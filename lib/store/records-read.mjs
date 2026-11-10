/**
 * B1 —— 记录读取（§11.2 GET /records/{id}；蓝图端点 #14）。
 *
 * 合同落实：
 *   - 按编号读取记录与证据索引：每条视图内容可追到持久记录（§21 阶段 B 完成标准）；
 *   - 记录是数据库真值的只读投影，本模块不写任何业务表（§15.1：Map 是视图）；
 *   - 所有读取校验项目与对象访问权（§11.2）：记录必须属于指定项目，
 *     不存在与跨项目一律 404，不泄露其他项目的对象存在性；
 *   - 证据索引给出读取入口（capture → blob 哈希 → GET /evidence/blobs/{sha256}、
 *     GET /captures/{id}），不默认返回证据字节本身（§15.4：原始证据按需获取）。
 */
import { apiError } from "../errors.mjs";
import { getStore } from "./record-service.mjs";
import { toSemanticSubjectKind } from "./verification.mjs";

/**
 * 编号前缀 → 物理表（存在性定位；§6.1 程序分配稳定 ID）。
 * P0-2（蓝图 §2.3 后端段）：覆盖两族编号（全局族 PREFIX-nnnn 与项目内嵌族
 * PREFIX-PRJ-nnnn-nnnn）与 0004 迁移后的主要编号形态；新表随迁移同步登记。
 */
const PREFIX_TABLES = Object.freeze({
  A: "assets",
  ASM: "attempts", // 执行分配句柄（assignment_id；attempts 表）
  ATT: "attempts",
  B: "blobs",
  BMK: "reading_bookmarks", // 0007 迁移：阅读书签（阶段 2）
  BS: "branch_summaries",  // 0010 迁移：分支摘要（阶段 5）
  CAP: "captures",
  CG: "candidate_groups",
  CR: "check_records",     // 0009 迁移：检查记录（阶段 4）
  EB: "extraction_batches", // 0008 迁移：提取批次（阶段 3）
  EI: "extraction_items",   // 0008 迁移：提取条目（阶段 3）
  CP: "checkpoints",
  EM: "evidence_memberships",
  F: "facts",
  G: "goals",
  H: "hypotheses",
  I: "intents",
  JC: "judgement_corrections", // 0009 迁移：判断修正（阶段 4）
  M: "memberships",
  MRL: "material_read_logs", // 0007 迁移：材料读取范围日志（阶段 2）
  MSG: "messages", // 0005 迁移：用户消息（§2.6-2）
  O: "observations",
  OA: "orchestration_actions",
  OD: "orchestration_decisions",
  PR: "plan_runs",
  PRJ: "projects",
  R: "relations",
  RES: "resources",
  SH: "branch_shelving",   // 0011 迁移：分支搁置（阶段 6）
  SNAP: "snapshots",
  SR: "scope_revisions",
  SUBS: "subscriptions",
  T: "endpoint_templates",
  TC: "tool_calls",
  V: "vulnerabilities",
  VJ: "verification_jobs",
  VR: "verification_results",
  WR: "worker_reports",
});

/** RR 双表前缀（蓝图 §2.3）：两写点同名前缀（reportgen→report_revisions、
 *  orchestrator→report_receipts），按序探测、命中即返回；语义含混如实标注。 */
const RR_PREFIX_TABLES = Object.freeze(["report_revisions", "report_receipts"]);

/** 前缀无法识别时的兜底扫描表（覆盖后续模块可能引入的编号格式）。 */
const FALLBACK_TABLES = Object.freeze([
  "assets",
  "observations",
  "hypotheses",
  "facts",
  "vulnerabilities",
  "relations",
  "goals",
  "intents",
  "attempts",
  "captures",
  "blobs",
  "endpoint_templates",
  "worker_reports",
  "tool_calls",
  "verification_jobs",
  "verification_results",
  "evidence_manifests",
  "orchestration_decisions",
  "orchestration_actions",
  "plan_runs",
  "plan_revisions",
  "candidate_groups",
  "memberships",
  "resources",
  "subscriptions",
  "checkpoints",
  "report_revisions",
  "report_receipts",
  "messages",
  "reading_bookmarks",
  "material_read_logs",
  "extraction_batches",
  "extraction_items",
  "check_records",
  "judgement_corrections",
  "branch_summaries",
  "branch_shelving",
  "submissions",
]);

