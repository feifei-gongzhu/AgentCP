/**
 * M2 —— 用户消息通道（蓝图 §2.6-2；要求 §4：消息闭环）。
 *
 * 合同落实：
 *   - 用户 → Orchestrator 的持久消息（含针对某资产/方向/漏洞的引用与资料附件）：
 *     持久化即 received；「handled」只在关联协调决定持久化后成立（§18.5.6 同法；
 *     规范 §14.3 delivered ≠ applied / handled）——展示对应任务与 AI 处理结果经
 *     message_links + AI 回复消息（direction=ai, reply_to=原消息）证明。
 *   - 引用与附件逐项校验存在于本项目：blob 按 B- 编号或 sha256、capture 按编号、
 *     其他记录按 /records 定位（locateRecord）；不存在 → INVALID_REFERENCE，
 *     拒绝整条消息（不半提交，§11.3）。
 *   - 附件只回显已校验的编号与读取入口（read_path），不复制证据字节进消息；
 *     AI 上下文经既有 read_record / read_blob 读取（§2.6-2 冻结通道）。
 *   - AI 回复与关联写入必须在决定持久化的同一事务内（由 lib/store/orchestrator.mjs
 *     的 recordDecision 增量调用本模块的事务内写点，本文件不另开通道）。
 *   - 事件（message.received / message.handled）随业务同事务入 Outbox（§2 约束 10）。
 *
 * 本模块不校验角色权限面以外的任何 AI 语义；Orchestrator 如何处理消息属协调 AI
 * 判断（§3.1），程序只保证持久化、关联与可靠事件。
 */
import { apiError } from "../errors.mjs";
import { getStore } from "./record-service.mjs";
import { locateRecord } from "./records-read.mjs";

export const MESSAGE_DIRECTIONS = Object.freeze(["user", "ai"]);
export const MESSAGE_STATUSES = Object.freeze(["received", "processing", "handled", "failed"]);
export const ATTACHMENT_KINDS = Object.freeze(["blob", "capture"]);

export const MAX_CONTENT_LENGTH = 8000;
export const MAX_ATTACHMENTS = 16;
export const MAX_REFS = 16;

/** 引用表 → link_kind（语义单数；未登记表以物理表名作 kind，仍可追溯）。 */
const LINK_KIND_BY_TABLE = Object.freeze({
  assets: "asset",
  intents: "intent",
  attempts: "attempt",
  vulnerabilities: "vulnerability",
  hypotheses: "hypothesis",
  facts: "fact",
  observations: "observation",
  goals: "goal",
  relations: "relation",
  blobs: "blob",
  captures: "capture",
  worker_reports: "worker_report",
  verification_jobs: "verification_job",
  verification_results: "verification_result",
  orchestration_decisions: "orchestration_decision",
  orchestration_actions: "orchestration_action",
  plan_runs: "plan_run",
  resources: "resource",
  endpoint_templates: "endpoint_template",
});

export function linkKindForTable(table) {
  return LINK_KIND_BY_TABLE[table] || table;
}

function nowIso() {
  return new Date().toISOString();
}

function pad4(n) {
  return String(n).padStart(4, "0");
}

/** 事务内分配消息序号（MSG-<PRJ>-nnnn，项目内嵌族；与 E1 同一序列池）。 */
function nextMessageSeq(db, projectId) {
  db.prepare(
    "INSERT INTO id_sequences (project_id, kind, next_val) VALUES (?, ?, 2) ON CONFLICT(project_id, kind) DO NOTHING",
  ).run(projectId, "message");
  const row = db.prepare("SELECT next_val AS n FROM id_sequences WHERE project_id = ? AND kind = ?").get(projectId, "message");
  db.prepare("UPDATE id_sequences SET next_val = ? WHERE project_id = ? AND kind = ?").run(row.n + 1, projectId, "message");
  return row.n;
}

function nextCommitSeq(db, projectId) {
  const row = db.prepare("SELECT next_commit_seq AS n FROM projects WHERE id = ?").get(projectId);
  db.prepare("UPDATE projects SET next_commit_seq = ? WHERE id = ?").run(row.n + 1, projectId);
  return row.n;
}

