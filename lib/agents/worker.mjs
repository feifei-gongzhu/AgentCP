/**
 * Worker AI（规范 §3.1/§10.2/§17/§18.3；蓝图阶段 C/E 的执行半边）。
 *
 * 合同：
 *   - 独立 LLM + 工具；决定一条意图内的具体方法（Orchestrator 不逐个审批其
 *     工具步骤，§3.1）。发现即时持久化（§2 约束 1）：观察/假设/疑似漏洞经
 *     submit_findings 落库，不等执行结束。
 *   - 工具调用一律经 Tool Gateway（§10.2/§17）：register→start→complete，
 *     程序校验范围/前提/租约/并发；真实执行体（当前 http_probe：真实 HTTP
 *     GET，目标必须落在项目范围内，超时/网络错误记 failed 并留证）由本模块
 *     提供，网关先登记 planned 再执行。
 *   - 证据链路真实（§13 顺序）：staging→固定→登记 Blob/Capture→complete 带
 *     evidence_refs；原始证据不可变。
 *   - 完成是建议（§10.1）：report_progress(kind=completion) 经程序检查全部
 *     工具调用终态后落定 Attempt；随后**程序**调 C1 reviewCompletion 复核意图完成
 *     （声明交付物时须有真实记录证明 → resolved；未声明交付物 → awaiting_review，
 *     一句完成不能直接 resolved）。执行开始时程序把意图置 running（§10.1 状态机）。
 *
 * 第 3 轮（2026-11-06）P0 修复（真实模型联调）：
 *   - 证据完整性（规范 §13/§18.3）：http_probe 用 arrayBuffer() 保留**完整原始响应字节**
 *     与**全量响应头**（含多个 set-cookie）；文本摘要按 Content-Type charset 解码并如实
 *     标注 body_charset / 是否支持；store_evidence(raw_body) 固定逐字节原始响应，
 *     store_evidence(exchange_record) 固定含完整请求/响应头与响应体的 JSON；
 *     只有超过 64MiB 才显式截断并在证据内注明（不静默丢字节）。
 *   - 提交幂等：submit_findings 的 submission_id 由 (attempt_id, operations) 的
 *     sha256 确定性派生 —— 重复调用（模型重试/恢复重跑）返回原回执，不重复写观察/假设。
 *   - 同一 tool_call 只固定一种表示（C2 采集以 tool_call_id 去重，§13）；同表示重复
 *     调用幂等返回原 Blob/Capture。
 */
import { createHash } from "node:crypto";

import { issueSession } from "../store/sessions.mjs";
import { getStore, submit } from "../store/record-service.mjs";
import "../store/dedup.mjs";
import "../store/judgements.mjs";
import { generateWorkerContext } from "../store/projection.mjs";
import { getRecord } from "../store/records-read.mjs";
import { attemptLifecycle, dispatchAttempt, reportProgress, toolGateway } from "../store/attempts.mjs";
import { registerCapture, storeBlob } from "../store/evidence.mjs";
import { reviewCompletion, transitionIntent } from "../store/intents.mjs";
import { apiError } from "../errors.mjs";
import { runAgentLoop } from "./loop.mjs";
import { openNode, listChildren, searchNodes, followRelations, navigateParent, readEvidenceSlice, saveBookmark, getBookmark, listBookmarks } from "../store/reading.mjs";
import { saveBatch as saveExtractionBatch } from "../store/extraction.mjs";
import { saveCheckRecord } from "../store/coverage.mjs";
import { createCheckpoint } from "../store/recovery.mjs";

export const WORKER_ACTOR_PREFIX = "worker-agent";

/** 证据单 Blob 上限（§13/§18.3）：只有超过才显式截断并在证据中注明。 */
export const MAX_EVIDENCE_BYTES = 64 * 1024 * 1024;
/** 送入模型上下文的响应体摘要上限（完整字节另经证据层固定）。 */
export const MAX_CONTEXT_BODY_CHARS = 600; // 成本：上下文摘要更短；完整字节仍在证据层

const SYSTEM = [
  "你是持续探索型渗透测试系统的一个 Worker（规范 §3.1/§10.2）。",
  "职责：执行一条意图——决定具体方法，持续提交观察与假设，提出验证或补查请求；发现即时持久化，不等执行结束。",
  "你没有的权限：直接改共享 Map、自行确认漏洞、绕过执行边界（§3）；工具调用一律经 register_tool_call/start/complete（网关校验范围、前提、租约），发现经 submit_findings 提交。",
  "证据要求：HTTP 请求完成后证据已自动固定（blob_id/capture_id 持久引用）；重要观察经 submit_findings 提交，无采集支撑的判断要注明条件与缺口。"
    + "每发起一次探测（register_tool_call/http_request）后，必须立即 store_evidence + complete_tool_call 把它落定，再发起下一次；程序会拒绝在上一个调用未落定时开新探测。",
    + "证据表示二选一：raw_body=逐字节原始响应体；exchange_record=含完整请求/响应头与响应体的完整记录（同一 tool_call 只能固定一次表示）。",
  "字符集：探测摘要带 body_charset（如 gbk/gb18030/utf-8）与 body_charset_supported；非 UTF-8 目标请以原始字节与解码摘要为准，不要把乱码当内容。",
  "作业目标与授权范围：严格依据开场上下文 target_and_scope 中的项目主目标（project.goal / task / description）、当前意图（intent.question / success_criteria）及当前范围版本（scope.rules 的 allow / deny / pending）推进。"
    + "工具选择由当前意图与授权范围决定：当意图指向已授权网络目标时，使用 register_tool_call / http_request（支持 GET/POST/PUT/PATCH/DELETE 等必要方法）真实探测并经 store_evidence + complete_tool_call 固定不可变证据；"
    + "当项目或意图仅针对本地文件、既有采集或材料复核时，使用 read_record / read_blob 核查材料并提交发现，禁止向未授权网络目标发起请求（§17）。",
  "资产图谱（§7.1/§7.2/§15.1）：每探测到新主机/端口，用 submit_findings 的 register_service_asset 一并登记；"
    + "每次对带参数/具名路径的精确 URL 探测，用 register_http_resource 登记样本。只把 URL 写在观察文本里会导致资产地图与接口视图缺失（不是投影 bug）。",
  "证据绑定（§7.3/§8.3）：报告漏洞时必须同批提交承载证据的观察（append_observation + capture_id）；程序会自动写 supports 关系。"
    + "没有证据/观察的漏洞只会让后续独立验证得到 insufficient（不等于已排除），浪费验证轮次。",
  "对已存在的 suspected 漏洞补证：用 submit_findings 的 relations 字段提交 "
    + "{from:\"O-…\", type:\"supports\", to:\"V-…\"}（from 用自身观察编号，不要伪造）；补证后独立验证才能拿到非空 Manifest。",
  "接口模板（§7.2）：同一路径族的多个 HTTP 资源样本可用 propose_endpoint_template 提案候选模板（resource_ids 来自 register_http_resource 回执，一次一个模板）。",
  "技术栈证据（§7.1/§15.1）：识别到的产品/框架/中间件/版本（如应用软件、Web 服务器、运行时及版本）用 submit_findings 的 register_asset 登记为 asset_type=product/technology（canonical_key 写「产品 版本」、original_input 写证据编号），并 add_relation targets/derived_from 指向服务资产；只写在观察文本里，资产页的技术栈块就永远是空的。",
  "资产层级树（MemWalker 分层导航）：资产必须构建为树形结构，不允许在同一层级重复注册相同资产。"
    + "推荐层级：host（主机/IP）→ product（产品/服务）→ component（组件/模块）→ entry（入口/端点）。"
    + "注册子资产时必须填写 parent_asset_id 指向其父资产编号（如 A-0001）。"
    + "注册前先搜索：用 read_record 检查目标父节点下是否已有同名同类型资产，避免重复创建。"
    + "例：发现 通达OA 运行在 192.168.1.1 上，先 register_service_asset 得到主机资产 A-0001，"
    + "再 register_asset(asset_type=product, canonical_key='通达OA', parent_asset_id='A-0001') 得到产品节点 A-0002，"
    + "后续版本信息 register_asset(asset_type=component, canonical_key='通达OA V11.6', parent_asset_id='A-0002')。",
  "程序会在每次固定证据后自动登记服务资产与 HTTP 资源样本（图谱兜底），但产品/技术栈/接口模板仍需要你显式提交。",
  "unknown 工具调用（进程中断/超时导致结果未知）：先核查现状，再用 resolve_tool_call 登记 succeeded/failed/cancelled 并写 check_note；"
    + "未 resolve 的 unknown 会阻塞重试与 completion（§10.2）。",
  "完成或受阻时**必须**调用 report_progress：完成用 kind=completion，做不下去用 kind=blocked（写明缺口/原因）。"
    + "不要只输出普通文本就结束——普通文本会留下 leased Attempt 空转到租约到期，并浪费一轮执行。",
  "完成后调用 report_progress(kind=completion) 提交完成建议（程序检查全部工具调用终态后落定），并用中文简述实际完成与未覆盖部分。"
    + "若意图声明了 deliverables，必须在同一次调用里携带 deliverables_proof（真实记录编号，如 submit_findings 返回的观察编号），否则意图只会进入待复核而不会 resolved。",
].join("\n");

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** 确定性 JSON（键递归排序）：幂等编号的稳定输入（同内容 → 同摘要）。 */
function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableJson(value[k])).join(",") + "}";
}