/** 两族编号同型（蓝图 §2.3）：全局族 PREFIX-nnnn 与项目内嵌族 PREFIX-PRJ-nnnn-nnnn。 */
const RECORD_SHAPE_RE = /^([A-Za-z]+)-(?:PRJ-\d{1,8}-)?(\d{1,8})$/;

/** 事件编号（不属 /records，定位一律 404 + 指向 /changes 的 hint）。 */
const EVENT_ID_RE = /^[Ee][Vv][Tt]-/;

/** 逐表按 (id, project_id) 定位（projects 表无 project_id 列，单独处理）。 */
export function locateRecord(db, projectId, ref) {
  if (typeof ref !== "string" || !ref) return null;
  const refTrimmed = ref.trim();
  if (EVENT_ID_RE.test(refTrimmed)) return null; // 事件编号不是持久记录
  const m = /^([A-Za-z]+)-/.exec(refTrimmed);
  if (m && RECORD_SHAPE_RE.test(refTrimmed)) {
    if (m[1] === "RR") {
      for (const table of RR_PREFIX_TABLES) {
        if (rowIn(db, table, refTrimmed, projectId)) {
          return { table, note: "RR 前缀跨两类记录（report_revisions / report_receipts），按存储定位" };
        }
      }
    } else {
      const table = PREFIX_TABLES[m[1]];
      if (table && rowIn(db, table, refTrimmed, projectId)) return { table };
    }
  }
  for (const table of FALLBACK_TABLES) {
    if (rowIn(db, table, refTrimmed, projectId)) return { table };
  }
  return null;
}

function rowIn(db, table, ref, projectId) {
  if (table === "projects") {
    return ref === projectId && Boolean(db.prepare("SELECT 1 FROM projects WHERE id = ?").get(ref));
  }
  return Boolean(
    db.prepare(`SELECT 1 FROM ${table} WHERE id = ? AND project_id = ?`).get(ref, projectId),
  );
}

function parseJsonField(text, fallback) {
  if (text === undefined || text === null || text === "") return fallback;
  try {
    const v = JSON.parse(text);
    return v === null || v === undefined ? fallback : v;
  } catch {
    return typeof fallback === "object" && fallback !== null ? { raw: String(text) } : fallback;
  }
}

/** 统一读取入口模板（§15.4 分层读取：编号与入口优先，字节按需获取）。 */
const READ_PATHS = Object.freeze({
  blob: "/sorne/evidence/blobs/{sha256}?project_id={pid}",
});

function relationEdges(db, projectId, recordId, limit = 50) {
  const edges = db
    .prepare(
      `SELECT id, from_id, to_id, relation_type, conditions, requires_state, source,
              valid_from_seq, retracted_at, created_at, created_by
         FROM relations
        WHERE project_id = ? AND (from_id = ? OR to_id = ?)
        ORDER BY valid_from_seq, rowid LIMIT ?`,
    )
    .all(projectId, recordId, recordId, limit + 1);
  const truncated = edges.length > limit;
  return {
    edges: edges.slice(0, limit).map((r) => ({
      id: r.id,
      from: r.from_id,
      to: r.to_id,
      relation_type: r.relation_type,
      conditions: r.conditions,
      requires_state: r.requires_state || undefined,
      source: r.source || undefined,
      valid_from_seq: r.valid_from_seq,
      retracted_at: r.retracted_at || null,
      created_at: r.created_at,
      created_by: r.created_by,
    })),
    truncated,
    note: truncated ? `仅列出前 ${limit} 条边；其余经编号在 /sorne/records/{id} 逐条展开` : undefined,
  };
}

