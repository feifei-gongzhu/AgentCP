/**
 * D1 —— 验证服务与准入（规范 §8.3 §12 §11.2 verification-*）。
 *
 * 合同落实：
 *   - 验证请求五要素（§8.3）：待核实的明确判断（subject_id）、必要的环境与身份条件
 *     （condition_snapshot_id / conditions）、原始证据索引（raw_evidence_refs，指向
 *     blobs/captures）、相关反对证据（opposing_evidence_refs）、验证策略及其版本
 *     （policy_id + policy_version，须先经 registerVerificationPolicy 注册）；
 *   - 去重键（§7.3）= 判断 + 条件快照 + 策略版本 + 所审阅证据版本：同键返回原 job
 *     （deduplicated），新证据推进 evidence_revision 后可开新 job（续验通道不被吞掉）；
 *   - Manifest 服务（§12.1）：按证据集版本生成不可变 evidence_manifests（成员/
 *     条件/判断版本/策略版本，content_hash 锚定），job.evidence_manifest_id 与
 *     result.reviewed_manifest_id 外键绑定；单个最大 Event ID 不能替代 Manifest；
 *   - §12.2 核心事务（见 submitVerificationResult）：校验 → 保存不可变结果 →
 *     同一 runSerial 事务内读 subject 三版本（state_version / claim_revision +
 *     assessment_epoch / evidence_revision）→ 全部匹配且检查通过才经 §2.7 冻结签名
 *     applyStateTransition 应用转换（D2 唯一实现，本模块不另行实现状态机）→
 *     同事务登记 Outbox；检查与状态更新原子，不在事务外检查版本再无条件写入；
 *   - §12.3 五种竞争情形（新证据先提交 / 确认先提交 / 无关备注 / 完全重复 /
 *     无法确定相关性）由本模块与 A1 的证据集版本机制共同保证，测试全覆盖；
 *   - 准入（§8.2/§9.1）：evaluateAdmission 供执行/规划侧检查「有效性 + 复核标记」，
 *     不能只看字符串 confirmed；
 *   - 仅 verifier 会话可交结果（§8.3(1)）；发现者（subject.created_by）不得提交
 *     应用型结果（supported/falsified，§8.3(2)）；续验/复核的请求发起者不受限
 *     （§8.3(3)）。
 *
 * 程序只做规范交给程序的校验与保障（权限、必要前提、幂等、原子性、可靠事件）；
 * 验证策略内容与真实性判断属 AI/规则引擎，本模块只提供版本化注册表与结构校验
 * （§3.2、§22 待实施评审确定的配置）。
 *
 * 与 D2 的并行协调（§2.7 冻结签名）：本模块调用 applyStateTransition（D2 落地版
 * 会按 verification_result_id 回读结果行并返回待 flush 的事件结构，本模块在调用前
 * 先落结果行、调用后把返回事件并入同事务 Outbox）。D1 的 outcome→action 路由表
 * （§8.4 各行在验证路径上的落点）：
 *   - vulnerabilities: supported→confirm / falsified→falsify（confirmed 起点需显式
 *     overturn 声明透传）/ conflicting→mark_conflicting / insufficient→mark_insufficient；
 *   - hypotheses: supported→support / falsified→reject；conflicting/insufficient 无对应
 *     动作（假设无复核标记；§8.4「可为 inconclusive」为许可性用语）→ 仅记录意见；
 *   - facts: 验证路径不驱动转换（§8.1 事实准入按判断类别经 D2 受控流程）→ 仅记录。
 * 起点状态不被 §8.4 合同接受时（如对已 confirmed 再 confirm），保留意见、
 * decision=no_transition，不丢弃验证意见也不另行实现状态机。
 */
import { createHash } from "node:crypto";

import { apiError } from "../errors.mjs";
import { getStore } from "./record-service.mjs";
import { locateRecord } from "./records-read.mjs";

/* ── 常量 ─────────────────────────────────────────────────────────── */

/** §8.3 outcome 四值（与冻结 DDL CHECK 一致）。 */
export const VERIFIER_OUTCOMES = Object.freeze(["supported", "falsified", "insufficient", "conflicting"]);

/** §8.3 verifier_kind（与冻结 DDL CHECK 一致）。 */
export const VERIFIER_KINDS = Object.freeze(["llm_agent", "versioned_rule", "arbitration"]);

/** 验证任务状态（与冻结 DDL CHECK 一致；superseded 预留、当前无自动置位方）。 */
export const JOB_STATUSES = Object.freeze(["pending", "in_progress", "completed", "superseded"]);

/** 拥有三版本字段（claim/evidence/epoch）的判断类对象（§6.1 结论类对象）。 */
export const JUDGEMENT_SUBJECT_TABLES = Object.freeze({
  hypotheses: "hypotheses",
  facts: "facts",
  vulnerabilities: "vulnerabilities",
});

/**
 * 语义 subject 类型（§8.1 四类；评审 §4b / 蓝图 P0-4）：
 * 验证任务与 Manifest 的 subject_kind 一律以语义类型持久化与呈现
 * （observation / hypothesis / fact / vulnerability），物理表名经 subject_table
 * 字段并存，不再把表名当类型暴露给视图（「未知类型（vulnerabilities）」的根因）。
 */
export const SUBJECT_KINDS = Object.freeze(["observation", "hypothesis", "fact", "vulnerability"]);

const SEMANTIC_KIND_BY_TABLE = Object.freeze({
  observations: "observation",
  hypotheses: "hypothesis",
  facts: "fact",
  vulnerabilities: "vulnerability",
});

/** 物理表名 → 语义类型；未登记表返回 null（不猜测）。 */
export function semanticSubjectKind(table) {
  return SEMANTIC_KIND_BY_TABLE[String(table || "").toLowerCase()] || null;
}

/** 库内 subject_kind 值 → 语义类型（兼容历史行可能存物理表名）；未知返回 null。 */
export function toSemanticSubjectKind(value) {
  const v = String(value || "").toLowerCase();
  if (SEMANTIC_KIND_BY_TABLE[v]) return SEMANTIC_KIND_BY_TABLE[v];
  return SUBJECT_KINDS.includes(v) ? v : null;
}

/** 语义类型 → 物理表名（subject_table 字段并存；D2 applyStateTransition 同型映射）。 */
export function subjectTableOf(kind) {
  const v = String(kind || "").toLowerCase();
  if (SEMANTIC_KIND_BY_TABLE[v]) return v;
  for (const [table, semantic] of Object.entries(SEMANTIC_KIND_BY_TABLE)) {
    if (semantic === v) return table;
  }
  return null;
}

/** 各判断类的默认「可作为满足前提」状态（§8.2/§9.1；复核标记另查）。 */
export const DEFAULT_ADMITTED_STATUS = Object.freeze({
  hypotheses: ["supported"],
  facts: ["verified"],
  vulnerabilities: ["confirmed"],
});

/** §8.2 复核标记语义（准入要求默认 clear）。 */
const REVIEW_TABLES = new Set(["vulnerabilities"]);

/**
 * outcome → applyStateTransition 的 action 路由（D2 落地词表；空=验证路径不驱动
 * 转换、仅记录意见）。D2 是 §8.4 唯一状态机：from 状态、目标状态、守卫与事件
 * 均由其实现；本表只做「哪类结论走哪个动作」的映射。
 */
const TRANSITION_ACTIONS = Object.freeze({
  vulnerabilities: Object.freeze({
    supported: "confirm",
    falsified: "falsify",
    conflicting: "mark_conflicting",
    insufficient: "mark_insufficient",
  }),
  hypotheses: Object.freeze({
    supported: "support",
    falsified: "reject",
    conflicting: null,
    insufficient: null,
  }),
  facts: Object.freeze({ supported: null, falsified: null, conflicting: null, insufficient: null }),
});

