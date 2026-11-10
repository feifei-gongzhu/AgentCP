/**
 * M6 —— 发现页测试（lib/ui/pages/findings.page.mjs；BLUEPRINT-UI §1.5 发现 / §e-J3）。
 *
 * 覆盖：
 *   - 页面契约：纯 ESM 不引包、不用浏览器存储、无钩子、无编号正则副本、无字面颜色值、
 *     无宿主 --dsw-alias-* 变量；id/title/order 与注册表一致；render/renderDetail 齐备；
 *   - 主表（#30）：状态与复核状态分列（四态 + 三态徽章）、条件与证据入口、
 *     确认版本 JSON 折叠、行点击 → ?id= 详情、服务端筛选（status/review）、游标分页；
 *   - 详情：适用条件、版本字段实际值、证据索引（#14）→ 采集（#44）→ 原始字节（#43）、
 *     验证经过（#29：Manifest/outcome/applied=0 警示/等待时长/reviewed_evidence_revision
 *     实际值）、后续探索（#21 basis_refs）、请求复核只能发消息（#46）不得直改状态；
 *   - 语义纪律逐条迁移自 test/ui-verification.test.mjs（删测前）：confirmed 限指定条件 /
 *     insufficient 不写作已排除 / falsified 不等于历史上不存在 / 未应用意见警示 /
 *     按已加载数据推导；并新增「已提交 reviewed_evidence_revision 必须显示实际值」；
 *   - P0-3：验证区加载更多 cursor 主路径 + after 兼容（不写死单一错误参数）；
 *   - P0-4：渲染文本「未知类型（」0 次（永久闸）；
 *   - 真实服务：manifest 收录 findings（旧页已删）、真实 #30 台账渲染、#29 空队列诚实呈现。
 *
 * 测试宿主：沿用 M1/M3 测试宿主（不依赖 React 运行时）：最小 createElement + Component
 * 基类驱动页面类组件，并绑定 M1 真实渲染器（lib/ui/render.mjs + record-ids.mjs）。
 *
 * 并行安全：fakeApi 用例不占端口；真实服务用例走 withTestServer（独立临时目录 +
 * listen(0) 随机端口 + finally 收尾）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { withTestServer } from "./helpers.mjs";
import { issueSession } from "../lib/store/sessions.mjs";
import * as renderMod from "../lib/ui/render.mjs";
import * as recordIdsMod from "../lib/ui/record-ids.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGES_DIR = join(HERE, "..", "lib", "ui", "pages");

async function loadPage(id) {
  const mod = await import(pathToFileURL(join(PAGES_DIR, id + ".page.mjs")).href);
  return mod.default;
}

/* ── 最小宿主与 M1 真实渲染器绑定（同 ui-projects.test.mjs 先例） ──── */

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

function mountTree(rootElem) {
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

  async function flush(rounds = 32) {
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
    assert.ok(hits.length >= 1, "未找到按钮「" + label + "」；当前文本：" + text().slice(0, 600));
    return hits[hits.length - 1];
  }

  function click(node) {
    assert.ok(!node.props.disabled, "按钮被禁用：" + nodeText(node.children));
    node.props.onClick({ preventDefault() {}, stopPropagation() {} });
  }

  function rowElements() {
    return findAll((n) => n.type === "tr" && n.props.onClick);
  }

  function findTextarea() {
    return findAll((n) => n.type === "textarea")[0] || null;
  }

  return { flush, text, findAll, findButton, click, rowElements, nodeText, findTextarea };
}

/* ── fakeApi（按 METHOD + 基路径分发；handler 可读完整 path） ──────── */

function parseBody(raw) {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
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
    const handler = handlers[method + " " + basePath(path)];
    if (!handler) {
      return Promise.reject(new Error("fakeApi 未配置：" + method + " " + basePath(path)));
    }
    return Promise.resolve().then(() => (typeof handler === "function" ? handler(body, path) : handler));
  };
  fn.calls = calls;
  return fn;
}

