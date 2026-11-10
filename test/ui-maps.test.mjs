/**
 * M5 —— 资产与探索页测试（test/ui-maps.test.mjs 沿用原名重写；BLUEPRINT-UI §1.5 / §g / §e-J5）。
 *
 * 覆盖（旧 B3 断言的迁移落点逐条见 docs/modules/ui-M5.md 的「旧断言 → 新落点」表）：
 *   - 页面契约：纯 ESM 零 import、无浏览器存储、无 React 钩子、无编号正则副本
 *     （P0-2②：RECORD_ID_RE 只在 lib/ui/record-ids.mjs）、无字面颜色值/宿主变量
 *     （P0-1②）、export default 含 id/title/order/render/renderDetail；
 *   - 资产页五块：站点树（服务/主机层级）、资产列表（类型分组真表格）、技术栈
 *     （分层画像：产品 → 版本 → 证据；同一产品多条指纹合并、版本未知显式）、接口
 *     （候选/已确认模板 + T- chip）、文件及来源
 *     （资产记录计数/关联编号 + #44 采集详情读取 + #43 原始字节入口）；
 *   - 快照六要素（快照编号/模式版本/截止提交序号/生成时刻/投影范围/折叠省略说明）
 *     与订阅边界、resume_cursor；投影范围裸串改页头可读行；
 *   - 折叠：计数 + 展开入口（fold_since 续读）+ 折叠不删记录；
 *   - URL / 路径原样展示：不小写、不解码、不重排参数；
 *   - 行点击 → 右侧详情（renderDetail）：字段、来源/相关发现/已开展探索计数与编号、
 *     关系边；「就此资产向 AI 下任务」= 预填消息草稿 + POST /sorne/messages；
 *   - 探索页：方向列表（目标/依据/进展/阻塞/后续）、局部分支图（view=graph）、
 *     完整大图（view=full，辅助）、方向详情 + 追问/建议暂缓消息草稿；
 *   - J5：新意图出现在方向列表且依据/前提随记录呈现（点刷新后可见新方向）；
 *   - 状态不夸大：intent_status/vulnerability_status 词表徽章（已确认（限指定条件））；
 *   - UI 通用规则：501 未实现 ≠ 报错、错误卡、未知形状显式、空态显式、无项目不发请求；
 *   - 项目切换：onChange 后按新 project_id 重读，旧数据不残留；
 *   - 真实服务：manifest、真实提交建资产/模板（D2 操作路径）与计划接收（C1）后页面呈现。
 *
 * 测试宿主：不依赖 React 运行时——最小 createElement + Component 基类驱动页面类组件，
 * 并绑定 M1 真实渲染器（lib/ui/render.mjs + lib/ui/record-ids.mjs），断言打到真实输出。
 * 并行安全：fakeApi 用例不占端口；真实服务用例走 withTestServer（mkdtemp + listen(0)）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { withTestServer } from "./helpers.mjs";
import { issueSession } from "../lib/store/sessions.mjs";
import { buildTechStack } from "../lib/store/tech-stack.mjs";
import * as renderMod from "../lib/ui/render.mjs";
import * as recordIdsMod from "../lib/ui/record-ids.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGES_DIR = join(HERE, "..", "lib", "ui", "pages");

async function loadPage(id) {
  const mod = await import(pathToFileURL(join(PAGES_DIR, id + ".page.mjs")).href);
  return mod.default;
}

/* ── 最小宿主 + M1 真实渲染器绑定 ─────────────────────────────────── */

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

function nodeText(node) {
  if (node === null || node === undefined || node === true || node === false) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (node.__elem) return nodeText(node.children);
  return String(node);
}

/** 展开元素树（类组件实例按路径缓存；渲染器函数组件直接调用）。 */
function mountElement(rootElem) {
  let tree = null;
  const cdmQueue = [];
  const instCache = new Map();

  function walk(node, path) {
    if (Array.isArray(node)) return node.map((c, i) => walk(c, path + "/" + i));
    if (!node || !node.__elem) return node;
    if (typeof node.type === "function") {
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
        const child = inst.render();
        return { ...node, __inst: inst, children: [walk(child, path + "/out")] };
      }
      const child = node.type(node.props);
      return { ...node, children: [walk(child, path + "/fn")] };
    }
    return { ...node, children: node.children.map((c, i) => walk(c, path + "/" + i)) };
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

  function text() {
    return nodeText(tree);
  }

  function findButton(label) {
    const hits = findAll((n) => n.type === "button" && nodeText(n.children).includes(label));
    assert.ok(hits.length >= 1, "未找到按钮「" + label + "」；当前文本：" + text().slice(0, 500));
    return hits[hits.length - 1];
  }

  function findInputByPlaceholder(placeholder) {
    const hits = findAll((n) => n.type === "input" && String(n.props.placeholder || "").includes(placeholder));
    assert.ok(hits.length >= 1, "未找到输入框「" + placeholder + "」");
    return hits[hits.length - 1];
  }

  function findTextarea() {
    const hits = findAll((n) => n.type === "textarea");
    assert.ok(hits.length >= 1, "未找到消息草稿 textarea");
    return hits[hits.length - 1];
  }

  function click(node) {
    assert.ok(!node.props.disabled, "按钮被禁用：" + nodeText(node.children));
    node.props.onClick({ preventDefault() {}, stopPropagation() {} });
  }

  function rowElements() {
    return findAll((n) => n.type === "tr" && n.props.onClick);
  }

  return { flush, text, findAll, findButton, findInputByPlaceholder, findTextarea, click, rowElements, nodeText };
}

function mountPage(def, ctx) {
  return mountElement(def.render(ctx));
}

function mountDetail(def, ctx) {
  assert.equal(typeof def.renderDetail, "function", "页面必须导出 renderDetail（右侧详情槽位契约）");
  return mountElement(def.renderDetail(ctx));
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
  const e = new Error(body.message || "HTTP " + status);
  e.status = status;
  e.code = body.code;
  e.body = body;
  return e;
}

function notImpl(moduleId, method, path, spec) {
  return apiError(501, {
    code: "NOT_IMPLEMENTED",
    message: "端点 " + method + " " + path + " 由模块 " + moduleId + " 施工（" + spec + "）",
  });
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
    let handler = handlers[method + " " + basePath(path)];
    if (handler === undefined) handler = handlers[method + " " + path];
    if (handler === undefined) return Promise.reject(new Error("fakeApi 未配置：" + method + " " + basePath(path)));
    if (handler instanceof Error) return Promise.reject(handler);
    return Promise.resolve().then(() => (typeof handler === "function" ? handler(body, path) : handler));
  };
  fn.calls = calls;
  return fn;
}

/** 假路由：记录 open/replace/back/openRecord；fire() 通知 onChange（模拟导航）。 */
function makeRouter({ page = "assets", projectId = "PRJ-0001", params = {}, query = {} } = {}) {
  const calls = [];
  const listeners = new Set();
  const router = {
    hash: "#/p/" + projectId + "/" + page,
    page,
    projectId,
    params,
    query,
    open: (target) => {
      calls.push({ kind: "open", hash: target });
      router.hash = target;
    },
    replace: (target) => calls.push({ kind: "replace", hash: target }),
    back: (fb) => calls.push({ kind: "back", fallback: fb }),
    openRecord: (id) => calls.push({ kind: "openRecord", id }),
    isInAppHistory: () => false,
    onChange: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    fire: () => {
      for (const fn of Array.from(listeners)) fn(router);
    },
    __calls: calls,
  };
  return router;
}

