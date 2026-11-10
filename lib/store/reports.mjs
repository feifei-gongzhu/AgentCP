/**
 * E2 —— Worker 分层汇报服务（规范 §18.3 §18.4 §18.5；蓝图端点 #37/#38）。
 *
 * 合同落实：
 *   - 三层汇报（§18.3 表）：交接卡（handoff_card）/ 关键记录层（key_records）/
 *     完整依据层（full_basis），按层读取（GET /worker-reports/{id}?layer=…）；
 *   - WorkerReport 字段集 = §18.3 合同：report_id/project_id/intent_id/attempt_id/
 *     kind(progress|handoff|blocked|completion)/replaces_report_id?/base_report_id?/
 *     source_manifest_id/source_commit_boundary/task_question/actual_outcome/
 *     execution_status/important_findings[{record_id,type,current_status,short_statement}]/
 *     material_conditions[]/contradictions[]/significant_attempts[]/
 *     unresolved_questions[]/blockers[]/prerequisite_changes[]/proposed_next_actions[]/
 *     omitted_sections[{type,count,read_pointer}]/evidence_refs[]/full_record_pointer/
 *     delivery_status/handling_status。结构化列表存 worker_reports.content（列名即
 *     冻结 DDL，content 内形态为本模块合同）；
 *   - source_manifest_id：服务端在提交事务内按「执行窗口归因规则 v1」生成不可变
 *     记录清单（§18.5-2「汇报工具生成本次记录清单」），清单本体持久化于汇报行
 *     content.manifest（冻结 DDL 无独立清单表，见竣工记录偏差）；
 *     source_commit_boundary 判定时效：清单窗口上界；boundary 之后的新记录不拒绝
 *     提交（§18.3「新发现可以在汇报生成期间继续提交，并由后续增量通知覆盖」），
 *     回执与读取面均附增量提示；
 *   - 交接卡长度预算（§18.3 末段）：可配置（query budget / 环境变量），超预算分组
 *     分页 + 展开入口（omitted_from_this_page + read_pointer），任何条目不截断、
 *     不确定性/反对证据/身份条件不因预算删除（§20.3 场景 28）；
 *   - 程序覆盖检查（§18.4：新漏洞/待验证线索/状态撤回/阻塞/unknown 调用必须列入
 *     交接卡或显式分类清单，否则退回；§20.3 场景 26）；
 *   - 事实状态以库为准（§18.4 末段）：current_status 与持久记录不一致 → 拒绝提交
 *     （§20.3 场景 27：suspected 不得写成 confirmed）；读取面渲染与附带均取数据库
 *     当前值；AI 解释与建议单独标注，不替代原记录状态；
 *   - 幂等与重复投递（§18.5 末段）：提交登记于 A1 submissions 幂等域
 *     (project_id, submitter_id, submission_id)，同 ID 同内容 → 原回执，不重复落
 *     汇报、不重复发 worker_report.submitted 事件（同一汇报重复投递不得重复产生
 *     调度效果）；事件 payload 携带 covered_record_ids 供按记录 ID 去重通知；
 *   - base_report 基线（§18.6/§20.3 场景 31）：base_report_id 校验存在；读取面
 *     附相对基线的变化（集合差）并可展开基线全文，不依赖对话记忆；
 *   - completion 仅表示 worker 对本次意图执行的完成汇报（§18.3）：本模块不改
 *     intents/attempts 状态（意图完成判定归 C1、Attempt 终结归 C2），不自动确认
 *     漏洞、不结束项目（§1/§8）。
 *
 * 程序只做规范交给程序的校验与保障（权限、引用有效性、覆盖结构检查、幂等、
 * 原子事务、可靠事件）；覆盖检查是结构与覆盖检查，不保证语义准确（§18.4），
 * 语义核查、追问与协调决定归 Orchestrator/Verifier AI（§3.2/§18.5）。
 *
 * 编号：汇报 `WR-<projectId>-NNNN`、清单 `WRM-<projectId>-NNNN`（带项目前缀规避
 * A1 编号序列的跨项目主键冲突；与 C2 在 worker_reports 表内的 `WR-NNNN` 进展行
 * 共享同项目序列 kind=worker_report，同项目内互斥递增、形态互不冲突）。
 */
import { createHash } from "node:crypto";

import { apiError } from "../errors.mjs";
import { getStore } from "./record-service.mjs";

/* ── 常量与合同 ───────────────────────────────────────────────────── */

/** §18.3 kind 四态（与冻结 DDL CHECK 一致）。 */
export const REPORT_KINDS = Object.freeze(["progress", "handoff", "blocked", "completion"]);

/** §18.3：重要发现必须注明的四类对象（全称）→ 冻结 DDL 物理表。 */
export const FINDING_TYPE_TABLES = Object.freeze({
  Observation: "observations",
  Hypothesis: "hypotheses",
  Fact: "facts",
  Vulnerability: "vulnerabilities",
});

/** 编号前缀 → 发现类型全称（A1/D2 编号形态：O-/H-/F-/V-，可带项目段）。 */
const PREFIX_FINDING_TYPE = Object.freeze({
  O: "Observation",
  H: "Hypothesis",
  F: "Fact",
  V: "Vulnerability",
});

/** 判断类表（覆盖检查窗口归因的扫描对象）。 */
const JUDGEMENT_TABLES = Object.freeze(["vulnerabilities", "hypotheses", "facts"]);

/** 引用存在性校验的兜底扫描表（含证据与关系；不含仅有内联视图的执行对象）。 */
const REF_TABLES = Object.freeze([
  ...JUDGEMENT_TABLES,
  "observations",
  "assets",
  "relations",
  "captures",
  "blobs",
]);

/** §18.3 交接卡默认长度预算（字符）；可经 query budget 或 SORNE_HANDOFF_BUDGET 配置。 */
export const DEFAULT_HANDOFF_BUDGET = Number(process.env.SORNE_HANDOFF_BUDGET) || 2000;
export const MIN_HANDOFF_BUDGET = 500;
export const MAX_HANDOFF_BUDGET = 20000;

/** 交接卡分组：发现/条件类大组按每组条数切子组，保证「分组分页」粒度（§18.3 末段）。 */
const MAX_GROUP_ITEMS = 8;
/** 单页安全上限（防极端循环）。 */
const MAX_HANDOFF_PAGES = 2000;
/** manifest 记录数上限（内容保护；counts 始终真实）。 */
const MAX_MANIFEST_RECORDS = 5000;