/** 幂等提交编号：由 (attempt, 内容) 确定性派生，重复调用得到同一 submission_id。 */
function deterministicSubmissionId(prefix, parts) {
  const digest = sha256Hex(Buffer.from(stableJson(parts), "utf8")).slice(0, 32);
  return prefix + "-" + digest; // 38 字符，满足 A1 的 1..128 位 [A-Za-z0-9._:-]
}

/** 从 Content-Type 取 charset；gb2312/gb_2312-80 归一为 gbk（TextDecoder 别名）。 */
function charsetFromContentType(contentType) {
  const match = /charset\s*=\s*"?\s*([A-Za-z0-9._-]+)/i.exec(String(contentType || ""));
  if (!match) return null;
  const label = match[1].toLowerCase();
  if (label === "gb2312" || label === "gb_2312-80" || label === "x-gbk") return "gbk";
  return label;
}

/**
 * 按声明字符集把原始字节解码为文本（仅在内存中做摘要用）。
 * 实测 Node 22（v22.23.2）TextDecoder 支持 gbk / gb18030（见 docs/modules/AGENTS-realrun.md）。
 * 不支持的标签：保留原始字节、按 utf-8 尽力解码并如实标注（不让模型看到无说明的乱码）。
 */
function decodeBodyText(bytes, charset) {
  const label = charset || "utf-8";
  // R21：实测根页响应头声明 gbk、正文却是合法 UTF-8（直接按 gbk 解码会得到乱码，
  // 影响产品/路径提取）。声明非 UTF-8 时先用严格 UTF-8 试解，成功且含 CJK 则按 UTF-8
  // 返回并显式标记 mismatch（原始字节仍在证据层，可复核）。
  if (charset && !/^utf-?8$/i.test(charset)) {
    try {
      const strictUtf8 = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (/[\u4e00-\u9fff]/.test(strictUtf8)) {
        return {
          ok: true,
          charset: "utf-8",
          declared_charset: charset,
          text: strictUtf8,
          mismatch: true,
          note: "声明字符集 " + charset + " 与真实字节不一致：字节为合法 UTF-8，已按 utf-8 解码（原始字节完整保留）",
        };
      }
    } catch {
      /* 非 UTF-8，按声明解码 */
    }
  }
  try {
    const decoder = new TextDecoder(label, { fatal: false });
    return { ok: true, charset: label, declared_charset: charset, text: decoder.decode(bytes), note: null };
  } catch {
    const fallback = new TextDecoder("utf-8", { fatal: false });
    return {
      ok: false,
      charset: "utf-8",
      declared_charset: charset,
      text: fallback.decode(bytes),
      note: "声明字符集 " + label + " 不受当前运行时 TextDecoder 支持，已按 utf-8 尽力解码（原始字节完整保留于证据）",
    };
  }
}

/** 全量响应头（保留重复头，如多个 Set-Cookie；不截断条数）。 */
function headersToArray(headers) {
  const out = [];
  let combinedSetCookie = null;
  for (const [name, value] of headers.entries()) {
    if (name.toLowerCase() === "set-cookie") {
      combinedSetCookie = value;
      continue;
    }
    out.push({ name, value });
  }
  const listed = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
  if (listed.length) {
    for (const cookie of listed) out.push({ name: "set-cookie", value: cookie });
  } else if (combinedSetCookie !== null) {
    out.push({ name: "set-cookie", value: combinedSetCookie });
  }
  return out;
}

/**
 * 真实执行体：http_probe（§10.2 工具由程序可靠执行；目标必须已通过网关范围校验）。
 * 返回 { observation, rawBody, request }：observation 是可读摘要（进模型上下文），
 * rawBody 是**完整的原始响应字节**（Buffer，仅进程内供 store_evidence 固定）。
 */
