/**
 * E1 —— Orchestrator 协调服务与决定持久化（规范 §3.1 §3.3 §16.1 §16.3 §16.4
 * §18.5(接收端) §18.6；蓝图端点 #31–#36）。
 *
 * 职责边界（§3.2：AI 决策，程序可靠执行）：
 *   - 程序只做规范交给程序的事：持久化协调决定与动作（独立幂等编号）、逐项核对
 *     动作实际完成情况、汇报回执的门控（决定持久化后才 handled）、资源用量/
 *     等待时长/重复尝试/验证积压等信息的供给、单规划在途与并行上限等明确约束；
 *   - 是否继续、追问、换方法、暂缓还是重规划，全部由 Orchestrator AI 以决定形式
 *     提交并持久保存（record_strategy 动作承载「继续/追问/换方法/暂缓/重规划」
 *     词汇），程序不写死任何重试流水线，也不因固定评分覆盖 AI 计划。
 *
 * 决定与动作（§3.3）：
 *   - 一次决定 = orchestration_decisions 一行（输入汇报/事件引用、简要理由、
 *     工具执行结果）+ orchestration_actions 若干行（每动作独立幂等编号，
 *     UNIQUE(project_id, idempotency_key)）；
 *   - 动作按序执行；单一动作失败不阻断其余动作（工具返回成功/冲突/受阻原因，
 *     AI 据结果继续调整）；每动作结果写回 status/result；
 *   - 重启后逐项核对：外部委托型动作（派发/生命周期/验证请求）先查实际效果
 *     （如 assignment 已有 Attempt），已完成的标记 reconciled 不重放；库内原子型
 *     动作（追问/上下文/回执/规划请求/限额/策略）的效果与状态同一事务提交，
 *     pending 即未发生，可安全执行（§20.3 场景 30）。
 *
 * 汇报接收闭环（§18.5）：
 *   - delivery ≠ 处理：worker_reports.handling_status 只在协调决定持久化并落
 *     report_receipts 后置 handled；仅送入上下文（delivered）不算已处理；
 *   - 读完汇报但保存决定前中断 → 汇报保持 pending，恢复后仍待处理（场景 29）。
 *
 * 工作面板（§18.6）：活跃计划、各意图最新状态、未处理汇报（含 base_report
 * 相对变化线索）、重要发现（状态以库为准）、待决事项（含中断待核对动作）、
 * 关键限制；旧汇报/旧决策留在持久记录，面板只用最新状态与引用。
 *
 * §16.1 唤醒与单规划在途：plan-requests 建立 plan_runs（in_flight）；同项目默认
 * 最多一个规划调用在途；陈旧 in_flight run 由核对流程标记 rejected（传输恢复
 * 不盲目重做业务决定）。§16.3 供给块随 overview 与 plan-requests 提供。
 */
import { apiError } from "../errors.mjs";
import { buildProjectContext, EVENT_SCHEMA_VERSION, getStore } from "./record-service.mjs";
import { attemptLifecycle, dispatchAttempt } from "./attempts.mjs";
import { receivePlanRevision } from "./intents.mjs";
import { requestVerification } from "./verification.mjs";
import { linkDecisionAndReplyInTx, linkRecordsToMessage } from "./messages.mjs";

/* ── 常量与词表 ───────────────────────────────────────────────────── */

/** §3.3/蓝图 §5.2 协调动作词表（程序可执行的操作语义面）。 */
export const DECISION_ACTION_KINDS = Object.freeze([
  "assign_execution", // 分配执行（经 C2 条件领取；assignment 句柄默认取幂等键）
  "suspend_execution", // 暂缓执行（保存原因与恢复条件，§3.3）
  "resume_execution", // 恢复执行
  "cancel_execution", // 取消执行
  "request_verification", // 请求独立验证（经 D1；不代替 verifier 确认）
  "request_planning", // 请求（重新）规划（建立 plan_runs，§16.1 单规划在途）
  "revise_intent", // 持久化修订现存意图（经 C1 receivePlanRevision op=revise，含版本推进与历史，§3.3/§10.1）
  "followup", // 追问 worker（关联原意图与汇报，§18.5 needs_clarification）
  "attach_context", // 补充任务上下文（持久记录引用 + 用途，不改事实状态）
  "handle_report", // 处理汇报（落回执；handled 门控见 §18.5）
  "set_execution_limits", // 设置并行上限（§16.3 支持 AI 设并行限制）
  "record_strategy", // 反复失败时的策略决定：继续/追问/换方法/暂缓/重规划（§16.3）
]);

/** §16.3「继续/追问/换方法/暂缓/重规划」词汇（仅持久化，无程序化流程语义）。 */
export const STRATEGY_CHOICES = Object.freeze([
  "continue",
  "ask",
  "switch_method",
  "defer",
  "replan",
]);

/** §11.2/DDL report_receipts.receipt_kind。 */
export const RECEIPT_KINDS = Object.freeze([
  "accepted",
  "needs_clarification",
  "deferred",
  "coordinated",
]);

/** 回执 → worker_reports.handling_status（§18.5：仅决定持久化后才允许 handled）。 */
const HANDLING_FOR_RECEIPT = Object.freeze({
  accepted: "handled",
  coordinated: "handled",
  needs_clarification: "needs_clarification",
  deferred: "deferred",
});

export const MAX_ACTIONS_PER_DECISION = 16;
export const MAX_RECORD_REFS = 32;
/** 并行上限的硬顶（§3.2：程序校验资源上限；上限本身由 AI/用户调整）。 */
export const MAX_PARALLEL_ATTEMPTS_LIMIT = 64;
/** 陈旧 in_flight 规划 run 的清扫窗口（§16.1 传输恢复；F2 可覆写参数）。 */
export const DEFAULT_PLAN_RUN_STALE_MS = 30 * 60 * 1000;

const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DECISION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const INTENT_STATUS_TEXT = Object.freeze({
  proposed: "已提议",
  queued: "已入队",
  running: "执行中",
  resolved: "已解决",
  blocked: "受阻",
  awaiting_review: "待复核",
  deferred: "已暂缓",
  obsolete: "已废弃",
  cancelled: "已取消",
});

const PROJECT_STATUS_TEXT = Object.freeze({
  active: "运行中",
  waiting_for_change: "等待条件变化",
  paused: "已暂停",
  stopped: "已停止",
});

const REPORT_KIND_TEXT = Object.freeze({
  progress: "进展",
  handoff: "交接",
  blocked: "受阻",
  completion: "完成汇报",
});

const RECEIPT_KIND_TEXT = Object.freeze({
  accepted: "接受交接",
  needs_clarification: "需要补充",
  deferred: "明确暂缓",
  coordinated: "已作协调处理",
});

/** 编号可解析的物理表全集（多态引用存在性校验；§6.2 表集合）。 */
const REF_TABLES = Object.freeze([
  "intents",
  "attempts",
  "tool_calls",
  "observations",
  "hypotheses",
  "facts",
  "vulnerabilities",
  "assets",
  "resources",
  "relations",
  "captures",
  "blobs",
  "transforms",
  "verification_jobs",
  "verification_results",
  "evidence_manifests",
  "evidence_memberships",
  "worker_reports",
  "orchestration_decisions",
  "orchestration_actions",
  "report_receipts",
  "plan_runs",
  "plan_revisions",
  "snapshots",
  "checkpoints",
  "goals",
  "endpoint_templates",
  "memberships",
  "candidate_groups",
  "report_revisions",
  "scope_revisions",
]);

/* ── 基础工具（与 A1/C2 同法：事务内分配编号与 commit_seq） ────────── */

function nowIso() {
  return new Date().toISOString();
}

