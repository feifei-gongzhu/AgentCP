/**
 * F2 —— 运行指标（规范 §20.2）。
 *
 * 指标全集（§20.2 原文十类）与可观测口径（每类在返回值中带中文 note 说明口径，
 * 口径必须是库内可核对的事实，不虚构数值）：
 *   1. 保存延迟：staged Blob 滞留年龄（上传落 staging 后未固定/未登记，§13 中断
 *      残留）+ 采集→登记延迟（captures.observed_at→recorded_at，近 100 条）
 *      + 提交节奏（近 50 条 submissions 相邻 created_at 间隔；口径为节奏非延迟，
 *      服务端未记录请求受理起点，处理耗时不虚构）；
 *   2. Outbox 积压与重试：delivery_status 分布、最老 pending 事件年龄、
 *      delivery_attempts 总量/最大、failed 事件数（B2 偏差：pending→sent 为
 *      任一消费者投递即转的全局语义，各消费者真实进度在 consumer_receipts）；
 *   3. 投影滞后：各 kind 快照的 latest snapshot_commit_seq 对事件高水位的落后
 *      commit 数（无快照 kind 记 null 表示未投影，不冒充 0 滞后）；
 *   4. 未消费发现数量：晚于最新 planner_view 快照边界的观察/假设/漏洞计数
 *      （无 planner_view 快照时边界为 0，即全部尚未进入 Planner 视图）；
 *   5. 重复意图比例：按 question 分组的多副本意图（疑似语义重复的候选信号，
 *      是否合并归 AI 判断，§16.2/§7.3）；
 *   6. 无新增信息的重复执行：多 Attempt 意图分布 + 最新 Attempt 无任何成功
 *      工具调用的候选标记（程序供给信息，是否继续由 Orchestrator 评估，§16.3）；
 *   7. 验证队列等待时间：pending/in_progress 任务数与等待时长（数据时刻值）；
 *   8. 冲突类型：漏洞复核 disputed/pending、活跃反对证据成员、conflicting 验证
 *      结果、幂等拒绝提交的分类计数；
 *   9. 受阻方向恢复率：经 intent_state_history（C1 迁移 0003）进入过
 *      blocked/deferred 的意图中已恢复（当前状态离开受阻集）的比例；
 *  10. 证据容量及完整性异常：各项目 Blob 行数/字节数/存储状态分布 + 磁盘
 *      完整性核对（缺失/损坏/孤立文件，经 A2 findStorageAnomalies 真实读盘）。
 *
 * 另附 §1「运行状态与探索进展分开」的观测面：项目按
 * active/waiting_for_change/paused/stopped 分组计数（§16.4 四态）。
 * 漏洞数量不是唯一健康指标：本端点不突出漏洞计数，仅作为冲突/发现观测的
 * 组成部分呈现。
 *
 * 本模块只读：不写库、不发事件、不改任何状态；磁盘完整性核对只读文件字节。
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { getStore } from "./record-service.mjs";
import { findStorageAnomalies } from "./evidence.mjs";
import { evidenceDirs } from "./layout.mjs";

export const METRICS_SCHEMA_VERSION = 1;

const AGO_MS = (iso, now) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, now - t) : null;
};

const mean = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

function all(db, sql, ...args) {
  return db.prepare(sql).all(...args);
}
function get(db, sql, ...args) {
  return db.prepare(sql).get(...args);
}

/** staging 目录残留（A2 的 staged 语义：上传已落暂存、尚未固定/登记；§18.2 步骤 1「待固定上传」）。 */
function stagedUploads(dataDir, projectIds, now) {
  const files = [];
  for (const id of projectIds) {
    const { staging } = evidenceDirs(dataDir, id);
    let names = [];
    try {
      names = readdirSync(staging);
    } catch {
      continue; // 目录尚不存在：无残留
    }
    for (const name of names) {
      try {
        const mtimeMs = statSync(join(staging, name)).mtimeMs;
        files.push({ project_id: id, file: name, age_ms: Math.max(0, now - mtimeMs) });
      } catch {
        /* 文件在枚举后被清理：跳过 */
      }
    }
  }
  return files;
}

/* ── 1. 保存延迟（§20.2） ─────────────────────────────────────────── */

