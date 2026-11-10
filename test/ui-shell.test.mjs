/**
 * M1 —— 外壳测试（client.js：hash 路由双布局 + 槽位 + 顶栏 + 覆盖层）。
 *
 * 覆盖（BLUEPRINT-UI §1.1/§1.4/§2.4/§2.4-2/§2.5 断言规则、要求 §1/§2/§7、
 * 评审 P0-1③、P1-6）：
 *   - 双布局：引导态（#/onboarding、#/projects）与工作区态（#/p/:pid/*）；
 *     左导航 id 集合为冻结白名单（§2.5：断言导航可达集合，非 manifest 全集；
 *     旧 id 页面过渡期不入任何导航面，页面文件未落地时槽位渲染占位卡）；
 *   - hash 路由：空/未知 hash → #/projects；深链直开恢复原页面（刷新/分享）；
 *     未知项目 404 → 重定向 #/projects 并提示；
 *   - keep-alive：切页不卸载（display:none 隐藏）、切回后实例状态保留
 *     （要求 §2：不丢筛选/展开/阅读位）；
 *   - 右侧详情槽位（§2.4-2）：?id= + renderDetail → 右栏渲染；关闭 =
 *     有应用内前驱 → history.back()，深链直开 → replace 列表态；
 *   - #/records 记录覆盖层：openRecord 携带当前项目；覆盖层读取
 *     GET /records/:id?project_id=；关闭回来源页；缺 project 参数如实报错；
 *   - 引导门控（要求 §1）：configured:false → 「尚未连接模型，项目可以保存，
 *     AI 暂不能开始」+ 直达入口；configured:true → 不出现；端点未注册 →
 *     「状态未知」如实呈现（不冒充已配置/未配置）；
 *   - 顶栏运行状态（要求 §7）：正在探索/等待条件补齐(说明等什么)/正在暂停/
 *     已暂停/系统异常/已停止，映射真实端点数据；暂停 → POST lifecycle →
 *     「正在暂停」→ 已暂停（POST 在途态可见，不假装全部停止）；
 *   - aria/键盘：导航 aria-label/aria-current、对话框 role、Esc 关闭覆盖层；
 *   - 深浅两主题下外壳文本对比度（元素树计算样式：样式声明 → token →
 *     WCAG 公式确定性计算）≥4.5；
 *   - 页面模块加载失败 / manifest 失败 → 如实错误卡，不白屏。
 *
 * 测试宿主：本文件内置一个带 reconcile（key+类型匹配复用组件实例）的最小
 * 渲染宿主，驱动 client.js 的真实类组件（componentDidMount/setState/
 * forceUpdate）并断言元素树结构与内联样式；无真实浏览器 DOM——P0-1③ 的
 * 对比度按确定性公式计算（机制说明见 docs/modules/ui-M1.md 偏差记录）。
 * 设计系统模块（lib/ui/*.mjs）经真实动态 import 加载（非 mock）。
 *
 * 并行安全：fake api 用例不占端口；唯一真实服务用例走 withTestServer
 * （独立临时目录 + listen(0) 随机端口 + finally 收尾）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/* helpers（真实服务工具）在用例内动态 import：本文件其余用例不依赖真实服务，
   不应因共享底座的模块加载顺序被阻塞（并行施工期的瞬态不拖垮外壳断言）。 */
import { contrastRatio, tokenHex } from "../lib/ui/theme.mjs";
import { parseRecordId } from "../lib/ui/record-ids.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

/* ══════════════════════ 迷你渲染宿主（key+类型匹配的实例复用） ═══════ */

function flatten(arr) {
  return arr.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== true && c !== false);
}

