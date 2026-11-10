/**
 * 纠偏回归测试——阅读可达性、批次展开、搜索覆盖、截断保护、摘要接入、markStale 自动触发。
 *
 * 对照报告 §一至§五 指出的接口层缺陷和连接层缺失。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getStore, submit, createProject } from "../lib/store/record-service.mjs";
import { issueSession } from "../lib/store/sessions.mjs";
import { saveBatch } from "../lib/store/extraction.mjs";
import { beginRefresh, publishRefresh, getSummary } from "../lib/store/summaries.mjs";
import { openNode, listChildren, searchNodes } from "../lib/store/reading.mjs";
import "../lib/store/dedup.mjs";
import "../lib/store/judgements.mjs";

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "sorne-fix-"));
}

async function setupProject(name) {
  const dir = makeTempDir();
  const prev = process.env.SORNE_DATA_DIR;
  process.env.SORNE_DATA_DIR = dir;
  const pctx = { dataDir: dir, logger: { info() {}, warn() {}, error() {} } };

  const created = await createProject(pctx, {
    actor: "fix-test", name, task: `${name} 纠偏测试`,
  });
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

/* ── 1. 资产子入口分页返回可用游标 ────────────────────────────── */

test("纠偏§二：资产子入口超过一页时返回可续读的 next_cursor", async () => {
  const env = await setupProject("asset-cursor");
  try {
    const { pctx, projectId, db, session } = env;

    // 创建一个资产
    const a = await submit(pctx, {
      session,
      envelope: {
        submission_id: "asset-1",
        operations: [{ op: "register_asset", local_ref: "a1", canonical_key: "test.webapp.local", asset_type: "domain", canonicalization_version: "1" }],
      },
    });
    const assetId = a.ids.a1;

    // 创建 25 条指向该资产的漏洞
    for (let i = 0; i < 25; i++) {
      await submit(pctx, {
        session,
        envelope: {
          submission_id: `vuln-${i}`,
          operations: [{
            op: "report_vulnerability",
            local_ref: `v${i}`,
            category: `xss-${i}`,
            asset_id: assetId,
          }],
        },
      });
    }

    // 第一页（limit=20）
    const page1 = await listChildren(pctx, { projectId, nodeId: assetId, limit: 20 });
    assert.equal(page1.items.length, 20);
    assert.equal(page1.has_more, true);
    assert.ok(page1.next_cursor, "应返回可续读游标");

    // 第二页
    const page2 = await listChildren(pctx, { projectId, nodeId: assetId, cursor: page1.next_cursor, limit: 20 });
    assert.ok(page2.items.length >= 5, "第二页应包含剩余项");

    // 两页不重复
    const ids1 = new Set(page1.items.map((i) => i.id));
    const dup = page2.items.filter((i) => ids1.has(i.id));
    assert.equal(dup.length, 0, "两页不应有重复项");
  } finally {
    env.cleanup();
  }
});

/* ── 2. 批次展开返回其提取条目 ────────────────────────────────── */

test("纠偏§二：提取批次展开返回条目子入口", async () => {
  const env = await setupProject("batch-expand");
  try {
    const { pctx, projectId } = env;

    const items = [];
    for (let i = 0; i < 25; i++) {
      items.push({ category: "domain", value: `host-${i}.local` });
    }

    const receipt = await saveBatch(pctx, {
      projectId,
      idempotencyKey: "batch-expand-1",
      inputSha256: "b".repeat(64),
      extractorName: "test-extractor",
      extractorVersion: "1.0.0",
      actor: "worker",
      items,
    });

    // openNode 应显示有子节点
    const node = await openNode(pctx, { projectId, nodeId: receipt.batch_id });
    assert.ok(node.node.has_children, "批次应有子节点");
    assert.equal(node.node.children_count, 25);

    // listChildren 应返回条目
    const children = await listChildren(pctx, { projectId, nodeId: receipt.batch_id, limit: 10 });
    assert.equal(children.items.length, 10);
    assert.equal(children.has_more, true);
    assert.ok(children.next_cursor, "应有续读游标");

    // 续读第二页
    const page2 = await listChildren(pctx, { projectId, nodeId: receipt.batch_id, cursor: children.next_cursor, limit: 20 });
    assert.equal(page2.items.length, 15);
  } finally {
    env.cleanup();
  }
});

