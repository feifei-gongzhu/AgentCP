/**
 * 0009 —— 覆盖记录与依赖追踪（01 号基线 §五、§十、§十二；实施计划阶段 4）。
 *
 * 新增持久表：
 *   1. check_records：按意图/Attempt 保存的检查记录。记录材料范围、检查方法、
 *      发现入口、未覆盖部分与适用条件。覆盖状态三值：checked/partial/unknown。
 *      §十「工具记录实际读取范围，Worker 说明做过什么检查，两者分别保留」。
 *   2. judgement_corrections：判断修正记录。保留原观察和反证，记录修正原因、
 *      新解释与受影响的依赖。§九「后来发现该字符串属于 Mock 配置，可能改变解释，
 *      但不需要删除"字符串曾出现"的观察」。
 */
export const version = 9;
export const description =
  "覆盖记录与依赖追踪：check_records + judgement_corrections（阶段 4）";

export function up(db) {
  db.exec(`
    CREATE TABLE check_records (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      intent_id TEXT NOT NULL,
      attempt_id TEXT,
      material_ids_json TEXT NOT NULL DEFAULT '[]',
      material_range_json TEXT NOT NULL DEFAULT '{}',
      check_method TEXT NOT NULL DEFAULT '',
      findings_entry_ids_json TEXT NOT NULL DEFAULT '[]',
      uncovered_parts_json TEXT NOT NULL DEFAULT '[]',
      applicable_conditions_json TEXT NOT NULL DEFAULT '[]',
      coverage_status TEXT NOT NULL DEFAULT 'unknown'
        CHECK (coverage_status IN ('checked', 'partial', 'unknown')),
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_seq INTEGER NOT NULL
    );
    CREATE INDEX idx_check_records_intent
      ON check_records (project_id, intent_id);
    CREATE INDEX idx_check_records_attempt
      ON check_records (project_id, attempt_id);

    CREATE TABLE judgement_corrections (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      subject_id TEXT NOT NULL,
      subject_kind TEXT NOT NULL,
      original_interpretation TEXT NOT NULL DEFAULT '',
      corrected_interpretation TEXT NOT NULL DEFAULT '',
      correction_reason TEXT NOT NULL DEFAULT '',
      counter_evidence_ids_json TEXT NOT NULL DEFAULT '[]',
      preserved_observation_ids_json TEXT NOT NULL DEFAULT '[]',
      affected_intent_ids_json TEXT NOT NULL DEFAULT '[]',
      corrected_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_seq INTEGER NOT NULL
    );
    CREATE INDEX idx_judgement_corrections_subject
      ON judgement_corrections (project_id, subject_id);
  `);
}
