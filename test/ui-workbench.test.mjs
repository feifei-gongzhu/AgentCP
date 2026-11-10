/**
 * M4 —— 工作台页测试（lib/ui/pages/workbench.page.mjs；BLUEPRINT-UI §1.4/§e J1·J2·J4·J5·J6/§g）。
 *
 * 覆盖（含旧 test/ui-coordination.test.mjs 断言的语义迁移，迁移清单见 docs/modules/ui-M4.md）：
 *   - 页面契约：纯 ESM 不引包、不用浏览器存储、无 React 钩子、无编号正则副本
 *     （P0-2②：RECORD_ID_RE 只存在于 lib/ui/record-ids.mjs）、无字面颜色值与宿主
 *     --dsw-alias 变量引用（P0-1②）、中文标题、order=20；
 *   - 顶部 4 张卡（项目状态/探索进展/待你处理/系统健康）+ 6 项指标（九态计数/活跃尝试/
 *     待验证/未处理汇报/待处理消息/提交边界与 Outbox）；原始 /metrics JSON 不进工作台；
 *   - 三区：正在做什么（#31 当前方向 + #23 活跃 Attempt + #45 最新进展）、得到了什么
 *     （#31 重要新发现原样状态 + 按已加载事件推导的新增记录）、需要我做什么（受阻方向
 *     与缺什么/待验证等待时长/待澄清与未处理汇报，点击进右栏 renderDetail ?id=）；
 *   - 进展条（J1）：六段按 §2.6-3 冻结映射逐段用真实记录事实判定（规划请求数/
 *     planner_view 投影滞后/plan_runs 在途/意图与尝试计数/提交边界/计划接收状态），
 *     读取中不显示假进度、失败显示原因；
 *   - 对话（J4/J5）：#47 列表呈现「已接收 → 对应任务 → AI 处理结果」三段（不是孤立气泡）、
 *     状态 received/processing/handled/failed 原样（收到 ≠ 已处理）、links 编号 chip；
 *     #46 发送（本地拦截空内容/坏附件；attachments kind=blob|capture；发送后重读列表）；
 *   - 暂停反馈（J6）：paused 且活跃 Attempt>0 → 「正在暂停，仍有 N 个收尾中的操作」；
 *     归零后 → 「已暂停（无收尾中的操作）」；
 *   - 右侧详情：汇报三层（交接卡分组/分页/omitted；关键记录层 db 状态注记与 AI 建议
 *     标注；完整依据层 read_pointer 与 manifest）、基线 base_report 下钻链与返回、
 *     relative_to_base、boundary（Manifest/提交边界/项目当前边界）；
 *   - 语义纪律冻结原文留名：resolved 不代表已测透（§10.1）、恢复与重派由协调 AI 决定
 *     （§3.1/§3.2）、同项目最多一个规划调用在途（§16.1）、九态计数以库为准（§10.1）、
 *     收到 ≠ 已处理（delivered ≠ handled）、未提供 ≠ 不存在（「—（未提供）」）；
 *   - 501/错误/未知形状/空态分支不白屏；数据时刻与「按已加载数据推导」在场；
 *   - 真实服务集成：A1 创建项目 → 页面按 router.projectId 自动取数（#31/#23/#29/#45/
 *     #47/#49）；页面发消息经真实 #46 持久化并以 #47 呈现「已接收」；直写一条真实
 *     worker_reports 行 → 真实 #38 三层链路（handoff_card/key_records）呈现在右栏详情。
 *
 * 测试宿主：不依赖 React 运行时（依赖树不含 react）——以最小 createElement + Component
 * 基类驱动页面的类组件，并绑定 M1 真实渲染器（lib/ui/render.mjs + record-ids.mjs），
 * 断言打到真实渲染输出。
 *
 * 并行安全：fakeApi 用例不占端口；真实服务用例走 withTestServer（独立临时目录 +
 * listen(0) 随机端口 + finally 收尾，见 test/helpers.mjs）；无后台进程残留。
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
const ROOT = join(HERE, "..");
const PAGES_DIR = join(ROOT, "lib", "ui", "pages");
const LIB_DIR = join(ROOT, "lib");

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

/* ── 挂载仿真：展开类组件树（顶层 1 个页面类组件；渲染器函数组件直接调用） ── */

function mountRoot(rootElem) {
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
          inst.setState = (patch, cb) => {
            const next = typeof patch === "function" ? patch(inst.state) : patch;
            inst.state = Object.assign({}, inst.state, next);
            if (typeof cb === "function") cb();
          };
          instCache.set(path, inst);
          cdmQueue.push(inst);
        } else {
          inst.props = node.props;
        }
        child = inst.render();
        return Object.assign({}, node, { __inst: inst, children: [walk(child, path + "/out")] });
      }
      child = node.type(node.props);
      return Object.assign({}, node, { children: [walk(child, path + "/fn")] });
    }
    return Object.assign({}, node, { children: node.children.map((c, i) => walk(c, path + "/" + i)) });
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
    for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
    rerender();
  }

  async function waitUntil(pred, { rounds = 300, label = "条件" } = {}) {
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

  function text() {
    return nodeText(tree);
  }

  function findButton(label) {
    const hits = findAll((n) => n.type === "button" && nodeText(n.children).includes(label));
    assert.ok(hits.length >= 1, "未找到按钮「" + label + "」；当前文本：" + text().slice(0, 500));
    return hits[hits.length - 1];
  }

  function findAllButtons(label) {
    return findAll((n) => n.type === "button" && nodeText(n.children).includes(label));
  }

  function findInputByPlaceholder(placeholder) {
    const hits = findAll((n) => n.type === "input" && String(n.props.placeholder || "").includes(placeholder));
    assert.ok(hits.length >= 1, "未找到输入框「" + placeholder + "」");
    return hits[hits.length - 1];
  }

  function setText(node, value) {
    node.props.onChange({ target: { value: value } });
  }

  function click(node) {
    assert.ok(!node.props.disabled, "按钮被禁用：" + nodeText(node.children));
    node.props.onClick({ preventDefault() {}, stopPropagation() {} });
  }

  return {
    flush: flush, waitUntil: waitUntil, text: text, findAll: findAll, findAllButtons: findAllButtons,
    findButton: findButton, findInputByPlaceholder: findInputByPlaceholder, setText: setText, click: click,
    nodeText: nodeText,
  };
}

function mountMain(def, ctx) {
  return mountRoot(def.render(ctx));
}

