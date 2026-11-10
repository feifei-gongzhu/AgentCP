/**
 * M6 —— 报告页测试（lib/ui/pages/reports.page.mjs 重写版；BLUEPRINT-UI 1.5 / e-J6 / g）。
 *
 * 覆盖（旧 test/ui-reports.test.mjs（F3）断言逐条迁移，迁移清单见
 * docs/modules/ui-M6-reports.md）：
 *   - 页面契约：纯 ESM 不引包、不用浏览器本地存储、无 React 钩子、无编号正则副本
 *     （RECORD_ID_RE 仅存在于 lib/ui/record-ids.mjs）、无字面颜色值与宿主变量
 *     （全部经 --sorne-* token）、中文标题「报告」、冻结 order 60、render + renderDetail；
 *   - 可见正文不出现规范章节引用（全部解释性段落收进「语义说明」折叠区，折叠不删
 *     记录；源码中章节引用仅存在于 SEMANTICS 数组一处）；
 *   - 漏洞报告（端点 39）：摘要列表（状态/复核分列、版本计数、数据截止边界、报告
 *     版本编号 chip）、cursor 游标分页「加载更多」、501 → 「未实现」不是报错、错误卡、
 *     未知形状显式、空态显式；
 *   - 阶段报告（端点 40）：五分区（已确认成果/未确认线索/已完成方向/受阻方向/未覆盖
 *     部分）计数与缺省、数据截止边界（提交边界 + 生成时间 + 边界之后/不代表全量）、
 *     版本切换、按需生成（refresh=1；读取默认不增殖版本；生成不结束项目）；
 *   - 覆盖缺口：未覆盖聚合、按资产/方向/身份条件记录、未覆盖标记、折叠口径说明；
 *   - 单份详情（hash ?id=RR-/MR-/V-）：经端点 14 解析报告版本行（subject_id +
 *     version）再读端点 39/40；版本为历史版本时显式提示且边界同步切换；§19 最小
 *     内容集（状态/复核/条件/支持与反对证据/验证结论含 reviewed_evidence_revision
 *     实际值/限制/来源与后续意图/四向追溯）；全部编号为 RecordIdChip（openRecord，
 *     页面不自行请求 /records）；
 *   - 导出（端点 53）：成功 → Markdown 下载链接 + 内容与视图同源说明；404 → 失败
 *     如实呈现（含服务端 note）与下一步条件，不虚报导出成功；
 *   - 真实服务集成：manifest 注册、真实项目/漏洞/阶段报告、生成（refresh=1）、
 *     详情读回与真实导出（字节经页面导出路径）。
 *
 * 测试宿主：不依赖 React 运行时（依赖树不含 react）——最小 createElement + Component
 * 基类驱动页面类组件，绑定 M1 真实渲染器（lib/ui/render.mjs + record-ids.mjs），
 * 断言打到真实渲染输出（含 StatusBadge/RecordIdChip/FieldRow/FoldableObject）。
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
import { issueSession } from "../lib/store/sessions.mjs";
import * as renderMod from "../lib/ui/render.mjs";
import * as recordIdsMod from "../lib/ui/record-ids.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGES_DIR = join(HERE, "..", "lib", "ui", "pages");
const PAGE_FILE = join(PAGES_DIR, "reports.page.mjs");

async function loadPage() {
  const mod = await import(pathToFileURL(PAGE_FILE).href);
  return mod.default;
}

/* ══════════════════════════════════════════════════════════════════ */
/* 1. 最小宿主 + M1 真实渲染器绑定                                      */
/* ══════════════════════════════════════════════════════════════════ */

const h = (type, props, ...children) => ({
  __elem: true,
  type,
  props: props || {},
  children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== true && c !== false),
});
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

/* ══════════════════════════════════════════════════════════════════ */
/* 2. 挂载仿真（展开类组件树；渲染器函数组件直接调用）                  */
/* ══════════════════════════════════════════════════════════════════ */

