/**
 * Sorne —— 双主题设计系统 token（lib/ui/theme.mjs；M1 独占）。
 *
 * 蓝图 §2.1（冻结契约）。修复评审 §1（深色宿主对比度 1.18:1）：
 *   - 全部颜色以 token 声明，本文件是全站唯一允许出现字面颜色值的文件
 *     （P0-1② 字面颜色闸扫描面：client.js、test-ui-server.mjs、lib/ui 目录下
 *     全部 .mjs 均不得含 `#hex` / `rgb()` 字面值；唯一豁免本文件）；
 *   - 注入方式（冻结）：外壳挂载时注入一份 <style>，定义
 *     html[data-sorne-theme="light"]{…} 与 html[data-sorne-theme="dark"]{…}
 *     两套 CSS 自定义属性，并注入 html{color-scheme:light dark}；
 *   - 无显式选择时随 prefers-color-scheme；顶栏三态切换（浅/深/跟随系统），
 *     选择存 localStorage（非授权类输入，允许）；
 *   - 禁止任何页面引用宿主 --dsw-alias-* 变量（评审 §1 根因：宿主变量为空
 *     回退浅色值）；
 *   - 对比度契约由 CONTRAST_PAIRS 声明，tools/contrast-check.mjs 与
 *     test/ui-design.test.mjs 以本文件为单一真值源确定性计算（测试是最终权威）。
 *
 * 排版基线（冻结）：正文 ≥ 14px、行高 ≥ 1.55、导航与按钮 ≥ 13px；
 * 可访问性基线：:focus-visible 焦点环永不置 none（评审 §5）。
 *
 * 本文件不得 import 任何包或 Node 内置模块；浏览器 API（document/localStorage/
 * matchMedia）全部带 typeof 守卫，Node 测试可直接 import 读取 TOKENS。
 */

/* ── token 表（结构与阈值为冻结契约；hex 为初版实现值，可微调，
      但必须通过 CONTRAST_PAIRS 的确定性对比度检查） ─────────────────── */

/**
 * @type {{ name: string, light: string, dark: string, role: string }[]}
 * role 仅作文档说明。命名沿用蓝图 §2.1；状态色拆为 -fg/-bg 两个变量
 * （蓝图以「前景/底」成对声明，本实现落成对变量）。
 */
export const TOKENS = Object.freeze([
  { name: "--sorne-bg-canvas", light: "#f6f7f9", dark: "#0f1520", role: "页面底" },
  { name: "--sorne-bg-surface", light: "#ffffff", dark: "#171f2e", role: "卡片/面板" },
  { name: "--sorne-bg-raised", light: "#ffffff", dark: "#1d2637", role: "弹层/详情栏" },
  { name: "--sorne-bg-subtle", light: "#eef0f3", dark: "#222c40", role: "分隔区/表头" },
  { name: "--sorne-text-primary", light: "#17202e", dark: "#e8edf6", role: "正文/标题（≥7:1）" },
  { name: "--sorne-text-secondary", light: "#46536b", dark: "#b6c1d4", role: "次要正文（≥4.5:1）" },
  { name: "--sorne-text-muted", light: "#5d6a80", dark: "#93a1b8", role: "辅助信息（≥4.5:1）" },
  { name: "--sorne-border", light: "#d7dce3", dark: "#2c3850", role: "装饰边框" },
  { name: "--sorne-border-strong", light: "#7d8899", dark: "#647491", role: "控件边框（≥3:1，WCAG 1.4.11）" },
  { name: "--sorne-brand", light: "#1d4ed8", dark: "#4c93f9", role: "主按钮底/激活导航（作前景时对 surface ≥4.5:1）" },
  { name: "--sorne-on-brand", light: "#ffffff", dark: "#0a101c", role: "主按钮文字（对 brand ≥4.5:1）" },
  { name: "--sorne-focus-ring", light: "#1d4ed8", dark: "#93c5fd", role: "焦点环（对相邻底 ≥3:1；永不置 none）" },
  { name: "--sorne-status-suspected-fg", light: "#92400e", dark: "#fcd34d", role: "疑似（琥珀）前景" },
  { name: "--sorne-status-suspected-bg", light: "#fef3c7", dark: "#3a2c08", role: "疑似底" },
  { name: "--sorne-status-confirmed-fg", light: "#b91c1c", dark: "#f87171", role: "已确认（红）前景" },
  { name: "--sorne-status-confirmed-bg", light: "#fee2e2", dark: "#3d1414", role: "已确认底" },
  { name: "--sorne-status-falsified-fg", light: "#374151", dark: "#cbd5e1", role: "已证伪（灰）前景" },
  { name: "--sorne-status-falsified-bg", light: "#e5e7eb", dark: "#1f2937", role: "已证伪底" },
  { name: "--sorne-status-review-fg", light: "#1d4ed8", dark: "#93c5fd", role: "待复核（蓝点）前景" },
  { name: "--sorne-status-review-bg", light: "#dbeafe", dark: "#14243f", role: "待复核底" },
  { name: "--sorne-status-unknown-fg", light: "#b91c1c", dark: "#f87171", role: "unknown/异常（红点）前景" },
  { name: "--sorne-status-unknown-bg", light: "#fee2e2", dark: "#3d1414", role: "unknown底" },
  { name: "--sorne-status-ok-fg", light: "#166534", dark: "#86efac", role: "正常/运行中前景" },
  { name: "--sorne-status-ok-bg", light: "#dcfce7", dark: "#0d2b16", role: "正常底" },
]);

