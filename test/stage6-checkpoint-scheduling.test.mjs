/**
 * 阶段 6 验收测试——检查点、交接与长期调度（01 号基线 §十一、§十二、§十四至§十六）。
 *
 * 覆盖：
 *   1. 检查点创建与恢复：阶段边界检查点包含完整接手信息。
 *   2. 旧检查点引用：检查点是派生资料，恢复时从持久记录读取当前状态。
 *   3. 分支搁置：记录原因、范围和重新考虑的条件；重复搁置幂等。
 *   4. 分支恢复：恢复后状态变更为 resumed。
 *   5. 唤醒条件：搁置后新事件匹配 wake_on_event_types 时报告可唤醒。
 *   6. 无变化等待：assessWaiting 判定无可执行工作。
 *   7. 重复交接幂等：同一 submission_id 的交接不重复创建。
 *   8. 记录可达：SH 编号经 locateRecord 可定位。
 *   9. recoverContext 组合：检查点 + 等待状态 + 唤醒条件一次获取。
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
import { createCheckpoint, latestCheckpoint, assessWaiting } from "../lib/store/recovery.mjs";
import {
  shelveBranch,
  resumeBranch,
  listShelvedBranches,
  evaluateWakeConditions,
  phaseBoundaryCheckpoint,
  recoverContext,
} from "../lib/store/scheduling.mjs";
import { locateRecord } from "../lib/store/records-read.mjs";
import "../lib/store/dedup.mjs";
import "../lib/store/judgements.mjs";

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "sorne-stage6-"));
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
    ).run(`PRJ-${name}`, name, "检查点调度测试", "", new Date().toISOString());
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

async function seedIntent(env, suffix, question) {
  const { store, projectId } = env;
  const intentId = `I-${projectId}-${suffix}`;
  await store.runSerial((tx) => {
    const seq = tx.prepare("SELECT next_commit_seq AS n FROM projects WHERE id = ?").get(projectId).n;
    tx.prepare("UPDATE projects SET next_commit_seq = ? WHERE id = ?").run(seq + 1, projectId);
    tx.prepare(
      `INSERT INTO intents (id, project_id, question, kind, status, priority, state_version, plan_revision, created_at, created_by, created_seq, updated_seq)
       VALUES (?, ?, ?, 'investigate', 'proposed', 1, 1, 1, ?, 'test', ?, ?)`,
    ).run(intentId, projectId, question, new Date().toISOString(), seq, seq);
  });
  return intentId;
}

/* ── 1. 检查点创建与恢复 ─────────────────────────────────────────── */

test("阶段边界检查点：包含意图、判断、工具调用等接手信息", async () => {
  const env = await setupProject("cp1");
  try {
    const { pctx, projectId } = env;
    const intentId = await seedIntent(env, "i1", "检查点测试");

    const cp = await phaseBoundaryCheckpoint(pctx, {
      projectId, intentId, actor: "test-orch",
      phaseNote: "第一阶段完成",
    });
    assert.ok(cp.checkpoint_id.startsWith("CP-"));
    assert.ok(cp.content);
    assert.equal(cp.content.intent.id, intentId);
    assert.equal(cp.content.current_question, "检查点测试");
    assert.ok(typeof cp.processed_boundary === "number" || typeof cp.processed_boundary === "string");

    // latestCheckpoint 返回同一份
    const latest = await latestCheckpoint(pctx, { projectId });
    assert.equal(latest.checkpoint_id, cp.checkpoint_id);
  } finally {
    env.cleanup();
  }
});

/* ── 2. 旧检查点引用：恢复时从记录读取当前状态 ──────────────────── */