function makeCtx(api, { page = "findings", projectId = "PRJ-0001", params = {}, hash } = {}) {
  const calls = [];
  const router = {
    hash: hash || "#/p/" + projectId + "/" + page,
    page,
    projectId,
    params,
    query: {},
    open: (target) => calls.push({ kind: "open", hash: target }),
    replace: (target) => calls.push({ kind: "replace", hash: target }),
    back: (fb) => calls.push({ kind: "back", fallback: fb }),
    openRecord: (id) => calls.push({ kind: "openRecord", id }),
    isInAppHistory: () => false,
    onChange: () => () => {},
    __calls: calls,
  };
  return { React: { createElement: h, Component: ComponentBase }, h, api, router, ui, theme: null, __router: router };
}

/* ── 样例数据 ─────────────────────────────────────────────────────── */

const SHA = "ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56abcd";
const SHA64 = "0".repeat(64);

const V1 = {
  id: "V-0001", project_id: "PRJ-0001", asset_id: "A-0001", category: "sql-injection",
  location: "/login", status: "suspected", review: "clear", conditions: ["未登录身份"],
  confirmed_version: null, claim_revision: 1, evidence_revision: 2, assessment_epoch: 1,
  created_at: "2026-11-06T02:00:00.000Z",
  evidence: { supports: 1, contradicts: 0, total: 1 }, candidate_groups: [],
};
const V2 = {
  ...V1, id: "V-0002", status: "confirmed", review: "clear",
  confirmed_version: { verification_result_id: "VR-0002", reviewed_manifest_id: "EM-0002", state_version: 2 },
  evidence_revision: 3, evidence: { supports: 2, contradicts: 0, total: 2 },
};
const V3 = {
  ...V1, id: "V-0003", status: "falsified", review: "pending",
  confirmed_version: { verification_result_id: "VR-0003" }, evidence: { supports: 0, contradicts: 2, total: 2 },
};
const V4 = {
  ...V1, id: "V-0004", status: "inconclusive", review: "disputed", evidence: { supports: 1, contradicts: 1, total: 2 },
};

const LIST = {
  project_id: "PRJ-0001",
  vulnerabilities: [V1, V2, V3, V4],
  total: 4,
  next_cursor: null,
  has_more: false,
  note: "status 为结论状态、review 为复核状态，二者独立；confirmed 只说明在指定条件下得到确认，不代表持续存在",
};

const JOB_BASE = {
  id: "VJ-0007", subject_id: "V-0002", subject_kind: "vulnerability", claim_revision: 1,
  condition_snapshot_id: "CS-0042", policy_id: "policy/x", policy_version: "v1",
  evidence_manifest_id: "EM-0007",
  expected: { state_version: 2, evidence_revision: 3, assessment_epoch: 1 },
  manifest: { id: "EM-0007", members_count: 2, evidence_revision: 3, content_hash: SHA64 },
  created_at: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
  waiting_ms: 2 * 3600 * 1000,
  status: "completed",
  latest_result: {
    id: "VR-0007", outcome: "supported", applied: false,
    verifier_identity: "verifier-x", reviewed_manifest_id: "EM-0007",
    reviewed_evidence_revision: 7, created_at: "2026-11-06T03:00:00.000Z",
  },
};
const JOB_PENDING = {
  id: "VJ-0008", subject_id: "V-0002", subject_kind: "vulnerability", status: "pending",
  policy_id: "policy/x", policy_version: "v1", condition_snapshot_id: "CS-0042",
  created_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
  expected: { state_version: 2, evidence_revision: 4, assessment_epoch: 1 },
  latest_result: null,
};

const RECORD = {
  record: {
    id: "V-0002", kind: "vulnerabilities", project_id: "PRJ-0001", status: "confirmed",
    review: "pending", category: "sql-injection", location: "/login",
    conditions: ["未登录身份"], claim_revision: 1, evidence_revision: 3, assessment_epoch: 1,
    confirmed_version: { verification_result_id: "VR-0002", reviewed_manifest_id: "EM-0002" },
  },
  evidence_index: [{
    membership_id: "M-0001", member_kind: "observations", member_id: "O-0001",
    stance: "supports", status: "active", read_path: "/sorne/records/O-0001?project_id=PRJ-0001",
  }],
  relations: { edges: [], truncated: false },
  expand: { note: "原始证据字节按需读取" },
};

