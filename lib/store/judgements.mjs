/**
 * D2 —— 判断分层与漏洞状态机（规范 §8.1 §8.2 §8.4；蓝图 §2.7 冻结签名实现方）。
 *
 * 职责边界（§3.2：程序只做规范交给程序的校验与保障）：
 *   - §8.1 四类语义边界：Observation / Hypothesis / Fact / Vulnerability 不是同一行
 *     依次改类型的流水线（各自独立成行）；原观察永远保留；同一观察可支持或反对
 *     多个判断。观察/假设/漏洞（suspected）的写入通道由 A1 的 submission 操作集
 *     提供（append_observation / propose_hypothesis / report_vulnerability），
 *     本模块不重复实现；本模块补齐 **Fact 准入**：未经核实依据的判断不得写进
 *     Fact 表——「参数存在 SQL 注入」这类漏洞判断不能借 Fact 绕开漏洞验证
 *     （§8.1「确认准入根据判断类别执行」；蓝图 §8.2 worker 操作集不含 Fact）。
 *   - §8.2 状态与权限：Hypothesis 五态 / Fact 四态 / Vulnerability 四态 + 独立的
 *     review（clear/pending/disputed）；confirmed ≠ 持续存在；依赖放行检查必须
 *     同时看有效性与复核标记，不能只看字符串 confirmed。
 *   - §8.4 漏洞状态转换合同的**唯一实现**（全系统只有这一套状态机）：
 *     export function applyStateTransition(db, { project_id, subject_kind, subject_id,
 *       expected: { state_version, claim_revision, evidence_revision, assessment_epoch },
 *       action, verification_result_id, ...可选 opts })
 *     —— 在调用方事务内（§12.2 核心事务，D1 调用）按前提校验并写入新状态/版本/
 *     review；前提不满足抛 STALE_STATE / CLAIM_CHANGED / PRECONDITION_INVALID
 *     （证据集版本不匹配按 §5.3 错误码表抛 STALE_EVIDENCE；对象不存在抛
 *     INVALID_REFERENCE——均为 §20.1 注册表内语义码，非签名变更）。
 *
 * 事件说明：漏洞状态/复核变化发 vulnerability.state_changed（蓝图 §6 目录）；
 * 假设/事实的状态变化目录无对应类型，本模块新增 judgement.state_changed 并在
 * 竣工记录上报目录遗漏（A1 relation.added 同源问题）；推翻/失效类转换追发
 * judgement.invalidated；影响 requires 前提的转换追发 dependency.changed（强制
 * 通知类，§9.2/§15.5）。applyStateTransition 不直接写 outbox：它把事件结构返回
 * 给调用方（D1 在其 §12.2 事务内 flush）；opts.emit 提供时同时逐个送入。
 */
import { apiError } from "../errors.mjs";
import { getStore, GLOBAL_SEQ_SCOPE, registerSubmissionOps } from "./record-service.mjs";

/* ── §8.2 状态目录 ────────────────────────────────────────────────── */

export const VULNERABILITY_STATUSES = Object.freeze([
  "suspected",
  "confirmed",
  "falsified",
  "inconclusive",
]);
export const REVIEW_STATUSES = Object.freeze(["clear", "pending", "disputed"]);
export const HYPOTHESIS_STATUSES = Object.freeze([
  "open",
  "testing",
  "supported",
  "rejected",
  "inconclusive",
]);
export const FACT_STATUSES = Object.freeze([
  "verified",
  "disputed",
  "superseded",
  "retracted",
]);

/** §2.7 冻结签名的 subject_kind 解析（单复数均接受，映射到物理表）。 */
const SUBJECT_KINDS = Object.freeze({
  vulnerability: "vulnerabilities",
  vulnerabilities: "vulnerabilities",
  hypothesis: "hypotheses",
  hypotheses: "hypotheses",
  fact: "facts",
  facts: "facts",
});

const KIND_LABEL = Object.freeze({
  vulnerabilities: "漏洞",
  hypotheses: "假设",
  facts: "事实",
});

/* ── §8.4 状态转换合同表（唯一实现；D1 不得另行实现转换规则） ──────── */

const ANY_STATUS = "*";

/**
 * 字段语义：
 *   from              允许的起始状态（ANY_STATUS=任意；mark_insufficient 另做动态分流）
 *   to                目标状态（缺省=不变）
 *   review_to         目标复核状态（缺省=不变）
 *   vr_outcome        必须携带 verification_result_id 且其 outcome 等于该值（应用型转换）
 *   vr_optional       提供 verification_result_id 时校验 outcome 等于该值（非应用型）
 *   discoverer_guard  应用型转换执行「发现者 ≠ 验证结果提交者」（蓝图 §8.3.2）
 *   overturn_guard    从 confirmed 起点的推翻需显式 overturn=true（§8.4：
 *                     「新验证明确推翻历史判断，而非仅本次未复现」的显式声明）
 *   advance_epoch     falsified → 重新调查：推进 assessment_epoch，开启新一轮
 *                     验证，不直接确认（§8.4 末行）
 *   invalidates       追发 judgement.invalidated（判断失效/推翻，蓝图 §6）
 *   gate              重查受影响执行前提：枚举 requires 入边发 dependency.changed（§8.2/§9.2）
 */