/** 应用型 outcome（发现者不得自证所针对的两类，§8.3(2)）。 */
const APPLICATION_OUTCOMES = new Set(["supported", "falsified"]);

const EVENT_SCHEMA_VERSION = 1;
const PRODUCER_ID = "d1/verification";

/* ── 验证策略注册表（§8.3：策略定义需要哪些证据、对照和检查；§22 内容待评审） ── */

const policyRegistry = new Map(); // `${policy_id}@${policy_version}` → policy

/**
 * 注册版本化验证策略。策略声明该类判断的必需检查项（required_checks，按名匹配
 * 结果 checks[].name）；具体检查语义由 verifier/规则实现，本模块只做结构校验。
 */
export function registerVerificationPolicy({ id, version, required_checks = [], description = "" }) {
  if (typeof id !== "string" || !id.trim() || id.length > 128) {
    throw apiError("BAD_REQUEST", "验证策略 id 必填（1..128 字符）");
  }
  if (typeof version !== "string" || !version.trim() || version.length > 64) {
    throw apiError("BAD_REQUEST", `验证策略 ${id} 的 version 必填（1..64 字符）`);
  }
  if (!Array.isArray(required_checks) || required_checks.some((c) => typeof c !== "string" || !c.trim())) {
    throw apiError("BAD_REQUEST", `验证策略 ${id}@${version} 的 required_checks 必须是字符串数组`);
  }
  const key = `${id}@${version}`;
  const normalized = {
    id,
    version,
    required_checks: Object.freeze(required_checks.map((c) => c.trim()).filter(Boolean)),
    description: String(description || ""),
  };
  const existing = policyRegistry.get(key);
  if (existing) {
    // 同键重复注册：内容一致视为幂等，不一致拒绝（策略版本不可变）
    if (
      JSON.stringify(existing.required_checks) !== JSON.stringify(normalized.required_checks) ||
      existing.description !== normalized.description
    ) {
      throw apiError("BAD_REQUEST", `验证策略 ${key} 已以不同内容注册；策略版本不可变，请递增 version`);
    }
    return existing;
  }
  policyRegistry.set(key, Object.freeze(normalized));
  return normalized;
}

export function listVerificationPolicies() {
  return [...policyRegistry.values()].map((p) => ({ ...p, required_checks: [...p.required_checks] }));
}

/**
 * 内置基线验证策略（§8.3 必备要素：策略及其版本）。
 *
 * 为什么内置：validateEvidenceRefs/requirePolicy 要求策略先注册，而生产进程此前没有任何
 * 注册点 → 真实运行中 request_verification 永远 INVALID_REFERENCE（验证准入链路不可用）。
 * 内置一条最小基线策略，只要求「审阅不可变 Manifest 与原始证据」；更严格的按判断类型的
 * 策略（§22 待评审）可由调用方继续 registerVerificationPolicy 追加，版本不可变语义不变。
 */
export const DEFAULT_VERIFICATION_POLICY = Object.freeze({
  id: "default-verification",
  version: "v1",
  required_checks: Object.freeze(["evidence_reviewed"]),
  description: "内置基线策略：要求验证者审阅不可变 Manifest 成员与原始证据；具体检查语义由 verifier 执行（§22 策略细节待评审，可追加更严格策略）",
});

// 模块加载即注册（幂等；进程内注册表，重启后自动恢复）。
registerVerificationPolicy({
  id: DEFAULT_VERIFICATION_POLICY.id,
  version: DEFAULT_VERIFICATION_POLICY.version,
  required_checks: [...DEFAULT_VERIFICATION_POLICY.required_checks],
  description: DEFAULT_VERIFICATION_POLICY.description,
});

function requirePolicy(policyId, policyVersion) {
  const policy = policyRegistry.get(`${policyId}@${policyVersion}`);
  if (!policy) {
    throw apiError("INVALID_REFERENCE", `验证策略未注册：${policyId}@${policyVersion}`, {
      detail: { policy_id: policyId, policy_version: policyVersion },
      next_requirements: ["先经 registerVerificationPolicy 注册该策略版本（验证策略及其版本为 §8.3 必备要素）"],
    });
  }
  return policy;
}

/* ── §2.7 冻结签名 applyStateTransition 的装配（D2 唯一实现） ───────── */

let testApplier = null; // __installStateTransitionForTests 安装（D2 未落地窗口）
let d2Applier = null;
let d2Resolved = false;

/** 仅供测试注入真实事务实现（B1 先例）；D2 落地后默认装配优先生效。 */
export function __installStateTransitionForTests(fn) {
  if (typeof fn !== "function") throw new Error("__installStateTransitionForTests 需要函数");
  testApplier = fn;
}

/** 当前状态转换装配来源（诊断/测试用）：d2/judgements | test-install | none。 */
export function stateTransitionSource() {
  if (testApplier) return "test-install";
  return d2Resolved ? (d2Applier ? "d2/judgements" : "none") : "unresolved";
}

async function resolveStateTransition() {
  if (testApplier) return { apply: testApplier, source: "test-install" };
  if (!d2Resolved) {
    try {
      const mod = await import("./judgements.mjs");
      d2Applier = typeof mod.applyStateTransition === "function" ? mod.applyStateTransition : null;
    } catch {
      d2Applier = null; // D2 文件不可读时按未落地处理
    }
    d2Resolved = true;
  }
  return d2Applier ? { apply: d2Applier, source: "d2/judgements" } : null;
}

/* ── 基础工具 ─────────────────────────────────────────────────────── */

function sha256Hex(text) {
  return createHash("sha256").update(text).digest("hex");
}

/** 规范化 JSON（键递归排序）：去重键与 content_hash 的确定性基础（与 A1/C1 同法）。 */
function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

function pad4(n) {
  return String(n).padStart(4, "0");
}

/** 事务内分配项目内序列（§6.1 id_sequences；与 A1/C1 共用同一序列池）。 */
function nextSeq(db, projectId, kind) {
  db.prepare(
    "INSERT INTO id_sequences (project_id, kind, next_val) VALUES (?, ?, 1) ON CONFLICT(project_id, kind) DO NOTHING",
  ).run(projectId, kind);
  const row = db.prepare("SELECT next_val AS n FROM id_sequences WHERE project_id = ? AND kind = ?").get(projectId, kind);
  db.prepare("UPDATE id_sequences SET next_val = ? WHERE project_id = ? AND kind = ?").run(row.n + 1, projectId, kind);
  return row.n;
}

/** 项目级 commit_seq：事务内取出并推进（§14.1，与 A1 共用计数器）。 */
function nextCommitSeq(db, projectId) {
  const row = db.prepare("SELECT next_commit_seq AS n FROM projects WHERE id = ?").get(projectId);
  db.prepare("UPDATE projects SET next_commit_seq = ? WHERE id = ?").run(row.n + 1, projectId);
  return row.n;
}

function jobIdFor(projectId, n) {
  return `VJ-${projectId}-${pad4(n)}`;
}
function resultIdFor(projectId, n) {
  return `VR-${projectId}-${pad4(n)}`;
}
export function manifestIdFor(projectId, n) {
  return `EVM-${projectId}-${pad4(n)}`;
}

/** 事务内事件汇（§2 约束 10：业务记录与 Outbox 同事务）。 */
function makeEventSink() {
  const events = [];
  return {
    events,
    emit(event_type, { subject_ids = [], changed_fields = [], cause_refs = [], payload = {} } = {}) {
      events.push({ event_type, subject_ids, changed_fields, cause_refs, payload });
    },
  };
}

