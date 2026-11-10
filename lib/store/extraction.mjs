/**
 * 工具产物批量持久化服务（01 号基线 §八、§九、§十五；实施计划阶段 3）。
 *
 * 核心流程：
 *   1. Worker 调用 JS 提取工具 → 工具接入层收到提取结果数组。
 *   2. saveBatch()：原始输入（Blob+Capture）已固定后，在单一 runSerial 事务内
 *      保存批次信封、全部条目、候选来源关系和变更事件。
 *   3. 同一幂等键回原回执（§十五）；同键不同内容报冲突。
 *   4. 返回短回执（批次入口 + 分类计数 + 状态），不送全量条目进模型上下文（§八）。
 *   5. 中断后已提交批次保留，整次工作标明 partial/failed（§八）。
 *
 * 条目可经阅读服务按类别搜索/分页（search extraction_items）。
 */
import { createHash } from "node:crypto";

import { apiError } from "../errors.mjs";
import { getStore, GLOBAL_SEQ_SCOPE, registerSubmissionOps } from "./record-service.mjs";

function sha256Hex(text) {
  return createHash("sha256").update(text).digest("hex");
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableJson(value[k])).join(",") + "}";
}

function pad4(n) { return String(n).padStart(4, "0"); }

function allocateSeq(db, projectId, kind) {
  db.prepare(
    "INSERT INTO id_sequences (project_id, kind, next_val) VALUES (?, ?, 2) ON CONFLICT DO NOTHING",
  ).run(projectId, kind);
  const row = db.prepare(
    "SELECT next_val AS n FROM id_sequences WHERE project_id = ? AND kind = ?",
  ).get(projectId, kind);
  db.prepare(
    "UPDATE id_sequences SET next_val = ? WHERE project_id = ? AND kind = ?",
  ).run(row.n + 1, projectId, kind);
  return row.n;
}

function allocateCommitSeq(db, projectId) {
  const row = db.prepare("SELECT next_commit_seq AS n FROM projects WHERE id = ?").get(projectId);
  if (!row) throw apiError("INVALID_REFERENCE", `项目不存在：${projectId}`);
  db.prepare("UPDATE projects SET next_commit_seq = ? WHERE id = ?").run(row.n + 1, projectId);
  return row.n;
}

function insertOutboxEvent(db, { projectId, commitSeq, eventIndex, eventType, subjectIds, payload, actor }) {
  const eventId = `evt-${projectId}-${commitSeq}-${eventIndex}`;
  db.prepare(
    `INSERT INTO outbox (event_id, project_id, commit_seq, event_index, event_type, subject_ids,
       changed_fields, cause_refs, producer_id, schema_version, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?, '[]', '[]', 'sorne.extraction', 1, ?, ?)`,
  ).run(eventId, projectId, commitSeq, eventIndex, eventType, JSON.stringify(subjectIds ?? []), JSON.stringify(payload ?? {}), new Date().toISOString());
  return eventId;
}

/**
 * 保存一个提取批次（单一事务；§十五 事务性事件落盘）。
 *
 * @param {object} pctx - 进程上下文
 * @param {object} opts
 * @param {string} opts.projectId
 * @param {string} opts.idempotencyKey - 幂等键
 * @param {string} opts.captureId - 关联采集（可选）
 * @param {string} opts.blobId - 关联 Blob（可选）
 * @param {string} opts.inputSha256 - 输入内容哈希
 * @param {string} opts.extractorName
 * @param {string} opts.extractorVersion
 * @param {string} [opts.intentId]
 * @param {string} [opts.attemptId]
 * @param {string} [opts.runId]
 * @param {string} opts.actor
 * @param {Array<{category, value, source_locator?, confidence?, metadata?}>} opts.items
 * @returns {object} 短回执
 */
