/**
 * M2 —— 开始探索路由（蓝图 §2.6-3 端点 #48）。
 *
 * POST /sorne/projects/{id}/explore-start {} → 200 | 409 LLM_NOT_CONFIGURED。
 * 用户面端点（无会话按 user 处理；会话角色限 user）。归属校验：项目不存在 → 404。
 */
import { apiError } from "../errors.mjs";
import { sessionFromRequest } from "../store/sessions.mjs";
import { startExploration } from "../store/explore.mjs";

function userPlane(req) {
  const session = sessionFromRequest(req);
  if (!session) return { actor: "user", role: "user" };
  if (session.role !== "user") {
    throw apiError(
      "TRUST_DENIED",
      `端点属用户面（开始探索），会话角色 ${session.role} 无权调用（蓝图 §8.2）`,
      { detail: { role: session.role } },
    );
  }
  return { actor: session.actor, role: "user" };
}

export const routes = [
  {
    method: "POST",
    path: "/sorne/projects/:id/explore-start",
    async handler(pctx, req, res, { params }) {
      const who = userPlane(req);
      return startExploration(pctx, { projectId: params.id, actor: who.actor, role: who.role });
    },
  },
];