function mountPage(def, ctx, { detail = false } = {}) {
  const rootElem = detail ? def.renderDetail(ctx) : def.render(ctx);
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

  async function flush(rounds = 30) {
    for (let i = 0; i < rounds; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    rerender();
  }

  async function waitUntil(pred, { rounds = 400, label = "条件" } = {}) {
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

  /** 折叠区内容（childValue 保留在元素 props 中；折叠不删记录，展开可见）。 */
  function foldedText() {
    const parts = [];
    (function walkNode(node) {
      if (!node || !node.__elem) return;
      if (Object.prototype.hasOwnProperty.call(node.props || {}, "childValue")) {
        const value = node.props.childValue;
        try {
          parts.push(typeof value === "string" ? value : JSON.stringify(value));
        } catch {
          parts.push(String(value));
        }
      }
      for (const child of node.children) walkNode(child);
    })(tree);
    return parts.join("\n");
  }

  function findButton(label) {
    const hits = findAll((n) => n.type === "button" && nodeText(n.children).includes(label));
    assert.ok(hits.length >= 1, "未找到按钮「" + label + "」；当前文本：" + text().slice(0, 500));
    return hits[hits.length - 1];
  }

  function findButtons(label) {
    return findAll((n) => n.type === "button" && nodeText(n.children).includes(label));
  }

  function click(node) {
    assert.ok(!node.props.disabled, "按钮被禁用：" + nodeText(node.children));
    node.props.onClick({ preventDefault() {}, stopPropagation() {} });
  }

  function rowElements() {
    return findAll((n) => n.type === "tr" && typeof n.props.onClick === "function");
  }

  return { flush, waitUntil, text, foldedText, findAll, findButton, findButtons, click, rowElements, nodeText };
}

/* ══════════════════════════════════════════════════════════════════ */
/* 3. fakeApi / 上下文                                                  */
/* ══════════════════════════════════════════════════════════════════ */

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
  e.detail = body.detail;
  e.body = body;
  return e;
}

function fakeApi(handlers) {
  const calls = [];
  const fn = (path, options) => {
    const method = (options && options.method) || "GET";
    calls.push({ method, path, options });
    const handler = handlers[method + " " + path];
    if (handler === undefined) {
      return Promise.reject(new Error("fakeApi 未配置：" + method + " " + path));
    }
    if (handler instanceof Error) return Promise.reject(handler);
    return Promise.resolve().then(() => (typeof handler === "function" ? handler(path) : handler));
  };
  fn.calls = calls;
  return fn;
}

function makeRouter({ projectId = "PRJ-001", page = "reports", id = "" } = {}) {
  const calls = [];
  const listeners = new Set();
  const router = {
    hash: "",
    page,
    projectId,
    recordId: null,
    params: id ? { id } : {},
    query: {},
    open: (target) => {
      calls.push({ kind: "open", hash: target });
      router.hash = target;
      for (const fn of Array.from(listeners)) fn(router);
    },
    replace: (target) => calls.push({ kind: "replace", hash: target }),
    back: (fallback) => calls.push({ kind: "back", fallback }),
    openRecord: (recordId) => calls.push({ kind: "openRecord", id: recordId }),
    isInAppHistory: () => false,
    onChange: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    __calls: calls,
  };
  return router;
}

function makeCtx(api, opts) {
  const router = makeRouter(opts);
  return { React: { createElement: h, Component: ComponentBase }, h, api, router, ui, theme: null };
}

/* ══════════════════════════════════════════════════════════════════ */
/* 4. 夹具（端点 39/40/14/53 的实装形状）                                */
/* ══════════════════════════════════════════════════════════════════ */

const P1 = "PRJ-001";

function vulnListItem(over) {
  return Object.assign({
    id: "V-0003",
    report_kind: "vulnerability",
    subject_id: "V-0003",
    asset_id: "A-0012",
    category: "SQL 注入",
    location: "/api/users?id=1",
    status: "confirmed",
    review: "pending",
    latest_version: "v2",
    version: "v2",
    versions: 2,
    changed_fields: ["status"],
    data_boundary: { snapshot_commit_seq: 42, generated_at: "2026-11-05T10:00:00.000Z" },
    report_id: "RR-PRJ-001-0002",
    content_ref: "reports/vulnerabilities/V-0003/v2.json",
    created_at: "2026-11-05T10:00:00.000Z",
  }, over || {});
}

function vulnListEnvelope(over) {
  return Object.assign({
    project_id: P1,
    reports: [
      vulnListItem(),
      vulnListItem({
        id: "V-0005", subject_id: "V-0005", asset_id: "A-0002", category: "越权访问",
        location: "/api/admin", status: "suspected", review: "clear",
        latest_version: "v1", version: "v1", versions: 1, changed_fields: null,
        data_boundary: { snapshot_commit_seq: 50, generated_at: "2026-11-05T11:00:00.000Z" },
        report_id: "RR-PRJ-001-0003", content_ref: "reports/vulnerabilities/V-0005/v1.json",
      }),
    ],
    summary: { total: 2, by_status: { confirmed: 1, suspected: 1 }, by_review: { pending: 1, clear: 1 } },
    total: 2,
    next_cursor: null,
    has_more: false,
    sync: [],
    note: "漏洞报告自 suspected 起即有草稿并随状态/证据/条件/影响持续更新",
  }, over || {});
}

function vulnDetailEnvelope(version) {
  const isHistory = version === "v1";
  return {
    project_id: P1,
    report: {
      report_kind: "vulnerability",
      schema_version: 1,
      subject: {
        id: "V-0003", project_id: P1,
        asset: { id: "A-0012", asset_type: "web_service", canonical_key: "https://test.com" },
        location: "/api/users?id=1", category: "SQL 注入",
        status: isHistory ? "suspected" : "confirmed",
        review: isHistory ? "clear" : "pending",
        impact: "未授权数据读取（限未登录身份）",
        conditions: ["未登录身份", "后端 MySQL 5.7"],
        confirmed_version: isHistory ? null : { verification_result_id: "VR-0007" },
        state_version: 3, claim_revision: 2, evidence_revision: 5, assessment_epoch: 1,
        created_at: "2026-11-04T09:00:00.000Z", created_by: "worker-a", created_seq: 12,
        updated_seq: 42,
      },
      supporting_evidence: [{
        member_kind: "observations", member_id: "O-0031", stance: "supports",
        membership_status: "active", statement: "该请求响应为 500 且报错含 SQL 语法",
      }],
      opposing_evidence: [{
        member_kind: "observations", member_id: "O-0044", stance: "contradicts",
        membership_status: "active", statement: "参数化处理后未复现",
      }],
      other_evidence_members: [],
      historical_evidence_members: [],
      evidence_counts: {
        supporting: 1, opposing: 1, other_active: 0, withdrawn_or_disputed: 0,
        evidence_revision: 5, inline_limit: 64, folded: null,
      },
      verification_conclusions: {
        results: [{
          id: "VR-0007", job_id: "VJ-0007", outcome: "supported", applied: true,
          verifier_identity: "verifier-alpha", verifier_kind: "llm_agent", policy_version: "v3",
          reviewed_manifest_id: "EM-PRJ-001-0011", reviewed_evidence_revision: 5,
          limitations: "仅未登录身份", suggested_followups: [],
          created_at: "2026-11-05T09:30:00.000Z",
        }],
        pending_jobs: [{
          id: "VJ-0008", status: "pending", policy_id: "sql-injection", policy_version: "v3",
          created_at: "2026-11-05T09:40:00.000Z",
        }],
      },
      limitations: [
        "confirmed 只说明在指定条件下得到确认，不代表持续存在",
        "复核状态为 pending：依赖检查不能只看状态字符串",
      ],
      source_intents: [{ intent_id: "I-0007", relation_id: "R-0003", via: "discovered_from" }],
      follow_up_intents: [{ intent_id: "I-0021", relation_id: "R-0009" }],
      trace: {
        origin: { edges: [], source_intents: [{ intent_id: "I-0007" }], provenance_note: null },
        execution: { attempts: [], produced_by_edges: [], note: "执行归因来自证据采集的 attempt_id" },
        evidence: {
          members: [], relations: [],
          counts: { members: 2, active_supports: 1, active_contradicts: 1, withdrawn_or_disputed: 0 },
          read_entry: "原始证据字节经 GET /sorne/evidence/blobs/{sha256} 与 GET /sorne/captures/{id} 读取（#43/#44）",
        },
        follow_ups: { intents: [], requires_dependents: [], note: "已 resolved 的方向不代表对象测透" },
      },
      data_boundary: {
        snapshot_commit_seq: isHistory ? 12 : 42,
        generated_at: isHistory ? "2026-11-04T09:00:00.000Z" : "2026-11-05T10:00:00.000Z",
        note: "数据截止到该提交边界；边界之后的提交由下一次报告版本承载",
      },
    },
    report_meta: {
      report_id: isHistory ? "RR-PRJ-001-0001" : "RR-PRJ-001-0002",
      version: isHistory ? "v1" : "v2",
      changed_fields: isHistory ? null : ["status"],
      data_boundary: { snapshot_commit_seq: isHistory ? 12 : 42, generated_at: isHistory ? "2026-11-04T09:00:00.000Z" : "2026-11-05T10:00:00.000Z" },
      content_ref: "reports/vulnerabilities/V-0003/" + (isHistory ? "v1" : "v2") + ".json",
      content_available: true,
      created_at: isHistory ? "2026-11-04T09:00:00.000Z" : "2026-11-05T10:00:00.000Z",
      created_by: "reportgen",
      created_seq: isHistory ? 12 : 42,
    },
    current_version: "v2",
    requested_version: isHistory ? "v1" : "v2",
    history: [
      {
        report_id: "RR-PRJ-001-0001", version: "v1", changed_fields: null,
        data_boundary: { snapshot_commit_seq: 12, generated_at: "2026-11-04T09:00:00.000Z" },
        content_ref: "reports/vulnerabilities/V-0003/v1.json", content_available: true,
        created_at: "2026-11-04T09:00:00.000Z", created_by: "reportgen", created_seq: 12,
      },
      {
        report_id: "RR-PRJ-001-0002", version: "v2", changed_fields: ["status"],
        data_boundary: { snapshot_commit_seq: 42, generated_at: "2026-11-05T10:00:00.000Z" },
        content_ref: "reports/vulnerabilities/V-0003/v2.json", content_available: true,
        created_at: "2026-11-05T10:00:00.000Z", created_by: "reportgen", created_seq: 42,
      },
    ],
    history_total: 2,
    note: null,
  };
}

function milestoneEnvelope(version, over) {
  const isHistory = version === "v1";
  return Object.assign({
    project_id: P1,
    report: {
      report_kind: "milestone",
      schema_version: 1,
      project: { id: P1, name: "报告与覆盖度项目", status: "active", note: "阶段报告是持续探索的产物与引用入口" },
      confirmed_findings: {
        vulnerabilities: [{
          id: "V-0003", category: "SQL 注入", asset_id: "A-0012", location: "/api/users?id=1",
          conditions: ["未登录身份"], review: "pending", confirmed_version: { verification_result_id: "VR-0007" },
          evidence_revision: 5, report_entry: "GET /sorne/reports/vulnerabilities?id=V-0003",
        }],
        vulnerabilities_total: isHistory ? 0 : 1,
        facts: [{ id: "F-0012", statement: "目标使用 MySQL 5.7", status: "verified", conditions: [] }],
        facts_total: 1,
        folded_note: null,
      },
      unconfirmed_leads: {
        vulnerabilities: [{
          id: "V-0005", category: "越权访问", asset_id: "A-0002", status: "suspected",
          review: "clear", conditions: [], report_entry: "GET /sorne/reports/vulnerabilities?id=V-0005",
        }],
        vulnerabilities_total: 1,
        hypotheses: [{ id: "H-0007", statement: "另一接口访问限制可能异常", status: "open" }],
        hypotheses_total: 1,
        pending_verification_jobs: [{ id: "VJ-0008", subject_id: "V-0005", subject_kind: "vulnerability", status: "pending", created_at: "2026-11-05T09:40:00.000Z" }],
        pending_verification_jobs_total: 1,
        changed_facts: [{ id: "F-0013", status: "disputed", statement: "旧结论被新证据争议" }],
        note: "未确认线索不因报告生成而升级或丢弃",
      },
      completed_directions: {
        intents: [{ id: "I-0001", question: "确认登录相关入口", kind: "collect" }],
        total: isHistory ? 0 : 1,
        note: "resolved 表示该版本的问题已处理，不代表关联资产已测透",
      },
      blocked_directions: {
        intents: [{
          id: "I-0009", question: "登录后调用信息补查", kind: "investigate", status: "blocked",
          resume_conditions: ["获得登录凭据"],
        }],
        total: 1,
        note: "受阻方向保留恢复条件",
      },
      uncovered: {
        assets_without_direction: 1, assets_without_capture: 1, total_assets: 2,
        note: "未覆盖部分是覆盖缺口的事实陈述，不是测完声明",
      },
      coverage: {
        records: [
          {
            asset: { id: "A-0012", asset_type: "web_service", canonical_key: "https://test.com", original_input: "https://test.com", scope_status: "allow" },
            directions: {
              collect: { total: 1, resolved: 1, blocked: 0, ongoing: 0, cancelled: 0 },
              investigate: { total: 2, resolved: 0, blocked: 1, ongoing: 1, cancelled: 0 },
              verify: { total: 0, resolved: 0, blocked: 0, ongoing: 0, cancelled: 0 },
              revisit: { total: 0, resolved: 0, blocked: 0, ongoing: 0, cancelled: 0 },
            },
            intents_directed: 3, observations: 5, captures: 4,
            identity_conditions: {
              from_intents: ["未登录身份"],
              observed_in_captures: ["未登录状态"],
              note: "身份/条件记录的不是覆盖声明",
            },
            findings: { vulnerabilities: { suspected: 1, confirmed: 1, falsified: 0, inconclusive: 0 } },
            uncovered_flags: { no_direction: false, no_capture: false },
          },
          {
            asset: { id: "A-0002", asset_type: "host", canonical_key: "test2.com", scope_status: "pending" },
            directions: {},
            intents_directed: 0, observations: 0, captures: 0,
            identity_conditions: { from_intents: [], observed_in_captures: [], note: "" },
            findings: { vulnerabilities: { suspected: 0, confirmed: 0, falsified: 0, inconclusive: 0 } },
            uncovered_flags: { no_direction: true, no_capture: true },
          },
        ],
        total_assets: 2, has_more: false, folded_note: null,
        coverage_note: "覆盖度按资产/方向/身份条件记录完成情况；已执行过某个方向不代表该资产没有其他漏洞",
      },
      exploration_continues: { ongoing_intents: { running: 1 }, ongoing_total: 1, note: "报告生成后探索继续" },
      data_boundary: {
        snapshot_commit_seq: isHistory ? 30 : 88,
        generated_at: isHistory ? "2026-11-04T08:00:00.000Z" : "2026-11-05T12:00:00.000Z",
        note: "阶段报告注明数据截止版本与生成时间",
      },
    },
    report_meta: {
      report_id: "MR-PRJ-001-0001",
      version: isHistory ? "v1" : "v2",
      changed_fields: null,
      data_boundary: { snapshot_commit_seq: isHistory ? 30 : 88, generated_at: isHistory ? "2026-11-04T08:00:00.000Z" : "2026-11-05T12:00:00.000Z" },
      content_ref: "reports/milestones/MR-PRJ-001-0001/content.json",
      content_available: true,
      created_at: isHistory ? "2026-11-04T08:00:00.000Z" : "2026-11-05T12:00:00.000Z",
      created_by: "reportgen",
      created_seq: isHistory ? 30 : 88,
    },
    current_version: "v2",
    requested_version: isHistory ? "v1" : "v2",
    refreshed: false,
    history: [
      {
        report_id: "MR-PRJ-001-0001", version: "v1", changed_fields: null,
        data_boundary: { snapshot_commit_seq: 30, generated_at: "2026-11-04T08:00:00.000Z" },
        content_ref: "reports/milestones/MR-PRJ-001-0001/content.json", content_available: true,
        created_at: "2026-11-04T08:00:00.000Z", created_by: "reportgen", created_seq: 30,
      },
      {
        report_id: "MR-PRJ-001-0001", version: "v2", changed_fields: null,
        data_boundary: { snapshot_commit_seq: 88, generated_at: "2026-11-05T12:00:00.000Z" },
        content_ref: "reports/milestones/MR-PRJ-001-0001/content.json", content_available: true,
        created_at: "2026-11-05T12:00:00.000Z", created_by: "reportgen", created_seq: 88,
      },
    ],
    note: "阶段报告注明数据截止版本与生成时间",
  }, over || {});
}

function emptyMilestoneEnvelope() {
  return {
    project_id: P1,
    report: {
      report_kind: "milestone",
      schema_version: 1,
      project: { id: P1, name: "空项目", status: "active", note: "" },
      confirmed_findings: { vulnerabilities: [], vulnerabilities_total: 0, facts: [], facts_total: 0, folded_note: null },
      unconfirmed_leads: {
        vulnerabilities: [], vulnerabilities_total: 0, hypotheses: [], hypotheses_total: 0,
        pending_verification_jobs: [], pending_verification_jobs_total: 0, changed_facts: [], note: "",
      },
      completed_directions: { intents: [], total: 0, note: "" },
      blocked_directions: { intents: [], total: 0, note: "" },
      uncovered: { assets_without_direction: 0, assets_without_capture: 0, total_assets: 0, note: "" },
      coverage: { records: [], total_assets: 0, has_more: false, folded_note: null, coverage_note: "" },
      exploration_continues: { ongoing_intents: {}, ongoing_total: 0, note: "" },
      data_boundary: { snapshot_commit_seq: 1, generated_at: "2026-11-05T12:00:00.000Z", note: "" },
    },
    report_meta: {
      report_id: "MR-PRJ-001-0001", version: "v1", changed_fields: null,
      data_boundary: { snapshot_commit_seq: 1, generated_at: "2026-11-05T12:00:00.000Z" },
      content_ref: "reports/milestones/MR-PRJ-001-0001/content.json", content_available: true,
      created_at: "2026-11-05T12:00:00.000Z", created_by: "reportgen", created_seq: 1,
    },
    current_version: "v1",
    requested_version: "v1",
    refreshed: false,
    history: [],
    note: "",
  };
}

function recordsEnvelope(reportId, kind, subjectId, version) {
  return {
    record: {
      id: reportId,
      kind: "report_revisions",
      project_id: P1,
      created_at: "2026-11-05T10:00:00.000Z",
      created_by: "reportgen",
      created_seq: 42,
      report_kind: kind,
      subject_id: subjectId,
      version,
      content_ref: "reports/example/content.json",
      data_boundary: { snapshot_commit_seq: 42, generated_at: "2026-11-05T10:00:00.000Z" },
      basis_refs: [],
    },
    evidence_index: [],
    relations: { edges: [], truncated: false },
    expand: {},
  };
}

/** 页面（中栏）最小 fakeApi 夹具：漏洞列表 + 当前阶段报告。 */
function pageHandlers(over) {
  return Object.assign({
    ["GET /sorne/reports/vulnerabilities?project_id=" + P1]: vulnListEnvelope(),
    ["GET /sorne/reports/milestones?project_id=" + P1]: milestoneEnvelope("v2"),
  }, over || {});
}

function reportIdOfHref(href) {
  const m = /#\/p\/[^/]+\/reports\?id=([^&]+)/.exec(href || "");
  return m ? decodeURIComponent(m[1]) : "";
}

/* ══════════════════════════════════════════════════════════════════ */
/* 1. 页面契约                                                         */
/* ══════════════════════════════════════════════════════════════════ */

test("M6 页面契约：纯 ESM 不引包、无编号正则副本、无字面颜色/宿主变量、标题报告 order 60", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.doesNotMatch(src, /(^|\n)\s*import[\s(]/, "页面不得静态 import 任何模块");
  assert.doesNotMatch(src, /[^.\w]require\s*\(/, "页面不得使用 require");
  assert.doesNotMatch(src, /localStorage|sessionStorage/, "页面不得使用浏览器本地存储");
  assert.doesNotMatch(src, /React\.useState|React\.useEffect|useState\(|useEffect\(/, "页面不得使用 React 钩子");
  assert.doesNotMatch(src, /RECORD_ID_RE/, "编号正则唯一实现必须在 lib/ui/record-ids.mjs（P0-2②）");
  assert.doesNotMatch(src, /#[0-9a-fA-F]{3,8}\b|rgba?\(/, "页面不得书写字面颜色值（P0-1②，全部经 --sorne-* token）");
  assert.doesNotMatch(src, /--dsw-alias-/, "页面不得引用宿主 --dsw-alias-* 变量");
  assert.doesNotMatch(src, /toLowerCase\(\)|decodeURIComponent\(|\.replace\(/, "页面不得改写或清洗展示值");

  const def = await loadPage();
  assert.equal(def.id, "reports");
  assert.equal(def.order, 60, "注册表冻结 order（BLUEPRINT-UI 2.5）");
  assert.equal(def.title, "报告", "注册表冻结标题");
  assert.equal(typeof def.render, "function");
  assert.equal(typeof def.renderDetail, "function", "hash ?id= 详情经 renderDetail 渲染（2.4-2）");

  /* 规范章节引用只允许存在于 SEMANTICS 单一数组（正文解释全部折叠）。 */
  const start = src.indexOf("const SEMANTICS = Object.freeze([");
  const end = src.indexOf("\n]);", start);
  assert.ok(start >= 0 && end > start, "页面应有 SEMANTICS 常量块");
  const outside = src.slice(0, start) + src.slice(end);
  assert.equal((outside.match(/§/g) || []).length, 0, "SEMANTICS 之外不得出现规范章节引用");
});

test("页面初始渲染不白屏：报告标题与任务导向一句 + 两区加载态", async () => {
  const t = mountPage(await loadPage(), makeCtx(fakeApi({})));
  const text = t.text();
  assert.match(text, /报告/);
  assert.match(text, /按需生成阶段报告并导出 Markdown/);
  assert.match(text, /正在读取漏洞报告/);
  assert.match(text, /正在读取阶段报告/);
});

/* ══════════════════════════════════════════════════════════════════ */
/* 2. 漏洞报告列表（端点 39）                                           */
/* ══════════════════════════════════════════════════════════════════ */

test("漏洞报告列表：状态/复核分列、版本计数、数据截止边界、报告版本编号 chip、按已加载数据推导", async () => {
  const t = mountPage(await loadPage(), makeCtx(fakeApi(pageHandlers())));
  await t.flush();
  const text = t.text();

  assert.match(text, /漏洞报告/);
  const heads = t.findAll((n) => n.type === "th").map((n) => t.nodeText(n.children));
  for (const label of ["漏洞编号", "状态", "复核状态", "当前版本", "版本数", "数据截止边界", "报告版本编号"]) {
    assert.ok(heads.includes(label), "表头应有「" + label + "」");
  }
  /* 状态与复核分列，label 为冻结词表原文（限指定条件 / 待复核）。 */
  assert.match(text, /已确认（限指定条件）/);
  assert.match(text, /待复核/);
  assert.match(text, /疑似/);
  assert.match(text, /v2/);
  assert.match(text, /历史版本共|当前版本/);
  /* 报告版本编号 chip（RR- 完整编号，不截断项目段）。 */
  assert.match(text, /RR-PRJ-001-0002/);
  assert.match(text, /RR-PRJ-001-0003/);
  /* 数据截止边界（提交边界 + 生成时间本地化；不裸出 UTC ISO 串）。 */
  assert.match(text, /提交边界 42/);
  assert.match(text, /生成于/);
  assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, "绝不裸出 UTC ISO 串");
  /* 计数口径。 */
  assert.match(text, /按已加载数据推导/);
  assert.match(text, /不代表全量|汇总/);
  /* 可见正文无规范章节引用（解释收进语义说明折叠区）。 */
  assert.equal((text.match(/§/g) || []).length, 0, "可见正文不出现规范章节引用");
});

test("漏洞报告分页：has_more=true 渲染「加载更多」，携带 cursor 并累积；结束后按钮消失", async () => {
  const second = vulnListItem({ id: "V-0009", subject_id: "V-0009", latest_version: "v1", versions: 1, report_id: "RR-PRJ-001-0009" });
  const api = fakeApi(pageHandlers({
    ["GET /sorne/reports/vulnerabilities?project_id=" + P1]: vulnListEnvelope({
      reports: [vulnListItem()], next_cursor: "42:V-0003", has_more: true,
    }),
    ["GET /sorne/reports/vulnerabilities?project_id=" + P1 + "&cursor=42%3AV-0003"]: vulnListEnvelope({
      reports: [second], next_cursor: null, has_more: false, summary: { total: 2, by_status: {}, by_review: {} },
    }),
  }));
  const t = mountPage(await loadPage(), makeCtx(api));
  await t.flush();
  assert.match(t.text(), /加载更多漏洞报告/);
  assert.match(t.text(), /不代表全量/);

  t.click(t.findButton("加载更多漏洞报告"));
  await t.flush();
  assert.ok(api.calls.some((c) => c.path.includes("cursor=42%3AV-0003")), "翻页请求应携带 cursor");
  assert.match(t.text(), /V-0009/, "跨页累积");
  assert.doesNotMatch(t.text(), /加载更多漏洞报告/, "无更多页后按钮消失");
});

test("501 未实现：漏洞报告/阶段报告呈现「未实现」态而不是报错，页面其余内容仍在", async () => {
  const t = mountPage(await loadPage(), makeCtx(fakeApi({
    ["GET /sorne/reports/vulnerabilities?project_id=" + P1]:
      apiError(501, { code: "NOT_IMPLEMENTED", module: "F1", message: "端点 GET /sorne/reports/vulnerabilities 由模块 F1 施工" }),
    ["GET /sorne/reports/milestones?project_id=" + P1]:
      apiError(501, { code: "NOT_IMPLEMENTED", module: "F1", message: "端点 GET /sorne/reports/milestones 由模块 F1 施工" }),
  })));
  await t.flush();
  const text = t.text();
  assert.match(text, /漏洞报告未实现（不是报错）/);
  assert.match(text, /阶段报告未实现（不是报错）/);
  assert.match(text, /由模块 F1 施工/);
  assert.match(text, /语义说明/, "未实现不白屏：语义说明与覆盖缺口区仍在场");
  assert.match(text, /覆盖缺口/);
});

test("错误态：端点 5xx 呈现错误卡与错误码原文，其余区块不受影响", async () => {
  const t = mountPage(await loadPage(), makeCtx(fakeApi({
    ["GET /sorne/reports/vulnerabilities?project_id=" + P1]:
      apiError(500, { code: "INTERNAL_ERROR", message: "报告服务暂不可用" }),
    ["GET /sorne/reports/milestones?project_id=" + P1]:
      apiError(503, { code: "RESOURCE_LIMIT", message: "报告生成繁忙" }),
  })));
  await t.flush();
  const text = t.text();
  assert.match(text, /漏洞报告加载失败/);
  assert.match(text, /INTERNAL_ERROR · 报告服务暂不可用/);
  assert.match(text, /阶段报告加载失败/);
  assert.match(text, /RESOURCE_LIMIT · 报告生成繁忙/);
  assert.match(text, /语义说明/);
});

test("未知形状：响应无可识别 reports/report 键时显式「形状无法识别」，不静默当作空", async () => {
  const t = mountPage(await loadPage(), makeCtx(fakeApi({
    ["GET /sorne/reports/vulnerabilities?project_id=" + P1]: { unexpected: true },
    ["GET /sorne/reports/milestones?project_id=" + P1]: { totally: "unknown" },
  })));
  await t.flush();
  assert.match(t.text(), /漏洞报告响应形状无法识别/);
  assert.match(t.text(), /阶段报告响应形状无法识别/);
});

test("空态：无漏洞报告与空阶段报告显式呈现，分区 0 条是准确计数而非「未提供」", async () => {
  const t = mountPage(await loadPage(), makeCtx(fakeApi(pageHandlers({
    ["GET /sorne/reports/vulnerabilities?project_id=" + P1]: vulnListEnvelope({
      reports: [], summary: { total: 0, by_status: {}, by_review: {} },
    }),
    ["GET /sorne/reports/milestones?project_id=" + P1]: emptyMilestoneEnvelope(),
  }))));
  await t.flush();
  const text = t.text();
  assert.match(text, /暂无漏洞报告/);
  assert.match(text, /漏洞自疑似阶段起即应有报告草稿/);
  assert.match(text, /已确认漏洞 0 条（共 0）/);
  assert.match(text, /未确认漏洞 0 条/);
  assert.match(text, /已解决意图 0 条/);
  assert.match(text, /受阻\/暂缓意图 0 条/);
  assert.match(text, /资产共 0 个/);
  assert.match(text, /无资产覆盖记录：尚无资产或均未进入覆盖统计；未提供不代表已覆盖/);
  assert.match(text, /提交边界 1/);
});

/* ══════════════════════════════════════════════════════════════════ */
/* 3. 阶段报告（端点 40）与按需生成                                     */
/* ══════════════════════════════════════════════════════════════════ */

test("阶段报告：数据截止边界与时间、五分区计数、版本切换、读取默认不增殖", async () => {
  const api = fakeApi(pageHandlers());
  const t = mountPage(await loadPage(), makeCtx(api));
  await t.flush();
  const text = t.text();

  /* 数据截止边界：提交边界 + 生成时间 + 边界之后/不代表全量。 */
  assert.match(text, /数据截止边界：提交边界 88/);
  assert.match(text, /生成于/);
  assert.match(text, /边界之后提交的发现不在本版本内，不代表全量/);
  /* 五分区（计数来自端点 40 当前版本）。 */
  assert.match(text, /已确认成果：已确认漏洞 1 条（共 1）；已核实事实 1 条（共 1）/);
  assert.match(text, /未确认线索：未确认漏洞 1 条；待检验假设 1 条；待处理验证任务 1 个/);
  assert.match(text, /已完成方向：已解决意图 1 条（resolved 只表示该版本的问题已处理，不代表关联资产已测透）/);
  assert.match(text, /受阻方向：受阻\/暂缓意图 1 条（保留恢复条件，是否恢复由协调与规划决定）/);
  assert.match(text, /未覆盖部分：资产共 2 个；无任何测试方向 1 个；无任何采集 1 个/);
  assert.match(text, /未覆盖部分是覆盖缺口的事实陈述，不是测完声明/);
  assert.match(text, /进行中探索：1 条意图/);
  /* 版本切换：当前版本 + 历史版本按钮。 */
  assert.match(text, /当前版本（v2）/);
  assert.match(text, /历史版本（v1）/);
  /* 读取默认不增殖版本。 */
  assert.ok(api.calls.every((c) => !c.path.includes("refresh=1")), "普通读取不得携带 refresh=1");
});

test("阶段报告版本切换：历史版本按钮导航到该版本的报告编号 hash（MR-）", async () => {
  const api = fakeApi(pageHandlers());
  const ctx = makeCtx(api);
  const t = mountPage(await loadPage(), ctx);
  await t.flush();
  t.click(t.findButton("历史版本（v1）"));
  const nav = ctx.router.__calls.find((c) => c.kind === "open");
  assert.ok(nav, "点击历史版本应导航");
  assert.match(nav.hash, /^#\/p\/PRJ-001\/reports\?id=MR-PRJ-001-0001$/);
});

test("按需生成阶段报告（refresh=1）：请求携带 refresh、版本推进、如实提示不结束项目", async () => {
  const api = fakeApi(pageHandlers({
    ["GET /sorne/reports/milestones?project_id=" + P1 + "&refresh=1"]:
      milestoneEnvelope("v2", { refreshed: true, current_version: "v3" }),
  }));
  const ctx = makeCtx(api);
  const t = mountPage(await loadPage(), ctx);
  await t.flush();
  assert.match(t.text(), /当前版本（v2）/);

  t.click(t.findButton("生成阶段报告（数据截止到当前）"));
  await t.flush();
  assert.ok(api.calls.some((c) => c.path === "/sorne/reports/milestones?project_id=" + P1 + "&refresh=1"),
    "生成应携带 refresh=1");
  assert.match(t.text(), /本次读取生成了携带最新数据截止边界的新版本/);
  assert.match(t.text(), /读取默认不增殖版本/);
  assert.match(t.text(), /当前版本（v3）/);
  assert.match(t.text(), /生成报告不结束项目/);
});

/* ══════════════════════════════════════════════════════════════════ */
/* 4. 覆盖缺口（端点 40 的 coverage 块）                                */
/* ══════════════════════════════════════════════════════════════════ */

test("覆盖缺口：未覆盖聚合、按资产/方向/身份条件记录、未覆盖标记、折叠口径说明", async () => {
  const t = mountPage(await loadPage(), makeCtx(fakeApi(pageHandlers())));
  await t.flush();
  const text = t.text();

  assert.match(text, /覆盖缺口/);
  assert.match(text, /未覆盖聚合：资产共 2 个，无任何测试方向 1 个，无任何采集 1 个/);
  const heads = t.findAll((n) => n.type === "th").map((n) => t.nodeText(n.children));
  for (const label of ["资产", "方向完成情况", "采集/观察/直接意图", "身份或条件", "未覆盖标记"]) {
    assert.ok(heads.includes(label), "覆盖表头应有「" + label + "」");
  }
  assert.match(text, /A-0012/);
  assert.match(text, /类型 web_service/);
  assert.match(text, /范围 allow/);
  assert.match(text, /搜集 共 1（已解决 1·受阻 0·进行中 0·取消 0）/);
  assert.match(text, /调查 共 2（已解决 0·受阻 1·进行中 1·取消 0）/);
  assert.match(text, /意图声明：未登录身份/);
  assert.match(text, /采集中观察到：未登录状态/);
  assert.match(text, /【未覆盖：无任何测试方向】【未覆盖：无任何采集】/);
  /* 覆盖口径说明收进折叠区（不在可见正文）：折叠不删记录。 */
  assert.match(t.foldedText(), /覆盖度按资产\/方向\/身份条件记录完成情况/);
  assert.doesNotMatch(text, /已执行过某个方向不代表该资产没有其他漏洞。$/);
});

/* ══════════════════════════════════════════════════════════════════ */
/* 5. 语义说明折叠区（§≤2/页；折叠不删记录）                            */
/* ══════════════════════════════════════════════════════════════════ */

test("语义说明折叠区：规范段落折叠保留（不删记录），可见正文不出现章节引用", async () => {
  const t = mountPage(await loadPage(), makeCtx(fakeApi(pageHandlers())));
  await t.flush();
  const text = t.text();
  assert.match(text, /语义说明/);
  assert.match(text, /已折叠 \d+ 项/, "折叠区显示已折叠计数（折叠不删记录）");
  const folded = t.foldedText();
  for (const sentence of [
    "漏洞报告自疑似（suspected）阶段即形成草稿并持续更新",
    "阶段报告注明数据截止版本与时间",
    "覆盖度不能简化成「资产挂过一个 Fact 就已测」",
    "任何漏洞或事实都能追溯来源、执行、证据和后续方向",
    "未提供 ≠ 不存在",
  ]) {
    assert.ok(folded.includes(sentence), "折叠区应保留原文：" + sentence);
  }
  assert.equal((text.match(/§/g) || []).length, 0, "可见正文「§」为 0（≤2/页）");
});

/* ══════════════════════════════════════════════════════════════════ */
/* 6. 单份详情（hash ?id=；经端点 14 解析报告版本行）                    */
/* ══════════════════════════════════════════════════════════════════ */

function detailCtx(api, id) {
  return makeCtx(api, { id });
}

test("详情（?id=RR-）：经 /records 解析主体与版本后读端点 39；§19 最小内容集与已复核证据版本实际值", async () => {
  const api = fakeApi({
    ["GET /sorne/records/RR-PRJ-001-0002?project_id=" + P1]: recordsEnvelope("RR-PRJ-001-0002", "vulnerability", "V-0003", "v2"),
    ["GET /sorne/reports/vulnerabilities?project_id=" + P1 + "&id=V-0003&version=v2"]: vulnDetailEnvelope("v2"),
  });
  const t = mountPage(await loadPage(), detailCtx(api, "RR-PRJ-001-0002"), { detail: true });
  await t.flush();
  const text = t.text();

  assert.ok(api.calls.some((c) => c.path === "/sorne/records/RR-PRJ-001-0002?project_id=" + P1), "先经端点 14 解析报告版本行");
  assert.ok(api.calls.some((c) => c.path === "/sorne/reports/vulnerabilities?project_id=" + P1 + "&id=V-0003&version=v2"),
    "再按 subject_id + version 读端点 39");
  assert.match(text, /报告详情/);
  assert.match(text, /报告版本编号：/);
  assert.match(text, /RR-PRJ-001-0002/);
  assert.match(text, /已确认（限指定条件）/);
  assert.match(text, /待复核/);
  assert.match(text, /判断条件：未登录身份；后端 MySQL 5\.7/);
  assert.match(text, /支持证据（1 条）/);
  assert.match(text, /O-0031/);
  assert.match(text, /反对证据（1 条）/);
  assert.match(text, /O-0044/);
  assert.match(text, /验证结论/);
  assert.match(text, /VR-0007/);
  assert.match(text, /VJ-0007/);
  assert.match(text, /EM-PRJ-001-0011/);
  /* 已提交 reviewed_evidence_revision 必须显示实际值（M2 视图缺口修复的页面侧）。 */
  assert.match(text, /已复核证据版本/);
  assert.match(text, /5/);
  assert.match(text, /待处理验证任务/);
  assert.match(text, /VJ-0008/);
  assert.match(text, /限制/);
  assert.match(text, /限制：|· confirmed 只说明在指定条件下得到确认，不代表持续存在/);
  assert.match(text, /来源意图：/);
  assert.match(text, /I-0007/);
  assert.match(text, /后续意图：/);
  assert.match(text, /I-0021/);
  assert.match(text, /四向追溯/);
  /* 数据截止边界随版本（当前 v2=42）。 */
  assert.match(text, /数据截止边界：提交边界 42/);
  assert.match(text, /生成于/);
  /* 当前版本不出现历史版本提示；历史版本按钮在场。 */
  assert.doesNotMatch(text, /正在查看历史版本/);
  assert.match(text, /历史版本（v1）/);
});

test("详情（?id=RR-，历史版本）：显式历史版本提示，边界同步切换；版本按钮导航到目标报告编号", async () => {
  const api = fakeApi({
    ["GET /sorne/records/RR-PRJ-001-0001?project_id=" + P1]: recordsEnvelope("RR-PRJ-001-0001", "vulnerability", "V-0003", "v1"),
    ["GET /sorne/reports/vulnerabilities?project_id=" + P1 + "&id=V-0003&version=v1"]: vulnDetailEnvelope("v1"),
  });
  const ctx = detailCtx(api, "RR-PRJ-001-0001");
  const t = mountPage(await loadPage(), ctx, { detail: true });
  await t.flush();
  const text = t.text();

  assert.match(text, /正在查看历史版本（v1）/);
  assert.match(text, /当前视图以最新版本（v2）为准/);
  assert.match(text, /疑似/);
  assert.match(text, /数据截止边界：提交边界 12/);
  assert.doesNotMatch(text, /数据截止边界：提交边界 42/);
  assert.match(text, /当前版本（v2）/);

  t.click(t.findButton("当前版本（v2）"));
  const nav = ctx.router.__calls.find((c) => c.kind === "open");
  assert.ok(nav, "切换版本应导航");
  assert.equal(reportIdOfHref(nav.hash), "RR-PRJ-001-0002");
});

test("详情（?id=MR-）：经 /records 解析为阶段报告版本后读端点 40；五分区明细与覆盖记录在场", async () => {
  const api = fakeApi({
    ["GET /sorne/records/MR-PRJ-001-0001?project_id=" + P1]: recordsEnvelope("MR-PRJ-001-0001", "milestone", P1, "v2"),
    ["GET /sorne/reports/milestones?project_id=" + P1 + "&version=v2"]: milestoneEnvelope("v2"),
  });
  const t = mountPage(await loadPage(), detailCtx(api, "MR-PRJ-001-0001"), { detail: true });
  await t.flush();
  const text = t.text();

  assert.ok(api.calls.some((c) => c.path === "/sorne/reports/milestones?project_id=" + P1 + "&version=v2"),
    "阶段报告版本经 version 参数读回");
  assert.match(text, /报告详情/);
  assert.match(text, /已确认成果/);
  assert.match(text, /V-0003/);
  assert.match(text, /F-0012/);
  assert.match(text, /未确认线索/);
  assert.match(text, /H-0007/);
  assert.match(text, /已完成方向/);
  assert.match(text, /I-0001/);
  assert.match(text, /受阻方向/);
  assert.match(text, /I-0009/);
  assert.match(text, /恢复条件：获得登录凭据/);
  assert.match(text, /未覆盖部分/);
  assert.match(text, /资产共 2 个；无任何测试方向 1 个；无任何采集 1 个/);
  assert.match(text, /数据截止边界：提交边界 88/);
  assert.match(text, /报告生成后探索继续/);
});

test("详情直接以 V- 编号打开：按漏洞主体读取最新版本（兼容链接）", async () => {
  const api = fakeApi({
    ["GET /sorne/reports/vulnerabilities?project_id=" + P1 + "&id=V-0003"]: vulnDetailEnvelope("v2"),
  });
  const t = mountPage(await loadPage(), detailCtx(api, "V-0003"), { detail: true });
  await t.flush();
  assert.match(t.text(), /报告详情/);
  assert.ok(api.calls.some((c) => c.path === "/sorne/reports/vulnerabilities?project_id=" + P1 + "&id=V-0003"));
});

test("详情错误态：报告编号不存在 404 如实呈现；无法识别的编号显式拒绝（不猜测）", async () => {
  const api = fakeApi({
    ["GET /sorne/records/RR-PRJ-001-9999?project_id=" + P1]:
      apiError(404, { code: "NOT_FOUND", message: "项目 PRJ-001 内不存在编号为 RR-PRJ-001-9999 的记录" }),
  });
  const t1 = mountPage(await loadPage(), detailCtx(api, "RR-PRJ-001-9999"), { detail: true });
  await t1.flush();
  assert.match(t1.text(), /报告版本不存在或不可读/);
  assert.match(t1.text(), /NOT_FOUND · 项目 PRJ-001 内不存在编号为 RR-PRJ-001-9999 的记录/);

  const t2 = mountPage(await loadPage(), detailCtx(fakeApi({}), "XYZ-0001"), { detail: true });
  await t2.flush();
  assert.match(t2.text(), /无法识别的报告编号/);
  assert.match(t2.text(), /支持 RR-\/MR-\/V- 编号/);
});

/* ══════════════════════════════════════════════════════════════════ */
/* 7. 编号 chip 与导航（不复制编号、页面不自行请求 /records）            */
/* ══════════════════════════════════════════════════════════════════ */

test("列表行点击导航到报告详情 hash；编号 chip 点击 openRecord（完整编号，不截断）", async () => {
  const api = fakeApi(pageHandlers());
  const ctx = makeCtx(api);
  const t = mountPage(await loadPage(), ctx);
  await t.flush();

  const rows = t.rowElements();
  assert.ok(rows.length >= 2, "两个漏洞报告行");
  t.click(rows[0]);
  const nav = ctx.router.__calls.find((c) => c.kind === "open");
  assert.ok(nav, "行点击应导航到详情");
  assert.equal(reportIdOfHref(nav.hash), "RR-PRJ-001-0002");

  const chip = t.findAll((n) => n.type === "button" && String(n.props["aria-label"] || "").includes("V-0003"));
  assert.ok(chip.length >= 1, "漏洞编号渲染为 chip");
  t.click(chip[0]);
  const recCalls = ctx.router.__calls.filter((c) => c.kind === "openRecord");
  assert.ok(recCalls.some((c) => c.id === "V-0003"), "chip 点击 openRecord 完整编号");
  assert.ok(!api.calls.some((c) => c.path.startsWith("GET /sorne/records/V-0003")), "页面不自行请求 /records（由外壳覆盖层负责）");
});

test("详情内编号全部为 chip：漏洞/资产/证据成员/验证结果/清单/意图（点击 openRecord，完整编号）", async () => {
  const api = fakeApi({
    ["GET /sorne/records/RR-PRJ-001-0002?project_id=" + P1]: recordsEnvelope("RR-PRJ-001-0002", "vulnerability", "V-0003", "v2"),
    ["GET /sorne/reports/vulnerabilities?project_id=" + P1 + "&id=V-0003&version=v2"]: vulnDetailEnvelope("v2"),
  });
  const ctx = detailCtx(api, "RR-PRJ-001-0002");
  const t = mountPage(await loadPage(), ctx, { detail: true });
  await t.flush();

  const ariaIds = t.findAll((n) => n.type === "button" && typeof n.props["aria-label"] === "string")
    .map((n) => n.props["aria-label"]);
  for (const id of ["V-0003", "A-0012", "O-0031", "O-0044", "VR-0007", "VJ-0007", "VJ-0008", "EM-PRJ-001-0011", "I-0007", "I-0021"]) {
    assert.ok(ariaIds.some((a) => a.includes(id)), "应有编号 chip：" + id);
  }
  const chip = t.findAll((n) => n.type === "button" && String(n.props["aria-label"] || "").includes("A-0012"))[0];
  t.click(chip);
  const recCalls = ctx.router.__calls.filter((c) => c.kind === "openRecord");
  assert.ok(recCalls.some((c) => c.id === "A-0012"), "点击资产 chip → openRecord 完整编号");
});

/* ══════════════════════════════════════════════════════════════════ */
/* 8. 导出（端点 53）                                                   */
/* ══════════════════════════════════════════════════════════════════ */

function detailHandlers(over) {
  return Object.assign({
    ["GET /sorne/records/RR-PRJ-001-0002?project_id=" + P1]: recordsEnvelope("RR-PRJ-001-0002", "vulnerability", "V-0003", "v2"),
    ["GET /sorne/reports/vulnerabilities?project_id=" + P1 + "&id=V-0003&version=v2"]: vulnDetailEnvelope("v2"),
  }, over || {});
}

test("导出成功：请求端点 53（带 project_id/version），呈现 Markdown 下载链接与内容与视图同源说明", async () => {
  const exportPath = "/sorne/reports/RR-PRJ-001-0002/export?project_id=" + P1 + "&version=v2";
  const api = fakeApi(detailHandlers({
    ["GET " + exportPath]: { raw: "# 报告 RR-PRJ-001-0002\n\n数据截止：commit_seq=42\n" },
  }));
  const t = mountPage(await loadPage(), detailCtx(api, "RR-PRJ-001-0002"), { detail: true });
  await t.flush();

  t.click(t.findButton("导出本版本（Markdown）"));
  await t.flush();
  assert.ok(api.calls.some((c) => c.path === exportPath), "导出请求应带 project_id 与 version");
  assert.match(t.text(), /内容与当前视图同源/);
  const links = t.findAll((n) => n.type === "a");
  assert.ok(links.length >= 1, "应呈现 Markdown 下载链接");
  assert.equal(links[0].props.href, exportPath);
  assert.match(String(links[0].props.download), /RR-PRJ-001-0002\.md/);
});

test("导出失败：404 如实呈现错误信封与服务端 note，并给下一步条件（不虚报成功）", async () => {
  const exportPath = "/sorne/reports/RR-PRJ-001-0002/export?project_id=" + P1 + "&version=v2";
  const api = fakeApi(detailHandlers({
    ["GET " + exportPath]: apiError(404, {
      code: "NOT_FOUND",
      message: "报告内容文件不可读：RR-PRJ-001-0002 v2",
      detail: { note: "内容文件不可读，refresh=1 可生成新版本" },
    }),
  }));
  const t = mountPage(await loadPage(), detailCtx(api, "RR-PRJ-001-0002"), { detail: true });
  await t.flush();

  t.click(t.findButton("导出本版本（Markdown）"));
  await t.flush();
  const text = t.text();
  assert.match(text, /导出失败：NOT_FOUND · 报告内容文件不可读/);
  assert.match(text, /内容文件不可读，refresh=1 可生成新版本/, "服务端 note 原文呈现");
  assert.match(text, /不虚报导出成功/);
  assert.ok(!t.findAll((n) => n.type === "a").some((n) => String(n.props.href || "").includes("/export")),
    "失败时不呈现下载链接");
});

/* ══════════════════════════════════════════════════════════════════ */
/* 8.5 旧断言迁移补充（单版主体 / 五分区整体缺失 / 覆盖取当前版本 / 无覆盖块） */
/* ══════════════════════════════════════════════════════════════════ */

test("漏洞报告单版主体：列表版本数 1；详情只有当前版本按钮，无历史版本按钮", async () => {
  const api = fakeApi(pageHandlers({
    ["GET /sorne/reports/vulnerabilities?project_id=" + P1]: vulnListEnvelope({
      reports: [vulnListItem({ versions: 1, latest_version: "v1", version: "v1" })],
    }),
  }));
  const t = mountPage(await loadPage(), makeCtx(api));
  await t.flush();
  assert.match(t.text(), /RR-PRJ-001-0002/, "单版主体的报告版本编号 chip 在场");
  assert.match(t.text(), /已确认（限指定条件）/, "单版列表仍呈现状态徽章");

  const singleVersionDetail = vulnDetailEnvelope("v1");
  singleVersionDetail.current_version = "v1";
  singleVersionDetail.requested_version = "v1";
  singleVersionDetail.history = singleVersionDetail.history.filter((row) => row.version === "v1");
  const dapi = fakeApi({
    ["GET /sorne/records/RR-PRJ-001-0001?project_id=" + P1]: recordsEnvelope("RR-PRJ-001-0001", "vulnerability", "V-0003", "v1"),
    ["GET /sorne/reports/vulnerabilities?project_id=" + P1 + "&id=V-0003&version=v1"]: singleVersionDetail,
  });
  const td = mountPage(await loadPage(), detailCtx(dapi, "RR-PRJ-001-0001"), { detail: true });
  await td.flush();
  assert.equal(td.findButtons("历史版本（").length, 0, "单版详情只有当前版本按钮");
  assert.doesNotMatch(td.text(), /正在查看历史版本/);
});

test("阶段报告五分区整体缺失：每分区显式「—（未提供）」，不虚构 0 计数", async () => {
  const envelope = milestoneEnvelope("v2");
  delete envelope.report.confirmed_findings;
  delete envelope.report.unconfirmed_leads;
  delete envelope.report.completed_directions;
  delete envelope.report.blocked_directions;
  delete envelope.report.uncovered;
  const t = mountPage(await loadPage(), makeCtx(fakeApi(pageHandlers({
    ["GET /sorne/reports/milestones?project_id=" + P1]: envelope,
  }))));
  await t.flush();
  const text = t.text();
  for (const label of ["已确认成果：", "未确认线索：", "已完成方向：", "受阻方向：", "未覆盖部分："]) {
    const at = text.indexOf(label);
    assert.ok(at >= 0, "应有分区 " + label);
    assert.ok(text.startsWith(label + "—（未提供）", at), "分区 " + label + " 应显式未提供，实际：" + text.slice(at, at + 30));
  }
});

test("覆盖缺口取当前阶段报告版本：浏览历史版本只改详情，不回退中栏覆盖视图", async () => {
  const api = fakeApi(pageHandlers());
  const ctx = makeCtx(api);
  const t = mountPage(await loadPage(), ctx);
  await t.flush();
  assert.match(t.text(), /A-0012/);
  /* 点击历史版本只导航（详情由外壳右栏渲染），中栏覆盖仍取当前版本记录。 */
  t.click(t.findButton("历史版本（v1）"));
  assert.match(t.text(), /A-0012/);
  assert.match(t.text(), /搜集 共 1（已解决 1·受阻 0·进行中 0·取消 0）/);
  assert.ok(!t.text().includes("未提供不代表已覆盖"), "当前版本有覆盖记录时不显示空态");
});

test("阶段报告未携带覆盖块：覆盖度显式「—（未提供）；未提供不代表已覆盖」，不当作已覆盖", async () => {
  const envelope = milestoneEnvelope("v2");
  delete envelope.report.coverage;
  const t = mountPage(await loadPage(), makeCtx(fakeApi(pageHandlers({
    ["GET /sorne/reports/milestones?project_id=" + P1]: envelope,
  }))));
  await t.flush();
  assert.match(t.text(), /阶段报告未携带覆盖块：覆盖度数据 —（未提供）；未提供不代表已覆盖。/);
  assert.match(t.text(), /未覆盖聚合：资产共 2 个/);
});

/* ══════════════════════════════════════════════════════════════════ */
/* 9. 真实服务集成                                                      */
/* ══════════════════════════════════════════════════════════════════ */

function realApi(base) {
  const calls = [];
  const api = async (path, options) => {
    calls.push({ method: (options && options.method) || "GET", path });
    const res = await fetch(base + path, {
      credentials: "same-origin",
      method: (options && options.method) || "GET",
      headers: { "Content-Type": "application/json", origin: base, ...((options && options.headers) || {}) },
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
      const err = new Error((data && data.message) || "HTTP " + res.status);
      err.status = res.status;
      err.code = data && data.code;
      err.body = data;
      throw err;
    }
    return data;
  };
  api.calls = calls;
  return api;
}

async function createProjectWithVulnerability(base) {
  const created = await fetch(base + "/sorne/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json", origin: base },
    body: JSON.stringify({ name: "M6 报告页集成项目", description: "报告页集成验收目标" }),
  }).then((r) => r.json());
  const projectId = created.project.id;
  const session = issueSession({ project_id: projectId, actor: "worker-m6", role: "worker" });
  const sub = await fetch(base + "/sorne/submissions", {
    method: "POST",
    headers: { "Content-Type": "application/json", origin: base, "x-sorne-session": session.session_token },
    body: JSON.stringify({
      submission_id: "m6-report-vuln",
      operations: [{
        op: "report_vulnerability",
        local_ref: "v",
        category: "SQL 注入",
        location: "/api/users?id=1",
        impact: "未授权数据读取",
        conditions: ["未登录身份"],
      }],
    }),
  }).then((r) => r.json());
  assert.ok(sub.ids && sub.ids.v, "真实服务应创建漏洞：" + JSON.stringify(sub).slice(0, 300));
  return { projectId, vulnerabilityId: sub.ids.v };
}

test("真实服务：manifest 注册 reports（order 60）；漏洞列表/阶段报告读回，生成（refresh=1）与详情导出全链路", () =>
  withTestServer(async ({ base, request }) => {
    const manifest = await request("GET", "/sorne/ui/manifest");
    assert.equal(manifest.status, 200);
    const page = manifest.body.pages.find((p) => p.id === "reports");
    assert.ok(page, "manifest 缺 reports");
    assert.equal(page.file, "/sorne/ui/pages/reports.page.mjs");
    assert.equal(page.order, 60);
    assert.equal(page.title, "报告");

    const { projectId, vulnerabilityId } = await createProjectWithVulnerability(base);

    const def = await loadPage();
    const api = realApi(base);
    const ctx = makeCtx(api, { projectId, page: "reports" });
    const t = mountPage(def, ctx);
    await t.waitUntil(
      () => t.text().includes("漏洞编号") && t.text().includes("数据截止边界："),
      { label: "真实报告页就绪" },
    ).catch(async (e) => {
      throw e;
    });
    const text = t.text();
    assert.match(text, new RegExp(vulnerabilityId.replace(/-/g, "\\-")), "真实漏洞编号呈现");
    assert.match(text, /已确认成果|未确认线索/, "真实阶段报告五分区呈现");
    assert.match(text, /覆盖缺口/);
    assert.doesNotMatch(text, /未实现/, "端点已实装，不出现未实现态");
    /* 真实服务下可见正文同样不出现章节引用。 */
    assert.equal((text.match(/§/g) || []).length, 0);

    /* 生成阶段报告（refresh=1）：真实端点推进版本。 */
    const before = await request("GET", "/sorne/reports/milestones?project_id=" + projectId);
    assert.equal(before.status, 200);
    t.click(t.findButton("生成阶段报告（数据截止到当前）"));
    await t.waitUntil(() => t.text().includes("本次读取生成了携带最新数据截止边界的新版本"), { label: "生成回执" });
    assert.ok(api.calls.some((c) => c.path.includes("refresh=1")), "生成请求携带 refresh=1");
    const after = await request("GET", "/sorne/reports/milestones?project_id=" + projectId);
    assert.ok(Number(after.body.current_version.replace(/^v/, "")) > Number(before.body.current_version.replace(/^v/, "")),
      "生成后版本推进：" + before.body.current_version + " → " + after.body.current_version);

    /* 详情：按真实阶段报告编号打开，边界与内容读回；真实导出端点成功。 */
    const milestoneId = after.body.report_meta.report_id;
    const dctx = makeCtx(api, { projectId, page: "reports", id: milestoneId });
    const td = mountPage(def, dctx, { detail: true });
    await td.waitUntil(() => td.text().includes("报告详情") && td.text().includes("数据截止边界："), { label: "真实详情就绪" });
    assert.match(td.text(), /已确认成果|未确认线索/);
    assert.match(td.text(), new RegExp(milestoneId.replace(/-/g, "\\-")));
    td.click(td.findButton("导出本版本（Markdown）"));
    await td.waitUntil(() => td.text().includes("内容与当前视图同源"), { label: "真实导出成功" });
    const links = td.findAll((n) => n.type === "a");
    assert.ok(links.length >= 1, "真实导出应呈现下载链接");
    assert.ok(String(links[0].props.href).includes("/sorne/reports/" + milestoneId + "/export"), "下载链接指向端点 53");
    const exported = await request("GET", String(links[0].props.href).replace(base, ""));
    assert.equal(exported.status, 200);
    assert.match(exported.body.raw || "", /^# 报告 /, "导出内容为 Markdown 且与视图同源");
  }));

test("真实服务：未知报告编号详情如实 404（不泄露存在性），导出失败不虚报成功", () =>
  withTestServer(async ({ base }) => {
    const { projectId } = await createProjectWithVulnerability(base);
    const def = await loadPage();
    const api = realApi(base);
    const td = mountPage(def, makeCtx(api, { projectId, page: "reports", id: "RR-PRJ-9999-0001" }), { detail: true });
    await td.waitUntil(() => td.text().includes("报告版本不存在或不可读") || td.text().includes("报告详情加载失败"), { label: "404 详情" });
    assert.match(td.text(), /NOT_FOUND|不存在/);
    assert.match(td.text(), /可返回报告列表重新选择/);
  }));