/* ── 3. 搜索覆盖提取器名称 ───────────────────────────────────── */

test("纠偏§二：搜索可通过提取器名称找到批次", async () => {
  const env = await setupProject("search-extractor");
  try {
    const { pctx, projectId } = env;

    await saveBatch(pctx, {
      projectId,
      idempotencyKey: "search-ext-1",
      inputSha256: "c".repeat(64),
      extractorName: "js-unique-scanner",
      extractorVersion: "2.1.0",
      actor: "worker",
      items: [{ category: "config", value: "debug=true" }],
    });

    const result = await searchNodes(pctx, { projectId, query: "js-unique-scanner" });
    assert.ok(result.items.length >= 1, "搜索提取器名称应返回批次");
    const hit = result.items.find((i) => i.record_kind === "extraction_batches");
    assert.ok(hit, "命中项应来自 extraction_batches");
  } finally {
    env.cleanup();
  }
});

/* ── 4. 截断保留分页控制字段 ─────────────────────────────────── */

test("纠偏§二：工具结果截断时保留 next_cursor 等分页字段", async () => {
  const { __test__ } = await import("../lib/agents/loop.mjs");
  const { toolResultMessage } = __test__;

  const bigPayload = {
    items: Array.from({ length: 100 }, (_, i) => ({
      id: `ITEM-${i}`,
      title: "A".repeat(100),
      created_seq: i,
    })),
    has_more: true,
    next_cursor: "42:ITEM-99",
    total: 500,
  };

  const msg = toolResultMessage("call-1", "read_children", bigPayload);
  const parsed = JSON.parse(msg.content);
  assert.ok(parsed.next_cursor, "截断后应保留 next_cursor");
  assert.equal(parsed.has_more, true, "截断后应保留 has_more");
  assert.equal(parsed.total, 500, "截断后应保留 total");
  assert.ok(parsed.items.length < 100, "items 应被裁减");
  assert.ok(parsed._truncated, "应标注截断信息");
});

/* ── 5. openNode 接入语义摘要 ─────────────────────────────────── */

test("纠偏§一：openNode 返回语义摘要（来自 branch_summaries）", async () => {
  const env = await setupProject("summary-in-node");
  try {
    const { pctx, projectId, db } = env;

    // 创建意图
    const seq = db.prepare("SELECT next_commit_seq AS n FROM projects WHERE id = ?").get(projectId).n;
    db.prepare("UPDATE projects SET next_commit_seq = ? WHERE id = ?").run(seq + 1, projectId);
    const intentId = `I-${projectId}-summary`;
    db.prepare(
      `INSERT INTO intents (id, project_id, question, kind, status, priority, state_version, plan_revision,
         created_at, created_by, created_seq, updated_seq)
       VALUES (?, ?, ?, 'investigate', 'proposed', 1, 1, 1, ?, 'test', ?, ?)`,
    ).run(intentId, projectId, "测试摘要接入", new Date().toISOString(), seq, seq);

    // 无摘要时
    const nodeBefore = await openNode(pctx, { projectId, nodeId: intentId });
    assert.ok(nodeBefore.node.summary.includes("intents"), "无摘要时显示表名");

    // 创建并发布摘要
    await beginRefresh(pctx, { projectId, branchId: intentId, branchKind: "intent", actor: "planner" });
    await publishRefresh(pctx, {
      projectId, branchId: intentId,
      semanticSummary: "该意图调查 test2.com 的安全性，已确认为 Mock 配置",
      actor: "planner",
    });

    // 有摘要时
    const nodeAfter = await openNode(pctx, { projectId, nodeId: intentId });
    assert.ok(nodeAfter.node.summary.includes("Mock 配置"), "有摘要时应包含语义摘要内容");
    assert.ok(nodeAfter.node.summary.includes("intents"), "应保留基础信息");
  } finally {
    env.cleanup();
  }
});