function parseJson(text, fallback) {
  if (text === undefined || text === null || text === "") return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function truncate(text, max = 160) {
  const s = String(text ?? "");
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

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

function formatSeqId(prefix, projectId, n, width = 4) {
  return `${prefix}-${projectId}-${String(n).padStart(width, "0")}`;
}

function allocateCommitSeq(db, projectId) {
  const row = db.prepare("SELECT next_commit_seq AS n FROM projects WHERE id = ?").get(projectId);
  db.prepare("UPDATE projects SET next_commit_seq = ? WHERE id = ?").run(row.n + 1, projectId);
  return row.n;
}

function emitEvent(
  db,
  { projectId, commitSeq, eventType, subjectIds, changedFields, causeRefs, producerId, payload, now },
) {
  const n = allocateSeq(db, projectId, "event");
  db.prepare(
    `INSERT INTO outbox (event_id, project_id, commit_seq, event_index, event_type, subject_ids,
       changed_fields, cause_refs, producer_id, schema_version, payload, delivery_status,
       delivery_attempts, created_at)
     VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)`,
  ).run(
    `EVT-${projectId}-${String(n).padStart(6, "0")}`,
    projectId,
    commitSeq,
    eventType,
    JSON.stringify(subjectIds ?? []),
    JSON.stringify(changedFields ?? []),
    JSON.stringify(causeRefs?.length ? causeRefs : ["orchestrator"]),
    producerId || "orchestrator",
    EVENT_SCHEMA_VERSION,
    JSON.stringify(payload ?? {}),
    now,
  );
}

/** 多态引用存在性（§6.2：Record Service 校验存在性；本模块面向全表编号）。 */
function locateAnyRecord(db, projectId, ref) {
  if (typeof ref !== "string" || !ref.trim()) return null;
  if (REF_TABLES.some((table) => Boolean(
    db.prepare(`SELECT 1 FROM ${table} WHERE id = ? AND project_id = ?`).get(ref, projectId),
  ))) {
    return { ref };
  }
  return null;
}

function requireRecord(db, projectId, ref, what) {
  if (!locateAnyRecord(db, projectId, ref)) {
    throw apiError("INVALID_REFERENCE", `${what} 引用的记录在本项目不存在：${ref}`, {
      detail: { field: what, value: ref },
      next_requirements: ["改用本项目已存在的持久记录编号（可经 GET /sorne/records/{id} 核对）"],
    });
  }
}

/* ── 视图 ─────────────────────────────────────────────────────────── */

function actionView(row) {
  return {
    id: row.id,
    decision_id: row.decision_id,
    action_kind: row.action_kind,
    idempotency_key: row.idempotency_key,
    payload: parseJson(row.payload, {}),
    status: row.status,
    status_text:
      row.status === "executed"
        ? "已执行"
        : row.status === "failed"
          ? "执行失败"
          : row.status === "skipped"
            ? "已跳过"
            : "待执行",
    result: parseJson(row.result, null),
    created_at: row.created_at,
    updated_seq: row.updated_seq,
  };
}

function decisionView(db, row, { withActions = true } = {}) {
  const view = {
    id: row.id,
    project_id: row.project_id,
    input_report_ids: parseJson(row.input_report_ids, []),
    input_event_refs: parseJson(row.input_event_refs, []),
    rationale: row.rationale,
    tool_result: parseJson(row.tool_result, null),
    created_at: row.created_at,
    created_by: row.created_by,
    commit_seq: row.created_seq,
  };
  if (withActions) {
    view.actions = db
      .prepare("SELECT * FROM orchestration_actions WHERE decision_id = ? ORDER BY created_seq, id")
      .all(row.id)
      .map(actionView);
  }
  return view;
}

function receiptView(row) {
  return {
    id: row.id,
    report_id: row.report_id,
    receipt_kind: row.receipt_kind,
    receipt_kind_text: RECEIPT_KIND_TEXT[row.receipt_kind] || row.receipt_kind,
    followup_ref: row.followup_ref || "",
    decision_id: row.decision_id || null,
    created_at: row.created_at,
    created_by: row.created_by,
  };
}

/* ── 动作词表校验（记录期形状校验；执行期仍防御性复核） ───────────── */

function reqString(payload, field, what, { max = 2000 } = {}) {
  const v = payload[field];
  if (typeof v !== "string" || !v.trim() || v.length > max) {
    throw apiError("BAD_REQUEST", `${what} 的 ${field} 必填（非空、≤${max} 字）`);
  }
  return v.trim();
}

function strArrayField(payload, field, what, { max = MAX_RECORD_REFS } = {}) {
  const v = payload[field];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > max) {
    throw apiError("BAD_REQUEST", `${what} 的 ${field} 必须是数组（≤${max} 项）`);
  }
  for (const item of v) {
    if (typeof item !== "string" || !item.trim()) {
      throw apiError("BAD_REQUEST", `${what} 的 ${field} 每项必须是非空字符串`);
    }
  }
  return v.map((s) => s.trim());
}

/**
 * 记录期动作形状校验（含廉价的存在性校验；状态类校验留给执行期，
 * 因为记录与执行（或重启核对）之间库内状态可能变化，失败以动作结果承载）。
 */
function validateActionPayload(db, projectId, kind, payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw apiError("BAD_REQUEST", `动作 ${kind} 的 payload 必须是 JSON 对象`);
  }
  switch (kind) {
    case "assign_execution": {
      reqString(payload, "intent_id", "assign_execution", { max: 128 });
      reqString(payload, "worker_id", "assign_execution", { max: 128 });
      // 阶段 1 职责边界（§3.1/§3.3）：assign_execution 仅分配已持久化的意图，禁止在派发时静默改写意图问题、目标资产、完成条件或假设。
      const forbiddenRewriteFields = [
        "question",
        "target_asset_ids",
        "success_criteria",
        "deliverables",
        "hypothesis_id",
        "goal_id",
        "kind",
        "rationale",
      ].filter((k) => payload[k] !== undefined && payload[k] !== null);
      if (forbiddenRewriteFields.length > 0) {
        throw apiError(
          "PRECONDITION_INVALID",
          `assign_execution 仅负责分配已持久化的意图，不得静默改写意图字段（${forbiddenRewriteFields.join("、")}）；如需调整意图请使用 revise_intent 持久化修订或 request_planning 请求重新规划（§3.1/§3.3）`,
          {
            detail: { intent_id: payload.intent_id, forbidden_fields: forbiddenRewriteFields },
            next_requirements: [
              "先提交 revise_intent 动作持久化意图修订（含版本推进与历史记录），或提交 request_planning 由 Planner 重新规划，再执行 assign_execution",
            ],
          },
        );
      }
      if (payload.assignment_id !== undefined && payload.assignment_id !== null) {
        reqString(payload, "assignment_id", "assign_execution", { max: 128 });
      }
      if (
        payload.lease_ttl_ms !== undefined &&
        payload.lease_ttl_ms !== null &&
        (!Number.isInteger(payload.lease_ttl_ms) || payload.lease_ttl_ms <= 0)
      ) {
        throw apiError("BAD_REQUEST", "assign_execution 的 lease_ttl_ms 必须是正整数毫秒");
      }
      if (!locateAnyRecord(db, projectId, payload.intent_id)) {
        throw apiError("INVALID_REFERENCE", `assign_execution 的 intent_id 不存在：${payload.intent_id}`, {
          next_requirements: ["意图需先经 POST /sorne/plan-revisions 建立"],
        });
      }
      break;
    }
    case "revise_intent": {
      reqString(payload, "intent_id", "revise_intent", { max: 128 });
      const intentRow = db
        .prepare("SELECT id, state_version FROM intents WHERE project_id = ? AND id = ?")
        .get(projectId, payload.intent_id);
      if (!intentRow) {
        throw apiError("INVALID_REFERENCE", `revise_intent 的 intent_id 不存在：${payload.intent_id}`, {
          next_requirements: ["意图需先经 POST /sorne/plan-revisions 建立"],
        });
      }
      if (
        payload.expected_state_version !== undefined &&
        payload.expected_state_version !== null &&
        (!Number.isInteger(payload.expected_state_version) || payload.expected_state_version < 1)
      ) {
        throw apiError("BAD_REQUEST", "revise_intent 的 expected_state_version 必须是正整数");
      }
      const revisableFields = [
        "question",
        "rationale",
        "kind",
        "success_criteria",
        "target_asset_ids",
        "basis_refs",
        "prerequisite_refs",
        "condition_requirements",
        "deliverables",
        "priority",
        "budget",
        "resume_conditions",
        "goal_id",
      ];
      const hasAnyField = revisableFields.some((k) => payload[k] !== undefined && payload[k] !== null);
      if (!hasAnyField) {
        throw apiError(
          "BAD_REQUEST",
          `revise_intent 至少需提供一个待修订的意图字段（${revisableFields.join(" / ")}）`,
        );
      }
      break;
    }
    case "suspend_execution":
    case "resume_execution":
    case "cancel_execution": {
      reqString(payload, "attempt_id", kind, { max: 128 });
      const row = db
        .prepare("SELECT 1 FROM attempts WHERE project_id = ? AND id = ?")
        .get(projectId, payload.attempt_id);
      if (!row) {
        throw apiError("INVALID_REFERENCE", `${kind} 的 attempt_id 不存在：${payload.attempt_id}`);
      }
      strArrayField(payload, "resume_conditions", kind, { max: 16 });
      break;
    }
    case "request_verification": {
      // 五要素交由 D1 requestVerification 校验（存在性/策略注册/证据引用）；
      // 这里只做它要求的最小形状，避免重复实现验证准入词表。
      reqString(payload, "subject_id", "request_verification", { max: 128 });
      reqString(payload, "policy_id", "request_verification", { max: 128 });
      reqString(payload, "policy_version", "request_verification", { max: 128 });
      break;
    }
    case "request_planning": {
      reqString(payload, "question", "request_planning");
      strArrayField(payload, "record_refs", "request_planning");
      break;
    }
    case "followup": {
      reqString(payload, "attempt_id", "followup", { max: 128 });
      reqString(payload, "question", "followup");
      const row = db
        .prepare("SELECT 1 FROM attempts WHERE project_id = ? AND id = ?")
        .get(projectId, payload.attempt_id);
      if (!row) {
        throw apiError("INVALID_REFERENCE", `followup 的 attempt_id 不存在：${payload.attempt_id}`);
      }
      if (payload.report_id !== undefined && payload.report_id !== null) {
        const rep = db
          .prepare("SELECT 1 FROM worker_reports WHERE project_id = ? AND id = ?")
          .get(projectId, payload.report_id);
        if (!rep) {
          throw apiError("INVALID_REFERENCE", `followup 的 report_id 不存在：${payload.report_id}`);
        }
      }
      strArrayField(payload, "gap_refs", "followup");
      break;
    }
    case "attach_context": {
      reqString(payload, "attempt_id", "attach_context", { max: 128 });
      reqString(payload, "purpose", "attach_context", { max: 500 });
      const refs = strArrayField(payload, "record_refs", "attach_context");
      if (refs.length === 0) {
        throw apiError("BAD_REQUEST", "attach_context 的 record_refs 不能为空（要交给任务的持久记录）");
      }
      const row = db
        .prepare("SELECT 1 FROM attempts WHERE project_id = ? AND id = ?")
        .get(projectId, payload.attempt_id);
      if (!row) {
        throw apiError("INVALID_REFERENCE", `attach_context 的 attempt_id 不存在：${payload.attempt_id}`);
      }
      for (const ref of refs) requireRecord(db, projectId, ref, "attach_context.record_refs");
      break;
    }
    case "handle_report": {
      reqString(payload, "report_id", "handle_report", { max: 128 });
      if (!RECEIPT_KINDS.includes(payload.receipt_kind)) {
        throw apiError("BAD_REQUEST", `handle_report 的 receipt_kind 允许：${RECEIPT_KINDS.join("、")}`);
      }
      const rep = db
        .prepare("SELECT 1 FROM worker_reports WHERE project_id = ? AND id = ?")
        .get(projectId, payload.report_id);
      if (!rep) {
        throw apiError("INVALID_REFERENCE", `handle_report 的 report_id 不存在：${payload.report_id}`);
      }
      if (payload.receipt_kind === "deferred" && !(typeof payload.note === "string" && payload.note.trim())) {
        throw apiError("BAD_REQUEST", "handle_report 暂缓必须携带 note（明确暂缓原因，§3.3）");
      }
      break;
    }
    case "set_execution_limits": {
      if (!Number.isInteger(payload.max_active_attempts) || payload.max_active_attempts < 1) {
        throw apiError("BAD_REQUEST", "set_execution_limits 的 max_active_attempts 必须是 ≥1 的整数");
      }
      if (payload.max_active_attempts > MAX_PARALLEL_ATTEMPTS_LIMIT) {
        throw apiError("RESOURCE_LIMIT", `并行上限不可超过硬顶 ${MAX_PARALLEL_ATTEMPTS_LIMIT}`, {
          detail: { requested: payload.max_active_attempts, hard_limit: MAX_PARALLEL_ATTEMPTS_LIMIT },
        });
      }
      break;
    }
    case "record_strategy": {
      if (!STRATEGY_CHOICES.includes(payload.strategy)) {
        throw apiError(
          "BAD_REQUEST",
          `record_strategy 的 strategy 允许：${STRATEGY_CHOICES.join("、")}（§16.3 继续/追问/换方法/暂缓/重规划）`,
        );
      }
      reqString(payload, "reason", "record_strategy");
      strArrayField(payload, "resume_conditions", "record_strategy", { max: 16 });
      strArrayField(payload, "related_refs", "record_strategy");
      break;
    }
    default:
      throw apiError("BAD_REQUEST", `未知动作类型：${kind}（允许：${DECISION_ACTION_KINDS.join("、")}）`);
  }
}

/* ── 动作执行：逐项核对 + 委托/原子两类（§3.3 / 场景 30） ──────────── */

/** assign_execution 的稳定分配句柄：默认取动作幂等键（重启核对可据此查 Attempt）。 */
function assignmentHandle(payload, action) {
  const explicit = typeof payload.assignment_id === "string" ? payload.assignment_id.trim() : "";
  return explicit || action.idempotency_key;
}

