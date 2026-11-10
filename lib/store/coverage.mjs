/**
 * 覆盖记录与判断修正服务（01 号基线 §五、§九、§十、§十二；实施计划阶段 4）。
 *
 * 核心流程：
 *   1. saveCheckRecord：Worker/Verifier 按意图和 Attempt 保存检查记录——
 *      材料范围、检查方法、发现入口、未覆盖部分与适用条件。
 *      §十「工具记录实际读取范围，Worker 说明做过什么检查，两者分别保留」。
 *   2. correctJudgement：修正判断时保留原观察和反证，用明确依赖筛选
 *      受影响任务。§九「后来发现属于 Mock 配置，改变解释但不删除观察」。
 *   3. findAffectedIntents：按 basis_refs / prerequisite_refs 查找依赖
 *      某个判断的意图，区分「调查」与「依赖成立」。§十二。
 */
import { apiError } from "../errors.mjs";
import { getStore } from "./record-service.mjs";

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

/**
 * 保存一条检查记录（§十：覆盖记录围绕具体工作保存）。
 *
 * @param {object} pctx
 * @param {object} opts
 * @param {string} opts.projectId
 * @param {string} opts.intentId
 * @param {string} [opts.attemptId]
 * @param {string[]} [opts.materialIds] - 涉及材料的记录编号
 * @param {object} [opts.materialRange] - 材料的字节/行/选择器范围
 * @param {string} opts.checkMethod - 检查方法说明
 * @param {string[]} [opts.findingsEntryIds] - 发现入口编号
 * @param {string[]} [opts.uncoveredParts] - 未覆盖部分说明
 * @param {string[]} [opts.applicableConditions] - 适用条件
 * @param {string} [opts.coverageStatus] - checked/partial/unknown
 * @param {string} [opts.note]
 * @param {string} opts.actor
 */