function saveLatency(db, projectIds, now, dataDir) {
  const inP = `(${projectIds.map(() => "?").join(",")})`;
  const staged = stagedUploads(dataDir, projectIds, now);
  const captureRows = projectIds.length
    ? all(
        db,
        `SELECT observed_at, recorded_at FROM captures
          WHERE project_id IN ${inP} AND observed_at IS NOT NULL AND recorded_at IS NOT NULL
          ORDER BY created_seq DESC LIMIT 100`,
        ...projectIds,
      )
    : [];
  const ingest = captureRows
    .map((r) => Date.parse(r.recorded_at) - Date.parse(r.observed_at))
    .filter((d) => Number.isFinite(d) && d >= 0);
  const subs = projectIds.length
    ? all(
        db,
        `SELECT created_at FROM submissions
          WHERE project_id IN ${inP} AND status = 'committed' ORDER BY created_at DESC LIMIT 50`,
        ...projectIds,
      )
    : [];
  const gaps = [];
  for (let i = 0; i + 1 < subs.length; i += 1) {
    const d = Date.parse(subs[i].created_at) - Date.parse(subs[i + 1].created_at);
    if (Number.isFinite(d) && d >= 0) gaps.push(d);
  }
  const stagedAges = staged.map((s) => s.age_ms);
  return {
    staged_uploads: {
      count: staged.length,
      oldest_age_ms: stagedAges.length ? Math.max(...stagedAges) : null,
      files: staged.slice(0, 20),
      note: "已落 evidence/staging 但尚未固定/登记的待固定上传（§13 中断残留，A2 的 staged 为目录暂存语义）；年龄为数据时刻值",
    },
    capture_ingest_delay_ms: {
      samples: ingest.length,
      avg: mean(ingest),
      max: ingest.length ? Math.max(...ingest) : null,
      note: "采集观察到登记入库的延迟（captures.observed_at→recorded_at，近 100 条）",
    },
    commit_pace_ms: {
      samples: gaps.length,
      avg: mean(gaps),
      max: gaps.length ? Math.max(...gaps) : null,
      note: "近 50 条成功提交的相邻间隔（提交节奏观测；服务端未记录请求受理起点，处理耗时不虚构）",
    },
  };
}

/* ── 2. Outbox 积压与重试（§20.2；B2 全局投递语义） ──────────────── */

function outboxMetrics(db, projectIds, now) {
  const by_status = { pending: 0, sent: 0, failed: 0, skipped: 0, total: 0 };
  let retryTotal = 0;
  let retryMax = 0;
  if (projectIds.length) {
    const inP = `(${projectIds.map(() => "?").join(",")})`;
    for (const r of all(db, `SELECT delivery_status AS s, COUNT(*) AS c, SUM(delivery_attempts) AS t, MAX(delivery_attempts) AS m
        FROM outbox WHERE project_id IN ${inP} GROUP BY delivery_status`, ...projectIds)) {
      by_status[r.s] = r.c;
      by_status.total += r.c;
      if (r.t) retryTotal += r.t;
      if (r.m && r.m > retryMax) retryMax = r.m;
    }
  }
  const oldestPending =
    projectIds.length
      ? get(
          db,
          `SELECT MIN(created_at) AS oldest FROM outbox
            WHERE project_id IN (${projectIds.map(() => "?").join(",")}) AND delivery_status = 'pending'`,
          ...projectIds,
        )
      : null;
  return {
    by_status,
    pending_oldest_age_ms: oldestPending && oldestPending.oldest ? AGO_MS(oldestPending.oldest, now) : null,
    retry_attempts: { total: retryTotal, max: retryMax },
    note: "delivery_status 为任一消费者投递即转 sent 的全局语义（B2）；各消费者真实进度在 consumer_receipts 与订阅 last_cursor；pending 事件由拉取式变化页补投递（§14.2 至少一次）",
  };
}

/* ── 3. 投影滞后（§20.2；§15.1 异步投影标注 commit_seq） ──────────── */

function projectionLag(db, projectIds) {
  const kinds = ["asset_map", "exploration_map", "planner_view", "context", "report"];
  const per_kind = {};
  if (!projectIds.length) return { per_kind, note: "" };
  const inP = `(${projectIds.map(() => "?").join(",")})`;
  const highWater =
    get(db, `SELECT MAX(commit_seq) AS h FROM outbox WHERE project_id IN ${inP}`, ...projectIds)?.h ?? 0;
  for (const kind of kinds) {
    const row = get(
      db,
      `SELECT MAX(snapshot_commit_seq) AS s, MAX(created_at) AS at FROM snapshots
        WHERE project_id IN ${inP} AND kind = ?`,
      ...projectIds,
      kind,
    );
    if (!row || row.s === null) {
      per_kind[kind] = { latest_snapshot_commit_seq: null, lag_commits: null, latest_age_note: "尚无该类快照（未投影，不冒充 0 滞后）" };
    } else {
      per_kind[kind] = {
        latest_snapshot_commit_seq: row.s,
        lag_commits: Math.max(0, highWater - row.s),
        latest_created_at: row.at,
      };
    }
  }
  return {
    high_watermark: highWater,
    per_kind,
    note: "滞后 = 事件高水位 − 该类最新快照 snapshot_commit_seq（commit 数口径）；快照为派生视图，可完全重建（§15.1）",
  };
}