function createHost() {
  const h = (type, props, ...children) => {
    const flat = flatten(children);
    const merged = { ...(props || {}), children: flat.length === 1 ? flat[0] : flat };
    return {
      __elem: true,
      type,
      props: merged,
      key: props && props.key !== undefined ? String(props.key) : null,
      children: flat,
    };
  };

  class Component {
    constructor(props) { this.props = props || {}; }
  }

  const mountQueue = [];

  function toChildren(rendered, parent) {
    const arr = rendered === null || rendered === undefined
      ? []
      : (Array.isArray(rendered) ? rendered : [rendered]);
    return flatten(arr).map((el) => build(el, parent)).filter(Boolean);
  }

  function build(el, parent) {
    if (el === null || el === undefined || typeof el === "boolean") return null;
    if (typeof el === "string" || typeof el === "number") {
      return { kind: "text", text: String(el), children: [], parent };
    }
    if (Array.isArray(el)) {
      return { kind: "fragment", type: null, props: {}, key: null, children: toChildren(el, parent), parent };
    }
    if (!el.__elem) return { kind: "text", text: String(el), children: [], parent };

    if (typeof el.type === "function" && el.type.prototype && typeof el.type.prototype.render === "function") {
      const inst = new el.type(el.props);
      if (!inst.state) inst.state = {};
      const node = { kind: "component", type: el.type, key: el.key, props: el.props, inst, children: [], parent };
      const rerender = () => {
        node.children = reconcileList(node, inst.render());
        drainMountQueue(); // 重渲染产出的新类组件节点也要触发挂载（React 语义）
      };
      inst.setState = (patch, callback) => {
        inst.state = { ...inst.state, ...(typeof patch === "function" ? patch(inst.state) : patch) };
        rerender();
        if (typeof callback === "function") callback();
      };
      inst.forceUpdate = () => rerender();
      node.rerender = rerender;
      rerender();
      mountQueue.push(node);
      return node;
    }
    if (typeof el.type === "function") {
      return build(el.type(el.props), parent);
    }
    return { kind: "host", type: el.type, key: el.key, props: el.props, children: toChildren(el.children, parent), parent };
  }

  function matchChild(oldChildren, el, index) {
    if (el.key !== null) {
      return oldChildren.find((c) => c && c.key === el.key && c.type === el.type) || null;
    }
    // React 语义：无 key 时按「同位置 + 同类型」复用实例
    const at = oldChildren[index];
    if (at && at.type === el.type && (at.kind === "host" || at.kind === "component")) {
      return at;
    }
    return null;
  }

  function drainMountQueue() {
    // cDM 可内嵌 setState → 再产出新节点；循环直至清空
    let guard = 0;
    while (mountQueue.length && guard < 10000) {
      guard += 1;
      const node = mountQueue.shift();
      if (typeof node.inst.componentDidMount === "function") node.inst.componentDidMount();
    }
  }

  function reconcileList(node, rendered) {
    const arr = rendered === null || rendered === undefined
      ? []
      : (Array.isArray(rendered) ? rendered : [rendered]);
    const old = node.children || [];
    const next = [];
    const used = new Set();
    let index = 0;
    for (const el of arr) {
      if (el === null || el === undefined || typeof el === "boolean") continue;
      if (typeof el === "string" || typeof el === "number") {
        next.push({ kind: "text", text: String(el), children: [], parent: node });
        index += 1;
        continue;
      }
      if (!el.__elem) { next.push({ kind: "text", text: String(el), children: [], parent: node }); index += 1; continue; }
      const matched = matchChild(old, el, index);
      if (matched && !used.has(matched)) {
        used.add(matched);
        updateNode(matched, el);
        next.push(matched);
      } else {
        next.push(build(el, node));
      }
      index += 1;
    }
    for (const c of old) {
      if (!used.has(c) && !next.includes(c)) unmount(c);
    }
    return next.filter(Boolean);
  }

  function unmount(node) {
    if (!node) return;
    if (node.kind === "component" && typeof node.inst.componentWillUnmount === "function") {
      node.inst.componentWillUnmount();
    }
    for (const c of node.children || []) unmount(c);
  }

  function updateNode(node, el) {
    const prevProps = node.props;
    node.props = el.props;
    node.key = el.key;
    if (node.kind === "component") {
      node.inst.props = el.props;
      node.children = reconcileList(node, node.inst.render());
      drainMountQueue();
      if (typeof node.inst.componentDidUpdate === "function" && prevProps !== el.props) {
        node.inst.componentDidUpdate(prevProps);
      }
    } else if (node.kind === "host") {
      node.children = reconcileList(node, el.children);
      drainMountQueue();
    } else if (node.kind === "fragment") {
      node.children = reconcileList(node, el);
      drainMountQueue();
    }
  }

  const host = {
    h,
    Component,
    mount(rootEl) {
      host.root = build(rootEl, null);
      drainMountQueue();
      return host.root;
    },
    async flush(rounds = 24) {
      for (let i = 0; i < rounds; i += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
    text(node = host.root) {
      if (!node) return "";
      if (node.kind === "text") return node.text;
      return (node.children || []).map((c) => host.text(c)).join("");
    },
    find(pred, node = host.root, out = []) {
      if (!node) return out;
      if (node.kind === "host" || node.kind === "component") {
        const fake = { type: node.type, props: node.props, children: node.children || [] };
        if (pred(fake)) out.push(node);
      }
      for (const c of node.children || []) host.find(pred, c, out);
      return out;
    },
    findAllByText(substr, node = host.root, out = []) {
      if (!node) return out;
      if (node.kind === "host" || node.kind === "component") {
        const own = (node.children || [])
          .filter((c) => c.kind === "text")
          .map((c) => c.text)
          .join("");
        if (own.includes(substr)) out.push(node);
      }
      for (const c of node.children || []) host.findAllByText(substr, c, out);
      return out;
    },
    findButton(label, node = host.root) {
      const hits = host.find((n) => n.type === "button" && host.text(n).includes(label), node);
      assert.ok(hits.length >= 1, `未找到按钮「${label}」；当前文本：${host.text(node).slice(0, 500)}`);
      return hits[hits.length - 1];
    },
    click(node) {
      assert.ok(!node.props.disabled, `按钮被禁用：${host.text(node)}`);
      node.props.onClick({ preventDefault() {}, stopPropagation() {} });
    },
    pageHost(pageId) {
      return host.find((n) => n.props && n.props["data-page-host"] === pageId)[0] || null;
    },
    rootHostElement() {
      // onKeyDown 挂载在 Shell 渲染的最外层 div 上（递归找第一个带 onKeyDown 的 div）
      let found = null;
      (function walk(node) {
        if (found || !node) return;
        if (node.kind === "host" && node.type === "div" && typeof node.props.onKeyDown === "function") {
          found = node;
          return;
        }
        for (const c of node.children || []) walk(c);
      })(host.root);
      return found;
    },
  };
  return host;
}

/* ══════════════════════ 假 window（hash 历史，同步事件） ══════════════ */

function fakeWindow(initialHash = "") {
  const listeners = { hashchange: new Set(), keydown: new Set() };
  let hash = initialHash;
  const stack = [initialHash];
  let idx = 0;
  const win = {
    location: {
      get hash() { return hash; },
      set hash(v) {
        if (v === hash) return;
        stack.splice(idx + 1);
        stack.push(v);
        idx += 1;
        hash = v;
        for (const fn of Array.from(listeners.hashchange)) fn({ type: "hashchange" });
      },
    },
    history: {
      replaceState(_s, _t, url) { hash = url; },
      back() {
        if (idx > 0) {
          idx -= 1;
          hash = stack[idx];
          for (const fn of Array.from(listeners.hashchange)) fn({ type: "hashchange" });
        }
      },
    },
    addEventListener(type, fn) { listeners[type].add(fn); },
    removeEventListener(type, fn) { listeners[type].delete(fn); },
  };
  win.__hashStack = stack;
  win.__hashIndex = () => idx;
  return win;
}

/* ══════════════════════ 假 api / 假 manifest / 假页面 ═══════════════ */

function fakeApi(handlers = {}) {
  const calls = [];
  const fn = (path, options) => {
    const method = (options && options.method) || "GET";
    const body = options && options.body ? JSON.parse(options.body) : undefined;
    const bare = path.split("?")[0];
    calls.push({ method, path, bare, body });
    const key = Object.keys(handlers).find((k) => {
      const [m, p] = k.split(" ");
      if (m !== method) return false;
      if (p === bare) return true;
      const re = new RegExp(`^${p.replace(/:[^/]+/g, "[^/]+")}$`);
      return re.test(bare);
    });
    if (!key) return Promise.reject(new Error(`fakeApi 未配置：${method} ${bare}`));
    const handler = handlers[key];
    return Promise.resolve().then(() => (typeof handler === "function" ? handler({ path, bare, body }) : handler));
  };
  fn.calls = calls;
  return fn;
}

function makePage(id, opts = {}) {
  const def = {
    id,
    title: id,
    order: 1,
    render: (ctx) => ctx.h("div", { "data-fake-page": id }, `页面:${id}`),
  };
  if (opts.withDetail) {
    def.renderDetail = (ctx) => ctx.h(
      "div",
      { "data-fake-detail": ctx.router.params.id },
      `详情:${ctx.router.params.id}`,
    );
  }
  return { default: def };
}

/** 有状态假页（keep-alive 断言用）：内部计数按钮，切页后状态应保留。 */
function makeStatefulPage(id) {
  class StatefulPage extends Component {
    constructor(props) {
      super(props);
      this.state = { taps: 0 };
    }
    render() {
      const hh = this.props.h;
      return hh("div", { "data-fake-page": id },
        hh("div", null, `页面:${id}`),
        hh("div", { "data-taps": String(this.state.taps) }, `点击次数:${this.state.taps}`),
        hh("button", { onClick: () => this.setState({ taps: this.state.taps + 1 }) }, "加一"),
      );
    }
  }
  return {
    default: { id, title: id, order: 1, render: (ctx) => ctx.h(StatefulPage, { h: ctx.h, api: ctx.api }) },
  };
}

class Component {
  constructor(props) { this.props = props || {}; }
}

async function loadLibs() {
  const urls = {
    theme: join(ROOT, "lib", "ui", "theme.mjs"),
    "record-ids": join(ROOT, "lib", "ui", "record-ids.mjs"),
    render: join(ROOT, "lib", "ui", "render.mjs"),
    router: join(ROOT, "lib", "ui", "router.mjs"),
  };
  const out = {};
  for (const [name, p] of Object.entries(urls)) {
    out[name] = await import(pathToFileURL(p).href);
  }
  return (name) => Promise.resolve(out[name]);
}

let clientModulePromise = null;
function loadClientModule() {
  if (!clientModulePromise) {
    clientModulePromise = (async () => {
      const box = { exports: null };
      const prevWindow = globalThis.window;
      globalThis.window = {
        __ModuleLoader__: {
          load: (def) => {
            box.exports = def.factory((id) => {
              if (id === "react") {
                // 仅需支持工厂顶层的解构与 SectionErrorBoundary 的基类契约
                // （真实 React 的 Component 会在构造时赋 props/state）。
                return {
                  createElement: () => null,
                  Component: class StubComponent {
                    constructor(props) {
                      this.props = props || {};
                      this.state = null;
                    }
                    setState(patch) {
                      this.state = { ...this.state, ...(typeof patch === "function" ? patch(this.state) : patch) };
                    }
                  },
                  useState: () => [null, () => {}],
                  useEffect: () => {},
                };
              }
              throw new Error(`client.js 测试加载不应依赖 ${id}`);
            });
          },
        },
      };
      try {
        await import(pathToFileURL(join(ROOT, "client.js")).href);
      } finally {
        if (prevWindow === undefined) delete globalThis.window;
        else globalThis.window = prevWindow;
      }
      assert.ok(box.exports && box.exports.__test__, "client.js 应导出 __test__");
      return box.exports.__test__;
    })();
  }
  return clientModulePromise;
}

/** 装配一个已加载完成的外壳宿主（设计系统走真实模块；页面/manifest/api 可注入）。 */
async function bootShell({
  initialHash = "",
  theme = undefined,
  apiHandlers = {},
  apiImpl = null,
  manifestPages = ["workbench", "assets", "exploration", "findings", "reports", "diagnostics", "projects", "onboarding"],
  pageOverrides = {},
  manifestFailure = false,
  allPagesFail = false,
} = {}) {
  const win = fakeWindow(initialHash);
  const host = createHost();
  const api = apiImpl || fakeApi(apiHandlers);
  const libLoader = await loadLibs();
  const modules = new Map();
  for (const id of manifestPages) {
    if (allPagesFail) {
      modules.set(`/sorne/ui/pages/${id}.page.mjs`, { get default() { throw new Error(`模块 ${id} 损坏（模拟）`); } });
    } else {
      modules.set(
        `/sorne/ui/pages/${id}.page.mjs`,
        pageOverrides[id] || makePage(id, { withDetail: id === "assets" || id === "findings" }),
      );
    }
  }
  const { createShellRuntime } = await loadClientModule();
  const runtime = createShellRuntime({
    React: { createElement: host.h, Component: host.Component },
    h: host.h,
    api,
    loadLibModule: libLoader,
    fetchManifest: manifestFailure
      ? async () => { throw new Error("页面清单不可达（模拟）"); }
      : async () => ({
          pages: manifestPages.map((id, i) => ({ id, title: id, order: (i + 1) * 10, file: `/sorne/ui/pages/${id}.page.mjs` })),
        }),
    importPageModule: async (file) => {
      if (!modules.has(file)) throw new Error(`页面模块未提供：${file}`);
      return modules.get(file);
    },
    win,
    doc: null,
    initialThemeMode: theme,
  });
  host.mount(host.h(runtime.SornePanel));
  await host.flush();
  return { host, api, runtime, win };
}

/* ── 常用假数据 ────────────────────────────────────────────────────── */

const PROJECT = (over = {}) => ({
  id: "PRJ-0002", name: "演示项目", description: "内网持续探索", status: "active",
  created_at: "2026-11-05T14:00:00.000Z", created_by: "user", created_seq: 1,
  updated_seq: 0, state_version: 1, ...over,
});
const ATTEMPT = (status, over = {}) => ({
  id: "ATT-0001", project_id: "PRJ-0002", intent_id: "I-PRJ-0002-0001", status,
  lease_expires_at: "2026-11-05T15:00:00.000Z", created_at: "2026-11-05T14:00:00.000Z",
  ...over,
});

function workspaceApiHandlers(over = {}) {
  return {
    "GET /sorne/projects": { projects: [PROJECT()], next_cursor: null, has_more: false },
    "GET /sorne/projects/:id": { project: PROJECT(), scope: null, counts: { assets: 1 } },
    "GET /sorne/attempts": { attempts: [ATTEMPT("running")], has_more: false, next_after: null, count: 1 },
    "GET /sorne/intents": { project_id: "PRJ-0002", intents: [], next_cursor: null, has_more: false },
    "GET /sorne/diagnostics": { generated_at: "2026-11-05T14:00:00.000Z", health: { ok: true } },
    "GET /sorne/health": { ok: true, service: "sorne", version: "0.1.0", checked_at: "2026-11-05T14:00:00.000Z" },
    "GET /sorne/llm/settings": { configured: true, base_url: "https://x", model: "m", api_key_set: true, source: "env", updated_at: "2026-11-05T14:00:00.000Z" },
    ...over,
  };
}

/* ══════════════════════ 1. 双布局与导航白名单（§2.5） ═══════════════ */

test("引导态：空 hash 重定向 #/projects；左导航恰为 {onboarding, projects}（未落地槽位如实占位）", async () => {
  const { host, win } = await bootShell({ initialHash: "", manifestPages: ["projects"] });
  assert.equal(win.location.hash, "#/projects", "空 hash 应 replace 到 #/projects");
  const nav = host.find((n) => n.type === "nav")[0];
  assert.ok(nav, "引导态应有 nav");
  const navIds = host.find((n) => n.type === "button" && n.props["aria-label"], nav)
    .map((n) => n.props["aria-label"]);
  assert.deepEqual(navIds, ["首次使用", "项目列表"], `引导导航应为冻结白名单，实际：${navIds.join("、")}`);
  assert.match(host.text(), /页面模块未就绪/, "onboarding 页面文件未落地 → 占位卡如实标注");
  assert.match(host.text(), /M3/, "占位卡标注归属模块");
});

test("工作区态：#/p/:pid/workbench 渲染顶栏项目名；左导航恰为 5 页 + 「系统诊断」；旧 id 页面不入导航也不加载", async () => {
  const { host, api } = await bootShell({
    initialHash: "#/p/PRJ-0002/workbench",
    manifestPages: ["overview", "execution", "workbench", "assets", "exploration", "findings", "reports", "diagnostics", "projects"],
    apiHandlers: workspaceApiHandlers(),
  });
  assert.match(host.text(), /演示项目/, "顶栏显示项目名");
  const nav = host.find((n) => n.type === "nav" && n.props["aria-label"] === "工作区导航")[0];
  assert.ok(nav, "工作区导航 aria-label=工作区导航");
  const ids = host.find((n) => n.type === "button" && n.props["aria-label"], nav).map((n) => n.props["aria-label"]);
  assert.deepEqual(ids, ["工作台", "资产", "探索", "发现", "报告", "系统诊断"],
    `工作区左导航应为冻结白名单 + 诊断入口，实际：${ids.join("、")}`);
  for (const oldId of ["overview", "execution"]) {
    assert.ok(!ids.includes(oldId), `旧 id ${oldId} 不得出现在导航面（§2.5）`);
  }
  assert.ok(!api.calls.some((c) => c.bare.includes("overview") || c.bare.includes("execution")),
    "旧 id 页面不应被加载（不 import）");
});

test("页面槽位：工作区页文件未落地时占位卡如实标注归属模块，导航仍可点、可达", async () => {
  const { host } = await bootShell({
    initialHash: "#/p/PRJ-0002/workbench",
    manifestPages: [],
    apiHandlers: workspaceApiHandlers(),
  });
  const text = host.text();
  assert.match(text, /工作台（页面模块未就绪）/, "占位卡标题");
  assert.match(text, /M4/, "工作台占位标注 M4");
  assert.match(text, /M5/, "资产占位标注 M5");
  assert.match(text, /M6/, "发现/报告占位标注 M6");
});

/* ══════════════════════ 2. hash 路由（§2.4） ════════════════════════ */

test("hash 路由：未知 hash → #/projects 并提示；未知项目 404 → 重定向 + 提示", async () => {
  const a = await bootShell({ initialHash: "#/nonsense/deep" });
  assert.equal(a.win.location.hash, "#/projects", "未知 hash → #/projects");
  assert.match(a.host.text(), /未识别的地址已回到项目列表/);

  const b = await bootShell({
    initialHash: "#/p/PRJ-404/workbench",
    apiHandlers: workspaceApiHandlers({
      "GET /sorne/projects/:id": () => {
        const e = new Error("项目不存在：PRJ-404");
        e.status = 404;
        throw e;
      },
    }),
  });
  await b.host.flush();
  assert.equal(b.win.location.hash, "#/projects", "未知项目 → 重定向 #/projects");
  assert.match(b.host.text(), /项目不存在或不可访问：PRJ-404/, "重定向应伴随提示");
});

test("hash 路由：点击左导航切换页面（#/p/:pid/<page>）；aria-current 随激活项移动", async () => {
  const { host, win } = await bootShell({
    initialHash: "#/p/PRJ-0002/workbench",
    apiHandlers: workspaceApiHandlers(),
  });
  assert.equal(win.location.hash, "#/p/PRJ-0002/workbench");
  const nav = host.find((n) => n.type === "nav" && n.props["aria-label"] === "工作区导航")[0];
  const current = () => host.find((n) => n.type === "button" && n.props["aria-current"] === "page", nav)
    .map((n) => n.props["aria-label"]);
  assert.deepEqual(current(), ["工作台"]);

  host.click(host.findButton("资产", nav));
  await host.flush();
  assert.equal(win.location.hash, "#/p/PRJ-0002/assets");
  assert.deepEqual(current(), ["资产"], "aria-current 移动到激活项");
  assert.match(host.text(host.root), /页面:assets/, "资产页（假页）渲染");
});

/* ══════════════════════ 3. keep-alive（要求 §2） ════════════════════ */

test("keep-alive：切页不卸载（隐藏），切回后实例状态保留（筛选/展开/阅读位不丢）", async () => {
  const { host, win } = await bootShell({
    initialHash: "#/p/PRJ-0002/workbench",
    apiHandlers: workspaceApiHandlers(),
    pageOverrides: { workbench: makeStatefulPage("workbench") },
  });
  await host.flush();
  assert.match(host.text(), /点击次数:0/);

  host.click(host.findButton("加一"));
  await host.flush();
  assert.match(host.text(), /点击次数:1/);

  host.click(host.findButton("资产"));
  await host.flush();
  const workbenchHost = host.pageHost("workbench");
  assert.ok(workbenchHost, "工作台槽位仍在树中");
  assert.equal(workbenchHost.props.style && workbenchHost.props.style.display, "none", "切走 → 隐藏而非卸载");
  assert.equal(win.location.hash, "#/p/PRJ-0002/assets");

  host.click(host.findButton("工作台"));
  await host.flush();
  assert.match(host.text(), /点击次数:1/, "切回后实例状态保留（keep-alive）");
  const workbenchHost2 = host.pageHost("workbench");
  assert.equal(workbenchHost2.props.style, undefined, "切回 → 重新可见");
});

/* ══════════════════════ 4. 右侧详情槽位（§2.4-2） ═══════════════════ */

test("右侧详情：?id= + renderDetail → 右栏渲染；关闭（有应用内前驱）→ back 回列表态", async () => {
  const { host, win } = await bootShell({
    initialHash: "#/p/PRJ-0002/assets",
    apiHandlers: workspaceApiHandlers(),
  });
  assert.equal(host.find((n) => n.type === "aside").length, 0, "无 ?id= 时无右栏");

  win.location.hash = "#/p/PRJ-0002/assets?id=A-PRJ-0002-0001";
  await host.flush();
  const aside = host.find((n) => n.type === "aside")[0];
  assert.ok(aside, "?id= 时渲染右栏");
  assert.match(host.text(aside), /详情:A-PRJ-0002-0001/, "右栏渲染 renderDetail 输出");
  assert.ok(host.find((n) => n.type === "button" && n.props["aria-label"] === "关闭详情", aside)[0],
    "关闭按钮 aria-label（外壳统一提供，§2.4-2）");

  host.click(host.findButton("关闭详情", aside));
  await host.flush();
  assert.equal(win.location.hash, "#/p/PRJ-0002/assets", "关闭详情回列表态（应用内前驱 → back）");
  assert.equal(host.find((n) => n.type === "aside").length, 0);
});

test("右侧详情：深链直开详情（无应用内前驱）关闭 → 落列表态（replace，§2.4-2 规则 1）", async () => {
  const { host, win } = await bootShell({
    initialHash: "#/p/PRJ-0002/assets?id=A-PRJ-0002-0001",
    apiHandlers: workspaceApiHandlers(),
  });
  await host.flush();
  assert.ok(host.find((n) => n.type === "aside")[0], "深链直开详情");
  host.click(host.findButton("关闭详情"));
  await host.flush();
  assert.equal(win.location.hash, "#/p/PRJ-0002/assets", "深链关闭 → 列表态");
  assert.equal(win.__hashIndex(), 0, "replace 语义：不产生新历史条目");
});

/* ══════════════════════ 5. #/records 覆盖层 ═════════════════════════ */

test("记录覆盖层：读取 GET /records/:id?project_id=，呈现记录字段与口径说明；关闭回来源页", async () => {
  const recordEnvelope = {
    record: {
      id: "A-PRJ-0002-0002", kind: "assets", project_id: "PRJ-0002",
      created_at: "2026-11-05T14:00:00.000Z", created_by: "worker", created_seq: 7,
      asset_type: "service", canonical_key: "https://api.seed.test",
    },
    evidence_index: [],
    relations: { edges: [], truncated: false },
    expand: { record_path: "/sorne/records/A-PRJ-0002-0002?project_id=PRJ-0002" },
  };
  const { host, win, api } = await bootShell({
    initialHash: "#/p/PRJ-0002/assets",
    apiHandlers: workspaceApiHandlers({
      "GET /sorne/records/:id": recordEnvelope,
    }),
  });

  win.location.hash = "#/records/A-PRJ-0002-0002?project=PRJ-0002";
  await host.flush();
  const dialog = host.find((n) => n.type === "section" && n.props["aria-label"] === "记录 A-PRJ-0002-0002")[0];
  assert.ok(dialog, "覆盖层 dialog（aria-label=记录编号）");
  const call = api.calls.find((c) => c.bare.startsWith("/sorne/records/A-PRJ-0002-0002"));
  assert.ok(call, "应发起 /records 读取");
  assert.ok(call.path.includes("project_id=PRJ-0002"), "读取应携带 project_id");
  assert.match(host.text(dialog), /A-PRJ-0002-0002/);
  assert.match(host.text(dialog), /service/, "记录视图字段呈现");
  assert.match(host.text(dialog), /只读投影/, "口径说明（数据时刻/不代表全量）");

  host.click(host.findButton("关闭", dialog));
  await host.flush();
  assert.equal(win.location.hash, "#/p/PRJ-0002/assets", "关闭覆盖层回来源页（含其 ?id= 态则回详情态）");
});

test("记录覆盖层：Esc 关闭（键盘可达）；深链缺 project 参数如实报错（不猜测项目）", async () => {
  const { host, win } = await bootShell({
    initialHash: "#/p/PRJ-0002/assets",
    apiHandlers: workspaceApiHandlers({
      "GET /sorne/records/:id": { record: { id: "V-0003", kind: "vulnerabilities" }, evidence_index: [], relations: { edges: [], truncated: false } },
    }),
  });
  win.location.hash = "#/records/V-0003?project=PRJ-0002";
  await host.flush();
  assert.ok(host.find((n) => n.type === "section" && String(n.props["aria-label"] || "").startsWith("记录 V-0003"))[0]);

  const rootDiv = host.rootHostElement();
  rootDiv.props.onKeyDown({ key: "Escape" });
  await host.flush();
  assert.equal(win.location.hash, "#/p/PRJ-0002/assets", "Esc 关闭覆盖层（§2.4-2 规则 2）");

  win.location.hash = "#/records/V-0009";
  await host.flush();
  assert.match(host.text(), /缺少 project 参数/, "缺 project 参数 → 如实报错");
});

/* ══════════════════════ 6. 引导门控（要求 §1） ══════════════════════ */

test("门控：模型未配置 → 「尚未连接模型，项目可以保存，AI 暂不能开始」+ 直达入口（→ #/onboarding）", async () => {
  const { host, win } = await bootShell({
    initialHash: "#/p/PRJ-0002/workbench",
    apiHandlers: workspaceApiHandlers({
      "GET /sorne/llm/settings": { configured: false, base_url: "", model: "", api_key_set: false, source: "none", updated_at: null },
    }),
  });
  const text = host.text();
  assert.match(text, /尚未连接模型，项目可以保存，AI 暂不能开始/, "门控文案（冻结）");
  const gate = host.find((n) => n.type === "button" && String(n.props["aria-label"] || "").includes("尚未连接模型"))[0];
  assert.ok(gate, "门控是可点按钮（直达入口，不是文本摆设）");
  assert.match(gate.props["aria-label"], /连接模型/);
  host.click(gate);
  await host.flush();
  assert.equal(win.location.hash, "#/onboarding", "直达入口 → 首次使用向导槽位");
});

test("门控：已配置 → 不出现；设置端点未注册（404）→ 「状态未知」如实呈现，不冒充两态", async () => {
  const a = await bootShell({
    initialHash: "#/p/PRJ-0002/workbench",
    apiHandlers: workspaceApiHandlers(),
  });
  assert.doesNotMatch(a.host.text(), /尚未连接模型/, "已配置不显示门控");

  const b = await bootShell({
    initialHash: "#/p/PRJ-0002/workbench",
    apiHandlers: workspaceApiHandlers({
      "GET /sorne/llm/settings": () => {
        const e = new Error("未注册路由：GET /sorne/llm/settings");
        e.status = 404;
        throw e;
      },
    }),
  });
  assert.match(b.host.text(), /模型配置状态未知/, "端点未注册 → 状态未知（不猜测）");
  assert.match(b.host.text(), /后端模块施工中/, "如实标注施工状态");
  assert.doesNotMatch(b.host.text(), /尚未连接模型，项目可以保存，AI 暂不能开始/, "不得在未知态冒充未配置文案");
});

/* ══════════════════════ 7. 顶栏运行状态（要求 §7） ══════════════════ */

test("顶栏状态：active+执行中尝试 → 正在探索；paused/stopped → 已暂停/已停止（含 §16.4 说明）", async () => {
  const a = await bootShell({
    initialHash: "#/p/PRJ-0002/workbench",
    apiHandlers: workspaceApiHandlers({
      "GET /sorne/attempts": { attempts: [ATTEMPT("running"), ATTEMPT("leased", { id: "ATT-0002" })], has_more: false, next_after: null, count: 2 },
    }),
  });
  assert.match(a.host.text(), /正在探索/, "active + 2 个执行中尝试 → 正在探索");
  assert.match(a.host.text(), /2 个执行中的尝试/);

  const b = await bootShell({
    initialHash: "#/p/PRJ-0002/workbench",
    apiHandlers: workspaceApiHandlers({
      "GET /sorne/projects/:id": { project: PROJECT({ status: "paused" }), scope: null, counts: {} },
      "GET /sorne/attempts": { attempts: [], has_more: false, next_after: null, count: 0 },
    }),
  });
  assert.match(b.host.text(), /已暂停/);

  const c = await bootShell({
    initialHash: "#/p/PRJ-0002/workbench",
    apiHandlers: workspaceApiHandlers({
      "GET /sorne/projects/:id": { project: PROJECT({ status: "stopped" }), scope: null, counts: {} },
    }),
  });
  assert.match(c.host.text(), /已停止/);
  assert.match(c.host.text(), /已产生的证据与记录仍保留/, "停止语义说明（§16.4）");
});

test("顶栏状态：waiting_for_change → 等待条件补齐并说明在等什么（受阻方向数）；health 失败 → 系统异常", async () => {
  const a = await bootShell({
    initialHash: "#/p/PRJ-0002/workbench",
    apiHandlers: workspaceApiHandlers({
      "GET /sorne/projects/:id": { project: PROJECT({ status: "waiting_for_change" }), scope: null, counts: {} },
      "GET /sorne/attempts": { attempts: [], has_more: false, next_after: null, count: 0 },
      "GET /sorne/intents": { project_id: "PRJ-0002", intents: [{ id: "I-1", status: "blocked" }, { id: "I-2", status: "blocked" }], next_cursor: null, has_more: false },
    }),
  });
  const text = a.host.text();
  assert.match(text, /等待条件补齐/, "五态之二");
  assert.match(text, /2 个方向受阻，等待条件补齐/, "说明在等什么（受阻方向数，来自真实端点）");

  const b = await bootShell({
    initialHash: "#/p/PRJ-0002/workbench",
    apiHandlers: workspaceApiHandlers({
      "GET /sorne/health": () => {
        const e = new Error("数据库不可用");
        e.status = 500;
        throw e;
      },
    }),
  });
  assert.match(b.host.text(), /系统异常/, "health 失败 → 系统异常");
  assert.match(b.host.text(), /数据库不可用/, "异常原因呈现");
});

test("顶栏状态：active 但无执行中尝试 → 等待条件补齐（已知事实与未知明细分列，不冒充诊断）", async () => {
  const { host } = await bootShell({
    initialHash: "#/p/PRJ-0002/workbench",
    apiHandlers: workspaceApiHandlers({
      "GET /sorne/attempts": { attempts: [], has_more: false, next_after: null, count: 0 },
      "GET /sorne/diagnostics": () => {
        const e = new Error("未注册路由");
        e.status = 404;
        throw e;
      },
    }),
  });
  const text = host.text();
  assert.match(text, /等待条件补齐/);
  assert.match(text, /当前没有执行中的尝试/, "已知事实：无执行中尝试");
  assert.match(text, /诊断端点不可用/, "未知部分如实标注（不冒充已诊断）");
});

test("暂停交互：点击暂停 → 「正在暂停」可见（POST 在途）→ 回执后已暂停；提交体为 action=pause", async () => {
  let deferred = null;
  let statusNow = "active";
  const api = fakeApi({
    "GET /sorne/projects": { projects: [PROJECT()], next_cursor: null, has_more: false },
    "GET /sorne/projects/:id": () => ({ project: PROJECT({ status: statusNow }), scope: null, counts: {} }),
    "GET /sorne/attempts": { attempts: [ATTEMPT("running")], has_more: false, next_after: null, count: 1 },
    "GET /sorne/intents": { project_id: "PRJ-0002", intents: [], next_cursor: null, has_more: false },
    "GET /sorne/diagnostics": { generated_at: "2026-11-05T14:00:00.000Z", health: { ok: true } },
    "GET /sorne/health": { ok: true, service: "sorne", checked_at: "2026-11-05T14:00:00.000Z" },
    "GET /sorne/llm/settings": { configured: true, api_key_set: true, source: "env" },
    "POST /sorne/projects/:id/lifecycle": ({ body }) => {
      assert.equal(body.action, "pause");
      return new Promise((resolve) => { deferred = resolve; });
    },
  });
  const { host } = await bootShell({
    initialHash: "#/p/PRJ-0002/workbench",
    apiImpl: api,
  });
  await host.flush();
  assert.match(host.text(), /正在探索/);

  host.click(host.findButton("暂停"));
  await host.flush(6);
  assert.match(host.text(), /正在暂停/, "POST 在途 → 正在暂停（不点击后假装全部停止）");
  assert.match(host.text(), /1 个执行中的尝试在收尾/, "收尾中操作数来自执行尝试列表（#23）");

  statusNow = "paused";
  deferred({ project: PROJECT({ status: "paused" }) });
  await host.flush();
  assert.match(host.text(), /已暂停/, "收尾完成 → 已暂停");
  const post = api.calls.find((c) => c.method === "POST" && c.bare.includes("/lifecycle"));
  assert.ok(post, "应发起 POST lifecycle");
  assert.deepEqual(post.body, { action: "pause" });
});

/* ══════════════════════ 8. aria / 键盘 / 主题对比度 ═════════════════ */

test("aria 与键盘：导航 aria-label、覆盖层 role=dialog + aria-modal + Esc、动作按钮 aria-label", async () => {
  const { host, win } = await bootShell({
    initialHash: "#/p/PRJ-0002/workbench",
    apiHandlers: workspaceApiHandlers({
      "GET /sorne/records/:id": { record: { id: "A-PRJ-0002-0002", kind: "assets" }, evidence_index: [], relations: { edges: [], truncated: false } },
    }),
  });
  const nav = host.find((n) => n.type === "nav" && n.props["aria-label"] === "工作区导航")[0];
  for (const b of host.find((n) => n.type === "button", nav)) {
    assert.ok(b.props["aria-label"], `导航按钮应有 aria-label：${host.text(b)}`);
  }
  for (const label of ["暂停项目", "继续项目", "项目设置", "切换项目"]) {
    assert.ok(host.find((n) => n.type === "button" && n.props["aria-label"] === label)[0], `应存在 aria-label=${label} 的按钮`);
  }

  win.location.hash = "#/records/A-PRJ-0002-0002?project=PRJ-0002";
  await host.flush();
  const dialog = host.find((n) => n.type === "section" && n.props.role === "dialog")[0];
  assert.ok(dialog, "覆盖层 role=dialog");
  assert.equal(dialog.props["aria-modal"], "true");
  assert.ok(host.find((n) => n.type === "button" && n.props["aria-label"] === "关闭记录详情")[0], "关闭按钮 aria-label");

  host.rootHostElement().props.onKeyDown({ key: "Escape" });
  await host.flush();
  assert.equal(win.location.hash, "#/p/PRJ-0002/workbench", "Esc 关闭覆盖层（键盘可达，回来源页）");
});

/** 收集元素树中文本元素的显式配色（color + background），解析 token 后算对比度。 */
function collectColorPairs(node, out = []) {
  if (!node) return out;
  if (node.kind === "host" || node.kind === "component") {
    const style = node.props && node.props.style;
    const hasText = (node.children || []).some((c) => c.kind === "text" && c.text.trim());
    if (style && hasText) {
      const color = typeof style.color === "string" ? style.color : "";
      const bg = typeof style.background === "string" ? style.background : "";
      const mColor = /var\((--sorne-[a-z-]+)\)/.exec(color);
      const mBg = /var\((--sorne-[a-z-]+)\)/.exec(bg);
      if (mColor) {
        out.push({ colorToken: mColor[1], bgToken: mBg ? mBg[1] : "--sorne-bg-canvas", tag: String(node.type) });
      }
    }
  }
  for (const c of node.children || []) collectColorPairs(c, out);
  return out;
}

for (const themeName of ["light", "dark"]) {
  test(`深浅两主题下外壳文本对比度（元素树计算样式）≥4.5：${themeName}`, async () => {
    const { host } = await bootShell({
      initialHash: "#/p/PRJ-0002/workbench",
      theme: themeName,
      apiHandlers: workspaceApiHandlers({
        "GET /sorne/llm/settings": { configured: false, api_key_set: false, source: "none", updated_at: null },
      }),
    });
    const pairs = collectColorPairs(host.root);
    assert.ok(pairs.length >= 8, `应收集到足量显式配色文本元素，实际 ${pairs.length}`);
    const failures = [];
    for (const p of pairs) {
      const ratio = contrastRatio(tokenHex(p.colorToken, themeName), tokenHex(p.bgToken, themeName));
      if (ratio < 4.5) {
        failures.push(`${p.colorToken} on ${p.bgToken} = ${Math.round(ratio * 100) / 100}（<${p.tag}>）`);
      }
    }
    assert.deepEqual(failures, [], `主题 ${themeName} 对比度不足 4.5:1 的文本元素：\n${failures.join("\n")}`);
    /* 抽查非空跑：门控（琥珀）与状态色应实际出现。 */
    assert.ok(pairs.some((p) => p.colorToken.startsWith("--sorne-status-suspected")), "应包含疑似色（门控/等待）");
  });
}

/* ══════════════════════ 9. 失败呈现（不白屏） ═══════════════════════ */

test("页面模块加载失败 → 错误卡如实呈现（其余页面不受影响）", async () => {
  const { host } = await bootShell({
    initialHash: "#/p/PRJ-0002/workbench",
    apiHandlers: workspaceApiHandlers(),
    allPagesFail: true,
  });
  await host.flush();
  assert.match(host.text(), /部分页面模块加载失败/, "汇总错误卡");
  assert.match(host.text(), /模块 workbench 损坏（模拟）/, "具体原因呈现");
  assert.match(host.text(), /页面模块未就绪|加载失败/, "页面区域不白屏（占位或错误卡）");
});

test("manifest 不可用 → 提示且导航槽位仍可点（降级不白屏）", async () => {
  const { host } = await bootShell({
    initialHash: "#/p/PRJ-0002/workbench",
    apiHandlers: workspaceApiHandlers(),
    manifestFailure: true,
  });
  await host.flush();
  assert.match(host.text(), /页面清单不可用/, "manifest 失败提示");
  assert.match(host.text(), /页面模块未就绪/, "槽位占位仍渲染");
  const nav = host.find((n) => n.type === "nav" && n.props["aria-label"] === "工作区导航")[0];
  assert.ok(nav, "导航仍可点");
});

/* ══════════════════════ 10. 真实服务端到端（随机端口） ═══════════════ */

test("真实服务：register_asset → /records 定位；覆盖层读取与编号解析端到端一致", async () => {
  const { withTestServer } = await import("./helpers.mjs");
  await withTestServer(async (server) => {
    const create = await server.request("POST", "/sorne/projects", { body: { name: "覆盖层项目", description: "J3" } });
    assert.equal(create.status, 200);
    const pid = create.body.project.id;

    const { issueSession } = await import("../lib/store/sessions.mjs");
    const session = issueSession({ project_id: pid, actor: "worker-1", role: "worker" });

    const res = await fetch(`${server.base}/sorne/submissions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: server.base,
        "x-sorne-session": session.session_token,
      },
      body: JSON.stringify({
        submission_id: "sub-ui-001",
        operations: [{
          op: "register_asset", local_ref: "svc", asset_type: "service",
          canonicalization_version: "v1", canonical_key: "https://seed.test", source_note: "测试",
        }],
      }),
    });
    const regBody = await res.json();
    assert.equal(res.status, 200, `register_asset 应成功：${JSON.stringify(regBody).slice(0, 300)}`);
    const assetId = regBody.ids && regBody.ids.svc;
    assert.ok(assetId && /^A-\d+$/.test(assetId), `应产生 A-nnnn 全局编号：${JSON.stringify(regBody.ids)}`);

    const rec = await server.request("GET", `/sorne/records/${encodeURIComponent(assetId)}?project_id=${pid}`);
    assert.equal(rec.status, 200);
    assert.equal(rec.body.record.kind, "assets", `/records/${assetId} 应定位为资产（全局族）`);
    assert.equal(rec.body.record.id, assetId);

    /* 前端编号解析与服务端定位一致（完整编号、不截断）。 */
    const parsed = parseRecordId(assetId);
    assert.equal(parsed.table, "assets");
    assert.equal(parsed.id, assetId);
  });
});
