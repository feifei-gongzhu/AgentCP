/**
 * M4 —— 系统诊断页测试（lib/ui/pages/diagnostics.page.mjs；BLUEPRINT-UI §1.5/§g）。
 *
 * 覆盖：页面契约、#49 诊断聚合各块、#41 指标原始 JSON 折叠、#45 变化流只读视图、
 * #23 执行尝试/租约/工具调用（unknown 置顶红字）、只读职责边界、自动刷新、游标分页、
 * 501/403/500/未知形状/空态降级、真实服务集成。
 *
 * 旧断言迁移：承接原 test/ui-execution.test.mjs（租约/工具调用/unknown/自动刷新/501/
 * 错误/未知形状/空态/游标分页/观察摘要）与 test/change-log.test.mjs 页面半边（契约/
 * 事件/游标/订阅边界/错误/未知形状）的语义断言；意图状态过滤、意图游标分页、项目选择器
 * 等属工作台/外壳职责的断言迁入 test/ui-workbench.test.mjs 与外壳测试（清单见
 * docs/modules/ui-M4-diagnostics.md）。
 *
 * 测试宿主：最小 createElement + Component 基类驱动页面类组件，并绑定 M1 真实渲染器
 * （lib/ui/render.mjs + record-ids.mjs，经 bindRenderers 注入），断言打到真实渲染输出。
 * 并行安全：fakeApi 用例不占端口；真实服务用例走 withTestServer；自动刷新用例以桩替换
 * global setInterval/clearInterval（finally 恢复），不留后台进程。
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
  const mod = await import(pathToFileURL(join(PAGES_DIR, id + ".page.mjs")).href);
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

const React = { createElement: h, Component: ComponentBase };

/* ── 路由桩（页面只读 router.projectId / router.onChange / router.openRecord） ── */

function makeRouter(projectId) {
  const opened = [];
  const listeners = new Set();
  return {
    page: "diagnostics",
    projectId,
    params: {},
    query: {},
    hash: "#/p/" + projectId + "/diagnostics",
    open() {},
    replace() {},
    back() {},
    openRecord(id) { opened.push(id); },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    __opened: opened,
    __notify() { for (const fn of Array.from(listeners)) fn(this); },
  };
}

/* ── 挂载仿真：展开类组件树（同位实例跨渲染保留） ─────────────────── */

function mountPage(def, api, router) {
  const ctx = { React, h, api, router: router || makeRouter("PRJ-001"), ui };
  const rootElem = def.render(ctx);
  let tree = null;
  const cdmQueue = [];
  const instCache = new Map();

  function walk(node, path) {
    if (Array.isArray(node)) return node.map((c, i) => walk(c, path + "/" + i));
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
        return { ...node, __inst: inst, children: [walk(child, path + "/out")] };
      }
      child = node.type(node.props);
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

  async function waitUntil(pred, { rounds = 240, label = "条件" } = {}) {
    for (let i = 0; i < rounds; i += 1) {
      if (pred()) return;
      await new Promise((resolve) => setImmediate(resolve));
      rerender();
    }
    assert.ok(pred(), "等待超时：" + label + "；当前文本：" + text().slice(0, 500));
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

  function text() { return nodeText(tree); }

  function findButton(label) {
    const hits = findAll((n) => n.type === "button" && nodeText(n.children).includes(label));
    assert.ok(hits.length >= 1, "未找到按钮「" + label + "」；当前文本：" + text().slice(0, 500));
    return hits[hits.length - 1];
  }

  function findInputByLabel(label) {
    const hits = findAll((n) => n.type === "input" && String(n.props["aria-label"] || "").includes(label));
    assert.ok(hits.length >= 1, "未找到输入框「" + label + "」");
    return hits[hits.length - 1];
  }

  function click(node) {
    assert.ok(!node.props.disabled, "按钮被禁用：" + nodeText(node.children));
    node.props.onClick({ preventDefault() {}, stopPropagation() {} });
  }

  return { root: rootElem, tree: () => tree, flush, waitUntil, text, findAll, findButton, findInputByLabel, click, nodeText };
}

/* ── fakeApi：按「METHOD path」精确分发，记录全部调用 ─────────────── */

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
    module: moduleId,
    endpoint: method + " " + path,
    spec,
  });
}

function fakeApi(handlers) {
  const calls = [];
  const fn = (path) => {
    calls.push(path);
    const handler = handlers[path];
    if (handler === undefined) return Promise.reject(new Error("fakeApi 未配置：" + path));
    return Promise.resolve().then(() => (typeof handler === "function" ? handler() : handler));
  };
  fn.calls = calls;
  return fn;
}

/* ── 夹具 ─────────────────────────────────────────────────────────── */

const NOW = Date.now();

const DIAG_PATH = "/sorne/diagnostics?project_id=PRJ-001";
const METRICS_PATH = "/sorne/metrics?project_id=PRJ-001";
const HEALTH_PATH = "/sorne/health";
const LOG_PATH = "/sorne/change-log?project_id=PRJ-001&limit=50";
const LOG_MORE_PATH = "/sorne/change-log?project_id=PRJ-001&limit=50&cursor=log%3A3%3A1";
const LOG_SUB_PATH = "/sorne/change-log?project_id=PRJ-001&limit=50&subscription=SUBS-0001";
const ATTEMPTS_PATH = "/sorne/attempts?project_id=PRJ-001&limit=50";
const ATTEMPTS_MORE_PATH = "/sorne/attempts?project_id=PRJ-001&limit=50&cursor=17";

