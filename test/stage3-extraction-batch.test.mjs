/**
 * 阶段 3 验收测试——自动批量保存（01 号基线 §八、§九、§十五）。
 *
 * 覆盖：
 *   1. 数百条提取结果批量保存，条目完整、分类计数正确。
 *   2. 单项溯源：getBatch 分页返回条目，每项含 source_locator 与 confidence。
 *   3. 回执大小：saveBatch 返回短回执（不含全量条目），回执 JSON 小于 2KB。
 *   4. 幂等重放：同一 idempotency_key+内容 → 原回执（idempotent=true）。
 *   5. 幂等键冲突：同键不同内容 → IDEMPOTENCY_KEY_REUSED 错误。
 *   6. 部分状态：markBatchPartial 标记中断批次。
 *   7. 阅读服务搜索：extraction_items 经 searchNodes 可按关键词发现。
 *   8. 按类别分页：listItemsByCategory 按 category 过滤并游标分页。
 *   9. 记录可达：EB/EI 编号经 records-read.mjs 的 locateRecord 可定位。
 *  10. 网关仍拒绝未授权执行：仅登记新域名时不能绕过工具网关范围检查。
 *
 * 并行安全：mkdtemp + SORNE_DATA_DIR 注入。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDatabase } from "../lib/db.mjs";
import { getStore, closeStore } from "../lib/store/record-service.mjs";
import { saveBatch, markBatchPartial, getBatch, listItemsByCategory } from "../lib/store/extraction.mjs";
import { searchNodes } from "../lib/store/reading.mjs";
import { locateRecord } from "../lib/store/records-read.mjs";
import { issueSession } from "../lib/store/sessions.mjs";
import { withTestServer } from "./helpers.mjs";

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "sorne-stage3-"));
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
    ).run(`PRJ-${name}`, name, "批量提取测试", "", new Date().toISOString());
    projectId = `PRJ-${name}`;
  });

  return {
    pctx, projectId, store, db, dir,
    cleanup() {
      try { store.close(); } catch {}
      if (prev === undefined) delete process.env.SORNE_DATA_DIR;
      else process.env.SORNE_DATA_DIR = prev;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function generateItems(count) {
  const categories = ["domain", "endpoint", "email", "ip_address", "technology"];
  const items = [];
  for (let i = 0; i < count; i++) {
    const cat = categories[i % categories.length];
    items.push({
      category: cat,
      value: `${cat}-value-${String(i).padStart(4, "0")}`,
      source_locator: { line: i + 1, offset: i * 10 },
      confidence: i % 3 === 0 ? "confirmed" : "candidate",
      metadata: { index: i },
    });
  }
  return items;
}

/* ── 1. 数百条批量保存：完整性与分类计数 ──────────────────────────── */

test("批量保存 200 条：条目完整、分类计数正确、状态 committed", async () => {
  const env = await setupProject("batch200");
  try {
    const { pctx, projectId } = env;
    const items = generateItems(200);
    const receipt = await saveBatch(pctx, {
      projectId,
      idempotencyKey: "batch-200-key",
      inputSha256: "abc123def456",
      extractorName: "test-extractor",
      extractorVersion: "1.0.0",
      actor: "test-worker",
      items,
    });

    assert.equal(receipt.status, "committed");
    assert.equal(receipt.item_count, 200);
    assert.equal(receipt.idempotent, false);
    assert.ok(receipt.batch_id.startsWith("EB-"));

    // 分类计数：5 类各 40 条
    assert.equal(receipt.category_counts.domain, 40);
    assert.equal(receipt.category_counts.endpoint, 40);
    assert.equal(receipt.category_counts.email, 40);
    assert.equal(receipt.category_counts.ip_address, 40);
    assert.equal(receipt.category_counts.technology, 40);

    // 数据库中确认全部条目存在
    const count = env.db.prepare(
      "SELECT COUNT(*) AS c FROM extraction_items WHERE batch_id = ?",
    ).get(receipt.batch_id).c;
    assert.equal(count, 200);
  } finally {
    env.cleanup();
  }
});

/* ── 2. 单项溯源：getBatch 分页返回带出处的条目 ──────────────────── */

