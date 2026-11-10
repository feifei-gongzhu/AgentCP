/**
 * 页面：系统诊断（lib/ui/pages/diagnostics.page.mjs；M4 独占新增；BLUEPRINT-UI §1.5/§g）。
 *
 * 只回答一个问题：系统内部现在健康吗？数据面（全部只读，不写库、不发事件、不制造第二真值源）：
 *   - GET /sorne/diagnostics?project_id=…   #49 单项目聚合（llm/runtime 原文、health、plan、
 *       intents 九态计数、attempts/租约/unknown 工具调用、verification、reports、messages、
 *       outbox、projection、evidence；数据时刻 generated_at）；
 *   - GET /sorne/diagnostics               #49 全局面（项目四态分布；工作区页与项目面对照呈现）；
 *   - GET /sorne/metrics?project_id=…       #41 §20.2 指标全集（原始 JSON 折叠呈现）；
 *   - GET /sorne/change-log?project_id=…    #45 变化流只读视图（每事件一行摘要 + 主体编号
 *       chip + 一句人话；payload 折叠；按 event_type 分组计数；游标续读）；查看≠消费。
 *       注：#16 GET /changes 属消费者面（需程序签发会话，浏览器无签发通道），UI 只读面用 #45。
 *   - GET /sorne/attempts?project_id=…      #23 执行尝试/租约/fencing/工具调用（unknown 置顶红字）；
 *   - GET /sorne/health                     #3 健康检查（db/outbox/projects/sessions）。
 *
 * 语义纪律（冻结原文，不得改写；集中在本页「语义说明」折叠区，正文只留任务导向与数据）：
 *   - unknown 工具调用：「先检查外部现状再决定重试，不得当作已完成或已失败」（§10.2）；
 *   - 只读视图：「查看≠消费，delivered≠applied」；不写投递回执、不推进订阅游标；
 *   - 未提供≠不存在（「—（未提供）」）；折叠不删记录（展开入口 + 计数）；501 未实现≠报错；
 *   - 数据时刻/截止边界/不代表全量；计数按已加载数据推导；
 *   - resolved 只表示该版本的问题已处理，不代表关联资产已测透（规范 §10.1）；
 *   - 恢复与重派由协调 AI 决定，程序不写死固定重试（规范 §3.1/§3.2）；
 *   - 同项目默认最多一个规划调用在途（§16.1）；九态计数以库为准（§10.1）。
 *
 * 页面契约（BLUEPRINT-UI §2.5，冻结）：纯 ESM、不 import 任何包或 Node 内置模块、不使用
 * 浏览器本地存储、不使用 React 钩子（有状态部分收敛为单个类组件）；全部颜色经
 * var(--sorne-*) token；编号解析唯一实现为 ctx.ui.parseRecordId（本页无编号正则副本）；
 * 项目上下文来自 ctx.router.projectId（不重选项目）；导航响应经 router.onChange 订阅。
 */

const EVENT_SENTENCES = {
  "asset.discovered": "发现新资产",
  "observation.appended": "新增观察（证据已固定）",
  "hypothesis.proposed": "提出新假设",
  "relation.added": "建立记录关系",
  "dependency.changed": "依赖关系发生变化",
  "evidence_set.revised": "证据集合修订",
  "judgement.state_changed": "判断状态变化",
  "intent.blocked": "意图受阻（等待条件补齐）",
  "intent.completed": "意图标记完成",
  "plan.received": "计划修订已接收",
  "scope.revised": "范围版本变更",
  "resource_state.changed": "资源/执行状态变化",
  "resource.content_changed": "资源内容变化",
  "capture.completed": "采集完成",
  "verification.completed": "独立验证完成",
  "vulnerability.state_changed": "漏洞状态变化",
  "message.received": "收到用户消息",
  "message.handled": "用户消息已处理",
  "orchestration.decision_recorded": "协调决定已保存",
};

const INTENT_STATUS_ORDER = [
  "proposed", "queued", "running", "resolved", "blocked",
  "awaiting_review", "deferred", "obsolete", "cancelled",
];

const PROJECTION_KINDS = ["asset_map", "exploration_map", "planner_view", "context", "report"];

const AUTO_REFRESH_MS = 10000;
const LOG_PAGE_LIMIT = 50;
const ATTEMPTS_PAGE_LIMIT = 50;