const INTENTS = {
  intents: [
    { id: "I-PRJ-0001-0001", question: "围绕 V-0002 排查同参数族入口", kind: "investigate", status: "queued", basis_refs: ["V-0002"], prerequisite_refs: [] },
    { id: "I-PRJ-0001-0002", question: "无关方向", kind: "collect", status: "queued", basis_refs: [], prerequisite_refs: [] },
    { id: "I-PRJ-0001-0003", question: "以该发现为前提的复核", kind: "verify", status: "proposed", prerequisite_refs: ["V-0002"] },
  ],
};

function detailHandlers(overrides = {}) {
  return {
    "GET /sorne/records/V-0002": RECORD,
    "GET /sorne/verification-jobs": { jobs: [JOB_BASE, JOB_PENDING], next_cursor: null, next_after: null, has_more: false },
    "GET /sorne/intents": INTENTS,
    "GET /sorne/records/O-0001": {
      record: { id: "O-0001", kind: "observations", statement: "登录接口对单引号返回 500", capture_id: "CAP-0001", conditions: ["未登录身份"] },
      evidence_index: [], relations: { edges: [], truncated: false }, expand: {},
    },
    "GET /sorne/captures/CAP-0001": {
      capture: {
        id: "CAP-0001", capture_id: "CAP-0001", condition_snapshot_id: "CS-0042",
        integrity_status: "verified", response_body_blob: { sha256: SHA, representation: "raw_body" },
      },
    },
    ["GET /sorne/evidence/blobs/" + SHA]: { raw: "HTTP/1.1 200 OK\r\nX-Echo: <script>alert(1)</script>" },
    "POST /sorne/projects/PRJ-0001/messages": {
      message: { id: "MSG-PRJ-0001-0001", direction: "user", status: "received", content: "…" },
      state: "queued_for_orchestrator",
    },
    ...overrides,
  };
}

async function mountDetail(handlers = detailHandlers()) {
  const def = await loadPage("findings");
  const api = fakeApi(handlers);
  const ctx = makeCtx(api, { params: { id: "V-0002" } });
  const t = mountTree(def.renderDetail(ctx));
  await t.flush();
  return { def, api, ctx, t };
}

/* ══════════════════════════════════════════════════════════════════ */
/* 1. 页面契约                                                         */
/* ══════════════════════════════════════════════════════════════════ */

