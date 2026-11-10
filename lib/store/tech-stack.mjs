/**
 * 分层技术栈画像（product → version → evidence）。
 *
 * 背景：技术栈原先按「每条指纹一行资产」平铺展示，同一产品会因入口/模板/
 * 「版本未知」等描述差异被拆成多条并列资产（如多个「通达OA」），既无法表达
 * 版本层级，也让 AI 与用户看到的是重复条目而不是产品画像。
 *
 * 本模块只做**只读派生**，不改写资产记录、不新增表：
 *   - 资产记录仍是唯一事实（每条指纹/版本线索保留原编号与证据）；
 *   - 读时把 product/technology 资产规范化为「产品 → 版本 → 证据」三层树，
 *     同一产品的多条记录合并到同一个产品节点下，版本未知显式标为「版本未知」；
 *   - 树同时供 UI（可展开/下钻）与 AI 供给面（planner_view / asset_map / recon）
 *     使用：上层是摘要节点（产品/版本 + 计数），叶子是原始资产编号，按需展开。
 *
 * 这一形状对应两类论文的核心结构：
 *   - PentestGPT 的 Pentesting Task Tree（PTT）：高层摘要 + 可展开子任务，
 *     同一棵树既给人看也给模型读；
 *   - MemWalker 的记忆树：非叶节点是摘要、叶节点是原始片段，交互式下钻，
 *     展开后才读取明细。
 *
 * canonical_key 约定（新写入）：`产品@版本`（版本未知写 `产品@unknown`），
 * 入口/模板/证据等描述放 original_input；历史自由文本（如
 * 「通达OA (Tongda MYOA) 2015版模板」「nginx（版本未披露）」）由本模块兼容解析。
 * 任何解析都是**展示层归并**：不删除、不改写、不合并资产行。
 */

export const TECH_ASSET_TYPES = Object.freeze([
  "product",
  "technology",
  "technique",
  "framework",
  "middleware",
  "language",
  "database",
  "web_server",
]);

const TECH_TYPE_SET = new Set(TECH_ASSET_TYPES);

const UNKNOWN_VERSION_RE =
  /(版本\s*(?:未知|未披露|不明|未识别|未详)|版本号?\s*(?:未知|未披露)|unknown(?:\s+version)?|version\s+unknown)/i;