function flushEvents(db, { projectId, actor, commitSeq, causeRef, events, now }) {
  events.forEach((ev, i) => {
    const eventId = `evt-d1-${projectId}-${commitSeq}-${i + 1}`;
    db.prepare(
      `INSERT INTO outbox (event_id, project_id, commit_seq, event_index, event_type, subject_ids,
         changed_fields, cause_refs, producer_id, schema_version, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      eventId,
      projectId,
      commitSeq,
      i + 1,
      ev.event_type,
      JSON.stringify(ev.subject_ids),
      JSON.stringify(ev.changed_fields),
      JSON.stringify(ev.cause_refs.length ? ev.cause_refs : [causeRef]),
      actor,
      EVENT_SCHEMA_VERSION,
      JSON.stringify(ev.payload),
      now,
    );
  });
}

/** 判断类 subject 定位与三版本读取（§6.1 结论类对象）。 */
function requireJudgementSubject(db, projectId, subjectId) {
  const located = locateRecord(db, projectId, subjectId);
  if (!located) {
    throw apiError("INVALID_REFERENCE", `待验证判断不存在（会话项目域内）：${subjectId}`, {
      detail: { subject_id: subjectId },
      next_requirements: ["先创建该判断（如经 POST /submissions 的 report_vulnerability / propose_hypothesis）"],
    });
  }
  const table = JUDGEMENT_SUBJECT_TABLES[located.table];
  if (!table) {
    throw apiError(
      "BAD_REQUEST",
      `验证对象必须是判断类记录（hypotheses / facts / vulnerabilities）：${subjectId} 是 ${located.table}`,
      { detail: { subject_id: subjectId, located_table: located.table } },
    );
  }
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ? AND project_id = ?`).get(subjectId, projectId);
  return { table, row };
}

function parseJson(text, fallback) {
  if (text === undefined || text === null || text === "") return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function subjectVersions(row) {
  return {
    state_version: row.state_version,
    claim_revision: row.claim_revision,
    evidence_revision: row.evidence_revision,
    assessment_epoch: row.assessment_epoch,
  };
}

/* ── Manifest 服务（§12.1：reviewed_evidence_revision 必须绑定不可变 Manifest） ── */

/**
 * 按证据集版本生成（或幂等返回）不可变 evidence_manifests：
 * 成员（evidence_memberships 全量含 withdrawn/disputed 及其 stance/status）、
 * 条件（subject.conditions）、判断版本（claim_revision）、策略版本（policy_version）、
 * 证据集版本（evidence_revision）；content_hash 锚定全部内容。
 * Manifest 为派生资料：不消耗项目 commit_seq（B1 快照先例）。
 */
export async function generateEvidenceManifest(pctx, { session, subjectId, policyId, policyVersion }) {
  const store = await getStore(pctx);
  return store.runSerial((db) => {
    const { table, row } = requireJudgementSubject(db, session.project_id, subjectId);
    const subjectKind = semanticSubjectKind(table); // P0-4：语义类型，不再以表名当类型
    if (!subjectKind) {
      throw apiError("BAD_REQUEST", `判断类对象 ${subjectId} 的表 ${table} 无语义类型映射`);
    }
    const policy = requirePolicy(policyId, policyVersion);
    const members = db
      .prepare(
        `SELECT member_kind, member_id, stance, status FROM evidence_memberships
          WHERE project_id = ? AND subject_id = ? ORDER BY created_seq, id`,
      )
      .all(session.project_id, subjectId)
      .map((m) => ({ member_kind: m.member_kind, member_id: m.member_id, stance: m.stance, status: m.status }));
    const conditions = parseJson(row.conditions, []);
    const content = {
      subject_id: subjectId,
      subject_kind: subjectKind,
      subject_table: table,
      claim_revision: row.claim_revision,
      policy_version: policy.version,
      evidence_revision: row.evidence_revision,
      members,
      conditions,
    };
    const contentHash = sha256Hex(canonicalJson(content));
    const existing = db
      .prepare(
        `SELECT * FROM evidence_manifests WHERE project_id = ? AND subject_id = ?
           AND evidence_revision = ? AND claim_revision = ? AND policy_version = ?`,
      )
      .get(session.project_id, subjectId, row.evidence_revision, row.claim_revision, policy.version);
    if (existing) {
      return {
        manifest: manifestView(existing),
        deduplicated: true,
      };
    }
    const id = manifestIdFor(session.project_id, nextSeq(db, session.project_id, "evidence_manifest"));
    const now = new Date().toISOString();
    // 派生资料的 created_seq 取当前提交边界（projects.next_commit_seq 已分配的最近一格）
    const boundaryRow = db
      .prepare("SELECT next_commit_seq AS n FROM projects WHERE id = ?")
      .get(session.project_id);
    const boundary = Math.max(1, boundaryRow.n - 1);
    db.prepare(
      `INSERT INTO evidence_manifests (id, project_id, subject_id, subject_kind, claim_revision,
         policy_version, evidence_revision, members, conditions, content_hash, created_at, created_by, created_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      session.project_id,
      subjectId,
      subjectKind,
      row.claim_revision,
      policy.version,
      row.evidence_revision,
      JSON.stringify(members),
      JSON.stringify(conditions),
      contentHash,
      now,
      session.actor,
      boundary,
    );
    return {
      manifest: manifestView(
        db.prepare("SELECT * FROM evidence_manifests WHERE id = ?").get(id),
      ),
      deduplicated: false,
    };
  });
}

function manifestView(row) {
  const semantic = toSemanticSubjectKind(row.subject_kind);
  return {
    id: row.id,
    project_id: row.project_id,
    subject_id: row.subject_id,
    subject_kind: semantic || row.subject_kind, // P0-4：语义类型（历史表名值映射呈现）
    subject_table: semantic ? subjectTableOf(semantic) : null,
    claim_revision: row.claim_revision,
    policy_version: row.policy_version,
    evidence_revision: row.evidence_revision,
    members: parseJson(row.members, []),
    conditions: parseJson(row.conditions, []),
    content_hash: row.content_hash,
    created_at: row.created_at,
    created_by: row.created_by,
    created_seq: row.created_seq,
  };
}

/* ── 验证请求（§8.3 五要素 + §7.3 去重键） ────────────────────────── */

function normalizeConditionSnapshot(input) {
  const snapshot = typeof input.condition_snapshot_id === "string" ? input.condition_snapshot_id.trim() : "";
  const conditions = input.conditions;
  if (snapshot && conditions !== undefined && conditions !== null) {
    throw apiError("BAD_REQUEST", "condition_snapshot_id 与 conditions 二选一（§8.3 环境与身份条件）");
  }
  if (snapshot) {
    if (snapshot.length > 512) throw apiError("BAD_REQUEST", "condition_snapshot_id 过长（≤512 字符）");
    return { condition_snapshot_id: snapshot, conditions: null };
  }
  if (Array.isArray(conditions) && conditions.length > 0 && conditions.length <= 32) {
    // 无显式快照编号时以规范化摘要充当快照标识（dedup 键成分稳定）
    return {
      condition_snapshot_id: `cond:${sha256Hex(canonicalJson(conditions)).slice(0, 24)}`,
      conditions,
    };
  }
  throw apiError(
    "BAD_REQUEST",
    "验证请求必须携带必要的环境与身份条件：condition_snapshot_id（字符串）或 conditions（1..32 项数组）（§8.3）",
  );
}

function validateEvidenceRefs(db, projectId, refs, field, { rawOnly }) {
  if (!Array.isArray(refs)) {
    throw apiError("BAD_REQUEST", `字段 ${field} 必须是数组（§8.3）`);
  }
  if (rawOnly && refs.length === 0) {
    throw apiError("BAD_REQUEST", `字段 ${field} 至少包含一条原始证据索引（§8.3：Verifier 必须收到原始证据索引）`);
  }
  if (refs.length > 64) {
    throw apiError("BAD_REQUEST", `字段 ${field} 最多 64 条（资源上限）`);
  }
  return refs.map((ref) => {
    if (typeof ref !== "string" || !ref.trim() || ref.length > 256) {
      throw apiError("BAD_REQUEST", `字段 ${field} 的成员必须是 1..256 字符的编号`);
    }
    const located = locateRecord(db, projectId, ref);
    if (!located) {
      throw apiError("INVALID_REFERENCE", `字段 ${field} 引用的对象不存在（会话项目域内）：${ref}`, {
        detail: { field, ref },
      });
    }
    if (rawOnly && located.table !== "blobs" && located.table !== "captures") {
      throw apiError(
        "INVALID_REFERENCE",
        `字段 ${field} 必须指向原始证据（blobs / captures）：${ref} 是 ${located.table}`,
        { detail: { field, ref, located_table: located.table } },
      );
    }
    return ref;
  });
}

/**
 * 请求独立验证（#27）：创建（或幂等返回）verification_jobs，绑定按当前证据集版本
 * 生成的不可变 Manifest 与期望三版本；不代替 verifier 确认（§3.3）。
 * 角色面（§8.2/§8.3(3)）：worker / orchestrator / verifier 均可发起（worker 提出
 * 验证请求是 §3 的职责；续验不受 requested_by 限制）。
 */
export async function requestVerification(pctx, { session, input }) {
  if (!input || typeof input !== "object") {
    throw apiError("BAD_REQUEST", "验证请求必须是 JSON 对象");
  }
  if ("project_id" in input) {
    throw apiError("BAD_REQUEST", "验证请求不得携带 project_id：由服务端会话决定（§11.1）");
  }
  if (typeof input.subject_id !== "string" || !input.subject_id.trim()) {
    throw apiError("BAD_REQUEST", "验证请求缺少 subject_id（待核实的明确判断，§8.3）");
  }
  const policyId = typeof input.policy_id === "string" ? input.policy_id.trim() : "";
  const policyVersion = typeof input.policy_version === "string" ? input.policy_version.trim() : "";
  if (!policyId || !policyVersion) {
    throw apiError("BAD_REQUEST", "验证请求缺少 policy_id / policy_version（验证策略及其版本，§8.3）");
  }
  const policy = requirePolicy(policyId, policyVersion);
  const snapshot = normalizeConditionSnapshot(input);
  const store = await getStore(pctx);
  return store.runSerial((db) => {
    const { table, row } = requireJudgementSubject(db, session.project_id, input.subject_id.trim());
    const subjectKind = semanticSubjectKind(table); // P0-4：任务与 Manifest 以语义类型持久化
    if (!subjectKind) {
      throw apiError("BAD_REQUEST", `判断类对象 ${input.subject_id.trim()} 的表 ${table} 无语义类型映射`);
    }
    const rawRefs = validateEvidenceRefs(db, session.project_id, input.raw_evidence_refs ?? [], "raw_evidence_refs", {
      rawOnly: true,
    });
    const opposingRefs = validateEvidenceRefs(
      db,
      session.project_id,
      input.opposing_evidence_refs ?? [],
      "opposing_evidence_refs",
      { rawOnly: false },
    );
    // §7.3 去重键 = 判断 + 条件快照 + 策略版本 + 所审阅证据版本
    const dedupKey = sha256Hex(
      canonicalJson({
        subject_id: row.id,
        condition_snapshot_id: snapshot.condition_snapshot_id,
        policy_id: policy.id,
        policy_version: policy.version,
        evidence_revision: row.evidence_revision,
      }),
    );
    const dup = db
      .prepare("SELECT * FROM verification_jobs WHERE project_id = ? AND dedup_key = ?")
      .get(session.project_id, dedupKey);
    if (dup) {
      return {
        job: jobView(db, dup),
        deduplicated: true,
        note: "同判断+同条件快照+同策略版本+同证据集版本的验证任务已存在，按 §7.3 去重返回原任务；新证据到来推进 evidence_revision 后可开新任务（续验）",
      };
    }
    // Manifest：按当前证据集版本生成不可变清单并外键绑定（§12.1）
    const { manifest } = manifestInTransaction(db, {
      projectId: session.project_id,
      actor: session.actor,
      subjectId: row.id,
      subjectKind,
      subjectRow: row,
      policyVersion: policy.version,
    });
    const commitSeq = nextCommitSeq(db, session.project_id);
    const now = new Date().toISOString();
    const id = jobIdFor(session.project_id, nextSeq(db, session.project_id, "verification_job"));
    db.prepare(
      `INSERT INTO verification_jobs (id, project_id, subject_id, subject_kind, claim_revision,
         condition_snapshot_id, policy_id, policy_version, evidence_manifest_id,
         expected_state_version, expected_evidence_revision, expected_assessment_epoch,
         requested_by, status, dedup_key, created_at, created_by, created_seq, updated_seq, state_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, 1)`,
    ).run(
      id,
      session.project_id,
      row.id,
      subjectKind,
      row.claim_revision,
      snapshot.condition_snapshot_id,
      policy.id,
      policy.version,
      manifest.id,
      row.state_version,
      row.evidence_revision,
      row.assessment_epoch,
      session.actor,
      dedupKey,
      now,
      session.actor,
      commitSeq,
      commitSeq,
    );
    const warnings = [];
    // 程序可核对的声明一致性：请求方声明反对证据为空、但库内存在 active 反对成员 → 告警
    const manifestMembers = parseJson(manifest.members, []);
    const activeOpposing = manifestMembers.filter((m) => m.status === "active" && m.stance === "contradicts");
    if (opposingRefs.length === 0 && activeOpposing.length > 0) {
      warnings.push(
        `请求未声明反对证据，但证据集内存在 ${activeOpposing.length} 条 active 反对成员（${activeOpposing
          .map((m) => m.member_id)
          .join("、")}），已全部列入 Manifest（声明不改变库内证据集，§12.1）`,
      );
    }
    const sink = makeEventSink(); // 验证任务创建不占 §14.1 必要事件（目录无对应类型；队列经 #29 拉取）
    flushEvents(db, {
      projectId: session.project_id,
      actor: session.actor,
      commitSeq,
      causeRef: id,
      events: sink.events,
      now,
    });
    return { job: jobView(db, db.prepare("SELECT * FROM verification_jobs WHERE id = ?").get(id)), deduplicated: false, warnings };
  });
}

/** 事务内 Manifest 生成/幂等返回（供 requestVerification 与导出的 generateEvidenceManifest 复用）。 */
function manifestInTransaction(db, { projectId, actor, subjectId, subjectKind, subjectRow, policyVersion }) {
  const members = db
    .prepare(
      `SELECT member_kind, member_id, stance, status FROM evidence_memberships
        WHERE project_id = ? AND subject_id = ? ORDER BY created_seq, id`,
    )
    .all(projectId, subjectId)
    .map((m) => ({ member_kind: m.member_kind, member_id: m.member_id, stance: m.stance, status: m.status }));
  const conditions = parseJson(subjectRow.conditions, []);
  const contentHash = sha256Hex(
    canonicalJson({
      subject_id: subjectId,
      subject_kind: subjectKind,
      subject_table: subjectTableOf(subjectKind),
      claim_revision: subjectRow.claim_revision,
      policy_version: policyVersion,
      evidence_revision: subjectRow.evidence_revision,
      members,
      conditions,
    }),
  );
  const existing = db
    .prepare(
      `SELECT * FROM evidence_manifests WHERE project_id = ? AND subject_id = ?
         AND evidence_revision = ? AND claim_revision = ? AND policy_version = ?`,
    )
    .get(projectId, subjectId, subjectRow.evidence_revision, subjectRow.claim_revision, policyVersion);
  if (existing) return { manifest: existing, created: false };
  const id = manifestIdFor(projectId, nextSeq(db, projectId, "evidence_manifest"));
  const boundaryRow = db.prepare("SELECT next_commit_seq AS n FROM projects WHERE id = ?").get(projectId);
  db.prepare(
    `INSERT INTO evidence_manifests (id, project_id, subject_id, subject_kind, claim_revision,
       policy_version, evidence_revision, members, conditions, content_hash, created_at, created_by, created_seq)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    projectId,
    subjectId,
    subjectKind,
    subjectRow.claim_revision,
    policyVersion,
    subjectRow.evidence_revision,
    JSON.stringify(members),
    JSON.stringify(conditions),
    contentHash,
    new Date().toISOString(),
    actor,
    Math.max(1, boundaryRow.n - 1),
  );
  return { manifest: db.prepare("SELECT * FROM evidence_manifests WHERE id = ?").get(id), created: true };
}

function jobView(db, row) {
  const manifest = row.evidence_manifest_id
    ? manifestView(db.prepare("SELECT * FROM evidence_manifests WHERE id = ?").get(row.evidence_manifest_id))
    : null;
  const latest = db
    .prepare("SELECT * FROM verification_results WHERE job_id = ? ORDER BY created_seq DESC, rowid DESC LIMIT 1")
    .get(row.id);
  const createdMs = Date.parse(row.created_at);
  const subjectKind = toSemanticSubjectKind(row.subject_kind) || row.subject_kind;
  return {
    id: row.id,
    project_id: row.project_id,
    subject_id: row.subject_id,
    subject_kind: subjectKind, // P0-4：语义类型（observation/hypothesis/fact/vulnerability）
    subject_table: subjectTableOf(subjectKind), // 物理表名并存（定位与排查用）
    claim_revision: row.claim_revision,
    condition_snapshot_id: row.condition_snapshot_id,
    policy_id: row.policy_id,
    policy_version: row.policy_version,
    evidence_manifest_id: row.evidence_manifest_id,
    expected: {
      state_version: row.expected_state_version,
      evidence_revision: row.expected_evidence_revision,
      assessment_epoch: row.expected_assessment_epoch,
      claim_revision: row.claim_revision,
    },
    requested_by: row.requested_by,
    status: row.status,
    dedup_key: row.dedup_key,
    created_seq: row.created_seq,
    created_at: row.created_at,
    waiting_ms: Number.isFinite(createdMs) ? Math.max(0, Date.now() - createdMs) : null,
    manifest: manifest
      ? {
          id: manifest.id,
          evidence_revision: manifest.evidence_revision,
          claim_revision: manifest.claim_revision,
          policy_version: manifest.policy_version,
          members_count: manifest.members.length,
          conditions: manifest.conditions,
          content_hash: manifest.content_hash,
        }
      : null,
    latest_result: latest
      ? {
          id: latest.id,
          outcome: latest.outcome,
          applied: Boolean(latest.applied),
          verifier_identity: latest.verifier_identity,
          // 评审 §7b 后半（蓝图 §d-2）：verifier 提交过的审阅版本必须到达视图，
          // 不能因视图缺口恒显「未提供」（未提供 ≠ 不存在）
          reviewed_manifest_id: latest.reviewed_manifest_id || null,
          reviewed_evidence_revision: latest.reviewed_evidence_revision ?? null,
          created_at: latest.created_at,
        }
      : null,
  };
}

/* ── §12.2 核心事务：接收验证结果 ─────────────────────────────────── */

function requireString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw apiError("BAD_REQUEST", `验证结果缺少必填字段 ${field}（§8.3 VerificationResult 合同）`);
  }
  return value.trim();
}

/** 结果内容摘要（传输重试幂等：同 job 同内容 → 原回执，§13/§14.2 的等价保障）。 */
function resultDigest(input) {
  return sha256Hex(
    canonicalJson({
      job_id: input.job_id,
      // subject 由 job 唯一决定；condition_snapshot_id 由 job 承载（结果行回显 job 值），
      // 两者均不参与内容摘要，保证输入摘要与库行摘要可重算一致
      claim_revision: input.claim_revision,
      verifier_identity: input.verifier_identity,
      verifier_kind: input.verifier_kind,
      policy_version: input.policy_version,
      reviewed_manifest_id: input.reviewed_manifest_id,
      reviewed_evidence_revision: input.reviewed_evidence_revision,
      expected_state_version: input.expected_state_version,
      expected_assessment_epoch: input.expected_assessment_epoch,
      outcome: input.outcome,
      checks: input.checks ?? [],
      supporting_refs: input.supporting_refs ?? [],
      opposing_refs: input.opposing_refs ?? [],
      limitations: input.limitations ?? "",
      suggested_followups: input.suggested_followups ?? [],
    }),
  );
}

function rowDigest(row) {
  return sha256Hex(
    canonicalJson({
      job_id: row.job_id,
      claim_revision: row.claim_revision,
      verifier_identity: row.verifier_identity,
      verifier_kind: row.verifier_kind,
      policy_version: row.policy_version,
      reviewed_manifest_id: row.reviewed_manifest_id,
      reviewed_evidence_revision: row.reviewed_evidence_revision,
      expected_state_version: row.expected_state_version,
      expected_assessment_epoch: row.expected_assessment_epoch,
      outcome: row.outcome,
      checks: parseJson(row.checks, []),
      supporting_refs: parseJson(row.supporting_refs, []),
      opposing_refs: parseJson(row.opposing_refs, []),
      limitations: row.limitations,
      suggested_followups: parseJson(row.suggested_followups, []),
    }),
  );
}

function validateChecksShape(checks) {
  if (!Array.isArray(checks) || checks.length === 0) {
    throw apiError("BAD_REQUEST", "checks 必须是非空数组（§8.3：验证结果至少包含检查项结构）");
  }
  if (checks.length > 64) throw apiError("BAD_REQUEST", "checks 最多 64 项（资源上限）");
  const seen = new Set();
  return checks.map((c) => {
    if (!c || typeof c !== "object" || typeof c.name !== "string" || !c.name.trim()) {
      throw apiError("BAD_REQUEST", "每个检查项必须是含 name 字符段的对象");
    }
    if (typeof c.passed !== "boolean") {
      throw apiError("BAD_REQUEST", `检查项 ${c.name} 缺少布尔 passed`);
    }
    if (seen.has(c.name)) {
      throw apiError("BAD_REQUEST", `检查项名称重复：${c.name}`);
    }
    seen.add(c.name);
    return { name: c.name.trim(), passed: c.passed, note: typeof c.note === "string" ? c.note : "" };
  });
}

/**
 * 接收验证结果（#28，仅 verifier 会话，§8.3(1)）—— §12.2 核心事务：
 *   1. 校验验证身份（路由面）、判断版本、策略、Manifest 和引用；
 *   2. 保存不可变 VerificationResult（同内容重发返回原回执）；
 *   3. 同一 runSerial 事务内读 subject 三版本；
 *   4. 与申请的预期版本全部匹配且必需检查通过 → 经 §2.7 applyStateTransition
 *      应用状态转换（D2 唯一实现）；否则保留本次验证意见、标记需复核（仅当
 *      证据基线/判断核心移动）、不覆盖新结论；
 *   5. 同事务登记 Outbox（verification.completed；应用改变结论状态时另发状态事件）；
 *   6. 版本不匹配路径在事务提交后以 STALE_EVIDENCE / STALE_STATE / CLAIM_CHANGED
 *      错误信封返回，并携带已保存内容的回执（§20.1：不得用错误掩盖提交已成功）。
 */
export async function submitVerificationResult(pctx, { session, input }) {
  if (!input || typeof input !== "object") {
    throw apiError("BAD_REQUEST", "验证结果必须是 JSON 对象");
  }
  if ("project_id" in input) {
    throw apiError("BAD_REQUEST", "验证结果不得携带 project_id：由服务端会话决定（§11.1）");
  }
  const jobId = requireString(input.job_id, "job_id");
  const verifierIdentity = requireString(input.verifier_identity, "verifier_identity");
  if (!VERIFIER_KINDS.includes(input.verifier_kind)) {
    throw apiError("BAD_REQUEST", `verifier_kind 必须是 ${VERIFIER_KINDS.join(" / ")} 之一`);
  }
  if (!VERIFIER_OUTCOMES.includes(input.outcome)) {
    throw apiError("BAD_REQUEST", `outcome 必须是 ${VERIFIER_OUTCOMES.join(" / ")} 之一`);
  }
  for (const field of ["claim_revision", "reviewed_evidence_revision", "expected_state_version", "expected_assessment_epoch"]) {
    const v = input[field];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
      throw apiError("BAD_REQUEST", `字段 ${field} 必须是正整数（§8.3 VerificationResult 合同）`);
    }
  }
  const checks = validateChecksShape(input.checks);
  const policyVersion = requireString(input.policy_version, "policy_version");
  const reviewedManifestId = requireString(input.reviewed_manifest_id, "reviewed_manifest_id");
  const supportingRefs = input.supporting_refs === undefined ? [] : input.supporting_refs;
  const opposingRefs = input.opposing_refs === undefined ? [] : input.opposing_refs;
  const followups = input.suggested_followups === undefined ? [] : input.suggested_followups;
  if (!Array.isArray(followups) || followups.length > 32) {
    throw apiError("BAD_REQUEST", "suggested_followups 必须是 ≤32 项的数组");
  }
  const digest = resultDigest(input);
  const overturn = input.overturn === true;
  if (input.overturn !== undefined && typeof input.overturn !== "boolean") {
    throw apiError("BAD_REQUEST", "overturn 必须是布尔值（§8.4 confirmed→falsified 的显式推翻声明）");
  }
  // 应用/复核标记路径需要 §2.7 冻结签名（D2 落地版会回读结果行，故先落行再调用）；
  // 在事务外解析装配，事务内同步调用
  const applier = await resolveStateTransition();

  const store = await getStore(pctx);
  const outcome = await store.runSerial((db) => {
    /* ── 步骤 1：校验（判断版本 / 策略 / Manifest / 引用 / 独立性） ── */
    const job = db
      .prepare("SELECT * FROM verification_jobs WHERE id = ? AND project_id = ?")
      .get(jobId, session.project_id);
    if (!job) {
      throw apiError("INVALID_REFERENCE", `验证任务不存在（会话项目域内）：${jobId}`, {
        detail: { job_id: jobId },
      });
    }
    if (job.status === "superseded") {
      throw apiError("PRECONDITION_INVALID", `验证任务 ${jobId} 已被取代，不再接收结果`, {
        next_requirements: ["按当前证据集版本发起新的验证请求（§7.3 续验）"],
      });
    }
    const { table: subjectTable, row: subject } = requireJudgementSubject(db, session.project_id, job.subject_id);
    // §8.3(2)：发现者不得提交应用型结果（supported→确认 / falsified→排除）
    if (APPLICATION_OUTCOMES.has(input.outcome) && subject.created_by === session.actor) {
      throw apiError(
        "TRUST_DENIED",
        `发现者（created_by=${subject.created_by}）不得确认或推翻自己的判断（§2 约束 6 / §8.3）：应用型结果（${input.outcome}）必须由独立 verifier 提交`,
        {
          detail: { subject_id: job.subject_id, finder: subject.created_by, actor: session.actor, outcome: input.outcome },
          next_requirements: ["由其他 verifier 会话提交应用型结果；发现者本人仅可提交 insufficient / conflicting 意见"],
        },
      );
    }
    // 判断版本回执：结果核对的 claim_revision 必须与任务登记的一致
    if (input.claim_revision !== job.claim_revision) {
      throw apiError("CLAIM_CHANGED", `结果声明的 claim_revision（${input.claim_revision}）与任务登记（${job.claim_revision}）不一致`, {
        detail: { job_claim_revision: job.claim_revision, result_claim_revision: input.claim_revision },
        next_requirements: ["按任务登记的判断版本提交，或对修订后的判断发起新验证"],
      });
    }
    if (policyVersion !== job.policy_version) {
      throw apiError("PRECONDITION_INVALID", `结果声明的策略版本（${policyVersion}）与任务（${job.policy_version}）不一致（§12.2 步骤 1 校验策略）`, {
        next_requirements: ["按任务登记的策略版本提交结果"],
      });
    }
    const policy = requirePolicy(job.policy_id, job.policy_version);
    // Manifest 绑定：reviewed_manifest_id 必须是任务绑定的不可变清单，声明版本必须与清单一致（§12.1）
    const manifest = db.prepare("SELECT * FROM evidence_manifests WHERE id = ?").get(reviewedManifestId);
    if (!manifest || manifest.id !== job.evidence_manifest_id || manifest.project_id !== session.project_id) {
      throw apiError("PRECONDITION_INVALID", `reviewed_manifest_id 必须是验证任务 ${jobId} 绑定的 Manifest（${job.evidence_manifest_id}）（§12.1 reviewed_evidence_revision 必须绑定不可变 Manifest）`, {
        detail: { job_manifest_id: job.evidence_manifest_id, declared: reviewedManifestId },
        next_requirements: [`以 reviewed_manifest_id=${job.evidence_manifest_id} 提交`],
      });
    }
    if (input.reviewed_evidence_revision !== manifest.evidence_revision) {
      throw apiError("PRECONDITION_INVALID", `reviewed_evidence_revision（${input.reviewed_evidence_revision}）与所引 Manifest 的证据集版本（${manifest.evidence_revision}）不一致`, {
        detail: { manifest_evidence_revision: manifest.evidence_revision },
      });
    }
    if (input.expected_state_version !== job.expected_state_version || input.expected_assessment_epoch !== job.expected_assessment_epoch) {
      throw apiError("PRECONDITION_INVALID", "结果声明的 expected_state_version / expected_assessment_epoch 必须与任务登记一致（§12.2 步骤 1）", {
        detail: {
          job: { state_version: job.expected_state_version, assessment_epoch: job.expected_assessment_epoch },
          declared: { state_version: input.expected_state_version, assessment_epoch: input.expected_assessment_epoch },
        },
      });
    }
    validateEvidenceRefs(db, session.project_id, supportingRefs, "supporting_refs", { rawOnly: false });
    validateEvidenceRefs(db, session.project_id, opposingRefs, "opposing_refs", { rawOnly: false });

    // §8.3：检查项未覆盖时必须返回不足或冲突——应用型结果不得缺必需检查
    const submitted = new Set(checks.map((c) => c.name));
    const missing = policy.required_checks.filter((name) => !submitted.has(name));
    if (missing.length > 0 && APPLICATION_OUTCOMES.has(input.outcome)) {
      throw apiError(
        "PRECONDITION_INVALID",
        `策略 ${policy.id}@${policy.version} 必需检查未覆盖（缺 ${missing.join("、")}）：检查项未覆盖时必须返回 insufficient 或 conflicting，不得确认或排除（§8.3）`,
        {
          detail: { missing_required_checks: missing, required_checks: policy.required_checks },
          next_requirements: ["补齐必需检查项后重交，或将 outcome 改为 insufficient / conflicting"],
        },
      );
    }
    const failedRequired = checks.filter((c) => !c.passed && policy.required_checks.includes(c.name));

    /* ── 步骤 2：传输级幂等（同 job 同内容 → 原回执，不重复建行/事件） ── */
    const priorRows = db
      .prepare("SELECT * FROM verification_results WHERE job_id = ? AND project_id = ? ORDER BY created_seq, rowid")
      .all(jobId, session.project_id);
    const prior = priorRows.find((r) => rowDigest(r) === digest);
    if (prior) {
      return {
        kind: "deduplicated",
        receipt: resultReceipt(db, prior, { subjectTable, subject }),
      };
    }

    /* ── 步骤 3-5：保存 → 事务内读三版本 → 匹配且检查通过才应用 → 同事务 Outbox ── */
    const commitSeq = nextCommitSeq(db, session.project_id);
    const now = new Date().toISOString();
    const resultId = resultIdFor(session.project_id, nextSeq(db, session.project_id, "verification_result"));
    const before = subjectVersions(subject);
    const beforeStatus = subject.status;
    const beforeReview = REVIEW_TABLES.has(subjectTable) ? subject.review : null;
    const sink = makeEventSink();

    // 版本匹配判定（§12.2 步骤 4）：证据基线 / 判断核心 / 行状态逐项比对
    const mismatches = [];
    if (before.claim_revision !== job.claim_revision) mismatches.push("claim_revision");
    if (before.assessment_epoch !== job.expected_assessment_epoch) mismatches.push("assessment_epoch");
    if (before.evidence_revision !== job.expected_evidence_revision) mismatches.push("evidence_revision");
    if (before.state_version !== job.expected_state_version) mismatches.push("state_version");
    const versionsMatch = mismatches.length === 0;
    const checksPass = failedRequired.length === 0;
    const basisMoved =
      mismatches.includes("evidence_revision") || mismatches.includes("claim_revision") || mismatches.includes("assessment_epoch");
    let applied = false;
    let decision = null; // applied | no_transition | stale_evidence | claim_changed | stale_state | checks_failed | recorded
    let applierNote = null;

    // 先落不可变结果行（D2 落地版 applyStateTransition 按 verification_result_id 回读，
    // 其验证结果前提/检查项/发现者守卫均以库内行为准；applied 置位在后）
    db.prepare(
      `INSERT INTO verification_results (id, project_id, job_id, subject_id, claim_revision,
         condition_snapshot_id, verifier_identity, verifier_kind, policy_version, reviewed_manifest_id,
         reviewed_evidence_revision, expected_state_version, expected_assessment_epoch, outcome,
         checks, supporting_refs, opposing_refs, limitations, suggested_followups, applied,
         created_at, created_by, created_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    ).run(
      resultId,
      session.project_id,
      jobId,
      job.subject_id,
      input.claim_revision,
      typeof input.condition_snapshot_id === "string" && input.condition_snapshot_id ? input.condition_snapshot_id : job.condition_snapshot_id,
      verifierIdentity,
      input.verifier_kind,
      policyVersion,
      reviewedManifestId,
      input.reviewed_evidence_revision,
      input.expected_state_version,
      input.expected_assessment_epoch,
      input.outcome,
      JSON.stringify(checks),
      JSON.stringify(supportingRefs),
      JSON.stringify(opposingRefs),
      typeof input.limitations === "string" ? input.limitations : "",
      JSON.stringify(followups),
      now,
      session.actor,
      commitSeq,
    );

    /** 起点状态不被 §8.4 合同接受时降级为「保留意见、不转换」，不丢弃验证意见。 */
    const applyTransition = (action, { expected }) => {
      try {
        return applier.apply(
          db,
          {
            project_id: session.project_id,
            subject_kind: subjectTable,
            subject_id: job.subject_id,
            expected,
            action,
            verification_result_id: resultId,
          },
          { commitSeq, now, overturn },
        );
      } catch (error) {
        if (
          error &&
          error.code === "PRECONDITION_INVALID" &&
          error.extra &&
          error.extra.detail &&
          Array.isArray(error.extra.detail.allowed_from)
        ) {
          return { downgraded: true, note: error.message };
        }
        throw error;
      }
    };

    if (versionsMatch && checksPass) {
      const action = (TRANSITION_ACTIONS[subjectTable] || {})[input.outcome] ?? null;
      if (action === null) {
        // 该判断类别对该结论无验证驱动的转换（§8.4/路由表）：保存缺口/意见即可
        decision = "recorded";
      } else {
        const out = applyTransition(action, { expected: { ...before } });
        if (out && out.downgraded) {
          decision = "no_transition";
          applierNote = out.note;
        } else {
          applied = true;
          decision = "applied";
          // D2 返回的事件结构（dependency.changed / judgement.invalidated /
          // vulnerability.state_changed / judgement.state_changed）并入同事务 Outbox
          for (const ev of out.events || []) sink.events.push(ev);
        }
      }
    } else if (!versionsMatch) {
      // §12.2 否则分支：保留意见、标记需复核、不覆盖新结论。
      // 复核标记只在「证据基线或判断核心移动」时设置；state_version 单独移动
      // （如另一验证已应用）不构成新依据，不制造虚假冲突（§12.3 情形 3 反向保障、§16.3）
      decision =
        mismatches.includes("evidence_revision")
          ? "stale_evidence"
          : mismatches.includes("claim_revision") || mismatches.includes("assessment_epoch")
            ? "claim_changed"
            : "stale_state";
      if (REVIEW_TABLES.has(subjectTable) && basisMoved) {
        if (subject.status === "confirmed") {
          // confirmed 判断的复核标记走 D2 的 require_review（附带受影响依赖枚举事件）
          const out = applyTransition("require_review", { expected: { ...before } });
          if (!(out && out.downgraded)) {
            for (const ev of out.events || []) sink.events.push(ev);
          }
          // require_review 落地失败（如已被 A1 证据路径标记）不视为错误
        } else if (subject.review === "clear") {
          db.prepare(`UPDATE ${subjectTable} SET review = 'pending', updated_seq = ? WHERE id = ? AND project_id = ?`).run(
            commitSeq,
            job.subject_id,
            session.project_id,
          );
        }
      }
    } else {
      // 版本匹配但必需检查未通过：不应用，标记需复核（§12.2「全部匹配且检查通过」）
      decision = "checks_failed";
      if (REVIEW_TABLES.has(subjectTable) && subject.review === "clear") {
        db.prepare(`UPDATE ${subjectTable} SET review = 'pending', updated_seq = ? WHERE id = ? AND project_id = ?`).run(
          commitSeq,
          job.subject_id,
          session.project_id,
        );
      }
    }

    if (applied) {
      db.prepare("UPDATE verification_results SET applied = 1 WHERE id = ?").run(resultId);
    }
    db.prepare("UPDATE verification_jobs SET status = 'completed', updated_seq = ?, state_version = state_version + 1 WHERE id = ?").run(
      commitSeq,
      jobId,
    );

    // 同事务 Outbox：verification.completed（含未应用意见）；D2 转换事件已并入 sink
    const after = db.prepare(`SELECT * FROM ${subjectTable} WHERE id = ? AND project_id = ?`).get(job.subject_id, session.project_id);
    sink.emit("verification.completed", {
      subject_ids: [job.subject_id, resultId],
      changed_fields: ["verification"],
      payload: {
        result_id: resultId,
        job_id: jobId,
        subject_id: job.subject_id,
        subject_kind: toSemanticSubjectKind(job.subject_kind) || job.subject_kind,
        subject_table: subjectTable,
        outcome: input.outcome,
        applied,
        decision,
        verifier_identity: verifierIdentity,
        verifier_kind: input.verifier_kind,
        policy_version: policyVersion,
        reviewed_manifest_id: reviewedManifestId,
        reviewed_evidence_revision: input.reviewed_evidence_revision,
        review_before: beforeReview,
        review_after: REVIEW_TABLES.has(subjectTable) ? after.review : null,
        subject_status_before: beforeStatus,
        subject_status_after: after.status,
        ...(applierNote ? { transition_note: applierNote } : {}),
      },
    });
    flushEvents(db, {
      projectId: session.project_id,
      actor: session.actor,
      commitSeq,
      causeRef: resultId,
      events: sink.events,
      now,
    });
    const savedRow = db.prepare("SELECT * FROM verification_results WHERE id = ?").get(resultId);
    return {
      kind: "saved",
      decision,
      applied,
      mismatches,
      receipt: {
        ...resultReceipt(db, savedRow, { subjectTable, subject: after }),
        decision,
        applied,
        version_mismatches: mismatches,
        subject: {
          id: job.subject_id,
          kind: subjectTable,
          status: after.status,
          state_version: after.state_version,
          review: REVIEW_TABLES.has(subjectTable) ? after.review : null,
          versions: subjectVersions(after),
        },
      },
    };
  });

  if (outcome.kind === "deduplicated") return { ...outcome.receipt, deduplicated: true };
  // no_transition（§8.4 起点不被合同接受、意见保留）与 recorded / checks_failed 一样按成功保存返回；
  // 仅版本竞争（stale_* / claim_changed）按 §20.1 以错误信封带回执返回
  if (
    outcome.kind === "saved" &&
    !outcome.applied &&
    outcome.decision !== "recorded" &&
    outcome.decision !== "checks_failed" &&
    outcome.decision !== "no_transition"
  ) {
    // §20.1：提交已成功保存——错误信封带回执，不用错误掩盖
    const code =
      outcome.decision === "stale_evidence" ? "STALE_EVIDENCE" : outcome.decision === "claim_changed" ? "CLAIM_CHANGED" : "STALE_STATE";
    const mismatchNote = outcome.mismatches.length ? `（不匹配项：${outcome.mismatches.join("、")}）` : "";
    throw apiError(
      code,
      `验证意见已保存但未应用：subject 当前版本与验证任务预期不一致${mismatchNote}，不覆盖新结论（§12.2/§12.3）`,
      {
        receipt: outcome.receipt,
        next_requirements: [
          "按当前证据集版本发起新验证请求（§7.3 续验），或由 AI 复核新证据对判断的影响后再决定",
        ],
      },
    );
  }
  return outcome.receipt;
}

function resultReceipt(db, row, { subjectTable, subject }) {
  return {
    result_id: row.id,
    job_id: row.job_id,
    project_id: row.project_id,
    subject_id: row.subject_id,
    claim_revision: row.claim_revision,
    verifier_identity: row.verifier_identity,
    verifier_kind: row.verifier_kind,
    policy_version: row.policy_version,
    reviewed_manifest_id: row.reviewed_manifest_id,
    reviewed_evidence_revision: row.reviewed_evidence_revision,
    expected_state_version: row.expected_state_version,
    expected_assessment_epoch: row.expected_assessment_epoch,
    outcome: row.outcome,
    checks: parseJson(row.checks, []),
    supporting_refs: parseJson(row.supporting_refs, []),
    opposing_refs: parseJson(row.opposing_refs, []),
    limitations: row.limitations,
    suggested_followups: parseJson(row.suggested_followups, []),
    applied: Boolean(row.applied),
    created_at: row.created_at,
    created_by: row.created_by,
    commit_seq: row.created_seq,
    subject: subject
      ? {
          id: subject.id,
          kind: toSemanticSubjectKind(subjectTable) || subjectTable,
          table: subjectTable,
          status: subject.status,
          state_version: subject.state_version,
          review: REVIEW_TABLES.has(subjectTable) ? subject.review : null,
        }
      : null,
  };
}

/* ── 验证队列视图（#29，§8.3：验证队列等待时间是 §20.2 指标） ──────── */

export async function listVerificationJobs(pctx, { projectId, statuses, subjectId, outcome, limit, cursor }) {
  const store = await getStore(pctx);
  const db = store.db;
  const where = ["project_id = ?"];
  const args = [projectId];
  if (statuses && statuses.length) {
    where.push(`status IN (${statuses.map(() => "?").join(",")})`);
    args.push(...statuses);
  }
  if (subjectId) {
    where.push("subject_id = ?");
    args.push(subjectId);
  }
  if (cursor) {
    const m = /^(\d+):(.+)$/.exec(cursor);
    if (!m) throw apiError("BAD_REQUEST", "cursor 格式非法（应为 <created_seq>:<id>）");
    where.push("(created_seq > ? OR (created_seq = ? AND id > ?))");
    args.push(Number(m[1]), Number(m[1]), m[2]);
  }
  const cap = Math.min(Math.max(Number.isInteger(limit) ? limit : 50, 1), 200);
  const rows = db
    .prepare(`SELECT * FROM verification_jobs WHERE ${where.join(" AND ")} ORDER BY created_seq, id LIMIT ?`)
    .all(...args, cap + 1);
  const hasMore = rows.length > cap;
  const page = rows.slice(0, cap).map((r) => jobView(db, r));
  const filtered = outcome ? page.filter((j) => j.latest_result && j.latest_result.outcome === outcome) : page;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? `${last.created_seq}:${last.id}` : null;
  return {
    jobs: filtered,
    count: filtered.length,
    has_more: hasMore,
    // 游标统一（蓝图 §2.6-6）：next_cursor 为规范名；next_after 保留一个版本作
    // 兼容回填（同值，deprecated），既有调用方（verification.test.mjs 等）不破坏
    next_cursor: nextCursor,
    next_after: nextCursor,
    note: hasMore ? "存在更多验证任务；以 next_cursor 续读（游标分页，不静默截断）" : null,
  };
}

/* ── 准入检查（§8.2/§9.1：有效性 + 复核标记，不只看字符串 confirmed） ── */

/**
 * 判断对象能否作为「已满足的前提」被依赖（§8.2：依赖它执行的任务是否放行，
 * 应检查有效性和复核标记）。供 C2/E1/D3 等后续模块以存储级 API 调用
 * （蓝图 44 端点清单外不新增端点，A2 registerTransform 先例）。
 */
export async function evaluateAdmission(pctx, { projectId, subjectId, expectedStatus, expectedReview }) {
  const store = await getStore(pctx);
  const db = store.db;
  const located = locateRecord(db, projectId, subjectId);
  if (!located || !JUDGEMENT_SUBJECT_TABLES[located.table]) {
    return {
      admitted: false,
      subject_id: subjectId,
      reasons: ["对象不存在或不是判断类记录（hypotheses / facts / vulnerabilities）"],
    };
  }
  const table = JUDGEMENT_SUBJECT_TABLES[located.table];
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ? AND project_id = ?`).get(subjectId, projectId);
  const wantedStatus = Array.isArray(expectedStatus) && expectedStatus.length
    ? expectedStatus
    : DEFAULT_ADMITTED_STATUS[table];
  const wantedReview = typeof expectedReview === "string" ? expectedReview : "clear";
  const reasons = [];
  if (!wantedStatus.includes(row.status)) {
    reasons.push(`状态 ${row.status} 不在准入状态集 [${wantedStatus.join("、")}]（§8.2 有效性）`);
  }
  if (REVIEW_TABLES.has(table) && row.review !== wantedReview) {
    reasons.push(`复核标记 ${row.review} ≠ ${wantedReview}（§8.2：不能只检查字符串 confirmed，复核未清不得无条件放行）`);
  }
  return {
    admitted: reasons.length === 0,
    subject_id: subjectId,
    subject_kind: toSemanticSubjectKind(table) || table,
    subject_table: table,
    status: row.status,
    review: REVIEW_TABLES.has(table) ? row.review : null,
    versions: subjectVersions(row),
    reasons,
  };
}
