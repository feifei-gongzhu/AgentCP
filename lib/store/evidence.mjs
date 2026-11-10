/**
 * A2 —— 证据存储与采集记录（Evidence Store，规范 §5.3 §5.4 §13）。
 *
 * §13 写入顺序（唯一实现的编排，端点与后续模块复用）：
 *   1. 上传到 staging（随机名临时文件 + fsync）；
 *   2. 计算并校验内容 SHA-256（可选 expected_sha256 对照，防传输损坏）；
 *   3. 固定到 evidence/blobs/sha256/<ab>/<完整哈希>（rename；目标已存在则校验
 *      内容一致后去重，绝不覆盖不可变内容）；
 *   4. 数据库事务登记 Blob / Capture / transforms 与 Outbox 事件（runSerial
 *      串行短事务；数据库不提交对未固定文件的可用证据引用）；
 *   5. 返回成功回执（内容寻址天然幂等；Capture 以 tool_call_id 去重）。
 *
 * 文件固定成功但数据库失败会留下孤立 Blob（findStorageAnomalies 可识别）；
 * 首版不自动删除（§13 清理策略前置条件未满足）。
 *
 * Capture（§5.3）：每次采集单独建立记录；相同 Blob 可被多个 Capture 引用，
 * 内容去重不得删除采集历史；表示形式必须注明；第三方导入/worker 上传标记来源。
 *
 * EvidenceAnchor（§5.4）：绑定 capture_id + blob_hash + representation + 定位符，
 * 行号绑定确切版本与文本解码方式（text_encoding）；格式化产物的行号绑定派生
 * Blob（transform_id），不声称是原始 JS 的行号。
 */