/** 外部委托型动作的「实际完成情况」核对（重启后先核对，不盲目重放）。 */
function verifyDelegatedEffect(db, projectId, kind, payload, action) {
  switch (kind) {
    case "assign_execution": {
      const handle = assignmentHandle(payload, action);
      const row = db
        .prepare(
          "SELECT id, status, worker_id, intent_id FROM attempts WHERE project_id = ? AND assignment_id = ? ORDER BY created_seq LIMIT 1",
        )
        .get(projectId, handle);
      return row
        ? { attempt_id: row.id, attempt_status: row.status, worker_id: row.worker_id, assignment_id: handle }
        : null;
    }
    case "suspend_execution": {
      const row = db
        .prepare("SELECT status FROM attempts WHERE project_id = ? AND id = ?")
        .get(projectId, payload.attempt_id);
      if (!row) return null;
      return row.status === "suspended" ? { attempt_id: payload.attempt_id, status: row.status } : null;
    }
    case "resume_execution": {
      const row = db
        .prepare("SELECT status FROM attempts WHERE project_id = ? AND id = ?")
        .get(projectId, payload.attempt_id);
      if (!row) return null;
      return ["leased", "running"].includes(row.status)
        ? { attempt_id: payload.attempt_id, status: row.status }
        : null;
    }
    case "cancel_execution": {
      const row = db
        .prepare("SELECT status FROM attempts WHERE project_id = ? AND id = ?")
        .get(projectId, payload.attempt_id);
      if (!row) return null;
      return ["cancelled", "completed", "failed", "interrupted"].includes(row.status)
        ? { attempt_id: payload.attempt_id, status: row.status }
        : null;
    }
    case "revise_intent": {
      const subId = `ORCH-REV-${action.decision_id}-${action.id}`;
      const subRow = db
        .prepare("SELECT receipt FROM submissions WHERE project_id = ? AND id = ? LIMIT 1")
        .get(projectId, subId);
      if (!subRow || !subRow.receipt) return null;
      let receipt = {};
      try {
        receipt = JSON.parse(subRow.receipt) || {};
      } catch {
        receipt = {};
      }
      return {
        plan_revision_id: receipt.plan_revision_id ?? null,
        revision: receipt.revision ?? null,
        received_status: receipt.received_status ?? "accepted",
        intent_id: payload.intent_id,
      };
    }
    default:
      return null;
  }
}

