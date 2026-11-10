/**
 * 页面：工作台（lib/ui/pages/workbench.page.mjs；M4 独占新增；BLUEPRINT-UI §1.4/§e J1·J2·J4·J5·J6/§g）。
 *
 * 只回答一个问题：现在发生了什么、我需要做什么（要求 §4）。三区结构：
 *   ① 正在做什么——当前方向（#31 intents.active）、活跃 Attempt（#23）、最新进展（#45 事件流）；
 *   ② 得到了什么——重要新发现（#31 important_findings：疑似漏洞/假设+原始状态）与近期新增记录
 *      （按已加载事件推导，标注不代表全量）；
 *   ③ 需要我做什么——受阻方向与缺什么（#31 blocked_detail/resume_conditions）、待验证
 *      （#29 队列与最长等待）、待澄清与未处理汇报（#31 pending_items/pending_reports，
 *      点击进右栏 renderDetail ?id=WR-…）。
 *
 * 顶部：「4 张卡（项目状态/探索进展/待你处理/系统健康）+ 6 项指标」。指标全部来自
 * #31/#23/#29/#45/#47/#49 的聚合字段——原始 /metrics JSON 不进工作台（归系统诊断页，
 * 避免把数据库铺在屏幕上）。
 *
 * 进展条（J1，§2.6-3 冻结映射）：已接收目标 / 正在读取已有信息 / 正在制定计划 /
 * 已分配任务 / 持续探索中 / 失败——每段用一个真实记录事实判定并在段内写明证据
 * （规划请求数、planner_view 投影滞后、意图/尝试计数、提交边界、计划接收状态），
 * 读取失败显示失败原因，不假进度、不转圈。
 *
 * 对话区（J4/J5）：输入 + POST /sorne/messages（#46），列表 GET /sorne/messages（#47）；
 * 每条用户消息呈现「已接收 → 对应任务 → AI 处理结果」三段（不是孤立气泡），
 * 状态 received/processing/handled/failed 原样呈现且收到（delivered）≠ 已处理（handled）；
 * 关联任务以编号 chip 呈现（决定/意图/尝试/验证任务/汇报），点击经 record-ids 唯一实现
 * 打开记录覆盖层。附件可选：先经 #11/#12 上传取得 B-/CAP- 编号，再随消息以
 * attachments 提交（kind=blob|capture）。
 *
 * 暂停反馈（J6）：项目状态为 paused 且仍有活跃 Attempt 时显示「正在暂停，仍有 N 个
 * 收尾中的操作（活跃 Attempt 数，来自 #23）」；归零后转「已暂停（无收尾中的操作）」——
 * 不点击后假装全部停止。暂停/继续按钮在冻结外壳顶栏（M1）；本页只如实呈现过渡态。
 *
 * 右侧详情（renderDetail，§2.4-2）：hash ?id= 为汇报编号（WR-…）时渲染三层汇报
 * （交接卡 → 关键记录层 → 完整依据层，按需请求 #38）、基线 base_report 下钻、
 * relative_to_base、boundary（Manifest/提交边界/项目当前边界）、分页与 omitted 分区；
 * 其它编号的详情由外壳记录覆盖层承担（本页给「打开记录」入口，不重复实现第二套）。
 *
 * 语义纪律（冻结原文，全部经语义说明折叠区或正文原样呈现）：
 *   - confirmed 永远带「（限指定条件）」；insufficient「证据不足：未确认，不伪装成已排除」；
 *     falsified「不等于历史上不存在」（状态徽章由 VOCAB 提供冻结原文，本页不另写）；
 *   - delivered ≠ handled；未提供 ≠ 不存在（「—（未提供）」）；
 *   - resolved 只表示该版本的问题已处理，不代表关联资产已测透（规范 §10.1）；
 *     恢复与重派由协调 AI 决定，程序不写死固定重试（规范 §3.1/§3.2）；
 *     同项目默认最多一个规划调用在途（§16.1）；九态计数以库为准（§10.1）；
 *   - 每个数据面标注数据时刻与「按已加载数据推导，不代表全量」；
 *     501 未实现 ≠ 报错（呈现「未实现」态）；每页正文 § 引用 ≤ 2（解释收进折叠区）。
 *
 * 页面契约（§2.5）：纯 ESM、不 import 任何包或 Node 内置模块、不用浏览器本地存储、
 * 无 React 钩子、无字面颜色值（全部经 --sorne-* token）、中文；
 * export default { id, title, order, render(ctx), renderDetail(ctx) }；
 * ctx = { React, h, api, router, ui, theme }；有状态部分收敛为 React.Component 子类，
 * 路由变化经 router.onChange 订阅（外壳 keep-alive：切走隐藏、切回原样恢复）。
 */

/* ── 小工具（样式/错误/标签；不含任何编号正则——编号解析唯一实现在 record-ids） ── */

function btnStyle(variant, disabled) {
  const base = {
    fontSize: 13, padding: "5px 12px", borderRadius: 6,
    border: "1px solid var(--sorne-border-strong)",
    background: "var(--sorne-bg-surface)", color: "var(--sorne-text-primary)",
    fontFamily: "inherit", lineHeight: 1.55,
  };
  if (variant === "primary") {
    base.background = "var(--sorne-brand)";
    base.color = "var(--sorne-on-brand)";
    base.borderColor = "var(--sorne-brand)";
  }
  if (variant === "quiet") {
    base.border = "1px solid transparent";
    base.background = "transparent";
    base.color = "var(--sorne-text-secondary)";
  }
  if (disabled) {
    base.opacity = 0.55;
    base.cursor = "default";
  } else {
    base.cursor = "pointer";
  }
  return base;
}

function errorMessage(e) {
  const err = e || {};
  const msg = err.message ? String(err.message) : String(err);
  return err.code ? err.code + " · " + msg : msg;
}

function isNotImplemented(e) {
  return Boolean(e && (e.code === "NOT_IMPLEMENTED" || e.status === 501));
}

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** 计数缺省呈现：未提供而不是 0（未提供 ≠ 不存在）。 */
function numText(v) {
  const n = num(v);
  return n === null ? "—（未提供）" : String(n);
}

/** 模型两层状态：configured（配了没）× reachable（连得上没）。 */
function llmStatusText(llm) {
  if (!llm) return "模型 —";
  if (llm.configured !== true) return "模型未配置";
  if (llm.needs_user) return "模型需更新凭据";
  if (llm.reachable === false) {
    const kind = llm.last_error_kind ? "（" + llm.last_error_kind + "）" : "";
    return "模型暂不可用" + kind;
  }
  if (llm.reachable !== true) return "模型已配置，连通性未验证";
  return "模型可用";
}

/** 词表标签（VOCAB 未登记的字段用本页局部映射，未知值原样呈现）。 */
const REPORT_KIND_TEXT = Object.freeze({
  progress: "进展汇报", handoff: "交接汇报", blocked: "受阻汇报", completion: "完成汇报",
});
const REPORT_HANDLING_TEXT = Object.freeze({
  pending: "待处理（pending）", handled: "已处理（handled）",
  needs_clarification: "需补充说明（needs_clarification）", deferred: "已暂缓（deferred）",
});
const MESSAGE_STATUS_TEXT = Object.freeze({
  received: "已接收（尚未处理）", processing: "处理中",
  handled: "已处理（handled；决定已持久化）", failed: "处理失败",
});
const MESSAGE_DIRECTION_TEXT = Object.freeze({ user: "你", ai: "AI" });
const LINK_KIND_TEXT = Object.freeze({
  intent: "意图", attempt: "尝试", orchestration_decision: "决定",
  verification_job: "验证任务", worker_report: "汇报", blob: "证据字节", capture: "采集",
});
/** 意图类别（VOCAB 未登记 intent_kind；未知值原样呈现）。 */
const INTENT_KIND_TEXT = Object.freeze({
  collect: "采集", investigate: "调查", verify: "验证", revisit: "回访",
});
const PLAN_RECEIVED_TEXT = Object.freeze({
  pending: "待定（pending）", accepted: "已接收（accepted）",
  partial: "部分接收（partial）", rejected: "已拒绝（rejected）", suspended: "已挂起（suspended）",
});
const STAGE_STATE_TEXT = Object.freeze({
  done: "已完成", current: "进行中", pending: "未开始", failed: "失败",
});

/** 模块级 VOCAB 引用（render 时注入，避免页面文件 import）。 */
let VOCAB_REF = null;

function vocabLabel(vocabKey, value) {
  const vocab = VOCAB_REF && VOCAB_REF[vocabKey] ? VOCAB_REF[vocabKey] : null;
  if (!vocab) return value === null || value === undefined || value === "" ? "未提供" : String(value);
  const entry = Object.prototype.hasOwnProperty.call(vocab, value) ? vocab[value] : null;
  return entry && entry.label ? entry.label : (value === null || value === undefined || value === "" ? "未提供" : String(value));
}

/**
 * 文本中的完整编号 → 编号 chip 混排（编号解析唯一实现经 ui.parseRecordId；
 * 本页不做任何编号模式匹配：按分隔符切分后整体交解析器，失败片段原样保留）。
 */
function textWithChips(text, ui, router, projectId) {
  const raw = text === null || text === undefined ? "" : String(text);
  if (!raw) return raw;
  const canChip = ui && typeof ui.parseRecordId === "function" && typeof ui.RecordIdChip === "function";
  if (!canChip) return raw;
  const parts = raw.split(/([\s（）、；;，,：:]+)/);
  const out = [];
  parts.forEach((part, i) => {
    if (!part) return;
    if (i % 2 === 1) { out.push(part); return; }
    const parsed = ui.parseRecordId(part);
    if (parsed && parsed.id) {
      out.push(ui.RecordIdChip(parsed.id, {
        projectId: projectId,
        navigate: (id) => { if (router && typeof router.openRecord === "function") router.openRecord(id); },
      }));
    } else {
      out.push(part);
    }
  });
  return out;
}

/** 编号 chip（单个）；空值 → 未提供。 */
function idChip(ui, router, projectId, id) {
  if (!id) return "—（未提供）";
  if (ui && typeof ui.RecordIdChip === "function") {
    return ui.RecordIdChip(String(id), {
      projectId: projectId,
      navigate: (rid) => { if (router && typeof router.openRecord === "function") router.openRecord(rid); },
    });
  }
  return String(id);
}

/** 消息状态徽章：VOCAB 含 received/processing/failed；handled 由本页局部词表承接
 *  （M2 实际词表为 received→processing→handled|failed，见 docs/modules/ui-M2.md 偏差 2）。 */
function messageStatusNode(h, ui, status) {
  const raw = status === null || status === undefined || status === "" ? "" : String(status);
  if (!raw) return ui && ui.StatusBadge ? ui.StatusBadge("message_status", "") : h("span", null, "—（未提供）");
  if (raw === "handled") {
    return h("span", {
      title: "原始值：handled（决定已持久化）",
      style: {
        display: "inline-flex", alignItems: "center", gap: 5, padding: "1px 8px",
        borderRadius: 999, fontSize: 13, whiteSpace: "normal",
        background: "var(--sorne-status-ok-bg)", color: "var(--sorne-status-ok-fg)",
      },
    }, MESSAGE_STATUS_TEXT.handled);
  }
  return ui && ui.StatusBadge
    ? ui.StatusBadge("message_status", raw)
    : h("span", { title: "原始值：" + raw }, MESSAGE_STATUS_TEXT[raw] || raw);
}

/* ── 页面定义 ─────────────────────────────────────────────────────── */