function emitMessageEvent(db, { projectId, commitSeq, eventType, subjectIds, payload, now, causeRefs }) {
  // 事件编号走与 E1 相同的 outbox "event" 序列（EVT-<projectId>-nnnnnn）；
  // event_index 取该事务内下一个空位（与 recordDecision 等同事务写点共存，§14.1）
  const used = db
    .prepare("SELECT COUNT(*) AS c FROM outbox WHERE project_id = ? AND commit_seq = ?")
    .get(projectId, commitSeq).c;
  db.prepare(
    `INSERT INTO outbox (event_id, project_id, commit_seq, event_index, event_type, subject_ids,
       changed_fields, cause_refs, producer_id, schema_version, payload, delivery_status,
       delivery_attempts, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)`,
  ).run(
    `EVT-${projectId}-${String(nextOutboxSeq(db, projectId)).padStart(6, "0")}`,
    projectId,
    commitSeq,
    used + 1,
    eventType,
    JSON.stringify(subjectIds ?? []),
    JSON.stringify([]),
    JSON.stringify(causeRefs?.length ? causeRefs : ["messages"]),
    "m2/messages",
    1,
    JSON.stringify(payload ?? {}),
    now,
  );
}

function nextOutboxSeq(db, projectId) {
  return allocateEventSeq(db, projectId);
}

/**
 * Outbox 事件序号（与 A1/E1 共用 "event" 项目序列；EVT-<projectId>-nnnnnn 全局唯一）。
 * 供 M2 内多个同事务写点（messages / explore-start / runtime 唤醒）复用。
 */
export function allocateEventSeq(db, projectId) {
  db.prepare(
    "INSERT INTO id_sequences (project_id, kind, next_val) VALUES (?, ?, 2) ON CONFLICT(project_id, kind) DO NOTHING",
  ).run(projectId, "event");
  const row = db.prepare("SELECT next_val AS n FROM id_sequences WHERE project_id = ? AND kind = ?").get(projectId, "event");
  db.prepare("UPDATE id_sequences SET next_val = ? WHERE project_id = ? AND kind = ?").run(row.n + 1, projectId, "event");
  return row.n;
}

export function messageRowView(db, row) {
  const links = db
    .prepare("SELECT link_kind, ref_id, label FROM message_links WHERE message_id = ? ORDER BY link_kind, ref_id")
    .all(row.id);
  const attachments = [];
  for (const link of links) {
    if (link.link_kind === "blob") {
      const b = db.prepare("SELECT sha256, byte_size, representation, storage_status FROM blobs WHERE id = ?").get(link.ref_id);
      const sha = b?.sha256 ?? (link.ref_id.length === 64 ? link.ref_id : null);
      attachments.push({
        kind: "blob",
        ref: link.ref_id,
        label: link.label,
        ...(sha
          ? { sha256: sha, read_path: `/sorne/evidence/blobs/${sha}?project_id=${encodeURIComponent(row.project_id)}` }
          : {}),
      });
    } else if (link.link_kind === "capture") {
      attachments.push({ kind: "capture", ref: link.ref_id, label: link.label, read_path: `/sorne/captures/${link.ref_id}` });
    }
  }
  return {
    id: row.id,
    project_id: row.project_id,
    direction: row.direction,
    content: row.content,
    status: row.status,
    reply_to: row.reply_to || null,
    source_decision_id: row.source_decision_id || null,
    attachments,
    links: links
      .filter((l) => l.link_kind !== "blob" && l.link_kind !== "capture")
      .map((l) => ({ kind: l.link_kind, ref_id: l.ref_id, label: l.label || undefined })),
    created_at: row.created_at,
    created_by: row.created_by,
    created_seq: row.created_seq,
  };
}