const TRANSITIONS = Object.freeze({
  vulnerabilities: {
    confirm: {
      from: ["suspected", "inconclusive"],
      to: "confirmed",
      review_to: "clear",
      vr_outcome: "supported",
      discoverer_guard: true,
    },
    falsify: {
      from: ["suspected", "inconclusive", "confirmed"],
      to: "falsified",
      vr_outcome: "falsified",
      discoverer_guard: true,
      overturn_guard: true,
      invalidates: true,
      gate: true,
    },
    mark_insufficient: { from: ANY_STATUS, dynamic: "insufficient" },
    mark_conflicting: { from: ANY_STATUS, review_to: "disputed" },
    require_review: { from: ["confirmed"], review_to: "pending", gate: true },
    reopen: {
      from: ["falsified"],
      to: "suspected",
      advance_epoch: true,
      gate: true,
    },
  },
  hypotheses: {
    test: { from: ["open"], to: "testing" },
    support: { from: ["open", "testing", "inconclusive"], to: "supported", vr_optional: "supported" },
    reject: {
      from: ["open", "testing", "supported", "inconclusive"],
      to: "rejected",
      vr_optional: "falsified",
      invalidates: true,
    },
    mark_inconclusive: { from: ["open", "testing", "supported"], to: "inconclusive" },
  },
  facts: {
    dispute: { from: ["verified"], to: "disputed" },
    supersede: { from: ["verified", "disputed"], to: "superseded", invalidates: true },
    retract: { from: ["verified", "disputed", "superseded"], to: "retracted", invalidates: true },
  },
});

function allowedActions(table) {
  return Object.keys(TRANSITIONS[table]).join("、");
}

/* ── 版本与验证结果的前提校验（§8.4 前提列 / §12.2 步骤 3–4） ───────── */

function assertExpectedMatch(row, expected, table, id) {
  const e = expected || {};
  if (e.state_version != null && row.state_version !== e.state_version) {
    throw apiError("STALE_STATE", `${KIND_LABEL[table]} ${id} 的 state_version 已变化，拒绝转换（§8.4/§12.2）`, {
      detail: { current_state_version: row.state_version, expected_state_version: e.state_version },
      next_requirements: [`以 expected.state_version=${row.state_version} 重试`],
    });
  }
  if (e.claim_revision != null && row.claim_revision !== e.claim_revision) {
    throw apiError("CLAIM_CHANGED", `${KIND_LABEL[table]} ${id} 的 claim_revision 已推进（判断内容已变化，旧验证结果不能自动确认新判断，§11.3）`, {
      detail: { current_claim_revision: row.claim_revision, expected_claim_revision: e.claim_revision },
      next_requirements: [`判断内容已修改，需对 claim_revision=${row.claim_revision} 的新判断重新验证`],
    });
  }
  if (e.assessment_epoch != null && row.assessment_epoch !== e.assessment_epoch) {
    throw apiError("CLAIM_CHANGED", `${KIND_LABEL[table]} ${id} 的 assessment_epoch 已推进（判断已进入新一轮评估，§8.4）`, {
      detail: { current_assessment_epoch: row.assessment_epoch, expected_assessment_epoch: e.assessment_epoch },
      next_requirements: [`当前评估代际为 ${row.assessment_epoch}，需按当前代际重新验证`],
    });
  }
  if (e.evidence_revision != null && row.evidence_revision !== e.evidence_revision) {
    throw apiError("STALE_EVIDENCE", `${KIND_LABEL[table]} ${id} 的证据集版本已推进（新相关证据先提交），验证结果不直接改变状态（§12.3）`, {
      detail: { current_evidence_revision: row.evidence_revision, expected_evidence_revision: e.evidence_revision },
      next_requirements: [
        `以 expected.evidence_revision=${row.evidence_revision} 重新发起验证（或让验证方按新证据集续验）`,
      ],
    });
  }
}

function loadVerificationResult(db, projectId, vrId) {
  if (typeof vrId !== "string" || !vrId.trim()) {
    throw apiError("PRECONDITION_INVALID", "该转换必须携带 verification_result_id：只有独立验证结果才能驱动应用型状态转换（§8.4）", {
      next_requirements: ["先经验证流程（POST /verification-requests）取得验证结果"],
    });
  }
  const row = db
    .prepare("SELECT * FROM verification_results WHERE id = ? AND project_id = ?")
    .get(vrId, projectId);
  if (!row) {
    throw apiError("INVALID_REFERENCE", `验证结果不存在：${vrId}`, {
      next_requirements: [`先保存验证结果（D1 验证服务），再应用转换`],
    });
  }
  return row;
}