/* ── 4. 未消费发现数量（§20.2） ───────────────────────────────────── */

function unconsumedFindings(db, projectIds) {
  if (!projectIds.length) {
    return { boundary: null, observations: 0, hypotheses: 0, vulnerabilities: 0 };
  }
  const inP = `(${projectIds.map(() => "?").join(",")})`;
  const boundaryRow = get(
    db,
    `SELECT MAX(snapshot_commit_seq) AS s FROM snapshots
      WHERE project_id IN ${inP} AND kind = 'planner_view'`,
    ...projectIds,
  );
  const boundary = boundaryRow && boundaryRow.s !== null ? boundaryRow.s : 0;
  const hasBoundary = Boolean(boundaryRow && boundaryRow.s !== null);
  const count = (table) =>
    get(
      db,
      `SELECT COUNT(*) AS c FROM ${table} WHERE project_id IN ${inP} AND created_seq > ?`,
      ...projectIds,
      boundary,
    ).c;
  return {
    boundary,
    boundary_kind: hasBoundary ? "planner_view 快照边界" : "无 planner_view 快照（边界取 0，即全部发现尚未进入 Planner 视图）",
    observations: count("observations"),
    hypotheses: count("hypotheses"),
    vulnerabilities: count("vulnerabilities"),
    note: "晚于最新 Planner 视图边界的发现计数（发现即时持久化 §2 约束 1；进入 Planner 视图即视为已供给规划）",
  };
}

/* ── 5. 重复意图比例（§20.2；疑似语义重复交 AI，§16.2） ───────────── */

function duplicateIntents(db, projectIds) {
  if (!projectIds.length) return { total_intents: 0, question_groups: 0, duplicated_intents: 0, ratio: null };
  const rows = all(
    db,
    `SELECT question, COUNT(*) AS c FROM intents
      WHERE project_id IN (${projectIds.map(() => "?").join(",")}) GROUP BY question`,
    ...projectIds,
  );
  const groups = rows.length;
  const duplicated = rows.filter((r) => r.c > 1);
  const duplicatedIntents = duplicated.reduce((a, r) => a + r.c, 0);
  const total = rows.reduce((a, r) => a + r.c, 0);
  return {
    total_intents: total,
    question_groups: groups,
    duplicated_intents: duplicatedIntents,
    duplicated_examples: duplicated.slice(0, 10).map((r) => ({ question: r.question, count: r.c })),
    ratio: total > 0 ? Number((duplicatedIntents / total).toFixed(4)) : null,
    note: "按 question 精确分组的多副本意图（重复候选信号）；疑似语义重复是否合并由 planner 判断，程序不强制（§16.2/§7.3）",
  };
}

/* ── 6. 无新增信息的重复执行（§20.2；§16.3 程序供给、AI 评估） ────── */

function repeatedExecution(db, projectIds) {
  if (!projectIds.length) {
    return { intents_with_multiple_attempts: 0, attempts_involved: 0, no_new_info_candidates: [] };
  }
  const inP = `(${projectIds.map(() => "?").join(",")})`;
  const rows = all(
    db,
    `SELECT intent_id, COUNT(*) AS attempts FROM attempts
      WHERE project_id IN ${inP} GROUP BY intent_id HAVING COUNT(*) > 1`,
    ...projectIds,
  );
  const candidates = [];
  for (const r of rows) {
    // 最新一次 Attempt 无任何成功工具调用 → 无新增信息的重复执行候选（程序标记，继续与否归 Orchestrator）
    const last = get(
      db,
      `SELECT a.id, (SELECT COUNT(*) FROM tool_calls t WHERE t.attempt_id = a.id AND t.status = 'succeeded') AS ok
         FROM attempts a WHERE a.project_id IN ${inP} AND a.intent_id = ?
         ORDER BY a.created_seq DESC, a.id DESC LIMIT 1`,
      ...projectIds,
      r.intent_id,
    );
    if (last && last.ok === 0) {
      candidates.push({ intent_id: r.intent_id, attempts: r.attempts, latest_attempt_id: last.id });
    }
  }
  return {
    intents_with_multiple_attempts: rows.length,
    attempts_involved: rows.reduce((a, r) => a + r.attempts, 0),
    distribution: rows.slice(0, 20).map((r) => ({ intent_id: r.intent_id, attempts: r.attempts })),
    no_new_info_candidates: candidates.slice(0, 20),
    note: "多 Attempt 意图分布；候选=最新 Attempt 无任何 succeeded 工具调用（程序供给的浪费资源信号，§16.3：是否继续/追问/换方法由 Orchestrator 评估并保存理由）",
  };
}