import { createHash, randomBytes } from "node:crypto";
import { access, constants, mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import { openDatabase } from "../db.mjs";
import { ApiError, apiError } from "../errors.mjs";
import * as layout from "./layout.mjs";

export const REPRESENTATIONS = Object.freeze([
  "raw_body",
  "decoded_body",
  "request_record",
  "exchange_record",
  "derived",
  "uploaded_file",
]);
export const SOURCE_KINDS = Object.freeze(["tool_gateway", "third_party_import", "worker_upload"]);
export const INTEGRITY_STATUS = Object.freeze(["verified", "mismatch", "missing"]);
export const EVENT_SCHEMA_VERSION = 1;
const PRODUCER_ID = "sorne.a2.evidence";
const DEFAULT_MAX_BLOB_BYTES = 64 * 1024 * 1024;

/** 证据单 Blob 上限（rawBody 路由自定上限，§11.2/蓝图 §2.2）；可用环境变量覆盖。 */
export function evidenceMaxBytes() {
  const v = Number(process.env.SORNE_EVIDENCE_MAX_BYTES);
  return Number.isSafeInteger(v) && v > 0 ? v : DEFAULT_MAX_BLOB_BYTES;
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function isSha256(text) {
  return typeof text === "string" && /^[0-9a-f]{64}$/.test(text);
}

function badRequest(message, extra) {
  return apiError("BAD_REQUEST", message, extra);
}

/** 存储不可用/磁盘故障：可重试错误，绝不制造「已有证据」事实（§13/§20.3 场景 25）。 */
function storageError(message, extra = {}) {
  return apiError("INTERNAL_ERROR", `证据存储不可用：${message}`, {
    retryable: true,
    next_requirements: ["证据存储恢复后重试上传；未成功的上传不会留下可用证据记录"],
    ...extra,
  });
}

function logWarn(pctx, message) {
  try {
    pctx?.logger?.warn?.(`[sorne/a2] ${message}`);
  } catch {
    /* 无 logger 场景忽略 */
  }
}

/* ── 数据库句柄：按库文件路径记忆（同文件串行写队列；详见竣工记录协调说明） ── */

const openStores = new Map(); // 解析后的库文件路径 → 受控句柄
const openFlights = new Map();

/** 打开（或复用）数据根的共享受控句柄。 */
export async function getStore(pctx) {
  const file = layout.stateDbPath(pctx.dataDir);
  const cached = openStores.get(file);
  if (cached && cached.db.isOpen) return cached;
  let flight = openFlights.get(file);
  if (!flight) {
    flight = openDatabase({ file }).then((handle) => {
      openStores.set(file, handle);
      openFlights.delete(file);
      return handle;
    });
    openFlights.set(file, flight);
  }
  return flight;
}

/** 测试/演练收尾：关闭本模块持有的全部句柄（真实重开即进程重启的存储面）。 */
export function closeAllStores() {
  for (const handle of openStores.values()) {
    try {
      handle.close();
    } catch {
      /* 已关闭的句柄忽略 */
    }
  }
  openStores.clear();
}

/* ── 事务内编号与序号（§6.1：稳定编号由 id_sequences 事务内分配） ── */

function requireProject(db, projectId) {
  const row = db.prepare("SELECT id, next_commit_seq FROM projects WHERE id = ?").get(projectId);
  if (!row) throw apiError("INVALID_REFERENCE", `项目不存在：${projectId}`);
  return row;
}

function nextCommitSeq(db, projectId) {
  const row = requireProject(db, projectId);
  const seq = row.next_commit_seq;
  db.prepare("UPDATE projects SET next_commit_seq = ? WHERE id = ?").run(seq + 1, projectId);
  return seq;
}

function nextDisplaySeq(db, projectId, kind) {
  db.prepare(
    "INSERT INTO id_sequences (project_id, kind, next_val) VALUES (?, ?, 1) ON CONFLICT(project_id, kind) DO NOTHING",
  ).run(projectId, kind);
  const row = db.prepare("SELECT next_val FROM id_sequences WHERE project_id = ? AND kind = ?").get(projectId, kind);
  const n = row.next_val;
  db.prepare("UPDATE id_sequences SET next_val = ? WHERE project_id = ? AND kind = ?").run(n + 1, projectId, kind);
  return n;
}

function pad4(n) {
  return String(n).padStart(4, "0");
}

/** 全局唯一实体编号：嵌入项目编号 + 项目内序列（PK 全局唯一，显示层可读）。 */
export function blobIdFor(projectId, n) {
  return `B-${projectId}-${pad4(n)}`;
}
export function captureIdFor(projectId, n) {
  return `CAP-${projectId}-${pad4(n)}`;
}
export function captureNoOf(captureId) {
  const m = /-(\d+)$/.exec(String(captureId));
  return m ? Number(m[1]) : null;
}

function insertOutboxEvent(db, { projectId, commitSeq, eventIndex, eventType, subjectIds, changedFields, causeRefs, payload }) {
  const eventId = `evt-${projectId}-${commitSeq}-${eventIndex}`;
  db.prepare(
    `INSERT INTO outbox (event_id, project_id, commit_seq, event_index, event_type, subject_ids,
       changed_fields, cause_refs, producer_id, schema_version, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    eventId,
    projectId,
    commitSeq,
    eventIndex,
    eventType,
    JSON.stringify(subjectIds ?? []),
    JSON.stringify(changedFields ?? []),
    JSON.stringify(causeRefs ?? []),
    PRODUCER_ID,
    EVENT_SCHEMA_VERSION,
    JSON.stringify(payload ?? {}),
    new Date().toISOString(),
  );
  return eventId;
}

/* ── §13 步骤 1+2：staging 写入与哈希 ── */

async function fsyncDir(dir) {
  try {
    const fh = await open(dir, "r");
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
  } catch {
    /* 平台不支持目录 fsync 时 best-effort 忽略 */
  }
}

/**
 * 原始字节落 staging（fsync 后返回）；哈希在内存中计算。
 * 上限受调用方约束（端点层为 evidenceMaxBytes）；staging 写失败映射为可重试存储错误。
 */
export async function stageBytes(pctx, { projectId, bytes }) {
  if (!Buffer.isBuffer(bytes)) throw badRequest("证据字节缺失（body 必须为原始字节流）");
  const { staging } = layout.evidenceDirs(pctx.dataDir, projectId);
  const stagingPath = join(staging, `${process.pid}-${Date.now()}-${randomBytes(6).toString("hex")}.tmp`);
  try {
    await mkdir(staging, { recursive: true });
    const fh = await open(stagingPath, "wx");
    try {
      await fh.writeFile(bytes);
      await fh.sync();
    } finally {
      await fh.close();
    }
  } catch (error) {
    await rm(stagingPath, { force: true }).catch(() => {});
    if (error instanceof ApiError) throw error;
    throw storageError(`暂存写入失败（${error.code ?? error.message}）`, { project_id: projectId });
  }
  return { stagingPath, sha256: sha256Hex(bytes), byteSize: bytes.length };
}

/* ── §13 步骤 3：固定（不可变、内容寻址、去重不覆盖） ── */

export async function fixBlobFile(pctx, { projectId, sha256, stagingPath }) {
  if (!isSha256(sha256)) throw badRequest("sha256 必须是 64 位十六进制");
  const finalPath = layout.blobPath(pctx.dataDir, projectId, sha256);
  try {
    await access(finalPath, constants.F_OK);
    // 已存在：校验磁盘内容确与哈希一致；不一致视为存储损坏，绝不覆盖（不可变保护）。
    const existing = await readFile(finalPath);
    if (sha256Hex(existing) !== sha256) {
      throw apiError("INTERNAL_ERROR", "目标 Blob 路径已存在且内容与哈希不符（疑似存储损坏），拒绝覆盖不可变证据", {
        retryable: false,
        integrity: "mismatch",
        path: layout.relToDataDir(pctx.dataDir, finalPath),
        next_requirements: ["人工核查该路径的存储损坏后再重试上传"],
      });
    }
    await rm(stagingPath, { force: true });
    return { blobPath: finalPath, deduplicated: true };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error.code !== "ENOENT") {
      throw storageError(`固定前校验失败（${error.code ?? error.message}）`, { project_id: projectId });
    }
  }
  try {
    await mkdir(dirname(finalPath), { recursive: true });
    await rename(stagingPath, finalPath);
    await fsyncDir(dirname(finalPath));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw storageError(`固定 Blob 失败（${error.code ?? error.message}）`, { project_id: projectId });
  }
  return { blobPath: finalPath, deduplicated: false };
}

/* ── §13 步骤 4：库事务登记（Blob） ── */

export async function registerBlob(pctx, { projectId, sha256, byteSize, representation, sourceKind = "tool_gateway", actor = "unknown", blobPath }) {
  const store = await getStore(pctx);
  let receipt = null;
  let warnings = [];
  await store.runSerial((db) => {
    requireProject(db, projectId);
    const existing = db
      .prepare("SELECT * FROM blobs WHERE project_id = ? AND sha256 = ?")
      .get(projectId, sha256);
    if (existing) {
      warnings =
        existing.representation !== representation
          ? [`该内容已以表示形式 ${existing.representation} 登记；同一字节不混称多种表示（§5.3），保留首次登记`]
          : [];
      receipt = {
        blob_id: existing.id,
        sha256: existing.sha256,
        byte_size: existing.byte_size,
        representation: existing.representation,
        storage_status: existing.storage_status,
        referencable: existing.storage_status === "fixed",
        source_kind: existing.source_kind,
        created_at: existing.created_at,
        created_seq: existing.created_seq,
        deduplicated: true,
        warnings,
      };
      return;
    }
    const commitSeq = nextCommitSeq(db, projectId);
    const blobId = blobIdFor(projectId, nextDisplaySeq(db, projectId, "blob"));
    db.prepare(
      `INSERT INTO blobs (id, project_id, sha256, byte_size, representation, stored_path,
         storage_status, source_kind, created_at, created_by, created_seq)
       VALUES (?, ?, ?, ?, ?, ?, 'fixed', ?, ?, ?, ?)`,
    ).run(
      blobId,
      projectId,
      sha256,
      byteSize,
      representation,
      layout.relToDataDir(pctx.dataDir, blobPath),
      sourceKind,
      new Date().toISOString(),
      actor,
      commitSeq,
    );
    receipt = {
      blob_id: blobId,
      sha256,
      byte_size: byteSize,
      representation,
      storage_status: "fixed",
      referencable: true,
      source_kind: sourceKind,
      created_at: null,
      created_seq: commitSeq,
      deduplicated: false,
      warnings: [],
    };
  });
  if (receipt.created_at === null) {
    const row = await blobBySha(pctx, { projectId, sha256 });
    receipt.created_at = row?.created_at ?? null;
  }
  return receipt;
}

async function blobBySha(pctx, { projectId, sha256 }) {
  const store = await getStore(pctx);
  if (projectId) {
    return store.db.prepare("SELECT * FROM blobs WHERE project_id = ? AND sha256 = ?").get(projectId, sha256) ?? null;
  }
  const rows = store.db.prepare("SELECT * FROM blobs WHERE sha256 = ?").all(sha256);
  if (rows.length === 0) return null;
  if (rows.length > 1) {
    throw badRequest("该哈希在多个项目中存在，请以 project_id 指定存储权限域", {
      project_ids: rows.map((r) => r.project_id),
    });
  }
  return rows[0];
}

/* ── 完整编排：staging → 哈希 → 固定 → 登记 → 回执（§13 顺序） ── */

export async function storeBlob(pctx, { projectId, bytes, representation, sourceKind, actor, expectedSha256 }) {
  if (!projectId || typeof projectId !== "string") throw badRequest("缺少 project_id（query 参数）");
  if (!REPRESENTATIONS.includes(representation)) {
    throw badRequest(`representation 必须是以下之一：${REPRESENTATIONS.join(" / ")}（§5.3 表示形式必须注明）`);
  }
  if (sourceKind !== undefined && !SOURCE_KINDS.includes(sourceKind)) {
    throw badRequest(`source_kind 必须是以下之一：${SOURCE_KINDS.join(" / ")}`);
  }
  // 项目存在性前置检查（事务内仍复查；中途被删则文件成为可识别孤立 Blob，§13）。
  {
    const store = await getStore(pctx);
    requireProject(store.db, projectId);
  }
  const staged = await stageBytes(pctx, { projectId, bytes });
  if (expectedSha256 !== undefined) {
    const want = String(expectedSha256).toLowerCase();
    if (!isSha256(want)) throw badRequest("expected_sha256 必须是 64 位十六进制");
    if (want !== staged.sha256) {
      await rm(staged.stagingPath, { force: true }).catch(() => {});
      throw badRequest("上传内容与 expected_sha256 不符（传输损坏或来源不一致），已拒绝并丢弃暂存", {
        expected: want,
        actual: staged.sha256,
      });
    }
  }
  const fixed = await fixBlobFile(pctx, { projectId, sha256: staged.sha256, stagingPath: staged.stagingPath });
  const receipt = await registerBlob(pctx, {
    projectId,
    sha256: staged.sha256,
    byteSize: staged.byteSize,
    representation,
    sourceKind: sourceKind ?? "tool_gateway",
    actor,
    blobPath: fixed.blobPath,
  });
  return { ...receipt, deduplicated: receipt.deduplicated || fixed.deduplicated };
}

/* ── 原始证据读取（§8.3 验证读取；§18.3 完整依据层） ── */

function blobRowToPublic(row, dataDir) {
  return {
    blob_id: row.id,
    project_id: row.project_id,
    sha256: row.sha256,
    byte_size: row.byte_size,
    representation: row.representation,
    storage_status: row.storage_status,
    source_kind: row.source_kind,
    stored_path: row.stored_path,
    created_at: row.created_at,
    created_by: row.created_by,
    created_seq: row.created_seq,
    read_path: `/sorne/evidence/blobs/${row.sha256}?project_id=${encodeURIComponent(row.project_id)}`,
  };
}

/** 校验磁盘字节哈希；未通过一律拒绝提供（不静默提供损坏证据）。 */
export async function readBlobBytes(pctx, { sha256, projectId }) {
  const want = String(sha256 ?? "").toLowerCase();
  if (!isSha256(want)) throw badRequest("sha256 路径参数必须是 64 位十六进制");
  const row = await blobBySha(pctx, { projectId, sha256: want });
  if (!row) throw apiError("NOT_FOUND", `未找到该哈希对应的 Blob：${want}`);
  if (row.storage_status !== "fixed") {
    throw apiError("EVIDENCE_NOT_COMMITTED", `Blob 不处于可引用状态（storage_status=${row.storage_status}）`, {
      next_requirements: ["该 Blob 需重新上传并固定后才能作为证据读取"],
    });
  }
  const abs = join(pctx.dataDir, row.stored_path);
  let bytes;
  try {
    bytes = await readFile(abs);
  } catch (error) {
    throw storageError(`Blob 文件读取失败（${error.code ?? error.message}）`, { sha256: want });
  }
  if (sha256Hex(bytes) !== want) {
    throw apiError("INTERNAL_ERROR", "Blob 完整性校验失败：磁盘内容与登记哈希不符，拒绝提供", {
      retryable: false,
      integrity: "mismatch",
      next_requirements: ["核查证据存储完整性异常；该 Blob 的历史登记保留，不静默替换"],
    });
  }
  return { bytes, row: blobRowToPublic(row) };
}

/* ── 完整性检查与孤立 Blob 识别（§13/§20.2） ── */

export async function verifyBlobIntegrity(pctx, { projectId, sha256 }) {
  const row = await blobBySha(pctx, { projectId, sha256 });
  if (!row) return { status: "missing_row" };
  let bytes;
  try {
    bytes = await readFile(join(pctx.dataDir, row.stored_path));
  } catch {
    return { status: "missing", row };
  }
  return { status: sha256Hex(bytes) === row.sha256 ? "verified" : "mismatch", row };
}

async function walkFiles(dir, base, out) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) await walkFiles(full, base, out);
    else if (e.isFile()) out.push(layout.relToDataDir(base, full));
  }
}

/**
 * 存储异常盘点（§13：文件固定成功但数据库失败 → 孤立 Blob 可识别）：
 *   - blob_rows：每行 Blob 的磁盘状态与哈希核对；
 *   - orphan_files：磁盘上存在但数据库无登记的固定文件（真实孤立 Blob）；
 *   - missing_files / mismatched_files：登记在库但磁盘缺失/内容不符。
 */
export async function findStorageAnomalies(pctx, { projectId }) {
  const store = await getStore(pctx);
  const rows = store.db.prepare("SELECT * FROM blobs WHERE project_id = ?").all(projectId);
  const referenced = new Set(rows.map((r) => r.stored_path));
  const blobsRoot = layout.evidenceDirs(pctx.dataDir, projectId).blobsRoot;
  const diskFiles = [];
  await walkFiles(blobsRoot, pctx.dataDir, diskFiles);
  const missingFiles = [];
  const mismatchedFiles = [];
  for (const row of rows) {
    try {
      const bytes = await readFile(join(pctx.dataDir, row.stored_path));
      if (sha256Hex(bytes) !== row.sha256) mismatchedFiles.push(row.stored_path);
    } catch {
      missingFiles.push(row.stored_path);
    }
  }
  return {
    project_id: projectId,
    blob_rows: rows.map((r) => ({ blob_id: r.id, sha256: r.sha256, storage_status: r.storage_status })),
    orphan_files: diskFiles.filter((f) => !referenced.has(f)),
    missing_files: missingFiles,
    mismatched_files: mismatchedFiles,
  };
}

/* ── Capture 登记（§5.3） ── */

function publicCapture(row) {
  return {
    capture_id: row.id,
    project_id: row.project_id,
    capture_no: captureNoOf(row.id),
    resource_id: row.resource_id,
    tool_call_id: row.tool_call_id,
    attempt_id: row.attempt_id,
    observed_at: row.observed_at,
    recorded_at: row.recorded_at,
    request_ref: row.request_ref,
    response_headers_ref: row.response_headers_ref,
    response_body_blob: row.response_body_blob,
    request_url_exact: row.request_url_exact,
    method: row.method,
    condition_snapshot_id: row.condition_snapshot_id,
    source_kind: row.source_kind,
    integrity_status: row.integrity_status,
    created_at: row.created_at,
    created_by: row.created_by,
    created_seq: row.created_seq,
  };
}

/** 引用解析：接受 Blob 哈希或 Blob 编号；必须已固定（§13：不得引用未固定文件）。 */
async function requireFixedBlob(pctx, { projectId, ref, field }) {
  if (ref === undefined || ref === null || ref === "") return null;
  const store = await getStore(pctx);
  const text = String(ref);
  let row = store.db.prepare("SELECT * FROM blobs WHERE project_id = ? AND sha256 = ?").get(projectId, text.toLowerCase());
  if (!row) row = store.db.prepare("SELECT * FROM blobs WHERE project_id = ? AND id = ?").get(projectId, text);
  if (!row) throw apiError("INVALID_REFERENCE", `${field} 引用的 Blob 不存在：${text}`);
  if (row.storage_status !== "fixed") {
    throw apiError("EVIDENCE_NOT_COMMITTED", `${field} 引用的 Blob 未固定（storage_status=${row.storage_status}）`, {
      next_requirements: ["先完成 POST /sorne/evidence/blobs 上传并固定证据字节"],
    });
  }
  return row;
}

function markBlobLost(pctx) {
  return async ({ projectId, blobId, integrity }) => {
    const store = await getStore(pctx);
    await store.runSerial((db) => {
      db.prepare("UPDATE blobs SET storage_status = 'lost' WHERE project_id = ? AND id = ?").run(projectId, blobId);
    });
    logWarn(pctx, `Blob ${blobId} 标记为 lost（${integrity}）`);
  };
}

/**
 * POST /captures 主体（§5.3 Capture 合同 + §14.1 capture.completed 同事务事件）。
 * 幂等：同一 (project_id, tool_call_id) 重复提交返回原采集；同 ID 不同内容拒绝
 * （IDEMPOTENCY_KEY_REUSED）。同 URL 新版本内容时同事务追加 resource.content_changed。
 * 采集登记成功后尽力物化 assets/ 逻辑入口（视图失败不影响事实）。
 */
export async function registerCapture(pctx, body, { actor = "unknown" } = {}) {
  const projectId = body?.project_id;
  if (!projectId || typeof projectId !== "string") throw badRequest("缺少 project_id");
  const toolCallId = body?.tool_call_id;
  if (!toolCallId || typeof toolCallId !== "string") throw badRequest("缺少 tool_call_id（采集操作 ID，幂等去重键）");
  const urlExact = body?.request_url_exact;
  if (!urlExact || typeof urlExact !== "string") throw badRequest("缺少 request_url_exact（精确 URL，不做规范化）");
  const method = body?.method;
  if (!method || typeof method !== "string") throw badRequest("缺少 method");
  const sourceKind = body?.source_kind ?? "tool_gateway";
  if (!SOURCE_KINDS.includes(sourceKind)) {
    throw badRequest(`source_kind 必须是以下之一：${SOURCE_KINDS.join(" / ")}（§5.3 来源必须标记，不得伪装）`);
  }
  const observedAt = body?.observed_at;
  if (observedAt !== undefined && observedAt !== null) {
    if (typeof observedAt !== "string" || Number.isNaN(Date.parse(observedAt))) {
      throw badRequest("observed_at 必须是 ISO-8601 时间字符串");
    }
  }
  const conditionSnapshotId = body?.condition_snapshot_id;
  if (conditionSnapshotId !== undefined && conditionSnapshotId !== null && typeof conditionSnapshotId !== "string") {
    throw badRequest("condition_snapshot_id 必须是字符串（条件快照编号）");
  }

  const store = await getStore(pctx);
  requireProject(store.db, projectId);

  const bodyBlob = await requireFixedBlob(pctx, { projectId, ref: body?.response_body_blob, field: "response_body_blob" });
  if (!bodyBlob) throw badRequest("缺少 response_body_blob（响应体证据引用）");
  const requestBlob = await requireFixedBlob(pctx, { projectId, ref: body?.request_ref, field: "request_ref" });
  const headersBlob = await requireFixedBlob(pctx, { projectId, ref: body?.response_headers_ref, field: "response_headers_ref" });

  if (body?.resource_id !== undefined && body?.resource_id !== null) {
    const row = store.db.prepare("SELECT id FROM resources WHERE project_id = ? AND id = ?").get(projectId, body.resource_id);
    if (!row) throw apiError("INVALID_REFERENCE", `resource_id 不存在：${body.resource_id}`);
  }
  if (body?.attempt_id !== undefined && body?.attempt_id !== null) {
    const row = store.db.prepare("SELECT id FROM attempts WHERE project_id = ? AND id = ?").get(projectId, body.attempt_id);
    if (!row) throw apiError("INVALID_REFERENCE", `attempt_id 不存在：${body.attempt_id}`);
  }

  // 采集前核实证据字节在磁盘上完好：缺失/损坏则标记 lost 并拒绝（不造假记录）。
  const integrity = await verifyBlobIntegrity(pctx, { projectId, sha256: bodyBlob.sha256 });
  if (integrity.status !== "verified") {
    await markBlobLost(pctx)({ projectId, blobId: bodyBlob.id, integrity: integrity.status });
    throw apiError("EVIDENCE_NOT_COMMITTED", `response_body_blob 证据文件${integrity.status === "missing" ? "缺失" : "内容与哈希不符"}，已标记 lost 并拒绝建立采集`, {
      integrity: integrity.status,
      next_requirements: ["重新上传并固定证据字节后，使用新的 tool_call_id 再次登记采集"],
    });
  }

  let receipt = null;
  await store.runSerial((db) => {
    const existing = db
      .prepare("SELECT * FROM captures WHERE project_id = ? AND tool_call_id = ?")
      .get(projectId, toolCallId);
    if (existing) {
      const sameEvidence =
        existing.response_body_blob === bodyBlob.id &&
        existing.request_url_exact === urlExact &&
        existing.method === method;
      if (!sameEvidence) {
        throw apiError("IDEMPOTENCY_KEY_REUSED", "同一 tool_call_id 已登记不同内容的采集；新的独立采集必须使用新的 tool_call_id", {
          existing_capture_id: existing.id,
          next_requirements: ["为本次采集分配新的 tool_call_id 后重试"],
        });
      }
      const commitSeq = existing.created_seq;
      receipt = {
        capture: publicCapture(existing),
        capture_id: existing.id,
        capture_no: captureNoOf(existing.id),
        commit_seq: commitSeq,
        event_id: `evt-${projectId}-${commitSeq}-0`,
        deduplicated: true,
        asset_entry: null,
      };
      return;
    }
    const commitSeq = nextCommitSeq(db, projectId);
    const captureNo = nextDisplaySeq(db, projectId, "capture");
    const captureId = captureIdFor(projectId, captureNo);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO captures (id, project_id, resource_id, tool_call_id, attempt_id, observed_at, recorded_at,
         request_ref, response_headers_ref, response_body_blob, request_url_exact, method,
         condition_snapshot_id, source_kind, integrity_status, created_at, created_by, created_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'verified', ?, ?, ?)`,
    ).run(
      captureId,
      projectId,
      body?.resource_id ?? null,
      toolCallId,
      body?.attempt_id ?? null,
      observedAt ?? null,
      now,
      requestBlob ? requestBlob.id : null,
      headersBlob ? headersBlob.id : null,
      bodyBlob.id,
      urlExact,
      method,
      conditionSnapshotId ?? null,
      sourceKind,
      now,
      actor,
      commitSeq,
    );
    const eventId = insertOutboxEvent(db, {
      projectId,
      commitSeq,
      eventIndex: 0,
      eventType: "capture.completed",
      subjectIds: [captureId],
      changedFields: [],
      causeRefs: [bodyBlob.id],
      payload: {
        capture_id: captureId,
        capture_no: captureNo,
        tool_call_id: toolCallId,
        method,
        request_url_exact: urlExact,
        response_blob_sha256: bodyBlob.sha256,
        representation: bodyBlob.representation,
        byte_size: bodyBlob.byte_size,
        source_kind: sourceKind,
        integrity_status: "verified",
      },
    });
    // §14.1 相关内容变化：同 URL（同 method）出现新版本内容 → 同事务追加事件。
    const previous = db
      .prepare(
        `SELECT c.id AS capture_id, b.sha256 AS sha256 FROM captures c
         JOIN blobs b ON b.id = c.response_body_blob
         WHERE c.project_id = ? AND c.request_url_exact = ? AND c.method = ? AND c.id != ?
         ORDER BY c.created_seq DESC LIMIT 1`,
      )
      .get(projectId, urlExact, method, captureId);
    if (previous && previous.sha256 !== bodyBlob.sha256) {
      insertOutboxEvent(db, {
        projectId,
        commitSeq,
        eventIndex: 1,
        eventType: "resource.content_changed",
        subjectIds: [captureId],
        changedFields: ["content"],
        causeRefs: [previous.capture_id],
        payload: {
          request_url_exact: urlExact,
          method,
          previous_capture_id: previous.capture_id,
          previous_sha256: previous.sha256,
          new_capture_id: captureId,
          new_sha256: bodyBlob.sha256,
        },
      });
    }
    receipt = {
      capture: null,
      capture_id: captureId,
      capture_no: captureNo,
      commit_seq: commitSeq,
      event_id: eventId,
      deduplicated: false,
      asset_entry: null,
    };
  });

  if (receipt.deduplicated) return receipt;
  const captureRow = store.db.prepare("SELECT * FROM captures WHERE id = ?").get(receipt.capture_id);
  receipt.capture = publicCapture(captureRow);

  // 尽力物化 assets/ 逻辑入口（§5.2 程序义务；视图失败不影响已提交事实）。
  try {
    receipt.asset_entry = await layout.materializeAssetEntry(pctx.dataDir, projectId, {
      capture_id: receipt.capture_id,
      capture_no: receipt.capture_no,
      url_exact: urlExact,
      method,
      resource_id: body?.resource_id ?? null,
      sha256: bodyBlob.sha256,
      representation: bodyBlob.representation,
      captured_at: captureRow.observed_at ?? captureRow.recorded_at,
      source_blob_path: join(pctx.dataDir, bodyBlob.stored_path),
    });
  } catch (error) {
    logWarn(pctx, `assets 逻辑入口物化失败（不影响采集事实）：${error?.message ?? error}`);
    receipt.asset_entry = { materialized: false, reason: error?.code ?? String(error?.message ?? error) };
  }
  return receipt;
}