export default {
  id: "workbench",
  title: "工作台",
  order: 20,
  render({ React, h, api, router, ui, theme }) {
    VOCAB_REF = ui && ui.VOCAB ? ui.VOCAB : null;
    const ComponentBase = React && typeof React.Component === "function"
      ? React.Component
      : class PageComponentBase { constructor(props) { this.props = props || {}; } };

    class WorkbenchBody extends ComponentBase {
      constructor(props) {
        super(props);
        const pid = props.router && props.router.projectId ? String(props.router.projectId) : "";
        this.state = {
          projectId: pid,
          overview: { phase: "loading", data: null, error: null },
          attempts: { phase: "loading", data: null, error: null },
          verification: { phase: "loading", data: null, error: null },
          changes: { phase: "loading", data: null, error: null },
          messages: { phase: "loading", data: null, error: null },
          diagnostics: { phase: "loading", data: null, error: null },
          compose: { content: "", attachments: "", busy: false, error: "", notice: "" },
          dataAt: null,
        };
        this.seqOverview = 0;
        this.seqAttempts = 0;
        this.seqVerification = 0;
        this.seqChanges = 0;
        this.seqMessages = 0;
        this.seqDiagnostics = 0;
        this.onNav = this.onNav.bind(this);
        this.unsubNav = null;
      }

      componentDidMount() {
        this.refreshAll();
        const router = this.props.router;
        if (router && typeof router.onChange === "function") this.unsubNav = router.onChange(this.onNav);
      }

      componentWillUnmount() {
        if (typeof this.unsubNav === "function") this.unsubNav();
      }

      onNav() {
        const router = this.props.router;
        if (!router) return;
        const pid = router.projectId ? String(router.projectId) : "";
        if (router.page === "workbench" && pid && pid !== this.state.projectId) {
          this.setState({ projectId: pid }, () => this.refreshAll());
        }
      }

      /* ── 取数（六个端点各自独立失败，互不拖垮） ────────────────── */

      refreshAll() {
        const pid = this.state.projectId;
        if (!pid) {
          this.setState({ overview: { phase: "ready", data: null, error: null } });
          return;
        }
        this.setState({ dataAt: null });
        this.loadOverview(pid);
        this.loadAttempts(pid);
        this.loadVerification(pid);
        this.loadChanges(pid);
        this.loadMessages(pid);
        this.loadDiagnostics(pid);
      }

      async fetchJSON(path) {
        const { api } = this.props;
        if (typeof api !== "function") {
          const e = new Error("当前宿主未提供 API 通道");
          e.code = "NO_API";
          throw e;
        }
        return api(path);
      }

      settle(key, phase, data, error) {
        this.setState({ [key]: { phase: phase, data: data, error: error } });
      }

      loadOverview(pid) {
        this.settle("overview", "loading", null, null);
        const mine = ++this.seqOverview;
        this.fetchJSON("/sorne/orchestrator/overview?project_id=" + encodeURIComponent(pid)).then(
          (data) => { if (mine === this.seqOverview) this.settle("overview", "ready", data, null); },
          (e) => { if (mine === this.seqOverview) this.settle("overview", isNotImplemented(e) ? "notimpl" : "error", null, e); },
        );
      }

      loadAttempts(pid) {
        this.settle("attempts", "loading", null, null);
        const mine = ++this.seqAttempts;
        this.fetchJSON("/sorne/attempts?project_id=" + encodeURIComponent(pid) + "&limit=50").then(
          (data) => { if (mine === this.seqAttempts) this.settle("attempts", "ready", data, null); },
          (e) => { if (mine === this.seqAttempts) this.settle("attempts", isNotImplemented(e) ? "notimpl" : "error", null, e); },
        );
      }

      loadVerification(pid) {
        this.settle("verification", "loading", null, null);
        const mine = ++this.seqVerification;
        this.fetchJSON("/sorne/verification-jobs?project_id=" + encodeURIComponent(pid) + "&limit=50").then(
          (data) => { if (mine === this.seqVerification) this.settle("verification", "ready", data, null); },
          (e) => { if (mine === this.seqVerification) this.settle("verification", isNotImplemented(e) ? "notimpl" : "error", null, e); },
        );
      }

      loadChanges(pid) {
        this.settle("changes", "loading", null, null);
        const mine = ++this.seqChanges;
        this.fetchJSON("/sorne/change-log?project_id=" + encodeURIComponent(pid) + "&limit=20").then(
          (data) => { if (mine === this.seqChanges) this.settle("changes", "ready", data, null); },
          (e) => { if (mine === this.seqChanges) this.settle("changes", isNotImplemented(e) ? "notimpl" : "error", null, e); },
        );
      }

      loadMessages(pid) {
        this.settle("messages", "loading", null, null);
        const mine = ++this.seqMessages;
        this.fetchJSON("/sorne/messages?project_id=" + encodeURIComponent(pid) + "&limit=50").then(
          (data) => {
            if (mine !== this.seqMessages) return;
            this.settle("messages", "ready", data, null);
            this.setState({ dataAt: new Date().toISOString() });
          },
          (e) => {
            if (mine !== this.seqMessages) return;
            this.settle("messages", isNotImplemented(e) ? "notimpl" : "error", null, e);
            this.setState({ dataAt: new Date().toISOString() });
          },
        );
      }

      /** 消息分页续读（#47 游标；更早消息追加，不静默截断——P0-3 同类要求）。 */
      async loadMoreMessages() {
        const { api } = this.props;
        const pid = this.state.projectId;
        const data = this.state.messages.data;
        const cursor = data && typeof data.next_cursor === "string" ? data.next_cursor : null;
        if (!cursor || typeof api !== "function") return;
        try {
          const page = await api("/sorne/messages?project_id=" + encodeURIComponent(pid) +
            "&limit=50&cursor=" + encodeURIComponent(cursor));
          const more = page && Array.isArray(page.messages) ? page.messages : [];
          this.setState((prev) => {
            const prevData = prev.messages.data || { messages: [] };
            const seen = new Set((prevData.messages || []).map((m) => m && m.id));
            const merged = (prevData.messages || []).slice();
            for (const m of more) {
              if (!seen.has(m && m.id)) merged.push(m);
            }
            return {
              messages: {
                phase: "ready",
                data: Object.assign({}, prevData, {
                  messages: merged,
                  next_cursor: page && page.next_cursor ? page.next_cursor : null,
                  has_more: Boolean(page && page.has_more),
                }),
                error: null,
              },
            };
          });
        } catch (e) {
          this.setState({ messages: { phase: "ready", data: data, error: e } });
        }
      }

      loadDiagnostics(pid) {
        this.settle("diagnostics", "loading", null, null);
        const mine = ++this.seqDiagnostics;
        this.fetchJSON("/sorne/diagnostics?project_id=" + encodeURIComponent(pid)).then(
          (data) => { if (mine === this.seqDiagnostics) this.settle("diagnostics", "ready", data, null); },
          (e) => { if (mine === this.seqDiagnostics) this.settle("diagnostics", "error", null, e); },
        );
      }

      /* ── 对话（J4/J5） ─────────────────────────────────────────── */

      patchCompose(patch) {
        this.setState((prev) => ({ compose: Object.assign({}, prev.compose, patch) }));
      }

      parseAttachmentsInput(raw) {
        const text = String(raw || "").trim();
        if (!text) return { attachments: [], error: "" };
        const tokens = text.split(/[\s,，;；]+/).filter(Boolean);
        if (tokens.length > 16) return { attachments: [], error: "附件最多 16 项" };
        const attachments = [];
        for (const token of tokens) {
          const value = token.trim();
          if (ui && typeof ui.parseRecordId === "function") {
            const parsed = ui.parseRecordId(value);
            if (parsed && parsed.prefix === "CAP") { attachments.push({ kind: "capture", ref: parsed.id }); continue; }
            if (parsed && parsed.prefix === "B") { attachments.push({ kind: "blob", ref: parsed.id }); continue; }
          }
          if (/^[0-9a-f]{64}$/i.test(value)) { attachments.push({ kind: "blob", ref: value.toLowerCase() }); continue; }
          return { attachments: [], error: "附件「" + value + "」不是可识别的证据编号：只接受 B-（证据）或 CAP-（采集）编号，先经 /evidence/blobs 与 /captures 上传" };
        }
        return { attachments: attachments, error: "" };
      }

      async sendMessage() {
        const { api } = this.props;
        const { compose, projectId } = this.state;
        const content = String(compose.content || "").trim();
        if (!content) {
          this.patchCompose({ error: "请先输入消息内容（本地拦截，未发请求）", notice: "" });
          return;
        }
        if (typeof api !== "function") {
          this.patchCompose({ error: "发送失败：当前宿主未提供 API 通道", notice: "" });
          return;
        }
        const parsed = this.parseAttachmentsInput(compose.attachments);
        if (parsed.error) {
          this.patchCompose({ error: parsed.error, notice: "" });
          return;
        }
        this.patchCompose({ busy: true, error: "", notice: "" });
        const body = { project_id: projectId, content: content };
        if (parsed.attachments.length) body.attachments = parsed.attachments;
        try {
          const res = await api("/sorne/messages", { method: "POST", body: JSON.stringify(body) });
          const message = res && res.message ? res.message : null;
          this.setState({
            compose: {
              content: "", attachments: "", busy: false, error: "",
              notice: "已发送" + (message && message.id ? "（" + message.id + "）" : "") +
                "：已接收（received）≠ 已处理（handled）——AI 读取并作出决定后才算处理",
            },
          });
          this.loadMessages(projectId);
        } catch (e) {
          this.patchCompose({ busy: false, error: "发送失败：" + errorMessage(e), notice: "" });
        }
      }

      /* ── 派生视图（全部来自已加载数据，明确标注口径） ───────────── */

      overviewData() {
        return this.state.overview.phase === "ready" ? this.state.overview.data : null;
      }

      diagnosticsProject() {
        const d = this.state.diagnostics.phase === "ready" ? this.state.diagnostics.data : null;
        return d && d.project && typeof d.project === "object" ? d.project : null;
      }

      attemptsList() {
        const d = this.state.attempts.phase === "ready" ? this.state.attempts.data : null;
        return d && Array.isArray(d.attempts) ? d.attempts : [];
      }

      activeAttempts() {
        return this.attemptsList().filter((a) => a && (a.status === "leased" || a.status === "running"));
      }

      verificationList() {
        const d = this.state.verification.phase === "ready" ? this.state.verification.data : null;
        return d && Array.isArray(d.jobs) ? d.jobs : [];
      }

      changeEvents() {
        const d = this.state.changes.phase === "ready" ? this.state.changes.data : null;
        return d && Array.isArray(d.events) ? d.events : [];
      }

      messageList() {
        const d = this.state.messages.phase === "ready" ? this.state.messages.data : null;
        return d && Array.isArray(d.messages) ? d.messages : [];
      }

      projectStatus() {
        /* 诊断聚合（#49）是状态与收尾计数的专用面；#31 为 501 时仍可呈现状态。 */
        const dp = this.diagnosticsProject();
        if (dp && typeof dp.status === "string" && dp.status) return dp.status;
        const ov = this.overviewData();
        if (ov && ov.project && typeof ov.project.status === "string") return ov.project.status;
        return "";
      }

      planCounts() {
        const dp = this.diagnosticsProject();
        if (dp && dp.plan) {
          return {
            pending: num(dp.plan.plan_runs_pending),
            inFlight: num(dp.plan.plan_runs_in_flight),
          };
        }
        return { pending: null, inFlight: null };
      }

      intentCounts() {
        const ov = this.overviewData();
        if (ov && ov.intents && ov.intents.counts_by_status && typeof ov.intents.counts_by_status === "object") {
          return ov.intents.counts_by_status;
        }
        const dp = this.diagnosticsProject();
        if (dp && dp.intents && dp.intents.by_status && typeof dp.intents.by_status === "object") {
          return dp.intents.by_status;
        }
        return null;
      }

      activeIntents() {
        const ov = this.overviewData();
        if (!ov || !ov.intents || !Array.isArray(ov.intents.active)) return [];
        return ov.intents.active.filter((it) => it && typeof it === "object");
      }

      blockedIntents() {
        return this.activeIntents().filter((it) =>
          it.status === "blocked" || it.status === "awaiting_review" || it.status === "deferred");
      }

      pendingReports() {
        const ov = this.overviewData();
        if (!ov || !ov.pending_reports || typeof ov.pending_reports !== "object") return null;
        const items = Array.isArray(ov.pending_reports.items) ? ov.pending_reports.items : [];
        /* 未处理 = 处理状态非 handled（delivered ≠ handled；服务端 #31 通常已按 pending 过滤，
           此处按 §18.5 面板语义再做一次防御，不把已处理汇报列进待办）。 */
        const unhandled = items.filter((r) => !(r && r.handling_status === "handled"));
        return {
          total: num(ov.pending_reports.total),
          hasMore: ov.pending_reports.has_more === true,
          items: unhandled,
          note: typeof ov.pending_reports.note === "string" ? ov.pending_reports.note : "",
        };
      }

      pendingItems() {
        const ov = this.overviewData();
        if (!ov || !ov.pending_items || typeof ov.pending_items !== "object") return null;
        return ov.pending_items;
      }

      findings() {
        const ov = this.overviewData();
        if (!ov || !ov.important_findings || typeof ov.important_findings !== "object") return null;
        return {
          vulnerabilities: Array.isArray(ov.important_findings.vulnerabilities) ? ov.important_findings.vulnerabilities : [],
          hypotheses: Array.isArray(ov.important_findings.hypotheses) ? ov.important_findings.hypotheses : [],
          note: typeof ov.important_findings.note === "string" ? ov.important_findings.note : "",
        };
      }

      latestPlanRevision() {
        const ov = this.overviewData();
        if (!ov || !ov.active_plan || !Array.isArray(ov.active_plan.latest_plan_revisions)) return null;
        return ov.active_plan.latest_plan_revisions[0] || null;
      }

      highWatermark() {
        const d = this.state.changes.phase === "ready" ? this.state.changes.data : null;
        if (d && d.high_watermark && num(d.high_watermark.commit_seq) !== null) return num(d.high_watermark.commit_seq);
        const dp = this.diagnosticsProject();
        return dp ? num(dp.high_watermark) : null;
      }

      health() {
        const d = this.state.diagnostics.phase === "ready" ? this.state.diagnostics.data : null;
        return d && d.health && typeof d.health === "object" ? d.health : null;
      }

      llm() {
        const d = this.state.diagnostics.phase === "ready" ? this.state.diagnostics.data : null;
        return d && d.llm && typeof d.llm === "object" ? d.llm : null;
      }

      /** 待处理数量：受阻方向 + 待验证任务 + 未处理汇报（按已加载数据推导）。 */
      todoCount() {
        const vjobs = this.verificationList().filter((j) => j && (j.status === "pending" || j.status === "in_progress"));
        const reports = this.pendingReports();
        return this.blockedIntents().length + vjobs.length + (reports && reports.total !== null ? reports.total : 0);
      }

      /** J1 进展条：六段，每段必须来自真实记录事实（§2.6-3 冻结映射）。 */
      progressStages() {
        const ov = this.overviewData();
        const dp = this.diagnosticsProject();
        const plan = this.planCounts();
        const counts = this.intentCounts();
        const active = this.activeAttempts();
        const hw = this.highWatermark();
        const plannerLag = dp && dp.projection && typeof dp.projection === "object"
          ? num(dp.projection.planner_view) : null;
        const lastPlan = this.latestPlanRevision();
        const planAccepted = Boolean(lastPlan && (lastPlan.received_status === "accepted" || lastPlan.received_status === "partial"));
        const planFailed = Boolean(lastPlan && (lastPlan.received_status === "rejected" || lastPlan.received_status === "partial"));
        const countsTotal = counts
          ? Object.keys(counts).reduce((sum, k) => sum + (num(counts[k]) || 0), 0) : null;
        const hasWork = countsTotal !== null ? countsTotal > 0 : false;
        const queuedOrRunning = counts ? (num(counts.queued) || 0) + (num(counts.running) || 0) : 0;
        const planPending = (plan.pending || 0) + (plan.inFlight || 0);
        const projectExists = Boolean(this.state.projectId && (this.projectStatus() || ov));
        const stages = [];

        /* ① 已接收目标：项目存在且已建规划请求（plan_run 计数 > 0，或已有意图/提交）。 */
        const goalAccepted = Boolean(projectExists && ((plan.pending || 0) + (plan.inFlight || 0) > 0 || planAccepted || hasWork || (hw || 0) > 0));
        stages.push({
          key: "goal", label: "已接收目标",
          state: goalAccepted ? "done" : "current",
          evidence: goalAccepted
            ? "规划请求：待处理 " + numText(plan.pending) + " · 进行中 " + numText(plan.inFlight)
            : "尚无规划请求（plan_run 计数为 0）：可在向导第④步「开始探索」，之后本段自动推进",
        });

        /* ② 正在读取已有信息：planner_view 投影滞后（null=未投影，不冒充 0）。 */
        const reading = plannerLag !== null && plannerLag > 0;
        stages.push({
          key: "reading", label: "正在读取已有信息",
          state: plannerLag === null ? "pending" : (reading ? "current" : "done"),
          evidence: plannerLag === null
            ? "尚未同步已处理记录（未提供）"
            : "正在同步已处理记录（落后 " + plannerLag + " 条，已处理到 #" + numText(hw) + "）",
        });

        /* ③ 正在制定计划：plan_runs status ∈ {pending, in_flight}。 */
        stages.push({
          key: "planning", label: "正在制定计划",
          state: planPending > 0 ? "current" : (planAccepted ? "done" : "pending"),
          evidence: planPending > 0
            ? "规划进行中（" + planPending + " 个）"
            : (lastPlan
              ? "最新计划修订 " + (lastPlan.id || "—") + " 接收状态：" + (PLAN_RECEIVED_TEXT[lastPlan.received_status] || lastPlan.received_status || "未提供")
              : "尚无计划修订记录"),
        });

        /* ④ 已分配任务：queued/running 意图（#21 聚合）或活跃 Attempt（#23）。 */
        stages.push({
          key: "assigned", label: "已分配任务",
          state: (queuedOrRunning > 0 || active.length > 0) ? "current" : (planAccepted ? "done" : "pending"),
          evidence: (queuedOrRunning > 0 || active.length > 0)
            ? "排队 " + (num(counts && counts.queued) || 0) + " · 执行中 " + (num(counts && counts.running) || 0) + " · 活跃尝试 " + active.length
            : "当前没有待执行任务",
        });

        /* ⑤ 持续探索中：高水位推进 / 近期事件（#45）。 */
        const events = this.changeEvents();
        stages.push({
          key: "exploring", label: "持续探索中",
          state: (hw || 0) > 0 && (events.length > 0 || active.length > 0) ? "current" : "pending",
          evidence: (hw || 0) > 0
            ? "已处理到 #" + numText(hw) + " · 最近事件 " + events.length + " 条" +
              (events.length ? "（" + ui.formatTime(events[events.length - 1].created_at) + "）" : "")
            : "尚无事件记录",
        });

        /* ⑥ 失败：计划被拒绝/部分接收，或 agents 运行时报错（显示原因，不转圈）。 */
        const runtime = this.llm() && typeof this.llm().runtime === "string" ? this.llm().runtime : "";
        const runtimeError = /error|failed|异常|错误/i.test(runtime);
        stages.push({
          key: "failed", label: "失败（如发生）",
          state: (planFailed || runtimeError) ? "failed" : "pending",
          evidence: (planFailed || runtimeError)
            ? "原因：" + (planFailed ? "计划接收状态 " + (PLAN_RECEIVED_TEXT[lastPlan.received_status] || lastPlan.received_status) + "（plan " + (lastPlan.id || "—") + "）" : "运行时报告错误") +
              (runtimeError ? "；agents：" + runtime : "")
            : "当前没有失败记录（计划未被拒绝、运行时未报错）",
        });

        const hasAnyLoading = this.state.overview.phase === "loading" || this.state.diagnostics.phase === "loading";
        return { stages: stages, loading: hasAnyLoading, plannerLag: plannerLag, hw: hw };
      }

      openDetail(id) {
        const router = this.props.router;
        if (!router || typeof router.open !== "function") return;
        const pid = this.state.projectId;
        router.open("#/p/" + encodeURIComponent(pid) + "/workbench?id=" + encodeURIComponent(id));
      }

      /* ── 渲染：头部 + 语义说明折叠区 ───────────────────────────── */

      renderHeader() {
        const { h, ui } = this.props;
        const { dataAt } = this.state;
        const llm = this.llm();
        const notConfigured = Boolean(llm && llm.configured === false);
        const runtime = llm && typeof llm.runtime === "string" ? llm.runtime : "";
        const loading = this.state.overview.phase === "loading" && this.state.diagnostics.phase === "loading";
        return h("div", { key: "head", style: { display: "flex", flexDirection: "column", gap: 8 } },
          h("div", { style: { display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" } },
            h("h2", { style: { margin: 0, fontSize: 17, color: "var(--sorne-text-primary)" } }, "工作台"),
            h("span", { style: { fontSize: 13.5, color: "var(--sorne-text-secondary)" } },
              "现在发生了什么、你需要做什么；数据来自真实记录，计数按已加载数据推导。"),
          ),
          h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" } },
            h("button", {
              type: "button", "aria-label": "刷新工作台数据", onClick: () => this.refreshAll(),
              style: btnStyle(null, loading), disabled: loading,
            }, "刷新"),
            dataAt
              ? h("span", { style: { fontSize: 13, color: "var(--sorne-text-muted)" } },
                  "数据时刻：" + ui.formatTime(dataAt) + " · 已加载工作台数据")
              : null,
            notConfigured
              ? h("span", {
                  role: "status",
                  style: {
                    fontSize: 13.5, padding: "3px 10px", borderRadius: 999,
                    border: "1px solid var(--sorne-status-suspected-fg)",
                    background: "var(--sorne-status-suspected-bg)",
                    color: "var(--sorne-status-suspected-fg)",
                  },
                }, "尚未连接模型，项目可以保存，AI 暂不能开始")
              : null,
          ),
          notConfigured
            ? h("div", { style: { fontSize: 13.5, color: "var(--sorne-text-secondary)", lineHeight: 1.6 } },
                runtime
                  ? "AI 运行状态：" + runtime + "（来自诊断聚合，原样呈现）。消息会停留在「已接收」，AI 读取并作出决定后才算处理。"
                  : "AI 运行状态未知（诊断未提供）：不以「服务正常」暗示 AI 可工作。")
            : null,
          h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
            h("button", {
              type: "button", "aria-label": "前往系统诊断",
              onClick: () => {
                const router = this.props.router;
                if (router && typeof router.open === "function") {
                  router.open("#/p/" + encodeURIComponent(this.state.projectId) + "/diagnostics");
                }
              },
              style: btnStyle("quiet"),
            }, "查看系统诊断"),
          ),
          h("details", { style: { fontSize: 13.5, color: "var(--sorne-text-secondary)" } },
            h("summary", { style: { cursor: "pointer" } }, "这些数字怎么来的"),
            h("div", { style: { lineHeight: 1.7, marginTop: 4, display: "flex", flexDirection: "column", gap: 2 } },
              h("div", null, "三区字段来自 #31 工作概览、#23 执行尝试、#29 验证队列、#45 变化流、#47 消息与 #49 诊断聚合；原始指标 JSON 归系统诊断页，不在工作台铺开。"),
              h("div", null, "resolved 只表示该版本的问题已处理，不代表关联资产已测透（规范 §10.1）"),
              h("div", null, "恢复与重派由协调 AI 决定，程序不写死固定重试（规范 §3.1/§3.2）"),
              h("div", null, "同项目默认最多一个规划调用在途（§16.1）"),
              h("div", null, "九态计数以库为准（§10.1）；「按已加载数据推导，不代表全量」，缺失值显示「—（未提供）」（未提供 ≠ 不存在）。"),
              h("div", null, "收到 ≠ 已处理：delivered 只表示已送入上下文；决定持久化并回写关联后才 handled（§18.5）。折叠不删记录；501 未实现 ≠ 报错。"),
              h("div", null, "新汇报默认强调相对于 base_report 的变化，接收方缺少基线时可以读取基线，不依赖对话记忆（§18.6）；交接卡/关键记录/完整依据三层展开，面板折叠不改变原始关系与恢复条件（§18.6）。"),
            ),
          ),
        );
      }

      /* ── 渲染：进展条 ──────────────────────────────────────────── */

      renderProgress() {
        const { h } = this.props;
        const info = this.progressStages();
        const stages = info.stages;
        return h("section", { key: "progress", "aria-label": "探索进展", style: CARD },
          h("h3", { style: H3 }, "探索进展"),
          info.loading
            ? h("div", { role: "status", style: MUTED }, "正在读取进展（读取完成前不显示进度，不转圈）…")
            : null,
          h("ol", { style: { listStyle: "none", margin: "6px 0 0", padding: 0, display: "flex", flexDirection: "column", gap: 4 } },
            stages.map((stage, i) => h("li", {
              key: stage.key,
              style: {
                display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap",
                padding: "4px 0", borderTop: i === 0 ? "none" : "1px dashed var(--sorne-border)",
                opacity: stage.state === "pending" ? 0.85 : 1,
              },
            },
              h("span", {
                "aria-hidden": "true",
                style: {
                  flex: "0 0 auto", width: 20, height: 20, borderRadius: "50%",
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                  fontSize: 13, fontWeight: 600,
                  background: stage.state === "failed" ? "var(--sorne-status-unknown-bg)"
                    : stage.state === "current" ? "var(--sorne-status-review-bg)"
                      : stage.state === "done" ? "var(--sorne-status-ok-bg)" : "var(--sorne-bg-subtle)",
                  color: stage.state === "failed" ? "var(--sorne-status-unknown-fg)"
                    : stage.state === "current" ? "var(--sorne-status-review-fg)"
                      : stage.state === "done" ? "var(--sorne-status-ok-fg)" : "var(--sorne-text-muted)",
                },
              }, String(i + 1)),
              h("span", { style: { fontSize: 14, fontWeight: 600, color: "var(--sorne-text-primary)" } }, stage.label),
              h("span", { style: { fontSize: 13, color: "var(--sorne-text-secondary)" } }, STAGE_STATE_TEXT[stage.state] || stage.state),
              h("span", { style: { fontSize: 13, color: "var(--sorne-text-muted)", flex: "1 1 260px", minWidth: 0, wordBreak: "break-word" } }, stage.evidence),
            )),
          ),
          h("div", { style: { ...MUTED, marginTop: 6 } },
            "每段映射真实记录；读取中不显示假进度；失败段显示原因。计数按已加载数据推导，不代表全量。"),
        );
      }

      /* ── 渲染：4 张卡 + 6 项指标 ───────────────────────────────── */

      renderOverviewCards() {
        const { h, ui } = this.props;
        const status = this.projectStatus();
        const activeAttempts = this.activeAttempts();
        const counts = this.intentCounts();
        const vjobs = this.verificationList().filter((j) => j && (j.status === "pending" || j.status === "in_progress"));
        const reports = this.pendingReports();
        const messages = this.messageList();
        const pendingMsgs = messages.filter((m) => m && m.direction === "user" && (m.status === "received" || m.status === "processing"));
        const health = this.health();
        const llm = this.llm();
        const hw = this.highWatermark();
        const cells = [
          { key: "status", label: "项目状态", node: status ? ui.StatusBadge("project_status", status) : h("span", { style: MUTED }, "—（未提供）") },
          { key: "intents", label: "意图", node: h("span", { style: COUNT }, counts
            ? "排队 " + (num(counts.queued) || 0) + " · 执行中 " + (num(counts.running) || 0)
            : "—（未提供）") },
          { key: "attempts", label: "活跃尝试", node: h("span", { style: COUNT }, activeAttempts.length + " 个") },
          { key: "verify", label: "待验证", node: h("span", { style: COUNT }, vjobs.length + " 个") },
          { key: "todo", label: "待你处理", node: h("span", { style: COUNT },
            (reports && reports.total !== null ? reports.total + " 份汇报" : "汇报 —")
            + " · " + pendingMsgs.length + " 条消息") },
          { key: "progress", label: "处理进度", node: h("span", { style: COUNT }, hw !== null && hw !== undefined ? "已处理到 #" + numText(hw) : "—（未提供）") },
          { key: "system", label: "系统", node: h("span", { style: COUNT },
            (health ? (health.ok === false ? "服务异常" : "服务正常") : "服务 —")
            + " · " + llmStatusText(llm)) },
        ];
        return h("section", { key: "overview", "aria-label": "工作台概览",
          style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8 } },
          cells.map((c) => h("div", { key: c.key, style: { ...CARD, padding: "8px 10px" } },
            h("div", { style: { fontSize: 12.5, color: "var(--sorne-text-secondary)", marginBottom: 3 } }, c.label),
            h("div", { style: { display: "flex", alignItems: "baseline", gap: 6, flexWrap: "wrap" } }, c.node),
          )),
        );
      }

      renderIndicators() {
        return null;
      }


      /* ── 渲染：J6 暂停过渡态 ───────────────────────────────────── */

      renderPauseFeedback() {
        const { h } = this.props;
        const status = this.projectStatus();
        const activeAttempts = this.activeAttempts();
        if (status === "paused") {
          const n = activeAttempts.length;
          return h("div", {
            key: "pause", role: "status",
            style: {
              display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center",
              padding: "8px 12px", borderRadius: 8, fontSize: 13.5, lineHeight: 1.6,
              border: n > 0 ? "1px solid var(--sorne-status-suspected-fg)" : "1px solid var(--sorne-status-ok-fg)",
              background: n > 0 ? "var(--sorne-status-suspected-bg)" : "var(--sorne-status-ok-bg)",
              color: n > 0 ? "var(--sorne-status-suspected-fg)" : "var(--sorne-status-ok-fg)",
            },
          },
            n > 0
              ? h("span", null, "正在暂停，仍有 " + n + " 个收尾中的操作（活跃 Attempt 数，来自 #23）——收尾完成前不假装全部停止。")
              : h("span", null, "已暂停（无收尾中的操作）"),
          );
        }
        if (status === "waiting_for_change") {
          return h("div", { key: "wait", role: "status", style: {
              padding: "8px 12px", borderRadius: 8, fontSize: 13.5, lineHeight: 1.6,
              border: "1px solid var(--sorne-status-suspected-fg)",
              background: "var(--sorne-status-suspected-bg)", color: "var(--sorne-status-suspected-fg)",
            } },
            "等待条件补齐：没有可派发工作时进入等待条件变化，不是结束；原因见顶栏与系统诊断。");
        }
        return null;
      }

      /* ── 渲染：正在做什么 ─────────────────────────────────────── */

      renderDoing() {
        const { h, ui, router } = this.props;
        const projectId = this.state.projectId;
        const intents = this.activeIntents();
        const attempts = this.activeAttempts();
        const events = this.changeEvents();
        const recent = events.slice(-3).reverse();
        return h("section", { key: "doing", "aria-label": "正在做什么", style: CARD },
          h("h3", { style: H3 }, "正在做什么"),
          h("div", { style: SUB }, "当前方向（#31 活跃意图）"),
          this.state.overview.phase === "loading"
            ? h("div", { style: MUTED }, "正在读取当前方向…")
            : this.state.overview.phase === "notimpl"
              ? this.notImplCard("工作概览", this.state.overview.error)
              : this.state.overview.phase === "error"
                ? this.errorCard("工作概览不可用", this.state.overview.error)
                : intents.length
                  ? h("div", { style: { display: "flex", flexDirection: "column", gap: 6, marginTop: 4 } },
                      intents.slice(0, 8).map((it) => h("div", {
                        key: it.id || it.question,
                        style: { border: "1px solid var(--sorne-border)", borderRadius: 8, padding: "6px 9px", background: "var(--sorne-bg-surface)" },
                      },
                        h("div", { style: { display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" } },
                          idChip(ui, router, projectId, it.id),
                          ui.StatusBadge ? ui.StatusBadge("intent_status", it.status) : String(it.status || "—（未提供）"),
                          it.kind ? h("span", { style: COUNT }, "类别：" + (INTENT_KIND_TEXT[it.kind] || it.kind)) : null,
                          it.priority !== null && it.priority !== undefined ? h("span", { style: COUNT }, "优先级 " + it.priority) : null,
                        ),
                        h("div", { style: { fontSize: 13.5, color: "var(--sorne-text-primary)", lineHeight: 1.6 } }, "问题：" + (it.question || "—（未提供）")),
                        it.latest_attempt
                          ? h("div", { style: COUNT }, "最近尝试：", idChip(ui, router, projectId, it.latest_attempt.id),
                              " · " + (vocabLabel("attempt_status", it.latest_attempt.status) || it.latest_attempt.status || "未提供"),
                              it.latest_attempt.worker_id ? " · worker：" + it.latest_attempt.worker_id : "")
                          : null,
                        it.status === "blocked"
                          ? h("div", { style: { fontSize: 13, color: "var(--sorne-status-suspected-fg)", lineHeight: 1.6 } },
                              "受阻：" + ((it.blocked_detail && it.blocked_detail.note) || "原因未提供"))
                          : null,
                      )),
                    )
                  : h("div", { style: MUTED }, "（当前没有活跃意图；意图由 Planner 提交后进入工作台）"),
          intents.length > 8
            ? h("div", { style: { ...MUTED, marginTop: 2 } }, "仅显示前 8 条（本页已加载 " + intents.length + " 条；完整清单以探索页为准）。")
            : null,
          h("div", { style: SUB }, "活跃 Attempt（#23 租约视图）"),
          this.state.attempts.phase === "loading"
            ? h("div", { style: MUTED }, "正在读取执行尝试…")
            : this.state.attempts.phase === "notimpl"
              ? this.notImplCard("执行尝试视图", this.state.attempts.error)
              : this.state.attempts.phase === "error"
                ? this.errorCard("执行尝试不可用", this.state.attempts.error)
                : attempts.length
                  ? h("div", { style: { display: "flex", flexDirection: "column", gap: 4, marginTop: 4 } },
                      attempts.slice(0, 8).map((a) => h("div", {
                        key: a.id,
                        style: { display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap", fontSize: 13.5 },
                      },
                        idChip(ui, router, projectId, a.id),
                        ui.StatusBadge ? ui.StatusBadge("attempt_status", a.status) : String(a.status || "—（未提供）"),
                        a.intent_id ? h("span", { style: COUNT }, "意图：", idChip(ui, router, projectId, a.intent_id)) : null,
                        a.worker_id ? h("span", { style: COUNT }, "worker：" + a.worker_id) : null,
                        a.lease && a.lease.expires_at
                          ? h("span", { style: COUNT }, "租约到期：" + ui.formatTime(a.lease.expires_at))
                          : null,
                      )),
                    )
                  : h("div", { style: MUTED }, "（当前没有活跃的执行尝试）"),
          attempts.length > 8
            ? h("div", { style: { ...MUTED, marginTop: 2 } }, "仅显示前 8 条（本页已加载 " + attempts.length + " 条；完整明细见系统诊断页）。")
            : null,
          h("div", { style: SUB }, "最新进展（#45 变化流，最近 3 条）"),
          this.state.changes.phase === "loading"
            ? h("div", { style: MUTED }, "正在读取最新进展…")
            : this.state.changes.phase === "notimpl"
              ? this.notImplCard("变化流", this.state.changes.error)
              : this.state.changes.phase === "error"
                ? this.errorCard("变化流不可用", this.state.changes.error)
                : recent.length === 0
                  ? h("div", { style: MUTED }, "（当前区间暂无事件）")
                  : h("div", { style: { display: "flex", flexDirection: "column", gap: 3, marginTop: 4 } },
                      recent.map((ev) => h("div", { key: ev.event_id, style: { fontSize: 13.5, color: "var(--sorne-text-primary)", lineHeight: 1.6 } },
                        "#" + ev.commit_seq + "/" + ev.event_index + " · " + (ev.event_type || "—") + " · " + ui.formatTime(ev.created_at),
                        Array.isArray(ev.subject_ids) && ev.subject_ids.length
                          ? h("span", null, " · 主体：", ev.subject_ids.map((sid, i) => h("span", { key: sid + "-" + i },
                              idChip(ui, router, projectId, sid), i < ev.subject_ids.length - 1 ? "、" : "")))
                          : null,
                      )),
                    ),
        );
      }

      /* ── 渲染：得到了什么 ─────────────────────────────────────── */

      renderGained() {
        const { h, ui, router } = this.props;
        const projectId = this.state.projectId;
        const findings = this.findings();
        const events = this.changeEvents();
        const createdTypes = /asset|observation|hypothesis|vulnerability|fact/i;
        const newRecords = [];
        const seen = new Set();
        for (const ev of events) {
          if (!ev || typeof ev.event_type !== "string") continue;
          if (!createdTypes.test(ev.event_type)) continue;
          for (const sid of Array.isArray(ev.subject_ids) ? ev.subject_ids : []) {
            if (seen.has(sid)) continue;
            seen.add(sid);
            newRecords.push({ id: sid, eventType: ev.event_type, at: ev.created_at });
          }
        }
        return h("section", { key: "gained", "aria-label": "得到了什么", style: CARD },
          h("h3", { style: H3 }, "得到了什么"),
          h("div", { style: SUB }, "重要新发现（#31：疑似漏洞/假设，状态原样呈现、不提升）"),
          this.state.overview.phase === "loading"
            ? h("div", { style: MUTED }, "正在读取重要新发现…")
            : !findings
              ? h("div", { style: MUTED }, "—（未提供：工作概览未返回重要发现区块；未提供 ≠ 不存在）")
              : (findings.vulnerabilities.length + findings.hypotheses.length === 0
                  ? h("div", { style: MUTED }, "（当前没有标注为重要的新发现）")
                  : h("div", { style: { display: "flex", flexDirection: "column", gap: 6, marginTop: 4 } },
                      findings.vulnerabilities.map((v) => h("div", {
                        key: v.id, style: { border: "1px solid var(--sorne-border)", borderRadius: 8, padding: "6px 9px", background: "var(--sorne-bg-surface)" },
                      },
                        h("div", { style: { display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" } },
                          idChip(ui, router, projectId, v.id),
                          h("span", { style: COUNT }, "漏洞"),
                          ui.StatusBadge ? ui.StatusBadge("vulnerability_status", v.status) : String(v.status || "—（未提供）"),
                          v.review ? h("span", { style: COUNT }, "复核：", ui.StatusBadge ? ui.StatusBadge("review_status", v.review) : v.review) : null,
                        ),
                        h("div", { style: { fontSize: 13.5, color: "var(--sorne-text-primary)", lineHeight: 1.6, wordBreak: "break-word" } },
                          (v.category || "类别未提供") + (v.location ? " @ " + v.location : "")),
                      )),
                      findings.hypotheses.map((hy) => h("div", {
                        key: hy.id, style: { border: "1px solid var(--sorne-border)", borderRadius: 8, padding: "6px 9px", background: "var(--sorne-bg-surface)" },
                      },
                        h("div", { style: { display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" } },
                          idChip(ui, router, projectId, hy.id),
                          h("span", { style: COUNT }, "假设"),
                          hy.status ? h("span", { style: { ...COUNT, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" } }, "状态：" + hy.status) : null,
                        ),
                        h("div", { style: { fontSize: 13.5, color: "var(--sorne-text-primary)", lineHeight: 1.6, wordBreak: "break-word" } },
                          hy.statement || "—（未提供）"),
                      )),
                    )),
          findings && findings.note
            ? h("div", { style: { ...MUTED, marginTop: 4 } }, findings.note)
            : null,
          h("div", { style: SUB }, "近期新增记录（按已加载事件推导，不代表全量）"),
          newRecords.length
            ? h("div", { style: { display: "flex", flexDirection: "column", gap: 3, marginTop: 4 } },
                newRecords.slice(0, 8).map((r) => h("div", { key: r.id + "-" + r.eventType, style: { fontSize: 13.5, color: "var(--sorne-text-primary)" } },
                  idChip(ui, router, projectId, r.id),
                  h("span", { style: COUNT }, " · " + r.eventType + " · " + ui.formatTime(r.at)),
                )),
              )
            : h("div", { style: MUTED },
                this.state.changes.phase === "loading" ? "正在读取事件流…" :
                  this.state.changes.phase === "ready" ? "（已加载事件中暂无新增资产/线索；未加载页不含在内）" : "—（未提供：变化流不可用）"),
          h("div", { style: { ...MUTED, marginTop: 6 } },
            "发现状态以数据库为准并原样展示：疑似不会被提升为已确认；确认必须经独立验证（页面不提供改状态入口）。"),
        );
      }

      /* ── 渲染：需要我做什么 ───────────────────────────────────── */

      renderNeed() {
        const { h, ui, router } = this.props;
        const projectId = this.state.projectId;
        const blocked = this.blockedIntents();
        const reports = this.pendingReports();
        const pendingItems = this.pendingItems();
        const vjobs = this.verificationList().filter((j) => j && (j.status === "pending" || j.status === "in_progress"));
        const items = [];
        for (const it of blocked) {
          items.push(h("div", {
            key: "blk-" + it.id,
            style: { border: "1px solid var(--sorne-status-suspected-fg)", borderRadius: 8, padding: "6px 9px", background: "var(--sorne-status-suspected-bg)", color: "var(--sorne-status-suspected-fg)" },
          },
            h("div", { style: { display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap", fontSize: 13.5 } },
              h("span", { style: { fontWeight: 600 } }, "受阻方向"),
              idChip(ui, router, projectId, it.id),
              it.blocked_detail && it.blocked_detail.report_id ? h("span", null, "汇报：", idChip(ui, router, projectId, it.blocked_detail.report_id)) : null,
            ),
            h("div", { style: { fontSize: 13.5, lineHeight: 1.6, wordBreak: "break-word" } },
              "缺什么：" + ((it.blocked_detail && it.blocked_detail.note) || "原因未提供")),
            Array.isArray(it.resume_conditions) && it.resume_conditions.length
              ? h("div", { style: { fontSize: 13.5, lineHeight: 1.6, wordBreak: "break-word" } },
                  "恢复条件：" + it.resume_conditions.join("；"))
              : null,
          ));
        }
        for (const job of vjobs.slice(0, 6)) {
          items.push(h("div", { key: "vj-" + job.id, style: ROW },
            h("div", { style: { display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap", fontSize: 13.5 } },
              h("span", { style: { fontWeight: 600 } }, "待验证"),
              idChip(ui, router, projectId, job.id),
              job.subject_id ? h("span", null, "判断：", idChip(ui, router, projectId, job.subject_id)) : null,
              ui.StatusBadge ? ui.StatusBadge("job_status", job.status) : String(job.status || "—（未提供）"),
            ),
            h("div", { style: COUNT },
              "等待时长：" + (job.created_at ? formatDuration(Math.max(0, Date.now() - new Date(job.created_at).getTime())) : "—（未提供，不臆造时长）")),
          ));
        }
        if (reports && reports.items.length) {
          for (const r of reports.items.slice(0, 8)) {
            items.push(h("div", { key: "rep-" + r.id, style: ROW },
              h("div", { style: { display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap", fontSize: 13.5 } },
                h("span", { style: { fontWeight: 600 } }, "未处理汇报"),
                h("button", {
                  type: "button",
                  "aria-label": "查看未处理汇报 " + r.id + " 详情",
                  onClick: () => this.openDetail(r.id),
                  style: {
                    background: "transparent", border: "none", padding: 0, font: "inherit",
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                    color: "var(--sorne-brand)", cursor: "pointer", textDecoration: "underline",
                  },
                }, String(r.id || "—（未提供）")),
                h("span", { style: COUNT }, REPORT_KIND_TEXT[r.kind] || r.kind_text || r.kind || "—（未提供）"),
                r.intent_id ? h("span", { style: COUNT }, "意图：", idChip(ui, router, projectId, r.intent_id)) : null,
                h("span", { style: COUNT }, "处理状态：" + (REPORT_HANDLING_TEXT[r.handling_status] || r.handling_status || "—（未提供）")),
              ),
              r.task_question ? h("div", { style: { fontSize: 13.5, color: "var(--sorne-text-primary)", lineHeight: 1.6 } }, "任务：" + r.task_question) : null,
              r.actual_outcome ? h("div", { style: COUNT }, "实际完成：" + r.actual_outcome) : null,
            ));
          }
        }
        const reportsTruncated = Boolean(reports && reports.items.length > 8);
        return h("section", { key: "need", "aria-label": "需要我做什么", style: CARD },
          h("h3", { style: H3 }, "需要我做什么"),
          this.state.overview.phase === "loading"
            ? h("div", { style: MUTED }, "正在读取待办…")
            : this.state.overview.phase === "notimpl"
              ? this.notImplCard("工作概览", this.state.overview.error)
              : this.state.overview.phase === "error"
                ? this.errorCard("工作概览不可用", this.state.overview.error)
                : items.length
                  ? h("div", { style: { display: "flex", flexDirection: "column", gap: 6, marginTop: 4 } }, items)
                  : h("div", { style: MUTED }, "（当前没有需要你处理的事项）"),
          reportsTruncated
            ? h("div", { style: { ...MUTED, marginTop: 2 } }, "未处理汇报仅显示前 8 条（共 " + reports.items.length + " 条已加载；完整清单以持久记录为准）。")
            : null,
          pendingItems && num(pendingItems.needs_clarification_reports) !== null
            ? h("div", { style: { ...MUTED, marginTop: 4 } },
                "需补充说明的汇报 " + pendingItems.needs_clarification_reports + " 份 · 已暂缓汇报 " + numText(pendingItems.deferred_reports) + " 份")
            : null,
          pendingItems && pendingItems.interrupted_actions && Array.isArray(pendingItems.interrupted_actions.items) && pendingItems.interrupted_actions.items.length
            ? h("div", { style: { marginTop: 6 } },
                h("div", { style: SUB }, "待完成动作（决定已保存但动作未完成——逐项核对，不盲目重放）"),
                pendingItems.interrupted_actions.items.slice(0, 6).map((a) => h("div", {
                  key: a.action_id || a.decision_id, style: { fontSize: 13.5, color: "var(--sorne-text-primary)", lineHeight: 1.6, wordBreak: "break-word" },
                }, "· ", idChip(ui, router, projectId, a.action_id), " · " + (a.action_kind || "—") +
                  " · 决定 ", idChip(ui, router, projectId, a.decision_id), (a.rationale ? "：" + a.rationale : ""))),
              )
            : null,
          h("div", { style: { ...MUTED, marginTop: 6 } },
            "恢复与重派由协调 AI 决定，程序不写死固定重试（见语义说明）；点击未处理汇报编号在右侧详情展开三层汇报。"),
        );
      }

      /* ── 渲染：对话区 ─────────────────────────────────────────── */

      renderConversation() {
        const { h, ui, router } = this.props;
        const projectId = this.state.projectId;
        const compose = this.state.compose;
        const all = this.messageList();
        const list = all.slice().reverse(); /* API 新到旧 → 对话按时间正序 */
        const repliesByParent = new Map();
        for (const m of all) {
          if (m && m.direction === "ai" && m.reply_to) {
            if (!repliesByParent.has(m.reply_to)) repliesByParent.set(m.reply_to, []);
            repliesByParent.get(m.reply_to).push(m);
          }
        }
        const linkChips = (m) => {
          const links = Array.isArray(m.links) ? m.links : [];
          if (!links.length) return null;
          return h("span", { style: { display: "inline-flex", gap: 6, flexWrap: "wrap" } },
            links.map((link, i) => h("span", { key: (link.kind || "k") + "-" + (link.ref_id || i), style: { display: "inline-flex", gap: 4, alignItems: "baseline" } },
              h("span", { style: { fontSize: 13, color: "var(--sorne-text-secondary)" } }, (LINK_KIND_TEXT[link.kind] || link.kind) + "："),
              idChip(ui, router, projectId, link.ref_id),
              i < links.length - 1 ? h("span", { style: { color: "var(--sorne-text-muted)" } }, " · ") : null,
            )));
        };
        const attachmentNodes = (m) => {
          const atts = Array.isArray(m.attachments) ? m.attachments : [];
          if (!atts.length) return null;
          return h("div", { style: { display: "flex", gap: 6, flexWrap: "wrap", alignItems: "baseline", marginTop: 2 } },
            h("span", { style: { fontSize: 13, color: "var(--sorne-text-secondary)" } }, "附件："),
            atts.map((att, i) => h("span", { key: (att.ref || i) + "-" + i, style: { display: "inline-flex", gap: 4, alignItems: "baseline" } },
              idChip(ui, router, projectId, att.ref),
              h("span", { style: { fontSize: 13, color: "var(--sorne-text-muted)" } },
                "（" + (att.kind === "blob" ? "证据字节" : att.kind === "capture" ? "采集" : att.kind) + "）"),
            )),
          );
        };
        const renderMessage = (m) => {
          const isUser = m.direction !== "ai";
          const replies = isUser && m.id ? (repliesByParent.get(m.id) || []) : [];
          return h("div", {
            key: m.id || (m.direction + "-" + m.created_seq),
            style: {
              border: "1px solid var(--sorne-border)", borderRadius: 8, padding: "8px 10px",
              background: isUser ? "var(--sorne-bg-surface)" : "var(--sorne-bg-subtle)",
            },
          },
            h("div", { style: { display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" } },
              h("span", { style: { fontWeight: 600, fontSize: 13.5, color: "var(--sorne-text-primary)" } },
                MESSAGE_DIRECTION_TEXT[m.direction] || m.direction || "—"),
              idChip(ui, router, projectId, m.id),
              messageStatusNode(h, ui, m.status),
              h("span", { style: { fontSize: 13, color: "var(--sorne-text-muted)" } }, ui.formatTime(m.created_at)),
            ),
            h("div", { style: { fontSize: 14, color: "var(--sorne-text-primary)", lineHeight: 1.6, marginTop: 4, whiteSpace: "pre-wrap", wordBreak: "break-word" } },
              m.content || "—（未提供）"),
            attachmentNodes(m),
            isUser
              ? h("div", { style: { marginTop: 6, display: "flex", flexDirection: "column", gap: 2, fontSize: 13.5 } },
                  h("div", { style: { color: "var(--sorne-text-secondary)" } },
                    "① 已接收：" + (MESSAGE_STATUS_TEXT[m.status] || (m.status ? "未知状态（" + m.status + "）" : "—（未提供）")) +
                    " · " + ui.formatTime(m.created_at)),
                  h("div", { style: { color: "var(--sorne-text-secondary)" } }, "② 对应任务：",
                    Array.isArray(m.links) && m.links.length ? linkChips(m)
                      : h("span", { style: { color: "var(--sorne-text-muted)" } }, "尚未关联任务（AI 处理前）")),
                  h("div", { style: { color: "var(--sorne-text-secondary)" } }, "③ AI 处理结果：",
                    replies.length
                      ? h("span", { style: { color: "var(--sorne-text-primary)" } }, replies.map((r) => r.content || "—").join(" / "))
                      : h("span", { style: { color: "var(--sorne-text-muted)" } },
                          m.status === "handled" ? "已处理（AI 回复未在已加载消息中呈现）" : "尚未处理（收到 ≠ 已处理；AI 读取并作出决定后才算处理）")),
                )
              : h("div", { style: { marginTop: 4 } }, linkChips(m)),
          );
        };
        return h("section", { key: "talk", "aria-label": "与 AI 对话", style: CARD },
          h("h3", { style: H3 }, "与 AI 对话"),
          h("div", { style: SUB },
            "消息发给协调 AI：消息先「已接收」，AI 读取并作出决定后才有对应任务与回复。收到 ≠ 已处理。"),
          h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap", marginTop: 6 } },
            h("input", {
              type: "text",
              "aria-label": "消息内容",
              placeholder: "向 AI 说明目标或调整探索重点…",
              value: compose.content,
              onChange: (e) => this.patchCompose({ content: e.target.value }),
              onKeyDown: (e) => { if (e.key === "Enter") this.sendMessage(); },
              style: { ...INPUT, flex: "1 1 320px" },
            }),
            h("button", {
              type: "button", "aria-label": "发送消息", disabled: compose.busy,
              onClick: () => this.sendMessage(), style: btnStyle("primary", compose.busy),
            }, compose.busy ? "发送中…" : "发送"),
          ),
          h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap", marginTop: 6, alignItems: "baseline" } },
            h("input", {
              type: "text",
              "aria-label": "附件编号（可选）",
              placeholder: "附件编号（可选，逗号分隔：B-0001、CAP-0007）",
              value: compose.attachments,
              onChange: (e) => this.patchCompose({ attachments: e.target.value }),
              style: { ...INPUT, flex: "1 1 320px" },
            }),
            h("span", { style: { fontSize: 13, color: "var(--sorne-text-muted)" } },
              "附件需先经 /evidence/blobs（#11）或 /captures（#12）上传取得编号；随消息以 attachments 提交，AI 经 read_blob/read_record 读取。"),
          ),
          compose.error ? h("div", { role: "alert", style: { marginTop: 6, fontSize: 13.5, color: "var(--sorne-status-unknown-fg)", lineHeight: 1.6 } }, compose.error) : null,
          compose.notice ? h("div", { role: "status", style: { marginTop: 6, fontSize: 13.5, color: "var(--sorne-status-ok-fg)", lineHeight: 1.6 } }, compose.notice) : null,
          h("div", { style: { marginTop: 8, display: "flex", flexDirection: "column", gap: 6 } },
            this.state.messages.phase === "loading"
              ? h("div", { style: MUTED }, "正在读取消息…")
              : this.state.messages.phase === "notimpl"
                ? this.notImplCard("消息通道", this.state.messages.error)
                : this.state.messages.phase === "error"
                  ? this.errorCard("消息读取失败", this.state.messages.error)
                  : list.length
                    ? list.map(renderMessage)
                    : ui.EmptyState({
                        title: "还没有消息",
                        hint: "向 AI 说明探索目标或调整重点；消息会先进入「已接收」，AI 处理后再出现对应任务与回复。",
                      }),
            this.state.messages.phase === "ready" && list.length
              ? h("div", { style: { ...MUTED, marginTop: 2 } },
                  "已加载 " + list.length + " 条消息（首屏最近 50 条" +
                  (this.state.messages.data && this.state.messages.data.has_more ? "；更早消息可加载更多" : "；已到最早") + "）。")
              : null,
            this.state.messages.phase === "ready" && this.state.messages.data && this.state.messages.data.has_more
              ? h("button", {
                  type: "button", "aria-label": "加载更多消息（更早）", onClick: () => this.loadMoreMessages(),
                  style: btnStyle(null),
                }, "加载更多消息（更早）")
              : null,
            this.state.messages.error && this.state.messages.phase === "ready"
              ? h("div", { role: "alert", style: { ...ERR, marginTop: 4 } }, "消息续读失败：" + errorMessage(this.state.messages.error))
              : null,
          ),
        );
      }

      /* ── 通用错误/未实现卡 ────────────────────────────────────── */

      notImplCard(label, error) {
        const { h } = this.props;
        return h("div", { role: "status", style: { ...WARN, marginTop: 4 } },
          h("div", { style: { fontWeight: 600 } }, label + "未实现"),
          h("div", null, "该端点尚未实装（501 未实现 ≠ 报错）：" + errorMessage(error)),
        );
      }

      errorCard(label, error) {
        const { h } = this.props;
        return h("div", { role: "alert", style: { ...ERR, marginTop: 4 } },
          h("div", { style: { fontWeight: 600 } }, label),
          h("div", null, errorMessage(error)),
        );
      }

      render() {
        const { h } = this.props;
        const projectId = this.state.projectId;
        if (!projectId) {
          return h("div", { style: WRAP },
            h("h2", { style: { margin: 0, fontSize: 17, color: "var(--sorne-text-primary)" } }, "工作台"),
            h("div", { role: "status", style: MUTED },
              "缺少项目上下文（路由未携带 projectId）——工作台在项目工作区内渲染；请从项目列表进入。"),
          );
        }
        if (!this.props.ui || typeof this.props.ui.formatTime !== "function") {
          return h("div", { style: WRAP },
            h("h2", { style: { margin: 0, fontSize: 17, color: "var(--sorne-text-primary)" } }, "工作台"),
            h("div", { role: "alert", style: ERR },
              "渲染器未就绪：工作台依赖设计系统渲染器（ui.formatTime / StatusBadge / RecordIdChip）。当前宿主未提供，页面以降级态呈现，不做数据猜测。"),
          );
        }
        return h("div", { style: WRAP },
          this.renderHeader(),
          this.renderPauseFeedback(),
          this.renderProgress(),
          this.renderOverviewCards(),
          this.renderDoing(),
          this.renderGained(),
          this.renderNeed(),
          this.renderConversation(),
          h("div", { key: "foot", style: { fontSize: 13, color: "var(--sorne-text-muted)", lineHeight: 1.6 } },
            "计数按已加载数据推导，不代表全量；数据时刻见页头。未提供 ≠ 不存在（缺失值显示「—（未提供）」）。"),
        );
      }
    }

    return h(WorkbenchBody, { React, h, api, router, ui, theme });
  },

  /* ── 右侧详情（§2.4-2）：汇报三层 / 基线 / 其它编号转记录覆盖层 ── */

  renderDetail({ React, h, api, router, ui, theme }) {
    VOCAB_REF = ui && ui.VOCAB ? ui.VOCAB : null;
    const ComponentBase = React && typeof React.Component === "function"
      ? React.Component
      : class PageComponentBase { constructor(props) { this.props = props || {}; } };

    class WorkbenchDetail extends ComponentBase {
      constructor(props) {
        super(props);
        const r = props.router || {};
        const id = r.params && r.params.id ? String(r.params.id) : "";
        this.state = {
          id: id,
          projectId: r.projectId ? String(r.projectId) : "",
          phase: "loading",
          data: null,
          error: null,
          layers: {
            keyRecords: { open: false, phase: "idle", data: null, error: null },
            fullBasis: { open: false, phase: "idle", data: null, error: null },
          },
          chain: [],
          notice: "",
          seq: 0,
        };
      }

      componentDidMount() {
        if (this.isReportId(this.state.id)) this.loadReport(this.state.id);
        else this.setState({ phase: "other" });
      }

      isReportId(id) {
        if (typeof id !== "string" || !id) return false;
        const parsed = this.props.ui && typeof this.props.ui.parseRecordId === "function"
          ? this.props.ui.parseRecordId(id) : null;
        if (parsed) return parsed.prefix === "WR";
        return id.indexOf("WR-") === 0;
      }

      async loadReport(reportId, options) {
        const opts = options || {};
        const { api } = this.props;
        const projectId = this.state.projectId;
        if (typeof api !== "function") {
          this.setState({ phase: "error", data: null, error: { code: "NO_API", message: "当前宿主未提供 API 通道" } });
          return;
        }
        const prevData = this.state.data;
        const nextChain = Array.isArray(opts.chain) ? opts.chain
          : (opts.asBase && prevData && prevData.report_id ? this.state.chain.concat([prevData.report_id]) : []);
        const seq = this.state.seq + 1;
        this.setState({
          id: reportId, phase: "loading", data: null, error: null, chain: nextChain, notice: "", seq: seq,
          layers: {
            keyRecords: { open: false, phase: "idle", data: null, error: null },
            fullBasis: { open: false, phase: "idle", data: null, error: null },
          },
        });
        try {
          const data = await api("/sorne/worker-reports/" + encodeURIComponent(reportId) +
            "?project_id=" + encodeURIComponent(projectId) + "&layer=handoff_card");
          if (this.state.seq !== seq) return;
          if (!data || typeof data !== "object" || Array.isArray(data)) {
            this.setState({ phase: "unrecognized", data: null, error: null });
            return;
          }
          this.setState({ phase: "ready", data: data, error: null });
        } catch (e) {
          if (this.state.seq !== seq) return;
          this.setState({ phase: isNotImplemented(e) ? "notimpl" : "error", data: null, error: e });
        }
      }

      async loadLayer(layerKey, options) {
        const opts = options || {};
        const { api } = this.props;
        const id = this.state.id;
        const projectId = this.state.projectId;
        if (typeof api !== "function") return;
        const layerValue = layerKey === "keyRecords" ? "key_records" : "full_basis";
        this.setState((prev) => ({
          layers: Object.assign({}, prev.layers, {
            [layerKey]: Object.assign({}, prev.layers[layerKey], { open: true, phase: "loading", error: null }),
          }),
        }));
        let query = "?project_id=" + encodeURIComponent(projectId) + "&layer=" + layerValue;
        if (opts.page) query += "&page=" + encodeURIComponent(String(opts.page));
        try {
          const data = await api("/sorne/worker-reports/" + encodeURIComponent(id) + query);
          if (this.state.id !== id) return;
          const inner = data && data[layerValue] && typeof data[layerValue] === "object" ? data[layerValue] : null;
          if (!inner) {
            this.setState((prev) => ({
              layers: Object.assign({}, prev.layers, { [layerKey]: Object.assign({}, prev.layers[layerKey], { phase: "unrecognized", data: null, error: null }) }),
            }));
            return;
          }
          this.setState((prev) => ({
            layers: Object.assign({}, prev.layers, { [layerKey]: Object.assign({}, prev.layers[layerKey], { open: true, phase: "ready", data: { meta: data, layer: inner }, error: null }) }),
          }));
        } catch (e) {
          this.setState((prev) => ({
            layers: Object.assign({}, prev.layers, { [layerKey]: Object.assign({}, prev.layers[layerKey], { open: true, phase: isNotImplemented(e) ? "notimpl" : "error", data: null, error: e }) }),
          }));
        }
      }

      /** 交接卡分页续读：追加分组，不丢已读（不静默截断）。 */
      async loadHandoffPage(page) {
        const { api } = this.props;
        const id = this.state.id;
        const projectId = this.state.projectId;
        if (!this.state.data || typeof api !== "function") return;
        try {
          const res = await api("/sorne/worker-reports/" + encodeURIComponent(id) +
            "?project_id=" + encodeURIComponent(projectId) + "&layer=handoff_card&page=" + encodeURIComponent(String(page)));
          if (this.state.id !== id) return;
          const card = res && res.handoff_card && typeof res.handoff_card === "object" ? res.handoff_card : null;
          if (!card) return;
          this.setState((prev) => {
            if (!prev.data) return {};
            const prevCard = prev.data.handoff_card && typeof prev.data.handoff_card === "object" ? prev.data.handoff_card : null;
            if (!prevCard) return {};
            const seen = new Set((Array.isArray(prevCard.groups) ? prevCard.groups : []).map((g) => g && g.group_id));
            const merged = (Array.isArray(prevCard.groups) ? prevCard.groups : []).slice();
            for (const g of Array.isArray(card.groups) ? card.groups : []) {
              if (!seen.has(g && g.group_id)) merged.push(g);
            }
            return { data: Object.assign({}, prev.data, { handoff_card: Object.assign({}, card, { groups: merged }) }), notice: "" };
          });
        } catch (e) {
          this.setState({ notice: "续读失败：" + errorMessage(e) + "（已读分组保留，可重试）" });
        }
      }

      /** 读取入口路由：同汇报层直达 / 其它汇报基线下钻 / 记录与采集 → 记录覆盖层。 */
      routeRef(pointer) {
        const raw = String(pointer || "").trim();
        if (!raw) return;
        const { ui, router } = this.props;
        if (raw.indexOf("/sorne/worker-reports/") === 0) {
          const m = /^\/sorne\/worker-reports\/([^/?]+)/.exec(raw);
          if (!m) return;
          const targetId = m[1];
          const lm = /[?&]layer=([^&]+)/.exec(raw);
          const pm = /[?&]page=([^&]+)/.exec(raw);
          const layer = lm ? lm[1] : "handoff_card";
          if (targetId === this.state.id) {
            if (layer === "key_records") this.loadLayer("keyRecords");
            else if (layer === "full_basis") this.loadLayer("fullBasis");
            else if (pm) this.loadHandoffPage(Number(pm[1]));
            return;
          }
          this.loadReport(targetId, { asBase: true });
          if (layer === "key_records") this.loadLayer("keyRecords");
          else if (layer === "full_basis") this.loadLayer("fullBasis");
          return;
        }
        const recMatch = /\/sorne\/records\/([^/?]+)/.exec(raw) || /\/sorne\/captures\/([^/?]+)/.exec(raw);
        if (recMatch) {
          if (router && typeof router.openRecord === "function") router.openRecord(decodeURIComponent(recMatch[1]));
          return;
        }
        if (ui && typeof ui.parseRecordId === "function") {
          const parsed = ui.parseRecordId(raw);
          if (parsed && parsed.id) {
            if (router && typeof router.openRecord === "function") router.openRecord(parsed.id);
            return;
          }
        }
        this.setState({ notice: "读取入口（原样展示，未猜测目标）：" + raw });
      }

      popChain() {
        const chain = Array.isArray(this.state.chain) ? this.state.chain : [];
        if (!chain.length) return;
        const backId = chain[chain.length - 1];
        this.loadReport(backId, { chain: chain.slice(0, -1) });
      }

      toggleLayer(layerKey) {
        const layer = this.state.layers[layerKey];
        if (layer.open) {
          this.setState((prev) => ({
            layers: Object.assign({}, prev.layers, { [layerKey]: Object.assign({}, prev.layers[layerKey], { open: false }) }),
          }));
          return;
        }
        if (layer.phase === "ready" || layer.phase === "loading") {
          this.setState((prev) => ({
            layers: Object.assign({}, prev.layers, { [layerKey]: Object.assign({}, prev.layers[layerKey], { open: true }) }),
          }));
          return;
        }
        this.loadLayer(layerKey);
      }

      textNodes(text) {
        const { ui, router } = this.props;
        const nodes = textWithChips(text, ui, router, this.state.projectId);
        return Array.isArray(nodes) ? nodes : [nodes];
      }

      renderGroupLines(lines) {
        const { h } = this.props;
        const list = Array.isArray(lines) ? lines : [];
        return list.map((line, i) => h("div", {
          key: "ln-" + i, style: { fontSize: 13.5, color: "var(--sorne-text-primary)", lineHeight: 1.6, wordBreak: "break-word" },
        }, "· ", this.textNodes(line)));
      }

      renderHandoff(data) {
        const { h } = this.props;
        const card = data.handoff_card && typeof data.handoff_card === "object" ? data.handoff_card : null;
        if (!card) {
          return h("div", { style: MUTED }, "—（交接卡未提供：该版本没有 handoff_card 区块；未提供 ≠ 不存在）");
        }
        const groups = Array.isArray(card.groups) ? card.groups : [];
        const omitted = Array.isArray(card.omitted_from_this_page) ? card.omitted_from_this_page : [];
        const notes = [card.pagination_note, card.ai_note, card.status_note].filter((s) => typeof s === "string" && s);
        const nextPage = num(card.next_page);
        return h("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
          notes.map((n, i) => h("div", { key: "note-" + i, style: MUTED }, n)),
          groups.length
            ? groups.map((g, gi) => h("div", {
                key: g.group_id || "g-" + gi,
                style: { borderTop: gi === 0 ? "none" : "1px dashed var(--sorne-border)", paddingTop: gi === 0 ? 0 : 4 },
              },
                h("div", { style: { fontSize: 13.5, fontWeight: 600, color: "var(--sorne-text-primary)" } }, g.title || g.type || "（分组）"),
                this.renderGroupLines(g.lines),
              ))
            : h("div", { style: MUTED }, "（交接卡未提供分组内容）"),
          omitted.length
            ? h("div", { style: Object.assign({}, WARN, { marginTop: 4 }) },
                h("div", { style: { fontWeight: 600 } }, "本页未包含的分组（超预算显式列明，不静默截断）："),
                omitted.map((o, i) => h("div", { key: "om-" + i, style: { fontSize: 13.5, lineHeight: 1.6, wordBreak: "break-word" } },
                  "· 类型 " + (o.type || "—") + (num(o.count) !== null ? " · " + o.count + " 组" : "") + " · 读取入口：",
                  o.read_pointer
                    ? h("button", {
                        type: "button", "aria-label": "续读后续分组", onClick: () => this.routeRef(o.read_pointer),
                        style: Object.assign({}, btnStyle("quiet"), { padding: "1px 6px" }),
                      }, "续读后续分组")
                    : "—（未提供）",
                )),
              )
            : null,
          card.has_more && nextPage !== null
            ? h("div", { style: { marginTop: 4, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" } },
                h("button", {
                  type: "button",
                  "aria-label": "加载下一页交接卡（第 " + nextPage + " 页）",
                  onClick: () => this.loadHandoffPage(nextPage),
                  style: btnStyle(null),
                }, "加载下一页交接卡（第 " + nextPage + " 页 / 共 " + (num(card.total_pages) !== null ? card.total_pages : "?") + " 页）"),
                h("span", { style: MUTED }, "交接卡按长度预算分组分页；任何条目不截断、不确定性与反对证据不删除。"),
              )
            : null,
        );
      }

      renderFindings(findings) {
        const { h, ui, router } = this.props;
        const list = Array.isArray(findings) ? findings : [];
        if (!list.length) return h("div", { style: MUTED }, "发现清单：未提供（或无）");
        return h("div", { style: { display: "flex", flexDirection: "column", gap: 3, marginTop: 2 } },
          list.map((f, i) => h("div", {
            key: (f.record_id || "f") + "-" + i,
            style: { fontSize: 13.5, lineHeight: 1.6, color: "var(--sorne-text-primary)", wordBreak: "break-word" },
          },
            "· ", idChip(ui, router, this.state.projectId, f.record_id),
            f.type ? h("span", { style: COUNT }, " · " + f.type) : null,
            h("span", { style: COUNT }, " · 当前状态：" + (f.current_status || "—（未提供）")),
            f.db && f.db.exists
              ? h("span", { style: COUNT }, "（库内当前 " + (f.db.status === null || f.db.status === undefined ? "—" : f.db.status) +
                  (f.db.review ? " · 复核 " + f.db.review : "") + "）")
              : h("span", { style: COUNT }, "（库内：记录不存在）"),
            f.short_statement ? h("span", null, "：" + f.short_statement) : null,
            f.status_note ? h("div", { style: MUTED }, "（" + f.status_note + "）") : null,
          )),
        );
      }

      renderAdvice(actions) {
        const { h } = this.props;
        const list = Array.isArray(actions) ? actions : [];
        if (!list.length) return null;
        const ai = list.some((a) => a && a.ai_advice === true);
        return h("div", { style: { fontSize: 13.5, color: "var(--sorne-text-primary)", lineHeight: 1.6, wordBreak: "break-word" } },
          "需要的决策（建议后续动作）：" + list.map((a) => (a && a.advice) || "—").join("；"),
          ai ? "（AI 建议单独标注，不能替代原记录状态）" : "");
      }

      renderOmitted(list) {
        const { h } = this.props;
        const arr = Array.isArray(list) ? list : [];
        if (!arr.length) return h("div", { style: MUTED }, "遗漏与省略分区：未提供（或无）");
        return h("div", { style: { marginTop: 2 } },
          h("div", { style: { fontSize: 13.5, fontWeight: 600, color: "var(--sorne-text-primary)" } },
            "遗漏与省略分区（未列入交接卡的内容在此显式列明，不静默截断）："),
          arr.map((o, i) => h("div", { key: "ok-" + i, style: { fontSize: 13.5, lineHeight: 1.6, wordBreak: "break-word" } },
            "· 类型 " + (o.type || "—") + (num(o.count) !== null ? " · " + o.count + " 条" : "") + " · 读取入口：",
            o.read_pointer
              ? h("button", {
                  type: "button", "aria-label": "展开遗漏分区读取入口", onClick: () => this.routeRef(o.read_pointer),
                  style: Object.assign({}, btnStyle("quiet"), { padding: "1px 6px" }),
                }, String(o.read_pointer))
              : "—（未提供）",
          )),
        );
      }

      renderKeyRecords(k) {
        const { h } = this.props;
        return h("div", { style: { display: "flex", flexDirection: "column", gap: 4, marginTop: 4 } },
          h("div", { style: { fontSize: 13.5, color: "var(--sorne-text-primary)" } }, "任务问题：" + (k.task_question || "—（未提供）")),
          h("div", { style: { fontSize: 13.5, color: "var(--sorne-text-primary)" } }, "实际完成：" + (k.actual_outcome || "—（未提供）")),
          h("div", { style: COUNT }, "执行状态：" + (k.execution_status || "—（未提供）")),
          h("div", { style: { fontSize: 13.5, fontWeight: 600, color: "var(--sorne-text-primary)", marginTop: 2 } }, "发现清单（状态以库为准并附声明值）："),
          this.renderFindings(k.important_findings),
          h("div", { style: COUNT }, "重要尝试：" + (Array.isArray(k.significant_attempts) && k.significant_attempts.length ? k.significant_attempts.join("；") : "未提供（或无）")),
          h("div", { style: COUNT }, "正反证据与矛盾：" + (Array.isArray(k.contradictions) && k.contradictions.length ? k.contradictions.join("；") : "未提供（或无）")),
          h("div", { style: COUNT }, "前提与状态变化：" + (Array.isArray(k.prerequisite_changes) && k.prerequisite_changes.length ? k.prerequisite_changes.join("；") : "未提供（或无）")),
          h("div", { style: COUNT }, "条件限制：" + (Array.isArray(k.material_conditions) && k.material_conditions.length ? k.material_conditions.join("；") : "未提供（或无）")),
          h("div", { style: COUNT }, "阻塞：" + (Array.isArray(k.blockers) && k.blockers.length ? k.blockers.join("；") : "未提供（或无）")),
          this.renderAdvice(k.proposed_next_actions),
          h("div", { style: COUNT }, "未解决问题：" + (Array.isArray(k.unresolved_questions) && k.unresolved_questions.length ? k.unresolved_questions.join("；") : "未提供（或无）")),
          this.renderOmitted(k.omitted_sections),
          Array.isArray(k.evidence_refs) && k.evidence_refs.length
            ? h("div", { style: { fontSize: 13.5, wordBreak: "break-word" } }, "证据引用：",
                k.evidence_refs.map((ref, i) => h("span", { key: String(ref) + "-" + i },
                  this.textNodes(String(ref)), i < k.evidence_refs.length - 1 ? "、" : "")))
            : h("div", { style: MUTED }, "证据引用：未提供（或无）"),
          k.expand_pointer
            ? h("div", { style: { fontSize: 13.5, wordBreak: "break-word" } }, "完整依据入口：",
                h("button", {
                  type: "button", "aria-label": "展开完整依据层", onClick: () => this.routeRef(k.expand_pointer),
                  style: Object.assign({}, btnStyle("quiet"), { padding: "1px 6px" }),
                }, String(k.expand_pointer)))
            : null,
          h("div", { style: MUTED }, "本层条目按编号展开；未在本层出现的记录仍持久保存，可按编号查询（未显示不等于不存在）。"),
        );
      }

      renderFullBasis(f) {
        const { h, ui } = this.props;
        return h("div", { style: { display: "flex", flexDirection: "column", gap: 4, marginTop: 4 } },
          Array.isArray(f.evidence_refs) && f.evidence_refs.length
            ? h("div", { style: { fontSize: 13.5, wordBreak: "break-word" } },
                "证据引用（执行记录、采集、请求响应、文件、验证结果；按编号或读取入口展开）：",
                f.evidence_refs.map((r, i) => h("div", { key: "fb-" + String(r.ref) + "-" + i, style: { fontSize: 13.5, lineHeight: 1.6 } },
                  "· ",
                  h("button", {
                    type: "button", "aria-label": "展开证据引用 " + String(r.ref), onClick: () => this.routeRef(r.read_pointer || r.ref),
                    style: Object.assign({}, btnStyle("quiet"), { padding: "1px 6px" }),
                  }, String(r.ref)),
                  r.read_pointer ? h("span", { style: MUTED }, "（读取入口 " + r.read_pointer + "）") : h("span", { style: MUTED }, "（无读取入口）"),
                )))
            : h("div", { style: MUTED }, "证据引用：未提供（或无）"),
          f.full_record_pointer
            ? h("div", { style: { fontSize: 13.5, wordBreak: "break-word" } }, "完整记录入口：",
                h("button", {
                  type: "button", "aria-label": "展开完整记录入口", onClick: () => this.routeRef(f.full_record_pointer),
                  style: Object.assign({}, btnStyle("quiet"), { padding: "1px 6px" }),
                }, String(f.full_record_pointer)))
            : null,
          f.manifest
            ? h("div", { style: { marginTop: 4 } },
                h("div", { style: { fontSize: 13.5, fontWeight: 600, color: "var(--sorne-text-primary)" } }, "本次汇报覆盖的记录清单（manifest）"),
                ui && ui.FoldableObject ? ui.FoldableObject(f.manifest, { defaultOpen: false }) : null)
            : null,
          f.note ? h("div", { style: MUTED }, f.note) : null,
          h("div", { style: MUTED }, "完整依据不默认送入模型；核查或继续执行时按编号读取。"),
        );
      }

      renderLayerBody(layerKey) {
        const { h } = this.props;
        const layer = this.state.layers[layerKey];
        if (layer.phase === "loading") return h("div", { style: MUTED }, "正在读取本层…");
        if (layer.phase === "notimpl") {
          return h("div", { style: Object.assign({}, WARN, { marginTop: 4 }) },
            h("div", { style: { fontWeight: 600 } }, "本层读取未实现"),
            h("div", null, "该层端点尚未实装（501 未实现 ≠ 报错）：" + errorMessage(layer.error)));
        }
        if (layer.phase === "error") {
          return h("div", { style: Object.assign({}, ERR, { marginTop: 4 }) }, "本层读取失败：" + errorMessage(layer.error));
        }
        if (layer.phase === "unrecognized") return h("div", { style: Object.assign({}, WARN, { marginTop: 4 }) }, "本层形状无法识别（数据源返回了未知结构）。");
        if (layer.phase !== "ready" || !layer.data) return h("div", { style: MUTED }, "（本层尚无数据）");
        return layerKey === "keyRecords" ? this.renderKeyRecords(layer.data.layer) : this.renderFullBasis(layer.data.layer);
      }

      renderRelative(meta) {
        const { h, ui } = this.props;
        const rel = meta.relative_to_base;
        if (!rel || typeof rel !== "object") {
          if (meta.changes_since_base) {
            return h("div", { style: { fontSize: 13.5, color: "var(--sorne-text-primary)", wordBreak: "break-word" } },
              "相对基线的变化：",
              ui && ui.FoldableObject ? ui.FoldableObject(meta.changes_since_base, { defaultOpen: false }) : String(meta.changes_since_base));
          }
          return null;
        }
        if (rel.missing) {
          return h("div", { style: MUTED }, "相对基线：基线汇报 " + String(rel.base_report_id || "—") + " 不存在或不可读（missing）。");
        }
        const added = Array.isArray(rel.new_record_ids) ? rel.new_record_ids : [];
        const dropped = Array.isArray(rel.dropped_record_ids) ? rel.dropped_record_ids : [];
        const unchanged = Array.isArray(rel.unchanged_record_ids) ? rel.unchanged_record_ids : [];
        return h("div", { style: { fontSize: 13.5, color: "var(--sorne-text-primary)", wordBreak: "break-word" } },
          "相对基线的变化（相对 " + String(rel.base_report_id || "—") + "）：",
          added.length ? "新增 " + added.join("、") : "无新增", " · ",
          dropped.length ? "移除 " + dropped.join("、") : "无移除", " · ",
          "未变 " + unchanged.length + " 条",
          rel.base_read_pointer
            ? h("button", {
                type: "button", "aria-label": "读取基线", onClick: () => this.routeRef(rel.base_read_pointer),
                style: Object.assign({}, btnStyle("quiet"), { marginLeft: 6, padding: "1px 8px" }),
              }, "读取基线")
            : null,
        );
      }

      renderUnavailable() {
        const { h } = this.props;
        const phase = this.state.phase;
        const error = this.state.error;
        if (phase === "notimpl") {
          return h("div", { style: Object.assign({}, WARN, { marginTop: 4 }) },
            h("div", { style: { fontWeight: 600 } }, "汇报读取未实现"),
            h("div", null, "该端点尚未实装（501 未实现 ≠ 报错）：" + errorMessage(error)));
        }
        if (phase === "error") {
          return h("div", { style: Object.assign({}, ERR, { marginTop: 4 }) },
            h("div", { style: { fontWeight: 600 } }, "汇报 " + this.state.id + " 读取失败"),
            h("div", null, errorMessage(error)));
        }
        if (phase === "unrecognized") {
          return h("div", { style: Object.assign({}, WARN, { marginTop: 4 }) },
            "汇报形状无法识别（数据源返回了未知结构；应为含 handoff_card 的汇报对象）。");
        }
        return null;
      }

      render() {
        const { h, ui, router } = this.props;
        const id = this.state.id;
        const projectId = this.state.projectId;
        const phase = this.state.phase;
        const data = this.state.data;
        const close = () => {
          if (router && typeof router.back === "function") {
            router.back("#/p/" + encodeURIComponent(projectId) + "/workbench");
          }
        };
        const header = h("div", { style: { display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap", marginBottom: 6 } },
          h("h3", { style: { margin: 0, fontSize: 15, color: "var(--sorne-text-primary)" } }, "详情"),
          h("span", { style: { fontSize: 13.5, color: "var(--sorne-text-secondary)", wordBreak: "break-all" } }, id || "—（未提供）"),
          h("button", {
            type: "button", "aria-label": "关闭详情", onClick: close, style: Object.assign({}, btnStyle("quiet"), { marginLeft: "auto" }),
          }, "关闭"),
        );
        if (phase === "other" || !this.isReportId(id)) {
          const parsed = ui && typeof ui.parseRecordId === "function" ? ui.parseRecordId(id) : null;
          return h("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
            header,
            h("div", { style: MUTED },
              "该编号不是汇报（WR-）编号：完整详情按编号经记录覆盖层读取，此处不重复实现第二套详情。"),
            h("button", {
              type: "button", "aria-label": "打开记录覆盖层",
              onClick: () => { if (router && typeof router.openRecord === "function") router.openRecord(id); },
              style: btnStyle("primary"),
            }, "打开记录"),
            parsed && parsed.kindLabel ? h("div", { style: MUTED }, "编号类型：" + parsed.kindLabel) : null,
          );
        }
        if (phase === "loading") {
          return h("div", { style: { display: "flex", flexDirection: "column", gap: 6 } }, header,
            h("div", { role: "status", style: MUTED }, "正在读取汇报 " + id + "…"));
        }
        const unavailable = this.renderUnavailable();
        if (unavailable) return h("div", { style: { display: "flex", flexDirection: "column", gap: 6 } }, header, unavailable);
        if (!data) return h("div", { style: { display: "flex", flexDirection: "column", gap: 6 } }, header, h("div", { style: MUTED }, "—（未提供）"));

        const boundary = data.boundary && typeof data.boundary === "object" ? data.boundary : {};
        const layers = this.state.layers;
        return h("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
          header,
          h("div", { style: { display: "flex", flexDirection: "column", gap: 3 } },
            h("div", { style: { display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" } },
              ui.StatusBadge ? ui.StatusBadge("report_kind", data.kind) : String(data.kind || "—（未提供）"),
              h("span", { style: COUNT }, "处理状态：" + (REPORT_HANDLING_TEXT[data.handling_status] || data.handling_status || "—（未提供）")),
              h("span", { style: COUNT }, "投递状态：" + (data.delivery_status || "—（未提供）")),
            ),
            data.intent_id ? h("div", { style: COUNT }, "意图：", idChip(ui, router, projectId, data.intent_id)) : null,
            data.attempt_id ? h("div", { style: COUNT }, "尝试：", idChip(ui, router, projectId, data.attempt_id)) : null,
            h("div", { style: { fontSize: 13.5, color: "var(--sorne-text-primary)", wordBreak: "break-word" } },
              "来源清单（Manifest）：", String(boundary.source_manifest_id || "—（未提供）"),
              " · 提交边界：", (boundary.source_commit_boundary === null || boundary.source_commit_boundary === undefined)
                ? "—（未提供）" : String(boundary.source_commit_boundary),
              num(boundary.latest_commit_seq) !== null
                ? "（项目当前提交边界 " + boundary.latest_commit_seq + "；其后新提交由后续增量通知覆盖）"
                : "（边界用于判定汇报时效）"),
            data.base_report_id
              ? h("div", { style: COUNT }, "基线汇报：", idChip(ui, router, projectId, data.base_report_id),
                  h("button", {
                    type: "button", "aria-label": "读取基线汇报", onClick: () => this.loadReport(data.base_report_id, { asBase: true }),
                    style: Object.assign({}, btnStyle("quiet"), { padding: "1px 8px", marginLeft: 6 }),
                  }, "读取基线汇报"))
              : null,
            data.replaces_report_id
              ? h("div", { style: COUNT }, "替代汇报：", idChip(ui, router, projectId, data.replaces_report_id)) : null,
            this.state.chain.length
              ? h("div", { style: Object.assign({}, MUTED, { wordBreak: "break-word" }) },
                  "当前沿基线下钻：" + this.state.chain.join(" → ") + " → 本汇报。",
                  h("button", {
                    type: "button", "aria-label": "返回上一份汇报", onClick: () => this.popChain(),
                    style: Object.assign({}, btnStyle("quiet"), { marginLeft: 6, padding: "1px 8px" }),
                  }, "返回上一份"))
              : null,
            this.renderRelative(data),
            this.state.notice ? h("div", { role: "status", style: MUTED }, this.state.notice) : null,
          ),
          h("div", { style: Object.assign({}, CARD, { marginTop: 2 }) },
            h("div", { style: { fontWeight: 600, fontSize: 13.5, marginBottom: 2, color: "var(--sorne-text-primary)" } }, "第一层 · 交接卡（默认接收）"),
            this.renderHandoff(data),
          ),
          h("div", { style: Object.assign({}, CARD, { marginTop: 2 }) },
            h("div", { style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" } },
              h("div", { style: { fontWeight: 600, fontSize: 13.5, color: "var(--sorne-text-primary)" } }, "第二层 · 关键记录层（按类型或编号展开）"),
              h("button", {
                type: "button", "aria-label": "展开或收起关键记录层", onClick: () => this.toggleLayer("keyRecords"),
                style: btnStyle("quiet"),
              }, layers.keyRecords.open ? "收起本层" : "展开本层")),
            layers.keyRecords.open
              ? this.renderLayerBody("keyRecords")
              : h("div", { style: MUTED }, "（本层默认收起——发现清单、重要尝试、正反证据、状态变化、遗漏与未知项按需展开）"),
          ),
          h("div", { style: Object.assign({}, CARD, { marginTop: 2 }) },
            h("div", { style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" } },
              h("div", { style: { fontWeight: 600, fontSize: 13.5, color: "var(--sorne-text-primary)" } }, "第三层 · 完整依据层（核查或继续执行时读取）"),
              h("button", {
                type: "button", "aria-label": "展开或收起完整依据层", onClick: () => this.toggleLayer("fullBasis"),
                style: btnStyle("quiet"),
              }, layers.fullBasis.open ? "收起本层" : "展开本层")),
            layers.fullBasis.open
              ? this.renderLayerBody("fullBasis")
              : h("div", { style: MUTED }, "（本层默认收起——执行记录、采集、请求响应、文件与验证结果在核查或继续执行时读取）"),
          ),
          h("div", { style: MUTED },
            "本页只读：不提供处理汇报或记录回执的入口；汇报处理由协调 AI 决定并持久化（delivered ≠ handled）。"),
        );
      }
    }

    return h(WorkbenchDetail, { React, h, api, router, ui, theme });
  },

};

/* ── 局部样式（全部经 --sorne-* token；无字面颜色值） ─────────────── */

const WRAP = { display: "flex", flexDirection: "column", gap: 12, width: "100%" };
const CARD = {
  background: "var(--sorne-bg-surface)",
  border: "1px solid var(--sorne-border)",
  borderRadius: 8,
  padding: "12px 14px",
};
const H3 = { margin: "0 0 6px", fontSize: 14.5, color: "var(--sorne-text-primary)" };
const SUB = { fontSize: 13.5, fontWeight: 600, color: "var(--sorne-text-primary)", marginTop: 8 };
const MUTED = { fontSize: 13.5, color: "var(--sorne-text-secondary)", lineHeight: 1.6 };
const COUNT = { fontSize: 13.5, color: "var(--sorne-text-secondary)" };
const WARN = {
  padding: "8px 10px", borderRadius: 8, fontSize: 13.5, lineHeight: 1.6,
  border: "1px dashed var(--sorne-status-suspected-fg)",
  background: "var(--sorne-status-suspected-bg)", color: "var(--sorne-status-suspected-fg)",
};
const ERR = {
  padding: "8px 10px", borderRadius: 8, fontSize: 13.5, lineHeight: 1.6,
  border: "1px dashed var(--sorne-status-unknown-fg)",
  background: "var(--sorne-status-unknown-bg)", color: "var(--sorne-status-unknown-fg)",
};
const ROW = {
  border: "1px solid var(--sorne-border)", borderRadius: 8, padding: "6px 9px",
  background: "var(--sorne-bg-surface)",
};
const INPUT = {
  fontSize: 14, padding: "6px 8px", borderRadius: 6, lineHeight: 1.55,
  border: "1px solid var(--sorne-border-strong)",
  background: "var(--sorne-bg-canvas)", color: "var(--sorne-text-primary)",
  boxSizing: "border-box", width: "100%", maxWidth: 640,
};

/* ── 时长格式化（时间绝对值由 ui.formatTime 承担；本文件不裸出 ISO 串） ── */

function formatDuration(ms) {
  const total = Math.max(0, Math.round(Number(ms) / 1000));
  const d = Math.floor(total / 86400);
  const hh = Math.floor((total % 86400) / 3600);
  const mm = Math.floor((total % 3600) / 60);
  const ss = total % 60;
  if (d > 0) return d + " 天 " + hh + " 小时";
  if (hh > 0) return hh + " 小时 " + mm + " 分";
  if (mm > 0) return mm + " 分 " + ss + " 秒";
  return ss + " 秒";
}
