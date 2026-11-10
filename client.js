/**
 * Sorne —— 客户端半端（浏览器，dsh web 平台）。M1 重写版（hash 路由双布局外壳）。
 *
 * 本批一次性升级后重新冻结（BLUEPRINT-UI §3.3）。蓝图 §1.1/§1.4/§2.4/§2.4-2/§2.5：
 *
 *   两种布局（外壳的两种形态）：
 *     - 引导层（#/onboarding、#/projects、未知 hash 重定向落点）：
 *       无顶栏/左导航工作区，仅标题 + 引导页导航（首次使用 / 项目列表）；
 *     - 工作区（#/p/:projectId/*）：顶栏（项目名｜运行状态｜暂停·继续｜项目设置｜
 *       切换项目｜主题）+ 左导航（工作台/资产/探索/发现/报告 + 底部独立入口
 *       系统诊断）+ 中间主区 + 右侧详情槽位。
 *
 *   hash 路由为唯一页面状态入口（#/page/project/id）：刷新、回退、分享、
 *   直链全部成立；未知 hash → #/projects；未知项目经详情 404 重定向 #/projects
 *   并提示。#/records/:id 为外壳级记录覆盖层（任何页可跳，关闭回到来源）。
 *
 *   页面槽位（§2.5 注册表，冻结 id 白名单）：页面文件由各模块（M3–M6）填入
 *   lib/ui/pages/*.page.mjs；外壳按白名单渲染导航，页面未落地时槽位显示
 *   「页面模块未就绪」占位卡（如实标注归属模块），导航集合不随后续模块
 *   施工进度变化（§2.5 断言规则）。旧 id 页面（overview/execution/…）在过渡期
 *   即使仍在 manifest 也不出现在任何导航面。
 *
 *   页面模块契约（§2.5，冻结）：export default { id, title, order, render(ctx),
 *   renderDetail? }；ctx = { React, h, api, router, ui, theme }。
 *   - 页面不 import 任何包或 Node 内置模块；React 由外壳注入（无构建、内联样式）；
 *   - 页面 render(ctx) 在外壳渲染期同步调用，**每个页面槽位（布局+项目）只调用
 *     一次**，返回的元素树被外壳 keep-alive 保活（切走隐藏、切回原样恢复：
 *     筛选/展开/阅读位不丢，要求 §2）。动态路由值（router.page/projectId/params）
 *     须在页面自身组件的 render 内经 ctx.router 读取（router 为稳定可变句柄，
 *     导航后原位更新；需要导航响应时在类组件 componentDidMount 里
 *     router.onChange(fn) 订阅、componentWillUnmount 退订），不得在外层
 *     render(ctx) 闭包里读快照值；
 *   - 右侧详情：hash 带 ?id= 且页面定义 renderDetail(ctx) 时，外壳把其渲染进
 *     右栏（宽度、关闭按钮、Esc 由外壳统一提供，§2.4-2）；render(ctx) 只渲染
 *     中间栏内容；
 *   - 主题：全部颜色经 lib/ui/theme.mjs token（var(--sorne-*)）；禁止引用宿主
 *     --dsw-alias-* 变量与书写字面颜色值（评审 §1 根因，P0-1② 闸）；
 *   - 通信只走同源 /sorne/*（宿主 webServer 前缀路由，loopback-only）。
 *
 * 设计系统模块（lib/ui/theme|record-ids|render|router.mjs）经同源
 * /sorne/ui/lib/<name>.mjs 动态 import 加载（test-ui-server.mjs 提供该路径；
 * 独立宿主未提供该路径时外壳降级为无样式可读态并如实提示——见
 * docs/modules/ui-M1.md 偏差记录）。
 */
