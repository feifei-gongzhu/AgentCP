/**
 * C2 —— 执行运行时与工具网关（规范 §10.2 §17 §3.2；蓝图 §3 C2、§5 端点 #22–#26）。
 *
 * 合同落实（§10.2 逐条）：
 *   - Attempt：唯一编号（ATT-####）、worker 身份、租约截止时间、单调递增
 *     fencing token（id_sequences kind=fencing，项目内单调；DDL
 *     UNIQUE(project_id, fencing_token) 兜底）。
 *   - 条件领取：同一执行分配（assignment_id）在同一时刻最多一个有效租约——
 *     DDL 部分唯一索引 idx_attempts_active_assignment(status IN leased/running)
 *     是硬约束；INSERT 撞索引时按幂等/冲突分流（跨进程并发亦受保护）。
 *     心跳续租为条件 UPDATE（token+状态+租约三条件）；过期阻止旧执行继续
 *     操作（LEASE_EXPIRED）并以 resource_state.changed(kind=lease_expired)
 *     通知 Orchestrator 决定恢复、重派或调整——程序不自行重派（§3.2：
 *     传输重试可由程序完成，涉及测试策略的重试由 AI 决定）。
 *   - 旧 Attempt 迟到提交：合法证据/进展仍留档（worker_reports 行 + late
 *     标记 + 来源），不得改变新 Attempt 的执行状态，不得继续获得工具执行
 *     权限（§20.3 场景 17）。
 *   - ToolCall：planned→running→succeeded/failed/unknown；进程中断且无法判断
 *     外部操作是否已完成时标 unknown；unknown 必须先核查现状（resolve 需
 *     check_note）才能重试同身份调用（§20.3 场景 18）；不把工具调用视作
 *     恰好一次——重试是新调用（新 TC 编号），采集去重由 A2 的 tool_call_id 承担。
 *   - 子 agent：统一登记为所属 Attempt 的工具调用（tool_calls.created_by 记
 *     执行 agent 身份），继承同一租约/范围/前提/预算，受同一并发上限约束，
 *     不得经子 agent 另开无限执行链（§10.2）。
 *
 * §17 落实：派发时（意图目标资产）与每次工具动作前（register/start 逐目标）
 * 校验范围（当前 scope_revisions 版本，拒绝优先）、执行前提（requires 边与
 * prerequisite_refs，含 requires_state 谓词 status/review/scope_status）、租约
 * 与资源上限；重定向/新目标逐跳过闸（新调用即新闸门）。范围变化立即影响
 * 新动作；已发出操作经 complete 记录实际结果（含 touched_targets 事后判定）。
 * 目标集重申契约：冻结 DDL 的 tool_calls 仅存 args_digest（无 args 列），登记
 * 时派生的目标集随回执返回（declared_targets），执行运行时在 start 请求重申
 * 以完成启动前逐跳复检；未重申时不做目标复检（登记时已全量过闸），由
 * complete 的 touched_targets 事后判定兜底记录。
 *
 * §16.4/§3.2 落实：用户停止立即生效——任何 C2 操作先执行 sweep：项目 stopped
 * → 撤销有效执行权（活跃 Attempt → interrupted，running 调用 → unknown，
 * planned → cancelled，发 execution_revoked 事件）；租约到期 → interrupted +
 * running → unknown（结果未观测）+ lease_expired 通知事件。paused 阻止新动作
 * （新派发/新工具动作），但允许心跳与在途调用的落定（记录实际结果）。
 * 历史一律保留（状态变化只改行状态，不删行）。
 *
 * 权限（蓝图 §8.2）：#22/#24 runtime；#25 worker（本人 Attempt）/runtime；
 * #26 worker（本人 Attempt，经网关）/runtime；#23 任意有效会话只读
 * （fencing_token 对 user 角色隐藏）。project_id/actor 以会话为准（§11.1）。
 *
 * 边界（§3.2）：本模块只做程序侧保障——权限、必要前提、范围、资源上限、
 * 租约、幂等、与 Outbox 同事务的可靠通知；不替 AI 判断探索策略、不内置
 * 固定重试剧本、不改 intents 状态机（C1 领域）与漏洞状态（D 阶段领域）。
 */
import { createHash } from "node:crypto";

import { apiError } from "../errors.mjs";
import { EVENT_SCHEMA_VERSION, getStore, GLOBAL_SEQ_SCOPE } from "./record-service.mjs";
import {
  checkActionTargets,
  checkIntentTargets,
  evaluateTarget,
  parseTarget,
  persistAssetScopeVerdicts,
} from "./scope.mjs";
import { reconcileIntentLiveness } from "./intents.mjs";

/* ── 常量（资源上限默认值可被 projects.resource_policy / intents.budget 覆盖） ── */

// 30 分钟：runtime 每 tick 只驱动 1 个 Worker + 5 分钟 tick 时，10 分钟租约会在
// 等待被驱动期间就过期（实测 38 次 interrupted / 8 条 running intent 的尝试全部
// lease_expired）。租约仍是崩溃保护，但必须覆盖「排队等待 + 一轮执行」的时长。
export const DEFAULT_LEASE_TTL_MS = 30 * 60 * 1000;
export const MIN_LEASE_TTL_MS = 1000;
export const MAX_LEASE_TTL_MS = 24 * 60 * 60 * 1000;
/** 统一并发上限（含子 agent 的调用；§10.2「受统一并发限制」的默认值）。 */
export const DEFAULT_MAX_RUNNING_TOOL_CALLS = 8;
export const MAX_TARGETS_PER_CALL = 64;
/** 工具调用网关动作目录（#26 单端点，动作路由）。 */
export const TOOL_ACTIONS = Object.freeze([
  "register",
  "start",
  "complete",
  "mark_unknown",
  "resolve",
  "cancel",
]);
/** Attempt 终态（不再持有租约/执行权）。 */
const TERMINAL_ATTEMPT_STATUS = new Set(["completed", "failed", "cancelled"]);
/** 心跳与租约有效性承认的项目状态（paused 允许心跳：暂停不撤销在途租约）。 */
const HEARTBEAT_PROJECT_STATUS = new Set(["active", "waiting_for_change", "paused"]);
/** 新执行动作（派发/登记/启动）允许的项目状态。 */
const NEW_EXECUTION_PROJECT_STATUS = new Set(["active", "waiting_for_change"]);

const TOOL_CALL_TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

/* ── 基础工具 ─────────────────────────────────────────────────────── */

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

function sha256Hex(text) {
  return createHash("sha256").update(text).digest("hex");
}

function nowIso() {
  return new Date().toISOString();
}

/** node:sqlite 的唯一约束违例（code=ERR_SQLITE_ERROR + UNIQUE constraint failed 消息）。 */
function isUniqueConstraintError(error) {
  return (
    error &&
    (error.code === "ERR_SQLITE_ERROR" || String(error.code || "").startsWith("SQLITE_CONSTRAINT")) &&
    /UNIQUE constraint failed/i.test(String(error.message || ""))
  );
}

