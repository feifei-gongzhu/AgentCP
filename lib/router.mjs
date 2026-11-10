/**
 * 路由装载与分发（冻结契约，见 docs/BLUEPRINT.md §2.2）。
 *
 * 模块挂载协议：lib/routes/<area>.routes.mjs 导出
 *   export const routes = [{ method, path, handler, rawBody?, maxBodyBytes? }]
 *   - path 以 /sorne 开头，支持单段参数 ":name"（如 /sorne/records/:id）；
 *   - handler(pctx, req, res, { params, query, body })：
 *     返回值 !== undefined → 自动以 200 JSON 序列化；
 *     需要非 JSON 响应时自行结束 res 并返回 undefined；
 *     抛 ApiError → 统一错误信封。
 *   - rawBody: true → dispatcher 不预读不解析请求体（流保持未消费），由
 *     handler 自行以 http.readRawBody(req, maxBytes) 流式读取；用于证据
 *     字节等非 JSON 大载荷（§5.3/§13）。maxBodyBytes 仅约束 JSON 预读上限。
 * 分发顺序：连接层信任（回环+无转发头）→ 路由匹配 → 变更 Origin 同源检查
 * → 请求体；信任拒绝先于 404，不泄露路由存在性。
 * index.js 启动时扫描目录装载，模块施工只新增自己的文件，不改共享文件。
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ApiError } from "./errors.mjs";
import { isLoopbackConnection, isSameOriginLoopback, parsePathname, readJsonBody, sendJson } from "./http.mjs";

export async function loadRouteFiles(routesDir) {
  const files = (await readdir(routesDir)).filter((f) => f.endsWith(".routes.mjs")).sort();
  const routes = [];
  for (const file of files) {
    const mod = await import(pathToFileURL(join(routesDir, file)).href);
    if (!Array.isArray(mod.routes)) {
      throw new Error(`路由文件缺少 routes 导出：${file}`);
    }
    for (const r of mod.routes) {
      if (!r.method || !r.path || typeof r.handler !== "function") {
        throw new Error(`路由形状非法：${file} ${r.method} ${r.path}`);
      }
      routes.push({ ...r, file });
    }
  }
  return routes;
}

function matchPath(segments, pathname) {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length !== segments.length) return null;
  const params = {};
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.startsWith(":")) {
      if (!parts[i]) return null;
      params[seg.slice(1)] = parts[i];
    } else if (seg !== parts[i]) {
      return null;
    }
  }
  return params;
}

export function createDispatcher({ routes }) {
  const routesReady = Promise.resolve(routes).then((rs) =>
    rs.map((r) => ({ ...r, segments: r.path.split("/").filter(Boolean) })),
  );
  return async function dispatch(pctx, req, res) {
    try {
      const pathname = parsePathname(req);
      if (!pathname.startsWith("/sorne/") && pathname !== "/sorne") {
        sendJson(res, 404, { code: "NOT_FOUND", message: `非插件前缀：${pathname}` });
        return;
      }
      const method = req.method === "HEAD" ? "GET" : String(req.method || "GET").toUpperCase();
      // 1) 连接层信任先于路由匹配：非回环/带转发头一律 403，不泄露路由存在性。
      if (!isLoopbackConnection(req)) {
        sendJson(res, 403, {
          code: "TRUST_DENIED",
          message: "仅接受回环连接且不得携带转发头",
          retryable: false,
        });
        return;
      }
      const all = await routesReady;
      let match = null;
      for (const r of all) {
        if (r.method !== method) continue;
        const params = matchPath(r.segments, pathname);
        if (params) {
          match = { route: r, params };
          break;
        }
      }
      if (!match) {
        sendJson(res, 404, { code: "NOT_FOUND", message: `未注册路由：${method} ${pathname}` });
        return;
      }
      const mutation = !(req.method === "GET" || req.method === "HEAD");
      // 2) 变更操作要求同源 Origin（回环机器内的第二道检查）。
      if (mutation && !isSameOriginLoopback(req)) {
        sendJson(res, 403, {
          code: "TRUST_DENIED",
          message: "变更操作要求同源回环 Origin",
          retryable: false,
        });
        return;
      }
      const url = new URL(req.url ?? "/", "http://x");
      const query = Object.fromEntries(url.searchParams.entries());
      // 3) 请求体：rawBody 路由（证据字节流等）不预读不解析，由 handler 自行消费 req。
      const body = mutation && !match.route.rawBody
        ? await readJsonBody(req, match.route.maxBodyBytes)
        : undefined;
      const result = await match.route.handler(pctx, req, res, { params: match.params, query, body });
      if (result !== undefined) sendJson(res, 200, result);
    } catch (error) {
      if (error instanceof ApiError) {
        sendJson(res, error.status, error.toJSON());
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      try {
        pctx.logger.warn(`[sorne] ${req.method} ${req.url} 失败: ${message}`);
      } catch {
        /* 测试宿主可能没有 logger */
      }
      if (!res.headersSent) {
        sendJson(res, 500, { code: "INTERNAL_ERROR", message, retryable: false });
      } else {
        res.end();
      }
    }
  };
}