function makeCtx(api, router) {
  return { React: { createElement: h, Component: ComponentBase }, h, api, router, ui, theme: null };
}

/** 与修复后 client.js 的 api() 同构（message 优先；错误带 code/status/body）。 */
function realApi(base) {
  return async function api(path, options) {
    const res = await fetch(base + path, {
      credentials: "same-origin",
      method: (options && options.method) || "GET",
      headers: { "Content-Type": "application/json", ...((options && options.headers) || {}), origin: base },
      body: options && options.body,
    });
    const raw = await res.text();
    let data = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      data = { raw };
    }
    if (!res.ok) {
      const msg = data && typeof data.message === "string" && data.message.trim()
        ? data.message
        : "HTTP " + res.status;
      const err = new Error(msg);
      err.status = res.status;
      err.code = data && data.code;
      err.body = data;
      throw err;
    }
    return data;
  };
}

/** 带会话头的真实请求（写端点需要角色会话；helpers.request 不带会话头）。 */
async function authedCall(base, method, path, { body, session } = {}) {
  const headers = { origin: base };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (session) headers["x-sorne-session"] = session.session_token;
  const res = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, body: json };
}

async function waitText(t, pred, label) {
  for (let i = 0; i < 240; i += 1) {
    if (pred(t.text())) return;
    await t.flush(2);
  }
  assert.ok(pred(t.text()), "等待超时：" + (label || "条件") + "；当前文本：" + t.text().slice(0, 600));
}

/* ── 夹具 ─────────────────────────────────────────────────────────── */

const SHA = "ab12cd34ef5678901234567890abcdef1234567890abcdef1234567890abcdef";

const TECH_ROWS = [
  { id: "A-0101", asset_type: "product", canonical_key: "通达OA", original_input: "O-0001", scope_status: "pending", created_seq: 1 },
  { id: "A-0102", asset_type: "product", canonical_key: "nginx", original_input: "O-0002", scope_status: "pending", created_seq: 2 },
  { id: "A-0103", asset_type: "technology", canonical_key: "PHP", original_input: "O-0003", scope_status: "pending", created_seq: 3 },
  { id: "A-0104", asset_type: "technology", canonical_key: "通达OA (Tongda2000 MYOA) Web 登录入口", original_input: "O-0004", scope_status: "pending", created_seq: 4 },
  { id: "A-0105", asset_type: "technology", canonical_key: "nginx（版本未披露）", original_input: "O-0005", scope_status: "pending", created_seq: 5 },
  { id: "A-0106", asset_type: "product", canonical_key: "通达OA (Tongda MYOA) 2015版模板", original_input: "O-0006", scope_status: "pending", created_seq: 6 },
  { id: "A-0107", asset_type: "product", canonical_key: "通达OA 版本未知", original_input: "O-0007", scope_status: "pending", created_seq: 7 },
  { id: "A-0108", asset_type: "product", canonical_key: "nginx 版本未知", original_input: "O-0008", scope_status: "pending", created_seq: 8 },
  { id: "A-0109", asset_type: "product", canonical_key: "PHP 版本未知", original_input: "O-0009", scope_status: "pending", created_seq: 9 },
  { id: "A-0110", asset_type: "product", canonical_key: "jQuery 3.x 版本未知", original_input: "O-0010", scope_status: "pending", created_seq: 10 },
];
const TECH_TREE = buildTechStack(TECH_ROWS);

const ASSET_TREE = {
  project_id: "PRJ-0001",
  generated_at: "2026-11-06T02:00:00.000Z",
  asset_map_md: { name: "asset_map.md", summary: "站点 1 · 资产 3 · 技术栈产品 4（版本节点 5） · 接口 3 · 采集 2" },
  tech_stack: TECH_TREE,
  sites: [
    {
      host: "Test.Example.com:8443",
      js: [], pages: [], interfaces: [], files: [],
      counts: { js: 0, pages: 0, interfaces: 0, files: 0 },
    },
  ],
  counts: { sites: 1, assets: 3, interfaces: 3, resources: 1, captures: 2 },
};

const ASSET_SNAPSHOT = {
  kind: "asset_map",
  snapshot_id: "SNAP-A-0001",
  schema_version: 1,
  snapshot_commit_seq: 42,
  content_commit_seq: 42,
  generated_at: "2026-11-06T02:00:00.000Z",
  project_id: "PRJ-0001",
  projection_scope: { project_id: "PRJ-0001", fold_since: null, limits: { edges: 500, exploration_nodes: 200, recent_events: 10 } },
  folding_notes: [
    { section: "folded_assets", groups: 2, total_folded: 27, reason: "静态资源分支长期无变化", refs: ["A-009"] },
  ],
  content: {
    groups: [
      {
        asset_type: "service",
        total: 1,
        assets: [
          { id: "A-0001", canonical_key: "https://Test.Example.com:8443/api/Users?debug=1&x=%2F", original_input: "https://Test.Example.com:8443", scope_status: "allow", activity_seq: 40, created_seq: 38 },
        ],
      },
      {
        asset_type: "host",
        total: 2,
        assets: [
          { id: "A-0002", canonical_key: "https://Test.Example.com:8443/docs/A%20b/c.js?ts=123&sig=Xy%2B", original_input: "Api.Test.Example.com", scope_status: "pending", activity_seq: 20, created_seq: 20, path: "/docs/A%20b/c.js?ts=123&sig=Xy%2B" },
        ],
        folded: {
          count: 27,
          sample_ids: ["A-009", "A-010"],
          unfold_fold_since: 12,
          expand: { how: "以 fold_since=12 重新请求本快照可展开本组全部资产", note: "折叠只影响展示" },
        },
      },
    ],
    edges: [
      { id: "R-0001", from: "A-0002", to: "A-0001", relation_type: "discovered_from", from_kind: "assets", to_kind: "assets", valid_from_seq: 21, retracted_at: null },
    ],
    edges_total: 1,
    edges_omitted: 0,
    folded_dependencies: [],
    totals: { assets: 3, groups: 2, folded_assets: 27 },
    tech_stack: TECH_TREE,
    endpoint_templates: {
      total: 3,
      by_status: {
        candidate: {
          total: 2,
          omitted: 0,
          items: [
            { id: "T-0001", method: "GET", service_asset_id: "A-0001", path_template: "/api/Users/{id}", confidence: "0.80", created_seq: 41 },
            { id: "T-0002", method: "POST", service_asset_id: "A-0001", path_template: "/api/Login", confidence: null, created_seq: 42 },
          ],
        },
        confirmed: {
          total: 1,
          omitted: 0,
          items: [{ id: "T-0003", method: "GET", service_asset_id: "A-0001", path_template: "/api/Health", confidence: "0.95", created_seq: 43 }],
        },
      },
      folded: { split: 1, withdrawn: 0, note: "split/withdrawn 模板折叠为计数（折叠不删记录）" },
      expand: { how: "逐条经 GET /sorne/records/{id} 展开（T- 编号）；样本超出上限以计数标明，不静默截断" },
      note: "接口模板是候选接口族：模板可信状态可确认、拆分或撤回；原始采集与路径来源保留，不因模板合并丢失",
    },
  },
  subscription: {
    available: true,
    subscription_id: "SUBS-0002",
    subscription_revision: 3,
    resume_cursor: "c:SUBS-0002:3:42:0",
    snapshot_commit_seq: 42,
    note: "后续从 snapshot_commit_seq 之后重放事件",
  },
};