function diagEnvelope(over = {}) {
  return {
    generated_at: "2026-11-06T03:00:00.000Z",
    llm: { configured: true, runtime: "agents: started（tick 5s）", note: "" },
    health: healthEnvelope(),
    project: {
      status: "active",
      current_scope_revision: "SR-0001",
      high_watermark: 42,
      plan: { plan_runs_pending: 1, plan_runs_in_flight: 2 },
      intents: {
        by_status: { proposed: 1, queued: 2, running: 3, resolved: 4, blocked: 5, awaiting_review: 6, deferred: 7, obsolete: 8, cancelled: 9 },
        blocked_ids: ["I-0003", "I-0004"],
      },
      attempts: {
        active_leases: 2,
        expired: [{ id: "ATT-0002", intent_id: "I-0001", lease_expires_at: "2026-11-06T02:58:00.000Z" }],
        unknown_tool_calls: [{ id: "TC-0002", attempt_id: "ATT-0003", tool_name: "nmap_scan" }],
        unknown_note: "存在 unknown 工具调用：须先检查外部现状再决定重试",
      },
      verification: { pending_jobs: 2, oldest_wait_seconds: 120 },
      reports: { unhandled_worker_reports: 1 },
      messages: { pending_user: 1, last_ai_reply_at: "2026-11-06T02:59:00.000Z" },
      outbox: { pending: 3, oldest_pending_age_s: 60, failed: 1 },
      projection: { asset_map: 2, exploration_map: null, planner_view: 0, context: null, report: null },
      evidence: { staged_blobs: 1, lost_blobs: 0, integrity_anomalies: null },
    },
    ...over,
  };
}

function healthEnvelope(over = {}) {
  return {
    ok: true,
    service: "sorne",
    version: "0.1.0",
    checked_at: "2026-11-06T03:00:01.000Z",
    db: { ok: true, schema_version: 5 },
    outbox: { pending: 3, sent: 10, failed: 1, skipped: 0, total: 14 },
    projects: 1,
    sessions: { active: 2 },
    ...over,
  };
}

function metricsEnvelope(over = {}) {
  return {
    schema_version: 1,
    generated_at: "2026-11-06T03:00:02.000Z",
    scope: { project_id: "PRJ-001", projects: 1 },
    outbox: {
      by_status: { pending: 2, sent: 5, failed: 1, skipped: 0, total: 8 },
      pending_oldest_age_ms: 60000,
      retry_attempts: { total: 3, max: 2 },
    },
    projection_lag: {
      high_watermark: 42,
      per_kind: { asset_map: { lag_commits: 2 }, exploration_map: { lag_commits: null }, planner_view: { lag_commits: 0 } },
    },
    save_latency: { staged_uploads: { count: 1 } },
    notes: ["指标用于发现长期运行是否在浪费资源或遗漏成果"],
    ...over,
  };
}

function globalDiagEnvelope(over = {}) {
  return {
    generated_at: "2026-11-06T03:00:00.000Z",
    llm: { configured: true, runtime: "agents: started（tick 5s）" },
    health: healthEnvelope(),
    projects: { active: 2, waiting_for_change: 1, paused: 0, stopped: 1 },
    ...over,
  };
}

function logPage(events, over = {}) {
  return {
    project_id: "PRJ-001",
    read_only: true,
    subscription: null,
    after_position: { commit_seq: 0, event_index: 0 },
    events,
    next_cursor: events.length ? "log:" + events[events.length - 1].commit_seq + ":" + events[events.length - 1].event_index : "log:0:0",
    high_watermark: { commit_seq: 42, event_index: 1 },
    has_more: false,
    note: "只读视图",
    ...over,
  };
}

function EV(seq, idx, type, subjectIds, payload) {
  return {
    event_id: "EVT-PRJ-001-" + String(seq).padStart(6, "0"),
    commit_seq: seq,
    event_index: idx,
    event_type: type,
    subject_ids: subjectIds || [],
    changed_fields: [],
    cause_refs: [],
    producer_id: "w1",
    schema_version: 1,
    payload: payload !== undefined ? payload : { note: "事件 " + seq + "/" + idx },
    created_at: "2026-11-06T02:50:00.000Z",
  };
}

function attemptEnvelope(over = {}) {
  return {
    attempts: [
      {
        id: "ATT-0001", intent_id: "I-0002", assignment_id: "ASGN-07", worker_id: "worker-a",
        status: "running", lease: { expires_at: new Date(NOW + 90 * 1000).toISOString(), state: "active", seconds_remaining: 90 },
        tool_calls: { total: 3, by_status: { succeeded: 1, unknown: 1, running: 1 }, running: [{ id: "TC-0001", tool_name: "http_fetch" }], unknown: [{ id: "TC-0002", tool_name: "nmap_scan", error: "进程中断，外部扫描是否完成无法判断" }], planned: ["TC-0006"] },
        reports: { total: 1, unhandled: 1 },
      },
      {
        id: "ATT-0002", intent_id: "I-0001", assignment_id: "ASGN-08", worker_id: "worker-b",
        status: "leased", lease: { expires_at: new Date(NOW - 90 * 1000).toISOString(), state: "expired", seconds_remaining: null },
        tool_calls: { total: 0, by_status: {}, running: [], unknown: [], planned: [] },
      },
      {
        id: "ATT-0003", intent_id: "I-0002", assignment_id: "ASGN-07", worker_id: "worker-a",
        status: "interrupted", recovery_note: "进程退出，租约中断；恢复前须复核未完成工具调用",
        tool_calls: { total: 0, by_status: {}, running: [], unknown: [], planned: [] },
      },
      {
        id: "ATT-0004", intent_id: "I-0005", assignment_id: "ASGN-02", worker_id: "worker-c",
        status: "completed",
        tool_calls: { total: 0, by_status: {}, running: [], unknown: [], planned: [] },
      },
    ],
    has_more: true,
    next_cursor: "17",
    count: 4,
    ...over,
  };
}

