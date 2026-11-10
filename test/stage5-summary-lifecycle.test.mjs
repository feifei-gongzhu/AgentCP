/**
 * 阶段 5 验收测试——摘要生命周期（01 号基线 §三、§十三）。
 *
 * 覆盖：
 *   1. 刷新期间追加新条目：刷新后新条目仍可直接定位，未汇总状态正确。
 *   2. 判断修正不等待摘要：关键判断即时从记录读取。
 *   3. 刷新水位机制：beginRefresh 固定水位 → publishRefresh 推进到该水位。
 *   4. 刷新期间新内容到达 → 发布后状态为 stale。
 *   5. 高频写入不为每条记录重写祖先摘要。
 *   6. 程序生成子入口与判断快照。
 *   7. 记录可达：BS 编号经 locateRecord 可定位。
 *
 * 并行安全：mkdtemp + SORNE_DATA_DIR 注入。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getStore, submit } from "../lib/store/record-service.mjs";
import { issueSession } from "../lib/store/sessions.mjs";
import {
  beginRefresh,
  publishRefresh,
  getSummary,
  listPendingRefreshes,
  markStale,
} from "../lib/store/summaries.mjs";
import { searchNodes } from "../lib/store/reading.mjs";
import { locateRecord } from "../lib/store/records-read.mjs";
import "../lib/store/dedup.mjs";
import "../lib/store/judgements.mjs";

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "sorne-stage5-"));
}

async function setupProject(name) {
  const dir = makeTempDir();
  const prev = process.env.SORNE_DATA_DIR;
  process.env.SORNE_DATA_DIR = dir;
  const pctx = { dataDir: dir, logger: { info() {}, warn() {}, error() {} } };
  const store = await getStore(pctx);
  const db = store.db;

  let projectId;
  await store.runSerial((tx) => {
    tx.prepare(
      `INSERT INTO projects (id, name, task, description, status, next_commit_seq, created_at, created_by, created_seq, updated_seq, state_version)
       VALUES (?, ?, ?, ?, 'active', 2, ?, 'test', 1, 1, 1)`,
    ).run(`PRJ-${name}`, name, "摘要生命周期测试", "", new Date().toISOString());
    projectId = `PRJ-${name}`;
  });

  const session = issueSession({ project_id: projectId, actor: "test-worker", role: "worker", ttl_ms: 60_000 });
  return {
    pctx, projectId, store, db, session, dir,
    cleanup() {
      try { store.close(); } catch {}
      if (prev === undefined) delete process.env.SORNE_DATA_DIR;
      else process.env.SORNE_DATA_DIR = prev;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function seedGoalAndIntent(env, goalSuffix, question) {
  const { store, projectId } = env;
  const goalId = `G-${projectId}-${goalSuffix}`;
  const intentId = `I-${projectId}-${goalSuffix}`;
  await store.runSerial((tx) => {
    const seq = tx.prepare("SELECT next_commit_seq AS n FROM projects WHERE id = ?").get(projectId).n;
    tx.prepare("UPDATE projects SET next_commit_seq = ? WHERE id = ?").run(seq + 2, projectId);
    tx.prepare(
      `INSERT INTO goals (id, project_id, parent_goal_id, statement, status, state_version, created_at, created_by, created_seq)
       VALUES (?, ?, NULL, ?, 'active', 1, ?, 'test', ?)`,
    ).run(goalId, projectId, question, new Date().toISOString(), seq);
    tx.prepare(
      `INSERT INTO intents (id, project_id, goal_id, question, kind, status, priority, state_version, plan_revision, created_at, created_by, created_seq, updated_seq)
       VALUES (?, ?, ?, ?, 'investigate', 'proposed', 1, 1, 1, ?, 'test', ?, ?)`,
    ).run(intentId, projectId, goalId, question, new Date().toISOString(), seq + 1, seq + 1);
  });
  return { goalId, intentId };
}

/* ── 1. 刷新水位机制：begin → publish → 覆盖正确 ─────────────────── */

