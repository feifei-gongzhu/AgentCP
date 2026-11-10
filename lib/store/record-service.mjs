/**
 * A1 —— 统一记录服务（Record Service）。
 *
 * 规范落点：§3(Record Service 职责) §5.1(受控串行短事务) §6.1(编号与通用字段)
 * §6.2/§6.3(基础表与约束的使用方) §11.1(统一提交信封) §11.3(追加与修改分流)
 * §13(数据库侧：业务记录与 Outbox 同事务) §16.4(项目生命周期) §17(范围版本表)
 * §20.1(机器可区分错误) §14.1(commit_seq / event_index / Outbox 事件)。
 *
 * 对外导出（后续阶段模块只允许 import 调用，不得改本文件）：
 *   - getStore(pctx)/closeStore(pctx)：受控数据库句柄（runSerial 串行短事务，§5.1）；
 *   - submit(pctx, {session, envelope})：幂等统一提交（§11.1/§11.3）；
 *   - createProject / updateProjectLifecycle / createScopeRevision /
 *     listProjects / getProjectDetail / getProjectScope：项目面（§16.4/§17）；
 *   - registerSubmissionOps(owner, ops)：提交操作注册表。后续模块（C1/D1/E1…）
 *     在自己的文件内向信封注册新操作，无需修改本文件；每个操作声明
 *     { name, kind: "append"|"modify", roles: [...], handler }，角色越权由引擎拒绝。
 *
 * 程序只做规范交给程序的校验与保障（权限、必要前提、幂等、可靠投递、原子性）；
 * 探索策略与语义判断留给 AI 角色（§3.2）。
 */
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { openDatabase } from "../db.mjs";
import { apiError } from "../errors.mjs";
import { revokeSessionsForProject } from "./sessions.mjs";

/* ── 常量 ─────────────────────────────────────────────────────────── */

/** 事件信封 schema 版本（§14.1 Event.schema_version；随 payload 结构演进递增）。 */
export const EVENT_SCHEMA_VERSION = 1;

/** §9.1 九类关系 + §7.3 duplicate_of/equivalent_to（与冻结 DDL CHECK 一致）。 */
export const RELATION_TYPES = Object.freeze([
  "discovered_from",
  "derived_from",
  "requires",
  "supports",
  "contradicts",
  "targets",
  "produced_by",
  "verifies",
  "supersedes",
  "retracts",
  "related_to",
  "duplicate_of",
  "equivalent_to",
]);

/** 拥有 evidence_revision 的判断类对象（§6.1 结论类对象；evidence_revision 的归属）。 */
const JUDGEMENT_TABLES = new Set(["hypotheses", "facts", "vulnerabilities"]);

/** 编号前缀 → 物理表（存在性校验与多态引用解析；§6.1 程序分配稳定 ID）。 */
const PREFIX_TABLES = Object.freeze({
  A: "assets",
  B: "blobs",
  CAP: "captures",
  EM: "evidence_memberships",
  F: "facts",
  G: "goals",
  H: "hypotheses",
  I: "intents",
  O: "observations",
  PRJ: "projects",
  R: "relations",
  SR: "scope_revisions",
  T: "endpoint_templates",
  V: "vulnerabilities",
});

/** 前缀无法识别时的兜底扫描表（覆盖后续模块可能引入的编号格式）。 */
const FALLBACK_TABLES = Object.freeze([
  "assets",
  "observations",
  "hypotheses",
  "facts",
  "vulnerabilities",
  "relations",
  "goals",
  "intents",
  "captures",
  "blobs",
]);

/** §16.4 项目生命周期迁移表：局部目标可达成，长期目标继续存在；停止不结束项目。 */
const LIFECYCLE_TRANSITIONS = Object.freeze({
  pause: { to: "paused", from: ["active", "waiting_for_change"] },
  wait: { to: "waiting_for_change", from: ["active"] },
  resume: { to: "active", from: ["paused", "waiting_for_change", "stopped"] },
  stop: { to: "stopped", from: ["active", "waiting_for_change", "paused"] },
});

/* ── 受控句柄（§5.1：所有变更经本服务进入串行短事务） ──────────────── */

const storeCache = new Map(); // 绝对库文件路径 → openDatabase promise

function storeFile(pctx) {
  return resolve(join(pctx.dataDir, "state", "sorne.sqlite"));
}

/** 打开（或复用）数据根下的受控句柄；进程内同文件单一串行写队列。 */
export function getStore(pctx) {
  const file = storeFile(pctx);
  if (!storeCache.has(file)) {
    storeCache.set(file, openDatabase({ file }));
  }
  return storeCache.get(file);
}

/** 关闭并丢弃缓存句柄（进程退出/重启演练用；F2 恢复流程可复用）。 */
export async function closeStore(pctx) {
  const file = storeFile(pctx);
  const pending = storeCache.get(file);
  if (!pending) return;
  storeCache.delete(file);
  const store = await pending;
  store.close();
}

/* ── 基础工具 ─────────────────────────────────────────────────────── */

function sha256Hex(text) {
  return createHash("sha256").update(text).digest("hex");
}

/** 规范化 JSON（键递归排序）：请求摘要与 result_hash 的确定性基础。 */
function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

