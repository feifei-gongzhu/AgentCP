/**
 * 范围规则编辑器（lib/ui/scope/editor.mjs；M3 独占；BLUEPRINT-UI §2.7 跨模块冻结签名的实现方）。
 *
 * 允许 / 拒绝 / 待判断 三区编辑（§17），项目设置抽屉（M4 调用）与首次使用向导
 * 第②步（M3 自用）共用同一实现——M4 不得自实现第二份编辑器（§2.7）。
 *
 * 范围规则语法（与 lib/store/scope.mjs 冻结语义一致，提示文案据此书写）：
 *   - 主机规则：`example.test`（匹配该主机本身）；子域通配 `*.example.test`
 *     （仅匹配子域，不含主域本身；主机通配【仅适用于主机规则】，URL 条目不适用）；
 *   - URL 规则：`https://api.example.test/v1/`（路径前缀：匹配该路径与其下路径；
 *     URL 条目必须精确比对主机，跨主机一律不命中——P0-5 修复语义）；
 *     路径通配：`https://api.example.test/v1/*`（匹配 /v1、/v1/ 及其下任意路径）；
 *   - 对象规则（JSON 行）：`{"host":"*.example.test","port":8443,"path_prefix":"/api"}`
 *     （host 支持 *. 通配；scheme/port/path_prefix 可选）；
 *   - 明确拒绝优先于允许；待判断（pending）表达「需人工裁决」，缺少目标范围时
 *     不得默认任意目标均可操作（§17）。
 *
 * 导出面（依赖全部注入，本模块零 import——与页面同规：不引包、不引 Node 内置模块）：
 *   - scopeRulesToText(rules) → { allowText, denyText, pendingText }
 *   - parseScopeRulesText({ allowText, denyText, pendingText }) → { rules, errors, valid }
 *       rules = { allow: (string|object)[], deny: [...], pending: [...] }；行首为 "{" 的
 *       行按 JSON 解析为对象条目，解析失败计入 errors（本地拦截，不发请求）。
 *   - createScopeEditorElement({ React, h, api, scope, projectId, onChange, onSaved,
 *       onDone, embedded }) → React 元素（内嵌模式供向导使用；有 projectId 时提供
 *       「保存范围版本」按钮，调 POST /sorne/scope-revisions（#8））。
 *   - openScopeRulesEditor({ project, scope, onSaved, React, h, api, mount }) → void
 *       （§2.7 冻结签名；抽屉模式）。mount 是宿主页面提供的渲染挂点（页面类组件经
 *       setState 把抽屉元素挂进自身树）：mount(element) 渲染、mount(null) 关闭。
 *       project 为既有项目对象或 { id }；project 缺省时为纯收集模式（不调后端，
 *       onSaved({ rules }) 后由调用方决定用途——向导创建项目时随 POST /projects 提交）。
 *
 * 与 §2.7 字面签名的偏差（已记入 docs/modules/ui-M3.md 偏差节并上报）：
 *   冻结签名只列 { project, scope, onSaved } 三个键；一个 → void 的命令式函数
 *   在无 ReactDOM 可用的外壳里无法自行渲染，故追加 React/h/api/mount 四个渲染
 *   依赖键（页面 ctx 里现成，调用方写法 openScopeRulesEditor({ ...ctx, project,
 *   scope, onSaved, mount })）。三个冻结键保持一等语义不变。
 */

/* ── 文本 ↔ 规则（纯函数，便于单测） ─────────────────────────────── */

export function scopeRulesToText(rules) {
  const r = rules && typeof rules === "object" && !Array.isArray(rules) ? rules : {};
  const zone = (v) => (Array.isArray(v) ? v : []);
  const line = (entry) => {
    if (typeof entry === "string") return entry;
    try {
      return JSON.stringify(entry);
    } catch {
      return String(entry);
    }
  };
  return {
    allowText: zone(r.allow).map(line).join("\n"),
    denyText: zone(r.deny).map(line).join("\n"),
    pendingText: zone(r.pending).map(line).join("\n"),
  };
}

