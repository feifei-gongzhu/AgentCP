/**
 * F1 —— 报告服务（规范 §19 报告与覆盖度）。
 *
 * 合同落实（§19 逐条）：
 *   - 漏洞报告自 suspected 起即可形成草稿：每个漏洞在首次读取报告视图时建立
 *     v1 草稿（report_revisions 行 + §5.2 reports/ 文件），状态、证据、条件和
 *     影响变化持续更新为新版本；
 *   - 确认后生成对应确认版本；被排除或争议时同步当前视图；历史版本全部保留
 *     且可按 version 读回（不覆盖、不删除）；
 *   - 报告至少包含：漏洞 ID、资产、状态与复核状态、判断条件、支持/反对证据、
 *     验证结论、限制、来源意图和后续意图；
 *   - 阶段报告（milestone）注明数据截止版本（snapshot_commit_seq）与时间
 *     （generated_at），包含已确认成果、未确认线索、已完成方向、受阻方向及
 *     未覆盖部分；生成后探索继续（§1/§20.3 场景 22：报告与确认均不结束项目）；
 *   - 覆盖度按资产/功能/测试方向/身份或条件记录完成情况，不简化成「资产挂过
 *     一个 Fact 就已测」；已执行过某方向不代表该资产没有其他漏洞；
 *   - 任何漏洞/事实都能四向追溯：来源（discovered_from/derived_from 边）、
 *     执行（produced_by 边与证据采集归因的 Attempt 及工具调用）、证据
 *     （证据集成员 + 采集/Blob 身份）、后续方向（basis/prerequisite 引用、
 *     requires 边、验证建议）（§21 阶段 F 完成标准）。
 *
 * 实现边界（§3.2：程序只做规范交给程序的校验与保障）：
 *   - 报告是**派生资料**（§15.1 同源原则）：从结构化记录确定性生成，不产生
 *     业务提交、不消耗项目 commit_seq、不发 Outbox 事件（蓝图 §6 目录无
 *     report.* 类型；B1 快照先例）。行 created_seq 取生成依据的数据截止边界；
 *   - 版本同步以「报告相关指纹」判定：仅当该漏洞自身报告相关内容（状态/复核/
 *     条件/影响/证据集/验证结论/来源与后续引用）变化时才切新版本——其他对象
 *     的提交不产生本报告的新版本（§20.3 场景 10 的报告面同义保障）；
 *   - 程序不推断未建立的来源关系：无来源边时如实标注「未链接」并展示持久
 *     溯源字段（created_by/created_seq），不编造来源意图；
 *   - 写入顺序（§13 同法）：先在一致读视图内取内容 → 原子写文件 → runSerial
 *     落 report_revisions 行；文件先行保证库行不引用未固定文件，插入失败留下
 *     的孤立文件由下次同步以同版本号回收（视图可完全重建）。
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { apiError } from "../errors.mjs";
import { getStore } from "./record-service.mjs";
import { projectDir, safeSegment } from "./layout.mjs";

export const REPORT_SCHEMA_VERSION = 1;

/* 折叠上限（§15.1 同源：折叠保留计数与入口，不静默截断） */
const MAX_INLINE_EVIDENCE = 64;
const MAX_INLINE_FINDINGS = 100;
const MAX_INLINE_ASSETS = 100;
const MAX_INTENTS_INLINE = 60;
const MAX_HISTORY_INLINE = 100;

const SOURCE_RELATION_TYPES = ["discovered_from", "derived_from"];
const UNCONFIRMED_VULN_STATUSES = ["suspected", "inconclusive"];
const OPEN_HYPOTHESIS_STATUSES = ["open", "testing", "inconclusive"];
const BLOCKED_INTENT_STATUSES = ["blocked", "deferred", "obsolete"];
const ONGOING_INTENT_STATUSES = ["proposed", "queued", "running", "awaiting_review"];

/* ── 基础工具 ─────────────────────────────────────────────────────── */