function truncate(text, max = 160) {
  const s = String(text);
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

function toJsonArr(value, field, opName) {
  if (value === undefined || value === null) return "[]";
  if (Array.isArray(value)) return JSON.stringify(value);
  throw apiError("BAD_REQUEST", `操作 ${opName} 的字段 ${field} 必须是数组`);
}

function reqStr(op, field) {
  const v = op[field];
  if (typeof v !== "string" || !v.trim()) {
    throw apiError("BAD_REQUEST", `操作 ${op.op} 缺少必填字段 ${field}`);
  }
  return v;
}

function optStr(op, field) {
  const v = op[field];
  return typeof v === "string" ? v : "";
}

/**
 * 全局序列作用域：所有业务表的 id 是全局 TEXT PRIMARY KEY（0001 DDL），凡编号
 * 形如 `PREFIX-nnnn`（不内嵌项目编号）的实体必须从全局序列取号，否则第二个项目
 * 首写即与第一个项目撞全局主键（UNIQUE constraint failed）。仅编号内嵌项目编号
 * （EVT-<PRJ>-nnnn）或按 DDL 以 (project_id, …) 为唯一域的序列（fencing）才用
 * 项目作用域。
 */
export const GLOBAL_SEQ_SCOPE = "_global";

/**
 * 事务内分配稳定编号（§6.1：id_sequences，序列只保证单调，允许有空洞）。
 *
 * 外观说明（终审视核，非缺陷）：首个分配值从 2 起（INSERT…VALUES(…,2) 后读取），
 * 1 号永不发放——即首个项目是 PRJ-0002、首个资产是 A-0002。编号的唯一性、
 * 单调性与稳定性不受影响；规范 §6.1 只要求程序分配的稳定 ID，未规定起始值。
 * 保持该历史行为的原因：既有部署/测试已固化 2 起始的编号流，改动会使全部
 * 存量编号与新编号错位（迁移价值为零、回归面大）；1 号事实上成为每个序列的
 * 保留空洞。见 docs/modules/A1.md 偏差 7。
 */
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

function formatSeqId(prefix, n, width = 4) {
  return `${prefix}-${String(n).padStart(width, "0")}`;
}

/** 项目级 commit_seq：事务内取出并推进（§14.1：形成稳定提交顺序）。 */
function allocateCommitSeq(db, projectId) {
  const row = db.prepare("SELECT next_commit_seq AS n FROM projects WHERE id = ?").get(projectId);
  db.prepare("UPDATE projects SET next_commit_seq = ? WHERE id = ?").run(row.n + 1, projectId);
  return row.n;
}

/** 多态引用存在性定位（§6.2：由 Record Service 校验，返回表名或 null）。 */
function locateRecord(db, projectId, ref) {
  if (typeof ref !== "string" || !ref) return null;
  const m = /^([A-Za-z]+)-\d+$/.exec(ref);
  if (m) {
    const table = PREFIX_TABLES[m[1]];
    if (table) return existsInTable(db, table, ref, projectId) ? { table } : null;
  }
  for (const table of FALLBACK_TABLES) {
    if (existsInTable(db, table, ref, projectId)) return { table };
  }
  return null;
}

function existsInTable(db, table, ref, projectId) {
  if (table === "projects") {
    return Boolean(db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(ref));
  }
  return Boolean(
    db.prepare(`SELECT 1 FROM ${table} WHERE id = ? AND project_id = ?`).get(ref, projectId),
  );
}

/* ── Outbox：业务记录与事件同事务（§2 约束 10 / §13 / §14.1） ───────── */

function makeEventSink() {
  const events = [];
  return {
    events,
    emit(event_type, { subject_ids = [], changed_fields = [], cause_refs = [], payload = {} } = {}) {
      events.push({ event_type, subject_ids, changed_fields, cause_refs, payload });
    },
  };
}

/** 将本次提交的事件写入 outbox：event_id 唯一、commit_seq 事务内分配、event_index 区分。 */
function flushEvents(db, { projectId, actor, commitSeq, causeRef, events, now }) {
  events.forEach((ev, i) => {
    // event_id 形如 EVT-<projectId>-nnnn，编号内嵌项目 → 项目作用域序列即可全局唯一
    const n = allocateSeq(db, projectId, "event");
    db.prepare(
      `INSERT INTO outbox (event_id, project_id, commit_seq, event_index, event_type,
         subject_ids, changed_fields, cause_refs, producer_id, schema_version, payload,
         delivery_status, delivery_attempts, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)`,
    ).run(
      `EVT-${projectId}-${String(n).padStart(6, "0")}`,
      projectId,
      commitSeq,
      i + 1,
      ev.event_type,
      JSON.stringify(ev.subject_ids),
      JSON.stringify(ev.changed_fields),
      JSON.stringify(ev.cause_refs.length ? ev.cause_refs : [causeRef]),
      actor,
      EVENT_SCHEMA_VERSION,
      JSON.stringify(ev.payload),
      now,
    );
  });
}

/* ── 提交操作注册表（后续模块经 registerSubmissionOps 扩展） ────────── */

const opRegistry = new Map();

/**
 * 注册提交操作。ops: [{ name, kind: "append"|"modify", roles: string[], handler(ctx, op) }]
 * - append：不查节点状态版本（§11.3 追加型）；
 * - modify：handler 必须校验 expected_* 版本，不匹配抛 STALE_STATE（§11.3 修改型）；
 * - roles：允许执行该操作的角色（蓝图 §8.2 权限矩阵），越权由引擎拒绝；
 * - handler 必须同步，事务由引擎统一包裹（§5.1）。
 */
export function registerSubmissionOps(owner, ops) {
  if (!Array.isArray(ops)) throw new Error("registerSubmissionOps 需要 ops 数组");
  for (const op of ops) {
    if (!op || typeof op.name !== "string" || !op.name) {
      throw new Error("提交操作缺少 name");
    }
    if (typeof op.handler !== "function") {
      throw new Error(`提交操作 ${op.name} 缺少 handler`);
    }
    if (opRegistry.has(op.name)) {
      throw new Error(`提交操作已注册：${op.name}`);
    }
    opRegistry.set(op.name, {
      owner: owner || "unknown",
      name: op.name,
      kind: op.kind === "modify" ? "modify" : "append",
      roles: Object.freeze([...(Array.isArray(op.roles) ? op.roles : [])]),
      handler: op.handler,
    });
  }
}

export function listSubmissionOps() {
  return [...opRegistry.values()].map(({ name, kind, roles, owner }) => ({ name, kind, roles, owner }));
}

/* ── 操作执行上下文 ───────────────────────────────────────────────── */

function makeOpContext(db, session, submissionId, commitSeq) {
  const sink = makeEventSink();
  const ctx = {
    db,
    projectId: session.project_id,
    actor: session.actor,
    role: session.role,
    submissionId,
    commitSeq,
    now: new Date().toISOString(),
    ids: {}, // local_ref → 正式 ID（§11.1）
    warnings: [],
    events: sink.events,
    emit: sink.emit,
    resolveRef(v) {
      return typeof v === "string" && Object.prototype.hasOwnProperty.call(ctx.ids, v)
        ? ctx.ids[v]
        : v;
    },
    assertExists(ref, field) {
      const hit = locateRecord(db, ctx.projectId, ref);
      if (!hit) {
        throw apiError("INVALID_REFERENCE", `操作引用的对象不存在（${field}）：${ref}`, {
          detail: { field, ref },
          next_requirements: [`先创建被引用对象，或修正 ${field} 引用`],
        });
      }
      return hit;
    },
  };
  return ctx;
}

/* ── 共享写入辅助 ─────────────────────────────────────────────────── */

/** 插入关系边：无通用去重键（§6.3：条件与历史版本不被去重键忽略）。 */
function insertRelation(ctx, { from, to, relation_type, conditions = "", requires_state = "", source = "" }) {
  // R-nnnn 为全局主键编号 → 全局序列（C1 的 R-<PRJ>-nnnn 格式仍走项目作用域）
  const id = formatSeqId("R", allocateSeq(ctx.db, GLOBAL_SEQ_SCOPE, "relation"));
  ctx.db
    .prepare(
      `INSERT INTO relations (id, project_id, from_id, to_id, relation_type, conditions,
         requires_state, source, valid_from_seq, created_at, created_by, created_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      ctx.projectId,
      from,
      to,
      relation_type,
      conditions,
      requires_state,
      source,
      ctx.commitSeq,
      ctx.now,
      ctx.actor,
      ctx.commitSeq,
    );
  // 新边事件（§15.5 要求新边事件包含端点信息；蓝图 §6 事件目录表格遗漏，见竣工记录偏差）
  ctx.emit("relation.added", {
    subject_ids: [from, to],
    payload: { relation_id: id, from, to, relation_type, endpoints: { from, to } },
  });
  if (relation_type === "requires") {
    // §9.2：前提变更产生依赖变化事件（执行门槛的关闭由执行侧在动作前重查实现）
    ctx.emit("dependency.changed", {
      subject_ids: [to],
      changed_fields: ["requires"],
      payload: { relation_id: id, from, to, change: "added" },
    });
  }
  return id;
}

/** 判断对象的 evidence_revision 推进（§11.3/§12.1）；confirmed 遇新证据置复核（§12.3/§8.4）。 */
function advanceEvidenceRevision(ctx, { subjectId, subjectTable, reason }) {
  const row = ctx.db
    .prepare(`SELECT * FROM ${subjectTable} WHERE id = ? AND project_id = ?`)
    .get(subjectId, ctx.projectId);
  if (!row) {
    ctx.warnings.push(`证据集变更的目标 ${subjectId} 不再存在，仅记录关系边`);
    return;
  }
  const changed = ["evidence_revision"];
  const sets = ["evidence_revision = ?", "updated_seq = ?"];
  const args = [row.evidence_revision + 1, ctx.commitSeq];
  if (
    subjectTable === "vulnerabilities" &&
    row.status === "confirmed" &&
    row.review === "clear"
  ) {
    sets.push("review = 'pending'");
    changed.push("review");
    ctx.warnings.push(
      `确认状态的对象 ${subjectId} 收到新相关证据（${reason}），按 §8.4/§12.3 置 review=pending，保留确认历史`,
    );
  }
  args.push(subjectId, ctx.projectId);
  ctx.db.prepare(`UPDATE ${subjectTable} SET ${sets.join(", ")} WHERE id = ? AND project_id = ?`).run(...args);
  ctx.emit("evidence_set.revised", {
    subject_ids: [subjectId],
    changed_fields: changed,
    payload: {
      subject_id: subjectId,
      evidence_revision: row.evidence_revision + 1,
      reason,
      review: changed.includes("review") ? "pending" : row.review,
    },
  });
}

/** supports/contradicts 到达判断对象时的证据集成员维护（§6.3/§12.1/§12.3）。 */
function applyEvidenceMembership(ctx, { subjectId, subjectTable, fromId, relation_type }) {
  const stance = relation_type === "supports" ? "supports" : "contradicts";
  const located = locateRecord(ctx.db, ctx.projectId, fromId);
  if (!located) {
    ctx.warnings.push(`无法定位证据成员 ${fromId} 的对象类型，仅记录关系边，不改证据集`);
    return;
  }
  const memberKind = located.table;
  const existing = ctx.db
    .prepare(
      `SELECT * FROM evidence_memberships
        WHERE project_id = ? AND subject_id = ? AND member_kind = ? AND member_id = ?`,
    )
    .get(ctx.projectId, subjectId, memberKind, fromId);
  if (!existing) {
    ctx.db
      .prepare(
        `INSERT INTO evidence_memberships (id, project_id, subject_id, member_kind, member_id,
           stance, status, created_at, created_by, created_seq)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      )
      .run(
        formatSeqId("EM", allocateSeq(ctx.db, GLOBAL_SEQ_SCOPE, "membership")),
        ctx.projectId,
        subjectId,
        memberKind,
        fromId,
        stance,
        ctx.now,
        ctx.actor,
        ctx.commitSeq,
      );
    advanceEvidenceRevision(ctx, {
      subjectId,
      subjectTable,
      reason: `证据成员加入（${fromId} ${stance}）`,
    });
    return;
  }
  if (existing.status !== "active" || existing.stance !== stance) {
    // §6.3：反对关系或条件变化仍算证据集变更（经更新行实现）
    ctx.db
      .prepare("UPDATE evidence_memberships SET stance = ?, status = 'active' WHERE id = ?")
      .run(stance, existing.id);
    advanceEvidenceRevision(ctx, {
      subjectId,
      subjectTable,
      reason: `证据成员变化（${fromId} ${existing.stance}/${existing.status} → ${stance}/active）`,
    });
    return;
  }
  // §12.3：新提交和旧证据完全重复且可确定 → 返回去重结果，不无故触发复核
  ctx.warnings.push(
    `证据成员 ${fromId} 对 ${subjectId} 的 ${stance} 关系已存在，按去重处理，不推进 evidence_revision（§12.3）`,
  );
}