test("getBatch 分页：返回条目含 source_locator 与 confidence", async () => {
  const env = await setupProject("provenance");
  try {
    const { pctx, projectId } = env;
    const items = generateItems(30);
    const receipt = await saveBatch(pctx, {
      projectId,
      idempotencyKey: "prov-key",
      inputSha256: "prov-hash",
      extractorName: "prov-extractor",
      extractorVersion: "2.0.0",
      actor: "test-worker",
      items,
    });

    // 第一页
    const page1 = await getBatch(pctx, {
      projectId, batchId: receipt.batch_id, offset: 0, limit: 10,
    });
    assert.equal(page1.items.length, 10);
    assert.equal(page1.has_more, true);
    assert.equal(page1.item_count, 30);
    assert.equal(page1.items[0].item_index, 0);
    assert.deepEqual(page1.items[0].source_locator, { line: 1, offset: 0 });
    assert.equal(page1.items[0].confidence, "confirmed"); // index 0 → 0%3==0

    // 第三页（最后一页）
    const page3 = await getBatch(pctx, {
      projectId, batchId: receipt.batch_id, offset: 20, limit: 10,
    });
    assert.equal(page3.items.length, 10);
    assert.equal(page3.has_more, false);
    assert.equal(page3.items[9].item_index, 29);
  } finally {
    env.cleanup();
  }
});

/* ── 3. 回执大小：短回执 JSON < 2KB ──────────────────────────────── */

test("回执大小：saveBatch 返回短回执，JSON 小于 2KB", async () => {
  const env = await setupProject("receipt-size");
  try {
    const { pctx, projectId } = env;
    const items = generateItems(500);
    const receipt = await saveBatch(pctx, {
      projectId,
      idempotencyKey: "size-key",
      inputSha256: "size-hash",
      extractorName: "big-extractor",
      extractorVersion: "1.0.0",
      actor: "test-worker",
      items,
    });

    const receiptJson = JSON.stringify(receipt);
    assert.ok(
      receiptJson.length < 2048,
      `回执 JSON ${receiptJson.length} 字节应小于 2KB（§八：不送全量条目进模型上下文）`,
    );
    assert.equal(receipt.item_count, 500);
    assert.ok(receipt.read_path, "回执应包含阅读服务入口路径");
  } finally {
    env.cleanup();
  }
});

/* ── 4. 幂等重放：同键同内容 → 原回执 ───────────────────────────── */

test("幂等重放：同一 idempotency_key+内容返回原回执", async () => {
  const env = await setupProject("idempotent");
  try {
    const { pctx, projectId } = env;
    const items = generateItems(5);
    const params = {
      projectId,
      idempotencyKey: "idem-key",
      inputSha256: "idem-hash",
      extractorName: "idem-extractor",
      extractorVersion: "1.0.0",
      actor: "test-worker",
      items,
    };

    const first = await saveBatch(pctx, params);
    assert.equal(first.idempotent, false);
    assert.equal(first.status, "committed");

    const second = await saveBatch(pctx, params);
    assert.equal(second.idempotent, true);
    assert.equal(second.batch_id, first.batch_id);
    assert.equal(second.item_count, first.item_count);

    // 数据库中仍然只有一个批次
    const batches = env.db.prepare(
      "SELECT COUNT(*) AS c FROM extraction_batches WHERE project_id = ?",
    ).get(projectId).c;
    assert.equal(batches, 1);
  } finally {
    env.cleanup();
  }
});

/* ── 5. 幂等键冲突：同键不同内容 → IDEMPOTENCY_KEY_REUSED ────── */

test("幂等键冲突：同键不同内容报 IDEMPOTENCY_KEY_REUSED", async () => {
  const env = await setupProject("conflict");
  try {
    const { pctx, projectId } = env;

    await saveBatch(pctx, {
      projectId,
      idempotencyKey: "conflict-key",
      inputSha256: "hash-a",
      extractorName: "ext",
      extractorVersion: "1.0.0",
      actor: "test-worker",
      items: [{ category: "domain", value: "a.com" }],
    });

    await assert.rejects(
      () => saveBatch(pctx, {
        projectId,
        idempotencyKey: "conflict-key",
        inputSha256: "hash-b",
        extractorName: "ext",
        extractorVersion: "1.0.0",
        actor: "test-worker",
        items: [{ category: "domain", value: "b.com" }],
      }),
      (err) => {
        assert.equal(err.code, "IDEMPOTENCY_KEY_REUSED");
        return true;
      },
    );
  } finally {
    env.cleanup();
  }
});