export function parseScopeRulesText({ allowText, denyText, pendingText } = {}) {
  const errors = [];
  const rules = { allow: [], deny: [], pending: [] };
  const zones = [
    ["allow", allowText],
    ["deny", denyText],
    ["pending", pendingText],
  ];
  for (const [key, text] of zones) {
    const lines = String(text ?? "").split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const raw = lines[i].trim();
      if (!raw) continue;
      if (raw.startsWith("{")) {
        try {
          const obj = JSON.parse(raw);
          if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
            throw new Error("对象条目必须是 JSON 对象");
          }
          rules[key].push(obj);
        } catch (e) {
          errors.push({ zone: key, line: i + 1, text: raw, message: `JSON 解析失败：${e && e.message ? e.message : e}` });
        }
      } else {
        rules[key].push(raw);
      }
    }
  }
  return { rules, errors, valid: errors.length === 0 };
}

/* ── 编辑器组件（类组件：外壳冻结渲染协议下不可用 React 钩子） ─────── */

const ZONE_DEFS = Object.freeze([
  {
    key: "allow",
    label: "允许（allow）",
    hint: "匹配的目标允许主动访问与采集。",
    ariaLabel: "允许范围规则，每行一条",
    placeholder: "例如：\nexample.test\nhttps://api.example.test/v1/*",
  },
  {
    key: "deny",
    label: "拒绝（deny，优先）",
    hint: "明确拒绝优先于允许；被拒绝的目标不派发任何动作。",
    ariaLabel: "拒绝范围规则，每行一条",
    placeholder: "例如：\nhttps://example.test/admin",
  },
  {
    key: "pending",
    label: "待判断（pending）",
    hint: "显式标记需人工裁决的目标；未列入任何区的目标在范围未配置时同样按待判断处理。",
    ariaLabel: "待判断范围规则，每行一条",
    placeholder: "例如：\n*.staging.example.test",
  },
]);

/* 编辑器类按 React.Component 身份缓存一次：宿主页面每次 render 都会新建元素，
   若类身份随之变化，真实 React 会按「不同组件类型」卸载重挂（输入焦点丢失）。
   类身份稳定是 keep-alive/受控输入不丢的前提。 */
let editorClassCache = { base: null, cls: null };

