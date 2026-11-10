/**
 * D2 —— 资产身份与分层去重（规范 §7.1 §7.2 §7.3）。
 *
 * §7.1 确定性规范化：
 *   - 规范化规则必须版本化（CANONICALIZATION_VERSION），并保留原始输入
 *     （assets.original_input / resources.url_exact）；规范化升级需显式迁移，
 *     不在日常写入中悄悄改历史身份；
 *   - 只统一已明确等价的表示：scheme/host 大小写、默认端口表示；**不**普遍
 *     小写路径、不删查询参数、不重排参数、不任意解码路径（具体 HTTP 资源以
 *     method + 精确 URL 为身份，resources 表唯一键承载）；
 *   - IP 与域名通过观察到的解析关系相连（related_to + conditions.kind=
 *     dns_resolution），不自动合成一个资产。
 *
 * §7.2 模板只作为可修正判断：method+service+path_template 是候选接口族；
 * 具体样本（resources）永远保留；模板可确认/拆分/撤回（修改型，检查
 * expected_state_version），拆分移动成员但绝不清除样本与来源。
 *
 * §7.3 线索聚合与漏洞身份：asset+location+category 的 group_key 只用于查找
 * 候选组，不作为不可拆分的漏洞唯一键；确认重复时创建 duplicate_of /
 * equivalent_to 显式关系（保留原 ID/引用/证据）；误合并可拆分（移除成员 +
 * 撤回合并边），不删除被合并节点。
 *
 * 写入通道：经 A1 record-service 的 registerSubmissionOps 扩展点注册提交操作
 * （不改其文件）；编号带项目前缀（规避同库跨项目主键冲突，C1/A2 先例）。
 * 模板/资源/候选组编号（T-/RES-/CG- 复合前缀）不经 A1 的多态引用解析表，
 * 本模块内部自行校验存在性（竣工记录说明）。
 */
import { apiError } from "../errors.mjs";
import { registerSubmissionOps } from "./record-service.mjs";

/** §7.1 服务身份规范化规则版本（升级需显式迁移与映射，§7.1 末段）。 */
export const CANONICALIZATION_VERSION = "service-identity-v1";

/** §7.2 路径模板推导规则版本（哪些段折叠为参数属可修正规则，须可追溯）。 */
export const TEMPLATE_RULE_VERSION = "path-template-v1";

/* ── §7.1 规范化（纯函数，规则版本化；保留原始输入由调用方随行保存） ── */

const SCHEME_DEFAULT_PORTS = Object.freeze({ http: 80, https: 443 });

function isAscii(text) {
  return /^[\x00-\x7F]*$/.test(text);
}

/**
 * 服务身份规范化：统一 scheme/host 大小写与已明确等价的默认端口表示。
 * 不处理路径/查询（服务身份不含）；非 ASCII 主机保留原样（等价性未明确，
 * 不做 IDNA 推断）。IP 字面量（含 IPv6）原样保留为身份（小写），不与域名合并。
 */
export function canonicalizeServiceIdentity({ scheme, host, port } = {}) {
  if (typeof scheme !== "string" || !scheme.trim()) {
    throw apiError("BAD_REQUEST", "服务身份需要 scheme（如 https）");
  }
  if (typeof host !== "string" || !host.trim()) {
    throw apiError("BAD_REQUEST", "服务身份需要 host");
  }
  const normScheme = scheme.trim().toLowerCase();
  const rawHost = host.trim();
  let normHost;
  let bareHost = rawHost;
  const v6 = /^\[(.*)\]$/.exec(rawHost);
  if (v6) {
    bareHost = v6[1];
    normHost = `[${bareHost.toLowerCase()}]`;
  } else if (isAscii(rawHost)) {
    // 域名字母大小写在 DNS 语义下等价（§7.1「已明确等价的表示」范围）
    normHost = rawHost.toLowerCase();
  } else {
    normHost = rawHost; // 非 ASCII 主机不做等价推断，保留原样
  }
  let portNum = null;
  if (port !== undefined && port !== null && port !== "") {
    const n = typeof port === "number" ? port : Number(port);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      throw apiError("BAD_REQUEST", `端口必须是非零整数：${port}`);
    }
    portNum = n;
  }
  const defaultPort = SCHEME_DEFAULT_PORTS[normScheme] ?? null;
  const explicitDefault = portNum !== null && portNum === defaultPort;
  const portSuffix = portNum !== null && !explicitDefault ? `:${portNum}` : "";
  return {
    canonicalization_version: CANONICALIZATION_VERSION,
    canonical_key: `${normScheme}://${normHost}${portSuffix}`,
    service: {
      scheme: normScheme,
      host: normHost,
      port_effective: portNum ?? defaultPort,
      port_explicit_default: explicitDefault,
    },
  };
}

/**
 * 具体 HTTP 资源规范化：保留 method、精确路径（大小写/编码原样）、查询串
 * （顺序与重复参数原样）；fragment 不属于资源身份（不发送到服务端）。
 * url_exact 恒为原始输入串——同一服务下的不同精确 URL 是不同资源样本，
 * 参数值不因资产合并而丢失（§7.1）。
 */