/** §8.4 confirmed 前提「必要检查通过」：checks 中任何显式未通过项 → 拒绝。 */
function assertRequiredChecksPass(vrRow) {
  let checks = [];
  try {
    const parsed = JSON.parse(vrRow.checks || "[]");
    if (Array.isArray(parsed)) checks = parsed;
  } catch {
    checks = [];
  }
  const failed = checks.filter(
    (c) =>
      c &&
      typeof c === "object" &&
      (c.passed === false || c.status === "failed" || c.status === "not_met"),
  );
  if (failed.length) {
    throw apiError("PRECONDITION_INVALID", `验证结果 ${vrRow.id} 有 ${failed.length} 项必要检查未通过，不满足确认前提（§8.4）`, {
      detail: { verification_result_id: vrRow.id, failed_checks: failed.length },
      next_requirements: ["补齐检查项后重新提交验证结果"],
    });
  }
}

/** 蓝图 §8.3.2：应用型转换的发现者（判断 created_by）≠ 验证结果提交者（vr.created_by）。 */
function assertDiscovererNotVerifier(subjectRow, vrRow, table, id) {
  if (subjectRow.created_by === vrRow.created_by) {
    throw apiError(
      "PRECONDITION_INVALID",
      `发现者不得自证（§2.6/§8.3）：${KIND_LABEL[table]} ${id} 的创建者（${subjectRow.created_by}）与验证结果 ${vrRow.id} 的提交者相同，独立验证必须由不同身份完成`,
      {
        detail: { subject_id: id, discoverer: subjectRow.created_by, verifier_submitter: vrRow.created_by },
        next_requirements: ["由其他 verifier 身份重新执行验证"],
      },
    );
  }
}

/** 受影响执行前提枚举（§8.2「重查必要执行前提」/§9.2 依赖变化事件）。 */
function affectedRequiresEdges(db, projectId, subjectId) {
  return db
    .prepare(
      `SELECT id, from_id, to_id FROM relations
         WHERE project_id = ? AND to_id = ? AND relation_type = 'requires' AND retracted_at IS NULL`,
    )
    .all(projectId, subjectId);
}

function dependencyChangeEvent(subjectId, change, edges) {
  return {
    event_type: "dependency.changed",
    subject_ids: [subjectId],
    changed_fields: ["requires"],
    cause_refs: [],
    payload: {
      subject_id: subjectId,
      change,
      affected_relations: edges.map((e) => e.id),
      affected_dependents: [...new Set(edges.map((e) => e.from_id))],
      note: "受影响依赖需重查必要执行前提；放行判定看有效性与复核标记，不能只看状态字符串（§8.2）",
    },
  };
}

/* ── §2.7 冻结签名：applyStateTransition（§8.4 唯一状态机实现） ─────── */

/**
 * 在调用方事务内应用 §8.4 状态转换（D1 的 §12.2 核心事务在完成身份/Manifest/
 * 版本校验后调用本函数；全系统不得另行实现转换规则）。
 *
 * @param {object} db 调用方事务内的数据库句柄（本函数不自行开事务）
 * @param {{project_id: string, subject_kind: string, subject_id: string,
 *          expected: {state_version?, claim_revision?, evidence_revision?, assessment_epoch?},
 *          action: string, verification_result_id?: string}} args 冻结签名参数
 * @param {{emit?: Function, actor?: string, now?: string, commitSeq?: number,
 *          overturn?: boolean, reason?: string, successor_ref?: string}} [opts]
 *        可选扩展（不破坏冻结签名）：emit 收集事件；overturn 显式推翻声明；
 *        reason 记录于事件 payload 供追溯。
 * @returns {{applied: boolean, subject: object, changed_fields: string[],
 *            events: Array, note?: string}}
 */