/** 校验并规范化附件（blob/capture 必须存在于本项目；整条拒绝，不半提交）。 */
function validateAttachments(db, projectId, rawAttachments) {
  if (rawAttachments === undefined || rawAttachments === null) return [];
  if (!Array.isArray(rawAttachments)) throw apiError("BAD_REQUEST", "attachments 必须是数组");
  if (rawAttachments.length > MAX_ATTACHMENTS) {
    throw apiError("BAD_REQUEST", `attachments 最多 ${MAX_ATTACHMENTS} 项（资源上限）`);
  }
  return rawAttachments.map((att) => {
    if (!att || typeof att !== "object") {
      throw apiError("BAD_REQUEST", "attachments 每项必须是 { kind, ref } 对象");
    }
    if (!ATTACHMENT_KINDS.includes(att.kind)) {
      throw apiError("BAD_REQUEST", `attachments[].kind 允许：${ATTACHMENT_KINDS.join(" / ")}`);
    }
    if (typeof att.ref !== "string" || !att.ref.trim() || att.ref.length > 256) {
      throw apiError("BAD_REQUEST", "attachments[].ref 必须是 1..256 字符的编号或哈希");
    }
    const ref = att.ref.trim();
    if (att.kind === "blob") {
      const byId = db.prepare("SELECT 1 FROM blobs WHERE project_id = ? AND id = ?").get(projectId, ref);
      const isSha = /^[0-9a-f]{64}$/.test(ref.toLowerCase());
      const bySha = isSha
        ? db.prepare("SELECT 1 FROM blobs WHERE project_id = ? AND sha256 = ?").get(projectId, ref.toLowerCase())
        : null;
      if (!byId && !bySha) {
        throw apiError("INVALID_REFERENCE", `附件 blob 不存在于本项目（先经 POST /sorne/evidence/blobs 上传）：${ref}`, {
          detail: { kind: "blob", ref },
          next_requirements: ["先经 POST /sorne/evidence/blobs 上传并取得 B- 编号或 sha256，再随消息提交"],
        });
      }
    } else {
      const hit = locateRecord(db, projectId, ref);
      if (!hit || hit.table !== "captures") {
        throw apiError("INVALID_REFERENCE", `附件 capture 不存在于本项目（先经 POST /sorne/captures 建立采集）：${ref}`, {
          detail: { kind: "capture", ref },
          next_requirements: ["先经 POST /sorne/captures 建立采集记录，再随消息提交"],
        });
      }
    }
    return { kind: att.kind, ref };
  });
}

/** 校验用户引用（针对某资产/方向/漏洞等持久记录；逐项定位，整条拒绝）。 */
function validateRefs(db, projectId, rawRefs) {
  if (rawRefs === undefined || rawRefs === null) return [];
  if (!Array.isArray(rawRefs)) throw apiError("BAD_REQUEST", "refs 必须是数组");
  if (rawRefs.length > MAX_REFS) {
    throw apiError("BAD_REQUEST", `refs 最多 ${MAX_REFS} 项（资源上限）`);
  }
  return rawRefs.map((ref) => {
    if (typeof ref !== "string" || !ref.trim() || ref.trim().length > 256) {
      throw apiError("BAD_REQUEST", "refs 每项必须是 1..256 字符的持久记录编号");
    }
    const trimmed = ref.trim();
    const located = locateRecord(db, projectId, trimmed);
    if (!located) {
      throw apiError("INVALID_REFERENCE", `引用的记录在本项目不存在：${trimmed}`, {
        detail: { ref: trimmed },
        next_requirements: ["改用本项目已存在的持久记录编号（可经 GET /sorne/records/{id} 核对）"],
      });
    }
    return { ref: trimmed, kind: linkKindForTable(located.table) };
  });
}

/**
 * 用户消息入库（#46）。project_id 归属由路由面校验；content 1..8000 字符。
 * 返回 { message, state }；state 恒为 queued_for_orchestrator（等待协调 AI 读取，
 * 不冒充已处理——delivered ≠ handled）。
 */
export async function createUserMessage(pctx, { projectId, actor = "user", content, replyTo, attachments, refs }) {
  if (typeof content !== "string" || !content.trim() || content.length > MAX_CONTENT_LENGTH) {
    throw apiError("BAD_REQUEST", `消息 content 必填（1..${MAX_CONTENT_LENGTH} 字符）`);
  }
  const store = await getStore(pctx);
  return store.runSerial((db) => {
    const project = db.prepare("SELECT id, status FROM projects WHERE id = ?").get(projectId);
    if (!project) {
      throw apiError("NOT_FOUND", `项目不存在：${projectId}`);
    }
    const now = nowIso();
    const normalizedAttachments = validateAttachments(db, projectId, attachments);
    const normalizedRefs = validateRefs(db, projectId, refs);
    if (replyTo !== undefined && replyTo !== null) {
      if (typeof replyTo !== "string" || !replyTo.trim()) {
        throw apiError("BAD_REQUEST", "reply_to 必须是消息编号");
      }
      const parent = db
        .prepare("SELECT 1 FROM messages WHERE project_id = ? AND id = ?")
        .get(projectId, replyTo.trim());
      if (!parent) {
        throw apiError("INVALID_REFERENCE", `reply_to 引用的消息不存在：${replyTo.trim()}`);
      }
    }
    const commitSeq = nextCommitSeq(db, projectId);
    const id = `MSG-${projectId}-${pad4(nextMessageSeq(db, projectId))}`;
    db.prepare(
      `INSERT INTO messages (id, project_id, direction, content, status, reply_to, source_decision_id,
         created_at, created_by, created_seq)
       VALUES (?, ?, 'user', ?, 'received', ?, NULL, ?, ?, ?)`,
    ).run(id, projectId, content.trim(), replyTo ? replyTo.trim() : null, now, actor, commitSeq);
    const links = [
      ...normalizedRefs.map((r) => ({ kind: r.kind, ref: r.ref })),
      ...normalizedAttachments.map((a) => ({ kind: a.kind, ref: a.ref })),
    ];
    for (const link of links) {
      db.prepare("INSERT OR IGNORE INTO message_links (message_id, link_kind, ref_id, label) VALUES (?, ?, ?, '')").run(
        id,
        link.kind,
        link.ref,
      );
    }
    emitMessageEvent(db, {
      projectId,
      commitSeq,
      eventType: "message.received",
      subjectIds: [id, ...links.map((l) => l.ref)],
      payload: {
        message_id: id,
        direction: "user",
        status: "received",
        reply_to: replyTo ? replyTo.trim() : null,
        attachment_kinds: normalizedAttachments.map((a) => a.kind),
        refs: normalizedRefs.map((r) => r.ref),
        note: "用户消息已持久化（received ≠ handled）；唤醒条件见 §2.6-2（delivered ≠ handled）",
      },
      now,
      causeRefs: [id],
    });
    const row = db.prepare("SELECT * FROM messages WHERE id = ?").get(id);
    return {
      message: messageRowView(db, row),
      state: "queued_for_orchestrator",
      note: "消息已持久化等待 Orchestrator 读取（received ≠ handled）；AI 处理结果经 GET /sorne/messages/{id} 的 links 与回复呈现",
    };
  });
}

