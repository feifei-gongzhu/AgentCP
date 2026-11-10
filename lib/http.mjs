/**
 * HTTP 基元与宿主信任边界（冻结契约，见 docs/BLUEPRINT.md §2.1）。
 *
 * 信任模型与 dsh-mrecon 参考实现一致（同 market-installer 的信任模型）：
 *   - 只接受回环连接（127.0.0.1 / ::1 / ::ffff:127.0.0.1）；
 *   - 出现 Forwarded / X-Forwarded-* / X-Real-IP 一律拒绝（防代理伪造来源）；
 *   - 读操作（GET/HEAD）仅要求回环；
 *   - 变更操作（POST 等）额外要求 Origin 与 Host 同源且 Origin 主机为回环。
 */
import { ApiError } from "./errors.mjs";

export const MAX_REQUEST_BODY_BYTES = 256 * 1024;

export function isLoopback(address) {
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1"
  );
}

export function hasForwardedAddress(req) {
  return Boolean(
    req.headers.forwarded ||
      req.headers["x-forwarded-for"] ||
      req.headers["x-real-ip"] ||
      req.headers["x-forwarded-host"],
  );
}

export function isTrustedRequest(req, mutation = false) {
  return isLoopbackConnection(req) && (!mutation || isSameOriginLoopback(req));
}

/** 连接层信任（先于路由匹配执行，不泄露路由存在性）：回环且无转发头。 */
export function isLoopbackConnection(req) {
  return isLoopback(req.socket.remoteAddress) && !hasForwardedAddress(req);
}

/** 变更操作信任：Origin 与 Host 同源且 Origin 主机为回环。 */
export function isSameOriginLoopback(req) {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (typeof origin !== "string" || typeof host !== "string") return false;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "http:" && parsed.host === host && isLoopback(parsed.hostname);
  } catch {
    return false;
  }
}

export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

export function sendText(res, status, text, contentType) {
  const body = String(text);
  res.writeHead(status, {
    "content-type": contentType || "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

/** 读取请求体并解析 JSON；空体返回 {}；超限/坏 JSON 抛 ApiError。 */
export function readJsonBody(req, maxBytes = MAX_REQUEST_BODY_BYTES) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    let rejected = false;
    req.on("data", (c) => {
      size += c.length;
      if (size > maxBytes) {
        if (!rejected) {
          rejected = true;
          rejectBody(new ApiError("REQUEST_TOO_LARGE", "请求体过大"));
        }
        return;
      }
      if (!rejected) chunks.push(c);
    });
    req.on("end", () => {
      if (rejected) return;
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text.trim()) {
        resolveBody({});
        return;
      }
      try {
        resolveBody(JSON.parse(text));
      } catch {
        rejectBody(new ApiError("BAD_REQUEST", "请求体不是合法 JSON"));
      }
    });
    req.on("error", rejectBody);
  });
}

export function parsePathname(req) {
  return decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
}

/**
 * 读取原始请求体（Buffer），不解析 JSON。
 * 供 rawBody 路由（如 POST /sorne/evidence/blobs 的证据字节流式上传）使用；
 * 上限由调用方按端点语义决定（§13：上传失败返回可重试错误，不制造已有证据事实）。
 */
export function readRawBody(req, maxBytes = MAX_REQUEST_BODY_BYTES) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    let rejected = false;
    req.on("data", (c) => {
      size += c.length;
      if (size > maxBytes) {
        if (!rejected) {
          rejected = true;
          rejectBody(new ApiError("REQUEST_TOO_LARGE", "请求体过大"));
        }
        return;
      }
      if (!rejected) chunks.push(c);
    });
    req.on("end", () => {
      if (!rejected) resolveBody(Buffer.concat(chunks));
    });
    req.on("error", rejectBody);
  });
}