/** 库内原子型动作：效果与动作状态同一事务（pending 即未发生，可安全执行）。 */
function applyAtomicAction(db, { projectId, actor, decision, action, payload, now }) {
  const commitSeq = allocateCommitSeq(db, projectId);
  let result;
  switch (action.action_kind) {
    case "request_planning": {
      const inFlight = db
        .prepare("SELECT id, created_at FROM plan_runs WHERE project_id = ? AND status IN ('pending','in_flight')")
        .get(projectId);
      if (inFlight) {
        throw apiError(
          "PRECONDITION_INVALID",
          `规划调用已在途（plan_run ${inFlight.id}），同项目默认最多一个规划调用在途（§16.1）`,
          {
            retryable: false,
            detail: { in_flight_plan_run_id: inFlight.id, created_at: inFlight.created_at },
            next_requirements: ["等待 planner 经 POST /sorne/plan-revisions 提交该 run 的计划，或待核对流程将其标记 rejected 后重新请求"],
          },
        );
      }
      const boundary = db.prepare("SELECT next_commit_seq AS n FROM projects WHERE id = ?").get(projectId).n - 1;
      const planRunId = formatSeqId("PR", projectId, allocateSeq(db, projectId, "plan_run"));
      db.prepare(
        `INSERT INTO plan_runs (id, project_id, input_snapshot_id, input_boundary, status,
           created_at, created_by, created_seq, updated_seq, state_version)
         VALUES (?, ?, NULL, ?, 'in_flight', ?, ?, ?, ?, 1)`,
      ).run(planRunId, projectId, String(boundary), now, actor, commitSeq, commitSeq);
      result = {
        plan_run_id: planRunId,
        question: payload.question,
        record_refs: payload.record_refs ?? [],
        changes: payload.changes ?? [],
        urgency: payload.urgency ?? "",
        input_boundary: String(boundary),
        note: "规划请求已建立 in_flight；planner 以 plan_run_id 提交计划（POST /sorne/plan-revisions）",
      };
      break;
    }
    case "followup": {
      emitEvent(db, {
        projectId,
        commitSeq,
        eventType: "orchestration.decision_recorded",
        subjectIds: [payload.attempt_id, ...(payload.report_id ? [payload.report_id] : [])],
        changedFields: [],
        causeRefs: [action.id, decision.id],
        producerId: actor,
        payload: {
          kind: "followup",
          action_id: action.id,
          decision_id: decision.id,
          attempt_id: payload.attempt_id,
          question: payload.question,
          report_id: payload.report_id ?? null,
          gap_refs: payload.gap_refs ?? [],
          note: payload.note ?? "",
        },
        now,
      });
      result = {
        delivered_to_attempt: payload.attempt_id,
        question: payload.question,
        followup_ref: action.id,
        note: "追问已随事件投递到该 Attempt 的关注订阅；汇报回执可用此 followup_ref 关联（§18.5 needs_clarification）",
      };
      break;
    }
    case "attach_context": {
      const refs = payload.record_refs ?? [];
      emitEvent(db, {
        projectId,
        commitSeq,
        eventType: "orchestration.decision_recorded",
        subjectIds: [payload.attempt_id, ...refs],
        changedFields: [],
        causeRefs: [action.id, decision.id],
        producerId: actor,
        payload: {
          kind: "context_attached",
          action_id: action.id,
          decision_id: decision.id,
          attempt_id: payload.attempt_id,
          record_refs: refs,
          purpose: payload.purpose,
          note: payload.note ?? "",
        },
        now,
      });
      result = {
        delivered_to_attempt: payload.attempt_id,
        record_refs: refs,
        purpose: payload.purpose,
        note: "持久记录引用已交给该任务（不改事实状态，§3.3）；worker 可按编号经 GET /sorne/records/{id} 展开",
      };
      break;
    }
    case "handle_report": {
      const kind = payload.receipt_kind;
      const receiptId = formatSeqId("RR", projectId, allocateSeq(db, projectId, "report_receipt"));
      db.prepare(
        `INSERT INTO report_receipts (id, project_id, report_id, receipt_kind, followup_ref,
           decision_id, created_at, created_by, created_seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        receiptId,
        projectId,
        payload.report_id,
        kind,
        typeof payload.followup_ref === "string" ? payload.followup_ref : "",
        decision.id,
        now,
        actor,
        commitSeq,
      );
      const handling = HANDLING_FOR_RECEIPT[kind];
      db.prepare("UPDATE worker_reports SET handling_status = ? WHERE project_id = ? AND id = ?").run(
        handling,
        projectId,
        payload.report_id,
      );
      result = {
        report_id: payload.report_id,
        receipt_kind: kind,
        receipt_id: receiptId,
        handling_status: handling,
        note: payload.note ?? "",
      };
      break;
    }
    case "set_execution_limits": {
      const project = db.prepare("SELECT resource_policy FROM projects WHERE id = ?").get(projectId);
      const policy = parseJson(project.resource_policy, {});
      const previous = Number.isInteger(policy.max_active_attempts) ? policy.max_active_attempts : null;
      policy.max_active_attempts = payload.max_active_attempts;
      db.prepare("UPDATE projects SET resource_policy = ? WHERE id = ?").run(
        JSON.stringify(policy),
        projectId,
      );
      emitEvent(db, {
        projectId,
        commitSeq,
        eventType: "resource_state.changed",
        subjectIds: [projectId],
        changedFields: ["resource_policy.max_active_attempts"],
        causeRefs: [action.id, decision.id],
        producerId: actor,
        payload: {
          kind: "execution_limits_set",
          max_active_attempts: payload.max_active_attempts,
          previous,
          decision_id: decision.id,
        },
        now,
      });
      result = {
        max_active_attempts: payload.max_active_attempts,
        previous,
        note: "并行上限立即对后续派发生效（C2 派发面按 resource_policy.max_active_attempts 校验）",
      };
      break;
    }
    case "record_strategy": {
      // 纯持久化动作：反复失败时 AI 的「继续/追问/换方法/暂缓/重规划」决定与
      // 理由、恢复条件入库；程序不据此自动执行任何流程（§16.3 不写死流水线）。
      result = {
        strategy: payload.strategy,
        reason: payload.reason,
        resume_conditions: payload.resume_conditions ?? [],
        related_refs: payload.related_refs ?? [],
        note: "策略决定已持久化；后续动作（追问/暂缓/重规划等）由 AI 以对应动作类型显式提交",
      };
      break;
    }
    default:
      throw apiError("BAD_REQUEST", `动作类型 ${action.action_kind} 不是原子型，不应进入此路径`);
  }
  return { result, commitSeq };
}

/** 委托型动作的执行（各自模块的真实事务；效果+状态两段由核对谓词兜底）。 */
async function applyDelegatedAction(pctx, { projectId, actor, decision, action, payload }) {
  // 程序代行 AI 已提交的决定：执行运行时执行分配/生命周期（§3 Execution Runtime
  // 「执行 AI 已提交的分配决定」）；验证请求以 orchestrator 身份发起（§8.3(3)）。
  const execSession = { project_id: projectId, actor, role: "runtime" };
  switch (action.action_kind) {
    case "assign_execution": {
      const out = await dispatchAttempt(pctx, {
        session: execSession,
        intentId: payload.intent_id,
        assignmentId: assignmentHandle(payload, action),
        workerId: payload.worker_id,
        leaseTtlMs: payload.lease_ttl_ms,
        handoffSummary: payload.handoff_summary,
      });
      return {
        attempt_id: out.attempt.id,
        assignment_id: out.assignment_id,
        fencing_token: out.fencing_token,
        lease_expires_at: out.lease_expires_at,
        idempotent: Boolean(out.idempotent),
        warnings: out.warnings ?? [],
        note: "分配经执行运行时条件领取（租约与 fencing token 由 C2 维护）",
      };
    }
    case "suspend_execution":
    case "resume_execution":
    case "cancel_execution": {
      const lifecycleAction = action.action_kind === "suspend_execution"
        ? "suspend"
        : action.action_kind === "resume_execution"
          ? "resume"
          : "cancel";
      const out = await attemptLifecycle(pctx, {
        session: execSession,
        attemptId: payload.attempt_id,
        action: lifecycleAction,
        reason: payload.reason,
        resumeConditions: payload.resume_conditions,
        leaseTtlMs: payload.lease_ttl_ms,
      });
      return {
        attempt_id: out.attempt.id,
        status: out.attempt.status,
        note: `生命周期动作 ${lifecycleAction} 已由程序实施（原因与恢复条件随决定持久化）`,
      };
    }
    case "request_verification": {
      const input = { ...payload };
      delete input.note;
      const out = await requestVerification(pctx, {
        session: { project_id: projectId, actor, role: "orchestrator" },
        input,
      });
      return {
        job_id: out.job.id,
        deduplicated: Boolean(out.deduplicated),
        ...(out.deduplicated
          ? { note: `验证任务已存在（D1 §7.3 去重键吸收重放）：${out.note ?? ""}` }
          : { note: "独立验证任务已建立；verifier 确认不受本决定替代（§3.3）" }),
      };
    }
    case "revise_intent": {
      const store = await getStore(pctx);
      const currentRow = store.db
        .prepare("SELECT state_version FROM intents WHERE project_id = ? AND id = ?")
        .get(projectId, payload.intent_id);
      if (!currentRow) {
        throw apiError("INVALID_REFERENCE", `待修订的意图不存在：${payload.intent_id}`);
      }
      const expectedVersion =
        payload.expected_state_version !== undefined && payload.expected_state_version !== null
          ? payload.expected_state_version
          : currentRow.state_version;
      const reviseOp = {
        op: "revise",
        intent_id: payload.intent_id,
        expected_state_version: expectedVersion,
      };
      for (const k of [
        "question",
        "rationale",
        "kind",
        "success_criteria",
        "target_asset_ids",
        "basis_refs",
        "prerequisite_refs",
        "condition_requirements",
        "deliverables",
        "priority",
        "budget",
        "resume_conditions",
        "goal_id",
      ]) {
        if (payload[k] !== undefined && payload[k] !== null) {
          reviseOp[k] = payload[k];
        }
      }
      const submissionId = `ORCH-REV-${decision.id}-${action.id}`;
      const planRevision =
        typeof payload.plan_revision === "string" && payload.plan_revision.trim()
          ? payload.plan_revision.trim()
          : `orch-rev-${action.id}`;
      const out = await receivePlanRevision(pctx, {
        session: { project_id: projectId, actor, role: "planner" },
        envelope: {
          submission_id: submissionId,
          plan_revision: planRevision,
          rationale: payload.rationale || decision.rationale || "协调者持久化修订意图",
          intents: [reviseOp],
        },
      });
      if (Array.isArray(out.rejected) && out.rejected.length > 0) {
        const first = out.rejected[0];
        throw apiError(
          first.code || "PRECONDITION_INVALID",
          first.reason || `意图修订被拒绝：${payload.intent_id}`,
          { detail: first.detail || first },
        );
      }
      const updated = store.db
        .prepare("SELECT state_version, plan_revision, question, success_criteria, target_asset_ids FROM intents WHERE project_id = ? AND id = ?")
        .get(projectId, payload.intent_id);
      return {
        intent_id: payload.intent_id,
        plan_revision_id: out.plan_revision_id,
        plan_revision: out.plan_revision,
        received_status: out.received_status,
        state_version: updated ? updated.state_version : expectedVersion + 1,
        note: "意图已通过持久化计划修订更新（state_version 递增并写入历史，§3.3/§10.1）",
      };
    }
    default:
      throw apiError("BAD_REQUEST", `动作类型 ${action.action_kind} 不是委托型`);
  }
}

const DELEGATED_KINDS = new Set([
  "assign_execution",
  "suspend_execution",
  "resume_execution",
  "cancel_execution",
  "request_verification",
  "revise_intent",
]);

/**
 * 执行单个动作：先核对实际完成情况（已完成的标记 reconciled 不重放），
 * 再执行并写回状态/结果。返回动作视图；动作自身失败以 status=failed 落库，
 * 不中断决定内其余动作（§3.3 工具返回受阻原因，AI 继续调整）。
 */
async function executeDecisionAction(pctx, { decision, action }) {
  const store = await getStore(pctx);
  const projectId = decision.project_id;
  const actor = decision.created_by;
  const payload = parseJson(action.payload, {});

  // 幂等：动作已终态则原样返回（并发/重复核对）。
  if (action.status !== "pending") return actionView(action);

  try {
    if (DELEGATED_KINDS.has(action.action_kind)) {
      // ① 核对实际完成情况（场景 30：重启逐项核对，不盲目重放）
      const evidence = await store.runSerial((db) =>
        verifyDelegatedEffect(db, projectId, action.action_kind, payload, action),
      );
      if (evidence) {
        return await store.runSerial((db) => {
          const commitSeq = allocateCommitSeq(db, projectId);
          const result = {
            reconciled: true,
            evidence,
            note: "核对发现动作效果已实际完成（重启恢复逐项核对，未重放，§3.3/§20.3 场景 30）",
          };
          db.prepare(
            "UPDATE orchestration_actions SET status = 'executed', result = ?, updated_seq = ? WHERE id = ?",
          ).run(JSON.stringify(result), commitSeq, action.id);
          return actionView(
            db.prepare("SELECT * FROM orchestration_actions WHERE id = ?").get(action.id),
          );
        });
      }
      // ② 执行（委托模块的真实事务）
      const result = await applyDelegatedAction(pctx, { projectId, actor, decision, action, payload });
      return await store.runSerial((db) => {
        const commitSeq = allocateCommitSeq(db, projectId);
        db.prepare(
          "UPDATE orchestration_actions SET status = 'executed', result = ?, updated_seq = ? WHERE id = ?",
        ).run(JSON.stringify(result), commitSeq, action.id);
        return actionView(
          db.prepare("SELECT * FROM orchestration_actions WHERE id = ?").get(action.id),
        );
      });
    }

    // 原子型：效果与状态同一事务（pending 即未发生）
    return await store.runSerial((db) => {
      const now = nowIso();
      const { result, commitSeq } = applyAtomicAction(db, {
        projectId,
        actor,
        decision,
        action,
        payload,
        now,
      });
      db.prepare(
        "UPDATE orchestration_actions SET status = 'executed', result = ?, updated_seq = ? WHERE id = ?",
      ).run(JSON.stringify(result), commitSeq, action.id);
      return actionView(
        db.prepare("SELECT * FROM orchestration_actions WHERE id = ?").get(action.id),
      );
    });
  } catch (error) {
    // 动作级失败落库（含核对/执行中的 PRECONDITION_INVALID 等），决定继续；
    // 错误信封要件（detail/next_requirements）随结果保存，供工具面原样转达（§20.1）
    const info = error && error.code
      ? {
          code: error.code,
          message: error.message,
          retryable: Boolean(error.retryable),
          ...(error.extra && error.extra.detail !== undefined ? { detail: error.extra.detail } : {}),
          ...(error.extra && Array.isArray(error.extra.next_requirements)
            ? { next_requirements: error.extra.next_requirements }
            : {}),
        }
      : { code: "INTERNAL_ERROR", message: error?.message ?? String(error), retryable: false };
    return await store.runSerial((db) => {
      const commitSeq = allocateCommitSeq(db, projectId);
      db.prepare(
        "UPDATE orchestration_actions SET status = 'failed', result = ?, updated_seq = ? WHERE id = ?",
      ).run(JSON.stringify({ error: info }), commitSeq, action.id);
      return actionView(
        db.prepare("SELECT * FROM orchestration_actions WHERE id = ?").get(action.id),
      );
    });
  }
}

/** 更新决定级 tool_result（§3.3：工具执行结果随决定保存）。 */
async function refreshDecisionToolResult(pctx, projectId, decisionId) {
  const store = await getStore(pctx);
  return store.runSerial((db) => {
    const actions = db
      .prepare("SELECT id, action_kind, status FROM orchestration_actions WHERE decision_id = ? ORDER BY created_seq, id")
      .all(decisionId);
    const commitSeq = allocateCommitSeq(db, projectId);
    const toolResult = {
      executed: actions.filter((a) => a.status === "executed").length,
      failed: actions.filter((a) => a.status === "failed").length,
      skipped: actions.filter((a) => a.status === "skipped").length,
      pending: actions.filter((a) => a.status === "pending").length,
      actions: actions.map((a) => ({ id: a.id, action_kind: a.action_kind, status: a.status })),
      finalized_at: nowIso(),
    };
    db.prepare("UPDATE orchestration_decisions SET tool_result = ? WHERE id = ?").run(
      JSON.stringify(toolResult),
      decisionId,
    );
    return toolResult;
  });
}

/* ── 决定记录与执行（#32） ────────────────────────────────────────── */

function contentDigestPart(inputReportIds, inputEventRefs, rationale, actions, sourceMessageId) {
  return JSON.stringify({
    input_report_ids: inputReportIds,
    input_event_refs: inputEventRefs,
    rationale,
    source_message_id: sourceMessageId ?? null,
    actions: actions.map((a) => ({
      action_kind: a.action_kind,
      idempotency_key: a.idempotency_key,
      payload: a.payload ?? {},
    })),
  });
}

/**
 * 记录协调决定并执行其动作（§3.3/§18.5）。
 * 幂等：同 decision_id 同内容重发 → 返回已保存决定的当前状态（动作状态以库为准）；
 * 同 decision_id 不同内容 → IDEMPOTENCY_KEY_REUSED（不覆盖原决定）。
 *
 * M2 增量（蓝图 §2.6-2）：可选 source_message_id——决定持久化的同一事务内关联
 * 用户消息（message_links）、置 handled 并追加 AI 回复（delivered ≠ handled 的
 * 闭环）；动作执行后把产生的意图/任务/验证任务编号补进消息关联（展示对应任务）。
 * 其余 E1 语义不动。
 */
export async function recordDecision(
  pctx,
  { session, decisionId, inputReportIds, inputEventRefs, rationale, actions, sourceMessageId },
) {
  if (typeof rationale !== "string" || !rationale.trim() || rationale.length > 4000) {
    throw apiError("BAD_REQUEST", "决定缺少简要理由 rationale（非空、≤4000 字，§3.3）");
  }
  if (!Array.isArray(actions) || actions.length === 0 || actions.length > MAX_ACTIONS_PER_DECISION) {
    throw apiError(
      "BAD_REQUEST",
      `actions 必须是 1..${MAX_ACTIONS_PER_DECISION} 个动作的数组（一次决定可含多个动作，§3.3）`,
    );
  }
  const reportIds = strArrayField({ input_report_ids: inputReportIds ?? [] }, "input_report_ids", "决定");
  const eventRefs = strArrayField({ input_event_refs: inputEventRefs ?? [] }, "input_event_refs", "决定");
  if (decisionId !== undefined && decisionId !== null) {
    if (typeof decisionId !== "string" || !DECISION_ID_RE.test(decisionId)) {
      throw apiError("BAD_REQUEST", "decision_id 必须是 1..128 位 [A-Za-z0-9._:-]（重试时复用同一编号）");
    }
  }

  const normalized = [];
  const seenKeys = new Set();
  for (const raw of actions) {
    if (!raw || typeof raw !== "object") {
      throw apiError("BAD_REQUEST", "actions 每项必须是对象 { action_kind, idempotency_key, payload }");
    }
    if (!DECISION_ACTION_KINDS.includes(raw.action_kind)) {
      throw apiError(
        "BAD_REQUEST",
        `action_kind 允许：${DECISION_ACTION_KINDS.join("、")}（收到：${String(raw.action_kind)}）`,
      );
    }
    if (typeof raw.idempotency_key !== "string" || !IDEMPOTENCY_KEY_RE.test(raw.idempotency_key)) {
      throw apiError(
        "BAD_REQUEST",
        `动作 ${raw.action_kind} 缺少合法 idempotency_key（1..128 位 [A-Za-z0-9._:-]，每动作独立幂等编号，§3.3）`,
      );
    }
    if (seenKeys.has(raw.idempotency_key)) {
      throw apiError("BAD_REQUEST", `idempotency_key 在同一决定内重复：${raw.idempotency_key}`);
    }
    seenKeys.add(raw.idempotency_key);
    normalized.push({
      action_kind: raw.action_kind,
      idempotency_key: raw.idempotency_key,
      payload: raw.payload ?? {},
    });
  }

  const store = await getStore(pctx);
  const projectId = session.project_id;
  const actor = session.actor;

  const recorded = await store.runSerial((db) => {
    const now = nowIso();
    const project = db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId);
    if (!project) throw apiError("NOT_FOUND", `会话绑定的项目不存在：${projectId}`);

    for (const rid of reportIds) {
      const rep = db
        .prepare("SELECT 1 FROM worker_reports WHERE project_id = ? AND id = ?")
        .get(projectId, rid);
      if (!rep) {
        throw apiError("INVALID_REFERENCE", `input_report_ids 引用的汇报不存在：${rid}`, {
          detail: { report_id: rid },
          next_requirements: ["改用本项目已存在的汇报编号"],
        });
      }
    }
    for (const ref of eventRefs) {
      if (ref.startsWith("EVT-")) {
        const ev = db
          .prepare("SELECT 1 FROM outbox WHERE project_id = ? AND event_id = ?")
          .get(projectId, ref);
        if (!ev) {
          throw apiError("INVALID_REFERENCE", `input_event_refs 引用的事件不存在：${ref}`);
        }
      }
    }
    for (const action of normalized) {
      validateActionPayload(db, projectId, action.action_kind, action.payload);
    }

    // 决定级幂等（重试）：同 ID 同内容 → 返回已保存决定的当前状态
    if (decisionId) {
      const existing = db
        .prepare("SELECT * FROM orchestration_decisions WHERE id = ? AND project_id = ?")
        .get(decisionId, projectId);
      if (existing) {
        const existingActions = db
          .prepare(
            "SELECT action_kind, idempotency_key, payload FROM orchestration_actions WHERE decision_id = ? ORDER BY created_seq, id",
          )
          .all(decisionId);
        const same =
          contentDigestPart(
            parseJson(existing.input_report_ids, []),
            parseJson(existing.input_event_refs, []),
            existing.rationale,
            existingActions.map((a) => ({ ...a, payload: parseJson(a.payload, {}) })),
          ) === contentDigestPart(reportIds, eventRefs, rationale.trim(), normalized, sourceMessageId);
        if (!same) {
          throw apiError(
            "IDEMPOTENCY_KEY_REUSED",
            `decision_id ${decisionId} 已用于不同内容的决定，拒绝覆盖原决定（§3.3 决定幂等）`,
            {
              receipt: { decision_id: existing.id, created_at: existing.created_at },
              next_requirements: ["原样重发同一决定；内容变化使用新的 decision_id（或省略由服务端分配）"],
            },
          );
        }
        return { decision: decisionView(db, existing), idempotent: true };
      }
    }

    // 动作幂等键全局唯一（project, idempotency_key）
    for (const action of normalized) {
      const dup = db
        .prepare("SELECT id, decision_id, status FROM orchestration_actions WHERE project_id = ? AND idempotency_key = ?")
        .get(projectId, action.idempotency_key);
      if (dup) {
        throw apiError(
          "IDEMPOTENCY_KEY_REUSED",
          `动作幂等键 ${action.idempotency_key} 已被决定 ${dup.decision_id} 的动作 ${dup.id} 使用（status=${dup.status}），拒绝覆盖（§3.3 每动作独立幂等编号）`,
          {
            receipt: { action_id: dup.id, decision_id: dup.decision_id, status: dup.status },
            next_requirements: ["新动作用新的幂等键；原动作重试经其所属决定进行"],
          },
        );
      }
    }

    const finalDecisionId =
      decisionId || formatSeqId("OD", projectId, allocateSeq(db, projectId, "decision"));
    const commitSeq = allocateCommitSeq(db, projectId);
    db.prepare(
      `INSERT INTO orchestration_decisions (id, project_id, input_report_ids, input_event_refs,
         rationale, tool_result, created_at, created_by, created_seq)
       VALUES (?, ?, ?, ?, ?, '', ?, ?, ?)`,
    ).run(
      finalDecisionId,
      projectId,
      JSON.stringify(reportIds),
      JSON.stringify(eventRefs),
      rationale.trim(),
      now,
      actor,
      commitSeq,
    );
    const actionRows = normalized.map((action) => {
      const actionId = formatSeqId("OA", projectId, allocateSeq(db, projectId, "action"));
      db.prepare(
        `INSERT INTO orchestration_actions (id, project_id, decision_id, action_kind, idempotency_key,
           payload, status, result, created_at, created_by, created_seq, updated_seq)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', '', ?, ?, ?, ?)`,
      ).run(
        actionId,
        projectId,
        finalDecisionId,
        action.action_kind,
        action.idempotency_key,
        JSON.stringify(action.payload),
        now,
        actor,
        commitSeq,
        commitSeq,
      );
      return { id: actionId, ...action };
    });
    emitEvent(db, {
      projectId,
      commitSeq,
      eventType: "orchestration.decision_recorded",
      subjectIds: [finalDecisionId, ...reportIds],
      changedFields: [],
      causeRefs: [finalDecisionId],
      producerId: actor,
      payload: {
        kind: "decision_recorded",
        decision_id: finalDecisionId,
        action_ids: actionRows.map((a) => a.id),
        action_kinds: actionRows.map((a) => a.action_kind),
        input_report_ids: reportIds,
        input_event_refs: eventRefs,
        ...(sourceMessageId ? { source_message_id: sourceMessageId } : {}),
        rationale: truncate(rationale.trim(), 200),
      },
      now,
    });
    // M2（§2.6-2）：决定持久化的同一事务内关联用户消息、置 handled 并追加 AI 回复
    if (sourceMessageId) {
      const replyRow = linkDecisionAndReplyInTx(db, {
        projectId,
        messageId: sourceMessageId,
        decisionId: finalDecisionId,
        replyContent: rationale.trim(),
        actor,
        commitSeq,
        now,
      });
      if (!replyRow) {
        throw apiError("INVALID_REFERENCE", `source_message_id 引用的消息不存在：${sourceMessageId}`);
      }
    }
    const row = db
      .prepare("SELECT * FROM orchestration_decisions WHERE id = ?")
      .get(finalDecisionId);
    return { decision: decisionView(db, row), idempotent: false, commitSeq };
  });

  if (recorded.idempotent) {
    // 传输重试：同决定重发时补齐仍未完成的动作（中断恢复路径，§3.3），
    // 已完成动作由核对谓词标记 reconciled，不重放。
    const resumed = await executeDecisionActions(pctx, {
      projectId,
      decisionId: recorded.decision.id,
    });
    await linkMessageTaskRefs(pctx, { projectId, decision: resumed });
    return { ...resumed, idempotent: true };
  }

  const executed = await executeDecisionActions(pctx, { projectId, decisionId: recorded.decision.id });
  await linkMessageTaskRefs(pctx, { projectId, decision: executed });
  return { ...executed, idempotent: false };
}

