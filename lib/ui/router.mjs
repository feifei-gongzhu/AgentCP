/**
 * Sorne —— hash 路由（lib/ui/router.mjs；M1 独占）。
 *
 * 蓝图 §2.4 / §2.4-2（冻结契约）。修复评审 §4d「无 hash 路由——刷新回总览，
 * 无法分享」：
 *
 *   路由表（冻结）：
 *     #/onboarding                  首次使用向导（引导层，M3）
 *     #/projects                    项目列表（无项目时为默认落点，引导层，M3）
 *     #/p/:pid/workbench            工作台（进入项目默认页，M4）
 *     #/p/:pid/assets[?id=<编号>]   资产列表 / 详情（M5）
 *     #/p/:pid/exploration[?id=&view=graph|full]（M5）
 *     #/p/:pid/findings[?id=<V-编号>]（M6）
 *     #/p/:pid/reports[?id=<RR-/MR-编号>]（M6）
 *     #/p/:pid/diagnostics          系统诊断（M4）
 *     #/records/:id?project=:pid    记录展开覆盖层（外壳级；任何页可跳，
 *                                   关闭回到来源 hash）
 *
 *   规则（冻结）：路由为唯一页面状态入口——刷新/分享/回退/前进全部成立；
 *   未知 hash → #/projects；未知 :pid 由外壳经项目详情 404 重定向 #/projects。
 *   「#/p/:pid」缺页段等价 workbench（进入项目默认页）。
 *
 *   返回栈规则（§2.4-2 冻结，M3–M6 共同依赖）：
 *     1. 应用内导航一律 push（location.hash 赋值）；关闭详情/覆盖层时：
 *        存在应用内前驱（本模块 navLog 记账，覆盖刷新后无前驱与深链直开两种
 *        情形）→ history.back()，否则 location.replace 到来源页列表 hash。
 *     2. #/records 覆盖层关闭 → 存在前驱 → back 回来源页（含其 ?id= 详情态），
 *        否则落 #/p/:project/workbench。
 *     3. 浏览器原生返回/前进与上述 push/replace 一致（不劫持）。
 *
 * 本文件不得 import 任何包或 Node 内置模块；window/history 经 createRouter
 * 注入（Node 测试可注入假 window）。
 */

/** 工作区左导航页 id（冻结顺序 = 蓝图 §2.5 注册表 order）。 */
export const WORKSPACE_PAGES = Object.freeze(["workbench", "assets", "exploration", "findings", "reports"]);
/** 引导层页 id（不走左导航）。 */
export const GUIDE_PAGES = Object.freeze(["onboarding", "projects"]);
/** 系统诊断（工作区左导航底部独立入口）。 */
export const DIAGNOSTICS_PAGE = "diagnostics";
/** 记录覆盖层页 id（外壳级，不属于任何布局）。 */
export const RECORDS_PAGE = "records";
/** 全部合法页 id（工作区 + 引导 + 诊断 + 覆盖层）。 */
export const KNOWN_PAGES = Object.freeze([
  ...GUIDE_PAGES,
  ...WORKSPACE_PAGES,
  DIAGNOSTICS_PAGE,
  RECORDS_PAGE,
]);

/** 导航中文标签（冻结；页面文件未落地时槽位照常渲染）。 */
export const PAGE_LABELS = Object.freeze({
  onboarding: "首次使用",
  projects: "项目列表",
  workbench: "工作台",
  assets: "资产",
  exploration: "探索",
  findings: "发现",
  reports: "报告",
  diagnostics: "系统诊断",
});

/** 页面槽位归属（页面文件未就绪时向用户如实标注施工模块）。 */
export const SLOT_OWNERS = Object.freeze({
  onboarding: "M3（引导与项目列表）",
  projects: "M3（引导与项目列表）",
  workbench: "M4（工作台与系统诊断）",
  diagnostics: "M4（工作台与系统诊断）",
  assets: "M5（资产与探索）",
  exploration: "M5（资产与探索）",
  findings: "M6（发现与报告）",
  reports: "M6（发现与报告）",
});

