/**
 * 页面：首次使用向导（lib/ui/pages/onboarding.page.mjs；M3 独占；BLUEPRINT-UI §1.2）。
 *
 * 四步流程（步骤条可回退，第③步可整体跳过）：
 *   ① 连接模型：提供方（OpenAI 兼容）· Base URL · 模型名 · API Key；按角色高级配置
 *      默认四角色共用同一套（高级设置折叠区）。保存 PUT /sorne/llm/settings（#51），
 *      测试 POST /sorne/llm/test（#52）——可用显示「可用（时延）」或失败原因（超时/401/
 *      模型不存在等原样呈现），可用/不可用二态明确。
 *   ② 创建项目：名称、目标（写入 description）、允许/拒绝/待判断范围（共用
 *      lib/ui/scope/editor.mjs 范围编辑器，§2.7）。提交 POST /sorne/projects（#5）。
 *      项目创建后本流程内名称/目标不再可改（无更新端点，如实标注）；范围可经
 *      POST /sorne/scope-revisions（#8）出新版本。
 *   ③ 导入已有资料（可跳过）：文件原始字节经 POST /sorne/evidence/blobs（#11，rawBody，
 *      representation=uploaded_file）固定，再 POST /sorne/captures（#12）登记采集记录
 *      （来源标记 third_party_import——后端 SOURCE_KINDS 无 uploaded_file，见竣工记录偏差）。
 *      上传失败如实呈现（EVIDENCE_NOT_COMMITTED 等），不假装成功。
 *   ④ 检查并开始：模型可用状态 + 范围/资料摘要；「保存项目」（未创建则创建）/
 *      「开始探索」POST /sorne/projects/{id}/explore-start（#48）——成功进入工作区
 *      #/p/:pid/workbench；409 LLM_NOT_CONFIGURED 呈现「尚未连接模型，项目可以保存，
 *      AI 暂不能开始」与直达连接入口；端点未竣工（404/501）如实呈现，不虚报已开始。
 *
 * 模型未配置横幅：全程可见（每一步都渲染），附直达连接入口；绝不用「服务正常」
 * 暗示 AI 可工作（要求 §1）。
 *
 * 语义纪律（冻结）：未提供 ≠ 不存在（空值「—（未提供）」）；501/404 未实现 ≠ 报错
 * （呈现「不可用」态并说明）；数据时刻标注；用户可见文案中文。
 *
 * 页面契约（§2.5）：纯 ESM、不 import 任何包或 Node 内置模块（范围编辑器为同工程
 * UI 模块，运行时动态 import，见 loadScopeEditorModule）；不用浏览器本地存储；
 * export default { id, title, order, render(ctx) }，ctx = { React, h, api, router, ui, theme }；
 * 有状态部分收敛为单个 React.Component 子类（外壳冻结渲染协议：render(ctx) 在外壳
 * 渲染期同步调用，页面顶层不得调用 React 钩子；路由变化经 router.onChange 订阅）。
 */