/* ── 6. 部分状态：markBatchPartial 标记中断批次 ─────────────────── */

test("markBatchPartial：已提交批次可标为 partial", async () => {
  const env = await setupProject("partial");
  try {
    const { pctx, projectId } = env;
    const receipt = await saveBatch(pctx, {
      projectId,
      idempotencyKey: "partial-key",
      inputSha256: "partial-hash",
      extractorName: "ext",
      extractorVersion: "1.0.0",
      actor: "test-worker",
      items: [{ category: "domain", value: "partial.test" }],
    });
    assert.equal(receipt.status, "committed");

    const marked = await markBatchPartial(pctx, {
      projectId,
      batchId: receipt.batch_id,
      errorNote: "进程中断：仅完成 1/3",
    });
    assert.equal(marked.status, "partial");
    assert.equal(marked.error_note, "进程中断：仅完成 1/3");

    // 条目仍可读（§八：已提交部分保留）
    const batch = await getBatch(pctx, {
      projectId, batchId: receipt.batch_id, offset: 0, limit: 10,
    });
    assert.equal(batch.status, "partial");
    assert.equal(batch.items.length, 1);

    // 重复标记不报错
    const again = await markBatchPartial(pctx, {
      projectId,
      batchId: receipt.batch_id,
      errorNote: "再次标记",
    });
    assert.equal(again.status, "partial");
    assert.ok(again.note, "重复标记应返回说明");
  } finally {
    env.cleanup();
  }
});

/* ── 7. 阅读服务搜索：extraction_items 可被 searchNodes 发现 ──── */

test("searchNodes 搜索提取条目：按关键词命中 extraction_items", async () => {
  const env = await setupProject("search");
  try {
    const { pctx, projectId } = env;
    await saveBatch(pctx, {
      projectId,
      idempotencyKey: "search-key",
      inputSha256: "search-hash",
      extractorName: "html-extractor",
      extractorVersion: "1.0.0",
      actor: "test-worker",
      items: [
        { category: "domain", value: "hidden-target.example.com" },
        { category: "endpoint", value: "/api/v2/secret-admin" },
        { category: "email", value: "admin@hidden-target.example.com" },
      ],
    });

    // 搜索应命中 extraction_items
    const results = await searchNodes(pctx, { projectId, query: "hidden-target" });
    assert.ok(results.items.length >= 2, "至少应命中 domain 和 email 条目");
    const ids = results.items.map((r) => r.id);
    assert.ok(ids.some((id) => id.startsWith("EI-")), "搜索结果应包含 EI- 编号");

    // 按 kinds 过滤
    const filtered = await searchNodes(pctx, {
      projectId, query: "secret-admin", kinds: ["extraction_items"],
    });
    assert.ok(filtered.items.length >= 1, "按类别过滤应命中 endpoint 条目");
    assert.equal(filtered.items[0].record_kind, "extraction_items");
  } finally {
    env.cleanup();
  }
});

/* ── 8. 按类别分页：listItemsByCategory ──────────────────────────── */

test("listItemsByCategory：按 category 过滤并游标分页", async () => {
  const env = await setupProject("catpage");
  try {
    const { pctx, projectId } = env;
    const items = generateItems(25); // 5 domain items (index 0,5,10,15,20)
    await saveBatch(pctx, {
      projectId,
      idempotencyKey: "cat-key",
      inputSha256: "cat-hash",
      extractorName: "ext",
      extractorVersion: "1.0.0",
      actor: "test-worker",
      items,
    });

    // 按 domain 类别列出，每页 3 条
    const page1 = await listItemsByCategory(pctx, {
      projectId, category: "domain", limit: 3,
    });
    assert.equal(page1.items.length, 3);
    assert.equal(page1.has_more, true);
    assert.ok(page1.next_cursor);
    for (const it of page1.items) {
      assert.equal(it.category, "domain");
    }

    // 续读第二页
    const page2 = await listItemsByCategory(pctx, {
      projectId, category: "domain", cursor: page1.next_cursor, limit: 3,
    });
    assert.equal(page2.items.length, 2); // 5 total, 3 already read
    assert.equal(page2.has_more, false);

    // 无 category 过滤 → 全部条目
    const all = await listItemsByCategory(pctx, {
      projectId, limit: 100,
    });
    assert.equal(all.items.length, 25);
  } finally {
    env.cleanup();
  }
});

