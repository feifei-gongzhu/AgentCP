/**
 * 0005 —— 用户消息与关联（蓝图 §2.6-2；M2）。
 *
 * 用户 ↔ Orchestrator 的持久消息通道（要求 §4：消息发出后必须看到它已经被
 * 接收、对应哪个任务，以及 AI 作出了什么处理——不能只留下一个聊天气泡）：
 *   - messages：direction（user/ai）、status（received/processing/handled/failed）。
 *     语义纪律 delivered ≠ handled：持久化即 received；关联协调决定持久化后才算
 *     handled（§18.5.6 同法，规范 §14.3「消息进入上下文只表示 delivered」）。
 *   - message_links：消息与 decision/intent/attempt/verification_job/worker_report/
 *     blob/capture/资产等持久对象的关联（复合主键防重复；label 为人读标签）。
 *     资料半边闭环：用户上传证据经附件编号进入消息（link_kind 含 blob/capture），
 *     AI 经既有 read_record/read_blob 读取，不复制内容进消息。
 *
 * 0005 编号说明（偏离蓝图 §2.8 的 0005-llm-settings/0006-messages 双迁移）：
 *   施工要点将 LLM 配置落 <dataDir>/llm.json 文件（参照已就位的 sorne-data/
 *   llm.json 结构），不建 llm_settings 表；messages/message_links 占 0005。
 *   偏差已在 docs/modules/ui-M2.md 登记回报（蓝图 §10.7）。
 *
 * 迁移纪律（lib/db.mjs）：新表无历史数据；事务内版本复查由 db.mjs 统一实施。
 */
export const version = 5;
export const description = "用户消息 messages 与关联 message_links（§2.6-2：delivered≠handled 闭环）";

export function up(db) {
  db.exec(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      direction TEXT NOT NULL CHECK (direction IN ('user','ai')),
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'received'
        CHECK (status IN ('received','processing','handled','failed')),
      reply_to TEXT REFERENCES messages(id),
      source_decision_id TEXT,
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_seq INTEGER NOT NULL
    );
    CREATE INDEX idx_messages_project ON messages (project_id, created_seq, id);
    CREATE INDEX idx_messages_reply ON messages (reply_to);

    CREATE TABLE message_links (
      message_id TEXT NOT NULL REFERENCES messages(id),
      link_kind TEXT NOT NULL,
      ref_id TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (message_id, link_kind, ref_id)
    );
    CREATE INDEX idx_message_links_ref ON message_links (ref_id);
  `);
}
