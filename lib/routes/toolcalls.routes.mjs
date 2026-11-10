/**
 * 只读明细端点（诊断/全链路视图用）：
 *   GET /sorne/tool-calls?project_id=&limit=   工具调用明细（含执行者与操作目标 URL）
 *   GET /sorne/captures?project_id=&limit=     采集明细（按工具调用归并 URL）
 * 数据直接来自持久表；不提供写操作。
 */
import { apiError } from "../errors.mjs";
import { getStore } from "../store/record-service.mjs";

function clampLimit(raw, fallback = 100, max = 500) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

export const routes = [
  {
    method: "GET",
    path: "/sorne/tool-calls",
    async handler(pctx, req, res, { query }) {
      const pid = typeof query.project_id === "string" ? query.project_id : "";
      if (!pid) throw apiError("BAD_REQUEST", "缺少 project_id");
      const store = await getStore(pctx);
      const project = store.db.prepare("SELECT id FROM projects WHERE id = ?").get(pid);
      if (!project) throw apiError("NOT_FOUND", `项目不存在：${pid}`);
      const limit = clampLimit(query.limit, 100, 500);
      const rows = store.db.prepare(
        `SELECT tc.id, tc.project_id, tc.attempt_id, tc.tool_name, tc.args_digest, tc.status,
                tc.started_at, tc.ended_at, tc.error, a.worker_id
           FROM tool_calls tc LEFT JOIN attempts a ON a.id = tc.attempt_id AND a.project_id = tc.project_id
          WHERE tc.project_id = ?
          ORDER BY tc.created_seq DESC LIMIT ?`,
      ).all(pid, limit);
      const captures = store.db.prepare(
        "SELECT tool_call_id, request_url_exact FROM captures WHERE project_id = ? ORDER BY created_seq DESC LIMIT 2000",
      ).all(pid);
      const urls = new Map();
      for (const c of captures) {
        if (!c.tool_call_id) continue;
        if (!urls.has(c.tool_call_id)) urls.set(c.tool_call_id, []);
        urls.get(c.tool_call_id).push(c.request_url_exact);
      }
      return {
        project_id: pid,
        tool_calls: rows.map((r) => ({
          id: r.id,
          attempt_id: r.attempt_id,
          worker_id: r.worker_id || null,
          tool_name: r.tool_name,
          args_digest: r.args_digest,
          status: r.status,
          started_at: r.started_at,
          ended_at: r.ended_at,
          error: r.error || "",
          capture_urls: urls.get(r.id) || [],
        })),
      };
    },
  },
  {
    method: "GET",
    path: "/sorne/captures",
    async handler(pctx, req, res, { query }) {
      const pid = typeof query.project_id === "string" ? query.project_id : "";
      if (!pid) throw apiError("BAD_REQUEST", "缺少 project_id");
      const store = await getStore(pctx);
      const project = store.db.prepare("SELECT id FROM projects WHERE id = ?").get(pid);
      if (!project) throw apiError("NOT_FOUND", `项目不存在：${pid}`);
      const limit = clampLimit(query.limit, 100, 500);
      const rows = store.db.prepare(
        `SELECT id, project_id, attempt_id, tool_call_id, method, request_url_exact, observed_at, recorded_at, integrity_status
           FROM captures WHERE project_id = ? ORDER BY created_seq DESC LIMIT ?`,
      ).all(pid, limit);
      return { project_id: pid, captures: rows };
    },
  },
];