/** 消息列表（#47；cursor/limit 游标分页，信封 next_cursor + has_more）。 */
export async function listMessages(pctx, { projectId, direction, limit, cursor }) {
  const store = await getStore(pctx);
  const db = store.db;
  if (!db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) {
    throw apiError("NOT_FOUND", `项目不存在：${projectId}`);
  }
  const where = ["project_id = ?"];
  const args = [projectId];
  if (direction) {
    if (!MESSAGE_DIRECTIONS.includes(direction)) {
      throw apiError("BAD_REQUEST", `参数 direction 允许：${MESSAGE_DIRECTIONS.join("、")}`);
    }
    where.push("direction = ?");
    args.push(direction);
  }
  if (cursor) {
    const m = /^(\d+):(.+)$/.exec(cursor);
    if (!m) throw apiError("BAD_REQUEST", "cursor 格式非法（应使用上一页返回的 next_cursor）");
    // 列表按新到旧（created_seq DESC）：续读游标 = 上一页最后一行的 (created_seq, id)，
    // 谓词取更旧一侧（< ），与排序方向一致（不静默停留第一页）
    where.push("(created_seq < ? OR (created_seq = ? AND id < ?))");
    args.push(Number(m[1]), Number(m[1]), m[2]);
  }
  const cap = Math.min(Math.max(Number.isInteger(limit) ? limit : 50, 1), 200);
  const rows = db
    .prepare(`SELECT * FROM messages WHERE ${where.join(" AND ")} ORDER BY created_seq DESC, id LIMIT ?`)
    .all(...args, cap + 1);
  const hasMore = rows.length > cap;
  const page = rows.slice(0, cap);
  const last = page[page.length - 1];
  return {
    messages: page.map((r) => messageRowView(db, r)),
    count: page.length,
    has_more: hasMore,
    next_cursor: hasMore && last ? `${last.created_seq}:${last.id}` : null,
    note: "列表按新到旧；received ≠ handled（AI 处理结果以 links 与 AI 回复消息为准）",
  };
}

/** 单条消息（含回复链与全部关联；「展示对应任务与 AI 处理结果」的读取面）。 */
export async function getMessage(pctx, { projectId, messageId }) {
  const store = await getStore(pctx);
  const db = store.db;
  const row = db.prepare("SELECT * FROM messages WHERE project_id = ? AND id = ?").get(projectId, messageId);
  if (!row) {
    throw apiError("NOT_FOUND", `消息不存在：${messageId}`);
  }
  const replies = db
    .prepare("SELECT * FROM messages WHERE reply_to = ? ORDER BY created_seq, id")
    .all(messageId)
    .map((r) => messageRowView(db, r));
  return {
    message: messageRowView(db, row),
    replies,
    note:
      row.status === "handled"
        ? "AI 已处理（协调决定已持久化并回复）；对应任务与依据经 links 展开"
        : row.direction === "user"
          ? "AI 尚未完成处理（received ≠ handled）；无模型配置或未到协调轮次时停留在 received，不冒充已答复"
          : "AI 消息",
  };
}

