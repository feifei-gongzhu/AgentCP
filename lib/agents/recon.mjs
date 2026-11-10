/**
 * 只读侦察摘要（阶段 1 通用化）：从当前项目既有证据（captures/resources/blobs/assets）
 * 提炼结构化技术栈、指纹与已观测路径，供 Planner/Orchestrator 开场使用。
 *
 * 约束（阶段 1）：
 *   - 严禁写死特定项目 URL、主机或固定目标；只按 projectId 过滤本项目持久记录；
 *   - 每条提炼线索必须附带可追溯的证据或观察编号（source_refs / evidence）；
 *   - 产品级候选入口面仅在本项目证据实际命中对应产品指纹与路径样本时才生成，
 *     不把特定产品的候选入口硬塞给无关项目。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getStore } from "../store/record-service.mjs";
import { buildTechStack, renderTechStackLines } from "../store/tech-stack.mjs";

/** 已知产品级候选入口目录（仅在本项目证据命中对应产品且存在匹配路径样本时附带，非漏洞断言）。 */
const KNOWN_PRODUCT_SURFACES = [
  {
    match: /tongda|通达/i,
    surfaces: [
      { path: "/ispirit/interface/gateway.php", surfaces: "匿名 JSON/网关接口族", next: "用 http_request 对空体/最小 JSON POST 判定请求体是否被消费；对比 GET 基线" },
      { path: "/general/document/index.php/", surfaces: "公文/文件操作入口（PATH_INFO）", next: "验证 PATH_INFO 文件读取/包含/路径穿越行为；比较同路径基线" },
      { path: "/module/", surfaces: "模块入口（未授权模块/上传面）", next: "只探测正文逐字引用的模块名；判定匿名可达与上传面" },
      { path: "/portal/", surfaces: "门户入口（匿名渲染）", next: "判定查询/表单参数是否进入正文；反射/模板/注入前件" },
      { path: "/static/", surfaces: "静态资源根（写入/上传面）", next: "PUT/POST 写入可逆标记并回读；判定应用层写权限" },
      { path: "/attachment", surfaces: "附件下载入口", next: "判定文件名/路径参数读取面（仅授权主机）" },
      { path: "/logincheck.php", surfaces: "登录校验入口", next: "无凭据不猜解；观察错误差异与字段回显面" },
    ],
  },
];

function decodeBest(bytes) {
  try {
    const utf8 = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { text: utf8, charset: "utf-8" };
  } catch {
    try {
      return { text: new TextDecoder("gbk").decode(bytes), charset: "gbk" };
    } catch {
      return { text: "", charset: "unknown" };
    }
  }
}