/** Observation / 判断类对象共用的证据索引（§11.2「记录和证据索引」）。 */
function evidenceIndexForObservation(db, projectId, row) {
  const index = [];
  if (row.capture_id) {
    const cap = db
      .prepare("SELECT * FROM captures WHERE project_id = ? AND id = ?")
      .get(projectId, row.capture_id);
    if (cap) {
      let blob = null;
      if (cap.response_body_blob) {
        const b = db.prepare("SELECT * FROM blobs WHERE id = ?").get(cap.response_body_blob);
        if (b) {
          blob = {
            blob_id: b.id,
            sha256: b.sha256,
            byte_size: b.byte_size,
            representation: b.representation,
            storage_status: b.storage_status,
            read_path: `/sorne/evidence/blobs/${b.sha256}?project_id=${encodeURIComponent(projectId)}`,
          };
        }
      }
      index.push({
        kind: "capture",
        capture_id: cap.id,
        tool_call_id: cap.tool_call_id,
        method: cap.method,
        request_url_exact: cap.request_url_exact,
        observed_at: cap.observed_at,
        condition_snapshot_id: cap.condition_snapshot_id,
        integrity_status: cap.integrity_status,
        response_body_blob: blob,
        read_path: `/sorne/captures/${cap.id}`,
      });
    }
  }
  return index;
}

function evidenceIndexForJudgement(db, projectId, subjectId) {
  const members = db
    .prepare(
      `SELECT id, member_kind, member_id, stance, status
         FROM evidence_memberships
        WHERE project_id = ? AND subject_id = ?
        ORDER BY created_seq, rowid`,
    )
    .all(projectId, subjectId);
  return members.map((m) => ({
    kind: "evidence_membership",
    membership_id: m.id,
    member_kind: m.member_kind,
    member_id: m.member_id,
    stance: m.stance,
    status: m.status,
    read_path: `/sorne/records/${m.member_id}?project_id=${encodeURIComponent(projectId)}`,
  }));
}

/* ── 各表记录视图 ─────────────────────────────────────────────────── */