export function canonicalizeHttpResource(url) {
  if (typeof url !== "string" || !url.trim()) {
    throw apiError("BAD_REQUEST", "资源登记需要 url");
  }
  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw apiError("BAD_REQUEST", `无法解析的 URL：${url}`);
  }
  if (!parsed.hostname) {
    throw apiError("BAD_REQUEST", `资源 URL 必须是含主机的绝对地址：${url}`);
  }
  const service = canonicalizeServiceIdentity({
    scheme: parsed.protocol.replace(/:$/, ""),
    host: parsed.hostname,
    port: parsed.port === "" ? null : Number(parsed.port),
  });
  return {
    canonicalization_version: CANONICALIZATION_VERSION,
    url_exact: url,
    path_exact: parsed.pathname,
    query_exact: parsed.search,
    service,
  };
}

/** §7.2 路径模板推导：数字/UUID/Hash 段折叠为参数占位；其余段原样保留。 */
export function derivePathTemplate(path) {
  if (typeof path !== "string" || !path.startsWith("/")) {
    throw apiError("BAD_REQUEST", `路径必须以 / 开头：${path}`);
  }
  const folded = [];
  const template = path
    .split("/")
    .map((seg) => {
      if (/^\d+$/.test(seg)) {
        folded.push(seg);
        return "{n}";
      }
      if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(seg)) {
        folded.push(seg);
        return "{uuid}";
      }
      if (/^[0-9a-fA-F]{32}$|^[0-9a-fA-F]{40}$|^[0-9a-fA-F]{64}$/.test(seg)) {
        folded.push(seg);
        return "{hash}";
      }
      return seg;
    })
    .join("/");
  return { path_template: template, rule_version: TEMPLATE_RULE_VERSION, folded_segments: folded };
}

/* ── 内部小工具（A1 同形实现；编号带项目前缀规避跨项目冲突） ───────── */

function allocateSeq(db, projectId, kind) {
  db.prepare(
    "INSERT INTO id_sequences (project_id, kind, next_val) VALUES (?, ?, 2) ON CONFLICT DO NOTHING",
  ).run(projectId, kind);
  const row = db
    .prepare("SELECT next_val AS n FROM id_sequences WHERE project_id = ? AND kind = ?")
    .get(projectId, kind);
  db.prepare("UPDATE id_sequences SET next_val = ? WHERE project_id = ? AND kind = ?").run(
    row.n + 1,
    projectId,
    kind,
  );
  return row.n;
}

function formatSeqId(prefix, projectId, n, width = 4) {
  return `${prefix}-${projectId}-${String(n).padStart(width, "0")}`;
}

function reqStr(op, field) {
  const v = op[field];
  if (typeof v !== "string" || !v.trim()) {
    throw apiError("BAD_REQUEST", `操作 ${op.op} 缺少必填字段 ${field}`);
  }
  return v;
}

function optStr(op, field) {
  const v = op[field];
  return typeof v === "string" ? v : "";
}

