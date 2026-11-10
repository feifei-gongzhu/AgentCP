/**
 * E1 —— 协调服务路由（规范 §3.1 §3.3 §16.1 §16.3 §16.4 §18.5(接收端) §18.6）。
 * 归属模块：E1（协调服务与决定持久化）。蓝图 §5 端点 #31–#36。
 *
 * §3.3 九工具合同 → 端点映射（蓝图 §5.2，9/9）：
 *   读取工作概览 → #31；读取汇报或记录 → #38(E2)/#14(B1)；分配执行 → #22(C2)；
 *   补充任务上下文 → #35；追问 worker → #34；暂缓/恢复/取消执行 → #24(C2)；
 *   请求规划 → #36；请求独立验证 → #27(D1)；处理汇报 → #33。
 *   其中 #31/#33/#34/#35/#36 由本模块实装；分配/生命周期/验证作为协调决定的
 *   动作由程序代行执行（§3 Execution Runtime「执行 AI 已提交的分配决定」，
 *   #22/#24 的 HTTP 面归 runtime 角色）。
 *
 * 权限面（蓝图 §8.2）：
 *   - #31 为只读面板：orchestrator 读取，无会话回环按 user 面只读（E3 页面同
 *     C1/B1/D1 先例）；会话项目域与目标项目不一致 → 403；
 *   - #32–#36 仅 orchestrator 会话；project_id/actor/角色以服务端会话为准（§11.1）。
 */
import { apiError } from "../errors.mjs";
import { sessionFromRequest } from "../store/sessions.mjs";
import {
  attachAttemptContext,
  createFollowup,
  createPlanRequest,
  orchestratorOverview,
  recordDecision,
  recordReportReceipt,
} from "../store/orchestrator.mjs";

function intParam(query, name, { min, max }) {
  const raw = query[name];
  if (raw === undefined || raw === null || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw apiError("BAD_REQUEST", `参数 ${name} 必须是 ${min}..${max} 的整数`);
  }
  return n;
}

function strArray(body, name) {
  const v = body?.[name];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !x.trim())) {
    throw apiError("BAD_REQUEST", `${name} 必须是非空字符串数组`);
  }
  return v;
}

/** 变更面鉴权：仅 orchestrator 会话（蓝图 §8.2 #32–#36）。 */
function requireOrchestrator(req, what) {
  const session = sessionFromRequest(req);
  if (!session) {
    throw apiError(
      "TRUST_DENIED",
      `端点 ${what} 需要程序签发的 orchestrator 会话（请求头 x-sorne-session）；project_id/actor/角色由服务端会话决定（§11.1）`,
    );
  }
  if (session.role !== "orchestrator") {
    throw apiError(
      "TRUST_DENIED",
      `端点 ${what} 不允许会话角色 ${session.role} 调用（蓝图 §8.2 协调面归 orchestrator）`,
      { detail: { role: session.role, required: "orchestrator" } },
    );
  }
  return session;
}

export const routes = [
  // #31 读取工作概览（§3.3：当前计划、活跃/受阻任务、新汇报、可用资源与关键变化；
  // §18.6 工作面板；§16.3 供给块；读取时先做程序状态核对 §16.1）
  {
    method: "GET",
    path: "/sorne/orchestrator/overview",
    async handler(pctx, req, res, { query }) {
      const session = sessionFromRequest(req);
      const projectId =
        (typeof query.project_id === "string" && query.project_id) ||
        (session && typeof session.project_id === "string" && session.project_id) ||
        null;
      if (!projectId) {
        throw apiError("BAD_REQUEST", "缺少 project_id（query 参数，或由会话绑定项目提供）");
      }
      if (session && session.project_id && session.project_id !== projectId) {
        throw apiError(
          "TRUST_DENIED",
          `会话绑定的项目（${session.project_id}）与请求读取的项目（${projectId}）不一致，拒绝跨项目读取（§11.2）`,
        );
      }
      return orchestratorOverview(pctx, {
        session,
        projectId,
        sinceSeq: intParam(query, "since_seq", { min: 0, max: Number.MAX_SAFE_INTEGER }),
        intentLimit: intParam(query, "limit", { min: 1, max: 200 }) ?? 50,
        reportLimit: intParam(query, "report_limit", { min: 1, max: 100 }) ?? 20,
        changesLimit: intParam(query, "changes_limit", { min: 1, max: 100 }) ?? 20,
      });
    },
  },
  // #32 保存协调决定与动作（§11.2/§3.3：决定+独立幂等编号动作；程序执行并保存各项结果）
  {
    method: "POST",
    path: "/sorne/orchestration-decisions",
    async handler(pctx, req, res, { body }) {
      const session = requireOrchestrator(req, "POST /orchestration-decisions");
      const input = body ?? {};
      return recordDecision(pctx, {
        session,
        decisionId: input.decision_id,
        inputReportIds: strArray(input, "input_report_ids"),
        inputEventRefs: strArray(input, "input_event_refs"),
        rationale: input.rationale,
        actions: input.actions,
      });
    },
  },
  // #33 汇报接收回执（§11.2/§18.5：决定持久化后才 handled；delivered≠处理）
  {
    method: "POST",
    path: "/sorne/report-receipts",
    async handler(pctx, req, res, { body }) {
      const session = requireOrchestrator(req, "POST /report-receipts");
      const input = body ?? {};
      return recordReportReceipt(pctx, {
        session,
        reportId: input.report_id,
        receiptKind: input.receipt_kind,
        note: input.note,
        followupRef: input.followup_ref,
        resumeConditions: Array.isArray(input.resume_conditions) ? input.resume_conditions : [],
        decisionId: input.decision_id,
      });
    },
  },
  // #34 追问 worker（§3.3：关联原意图与汇报；§18.5 needs_clarification 的追问载体）
  {
    method: "POST",
    path: "/sorne/attempts/:id/followups",
    async handler(pctx, req, res, { params, body }) {
      const session = requireOrchestrator(req, "POST /attempts/{id}/followups");
      const input = body ?? {};
      return createFollowup(pctx, {
        session,
        attemptId: params.id,
        question: input.question,
        reportId: input.report_id,
        gapRefs: Array.isArray(input.gap_refs) ? input.gap_refs : [],
        note: input.note,
        idempotencyKey: input.idempotency_key,
      });
    },
  },
  // #35 补充任务上下文（§3.3：持久记录引用+用途，不改事实状态）
  {
    method: "POST",
    path: "/sorne/attempts/:id/context",
    async handler(pctx, req, res, { params, body }) {
      const session = requireOrchestrator(req, "POST /attempts/{id}/context");
      const input = body ?? {};
      return attachAttemptContext(pctx, {
        session,
        attemptId: params.id,
        recordRefs: strArray(input, "record_refs"),
        purpose: input.purpose,
        note: input.note,
        idempotencyKey: input.idempotency_key,
      });
    },
  },
  // #36 请求（重新）规划（§3.3/§16.1：单规划在途；响应附 §16.3 供给块）
  {
    method: "POST",
    path: "/sorne/plan-requests",
    async handler(pctx, req, res, { body }) {
      const session = requireOrchestrator(req, "POST /plan-requests");
      const input = body ?? {};
      return createPlanRequest(pctx, {
        session,
        question: input.question,
        recordRefs: strArray(input, "record_refs"),
        changes: strArray(input, "changes"),
        urgency: typeof input.urgency === "string" ? input.urgency : "",
        note: input.note,
        idempotencyKey: input.idempotency_key,
      });
    },
  },
];