test("检查点是恢复入口：修改记录后 createCheckpoint 反映当前状态", async () => {
  const env = await setupProject("stale-cp");
  try {
    const { pctx, projectId, store } = env;
    const intentId = await seedIntent(env, "i1", "状态变化测试");

    // 创建检查点（意图状态 proposed）
    const cp1 = await createCheckpoint(pctx, { projectId, intentId, actor: "test" });
    assert.equal(cp1.content.intent.status, "proposed");

    // 修改意图状态
    await store.runSerial((tx) => {
      tx.prepare("UPDATE intents SET status = 'running' WHERE id = ?").run(intentId);
    });

    // 新检查点反映当前状态
    const cp2 = await createCheckpoint(pctx, { projectId, intentId, actor: "test" });
    assert.equal(cp2.content.intent.status, "running", "新检查点应反映当前记录状态");
    assert.notEqual(cp2.checkpoint_id, cp1.checkpoint_id);
  } finally {
    env.cleanup();
  }
});

/* ── 3. 分支搁置 ─────────────────────────────────────────────────── */

test("shelveBranch：记录原因、范围和唤醒条件；重复搁置幂等", async () => {
  const env = await setupProject("shelve");
  try {
    const { pctx, projectId } = env;
    const intentId = await seedIntent(env, "i1", "搁置测试");

    const result = await shelveBranch(pctx, {
      projectId,
      branchId: intentId,
      branchKind: "intent",
      shelveReason: "insufficient_evidence",
      reasonDetail: "缺少服务端行为的直接证据",
      scope: "仅暂停该意图的主动执行",
      reconsiderConditions: ["获取到服务端日志", "发现新的 API 端点"],
      wakeOnEventTypes: ["submission.committed", "extraction.batch_committed"],
      actor: "test-orch",
    });
    assert.ok(result.shelving_id.startsWith("SH-"));
    assert.equal(result.shelve_reason, "insufficient_evidence");
    assert.equal(result.status, "shelved");

    // 重复搁置幂等
    const dup = await shelveBranch(pctx, {
      projectId, branchId: intentId,
      shelveReason: "insufficient_evidence", actor: "test-orch",
    });
    assert.equal(dup.already_shelved, true);
    assert.equal(dup.shelving_id, result.shelving_id);

    // 列出搁置分支
    const list = await listShelvedBranches(pctx, { projectId });
    assert.equal(list.total, 1);
    assert.deepEqual(list.branches[0].reconsider_conditions, ["获取到服务端日志", "发现新的 API 端点"]);
  } finally {
    env.cleanup();
  }
});

/* ── 4. 分支恢复 ─────────────────────────────────────────────────── */

test("resumeBranch：恢复后状态变更为 resumed", async () => {
  const env = await setupProject("resume");
  try {
    const { pctx, projectId } = env;
    const intentId = await seedIntent(env, "i1", "恢复测试");

    await shelveBranch(pctx, {
      projectId, branchId: intentId,
      shelveReason: "conditions_unmet", actor: "test",
    });

    const result = await resumeBranch(pctx, {
      projectId, branchId: intentId,
      actor: "test", resumeNote: "条件已满足",
    });
    assert.equal(result.resumed, true);
    assert.equal(result.status, "resumed");
    assert.equal(result.previous_reason, "conditions_unmet");

    // 搁置列表不再包含
    const list = await listShelvedBranches(pctx, { projectId });
    assert.equal(list.total, 0);
  } finally {
    env.cleanup();
  }
});

/* ── 5. 唤醒条件 ─────────────────────────────────────────────────── */

test("evaluateWakeConditions：搁置后新事件匹配唤醒类型时报告可唤醒", async () => {
  const env = await setupProject("wake");
  try {
    const { pctx, projectId, session } = env;
    const intentId = await seedIntent(env, "i1", "唤醒测试");

    await shelveBranch(pctx, {
      projectId, branchId: intentId,
      shelveReason: "insufficient_evidence",
      wakeOnEventTypes: ["observation.appended"],
      actor: "test",
    });

    // 搁置后无事件 → 无可唤醒
    const before = await evaluateWakeConditions(pctx, { projectId });
    assert.equal(before.wakeable.length, 0);

    // 提交一个 submission（产生 Outbox 事件）
    await submit(pctx, {
      session,
      envelope: {
        submission_id: "wake-obs-1",
        operations: [
          { op: "append_observation", local_ref: "obs1", statement: "新发现的线索" },
        ],
      },
    });

    // 现在应该有匹配的唤醒条件
    const after = await evaluateWakeConditions(pctx, { projectId });
    assert.ok(after.wakeable.length >= 1, "应有可唤醒的分支");
    const match = after.wakeable.find((w) => w.branch_id === intentId);
    assert.ok(match, "搁置的意图应因 observation.appended 事件被标为可唤醒");
    assert.ok(match.matched_events.length > 0);
  } finally {
    env.cleanup();
  }
});