export default {
  id: "diagnostics",
  title: "系统诊断",
  order: 70,
  render({ React, h, api, router, ui }) {
    const ComponentBase = React && typeof React.Component === "function"
      ? React.Component
      : class PageComponentBase {
          constructor(props) {
            this.props = props || {};
          }
        };

    class DiagnosticsBody extends ComponentBase {
      constructor(props) {
        super(props);
        this.state = {
          diag: { phase: "idle", data: null, error: null },
          global: { phase: "idle", data: null, error: null },
          metrics: { phase: "idle", data: null, error: null },
          health: { phase: "idle", data: null, error: null },
          log: {
            phase: "idle", anchor: "项目全部事件（从头）", events: [],
            nextCursor: "", highWatermark: null, hasMore: false, readOnly: true,
            subscription: null, error: null,
          },
          attempts: {
            phase: "idle", items: [], toolCalls: [], toolRows: [], toolCallsProvided: false,
            toolSummaryOnly: false, nextCursor: "", view: "all", error: null,
          },
          subscriptionInput: "",
          subscriptionError: "",
          dataAt: "",
          auto: false,
          remTick: 0,
          navSeq: 0,
        };
        this.timer = null;
        this.unsubNav = null;
        this.onNav = this.onNav.bind(this);
      }

      componentDidMount() {
        this.loadAll({ reset: true });
        const router = this.props.router;
        if (router && typeof router.onChange === "function") {
          this.unsubNav = router.onChange(this.onNav);
        }
      }

      componentWillUnmount() {
        if (typeof this.unsubNav === "function") this.unsubNav();
        this.stopAutoRefresh();
      }

      projectId() {
        const router = this.props.router;
        return router && typeof router.projectId === "string" ? router.projectId : "";
      }

      onNav() {
        const router = this.props.router;
        if (!router || router.page !== "diagnostics") return;
        this.setState((prev) => ({ navSeq: prev.navSeq + 1 }));
        this.loadAll({ reset: true, silent: true });
      }

      /* ── 读取（全部只读 GET；各区块独立降级，单点失败不拖垮整页） ── */

      loadAll({ reset, silent }) {
        const projectId = this.projectId();
        this.loadDiagnostics(projectId, { silent });
        this.loadGlobal({ silent });
        this.loadMetrics(projectId, { silent });
        this.loadHealth({ silent });
        this.loadLog({ projectId, mode: reset ? "head" : "more", silent });
        this.loadAttempts({ projectId, cursor: reset ? "" : this.state.attempts.nextCursor, append: !reset, silent });
      }

      loadDiagnostics(projectId, { silent } = {}) {
        const { api } = this.props;
        if (typeof api !== "function") {
          this.setState({ diag: { phase: "error", data: null, error: { message: "当前宿主未提供 API 通道" } } });
          return;
        }
        if (!silent) this.setState((prev) => ({ diag: { ...prev.diag, phase: "loading", error: null } }));
        const path = projectId
          ? "/sorne/diagnostics?project_id=" + encodeURIComponent(projectId)
          : "/sorne/diagnostics";
        api(path).then(
          (data) => {
            const extracted = extractDiagnostics(data);
            this.setState((prev) => ({
              diag: extracted === null
                ? { phase: "unrecognized", data: null, error: null }
                : { phase: "ok", data: extracted, error: null },
              dataAt: new Date().toISOString(),
            }));
          },
          (e) => this.setState({ diag: { phase: isNotImplemented(e) ? "notimpl" : "error", data: null, error: e } }),
        );
      }

      /** #49 全局面：项目四态分布（工作区页也展示，供对照项目当前状态）。 */
      loadGlobal({ silent } = {}) {
        const { api } = this.props;
        if (typeof api !== "function") return;
        if (!silent) this.setState((prev) => ({ global: { ...prev.global, phase: "loading", error: null } }));
        api("/sorne/diagnostics").then(
          (data) => {
            const extracted = extractDiagnostics(data);
            this.setState({
              global: extracted === null
                ? { phase: "unrecognized", data: null, error: null }
                : { phase: "ok", data: extracted, error: null },
            });
          },
          (e) => this.setState({ global: { phase: isNotImplemented(e) ? "notimpl" : "error", data: null, error: e } }),
        );
      }

      loadMetrics(projectId, { silent } = {}) {
        const { api } = this.props;
        if (typeof api !== "function") return;
        if (!silent) this.setState((prev) => ({ metrics: { ...prev.metrics, phase: "loading", error: null } }));
        const path = projectId
          ? "/sorne/metrics?project_id=" + encodeURIComponent(projectId)
          : "/sorne/metrics";
        api(path).then(
          (data) => {
            const extracted = extractMetrics(data);
            this.setState({
              metrics: extracted === null
                ? { phase: "unrecognized", data: null, error: null }
                : { phase: "ok", data: extracted, error: null },
            });
          },
          (e) => this.setState({ metrics: { phase: isNotImplemented(e) ? "notimpl" : "error", data: null, error: e } }),
        );
      }

      loadHealth({ silent } = {}) {
        const { api } = this.props;
        if (typeof api !== "function") return;
        if (!silent) this.setState((prev) => ({ health: { ...prev.health, phase: "loading", error: null } }));
        api("/sorne/health").then(
          (data) => this.setState({
            health: data && typeof data === "object" && !Array.isArray(data)
              ? { phase: "ok", data, error: null }
              : { phase: "unrecognized", data: null, error: null },
          }),
          (e) => this.setState({ health: { phase: isNotImplemented(e) ? "notimpl" : "error", data: null, error: e } }),
        );
      }

      /** mode: head（从头/重置）| more（游标续读）| subscription（订阅边界之后） */
      loadLog({ projectId, mode, silent }) {
        const { api } = this.props;
        if (typeof api !== "function") return;
        const pid = projectId || this.projectId();
        if (!pid) {
          this.setState({ log: { phase: "idle", anchor: "缺少项目上下文", events: [], nextCursor: "", highWatermark: null, hasMore: false, readOnly: true, subscription: null, error: null } });
          return;
        }
        const current = this.state.log;
        const anchor =
          mode === "subscription"
            ? "订阅 " + this.state.subscriptionInput.trim() + " 的快照边界之后"
            : mode === "more"
              ? current.anchor
              : "项目全部事件（从头）";
        if (!silent) {
          this.setState((prev) => (prev.log.phase === "ok" && mode === "more"
            ? { log: { ...prev.log, error: null } }
            : { log: { ...prev.log, phase: "loading", anchor, error: null } }));
        }
        let query = "?project_id=" + encodeURIComponent(pid) + "&limit=" + LOG_PAGE_LIMIT;
        if (mode === "more" && current.nextCursor) query += "&cursor=" + encodeURIComponent(current.nextCursor);
        if (mode === "subscription") query += "&subscription=" + encodeURIComponent(this.state.subscriptionInput.trim());
        api("/sorne/change-log" + query).then(
          (data) => {
            const page = extractChangeLog(data);
            this.setState((prev) => {
              if (page === null) return { log: { ...prev.log, phase: "unrecognized", anchor, error: null } };
              return {
                log: {
                  phase: "ok",
                  anchor,
                  events: mode === "more" ? [...prev.log.events, ...page.events] : page.events,
                  nextCursor: page.nextCursor,
                  highWatermark: page.highWatermark,
                  hasMore: page.hasMore,
                  readOnly: page.readOnly,
                  subscription: page.subscription,
                  error: null,
                },
                dataAt: new Date().toISOString(),
              };
            });
          },
          (e) => this.setState((prev) => ({
            log: { ...prev.log, phase: isNotImplemented(e) ? "notimpl" : "error", anchor, error: e },
          })),
        );
      }

      loadAttempts({ projectId, cursor, append, silent }) {
        const { api } = this.props;
        if (typeof api !== "function") return;
        const pid = projectId || this.projectId();
        if (!pid) {
          this.setState({ attempts: { phase: "idle", items: [], toolCalls: [], toolRows: [], toolCallsProvided: false, toolSummaryOnly: false, nextCursor: "", view: "all", error: null } });
          return;
        }
        this.loadToolRows(pid);
        if (!silent) {
          this.setState((prev) => (append
            ? { attempts: { ...prev.attempts, error: null } }
            : { attempts: { ...prev.attempts, phase: "loading", items: [], nextCursor: "", error: null } }));
        }
        let path = "/sorne/attempts?project_id=" + encodeURIComponent(pid) + "&limit=" + ATTEMPTS_PAGE_LIMIT;
        if (cursor) path += "&cursor=" + encodeURIComponent(cursor);
        api(path).then(
          (data) => {
            const list = extractAttempts(data);
            if (list === null) {
              this.setState((prev) => ({
                attempts: { ...prev.attempts, phase: "unrecognized", items: [], toolCalls: [], toolRows: [], toolCallsProvided: false, nextCursor: "", error: null },
              }));
              return;
            }
            const items = list.map(normalizeAttempt);
            const collected = collectToolCalls(data, items);
            const info = attemptsCursorOf(data);
            this.setState((prev) => ({
              attempts: {
                ...prev.attempts,
                phase: "ok",
                items: append ? mergeById(prev.attempts.items, items) : items,
                toolCalls: append ? mergeById(prev.attempts.toolCalls, collected.calls) : collected.calls,
                toolCallsProvided: collected.provided,
                toolSummaryOnly: collected.summaryOnly,
                nextCursor: info,
                error: null,
              },
              dataAt: new Date().toISOString(),
            }));
          },
          (e) => this.setState((prev) => ({
            attempts: { ...prev.attempts, phase: isNotImplemented(e) ? "notimpl" : "error", items: [], toolCalls: [], toolRows: [], toolCallsProvided: false, nextCursor: "", error: e },
          })),
        );
      }

      async loadToolRows(pid) {
        const { api } = this.props;
        if (typeof api !== "function") return;
        const enc = encodeURIComponent(pid);
        const [tcRes, capRes] = await Promise.all([
          Promise.resolve().then(() => api("/sorne/tool-calls?project_id=" + enc + "&limit=200")).catch(() => null),
          Promise.resolve().then(() => api("/sorne/captures?project_id=" + enc + "&limit=200")).catch(() => null),
        ]);
        const calls = tcRes && Array.isArray(tcRes.tool_calls) ? tcRes.tool_calls
          : (tcRes && Array.isArray(tcRes.items) ? tcRes.items : null);
        if (!calls) return;
        const caps = capRes && Array.isArray(capRes.captures) ? capRes.captures
          : (capRes && Array.isArray(capRes.items) ? capRes.items : []);
        const urlsByCall = new Map();
        for (const c of caps) {
          const key = c && (c.tool_call_id || c.toolCallId);
          if (!key) continue;
          if (!urlsByCall.has(key)) urlsByCall.set(key, []);
          if (c.request_url_exact) urlsByCall.get(key).push(c.request_url_exact);
        }
        const rows = calls.map((c) => ({
          id: c.id,
          attemptId: c.attempt_id || c.attemptId || "",
          workerId: c.worker_id || c.workerId || "",
          toolName: c.tool_name || c.toolName || "",
          status: c.status || "",
          startedAt: c.started_at || c.startedAt || "",
          endedAt: c.ended_at || c.endedAt || "",
          error: c.error || "",
          argsDigest: c.args_digest || c.argsDigest || "",
          urls: urlsByCall.get(c.id) || [],
        }));
        rows.sort((a, b) => {
          const au = a.status === "unknown" || a.status === "running" ? 0 : 1;
          const bu = b.status === "unknown" || b.status === "running" ? 0 : 1;
          if (au !== bu) return au - bu;
          return String(b.startedAt || "").localeCompare(String(a.startedAt || ""));
        });
        this.setState((prev) => ({ attempts: { ...prev.attempts, toolRows: rows } }));
      }

      /* ── 视图操作（全部本地行为；自动刷新默认关闭） ───────────────── */

      setAttemptsView(view) {
        this.setState((prev) => ({ attempts: { ...prev.attempts, view } }));
      }

      recomputeLease() {
        this.setState((prev) => ({ remTick: prev.remTick + 1 }));
      }

      refreshData() {
        this.loadAll({ reset: true });
      }

      toggleAutoRefresh() {
        if (this.timer) {
          this.stopAutoRefresh();
          return;
        }
        this.timer = setInterval(() => {
          this.loadAll({ reset: true, silent: true });
        }, AUTO_REFRESH_MS);
        this.setState({ auto: true });
      }

      stopAutoRefresh() {
        if (this.timer) {
          clearInterval(this.timer);
          this.timer = null;
        }
        if (this.state.auto) this.setState({ auto: false });
      }

      setSubscriptionInput(value) {
        this.setState({ subscriptionInput: value });
      }

      submitSubscription() {
        const id = this.state.subscriptionInput.trim();
        if (!id) {
          this.setState({ subscriptionError: "请填写订阅编号（快照头「订阅边界」中的 SUBS-…）" });
          return;
        }
        const projectId = this.projectId();
        if (!projectId) {
          this.setState({ subscriptionError: "缺少项目上下文，无法读取订阅边界" });
          return;
        }
        this.setState({ subscriptionError: "" });
        this.loadLog({ projectId, mode: "subscription" });
      }

      readFromHead() {
        this.setState({ subscriptionError: "" });
        this.loadLog({ projectId: this.projectId(), mode: "head" });
      }

      /* ── 状态推导（只读；全部按已加载数据推导） ───────────────────── */

      derivedAttempts(nowMs) {
        const rows = Array.isArray(this.state.attempts.items) ? this.state.attempts.items : [];
        const toolCalls = Array.isArray(this.state.attempts.toolCalls) ? this.state.attempts.toolCalls : [];
        const active = rows.filter((a) => a.status === "leased" || a.status === "running");
        const expiredActive = active.filter((a) => leaseStateOf(a, nowMs).kind === "expired");
        const interrupted = rows.filter((a) => a.status === "interrupted");
        const unknownCalls = toolCalls.filter((t) => t.status === "unknown");
        const runningCalls = toolCalls.filter((t) => t.status === "running");
        const failedCount = rows.reduce((sum, a) => sum + failedCallsOf(a), 0);
        const visible = this.state.attempts.view === "attention"
          ? rows.filter((a) => a.status === "leased" || a.status === "running"
            || a.status === "interrupted" || leaseStateOf(a, nowMs).kind === "expired")
          : rows;
        return { rows, toolCalls, active, expiredActive, interrupted, unknownCalls, runningCalls, failedCount, visible };
      }

      /* ── 渲染 ───────────────────────────────────────────────────── */

      render() {
        const { h, ui, router } = this.props;
        if (!ui || typeof ui.formatTime !== "function") {
          return h("div", { style: WRAP },
            h("div", { role: "alert", style: CARD },
              h("div", { style: { fontWeight: 600, color: "var(--sorne-text-primary)" } }, "渲染器未就绪"),
              h("div", { style: MUTED }, "系统诊断页依赖设计系统渲染器（ui.formatTime / StatusBadge / FoldableObject 等）。当前宿主未提供，页面以降级态呈现，不做数据猜测。"),
            ));
        }

        const projectId = this.projectId();
        const nowMs = Date.now();
        const diagState = this.state.diag;
        const diag = diagState.data || null;
        const project = diag && diag.project ? diag.project : null;
        const derived = this.derivedAttempts(nowMs);
        const children = [];

        children.push(h("div", { key: "head", style: { display: "flex", flexDirection: "column", gap: 4 } },
          h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", fontSize: 13, lineHeight: 1.6, color: "var(--sorne-text-muted)" } },
            h("span", null, "项目："),
            projectId ? ui.RecordIdChip(projectId, { projectId, navigate: navigateRecord(router) }) : h("span", null, "—（未提供）"),
            project && project.status ? ui.StatusBadge("project_status", project.status) : null,
            h("span", null, "数据时刻：" + (this.state.dataAt ? ui.formatTime(this.state.dataAt) : "—（未提供）")),
            project && typeof project.high_watermark === "number"
              ? h("span", null, "截止边界 commit_seq=" + project.high_watermark)
              : null,
            h("span", null, "计数按已加载数据推导，不代表全量")),
        ));

        if (diagState.phase === "idle" || diagState.phase === "loading") {
          children.push(h("div", { key: "diag-loading", style: MUTED }, "正在读取诊断聚合（#49）…"));
        } else if (diagState.phase === "notimpl") {
          children.push(h("div", { key: "diag-notimpl", style: WARN_BOX },
            h("div", { style: { fontWeight: 600 } }, "诊断聚合未实现（501，不是报错）"),
            h("div", { style: MUTED }, errMessage(diagState.error))));
        } else if (diagState.phase === "error") {
          children.push(h("div", { key: "diag-error", style: DANGER_TEXT },
            "诊断聚合不可用：", errNotice(diagState.error)));
        } else if (diagState.phase === "unrecognized") {
          children.push(h("div", { key: "diag-unrecognized", style: WARN_BOX },
            "诊断聚合形状无法识别（应为含 health/llm/project 的对象信封），不静默当作空。"));
        }

        if (derived.unknownCalls.length) {
          children.push(h("div", { key: "unknown-top", role: "alert", style: DANGER_BOX },
            h("div", { style: { fontWeight: 700 } },
              "有 " + derived.unknownCalls.length + " 个结果未知（unknown）的工具调用"),
            h("div", null, "须先检查外部现状再决定重试，不得当作已完成或已失败。"),
            h("div", { style: MUTED },
              "涉及：", derived.unknownCalls.slice(0, 10).map((t, i) =>
                h("span", { key: t.id || "u" + i, style: { marginRight: 8 } },
                  ui.RecordIdChip(t.id, { projectId, navigate: navigateRecord(router) }),
                  "（", t.toolName || "工具名未提供", "）"))),
          ));
        }

        this.renderHealthBlock(children, diag, projectId, router);
        this.renderSummaryBlock(children, project, derived);
        this.renderPlanAndIntents(children, project, projectId, router);
        this.renderVerificationAndMessages(children, project);
        this.renderOutbox(children, diag, project);
        this.renderProjection(children, project);
        this.renderEvidence(children, project);
        this.renderAttempts(children, derived, nowMs, projectId, router);
        this.renderLog(children, projectId, router);
        this.renderMetrics(children);

        children.push(h("details", { key: "semantics", style: { ...CARD, fontSize: 13.5, lineHeight: 1.7, color: "var(--sorne-text-secondary)" } },
          h("summary", { style: { cursor: "pointer", fontWeight: 600, color: "var(--sorne-text-primary)" } },
            "语义说明（冻结原文；点开展开全部口径）"),
          h("div", { style: { marginTop: 6, display: "flex", flexDirection: "column", gap: 4 } },
            h("div", null, "本页只读聚合：系统诊断数据来自 #49 诊断聚合、#41 指标全集、#45 变化流只读视图、#23 执行尝试与租约、#3 健康检查；不写库、不发事件、不制造第二真值源。"),
            h("div", null, "resolved 只表示该版本的问题已处理，不代表关联资产已测透（规范 §10.1）。"),
            h("div", null, "恢复与重派由协调 AI 决定，程序不写死固定重试（规范 §3.1/§3.2）。"),
            h("div", null, "同项目默认最多一个规划调用在途（§16.1）。"),
            h("div", null, "九态计数以库为准（§10.1）。"),
            h("div", null, "unknown 工具调用：须先检查外部现状再决定重试，不得当作已完成或已失败（规范 §10.2）。"),
            h("div", null, "租约已过期：旧执行不得继续操作（LEASE_EXPIRED，规范 §10.2）；恢复、重派或调整由 Orchestrator 决定。其迟到提交的合法证据仍可留档，但不得改变新尝试的状态、不得继续获得工具执行权限。"),
            h("div", null, "同一不可并行的执行分配同一时刻最多一个有效租约（规范 §10.2）。"),
            h("div", null, "查看≠消费，delivered≠applied：本页只读，不写投递回执、不推进订阅游标；delivered/applied 仅订阅消费者本人经 GET /changes 与 POST /consumer-acks 推进（§14.2/§14.3）。"),
            h("div", null, "数据时刻/截止边界（commit_seq）：本页所有计数按已加载数据在数据时刻推导，游标未加载完时不代表全量。"),
            h("div", null, "未提供≠不存在（「—（未提供）」）；折叠不删记录（展开入口与已折叠计数保留），完整明细可按编号经 /records/{id} 读取。"),
            h("div", null, "501 未实现≠报错：端点未实装时呈现「未实现」状态并标注负责模块，其余区块继续渲染。"),
            h("div", null, "全局运行指标（保存延迟、Outbox 积压与重试、投影滞后等，§20.2 全集）由 /metrics 提供，见本页「运行指标」折叠块；漏洞数量不是唯一健康指标。"),
            h("div", null, "本页只读监控队列、租约与工具调用状态，不提供暂缓/恢复/取消等操作入口；不写死「重试三次然后失败」一类的固定流程（规范 §3.1）。"),
            h("div", null, "浏览器 UI 当前没有会话签发通道：如需 C2 消费者面动作，只能由程序侧会话推进；本页按 user 面只读呈现。"),
          ),
        ));

        children.push(h("div", { key: "boundary" },
          h("span", { style: MUTED }, "以上计数按本页已加载数据在数据时刻推导，游标未加载完时不代表全量。"),
        ));

        return h("div", { style: WRAP }, children);
      }

      renderHealthBlock(children, diag, projectId, router) {
        const { h, ui } = this.props;
        const healthState = this.state.health;
        const health = healthState.phase === "ok"
          ? healthState.data
          : diag && diag.health
            ? diag.health
            : null;
        const llm = diag && diag.llm ? diag.llm : null;
        const rows = [];
        if (health) {
          rows.push(h("div", { key: "ok", style: { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" } },
            h("span", { style: { fontWeight: 600 } }, "服务状态："),
            health.ok
              ? h("span", { style: { color: "var(--sorne-status-ok-fg)", fontWeight: 600 } }, "服务正常（ok）")
              : h("span", { style: { color: "var(--sorne-status-unknown-fg)", fontWeight: 600 } }, "系统异常（health.ok=false）"),
            health.service ? h("span", { style: MUTED }, "服务：", String(health.service), health.version ? " · 版本：" + health.version : "") : null,
          ));
          if (health.checked_at) {
            rows.push(h("div", { key: "checked" }, ui.FieldRow("checked_at", health.checked_at)));
          }
          const db = health.db || {};
          rows.push(h("div", { key: "db" },
            "数据库：", db.ok ? "可打开（ok）" : "不可用" ,
            db.schema_version !== undefined && db.schema_version !== null ? " · 模式版本：" + String(db.schema_version) : "",
          ));
          const ob = health.outbox || {};
          rows.push(h("div", { key: "ob" },
            "Outbox（健康面）：待发送 ", String(ob.pending || 0),
            " · 已发送 ", String(ob.sent || 0),
            " · 失败 ", String(ob.failed || 0),
            " · 已跳过 ", String(ob.skipped || 0),
            " · 总计 ", String(ob.total || 0),
          ));
          rows.push(h("div", { key: "scale" },
            "规模：项目 ", String(health.projects !== undefined ? health.projects : "—（未提供）"),
            " · 活跃会话 ", String(health.sessions && health.sessions.active !== undefined ? health.sessions.active : "—（未提供）"),
          ));
        } else if (healthState.phase === "notimpl") {
          rows.push(h("div", { key: "notimpl", style: WARN_BOX }, "健康检查未实现（501，不是报错）；诊断聚合块独立呈现。"));
        } else if (healthState.phase === "error") {
          rows.push(h("div", { key: "err", style: DANGER_TEXT }, "健康检查不可用：", errNotice(healthState.error)));
        } else if (healthState.phase === "loading" || healthState.phase === "idle") {
          rows.push(h("div", { key: "loading", style: MUTED }, "正在读取系统健康…"));
        }

        const globalState = this.state.global;
        const globalDiag = globalState.phase === "ok" && globalState.data ? globalState.data : null;
        if (globalDiag && globalDiag.projects) {
          const g = globalDiag.projects;
          rows.push(h("div", { key: "global-projects" },
            "全局项目状态：运行中 ", String(g.active || 0),
            " · 等待条件变化 ", String(g.waiting_for_change || 0),
            " · 已暂停 ", String(g.paused || 0),
            " · 已停止 ", String(g.stopped || 0)));
        }

        if (llm) {
          rows.push(h("div", { key: "llm" },
            "模型：",
            !llm.configured ? "尚未连接模型，项目可以保存，AI 暂不能开始"
              : llm.needs_user ? "模型配置或凭据需要处理"
                : llm.reachable === true ? "最近一次模型调用成功"
                  : llm.reachable === false ? `模型暂不可用（${llm.last_error_kind || "调用失败"}）`
                    : "模型已配置，连通性未验证",
          ));
          if (llm.reachable === false && llm.next_retry_at && !llm.needs_user) {
            rows.push(h("div", { key: "llm-retry", style: MUTED }, "允许重试时间：", String(llm.next_retry_at)));
          }
          if (llm.runtime !== undefined) {
            rows.push(h("div", { key: "runtime", style: MUTED }, "运行时（agents.describe() 原文）：", String(llm.runtime)));
          }
        }

        children.push(h("section", { key: "health", style: SECTION },
          h("h3", { style: SECTION_TITLE }, "健康与模型"),
          h("div", { style: { display: "flex", flexDirection: "column", gap: 3 } }, rows),
        ));
      }

      renderSummaryBlock(children, project, derived) {
        const { h } = this.props;
        const by = project && project.intents && project.intents.by_status ? project.intents.by_status : null;
        const count = (k) => (by && typeof by[k] === "number" ? by[k] : 0);
        const rows = [];
        if (by) {
          rows.push(h("div", { key: "intents" },
            "意图（九态计数，以库为准）：",
            "已提议 " + count("proposed"), " · 已入队 " + count("queued"), " · 执行中 " + count("running"),
            " · 已解决 " + count("resolved"), " · 受阻 " + count("blocked"),
            " · 待复核 " + count("awaiting_review"), " · 已暂缓 " + count("deferred"),
            " · 已废弃 " + count("obsolete"), " · 已取消 " + count("cancelled")));
        } else {
          rows.push(h("div", { key: "intents-missing", style: MUTED }, "意图九态计数：—（未提供；诊断端点不可用时如实呈现）"));
        }
        rows.push(h("div", { key: "attempts" },
          "执行尝试（已加载 ", String(derived.rows.length), " 条）：",
          "活跃（leased/running）", String(derived.active.length),
          " · 其中租约已过期 ", String(derived.expiredActive.length),
          " · 已中断 ", String(derived.interrupted.length)));
        rows.push(h("div", { key: "calls" },
          "工具调用（已加载 ", String(derived.toolCalls.length), " 条明细）：",
          "执行中 ", String(derived.runningCalls.length),
          " · 结果未知 ", String(derived.unknownCalls.length),
          " · 已失败 ", String(derived.failedCount)));
        children.push(h("section", { key: "summary", style: SECTION },
          h("h3", { style: SECTION_TITLE }, "观察摘要（按已加载数据推导）"),
          h("div", { style: { display: "flex", flexDirection: "column", gap: 3 } }, rows),
        ));
      }

      renderPlanAndIntents(children, project, projectId, router) {
        const { h, ui } = this.props;
        const plan = project && project.plan ? project.plan : null;
        const intents = project && project.intents ? project.intents : null;
        const rows = [];
        if (plan) {
          rows.push(h("div", { key: "plan" },
            "规划运行：pending ", String(plan.plan_runs_pending || 0),
            " · in_flight ", String(plan.plan_runs_in_flight || 0),
            "（同项目默认最多一个规划调用在途；数据来自 #49）"));
        } else {
          rows.push(h("div", { key: "plan-missing", style: MUTED }, "规划运行：—（未提供）"));
        }
        if (intents) {
          rows.push(h("div", { key: "blocked" },
            "受阻族（blocked/awaiting_review/deferred）全列（",
            String((intents.blocked_ids || []).length),
            " 条）：",
            (intents.blocked_ids || []).length
              ? (intents.blocked_ids || []).map((id, i) => h("span", { key: id || "b" + i, style: { marginRight: 6 } },
                  ui.RecordIdChip(id, { projectId, navigate: navigateRecord(router) })))
              : "—（无）"));
        }
        children.push(h("section", { key: "plan", style: SECTION },
          h("h3", { style: SECTION_TITLE }, "计划与探索方向（#49）"),
          h("div", { style: { display: "flex", flexDirection: "column", gap: 3 } }, rows),
        ));
      }

      renderVerificationAndMessages(children, project) {
        const { h, ui } = this.props;
        const v = project && project.verification ? project.verification : null;
        const reports = project && project.reports ? project.reports : null;
        const messages = project && project.messages ? project.messages : null;
        children.push(h("section", { key: "queue", style: SECTION },
          h("h3", { style: SECTION_TITLE }, "验证积压与消息（#49）"),
          h("div", { style: { display: "flex", flexDirection: "column", gap: 3 } },
            h("div", null,
              "待验证任务：", v ? String(v.pending_jobs || 0) : "—（未提供）",
              " · 最老等待：", v && v.oldest_wait_seconds !== null && v.oldest_wait_seconds !== undefined
                ? formatDuration(v.oldest_wait_seconds * 1000)
                : "—（未提供）"),
            h("div", null,
              "未处理 Worker 汇报：", reports ? String(reports.unhandled_worker_reports || 0) : "—（未提供）",
              "（delivered≠handled：仅送入上下文不算已处理）"),
            h("div", null,
              "用户消息：待处理 ", messages ? String(messages.pending_user || 0) : "—（未提供）",
              " · 最近 AI 回复：", messages && messages.last_ai_reply_at ? ui.formatTime(messages.last_ai_reply_at) : "—（未提供）"),
          ),
        ));
      }

      renderOutbox(children, diag, project) {
        const { h, ui } = this.props;
        const projectOutbox = project && project.outbox ? project.outbox : null;
        const healthOutbox = this.state.health.phase === "ok" && this.state.health.data && this.state.health.data.outbox
          ? this.state.health.data.outbox
          : null;
        const metricsOutbox = this.state.metrics.phase === "ok" && this.state.metrics.data
          ? this.state.metrics.data.outbox
          : null;
        const lines = [];
        if (projectOutbox) {
          lines.push(h("div", { key: "p" },
            "项目 Outbox：pending ", String(projectOutbox.pending || 0),
            " · failed ", String(projectOutbox.failed || 0),
            " · 最老 pending：", projectOutbox.oldest_pending_age_s !== null && projectOutbox.oldest_pending_age_s !== undefined
              ? formatDuration(projectOutbox.oldest_pending_age_s * 1000) : "—（未提供）"));
        } else if (healthOutbox) {
          lines.push(h("div", { key: "h" },
            "全局 Outbox（健康面）：pending ", String(healthOutbox.pending || 0),
            " · failed ", String(healthOutbox.failed || 0)));
        } else {
          lines.push(h("div", { key: "missing", style: MUTED }, "Outbox：—（未提供）"));
        }
        if (metricsOutbox && metricsOutbox.by_status) {
          const by = metricsOutbox.by_status || {};
          lines.push(h("div", { key: "m" },
            "投递分布（#41）：pending ", String(by.pending || 0),
            " · sent ", String(by.sent || 0),
            " · failed ", String(by.failed || 0),
            " · skipped ", String(by.skipped || 0)));
          if (metricsOutbox.pending_oldest_age_ms !== null && metricsOutbox.pending_oldest_age_ms !== undefined) {
            lines.push(h("div", { key: "age" }, "最老 pending 事件年龄：", formatDuration(metricsOutbox.pending_oldest_age_ms)));
          }
          const retry = metricsOutbox.retry_attempts || {};
          lines.push(h("div", { key: "retry" },
            "投递重试：累计 ", String(retry.total || 0), " · 单事件最大 ", String(retry.max || 0)));
        }
        lines.push(h("div", { key: "note", style: MUTED },
          "查看≠消费，delivered≠applied：本页只读，不写投递回执、不推进订阅游标；delivered/applied 仅订阅消费者本人推进。"));
        children.push(h("section", { key: "outbox", style: SECTION },
          h("h3", { style: SECTION_TITLE }, "Outbox 与消息投递"),
          h("div", { style: { display: "flex", flexDirection: "column", gap: 3 } }, lines),
        ));
      }

      renderProjection(children, project) {
        const { h } = this.props;
        const projection = project && project.projection ? project.projection : null;
        const metricsLag = this.state.metrics.phase === "ok" && this.state.metrics.data
          ? this.state.metrics.data.projection_lag
          : null;
        const rows = [];
        if (projection) {
          for (const kind of PROJECTION_KINDS) {
            const v = projection[kind];
            rows.push(h("div", { key: kind },
              kind + "：",
              typeof v === "number"
                ? "落后 " + v + " 个提交"
                : "—（未投影：null 表示未观测，不冒充 0）"));
          }
        } else if (metricsLag) {
          rows.push(h("div", { key: "hw" }, "事件高水位：", String(metricsLag.high_watermark !== undefined ? metricsLag.high_watermark : "—（未提供）")));
          for (const kind of PROJECTION_KINDS) {
            const item = metricsLag.per_kind ? metricsLag.per_kind[kind] : null;
            rows.push(h("div", { key: kind },
              kind + "：",
              item && typeof item.lag_commits === "number"
                ? "落后 " + item.lag_commits + " 个提交"
                : "—（未投影：null 表示未观测，不冒充 0）"));
          }
        } else {
          rows.push(h("div", { key: "missing", style: MUTED }, "投影滞后：—（未提供）"));
        }
        children.push(h("section", { key: "projection", style: SECTION },
          h("h3", { style: SECTION_TITLE }, "投影滞后"),
          h("div", { style: { display: "flex", flexDirection: "column", gap: 3 } }, rows),
        ));
      }

      renderEvidence(children, project) {
        const { h } = this.props;
        const evidence = project && project.evidence ? project.evidence : null;
        children.push(h("section", { key: "evidence", style: SECTION },
          h("h3", { style: SECTION_TITLE }, "证据容量与完整性"),
          h("div", { style: { display: "flex", flexDirection: "column", gap: 3 } },
            h("div", null,
              "待固定 Blob：", evidence ? String(evidence.staged_blobs || 0) : "—（未提供）",
              " · 丢失 Blob：", evidence ? String(evidence.lost_blobs || 0) : "—（未提供）"),
            h("div", null,
              "完整性异常（真实读盘核对）：",
              !evidence
                ? "—（未提供）"
                : evidence.integrity_anomalies === null || evidence.integrity_anomalies === undefined
                  ? "—（本次未核对，不冒充 0）"
                  : String(evidence.integrity_anomalies) + " 项"),
          ),
        ));
      }

      renderAttempts(children, derived, nowMs, projectId, router) {
        const { h, ui } = this.props;
        const api = this.props.api;
        const attemptsState = this.state.attempts;
        const nodes = [];
        nodes.push(h("div", { key: "toolbar", style: { display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 6 } },
          h("button", { key: "all", type: "button", "aria-label": "查看全部尝试",
            style: attemptsState.view === "all" ? BTN_ACTIVE : BTN,
            onClick: () => this.setAttemptsView("all") }, "全部尝试"),
          h("button", { key: "att", type: "button", "aria-label": "仅看活跃与异常尝试",
            style: attemptsState.view === "attention" ? BTN_ACTIVE : BTN,
            onClick: () => this.setAttemptsView("attention") }, "仅看活跃与异常"),
          h("button", { key: "refresh", type: "button", "aria-label": "刷新数据（重置到第一页）",
            style: BTN, onClick: () => this.refreshData() }, "刷新数据（重置到第一页）"),
          h("button", { key: "lease", type: "button", "aria-label": "仅重算剩余时间",
            style: BTN, onClick: () => this.recomputeLease() }, "仅重算剩余时间"),
          h("button", { key: "auto", type: "button",
            "aria-label": attemptsState.view === undefined ? "自动刷新" : (this.state.auto ? "关闭自动刷新" : "开启自动刷新"),
            style: this.state.auto ? BTN_ACTIVE : BTN,
            onClick: () => this.toggleAutoRefresh() },
            this.state.auto ? "自动刷新：开（点击关闭）" : "开启自动刷新（每 10 秒）")),
        );
        nodes.push(h("div", { key: "thread-note", style: MUTED },
          "每次尝试有唯一编号、worker 身份、租约截止时间与单调递增的 fencing token；同一不可并行的执行分配同一时刻最多一个有效租约。",
          "租约剩余时间按本次渲染时刻计算，不是实时计时。"));
        if (attemptsState.view === "attention") {
          nodes.push(h("div", { key: "filter-note", style: MUTED },
            "当前筛选只作用于本页已加载数据的尝试，不代表全量。"));
        }

        if (attemptsState.phase === "idle") {
          nodes.push(h("div", { key: "idle", style: MUTED },
            projectId ? "正在准备读取执行尝试…" : "缺少项目上下文；请从左侧进入项目后查看执行尝试。"));
        } else if (attemptsState.phase === "loading") {
          nodes.push(h("div", { key: "loading", style: MUTED }, "正在读取执行尝试与租约…"));
        } else if (attemptsState.phase === "notimpl") {
          nodes.push(h("div", { key: "notimpl", style: WARN_BOX },
            h("div", { style: { fontWeight: 600 } }, "执行尝试视图未实现（501，不是报错）"),
            h("div", { style: MUTED }, errMessage(attemptsState.error)),
            notImplModule(attemptsState.error)
              ? h("div", { style: MUTED }, "负责模块：" + notImplModule(attemptsState.error) + "（按蓝图阶段排序实装）")
              : null));
        } else if (attemptsState.phase === "error") {
          nodes.push(h("div", { key: "error", style: { display: "flex", flexDirection: "column", gap: 3 } },
            h("div", { style: DANGER_TEXT }, "执行尝试视图不可用：", errNotice(attemptsState.error)),
            attemptsState.error && attemptsState.error.code === "TRUST_DENIED"
              ? h("div", { style: MUTED },
                  "该端点要求程序签发的会话（x-sorne-session）；浏览器 UI 当前没有会话签发通道。",
                  "本页如实呈现该限制，不伪造数据。")
              : null));
        } else if (attemptsState.phase === "unrecognized") {
          nodes.push(h("div", { key: "unrecognized", style: WARN_BOX },
            "执行尝试形状无法识别（数据源返回了未知结构；应为尝试数组或带列表字段的对象）。"));
        } else if (attemptsState.phase === "ok" && !derived.rows.length) {
          nodes.push(h("div", { key: "empty", style: MUTED },
            "（暂无执行尝试；执行分配由 Orchestrator 经 POST /attempts 创建后出现在此）"));
        }

        for (const [idx, a] of derived.visible.entries()) {
          const lease = leaseStateOf(a, nowMs);
          const activeExpired = (a.status === "leased" || a.status === "running") && lease.kind === "expired";
          nodes.push(h("div", { key: a.id || "attempt-" + idx, style: activeExpired || a.status === "interrupted" ? { ...CARD, ...CARD_ATTENTION } : CARD },
            h("div", { style: { display: "flex", gap: 6, flexWrap: "wrap", alignItems: "baseline" } },
              ui.RecordIdChip(a.id, { projectId, navigate: navigateRecord(router) }),
              ui.StatusBadge("attempt_status", a.status),
              a.intentId ? h("span", { style: MUTED }, "意图：", ui.RecordIdChip(a.intentId, { projectId, navigate: navigateRecord(router) })) : null,
              a.workerId ? h("span", { style: MUTED }, "worker：" + a.workerId) : null),
            h("div", { style: MUTED },
              a.assignmentId ? "执行分配：" + a.assignmentId + " · " : "",
              "fencing token：",
              a.fencingToken !== null && a.fencingToken !== undefined
                ? String(a.fencingToken)
                : "—（未提供或当前会话角色不展示）"),
            a.toolSummary ? h("div", null, "工具调用：" + a.toolSummary) : null,
            h("div", null,
              "租约截止：", lease.expiresText,
              lease.kind === "live" ? " · 剩余约 " + lease.remainingText : "",
              lease.kind === "expired" ? " · 已过期约 " + lease.remainingText : ""),
            activeExpired
              ? h("div", { style: DANGER_TEXT },
                  "租约已过期：旧执行不得继续操作（LEASE_EXPIRED）；恢复、重派或调整由 Orchestrator 决定。")
              : null,
            a.recoveryNote
              ? h("div", { style: MUTED }, "恢复备注：", typeof a.recoveryNote === "string" ? a.recoveryNote : JSON.stringify(a.recoveryNote))
              : null,
          ));
        }

        if (attemptsState.phase === "ok" && attemptsState.nextCursor) {
          nodes.push(h("div", { key: "more", style: { display: "flex", gap: 8, alignItems: "center", marginTop: 6 } },
            h("button", { type: "button", "aria-label": "加载更多尝试", style: BTN,
              onClick: () => {
                if (typeof api === "function") {
                  this.loadAttempts({ projectId, cursor: attemptsState.nextCursor, append: true });
                }
              } }, "加载更多尝试"),
            h("span", { style: MUTED }, "（还有更多尝试在下一页，可继续加载；游标续读不跳过区间）")));
        }

        nodes.push(h("div", { key: "calls-title", style: { ...SECTION_TITLE, marginTop: 10 } }, "工具调用状态（随 #23 一并读取）"));
        nodes.push(h("div", { key: "calls-note", style: MUTED },
          "工具调用按 planned→running→succeeded/failed/unknown 登记，不视作恰好一次；结果未知与执行中的调用排在最前。"));

        if (attemptsState.phase === "ok" && derived.rows.length && !attemptsState.toolCallsProvided) {
          nodes.push(h("div", { key: "not-provided", style: WARN_BOX },
            "本次执行尝试响应未携带工具调用数据（not_provided）：已读取的尝试与租约信息不受影响，完整明细与依据可按编号经 /records/{id} 读取。"));
        }
        if (attemptsState.phase === "ok" && derived.rows.length && attemptsState.toolCallsProvided && !derived.toolCalls.length) {
          nodes.push(h("div", { key: "calls-empty", style: MUTED }, "（暂无工具调用记录）"));
        }
        if (attemptsState.phase === "ok" && attemptsState.toolSummaryOnly) {
          nodes.push(h("div", { key: "summary-only", style: { ...MUTED, marginTop: 4 } },
            "（队列视图以摘要形式携带工具调用：以下明细只含结果未知、执行中与计划中条目，其余状态的计数见各尝试行；完整明细与依据可按编号经 /records/{id} 读取。）"));
        }

        const toolRows = this.state.attempts.toolRows || [];
        const attemptById = new Map(derived.rows.map((a) => [a.id, a]));
        if (toolRows.length) {
          const TH = { textAlign: "left", fontSize: 12, color: "var(--sorne-text-secondary)", fontWeight: 600, padding: "6px 8px", borderBottom: "1px solid var(--sorne-border)", whiteSpace: "nowrap" };
          const TD = { fontSize: 12.5, color: "var(--sorne-text-primary)", padding: "6px 8px", borderBottom: "1px solid var(--sorne-border)", verticalAlign: "top" };
          nodes.push(h("div", { key: "calls-table", style: { ...CARD, padding: 0, marginTop: 8, overflow: "auto" } },
            h("table", { style: { width: "100%", borderCollapse: "collapse" } },
              h("thead", null, h("tr", null,
                h("th", { style: TH }, "时间"),
                h("th", { style: TH }, "编号"),
                h("th", { style: TH }, "执行者"),
                h("th", { style: TH }, "工具"),
                h("th", { style: TH }, "操作摘要"),
                h("th", { style: TH }, "状态"),
              )),
              h("tbody", null, toolRows.map((t) => {
                const attempt = t.attemptId ? attemptById.get(t.attemptId) : null;
                const worker = t.workerId || (attempt && attempt.workerId ? attempt.workerId : "—");
                const opText = t.urls.length
                  ? t.urls.slice(0, 2).join(" · ") + (t.urls.length > 2 ? " 等 " + t.urls.length + " 个请求" : "")
                  : (t.argsDigest ? "参数摘要：" + String(t.argsDigest).slice(0, 96) : "—（参数未提供）");
                return h("tr", { key: t.id },
                  h("td", { style: { ...TD, whiteSpace: "nowrap", color: "var(--sorne-text-secondary)" } }, t.startedAt ? ui.formatTime(t.startedAt) : "—"),
                  h("td", { style: TD }, ui.RecordIdChip(t.id, { projectId, navigate: navigateRecord(router) })),
                  h("td", { style: { ...TD, whiteSpace: "nowrap" } }, worker),
                  h("td", { style: { ...TD, whiteSpace: "nowrap", fontFamily: "ui-monospace, Menlo, monospace" } }, t.toolName || "—"),
                  h("td", { style: { ...TD, maxWidth: 460, wordBreak: "break-all" }, title: t.error || "" }, opText),
                  h("td", { style: TD }, (() => {
                    const label = { planned: "计划中", running: "执行中", succeeded: "成功", failed: "失败", unknown: "未知", cancelled: "已取消" }[t.status] || t.status || "—";
                    const tone = t.status === "unknown" || t.status === "failed" ? "unknown" : t.status === "running" || t.status === "succeeded" ? "ok" : "review";
                    const title = t.status === "unknown"
                      ? "结果未知：须先检查外部现状再决定重试，不得当作已完成或已失败"
                      : (t.error || "");
                    return h("span", {
                      title,
                      style: {
                        display: "inline-flex", alignItems: "center", padding: "1px 8px", borderRadius: 999,
                        fontSize: 12, fontWeight: 600,
                        background: "var(--sorne-status-" + tone + "-bg)", color: "var(--sorne-status-" + tone + "-fg)",
                        border: "1px solid var(--sorne-status-" + tone + "-fg)", whiteSpace: "nowrap",
                      },
                    }, label);
                  })()),
                );
              })),
            ),
          ));
          if (toolRows.some((t) => t.status === "unknown")) {
            nodes.push(h("div", { key: "unknown-note", style: { ...MUTED, marginTop: 6 } },
              "结果未知（unknown）的调用：须先检查外部现状再决定重试，不得当作已完成或已失败。"));
          }
        } else {

            const attentionCalls = derived.toolCalls.filter((t) => t.status === "unknown" || t.status === "running");
            const otherCalls = derived.toolCalls.filter((t) => t.status !== "unknown" && t.status !== "running");
          for (const [idx, t] of attentionCalls.entries()) {
            nodes.push(h("div", { key: t.id || "tc-a-" + idx, style: t.status === "unknown" ? { ...CARD, ...CARD_ATTENTION } : CARD },
              h("div", { style: { display: "flex", gap: 6, flexWrap: "wrap", alignItems: "baseline" } },
                ui.RecordIdChip(t.id, { projectId, navigate: navigateRecord(router) }),
                ui.StatusBadge("tool_call_status", t.status),
                t.toolName ? h("span", { style: MUTED }, "工具：" + t.toolName) : null,
                t.attemptId ? h("span", { style: MUTED }, "尝试：", ui.RecordIdChip(t.attemptId, { projectId, navigate: navigateRecord(router) })) : null),
              t.error ? h("div", { style: MUTED }, "错误/说明：" + t.error) : null,
              t.status === "unknown"
                ? h("div", { style: DANGER_TEXT },
                    "结果未知（unknown）：须先检查外部现状再决定重试，不得当作已完成或已失败。")
                : null,
              t.evidenceRefs && t.evidenceRefs.length
                ? h("div", { style: MUTED }, "证据引用：", t.evidenceRefs.map((r, i) => h("span", { key: r || "r" + i, style: { marginRight: 6 } },
                    ui.RecordIdChip(r, { projectId, navigate: navigateRecord(router) }))))
                : null,
            ));
          }
          for (const [idx, t] of otherCalls.entries()) {
            nodes.push(h("div", { key: t.id || "tc-o-" + idx, style: CARD },
              h("div", { style: { display: "flex", gap: 6, flexWrap: "wrap", alignItems: "baseline" } },
                ui.RecordIdChip(t.id, { projectId, navigate: navigateRecord(router) }),
                ui.StatusBadge("tool_call_status", t.status),
                t.toolName ? h("span", { style: MUTED }, "工具：" + t.toolName) : null,
                t.attemptId ? h("span", { style: MUTED }, "尝试：", ui.RecordIdChip(t.attemptId, { projectId, navigate: navigateRecord(router) })) : null),
              t.error ? h("div", { style: MUTED }, "错误/说明：" + t.error) : null,
              t.evidenceRefs && t.evidenceRefs.length
                ? h("div", { style: MUTED }, "证据引用：", t.evidenceRefs.map((r, i) => h("span", { key: r || "r" + i, style: { marginRight: 6 } },
                    ui.RecordIdChip(r, { projectId, navigate: navigateRecord(router) }))))
                : null,
            ));
          }

        }
        children.push(h("section", { key: "attempts", style: SECTION },
          h("h3", { style: SECTION_TITLE }, "执行尝试、租约与工具调用（#23）"),
          ...nodes,
        ));
      }

      renderLog(children, projectId, router) {
        const { h, ui } = this.props;
        const log = this.state.log;
        const nodes = [];
        nodes.push(h("div", { key: "anchor-row", style: { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 6 } },
          h("input", { key: "sub", type: "text", "aria-label": "订阅编号", placeholder: "例如：SUBS-0002",
            value: this.state.subscriptionInput, style: INPUT,
            onChange: (e) => this.setSubscriptionInput(e && e.target ? e.target.value : ""),
            onKeyDown: (e) => { if (e && e.key === "Enter") this.submitSubscription(); } }),
          h("button", { key: "read-sub", type: "button", "aria-label": "从订阅边界读取", style: BTN_ACTIVE,
            onClick: () => this.submitSubscription() }, "从订阅边界读取"),
          h("button", { key: "read-head", type: "button", "aria-label": "从头读取", style: BTN,
            onClick: () => this.readFromHead() }, "从头读取")),
        );
        if (this.state.subscriptionError) {
          nodes.push(h("div", { key: "sub-err", style: DANGER_TEXT }, this.state.subscriptionError));
        }
        const hw = log.highWatermark;
        nodes.push(h("div", { key: "meta", style: MUTED },
          "当前区间：" + log.anchor + "；",
          hw ? "高水位（high_watermark）：#" + hw.commitSeq + "/" + hw.eventIndex + "；" : "",
          "has_more：" + (log.hasMore ? "true" : "false"),
          log.readOnly ? " · 只读视图（不写投递回执、不推进订阅游标）" : ""));
        if (log.subscription) {
          nodes.push(h("div", { key: "sub-info", style: MUTED },
            "订阅 " + (log.subscription.id || "—（未提供）") + "（修订 " + (log.subscription.subscription_revision !== undefined ? log.subscription.subscription_revision : "—（未提供）") + "） · ",
            "快照边界 commit_seq：" + (log.subscription.snapshot_commit_seq !== undefined && log.subscription.snapshot_commit_seq !== null ? log.subscription.snapshot_commit_seq : "—（未提供）") + " · ",
            "resume_cursor：" + (log.subscription.resume_cursor || "—（未提供）")));
        }

        if (log.phase === "idle") {
          nodes.push(h("div", { key: "idle", style: MUTED },
            projectId ? "正在准备读取事件流…" : "缺少项目上下文；请从左侧进入项目后查看变化流。"));
        } else if (log.phase === "loading") {
          nodes.push(h("div", { key: "loading", style: MUTED }, "正在读取事件流…"));
        } else if (log.phase === "notimpl") {
          nodes.push(h("div", { key: "notimpl", style: WARN_BOX },
            h("div", { style: { fontWeight: 600 } }, "变化流只读视图未实现（501，不是报错）"),
            h("div", { style: MUTED }, errMessage(log.error))));
        } else if (log.phase === "error") {
          nodes.push(h("div", { key: "error", style: DANGER_TEXT }, "事件流不可用：", errNotice(log.error)));
        } else if (log.phase === "unrecognized") {
          nodes.push(h("div", { key: "unrecognized", style: WARN_BOX },
            "事件流形状无法识别（数据源返回了未知结构；应含 events 与 next_cursor）。"));
        } else if (log.phase === "ok") {
          const counts = countEventsByType(log.events);
          nodes.push(h("div", { key: "counts", style: MUTED },
            "按事件类型分组（按已加载事件推导）：",
            counts.length
              ? counts.map(([type, n], i) => h("span", { key: type + i, style: { marginRight: 10 } }, type + " " + n))
              : "—（无）"));
          if (!log.events.length) {
            nodes.push(h("div", { key: "empty", style: MUTED },
              "（当前区间暂无事件；快照生成期间发生的变化会由边界之后的增量补齐）"));
          } else {
            nodes.push(h("div", { key: "events", style: { display: "flex", flexDirection: "column", gap: 6, marginTop: 6 } },
              log.events.map((ev, i) => this.renderEvent(ev, i, projectId, router))));
          }
          nodes.push(h("div", { key: "page-row", style: { display: "flex", gap: 8, alignItems: "center", marginTop: 8, flexWrap: "wrap" } },
            h("span", { key: "cur", style: MUTED }, "next_cursor：" + (log.nextCursor || "—（未提供）")),
            log.hasMore
              ? h("button", { key: "more", type: "button", "aria-label": "加载更多事件", style: BTN_ACTIVE,
                  onClick: () => this.loadLog({ projectId, mode: "more" }) }, "加载更多")
              : null,
            log.hasMore ? h("span", { key: "more-note", style: MUTED }, "（仍有未读取事件，游标续读不跳过区间）") : null));
        }
        nodes.push(h("div", { key: "note", style: MUTED },
          "查看≠消费，delivered≠applied：本页只读，不写投递回执、不推进订阅游标；事件按提交序号与页序有序呈现，payload 折叠不删记录。"));
        children.push(h("section", { key: "log", style: SECTION },
          h("h3", { style: SECTION_TITLE }, "变化流（只读视图，#45）"),
          ...nodes,
        ));
      }

      renderEvent(ev, index, projectId, router) {
        const { h, ui } = this.props;
        const sentence = EVENT_SENTENCES[ev.eventType] || "事件（未登记摘要，按类型原样呈现）";
        return h("div", { key: (ev.eventId || "ev") + "-" + index, style: CARD },
          h("div", { style: { display: "flex", gap: 6, flexWrap: "wrap", alignItems: "baseline" } },
            h("span", { key: "t", style: MUTED }, ui.formatTime(ev.createdAt)),
            h("span", { key: "seq", style: MUTED }, "#" + ev.commitSeq + "/" + ev.eventIndex),
            ui.StatusBadge("event_type", ev.eventType),
            h("span", { key: "s", style: { fontWeight: 600, color: "var(--sorne-text-primary)" } }, sentence)),
          h("div", { key: "subjects", style: { display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginTop: 2 } },
            h("span", { key: "l", style: MUTED }, "主体："),
            ev.subjectIds && ev.subjectIds.length
              ? ev.subjectIds.map((id, i) => h("span", { key: id || "s" + i, style: { marginRight: 4 } },
                  ui.isEventId && ui.isEventId(id)
                    ? h("span", { title: "事件编号（不属记录读取）；可在本页变化流中查看", style: { fontFamily: MONO } }, id)
                    : ui.RecordIdChip(id, { projectId, navigate: navigateRecord(router) })))
              : h("span", { key: "none", style: MUTED }, "—（无）")),
          h("div", { key: "payload", style: { marginTop: 2 } },
            ui.FoldableObject(ev.payload, { summary: "payload", level: 1 })),
          h("div", { key: "producer", style: MUTED },
            "生产者：" + (ev.producerId || "—（未提供）"),
            " · 变化字段：" + (ev.changedFields && ev.changedFields.length ? ev.changedFields.join("、") : "—（无）")),
        );
      }

      renderMetrics(children) {
        const { h, ui } = this.props;
        const metricsState = this.state.metrics;
        const nodes = [];
        if (metricsState.phase === "notimpl") {
          nodes.push(h("div", { key: "notimpl", style: WARN_BOX },
            "运行指标未实现（501，不是报错）；其余区块独立呈现。"));
        } else if (metricsState.phase === "error") {
          nodes.push(h("div", { key: "error", style: DANGER_TEXT }, "运行指标不可用：", errNotice(metricsState.error)));
        } else if (metricsState.phase === "unrecognized") {
          nodes.push(h("div", { key: "unrecognized", style: WARN_BOX }, "运行指标形状无法识别（应为对象信封），不静默当作空。"));
        } else if (metricsState.phase === "ok") {
          nodes.push(h("div", { key: "meta", style: MUTED },
            "指标数据时刻：" + (metricsState.data.generated_at ? ui.formatTime(metricsState.data.generated_at) : "—（未提供）"),
            " · 模式版本：" + (metricsState.data.schema_version !== undefined ? metricsState.data.schema_version : "—（未提供）")));
          nodes.push(h("div", { key: "raw", style: { marginTop: 4 } },
            ui.FoldableObject(metricsState.data, { summary: "运行指标原始 JSON（§20.2 全集）", level: 1 })));
        } else {
          nodes.push(h("div", { key: "loading", style: MUTED }, "正在读取运行指标…"));
        }
        nodes.push(h("div", { key: "note", style: MUTED }, "漏洞数量不是唯一健康指标；指标用于发现长期运行是否在浪费资源或遗漏成果。"));
        children.push(h("section", { key: "metrics", style: SECTION },
          h("h3", { style: SECTION_TITLE }, "运行指标（#41，原始 JSON 折叠）"),
          ...nodes,
        ));
      }
    }

    return h("div", { style: WRAP },
      h("h2", { style: { margin: 0, fontSize: 17, color: "var(--sorne-text-primary)" } }, "系统诊断"),
      h("div", { style: { fontSize: 14, lineHeight: 1.6, color: "var(--sorne-text-secondary)" } },
        "查看系统内部健康、执行租约、变化流与运行指标；全部只读，不改任何执行与计划状态。"),
      h(DiagnosticsBody, { h, api, router, ui }),
    );
  },
};

/* ── 页面内公共小工具（页面模块不得引包，故本文件自带） ────────────── */

function navigateRecord(router) {
  return (id) => {
    if (router && typeof router.openRecord === "function") router.openRecord(id);
  };
}

function isNotImplemented(e) {
  return Boolean(e && (e.code === "NOT_IMPLEMENTED" || e.status === 501));
}

function errMessage(e) {
  if (!e) return "未知错误";
  if (e.message) return e.message;
  if (e.code || e.status) return "错误码 " + (e.code || "未知") + "（HTTP " + (e.status !== undefined ? e.status : "?") + "）";
  return String(e);
}

function errNotice(e) {
  if (!e) return "未知错误";
  if (e.message) return (e.code ? e.code + " · " : "") + e.message;
  return errMessage(e);
}

function notImplModule(e) {
  const m = /由模块\s+([A-Za-z0-9]+)\s+施工/.exec(errMessage(e));
  return m ? m[1] : "";
}

/* ── 响应形状防御（未知形状显式呈现，不静默当作空） ───────────────── */

function extractDiagnostics(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  if (!data.health && !data.project && !data.llm) return null;
  return data;
}

function extractChangeLog(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  if (!Array.isArray(data.events) || typeof data.next_cursor !== "string") return null;
  const events = data.events.map((ev) => {
    const src = ev && typeof ev === "object" ? ev : {};
    return {
      eventId: firstStringOf(src.event_id, src.eventId),
      commitSeq: src.commit_seq,
      eventIndex: src.event_index,
      eventType: firstStringOf(src.event_type, src.eventType),
      subjectIds: Array.isArray(src.subject_ids) ? src.subject_ids.map(String) : [],
      changedFields: Array.isArray(src.changed_fields) ? src.changed_fields.map(String) : [],
      producerId: firstStringOf(src.producer_id),
      createdAt: firstStringOf(src.created_at),
      payload: src.payload !== undefined && src.payload !== null ? src.payload : {},
    };
  });
  const hw = data.high_watermark && typeof data.high_watermark === "object"
    ? { commitSeq: data.high_watermark.commit_seq, eventIndex: data.high_watermark.event_index }
    : null;
  return {
    events,
    nextCursor: data.next_cursor,
    highWatermark: hw,
    hasMore: Boolean(data.has_more),
    readOnly: data.read_only !== false,
    subscription: data.subscription && typeof data.subscription === "object" ? data.subscription : null,
  };
}

function extractMetrics(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const known = ["schema_version", "generated_at", "scope", "outbox", "projection_lag", "save_latency"];
  for (const k of known) {
    if (k in data) return data;
  }
  return null;
}

function extractAttempts(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const keys = ["attempts", "items", "list", "results"];
  for (const k of keys) {
    if (Array.isArray(data[k])) return data[k];
  }
  return null;
}

function attemptsCursorOf(data) {
  if (!data || typeof data !== "object") return "";
  if (typeof data.next_cursor === "string" && data.next_cursor) return data.next_cursor;
  if (typeof data.next_after === "string" && data.next_after) return data.next_after;
  return "";
}

/* ── 领域归一化（信封字段别名防御；展示不改写服务端原值） ─────────── */

function normalizeAttempt(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const lease = src.lease && typeof src.lease === "object" && !Array.isArray(src.lease) ? src.lease : {};
  return {
    id: firstStringOf(src.id, src.attempt_id),
    intentId: firstStringOf(src.intent_id, src.intentId),
    assignmentId: firstStringOf(src.assignment_id, src.assignmentId),
    workerId: firstStringOf(src.worker_id, src.workerId),
    fencingToken: src.fencing_token !== undefined ? src.fencing_token : src.fencingToken,
    leaseExpiresAt: firstStringOf(src.lease_expires_at, src.leaseExpiresAt, lease.expires_at),
    status: firstStringOf(src.status, src.state),
    recoveryNote: src.recovery_note !== undefined && src.recovery_note !== null ? src.recovery_note : "",
    toolSummary: toolSummaryText(src.tool_calls),
    byStatus: src.tool_calls && typeof src.tool_calls === "object" && !Array.isArray(src.tool_calls)
      ? (src.tool_calls.by_status && typeof src.tool_calls.by_status === "object" ? src.tool_calls.by_status : {})
      : {},
    raw: src,
  };
}

function normalizeToolCall(raw, attemptId) {
  const src = raw && typeof raw === "object" ? raw : {};
  return {
    id: firstStringOf(src.id, src.tool_call_id),
    attemptId: firstStringOf(attemptId, src.attempt_id, src.attemptId),
    toolName: firstStringOf(src.tool_name, src.toolName, src.name),
    status: firstStringOf(src.status, src.state),
    error: firstStringOf(src.error, src.note, src.message),
    evidenceRefs: toStringArray(src.evidence_refs !== undefined ? src.evidence_refs : src.evidenceRefs),
    raw: src,
  };
}

function toolSummaryText(toolCalls) {
  if (!toolCalls || typeof toolCalls !== "object" || Array.isArray(toolCalls)) return "";
  const by = toolCalls.by_status && typeof toolCalls.by_status === "object" ? toolCalls.by_status : {};
  return [
    "共 " + (typeof toolCalls.total === "number" ? toolCalls.total : "—（未提供）"),
    "结果未知 " + (by.unknown || 0),
    "执行中 " + (by.running || 0),
    "已成功 " + (by.succeeded || 0),
    "已失败 " + (by.failed || 0),
    "已取消 " + (by.cancelled || 0),
    "计划中 " + (by.planned || 0),
  ].join(" · ");
}

function failedCallsOf(attempt) {
  const by = attempt && attempt.byStatus ? attempt.byStatus : {};
  return typeof by.failed === "number" ? by.failed : 0;
}

/** 工具调用随队列视图提供，识别三种形态（同旧执行页口径）：
 *  ① 顶层 tool_calls 数组；② 各尝试内嵌数组；③ C2 落地信封的摘要对象
 *  （total/by_status + running/unknown 明细 + planned 编号 → 物化可呈现明细并置 summaryOnly）。 */
function collectToolCalls(response, attemptItems) {
  const calls = [];
  let provided = false;
  let summaryOnly = false;
  const top = response && typeof response === "object" && !Array.isArray(response)
    ? firstArray(response.tool_calls, response.toolCalls)
    : null;
  if (top !== null) {
    provided = true;
    for (const tc of top) calls.push(normalizeToolCall(tc));
  }
  for (const a of attemptItems) {
    const embedded = a.raw ? firstArray(a.raw.tool_calls, a.raw.toolCalls) : null;
    if (embedded !== null) {
      provided = true;
      for (const tc of embedded) calls.push(normalizeToolCall(tc, a.id));
      continue;
    }
    const summary = a.raw && a.raw.tool_calls && typeof a.raw.tool_calls === "object" && !Array.isArray(a.raw.tool_calls)
      ? a.raw.tool_calls
      : null;
    if (summary) {
      provided = true;
      summaryOnly = true;
      const unknowns = Array.isArray(summary.unknown) ? summary.unknown : [];
      const runnings = Array.isArray(summary.running) ? summary.running : [];
      const planned = Array.isArray(summary.planned) ? summary.planned : [];
      for (const tc of unknowns) {
        calls.push(normalizeToolCall(tc && typeof tc === "object" ? { ...tc, status: "unknown" } : { status: "unknown" }, a.id));
      }
      for (const tc of runnings) {
        calls.push(normalizeToolCall(tc && typeof tc === "object" ? { ...tc, status: "running" } : { status: "running" }, a.id));
      }
      for (const id of planned) {
        if (typeof id === "string" && id) calls.push(normalizeToolCall({ id, status: "planned" }, a.id));
      }
    }
  }
  return { calls, provided, summaryOnly };
}

function firstArray(...values) {
  for (const v of values) {
    if (Array.isArray(v)) return v;
  }
  return null;
}

function firstStringOf(...values) {
  for (const v of values) {
    if (typeof v === "string" && v) return v;
  }
  return "";
}

function toStringArray(value) {
  if (Array.isArray(value)) return value.map((x) => (typeof x === "string" ? x : safeJson(x))).filter(Boolean);
  if (typeof value === "string" && value) return [value];
  return [];
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function mergeById(prev, next) {
  const seen = new Set((Array.isArray(prev) ? prev : []).map((p) => p && p.id).filter(Boolean));
  const out = Array.isArray(prev) ? [...prev] : [];
  for (const p of next) {
    if (p && p.id && !seen.has(p.id)) {
      out.push(p);
      seen.add(p.id);
    }
  }
  return out;
}

/* ── 租约剩余时间（按渲染时刻计算；四态：剩余/已过期/未提供/无法解析） ── */

function leaseStateOf(attempt, nowMs) {
  const raw = attempt && attempt.leaseExpiresAt;
  if (!raw) return { kind: "absent", expiresText: "未提供", remainingText: "" };
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return { kind: "invalid", expiresText: "无法解析（" + raw + "）", remainingText: "" };
  const remainingMs = t - nowMs;
  if (remainingMs > 0) return { kind: "live", expiresText: raw, remainingText: formatDuration(remainingMs) };
  return { kind: "expired", expiresText: raw, remainingText: formatDuration(-remainingMs) };
}

function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (d > 0) return d + " 天 " + h + " 小时";
  if (h > 0) return h + " 小时 " + m + " 分";
  if (m > 0) return m + " 分 " + s + " 秒";
  return s + " 秒";
}

/* ── 事件类型分组计数（按已加载事件推导） ─────────────────────────── */

function countEventsByType(events) {
  const counts = {};
  for (const ev of events) {
    const k = ev && ev.eventType ? ev.eventType : "—（未提供）";
    counts[k] = (counts[k] || 0) + 1;
  }
  return Object.keys(counts).map((k) => [k, counts[k]]).sort((a, b) => b[1] - a[1]);
}

/* ── 内联样式常量（全部经 var(--sorne-*) token；无字面颜色值） ────── */

const WRAP = { display: "flex", flexDirection: "column", gap: 12, width: "100%" };
const SECTION = {
  padding: "12px 14px", borderRadius: 8, background: "var(--sorne-bg-surface)",
  border: "1px solid var(--sorne-border)", fontSize: 14, lineHeight: 1.6,
};
const SECTION_TITLE = {
  margin: "0 0 6px", fontSize: 15, fontWeight: 700, color: "var(--sorne-text-primary)",
};
const CARD = {
  padding: "8px 10px", borderRadius: 7, background: "var(--sorne-bg-raised)",
  border: "1px solid var(--sorne-border)", fontSize: 13.5, lineHeight: 1.6,
};
const CARD_ATTENTION = { borderColor: "var(--sorne-status-unknown-fg)" };
const MUTED = { fontSize: 13, lineHeight: 1.6, color: "var(--sorne-text-secondary)" };
const DANGER_TEXT = { fontSize: 13.5, lineHeight: 1.6, color: "var(--sorne-status-unknown-fg)", fontWeight: 600 };
const DANGER_BOX = {
  padding: "10px 12px", borderRadius: 8, fontSize: 14, lineHeight: 1.6,
  border: "1px solid var(--sorne-status-unknown-fg)",
  background: "var(--sorne-status-unknown-bg)",
  color: "var(--sorne-status-unknown-fg)",
};
const WARN_BOX = {
  padding: "8px 10px", borderRadius: 7, fontSize: 13, lineHeight: 1.6,
  border: "1px solid var(--sorne-border-strong)", background: "var(--sorne-bg-subtle)",
  color: "var(--sorne-text-secondary)",
};
const INPUT = {
  padding: "5px 9px", fontSize: 13, borderRadius: 6,
  border: "1px solid var(--sorne-border-strong)",
  background: "var(--sorne-bg-raised)", color: "var(--sorne-text-primary)",
  width: 200, boxSizing: "border-box", fontFamily: "inherit", lineHeight: 1.55,
};
const BTN = {
  padding: "5px 12px", fontSize: 13, borderRadius: 6, cursor: "pointer", fontFamily: "inherit",
  border: "1px solid var(--sorne-border-strong)",
  background: "var(--sorne-bg-surface)", color: "var(--sorne-text-primary)",
  lineHeight: 1.55,
};
const BTN_ACTIVE = { ...BTN, borderColor: "var(--sorne-brand)", color: "var(--sorne-brand)" };
const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";