/* ── 内置提交操作（阶段 A；其余模块经 registerSubmissionOps 增补） ──── */

function opRegisterAsset(ctx, op) {
  const asset_type = reqStr(op, "asset_type");
  const canonicalization_version = reqStr(op, "canonicalization_version");
  const canonical_key = reqStr(op, "canonical_key");
  const original_input =
    typeof op.original_input === "string" && op.original_input ? op.original_input : canonical_key;
  const parent_asset_id = typeof op.parent_asset_id === "string" && op.parent_asset_id ? op.parent_asset_id : null;
  if (parent_asset_id) {
    const parentExists = ctx.db.prepare("SELECT 1 FROM assets WHERE id = ? AND project_id = ?").get(parent_asset_id, ctx.projectId);
    if (!parentExists) throw apiError("INVALID_REFERENCE", `parent_asset_id 指向的资产不存在：${parent_asset_id}`);
  }
  const candidateId = formatSeqId("A", allocateSeq(ctx.db, GLOBAL_SEQ_SCOPE, "asset"));
  const res = ctx.db
    .prepare(
      `INSERT OR IGNORE INTO assets (id, project_id, parent_asset_id, asset_type, canonicalization_version,
         canonical_key, original_input, created_at, created_by, created_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      candidateId,
      ctx.projectId,
      parent_asset_id,
      asset_type,
      canonicalization_version,
      canonical_key,
      original_input,
      ctx.now,
      ctx.actor,
      ctx.commitSeq,
    );
  let assetId = candidateId;
  const first = res.changes === 1;
  if (!first) {
    const row = ctx.db
      .prepare(
        `SELECT id FROM assets WHERE project_id = ? AND COALESCE(parent_asset_id, '') = ?
           AND asset_type = ? AND canonicalization_version = ? AND canonical_key = ?`,
      )
      .get(ctx.projectId, parent_asset_id || "", asset_type, canonicalization_version, canonical_key);
    assetId = row.id;
    ctx.warnings.push(
      `资产身份已存在（${asset_type}/${canonical_key}），按唯一约束归并为同一节点，未覆盖任何记录`,
    );
  }
  if (op.local_ref) ctx.ids[op.local_ref] = assetId;
  ctx.emit("asset.discovered", {
    subject_ids: [assetId],
    payload: {
      asset_id: assetId,
      asset_type,
      canonicalization_version,
      canonical_key,
      first_discovery: first,
      source_note: optStr(op, "source_note"),
    },
  });
  if (op.discovered_from !== undefined && op.discovered_from !== null && op.discovered_from !== "") {
    const src = ctx.resolveRef(op.discovered_from);
    ctx.assertExists(src, "discovered_from");
    insertRelation(ctx, { from: assetId, to: src, relation_type: "discovered_from", source: "submission" });
  }
  return { id: assetId };
}

function opAppendObservation(ctx, op) {
  const statement = reqStr(op, "statement");
  let captureId = null;
  if (op.capture_id !== undefined && op.capture_id !== null && op.capture_id !== "") {
    captureId = ctx.resolveRef(op.capture_id);
    ctx.assertExists(captureId, "capture_id");
  }
  const anchor =
    op.anchor === undefined || op.anchor === null
      ? "{}"
      : typeof op.anchor === "string"
        ? op.anchor
        : JSON.stringify(op.anchor);
  const id = formatSeqId("O", allocateSeq(ctx.db, GLOBAL_SEQ_SCOPE, "observation"));
  ctx.db
    .prepare(
      `INSERT INTO observations (id, project_id, capture_id, anchor, statement, conditions,
         created_at, created_by, created_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, ctx.projectId, captureId, anchor, statement, toJsonArr(op.conditions, "conditions", op.op), ctx.now, ctx.actor, ctx.commitSeq);
  if (op.local_ref) ctx.ids[op.local_ref] = id;
  // 观察不可变、独立保留：追加不等于集合并集（§11.3）；不推进任何 evidence_revision
  ctx.emit("observation.appended", {
    subject_ids: [id],
    payload: { observation_id: id, statement: truncate(statement), capture_id: captureId },
  });
  return { id };
}

function opProposeHypothesis(ctx, op) {
  const statement = reqStr(op, "statement");
  const id = formatSeqId("H", allocateSeq(ctx.db, GLOBAL_SEQ_SCOPE, "hypothesis"));
  ctx.db
    .prepare(
      `INSERT INTO hypotheses (id, project_id, statement, conditions, status, created_at,
         created_by, created_seq, updated_seq, state_version, claim_revision, evidence_revision, assessment_epoch)
       VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, 1, 1, 1, 1)`,
    )
    .run(id, ctx.projectId, statement, toJsonArr(op.conditions, "conditions", op.op), ctx.now, ctx.actor, ctx.commitSeq, ctx.commitSeq);
  if (op.local_ref) ctx.ids[op.local_ref] = id;
  ctx.emit("hypothesis.proposed", {
    subject_ids: [id],
    payload: { hypothesis_id: id, statement: truncate(statement), status: "open" },
  });
  return { id };
}

function opReportVulnerability(ctx, op) {
  // §8.2：疑似阶段即可创建并立即拥有 ID 与草稿；worker 不能自行 confirmed/falsified
  const category = reqStr(op, "category");
  let assetId = null;
  if (op.asset_id !== undefined && op.asset_id !== null && op.asset_id !== "") {
    assetId = ctx.resolveRef(op.asset_id);
    const hit = ctx.assertExists(assetId, "asset_id");
    if (hit.table !== "assets") {
      throw apiError("INVALID_REFERENCE", `asset_id 引用的不是资产：${assetId}`);
    }
  }
  const id = formatSeqId("V", allocateSeq(ctx.db, GLOBAL_SEQ_SCOPE, "vulnerability"));
  ctx.db
    .prepare(
      `INSERT INTO vulnerabilities (id, project_id, asset_id, location, category, status, review,
         impact, conditions, created_at, created_by, created_seq, updated_seq, state_version,
         claim_revision, evidence_revision, assessment_epoch)
       VALUES (?, ?, ?, ?, ?, 'suspected', 'clear', ?, ?, ?, ?, ?, ?, 1, 1, 1, 1)`,
    )
    .run(
      id,
      ctx.projectId,
      assetId,
      optStr(op, "location"),
      category,
      optStr(op, "impact"),
      toJsonArr(op.conditions, "conditions", op.op),
      ctx.now,
      ctx.actor,
      ctx.commitSeq,
      ctx.commitSeq,
    );
  if (op.local_ref) ctx.ids[op.local_ref] = id;
  ctx.emit("vulnerability.state_changed", {
    subject_ids: [id],
    changed_fields: ["status"],
    payload: { vulnerability_id: id, from: null, to: "suspected", category, location: optStr(op, "location") },
  });
  return { id };
}

function opAddRelation(ctx, op) {
  const type = reqStr(op, "type");
  if (!RELATION_TYPES.includes(type)) {
    throw apiError("BAD_REQUEST", `关系类型不在 §9.1/§7.3 目录：${type}`, {
      detail: { allowed: RELATION_TYPES },
    });
  }
  const from = ctx.resolveRef(reqStr(op, "from"));
  const to = ctx.resolveRef(reqStr(op, "to"));
  ctx.assertExists(from, "from");
  const toHit = ctx.assertExists(to, "to");
  const conditions =
    typeof op.conditions === "string" ? op.conditions : JSON.stringify(op.conditions ?? "");
  const id = insertRelation(ctx, {
    from,
    to,
    relation_type: type,
    conditions,
    requires_state: optStr(op, "requires_state"),
    source: optStr(op, "source"),
  });
  if (op.local_ref) ctx.ids[op.local_ref] = id;
  if ((type === "supports" || type === "contradicts") && JUDGEMENT_TABLES.has(toHit.table)) {
    applyEvidenceMembership(ctx, { subjectId: to, subjectTable: toHit.table, fromId: from, relation_type: type });
  }
  return { id };
}

function opRetractRelation(ctx, op) {
  // §11.3 修改型：关系撤回检查期望版本；关系行无 state_version，以创建边界
  // valid_from_seq 作为该边的可校验版本（竣工记录中说明该映射）
  const id = ctx.resolveRef(reqStr(op, "id"));
  const row = ctx.db
    .prepare("SELECT * FROM relations WHERE id = ? AND project_id = ?")
    .get(id, ctx.projectId);
  if (!row) {
    throw apiError("INVALID_REFERENCE", `关系不存在：${id}`);
  }
  if (row.retracted_at) {
    throw apiError("PRECONDITION_INVALID", `关系已撤回：${id}`);
  }
  const expected = op.expected_valid_from_seq;
  if (typeof expected !== "number" || !Number.isInteger(expected)) {
    throw apiError("BAD_REQUEST", "操作 retract_relation 需要整数字段 expected_valid_from_seq（§11.3）");
  }
  if (row.valid_from_seq !== expected) {
    throw apiError("STALE_STATE", `关系 ${id} 的创建边界已变化，拒绝撤回（§11.3）`, {
      detail: { current_valid_from_seq: row.valid_from_seq, expected_valid_from_seq: expected },
      next_requirements: [`以 expected_valid_from_seq=${row.valid_from_seq} 重试`],
    });
  }
  ctx.db.prepare("UPDATE relations SET retracted_at = ? WHERE id = ?").run(ctx.now, id);
  if (op.local_ref) ctx.ids[op.local_ref] = id;
  if (row.relation_type === "requires") {
    ctx.emit("dependency.changed", {
      subject_ids: [row.to_id],
      changed_fields: ["requires"],
      payload: { relation_id: id, from: row.from_id, to: row.to_id, change: "retracted" },
    });
  }
  if (
    (row.relation_type === "supports" || row.relation_type === "contradicts") &&
    JUDGEMENT_TABLES.has(locateRecord(ctx.db, ctx.projectId, row.to_id)?.table || "")
  ) {
    // §12.1：证据撤回推进 evidence_revision
    const membership = ctx.db
      .prepare(
        `SELECT id FROM evidence_memberships WHERE project_id = ? AND subject_id = ? AND member_id = ?`,
      )
      .get(ctx.projectId, row.to_id, row.from_id);
    if (membership) {
      ctx.db
        .prepare("UPDATE evidence_memberships SET status = 'withdrawn' WHERE id = ?")
        .run(membership.id);
    }
    advanceEvidenceRevision(ctx, {
      subjectId: row.to_id,
      subjectTable: locateRecord(ctx.db, ctx.projectId, row.to_id).table,
      reason: `证据成员撤回（${row.from_id} ${row.relation_type}）`,
    });
  }
  return { id };
}

function opReviseHypothesis(ctx, op) {
  // §11.3 修改型：判断内容修改检查 expected_state_version；更改核心判断推进 claim_revision
  const id = ctx.resolveRef(reqStr(op, "id"));
  const row = ctx.db
    .prepare("SELECT * FROM hypotheses WHERE id = ? AND project_id = ?")
    .get(id, ctx.projectId);
  if (!row) {
    throw apiError("INVALID_REFERENCE", `假设不存在：${id}`);
  }
  const expected = op.expected_state_version;
  if (typeof expected !== "number" || !Number.isInteger(expected)) {
    throw apiError("BAD_REQUEST", "操作 revise_hypothesis 需要整数字段 expected_state_version（§11.3）");
  }
  if (row.state_version !== expected) {
    throw apiError("STALE_STATE", `假设 ${id} 的 state_version 已变化，拒绝修改（§11.3）`, {
      detail: { current_state_version: row.state_version, expected_state_version: expected },
      next_requirements: [`以 expected_state_version=${row.state_version} 重试`],
    });
  }
  const hasStatement = typeof op.statement === "string" && op.statement.trim();
  const hasConditions = op.conditions !== undefined;
  if (!hasStatement && !hasConditions) {
    throw apiError("BAD_REQUEST", "操作 revise_hypothesis 至少提供 statement 或 conditions 之一");
  }
  const changedFields = [];
  if (hasStatement) changedFields.push("statement");
  if (hasConditions) changedFields.push("conditions");
  changedFields.push("claim_revision", "state_version");
  ctx.db
    .prepare(
      `UPDATE hypotheses SET statement = ?, conditions = ?, state_version = ?, claim_revision = ?,
         updated_seq = ? WHERE id = ? AND project_id = ?`,
    )
    .run(
      hasStatement ? op.statement : row.statement,
      hasConditions ? toJsonArr(op.conditions, "conditions", op.op) : row.conditions,
      row.state_version + 1,
      row.claim_revision + 1,
      ctx.commitSeq,
      id,
      ctx.projectId,
    );
  if (op.local_ref) ctx.ids[op.local_ref] = id;
  // 事件目录：hypothesis.proposed 覆盖「Hypothesis 建立/修订」（蓝图 §6）
  ctx.emit("hypothesis.proposed", {
    subject_ids: [id],
    changed_fields: changedFields,
    payload: {
      hypothesis_id: id,
      revised: true,
      claim_revision: row.claim_revision + 1,
      statement: truncate(hasStatement ? op.statement : row.statement),
    },
  });
  return { id };
}

registerSubmissionOps("A1/record-service", [
  { name: "register_asset", kind: "append", roles: ["worker"], handler: opRegisterAsset },
  { name: "append_observation", kind: "append", roles: ["worker"], handler: opAppendObservation },
  { name: "propose_hypothesis", kind: "append", roles: ["worker"], handler: opProposeHypothesis },
  { name: "report_vulnerability", kind: "append", roles: ["worker"], handler: opReportVulnerability },
  { name: "add_relation", kind: "append", roles: ["worker"], handler: opAddRelation },
  { name: "retract_relation", kind: "modify", roles: ["worker"], handler: opRetractRelation },
  { name: "revise_hypothesis", kind: "modify", roles: ["worker"], handler: opReviseHypothesis },
]);

/* ── 统一提交信封（§11.1/§11.3） ──────────────────────────────────── */

const SUBMISSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const FORMAL_ID_RE = /^[A-Z]{1,4}-\d+$/;

function validateEnvelopeShape(envelope) {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw apiError("BAD_REQUEST", "提交信封必须是 JSON 对象");
  }
  for (const forbidden of ["project_id", "actor", "role"]) {
    if (forbidden in envelope) {
      throw apiError("BAD_REQUEST", `信封不得携带 ${forbidden}：由服务端会话决定，不信任模型自报（§11.1）`);
    }
  }
  if (typeof envelope.submission_id !== "string" || !SUBMISSION_ID_RE.test(envelope.submission_id)) {
    throw apiError("BAD_REQUEST", "submission_id 必须是 1..128 位的 [A-Za-z0-9._:-] 编号（首字符为字母或数字）");
  }
  if (
    envelope.attempt_id !== undefined &&
    envelope.attempt_id !== null &&
    (typeof envelope.attempt_id !== "string" || !SUBMISSION_ID_RE.test(envelope.attempt_id))
  ) {
    throw apiError("BAD_REQUEST", "attempt_id 必须是与 submission_id 同形的编号");
  }
  if (!Array.isArray(envelope.operations)) {
    throw apiError("BAD_REQUEST", "operations 必须是数组");
  }
  const seenRefs = new Set();
  for (const op of envelope.operations) {
    if (!op || typeof op !== "object" || typeof op.op !== "string" || !op.op) {
      throw apiError("BAD_REQUEST", "每个操作必须是含 op 字符段的对象");
    }
    if (op.local_ref !== undefined && op.local_ref !== null) {
      if (typeof op.local_ref !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(op.local_ref)) {
        throw apiError("BAD_REQUEST", `local_ref 格式非法：${op.local_ref}`);
      }
      if (FORMAL_ID_RE.test(op.local_ref)) {
        throw apiError("BAD_REQUEST", `local_ref 不得使用正式编号形态（${op.local_ref}），避免与持久 ID 混淆`);
      }
      if (seenRefs.has(op.local_ref)) {
        throw apiError("BAD_REQUEST", `local_ref 在同一提交内重复：${op.local_ref}`);
      }
      seenRefs.add(op.local_ref);
    }
  }
}

