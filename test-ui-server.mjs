/**
 * Sorne 独立 UI 测试宿主（开发/前端走查用，不属于插件运行时；M1 改造版）。
 *
 *   node test-ui-server.mjs [端口=8898]
 *
 * 无真实 dsh 也能验证完整工作台：
 *   1. mock ctx 调 index.js 的 apply()，/sorne/* 全部走真实 dispatcher
 *      （health/UI manifest/页面与设计系统静态路由已实装，业务端点随模块竣工）；
 *   2. client.js 独立渲染：React 18 UMD + __ModuleLoader__ shim，
 *      外壳动态 import 设计系统模块（/sorne/ui/lib/*.mjs，本宿主提供）与
 *      页面模块（/sorne/ui/pages/*.page.mjs，UI 静态路由提供）并渲染
 *      双布局外壳（引导层/工作区）+ hash 路由；
 *   3. 主题（评审 §1 根因修复）：本宿主不再硬编码任何背景/前景颜色——
 *      全部颜色由 lib/ui/theme.mjs 的双主题 token 经外壳注入的 <style> 提供，
 *      body 无色（由外壳根节点铺 --sorne-bg-canvas）。可用 ?theme=light|dark
 *      预设主题（存为初始模式，仍可在顶栏三态切换）；
 *   4. 数据目录使用独立临时目录（不触碰 ~/.sorne），可用 SORNE_DATA_DIR 覆盖。
 *
 * 浏览器打开 http://127.0.0.1:<port>/ 即可人工/自动化走查；示例：
 *   http://127.0.0.1:8898/?theme=dark          深色主题走查
 *   http://127.0.0.1:8898/?theme=light#/p/PRJ-0002/workbench   直链深链
 * 需要 React UMD（仅测试用，不进依赖树）：
 *   npm i --no-save react@18 react-dom@18
 */
import http from "node:http";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { apply } from "./index.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/* ── 数据目录：默认临时目录，绝不污染真实 ~/.sorne ─────────────────── */
if (!process.env.SORNE_DATA_DIR) {
  process.env.SORNE_DATA_DIR = mkdtempSync(join(tmpdir(), "sorne-ui-harness-"));
}

/* ── 服务半端：mock ctx 挂真实 /sorne 路由 ────────────────────────── */
const registered = [];
apply({
  webServer: {
    register: (opts) => {
      registered.push(opts);
      return () => {};
    },
  },
  logger: {
    info: (m) => console.log("[srv-info]", m),
    warn: (m) => console.log("[srv-warn]", m),
    error: (m) => console.log("[srv-err]", m),
  },
  effect: (fn) => fn(),
});
const route = registered.find((r) => r.kind === "prefix" && r.path === "/sorne");
if (!route) {
  console.error("[ui-harness] /sorne 路由未注册");
  process.exit(1);
}

/* ── 静态资源与页面 ────────────────────────────────────────────────── */
const reactUmd = join(HERE, "node_modules", "react", "umd", "react.production.min.js");
const reactDomUmd = join(HERE, "node_modules", "react-dom", "umd", "react-dom.production.min.js");
for (const f of [reactUmd, reactDomUmd]) {
  if (!existsSync(f)) {
    console.error(`[ui-harness] 缺少 ${f}；请在 sorne 目录执行 npm i --no-save react@18 react-dom@18`);
    process.exit(1);
  }
}

/* 主题预设：URL ?theme=light|dark → window.__SORNE_THEME__（外壳初始模式；
   不预设时跟随系统 prefers-color-scheme）。按请求生成页面 HTML。 */
function pageHtml(themeParam) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sorne 工作台 UI 宿主</title>
<style>
  /* 本宿主不书写任何颜色值（P0-1② 字面颜色闸覆盖本文件）；
     页面底色/前景全部来自外壳注入的 sorne 主题 token。 */
  html, body { margin: 0; padding: 0; }
</style>
</head><body>
<div id="root"></div>
<script>
window.__ModuleLoader__ = {
  _pending: null,
  load(def) { this._pending = def; },
  mount(requireFn) { return this._pending.factory(requireFn); },
};
window.__SORNE_THEME__ = ${themeParam ? JSON.stringify(themeParam) : "undefined"};
</script>
<script src="/react.js"></script>
<script src="/react-dom.js"></script>
<script src="/client.js"></script>
<script>
  const mod = window.__ModuleLoader__.mount(
    (name) => name === "react" ? window.React : window.ReactDOM);
  window.__sorneTest__ = mod.__test__; /* 自动化用例可直接取内部实现 */
  ReactDOM.createRoot(document.getElementById("root")).render(
    React.createElement(mod.__test__.createShellRuntime({
      React: window.React,
      h: window.React.createElement,
      api: mod.__test__.api,
      win: window,
      doc: document,
      initialThemeMode: window.__SORNE_THEME__,
      loadLibModule: (name) => import("/sorne/ui/lib/" + name + ".mjs"),
      importPageModule: (file) => import(file),
    }).SornePanel));
</script>
</body></html>`;
}

const JS_FILES = {
  "/client.js": join(HERE, "client.js"),
  "/react.js": reactUmd,
  "/react-dom.js": reactDomUmd,
};

/* 设计系统模块（M1）：以 /sorne/ui/lib/<name>.mjs 提供给浏览器动态 import。
   client.js 的加载器还兼容 lib/ui/<name>.mjs 相对路径，本宿主一并提供。 */
const LIB_ROOT = join(HERE, "lib", "ui");
function libFileFor(path) {
  // 设计系统模块可用于子目录（如 scope/editor.mjs）：/sorne/ui/lib/scope/editor.mjs。
  // 只放行 lib/ui 下真实存在的 .mjs，规范化后仍须位于 LIB_ROOT 内（路径穿越防护）。
  const m = /^\/(?:sorne\/ui\/lib|lib\/ui)\/([A-Za-z0-9_./-]+)\.mjs$/.exec(path);
  if (!m) return null;
  const rel = m[1];
  if (!rel || rel.includes("..") || rel.startsWith("/")) return null;
  const resolved = resolve(LIB_ROOT, `${rel}.mjs`);
  if (!resolved.startsWith(LIB_ROOT + sep)) return null;
  return existsSync(resolved) ? resolved : null;
}

const port = Number(process.argv[2]) || 8898;
const server = http.createServer((req, res) => {
  const url = req.url || "/";
  const path = url.split("?")[0];
  if (path === "/" || path === "/index.html") {
    const q = /[?&]theme=(light|dark)\b/i.exec(url);
    const themeParam = q ? q[1].toLowerCase() : null;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(pageHtml(themeParam));
    return;
  }
  if (path.startsWith("/sorne/ui/lib/") || path.startsWith("/lib/ui/")) {
    const file = libFileFor(path);
    if (file && existsSync(file)) {
      res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      res.end(readFileSync(file));
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("not found: " + path);
    return;
  }
  if (path.startsWith("/sorne/")) {
    route.handler(req, res);
    return;
  }
  const file = JS_FILES[path];
  if (file && existsSync(file)) {
    res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
    res.end(readFileSync(file));
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("not found: " + path);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[ui-harness] http://127.0.0.1:${port}/（可用 ?theme=light|dark 预设主题；hash 直链如 #/p/PRJ-0002/workbench）`);
  console.log(`[ui-harness] 数据目录（临时）: ${process.env.SORNE_DATA_DIR}`);
  console.log("[ui-harness] /sorne/* 走真实插件路由；业务端点在对应模块竣工前为未注册/未实现");
  console.log("[ui-harness] 主题：默认跟随系统（prefers-color-scheme），顶栏可三态切换");
});