export async function saveBatch(pctx, opts) {
  const {
    projectId, idempotencyKey, captureId, blobId, inputSha256,
    extractorName, extractorVersion, intentId, attemptId, runId,
    actor, items,
  } = opts;

  if (!projectId) throw apiError("BAD_REQUEST", "缺少 project_id");
  if (!idempotencyKey) throw apiError("BAD_REQUEST", "缺少 idempotency_key");
  if (!inputSha256) throw apiError("BAD_REQUEST", "缺少 input_sha256");
  if (!extractorName) throw apiError("BAD_REQUEST", "缺少 extractor_name");
  if (!extractorVersion) throw apiError("BAD_REQUEST", "缺少 extractor_version");
  if (!Array.isArray(items) || items.length === 0) {
    throw apiError("BAD_REQUEST", "items 必须为非空数组");
  }

  const store = await getStore(pctx);
  const requestDigest = sha256Hex(stableJson({
    idempotency_key: idempotencyKey,
    input_sha256: inputSha256,
    extractor_name: extractorName,
    extractor_version: extractorVersion,
    items: items.map((it, i) => ({
      index: i,
      category: it.category || "",
      value: it.value || "",
    })),
  }));

  return store.runSerial((db) => {
    // 幂等检查
    const existing = db.prepare(
      "SELECT * FROM extraction_batches WHERE project_id = ? AND idempotency_key = ?",
    ).get(projectId, idempotencyKey);

    if (existing) {
      // 同键同内容 → 原回执
      const existingDigest = sha256Hex(stableJson({
        idempotency_key: existing.idempotency_key,
        input_sha256: existing.input_sha256,
        extractor_name: existing.extractor_name,
        extractor_version: existing.extractor_version,
        items: db.prepare(
          "SELECT item_index, category, value FROM extraction_items WHERE batch_id = ? ORDER BY item_index",
        ).all(existing.id).map((r) => ({
          index: r.item_index,
          category: r.category,
          value: r.value,
        })),
      }));

      if (existingDigest === requestDigest) {
        const categoryCounts = JSON.parse(existing.category_counts_json || "{}");
        return {
          batch_id: existing.id,
          idempotent: true,
          status: existing.status,
          item_count: existing.item_count,
          category_counts: categoryCounts,
          created_seq: existing.created_seq,
          read_path: `/sorne/reading/search?project_id=${encodeURIComponent(projectId)}&q=${encodeURIComponent(extractorName)}`,
          note: "同一幂等键的重复提交：返回原回执（§十五）",
        };
      }
      throw apiError("IDEMPOTENCY_KEY_REUSED",
        `幂等键 ${idempotencyKey} 已用于不同内容，拒绝覆盖（§十五）`, {
          existing_batch_id: existing.id,
        });
    }

    const commitSeq = allocateCommitSeq(db, projectId);
    const now = new Date().toISOString();
    const batchN = allocateSeq(db, projectId, "extraction_batch");
    const batchId = `EB-${projectId}-${pad4(batchN)}`;

    // 统计分类计数
    const categoryCounts = {};
    for (const it of items) {
      const cat = it.category || "uncategorized";
      categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
    }

    // 插入批次信封
    db.prepare(
      `INSERT INTO extraction_batches
         (id, project_id, idempotency_key, capture_id, blob_id, input_sha256,
          extractor_name, extractor_version, intent_id, attempt_id, run_id,
          status, item_count, category_counts_json,
          created_at, created_by, created_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'committed', ?, ?, ?, ?, ?)`,
    ).run(
      batchId, projectId, idempotencyKey,
      captureId || null, blobId || null, inputSha256,
      extractorName, extractorVersion,
      intentId || null, attemptId || null, runId || "",
      items.length, JSON.stringify(categoryCounts),
      now, actor || "extraction", commitSeq,
    );

    // 插入全部条目（同一事务）
    const insertItem = db.prepare(
      `INSERT INTO extraction_items
         (id, project_id, batch_id, item_index, category, value,
          source_locator_json, confidence, metadata_json,
          created_at, created_by, created_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const itemIds = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const itemN = allocateSeq(db, projectId, "extraction_item");
      const itemId = `EI-${projectId}-${pad4(itemN)}`;
      insertItem.run(
        itemId, projectId, batchId, i,
        it.category || "", it.value || "",
        JSON.stringify(it.source_locator || {}),
        it.confidence || "candidate",
        JSON.stringify(it.metadata || {}),
        now, actor || "extraction", commitSeq,
      );
      itemIds.push(itemId);
    }

    // Outbox 事件
    insertOutboxEvent(db, {
      projectId, commitSeq, eventIndex: 0,
      eventType: "extraction.batch_committed",
      subjectIds: [batchId],
      payload: {
        batch_id: batchId,
        extractor_name: extractorName,
        item_count: items.length,
        category_counts: categoryCounts,
        input_sha256: inputSha256,
      },
      actor,
    });

    return {
      batch_id: batchId,
      idempotent: false,
      status: "committed",
      item_count: items.length,
      category_counts: categoryCounts,
      created_seq: commitSeq,
      read_path: `/sorne/reading/search?project_id=${encodeURIComponent(projectId)}&q=${encodeURIComponent(extractorName)}`,
      note: `本批次已保存：${Object.entries(categoryCounts).map(([k, v]) => `${k} ${v} 项`).join("、")}。可按类别展开、搜索或查看原文。`,
    };
  });
}

/**
 * 标记批次为 partial（中断恢复用；§八「中途失败时，已提交部分保留」）。
 */
export async function markBatchPartial(pctx, { projectId, batchId, errorNote }) {
  const store = await getStore(pctx);
  return store.runSerial((db) => {
    const batch = db.prepare(
      "SELECT * FROM extraction_batches WHERE project_id = ? AND id = ?",
    ).get(projectId, batchId);
    if (!batch) throw apiError("NOT_FOUND", `批次不存在：${batchId}`);
    if (batch.status !== "committed") {
      return { batch_id: batchId, status: batch.status, note: "批次已非 committed 状态" };
    }
    db.prepare(
      "UPDATE extraction_batches SET status = 'partial', error_note = ? WHERE id = ?",
    ).run(errorNote || "", batchId);
    return { batch_id: batchId, status: "partial", error_note: errorNote || "" };
  });
}

/**
 * 读取批次详情（回执 + 条目分页）。
 */
export async function getBatch(pctx, { projectId, batchId, offset, limit }) {
  const store = await getStore(pctx);
  const db = store.db;
  const batch = db.prepare(
    "SELECT * FROM extraction_batches WHERE project_id = ? AND id = ?",
  ).get(projectId, batchId);
  if (!batch) throw apiError("NOT_FOUND", `批次不存在：${batchId}`);

  const lim = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const off = Math.max(Number(offset) || 0, 0);
  const items = db.prepare(
    "SELECT * FROM extraction_items WHERE batch_id = ? ORDER BY item_index LIMIT ? OFFSET ?",
  ).all(batchId, lim, off);

  return {
    batch_id: batch.id,
    status: batch.status,
    extractor_name: batch.extractor_name,
    extractor_version: batch.extractor_version,
    input_sha256: batch.input_sha256,
    capture_id: batch.capture_id,
    blob_id: batch.blob_id,
    intent_id: batch.intent_id,
    attempt_id: batch.attempt_id,
    item_count: batch.item_count,
    category_counts: JSON.parse(batch.category_counts_json || "{}"),
    items: items.map((it) => ({
      id: it.id,
      item_index: it.item_index,
      category: it.category,
      value: it.value,
      source_locator: JSON.parse(it.source_locator_json || "{}"),
      confidence: it.confidence,
      metadata: JSON.parse(it.metadata_json || "{}"),
    })),
    has_more: off + items.length < batch.item_count,
    offset: off,
    limit: lim,
  };
}

/**
 * 按类别列出项目内的提取条目（§八「可按类别展开、搜索或查看原文」）。
 */
export async function listItemsByCategory(pctx, { projectId, category, cursor, limit }) {
  const store = await getStore(pctx);
  const db = store.db;
  const lim = Math.min(Math.max(Number(limit) || 20, 1), 100);
  let where = "project_id = ?";
  const params = [projectId];
  if (category) {
    where += " AND category = ?";
    params.push(category);
  }
  if (cursor) {
    const sep = cursor.indexOf(":");
    if (sep > 0) {
      const seq = Number(cursor.slice(0, sep));
      const id = cursor.slice(sep + 1);
      where += " AND (created_seq > ? OR (created_seq = ? AND id > ?))";
      params.push(seq, seq, id);
    }
  }
  const rows = db.prepare(
    `SELECT * FROM extraction_items WHERE ${where} ORDER BY created_seq, id LIMIT ?`,
  ).all(...params, lim + 1);

  const hasMore = rows.length > lim;
  const items = rows.slice(0, lim);
  return {
    items: items.map((it) => ({
      id: it.id,
      batch_id: it.batch_id,
      item_index: it.item_index,
      category: it.category,
      value: it.value,
      source_locator: JSON.parse(it.source_locator_json || "{}"),
      confidence: it.confidence,
    })),
    total: items.length,
    has_more: hasMore,
    next_cursor: items.length > 0 ? `${items[items.length - 1].created_seq}:${items[items.length - 1].id}` : null,
  };
}