/**
 * M2（§2.6-2）：决定执行后把动作产生的任务面编号补进来源消息的关联
 * （展示对应任务：attempt/intent/verification_job/plan_run/worker_report）。
 * 决定未关联消息时为空操作；补链失败不回滚决定（独立小事务，幂等）。
 */
async function linkMessageTaskRefs(pctx, { projectId, decision }) {
  if (!decision || !decision.actions) return;
  // 来源消息经 message_links 反查（决定关联在持久化事务内已写入；幂等重试路径同样成立）
  const store = await getStore(pctx);
  const messageId = store.db
    .prepare("SELECT message_id FROM message_links WHERE link_kind = 'orchestration_decision' AND ref_id = ? LIMIT 1")
    .get(decision.id)?.message_id ?? null;
  if (!messageId) return;
  const links = [];
  for (const action of decision.actions) {
    if (action.status !== "executed" && action.status !== "reconciled") continue;
    const payload = action.payload ?? {};
    const result = action.result ?? {};
    switch (action.action_kind) {
      case "assign_execution":
        if (result.attempt_id) links.push({ kind: "attempt", ref: result.attempt_id });
        if (payload.intent_id) links.push({ kind: "intent", ref: payload.intent_id });
        break;
      case "request_verification":
        if (result.job_id) links.push({ kind: "verification_job", ref: result.job_id });
        break;
      case "request_planning":
        if (result.plan_run_id) links.push({ kind: "plan_run", ref: result.plan_run_id });
        break;
      case "followup":
      case "attach_context":
        if (result.delivered_to_attempt) links.push({ kind: "attempt", ref: result.delivered_to_attempt });
        if (payload.report_id) links.push({ kind: "worker_report", ref: payload.report_id });
        break;
      case "handle_report":
        if (payload.report_id) links.push({ kind: "worker_report", ref: payload.report_id });
        break;
      default:
        break;
    }
  }
  if (!links.length) return;
  await linkRecordsToMessage(pctx, { projectId, messageId, links });
}

/** 按序执行决定内全部 pending 动作（记录后立即调用；重启核对亦走此入口）。 */
export async function executeDecisionActions(pctx, { projectId, decisionId }) {
  const store = await getStore(pctx);
  const decisionRow = await store.runSerial((db) => {
    const row = db
      .prepare("SELECT * FROM orchestration_decisions WHERE project_id = ? AND id = ?")
      .get(projectId, decisionId);
    if (!row) {
      throw apiError("INVALID_REFERENCE", `协调决定不存在：${decisionId}`, {
        next_requirements: ["核对 decision_id（GET /sorne/orchestrator/overview 的 pending_items 可见中断决定）"],
      });
    }
    return row;
  });
  const pending = await store.runSerial((db) =>
    db
      .prepare(
        "SELECT * FROM orchestration_actions WHERE decision_id = ? AND status = 'pending' ORDER BY created_seq, id",
      )
      .all(decisionId),
  );
  for (const action of pending) {
    await executeDecisionAction(pctx, { decision: decisionRow, action });
  }
  const toolResult = await refreshDecisionToolResult(pctx, projectId, decisionId);
  const view = await store.runSerial((db) => {
    const row = db.prepare("SELECT * FROM orchestration_decisions WHERE id = ?").get(decisionId);
    return decisionView(db, row);
  });
  return { ...view, tool_result: toolResult };
}

/**
 * 重启后的逐项核对（§3.3/§18.5；场景 30）：
 *   - 对每个含 pending 动作的决定逐动作核对执行（executeDecisionAction 先查
 *     实际完成情况，已完成的标记 reconciled 不重放）；
 *   - 清扫陈旧 in_flight 规划 run（§16.1 单规划在途的传输恢复：规划调用推定
 *     丢失时标记 rejected，允许 Orchestrator 重新请求；不盲目重做业务决定）。
 * overview 读取时自动执行；亦导出供 F2 恢复流程调用。
 */
export async function reconcilePendingDecisions(
  pctx,
  { projectId, stalePlanRunMs = DEFAULT_PLAN_RUN_STALE_MS },
) {
  const store = await getStore(pctx);
  const decisionIds = await store.runSerial((db) =>
    db
      .prepare(
        `SELECT DISTINCT d.id FROM orchestration_decisions d
         JOIN orchestration_actions a ON a.decision_id = d.id
         WHERE d.project_id = ? AND a.status = 'pending'
         ORDER BY d.created_seq LIMIT 100`,
      )
      .all(projectId)
      .map((r) => r.id),
  );
  const outcomes = [];
  for (const decisionId of decisionIds) {
    const before = await store.runSerial((db) =>
      db
        .prepare(
          "SELECT id, status, result, updated_seq FROM orchestration_actions WHERE decision_id = ? AND status = 'pending'",
        )
        .all(decisionId),
    );
    await executeDecisionActions(pctx, { projectId, decisionId });
    const after = await store.runSerial((db) =>
      db
        .prepare(
          "SELECT id, action_kind, status, result, updated_seq FROM orchestration_actions WHERE decision_id = ?",
        )
        .all(decisionId),
    );
    const byId = new Map(after.map((a) => [a.id, a]));
    outcomes.push({
      decision_id: decisionId,
      actions: before.map((a) => {
        const now = byId.get(a.id);
        return {
          id: a.id,
          action_kind: now?.action_kind,
          status: now?.status,
          reconciled: Boolean(now && parseJson(now.result, {})?.reconciled),
        };
      }),
    });
  }
  const cutoff = new Date(Date.now() - stalePlanRunMs).toISOString();
  const stalePlanRuns = await store.runSerial((db) => {
    const rows = db
      .prepare(
        "SELECT id, created_at FROM plan_runs WHERE project_id = ? AND status = 'in_flight' AND created_at < ?",
      )
      .all(projectId, cutoff);
    for (const row of rows) {
      db.prepare("UPDATE plan_runs SET status = 'rejected', updated_seq = ? WHERE id = ?").run(
        allocateCommitSeq(db, projectId),
        row.id,
      );
    }
    return rows.map((r) => r.id);
  });
  return {
    decisions_checked: decisionIds.length,
    decisions: outcomes,
    stale_plan_runs_rejected: stalePlanRuns,
    note: "逐项核对：外部委托型动作先查实际效果，已完成标记 reconciled 不重放（§3.3）；陈旧 in_flight 规划 run 标记 rejected（§16.1 传输恢复）",
  };
}