/* ── 事务内写点（仅供 recordDecision 在决定持久化事务内调用） ────────── */

/**
 * 决定持久化事务内：关联消息 → decision、置 handled、追加 AI 回复（同一事务，
 * 蓝图 §2.6-2 冻结）。返回回复消息行。失败抛错使整个决定事务回滚（不产生
 * 「决定已存、闭环缺失」的半态）。
 */
export function linkDecisionAndReplyInTx(db, { projectId, messageId, decisionId, replyContent, actor, commitSeq, now, extraLinks = [] }) {
  const msg = db.prepare("SELECT * FROM messages WHERE project_id = ? AND id = ?").get(projectId, messageId);
  if (!msg) {
    throw apiError("INVALID_REFERENCE", `source_message_id 引用的消息不存在：${messageId}`);
  }
  db.prepare("INSERT OR IGNORE INTO message_links (message_id, link_kind, ref_id, label) VALUES (?, 'orchestration_decision', ?, '')").run(
    messageId,
    decisionId,
  );
  for (const link of extraLinks) {
    db.prepare("INSERT OR IGNORE INTO message_links (message_id, link_kind, ref_id, label) VALUES (?, ?, ?, ?)").run(
      messageId,
      link.kind,
      link.ref,
      link.label || "",
    );
  }
  db.prepare("UPDATE messages SET status = 'handled', source_decision_id = ? WHERE id = ?").run(decisionId, messageId);
  const replyId = `MSG-${projectId}-${pad4(nextMessageSeq(db, projectId))}`;
  db.prepare(
    `INSERT INTO messages (id, project_id, direction, content, status, reply_to, source_decision_id,
       created_at, created_by, created_seq)
     VALUES (?, ?, 'ai', ?, 'handled', ?, ?, ?, ?, ?)`,
  ).run(replyId, projectId, replyContent, messageId, decisionId, now, actor, commitSeq);
  emitMessageEvent(db, {
    projectId,
    commitSeq,
    eventType: "message.handled",
    subjectIds: [messageId, replyId, decisionId],
    payload: {
      message_id: messageId,
      reply_id: replyId,
      decision_id: decisionId,
      note: "协调决定已持久化，消息标记 handled 并附 AI 回复（delivered ≠ handled 的闭环证据）",
    },
    now,
    causeRefs: [decisionId],
  });
  return db.prepare("SELECT * FROM messages WHERE id = ?").get(replyId);
}

/**
 * 动作执行后补链（独立小事务；assign_execution 等产生的意图/任务编号补进
 * message_links——「展示对应任务」半边）。缺消息/缺表安全跳过（补链不回滚决定）。
 */
export async function linkRecordsToMessage(pctx, { projectId, messageId, links }) {
  if (!Array.isArray(links) || links.length === 0) return { linked: 0 };
  const store = await getStore(pctx);
  return store.runSerial((db) => {
    let linked = 0;
    for (const link of links) {
      if (!link || typeof link.ref !== "string" || !link.ref) continue;
      const info = db
        .prepare("INSERT OR IGNORE INTO message_links (message_id, link_kind, ref_id, label) VALUES (?, ?, ?, ?)")
        .run(messageId, link.kind || linkKindForTable(link.table || ""), link.ref, link.label || "");
      linked += info.changes;
    }
    return { linked };
  });
}

/** 项目待处理用户消息计数（运行时唤醒条件；§2.6-2/§16.1）。 */
export function countPendingUserMessages(db, projectId) {
  return db
    .prepare("SELECT COUNT(*) AS c FROM messages WHERE project_id = ? AND direction = 'user' AND status IN ('received','processing')")
    .get(projectId).c;
}

/** 取一条最旧的待处理用户消息（Orchestrator 循环读取面；不消费，处理后置 handled）。 */
export function oldestPendingUserMessage(db, projectId) {
  return db
    .prepare(
      `SELECT * FROM messages WHERE project_id = ? AND direction = 'user' AND status = 'received'
        ORDER BY created_seq, id LIMIT 1`,
    )
    .get(projectId);
}

/** 将消息置 processing（Orchestrator 开始读取时；独立小事务，读取失败可重试）。 */
export async function markMessageProcessing(pctx, { projectId, messageId }) {
  const store = await getStore(pctx);
  return store.runSerial((db) => {
    db.prepare("UPDATE messages SET status = 'processing' WHERE project_id = ? AND id = ? AND status = 'received'").run(
      projectId,
      messageId,
    );
    return { ok: true };
  });
}