function baseHandlers(over = {}) {
  const handlers = {
    [DIAG_PATH]: diagEnvelope(),
    "/sorne/diagnostics": globalDiagEnvelope(),
    [METRICS_PATH]: metricsEnvelope(),
    [HEALTH_PATH]: healthEnvelope(),
    [LOG_PATH]: logPage([EV(2, 1, "asset.discovered", ["A-0002"]), EV(3, 1, "scope.revised", ["PRJ-001"])]),
    [ATTEMPTS_PATH]: attemptEnvelope(),
  };
  return { ...handlers, ...over };
}

async function mountReady(def, handlers, routerOpts) {
  const api = fakeApi(handlers);
  const t = mountPage(def, api, routerOpts === null ? null : makeRouter((routerOpts && routerOpts.projectId) || "PRJ-001"));
  await t.flush();
  return { t, api };
}

/* ══════════════════ 1. 页面契约（P0-1②/P0-2② + 蓝图 §2.5） ═══════════ */

test("页面契约：纯 ESM 不引包/不用浏览器存储/无 React 钩子/无编号正则副本/无字面颜色与宿主变量", async () => {
  const src = await readFile(join(PAGES_DIR, "diagnostics.page.mjs"), "utf8");
  assert.doesNotMatch(src, /(^|\n)\s*import[\s(]/, "页面不得引包或 Node 内置模块");
  assert.doesNotMatch(src, /[^.\w]require\s*\(/, "页面不得使用 require");
  assert.doesNotMatch(src, /localStorage|sessionStorage/, "页面不得使用浏览器本地存储（蓝图 §2.5）");
  assert.doesNotMatch(src, /React\.useState|React\.useEffect|useState\(|useEffect\(/, "页面不得使用 React 钩子");
  assert.doesNotMatch(src, /toLowerCase\(\)|decodeURIComponent\(|\.replace\(/, "页面不得改写或清洗展示值");
  assert.doesNotMatch(src, /#[0-9a-fA-F]{3,8}\b|rgba?\(/, "P0-1②：页面不得出现字面颜色值（只用 var(--sorne-*) token）");
  assert.doesNotMatch(src, /--dsw-alias/, "页面不得引用宿主 --dsw-alias 变量（评审 §1 根因）");
  assert.doesNotMatch(src, /RECORD_ID_RE/, "编号解析唯一实现为 lib/ui/record-ids.mjs，页面零副本");

  const def = await loadPage("diagnostics");
  assert.equal(def.id, "diagnostics");
  assert.equal(def.title, "系统诊断");
  assert.equal(def.order, 70);
  assert.equal(typeof def.render, "function");
});

test("初始渲染不白屏：标题与任务导向一句在场，进入加载态", async () => {
  const def = await loadPage("diagnostics");
  const api = fakeApi({});
  const t = mountPage(def, api, makeRouter("PRJ-001"));
  assert.match(t.text(), /系统诊断/);
  assert.match(t.text(), /全部只读，不改任何执行与计划状态/);
  assert.match(t.text(), /正在读取|正在准备/);
});

/* ══════════════════ 2. 健康与模型（#3 + #49） ═══════════════════════ */

test("健康与模型：ok/异常两态、db/outbox/规模字段；模型未连接时冻结文案与 runtime 原文", async () => {
  const def = await loadPage("diagnostics");
  {
    const { t } = await mountReady(def, baseHandlers());
    const text = t.text();
    assert.match(text, /服务状态：.*服务正常（ok）/);
    assert.match(text, /数据库：可打开（ok） · 模式版本：5/);
    assert.match(text, /Outbox（健康面）：待发送 3 · 已发送 10 · 失败 1 · 已跳过 0 · 总计 14/);
    assert.match(text, /规模：项目 1 · 活跃会话 2/);
    assert.match(text, /全局项目状态：运行中 2 · 等待条件变化 1 · 已暂停 0 · 已停止 1/);
    assert.match(text, /模型：模型已配置，连通性未验证/);
    assert.match(text, /运行时（agents\.describe\(\) 原文）：agents: started（tick 5s）/);
  }
  {
    const handlers = baseHandlers({
      [DIAG_PATH]: diagEnvelope({ llm: { configured: false, runtime: "agents: not-configured（未配置模型）" } }),
      [HEALTH_PATH]: healthEnvelope({ ok: false, db: { ok: false, error: "db broken" } }),
    });
    const { t } = await mountReady(def, handlers);
    const text = t.text();
    assert.match(text, /系统异常（health\.ok=false）/);
    assert.match(text, /尚未连接模型，项目可以保存，AI 暂不能开始/);
    assert.match(text, /agents: not-configured（未配置模型）/);
  }
});

/* ══════════════════ 3. 语义纪律原文（M4 迁移义务留名） ═══════════════ */

test("语义纪律原句在场：resolved 不代表已测透、恢复由协调 AI 决定、单规划在途、九态以库为准", async () => {
  const def = await loadPage("diagnostics");
  const { t } = await mountReady(def, baseHandlers());
  const text = t.text();
  assert.match(text, /resolved 只表示该版本的问题已处理，不代表关联资产已测透（规范 §10\.1）/);
  assert.match(text, /恢复与重派由协调 AI 决定，程序不写死固定重试（规范 §3\.1\/§3\.2）/);
  assert.match(text, /同项目默认最多一个规划调用在途（§16\.1）/);
  assert.match(text, /九态计数以库为准（§10\.1）/);
  assert.match(text, /须先检查外部现状再决定重试，不得当作已完成或已失败/);
  assert.match(text, /同一不可并行的执行分配同一时刻最多一个有效租约（规范 §10\.2）/);
  assert.match(text, /其迟到提交的合法证据仍可留档，但不得改变新尝试的状态、不得继续获得工具执行权限/);
  assert.match(text, /本页只读监控队列、租约与工具调用状态，不提供暂缓\/恢复\/取消等操作入口/);
  assert.match(text, /不写死「重试三次然后失败」一类的固定流程（规范 §3\.1）/);
  assert.match(text, /未提供≠不存在（「—（未提供）」）/);
  assert.match(text, /折叠不删记录/);
  assert.match(text, /501 未实现≠报错/);
  assert.match(text, /查看≠消费，delivered≠applied/);
});

/* ══════════════════ 4. #49 诊断聚合各块 ═════════════════════════════ */

test("#49 诊断聚合：九态计数、计划在途、受阻族编号 chip、验证积压、汇报与消息", async () => {
  const def = await loadPage("diagnostics");
  const { t } = await mountReady(def, baseHandlers());
  const text = t.text();
  assert.match(text, /已提议 1 · 已入队 2 · 执行中 3 · 已解决 4 · 受阻 5/);
  assert.match(text, /待复核 6 · 已暂缓 7 · 已废弃 8 · 已取消 9/);
  assert.match(text, /规划运行：pending 1 · in_flight 2/);
  assert.match(text, /受阻族（blocked\/awaiting_review\/deferred）全列（2 条）/);
  assert.match(text, /I-0003/);
  assert.match(text, /待验证任务：2 · 最老等待：2 分 0 秒/);
  assert.match(text, /未处理 Worker 汇报：1（delivered≠handled：仅送入上下文不算已处理）/);
  assert.match(text, /用户消息：待处理 1 · 最近 AI 回复：/);
});

test("#49 逐块：Outbox/投递重试、投影滞后（null≠0）、证据完整性（null 不冒充 0）", async () => {
  const def = await loadPage("diagnostics");
  const { t } = await mountReady(def, baseHandlers());
  const text = t.text();
  assert.match(text, /项目 Outbox：pending 3 · failed 1 · 最老 pending：1 分 0 秒/);
  assert.match(text, /投递分布（#41）：pending 2 · sent 5 · failed 1 · skipped 0/);
  assert.match(text, /投递重试：累计 3 · 单事件最大 2/);
  assert.match(text, /asset_map：落后 2 个提交/);
  assert.match(text, /exploration_map：—（未投影：null 表示未观测，不冒充 0）/);
  assert.match(text, /planner_view：落后 0 个提交/);
  assert.match(text, /待固定 Blob：1 · 丢失 Blob：0/);
  assert.match(text, /完整性异常（真实读盘核对）：—（本次未核对，不冒充 0）/);
});

test("#41 metrics：原始 JSON 折叠呈现（折叠不删记录）、数据时刻与模式版本", async () => {
  const def = await loadPage("diagnostics");
  const { t } = await mountReady(def, baseHandlers());
  assert.match(t.text(), /运行指标（#41，原始 JSON 折叠）/);
  assert.match(t.text(), /模式版本：1/);
  assert.match(t.text(), /漏洞数量不是唯一健康指标/);
  const fold = t.findAll((n) => n.type === "button" && t.nodeText(n.children).includes("运行指标原始 JSON"));
  assert.ok(fold.length >= 1, "指标原始 JSON 应以折叠块呈现");
  assert.match(t.text(), /已折叠 \d+ 项/);
  t.click(fold[0]);
  await t.flush();
  assert.match(t.text(), /save_latency/, "展开后应呈现原始指标键（折叠不删记录）");
});

/* ══════════════════ 5. #23 执行尝试与租约 ═══════════════════════════ */

test("租约四态：剩余/已过期/未提供/无法解析；fencing token 隐藏时显式说明；数据时刻标注", async () => {
  const def = await loadPage("diagnostics");
  const { t } = await mountReady(def, baseHandlers());
  const text = t.text();
  assert.match(text, /剩余约 1 分 \d{1,2} 秒/);
  assert.match(text, /已过期约 1 分 \d{1,2} 秒/);
  assert.match(text, /租约截止：未提供/);
  assert.match(text, /fencing token：—（未提供或当前会话角色不展示）/);
  assert.match(text, /执行分配：ASGN-07/);
  assert.match(text, /worker：worker-a/);
  assert.match(text, /意图：I-0002/);
  assert.match(text, /数据时刻：/);
  assert.match(text, /截止边界 commit_seq=42/);
});

test("租约截止无法解析（invalid）显式呈现，不臆造时间", async () => {
  const def = await loadPage("diagnostics");
  const handlers = baseHandlers({
    [ATTEMPTS_PATH]: {
      attempts: [
        { id: "ATT-0009", status: "leased", lease_expires_at: "not-a-date" },
        { id: "ATT-0010", status: "running" },
      ],
      tool_calls: [],
    },
  });
  const { t } = await mountReady(def, handlers);
  assert.match(t.text(), /租约截止：无法解析（not-a-date）/);
  assert.match(t.text(), /租约截止：未提供/);
});

test("过期活跃租约与中断显式呈现：LEASE_EXPIRED 警示、恢复备注、置顶红字", async () => {
  const def = await loadPage("diagnostics");
  const { t } = await mountReady(def, baseHandlers());
  const text = t.text();
  assert.match(text, /租约已过期：旧执行不得继续操作（LEASE_EXPIRED）；恢复、重派或调整由 Orchestrator 决定。/);
  assert.match(text, /恢复备注：进程退出，租约中断；恢复前须复核未完成工具调用/);
  assert.match(text, /被打断|已中断/);
  const idxTop = text.indexOf("有 1 个结果未知（unknown）的工具调用");
  assert.ok(idxTop >= 0, "unknown 应在页面顶部置顶警示");
  assert.ok(idxTop < text.indexOf("健康与模型"), "unknown 警示应置于各数据块之前");
  assert.match(text, /须先检查外部现状再决定重试，不得当作已完成或已失败/);
});

test("尝试视图筛选：仅看活跃与异常；明示只作用于已加载数据", async () => {
  const def = await loadPage("diagnostics");
  const { t } = await mountReady(def, baseHandlers());
  assert.match(t.text(), /已完成/);
  t.click(t.findButton("仅看活跃与异常"));
  await t.flush();
  const text = t.text();
  assert.match(text, /当前筛选只作用于本页已加载数据的尝试，不代表全量。/);
  assert.doesNotMatch(text, /ATT-0004/, "客户端筛选应隐藏已完成尝试");
  assert.match(text, /ATT-0002/);
});

test("尝试游标分页：加载更多使用 cursor 参数并跨页累积", async () => {
  const def = await loadPage("diagnostics");
  const handlers = baseHandlers({
    [ATTEMPTS_MORE_PATH]: {
      attempts: [{ id: "ATT-0101", intent_id: "I-0002", status: "leased", lease: { expires_at: new Date(NOW + 60000).toISOString() }, tool_calls: { total: 0, by_status: {}, running: [], unknown: [], planned: [] } }],
      has_more: false,
      next_cursor: null,
    },
  });
  const { t, api } = await mountReady(def, handlers);
  assert.match(t.text(), /还有更多尝试在下一页/);
  t.click(t.findButton("加载更多尝试"));
  await t.flush();
  assert.ok(api.calls.includes(ATTEMPTS_MORE_PATH), "加载更多尝试应以 cursor 续读");
  assert.match(t.text(), /ATT-0101/);
  assert.match(t.text(), /ATT-0001/, "跨页累积不丢第一页");
});

/* ══════════════════ 6. 工具调用（§10.2 六态 / unknown 置顶） ═════════ */

test("工具调用六态中文标签、unknown 置顶、错误/证据引用；工具与尝试编号呈现", async () => {
  const def = await loadPage("diagnostics");
  const handlers = baseHandlers({
    [ATTEMPTS_PATH]: {
      attempts: [],
      tool_calls: [
        { id: "TC-0001", attempt_id: "ATT-0001", tool_name: "http_fetch", status: "running" },
        { id: "TC-0002", attempt_id: "ATT-0003", tool_name: "nmap_scan", status: "unknown", error: "进程中断，外部扫描是否完成无法判断" },
        { id: "TC-0003", attempt_id: "ATT-0001", tool_name: "http_fetch", status: "succeeded", evidence_refs: ["B-abc123"] },
        { id: "TC-0004", attempt_id: "ATT-0004", tool_name: "js_extract", status: "failed", error: "响应非 JS 内容" },
        { id: "TC-0005", attempt_id: "ATT-0004", tool_name: "http_fetch", status: "cancelled" },
        { id: "TC-0006", attempt_id: "ATT-0001", tool_name: "screenshot", status: "planned" },
      ],
      has_more: false,
      next_cursor: null,
    },
  });
  const { t } = await mountReady(def, handlers);
  const text = t.text();
  assert.match(text, /已计划/);
  assert.match(text, /执行中/);
  assert.match(text, /已成功/);
  assert.match(text, /已失败/);
  assert.match(text, /结果未知（须先检查外部现状再决定重试，不得当作已完成或已失败）/);
  assert.match(text, /已取消/);
  assert.match(text, /工具：nmap_scan/);
  assert.match(text, /尝试：ATT-0003/);
  assert.match(text, /错误\/说明：进程中断，外部扫描是否完成无法判断/);
  assert.match(text, /B-abc123/);
  const idxUnknown = text.indexOf("TC-0002");
  const idxSucceeded = text.indexOf("TC-0003");
  assert.ok(idxUnknown >= 0 && idxSucceeded >= 0);
  assert.ok(idxUnknown < idxSucceeded, "unknown 调用应排在普通终态之前（需关注置顶）");
});

test("工具调用 not_provided 明示；空数组显式空态；空尝试不误报未提供；摘要对象物化明细", async () => {
  const def = await loadPage("diagnostics");
  {
    const { t } = await mountReady(def, baseHandlers({
      [ATTEMPTS_PATH]: { attempts: [{ id: "ATT-0001", status: "running", lease: { expires_at: new Date(NOW + 60000).toISOString() } }] },
    }));
    assert.match(t.text(), /本次执行尝试响应未携带工具调用数据（not_provided）/);
    assert.match(t.text(), /完整明细与依据可按编号经 \/records\/\{id\} 读取/);
  }
  {
    const { t } = await mountReady(def, baseHandlers({
      [ATTEMPTS_PATH]: { attempts: [{ id: "ATT-0001", status: "running" }], tool_calls: [] },
    }));
    assert.doesNotMatch(t.text(), /not_provided/);
    assert.match(t.text(), /（暂无工具调用记录）/);
  }
  {
    const { t } = await mountReady(def, baseHandlers({ [ATTEMPTS_PATH]: { attempts: [] } }));
    assert.doesNotMatch(t.text(), /not_provided/);
    assert.match(t.text(), /（暂无执行尝试/);
  }
  {
    const { t } = await mountReady(def, baseHandlers());
    assert.match(t.text(), /工具调用：共 3 · 结果未知 1 · 执行中 1 · 已成功 1 · 已失败 0 · 已取消 0 · 计划中 0/);
    assert.match(t.text(), /队列视图以摘要形式携带工具调用/);
    assert.match(t.text(), /TC-0002[\s\S]*结果未知/);
    assert.match(t.text(), /TC-0006[\s\S]*已计划/);
  }
});

/* ══════════════════ 7. 观察摘要与只读职责边界 ═══════════════════════ */

test("观察摘要：计数按已加载数据推导、边界说明在场；全局指标指向 /metrics 折叠块", async () => {
  const def = await loadPage("diagnostics");
  const { t } = await mountReady(def, baseHandlers());
  const text = t.text();
  assert.match(text, /执行尝试（已加载 4 条）：活跃（leased\/running）2 · 其中租约已过期 1 · 已中断 1/);
  assert.match(text, /工具调用（已加载 3 条明细）：执行中 1 · 结果未知 1 · 已失败 0/);
  assert.match(text, /以上计数按本页已加载数据在数据时刻推导，游标未加载完时不代表全量/);
  assert.match(text, /全局运行指标（保存延迟、Outbox 积压与重试、投影滞后等，§20\.2 全集）由 \/metrics 提供/);
});

test("只读职责边界：仅重算剩余时间不发请求；刷新重置到第一页并更新数据", async () => {
  const def = await loadPage("diagnostics");
  const { t, api } = await mountReady(def, baseHandlers());
  const before = api.calls.length;
  t.click(t.findButton("仅重算剩余时间"));
  await t.flush();
  assert.equal(api.calls.length, before, "仅重算剩余时间不应发起任何请求");
  assert.match(t.text(), /剩余约 1 分 \d{1,2} 秒/);

  const handlers2 = baseHandlers({
    [ATTEMPTS_PATH]: { attempts: [{ id: "ATT-0202", status: "running", lease: { expires_at: new Date(NOW + 30000).toISOString() }, tool_calls: { total: 0, by_status: {}, running: [], unknown: [], planned: [] } }], has_more: false },
  });
  const r2 = await mountReady(def, handlers2);
  assert.match(r2.t.text(), /ATT-0202/);
  r2.t.click(r2.t.findButton("刷新数据（重置到第一页）"));
  await r2.t.flush();
  assert.ok(r2.api.calls.filter((p) => p === ATTEMPTS_PATH).length >= 2, "刷新应重新读取尝试端点");
});

/* ══════════════════ 8. 自动刷新（默认关闭；清理定时器） ═════════════ */

test("自动刷新：默认关闭；开启注册 10 秒定时器并重读全部数据面；关闭与卸载均清理", async () => {
  const def = await loadPage("diagnostics");
  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  let timerCallback = null;
  let timerMs = null;
  const cleared = [];
  global.setInterval = (fn, ms) => {
    timerCallback = fn;
    timerMs = ms;
    return 777;
  };
  global.clearInterval = (id) => { cleared.push(id); };
  try {
    const { t, api } = await mountReady(def, baseHandlers());
    assert.equal(timerCallback, null, "默认不注册定时器");
    assert.match(t.text(), /开启自动刷新（每 10 秒）/);

    t.click(t.findButton("开启自动刷新（每 10 秒）"));
    await t.flush();
    assert.equal(timerMs, 10000, "自动刷新周期应为 10 秒");
    assert.match(t.text(), /自动刷新：开/);

    const before = {
      diag: api.calls.filter((p) => p.startsWith("/sorne/diagnostics")).length,
      metrics: api.calls.filter((p) => p.startsWith("/sorne/metrics")).length,
      log: api.calls.filter((p) => p.startsWith("/sorne/change-log")).length,
      attempts: api.calls.filter((p) => p.startsWith("/sorne/attempts")).length,
    };
    timerCallback();
    await t.flush();
    assert.ok(api.calls.filter((p) => p.startsWith("/sorne/diagnostics")).length > before.diag, "周期回调应重读诊断");
    assert.ok(api.calls.filter((p) => p.startsWith("/sorne/metrics")).length > before.metrics, "周期回调应重读指标");
    assert.ok(api.calls.filter((p) => p.startsWith("/sorne/change-log")).length > before.log, "周期回调应重读变化流");
    assert.ok(api.calls.filter((p) => p.startsWith("/sorne/attempts")).length > before.attempts, "周期回调应重读尝试");

    t.click(t.findButton("自动刷新：开"));
    await t.flush();
    assert.ok(cleared.includes(777), "关闭时应清理定时器");

    t.click(t.findButton("开启自动刷新（每 10 秒）"));
    await t.flush();
    const clearedBeforeUnmount = cleared.length;
    let instance = null;
    (function find(node) {
      if (!node || !node.__elem || instance) return;
      if (node.__inst && typeof node.__inst.componentWillUnmount === "function") instance = node.__inst;
      for (const c of node.children) find(c);
    })(t.tree());
    assert.ok(instance, "应能定位页面组件实例");
    instance.componentWillUnmount();
    assert.ok(cleared.length > clearedBeforeUnmount, "卸载时应清理定时器");
  } finally {
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
  }
});

/* ══════════════════ 9. #45 变化流只读视图 ═══════════════════════════ */

test("#45 变化流：每事件一行摘要（时间+类型+主体 chip+一句人话）、高水位、只读原句、分组计数", async () => {
  const def = await loadPage("diagnostics");
  const { t } = await mountReady(def, baseHandlers());
  const text = t.text();
  assert.match(text, /变化流（只读视图，#45）/);
  assert.match(text, /#2\/1/);
  assert.match(text, /发现新资产/);
  assert.match(text, /范围版本变更/);
  assert.match(text, /asset\.discovered/);
  assert.match(text, /主体：/);
  assert.match(text, /A-0002/);
  assert.match(text, /高水位（high_watermark）：#42\/1/);
  assert.match(text, /has_more：false/);
  assert.match(text, /next_cursor：log:3:1/);
  assert.match(text, /只读视图（不写投递回执、不推进订阅游标）/);
  assert.match(text, /按事件类型分组（按已加载事件推导）：/);
  assert.match(text, /查看≠消费，delivered≠applied/);
});

test("#45 payload 折叠：默认折叠显示计数，展开后原样呈现（折叠不删记录）", async () => {
  const def = await loadPage("diagnostics");
  const { t } = await mountReady(def, baseHandlers());
  assert.doesNotMatch(t.text(), /事件 2\/1/, "payload 默认折叠不展开");
  const fold = t.findAll((n) => n.type === "button" && t.nodeText(n.children).includes("payload"));
  assert.ok(fold.length >= 1, "payload 应以折叠块呈现");
  t.click(fold[0]);
  await t.flush();
  assert.match(t.text(), /事件 2\/1/, "展开后 payload 原样呈现（不改写、不清洗）");
  assert.match(t.text(), /说明/, "展开后应呈现 payload 的字段名与值（FieldRow）");
});

test("#45 游标续读：加载更多携带 cursor 并追加呈现", async () => {
  const def = await loadPage("diagnostics");
  const handlers = baseHandlers({
    [LOG_PATH]: logPage([EV(2, 1, "asset.discovered", ["A-0002"]), EV(3, 1, "scope.revised", ["PRJ-001"])], {
      next_cursor: "log:3:1",
      has_more: true,
    }),
    [LOG_MORE_PATH]: logPage([EV(4, 1, "observation.appended", ["O-0002"])]),
  });
  const { t, api } = await mountReady(def, handlers);
  assert.match(t.text(), /has_more：true/);
  assert.match(t.text(), /仍有未读取事件，游标续读不跳过区间/);
  t.click(t.findButton("加载更多"));
  await t.flush();
  assert.ok(api.calls.includes(LOG_MORE_PATH), "加载更多应以 cursor 续读");
  assert.match(t.text(), /#4\/1/);
  assert.match(t.text(), /新增观察/);
  assert.match(t.text(), /has_more：false/);
});

test("#45 订阅边界：输入 SUBS 编号后从边界读取；空输入本地拦截；订阅信息呈现", async () => {
  const def = await loadPage("diagnostics");
  const handlers = baseHandlers({
    [LOG_SUB_PATH]: logPage([EV(4, 1, "scope.revised", ["PRJ-001"])], {
      subscription: { id: "SUBS-0001", subscription_revision: 3, snapshot_commit_seq: 3, resume_cursor: "c:SUBS-0001:3:0:2" },
    }),
  });
  const { t, api } = await mountReady(def, handlers);
  t.click(t.findButton("从订阅边界读取"));
  await t.flush();
  assert.match(t.text(), /请填写订阅编号/);

  const input = t.findInputByLabel("订阅编号");
  input.props.onChange({ target: { value: "SUBS-0001" } });
  await t.flush();
  t.click(t.findButton("从订阅边界读取"));
  await t.flush();
  assert.ok(api.calls.includes(LOG_SUB_PATH), "应以订阅边界读取");
  assert.match(t.text(), /订阅 SUBS-0001（修订 3）/);
  assert.match(t.text(), /快照边界 commit_seq：3/);
  assert.match(t.text(), /resume_cursor：c:SUBS-0001:3:0:2/);
  assert.match(t.text(), /当前区间：订阅 SUBS-0001 的快照边界之后/);

  t.click(t.findButton("从头读取"));
  await t.flush();
  assert.match(t.text(), /当前区间：项目全部事件（从头）/);
});

test("#45 错误 / 未知形状 / 501 / 空事件：显式呈现不白屏", async () => {
  const def = await loadPage("diagnostics");
  {
    const handlers = baseHandlers({
      [LOG_PATH]: () => { const e = new Error("项目不存在：PRJ-001"); e.status = 404; e.code = "NOT_FOUND"; throw e; },
    });
    const { t } = await mountReady(def, handlers);
    assert.match(t.text(), /事件流不可用：NOT_FOUND · 项目不存在：PRJ-001/);
  }
  {
    const { t } = await mountReady(def, baseHandlers({ [LOG_PATH]: { hello: 1 } }));
    assert.match(t.text(), /事件流形状无法识别/);
  }
  {
    const { t } = await mountReady(def, baseHandlers({
      [LOG_PATH]: () => { throw notImpl("B2", "GET", "/sorne/change-log", "变化流只读视图"); },
    }));
    assert.match(t.text(), /变化流只读视图未实现（501，不是报错）/);
  }
  {
    const { t } = await mountReady(def, baseHandlers({ [LOG_PATH]: logPage([]) }));
    assert.match(t.text(), /当前区间暂无事件/);
  }
});

/* ══════════════════ 10. 降级分支（501 / 403 / 500 / 未知形状） ═══════ */

test("501 分支：诊断/指标/尝试/变化流未实现分别标注，健康面仍渲染（501 未实现≠报错）", async () => {
  const def = await loadPage("diagnostics");
  const handlers = baseHandlers({
    [DIAG_PATH]: () => { throw notImpl("M2", "GET", "/sorne/diagnostics", "§2.6-4 诊断聚合"); },
    [METRICS_PATH]: () => { throw notImpl("F2", "GET", "/sorne/metrics", "§20.2 指标全集"); },
    [ATTEMPTS_PATH]: () => { throw notImpl("C2", "GET", "/sorne/attempts", "§10.2 队列与租约视图"); },
    [LOG_PATH]: () => { throw notImpl("B2", "GET", "/sorne/change-log", "变化流只读视图"); },
  });
  const { t } = await mountReady(def, handlers);
  const text = t.text();
  assert.match(text, /诊断聚合未实现（501，不是报错）/);
  assert.match(text, /运行指标未实现（501，不是报错）/);
  assert.match(text, /执行尝试视图未实现（501，不是报错）/);
  assert.match(text, /由模块 C2 施工/);
  assert.match(text, /变化流只读视图未实现（501，不是报错）/);
  assert.match(text, /服务正常（ok）/, "健康面独立于 501 端点继续渲染");
  assert.match(text, /系统诊断/, "异常不得拖垮整页");
});

test("403 分支：执行尝试端点要求程序签发会话 → 显式错误卡与限制说明，不白屏", async () => {
  const def = await loadPage("diagnostics");
  const handlers = baseHandlers({
    [ATTEMPTS_PATH]: () => {
      throw apiError(403, { code: "TRUST_DENIED", message: "本端点需要程序签发的会话（请求头 x-sorne-session）" });
    },
  });
  const { t } = await mountReady(def, handlers);
  const text = t.text();
  assert.match(text, /执行尝试视图不可用：TRUST_DENIED · 本端点需要程序签发的会话/);
  assert.match(text, /浏览器 UI 当前没有会话签发通道/);
  assert.match(text, /健康与模型/, "其余区块不受影响");
});

test("500 错误与未知形状：错误卡附机器可区分错误码；形状无法识别显式提示", async () => {
  const def = await loadPage("diagnostics");
  const handlers = baseHandlers({
    [DIAG_PATH]: () => { throw apiError(500, { code: "INTERNAL_ERROR", message: "诊断服务暂时不可用" }); },
    [ATTEMPTS_PATH]: () => { throw apiError(500, { code: "INTERNAL_ERROR", message: "执行运行时暂时不可用" }); },
    [METRICS_PATH]: { hello: 1 },
  });
  const { t } = await mountReady(def, handlers);
  const text = t.text();
  assert.match(text, /诊断聚合不可用：INTERNAL_ERROR · 诊断服务暂时不可用/);
  assert.match(text, /执行尝试视图不可用：INTERNAL_ERROR · 执行运行时暂时不可用/);
  assert.match(text, /运行指标形状无法识别/);
  assert.match(text, /系统诊断/, "异常不得拖垮整页");
});

test("无项目上下文：显示缺少项目上下文，不发送项目域请求；健康与全局诊断仍读取", async () => {
  const def = await loadPage("diagnostics");
  const api = fakeApi({
    "/sorne/diagnostics": diagEnvelope(),
    "/sorne/metrics": metricsEnvelope(),
    [HEALTH_PATH]: healthEnvelope(),
  });
  const t = mountPage(def, api, makeRouter(""));
  await t.flush();
  const text = t.text();
  assert.match(text, /缺少项目上下文/);
  assert.ok(!api.calls.some((p) => p.includes("project_id=")), "无项目时不应发送项目域请求");
  assert.ok(api.calls.includes(HEALTH_PATH), "健康检查与项目无关，仍应读取");
});

/* ══════════════════ 11. 真实服务集成 ════════════════════════════════ */

test("真实服务：创建项目与范围版本后，页面携带 project_id 请求诊断/指标/变化流/尝试并呈现", () =>
  withTestServer(async (server) => {
    const created = await server.request("POST", "/sorne/projects", { body: { name: "M4 诊断走查项目" } });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const projectId = created.body.project.id;
    for (let i = 1; i <= 3; i += 1) {
      const r = await server.request("POST", "/sorne/scope-revisions", {
        body: { project_id: projectId, rules: { allow: ["v" + i + ".example.test"] }, summary: "v" + i },
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    }

    const def = await loadPage("diagnostics");
    const api = async (path) => {
      const res = await fetch(server.base + path, { headers: { origin: server.base } });
      const json = await res.json();
      if (!res.ok) {
        const e = new Error(json.message || "HTTP " + res.status);
        e.status = res.status;
        e.code = json.code;
        throw e;
      }
      return json;
    };
    const t = mountPage(def, api, makeRouter(projectId));
    await t.waitUntil(() => t.text().includes(projectId) && t.text().includes("变化流（只读视图"), { label: "诊断页数据呈现" });
    await t.waitUntil(() => /#\d+\/\d+/.test(t.text()), { label: "事件流呈现" });

    const text = t.text();
    assert.match(text, /系统诊断/);
    assert.ok(text.includes("项目：" + projectId), "应呈现当前项目编号");
    assert.match(text, /服务正常（ok）/);
    assert.match(text, /scope\.revised/, "真实事件类型应呈现");
    assert.match(text, /范围版本变更/);
    assert.match(text, /高水位（high_watermark）：#/);
    assert.match(text, /变化流（只读视图/);
    assert.match(text, /执行尝试、租约与工具调用/);
    assert.match(text, /运行指标（#41/);
  }));