/* ── §16.3 供给块（overview 与 plan-requests 共用） ───────────────── */

function ageMs(fromIso, now) {
  const t = Date.parse(fromIso);
  return Number.isFinite(t) ? Math.max(0, now - t) : null;
}

export function buildSupplySnapshot(db, projectId, now) {
  const active = db
    .prepare("SELECT COUNT(*) AS c FROM attempts WHERE project_id = ? AND status IN ('leased','running')")
    .get(projectId).c;
  const runningTools = db
    .prepare("SELECT COUNT(*) AS c FROM tool_calls WHERE project_id = ? AND status = 'running'")
    .get(projectId).c;
  const suspended = db
    .prepare("SELECT COUNT(*) AS c FROM attempts WHERE project_id = ? AND status = 'suspended'")
    .get(projectId).c;
  const interrupted = db
    .prepare("SELECT COUNT(*) AS c FROM attempts WHERE project_id = ? AND status = 'interrupted'")
    .get(projectId).c;
  const project = db.prepare("SELECT resource_policy, next_commit_seq FROM projects WHERE id = ?").get(projectId);
  const policy = parseJson(project?.resource_policy, {});
  const maxActive = Number.isInteger(policy.max_active_attempts) ? policy.max_active_attempts : null;

  const blockedIntents = db
    .prepare("SELECT COUNT(*) AS c FROM intents WHERE project_id = ? AND status = 'blocked'")
    .get(projectId).c;
  const deferredIntents = db
    .prepare("SELECT COUNT(*) AS c FROM intents WHERE project_id = ? AND status = 'deferred'")
    .get(projectId).c;
  const awaitingReview = db
    .prepare("SELECT COUNT(*) AS c FROM intents WHERE project_id = ? AND status = 'awaiting_review'")
    .get(projectId).c;
  const pendingReports = db
    .prepare("SELECT COUNT(*) AS c, MIN(created_at) AS oldest FROM worker_reports WHERE project_id = ? AND handling_status = 'pending'")
    .get(projectId);
  const oldestBlockedReport = db
    .prepare(
      `SELECT MIN(created_at) AS oldest FROM worker_reports
       WHERE project_id = ? AND kind = 'blocked'
         AND intent_id IN (SELECT id FROM intents WHERE project_id = ? AND status = 'blocked')`,
    )
    .get(projectId, projectId);

  const repeated = db
    .prepare(
      `SELECT intent_id, COUNT(*) AS c, MAX(created_seq) AS last_seq FROM attempts
       WHERE project_id = ? GROUP BY intent_id HAVING c >= 2 ORDER BY c DESC LIMIT 20`,
    )
    .all(projectId);
  const repeatedAttempts = repeated.map((r) => {
    const last = db
      .prepare(
        "SELECT id, status, worker_id, recovery_note, created_at FROM attempts WHERE project_id = ? AND intent_id = ? ORDER BY created_seq DESC LIMIT 1",
      )
      .get(projectId, r.intent_id);
    const lastBlocked = db
      .prepare(
        "SELECT content FROM worker_reports WHERE project_id = ? AND intent_id = ? AND kind = 'blocked' ORDER BY created_seq DESC LIMIT 1",
      )
      .get(projectId, r.intent_id);
    return {
      intent_id: r.intent_id,
      attempt_count: r.c,
      last_attempt: last
        ? {
            id: last.id,
            status: last.status,
            worker_id: last.worker_id,
            created_at: last.created_at,
            note: truncate(parseJson(last.recovery_note, {}).reason || parseJson(lastBlocked?.content, {}).note || "", 120),
          }
        : null,
    };
  });

  const backlog = db
    .prepare(
      `SELECT
         SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending_jobs,
         SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress_jobs,
         MIN(CASE WHEN status = 'pending' THEN created_at END) AS oldest_pending_at
       FROM verification_jobs WHERE project_id = ?`,
    )
    .get(projectId);
  const unapplied = db
    .prepare("SELECT COUNT(*) AS c FROM verification_results WHERE project_id = ? AND applied = 0")
    .get(projectId).c;

  return {
    resource_usage: {
      active_attempts: active,
      max_active_attempts: maxActive,
      max_active_attempts_note:
        maxActive === null ? "未设置并行上限（可经 set_execution_limits 动作设置，§16.3）" : "并行上限，AI 可经 set_execution_limits 调整（硬顶 " + MAX_PARALLEL_ATTEMPTS_LIMIT + "）",
      running_tool_calls: runningTools,
      suspended_attempts: suspended,
      interrupted_attempts: interrupted,
    },
    waiting: {
      blocked_intents: blockedIntents,
      deferred_intents: deferredIntents,
      awaiting_review_intents: awaitingReview,
      pending_reports: pendingReports.c,
      oldest_pending_report_age_ms: pendingReports.oldest ? ageMs(pendingReports.oldest, now) : null,
      oldest_blocked_since_ms: oldestBlockedReport.oldest ? ageMs(oldestBlockedReport.oldest, now) : null,
    },
    repeated_attempts: {
      note: "相同意图的重复尝试清单（含最后失败/受阻原因）：是否继续、追问、换方法、暂缓或重规划由 AI 决定并持久化（§16.3），程序不写死重试策略",
      items: repeatedAttempts,
    },
    verification_backlog: {
      pending_jobs: backlog.pending_jobs ?? 0,
      in_progress_jobs: backlog.in_progress_jobs ?? 0,
      oldest_pending_waiting_ms: backlog.oldest_pending_at ? ageMs(backlog.oldest_pending_at, now) : null,
      unapplied_results: unapplied,
      note: "unapplied_results 为因版本竞争而未应用但保留的验证意见（§12.2）",
    },
    commit_boundary: project ? project.next_commit_seq - 1 : null,
    snapshot_at: new Date(now).toISOString(),
  };
}

/* ── 工作面板（#31；§3.3 概览 + §18.6 面板） ──────────────────────── */

const ACTIVE_INTENT_STATUSES = [
  "proposed",
  "queued",
  "running",
  "blocked",
  "awaiting_review",
  "deferred",
];