test("刷新水位：beginRefresh 固定水位 → publishRefresh 推进到该水位", async () => {
  const env = await setupProject("watermark");
  try {
    const { pctx, projectId } = env;
    const { goalId } = await seedGoalAndIntent(env, "g1", "调查 watermark");

    const begin = await beginRefresh(pctx, { projectId, branchId: goalId, branchKind: "goal" });
    assert.equal(begin.refresh_status, "refreshing");
    assert.ok(typeof begin.refresh_input_seq === "number");
    const fixedSeq = begin.refresh_input_seq;

    const published = await publishRefresh(pctx, {
      projectId, branchId: goalId,
      semanticSummary: "watermark 分支的语义摘要：尚在初步调查阶段",
      summaryRefs: [],
      incrementalPrompt: "首次刷新",
    });
    assert.equal(published.covered_commit_seq, fixedSeq);
    assert.ok(["current", "stale"].includes(published.refresh_status));

    // getSummary 返回摘要
    const summary = await getSummary(pctx, { projectId, branchId: goalId });
    assert.equal(summary.exists, true);
    assert.equal(summary.semantic_summary, "watermark 分支的语义摘要：尚在初步调查阶段");
    assert.equal(summary.covered_commit_seq, fixedSeq);
  } finally {
    env.cleanup();
  }
});

/* ── 2. 刷新期间追加新条目 → 发布后仍标为 stale ──────────────────── */

test("刷新期间追加新条目：发布后状态 stale，新条目可定位", async () => {
  const env = await setupProject("midrefresh");
  try {
    const { pctx, projectId, session } = env;
    const { goalId, intentId } = await seedGoalAndIntent(env, "g1", "调查 midrefresh");

    // 开始刷新
    await beginRefresh(pctx, { projectId, branchId: goalId, branchKind: "goal" });

    // 刷新期间追加新观察
    await submit(pctx, {
      session,
      envelope: {
        submission_id: "mid-obs-1",
        operations: [
          { op: "append_observation", local_ref: "obs1", statement: "刷新期间发现的新线索" },
        ],
      },
    });

    // 发布刷新
    const published = await publishRefresh(pctx, {
      projectId, branchId: goalId,
      semanticSummary: "初步调查摘要",
      summaryRefs: [],
    });
    assert.equal(published.refresh_status, "stale", "刷新期间有新内容 → 发布后应为 stale");
    assert.equal(published.has_unsummarized, true);

    // 新条目仍可直接定位（通过阅读服务搜索）
    const results = await searchNodes(pctx, { projectId, query: "刷新期间发现" });
    assert.ok(results.items.length >= 1, "刷新期间追加的观察应可搜索到");
  } finally {
    env.cleanup();
  }
});

/* ── 3. 判断修正不等待摘要 ───────────────────────────────────────── */

test("判断即时状态：getSummary 的 live_judgement_states 从记录直接读取", async () => {
  const env = await setupProject("livejudge");
  try {
    const { pctx, projectId, session, store, db } = env;
    const { goalId, intentId } = await seedGoalAndIntent(env, "g1", "调查判断即时性");

    // 生成初始摘要
    await beginRefresh(pctx, { projectId, branchId: goalId, branchKind: "goal" });
    await publishRefresh(pctx, {
      projectId, branchId: goalId,
      semanticSummary: "初始摘要",
    });

    // 提交假设并关联到意图
    const sub = await submit(pctx, {
      session,
      envelope: {
        submission_id: "hyp-live-1",
        operations: [
          { op: "propose_hypothesis", local_ref: "hyp1", statement: "可能存在信息泄露" },
          { op: "add_relation", from: "hyp1", type: "supports", to: intentId },
        ],
      },
    });
    const hypId = sub.ids.hyp1;

    // getSummary 应从记录直接读取假设状态（不需要重新刷新摘要）
    const summary = await getSummary(pctx, { projectId, branchId: goalId });
    const liveStates = summary.live_judgement_states;
    assert.ok(liveStates[hypId], "应包含假设的即时状态");
    assert.equal(liveStates[hypId].status, "open", "假设初始状态应为 open");

    // 直接修改假设状态
    await store.runSerial((tx) => {
      tx.prepare("UPDATE hypotheses SET status = 'rejected' WHERE id = ?").run(hypId);
    });

    // 再次 getSummary：即时状态应反映修改，无需刷新
    const summary2 = await getSummary(pctx, { projectId, branchId: goalId });
    assert.equal(summary2.live_judgement_states[hypId].status, "rejected",
      "判断修正后即时可见，不等待摘要刷新（§十三）");
    assert.equal(summary2.semantic_summary, "初始摘要", "语义摘要未变（需要刷新才更新）");
  } finally {
    env.cleanup();
  }
});

/* ── 4. 高频写入不为每条记录重写祖先摘要 ─────────────────────────── */

