/**
 * 0001 —— 核心模式（冻结 DDL，完整对应规范 §6.2 全部逻辑表 + §6.3 全部约束与索引）。
 *
 * 本文件是 BLUEPRINT.md §4「DDL 清单」的唯一权威实现：
 *   - §6.1 通用字段：所有业务表含 id/project_id/created_at/created_by/created_seq；
 *     可变对象加 updated_seq/state_version；结论类对象加 evidence_revision/
 *     assessment_epoch/claim_revision。
 *   - §6.3 约束逐条落实（见 BLUEPRINT §4.2 对照表）；修改本文件需架构师批准。
 *   - 多态引用（relations.from_id 等）无法用外键表达，由 Record Service 校验存在性。
 */
export const version = 1;
export const description = "核心模式：§6.2 全部逻辑表与 §6.3 全部约束索引";

const SQL = `
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','waiting_for_change','paused','stopped')),
  current_scope_revision TEXT,
  resource_policy TEXT NOT NULL DEFAULT '{}',
  next_commit_seq INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_seq INTEGER NOT NULL DEFAULT 0,
  updated_seq INTEGER NOT NULL DEFAULT 0,
  state_version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE scope_revisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  revision TEXT NOT NULL,
  rules TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_seq INTEGER NOT NULL,
  UNIQUE (project_id, revision)
);

CREATE TABLE goals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  parent_goal_id TEXT REFERENCES goals(id),
  statement TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  constraint_refs TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_seq INTEGER NOT NULL,
  updated_seq INTEGER NOT NULL DEFAULT 0,
  state_version INTEGER NOT NULL DEFAULT 1
);

-- §7.1 资产身份：唯一约束保护已定义的精确身份；并发创建靠约束而非先查后插。
CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  asset_type TEXT NOT NULL,
  canonicalization_version TEXT NOT NULL,
  canonical_key TEXT NOT NULL,
  original_input TEXT NOT NULL,
  scope_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (scope_status IN ('allowed','denied','pending')),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_seq INTEGER NOT NULL,
  UNIQUE (project_id, asset_type, canonicalization_version, canonical_key)
);
CREATE INDEX idx_assets_project_type ON assets (project_id, asset_type);

CREATE TABLE resources (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  asset_id TEXT NOT NULL REFERENCES assets(id),
  method TEXT NOT NULL,
  url_exact TEXT NOT NULL,
  scheme TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  path_exact TEXT NOT NULL,
  query_exact TEXT NOT NULL DEFAULT '',
  service_asset_id TEXT REFERENCES assets(id),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_seq INTEGER NOT NULL,
  UNIQUE (project_id, method, url_exact)
);

-- §7.2 模板是可修正判断：可确认、拆分、撤回，不导致原始采集丢失。
CREATE TABLE endpoint_templates (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  method TEXT NOT NULL,
  service_asset_id TEXT NOT NULL REFERENCES assets(id),
  path_template TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'candidate'
    CHECK (status IN ('candidate','confirmed','split','withdrawn')),
  confidence TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_seq INTEGER NOT NULL,
  updated_seq INTEGER NOT NULL DEFAULT 0,
  state_version INTEGER NOT NULL DEFAULT 1,
  UNIQUE (project_id, method, service_asset_id, path_template)
);
CREATE TABLE template_members (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  template_id TEXT NOT NULL REFERENCES endpoint_templates(id),
  resource_id TEXT NOT NULL REFERENCES resources(id),
  captured_from TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_seq INTEGER NOT NULL,
  UNIQUE (template_id, resource_id)
);

-- §5.3 Blob：内容寻址、不可变；相同哈希只保留一份；表示形式必须注明。
CREATE TABLE blobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  sha256 TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  representation TEXT NOT NULL
    CHECK (representation IN ('raw_body','decoded_body','request_record','exchange_record','derived','uploaded_file')),
  stored_path TEXT NOT NULL DEFAULT '',
  storage_status TEXT NOT NULL DEFAULT 'staged'
    CHECK (storage_status IN ('staged','fixed','orphan','lost')),
  source_kind TEXT NOT NULL DEFAULT 'tool_gateway'
    CHECK (source_kind IN ('tool_gateway','third_party_import','worker_upload')),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_seq INTEGER NOT NULL,
  UNIQUE (project_id, sha256)
);

-- §6.3：captures 用采集操作 ID 去重，不对 URL+Blob 建唯一约束。
CREATE TABLE captures (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  resource_id TEXT REFERENCES resources(id),
  tool_call_id TEXT NOT NULL,
  attempt_id TEXT,
  observed_at TEXT,
  recorded_at TEXT NOT NULL,
  request_ref TEXT,
  response_headers_ref TEXT,
  response_body_blob TEXT REFERENCES blobs(id),
  request_url_exact TEXT NOT NULL,
  method TEXT NOT NULL,
  condition_snapshot_id TEXT,
  source_kind TEXT NOT NULL DEFAULT 'tool_gateway',
  integrity_status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_seq INTEGER NOT NULL,
  UNIQUE (project_id, tool_call_id)
);

-- §5.3 派生资料：source + transform_name + transform_version + parameters + derived_blob。
CREATE TABLE transforms (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('blob','capture')),
  source_id TEXT NOT NULL,
  transform_name TEXT NOT NULL,
  transform_version TEXT NOT NULL,
  parameters TEXT NOT NULL DEFAULT '{}',
  derived_blob_id TEXT NOT NULL REFERENCES blobs(id),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_seq INTEGER NOT NULL,
  UNIQUE (project_id, source_kind, source_id, transform_name, transform_version, parameters)
);

-- 观察：不可变；锚点为 EvidenceAnchor（§5.4）。
CREATE TABLE observations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  capture_id TEXT REFERENCES captures(id),
  anchor TEXT NOT NULL DEFAULT '{}',
  statement TEXT NOT NULL,
  conditions TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_seq INTEGER NOT NULL
);

-- 假设：§8.2 状态机。
CREATE TABLE hypotheses (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  statement TEXT NOT NULL,
  conditions TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','testing','supported','rejected','inconclusive')),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_seq INTEGER NOT NULL,
  updated_seq INTEGER NOT NULL DEFAULT 0,
  state_version INTEGER NOT NULL DEFAULT 1,
  claim_revision INTEGER NOT NULL DEFAULT 1,
  evidence_revision INTEGER NOT NULL DEFAULT 1,
  assessment_epoch INTEGER NOT NULL DEFAULT 1
);

-- 事实：§8.2 状态机；适用条件与验证依据必须注明。
CREATE TABLE facts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  statement TEXT NOT NULL,
  conditions TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'verified'
    CHECK (status IN ('verified','disputed','superseded','retracted')),
  verification_refs TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_seq INTEGER NOT NULL,
  updated_seq INTEGER NOT NULL DEFAULT 0,
  state_version INTEGER NOT NULL DEFAULT 1,
  claim_revision INTEGER NOT NULL DEFAULT 1,
  evidence_revision INTEGER NOT NULL DEFAULT 1,
  assessment_epoch INTEGER NOT NULL DEFAULT 1
);

-- 漏洞：suspected 起即有身份与草稿；confirmed 只能由独立验证经程序提交（§8.2/§8.4）。
CREATE TABLE vulnerabilities (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  asset_id TEXT REFERENCES assets(id),
  location TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'suspected'
    CHECK (status IN ('suspected','confirmed','falsified','inconclusive')),
  review TEXT NOT NULL DEFAULT 'clear' CHECK (review IN ('clear','pending','disputed')),
  impact TEXT NOT NULL DEFAULT '',
  conditions TEXT NOT NULL DEFAULT '[]',
  confirmed_version TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_seq INTEGER NOT NULL,
  updated_seq INTEGER NOT NULL DEFAULT 0,
  state_version INTEGER NOT NULL DEFAULT 1,
  claim_revision INTEGER NOT NULL DEFAULT 1,
  evidence_revision INTEGER NOT NULL DEFAULT 1,
  assessment_epoch INTEGER NOT NULL DEFAULT 1
);

-- §7.3 候选组只用于查找聚合，不替代漏洞身份；误合并可拆分。
CREATE TABLE candidate_groups (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  group_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_seq INTEGER NOT NULL,
  updated_seq INTEGER NOT NULL DEFAULT 0,
  state_version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE memberships (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  group_id TEXT NOT NULL REFERENCES candidate_groups(id),
  member_id TEXT NOT NULL,
  member_kind TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_seq INTEGER NOT NULL,
  UNIQUE (group_id, member_id)
);

-- §9.1 关系边：带创建者、来源与提交序号；不支持通用去重键（条件与历史版本不被忽略）。
CREATE TABLE relations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  relation_type TEXT NOT NULL CHECK (relation_type IN (
    'discovered_from','derived_from','requires','supports','contradicts',
    'targets','produced_by','verifies','supersedes','retracts','related_to',
    'duplicate_of','equivalent_to')),
  conditions TEXT NOT NULL DEFAULT '',
  requires_state TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  valid_from_seq INTEGER NOT NULL,
  retracted_at TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_seq INTEGER NOT NULL
);
CREATE INDEX idx_relations_from ON relations (project_id, from_id, relation_type);
CREATE INDEX idx_relations_to ON relations (project_id, to_id, relation_type);

-- §10.1 意图合同。
CREATE TABLE intents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  goal_id TEXT REFERENCES goals(id),
  question TEXT NOT NULL,
  rationale TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL CHECK (kind IN ('collect','investigate','verify','revisit')),
  target_asset_ids TEXT NOT NULL DEFAULT '[]',
  basis_refs TEXT NOT NULL DEFAULT '[]',
  prerequisite_refs TEXT NOT NULL DEFAULT '[]',
  scope_revision TEXT,
  condition_requirements TEXT NOT NULL DEFAULT '[]',
  success_criteria TEXT NOT NULL DEFAULT '',
  deliverables TEXT NOT NULL DEFAULT '[]',
  priority INTEGER NOT NULL DEFAULT 0,
  budget TEXT NOT NULL DEFAULT '{}',
  resume_conditions TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed','queued','running','resolved','blocked','awaiting_review','deferred','obsolete','cancelled')),
  runnable_at TEXT,
  state_version INTEGER NOT NULL DEFAULT 1,
  plan_revision TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_seq INTEGER NOT NULL,
  updated_seq INTEGER NOT NULL DEFAULT 0
);
-- §6.3：索引状态、优先级、可运行时间；候选相似性不建唯一约束。
CREATE INDEX idx_intents_dispatch ON intents (project_id, status, priority, runnable_at);
CREATE INDEX idx_intents_status ON intents (project_id, status);
-- §6.3「恢复条件」的等效结构：resume_conditions 为 JSON 数组无法直接 B-tree，
-- 以部分表达式索引加速「带未满足恢复条件的可恢复意图」检索（§10.1/§9.2）。
CREATE INDEX idx_intents_resume
  ON intents (project_id, status)
  WHERE status IN ('blocked','deferred','obsolete') AND resume_conditions != '[]';

-- §10.2 Attempt：条件领取 + 单调 fencing token；同一执行分配最多一个有效执行者。
CREATE TABLE attempts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  intent_id TEXT NOT NULL REFERENCES intents(id),
  assignment_id TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  fencing_token INTEGER NOT NULL,
  lease_expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'leased'
    CHECK (status IN ('leased','running','suspended','interrupted','completed','failed','cancelled')),
  recovery_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_seq INTEGER NOT NULL,
  updated_seq INTEGER NOT NULL DEFAULT 0,
  state_version INTEGER NOT NULL DEFAULT 1,
  UNIQUE (project_id, fencing_token)
);
CREATE UNIQUE INDEX idx_attempts_active_assignment
  ON attempts (project_id, assignment_id) WHERE status IN ('leased','running');

-- §10.2 工具调用：planned→running→succeeded/failed/unknown；不视作恰好一次。
CREATE TABLE tool_calls (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  tool_name TEXT NOT NULL,
  args_digest TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned','running','succeeded','failed','unknown','cancelled')),
  started_at TEXT,
  ended_at TEXT,
  evidence_refs TEXT NOT NULL DEFAULT '[]',
  error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_seq INTEGER NOT NULL,
  updated_seq INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_tool_calls_attempt ON tool_calls (project_id, attempt_id);

-- §12.1 不可变证据清单：reviewed_evidence_revision 必须绑定 Manifest
-- （列出该版本的证据成员、条件、判断版本和策略版本；单个最大 Event ID 不能替代）。
CREATE TABLE evidence_manifests (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  subject_id TEXT NOT NULL,
  subject_kind TEXT NOT NULL,
  claim_revision INTEGER NOT NULL,
  policy_version TEXT NOT NULL DEFAULT '',
  evidence_revision INTEGER NOT NULL,
  members TEXT NOT NULL DEFAULT '[]',
  conditions TEXT NOT NULL DEFAULT '[]',
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_seq INTEGER NOT NULL,
  UNIQUE (project_id, subject_id, evidence_revision, claim_revision, policy_version)
);

-- §8.3 验证任务：去重键=待验证判断+条件快照+验证策略版本+所审阅证据版本（§7.3）。
CREATE TABLE verification_jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  subject_id TEXT NOT NULL,
  subject_kind TEXT NOT NULL,
  claim_revision INTEGER NOT NULL,
  condition_snapshot_id TEXT,
  policy_id TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  evidence_manifest_id TEXT REFERENCES evidence_manifests(id),
  expected_state_version INTEGER NOT NULL,
  expected_evidence_revision INTEGER NOT NULL,
  expected_assessment_epoch INTEGER NOT NULL,
  requested_by TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','in_progress','completed','superseded')),
  dedup_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_seq INTEGER NOT NULL,
  updated_seq INTEGER NOT NULL DEFAULT 0,
  state_version INTEGER NOT NULL DEFAULT 1,
  UNIQUE (project_id, dedup_key)
);

-- §8.3 验证结果：不可变；字段与 VerificationResult 合同一一对应。
CREATE TABLE verification_results (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  job_id TEXT NOT NULL REFERENCES verification_jobs(id),
  subject_id TEXT NOT NULL,
  claim_revision INTEGER NOT NULL,
  condition_snapshot_id TEXT,
  verifier_identity TEXT NOT NULL,
  verifier_kind TEXT NOT NULL CHECK (verifier_kind IN ('llm_agent','versioned_rule','arbitration')),
  policy_version TEXT NOT NULL,
  reviewed_manifest_id TEXT NOT NULL REFERENCES evidence_manifests(id),
  reviewed_evidence_revision INTEGER NOT NULL,
  expected_state_version INTEGER NOT NULL,
  expected_assessment_epoch INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('supported','falsified','insufficient','conflicting')),
  checks TEXT NOT NULL DEFAULT '[]',
  supporting_refs TEXT NOT NULL DEFAULT '[]',
  opposing_refs TEXT NOT NULL DEFAULT '[]',
  limitations TEXT NOT NULL DEFAULT '',
  suggested_followups TEXT NOT NULL DEFAULT '[]',
  applied INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_seq INTEGER NOT NULL
);

-- §12.1 证据集成员：防重复；反对关系/条件变化仍算证据集变更。
CREATE TABLE evidence_memberships (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  subject_id TEXT NOT NULL,
  member_kind TEXT NOT NULL,
  member_id TEXT NOT NULL,
  stance TEXT NOT NULL DEFAULT 'supports' CHECK (stance IN ('supports','contradicts','neutral')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','withdrawn','disputed')),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_seq INTEGER NOT NULL,
  UNIQUE (project_id, subject_id, member_kind, member_id)
);
CREATE INDEX idx_evidence_memberships_subject ON evidence_memberships (project_id, subject_id);

-- §11.1/§6.3 幂等提交：同 ID 同摘要返回原回执，同 ID 不同内容拒绝。
CREATE TABLE submissions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  submitter_id TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  receipt TEXT NOT NULL DEFAULT '',
  commit_seq INTEGER,
  status TEXT NOT NULL DEFAULT 'committed' CHECK (status IN ('committed','rejected')),
  accepted_operations TEXT NOT NULL DEFAULT '[]',
  warnings TEXT NOT NULL DEFAULT '[]',
  result_hash TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE (project_id, submitter_id, id)
);

-- §14.1 Outbox：event_id 唯一；页序索引与待发送状态索引。
CREATE TABLE outbox (
  event_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  commit_seq INTEGER NOT NULL,
  event_index INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  subject_ids TEXT NOT NULL DEFAULT '[]',
  changed_fields TEXT NOT NULL DEFAULT '[]',
  cause_refs TEXT NOT NULL DEFAULT '[]',
  producer_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  delivery_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (delivery_status IN ('pending','sent','failed','skipped')),
  delivery_attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, commit_seq, event_index)
);
CREATE INDEX idx_outbox_page ON outbox (project_id, commit_seq, event_index);
CREATE INDEX idx_outbox_pending ON outbox (delivery_status) WHERE delivery_status = 'pending';

-- §14.3 消费回执：delivered 与 applied 分开保存。
CREATE TABLE consumer_receipts (
  consumer_id TEXT NOT NULL,
  subscription_revision INTEGER NOT NULL,
  event_id TEXT NOT NULL REFERENCES outbox(event_id),
  receipt_kind TEXT NOT NULL DEFAULT 'delivered' CHECK (receipt_kind IN ('delivered','applied')),
  boundary TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  PRIMARY KEY (consumer_id, subscription_revision, event_id)
);

-- §15.5 动态订阅。
CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  consumer_id TEXT NOT NULL,
  focus TEXT NOT NULL DEFAULT '{}',
  relation_rules TEXT NOT NULL DEFAULT '[]',
  scope TEXT NOT NULL DEFAULT '{}',
  subscription_revision INTEGER NOT NULL DEFAULT 1,
  last_cursor TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_seq INTEGER NOT NULL,
  updated_seq INTEGER NOT NULL DEFAULT 0,
  state_version INTEGER NOT NULL DEFAULT 1
);

-- §15.1 Map 快照是派生视图，可完全重建。
CREATE TABLE snapshots (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL CHECK (kind IN ('asset_map','exploration_map','planner_view','context','report')),
  scope TEXT NOT NULL DEFAULT '{}',
  snapshot_commit_seq INTEGER NOT NULL,
  content_ref TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  folding_notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_seq INTEGER NOT NULL
);

-- §18.1 接手快照。
CREATE TABLE checkpoints (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  intent_id TEXT,
  attempt_id TEXT,
  content TEXT NOT NULL DEFAULT '{}',
  processed_boundary TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_seq INTEGER NOT NULL
);

-- §16.2 计划接收：输入版本、输出、接收/拒绝结果。
CREATE TABLE plan_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  input_snapshot_id TEXT,
  input_boundary TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','in_flight','received','rejected')),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_seq INTEGER NOT NULL,
  updated_seq INTEGER NOT NULL DEFAULT 0,
  state_version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE plan_revisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  plan_run_id TEXT NOT NULL REFERENCES plan_runs(id),
  revision TEXT NOT NULL,
  intents_created TEXT NOT NULL DEFAULT '[]',
  intents_updated TEXT NOT NULL DEFAULT '[]',
  rationale_refs TEXT NOT NULL DEFAULT '[]',
  prerequisites TEXT NOT NULL DEFAULT '[]',
  received_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (received_status IN ('pending','accepted','partial','rejected','suspended')),
  reject_reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_seq INTEGER NOT NULL,
  UNIQUE (project_id, plan_run_id, revision)
);

-- §3.3 协调决定与动作：动作有独立幂等编号；重启后逐项核对实际完成情况。
CREATE TABLE orchestration_decisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  input_report_ids TEXT NOT NULL DEFAULT '[]',
  input_event_refs TEXT NOT NULL DEFAULT '[]',
  rationale TEXT NOT NULL DEFAULT '',
  tool_result TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_seq INTEGER NOT NULL
);
CREATE TABLE orchestration_actions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  decision_id TEXT NOT NULL REFERENCES orchestration_decisions(id),
  action_kind TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','executed','failed','skipped')),
  result TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_seq INTEGER NOT NULL,
  updated_seq INTEGER NOT NULL DEFAULT 0,
  UNIQUE (project_id, idempotency_key)
);

-- §18.3 分层汇报与 §18.5 接收闭环。
CREATE TABLE worker_reports (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  intent_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('progress','handoff','blocked','completion')),
  replaces_report_id TEXT,
  base_report_id TEXT,
  source_manifest_id TEXT NOT NULL DEFAULT '',
  source_commit_boundary TEXT NOT NULL DEFAULT '',
  task_question TEXT NOT NULL DEFAULT '',
  actual_outcome TEXT NOT NULL DEFAULT '',
  execution_status TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '{}',
  omitted_sections TEXT NOT NULL DEFAULT '[]',
  delivery_status TEXT NOT NULL DEFAULT 'delivered',
  handling_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (handling_status IN ('pending','handled','needs_clarification','deferred')),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_seq INTEGER NOT NULL
);
CREATE TABLE report_receipts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  report_id TEXT NOT NULL REFERENCES worker_reports(id),
  receipt_kind TEXT NOT NULL
    CHECK (receipt_kind IN ('accepted','needs_clarification','deferred','coordinated')),
  followup_ref TEXT NOT NULL DEFAULT '',
  decision_id TEXT REFERENCES orchestration_decisions(id),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_seq INTEGER NOT NULL
);

-- §19 报告版本。
CREATE TABLE report_revisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  report_kind TEXT NOT NULL CHECK (report_kind IN ('vulnerability','milestone')),
  subject_id TEXT NOT NULL,
  version TEXT NOT NULL,
  content_ref TEXT NOT NULL,
  basis_refs TEXT NOT NULL DEFAULT '[]',
  data_boundary TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_seq INTEGER NOT NULL,
  UNIQUE (project_id, report_kind, subject_id, version)
);

-- 程序分配稳定编号的序列源（§6.1）：kind 如 asset、intent、event、fencing、seq。
CREATE TABLE id_sequences (
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  next_val INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (project_id, kind)
);
`;

export function up(db) {
  db.exec(SQL);
}