/* ── 采集详情（§18.3 完整依据层读取落点，端点 #44） ── */

export async function getCaptureDetail(pctx, captureId) {
  const store = await getStore(pctx);
  const row = store.db.prepare("SELECT * FROM captures WHERE id = ?").get(String(captureId ?? ""));
  if (!row) throw apiError("NOT_FOUND", `采集记录不存在：${captureId}`);
  const blobOf = (blobId) => {
    if (!blobId) return null;
    const b = store.db.prepare("SELECT * FROM blobs WHERE id = ?").get(blobId);
    return b ? blobRowToPublic(b) : null;
  };
  const transforms = store.db
    .prepare(
      `SELECT * FROM transforms WHERE project_id = ?
       AND ((source_kind = 'capture' AND source_id = ?) OR (source_kind = 'blob' AND source_id = ?))
       ORDER BY created_seq`,
    )
    .all(row.project_id, row.id, row.response_body_blob ?? "")
    .map((t) => {
      const derived = blobOf(t.derived_blob_id);
      return {
        transform_id: t.id,
        source_kind: t.source_kind,
        source_id: t.source_id,
        transform_name: t.transform_name,
        transform_version: t.transform_version,
        parameters: JSON.parse(t.parameters || "{}"),
        derived_blob: derived,
        created_at: t.created_at,
      };
    });
  return {
    capture: publicCapture(row),
    response_body_blob: blobOf(row.response_body_blob),
    request_ref_blob: blobOf(row.request_ref),
    response_headers_ref_blob: blobOf(row.response_headers_ref),
    transforms,
    read_pointers: {
      response_body_bytes: row.response_body_blob
        ? `/sorne/evidence/blobs/${blobOf(row.response_body_blob)?.sha256}?project_id=${encodeURIComponent(row.project_id)}`
        : null,
      record: `/sorne/captures/${row.id}`,
    },
  };
}