/* ── 6. 提交新观察自动标记摘要为 stale ────────────────────────── */

test("纠偏§一：提交新观察后，current 的分支摘要自动变为 stale", async () => {
  const env = await setupProject("auto-stale");
  try {
    const { pctx, projectId, db, session } = env;

    // 创建意图
    const seq = db.prepare("SELECT next_commit_seq AS n FROM projects WHERE id = ?").get(projectId).n;
    db.prepare("UPDATE projects SET next_commit_seq = ? WHERE id = ?").run(seq + 1, projectId);
    const intentId = `I-${projectId}-stale`;
    db.prepare(
      `INSERT INTO intents (id, project_id, question, kind, status, priority, state_version, plan_revision,
         created_at, created_by, created_seq, updated_seq)
       VALUES (?, ?, ?, 'investigate', 'proposed', 1, 1, 1, ?, 'test', ?, ?)`,
    ).run(intentId, projectId, "stale 测试", new Date().toISOString(), seq, seq);

    // 创建并发布摘要（状态为 current）
    // 注意：beginRefresh 本身会推进 commit_seq，所以 publishRefresh 看到 watermark 可能相同
    await beginRefresh(pctx, { projectId, branchId: intentId, branchKind: "intent", actor: "planner" });
    const pub = await publishRefresh(pctx, {
      projectId, branchId: intentId,
      semanticSummary: "初始摘要",
      actor: "planner",
    });
    // publishRefresh 可能返回 current 或 stale（取决于 beginRefresh 前后是否有新内容）
    // 如果已经 stale，手动置为 current 以便测试 submit 触发
    if (pub.refresh_status === "stale") {
      env.db.prepare(
        "UPDATE branch_summaries SET refresh_status = 'current' WHERE project_id = ? AND branch_id = ?",
      ).run(projectId, intentId);
    }
    const preCheck = await getSummary(pctx, { projectId, branchId: intentId, branchKind: "intent" });
    assert.equal(preCheck.refresh_status, "current", "发布后应为 current");

    // 提交新观察
    await submit(pctx, {
      session,
      envelope: {
        submission_id: "stale-obs-1",
        operations: [{ op: "append_observation", local_ref: "o1", statement: "新发现触发 stale" }],
      },
    });

    // 摘要应自动变为 stale
    const summary = await getSummary(pctx, { projectId, branchId: intentId, branchKind: "intent" });
    assert.equal(summary.refresh_status, "stale", "新观察提交后摘要应自动标记为 stale");
  } finally {
    env.cleanup();
  }
});

/* ── 7. 新增表的 recordParent 返回合理父节点 ─────────────────── */

test("纠偏§二：extraction_items 的 recordParent 指向其批次", async () => {
  const env = await setupProject("parent-chain");
  try {
    const { pctx, projectId } = env;

    const receipt = await saveBatch(pctx, {
      projectId,
      idempotencyKey: "parent-1",
      inputSha256: "d".repeat(64),
      extractorName: "test",
      extractorVersion: "1.0",
      actor: "worker",
      items: [{ category: "domain", value: "example.com" }],
    });

    // 批次的子条目
    const children = await listChildren(pctx, { projectId, nodeId: receipt.batch_id, limit: 5 });
    assert.ok(children.items.length >= 1);
    const itemId = children.items[0].id;

    // 打开条目——面包屑应包含批次
    const node = await openNode(pctx, { projectId, nodeId: itemId });
    const pathIds = node.node.path.map((p) => p.id);
    assert.ok(pathIds.includes(receipt.batch_id), "提取条目的面包屑路径应包含其批次");
  } finally {
    env.cleanup();
  }
});
