/**
 * 测试工具（冻结契约，所有模块测试必须复用，保证并行安全）。
 *
 * 并行安全规则（BLUEPRINT §12）：
 *   - 每个测试用独立 mkdtemp 临时目录，并通过 SORNE_DATA_DIR 注入；
 *   - HTTP 服务监听 127.0.0.1 随机端口（listen 0）；
 *   - 测试结束关闭服务器、删除临时目录，不留后台进程；
 *   - 不触碰 ~/.sorne 真实数据目录。
 */
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { apply } from "../index.js";

const quietLogger = { info: () => {}, warn: () => {}, error: () => {} };

export function makeTempDir(prefix = "sorne-test-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * 启动真实插件路由的测试服务器：
 * 以 mock ctx 调 index.js 的 apply()（同参考实现 test-ui-server 的做法），
 * /sorne/* 全部走真实 dispatcher。
 */
export async function startTestServer({ dataDir } = {}) {
  const dir = dataDir || makeTempDir();
  const prevDataDir = process.env.SORNE_DATA_DIR;
  process.env.SORNE_DATA_DIR = dir;

  const registered = [];
  apply({
    webServer: {
      register: (opts) => {
        registered.push(opts);
        return () => {};
      },
    },
    logger: quietLogger,
    effect: (fn) => fn(),
  });
  const route = registered.find((r) => r.kind === "prefix" && r.path === "/sorne");
  if (!route) throw new Error("/sorne 路由未注册");

  const server = http.createServer((req, res) => route.handler(req, res));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  /** 默认带同源 Origin（变更请求信任边界要求）；origin:null 表示省略该头。 */
  async function request(method, path, { body, origin } = {}) {
    const headers = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (origin !== null) headers["origin"] = origin !== undefined ? origin : base;
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }
    return { status: res.status, body: json, headers: res.headers };
  }

  async function close() {
    await new Promise((resolve) => server.close(resolve));
    if (prevDataDir === undefined) delete process.env.SORNE_DATA_DIR;
    else process.env.SORNE_DATA_DIR = prevDataDir;
    rmSync(dir, { recursive: true, force: true });
  }

  return { base, port, request, close, dataDir: dir };
}

/** withTestServer(fn)：自动建临时目录、启动、收尾。 */
export async function withTestServer(fn, opts) {
  const s = await startTestServer(opts);
  try {
    return await fn(s);
  } finally {
    await s.close();
  }
}
