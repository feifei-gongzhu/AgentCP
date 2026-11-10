/**
 * M1 —— 设计系统测试（lib/ui/theme|render|record-ids|router + client.js 闸）。
 *
 * 覆盖（BLUEPRINT-UI §f P0-1①② / P0-2①② / §2.1 / §2.2 / §2.4）：
 *   - token 对比度：对 theme.mjs 声明的每对前景/背景以 WCAG 相对亮度公式
 *     确定性计算（浅/深两主题），任一对低于其声明下限即失败——测试是最终权威；
 *   - 字面颜色闸：全部 UI 文件（client.js、test-ui-server.mjs、lib/ui 目录全部
 *     .mjs、lib/ui/scope/editor.mjs 若存在）grep 字面颜色与宿主 --dsw-alias 变量
 *     必须 0 命中，唯一豁免 lib/ui/theme.mjs；
 *   - 编号解析：两族格式 × 前缀全用例；A-PRJ-0002-0002 必须整体解析为资产，
 *     绝不解析出 PRJ-0002（评审 §4a 的静默错记录交互）；事件编号不属 /records；
 *   - 全站编号解析唯一实现：页面模块零分叉（过渡期允许 6 份已知旧副本，
 *     随 M4/M5/M6 删除/重写归零，终验全站 0 命中）；
 *   - 渲染器契约：formatTime / formatHash / RecordIdChip / FoldableObject /
 *     StatusBadge / FieldRow / DataTable / EmptyState / LABELS / VOCAB；
 *   - 语义纪律词表冻结原文：confirmed（限指定条件）/ insufficient 不伪装成
 *     已排除 / falsified 不等于历史上不存在 / unknown 工具调用警示 /
 *     delivered ≠ handled（received ≠ 已答复）；
 *   - LABELS 覆盖闸：端点样例响应 fixtures 逐字段断言中文标签（显式豁免清单）；
 *   - theme 句柄与 router 纯函数单测。
 *
 * 并行安全：本文件不占端口、不建临时目录、不动 SORNE_DATA_DIR（全为进程内
 * 纯函数与文件扫描；唯一直接子进程是 tools/contrast-check.mjs，同步收尾）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, existsSync, readFileSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  TOKENS,
  CONTRAST_PAIRS,
  THEME_MODES,
  THEME_STORAGE_KEY,
  buildThemeCss,
  evaluateContrast,
  contrastRatio,
  relativeLuminance,
  tokenHex,
  createThemeHandle,
  ensureThemeStyle,
  resolveThemeMode,
  systemPrefersDark,
} from "../lib/ui/theme.mjs";
import {
  parseRecordId,
  isEventId,
  hasProjectSegment,
  EVENT_ID_RE,
  RECORD_ID_RE,
  PREFIX_TABLES,
  PREFIX_LABELS,
} from "../lib/ui/record-ids.mjs";
import {
  bindRenderers,
  LABELS,
  VOCAB,
  RUN_STATUS,
  formatTime,
  formatHash,
  RecordIdChip,
  FoldableObject,
  StatusBadge,
  FieldRow,
  DataTable,
  EmptyState,
} from "../lib/ui/render.mjs";
import {
  parseHash,
  pageBaseHash,
  recordHash,
  createRouter,
  WORKSPACE_PAGES,
  GUIDE_PAGES,
  DIAGNOSTICS_PAGE,
  RECORDS_PAGE,
  KNOWN_PAGES,
  PAGE_LABELS,
  SLOT_OWNERS,
} from "../lib/ui/router.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

/* ── 渲染注入（与外壳相同的绑定方式：createElement + Component 基类） ── */

function miniH(type, props, ...children) {
  return {
    __elem: true,
    type,
    props: props || {},
    children: children
      .flat(Infinity)
      .filter((c) => c !== null && c !== undefined && c !== true && c !== false),
  };
}
class MiniComponent {
  constructor(props) { this.props = props || {}; }
}
bindRenderers({ createElement: miniH, Component: MiniComponent });

function nodeText(node) {
  if (node === null || node === undefined || node === false || node === true) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (node.__elem) return nodeText(node.children);
  return "";
}

/**
 * hydration 树：把元素树实例化为统一节点 { kind, type, props, children, inst? }。
 * 类组件节点持有实例；setState/forceUpdate 原位重渲染（children 就地替换）。
 */
function toChildren(rendered) {
  const arr = rendered === null || rendered === undefined
    ? []
    : (Array.isArray(rendered) ? rendered : [rendered]);
  return arr.map(hydrate).filter(Boolean).flat(Infinity);
}

function hydrate(el) {
  if (el === null || el === undefined || typeof el === "boolean") return null;
  if (typeof el === "string" || typeof el === "number") return { kind: "text", text: String(el), children: [] };
  if (Array.isArray(el)) return { kind: "fragment", children: toChildren(el), type: null, props: {} };
  if (!el.__elem) return { kind: "text", text: String(el), children: [] };
  if (typeof el.type === "function" && el.type.prototype && typeof el.type.prototype.render === "function") {
    const inst = new el.type(el.props);
    if (!inst.state) inst.state = {};
    const node = { kind: "component", type: el.type, props: el.props, inst, children: [] };
    const rerender = () => {
      node.props = inst.props;
      node.children = toChildren(inst.render());
    };
    inst.setState = (patch) => {
      inst.state = { ...inst.state, ...(typeof patch === "function" ? patch(inst.state) : patch) };
      rerender();
    };
    inst.forceUpdate = rerender;
    rerender();
    return node;
  }
  if (typeof el.type === "function") {
    return hydrate(el.type(el.props));
  }
  return { kind: "host", type: el.type, props: el.props, children: toChildren(el.children) };
}

function treeText(node) {
  if (!node) return "";
  if (node.kind === "text") return node.text;
  return (node.children || []).map(treeText).join("");
}

function findNodes(node, pred, out = []) {
  if (!node) return out;
  if (Array.isArray(node)) { node.forEach((n) => findNodes(n, pred, out)); return out; }
  if (pred(node)) out.push(node);
  for (const c of node.children || []) findNodes(c, pred, out);
  return out;
}

/* ══════════════════════ 1. token 对比度（P0-1①） ═══════════════════ */

