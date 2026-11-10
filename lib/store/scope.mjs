/**
 * C2 —— Tool Gateway 范围与执行条件（规范 §17）。
 *
 * 合同落实（§17 逐条）：
 *   - 发现建档与主动访问分开：本模块只判定「能否采集/可测试」；发现记录
 *     （register_asset）不经本模块（A1 面向发现，不校验范围）。
 *   - 范围采用版本化配置（scope_revisions，A1 存储）：区分 allow / deny / pending；
 *     明确拒绝规则优先；缺少目标范围不能默认为任意目标可操作
 *     （SCOPE_UNRESOLVED）。
 *   - source_type=official 或模型自报来源不能绕过授权：本模块只读取项目当前
 *     范围版本的规则，忽略工具参数里任何「来源/官方」自报字段。
 *   - 派发时（意图目标资产）与每次工具执行前（逐目标）校验；重定向或工具
 *     内部展开的新目标必须作为新的目标集/新调用再次过闸（逐跳校验）。
 *   - 范围变化立即影响新动作（每次判定读当前 scope_revisions）；已发出操作
 *     不假装撤回，由 complete 记录实际结果并附 touched_targets 的事后判定。
 *
 * 规则条目形态（A1 validateScopeRules 允许字符串或对象）与匹配语义（本模块定义）：
 *   - 字符串 "example.com"        → 主机条目：匹配该主机的任意 scheme/端口/路径；
 *   - 字符串 "*.example.com"      → 通配主机：匹配任意层级子域（不含裸域）；
 *   - 字符串 "https://example.com[:port][/p][/ *]" → URL 条目：约束 scheme+host
 *     +端口（缺省按 scheme 默认端口）+路径前缀（"/" 表示任意路径；路径以 "/*"
 *     结尾时按前缀通配，如 "/v1/*" 匹配 /v1、/v1/ 与 /v1/ 下任意路径）；
 *   - 对象 { host, scheme?, port?, path_prefix? } → 结构化条目，未给出字段为通配。
 *   目标形态：绝对 URL（带 scheme）或裸主机名。裸主机目标只匹配主机条目与
 *   未约束 scheme/port 的对象条目；URL 条目对裸主机目标判为不匹配
 *   （无法核实 scheme/端口 → 待判断，不默认放行）。
 *
 * 安全语义（P0-5，DeepSeek 评审 §7a）：URL 条目必须比对 host——字符串规则
 * 只写了 scheme/端口/路径而未写主机时，按规则内主机判定；规则主机与目标主机
 * 不一致一律不匹配（deny 不跨 host 误拒、pending 不跨 host 误标、allow 不跨
 * host 放行）。主机通配 "*.base" 仅作用于裸主机条目与对象条目（URL 条目内
 * 的 "*.host" 不展开，按字面主机处理 → 与任何目标都不相等，保持「子域通配
 * 仅作用于裸主机/对象规则」的现状语义）。
 *
 * 程序只做规范交给程序的范围判定（§3.2）；范围规则的语义（是否应该收缩、
 * 待判断项如何处置）由用户与 AI 决定，本模块不修改范围规则。
 */
import { apiError } from "../errors.mjs";

/* ── 目标解析 ─────────────────────────────────────────────────────── */

/** 解析目标字符串：绝对 URL 或裸主机。无法解析返回 null。 */
export function parseTarget(target) {
  if (typeof target !== "string") return null;
  const text = target.trim();
  if (!text || text.length > 2048) return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(text)) {
    let u;
    try {
      u = new URL(text);
    } catch {
      return null;
    }
    const scheme = u.protocol.replace(":", "").toLowerCase();
    const host = u.hostname.toLowerCase() || (scheme === "file" ? "localhost" : "");
    if (!host) return null;
    return {
      kind: "url",
      scheme,
      host,
      port: portOf(u),
      path: u.pathname || "/",
    };
  }
  // 裸主机：含点或 localhost 或 [IPv6]
  if (/^[a-zA-Z0-9_.-]+$/.test(text) && (text.includes(".") || text === "localhost")) {
    return { kind: "host", scheme: null, host: text.toLowerCase(), port: null, path: null };
  }
  if (/^\[[0-9a-fA-F:.]+\]$/.test(text)) {
    return { kind: "host", scheme: null, host: text.toLowerCase(), port: null, path: null };
  }
  return null;
}

