/**
 * 页面：项目列表（lib/ui/pages/projects.page.mjs；M3 独占重写；BLUEPRINT-UI §1.3）。
 *
 * 只展示五列（要求 §2）：项目｜当前状态｜最近进展｜待处理事项｜最近活动。
 *   - 数据来自 GET /sorne/projects?include=summary（#4 summary 扩展，真分页
 *     cursor/has_more；五列字段全部来自库内记录，计数按已加载数据推导，不代表全量）；
 *   - 整行点击进入工作区 #/p/:pid/workbench（项目上下文经路由共享，切页不重选项目）；
 *     「最近进展」列中的完整记录编号渲染为编号 chip（经 ui.parseRecordId 整体校验后
 *     交 ui.RecordIdChip——不做子串匹配，绝不用残缺编号打开错误记录），点击直达详情；
 *   - 真分页：仅当 has_more=true 渲染「加载更多」（没有后端分页的列表一律不渲染
 *     该按钮——评审 §4d「死代码加载更多」在此消灭）；
 *   - 空列表：三步引导「连接模型 → 创建项目 → 开始探索」（模型未配置时第一步直达
 *     向导连接页）；无数据的（空）块默认隐藏，空值显示「—（未提供）」
 *     （未提供 ≠ 不存在）；
 *   - 服务端未返回 summary 字段（旧形体）时如实标注「未提供」，不伪造数据。
 *
 * 语义纪律（冻结）：每个数据面标注数据时刻与「按已加载数据推导」；状态经词表徽章
 * 呈现（未知值原样告警，不猜测）；用户可见文案中文。
 *
 * 页面契约（§2.5）：纯 ESM、不 import 任何包或 Node 内置模块、不用浏览器本地存储；
 * export default { id, title, order, render(ctx) }；有状态部分收敛为单个
 * React.Component 子类（外壳冻结渲染协议；路由变化经 router.onChange 订阅，
 * keep-alive 外壳切走再切回时静默刷新列表）。
 */

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

const INPUT = {
  fontSize: 14, padding: "6px 10px", borderRadius: 6,
  border: "1px solid var(--sorne-border-strong)",
  background: "var(--sorne-bg-surface)", color: "var(--sorne-text-primary)",
  fontFamily: "inherit", width: "100%", boxSizing: "border-box",
};
const FIELD = { display: "flex", flexDirection: "column", gap: 5, fontSize: 13, color: "var(--sorne-text-secondary)" };
const CARD_BOX = {
  border: "1px solid var(--sorne-border)", borderRadius: 8,
  padding: "12px 14px", background: "var(--sorne-bg-surface)",
  display: "flex", flexDirection: "column", gap: 10,
};

function errorMessage(e) {
  const err = e || {};
  const msg = err.message ? String(err.message) : String(err);
  return err.code ? `${err.code} · ${msg}` : msg;
}

/** 待处理事项文本：仅列非零计数（计数按已加载数据推导，单元格 title 注明口径）。 */
function pendingParts(row) {
  const p = row && row.pending;
  if (!p || typeof p !== "object") return null; // 未提供（旧形体）
  const parts = [];
  if (p.unhandled_reports > 0) parts.push(`未处理汇报 ${p.unhandled_reports}`);
  if (p.pending_verification > 0) parts.push(`待验证 ${p.pending_verification}`);
  if (p.blocked_intents > 0) parts.push(`受阻方向 ${p.blocked_intents}`);
  return parts;
}

/**
 * 最近进展 → 文本与编号 chip 混排。
 * 仅做「完整候选片段」的编号校验（分隔符切分后整体交给 ui.parseRecordId）——
 * 编号模式匹配唯一实现在 lib/ui/record-ids.mjs，本页不做任何编号正则；
 * 解析失败的片段按原样文本呈现，不猜测、不截断。
 */
const EVENT_TYPE_LABELS = {
  "asset.discovered": "发现新资产",
  "capture.completed": "采集完成",
  "resource.content_changed": "内容版本变化",
  "observation.appended": "新增观察",
  "hypothesis.proposed": "新增/修订假设",
  "evidence_set.revised": "证据集变化",
  "verification.completed": "验证完成",
  "judgement.invalidated": "判断失效",
  "intent.blocked": "方向受阻",
  "intent.completed": "方向完成",
  "scope.revised": "范围更新",
  "resource_state.changed": "运行状态变化",
  "dependency.changed": "依赖变化",
  "vulnerability.state_changed": "漏洞状态变化",
  "orchestration.decision_recorded": "协调决定",
  "worker_report.submitted": "收到汇报",
  "plan.received": "计划已接收",
  "message.received": "收到用户消息",
  "message.handled": "消息已处理",
  "relation.added": "关系新增",
};