function createEditorClass(React) {
  const ComponentBase =
    React && typeof React.Component === "function"
      ? React.Component
      : class EditorComponentBase {
          constructor(props) {
            this.props = props || {};
          }
        };

  if (editorClassCache.base === ComponentBase && editorClassCache.cls) {
    return editorClassCache.cls;
  }

  const cls = class ScopeEditorBody extends ComponentBase {
    constructor(props) {
      super(props);
      const initial = scopeRulesToText(props.scope);
      this.state = {
        texts: {
          allowText: initial.allowText,
          denyText: initial.denyText,
          pendingText: initial.pendingText,
        },
        parse: parseScopeRulesText(initial),
        saving: false,
        msg: null, // { kind: "ok"|"err", text }
        savedRevision: null,
      };
      this.onZoneChange = this.onZoneChange.bind(this);
      this.onSave = this.onSave.bind(this);
      this.onCancel = this.onCancel.bind(this);
      this.onCloseSaved = this.onCloseSaved.bind(this);
    }

    onZoneChange(key, value) {
      // 事件处理器内同步计算（setState 更新器保持纯函数；宿主通知不放进更新器）。
      const texts = { ...this.state.texts, [`${key}Text`]: value };
      const parse = parseScopeRulesText(texts);
      this.setState({ texts, parse, savedRevision: null });
      // 通知宿主最新解析结果（宿主决定何时采用；本地校验失败时宿主不得提交）。
      if (typeof this.props.onChange === "function") {
        this.props.onChange({ rules: parse.rules, errors: parse.errors, valid: parse.valid });
      }
    }

    async onSave() {
      const { api, projectId } = this.props;
      const parse = this.state.parse;
      if (!parse.valid) {
        this.setState({ msg: { kind: "err", text: "存在格式错误的条目，已本地拦截：请先修正（未发请求）" } });
        return;
      }
      if (typeof api !== "function") {
        this.setState({ msg: { kind: "err", text: "保存失败：当前宿主未提供 API 通道" } });
        return;
      }
      this.setState({ saving: true, msg: null });
      try {
        const res = await api("/sorne/scope-revisions", {
          method: "POST",
          body: JSON.stringify({
            project_id: projectId,
            rules: parse.rules,
            summary: "经范围编辑器更新",
          }),
        });
        const rev = res && res.scope_revision ? res.scope_revision : null;
        const revLabel = rev ? `${rev.id || ""}${rev.revision ? `（第 ${rev.revision} 版）` : ""}` : "";
        this.setState({
          saving: false,
          savedRevision: rev ? rev.id || null : null,
          msg: { kind: "ok", text: `范围版本已保存${revLabel ? `：${revLabel}` : ""}` },
        });
        if (typeof this.props.onSaved === "function") {
          this.props.onSaved({ rules: parse.rules, scope_revision: rev });
        }
      } catch (e) {
        this.setState({
          saving: false,
          msg: { kind: "err", text: `保存范围版本失败：${e && e.message ? e.message : e}` },
        });
      }
    }

    onCancel() {
      if (typeof this.props.onDone === "function") this.props.onDone({ saved: false });
    }

    onCloseSaved() {
      if (typeof this.props.onDone === "function") this.props.onDone({ saved: true });
    }

    render() {
      const { h, projectId, embedded } = this.props;
      const { texts, parse, saving, msg, savedRevision } = this.state;
      const drawerMode = Boolean(projectId) && !embedded;
      const errorTexts = parse.errors.map(
        (e) => `${zoneLabel(e.zone)} 第 ${e.line} 行：${e.message}（原文：${e.text.slice(0, 80)}）`,
      );

      return h(
        "div",
        {
          role: drawerMode ? "dialog" : "group",
          "aria-label": "范围规则编辑器（允许/拒绝/待判断三区）",
          style: {
            border: "1px solid var(--sorne-border)",
            borderRadius: 8,
            background: "var(--sorne-bg-surface)",
            padding: "12px 14px",
            display: "flex",
            flexDirection: "column",
            gap: 10,
          },
        },
        h(
          "div",
          { style: { fontSize: 14, fontWeight: 600, color: "var(--sorne-text-primary)" } },
          "范围规则（允许 / 拒绝 / 待判断，版本化保存）",
        ),
        h(
          "div",
          { style: { fontSize: 13, lineHeight: 1.6, color: "var(--sorne-text-secondary)" } },
          "每行一条规则。语法提示：",
        ),
        h(
          "ul",
          {
            style: {
              margin: 0, paddingLeft: 20, fontSize: 13, lineHeight: 1.7,
              color: "var(--sorne-text-secondary)",
            },
          },
          h("li", null, "主机规则：", h("code", { style: CODE }, "example.test"),
            "；子域通配 ", h("code", { style: CODE }, "*.example.test"),
            "（仅匹配子域，不含主域本身；通配仅适用于主机规则）"),
          h("li", null, "URL 规则：", h("code", { style: CODE }, "https://api.example.test/v1/"),
            "（路径前缀；URL 规则必须精确比对主机）"),
          h("li", null, "路径通配：", h("code", { style: CODE }, "https://api.example.test/v1/*"),
            "（匹配 /v1、/v1/ 及其下任意路径）"),
          h("li", null, "对象规则（JSON 行）：",
            h("code", { style: CODE }, '{"host":"*.example.test","port":8443,"path_prefix":"/api"}')),
          h("li", null, "明确拒绝优先于允许；「待判断」表达需人工裁决，不代表允许"),
        ),
        h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: 10 } },
          ZONE_DEFS.map((z) =>
            h(
              "div",
              { key: z.key },
              h(
                "div",
                { style: { fontSize: 14, fontWeight: 600, color: "var(--sorne-text-primary)", marginBottom: 3 } },
                z.label,
              ),
              h(
                "div",
                { style: { fontSize: 13, color: "var(--sorne-text-secondary)", marginBottom: 4 } },
                z.hint,
              ),
              h("textarea", {
                "aria-label": z.ariaLabel,
                value: texts[`${z.key}Text`],
                placeholder: z.placeholder,
                onChange: (e) => this.onZoneChange(z.key, e && e.target ? e.target.value : ""),
                rows: 3,
                style: {
                  width: "100%", boxSizing: "border-box", fontSize: 14, lineHeight: 1.55,
                  padding: "6px 8px", borderRadius: 6,
                  border: "1px solid var(--sorne-border-strong)",
                  background: "var(--sorne-bg-canvas)", color: "var(--sorne-text-primary)",
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                  resize: "vertical",
                },
              }),
            ),
          ),
        ),
        errorTexts.length
          ? h(
              "div",
              { role: "alert", style: { fontSize: 13.5, lineHeight: 1.6, color: "var(--sorne-status-unknown-fg)" } },
              errorTexts.map((t, i) => h("div", { key: i }, t)),
            )
          : null,
        msg
          ? h(
              "div",
              {
                role: msg.kind === "err" ? "alert" : "status",
                style: {
                  fontSize: 13.5, lineHeight: 1.6,
                  color: msg.kind === "err" ? "var(--sorne-status-unknown-fg)" : "var(--sorne-status-ok-fg)",
                },
              },
              msg.text,
            )
          : null,
        h(
          "div",
          { style: { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" } },
          projectId
            ? h("button", {
                type: "button",
                "aria-label": "保存范围版本",
                disabled: saving,
                onClick: this.onSave,
                style: btnStyle(saving),
              }, saving ? "保存中…" : "保存范围版本")
            : null,
          drawerMode
            ? h("button", {
                type: "button",
                "aria-label": "关闭范围编辑器",
                onClick: savedRevision ? this.onCloseSaved : this.onCancel,
                style: btnStyle(false),
              }, savedRevision ? "关闭" : "取消")
            : null,
          h(
            "span",
            { style: { fontSize: 13, color: "var(--sorne-text-muted)" } },
            parse.valid
              ? `当前解析：允许 ${parse.rules.allow.length} 条 · 拒绝 ${parse.rules.deny.length} 条 · 待判断 ${parse.rules.pending.length} 条`
              : "存在错误条目，保存被本地拦截（未提供 ≠ 不存在：错误条目不会被静默丢弃）",
          ),
        ),
      );
    }
  };

  editorClassCache = { base: ComponentBase, cls };
  return cls;
}