/* ── 范围编辑器模块加载（多候选：Node/相对布局 → 宿主 lib 服务布局） ── */
async function loadScopeEditorModule() {
  const candidates = [];
  try {
    candidates.push(new URL("../scope/editor.mjs", import.meta.url).href);
  } catch {
    /* import.meta.url 不可用时忽略该候选 */
  }
  candidates.push("/sorne/ui/lib/scope/editor.mjs");
  let lastError = null;
  for (const spec of candidates) {
    try {
      return await import(spec);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError || new Error("范围编辑器模块不可达");
}

/* ── 小工具 ───────────────────────────────────────────────────────── */

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

const CARD = {
  background: "var(--sorne-bg-surface)",
  border: "1px solid var(--sorne-border)",
  borderRadius: 8,
  padding: "12px 14px",
};

function textLike(value) {
  if (value === null || value === undefined || value === "") return "—（未提供）";
  return String(value);
}

function errorMessage(e) {
  const err = e || {};
  const msg = err.message ? String(err.message) : String(err);
  return err.code ? `${err.code} · ${msg}` : msg;
}

const STEP_DEFS = Object.freeze([
  { no: 1, label: "连接模型" },
  { no: 2, label: "创建项目" },
  { no: 3, label: "导入已有资料（可跳过）" },
  { no: 4, label: "检查并开始" },
]);

/* ── 页面定义 ─────────────────────────────────────────────────────── */

export default {
  id: "onboarding",
  title: "首次使用",
  order: 5,
  render({ React, h, api, router, ui, theme }) {
    const ComponentBase =
      React && typeof React.Component === "function"
        ? React.Component
        : class PageComponentBase {
            constructor(props) {
              this.props = props || {};
            }
          };

    class OnboardingBody extends ComponentBase {
      constructor(props) {
        super(props);
        this.state = {
          step: 1,
          llm: { phase: "loading", data: null, error: null },
          modelForm: { baseUrl: "", model: "", apiKey: "", perRole: {}, advancedNote: null },
          test: { phase: "idle", latency: null, message: null },
          proj: {
            name: "",
            goal: "",
            rules: { allow: [], deny: [], pending: [] },
            rulesValid: true,
            ruleErrors: [],
            rulesDirty: false,
            created: null, // { id, name }
            msg: null,
            creating: false,
          },
          editor: { phase: "idle", error: null },
          imports: { items: [], running: false, msg: null },
          start: { running: false, msg: null, started: false },
          dataAt: null,
          navSeq: 0,
        };
        this.importSeq = 0;
        this.onNav = this.onNav.bind(this);
        this.unsubNav = null;
      }

      componentDidMount() {
        this.reloadLlm(false);
        const router = this.props.router;
        if (router && typeof router.onChange === "function") {
          this.unsubNav = router.onChange(this.onNav);
        }
      }

      componentWillUnmount() {
        if (typeof this.unsubNav === "function") this.unsubNav();
      }

      onNav() {
        // keep-alive 外壳：回到本页时刷新模型配置（横幅与连接状态保持新鲜）。
        this.setState((prev) => ({ navSeq: prev.navSeq + 1 }));
        this.reloadLlm(true);
      }

      async reloadLlm(silent) {
        const { api } = this.props;
        if (typeof api !== "function") {
          this.setState({ llm: { phase: "error", data: null, error: { message: "当前宿主未提供 API 通道" } } });
          return;
        }
        if (!silent) this.setState({ llm: { phase: "loading", data: null, error: null } });
        try {
          const data = await api("/sorne/llm/settings");
          this.setState((prev) => {
            const form = { ...prev.modelForm };
            // 预填已保存配置（API Key 只写不读：仅显示掩码提示，不回填明文）
            if (data && typeof data === "object") {
              if (typeof data.base_url === "string" && data.base_url && !form.baseUrl) form.baseUrl = data.base_url;
              if (typeof data.model === "string" && data.model && !form.model) form.model = data.model;
              const pr = data.per_role && typeof data.per_role === "object" ? data.per_role : {};
              const merged = { ...form.perRole };
              for (const role of ["planner", "orchestrator", "worker", "verifier"]) {
                const entry = pr[role];
                const m = entry && typeof entry.model === "string" ? entry.model : "";
                if (m && !merged[role]) merged[role] = m;
              }
              form.perRole = merged;
            }
            return {
              llm: { phase: "ready", data, error: null },
              modelForm: form,
              dataAt: new Date().toISOString(),
            };
          });
        } catch (e) {
          this.setState({ llm: { phase: "error", data: null, error: e }, dataAt: new Date().toISOString() });
        }
      }

      setStep(step) {
        this.setState({ step, start: { running: false, msg: null, started: false } });
        if (step === 2) this.ensureEditor();
      }

      /* ── 第①步：连接模型 ─────────────────────────────────────── */

      patchModelForm(patch) {
        this.setState((prev) => ({ modelForm: { ...prev.modelForm, ...patch } }));
      }

      async saveModelSettings() {
        const { api } = this.props;
        const { modelForm } = this.state;
        if (typeof api !== "function") {
          this.setState({ modelForm: { ...modelForm, advancedNote: "保存失败：当前宿主未提供 API 通道" } });
          return;
        }
        const body = { base_url: modelForm.baseUrl.trim(), model: modelForm.model.trim() };
        if (!body.base_url || !body.model) {
          this.setState({ modelForm: { ...modelForm, advancedNote: "Base URL 与模型名必填（保存被本地拦截，未发请求）" } });
          return;
        }
        if (typeof modelForm.apiKey === "string" && modelForm.apiKey.trim()) {
          // 只写不读：不落本地存储、不回显。契约键为 snake_case api_key（蓝图 §2.6-1）；
          // M2 存储层同时接受 apiKey 别名，但提交体只发契约键，避免双键歧义。
          body.api_key = modelForm.apiKey.trim();
        }
        const perRole = {};
        for (const role of ["planner", "orchestrator", "worker", "verifier"]) {
          const m = String(modelForm.perRole[role] || "").trim();
          if (m) perRole[role] = { model: m };
        }
        body.per_role = perRole; // 表单即真相：整表替换（空 = 清除全部角色覆盖）
        this.setState({ modelForm: { ...modelForm, advancedNote: "保存中…" } });
        try {
          const res = await api("/sorne/llm/settings", { method: "PUT", body: JSON.stringify(body) });
          const reload = res && res.reload ? res.reload : null;
          const reloadNote =
            reload && reload.started
              ? "运行时已热加载，AI 可开始工作"
              : reload && reload.reason
                ? `运行时热加载：未启动（${reload.reason}）`
                : null;
          this.setState({
            modelForm: { ...this.state.modelForm, apiKey: "", advancedNote: reloadNote || "设置已保存" },
          });
          this.reloadLlm(true);
          await this.runConnectionTest();
        } catch (e) {
          this.setState({
            modelForm: { ...this.state.modelForm, advancedNote: `保存设置失败：${errorMessage(e)}` },
          });
        }
      }

      async runConnectionTest() {
        const { api } = this.props;
        const { modelForm } = this.state;
        if (typeof api !== "function") {
          this.setState({ test: { phase: "fail", latency: null, message: "当前宿主未提供 API 通道" } });
          return;
        }
        const baseUrl = modelForm.baseUrl.trim();
        const model = modelForm.model.trim();
        if (!baseUrl || !model) {
          this.setState({ test: { phase: "fail", latency: null, message: "测试连接需要 Base URL 与模型名（可用已保存配置）" } });
          return;
        }
        this.setState({ test: { phase: "running", latency: null, message: null } });
        try {
          // M2 实装读取 baseUrl/model（camelCase）；同携蓝图别名 base_url 兼容后续修订。
          const res = await api("/sorne/llm/test", {
            method: "POST",
            body: JSON.stringify({ baseUrl, model, base_url: baseUrl }),
          });
          if (res && res.ok) {
            this.setState({
              test: { phase: "ok", latency: res.latency_ms ?? null, message: null },
              dataAt: new Date().toISOString(),
            });
          } else {
            const err = res && res.error ? res.error : {};
            this.setState({
              test: {
                phase: "fail",
                latency: res && res.latency_ms != null ? res.latency_ms : null,
                message: `${err.code ? `${err.code} · ` : ""}${err.message || "连接失败（原因未提供）"}`,
              },
              dataAt: new Date().toISOString(),
            });
          }
        } catch (e) {
          this.setState({ test: { phase: "fail", latency: null, message: errorMessage(e) } });
        }
      }

      renderModelStep() {
        const { h, ui } = this.props;
        const { modelForm, test, llm } = this.state;
        const apiKeyHint =
          llm.phase === "ready" && llm.data && llm.data.api_key_set
            ? `已保存密钥（${llm.data.api_key_hint || "已掩码"}）：留空即沿用`
            : "密钥仅提交到服务端保存，浏览器不存储、不回显";
        return h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: 10 } },
          h("div", { style: FIELD }, "提供方：OpenAI 兼容（Base URL + 模型名 + API Key）"),
          this.input("Base URL（如 https://api.example.com/v1）", "模型连接 Base URL", modelForm.baseUrl, (v) =>
            this.patchModelForm({ baseUrl: v })),
          this.input("模型名（如 deepseek-chat）", "模型连接模型名", modelForm.model, (v) =>
            this.patchModelForm({ model: v })),
          this.input("API Key（留空 = 沿用已保存）", "模型连接 API Key", modelForm.apiKey, (v) =>
            this.patchModelForm({ apiKey: v }), "password"),
          h("div", { style: { fontSize: 13, color: "var(--sorne-text-muted)" } }, apiKeyHint),
          h(
            "details",
            { style: { fontSize: 14, color: "var(--sorne-text-primary)" } },
            h("summary", { style: { cursor: "pointer", fontWeight: 600 } }, "高级设置：按角色分别配置（默认四角色共用同一套模型）"),
            h(
              "div",
              { style: { display: "flex", flexDirection: "column", gap: 8, marginTop: 8 } },
              h(
                "div",
                { style: { fontSize: 13, color: "var(--sorne-text-secondary)" } },
                "Planner / Orchestrator / Worker / Verifier 默认共用上方模型配置；仅在需要时为单个角色覆盖模型名（留空 = 共用）。",
              ),
              ["planner", "orchestrator", "worker", "verifier"].map((role) =>
                this.input(
                  `${role} 模型覆盖（留空 = 共用）`,
                  `角色 ${role} 的模型覆盖`,
                  modelForm.perRole[role] || "",
                  (v) => this.patchModelForm({ perRole: { ...modelForm.perRole, [role]: v } }),
                ),
              ),
            ),
          ),
          h(
            "div",
            { style: { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" } },
            h("button", {
              type: "button",
              "aria-label": "保存模型设置",
              onClick: () => this.saveModelSettings(),
              style: btnStyle("primary"),
            }, "保存设置"),
            h("button", {
              type: "button",
              "aria-label": "测试模型连接",
              onClick: () => this.runConnectionTest(),
              disabled: test.phase === "running",
              style: btnStyle(null, test.phase === "running"),
            }, test.phase === "running" ? "测试中…" : "测试连接"),
            modelForm.advancedNote
              ? h("span", { role: "status", style: { fontSize: 13.5, color: "var(--sorne-text-secondary)" } }, modelForm.advancedNote)
              : null,
          ),
          test.phase === "ok"
            ? h("div", { role: "status", style: { ...OKLINE, fontSize: 14 } },
                `连接可用（时延 ${textLike(test.latency)} ms${ui && ui.formatTime && this.state.dataAt ? ` · 数据时刻 ${ui.formatTime(this.state.dataAt)}` : ""}）`)
            : null,
          test.phase === "fail"
            ? h("div", { role: "alert", style: { ...ERRLINE, fontSize: 14 } }, `连接失败：${test.message}`)
            : null,
        );
      }

      input(label, ariaLabel, value, onChange, type) {
        const { h } = this.props;
        return h("label", { style: { display: "flex", flexDirection: "column", gap: 3, fontSize: 14 } },
          h("span", { style: { color: "var(--sorne-text-primary)" } }, label),
          h("input", {
            type: type || "text",
            "aria-label": ariaLabel,
            value,
            onChange: (e) => onChange(e && e.target ? e.target.value : ""),
            style: INPUT,
          }),
        );
      }

      /* ── 第②步：创建项目 ─────────────────────────────────────── */

      async ensureEditor() {
        if (this.state.editor.phase === "loading" || this.state.editor.phase === "ok") return;
        this.setState({ editor: { phase: "loading", error: null } });
        try {
          const mod = await loadScopeEditorModule();
          if (!mod || typeof mod.createScopeEditorElement !== "function") {
            throw new Error("模块缺少 createScopeEditorElement 导出");
          }
          this.editorModule = mod;
          this.setState({ editor: { phase: "ok", error: null } });
        } catch (e) {
          this.setState({ editor: { phase: "error", error: e } });
        }
      }

      renderEditorArea() {
        const { h, React, api } = this.props;
        const { editor, proj } = this.state;
        if (editor.phase === "ok" && this.editorModule) {
          try {
            return this.editorModule.createScopeEditorElement({
              React,
              h,
              api,
              scope: proj.rules,
              projectId: proj.created ? proj.created.id : null,
              embedded: true,
              onChange: (payload) => {
                this.setState((prev) => ({
                  proj: {
                    ...prev.proj,
                    rules: payload.rules,
                    rulesValid: payload.valid,
                    ruleErrors: payload.errors,
                    rulesDirty: true,
                  },
                }));
              },
              onSaved: () => {
                this.setState((prev) => ({ proj: { ...prev.proj, rulesDirty: false } }));
                this.reloadLlm(true);
              },
            });
          } catch (e) {
            return h("div", { role: "alert", style: ERRCard }, `范围编辑器渲染失败：${errorMessage(e)}`);
          }
        }
        if (editor.phase === "error") {
          return h(
            "div",
            { role: "alert", style: { ...CARD, borderStyle: "dashed", fontSize: 14, lineHeight: 1.7, color: "var(--sorne-text-secondary)" } },
            h("div", { style: { fontWeight: 600, color: "var(--sorne-status-unknown-fg)" } }, "范围编辑器模块不可加载"),
            h("div", null, `宿主未提供模块源（${errorMessage(editor.error)}）。`),
            h("div", null,
              "可先不配置范围继续创建项目：范围未配置时，所有目标都将按「待判断」处理，AI 不会自动操作任何目标（§17）；",
              "创建后可在项目设置中补配范围。"),
          );
        }
        return h("div", { role: "status", style: { fontSize: 14, color: "var(--sorne-text-secondary)" } }, "正在加载范围编辑器…");
      }

      async submitProject({ summary }) {
        const { api } = this.props;
        const { proj } = this.state;
        if (typeof api !== "function") {
          this.setState({ proj: { ...proj, msg: { kind: "err", text: "当前宿主未提供 API 通道" } } });
          return null;
        }
        if (!proj.name.trim() || !proj.goal.trim()) {
          this.setState({ proj: { ...proj, msg: { kind: "err", text: "项目名称与目标必填（本地校验，未发请求）" } } });
          return null;
        }
        if (!proj.rulesValid) {
          this.setState({ proj: { ...proj, msg: { kind: "err", text: "范围条目存在格式错误，请先修正（未发请求）" } } });
          return null;
        }
        if (proj.created) {
          if (summary) {
            this.setState({ proj: { ...proj, msg: { kind: "ok", text: `项目已保存：${proj.created.id}` } } });
          }
          return proj.created;
        }
        this.setState({ proj: { ...this.state.proj, creating: true, msg: null } });
        try {
          const res = await api("/sorne/projects", {
            method: "POST",
            body: JSON.stringify({
              name: proj.name.trim(),
              description: proj.goal.trim(),
              scope_rules: proj.rules,
            }),
          });
          const created = res && res.project ? { id: res.project.id, name: res.project.name } : null;
          this.setState({
            proj: {
              ...this.state.proj,
              creating: false,
              created,
              rulesDirty: false, // 范围已随项目创建入库
              msg: created ? { kind: "ok", text: `项目已创建：${created.id}` } : null,
            },
            dataAt: new Date().toISOString(),
          });
          return created;
        } catch (e) {
          this.setState({
            proj: { ...this.state.proj, creating: false, msg: { kind: "err", text: `创建项目失败：${errorMessage(e)}` } },
          });
          return null;
        }
      }

      async saveScopeRevisionIfDirty(created, rulesDirty) {
        const { api } = this.props;
        const { proj } = this.state;
        if (!created || !rulesDirty || !proj.rulesValid) return true;
        if (typeof api !== "function") return false;
        try {
          await api("/sorne/scope-revisions", {
            method: "POST",
            body: JSON.stringify({ project_id: created.id, rules: proj.rules, summary: "向导第②步调整范围" }),
          });
          this.setState({ proj: { ...this.state.proj, rulesDirty: false, msg: { kind: "ok", text: "范围已保存为新版本" } } });
          return true;
        } catch (e) {
          this.setState({ proj: { ...this.state.proj, msg: { kind: "err", text: `保存范围版本失败：${errorMessage(e)}` } } });
          return false;
        }
      }

      async goStep3() {
        const { proj } = this.state;
        if (proj.created) {
          // 项目已存在（回退到第②步调整过范围）：只出新范围版本，不重复创建项目。
          const ok = await this.saveScopeRevisionIfDirty(proj.created, proj.rulesDirty);
          if (!ok) return;
        } else {
          const created = await this.submitProject({ summary: false });
          if (!created) return;
        }
        this.setStep(3);
      }

      renderProjectStep() {
        const { h } = this.props;
        const { proj } = this.state;
        const locked = Boolean(proj.created);
        return h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: 10 } },
          locked
            ? h(
                "div",
                { style: { ...CARD, fontSize: 13.5, lineHeight: 1.6, color: "var(--sorne-text-secondary)" } },
                `项目已创建（${proj.created.id}）。名称与目标在本流程内不再可改（创建后无更新端点，如实标注）；`,
                "继续下一步会把本次范围调整保存为新范围版本。",
              )
            : null,
          locked
            ? h("div", { style: FIELD }, `项目名称：${proj.created.name}`)
            : this.input("项目名称（必填）", "项目名称", proj.name, (v) => this.patchProj({ name: v })),
          locked
            ? h("div", { style: { ...FIELD, whiteSpace: "pre-wrap" } }, `目标：${proj.goal}`)
            : h("label", { style: { display: "flex", flexDirection: "column", gap: 3, fontSize: 14 } },
                h("span", { style: { color: "var(--sorne-text-primary)" } }, "目标（必填，写入项目描述）"),
                h("textarea", {
                  "aria-label": "项目目标",
                  rows: 4,
                  value: proj.goal,
                  placeholder: "例如：对 test.example 内网系统做持续渗透探索，重点覆盖登录与支付链路",
                  onChange: (e) => this.patchProj({ goal: e && e.target ? e.target.value : "" }),
                  style: { ...INPUT, resize: "vertical" },
                })),
          this.renderEditorArea(),
          proj.msg
            ? h("div", {
                role: proj.msg.kind === "err" ? "alert" : "status",
                style: { fontSize: 14, lineHeight: 1.6, color: proj.msg.kind === "err" ? "var(--sorne-status-unknown-fg)" : "var(--sorne-status-ok-fg)" },
              }, proj.msg.text)
            : null,
        );
      }

      patchProj(patch) {
        this.setState((prev) => ({ proj: { ...prev.proj, ...patch } }));
      }

      /* ── 第③步：导入已有资料（可跳过） ───────────────────────── */

      async onFilesSelected(fileList) {
        const { api } = this.props;
        const { proj } = this.state;
        const files = Array.from(fileList || []);
        if (!files.length) return;
        if (!proj.created) {
          this.setState({ imports: { items: [], running: false, msg: { kind: "err", text: "尚未创建项目：请先完成第②步（资料必须归属项目）" } } });
          return;
        }
        if (typeof api !== "function") {
          this.setState({ imports: { items: [], running: false, msg: { kind: "err", text: "当前宿主未提供 API 通道" } } });
          return;
        }
        this.setState((prev) => ({ imports: { ...prev.imports, running: true, msg: null } }));
        const results = [];
        for (const file of files) {
          try {
            const bytes = await file.arrayBuffer();
            const q = new URLSearchParams({
              project_id: proj.created.id,
              representation: "uploaded_file",
              source_kind: "third_party_import",
            });
            const blobReceipt = await api(`/sorne/evidence/blobs?${q.toString()}`, {
              method: "POST",
              headers: { "Content-Type": "application/octet-stream" },
              body: bytes,
            });
            const sha256 = blobReceipt && blobReceipt.sha256;
            const captureReceipt = await api("/sorne/captures", {
              method: "POST",
              body: JSON.stringify({
                project_id: proj.created.id,
                tool_call_id: `wizard-import-${Date.now()}-${this.importSeq++}`,
                request_url_exact: file.name,
                method: "IMPORT",
                source_kind: "third_party_import",
                response_body_blob: sha256,
              }),
            });
            const captureId =
              captureReceipt && captureReceipt.capture_id
                ? captureReceipt.capture_id
                : captureReceipt && captureReceipt.capture
                  ? captureReceipt.capture.capture_id
                  : null;
            results.push({ name: file.name, byteSize: bytes.byteLength, sha256, captureId, error: null });
          } catch (e) {
            results.push({ name: file.name, byteSize: null, sha256: null, captureId: null, error: errorMessage(e) });
          }
        }
        this.setState((prev) => ({
          imports: {
            items: [...prev.imports.items, ...results],
            running: false,
            msg: results.some((r) => r.error)
              ? { kind: "err", text: "部分文件导入失败（明细见列表；失败的文件未产生可用采集记录，不假装成功）" }
              : { kind: "ok", text: `已导入 ${results.filter((r) => !r.error).length} 个文件（Blob 已固定并登记采集）` },
          },
          dataAt: new Date().toISOString(),
        }));
      }

      renderImportStep() {
        const { h, ui } = this.props;
        const { imports } = this.state;
        return h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: 10 } },
          h(
            "div",
            { style: { fontSize: 14, lineHeight: 1.6, color: "var(--sorne-text-primary)" } },
            "附加已有资料（可跳过）：文件原始字节将固定为证据 Blob 并登记采集记录，AI 后续可经编号读取。",
          ),
          h("input", {
            type: "file",
            multiple: true,
            "aria-label": "选择要导入的资料文件",
            onChange: (e) => {
              const files = e && e.target ? e.target.files : null;
              if (e && e.target) e.target.value = "";
              this.onFilesSelected(files);
            },
            style: { fontSize: 14, color: "var(--sorne-text-primary)" },
          }),
          imports.running
            ? h("div", { role: "status", style: { fontSize: 14, color: "var(--sorne-text-secondary)" } }, "正在导入…")
            : null,
          imports.msg
            ? h("div", {
                role: imports.msg.kind === "err" ? "alert" : "status",
                style: { fontSize: 14, lineHeight: 1.6, color: imports.msg.kind === "err" ? "var(--sorne-status-unknown-fg)" : "var(--sorne-status-ok-fg)" },
              }, imports.msg.text)
            : null,
          imports.items.length
            ? h(
                "ul",
                { style: { margin: 0, paddingLeft: 20, fontSize: 14, lineHeight: 1.7, color: "var(--sorne-text-primary)" } },
                imports.items.map((it, i) =>
                  it.error
                    ? h("li", { key: i }, `${it.name}：导入失败 —— ${it.error}`)
                    : h(
                        "li",
                        { key: i },
                        `${it.name}（${it.byteSize} 字节）· Blob ${textLike(it.sha256).slice(0, 19)}…`,
                        it.captureId && ui && ui.RecordIdChip
                          ? h("span", null, " · 采集 ", ui.RecordIdChip(it.captureId, {
                              projectId: this.state.proj.created ? this.state.proj.created.id : null,
                              navigate: (id) => this.props.router && this.props.router.openRecord(id),
                            }))
                          : null,
                      ),
                ),
              )
            : null,
        );
      }

      /* ── 第④步：检查并开始 ───────────────────────────────────── */

      async startExploring() {
        const { router } = this.props;
        const created = await this.submitProject({ summary: true });
        if (!created) return;
        if (typeof router !== "object" || router === null || typeof router.open !== "function") {
          this.setState({ start: { running: false, msg: { kind: "err", text: "导航模块未就绪，无法进入工作区" }, started: false } });
          return;
        }
        const { api } = this.props;
        this.setState({ start: { running: true, msg: null, started: false } });
        try {
          await api(`/sorne/projects/${encodeURIComponent(created.id)}/explore-start`, {
            method: "POST",
            body: JSON.stringify({}),
          });
          this.setState({ start: { running: false, msg: { kind: "ok", text: "探索已开始，正在进入工作区…" }, started: true } });
          router.open(`#/p/${encodeURIComponent(created.id)}/workbench`);
        } catch (e) {
          const status = e && typeof e.status === "number" ? e.status : null;
          if (e && e.code === "LLM_NOT_CONFIGURED") {
            const reqs = e.body && Array.isArray(e.body.next_requirements) ? e.body.next_requirements : [];
            this.setState({
              start: {
                running: false,
                started: false,
                msg: {
                  kind: "err",
                  text: `尚未连接模型，项目可以保存，AI 暂不能开始。${e.message ? `（${e.message}）` : ""}${reqs.length ? ` 下一步：${reqs.join("；")}` : ""}`,
                },
              },
            });
          } else if (status === 404 || status === 501) {
            this.setState({
              start: {
                running: false,
                started: false,
                msg: { kind: "err", text: `开始探索接口不可用（HTTP ${status}）：服务端尚未提供该端点。项目已保存，可稍后在项目内开始探索。` },
              },
            });
          } else {
            this.setState({ start: { running: false, started: false, msg: { kind: "err", text: `开始探索失败：${errorMessage(e)}` } } });
          }
        }
      }

      renderSummaryRow(label, value) {
        const { h } = this.props;
        return h("div", { style: { display: "flex", gap: 8, fontSize: 14, lineHeight: 1.7 } },
          h("span", { style: { color: "var(--sorne-text-secondary)", flex: "0 0 auto", minWidth: 96 } }, label),
          h("span", { style: { color: "var(--sorne-text-primary)", wordBreak: "break-all" } }, value),
        );
      }

      renderReviewStep() {
        const { h, ui } = this.props;
        const { proj, imports, llm, test, start } = this.state;
        const modelReady = llm.phase === "ready" && llm.data && llm.data.configured;
        const modelText = modelReady
          ? `已连接：${llm.data.model}（来源：${llm.data.source === "env" ? "环境变量" : "已保存设置"}）`
          : "未连接（项目可以保存，AI 暂不能开始）";
        const scopeCounts = proj.rules
          ? `允许 ${proj.rules.allow.length} 条 · 拒绝 ${proj.rules.deny.length} 条 · 待判断 ${proj.rules.pending.length} 条${proj.rulesDirty ? "（有未保存修改）" : ""}`
          : "—（未提供）";
        const imported = imports.items.filter((it) => !it.error);
        const importsText = imported.length
          ? `${imported.length} 个文件已固定为 Blob 并登记采集${imports.items.some((it) => it.error) ? "；存在失败项" : ""}`
          : "未导入资料";
        return h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: 10 } },
          h("div", { style: { fontSize: 14, fontWeight: 600, color: "var(--sorne-text-primary)" } }, "开始前检查"),
          this.renderSummaryRow("模型", modelText),
          test.phase === "ok"
            ? this.renderSummaryRow("最近测试", `连接可用（时延 ${textLike(test.latency)} ms）`)
            : null,
          test.phase === "fail"
            ? this.renderSummaryRow("最近测试", `失败：${test.message}`)
            : null,
          this.renderSummaryRow("项目", proj.created
            ? `${proj.created.name}（${proj.created.id}）`
            : proj.name.trim()
              ? `${proj.name.trim()}（尚未创建）`
              : "尚未填写"),
          this.renderSummaryRow("范围", scopeCounts),
          this.renderSummaryRow("资料", importsText),
          imports.items.some((it) => it.error)
            ? h("div", { role: "alert", style: { ...ERRLINE, fontSize: 13.5 } },
                `导入失败项：${imports.items.filter((it) => it.error).map((it) => it.name).join("、")}`)
            : null,
          h(
            "div",
            { style: { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" } },
            h("button", {
              type: "button",
              "aria-label": "保存项目",
              disabled: start.running || proj.creating,
              onClick: () => this.submitProject({ summary: true }),
              style: btnStyle(null, start.running || proj.creating),
            }, proj.creating ? "保存中…" : "保存项目"),
            h("button", {
              type: "button",
              "aria-label": "开始探索",
              disabled: start.running || proj.creating,
              onClick: () => this.startExploring(),
              style: btnStyle("primary", start.running || proj.creating),
            }, start.running ? "正在开始…" : "开始探索"),
            proj.created
              ? h("button", {
                  type: "button",
                  "aria-label": "前往项目列表",
                  onClick: () => {
                    const router = this.props.router;
                    if (router && typeof router.open === "function") router.open("#/projects");
                  },
                  style: btnStyle("quiet"),
                }, "前往项目列表")
              : null,
          ),
          start.msg
            ? h("div", {
                role: start.msg.kind === "err" ? "alert" : "status",
                style: { fontSize: 14, lineHeight: 1.7, color: start.msg.kind === "err" ? "var(--sorne-status-unknown-fg)" : "var(--sorne-status-ok-fg)" },
              }, start.msg.text)
            : null,
          !start.msg && proj.msg
            ? h("div", {
                role: proj.msg.kind === "err" ? "alert" : "status",
                style: { fontSize: 14, lineHeight: 1.7, color: proj.msg.kind === "err" ? "var(--sorne-status-unknown-fg)" : "var(--sorne-status-ok-fg)" },
              }, proj.msg.text)
            : null,
          start.msg && start.msg.kind === "err" && start.msg.text.includes("尚未连接模型")
            ? h("button", {
                type: "button",
                "aria-label": "去连接模型",
                onClick: () => this.setStep(1),
                style: btnStyle(null),
              }, "去连接模型")
            : null,
          ui && ui.formatTime && this.state.dataAt
            ? h("div", { style: { fontSize: 13, color: "var(--sorne-text-muted)" } },
                `数据时刻：${ui.formatTime(this.state.dataAt)} · 摘要按已加载数据推导`)
            : null,
        );
      }

      /* ── 横幅与步骤条 ────────────────────────────────────────── */

      renderModelBanner() {
        const { h, ui } = this.props;
        const { llm } = this.state;
        if (llm.phase === "loading") {
          return h("div", { role: "status", style: { ...BANNER, color: "var(--sorne-text-secondary)" } }, "正在读取模型配置…");
        }
        if (llm.phase === "error") {
          return h(
            "div",
            { role: "alert", style: { ...BANNER_WARN } },
            h("span", null, `模型配置状态未知（${errorMessage(llm.error)}）——AI 暂不能开始；项目可以保存。`),
            h("button", { type: "button", "aria-label": "重试读取模型配置", onClick: () => this.reloadLlm(false), style: btnStyle(null) }, "重试"),
            h("button", { type: "button", "aria-label": "去连接模型", onClick: () => this.setStep(1), style: btnStyle(null) }, "去连接模型"),
          );
        }
        if (llm.data && llm.data.configured === false) {
          return h(
            "div",
            { role: "status", style: { ...BANNER_WARN } },
            h("span", { style: { fontWeight: 600 } }, "尚未连接模型，项目可以保存，AI 暂不能开始"),
            h("button", { type: "button", "aria-label": "去连接模型", onClick: () => this.setStep(1), style: btnStyle(null) }, "去连接模型"),
          );
        }
        if (llm.data && llm.data.configured) {
          const src = llm.data.source === "env" ? "环境变量" : "已保存设置";
          return h("div", { role: "status", style: { ...BANNER_OK } },
            `模型已连接：${textLike(llm.data.model)}（来源：${src}）${ui && ui.formatTime && this.state.dataAt ? ` · 数据时刻 ${ui.formatTime(this.state.dataAt)}` : ""}`);
        }
        return null;
      }

      renderStepBar() {
        const { h } = this.props;
        const { step } = this.state;
        return h(
          "ol",
          {
            "aria-label": "向导步骤",
            style: { listStyle: "none", display: "flex", gap: 8, flexWrap: "wrap", margin: 0, padding: 0 },
          },
          STEP_DEFS.map((s) => {
            const current = s.no === step;
            const past = s.no < step;
            const content = `${s.no}. ${s.label}`;
            return h("li", { key: s.no },
              past
                ? h("button", {
                    type: "button",
                    "aria-label": `回退到第 ${s.no} 步：${s.label}`,
                    "aria-current": current ? "step" : undefined,
                    onClick: () => this.setStep(s.no),
                    style: btnStyle("quiet"),
                  }, content)
                : h("span", {
                    "aria-current": current ? "step" : undefined,
                    style: {
                      fontSize: 13.5,
                      padding: "5px 12px",
                      borderRadius: 6,
                      border: current ? "1px solid var(--sorne-brand)" : "1px solid var(--sorne-border)",
                      background: current ? "var(--sorne-bg-subtle)" : "transparent",
                      color: "var(--sorne-text-primary)",
                      fontWeight: current ? 600 : 400,
                    },
                  }, content),
            );
          }),
        );
      }

      renderNavButtons() {
        const { h, router } = this.props;
        const { step, proj } = this.state;
        const buttons = [];
        if (step > 1) {
          buttons.push(h("button", {
            type: "button",
            key: "back",
            "aria-label": `上一步（第 ${step - 1} 步）`,
            onClick: () => this.setStep(step - 1),
            style: btnStyle(null),
          }, "上一步"));
        }
        if (step === 1) {
          buttons.push(h("button", {
            type: "button",
            key: "next1",
            "aria-label": "下一步：创建项目",
            onClick: () => this.setStep(2),
            style: btnStyle("primary"),
          }, "下一步：创建项目"));
        }
        if (step === 2) {
          buttons.push(h("button", {
            type: "button",
            key: "next2",
            "aria-label": "下一步：导入资料（可跳过）",
            disabled: proj.creating,
            onClick: () => this.goStep3(),
            style: btnStyle("primary", proj.creating),
          }, proj.creating ? "创建中…" : proj.created ? "下一步：导入资料（可跳过）" : "创建项目并继续（资料可跳过）"));
        }
        if (step === 3) {
          buttons.push(h("button", {
            type: "button",
            key: "skip3",
            "aria-label": "跳过，不导入资料",
            onClick: () => this.setStep(4),
            style: btnStyle("primary"),
          }, "跳过，不导入资料"));
          buttons.push(h("button", {
            type: "button",
            key: "next3",
            "aria-label": "下一步：检查并开始",
            onClick: () => this.setStep(4),
            style: btnStyle(null),
          }, "下一步：检查并开始"));
        }
        if (step === 1 && router && typeof router.open === "function") {
          buttons.push(h("button", {
            type: "button",
            key: "tolist",
            "aria-label": "返回项目列表",
            onClick: () => router.open("#/projects"),
            style: btnStyle("quiet"),
          }, "返回项目列表"));
        }
        return h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap" } }, buttons);
      }

      render() {
        const { h, ui } = this.props;
        const { step } = this.state;
        return h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: 12, width: "100%" } },
          h(
            "div",
            { style: { display: "flex", flexDirection: "column", gap: 4 } },
            h("h2", { style: { margin: 0, fontSize: 17, color: "var(--sorne-text-primary)" } }, "首次使用：连接模型 → 创建项目 → 开始探索"),
            h("div", { style: { fontSize: 14, lineHeight: 1.6, color: "var(--sorne-text-secondary)" } },
              "四步完成准备；每一步都可以回退，第③步可整体跳过。项目随时可以保存；模型未连接时 AI 暂不能开始，页面会如实提示。"),
            h(
              "details",
              { style: { fontSize: 13.5, color: "var(--sorne-text-secondary)" } },
              h("summary", { style: { cursor: "pointer" } }, "语义说明"),
              h("div", { style: { lineHeight: 1.7, marginTop: 4 } },
                "本页不夸大状态：可用/不可用来自真实连接测试；端点未竣工显示「不可用」而非报错；",
                "空值显示「—（未提供）」——未提供不等于不存在；摘要均标注数据时刻并按已加载数据推导。"),
            ),
          ),
          this.renderModelBanner(),
          this.renderStepBar(),
          h("div", { style: CARD },
            step === 1 ? this.renderModelStep() : null,
            step === 2 ? this.renderProjectStep() : null,
            step === 3 ? this.renderImportStep() : null,
            step === 4 ? this.renderReviewStep() : null,
          ),
          this.renderNavButtons(),
          ui && ui.formatTime && this.state.dataAt && step !== 4
            ? h("div", { style: { fontSize: 13, color: "var(--sorne-text-muted)" } },
                `数据时刻：${ui.formatTime(this.state.dataAt)} · 配置状态来自服务端实时读取`)
            : null,
        );
      }
    }

    return h(OnboardingBody, { React, h, api, router, ui, theme });
  },
};

