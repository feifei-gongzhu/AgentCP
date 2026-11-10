/**
 * D1 —— 验证服务路由（蓝图 §5 端点 #27/#28/#29）。
 *
 * 权限面（蓝图 §8.2/§8.3）：
 *   - #27 POST /verification-requests：需要程序签发会话；发起者角色限
 *     worker / orchestrator / verifier（§3 worker 提出 verification 请求、
 *     §3.3 orchestrator 发起独立验证、§8.3(3) 续验不受 requested_by 限制）；
 *   - #28 POST /verification-results：仅 verifier 会话可调用（§8.3(1) 独立性由
 *     调用身份与服务权限落实）；发现者自证的应用型结果由存储层拒绝（§8.3(2)）；
 *   - #29 GET /verification-jobs：只读视图（全角色；会话项目域校验，跨项目拒绝）。
 * project_id / actor / 角色一律以会话为准，信封内自报一律拒绝（§11.1）。
 */
import { apiError } from "../errors.mjs";
import { sessionFromRequest } from "../store/sessions.mjs";
import {
  JOB_STATUSES,
  VERIFIER_OUTCOMES,
  listVerificationJobs,
  requestVerification,
  submitVerificationResult,
} from "../store/verification.mjs";

const REQUESTER_ROLES = Object.freeze(["worker", "orchestrator", "verifier"]);

function csvParam(query, name, allowed, label) {
  const raw = query[name];
  if (raw === undefined || raw === null || raw === "") return [];
  const parts = String(raw).split(",").map((s) => s.trim()).filter(Boolean);
  for (const p of parts) {
    if (!allowed.includes(p)) {
      throw apiError("BAD_REQUEST", `参数 ${name} 的取值 ${p} 非法；${label}允许：${allowed.join("、")}`);
    }
  }
  return parts;
}

function limitParam(query) {
  const raw = query.limit;
  if (raw === undefined || raw === null || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 200) {
    throw apiError("BAD_REQUEST", "参数 limit 必须是 1..200 的整数（列表分页走游标，不静默截断）");
  }
  return n;
}

export const routes = [
  // #27 请求独立验证（§11.2/§8.3：五要素 + §7.3 去重键；不代替 verifier 确认）
  {
    method: "POST",
    path: "/sorne/verification-requests",
    async handler(pctx, req, res, { body }) {
      const session = sessionFromRequest(req);
      if (!session) {
        throw apiError(
          "TRUST_DENIED",
          "POST /verification-requests 需要程序签发的会话（请求头 x-sorne-session）；project_id/actor/角色由服务端会话决定（§11.1）",
        );
      }
      if (!REQUESTER_ROLES.includes(session.role)) {
        throw apiError(
          "TRUST_DENIED",
          `验证请求仅 worker / orchestrator / verifier 角色可发起（蓝图 §8.2；§8.3(3) 续验不受 requested_by 限制）；当前会话角色为 ${session.role}（actor=${session.actor}）`,
          { detail: { role: session.role, allowed_roles: [...REQUESTER_ROLES] } },
        );
      }
      return requestVerification(pctx, { session, input: body ?? {} });
    },
  },
  // #28 提交验证结果（§11.2/§12.2 核心事务；仅验证身份可调用，§8.3(1)）
  {
    method: "POST",
    path: "/sorne/verification-results",
    async handler(pctx, req, res, { body }) {
      const session = sessionFromRequest(req);
      if (!session) {
        throw apiError(
          "TRUST_DENIED",
          "POST /verification-results 仅验证身份会话可调用（请求头 x-sorne-session；§8.3 独立性由调用身份和服务权限落实）",
        );
      }
      if (session.role !== "verifier") {
        throw apiError(
          "TRUST_DENIED",
          `验证结果仅 verifier 角色可提交（§8.3(1)；发现者不能假冒 verifier 身份）；当前会话角色为 ${session.role}（actor=${session.actor}）`,
          { detail: { role: session.role, required: "verifier" } },
        );
      }
      return submitVerificationResult(pctx, { session, input: body ?? {} });
    },
  },
  // #29 验证队列视图（§8.3：Manifest / outcome / 等待时长）
  {
    method: "GET",
    path: "/sorne/verification-jobs",
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
      const outcome = typeof query.outcome === "string" && query.outcome ? query.outcome : null;
      if (outcome && !VERIFIER_OUTCOMES.includes(outcome)) {
        throw apiError("BAD_REQUEST", `参数 outcome 允许：${VERIFIER_OUTCOMES.join("、")}`);
      }
      return listVerificationJobs(pctx, {
        projectId,
        statuses: csvParam(query, "status", JOB_STATUSES, "任务状态"),
        subjectId: typeof query.subject_id === "string" && query.subject_id ? query.subject_id : null,
        outcome,
        limit: limitParam(query),
        // 游标统一（蓝图 §2.6-6）：cursor 为规范名；继续接受 after 别名
        // （旧 UI 曾以 ?after= 请求被静默忽略——评审 §4c）
        cursor:
          (typeof query.cursor === "string" && query.cursor) ||
          (typeof query.after === "string" && query.after) ||
          null,
      });
    },
  },
];