/** 列表项中的结构化引用字段（覆盖检查的引用收集范围）。 */
const REF_KEYS = Object.freeze([
  "record_id",
  "ref",
  "tool_call_id",
  "attempt_id",
  "report_id",
  "relation_id",
  "capture_id",
  "evidence_ref",
]);

/** 覆盖类别 → 满足「显式分类清单」的 omitted_sections.type 取值（§18.4）。 */
const OMITTED_COVER_TYPES = Object.freeze({
  new_vulnerability: ["vulnerabilities", "important_findings", "key_records"],
  pending_hypothesis: ["pending_leads", "hypotheses", "important_findings", "key_records"],
  retraction: ["retractions", "contradictions", "key_records"],
  blocker: ["blockers", "key_records"],
  unknown_tool_call: ["unknown_tool_calls", "unknown", "key_records"],
});

const SUBMISSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** 编号形态（前缀-数字 或 前缀-项目段-数字）。 */
const RECORD_ID_RE = /^[A-Z]{1,4}(-[A-Za-z0-9][A-Za-z0-9_-]*)*-\d+$/;

/* ── 基础工具（与 A1/D1 同法的本地实现；冻结共享文件未导出这些内部件） ── */

function nowIso() {
  return new Date().toISOString();
}
function sha256Hex(text) {
  return createHash("sha256").update(text).digest("hex");
}
function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}
function pad(n, width = 4) {
  return String(n).padStart(width, "0");
}
/** 事务内分配稳定编号（§6.1 id_sequences；kind=worker_report 与 C2 共享同项目序列）。 */
function nextSeq(db, projectId, kind) {
  db.prepare(
    "INSERT INTO id_sequences (project_id, kind, next_val) VALUES (?, ?, 2) ON CONFLICT DO NOTHING",
  ).run(projectId, kind);
  const row = db.prepare("SELECT next_val AS n FROM id_sequences WHERE project_id = ? AND kind = ?").get(projectId, kind);
  db.prepare("UPDATE id_sequences SET next_val = ? WHERE project_id = ? AND kind = ?").run(row.n + 1, projectId, kind);
  return row.n;
}
function nextCommitSeq(db, projectId) {
  const row = db.prepare("SELECT next_commit_seq AS n FROM projects WHERE id = ?").get(projectId);
  db.prepare("UPDATE projects SET next_commit_seq = ? WHERE id = ?").run(row.n + 1, projectId);
  return row.n;
}
function currentBoundary(db, projectId) {
  return db.prepare("SELECT next_commit_seq AS n FROM projects WHERE id = ?").get(projectId).n - 1;
}
function reportIdFor(projectId, n) {
  return `WR-${projectId}-${pad(n)}`;
}
function manifestIdFor(projectId, n) {
  return `WRM-${projectId}-${pad(n)}`;
}
function parseJsonField(text, fallback) {
  if (text === null || text === undefined || text === "") return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}
function asArray(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw apiError("BAD_REQUEST", `汇报字段 ${field} 必须是数组（§18.3 WorkerReport 合同）`);
  }
  return value;
}
function optText(value, field) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") {
    throw apiError("BAD_REQUEST", `汇报字段 ${field} 必须是字符串`);
  }
  return value;
}