const VERSION_PATTERNS = [
  /(?:^|[\s（(])v?(\d{4})\s*版/i, // 2015版
  /(?:^|[\s（(])v(\d+(?:\.\d+){0,3})(?![\d.])/i, // v1.2
  /(?:^|[\s（(])(\d+\.x)(?![\d.])/i, // 3.x
  /(?:^|[\s（(])(\d+(?:\.\d+){1,3})(?![\d.])/, // 1.2.3
  /(?:^|[\s（(])version[\s:：]*(\d+(?:\.\d+){0,3})/i, // version: 1.2
];

const DESCRIPTOR_MARKER_RE =
  /(版本\s*(?:未知|未披露|不明|未识别|未详|号)?|Web\s*登录入口|登录入口|入口|页面|接口|模板|服务|中间件|框架|组件|运行时|应用软件|版模板)/i;

function cleanSpace(text) {
  return String(text ?? "")
    .replace(/[\u3000\t\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s\-—–:：,，;；·|/]+|[\s\-—–:：,，;；·|/]+$/g, "")
    .trim();
}

function productKeyOf(name) {
  return cleanSpace(name)
    .toLowerCase()
    .replace(/[\s\-—–_/\\()（）:：·.,，;；'"“”‘’]+/g, "");
}

function extractVersion(text) {
  for (const re of VERSION_PATTERNS) {
    const m = re.exec(text);
    if (m && m[1]) return { version: String(m[1]).replace(/^v/i, ""), index: m.index, length: m[0].length };
  }
  return null;
}

function dedupeStrings(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const raw = cleanSpace(item);
    if (!raw) continue;
    const key = raw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(raw);
  }
  return out;
}

/**
 * 把单条 product/technology 资产解析为产品/版本/描述。
 * 解析失败不猜测：保留原文作为产品名，版本标未知。
 */
export function normalizeTechAsset(asset) {
  const raw = cleanSpace(asset && asset.canonical_key);
  const rawInput = cleanSpace(asset && asset.original_input);
  const base = {
    asset_id: asset && asset.id ? String(asset.id) : "",
    asset_type: asset && asset.asset_type ? String(asset.asset_type) : "",
    raw,
    raw_input: rawInput,
    scope_status: asset ? asset.scope_status ?? null : null,
    created_seq: Number.isFinite(asset && asset.created_seq) ? asset.created_seq : 0,
    product: raw,
    product_key: productKeyOf(raw),
    aliases: [],
    version: "",
    version_key: "unknown",
    version_label: "版本未知",
    unknown_version: true,
    descriptor: "",
    clean: true,
  };
  if (!raw) return base;

  // 1) 显式 `产品@版本` 约定优先（新写入规范；版本未知写 @unknown）
  let text = raw;
  let atVersion = "";
  const atMatch = /^(.*?)@([^@]*)$/.exec(text);
  if (atMatch && atMatch[1].trim()) {
    text = atMatch[1];
    atVersion = cleanSpace(atMatch[2]);
  }

  // 2) 括注：版本/未知标记进版本维度，其余作为产品别名（如 Tongda2000 MYOA）
  const aliases = [];
  let unknownMarked = false;
  text = text.replace(/[（(]([^（）()]*)[）)]/g, (_m, inner) => {
    const inside = cleanSpace(inner);
    if (!inside) return " ";
    if (UNKNOWN_VERSION_RE.test(inside)) {
      unknownMarked = true;
      return " ";
    }
    const v = extractVersion(inside);
    if (v) {
      if (!atVersion) atVersion = v.version;
      return " ";
    }
    aliases.push(inside);
    return " ";
  });

  // 3) 版本：@ 约定 > 括号 > 正文；从正文中移除版本 token，避免污染产品名
  let version = atVersion;
  if (version && /^(unknown|未知|未披露|不明)$/i.test(version)) {
    unknownMarked = true;
    version = "";
  }
  if (!version) {
    const found = extractVersion(text);
    if (found) {
      version = found.version;
      text = text.slice(0, found.index) + " " + text.slice(found.index + found.length);
    }
  }
  if (!version && UNKNOWN_VERSION_RE.test(raw)) unknownMarked = true;

  // 4) 描述词（入口/模板/版本未知…）从标记处切开；标记之前是产品名
  let productRaw = text;
  let descriptor = "";
  const marker = DESCRIPTOR_MARKER_RE.exec(text);
  if (marker && marker.index > 0) {
    productRaw = text.slice(0, marker.index);
    descriptor = text.slice(marker.index);
  } else if (marker && marker.index === 0) {
    descriptor = text;
    productRaw = "";
  }
  productRaw = cleanSpace(productRaw);
  descriptor = cleanSpace(
    descriptor
      .replace(UNKNOWN_VERSION_RE, " ")
      .replace(/\b版本\b/g, " ")
      .replace(/版模板/g, "模板"),
  );
  if (!productRaw) productRaw = cleanSpace(raw.replace(/[（(][^）)]*[）)]/g, " "));
  if (!productRaw) productRaw = raw;

  const unknownVersion = !version;
  return {
    ...base,
    product: productRaw,
    product_key: productKeyOf(productRaw) || productKeyOf(raw),
    aliases: dedupeStrings(aliases),
    version,
    version_key: version ? version.toLowerCase() : "unknown",
    version_label: version ? `版本 ${version}` : "版本未知",
    unknown_version: unknownVersion,
    descriptor,
    clean: !version && !descriptor && aliases.length === 0,
    unknown_marked: unknownMarked,
  };
}

function compareVersion(a, b) {
  if (a.unknown_version !== b.unknown_version) return a.unknown_version ? 1 : -1;
  if (a.version_key === b.version_key) return 0;
  const na = Number.parseFloat(a.version_key);
  const nb = Number.parseFloat(b.version_key);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return a.version_key.localeCompare(b.version_key);
}

function itemView(parsed) {
  return {
    id: parsed.asset_id,
    asset_type: parsed.asset_type,
    canonical_key: parsed.raw,
    original_input: parsed.raw_input,
    descriptor: parsed.descriptor,
    scope_status: parsed.scope_status,
    created_seq: parsed.created_seq,
    version: parsed.version || null,
    unknown_version: parsed.unknown_version,
  };
}

/**
 * 构建分层技术栈树。纯函数：输入资产行，输出产品/版本/证据三层派生视图。
 * 不修改输入；同一产品的多条资产合并到同产品节点下（记录仍各自保留）。
 */
export function buildTechStack(assets, options = {}) {
  const productLimit = Number.isInteger(options.productLimit) && options.productLimit > 0 ? options.productLimit : 50;
  const itemsPerVersion =
    Number.isInteger(options.itemsPerVersion) && options.itemsPerVersion > 0 ? options.itemsPerVersion : 12;
  const rows = Array.isArray(assets) ? assets : [];
  const techRows = rows.filter((a) => a && TECH_TYPE_SET.has(String(a.asset_type)));
  const parsedRows = techRows.map((a) => normalizeTechAsset(a));

  const byProduct = new Map();
  for (const parsed of parsedRows) {
    const key = parsed.product_key || parsed.raw || "unknown";
    if (!byProduct.has(key)) byProduct.set(key, []);
    byProduct.get(key).push(parsed);
  }

  const products = [];
  for (const [key, list] of byProduct) {
    list.sort((a, b) => a.created_seq - b.created_seq || a.asset_id.localeCompare(b.asset_id));
    const display =
      list.find((p) => p.clean)?.product ||
      list.slice().sort((a, b) => a.product.length - b.product.length || a.created_seq - b.created_seq)[0]
        .product ||
      list[0].raw;
    const aliases = dedupeStrings(list.flatMap((p) => p.aliases));
    const versionsMap = new Map();
    for (const parsed of list) {
      const vkey = parsed.version_key;
      if (!versionsMap.has(vkey)) versionsMap.set(vkey, []);
      versionsMap.get(vkey).push(parsed);
    }
    const versions = [...versionsMap.entries()]
      .map(([vkey, items]) => {
        items.sort((a, b) => a.created_seq - b.created_seq || a.asset_id.localeCompare(b.asset_id));
        const sample = items.slice(0, itemsPerVersion);
        const first = items[0];
        return {
          key: vkey,
          version: first.version || null,
          label: first.version_label,
          unknown_version: first.unknown_version,
          asset_ids: items.map((i) => i.asset_id),
          count: items.length,
          items: sample.map(itemView),
          omitted: Math.max(0, items.length - sample.length),
          omitted_note:
            items.length > sample.length
              ? `本版本仅列前 ${sample.length} 条，其余 ${items.length - sample.length} 条经资产编号读取（不静默截断）`
              : undefined,
        };
      })
      .sort(compareVersion);
    const assetIds = list.map((p) => p.asset_id);
    const unknownCount = versions.filter((v) => v.unknown_version).reduce((n, v) => n + v.count, 0);
    products.push({
      key,
      product: display,
      aliases,
      asset_ids: assetIds,
      primary_asset_id: (list.find((p) => p.clean) || list[0]).asset_id,
      count: list.length,
      version_count: versions.length,
      unknown_version_count: unknownCount,
      versions,
      summary:
        `${versions.length} 个版本 · ${list.length} 条线索` +
        (unknownCount > 0 ? `（其中 ${unknownCount} 条版本未知）` : ""),
    });
  }
  products.sort((a, b) => {
    const as = Math.min(...a.asset_ids.map((id) => parsedRows.find((p) => p.asset_id === id)?.created_seq ?? 0));
    const bs = Math.min(...b.asset_ids.map((id) => parsedRows.find((p) => p.asset_id === id)?.created_seq ?? 0));
    return as - bs || a.product.localeCompare(b.product);
  });

  const kept = products.slice(0, productLimit);
  const versionNodes = kept.reduce((n, p) => n + p.version_count, 0);
  const unknownVersionNodes = kept.reduce(
    (n, p) => n + p.versions.filter((v) => v.unknown_version).length,
    0,
  );
  return {
    schema_version: 1,
    products: kept,
    summary: {
      products: products.length,
      version_nodes: versionNodes,
      raw_assets: parsedRows.length,
      merged_rows: Math.max(0, parsedRows.length - products.length),
      unknown_version_nodes: unknownVersionNodes,
      truncated_products: Math.max(0, products.length - kept.length),
    },
    note:
      "同一产品的多条指纹/版本线索合并为产品节点（记录不删除、不改写）；版本未知显式标注；叶节点可按资产编号继续展开原始证据。",
  };
}

/** 面向模型/文档的紧凑文本（摘要节点 + 资产编号；不铺开全部原始字段）。 */
export function renderTechStackLines(tree, options = {}) {
  const maxChars = Number.isInteger(options.maxChars) && options.maxChars > 0 ? options.maxChars : 1400;
  const lines = [];
  if (!tree || !Array.isArray(tree.products) || tree.products.length === 0) return "";
  const s = tree.summary || {};
  lines.push(
    `技术栈画像（产品 → 版本 → 证据）：产品 ${s.products ?? tree.products.length} · 版本节点 ${s.version_nodes ?? 0} · 原始条目 ${s.raw_assets ?? 0}` +
      `（同产品合并 ${s.merged_rows ?? 0} 条；版本未知节点 ${s.unknown_version_nodes ?? 0} 个）`,
  );
  for (const p of tree.products) {
    const alias = p.aliases && p.aliases.length ? `（别名：${p.aliases.join("、")}）` : "";
    lines.push(
      `- ${p.product}${alias}｜${p.version_count} 个版本 · ${p.count} 条线索｜产品资产 ${p.primary_asset_id}`,
    );
    for (const v of p.versions) {
      const ids = v.asset_ids.slice(0, 6).join("、") + (v.asset_ids.length > 6 ? `…共 ${v.asset_ids.length} 条` : "");
      lines.push(`  - ${v.label}（${v.count}）：${ids}`);
    }
  }
  let text = lines.join("\n");
  if (text.length > maxChars) {
    text = text.slice(0, maxChars - 1) + "…";
  }
  return text;
}

export const __test__ = { productKeyOf, extractVersion, cleanSpace };