export async function buildReconSummary(pctx, projectId) {
  const store = await getStore(pctx);
  const db = store.db;
  const evidenceSet = new Set();
  const clues = [];
  const addClue = (kind, value, sourceRefs) => {
    const refs = (Array.isArray(sourceRefs) ? sourceRefs : [sourceRefs]).filter(Boolean);
    for (const r of refs) evidenceSet.add(r);
    clues.push({ kind, value, source_refs: refs });
  };

  const summary = {
    project_id: projectId,
    product: null,
    version: null,
    server: null,
    php: null,
    cookies: [],
    title: null,
    charset: null,
    template: null,
    registered_assets: [],
    observed_paths: [],
    candidate_surface: [],
    clues,
    evidence: [],
    note: "只读摘要：仅来自本项目既有 capture/resource/blob/asset，每条线索附 source_refs 证据编号；candidate_surface 仅在本项目证据命中对应产品时才附带",
  };

  try {
    // 0) 本项目已登记的产品/技术栈/服务资产（带真实资产编号）
    const assetRows = db
      .prepare(
        "SELECT id, asset_type, canonical_key, original_input, scope_status FROM assets WHERE project_id = ? ORDER BY created_seq LIMIT 40",
      )
      .all(projectId);
    summary.registered_assets = assetRows.map((a) => ({
      id: a.id,
      asset_type: a.asset_type,
      canonical_key: a.canonical_key,
      scope_status: a.scope_status,
      source_refs: [a.id],
    }));
    // 分层技术栈画像（产品 → 版本 → 证据）：Planner/Orchestrator 开场读同一棵树。
    const techAssets = db
      .prepare("SELECT * FROM assets WHERE project_id = ? ORDER BY created_seq, rowid")
      .all(projectId);
    const techTree = buildTechStack(techAssets);
    summary.tech_stack = { ...techTree, lines: renderTechStackLines(techTree) };
    for (const a of assetRows) {
      if ((a.asset_type === "product" || a.asset_type === "technology") && !summary.product) {
        summary.product = a.canonical_key;
        addClue("product_asset", a.canonical_key, [a.id]);
      }
    }

    // 1) 本项目采集正文（按当前项目 captures 扫描，不写死任何 URL）
    const capRows = db
      .prepare(
        `SELECT id, request_url_exact, method, response_body_blob, request_ref, response_headers_ref
           FROM captures WHERE project_id = ?
          ORDER BY CASE WHEN request_url_exact LIKE '%/' THEN 0 ELSE 1 END, created_seq
          LIMIT 25`,
      )
      .all(projectId);
    for (const cap of capRows) {
      if (!cap.response_body_blob) continue;
      const blob = db
        .prepare("SELECT id, stored_path FROM blobs WHERE project_id = ? AND id = ?")
        .get(projectId, cap.response_body_blob);
      if (!blob || !blob.stored_path) continue;
      try {
        const bytes = readFileSync(join(pctx.dataDir, blob.stored_path));
        const { text, charset } = decodeBest(bytes);
        if (!text) continue;
        const refs = [cap.id, blob.id];
        if (!summary.title) {
          const titleMatch = text.match(/<title>([^<]*)<\/title>/i);
          if (titleMatch && titleMatch[1].trim()) {
            summary.title = titleMatch[1].trim();
            summary.charset = charset;
            addClue("title", summary.title, refs);
          }
        }
        if (!summary.template) {
          const tmpl = text.match(/static\/templates\/(\d{4}_\d{2})/);
          if (tmpl) {
            summary.template = tmpl[1];
            addClue("template", summary.template, refs);
          }
        }
        if (!summary.product && /tongda|通达|网络智能办公/i.test(text)) {
          summary.product = "通达 OA（TongDa OA）";
          summary.version = summary.template || null;
          addClue("product", summary.product, refs);
          if (summary.version) addClue("version", summary.version, refs);
        }
      } catch {
        /* 单条采集文件读取失败忽略 */
      }
    }

    // 2) 本项目响应头指纹（server / x-powered-by / Set-Cookie 名），带 blob 与关联 capture 编号
    const headerBlobs = db
      .prepare(
        `SELECT b.id AS blob_id, b.stored_path,
                (SELECT c.id FROM captures c WHERE c.project_id = b.project_id AND (c.response_headers_ref = b.id OR c.response_body_blob = b.id OR c.request_ref = b.id) LIMIT 1) AS capture_id
           FROM blobs b
          WHERE b.project_id = ? AND b.representation = 'exchange_record'
          ORDER BY b.created_seq LIMIT 80`,
      )
      .all(projectId);
    for (const b of headerBlobs) {
      try {
        const j = JSON.parse(readFileSync(join(pctx.dataDir, b.stored_path), "utf8"));
        const headers = j.response && Array.isArray(j.response.headers) ? j.response.headers : [];
        const refs = [b.capture_id, b.blob_id].filter(Boolean);
        for (const h of headers) {
          const name = String(h.name || "").toLowerCase();
          if (name === "server" && !summary.server && h.value) {
            summary.server = h.value;
            addClue("server", h.value, refs);
          }
          if (name === "x-powered-by" && !summary.php && h.value) {
            summary.php = h.value;
            addClue("runtime", h.value, refs);
          }
          if (name === "set-cookie") {
            const cookieName = String(h.value || "").split("=")[0].trim();
            if (cookieName && !summary.cookies.includes(cookieName)) {
              summary.cookies.push(cookieName);
              addClue("cookie", cookieName, refs);
            }
            if (/phpsessid/i.test(cookieName) && !summary.php) {
              summary.php = "PHP（PHPSESSID 会话）";
              addClue("runtime", summary.php, refs);
            }
          }
        }
        if (summary.server && summary.php && summary.cookies.length) break;
      } catch {
        /* 单条解析失败忽略 */
      }
    }

    // 3) 本项目已观测路径（附带代表性资源样本编号 RES-…）
    const rows = db
      .prepare(
        `SELECT method, path_exact, COUNT(*) AS c, MIN(id) AS sample_resource_id
           FROM resources WHERE project_id = ?
          GROUP BY method, path_exact
          ORDER BY c DESC, path_exact LIMIT 40`,
      )
      .all(projectId);
    summary.observed_paths = rows.map((r) => {
      if (r.sample_resource_id) evidenceSet.add(r.sample_resource_id);
      return {
        method: r.method,
        path: r.path_exact,
        samples: r.c,
        source_refs: r.sample_resource_id ? [r.sample_resource_id] : [],
      };
    });

    // 4) 产品级已知面：仅当本项目证据识别出对应产品且存在匹配路径样本时才生成
    if (summary.product) {
      for (const catalog of KNOWN_PRODUCT_SURFACES) {
        if (!catalog.match.test(summary.product)) continue;
        for (const item of catalog.surfaces) {
          const hit = summary.observed_paths.find(
            (p) => p.path === item.path || p.path.startsWith(item.path),
          );
          if (hit) {
            summary.candidate_surface.push({
              ...item,
              status: "candidate_unverified",
              source_refs: hit.source_refs,
            });
          }
        }
      }
    }
    summary.evidence = [...evidenceSet];
  } catch (error) {
    summary.error = String(error?.message ?? error);
  }
  return summary;
}