test("深色主题 token 对比度全部达标（正文/导航/按钮/状态徽章 ≥4.5:1，控件边框 ≥3:1，正文/标题目标 ≥7:1）", () => {
  const results = evaluateContrast("dark");
  assert.ok(results.length >= 20, `对比度契约对数应 ≥20，实际 ${results.length}`);
  const failures = results.filter((r) => !r.pass);
  assert.deepEqual(
    failures,
    [],
    `深色主题对比度不达标项：${failures.map((f) => `${f.fg}/${f.bg}=${f.ratio}（要求 ≥${f.min}）`).join("；")}`,
  );
  /* 正文/标题目标 ≥7:1（蓝图 §2.1 token 表硬目标）。 */
  for (const bg of ["--sorne-bg-canvas", "--sorne-bg-surface", "--sorne-bg-raised", "--sorne-bg-subtle"]) {
    const r = results.find((x) => x.fg === "--sorne-text-primary" && x.bg === bg);
    assert.ok(r && r.ratio >= 7, `深色正文对 ${bg} 应 ≥7:1，实测 ${r && r.ratio}`);
  }
});

test("浅色主题 token 对比度全部达标（同契约逐对确定性计算）", () => {
  const results = evaluateContrast("light");
  const failures = results.filter((r) => !r.pass);
  assert.deepEqual(
    failures,
    [],
    `浅色主题对比度不达标项：${failures.map((f) => `${f.fg}/${f.bg}=${f.ratio}（要求 ≥${f.min}）`).join("；")}`,
  );
});

