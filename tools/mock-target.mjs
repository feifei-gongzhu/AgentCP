/**
 * 本地故意漏洞靶标（只绑 127.0.0.1；演练/真实模型联调用，不属于插件运行时）。
 *
 *   node tools/mock-target.mjs [port=8909]
 *
 * 用途（docs/modules/AGENTS-realrun.md §5）：
 *   - 给 Worker 的 http_probe 一个**真实 HTTP 服务**（非 mock fetch），验证
 *     range/gateway/证据/字符集/二进制响应等真实链路；
 *   - 端点覆盖：HTML（UTF-8 与 GBK 两种字符集）、未授权管理入口、robots.txt、
 *     二进制响应（application/zip 字节）、JSON API、Set-Cookie 多值、404；
 *   - 只监听 127.0.0.1，不触外网；供测试以 startMockTarget({port:0}) 随机端口复用。
 *
 * 注意：这是**故意**的漏洞靶标（/admin 无鉴权返回 200 并带敏感标记），仅用于
 * 授权演练；不得部署到非回环地址。
 */
import http from "node:http";
import { pathToFileURL } from "node:url";

const GBK_BYTES = Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0xa3, 0xac, 0xce, 0xb4, 0xca, 0xda, 0xc8, 0xa8, 0xb9, 0xdc, 0xc0, 0xed, 0xc8, 0xeb, 0xbf, 0xda]); // "你好，未授权管理入口"（GBK）

function html(title, body, extraHead) {
  return "<!doctype html><html lang=zh-CN><head><meta charset=utf-8><title>" + title + "</title>"
    + (extraHead || "") + "</head><body><h1>" + title + "</h1>" + body + "</body></html>";
}

function cookieValue() {
  return "PHPSESSID=" + Math.random().toString(36).slice(2, 12);
}

function handler(req, res) {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const path = url.pathname;
  const common = {
    "x-powered-by": "PHP/7.4.33",
    "x-mock-target": "sorne-local-target",
    "cache-control": "no-store",
  };
  const send = (status, headers, body) => {
    res.writeHead(status, { ...common, ...headers });
    res.end(body);
  };
  if (path === "/" || path === "/index.html") {
    send(200, { "content-type": "text/html; charset=utf-8" }, html("OA 系统（本地靶标）",
      "<ul><li><a href=/admin>管理后台</a></li><li><a href=/api/echo?msg=hello>回显 API</a></li>"
      + "<li><a href=/robots.txt>robots.txt</a></li><li><a href=/gbk>GBK 页面</a></li>"
      + "<li><a href=/backup.zip>backup.zip</a></li><li><a href=/health>health</a></li></ul>"));
    return;
  }
  if (path === "/health") {
    send(200, { "content-type": "application/json; charset=utf-8" }, JSON.stringify({ ok: true, service: "mock-target" }));
    return;
  }
  if (path === "/admin") {
    // 故意漏洞：未鉴权可访问的管理入口；附带多个 Set-Cookie
    res.writeHead(200, {
      ...common,
      "content-type": "text/html; charset=utf-8",
      "set-cookie": [cookieValue() + "; Path=/; HttpOnly", "role=admin; Path=/"],
    });
    res.end(html("管理后台", "<p>未鉴权可访问（故意漏洞）：用户列表 <code>admin, alice, bob</code></p>"));
    return;
  }
  if (path === "/api/echo") {
    const msg = url.searchParams.get("msg") ?? "";
    send(200, { "content-type": "application/json; charset=utf-8" }, JSON.stringify({ ok: true, msg }));
    return;
  }
  if (path === "/robots.txt") {
    send(200, { "content-type": "text/plain; charset=utf-8" }, "User-agent: *\nDisallow: /admin\nDisallow: /backup\n");
    return;
  }
  if (path === "/gbk") {
    // GBK 编码页面：验证 worker 按 charset 解码（不引入新依赖，Node 22 TextDecoder 支持 gbk）
    res.writeHead(200, { ...common, "content-type": "text/html; charset=gbk" });
    res.end(Buffer.concat([Buffer.from("<html><head><meta charset=gbk></head><body><p>"), GBK_BYTES, Buffer.from("</p></body></html>")]));
    return;
  }
  if (path === "/backup.zip") {
    // 二进制响应：验证 exchange_record 用 base64、raw_body 逐字节一致
    const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00, 0xde, 0xad, 0xbe, 0xef, 0x00, 0xff]);
    send(200, { "content-type": "application/zip" }, bytes);
    return;
  }
  send(404, { "content-type": "text/plain; charset=utf-8" }, "not found: " + path);
}

function buildServer() {
  return http.createServer(handler);
}

/** 启动靶标；port=0 时随机端口。返回 { server, port, base, close() }。 */
export async function startMockTarget({ port = 0, host = "127.0.0.1" } = {}) {
  if (host !== "127.0.0.1") throw new Error("mock-target 只允许绑定 127.0.0.1（演练纪律）");
  const server = buildServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const actual = server.address().port;
  return {
    server,
    port: actual,
    base: "http://127.0.0.1:" + actual,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) {
  const port = Number(process.argv[2]) || 8909;
  const target = await startMockTarget({ port });
  console.log("[mock-target] listening " + target.base);
  console.log("[mock-target] endpoints: / /admin /api/echo /robots.txt /gbk /backup.zip /health");
  const shutdown = () => target.close().then(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
