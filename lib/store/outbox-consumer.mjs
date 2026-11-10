/**
 * Outbox 消费闭环（规范 §14）：进程内消费者 "sorne-runtime" 的投递与确认。
 *
 * 现状：Outbox 只有生产，pending 长期不下降；变化页是拉取式，agent 运行时靠
 * 高水位轮询，不写 consumer_receipts。本模块把「运行时已处理到哪里」变成持久回执：
 *   - bootstrap：首次接手时，把当前高水位之前的存量事件标记 skipped（已由快照覆盖，
 *     §15.2 快照+增量不丢；不伪造 applied）；
 *   - consume：每次 runOnce 处理完输入边界后，为 (prev, boundary] 的事件写 applied 回执，
 *     并把对应 outbox 行置 sent（任一消费者投递即 sent 的全局语义，B2）；
 *   - 幂等：consumer_receipts 复合主键 + ON CONFLICT，重复执行不重复计费/不重复事件。
 */
import { getStore } from "./record-service.mjs";

const CONSUMER_ID = "sorne-runtime";

/** 首次接手：把 boundary 之前的存量 pending 标记 skipped（快照已覆盖，不冒充 applied）。 */
export async function bootstrapOutbox(pctx, { projectId, throughCommitSeq, consumerId = CONSUMER_ID }) {
  const store = await getStore(pctx);
  return store.runSerial((db) => {
    const now = new Date().toISOString();
    const upd = db
      .prepare("UPDATE outbox SET delivery_status = 'skipped' WHERE project_id = ? AND delivery_status = 'pending' AND commit_seq <= ?")
      .run(projectId, throughCommitSeq);
    return { consumer_id: consumerId, bootstrap_skipped: upd.changes, through_commit_seq: throughCommitSeq, at: now };
  });
}

/** 消费 (fromCommitSeq, throughCommitSeq]：写 applied 回执并置 sent（幂等）。 */
export async function consumeOutbox(pctx, { projectId, fromCommitSeq = 0, throughCommitSeq, consumerId = CONSUMER_ID, subscriptionRevision = 1 }) {
  if (!projectId) throw new Error("consumeOutbox 需要 projectId");
  if (!Number.isInteger(fromCommitSeq) || fromCommitSeq < 0) throw new Error("fromCommitSeq 必须是非负整数");
  if (!Number.isInteger(throughCommitSeq) || throughCommitSeq < 0) throw new Error("throughCommitSeq 必须是非负整数");
  const store = await getStore(pctx);
  return store.runSerial((db) => {
    const now = new Date().toISOString();
    const rows = db
      .prepare("SELECT event_id, commit_seq, event_index FROM outbox WHERE project_id = ? AND commit_seq > ? AND commit_seq <= ? ORDER BY commit_seq, event_index")
      .all(projectId, fromCommitSeq, throughCommitSeq);
    const insert = db.prepare(
      "INSERT INTO consumer_receipts (consumer_id, subscription_revision, event_id, receipt_kind, boundary, created_at) " +
      "VALUES (?, ?, ?, 'applied', ?, ?) " +
      "ON CONFLICT(consumer_id, subscription_revision, event_id) " +
      "DO UPDATE SET receipt_kind = 'applied', boundary = excluded.boundary",
    );
    let applied = 0;
    for (const r of rows) {
      insert.run(consumerId, subscriptionRevision, r.event_id, "log:" + r.commit_seq + ":" + r.event_index, now);
      applied += 1;
    }
    const upd = db
      .prepare("UPDATE outbox SET delivery_status = 'sent' WHERE project_id = ? AND delivery_status = 'pending' AND commit_seq > ? AND commit_seq <= ?")
      .run(projectId, fromCommitSeq, throughCommitSeq);
    return {
      consumer_id: consumerId,
      subscription_revision: subscriptionRevision,
      scanned: rows.length,
      applied,
      marked_sent: upd.changes,
      from_commit_seq: fromCommitSeq,
      through_commit_seq: throughCommitSeq,
    };
  });
}