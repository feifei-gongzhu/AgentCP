/**
 * M3 —— 首次使用向导测试（lib/ui/pages/onboarding.page.mjs；BLUEPRINT-UI §1.2、要求 §1/§3）。
 *
 * 覆盖（J1 主责用例，蓝图 §e-J1 命名）：
 *   - 页面契约：纯 ESM、无钩子、无浏览器本地存储、无编号正则副本、无字面颜色值；
 *   - J1 未配置模型时显示『尚未连接模型，项目可以保存，AI 暂不能开始』并提供直达入口
 *     （横幅全程可见：四步都渲染）；
 *   - 第①步连接模型：保存 PUT /sorne/llm/settings（含 per_role 角色覆盖；API Key 只写
 *     不读、不回显、不落本地存储）；测试 POST /sorne/llm/test 可用（时延）/失败（原文）二态；
 *   - 第②步创建项目：名称/目标必填本地校验；范围编辑器三区与通配符提示；POST
 *     /sorne/projects 提交体含 scope_rules；BAD_REQUEST 原文呈现；项目创建后回退改范围
 *     走 POST /sorne/scope-revisions（不重复创建项目）；
 *   - 向导第③步可跳过；导入走 #11 原始字节 + #12 采集登记；失败如实呈现不假装成功；
 *   - 第④步：保存项目 / 开始探索——200 进入工作区；409 LLM_NOT_CONFIGURED 呈现
 *     未连接文案与直达入口；404（端点未竣工）如实呈现不虚报已开始。
 *
 * 测试宿主与并行安全同 test/ui-projects.test.mjs（最小 Component 基类 + M1 真实渲染器；
 * fakeApi 不占端口；真实服务用例走 withTestServer）。范围编辑器经真实动态 import
 * 加载（../scope/editor.mjs 相对 file URL 在 Node 下成立），连向导与编辑器的接线一起测。
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

/* ── 最小宿主 + M1 真实渲染器绑定（同 ui-projects） ────────────────── */

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

/* ── 挂载仿真（实例按元素身份缓存；嵌套类组件随之展开） ────────────── */

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

  function findInputByAria(ariaLabel) {
    const hits = findAll((n) => n.type === "input" && n.props["aria-label"] === ariaLabel);
    assert.ok(hits.length >= 1, `未找到输入框「${ariaLabel}」；当前文本：${text().slice(0, 400)}`);
    return hits[hits.length - 1];
  }

  function findTextareaByAria(ariaLabel) {
    const hits = findAll((n) => n.type === "textarea" && n.props["aria-label"] === ariaLabel);
    assert.ok(hits.length >= 1, `未找到文本域「${ariaLabel}」`);
    return hits[hits.length - 1];
  }

  function setText(node, value) {
    node.props.onChange({ target: { value } });
  }

  function click(node) {
    assert.ok(!node.props.disabled, `按钮被禁用：${nodeText(node.children)}`);
    node.props.onClick({ preventDefault() {}, stopPropagation() {} });
  }

  function currentStep() {
    const el = findAll((n) => n.props && n.props["aria-current"] === "step");
    assert.equal(el.length, 1, "应恰有一个当前步骤标记");
    return Number(t_numberOf(el[0]));
  }

  function t_numberOf(node) {
    const m = nodeText(node.children).match(/^(\d+)\./);
    return m ? m[1] : "?";
  }

  return { flush, text, findAll, findButton, findInputByAria, findTextareaByAria, setText, click, currentStep, nodeText, inst: () => instCache.get("r") };
}

/* ── fakeApi ──────────────────────────────────────────────────────── */

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
    calls.push({ method, path, body, headers: options && options.headers });
    const handler = handlers[`${method} ${basePath(path)}`];
    if (!handler) {
      return Promise.reject(new Error(`fakeApi 未配置：${method} ${basePath(path)}`));
    }
    return Promise.resolve().then(() => (typeof handler === "function" ? handler(body, path) : handler));
  };
  fn.calls = calls;
  return fn;
}