/**
 * 解析 hash（纯函数）。
 * @returns {{
 *   raw: string,
 *   page: string|null,          // KNOWN_PAGES 之一；null=空 hash；"unknown"=未登记
 *   projectId: string|null,     // 工作区页的项目 id；records 页为 ?project=
 *   recordId: string|null,      // records 覆盖层的记录编号
 *   params: {{ id?: string, view?: string }},  // query 白名单（id/view）
 *   query: object,              // 全部 query（原样，供页面按需读取）
 * }}
 */
export function parseHash(hash) {
  const raw = typeof hash === "string" ? hash : "";
  let path = raw.startsWith("#") ? raw.slice(1) : raw;
  if (!path.startsWith("/")) path = `/${path}`;
  const qIndex = path.indexOf("?");
  const pathPart = qIndex >= 0 ? path.slice(0, qIndex) : path;
  const query = {};
  if (qIndex >= 0) {
    const qs = path.slice(qIndex + 1);
    for (const pair of qs.split("&")) {
      if (!pair) continue;
      const eq = pair.indexOf("=");
      const k = eq >= 0 ? pair.slice(0, eq) : pair;
      const v = eq >= 0 ? pair.slice(eq + 1) : "";
      try {
        query[decodeURIComponent(k)] = decodeURIComponent(v);
      } catch {
        query[k] = v;
      }
    }
  }

  const params = {};
  if (typeof query.id === "string" && query.id) params.id = query.id;
  if (typeof query.view === "string" && query.view) params.view = query.view;

  if (pathPart === "/" || pathPart === "") {
    return { raw, page: null, projectId: null, recordId: null, params, query };
  }
  if (pathPart === "/onboarding" || pathPart === "/projects") {
    return { raw, page: pathPart.slice(1), projectId: null, recordId: null, params, query };
  }
  const records = /^\/records\/([^/?#]+)$/.exec(pathPart);
  if (records) {
    let recordId = records[1];
    try { recordId = decodeURIComponent(recordId); } catch { /* 保持原样 */ }
    const projectId = typeof query.project === "string" && query.project ? query.project : null;
    return { raw, page: RECORDS_PAGE, projectId, recordId, params, query };
  }
  const workspace = /^\/p\/([^/?#]+)\/([^/?#]+)$/.exec(pathPart);
  if (workspace) {
    let pid = workspace[1];
    let page = workspace[2];
    try { pid = decodeURIComponent(pid); } catch { /* 保持原样 */ }
    try { page = decodeURIComponent(page); } catch { /* 保持原样 */ }
    if (KNOWN_PAGES.includes(page)) {
      return { raw, page, projectId: pid, recordId: null, params, query };
    }
    return { raw, page: "unknown", projectId: pid, recordId: null, params, query };
  }
  const bareWorkspace = /^\/p\/([^/?#]+)$/.exec(pathPart);
  if (bareWorkspace) {
    let pid = bareWorkspace[1];
    try { pid = decodeURIComponent(pid); } catch { /* 保持原样 */ }
    // #/p/:pid 缺页段 → 进入项目默认页（workbench），不强制改写 URL。
    return { raw, page: "workbench", projectId: pid, recordId: null, params, query };
  }
  return { raw, page: "unknown", projectId: null, recordId: null, params, query };
}

/** 当前页的「列表基 hash」：同 :pid/<page>、去 id/view 详情参数（§2.4-2 关闭详情落点）。 */
export function pageBaseHash({ page, projectId }) {
  if (page === RECORDS_PAGE) return `#/p/${encodeURIComponent(projectId || "")}/workbench`;
  if (GUIDE_PAGES.includes(page) || page === null || page === "unknown") return "#/projects";
  return `#/p/${encodeURIComponent(projectId || "")}/${page}`;
}

/** 构造记录覆盖层 hash（§2.4：#/records/:id?project=:pid）。 */
export function recordHash(recordId, projectId) {
  const q = projectId ? `?project=${encodeURIComponent(projectId)}` : "";
  return `#/records/${encodeURIComponent(recordId)}${q}`;
}

/**
 * 创建路由句柄（外壳唯一持有；经 ctx.router 提供给页面）。
 *
 * handle = {
 *   hash, page, projectId, recordId, params, query,   // 当前值（稳定对象，导航后原位更新）
 *   open(hash)          // push（产生历史条目；同 hash 幂等）
 *   replace(hash)       // replace（不产生历史条目；用于重定向/落列表态）
 *   back(fallbackHash)  // §2.4-2：有应用内前驱 → history.back()，否则 replace(fallback)
 *   openRecord(id)      // open(recordHash(id, 当前项目))
 *   isInAppHistory()    // navLog 深度 >1（存在应用内前驱）
 *   onChange(fn) => unsub
 * }
 */
export function createRouter({ win, initialHash } = {}) {
  const w = win || (typeof window !== "undefined" ? window : null);
  if (!w || !w.location || !w.history) {
    throw new Error("createRouter 需要 window（含 location/history）；测试请注入假 window");
  }

  const listeners = new Set();
  /** 应用内导航记账：navLog[0..n-1] 为会话内应用内 hash 序列（含当前）。 */
  let navLog = [];

  const handle = {
    hash: "",
    page: null,
    projectId: null,
    recordId: null,
    params: {},
    query: {},
  };

  function applyHash(hash) {
    const parsed = parseHash(hash);
    handle.hash = parsed.raw || "#";
    handle.page = parsed.page;
    handle.projectId = parsed.projectId;
    handle.recordId = parsed.recordId;
    handle.params = parsed.params;
    handle.query = parsed.query;
  }

  function syncNavLogOnHashChange(newHash) {
    // 浏览器返回/前进：新 hash 与倒数第二个应用内条目一致 → 回退弹栈；
    // 其余（open/push、replace 后的首帧、外站跳入）→ 作为新应用内条目。
    if (navLog.length >= 2 && navLog[navLog.length - 2] === newHash) {
      navLog = navLog.slice(0, -1);
    } else if (navLog[navLog.length - 1] !== newHash) {
      navLog = [...navLog, newHash];
    }
  }

  function notify() {
    for (const fn of Array.from(listeners)) {
      try { fn(handle); } catch { /* 单个监听者异常不拖垮路由 */ }
    }
  }

  function onHashChange() {
    const hash = w.location.hash || "#";
    syncNavLogOnHashChange(hash);
    applyHash(hash);
    notify();
  }

  if (typeof w.addEventListener === "function") {
    w.addEventListener("hashchange", onHashChange);
  }
  // 初始帧：不入 navLog 记账（首条即当前），保证深链直开详情时关闭 → replace。
  const startHash = initialHash !== undefined ? initialHash : (w.location.hash || "#");
  navLog = [startHash];
  applyHash(startHash);

  handle.open = function open(hash) {
    const next = String(hash || "");
    if (next === (w.location.hash || "#")) return;
    // push 语义：赋值 location.hash 产生历史条目；hashchange 监听统一走
    // onHashChange（真实浏览器按事件语义触发；测试假 window 同步派发）。
    w.location.hash = next;
  };

  handle.replace = function replace(hash) {
    const next = String(hash || "#");
    try {
      w.history.replaceState(null, "", next);
    } catch {
      w.location.hash = next;
    }
    navLog = [next];
    applyHash(next);
    notify();
  };

  handle.isInAppHistory = function isInAppHistory() {
    return navLog.length >= 2;
  };

  handle.back = function back(fallbackHash) {
    if (navLog.length >= 2) {
      w.history.back();
      // history.back() 触发 hashchange（真实浏览器）；无事件环境由测试驱动。
      return;
    }
    handle.replace(fallbackHash || "#/projects");
  };

  handle.openRecord = function openRecord(recordId) {
    if (typeof recordId !== "string" || !recordId.trim()) return;
    handle.open(recordHash(recordId, handle.projectId));
  };

  handle.onChange = function onChange(fn) {
    if (typeof fn !== "function") return () => {};
    listeners.add(fn);
    return () => listeners.delete(fn);
  };

  handle.__test__ = {
    navLog: () => [...navLog],
    simulateHashChange: (hash) => onHashChange(hash),
  };

  return handle;
}