function precheckOps(session, envelope) {
  for (const op of envelope.operations) {
    const def = opRegistry.get(op.op);
    if (!def) {
      throw apiError("BAD_REQUEST", `未知操作：${op.op}`, {
        detail: { registered: [...opRegistry.keys()] },
      });
    }
    if (!def.roles.includes(session.role)) {
      throw apiError("TRUST_DENIED", `会话角色 ${session.role}（actor=${session.actor}）无权执行操作 ${op.op}（蓝图 §8.2 权限矩阵）`, {
        detail: { op: op.op, allowed_roles: def.roles },
      });
    }
  }
}

/**
 * 幂等统一提交（§11.1/§11.3/§13/§14.1）：
 * 同一 (project_id, submitter_id, submission_id) + 相同请求摘要 → 原回执；
 * 同 ID 不同内容 → IDEMPOTENCY_KEY_REUSED（不覆盖原提交）。
 * 业务记录、submissions 回执与 Outbox 事件在同一 runSerial 事务内提交；
 * 逻辑依赖组全部成功或全部失败（§11.3）。
 */
export async function submit(pctx, { session, envelope }) {
  const store = await getStore(pctx);
  validateEnvelopeShape(envelope);
  const requestDigest = sha256Hex(
    canonicalJson({
      submission_id: envelope.submission_id,
      attempt_id: envelope.attempt_id ?? null,
      operations: envelope.operations,
    }),
  );
  // 预检操作与角色：失败快速返回，不进入事务、不消耗 commit_seq
  precheckOps(session, envelope);
  return store.runSerial((db) => {
    const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(session.project_id);
    if (!project) {
      throw apiError("NOT_FOUND", `会话绑定的项目不存在：${session.project_id}`);
    }
    const dup = db
      .prepare("SELECT * FROM submissions WHERE project_id = ? AND submitter_id = ? AND id = ?")
      .get(session.project_id, session.actor, envelope.submission_id);
    if (dup) {
      if (dup.request_digest === requestDigest) {
        return JSON.parse(dup.receipt); // 原回执原样返回（§11.1：同摘要返回原回执）
      }
      throw apiError("IDEMPOTENCY_KEY_REUSED", `submission_id ${envelope.submission_id} 已用于不同内容，拒绝覆盖原提交（§11.1）`, {
        receipt: { submission_id: dup.id, commit_seq: dup.commit_seq, result_hash: dup.result_hash },
        next_requirements: ["重试原内容必须原样重发同一提交；不同内容必须使用新的 submission_id"],
      });
    }
    if (envelope.attempt_id != null) {
      const att = db
        .prepare("SELECT id FROM attempts WHERE project_id = ? AND id = ?")
        .get(session.project_id, envelope.attempt_id);
      if (!att) {
        throw apiError("INVALID_REFERENCE", `attempt_id 不存在：${envelope.attempt_id}`, {
          next_requirements: ["先创建执行尝试（POST /attempts），或去掉 attempt_id"],
        });
      }
    }
    // §16.4：用户停止禁止的是新派发；已产生证据的保存不因项目 paused/stopped 被拒
    const commitSeq = allocateCommitSeq(db, session.project_id);
    const ctx = makeOpContext(db, session, envelope.submission_id, commitSeq);
    const accepted = [];
    for (const op of envelope.operations) {
      const def = opRegistry.get(op.op);
      const out = def.handler(ctx, op);
      accepted.push({ op: op.op, local_ref: op.local_ref ?? null, id: (out && out.id) || null });
    }
    const receipt = {
      submission_id: envelope.submission_id,
      commit_seq: commitSeq,
      ids: ctx.ids,
      accepted_operations: accepted,
      warnings: ctx.warnings,
      result_hash: null,
    };
    receipt.result_hash = sha256Hex(
      canonicalJson({
        submission_id: receipt.submission_id,
        commit_seq: receipt.commit_seq,
        ids: receipt.ids,
        accepted_operations: receipt.accepted_operations,
      }),
    );
    flushEvents(db, {
      projectId: session.project_id,
      actor: session.actor,
      commitSeq,
      causeRef: envelope.submission_id,
      events: ctx.events,
      now: ctx.now,
    });
    // 自动标记受影响的分支摘要为 stale（§十三：新内容写入后由程序触发，不在每条写入时重写摘要）
    const staleTriggerTypes = new Set([
      "observation.appended", "hypothesis.proposed", "hypothesis.revised",
      "vulnerability.state_changed", "fact.recorded",
    ]);
    const hasStaleTrigger = ctx.events.some((e) => staleTriggerTypes.has(e.event_type));
    if (hasStaleTrigger) {
      db.prepare(
        `UPDATE branch_summaries SET refresh_status = 'stale', updated_at = ?
         WHERE project_id = ? AND refresh_status = 'current'`,
      ).run(ctx.now, session.project_id);
    }
    db.prepare(
      `INSERT INTO submissions (id, project_id, submitter_id, request_digest, receipt, commit_seq,
         status, accepted_operations, warnings, result_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'committed', ?, ?, ?, ?)`,
    ).run(
      envelope.submission_id,
      session.project_id,
      session.actor,
      requestDigest,
      JSON.stringify(receipt),
      commitSeq,
      JSON.stringify(accepted),
      JSON.stringify(ctx.warnings),
      receipt.result_hash,
      ctx.now,
    );
    return receipt;
  });
}

