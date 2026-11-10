/**
 * C1 —— 意图与计划接收（规范 §10.1 §16.2 §11.2 #20/#21）。
 *
 * 合同落实：
 *   - Intent 合同字段与 §10.1 一一对应（kind 四类、九态状态机、前提/依据/目标/
 *     预算/恢复条件/计划版本全量落库）；状态变化逐行写入 intent_state_history
 *     （迁移 0003，§10.1「状态变化留历史」）；
 *   - §16.2 计划接收：程序检查对象存在、范围有效、前提版本有效、依赖死锁
 *     （DEPENDENCY_CYCLE）；完全相同的提交按幂等规则返回原回执，疑似语义重复
 *     的意图只告警交 AI 判断、绝不凭模板强制合并；规划期间前提失效只拒绝或
 *     挂起受影响部分并保留理由，不因全局新增一条无关记录废弃整个计划；
 *   - §10.1 完成建议：程序检查必要产物（声明的交付物必须有真实存在的记录作证）
 *     与状态条件（前提期望重验）；一句「完成」最多进入 awaiting_review 交复核，
 *     永不关闭项目（resolved 只表示该版本的问题已处理，不动项目状态）。
 *
 * 程序只做规范交给程序的校验与保障（§3.2）：权限、必要前提、幂等、原子性、
 * 可靠事件；探索策略与语义判断（是否值得重试、如何拆分、何算完成）留给 AI。
 * AI 判断的职责以接口与合同形式留出：疑似重复→warnings、前提失效→逐意图
 * 挂起/拒绝理由、无交付物的完成→awaiting_review，均交 planner/verifier 决断。
 */
import { createHash } from "node:crypto";

import { apiError } from "../errors.mjs";
import { getStore } from "./record-service.mjs";
import { locateRecord } from "./records-read.mjs";

/* ── 常量（§10.1） ────────────────────────────────────────────────── */

export const INTENT_KINDS = Object.freeze(["collect", "investigate", "verify", "revisit"]);

export const INTENT_STATUSES = Object.freeze([
  "proposed",
  "queued",
  "running",
  "resolved",
  "blocked",
  "awaiting_review",
  "deferred",
  "obsolete",
  "cancelled",
]);

const TERMINAL_STATUSES = new Set(["resolved", "cancelled", "obsolete"]);

/** §10.1 建议流 proposed→queued→running→resolved + 六个支线状态；终态无出边。 */
export const INTENT_TRANSITIONS = Object.freeze({
  activate: { to: "queued", from: ["proposed"] },
  start: { to: "running", from: ["queued"] },
  block: {
    to: "blocked",
    from: ["proposed", "queued", "running", "awaiting_review"],
  },
  defer: {
    to: "deferred",
    from: ["proposed", "queued", "running", "blocked"],
  },
  resume: { to: "queued", from: ["blocked", "deferred"] },
  requeue: { to: "queued", from: ["running"] },
  submit_review: { to: "awaiting_review", from: ["running", "queued"] },
  resolve: { to: "resolved", from: ["running", "awaiting_review"] },
  cancel: {
    to: "cancelled",
    from: ["proposed", "queued", "running", "blocked", "deferred", "awaiting_review"],
  },
  obsolete: {
    to: "obsolete",
    from: ["proposed", "queued", "running", "blocked", "deferred", "awaiting_review"],
  },
});

/** 前提期望字段 → 各表可用性（§16.2 前提版本有效；行存在但无可校验字段 → BAD_REQUEST）。 */
const EXPECTABLE_FIELDS = Object.freeze({
  intents: ["state_version", "status"],
  goals: ["state_version", "status"],
  hypotheses: ["state_version", "status", "claim_revision", "evidence_revision", "assessment_epoch"],
  facts: ["state_version", "status", "claim_revision", "evidence_revision", "assessment_epoch"],
  vulnerabilities: [
    "state_version",
    "status",
    "review",
    "claim_revision",
    "evidence_revision",
    "assessment_epoch",
  ],
});

const EXPECTATION_KEYS = [
  "expected_state_version",
  "expected_status",
  "expected_review",
  "expected_claim_revision",
  "expected_evidence_revision",
  "expected_assessment_epoch",
];

const EVENT_SCHEMA_VERSION = 1;
const PRODUCER_ID = "c1/intents";

/* 依赖图遍历规模限制（§9.2：遍历必须有 visited 集合和规模限制）。 */
const DEP_GRAPH_MAX_NODES = 20000;
const DEP_GRAPH_MAX_EDGES = 200000;

/* ── 基础工具 ─────────────────────────────────────────────────────── */

function sha256Hex(text) {
  return createHash("sha256").update(text).digest("hex");
}

/** 规范化 JSON（键递归排序）：请求摘要与 result_hash 的确定性基础（与 A1 同法）。 */
function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

function pad4(n) {
  return String(n).padStart(4, "0");
}

function toJson(value, field) {
  return JSON.stringify(value === undefined || value === null ? [] : value);
}

/** 事务内分配项目内序列（§6.1 id_sequences；与 A1/A2 共用同一序列池）。 */
function nextSeq(db, projectId, kind) {
  db.prepare(
    "INSERT INTO id_sequences (project_id, kind, next_val) VALUES (?, ?, 1) ON CONFLICT(project_id, kind) DO NOTHING",
  ).run(projectId, kind);
  const row = db
    .prepare("SELECT next_val AS n FROM id_sequences WHERE project_id = ? AND kind = ?")
    .get(projectId, kind);
  db.prepare("UPDATE id_sequences SET next_val = ? WHERE project_id = ? AND kind = ?").run(
    row.n + 1,
    projectId,
    kind,
  );
  return row.n;
}

/** 项目级 commit_seq：事务内取出并推进（§14.1，与 A1 共用计数器）。 */
function nextCommitSeq(db, projectId) {
  const row = db.prepare("SELECT next_commit_seq AS n FROM projects WHERE id = ?").get(projectId);
  db.prepare("UPDATE projects SET next_commit_seq = ? WHERE id = ?").run(row.n + 1, projectId);
  return row.n;
}

function intentIdFor(projectId, n) {
  return `I-${projectId}-${pad4(n)}`;
}
function planRunIdFor(projectId, n) {
  return `RUN-${projectId}-${pad4(n)}`;
}
function planRevisionIdFor(projectId, n) {
  return `PLAN-${projectId}-${pad4(n)}`;
}
function relationIdFor(projectId, n) {
  return `R-${projectId}-${pad4(n)}`;
}
function historyIdFor(projectId, n) {
  return `ISH-${projectId}-${pad4(n)}`;
}

/** 事务内事件汇（§2 约束 10：业务记录与 Outbox 同事务）。 */
function makeEventSink() {
  const events = [];
  return {
    events,
    emit(event_type, { subject_ids = [], changed_fields = [], cause_refs = [], payload = {} } = {}) {
      events.push({ event_type, subject_ids, changed_fields, cause_refs, payload });
    },
  };
}

function flushEvents(db, { projectId, actor, commitSeq, causeRef, events, now }) {
  events.forEach((ev, i) => {
    db.prepare(
      `INSERT INTO outbox (event_id, project_id, commit_seq, event_index, event_type,
         subject_ids, changed_fields, cause_refs, producer_id, schema_version, payload,
         delivery_status, delivery_attempts, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)`,
    ).run(
      `evt-${projectId}-${commitSeq}-${i + 1}`,
      projectId,
      commitSeq,
      i + 1,
      ev.event_type,
      JSON.stringify(ev.subject_ids),
      JSON.stringify(ev.changed_fields),
      JSON.stringify(ev.cause_refs.length ? ev.cause_refs : [causeRef]),
      PRODUCER_ID,
      EVENT_SCHEMA_VERSION,
      JSON.stringify(ev.payload),
      now,
    );
  });
}

/* ── 意图行视图（§10.1 合同全字段，JSON 列解析） ───────────────────── */

function intentView(row, history) {
  const view = {
    id: row.id,
    project_id: row.project_id,
    goal_id: row.goal_id,
    question: row.question,
    rationale: row.rationale,
    kind: row.kind,
    target_asset_ids: JSON.parse(row.target_asset_ids),
    basis_refs: JSON.parse(row.basis_refs),
    prerequisite_refs: JSON.parse(row.prerequisite_refs),
    scope_revision: row.scope_revision,
    condition_requirements: JSON.parse(row.condition_requirements),
    success_criteria: row.success_criteria,
    deliverables: JSON.parse(row.deliverables),
    priority: row.priority,
    budget: JSON.parse(row.budget),
    resume_conditions: JSON.parse(row.resume_conditions),
    status: row.status,
    runnable_at: row.runnable_at,
    retry_count: row.retry_count,
    retry_limit: row.retry_limit,
    state_version: row.state_version,
    plan_revision: row.plan_revision,
    created_at: row.created_at,
    created_by: row.created_by,
    created_seq: row.created_seq,
    updated_seq: row.updated_seq,
  };
  if (history !== undefined) view.state_history = history;
  return view;
}

function historyView(row) {
  return {
    id: row.id,
    intent_id: row.intent_id,
    from_status: row.from_status,
    to_status: row.to_status,
    action: row.action,
    reason: row.reason,
    via: row.via,
    actor: row.actor,
    commit_seq: row.commit_seq,
    created_at: row.created_at,
  };
}

