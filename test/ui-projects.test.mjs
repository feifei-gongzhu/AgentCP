/**
 * M3 —— 项目列表页测试（lib/ui/pages/projects.page.mjs 重写版；BLUEPRINT-UI §1.3）。
 *
 * 覆盖（含旧 ui-shell.test.mjs「项目页」断言的语义迁移，迁移清单见 docs/modules/ui-M3.md）：
 *   - 页面契约：纯 ESM 不引包、不用浏览器本地存储、无 React 钩子、无编号正则副本
 *     （P0-2②：RECORD_ID_RE 只存在于 lib/ui/record-ids.mjs）、无字面颜色值与宿主
 *     变量引用（P0-1②，theme.mjs token 之外零命中）；
 *   - 五列恰为：项目｜当前状态｜最近进展｜待处理事项｜最近活动（要求 §2）；
 *   - 行点击进入工作区 #/p/:pid/workbench；编号 chip 携带完整编号（项目段族
 *     A-PRJ-0002-0002 与全局族 A-0002 都不截断，点击 openRecord 完整编号）；
 *   - 真分页：仅 has_more=true 渲染「加载更多」，翻页携带 cursor 并累积；
 *     无分页信息（旧形体）绝不渲染该按钮（评审 §4d 死代码消灭）；
 *   - summary 字段缺失 → 「—（未提供）」+ 如实标注（未提供 ≠ 不存在）；
 *   - 空态三步引导「连接模型 → 创建项目 → 开始探索」+ 模型未连接横幅（直达向导）；
 *   - 无数据块隐藏：全零待处理不渲染「（空）」块；数据时刻/按已加载数据推导/不代表全量；
 *   - 真实服务集成：manifest 注册、summary 形体、创建项目后列表呈现（两种状态下都成立）。
 *
 * 测试宿主：不依赖 React 运行时（依赖树不含 react）——用最小 createElement +
 * Component 基类驱动页面的类组件，并绑定 M1 真实渲染器（lib/ui/render.mjs +
 * lib/ui/record-ids.mjs，经 bindRenderers 注入同一实现），保证断言打到真实渲染输出。
 *
 * 并行安全：fakeApi 用例不占端口；真实服务用例走 withTestServer（独立临时目录 +
 * listen(0) 随机端口 + finally 收尾，见 test/helpers.mjs）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { withTestServer } from "./helpers.mjs";
import * as renderMod from "../lib/ui/render.mjs";
import * as recordIdsMod from "../lib/ui/record-ids.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGES_DIR = join(HERE, "..", "lib", "ui", "pages");

async function loadPage(id) {
  const mod = await import(pathToFileURL(join(PAGES_DIR, `${id}.page.mjs`)).href);
  return mod.default;
}

/* ── 最小宿主（createElement + Component 基类）与 M1 真实渲染器绑定 ── */

function makeH() {
  return (type, props, ...children) => ({
    __elem: true,
    type,
    props: props || {},
    children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== true && c !== false),
  });
}

const h = makeH();
const ComponentBase = class HarnessComponent {
  constructor(props) {
    this.props = props || {};
  }
};
renderMod.bindRenderers({ createElement: h, Component: ComponentBase });

const ui = {
  formatTime: renderMod.formatTime,
  formatHash: renderMod.formatHash,
  RecordIdChip: renderMod.RecordIdChip,
  FoldableObject: renderMod.FoldableObject,
  StatusBadge: renderMod.StatusBadge,
  FieldRow: renderMod.FieldRow,
  DataTable: renderMod.DataTable,
  EmptyState: renderMod.EmptyState,
  LABELS: renderMod.LABELS,
  VOCAB: renderMod.VOCAB,
  RUN_STATUS: renderMod.RUN_STATUS,
  parseRecordId: recordIdsMod.parseRecordId,
  isEventId: recordIdsMod.isEventId,
  hasProjectSegment: recordIdsMod.hasProjectSegment,
};

/* ── 挂载仿真：展开类组件树（顶层 1 个页面类组件；渲染器函数组件直接调用） ── */