/* ── 项目与范围（§16.4/§17） ──────────────────────────────────────── */

/**
 * 统一解析项目目标与补充说明（阶段 1：task 优先；task 为空回退 description；
 * 均为空时显式标记 goal_missing=true，不混用、不静默伪造默认目标）。
 */
export function resolveProjectGoal(row) {
  const task = typeof row?.task === "string" ? row.task.trim() : "";
  const description = typeof row?.description === "string" ? row.description.trim() : "";
  if (task) {
    return {
      task,
      description,
      goal: task,
      goal_source: "task",
      goal_missing: false,
      goal_note: null,
    };
  }
  if (description) {
    return {
      task: "",
      description,
      goal: description,
      goal_source: "description_fallback",
      goal_missing: false,
      goal_note: "task 字段为空，回退使用项目 description 作为有效探索目标",
    };
  }
  return {
    task: "",
    description: "",
    goal: "",
    goal_source: "missing",
    goal_missing: true,
    goal_note: "项目 task 与 description 均为空，探索目标缺失（goal_missing=true），不得假定固定默认目标",
  };
}

function projectView(row) {
  const goalInfo = resolveProjectGoal(row);
  let resourcePolicy = {};
  try {
    resourcePolicy = row.resource_policy ? JSON.parse(row.resource_policy) : {};
  } catch {
    resourcePolicy = {};
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    task: row.task ?? "",
    goal: goalInfo.goal,
    goal_source: goalInfo.goal_source,
    goal_missing: goalInfo.goal_missing,
    goal_note: goalInfo.goal_note,
    status: row.status,
    current_scope_revision: row.current_scope_revision,
    resource_policy: resourcePolicy,
    created_at: row.created_at,
    created_by: row.created_by,
    created_seq: row.created_seq,
    updated_seq: row.updated_seq,
    state_version: row.state_version,
  };
}