export async function saveCheckRecord(pctx, opts) {
  const {
    projectId, intentId, attemptId, materialIds, materialRange,
    checkMethod, findingsEntryIds, uncoveredParts, applicableConditions,
    coverageStatus, note, actor,
  } = opts;

  if (!projectId) throw apiError("BAD_REQUEST", "缺少 project_id");
  if (!intentId) throw apiError("BAD_REQUEST", "缺少 intent_id");
  if (!checkMethod) throw apiError("BAD_REQUEST", "缺少 check_method");

  const status = coverageStatus || "unknown";
  if (!["checked", "partial", "unknown"].includes(status)) {
    throw apiError("BAD_REQUEST", `coverage_status 必须为 checked/partial/unknown，实际：${status}`);
  }

  const store = await getStore(pctx);
  return store.runSerial((db) => {
    const commitSeq = allocateCommitSeq(db, projectId);
    const now = new Date().toISOString();
    const n = allocateSeq(db, projectId, "check_record");
    const id = `CR-${projectId}-${pad4(n)}`;

    db.prepare(
      `INSERT INTO check_records
         (id, project_id, intent_id, attempt_id,
          material_ids_json, material_range_json, check_method,
          findings_entry_ids_json, uncovered_parts_json, applicable_conditions_json,
          coverage_status, note, created_at, created_by, created_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, projectId, intentId, attemptId || null,
      JSON.stringify(materialIds || []),
      JSON.stringify(materialRange || {}),
      checkMethod,
      JSON.stringify(findingsEntryIds || []),
      JSON.stringify(uncoveredParts || []),
      JSON.stringify(applicableConditions || []),
      status, note || "", now, actor || "system", commitSeq,
    );

    return {
      check_record_id: id,
      coverage_status: status,
      material_count: (materialIds || []).length,
      findings_count: (findingsEntryIds || []).length,
      uncovered_count: (uncoveredParts || []).length,
      created_seq: commitSeq,
    };
  });
}

/**
 * 列出某意图或 Attempt 的检查记录。
 */
export async function listCheckRecords(pctx, { projectId, intentId, attemptId, limit, cursor }) {
  if (!projectId) throw apiError("BAD_REQUEST", "缺少 project_id");
  const store = await getStore(pctx);
  const db = store.db;
  const lim = Math.min(Math.max(Number(limit) || 20, 1), 100);

  let where = "project_id = ?";
  const params = [projectId];
  if (intentId) { where += " AND intent_id = ?"; params.push(intentId); }
  if (attemptId) { where += " AND attempt_id = ?"; params.push(attemptId); }
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
    `SELECT * FROM check_records WHERE ${where} ORDER BY created_seq, id LIMIT ?`,
  ).all(...params, lim + 1);

  const hasMore = rows.length > lim;
  const items = rows.slice(0, lim);
  return {
    items: items.map((r) => ({
      id: r.id,
      intent_id: r.intent_id,
      attempt_id: r.attempt_id,
      material_ids: JSON.parse(r.material_ids_json),
      material_range: JSON.parse(r.material_range_json),
      check_method: r.check_method,
      findings_entry_ids: JSON.parse(r.findings_entry_ids_json),
      uncovered_parts: JSON.parse(r.uncovered_parts_json),
      applicable_conditions: JSON.parse(r.applicable_conditions_json),
      coverage_status: r.coverage_status,
      note: r.note,
      created_at: r.created_at,
      created_by: r.created_by,
      created_seq: r.created_seq,
    })),
    total: items.length,
    has_more: hasMore,
    next_cursor: items.length > 0
      ? `${items[items.length - 1].created_seq}:${items[items.length - 1].id}` : null,
  };
}

/**
 * 获取材料的覆盖状态（§十：覆盖范围不明确时，标记为部分检查或未知）。
 *
 * 综合 material_read_logs（工具实际读取范围）和 check_records（Worker 声明的检查范围），
 * 返回最高覆盖状态。仅有 read_logs 无 check_records → unknown（读取不等于检查）。
 */
export async function getCoverageForMaterial(pctx, { projectId, materialId }) {
  if (!projectId || !materialId) throw apiError("BAD_REQUEST", "缺少 project_id 或 material_id");
  const store = await getStore(pctx);
  const db = store.db;

  const readLogs = db.prepare(
    "SELECT COUNT(*) AS c FROM material_read_logs WHERE project_id = ? AND target_id = ?",
  ).get(projectId, materialId);

  const checkRecords = db.prepare(
    `SELECT coverage_status, material_ids_json FROM check_records
     WHERE project_id = ? AND material_ids_json LIKE ?
     ORDER BY created_seq DESC`,
  ).all(projectId, `%${materialId}%`);

  const hasReads = readLogs.c > 0;
  const checks = checkRecords.filter((r) => {
    const ids = JSON.parse(r.material_ids_json || "[]");
    return ids.includes(materialId);
  });

  if (checks.length === 0) {
    return {
      material_id: materialId,
      coverage_status: hasReads ? "unknown" : "unknown",
      read_count: readLogs.c,
      check_count: 0,
      note: hasReads
        ? "材料已被工具读取但无检查记录——仅说明工具返回过它，不说明模型从所有角度检查过（§十）"
        : "材料未被读取也无检查记录",
    };
  }

  const best = checks.some((c) => c.coverage_status === "checked") ? "checked"
    : checks.some((c) => c.coverage_status === "partial") ? "partial"
      : "unknown";

  return {
    material_id: materialId,
    coverage_status: best,
    read_count: readLogs.c,
    check_count: checks.length,
    note: null,
  };
}

/**
 * 修正判断（§九/§十二）：保留原观察和反证，更新解释，查找受影响意图。
 *
 * 不删除原始观察——「后来发现该字符串属于 Mock 配置，可能改变解释，
 * 但不需要删除"字符串曾出现"的观察」。
 *
 * @param {object} pctx
 * @param {object} opts
 * @param {string} opts.projectId
 * @param {string} opts.subjectId - 被修正的判断编号（H-/V-/F-）
 * @param {string} opts.subjectKind - hypothesis/vulnerability/fact
 * @param {string} opts.originalInterpretation - 原解释
 * @param {string} opts.correctedInterpretation - 修正后的解释
 * @param {string} opts.correctionReason - 修正原因（如「发现属于 Mock 配置」）
 * @param {string[]} [opts.counterEvidenceIds] - 反证记录编号
 * @param {string[]} [opts.preservedObservationIds] - 保留的观察编号
 * @param {string} opts.actor
 */
export async function correctJudgement(pctx, opts) {
  const {
    projectId, subjectId, subjectKind,
    originalInterpretation, correctedInterpretation, correctionReason,
    counterEvidenceIds, preservedObservationIds, actor,
  } = opts;

  if (!projectId) throw apiError("BAD_REQUEST", "缺少 project_id");
  if (!subjectId) throw apiError("BAD_REQUEST", "缺少 subject_id");
  if (!subjectKind) throw apiError("BAD_REQUEST", "缺少 subject_kind");
  if (!correctionReason) throw apiError("BAD_REQUEST", "缺少 correction_reason");

  const store = await getStore(pctx);
  return store.runSerial((db) => {
    const commitSeq = allocateCommitSeq(db, projectId);
    const now = new Date().toISOString();
    const n = allocateSeq(db, projectId, "judgement_correction");
    const id = `JC-${projectId}-${pad4(n)}`;

    // 查找受影响的意图：basis_refs 或 prerequisite_refs 包含此判断
    const affectedIntents = findAffectedIntentsInDb(db, projectId, subjectId);

    db.prepare(
      `INSERT INTO judgement_corrections
         (id, project_id, subject_id, subject_kind,
          original_interpretation, corrected_interpretation, correction_reason,
          counter_evidence_ids_json, preserved_observation_ids_json,
          affected_intent_ids_json, corrected_by,
          created_at, created_by, created_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, projectId, subjectId, subjectKind,
      originalInterpretation || "", correctedInterpretation || "", correctionReason,
      JSON.stringify(counterEvidenceIds || []),
      JSON.stringify(preservedObservationIds || []),
      JSON.stringify(affectedIntents.map((i) => i.id)),
      actor || "system",
      now, actor || "system", commitSeq,
    );

    return {
      correction_id: id,
      subject_id: subjectId,
      subject_kind: subjectKind,
      affected_intents: affectedIntents,
      counter_evidence_count: (counterEvidenceIds || []).length,
      preserved_observation_count: (preservedObservationIds || []).length,
      created_seq: commitSeq,
      note: affectedIntents.length > 0
        ? `修正已记录；${affectedIntents.length} 个意图受影响（依赖此判断的待执行意图应重新校验，运行中意图在下一边界重查前提）`
        : "修正已记录；无意图直接依赖此判断",
    };
  });
}

/**
 * 在数据库内查找依赖某个判断的意图（§十二：用明确依赖筛选受影响任务）。
 *
 * 区分两种关系：
 * - basis_refs 包含此判断 → 「由此发现提出」的意图（调查假设）
 * - prerequisite_refs 包含此判断 → 「依赖此假设成立」的意图（依赖假设）
 *
 * §十二「不能因为共享一个资产，就把整个分支全部取消」——
 * 仅返回有明确 ref 依赖的意图，不扩展到共享资产。
 */
function findAffectedIntentsInDb(db, projectId, subjectId) {
  const intents = db.prepare(
    `SELECT id, question, status, basis_refs, prerequisite_refs
     FROM intents WHERE project_id = ?`,
  ).all(projectId);

  const affected = [];
  for (const intent of intents) {
    let basisRefs = [];
    let prereqRefs = [];
    try { basisRefs = JSON.parse(intent.basis_refs || "[]"); } catch {}
    try { prereqRefs = JSON.parse(intent.prerequisite_refs || "[]"); } catch {}

    const inBasis = basisRefs.some((ref) =>
      (typeof ref === "string" && ref === subjectId) ||
      (ref && typeof ref === "object" && ref.id === subjectId),
    );
    const inPrereq = prereqRefs.some((ref) =>
      (typeof ref === "string" && ref === subjectId) ||
      (ref && typeof ref === "object" && ref.id === subjectId) ||
      (ref && typeof ref === "object" && ref.ref === subjectId),
    );

    if (inBasis || inPrereq) {
      affected.push({
        id: intent.id,
        question: intent.question,
        status: intent.status,
        dependency_type: inPrereq ? "depends_on" : "investigates",
        note: inPrereq
          ? "此意图依赖该判断成立——待执行时应重新校验前提（§十二）"
          : "此意图由该发现提出——可在不确定性中推进，但需注意修正（§十二）",
      });
    }
  }
  return affected;
}

/**
 * 查找依赖某个判断的意图（公开接口）。
 */
export async function findAffectedIntents(pctx, { projectId, subjectId }) {
  if (!projectId || !subjectId) throw apiError("BAD_REQUEST", "缺少 project_id 或 subject_id");
  const store = await getStore(pctx);
  return { affected_intents: findAffectedIntentsInDb(store.db, projectId, subjectId) };
}

/**
 * 列出某个判断的修正历史。
 */
export async function listCorrections(pctx, { projectId, subjectId }) {
  if (!projectId) throw apiError("BAD_REQUEST", "缺少 project_id");
  const store = await getStore(pctx);
  const db = store.db;

  let where = "project_id = ?";
  const params = [projectId];
  if (subjectId) { where += " AND subject_id = ?"; params.push(subjectId); }

  const rows = db.prepare(
    `SELECT * FROM judgement_corrections WHERE ${where} ORDER BY created_seq`,
  ).all(...params);

  return {
    corrections: rows.map((r) => ({
      id: r.id,
      subject_id: r.subject_id,
      subject_kind: r.subject_kind,
      original_interpretation: r.original_interpretation,
      corrected_interpretation: r.corrected_interpretation,
      correction_reason: r.correction_reason,
      counter_evidence_ids: JSON.parse(r.counter_evidence_ids_json),
      preserved_observation_ids: JSON.parse(r.preserved_observation_ids_json),
      affected_intent_ids: JSON.parse(r.affected_intent_ids_json),
      corrected_by: r.corrected_by,
      created_at: r.created_at,
    })),
  };
}