const FIELD = { fontSize: 14, lineHeight: 1.6, color: "var(--sorne-text-primary)" };
const INPUT = {
  fontSize: 14, padding: "6px 8px", borderRadius: 6, lineHeight: 1.55,
  border: "1px solid var(--sorne-border-strong)",
  background: "var(--sorne-bg-canvas)", color: "var(--sorne-text-primary)",
  boxSizing: "border-box", width: "100%", maxWidth: 480,
};
const BANNER = {
  display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center",
  padding: "10px 12px", borderRadius: 8, fontSize: 14, lineHeight: 1.6,
  border: "1px solid var(--sorne-border)", background: "var(--sorne-bg-surface)",
};
const BANNER_WARN = {
  ...BANNER,
  border: "1px solid var(--sorne-status-suspected-fg)",
  background: "var(--sorne-status-suspected-bg)",
  color: "var(--sorne-status-suspected-fg)",
};
const BANNER_OK = {
  ...BANNER,
  border: "1px solid var(--sorne-status-ok-fg)",
  background: "var(--sorne-status-ok-bg)",
  color: "var(--sorne-status-ok-fg)",
};
const OKLINE = { color: "var(--sorne-status-ok-fg)" };
const ERRLINE = { color: "var(--sorne-status-unknown-fg)", lineHeight: 1.6 };
const ERRCard = {
  ...CARD,
  borderStyle: "dashed",
  fontSize: 14, lineHeight: 1.7,
  color: "var(--sorne-status-unknown-fg)",
};
