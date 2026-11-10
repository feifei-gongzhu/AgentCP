/**
 * M2 —— 报告导出路由（蓝图 §2.6-9 端点 #53；要求 §6「按需生成阶段报告并导出」）。
 *
 * GET /sorne/reports/{id}/export?project_id=&version=
 *   → text/markdown; charset=utf-8 + Content-Disposition: attachment
 *   → 404 + note（未知 id / 跨项目 / 内容文件缺失，不泄露存在性；沿 reportgen
 *     既有口径：refresh=1 可生成携带最新边界的新版本）。
 * 生成动作本身零新端点（#40 ?refresh=1，报告页「生成阶段报告」按钮）。
 */
import { apiError } from "../errors.mjs";
import { sessionFromRequest } from "../store/sessions.mjs";
import { readReportRevisionForExport, renderReportMarkdown } from "../store/reportgen.mjs";

function projectOf(query, req) {
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
  return projectId;
}

export const routes = [
  {
    method: "GET",
    path: "/sorne/reports/:id/export",
    async handler(pctx, req, res, { params, query }) {
      const projectId = projectOf(query, req);
      const found = await readReportRevisionForExport(pctx, {
        projectId,
        reportId: params.id,
        version: typeof query.version === "string" && query.version ? query.version : undefined,
      });
      if (!found) {
        throw apiError("NOT_FOUND", `项目 ${projectId} 内不存在该报告版本：${params.id}`, {
          detail: {
            report_id: params.id,
            hint: "报告版本行经 #39/#40 视图查看；阶段报告新版本经 GET /sorne/reports/milestones?refresh=1 生成",
          },
        });
      }
      if (!found.content) {
        throw apiError("NOT_FOUND", `报告内容文件不可读：${found.row.id} v${found.row.version}`, {
          detail: {
            report_id: found.row.id,
            content_ref: found.row.content_ref,
            note: "内容文件不可读，refresh=1 可生成新版本（沿 reportgen 既有口径；不虚报导出成功）",
          },
        });
      }
      const markdown = renderReportMarkdown(found.row, found.content);
      const filename = `${found.row.id}-v${String(found.row.version).replace(/^v/i, "")}.md`;
      res.writeHead(200, {
        "content-type": "text/markdown; charset=utf-8",
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "no-store",
      });
      res.end(markdown);
      return undefined; // 自行结束响应（lib/router.mjs 契约）
    },
  },
];
