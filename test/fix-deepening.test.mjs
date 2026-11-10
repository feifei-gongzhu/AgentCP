/**
 * 深化纠偏回归测试——虚拟节点摘要、unresolved 分页、角色导航引导。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getStore, submit, createProject } from "../lib/store/record-service.mjs";
import { issueSession } from "../lib/store/sessions.mjs";
import { beginRefresh, publishRefresh } from "../lib/store/summaries.mjs";
import { openNode, listChildren } from "../lib/store/reading.mjs";
import "../lib/store/dedup.mjs";
import "../lib/store/judgements.mjs";

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "sorne-deep-"));
}

async function setupProject(name) {
  const dir = makeTempDir();
  const prev = process.env.SORNE_DATA_DIR;
  process.env.SORNE_DATA_DIR = dir;
  const pctx = { dataDir: dir, logger: { info() {}, warn() {}, error() {} } };
  const created = await createProject(pctx, { actor: "test", name, task: `${name} 深化测试` });
  const projectId = created.project.id;
  const store = await getStore(pctx);
  const db = store.db;
  const session = issueSession({ project_id: projectId, actor: "worker", role: "worker", ttl_ms: 60_000 });
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

function seedIntent(db, projectId, suffix, question, opts = {}) {
  const seq = db.prepare("SELECT next_commit_seq AS n FROM projects WHERE id = ?").get(projectId).n;
  db.prepare("UPDATE projects SET next_commit_seq = ? WHERE id = ?").run(seq + 1, projectId);
  const intentId = `I-${projectId}-${suffix}`;
  db.prepare(
    `INSERT INTO intents (id, project_id, question, kind, status, priority, state_version, plan_revision,
       created_at, created_by, created_seq, updated_seq)
     VALUES (?, ?, ?, 'investigate', ?, 1, 1, 1, ?, 'test', ?, ?)`,
  ).run(intentId, projectId, question, opts.status || "proposed", new Date().toISOString(), seq, seq);
  return intentId;
}

/* ── 1. atype 虚拟节点有摘要 ──────────────────────────────────── */

test("深化§一：atype 虚拟节点返回资产计数摘要", async () => {
  const env = await setupProject("atype-sum");
  try {
    const { pctx, projectId, session } = env;
    await submit(pctx, {
      session,
      envelope: {
        submission_id: "asset-1",
        operations: [
          { op: "register_asset", local_ref: "a1", canonical_key: "example.com", asset_type: "domain", canonicalization_version: "1" },
          { op: "register_asset", local_ref: "a2", canonical_key: "api.example.com", asset_type: "domain", canonicalization_version: "1" },
        ],
      },
    });

    const node = await openNode(pctx, { projectId, nodeId: "atype:domain" });
    assert.ok(node.node.summary, "atype 虚拟节点应有摘要");
    assert.ok(node.node.summary.includes("2"), "摘要应包含资产数量");
    assert.ok(node.node.summary.includes("domain"), "摘要应包含类型名");
  } finally {
    env.cleanup();
  }
});

/* ── 2. unresolved 虚拟节点支持分页 ─────────────────────────── */

test("深化§二：unresolved 虚拟节点超过一页时返回可续读游标", async () => {
  const env = await setupProject("unresolved-page");
  try {
    const { pctx, projectId, db, session } = env;
    // 创建 25 个 open 假设
    for (let i = 0; i < 25; i++) {
      await submit(pctx, {
        session,
        envelope: {
          submission_id: `hyp-${i}`,
          operations: [{ op: "propose_hypothesis", local_ref: `h${i}`, statement: `假设 ${i}` }],
        },
      });
    }

    const page1 = await listChildren(pctx, { projectId, nodeId: "unresolved", limit: 20 });
    assert.equal(page1.items.length, 20);
    assert.equal(page1.has_more, true);
    assert.ok(page1.next_cursor, "应返回可续读游标");

    const page2 = await listChildren(pctx, { projectId, nodeId: "unresolved", cursor: page1.next_cursor, limit: 20 });
    assert.ok(page2.items.length >= 5, "第二页应包含剩余项");

    const ids1 = new Set(page1.items.map((i) => i.id));
    const dup = page2.items.filter((i) => ids1.has(i.id));
    assert.equal(dup.length, 0, "两页不应有重复项");
  } finally {
    env.cleanup();
  }
});