export function applyStateTransition(db, args, opts = {}) {
  const merged = { ...(args || {}), ...opts };
  const { project_id, subject_kind, subject_id, expected, action, verification_result_id } = merged;
  if (!project_id || typeof project_id !== "string") {
    throw apiError("BAD_REQUEST", "applyStateTransition 需要 project_id");
  }
  const table = SUBJECT_KINDS[String(subject_kind || "").toLowerCase()];
  if (!table) {
    throw apiError("BAD_REQUEST", `未知 subject_kind：${subject_kind}（允许：vulnerability / hypothesis / fact）`);
  }
  if (typeof subject_id !== "string" || !subject_id.trim()) {
    throw apiError("BAD_REQUEST", "applyStateTransition 需要 subject_id");
  }
  const def = (TRANSITIONS[table] || {})[action];
  if (!def) {
    throw apiError("BAD_REQUEST", `对象 ${subject_kind} 不支持动作 ${action}（允许：${allowedActions(table)}）`);
  }
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ? AND project_id = ?`).get(subject_id, project_id);
  if (!row) {
    throw apiError("INVALID_REFERENCE", `${KIND_LABEL[table]}不存在或不在项目内：${subject_id}`);
  }

  // 1) 验证结果前提（应用型转换）
  let vr = null;
  if (def.vr_outcome || verification_result_id != null) {
    vr = loadVerificationResult(db, project_id, verification_result_id);
    const want = def.vr_outcome || def.vr_optional;
    if (want && vr.outcome !== want) {
      throw apiError("PRECONDITION_INVALID", `验证结果 ${vr.id} 的 outcome 为 ${vr.outcome}，不满足动作 ${action} 所需的 ${want}（§8.4）`, {
        detail: { verification_result_id: vr.id, outcome: vr.outcome, required_outcome: want },
        next_requirements: [`按 outcome=${want} 的验证结果应用，或改用与其匹配的动作`],
      });
    }
    if (def.vr_outcome) {
      assertRequiredChecksPass(vr);
      // 一致性防御：验证结果声明审阅的证据集版本应与申请预期一致（§12.1/§12.3）
      if (
        expected &&
        expected.evidence_revision != null &&
        vr.reviewed_evidence_revision !== expected.evidence_revision
      ) {
        throw apiError("STALE_EVIDENCE", `验证结果 ${vr.id} 审阅的证据集版本（${vr.reviewed_evidence_revision}）与申请预期（${expected.evidence_revision}）不一致，不能应用（§12.1）`, {
          detail: {
            reviewed_evidence_revision: vr.reviewed_evidence_revision,
            expected_evidence_revision: expected.evidence_revision,
          },
        });
      }
    }
    if (def.discoverer_guard) {
      assertDiscovererNotVerifier(row, vr, table, subject_id);
    }
  }

  // 2) 版本匹配（§12.2 步骤 3–4：事务内读、原子判定）
  assertExpectedMatch(row, expected, table, subject_id);

  // 3) 起点状态与显式推翻声明
  if (def.from !== ANY_STATUS && !def.from.includes(row.status)) {
    throw apiError("PRECONDITION_INVALID", `${KIND_LABEL[table]} ${subject_id} 当前状态 ${row.status} 不允许执行 ${action}（§8.4 合同表）`, {
      detail: { current_status: row.status, action, allowed_from: def.from },
      next_requirements: [`合法动作：${allowedActions(table)}`],
    });
  }
  if (def.overturn_guard && row.status === "confirmed" && !merged.overturn) {
    throw apiError("PRECONDITION_INVALID", `对已确认判断的推翻必须显式声明 overturn=true（§8.4：新验证需明确推翻历史判断，而非仅本次未复现）`, {
      detail: { subject_id: subject_id, action },
      next_requirements: ["确认新验证为实质性推翻后携带 overturn=true 重试；仅本次未复现应走补验记录（insufficient）"],
    });
  }

  // 4) 计算目标状态/复核（mark_insufficient 动态分流，§8.4 表）
  let toStatus = "to" in def ? def.to : row.status;
  let toReview = row.review;
  let note;
  if (def.dynamic === "insufficient") {
    if (row.status === "confirmed") {
      // §8.4 末段：对 confirmed 的一次补验 insufficient 不自动证明原结论为假；
      // 记录本次不足及适用性变化（review=pending），状态与确认历史保留
      toStatus = row.status;
      toReview = "pending";
      note = "确认判断的补验不足：保留确认历史与状态，置 review=pending 记录适用性变化（§8.4）";
    } else if (row.status === "falsified") {
      toStatus = row.status;
      toReview = row.review;
      note = "已排除判断的补验不足：不改变原排除结论（重新调查走 reopen，§8.4）";
    } else {
      toStatus = "inconclusive";
      note = "未确认问题在证据不足时为 inconclusive，不伪装成已排除（§8.4）";
    }
  } else if (def.review_to) {
    toReview = def.review_to;
  }

  const statusChanged = toStatus !== row.status;
  const reviewChanged = table === "vulnerabilities" && toReview !== row.review;
  const epochAdvanced = Boolean(def.advance_epoch);
  if (!statusChanged && !reviewChanged && !epochAdvanced) {
    // 合同受理但无字段变化（如已 disputed 再报冲突）：如实返回，不虚增版本
    return {
      applied: true,
      subject: subjectSnapshot(table, row),
      changed_fields: [],
      events: [],
      note: `动作 ${action} 受理，但当前状态/复核已处于目标值，无字段变化`,
    };
  }

  // 5) 写入（同调用方事务）：状态/复核/版本/确认版本/评估代际
  const now = merged.now || new Date().toISOString();
  const updatedSeq = typeof merged.commitSeq === "number" ? merged.commitSeq : row.updated_seq + 1;
  const newStateVersion = row.state_version + 1;
  const sets = ["state_version = ?", "updated_seq = ?"];
  const setArgs = [newStateVersion, updatedSeq];
  const changedFields = ["state_version"];
  if (statusChanged) {
    sets.push("status = ?");
    setArgs.push(toStatus);
    changedFields.unshift("status");
  }
  if (reviewChanged) {
    sets.push("review = ?");
    setArgs.push(toReview);
    changedFields.unshift("review");
  }
  if (epochAdvanced) {
    sets.push("assessment_epoch = ?");
    setArgs.push(row.assessment_epoch + 1);
    changedFields.push("assessment_epoch");
  }
  if (action === "confirm") {
    const confirmedVersion = JSON.stringify({
      verification_result_id: vr ? vr.id : null,
      claim_revision: row.claim_revision,
      assessment_epoch: row.assessment_epoch,
      evidence_revision: row.evidence_revision,
      state_version: newStateVersion,
      confirmed_at: now,
    });
    sets.push("confirmed_version = ?");
    setArgs.push(confirmedVersion);
    changedFields.push("confirmed_version");
  }
  setArgs.push(subject_id, project_id);
  db.prepare(`UPDATE ${table} SET ${sets.join(", ")} WHERE id = ? AND project_id = ?`).run(...setArgs);

  // 6) 事件（返回给调用方在其事务内 flush；opts.emit 提供时同时送入）
  const events = [];
  const base = {
    subject_kind: table,
    subject_id: subject_id,
    action,
    from: row.status,
    to: toStatus,
    review_from: row.review,
    review_to: toReview,
    verification_result_id: vr ? vr.id : null,
  };
  if (merged.reason) base.reason = merged.reason;
  if (epochAdvanced) base.assessment_epoch = row.assessment_epoch + 1;
  if (action === "confirm") base.confirmed_note = "确认只在指定条件下成立，不代表持续存在（§8.2）";
  if (def.gate || def.invalidates) {
    const edges = affectedRequiresEdges(db, project_id, subject_id);
    if (edges.length) {
      events.push(
        dependencyChangeEvent(
          subject_id,
          def.invalidates ? "invalidated" : "review_required",
          edges,
        ),
      );
    }
  }
  if (def.invalidates) {
    events.push({
      event_type: "judgement.invalidated",
      subject_ids: [subject_id],
      changed_fields: ["status"],
      cause_refs: vr ? [vr.id] : [],
      payload: { ...base, kind: "invalidated" },
    });
  }
  events.push({
    event_type: table === "vulnerabilities" ? "vulnerability.state_changed" : "judgement.state_changed",
    subject_ids: [subject_id],
    changed_fields: changedFields,
    cause_refs: vr ? [vr.id] : [],
    payload: base,
  });
  if (typeof merged.emit === "function") {
    for (const ev of events) merged.emit(ev.event_type, ev);
  }

  const updated = db.prepare(`SELECT * FROM ${table} WHERE id = ? AND project_id = ?`).get(subject_id, project_id);
  return {
    applied: true,
    subject: subjectSnapshot(table, updated),
    changed_fields: changedFields,
    events,
    ...(note ? { note } : {}),
  };
}

function subjectSnapshot(table, row) {
  const snap = {
    kind: table,
    id: row.id,
    status: row.status,
    state_version: row.state_version,
    claim_revision: row.claim_revision,
    evidence_revision: row.evidence_revision,
    assessment_epoch: row.assessment_epoch,
  };
  if (table === "vulnerabilities") {
    snap.review = row.review;
    snap.confirmed_version = row.confirmed_version ? JSON.parse(row.confirmed_version) : null;
  }
  return snap;
}

/* ── §8.2 依赖放行检查：有效性与复核标记，不只看状态字符串 ──────────── */

/**
 * 解析 requires_state 的受控语法：
 *   "confirmed" / "supported" / "verified"（简写状态）
 *   "status=confirmed & review=clear"（& 或 , 或 ；分隔；显式 review 覆盖默认）
 * 解析失败返回 null（调用方保守拒绝，不默默放行）。
 */
export function parseRequiresState(requiresState) {
  if (requiresState == null) return {};
  if (typeof requiresState !== "string") return null;
  const text = requiresState.trim();
  if (!text) return {};
  const out = {};
  for (const rawPart of text.split(/&|,|，|；|;/)) {
    const part = rawPart.trim();
    if (!part) continue;
    let m = /^(?:status|状态)\s*=\s*([a-z_]+)$/i.exec(part);
    if (m) {
      if (out.status !== undefined) return null;
      out.status = m[1].toLowerCase();
      continue;
    }
    m = /^(?:review|复核)\s*=\s*(clear|pending|disputed)$/i.exec(part);
    if (m) {
      if (out.review !== undefined) return null;
      out.review = m[1].toLowerCase();
      continue;
    }
    m = /^([a-z_]+)$/i.exec(part);
    if (m) {
      if (out.status !== undefined) return null;
      out.status = m[1].toLowerCase();
      continue;
    }
    return null;
  }
  return out;
}

const PREREQUISITE_TABLES = Object.freeze([
  "vulnerabilities",
  "hypotheses",
  "facts",
  "intents",
]);

/**
 * 依赖放行判定（§8.2 末段）：依赖某判断执行的任务是否放行，检查有效性与复核
 * 标记，不能只检查字符串 confirmed。对漏洞：未显式声明 review 时默认叠加
 * review=clear 要求（confirmed ≠ 持续存在；review=pending/disputed 不放行）。
 */
export function evaluatePrerequisite(db, { project_id, ref, requires_state }) {
  let row = null;
  let table = null;
  for (const t of PREREQUISITE_TABLES) {
    const hit = db.prepare(`SELECT * FROM ${t} WHERE id = ? AND project_id = ?`).get(ref, project_id);
    if (hit) {
      row = hit;
      table = t;
      break;
    }
  }
  if (!row) {
    return {
      satisfied: false,
      ref,
      requirements: null,
      current: null,
      reason: `前提对象不存在或不在可判定表（漏洞/假设/事实/意图）内：${ref}`,
    };
  }
  const reqs = parseRequiresState(requires_state);
  if (reqs === null) {
    return {
      satisfied: false,
      ref,
      requirements: requires_state,
      current: subjectSnapshot(table, row),
      reason: `requires_state 无法解析（受控语法：'confirmed' 或 'status=confirmed & review=clear'）：${requires_state}；无法判定时保守拒绝`,
    };
  }
  if (!reqs.status) {
    return {
      satisfied: false,
      ref,
      requirements: requires_state,
      current: subjectSnapshot(table, row),
      reason: "requires_state 未声明目标状态：requires 边应注明需要的状态与适用条件（§9.1）",
    };
  }
  // §8.2：不能只看字符串 confirmed——漏洞默认叠加复核状态检查，除非显式放宽
  const needReview =
    reqs.review !== undefined ? reqs.review : table === "vulnerabilities" ? "clear" : null;
  const current = subjectSnapshot(table, row);
  if (row.status !== reqs.status) {
    return {
      satisfied: false,
      ref,
      requirements: reqs,
      current,
      reason: `目标要求状态 ${reqs.status}，当前状态 ${row.status}（${KIND_LABEL[table] || table} ${ref}）`,
    };
  }
  if (needReview) {
    const currentReview = table === "vulnerabilities" ? row.review : null;
    if (currentReview !== needReview) {
      return {
        satisfied: false,
        ref,
        requirements: { ...reqs, review: needReview },
        current,
        reason:
          table === "vulnerabilities"
            ? `漏洞 ${ref} 状态为 ${row.status} 但复核状态为 ${row.review}：confirmed 只说明在指定条件下得到确认，不代表持续存在；复核未清不得放行（§8.2）`
            : `对象类型 ${table} 无独立复核状态，无法满足 review=${needReview}`,
      };
    }
  }
  return {
    satisfied: true,
    ref,
    requirements: { ...reqs, ...(needReview ? { review: needReview } : {}) },
    current,
    reason: `状态 ${row.status}${needReview ? ` 且复核 ${needReview}` : ""} 满足前提`,
  };
}

/* ── §8.1 Fact 准入（提交操作：未经核实的判断不得写进 Fact 表） ──────── */

function verificationResultRow(ctx, id) {
  const row = ctx.db
    .prepare("SELECT * FROM verification_results WHERE id = ? AND project_id = ?")
    .get(id, ctx.projectId);
  if (!row) {
    throw apiError("INVALID_REFERENCE", `verification_refs 引用的验证结果不存在：${id}`, {
      next_requirements: ["先经验证流程保存验证结果，再归档事实"],
    });
  }
  return row;
}

function opRecordFact(ctx, op) {
  const statement = reqStr(op, "statement");
  const refs = op.verification_refs;
  if (!Array.isArray(refs) || refs.length === 0) {
    throw apiError(
      "PRECONDITION_INVALID",
      "Fact 必须注明核实依据（verification_refs 非空，§8.1）：未经核实的判断应作为 Hypothesis 提交；漏洞判断必须走漏洞记录与独立验证，不能通过写进 Fact 绕开验证（§8.1 准入按判断类别执行）",
      {
        next_requirements: [
          "携带 verification_refs: [{source:'verification_result', id} 或 {source:'versioned_rule', rule_id, rule_version}]",
          "未经核实的判断改用 propose_hypothesis；漏洞判断改用 report_vulnerability",
        ],
      },
    );
  }
  const normalized = [];
  for (const r of refs) {
    const entry =
      typeof r === "string"
        ? { source: "verification_result", id: r }
        : r && typeof r === "object"
          ? r
          : null;
    if (!entry) {
      throw apiError("BAD_REQUEST", "verification_refs 的成员必须是编号字符串或 {source,...} 对象");
    }
    if (entry.source === "verification_result" || typeof r === "string") {
      const row = verificationResultRow(ctx, entry.id);
      if (row.outcome !== "supported") {
        throw apiError("PRECONDITION_INVALID", `验证结果 ${row.id} 的 outcome 为 ${row.outcome}：只有 supported（核实通过）的判断才可作为 Fact 归档（§8.1）`, {
          detail: { verification_result_id: row.id, outcome: row.outcome },
        });
      }
      normalized.push({ source: "verification_result", id: row.id, outcome: row.outcome });
    } else if (entry.source === "versioned_rule") {
      if (typeof entry.rule_id !== "string" || !entry.rule_id.trim() || typeof entry.rule_version !== "string" || !entry.rule_version.trim()) {
        throw apiError("BAD_REQUEST", "versioned_rule 引用必须同时提供 rule_id 与 rule_version（§8.1「经过相应规则……核实」，规则需可追溯版本）");
      }
      normalized.push({ source: "versioned_rule", rule_id: entry.rule_id, rule_version: entry.rule_version });
    } else {
      throw apiError("BAD_REQUEST", `verification_refs 的 source 非法：${entry.source}（允许 verification_result / versioned_rule）`);
    }
  }
  // F-nnnn 为全局主键编号 → 全局序列（跨项目不撞 facts.id）
  const id = formatSeqId("F", allocateSeq(ctx.db, GLOBAL_SEQ_SCOPE, "fact"));
  ctx.db
    .prepare(
      `INSERT INTO facts (id, project_id, statement, conditions, status, verification_refs,
         created_at, created_by, created_seq, updated_seq, state_version, claim_revision,
         evidence_revision, assessment_epoch)
       VALUES (?, ?, ?, ?, 'verified', ?, ?, ?, ?, ?, 1, 1, 1, 1)`,
    )
    .run(
      id,
      ctx.projectId,
      statement,
      toJsonArr(op.conditions, "conditions", op.op),
      JSON.stringify(normalized),
      ctx.now,
      ctx.actor,
      ctx.commitSeq,
      ctx.commitSeq,
    );
  if (op.local_ref) ctx.ids[op.local_ref] = id;
  ctx.emit("judgement.state_changed", {
    subject_ids: [id],
    changed_fields: ["status"],
    payload: {
      subject_kind: "facts",
      subject_id: id,
      action: "record",
      from: null,
      to: "verified",
      statement: truncate(statement),
      verification: normalized,
      note: "Fact 归档已核实判断；适用条件见 conditions（§8.1）",
    },
  });
  return { id };
}

/* ── 提交操作注册（经 A1 registerSubmissionOps 扩展点，不改其文件） ──── */

registerSubmissionOps("D2/judgements", [
  {
    name: "record_fact",
    kind: "append",
    // 蓝图 §8.2：worker 操作集不含 Fact（漏洞判断不得借 Fact 绕过验证）；
    // Fact 由验证流程核实后归档（verifier 会话），发现者自报不构成核实。
    roles: ["verifier"],
    handler: opRecordFact,
  },
]);

/* ── #30 漏洞台账视图（§8.2 状态与复核分列；§19 条件与证据入口） ────── */

function vulnerabilityView(row, evidenceCounts, groups) {
  return {
    id: row.id,
    project_id: row.project_id,
    asset_id: row.asset_id,
    location: row.location,
    category: row.category,
    status: row.status,
    review: row.review,
    impact: row.impact,
    conditions: JSON.parse(row.conditions || "[]"),
    confirmed_version: row.confirmed_version ? JSON.parse(row.confirmed_version) : null,
    state_version: row.state_version,
    claim_revision: row.claim_revision,
    evidence_revision: row.evidence_revision,
    assessment_epoch: row.assessment_epoch,
    created_at: row.created_at,
    created_by: row.created_by,
    updated_seq: row.updated_seq,
    evidence: evidenceCounts,
    candidate_groups: groups,
  };
}

export async function listVulnerabilities(
  pctx,
  { projectId, statuses, reviews, assetId, category, limit, cursor },
) {
  const store = await getStore(pctx);
  const db = store.db;
  const project = db.prepare("SELECT id FROM projects WHERE id = ?").get(projectId);
  if (!project) {
    throw apiError("NOT_FOUND", `项目不存在：${projectId}`);
  }
  const baseConditions = ["v.project_id = ?"];
  const baseArgs = [projectId];
  if (statuses && statuses.length) {
    baseConditions.push(`v.status IN (${statuses.map(() => "?").join(",")})`);
    baseArgs.push(...statuses);
  }
  if (reviews && reviews.length) {
    baseConditions.push(`v.review IN (${reviews.map(() => "?").join(",")})`);
    baseArgs.push(...reviews);
  }
  if (assetId) {
    baseConditions.push("v.asset_id = ?");
    baseArgs.push(assetId);
  }
  if (category) {
    baseConditions.push("v.category = ?");
    baseArgs.push(category);
  }
  const total = db
    .prepare(`SELECT COUNT(*) AS c FROM vulnerabilities v WHERE ${baseConditions.join(" AND ")}`)
    .get(...baseArgs).c;
  const conditions = [...baseConditions];
  const args = [...baseArgs];
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
  if (afterSeq !== null) {
    conditions.push("(v.created_seq > ? OR (v.created_seq = ? AND v.id > ?))");
    args.push(afterSeq, afterSeq, afterId);
  }
  const pageLimit = Math.min(Math.max(limit ?? 50, 1), 200);
  const rows = db
    .prepare(
      `SELECT v.* FROM vulnerabilities v WHERE ${conditions.join(" AND ")}
         ORDER BY v.created_seq, v.id LIMIT ?`,
    )
    .all(...args, pageLimit + 1);
  const hasMore = rows.length > pageLimit;
  const page = rows.slice(0, pageLimit);

  const views = page.map((row) => vulnerabilityView(row, { supports: 0, contradicts: 0, total: 0 }, []));
  if (page.length) {
    const marks = page.map(() => "?").join(",");
    const ids = page.map((r) => r.id);
    const evRows = db
      .prepare(
        `SELECT subject_id, stance FROM evidence_memberships
           WHERE project_id = ? AND subject_id IN (${marks}) AND status = 'active'`,
      )
      .all(projectId, ...ids);
    const evMap = new Map();
    for (const e of evRows) {
      if (!evMap.has(e.subject_id)) evMap.set(e.subject_id, { supports: 0, contradicts: 0, total: 0 });
      const bucket = evMap.get(e.subject_id);
      if (e.stance === "supports") bucket.supports += 1;
      if (e.stance === "contradicts") bucket.contradicts += 1;
      bucket.total += 1;
    }
    const groupRows = db
      .prepare(
        `SELECT m.member_id, g.id AS group_id, g.group_key, g.status AS group_status
           FROM memberships m JOIN candidate_groups g ON g.id = m.group_id
           WHERE m.project_id = ? AND m.member_kind = 'vulnerability' AND m.member_id IN (${marks})`,
      )
      .all(projectId, ...ids);
    const groupMap = new Map();
    for (const g of groupRows) {
      if (!groupMap.has(g.member_id)) groupMap.set(g.member_id, []);
      groupMap.get(g.member_id).push({ id: g.group_id, group_key: g.group_key, status: g.group_status });
    }
    views.forEach((view, i) => {
      view.evidence = evMap.get(view.id) || { supports: 0, contradicts: 0, total: 0 };
      view.candidate_groups = groupMap.get(view.id) || [];
    });
  }
  const last = page[page.length - 1];
  return {
    project_id: projectId,
    vulnerabilities: views,
    total,
    next_cursor: hasMore && last ? `${last.created_seq}:${last.id}` : null,
    has_more: hasMore,
    note: "status 为结论状态、review 为复核状态，二者独立（§8.2）；confirmed 只说明在指定条件下得到确认，不代表持续存在",
  };
}

/* ── 本文件内部使用的 A1 同形小工具（不 import 其私有实现） ─────────── */

function allocateSeq(db, projectId, kind) {
  db.prepare(
    "INSERT INTO id_sequences (project_id, kind, next_val) VALUES (?, ?, 2) ON CONFLICT DO NOTHING",
  ).run(projectId, kind);
  const row = db.prepare("SELECT next_val AS n FROM id_sequences WHERE project_id = ? AND kind = ?").get(projectId, kind);
  db.prepare("UPDATE id_sequences SET next_val = ? WHERE project_id = ? AND kind = ?").run(row.n + 1, projectId, kind);
  return row.n;
}

function formatSeqId(prefix, n, width = 4) {
  return `${prefix}-${String(n).padStart(width, "0")}`;
}

function truncate(text, max = 160) {
  const s = String(text);
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

function reqStr(op, field) {
  const v = op[field];
  if (typeof v !== "string" || !v.trim()) {
    throw apiError("BAD_REQUEST", `操作 ${op.op} 缺少必填字段 ${field}`);
  }
  return v;
}

function toJsonArr(value, field, opName) {
  if (value === undefined || value === null) return "[]";
  if (Array.isArray(value)) return JSON.stringify(value);
  throw apiError("BAD_REQUEST", `操作 ${opName} 的字段 ${field} 必须是数组`);
}