/* ── transforms 派生链（§5.3：source + transform + version + parameters + derived） ── */

export async function registerTransform(pctx, opts, { actor = "unknown" } = {}) {
  const projectId = opts?.project_id;
  if (!projectId || typeof projectId !== "string") throw badRequest("缺少 project_id");
  const sourceKind = opts?.source_kind;
  if (!["blob", "capture"].includes(sourceKind)) throw badRequest("source_kind 必须是 blob 或 capture");
  const sourceId = opts?.source_id;
  if (!sourceId || typeof sourceId !== "string") throw badRequest("缺少 source_id");
  const transformName = opts?.transform_name;
  if (!transformName || typeof transformName !== "string") throw badRequest("缺少 transform_name");
  const transformVersion = opts?.transform_version;
  if (!transformVersion || typeof transformVersion !== "string") throw badRequest("缺少 transform_version（派生链必须版本化）");
  const parameters = opts?.parameters ?? {};
  if (typeof parameters !== "object" || parameters === null || Array.isArray(parameters)) {
    throw badRequest("parameters 必须是 JSON 对象");
  }
  const store = await getStore(pctx);
  requireProject(store.db, projectId);

  // 来源存在性校验（INVALID_REFERENCE）。
  if (sourceKind === "blob") {
    const row = store.db.prepare("SELECT id FROM blobs WHERE project_id = ? AND id = ?").get(projectId, sourceId);
    if (!row) throw apiError("INVALID_REFERENCE", `source_id 引用的 Blob 不存在：${sourceId}`);
  } else {
    const row = store.db.prepare("SELECT id FROM captures WHERE project_id = ? AND id = ?").get(projectId, sourceId);
    if (!row) throw apiError("INVALID_REFERENCE", `source_id 引用的采集不存在：${sourceId}`);
  }

  // 派生 Blob：字节经同一 §13 流水线固定，或引用已固定的 derived Blob。
  let derivedBlob = null;
  let stored = null;
  if (opts?.derived_bytes !== undefined) {
    if (!Buffer.isBuffer(opts.derived_bytes)) throw badRequest("derived_bytes 必须是原始字节");
    stored = await storeBlob(pctx, {
      projectId,
      bytes: opts.derived_bytes,
      representation: "derived",
      actor,
    });
    const row = store.db.prepare("SELECT * FROM blobs WHERE project_id = ? AND sha256 = ?").get(projectId, stored.sha256);
    derivedBlob = row;
  } else if (opts?.derived_sha256 !== undefined) {
    const ref = String(opts.derived_sha256).toLowerCase();
    if (!isSha256(ref)) throw badRequest("derived_sha256 必须是 64 位十六进制");
    const row = store.db.prepare("SELECT * FROM blobs WHERE project_id = ? AND sha256 = ?").get(projectId, ref);
    if (!row) throw apiError("INVALID_REFERENCE", `derived_sha256 引用的 Blob 不存在：${ref}`);
    if (row.representation !== "derived") {
      throw badRequest("派生链的 derived_blob 必须是 representation=derived 的 Blob（§5.3 原始与派生不混称）");
    }
    derivedBlob = row;
  } else {
    throw badRequest("缺少派生产物：提供 derived_bytes 或 derived_sha256");
  }

  const parametersJson = JSON.stringify(parameters);
  let receipt = null;
  await store.runSerial((db) => {
    const existing = db
      .prepare(
        `SELECT * FROM transforms WHERE project_id = ? AND source_kind = ? AND source_id = ?
           AND transform_name = ? AND transform_version = ? AND parameters = ?`,
      )
      .get(projectId, sourceKind, sourceId, transformName, transformVersion, parametersJson);
    if (existing) {
      receipt = {
        transform_id: existing.id,
        derived_blob: blobRowToPublic(existing.derived_blob_id ? db.prepare("SELECT * FROM blobs WHERE id = ?").get(existing.derived_blob_id) : null),
        deduplicated: true,
      };
      return;
    }
    const commitSeq = nextCommitSeq(db, projectId);
    const transformId = `T-${projectId}-${pad4(nextDisplaySeq(db, projectId, "transform"))}`;
    db.prepare(
      `INSERT INTO transforms (id, project_id, source_kind, source_id, transform_name, transform_version,
         parameters, derived_blob_id, created_at, created_by, created_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      transformId,
      projectId,
      sourceKind,
      sourceId,
      transformName,
      transformVersion,
      parametersJson,
      derivedBlob.id,
      new Date().toISOString(),
      actor,
      commitSeq,
    );
    receipt = { transform_id: transformId, derived_blob: blobRowToPublic(derivedBlob), deduplicated: false };
  });
  return receipt;
}

/* ── EvidenceAnchor（§5.4 证据定位：绑定版本与解码） ── */

const LOCATOR_TYPES = Object.freeze(["line_range", "byte_range", "json_pointer", "whole"]);
const TEXT_ENCODINGS = Object.freeze(["utf-8", "utf-16le", "latin1"]);

export function validateEvidenceAnchorShape(anchor) {
  if (!anchor || typeof anchor !== "object" || Array.isArray(anchor)) {
    throw badRequest("EvidenceAnchor 必须是 JSON 对象（§5.4）");
  }
  if (typeof anchor.capture_id !== "string" || !anchor.capture_id) {
    throw badRequest("EvidenceAnchor 缺少 capture_id");
  }
  if (!isSha256(String(anchor.blob_hash ?? ""))) {
    throw badRequest("EvidenceAnchor.blob_hash 必须是 64 位十六进制（行号/定位必须绑定确切版本）");
  }
  if (typeof anchor.representation !== "string" || !REPRESENTATIONS.includes(anchor.representation)) {
    throw badRequest(`EvidenceAnchor.representation 必须是以下之一：${REPRESENTATIONS.join(" / ")}`);
  }
  if (!LOCATOR_TYPES.includes(anchor.locator_type)) {
    throw badRequest(`EvidenceAnchor.locator_type 必须是以下之一：${LOCATOR_TYPES.join(" / ")}`);
  }
  if (anchor.transform_id !== undefined && anchor.transform_id !== null && typeof anchor.transform_id !== "string") {
    throw badRequest("EvidenceAnchor.transform_id 必须是字符串");
  }
  if (anchor.locator_type === "line_range") {
    const loc = anchor.locator ?? {};
    if (anchor.text_encoding !== undefined && anchor.text_encoding !== null) {
      if (typeof anchor.text_encoding !== "string" || !TEXT_ENCODINGS.includes(anchor.text_encoding)) {
        throw badRequest(`line_range 锚点的 text_encoding 必须是以下之一：${TEXT_ENCODINGS.join(" / ")}（行号绑定文本解码方式）`);
      }
    }
    if (
      !Number.isInteger(loc.start_line) || !Number.isInteger(loc.end_line) ||
      loc.start_line < 1 || loc.end_line < loc.start_line
    ) {
      throw badRequest("line_range 定位符需要 1 起始的 start_line/end_line（end ≥ start）");
    }
  } else if (anchor.locator_type === "byte_range") {
    const loc = anchor.locator ?? {};
    if (
      !Number.isInteger(loc.start_byte) || !Number.isInteger(loc.end_byte) ||
      loc.start_byte < 0 || loc.end_byte <= loc.start_byte
    ) {
      throw badRequest("byte_range 定位符需要 0 起始的 start_byte/end_byte（左闭右开）");
    }
  } else if (anchor.locator_type === "json_pointer") {
    if (typeof anchor.locator !== "string" || !anchor.locator.startsWith("/")) {
      throw badRequest("json_pointer 定位符必须是以 / 起始的 RFC 6901 指针字符串");
    }
  }
  return true;
}

/**
 * 解析 EvidenceAnchor 到具体字节/文本（§5.4/§8.3）：
 *   - 校验 capture 存在、blob_hash 与 transform 派生链或采集响应体绑定一致；
 *   - representation 必须与被绑定 Blob 的表示形式一致（格式化 JS 的行号绑定
 *     格式化结果，即 transform_id 指向的 derived Blob，不声称是原始 JS 的行号）；
 *   - line_range 以 text_encoding 解码后切片；byte_range 左闭右开；
 *   - json_pointer 在解码文本的 JSON 上求值。
 */
export async function resolveEvidenceAnchor(pctx, { projectId, anchor }) {
  validateEvidenceAnchorShape(anchor);
  const store = await getStore(pctx);
  const capture = store.db
    .prepare("SELECT * FROM captures WHERE project_id = ? AND id = ?")
    .get(projectId, anchor.capture_id);
  if (!capture) throw apiError("INVALID_REFERENCE", `锚点引用的采集不存在：${anchor.capture_id}`);

  let blobRow = null;
  let viaTransform = null;
  if (anchor.transform_id) {
    const t = store.db
      .prepare("SELECT * FROM transforms WHERE project_id = ? AND id = ?")
      .get(projectId, anchor.transform_id);
    if (!t) throw apiError("INVALID_REFERENCE", `锚点引用的派生记录不存在：${anchor.transform_id}`);
    const derived = store.db.prepare("SELECT * FROM blobs WHERE id = ?").get(t.derived_blob_id);
    const bindsCapture = t.source_kind === "capture" && t.source_id === capture.id;
    const bindsBodyBlob = t.source_kind === "blob" && t.source_id === capture.response_body_blob;
    if (!bindsCapture && !bindsBodyBlob) {
      throw apiError("INVALID_REFERENCE", "锚点的 transform_id 与 capture_id 不构成派生链（同一采集或其响应体 Blob 的派生）");
    }
    blobRow = derived;
    viaTransform = { transform_id: t.id, transform_name: t.transform_name, transform_version: t.transform_version };
  } else {
    blobRow = store.db.prepare("SELECT * FROM blobs WHERE id = ?").get(capture.response_body_blob);
  }
  if (!blobRow) throw apiError("INVALID_REFERENCE", "采集缺少可解析的证据 Blob");
  if (blobRow.sha256 !== anchor.blob_hash) {
    throw apiError("INVALID_REFERENCE", "锚点 blob_hash 与采集绑定 Blob 不符：行号/定位必须绑定确切版本（§5.4）", {
      bound_sha256: blobRow.sha256,
      anchor_blob_hash: anchor.blob_hash,
    });
  }
  if (blobRow.representation !== anchor.representation) {
    throw apiError("INVALID_REFERENCE", `锚点 representation（${anchor.representation}）与 Blob 实际表示形式（${blobRow.representation}）不符`, {
      next_requirements: ["格式化/解码产物的行号必须锚定其派生 Blob（transform_id），不得冒称原始字节"],
    });
  }

  const { bytes } = await readBlobBytes(pctx, { sha256: blobRow.sha256, projectId });
  const result = {
    capture_id: capture.id,
    blob_id: blobRow.id,
    blob_hash: blobRow.sha256,
    representation: blobRow.representation,
    text_encoding: anchor.locator_type === "line_range" ? anchor.text_encoding ?? "utf-8" : null,
    locator_type: anchor.locator_type,
    byte_size: bytes.length,
    via_transform: viaTransform,
  };
  if (anchor.locator_type === "whole") {
    return { ...result, bytes };
  }
  if (anchor.locator_type === "byte_range") {
    const { start_byte: start, end_byte: end } = anchor.locator;
    if (end > bytes.length) {
      throw badRequest(`byte_range 超出证据长度（${end} > ${bytes.length}）`);
    }
    return { ...result, bytes: bytes.subarray(start, end) };
  }
  const encoding = anchor.text_encoding ?? "utf-8";
  const text = bytes.toString(encoding);
  if (anchor.locator_type === "line_range") {
    const lines = text.split(/\r\n|\n|\r/);
    const { start_line: start, end_line: end } = anchor.locator;
    if (end > lines.length) throw badRequest(`line_range 超出证据行数（${end} > ${lines.length}）`);
    return { ...result, text: lines.slice(start - 1, end).join("\n"), line_count: end - start + 1 };
  }
  // json_pointer
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    throw badRequest(`证据字节不是合法 JSON，无法求值 json_pointer（${error.message}）`);
  }
  if (anchor.locator === "/") return { ...result, value: doc };
  let node = doc;
  for (const rawToken of anchor.locator.split("/").slice(1)) {
    const token = rawToken.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(node)) {
      const idx = Number(token);
      if (!Number.isInteger(idx) || idx < 0 || idx >= node.length) {
        throw badRequest(`json_pointer 路径不存在：${rawToken}`);
      }
      node = node[idx];
    } else if (node && typeof node === "object") {
      if (!Object.prototype.hasOwnProperty.call(node, token)) {
        throw badRequest(`json_pointer 路径不存在：${token}`);
      }
      node = node[token];
    } else {
      throw badRequest(`json_pointer 无法在标量上继续求值：${token}`);
    }
  }
  return { ...result, value: node };
}

/* 供测试与维护工具直接盘点句柄状态。 */
export function __handles() {
  return { open: [...openStores.keys()], in_flight: openFlights.size };
}

async function statOk(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
export { statOk as pathExists };