function truncate(text, max = 160) {
  const s = String(text);
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

/**
 * 插入关系边（§6.3：无通用去重键，条件与历史版本不被忽略）。
 * 与 A1 同形：新边事件包含端点信息（§15.5）；requires 边追发依赖变化事件。
 */
function insertRelationD2(
  ctx,
  { from, to, relation_type, conditions = "", requires_state = "", source = "" },
) {
  const id = formatSeqId("R", ctx.projectId, allocateSeq(ctx.db, ctx.projectId, "relation"));
  ctx.db
    .prepare(
      `INSERT INTO relations (id, project_id, from_id, to_id, relation_type, conditions,
         requires_state, source, valid_from_seq, created_at, created_by, created_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      ctx.projectId,
      from,
      to,
      relation_type,
      typeof conditions === "string" ? conditions : JSON.stringify(conditions ?? ""),
      requires_state,
      source,
      ctx.commitSeq,
      ctx.now,
      ctx.actor,
      ctx.commitSeq,
    );
  ctx.emit("relation.added", {
    subject_ids: [from, to],
    payload: { relation_id: id, from, to, relation_type, endpoints: { from, to } },
  });
  if (relation_type === "requires") {
    ctx.emit("dependency.changed", {
      subject_ids: [to],
      changed_fields: ["requires"],
      payload: { relation_id: id, from, to, change: "added" },
    });
  }
  return id;
}

/** §6.3：同一身份的并发创建用数据库唯一约束解决（INSERT OR IGNORE + 查回），不先查后插。 */
function ensureAsset(ctx, { asset_type, canonicalization_version, canonical_key, original_input }) {
  const candidateId = formatSeqId("A", ctx.projectId, allocateSeq(ctx.db, ctx.projectId, "asset"));
  const res = ctx.db
    .prepare(
      `INSERT OR IGNORE INTO assets (id, project_id, asset_type, canonicalization_version,
         canonical_key, original_input, created_at, created_by, created_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      candidateId,
      ctx.projectId,
      asset_type,
      canonicalization_version,
      canonical_key,
      original_input,
      ctx.now,
      ctx.actor,
      ctx.commitSeq,
    );
  if (res.changes === 1) return { id: candidateId, first: true };
  const row = ctx.db
    .prepare(
      `SELECT id FROM assets WHERE project_id = ? AND COALESCE(parent_asset_id, '') = ''
         AND asset_type = ? AND canonicalization_version = ? AND canonical_key = ?`,
    )
    .get(ctx.projectId, asset_type, canonicalization_version, canonical_key);
  return { id: row.id, first: false };
}

/* ── §7.1 操作：register_service_asset / register_http_resource / observe_resolution */

function opRegisterServiceAsset(ctx, op) {
  let originalInput = null;
  let normalized;
  if (typeof op.url === "string" && op.url.trim()) {
    // url 路径：canonicalizeHttpResource 已完成版本化规范化，直接取其结果
    const resource = canonicalizeHttpResource(op.url);
    normalized = resource.service;
    originalInput = op.url; // 原始输入保留（§7.1），规范化结果不覆盖它
  } else if (op.service && typeof op.service === "object") {
    normalized = canonicalizeServiceIdentity(op.service);
    originalInput = JSON.stringify(op.service);
  } else {
    throw apiError("BAD_REQUEST", "操作 register_service_asset 需要 url 或 service {scheme, host, port}");
  }
  const assetType = optStr(op, "asset_type") || "service";
  const { id, first } = ensureAsset(ctx, {
    asset_type: assetType,
    canonicalization_version: normalized.canonicalization_version,
    canonical_key: normalized.canonical_key,
    original_input: originalInput,
  });
  if (!first) {
    ctx.warnings.push(
      `服务身份已存在（${normalized.canonical_key}），按唯一约束归并为同一节点；首见原始输入已保留，不被本次输入覆盖（§7.1）`,
    );
  }
  if (op.local_ref) ctx.ids[op.local_ref] = id;
  ctx.emit("asset.discovered", {
    subject_ids: [id],
    payload: {
      asset_id: id,
      asset_type: assetType,
      canonicalization_version: normalized.canonicalization_version,
      canonical_key: normalized.canonical_key,
      first_discovery: first,
      source_note: optStr(op, "source_note"),
    },
  });
  if (op.discovered_from) {
    const src = ctx.resolveRef(op.discovered_from);
    const srcRow = locatePolymorphic(ctx, src);
    if (!srcRow) {
      throw apiError("INVALID_REFERENCE", `操作 register_service_asset 引用的 discovered_from 不存在：${src}`);
    }
    insertRelationD2(ctx, { from: id, to: src, relation_type: "discovered_from", source: "submission" });
  }
  return { id, canonical_key: normalized.canonical_key, first };
}

function opRegisterHttpResource(ctx, op) {
  const resource = canonicalizeHttpResource(reqStr(op, "url"));
  const method = (optStr(op, "method") || "GET").toUpperCase();
  const asset = ensureAsset(ctx, {
    asset_type: "service",
    canonicalization_version: resource.service.canonicalization_version,
    canonical_key: resource.service.canonical_key,
    original_input: `${resource.service.canonical_key}/`,
  });
  const candidateId = formatSeqId("RES", ctx.projectId, allocateSeq(ctx.db, ctx.projectId, "resource"));
  const res = ctx.db
    .prepare(
      `INSERT OR IGNORE INTO resources (id, project_id, asset_id, method, url_exact, scheme, host,
         port, path_exact, query_exact, service_asset_id, created_at, created_by, created_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      candidateId,
      ctx.projectId,
      asset.id,
      method,
      resource.url_exact,
      resource.service.service.scheme,
      resource.service.service.host,
      resource.service.service.port_effective ?? 0,
      resource.path_exact,
      resource.query_exact,
      asset.id,
      ctx.now,
      ctx.actor,
      ctx.commitSeq,
    );
  let resourceId = candidateId;
  const first = res.changes === 1;
  if (!first) {
    const row = ctx.db
      .prepare("SELECT id FROM resources WHERE project_id = ? AND method = ? AND url_exact = ?")
      .get(ctx.projectId, method, resource.url_exact);
    resourceId = row.id;
    ctx.warnings.push(
      `资源样本已存在（${method} ${truncate(resource.url_exact)}），按唯一键归并；精确 URL 与参数组合保留首见值，不因资产合并丢失（§7.1）`,
    );
  }
  if (op.local_ref) ctx.ids[op.local_ref] = resourceId;
  if (first) {
    ctx.emit("asset.discovered", {
      subject_ids: [asset.id, resourceId],
      payload: {
        asset_id: asset.id,
        asset_type: "service",
        resource_id: resourceId,
        method,
        url_exact: truncate(resource.url_exact),
        path_exact: resource.path_exact,
        query_exact: resource.query_exact,
        canonicalization_version: resource.canonicalization_version,
        first_discovery: asset.first,
        note: "服务下新入口样本登记；样本保留精确路径/查询/参数组合（§7.1）",
      },
    });
  }
  return { id: resourceId, asset_id: asset.id, first };
}

function opObserveResolution(ctx, op) {
  const domain = reqStr(op, "domain");
  const ip = reqStr(op, "ip");
  // §7.1：IP 与域名各自成节点（不同 asset_type 与 canonical_key），
  // 经观察到的解析关系相连（related_to + conditions），不自动合成一个资产。
  const domainAsset = ensureAsset(ctx, {
    asset_type: "domain",
    canonicalization_version: CANONICALIZATION_VERSION,
    canonical_key: isAscii(domain) ? domain.trim().toLowerCase() : domain.trim(),
    original_input: domain,
  });
  const ipAsset = ensureAsset(ctx, {
    asset_type: "ip",
    canonicalization_version: CANONICALIZATION_VERSION,
    canonical_key: ip.trim().toLowerCase(),
    original_input: ip,
  });
  const relationId = insertRelationD2(ctx, {
    from: domainAsset.id,
    to: ipAsset.id,
    relation_type: "related_to",
    conditions: JSON.stringify({
      kind: "dns_resolution",
      observed_via: optStr(op, "observed_via"),
      note: "观察到的解析关系：域名与 IP 保持独立资产节点（§7.1）",
    }),
    source: "resolution_observation",
  });
  ctx.warnings.push(
    `域名 ${domain} 与 ${ip} 经解析关系相连（${domainAsset.id} related_to ${ipAsset.id}，边 ${relationId}），未合并为同一资产（§7.1）`,
  );
  return { id: domainAsset.id, domain_asset_id: domainAsset.id, ip_asset_id: ipAsset.id, relation_id: relationId };
}

/* ── §7.2 操作：propose_endpoint_template / revise_endpoint_template ─── */

function loadResource(ctx, ref) {
  const id = ctx.resolveRef(ref);
  const row = ctx.db
    .prepare("SELECT * FROM resources WHERE id = ? AND project_id = ?")
    .get(id, ctx.projectId);
  if (!row) {
    throw apiError("INVALID_REFERENCE", `资源样本不存在：${id}（先用 register_http_resource 登记样本）`);
  }
  return row;
}

function opProposeEndpointTemplate(ctx, op) {
  const refs = op.resource_ids;
  if (!Array.isArray(refs) || refs.length === 0) {
    throw apiError("BAD_REQUEST", "操作 propose_endpoint_template 需要非空数组 resource_ids（样本来源）");
  }
  const resources = refs.map(loadResource.bind(null, ctx));
  const derived = resources.map((r) => derivePathTemplate(r.path_exact));
  const templates = [...new Set(derived.map((d) => d.path_template))];
  if (templates.length > 1) {
    throw apiError("BAD_REQUEST", `一次提案只允许一个模板，样本推导出 ${templates.length} 个：${templates.join("；")}；请按模板分组分别提案`, {
      detail: { derived_templates: templates },
    });
  }
  const methods = [...new Set(resources.map((r) => r.method))];
  if (methods.length > 1) {
    throw apiError("BAD_REQUEST", `样本包含多个 method（${methods.join("、")}）；模板按 method 区分，请分别提案`);
  }
  const serviceAssetId =
    (typeof op.service_asset_id === "string" && op.service_asset_id) ||
    resources[0].service_asset_id ||
    resources[0].asset_id;
  if (!serviceAssetId) {
    throw apiError("BAD_REQUEST", "无法确定 service_asset_id（样本资源未关联服务资产且未显式提供）");
  }
  const serviceHit = ctx.db
    .prepare("SELECT id FROM assets WHERE id = ? AND project_id = ?")
    .get(serviceAssetId, ctx.projectId);
  if (!serviceHit) {
    throw apiError("INVALID_REFERENCE", `service_asset_id 不存在：${serviceAssetId}`);
  }
  const pathTemplate = templates[0];
  const candidateId = formatSeqId("T", ctx.projectId, allocateSeq(ctx.db, ctx.projectId, "template"));
  const res = ctx.db
    .prepare(
      `INSERT OR IGNORE INTO endpoint_templates (id, project_id, method, service_asset_id,
         path_template, status, confidence, created_at, created_by, created_seq, updated_seq, state_version)
       VALUES (?, ?, ?, ?, ?, 'candidate', ?, ?, ?, ?, ?, 1)`,
    )
    .run(
      candidateId,
      ctx.projectId,
      methods[0],
      serviceAssetId,
      pathTemplate,
      optStr(op, "confidence"),
      ctx.now,
      ctx.actor,
      ctx.commitSeq,
      ctx.commitSeq,
    );
  let templateId = candidateId;
  const first = res.changes === 1;
  if (!first) {
    const row = ctx.db
      .prepare(
        `SELECT id FROM endpoint_templates WHERE project_id = ? AND method = ?
           AND service_asset_id = ? AND path_template = ?`,
      )
      .get(ctx.projectId, methods[0], serviceAssetId, pathTemplate);
    templateId = row.id;
    ctx.warnings.push(`模板已存在（${methods[0]} ${pathTemplate}），本次样本并入既有候选（§7.2 模板可修正）`);
  }
  const capturedList = Array.isArray(op.captured_from)
    ? op.captured_from
    : resources.map(() => optStr(op, "captured_from"));
  const memberIds = [];
  resources.forEach((r, i) => {
    const memberId = formatSeqId("M", ctx.projectId, allocateSeq(ctx.db, ctx.projectId, "membership"));
    const captured = typeof capturedList[i] === "string" ? capturedList[i] : String(capturedList[i] ?? "");
    const mres = ctx.db
      .prepare(
        `INSERT OR IGNORE INTO template_members (id, project_id, template_id, resource_id,
           captured_from, created_at, created_by, created_seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(memberId, ctx.projectId, templateId, r.id, captured, ctx.now, ctx.actor, ctx.commitSeq);
    if (mres.changes === 1) memberIds.push(memberId);
    else ctx.warnings.push(`样本 ${r.id} 已是模板 ${templateId} 的成员，按去重处理（§11.3）`);
  });
  if (op.local_ref) ctx.ids[op.local_ref] = templateId;
  ctx.emit("judgement.state_changed", {
    subject_ids: [templateId],
    changed_fields: ["status"],
    payload: {
      subject_kind: "endpoint_templates",
      subject_id: templateId,
      action: "propose",
      from: null,
      to: "candidate",
      method: methods[0],
      service_asset_id: serviceAssetId,
      path_template: pathTemplate,
      rule_version: TEMPLATE_RULE_VERSION,
      sample_count: resources.length,
      folded_segments: derived[0].folded_segments,
      note: "模板是候选判断：具体样本与来源保留，可确认/拆分/撤回（§7.2）",
    },
  });
  return { id: templateId, path_template: pathTemplate, first, new_members: memberIds.length };
}

function loadTemplate(ctx, templateId) {
  const row = ctx.db
    .prepare("SELECT * FROM endpoint_templates WHERE id = ? AND project_id = ?")
    .get(templateId, ctx.projectId);
  if (!row) {
    throw apiError("INVALID_REFERENCE", `模板不存在：${templateId}`);
  }
  return row;
}

function assertTemplateVersion(row, expected, opName) {
  if (typeof expected !== "number" || !Number.isInteger(expected)) {
    throw apiError("BAD_REQUEST", `操作 ${opName} 需要整数字段 expected_state_version（§11.3 修改型）`);
  }
  if (row.state_version !== expected) {
    throw apiError("STALE_STATE", `模板 ${row.id} 的 state_version 已变化，拒绝修改（§11.3）`, {
      detail: { current_state_version: row.state_version, expected_state_version: expected },
      next_requirements: [`以 expected_state_version=${row.state_version} 重试`],
    });
  }
}

function opReviseEndpointTemplate(ctx, op) {
  const templateId = ctx.resolveRef(reqStr(op, "template_id"));
  const action = reqStr(op, "action");
  const reason = reqStr(op, "reason");
  const row = loadTemplate(ctx, templateId);
  assertTemplateVersion(row, op.expected_state_version, "revise_endpoint_template");
  let toStatus;
  const splitSummary = [];
  if (action === "confirm") {
    if (row.status !== "candidate") {
      throw apiError("PRECONDITION_INVALID", `模板 ${templateId} 当前状态 ${row.status}，只有 candidate 可确认（§7.2）`);
    }
    toStatus = "confirmed";
  } else if (action === "withdraw") {
    if (row.status !== "candidate" && row.status !== "confirmed") {
      throw apiError("PRECONDITION_INVALID", `模板 ${templateId} 当前状态 ${row.status}，不允许撤回（§7.2）`);
    }
    toStatus = "withdrawn";
  } else if (action === "split") {
    if (row.status !== "candidate" && row.status !== "confirmed") {
      throw apiError("PRECONDITION_INVALID", `模板 ${templateId} 当前状态 ${row.status}，不允许拆分（§7.2）`);
    }
    toStatus = "split";
    const targets = op.split_targets;
    if (!Array.isArray(targets) || targets.length === 0) {
      throw apiError("BAD_REQUEST", "拆分需要非空数组 split_targets: [{resource_ids, path_template?}]（§7.2 误折叠可拆分）");
    }
    for (const target of targets) {
      if (!target || !Array.isArray(target.resource_ids) || target.resource_ids.length === 0) {
        throw apiError("BAD_REQUEST", "每个 split_target 需要非空 resource_ids");
      }
      const members = target.resource_ids.map((ref) => {
        const resourceId = ctx.resolveRef(ref);
        const member = ctx.db
          .prepare("SELECT * FROM template_members WHERE template_id = ? AND resource_id = ?")
          .get(templateId, resourceId);
        if (!member) {
          throw apiError("INVALID_REFERENCE", `拆分目标资源 ${resourceId} 不是模板 ${templateId} 的成员（§7.2 拆分只能重挂本模板样本）`);
        }
        return member;
      });
      const resource = loadResource(ctx, target.resource_ids[0]);
      const derivedPath = derivePathTemplate(resource.path_exact).path_template;
      const pathTemplate = typeof target.path_template === "string" && target.path_template.trim()
        ? target.path_template.trim()
        : derivedPath;
      const newId = formatSeqId("T", ctx.projectId, allocateSeq(ctx.db, ctx.projectId, "template"));
      ctx.db
        .prepare(
          `INSERT INTO endpoint_templates (id, project_id, method, service_asset_id, path_template,
             status, confidence, created_at, created_by, created_seq, updated_seq, state_version)
           VALUES (?, ?, ?, ?, ?, 'candidate', ?, ?, ?, ?, ?, 1)`,
        )
        .run(newId, ctx.projectId, row.method, row.service_asset_id, pathTemplate, optStr(op, "confidence"), ctx.now, ctx.actor, ctx.commitSeq, ctx.commitSeq);
      // 移动成员：样本行不动，成员关系重挂到新模板并保留 captured_from（§7.2 样本与引用不丢）
      for (const member of members) {
        const mid = formatSeqId("M", ctx.projectId, allocateSeq(ctx.db, ctx.projectId, "membership"));
        ctx.db
          .prepare(
            `INSERT OR IGNORE INTO template_members (id, project_id, template_id, resource_id,
               captured_from, created_at, created_by, created_seq)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(mid, ctx.projectId, newId, member.resource_id, member.captured_from, ctx.now, ctx.actor, ctx.commitSeq);
        ctx.db.prepare("DELETE FROM template_members WHERE id = ?").run(member.id);
      }
      splitSummary.push({ new_template_id: newId, path_template: pathTemplate, moved: members.length });
      ctx.warnings.push(
        `拆分目标模板已创建：${newId}（${pathTemplate}），${members.length} 个样本成员已重挂且 captured_from 保留（§7.2）`,
      );
    }
  } else {
    throw apiError("BAD_REQUEST", `未知模板动作：${action}（允许：confirm / split / withdraw）`);
  }
  ctx.db
    .prepare("UPDATE endpoint_templates SET status = ?, state_version = ?, updated_seq = ? WHERE id = ?")
    .run(toStatus, row.state_version + 1, ctx.commitSeq, templateId);
  if (op.local_ref) ctx.ids[op.local_ref] = templateId;
  ctx.emit("judgement.state_changed", {
    subject_ids: [templateId, ...splitSummary.map((s) => s.new_template_id)],
    changed_fields: ["status"],
    payload: {
      subject_kind: "endpoint_templates",
      subject_id: templateId,
      action,
      from: row.status,
      to: toStatus,
      reason: truncate(reason),
      split_targets: splitSummary,
      note: "模板修正不删除任何样本：resources 原样保留，成员重挂并保留 captured_from（§7.2）",
    },
  });
  return { id: templateId, status: toStatus, split_targets: splitSummary };
}

/* ── §7.3 操作：merge_candidate_group / split_candidate_group ───────── */

function groupKeyOf({ asset_id, location, category }) {
  return `${asset_id || ""}|${location || ""}|${category || ""}`;
}

function loadJudgementMember(ctx, ref) {
  const id = ctx.resolveRef(ref);
  for (const [table, kind] of [
    ["vulnerabilities", "vulnerability"],
    ["hypotheses", "hypothesis"],
  ]) {
    const row = ctx.db.prepare(`SELECT * FROM ${table} WHERE id = ? AND project_id = ?`).get(id, ctx.projectId);
    if (row) return { row, table, member_kind: kind };
  }
  throw apiError("INVALID_REFERENCE", `候选组成员不存在（仅支持漏洞/假设）：${id}`);
}

function opMergeCandidateGroup(ctx, op) {
  const memberRefs = op.member_ids;
  if (!Array.isArray(memberRefs) || memberRefs.length < 2) {
    throw apiError("BAD_REQUEST", "操作 merge_candidate_group 需要至少两个 member_ids（候选聚合用于查找，不替代漏洞身份，§7.3）");
  }
  const reason = reqStr(op, "reason");
  const relation = optStr(op, "relation") || "duplicate_of";
  if (!["duplicate_of", "equivalent_to"].includes(relation)) {
    throw apiError("BAD_REQUEST", `relation 非法：${relation}（允许 duplicate_of / equivalent_to，§7.3 显式关系）`);
  }
  const members = memberRefs.map((ref) => loadJudgementMember(ctx, ref));
  const explicit = {
    asset_id: typeof op.asset_id === "string" ? op.asset_id : null,
    location: typeof op.location === "string" ? op.location : null,
    category: typeof op.category === "string" ? op.category : null,
  };
  const firstVuln = members.find((m) => m.table === "vulnerabilities");
  const derived = firstVuln
    ? { asset_id: firstVuln.row.asset_id, location: firstVuln.row.location, category: firstVuln.row.category }
    : { asset_id: null, location: null, category: null };
  const keySource = {
    asset_id: explicit.asset_id ?? derived.asset_id ?? null,
    location: explicit.location ?? derived.location ?? null,
    category: explicit.category ?? derived.category ?? null,
  };
  const groupKey = groupKeyOf(keySource);
  let group = ctx.db
    .prepare(
      "SELECT * FROM candidate_groups WHERE project_id = ? AND group_key = ? AND status = 'open' ORDER BY created_seq DESC LIMIT 1",
    )
    .get(ctx.projectId, groupKey);
  let groupId;
  if (group) {
    if (typeof op.expected_group_state_version !== "number" || !Number.isInteger(op.expected_group_state_version)) {
      throw apiError("BAD_REQUEST", "候选组已存在，操作 merge_candidate_group 需要整数字段 expected_group_state_version（§11.3 修改型）", {
        detail: { group_id: group.id, current_state_version: group.state_version },
      });
    }
    if (group.state_version !== op.expected_group_state_version) {
      throw apiError("STALE_STATE", `候选组 ${group.id} 的 state_version 已变化，拒绝归并（§11.3）`, {
        detail: { current_state_version: group.state_version, expected_group_state_version: op.expected_group_state_version },
        next_requirements: [`以 expected_group_state_version=${group.state_version} 重试`],
      });
    }
    groupId = group.id;
  } else {
    groupId = formatSeqId("CG", ctx.projectId, allocateSeq(ctx.db, ctx.projectId, "candidate_group"));
    ctx.db
      .prepare(
        `INSERT INTO candidate_groups (id, project_id, group_key, status, created_at, created_by,
           created_seq, updated_seq, state_version)
         VALUES (?, ?, ?, 'open', ?, ?, ?, ?, 1)`,
      )
      .run(groupId, ctx.projectId, groupKey, ctx.now, ctx.actor, ctx.commitSeq, ctx.commitSeq);
    group = ctx.db.prepare("SELECT * FROM candidate_groups WHERE id = ?").get(groupId);
  }
  const primaryRef = typeof op.primary_id === "string" && op.primary_id ? op.primary_id : memberRefs[0];
  const primary = members.find((m) => m.row.id === ctx.resolveRef(primaryRef));
  if (!primary) {
    throw apiError("INVALID_REFERENCE", `primary_id 不在 member_ids 中：${primaryRef}`);
  }
  for (const m of members) {
    const mid = formatSeqId("M", ctx.projectId, allocateSeq(ctx.db, ctx.projectId, "membership"));
    const res = ctx.db
      .prepare(
        `INSERT OR IGNORE INTO memberships (id, project_id, group_id, member_id, member_kind,
           created_at, created_by, created_seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(mid, ctx.projectId, groupId, m.row.id, m.member_kind, ctx.now, ctx.actor, ctx.commitSeq);
    if (res.changes !== 1) {
      ctx.warnings.push(`成员 ${m.row.id} 已在候选组 ${groupId}，按去重处理（§11.3）`);
    }
  }
  const relationIds = [];
  for (const m of members) {
    if (m.row.id === primary.row.id) continue;
    relationIds.push(
      insertRelationD2(ctx, {
        from: m.row.id,
        to: primary.row.id,
        relation_type: relation,
        conditions: JSON.stringify({ group_id: groupId, reason: truncate(reason) }),
        source: "candidate_merge",
      }),
    );
    ctx.warnings.push(
      `${m.row.id} 经 ${relation} 指向 ${primary.row.id}：原 ID、引用与证据全部保留，未被合并删除（§7.3）`,
    );
  }
  ctx.db
    .prepare("UPDATE candidate_groups SET state_version = ?, updated_seq = ? WHERE id = ?")
    .run(group.state_version + 1, ctx.commitSeq, groupId);
  if (op.local_ref) ctx.ids[op.local_ref] = groupId;
  ctx.emit("judgement.state_changed", {
    subject_ids: [groupId],
    changed_fields: ["state_version"],
    payload: {
      subject_kind: "candidate_groups",
      subject_id: groupId,
      action: "merge",
      group_key: groupKey,
      members: members.map((m) => m.row.id),
      primary: primary.row.id,
      relation,
      reason: truncate(reason),
      note: "候选组只用于查找聚合，不替代漏洞身份；被合并节点全部保留（§7.3）",
    },
  });
  return { id: groupId, group_id: groupId, group_key: groupKey, relation_ids: relationIds, primary: primary.row.id };
}

function opSplitCandidateGroup(ctx, op) {
  const groupId = ctx.resolveRef(reqStr(op, "group_id"));
  const reason = reqStr(op, "reason");
  const removeRefs = op.remove_member_ids;
  if (!Array.isArray(removeRefs) || removeRefs.length === 0) {
    throw apiError("BAD_REQUEST", "操作 split_candidate_group 需要非空数组 remove_member_ids");
  }
  const group = ctx.db
    .prepare("SELECT * FROM candidate_groups WHERE id = ? AND project_id = ?")
    .get(groupId, ctx.projectId);
  if (!group) {
    throw apiError("INVALID_REFERENCE", `候选组不存在：${groupId}`);
  }
  if (typeof op.expected_group_state_version !== "number" || !Number.isInteger(op.expected_group_state_version)) {
    throw apiError("BAD_REQUEST", "操作 split_candidate_group 需要整数字段 expected_group_state_version（§11.3 修改型）");
  }
  if (group.state_version !== op.expected_group_state_version) {
    throw apiError("STALE_STATE", `候选组 ${groupId} 的 state_version 已变化，拒绝拆分（§11.3）`, {
      detail: { current_state_version: group.state_version, expected_group_state_version: op.expected_group_state_version },
      next_requirements: [`以 expected_group_state_version=${group.state_version} 重试`],
    });
  }
  const memberIds = removeRefs.map((ref) => ctx.resolveRef(ref));
  const retractedRelations = [];
  for (const memberId of memberIds) {
    const membership = ctx.db
      .prepare("SELECT * FROM memberships WHERE group_id = ? AND member_id = ?")
      .get(groupId, memberId);
    if (!membership) {
      throw apiError("INVALID_REFERENCE", `成员 ${memberId} 不在候选组 ${groupId} 中`);
    }
    ctx.db.prepare("DELETE FROM memberships WHERE id = ?").run(membership.id);
    if (op.retract_relations !== false) {
      const others = ctx.db
        .prepare("SELECT DISTINCT member_id FROM memberships WHERE group_id = ? AND member_id != ?")
        .all(groupId, memberId);
      const otherIds = others.map((o) => o.member_id);
      if (otherIds.length) {
        const marks = otherIds.map(() => "?").join(",");
        const edges = ctx.db
          .prepare(
            `SELECT * FROM relations WHERE project_id = ? AND retracted_at IS NULL
               AND relation_type IN ('duplicate_of','equivalent_to')
               AND ((from_id = ? AND to_id IN (${marks})) OR (to_id = ? AND from_id IN (${marks})))`,
          )
          .all(ctx.projectId, memberId, ...otherIds, memberId, ...otherIds);
        for (const edge of edges) {
          ctx.db.prepare("UPDATE relations SET retracted_at = ? WHERE id = ?").run(ctx.now, edge.id);
          retractedRelations.push(edge.id);
        }
      }
    }
  }
  const remaining = ctx.db
    .prepare("SELECT COUNT(*) AS c FROM memberships WHERE group_id = ?")
    .get(groupId).c;
  const newStatus = remaining === 0 ? "closed" : group.status;
  ctx.db
    .prepare("UPDATE candidate_groups SET state_version = ?, updated_seq = ?, status = ? WHERE id = ?")
    .run(group.state_version + 1, ctx.commitSeq, newStatus, groupId);
  if (op.local_ref) ctx.ids[op.local_ref] = groupId;
  ctx.emit("judgement.state_changed", {
    subject_ids: [groupId],
    changed_fields: ["state_version", "status"],
    payload: {
      subject_kind: "candidate_groups",
      subject_id: groupId,
      action: "split",
      removed: memberIds,
      retracted_relations: retractedRelations,
      remaining_members: remaining,
      reason: truncate(reason),
      note: "误合并可拆分：成员移出、合并边撤回；被合并节点的 ID/引用/证据从未删除（§7.3）",
    },
  });
  return {
    id: groupId,
    group_id: groupId,
    removed: memberIds,
    retracted_relations: retractedRelations,
    remaining_members: remaining,
    status: newStatus,
  };
}

/* ── A1 多态引用定位（本模块内最小实现：discovered_from 校验用） ─────── */

function locatePolymorphic(ctx, ref) {
  for (const table of ["assets", "observations", "hypotheses", "facts", "vulnerabilities", "intents", "captures"]) {
    const hit = ctx.db
      .prepare(`SELECT id FROM ${table} WHERE id = ? AND project_id = ?`)
      .get(ref, ctx.projectId);
    if (hit) return { table };
  }
  return null;
}

/* ── 提交操作注册（经 A1 扩展点；worker 面为资产/样本/模板/候选组操作） ── */

registerSubmissionOps("D2/dedup", [
  { name: "register_service_asset", kind: "append", roles: ["worker"], handler: opRegisterServiceAsset },
  { name: "register_http_resource", kind: "append", roles: ["worker"], handler: opRegisterHttpResource },
  { name: "observe_resolution", kind: "append", roles: ["worker"], handler: opObserveResolution },
  { name: "propose_endpoint_template", kind: "append", roles: ["worker"], handler: opProposeEndpointTemplate },
  { name: "revise_endpoint_template", kind: "modify", roles: ["worker"], handler: opReviseEndpointTemplate },
  { name: "merge_candidate_group", kind: "modify", roles: ["worker"], handler: opMergeCandidateGroup },
  { name: "split_candidate_group", kind: "modify", roles: ["worker"], handler: opSplitCandidateGroup },
]);