export async function orchestratorOverview(
  pctx,
  { session, projectId, sinceSeq, intentLimit = 50, reportLimit = 20, changesLimit = 20 },
) {
  // 先做程序状态核对（§16.1：定期核对发现中断决定与陈旧规划；效果幂等）
  const reconcile = await reconcilePendingDecisions(pctx, { projectId });
  const store = await getStore(pctx);

  return store.runSerial((db) => {
    const now = Date.now();
    const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId);
    if (!project) throw apiError("NOT_FOUND", `项目不存在：${projectId}`);

    /* 当前计划：最近接收的 plan_revisions + 在途 plan_runs */
    const activePlan = {
      latest_plan_revisions: db
        .prepare(
          "SELECT id, plan_run_id, revision, received_status, created_at FROM plan_revisions WHERE project_id = ? ORDER BY created_seq DESC LIMIT 5",
        )
        .all(projectId),
      in_flight_plan_runs: db
        .prepare(
          "SELECT id, status, input_boundary, created_at FROM plan_runs WHERE project_id = ? AND status IN ('pending','in_flight') ORDER BY created_seq",
        )
        .all(projectId),
      note: "同项目默认最多一个规划调用在途（§16.1）；期间新增事件继续落盘并进入下一批处理",
    };

    /* 各意图最新状态（§18.6） */
    const counts = Object.fromEntries(
      db
        .prepare("SELECT status, COUNT(*) AS c FROM intents WHERE project_id = ? GROUP BY status")
        .all(projectId)
        .map((r) => [r.status, r.c]),
    );
    const intentLimitClamped = Math.max(1, Math.min(200, intentLimit));
    const intentRows = db
      .prepare(
        `SELECT * FROM intents WHERE project_id = ? AND status IN (${ACTIVE_INTENT_STATUSES.map(() => "?").join(",")})
         ORDER BY priority DESC, created_seq LIMIT ?`,
      )
      .all(projectId, ...ACTIVE_INTENT_STATUSES, intentLimitClamped);
    const latestAttempts = new Map(
      db
        .prepare(
          `SELECT a.* FROM attempts a
           JOIN (SELECT intent_id, MAX(created_seq) AS ms FROM attempts WHERE project_id = ? GROUP BY intent_id) m
             ON a.intent_id = m.intent_id AND a.created_seq = m.ms
           WHERE a.project_id = ?`,
        )
        .all(projectId, projectId)
        .map((r) => [r.intent_id, r]),
    );
    const blockedNotes = new Map(
      db
        .prepare(
          `SELECT w.* FROM worker_reports w
           JOIN (SELECT intent_id, MAX(created_seq) AS ms FROM worker_reports WHERE project_id = ? AND kind = 'blocked' GROUP BY intent_id) m
             ON w.intent_id = m.intent_id AND w.created_seq = m.ms
           WHERE w.project_id = ?`,
        )
        .all(projectId, projectId)
        .map((r) => [
          r.intent_id,
          {
            report_id: r.id,
            note: truncate(r.actual_outcome || parseJson(r.content, {}).note || "", 160),
            condition_gaps: parseJson(r.content, {}).condition_gaps ?? [],
            reported_at: r.created_at,
          },
        ]),
    );
    const intentList = intentRows.map((row) => ({
      id: row.id,
      question: truncate(row.question, 160),
      kind: row.kind,
      status: row.status,
      status_text: INTENT_STATUS_TEXT[row.status] || row.status,
      state_version: row.state_version,
      plan_revision: row.plan_revision,
      target_asset_ids: parseJson(row.target_asset_ids, []),
      success_criteria: truncate(row.success_criteria || "", 160),
      priority: row.priority,
      budget: parseJson(row.budget, {}),
      resume_conditions: parseJson(row.resume_conditions, []),
      latest_attempt: latestAttempts.has(row.id)
        ? {
            id: latestAttempts.get(row.id).id,
            status: latestAttempts.get(row.id).status,
            worker_id: latestAttempts.get(row.id).worker_id,
          }
        : null,
      blocked_detail: blockedNotes.get(row.id) ?? null,
    }));
    const intentsBlock = {
      counts_by_status: counts,
      counts_note: "九态计数以库为准（§10.1）；resolved 不代表关联资产已测透",
      active: intentList,
      has_more:
        db
          .prepare(
            `SELECT COUNT(*) AS c FROM intents WHERE project_id = ? AND status IN (${ACTIVE_INTENT_STATUSES.map(() => "?").join(",")})`,
          )
          .get(projectId, ...ACTIVE_INTENT_STATUSES).c > intentLimitClamped,
    };

    /* 未处理汇报（§18.5/§18.6：delivered≠处理；base_report 相对变化线索） */
    const reportLimitClamped = Math.max(1, Math.min(100, reportLimit));
    const pendingReportRows = db
      .prepare(
        "SELECT * FROM worker_reports WHERE project_id = ? AND handling_status = 'pending' ORDER BY created_seq LIMIT ?",
      )
      .all(projectId, reportLimitClamped);
    const pendingReportTotal = db
      .prepare("SELECT COUNT(*) AS c FROM worker_reports WHERE project_id = ? AND handling_status = 'pending'")
      .get(projectId).c;
    const pendingReports = {
      total: pendingReportTotal,
      has_more: pendingReportTotal > pendingReportRows.length,
      items: pendingReportRows.map((row) => {
        const content = parseJson(row.content, {});
        let baselineStatus = undefined;
        if (row.base_report_id) {
          const base = db
            .prepare("SELECT handling_status FROM worker_reports WHERE project_id = ? AND id = ?")
            .get(projectId, row.base_report_id);
          baselineStatus = base ? base.handling_status : "missing";
        }
        return {
          id: row.id,
          kind: row.kind,
          kind_text: REPORT_KIND_TEXT[row.kind] || row.kind,
          intent_id: row.intent_id,
          attempt_id: row.attempt_id,
          base_report_id: row.base_report_id || null,
          replaces_report_id: row.replaces_report_id || null,
          base_report_handling_status: baselineStatus,
          task_question: truncate(row.task_question, 120),
          actual_outcome: truncate(row.actual_outcome || content.note || "", 160),
          execution_status: row.execution_status,
          condition_gaps: content.condition_gaps ?? [],
          late: Boolean(content.late),
          source_commit_boundary: row.source_commit_boundary || "",
          created_at: row.created_at,
          delivery_status: row.delivery_status,
          handling_status: row.handling_status,
        };
      }),
      note: "仅送入上下文（delivered）不算已处理；决定持久化并落回执后才 handled（§18.5）。新汇报默认强调相对 base_report 的变化；基线经 GET /sorne/worker-reports/{id} 读取（§18.6）",
    };

    /* 重要发现（状态以库为准，§18.4：摘要不得提升状态） */
    const since = Number.isInteger(sinceSeq) ? sinceSeq : null;
    const vulns = db
      .prepare(
        since !== null
          ? "SELECT id, category, status, review, location, created_seq, created_at FROM vulnerabilities WHERE project_id = ? AND created_seq > ? ORDER BY created_seq DESC LIMIT 10"
          : "SELECT id, category, status, review, location, created_seq, created_at FROM vulnerabilities WHERE project_id = ? ORDER BY created_seq DESC LIMIT 10",
      )
      .all(...(since !== null ? [projectId, since] : [projectId]));
    const hyps = db
      .prepare(
        since !== null
          ? "SELECT id, statement, status, created_seq, created_at FROM hypotheses WHERE project_id = ? AND created_seq > ? ORDER BY created_seq DESC LIMIT 10"
          : "SELECT id, statement, status, created_seq, created_at FROM hypotheses WHERE project_id = ? ORDER BY created_seq DESC LIMIT 10",
      )
      .all(...(since !== null ? [projectId, since] : [projectId]));
    const importantFindings = {
      vulnerabilities: vulns.map((v) => ({
        id: v.id,
        category: v.category,
        status: v.status,
        review: v.review,
        location: truncate(v.location, 120),
        created_seq: v.created_seq,
        created_at: v.created_at,
      })),
      hypotheses: hyps.map((h) => ({
        id: h.id,
        statement: truncate(h.statement, 120),
        status: h.status,
        created_seq: h.created_seq,
        created_at: h.created_at,
      })),
      note: "状态与复核状态以库为准（confirmed 只说明在指定条件下得到确认，§8.2）；确认漏洞可立即产生后续方向，以漏洞成立为前提的执行必须等待前提有效（§16.3）",
    };

    /* 待决事项（§18.6） */
    const pendingActionRows = db
      .prepare(
        `SELECT a.id, a.action_kind, a.decision_id, d.rationale FROM orchestration_actions a
         JOIN orchestration_decisions d ON d.id = a.decision_id
         WHERE a.project_id = ? AND a.status = 'pending' ORDER BY a.created_seq LIMIT 50`,
      )
      .all(projectId);
    const pendingItems = {
      interrupted_actions: {
        total: db
          .prepare("SELECT COUNT(*) AS c FROM orchestration_actions WHERE project_id = ? AND status = 'pending'")
          .get(projectId).c,
        items: pendingActionRows.map((r) => ({
          action_id: r.id,
          action_kind: r.action_kind,
          decision_id: r.decision_id,
          rationale: truncate(r.rationale, 120),
        })),
        note: "决定已保存但动作未完成（如保存决定后中断）；overview 读取时逐项核对补齐，不盲目重放（§3.3/场景 30）",
      },
      in_flight_plan_runs: activePlan.in_flight_plan_runs,
      needs_clarification_reports: db
        .prepare("SELECT COUNT(*) AS c FROM worker_reports WHERE project_id = ? AND handling_status = 'needs_clarification'")
        .get(projectId).c,
      deferred_reports: db
        .prepare("SELECT COUNT(*) AS c FROM worker_reports WHERE project_id = ? AND handling_status = 'deferred'")
        .get(projectId).c,
    };

    /* 关键限制（§18.6） */
    const projectCtx = buildProjectContext(db, projectId);
    const policy = parseJson(project.resource_policy, {});
    const activeCount = db
      .prepare("SELECT COUNT(*) AS c FROM attempts WHERE project_id = ? AND status IN ('leased','running')")
      .get(projectId).c;
    const constraints = {
      project_status: project.status,
      project_status_text: PROJECT_STATUS_TEXT[project.status] || project.status,
      scope_revision: project.current_scope_revision || null,
      scope: projectCtx.scope,
      resource_policy: policy,
      max_active_attempts: Number.isInteger(policy.max_active_attempts) ? policy.max_active_attempts : null,
      active_attempts: activeCount,
      note:
        project.status !== "active"
          ? `项目${PROJECT_STATUS_TEXT[project.status] || project.status}：新派发被程序阻止（§16.4 用户停止/暂停立即生效，不需等待 AI 阅读消息）`
          : "并行上限与项目状态为程序约束；预算与方向由 planner/orchestrator 调整",
    };

    /* 执行面（§3.3 活跃任务/受阻任务；租约剩余） */
    const activeAttemptRows = db
      .prepare(
        "SELECT id, intent_id, worker_id, status, lease_expires_at FROM attempts WHERE project_id = ? AND status IN ('leased','running') ORDER BY created_seq DESC LIMIT 50",
      )
      .all(projectId);
    const unknownCalls = db
      .prepare(
        "SELECT id, attempt_id, tool_name FROM tool_calls WHERE project_id = ? AND status = 'unknown' ORDER BY created_seq DESC LIMIT 20",
      )
      .all(projectId);
    const execution = {
      active_attempts: activeAttemptRows.map((a) => ({
        ...a,
        lease_remaining_ms: a.lease_expires_at ? ageMs(a.lease_expires_at, now) : null,
      })),
      suspended_attempts: db
        .prepare(
          "SELECT id, intent_id, recovery_note FROM attempts WHERE project_id = ? AND status = 'suspended' ORDER BY created_seq DESC LIMIT 20",
        )
        .all(projectId)
        .map((a) => ({
          id: a.id,
          intent_id: a.intent_id,
          reason: truncate(parseJson(a.recovery_note, {}).reason || "", 120),
          resume_conditions: parseJson(a.recovery_note, {}).resume_conditions ?? [],
        })),
      unknown_tool_calls: {
        total: db
          .prepare("SELECT COUNT(*) AS c FROM tool_calls WHERE project_id = ? AND status = 'unknown'")
          .get(projectId).c,
        items: unknownCalls,
        note: "unknown 需先检查现状再决定重试，不视作恰好一次（§10.2）",
      },
    };

    /* §16.3 供给块 */
    const supply = buildSupplySnapshot(db, projectId, now);

    /* 唤醒信号（§16.1：参考信号，不是固定决策树） */
    const queuedIntents = db
      .prepare("SELECT COUNT(*) AS c FROM intents WHERE project_id = ? AND status = 'queued'")
      .get(projectId).c;
    const orphanedRunning = db
      .prepare(
        `SELECT COUNT(*) AS c FROM intents i
         WHERE i.project_id = ? AND i.status = 'running'
           AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.intent_id = i.id AND a.project_id = i.project_id AND a.status IN ('leased','running'))`,
      )
      .get(projectId).c;
    const wakeSignals = {
      dispatchable_intents: queuedIntents,
      orphaned_running_intents: orphanedRunning,
      active_attempts: activeCount,
      max_active_attempts: constraints.max_active_attempts,
      has_capacity: constraints.max_active_attempts === null || activeCount < constraints.max_active_attempts,
      pending_reports: pendingReportTotal,
      note: "唤醒信号仅提示（队列不足/未处理汇报/确认漏洞等）；是否交接、追问、安排执行或请求重新规划由 Orchestrator AI 判断（§16.1），程序不固定决策树"
        + (orphanedRunning > 0 ? `。注意：${orphanedRunning} 个意图状态为 running 但无活跃 Attempt（孤儿），需重新 assign_execution 或 cancel_execution` : ""),
    };

    /* 关键变化（真实 Outbox 事件，紧凑摘要） */
    const changesLimitClamped = Math.max(1, Math.min(100, changesLimit));
    const changeRows = db
      .prepare(
        since !== null
          ? "SELECT commit_seq, event_index, event_type, subject_ids, created_at FROM outbox WHERE project_id = ? AND commit_seq > ? ORDER BY commit_seq DESC, event_index DESC LIMIT ?"
          : "SELECT commit_seq, event_index, event_type, subject_ids, created_at FROM outbox WHERE project_id = ? ORDER BY commit_seq DESC, event_index DESC LIMIT ?",
      )
      .all(...(since !== null ? [projectId, since, changesLimitClamped] : [projectId, changesLimitClamped]));
    const keyChanges = {
      items: changeRows
        .slice()
        .reverse()
        .map((r) => ({
          commit_seq: r.commit_seq,
          event_index: r.event_index,
          event_type: r.event_type,
          subject_ids: parseJson(r.subject_ids, []),
          created_at: r.created_at,
        })),
      since_seq: since,
      note: "变化为真实 Outbox 事件（编号+紧凑摘要）；完整读取经 GET /sorne/changes（按订阅边界续读）",
    };

    return {
      project: {
        id: project.id,
        name: project.name,
        task: projectCtx.task,
        description: projectCtx.description,
        goal: projectCtx.goal,
        goal_source: projectCtx.goal_source,
        goal_missing: projectCtx.goal_missing,
        goal_note: projectCtx.goal_note,
        status: project.status,
        status_text: PROJECT_STATUS_TEXT[project.status] || project.status,
        scope: projectCtx.scope,
        resource_policy: projectCtx.resource_policy,
      },
      project_context: projectCtx,
      reconcile,
      active_plan: activePlan,
      intents: intentsBlock,
      pending_reports: pendingReports,
      important_findings: importantFindings,
      pending_items: pendingItems,
      constraints,
      execution,
      supply,
      wake_signals: wakeSignals,
      key_changes: keyChanges,
      panel_notes: [
        "仅送入上下文（delivered）不算已处理：汇报在协调决定持久化并落回执后才标记 handled（§18.5）",
        "新汇报默认强调相对 base_report 的变化；接收方缺少基线时经 GET /sorne/worker-reports/{id} 读取基线，不依赖对话记忆（§18.6）",
        "面板折叠不改变原始关系与恢复条件；全部条目可按编号经 GET /sorne/records/{id} 展开（§18.6）",
        "supply 为数据时刻快照，供 AI 设方向预算与并行限制参考；重复尝试/验证积压用于评估是否继续、追问、换方法、暂缓或重规划（§16.3）",
      ],
      generated_at: new Date(now).toISOString(),
      viewer: session ? { actor: session.actor, role: session.role } : { actor: "user", role: "user" },
    };
  });
}