/** 写入一行状态历史（§10.1 状态变化留历史；from_status=null 表示随创建直接进入该状态）。 */
function recordHistory(db, { projectId, intentId, fromStatus, toStatus, action, reason, via, actor, commitSeq, now }) {
  db.prepare(
    `INSERT INTO intent_state_history (id, project_id, intent_id, from_status, to_status,
       action, reason, via, actor, commit_seq, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    historyIdFor(projectId, nextSeq(db, projectId, "intent_state_history")),
    projectId,
    intentId,
    fromStatus,
    toStatus,
    action || "",
    reason || "",
    via || "",
    actor,
    commitSeq,
    now,
  );
}

/* ── 关系边（§9.1：意图的 targets/requires/derived_from；带端点的新边事件） ── */

function insertIntentRelation(db, { projectId, from, to, relationType, requiresState, source, commitSeq, actor, now, sink }) {
  const id = relationIdFor(projectId, nextSeq(db, projectId, "relation"));
  db.prepare(
    `INSERT INTO relations (id, project_id, from_id, to_id, relation_type, conditions,
       requires_state, source, valid_from_seq, created_at, created_by, created_seq)
     VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?)`,
  ).run(id, projectId, from, to, relationType, requiresState || "", source, commitSeq, now, actor, commitSeq);
  // §15.5：新边事件包含端点信息（A1 先例；蓝图 §6 目录表格遗漏该通用事件已上报）
  sink.emit("relation.added", {
    subject_ids: [from, to],
    payload: { relation_id: id, from, to, relation_type: relationType, endpoints: { from, to } },
  });
  if (relationType === "requires") {
    // §9.2：前提变更产生依赖变化事件（B2 强制通知类）
    sink.emit("dependency.changed", {
      subject_ids: [to],
      changed_fields: ["requires"],
      payload: { relation_id: id, from, to, change: "added" },
    });
  }
  return id;
}

function retractPlanRelation(db, { projectId, relationId, row, change, commitSeq, now, sink }) {
  db.prepare("UPDATE relations SET retracted_at = ? WHERE id = ?").run(now, relationId);
  sink.emit("dependency.changed", {
    subject_ids: [row.to_id],
    changed_fields: ["requires"],
    payload: { relation_id: relationId, from: row.from_id, to: row.to_id, change },
  });
}

/* ── 前提期望（§16.2 前提版本有效；§2.9 状态变化检查依据新鲜度） ───── */

/**
 * 校验并评估一条前提声明。返回 { ref, table, met, failures: [{field, expected, actual}] }。
 * 声明了目标表不具备的期望字段 → BAD_REQUEST（明确指出可用字段）。
 */
function evaluatePrerequisite(db, projectId, decl, index) {
  if (!decl || typeof decl !== "object" || Array.isArray(decl)) {
    throw apiError("BAD_REQUEST", `prerequisites[${index}] 必须是对象`);
  }
  const ref = decl.ref;
  if (typeof ref !== "string" || !ref.trim()) {
    throw apiError("BAD_REQUEST", `prerequisites[${index}].ref 必须是非空字符串`);
  }
  const located = locateRecord(db, projectId, ref);
  if (!located) {
    throw apiError("INVALID_REFERENCE", `前提引用的对象不存在：${ref}`, {
      detail: { field: `prerequisites[${index}].ref`, ref },
      next_requirements: ["修正前提引用，或先创建被引用的对象"],
    });
  }
  const available = EXPECTABLE_FIELDS[located.table];
  const declared = [];
  for (const key of EXPECTATION_KEYS) {
    if (decl[key] === undefined || decl[key] === null) continue;
    declared.push({ key, value: decl[key] });
  }
  if (!available) {
    if (declared.length > 0) {
      throw apiError(
        "BAD_REQUEST",
        `前提 ${ref}（${located.table}）没有可校验的状态/版本字段，不能声明期望（§16.2）`,
        { detail: { ref, table: located.table, declared: declared.map((d) => d.key) } },
      );
    }
    return { ref, table: located.table, met: true, failures: [], expectation: null };
  }
  for (const { key } of declared) {
    const field = key.replace(/^expected_/, "");
    if (!available.includes(field)) {
      throw apiError(
        "BAD_REQUEST",
        `前提 ${ref}（${located.table}）不支持期望字段 ${key}；可用：${available.map((f) => "expected_" + f).join("、")}`,
        { detail: { ref, table: located.table, field: key, available } },
      );
    }
    if (/^expected_(state_version|claim_revision|evidence_revision|assessment_epoch)$/.test(key)) {
      if (!Number.isInteger(decl[key])) {
        throw apiError("BAD_REQUEST", `前提 ${ref} 的 ${key} 必须是整数`);
      }
    } else if (typeof decl[key] !== "string") {
      throw apiError("BAD_REQUEST", `前提 ${ref} 的 ${key} 必须是字符串`);
    }
  }
  const row = db.prepare(`SELECT * FROM ${located.table} WHERE id = ? AND project_id = ?`).get(ref, projectId);
  const failures = [];
  for (const { key, value } of declared) {
    const field = key.replace(/^expected_/, "");
    if (row[field] !== value) {
      failures.push({ field, expected: value, actual: row[field] });
    }
  }
  const expectation = {};
  for (const { key, value } of declared) expectation[key] = value;
  return { ref, table: located.table, met: failures.length === 0, failures, expectation };
}

/** 恢复条件文本：把失效细节翻成可核对的恢复条件（供 resume 检查与 AI 决策）。 */
function recoveryConditionText(ref, failures) {
  if (!failures.length) return `${ref} 保持当前状态`;
  return `${ref} 恢复为 ${failures
    .map((f) => `${f.field}=${JSON.stringify(f.expected)}（当前 ${JSON.stringify(f.actual)}）`)
    .join(" 且 ")}`;
}

/* ── 依赖死锁检测（§9.2：调度前提图拒绝无法解锁的循环依赖） ────────── */

/**
 * 汇总项目内 intent→intent 的 requires 语义边（prerequisite_refs 解析结果 +
 * 未撤回的 requires 关系边），叠加本计划的新建/修订，从被触及节点出发做
 * 三色 DFS；仅 requires 语义参与（探索血缘与弱关联允许成环，不在此检查）。
 */
function assertNoDependencyCycle(db, projectId, touchedIntentIds) {
  const adjacency = new Map(); // intentId -> Set<intentId>（依赖方向：我 → 我的前提）
  let edgeCount = 0;
  const addEdge = (from, to) => {
    let set = adjacency.get(from);
    if (!set) {
      set = new Set();
      adjacency.set(from, set);
    }
    if (!set.has(to)) {
      set.add(to);
      edgeCount += 1;
      if (edgeCount > DEP_GRAPH_MAX_EDGES) {
        throw apiError("RESOURCE_LIMIT", `依赖图边数超过规模限制（${DEP_GRAPH_MAX_EDGES}），拒绝继续遍历（§9.2）`);
      }
    }
  };
  const intents = db.prepare("SELECT id, prerequisite_refs FROM intents WHERE project_id = ?").all(projectId);
  const intentIdSet = new Set(intents.map((i) => i.id));
  if (intentIdSet.size > DEP_GRAPH_MAX_NODES) {
    throw apiError("RESOURCE_LIMIT", `意图数超过依赖图规模限制（${DEP_GRAPH_MAX_NODES}），拒绝继续遍历（§9.2）`);
  }
  for (const it of intents) {
    for (const ref of JSON.parse(it.prerequisite_refs)) {
      if (typeof ref === "string" && intentIdSet.has(ref)) addEdge(it.id, ref);
    }
  }
  const requiresEdges = db
    .prepare(
      `SELECT from_id, to_id FROM relations
        WHERE project_id = ? AND relation_type = 'requires' AND retracted_at IS NULL`,
    )
    .all(projectId);
  for (const e of requiresEdges) {
    if (intentIdSet.has(e.from_id) && intentIdSet.has(e.to_id)) addEdge(e.from_id, e.to_id);
  }
  // 三色 DFS（迭代式，带 visited/栈规模上限）
  const color = new Map(); // 0=白 1=灰 2=黑
  const stack = [];
  for (const start of touchedIntentIds) {
    if (!adjacency.has(start) || color.get(start) === 2) continue;
    stack.push({ node: start, iter: adjacency.get(start)[Symbol.iterator]() });
    color.set(start, 1);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const next = top.iter.next();
      if (next.done) {
        color.set(top.node, 2);
        stack.pop();
        continue;
      }
      const dep = next.value;
      const c = color.get(dep) || 0;
      if (c === 1) {
        const cycle = [...stack.map((f) => f.node), dep].reverse();
        throw apiError(
          "DEPENDENCY_CYCLE",
          `计划将形成无法解锁的循环依赖：${cycle.join(" → ")}（§9.2/§16.2）`,
          {
            detail: { cycle },
            next_requirements: ["由 planner 调整前置关系后再提交；探索血缘与弱关联不受此限制"],
          },
        );
      }
      if (c === 0 && adjacency.has(dep)) {
        color.set(dep, 1);
        stack.push({ node: dep, iter: adjacency.get(dep)[Symbol.iterator]() });
      }
    }
  }
}

/* ── 计划信封校验（§16.2 Planner 输出：输入 snapshot、消费边界、意图、依据、前提、优先级、预算、恢复条件） ── */

const SUBMISSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PLAN_REVISION_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const LOCAL_REF_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;

function validatePlanEnvelope(envelope) {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw apiError("BAD_REQUEST", "计划信封必须是 JSON 对象");
  }
  for (const forbidden of ["project_id", "actor", "role"]) {
    if (forbidden in envelope) {
      throw apiError("BAD_REQUEST", `计划信封不得携带 ${forbidden}：由服务端会话决定，不信任模型自报（§11.1）`);
    }
  }
  if (typeof envelope.submission_id !== "string" || !SUBMISSION_ID_RE.test(envelope.submission_id)) {
    throw apiError("BAD_REQUEST", "submission_id 必填（1..128 位 [A-Za-z0-9._:-]，计划接收的稳定业务键，§14.2）");
  }
  if (typeof envelope.plan_revision !== "string" || !PLAN_REVISION_RE.test(envelope.plan_revision)) {
    throw apiError("BAD_REQUEST", "plan_revision 必填（planner 的计划版本标签，1..64 位 [A-Za-z0-9._:-]）");
  }
  if (envelope.plan_run_id !== undefined && envelope.plan_run_id !== null) {
    if (typeof envelope.plan_run_id !== "string" || !SUBMISSION_ID_RE.test(envelope.plan_run_id)) {
      throw apiError("BAD_REQUEST", "plan_run_id 必须是与 submission_id 同形的编号");
    }
  }
  for (const key of ["input_snapshot_id", "input_boundary"]) {
    const v = envelope[key];
    if (v !== undefined && v !== null && (typeof v !== "string" || v.length > 256)) {
      throw apiError("BAD_REQUEST", `${key} 必须是不长于 256 的字符串`);
    }
  }
  if (envelope.prerequisites !== undefined && envelope.prerequisites !== null) {
    if (!Array.isArray(envelope.prerequisites)) {
      throw apiError("BAD_REQUEST", "prerequisites 必须是数组（每项 { ref, expected_* }）");
    }
  }
  if (!Array.isArray(envelope.intents)) {
    throw apiError("BAD_REQUEST", "intents 必须是数组（可为空：纯标记消费边界的计划）");
  }
  const seenLocalRefs = new Set();
  for (const item of envelope.intents) {
    if (!item || typeof item !== "object") {
      throw apiError("BAD_REQUEST", "intents 的每项必须是对象");
    }
    if (item.op !== "create" && item.op !== "revise") {
      throw apiError("BAD_REQUEST", `intents[].op 必须是 create 或 revise（收到：${String(item.op)}）`);
    }
    if (item.local_ref !== undefined && item.local_ref !== null) {
      if (typeof item.local_ref !== "string" || !LOCAL_REF_RE.test(item.local_ref)) {
        throw apiError("BAD_REQUEST", `local_ref 格式非法：${item.local_ref}`);
      }
      if (seenLocalRefs.has(item.local_ref)) {
        throw apiError("BAD_REQUEST", `local_ref 在同一计划内重复：${item.local_ref}`);
      }
      seenLocalRefs.add(item.local_ref);
    }
  }
}

function strArray(value, field, { allowObjects = false } = {}) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw apiError("BAD_REQUEST", `字段 ${field} 必须是数组`);
  }
  for (const v of value) {
    const ok = allowObjects ? typeof v === "string" || (v && typeof v === "object") : typeof v === "string" && v.trim();
    if (!ok) throw apiError("BAD_REQUEST", `字段 ${field} 的成员非法（${allowObjects ? "须为字符串或对象" : "须为非空字符串"}）`);
  }
  return value;
}

/** 校验单个意图的字段形状（create 与 revise 共用；revise 允许省略除版本外的字段）。 */
function validateIntentFields(item, { forCreate }) {
  if (forCreate) {
    if (typeof item.question !== "string" || !item.question.trim() || item.question.length > 2000) {
      throw apiError("BAD_REQUEST", "意图缺少必填 question（一条意图围绕一个明确问题，1..2000 字，§10.1）");
    }
    if (!INTENT_KINDS.includes(item.kind)) {
      throw apiError("BAD_REQUEST", `意图 kind 必须是 ${INTENT_KINDS.join(" / ")} 之一（收到：${String(item.kind)}）`);
    }
    if (typeof item.success_criteria !== "string" || !item.success_criteria.trim()) {
      throw apiError(
        "BAD_REQUEST",
        "意图缺少必填 success_criteria（完成条件须说明要得到什么回答或明确什么缺口，程序才能检查完成建议，§10.1）",
      );
    }
  } else {
    if (item.question !== undefined && (typeof item.question !== "string" || !item.question.trim())) {
      throw apiError("BAD_REQUEST", "revise 的 question 必须是非空字符串");
    }
    if (item.kind !== undefined && !INTENT_KINDS.includes(item.kind)) {
      throw apiError("BAD_REQUEST", `意图 kind 必须是 ${INTENT_KINDS.join(" / ")} 之一`);
    }
    if (item.success_criteria !== undefined && (typeof item.success_criteria !== "string" || !item.success_criteria.trim())) {
      throw apiError("BAD_REQUEST", "revise 的 success_criteria 必须是非空字符串");
    }
  }
  if (item.rationale !== undefined && item.rationale !== null && typeof item.rationale !== "string") {
    throw apiError("BAD_REQUEST", "rationale 必须是字符串");
  }
  strArray(item.target_asset_ids, "target_asset_ids");
  strArray(item.basis_refs, "basis_refs");
  strArray(item.prerequisite_refs, "prerequisite_refs");
  strArray(item.condition_requirements, "condition_requirements", { allowObjects: true });
  strArray(item.deliverables, "deliverables", { allowObjects: true });
  strArray(item.resume_conditions, "resume_conditions", { allowObjects: true });
  if (item.priority !== undefined && item.priority !== null) {
    if (!Number.isInteger(item.priority)) {
      throw apiError("BAD_REQUEST", "priority 必须是整数");
    }
  }
  if (item.budget !== undefined && item.budget !== null) {
    if (typeof item.budget !== "object" || Array.isArray(item.budget)) {
      throw apiError("BAD_REQUEST", "budget 必须是对象");
    }
  }
  if (item.runnable_at !== undefined && item.runnable_at !== null) {
    if (typeof item.runnable_at !== "string" || Number.isNaN(Date.parse(item.runnable_at))) {
      throw apiError("BAD_REQUEST", "runnable_at 必须是可解析的时间字符串");
    }
  }
  if (item.on_prerequisite_invalid !== undefined && item.on_prerequisite_invalid !== null) {
    if (item.on_prerequisite_invalid !== "suspend" && item.on_prerequisite_invalid !== "reject") {
      throw apiError("BAD_REQUEST", "on_prerequisite_invalid 只允许 suspend（挂起，默认）或 reject（拒绝）");
    }
  }
}

/* ── 计划接收主体（§16.2；端点 #20） ──────────────────────────────── */

/**
 * 接收 planner 的计划修订。
 *
 * 硬失败（整单原子回滚，错误信封说明）：
 *   BAD_REQUEST（形状）/ IDEMPOTENCY_KEY_REUSED / INVALID_REFERENCE（对象不存在）/
 *   STALE_STATE（修订的期望版本不匹配，§11.3 修改型）/ SCOPE_UNRESOLVED（项目
 *   未配置范围且计划未声明）/ DEPENDENCY_CYCLE（调度前提图成环）。
 * 受影响部分处理（§16.2）：前提失效 → 按意图声明的策略挂起（默认）或拒绝，
 *   保留理由与恢复条件；目标资产被明确拒绝 → 该意图拒绝（SCOPE_DENIED）；
 *   其余意图照常接收，received_status 反映 partial/suspended/rejected。
 */
export async function receivePlanRevision(pctx, { session, envelope }) {
  const store = await getStore(pctx);
  validatePlanEnvelope(envelope);
  const requestDigest = sha256Hex(canonicalJson(envelope));
  return store.runSerial((db) => {
    const projectId = session.project_id;
    const actor = session.actor;
    const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId);
    if (!project) {
      throw apiError("NOT_FOUND", `会话绑定的项目不存在：${projectId}`);
    }
    // 幂等接收（§16.2 完全相同的提交按幂等规则处理；§14.2 计划接收有稳定业务键）
    const dup = db
      .prepare("SELECT * FROM submissions WHERE project_id = ? AND submitter_id = ? AND id = ?")
      .get(projectId, actor, envelope.submission_id);
    if (dup) {
      if (dup.request_digest === requestDigest) {
        return JSON.parse(dup.receipt); // 原回执原样返回
      }
      throw apiError(
        "IDEMPOTENCY_KEY_REUSED",
        `submission_id ${envelope.submission_id} 已用于不同内容的计划，拒绝覆盖原提交（§16.2/§11.1）`,
        {
          receipt: { submission_id: dup.id, commit_seq: dup.commit_seq, result_hash: dup.result_hash },
          next_requirements: ["原样重发同一计划；内容变化必须使用新的 submission_id"],
        },
      );
    }
    const now = new Date().toISOString();
    const warnings = [];
    const sink = makeEventSink();

    /* 范围有效（§16.2/§17）：计划级/意图级 scope_revision 必须存在于本项目；
       都未声明时回落到项目当前范围；项目从未配置范围 → SCOPE_UNRESOLVED
       （缺少目标范围不能默认为任意目标均可操作）。
       输入兼容两种形态：版本标签（"1"）或范围行编号（"SR-…"）；统一存行编号
       （与 projects.current_scope_revision 同形态，便于联查）。 */
    const resolveScopeRevision = (value, field) => {
      const row = db
        .prepare("SELECT id, revision FROM scope_revisions WHERE project_id = ? AND (revision = ? OR id = ?)")
        .get(projectId, value, value);
      if (!row) {
        throw apiError("INVALID_REFERENCE", `${field} 引用的范围版本在本项目不存在：${value}`, {
          detail: { field, value },
          next_requirements: ["改用本项目已存在的范围版本（GET /projects/{id}/scope 查询历史）"],
        });
      }
      return row.id;
    };
    const planScope =
      envelope.scope_revision !== undefined && envelope.scope_revision !== null && envelope.scope_revision !== ""
        ? resolveScopeRevision(envelope.scope_revision, "scope_revision")
        : project.current_scope_revision || null;
    if (!planScope) {
      throw apiError(
        "SCOPE_UNRESOLVED",
        "项目尚未配置任何范围版本，且计划未声明 scope_revision；缺少目标范围不能默认任意目标均可操作（§17）",
        {
          next_requirements: ["先经 POST /scope-revisions 配置范围版本，或在计划中显式声明 scope_revision"],
        },
      );
    }

    /* 前提版本有效（§16.2）：逐条声明解析、评估；失效集合供受影响意图分流。 */
    const prerequisiteDecls = envelope.prerequisites || [];
    const evaluated = prerequisiteDecls.map((decl, i) => evaluatePrerequisite(db, projectId, decl, i));
    const invalidMap = new Map(); // ref -> { failures, table }
    const expectationByRef = new Map(); // ref -> expectation JSON（写 requires 边时带上）
    for (const e of evaluated) {
      expectationByRef.set(e.ref, e.expectation);
      if (!e.met) invalidMap.set(e.ref, { failures: e.failures, table: e.table });
    }
    if (invalidMap.size > 0) {
      const referenced = new Set();
      for (const item of envelope.intents) {
        for (const ref of item.prerequisite_refs || []) referenced.add(ref);
      }
      for (const [ref, info] of invalidMap) {
        if (!referenced.has(ref)) {
          warnings.push(
            `计划级前提 ${ref} 已失效（${info.failures
              .map((f) => `${f.field}: 期望 ${JSON.stringify(f.expected)} 实际 ${JSON.stringify(f.actual)}`)
              .join("、")}），但没有意图直接依赖它，仅记录不影响接收`,
          );
        }
      }
    }

    /* plan_run：复用或新建（§6.2 plan_runs：规划输入版本与接收结果）。 */
    let planRunId = envelope.plan_run_id || null;
    if (planRunId) {
      const run = db.prepare("SELECT * FROM plan_runs WHERE id = ? AND project_id = ?").get(planRunId, projectId);
      if (!run) {
        throw apiError("INVALID_REFERENCE", `plan_run_id 不存在：${planRunId}`, {
          next_requirements: ["省略 plan_run_id 以创建新的规划运行，或使用本项目已有的 run"],
        });
      }
    }
    if (envelope.input_snapshot_id) {
      const snap = db
        .prepare("SELECT id FROM snapshots WHERE id = ? AND project_id = ?")
        .get(envelope.input_snapshot_id, projectId);
      if (!snap) {
        warnings.push(`input_snapshot_id ${envelope.input_snapshot_id} 未在本项目快照中找到，按 planner 自述的输入边界原样记录`);
      }
    }

    const commitSeq = nextCommitSeq(db, projectId);
    if (!planRunId) {
      planRunId = planRunIdFor(projectId, nextSeq(db, projectId, "plan_run"));
      db.prepare(
        `INSERT INTO plan_runs (id, project_id, input_snapshot_id, input_boundary, status,
           created_at, created_by, created_seq, updated_seq, state_version)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, 1)`,
      ).run(
        planRunId,
        projectId,
        envelope.input_snapshot_id || null,
        envelope.input_boundary || "",
        now,
        actor,
        commitSeq,
        commitSeq,
      );
    }

    /* 同一 run + revision 幂等性之外的重复标签：UNIQUE(project_id, plan_run_id, revision)
       会拒绝同 run 重复 revision；这里给出可读错误（内容不同时应换 submission_id+revision）。 */
    const dupRevision = db
      .prepare("SELECT id FROM plan_revisions WHERE project_id = ? AND plan_run_id = ? AND revision = ?")
      .get(projectId, planRunId, envelope.plan_revision);
    if (dupRevision) {
      throw apiError(
        "IDEMPOTENCY_KEY_REUSED",
        `计划修订 ${envelope.plan_revision} 已在 run ${planRunId} 下接收过；相同内容须以原 submission_id 重发，新内容使用新的 plan_revision`,
        {
          detail: { plan_run_id: planRunId, revision: envelope.plan_revision, existing_id: dupRevision.id },
          next_requirements: ["以原 submission_id 原样重发取得原回执，或递增 plan_revision 标签"],
        },
      );
    }

    /* 逐意图处理：local_ref 解析、引用校验、范围/前提分流、落库与边。 */
    const ids = {}; // local_ref -> formal id
    const created = [];
    const revised = [];
    const suspended = [];
    const rejected = [];
    const touched = new Set();
    const resolveRef = (v) =>
      typeof v === "string" && Object.prototype.hasOwnProperty.call(ids, v) ? ids[v] : v;

    // 预留新建意图编号：计划内 local_ref 可前向引用（条目顺序不限；编号随回滚一并释放）
    for (const item of envelope.intents) {
      if (item.op === "create" && item.local_ref) {
        ids[item.local_ref] = intentIdFor(projectId, nextSeq(db, projectId, "intent"));
      }
    }

    const locateOrThrow = (ref, field) => {
      // 本计划预留编号视为存在（intents；落库前即可被后续条目引用）
      if (typeof ref === "string" && Object.values(ids).includes(ref)) {
        return { table: "intents" };
      }
      const hit = locateRecord(db, projectId, ref);
      if (!hit) {
        throw apiError("INVALID_REFERENCE", `意图引用的对象不存在（${field}）：${ref}`, {
          detail: { field, ref },
          next_requirements: [`先创建被引用对象，或修正 ${field}`],
        });
      }
      return hit;
    };

    const requireTable = (ref, field, table) => {
      const hit = locateOrThrow(ref, field);
      if (hit.table !== table) {
        throw apiError("INVALID_REFERENCE", `${field} 引用的必须是 ${table} 记录：${ref}（实际 ${hit.table}）`);
      }
      return hit;
    };

    for (const item of envelope.intents) {
      validateIntentFields(item, { forCreate: item.op === "create" });
      if (item.op === "create") {
        // 目标资产：存在性 + 范围状态（§17 明确拒绝优先；pending 只告警，派发侧再逐跳校验）
        const targets = (item.target_asset_ids || []).map((ref) => {
          requireTable(resolveRef(ref), "target_asset_ids", "assets");
          return resolveRef(ref);
        });
        const deniedTargets = [];
        for (const t of targets) {
          const asset = db.prepare("SELECT scope_status, canonical_key FROM assets WHERE id = ? AND project_id = ?").get(t, projectId);
          if (asset.scope_status === "denied") deniedTargets.push(t);
          else if (asset.scope_status === "pending") {
            warnings.push(`目标资产 ${t}（${asset.canonical_key}）范围待判定；意图照常接收，派发与工具执行前仍会逐跳校验范围（§17）`);
          }
        }
        if (deniedTargets.length > 0) {
          rejected.push({
            op: "create",
            local_ref: item.local_ref ?? null,
            code: "SCOPE_DENIED",
            reason: `目标资产在明确拒绝范围：${deniedTargets.join("、")}（§17 明确拒绝规则优先）`,
            detail: { denied_targets: deniedTargets },
          });
          continue;
        }
        // 依据/前提引用（存在性；前提可为同计划 local_ref）
        const basisRefs = (item.basis_refs || []).map((r) => {
          locateOrThrow(resolveRef(r), "basis_refs");
          return resolveRef(r);
        });
        const prereqRefs = (item.prerequisite_refs || []).map((r) => {
          locateOrThrow(resolveRef(r), "prerequisite_refs");
          return resolveRef(r);
        });
        let goalId = null;
        if (item.goal_id !== undefined && item.goal_id !== null && item.goal_id !== "") {
          goalId = resolveRef(item.goal_id);
          requireTable(goalId, "goal_id", "goals");
        }
        const scopeRevision =
          item.scope_revision !== undefined && item.scope_revision !== null && item.scope_revision !== ""
            ? resolveScopeRevision(item.scope_revision, "intents[].scope_revision")
            : planScope;

        // 前提失效分流（§16.2）：挂起（默认）或拒绝受影响部分，保留理由
        const invalidPrereqs = prereqRefs.filter((r) => invalidMap.has(r));
        const policy = item.on_prerequisite_invalid || "suspend";
        const intentId =
          item.local_ref && ids[item.local_ref] ? ids[item.local_ref] : intentIdFor(projectId, nextSeq(db, projectId, "intent"));
        const status = invalidPrereqs.length > 0 ? (policy === "suspend" ? "blocked" : "proposed") : "proposed";
        let resumeConditions = item.resume_conditions || [];
        let suspendReason = "";
        if (invalidPrereqs.length > 0 && policy === "reject") {
          rejected.push({
            op: "create",
            local_ref: item.local_ref ?? null,
            code: "PRECONDITION_INVALID",
            reason: `前提在规划期间失效，按声明策略拒绝：${invalidPrereqs
              .map((r) => {
                const info = invalidMap.get(r);
                return `${r}（${info.failures.map((f) => `${f.field}: 期望 ${JSON.stringify(f.expected)} 实际 ${JSON.stringify(f.actual)}`).join("、")}）`;
              })
              .join("；")}`,
            detail: { prerequisites: invalidPrereqs },
          });
          continue;
        }
        if (invalidPrereqs.length > 0) {
          const reasons = invalidPrereqs.map((r) => {
            const info = invalidMap.get(r);
            const text = `前提 ${r} 失效：${info.failures
              .map((f) => `${f.field} 期望 ${JSON.stringify(f.expected)}，实际 ${JSON.stringify(f.actual)}`)
              .join("、")}`;
            resumeConditions = [
              ...resumeConditions,
              { kind: "prerequisite", description: recoveryConditionText(r, info.failures), ref: r },
            ];
            return text;
          });
          suspendReason = `规划期间前提失效，按 §16.2 挂起：${reasons.join("；")}`;
        }
        // 疑似语义重复：只告警交 AI 判断，绝不凭模板强制合并（§16.2）
        if (item.question && item.kind) {
          const twins = db
            .prepare(
              `SELECT id FROM intents WHERE project_id = ? AND question = ? AND kind = ?
                 AND status NOT IN ('resolved','cancelled','obsolete')`,
            )
            .all(projectId, item.question, item.kind);
          if (twins.length > 0) {
            warnings.push(
              `意图与现存未结意图疑似重复（${twins.map((t) => t.id).join("、")}，同问题同类型）：程序不强制合并，交 planner/orchestrator 判断是否修订或废弃（§16.2）`,
            );
          }
        }
        db.prepare(
          `INSERT INTO intents (id, project_id, goal_id, question, rationale, kind, target_asset_ids,
             basis_refs, prerequisite_refs, scope_revision, condition_requirements, success_criteria,
             deliverables, priority, budget, resume_conditions, status, runnable_at, state_version,
             plan_revision, created_at, created_by, created_seq, updated_seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
        ).run(
          intentId,
          projectId,
          goalId,
          item.question,
          item.rationale || "",
          item.kind,
          toJson(targets),
          toJson(basisRefs),
          toJson(prereqRefs),
          scopeRevision,
          toJson(item.condition_requirements),
          item.success_criteria,
          toJson(item.deliverables),
          item.priority ?? 0,
          item.budget === undefined || item.budget === null ? "{}" : JSON.stringify(item.budget),
          toJson(resumeConditions),
          status,
          item.runnable_at || null,
          envelope.plan_revision,
          now,
          actor,
          commitSeq,
          commitSeq,
        );
        if (item.local_ref) ids[item.local_ref] = intentId;
        touched.add(intentId);
        recordHistory(db, {
          projectId,
          intentId,
          fromStatus: null,
          toStatus: status,
          action: status === "blocked" ? "suspend_on_reception" : "create",
          reason: suspendReason,
          via: `plan:${envelope.plan_revision}`,
          actor,
          commitSeq,
          now,
        });
        // §9.1 语义边：targets（目标资产）/ requires（必要前提，带期望状态）/ derived_from（依据）
        for (const t of targets) {
          insertIntentRelation(db, {
            projectId,
            from: intentId,
            to: t,
            relationType: "targets",
            source: "plan",
            commitSeq,
            actor,
            now,
            sink,
          });
        }
        for (const p of prereqRefs) {
          const expectation = expectationByRef.get(p);
          insertIntentRelation(db, {
            projectId,
            from: intentId,
            to: p,
            relationType: "requires",
            requiresState: expectation ? JSON.stringify(expectation) : "",
            source: "plan",
            commitSeq,
            actor,
            now,
            sink,
          });
        }
        for (const b of basisRefs) {
          insertIntentRelation(db, {
            projectId,
            from: intentId,
            to: b,
            relationType: "derived_from",
            source: "plan",
            commitSeq,
            actor,
            now,
            sink,
          });
        }
        if (status === "blocked") {
          sink.emit("intent.blocked", {
            subject_ids: [intentId],
            payload: { intent_id: intentId, from: null, reason: suspendReason, prerequisites: invalidPrereqs },
          });
          suspended.push({ intent_id: intentId, local_ref: item.local_ref ?? null, reason: suspendReason, prerequisites: invalidPrereqs });
        }
        created.push({
          local_ref: item.local_ref ?? null,
          intent_id: intentId,
          outcome: status === "blocked" ? "suspended" : "created",
          status,
        });
      } else {
        /* revise（§11.3 修改型：检查 expected_state_version） */
        const intentId = resolveRef(item.intent_id);
        const row = db.prepare("SELECT * FROM intents WHERE id = ? AND project_id = ?").get(intentId, projectId);
        if (!row) {
          throw apiError("INVALID_REFERENCE", `待修订的意图不存在：${item.intent_id}`, {
            next_requirements: ["修正 intent_id，或改用 create 建立新意图"],
          });
        }
        if (typeof item.expected_state_version !== "number" || !Number.isInteger(item.expected_state_version)) {
          throw apiError("BAD_REQUEST", "revise 需要整数字段 expected_state_version（§11.3 修改型操作）");
        }
        if (row.state_version !== item.expected_state_version) {
          throw apiError("STALE_STATE", `意图 ${intentId} 的 state_version 已变化，拒绝修订（§11.3）`, {
            detail: { current_state_version: row.state_version, expected_state_version: item.expected_state_version },
            next_requirements: [`以 expected_state_version=${row.state_version} 重试修订`],
          });
        }
        if (TERMINAL_STATUSES.has(row.status)) {
          throw apiError(
            "PRECONDITION_INVALID",
            `意图 ${intentId} 已处于终态 ${row.status}（resolved 只表示该版本的问题已处理，§10.1）；新问题请创建新意图并在依据中引用旧意图`,
            {
              detail: { status: row.status },
              next_requirements: ["创建新意图（op=create，basis_refs 引用旧意图），由 planner 决定关系"],
            },
          );
        }
        const targets = item.target_asset_ids !== undefined
          ? item.target_asset_ids.map((ref) => {
              requireTable(resolveRef(ref), "target_asset_ids", "assets");
              return resolveRef(ref);
            })
          : JSON.parse(row.target_asset_ids);
        const deniedTargets = targets.filter((t) => {
          const asset = db.prepare("SELECT scope_status FROM assets WHERE id = ? AND project_id = ?").get(t, projectId);
          return asset && asset.scope_status === "denied";
        });
        if (deniedTargets.length > 0) {
          rejected.push({
            op: "revise",
            intent_id: intentId,
            code: "SCOPE_DENIED",
            reason: `修订后的目标资产在明确拒绝范围：${deniedTargets.join("、")}（§17）`,
            detail: { denied_targets: deniedTargets },
          });
          continue;
        }
        const basisRefs = item.basis_refs !== undefined
          ? item.basis_refs.map((r) => {
              locateOrThrow(resolveRef(r), "basis_refs");
              return resolveRef(r);
            })
          : JSON.parse(row.basis_refs);
        const prereqRefs = item.prerequisite_refs !== undefined
          ? item.prerequisite_refs.map((r) => {
              locateOrThrow(resolveRef(r), "prerequisite_refs");
              return resolveRef(r);
            })
          : JSON.parse(row.prerequisite_refs);
        let goalId = row.goal_id;
        if (item.goal_id !== undefined) {
          goalId = item.goal_id === null || item.goal_id === "" ? null : resolveRef(item.goal_id);
          if (goalId) requireTable(goalId, "goal_id", "goals");
        }
        const scopeRevision =
          item.scope_revision !== undefined
            ? item.scope_revision === null || item.scope_revision === ""
              ? planScope
              : resolveScopeRevision(item.scope_revision, "intents[].scope_revision")
            : row.scope_revision;
        const invalidPrereqs = prereqRefs.filter((r) => invalidMap.has(r));
        const policy = item.on_prerequisite_invalid || "suspend";
        if (invalidPrereqs.length > 0 && policy === "reject") {
          rejected.push({
            op: "revise",
            intent_id: intentId,
            code: "PRECONDITION_INVALID",
            reason: `修订引入的前提已失效，按声明策略拒绝修订：${invalidPrereqs.join("、")}`,
            detail: { prerequisites: invalidPrereqs },
          });
          continue;
        }
        // 前提重评估：修订把前提全部换成有效前提时，blocked 的意图解除挂起（§9.2 重评估，不一律改失败）
        let newStatus = row.status;
        let resumeConditions =
          item.resume_conditions !== undefined ? item.resume_conditions : JSON.parse(row.resume_conditions);
        let suspendReason = "";
        if (invalidPrereqs.length > 0) {
          const reasons = invalidPrereqs.map((r) => {
            const info = invalidMap.get(r);
            const text = `前提 ${r} 失效：${info.failures
              .map((f) => `${f.field} 期望 ${JSON.stringify(f.expected)}，实际 ${JSON.stringify(f.actual)}`)
              .join("、")}`;
            resumeConditions = [
              ...resumeConditions,
              { kind: "prerequisite", description: recoveryConditionText(r, info.failures), ref: r },
            ];
            return text;
          });
          suspendReason = `修订后前提失效，按 §16.2 挂起：${reasons.join("；")}`;
          newStatus = "blocked";
        } else if (row.status === "blocked") {
          newStatus = "proposed";
          warnings.push(`意图 ${intentId} 的前提已全部有效，随本次修订解除挂起回到 proposed（§9.2 重评估）`);
        }
        db.prepare(
          `UPDATE intents SET goal_id = ?, question = ?, rationale = ?, kind = ?, target_asset_ids = ?,
             basis_refs = ?, prerequisite_refs = ?, scope_revision = ?, condition_requirements = ?,
             success_criteria = ?, deliverables = ?, priority = ?, budget = ?, resume_conditions = ?,
             status = ?, runnable_at = ?, state_version = ?, plan_revision = ?, updated_seq = ?
           WHERE id = ? AND project_id = ?`,
        ).run(
          goalId,
          item.question !== undefined ? item.question : row.question,
          item.rationale !== undefined ? item.rationale : row.rationale,
          item.kind !== undefined ? item.kind : row.kind,
          toJson(targets),
          toJson(basisRefs),
          toJson(prereqRefs),
          scopeRevision,
          item.condition_requirements !== undefined ? toJson(item.condition_requirements) : row.condition_requirements,
          item.success_criteria !== undefined ? item.success_criteria : row.success_criteria,
          item.deliverables !== undefined ? toJson(item.deliverables) : row.deliverables,
          item.priority !== undefined ? item.priority : row.priority,
          item.budget !== undefined
            ? item.budget === null
              ? "{}"
              : JSON.stringify(item.budget)
            : row.budget,
          toJson(resumeConditions),
          newStatus,
          item.runnable_at !== undefined ? item.runnable_at || null : row.runnable_at,
          row.state_version + 1,
          envelope.plan_revision,
          commitSeq,
          intentId,
          projectId,
        );
        touched.add(intentId);
        if (newStatus !== row.status) {
          recordHistory(db, {
            projectId,
            intentId,
            fromStatus: row.status,
            toStatus: newStatus,
            action: newStatus === "blocked" ? "suspend_on_revision" : "reevaluate",
            reason: suspendReason || "修订后前提全部有效，解除挂起",
            via: `plan:${envelope.plan_revision}`,
            actor,
            commitSeq,
            now,
          });
          if (newStatus === "blocked") {
            sink.emit("intent.blocked", {
              subject_ids: [intentId],
              payload: { intent_id: intentId, from: row.status, reason: suspendReason, prerequisites: invalidPrereqs },
            });
            suspended.push({ intent_id: intentId, reason: suspendReason, prerequisites: invalidPrereqs });
          }
        }
        // requires 边随修订同步：计划来源的旧 requires 边不再属于新前提集合 → 撤回；
        // 新前提补建缺失的边（targets/derived_from 同步重建为「缺啥补啥」）。
        if (item.prerequisite_refs !== undefined) {
          const oldPlanRequires = db
            .prepare(
              `SELECT * FROM relations WHERE project_id = ? AND from_id = ? AND relation_type = 'requires'
                 AND source = 'plan' AND retracted_at IS NULL`,
            )
            .all(projectId, intentId);
          const keep = new Set(prereqRefs);
          for (const rel of oldPlanRequires) {
            if (!keep.has(rel.to_id)) {
              retractPlanRelation(db, {
                projectId,
                relationId: rel.id,
                row: rel,
                change: "superseded",
                commitSeq,
                now,
                sink,
              });
            } else {
              keep.delete(rel.to_id);
            }
          }
          for (const p of keep) {
            const expectation = expectationByRef.get(p);
            insertIntentRelation(db, {
              projectId,
              from: intentId,
              to: p,
              relationType: "requires",
              requiresState: expectation ? JSON.stringify(expectation) : "",
              source: "plan",
              commitSeq,
              actor,
              now,
              sink,
            });
          }
        }
        if (item.target_asset_ids !== undefined) {
          const existingTargets = new Set(
            db
              .prepare(
                `SELECT to_id FROM relations WHERE project_id = ? AND from_id = ? AND relation_type = 'targets' AND retracted_at IS NULL`,
              )
              .all(projectId, intentId)
              .map((r) => r.to_id),
          );
          for (const t of targets) {
            if (!existingTargets.has(t)) {
              insertIntentRelation(db, {
                projectId,
                from: intentId,
                to: t,
                relationType: "targets",
                source: "plan",
                commitSeq,
                actor,
                now,
                sink,
              });
            }
          }
        }
        if (item.basis_refs !== undefined) {
          const existingBasis = new Set(
            db
              .prepare(
                `SELECT to_id FROM relations WHERE project_id = ? AND from_id = ? AND relation_type = 'derived_from' AND retracted_at IS NULL`,
              )
              .all(projectId, intentId)
              .map((r) => r.to_id),
          );
          for (const b of basisRefs) {
            if (!existingBasis.has(b)) {
              insertIntentRelation(db, {
                projectId,
                from: intentId,
                to: b,
                relationType: "derived_from",
                source: "plan",
                commitSeq,
                actor,
                now,
                sink,
              });
            }
          }
        }
        revised.push({
          intent_id: intentId,
          outcome: suspended.some((s) => s.intent_id === intentId) ? "suspended" : "revised",
          status: newStatus,
          state_version: row.state_version + 1,
        });
      }
    }

    /* 计划内部一致性：被拒绝意图的编号若仍被其他条目引用（前向 local_ref），
       该计划内部自相矛盾 → 整单拒绝（§11.3 逻辑依赖组全部成功或全部失败）。 */
    const rejectedIds = new Set(
      rejected.map((r) => (r.local_ref && ids[r.local_ref]) || r.intent_id).filter(Boolean),
    );
    if (rejectedIds.size > 0) {
      for (const item of envelope.intents) {
        const refs = [...(item.prerequisite_refs || []), ...(item.basis_refs || [])].map(resolveRef);
        if (refs.some((r) => rejectedIds.has(r))) {
          throw apiError(
            "INVALID_REFERENCE",
            `计划条目引用了被拒绝意图的编号（${[...rejectedIds].join("、")}），计划内部自相矛盾，整单拒绝（§16.2/§11.3）`,
            {
              detail: { rejected: [...rejectedIds] },
              next_requirements: ["移除对被拒绝意图的引用，或修正其被拒原因后重新提交计划"],
            },
          );
        }
      }
    }

    /* 依赖死锁（§16.2/§9.2）：调度前提图（requires 语义）不得成环；命中即整单回滚。 */
    assertNoDependencyCycle(db, projectId, touched);

    /* 汇总 received_status（DDL 枚举 pending/accepted/partial/rejected/suspended）。 */
    const acceptedCount =
      created.filter((c) => c.outcome === "created").length + revised.filter((r) => r.outcome === "revised").length;
    const suspendedCount = suspended.length;
    const rejectedCount = rejected.length;
    let receivedStatus;
    if (acceptedCount > 0) receivedStatus = suspendedCount + rejectedCount > 0 ? "partial" : "accepted";
    else if (suspendedCount > 0) receivedStatus = "suspended";
    else if (rejectedCount > 0) receivedStatus = "rejected";
    else receivedStatus = "accepted"; // 空意图计划：纯标记消费边界

    const planRevisionId = planRevisionIdFor(projectId, nextSeq(db, projectId, "plan_revision"));
    const reasonSummary =
      receivedStatus === "accepted"
        ? ""
        : JSON.stringify({
            suspended,
            rejected,
            note: "§16.2：前提失效/范围拒绝只影响所列意图，其余已按原计划接收",
          });
    db.prepare(
      `INSERT INTO plan_revisions (id, project_id, plan_run_id, revision, intents_created,
         intents_updated, rationale_refs, prerequisites, received_status, reject_reason,
         created_at, created_by, created_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      planRevisionId,
      projectId,
      planRunId,
      envelope.plan_revision,
      JSON.stringify(created),
      JSON.stringify(revised),
      toJson(envelope.rationale_refs),
      JSON.stringify(evaluated.map((e) => ({ ref: e.ref, met: e.met, failures: e.failures }))),
      receivedStatus,
      reasonSummary,
      now,
      actor,
      commitSeq,
    );
    db.prepare(
      "UPDATE plan_runs SET status = 'received', updated_seq = ?, state_version = state_version + 1 WHERE id = ?",
    ).run(commitSeq, planRunId);

    sink.emit("plan.received", {
      subject_ids: [planRevisionId, planRunId, ...created.map((c) => c.intent_id), ...revised.map((r) => r.intent_id)],
      changed_fields: ["received_status"],
      payload: {
        submission_id: envelope.submission_id,
        plan_revision_id: planRevisionId,
        plan_run_id: planRunId,
        revision: envelope.plan_revision,
        received_status: receivedStatus,
        created: created.map((c) => ({ intent_id: c.intent_id, outcome: c.outcome })),
        revised: revised.map((r) => ({ intent_id: r.intent_id, outcome: r.outcome })),
        suspended_count: suspendedCount,
        rejected_count: rejectedCount,
      },
    });
    flushEvents(db, { projectId, actor, commitSeq, causeRef: envelope.submission_id, events: sink.events, now });

    const receipt = {
      submission_id: envelope.submission_id,
      plan_run_id: planRunId,
      plan_revision_id: planRevisionId,
      revision: envelope.plan_revision,
      received_status: receivedStatus,
      commit_seq: commitSeq,
      scope_revision: planScope,
      ids,
      intents_created: created,
      intents_updated: revised,
      suspended,
      rejected,
      warnings,
      result_hash: null,
    };
    receipt.result_hash = sha256Hex(
      canonicalJson({
        submission_id: receipt.submission_id,
        plan_revision_id: receipt.plan_revision_id,
        commit_seq: receipt.commit_seq,
        received_status: receipt.received_status,
        ids: receipt.ids,
      }),
    );
    db.prepare(
      `INSERT INTO submissions (id, project_id, submitter_id, request_digest, receipt, commit_seq,
         status, accepted_operations, warnings, result_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'committed', ?, ?, ?, ?)`,
    ).run(
      envelope.submission_id,
      projectId,
      actor,
      requestDigest,
      JSON.stringify(receipt),
      commitSeq,
      JSON.stringify([...created, ...revised]),
      JSON.stringify(warnings),
      receipt.result_hash,
      now,
    );
    return receipt;
  });
}

/* ── 意图列表（§10.1 状态/优先级过滤；端点 #21） ───────────────────── */

export async function listIntents(pctx, { projectId, statuses, kinds, goalId, priorityMin, priorityMax, limit, cursor, includeHistory }) {
  const store = await getStore(pctx);
  const db = store.db;
  const project = db.prepare("SELECT id FROM projects WHERE id = ?").get(projectId);
  if (!project) {
    throw apiError("NOT_FOUND", `项目不存在：${projectId}`);
  }
  const conditions = ["project_id = ?"];
  const args = [projectId];
  if (statuses && statuses.length) {
    conditions.push(`status IN (${statuses.map(() => "?").join(",")})`);
    args.push(...statuses);
  }
  if (kinds && kinds.length) {
    conditions.push(`kind IN (${kinds.map(() => "?").join(",")})`);
    args.push(...kinds);
  }
  if (goalId) {
    conditions.push("goal_id = ?");
    args.push(goalId);
  }
  if (priorityMin !== undefined) {
    conditions.push("priority >= ?");
    args.push(priorityMin);
  }
  if (priorityMax !== undefined) {
    conditions.push("priority <= ?");
    args.push(priorityMax);
  }
  // 游标分页（§9 UI 通用规则：不静默截断）：(created_seq, id) 复合续读
  let afterSeq = null;
  let afterId = null;
  if (cursor) {
    const m = /^(\d+):(.+)$/.exec(cursor);
    if (!m) {
      throw apiError("BAD_REQUEST", "cursor 格式非法（应使用上一页返回的 next_cursor）");
    }
    afterSeq = Number(m[1]);
    afterId = m[2];
  }
  if (afterSeq !== null) {
    conditions.push("(created_seq > ? OR (created_seq = ? AND id > ?))");
    args.push(afterSeq, afterSeq, afterId);
  }
  const pageLimit = Math.min(Math.max(limit ?? 50, 1), 200);
  const rows = db
    .prepare(
      `SELECT * FROM intents WHERE ${conditions.join(" AND ")}
         ORDER BY created_seq, id LIMIT ?`,
    )
    .all(...args, pageLimit + 1);
  const hasMore = rows.length > pageLimit;
  const page = rows.slice(0, pageLimit);
  let historyByIntent = null;
  if (includeHistory && page.length) {
    const marks = page.map(() => "?").join(",");
    const historyRows = db
      .prepare(
        `SELECT * FROM intent_state_history WHERE project_id = ? AND intent_id IN (${marks})
           ORDER BY commit_seq, id`,
      )
      .all(projectId, ...page.map((r) => r.id));
    historyByIntent = new Map();
    for (const h of historyRows) {
      if (!historyByIntent.has(h.intent_id)) historyByIntent.set(h.intent_id, []);
      historyByIntent.get(h.intent_id).push(historyView(h));
    }
  }
  const last = page[page.length - 1];
  return {
    project_id: projectId,
    intents: page.map((r) => intentView(r, historyByIntent ? historyByIntent.get(r.id) || [] : undefined)),
    next_cursor: hasMore && last ? `${last.created_seq}:${last.id}` : null,
    has_more: hasMore,
  };
}

export async function getIntentStateHistory(pctx, { projectId, intentId }) {
  const store = await getStore(pctx);
  const db = store.db;
  const intent = db.prepare("SELECT id FROM intents WHERE id = ? AND project_id = ?").get(intentId, projectId);
  if (!intent) {
    throw apiError("INVALID_REFERENCE", `意图不存在或不属于该项目：${intentId}`);
  }
  return {
    intent_id: intentId,
    history: db
      .prepare("SELECT * FROM intent_state_history WHERE project_id = ? AND intent_id = ? ORDER BY commit_seq, id")
      .all(projectId, intentId)
      .map(historyView),
  };
}

/* ── 状态机（§10.1：九态 + 历史唯一写入点） ───────────────────────── */

/**
 * 显式状态转换（供调度/协调侧程序调用；expected_state_version 可选，提供即按
 * §11.3 修改型校验）。transitionIntent 是 intent 状态与历史的唯一写入实现；
 * C2/E1 若直接改 intents.status 将绕过历史（协调项见竣工记录）。
 */
export async function transitionIntent(
  pctx,
  { projectId, actor, intentId, action, expectedStateVersion, reason, resumeConditions, via },
) {
  const store = await getStore(pctx);
  return store.runSerial((db) =>
    applyIntentTransition(db, { projectId, actor, intentId, action, expectedStateVersion, reason, resumeConditions, via }),
  );
}

/**
 * 事务内同步的意图状态转换原语（§11.3）。调用方须已在 runSerial 事务中，
 * 禁止再调 runSerial。transitionIntent 与 reconcileIntentLiveness 共用此原语，
 * 保证状态校验、state_version、历史、Outbox 一致。
 */
export function applyIntentTransition(
  db,
  { projectId, actor, intentId, action, expectedStateVersion, reason, resumeConditions, via },
) {
    const row = db.prepare("SELECT * FROM intents WHERE id = ? AND project_id = ?").get(intentId, projectId);
    if (!row) {
      throw apiError("INVALID_REFERENCE", `意图不存在或不属于该项目：${intentId}`);
    }
    const transition = INTENT_TRANSITIONS[action];
    if (!transition) {
      throw apiError("BAD_REQUEST", `未知意图转换动作：${action}（允许：${Object.keys(INTENT_TRANSITIONS).join(" / ")}）`);
    }
    if (expectedStateVersion !== undefined && expectedStateVersion !== null) {
      if (typeof expectedStateVersion !== "number" || !Number.isInteger(expectedStateVersion)) {
        throw apiError("BAD_REQUEST", "expected_state_version 必须是整数");
      }
      if (row.state_version !== expectedStateVersion) {
        throw apiError("STALE_STATE", `意图 ${intentId} 的 state_version 已变化，拒绝转换（§11.3）`, {
          detail: { current_state_version: row.state_version, expected_state_version: expectedStateVersion },
          next_requirements: [`以 expected_state_version=${row.state_version} 重试`],
        });
      }
    }
    if (!transition.from.includes(row.status)) {
      throw apiError(
        "PRECONDITION_INVALID",
        `意图 ${intentId} 当前状态 ${row.status} 不允许执行 ${action}（→ ${transition.to}）`,
        {
          detail: { current_status: row.status, action, target: transition.to },
          next_requirements: [
            `合法迁移：${Object.entries(INTENT_TRANSITIONS)
              .map(([a, t]) => `${a}: ${t.from.join("|")} → ${t.to}`)
              .join("；")}`,
          ],
        },
      );
    }
    const commitSeq = nextCommitSeq(db, projectId);
    const now = new Date().toISOString();
    let resumeJson = row.resume_conditions;
    if (action === "defer" && Array.isArray(resumeConditions) && resumeConditions.length) {
      resumeJson = toJson([...JSON.parse(row.resume_conditions), ...resumeConditions]);
    }
    db.prepare(
      "UPDATE intents SET status = ?, state_version = state_version + 1, resume_conditions = ?, updated_seq = ? WHERE id = ?",
    ).run(transition.to, resumeJson, commitSeq, intentId);
    recordHistory(db, {
      projectId,
      intentId,
      fromStatus: row.status,
      toStatus: transition.to,
      action,
      reason: reason || "",
      via: via || "transition",
      actor,
      commitSeq,
      now,
    });
    const sink = makeEventSink();
    if (transition.to === "blocked") {
      sink.emit("intent.blocked", {
        subject_ids: [intentId],
        payload: { intent_id: intentId, from: row.status, reason: reason || "" },
      });
    }
    if (transition.to === "resolved") {
      // resolved 不含项目关闭语义（§10.1/§1）：LLM 一句完成不关项目
      sink.emit("intent.completed", {
        subject_ids: [intentId],
        payload: { intent_id: intentId, from: row.status, reason: reason || "" },
      });
    }
    flushEvents(db, { projectId, actor, commitSeq, causeRef: `intent:${intentId}`, events: sink.events, now });
    const updated = db.prepare("SELECT * FROM intents WHERE id = ?").get(intentId);
    return {
      intent: intentView(updated),
      commit_seq: commitSeq,
    };
}

/**
 * 确定性执行态对账（事务内同步）：强制不变式
 *   意图 running 必须有至少一个 leased/running attempt；派发后尚未开工时，
 *   queued 意图可以已有 leased attempt。
 * 调用方须已在 runSerial 事务中。无活跃 attempt 的 running 意图按触发 attempt 的
 * recovery_note.reason_code 分流：reassign → requeue；retryable 在预算内 requeue、
 * 超预算 block + 搁置；dead_end → block + 搁置。
 * 幂等：非 running、或仍有活跃 attempt 的意图直接返回 {reconciled:false}。
 */
export function reconcileIntentLiveness(db, { projectId, intentId, triggerAttemptId }) {
  const row = db.prepare("SELECT * FROM intents WHERE id = ? AND project_id = ?").get(intentId, projectId);
  if (!row || row.status !== "running") return { reconciled: false, reason: "not_running" };

  const active = db
    .prepare(
      "SELECT COUNT(*) AS c FROM attempts WHERE project_id = ? AND intent_id = ? AND status IN ('leased','running')",
    )
    .get(projectId, intentId).c;
  if (active > 0) return { reconciled: false, reason: "has_active_attempt" };

  let reasonCode = "reassign";
  if (triggerAttemptId) {
    const att = db
      .prepare("SELECT recovery_note FROM attempts WHERE project_id = ? AND intent_id = ? AND id = ?")
      .get(projectId, intentId, triggerAttemptId);
    if (att && att.recovery_note) {
      try {
        const rc = JSON.parse(att.recovery_note).reason_code;
        if (rc === "retryable" || rc === "reassign" || rc === "dead_end") reasonCode = rc;
      } catch { /* 无结构化原因码 → 默认 reassign */ }
    }
  }

  if (reasonCode === "dead_end") {
    applyIntentTransition(db, {
      projectId, actor: "runtime/reconcile", intentId, action: "block",
      reason: "执行方向判定为死胡同，确定性搁置（reconcileIntentLiveness）",
      via: "reconcile",
    });
    shelveBranchInTx(db, {
      projectId, branchId: intentId,
      shelveReason: "conditions_unmet",
      reasonDetail: "无活跃 attempt 且触发 attempt 标记 dead_end",
      wakeOnEventTypes: ["resource_state.changed", "capture.stored"],
    });
    return { reconciled: true, action: "block", reason_code: reasonCode };
  }

  if (reasonCode === "retryable") {
    const nextRetryCount = Number(row.retry_count || 0) + 1;
    const retryLimit = Number.isInteger(row.retry_limit) ? row.retry_limit : 3;
    db.prepare("UPDATE intents SET retry_count = ? WHERE id = ? AND project_id = ?")
      .run(nextRetryCount, intentId, projectId);
    if (nextRetryCount > retryLimit) {
      applyIntentTransition(db, {
        projectId, actor: "runtime/reconcile", intentId, action: "block",
        reason: `自动重试预算已耗尽（${nextRetryCount - 1}/${retryLimit} 次重试后仍失败），确定性搁置`,
        via: "reconcile",
      });
      shelveBranchInTx(db, {
        projectId, branchId: intentId,
        shelveReason: "blocked",
        reasonDetail: `retryable 连续失败超过上限：retry_count=${nextRetryCount}, retry_limit=${retryLimit}`,
        reconsiderConditions: ["目标或依赖恢复可达", "用户明确要求重新开启该方向"],
        wakeOnEventTypes: ["resource_state.changed", "message.received"],
      });
      return {
        reconciled: true,
        action: "block",
        reason_code: reasonCode,
        retry_count: nextRetryCount,
        retry_limit: retryLimit,
        retry_exhausted: true,
      };
    }
  }

  applyIntentTransition(db, {
    projectId, actor: "runtime/reconcile", intentId, action: "requeue",
    reason: "无活跃 attempt（reason_code=" + reasonCode + "），确定性退回 queued 等重新派发",
    via: "reconcile",
  });
  return {
    reconciled: true,
    action: "requeue",
    reason_code: reasonCode,
    retry_count: reasonCode === "retryable" ? Number(row.retry_count || 0) + 1 : Number(row.retry_count || 0),
    retry_limit: Number.isInteger(row.retry_limit) ? row.retry_limit : 3,
  };
}

/** 事务内搁置原语（§十四/§十六）：同一意图同一时刻只有一条活动搁置。 */
function shelveBranchInTx(db, { projectId, branchId, shelveReason, reasonDetail, scope, reconsiderConditions, wakeOnEventTypes }) {
  const existing = db
    .prepare("SELECT id FROM branch_shelving WHERE project_id = ? AND branch_id = ? AND status = 'shelved'")
    .get(projectId, branchId);
  if (existing) return { shelving_id: existing.id, already_shelved: true };

  const commitSeq = nextCommitSeq(db, projectId);
  const now = new Date().toISOString();
  const n = nextSeq(db, projectId, "branch_shelving");
  const id = `SH-${projectId}-${pad4(n)}`;
  db.prepare(
    `INSERT INTO branch_shelving
       (id, project_id, branch_id, branch_kind, shelve_reason, reason_detail, scope,
        reconsider_conditions_json, wake_on_event_types_json,
        status, shelved_at, created_at, created_by, created_seq)
     VALUES (?, ?, ?, 'intent', ?, ?, ?, ?, ?, 'shelved', ?, ?, ?, ?)`,
  ).run(
    id, projectId, branchId, shelveReason || "unknown", reasonDetail || "", scope || "",
    JSON.stringify(reconsiderConditions || []), JSON.stringify(wakeOnEventTypes || []),
    now, now, "runtime/reconcile", commitSeq,
  );
  return { shelving_id: id, already_shelved: false };
}

/* ── 完成建议检查（§10.1：必要产物 + 状态条件；一句完成不关项目） ──── */

function deliverableKeyOf(entry, index) {
  if (entry && typeof entry === "object" && typeof entry.key === "string" && entry.key) return entry.key;
  return String(index);
}

/**
 * Worker 完成建议的程序检查（§10.1）：
 *   1. 状态条件：意图必须处于 running/awaiting_review，且 requires 边上声明的
 *      前提期望此刻仍然成立（§2.9/§9.2 动作前重查必要前提）；
 *   2. 必要产物：意图声明的每个交付物必须有交付证明，证明引用的记录必须真实
 *      存在（INVALID_REFERENCE 拒绝伪产物）；缺失 → PRECONDITION_INVALID 列出
 *      缺口，意图保持原状态；
 *   3. 未声明交付物的完成建议无法程序验证 → 只进入 awaiting_review 交
 *      planner/verifier 复核（语义争议交 AI，§10.1）；
 *   4. resolved 只代表该版本问题已处理：不触碰项目状态，不终结其他意图。
 */
export async function reviewCompletion(pctx, { projectId, actor, intentId, attemptId, deliverablesProof, note }) {
  const store = await getStore(pctx);
  return store.runSerial((db) => {
    const row = db.prepare("SELECT * FROM intents WHERE id = ? AND project_id = ?").get(intentId, projectId);
    if (!row) {
      throw apiError("INVALID_REFERENCE", `意图不存在或不属于该项目：${intentId}`);
    }
    if (attemptId !== undefined && attemptId !== null && attemptId !== "") {
      const att = db.prepare("SELECT id FROM attempts WHERE id = ? AND project_id = ?").get(attemptId, projectId);
      if (!att) {
        throw apiError("INVALID_REFERENCE", `完成建议关联的 attempt 不存在：${attemptId}`, {
          next_requirements: ["修正 attempt_id，或省略以提交不带执行关联的完成建议"],
        });
      }
    }
    if (row.status !== "running" && row.status !== "awaiting_review") {
      throw apiError(
        "PRECONDITION_INVALID",
        `完成建议只能针对执行中（running）或待复核（awaiting_review）的意图；${intentId} 当前为 ${row.status}（§10.1）`,
        {
          detail: { current_status: row.status },
          next_requirements: [`先经 activate/start 使意图进入 running，或处理当前状态（${row.status}）`],
        },
      );
    }
    // 状态条件：requires 边的前提期望重验（§9.2 动作前重查必要前提）
    const requiresEdges = db
      .prepare(
        `SELECT * FROM relations WHERE project_id = ? AND from_id = ? AND relation_type = 'requires'
           AND retracted_at IS NULL`,
      )
      .all(projectId, intentId);
    const prereqFailures = [];
    for (const edge of requiresEdges) {
      if (!edge.requires_state) continue; // 未声明期望的前提只要求存在
      let expectation;
      try {
        expectation = JSON.parse(edge.requires_state);
      } catch {
        continue;
      }
      const located = locateRecord(db, projectId, edge.to_id);
      if (!located || !EXPECTABLE_FIELDS[located.table]) continue;
      const subject = db
        .prepare(`SELECT * FROM ${located.table} WHERE id = ? AND project_id = ?`)
        .get(edge.to_id, projectId);
      if (!subject) {
        prereqFailures.push({ ref: edge.to_id, field: "existence", expected: "存在", actual: "已不存在" });
        continue;
      }
      for (const [key, value] of Object.entries(expectation)) {
        const field = key.replace(/^expected_/, "");
        if (subject[field] !== value) {
          prereqFailures.push({ ref: edge.to_id, field, expected: value, actual: subject[field] });
        }
      }
    }
    if (prereqFailures.length > 0) {
      throw apiError("PRECONDITION_INVALID", `完成建议被拒：执行期间前提已失效（${prereqFailures.map((f) => `${f.ref}.${f.field} 期望 ${JSON.stringify(f.expected)} 实际 ${JSON.stringify(f.actual)}`).join("；")}），先处理依赖（§9.2/§10.1）`, {
        detail: { prerequisite_failures: prereqFailures },
        next_requirements: prereqFailures.map((f) => recoveryConditionText(f.ref, [f])),
      });
    }
    // 必要产物：声明的交付物逐项核对证明；证明引用的记录必须存在
    const deliverables = JSON.parse(row.deliverables);
    const proofs = Array.isArray(deliverablesProof) ? deliverablesProof : [];
    const proofByIndex = new Map();
    const proofByKey = new Map();
    for (const proof of proofs) {
      if (!proof || typeof proof !== "object") {
        throw apiError("BAD_REQUEST", "deliverables_proof 的每项必须是对象（{ index|key, record_ids }）");
      }
      const recordIds = strArray(proof.record_ids, "deliverables_proof[].record_ids");
      for (const ref of recordIds) {
        if (!locateRecord(db, projectId, ref)) {
          throw apiError("INVALID_REFERENCE", `交付证明引用的记录不存在：${ref}（必要产物必须真实存在，§10.1）`, {
            detail: { ref },
            next_requirements: ["先持久保存被引用的记录，再提交完成建议"],
          });
        }
      }
      if (proof.index !== undefined) proofByIndex.set(String(proof.index), proof);
      if (proof.key !== undefined) proofByKey.set(String(proof.key), proof);
    }
    const commitSeq = nextCommitSeq(db, projectId);
    const now = new Date().toISOString();
    const sink = makeEventSink();
    const historyBase = {
      projectId,
      intentId,
      actor,
      via: attemptId ? `completion:${attemptId}` : "completion",
    };
    if (deliverables.length === 0) {
      // 未声明交付物：程序无法验证必要产物 → 交复核，绝不直接 resolved（§10.1）
      if (row.status === "awaiting_review") {
        recordHistory(db, {
          ...historyBase,
          fromStatus: row.status,
          toStatus: "awaiting_review",
          action: "completion_suggested",
          reason: note || "重复完成建议：无声明交付物，继续等待复核",
          commitSeq,
          now,
        });
        flushEvents(db, { projectId, actor, commitSeq, causeRef: `intent:${intentId}`, events: [], now });
        return { intent_id: intentId, decision: "awaiting_review", reason: "意图未声明交付物，完成建议维持待复核（交 planner/verifier）" };
      }
      db.prepare("UPDATE intents SET status = 'awaiting_review', state_version = state_version + 1, updated_seq = ? WHERE id = ?").run(commitSeq, intentId);
      recordHistory(db, {
        ...historyBase,
        fromStatus: row.status,
        toStatus: "awaiting_review",
        action: "submit_review",
        reason: note || "无声明交付物：程序无法验证必要产物，交 planner/verifier 复核（§10.1）",
        commitSeq,
        now,
      });
      flushEvents(db, { projectId, actor, commitSeq, causeRef: `intent:${intentId}`, events: sink.events, now });
      return {
        intent_id: intentId,
        decision: "awaiting_review",
        reason: "意图未声明交付物，完成建议进入待复核；一句完成不能直接 resolved（§10.1）",
      };
    }
    const missing = [];
    for (let i = 0; i < deliverables.length; i++) {
      const key = deliverableKeyOf(deliverables[i], i);
      const proof = proofByIndex.get(String(i)) || proofByKey.get(key);
      if (!proof || !Array.isArray(proof.record_ids) || proof.record_ids.length === 0) {
        missing.push({ index: i, key, deliverable: deliverables[i] });
      }
    }
    if (missing.length > 0) {
      throw apiError(
        "PRECONDITION_INVALID",
        `完成建议被拒：缺少必要产物证明（${missing.map((m) => `#${m.index}${m.key !== String(m.index) ? `(${m.key})` : ""}`).join("、")}）；一句完成不能替代交付物（§10.1）`,
        {
          detail: { missing_deliverables: missing },
          next_requirements: missing.map((m) => `补齐交付物 #${m.index} 的证明（deliverables_proof 提供 record_ids，且记录须真实存在）`),
        },
      );
    }
    db.prepare("UPDATE intents SET status = 'resolved', state_version = state_version + 1, updated_seq = ? WHERE id = ?").run(commitSeq, intentId);
    recordHistory(db, {
      ...historyBase,
      fromStatus: row.status,
      toStatus: "resolved",
      action: "resolve",
      reason: note || `必要产物齐备（${deliverables.length} 项交付物均有真实记录作证），前提重验通过`,
      commitSeq,
      now,
    });
    sink.emit("intent.completed", {
      subject_ids: [intentId],
      payload: { intent_id: intentId, from: row.status, attempt_id: attemptId || null, deliverables_proven: deliverables.length },
    });
    flushEvents(db, { projectId, actor, commitSeq, causeRef: `intent:${intentId}`, events: sink.events, now });
    // §10.1/§1：resolved 只表示该版本问题已处理——项目状态与其余意图一概不动
    return {
      intent_id: intentId,
      decision: "resolved",
      deliverables_proven: deliverables.length,
      note: "resolved 不代表关联资产已测透，也不改变项目运行状态（§10.1）",
    };
  });
}