const CODE = {
  padding: "0 4px", borderRadius: 4,
  background: "var(--sorne-bg-subtle)",
  color: "var(--sorne-text-primary)",
  fontSize: 12.5,
};

function zoneLabel(key) {
  const found = ZONE_DEFS.find((z) => z.key === key);
  return found ? found.label : key;
}

function btnStyle(disabled) {
  return {
    fontSize: 13, padding: "5px 12px", borderRadius: 6, cursor: disabled ? "default" : "pointer",
    border: "1px solid var(--sorne-border-strong)",
    background: "var(--sorne-bg-surface)", color: "var(--sorne-text-primary)",
    fontFamily: "inherit", lineHeight: 1.55,
    opacity: disabled ? 0.55 : 1,
  };
}

/* ── 导出：内嵌元素与抽屉式打开（§2.7） ──────────────────────────── */

/**
 * 创建编辑器元素（内嵌模式）。scope 为 {allow,deny,pending} 形体（或 null）。
 * embedded=true 时不渲染抽屉关闭按钮；projectId 提供时仍可「保存范围版本」。
 */
export function createScopeEditorElement({ React, h, api, scope, projectId, onChange, onSaved, onDone, embedded } = {}) {
  if (!React || typeof React.Component !== "function") {
    throw new Error("createScopeEditorElement 需要 React（含 Component）；请从页面 ctx 传入");
  }
  if (typeof h !== "function") {
    throw new Error("createScopeEditorElement 需要 h（React.createElement）");
  }
  const EditorClass = createEditorClass(React);
  return h(EditorClass, { React, h, api, scope, projectId, onChange, onSaved, onDone, embedded: Boolean(embedded) });
}

/**
 * §2.7 冻结签名（键为 { project, scope, onSaved }；渲染依赖见文件头说明）。
 * - project 存在：保存调 POST /sorne/scope-revisions（#8），成功后 onSaved({rules, scope_revision})；
 * - project 缺省：纯收集模式，onSaved({rules})；
 * - mount(element)/mount(null) 由宿主页面渲染/关闭抽屉；缺 mount 直接抛错（开发期显式失败）。
 */
export function openScopeRulesEditor({ project, scope, onSaved, React, h, api, mount } = {}) {
  if (typeof mount !== "function") {
    throw new Error(
      "openScopeRulesEditor 需要 mount(element) 渲染挂点（宿主页面经 setState 把抽屉元素挂进自身树；见模块头注释）",
    );
  }
  if (!React || typeof React.Component !== "function" || typeof h !== "function") {
    throw new Error("openScopeRulesEditor 需要 React/h（从页面 ctx 传入）");
  }
  const projectId = project && typeof project === "object" ? project.id || project.project_id || null : null;
  const drawerEl = createScopeEditorElement({
    React,
    h,
    api,
    scope,
    projectId,
    onSaved: (payload) => {
      if (typeof onSaved === "function") onSaved(payload);
    },
    onDone: () => mount(null),
  });
  mount(drawerEl);
}