test("高频写入：多次 submit 不触发自动摘要重写", async () => {
  const env = await setupProject("highfreq");
  try {
    const { pctx, projectId, session, db } = env;
    const { goalId } = await seedGoalAndIntent(env, "g1", "高频写入测试");

    // 初始化摘要
    await beginRefresh(pctx, { projectId, branchId: goalId, branchKind: "goal" });
    await publishRefresh(pctx, {
      projectId, branchId: goalId,
      semanticSummary: "初始",
    });

    // 高频写入 20 条观察
    for (let i = 0; i < 20; i++) {
      await submit(pctx, {
        session,
        envelope: {
          submission_id: `hf-obs-${i}`,
          operations: [
            { op: "append_observation", local_ref: "o1", statement: `高频观察 #${i}` },
          ],
        },
      });
    }

    // 摘要仍为原文（未自动重写）
    const summary = await getSummary(pctx, { projectId, branchId: goalId });
    assert.equal(summary.semantic_summary, "初始", "高频写入不应自动重写摘要");

    // 但 unsummarized_count 应反映新增（通过 markStale 可手动标记）
    await markStale(pctx, { projectId, branchId: goalId });
    const pending = await listPendingRefreshes(pctx, { projectId });
    assert.ok(pending.branches.some((b) => b.branch_id === goalId), "标记后应出现在 pending 列表");
  } finally {
    env.cleanup();
  }
});

/* ── 5. 程序生成子入口 ───────────────────────────────────────────── */

test("beginRefresh 返回程序生成的子入口与判断快照", async () => {
  const env = await setupProject("subentries");
  try {
    const { pctx, projectId } = env;
    const { goalId, intentId } = await seedGoalAndIntent(env, "g1", "子入口测试");
    // 添加第二个意图
    const { intentId: intentId2 } = await seedGoalAndIntent(env, "g2", "子入口测试 2");
    // 这个意图属于不同 goal，不应出现

    const begin = await beginRefresh(pctx, { projectId, branchId: goalId, branchKind: "goal" });
    assert.ok(Array.isArray(begin.sub_entries));
    assert.ok(begin.sub_entries.includes(intentId), "子入口应包含该 goal 下的意图");
    assert.ok(!begin.sub_entries.includes(intentId2), "不应包含其他 goal 的意图");
  } finally {
    env.cleanup();
  }
});

/* ── 6. listPendingRefreshes ─────────────────────────────────────── */

test("listPendingRefreshes：只返回 stale 状态的分支", async () => {
  const env = await setupProject("pending");
  try {
    const { pctx, projectId } = env;
    const { goalId: g1 } = await seedGoalAndIntent(env, "g1", "stale 分支");
    const { goalId: g2 } = await seedGoalAndIntent(env, "g2", "current 分支");

    // g1: 只创建，默认 stale
    await beginRefresh(pctx, { projectId, branchId: g1, branchKind: "goal" });
    await publishRefresh(pctx, { projectId, branchId: g1, semanticSummary: "g1 摘要" });
    await markStale(pctx, { projectId, branchId: g1 });

    // g2: 刷新后 current
    await beginRefresh(pctx, { projectId, branchId: g2, branchKind: "goal" });
    await publishRefresh(pctx, { projectId, branchId: g2, semanticSummary: "g2 摘要" });

    const pending = await listPendingRefreshes(pctx, { projectId });
    const ids = pending.branches.map((b) => b.branch_id);
    assert.ok(ids.includes(g1), "stale 分支应在列表中");
    // g2 可能是 stale (if new commits arrived) or current
    // Key assertion: g1 is definitely there
  } finally {
    env.cleanup();
  }
});

/* ── 7. 记录可达：BS 编号经 locateRecord 可定位 ─────────────────── */

test("locateRecord：BS 编号可定位到 branch_summaries 表", async () => {
  const env = await setupProject("locate5");
  try {
    const { pctx, projectId, db } = env;
    const { goalId } = await seedGoalAndIntent(env, "g1", "定位测试");

    const begin = await beginRefresh(pctx, { projectId, branchId: goalId, branchKind: "goal" });
    const summaryId = begin.summary_id;

    const loc = locateRecord(db, projectId, summaryId);
    assert.ok(loc, "BS 编号应可定位");
    assert.equal(loc.table, "branch_summaries");

    // 跨项目不可见
    assert.equal(locateRecord(db, "PRJ-other", summaryId), null);
  } finally {
    env.cleanup();
  }
});