const INTENT_ROWS = [
  {
    id: "I-0007",
    project_id: "PRJ-0001",
    question: "登录入口有哪些调用？",
    kind: "investigate",
    status: "blocked",
    priority: 5,
    target_asset_ids: ["A-0001"],
    basis_refs: ["O-0003", "H-0007"],
    prerequisite_refs: ["H-0007"],
    resume_conditions: ["补充登录后身份条件", "等待 H-0007 复核"],
    budget: { max_tool_calls: 20 },
    success_criteria: "给出调用入口清单",
    deliverables: ["入口清单"],
    state_version: 2,
    plan_revision: "r1",
    scope_revision: "SR-0002",
    updated_seq: 32,
    created_seq: 30,
    condition_requirements: [],
  },
  {
    id: "I-0008",
    project_id: "PRJ-0001",
    question: "公开页面覆盖",
    kind: "collect",
    status: "running",
    priority: 3,
    target_asset_ids: ["A-0002"],
    basis_refs: ["O-0005"],
    prerequisite_refs: [],
    resume_conditions: [],
    state_version: 3,
    updated_seq: 33,
    created_seq: 31,
  },
  {
    id: "I-0009",
    project_id: "PRJ-0001",
    question: "依赖登录入口的后续方向",
    kind: "revisit",
    status: "proposed",
    priority: 2,
    target_asset_ids: [],
    basis_refs: [],
    prerequisite_refs: ["I-0007"],
    resume_conditions: [],
    state_version: 1,
    updated_seq: 34,
    created_seq: 34,
  },
];

const EXPL_MAP = {
  kind: "exploration_map",
  snapshot_id: "SNAP-E-0001",
  schema_version: 1,
  snapshot_commit_seq: 57,
  generated_at: "2026-11-06T03:00:00.000Z",
  project_id: "PRJ-0001",
  projection_scope: { project_id: "PRJ-0001", fold_since: 20, limits: { edges: 500, exploration_nodes: 200 } },
  folding_notes: "v1 之前已完成的方向折叠为计数；展开入口见各折叠块",
  content: {
    directions: [
      {
        goal_id: "G-0001",
        statement: "梳理登录面",
        status: "open",
        intents: [
          { id: "I-0007", question: "登录入口有哪些调用？", kind: "investigate", status: "blocked", priority: 5 },
          { id: "I-0008", question: "公开页面覆盖", kind: "collect", status: "running", priority: 3 },
        ],
      },
    ],
    ungrouped_intents: [{ id: "I-0009", question: "依赖登录入口的后续方向", kind: "revisit", status: "proposed", priority: 2 }],
    judgements: {
      hypotheses: { items: [{ id: "H-0007", statement: "另一接口访问限制可能异常", status: "open" }], count: 1, omitted: 0 },
      facts: { items: [], count: 0, omitted: 0 },
      vulnerabilities: { items: [{ id: "V-0003", status: "suspected", review: "clear", category: "SQL 注入", asset_id: "A-0001", location: "/api/users" }], count: 1, omitted: 0 },
    },
    unresolved: {
      open_hypotheses: ["H-0007"],
      blocked_intents: [{ id: "I-0007", question: "登录入口有哪些调用？", status: "blocked", resume_conditions: ["补充登录后身份条件"] }],
      blocked_intents_count: 1,
      suspected_vulnerabilities: ["V-0003"],
      pending_verification_jobs: 1,
    },
    edges: [
      { id: "R-0010", from: "O-0003", to: "H-0007", relation_type: "supports", valid_from_seq: 20, retracted_at: null },
      { id: "R-0011", from: "I-0007", to: "A-0001", relation_type: "targets", valid_from_seq: 22, retracted_at: null },
    ],
    edges_total: 2,
    edges_omitted: 0,
  },
  subscription: { available: true, subscription_id: "SUBS-0009", subscription_revision: 1, resume_cursor: "c:SUBS-0009:1:57:0" },
};

const ASSET_RECORD = {
  record: {
    id: "A-0001",
    kind: "assets",
    project_id: "PRJ-0001",
    asset_type: "service",
    canonicalization_version: "v1",
    canonical_key: "https://Test.Example.com:8443/api/Users?debug=1&x=%2F",
    original_input: "https://Test.Example.com:8443",
    scope_status: "allow",
    counts: { resources: 1, captures: 2, observations: 0, vulnerabilities: 1, intents_targeting: 1 },
    created_at: "2026-11-05T02:00:00.000Z",
    created_by: "worker-a",
    created_seq: 38,
    activity_seq: 40,
  },
  evidence_index: [],
  relations: {
    edges: [
      { id: "R-0020", from: "A-0001", to: "V-0003", relation_type: "targets", valid_from_seq: 30, retracted_at: null },
      { id: "R-0021", from: "I-0007", to: "A-0001", relation_type: "targets", valid_from_seq: 31, retracted_at: null },
      { id: "R-0022", from: "A-0001", to: "O-0003", relation_type: "discovered_from", valid_from_seq: 32, retracted_at: "2026-11-05T04:00:00.000Z" },
    ],
    truncated: false,
  },
  expand: { record_path: "/sorne/records/A-0001?project_id=PRJ-0001" },
};

const INTENT_RECORD = {
  record: {
    id: "I-0007",
    kind: "intents",
    project_id: "PRJ-0001",
    question: "登录入口有哪些调用？",
    kind: "investigate",
    status: "blocked",
    priority: 5,
    target_asset_ids: ["A-0001"],
    basis_refs: ["O-0003", "H-0007"],
    prerequisite_refs: ["H-0007"],
    resume_conditions: ["补充登录后身份条件"],
    condition_requirements: [],
    budget: { max_tool_calls: 20 },
    success_criteria: "给出调用入口清单",
    deliverables: ["入口清单"],
    state_version: 2,
    plan_revision: "r1",
    scope_revision: "SR-0002",
    updated_seq: 32,
    created_at: "2026-11-05T02:00:00.000Z",
    created_by: "planner-1",
    created_seq: 30,
  },
  evidence_index: [],
  relations: { edges: [{ id: "R-0011", from: "I-0007", to: "A-0001", relation_type: "targets", valid_from_seq: 22, retracted_at: null }], truncated: false },
};

const CAPTURE_DETAIL = {
  capture: {
    capture_id: "CAP-0002",
    request_url_exact: "https://Test.Example.com:8443/api/Users?debug=1&x=%2F",
    integrity_status: "verified",
  },
  response_body_blob: { sha256: SHA, representation: "raw_body" },
  request_ref_blob: { representation: "request_record" },
  read_pointers: { response_body_bytes: "/sorne/evidence/blobs/" + SHA + "?project_id=PRJ-0001" },
  transforms: [],
};

const MESSAGE_OK = {
  message: { id: "MSG-PRJ-0001-0001", direction: "user", status: "received", content: "…" },
  state: "queued_for_orchestrator",
};

/* ── 1. 页面契约 ──────────────────────────────────────────────────── */