/** 定位判断类记录（存在性 + 物理表；前缀映射 + 兜底扫描）。 */
function locateJudgement(db, projectId, ref) {
  if (typeof ref !== "string" || !ref) return null;
  const m = /^([A-Z]{1,4})-/.exec(ref);
  if (m) {
    const type = PREFIX_FINDING_TYPE[m[1]];
    if (type) {
      const table = FINDING_TYPE_TABLES[type];
      const row = db.prepare(`SELECT * FROM ${table} WHERE id = ? AND project_id = ?`).get(ref, projectId);
      return row ? { table, type, row } : null;
    }
  }
  for (const table of JUDGEMENT_TABLES) {
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ? AND project_id = ?`).get(ref, projectId);
    if (row) return { table, type: tableToFindingType(table), row };
  }
  return null;
}
function tableToFindingType(table) {
  return Object.keys(FINDING_TYPE_TABLES).find((k) => FINDING_TYPE_TABLES[k] === table);
}
/** 通用引用存在性（判断类 + 资产/关系/采集/Blob）。 */
function refExists(db, projectId, ref) {
  if (typeof ref !== "string" || !ref || !RECORD_ID_RE.test(ref)) return false;
  if (locateJudgement(db, projectId, ref)) return true;
  for (const table of ["assets", "relations", "captures", "blobs"]) {
    if (db.prepare(`SELECT 1 FROM ${table} WHERE id = ? AND project_id = ?`).get(ref, projectId)) return true;
  }
  return false;
}

/* ── 记录清单（§18.5-2：汇报工具生成本次记录清单） ───────────────── */

/**
 * 执行窗口归因规则 v1（保守并集；用于覆盖检查的作用域）：
 *   - tool_calls / C2 #25 进展行：attempt_id 列直接归因（精确）；unknown 调用与
 *     blocked 属持续未决状态（§18.4 必须保留「实际未完成部分、工具失败、执行
 *     结果未知和阻塞原因」），每份汇报都要重新呈现，不随增量窗口收缩；
 *   - 判断类记录（V/H/F）与撤回边：冻结 DDL 该类表无 attempt 列、produced_by 边
 *     因 A1 locateRecord 不解析 ATT- 编号而无法经 #10 建立，故按「创建者 =
 *     attempt.worker_id 且 created_seq ∈ (lo, boundary]」归因（lo 默认
 *     attempt.created_seq；增量汇报收缩到基线 boundary，见下）。保守方向：同
 *     worker 并行 attempt 的记录可能并入本清单——覆盖检查宁可多要求列明
 *     （§18.4 未覆盖项退回 worker 补充，补充路径含显式分类清单），不漏报；
 *   - 增量汇报（base_report_id 存在）：新增类对象的窗口下界收缩到基线汇报的
 *     source_commit_boundary（§18.6「新汇报默认强调相对于 base_report 的变化」），
 *     已被基线覆盖的新增对象不再重复要求；replaces（修正同一份汇报）不收缩。
 */
export function collectAttemptRecords(db, { projectId, attempt, boundary, judgementWindowLo }) {
  const lo = Math.max(attempt.created_seq, judgementWindowLo ?? attempt.created_seq);
  const hi = boundary;
  const toolCalls =
    hi >= 0
      ? db
          .prepare(
            `SELECT id, tool_name, status, started_at, ended_at, evidence_refs, created_seq
               FROM tool_calls WHERE project_id = ? AND attempt_id = ? AND created_seq <= ?
               ORDER BY created_seq, id`,
          )
          .all(projectId, attempt.id, hi)
      : [];
  // C2 #25 进展/阻塞行（content.source=attempt_progress 标记；§C2 竣工偏差 1）
  const progressRows = db
    .prepare(
      `SELECT id, kind, task_question, actual_outcome, execution_status, content, created_seq
         FROM worker_reports
        WHERE project_id = ? AND attempt_id = ? AND created_seq <= ?
          AND content LIKE '%"source":"attempt_progress"%'
        ORDER BY created_seq, id`,
    )
    .all(projectId, attempt.id, hi)
    .map((r) => ({ ...r, content: parseJsonField(r.content, {}) }));
  const judgement = [];
  if (hi > lo) {
    for (const table of JUDGEMENT_TABLES) {
      const rows = db
        .prepare(
          `SELECT * FROM ${table} WHERE project_id = ? AND created_by = ? AND created_seq > ? AND created_seq <= ?
             ORDER BY created_seq, id`,
        )
        .all(projectId, attempt.worker_id, lo, hi);
      for (const row of rows) judgement.push({ table, row });
    }
  }
  const retractEdges =
    hi > lo
      ? db
          .prepare(
            `SELECT id, from_id, to_id, relation_type, created_seq FROM relations
              WHERE project_id = ? AND created_by = ? AND relation_type IN ('retracts','supersedes')
                AND created_seq > ? AND created_seq <= ? ORDER BY created_seq, id`,
          )
          .all(projectId, attempt.worker_id, lo, hi)
      : [];
  const records = [
    ...toolCalls.map((t) => ({ id: t.id, kind: "tool_calls", status: t.status })),
    ...progressRows.map((p) => ({ id: p.id, kind: "worker_report_progress", status: p.kind })),
    ...judgement.map((j) => ({ id: j.row.id, kind: j.table, status: j.row.status })),
    ...retractEdges.map((e) => ({ id: e.id, kind: "relations", status: e.relation_type })),
  ];
  const contentHash = sha256Hex(canonicalJson(records.map((r) => [r.id, r.kind, r.status])));
  return {
    rule: "worker-window-v1",
    boundary,
    attempt_id: attempt.id,
    intent_id: attempt.intent_id,
    worker_id: attempt.worker_id,
    counts: {
      tool_calls: toolCalls.length,
      unknown_tool_calls: toolCalls.filter((t) => t.status === "unknown").length,
      progress_rows: progressRows.length,
      blocked_rows: progressRows.filter((p) => p.kind === "blocked").length,
      judgement_records: judgement.length,
      retract_edges: retractEdges.length,
      total: records.length,
    },
    records: records.slice(0, MAX_MANIFEST_RECORDS),
    records_truncated: records.length > MAX_MANIFEST_RECORDS,
    content_hash: contentHash,
    // 明细供完整依据层内联呈现（tool_calls/进展行无独立读取端点）
    _toolCalls: toolCalls,
    _progressRows: progressRows,
    _judgement: judgement,
    _retractEdges: retractEdges,
  };
}

/* ── 覆盖检查（§18.4；§20.3 场景 26） ─────────────────────────────── */

/** 收集汇报各结构化列表中的引用编号（引用字段显式命名；不解析自由文本）。 */
function collectBodyRefs(body) {
  const refs = new Set();
  const push = (v) => {
    if (typeof v === "string" && RECORD_ID_RE.test(v)) refs.add(v);
  };
  for (const f of asArray(body.important_findings, "important_findings")) {
    if (f && typeof f === "object") push(f.record_id);
  }
  for (const key of [
    "material_conditions",
    "contradictions",
    "significant_attempts",
    "unresolved_questions",
    "blockers",
    "prerequisite_changes",
  ]) {
    for (const item of asArray(body[key], key)) {
      if (typeof item === "string") push(item);
      else if (item && typeof item === "object") {
        for (const rk of REF_KEYS) push(item[rk]);
      }
    }
  }
  for (const ref of asArray(body.evidence_refs, "evidence_refs")) push(ref);
  return refs;
}

function omittedCovers(omittedSections, category) {
  const allowed = OMITTED_COVER_TYPES[category] || [];
  return omittedSections.some((o) => {
    if (!o || typeof o !== "object") return false;
    const type = typeof o.type === "string" ? o.type : "";
    const pointer = typeof o.read_pointer === "string" ? o.read_pointer.trim() : "";
    const count = Number.isInteger(o.count) ? o.count : 1;
    return allowed.includes(type) && pointer && count >= 1;
  });
}

/**
 * 覆盖检查：source_manifest 内的新漏洞 / 待验证线索 / 状态撤回 / 阻塞 / unknown
 * 调用必须出现在交接卡结构化引用中，或显式分类清单（omitted_sections）列明；
 * 未覆盖项返回缺口（提交侧抛 PRECONDITION_INVALID 退回，§18.4）。
 */
export function coverageGaps(db, { manifest, body, attempt }) {
  const refs = collectBodyRefs(body);
  const omitted = asArray(body.omitted_sections, "omitted_sections").filter(
    (o) => o && typeof o === "object",
  );
  const gaps = [];
  const need = (id, category, extra) => {
    if (refs.has(id)) return;
    if (omittedCovers(omitted, category)) return;
    gaps.push({ type: category, record_id: id, ...extra });
  };
  for (const { table, row } of manifest._judgement) {
    if (table === "vulnerabilities") {
      need(row.id, "new_vulnerability", { current_status: row.status, review: row.review });
    } else if (table === "hypotheses" && ["open", "testing"].includes(row.status)) {
      need(row.id, "pending_hypothesis", { current_status: row.status });
    }
  }
  // 状态撤回：窗口内新判断记录当前已处于撤回态，或窗口内新增 retracts/supersedes 边
  for (const { table, row } of manifest._judgement) {
    if (table === "facts" && ["retracted", "superseded"].includes(row.status)) {
      need(row.id, "retraction", { current_status: row.status });
    }
  }
  for (const edge of manifest._retractEdges) {
    need(edge.to_id, "retraction", { relation_id: edge.id, relation_type: edge.relation_type });
    need(edge.id, "retraction", { relation_id: edge.id, note: "撤回边本身" });
  }
  // 阻塞：C2 #25 blocked 进展行；本次汇报本身 kind=blocked 时该行语义已由本汇报承载
  for (const p of manifest._progressRows) {
    if (p.kind !== "blocked") continue;
    if (body.kind === "blocked" && asArray(body.blockers, "blockers").length > 0) continue;
    need(p.id, "blocker", { note: parseJsonField(p.content, {}).note || "", kind: "blocked" });
  }
  // unknown 工具调用（§10.2：先检查现状再决定重试；汇报必须显式呈现）
  for (const t of manifest._toolCalls) {
    if (t.status === "unknown") need(t.id, "unknown_tool_call", { tool_name: t.tool_name });
  }
  return gaps;
}

/* ── 提交（POST /worker-reports，§18.5-1..3） ─────────────────────── */

function validateReportShape(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw apiError("BAD_REQUEST", "汇报请求必须是 JSON 对象");
  }
  for (const forbidden of ["project_id", "actor", "role", "handling_status", "delivery_status"]) {
    if (forbidden in body) {
      throw apiError("BAD_REQUEST", `汇报不得携带 ${forbidden}：由服务端会话与程序决定（§11.1/§18.3）`);
    }
  }
  if (typeof body.submission_id !== "string" || !SUBMISSION_ID_RE.test(body.submission_id)) {
    throw apiError("BAD_REQUEST", "缺少合法 submission_id（1..128 位 [A-Za-z0-9._:-]，重试必须同 ID；§11.1 幂等域）");
  }
  if (typeof body.attempt_id !== "string" || !body.attempt_id.trim()) {
    throw apiError("BAD_REQUEST", "缺少 attempt_id（§18.3：每次汇报关联一个意图与 Attempt）");
  }
  if (!REPORT_KINDS.includes(body.kind)) {
    throw apiError("BAD_REQUEST", `kind 必须是 ${REPORT_KINDS.join(" / ")} 之一（§18.3）`, {
      detail: { allowed: REPORT_KINDS },
    });
  }
  if (
    body.source_commit_boundary !== undefined &&
    body.source_commit_boundary !== null &&
    (!Number.isInteger(body.source_commit_boundary) || body.source_commit_boundary < 0)
  ) {
    throw apiError("BAD_REQUEST", "source_commit_boundary 必须是非负整数（项目 commit_seq；§18.3 时效）");
  }
  for (const key of [
    "important_findings",
    "material_conditions",
    "contradictions",
    "significant_attempts",
    "unresolved_questions",
    "blockers",
    "prerequisite_changes",
    "proposed_next_actions",
    "omitted_sections",
    "evidence_refs",
  ]) {
    asArray(body[key], key);
  }
  for (const f of body.important_findings || []) {
    if (!f || typeof f !== "object") {
      throw apiError("BAD_REQUEST", "important_findings 项必须是对象 {record_id, type, current_status, short_statement}");
    }
    if (typeof f.record_id !== "string" || !f.record_id) {
      throw apiError("BAD_REQUEST", "important_findings[].record_id 必填（§18.3）");
    }
    if (!FINDING_TYPE_TABLES[f.type]) {
      throw apiError("BAD_REQUEST", `important_findings[].type 必须是 ${Object.keys(FINDING_TYPE_TABLES).join(" / ")}（§18.3：必须注明对象类型）`, {
        detail: { allowed: Object.keys(FINDING_TYPE_TABLES) },
      });
    }
    if (typeof f.current_status !== "string" || !f.current_status) {
      throw apiError("BAD_REQUEST", "important_findings[].current_status 必填（§18.3：保留当前状态）");
    }
    if (typeof f.short_statement !== "string" || !f.short_statement.trim()) {
      throw apiError("BAD_REQUEST", "important_findings[].short_statement 必填（§18.3）");
    }
  }
}

/**
 * 提交分层汇报（#37）。
 * 覆盖检查、引用有效性、状态一致性、manifest 生成、汇报落库、幂等回执与
 * worker_report.submitted 事件在同一 runSerial 事务内提交（§18.5-3；§2 约束 10）。
 */
export async function submitWorkerReport(pctx, { session, body }) {
  validateReportShape(body);
  const requestDigest = sha256Hex(canonicalJson(body));
  const store = await getStore(pctx);
  return store.runSerial((db) => {
    const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(session.project_id);
    if (!project) throw apiError("NOT_FOUND", `项目不存在：${session.project_id}`);
    // 幂等（§11.1 域；§18.5 同一汇报重复投递不重复落库/发事件）
    const dup = db
      .prepare("SELECT * FROM submissions WHERE project_id = ? AND submitter_id = ? AND id = ?")
      .get(session.project_id, session.actor, body.submission_id);
    if (dup) {
      if (dup.request_digest === requestDigest) {
        const receipt = parseJsonField(dup.receipt, {});
        return { ...receipt, idempotent: true };
      }
      throw apiError("IDEMPOTENCY_KEY_REUSED", `submission_id ${body.submission_id} 已用于不同汇报内容，拒绝覆盖（§11.1）`, {
        receipt: { submission_id: dup.id, commit_seq: dup.commit_seq, result_hash: dup.result_hash },
        next_requirements: ["原样重发同一汇报内容，或使用新的 submission_id"],
      });
    }
    // Attempt 与 worker 归属（蓝图 §8.2 worker 面：只汇报派给自己的执行）
    const attempt = db
      .prepare("SELECT * FROM attempts WHERE project_id = ? AND id = ?")
      .get(session.project_id, body.attempt_id);
    if (!attempt) {
      throw apiError("INVALID_REFERENCE", `attempt_id 不存在：${body.attempt_id}`, {
        next_requirements: ["先经执行运行时派发（POST /attempts）取得 Attempt，再提交汇报"],
      });
    }
    if (attempt.worker_id !== session.actor) {
      throw apiError("TRUST_DENIED", `会话 actor ${session.actor} 不是 Attempt ${attempt.id} 的执行者（${attempt.worker_id}）；worker 只能汇报自己的执行（蓝图 §8.2）`);
    }
    if (body.intent_id !== undefined && body.intent_id !== null && body.intent_id !== attempt.intent_id) {
      throw apiError("BAD_REQUEST", `intent_id（${body.intent_id}）与 Attempt 绑定的意图（${attempt.intent_id}）不一致；汇报关联以 Attempt 为准（§18.3）`);
    }
    for (const [field, ref] of [
      ["replaces_report_id", body.replaces_report_id],
      ["base_report_id", body.base_report_id],
    ]) {
      if (ref === undefined || ref === null) continue;
      const row = db
        .prepare("SELECT id FROM worker_reports WHERE project_id = ? AND id = ?")
        .get(session.project_id, ref);
      if (!row) {
        throw apiError("INVALID_REFERENCE", `${field} 不存在：${ref}（§18.3 基线/修正必须指向已持久汇报）`, {
          next_requirements: [field === "base_report_id" ? "基线缺失时先补交基线汇报，或去掉 base_report_id" : "修正对象不存在；去掉 replaces_report_id"],
        });
      }
    }
    // 时效边界（§18.3）：声明未来边界无意义 → 拒绝；缺省取提交时刻已分配边界
    const latest = currentBoundary(db, session.project_id);
    const boundary =
      body.source_commit_boundary === undefined || body.source_commit_boundary === null
        ? latest
        : body.source_commit_boundary;
    if (boundary > latest) {
      throw apiError("BAD_REQUEST", `source_commit_boundary（${boundary}）超过项目当前已分配边界（${latest}）`, {
        detail: { declared: boundary, latest },
      });
    }
    // 引用有效性 + 类型一致 + 状态以库为准（§18.4/§20.3 场景 27）
    for (const f of body.important_findings) {
      const hit = locateJudgement(db, session.project_id, f.record_id);
      if (!hit) {
        throw apiError("INVALID_REFERENCE", `important_findings 引用的记录不存在：${f.record_id}（§18.4 引用有效性）`, {
          detail: { record_id: f.record_id },
          next_requirements: ["先持久保存该发现（POST /submissions），再在汇报中引用"],
        });
      }
      if (hit.type !== f.type) {
        throw apiError("BAD_REQUEST", `important_findings 类型声明与持久记录不符：${f.record_id} 是 ${hit.type}，汇报声明 ${f.type}（§18.3 必须注明对象类型）`, {
          detail: { record_id: f.record_id, db_type: hit.type, declared_type: f.type },
        });
      }
      if (f.current_status !== hit.row.status) {
        throw apiError("STALE_STATE", `重要发现 ${f.record_id} 的状态声明与持久记录不一致：库为 ${hit.row.status}，汇报声明 ${f.current_status}；摘要不得把 ${hit.row.status} 写成 ${f.current_status}（§18.4 事实状态从数据库读取；§20.3 场景 27）`, {
          detail: { record_id: f.record_id, db_status: hit.row.status, declared_status: f.current_status },
          next_requirements: [`把 current_status 修正为库中状态 ${hit.row.status} 后重交（使用新 submission_id 或原样内容）`],
        });
      }
    }
    for (const ref of body.evidence_refs || []) {
      if (!refExists(db, session.project_id, ref)) {
        throw apiError("INVALID_REFERENCE", `evidence_refs 引用不存在：${ref}（§18.4 引用有效性）`, {
          detail: { ref },
        });
      }
    }
    // 记录清单 + 覆盖检查（§18.5-2；未覆盖退回，不落任何行）。
    // 增量汇报（base）：新增类对象窗口收缩到基线 boundary（§18.6 相对基线变化）
    let judgementWindowLo;
    if (body.base_report_id) {
      const baseRow = db
        .prepare("SELECT source_commit_boundary FROM worker_reports WHERE project_id = ? AND id = ?")
        .get(session.project_id, body.base_report_id);
      judgementWindowLo = Number(baseRow?.source_commit_boundary) || 0;
    }
    const manifest = collectAttemptRecords(db, { projectId: session.project_id, attempt, boundary, judgementWindowLo });
    const gaps = coverageGaps(db, { manifest, body, attempt });
    if (gaps.length) {
      const grouped = {};
      for (const g of gaps) (grouped[g.type] ??= []).push(g.record_id);
      throw apiError(
        "PRECONDITION_INVALID",
        `汇报覆盖检查未通过：本次记录清单含 ${gaps.length} 项必须列入交接卡或显式分类清单的对象（新漏洞/待验证线索/状态撤回/阻塞/unknown 调用）；退回补充，不接受空泛总结规避（§18.4；§20.3 场景 26）`,
        {
          detail: { missing: gaps, missing_by_type: grouped, source_manifest_boundary: boundary },
          next_requirements: [
            "把遗漏对象列入 important_findings / blockers / contradictions / significant_attempts 等结构化字段，或在 omitted_sections 用对应 type（vulnerabilities / pending_leads / retractions / blockers / unknown_tool_calls）列明 read_pointer 后重交",
          ],
        },
      );
    }
    // boundary 之后的增量（§18.3 时效：不拒绝，回执提示由后续增量通知覆盖）
    const warnings = [];
    let newerCount = 0;
    if (boundary < latest) {
      const hi = latest;
      newerCount += db
        .prepare(
          `SELECT COUNT(*) AS c FROM tool_calls WHERE project_id = ? AND attempt_id = ? AND created_seq > ? AND created_seq <= ?`,
        )
        .get(session.project_id, attempt.id, boundary, hi).c;
      for (const table of JUDGEMENT_TABLES) {
        newerCount += db
          .prepare(
            `SELECT COUNT(*) AS c FROM ${table} WHERE project_id = ? AND created_by = ? AND created_seq > ? AND created_seq <= ?`,
          )
          .get(session.project_id, attempt.worker_id, boundary, hi).c;
      }
      if (newerCount > 0) {
        warnings.push(
          `汇报边界 ${boundary} 之后该执行已有 ${newerCount} 条新记录提交；汇报仍然有效，新记录由后续增量通知覆盖（§18.3 时效）`,
        );
      }
    }
    // 落库（§18.5-3：检查通过后持久保存汇报及 Outbox 事件，同事务）
    const now = nowIso();
    const commitSeq = nextCommitSeq(db, session.project_id);
    const reportId = reportIdFor(session.project_id, nextSeq(db, session.project_id, "worker_report"));
    const manifestId = manifestIdFor(session.project_id, nextSeq(db, session.project_id, "report_manifest"));
    const intent = db.prepare("SELECT * FROM intents WHERE project_id = ? AND id = ?").get(session.project_id, attempt.intent_id);
    const taskQuestion = optText(body.task_question, "task_question") || (intent ? intent.question : "");
    const content = {
      source: "layered_report",
      task_question: taskQuestion,
      actual_outcome: optText(body.actual_outcome, "actual_outcome"),
      execution_status: optText(body.execution_status, "execution_status") || attempt.status,
      important_findings: body.important_findings || [],
      material_conditions: body.material_conditions || [],
      contradictions: body.contradictions || [],
      significant_attempts: body.significant_attempts || [],
      unresolved_questions: body.unresolved_questions || [],
      blockers: body.blockers || [],
      prerequisite_changes: body.prerequisite_changes || [],
      proposed_next_actions: body.proposed_next_actions || [],
      evidence_refs: body.evidence_refs || [],
      full_record_pointer:
        optText(body.full_record_pointer, "full_record_pointer") ||
        `/sorne/worker-reports/${reportId}?layer=full_basis`,
      manifest: {
        id: manifestId,
        rule: manifest.rule,
        boundary: manifest.boundary,
        counts: manifest.counts,
        records: manifest.records,
        records_truncated: manifest.records_truncated,
        content_hash: manifest.content_hash,
        generated_at: now,
      },
    };
    db.prepare(
      `INSERT INTO worker_reports (id, project_id, intent_id, attempt_id, kind, replaces_report_id,
         base_report_id, source_manifest_id, source_commit_boundary, task_question, actual_outcome,
         execution_status, content, omitted_sections, delivery_status, handling_status,
         created_at, created_by, created_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'pending', ?, ?, ?)`,
    ).run(
      reportId,
      session.project_id,
      attempt.intent_id,
      attempt.id,
      body.kind,
      body.replaces_report_id ?? null,
      body.base_report_id ?? null,
      manifestId,
      String(boundary),
      content.task_question,
      content.actual_outcome,
      content.execution_status,
      JSON.stringify(content),
      JSON.stringify(body.omitted_sections || []),
      now,
      session.actor,
      commitSeq,
    );
    // worker_report.submitted（§6 目录；payload 以编号与计数为主，covered_record_ids
    // 供消费端按记录 ID 去重通知效果——§18.5 末段）
    const eventSeq = nextSeq(db, session.project_id, "event");
    const coveredRecordIds = manifest._judgement.map((j) => j.row.id).concat(
      manifest._toolCalls.filter((t) => t.status === "unknown").map((t) => t.id),
    );
    db.prepare(
      `INSERT INTO outbox (event_id, project_id, commit_seq, event_index, event_type, subject_ids,
         changed_fields, cause_refs, producer_id, schema_version, payload, delivery_status,
         delivery_attempts, created_at)
       VALUES (?, ?, ?, 1, 'worker_report.submitted', ?, '[]', ?, ?, 1, ?, 'pending', 0, ?)`,
    ).run(
      `EVT-${session.project_id}-${pad(eventSeq, 6)}`,
      session.project_id,
      commitSeq,
      JSON.stringify([reportId, attempt.intent_id, attempt.id]),
      JSON.stringify([body.submission_id]),
      session.actor,
      JSON.stringify({
        report_id: reportId,
        kind: body.kind,
        intent_id: attempt.intent_id,
        attempt_id: attempt.id,
        worker_id: attempt.worker_id,
        source_manifest_id: manifestId,
        source_commit_boundary: boundary,
        covered_record_ids: coveredRecordIds,
        manifest_counts: manifest.counts,
        omitted_types: (body.omitted_sections || []).map((o) => (o && o.type) || null),
        replaces_report_id: body.replaces_report_id ?? null,
        base_report_id: body.base_report_id ?? null,
        newer_records_since_boundary: newerCount,
      }),
      now,
    );
    const accepted = [{ op: "submit_worker_report", local_ref: null, id: reportId }];
    const receipt = {
      report_id: reportId,
      submission_id: body.submission_id,
      commit_seq: commitSeq,
      kind: body.kind,
      intent_id: attempt.intent_id,
      attempt_id: attempt.id,
      source_manifest_id: manifestId,
      source_commit_boundary: boundary,
      manifest_counts: manifest.counts,
      coverage_checked: true,
      newer_records_since_boundary: newerCount,
      delivery_status: "pending",
      handling_status: "pending",
      full_record_pointer: content.full_record_pointer,
      warnings,
      result_hash: null,
    };
    receipt.result_hash = sha256Hex(
      canonicalJson({
        report_id: receipt.report_id,
        submission_id: receipt.submission_id,
        commit_seq: receipt.commit_seq,
        manifest_id: manifestId,
        boundary,
      }),
    );
    db.prepare(
      `INSERT INTO submissions (id, project_id, submitter_id, request_digest, receipt, commit_seq,
         status, accepted_operations, warnings, result_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'committed', ?, ?, ?, ?)`,
    ).run(
      body.submission_id,
      session.project_id,
      session.actor,
      requestDigest,
      JSON.stringify(receipt),
      commitSeq,
      JSON.stringify(accepted),
      JSON.stringify(warnings),
      receipt.result_hash,
      now,
    );
    return receipt;
  });
}

/* ── 读取（GET /worker-reports/{id}，§18.3 三层） ─────────────────── */

function dbStatusOf(db, projectId, recordId) {
  const hit = locateJudgement(db, projectId, recordId);
  if (!hit) return { exists: false };
  return { exists: true, table: hit.table, status: hit.row.status ?? null, review: hit.row.review ?? null };
}

function findingsWithDbStatus(db, projectId, findings) {
  return (findings || []).map((f) => {
    const dbv = dbStatusOf(db, projectId, f.record_id);
    return {
      ...f,
      db: dbv,
      status_note: dbv.exists ? `状态以数据库为准（提交时声明 ${f.current_status}，当前 ${dbv.status ?? "（该类记录无状态列）"}）` : "引用记录已不存在",
    };
  });
}

/** 交接卡分组（§18.3 末段：分页、分组、展开入口；不删不确定性）。 */
function buildHandoffGroups(db, projectId, row, content) {
  const groups = [];
  const header = [
    `任务：${content.task_question || row.task_question || "（未提供）"}`,
    `实际完成：${content.actual_outcome || row.actual_outcome || "（未提供）"}`,
    `执行状态：${content.execution_status || row.execution_status || "（未提供）"}`,
  ];
  groups.push({ group_id: "header", type: "header", title: "交接卡", lines: header });
  const findings = findingsWithDbStatus(db, projectId, content.important_findings);
  const findingsLines = findings.map((f) => {
    const status = f.db.exists ? (f.db.status ?? "（该类记录无状态列）") : "记录不存在";
    return `${f.record_id}（${f.type}·当前状态 ${status}${f.db.exists && f.db.review ? `·复核 ${f.db.review}` : ""}）：${f.short_statement}`;
  });
  for (let i = 0; i < findingsLines.length; i += MAX_GROUP_ITEMS) {
    groups.push({
      group_id: `important_findings#${Math.floor(i / MAX_GROUP_ITEMS) + 1}`,
      type: "important_findings",
      title: `关键发现（第 ${Math.floor(i / MAX_GROUP_ITEMS) + 1}/${Math.ceil(findingsLines.length / MAX_GROUP_ITEMS) || 1} 组）`,
      lines: findingsLines.slice(i, i + MAX_GROUP_ITEMS),
    });
  }
  const section = (type, title, items, render) => {
    const list = (items || []).map(render);
    if (!list.length) {
      groups.push({ group_id: type, type, title, lines: ["（无）"] });
      return;
    }
    for (let i = 0; i < list.length; i += MAX_GROUP_ITEMS) {
      groups.push({
        group_id: list.length <= MAX_GROUP_ITEMS ? type : `${type}#${Math.floor(i / MAX_GROUP_ITEMS) + 1}`,
        type,
        title: list.length <= MAX_GROUP_ITEMS ? title : `${title}（第 ${Math.floor(i / MAX_GROUP_ITEMS) + 1}/${Math.ceil(list.length / MAX_GROUP_ITEMS)} 组）`,
        lines: list.slice(i, i + MAX_GROUP_ITEMS),
      });
    }
  };
  section("material_conditions", "重要条件（身份/参数/环境/时间，不得省略）", content.material_conditions, (c) =>
    typeof c === "string" ? c : JSON.stringify(c),
  );
  section("contradictions", "矛盾与反对证据", content.contradictions, (c) =>
    typeof c === "string" ? c : JSON.stringify(c),
  );
  section("significant_attempts", "重要尝试（含 unknown 与未终态调用）", content.significant_attempts, (a) =>
    typeof a === "string" ? a : JSON.stringify(a),
  );
  section("unresolved_questions", "未解决与未知项", content.unresolved_questions, (q) =>
    typeof q === "string" ? q : JSON.stringify(q),
  );
  section("blockers", "阻塞", content.blockers, (b) => (typeof b === "string" ? b : JSON.stringify(b)));
  section("decisions_needed", "需要的决策（worker 建议，非记录状态；§18.4 AI 建议单独标注）", content.proposed_next_actions, (a) =>
    typeof a === "string" ? a : JSON.stringify(a),
  );
  return groups;
}