test("对比度公式与契约结构健全（WCAG 参照值；契约覆盖蓝图 §2.1 全部 token 组）", () => {
  assert.equal(Math.round(contrastRatio("#000000", "#ffffff") * 100) / 100, 21);
  assert.equal(contrastRatio("#ffffff", "#ffffff"), 1);
  assert.ok(relativeLuminance("#ffffff") > 0.99 && relativeLuminance("#000000") === 0);
  assert.throws(() => relativeLuminance("not-a-color"), /非法颜色值/);
  assert.throws(() => tokenHex("--sorne-not-exists", "light"), /未声明 token/);
  assert.equal(tokenHex("--sorne-brand", "dark"), TOKENS.find((t) => t.name === "--sorne-brand").dark);

  const fgTokens = new Set(CONTRAST_PAIRS.map((p) => p.fg));
  for (const required of [
    "--sorne-text-primary", "--sorne-text-secondary", "--sorne-text-muted",
    "--sorne-on-brand", "--sorne-focus-ring", "--sorne-border-strong",
    "--sorne-status-suspected-fg", "--sorne-status-confirmed-fg", "--sorne-status-falsified-fg",
    "--sorne-status-review-fg", "--sorne-status-unknown-fg", "--sorne-status-ok-fg",
  ]) {
    assert.ok(fgTokens.has(required), `对比度契约缺少前景 token：${required}`);
  }
  assert.equal(TOKENS.length >= 24, true, "token 数量应 ≥24（蓝图 §2.1 表全覆盖）");
  for (const t of TOKENS) {
    assert.match(t.light, /^#[0-9a-fA-F]{6}$/, `${t.name} 浅色值须为 #rrggbb`);
    assert.match(t.dark, /^#[0-9a-fA-F]{6}$/, `${t.name} 深色值须为 #rrggbb`);
  }
});

test("tools/contrast-check.mjs 确定性脚本通过（exit 0）且输出逐对比率", () => {
  const r = spawnSync(process.execPath, [join(ROOT, "tools", "contrast-check.mjs")], {
    encoding: "utf8",
    cwd: ROOT,
  });
  assert.equal(r.status, 0, `对比度脚本应 exit 0，实际 ${r.status}\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /对比度检查通过/);
  assert.match(r.stdout, /--sorne-text-primary/);
  const lightBlock = r.stdout.indexOf("浅色主题");
  const darkBlock = r.stdout.indexOf("深色主题");
  assert.ok(lightBlock >= 0 && darkBlock > lightBlock, "脚本应分别输出浅色与深色两段结果");
});

/* ══════════════════════ 2. 字面颜色闸（P0-1②） ═════════════════════ */

test("UI 文件无字面颜色值、无宿主变量引用（P0-1② 永久闸；唯一豁免 lib/ui/theme.mjs）", () => {
  const COLOR_RE = /#[0-9a-fA-F]{3,8}\b|rgba?\(/;
  /* 宿主变量「引用」按实际使用形态判定（var(--dsw-alias-…)/裸变量名），
     注释中提及禁令本身不算引用。 */
  const DSW_RE = /var\(--dsw-alias|--dsw-alias-[a-z]/;

  const files = [join(ROOT, "client.js"), join(ROOT, "test-ui-server.mjs")];
  (function collect(dir) {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) { collect(full); continue; }
      if (name.endsWith(".mjs")) files.push(full);
    }
  })(join(ROOT, "lib", "ui"));

  /* 过渡期规则：旧页文件（M4 删除 / M3/M5/M6 重写）在其尚含宿主变量标记
     （--dsw-alias）时跳过——它们是本次重构要消灭的对象，文件所有权不在 M1；
     文件被删除后自然退出扫描面，被重写后（不再含宿主变量标记）自动重新
     入闸。终验时旧文件全部消亡，闸覆盖全站（BLUEPRINT-UI §9）。 */
  const LEGACY_MARK = /--dsw-alias/;
  const skipped = [];

  for (const file of files) {
    const rel = relative(ROOT, file);
    const src = readFileSync(file, "utf8");
    if (rel === join("lib", "ui", "theme.mjs")) {
      // 唯一豁免：token 真值源。但仍不得引用宿主变量。
      assert.doesNotMatch(src, DSW_RE, `${rel} 不得引用宿主 --dsw-alias 变量`);
      continue;
    }
    if (rel.startsWith(join("lib", "ui", "pages")) && LEGACY_MARK.test(src)) {
      skipped.push(rel);
      continue;
    }
    const hits = src.split("\n").map((line, i) => ({ line, no: i + 1 }))
      .filter((x) => COLOR_RE.test(x.line));
    assert.deepEqual(
      hits.map((x) => `${rel}:${x.no}`),
      [],
      `${rel} 出现字面颜色值（P0-1② 闸）：\n${hits.map((x) => `  ${x.no}: ${x.line.trim()}`).join("\n")}`,
    );
    assert.doesNotMatch(src, DSW_RE, `${rel} 不得引用宿主 --dsw-alias 变量（评审 §1 根因）`);
  }
  assert.ok(files.length >= 6, `闸扫描面应覆盖全部 UI 文件，实际仅 ${files.length} 个`);
});

/* ══════════════════════ 3. 编号解析（P0-2①） ═══════════════════════ */

test("编号解析：A-PRJ-0002-0002 解析为资产（assets），绝不解析出 PRJ-0002（整体匹配）", () => {
  const parsed = parseRecordId("A-PRJ-0002-0002");
  assert.ok(parsed, "项目段编号必须整体解析成功");
  assert.equal(parsed.id, "A-PRJ-0002-0002");
  assert.equal(parsed.prefix, "A");
  assert.equal(parsed.projectSeq, "0002");
  assert.equal(parsed.seq, "0002");
  assert.equal(parsed.table, "assets");
  assert.equal(parsed.kindLabel, "资产");
  assert.notEqual(parsed.prefix, "PRJ", "不得把中段 PRJ 当作前缀（旧实现的静默错记录）");
  assert.equal(hasProjectSegment("A-PRJ-0002-0002"), true);
  assert.equal(hasProjectSegment("A-0002"), false);
});

test("编号解析：两族格式 × 全部前缀用例表（全局族与项目段族）", () => {
  const globalFamily = {
    A: "assets", O: "observations", H: "hypotheses", V: "vulnerabilities",
    F: "facts", I: "intents", G: "goals", R: "relations", T: "endpoint_templates",
    B: "blobs", EM: "evidence_memberships", ATT: "attempts", SNAP: "snapshots",
    SR: "scope_revisions", TC: "tool_calls", WR: "worker_reports", PRJ: "projects",
  };
  for (const [prefix, table] of Object.entries(globalFamily)) {
    const id = `${prefix}-0007`;
    const parsed = parseRecordId(id);
    assert.ok(parsed, `${id} 应解析成功`);
    assert.equal(parsed.table, table, `${id} 应定位到 ${table}`);
    assert.equal(parsed.projectSeq, null, `${id} 不应带项目段`);
  }
  const projectFamily = {
    A: "assets", I: "intents", WR: "worker_reports", MSG: "messages",
    VJ: "verification_jobs", VR: "verification_results", OD: "orchestration_decisions",
    OA: "orchestration_actions", PR: "plan_runs", CG: "candidate_groups",
    RES: "resources", SUBS: "subscriptions", CP: "checkpoints", ASM: "attempts",
  };
  for (const [prefix, table] of Object.entries(projectFamily)) {
    const id = `${prefix}-PRJ-0002-0042`;
    const parsed = parseRecordId(id);
    assert.ok(parsed, `${id} 应解析成功`);
    assert.equal(parsed.table, table, `${id} 应定位到 ${table}`);
    assert.equal(parsed.projectSeq, "0002", `${id} 项目段应为 0002`);
    assert.equal(parsed.seq, "0042");
  }
  /* 客户端前缀表与标签表一一对应（chip 悬停提示用；定位以服务端为准）。 */
  assert.deepEqual(Object.keys(PREFIX_LABELS).sort(), Object.keys(PREFIX_TABLES).sort());
});

test("编号解析：事件编号与非法形态全部拒绝（降级，不猜测）", () => {
  assert.equal(isEventId("evt-PRJ-0002-3-1"), true);
  assert.equal(isEventId("EVT-PRJ-0002-3-1"), true);
  assert.equal(EVENT_ID_RE.test("evt-1"), true);
  assert.equal(parseRecordId("evt-PRJ-0002-3-1"), null, "事件编号不属 /records");
  assert.equal(parseRecordId("EVT-PRJ-0002-3-1"), null);
  for (const bad of [
    "", "   ", "garbage", "a-0002", "A-0002x", "A_0002", "-0002", "A-",
    "A-PRJ-0002", "PRJ-0002-0002", "A--0002", "A-0002-", "A-00000001-0002",
    "A-00000000001", "123", null, undefined, 42, {}, [],
  ]) {
    assert.equal(parseRecordId(bad), null, `${JSON.stringify(bad)} 应解析失败（返回 null）`);
  }
  assert.equal(parseRecordId("  A-0002  ").id, "A-0002", "首尾空白容忍");
  assert.equal(RECORD_ID_RE.test("WR-PRJ-0002-0003"), true);
  /* 前缀长度上限 6（正则 {0,5}）："SNAPSH-0002" 结构可解析但前缀未登记
     （table=null）——chip 仍可点击、定位以服务端为准，不猜测、不给错记录。 */
  const overlong = parseRecordId("SNAPSH-0002");
  assert.ok(overlong, "6 位前缀结构上可解析（冻结正则形状）");
  assert.equal(overlong.table, null, "未登记前缀 table=null（降级提示，不猜测）");
  assert.equal(overlong.kindLabel, null);
  /* 7 位前缀彻底拒绝。 */
  assert.equal(parseRecordId("SNAPSHO-0002"), null);
});

/* ══════════════════════ 4. 全站唯一实现（P0-2② 过渡期闸） ═══════════ */

test("全站编号解析唯一实现：页面模块零分叉（旧 6 副本文件清单内过渡容忍，其余 0 命中）", () => {
  const pagesDir = join(ROOT, "lib", "ui", "pages");
  const allowedDuringTransition = new Set([
    // 旧页文件（M4 删除 / M5 重写 / M6 重写）；其消亡后本清单即空集。
    "assets.page.mjs", "exploration.page.mjs", "verification.page.mjs",
    "vulnerabilities.page.mjs", "reports.page.mjs", "coordination.page.mjs",
  ]);
  const violations = [];
  for (const name of readdirSync(pagesDir).sort()) {
    if (!name.endsWith(".page.mjs")) continue;
    const src = readFileSync(join(pagesDir, name), "utf8");
    if (src.includes("RECORD_ID_RE") && !allowedDuringTransition.has(name)) {
      violations.push(name);
    }
  }
  assert.deepEqual(violations, [], `页面模块不得自带编号解析（唯一实现在 lib/ui/record-ids.mjs）：${violations.join("、")}`);

  const client = readFileSync(join(ROOT, "client.js"), "utf8");
  assert.doesNotMatch(client, /RECORD_ID_RE/, "外壳不得自带编号解析");
  const renderSrc = readFileSync(join(ROOT, "lib", "ui", "render.mjs"), "utf8");
  assert.match(renderSrc, /from "\.\/record-ids\.mjs"/, "渲染器必须经唯一实现渲染编号 chip");
});

/* ══════════════════════ 5. 渲染器契约（§2.2） ═══════════════════════ */

const FIXED_NOW = new Date("2026-11-05T14:30:00.000Z").getTime();

test("formatTime：相对+本地化、绝不裸出 UTC ISO 串、悬停 title=原始值", () => {
  const iso = "2026-11-05T14:29:30.000Z";
  const el = formatTime(iso, { now: FIXED_NOW });
  assert.equal(typeof el, "string");
  assert.match(el, /^(刚刚|30 秒前|1 分钟前) · \d{2}:\d{2}:\d{2}$/, `相对时间形如「N 分钟前 · HH:MM:SS」，实际：${el}`);
  assert.doesNotMatch(el, /\.000Z|T14:/, "不得出现 UTC ISO 原串");

  const older = formatTime("2026-11-05T13:00:00.000Z", { now: FIXED_NOW });
  assert.match(older, /^1 小时前 · \d{2}:\d{2}:\d{2}$/);

  const daysAgo = formatTime("2026-11-02T13:00:00.000Z", { now: FIXED_NOW });
  assert.match(daysAgo, /^3 天前 · \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

  const abs = formatTime(iso, { mode: "absolute", now: FIXED_NOW });
  assert.match(abs, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}（本地）$/);
  assert.doesNotMatch(abs, /\.000Z/);

  assert.equal(formatTime(null), "—（未提供）");
  assert.equal(formatTime(undefined), "—（未提供）");
  assert.equal(formatTime(""), "—（未提供）");
  assert.match(formatTime("不是时间"), /^时间无法解析：/);
  /* 悬停原始值由 FieldRow/调用方经 title 提供；本函数纯文本。 */
});

test("formatHash：sha256 缩略 + 复制按钮（aria 完整）；空值 —（未提供）", () => {
  const sha = "ab12cd34ef0987654321ab12cd34ef0987654321ab12cd34ef0987654321abcd";
  const el = formatHash(sha);
  assert.equal(el.__elem, true);
  const code = el.children.find((c) => c && c.__elem && c.type === "code");
  assert.ok(code, "应有 <code> 展示缩略值");
  assert.equal(nodeText(code), `sha256:${sha.slice(0, 10)}…`);
  assert.equal(code.props.title, `完整值：${sha}`, "悬停提供完整值");
  const copyBtn = el.children.find((c) => c && c.__elem && c.type === "button");
  assert.ok(copyBtn, "应有复制按钮");
  assert.equal(copyBtn.props["aria-label"], "复制完整哈希值");
  assert.doesNotThrow(() => copyBtn.props.onClick(), "复制在无剪贴板环境应静默不抛");

  const short = formatHash("abc123");
  assert.equal(nodeText(short.children.find((c) => c.__elem && c.type === "code")), "abc123");

  const empty = formatHash("");
  assert.equal(nodeText(empty), "—（未提供）");
  assert.match(empty.props.title, /未提供 ≠ 不存在/);
});

test("RecordIdChip：完整编号按钮、aria=完整编号、点击携带完整编号（项目段不截断）", () => {
  const opened = [];
  const navigate = (id) => opened.push(id);
  const el = RecordIdChip("A-PRJ-0002-0002", { projectId: "PRJ-0002", navigate });
  assert.equal(el.type, "button", "解析成功 → 可点击按钮");
  assert.equal(nodeText(el), "A-PRJ-0002-0002", "显示完整编号（不截断项目段）");
  assert.equal(el.props["aria-label"], "查看记录 A-PRJ-0002-0002（资产）");
  assert.match(el.props.title, /资产/);
  assert.match(el.props.title, /项目内编号/);
  el.props.onClick({ preventDefault() {}, stopPropagation() {} });
  assert.deepEqual(opened, ["A-PRJ-0002-0002"], "点击必须携带完整编号，绝不静默给错记录");

  const globalChip = RecordIdChip("V-0003", { navigate });
  globalChip.props.onClick({ preventDefault() {}, stopPropagation() {} });
  assert.deepEqual(opened, ["A-PRJ-0002-0002", "V-0003"]);

  const bad = RecordIdTagHelper();
  function RecordIdTagHelper() { return RecordIdChip("完全不是编号", { navigate }); }
  assert.equal(bad.type, "span", "无法解析 → 降级纯文本 chip");
  assert.equal(nodeText(bad), "完全不是编号");
  assert.match(bad.props.title, /不猜测/);

  const evt = RecordIdChip("evt-PRJ-0002-3-1", { navigate });
  assert.equal(evt.type, "span", "事件编号降级");
  assert.match(evt.props.title, /变化流/);

  const noNav = RecordIdChip("V-0003", {});
  assert.doesNotThrow(() => noNav.props.onClick({ preventDefault() {}, stopPropagation() {} }), "navigate 缺失时点击不得抛错");
});

test("FoldableObject：默认折叠、已折叠计数、展开不删记录（语义纪律）", () => {
  const value = { alpha: 1, beta: "二", gamma: { nested: true }, delta: [1, 2, 3] };
  const el = FoldableObject(value, { level: 0 });
  const tree = hydrate(el);
  const toggle = findNodes(tree, (n) => n.type === "button")[0];
  assert.ok(toggle, "应有折叠切换按钮");
  assert.equal(toggle.props["aria-expanded"], "false", "默认折叠");
  const before = treeText(findNodes(tree, (n) => n.type === "button")[0]);
  assert.match(before, /\{4 项\}/);
  assert.match(before, /已折叠 4 项/);
  const countSpan = findNodes(tree, (n) => n.type === "span" && String(n.props.title || "").includes("折叠不删记录"))[0];
  assert.ok(countSpan, "折叠态必须提示可展开（折叠不删记录，title 提示）");

  toggle.props.onClick();
  const expandedText = treeText(tree);
  assert.match(expandedText, /alpha/, "展开后全部键可见（展开不删记录）");
  assert.match(expandedText, /二/);
  assert.match(expandedText, /delta/);

  /* 嵌套对象默认再折叠，但其独立展开入口在（层层可展开，不删记录）。 */
  const inner = findNodes(tree, (n) => n.type === "button").find((b) => treeText(b).includes("gamma"));
  assert.ok(inner, "嵌套对象应有独立折叠入口");
  assert.equal(inner.props["aria-expanded"], "false", "嵌套对象默认再折叠");
  inner.props.onClick();
  assert.match(treeText(tree), /nested/, "嵌套对象再展开后内容可见（递归展开不删记录）");

  /* 标量/空值。 */
  assert.equal(FoldableObject(null), "—（未提供）");
  assert.equal(FoldableObject("文本"), "文本");
});

test("StatusBadge：词表驱动、语义纪律冻结原文、未知值显式呈现（P0-4 联动）", () => {
  const confirmed = StatusBadge("vulnerability_status", "confirmed");
  assert.match(nodeText(confirmed), /已确认（限指定条件）/, "confirmed 永远带「（限指定条件）」");
  const insuf = StatusBadge("outcome", "insufficient");
  assert.match(nodeText(insuf), /证据不足：未确认，不伪装成已排除/);
  const falsified = StatusBadge("vulnerability_status", "falsified");
  assert.match(nodeText(falsified), /不等于历史上不存在/);
  const unknownTool = StatusBadge("tool_call_status", "unknown");
  assert.match(nodeText(unknownTool), /须先检查外部现状再决定重试，不得当作已完成或已失败/);
  assert.equal(confirmed.props.title, "原始值：confirmed", "悬停显示英文原值");

  const unknownVal = StatusBadge("vulnerability_status", "banana");
  assert.match(nodeText(unknownVal), /未知状态（banana）/, "未知值显式呈现，不猜测");
  assert.match(unknownVal.props.title, /P0-4/);

  const openEnded = StatusBadge("event_type", "plan.received");
  assert.match(nodeText(openEnded), /plan\.received/, "开放词表原样显示");
  assert.doesNotMatch(nodeText(openEnded), /未知状态/);

  const missingVocab = StatusBadge("no_such_vocab", "x");
  assert.match(nodeText(missingVocab), /词表 no_such_vocab 缺失/);
});

test("VOCAB 语义纪律词表：三句措辞与 delivered≠handled 为冻结原文（评审 §6）", () => {
  assert.equal(VOCAB.vulnerability_status.confirmed.label, "已确认（限指定条件）");
  assert.match(VOCAB.vulnerability_status.falsified.label, /不等于历史上不存在/);
  assert.match(VOCAB.vulnerability_status.inconclusive.label, /证据不足：未确认，不伪装成已排除/);
  assert.match(VOCAB.outcome.insufficient.label, /不伪装成已排除/);
  assert.match(VOCAB.tool_call_status.unknown.label, /不得当作已完成或已失败/);
  /* delivered ≠ handled：received 只是「已接收（尚未处理）」，不得显示为已答复。 */
  assert.match(VOCAB.message_status.received.label, /尚未处理/);
  assert.notEqual(VOCAB.message_status.received.label, VOCAB.message_status.answered.label);
  /* subject_kind 为语义类型四值（P0-4 联动；物理表名不再是呈现值）。 */
  assert.deepEqual(Object.keys(VOCAB.subject_kind).sort(), ["fact", "hypothesis", "observation", "vulnerability"]);
  /* 顶栏运行状态词表：要求 §7 五态 + 过渡 + 未知。 */
  assert.deepEqual(
    Object.keys(RUN_STATUS).sort(),
    ["abnormal", "exploring", "paused", "pausing", "stopped", "unknown", "waiting"].sort(),
  );
  assert.equal(RUN_STATUS.exploring.label, "正在探索");
  assert.equal(RUN_STATUS.waiting.label, "等待条件补齐");
  assert.equal(RUN_STATUS.pausing.label, "正在暂停");
  assert.equal(RUN_STATUS.paused.label, "已暂停");
  assert.equal(RUN_STATUS.abnormal.label, "系统异常");
  assert.equal(RUN_STATUS.stopped.label, "已停止");
});

test("FieldRow：LABELS 中文标签、布尔、未提供、未登记字段降级不吞掉", () => {
  const row = FieldRow("status", "active");
  assert.match(nodeText(row), /状态/);
  assert.match(nodeText(row), /active/);

  const boolRow = FieldRow("configured", true);
  assert.match(nodeText(boolRow), /是/);
  const boolRow2 = FieldRow("configured", false);
  assert.match(nodeText(boolRow2), /否/);

  const emptyRow = FieldRow("summary", null);
  assert.match(nodeText(emptyRow), /—（未提供）/);
  const span = findInElem(emptyRow, (e) => e.type === "span" && String(e.props.title || "").includes("未提供"))[0];
  assert.ok(span, "空值应悬停提示 未提供 ≠ 不存在");

  const unlabeled = FieldRow("definitely_not_registered_field", "值");
  assert.match(nodeText(unlabeled), /definitely_not_registered_field/, "未登记字段原样键名（不省略）");
  assert.match(nodeText(unlabeled), /标签未登记/);
  const labelSpan = findInElem(unlabeled, (e) => e.type === "span" && String(e.props.title || "").includes("标签未登记"))[0];
  assert.ok(labelSpan, "未登记字段应悬停提示「标签未登记」");

  /* 时间与哈希字段的自动渲染。 */
  const timeRow = FieldRow("created_at", "2026-11-05T14:00:00.000Z");
  const timeText = nodeText(timeRow);
  assert.doesNotMatch(timeText, /\.000Z/, "时间字段不得裸出 UTC ISO 串");
  const hashRow = FieldRow("sha256", "ab12cd34ef0987654321ab12cd34ef0987654321ab12cd34ef0987654321abcd");
  assert.match(nodeText(hashRow), /sha256:ab12cd34ef…/);

  /* id 形态字段的编号 chip。 */
  const idRow = FieldRow("intent_id", "I-PRJ-0002-0001");
  const chip = findInElem(idRow, (e) => e.type === "button")[0];
  assert.ok(chip, "id 形态字段的编号应渲染为 chip");
  assert.equal(nodeText(chip), "I-PRJ-0002-0001");
  /* 非编号文本不误判为 chip。 */
  const nameRow = FieldRow("name", "A-0002 项目名");
  assert.equal(findInElem(nameRow, (e) => e.type === "button").length, 0, "业务文本不得误渲染为编号 chip");
});

/** 在原始元素树（不经组件实例化）里查找元素。 */
function findInElem(el, pred, out = []) {
  if (!el || !el.__elem) return out;
  if (pred(el)) out.push(el);
  for (const c of el.children || []) findInElem(c, pred, out);
  return out;
}

test("DataTable：真表格、aria-sort 排序、行点击进详情；空数据走 EmptyState", () => {
  const rows = [
    { id: "A-0002", name: "乙资产", status: "candidate" },
    { id: "A-0001", name: "甲资产", status: "confirmed" },
  ];
  const clicked = [];
  const el = DataTable({
    columns: [
      { key: "id", label: "编号" },
      { key: "name", label: "名称" },
      { key: "status", label: "状态", badge: "scope_kind", value: (r) => r.status },
    ],
    rows,
    rowKey: (r) => r.id,
    onRowClick: (r) => clicked.push(r.id),
  });
  const tree = hydrate(el);
  const table = findNodes(tree, (n) => n.type === "table")[0];
  assert.ok(table, "应渲染真 <table>");
  const th = findNodes(tree, (n) => n.type === "th");
  assert.equal(th.length, 3);
  assert.equal(th[0].props["aria-sort"], "none");
  const sortBtn = findNodes(tree, (n) => n.type === "button" && String(n.props["aria-label"] || "").includes("排序"))[0];
  sortBtn.props.onClick();
  const bodyText = treeText(tree);
  const idxFirst = bodyText.indexOf("A-0001");
  const idxSecond = bodyText.indexOf("A-0002");
  assert.ok(idxFirst >= 0 && idxFirst < idxSecond, `排序后 A-0001 应在 A-0002 之前：${bodyText}`);
  const thAfter = findNodes(tree, (n) => n.type === "th")[0];
  assert.equal(thAfter.props["aria-sort"], "ascending");

  const tr = findNodes(tree, (n) => n.type === "tr")[1];
  tr.props.onClick();
  assert.deepEqual(clicked, ["A-0001"], "行点击应回调 onRowClick");

  const empty = DataTable({ columns: [{ key: "id", label: "编号" }], rows: [] });
  assert.match(nodeText(empty), /暂无数据/);
  assert.match(nodeText(empty), /不代表全量/, "空态注明按已加载数据推导口径");
});

test("EmptyState：标题/提示/动作；role=status", () => {
  const el = EmptyState({ title: "暂无项目", hint: "可从首次使用向导开始", actions: [miniH("button", { key: "a" }, "创建项目")] });
  assert.equal(el.props.role, "status");
  const text = nodeText(el);
  assert.match(text, /暂无项目/);
  assert.match(text, /首次使用向导/);
  assert.match(text, /创建项目/);
});

/* ══════════════════════ 6. LABELS 覆盖闸（机制化） ══════════════════ */

/** 端点样例响应 fixtures（真实形状；新增端点/字段联调时必须补入——漏登记即红）。
    字段名一律来自实测响应（见竣工记录 ui-M1.md 的实测命令）。 */
const ENDPOINT_FIXTURES = {
  "GET /sorne/health": {
    ok: true, service: "sorne", version: "0.1.0", checked_at: "2026-11-05T14:00:00.000Z",
    db: { ok: true, schema_version: 4 },
    outbox: { pending: 1, sent: 20, failed: 0, skipped: 0, total: 21 },
    projects: 1, sessions: { active: 0 },
  },
  "GET /sorne/projects": {
    projects: [{
      id: "PRJ-0002", name: "演示项目", description: "目标", status: "active",
      created_at: "2026-11-05T14:00:00.000Z", created_by: "user",
      created_seq: 1, updated_seq: 0, state_version: 1,
      latest_progress: "asset.registered A-PRJ-0002-0002",
      last_activity_at: "2026-11-05T14:00:00.000Z",
      pending: { unhandled_reports: 0, pending_verification: 0, blocked_intents: 1 },
    }],
    next_cursor: null, has_more: false,
  },
  "GET /sorne/projects/:id": {
    project: {
      id: "PRJ-0002", name: "演示项目", description: "目标", status: "active",
      current_scope_revision: "r2", created_at: "2026-11-05T14:00:00.000Z",
      created_by: "user", created_seq: 1, updated_seq: 3, state_version: 4,
    },
    scope: null,
    counts: { assets: 2, observations: 5, hypotheses: 1, vulnerabilities: 1, submissions: 9, outbox_pending: 0 },
  },
  "GET /sorne/projects/:id/scope": {
    project_id: "PRJ-0002",
    current: {
      revision: "r2", summary: "初始授权",
      rules: { allow: ["https://a.test/"], deny: ["https://x.test/"], pending: [] },
    },
    history: [{ revision: "r1" }],
    configured: true,
    note: "范围版本化呈现",
  },
  "POST /sorne/projects/:id/lifecycle": {
    project: { id: "PRJ-0002", status: "paused", state_version: 5, updated_seq: 4 },
    commit_seq: 5,
  },
  "GET /sorne/attempts": {
    attempts: [{
      id: "ATT-0001", project_id: "PRJ-0002", intent_id: "I-PRJ-0002-0001",
      status: "running", lease_expires_at: "2026-11-05T14:05:00.000Z",
      created_at: "2026-11-05T14:00:00.000Z", created_by: "orchestrator",
    }],
    has_more: false, next_after: null, count: 1,
  },
  "GET /sorne/intents": {
    project_id: "PRJ-0002",
    intents: [{
      id: "I-PRJ-0002-0001", project_id: "PRJ-0002", goal_id: "G-0001",
      kind: "investigate", status: "blocked", title: "登录入口",
      priority: 5, resume_conditions: ["补充接口文档"],
      created_at: "2026-11-05T14:00:00.000Z",
    }],
    next_cursor: null, has_more: false,
  },
  "GET /sorne/records/:id（资产视图）": {
    record: {
      id: "A-PRJ-0002-0002", kind: "assets", project_id: "PRJ-0002",
      created_at: "2026-11-05T14:00:00.000Z", created_by: "worker",
      created_seq: 7,
      asset_type: "service", canonicalization_version: "v1",
      canonical_key: "https://api.seed.test", original_input: "api.seed.test",
      scope_status: "allow", resources: 2, captures: 1, observations: 0,
      vulnerabilities: 0, intents_targeting: 1,
    },
    evidence_index: [],
    relations: {
      edges: [{
        id: "R-0001", from: "O-0001", to: "A-PRJ-0002-0002",
        relation_type: "targets", conditions: null, requires_state: null,
        source: "worker", valid_from_seq: 8, retracted_at: null,
        created_at: "2026-11-05T14:00:00.000Z", created_by: "worker",
      }],
      truncated: false,
      note: undefined,
    },
    expand: {
      record_path: "/sorne/records/A-PRJ-0002-0002?project_id=PRJ-0002",
      evidence_bytes_path_template: "/sorne/evidence/blobs/{sha256}?project_id={pid}",
      note: "原始证据字节按需读取",
    },
  },
};

/** 显式豁免清单：fixtures 中不强制中文标签的字段（附理由；新增豁免须评审）。 */
const LABEL_EXEMPT = new Set([
  "note",       // note 本身已是中文说明文本（值为说明，不需要标签名翻译）
]);

function walkFields(value, path, out) {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) walkFields(item, path, out);
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.push({ key: k, path: `${path}.${k}` });
      walkFields(v, `${path}.${k}`, out);
    }
  }
}

test("LABELS 覆盖闸：端点样例响应逐字段有中文标签（漏登记即红；显式豁免清单）", () => {
  const missing = [];
  for (const [endpoint, body] of Object.entries(ENDPOINT_FIXTURES)) {
    const fields = [];
    walkFields(body, endpoint, fields);
    for (const { key, path } of fields) {
      if (LABEL_EXEMPT.has(key)) continue;
      if (!Object.prototype.hasOwnProperty.call(LABELS, key)) {
        missing.push(`${path}（键 ${key}）`);
      }
    }
  }
  assert.deepEqual(
    missing,
    [],
    `以下字段未登记中文标签（应补登 lib/ui/render.mjs LABELS 或列入显式豁免）：\n${missing.join("\n")}`,
  );
  /* 抽样核对标签不是键名回显（真中文）。 */
  assert.match(LABELS.schema_version, /模式版本/);
  assert.match(LABELS.commit_seq, /提交序号/);
  assert.match(LABELS.resume_conditions, /恢复条件/);
  assert.match(LABELS.handling_status, /处理状态/);
  assert.match(LABELS.reviewed_evidence_revision, /已复核证据版本/);
});

/* ══════════════════════ 7. theme 句柄（§2.1 注入方式） ══════════════ */

function fakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
  };
}

test("theme：三态切换、localStorage 持久化、onChange 通知、非法模式拒绝", () => {
  const storage = fakeStorage();
  const events = [];
  const handle = createThemeHandle({ win: {}, storage });
  assert.equal(handle.mode(), "system", "默认跟随系统");
  const unsub = handle.onChange((t) => events.push(t));
  handle.set("dark");
  assert.equal(handle.effective(), "dark");
  assert.equal(storage.getItem(THEME_STORAGE_KEY), "dark");
  handle.set("light");
  assert.equal(handle.effective(), "light");
  handle.set("system");
  assert.equal(handle.effective(), resolveThemeMode("system", {}), "system 模式经 matchMedia 解析（无 matchMedia → light）");
  assert.equal(events.length, 3, "每次生效变化都通知");
  unsub();
  handle.set("dark");
  assert.equal(events.length, 3, "退订后不再通知");
  assert.throws(() => handle.set("blue"), /未知主题模式/);
  assert.deepEqual([...THEME_MODES], ["light", "dark", "system"]);
  /* 持久化恢复。 */
  const storage2 = fakeStorage();
  storage2.setItem(THEME_STORAGE_KEY, "dark");
  const handle2 = createThemeHandle({ win: {}, storage: storage2 });
  assert.equal(handle2.mode(), "dark", "启动时恢复持久化选择");
});

test("theme：CSS 注入含两套主题块与 color-scheme、焦点环永不置 none（评审 §5）", () => {
  const css = buildThemeCss();
  assert.match(css, /html\[data-sorne-theme="light"\]/);
  assert.match(css, /html\[data-sorne-theme="dark"\]/);
  assert.match(css, /color-scheme:\s*light dark/);
  for (const t of TOKENS) {
    assert.match(css, new RegExp(`${t.name}:`), `CSS 应包含 token ${t.name}`);
  }
  assert.match(css, /:focus-visible/);
  assert.match(css, /var\(--sorne-focus-ring\)/);
  assert.doesNotMatch(css, /outline:\s*(none|0)/, "焦点环不得被置 none");
  /* 幂等注入（带假 document）。 */
  const created = [];
  const fakeDoc = {
    head: { appendChild: (n) => created.push(n) },
    createElement: () => ({ set textContent(v) { this._t = v; }, get textContent() { return this._t; } }),
    getElementById: (id) => (created.some((n) => n.id === id) ? { id } : null),
  };
  assert.equal(ensureThemeStyle(fakeDoc), true);
  assert.equal(created.length, 1);
  assert.equal(ensureThemeStyle(fakeDoc), true, "幂等：第二次注入不再创建");
  assert.equal(created.length, 1);
  assert.equal(ensureThemeStyle(null), false, "无 document 环境（Node）安全跳过");
  assert.equal(systemPrefersDark({}), false, "无 matchMedia → 不外推宿主主题（如实返回 light）");
});

/* ══════════════════════ 8. router 纯函数与句柄（§2.4） ══════════════ */

function fakeWindow(initialHash = "") {
  const listeners = { hashchange: new Set(), keydown: new Set() };
  let hash = initialHash;
  const stack = [initialHash];
  let idx = 0;
  const win = {
    location: {
      get hash() { return hash; },
      set hash(v) {
        if (v === hash) return;
        stack.splice(idx + 1);
        stack.push(v);
        idx += 1;
        hash = v;
        for (const fn of Array.from(listeners.hashchange)) fn({ type: "hashchange" });
      },
    },
    history: {
      replaceState(_s, _t, url) { hash = url; },
      back() {
        if (idx > 0) {
          idx -= 1;
          hash = stack[idx];
          for (const fn of Array.from(listeners.hashchange)) fn({ type: "hashchange" });
        }
      },
    },
    addEventListener(type, fn) { listeners[type].add(fn); },
    removeEventListener(type, fn) { listeners[type].delete(fn); },
  };
  win.__stack = stack;
  win.__idx = () => idx;
  return win;
}

test("router.parseHash：路由表全量解析（#/page/project/id、records 覆盖层、未知回退）", () => {
  let r = parseHash("#/onboarding");
  assert.equal(r.page, "onboarding");
  r = parseHash("#/projects");
  assert.equal(r.page, "projects");
  r = parseHash("#/p/PRJ-0002/workbench");
  assert.equal(r.page, "workbench");
  assert.equal(r.projectId, "PRJ-0002");
  r = parseHash("#/p/PRJ-0002/assets?id=A-PRJ-0002-0001&view=graph");
  assert.equal(r.page, "assets");
  assert.equal(r.params.id, "A-PRJ-0002-0001");
  assert.equal(r.params.view, "graph");
  r = parseHash("#/p/PRJ-0002");
  assert.equal(r.page, "workbench", "#/p/:pid 缺页段等价 workbench（进入项目默认页）");
  r = parseHash("#/records/V-0003?project=PRJ-0002");
  assert.equal(r.page, RECORDS_PAGE);
  assert.equal(r.recordId, "V-0003");
  assert.equal(r.projectId, "PRJ-0002");
  r = parseHash("#/records/A-PRJ-0002-0002");
  assert.equal(r.recordId, "A-PRJ-0002-0002");
  assert.equal(r.projectId, null);
  r = parseHash("#/p/PRJ-1/overview");
  assert.equal(r.page, "unknown", "旧 id 页面不在白名单 → unknown（外壳重定向）");
  r = parseHash("");
  assert.equal(r.page, null, "空 hash → 默认落点（#/projects）");
  r = parseHash("#/nonsense");
  assert.equal(r.page, "unknown");
  /* 参数解码。 */
  r = parseHash("#/p/PRJ-0002/findings?id=" + encodeURIComponent("V-0003"));
  assert.equal(r.params.id, "V-0003");
});

test("router.createRouter：open/replace/back 返回栈记账（§2.4-2）与 openRecord", () => {
  const win = fakeWindow("#/projects");
  const changes = [];
  const router = createRouter({ win });
  const unsub = router.onChange((h) => changes.push(h.page));
  assert.equal(router.page, "projects");
  assert.equal(router.isInAppHistory(), false, "首条不算应用内前驱（深链语义）");

  router.open("#/p/PRJ-0002/assets");
  assert.equal(router.page, "assets");
  assert.equal(router.projectId, "PRJ-0002");
  assert.equal(router.isInAppHistory(), true, "open 产生应用内前驱");

  router.open("#/p/PRJ-0002/assets?id=A-PRJ-0002-0001");
  assert.equal(router.params.id, "A-PRJ-0002-0001");

  router.openRecord("V-0003");
  assert.equal(router.page, RECORDS_PAGE);
  assert.equal(router.recordId, "V-0003");
  assert.equal(router.projectId, "PRJ-0002", "openRecord 携带当前项目");
  assert.equal(router.hash, "#/records/V-0003?project=PRJ-0002");

  router.back("#/p/PRJ-0002/assets");
  assert.equal(router.page, "assets", "有应用内前驱 → back 回来源页（含 ?id= 详情态）");
  assert.equal(router.params.id, "A-PRJ-0002-0001");

  /* 继续返回：assets?id → assets 列表基 → 引导页（逐级应用内前驱）。 */
  router.back("#/p/PRJ-0002/assets");
  assert.equal(router.page, "assets");
  assert.equal(router.params.id, undefined, "详情关闭落到列表基（同页基、无 id）");
  router.back("#/projects");
  assert.equal(router.page, "projects");
  assert.equal(router.isInAppHistory(), false);
  assert.ok(win.__stack.length >= 4, "back 走浏览器历史（不劫持原生返回）");

  /* 深链直开详情：无应用内前驱 → 关闭落列表态（replace，不产生新历史）。 */
  const win2 = fakeWindow("#/p/PRJ-0002/findings?id=V-0003");
  const router2 = createRouter({ win: win2 });
  assert.equal(router2.params.id, "V-0003");
  assert.equal(router2.isInAppHistory(), false);
  router2.back("#/p/PRJ-0002/findings");
  assert.equal(router2.page, "findings");
  assert.equal(router2.params.id, undefined, "深链关闭详情 → 列表态（§2.4-2 规则 1）");

  /* replace：不产生应用内前驱（重定向语义）。 */
  const win3 = fakeWindow("#/whatever");
  const router3 = createRouter({ win: win3 });
  router3.replace("#/projects");
  assert.equal(router3.page, "projects");
  assert.equal(router3.isInAppHistory(), false);

  unsub();
  const before = changes.length;
  router3.open("#/projects");
  assert.equal(changes.length, before, "退订后不再通知");
  /* 冻结 API 面齐备。 */
  for (const key of ["hash", "page", "projectId", "params", "open", "replace", "back", "openRecord"]) {
    assert.ok(router[key] !== undefined, `router.${key} 为冻结 API（§2.4-2）`);
  }
  assert.equal(pageBaseHash({ page: "assets", projectId: "PRJ-1" }), "#/p/PRJ-1/assets");
  assert.equal(pageBaseHash({ page: RECORDS_PAGE, projectId: "PRJ-1" }), "#/p/PRJ-1/workbench");
  assert.equal(recordHash("A-1", "PRJ-1"), "#/records/A-1?project=PRJ-1");
  assert.equal(recordHash("A-1", null), "#/records/A-1");
});

test("外壳白名单常量与 lib/ui/router.mjs 导出一致（双布局导航集合为冻结契约）", () => {
  const client = readFileSync(join(ROOT, "client.js"), "utf8");
  /* client.js 内嵌白名单与 router.mjs 导出逐项一致（文本级比对）。 */
  for (const pageId of [...WORKSPACE_PAGES, ...GUIDE_PAGES, DIAGNOSTICS_PAGE]) {
    assert.match(
      client,
      new RegExp(`["']${pageId}["']`),
      `client.js 白名单应包含 ${pageId}`,
    );
  }
  assert.deepEqual([...WORKSPACE_PAGES], ["workbench", "assets", "exploration", "findings", "reports"]);
  assert.deepEqual([...GUIDE_PAGES], ["onboarding", "projects"]);
  assert.equal(KNOWN_PAGES.includes(DIAGNOSTICS_PAGE), true);
  assert.equal(KNOWN_PAGES.includes(RECORDS_PAGE), true);
  for (const id of Object.keys(PAGE_LABELS)) {
    assert.match(PAGE_LABELS[id], /[\u4e00-\u9fa5]/, `${id} 导航标签必须中文`);
  }
  for (const [id, owner] of Object.entries(SLOT_OWNERS)) {
    assert.match(owner, /^M[3-6]/, `${id} 槽位应标注施工模块（实际：${owner}）`);
  }
});