/**
 * 组装单项目的统一项目上下文（Planner / Orchestrator / Worker / Verifier 共用口径）：
 * 含主目标（task/description/goal/goal_source/goal_missing）、当前范围版本（allow/deny/pending）
 * 与资源限制（resource_policy）。
 */
export function buildProjectContext(db, projectId) {
  const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId);
  if (!project) {
    throw apiError("NOT_FOUND", `项目不存在：${projectId}`);
  }
  const goalInfo = resolveProjectGoal(project);
  const scopeRow = project.current_scope_revision
    ? db
        .prepare("SELECT * FROM scope_revisions WHERE project_id = ? AND id = ?")
        .get(projectId, project.current_scope_revision)
    : null;
  let scopeRules = null;
  if (scopeRow) {
    try {
      scopeRules = JSON.parse(scopeRow.rules);
    } catch {
      scopeRules = { allow: [], deny: [], pending: [] };
    }
  }
  let resourcePolicy = {};
  try {
    resourcePolicy = project.resource_policy ? JSON.parse(project.resource_policy) : {};
  } catch {
    resourcePolicy = {};
  }
  return {
    project_id: project.id,
    name: project.name,
    status: project.status,
    state_version: project.state_version,
    task: goalInfo.task,
    description: goalInfo.description,
    goal: goalInfo.goal,
    goal_source: goalInfo.goal_source,
    goal_missing: goalInfo.goal_missing,
    goal_note: goalInfo.goal_note,
    scope: scopeRow
      ? {
          configured: true,
          scope_revision_id: scopeRow.id,
          revision: scopeRow.revision,
          rules: scopeRules,
          summary: scopeRow.summary || "",
          created_at: scopeRow.created_at,
        }
      : {
          configured: false,
          scope_revision_id: null,
          revision: null,
          rules: null,
          summary: "",
          note: "尚未配置任何范围版本；缺少目标范围时不得默认任意目标均可操作（§17）",
        },
    resource_policy: resourcePolicy,
  };
}