async function executeHttpProbe(url, { timeoutMs = 8000, method = "GET", headers: extraHeaders = null, body = null } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const httpMethod = String(method || "GET").toUpperCase();
  const requestHeaders = { "user-agent": "sorne-worker-agent/0.1" };
  if (extraHeaders && typeof extraHeaders === "object") {
    for (const [k, v] of Object.entries(extraHeaders)) {
      if (typeof k === "string" && k.trim() && (typeof v === "string" || typeof v === "number")) {
        requestHeaders[k.trim()] = String(v);
      }
    }
  }
  const hasBody = body !== null && body !== undefined && httpMethod !== "GET" && httpMethod !== "HEAD";
  try {
    const res = await fetch(url, {
      method: httpMethod,
      redirect: "manual",
      signal: controller.signal,
      headers: requestHeaders,
      ...(hasBody ? { body: typeof body === "string" ? body : Buffer.from(body) } : {}),
    });
    // P0：完整原始字节（不经过 res.text() 的字符集假设）
    const rawBody = Buffer.from(await res.arrayBuffer());
    const finishedAt = new Date().toISOString();
    const durationMs = Date.now() - startedMs;
    const headers = headersToArray(res.headers);
    const contentType = res.headers.get("content-type") || "";
    const declaredCharset = charsetFromContentType(contentType);
    const decoded = decodeBodyText(rawBody, declaredCharset);
    const excerptTruncated = decoded.text.length > MAX_CONTEXT_BODY_CHARS;
    return {
      observation: {
        outcome: "succeeded",
        observed_at: startedAt,
        finished_at: finishedAt,
        duration_ms: durationMs,
        status: res.status,
        status_text: res.statusText || "",
        headers,
        headers_count: headers.length,
        content_type: contentType || null,
        body_charset: decoded.charset,
        body_charset_declared: declaredCharset,
        body_charset_supported: decoded.ok,
        body_charset_note: decoded.note,
        body_charset_mismatch: decoded.mismatch === true,
        body_bytes: rawBody.length,
        body_sha256: sha256Hex(rawBody),
        body_excerpt: excerptTruncated ? decoded.text.slice(0, MAX_CONTEXT_BODY_CHARS) : decoded.text,
        body_excerpt_truncated: excerptTruncated,
        body_charset_decoded_chars: decoded.text.length,
        note: "此处仅为可读摘要（按 body_charset 解码）；完整原始响应字节与全量头经 store_evidence 固定"
          + "（raw_body = 逐字节原始响应；exchange_record = 含完整请求/响应头与响应体的 JSON）",
      },
      rawBody,
      request: {
        method: httpMethod,
        url,
        headers: requestHeaders,
        issued_at: startedAt,
        ...(hasBody
          ? {
              body_bytes: Buffer.byteLength(typeof body === "string" ? body : Buffer.from(body)),
              body_text: typeof body === "string" ? body.slice(0, 65536) : null,
              body_base64: typeof body === "string" ? null : Buffer.from(body).subarray(0, 65536).toString("base64"),
            }
          : {}),
      },
    };
  } catch (error) {
    return {
      observation: {
        outcome: "failed",
        observed_at: startedAt,
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - startedMs,
        status: null,
        error: error && error.name === "AbortError" ? "超时（" + timeoutMs + "ms）" : String(error?.message ?? error),
        request: { method: httpMethod, url, headers: requestHeaders },
      },
      rawBody: null,
      request: { method: httpMethod, url, headers: requestHeaders, issued_at: startedAt },
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 执行开始时把意图推进到 running（§10.1 proposed→queued→running 的程序记账）。
 * 只处理 proposed/queued；blocked/deferred 由协调 AI 决定恢复（程序不写死重试，§3.1/§3.2）；
 * awaiting_review/resolved 不改写。失败不回滚 Attempt（返回说明交调用方记录）。
 */
async function ensureIntentRunning(pctx, { projectId, intentId, attemptId }) {
  const store = await getStore(pctx);
  const row = store.db
    .prepare("SELECT id, status FROM intents WHERE project_id = ? AND id = ?")
    .get(projectId, intentId);
  if (!row) return { ok: false, from: null, note: "意图不存在：" + intentId };
  if (row.status === "running") return { ok: true, from: "running", to: "running", note: "意图已在执行中" };
  if (row.status === "awaiting_review" || row.status === "resolved") {
    return { ok: true, from: row.status, to: row.status, note: "意图已进入复核/终态，不改写状态（§10.1）" };
  }
  if (row.status !== "proposed" && row.status !== "queued") {
    return {
      ok: false,
      from: row.status,
      note: "意图状态 " + row.status + " 不允许程序自动进入 running；恢复由协调 AI 决定（§3.1/§10.1）",
    };
  }
  const via = "attempt:" + attemptId;
  if (row.status === "proposed") {
    await transitionIntent(pctx, { projectId, actor: "runtime", intentId, action: "activate", via });
  }
  await transitionIntent(pctx, { projectId, actor: "runtime", intentId, action: "start", via });
  return { ok: true, from: row.status, to: "running", note: "执行开始：意图已置 running（§10.1 状态机）" };
}

/**
 * 完整交换记录（§13 exchange_record）：请求元数据 + **全量响应头** + 响应体。
 * 响应体按声明的 charset 解码为文本；含 NUL/解码失败按 base64 保留字节。
 * 只有响应体超过 MAX_EVIDENCE_BYTES 才显式截断，并在记录内注明被省略的字节数。
 */
function buildExchangeRecord({ probe, toolCallId, attemptId }) {
  const body = Buffer.isBuffer(probe.rawBody) ? probe.rawBody : Buffer.alloc(0);
  const truncated = body.length > MAX_EVIDENCE_BYTES;
  const kept = truncated ? body.subarray(0, MAX_EVIDENCE_BYTES) : body;
  const decoded = decodeBodyText(kept, probe.observation.body_charset_declared);
  const textual = decoded.ok && !kept.includes(0);
  return {
    schema: "sorne.exchange_record/v1",
    tool_call_id: toolCallId,
    attempt_id: attemptId,
    request: probe.request,
    response: {
      status: probe.observation.status,
      status_text: probe.observation.status_text,
      headers: probe.observation.headers,
      content_type: probe.observation.content_type,
      body_charset: decoded.charset,
      body_charset_declared: decoded.declared_charset,
      body_bytes: body.length,
      body_sha256: sha256Hex(body),
      body_text: textual ? decoded.text : null,
      body_base64: textual ? null : kept.toString("base64"),
      body_truncated: truncated,
      body_kept_bytes: kept.length,
      body_omitted_bytes: truncated ? body.length - kept.length : 0,
      truncation_note: truncated
        ? "响应体超过证据单上限 " + MAX_EVIDENCE_BYTES + " 字节：仅固定前 " + MAX_EVIDENCE_BYTES
          + " 字节，其余 " + (body.length - kept.length) + " 字节未保存（显式截断，非静默丢弃）"
        : null,
    },
    timing: { started_at: probe.request.issued_at, finished_at: probe.observation.finished_at },
    note: "完整请求/响应记录：请求元数据 + 全量响应头 + 响应体（文本按声明字符集解码；二进制/含 NUL 用 base64）",
  };
}

/** 调 C1 reviewCompletion 并把拒绝转成可回灌的结果（不中断循环）。 */
async function reviewIntentCompletion(pctx, { projectId, actor, intentId, attemptId, deliverablesProof, note }) {

/**
 * 程序侧自动固定证据（纠偏 §四：工具执行结果先持久化，再向模型返回持久入口）。
 *
 * 在 HTTP 请求完成后，自动完成 blob 存储 → capture 登记 → tool_call 落定，
 * 模型收到持久引用后主要负责解释和提出下一步。进程退出也不丢证据。
 */
async function autoFixEvidence({ pctx, projectId, session, probe, callId, attemptId, token, actor }) {
  const record = buildExchangeRecord({ probe, toolCallId: callId, attemptId });
  const bytes = Buffer.from(JSON.stringify(record, null, 2), "utf8");
  const sha = sha256Hex(bytes);

  const blob = await storeBlob(pctx, {
    projectId, bytes, representation: "exchange_record",
    sourceKind: "tool_gateway", actor, expectedSha256: sha,
  });

  const probeMethod = (probe.request && typeof probe.request.method === "string" ? probe.request.method : "GET").toUpperCase();
  const capture = await registerCapture(pctx, {
    project_id: projectId,
    tool_call_id: callId,
    attempt_id: attemptId,
    request_url_exact: probe.url,
    method: probeMethod,
    observed_at: probe.observation.observed_at,
    response_body_blob: blob.blob_id,
    condition_snapshot_id: "worker-agent:" + actor,
    integrity_status: "verified",
  }, { actor });

  await toolGateway(pctx, {
    session, action: "complete",
    attemptId, toolCallId: callId,
    fencingToken: token,
    outcome: "succeeded",
    evidenceRefs: [blob.blob_id, capture.id].filter(Boolean),
    touchedTargets: [],
  });

  // 图谱自动登记（R20）
  try {
    let origin = null;
    try { origin = new URL(probe.url).origin + "/"; } catch { origin = null; }
    if (origin) {
      await submit(pctx, {
        session,
        envelope: {
          submission_id: deterministicSubmissionId("MAP", {
            project_id: projectId, attempt_id: attemptId,
            url: probe.url, method: probeMethod,
          }),
          attempt_id: attemptId,
          operations: [
            { op: "register_service_asset", local_ref: "svcAuto", url: origin },
            { op: "register_http_resource", local_ref: "resAuto", url: probe.url, method: probeMethod },
          ],
        },
      });
    }
  } catch { /* 图谱登记失败不影响证据事实 */ }

  return {
    blob_id: blob.blob_id,
    capture_id: capture.id,
    byte_size: bytes.length,
    body_sha256: record.response.body_sha256,
    body_bytes: record.response.body_bytes,
  };
}
  try {
    return await reviewCompletion(pctx, { projectId, actor, intentId, attemptId, deliverablesProof, note });
  } catch (error) {
    return {
      decision: "rejected",
      code: error?.code ?? "INTERNAL_ERROR",
      message: String(error?.message ?? error),
      next_requirements: error?.extra?.next_requirements ?? [],
      note: "意图未关闭：按错误信封补齐后可用 report_progress(completion) 再次提交证明（Attempt 已完成不再改动，仅补复核）",
    };
  }
}

/**
 * 程序侧交付物证明兜底：AI 忘记带 deliverables_proof 时，以本 worker 最近一次 A1 提交
 * 回执里的真实编号（观察/采集/资产等）为证明。记录仍由 reviewCompletion 逐个核验存在性，
 * 证明来源在回执里标注（auto_from_latest_submission），不伪造记录。
 */
async function deriveDeliverableProofs(pctx, { projectId, actor, intentId }) {
  const store = await getStore(pctx);
  const sub = store.db
    // submissions 表没有 created_seq（提交序号在 commit_seq 列）：此前按 created_seq 排序
    // 会抛 ERR_SQLITE_ERROR: no such column，导致 AI 漏带 deliverables_proof 时完成通道
    // 连续失败（WR-0125 实测）。按 commit_seq + rowid 取最近一笔。
    .prepare("SELECT receipt FROM submissions WHERE project_id = ? AND submitter_id = ? ORDER BY commit_seq DESC, rowid DESC LIMIT 1")
    .get(projectId, actor);
  const intent = store.db
    .prepare("SELECT deliverables FROM intents WHERE project_id = ? AND id = ?")
    .get(projectId, intentId);
  if (!sub || !intent) return [];
  let ids = [];
  try {
    const receipt = JSON.parse(sub.receipt);
    ids = Object.values(receipt.ids || {}).filter((v) => typeof v === "string");
  } catch {
    return [];
  }
  if (!ids.length) return [];
  let deliverables = [];
  try {
    deliverables = JSON.parse(intent.deliverables) || [];
  } catch {
    return [];
  }
  return deliverables.map((d, i) => ({
    index: i,
    ...(d && typeof d === "object" && d.key ? { key: String(d.key) } : {}),
    record_ids: ids,
    from: "auto_from_latest_submission",
  }));
}

/**
 * runWorker(pctx, {projectId, intentId, model, assignmentId?, workerId?})
 * 未给 attempt 时先经 C2 条件领取（runtime 派发路径之外的自助领取；同一
 * assignment 幂等）。返回循环结局与 attempt 终态。
 */
export async function runWorker(
  pctx,
  { projectId, intentId, model, attemptId, fencingToken, assignmentId, workerId, maxSteps = Infinity },
) {
  if (!projectId || !intentId) throw new Error("runWorker 需要 projectId 与 intentId");
  let actor = workerId || `${WORKER_ACTOR_PREFIX}-${intentId}`;

  let attempt = null;
  let token = fencingToken ?? null;
  if (attemptId) {
    // 复用已派发 Attempt：以该 Attempt 登记的 worker 身份执行（runtime 把 Attempt
    // 交给本代理；所有网关/汇报调用因此满足 worker（本人 Attempt）权限面）。
    const { getStore } = await import("../store/record-service.mjs");
    const store = await getStore(pctx);
    const row = store.db
      .prepare("SELECT * FROM attempts WHERE project_id = ? AND id = ?")
      .get(projectId, attemptId);
    if (!row) throw new Error(`Attempt 不存在：${attemptId}`);
    if (row.intent_id !== intentId) {
      throw new Error(`Attempt ${attemptId} 属于意图 ${row.intent_id}，与请求的 ${intentId} 不一致`);
    }
    actor = row.worker_id;
  }
  // TTL：见 orchestrator.mjs 同款说明（避免角色会话无界累积）。
  const session = issueSession({ project_id: projectId, actor, role: "worker", ttl_ms: 30 * 60 * 1000 });

  if (!attemptId) {
    const dispatched = await dispatchAttempt(pctx, {
      session: issueSession({ project_id: projectId, actor, role: "runtime", ttl_ms: 30 * 60 * 1000 }),
      intentId,
      assignmentId: assignmentId || `worker-agent-${intentId}`,
      workerId: actor,
    });
    attempt = dispatched.attempt;
    token = dispatched.fencing_token;
  }

  const resolvedAttemptId = attempt ? attempt.id : attemptId;
  // P0 完成闭环（执行面记账）：执行开始时把意图推进到 running（§10.1 proposed→queued→running）。
  // 失败不阻断执行（网关/租约才是硬边界），如实写进返回值供审计。
  let intentState = null;
  try {
    intentState = await ensureIntentRunning(pctx, { projectId, intentId, attemptId: resolvedAttemptId });
  } catch (error) {
    intentState = { ok: false, note: "意图状态推进失败：" + String(error?.message ?? error) };
  }

  // 成本：Worker 视图字符预算 24k→12k（证据本体仍可按编号 read_record）。
  const ctxView = await generateWorkerContext(pctx, { projectId, intentId, actor, maxChars: 12000 });

  // tool_call_id → { observation（摘要）, rawBody（完整原始字节）, request, evidence（表示→回执） }
  const probeCache = new Map();

  const tools = [
    {
      name: "read_record",
      description: "按编号读取持久记录与证据索引（§11.2）。",
      parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      async execute(args) {
        return getRecord(pctx, { projectId, id: String(args.id || "") });
      },
    },
    {
      name: "register_tool_call",
      description:
        "经工具网关登记并真实执行 http_probe（GET 目标 URL）：网关先校验范围/前提/租约（拒绝优先），登记 planned→running 后执行真实请求；返回工具调用编号与观测结果。",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "绝对 URL（必须落在项目授权范围内；范围外的目标会被网关拒绝）" },
          purpose: { type: "string", description: "本次调用的目的（入档案）" },
        },
        required: ["url"],
      },
      async execute(args) {
        const url = String(args.url || "");
        const registered = await toolGateway(pctx, {
          session,
          action: "register",
          attemptId: attempt ? attempt.id : attemptId,
          fencingToken: token,
          toolName: "http_probe",
          args: { url, purpose: args.purpose ?? "" },
        });
        const callId = registered.tool_call.id;
        await toolGateway(pctx, {
          session,
          action: "start",
          attemptId: attempt ? attempt.id : attemptId,
          toolCallId: callId,
          fencingToken: token,
          targets: [url],
        });
        const probe = await executeHttpProbe(url);
        // 自动固定证据（纠偏 §四）：请求完成即持久化，模型收到持久引用
        let evidence = null;
        try {
          evidence = await autoFixEvidence({
            pctx, projectId, session, probe, callId,
            attemptId: attempt ? attempt.id : attemptId,
            token, actor,
          });
          probeCache.set(callId, { url, observation: probe.observation, rawBody: probe.rawBody, request: probe.request, evidence: new Map([["exchange_record", evidence]]) });
        } catch {
          // 自动固定失败——回退到旧路径，模型可手动调 store_evidence + complete_tool_call
          probeCache.set(callId, { url, observation: probe.observation, rawBody: probe.rawBody, request: probe.request, evidence: new Map() });
        }
        return {
          tool_call_id: callId,
          gate: registered.gate ?? null,
          observation: probe.observation,
          ...(evidence ? { evidence, note: "证据已自动固定（blob_id/capture_id 为持久引用）——无需再调 store_evidence + complete_tool_call" } : {}),
        };
      },
    },
    {
      name: "http_request",
      description:
        "经工具网关执行一次受控的非 GET 请求（POST/PUT/PATCH/DELETE/HEAD/OPTIONS）：网关先校验范围/前提/租约（拒绝优先），"
        + "登记 planned→running 后执行真实请求；不跟随重定向（3xx 原样返回）。用于登录/表单/参数/上传面探测与利用验证。"
        + "返回 tool_call_id；随后用 store_evidence 固定证据、complete_tool_call 落定。",
      parameters: {
        type: "object",
        properties: {
          method: { type: "string", enum: ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] },
          url: { type: "string", description: "绝对 URL（必须落在项目授权范围内；范围外会被网关拒绝）" },
          headers: { type: "object", description: "自定义请求头（字符串值）；Host/Content-Length 由底层管理" },
          body: { type: "string", description: "请求体原文（form-urlencoded 或 JSON 字符串）" },
          purpose: { type: "string", description: "本次调用的目的（入档案）" },
        },
        required: ["method", "url"],
      },
      async execute(args) {
        const url = String(args.url || "");
        const openStore = await getStore(pctx);
        const openCall = openStore.db
          .prepare("SELECT id FROM tool_calls WHERE project_id = ? AND attempt_id = ? AND status IN ('planned','running') LIMIT 1")
          .get(projectId, attempt ? attempt.id : attemptId);
        if (openCall) {
          throw apiError("PRECONDITION_INVALID", "上一个工具调用尚未落定（" + openCall.id + "）：先 store_evidence + complete_tool_call 再发起下一次探测", {
            detail: { open_tool_call_id: openCall.id },
            next_requirements: ["store_evidence（固定证据）→ complete_tool_call（落定）→ 再 register_tool_call/http_request"],
          });
        }
        const method = String(args.method || "POST").toUpperCase();
        const headers = args.headers && typeof args.headers === "object" ? args.headers : {};
        const body = args.body === undefined || args.body === null ? "" : String(args.body);
        const toolName = "http_" + method.toLowerCase();
        const registered = await toolGateway(pctx, {
          session,
          action: "register",
          attemptId: attempt ? attempt.id : attemptId,
          fencingToken: token,
          toolName,
          args: {
            url,
            method,
            body_sha256: sha256Hex(Buffer.from(body)),
            body_bytes: Buffer.byteLength(body),
            purpose: args.purpose ?? "",
          },
        });
        const callId = registered.tool_call.id;
        await toolGateway(pctx, {
          session,
          action: "start",
          attemptId: attempt ? attempt.id : attemptId,
          toolCallId: callId,
          fencingToken: token,
          targets: [url],
        });
        const probe = await executeHttpProbe(url, {
          method,
          headers,
          body: method === "GET" || method === "HEAD" ? null : body,
        });
        // 自动固定证据（纠偏 §四）
        let evidence = null;
        try {
          evidence = await autoFixEvidence({
            pctx, projectId, session, probe, callId,
            attemptId: attempt ? attempt.id : attemptId,
            token, actor,
          });
          probeCache.set(callId, { url, observation: probe.observation, rawBody: probe.rawBody, request: probe.request, evidence: new Map([["exchange_record", evidence]]) });
        } catch {
          probeCache.set(callId, { url, observation: probe.observation, rawBody: probe.rawBody, request: probe.request, evidence: new Map() });
        }
        return {
          tool_call_id: callId,
          gate: registered.gate ?? null,
          observation: probe.observation,
          ...(evidence ? { evidence, note: "证据已自动固定——无需再调 store_evidence + complete_tool_call" } : {}),
        };
      },
    },
    {
      name: "store_evidence",
      description:
        "把某次工具调用的观测固定为不可变证据（§13：staging→固定→登记 Blob/Capture）。representation 二选一："
        + "raw_body = 逐字节原始响应体（与探测到的字节完全一致，sha256 可核对）；"
        + "exchange_record = 含完整请求元数据/全量响应头/响应体的 JSON。"
        + "同一 tool_call 只允许固定一次表示（C2 采集以 tool_call_id 去重，§13）；同一表示的重复调用幂等返回原回执。"
        + "必须在 complete_tool_call 之前调用。",
      parameters: {
        type: "object",
        properties: {
          tool_call_id: { type: "string", description: "register_tool_call 返回的工具调用编号" },
          representation: { type: "string", enum: ["raw_body", "exchange_record"], description: "固定哪种表示（默认 exchange_record：完整请求/响应记录）" },
        },
        required: ["tool_call_id"],
      },
      async execute(args) {
        const toolCallId = String(args.tool_call_id || "");
        const resolvedAttemptId = attempt ? attempt.id : attemptId;
        const probe = probeCache.get(toolCallId);
        if (!probe) {
          throw apiError("INVALID_REFERENCE", "未找到工具调用 " + toolCallId + " 的观测（先 register_tool_call）", {
            next_requirements: ["先调用 register_tool_call 真实探测，再固定证据"],
          });
        }
        const requested = args.representation === "raw_body" ? "raw_body" : "exchange_record";
        const done = probe.evidence.get(requested);
        if (done) {
          return { ...done, idempotent: true, note: "同一工具调用同一表示的重复固定：返回原 Blob/Capture（幂等，不产生新证据）" };
        }
        if (probe.evidence.size > 0) {
          const held = [...probe.evidence.keys()].join(" / ");
          throw apiError(
            "PRECONDITION_INVALID",
            "工具调用 " + toolCallId + " 已固定为 " + held + " 表示；一次工具调用只允许一种表示（C2 采集以 tool_call_id 去重，§13）",
            {
              detail: { tool_call_id: toolCallId, existing_representation: held },
              next_requirements: ["同一表示的重复调用返回原回执；需要另一种表示时请新建一次 register_tool_call 再固定"],
            },
          );
        }
        // raw_body 需要真实字节；探测失败（无响应体）时降级为 exchange_record 并注明
        const effective = requested === "raw_body" && probe.rawBody ? "raw_body" : "exchange_record";
        let bytes;
        let bodySha = null;
        let truncation = null;
        if (effective === "raw_body") {
          const body = probe.rawBody;
          const truncated = body.length > MAX_EVIDENCE_BYTES;
          bytes = truncated ? body.subarray(0, MAX_EVIDENCE_BYTES) : body;
          bodySha = sha256Hex(body);
          if (truncated) {
            truncation = {
              truncated: true,
              cap_bytes: MAX_EVIDENCE_BYTES,
              kept_bytes: bytes.length,
              omitted_bytes: body.length - bytes.length,
              note: "响应体超过证据单上限，已显式截断并保留 body_sha256（完整字节哈希）用于核对",
            };
          }
        } else {
          const record = buildExchangeRecord({ probe, toolCallId, attemptId: resolvedAttemptId });
          bytes = Buffer.from(JSON.stringify(record, null, 2), "utf8");
          bodySha = record.response.body_sha256;
          if (record.response.body_truncated) {
            truncation = {
              truncated: true,
              cap_bytes: MAX_EVIDENCE_BYTES,
              kept_bytes: record.response.body_kept_bytes,
              omitted_bytes: record.response.body_omitted_bytes,
              note: record.response.truncation_note,
            };
          }
        }
        const sha256 = sha256Hex(bytes);
        const blob = await storeBlob(pctx, {
          projectId,
          bytes,
          representation: effective,
          sourceKind: "tool_gateway",
          actor,
          expectedSha256: sha256,
        });
        // 完整依据层：raw_body 表示另存请求记录与全量响应头（capture 的 request_ref / response_headers_ref）
        let requestBlob = null;
        let headersBlob = null;
        if (effective === "raw_body") {
          const headersBytes = Buffer.from(
            JSON.stringify(
              {
                schema: "sorne.response_headers/v1",
                tool_call_id: toolCallId,
                content_type: probe.observation.content_type,
                body_charset: probe.observation.body_charset,
                status: probe.observation.status,
                headers: probe.observation.headers,
              },
              null,
              2,
            ),
            "utf8",
          );
          headersBlob = await storeBlob(pctx, {
            projectId,
            bytes: headersBytes,
            representation: "derived",
            sourceKind: "tool_gateway",
            actor,
            expectedSha256: sha256Hex(headersBytes),
          });
          const requestBytes = Buffer.from(
            JSON.stringify({ schema: "sorne.request_record/v1", tool_call_id: toolCallId, request: probe.request }, null, 2),
            "utf8",
          );
          requestBlob = await storeBlob(pctx, {
            projectId,
            bytes: requestBytes,
            representation: "request_record",
            sourceKind: "tool_gateway",
            actor,
            expectedSha256: sha256Hex(requestBytes),
          });
        }
        const capture = await registerCapture(
          pctx,
          {
            project_id: projectId,
            tool_call_id: toolCallId,
            attempt_id: resolvedAttemptId,
            request_url_exact: probe.url,
            // 采集的方法必须来自真实请求（此前硬编码 GET：POST 探测的 capture 被记成 GET，
            // O-0432 实测发现，会误导验证与报告）。
            method: (probe.request && typeof probe.request.method === "string" ? probe.request.method : "GET").toUpperCase(),
            observed_at: probe.observation.observed_at,
            response_body_blob: blob.blob_id,
            ...(requestBlob ? { request_ref: requestBlob.blob_id } : {}),
            ...(headersBlob ? { response_headers_ref: headersBlob.blob_id } : {}),
            condition_snapshot_id: "worker-agent:" + actor,
            integrity_status: "verified",
          },
          { actor },
        );
        // 图谱自动登记（R20）：每固定一份证据就登记服务资产 + HTTP 资源样本，不依赖 AI
        // 是否记得；失败只影响视图，不影响证据事实（吞掉错误留给诊断）。
        try {
          const probeMethod = probe.request && probe.request.method ? String(probe.request.method).toUpperCase() : "GET";
          let origin = null;
          try { origin = new URL(probe.url).origin + "/"; } catch { origin = null; }
          if (origin) {
            const mapReceipt = await submit(pctx, {
              session,
              envelope: {
                submission_id: deterministicSubmissionId("MAP", {
                  project_id: projectId,
                  attempt_id: resolvedAttemptId,
                  url: probe.url,
                  method: probeMethod,
                }),
                attempt_id: resolvedAttemptId,
                operations: [
                  { op: "register_service_asset", local_ref: "svcAuto", url: origin },
                  { op: "register_http_resource", local_ref: "resAuto", url: probe.url, method: probeMethod },
                ],
              },
            });
            // 接口模板自动提案（R20）：路径含数字/UUID/Hash 段时按推导模板登记候选，
            // INSERT OR IGNORE 保证同模板只保留一条；失败忽略（视图增强，不影响证据）。
            const svcId = mapReceipt && mapReceipt.ids ? mapReceipt.ids.svcAuto : null;
            const resId = mapReceipt && mapReceipt.ids ? mapReceipt.ids.resAuto : null;
            if (svcId && resId) {
              try {
                const { derivePathTemplate } = await import("../store/dedup.mjs");
                const pathname = new URL(probe.url).pathname;
                const derived = derivePathTemplate(pathname);
                if (derived.folded_segments.length > 0) {
                  await submit(pctx, {
                    session,
                    envelope: {
                      submission_id: deterministicSubmissionId("TPL", {
                        project_id: projectId,
                        attempt_id: resolvedAttemptId,
                        path_template: derived.path_template,
                        method: probeMethod,
                      }),
                      attempt_id: resolvedAttemptId,
                      operations: [
                        {
                          op: "propose_endpoint_template",
                          local_ref: "tplAuto",
                          resource_ids: [resId],
                          service_asset_id: svcId,
                        },
                      ],
                    },
                  });
                }
              } catch {
                /* 模板提案失败忽略 */
              }
            }
          }
        } catch {
          /* 图谱登记失败不影响证据事实 */
        }
        const receipt = {
          blob,
          capture,
          representation: effective,
          requested_representation: requested,
          byte_size: bytes.length,
          body_bytes: probe.observation.body_bytes ?? null,
          body_sha256: bodySha,
          headers_count: probe.observation.headers_count ?? null,
          body_charset: probe.observation.body_charset ?? null,
          truncation,
          request_ref: requestBlob ? requestBlob.blob_id : null,
          response_headers_ref: headersBlob ? headersBlob.blob_id : null,
          note: effective === "raw_body"
            ? "raw_body = 逐字节原始响应体（byte_size 与探测 body_bytes 一致；body_sha256 可核对）"
            : "exchange_record = 完整请求/响应 JSON（含全量响应头与响应体；超过上限才显式截断并注明）",
        };
        probe.evidence.set(effective, receipt);
        if (requested !== effective) {
          probe.evidence.set(requested, receipt);
        }
        return receipt;
      },
    },
    {
      name: "complete_tool_call",
      description: "落定工具调用（succeeded/failed；可带 evidence_refs）。完成建议前全部调用须终态（§10.2）。",
      parameters: {
        type: "object",
        properties: {
          tool_call_id: { type: "string" },
          outcome: { type: "string", enum: ["succeeded", "failed"] },
          evidence_refs: { type: "array", items: { type: "string" }, description: "证据编号（B-…/CAP-…），来自 store_evidence" },
        },
        required: ["tool_call_id", "outcome"],
      },
      async execute(args) {
        const result = await toolGateway(pctx, {
          session,
          action: "complete",
          attemptId: attempt ? attempt.id : attemptId,
          toolCallId: String(args.tool_call_id || ""),
          fencingToken: token,
          outcome: args.outcome === "failed" ? "failed" : "succeeded",
          evidenceRefs: Array.isArray(args.evidence_refs) ? args.evidence_refs : [],
          touchedTargets: [],
        });
        return result;
      },
    },
    {
      name: "resolve_tool_call",
      description:
        "核查一个 unknown 工具调用的现状并登记实际结果（succeeded/failed/cancelled）。"
        + "§10.2：unknown 未 resolve 前不得重试同身份调用、也不得提交 completion；必须先检查现状并写清 check_note。",
      parameters: {
        type: "object",
        properties: {
          tool_call_id: { type: "string", description: "unknown 状态的工具调用编号" },
          outcome: { type: "string", enum: ["succeeded", "failed", "cancelled"], description: "核查后判定的实际结果" },
          check_note: { type: "string", description: "核查说明：核查了什么、现状如何、为何判为该结果（§10.2 必需）" },
          evidence_refs: { type: "array", items: { type: "string" }, description: "支撑现状判断的证据编号（可选）" },
        },
        required: ["tool_call_id", "outcome", "check_note"],
      },
      async execute(args) {
        return toolGateway(pctx, {
          session,
          action: "resolve",
          attemptId: attempt ? attempt.id : attemptId,
          toolCallId: String(args.tool_call_id || ""),
          fencingToken: token,
          outcome: args.outcome,
          checkNote: String(args.check_note || ""),
          evidenceRefs: Array.isArray(args.evidence_refs) ? args.evidence_refs : [],
        });
      },
    },
    {
      name: "submit_findings",
      description:
        "即时提交发现（§2 约束 1）：register_service_asset/register_http_resource/append_observation/propose_hypothesis/report_vulnerability；"
        + "同一事务返回正式编号。图谱纪律：新主机/端口用 register_service_asset 登记、带参数的精确 URL 用 register_http_resource 登记；"
        + "同一批同时提交观察与漏洞时，程序会自动写入 supports 关系把证据挂到该漏洞（§7.3/§8.3，Manifest 依赖该成员）。",
      parameters: {
        type: "object",
        properties: {
          note: { type: "string", description: "本批提交说明（幂等键成分）" },
          register_service_asset: {
            type: "object",
            properties: {
              url: { type: "string", description: "服务/主机 URL（来自当前授权范围或实际探测发现），经 D2 版本化规范化后登记为服务资产" },
              asset_type: { type: "string", description: "资产类型（默认 service）" },
            },
          },
          register_http_resource: {
            type: "object",
            properties: {
              url: { type: "string", description: "精确 URL（含 query），登记为 HTTP 资源样本（method+url_exact 身份）" },
              method: { type: "string", description: "HTTP 方法（默认 GET）" },
            },
          },
          register_asset: {
            type: "object",
            properties: {
              asset_type: { type: "string" },
              canonicalization_version: { type: "string" },
              canonical_key: { type: "string" },
              parent_asset_id: { type: "string", description: "父资产编号（如 A-0001），构建层级树：host > product > component > entry" },
            },
          },
          append_observation: {
            type: "object",
            properties: {
              statement: { type: "string" },
              capture_id: { type: "string", description: "store_evidence 返回的 capture 编号（有采集时必填）" },
              conditions: { type: "array", items: { type: "string" } },
            },
          },
          propose_hypothesis: {
            type: "object",
            properties: { statement: { type: "string" }, conditions: { type: "array", items: { type: "string" } } },
          },
          report_vulnerability: {
            type: "object",
            properties: {
              category: { type: "string" },
              asset_id: { type: "string" },
              location: { type: "string" },
              impact: { type: "string" },
            },
          },
          relations: {
            type: "array",
            description:
              "追加关系（§7.3）：常用于把既有证据绑到既有判断上，例如 "
              + "{from:\"O-0123\", type:\"supports\", to:\"V-0002\"}；同批 local_ref（obs1/hyp1/vuln1）也可作为端点。"
              + "对已存在的 suspected 漏洞补证时必须用它写 supports，否则 Manifest 仍为空、验证只会 insufficient。",
            items: {
              type: "object",
              properties: {
                from: { type: "string", description: "起点编号或同批 local_ref（如 obs1 / O-0123）" },
                to: { type: "string", description: "终点编号或同批 local_ref（如 V-0002 / vuln1）" },
                type: { type: "string", description: "关系类型，默认 supports；也可 contradicts/derived_from 等 §9.1 类型" },
              },
              required: ["from", "to"],
            },
          },
        },
        required: ["note"],
      },
      async execute(args) {
        const operations = [];
        if (args.register_service_asset && args.register_service_asset.url) {
          operations.push({
            op: "register_service_asset",
            local_ref: "svc1",
            url: String(args.register_service_asset.url),
            ...(args.register_service_asset.asset_type ? { asset_type: String(args.register_service_asset.asset_type) } : {}),
          });
        }
        if (args.register_http_resource && args.register_http_resource.url) {
          operations.push({
            op: "register_http_resource",
            local_ref: "res1",
            url: String(args.register_http_resource.url),
            method: String(args.register_http_resource.method || "GET").toUpperCase(),
          });
        }
        if (args.register_asset && args.register_asset.canonical_key) {
          operations.push({
            op: "register_asset",
            local_ref: "asset1",
            asset_type: args.register_asset.asset_type || "domain",
            canonicalization_version: args.register_asset.canonicalization_version || "v1",
            canonical_key: String(args.register_asset.canonical_key),
            ...(args.register_asset.parent_asset_id ? { parent_asset_id: String(args.register_asset.parent_asset_id) } : {}),
          });
        }
        if (args.append_observation && args.append_observation.statement) {
          operations.push({
            op: "append_observation",
            local_ref: "obs1",
            statement: String(args.append_observation.statement),
            ...(args.append_observation.capture_id ? { capture_id: String(args.append_observation.capture_id) } : {}),
            conditions: Array.isArray(args.append_observation.conditions) ? args.append_observation.conditions : [],
          });
        }
        if (args.propose_hypothesis && args.propose_hypothesis.statement) {
          operations.push({
            op: "propose_hypothesis",
            local_ref: "hyp1",
            statement: String(args.propose_hypothesis.statement),
            conditions: Array.isArray(args.propose_hypothesis.conditions) ? args.propose_hypothesis.conditions : [],
          });
        }
        if (args.report_vulnerability && args.report_vulnerability.category) {
          operations.push({
            op: "report_vulnerability",
            local_ref: "vuln1",
            category: String(args.report_vulnerability.category),
            ...(args.report_vulnerability.asset_id ? { asset_id: args.report_vulnerability.asset_id } : {}),
            ...(args.report_vulnerability.location ? { location: String(args.report_vulnerability.location) } : {}),
            ...(args.report_vulnerability.impact ? { impact: String(args.report_vulnerability.impact) } : {}),
          });
        }
        // 追加关系（§7.3）：显式 relations 优先（用于给既有漏洞补证）。
        if (Array.isArray(args.relations)) {
          for (const rel of args.relations) {
            if (!rel || !rel.from || !rel.to) continue;
            operations.push({
              op: "add_relation",
              from: String(rel.from),
              to: String(rel.to),
              type: String(rel.type || "supports"),
            });
          }
        }
        // 证据图谱闭环（§7.3/§8.3）：同批的观察 + 漏洞 → 自动写 supports 关系，
        // 使 D1 的不可变 Manifest 能包含证据成员（否则验证只能得 insufficient）。
        const hasObs = operations.some((o) => o.op === "append_observation");
        const hasVuln = operations.some((o) => o.op === "report_vulnerability");
        if (hasObs && hasVuln) {
          operations.push({ op: "add_relation", from: "obs1", type: "supports", to: "vuln1" });
        }
        if (!operations.length) {
          return { code: "BAD_REQUEST", message: "submit_findings 至少携带一种发现" };
        }
        const receipt = await submit(pctx, {
          session,
          envelope: {
            // P0：确定性幂等键（同 attempt + 同内容 → 同 submission_id → A1 返回原回执）
            submission_id: deterministicSubmissionId("WORKER", {
              project_id: projectId,
              attempt_id: attempt ? attempt.id : attemptId,
              operations,
            }),
            attempt_id: attempt ? attempt.id : attemptId,
            operations,
          },
        });
        return receipt;
      },
    },
    {
      name: "propose_endpoint_template",
      description:
        "用已登记的 HTTP 资源样本提案一个候选接口模板（§7.2：可确认/拆分/撤回，原始样本保留）。"
        + "resource_ids 必须来自 register_http_resource 回执（RES-…）且属于同一 method/路径模板；一次只提案一个模板。",
      parameters: {
        type: "object",
        properties: {
          resource_ids: { type: "array", items: { type: "string" }, description: "样本资源编号（RES-…），至少 1 个" },
          service_asset_id: { type: "string", description: "服务资产编号（可选；缺省取样本资源关联的服务资产）" },
        },
        required: ["resource_ids"],
      },
      async execute(args) {
        const ids = Array.isArray(args.resource_ids) ? args.resource_ids.map((v) => String(v)).filter(Boolean) : [];
        if (!ids.length) return { code: "BAD_REQUEST", message: "propose_endpoint_template 需要非空 resource_ids" };
        const operations = [{
          op: "propose_endpoint_template",
          resource_ids: ids,
          ...(args.service_asset_id ? { service_asset_id: String(args.service_asset_id) } : {}),
        }];
        const receipt = await submit(pctx, {
          session,
          envelope: {
            submission_id: deterministicSubmissionId("TEMPLATE", {
              project_id: projectId,
              attempt_id: attempt ? attempt.id : attemptId,
              operations,
            }),
            attempt_id: attempt ? attempt.id : attemptId,
            operations,
          },
        });
        return receipt;
      },
    },
    {
      name: "report_progress",
      description:
        "提交进展/阻塞/完成建议（progress/blocked/completion）。completion 前全部工具调用须终态（unknown 须先 resolve）；"
        + "完成只是建议：程序落定 Attempt 后立即按 C1 语义复核意图——意图声明了 deliverables 时必须同时提供 deliverables_proof"
        + "（每项 { index 或 key, record_ids:[真实记录编号] }，例如观察编号），齐备才 resolved；未声明交付物则进入待复核"
        + "（一句完成不能直接 resolved，§10.1）。",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["progress", "blocked", "completion"] },
          note: { type: "string" },
          condition_gaps: { type: "array", items: { type: "string" }, description: "缺少的身份/条件（blocked 时注明）" },
          deliverables_proof: {
            type: "array",
            description: "完成时给意图声明的必要产物逐项提供真实记录证明（意图未声明交付物时可省略）",
            items: {
              type: "object",
              properties: {
                index: { type: "integer", description: "交付物序号（从 0 开始）" },
                key: { type: "string", description: "交付物的 key（对象形态的交付物）" },
                record_ids: { type: "array", items: { type: "string" }, description: "真实持久记录编号（O-/CAP-/H-/V-/WR- 等）" },
              },
            },
          },
        },
        required: ["kind", "note"],
      },
      async execute(args) {
        const resolvedAttemptId = attempt ? attempt.id : attemptId;
        const progress = await reportProgress(pctx, {
          session,
          attemptId: resolvedAttemptId,
          kind: args.kind,
          note: String(args.note || ""),
          conditionGaps: Array.isArray(args.condition_gaps) ? args.condition_gaps : [],
          fencingToken: token,
        });
        // 完成闭环（P0）：Attempt 落定后由程序按 C1 语义复核意图完成。
        // 说明：late 的完成建议不改变 Attempt 状态，但若意图仍 running/awaiting_review，
        // 仍允许用本轮提供的证明补做复核（否则一次缺证明的完成会让意图永久停在 running）。
        let completionReview = null;
        if (args.kind === "completion" && progress && progress.attempt_status_after === "completed") {
          const reviewArgs = {
            projectId,
            actor,
            intentId,
            attemptId: resolvedAttemptId,
            deliverablesProof: Array.isArray(args.deliverables_proof) ? args.deliverables_proof : [],
            note: String(args.note || ""),
          };
          completionReview = await reviewIntentCompletion(pctx, reviewArgs);
          // AI 未带证明且被拒 → 用本次执行最新提交回执里的真实编号重试一次（程序核对存在性不变）
          if (completionReview && completionReview.decision === "rejected" && completionReview.code === "PRECONDITION_INVALID") {
            const auto = await deriveDeliverableProofs(pctx, { projectId, actor, intentId });
            if (auto.length) {
              const retried = await reviewIntentCompletion(pctx, { ...reviewArgs, deliverablesProof: auto });
              if (retried && retried.decision !== "rejected") {
                retried.proof_source = "auto_from_latest_submission";
                completionReview = retried;
              } else {
                completionReview.auto_proof_error = retried;
              }
            }
          }
        }
        return { ...progress, completion_review: completionReview };
      },
    },
    /* ── 阶段 3：批量提取保存工具 ──────────────────────────────── */
    {
      name: "save_extraction_batch",
      description:
        "把提取结果批量保存为持久条目（§八：不可变输入→有界批次→短回执）。"
        + "输入绑定 Blob/Capture 与提取器版本；条目记录出处与分类。"
        + "返回短回执（批次入口+分类计数+状态），不送全量条目进上下文。"
        + "同一幂等键重复调用返回原回执；同键不同内容报冲突。",
      parameters: {
        type: "object",
        properties: {
          idempotency_key: { type: "string", description: "幂等键（同一批次只保存一次）" },
          capture_id: { type: "string", description: "关联采集编号（可选）" },
          blob_id: { type: "string", description: "关联 Blob 编号（可选）" },
          input_sha256: { type: "string", description: "原始输入内容哈希" },
          extractor_name: { type: "string", description: "提取器名称" },
          extractor_version: { type: "string", description: "提取器版本" },
          items: {
            type: "array",
            description: "提取条目数组",
            items: {
              type: "object",
              properties: {
                category: { type: "string", description: "分类（如 domain/endpoint/email）" },
                value: { type: "string", description: "提取值" },
                source_locator: { type: "object", description: "出处定位（行/偏移/选择器等）" },
                confidence: { type: "string", description: "置信度（candidate/confirmed）" },
                metadata: { type: "object", description: "附加元数据" },
              },
              required: ["category", "value"],
            },
          },
        },
        required: ["idempotency_key", "input_sha256", "extractor_name", "extractor_version", "items"],
      },
      async execute(args) {
        return saveExtractionBatch(pctx, {
          projectId,
          idempotencyKey: String(args.idempotency_key),
          captureId: args.capture_id || null,
          blobId: args.blob_id || null,
          inputSha256: String(args.input_sha256),
          extractorName: String(args.extractor_name),
          extractorVersion: String(args.extractor_version),
          intentId,
          attemptId: resolvedAttemptId,
          runId: resolvedAttemptId,
          actor,
          items: Array.isArray(args.items) ? args.items : [],
        });
      },
    },
    /* ── 纠偏 §五：从证据直接提取并保存批次 ──────────────────── */
    {
      name: "extract_from_evidence",
      description:
        "从持久化的 Blob/Capture 读取内容，执行工具侧提取（域名/URL/邮箱/配置等），"
        + "直接保存完整批次并返回短回执。模型无需转述全部条目（§八：大量机械结果无需由模型生成）。",
      parameters: {
        type: "object",
        properties: {
          blob_id: { type: "string", description: "Blob 编号（B-…）" },
          capture_id: { type: "string", description: "Capture 编号（CAP-…；若指定则从 capture 关联的 blob 读取）" },
          categories: { type: "array", items: { type: "string" }, description: "提取类别（如 [\"domain\",\"url\",\"email\"]）；为空则提取所有识别的类别" },
        },
      },
      async execute(args) {
        const { readBlobBytes: readBlob } = await import("../store/evidence.mjs");
        let blobSha = null;
        if (args.capture_id) {
          const store0 = await getStore(pctx);
          const cap = store0.db.prepare("SELECT response_body_blob FROM captures WHERE project_id = ? AND id = ?").get(projectId, args.capture_id);
          if (!cap) throw apiError("INVALID_REFERENCE", "Capture 不存在：" + args.capture_id);
          const blobRow = store0.db.prepare("SELECT sha256 FROM blobs WHERE project_id = ? AND id = ?").get(projectId, cap.response_body_blob);
          if (blobRow) blobSha = blobRow.sha256;
        } else if (args.blob_id) {
          const store0 = await getStore(pctx);
          const blobRow = store0.db.prepare("SELECT sha256 FROM blobs WHERE project_id = ? AND id = ?").get(projectId, args.blob_id);
          if (blobRow) blobSha = blobRow.sha256;
        }
        if (!blobSha) throw apiError("INVALID_REFERENCE", "未找到可读取的 Blob");

        const { bytes } = await readBlob(pctx, { sha256: blobSha, projectId });
        const text = bytes.toString("utf8");
        const inputHash = sha256Hex(bytes);

        // 工具侧提取
        const items = [];
        const cats = new Set(Array.isArray(args.categories) && args.categories.length > 0 ? args.categories : ["domain", "url", "email", "ip"]);
        if (cats.has("domain")) {
          const domains = text.match(/(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}/gi) || [];
          const unique = [...new Set(domains)];
          for (const d of unique) items.push({ category: "domain", value: d.toLowerCase() });
        }
        if (cats.has("url")) {
          const urls = text.match(/https?:\/\/[^\s"'<>\]]+/gi) || [];
          const unique = [...new Set(urls)];
          for (const u of unique) items.push({ category: "url", value: u });
        }
        if (cats.has("email")) {
          const emails = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
          const unique = [...new Set(emails)];
          for (const e of unique) items.push({ category: "email", value: e.toLowerCase() });
        }
        if (cats.has("ip")) {
          const ips = text.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) || [];
          const unique = [...new Set(ips)].filter((ip) => !ip.startsWith("0.") && ip !== "127.0.0.1" && ip !== "0.0.0.0");
          for (const ip of unique) items.push({ category: "ip", value: ip });
        }

        if (items.length === 0) {
          return { extracted: 0, note: "未从证据中提取到匹配项" };
        }

        const idemKey = "auto-extract-" + inputHash.slice(0, 16) + "-" + items.length;
        return saveExtractionBatch(pctx, {
          projectId,
          idempotencyKey: idemKey,
          captureId: args.capture_id || null,
          blobId: args.blob_id || null,
          inputSha256: inputHash,
          extractorName: "sorne-auto-extractor",
          extractorVersion: "1.0.0",
          intentId,
          attemptId: resolvedAttemptId,
          runId: resolvedAttemptId,
          actor,
          items,
        });
      },
    },
    /* ── 阶段 4：覆盖记录工具 ────────────────────────────────── */
    {
      name: "save_check_record",
      description:
        "保存一条检查记录（§十：覆盖记录围绕具体工作保存）。记录材料范围、检查方法、"
        + "发现入口、未覆盖部分与适用条件。覆盖状态：checked/partial/unknown。"
        + "Worker 可以批量提交这份说明，不必逐项调用状态工具。",
      parameters: {
        type: "object",
        properties: {
          material_ids: { type: "array", items: { type: "string" }, description: "涉及材料的记录编号" },
          material_range: { type: "object", description: "材料的字节/行/选择器范围" },
          check_method: { type: "string", description: "检查方法说明（如「接口名称及调用位置」）" },
          findings_entry_ids: { type: "array", items: { type: "string" }, description: "发现入口编号（O-/H-/V- 等）" },
          uncovered_parts: { type: "array", items: { type: "string" }, description: "未覆盖部分说明" },
          applicable_conditions: { type: "array", items: { type: "string" }, description: "适用条件" },
          coverage_status: { type: "string", enum: ["checked", "partial", "unknown"], description: "覆盖状态" },
          note: { type: "string" },
        },
        required: ["check_method"],
      },
      async execute(args) {
        return saveCheckRecord(pctx, {
          projectId,
          intentId,
          attemptId: resolvedAttemptId,
          materialIds: args.material_ids,
          materialRange: args.material_range,
          checkMethod: String(args.check_method),
          findingsEntryIds: args.findings_entry_ids,
          uncoveredParts: args.uncovered_parts,
          applicableConditions: args.applicable_conditions,
          coverageStatus: args.coverage_status || "unknown",
          note: args.note,
          actor,
        });
      },
    },
    /* ── 阶段 2：主动阅读协议工具 ────────────────────────────── */
    {
      name: "read_open",
      description: "打开导航节点（根入口 root:assets / root:exploration，或记录编号）。",
      parameters: { type: "object", properties: { node_id: { type: "string" } }, required: ["node_id"] },
      async execute(args) { return openNode(pctx, { projectId, nodeId: String(args.node_id || "") }); },
    },
    {
      name: "read_children",
      description: "列出节点的子入口（分页；cursor 续读）。",
      parameters: { type: "object", properties: { node_id: { type: "string" }, cursor: { type: "string" }, limit: { type: "integer" } }, required: ["node_id"] },
      async execute(args) { return listChildren(pctx, { projectId, nodeId: String(args.node_id), cursor: args.cursor, limit: args.limit }); },
    },
    {
      name: "read_search",
      description: "按关键词搜索记录（返回面包屑与来源）。",
      parameters: { type: "object", properties: { query: { type: "string" }, kinds: { type: "array", items: { type: "string" } }, cursor: { type: "string" }, limit: { type: "integer" } }, required: ["query"] },
      async execute(args) { return searchNodes(pctx, { projectId, query: args.query, kinds: args.kinds, cursor: args.cursor, limit: args.limit }); },
    },
    {
      name: "read_follow",
      description: "沿关系边跳转到关联节点。",
      parameters: { type: "object", properties: { node_id: { type: "string" }, types: { type: "array", items: { type: "string" } }, direction: { type: "string", enum: ["outgoing","incoming","both"] } }, required: ["node_id"] },
      async execute(args) { return followRelations(pctx, { projectId, nodeId: String(args.node_id), types: args.types, direction: args.direction }); },
    },
    {
      name: "read_parent",
      description: "返回上层节点。",
      parameters: { type: "object", properties: { node_id: { type: "string" } }, required: ["node_id"] },
      async execute(args) { return navigateParent(pctx, { projectId, nodeId: String(args.node_id) }); },
    },
    {
      name: "read_evidence_slice",
      description: "读取证据片段（返回 sha256、字节范围与内容；§十 记录实际读取范围）。",
      parameters: { type: "object", properties: { target_id: { type: "string" }, byte_offset: { type: "integer" }, byte_length: { type: "integer" } }, required: ["target_id"] },
      async execute(args) {
        return readEvidenceSlice(pctx, { projectId, targetId: String(args.target_id), byteOffset: args.byte_offset, byteLength: args.byte_length, role: "worker", actorId: actor, intentId, attemptId: resolvedAttemptId });
      },
    },
    {
      name: "bookmark_save",
      description: "保存阅读书签（§四 阅读位置与执行位置分别维护）。",
      parameters: { type: "object", properties: { node_id: { type: "string" }, bookmark_key: { type: "string" }, note: { type: "string" } }, required: ["node_id"] },
      async execute(args) {
        return saveBookmark(pctx, { projectId, role: "worker", actorId: actor, attemptId: resolvedAttemptId, nodeId: String(args.node_id), bookmarkKey: args.bookmark_key || "default", note: args.note });
      },
    },
    {
      name: "bookmark_read",
      description: "读取已保存的阅读书签（支持继承同一意图前序 Attempt 的书签）。",
      parameters: { type: "object", properties: { bookmark_key: { type: "string" } } },
      async execute(args) {
        const key = args.bookmark_key || "default";
        // 先读本 Attempt 的书签
        const own = await getBookmark(pctx, { projectId, role: "worker", actorId: actor, attemptId: resolvedAttemptId, bookmarkKey: key });
        if (own) return own;
        // 纠偏 §六：回退到同一意图的前序 Attempt 书签
        const store0 = await getStore(pctx);
        const priorAttempts = store0.db.prepare(
          "SELECT id FROM attempts WHERE project_id = ? AND intent_id = ? AND id != ? ORDER BY created_seq DESC",
        ).all(projectId, intentId, resolvedAttemptId);
        for (const pa of priorAttempts) {
          const inherited = await getBookmark(pctx, { projectId, role: "worker", actorId: actor, attemptId: pa.id, bookmarkKey: key });
          if (inherited) return { ...inherited, inherited_from_attempt: pa.id, note: "继承自前序 Attempt 的书签（§六：跨 Attempt 接续阅读位置）" };
        }
        return null;
      },
    },
  ];

  const opening = [
    `你是项目 ${projectId} 意图 ${intentId} 的执行 Worker。项目上下文：`,
    JSON.stringify(ctxView, null, 1),
    "导航入口（纠偏 §三：从这里开始主动阅读，而非仅依赖上方供给面）：",
    "  root:assets — 资产根；root:exploration — 探索根",
    "  用 read_open / read_children / read_search / read_follow 按需展开证据和材料。",
    "HTTP 探测后证据已自动固定（blob_id/capture_id），无需手动调 store_evidence + complete_tool_call。",
    "提交发现用 submit_findings，报告进展用 report_progress。主动阅读尚未看到的材料再形成判断。",
  ].join("\n");

  const outcome = await runAgentLoop({ model, system: SYSTEM, tools, opening, maxSteps, role: "worker" });
  // 工具调用收口（§10.2）：循环结束时所有工具调用都已 await 完毕，仍为 running 的只可能是
  // 异常/中断遗留。程序直接标 unknown（不是语义判断，是资源与账目事实），避免 Attempt
  // 被悬挂调用拖到租约到期（实测 6 个 http_probe 悬挂导致 24 分钟停滞）。
  try {
    const store0 = await getStore(pctx);
    const hanging = store0.db
      .prepare("SELECT id FROM tool_calls WHERE project_id = ? AND attempt_id = ? AND status = 'running'")
      .all(projectId, resolvedAttemptId);
    for (const row of hanging) {
      try {
        await toolGateway(pctx, {
          session,
          action: "mark_unknown",
          attemptId: resolvedAttemptId,
          toolCallId: row.id,
          fencingToken: token,
          reason: "Worker 循环结束（" + outcome.stop_reason + "）但工具调用未落定；程序标 unknown（§10.2）",
        });
      } catch {
        /* 单个调用收口失败不阻断 */
      }
    }
  } catch {
    /* 收口读取失败不阻断 */
  }
  // 未完成收口（final/max_steps/provider_error）是「资源/执行事实」，由程序记录：
  // 1) 落 blocked 进度（模型文本 / provider 错误 / 步数用尽），让 Orchestrator 知道；
  // 2) 取消该 Attempt 释放租约——否则要等 30 分钟租约到期，期间 Orchestrator 看到
  //    leased 但没有 worker 在跑，形成 20+ 分钟停滞（实测多次）。
  const noCompletion = ["final", "max_steps", "provider_error"].includes(outcome.stop_reason);
  if (noCompletion) {
    const finalText = typeof outcome.final === "string" ? outcome.final : "";
    const detailText = outcome.stop_reason === "final"
      ? "模型最终文本（截断）：" + finalText.slice(0, 600)
      : outcome.stop_reason === "provider_error"
        ? "provider_error：" + String(outcome.error?.message ?? "").slice(0, 600)
        : "达到 maxSteps=" + maxSteps + "，未提交 completion";
    // 纠偏 §六：步数耗尽时保存检查点而非直接取消，后续 Attempt 可接手
    if (outcome.stop_reason === "max_steps") {
      try {
        await createCheckpoint(pctx, {
          projectId, intentId, attemptId: resolvedAttemptId, actor,
          note: "Worker 步数预算耗尽（maxSteps=" + maxSteps + "），保存检查点供后续接手",
        });
      } catch { /* 检查点保存失败不阻断收口 */ }
    }
    let attemptStillActive = true;
    try {
      const store0 = await getStore(pctx);
      const row = store0.db.prepare("SELECT status FROM attempts WHERE project_id = ? AND id = ?").get(projectId, resolvedAttemptId);
      attemptStillActive = Boolean(row && (row.status === "leased" || row.status === "running"));
    } catch {
      attemptStillActive = true;
    }
    if (!attemptStillActive) {
      try {
        pctx.logger?.info?.("[sorne-worker] " + intentId + "/" + resolvedAttemptId + " " + outcome.stop_reason + " (attempt 已终态)");
      } catch { /* ignore */ }
    } else {
      try {
        pctx.logger?.info?.(
          "[sorne-worker] " + intentId + "/" + resolvedAttemptId + " " + outcome.stop_reason
            + " finish_reason=" + (outcome.finish_reason ?? "?") + " steps=" + outcome.steps,
        );
      } catch { /* ignore */ }
      try {
        await reportProgress(pctx, {
          session,
          attemptId: resolvedAttemptId,
          kind: "blocked",
          note:
            "【程序记录】Worker 循环以 " + outcome.stop_reason + " 结束（finish_reason=" + (outcome.finish_reason ?? "?")
            + "，steps=" + outcome.steps + "），未调用 report_progress(completion)；" + detailText,
          fencingToken: token,
        });
      } catch {
        /* 迟到/租约失效时 reportProgress 会留档或报错；不阻断 */
      }
      try {
        await attemptLifecycle(pctx, {
          session,
          attemptId: resolvedAttemptId,
          action: "cancel",
          fencingToken: token,
          // 模型服务故障由 provider 退避控制，不能耗尽单个探索方向的预算。
          reasonCode: outcome.stop_reason === "provider_error" ? "reassign" : "retryable",
          reason: "Worker 未完成（stop_reason=" + outcome.stop_reason + "）；程序记录 blocked 并释放租约，交由 Orchestrator 重派/暂缓",
        });
      } catch {
        /* 已终态/租约失效时忽略 */
      }
    }
  }
  const lastReview = [...outcome.trace]
    .reverse()
    .find((t) => t.tool === "report_progress" && t.result && t.result.completion_review);
  return {
    role: "worker",
    actor,
    project_id: projectId,
    intent_id: intentId,
    attempt_id: attempt ? attempt.id : attemptId,
    fencing_token: token,
    intent_state: intentState,
    completion_review: lastReview ? lastReview.result.completion_review : null,
    ...outcome,
  };
}