/* ── 3. 意图节点 openNode 包含语义摘要 ─────────────────────── */

test("深化§一：意图节点 openNode 包含 branch_summaries 的语义摘要", async () => {
  const env = await setupProject("intent-summary");
  try {
    const { pctx, projectId, db } = env;
    const intentId = seedIntent(db, projectId, "sum1", "调查 API 安全性");

    // 发布摘要
    await beginRefresh(pctx, { projectId, branchId: intentId, branchKind: "intent", actor: "planner" });
    await publishRefresh(pctx, {
      projectId, branchId: intentId,
      semanticSummary: "API 端点已识别三个未鉴权的管理接口",
      actor: "planner",
    });
    // 确保 current 状态
    env.db.prepare(
      "UPDATE branch_summaries SET refresh_status = 'current' WHERE project_id = ? AND branch_id = ?",
    ).run(projectId, intentId);

    const node = await openNode(pctx, { projectId, nodeId: intentId });
    assert.ok(node.node.summary.includes("未鉴权"), "应包含语义摘要内容");
    assert.ok(node.node.summary.includes("intents"), "应保留基础表名");
    assert.ok(!node.node.summary.includes("待刷新"), "current 状态不应标注待刷新");

    // 标记 stale
    env.db.prepare(
      "UPDATE branch_summaries SET refresh_status = 'stale' WHERE project_id = ? AND branch_id = ?",
    ).run(projectId, intentId);

    const staleNode = await openNode(pctx, { projectId, nodeId: intentId });
    assert.ok(staleNode.node.summary.includes("待刷新"), "stale 状态应标注待刷新");
  } finally {
    env.cleanup();
  }
});

/* ── 4. 角色开场均包含导航入口引导 ──────────────────────────── */

test("深化§三：四角色开场均包含 root:assets 和 root:exploration 导航入口", async () => {
  function makeRecordingModel(handler) {
    const calls = [];
    const model = {
      calls,
      async chat(opts) {
        calls.push(opts);
        return handler(opts);
      },
    };
    return model;
  }

  const env = await setupProject("nav-roots");
  try {
    const { pctx, projectId, db } = env;
    const { runPlanner } = await import("../lib/agents/planner.mjs");
    const { runOrchestrator } = await import("../lib/agents/orchestrator.mjs");

    const noopModel = makeRecordingModel(async () => ({
      content: "已完成", tool_calls: [], finish_reason: "stop",
    }));

    await runPlanner(pctx, { projectId, model: noopModel, maxSteps: 1 });
    assert.equal(noopModel.calls.length, 1);
    const plannerText = JSON.stringify(noopModel.calls[0].messages);
    assert.ok(plannerText.includes("root:assets"), "Planner 开场应包含 root:assets");
    assert.ok(plannerText.includes("root:exploration"), "Planner 开场应包含 root:exploration");

    const orchModel = makeRecordingModel(async () => ({
      content: "已完成", tool_calls: [], finish_reason: "stop",
    }));
    await runOrchestrator(pctx, { projectId, model: orchModel, maxSteps: 1 });
    assert.equal(orchModel.calls.length, 1);
    const orchText = JSON.stringify(orchModel.calls[0].messages);
    assert.ok(orchText.includes("root:assets"), "Orchestrator 开场应包含 root:assets");
    assert.ok(orchText.includes("recover_context"), "Orchestrator 开场应包含 recover_context");
  } finally {
    env.cleanup();
  }
});