function mountDetail(def, ctx) {
  return mountRoot(def.renderDetail(ctx));
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

function notImpl(moduleId, method, path) {
  return apiError(501, {
    code: "NOT_IMPLEMENTED",
    message: "端点 " + method + " " + path + " 由模块 " + moduleId + " 施工（M4 测试桩）",
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
    calls.push({ method: method, path: path, body: body });
    const key = method + " " + path;
    let handler = handlers[key];
    /* 查询子集匹配：键形如 GET /path?cursor=...（分页游标用例）。 */
    if (handler === undefined) {
      for (const hk of Object.keys(handlers)) {
        const sp = hk.indexOf(" ");
        if (sp < 0) continue;
        if (hk.slice(0, sp) !== method) continue;
        const kp = hk.slice(sp + 1);
        const q = kp.indexOf("?");
        if (q < 0) continue;
        if (kp.slice(0, q) !== basePath(path)) continue;
        const pairs = kp.slice(q + 1).split("&").filter(Boolean);
        if (pairs.every((pair) => path.includes(pair))) { handler = handlers[hk]; break; }
      }
    }
    if (handler === undefined) handler = handlers[method + " " + basePath(path)];
    if (handler === undefined) return Promise.reject(new Error("fakeApi 未配置：" + key));
    return Promise.resolve().then(() => (typeof handler === "function" ? handler(body, path) : handler));
  };
  fn.calls = calls;
  return fn;
}

/** 与冻结 client.js 的 api() 同构的真实请求封装（含 {code,message} 信封）。 */
function realApi(base) {
  return async function api(path, options) {
    const res = await fetch(base + path, {
      credentials: "same-origin",
      method: (options && options.method) || "GET",
      /* 同源回环 Origin：变更请求的信任边界要求（浏览器会带；Node fetch 需显式带）。 */
      headers: { "Content-Type": "application/json", Origin: base, ...((options && options.headers) || {}) },
      body: options && options.body,
    });
    const raw = await res.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch { data = { raw: raw }; }
    if (!res.ok) {
      const msg = data && (data.error || data.message)
        ? (typeof data.error === "object" ? (data.error.message || JSON.stringify(data.error)) : (data.error || data.message))
        : "HTTP " + res.status;
      const err = new Error(msg);
      err.status = res.status;
      err.code = data && data.code;
      throw err;
    }
    return data;
  };
}

function makeCtx(api, over = {}) {
  const calls = [];
  const listeners = new Set();
  const router = {
    hash: over.hash || "#/p/PRJ-0001/workbench",
    page: over.page || "workbench",
    projectId: over.projectId === undefined ? "PRJ-0001" : over.projectId,
    params: over.params || {},
    query: {},
    open: (target) => {
      calls.push({ kind: "open", hash: target });
      router.hash = target;
      for (const fn of Array.from(listeners)) fn(router);
    },
    replace: (target) => calls.push({ kind: "replace", hash: target }),
    back: (fb) => calls.push({ kind: "back", fallback: fb }),
    openRecord: (id) => calls.push({ kind: "openRecord", id: id }),
    isInAppHistory: () => false,
    onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    __calls: calls,
  };
  return { React: { createElement: h, Component: ComponentBase }, h: h, api: api, router: router, ui: ui, theme: null };
}

/* ── 夹具（M2/E1 落地信封形状） ───────────────────────────────────── */

const NOW = Date.now();
const ISO = (offsetSec) => new Date(NOW + offsetSec * 1000).toISOString();

const P1 = "PRJ-0001";

function overviewFixture(over = {}) {
  return Object.assign({
    project: { id: P1, name: "演示项目", status: "active", status_text: "运行中" },
    active_plan: {
      latest_plan_revisions: [
        { id: "PR-0001", plan_run_id: "PLR-0001", revision: "r3", received_status: "accepted", created_at: ISO(-600) },
      ],
      in_flight_plan_runs: [{ id: "PLR-0002", status: "in_flight", input_boundary: "S-1040", created_at: ISO(-120) }],
      note: "同项目默认最多一个规划调用在途（§16.1）",
    },
    intents: {
      counts_by_status: { running: 1, blocked: 1, resolved: 1 },
      active: [
        { id: "I-0007", question: "登录入口有哪些调用？", kind: "investigate", status: "running", priority: 5, resume_conditions: [], latest_attempt: { id: "ATT-0002", status: "running", worker_id: "worker-a" }, blocked_detail: null },
        { id: "I-0008", question: "登录后的调用信息", kind: "collect", status: "blocked", priority: 3, resume_conditions: ["补充登录后页面信息"], latest_attempt: { id: "ATT-0003", status: "interrupted", worker_id: "worker-b" }, blocked_detail: { report_id: "WR-0003", note: "缺少登录后的调用信息" } },
      ],
      has_more: false,
    },
    pending_reports: {
      total: 3, has_more: false,
      items: [{
        id: "WR-0003", kind: "blocked", intent_id: "I-0008", attempt_id: "ATT-0003",
        base_report_id: "WR-0001", handling_status: "pending", delivery_status: "delivered",
        task_question: "确认登录相关入口", actual_outcome: "缺少登录后的调用信息", created_at: ISO(-300),
      }],
      note: "delivered 不算已处理（§18.5）",
    },
    important_findings: {
      vulnerabilities: [{ id: "V-0003", category: "SQL 注入", status: "suspected", review: "clear", location: "/api/users?id=1", created_seq: 1035, created_at: ISO(-400) }],
      hypotheses: [{ id: "H-0007", statement: "另一接口的访问限制可能异常", status: "testing", created_seq: 1040, created_at: ISO(-350) }],
      note: "状态与复核状态以库为准（confirmed 只说明在指定条件下得到确认）",
    },
    pending_items: {
      interrupted_actions: { total: 1, items: [{ action_id: "OA-0007", action_kind: "dispatch", decision_id: "OD-0002", rationale: "补查登录后调用信息" }], note: "" },
      needs_clarification_reports: 1, deferred_reports: 0,
    },
    constraints: { project_status: "active", scope_revision: "SR-0002", max_active_attempts: 2, active_attempts: 1, note: "并行上限与项目状态为程序约束" },
    generated_at: ISO(-60),
  }, over);
}

function attemptsFixture(over = {}) {
  return Object.assign({
    attempts: [
      { id: "ATT-0002", intent_id: "I-0007", assignment_id: "ASM-0002", worker_id: "worker-a", status: "running", lease: { expires_at: ISO(120), state: "active", seconds_remaining: 120, }, created_at: ISO(-200) },
      { id: "ATT-0003", intent_id: "I-0008", assignment_id: "ASM-0003", worker_id: "worker-b", status: "interrupted", lease: { expires_at: ISO(-30), state: "expired", seconds_remaining: null }, created_at: ISO(-500) },
    ],
    has_more: false, next_cursor: null, next_after: null, count: 2,
  }, over);
}

function verificationFixture(over = {}) {
  return Object.assign({
    jobs: [{ id: "VJ-0001", subject_id: "V-0003", subject_kind: "vulnerability", status: "pending", created_at: ISO(-300), latest_result: null }],
    count: 1, has_more: false, next_cursor: null, next_after: null, note: "等待中的任务",
  }, over);
}

function changesFixture(over = {}) {
  return Object.assign({
    project_id: P1, read_only: true, subscription: null,
    after_position: { commit_seq: 0, event_index: 0 },
    events: [
      { event_id: "EVT-PRJ-0001-1040-1", commit_seq: 1040, event_index: 1, event_type: "asset.registered", subject_ids: ["A-0002"], changed_fields: [], cause_refs: [], producer_id: "runtime", schema_version: 1, payload: {}, created_at: ISO(-240) },
      { event_id: "EVT-PRJ-0001-1041-1", commit_seq: 1041, event_index: 1, event_type: "observation.created", subject_ids: ["O-0031"], changed_fields: [], cause_refs: [], producer_id: "worker-a", schema_version: 1, payload: {}, created_at: ISO(-200) },
      { event_id: "EVT-PRJ-0001-1042-1", commit_seq: 1042, event_index: 1, event_type: "message.received", subject_ids: ["MSG-PRJ-0001-0001"], changed_fields: [], cause_refs: [], producer_id: "user", schema_version: 1, payload: {}, created_at: ISO(-150) },
    ],
    next_cursor: "log:1042:1",
    high_watermark: { commit_seq: 1042, event_index: 1 },
    has_more: false,
    note: "只读视图：查看 ≠ 消费",
  }, over);
}

function messagesFixture(over = {}) {
  return Object.assign({
    messages: [
      { id: "MSG-PRJ-0001-0002", project_id: P1, direction: "ai", content: "收到：已记录优先研究登录相关功能，并生成了计划请求。", status: "handled", reply_to: "MSG-PRJ-0001-0001", source_decision_id: "OD-0002", attachments: [], links: [{ kind: "intent", ref_id: "I-0007" }], created_at: ISO(-140), created_by: "orchestrator-agent", created_seq: 1044 },
      { id: "MSG-PRJ-0001-0001", project_id: P1, direction: "user", content: "接下来优先研究登录相关功能", status: "handled", reply_to: null, source_decision_id: null, attachments: [{ kind: "blob", ref: "B-0001", sha256: "a".repeat(64), read_path: "/sorne/evidence/blobs/" + "a".repeat(64) }], links: [{ kind: "orchestration_decision", ref_id: "OD-0002" }, { kind: "worker_report", ref_id: "WR-0003" }], created_at: ISO(-150), created_by: "user", created_seq: 1043 },
    ],
    count: 2, has_more: false, next_cursor: null, note: "列表按新到旧；received ≠ handled",
  }, over);
}

function diagnosticsFixture(over = {}) {
  return Object.assign({
    generated_at: ISO(-60),
    llm: { configured: true, reachable: true, runtime: "agents:started", note: "runtime 为 agents.describe() 原文" },
    health: { ok: true, service: "sorne", checked_at: ISO(-60), db: { ok: true, schema_version: 5 }, outbox: { pending: 2, sent: 10, failed: 0, skipped: 0 }, projects: 1 },
    project: {
      status: "active", current_scope_revision: "SR-0002", high_watermark: 1042,
      plan: { plan_runs_pending: 0, plan_runs_in_flight: 1 },
      intents: { by_status: { running: 1, blocked: 1 }, blocked_ids: ["I-0008"], note: "受阻族全列" },
      attempts: { active_leases: 2, expired: [], unknown_tool_calls: [], unknown_note: null },
      verification: { pending_jobs: 1, oldest_wait_seconds: 300, note: "数据时刻值" },
      reports: { unhandled_worker_reports: 3, note: "delivered ≠ handled" },
      messages: { pending_user: 1, last_ai_reply_at: ISO(-140), note: "pending_user 为 received/processing" },
      outbox: { pending: 2, oldest_pending_age_s: 5, failed: 0, note: "Outbox 摘要" },
      projection: { asset_map: 0, exploration_map: 0, planner_view: 2 },
      evidence: { staged_blobs: 0, lost_blobs: 0, integrity_anomalies: null, note: "null 表示未核对" },
    },
  }, over);
}

function baseHandlers(over = {}) {
  return Object.assign({
    "GET /sorne/orchestrator/overview": overviewFixture(),
    "GET /sorne/attempts": attemptsFixture(),
    "GET /sorne/verification-jobs": verificationFixture(),
    "GET /sorne/change-log": changesFixture(),
    "GET /sorne/messages": messagesFixture(),
    "GET /sorne/diagnostics": diagnosticsFixture(),
  }, over);
}

/* 汇报三层夹具（#38 落地信封；WR-0003 主汇报、WR-0001 基线） */
function handoffPage1() {
  return {
    report_id: "WR-0003", kind: "blocked", intent_id: "I-0008", attempt_id: "ATT-0003",
    created_at: ISO(-300), created_by: "worker-a", handling_status: "pending", delivery_status: "delivered",
    replaces_report_id: "WR-0002", base_report_id: "WR-0001", layer: "handoff_card",
    relative_to_base: {
      base_report_id: "WR-0001",
      new_record_ids: ["H-0007", "V-0003"], dropped_record_ids: [], unchanged_record_ids: ["F-0012"],
      base_read_pointer: "/sorne/worker-reports/WR-0001?layer=key_records",
    },
    handoff_card: {
      page: 1, total_pages: 2,
      groups: [
        { group_id: "header", type: "header", title: "交接卡", lines: ["任务：确认登录相关入口", "实际完成：查看页面及关联 JS，确认两个调用入口", "执行状态：blocked"] },
        { group_id: "important_findings#1", type: "important_findings", title: "关键发现（第 1/1 组）", lines: ["F-0012（fact·当前状态 verified）：页面调用 /api/login，依据 E-31", "V-0003（vulnerability·当前状态 suspected）：已建立疑似漏洞记录"] },
        { group_id: "blockers", type: "blockers", title: "阻塞", lines: ["缺少登录后的调用信息"] },
      ],
      used_chars: 210, has_more: true, next_page: 2, remaining_groups_after_this_page: 2, budget: 400, total_groups: 5,
      pagination_note: "交接卡按可配置长度预算分组分页；任何条目不截断、不确定性与反对证据不删除",
      ai_note: "「需要的决策」为 worker 建议（AI 解释和建议单独标注，不能替代原记录状态）",
      status_note: "关键发现的状态以数据库当前值渲染并附声明值",
      omitted_from_this_page: [{ type: "handoff_groups", count: 2, read_pointer: "/sorne/worker-reports/WR-0003?layer=handoff_card&page=2&budget=400" }],
    },
    boundary: { source_manifest_id: "EM-0021", source_commit_boundary: 1042, latest_commit_seq: 1050, note: "边界判定时效" },
  };
}

function handoffPage2() {
  const base = handoffPage1();
  return Object.assign({}, base, {
    handoff_card: Object.assign({}, base.handoff_card, {
      page: 2, has_more: false, next_page: null, remaining_groups_after_this_page: 0,
      groups: [
        { group_id: "material_conditions", type: "material_conditions", title: "重要条件（身份/参数/环境/时间，不得省略）", lines: ["观察来自未登录状态，不能推广到其他身份"] },
        { group_id: "decisions_needed", type: "decisions_needed", title: "需要的决策（worker 建议，非记录状态）", lines: ["补充相关身份条件下的信息"] },
      ],
      omitted_from_this_page: [],
    }),
  });
}

function keyRecordsFixture(reportId) {
  const rid = reportId || "WR-0003";
  return {
    report_id: rid, kind: "blocked", intent_id: "I-0008", attempt_id: "ATT-0003",
    handling_status: "pending", delivery_status: "delivered", layer: "key_records",
    key_records: {
      task_question: "确认登录相关入口",
      actual_outcome: "查看页面及关联 JS，确认两个调用入口；未覆盖登录后的页面",
      execution_status: "blocked",
      important_findings: [
        { record_id: "F-0012", type: "fact", current_status: "verified", short_statement: "页面调用 /api/login，依据 E-31", db: { exists: true, table: "facts", status: "verified", review: null }, status_note: "状态以数据库为准（提交时声明 verified，当前 verified）" },
        { record_id: "V-0003", type: "vulnerability", current_status: "suspected", short_statement: "已建立疑似漏洞记录，等待独立验证", db: { exists: true, table: "vulnerabilities", status: "suspected", review: "clear" } },
      ],
      material_conditions: ["观察来自未登录状态，不能推广到其他身份"],
      contradictions: ["一次请求因网络超时失败，不能据此认定接口不存在"],
      significant_attempts: ["ATT-0003：登录后调用采集（受阻）"],
      unresolved_questions: ["登录后的调用信息尚未覆盖"],
      blockers: ["缺少登录后的调用信息"],
      prerequisite_changes: [],
      proposed_next_actions: [{ advice: "补充相关身份条件下的信息", ai_advice: true }],
      omitted_sections: [{ type: "capture_details", count: 14, read_pointer: "CAP-0007" }],
      evidence_refs: ["O-0031"],
      expand_pointer: "/sorne/worker-reports/" + rid + "?layer=full_basis",
    },
    boundary: handoffPage1().boundary,
  };
}

function fullBasisFixture() {
  return {
    report_id: "WR-0003", kind: "blocked", handling_status: "pending", delivery_status: "delivered", layer: "full_basis",
    full_basis: {
      full_record_pointer: "/sorne/worker-reports/WR-0003?layer=full_basis",
      evidence_refs: [
        { ref: "O-0031", read_pointer: "/sorne/records/O-0031?project_id=" + P1 },
        { ref: "CAP-0007", read_pointer: "/sorne/captures/CAP-0007" },
      ],
      manifest: { counts: { total: 18, observations: 9, captures: 5 }, newer_records_since_boundary: 2, tool_calls: [{ id: "TC-0009", tool_name: "http_get", status: "succeeded", evidence_refs: [], read_pointer: null }] },
      note: "完整依据层：执行记录/进展/判断记录在本层内联呈现",
    },
    boundary: handoffPage1().boundary,
  };
}

function baseHandoffFixture() {
  return {
    report_id: "WR-0001", kind: "progress", intent_id: "I-0008", attempt_id: "ATT-0001",
    created_at: ISO(-900), created_by: "worker-a", handling_status: "handled", delivery_status: "delivered",
    replaces_report_id: null, base_report_id: null, layer: "handoff_card",
    handoff_card: {
      page: 1, total_pages: 1,
      groups: [{ group_id: "header", type: "header", title: "交接卡", lines: ["任务：确认登录相关入口", "实际完成：已开始静态查看页面与 JS", "执行状态：running"] }],
      used_chars: 90, has_more: false, next_page: null, remaining_groups_after_this_page: 0, budget: 400, total_groups: 1,
      pagination_note: "交接卡按长度预算分组分页", omitted_from_this_page: [],
    },
    boundary: { source_manifest_id: "EM-0019", source_commit_boundary: 1013, latest_commit_seq: 1050, note: "" },
  };
}

function baseKeyRecordsFixture() {
  return {
    report_id: "WR-0001", kind: "progress", handling_status: "handled", delivery_status: "delivered", layer: "key_records",
    key_records: {
      task_question: "确认登录相关入口", actual_outcome: "已开始静态查看页面与 JS", execution_status: "running",
      important_findings: [], material_conditions: [], contradictions: [], significant_attempts: [],
      unresolved_questions: [], blockers: [], prerequisite_changes: [], proposed_next_actions: [],
      omitted_sections: [], evidence_refs: ["O-0031"], expand_pointer: "/sorne/worker-reports/WR-0001?layer=full_basis",
    },
    boundary: baseHandoffFixture().boundary,
  };
}

function detailHandlers() {
  return {
    "GET /sorne/worker-reports/WR-0003": handoffPage1(),
    "GET /sorne/worker-reports/WR-0001": baseHandoffFixture(),
  };
}

/* 按 query 精确分发的 fakeApi（详情层需要区分 layer/page）。 */
function queryApi(routes, callsOut) {
  const calls = callsOut || [];
  const fn = (path, options) => {
    const method = (options && options.method) || "GET";
    const body = parseBody(options && options.body);
    calls.push({ method: method, path: path, body: body });
    const exact = routes[method + " " + path] !== undefined ? routes[method + " " + path] : routes[path];
    if (exact !== undefined) return Promise.resolve().then(() => (typeof exact === "function" ? exact(body, path) : exact));
    const base = path.split("?")[0];
    const fallback = routes[method + " " + base] !== undefined ? routes[method + " " + base] : routes[base];
    if (fallback !== undefined) {
      return Promise.resolve().then(() => {
        const v = typeof fallback === "function" ? fallback(body, path) : fallback;
        if (v && typeof v === "object" && !Array.isArray(v)) {
          const layerKey = /layer=key_records/.test(path) ? "key_records" : /layer=full_basis/.test(path) ? "full_basis" : null;
          if (layerKey && v[layerKey]) return v;
        }
        return v;
      });
    }
    return Promise.reject(new Error("queryApi 未配置：" + path));
  };
  fn.calls = calls;
  return fn;
}

/* ══════════════════════════════════════════════════════════════════ */
/* 1. 页面契约                                                         */
/* ══════════════════════════════════════════════════════════════════ */

test("M4 页面契约：纯 ESM 不引包、不用浏览器存储、无钩子、无编号正则副本、无字面颜色值、order=20", async () => {
  const src = await readFile(join(PAGES_DIR, "workbench.page.mjs"), "utf8");
  assert.doesNotMatch(src, /(^|\n)\s*import[\s(]/, "页面不得静态 import 任何模块");
  assert.doesNotMatch(src, /[^.\w]require\s*\(/, "页面不得使用 require");
  assert.doesNotMatch(src, /localStorage|sessionStorage/, "页面不得使用浏览器本地存储");
  assert.doesNotMatch(src, /React\.useState|React\.useEffect|useState\(|useEffect\(/, "页面顶层不得使用 React 钩子");
  assert.doesNotMatch(src, /RECORD_ID_RE/, "编号正则唯一实现必须在 lib/ui/record-ids.mjs（P0-2②）");
  assert.doesNotMatch(src, /#[0-9a-fA-F]{3,8}\b|rgba?\(/, "页面不得书写字面颜色值（P0-1②，全部经 --sorne-* token）");
  assert.doesNotMatch(src, /--dsw-alias-/, "页面不得引用宿主 --dsw-alias-* 变量");

  const def = await loadPage("workbench");
  assert.equal(def.id, "workbench");
  assert.equal(def.title, "工作台");
  assert.equal(def.order, 20);
  assert.equal(typeof def.render, "function");
  assert.equal(typeof def.renderDetail, "function", "工作台必须提供右栏详情（§2.4-2）");
});

test("M4 页面在 UI manifest 中按注册表顺序提供（真实服务）", () =>
  withTestServer(async ({ request }) => {
    const { status, body } = await request("GET", "/sorne/ui/manifest");
    assert.equal(status, 200);
    const pages = body.pages;
    const workbench = pages.find((p) => p.id === "workbench");
    assert.ok(workbench, "manifest 缺 workbench（M4 页面未落地？）");
    assert.equal(workbench.file, "/sorne/ui/pages/workbench.page.mjs");
    assert.equal(workbench.order, 20);
    const projects = pages.find((p) => p.id === "projects");
    if (projects) assert.ok(projects.order < workbench.order, "项目列表应在工作台之前");
    const assets = pages.find((p) => p.id === "assets");
    if (assets) assert.ok(workbench.order < assets.order, "工作台应在资产之前（§2.5 注册表）");
    /* 旧 id 页面此时应已删除（overview/coordination 归 M4；execution/changes 归 M4 诊断页） */
    assert.ok(!pages.some((p) => p.id === "overview"), "overview 旧页应已删除");
    assert.ok(!pages.some((p) => p.id === "coordination"), "coordination 旧页应已删除");
  }));

/* ══════════════════════════════════════════════════════════════════ */
/* 2. 顶部 4 卡 + 6 指标 + 数据时刻                                     */
/* ══════════════════════════════════════════════════════════════════ */

test("顶部 4 张卡与 6 项指标：计数全部来自端点并注明按已加载数据推导；原始 metrics JSON 不进工作台", async () => {
  const def = await loadPage("workbench");
  const api = fakeApi(baseHandlers());
  const t = mountMain(def, makeCtx(api));
  await t.flush();
  const text = t.text();

  for (const label of ["项目状态", "意图", "活跃尝试", "待验证", "待你处理", "处理进度", "系统"]) {
    assert.ok(text.includes(label), "指标「" + label + "」应呈现");
  }
  /* 单行指标：同一计数只出现一次（不再重复 4 张卡）。 */
  assert.match(text, /待你处理3 份汇报 · 0 条消息/);
  assert.match(text, /已处理到 #1042/);
  assert.match(text, /服务正常 · 模型可用/);
  /* 九态计数以库为准（冻结原文）。 */
  assert.match(text, /九态计数以库为准（§10\.1）/);
  assert.match(text, /意图排队 0 · 执行中 1/);
  assert.match(text, /活跃尝试1 个/);
  assert.match(text, /数据时刻：/);
  assert.match(text, /计数按已加载数据推导，不代表全量/);
  /* 工作台不拉取原始 /metrics（归系统诊断页）。 */
  assert.ok(!api.calls.some((c) => c.path.startsWith("/sorne/metrics")), "工作台不得读取 /metrics 原始 JSON");
});

/* ══════════════════════════════════════════════════════════════════ */
/* 3. 进展条（J1，§2.6-3 冻结映射）                                     */
/* ══════════════════════════════════════════════════════════════════ */


test("未处理汇报按 §18.5 语义过滤：handled 不属于待办；刷新按钮以 project_id 重读面板", async () => {
  const def = await loadPage("workbench");
  const overview = overviewFixture();
  overview.pending_reports.items = [
    { id: "WR-0003", kind: "blocked", handling_status: "pending", task_question: "待处理汇报", created_at: ISO(-300) },
    { id: "WR-0009", kind: "progress", handling_status: "handled", task_question: "已处理汇报", created_at: ISO(-400) },
  ];
  overview.pending_reports.total = 1;
  let overviewCalls = 0;
  const api = fakeApi({
    "GET /sorne/orchestrator/overview": () => { overviewCalls += 1; return overview; },
    "GET /sorne/attempts": attemptsFixture(),
    "GET /sorne/verification-jobs": verificationFixture(),
    "GET /sorne/change-log": changesFixture(),
    "GET /sorne/messages": messagesFixture(),
    "GET /sorne/diagnostics": diagnosticsFixture(),
  });
  const t = mountMain(def, makeCtx(api));
  await t.flush();
  assert.match(t.text(), /WR-0003/);
  assert.doesNotMatch(t.text(), /WR-0009/, "已处理汇报（handled）不属于未处理集合");
  assert.equal(overviewCalls, 1);
  t.click(t.findButton("刷新"));
  await t.flush();
  assert.equal(overviewCalls, 2, "刷新应携带 project_id 重新读取 #31");
});
test("J1 进展条：六段按冻结映射逐段呈现，每段来自真实记录事实（不假进度、不转圈）", async () => {
  const def = await loadPage("workbench");
  const t = mountMain(def, makeCtx(fakeApi(baseHandlers())));
  await t.flush();
  const text = t.text();
  for (const label of ["已接收目标", "正在读取已有信息", "正在制定计划", "已分配任务", "持续探索中", "失败（如发生）"]) {
    assert.ok(text.includes(label), "进展段「" + label + "」应呈现");
  }
  /* ① 已接收目标：plan_run 计数（真实记录）。 */
  assert.match(text, /规划请求：待处理 0 · 进行中 1/);
  /* ② 正在读取已有信息：同步滞后。 */
  assert.match(text, /正在同步已处理记录（落后 2 条，已处理到 #1042）/);
  /* ③ 正在制定计划：plan_runs 在途 + §16.1 原文。 */
  assert.match(text, /规划进行中（1 个）/);
  assert.match(text, /同项目默认最多一个规划调用在途（§16\.1）/);
  /* ④ 已分配任务：意图/尝试计数。 */
  assert.match(text, /排队 0 · 执行中 1 · 活跃尝试 1/);
  /* ⑤ 持续探索中：处理进度 + 最近事件。 */
  assert.match(text, /已处理到 #1042 · 最近事件 3 条/);
  /* ⑥ 失败：没有失败记录时如实说明（不当成 0 进度动画）。 */
  assert.match(text, /当前没有失败记录（计划未被拒绝、运行时未报错）/);
  assert.doesNotMatch(text, /%/, "不得出现百分比形式的假进度");
});

test("J1 进展条失败段：计划被拒绝时显示原因（不转圈、不静默）", async () => {
  const def = await loadPage("workbench");
  const overview = overviewFixture();
  overview.active_plan.latest_plan_revisions = [
    { id: "PR-0009", plan_run_id: "PLR-0009", revision: "r1", received_status: "rejected", created_at: ISO(-90) },
  ];
  const t = mountMain(def, makeCtx(fakeApi(baseHandlers({ "GET /sorne/orchestrator/overview": overview }))));
  await t.flush();
  const text = t.text();
  assert.match(text, /失败/);
  assert.match(text, /原因：计划接收状态 已拒绝（rejected）（plan PR-0009）/);
  /* 失败段样式走状态色 token（不出现字面颜色）。 */
  assert.doesNotMatch(text, /#[0-9a-f]{6}/i);
});

test("J1 读取中不显示假进度：端点未返回前只提示「正在读取进展」，不渲染百分比与转圈文案", async () => {
  const def = await loadPage("workbench");
  let resolveOverview;
  const pending = new Promise((resolve) => { resolveOverview = resolve; });
  const api = (path, options) => {
    if (path.startsWith("/sorne/orchestrator/overview")) return pending;
    const base = baseHandlers();
    const key = Object.keys(base).find((k) => k.split(" ")[1] === path.split("?")[0]);
    if (key) return Promise.resolve(base[key]);
    return Promise.reject(new Error("unexpected " + path));
  };
  const t = mountMain(def, makeCtx(api));
  await t.flush(4);
  const text = t.text();
  assert.match(text, /正在读取进展（读取完成前不显示进度，不转圈）/);
  assert.doesNotMatch(text, /%/);
  resolveOverview(overviewFixture());
  await t.flush();
  assert.doesNotMatch(t.text(), /正在读取进展（读取完成前不显示进度，不转圈）/);
});

/* ══════════════════════════════════════════════════════════════════ */
/* 4. 三区（正在做什么 / 得到了什么 / 需要我做什么）                     */
/* ══════════════════════════════════════════════════════════════════ */

test("J2 三区：当前方向/活跃 Attempt/最新进展、重要新发现原样状态、新增记录按已加载事件推导", async () => {
  const def = await loadPage("workbench");
  const t = mountMain(def, makeCtx(fakeApi(baseHandlers())));
  await t.flush();
  const text = t.text();

  /* 正在做什么（#31 当前方向 + #23 活跃 Attempt + #45 最新进展）。 */
  assert.match(text, /正在做什么/);
  assert.match(text, /问题：登录入口有哪些调用？/);
  assert.match(text, /最近尝试：ATT-0002 · 执行中/);
  assert.match(text, /受阻：缺少登录后的调用信息/);
  assert.match(text, /活跃 Attempt（#23 租约视图）/);
  assert.match(text, /租约到期：/);
  assert.match(text, /最新进展（#45 变化流，最近 3 条）/);
  assert.match(text, /#1042\/1 · message\.received/);

  /* 得到了什么（#31 important_findings：疑似状态原样、不提升）。 */
  assert.match(text, /得到了什么/);
  assert.match(text, /重要新发现（#31：疑似漏洞\/假设，状态原样呈现、不提升）/);
  assert.match(text, /疑似/);
  assert.match(text, /已确认（限指定条件）|复核：/);
  assert.match(text, /SQL 注入 @ \/api\/users\?id=1/);
  assert.match(text, /另一接口的访问限制可能异常/);
  assert.match(text, /发现状态以数据库为准并原样展示：疑似不会被提升为已确认/);
  /* 近期新增记录（事件推导，不冒充全量）。 */
  assert.match(text, /近期新增记录（按已加载事件推导，不代表全量）/);
  assert.match(text, /asset\.registered/);
  assert.match(text, /observation\.created/);

  /* 需要我做什么。 */
  assert.match(text, /需要我做什么/);
  assert.match(text, /受阻方向/);
  assert.match(text, /缺什么：缺少登录后的调用信息/);
  assert.match(text, /恢复条件：补充登录后页面信息/);
  assert.match(text, /待验证/);
  assert.match(text, /等待时长：/);
  assert.match(text, /未处理汇报/);
  assert.match(text, /WR-0003/);
  assert.match(text, /处理状态：待处理（pending）/);
  assert.match(text, /需补充说明的汇报 1 份/);
  assert.match(text, /待完成动作（决定已保存但动作未完成——逐项核对，不盲目重放）/);
  assert.match(text, /OA-0007 · dispatch · 决定 OD-0002：补查登录后调用信息/);
});

test("未处理汇报点击进入右栏详情（renderDetail ?id=WR-…）：不是跳走整页", async () => {
  const def = await loadPage("workbench");
  const ctx = makeCtx(fakeApi(baseHandlers()));
  const t = mountMain(def, ctx);
  await t.flush();
  const btn = t.findAll((n) => n.type === "button"
    && String(n.props["aria-label"] || "").includes("查看未处理汇报 WR-0003"))[0];
  assert.ok(btn, "未处理汇报编号应为可点击按钮（aria-label 标注用途）");
  t.click(btn);
  const opened = ctx.router.__calls.find((c) => c.kind === "open");
  assert.ok(opened, "点击应触发路由 open");
  assert.equal(opened.hash, "#/p/PRJ-0001/workbench?id=WR-0003", "应携带 ?id= 进入本页详情槽位");
});

/* ══════════════════════════════════════════════════════════════════ */
/* 5. 对话（J4/J5）                                                     */
/* ══════════════════════════════════════════════════════════════════ */

test("J4 对话三段：已接收 → 对应任务 → AI 处理结果；状态收到 ≠ 已处理；links 与附件编号 chip", async () => {
  const def = await loadPage("workbench");
  const t = mountMain(def, makeCtx(fakeApi(baseHandlers())));
  await t.flush();
  const text = t.text();

  assert.match(text, /与 AI 对话/);
  assert.match(text, /消息发给协调 AI：消息先「已接收」，AI 读取并作出决定后才有对应任务与回复。收到 ≠ 已处理。/);
  /* 用户消息：三段逐条呈现，不是孤立气泡。 */
  assert.match(text, /① 已接收：已处理（handled；决定已持久化）/);
  assert.match(text, /② 对应任务：决定：OD-0002 · 汇报：WR-0003/);
  assert.match(text, /③ AI 处理结果：收到：已记录优先研究登录相关功能，并生成了计划请求。/);
  /* AI 消息（direction=ai）与其关联任务。 */
  assert.match(text, /AI/);
  assert.match(text, /意图：I-0007/);
  /* 附件（blob）编号 chip 与类型。 */
  assert.match(text, /附件：/);
  assert.match(text, /B-0001/);
  assert.match(text, /（证据字节）/);
  /* delivered ≠ handled 纪律在对话区/语义说明在场。 */
  assert.match(text, /收到 ≠ 已处理/);
  assert.match(text, /delivered 只表示已送入上下文；决定持久化并回写关联后才 handled（§18\.5）/);
});

test("J4 发送：#46 携带 project_id 与 content；attachments 校验 B-/CAP- 编号；发送后重读 #47", async () => {
  const def = await loadPage("workbench");
  const api = fakeApi(baseHandlers({
    "POST /sorne/messages": () => ({ message: { id: "MSG-PRJ-0001-0003", direction: "user", status: "received", content: "优先研究登录" }, state: "queued_for_orchestrator", note: "received ≠ handled" }),
  }));
  const t = mountMain(def, makeCtx(api));
  await t.flush();

  /* 空输入本地拦截。 */
  const before = api.calls.length;
  t.click(t.findButton("发送"));
  await t.flush();
  assert.match(t.text(), /请先输入消息内容（本地拦截，未发请求）/);
  assert.equal(api.calls.length, before, "空内容不应发请求");

  /* 填内容 + 附件，发送。 */
  t.setText(t.findInputByPlaceholder("向 AI 说明目标或调整探索重点"), "优先研究登录相关功能");
  t.setText(t.findInputByPlaceholder("附件编号（可选"), "B-0001, CAP-0007");
  t.click(t.findButton("发送"));
  await t.flush();
  const post = api.calls.find((c) => c.method === "POST" && c.path === "/sorne/messages");
  assert.ok(post, "应 POST /sorne/messages");
  assert.equal(post.body.project_id, "PRJ-0001");
  assert.equal(post.body.content, "优先研究登录相关功能");
  assert.deepEqual(post.body.attachments, [{ kind: "blob", ref: "B-0001" }, { kind: "capture", ref: "CAP-0007" }]);
  /* 发送后重读列表（#47 被再次调用）。 */
  assert.ok(api.calls.filter((c) => c.method === "GET" && c.path.startsWith("/sorne/messages")).length >= 2,
    "发送后应重新读取消息列表");
  assert.match(t.text(), /已发送（MSG-PRJ-0001-0003）：已接收（received）≠ 已处理（handled）/);
});

test("J4 附件校验：非证据编号本地拒绝、不整条发送；超 16 项本地拦截", async () => {
  const def = await loadPage("workbench");
  const api = fakeApi(baseHandlers());
  const t = mountMain(def, makeCtx(api));
  await t.flush();
  t.setText(t.findInputByPlaceholder("向 AI 说明目标或调整探索重点"), "带一个坏附件");
  t.setText(t.findInputByPlaceholder("附件编号（可选"), "V-0003");
  t.click(t.findButton("发送"));
  await t.flush();
  assert.match(t.text(), /附件「V-0003」不是可识别的证据编号/);
  assert.ok(!api.calls.some((c) => c.method === "POST"), "坏附件不得发出请求（整条拒绝，不半提交）");
});

test("J5 调整探索重点：发送内容经 #46 持久化，页面提示对应任务由 AI 决定后出现（不假装已处理）", async () => {
  const def = await loadPage("workbench");
  const api = fakeApi(baseHandlers({
    "POST /sorne/messages": () => ({ message: { id: "MSG-PRJ-0001-0009", direction: "user", status: "received", content: "接下来优先研究登录相关功能" }, state: "queued_for_orchestrator" }),
  }));
  const t = mountMain(def, makeCtx(api));
  await t.flush();
  t.setText(t.findInputByPlaceholder("向 AI 说明目标或调整探索重点"), "接下来优先研究登录相关功能");
  t.click(t.findButton("发送"));
  await t.flush();
  const text = t.text();
  assert.match(text, /已接收（received）≠ 已处理（handled）——AI 读取并作出决定后才算处理/);
  /* 现有消息里未闭环的用户消息必须呈现「尚未处理」，不得显示为已答复。 */
  const api2 = fakeApi(baseHandlers({
    "GET /sorne/messages": messagesFixture({
      messages: [{ id: "MSG-PRJ-0001-0005", project_id: P1, direction: "user", content: "调整重点", status: "received", reply_to: null, attachments: [], links: [], created_at: ISO(-30), created_by: "user", created_seq: 1050 }],
      count: 1,
    }),
  }));
  const t2 = mountMain(def, makeCtx(api2));
  await t2.flush();
  assert.match(t2.text(), /尚未处理（收到 ≠ 已处理；AI 读取并作出决定后才算处理）/);
});

/* ══════════════════════════════════════════════════════════════════ */
/* 6. 暂停反馈（J6）                                                    */
/* ══════════════════════════════════════════════════════════════════ */

test("消息分页不静默截断：#47 首屏标注已加载条数，更早消息以 cursor 续读并追加", async () => {
  const def = await loadPage("workbench");
  const first = messagesFixture();
  first.has_more = true;
  first.next_cursor = "1043:MSG-PRJ-0001-0001";
  const older = {
    messages: [{ id: "MSG-PRJ-0001-0000", project_id: P1, direction: "user", content: "更早的一条消息", status: "handled", reply_to: null, attachments: [], links: [], created_at: ISO(-900), created_by: "user", created_seq: 1042 }],
    count: 1, has_more: false, next_cursor: null, note: "",
  };
  const api = fakeApi(baseHandlers({
    "GET /sorne/messages": first,
    "GET /sorne/messages?cursor=1043%3AMSG-PRJ-0001-0001": older,
  }));
  const t = mountMain(def, makeCtx(api));
  await t.flush();
  assert.match(t.text(), /已加载 2 条消息（首屏最近 50 条；更早消息可加载更多）/);
  t.click(t.findButton("加载更多消息（更早）"));
  await t.flush();
  assert.ok(api.calls.some((c) => c.path.includes("&cursor=1043%3AMSG-PRJ-0001-0001") || c.path.includes("&cursor=1043:MSG-PRJ-0001-0001")),
    "续读应携带 cursor 参数");
  assert.match(t.text(), /更早的一条消息/);
  assert.match(t.text(), /已加载 3 条消息/);
});

test("长列表不静默截断：意图/尝试/未处理汇报超过 8 条时显式标注仅显示前 8 条", async () => {
  const def = await loadPage("workbench");
  const overview = overviewFixture();
  overview.intents.active = Array.from({ length: 10 }, (_, i) => ({ id: "I-01" + String(i).padStart(2, "0"), question: "方向 " + i, status: "running", kind: "collect", latest_attempt: null, blocked_detail: null }));
  overview.pending_reports.items = Array.from({ length: 10 }, (_, i) => ({ id: "WR-01" + String(i).padStart(2, "0"), kind: "progress", handling_status: "pending", task_question: "任务 " + i, created_at: ISO(-300 - i) }));
  const attempts = attemptsFixture();
  attempts.attempts = Array.from({ length: 10 }, (_, i) => ({ id: "ATT-01" + String(i).padStart(2, "0"), intent_id: "I-0007", status: "running", worker_id: "w", lease: { expires_at: ISO(60) } }));
  const t = mountMain(def, makeCtx(fakeApi(baseHandlers({
    "GET /sorne/orchestrator/overview": overview,
    "GET /sorne/attempts": attempts,
  }))));
  await t.flush();
  const text = t.text();
  assert.match(text, /仅显示前 8 条（本页已加载 10 条；完整清单以探索页为准）/);
  assert.match(text, /仅显示前 8 条（本页已加载 10 条；完整明细见系统诊断页）/);
  assert.match(text, /未处理汇报仅显示前 8 条（共 10 条已加载；完整清单以持久记录为准）/);
});
test("J6 暂停反馈：paused 且仍有活跃 Attempt → 「正在暂停，仍有 N 个收尾中的操作」；归零后转「已暂停（无收尾中的操作）」", async () => {
  const def = await loadPage("workbench");
  let attempts = attemptsFixture();
  const diagnostics = diagnosticsFixture();
  diagnostics.project.status = "paused";
  const overview = overviewFixture();
  overview.project.status = "paused";
  const api = fakeApi(baseHandlers({
    "GET /sorne/diagnostics": diagnostics,
    "GET /sorne/orchestrator/overview": overview,
    "GET /sorne/attempts": () => attempts,
  }));
  const t = mountMain(def, makeCtx(api));
  await t.flush();
  assert.match(t.text(), /正在暂停，仍有 1 个收尾中的操作（活跃 Attempt 数，来自 #23）——收尾完成前不假装全部停止。/);

  /* 收尾完成（活跃 Attempt 归零）后刷新 → 已暂停（不假装停止的过渡结束）。 */
  attempts = attemptsFixture({ attempts: [] });
  t.click(t.findButton("刷新"));
  await t.flush();
  const text = t.text();
  assert.match(text, /已暂停（无收尾中的操作）/);
  assert.doesNotMatch(text, /正在暂停，仍有/);
});

test("J6 顶栏五态之外：waiting_for_change 呈现「等待条件补齐，不是结束」", async () => {
  const def = await loadPage("workbench");
  const diagnostics = diagnosticsFixture();
  diagnostics.project.status = "waiting_for_change";
  const overview = overviewFixture();
  overview.project.status = "waiting_for_change";
  const t = mountMain(def, makeCtx(fakeApi(baseHandlers({
    "GET /sorne/diagnostics": diagnostics,
    "GET /sorne/orchestrator/overview": overview,
  }))));
  await t.flush();
  assert.match(t.text(), /等待条件补齐：没有可派发工作时进入等待条件变化，不是结束/);
});

/* ══════════════════════════════════════════════════════════════════ */
/* 7. 右侧详情：汇报三层 / 基线 / 边界（§2.4-2、§18.3）                  */
/* ══════════════════════════════════════════════════════════════════ */

function detailCtx(routes, id) {
  return makeCtx(queryApi(routes), { params: { id: id }, projectId: "PRJ-0001" });
}

test("详情·交接卡层：分组（编号 chip）、relative_to_base、boundary、分页与 omitted 不静默截断", async () => {
  const def = await loadPage("workbench");
  const routes = Object.assign({
    "GET /sorne/worker-reports/WR-0003?project_id=PRJ-0001&layer=handoff_card": handoffPage1(),
    "GET /sorne/worker-reports/WR-0003?project_id=PRJ-0001&layer=handoff_card&page=2": handoffPage2(),
  }, detailHandlers());
  const ctx = detailCtx(routes, "WR-0003");
  const t = mountDetail(def, ctx);
  await t.flush();
  const text = t.text();

  assert.match(text, /详情/);
  assert.match(text, /WR-0003/);
  assert.match(text, /受阻汇报/);
  assert.match(text, /处理状态：待处理（pending）/);
  assert.match(text, /投递状态：delivered/);
  assert.match(text, /来源清单（Manifest）：EM-0021 · 提交边界：1042（项目当前提交边界 1050；其后新提交由后续增量通知覆盖）/);
  assert.match(text, /相对基线的变化（相对 WR-0001）：新增 H-0007、V-0003 · 无移除 · 未变 1 条/);
  assert.ok(t.findButton("读取基线"), "relative_to_base 应提供读取基线入口");
  assert.match(text, /第一层 · 交接卡（默认接收）/);
  assert.match(text, /任务：确认登录相关入口/);
  assert.match(text, /关键发现（第 1\/1 组）/);
  assert.match(text, /F-0012（fact·当前状态 verified）/);
  assert.ok(t.findButton("F-0012"), "交接卡行内编号应为可点击 chip");
  assert.match(text, /阻塞/);
  assert.match(text, /缺少登录后的调用信息/);
  /* 分页与省略分区（超预算显式列明）。 */
  assert.match(text, /本页未包含的分组（超预算显式列明，不静默截断）：/);
  assert.match(text, /· 类型 handoff_groups · 2 组 · 读取入口：/);
  assert.ok(t.findButton("续读后续分组"), "omitted 应提供续读入口");
  assert.ok(t.findButton("加载下一页交接卡（第 2 页 / 共 2 页）"), "应提供按页续读入口");

  /* 分页续读：追加分组且不丢已读。 */
  t.click(t.findButton("加载下一页交接卡（第 2 页 / 共 2 页）"));
  await t.flush();
  assert.ok(ctx.api.calls.some((c) => c.path === "/sorne/worker-reports/WR-0003?project_id=PRJ-0001&layer=handoff_card&page=2"),
    "续读应请求 layer=handoff_card&page=2");
  const text2 = t.text();
  assert.match(text2, /重要条件（身份\/参数\/环境\/时间，不得省略）/);
  assert.match(text2, /观察来自未登录状态，不能推广到其他身份/);
  assert.match(text2, /任务：确认登录相关入口/);
  assert.doesNotMatch(text2, /加载下一页交接卡/);
});

test("详情·关键记录层（按需 #38）：db 状态注记、AI 建议标注、遗漏分区与完整依据入口", async () => {
  const def = await loadPage("workbench");
  const routes = Object.assign({
    "GET /sorne/worker-reports/WR-0003?project_id=PRJ-0001&layer=handoff_card": handoffPage1(),
    "GET /sorne/worker-reports/WR-0003?project_id=PRJ-0001&layer=key_records": keyRecordsFixture(),
  }, detailHandlers());
  const ctx = detailCtx(routes, "WR-0003");
  const t = mountDetail(def, ctx);
  await t.flush();

  assert.match(t.text(), /第二层 · 关键记录层（按类型或编号展开）/);
  assert.match(t.text(), /（本层默认收起——发现清单、重要尝试、正反证据、状态变化、遗漏与未知项按需展开）/);
  assert.ok(!ctx.api.calls.some((c) => c.path.includes("layer=key_records")), "收起状态下不应请求关键记录层");

  const expandButtons16 = t.findAllButtons("展开本层");
  t.click(expandButtons16[0]);
  await t.flush();
  const text = t.text();
  assert.ok(ctx.api.calls.some((c) => c.path === "/sorne/worker-reports/WR-0003?project_id=PRJ-0001&layer=key_records"));
  assert.match(text, /任务问题：确认登录相关入口/);
  assert.match(text, /实际完成：查看页面及关联 JS，确认两个调用入口；未覆盖登录后的页面/);
  assert.match(text, /发现清单（状态以库为准并附声明值）：/);
  assert.match(text, /F-0012 · fact · 当前状态：verified（库内当前 verified）：页面调用 \/api\/login，依据 E-31/);
  assert.match(text, /（状态以数据库为准（提交时声明 verified，当前 verified））/);
  assert.match(text, /V-0003 · vulnerability · 当前状态：suspected（库内当前 suspected · 复核 clear）/);
  assert.match(text, /正反证据与矛盾：一次请求因网络超时失败，不能据此认定接口不存在/);
  assert.match(text, /需要\s*的决策（建议后续动作）：补充相关身份条件下的信息（AI 建议单独标注，不能替代原记录状态）/);
  assert.match(text, /遗漏与省略分区（未列入交接卡的内容在此显式列明，不静默截断）：/);
  assert.match(text, /· 类型 capture_details · 14 条 · 读取入口：/);
  assert.ok(t.findButton("CAP-0007"), "遗漏分区编号读取入口应可点击");
  assert.ok(t.findButton("/sorne/worker-reports/WR-0003?layer=full_basis"), "expand_pointer 应可点击直达第三层");
  assert.match(text, /本层条目按编号展开；未在本层出现的记录仍持久保存/);

  /* 点击 CAP-0007 → 记录覆盖层（openRecord），不是猜测目标。 */
  t.click(t.findButton("CAP-0007"));
  assert.ok(ctx.router.__calls.some((c) => c.kind === "openRecord" && c.id === "CAP-0007"), "纯编号读取入口应 openRecord(CAP-0007)");
});

test("详情·完整依据层（按需 #38）：read_pointer 原样、manifest 折叠、完整记录入口", async () => {
  const def = await loadPage("workbench");
  const routes = Object.assign({
    "GET /sorne/worker-reports/WR-0003?project_id=PRJ-0001&layer=handoff_card": handoffPage1(),
    "GET /sorne/worker-reports/WR-0003?project_id=PRJ-0001&layer=full_basis": fullBasisFixture(),
  }, detailHandlers());
  const ctx = detailCtx(routes, "WR-0003");
  const t = mountDetail(def, ctx);
  await t.flush();
  assert.match(t.text(), /第三层 · 完整依据层（核查或继续执行时读取）/);
  assert.ok(!ctx.api.calls.some((c) => c.path.includes("layer=full_basis")), "收起状态下不应请求完整依据层");

  const expandButtons = t.findAllButtons("展开本层");
  t.click(expandButtons[expandButtons.length - 1]);
  await t.flush();
  const text = t.text();
  assert.ok(ctx.api.calls.some((c) => c.path === "/sorne/worker-reports/WR-0003?project_id=PRJ-0001&layer=full_basis"));
  assert.match(text, /证据引用（执行记录、采集、请求响应、文件、验证结果；按编号或读取入口展开）：/);
  assert.match(text, /（读取入口 \/sorne\/records\/O-0031\?project_id=PRJ-0001）/);
  assert.match(text, /（读取入口 \/sorne\/captures\/CAP-0007）/);
  assert.match(text, /完整记录入口：/);
  assert.match(text, /本次汇报覆盖的记录清单（manifest）/);
  assert.match(text, /完整依据不默认送入模型；核查或继续执行时按编号读取。/);

  /* read_pointer 原样读取：点 O-0031 → openRecord("O-0031")（外壳记录覆盖层）。 */
  t.click(t.findButton("O-0031"));
  assert.ok(ctx.router.__calls.some((c) => c.kind === "openRecord" && c.id === "O-0031"));
});

test("详情·基线读取与下钻链：读取基线直达 key_records 层，返回上一份清空链", async () => {
  const def = await loadPage("workbench");
  const routes = Object.assign({
    "GET /sorne/worker-reports/WR-0003?project_id=PRJ-0001&layer=handoff_card": handoffPage1(),
    "GET /sorne/worker-reports/WR-0001?project_id=PRJ-0001&layer=handoff_card": baseHandoffFixture(),
    "GET /sorne/worker-reports/WR-0001?project_id=PRJ-0001&layer=key_records": baseKeyRecordsFixture(),
  }, detailHandlers());
  const ctx = detailCtx(routes, "WR-0003");
  const t = mountDetail(def, ctx);
  await t.flush();

  t.click(t.findButton("读取基线"));
  await t.flush();
  const text = t.text();
  assert.ok(ctx.api.calls.some((c) => c.path === "/sorne/worker-reports/WR-0001?project_id=PRJ-0001&layer=handoff_card"));
  assert.ok(ctx.api.calls.some((c) => c.path === "/sorne/worker-reports/WR-0001?project_id=PRJ-0001&layer=key_records"));
  assert.match(text, /WR-0001/);
  assert.match(text, /进展汇报/);
  assert.match(text, /处理状态：已处理（handled）/);
  assert.match(text, /已开始静态查看页面与 JS/);
  assert.match(text, /当前沿基线下钻：WR-0003 → 本汇报。/);
  assert.ok(t.findButton("返回上一份"));

  t.click(t.findButton("返回上一份"));
  await t.flush();
  const text2 = t.text();
  assert.match(text2, /WR-0003/);
  assert.doesNotMatch(text2, /当前沿基线下钻：/);
});

test("详情·非汇报编号：不重复实现第二套详情，给记录覆盖层入口", async () => {
  const def = await loadPage("workbench");
  const ctx = makeCtx(fakeApi({}), { params: { id: "V-0003" } });
  const t = mountDetail(def, ctx);
  await t.flush();
  assert.match(t.text(), /该编号不是汇报（WR-）编号：完整详情按编号经记录覆盖层读取/);
  t.click(t.findButton("打开记录"));
  assert.ok(ctx.router.__calls.some((c) => c.kind === "openRecord" && c.id === "V-0003"));
});

/* ══════════════════════════════════════════════════════════════════ */
/* 8. 501 / 错误 / 未知形状 / 空态（不白屏）                            */
/* ══════════════════════════════════════════════════════════════════ */

test("501 分支：工作概览/执行尝试/验证队列/变化流/消息/诊断各自标注「未实现」，其余区块仍渲染", async () => {
  const def = await loadPage("workbench");
  const api = fakeApi({
    "GET /sorne/orchestrator/overview": () => { throw notImpl("E1", "GET", "/sorne/orchestrator/overview"); },
    "GET /sorne/attempts": () => { throw notImpl("C2", "GET", "/sorne/attempts"); },
    "GET /sorne/verification-jobs": () => { throw notImpl("D1", "GET", "/sorne/verification-jobs"); },
    "GET /sorne/change-log": () => { throw notImpl("B2", "GET", "/sorne/change-log"); },
    "GET /sorne/messages": () => { throw notImpl("M2", "GET", "/sorne/messages"); },
    "GET /sorne/diagnostics": () => { throw notImpl("M2", "GET", "/sorne/diagnostics"); },
  });
  const t = mountMain(def, makeCtx(api));
  await t.flush();
  const text = t.text();
  assert.match(text, /工作概览未实现/);
  assert.match(text, /执行尝试视图未实现/);
  assert.match(text, /消息通道未实现/);
  assert.match(text, /501 未实现 ≠ 报错/);
  /* 页面骨架仍在（不白屏）。 */
  assert.match(text, /工作台/);
  assert.match(text, /探索进展/);
  assert.match(text, /正在做什么/);
  assert.match(text, /得到了什么/);
  assert.match(text, /需要我做什么/);
  assert.match(text, /与 AI 对话/);
});

test("错误分支：500 错误卡附错误码；403 会话缺口如实呈现；诊断不可用不拖垮工作台", async () => {
  const def = await loadPage("workbench");
  const a = mountMain(def, makeCtx(fakeApi(baseHandlers({
    "GET /sorne/orchestrator/overview": () => { throw apiError(500, { code: "INTERNAL_ERROR", message: "协调服务暂时不可用" }); },
  }))));
  await a.flush();
  assert.match(a.text(), /工作概览不可用/);
  assert.match(a.text(), /INTERNAL_ERROR · 协调服务暂时不可用/);
  assert.match(a.text(), /工作台/, "异常不得拖垮整页");

  const b = mountMain(def, makeCtx(fakeApi(baseHandlers({
    "GET /sorne/orchestrator/overview": () => { throw apiError(403, { code: "TRUST_DENIED", message: "本端点需要程序签发的会话" }); },
  }))));
  await b.flush();
  assert.match(b.text(), /工作概览不可用/);
  assert.match(b.text(), /TRUST_DENIED · 本端点需要程序签发的会话/);

  const c = mountMain(def, makeCtx(fakeApi(baseHandlers({
    "GET /sorne/diagnostics": () => { throw apiError(500, { code: "INTERNAL_ERROR", message: "诊断聚合不可用" }); },
  }))));
  await c.flush();
  assert.match(c.text(), /—（未提供）/, "诊断不可用时卡片如实未提供");
  assert.match(c.text(), /各意图最新状态|当前方向/, "其余区块仍渲染");
});

test("未知形状：工作概览为空对象时三区显式「未提供/无」，不静默当作空", async () => {
  const def = await loadPage("workbench");
  const t = mountMain(def, makeCtx(fakeApi(baseHandlers({
    "GET /sorne/orchestrator/overview": {},
  }))));
  await t.flush();
  const text = t.text();
  assert.match(text, /—（未提供：工作概览未返回重要发现区块；未提供 ≠ 不存在）/);
  assert.match(text, /（当前没有活跃意图；意图由 Planner 提交后进入工作台）/);
  assert.match(text, /（当前没有需要你处理的事项）|未处理汇报/);
});

test("空态：无项目上下文与空消息列表都显式呈现（不白屏、不假装有数据）", async () => {
  const def = await loadPage("workbench");
  const noProject = mountMain(def, makeCtx(fakeApi({}), { projectId: null }));
  await noProject.flush();
  assert.match(noProject.text(), /缺少项目上下文（路由未携带 projectId）/);

  const t = mountMain(def, makeCtx(fakeApi(baseHandlers({
    "GET /sorne/messages": { messages: [], count: 0, has_more: false, next_cursor: null, note: "" },
  }))));
  await t.flush();
  assert.match(t.text(), /还没有消息/);
});

/* ══════════════════════════════════════════════════════════════════ */
/* 9. 语义纪律冻结原文（§g ⑪–⑭ 与 未提供/收到≠已处理）                  */
/* ══════════════════════════════════════════════════════════════════ */

test("语义纪律冻结原文留名：resolved 不代表已测透、恢复由协调 AI 决定、单规划在途、九态以库为准", async () => {
  const def = await loadPage("workbench");
  const t = mountMain(def, makeCtx(fakeApi(baseHandlers())));
  await t.flush();
  const text = t.text();
  /* §g ⑪ */
  assert.match(text, /resolved 只表示该版本的问题已处理，不代表关联资产已测透（规范 §10\.1）/);
  /* §g ⑫ */
  assert.match(text, /恢复与重派由协调 AI 决定，程序不写死固定重试（规范 §3\.1\/§3\.2）/);
  /* §g ⑬ */
  assert.match(text, /同项目默认最多一个规划调用在途（§16\.1）/);
  /* §g ⑭ */
  assert.match(text, /九态计数以库为准（§10\.1）/);
  /* delivered ≠ handled / 未提供 ≠ 不存在 / 501 ≠ 报错 —— 三句纪律。 */
  assert.match(text, /收到 ≠ 已处理/);
  assert.match(text, /delivered 只表示已送入上下文；决定持久化并回写关联后才 handled（§18\.5）/);
  assert.match(text, /未提供 ≠ 不存在（缺失值显示「—（未提供）」）/);
  assert.match(text, /501 未实现 ≠ 报错/);
  /* 旧协调面板「接收端语义」迁移：基线不依赖对话记忆、折叠不改原始关系（§18.6）。 */
  assert.match(text, /新汇报默认强调相对于 base_report 的变化，接收方缺少基线时可以读取基线，不依赖对话记忆（§18\.6）/);
  assert.match(text, /交接卡\/关键记录\/完整依据三层展开，面板折叠不改变原始关系与恢复条件（§18\.6）/);
});

/* ══════════════════════════════════════════════════════════════════ */
/* 10. 真实服务集成（J1/J2/J4 + #38 真实三层）                          */
/* ══════════════════════════════════════════════════════════════════ */

test("真实服务：创建项目 → 工作台按 router.projectId 取数；页面发消息经 #46 → #47 呈现「已接收」", () =>
  withTestServer(async (server) => {
    const created = await server.request("POST", "/sorne/projects", { body: { name: "M4 工作台走查项目" } });
    assert.equal(created.status, 200, "创建项目失败：" + JSON.stringify(created.body));
    const projectId = created.body.project.id;

    const def = await loadPage("workbench");
    const ctx = makeCtx(realApi(server.base), { projectId: projectId });
    const t = mountMain(def, ctx);
    await t.waitUntil(
      () => !t.text().includes("正在读取进展（读取完成前不显示进度，不转圈）")
        && !t.text().includes("正在读取最新进展") && !t.text().includes("正在读取消息"),
      { label: "工作台首屏取数完成" },
    );
    const text = t.text();
    assert.match(text, /工作台/);
    assert.match(text, /已接收目标/);
    /* 新项目：无规划请求/无意图，进展条如实停在第一段（不假进度）。 */
    assert.match(text, /尚无规划请求（plan_run 计数为 0）/);
    assert.match(text, /（当前没有活跃意图；意图由 Planner 提交后进入工作台）/);
    assert.match(text, /还没有消息/);

    /* 页面发消息：真实 #46 持久化 → 重读 #47 呈现已接收。 */
    t.setText(t.findInputByPlaceholder("向 AI 说明目标或调整探索重点"), "M4 真实服务消息");
    t.click(t.findButton("发送"));
    await t.waitUntil(
      () => /已发送（MSG-/.test(t.text()) && t.text().includes("M4 真实服务消息"),
      { label: "消息发送并回读" },
    );
    const after = t.text();
    assert.match(after, /已发送（MSG-/);
    assert.match(after, /① 已接收：已接收（尚未处理）/);
    assert.match(after, /② 对应任务：尚未关联任务（AI 处理前）/);
    assert.match(after, /③ AI 处理结果：尚未处理（收到 ≠ 已处理/);

    /* 真实列表接口复核（页面外核对库内事实）。 */
    const list = await server.request("GET", "/sorne/messages?project_id=" + encodeURIComponent(projectId) + "&limit=50");
    assert.equal(list.status, 200);
    assert.equal(list.body.messages.length, 1);
    assert.equal(list.body.messages[0].status, "received");
  }));

test("真实服务：#38 真实汇报三层（直写 worker_reports 行）在右栏详情呈现交接卡与关键记录层", () =>
  withTestServer(async (server) => {
    const created = await server.request("POST", "/sorne/projects", { body: { name: "M4 汇报详情项目" } });
    const projectId = created.body.project.id;

    const { getStore } = await import(pathToFileURL(join(LIB_DIR, "store", "record-service.mjs")).href);
    const store = await getStore({
      logger: { info() {}, warn() {}, error() {} },
      dataDir: server.dataDir,
      pluginDir: "",
      version: "test",
    });
    const reportId = "WR-M4-" + Date.now().toString(36);
    store.db.prepare(
      "INSERT INTO worker_reports (id, project_id, intent_id, attempt_id, kind, replaces_report_id, base_report_id, " +
      "source_manifest_id, source_commit_boundary, task_question, actual_outcome, execution_status, content, omitted_sections, " +
      "delivery_status, handling_status, created_at, created_by, created_seq) " +
      "VALUES (?, ?, 'I-M4TEST', 'ATT-M4TEST', 'blocked', NULL, NULL, 'EM-M4TEST', '1', '确认登录相关入口', " +
      "'缺少登录后的调用信息', 'blocked', ?, '[]', 'delivered', 'pending', ?, 'worker-m4', 1)",
    ).run(
      reportId,
      projectId,
      JSON.stringify({
        important_findings: [{ record_id: "F-M4TEST", type: "fact", current_status: "verified", short_statement: "页面调用 /api/login" }],
        material_conditions: ["观察来自未登录状态"], contradictions: [], significant_attempts: [],
        unresolved_questions: [], blockers: ["缺少登录后的调用信息"], prerequisite_changes: [],
        proposed_next_actions: ["补充登录信息"], evidence_refs: [],
      }),
      new Date().toISOString(),
    );

    const def = await loadPage("workbench");
    const ctx = makeCtx(realApi(server.base), { params: { id: reportId }, projectId: projectId });
    const t = mountDetail(def, ctx);
    await t.waitUntil(() => t.text().includes("第一层 · 交接卡"), { label: "真实交接卡层" });
    const text = t.text();
    assert.match(text, new RegExp(reportId));
    assert.match(text, /受阻汇报/);
    assert.match(text, /处理状态：待处理（pending）/);
    assert.match(text, /来源清单（Manifest）：EM-M4TEST · 提交边界：1/);
    assert.match(text, /任务：确认登录相关入口/);
    assert.match(text, /F-M4TEST（fact·当前状态 记录不存在）：页面调用 \/api\/login/, "直写汇报无对应记录行 → E2 按库渲染「记录不存在」");

    const expandButtons = t.findAllButtons("展开本层");
    t.click(expandButtons[0]);
    await t.waitUntil(() => t.text().includes("发现清单（状态以库为准并附声明值"), { label: "真实关键记录层" });
    assert.match(t.text(), /阻塞：缺少登录后的调用信息/);
    assert.match(t.text(), /需要的决策（建议后续动作）：补充登录信息（AI 建议单独标注，不能替代原记录状态）/);
  }));