/** 事务内分配稳定编号（§6.1；与 A1 同一 id_sequences 模式，序列只保证单调允许空洞）。 */
function allocateSeq(db, projectId, kind) {
  db.prepare(
    "INSERT INTO id_sequences (project_id, kind, next_val) VALUES (?, ?, 2) ON CONFLICT DO NOTHING",
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

function formatSeqId(prefix, n) {
  return `${prefix}-${String(n).padStart(4, "0")}`;
}

/** 项目级 commit_seq（§14.1 事务内分配）。 */
function allocateCommitSeq(db, projectId) {
  const row = db.prepare("SELECT next_commit_seq AS n FROM projects WHERE id = ?").get(projectId);
  db.prepare("UPDATE projects SET next_commit_seq = ? WHERE id = ?").run(row.n + 1, projectId);
  return row.n;
}

/** 同事务写 Outbox 事件（§2 约束 10：数据变化与事件同事务提交）。 */
function emitEvent(db, { projectId, commitSeq, eventType, subjectIds, changedFields, causeRefs, producerId, payload, now, eventIndex = 1 }) {
  db.prepare(
    `INSERT INTO outbox (event_id, project_id, commit_seq, event_index, event_type, subject_ids,
       changed_fields, cause_refs, producer_id, schema_version, payload, delivery_status,
       delivery_attempts, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)`,
  ).run(
    `EVT-${projectId}-${commitSeq}-${eventIndex}`,
    projectId,
    commitSeq,
    eventIndex,
    eventType,
    JSON.stringify(subjectIds || []),
    JSON.stringify(changedFields || []),
    JSON.stringify(causeRefs && causeRefs.length ? causeRefs : [eventType]),
    producerId,
    EVENT_SCHEMA_VERSION,
    JSON.stringify(payload || {}),
    now,
  );
}

/** 多态引用定位（record-service 的 locateRecord 未导出，此处等价实现）。 */
const PREFIX_TABLES = Object.freeze({
  A: "assets",
  ATT: "attempts",
  B: "blobs",
  CAP: "captures",
  EM: "evidence_memberships",
  F: "facts",
  G: "goals",
  H: "hypotheses",
  I: "intents",
  O: "observations",
  R: "relations",
  T: "endpoint_templates",
  V: "vulnerabilities",
});
const LOCATE_TABLES = Object.freeze([
  "assets", "observations", "hypotheses", "facts", "vulnerabilities", "relations",
  "goals", "intents", "captures", "blobs", "attempts", "endpoint_templates",
]);

function locateSubject(db, projectId, ref) {
  if (typeof ref !== "string" || !ref) return null;
  const m = /^([A-Za-z]+)-\d+$/.exec(ref);
  if (m && PREFIX_TABLES[m[1]]) {
    const table = PREFIX_TABLES[m[1]];
    if (existsIn(db, table, ref, projectId)) return { table };
  }
  for (const table of LOCATE_TABLES) {
    if (existsIn(db, table, ref, projectId)) return { table };
  }
  return null;
}

function existsIn(db, table, ref, projectId) {
  return Boolean(
    db.prepare(`SELECT 1 FROM ${table} WHERE id = ? AND project_id = ?`).get(ref, projectId),
  );
}

function parseJsonField(text, fallback) {
  if (text === null || text === undefined) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/* ── 前提校验（§9.2/§17：派发与动作前；requires 边 + prerequisite_refs） ── */

/** 解析 requires_state 的机器可判定谓词（status=/review=/scope_status=）；其余文本为 AI 描述，不判定。 */
function parsePredicates(text) {
  if (typeof text !== "string" || !text.trim()) return {};
  const out = {};
  for (const part of text.split(/[;,\s]+/)) {
    const m = /^(status|review|scope_status)=(\S+)$/.exec(part);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const JUDGEMENT_INVALID_STATUS = Object.freeze({
  hypotheses: new Set(["rejected"]),
  facts: new Set(["superseded", "retracted"]),
  vulnerabilities: new Set(["falsified"]),
});

/**
 * 前提链检查（§9.2：上游被推翻 → 阻止不满足前提的后续动作；confirmed 复核
 * 标记未清 → 不能无条件放行，§8.2/§20.3 场景 9 的执行面）。
 * 返回逐前提结果；任一不满足抛 PRECONDITION_INVALID。
 */
function checkPrerequisites(db, { projectId, intent, phase }) {
  const problems = [];
  const checked = [];
  const addProblem = (ref, reason, detail) => problems.push({ ref, reason, ...detail });

  // 1) requires 边（未撤回）
  const edges = db
    .prepare(
      `SELECT * FROM relations WHERE project_id = ? AND from_id = ? AND relation_type = 'requires'
         AND retracted_at IS NULL`,
    )
    .all(projectId, intent.id);
  const subjects = [];
  for (const edge of edges) {
    subjects.push({ ref: edge.to_id, edge, predicates: parsePredicates(edge.requires_state) });
  }
  // 2) prerequisite_refs（存在性 + 状态）
  for (const ref of parseJsonField(intent.prerequisite_refs, [])) {
    if (!subjects.some((s) => s.ref === ref)) subjects.push({ ref, edge: null, predicates: {} });
  }

  for (const { ref, edge, predicates } of subjects) {
    const located = locateSubject(db, projectId, ref);
    if (!located) {
      if (edge) {
        addProblem(ref, "前提对象不存在（requires 边指向的记录缺失）", { relation_id: edge.id });
      } else {
        throw apiError("INVALID_REFERENCE", `意图 ${intent.id} 的 prerequisite_refs 引用不存在的对象：${ref}`, {
          next_requirements: ["修正意图前提引用后重新派发（C1 计划修订）"],
        });
      }
      continue;
    }
    const table = located.table;
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ? AND project_id = ?`).get(ref, projectId);
    const entry = { ref, table, relation_id: edge ? edge.id : null, predicates };

    // 机器可判定谓词（§9.1 requires_state 的程序面；其余文本留给 AI）
    if (predicates.status !== undefined && row && row.status !== undefined &&
        row.status !== predicates.status) {
      addProblem(ref, `requires_state 要求 status=${predicates.status}，当前 ${row.status}`, {
        table, current: row.status,
      });
      checked.push({ ...entry, verdict: "invalid" });
      continue;
    }
    if (predicates.review !== undefined && row && row.review !== undefined &&
        row.review !== predicates.review) {
      addProblem(ref, `requires_state 要求 review=${predicates.review}，当前 ${row.review}`, {
        table, current: row.review,
      });
      checked.push({ ...entry, verdict: "invalid" });
      continue;
    }
    if (predicates.scope_status !== undefined) {
      if (table !== "assets" || !row) {
        addProblem(ref, `requires_state=scope_status 仅适用于资产前提`, { table });
        checked.push({ ...entry, verdict: "invalid" });
        continue;
      }
      const target = row.canonical_key;
      const verdict = parseTarget(target)
        ? evaluateTarget(db, { projectId, target }).verdict
        : "pending";
      if (verdict !== predicates.scope_status) {
        addProblem(ref, `requires_state 要求 scope_status=${predicates.scope_status}，当前判定 ${verdict}`, {
          table, current: verdict,
        });
        checked.push({ ...entry, verdict: "invalid" });
        continue;
      }
      checked.push({ ...entry, verdict: "ok" });
      continue;
    }

    // 判断类前提的失效/复核门槛（§9.2/§8.2）
    if (row && JUDGEMENT_INVALID_STATUS[table]) {
      if (JUDGEMENT_INVALID_STATUS[table].has(row.status)) {
        addProblem(ref, `前提判断已被推翻/失效（${table} status=${row.status}）`, { table, current: row.status });
        checked.push({ ...entry, verdict: "invalid" });
        continue;
      }
      if (table === "vulnerabilities" && row.review === "disputed") {
        addProblem(ref, "前提判断处于争议复核（review=disputed）", { table, current: row.review });
        checked.push({ ...entry, verdict: "invalid" });
        continue;
      }
      if (table === "vulnerabilities" && row.review === "pending") {
        addProblem(ref, "前提判断收到新相关证据待复核（review=pending），不能无条件放行（§8.2）", {
          table, current: row.review,
        });
        checked.push({ ...entry, verdict: "needs_recheck" });
        continue;
      }
    }
    checked.push({ ...entry, verdict: "ok" });
  }

  if (problems.length) {
    throw apiError(
      "PRECONDITION_INVALID",
      `意图 ${intent.id} 的执行前提不满足（${phase}被拒绝；§9.2/§17）：${problems
        .map((p) => `${p.ref}：${p.reason}`)
        .join("；")}`,
      {
        retryable: false,
        detail: { phase, problems },
        next_requirements: [
          "前提恢复（如复核通过、范围修订或 planner 调整前提）后再执行；程序不自动重试",
        ],
      },
    );
  }
  return checked;
}

/* ── sweep：过期租约与项目停止的即时生效（§10.2/§16.4/§18.2 步骤 3–4） ── */

/**
 * 执行态清扫（幂等；独立事务）：
 *   - 项目 stopped：活跃 Attempt → interrupted（撤销执行权）；running 调用 →
 *     unknown（外部结果未观测；运行时确认后经 resolve 记录取消结果），
 *     planned → cancelled；发 resource_state.changed(kind=execution_revoked)。
 *   - 租约到期：活跃 Attempt → interrupted；running → unknown、planned →
 *     cancelled；发 resource_state.changed(kind=lease_expired) 通知 Orchestrator。
 * 返回 {interrupted: [...], revoked: [...]}。任何 C2 写操作与 #23 视图先执行本清扫。
 */
export async function sweepExecutionState(pctx, projectId) {
  const store = await getStore(pctx);
  return store.runSerial((db) => sweepInTx(db, { projectId, now: nowIso(), actor: "runtime/sweep" }));
}

/**
 * 全项目孤儿对账（幂等；独立事务）：对每个 running 且无活跃 attempt 的意图调
 * reconcileIntentLiveness。覆盖正常写路径漏网的历史孤儿（如 attempt 已 cancelled
 * 但意图当时未对账）。sweep 只处理 leased/running attempt，够不到这些；本函数兜底。
 */
export async function reconcileProjectOrphans(pctx, projectId) {
  const store = await getStore(pctx);
  return store.runSerial((db) => {
    const orphans = db
      .prepare(
        `SELECT i.id FROM intents i
         WHERE i.project_id = ? AND i.status = 'running'
           AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.intent_id = i.id AND a.project_id = i.project_id AND a.status IN ('leased','running'))`,
      )
      .all(projectId);
    const reconciled = [];
    for (const o of orphans) {
      const latest = db
        .prepare(
          "SELECT id FROM attempts WHERE project_id = ? AND intent_id = ? ORDER BY created_seq DESC LIMIT 1",
        )
        .get(projectId, o.id);
      const out = reconcileIntentLiveness(db, {
        projectId, intentId: o.id, triggerAttemptId: latest ? latest.id : null,
      });
      if (out.reconciled) reconciled.push({ intent_id: o.id, ...out });
    }
    return { reconciled };
  });
}

function sweepInTx(db, { projectId, now, actor }) {
  const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId);
  if (!project) return { interrupted: [], revoked: [] };
  const active = db
    .prepare(
      `SELECT * FROM attempts WHERE project_id = ? AND status IN ('leased','running')`,
    )
    .all(projectId);
  const interrupted = [];
  const revoked = [];
  for (const att of active) {
    const expired = att.lease_expires_at !== null && att.lease_expires_at <= now;
    const stopped = project.status === "stopped";
    if (!expired && !stopped) continue;
    const reason = stopped && expired ? "project_stopped_and_lease_expired" : stopped ? "project_stopped" : "lease_expired";
    const commitSeq = allocateCommitSeq(db, projectId);
    const toolCalls = db
      .prepare(`SELECT * FROM tool_calls WHERE project_id = ? AND attempt_id = ?`)
      .all(projectId, att.id);
    const markedUnknown = [];
    const markedCancelled = [];
    for (const tc of toolCalls) {
      if (tc.status === "running") {
        db.prepare(`UPDATE tool_calls SET status = 'unknown', error = ?, updated_seq = ? WHERE id = ?`).run(
          stopped
            ? "项目停止，进程被撤销，外部操作结果未观测（确认后经 resolve 记录取消结果）"
            : "租约过期，进程中断，外部操作结果未观测（先检查现状再决定重试，§10.2）",
          commitSeq,
          tc.id,
        );
        markedUnknown.push(tc.id);
      } else if (tc.status === "planned") {
        db.prepare(`UPDATE tool_calls SET status = 'cancelled', error = ?, updated_seq = ? WHERE id = ?`).run(
          stopped ? "项目停止，未启动即取消" : "租约过期，未启动即取消",
          commitSeq,
          tc.id,
        );
        markedCancelled.push(tc.id);
      }
    }
    db.prepare(
      `UPDATE attempts SET status = 'interrupted', lease_expires_at = NULL, recovery_note = ?,
         updated_seq = ?, state_version = state_version + 1 WHERE id = ?`,
    ).run(
      JSON.stringify({
        reason,
        reason_code: stopped ? "reassign" : "retryable",
        at: now,
        note: stopped ? "用户停止，执行权撤销（§16.4）" : "租约过期，执行权失效（§10.2）",
      }),
      commitSeq,
      att.id,
    );
    emitEvent(db, {
      projectId,
      commitSeq,
      eventType: "resource_state.changed",
      subjectIds: [att.id, att.intent_id],
      changedFields: ["status", "lease"],
      causeRefs: [att.id],
      producerId: actor,
      payload: {
        kind: stopped ? "execution_revoked" : "lease_expired",
        attempt_id: att.id,
        intent_id: att.intent_id,
        assignment_id: att.assignment_id,
        worker_id: att.worker_id,
        fencing_token: att.fencing_token,
        reason,
        tool_calls_marked_unknown: markedUnknown,
        tool_calls_cancelled: markedCancelled,
        // §10.2：过期后由 Orchestrator 决定恢复、重派或调整；程序不自行重派
        decision_needed_by: "orchestrator",
      },
      now,
    });
    (stopped ? revoked : interrupted).push({
      attempt_id: att.id,
      reason,
      tool_calls_marked_unknown: markedUnknown,
      tool_calls_cancelled: markedCancelled,
    });
    // 租约过期（非项目停止）：对账该意图，无活跃 attempt 则退回 queued 等重派。
    // 项目 stopped 时不对账——执行权已撤销，不应把意图拉回可派发。
    if (!stopped) {
      reconcileIntentLiveness(db, { projectId, intentId: att.intent_id, triggerAttemptId: att.id });
    }
  }
  return { interrupted, revoked };
}

/* ── 视图 ─────────────────────────────────────────────────────────── */

function attemptView(db, row, { revealToken }) {
  const now = Date.now();
  const leaseState =
    row.status === "leased" || row.status === "running"
      ? row.lease_expires_at && Date.parse(row.lease_expires_at) > now
        ? "active"
        : "expired"
      : "none";
  const toolCalls = db
    .prepare(`SELECT * FROM tool_calls WHERE project_id = ? AND attempt_id = ? ORDER BY created_seq, rowid`)
    .all(row.project_id, row.id);
  const byStatus = {};
  for (const tc of toolCalls) byStatus[tc.status] = (byStatus[tc.status] || 0) + 1;
  const reports = db
    .prepare(`SELECT COUNT(*) AS c FROM worker_reports WHERE project_id = ? AND attempt_id = ?`)
    .get(row.project_id, row.id).c;
  const unhandled = db
    .prepare(
      `SELECT COUNT(*) AS c FROM worker_reports WHERE project_id = ? AND attempt_id = ? AND handling_status = 'pending'`,
    )
    .get(row.project_id, row.id).c;
  const view = {
    id: row.id,
    project_id: row.project_id,
    intent_id: row.intent_id,
    assignment_id: row.assignment_id,
    worker_id: row.worker_id,
    status: row.status,
    lease: {
      expires_at: row.lease_expires_at,
      state: leaseState,
      seconds_remaining:
        leaseState === "active" ? Math.max(0, Math.round((Date.parse(row.lease_expires_at) - now) / 1000)) : null,
    },
    recovery_note: parseJsonField(row.recovery_note, row.recovery_note || ""),
    created_at: row.created_at,
    created_by: row.created_by,
    created_seq: row.created_seq,
    updated_seq: row.updated_seq,
    state_version: row.state_version,
    tool_calls: {
      total: toolCalls.length,
      by_status: byStatus,
      running: toolCalls
        .filter((t) => t.status === "running")
        .map((t) => ({ id: t.id, tool_name: t.tool_name, agent: t.created_by })),
      unknown: toolCalls
        .filter((t) => t.status === "unknown")
        .map((t) => ({ id: t.id, tool_name: t.tool_name, error: t.error })),
      planned: toolCalls.filter((t) => t.status === "planned").map((t) => t.id),
    },
    reports: { total: reports, unhandled },
  };
  if (revealToken) view.fencing_token = row.fencing_token;
  return view;
}

function toolCallView(row) {
  return {
    id: row.id,
    project_id: row.project_id,
    attempt_id: row.attempt_id,
    tool_name: row.tool_name,
    args_digest: row.args_digest,
    status: row.status,
    agent: row.created_by,
    started_at: row.started_at,
    ended_at: row.ended_at,
    evidence_refs: parseJsonField(row.evidence_refs, []),
    error: row.error || "",
    created_at: row.created_at,
    created_seq: row.created_seq,
  };
}

function loadAttempt(db, projectId, attemptId) {
  const row = db
    .prepare("SELECT * FROM attempts WHERE project_id = ? AND id = ?")
    .get(projectId, attemptId);
  if (!row) {
    throw apiError("NOT_FOUND", `执行尝试不存在（项目 ${projectId}）：${attemptId}`);
  }
  return row;
}

/* ── #22 派发与条件领取（§10.2/§3.3 分配执行） ─────────────────────── */

function resourcePolicyOf(project) {
  return parseJsonField(project.resource_policy, {});
}

/**
 * 创建执行分配并领取租约（runtime 角色；AI 的分配决定经 assignment_id 关联）。
 * 同 assignment_id + 同 intent + 同 worker 的重复派发返回原 Attempt（幂等，
 * §16.2「完全相同的分配按幂等规则处理」）；同 assignment 不同内容 →
 * IDEMPOTENCY_KEY_REUSED。并发领取由部分唯一索引兜底。
 */
export async function dispatchAttempt(pctx, { session, intentId, assignmentId, workerId, leaseTtlMs, handoffSummary }) {
  if (typeof intentId !== "string" || !intentId.trim()) {
    throw apiError("BAD_REQUEST", "缺少 intent_id（要执行的意图编号）");
  }
  if (typeof workerId !== "string" || !workerId.trim()) {
    throw apiError("BAD_REQUEST", "缺少 worker_id（执行者身份；能力要求由协调决定记录承载）");
  }
  const ttl = normalizeTtl(leaseTtlMs);
  const store = await getStore(pctx);
  await sweepExecutionState(pctx, session.project_id);
  // 目标资产的范围判定先以独立小事务持久化（assets.scope_status 不随派发被拒
  // 回滚；下方派发事务内的范围校验仍以当前范围版本为权威）
  await store.runSerial((tx) => {
    const it = tx
      .prepare("SELECT * FROM intents WHERE project_id = ? AND id = ?")
      .get(session.project_id, intentId);
    if (it) persistAssetScopeVerdicts(tx, { projectId: session.project_id, intent: it });
  });
  return store.runSerial((db) => {
    const now = nowIso();
    const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(session.project_id);
    if (!project) throw apiError("NOT_FOUND", `项目不存在：${session.project_id}`);
    if (!NEW_EXECUTION_PROJECT_STATUS.has(project.status)) {
      throw apiError(
        "PRECONDITION_INVALID",
        `项目${PROJECT_STATUS_TEXT[project.status] || project.status}（status=${project.status}）：禁止新派发（§16.4：用户停止/暂停立即生效，不需要等待 AI 阅读消息）`,
        {
          retryable: project.status === "paused",
          detail: { project_status: project.status },
          next_requirements: ["项目恢复 active 后重新派发"],
        },
      );
    }
    const intent = db
      .prepare("SELECT * FROM intents WHERE project_id = ? AND id = ?")
      .get(session.project_id, intentId);
    if (!intent) {
      throw apiError("INVALID_REFERENCE", `intent_id 不存在：${intentId}`, {
        next_requirements: ["先经计划接收（C1 #20）建立意图，或修正 intent_id"],
      });
    }
    if (["obsolete", "cancelled", "resolved"].includes(intent.status)) {
      throw apiError("PRECONDITION_INVALID", `意图 ${intent.id} 状态为 ${intent.status}，不可再派发执行`, {
        detail: { intent_status: intent.status },
        next_requirements: ["需要 planner 修订计划（ reopened 意图或新意图）后再派发"],
      });
    }
    // §17 派发时校验：意图目标资产 × 当前范围版本（拒绝优先；回写 scope_status）
    const scopeCheck = checkIntentTargets(db, { projectId: session.project_id, intent });
    // §9.2/§17 派发时校验执行前提
    checkPrerequisites(db, { projectId: session.project_id, intent, phase: "派发" });
    // §3.2 资源上限：项目级活跃 Attempt 数
    const policy = resourcePolicyOf(project);
    if (Number.isInteger(policy.max_active_attempts) && policy.max_active_attempts > 0) {
      const activeCount = db
        .prepare(`SELECT COUNT(*) AS c FROM attempts WHERE project_id = ? AND status IN ('leased','running')`)
        .get(session.project_id).c;
      if (activeCount >= policy.max_active_attempts) {
        throw apiError("RESOURCE_LIMIT", `项目活跃执行数已达上限 ${policy.max_active_attempts}（resource_policy.max_active_attempts）`, {
          retryable: true,
          detail: { active_attempts: activeCount, limit: policy.max_active_attempts },
          next_requirements: ["等待在途执行结束或暂缓后重试；提高上限需用户修订 resource_policy"],
        });
      }
    }
    const effectiveAssignment =
      typeof assignmentId === "string" && assignmentId.trim()
        ? assignmentId.trim()
        // ASM/ATT/TC/WR-nnnn 均为不内嵌项目编号的全局唯一业务编号 → 全局序列
        : formatSeqId("ASM", allocateSeq(db, GLOBAL_SEQ_SCOPE, "assignment"));
    // 条件领取：同 assignment 活跃租约的幂等/冲突分流
    const active = db
      .prepare(
        `SELECT * FROM attempts WHERE project_id = ? AND assignment_id = ? AND status IN ('leased','running')`,
      )
      .get(session.project_id, effectiveAssignment);
    if (active) {
      if (active.intent_id === intent.id && active.worker_id === workerId) {
        return {
          attempt: attemptView(db, active, { revealToken: true }),
          assignment_id: effectiveAssignment,
          fencing_token: active.fencing_token,
          lease_expires_at: active.lease_expires_at,
          idempotent: true,
          warnings: ["该执行分配已有有效租约，按幂等规则返回原 Attempt（§16.2）"],
          scope_check: scopeCheck,
        };
      }
      throw apiError("IDEMPOTENCY_KEY_REUSED", `执行分配 ${effectiveAssignment} 已由其他内容持有有效租约（attempt ${active.id}，intent ${active.intent_id}，worker ${active.worker_id}），拒绝覆盖（§10.2 同一分配单一有效租约）`, {
        retryable: false,
        receipt: { assignment_id: effectiveAssignment, active_attempt_id: active.id },
        next_requirements: ["等待该租约结束后再派发，或使用新的 assignment_id"],
      });
    }
    // fencing token 的唯一域按 DDL 是 (project_id, fencing_token) → 项目作用域保持项目内单调
    const fencingToken = allocateSeq(db, session.project_id, "fencing");
    const attemptId = formatSeqId("ATT", allocateSeq(db, GLOBAL_SEQ_SCOPE, "attempt"));
    const leaseExpires = new Date(Date.now() + ttl).toISOString();
    const commitSeq = allocateCommitSeq(db, session.project_id);
    try {
      db.prepare(
        `INSERT INTO attempts (id, project_id, intent_id, assignment_id, worker_id, fencing_token,
           lease_expires_at, status, recovery_note, created_at, created_by, created_seq,
           updated_seq, state_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'leased', ?, ?, ?, ?, ?, 1)`,
      ).run(
        attemptId,
        session.project_id,
        intent.id,
        effectiveAssignment,
        workerId,
        fencingToken,
        leaseExpires,
        handoffSummary ? JSON.stringify({ handoff_summary: handoffSummary }) : "",
        now,
        session.actor,
        commitSeq,
        commitSeq,
      );
    } catch (error) {
      // 部分唯一索引兜底（跨进程并发领取）：撞 idx_attempts_active_assignment → 分流
      if (isUniqueConstraintError(error)) {
        const winner = db
          .prepare(
            `SELECT * FROM attempts WHERE project_id = ? AND assignment_id = ? AND status IN ('leased','running')`,
          )
          .get(session.project_id, effectiveAssignment);
        if (winner && winner.intent_id === intent.id && winner.worker_id === workerId) {
          return {
            attempt: attemptView(db, winner, { revealToken: true }),
            assignment_id: effectiveAssignment,
            fencing_token: winner.fencing_token,
            lease_expires_at: winner.lease_expires_at,
            idempotent: true,
            warnings: ["并发领取由部分唯一索引仲裁，返回已存在的有效租约"],
            scope_check: scopeCheck,
          };
        }
        throw apiError("IDEMPOTENCY_KEY_REUSED", `执行分配 ${effectiveAssignment} 的有效租约已被其他执行者领取（并发条件领取被部分唯一索引拒绝）`, {
          retryable: false,
          receipt: { assignment_id: effectiveAssignment, active_attempt_id: winner ? winner.id : null },
          next_requirements: ["改用新的 assignment_id 重新派发"],
        });
      }
      throw error;
    }
    emitEvent(db, {
      projectId: session.project_id,
      commitSeq,
      eventType: "resource_state.changed",
      subjectIds: [attemptId, intent.id],
      changedFields: ["status", "lease"],
      causeRefs: [effectiveAssignment],
      producerId: session.actor,
      payload: {
        kind: "attempt_leased",
        attempt_id: attemptId,
        intent_id: intent.id,
        assignment_id: effectiveAssignment,
        worker_id: workerId,
        fencing_token: fencingToken,
        lease_expires_at: leaseExpires,
      },
      now,
    });
    const row = db.prepare("SELECT * FROM attempts WHERE id = ?").get(attemptId);
    return {
      attempt: attemptView(db, row, { revealToken: true }),
      assignment_id: effectiveAssignment,
      fencing_token: fencingToken,
      lease_expires_at: leaseExpires,
      idempotent: false,
      warnings: scopeCheck.warnings || [],
      scope_check: scopeCheck,
    };
  });
}

function normalizeTtl(ms) {
  if (ms === undefined || ms === null) return DEFAULT_LEASE_TTL_MS;
  if (typeof ms !== "number" || !Number.isInteger(ms) || ms < MIN_LEASE_TTL_MS || ms > MAX_LEASE_TTL_MS) {
    throw apiError("BAD_REQUEST", `lease_ttl_ms 必须是 ${MIN_LEASE_TTL_MS}..${MAX_LEASE_TTL_MS} 的整数毫秒`);
  }
  return ms;
}

/* ── #23 队列与租约视图 ───────────────────────────────────────────── */

export async function listAttempts(pctx, { session, intentId, status, limit, after }) {
  const store = await getStore(pctx);
  await sweepExecutionState(pctx, session.project_id);
  const pageLimit = Math.min(Math.max(Number.isInteger(limit) ? limit : 50, 1), 200);
  return store.runSerial((db) => {
    const where = ["project_id = ?"];
    const args = [session.project_id];
    if (intentId) {
      where.push("intent_id = ?");
      args.push(intentId);
    }
    if (status) {
      where.push("status = ?");
      args.push(status);
    }
    if (after !== undefined && after !== null && after !== "") {
      const n = Number(after);
      if (!Number.isInteger(n)) throw apiError("BAD_REQUEST", "after 必须是 created_seq 游标（整数）");
      where.push("created_seq > ?");
      args.push(n);
    }
    const rows = db
      .prepare(
        `SELECT * FROM attempts WHERE ${where.join(" AND ")} ORDER BY created_seq, rowid LIMIT ?`,
      )
      .all(...args, pageLimit + 1);
    const hasMore = rows.length > pageLimit;
    const page = rows.slice(0, pageLimit);
    const revealToken = (row) =>
      session.role === "runtime" ||
      session.role === "orchestrator" ||
      session.role === "verifier" ||
      (session.role === "worker" && row.worker_id === session.actor);
    const nextCursor = hasMore && page.length ? String(page[page.length - 1].created_seq) : null;
    return {
      attempts: page.map((r) => attemptView(db, r, { revealToken: revealToken(r) })),
      has_more: hasMore,
      // 游标统一（蓝图 §2.6-6）：next_cursor 为规范名；next_after 保留作兼容回填（同值）
      next_cursor: nextCursor,
      next_after: nextCursor,
      count: page.length,
    };
  });
}

/* ── #24 生命周期：heartbeat / suspend / resume / cancel（§3.3/§10.2） ── */

const VALID_REASON_CODES = new Set(["retryable", "reassign", "dead_end"]);

export async function attemptLifecycle(pctx, { session, attemptId, action, fencingToken, reason, reasonCode, resumeConditions, leaseTtlMs }) {
  const store = await getStore(pctx);
  await sweepExecutionState(pctx, session.project_id);
  return store.runSerial((db) => {
    const now = nowIso();
    const att = loadAttempt(db, session.project_id, attemptId);
    const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(session.project_id);
    const assertToken = () => {
      if (fencingToken !== undefined && fencingToken !== null && fencingToken !== att.fencing_token) {
        throw apiError("LEASE_EXPIRED", `fencing token 不匹配（持有 ${fencingToken}，当前 ${att.fencing_token}）：旧执行者不再持有有效执行权（§10.2）`, {
          retryable: false,
          detail: { reason: "fencing_mismatch", attempt_status: att.status },
          next_requirements: ["旧执行者不得继续操作；恢复/重派由 Orchestrator 决定"],
        });
      }
    };
    switch (action) {
      case "heartbeat": {
        if (!HEARTBEAT_PROJECT_STATUS.has(project.status)) {
          throw apiError("PRECONDITION_INVALID", `项目状态 ${project.status}：执行权已撤销，拒绝续租（§16.4 用户停止立即生效）`, {
            retryable: false,
            detail: { project_status: project.status },
          });
        }
        assertToken();
        const ttl = normalizeTtl(leaseTtlMs);
        const renewed = new Date(Date.now() + ttl).toISOString();
        const res = db
          .prepare(
            `UPDATE attempts SET lease_expires_at = ?, updated_seq = ? WHERE id = ? AND fencing_token = ?
               AND status IN ('leased','running') AND lease_expires_at > ?`,
          )
          .run(renewed, allocateCommitSeq(db, session.project_id), att.id, att.fencing_token, now);
        if (res.changes !== 1) {
          const fresh = db.prepare("SELECT * FROM attempts WHERE id = ?").get(att.id);
          throw apiError("LEASE_EXPIRED", `心跳续租失败：租约已过期或执行权已失效（状态 ${fresh.status}，§10.2 过期阻止旧执行继续操作）`, {
            retryable: false,
            detail: {
              reason: fresh.status !== att.status ? `status_changed:${fresh.status}` : "expired",
              attempt_status: fresh.status,
              lease_expires_at: fresh.lease_expires_at,
            },
            next_requirements: ["该 Attempt 不得继续执行；由 Orchestrator 决定恢复或重派（已发 lease_expired 通知）"],
          });
        }
        const row = db.prepare("SELECT * FROM attempts WHERE id = ?").get(att.id);
        return { attempt: attemptView(db, row, { revealToken: true }), renewed_until: renewed };
      }
      case "suspend": {
        assertToken();
        if (!["leased", "running"].includes(att.status)) {
          throw apiError("PRECONDITION_INVALID", `Attempt ${att.id} 状态 ${att.status} 不可暂缓（仅 leased/running）`, {
            detail: { attempt_status: att.status },
          });
        }
        const commitSeq = allocateCommitSeq(db, session.project_id);
        db.prepare(
          `UPDATE attempts SET status = 'suspended', lease_expires_at = NULL, recovery_note = ?,
             updated_seq = ?, state_version = state_version + 1 WHERE id = ?`,
        ).run(
          JSON.stringify({
            reason: reason || "协调决定暂缓",
            resume_conditions: Array.isArray(resumeConditions) ? resumeConditions : [],
            suspended_at: now,
            by: session.actor,
          }),
          commitSeq,
          att.id,
        );
        emitEvent(db, {
          projectId: session.project_id,
          commitSeq,
          eventType: "resource_state.changed",
          subjectIds: [att.id, att.intent_id],
          changedFields: ["status"],
          causeRefs: [att.id],
          producerId: session.actor,
          payload: { kind: "attempt_suspended", attempt_id: att.id, intent_id: att.intent_id, reason: reason || "", resume_conditions: Array.isArray(resumeConditions) ? resumeConditions : [] },
          now,
        });
        const row = db.prepare("SELECT * FROM attempts WHERE id = ?").get(att.id);
        return { attempt: attemptView(db, row, { revealToken: true }) };
      }
      case "resume": {
        if (att.status !== "suspended") {
          throw apiError("PRECONDITION_INVALID", `Attempt ${att.id} 状态 ${att.status} 不可恢复（仅 suspended）`, {
            detail: { attempt_status: att.status },
          });
        }
        if (!NEW_EXECUTION_PROJECT_STATUS.has(project.status)) {
          throw apiError("PRECONDITION_INVALID", `项目状态 ${project.status} 禁止恢复执行（§16.4）`, {
            detail: { project_status: project.status },
          });
        }
        const ttl = normalizeTtl(leaseTtlMs);
        const lease = new Date(Date.now() + ttl).toISOString();
        const commitSeq = allocateCommitSeq(db, session.project_id);
        try {
          db.prepare(
            `UPDATE attempts SET status = 'leased', lease_expires_at = ?, updated_seq = ?,
               state_version = state_version + 1 WHERE id = ? AND status = 'suspended'`,
          ).run(lease, commitSeq, att.id);
        } catch (error) {
          if (isUniqueConstraintError(error)) {
            throw apiError("PRECONDITION_INVALID", `执行分配 ${att.assignment_id} 已有其他有效租约，不能恢复本次暂缓（部分唯一索引拒绝，§10.2）`, {
              retryable: false,
              detail: { assignment_id: att.assignment_id },
              next_requirements: ["由 Orchestrator 决定是否终止现有租约或另立分配"],
            });
          }
          throw error;
        }
        emitEvent(db, {
          projectId: session.project_id,
          commitSeq,
          eventType: "resource_state.changed",
          subjectIds: [att.id, att.intent_id],
          changedFields: ["status", "lease"],
          causeRefs: [att.id],
          producerId: session.actor,
          payload: { kind: "attempt_resumed", attempt_id: att.id, intent_id: att.intent_id, lease_expires_at: lease },
          now,
        });
        const row = db.prepare("SELECT * FROM attempts WHERE id = ?").get(att.id);
        return { attempt: attemptView(db, row, { revealToken: true }) };
      }
      case "cancel": {
        assertToken();
        if (TERMINAL_ATTEMPT_STATUS.has(att.status) || att.status === "interrupted") {
          throw apiError("PRECONDITION_INVALID", `Attempt ${att.id} 已处于终态 ${att.status}，无需取消`, {
            detail: { attempt_status: att.status },
          });
        }
        const commitSeq = allocateCommitSeq(db, session.project_id);
        const markedUnknown = [];
        const markedCancelled = [];
        for (const tc of db.prepare(`SELECT * FROM tool_calls WHERE attempt_id = ?`).all(att.id)) {
          if (tc.status === "running") {
            db.prepare(`UPDATE tool_calls SET status = 'unknown', error = ?, updated_seq = ? WHERE id = ?`).run(
              "Attempt 取消，外部操作结果未观测（运行时确认后经 resolve 记录取消结果，§16.4）",
              commitSeq,
              tc.id,
            );
            markedUnknown.push(tc.id);
          } else if (tc.status === "planned") {
            db.prepare(`UPDATE tool_calls SET status = 'cancelled', error = ?, updated_seq = ? WHERE id = ?`).run(
              "Attempt 取消，未启动即取消",
              commitSeq,
              tc.id,
            );
            markedCancelled.push(tc.id);
          }
        }
        db.prepare(
          `UPDATE attempts SET status = 'cancelled', lease_expires_at = NULL, recovery_note = ?,
             updated_seq = ?, state_version = state_version + 1 WHERE id = ?`,
        ).run(
          JSON.stringify({
            reason: reason || "协调决定取消",
            reason_code: VALID_REASON_CODES.has(reasonCode) ? reasonCode : "reassign",
            cancelled_at: now,
            by: session.actor,
          }),
          commitSeq,
          att.id,
        );
        emitEvent(db, {
          projectId: session.project_id,
          commitSeq,
          eventType: "resource_state.changed",
          subjectIds: [att.id, att.intent_id],
          changedFields: ["status"],
          causeRefs: [att.id],
          producerId: session.actor,
          payload: {
            kind: "attempt_cancelled",
            attempt_id: att.id,
            intent_id: att.intent_id,
            reason: reason || "",
            tool_calls_marked_unknown: markedUnknown,
            tool_calls_cancelled: markedCancelled,
          },
          now,
        });
        // 确定性对账：取消释放租约后，若该意图已无活跃 attempt，按 reason_code 退回/搁置。
        reconcileIntentLiveness(db, {
          projectId: session.project_id,
          intentId: att.intent_id,
          triggerAttemptId: att.id,
        });
        const row = db.prepare("SELECT * FROM attempts WHERE id = ?").get(att.id);
        return { attempt: attemptView(db, row, { revealToken: true }) };
      }
      default:
        throw apiError("BAD_REQUEST", `未知生命周期动作：${action}（允许：heartbeat / suspend / resume / cancel）`);
    }
  });
}

/* ── #25 进展/阻塞/完成建议（§11.2；迟到留档，§20.3 场景 17） ──────── */

export async function reportProgress(pctx, { session, attemptId, kind, note, detail, conditionGaps, fencingToken }) {
  if (!["progress", "blocked", "completion"].includes(kind)) {
    throw apiError("BAD_REQUEST", "kind 必须是 progress / blocked / completion 之一（§11.2 进展、阻塞、完成建议）");
  }
  const store = await getStore(pctx);
  const sweep = await sweepExecutionState(pctx, session.project_id);
  return store.runSerial((db) => {
    const now = nowIso();
    const att = loadAttempt(db, session.project_id, attemptId);
    const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(session.project_id);
    // 迟到判定：执行权已失效（终态/中断/租约过期/token 不匹配/项目停止）→ 留档不改状态
    const tokenMismatch = fencingToken !== undefined && fencingToken !== null && fencingToken !== att.fencing_token;
    const leaseValid =
      ["leased", "running"].includes(att.status) &&
      att.lease_expires_at !== null &&
      att.lease_expires_at > now &&
      project.status !== "stopped";
    const late = Boolean(tokenMismatch) || !leaseValid;
    const reportId = formatSeqId("WR", allocateSeq(db, GLOBAL_SEQ_SCOPE, "worker_report"));
    const commitSeq = allocateCommitSeq(db, session.project_id);
    const content = {
      note: typeof note === "string" ? note : "",
      detail: detail ?? {},
      condition_gaps: Array.isArray(conditionGaps) ? conditionGaps : [],
      late,
      late_reason: late
        ? tokenMismatch
          ? "fencing token 不匹配（旧执行者）"
          : project.status === "stopped"
            ? "项目已停止（用户停止，§16.4）"
            : `执行权已失效（Attempt 状态 ${att.status}）`
        : null,
      source: "attempt_progress",
      reported_by: session.actor,
    };
    db.prepare(
      `INSERT INTO worker_reports (id, project_id, intent_id, attempt_id, kind, task_question,
         actual_outcome, execution_status, content, omitted_sections, delivery_status,
         handling_status, created_at, created_by, created_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', 'delivered', 'pending', ?, ?, ?)`,
    ).run(
      reportId,
      session.project_id,
      att.intent_id,
      att.id,
      kind,
      "",
      content.note,
      att.status,
      JSON.stringify(content),
      now,
      session.actor,
      commitSeq,
    );

    let attemptStatusAfter = att.status;
    let completionApplied = false;
    if (!late && kind === "completion") {
      // 程序状态条件（§10.1 的执行面）：完成前全部工具调用须终态（unknown 须先核查 resolve）
      const open = db
        .prepare(
          `SELECT id, status FROM tool_calls WHERE project_id = ? AND attempt_id = ? AND status IN ('planned','running','unknown')`,
        )
        .all(session.project_id, att.id);
      if (open.length) {
        throw apiError(
          "PRECONDITION_INVALID",
          `完成建议被拒绝：Attempt ${att.id} 仍有 ${open.length} 个未终态工具调用（${open
            .map((t) => `${t.id}:${t.status}`)
            .join("、")}）；unknown 调用须先核查现状并 resolve（§10.2）`,
          {
            retryable: false,
            detail: { open_tool_calls: open },
            next_requirements: ["先 complete/resolve/cancel 全部工具调用，再提交完成建议"],
          },
        );
      }
      db.prepare(
        `UPDATE attempts SET status = 'completed', lease_expires_at = NULL, updated_seq = ?,
           state_version = state_version + 1 WHERE id = ?`,
      ).run(commitSeq, att.id);
      attemptStatusAfter = "completed";
      completionApplied = true;
    }
    emitEvent(db, {
      projectId: session.project_id,
      commitSeq,
      eventType: "resource_state.changed",
      subjectIds: [att.id, att.intent_id],
      changedFields: late ? [] : ["execution"],
      causeRefs: [reportId],
      producerId: session.actor,
      payload: {
        kind: late
          ? "attempt_late_progress"
          : kind === "blocked"
            ? "attempt_blocked"
            : kind === "completion"
              ? completionApplied
                ? "attempt_completed"
                : "attempt_completion_suggested"
              : "attempt_progress",
        attempt_id: att.id,
        intent_id: att.intent_id,
        report_id: reportId,
        late,
        note: content.note,
        condition_gaps: content.condition_gaps,
        // 意图是否 resolved 由 C1/AI 判定（完成建议不自动关闭意图或项目，§10.1）
      },
      now,
    });
    const row = db.prepare("SELECT * FROM attempts WHERE id = ?").get(att.id);
    return {
      report_id: reportId,
      kind,
      late,
      saved: true,
      attempt_status_after: attemptStatusAfter,
      attempt: attemptView(db, row, { revealToken: session.role !== "user" }),
      sweep,
      note: late
        ? "迟到提交已留档并标明来源；不改变任何 Attempt 的执行状态，且不再获得工具执行权限（§10.2/§20.3 场景 17）"
        : completionApplied
          ? "完成建议已接受：本次执行尝试结束（意图是否 resolved 由 planner/程序按 C1 语义另行判定，不自动关闭项目）"
          : null,
    };
  });
}

/* ── #26 工具网关（§10.2 ToolCall 状态机；§17 动作前逐跳校验） ─────── */

function extractTargets(args, explicit) {
  if (Array.isArray(explicit)) {
    return explicit.map((t) => {
      if (typeof t !== "string") throw apiError("BAD_REQUEST", "targets 的成员必须是字符串（URL 或主机）");
      return t;
    });
  }
  if (explicit !== undefined && explicit !== null) {
    if (typeof explicit !== "string") throw apiError("BAD_REQUEST", "targets 必须是字符串数组或单个字符串");
    return [explicit];
  }
  const out = [];
  const push = (t) => {
    if (typeof t !== "string") return;
    out.push(t);
  };
  if (args && typeof args === "object") {
    push(args.url);
    if (Array.isArray(args.urls)) args.urls.forEach(push);
    if (Array.isArray(args.targets)) args.targets.forEach(push);
    if (typeof args.target === "string") push(args.target);
  }
  return out;
}

/** 执行闸门（§10.2/§17：租约+项目状态+ fencing；前提与范围由调用点分别执行）。 */
const PROJECT_STATUS_TEXT = { active: "运行中", waiting_for_change: "等待条件变化", paused: "已暂停", stopped: "已停止" };

function assertLiveLease(db, { project, att, fencingToken, phase }) {
  if (!NEW_EXECUTION_PROJECT_STATUS.has(project.status)) {
    throw apiError("PRECONDITION_INVALID", `项目${PROJECT_STATUS_TEXT[project.status] || project.status}（status=${project.status}）：新工具动作被程序阻止（§16.4/§17 立即生效，不等待 AI 阅读消息）`, {
      retryable: project.status === "paused",
      detail: { project_status: project.status, phase },
      next_requirements: ["项目恢复 active 后重新执行该动作"],
    });
  }
  if (typeof fencingToken !== "number" || !Number.isInteger(fencingToken)) {
    throw apiError("BAD_REQUEST", "缺少 fencing_token（整数；领取/续租时取得，§10.2）");
  }
  if (fencingToken !== att.fencing_token) {
    throw apiError("LEASE_EXPIRED", `fencing token 不匹配（持有 ${fencingToken}，当前 ${att.fencing_token}）：旧执行者不再持有有效执行权（${phase}，§10.2）`, {
      retryable: false,
      detail: { reason: "fencing_mismatch", attempt_status: att.status },
      next_requirements: ["该 Attempt 的执行权已转移或失效；结果由 Orchestrator 决定"],
    });
  }
  if (!["leased", "running"].includes(att.status)) {
    throw apiError("LEASE_EXPIRED", `Attempt ${att.id} 状态 ${att.status}：不再持有有效租约（${phase}被拒绝，§10.2 过期阻止旧执行继续操作）`, {
      retryable: false,
      detail: { reason: `attempt_${att.status}`, attempt_status: att.status },
      next_requirements: lateNextRequirements(att),
    });
  }
  if (!att.lease_expires_at || att.lease_expires_at <= nowIso()) {
    throw apiError("LEASE_EXPIRED", `Attempt ${att.id} 租约已过期（${phase}被拒绝；已通知 Orchestrator 决定恢复或重派）`, {
      retryable: false,
      detail: { reason: "expired", lease_expires_at: att.lease_expires_at },
      next_requirements: lateNextRequirements(att),
    });
  }
}

function lateNextRequirements(att) {
  return [
    `迟到执行的合法证据仍可提交（POST /attempts/${att.id}/progress 与 /submissions 会留档并标来源）；但不改变新 Attempt 状态、不再获得工具权限（§10.2）`,
  ];
}

function concurrencyCap(db, { project, intent }) {
  const policy = resourcePolicyOf(project);
  const budget = parseJsonField(intent.budget, {});
  const candidates = [
    Number.isInteger(policy.max_running_tool_calls_per_attempt) ? policy.max_running_tool_calls_per_attempt : null,
    Number.isInteger(budget.max_running_tool_calls) ? budget.max_running_tool_calls : null,
    DEFAULT_MAX_RUNNING_TOOL_CALLS,
  ].filter((v) => v !== null && v > 0);
  return Math.min(...candidates);
}

export async function toolGateway(pctx, { session, action, ...rest }) {
  if (!TOOL_ACTIONS.includes(action)) {
    throw apiError("BAD_REQUEST", `未知工具网关动作：${action}（允许：${TOOL_ACTIONS.join(" / ")}）`);
  }
  const store = await getStore(pctx);
  await sweepExecutionState(pctx, session.project_id);
  return store.runSerial((db) => {
    const now = nowIso();
    const att = loadAttempt(db, session.project_id, rest.attemptId);
    const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(session.project_id);
    const intent = db.prepare("SELECT * FROM intents WHERE id = ?").get(att.intent_id);

    switch (action) {
      case "register": {
        assertLiveLease(db, { project, att, fencingToken: rest.fencingToken, phase: "工具登记" });
        if (typeof rest.toolName !== "string" || !rest.toolName.trim()) {
          throw apiError("BAD_REQUEST", "缺少 tool_name");
        }
        const args = rest.args ?? {};
        if (args === null || typeof args !== "object" || Array.isArray(args)) {
          throw apiError("BAD_REQUEST", "args 必须是 JSON 对象");
        }
        const targets = extractTargets(args, rest.targets);
        if (targets.length > MAX_TARGETS_PER_CALL) {
          throw apiError("BAD_REQUEST", `单次调用目标数超过上限 ${MAX_TARGETS_PER_CALL}（逐跳校验，§17）`);
        }
        // §17 动作前范围校验（当前范围版本；范围变化立即影响新动作）
        const scopeVerdicts = targets.length
          ? checkActionTargets(db, { projectId: session.project_id, targets, phase: "工具登记" })
          : [];
        // §9.2/§17 动作前执行前提校验
        if (intent) checkPrerequisites(db, { projectId: session.project_id, intent, phase: "工具登记" });
        const argsDigest = sha256Hex(canonicalJson(args));
        // §10.2 场景 18：同身份调用的 unknown 未 resolve 前不得重试（先检查现状再决定重试）
        const unresolved = db
          .prepare(
            `SELECT id FROM tool_calls WHERE project_id = ? AND attempt_id = ? AND tool_name = ?
               AND args_digest = ? AND status = 'unknown'`,
          )
          .get(session.project_id, att.id, rest.toolName, argsDigest);
        if (unresolved) {
          throw apiError("PRECONDITION_INVALID", `同身份工具调用 ${unresolved.id} 处于 unknown，必须先核查现状并 resolve 再决定是否重试（§10.2/§20.3 场景 18）`, {
            retryable: false,
            detail: { unresolved_tool_call_id: unresolved.id, tool_name: rest.toolName, args_digest: argsDigest },
            next_requirements: [`先 POST /tool-calls {action:"resolve", tool_call_id:"${unresolved.id}", check_note:"…"} 记录核查结果`],
          });
        }
        // 统一并发限制（含子 agent；§10.2）
        const cap = intent ? concurrencyCap(db, { project, intent }) : DEFAULT_MAX_RUNNING_TOOL_CALLS;
        const running = db
          .prepare(`SELECT COUNT(*) AS c FROM tool_calls WHERE project_id = ? AND attempt_id = ? AND status = 'running'`)
          .get(session.project_id, att.id).c;
        if (running >= cap) {
          throw apiError("RESOURCE_LIMIT", `Attempt ${att.id} 运行中工具调用已达统一并发上限 ${cap}（含子 agent，§10.2）`, {
            retryable: true,
            detail: { running, cap },
            next_requirements: ["等待在途调用终态后重试；上限可经 resource_policy / intent budget 调整"],
          });
        }
        // 预算继承（intents.budget.max_tool_calls：本 Attempt 全部未取消调用计数）
        if (intent) {
          const budget = parseJsonField(intent.budget, {});
          if (Number.isInteger(budget.max_tool_calls) && budget.max_tool_calls > 0) {
            const used = db
              .prepare(
                `SELECT COUNT(*) AS c FROM tool_calls WHERE project_id = ? AND attempt_id = ? AND status != 'cancelled'`,
              )
              .get(session.project_id, att.id).c;
            if (used >= budget.max_tool_calls) {
              throw apiError("RESOURCE_LIMIT", `Attempt ${att.id} 工具调用预算已耗尽（max_tool_calls=${budget.max_tool_calls}，子 agent 同预算继承，§10.2/§16.3）`, {
                retryable: false,
                detail: { used, budget: budget.max_tool_calls },
                next_requirements: ["预算调整需 planner 修订意图（C1）；程序不自动放宽"],
              });
            }
          }
        }
        const id = formatSeqId("TC", allocateSeq(db, GLOBAL_SEQ_SCOPE, "tool_call"));
        const agent = typeof rest.agent === "string" && rest.agent.trim() ? rest.agent.trim() : session.actor;
        const commitSeq = allocateCommitSeq(db, session.project_id);
        db.prepare(
          `INSERT INTO tool_calls (id, project_id, attempt_id, tool_name, args_digest, status,
             started_at, ended_at, evidence_refs, error, created_at, created_by, created_seq, updated_seq)
           VALUES (?, ?, ?, ?, ?, 'planned', NULL, NULL, '[]', '', ?, ?, ?, ?)`,
        ).run(id, session.project_id, att.id, rest.toolName, argsDigest, now, agent, commitSeq, commitSeq);
        const row = db.prepare("SELECT * FROM tool_calls WHERE id = ?").get(id);
        return {
          tool_call: toolCallView(row),
          declared_targets: targets,
          gate: {
            phase: "register",
            scope_revision: scopeVerdicts.length ? scopeVerdicts[0].scope_revision : null,
            targets_checked: scopeVerdicts.map((v) => ({ target: v.target, verdict: v.verdict })),
            lease_expires_at: att.lease_expires_at,
            concurrency: { running_before: running, cap },
          },
        };
      }
      case "start": {
        const tc = loadToolCall(db, session.project_id, rest.toolCallId);
        if (tc.attempt_id !== att.id) {
          throw apiError("INVALID_REFERENCE", `工具调用 ${tc.id} 不属于 Attempt ${att.id}`);
        }
        assertLiveLease(db, { project, att, fencingToken: rest.fencingToken, phase: "工具启动" });
        // §17 逐跳：启动前对本次执行要触达的目标重查当前范围版本（register 与
        // start 之间范围可能收缩，收缩立即影响本动作）。冻结 DDL 的 tool_calls
        // 无 args 列（只存 args_digest），登记时的目标集由执行运行时在 start
        // 请求中按 register 回执的 declared_targets 重申；未重申时不做目标复检，
        // 由 complete 的 touched_targets 事后判定兜底（已在库契约中说明）。
        const targets = extractTargets(rest.args ?? {}, rest.targets);
        const scopeVerdicts = targets.length
          ? checkActionTargets(db, { projectId: session.project_id, targets, phase: "工具启动" })
          : [];
        if (intent) checkPrerequisites(db, { projectId: session.project_id, intent, phase: "工具启动" });
        const commitSeq = allocateCommitSeq(db, session.project_id);
        const res = db
          .prepare(`UPDATE tool_calls SET status = 'running', started_at = ?, updated_seq = ? WHERE id = ? AND status = 'planned'`)
          .run(now, commitSeq, tc.id);
        if (res.changes !== 1) {
          throw apiError("PRECONDITION_INVALID", `工具调用 ${tc.id} 状态 ${tc.status} 不可启动（仅 planned）`, {
            detail: { tool_call_status: tc.status },
          });
        }
        const row = db.prepare("SELECT * FROM tool_calls WHERE id = ?").get(tc.id);
        return {
          tool_call: toolCallView(row),
          gate: {
            phase: "start",
            targets_recheck: targets.length ? "redeclared" : "not_redeclared",
            scope_revision: scopeVerdicts.length ? scopeVerdicts[0].scope_revision : null,
            targets_checked: scopeVerdicts.map((v) => ({ target: v.target, verdict: v.verdict })),
          },
        };
      }
      case "complete":
      case "mark_unknown":
      case "resolve":
      case "cancel": {
        const tc = loadToolCall(db, session.project_id, rest.toolCallId);
        if (tc.attempt_id !== att.id) {
          throw apiError("INVALID_REFERENCE", `工具调用 ${tc.id} 不属于 Attempt ${att.id}`);
        }
        // 落定类动作（SETTLE）：租约/项目状态失效仍允许——已发出操作必须记录实际结果，
        // 不假装撤回（§17）；fencing token 仅在提供时校验归属。
        if (rest.fencingToken !== undefined && rest.fencingToken !== null && rest.fencingToken !== att.fencing_token) {
          throw apiError("LEASE_EXPIRED", `fencing token 不匹配（持有 ${rest.fencingToken}，当前 ${att.fencing_token}）：非持有者不得落定该调用的结果（§10.2）`, {
            retryable: false,
            detail: { reason: "fencing_mismatch" },
          });
        }
        const commitSeq = allocateCommitSeq(db, session.project_id);
        const warnings = [];
        if (action === "complete") {
          const outcome = rest.outcome;
          if (!["succeeded", "failed"].includes(outcome)) {
            throw apiError("BAD_REQUEST", "complete 需要 outcome: succeeded | failed");
          }
          if (TOOL_CALL_TERMINAL.has(tc.status)) {
            const implied = tc.status;
            if (implied === outcome) {
              const row = db.prepare("SELECT * FROM tool_calls WHERE id = ?").get(tc.id);
              return { tool_call: toolCallView(row), idempotent: true, warnings: ["重复落定按幂等返回原终态（传输重试，§10.2）"] };
            }
            throw apiError("PRECONDITION_INVALID", `工具调用 ${tc.id} 已终态 ${tc.status}，不能改判为 ${outcome}`, {
              detail: { tool_call_status: tc.status },
            });
          }
          if (tc.status !== "running") {
            throw apiError("PRECONDITION_INVALID", `工具调用 ${tc.id} 状态 ${tc.status} 不可 complete（仅 running；进程中断未决应 mark_unknown/resolve）`, {
              detail: { tool_call_status: tc.status },
            });
          }
          const evidenceRefs = validateEvidenceRefs(db, session.project_id, rest.evidenceRefs);
          // §17：touched_targets 事后逐目标判定（范围收缩对已发出操作只记录实际结果，
          // 不假装撤回）；当前判定非 allowed 的触达目标记警告并出 violation 事件。
          const touched = Array.isArray(rest.touchedTargets) ? rest.touchedTargets : [];
          const touchedVerdicts = touched.map((t) => evaluateTarget(db, { projectId: session.project_id, target: t }));
          for (const v of touchedVerdicts) {
            if (v.verdict !== "allowed") {
              warnings.push(
                `触达目标 ${v.target} 当前判定为 ${v.verdict}（${v.reason}）：已发出操作记录实际结果，不假装撤回；该目标的后续动作将被阻止（§17）`,
              );
              emitEvent(db, {
                projectId: session.project_id,
                commitSeq: allocateCommitSeq(db, session.project_id),
                eventType: "resource_state.changed",
                subjectIds: [att.id, tc.id],
                changedFields: ["scope"],
                causeRefs: [tc.id],
                producerId: session.actor,
                payload: {
                  kind: "scope_violation_observed",
                  attempt_id: att.id,
                  tool_call_id: tc.id,
                  target: v.target,
                  verdict: v.verdict,
                  reason: v.reason,
                },
                now,
              });
            }
          }
          db.prepare(
            `UPDATE tool_calls SET status = ?, ended_at = ?, evidence_refs = ?, error = ?, updated_seq = ? WHERE id = ?`,
          ).run(outcome, now, JSON.stringify(evidenceRefs), typeof rest.error === "string" ? rest.error : "", commitSeq, tc.id);
          const row = db.prepare("SELECT * FROM tool_calls WHERE id = ?").get(tc.id);
          return { tool_call: toolCallView(row), warnings, touched_targets: touchedVerdicts };
        }
        if (action === "mark_unknown") {
          if (tc.status !== "running") {
            throw apiError("PRECONDITION_INVALID", `工具调用 ${tc.id} 状态 ${tc.status} 不可标 unknown（仅 running；进程中断且无法判断外部操作是否已完成时标记，§10.2）`, {
              detail: { tool_call_status: tc.status },
            });
          }
          const reason = typeof rest.reason === "string" && rest.reason.trim() ? rest.reason : "进程中断，无法判断外部操作是否已完成";
          db.prepare(`UPDATE tool_calls SET status = 'unknown', error = ?, updated_seq = ? WHERE id = ?`).run(reason, commitSeq, tc.id);
          const row = db.prepare("SELECT * FROM tool_calls WHERE id = ?").get(tc.id);
          return {
            tool_call: toolCallView(row),
            note: "已标 unknown：不得视为恰好一次；重试同身份调用前必须先核查现状并 resolve（§10.2/§20.3 场景 18）",
          };
        }
        if (action === "resolve") {
          if (tc.status !== "unknown") {
            throw apiError("PRECONDITION_INVALID", `工具调用 ${tc.id} 状态 ${tc.status} 不可 resolve（仅 unknown）`, {
              detail: { tool_call_status: tc.status },
            });
          }
          const outcome = rest.outcome;
          if (!["succeeded", "failed", "cancelled"].includes(outcome)) {
            throw apiError("BAD_REQUEST", "resolve 需要 outcome: succeeded | failed | cancelled（核查现状后记录实际结果）");
          }
          // §10.2「先检查现状再决定重试」：核查说明为程序可见的必要前提（结构性检查，
          // 不判定核查语义质量——那是 AI/verifier 的职责，§3.2/§18.4）
          if (typeof rest.checkNote !== "string" || !rest.checkNote.trim()) {
            throw apiError("BAD_REQUEST", "resolve 需要 check_note：说明核查了什么、现状如何（先检查现状再决定重试，§10.2）", {
              next_requirements: ["补充 check_note 后重试；或经证据提交（A2 采集）佐证现状"],
            });
          }
          const evidenceRefs = validateEvidenceRefs(db, session.project_id, rest.evidenceRefs);
          db.prepare(
            `UPDATE tool_calls SET status = ?, ended_at = ?, evidence_refs = ?, error = ?, updated_seq = ? WHERE id = ?`,
          ).run(outcome, now, JSON.stringify(evidenceRefs), `核查：${rest.checkNote}`, commitSeq, tc.id);
          const row = db.prepare("SELECT * FROM tool_calls WHERE id = ?").get(tc.id);
          return { tool_call: toolCallView(row), resolved_by_check: rest.checkNote };
        }
        // cancel（执行者主动取消：执行者知晓取消发生在外部效果前后）
        if (TOOL_CALL_TERMINAL.has(tc.status) || tc.status === "unknown") {
          throw apiError("PRECONDITION_INVALID", `工具调用 ${tc.id} 状态 ${tc.status} 不可取消（终态/unknown 不可改；unknown 请 resolve）`, {
            detail: { tool_call_status: tc.status },
          });
        }
        db.prepare(`UPDATE tool_calls SET status = 'cancelled', ended_at = ?, error = ?, updated_seq = ? WHERE id = ?`).run(
          now,
          typeof rest.reason === "string" ? rest.reason : "执行者取消",
          commitSeq,
          tc.id,
        );
        const row = db.prepare("SELECT * FROM tool_calls WHERE id = ?").get(tc.id);
        return { tool_call: toolCallView(row) };
      }
      default:
        throw apiError("BAD_REQUEST", `未知动作：${action}`);
    }
  });
}

/** 工具调用的目标集契约：冻结 DDL 的 tool_calls 无 args 列（仅 args_digest），
 *  登记时派生的目标集在回执中返回（declared_targets），执行运行时在 start 时
 *  重申以完成逐跳复检（§17）；未重申时由 complete 的 touched_targets 事后判定兜底。 */

function loadToolCall(db, projectId, toolCallId) {
  const row = db
    .prepare("SELECT * FROM tool_calls WHERE project_id = ? AND id = ?")
    .get(projectId, toolCallId);
  if (!row) {
    throw apiError("NOT_FOUND", `工具调用不存在：${toolCallId}`);
  }
  return row;
}

function validateEvidenceRefs(db, projectId, refs) {
  if (refs === undefined || refs === null) return [];
  if (!Array.isArray(refs)) {
    throw apiError("BAD_REQUEST", "evidence_refs 必须是数组（blob/采集编号）");
  }
  for (const ref of refs) {
    if (!locateSubject(db, projectId, ref)) {
      throw apiError("INVALID_REFERENCE", `evidence_refs 引用的对象不存在：${ref}`, {
        next_requirements: ["先经 A2 固定证据并建立采集，再引用其编号"],
      });
    }
  }
  return refs;
}