function groupChars(group) {
  return group.lines.join("\n").length + group.title.length;
}

function paginateGroups(groups, { page, budget }) {
  const pages = [];
  let current = { groups: [], chars: 0 };
  for (const g of groups) {
    const size = groupChars(g);
    if (current.groups.length && current.chars + size > budget) {
      pages.push(current);
      current = { groups: [], chars: 0 };
    }
    current.groups.push(g);
    current.chars += size;
  }
  if (current.groups.length || pages.length === 0) pages.push(current);
  const idx = Math.min(Math.max(1, page), pages.length);
  const chosen = pages[idx - 1];
  const remainingAfter = pages.slice(idx).reduce((n, p) => n + p.groups.length, 0);
  return {
    page: idx,
    total_pages: pages.length,
    groups: chosen.groups,
    used_chars: chosen.chars,
    has_more: idx < pages.length,
    next_page: idx < pages.length ? idx + 1 : null,
    remaining_groups_after_this_page: remainingAfter,
  };
}

function boundaryView(db, projectId, row, manifest) {
  const latest = currentBoundary(db, projectId);
  const boundary = Number(row.source_commit_boundary) || 0;
  return {
    source_manifest_id: row.source_manifest_id,
    source_commit_boundary: boundary,
    latest_commit_seq: latest,
    note: "source_commit_boundary 判定本汇报时效；其后新提交的记录由后续增量通知覆盖，不以本汇报为最新（§18.3）",
  };
}