/**
 * 对比度契约（冻结；测试是最终权威）。
 * @type {{ fg: string, bg: string, min: number, note: string }[]}
 * fg/bg 均为 TOKENS 中的 token 名；min 为 WCAG 对比度下限。
 * 文本对 canvas/surface/raised/subtle 全部铺开（评审 §1：导航、按钮、正文、
 * 次要说明在四类底上都必须可读）。
 */
export const CONTRAST_PAIRS = Object.freeze([
  { fg: "--sorne-text-primary", bg: "--sorne-bg-canvas", min: 7, note: "正文/标题对页面底（AA AAA 目标）" },
  { fg: "--sorne-text-primary", bg: "--sorne-bg-surface", min: 7, note: "正文/标题对卡片" },
  { fg: "--sorne-text-primary", bg: "--sorne-bg-raised", min: 7, note: "正文/标题对弹层" },
  { fg: "--sorne-text-primary", bg: "--sorne-bg-subtle", min: 7, note: "正文/标题对表头/分隔区" },
  { fg: "--sorne-text-secondary", bg: "--sorne-bg-canvas", min: 4.5, note: "次要正文对页面底" },
  { fg: "--sorne-text-secondary", bg: "--sorne-bg-surface", min: 4.5, note: "次要正文对卡片" },
  { fg: "--sorne-text-secondary", bg: "--sorne-bg-raised", min: 4.5, note: "次要正文对弹层" },
  { fg: "--sorne-text-secondary", bg: "--sorne-bg-subtle", min: 4.5, note: "次要正文对分隔区" },
  { fg: "--sorne-text-muted", bg: "--sorne-bg-canvas", min: 4.5, note: "辅助信息对页面底" },
  { fg: "--sorne-text-muted", bg: "--sorne-bg-surface", min: 4.5, note: "辅助信息对卡片" },
  { fg: "--sorne-text-muted", bg: "--sorne-bg-raised", min: 4.5, note: "辅助信息对弹层" },
  { fg: "--sorne-text-muted", bg: "--sorne-bg-subtle", min: 4.5, note: "辅助信息对分隔区" },
  { fg: "--sorne-brand", bg: "--sorne-bg-canvas", min: 4.5, note: "激活导航文字对页面底" },
  { fg: "--sorne-brand", bg: "--sorne-bg-surface", min: 4.5, note: "激活导航文字对卡片" },
  { fg: "--sorne-on-brand", bg: "--sorne-brand", min: 4.5, note: "主按钮文字对主按钮底" },
  { fg: "--sorne-focus-ring", bg: "--sorne-bg-canvas", min: 3, note: "焦点环对页面底（非文本，WCAG 1.4.11）" },
  { fg: "--sorne-focus-ring", bg: "--sorne-bg-surface", min: 3, note: "焦点环对卡片" },
  { fg: "--sorne-border-strong", bg: "--sorne-bg-canvas", min: 3, note: "控件边框对页面底" },
  { fg: "--sorne-border-strong", bg: "--sorne-bg-surface", min: 3, note: "控件边框对卡片" },
  { fg: "--sorne-status-suspected-fg", bg: "--sorne-status-suspected-bg", min: 4.5, note: "疑似徽章" },
  { fg: "--sorne-status-confirmed-fg", bg: "--sorne-status-confirmed-bg", min: 4.5, note: "已确认徽章" },
  { fg: "--sorne-status-falsified-fg", bg: "--sorne-status-falsified-bg", min: 4.5, note: "已证伪徽章" },
  { fg: "--sorne-status-review-fg", bg: "--sorne-status-review-bg", min: 4.5, note: "待复核徽章" },
  { fg: "--sorne-status-unknown-fg", bg: "--sorne-status-unknown-bg", min: 4.5, note: "unknown/异常徽章" },
  { fg: "--sorne-status-ok-fg", bg: "--sorne-status-ok-bg", min: 4.5, note: "正常/运行中徽章" },
]);