/* ── 6. 无变化等待 ───────────────────────────────────────────────── */

test("assessWaiting：无可执行工作时标识为无待处理", async () => {
  const env = await setupProject("wait");
  try {
    const { pctx, projectId } = env;

    const state = await assessWaiting(pctx, { projectId });
    assert.ok(state, "应返回等待状态评估");
    assert.equal(state.has_pending_work, false, "空项目无可执行工作");
  } finally {
    env.cleanup();
  }
});

/* ── 7. 重复交接幂等 ─────────────────────────────────────────────── */

test("重复交接幂等：同一 submission_id 的 submit 返回原回执", async () => {
  const env = await setupProject("dedup");
  try {
    const { pctx, projectId, session } = env;

    const first = await submit(pctx, {
      session,
      envelope: {
        submission_id: "handoff-1",
        operations: [
          { op: "append_observation", local_ref: "obs1", statement: "交接观察" },
        ],
      },
    });
    assert.ok(first.ids.obs1);

    // 重复提交同一 submission_id
    const second = await submit(pctx, {
      session,
      envelope: {
        submission_id: "handoff-1",
        operations: [
          { op: "append_observation", local_ref: "obs1", statement: "交接观察" },
        ],
      },
    });
    assert.equal(second.ids.obs1, first.ids.obs1, "重复交接应返回原编号");
  } finally {
    env.cleanup();
  }
});

/* ── 8. 记录可达：SH 编号经 locateRecord 可定位 ─────────────────── */

test("locateRecord：SH 编号可定位到 branch_shelving 表", async () => {
  const env = await setupProject("locate6");
  try {
    const { pctx, projectId, db } = env;
    const intentId = await seedIntent(env, "i1", "定位测试");

    const sh = await shelveBranch(pctx, {
      projectId, branchId: intentId,
      shelveReason: "unknown", actor: "test",
    });

    const loc = locateRecord(db, projectId, sh.shelving_id);
    assert.ok(loc, "SH 编号应可定位");
    assert.equal(loc.table, "branch_shelving");
    assert.equal(locateRecord(db, "PRJ-other", sh.shelving_id), null);
  } finally {
    env.cleanup();
  }
});

/* ── 9. recoverContext 组合 ──────────────────────────────────────── */

test("recoverContext：检查点 + 等待状态 + 唤醒条件一次获取", async () => {
  const env = await setupProject("recover");
  try {
    const { pctx, projectId } = env;
    const intentId = await seedIntent(env, "i1", "恢复上下文");

    // 创建检查点
    await phaseBoundaryCheckpoint(pctx, {
      projectId, intentId, actor: "test",
      phaseNote: "恢复测试",
    });

    // 搁置一个分支
    await shelveBranch(pctx, {
      projectId, branchId: intentId,
      shelveReason: "blocked", actor: "test",
    });

    const ctx = await recoverContext(pctx, { projectId });
    assert.ok(ctx.checkpoint, "应有检查点");
    assert.ok(ctx.waiting, "应有等待状态");
    assert.ok(ctx.wake_conditions, "应有唤醒条件");
    assert.ok(ctx.shelved_branches, "应有搁置分支");
    assert.equal(ctx.shelved_branches.total, 1);
    assert.ok(ctx.note.includes("恢复入口"), "应说明检查点是恢复入口");
  } finally {
    env.cleanup();
  }
});