function portOf(url) {
  if (url.port) return Number(url.port);
  if (url.protocol === "https:") return 443;
  if (url.protocol === "http:") return 80;
  return null;
}

/* ── 规则匹配 ─────────────────────────────────────────────────────── */

function hostMatches(pattern, host) {
  if (pattern.startsWith("*.")) {
    const base = pattern.slice(2).toLowerCase();
    return host.endsWith(`.${base}`) && host.length > base.length + 1; // 子域，不含裸域
  }
  return host === pattern.toLowerCase();
}

/** 单条规则是否匹配已解析目标；畸形规则（对象缺 host）不匹配。 */
export function matchScopeRule(entry, parsed) {
  if (typeof entry === "string") {
    const text = entry.trim();
    if (!text) return false;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(text)) {
      if (parsed.kind !== "url") return false; // URL 条目不匹配裸主机目标（无法核实 scheme/端口）
      let u;
      try {
        u = new URL(text);
      } catch {
        return false;
      }
      // P0-5：URL 条目必须比对 host——规则主机与目标主机不一致一律不匹配
      // （跨 host 的 deny/pending/allow 均不得命中；主机通配不作用于 URL 条目）
      const ruleScheme = u.protocol.replace(":", "").toLowerCase();
      const ruleHost = u.hostname.toLowerCase() || (ruleScheme === "file" ? "localhost" : "");
      if (ruleHost !== parsed.host) return false;
      if (ruleScheme !== parsed.scheme) return false;
      if (portOf(u) !== parsed.port) return false;
      // 路径前缀；以 "/*" 结尾按前缀通配（/v1/* 匹配 /v1、/v1/ 与 /v1/ 下路径）
      const rawPath = u.pathname || "/";
      if (rawPath.endsWith("/*")) {
        const base = rawPath.slice(0, -2);
        if (base === "" || base === "/") return true; // "https://host/*" → 该主机任意路径
        const norm = base.length > 1 && base.endsWith("/") ? base.slice(0, -1) : base;
        return parsed.path === norm || parsed.path.startsWith(`${norm}/`);
      }
      const prefix = rawPath && rawPath !== "/" ? rawPath : "/";
      return parsed.path === prefix || parsed.path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`);
    }
    return hostMatches(text, parsed.host);
  }
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    if (typeof entry.host !== "string" || !entry.host.trim()) return false;
    if (!hostMatches(entry.host.trim(), parsed.host)) return false;
    if (entry.scheme !== undefined && entry.scheme !== null) {
      if (parsed.kind !== "url") return false;
      if (String(entry.scheme).toLowerCase() !== parsed.scheme) return false;
    }
    if (entry.port !== undefined && entry.port !== null) {
      if (parsed.kind !== "url" || parsed.port !== Number(entry.port)) return false;
    }
    if (typeof entry.path_prefix === "string" && entry.path_prefix && entry.path_prefix !== "/") {
      if (parsed.kind !== "url") return false;
      if (!(parsed.path === entry.path_prefix || parsed.path.startsWith(entry.path_prefix))) return false;
    }
    return true;
  }
  return false;
}

/* ── 版本化范围判定（§17） ────────────────────────────────────────── */

function loadRules(db, projectId) {
  const project = db.prepare("SELECT current_scope_revision FROM projects WHERE id = ?").get(projectId);
  if (!project || !project.current_scope_revision) {
    return { configured: false, revisionId: null, rules: null };
  }
  const row = db
    .prepare("SELECT * FROM scope_revisions WHERE project_id = ? AND id = ?")
    .get(projectId, project.current_scope_revision);
  if (!row) return { configured: false, revisionId: null, rules: null };
  let rules = null;
  try {
    rules = JSON.parse(row.rules);
  } catch {
    rules = null;
  }
  return { configured: true, revisionId: row.id, revision: row.revision, rules };
}

/**
 * 判定单个目标对当前范围版本的裁决。
 * 返回 { target, verdict: allowed|denied|pending, matched, scope_revision_id,
 *        configured, reason }；reason ∈
 *   denied_by_rule / allowed_by_rule / explicit_pending / unlisted /
 *   unconfigured / unparseable。
 */
export function evaluateTarget(db, { projectId, target }) {
  const scope = loadRules(db, projectId);
  const base = {
    target,
    scope_revision_id: scope.revisionId,
    scope_revision: scope.revision ?? null,
    configured: scope.configured,
  };
  const parsed = parseTarget(target);
  if (!parsed) {
    return { ...base, verdict: "pending", matched: null, reason: "unparseable" };
  }
  if (!scope.configured || !scope.rules) {
    // §17：缺少目标范围不能默认为任意目标均可操作
    return { ...base, verdict: "pending", matched: null, reason: "unconfigured" };
  }
  const deny = Array.isArray(scope.rules.deny) ? scope.rules.deny : [];
  const allow = Array.isArray(scope.rules.allow) ? scope.rules.allow : [];
  const pending = Array.isArray(scope.rules.pending) ? scope.rules.pending : [];
  // 判定顺序（§17「明确拒绝规则优先」+ 显式待判断先于一般允许）：
  //   deny（任何命中即拒绝，即使 allow/pending 也命中）
  //   → pending（显式待判断压过通配 allow：用户明确标未决的目标不得被泛 allow 放行）
  //   → allow → 未列出（unlisted，同样按待判断处理，不默认可操作）
  for (const entry of deny) {
    if (matchScopeRule(entry, parsed)) {
      return { ...base, verdict: "denied", matched: entry, reason: "denied_by_rule" };
    }
  }
  for (const entry of pending) {
    if (matchScopeRule(entry, parsed)) {
      return { ...base, verdict: "pending", matched: entry, reason: "explicit_pending" };
    }
  }
  for (const entry of allow) {
    if (matchScopeRule(entry, parsed)) {
      return { ...base, verdict: "allowed", matched: entry, reason: "allowed_by_rule" };
    }
  }
  return { ...base, verdict: "pending", matched: null, reason: "unlisted" };
}

/** 动作前逐目标校验（§17 派发与动作前、逐跳）：denied → SCOPE_DENIED；pending → SCOPE_UNRESOLVED。 */
export function checkActionTargets(db, { projectId, targets, phase }) {
  const list = Array.isArray(targets) ? targets : [targets];
  const results = [];
  for (const target of list) {
    const verdict = evaluateTarget(db, { projectId, target });
    results.push(verdict);
    if (verdict.verdict === "denied") {
      throw apiError(
        "SCOPE_DENIED",
        `目标 ${target} 在明确拒绝范围内（${phase}被拒绝；范围版本 ${verdict.scope_revision ?? "未配置"}）`,
        {
          retryable: false,
          detail: { target, matched: verdict.matched, scope_revision: verdict.scope_revision, phase },
          next_requirements: ["该目标不得执行；如属误配需要用户修订范围版本（POST /scope-revisions）"],
        },
      );
    }
    if (verdict.verdict === "pending") {
      const reasonText = {
        unconfigured: "项目尚未配置任何范围版本",
        unlisted: "目标不在允许清单，也未明确拒绝（待判断）",
        explicit_pending: "目标被列为待判断",
        unparseable: "目标不是可判定的 URL 或主机名",
      }[verdict.reason] || verdict.reason;
      throw apiError(
        "SCOPE_UNRESOLVED",
        `目标 ${target} 范围未判定：${reasonText}（缺少目标范围不能默认为任意目标均可操作，§17）`,
        {
          retryable: false,
          detail: { target, reason: verdict.reason, scope_revision: verdict.scope_revision, phase },
          next_requirements: ["由用户修订范围版本（allow 该目标或明确拒绝）后再执行"],
        },
      );
    }
  }
  return results;
}

/* ── 派发面：意图目标资产 → 目标串（并回写 assets.scope_status） ──── */

/** 资产编号 → 可判定目标串；不可解析返回 null（交由动作层逐跳校验兜底）。 */
export function targetOfAsset(asset) {
  const key = typeof asset.canonical_key === "string" ? asset.canonical_key.trim() : "";
  if (!key) return null;
  const urlLike = parseTarget(key);
  if (!urlLike) return null;
  return key;
}

/**
 * 把意图目标资产的当前范围判定持久化到 assets.scope_status（独立小事务，
 * 不随派发事务回滚——范围决策记录与派发成败解耦；派发事务内的权威校验
 * 仍以当前范围版本为准）。无目标资产的意图为空操作。
 */
export function persistAssetScopeVerdicts(db, { projectId, intent }) {
  let ids = [];
  try {
    ids = Array.isArray(intent.target_asset_ids)
      ? intent.target_asset_ids
      : JSON.parse(intent.target_asset_ids || "[]");
  } catch {
    ids = [];
  }
  const out = [];
  for (const assetId of ids) {
    const asset = db.prepare("SELECT * FROM assets WHERE project_id = ? AND id = ?").get(projectId, assetId);
    if (!asset) continue;
    const target = targetOfAsset(asset);
    if (!target) continue;
    const verdict = evaluateTarget(db, { projectId, target });
    db.prepare("UPDATE assets SET scope_status = ? WHERE id = ?").run(verdict.verdict, assetId);
    out.push({ asset_id: assetId, verdict: verdict.verdict });
  }
  return out;
}

/**
 * 派发时范围校验（§17「派发时……校验范围」）：
 * 对意图全部目标资产逐个判定；denied → SCOPE_DENIED、pending → SCOPE_UNRESOLVED
 * （意图目标里存在不可判定资产时派发被拒——缺范围不默认可操作）；同时把判定
 * 结果回写 assets.scope_status（allowed/denied/pending，DDL 列即此三态）。
 * 无可判定目标的意图放行（附 warnings），动作层仍逐目标过闸。
 */
export function checkIntentTargets(db, { projectId, intent }) {
  let ids = [];
  try {
    ids = Array.isArray(intent.target_asset_ids)
      ? intent.target_asset_ids
      : JSON.parse(intent.target_asset_ids || "[]");
  } catch {
    ids = [];
  }
  const warnings = [];
  const checked = [];
  const skipped = [];
  for (const assetId of ids) {
    const asset = db
      .prepare("SELECT * FROM assets WHERE project_id = ? AND id = ?")
      .get(projectId, assetId);
    if (!asset) {
      throw apiError("INVALID_REFERENCE", `意图 ${intent.id} 的目标资产不存在：${assetId}`, {
        next_requirements: ["修正意图目标（C1 计划修订）后重新派发"],
      });
    }
    const target = targetOfAsset(asset);
    if (!target) {
      skipped.push({ asset_id: assetId, note: "canonical_key 无法解析为可判定目标；动作层仍逐目标校验" });
      continue;
    }
    const verdict = evaluateTarget(db, { projectId, target });
    db.prepare("UPDATE assets SET scope_status = ? WHERE id = ?").run(
      verdict.verdict === "allowed" ? "allowed" : verdict.verdict === "denied" ? "denied" : "pending",
      assetId,
    );
    checked.push({ asset_id: assetId, target, ...verdict });
    if (verdict.verdict === "denied") {
      throw apiError(
        "SCOPE_DENIED",
        `意图 ${intent.id} 的目标 ${target}（${assetId}）在明确拒绝范围内，拒绝派发（§17 拒绝优先）`,
        {
          retryable: false,
          detail: { asset_id: assetId, target, matched: verdict.matched, scope_revision: verdict.scope_revision },
          next_requirements: ["该意图不得对该目标执行；需要用户修订范围或 planner 调整意图目标"],
        },
      );
    }
    if (verdict.verdict === "pending") {
      throw apiError(
        "SCOPE_UNRESOLVED",
        `意图 ${intent.id} 的目标 ${target}（${assetId}）范围未判定（${verdict.reason}），拒绝派发：缺少目标范围不能默认任意目标均可操作（§17）`,
        {
          retryable: false,
          detail: { asset_id: assetId, target, reason: verdict.reason, scope_revision: verdict.scope_revision },
          next_requirements: ["用户修订范围版本（明确 allow 或 deny）后重新派发"],
        },
      );
    }
  }
  if (skipped.length) {
    warnings.push(
      `意图 ${intent.id} 有 ${skipped.length} 个目标资产无法解析为可判定目标（${skipped
        .map((s) => s.asset_id)
        .join("、")}）；派发放行，工具动作层仍会逐目标校验（§17 逐跳）`,
    );
  }
  return { checked, skipped, warnings };
}