test("M5 页面契约：两页纯 ESM 零 import、无浏览器存储、无钩子、无编号正则、无字面颜色值；注册表 id/title/order 正确", async () => {
  for (const [id, title, order] of [["assets", "资产", 30], ["exploration", "探索", 40]]) {
    const src = await readFile(join(PAGES_DIR, id + ".page.mjs"), "utf8");
    assert.doesNotMatch(src, /(^|\n)\s*import[\s(]/, id + " 页面不得静态 import 任何模块");
    assert.doesNotMatch(src, /[^.\w]require\s*\(/, id + " 页面不得使用 require");
    assert.doesNotMatch(src, /localStorage/, id + " 页面不得使用浏览器本地存储");
    assert.doesNotMatch(src, /React\.useState|React\.useEffect|useState\(|useEffect\(/, id + " 页面不得使用 React 钩子");
    assert.doesNotMatch(src, /RECORD_ID_RE/, id + " 页面不得自带编号正则（唯一实现在 lib/ui/record-ids.mjs）");
    assert.doesNotMatch(src, /#[0-9a-fA-F]{3,8}\b|rgba?\(/, id + " 页面不得书写字面颜色值（P0-1②）");
    assert.doesNotMatch(src, /--dsw-alias/, id + " 页面不得引用宿主变量");

    const def = await loadPage(id);
    assert.equal(def.id, id);
    assert.equal(def.title, title, "注册表标题（M5 重写后）");
    assert.equal(def.order, order);
    assert.equal(typeof def.render, "function");
    assert.equal(typeof def.renderDetail, "function", id + " 必须导出 renderDetail（右侧详情槽位契约）");
  }
});

test("M5 manifest：assets(order 30)/exploration(order 40) 已登记且文件路径正确（真实服务）", () =>
  withTestServer(async ({ request }) => {
    const manifest = await request("GET", "/sorne/ui/manifest");
    assert.equal(manifest.status, 200);
    const assets = manifest.body.pages.find((p) => p.id === "assets");
    const exploration = manifest.body.pages.find((p) => p.id === "exploration");
    assert.ok(assets, "manifest 缺 assets");
    assert.ok(exploration, "manifest 缺 exploration");
    assert.equal(assets.file, "/sorne/ui/pages/assets.page.mjs");
    assert.equal(exploration.file, "/sorne/ui/pages/exploration.page.mjs");
    assert.equal(assets.order, 30);
    assert.equal(exploration.order, 40);
    assert.equal(assets.title, "资产");
    assert.equal(exploration.title, "探索");
  }));

/* ── 2. 资产页：快照六要素 / 订阅边界 / 折叠 / 五块 ─────────────────── */

function assetsHandlers(over) {
  return {
    "GET /sorne/snapshots/asset_map": ASSET_SNAPSHOT,
    "GET /sorne/projects/PRJ-0001/asset-tree": ASSET_TREE,
    "GET /sorne/records/A-0001": ASSET_RECORD,
    ...over,
  };
}

test("资产页：快照六要素逐项 + 订阅边界/resume_cursor + 投影范围转可读行 + 数据时刻/截止边界", async () => {
  const def = await loadPage("assets");
  const t = mountPage(def, makeCtx(fakeApi(assetsHandlers()), makeRouter()));
  await t.flush();
  const text = t.text();

  assert.match(text, /资产快照/);
  assert.match(text, /SNAP-A-0001/);
  assert.match(text, /数据截止 #42/);
  assert.match(text, /2026-11-06 10:00:00/);
  assert.match(text, /投影范围：项目 PRJ-0001 · 折叠边界：未启用 · 上限：关系边 500 · 探索判断 200 · 近期事件 10/);
  assert.match(text, /订阅边界：SUBS-0002（修订 3）/);
  assert.doesNotMatch(text, /resume_cursor/);
  assert.match(text, /异步投影不代表数据库当前版本/);
  assert.match(text, /数据时刻 .*截止边界（提交序号）42/);
  assert.doesNotMatch(text, /\{"project_id":"PRJ-0001"/);
});

test("资产页五块：站点树（discovered_from 层级）+ 资产列表（类型分组真表格）+ 技术栈（口径）+ 接口（候选/已确认模板）+ 文件及来源入口", async () => {
  const def = await loadPage("assets");
  const t = mountPage(def, makeCtx(fakeApi(assetsHandlers()), makeRouter()));
  await t.flush();
  const text = t.text();

  for (const block of ["资产列表", "技术栈", "接口（候选接口族）"]) {
    assert.ok(text.includes(block), "五块缺「" + block + "」");
  }
  assert.ok(text.includes("https://Test.Example.com:8443/api/Users?debug=1&x=%2F"), "规范身份原样呈现");
  const heads = t.findAll((n) => n.type === "th").map((n) => t.nodeText(n.children));
  assert.deepEqual(heads.slice(0, 5), ["编号", "规范身份", "范围状态", "活动提交序号", "创建提交序号"]);
  assert.match(text, /允许/);
  assert.match(text, /待判断/);
  assert.match(text, /口径：产品 → 版本 → 证据/);
  assert.match(text, /产品 4 · 版本节点 5 · 原始条目 10（同产品合并 6 条；版本未知节点 3 个）/);
  assert.match(text, /通达OA/);
  assert.match(text, /版本 2015/);
  assert.match(text, /版本未知/);
  assert.match(text, /候选模板/);
  assert.match(text, /已确认模板/);
  assert.match(text, /T-0001/);
  assert.match(text, /\/api\/Users\/\{id\}/);
  assert.match(text, /接口模板是候选接口族/);
});


test("资产页技术栈画像：10 条同名/变体指纹归并为 4 个产品；通达OA 下分版本 2015/未知；证据编号可下钻", async () => {
  const def = await loadPage("assets");
  const router = makeRouter();
  const t = mountPage(def, makeCtx(fakeApi(assetsHandlers()), router));
  await t.flush();
  const text = t.text();

  // 分层画像：4 个产品 / 5 个版本节点 / 10 条原始条目（同产品合并 6 条）
  assert.match(text, /技术栈画像/);
  assert.match(text, /产品 4 · 版本节点 5 · 原始条目 10（同产品合并 6 条；版本未知节点 3 个）/);
  // 通达OA 是产品节点，2015 与版本未知是其子节点（不是并列产品）
  assert.match(text, /通达OA（别名：Tongda2000 MYOA、Tongda MYOA）/);
  assert.match(text, /版本 2015（1 条）/);
  assert.match(text, /版本未知（3 条）/);
  // 跨站点技术栈用在资产目录区也渲染（不再按站点平铺）
  assert.match(text, /跨站点知识：产品 → 版本 → 证据/);
  assert.doesNotMatch(text, /口径：以资产类型聚合/);
  assert.doesNotMatch(text, /产品 \/ 组件 \/ 版本/, "旧扁平表格的列头不应再出现");

  // 叶子证据仍可下钻到原始资产记录
  const chips = t.findAll((n) => n.type === "button" && String(n.props["aria-label"] || "").includes("A-0106"));
  assert.ok(chips.length >= 1, "2015 版模板的资产编号应渲染为 chip");
  t.click(chips[0]);
  assert.ok(router.__calls.some((c) => c.kind === "openRecord" && c.id === "A-0106"), "点击证据编号应打开原始资产记录");
});

test("资产页：URL/路径原样展示（不小写、不解码、不重排参数）——旧 B3「不改写」断言迁移", async () => {
  const def = await loadPage("assets");
  const t = mountPage(def, makeCtx(fakeApi(assetsHandlers()), makeRouter()));
  await t.flush();
  const text = t.text();

  assert.ok(text.includes("https://Test.Example.com:8443/api/Users?debug=1&x=%2F"), "URL 必须逐字原样");
  assert.ok(text.includes("/docs/A%20b/c.js?ts=123&sig=Xy%2B"), "路径必须逐字原样（原始输入原样呈现）");
  assert.doesNotMatch(text, /test\.example\.com/, "不得小写化主机");
  assert.doesNotMatch(text, /\/api\/users/, "不得小写化路径");
  assert.ok(!text.includes("x=/"), "不得把 %2F 解码成 /");
  assert.ok(!text.includes("/docs/A b/"), "不得把 %20 解码成空格");
  assert.ok(!text.includes("Xy+"), "不得把 %2B 解码成 +");
});

test("资产页：折叠分组保留计数 + 样本 + 展开入口（fold_since 续读）；行点击打开右侧详情", async () => {
  const def = await loadPage("assets");
  const router = makeRouter();
  const api = fakeApi(assetsHandlers());
  const t = mountPage(def, makeCtx(api, router));
  await t.flush();

  assert.match(t.text(), /已折叠 27 项（活动提交序号小于折叠边界；折叠只影响展示，折叠不删记录）/);
  t.click(t.findButton("展开本组"));
  const foldNav = router.__calls.find((c) => c.kind === "open");
  assert.ok(foldNav, "展开本组应导航");
  assert.match(foldNav.hash, /#\/p\/PRJ-0001\/assets\?fold_since=12/);

  const rows = t.rowElements();
  assert.ok(rows.length >= 1, "资产列表应有可点击行");
  t.click(rows[0]);
  const nav = router.__calls.filter((c) => c.kind === "open").pop();
  assert.equal(nav.hash, "#/p/PRJ-0001/assets?id=A-0001", "行点击 → ?id=资产编号");
});

test("资产页：不再渲染站点树/文件及来源（按操作员要求只保留资产/技术栈/接口）", async () => {
  const def = await loadPage("assets");
  const t = mountPage(def, makeCtx(fakeApi(assetsHandlers()), makeRouter({ params: { id: "A-0001" } })));
  await t.flush();
  const text = t.text();
  assert.doesNotMatch(text, /站点树/);
  assert.doesNotMatch(text, /文件及来源/);
  assert.match(text, /资产列表/);
  assert.match(text, /技术栈/);
  assert.match(text, /接口（候选接口族）/);
});

/* ── 3. 资产页：右侧详情 + 消息草稿 ─────────────────────────────────── */

test("资产详情（renderDetail）：字段/计数/相关发现/已开展探索/关系边（撤回保留）：旧「按编号展开」语义迁移到 chip + 右栏", async () => {
  const def = await loadPage("assets");
  const t = mountDetail(def, makeCtx(fakeApi(assetsHandlers()), makeRouter({ params: { id: "A-0001" } })));
  await t.flush();
  const text = t.text();

  assert.match(text, /资产详情/);
  assert.match(text, /编号/);
  assert.match(text, /资产类型/);
  assert.match(text, /规范化键/);
  assert.match(text, /原始输入/);
  assert.match(text, /范围状态/);
  assert.match(text, /来源与关联（计数来自资产记录）/);
  assert.match(text, /资源 1 · 采集 2 · 观察 0 · 漏洞 1 · 指向此资产的意图 1/);
  assert.match(text, /相关发现/);
  assert.match(text, /已开展的探索/);
  assert.match(text, /漏洞状态以库为准：已确认永远带「（限指定条件）」，证据不足不伪装成已排除。/);
  assert.match(text, /关系边/);
  assert.match(text, /（已撤回，历史保留）/, "撤回边保留显示（历史不覆盖）");
  const chipBtn = t.findAll((n) => n.type === "button" && String(n.props["aria-label"] || "").includes("V-0003"));
  assert.ok(chipBtn.length >= 1, "相关发现编号应渲染为 chip");
  // 旧「点击编号 → /records/{id} 呈现记录」迁移：chip 点击经 router.openRecord 打开覆盖层（外壳级）
  const router = makeRouter({ params: { id: "A-0001" } });
  const t2 = mountDetail(def, makeCtx(fakeApi(assetsHandlers()), router));
  await t2.flush();
  t2.click(t2.findAll((n) => n.type === "button" && String(n.props["aria-label"] || "").includes("V-0003"))[0]);
  assert.ok(router.__calls.some((c) => c.kind === "openRecord" && c.id === "V-0003"), "编号点击应 openRecord（完整编号）");
});

test("资产详情：「就此资产向 AI 下任务」预填消息草稿 → POST /sorne/messages；成功呈现已接收≠已处理；失败与空内容如实呈现", async () => {
  const def = await loadPage("assets");
  const okApi = fakeApi(assetsHandlers({ "POST /sorne/messages": MESSAGE_OK }));
  const t = mountDetail(def, makeCtx(okApi, makeRouter({ params: { id: "A-0001" } })));
  await t.flush();

  const draft = t.findTextarea();
  assert.match(draft.props.value, /请针对资产 A-0001（https:\/\/Test.Example.com:8443\/api\/Users\?debug=1&x=%2F）安排下一步探索：/, "预填草稿含资产编号与规范身份");
  t.click(t.findButton("发送消息"));
  await t.flush();

  const post = okApi.calls.find((c) => c.method === "POST" && c.path === "/sorne/messages");
  assert.ok(post, "应 POST /sorne/messages");
  assert.equal(post.body.project_id, "PRJ-0001");
  assert.match(post.body.content, /A-0001/);
  assert.match(t.text(), /已提交：/);
  assert.match(t.text(), /MSG-PRJ-0001-0001/);
  assert.match(t.text(), /已接收（尚未处理）/);
  assert.match(t.text(), /收到 ≠ 已处理（queued_for_orchestrator），等待协调 AI 处理。/);

  t.findTextarea().props.onChange({ target: { value: "   " } });
  await t.flush();
  t.click(t.findButton("发送消息"));
  await t.flush();
  assert.match(t.text(), /消息发送失败：消息内容不能为空/);

  const failApi = fakeApi(assetsHandlers({
    "POST /sorne/messages": () => {
      throw apiError(422, { code: "INVALID_REFERENCE", message: "附件引用不存在" });
    },
  }));
  const t2 = mountDetail(def, makeCtx(failApi, makeRouter({ params: { id: "A-0001" } })));
  await t2.flush();
  t2.click(t2.findButton("发送消息"));
  await t2.flush();
  assert.match(t2.text(), /消息发送失败：INVALID_REFERENCE · 附件引用不存在/);
});

/* ── 4. 资产页：501 / 错误 / 未知形状 / 空态 / 无项目 ───────────────── */

test("资产页：快照 501 → 未实现态（501 未实现 ≠ 报错）且五块如实置空；记录 501 同样不白屏", async () => {
  const def = await loadPage("assets");
  const t = mountPage(def, makeCtx(fakeApi({
    "GET /sorne/snapshots/asset_map": notImpl("B1", "GET", "/sorne/snapshots/asset_map", "§15.1"),
    "GET /sorne/records/A-0001": notImpl("B1", "GET", "/sorne/records/:id", "§11.2"),
  }), makeRouter({ params: { id: "A-0001" } })));
  await t.flush();
  const text = t.text();

  assert.match(text, /资产地图快照未实现/);
  assert.match(text, /501 未实现 ≠ 报错/);
  assert.match(text, /资产 \/ 技术栈 \/ 接口（快照未实现）/);
  assert.match(text, /未提供不等于不存在/);
  assert.doesNotMatch(text, /文件及来源/);
  assert.match(text, /服务端说明：端点 GET \/sorne\/snapshots\/asset_map 由模块 B1 施工/, "服务端未实现说明原文呈现");
});

test("资产页：快照 500 → 错误卡（含错误码与可重试），其余区块不拖垮", async () => {
  const def = await loadPage("assets");
  const api = fakeApi({
    "GET /sorne/snapshots/asset_map": () => {
      throw apiError(500, { code: "INTERNAL_ERROR", message: "投影服务暂时不可用" });
    },
  });
  const t = mountPage(def, makeCtx(api, makeRouter()));
  await t.flush();
  assert.match(t.text(), /资产地图快照不可用/);
  assert.match(t.text(), /INTERNAL_ERROR · 投影服务暂时不可用/);
  const before = api.calls.length;
  t.click(t.findButton("重试"));
  await t.flush();
  assert.ok(api.calls.length > before, "重试应重新请求");
});

test("资产页：未知形状 → 显式「形状无法识别」（不静默当作空资产）", async () => {
  const def = await loadPage("assets");
  const t = mountPage(def, makeCtx(fakeApi({ "GET /sorne/snapshots/asset_map": { hello: 1 } }), makeRouter()));
  await t.flush();
  assert.match(t.text(), /资产地图快照形状无法识别/);
  assert.match(t.text(), /不猜测、不当作空资产/);
});

test("资产页：空资产 → 显式空态（未发现资产 ≠ 技术栈未知）；无项目 → 提示且不发快照请求", async () => {
  const def = await loadPage("assets");
  const emptyApi = fakeApi({
    "GET /sorne/snapshots/asset_map": {
      ...ASSET_SNAPSHOT,
      content: { groups: [], edges: [], edges_total: 0, edges_omitted: 0, folded_dependencies: [], totals: { assets: 0, groups: 0, folded_assets: 0 } },
    },
  });
  const t = mountPage(def, makeCtx(emptyApi, makeRouter()));
  await t.flush();
  assert.match(t.text(), /尚未发现资产/);
  assert.match(t.text(), /分组计数为 0 是准确计数/);

  const noProjApi = fakeApi({});
  const t2 = mountPage(def, makeCtx(noProjApi, makeRouter({ projectId: null })));
  await t2.flush();
  assert.match(t2.text(), /未选择项目/);
  assert.equal(noProjApi.calls.length, 0, "无项目时不发任何请求");
});

test("资产页：项目切换后按新 project_id 重读，旧资产不残留（要求 §2：页面继承当前项目）", async () => {
  const def = await loadPage("assets");
  const api = fakeApi({
    "GET /sorne/snapshots/asset_map": (_b, path) => (path.includes("PRJ-0002")
      ? {
          ...ASSET_SNAPSHOT,
          snapshot_id: "SNAP-B-0002",
          project_id: "PRJ-0002",
          folding_notes: [],
          projection_scope: { project_id: "PRJ-0002", fold_since: null, limits: { edges: 500 } },
          content: {
            groups: [{ asset_type: "domain", total: 1, assets: [{ id: "A-0500", canonical_key: "second.test.example", scope_status: "allow", activity_seq: 10, created_seq: 10 }] }],
            edges: [],
            edges_total: 0,
            edges_omitted: 0,
            folded_dependencies: [],
            totals: { assets: 1, groups: 1, folded_assets: 0 },
          },
        }
      : ASSET_SNAPSHOT),
  });
  const router = makeRouter();
  const t = mountPage(def, makeCtx(api, router));
  await t.flush();
  assert.match(t.text(), /A-0001/);

  router.projectId = "PRJ-0002";
  router.hash = "#/p/PRJ-0002/assets";
  router.fire();
  await t.flush();
  const text = t.text();
  assert.match(text, /A-0500/);
  assert.match(text, /second\.test\.example/);
  assert.doesNotMatch(text, /A-0001/, "旧项目资产不得残留");
  assert.ok(api.calls.some((c) => c.path.includes("/sorne/snapshots/asset_map") && c.path.includes("PRJ-0002")), "应以新 project_id 请求快照");
});

/* ── 5. 探索页：方向列表 / 分支图 / 大图 ───────────────────────────── */

function explorationHandlers(over) {
  return {
    "GET /sorne/snapshots/exploration_map": EXPL_MAP,
    "GET /sorne/intents": { project_id: "PRJ-0001", intents: INTENT_ROWS, next_cursor: null, has_more: false },
    "GET /sorne/records/I-0007": INTENT_RECORD,
    ...over,
  };
}

test("探索页：方向列表按目标分组，逐条呈现目标/依据/前提/进展/阻塞/后续；状态徽章不夸大", async () => {
  const def = await loadPage("exploration");
  const router = makeRouter({ page: "exploration" });
  const t = mountPage(def, makeCtx(fakeApi(explorationHandlers()), router));
  await t.flush();
  const text = t.text();

  assert.match(text, /方向列表/);
  assert.match(text, /梳理登录面/);
  assert.match(text, /目标状态：open/);
  assert.match(text, /（本组 2 条方向）/);
  assert.match(text, /I-0007/);
  assert.match(text, /受阻（等待条件补齐）/);
  assert.match(text, /类别：调查（investigate）/);
  assert.match(text, /优先级：5/);
  assert.match(text, /登录入口有哪些调用？/);
  assert.match(text, /目标：/);
  assert.match(text, /依据：/);
  assert.match(text, /前提：/);
  assert.match(text, /更新提交 #32 · 状态版本 2 · 计划修订 r1/);
  assert.match(text, /阻塞：/);
  assert.match(text, /· 补充登录后身份条件/);
  assert.match(text, /· 等待 H-0007 复核/);
  assert.match(text, /后续：/);
  assert.match(text, /I-0009/);
  assert.match(text, /待归类方向/);
  assert.match(text, /resolved 只表示该版本的问题已处理，不代表关联资产已测透（规范 §10\.1）/);
  assert.match(text, /恢复与重派由协调 AI 决定，程序不写死固定重试（规范 §3\.1\/§3\.2）/);
  assert.match(text, /本 Map 是派生阅读视图，可由持久记录完全重建，不是事实与状态的真值来源/);
  assert.match(text, /状态以持久记录为准：疑似不写作已确认/);
  assert.match(text, /已加载方向 3 条 · 计数与列表按已加载数据推导/);
  assert.match(text, /截止边界（提交序号）57/);
  // 旧「点击内容中的编号 → /records/{id}」迁移：编号 chip 点击 openRecord
  const chipBtns = t.findAll((n) => n.type === "button" && String(n.props["aria-label"] || "").includes("A-0001"));
  assert.ok(chipBtns.length >= 1, "目标资产编号应渲染为 chip");
  t.click(chipBtns[0]);
  assert.ok(router.__calls.some((c) => c.kind === "openRecord" && c.id === "A-0001"), "编号点击应 openRecord（完整编号）");
});

test("探索页 J5：新意图出现在方向列表且依据/前提随记录呈现（刷新后可见新方向）；点击详情带 view 与 id", async () => {
  const def = await loadPage("exploration");
  const newIntent = {
    id: "I-0600",
    project_id: "PRJ-0001",
    question: "新接收的登录后接口方向",
    kind: "investigate",
    status: "proposed",
    priority: 6,
    target_asset_ids: ["A-0001"],
    basis_refs: ["O-0042"],
    prerequisite_refs: ["H-0007"],
    resume_conditions: [],
    state_version: 1,
    updated_seq: 88,
    created_seq: 88,
  };
  let round = 0;
  const api = fakeApi({
    "GET /sorne/snapshots/exploration_map": EXPL_MAP,
    "GET /sorne/intents": () => {
      round += 1;
      return { intents: round === 1 ? INTENT_ROWS : [...INTENT_ROWS, newIntent], next_cursor: null, has_more: false };
    },
  });
  const router = makeRouter({ page: "exploration" });
  const t = mountPage(def, makeCtx(api, router));
  await t.flush();
  assert.doesNotMatch(t.text(), /新接收的登录后接口方向/);

  t.click(t.findButton("刷新"));
  await t.flush();
  const text = t.text();
  assert.match(text, /新接收的登录后接口方向/, "J5：新意图进入方向列表");
  assert.match(text, /O-0042/, "依据编号随记录呈现");
  assert.ok(text.includes("I-0600"));

  t.click(t.findButton("查看方向详情"));
  const nav = router.__calls.filter((c) => c.kind === "open").pop();
  assert.equal(nav.hash, "#/p/PRJ-0001/exploration?view=list&id=I-0600", "J5 新方向详情：hash 带 view 与 id");
});

test("探索页：视图切换（列表 / 局部分支图 view=graph / 完整大图 view=full 辅助）；分支图只呈直接邻接并明示不代表全量", async () => {
  const def = await loadPage("exploration");
  const router = makeRouter({ page: "exploration" });
  const t = mountPage(def, makeCtx(fakeApi(explorationHandlers()), router));
  await t.flush();

  t.click(t.findButton("局部分支图"));
  const nav = router.__calls.filter((c) => c.kind === "open").pop();
  assert.equal(nav.hash, "#/p/PRJ-0001/exploration?view=graph");

  const g = mountPage(def, makeCtx(fakeApi(explorationHandlers()), makeRouter({ page: "exploration", params: { view: "graph", id: "I-0007" } })));
  await g.flush();
  const gt = g.text();
  assert.match(gt, /局部分支图/);
  assert.match(gt, /前提 ──▶/);
  assert.match(gt, /依据：/);
  assert.match(gt, /目标：/);
  assert.match(gt, /局部视图只含直接邻接；不代表全量/);

  const f = mountPage(def, makeCtx(fakeApi(explorationHandlers()), makeRouter({ page: "exploration", params: { view: "full" } })));
  await f.flush();
  const ft = f.text();
  assert.match(ft, /完整大图（辅助视图）/);
  assert.match(ft, /假设（1）/);
  assert.match(ft, /漏洞（1）/);
  assert.match(ft, /疑似/);
  assert.match(ft, / @ \/api\/users/, "漏洞位置原样呈现（不改写路径）");
  assert.match(ft, /支持关系（supports）（1）/);
  assert.match(ft, /指向关系（targets）（1）/);
  assert.match(ft, /关系边共 2 条/);
});

/* ── 6. 探索页：501 / 错误 / 未知形状 / 空态 / 项目切换 ─────────────── */

test("探索页：快照 501 时方向列表仍按意图端点呈现（501 未实现 ≠ 报错）；快照与意图均 501 → 显式不可用", async () => {
  const def = await loadPage("exploration");
  const mapOnly = fakeApi({
    "GET /sorne/snapshots/exploration_map": notImpl("B1", "GET", "/sorne/snapshots/exploration_map", "§15.1"),
    "GET /sorne/intents": { intents: INTENT_ROWS },
  });
  const t = mountPage(def, makeCtx(mapOnly, makeRouter({ page: "exploration" })));
  await t.flush();
  assert.match(t.text(), /探索地图快照未实现/);
  assert.match(t.text(), /方向列表按意图端点呈现/);
  assert.match(t.text(), /全部方向（意图端点）/);
  assert.match(t.text(), /登录入口有哪些调用？/, "意图端点可用时方向仍呈现");

  const both = fakeApi({
    "GET /sorne/snapshots/exploration_map": notImpl("B1", "GET", "/sorne/snapshots/exploration_map", "§15.1"),
    "GET /sorne/intents": notImpl("C1", "GET", "/sorne/intents", "§10.1"),
  });
  const t2 = mountPage(def, makeCtx(both, makeRouter({ page: "exploration" })));
  await t2.flush();
  assert.match(t2.text(), /探索地图快照未实现/);
  assert.match(t2.text(), /意图队列未实现/);
  assert.match(t2.text(), /方向列表不可用/);
  assert.match(t2.text(), /未实现 ≠ 没有方向，未提供 ≠ 不存在/);
});

test("探索页：快照错误 → 错误卡（列表仍可用）；未知形状 → 显式提示；空方向 → 空态引导", async () => {
  const def = await loadPage("exploration");
  const t = mountPage(def, makeCtx(fakeApi({
    "GET /sorne/snapshots/exploration_map": () => {
      throw apiError(500, { code: "INTERNAL_ERROR", message: "投影生成失败" });
    },
    "GET /sorne/intents": { intents: INTENT_ROWS },
  }), makeRouter({ page: "exploration" })));
  await t.flush();
  assert.match(t.text(), /探索地图快照不可用/);
  assert.match(t.text(), /INTERNAL_ERROR · 投影生成失败/);
  assert.match(t.text(), /方向列表仍按意图端点呈现/);

  const t2 = mountPage(def, makeCtx(fakeApi({
    "GET /sorne/snapshots/exploration_map": { hello: 1 },
    "GET /sorne/intents": { intents: [] },
  }), makeRouter({ page: "exploration" })));
  await t2.flush();
  assert.match(t2.text(), /探索地图快照形状无法识别/);

  const t3 = mountPage(def, makeCtx(fakeApi({
    "GET /sorne/snapshots/exploration_map": { ...EXPL_MAP, content: { directions: [], ungrouped_intents: [], judgements: {}, edges: [], edges_total: 0 } },
    "GET /sorne/intents": { intents: [] },
  }), makeRouter({ page: "exploration" })));
  await t3.flush();
  assert.match(t3.text(), /尚无探索方向/);
  assert.match(t3.text(), /POST \/plan-revisions/);
});

test("探索页：项目切换后按新 project_id 重读，旧方向不残留（要求 §2）", async () => {
  const def = await loadPage("exploration");
  const api = fakeApi({
    "GET /sorne/snapshots/exploration_map": (_b, path) => (path.includes("PRJ-0002") ? { ...EXPL_MAP, content: { directions: [], ungrouped_intents: [], judgements: {}, edges: [], edges_total: 0 } } : EXPL_MAP),
    "GET /sorne/intents": (_b, path) => (path.includes("PRJ-0002")
      ? { intents: [{ id: "I-0900", question: "第二项目的方向", kind: "collect", status: "running", priority: 1 }] }
      : { intents: INTENT_ROWS }),
  });
  const router = makeRouter({ page: "exploration" });
  const t = mountPage(def, makeCtx(api, router));
  await t.flush();
  assert.match(t.text(), /登录入口有哪些调用？/);

  router.projectId = "PRJ-0002";
  router.hash = "#/p/PRJ-0002/exploration";
  router.fire();
  await t.flush();
  const text = t.text();
  assert.match(text, /第二项目的方向/);
  assert.doesNotMatch(text, /登录入口有哪些调用？/, "旧项目方向不得残留");
  assert.ok(api.calls.some((c) => c.path.includes("/sorne/intents?") && c.path.includes("PRJ-0002")), "应以新 project_id 请求意图");
});

/* ── 7. 探索页：方向详情 + 消息草稿 ────────────────────────────────── */

test("方向详情（renderDetail）：合同字段 + 目标/依据/前提 + 关系边；追问/建议暂缓填草稿并 POST /sorne/messages", async () => {
  const def = await loadPage("exploration");
  const api = fakeApi(explorationHandlers({ "POST /sorne/messages": MESSAGE_OK }));
  const t = mountDetail(def, makeCtx(api, makeRouter({ page: "exploration", params: { id: "I-0007" } })));
  await t.flush();
  let text = t.text();

  assert.match(text, /方向详情/);
  // LABELS 未登记 question：按冻结降级规则显示「键名（标签未登记）」——未登记不省略、不猜测。
  assert.match(text, /question（标签未登记）/);
  assert.match(text, /登录入口有哪些调用？/);
  assert.match(text, /目标 \/ 依据 \/ 前提/);
  assert.match(text, /目标：/);
  assert.match(text, /依据：/);
  assert.match(text, /前提：/);
  assert.match(text, /关系边/);
  assert.match(text, /操作：消息草稿（追问 \/ 建议暂缓）/);
  assert.match(text, /恢复与重派由协调 AI 决定/);
  assert.match(t.findTextarea().props.value, /关于探索方向 I-0007（登录入口有哪些调用？）：请解释当前进展与下一步建议：/);

  t.click(t.findButton("建议暂缓"));
  await t.flush();
  assert.equal(t.findTextarea().props.value, "建议暂缓方向 I-0007：理由：");
  t.click(t.findButton("追问 AI"));
  await t.flush();
  assert.match(t.findTextarea().props.value, /关于探索方向 I-0007/);

  t.click(t.findButton("发送消息"));
  await t.flush();
  const post = api.calls.find((c) => c.method === "POST" && c.path === "/sorne/messages");
  assert.ok(post, "应 POST /sorne/messages");
  assert.equal(post.body.project_id, "PRJ-0001");
  assert.match(post.body.content, /I-0007/);
  text = t.text();
  assert.match(text, /已提交：/);
  assert.match(text, /已接收（尚未处理）/);
  assert.match(text, /收到 ≠ 已处理/);

  const failApi = fakeApi(explorationHandlers({
    "POST /sorne/messages": () => {
      throw apiError(500, { code: "INTERNAL_ERROR", message: "消息服务不可用" });
    },
  }));
  const t2 = mountDetail(def, makeCtx(failApi, makeRouter({ page: "exploration", params: { id: "I-0007" } })));
  await t2.flush();
  t2.click(t2.findButton("发送消息"));
  await t2.flush();
  assert.match(t2.text(), /消息发送失败：INTERNAL_ERROR · 消息服务不可用/);
});

test("方向详情：记录 404 → 显式读取失败；无 ?id → 提示从列表选择（不臆造）", async () => {
  const def = await loadPage("exploration");
  const t = mountDetail(def, makeCtx(fakeApi({
    "GET /sorne/records/I-9999": () => {
      throw apiError(404, { code: "NOT_FOUND", message: "记录不存在：I-9999" });
    },
  }), makeRouter({ page: "exploration", params: { id: "I-9999" } })));
  await t.flush();
  assert.match(t.text(), /方向 I-9999读取失败/);
  assert.match(t.text(), /NOT_FOUND · 记录不存在：I-9999/);

  const t2 = mountDetail(def, makeCtx(fakeApi({}), makeRouter({ page: "exploration" })));
  await t2.flush();
  assert.match(t2.text(), /未选择方向/);
});

/* ── 8. 真实服务集成（assets 五块 + exploration J5 真实记录） ──────── */

test("真实服务：提交资产/HTTP 资源/接口模板与计划接收后，资产页五块与探索页方向列表呈现真实记录", () =>
  withTestServer(async ({ base, request }) => {
    const created = await request("POST", "/sorne/projects", {
      body: { name: "M5 走查项目", scope_rules: { allow: ["*.test.example"], deny: [], pending: [] } },
    });
    assert.equal(created.status, 200, "创建项目失败：" + JSON.stringify(created.body));
    const pid = created.body.project.id;

    const worker = issueSession({ project_id: pid, actor: "m5-worker", role: "worker" });
    const sub1 = await authedCall(base, "POST", "/sorne/submissions", {
      session: worker,
      body: {
        submission_id: "M5-SUB-ASSET",
        operations: [
          { op: "register_asset", local_ref: "svc", asset_type: "service", canonicalization_version: "v1", canonical_key: "https://api.test.example" },
        ],
      },
    });
    assert.equal(sub1.status, 200, "注册资产失败：" + JSON.stringify(sub1.body));
    const assetId = sub1.body.ids.svc;
    const sub2 = await authedCall(base, "POST", "/sorne/submissions", {
      session: worker,
      body: {
        submission_id: "M5-SUB-RES",
        operations: [
          { op: "register_http_resource", local_ref: "res", url: "https://api.test.example/v1/users/42" },
        ],
      },
    });
    assert.equal(sub2.status, 200, "登记资源失败：" + JSON.stringify(sub2.body));
    const resId = sub2.body.ids.res;
    const sub3 = await authedCall(base, "POST", "/sorne/submissions", {
      session: worker,
      body: {
        submission_id: "M5-SUB-TPL",
        operations: [
          { op: "propose_endpoint_template", local_ref: "tpl", resource_ids: [resId], service_asset_id: assetId },
        ],
      },
    });
    assert.equal(sub3.status, 200, "接口模板提案失败：" + JSON.stringify(sub3.body));

    const planner = issueSession({ project_id: pid, actor: "m5-planner", role: "planner" });
    const plan = await authedCall(base, "POST", "/sorne/plan-revisions", {
      session: planner,
      body: {
        submission_id: "M5-PLAN-1",
        plan_revision: "r1",
        intents: [
          {
            op: "create",
            local_ref: "i1",
            question: "M5 走查：/v1/users 的参数是否影响查询？",
            kind: "investigate",
            success_criteria: "给出是否可注入的回答或明确缺口",
          },
        ],
      },
    });
    assert.equal(plan.status, 200, "计划接收失败：" + JSON.stringify(plan.body));
    const intentId = plan.body.ids.i1;
    assert.ok(intentId);

    const snap = await request("GET", "/sorne/snapshots/asset_map?project_id=" + encodeURIComponent(pid));
    assert.equal(snap.status, 200, "快照失败：" + JSON.stringify(snap.body));
    const hasTemplates = Boolean(snap.body.content && snap.body.content.endpoint_templates && snap.body.content.endpoint_templates.total >= 1);

    const assetsDef = await loadPage("assets");
    const at = mountPage(assetsDef, makeCtx(realApi(base), makeRouter({ projectId: pid })));
    await waitText(at, () => !at.text().includes("正在读取资产地图快照"), "资产快照呈现");
    const atText = at.text();
    assert.match(atText, /api\.test\.example/, "真实资产规范身份应可见");
    assert.ok(atText.includes(assetId), "真实资产编号应可见");
    if (hasTemplates) {
      assert.match(atText, /候选模板/, "接口块按候选模板分列");
      assert.match(atText, /T-/, "接口模板编号 chip");
    } else {
      assert.match(atText, /服务端未返回接口模板维度/, "模板维度缺失时如实呈现未提供（不臆造）");
    }
    assert.match(atText, /SNAP-/, "真实快照编号");

    const expDef = await loadPage("exploration");
    const et = mountPage(expDef, makeCtx(realApi(base), makeRouter({ page: "exploration", projectId: pid })));
    await waitText(et, () => et.text().includes("M5 走查：/v1/users 的参数是否影响查询？"), "探索方向呈现");
    const etText = et.text();
    assert.match(etText, /方向列表/);
    assert.ok(etText.includes(intentId), "真实意图编号应可见");
    assert.match(etText, /依据：/);
    assert.match(etText, /截止边界（提交序号）\d+/);
  }));