test("M6 页面契约：纯 ESM 不引包、无存储/钩子、无编号正则副本、无字面颜色值、注册表 id/order", async () => {
  const src = await readFile(join(PAGES_DIR, "findings.page.mjs"), "utf8");
  assert.doesNotMatch(src, /(^|\n)\s*import[\s(]/, "页面不得静态 import 任何模块");
  assert.doesNotMatch(src, /[^.\w]require\s*\(/, "页面不得使用 require");
  assert.doesNotMatch(src, /localStorage/, "页面不得使用浏览器本地存储");
  assert.doesNotMatch(src, /React\.useState|React\.useEffect|useState\(|useEffect\(/, "页面不得使用 React 钩子");
  assert.doesNotMatch(src, /RECORD_ID_RE/, "编号正则唯一实现必须在 lib/ui/record-ids.mjs（P0-2②）");
  assert.doesNotMatch(src, /#[0-9a-fA-F]{3,8}\b|rgba?\(/, "页面不得书写字面颜色值（P0-1②）");
  assert.doesNotMatch(src, /--dsw-alias-/, "页面不得引用宿主 --dsw-alias-* 变量");
  assert.ok(!src.includes("未知类型（"), "页面不得出现 P0-4 缺陷文案「未知类型（」");

  const def = await loadPage("findings");
  assert.equal(def.id, "findings");
  assert.equal(def.title, "发现");
  assert.equal(def.order, 50);
  assert.equal(typeof def.render, "function");
  assert.equal(typeof def.renderDetail, "function", "发现页必须提供 renderDetail（§2.4-2 右栏详情）");
});

/* ══════════════════════════════════════════════════════════════════ */
/* 2. 主表：四态 + 复核分列 + 条件/证据入口 + 确认版本折叠 + 行点击        */
/* ══════════════════════════════════════════════════════════════════ */

test("主表：状态四态与复核三态分列徽章（冻结文案），行点击进入 ?id= 详情", async () => {
  const def = await loadPage("findings");
  const api = fakeApi({ "GET /sorne/vulnerabilities": LIST });
  const ctx = makeCtx(api);
  const t = mountTree(def.render(ctx));
  await t.flush();
  const text = t.text();

  const heads = t.findAll((n) => n.type === "th").map((n) => t.nodeText(n.children));
  assert.ok(heads.some((x) => x.includes("状态")), "缺状态列：" + JSON.stringify(heads));
  assert.ok(heads.some((x) => x.includes("复核状态")), "缺复核状态列");
  assert.ok(heads.some((x) => x.includes("证据入口")), "缺证据入口列");
  assert.ok(heads.some((x) => x.includes("确认版本")), "缺确认版本列");

  assert.match(text, /疑似/);
  assert.match(text, /已确认（限指定条件）/);
  assert.match(text, /已证伪（不等于历史上不存在）/);
  assert.match(text, /证据不足：未确认，不伪装成已排除/);
  assert.match(text, /待复核/);
  assert.match(text, /有争议/);

  const rows = t.rowElements();
  assert.equal(rows.length, 4, "四行发现");
  t.click(rows[1]);
  const open = ctx.__router.__calls.find((c) => c.kind === "open");
  assert.ok(open, "行点击应打开详情");
  assert.equal(open.hash, "#/p/PRJ-0001/findings?id=V-0002");
});

test("主表：条件逐条呈现、证据计数入口可点、确认版本 JSON 折叠（折叠不删记录）", async () => {
  const def = await loadPage("findings");
  const api = fakeApi({ "GET /sorne/vulnerabilities": LIST });
  const ctx = makeCtx(api);
  const t = mountTree(def.render(ctx));
  await t.flush();
  const text = t.text();

  assert.match(text, /适用条件：未登录身份/);
  assert.match(text, /支持 2 · 反对 0 · 共 2/);
  assert.match(text, /已折叠 3 项|已折叠 2 项/, "确认版本应默认折叠并给出折叠计数");
  /* 确认版本 JSON 展开后可见 field 值。 */
  const fold = t.findButton("{3 项}") || t.findButton("确认版本");
  if (fold) {
    t.click(fold);
    await t.flush();
    assert.match(t.text(), /verification_result_id|reviewed_manifest_id/);
  }
  /* 证据入口按钮：打开详情（不发任何改状态请求）。 */
  const evidenceBtn = t.findButton("支持 1 · 反对 0 · 共 1");
  t.click(evidenceBtn);
  const open = ctx.__router.__calls.filter((c) => c.kind === "open");
  assert.ok(open.some((c) => c.hash.includes("?id=V-0001")));
  assert.ok(!api.calls.some((c) => c.method !== "GET"), "列表页不得发变更请求");
});

test("主表筛选走服务端 #30 status/review 参数并重置到第一页", async () => {
  const def = await loadPage("findings");
  const api = fakeApi({ "GET /sorne/vulnerabilities": LIST });
  const ctx = makeCtx(api);
  const t = mountTree(def.render(ctx));
  await t.flush();
  api.calls.length = 0;

  t.click(t.findButton("已确认"));
  await t.flush();
  assert.ok(api.calls.some((c) => c.path.includes("status=confirmed")), "筛选应带 status 参数：" + JSON.stringify(api.calls.map((c) => c.path)));
  api.calls.length = 0;
  t.click(t.findButton("待复核"));
  await t.flush();
  assert.ok(api.calls.some((c) => c.path.includes("review=pending")), "筛选应带 review 参数");
  assert.ok(api.calls.every((c) => !c.path.includes("cursor=")), "切换筛选应回到第一页");
});

test("主表游标分页：加载更多携带 cursor 并跨页累积（不静默截断）", async () => {
  const def = await loadPage("findings");
  const page2 = { ...V4, id: "V-0005" };
  const api = fakeApi({
    "GET /sorne/vulnerabilities": (body, path) => path.includes("cursor=")
      ? { vulnerabilities: [page2], total: 5, next_cursor: null, has_more: false }
      : { vulnerabilities: [V1, V2], total: 5, next_cursor: "2:V-0002", has_more: true },
  });
  const ctx = makeCtx(api);
  const t = mountTree(def.render(ctx));
  await t.flush();
  assert.match(t.text(), /已加载 2 \/ 共 5 条/);
  t.click(t.findButton("加载更多发现"));
  await t.flush();
  assert.ok(api.calls.some((c) => c.path.includes("cursor=2%3AV-0002")), "加载更多应携带 cursor");
  assert.match(t.text(), /V-0005/);
  assert.match(t.text(), /V-0001/, "跨页累积不丢第一页");
  assert.match(t.text(), /已加载 3 \/ 共 5 条/);
});

test("数据时刻 / 按已加载数据推导 / 不代表全量 的边界说明在场；§ 引用 ≤2", async () => {
  const def = await loadPage("findings");
  const api = fakeApi({ "GET /sorne/vulnerabilities": { ...LIST, next_cursor: "4:V-0004", has_more: true } });
  const ctx = makeCtx(api);
  const t = mountTree(def.render(ctx));
  await t.flush();
  const text = t.text();
  assert.match(text, /数据时刻：/);
  assert.match(text, /按已加载数据推导/);
  assert.match(text, /不代表全量/);
  const sections = (text.match(/§/g) || []).length;
  assert.ok(sections <= 2, "每页「§」引用应 ≤2：" + sections);
});

test("空态、无项目、错误态与形状无法识别：诚实呈现不白屏", async () => {
  const def = await loadPage("findings");
  /* 空台账。 */
  const apiEmpty = fakeApi({ "GET /sorne/vulnerabilities": { vulnerabilities: [], total: 0 } });
  const t1 = mountTree(def.render(makeCtx(apiEmpty)));
  await t1.flush();
  assert.match(t1.text(), /暂无发现/);

  /* 无项目上下文：不发请求，给引导。 */
  const apiNone = fakeApi({});
  const t2 = mountTree(def.render(makeCtx(apiNone, { projectId: "" })));
  await t2.flush();
  assert.match(t2.text(), /缺少项目上下文/);
  assert.equal(apiNone.calls.length, 0, "无项目时不应发请求");

  /* 错误态。 */
  const apiErr = fakeApi({ "GET /sorne/vulnerabilities": () => { throw Object.assign(new Error("boom"), { code: "INTERNAL_ERROR" }); } });
  const t3 = mountTree(def.render(makeCtx(apiErr)));
  await t3.flush();
  assert.match(t3.text(), /发现台账加载失败/);
  assert.match(t3.text(), /INTERNAL_ERROR/);
});

/* ══════════════════════════════════════════════════════════════════ */
/* 3. 详情：条件/证据索引/验证经过/后续探索/请求复核                    */
/* ══════════════════════════════════════════════════════════════════ */

test("详情：适用条件、版本字段实际值、确认版本折叠（未提供≠不存在）", async () => {
  const { t } = await mountDetail(detailHandlers({
    "GET /sorne/records/V-0002": {
      ...RECORD,
      record: { ...RECORD.record, confirmed_version: null, claim_revision: 4, evidence_revision: 9, assessment_epoch: 2 },
    },
  }));
  const text = t.text();
  assert.match(text, /发现详情/);
  assert.match(text, /适用条件：未登录身份/);
  assert.match(text, /判断修订：4 · 证据集版本：9 · 评估纪元：2/);
  assert.match(text, /确认版本：—（未提供）/);
});

test("详情证据索引 #14 → 采集 #44 → 原始字节 #43；成员编号经 openRecord 打开覆盖层（J3 页面半边）", async () => {
  const { api, ctx, t } = await mountDetail();
  assert.match(t.text(), /证据索引/);
  assert.match(t.text(), /支持 · observations · 状态 active/);
  assert.ok(t.findButton("读取采集与原始证据"), "缺采集读取入口");
  assert.ok(t.findButton("O-0001"), "证据成员编号应可点击");

  /* 点击成员编号：打开记录覆盖层（不改变当前详情 hash；返回原位由外壳返回栈保证）。 */
  t.click(t.findButton("O-0001"));
  assert.ok(ctx.__router.__calls.some((c) => c.kind === "openRecord" && c.id === "O-0001"), "应打开 /records 覆盖层");
  assert.match(t.text(), /发现详情/, "详情保持原位可读");

  /* 读取采集与原始证据：三级真实读取链路。 */
  t.click(t.findButton("读取采集与原始证据"));
  await t.flush();
  assert.ok(api.calls.some((c) => c.path.startsWith("/sorne/records/O-0001")), "应读取成员记录");
  assert.ok(api.calls.some((c) => c.path.startsWith("/sorne/captures/CAP-0001")), "应读取采集 #44");
  const text = t.text();
  assert.match(text, /条件快照：CS-0042/);
  assert.match(text, /完整性：verified/);
  assert.match(text, /sha256:ab12cd34ef/);
  assert.ok(t.findButton("读取原始字节"), "缺 #43 原始字节入口");

  t.click(t.findButton("读取原始字节"));
  await t.flush();
  assert.ok(api.calls.some((c) => c.path.startsWith("/sorne/evidence/blobs/" + SHA)), "应读取原始字节 #43");
  assert.match(t.text(), /X-Echo/);
});

test("详情验证经过 #29：Manifest 摘要、outcome 徽章、未应用意见警示、等待时长、reviewed_evidence_revision 实际值", async () => {
  const { t } = await mountDetail();
  const text = t.text();
  assert.match(text, /验证经过/);
  /* Manifest 摘要：编号/成员/证据集版本/内容哈希。 */
  assert.match(text, /EM-0007 · 成员 2 · 证据集版本 3 · 内容哈希 sha256:0000000000/);
  /* outcome 词表徽章（不夸大）。 */
  assert.match(text, /支持（验证通过）/);
  /* 未应用意见警示（§12.2 语义，不隐藏意见）。 */
  assert.match(text, /状态转换：未应用——验证意见已保存，标记需复核，不覆盖新结论。/);
  /* 已提交的 reviewed_evidence_revision 必须显示实际值（不是「未提供」）。 */
  assert.match(text, /审阅证据集版本：7/);
  assert.doesNotMatch(text, /审阅证据集版本：—（未提供）/);
  assert.match(text, /审阅清单：EM-0007/);
  /* 等待时长：仅非终态任务展示（VJ-0008 pending 按创建时刻推算；VJ-0007 已完成不展示）。 */
  assert.match(text, /等待时长：已等待约 30 分 0 秒/);
  assert.equal((text.match(/等待时长：/g) || []).length, 1, "终态任务不应展示等待时长");
  /* 无结论任务诚实呈现。 */
  assert.match(text, /该任务尚无验证结论/);
});

test("P0-4 永久闸：验证区不出现「未知类型（」——旧物理表名与未知 subject_kind 均不触发", async () => {
  const { t } = await mountDetail(detailHandlers({
    "GET /sorne/verification-jobs": {
      jobs: [
        { ...JOB_BASE, subject_kind: "vulnerabilities" },
        { ...JOB_PENDING, id: "VJ-0009", subject_kind: "weird_kind_xyz" },
      ],
      next_cursor: null,
    },
  }));
  const text = t.text();
  assert.ok(!text.includes("未知类型（"), "渲染文本不得出现「未知类型（」");
  assert.match(text, /未知状态（vulnerabilities）/, "未知状态仍应显式呈现，不静默");
});

test("验证区加载更多：cursor 主路径（next_cursor → cursor）跨页累积", async () => {
  const second = { ...JOB_BASE, id: "VJ-0010", latest_result: null };
  const handlers = detailHandlers({
    "GET /sorne/verification-jobs": (body, path) => path.includes("cursor=")
      ? { jobs: [second], next_cursor: null, has_more: false }
      : { jobs: [JOB_BASE], next_cursor: "10:VJ-0007", next_after: "10:VJ-0007", has_more: true },
  });
  const { api, t } = await mountDetail(handlers);
  assert.match(t.text(), /VJ-0007/);
  t.click(t.findButton("加载更多验证任务"));
  await t.flush();
  assert.ok(api.calls.some((c) => c.path.includes("cursor=10%3AVJ-0007")), "主路径应使用 cursor：" + JSON.stringify(api.calls.map((c) => c.path)));
  assert.match(t.text(), /VJ-0010/);
  assert.match(t.text(), /VJ-0007/, "跨页累积不丢第一页任务");
});

test("验证区加载更多：after 兼容路径（仅 next_after 的信封 → after 参数）", async () => {
  const second = { ...JOB_BASE, id: "VJ-0011", latest_result: null };
  const handlers = detailHandlers({
    "GET /sorne/verification-jobs": (body, path) => path.includes("after=")
      ? { jobs: [second], next_after: null }
      : { jobs: [JOB_BASE], next_after: "7:VJ-0007" },
  });
  const { api, t } = await mountDetail(handlers);
  t.click(t.findButton("加载更多验证任务"));
  await t.flush();
  assert.ok(api.calls.some((c) => c.path.includes("after=7%3AVJ-0007")), "兼容路径应使用 after：" + JSON.stringify(api.calls.map((c) => c.path)));
  assert.match(t.text(), /VJ-0011/);
});

test("后续探索：按 basis_refs / prerequisite_refs 关联意图，并注明按已加载意图推导", async () => {
  const { t } = await mountDetail();
  const text = t.text();
  assert.match(text, /后续探索/);
  assert.match(text, /按已加载意图推导/);
  assert.match(text, /I-PRJ-0001-0001/);
  assert.match(text, /I-PRJ-0001-0003/);
  assert.doesNotMatch(text, /I-PRJ-0001-0002/, "无关意图不应出现");
});

test("请求复核：只发用户消息（#46）由协调 AI 转验证流程；绝不直接改状态", async () => {
  const { api, t } = await mountDetail();
  t.click(t.findButton("请求复核（经协调 AI）"));
  await t.flush();
  const ta = t.findTextarea();
  assert.ok(ta, "应展开复核请求编辑框");
  assert.match(String(ta.props.value), /请为 V-0002 安排一次独立验证复核/);
  ta.props.onChange({ target: { value: "请复核该发现，并说明证据缺口" } });
  t.click(t.findButton("发送复核请求"));
  await t.flush();

  const sent = api.calls.find((c) => c.method === "POST");
  assert.ok(sent, "应发出用户消息");
  assert.equal(sent.path, "/sorne/projects/PRJ-0001/messages");
  assert.deepEqual(sent.body, { content: "请复核该发现，并说明证据缺口" });
  assert.ok(
    !api.calls.some((c) => /verification-requests|verification-results|lifecycle/.test(c.path)),
    "页面不得直调验证请求/结果或生命周期端点改状态：" + JSON.stringify(api.calls.map((c) => c.path)),
  );
  assert.match(t.text(), /已接收（尚未处理）/, "delivered≠handled：回执应显示尚未处理");
  assert.match(t.text(), /本页不直接修改漏洞状态/);
});

test("详情错误与无编号分支：错误卡可重试、无 id 显式提示（深链缺参不白屏）", async () => {
  const def = await loadPage("findings");
  const apiErr = fakeApi({
    "GET /sorne/records/V-0002": () => { throw Object.assign(new Error("not found"), { code: "NOT_FOUND" }); },
    "GET /sorne/verification-jobs": { jobs: [] },
    "GET /sorne/intents": { intents: [] },
  });
  const ctx = makeCtx(apiErr, { params: { id: "V-0002" } });
  const t = mountTree(def.renderDetail(ctx));
  await t.flush();
  assert.match(t.text(), /记录读取失败/);
  assert.match(t.text(), /NOT_FOUND/);
  assert.ok(t.findButton("重试"));

  const t2 = mountTree(def.renderDetail(makeCtx(fakeApi({}), { params: {} })));
  await t2.flush();
  assert.match(t2.text(), /未选择发现/);
});

/* ══════════════════════════════════════════════════════════════════ */
/* 4. 真实服务：manifest 收录 findings、#30 真实台账                    */
/* ══════════════════════════════════════════════════════════════════ */

test("真实服务：manifest 收录 findings（旧验证/漏洞页已删）；真实 #30 台账渲染；#29 空队列诚实呈现", () =>
  withTestServer(async (s) => {
    const manifest = await s.request("GET", "/sorne/ui/manifest");
    assert.equal(manifest.status, 200);
    const ids = manifest.body.pages.map((p) => p.id);
    assert.ok(ids.includes("findings"), "manifest 应含 findings");
    assert.ok(!ids.includes("verification"), "旧 verification 页应已删除");
    assert.ok(!ids.includes("vulnerabilities"), "旧 vulnerabilities 页应已删除");

    const created = await s.request("POST", "/sorne/projects", { body: { name: "发现页真实服务" } });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const projectId = created.body.project.id;
    const worker = issueSession({ project_id: projectId, actor: "w-findings", role: "worker" });
    const submit = await fetch(s.base + "/sorne/submissions", {
      method: "POST",
      headers: { origin: s.base, "content-type": "application/json", "x-sorne-session": worker.session_token },
      body: JSON.stringify({
        submission_id: "ui-findings-1",
        operations: [
          { op: "register_asset", local_ref: "a", asset_type: "host", canonicalization_version: "v1", canonical_key: "find.example.test" },
          { op: "append_observation", local_ref: "o", statement: "登录接口对单引号返回 500", conditions: ["未登录身份"] },
          { op: "report_vulnerability", local_ref: "v", asset_id: "a", category: "sql-injection", location: "/login", conditions: ["未登录身份"] },
          { op: "add_relation", from: "o", type: "supports", to: "v" },
        ],
      }),
    });
    const submitText = await submit.text();
    assert.equal(submit.status, 200, submitText);
    const receipt = JSON.parse(submitText);

    const def = await loadPage("findings");
    const realApi = async (path) => {
      const res = await fetch(s.base + path, { headers: { origin: s.base } });
      const text = await res.text();
      const data = text ? JSON.parse(text) : null;
      if (!res.ok) {
        const err = new Error((data && data.message) || "HTTP " + res.status);
        err.status = res.status;
        err.code = data && data.code;
        throw err;
      }
      return data;
    };
    const ctx = makeCtx(realApi, { projectId });
    const t = mountTree(def.render(ctx));
    await t.flush();
    const text = t.text();
    assert.match(text, new RegExp(receipt.ids.v), "真实台账应出现新漏洞编号");
    assert.match(text, /疑似/, "suspected 应如实呈现（不自动升级）");
    assert.match(text, /适用条件：未登录身份/);

    /* #29 空队列在详情中的诚实呈现（真实服务无验证任务）。 */
    const detailCtx = makeCtx(realApi, { projectId, params: { id: receipt.ids.v } });
    const d = mountTree(def.renderDetail(detailCtx));
    await d.flush();
    assert.match(d.text(), /尚无验证任务/);
    assert.match(d.text(), /证据索引/);
    /* 证据成员按需展开：成员记录/采集明细（真实 #14；无采集时如实「—（未提供）」）。
       真实 fetch 链路需等待异步完成（fakeApi 同步 flush 不适用）。 */
    d.click(d.findButton("读取采集与原始证据"));
    let memberText = "";
    for (let i = 0; i < 60; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      await d.flush(4);
      memberText = d.text();
      if (memberText.includes("成员记录：") || memberText.includes("读取失败")) break;
    }
    assert.match(memberText, /成员记录：登录接口对单引号返回 500/);
    assert.match(memberText, /采集：—（未提供）/);
  }));