export async function getProjectContext(pctx, projectId) {
  const store = await getStore(pctx);
  return buildProjectContext(store.db, projectId);
}

export async function listProjects(pctx) {
  const store = await getStore(pctx);
  return {
    projects: store.db
      .prepare("SELECT * FROM projects ORDER BY created_at, rowid")
      .all()
      .map(projectView),
  };
}

export async function getProjectDetail(pctx, projectId) {
  const store = await getStore(pctx);
  const db = store.db;
  const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId);
  if (!project) {
    throw apiError("NOT_FOUND", `项目不存在：${projectId}`);
  }
  const scope = project.current_scope_revision
    ? db.prepare("SELECT * FROM scope_revisions WHERE id = ?").get(project.current_scope_revision)
    : null;
  const counts = {};
  for (const [key, table] of [
    ["assets", "assets"],
    ["observations", "observations"],
    ["hypotheses", "hypotheses"],
    ["vulnerabilities", "vulnerabilities"],
    ["submissions", "submissions"],
  ]) {
    counts[key] = db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE project_id = ?`).get(projectId).c;
  }
  counts.outbox_pending = db
    .prepare("SELECT COUNT(*) AS c FROM outbox WHERE project_id = ? AND delivery_status = 'pending'")
    .get(projectId).c;
  return {
    project: projectView(project),
    scope: scope ? scopeView(scope) : null,
    counts,
  };
}

function scopeView(row) {
  return {
    id: row.id,
    project_id: row.project_id,
    revision: row.revision,
    rules: JSON.parse(row.rules),
    summary: row.summary,
    created_at: row.created_at,
    created_by: row.created_by,
    created_seq: row.created_seq,
  };
}

function validateScopeRules(rules) {
  if (rules === undefined || rules === null) return { allow: [], deny: [], pending: [] };
  if (typeof rules !== "object" || Array.isArray(rules)) {
    throw apiError("BAD_REQUEST", "scope rules 必须是 { allow, deny, pending } 对象（§17）");
  }
  const out = { allow: [], deny: [], pending: [] };
  for (const key of ["allow", "deny", "pending"]) {
    const v = rules[key];
    if (v === undefined || v === null) continue;
    if (!Array.isArray(v)) {
      throw apiError("BAD_REQUEST", `scope rules.${key} 必须是数组（§17）`);
    }
    for (const entry of v) {
      if (typeof entry !== "string" && (entry === null || typeof entry !== "object")) {
        throw apiError("BAD_REQUEST", `scope rules.${key} 的成员必须是字符串或对象`);
      }
    }
    out[key] = v;
  }
  return out;
}

function insertScopeRevision(db, { projectId, revision, rules, summary, actor, commitSeq, now, sink }) {
  // SR-nnnn 为全局主键编号 → 全局序列
  const id = formatSeqId("SR", allocateSeq(db, GLOBAL_SEQ_SCOPE, "scope_revision"));
  db.prepare(
    `INSERT INTO scope_revisions (id, project_id, revision, rules, summary, created_at, created_by, created_seq)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, projectId, revision, JSON.stringify(rules), summary || "", now, actor, commitSeq);
  db.prepare("UPDATE projects SET current_scope_revision = ?, updated_seq = ? WHERE id = ?").run(
    id,
    commitSeq,
    projectId,
  );
  sink.emit("scope.revised", {
    subject_ids: [projectId],
    payload: { scope_revision_id: id, revision, summary: summary || "" },
  });
  return { id, revision, rules };
}

/** 创建项目（§16.4：active 起步；运行状态与探索进展分开）。可选携带初始范围版本（§17）。 */
export async function createProject(pctx, { actor, name, description = "", task = "", scopeRules = null }) {
  if (typeof name !== "string" || !name.trim() || name.length > 200) {
    throw apiError("BAD_REQUEST", "项目 name 必填（1..200 字符）");
  }
  const rules = scopeRules == null ? null : validateScopeRules(scopeRules);
  const store = await getStore(pctx);
  return store.runSerial((db) => {
    const projectId = formatSeqId("PRJ", allocateSeq(db, GLOBAL_SEQ_SCOPE, "project"));
    const now = new Date().toISOString();
    // 项目创建本身消耗首个 commit_seq（created_seq=1，next_commit_seq 推进到 2）
    db.prepare(
      `INSERT INTO projects (id, name, description, task, status, current_scope_revision, resource_policy,
         next_commit_seq, created_at, created_by, created_seq, updated_seq, state_version)
       VALUES (?, ?, ?, ?, 'active', NULL, '{}', 2, ?, ?, 1, 0, 1)`,
    ).run(projectId, name, description || "", typeof task === "string" ? task : "", now, actor);
    const sink = makeEventSink();
    let scope = null;
    if (rules) {
      const created = insertScopeRevision(db, {
        projectId,
        revision: "1",
        rules,
        summary: "初始范围版本",
        actor,
        commitSeq: 1,
        now,
        sink,
      });
      flushEvents(db, { projectId, actor, commitSeq: 1, causeRef: `project:${projectId}`, events: sink.events, now });
      scope = scopeView(db.prepare("SELECT * FROM scope_revisions WHERE id = ?").get(created.id));
    }
    return { project: projectView(db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId)), scope };
  });
}

/**
 * 删除项目：清空该项目在所有持久表中的记录、消费回执/消息链接、进程内会话与
 * projects/<id>/ 文件目录（M3 删除接口；「删除干净」由程序保证，不靠 UI）。
 * 删除是不可逆操作；调用方必须显式确认（路由层校验 confirm）。
 */