/* ── WCAG 相对亮度与对比度（确定性公式；tools/contrast-check.mjs 与
      test/ui-design.test.mjs 共用本实现，单一真值源） ─────────────────── */

function srgbChannelToLinear(c) {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/** "#rrggbb" → WCAG 相对亮度。 */
export function relativeLuminance(hex) {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) throw new Error(`非法颜色值（须 #rrggbb）：${hex}`);
  const n = parseInt(m[1], 16);
  return (
    0.2126 * srgbChannelToLinear((n >> 16) & 0xff) +
    0.7152 * srgbChannelToLinear((n >> 8) & 0xff) +
    0.0722 * srgbChannelToLinear(n & 0xff)
  );
}

/** WCAG 对比度（1..21）。 */
export function contrastRatio(fgHex, bgHex) {
  const l1 = relativeLuminance(fgHex);
  const l2 = relativeLuminance(bgHex);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/** 取 token 在指定主题下的 hex。theme = "light" | "dark"。 */
export function tokenHex(name, theme) {
  const t = TOKENS.find((x) => x.name === name);
  if (!t) throw new Error(`未声明 token：${name}`);
  return theme === "dark" ? t.dark : t.light;
}

/**
 * 计算全部对比度契约的实测值。
 * @returns {{ theme: string, fg: string, bg: string, min: number, ratio: number,
 *             pass: boolean, note: string }[]} 任一 fail 即整闸不过。
 */
export function evaluateContrast(theme) {
  return CONTRAST_PAIRS.map((p) => {
    const ratio = contrastRatio(tokenHex(p.fg, theme), tokenHex(p.bg, theme));
    return {
      theme,
      fg: p.fg,
      bg: p.bg,
      min: p.min,
      ratio: Math.round(ratio * 100) / 100,
      pass: ratio >= p.min,
      note: p.note,
    };
  });
}

/* ── CSS 生成与注入 ────────────────────────────────────────────────── */

export const THEME_STYLE_ID = "sorne-theme-tokens";

/** 排版与焦点环基线（冻结）：正文 ≥14px 由组件侧 font-size 落实；
    此处固化 :focus-visible 焦点环（永不置 none，评审 §5）。 */
export const BASE_CSS = `
*, *::before, *::after { box-sizing: border-box; }
button, [role="button"], a, input, select, textarea, [tabindex]:not([tabindex="-1"]) {
  font-family: inherit;
}
button:focus-visible, [role="button"]:focus-visible, a:focus-visible,
input:focus-visible, select:focus-visible, textarea:focus-visible,
[tabindex]:not([tabindex="-1"]):focus-visible {
  outline: 2px solid var(--sorne-focus-ring);
  outline-offset: 1px;
  border-radius: 4px;
}
.sorne-sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}
`;

/** 由 TOKENS 生成两套主题 CSS（单一真值源；手写 CSS 不再存在）。 */
export function buildThemeCss() {
  const varLines = (key) =>
    TOKENS.map((t) => `  ${t.name}: ${t[key]};`).join("\n");
  return (
    `html { color-scheme: light dark; }\n` +
    `html[data-sorne-theme="light"] {\n${varLines("light")}\n}\n` +
    `html[data-sorne-theme="dark"] {\n${varLines("dark")}\n}\n` +
    BASE_CSS
  );
}

/** 幂等注入 <style id="sorne-theme-tokens">（浏览器）；Node 无 document 时安全跳过。 */
export function ensureThemeStyle(doc) {
  const d = doc || (typeof document !== "undefined" ? document : null);
  if (!d || !d.head || typeof d.createElement !== "function") return false;
  if (d.getElementById(THEME_STYLE_ID)) return true;
  const style = d.createElement("style");
  style.id = THEME_STYLE_ID;
  style.textContent = buildThemeCss();
  d.head.appendChild(style);
  return true;
}

/* ── 主题句柄（三态：light / dark / system；跟随宿主深浅色） ─────────── */

export const THEME_STORAGE_KEY = "sorne-theme";
export const THEME_MODES = Object.freeze(["light", "dark", "system"]);

/** 读取系统偏好（Node/无 matchMedia → light，调用方不得据此外推宿主主题）。 */
export function systemPrefersDark(win) {
  const w = win || (typeof window !== "undefined" ? window : null);
  if (!w || typeof w.matchMedia !== "function") return false;
  try {
    return Boolean(w.matchMedia("(prefers-color-scheme: dark)").matches);
  } catch {
    return false;
  }
}

export function resolveThemeMode(mode, win) {
  if (mode === "light" || mode === "dark") return mode;
  return systemPrefersDark(win) ? "dark" : "light";
}

/**
 * 创建主题句柄（外壳唯一持有；经 ctx.theme 提供给页面，页面不得自取
 * localStorage——授权类之外的持久化统一收口在外壳）。
 *
 * handle = {
 *   mode: () => "light"|"dark"|"system"   // 用户选择（未选=system）
 *   effective: () => "light"|"dark"       // 实际生效主题
 *   set(mode)                             // 三态切换；持久化 localStorage
 *   onChange(fn) => unsubscribe           // 生效主题变化（含系统偏好变化）
 *   TOKENS, CONTRAST_PAIRS                // 只读引用（页面按需）
 * }
 */
export function createThemeHandle({ win, storage, initialMode } = {}) {
  const w = win || (typeof window !== "undefined" ? window : null);
  const store = storage || (w && w.localStorage) || null;
  const listeners = new Set();
  let mode = THEME_MODES.includes(initialMode) ? initialMode : "system";
  try {
    const saved = store && typeof store.getItem === "function" ? store.getItem(THEME_STORAGE_KEY) : null;
    if (THEME_MODES.includes(saved)) mode = saved;
  } catch { /* localStorage 不可用（隐私模式等）→ 保持内存态，不致命 */ }

  let media = null;
  if (w && typeof w.matchMedia === "function") {
    try {
      media = w.matchMedia("(prefers-color-scheme: dark)");
      if (media && typeof media.addEventListener === "function") {
        media.addEventListener("change", () => {
          if (mode === "system") notify();
        });
      }
    } catch { /* 无 matchMedia → 不跟随系统变化 */ }
  }

  function applyToDocument() {
    const d = typeof document !== "undefined" ? document : null;
    if (!d || !d.documentElement) return;
    d.documentElement.setAttribute("data-sorne-theme", resolveThemeMode(mode, w));
  }

  function notify() {
    applyToDocument();
    for (const fn of Array.from(listeners)) {
      try { fn(effective()); } catch { /* 单个监听者异常不拖垮其他 */ }
    }
  }

  function effective() {
    return resolveThemeMode(mode, w);
  }

  const handle = {
    mode: () => mode,
    effective,
    set(next) {
      if (!THEME_MODES.includes(next)) {
        throw new Error(`未知主题模式：${next}（允许 ${THEME_MODES.join("/")}）`);
      }
      mode = next;
      try {
        if (store && typeof store.setItem === "function") store.setItem(THEME_STORAGE_KEY, next);
      } catch { /* 持久化失败不致命 */ }
      notify();
    },
    onChange(fn) {
      if (typeof fn !== "function") return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    TOKENS,
    CONTRAST_PAIRS,
  };
  // 初始应用：句柄创建即把生效主题写到 <html data-sorne-theme>，保证首帧
  // CSS 变量可用（真实浏览器实测发现的缺陷：仅 set/notify 才写属性会漏首帧）。
  applyToDocument();
  return handle;
}