function sha256Hex(text) {
  return createHash("sha256").update(text).digest("hex");
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

function parseJson(text, fallback) {
  if (text === undefined || text === null || text === "") return fallback;
  try {
    const v = JSON.parse(text);
    return v === null || v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

/**
 * 一致读视图（§15.1 同法）：同步读事务内完成全部内容查询，
 * 事务体完全同步，与 runSerial 写队列无交错。
 */
function readView(store, fn) {
  store.db.exec("BEGIN");
  try {
    const out = fn(store.db);
    store.db.exec("COMMIT");
    return out;
  } catch (error) {
    try {
      store.db.exec("ROLLBACK");
    } catch {
      /* 连接异常由句柄兜底 */
    }
    throw error;
  }
}

/** 数据截止版本：当前一致视图内最后已分配的项目 commit_seq。 */
function currentCommitSeq(db, projectId) {
  const row = db.prepare("SELECT next_commit_seq AS n FROM projects WHERE id = ?").get(projectId);
  return row ? Math.max(0, row.n - 1) : 0;
}

function allocateSeq(db, projectId, kind) {
  db.prepare(
    "INSERT INTO id_sequences (project_id, kind, next_val) VALUES (?, ?, 2) ON CONFLICT DO NOTHING",
  ).run(projectId, kind);
  const row = db
    .prepare("SELECT next_val AS n FROM id_sequences WHERE project_id = ? AND kind = ?")
    .get(projectId, kind);
  db.prepare("UPDATE id_sequences SET next_val = ? WHERE project_id = ? AND kind = ?").run(
    row.n + 1,
    projectId,
    kind,
  );
  return row.n;
}

function pad4(n) {
  return String(n).padStart(4, "0");
}

function writeAtomic(filePath, text) {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, filePath);
}

function absFromRef(dataDir, contentRef) {
  return resolve(dataDir, contentRef);
}

/* ── 报告版本行（report_revisions） ───────────────────────────────── */

function latestRevisionRow(db, projectId, reportKind, subjectId) {
  return db
    .prepare(
      `SELECT * FROM report_revisions
         WHERE project_id = ? AND report_kind = ? AND subject_id = ?
         ORDER BY CAST(version AS INTEGER) DESC, rowid DESC LIMIT 1`,
    )
    .get(projectId, reportKind, subjectId);
}

function revisionHistoryRows(db, projectId, reportKind, subjectId) {
  return db
    .prepare(
      `SELECT * FROM report_revisions
         WHERE project_id = ? AND report_kind = ? AND subject_id = ?
         ORDER BY CAST(version AS INTEGER), rowid`,
    )
    .all(projectId, reportKind, subjectId);
}

function nextVersionNumber(rows) {
  let max = 0;
  for (const r of rows) {
    const n = Number.parseInt(String(r.version).replace(/^v/i, ""), 10);
    if (Number.isInteger(n) && n > max) max = n;
  }
  return max + 1;
}

/** 读回已持久化的报告内容文件；缺失/损坏返回 null（视图可重建，调用方据此切新版本）。 */
function readStoredContent(dataDir, row) {
  try {
    const text = readFileSync(absFromRef(dataDir, row.content_ref), "utf8");
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** 报告相关指纹：剔除 data_boundary 与 version_record（记录性字段，不参与变化判定）。 */
export function reportFingerprint(content) {
  const { data_boundary, version_record, ...rest } = content || {};
  return sha256Hex(canonicalJson(rest));
}

/** 顶层差异（供新版本的 changed_fields 说明；键路径一层）。 */
function topLevelDiff(oldContent, newContent) {
  const oldKeys = new Set(Object.keys(oldContent || {}));
  const changed = [];
  for (const key of Object.keys(newContent || {})) {
    if (key === "data_boundary" || key === "version_record") continue;
    if (!oldKeys.has(key)) {
      changed.push(`+${key}`);
    } else if (canonicalJson(oldContent[key]) !== canonicalJson(newContent[key])) {
      changed.push(key);
    }
  }
  return changed.length ? changed : ["regenerated"];
}

function isUniqueViolation(error) {
  return Boolean(
    error &&
    /UNIQUE constraint failed/i.test(String(error.message || error)),
  );
}

/* ── 记录视图辅助（只读，确定性） ─────────────────────────────────── */

function assetBrief(db, projectId, assetId) {
  if (!assetId) return null;
  const row = db
    .prepare("SELECT * FROM assets WHERE project_id = ? AND id = ?")
    .get(projectId, assetId);
  if (!row) return { id: assetId, missing: true };
  return {
    id: row.id,
    asset_type: row.asset_type,
    canonicalization_version: row.canonicalization_version,
    canonical_key: row.canonical_key,
    original_input: row.original_input,
    scope_status: row.scope_status,
  };
}

function blobBrief(db, projectId, blobId) {
  if (!blobId) return null;
  const row = db
    .prepare("SELECT * FROM blobs WHERE project_id = ? AND id = ?")
    .get(projectId, blobId);
  if (!row) return { id: blobId, missing: true };
  return {
    id: row.id,
    sha256: row.sha256,
    byte_size: row.byte_size,
    representation: row.representation,
    storage_status: row.storage_status,
  };
}

function captureBrief(db, projectId, captureId) {
  if (!captureId) return null;
  const row = db
    .prepare("SELECT * FROM captures WHERE project_id = ? AND id = ?")
    .get(projectId, captureId);
  if (!row) return { id: captureId, missing: true };
  return {
    id: row.id,
    tool_call_id: row.tool_call_id,
    attempt_id: row.attempt_id,
    request_url_exact: row.request_url_exact,
    method: row.method,
    condition_snapshot_id: row.condition_snapshot_id,
    integrity_status: row.integrity_status,
    response_body_blob: blobBrief(db, projectId, row.response_body_blob),
  };
}

function evidenceMemberView(db, projectId, member) {
  const base = {
    member_kind: member.member_kind,
    member_id: member.member_id,
    stance: member.stance,
    membership_status: member.status,
  };
  if (member.member_kind === "observations") {
    const row = db
      .prepare("SELECT * FROM observations WHERE project_id = ? AND id = ?")
      .get(projectId, member.member_id);
    if (row) {
      base.statement = row.statement;
      base.conditions = parseJson(row.conditions, []);
      base.capture = captureBrief(db, projectId, row.capture_id);
    }
  } else if (member.member_kind === "captures") {
    base.capture = captureBrief(db, projectId, member.member_id);
  } else if (member.member_kind === "blobs") {
    base.blob = blobBrief(db, projectId, member.member_id);
  } else if (
    member.member_kind === "hypotheses" ||
    member.member_kind === "facts" ||
    member.member_kind === "vulnerabilities"
  ) {
    const row = db
      .prepare(`SELECT statement, status FROM ${member.member_kind} WHERE project_id = ? AND id = ?`)
      .get(projectId, member.member_id);
    if (row) {
      base.statement = row.statement;
      base.subject_status = row.status;
    }
  }
  return base;
}

function toolCallSummary(db, projectId, attemptId) {
  const rows = db
    .prepare("SELECT status, COUNT(*) AS c FROM tool_calls WHERE project_id = ? AND attempt_id = ? GROUP BY status")
    .all(projectId, attemptId);
  const byStatus = {};
  let total = 0;
  for (const r of rows) {
    byStatus[r.status] = r.c;
    total += r.c;
  }
  return { total, by_status: byStatus };
}

function attemptBrief(db, projectId, attemptId) {
  const row = db
    .prepare("SELECT * FROM attempts WHERE project_id = ? AND id = ?")
    .get(projectId, attemptId);
  if (!row) return { id: attemptId, missing: true };
  return {
    id: row.id,
    intent_id: row.intent_id,
    worker_id: row.worker_id,
    status: row.status,
    tool_calls: toolCallSummary(db, projectId, row.id),
  };
}

/** 引用某判断对象的意图扫描（basis_refs / prerequisite_refs JSON 数组成员）。 */
function intentsReferencing(db, projectId, subjectId) {
  const rows = db
    .prepare(
      `SELECT id, question, kind, status, basis_refs, prerequisite_refs FROM intents
         WHERE project_id = ? AND (basis_refs LIKE ? OR prerequisite_refs LIKE ?)
         ORDER BY created_seq, id`,
    )
    .all(projectId, `%"${subjectId}"%`, `%"${subjectId}"%`);
  const out = [];
  for (const row of rows) {
    const via = [];
    if (parseJson(row.basis_refs, []).includes(subjectId)) via.push("basis_refs");
    if (parseJson(row.prerequisite_refs, []).includes(subjectId)) via.push("prerequisite_refs");
    if (!via.length) continue; // LIKE 命中但 JSON 不含（如子串），不虚报
    out.push({ intent_id: row.id, question: row.question, kind: row.kind, status: row.status, via });
  }
  return out;
}

/** requires 边上的下游依赖（to=subject；含撤回标记，历史保留）。 */
function requiresDependents(db, projectId, subjectId) {
  return db
    .prepare(
      `SELECT id, from_id, requires_state, retracted_at FROM relations
         WHERE project_id = ? AND to_id = ? AND relation_type = 'requires'
         ORDER BY created_seq, id`,
    )
    .all(projectId, subjectId)
    .map((r) => ({
      relation_id: r.id,
      dependent: r.from_id,
      requires_state: r.requires_state,
      retracted_at: r.retracted_at || null,
    }));
}

/**
 * 四向追溯（§21 F：来源/执行/证据/后续方向）。适用于任何判断类对象
 * （vulnerabilities / facts / hypotheses）；报告内容由此拼装，不推断未建立的边。
 */
export function buildSubjectTrace(db, { projectId, subjectId }) {
  // 来源：discovered_from / derived_from（from=subject → 来源对象）
  const originEdges = db
    .prepare(
      `SELECT id, to_id, relation_type, retracted_at FROM relations
         WHERE project_id = ? AND from_id = ? AND relation_type IN (${SOURCE_RELATION_TYPES.map(() => "?").join(",")})
         ORDER BY created_seq, id`,
    )
    .all(projectId, subjectId, ...SOURCE_RELATION_TYPES)
    .map((r) => ({
      relation_id: r.id,
      ref: r.to_id,
      relation_type: r.relation_type,
      retracted_at: r.retracted_at || null,
    }));
  const originIntentRows = originEdges
    .filter((e) => db.prepare("SELECT 1 FROM intents WHERE project_id = ? AND id = ?").get(projectId, e.ref))
    .map((e) => ({ intent_id: e.ref, relation_id: e.relation_id, via: e.relation_type }));

  // 证据：证据集成员（含 withdrawn/disputed，历史保留）+ supports/contradicts 边
  const members = db
    .prepare(
      `SELECT member_kind, member_id, stance, status FROM evidence_memberships
         WHERE project_id = ? AND subject_id = ? ORDER BY created_seq, id`,
    )
    .all(projectId, subjectId);
  const evidenceEdges = db
    .prepare(
      `SELECT id, from_id, relation_type, retracted_at FROM relations
         WHERE project_id = ? AND to_id = ? AND relation_type IN ('supports','contradicts')
         ORDER BY created_seq, id`,
    )
    .all(projectId, subjectId)
    .map((r) => ({
      relation_id: r.id,
      ref: r.from_id,
      stance: r.relation_type === "supports" ? "supports" : "contradicts",
      retracted_at: r.retracted_at || null,
    }));

  // 执行：证据观察的采集归因 Attempt + produced_by 边（不推断）
  const attemptIds = new Set();
  for (const m of members) {
    if (m.member_kind !== "observations") continue;
    const obs = db
      .prepare("SELECT capture_id FROM observations WHERE project_id = ? AND id = ?")
      .get(projectId, m.member_id);
    if (!obs || !obs.capture_id) continue;
    const cap = db
      .prepare("SELECT attempt_id FROM captures WHERE project_id = ? AND id = ?")
      .get(projectId, obs.capture_id);
    if (cap && cap.attempt_id) attemptIds.add(cap.attempt_id);
  }
  const producedBy = db
    .prepare(
      `SELECT to_id, retracted_at FROM relations
         WHERE project_id = ? AND from_id = ? AND relation_type = 'produced_by'
         ORDER BY created_seq, id`,
    )
    .all(projectId, subjectId)
    .map((r) => ({ ref: r.to_id, retracted_at: r.retracted_at || null }));
  const producedByResolved = [];
  for (const edge of producedBy) {
    const att = db
      .prepare("SELECT id FROM attempts WHERE project_id = ? AND id = ?")
      .get(projectId, edge.ref);
    if (att) {
      attemptIds.add(edge.ref);
      producedByResolved.push(edge.ref);
    }
  }

  // 后续方向：引用该对象的意图 + requires 下游 + 验证建议
  const followUpIntents = intentsReferencing(db, projectId, subjectId);
  const dependents = requiresDependents(db, projectId, subjectId);

  return {
    origin: {
      edges: originEdges,
      source_intents: originIntentRows,
      provenance_note:
        originEdges.length === 0
          ? "该对象无 discovered_from/derived_from 来源边：程序不推断来源，仅如实记录持久溯源字段（created_by/created_seq）；需要血缘时由执行侧经 add_relation 建立"
          : null,
    },
    execution: {
      attempts: [...attemptIds].sort().map((id) => attemptBrief(db, projectId, id)),
      produced_by_edges: producedBy,
      note: "执行归因来自证据采集的 attempt_id 与 produced_by 边；无归因时不虚构执行过程",
    },
    evidence: {
      members: members.map((m) => evidenceMemberView(db, projectId, m)),
      relations: evidenceEdges,
      counts: {
        members: members.length,
        active_supports: members.filter((m) => m.status === "active" && m.stance === "supports").length,
        active_contradicts: members.filter((m) => m.status === "active" && m.stance === "contradicts").length,
        withdrawn_or_disputed: members.filter((m) => m.status !== "active").length,
      },
      read_entry: "原始证据字节经 GET /sorne/evidence/blobs/{sha256} 与 GET /sorne/captures/{id} 读取（#43/#44）",
    },
    follow_ups: {
      intents: followUpIntents,
      requires_dependents: dependents,
      note: "后续方向来自以该对象为依据/前提的意图、requires 下游边与验证建议；已 resolved 的方向不代表对象测透（§19）",
    },
  };
}

function verificationSection(db, { projectId, subjectId }) {
  const results = db
    .prepare(
      `SELECT * FROM verification_results WHERE project_id = ? AND subject_id = ?
         ORDER BY created_seq, rowid`,
    )
    .all(projectId, subjectId)
    .map((r) => ({
      id: r.id,
      job_id: r.job_id,
      outcome: r.outcome,
      applied: Boolean(r.applied),
      verifier_identity: r.verifier_identity,
      verifier_kind: r.verifier_kind,
      policy_version: r.policy_version,
      reviewed_manifest_id: r.reviewed_manifest_id,
      reviewed_evidence_revision: r.reviewed_evidence_revision,
      limitations: r.limitations,
      suggested_followups: parseJson(r.suggested_followups, []),
      created_at: r.created_at,
    }));
  const pendingJobs = db
    .prepare(
      `SELECT id, status, policy_id, policy_version, created_at FROM verification_jobs
         WHERE project_id = ? AND subject_id = ? AND status IN ('pending','in_progress')
         ORDER BY created_seq, id`,
    )
    .all(projectId, subjectId);
  return { results, pending_jobs: pendingJobs };
}

/* ── 漏洞报告内容（§19 必备字段全量） ─────────────────────────────── */

/**
 * 构建单个漏洞的报告内容（纯读、同步；内容即该版本的全部语义）。
 * 指纹相关字段 = 除 data_boundary/version_record 外的全部键。
 */
export function buildVulnerabilityReportContent(db, { projectId, vuln, generatedAt }) {
  const boundary = currentCommitSeq(db, projectId);
  const trace = buildSubjectTrace(db, { projectId, subjectId: vuln.id });
  const verification = verificationSection(db, { projectId, subjectId: vuln.id });
  const conditions = parseJson(vuln.conditions, []);

  const activeMembers = trace.evidence.members.filter((m) => m.membership_status === "active");
  const supporting = activeMembers.filter((m) => m.stance === "supports");
  const opposing = activeMembers.filter((m) => m.stance === "contradicts");
  const otherMembers = activeMembers.filter((m) => m.stance !== "supports" && m.stance !== "contradicts");
  const historicalMembers = trace.evidence.members.filter((m) => m.membership_status !== "active");

  const limitations = [];
  const latestResult = verification.results[verification.results.length - 1] || null;
  if (latestResult && latestResult.limitations) limitations.push(latestResult.limitations);
  for (const job of verification.pending_jobs) {
    limitations.push(`存在${job.status === "pending" ? "待处理" : "进行中"}的验证任务 ${job.id}（策略 ${job.policy_id}@${job.policy_version}）：结论可能随验证推进变化`);
  }
  if (!verification.results.length) {
    limitations.push("尚无验证结论记录：当前报告只承载发现侧证据（§8.3），未经独立验证的判断不构成确认（§2.6）");
  }
  if (vuln.status === "suspected") {
    limitations.push("疑似阶段：尚未经独立验证，不得作为已确认前提引用或写入事实（§8.1/§8.2）");
  }
  if (vuln.status === "confirmed") {
    limitations.push("confirmed 只说明在指定条件下得到确认，不代表持续存在（§8.2）；条件变化后应要求复核");
  }
  if (vuln.status === "falsified") {
    limitations.push("被排除不等于历史上不存在（§8.4）；重新调查需新证据推进评估代际后开启新一轮验证");
  }
  if (vuln.status === "inconclusive") {
    limitations.push("证据不足时为 inconclusive，不伪装成已排除（§8.4）");
  }
  if (!conditions.length) {
    limitations.push("判断未注明适用条件（身份/参数/环境条件缺失，§8.1）：结论不可推广到未声明的条件");
  }
  if (vuln.review !== "clear") {
    limitations.push(`复核状态为 ${vuln.review}：依赖该判断执行的任务必须检查有效性与复核标记，不能只看状态字符串（§8.2）`);
  }

  return {
    report_kind: "vulnerability",
    schema_version: REPORT_SCHEMA_VERSION,
    subject: {
      id: vuln.id,
      project_id: projectId,
      asset: assetBrief(db, projectId, vuln.asset_id),
      location: vuln.location,
      category: vuln.category,
      status: vuln.status,
      review: vuln.review,
      impact: vuln.impact,
      conditions,
      confirmed_version: parseJson(vuln.confirmed_version, null),
      state_version: vuln.state_version,
      claim_revision: vuln.claim_revision,
      evidence_revision: vuln.evidence_revision,
      assessment_epoch: vuln.assessment_epoch,
      created_at: vuln.created_at,
      created_by: vuln.created_by,
      created_seq: vuln.created_seq,
      updated_seq: vuln.updated_seq,
    },
    supporting_evidence: supporting.slice(0, MAX_INLINE_EVIDENCE),
    opposing_evidence: opposing.slice(0, MAX_INLINE_EVIDENCE),
    other_evidence_members: otherMembers.slice(0, MAX_INLINE_EVIDENCE),
    historical_evidence_members: historicalMembers.slice(0, MAX_INLINE_EVIDENCE),
    evidence_counts: {
      supporting: supporting.length,
      opposing: opposing.length,
      other_active: otherMembers.length,
      withdrawn_or_disputed: historicalMembers.length,
      evidence_revision: vuln.evidence_revision,
      inline_limit: MAX_INLINE_EVIDENCE,
      folded:
        supporting.length + opposing.length + otherMembers.length + historicalMembers.length >
        MAX_INLINE_EVIDENCE * 4
          ? "证据成员超出内联上限，仅呈现各组前若干条；完整成员经 GET /sorne/records/{id} 与台账读取（不静默截断）"
          : null,
    },
    verification_conclusions: verification,
    limitations,
    source_intents: trace.origin.source_intents,
    follow_up_intents: trace.follow_ups.intents,
    trace,
    data_boundary: {
      snapshot_commit_seq: boundary,
      generated_at: generatedAt,
      note: "数据截止到该提交边界；边界之后的提交由下一次报告版本承载（报告是持续探索的产物，§19）",
    },
  };
}

/* ── 阶段报告内容（§19 五块 + 覆盖度） ────────────────────────────── */

function coverageRecords(db, projectId) {
  const assets = db
    .prepare("SELECT * FROM assets WHERE project_id = ? ORDER BY created_seq, id")
    .all(projectId);
  const intentsAll = db
    .prepare("SELECT id, kind, status, target_asset_ids, condition_requirements FROM intents WHERE project_id = ?")
    .all(projectId);
  const intentsByAsset = new Map();
  for (const it of intentsAll) {
    for (const assetId of parseJson(it.target_asset_ids, [])) {
      if (!intentsByAsset.has(assetId)) intentsByAsset.set(assetId, []);
      intentsByAsset.get(assetId).push(it);
    }
  }
  const observationsByAsset = new Map();
  const conditionsByAsset = new Map();
  const obsRows = db
    .prepare(
      `SELECT o.id, o.conditions, c.resource_id FROM observations o
         LEFT JOIN captures c ON c.id = o.capture_id AND c.project_id = o.project_id
         WHERE o.project_id = ?`,
    )
    .all(projectId);
  const resourceToAsset = new Map(
    db
      .prepare("SELECT id, asset_id FROM resources WHERE project_id = ?")
      .all(projectId)
      .map((r) => [r.id, r.asset_id]),
  );
  const capturesByAsset = new Map();
  for (const cap of db
    .prepare("SELECT id, resource_id FROM captures WHERE project_id = ?")
    .all(projectId)) {
    const assetId = cap.resource_id ? resourceToAsset.get(cap.resource_id) : null;
    if (assetId) capturesByAsset.set(assetId, (capturesByAsset.get(assetId) || 0) + 1);
  }
  for (const obs of obsRows) {
    const assetId = obs.resource_id ? resourceToAsset.get(obs.resource_id) : null;
    if (!assetId) continue;
    observationsByAsset.set(assetId, (observationsByAsset.get(assetId) || 0) + 1);
    const conds = conditionsByAsset.get(assetId) || new Set();
    for (const c of parseJson(obs.conditions, [])) {
      if (typeof c === "string" && c.trim()) conds.add(c);
    }
    conditionsByAsset.set(assetId, conds);
  }
  const vulnsByAsset = new Map();
  for (const v of db
    .prepare("SELECT id, asset_id, status FROM vulnerabilities WHERE project_id = ?")
    .all(projectId)) {
    if (!v.asset_id) continue;
    if (!vulnsByAsset.has(v.asset_id)) vulnsByAsset.set(v.asset_id, { suspected: 0, confirmed: 0, falsified: 0, inconclusive: 0 });
    const bucket = vulnsByAsset.get(v.asset_id);
    if (bucket[v.status] !== undefined) bucket[v.status] += 1;
  }
  // 事实不归属资产（facts 无资产列）：按资产维度的发现记录只统计漏洞，
  // 事实以全项目清单呈现并各自携带四向追溯（不推断归属，§3.2）。

  const records = assets.map((asset) => {
    const directed = intentsByAsset.get(asset.id) || [];
    const directions = {};
    for (const kind of ["collect", "investigate", "verify", "revisit"]) {
      const rows = directed.filter((i) => i.kind === kind);
      directions[kind] = {
        total: rows.length,
        resolved: rows.filter((i) => i.status === "resolved").length,
        blocked: rows.filter((i) => ["blocked", "deferred", "obsolete"].includes(i.status)).length,
        ongoing: rows.filter((i) => ONGOING_INTENT_STATUSES.includes(i.status)).length,
        cancelled: rows.filter((i) => i.status === "cancelled").length,
      };
    }
    const intentConditions = new Set();
    for (const it of directed) {
      for (const c of parseJson(it.condition_requirements, [])) {
        const text = typeof c === "string" ? c : c && typeof c === "object" ? c.description || c.condition || JSON.stringify(c) : null;
        if (text && String(text).trim()) intentConditions.add(String(text));
      }
    }
    const observedConditions = conditionsByAsset.get(asset.id) || new Set();
    return {
      asset: {
        id: asset.id,
        asset_type: asset.asset_type,
        canonical_key: asset.canonical_key,
        original_input: asset.original_input,
        scope_status: asset.scope_status,
      },
      directions,
      intents_directed: directed.length,
      observations: observationsByAsset.get(asset.id) || 0,
      captures: capturesByAsset.get(asset.id) || 0,
      identity_conditions: {
        from_intents: [...intentConditions].sort(),
        observed_in_captures: [...observedConditions].sort(),
        note: "身份/条件记录的是已执行意图声明的条件要求与采集观察中实际出现的条件，不是覆盖声明（§19）",
      },
      findings: {
        vulnerabilities: vulnsByAsset.get(asset.id) || { suspected: 0, confirmed: 0, falsified: 0, inconclusive: 0 },
      },
      uncovered_flags: {
        no_direction: directed.length === 0,
        no_capture: (capturesByAsset.get(asset.id) || 0) === 0,
      },
    };
  });
  return {
    records: records.slice(0, MAX_INLINE_ASSETS),
    total_assets: assets.length,
    has_more: records.length > MAX_INLINE_ASSETS,
    folded_note:
      records.length > MAX_INLINE_ASSETS
        ? `资产数 ${records.length} 超出内联上限 ${MAX_INLINE_ASSETS}，仅呈现前 ${MAX_INLINE_ASSETS} 条；其余按编号经 GET /sorne/records/{id} 读取（不静默截断）`
        : null,
    coverage_note:
      "覆盖度按资产/方向/身份条件记录完成情况；已执行过某个方向不代表该资产没有其他漏洞，资产挂过一个 Fact 更不等于已测（§19）",
  };
}

export function buildMilestoneReportContent(db, { projectId, generatedAt }) {
  const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId);
  const boundary = currentCommitSeq(db, projectId);

  const confirmedVulns = db
    .prepare(
      `SELECT * FROM vulnerabilities WHERE project_id = ? AND status = 'confirmed' ORDER BY created_seq, id`,
    )
    .all(projectId)
    .map((v) => ({
      id: v.id,
      category: v.category,
      asset_id: v.asset_id,
      location: v.location,
      conditions: parseJson(v.conditions, []),
      review: v.review,
      confirmed_version: parseJson(v.confirmed_version, null),
      evidence_revision: v.evidence_revision,
      report_entry: `GET /sorne/reports/vulnerabilities?id=${v.id}`,
    }));
  const unconfirmedVulns = db
    .prepare(
      `SELECT * FROM vulnerabilities WHERE project_id = ? AND status IN (${UNCONFIRMED_VULN_STATUSES.map(() => "?").join(",")})
         ORDER BY created_seq, id`,
    )
    .all(projectId, ...UNCONFIRMED_VULN_STATUSES)
    .map((v) => ({
      id: v.id,
      category: v.category,
      asset_id: v.asset_id,
      status: v.status,
      review: v.review,
      conditions: parseJson(v.conditions, []),
      report_entry: `GET /sorne/reports/vulnerabilities?id=${v.id}`,
    }));

  const facts = db
    .prepare("SELECT * FROM facts WHERE project_id = ? ORDER BY created_seq, id")
    .all(projectId)
    .map((f) => ({
      id: f.id,
      statement: f.statement,
      status: f.status,
      conditions: parseJson(f.conditions, []),
      verification_refs: parseJson(f.verification_refs, []),
      trace: buildSubjectTrace(db, { projectId, subjectId: f.id }),
    }));
  const verifiedFacts = facts.filter((f) => f.status === "verified");
  const changedFacts = facts.filter((f) => f.status !== "verified");

  const hypotheses = db
    .prepare(
      `SELECT id, statement, status FROM hypotheses WHERE project_id = ? AND status IN (${OPEN_HYPOTHESIS_STATUSES.map(() => "?").join(",")})
         ORDER BY created_seq, id`,
    )
    .all(projectId, ...OPEN_HYPOTHESIS_STATUSES);

  const pendingJobs = db
    .prepare(
      `SELECT id, subject_id, subject_kind, status, created_at FROM verification_jobs
         WHERE project_id = ? AND status IN ('pending','in_progress') ORDER BY created_seq, id`,
    )
    .all(projectId);

  const resolvedIntents = db
    .prepare(
      `SELECT id, question, kind FROM intents WHERE project_id = ? AND status = 'resolved' ORDER BY created_seq, id`,
    )
    .all(projectId);
  const blockedIntents = db
    .prepare(
      `SELECT id, question, kind, status, resume_conditions, updated_seq FROM intents
         WHERE project_id = ? AND status IN (${BLOCKED_INTENT_STATUSES.map(() => "?").join(",")})
         ORDER BY created_seq, id`,
    )
    .all(projectId, ...BLOCKED_INTENT_STATUSES)
    .map((it) => {
      const latest = db
        .prepare(
          `SELECT reason, via, created_at FROM intent_state_history WHERE project_id = ? AND intent_id = ? ORDER BY commit_seq DESC, rowid DESC LIMIT 1`,
        )
        .get(projectId, it.id);
      return {
        id: it.id,
        question: it.question,
        kind: it.kind,
        status: it.status,
        resume_conditions: parseJson(it.resume_conditions, []),
        latest_transition: latest || null,
      };
    });
  const ongoingIntents = db
    .prepare(
      `SELECT status, COUNT(*) AS c FROM intents WHERE project_id = ? AND status IN (${ONGOING_INTENT_STATUSES.map(() => "?").join(",")}) GROUP BY status`,
    )
    .all(projectId, ...ONGOING_INTENT_STATUSES);
  const ongoing = {};
  let ongoingTotal = 0;
  for (const r of ongoingIntents) {
    ongoing[r.status] = r.c;
    ongoingTotal += r.c;
  }

  const coverage = coverageRecords(db, projectId);
  // 未覆盖聚合只对内联记录统计（has_more 时缺口以折叠说明承载，不虚构全量值）
  const noDirection = coverage.records.filter((r) => r.uncovered_flags.no_direction).length;
  const noCapture = coverage.records.filter((r) => r.uncovered_flags.no_capture).length;

  return {
    report_kind: "milestone",
    schema_version: REPORT_SCHEMA_VERSION,
    project: {
      id: projectId,
      name: project ? project.name : "",
      status: project ? project.status : null,
      note: "阶段报告是持续探索的产物与引用入口；局部目标可以达成，长期目标继续存在（§1/§19）",
    },
    confirmed_findings: {
      vulnerabilities: confirmedVulns.slice(0, MAX_INLINE_FINDINGS),
      vulnerabilities_total: confirmedVulns.length,
      facts: verifiedFacts.slice(0, MAX_INLINE_FINDINGS),
      facts_total: verifiedFacts.length,
      folded_note:
        confirmedVulns.length > MAX_INLINE_FINDINGS || verifiedFacts.length > MAX_INLINE_FINDINGS
          ? `已确认成果超出内联上限 ${MAX_INLINE_FINDINGS}，仅呈现前若干条；完整清单按编号经 /records/{id} 与报告视图读取（不静默截断）`
          : null,
    },
    unconfirmed_leads: {
      vulnerabilities: unconfirmedVulns.slice(0, MAX_INLINE_FINDINGS),
      vulnerabilities_total: unconfirmedVulns.length,
      hypotheses: hypotheses.slice(0, MAX_INLINE_FINDINGS),
      hypotheses_total: hypotheses.length,
      pending_verification_jobs: pendingJobs.slice(0, MAX_INLINE_FINDINGS),
      pending_verification_jobs_total: pendingJobs.length,
      changed_facts: changedFacts.map((f) => ({ id: f.id, status: f.status, statement: f.statement })),
      note: "未确认线索不因报告生成而升级或丢弃；suspected 不写作 confirmed，insufficient 不写作已排除（§8.4/§18.4）",
    },
    completed_directions: {
      intents: resolvedIntents.slice(0, MAX_INTENTS_INLINE),
      total: resolvedIntents.length,
      note: "resolved 表示该版本的问题已处理，不代表关联资产已测透（§10.1/§19）",
    },
    blocked_directions: {
      intents: blockedIntents.slice(0, MAX_INTENTS_INLINE),
      total: blockedIntents.length,
      note: "受阻方向保留恢复条件；是否恢复由协调与规划决定，程序不写死重试（§16.3）",
    },
    uncovered: {
      assets_without_direction: noDirection,
      assets_without_capture: noCapture,
      total_assets: coverage.total_assets,
      note: "未覆盖部分是覆盖缺口的事实陈述，不是测完声明；范围未判定（pending）的目标不得默认可操作（§17）",
    },
    coverage,
    exploration_continues: {
      ongoing_intents: ongoing,
      ongoing_total: ongoingTotal,
      note: "报告生成后探索继续（§19）；确认漏洞、完成意图或生成本报告均不结束项目（§1）；后续方向由 planner 持续安排（§16.3）",
    },
    data_boundary: {
      snapshot_commit_seq: boundary,
      generated_at: generatedAt,
      note: "阶段报告注明数据截止版本（项目提交边界）与生成时间；边界之后的提交由下一份阶段报告承载",
    },
  };
}

/* ── 版本同步与落库 ───────────────────────────────────────────────── */

function vulnReportFileRef(dataDir, projectId, vulnId, version) {
  const dir = join(projectDir(dataDir, projectId), "reports", "vulnerabilities", safeSegment(vulnId));
  return {
    absPath: join(dir, `v${version}.json`),
    relPath: relative(dataDir, join(dir, `v${version}.json`)),
    dir,
  };
}

function milestoneReportFileRef(dataDir, projectId, reportId) {
  const dir = join(projectDir(dataDir, projectId), "reports", "milestones", safeSegment(reportId));
  return {
    absPath: join(dir, "content.json"),
    relPath: relative(dataDir, join(dir, "content.json")),
    dir,
  };
}

function insertRevisionRow(
  db,
  { id, projectId, reportKind, subjectId, version, contentRef, basisRefs, boundary, actor, now },
) {
  db.prepare(
    `INSERT INTO report_revisions (id, project_id, report_kind, subject_id, version, content_ref,
       basis_refs, data_boundary, created_at, created_by, created_seq)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    projectId,
    reportKind,
    subjectId,
    version,
    contentRef,
    JSON.stringify(basisRefs),
    JSON.stringify({ snapshot_commit_seq: boundary, generated_at: now }),
    now,
    actor || "reportgen",
    boundary, // 报告是派生资料：created_seq 记录其生成依据的提交边界（B1 快照先例）
  );
  return db.prepare("SELECT * FROM report_revisions WHERE id = ?").get(id);
}

/**
 * 同步漏洞报告到当前视图（§19 同步语义）：
 * 每个漏洞与最新版本比对报告相关指纹——一致则不产生新版本（无关提交不增殖
 * 版本）；变化则切新版本并保留历史。
 */
export async function syncVulnerabilityReports(pctx, { projectId, actor, onlySubjectId }) {
  const store = await getStore(pctx);
  const dataDir = pctx.dataDir;
  if (!store.db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) {
    throw apiError("NOT_FOUND", `项目不存在：${projectId}`);
  }
  const plan = readView(store, (db) => {
    const vulns = onlySubjectId
      ? db
          .prepare("SELECT * FROM vulnerabilities WHERE project_id = ? AND id = ?")
          .all(projectId, onlySubjectId)
      : db
          .prepare("SELECT * FROM vulnerabilities WHERE project_id = ? ORDER BY created_seq, id")
          .all(projectId);
    return vulns.map((vuln) => ({
      vuln,
      content: buildVulnerabilityReportContent(db, {
        projectId,
        vuln,
        generatedAt: new Date().toISOString(),
      }),
      history: revisionHistoryRows(db, projectId, "vulnerability", vuln.id),
    }));
  });

  const results = [];
  for (const item of plan) {
    const latest = item.history[item.history.length - 1] || null;
    const freshFp = reportFingerprint(item.content);
    let stored = null;
    if (latest) {
      stored = readStoredContent(dataDir, latest);
      if (stored && reportFingerprint(stored) === freshFp) {
        results.push({
          subject_id: item.vuln.id,
          version: latest.version,
          changed: false,
        });
        continue;
      }
    }
    const changedFields = stored ? topLevelDiff(stored, item.content) : ["created"];
    let written = false;
    let row = null;
    for (let attempt = 0; attempt < 3 && !written; attempt += 1) {
      const versionNum =
        nextVersionNumber(revisionHistoryRows(store.db, projectId, "vulnerability", item.vuln.id)) + attempt;
      const version = `v${versionNum}`;
      const fileRef = vulnReportFileRef(dataDir, projectId, item.vuln.id, versionNum);
      const content = {
        ...item.content,
        version_record: {
          version,
          previous_version: latest ? latest.version : null,
          changed_fields: changedFields,
        },
      };
      mkdirSync(fileRef.dir, { recursive: true });
      writeAtomic(fileRef.absPath, JSON.stringify(content, null, 2));
      const boundary = item.content.data_boundary.snapshot_commit_seq;
      const basisRefs = [
        item.vuln.id,
        ...item.content.trace.evidence.members
          .slice(0, 32)
          .map((m) => m.member_id),
        ...item.content.verification_conclusions.results
          .slice(0, 16)
          .map((r) => r.id),
        ...item.content.follow_up_intents.slice(0, 16).map((i) => i.intent_id),
      ].filter((v, i, arr) => arr.indexOf(v) === i);
      try {
        row = await store.runSerial((db) => {
          const dup = db
            .prepare(
              `SELECT 1 FROM report_revisions WHERE project_id = ? AND report_kind = 'vulnerability' AND subject_id = ? AND version = ?`,
            )
            .get(projectId, item.vuln.id, version);
          if (dup) throw new Error(`UNIQUE constraint failed: report_revisions slot ${version}`);
          const id = `RR-${projectId}-${pad4(allocateSeq(db, projectId, "report_vuln"))}`;
          return insertRevisionRow(db, {
            id,
            projectId,
            reportKind: "vulnerability",
            subjectId: item.vuln.id,
            version,
            contentRef: fileRef.relPath,
            basisRefs,
            boundary,
            actor,
            now: content.data_boundary.generated_at,
          });
        });
        written = true;
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        // 版本槽被并发同步占用：以更高版本号重试（孤立文件被同号回收或被新号覆盖）
      }
    }
    if (!written) {
      throw apiError("INTERNAL_ERROR", `报告版本写入重试用尽：${item.vuln.id}`, { retryable: true });
    }
    results.push({
      subject_id: item.vuln.id,
      version: row.version,
      changed: true,
      changed_fields: changedFields,
      report_id: row.id,
    });
  }
  return { project_id: projectId, results };
}

/* ── 阶段报告生成 ─────────────────────────────────────────────────── */

/**
 * 生成新的阶段报告版本（§19：阶段报告是数据截止边界上的快照，显式生成
 * [refresh] 或首读兜底 v1；读取不增殖版本）。
 */
export async function generateMilestoneReport(pctx, { projectId, actor }) {
  const store = await getStore(pctx);
  const dataDir = pctx.dataDir;
  if (!store.db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) {
    throw apiError("NOT_FOUND", `项目不存在：${projectId}`);
  }
  const content = readView(store, (db) =>
    buildMilestoneReportContent(db, { projectId, generatedAt: new Date().toISOString() }),
  );
  const history = revisionHistoryRows(store.db, projectId, "milestone", projectId);
  const versionNum = nextVersionNumber(history);
  const version = `v${versionNum}`;
  const boundary = content.data_boundary.snapshot_commit_seq;
  const basisRefs = [
    projectId,
    ...content.confirmed_findings.vulnerabilities.slice(0, 32).map((v) => v.id),
    ...content.confirmed_findings.facts.slice(0, 32).map((f) => f.id),
    ...content.completed_directions.intents.slice(0, 32).map((i) => i.id),
  ].filter((v, i, arr) => arr.indexOf(v) === i);

  // §13 同法：文件先固定，再落库行（报告 id 经独立小事务分配，单调不冲突）
  const reportId = await store.runSerial((db) => `MR-${projectId}-${pad4(allocateSeq(db, projectId, "report_ms"))}`);
  const fileRef = milestoneReportFileRef(dataDir, projectId, reportId);
  const withRecord = {
    ...content,
    version_record: { version, previous_version: history.length ? history[history.length - 1].version : null, changed_fields: ["refresh"] },
  };
  mkdirSync(fileRef.dir, { recursive: true });
  writeAtomic(fileRef.absPath, JSON.stringify(withRecord, null, 2));
  const row = await store.runSerial((db) =>
    insertRevisionRow(db, {
      id: reportId,
      projectId,
      reportKind: "milestone",
      subjectId: projectId,
      version,
      contentRef: fileRef.relPath,
      basisRefs,
      boundary,
      actor,
      now: content.data_boundary.generated_at,
    }),
  );
  return { project_id: projectId, report_id: reportId, version: row.version, boundary };
}

/* ── 视图（端点主体） ─────────────────────────────────────────────── */

function historyView(row, dataDir) {
  const stored = readStoredContent(dataDir, row);
  const record = stored && stored.version_record ? stored.version_record : null;
  return {
    report_id: row.id,
    version: row.version,
    changed_fields: record ? record.changed_fields : null,
    data_boundary: parseJson(row.data_boundary, null),
    content_ref: row.content_ref,
    content_available: Boolean(stored),
    created_at: row.created_at,
    created_by: row.created_by,
    created_seq: row.created_seq,
  };
}

/**
 * #39 GET /reports/vulnerabilities 主体：
 * 无 id → 同步后返回摘要列表（cursor/limit 游标分页，蓝图 §9 列表分页走游标
 * 不静默截断；分页只作用于摘要呈现，草稿/版本同步仍覆盖全部漏洞）；有 id →
 * 单份报告（默认最新版本），version 指定历史版本（历史保留可读）。
 */
export async function getVulnerabilityReportView(pctx, { projectId, subjectId, version, actor, limit, cursor }) {
  const store = await getStore(pctx);
  const dataDir = pctx.dataDir;
  if (!store.db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) {
    throw apiError("NOT_FOUND", `项目不存在：${projectId}`);
  }
  if (subjectId) {
    const vuln = store.db
      .prepare("SELECT * FROM vulnerabilities WHERE project_id = ? AND id = ?")
      .get(projectId, subjectId);
    if (!vuln) {
      throw apiError("NOT_FOUND", `漏洞不存在或不属于该项目：${subjectId}`);
    }
  }
  // 当前视图同步（suspected 起草稿 / 确认、排除、争议同步；无关提交不增殖版本）
  const sync = await syncVulnerabilityReports(pctx, { projectId, actor, onlySubjectId: subjectId || null });

  if (!subjectId) {
    // 游标分页（蓝图 §9：列表分页走游标不静默截断）；分页只作用于摘要呈现
    let afterSeq = null;
    let afterId = null;
    if (cursor) {
      const m = /^(\d+):(.+)$/.exec(cursor);
      if (!m) {
        throw apiError("BAD_REQUEST", "cursor 格式非法（应使用上一页返回的 next_cursor）");
      }
      afterSeq = Number(m[1]);
      afterId = m[2];
    }
    const pageLimit = Math.min(Math.max(limit ?? 50, 1), 200);
    const where = ["project_id = ?"];
    const args = [projectId];
    if (afterSeq !== null) {
      where.push("(created_seq > ? OR (created_seq = ? AND id > ?))");
      args.push(afterSeq, afterSeq, afterId);
    }
    const vulnRows = store.db
      .prepare(`SELECT * FROM vulnerabilities WHERE ${where.join(" AND ")} ORDER BY created_seq, id LIMIT ?`)
      .all(...args, pageLimit + 1);
    const hasMore = vulnRows.length > pageLimit;
    const vulns = vulnRows.slice(0, pageLimit);
    const reports = vulns.map((v) => {
      const history = revisionHistoryRows(store.db, projectId, "vulnerability", v.id);
      const latest = history[history.length - 1] || null;
      const stored = latest ? readStoredContent(dataDir, latest) : null;
      const record = stored && stored.version_record ? stored.version_record : null;
      return {
        id: v.id,
        report_kind: "vulnerability",
        subject_id: v.id,
        asset_id: v.asset_id,
        category: v.category,
        location: v.location,
        status: v.status,
        review: v.review,
        latest_version: latest ? latest.version : null,
        version: latest ? latest.version : null, // DDL 相邻别名（report_revisions.version 形态）
        versions: history.length,
        changed_fields: record ? record.changed_fields : null,
        data_boundary: latest ? parseJson(latest.data_boundary, null) : null,
        report_id: latest ? latest.id : null,
        content_ref: latest ? latest.content_ref : null,
        created_at: latest ? latest.created_at : null,
      };
    });
    const totalRow = store.db
      .prepare("SELECT COUNT(*) AS c FROM vulnerabilities WHERE project_id = ?")
      .get(projectId);
    const all = store.db
      .prepare("SELECT status, review FROM vulnerabilities WHERE project_id = ?")
      .all(projectId);
    const summary = { total: totalRow.c, by_status: {}, by_review: {} };
    for (const v of all) {
      summary.by_status[v.status] = (summary.by_status[v.status] || 0) + 1;
      summary.by_review[v.review] = (summary.by_review[v.review] || 0) + 1;
    }
    const last = vulns[vulns.length - 1];
    return {
      project_id: projectId,
      reports,
      summary,
      total: totalRow.c,
      next_cursor: hasMore && last ? `${last.created_seq}:${last.id}` : null,
      has_more: hasMore,
      sync: sync.results,
      note: "漏洞报告自 suspected 起即有草稿并随状态/证据/条件/影响持续更新；确认、排除与争议同步当前视图，历史版本保留可按 version 读回（§19）。报告是持续探索的引用入口，生成后探索继续（§1）",
    };
  }

  const history = revisionHistoryRows(store.db, projectId, "vulnerability", subjectId);
  if (!history.length) {
    throw apiError("INTERNAL_ERROR", `同步后仍无报告版本：${subjectId}`, { retryable: true });
  }
  const current = history[history.length - 1];
  let requested = current;
  if (version) {
    const wanted = /^v?\d+$/i.test(String(version)) ? `v${String(version).replace(/^v/i, "")}` : null;
    if (!wanted) {
      throw apiError("BAD_REQUEST", "version 参数形如 v2 或 2");
    }
    requested = history.find((r) => r.version.toLowerCase() === wanted.toLowerCase()) || null;
    if (!requested) {
      throw apiError("NOT_FOUND", `报告版本不存在：${subjectId} ${wanted}（现存 ${history.map((r) => r.version).join("、")}）`);
    }
  }
  const stored = readStoredContent(dataDir, requested);
  return {
    project_id: projectId,
    report: stored,
    report_meta: historyView(requested, dataDir),
    current_version: current.version,
    requested_version: requested.version,
    history: history.slice(-MAX_HISTORY_INLINE).map((r) => historyView(r, dataDir)),
    history_total: history.length,
    note: stored
      ? null
      : "该版本的报告内容文件不可读（磁盘异常或被清理）；行元数据保留，最新版本可经重新同步重建（视图可完全重建）",
  };
}

/**
 * #40 GET /reports/milestones 主体：默认返回最新阶段报告（无则生成 v1，
 * 读取不增殖版本）；refresh=1 显式生成新版本；version 读历史版本。
 */
export async function getMilestoneReportView(pctx, { projectId, refresh, version, actor }) {
  const store = await getStore(pctx);
  const dataDir = pctx.dataDir;
  if (!store.db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) {
    throw apiError("NOT_FOUND", `项目不存在：${projectId}`);
  }
  let generated = null;
  if (refresh) {
    generated = await generateMilestoneReport(pctx, { projectId, actor });
  } else {
    const existing = revisionHistoryRows(store.db, projectId, "milestone", projectId);
    if (!existing.length) {
      generated = await generateMilestoneReport(pctx, { projectId, actor });
    }
  }
  const history = revisionHistoryRows(store.db, projectId, "milestone", projectId);
  if (!history.length) {
    throw apiError("INTERNAL_ERROR", "阶段报告生成失败（无版本行）", { retryable: true });
  }
  const current = history[history.length - 1];
  let requested = current;
  if (version) {
    const wanted = /^v?\d+$/i.test(String(version)) ? `v${String(version).replace(/^v/i, "")}` : null;
    if (!wanted) {
      throw apiError("BAD_REQUEST", "version 参数形如 v2 或 2");
    }
    requested = history.find((r) => r.version.toLowerCase() === wanted.toLowerCase()) || null;
    if (!requested) {
      throw apiError("NOT_FOUND", `阶段报告版本不存在：${wanted}（现存 ${history.map((r) => r.version).join("、")}）`);
    }
  }
  const stored = readStoredContent(dataDir, requested);
  return {
    project_id: projectId,
    report: stored,
    report_meta: historyView(requested, dataDir),
    current_version: current.version,
    requested_version: requested.version,
    refreshed: Boolean(generated),
    history: history.map((r) => historyView(r, dataDir)),
    note: stored
      ? "阶段报告注明数据截止版本（snapshot_commit_seq）与生成时间；生成后探索继续（§19）。刷新请携带 refresh=1"
      : "该版本的报告内容文件不可读（磁盘异常或被清理）；行元数据保留，refresh=1 可生成携带最新边界的新版本",
  };
}

/* ── #53 报告导出（蓝图 §2.6-9；M2 只增不改） ──────────────────────── */

/**
 * 导出读取：按报告版本行（RR-/MR- 前缀）定位 report_revisions，读取内容文件。
 * 归属校验：报告行不属于指定项目 → null（404 不泄露存在性，与 records-read 同合同）；
 * 内容文件缺失/损坏 → { row, content: null }（404 + note，沿 reportgen 既有口径：
 * refresh=1 可生成携带最新边界的新版本）。
 */
export async function readReportRevisionForExport(pctx, { projectId, reportId, version }) {
  const store = await getStore(pctx);
  const db = store.db;
  if (!db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) return null;
  let row = db.prepare("SELECT * FROM report_revisions WHERE project_id = ? AND id = ?").get(projectId, reportId);
  if (!row) return null;
  if (version) {
    const wanted = /^v?\d+$/i.test(String(version)) ? `v${String(version).replace(/^v/i, "")}` : null;
    if (!wanted) {
      throw apiError("BAD_REQUEST", "version 参数形如 v2 或 2");
    }
    row = db
      .prepare("SELECT * FROM report_revisions WHERE project_id = ? AND id = ? AND version = ?")
      .get(projectId, reportId, wanted);
    if (!row) return null;
  }
  return { row, content: readStoredContent(pctx.dataDir, row) };
}

const SECTION_TITLES = Object.freeze({
  schema_version: "模式版本",
  project: "项目",
  confirmed_findings: "已确认成果",
  unconfirmed_leads: "未确认线索",
  completed_directions: "已完成方向",
  blocked_directions: "受阻方向",
  uncovered: "未覆盖部分",
  coverage: "覆盖度记录",
  exploration_continues: "探索继续",
  data_boundary: "数据截止边界",
  trace: "追溯关系",
  verification_conclusions: "验证结论",
  source_intents: "来源意图",
  follow_up_intents: "后续意图",
  status_and_review: "状态与复核",
  impact: "影响说明",
  conditions: "适用条件",
  supporting_evidence: "支持证据",
  opposing_evidence: "反对证据",
  limitations: "限制",
});

/** 单值 → markdown 行（不虚构：null/空 → 未提供；深层对象折叠为计数与展开入口）。 */
function mdValue(value, indent = "", depth = 0) {
  if (value === null || value === undefined || value === "") return `${indent}- （未提供）`;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return `${indent}- ${String(value)}`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return `${indent}- （空）`;
    return value.map((v) => mdValue(v, indent, depth)).join("\n");
  }
  if (typeof value === "object") {
    const lines = [];
    if (typeof value.id === "string") {
      const brief = [value.category, value.status, value.statement]
        .filter((x) => typeof x === "string" && x)
        .slice(0, 2)
        .map((x) => String(x).slice(0, 80));
      lines.push(`${indent}- ${value.id}${brief.length ? `（${brief.join("｜")}）` : ""}`);
    }
    for (const [k, v] of Object.entries(value)) {
      if (k === "id" || v === null || v === undefined || v === "") continue;
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        lines.push(`${indent}  - ${k}: ${String(v)}`);
      } else if (Array.isArray(v)) {
        if (depth < 2 && v.length && typeof v[0] === "object") {
          // 编号清单展开一层（深度受限；超限以计数与展开入口呈现，折叠不删记录）
          lines.push(`${indent}  - ${k}（${v.length} 项）：`);
          for (const item of v.slice(0, 20)) lines.push(mdValue(item, `${indent}    `, depth + 1));
          if (v.length > 20) lines.push(`${indent}    - …其余 ${v.length - 20} 项经报告视图 /records 按编号展开`);
        } else {
          lines.push(`${indent}  - ${k}: ${v.length} 项（结构化字段，经报告视图 /records 按编号展开）`);
        }
      } else if (typeof v === "object" && depth < 1) {
        lines.push(mdValue(v, `${indent}  `, depth + 1));
      } else if (typeof v === "object") {
        lines.push(`${indent}  - ${k}: 对象（结构化字段，经报告视图 /records 按编号展开）`);
      }
    }
    return lines.join("\n") || `${indent}- （空对象）`;
  }
  return `${indent}- ${String(value)}`;
}

/**
 * 报告版本 → markdown 导出文本（§19：报告含 ID、状态与条件、证据、验证结论、
 * 限制与方向；note 字段原文保留——语义纪律随报告走）。
 */
export function renderReportMarkdown(row, content) {
  const boundary = content?.data_boundary ?? null;
  const head = [
    `# 报告 ${row.id}（${row.report_kind === "milestone" ? "阶段报告" : "漏洞报告"} v${row.version}）`,
    "",
    `- 报告编号：${row.id}`,
    `- 报告种类：${row.report_kind}`,
    `- 版本：${row.version}（主体：${row.subject_id}）`,
    `- 数据截止：commit_seq=${boundary?.snapshot_commit_seq ?? "（未提供）"}，生成于 ${boundary?.generated_at ?? row.created_at}`,
    `- 导出时间：${new Date().toISOString()}`,
    "",
    boundary?.note ? `> ${boundary.note}\n` : "",
  ];
  const body = [];
  for (const [key, value] of Object.entries(content ?? {})) {
    if (key === "data_boundary" || key === "version_record") continue;
    body.push(`## ${SECTION_TITLES[key] ?? key}`);
    body.push("");
    if (value && typeof value === "object" && !Array.isArray(value) && typeof value.note === "string") {
      body.push(`> ${value.note}`);
      body.push("");
    }
    body.push(mdValue(value));
    body.push("");
  }
  const record = content?.version_record;
  if (record) {
    body.push("## 版本记录");
    body.push("");
    body.push(`- 版本：${record.version ?? row.version}`);
    if (record.previous_version) body.push(`- 上一版本：${record.previous_version}`);
    if (Array.isArray(record.changed_fields) && record.changed_fields.length) {
      body.push(`- 变化字段：${record.changed_fields.join("、")}`);
    }
    body.push("");
  }
  return [...head, ...body].join("\n");
}