function makeCtx(api, { page = "onboarding", hash = "#/onboarding" } = {}) {
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

const LLM_NOT_CONFIGURED = {
  configured: false,
  base_url: null,
  model: null,
  api_key_set: false,
  api_key_hint: null,
  per_role: {},
  source: "none",
  updated_at: null,
};

/* ══════════════════════════════════════════════════════════════════ */

test("M3 页面契约：纯 ESM 不引包、不用浏览器本地存储、无钩子、无编号正则副本、无字面颜色值", async () => {
  const src = await readFile(join(PAGES_DIR, "onboarding.page.mjs"), "utf8");
  assert.doesNotMatch(src, /(^|\n)\s*import[\s(]/, "页面不得静态 import（范围编辑器为运行时动态 import）");
  assert.doesNotMatch(src, /[^.\w]require\s*\(/, "页面不得使用 require");
  assert.doesNotMatch(src, /localStorage/, "页面不得使用浏览器本地存储（授权类输入绝不落本地）");
  assert.doesNotMatch(src, /React\.useState|React\.useEffect|useState\(|useEffect\(/, "页面顶层不得使用 React 钩子");
  assert.doesNotMatch(src, /RECORD_ID_RE/, "编号正则唯一实现必须在 lib/ui/record-ids.mjs");
  assert.doesNotMatch(src, /#[0-9a-fA-F]{3,8}\b|rgba?\(/, "页面不得书写字面颜色值（全部经 --sorne-* token）");
  assert.doesNotMatch(src, /--dsw-alias-/, "页面不得引用宿主 --dsw-alias-* 变量");

  const def = await loadPage("onboarding");
  assert.equal(def.id, "onboarding");
  assert.equal(def.order, 5);
  assert.equal(def.title, "首次使用");
  assert.equal(typeof def.render, "function");
});

test("J1 未配置模型时显示『尚未连接模型，项目可以保存，AI 暂不能开始』并提供直达入口", async () => {
  const def = await loadPage("onboarding");
  const api = fakeApi({ "GET /sorne/llm/settings": LLM_NOT_CONFIGURED });
  const t = mountPage(def, makeCtx(api));
  await t.flush();

  assert.match(t.text(), /尚未连接模型，项目可以保存，AI 暂不能开始/, "要求 §1 冻结文案");
  const t0 = t.currentStep();
  assert.equal(t0, 1, "默认落在第①步");
  t.click(t.findButton("去连接模型"));
  assert.equal(t.currentStep(), 1, "直达连接入口落在第①步");
});

test("模型未连接横幅全程可见（四步都渲染）；配置状态未知时如实呈现不冒充正常", async () => {
  const def = await loadPage("onboarding");
  const api = fakeApi({
    "GET /sorne/llm/settings": LLM_NOT_CONFIGURED,
    "POST /sorne/projects": { project: { id: "PRJ-0001", name: "N" }, scope: null },
  });
  const t = mountPage(def, makeCtx(api));
  await t.flush();

  t.click(t.findButton("下一步：创建项目"));
  await t.flush();
  assert.match(t.text(), /尚未连接模型，项目可以保存，AI 暂不能开始/, "第②步仍可见");

  // 直达第③步（跳过校验路径不可行——先填名称目标）
  t.setText(t.findInputByAria("项目名称"), "横幅项目");
  t.setText(t.findTextareaByAria("项目目标"), "目标说明");
  t.click(t.findButton("创建项目并继续（资料可跳过）"));
  await t.flush();
  assert.match(t.text(), /附加已有资料/, "已到第③步");
  assert.match(t.text(), /尚未连接模型，项目可以保存，AI 暂不能开始/, "第③步仍可见");

  t.click(t.findButton("跳过，不导入资料"));
  await t.flush();
  assert.match(t.text(), /开始前检查/, "已到第④步");
  assert.match(t.text(), /尚未连接模型，项目可以保存，AI 暂不能开始/, "第④步仍可见");
});

test("设置接口不可用（404）→ 「模型配置状态未知」如实呈现，不冒充服务正常", async () => {
  const def = await loadPage("onboarding");
  const api = fakeApi({
    "GET /sorne/llm/settings": () => {
      throw apiError(404, { code: "NOT_FOUND", message: "未注册路由：GET /sorne/llm/settings" });
    },
  });
  const t = mountPage(def, makeCtx(api));
  await t.flush();
  assert.match(t.text(), /模型配置状态未知/);
  assert.match(t.text(), /AI 暂不能开始；项目可以保存/);
  assert.doesNotMatch(t.text(), /模型已连接/);
});

test("第①步：保存设置提交体正确（api_key 只写不读）；成功后自动测试连接显示可用+时延", async () => {
  const def = await loadPage("onboarding");
  let saved = false;
  const api = fakeApi({
    "GET /sorne/llm/settings": () =>
      saved
        ? { configured: true, base_url: "http://127.0.0.1:9/v1", model: "deepseek-chat", api_key_set: true, api_key_hint: "sk-…abcd", per_role: {}, source: "store" }
        : LLM_NOT_CONFIGURED,
    "PUT /sorne/llm/settings": () => {
      saved = true;
      return { configured: true, base_url: "http://127.0.0.1:9/v1", model: "deepseek-chat", api_key_set: true, api_key_hint: "sk-…abcd", per_role: {}, source: "store" };
    },
    "POST /sorne/llm/test": { ok: true, latency_ms: 123, model: "deepseek-chat" },
  });
  const t = mountPage(def, makeCtx(api));
  await t.flush();

  t.setText(t.findInputByAria("模型连接 Base URL"), "http://127.0.0.1:9/v1");
  t.setText(t.findInputByAria("模型连接模型名"), "deepseek-chat");
  t.setText(t.findInputByAria("模型连接 API Key"), "sk-secret-123");
  t.click(t.findButton("保存设置"));
  await t.flush();

  const put = api.calls.find((c) => c.method === "PUT" && c.path === "/sorne/llm/settings");
  assert.ok(put, "应发起 PUT /sorne/llm/settings");
  assert.deepEqual(put.body, {
    base_url: "http://127.0.0.1:9/v1",
    model: "deepseek-chat",
    api_key: "sk-secret-123",
    per_role: {},
  }, "提交体含 base_url/model/api_key/per_role");

  const testCall = api.calls.find((c) => c.method === "POST" && c.path === "/sorne/llm/test");
  assert.ok(testCall, "保存成功后应自动测试连接");
  assert.equal(testCall.body.baseUrl, "http://127.0.0.1:9/v1");

  assert.match(t.text(), /连接可用（时延 123 ms/, "可用 + 时延明确显示");
  assert.doesNotMatch(t.text(), /sk-secret-123/, "API Key 明文绝不回显到界面");
  assert.match(t.text(), /sk-…abcd/, "仅显示服务端掩码提示");
});

test("第①步：高级设置按角色覆盖随 per_role 提交（默认四角色共用不强制配置）", async () => {
  const def = await loadPage("onboarding");
  const api = fakeApi({
    "GET /sorne/llm/settings": LLM_NOT_CONFIGURED,
    "PUT /sorne/llm/settings": { configured: true, per_role: { planner: { model: "m2" } }, source: "store" },
    "POST /sorne/llm/test": { ok: false, error: { code: "TIMEOUT", message: "连接超时（10s）" }, latency_ms: 10000 },
  });
  const t = mountPage(def, makeCtx(api));
  await t.flush();

  t.setText(t.findInputByAria("模型连接 Base URL"), "http://127.0.0.1:9/v1");
  t.setText(t.findInputByAria("模型连接模型名"), "deepseek-chat");
  t.setText(t.findInputByAria("角色 planner 的模型覆盖"), "m2");
  t.click(t.findButton("保存设置"));
  await t.flush();

  const put = api.calls.find((c) => c.method === "PUT");
  assert.deepEqual(put.body.per_role, { planner: { model: "m2" } }, "仅覆盖的角色进入 per_role");

  assert.match(t.text(), /连接失败：TIMEOUT · 连接超时（10s）/, "失败原因原样呈现，不转圈");
});

test("第②步：范围编辑器三区与通配符提示呈现；提交体含 scope_rules；BAD_REQUEST 原文呈现", async () => {
  const def = await loadPage("onboarding");
  const api = fakeApi({
    "GET /sorne/llm/settings": LLM_NOT_CONFIGURED,
    "POST /sorne/projects": { project: { id: "PRJ-0009", name: "N" }, scope: { id: "SR-0001", revision: "1", rules: {} } },
  });
  const t = mountPage(def, makeCtx(api));
  await t.flush();

  t.click(t.findButton("下一步：创建项目"));
  await t.flush();

  // 编辑器经真实动态 import 加载（共用同一实现，§2.7）
  assert.match(t.text(), /允许（allow）/);
  assert.match(t.text(), /拒绝（deny，优先）/);
  assert.match(t.text(), /待判断（pending）/);
  assert.match(t.text(), /\*\.example\.test/, "子域通配提示");
  assert.match(t.text(), /https:\/\/api\.example\.test\/v1\/\*/, "路径通配提示");
  assert.match(t.text(), /明确拒绝优先于允许/, "拒绝优先语义提示");

  t.setText(t.findInputByAria("项目名称"), "向导项目");
  t.setText(t.findTextareaByAria("项目目标"), "对内网系统做持续探索");
  t.setText(t.findTextareaByAria("允许范围规则，每行一条"), "example.test\n*.staging.example.test");
  t.setText(t.findTextareaByAria("拒绝范围规则，每行一条"), "https://example.test/admin");
  t.click(t.findButton("创建项目并继续（资料可跳过）"));
  await t.flush();

  const post = api.calls.find((c) => c.method === "POST" && c.path === "/sorne/projects");
  assert.ok(post, "应发起 POST /sorne/projects");
  assert.deepEqual(post.body, {
    name: "向导项目",
    description: "对内网系统做持续探索",
    scope_rules: {
      allow: ["example.test", "*.staging.example.test"],
      deny: ["https://example.test/admin"],
      pending: [],
    },
  }, "提交体：名称/目标/三区规则");
  assert.match(t.text(), /附加已有资料/, "创建成功自动进入第③步（创建回执在第②步内呈现过，进入第③步后随步骤内容切换）");
});

test("第②步：名称/目标必填本地校验（不发请求）；非法范围条目本地拦截", async () => {
  const def = await loadPage("onboarding");
  const api = fakeApi({ "GET /sorne/llm/settings": LLM_NOT_CONFIGURED });
  const t = mountPage(def, makeCtx(api));
  await t.flush();
  t.click(t.findButton("下一步：创建项目"));
  await t.flush();

  t.click(t.findButton("创建项目并继续（资料可跳过）"));
  await t.flush();
  assert.match(t.text(), /项目名称与目标必填（本地校验，未发请求）/);
  assert.equal(api.calls.filter((c) => c.method === "POST").length, 0, "必填校验拦截不发请求");

  // 对象条目 JSON 非法 → 编辑器本地拦截（错误可见），提交被阻止
  t.setText(t.findInputByAria("项目名称"), "X");
  t.setText(t.findTextareaByAria("项目目标"), "Y");
  t.setText(t.findTextareaByAria("允许范围规则，每行一条"), '{"host": ');
  t.click(t.findButton("创建项目并继续（资料可跳过）"));
  await t.flush();
  assert.match(t.text(), /JSON 解析失败/, "编辑器解析错误可见");
  assert.match(t.text(), /范围条目存在格式错误，请先修正（未发请求）/);
  assert.equal(api.calls.filter((c) => c.method === "POST" && c.path === "/sorne/projects").length, 0);

  // 修正后正常提交
  t.setText(t.findTextareaByAria("允许范围规则，每行一条"), '{"host":"*.example.test","port":8443}');
  t.click(t.findButton("创建项目并继续（资料可跳过）"));
  await t.flush();
  const post = api.calls.find((c) => c.method === "POST" && c.path === "/sorne/projects");
  assert.ok(post, "修正后提交放行");
  assert.deepEqual(post.body.scope_rules, { allow: [{ host: "*.example.test", port: 8443 }], deny: [], pending: [] });
});

test("第②步：服务端 BAD_REQUEST 原文呈现", async () => {
  const def = await loadPage("onboarding");
  const api = fakeApi({
    "GET /sorne/llm/settings": LLM_NOT_CONFIGURED,
    "POST /sorne/projects": () => {
      throw apiError(400, { code: "BAD_REQUEST", message: "scope rules.deny 必须是数组（§17）" });
    },
  });
  const t = mountPage(def, makeCtx(api));
  await t.flush();
  t.click(t.findButton("下一步：创建项目"));
  await t.flush();
  t.setText(t.findInputByAria("项目名称"), "X");
  t.setText(t.findTextareaByAria("项目目标"), "Y");
  t.click(t.findButton("创建项目并继续（资料可跳过）"));
  await t.flush();
  assert.match(t.text(), /创建项目失败：BAD_REQUEST · scope rules\.deny 必须是数组（§17）/, "后端原文（含 §）原样呈现");
});

test("已创建项目后回退第②步改范围 → scope-revisions 新版本，不重复创建项目；名称/目标锁定如实标注", async () => {
  const def = await loadPage("onboarding");
  const api = fakeApi({
    "GET /sorne/llm/settings": LLM_NOT_CONFIGURED,
    "POST /sorne/projects": { project: { id: "PRJ-0007", name: "N" }, scope: { id: "SR-0001", revision: "1" } },
    "POST /sorne/scope-revisions": { scope_revision: { id: "SR-0002", revision: "2", rules: {} }, commit_seq: 4 },
  });
  const t = mountPage(def, makeCtx(api));
  await t.flush();
  t.click(t.findButton("下一步：创建项目"));
  await t.flush();
  t.setText(t.findInputByAria("项目名称"), "项目A");
  t.setText(t.findTextareaByAria("项目目标"), "目标A");
  t.click(t.findButton("创建项目并继续（资料可跳过）"));
  await t.flush();
  assert.match(t.text(), /附加已有资料/);

  // 回退到第②步，修改范围
  t.click(t.findButton("上一步"));
  await t.flush();
  assert.match(t.text(), /项目已创建（PRJ-0007）/);
  assert.match(t.text(), /名称与目标在本流程内不再可改/, "无更新端点的约束如实标注");
  t.setText(t.findTextareaByAria("拒绝范围规则，每行一条"), "https://secret.example.test/");
  t.click(t.findButton("下一步：导入资料（可跳过）"));
  await t.flush();

  const posts = api.calls.filter((c) => c.method === "POST" && c.path === "/sorne/projects");
  assert.equal(posts.length, 1, "不重复创建项目");
  const rev = api.calls.find((c) => c.method === "POST" && c.path === "/sorne/scope-revisions");
  assert.ok(rev, "范围修改经 scope-revisions 版本化");
  assert.deepEqual(rev.body, {
    project_id: "PRJ-0007",
    rules: { allow: [], deny: ["https://secret.example.test/"], pending: [] },
    summary: "向导第②步调整范围",
  });
});

test("向导第③步可跳过（J1 命名用例）：跳过不触发任何上传", async () => {
  const def = await loadPage("onboarding");
  const api = fakeApi({
    "GET /sorne/llm/settings": LLM_NOT_CONFIGURED,
    "POST /sorne/projects": { project: { id: "PRJ-0005", name: "N" }, scope: null },
  });
  const t = mountPage(def, makeCtx(api));
  await t.flush();
  t.click(t.findButton("下一步：创建项目"));
  await t.flush();
  t.setText(t.findInputByAria("项目名称"), "跳过项目");
  t.setText(t.findTextareaByAria("项目目标"), "目标");
  t.click(t.findButton("创建项目并继续（资料可跳过）"));
  await t.flush();
  t.click(t.findButton("跳过，不导入资料"));
  await t.flush();
  assert.match(t.text(), /开始前检查/);
  assert.equal(
    api.calls.filter((c) => c.path === "/sorne/evidence/blobs" || c.path === "/sorne/captures").length,
    0,
    "跳过路径零上传调用",
  );
  assert.match(t.text(), /未导入资料/);
});

test("第③步导入：原始字节上传 + 采集登记；成功列出 Blob/采集编号；失败如实呈现不假装成功", async () => {
  const def = await loadPage("onboarding");
  const sha = "a".repeat(64);
  const api = fakeApi({
    "GET /sorne/llm/settings": LLM_NOT_CONFIGURED,
    "POST /sorne/projects": { project: { id: "PRJ-0006", name: "N" }, scope: null },
    "POST /sorne/evidence/blobs": (_b, path) => {
      assert.match(path, /project_id=PRJ-0006/);
      assert.match(path, /representation=uploaded_file/);
      assert.match(path, /source_kind=third_party_import/);
      return { blob_id: "B-0001", sha256: sha, byte_size: 5, representation: "uploaded_file", storage_status: "fixed", deduplicated: false };
    },
    "POST /sorne/captures": (body) => {
      assert.equal(body.source_kind, "third_party_import");
      assert.equal(body.response_body_blob, sha);
      assert.equal(body.method, "IMPORT");
      assert.equal(typeof body.tool_call_id, "string");
      return { capture: { capture_id: "CAP-0001" }, capture_id: "CAP-0001" };
    },
  });
  const t = mountPage(def, makeCtx(api));
  await t.flush();
  t.click(t.findButton("下一步：创建项目"));
  await t.flush();
  t.setText(t.findInputByAria("项目名称"), "导入项目");
  t.setText(t.findTextareaByAria("项目目标"), "目标");
  t.click(t.findButton("创建项目并继续（资料可跳过）"));
  await t.flush();

  const enc = new TextEncoder();
  const file = { name: "接口说明.md", arrayBuffer: async () => enc.encode("hello").buffer };
  await t.inst().onFilesSelected([file]);
  await t.flush();

  assert.match(t.text(), /接口说明\.md（5 字节）/);
  assert.match(t.text(), /CAP-0001/, "采集编号呈现（可经 chip 跳详情）");
  assert.match(t.text(), /已导入 1 个文件/);

  const blobCall = api.calls.find((c) => c.path.startsWith("/sorne/evidence/blobs"));
  assert.ok(blobCall, "原始字节上传");
  const capCall = api.calls.find((c) => c.path === "/sorne/captures");
  assert.ok(capCall, "采集登记");
});

test("第③步导入失败（EVIDENCE_NOT_COMMITTED）→ 失败明细可见，不产生虚假成功", async () => {
  const def = await loadPage("onboarding");
  const api = fakeApi({
    "GET /sorne/llm/settings": LLM_NOT_CONFIGURED,
    "POST /sorne/projects": { project: { id: "PRJ-0008", name: "N" }, scope: null },
    "POST /sorne/evidence/blobs": () => {
      throw apiError(422, {
        code: "EVIDENCE_NOT_COMMITTED",
        message: "response_body_blob 证据文件缺失，已标记 lost 并拒绝建立采集",
      });
    },
  });
  const t = mountPage(def, makeCtx(api));
  await t.flush();
  t.click(t.findButton("下一步：创建项目"));
  await t.flush();
  t.setText(t.findInputByAria("项目名称"), "失败项目");
  t.setText(t.findTextareaByAria("项目目标"), "目标");
  t.click(t.findButton("创建项目并继续（资料可跳过）"));
  await t.flush();

  const enc = new TextEncoder();
  await t.inst().onFilesSelected([{ name: "broken.bin", arrayBuffer: async () => enc.encode("xx").buffer }]);
  await t.flush();

  assert.match(t.text(), /broken\.bin：导入失败/);
  assert.match(t.text(), /EVIDENCE_NOT_COMMITTED · response_body_blob 证据文件缺失/);
  assert.match(t.text(), /部分文件导入失败/);
  assert.doesNotMatch(t.text(), /已导入 1 个文件/, "失败不冒充成功");
});

test("第④步开始探索成功 → 进入工作区 #/p/:pid/workbench", async () => {
  const def = await loadPage("onboarding");
  const api = fakeApi({
    "GET /sorne/llm/settings": { configured: true, base_url: "http://x/v1", model: "m", api_key_set: true, per_role: {}, source: "store" },
    "POST /sorne/projects": { project: { id: "PRJ-0010", name: "开始项目" }, scope: null },
    "POST /sorne/projects/PRJ-0010/explore-start": { project: { id: "PRJ-0010" }, plan_request_id: "PR-0001" },
  });
  const ctx = makeCtx(api);
  const t = mountPage(def, ctx);
  await t.flush();
  t.click(t.findButton("下一步：创建项目"));
  await t.flush();
  t.setText(t.findInputByAria("项目名称"), "开始项目");
  t.setText(t.findTextareaByAria("项目目标"), "目标");
  t.click(t.findButton("创建项目并继续（资料可跳过）"));
  await t.flush();
  t.click(t.findButton("跳过，不导入资料"));
  await t.flush();
  t.click(t.findButton("开始探索"));
  await t.flush();

  assert.match(t.text(), /探索已开始/);
  const nav = ctx.router.__calls.find((c) => c.kind === "open");
  assert.ok(nav, "应导航进入工作区");
  assert.equal(nav.hash, "#/p/PRJ-0010/workbench");
});

test("第④步 409 LLM_NOT_CONFIGURED → 未连接文案 + 直达连接入口；项目保持已保存", async () => {
  const def = await loadPage("onboarding");
  const api = fakeApi({
    "GET /sorne/llm/settings": LLM_NOT_CONFIGURED,
    "POST /sorne/projects": { project: { id: "PRJ-0011", name: "N" }, scope: null },
    "POST /sorne/projects/PRJ-0011/explore-start": () => {
      throw apiError(409, {
        code: "LLM_NOT_CONFIGURED",
        message: "尚未连接模型，项目可以保存，AI 暂不能开始",
        next_requirements: ["配置模型：PUT /sorne/llm/settings 或前往引导页连接模型"],
      });
    },
  });
  const t = mountPage(def, makeCtx(api));
  await t.flush();
  t.click(t.findButton("下一步：创建项目"));
  await t.flush();
  t.setText(t.findInputByAria("项目名称"), "待连项目");
  t.setText(t.findTextareaByAria("项目目标"), "目标");
  t.click(t.findButton("创建项目并继续（资料可跳过）"));
  await t.flush();
  t.click(t.findButton("跳过，不导入资料"));
  await t.flush();
  t.click(t.findButton("开始探索"));
  await t.flush();

  assert.match(t.text(), /尚未连接模型，项目可以保存，AI 暂不能开始/);
  assert.match(t.text(), /下一步：配置模型：PUT \/sorne\/llm\/settings 或前往引导页连接模型/, "next_requirements 呈现");
  t.click(t.findButton("去连接模型"));
  await t.flush();
  assert.equal(t.currentStep(), 1, "直达连接入口");
});

test("第④步端点未竣工（404）→ 如实呈现「接口不可用」，项目已保存，不虚报已开始", async () => {
  const def = await loadPage("onboarding");
  const api = fakeApi({
    "GET /sorne/llm/settings": LLM_NOT_CONFIGURED,
    "POST /sorne/projects": { project: { id: "PRJ-0012", name: "N" }, scope: null },
    "POST /sorne/projects/PRJ-0012/explore-start": () => {
      throw apiError(404, { code: "NOT_FOUND", message: "未注册路由：POST /sorne/projects/PRJ-0012/explore-start" });
    },
  });
  const t = mountPage(def, makeCtx(api));
  await t.flush();
  t.click(t.findButton("下一步：创建项目"));
  await t.flush();
  t.setText(t.findInputByAria("项目名称"), "X");
  t.setText(t.findTextareaByAria("项目目标"), "Y");
  t.click(t.findButton("创建项目并继续（资料可跳过）"));
  await t.flush();
  t.click(t.findButton("跳过，不导入资料"));
  await t.flush();
  t.click(t.findButton("开始探索"));
  await t.flush();

  assert.match(t.text(), /开始探索接口不可用（HTTP 404）/, "501/404 未实现 ≠ 报错（呈现不可用态）");
  assert.match(t.text(), /项目已保存，可稍后在项目内开始探索/);
  assert.doesNotMatch(t.text(), /探索已开始/);
});

test("第④步保存项目：已创建不重复提交，呈现已保存与项目列表入口", async () => {
  const def = await loadPage("onboarding");
  const api = fakeApi({
    "GET /sorne/llm/settings": LLM_NOT_CONFIGURED,
    "POST /sorne/projects": { project: { id: "PRJ-0013", name: "仅保存" }, scope: null },
  });
  const ctx = makeCtx(api);
  const t = mountPage(def, ctx);
  await t.flush();
  t.click(t.findButton("下一步：创建项目"));
  await t.flush();
  t.setText(t.findInputByAria("项目名称"), "仅保存");
  t.setText(t.findTextareaByAria("项目目标"), "目标");
  t.click(t.findButton("创建项目并继续（资料可跳过）"));
  await t.flush();
  t.click(t.findButton("跳过，不导入资料"));
  await t.flush();
  t.click(t.findButton("保存项目"));
  await t.flush();

  assert.equal(api.calls.filter((c) => c.method === "POST" && c.path === "/sorne/projects").length, 1, "不重复创建");
  assert.match(t.text(), /项目已保存：PRJ-0013/);
  t.click(t.findButton("前往项目列表"));
  const nav = ctx.router.__calls.find((c) => c.kind === "open");
  assert.equal(nav.hash, "#/projects");
});

test("每步可回退：步骤条回退按钮逐步可达第①步", async () => {
  const def = await loadPage("onboarding");
  const api = fakeApi({
    "GET /sorne/llm/settings": LLM_NOT_CONFIGURED,
    "POST /sorne/projects": { project: { id: "PRJ-0014", name: "N" }, scope: null },
  });
  const t = mountPage(def, makeCtx(api));
  await t.flush();
  t.click(t.findButton("下一步：创建项目"));
  await t.flush();
  t.setText(t.findInputByAria("项目名称"), "回退项目");
  t.setText(t.findTextareaByAria("项目目标"), "目标");
  t.click(t.findButton("创建项目并继续（资料可跳过）"));
  await t.flush();
  t.click(t.findButton("跳过，不导入资料"));
  await t.flush();
  assert.equal(t.currentStep(), 4);

  t.click(t.findButton("上一步"));
  await t.flush();
  assert.equal(t.currentStep(), 3);
  t.click(t.findButton("上一步"));
  await t.flush();
  assert.equal(t.currentStep(), 2);
  t.click(t.findButton("上一步"));
  await t.flush();
  assert.equal(t.currentStep(), 1);
  // 回退到第①步后项目仍在（状态保留，不要求重来）
  t.click(t.findButton("下一步：创建项目"));
  await t.flush();
  assert.match(t.text(), /项目已创建（PRJ-0014）/);
});

test("无 router/ui 降级：不崩溃并如实提示", async () => {
  const def = await loadPage("onboarding");
  const api = fakeApi({ "GET /sorne/llm/settings": LLM_NOT_CONFIGURED });
  const t = mountPage(def, {
    React: { createElement: h, Component: ComponentBase },
    h,
    api,
    router: null,
    ui: null,
    theme: null,
  });
  await t.flush();
  assert.match(t.text(), /首次使用/, "页面标题仍在");
  assert.match(t.text(), /尚未连接模型，项目可以保存，AI 暂不能开始/, "横幅不依赖 ui/router");
});

/* ══════════════════════════════════════════════════════════════════ */
/* 真实服务集成（端点状态自适应：已实装→数据断言；未实装→不可用态断言） */
/* ══════════════════════════════════════════════════════════════════ */

function makeRealApi(base) {
  return async function api(path, options) {
    const headers = { origin: base };
    if (options && options.headers && options.headers["Content-Type"]) {
      headers["Content-Type"] = options.headers["Content-Type"];
    } else if (options && options.body !== undefined && typeof options.body === "string") {
      headers["Content-Type"] = "application/json";
    }
    const res = await fetch(base + path, {
      method: (options && options.method) || "GET",
      headers,
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
}

test("真实服务 J1：向导读未配置状态 → 显示未连接横幅；创建项目成功并可列出；连接失败如实呈现", () =>
  withTestServer(async ({ base, request }) => {
    const def = await loadPage("onboarding");
    const api = makeRealApi(base);
    const ctx = makeCtx(api);
    const t = mountPage(def, ctx);
    await t.flush();

    // 全新临时数据目录：模型必然未配置 → 横幅（要求 §1）
    assert.match(t.text(), /尚未连接模型，项目可以保存，AI 暂不能开始/);

    // 第①步：保存设置（指向必然拒绝连接的回环地址）→ 保存成功 + 测试连接失败原文
    t.setText(t.findInputByAria("模型连接 Base URL"), "http://127.0.0.1:9/v1");
    t.setText(t.findInputByAria("模型连接模型名"), "integration-model");
    t.setText(t.findInputByAria("模型连接 API Key"), "sk-integration-test");
    t.click(t.findButton("保存设置"));
    // 真实 HTTP 往返（PUT 保存 → GET 刷新 → POST 测试连接）不是固定轮数能覆盖的：
    // 轮询等待页面进入「测试连接结束」态（成功/失败文案任一），再做服务端断言。
    for (let i = 0; i < 100 && !/连接失败：|模型已连接：|保存设置失败：/.test(t.text()); i += 1) {
      await t.flush(4);
    }
    await t.flush();

    const settings = await request("GET", "/sorne/llm/settings");
    assert.equal(settings.status, 200);
    assert.equal(settings.body.configured, true, "设置已持久化");
    assert.equal(settings.body.model, "integration-model");
    assert.equal(settings.body.api_key_set, true, "key 已保存");
    assert.doesNotMatch(JSON.stringify(settings.body), /sk-integration-test/, "响应永不含明文 key");

    // 保存后自动测试：127.0.0.1:9 必然连接失败 → 失败原因如实呈现（不依赖外网）
    assert.match(t.text(), /连接失败：/, "真实测试连接失败路径");

    // 横幅随刷新转为已连接
    await t.flush();
    assert.match(t.text(), /模型已连接：integration-model/);

    // 第②步：真实创建项目（含范围）
    t.click(t.findButton("下一步：创建项目"));
    await t.flush();
    t.setText(t.findInputByAria("项目名称"), "向导集成项目");
    t.setText(t.findTextareaByAria("项目目标"), "集成验收目标说明");
    t.setText(t.findTextareaByAria("允许范围规则，每行一条"), "example.test");
    t.click(t.findButton("创建项目并继续（资料可跳过）"));
    await t.flush();

    const list = await request("GET", "/sorne/projects?include=summary&limit=50");
    assert.equal(list.status, 200);
    assert.equal(list.body.projects.length, 1);
    assert.equal(list.body.projects[0].name, "向导集成项目");
    const pid = list.body.projects[0].id;

    const scope = await request("GET", `/sorne/projects/${pid}/scope`);
    assert.equal(scope.status, 200);
    assert.equal(scope.body.configured, true);
    assert.deepEqual(scope.body.current.rules.allow, ["example.test"]);

    // 第③步：真实上传（原始字节 → Blob 固定 → 采集登记）
    const enc = new TextEncoder();
    await t.inst().onFilesSelected([{ name: "集成资料.txt", arrayBuffer: async () => enc.encode("integration-bytes").buffer }]);
    await t.flush();
    assert.match(t.text(), /集成资料\.txt（17 字节）/);
    assert.match(t.text(), /CAP-/, "真实采集编号呈现");

    // 第④步：开始探索——端点当前状态自适应断言（M2 竣工前 404 → 不可用态）
    t.click(t.findButton("跳过，不导入资料"));
    await t.flush();
    t.click(t.findButton("开始探索"));
    // 真实 POST /explore-start 往返：轮询到终态（成功/404/失败）再断言，不用固定轮数赌时序。
    for (let i = 0; i < 100 && !/探索已开始|开始探索接口不可用|开始探索失败/.test(t.text()); i += 1) {
      await t.flush(4);
    }
    await t.flush();
    const started = t.text().match(/探索已开始/);
    const unavailable = t.text().match(/开始探索接口不可用（HTTP 404）/);
    assert.ok(started || unavailable, `explore-start 两种竣工状态下都成立（实际：${t.text().slice(0, 200)}）`);
    if (started) {
      const nav = ctx.router.__calls.find((c) => c.kind === "open");
      assert.ok(nav && nav.hash === `#/p/${pid}/workbench`, "成功后进入工作区");
    } else {
      assert.match(t.text(), /项目已保存，可稍后在项目内开始探索/);
    }
  }));