export async function deleteProject(pctx, { projectId, actor }) {
  if (typeof projectId !== "string" || !projectId.trim()) {
    throw apiError("BAD_REQUEST", "缺少 projectId");
  }
  const store = await getStore(pctx);
  const result = await store.runSerial((db) => {
    const project = db.prepare("SELECT id, name, status FROM projects WHERE id = ?").get(projectId);
    if (!project) throw apiError("NOT_FOUND", `项目不存在：${projectId}`);
    // 延迟外键：先删子表/关联表，最后删 projects；提交时统一校验（项目内全部行已删）。
    db.exec("PRAGMA defer_foreign_keys = ON");
    const counts = {};
    const outboxIds = db.prepare("SELECT event_id FROM outbox WHERE project_id = ?").all(projectId).map((r) => r.event_id);
    if (outboxIds.length) {
      const ph = outboxIds.map(() => "?").join(",");
      counts.consumer_receipts = db.prepare(`DELETE FROM consumer_receipts WHERE event_id IN (${ph})`).run(...outboxIds).changes;
    }
    const messageIds = db.prepare("SELECT id FROM messages WHERE project_id = ?").all(projectId).map((r) => r.id);
    if (messageIds.length) {
      const ph = messageIds.map(() => "?").join(",");
      counts.message_links = db.prepare(`DELETE FROM message_links WHERE message_id IN (${ph})`).run(...messageIds).changes;
    }
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((r) => r.name);
    for (const table of tables) {
      if (table === "projects" || table === "schema_version") continue;
      const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
      if (!cols.includes("project_id")) continue;
      const res = db.prepare(`DELETE FROM ${table} WHERE project_id = ?`).run(projectId);
      if (res.changes) counts[table] = (counts[table] || 0) + res.changes;
    }
    const del = db.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
    counts.projects = del.changes;
    return { project, counts };
  });
  const sessions_revoked = revokeSessionsForProject(projectId);
  let files_removed = false;
  let file_error = null;
  try {
    await rm(join(pctx.dataDir, "projects", projectId), { recursive: true, force: true });
    files_removed = true;
  } catch (error) {
    file_error = String(error?.message ?? error);
  }
  return {
    deleted_project_id: projectId,
    deleted_project_name: result.project.name,
    deleted: result.counts,
    sessions_revoked,
    files_removed,
    file_error,
    actor,
  };
}

/** 项目生命周期（§16.4）：active/waiting_for_change/paused/stopped；可选 expected_state_version（§11.3 修改型语义）。 */
export async function updateProjectLifecycle(pctx, { projectId, actor, action, expectedStateVersion }) {
  const transition = LIFECYCLE_TRANSITIONS[action];
  if (!transition) {
    throw apiError("BAD_REQUEST", `未知生命周期动作：${action}（允许：pause / wait / resume / stop）`);
  }
  const store = await getStore(pctx);
  return store.runSerial((db) => {
    const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId);
    if (!project) {
      throw apiError("NOT_FOUND", `项目不存在：${projectId}`);
    }
    if (expectedStateVersion !== undefined && expectedStateVersion !== null) {
      if (typeof expectedStateVersion !== "number" || !Number.isInteger(expectedStateVersion)) {
        throw apiError("BAD_REQUEST", "expected_state_version 必须是整数");
      }
      if (project.state_version !== expectedStateVersion) {
        throw apiError("STALE_STATE", `项目 ${projectId} 的 state_version 已变化，拒绝生命周期变更（§11.3）`, {
          detail: { current_state_version: project.state_version, expected_state_version: expectedStateVersion },
          next_requirements: [`以 expected_state_version=${project.state_version} 重试`],
        });
      }
    }
    if (!transition.from.includes(project.status)) {
      throw apiError("PRECONDITION_INVALID", `项目状态 ${project.status} 不允许执行 ${action}（→ ${transition.to}）`, {
        detail: { current_status: project.status, action, target: transition.to },
        next_requirements: [`合法迁移：${Object.entries(LIFECYCLE_TRANSITIONS)
          .map(([a, t]) => `${a}: ${t.from.join("|")} → ${t.to}`)
          .join("；")}`],
      });
    }
    const commitSeq = allocateCommitSeq(db, projectId);
    const now = new Date().toISOString();
    db.prepare("UPDATE projects SET status = ?, state_version = ?, updated_seq = ? WHERE id = ?").run(
      transition.to,
      project.state_version + 1,
      commitSeq,
      projectId,
    );
    // 事件映射说明：生命周期影响全部资源可用性，以 resource_state.changed 承载（蓝图 §6 目录；竣工记录有说明）
    const sink = makeEventSink();
    sink.emit("resource_state.changed", {
      subject_ids: [projectId],
      changed_fields: ["status"],
      payload: { kind: "project_lifecycle", from: project.status, to: transition.to, action },
    });
    flushEvents(db, { projectId, actor, commitSeq, causeRef: `project:${projectId}`, events: sink.events, now });
    const updated = db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId);
    return { project: projectView(updated), commit_seq: commitSeq };
  });
}

/** 新范围版本（§17：版本化配置，区分允许/拒绝/待判断；立即生效于新动作的判定属 C2）。 */
export async function createScopeRevision(pctx, { projectId, actor, rules, summary = "" }) {
  const normalized = validateScopeRules(rules);
  const store = await getStore(pctx);
  return store.runSerial((db) => {
    const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId);
    if (!project) {
      throw apiError("NOT_FOUND", `项目不存在：${projectId}`);
    }
    const revisionNum =
      db.prepare("SELECT COUNT(*) AS c FROM scope_revisions WHERE project_id = ?").get(projectId).c + 1;
    const commitSeq = allocateCommitSeq(db, projectId);
    const now = new Date().toISOString();
    const sink = makeEventSink();
    const scope = insertScopeRevision(db, {
      projectId,
      revision: String(revisionNum),
      rules: normalized,
      summary,
      actor,
      commitSeq,
      now,
      sink,
    });
    flushEvents(db, { projectId, actor, commitSeq, causeRef: `project:${projectId}`, events: sink.events, now });
    const row = db.prepare("SELECT * FROM scope_revisions WHERE id = ?").get(scope.id);
    return { scope_revision: scopeView(row), commit_seq: commitSeq };
  });
}

/** 当前范围与历史（§17：缺少目标范围不得默认任意目标可操作——以 configured=false 显式表达）。 */
export async function getProjectScope(pctx, projectId) {
  const store = await getStore(pctx);
  const db = store.db;
  const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId);
  if (!project) {
    throw apiError("NOT_FOUND", `项目不存在：${projectId}`);
  }
  const history = db
    .prepare("SELECT * FROM scope_revisions WHERE project_id = ? ORDER BY CAST(revision AS INTEGER), rowid")
    .all(projectId)
    .map(scopeView);
  const current = project.current_scope_revision
    ? history.find((s) => s.id === project.current_scope_revision) || null
    : null;
  return {
    project_id: projectId,
    current,
    history,
    configured: Boolean(current),
    note: current
      ? null
      : "尚未配置任何范围版本；缺少目标范围时不得默认任意目标均可操作（§17）",
  };
}