function baseView(db, projectId, baseRow) {
  const content = parseJsonField(baseRow.content, {});
  return {
    report_id: baseRow.id,
    kind: baseRow.kind,
    intent_id: baseRow.intent_id,
    attempt_id: baseRow.attempt_id,
    created_at: baseRow.created_at,
    handling_status: baseRow.handling_status,
    task_question: content.task_question ?? baseRow.task_question,
    actual_outcome: content.actual_outcome ?? baseRow.actual_outcome,
    important_findings: findingsWithDbStatus(db, projectId, content.important_findings),
    blockers: content.blockers || [],
    unresolved_questions: content.unresolved_questions || [],
    read_pointer: `/sorne/worker-reports/${baseRow.id}?layer=key_records`,
  };
}

/** 读取端点统一入口；viewer 供分层视图标注读取者可见性（不影响内容）。 */
export async function readWorkerReport(pctx, { reportId, layer = "handoff_card", page = 1, budget, includeBase = false }) {
  const store = await getStore(pctx);
  const db = store.db;
  const row = db.prepare("SELECT * FROM worker_reports WHERE id = ?").get(reportId);
  if (!row) {
    throw apiError("NOT_FOUND", `汇报不存在：${reportId}`);
  }
  const projectId = row.project_id;
  const content = parseJsonField(row.content, {});
  // C2 #25 进展行的降级视图（非分层汇报；同表共存，见 C2 竣工偏差 1）
  if (content.source === "attempt_progress") {
    return {
      report_id: row.id,
      kind: row.kind,
      intent_id: row.intent_id,
      attempt_id: row.attempt_id,
      created_at: row.created_at,
      created_by: row.created_by,
      source: "attempt_progress",
      note: "本行是执行进展记录（C2 #25），不是 E2 分层汇报；三层视图降级为通用呈现",
      layer,
      handoff_card: { lines: [content.note || "（无说明）"].filter(Boolean) },
      key_records: { condition_gaps: content.condition_gaps || [], late: Boolean(content.late), late_reason: content.late_reason || null, reported_by: content.reported_by || row.created_by },
      full_basis: { note: "执行过程与证据经 Attempt 视图（GET /attempts）与记录编号（GET /records/{id}）读取" },
      handling_status: row.handling_status,
      delivery_status: row.delivery_status,
    };
  }
  const manifestStored = content.manifest || null;
  const fresh = collectAttemptRecords(db, {
    projectId,
    attempt: db.prepare("SELECT * FROM attempts WHERE project_id = ? AND id = ?").get(projectId, row.attempt_id) || { id: row.attempt_id, intent_id: row.intent_id, worker_id: row.created_by, created_seq: 0 },
    boundary: Number(row.source_commit_boundary) || 0,
  });
  const base = { report_id: row.id, kind: row.kind, intent_id: row.intent_id, attempt_id: row.attempt_id, created_at: row.created_at, created_by: row.created_by, handling_status: row.handling_status, delivery_status: row.delivery_status, replaces_report_id: row.replaces_report_id, base_report_id: row.base_report_id };
  const result = { ...base, layer };
  // §18.6/§20.3 场景 31：有基线时默认附相对变化，接收方无须猜测上下文
  if (row.base_report_id) {
    const baseRow = db
      .prepare("SELECT * FROM worker_reports WHERE project_id = ? AND id = ?")
      .get(projectId, row.base_report_id);
    if (baseRow) {
      const refsOf = (r) => {
        const c = parseJsonField(r.content, {});
        return new Set([
          ...(c.important_findings || []).map((f) => f && f.record_id).filter(Boolean),
          ...(c.evidence_refs || []),
        ]);
      };
      const mine = refsOf(row);
      const baseRefs = refsOf(baseRow);
      result.relative_to_base = {
        base_report_id: baseRow.id,
        new_record_ids: [...mine].filter((x) => !baseRefs.has(x)),
        dropped_record_ids: [...baseRefs].filter((x) => !mine.has(x)),
        unchanged_record_ids: [...mine].filter((x) => baseRefs.has(x)),
        base_read_pointer: `/sorne/worker-reports/${baseRow.id}?layer=key_records`,
      };
    } else {
      result.relative_to_base = { base_report_id: row.base_report_id, missing: true };
    }
  }
  if (layer === "handoff_card") {
    const effBudget = Math.min(Math.max(budget || DEFAULT_HANDOFF_BUDGET, MIN_HANDOFF_BUDGET), MAX_HANDOFF_BUDGET);
    const groups = buildHandoffGroups(db, projectId, row, content);
    const pageView = paginateGroups(groups, { page, budget: effBudget });
    result.handoff_card = {
      ...pageView,
      budget: effBudget,
      total_groups: groups.length,
      pagination_note: "交接卡按可配置长度预算分组分页；任何条目不截断、不确定性与反对证据不删除（§18.3/§20.3 场景 28）",
      omitted_from_this_page: pageView.has_more
        ? [
            {
              type: "handoff_groups",
              count: pageView.remaining_groups_after_this_page,
              read_pointer: `/sorne/worker-reports/${row.id}?layer=handoff_card&page=${pageView.next_page}&budget=${effBudget}`,
            },
          ]
        : [],
      ai_note: "「需要的决策」为 worker 建议（AI 解释和建议单独标注，不能替代原记录状态，§18.4）",
      status_note: "关键发现的状态以数据库当前值渲染并附声明值（§18.4 事实状态从数据库读取并附带）",
    };
    result.boundary = boundaryView(db, projectId, row, manifestStored);
    return result;
  }
  if (layer === "key_records") {
    result.key_records = {
      task_question: content.task_question ?? row.task_question,
      actual_outcome: content.actual_outcome ?? row.actual_outcome,
      execution_status: content.execution_status ?? row.execution_status,
      important_findings: findingsWithDbStatus(db, projectId, content.important_findings),
      material_conditions: content.material_conditions || [],
      contradictions: content.contradictions || [],
      significant_attempts: content.significant_attempts || [],
      unresolved_questions: content.unresolved_questions || [],
      blockers: content.blockers || [],
      prerequisite_changes: content.prerequisite_changes || [],
      proposed_next_actions: (content.proposed_next_actions || []).map((a) => ({ advice: a, ai_advice: true })),
      omitted_sections: parseJsonField(row.omitted_sections, []),
      evidence_refs: content.evidence_refs || [],
      expand_pointer: `/sorne/worker-reports/${row.id}?layer=full_basis`,
    };
    result.boundary = boundaryView(db, projectId, row, manifestStored);
    if (includeBase && row.base_report_id) result.base_report = baseView(db, projectId, db.prepare("SELECT * FROM worker_reports WHERE project_id = ? AND id = ?").get(projectId, row.base_report_id));
    return result;
  }
  // full_basis（§18.3：执行记录、采集、请求响应、文件、验证结果）
  const readPointer = (kind, id) => {
    if (["observations", "hypotheses", "facts", "vulnerabilities", "assets", "relations"].includes(kind)) {
      return `/sorne/records/${id}?project_id=${projectId}`;
    }
    if (kind === "captures") return `/sorne/captures/${id}`;
    return null; // tool_calls / 进展行 / 汇报：本层内联呈现（无独立读取端点）
  };
  const manifestView = manifestStored
    ? {
        ...manifestStored,
        newer_records_since_boundary: Math.max(0, fresh.counts.total - (manifestStored.counts?.total ?? fresh.counts.total)),
        tool_calls: fresh._toolCalls.map((t) => ({ id: t.id, tool_name: t.tool_name, status: t.status, evidence_refs: parseJsonField(t.evidence_refs, []), read_pointer: readPointer("tool_calls", t.id) })),
        progress_rows: fresh._progressRows.map((p) => ({ id: p.id, kind: p.kind, note: p.content.note || "", read_pointer: readPointer("progress", p.id) })),
        judgement_records: fresh._judgement.map((j) => ({
          id: j.row.id,
          kind: j.table,
          status: j.row.status,
          review: j.row.review ?? null,
          read_pointer: readPointer(j.table, j.row.id),
        })),
        retract_edges: fresh._retractEdges.map((e) => ({ id: e.id, from: e.from_id, to: e.to_id, relation_type: e.relation_type, read_pointer: readPointer("relations", e.id) })),
      }
    : null;
  result.full_basis = {
    full_record_pointer: content.full_record_pointer || `/sorne/worker-reports/${row.id}?layer=full_basis`,
    evidence_refs: (content.evidence_refs || []).map((ref) => ({
      ref,
      read_pointer: refExists(db, projectId, ref)
        ? /^CAP-/.test(ref)
          ? `/sorne/captures/${ref}`
          : /^[a-f0-9]{64}$/.test(ref)
            ? `/sorne/evidence/blobs/${ref}`
            : `/sorne/records/${ref}?project_id=${projectId}`
        : null,
    })),
    manifest: manifestView,
    note: "完整依据层：执行记录/进展/判断记录在本层内联呈现；持久记录按编号经 #14 读取、采集经 #44、原始字节经 #43（§18.3 完整依据层）",
  };
  result.boundary = boundaryView(db, projectId, row, manifestStored);
  if (includeBase && row.base_report_id) {
    result.base_report = baseView(db, projectId, db.prepare("SELECT * FROM worker_reports WHERE project_id = ? AND id = ?").get(projectId, row.base_report_id));
  }
  return result;
}

export const __testables = { collectBodyRefs, omittedCovers, paginateGroups, buildHandoffGroups };