/* ── 7. 验证队列等待时间（§20.2，数据时刻值） ─────────────────────── */

function verificationQueue(db, projectIds, now) {
  if (!projectIds.length) return { pending: 0, in_progress: 0, oldest_waiting_ms: null, avg_waiting_ms: null };
  const inP = `(${projectIds.map(() => "?").join(",")})`;
  const rows = all(
    db,
    `SELECT status, created_at FROM verification_jobs
      WHERE project_id IN ${inP} AND status IN ('pending','in_progress')`,
    ...projectIds,
  );
  const waits = rows.map((r) => AGO_MS(r.created_at, now)).filter((v) => v !== null);
  return {
    pending: rows.filter((r) => r.status === "pending").length,
    in_progress: rows.filter((r) => r.status === "in_progress").length,
    oldest_waiting_ms: waits.length ? Math.max(...waits) : null,
    avg_waiting_ms: mean(waits),
    note: "等待时长按指标生成时刻计算（数据时刻快照值，不做实时计时）",
  };
}

/* ── 8. 冲突类型（§20.2 分类计数） ────────────────────────────────── */

function conflictTypes(db, projectIds) {
  const zero = {
    vulnerability_review_disputed: 0,
    vulnerability_review_pending: 0,
    contradicted_evidence_members: 0,
    conflicting_verification_results: 0,
    idempotency_rejections: 0,
  };
  if (!projectIds.length) return zero;
  const inP = `(${projectIds.map(() => "?").join(",")})`;
  const one = (sql) => get(db, sql, ...projectIds).c;
  return {
    vulnerability_review_disputed: one(
      `SELECT COUNT(*) AS c FROM vulnerabilities WHERE project_id IN ${inP} AND review = 'disputed'`,
    ),
    vulnerability_review_pending: one(
      `SELECT COUNT(*) AS c FROM vulnerabilities WHERE project_id IN ${inP} AND review = 'pending'`,
    ),
    contradicted_evidence_members: one(
      `SELECT COUNT(*) AS c FROM evidence_memberships WHERE project_id IN ${inP} AND stance = 'contradicts' AND status = 'active'`,
    ),
    conflicting_verification_results: one(
      `SELECT COUNT(*) AS c FROM verification_results WHERE project_id IN ${inP} AND outcome = 'conflicting'`,
    ),
    idempotency_rejections: one(
      `SELECT COUNT(*) AS c FROM submissions WHERE project_id IN ${inP} AND status = 'rejected'`,
    ),
    note: "冲突分类计数（复核争议/反对证据/矛盾验证结果/幂等拒绝）；实质矛盾的裁定归 verifier 或仲裁验证，planner 只安排工作（§12.3）",
  };
}

/* ── 9. 受阻方向恢复率（§20.2；历史经 C1 intent_state_history） ─────── */

function blockedRecovery(db, projectIds) {
  if (!projectIds.length) {
    return { ever_blocked: 0, currently_blocked: 0, recovered: 0, recovery_rate: null };
  }
  const inP = `(${projectIds.map(() => "?").join(",")})`;
  const everRows = all(
    db,
    `SELECT DISTINCT intent_id FROM intent_state_history
      WHERE project_id IN ${inP} AND to_status IN ('blocked','deferred')`,
    ...projectIds,
  );
  const ever = everRows.map((r) => r.intent_id);
  let recovered = 0;
  for (const intentId of ever) {
    const cur = get(
      db,
      `SELECT status FROM intents WHERE id = ? AND project_id IN ${inP}`,
      intentId,
      ...projectIds,
    );
    if (cur && ["proposed", "queued", "running", "resolved"].includes(cur.status)) recovered += 1;
  }
  const currently = get(
    db,
    `SELECT COUNT(*) AS c FROM intents WHERE project_id IN ${inP} AND status IN ('blocked','deferred')`,
    ...projectIds,
  ).c;
  return {
    ever_blocked: ever.length,
    currently_blocked: currently,
    recovered,
    recovery_rate: ever.length > 0 ? Number((recovered / ever.length).toFixed(4)) : null,
    note: "进入过 blocked/deferred 的意图中当前已恢复（离开受阻状态集）的比例；「恢复」包含 planner 重评估后的路径，程序不自动重派（§9.2/§3.2）",
  };
}