/* ── 单动作端点的糖衣（#34/#35/#36：仍是决定，走同一持久化与核对） ── */

/**
 * 单动作工具端点的受阻语义（§3.2 工具返回成功、冲突或受阻原因）：
 * 决定与动作已持久化（不掩盖），但工具目的未达成时以动作的错误码抛出，
 * 并携带 receipt 指明已保存的决定（§20.1）。
 */
function surfaceActionFailure(decision) {
  const action = decision.actions?.[0];
  if (action && action.status === "failed" && action.result?.error) {
    const err = action.result.error;
    throw apiError(err.code, err.message, {
      retryable: err.retryable,
      ...(err.detail !== undefined ? { detail: err.detail } : {}),
      ...(Array.isArray(err.next_requirements) ? { next_requirements: err.next_requirements } : {}),
      receipt: { decision_id: decision.id, action_id: action.id, action_status: "failed" },
    });
  }
  return action;
}

/** #34 追问 worker（§3.3：关联原意图与汇报；§18.5 needs_clarification 的追问载体）。 */
export async function createFollowup(pctx, { session, attemptId, question, reportId, gapRefs, note, idempotencyKey }) {
  const key =
    typeof idempotencyKey === "string" && idempotencyKey.trim()
      ? idempotencyKey.trim()
      : null;
  const decision = await recordDecision(pctx, {
    session,
    decisionId: key ? `FU-${key}` : undefined,
    inputReportIds: reportId ? [reportId] : [],
    inputEventRefs: [],
    rationale: `追问 worker：${truncate(question, 200)}`,
    actions: [
      {
        action_kind: "followup",
        idempotency_key: key || `followup-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        payload: {
          attempt_id: attemptId,
          question,
          report_id: reportId ?? null,
          gap_refs: gapRefs ?? [],
          note: note ?? "",
        },
      },
    ],
  });
  const action = surfaceActionFailure(decision);
  return {
    decision_id: decision.id,
    followup_ref: action?.id ?? null,
    action,
    note: "追问已作为协调决定持久化并投递到该 Attempt；汇报回执（needs_clarification）可用 followup_ref 关联（§18.5）",
  };
}

/** #35 补充任务上下文（§3.3：持久记录引用 + 用途，不改事实状态）。 */
export async function attachAttemptContext(
  pctx,
  { session, attemptId, recordRefs, purpose, note, idempotencyKey },
) {
  const key =
    typeof idempotencyKey === "string" && idempotencyKey.trim()
      ? idempotencyKey.trim()
      : null;
  const decision = await recordDecision(pctx, {
    session,
    decisionId: key ? `CX-${key}` : undefined,
    inputReportIds: [],
    inputEventRefs: [],
    rationale: `补充任务上下文：${truncate(purpose, 200)}`,
    actions: [
      {
        action_kind: "attach_context",
        idempotency_key: key || `ctx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        payload: { attempt_id: attemptId, record_refs: recordRefs, purpose, note: note ?? "" },
      },
    ],
  });
  return {
    decision_id: decision.id,
    action: surfaceActionFailure(decision),
    note: "记录引用已交给指定任务（不改变事实状态）；worker 按编号经 GET /sorne/records/{id} 展开（§3.3）",
  };
}

/** #36 请求（重新）规划（§3.3/§16.1：单规划在途；响应附 §16.3 供给块）。 */
export async function createPlanRequest(
  pctx,
  { session, question, recordRefs, changes, urgency, note, idempotencyKey },
) {
  const key =
    typeof idempotencyKey === "string" && idempotencyKey.trim()
      ? idempotencyKey.trim()
      : null;
  const decision = await recordDecision(pctx, {
    session,
    decisionId: key ? `PR-${key}` : undefined,
    inputReportIds: [],
    inputEventRefs: [],
    rationale: `请求规划：${truncate(question, 200)}`,
    actions: [
      {
        action_kind: "request_planning",
        idempotency_key: key || `planreq-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        payload: {
          question,
          record_refs: recordRefs ?? [],
          changes: changes ?? [],
          urgency: urgency ?? "",
          note: note ?? "",
        },
      },
    ],
  });
  const action = surfaceActionFailure(decision);
  const store = await getStore(pctx);
  const supply = await store.runSerial((db) =>
    buildSupplySnapshot(db, session.project_id, Date.now()),
  );
  return {
    decision_id: decision.id,
    plan_run: action?.status === "executed" ? action.result : null,
    action,
    supply,
    note: "规划请求已持久化并建立 plan_run（in_flight）；planner 以 plan_run_id 经 POST /sorne/plan-revisions 提交；同项目默认最多一个规划调用在途（§16.1）",
  };
}

/* ── #33 汇报回执（§18.5：回执只在决定持久化后 handled） ──────────── */

/** 决定是否关联某汇报（input_report_ids 或 handle_report 动作）。 */
function decisionReferencesReport(db, projectId, decisionRow, reportId) {
  const ids = parseJson(decisionRow.input_report_ids, []);
  if (ids.includes(reportId)) return true;
  const hit = db
    .prepare(
      "SELECT payload FROM orchestration_actions WHERE project_id = ? AND decision_id = ? AND action_kind = 'handle_report'",
    )
    .all(projectId, decisionRow.id);
  return hit.some((row) => parseJson(row.payload, {}).report_id === reportId);
}

/**
 * 记录汇报处理回执（#33）。
 * 门控（§18.5.6）：accepted/coordinated（标记 handled）必须关联一个已持久化、
 * 且引用了该汇报的协调决定；needs_clarification 关联追问（followup_ref）；
 * deferred 必须携带暂缓原因（note）与可选恢复条件。
 */
export async function recordReportReceipt(
  pctx,
  { session, reportId, receiptKind, note, followupRef, resumeConditions, decisionId },
) {
  if (typeof reportId !== "string" || !reportId.trim()) {
    throw apiError("BAD_REQUEST", "缺少 report_id（要落回执的汇报编号）");
  }
  if (!RECEIPT_KINDS.includes(receiptKind)) {
    throw apiError("BAD_REQUEST", `receipt_kind 允许：${RECEIPT_KINDS.join("、")}`);
  }
  const store = await getStore(pctx);
  const projectId = session.project_id;
  const warnings = [];

  if (receiptKind === "deferred" && !(typeof note === "string" && note.trim())) {
    throw apiError("BAD_REQUEST", "deferred 回执必须携带 note（明确暂缓原因，§3.3）");
  }

  return store.runSerial((db) => {
    const now = nowIso();
    const report = db
      .prepare("SELECT * FROM worker_reports WHERE project_id = ? AND id = ?")
      .get(projectId, reportId);
    if (!report) {
      throw apiError("INVALID_REFERENCE", `汇报不存在：${reportId}`, {
        next_requirements: ["改用本项目已存在的汇报编号（overview 的 pending_reports 可见）"],
      });
    }

    let linkedDecisionId = null;
    if (receiptKind === "accepted" || receiptKind === "coordinated") {
      // handled 门控：必须先有引用该汇报的持久化决定（§18.5.6）
      if (typeof decisionId === "string" && decisionId) {
        const row = db
          .prepare("SELECT * FROM orchestration_decisions WHERE project_id = ? AND id = ?")
          .get(projectId, decisionId);
        if (!row) {
          throw apiError("INVALID_REFERENCE", `decision_id 不存在：${decisionId}`);
        }
        if (!decisionReferencesReport(db, projectId, row, reportId)) {
          throw apiError(
            "PRECONDITION_INVALID",
            `决定 ${decisionId} 未引用汇报 ${reportId}（input_report_ids 或 handle_report 动作），不能作为其 handled 依据`,
            { next_requirements: ["先提交引用该汇报的协调决定（POST /sorne/orchestration-decisions）"] },
          );
        }
        linkedDecisionId = row.id;
      } else {
        // 自动寻找最近一个引用该汇报的决定
        const candidates = db
          .prepare(
            "SELECT * FROM orchestration_decisions WHERE project_id = ? ORDER BY created_seq DESC LIMIT 200",
          )
          .all(projectId);
        const found = candidates.find((row) => decisionReferencesReport(db, projectId, row, reportId));
        if (!found) {
          throw apiError(
            "PRECONDITION_INVALID",
            `汇报 ${reportId} 尚无持久化的协调决定；回执只在决定持久化后标记 handled（§18.5）`,
            {
              retryable: false,
              detail: { report_id: reportId, receipt_kind: receiptKind },
              next_requirements: [
                "先经 POST /sorne/orchestration-decisions 持久化引用该汇报的协调决定（或用 handle_report 动作），再落 accepted/coordinated 回执",
              ],
            },
          );
        }
        linkedDecisionId = found.id;
        warnings.push(`自动关联到最近引用该汇报的决定 ${found.id}`);
      }
    } else if (receiptKind === "needs_clarification" && !(typeof followupRef === "string" && followupRef)) {
      warnings.push("needs_clarification 未携带 followup_ref：建议关联追问动作（POST /sorne/attempts/{id}/followups 返回 followup_ref，§18.5）");
    }

    const commitSeq = allocateCommitSeq(db, projectId);
    const receiptId = formatSeqId("RR", projectId, allocateSeq(db, projectId, "report_receipt"));
    db.prepare(
      `INSERT INTO report_receipts (id, project_id, report_id, receipt_kind, followup_ref,
         decision_id, created_at, created_by, created_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      receiptId,
      projectId,
      reportId,
      receiptKind,
      typeof followupRef === "string" ? followupRef : "",
      linkedDecisionId,
      now,
      session.actor,
      commitSeq,
    );
    const handling = HANDLING_FOR_RECEIPT[receiptKind];
    db.prepare("UPDATE worker_reports SET handling_status = ? WHERE project_id = ? AND id = ?").run(
      handling,
      projectId,
      reportId,
    );
    if (Array.isArray(resumeConditions) && resumeConditions.length) {
      const content = parseJson(report.content, {});
      content.orchestrator_resume_conditions = resumeConditions;
      db.prepare("UPDATE worker_reports SET content = ? WHERE project_id = ? AND id = ?").run(
        JSON.stringify(content),
        projectId,
        reportId,
      );
    }
    const receiptRow = db.prepare("SELECT * FROM report_receipts WHERE id = ?").get(receiptId);
    return {
      receipt: receiptView(receiptRow),
      report: { id: reportId, handling_status: handling },
      warnings,
      note: "回执已持久化；delivered（送入上下文）与处理（handled）分开保存（§18.5）",
    };
  });
}