const VIEWS = {
  assets(db, projectId, row) {
    const counts = {
      resources: db
        .prepare("SELECT COUNT(*) AS c FROM resources WHERE project_id = ? AND asset_id = ?")
        .get(projectId, row.id).c,
      captures: db
        .prepare("SELECT COUNT(*) AS c FROM captures WHERE project_id = ? AND resource_id IN (SELECT id FROM resources WHERE project_id = ? AND asset_id = ?)")
        .get(projectId, projectId, row.id).c,
      observations: 0,
      vulnerabilities: db
        .prepare("SELECT COUNT(*) AS c FROM vulnerabilities WHERE project_id = ? AND asset_id = ?")
        .get(projectId, row.id).c,
      intents_targeting: 0,
    };
    counts.observations = db
      .prepare(
        `SELECT COUNT(*) AS c FROM observations WHERE project_id = ?
          AND EXISTS (SELECT 1 FROM relations r WHERE r.project_id = ? AND r.relation_type = 'targets'
                        AND r.from_id = observations.id AND r.to_id = ? AND r.retracted_at IS NULL)`,
      )
      .get(projectId, projectId, row.id).c;
    counts.intents_targeting = db
      .prepare(
        `SELECT COUNT(*) AS c FROM intents WHERE project_id = ?
          AND EXISTS (SELECT 1 FROM json_each(intents.target_asset_ids) WHERE json_each.value = ?)`,
      )
      .get(projectId, row.id).c;
    return {
      asset_type: row.asset_type,
      canonicalization_version: row.canonicalization_version,
      canonical_key: row.canonical_key,
      original_input: row.original_input,
      scope_status: row.scope_status,
      counts,
    };
  },
  observations(db, projectId, row) {
    return {
      capture_id: row.capture_id,
      anchor: parseJsonField(row.anchor, {}),
      statement: row.statement,
      conditions: parseJsonField(row.conditions, []),
    };
  },
  hypotheses(db, projectId, row) {
    return {
      statement: row.statement,
      conditions: parseJsonField(row.conditions, []),
      status: row.status,
      state_version: row.state_version,
      claim_revision: row.claim_revision,
      evidence_revision: row.evidence_revision,
      assessment_epoch: row.assessment_epoch,
      updated_seq: row.updated_seq,
    };
  },
  facts(db, projectId, row) {
    return {
      statement: row.statement,
      conditions: parseJsonField(row.conditions, []),
      status: row.status,
      verification_refs: parseJsonField(row.verification_refs, []),
      state_version: row.state_version,
      claim_revision: row.claim_revision,
      evidence_revision: row.evidence_revision,
      assessment_epoch: row.assessment_epoch,
      updated_seq: row.updated_seq,
    };
  },
  vulnerabilities(db, projectId, row) {
    return {
      asset_id: row.asset_id,
      location: row.location,
      category: row.category,
      status: row.status,
      review: row.review,
      impact: row.impact,
      conditions: parseJsonField(row.conditions, []),
      confirmed_version: row.confirmed_version,
      state_version: row.state_version,
      claim_revision: row.claim_revision,
      evidence_revision: row.evidence_revision,
      assessment_epoch: row.assessment_epoch,
      updated_seq: row.updated_seq,
    };
  },
  relations(db, projectId, row) {
    return {
      from: row.from_id,
      to: row.to_id,
      relation_type: row.relation_type,
      conditions: row.conditions,
      requires_state: row.requires_state || undefined,
      source: row.source || undefined,
      valid_from_seq: row.valid_from_seq,
      retracted_at: row.retracted_at || null,
    };
  },
  intents(db, projectId, row) {
    return {
      goal_id: row.goal_id,
      question: row.question,
      rationale: row.rationale,
      // §10.1 的 kind（collect/investigate/verify/revisit）以 intent_kind 暴露，
      // 避免覆盖信封的 record.kind（对象种类 = 物理表名）
      intent_kind: row.kind,
      target_asset_ids: parseJsonField(row.target_asset_ids, []),
      basis_refs: parseJsonField(row.basis_refs, []),
      prerequisite_refs: parseJsonField(row.prerequisite_refs, []),
      scope_revision: row.scope_revision,
      condition_requirements: parseJsonField(row.condition_requirements, []),
      success_criteria: row.success_criteria,
      deliverables: parseJsonField(row.deliverables, []),
      priority: row.priority,
      budget: parseJsonField(row.budget, {}),
      resume_conditions: parseJsonField(row.resume_conditions, []),
      status: row.status,
      runnable_at: row.runnable_at,
      state_version: row.state_version,
      plan_revision: row.plan_revision,
      updated_seq: row.updated_seq,
    };
  },
  goals(db, projectId, row) {
    return {
      parent_goal_id: row.parent_goal_id,
      statement: row.statement,
      status: row.status,
      constraint_refs: parseJsonField(row.constraint_refs, []),
      state_version: row.state_version,
    };
  },
  attempts(db, projectId, row) {
    return {
      intent_id: row.intent_id,
      assignment_id: row.assignment_id,
      worker_id: row.worker_id,
      fencing_token: row.fencing_token,
      lease_expires_at: row.lease_expires_at,
      status: row.status,
      recovery_note: row.recovery_note,
      state_version: row.state_version,
    };
  },
  captures(db, projectId, row) {
    // 紧凑视图 + 展开入口（§15.4 分层读取；详情由 A2 的 #44 端点提供）
    return {
      resource_id: row.resource_id,
      tool_call_id: row.tool_call_id,
      attempt_id: row.attempt_id,
      observed_at: row.observed_at,
      recorded_at: row.recorded_at,
      request_url_exact: row.request_url_exact,
      method: row.method,
      condition_snapshot_id: row.condition_snapshot_id,
      source_kind: row.source_kind,
      integrity_status: row.integrity_status,
      detail_path: `/sorne/captures/${row.id}`,
    };
  },
  blobs(db, projectId, row) {
    return {
      sha256: row.sha256,
      byte_size: row.byte_size,
      representation: row.representation,
      storage_status: row.storage_status,
      source_kind: row.source_kind,
      read_path: `/sorne/evidence/blobs/${row.sha256}?project_id=${encodeURIComponent(projectId)}`,
    };
  },
  scope_revisions(db, projectId, row) {
    return {
      revision: row.revision,
      rules: parseJsonField(row.rules, {}),
      summary: row.summary,
    };
  },
  endpoint_templates(db, projectId, row) {
    return {
      method: row.method,
      service_asset_id: row.service_asset_id,
      path_template: row.path_template,
      status: row.status,
      confidence: row.confidence,
      state_version: row.state_version,
    };
  },
  evidence_memberships(db, projectId, row) {
    return {
      subject_id: row.subject_id,
      member_kind: row.member_kind,
      member_id: row.member_id,
      stance: row.stance,
      status: row.status,
    };
  },
  snapshots(db, projectId, row) {
    return {
      kind: row.kind,
      scope: parseJsonField(row.scope, {}),
      snapshot_commit_seq: row.snapshot_commit_seq,
      schema_version: row.schema_version,
      folding_notes: parseJsonField(row.folding_notes, []),
      content_ref: row.content_ref,
    };
  },
  /* ── P0-2 扩展前缀的紧凑视图（蓝图 §2.3：kind/status/created_* + 关键引用） ── */
  worker_reports(db, projectId, row) {
    return {
      intent_id: row.intent_id,
      attempt_id: row.attempt_id,
      kind: row.kind,
      replaces_report_id: row.replaces_report_id || null,
      base_report_id: row.base_report_id || null,
      source_manifest_id: row.source_manifest_id || null,
      source_commit_boundary: row.source_commit_boundary || null,
      task_question: row.task_question,
      actual_outcome: row.actual_outcome,
      execution_status: row.execution_status,
      delivery_status: row.delivery_status,
      handling_status: row.handling_status,
      detail_path: `/sorne/worker-reports/${row.id}`,
    };
  },
  tool_calls(db, projectId, row) {
    return {
      attempt_id: row.attempt_id,
      tool_name: row.tool_name,
      args_digest: row.args_digest || null,
      status: row.status,
      started_at: row.started_at || null,
      ended_at: row.ended_at || null,
      evidence_refs: parseJsonField(row.evidence_refs, []),
      error: row.error || null,
    };
  },
  verification_jobs(db, projectId, row) {
    const semantic = toSemanticSubjectKind(row.subject_kind) || row.subject_kind;
    return {
      subject_id: row.subject_id,
      subject_kind: semantic, // P0-4：语义类型（历史表名值映射呈现）
      subject_table: semantic === row.subject_kind ? null : row.subject_kind,
      claim_revision: row.claim_revision,
      condition_snapshot_id: row.condition_snapshot_id || null,
      policy_id: row.policy_id,
      policy_version: row.policy_version,
      evidence_manifest_id: row.evidence_manifest_id || null,
      expected: {
        state_version: row.expected_state_version,
        evidence_revision: row.expected_evidence_revision,
        assessment_epoch: row.expected_assessment_epoch,
      },
      requested_by: row.requested_by,
      status: row.status,
    };
  },
  verification_results(db, projectId, row) {
    return {
      job_id: row.job_id,
      subject_id: row.subject_id,
      claim_revision: row.claim_revision,
      verifier_identity: row.verifier_identity,
      verifier_kind: row.verifier_kind,
      policy_version: row.policy_version,
      reviewed_manifest_id: row.reviewed_manifest_id,
      reviewed_evidence_revision: row.reviewed_evidence_revision,
      outcome: row.outcome,
      applied: Boolean(row.applied),
    };
  },
  evidence_manifests(db, projectId, row) {
    const semantic = toSemanticSubjectKind(row.subject_kind) || row.subject_kind;
    return {
      subject_id: row.subject_id,
      subject_kind: semantic,
      subject_table: semantic === row.subject_kind ? null : row.subject_kind,
      claim_revision: row.claim_revision,
      policy_version: row.policy_version,
      evidence_revision: row.evidence_revision,
      members_count: parseJsonField(row.members, []).length,
      content_hash: row.content_hash,
    };
  },
  orchestration_decisions(db, projectId, row) {
    return {
      input_report_ids: parseJsonField(row.input_report_ids, []),
      input_event_refs: parseJsonField(row.input_event_refs, []),
      rationale: row.rationale,
      tool_result: parseJsonField(row.tool_result, null),
    };
  },
  orchestration_actions(db, projectId, row) {
    return {
      decision_id: row.decision_id,
      action_kind: row.action_kind,
      idempotency_key: row.idempotency_key,
      payload: parseJsonField(row.payload, {}),
      status: row.status,
      result: parseJsonField(row.result, null),
      updated_seq: row.updated_seq,
    };
  },
  plan_runs(db, projectId, row) {
    return {
      input_snapshot_id: row.input_snapshot_id || null,
      input_boundary: row.input_boundary || null,
      status: row.status,
      updated_seq: row.updated_seq,
    };
  },
  plan_revisions(db, projectId, row) {
    return {
      run_id: row.run_id,
      status: row.status || null,
      plan_snapshot_id: row.plan_snapshot_id || null,
    };
  },
  checkpoints(db, projectId, row) {
    return {
      intent_id: row.intent_id || null,
      attempt_id: row.attempt_id || null,
      processed_boundary: row.processed_boundary || "",
      content: parseJsonField(row.content, {}),
    };
  },
  subscriptions(db, projectId, row) {
    return {
      consumer_id: row.consumer_id,
      focus: parseJsonField(row.focus, {}),
      status: row.status,
      subscription_revision: row.subscription_revision,
      last_cursor: row.last_cursor || "",
    };
  },
  candidate_groups(db, projectId, row) {
    return {
      group_key: row.group_key,
      status: row.status,
      state_version: row.state_version,
    };
  },
  memberships(db, projectId, row) {
    return {
      group_id: row.group_id,
      member_id: row.member_id,
      member_kind: row.member_kind,
    };
  },
  resources(db, projectId, row) {
    return {
      asset_id: row.asset_id,
      method: row.method,
      url_exact: row.url_exact,
      scheme: row.scheme,
      host: row.host,
      port: row.port,
      path_exact: row.path_exact,
      query_exact: row.query_exact || "",
      service_asset_id: row.service_asset_id || null,
    };
  },
  report_revisions(db, projectId, row) {
    return {
      report_kind: row.report_kind,
      subject_id: row.subject_id,
      version: row.version,
      content_ref: row.content_ref,
      data_boundary: parseJsonField(row.data_boundary, null),
      basis_refs: parseJsonField(row.basis_refs, []),
    };
  },
  report_receipts(db, projectId, row) {
    return {
      report_id: row.report_id,
      receipt_kind: row.receipt_kind,
      followup_ref: row.followup_ref || "",
      decision_id: row.decision_id || null,
    };
  },
  messages(db, projectId, row) {
    return {
      direction: row.direction,
      content: row.content,
      status: row.status,
      reply_to: row.reply_to || null,
      source_decision_id: row.source_decision_id || null,
      links_path: `/sorne/messages/${row.id}?project_id=${encodeURIComponent(projectId)}`,
    };
  },
  submissions(db, projectId, row) {
    return {
      submitter_id: row.submitter_id,
      submission_id: row.submission_id,
      request_digest: row.request_digest || null,
      status: row.status ?? null,
    };
  },
  // reading_bookmarks 故意不提供通用视图：书签是按角色/执行身份隔离的工作记忆，
  // 内容只经 lib/store/reading.mjs 的身份校验接口读取（阶段 2），不经 /records 泄露。
  material_read_logs(db, projectId, row) {
    return {
      role: row.role,
      actor_id: row.actor_id,
      intent_id: row.intent_id || null,
      attempt_id: row.attempt_id || null,
      tool_name: row.tool_name,
      target_id: row.target_id,
      target_kind: row.target_kind || null,
      blob_sha256: row.blob_sha256 || null,
      byte_offset: row.byte_offset ?? null,
      byte_length: row.byte_length ?? null,
      total_bytes: row.total_bytes ?? null,
      locator: parseJsonField(row.locator_json, {}),
    };
  },
  extraction_batches(db, projectId, row) {
    return {
      idempotency_key: row.idempotency_key,
      capture_id: row.capture_id || null,
      blob_id: row.blob_id || null,
      input_sha256: row.input_sha256,
      extractor_name: row.extractor_name,
      extractor_version: row.extractor_version,
      intent_id: row.intent_id || null,
      attempt_id: row.attempt_id || null,
      status: row.status,
      item_count: row.item_count,
      category_counts: parseJsonField(row.category_counts_json, {}),
      error_note: row.error_note || null,
    };
  },
  extraction_items(db, projectId, row) {
    return {
      batch_id: row.batch_id,
      item_index: row.item_index,
      category: row.category,
      value: row.value,
      source_locator: parseJsonField(row.source_locator_json, {}),
      confidence: row.confidence,
      metadata: parseJsonField(row.metadata_json, {}),
    };
  },
  check_records(db, projectId, row) {
    return {
      intent_id: row.intent_id,
      attempt_id: row.attempt_id || null,
      material_ids: parseJsonField(row.material_ids_json, []),
      material_range: parseJsonField(row.material_range_json, {}),
      check_method: row.check_method,
      findings_entry_ids: parseJsonField(row.findings_entry_ids_json, []),
      uncovered_parts: parseJsonField(row.uncovered_parts_json, []),
      applicable_conditions: parseJsonField(row.applicable_conditions_json, []),
      coverage_status: row.coverage_status,
      note: row.note || null,
    };
  },
  judgement_corrections(db, projectId, row) {
    return {
      subject_id: row.subject_id,
      subject_kind: row.subject_kind,
      original_interpretation: row.original_interpretation,
      corrected_interpretation: row.corrected_interpretation,
      correction_reason: row.correction_reason,
      counter_evidence_ids: parseJsonField(row.counter_evidence_ids_json, []),
      preserved_observation_ids: parseJsonField(row.preserved_observation_ids_json, []),
      affected_intent_ids: parseJsonField(row.affected_intent_ids_json, []),
      corrected_by: row.corrected_by,
    };
  },
  branch_summaries(db, projectId, row) {
    return {
      branch_id: row.branch_id,
      branch_kind: row.branch_kind,
      semantic_summary: row.semantic_summary,
      summary_refs: parseJsonField(row.summary_refs_json, []),
      covered_commit_seq: row.covered_commit_seq,
      refresh_status: row.refresh_status,
      incremental_prompt: row.incremental_prompt,
      sub_entries: parseJsonField(row.sub_entries_json, []),
    };
  },
  branch_shelving(db, projectId, row) {
    return {
      branch_id: row.branch_id,
      branch_kind: row.branch_kind,
      shelve_reason: row.shelve_reason,
      reason_detail: row.reason_detail,
      scope: row.scope,
      reconsider_conditions: parseJsonField(row.reconsider_conditions_json, []),
      wake_on_event_types: parseJsonField(row.wake_on_event_types_json, []),
      status: row.status,
      shelved_at: row.shelved_at,
      resumed_at: row.resumed_at,
    };
  },
};