/* ── 10. 证据容量及完整性异常（§20.2；经 A2 真实读盘核对） ────────── */

async function evidenceStore(pctx, db, projectIds) {
  const per_project = {};
  for (const id of projectIds) {
    const agg = get(
      db,
      `SELECT COUNT(*) AS rows, IFNULL(SUM(byte_size),0) AS bytes FROM blobs WHERE project_id = ?`,
      id,
    );
    const statusRows = all(db, `SELECT storage_status AS s, COUNT(*) AS c FROM blobs WHERE project_id = ? GROUP BY storage_status`, id);
    const by_status = {};
    for (const r of statusRows) by_status[r.s] = r.c;
    let anomalies = { orphan_files: [], missing_files: [], mismatched_files: [] };
    try {
      anomalies = await findStorageAnomalies(pctx, { projectId: id });
    } catch (error) {
      anomalies = { error: error instanceof Error ? error.message : String(error), orphan_files: [], missing_files: [], mismatched_files: [] };
    }
    per_project[id] = {
      blob_rows: agg.rows,
      total_bytes: agg.bytes,
      by_storage_status: by_status,
      orphan_files: anomalies.orphan_files?.length ?? 0,
      missing_files: anomalies.missing_files?.length ?? 0,
      mismatched_files: anomalies.mismatched_files?.length ?? 0,
      anomaly_error: anomalies.error || null,
    };
  }
  return {
    per_project,
    note: "容量按 Blob 行数/字节数；完整性异常经真实读盘哈希核对（缺失/损坏/孤立文件，A2 findStorageAnomalies）；容量监控先于清理，首版不自动删除（§13）",
  };
}

/* ── 汇总入口 ─────────────────────────────────────────────────────── */

/**
 * 收集 §20.2 运行指标全集（只读）。
 * @param {{dataDir: string}} pctx
 * @param {{projectId?: string}} [opts] 指定项目域；缺省为全部项目
 */
export async function collectMetrics(pctx, { projectId } = {}) {
  const store = await getStore(pctx);
  const db = store.db;
  const now = Date.now();
  const projectRows = projectId
    ? all(db, "SELECT id, status FROM projects WHERE id = ?", projectId)
    : all(db, "SELECT id, status FROM projects");
  const projectIds = projectRows.map((r) => r.id);
  const by_status = { active: 0, waiting_for_change: 0, paused: 0, stopped: 0 };
  for (const r of projectRows) by_status[r.status] = (by_status[r.status] || 0) + 1;

  return {
    schema_version: METRICS_SCHEMA_VERSION,
    generated_at: new Date(now).toISOString(),
    scope: { project_id: projectId || null, projects: projectIds.length },
    projects: {
      by_status,
      total: projectIds.length,
      note: "运行状态与探索进展分开（§1）：没有可执行工作时进入等待条件变化的状态，等待不等于暂停，均不结束项目",
    },
    save_latency: saveLatency(db, projectIds, now, pctx.dataDir),
    outbox: outboxMetrics(db, projectIds, now),
    projection_lag: projectionLag(db, projectIds),
    unconsumed_findings: unconsumedFindings(db, projectIds),
    duplicate_intents: duplicateIntents(db, projectIds),
    repeated_execution: repeatedExecution(db, projectIds),
    verification_queue: verificationQueue(db, projectIds, now),
    conflicts: conflictTypes(db, projectIds),
    blocked_recovery: blockedRecovery(db, projectIds),
    evidence_store: await evidenceStore(pctx, db, projectIds),
    notes: [
      "指标用于发现长期运行是否正在浪费资源或遗漏成果（§20.2）；漏洞数量不是唯一健康指标",
      "全部指标为数据时刻的只读快照；等待类时长按 generated_at 计算",
    ],
  };
}

/** 演练报告落盘路径（work/ 工作区，§5.2；A2 layout.ensureWorkspace 同域用法）。 */
export function drillReportPath(dataDir, stamp) {
  return join(dataDir, "work", "recovery", "drills", `${stamp}.json`);
}
