/**
 * C2 —— 执行运行时与工具网关路由（蓝图 §5 端点 #22–#26）。
 *
 * 规范落点：
 *   - #22 POST /attempts（§3.3 分配执行 / §10.2）：创建执行分配 + 条件领取租约
 *     （runtime 角色；AI 的分配决定经 assignment_id 关联，程序只执行与保障）；
 *   - #23 GET /attempts（§10.2）：队列与租约视图（任意有效会话只读；
 *     fencing_token 对 user 角色隐藏）；
 *   - #24 POST /attempts/:id/lifecycle（§3.3 暂缓/恢复/取消 + §10.2 心跳续租）；
 *   - #25 POST /attempts/:id/progress（§11.2 进展/阻塞/完成建议与条件缺口；
 *     迟到提交留档不改新 Attempt、不再获工具权限，§20.3 场景 17）；
 *   - #26 POST /tool-calls（§10.2 ToolCall 状态机 + §17 动作前逐跳校验）。
 *
 * 权限（蓝图 §8.2）：#22/#24 仅 runtime；#25/#26 worker（本人 Attempt）或
 * runtime；project_id/actor 以程序签发会话为准（§11.1），自报一律忽略。
 */
import { apiError } from "../errors.mjs";
import { sessionFromRequest } from "../store/sessions.mjs";
import {
  attemptLifecycle,
  dispatchAttempt,
  listAttempts,
  reportProgress,
  toolGateway,
} from "../store/attempts.mjs";

function requireRole(req, roles, what) {
  const session = sessionFromRequest(req);
  if (!session) {
    throw apiError(
      "TRUST_DENIED",
      `本端点需要程序签发的会话（请求头 x-sorne-session）；project_id/actor/角色由服务端会话决定（§11.1）`,
    );
  }
  if (!roles.includes(session.role)) {
    throw apiError("TRUST_DENIED", `端点 ${what} 不允许会话角色 ${session.role} 调用（蓝图 §8.2）`, {
      detail: { role: session.role, allowed_roles: [...roles] },
    });
  }
  return session;
}

function requireSession(req) {
  const session = sessionFromRequest(req);
  if (!session) {
    throw apiError("TRUST_DENIED", "本端点需要程序签发的会话（请求头 x-sorne-session）");
  }
  return session;
}

/** #25/#26 的 worker 面约束：worker 只能操作派发给自己的 Attempt；runtime 不限。 */
async function assertAttemptOwnership(pctx, session, attemptId) {
  if (session.role === "runtime") return;
  const { getStore } = await import("../store/record-service.mjs");
  const store = await getStore(pctx);
  const row = store.db
    .prepare("SELECT worker_id FROM attempts WHERE project_id = ? AND id = ?")
    .get(session.project_id, attemptId);
  if (!row) {
    throw apiError("NOT_FOUND", `执行尝试不存在（项目 ${session.project_id}）：${attemptId}`);
  }
  if (row.worker_id !== session.actor) {
    throw apiError(
      "TRUST_DENIED",
      `会话 actor ${session.actor} 不是 Attempt ${attemptId} 的执行者（${row.worker_id}）；worker 只能操作派给自己的执行（蓝图 §8.2）`,
    );
  }
}

function intField(body, name) {
  const v = body?.[name];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v)) {
    throw apiError("BAD_REQUEST", `${name} 必须是整数`);
  }
  return v;
}