function progressNodes(row, ui, router) {
  let raw = row && typeof row.latest_progress === "string" ? row.latest_progress : "";
  if (!raw.trim()) return null;
  // 事件类型 → 中文短语（原始 event_type 保留在悬停 title 中，不丢失机器可读信息）。
  const m = /^([a-z][a-z0-9_.]*)([\s\S]*)$/.exec(raw.trim());
  if (m && EVENT_TYPE_LABELS[m[1]]) raw = EVENT_TYPE_LABELS[m[1]] + m[2];
  const canChip = ui && typeof ui.parseRecordId === "function" && typeof ui.RecordIdChip === "function";
  if (!canChip) return [raw];
  const parts = raw.split(/[\s（）、；;，,]+/).filter(Boolean);
  const out = [];
  parts.forEach((p, i) => {
    if (i > 0) out.push(" ");
    const parsed = ui.parseRecordId(p);
    if (parsed && parsed.id) {
      out.push(ui.RecordIdChip(parsed.id, {
        projectId: row.id,
        navigate: (id) => {
          if (router && typeof router.openRecord === "function") router.openRecord(id);
        },
      }));
    } else {
      out.push(p);
    }
  });
  return out;
}

export default {
  id: "projects",
  title: "项目",
  order: 10,
  render({ React, h, api, router, ui, theme }) {
    const ComponentBase =
      React && typeof React.Component === "function"
        ? React.Component
        : class PageComponentBase {
            constructor(props) {
              this.props = props || {};
            }
          };

    class ProjectsBody extends ComponentBase {
      constructor(props) {
        super(props);
        this.state = {
          list: { phase: "loading", rows: [], nextCursor: null, hasMore: false, error: null, summaryMissing: false, unknownShape: false },
          llm: { phase: "loading", data: null, error: null },
          dataAt: null,
          navSeq: 0,
          form: { name: "", target: "", task: "", baseUrl: "", apiKey: "", model: "" },
          create: { running: false, msg: null },
          deleteConfirmId: null,
          deleting: false,
        };
        this.onNav = this.onNav.bind(this);
        this.unsubNav = null;
        this.loadSeq = 0;
      }

      componentDidMount() {
        this.load(null, { append: false, silent: false });
        this.reloadLlm();
        const router = this.props.router;
        if (router && typeof router.onChange === "function") {
          this.unsubNav = router.onChange(this.onNav);
        }
      }

      componentWillUnmount() {
        if (typeof this.unsubNav === "function") this.unsubNav();
      }

      onNav() {
        // keep-alive 外壳：回到本页时静默刷新（阅读位由外壳保留，数据保持新鲜）。
        const router = this.props.router;
        if (router && router.page === "projects") {
          this.setState((prev) => ({ navSeq: prev.navSeq + 1 }));
          this.load(null, { append: false, silent: true });
          this.reloadLlm();
        }
      }

      async reloadLlm() {
        const { api } = this.props;
        if (typeof api !== "function") {
          this.setState({ llm: { phase: "error", data: null, error: { message: "当前宿主未提供 API 通道" } } });
          return;
        }
        try {
          const data = await api("/sorne/llm/settings");
          this.setState((prev) => ({
            llm: { phase: "ready", data, error: null },
            form: {
              ...prev.form,
              baseUrl: prev.form.baseUrl || (data && data.base_url) || "",
              model: prev.form.model || (data && data.model) || "",
            },
          }));
        } catch (e) {
          this.setState({ llm: { phase: "error", data: null, error: e } });
        }
      }

      updateForm(field, value) {
        this.setState((prev) => ({
          form: { ...prev.form, [field]: value },
          create: { ...prev.create, msg: null },
        }));
      }

      async createProject() {
        const { api } = this.props;
        const form = this.state.form;
        const name = form.name.trim();
        const target = form.target.trim();
        if (typeof api !== "function") {
          this.setState({ create: { running: false, msg: { kind: "error", text: "当前宿主未提供 API 通道" } } });
          return;
        }
        if (!name) {
          this.setState({ create: { running: false, msg: { kind: "error", text: "项目名称必填" } } });
          return;
        }
        if (!/^https?:\/\//i.test(target)) {
          this.setState({ create: { running: false, msg: { kind: "error", text: "测试目标必填，且必须是 http(s) URL" } } });
          return;
        }
        const baseUrl = form.baseUrl.trim();
        const model = form.model.trim();
        if ((baseUrl && !model) || (!baseUrl && model)) {
          this.setState({ create: { running: false, msg: { kind: "error", text: "LLM 配置需要 Base URL 与模型名同时填写（或都留空）" } } });
          return;
        }
        const body = {
          name,
          description: target,
          task: form.task.trim(),
          target,
        };
        if (baseUrl && model) {
          body.llm = { baseUrl, model };
          if (form.apiKey.trim()) body.llm.apiKey = form.apiKey.trim();
        }
        this.setState({ create: { running: true, msg: null } });
        try {
          const res = await api("/sorne/projects", { method: "POST", body: JSON.stringify(body) });
          const id = res && res.project ? res.project.id : null;
          this.setState({
            form: { name: "", target: "", task: "", baseUrl: "", apiKey: "", model: "" },
            create: { running: false, msg: { kind: "ok", text: id ? `已创建项目 ${id}` : "已创建项目" } },
          });
          this.reloadLlm();
          await this.load(null, { append: false, silent: true });
        } catch (e) {
          this.setState({ create: { running: false, msg: { kind: "error", text: errorMessage(e) } } });
        }
      }

      async removeProject(row) {
        const { api } = this.props;
        if (typeof api !== "function") return;
        if (this.state.deleteConfirmId !== row.id) {
          this.setState({ deleteConfirmId: row.id });
          return;
        }
        this.setState({ deleting: true, deleteConfirmId: null });
        try {
          await api(`/sorne/projects/${encodeURIComponent(row.id)}?confirm=delete`, { method: "DELETE" });
          await this.load(null, { append: false, silent: true });
        } catch (e) {
          this.setState({ create: { running: false, msg: { kind: "error", text: "删除失败：" + errorMessage(e) } } });
        } finally {
          this.setState({ deleting: false });
        }
      }

      async load(cursor, { append, silent }) {
        const { api } = this.props;
        if (typeof api !== "function") {
          this.setState({
            list: { phase: "error", rows: [], nextCursor: null, hasMore: false, error: { message: "当前宿主未提供 API 通道" }, summaryMissing: false, unknownShape: false },
          });
          return;
        }
        const seq = ++this.loadSeq;
        if (!silent) {
          this.setState((prev) => ({
            list: { ...prev.list, phase: append ? prev.list.phase : "loading", error: null },
          }));
        }
        try {
          const q = new URLSearchParams({ include: "summary", limit: "50" });
          if (cursor) q.set("cursor", cursor);
          const data = await api(`/sorne/projects?${q.toString()}`);
          if (seq !== this.loadSeq) return; // 过期响应丢弃
          const rows = data && Array.isArray(data.projects) ? data.projects : null;
          if (!rows) {
            this.setState({
              list: { phase: "ready", rows: [], nextCursor: null, hasMore: false, error: null, summaryMissing: false, unknownShape: true },
              dataAt: new Date().toISOString(),
            });
            return;
          }
          const summaryMissing = rows.length > 0 && rows.every((r) => !("latest_progress" in r) && !("pending" in r));
          this.setState((prev) => ({
            list: {
              phase: "ready",
              rows: append ? [...prev.list.rows, ...rows] : rows,
              nextCursor: data && data.next_cursor ? data.next_cursor : null,
              hasMore: Boolean(data && data.has_more),
              error: null,
              summaryMissing,
              unknownShape: false,
            },
            dataAt: new Date().toISOString(),
          }));
        } catch (e) {
          if (seq !== this.loadSeq) return;
          this.setState((prev) => ({
            list: { ...prev.list, phase: "error", error: e, summaryMissing: false },
            dataAt: new Date().toISOString(),
          }));
        }
      }

      openWorkspace(row) {
        const router = this.props.router;
        if (router && typeof router.open === "function") {
          router.open(`#/p/${encodeURIComponent(row.id)}/workbench`);
        }
      }

      render() {
        const { h, ui, router } = this.props;
        const { list, llm, dataAt } = this.state;
        const hasNav = Boolean(router && typeof router.open === "function");

        if (!ui || typeof ui.formatTime !== "function") {
          return h("div", { style: WRAP },
            h("div", {
              role: "alert",
              style: { border: "1px dashed var(--sorne-border-strong)", borderRadius: 8, padding: "14px 16px", fontSize: 14, lineHeight: 1.7, color: "var(--sorne-text-secondary)" },
            },
              h("div", { style: { fontWeight: 600, color: "var(--sorne-text-primary)" } }, "渲染器未就绪"),
              h("div", null, "项目列表依赖设计系统渲染器（ui.formatTime / StatusBadge / RecordIdChip 等）。当前宿主未提供，页面以降级态呈现，不做数据猜测。"),
            ),
          );
        }

        const children = [];

        children.push(h(
          "div",
          { key: "head", style: { display: "flex", flexDirection: "column", gap: 4 } },
          h("h2", { style: { margin: 0, fontSize: 17, color: "var(--sorne-text-primary)" } }, "项目"),
          h("div", { style: { fontSize: 14, lineHeight: 1.6, color: "var(--sorne-text-secondary)" } },
            "点击项目进入工作区；资产、探索、发现、报告都继承所选项目。五列数据来自真实记录，计数按已加载数据推导。",
          ),
        ));

        // 新建项目（名称 / 测试目标 / 测试任务 / LLM 基础配置）；创建即落库并建初始范围
        children.push(h(
          "div",
          { key: "create", style: CARD_BOX },
          h("div", { style: { fontSize: 15, fontWeight: 600, color: "var(--sorne-text-primary)" } }, "新建项目"),
          h("div", { style: { fontSize: 13, color: "var(--sorne-text-secondary)", lineHeight: 1.6 } },
            "名称与测试目标（http/https URL）必填；测试任务与 LLM 基础配置可选。创建后测试目标会成为初始允许范围。"),
          h("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 } },
            h("label", { style: FIELD }, "项目名称 *",
              h("input", { type: "text", value: this.state.form.name, placeholder: "如：OA 授权测试", onChange: (e) => this.updateForm("name", e.target.value), style: INPUT })),
            h("label", { style: FIELD }, "测试目标 *（http/https URL）",
              h("input", { type: "text", value: this.state.form.target, placeholder: "如：http://oa.example.com/", onChange: (e) => this.updateForm("target", e.target.value), style: INPUT })),
            h("label", { style: FIELD }, "测试任务（可选）",
              h("input", { type: "text", value: this.state.form.task, placeholder: "如：获取服务器权限 / 验证会话缺陷", onChange: (e) => this.updateForm("task", e.target.value), style: INPUT })),
            h("label", { style: FIELD }, "LLM Base URL（可选）",
              h("input", { type: "text", value: this.state.form.baseUrl, placeholder: "https://api.deepseek.com", onChange: (e) => this.updateForm("baseUrl", e.target.value), style: INPUT })),
            h("label", { style: FIELD }, "LLM 模型名（可选）",
              h("input", { type: "text", value: this.state.form.model, placeholder: "deepseek-flash", onChange: (e) => this.updateForm("model", e.target.value), style: INPUT })),
            h("label", { style: FIELD }, "LLM API Key（可选；留空沿用已保存）",
              h("input", { type: "password", value: this.state.form.apiKey, placeholder: llm.data && llm.data.api_key_set ? "已保存密钥：留空即沿用" : "仅提交到服务端保存，不回显", onChange: (e) => this.updateForm("apiKey", e.target.value), style: INPUT })),
          ),
          this.state.create.msg
            ? h("div", { role: this.state.create.msg.kind === "error" ? "alert" : "status", style: {
                fontSize: 13, color: this.state.create.msg.kind === "error" ? "var(--sorne-status-unknown-fg)" : "var(--sorne-text-secondary)",
              } }, this.state.create.msg.text)
            : null,
          h("div", { style: { display: "flex", gap: 8, alignItems: "center" } },
            h("button", { type: "button", "aria-label": "创建项目", disabled: this.state.create.running, onClick: () => this.createProject(), style: btnStyle("primary", this.state.create.running) },
              this.state.create.running ? "创建中…" : "创建项目"),
            h("span", { style: { fontSize: 12.5, color: "var(--sorne-text-muted)" } }, "LLM 配置保存到全局 sorne-data/llm.json；已有项目同样生效。"),
          ),
        ));

        // 模型未连接提示（引导层可见；绝不以「服务正常」暗示 AI 可工作）
        if (llm.phase === "ready" && llm.data && llm.data.configured === false) {
          children.push(h(
            "div",
            { key: "llm-banner", role: "status", style: {
                display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center",
                padding: "8px 12px", borderRadius: 8, fontSize: 14,
                border: "1px solid var(--sorne-status-suspected-fg)",
                background: "var(--sorne-status-suspected-bg)",
                color: "var(--sorne-status-suspected-fg)",
              } },
            h("span", { style: { fontWeight: 600 } }, "尚未连接模型，项目可以保存，AI 暂不能开始"),
            hasNav
              ? h("button", { type: "button", "aria-label": "去连接模型", onClick: () => router.open("#/onboarding"), style: btnStyle(null) }, "去连接模型")
              : null,
          ));
        }

        if (list.phase === "loading") {
          children.push(h("div", { key: "loading", role: "status", style: { fontSize: 14, color: "var(--sorne-text-secondary)" } }, "正在加载项目列表…"));
          return h("div", { style: WRAP }, ...children);
        }

        if (list.phase === "error") {
          children.push(h("div", { key: "error", role: "alert", style: {
              border: "1px dashed var(--sorne-border-strong)", borderRadius: 8,
              padding: "14px 16px", fontSize: 14, lineHeight: 1.7,
              color: "var(--sorne-status-unknown-fg)",
            } },
            h("div", { style: { fontWeight: 600 } }, "项目列表加载失败"),
            h("div", null, errorMessage(list.error)),
            h("button", { type: "button", "aria-label": "重试加载项目列表", onClick: () => this.load(null, { append: false, silent: false }), style: btnStyle(null) }, "重试"),
          ));
          return h("div", { style: WRAP }, ...children);
        }

        if (list.unknownShape) {
          children.push(h("div", { key: "unknown", role: "alert", style: {
              border: "1px dashed var(--sorne-border-strong)", borderRadius: 8,
              padding: "14px 16px", fontSize: 14, lineHeight: 1.7, color: "var(--sorne-text-secondary)",
            } },
            "项目列表响应形状无法识别（缺少 projects 数组）——已按空列表处理，不做猜测；请稍后重试。",
          ));
        }

        if (!list.rows.length) {
          // 空态：三步引导（要求 §2）。无数据的（空）块默认隐藏——不渲染任何「（空）」块。
          const modelHint = llm.phase === "ready" && llm.data && llm.data.configured === false
            ? "当前尚未连接模型：项目可以保存，AI 暂不能开始。"
            : null;
          const actions = [];
          if (hasNav) {
            actions.push(h("button", { key: "s1", type: "button", "aria-label": "第一步：连接模型", onClick: () => router.open("#/onboarding"), style: btnStyle("primary") }, "① 连接模型"));
            actions.push(h("button", { key: "s2", type: "button", "aria-label": "第二步：创建项目", onClick: () => router.open("#/onboarding"), style: btnStyle(null) }, "② 创建项目"));
            actions.push(h("span", { key: "s3", style: { fontSize: 13.5, color: "var(--sorne-text-secondary)", alignSelf: "center" } }, "③ 开始探索（向导第④步或进入项目后开始）"));
          } else {
            actions.push(h("span", { key: "note", style: { fontSize: 13.5, color: "var(--sorne-text-secondary)" } },
              "引导入口需要导航模块（router）；当前宿主未提供，暂无法跳转向导。"));
          }
          children.push(ui.EmptyState({
            key: "empty",
            title: "还没有项目",
            hint: modelHint ? `从三步开始：连接模型 → 创建项目 → 开始探索。${modelHint}` : "从三步开始：连接模型 → 创建项目 → 开始探索。",
            actions,
          }));
        } else {
          children.push(this.renderTable());
          if (list.summaryMissing) {
            children.push(h("div", { key: "summary-note", role: "status", style: { fontSize: 13.5, lineHeight: 1.6, color: "var(--sorne-text-secondary)" } },
              "服务端未返回五列摘要字段（最近进展 / 待处理事项 / 最近活动）：本页按「—（未提供）」呈现——未提供不等于不存在；summary 扩展竣工后将自动呈现。",
            ));
          }
          if (list.hasMore && list.nextCursor) {
            children.push(h("button", {
              key: "more",
              type: "button",
              "aria-label": "加载更多项目",
              onClick: () => this.load(list.nextCursor, { append: true, silent: false }),
              style: btnStyle(null),
            }, "加载更多项目"));
          }
          // has_more 为假或缺失时不渲染任何「加载更多」（评审 §4d：死代码一律不渲染）。
        }

        children.push(h("div", { key: "meta", style: { fontSize: 13, color: "var(--sorne-text-muted)" } },
          `数据时刻：${ui.formatTime(dataAt)} · 已加载 ${list.rows.length} 个项目 · 计数按已加载数据推导${list.hasMore ? " · 不代表全量（还有未加载页）" : ""}`,
        ));

        return h("div", { style: WRAP }, ...children);
      }

      renderTable() {
        const { h, ui, router } = this.props;
        const { list } = this.state;
        const hasNav = Boolean(router && typeof router.open === "function");
        const headerCells = [
          { key: "name", label: "项目" },
          { key: "status", label: "当前状态" },
          { key: "progress", label: "最近进展" },
          { key: "pending", label: "待处理事项" },
          { key: "activity", label: "最近活动" },
          { key: "ops", label: "操作" },
        ];
        return h("table", {
          key: "table",
          style: { width: "100%", borderCollapse: "collapse", fontSize: 14, lineHeight: 1.55 },
        },
          h("thead", null,
            h("tr", null, headerCells.map((c) =>
              h("th", {
                key: c.key,
                scope: "col",
                style: {
                  textAlign: "left", padding: "6px 10px", fontSize: 13,
                  color: "var(--sorne-text-secondary)",
                  background: "var(--sorne-bg-subtle)",
                  borderBottom: "1px solid var(--sorne-border)",
                  whiteSpace: "nowrap",
                },
              }, c.label),
            ))),
          h("tbody", null, list.rows.map((row) => {
            const progress = progressNodes(row, ui, router);
            const pending = pendingParts(row);
            const clickable = hasNav;
            return h("tr", {
              key: row.id,
              onClick: clickable ? () => this.openWorkspace(row) : undefined,
              style: {
                borderBottom: "1px solid var(--sorne-border)",
                background: "var(--sorne-bg-surface)",
                cursor: clickable ? "pointer" : "default",
              },
            },
              h("td", { style: TD },
                h("div", { style: { fontWeight: 600, color: "var(--sorne-text-primary)" } },
                  clickable
                    ? h("button", {
                        type: "button",
                        "aria-label": `进入项目 ${row.name || row.id} 工作区`,
                        onClick: (e) => {
                          if (e && typeof e.stopPropagation === "function") e.stopPropagation();
                          this.openWorkspace(row);
                        },
                        style: {
                          background: "transparent", border: "none", padding: 0,
                          font: "inherit", fontWeight: 600, cursor: "pointer",
                          color: "var(--sorne-brand)", textAlign: "left",
                        },
                      }, row.name || row.id)
                    : (row.name || row.id),
                ),
                h("div", { style: { fontSize: 12.5, color: "var(--sorne-text-muted)" } }, row.id || "—（未提供）"),
              ),
              h("td", { style: TD },
                ui.StatusBadge("project_status", row.status)),
              h("td", { style: TD },
                progress
                  ? h("span", { style: { wordBreak: "break-all" } }, ...progress)
                  : "—（未提供）"),
              h("td", { style: TD, title: "按已加载数据推导" },
                pending === null
                  ? "—（未提供）"
                  : pending.length
                    ? pending.join(" · ")
                    : "—"),
              h("td", { style: TD }, ui.formatTime(row.last_activity_at)),
              h("td", { style: TD },
                this.state.deleteConfirmId === row.id
                  ? h("div", { style: { display: "flex", gap: 6 } },
                      h("button", {
                        type: "button",
                        "aria-label": `确认删除项目 ${row.name || row.id}`,
                        disabled: this.state.deleting,
                        onClick: (e) => { if (e && e.stopPropagation) e.stopPropagation(); this.removeProject(row); },
                        style: btnStyle("primary", this.state.deleting),
                      }, "确认删除"),
                      h("button", {
                        type: "button",
                        onClick: (e) => { if (e && e.stopPropagation) e.stopPropagation(); this.setState({ deleteConfirmId: null }); },
                        style: btnStyle("quiet"),
                      }, "取消"),
                    )
                  : h("button", {
                      type: "button",
                      "aria-label": `删除项目 ${row.name || row.id}`,
                      onClick: (e) => { if (e && e.stopPropagation) e.stopPropagation(); this.removeProject(row); },
                      style: btnStyle("quiet"),
                    }, "删除"),
              ),
            );
          })),
        );
      }
    }

    return h(ProjectsBody, { React, h, api, router, ui, theme });
  },
};

const WRAP = { display: "flex", flexDirection: "column", gap: 12, width: "100%" };
const TD = { padding: "8px 10px", verticalAlign: "top", color: "var(--sorne-text-primary)" };
