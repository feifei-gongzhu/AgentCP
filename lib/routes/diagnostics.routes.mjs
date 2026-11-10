/**
 * M2 —— 系统诊断聚合路由（蓝图 §2.6-4 端点 #49）。
 *
 * GET /sorne/diagnostics                     → 全局聚合（含 projects 四态分组）
 * GET /sorne/diagnostics?project_id=PRJ-xxxx → 单项目聚合（不存在 → 404 不泄露存在性）
 * 只读聚合，不写库不发事件；user 面只读（携带会话时跨项目拒绝，§11.2）。
 */
import { apiError } from "../errors.mjs";
import { sessionFromRequest } from "../store/sessions.mjs";
import { buildDiagnostics } from "../store/diagnostics.mjs";

export const routes = [
  {
    method: "GET",
    path: "/sorne/diagnostics",
    async handler(pctx, req, res, { query }) {
      const session = sessionFromRequest(req);
      const projectId =
        (typeof query.project_id === "string" && query.project_id) ||
        (session && typeof session.project_id === "string" && session.project_id) ||
        null;
      if (session && session.project_id && projectId && session.project_id !== projectId) {
        throw apiError(
          "TRUST_DENIED",
          `会话绑定的项目（${session.project_id}）与请求读取的项目（${projectId}）不一致，拒绝跨项目读取（§11.2）`,
        );
      }
      return buildDiagnostics(pctx, { projectId });
    },
  },
];