/** 判断类表的证据索引选择。 */
const JUDGEMENT_EVIDENCE = new Set(["hypotheses", "facts", "vulnerabilities"]);

/**
 * GET /records/{id} 主体：按编号读取记录与证据索引（§11.2）。
 * 不存在 / 跨项目 → 404（不泄露存在性）。
 */
export async function getRecord(pctx, { projectId, id }) {
  if (typeof projectId !== "string" || !projectId) {
    throw apiError("BAD_REQUEST", "缺少 project_id（query 参数）");
  }
  if (typeof id !== "string" || !id.trim()) {
    throw apiError("BAD_REQUEST", "缺少记录编号");
  }
  const store = await getStore(pctx);
  const db = store.db;
  const project = db.prepare("SELECT id FROM projects WHERE id = ?").get(projectId);
  if (!project) {
    throw apiError("NOT_FOUND", `项目不存在：${projectId}`);
  }
  const located = locateRecord(db, projectId, id.trim());
  if (!located) {
    throw apiError("NOT_FOUND", `项目 ${projectId} 内不存在编号为 ${id} 的记录`, {
      detail: {
        id,
        hint: /^[Ee][Vv][Tt]-/.test(id.trim())
          ? "变化流事件（EVT-/evt-）不属持久记录，经 GET /sorne/changes 读取（B2）"
          : "核对编号（两族形态：PREFIX-nnnn / PREFIX-PRJ-nnnn-nnnn）；变化流事件（EVT-/evt-）经 GET /sorne/changes 读取",
      },
    });
  }
  const { table, note: locateNote } = located;
  // projects 表无 project_id 列，单独处理（编号即本项目）
  if (table === "projects") {
    const p = db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId);
    return {
      record: {
        id: p.id,
        kind: "projects",
        project_id: projectId,
        name: p.name,
        description: p.description,
        status: p.status,
        current_scope_revision: p.current_scope_revision,
        created_at: p.created_at,
        created_by: p.created_by,
        created_seq: p.created_seq,
        state_version: p.state_version,
      },
      evidence_index: [],
      relations: { edges: [], truncated: false },
      expand: {
        record_path: `/sorne/records/${p.id}?project_id=${encodeURIComponent(projectId)}`,
        evidence_bytes_path_template: READ_PATHS.blob,
        note: "原始证据字节按需读取；本端点只返回索引与编号（§15.4）",
      },
    };
  }
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ? AND project_id = ?`).get(id.trim(), projectId);
  const record = {
    id: row.id,
    kind: table,
    project_id: projectId,
    created_at: row.created_at,
    created_by: row.created_by,
    created_seq: row.created_seq,
  };
  const view = VIEWS[table];
  const fields = view
    ? view(db, projectId, row)
    : { note: `表 ${table} 无专用视图，仅返回编号与时间戳（后续模块可在 B1 注册视图）` };
  Object.assign(record, fields);

  let evidence_index = [];
  if (table === "observations") evidence_index = evidenceIndexForObservation(db, projectId, row);
  else if (JUDGEMENT_EVIDENCE.has(table)) evidence_index = evidenceIndexForJudgement(db, projectId, record.id);

  const rel = table === "relations" ? { edges: [], truncated: false } : relationEdges(db, projectId, record.id);
  return {
    record,
    evidence_index,
    relations: rel,
    ...(locateNote ? { note: locateNote } : {}),
    expand: {
      record_path: `/sorne/records/${record.id}?project_id=${encodeURIComponent(projectId)}`,
      evidence_bytes_path_template: READ_PATHS.blob,
      note: "原始证据字节按需读取；本端点只返回索引与编号（§15.4）",
    },
  };
}