/* ── 9. 记录可达：EB/EI 编号经 locateRecord 定位 ────────────────── */

test("locateRecord：EB 和 EI 编号可定位到对应表", async () => {
  const env = await setupProject("locate");
  try {
    const { pctx, projectId, db } = env;
    const receipt = await saveBatch(pctx, {
      projectId,
      idempotencyKey: "locate-key",
      inputSha256: "locate-hash",
      extractorName: "ext",
      extractorVersion: "1.0.0",
      actor: "test-worker",
      items: [{ category: "domain", value: "locate.test" }],
    });

    const batchLoc = locateRecord(db, projectId, receipt.batch_id);
    assert.ok(batchLoc, "EB 编号应可定位");
    assert.equal(batchLoc.table, "extraction_batches");

    const itemId = env.db.prepare(
      "SELECT id FROM extraction_items WHERE batch_id = ? ORDER BY item_index LIMIT 1",
    ).get(receipt.batch_id).id;
    const itemLoc = locateRecord(db, projectId, itemId);
    assert.ok(itemLoc, "EI 编号应可定位");
    assert.equal(itemLoc.table, "extraction_items");

    // 跨项目不可见
    const cross = locateRecord(db, "PRJ-nonexistent", receipt.batch_id);
    assert.equal(cross, null, "跨项目应返回 null");
  } finally {
    env.cleanup();
  }
});

/* ── 10. 网关仍拒绝未授权执行 ────────────────────────────────────── */

async function call(base, method, path, { body, session } = {}) {
  const headers = { origin: base };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (session) headers["x-sorne-session"] = session.session_token;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: res.status, body: json };
}

test("仅登记新域名时，网关仍拒绝未授权的主动执行", () =>
  withTestServer(async ({ base }) => {
    // 创建一个有严格范围的项目
    const created = (await call(base, "POST", "/sorne/projects", {
      body: { name: "网关测试" },
    })).body;
    const projectId = created.project.id;
    await call(base, "POST", "/sorne/scope-revisions", {
      body: { project_id: projectId, rules: { allow: ["*.allowed.test"], deny: ["*"], pending: [] } },
    });

    const session = issueSession({ project_id: projectId, actor: "w-gate", role: "worker" });
    const runtime = issueSession({ project_id: projectId, actor: "r-gate", role: "runtime" });

    // 创建意图和 Attempt
    const planner = issueSession({ project_id: projectId, actor: "p-gate", role: "planner" });
    const plan = (await call(base, "POST", "/sorne/plan-revisions", {
      body: {
        submission_id: "plan-gate",
        plan_revision: "r1",
        intents: [
          { op: "create", local_ref: "i1", question: "网关测试", kind: "investigate", rationale: "test", success_criteria: "any", target_asset_ids: [] },
        ],
      },
      session: planner,
    })).body;
    const intentId = plan.ids.i1;
    const dispatch = (await call(base, "POST", "/sorne/attempts", {
      body: { intent_id: intentId, worker_id: "w-gate" },
      session: runtime,
    })).body;

    // 尝试对范围外目标注册工具调用 → 应被拒绝
    const res = await call(base, "POST", "/sorne/tool-calls", {
      body: {
        action: "register",
        attempt_id: dispatch.attempt.id,
        fencing_token: dispatch.fencing_token,
        tool_name: "http_probe",
        args: { url: "https://forbidden.example.com/" },
      },
      session,
    });
    assert.ok(
      res.body.code === "SCOPE_DENIED" || res.body.code === "SCOPE_UNRESOLVED",
      `范围外目标应被网关拒绝，实际: ${res.body.code}`,
    );
  }));