export const routes = [
  // #22 创建执行分配 + 租约（§3.3 分配执行；§10.2 条件领取 + fencing token）
  {
    method: "POST",
    path: "/sorne/attempts",
    async handler(pctx, req, res, { body }) {
      const session = requireRole(req, ["runtime"], "POST /attempts（执行分配）");
      const b = body || {};
      return dispatchAttempt(pctx, {
        session,
        intentId: b.intent_id,
        assignmentId: b.assignment_id,
        workerId: b.worker_id,
        leaseTtlMs: intField(b, "lease_ttl_ms"),
        handoffSummary: typeof b.handoff_summary === "string" ? b.handoff_summary : undefined,
      });
    },
  },
  // #23 队列与租约视图（§10.2；unknown 与受阻显式呈现，租约剩余时间）。
  // 只读面与 B1 快照端点同 precedent：携带会话时按会话项目域校验；无会话的
  // 回环请求按 user 面只读处理（project_id 取 query）；fencing_token 对 user 隐藏。
  {
    method: "GET",
    path: "/sorne/attempts",
    async handler(pctx, req, res, { query }) {
      const session = sessionFromRequest(req);
      const projectId =
        (typeof query.project_id === "string" && query.project_id) ||
        (session && session.project_id) ||
        "";
      if (!projectId) {
        throw apiError("BAD_REQUEST", "缺少 project_id（query 参数，或由会话绑定项目提供）");
      }
      if (session && session.project_id && session.project_id !== projectId) {
        throw apiError(
          "TRUST_DENIED",
          `会话绑定的项目（${session.project_id}）与请求读取的项目（${projectId}）不一致，拒绝跨项目读取（§11.2）`,
        );
      }
      const limit = query.limit === undefined || query.limit === "" ? undefined : Number(query.limit);
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 500)) {
        throw apiError("BAD_REQUEST", "limit 必须是 1..500 的整数");
      }
      // 分页游标：after 为规范名；cursor 为 UI 侧别名（宽松输入，B1 kind 别名先例）
      const after = query.after !== undefined && query.after !== "" ? query.after : query.cursor;
      return listAttempts(pctx, {
        session: {
          project_id: projectId,
          actor: session ? session.actor : "user",
          role: session ? session.role : "user",
        },
        intentId: query.intent_id,
        status: query.status,
        limit,
        after,
      });
    },
  },
  // #24 暂缓/恢复/取消 + 心跳续租（§3.3/§10.2；runtime 执行协调决定）
  {
    method: "POST",
    path: "/sorne/attempts/:id/lifecycle",
    async handler(pctx, req, res, { params, body }) {
      const session = requireRole(req, ["runtime"], "POST /attempts/:id/lifecycle（执行生命周期）");
      const b = body || {};
      if (typeof b.action !== "string" || !b.action) {
        throw apiError("BAD_REQUEST", "缺少 action（heartbeat / suspend / resume / cancel）");
      }
      if (b.reason_code !== undefined && !["retryable", "reassign", "dead_end"].includes(b.reason_code)) {
        throw apiError("BAD_REQUEST", "reason_code 必须为 retryable / reassign / dead_end");
      }
      return attemptLifecycle(pctx, {
        session,
        attemptId: params.id,
        action: b.action,
        fencingToken: intField(b, "fencing_token"),
        reason: typeof b.reason === "string" ? b.reason : undefined,
        reasonCode: b.reason_code,
        resumeConditions: Array.isArray(b.resume_conditions) ? b.resume_conditions : undefined,
        leaseTtlMs: intField(b, "lease_ttl_ms"),
      });
    },
  },
  // #25 进展/阻塞/完成建议（§11.2；迟到留档）
  {
    method: "POST",
    path: "/sorne/attempts/:id/progress",
    async handler(pctx, req, res, { params, body }) {
      const session = requireRole(req, ["worker", "runtime"], "POST /attempts/:id/progress（进展汇报）");
      await assertAttemptOwnership(pctx, session, params.id);
      const b = body || {};
      if (typeof b.kind !== "string" || !b.kind) {
        throw apiError("BAD_REQUEST", "缺少 kind（progress / blocked / completion）");
      }
      return reportProgress(pctx, {
        session,
        attemptId: params.id,
        kind: b.kind,
        note: typeof b.note === "string" ? b.note : "",
        detail: b.detail,
        conditionGaps: b.condition_gaps,
        fencingToken: intField(b, "fencing_token"),
      });
    },
  },
  // #26 工具网关（§10.2 ToolCall 状态机；§17 派发与动作前逐跳校验）
  {
    method: "POST",
    path: "/sorne/tool-calls",
    async handler(pctx, req, res, { body }) {
      const session = requireRole(req, ["worker", "runtime"], "POST /tool-calls（工具网关）");
      const b = body || {};
      if (typeof b.action !== "string" || !b.action) {
        throw apiError("BAD_REQUEST", "缺少 action（register / start / complete / mark_unknown / resolve / cancel）");
      }
      if (typeof b.attempt_id !== "string" || !b.attempt_id) {
        throw apiError("BAD_REQUEST", "缺少 attempt_id");
      }
      await assertAttemptOwnership(pctx, session, b.attempt_id);
      return toolGateway(pctx, {
        session,
        action: b.action,
        attemptId: b.attempt_id,
        fencingToken: intField(b, "fencing_token"),
        toolCallId: b.tool_call_id,
        toolName: b.tool_name,
        args: b.args,
        targets: b.targets,
        agent: b.agent,
        outcome: b.outcome,
        evidenceRefs: b.evidence_refs,
        touchedTargets: b.touched_targets,
        reason: b.reason,
        checkNote: b.check_note,
        error: b.error,
      });
    },
  },
];