function mountPage(def, ctx) {
  const rootElem = def.render(ctx);
  let tree = null;
  const cdmQueue = [];
  const instCache = new Map(); // 树路径 → 实例（模拟 React 按位置协调：同位实例跨渲染保留）

  function walk(node, path) {
    if (Array.isArray(node)) return node.map((c, i) => walk(c, `${path}/${i}`));
    if (!node || !node.__elem) return node;
    if (typeof node.type === "function") {
      let child;
      if (node.type.prototype instanceof ComponentBase) {
        let inst = instCache.get(path);
        const first = !inst;
        if (first) {
          inst = new node.type(node.props);
          if (!inst.state) inst.state = {};
          inst.setState = (patch) => {
            const next = typeof patch === "function" ? patch(inst.state) : patch;
            inst.state = { ...inst.state, ...next };
          };
          instCache.set(path, inst);
          cdmQueue.push(inst);
        } else {
          inst.props = node.props;
        }
        child = inst.render();
        return { ...node, __inst: inst, children: [walk(child, `${path}/out`)] };
      }
      // 渲染器函数组件（StatusBadge/EmptyState/RecordIdChip 等）：直接调用。
      child = node.type(node.props);
      return { ...node, children: [walk(child, `${path}/fn`)] };
    }
    return { ...node, children: node.children.map((c, i) => walk(c, `${path}/${i}`)) };
  }

  function rerender() {
    cdmQueue.length = 0;
    tree = walk(rootElem, "r");
    for (const inst of cdmQueue) {
      if (typeof inst.componentDidMount === "function") inst.componentDidMount();
    }
  }

  rerender();

  async function flush(rounds = 24) {
    for (let i = 0; i < rounds; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    rerender();
  }

  function findAll(pred) {
    const found = [];
    (function walkNode(node) {
      if (node && node.__elem) {
        if (pred(node)) found.push(node);
        for (const child of node.children) walkNode(child);
      }
    })(tree);
    return found;
  }

  function nodeText(node) {
    if (node === null || node === undefined || node === true || node === false) return "";
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(nodeText).join("");
    if (node.__elem) return nodeText(node.children);
    return String(node);
  }

  function text() {
    return nodeText(tree);
  }

  function findButton(label) {
    const hits = findAll((n) => n.type === "button" && nodeText(n.children).includes(label));
    assert.ok(hits.length >= 1, `未找到按钮「${label}」；当前文本：${text().slice(0, 400)}`);
    return hits[hits.length - 1];
  }

  function click(node) {
    assert.ok(!node.props.disabled, `按钮被禁用：${nodeText(node.children)}`);
    node.props.onClick({ preventDefault() {}, stopPropagation() {} });
  }

  function rowElements() {
    return findAll((n) => n.type === "tr" && n.props.onClick);
  }

  return { flush, text, findAll, findButton, click, rowElements, nodeText };
}

/* ── fakeApi：按「METHOD 基路径」分发（忽略 query），记录全部调用 ──── */

function parseBody(raw) {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function apiError(status, body) {
  const e = new Error(body.message || `HTTP ${status}`);
  e.status = status;
  e.code = body.code;
  e.body = body;
  return e;
}

function basePath(path) {
  return path.split("?")[0];
}

function fakeApi(handlers) {
  const calls = [];
  const fn = (path, options) => {
    const method = (options && options.method) || "GET";
    const body = parseBody(options && options.body);
    calls.push({ method, path, body });
    const handler = handlers[`${method} ${basePath(path)}`];
    if (!handler) {
      return Promise.reject(new Error(`fakeApi 未配置：${method} ${basePath(path)}`));
    }
    return Promise.resolve().then(() => (typeof handler === "function" ? handler(body, path) : handler));
  };
  fn.calls = calls;
  return fn;
}

function makeCtx(api, { page = "projects", hash = "#/projects" } = {}) {
  const calls = [];
  const listeners = new Set();
  const router = {
    hash,
    page,
    projectId: null,
    params: {},
    query: {},
    open: (target) => {
      calls.push({ kind: "open", hash: target });
      router.hash = target;
      for (const fn of Array.from(listeners)) fn(router);
    },
    replace: (target) => calls.push({ kind: "replace", hash: target }),
    back: (fb) => calls.push({ kind: "back", fallback: fb }),
    openRecord: (id) => calls.push({ kind: "openRecord", id }),
    isInAppHistory: () => false,
    onChange: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    __calls: calls,
  };
  return { React: { createElement: h, Component: ComponentBase }, h, api, router, ui, theme: null };
}

/* ── 样例数据 ─────────────────────────────────────────────────────── */

const SUMMARY_ROW = (over = {}) => ({
  id: "PRJ-0001",
  name: "演示项目",
  description: "对 test.example 的持续探索",
  status: "active",
  latest_progress: "asset.registered（A-PRJ-0002-0002）",
  last_activity_at: "2026-11-06T02:00:00.000Z",
  pending: { unhandled_reports: 2, pending_verification: 0, blocked_intents: 1 },
  ...over,
});

/* ══════════════════════════════════════════════════════════════════ */
/* 1. 页面契约                                                         */
/* ══════════════════════════════════════════════════════════════════ */

test("M3 页面契约：纯 ESM 不引包、不用浏览器本地存储、无钩子、无编号正则副本、无字面颜色值", async () => {
  const src = await readFile(join(PAGES_DIR, "projects.page.mjs"), "utf8");
  assert.doesNotMatch(src, /(^|\n)\s*import[\s(]/, "页面不得静态 import 任何模块");
  assert.doesNotMatch(src, /[^.\w]require\s*\(/, "页面不得使用 require");
  assert.doesNotMatch(src, /localStorage/, "页面不得使用浏览器本地存储");
  assert.doesNotMatch(src, /React\.useState|React\.useEffect|useState\(|useEffect\(/, "页面顶层不得使用 React 钩子");
  assert.doesNotMatch(src, /RECORD_ID_RE/, "编号正则唯一实现必须在 lib/ui/record-ids.mjs（P0-2②）");
  assert.doesNotMatch(src, /#[0-9a-fA-F]{3,8}\b|rgba?\(/, "页面不得书写字面颜色值（P0-1②，全部经 --sorne-* token）");
  assert.doesNotMatch(src, /--dsw-alias-/, "页面不得引用宿主 --dsw-alias-* 变量");

  const def = await loadPage("projects");
  assert.equal(def.id, "projects");
  assert.equal(def.order, 10);
  assert.equal(def.title, "项目", "注册表标题（§2.5）");
  assert.equal(typeof def.render, "function");
});

/* ══════════════════════════════════════════════════════════════════ */
/* 2. 五列与数据呈现                                                    */
/* ══════════════════════════════════════════════════════════════════ */

test("项目列表：五列数据 + 操作列（删除）（要求 §2；M3 删除接口）", async () => {
  const def = await loadPage("projects");
  const api = fakeApi({ "GET /sorne/projects": { projects: [SUMMARY_ROW()], next_cursor: null, has_more: false } });
  const t = mountPage(def, makeCtx(api));
  await t.flush();

  const heads = t.findAll((n) => n.type === "th").map((n) => t.nodeText(n.children));
  assert.deepEqual(heads, ["项目", "当前状态", "最近进展", "待处理事项", "最近活动", "操作"]);
});

test("行数据：中文状态徽章、编号 chip 携带完整项目段编号、点击 openRecord 不截断（P0-2 回归）", async () => {
  const def = await loadPage("projects");
  const api = fakeApi({
    "GET /sorne/projects": {
      projects: [
        SUMMARY_ROW({
          id: "PRJ-0002",
          latest_progress: "asset.registered（A-PRJ-0002-0002、I-PRJ-0002-0001）",
          status: "paused",
        }),
        SUMMARY_ROW({ id: "PRJ-0003", latest_progress: "observation.created（A-0002）" }),
      ],
      next_cursor: null,
      has_more: false,
    },
  });
  const ctx = makeCtx(api);
  const t = mountPage(def, ctx);
  await t.flush();

  assert.match(t.text(), /已暂停/, "paused → 中文徽章（词表驱动）");
  assert.match(t.text(), /运行中/, "active → 中文徽章");
  // 完整编号必须原样出现（不得只剩 PRJ-0002 中段——评审 §4a 的静默错误）
  assert.match(t.text(), /A-PRJ-0002-0002/);
  assert.match(t.text(), /I-PRJ-0002-0001/);
  assert.match(t.text(), /A-0002/);

  const chipA = t.findAll((n) => n.type === "button" && String(n.props["aria-label"] || "").includes("A-PRJ-0002-0002"));
  assert.ok(chipA.length >= 1, "项目段族编号渲染为可点击 chip");
  t.click(chipA[0]);
  const rec = ctx.router.__calls.find((c) => c.kind === "openRecord");
  assert.ok(rec, "点击 chip 应 openRecord");
  assert.equal(rec.id, "A-PRJ-0002-0002", "openRecord 必须携带完整编号");

  const chipB = t.findAll((n) => n.type === "button" && String(n.props["aria-label"] || "").includes("A-0002"));
  assert.ok(chipB.length >= 1, "全局族编号同样渲染为 chip");
});

test("整行点击进入工作区 #/p/:pid/workbench；行内按钮 aria-label 可达", async () => {
  const def = await loadPage("projects");
  const api = fakeApi({ "GET /sorne/projects": { projects: [SUMMARY_ROW()], next_cursor: null, has_more: false } });
  const ctx = makeCtx(api);
  const t = mountPage(def, ctx);
  await t.flush();

  const rows = t.rowElements();
  assert.equal(rows.length, 1);
  t.click(rows[0]);
  const nav = ctx.router.__calls.find((c) => c.kind === "open");
  assert.ok(nav, "行点击应导航");
  assert.equal(nav.hash, "#/p/PRJ-0001/workbench");

  const nameBtn = t.findAll((n) => n.type === "button" && String(n.props["aria-label"] || "").includes("进入项目"));
  assert.ok(nameBtn.length >= 1, "项目名按钮有 aria-label（键盘/读屏可达）");
});

test("待处理事项：仅列非零计数；全零显示 —（不渲染任何「（空）」块）", async () => {
  const def = await loadPage("projects");
  const api = fakeApi({
    "GET /sorne/projects": {
      projects: [
        SUMMARY_ROW({ id: "PRJ-0001", pending: { unhandled_reports: 2, pending_verification: 0, blocked_intents: 1 } }),
        SUMMARY_ROW({ id: "PRJ-0002", pending: { unhandled_reports: 0, pending_verification: 0, blocked_intents: 0 } }),
      ],
      next_cursor: null,
      has_more: false,
    },
  });
  const t = mountPage(def, makeCtx(api));
  await t.flush();

  assert.match(t.text(), /未处理汇报 2/);
  assert.match(t.text(), /受阻方向 1/);
  assert.doesNotMatch(t.text(), /待验证/, "零计数不展示");
  assert.doesNotMatch(t.text(), /（空）/, "无数据的（空）块默认隐藏（评审 §4d/P2-11）");
});

test("summary 字段缺失（旧形体）→ 「—（未提供）」+ 如实标注：未提供不等于不存在", async () => {
  const def = await loadPage("projects");
  const api = fakeApi({ "GET /sorne/projects": { projects: [{ id: "PRJ-0001", name: "旧形体项目", status: "active" }] } });
  const t = mountPage(def, makeCtx(api));
  await t.flush();

  assert.match(t.text(), /—（未提供）/, "缺失字段不伪造数据");
  assert.match(t.text(), /未提供不等于不存在/);
  assert.doesNotMatch(t.text(), /加载更多项目/, "旧形体无分页信息 → 绝不渲染「加载更多」");
});

test("loading 与加载失败呈现；失败可重试", async () => {
  const def = await loadPage("projects");
  const t1 = mountPage(def, makeCtx(fakeApi({})));
  // 首帧（componentDidMount 触发的请求尚未落地）→ loading 态
  assert.match(t1.text(), /正在加载项目列表…/);

  const api2 = fakeApi({
    "GET /sorne/projects": () => {
      throw apiError(500, { code: "INTERNAL_ERROR", message: "库不可用" });
    },
  });
  const t2 = mountPage(def, makeCtx(api2));
  await t2.flush();
  assert.match(t2.text(), /项目列表加载失败/);
  assert.match(t2.text(), /INTERNAL_ERROR · 库不可用/, "错误信封原文呈现");
  t2.click(t2.findButton("重试"));
  await t2.flush();
  assert.ok(api2.calls.filter((c) => c.method === "GET").length >= 2, "重试重新发起请求");
});

/* ══════════════════════════════════════════════════════════════════ */
/* 3. 真分页（评审 §4d：没有后端分页一律不渲染「加载更多」）             */
/* ══════════════════════════════════════════════════════════════════ */

test("真分页：has_more=true 渲染「加载更多」；翻页携带 cursor 并累积；结束后按钮消失", async () => {
  const def = await loadPage("projects");
  const api = fakeApi({
    "GET /sorne/projects": (_body, path) => {
      if (path.includes("cursor=")) {
        return { projects: [SUMMARY_ROW({ id: "PRJ-0002", name: "第二页项目" })], next_cursor: null, has_more: false };
      }
      return { projects: [SUMMARY_ROW()], next_cursor: "5:PRJ-0001", has_more: true };
    },
  });
  const t = mountPage(def, makeCtx(api));
  await t.flush();

  assert.match(t.text(), /加载更多项目/, "仅 has_more=true 时渲染");
  assert.match(t.text(), /不代表全量/, "有未加载页时如实标注");

  t.click(t.findButton("加载更多项目"));
  await t.flush();

  const second = api.calls.filter((c) => c.method === "GET" && c.path.includes("cursor="));
  assert.ok(second.length >= 1, "翻页请求应携带 cursor");
  assert.match(second[0].path, /cursor=5%3APRJ-0001|cursor=5:PRJ-0001/);
  assert.match(t.text(), /第二页项目/, "跨页累积");
  assert.doesNotMatch(t.text(), /加载更多项目/, "has_more=false 后按钮消失");
});

test("无分页信息（旧形体）即使有数据也绝不渲染「加载更多」（死代码消灭）", async () => {
  const def = await loadPage("projects");
  const api = fakeApi({ "GET /sorne/projects": { projects: [SUMMARY_ROW()] } });
  const t = mountPage(def, makeCtx(api));
  await t.flush();
  assert.match(t.text(), /演示项目/);
  assert.doesNotMatch(t.text(), /加载更多项目/);
});

/* ══════════════════════════════════════════════════════════════════ */
/* 4. 空态三步引导与模型未连接横幅                                       */
/* ══════════════════════════════════════════════════════════════════ */

test("空列表 + 模型未配置 → 三步引导「连接模型→创建项目→开始探索」+ 未连接横幅 + 直达向导", async () => {
  const def = await loadPage("projects");
  const api = fakeApi({
    "GET /sorne/projects": { projects: [], next_cursor: null, has_more: false },
    "GET /sorne/llm/settings": { configured: false, base_url: null, model: null, api_key_set: false, per_role: {}, source: "none" },
  });
  const ctx = makeCtx(api);
  const t = mountPage(def, ctx);
  await t.flush();

  assert.match(t.text(), /还没有项目/);
  assert.match(t.text(), /连接模型/);
  assert.match(t.text(), /创建项目/);
  assert.match(t.text(), /开始探索/);
  assert.match(t.text(), /尚未连接模型，项目可以保存，AI 暂不能开始/, "引导层横幅（要求 §1）");

  t.click(t.findButton("① 连接模型"));
  const nav = ctx.router.__calls.find((c) => c.kind === "open");
  assert.equal(nav.hash, "#/onboarding", "引导直达向导");

  t.click(t.findButton("去连接模型"));
  const nav2 = ctx.router.__calls.filter((c) => c.kind === "open");
  assert.ok(nav2.some((c) => c.hash === "#/onboarding"), "横幅直达连接入口");
});

test("有项目 + 模型未配置 → 顶部横幅呈现且直达连接入口可用", async () => {
  const def = await loadPage("projects");
  const api = fakeApi({
    "GET /sorne/projects": { projects: [SUMMARY_ROW()], next_cursor: null, has_more: false },
    "GET /sorne/llm/settings": { configured: false, base_url: null, model: null, api_key_set: false, per_role: {}, source: "none" },
  });
  const ctx = makeCtx(api);
  const t = mountPage(def, ctx);
  await t.flush();
  assert.match(t.text(), /尚未连接模型，项目可以保存，AI 暂不能开始/);
  t.click(t.findButton("去连接模型"));
  assert.ok(ctx.router.__calls.some((c) => c.hash === "#/onboarding"));
});

test("数据时刻与口径标注：数据时刻 / 按已加载数据推导 / 不裸出 UTC ISO 串", async () => {
  const def = await loadPage("projects");
  const api = fakeApi({ "GET /sorne/projects": { projects: [SUMMARY_ROW()], next_cursor: null, has_more: false } });
  const t = mountPage(def, makeCtx(api));
  await t.flush();

  assert.match(t.text(), /数据时刻/);
  assert.match(t.text(), /按已加载数据推导/);
  assert.doesNotMatch(t.text(), /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, "绝不裸出 UTC ISO 串（评审 §3）");
});

/* ══════════════════════════════════════════════════════════════════ */
/* 5. 降级态（旧宿主无 ui/router）                                       */
/* ══════════════════════════════════════════════════════════════════ */

test("无 ui 渲染器 → 降级提示不崩溃；无 router → 行不可点击并如实说明", async () => {
  const def = await loadPage("projects");
  const api = fakeApi({ "GET /sorne/projects": { projects: [] }, "GET /sorne/llm/settings": { configured: false } });
  const t1 = mountPage(def, { React: { createElement: h, Component: ComponentBase }, h, api, router: null, ui: null, theme: null });
  await t1.flush();
  assert.match(t1.text(), /渲染器未就绪/, "无 ui 时诚实降级，不做数据猜测");

  const ctx2 = makeCtx(api);
  ctx2.router = null;
  const t2 = mountPage(def, ctx2);
  await t2.flush();
  assert.match(t2.text(), /引导入口需要导航模块/);
});

/* ══════════════════════════════════════════════════════════════════ */
/* 6. 真实服务集成（两种端点状态下都成立）                               */
/* ══════════════════════════════════════════════════════════════════ */

test("真实服务：manifest 注册 projects（order 10）；summary 形体呈现；空库空态引导", () =>
  withTestServer(async ({ base, request }) => {
    const manifest = await request("GET", "/sorne/ui/manifest");
    assert.equal(manifest.status, 200);
    const projects = manifest.body.pages.find((p) => p.id === "projects");
    assert.ok(projects, "manifest 缺 projects");
    assert.equal(projects.file, "/sorne/ui/pages/projects.page.mjs");
    assert.equal(projects.order, 10);
    assert.equal(projects.title, "项目");

    const empty = await request("GET", "/sorne/projects?include=summary&limit=50");
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body.projects, [], "空库返回空数组");
    assert.equal(empty.body.has_more, false);

    const def = await loadPage("projects");
    const api = async (path, options) => {
      const res = await fetch(base + path, {
        method: (options && options.method) || "GET",
        headers: {
          "Content-Type": (options && options.headers && options.headers["Content-Type"]) || "application/json",
          origin: base,
        },
        body: options && options.body,
      });
      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = { raw: text };
      }
      if (!res.ok) {
        const err = new Error((data && data.message) || `HTTP ${res.status}`);
        err.status = res.status;
        err.code = data && data.code;
        err.body = data;
        throw err;
      }
      return data;
    };
    const t = mountPage(def, makeCtx(api));
    await t.flush();
    assert.match(t.text(), /还没有项目/, "空库 → 空态三步引导");
    assert.match(t.text(), /连接模型/);
    assert.match(t.text(), /数据时刻/);
  }));

test("真实服务：创建项目后列表五列呈现；summary 计数与库内事实一致", () =>
  withTestServer(async ({ base, request }) => {
    const created = await request("POST", "/sorne/projects", {
      body: { name: "集成项目", description: "集成验收目标", scope_rules: { allow: ["example.test"], deny: [], pending: [] } },
    });
    assert.equal(created.status, 200);
    const pid = created.body.project.id;

    const list = await request("GET", "/sorne/projects?include=summary&limit=50");
    assert.equal(list.status, 200);
    assert.equal(list.body.projects.length, 1);
    const row = list.body.projects[0];
    assert.equal(row.id, pid);
    assert.equal(row.status, "active");
    assert.ok("latest_progress" in row, "summary 形体含最近进展字段");
    assert.deepEqual(row.pending, { unhandled_reports: 0, pending_verification: 0, blocked_intents: 0 });

    const def = await loadPage("projects");
    const api = async (path, options) => {
      const res = await fetch(base + path, {
        method: (options && options.method) || "GET",
        headers: { "Content-Type": "application/json", origin: base },
        body: options && options.body,
      });
      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = { raw: text };
      }
      if (!res.ok) {
        const err = new Error((data && data.message) || `HTTP ${res.status}`);
        err.status = res.status;
        err.code = data && data.code;
        err.body = data;
        throw err;
      }
      return data;
    };
    const ctx = makeCtx(api);
    const t = mountPage(def, ctx);
    await t.flush();

    assert.match(t.text(), /集成项目/);
    assert.match(t.text(), new RegExp(pid.replace(/-/g, "\\-")));
    assert.match(t.text(), /运行中/, "active 徽章");
    assert.match(t.text(), /数据时刻/);
    assert.doesNotMatch(t.text(), /加载更多项目/, "单页数据不渲染加载更多");

    // 行点击 → 工作区路由（项目上下文共享的入口）
    const rows = t.rowElements();
    assert.equal(rows.length, 1);
    t.click(rows[0]);
    const nav = ctx.router.__calls.find((c) => c.kind === "open");
    assert.equal(nav.hash, `#/p/${pid}/workbench`);
  }));
test("M3 创建/删除界面：名称+测试目标+测试任务+LLM 配置字段；行内删除需二次确认", async () => {
  const def = await loadPage("projects");
  const api = fakeApi({
    "GET /sorne/projects": { projects: [SUMMARY_ROW()], next_cursor: null, has_more: false },
    "GET /sorne/llm/settings": { configured: true, base_url: "https://api.example.com", model: "m1", api_key_set: true, api_key_hint: "sk-…" },
  });
  const t = mountPage(def, makeCtx(api));
  await t.flush();
  assert.match(t.text(), /新建项目/);
  assert.match(t.text(), /项目名称/);
  assert.match(t.text(), /测试目标/);
  assert.match(t.text(), /测试任务/);
  assert.match(t.text(), /LLM Base URL/);
  assert.match(t.text(), /LLM 模型名/);
  assert.match(t.text(), /LLM API Key/);

  const del = t.findAll((n) => n.type === "button" && String(n.props["aria-label"] || "").startsWith("删除项目"));
  assert.ok(del.length >= 1, "每行应有删除按钮");
  t.click(del[0]);
  await t.flush();
  assert.match(t.text(), /确认删除/, "删除需要二次确认");
  assert.match(t.text(), /取消/);
  const cancel = t.findAll((n) => n.type === "button" && t.nodeText(n.children) === "取消");
  assert.ok(cancel.length >= 1);
  t.click(cancel[0]);
  await t.flush();
  assert.doesNotMatch(t.text(), /确认删除/);
});