window.__ModuleLoader__.load({
  id: "sorne",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const { useState, useEffect, Component } = React;
    const h = React.createElement;

    /* 同源 API：统一错误文本。本工程错误信封是 {code, message, retryable}
       （lib/errors.mjs，§20.1 机器可区分错误）——message 优先呈现；兼容旧
       {error: string|{message}} 信封；两者皆缺时退回 HTTP 状态码。 */
    async function api(path, options) {
      const res = await fetch(path, {
        credentials: "same-origin",
        ...options,
        headers: { "Content-Type": "application/json", ...(options && options.headers) },
      });
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        if (data && typeof data === "object") {
          if (typeof data.message === "string" && data.message.trim()) {
            msg = data.message;
          } else if (typeof data.error === "string" && data.error) {
            msg = data.error;
          } else if (data.error && typeof data.error === "object") {
            msg = data.error.message || JSON.stringify(data.error);
          }
        }
        const err = new Error(msg);
        err.status = res.status;
        err.code = data && data.code;
        throw err;
      }
      return data;
    }

    /* React 错误边界：单页异常不白屏整个工作台（A3 语义原样保留）。 */
    class SectionErrorBoundary extends Component {
      constructor(props) { super(props); this.state = { error: null }; }
      static getDerivedStateFromError(error) { return { error }; }
      render() {
        if (!this.state.error) return this.props.children;
        const err = this.state.error;
        return h("div", {
          role: "alert",
          style: {
            padding: "12px 14px", margin: "8px 0", borderRadius: 8,
            border: "1px solid var(--sorne-status-unknown-fg)",
            background: "var(--sorne-bg-surface)",
            color: "var(--sorne-status-unknown-fg)",
            fontSize: 14, lineHeight: 1.6, wordBreak: "break-all",
          },
        }, `Sorne 页面渲染出错：${err && err.message ? err.message : String(err)}`);
      }
    }

    /* ── 页面槽位白名单（冻结；与 lib/ui/router.mjs 导出一致，
          ui-shell 测试断言两者一致） ─────────────────────────────────── */
    const WORKSPACE_PAGES = ["workbench", "assets", "exploration", "findings", "reports"];
    const GUIDE_PAGES = ["onboarding", "projects"];
    const DIAGNOSTICS_PAGE = "diagnostics";
    const RECORDS_PAGE = "records";
    const PAGE_LABELS = {
      onboarding: "首次使用",
      projects: "项目列表",
      workbench: "工作台",
      assets: "资产",
      exploration: "探索",
      findings: "发现",
      reports: "报告",
      diagnostics: "系统诊断",
    };
    const SLOT_OWNERS = {
      onboarding: "M3（引导与项目列表）",
      projects: "M3（引导与项目列表）",
      workbench: "M4（工作台与系统诊断）",
      diagnostics: "M4（工作台与系统诊断）",
      assets: "M5（资产与探索）",
      exploration: "M5（资产与探索）",
      findings: "M6（发现与报告）",
      reports: "M6（发现与报告）",
    };

    const DEFAULT_HASH = "#/projects";

    /* ── 纯函数：顶栏运行状态解析（要求 §7 五态 + 过渡/未知态；
          测试与 M4 经 __test__ 复用；数据缺失时如实降级，不冒充状态） ──── */
    function resolveRunStatus(input) {
      const i = input || {};
      const reasons = [];
      if (i.pausing) {
        const n = i.attemptsKnown ? i.attemptsActive : null;
        return {
          state: "pausing",
          label: "正在暂停",
          detail: n !== null && n > 0
            ? `已提交暂停请求；仍有 ${n} 个执行中的尝试在收尾，收尾完成前不假装全部停止`
            : "已提交暂停请求，等待项目状态确认",
          reasons,
        };
      }
      if (i.projectError) {
        return { state: "unknown", label: "状态未知", detail: `项目状态未知：${i.projectError}`, reasons };
      }
      const status = i.projectStatus;
      if (!status) {
        return { state: "unknown", label: "状态未知", detail: "项目状态未提供（项目详情不可得）", reasons };
      }
      if (status === "stopped") {
        return {
          state: "stopped", label: "已停止",
          detail: "停止后禁止新的派发并撤销执行权；已产生的证据与记录仍保留（规范 §16.4）",
          reasons,
        };
      }
      if (status === "paused") {
        return {
          state: "paused", label: "已暂停",
          detail: "项目已暂停；恢复后重新检查范围、前提与预算（规范 §16.4）",
          reasons,
        };
      }
      if (i.healthState === "error") {
        return { state: "abnormal", label: "系统异常", detail: `健康检查失败：${i.healthError || "原因未提供"}`, reasons };
      }
      const diag = i.diagnostics && i.diagnostics.available ? i.diagnostics.data : null;
      if (diag && diag.health && diag.health.ok === false) {
        return { state: "abnormal", label: "系统异常", detail: "诊断聚合显示健康状态异常", reasons };
      }

      const blockedIntents = [];
      if (i.intentsKnown && typeof i.intentsBlocked === "number" && i.intentsBlocked > 0) {
        blockedIntents.push(`${i.intentsBlocked} 个方向受阻，等待条件补齐`);
      }
      if (diag && diag.project && diag.project.intents && Array.isArray(diag.project.intents.blocked_ids)) {
        if (diag.project.intents.blocked_ids.length > 0) {
          blockedIntents.push(`${diag.project.intents.blocked_ids.length} 个方向受阻（诊断聚合）`);
        }
      }
      const planPending = diag && diag.project && diag.project.plan
        ? (diag.project.plan.plan_runs_pending || 0) + (diag.project.plan.plan_runs_in_flight || 0)
        : 0;

      if (status === "waiting_for_change") {
        if (!reasons.length) reasons.push("没有待执行任务；有新计划或新消息时自动继续");
        if (blockedIntents.length) reasons.push(...blockedIntents);
        if (planPending > 0) reasons.push(`规划调用在途/待处理：${planPending}`);
        if (!i.diagnostics || !i.diagnostics.available) {
          reasons.push("诊断端点不可用（未注册或失败），「在等什么」的明细暂不可得");
        }
        return {
          state: "waiting", label: "等待条件补齐",
          detail: "",
          reasons,
        };
      }
      // status === "active"
      if (i.attemptsKnown && i.attemptsActive > 0) {
        reasons.push(`${i.attemptsActive} 个执行中的尝试（leased/running）`);
        if (planPending > 0) reasons.push(`规划调用在途/待处理：${planPending}`);
        return { state: "exploring", label: "正在探索", detail: `${i.attemptsActive} 个执行中的尝试`, reasons };
      }
      if (planPending > 0) {
        reasons.push(`规划调用在途/待处理：${planPending}`);
        return { state: "exploring", label: "正在探索", detail: "规划进行中（当前无执行中的尝试）", reasons };
      }
      if (i.attemptsKnown && i.attemptsActive === 0) {
        if (!reasons.length) reasons.push("当前没有执行中的尝试；有新计划或新消息时自动继续");
        if (blockedIntents.length) reasons.push(...blockedIntents);
        if (!i.diagnostics || !i.diagnostics.available) {
          reasons.push("诊断端点不可用（未注册或失败），「在等什么」的明细暂不可得");
        }
        return {
          state: "waiting", label: "等待条件补齐",
          detail: "",
          reasons,
        };
      }
      reasons.push("执行尝试数据不可用，无法判定是否在探索");
      return { state: "unknown", label: "状态未知", detail: "执行尝试数据不可用，无法判定是否在探索", reasons };
    }

    /* ── 纯函数：模型连接门控（要求 §1：绝不以「服务正常」暗示 AI 可工作；
          端点未注册（M2 竣工前 404）时如实呈现「状态未知」而非猜测） ───── */
    function resolveLlmGate(input) {
      const i = input || {};
      if (i.status === "ok" && i.data) {
        if (i.data.configured === false) {
          return {
            state: "unconfigured",
            text: "尚未连接模型，项目可以保存，AI 暂不能开始",
            actionLabel: "连接模型",
            actionHash: "#/onboarding",
          };
        }
        return null;
      }
      if (i.status === "error" && !i.unregistered) {
        return {
          state: "unknown",
          text: `模型配置状态未知（读取失败：${i.error || "原因未提供"}）；AI 能否开始以系统诊断为准`,
          actionLabel: "打开首次使用向导",
          actionHash: "#/onboarding",
        };
      }
      return {
        state: "unknown",
        text: "模型配置状态未知（设置端点未注册，后端模块施工中）；项目可以保存，AI 能否开始以系统诊断为准",
        actionLabel: "打开首次使用向导",
        actionHash: "#/onboarding",
      };
    }

    /* ── 设计系统模块加载（同源 /sorne/ui/lib/<name>.mjs；多候选 URL 兼容
          不同宿主的静态服务形态；全部失败 → 降级态，不猜测、不虚报） ───── */
    function defaultLoadLibModule(name) {
      const candidates = [
        `/sorne/ui/lib/${name}.mjs`,
        `lib/ui/${name}.mjs`,
      ];
      let lastError = null;
      const tryNext = (idx) => {
        if (idx >= candidates.length) {
          return Promise.reject(lastError || new Error(`设计系统模块不可达：${name}`));
        }
        return import(candidates[idx]).catch((e) => { lastError = e; return tryNext(idx + 1); });
      };
      return tryNext(0);
    }

    /* ── 通用按钮样式 ─────────────────────────────────────────────── */
    const BTN = {
      base: {
        fontSize: 13, padding: "5px 12px", borderRadius: 6, cursor: "pointer",
        border: "1px solid var(--sorne-border-strong)",
        background: "var(--sorne-bg-surface)", color: "var(--sorne-text-primary)",
        fontFamily: "inherit", lineHeight: 1.55,
      },
      primary: {
        background: "var(--sorne-brand)", color: "var(--sorne-on-brand)",
        borderColor: "var(--sorne-brand)",
      },
      quiet: {
        border: "1px solid transparent", background: "transparent",
        color: "var(--sorne-text-secondary)",
      },
      disabled: { opacity: 0.55, cursor: "default" },
    };
    function btnStyle(variant, disabled) {
      const base = { ...BTN.base };
      if (variant === "primary") Object.assign(base, BTN.primary);
      if (variant === "quiet") Object.assign(base, BTN.quiet);
      if (disabled) Object.assign(base, BTN.disabled);
      return base;
    }

    const CARD = {
      background: "var(--sorne-bg-surface)",
      border: "1px solid var(--sorne-border)",
      borderRadius: 8,
      padding: "12px 14px",
    };

    /* ════════════════════════════════════════════════════════════════
       外壳运行时（可注入依赖：真实入口用 fetch/import；测试注入假实现）
       ════════════════════════════════════════════════════════════════ */
    function createShellRuntime(deps) {
      const {
        React: R, h: hh, api: apiFn,
        loadLibModule = defaultLoadLibModule,
        fetchManifest, importPageModule,
        win, themeStorage, initialThemeMode, doc,
      } = deps;
      const H = hh || h;
      const Comp = R.Component;

      /* ── 顶栏（项目名｜运行状态｜暂停·继续｜项目设置｜切换项目｜主题） ── */
      class Topbar extends Comp {
        constructor(props) {
          super(props);
          this.state = {
            detail: { phase: "loading", data: null, error: null },
            attempts: { known: false, active: 0, error: null },
            intents: { known: false, blocked: 0, error: null },
            diagnostics: { available: false, data: null, error: null },
            health: { state: "loading", error: null },
            llm: { status: "loading", data: null, error: null },
            lifecycle: { phase: "idle", error: "", notice: "" },
            switcher: { open: false, phase: "idle", items: [], error: null },
          };
        }
        componentDidMount() { this.loadAll(this.props.projectId); }
        componentDidUpdate(prev) {
          if (prev.projectId !== this.props.projectId) {
            this.setState({
              detail: { phase: "loading", data: null, error: null },
              attempts: { known: false, active: 0, error: null },
              intents: { known: false, blocked: 0, error: null },
              diagnostics: { available: false, data: null, error: null },
              health: { state: "loading", error: null },
              lifecycle: { phase: "idle", error: "", notice: "" },
              switcher: { open: false, phase: "idle", items: [], error: null },
            });
            this.loadAll(this.props.projectId);
          }
        }
        loadAll(pid) {
          if (!pid) return;
          const fresh = () => this.props.projectId === pid;
          this.props.api(`/sorne/projects/${encodeURIComponent(pid)}`).then(
            (data) => {
              if (!fresh()) return;
              const project = data && data.project ? data.project : data;
              if (!project || !project.id) {
                this.setState({ detail: { phase: "error", data: null, error: new Error("项目详情形状无法识别") } });
                return;
              }
              this.setState({ detail: { phase: "ok", data: project, error: null } });
            },
            (e) => {
              if (!fresh()) return;
              this.setState({ detail: { phase: "error", data: null, error: e } });
              if (e && e.status === 404 && typeof this.props.onProjectMissing === "function") {
                this.props.onProjectMissing(pid, e);
              }
            },
          );
          this.props.api(`/sorne/attempts?project_id=${encodeURIComponent(pid)}`).then(
            (data) => {
              if (!fresh()) return;
              const list = data && Array.isArray(data.attempts) ? data.attempts : [];
              const activeCount = list.filter((a) => a && (a.status === "leased" || a.status === "running")).length;
              this.setState({ attempts: { known: true, active: activeCount, error: null } });
            },
            (e) => { if (fresh()) this.setState({ attempts: { known: false, active: 0, error: e } }); },
          );
          this.props.api(`/sorne/intents?project_id=${encodeURIComponent(pid)}&status=blocked`).then(
            (data) => {
              if (!fresh()) return;
              const list = data && Array.isArray(data.intents) ? data.intents : [];
              this.setState({ intents: { known: true, blocked: list.length, error: null } });
            },
            (e) => { if (fresh()) this.setState({ intents: { known: false, blocked: 0, error: e } }); },
          );
          this.props.api(`/sorne/diagnostics?project_id=${encodeURIComponent(pid)}`).then(
            (data) => { if (fresh()) this.setState({ diagnostics: { available: true, data, error: null } }); },
            (e) => { if (fresh()) this.setState({ diagnostics: { available: false, data: null, error: e } }); },
          );
          this.props.api("/sorne/health").then(
            (data) => { if (fresh()) this.setState({ health: { state: data && data.ok ? "ok" : "error", error: null } }); },
            (e) => { if (fresh()) this.setState({ health: { state: "error", error: e } }); },
          );
          this.props.api("/sorne/llm/settings").then(
            (data) => { if (fresh()) this.setState({ llm: { status: "ok", data, error: null } }); },
            (e) => { if (fresh()) this.setState({ llm: { status: "unavailable", data: null, error: e } }); },
          );
        }
        refreshAfterLifecycle() {
          this.loadAll(this.props.projectId);
        }
        doLifecycle(action, confirmNote) {
          const pid = this.props.projectId;
          const busy = action === "pause" ? "pausing" : "resuming";
          this.setState({ lifecycle: { phase: busy, error: "", notice: confirmNote || "" } });
          this.props.api(`/sorne/projects/${encodeURIComponent(pid)}/lifecycle`, {
            method: "POST",
            body: JSON.stringify({ action }),
          }).then(
            () => {
              if (this.props.projectId !== pid) return;
              this.setState({
                lifecycle: {
                  phase: "idle", error: "",
                  notice: action === "pause"
                    ? "已提交暂停；项目状态以重新读取的结果为准"
                    : "已提交恢复；项目状态以重新读取的结果为准",
                },
              });
              this.refreshAfterLifecycle();
            },
            (e) => {
              if (this.props.projectId !== pid) return;
              this.setState({ lifecycle: { phase: "idle", error: e, notice: "" } });
            },
          );
        }
        openSwitcher() {
          this.setState({ switcher: { open: true, phase: "loading", items: this.state.switcher.items, error: null } });
          this.props.api("/sorne/projects").then(
            (data) => {
              const items = data && Array.isArray(data.projects) ? data.projects : [];
              this.setState({ switcher: { open: true, phase: "ok", items, error: null } });
            },
            (e) => this.setState({ switcher: { open: true, phase: "error", items: [], error: e } }),
          );
        }
        render() {
          const ui = this.props.ui;
          const theme = this.props.theme;
          const router = this.props.router;
          const detail = this.state.detail;
          const projectName = detail.phase === "ok" && detail.data ? detail.data.name : null;

          const status = resolveRunStatus({
            pausing: this.state.lifecycle.phase === "pausing",
            projectStatus: detail.phase === "ok" && detail.data ? detail.data.status : null,
            projectError: detail.phase === "error" && detail.error ? detail.error.message : null,
            attemptsKnown: this.state.attempts.known,
            attemptsActive: this.state.attempts.active,
            intentsKnown: this.state.intents.known,
            intentsBlocked: this.state.intents.blocked,
            healthState: this.state.health.state === "error" ? "error" : "ok",
            healthError: this.state.health.error ? this.state.health.error.message : null,
            diagnostics: this.state.diagnostics.available
              ? { available: true, data: this.state.diagnostics.data }
              : { available: false, data: null },
          });

          const gate = this.state.llm.status === "loading" ? null : resolveLlmGate({
            status: this.state.llm.status === "ok" ? "ok" : "error",
            unregistered: this.state.llm.status === "unavailable"
              && this.state.llm.error && this.state.llm.error.status === 404,
            data: this.state.llm.data,
            error: this.state.llm.error ? this.state.llm.error.message : null,
          });

          const paused = status.state === "paused";
          const stopped = status.state === "stopped";
          const canPause = !paused && !stopped && this.state.lifecycle.phase === "idle"
            && detail.phase === "ok";
          const canResume = paused && this.state.lifecycle.phase === "idle" && detail.phase === "ok";

          return H("header", {
            role: "banner",
            style: {
              display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
              padding: "8px 16px",
              background: "var(--sorne-bg-surface)",
              borderBottom: "1px solid var(--sorne-border)",
            },
          },
            H("div", { style: { display: "flex", alignItems: "baseline", gap: 8, minWidth: 0 } },
              H("span", {
                style: { fontWeight: 700, fontSize: 15, color: "var(--sorne-text-primary)" },
                title: detail.phase === "ok" && detail.data ? `项目 ${detail.data.id}` : undefined,
              }, projectName || (detail.phase === "loading" ? "（项目读取中…）" : "（项目名称未提供）")),
              detail.phase === "ok" && detail.data
                ? H("span", { style: { fontSize: 13, color: "var(--sorne-text-muted)" } }, detail.data.id)
                : null,
            ),
            H(RunStatusBadge, { status, ui }),
            status.state === "waiting" && status.reasons && status.reasons.length
              ? H("span", {
                  style: {
                    fontSize: 13, color: "var(--sorne-text-muted)",
                    maxWidth: 420, lineHeight: 1.5,
                  },
                }, "为什么等：" + Array.from(new Set(status.reasons)).join("；"))
              : null,
            gate ? H("button", {
              type: "button",
              "aria-label": `${gate.text}；${gate.actionLabel}`,
              title: gate.text,
              onClick: () => router.open(gate.actionHash),
              style: {
                ...btnStyle(), background: "var(--sorne-status-suspected-bg)",
                color: "var(--sorne-status-suspected-fg)",
                borderColor: "var(--sorne-status-suspected-fg)",
                fontSize: 13, maxWidth: 420, textAlign: "left",
              },
            }, `${gate.text} → ${gate.actionLabel}`) : null,
            H("div", { style: { flex: "1 1 auto" } }),
            H("button", {
              type: "button", "aria-label": "暂停项目",
              disabled: !canPause, onClick: () => this.doLifecycle("pause"),
              style: btnStyle("primary", !canPause),
            }, "暂停"),
            H("button", {
              type: "button", "aria-label": "继续项目",
              disabled: !canResume, onClick: () => this.doLifecycle("resume"),
              style: btnStyle("primary", !canResume),
            }, "继续"),
            H("button", {
              type: "button", "aria-label": "项目设置",
              onClick: () => this.props.onOpenSettings && this.props.onOpenSettings(),
              style: btnStyle(),
            }, "项目设置"),
            H("button", {
              type: "button", "aria-label": "切换项目",
              "aria-expanded": this.state.switcher.open ? "true" : "false",
              onClick: () => (this.state.switcher.open
                ? this.setState({ switcher: { ...this.state.switcher, open: false } })
                : this.openSwitcher()),
              style: btnStyle(),
            }, "切换项目"),
            H(ThemeSwitch, { theme }),
            this.state.lifecycle.phase === "pausing" || this.state.lifecycle.phase === "resuming"
              ? H("span", { role: "status", style: { fontSize: 13, color: "var(--sorne-text-secondary)" } },
                  this.state.lifecycle.notice || "正在提交生命周期操作…")
              : null,
            this.state.lifecycle.error
              ? H("span", { role: "alert", style: { fontSize: 13, color: "var(--sorne-status-unknown-fg)" } },
                  `生命周期操作失败：${this.state.lifecycle.error.message}`)
              : null,
            this.state.switcher.open
              ? H(ProjectSwitcher, {
                  state: this.state.switcher,
                  router: this.props.router,
                  currentPid: this.props.projectId,
                  ui,
                  onClose: () => this.setState({ switcher: { ...this.state.switcher, open: false } }),
                })
              : null,
          );
        }
      }

      function RunStatusBadge({ status, ui }) {
        const toneMap = {
          exploring: "ok", waiting: "suspected", pausing: "suspected", paused: "falsified",
          abnormal: "unknown", stopped: "falsified", unknown: "unknown",
        };
        const tone = toneMap[status.state] || "unknown";
        const bgVar = `--sorne-status-${tone}-bg`;
        const fgVar = `--sorne-status-${tone}-fg`;
        return H("span", {
          role: "status",
          "aria-label": `运行状态：${status.label}`,
          title: status.detail + (status.reasons && status.reasons.length
            ? `\n` + status.reasons.map((r) => `· ${r}`).join("\n")
            : ""),
          style: {
            display: "inline-flex", alignItems: "center", gap: 6,
            padding: "2px 10px", borderRadius: 999, fontSize: 13,
            background: `var(${bgVar})`, color: `var(${fgVar})`,
            border: `1px solid var(${fgVar})`,
            maxWidth: 560,
          },
        },
          H("span", { "aria-hidden": "true", style: {
            width: 8, height: 8, borderRadius: "50%",
            background: `var(${fgVar})`, display: "inline-block", flex: "0 0 auto",
          } }),
          H("span", { style: { fontWeight: 600 } }, status.label),
          status.detail
            ? H("span", { style: { fontWeight: 400, opacity: 0.92 } }, `（${status.detail}）`)
            : null,
        );
      }

      function ProjectSwitcher({ state, router, currentPid, ui, onClose }) {
        return H("div", {
          role: "menu", "aria-label": "切换项目",
          style: {
            position: "absolute", top: 52, right: 16, zIndex: 60, minWidth: 320,
            ...CARD,
            border: "1px solid var(--sorne-border-strong)",
            padding: 0,
          },
        },
          H("div", { style: { padding: "8px 12px", borderBottom: "1px solid var(--sorne-border)", display: "flex", justifyContent: "space-between", alignItems: "center" } },
            H("span", { style: { fontSize: 13, color: "var(--sorne-text-secondary)" } }, "选择要进入的项目"),
            H("button", { type: "button", "aria-label": "关闭项目切换", onClick: onClose, style: btnStyle("quiet") }, "×"),
          ),
          state.phase === "loading" ? H("div", { style: { padding: 12, fontSize: 14 } }, "项目列表读取中…") : null,
          state.phase === "error"
            ? H("div", { role: "alert", style: { padding: 12, fontSize: 14, color: "var(--sorne-status-unknown-fg)" } },
                `项目列表读取失败：${state.error && state.error.message ? state.error.message : String(state.error)}`)
            : null,
          state.phase === "ok"
            ? H("div", { style: { maxHeight: 320, overflow: "auto" } },
                state.items.length === 0
                  ? H("div", { style: { padding: 12, fontSize: 14, color: "var(--sorne-text-secondary)" } }, "（暂无项目）")
                  : state.items.map((p) => H("button", {
                      key: p.id,
                      type: "button",
                      role: "menuitem",
                      "aria-label": `打开项目 ${p.name || p.id}`,
                      onClick: () => { onClose(); router.open(`#/p/${encodeURIComponent(p.id)}/workbench`); },
                      style: {
                        display: "block", width: "100%", textAlign: "left", cursor: "pointer",
                        padding: "8px 12px", fontSize: 14, background: "transparent",
                        border: "none", borderBottom: "1px solid var(--sorne-border)",
                        color: "var(--sorne-text-primary)", fontFamily: "inherit",
                        fontWeight: p.id === currentPid ? 700 : 400,
                      },
                    },
                      `${p.name || "（名称未提供）"}（${p.id}）`,
                      p.id === currentPid ? H("span", { style: { color: "var(--sorne-text-muted)", fontSize: 13 } }, " · 当前") : null,
                    )),
              )
            : null,
        );
      }

      function ThemeSwitch({ theme }) {
        const modes = [["light", "浅色"], ["dark", "深色"], ["system", "跟随系统"]];
        const current = theme ? theme.mode() : "system";
        return H("div", { role: "group", "aria-label": "主题切换", style: { display: "inline-flex", gap: 4 } },
          modes.map(([m, label]) => H("button", {
            key: m,
            type: "button",
            "aria-label": `主题：${label}`,
            "aria-pressed": current === m ? "true" : "false",
            onClick: () => theme && theme.set(m),
            style: {
              ...btnStyle(current === m ? "primary" : "quiet"),
              fontSize: 13, padding: "3px 8px",
            },
          }, label)),
        );
      }

      /* ── 项目设置抽屉（M1 提供容器与只读信息；范围编辑器由 M3 提供） ── */
      class SettingsDrawer extends Comp {
        constructor(props) {
          super(props);
          this.state = {
            detail: { phase: "loading", data: null, error: null },
            scope: { phase: "loading", data: null, error: null },
            lifecycle: { busy: false, error: "", notice: "" },
          };
        }
        componentDidMount() { this.load(); }
        load() {
          const pid = this.props.projectId;
          this.props.api(`/sorne/projects/${encodeURIComponent(pid)}`).then(
            (data) => this.setState({ detail: { phase: "ok", data: data && data.project ? data.project : data, error: null } }),
            (e) => this.setState({ detail: { phase: "error", data: null, error: e } }),
          );
          this.props.api(`/sorne/projects/${encodeURIComponent(pid)}/scope`).then(
            (data) => this.setState({ scope: { phase: "ok", data, error: null } }),
            (e) => this.setState({ scope: { phase: "error", data: null, error: e } }),
          );
        }
        stop() {
          const pid = this.props.projectId;
          this.setState({ lifecycle: { busy: true, error: "", notice: "" } });
          this.props.api(`/sorne/projects/${encodeURIComponent(pid)}/lifecycle`, {
            method: "POST", body: JSON.stringify({ action: "stop" }),
          }).then(
            () => this.setState({ lifecycle: { busy: false, error: "", notice: "已提交停止；停止后禁止新的派发并撤销执行权，已产生证据仍保留（规范 §16.4）" } }),
            (e) => this.setState({ lifecycle: { busy: false, error: e, notice: "" } }),
          );
        }
        render() {
          const ui = this.props.ui;
          const detail = this.state.detail;
          const scope = this.state.scope;
          return H("div", { style: { position: "fixed", inset: 0, zIndex: 70, display: "flex", justifyContent: "flex-end" } },
            H("div", {
              onClick: this.props.onClose,
              "aria-hidden": "true",
              style: { position: "absolute", inset: 0, background: "transparent", cursor: "default" },
            }),
            H("section", {
              role: "dialog", "aria-modal": "true", "aria-label": "项目设置",
              style: {
                position: "relative", width: 480, maxWidth: "92vw", height: "100%",
                overflow: "auto", padding: 16,
                background: "var(--sorne-bg-raised)",
                borderLeft: "1px solid var(--sorne-border-strong)",
                color: "var(--sorne-text-primary)", fontSize: 14, lineHeight: 1.6,
              },
            },
              H("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 } },
                H("h2", { style: { margin: 0, fontSize: 16 } }, "项目设置"),
                H("button", { type: "button", "aria-label": "关闭项目设置", onClick: this.props.onClose, style: btnStyle() }, "关闭"),
              ),
              detail.phase === "loading" ? H("p", null, "项目信息读取中…") : null,
              detail.phase === "error"
                ? H("p", { role: "alert", style: { color: "var(--sorne-status-unknown-fg)" } },
                    `项目信息读取失败：${detail.error && detail.error.message ? detail.error.message : String(detail.error)}`)
                : null,
              detail.phase === "ok" && detail.data
                ? H("div", { style: CARD },
                    H("h3", { style: { margin: "0 0 6px", fontSize: 14 } }, "基本信息"),
                    ["name", "id", "status", "description", "current_scope_revision", "state_version", "created_at", "created_by"]
                      .map((k) => H("div", { key: k }, ui.FieldRow(k, detail.data[k]))),
                  )
                : null,
              scope.phase === "loading" ? H("p", null, "范围读取中…") : null,
              scope.phase === "error"
                ? H("p", { role: "alert", style: { color: "var(--sorne-status-unknown-fg)" } },
                    `范围读取失败：${scope.error && scope.error.message ? scope.error.message : String(scope.error)}`)
                : null,
              scope.phase === "ok" && scope.data
                ? H("div", { style: { ...CARD, marginTop: 10 } },
                    H("h3", { style: { margin: "0 0 6px", fontSize: 14 } }, "当前范围（只读呈现）"),
                    scope.data && scope.data.configured === false
                      ? H("p", { style: { color: "var(--sorne-text-secondary)" } },
                          scope.data.note || "尚未配置任何范围版本。")
                      : null,
                    scope.data && scope.data.current
                      ? ["revision", "summary"].map((k) => H("div", { key: k }, ui.FieldRow(k, scope.data.current[k])))
                      : null,
                    scope.data && scope.data.current && scope.data.current.rules
                      ? ["allow", "deny", "pending"].map((k) => H("div", { key: k, style: { marginTop: 6 } },
                          H("div", { style: { fontSize: 13, color: "var(--sorne-text-secondary)", fontWeight: 600 } },
                            (ui.VOCAB.scope_kind[k] ? ui.VOCAB.scope_kind[k].label : k)),
                          Array.isArray(scope.data.current.rules[k]) && scope.data.current.rules[k].length
                            ? H("ul", { style: { margin: "4px 0 0", paddingLeft: 20 } },
                                scope.data.current.rules[k].map((r, i) => H("li", { key: i, style: { fontSize: 13.5, wordBreak: "break-all" } }, String(r))))
                            : H("div", { style: { fontSize: 13.5, color: "var(--sorne-text-muted)" } }, "（未提供）"),
                        ))
                      : null,
                    H("p", { style: { marginTop: 8, fontSize: 13, color: "var(--sorne-text-muted)" } },
                      "范围规则的编辑（允许/排除/待判断三区与通配符）由「首次使用与项目列表」模块（M3）提供的范围编辑器承载，当前为只读呈现；资源与预算的处理入口见系统诊断页。"),
                  )
                : null,
              detail.phase === "ok" && detail.data
                ? H("div", { style: { ...CARD, marginTop: 10 } },
                    H("h3", { style: { margin: "0 0 6px", fontSize: 14 } }, "生命周期"),
                    H("p", { style: { fontSize: 13, color: "var(--sorne-text-secondary)", margin: "0 0 8px" } },
                      "暂停/继续在顶栏；停止后禁止新的派发并撤销执行权，已产生证据仍保留（规范 §16.4）。"),
                    H("button", {
                      type: "button", "aria-label": "停止项目",
                      disabled: this.state.lifecycle.busy || detail.data.status === "stopped",
                      onClick: () => this.stop(),
                      style: btnStyle(detail.data.status === "stopped" ? "" : "primary", this.state.lifecycle.busy || detail.data.status === "stopped"),
                    }, detail.data.status === "stopped" ? "已停止" : "停止项目"),
                    this.state.lifecycle.notice
                      ? H("p", { role: "status", style: { marginTop: 8, fontSize: 13 } }, this.state.lifecycle.notice)
                      : null,
                    this.state.lifecycle.error
                      ? H("p", { role: "alert", style: { marginTop: 8, fontSize: 13, color: "var(--sorne-status-unknown-fg)" } },
                          `停止失败：${this.state.lifecycle.error.message}`)
                      : null,
                  )
                : null,
            ),
          );
        }
      }

      /* ── 记录覆盖层（#/records/:id?project=:pid；外壳级，任何页可跳） ── */
      class RecordOverlay extends Comp {
        constructor(props) {
          super(props);
          this.state = { phase: "loading", data: null, error: null };
        }
        componentDidMount() { this.load(); }
        componentDidUpdate(prev) {
          if (prev.recordId !== this.props.recordId || prev.projectId !== this.props.projectId) {
            this.setState({ phase: "loading", data: null, error: null });
            this.load();
          }
        }
        load() {
          const { recordId, projectId, api } = this.props;
          if (!projectId) {
            this.setState({ phase: "error", data: null, error: new Error("缺少 project 参数；请从项目内打开记录编号") });
            return;
          }
          api(`/sorne/records/${encodeURIComponent(recordId)}?project_id=${encodeURIComponent(projectId)}`).then(
            (data) => this.setState({ phase: "ok", data, error: null }),
            (e) => this.setState({ phase: "error", data: null, error: e }),
          );
        }
        render() {
          const ui = this.props.ui;
          const { recordId } = this.props;
          return H("div", { style: { position: "fixed", inset: 0, zIndex: 80, display: "flex", justifyContent: "flex-end" } },
            H("div", {
              onClick: this.props.onClose, "aria-hidden": "true",
              style: { position: "absolute", inset: 0, background: "transparent" },
            }),
            H("section", {
              role: "dialog", "aria-modal": "true", "aria-label": `记录 ${recordId}`,
              style: {
                position: "relative", width: 560, maxWidth: "94vw", height: "100%",
                overflow: "auto", padding: 16,
                background: "var(--sorne-bg-raised)",
                borderLeft: "1px solid var(--sorne-border-strong)",
                color: "var(--sorne-text-primary)", fontSize: 14, lineHeight: 1.6,
              },
            },
              H("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 8 } },
                H("h2", { style: { margin: 0, fontSize: 15, display: "flex", alignItems: "center", gap: 8 } },
                  "记录",
                  H("code", { style: { fontSize: 14, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" } }, recordId),
                  (() => {
                    const parsed = ui.parseRecordId ? ui.parseRecordId(recordId) : null;
                    return parsed && parsed.kindLabel
                      ? H("span", { style: { fontSize: 13, fontWeight: 400, color: "var(--sorne-text-secondary)" } },
                          `（${parsed.kindLabel}${parsed.projectSeq ? " · 项目内编号" : ""}）`)
                      : null;
                  })()),
                H("button", { type: "button", "aria-label": "关闭记录详情", onClick: this.props.onClose, style: btnStyle() }, "关闭"),
              ),
              H("p", { style: { fontSize: 13, color: "var(--sorne-text-muted)", margin: "0 0 10px" } },
                "记录是数据库真值的只读投影；本面板为读取时刻快照，不代表全量（规范 §15.1）。"),
              this.state.phase === "loading" ? H("p", null, "记录读取中…") : null,
              this.state.phase === "error"
                ? H("div", { role: "alert", style: CARD },
                    H("p", { style: { margin: "0 0 6px", color: "var(--sorne-status-unknown-fg)" } },
                      `记录读取失败：${this.state.error && this.state.error.message ? this.state.error.message : String(this.state.error)}`),
                    H("p", { style: { margin: 0, fontSize: 13, color: "var(--sorne-text-secondary)" } },
                      this.state.error && this.state.error.status === 404
                        ? "编号无法定位：可能为该前缀尚未登记（记录编号注册表扩展由后端模块 M2 施工）、或该记录不属于当前项目；事件编号（evt-）不属记录读取，可在系统诊断的变化流中查看。"
                        : "可稍后重试；记录定位以服务端 /records 为准。"),
                  )
                : null,
              this.state.phase === "ok" && this.state.data
                ? (() => {
                    const envelope = this.state.data;
                    const rec = envelope.record && typeof envelope.record === "object" ? envelope.record : null;
                    if (!rec) {
                      return H("p", { role: "alert", style: { color: "var(--sorne-status-unknown-fg)" } },
                        "记录信封缺少 record 字段（形状以服务端 /records 为准）；已按原样呈现，不做猜测。");
                    }
                    const headKeys = ["id", "kind", "project_id", "created_at", "created_by", "created_seq"];
                    return H("div", null,
                      headKeys.map((k) => (rec[k] !== undefined ? H("div", { key: k }, ui.FieldRow(k, rec[k])) : null)),
                      H("div", { style: { ...CARD, marginTop: 10 } },
                        H("h3", { style: { margin: "0 0 6px", fontSize: 14 } }, "记录视图"),
                        Object.keys(rec)
                          .filter((k) => !headKeys.includes(k))
                          .map((k) => H("div", { key: k }, ui.FieldRow(k, rec[k]))),
                      ),
                      envelope.relations && envelope.relations.truncated
                        ? H("p", { style: { fontSize: 13, color: "var(--sorne-text-muted)" } },
                            "关系边已截断，其余经编号逐条展开（折叠不删记录）。")
                        : null,
                      envelope.relations
                        ? H("div", { style: { ...CARD, marginTop: 10 } },
                            H("h3", { style: { margin: "0 0 6px", fontSize: 14 } }, "关系"),
                            ui.FieldRow("relations", envelope.relations),
                          )
                        : null,
                      envelope.evidence_index
                        ? H("div", { style: { ...CARD, marginTop: 10 } },
                            H("h3", { style: { margin: "0 0 6px", fontSize: 14 } }, "证据索引"),
                            ui.FieldRow("evidence_index", envelope.evidence_index),
                          )
                        : null,
                      envelope.expand
                        ? H("div", { style: { ...CARD, marginTop: 10 } },
                            H("h3", { style: { margin: "0 0 6px", fontSize: 14 } }, "展开入口"),
                            ui.FieldRow("expand", envelope.expand),
                          )
                        : null,
                      envelope.note
                        ? H("p", { style: { fontSize: 13, color: "var(--sorne-text-muted)" } }, String(envelope.note))
                        : null,
                    );
                  })()
                : null,
            ),
          );
        }
      }

      /* ── 页面槽位占位（页面文件未落地时如实标注；不是文本摆设的假页） ── */
      function placeholderPageEl(H2, pageId) {
        return H2("div", { style: CARD },
          H2("h2", { style: { margin: "0 0 6px", fontSize: 16 } }, `${PAGE_LABELS[pageId] || pageId}（页面模块未就绪）`),
          H2("p", { style: { margin: "0 0 4px", color: "var(--sorne-text-secondary)" } },
            `页面槽位已登记（id=${pageId}）；页面文件由 ${SLOT_OWNERS[pageId] || "后续模块"} 施工中。`),
          H2("p", { style: { margin: 0, fontSize: 13, color: "var(--sorne-text-muted)" } },
            "导航与路由已可点、可达；该页的取数与操作随对应模块竣工提供。"),
        );
      }

      /* ── 外壳 ─────────────────────────────────────────────────────── */
      class Shell extends Comp {
        constructor(props) {
          super(props);
          this.state = {
            libPhase: "loading",
            libError: null,
            theme: null,
            router: null,
            ui: null,
            pagesPhase: "loading",
            pages: new Map(),
            manifestError: null,
            pageLoadErrors: [],
            notice: null,
            settingsOpen: false,
          };
          this.pageEls = new Map();     // groupKey|pageId → element（keep-alive）
          this.ctxByGroup = new Map();  // groupKey → ctx
          this.detailEls = new Map();   // groupKey|pageId|detailId → element
          this.underlay = null;         // 记录覆盖层打开时的底衬页 {page, projectId}
          this.unsubRouter = null;
          this.onRouterChange = this.onRouterChange.bind(this);
          this.onKeyDown = this.onKeyDown.bind(this);
        }
        componentDidMount() {
          Promise.all([
            loadLibModule("theme"),
            loadLibModule("record-ids"),
            loadLibModule("render"),
            loadLibModule("router"),
          ]).then(
            ([themeMod, recordIdsMod, renderMod, routerMod]) => {
              const theme = themeMod.createThemeHandle({
                win, storage: themeStorage, initialMode: initialThemeMode,
              });
              themeMod.ensureThemeStyle(doc || (typeof document !== "undefined" ? document : null));
              const router = routerMod.createRouter({ win });
              renderMod.bindRenderers({ createElement: H, Component: Comp });
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
              this.unsubRouter = router.onChange(this.onRouterChange);
              this.setState({ libPhase: "ok", theme, router, ui });
              this.trackUnderlay(router);
              this.redirectIfNeeded(router);
              this.loadManifest();
            },
            (e) => this.setState({
              libPhase: "error",
              libError: e && e.message ? e.message : String(e),
            }),
          );
        }
        componentWillUnmount() {
          if (typeof this.unsubRouter === "function") this.unsubRouter();
        }
        onRouterChange() {
          this.trackUnderlay(this.state.router);
          this.redirectIfNeeded(this.state.router);
          this.forceUpdate();
        }
        /* 记录覆盖层的底衬页：打开 #/records 时保持来源页在树中（覆盖层关闭
           回到原位，阅读位置不丢）；覆盖层页本身不改变底衬。 */
        trackUnderlay(router) {
          if (!router) return;
          if (router.page !== RECORDS_PAGE) {
            this.underlay = { page: router.page, projectId: router.projectId };
          }
        }
        redirectIfNeeded(router) {
          if (!router) return;
          if (router.page === null || router.page === "unknown") {
            const wasUnknown = router.page === "unknown";
            // 冻结规则：空 hash 与未知 hash → #/projects（replace，不产生历史条目）。
            router.replace(DEFAULT_HASH);
            if (wasUnknown) {
              this.setNotice({ kind: "info", text: "未识别的地址已回到项目列表（#/projects）" });
            }
          }
        }
        setNotice(notice) { this.setState({ notice }); }
        loadManifest() {
          const fetchM = fetchManifest || (() => apiFn("/sorne/ui/manifest"));
          const importP = importPageModule || ((file) => import(file));
          const wanted = new Set([...GUIDE_PAGES, ...WORKSPACE_PAGES, DIAGNOSTICS_PAGE]);
          fetchM().then(
            async (manifest) => {
              const list = manifest && Array.isArray(manifest.pages) ? manifest.pages : [];
              const pages = new Map();
              const pageLoadErrors = [];
              for (const item of list) {
                if (!wanted.has(item.id)) continue; // 旧 id 页面过渡期不加载、不入导航
                try {
                  const mod = await importP(item.file);
                  const def = mod && mod.default;
                  if (def && def.id && typeof def.render === "function") {
                    pages.set(def.id, def);
                  } else {
                    pageLoadErrors.push(`${item.id}：页面模块形状非法（缺 id 或 render）`);
                  }
                } catch (e) {
                  pageLoadErrors.push(`${item.id}：加载失败（${e && e.message ? e.message : String(e)}）`);
                }
              }
              // 页面定义就位：先清除加载期创建的占位元素缓存（此刻尚无用户
              // 交互状态，一次性重建无损），再置状态触发重渲染，使本次渲染
              // 即以真实页面模块建元素。
              this.pageEls.clear();
              this.detailEls.clear();
              this.ctxByGroup.clear();
              this.setState({ pagesPhase: "ok", pages, pageLoadErrors, manifestError: null });
            },
            (e) => this.setState({
              pagesPhase: "error", pages: new Map(),
              manifestError: e && e.message ? e.message : String(e),
            }),
          );
        }
        onKeyDown(e) {
          if (!this.state.router) return;
          const r = this.state.router;
          if (e && e.key === "Escape") {
            if (r.page === RECORDS_PAGE) {
              r.back(`#/p/${encodeURIComponent(r.projectId || "")}/workbench`);
            } else if (r.params && r.params.id) {
              r.back(`#/p/${encodeURIComponent(r.projectId || "")}/${r.page}`);
            } else if (this.state.settingsOpen) {
              this.setState({ settingsOpen: false });
            }
          }
        }
        buildCtx(groupKey) {
          if (this.ctxByGroup.has(groupKey)) return this.ctxByGroup.get(groupKey);
          const ctx = {
            React: R, h: H, api: apiFn,
            router: this.state.router,
            ui: this.state.ui,
            theme: this.state.theme,
          };
          this.ctxByGroup.set(groupKey, ctx);
          return ctx;
        }
        ensurePageEl(groupKey, pageId, def) {
          const key = `${groupKey}|${pageId}`;
          if (this.pageEls.has(key)) return this.pageEls.get(key);
          const ctx = this.buildCtx(groupKey);
          const el = def && typeof def.render === "function"
            ? def.render(ctx)
            : placeholderPageEl(H, pageId);
          this.pageEls.set(key, el);
          return el;
        }
        ensureDetailEl(groupKey, pageId, def, detailId) {
          const key = `${groupKey}|${pageId}|${detailId}`;
          if (this.detailEls.has(key)) return this.detailEls.get(key);
          const ctx = this.buildCtx(groupKey);
          const el = def && typeof def.renderDetail === "function"
            ? def.renderDetail(ctx)
            : H("div", { style: CARD }, "该页面未提供详情渲染（renderDetail）；右侧详情由页面模块实现。");
          this.detailEls.set(key, el);
          return el;
        }
        pruneCaches(groupKey) {
          for (const key of Array.from(this.pageEls.keys())) {
            if (!key.startsWith(`${groupKey}|`)) this.pageEls.delete(key);
          }
          for (const key of Array.from(this.detailEls.keys())) {
            if (!key.startsWith(`${groupKey}|`)) this.detailEls.delete(key);
          }
          for (const key of Array.from(this.ctxByGroup.keys())) {
            if (key !== groupKey) this.ctxByGroup.delete(key);
          }
        }
        render() {
          const s = this.state;
          if (s.libPhase === "loading") {
            return H("div", { style: { padding: 20, fontSize: 14, lineHeight: 1.6 } }, "正在加载设计系统（主题/渲染器/路由）…");
          }
          if (s.libPhase === "error") {
            return H("div", { role: "alert", style: { ...CARD, margin: 20, fontSize: 14, lineHeight: 1.7 } },
              H("h2", { style: { margin: "0 0 8px", fontSize: 16 } }, "设计系统模块不可加载"),
              H("p", { style: { margin: "0 0 6px" } },
                `同源 /sorne/ui/lib/*.mjs 不可达（${s.libError}）。外壳以降级模式运行：导航仍可点击，页面内容暂不可用。`),
              H("p", { style: { margin: 0, fontSize: 13 } },
                "该路径由测试宿主（test-ui-server.mjs）提供；独立宿主接入时需提供同源静态服务或将 lib/ui 模块随 client 打包（见 docs/modules/ui-M1.md 偏差记录）。"),
            );
          }

          const router = s.router;
          /* 记录覆盖层打开时，底衬页保持原布局原位（underlay 由 trackUnderlay
             维护）；覆盖层关闭后回到来源页。 */
          const isRecords = router.page === RECORDS_PAGE;
          const layoutPage = isRecords && this.underlay ? this.underlay.page : router.page;
          const layoutPid = isRecords && this.underlay ? this.underlay.projectId : router.projectId;
          const groupKey = GUIDE_PAGES.includes(layoutPage) || layoutPage === "unknown" || layoutPage === null
            ? "guide"
            : `p|${layoutPid || "-"}`;
          this.pruneCaches(groupKey);

          const isWorkspace = !GUIDE_PAGES.includes(layoutPage) && !isRecords
            && layoutPage !== null && layoutPage !== "unknown";
          const activePageId = layoutPage;

          const navPages = isWorkspace ? [...WORKSPACE_PAGES] : [...GUIDE_PAGES];

          const pageHosts = [];
          const keysToRender = new Set(navPages);
          if (activePageId) keysToRender.add(activePageId);
          if (isWorkspace) keysToRender.add(DIAGNOSTICS_PAGE);
          for (const pageId of keysToRender) {
            const el = this.ensurePageEl(groupKey, pageId, s.pages.get(pageId) || null);
            const visible = pageId === activePageId;
            pageHosts.push(H("div", {
              key: pageId,
              "data-page-host": pageId,
              style: visible ? undefined : { display: "none" },
            }, H(SectionErrorBoundary, { key: pageId }, el)));
          }

          const showDetail = isWorkspace && router.params && router.params.id;
          let detailEl = null;
          if (showDetail) {
            detailEl = this.ensureDetailEl(groupKey, activePageId, s.pages.get(activePageId) || null, router.params.id);
          }

          return H("div", {
            onKeyDown: this.onKeyDown,
            style: {
              minHeight: "100vh",
              background: "var(--sorne-bg-canvas)",
              color: "var(--sorne-text-primary)",
              fontSize: 14, lineHeight: 1.6,
              fontFamily: '-apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
            },
          },
            s.notice
              ? H("div", {
                  role: "status",
                  style: {
                    display: "flex", gap: 10, alignItems: "center",
                    margin: "8px 16px 0", padding: "8px 12px", borderRadius: 8,
                    background: "var(--sorne-bg-subtle)",
                    border: "1px solid var(--sorne-border-strong)",
                  },
                },
                  H("span", { style: { flex: 1 } }, s.notice.text),
                  H("button", { type: "button", "aria-label": "关闭提示", onClick: () => this.setState({ notice: null }), style: btnStyle("quiet") }, "×"),
                )
              : null,
            s.pageLoadErrors && s.pageLoadErrors.length
              ? H("div", {
                  role: "alert",
                  style: {
                    margin: "8px 16px 0", padding: "8px 12px", borderRadius: 8,
                    background: "var(--sorne-bg-surface)",
                    border: "1px solid var(--sorne-status-unknown-fg)",
                    color: "var(--sorne-status-unknown-fg)", fontSize: 13,
                  },
                }, `部分页面模块加载失败：${s.pageLoadErrors.join("；")}`)
              : null,
            s.manifestError
              ? H("div", {
                  role: "alert",
                  style: {
                    margin: "8px 16px 0", padding: "8px 12px", borderRadius: 8,
                    background: "var(--sorne-bg-surface)",
                    border: "1px solid var(--sorne-status-unknown-fg)",
                    color: "var(--sorne-status-unknown-fg)", fontSize: 13,
                  },
                }, `页面清单不可用：${s.manifestError}；导航槽位仍可点击，页面以占位卡呈现。`)
              : null,
            isWorkspace
              ? H(Topbar, {
                  api: apiFn, ui: s.ui, theme: s.theme, router,
                  projectId: router.projectId,
                  onOpenSettings: () => this.setState({ settingsOpen: true }),
                  onProjectMissing: (pid) => {
                    router.replace(DEFAULT_HASH);
                    this.setNotice({ kind: "info", text: `项目不存在或不可访问：${pid}；已回到项目列表` });
                  },
                })
              : null,
            H("div", { style: { display: "flex", alignItems: "flex-start", gap: 0, maxWidth: 1440, margin: "0 auto", width: "100%" } },
              H("nav", {
                "aria-label": isWorkspace ? "工作区导航" : "引导导航",
                style: {
                  flex: "0 0 190px", padding: 10, display: "flex", flexDirection: "column", gap: 2,
                },
              },
                navPages.map((pageId) => {
                  const isActive = pageId === activePageId;
                  return H("button", {
                    key: pageId,
                    type: "button",
                    "aria-label": PAGE_LABELS[pageId] || pageId,
                    "aria-current": isActive ? "page" : undefined,
                    onClick: () => {
                      if (pageId === DIAGNOSTICS_PAGE) {
                        router.open(`#/p/${encodeURIComponent(router.projectId || "")}/diagnostics`);
                      } else if (GUIDE_PAGES.includes(pageId)) {
                        router.open(`#/${pageId}`);
                      } else {
                        router.open(`#/p/${encodeURIComponent(router.projectId || "")}/${pageId}`);
                      }
                    },
                    style: {
                      ...btnStyle("quiet"),
                      textAlign: "left",
                      fontSize: 14, padding: "7px 10px", borderRadius: 6,
                      fontWeight: isActive ? 700 : 400,
                      color: isActive ? "var(--sorne-brand)" : "var(--sorne-text-primary)",
                      background: isActive ? "var(--sorne-bg-subtle)" : "transparent",
                    },
                  }, PAGE_LABELS[pageId] || pageId);
                }),
                isWorkspace
                  ? H("div", { style: { marginTop: 10, paddingTop: 8, borderTop: "1px solid var(--sorne-border)" } },
                      H("button", {
                        type: "button",
                        "aria-label": "系统诊断",
                        "aria-current": activePageId === DIAGNOSTICS_PAGE ? "page" : undefined,
                        onClick: () => router.open(`#/p/${encodeURIComponent(router.projectId || "")}/diagnostics`),
                        style: {
                          ...btnStyle("quiet"), textAlign: "left", fontSize: 14, padding: "7px 10px",
                          color: activePageId === DIAGNOSTICS_PAGE ? "var(--sorne-brand)" : "var(--sorne-text-secondary)",
                          fontWeight: activePageId === DIAGNOSTICS_PAGE ? 700 : 400,
                          background: activePageId === DIAGNOSTICS_PAGE ? "var(--sorne-bg-subtle)" : "transparent",
                        },
                      }, "系统诊断"))
                  : null,
              ),
              H("main", {
                style: {
                  flex: "1 1 auto", minWidth: 0, padding: "10px 12px",
                  display: "flex", gap: 12, alignItems: "flex-start",
                },
              },
                H("div", { style: { flex: "1 1 auto", minWidth: 0 } }, pageHosts),
                showDetail
                  ? H("aside", {
                      "aria-label": "详情",
                      style: {
                        flex: "0 0 400px", maxWidth: "42vw",
                        background: "var(--sorne-bg-raised)",
                        border: "1px solid var(--sorne-border)",
                        borderRadius: 8, padding: 12, overflow: "auto", maxHeight: "80vh",
                      },
                    },
                      H("div", { style: { display: "flex", justifyContent: "flex-end", marginBottom: 6 } },
                        H("button", {
                          type: "button", "aria-label": "关闭详情",
                          onClick: () => router.back(`#/p/${encodeURIComponent(router.projectId || "")}/${activePageId}`),
                          style: btnStyle(),
                        }, "关闭详情")),
                      H(SectionErrorBoundary, null, detailEl))
                  : null,
              ),
            ),
            isRecords
              ? H(RecordOverlay, {
                  api: apiFn, ui: s.ui,
                  recordId: router.recordId,
                  projectId: router.projectId,
                  openRecord: (id) => router.openRecord(id),
                  onClose: () => router.back(`#/p/${encodeURIComponent(router.projectId || "")}/workbench`),
                })
              : null,
            s.settingsOpen
              ? H(SettingsDrawer, {
                  api: apiFn, ui: s.ui,
                  projectId: router.projectId,
                  onClose: () => this.setState({ settingsOpen: false }),
                })
              : null,
            H("footer", { style: { padding: "6px 16px 16px", fontSize: 13, color: "var(--sorne-text-muted)" } },
              "Sorne 持续探索工作台 · 规划—执行—保存—验证—再规划；观察、意图、知识与证据独立于会话持久保存。"),
          );
        }
      }

      function SornePanel() {
        return H(SectionErrorBoundary, null, H(Shell));
      }

      return { Shell, SornePanel, Topbar, RecordOverlay, SettingsDrawer, resolveRunStatus, resolveLlmGate };
    }

    /* 真实入口依赖注入（浏览器全局；测试经 createShellRuntime 注入假实现）。 */
    const realDeps = {
      React, h, api,
      win: typeof window !== "undefined" ? window : undefined,
      doc: typeof document !== "undefined" ? document : undefined,
      initialThemeMode: (typeof window !== "undefined" && window.__SORNE_THEME__) || undefined,
    };

    const inject = ["slots"];

    function apply(ctx) {
      const runtime = createShellRuntime(realDeps);
      const SornePanelBound = runtime.SornePanel;
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          {
            name: "settings.section",
            id: "sorne",
            order: 21,
            label: () => "Sorne 持续探索工作台",
            inject: () => ({}),
          },
          function sorneSectionBoundary() {
            return h(SornePanelBound);
          },
        ),
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    /* 无头冒烟与后续模块测试用：直接引用内部实现（避免从源码文本抽取执行）。 */
    exports.__test__ = {
      createShellRuntime,
      resolveRunStatus,
      resolveLlmGate,
      WORKSPACE_PAGES,
      GUIDE_PAGES,
      DIAGNOSTICS_PAGE,
      RECORDS_PAGE,
      PAGE_LABELS,
      SLOT_OWNERS,
      api,
      SectionErrorBoundary,
    };
    return module.exports;
  },
});
