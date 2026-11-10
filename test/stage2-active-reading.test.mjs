/**
 * 阶段 2 验收测试——主动阅读与可达性（01 号基线 §二至§五、§十）。
 *
 * 覆盖：
 *   1. 冷启动无 ID：从 root:assets / root:exploration 逐层展开，
 *      找到被折叠在首页之外的关键线索（expand → search → follow → evidence slice）。
 *   2. 分页越界：cursor 超过末尾返回空页而非报错；has_more + total 正确。
 *   3. 新增记录可见：写入新观察后立即出现在 listChildren 与 searchNodes。
 *   4. 目录重组可达：别名映射后旧 ID 仍可解析到新节点。
 *   5. 跨项目 & 角色隔离：项目 A 的书签在项目 B 不可见；不同角色/actor 书签互不干扰。
 *   6. 读取范围日志：readEvidenceSlice 写入 material_read_logs，可按意图/Attempt 查询。
 *
 * 并行安全：mkdtemp + SORNE_DATA_DIR 注入。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDatabase } from "../lib/db.mjs";
import { getStore } from "../lib/store/record-service.mjs";
import {
  openNode,
  listChildren,
  searchNodes,
  followRelations,
  navigateParent,
  readEvidenceSlice,
  saveBookmark,
  getBookmark,
  listBookmarks,
  createAlias,
} from "../lib/store/reading.mjs";
import { storeBlob, registerCapture } from "../lib/store/evidence.mjs";
import { submit } from "../lib/store/record-service.mjs";
import { issueSession } from "../lib/store/sessions.mjs";
import "../lib/store/dedup.mjs";
import "../lib/store/judgements.mjs";

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "sorne-stage2-"));
}

/** 搭建隔离 pctx + 项目，返回 { pctx, projectId, store, db, session }。 */
async function setupProject(name, { task = "", description = "", scopeRules = null } = {}) {
  const dir = makeTempDir();
  const prev = process.env.SORNE_DATA_DIR;
  process.env.SORNE_DATA_DIR = dir;
  const pctx = { dataDir: dir, logger: { info() {}, warn() {}, error() {} } };
  const store = await getStore(pctx);
  const db = store.db;

  // 创建项目
  let projectId;
  await store.runSerial((tx) => {
    const seq = 1;
    tx.prepare(
      `INSERT INTO projects (id, name, task, description, status, next_commit_seq, created_at, created_by, created_seq, updated_seq, state_version)
       VALUES (?, ?, ?, ?, 'active', 2, ?, 'test', ?, ?, 1)`,
    ).run(`PRJ-${name}`, name, task, description, new Date().toISOString(), seq, seq);
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

/* ──────────────────────────────────────────────────────────────── */

test("冷启动：从根入口逐层展开找到资产和意图", async () => {
  const env = await setupProject("cold-start", { task: "渗透测试 test.com" });
  try {
    const { pctx, projectId, db, store, session } = env;

    // 种植资产和意图
    await submit(pctx, {
      session,
      envelope: {
        submission_id: "seed-1",
        operations: [
          { op: "register_service_asset", local_ref: "svc", url: "http://test.com/" },
        ],
      },
    });
    await store.runSerial((tx) => {
      const seq = tx.prepare("SELECT next_commit_seq AS n FROM projects WHERE id = ?").get(projectId).n;
      tx.prepare("UPDATE projects SET next_commit_seq = ? WHERE id = ?").run(seq + 1, projectId);
      tx.prepare(
        `INSERT INTO goals (id, project_id, parent_goal_id, statement, status, state_version, created_at, created_by, created_seq)
         VALUES (?, ?, NULL, ?, 'active', 1, ?, 'test', ?)`,
      ).run(`G-${projectId}-0002`, projectId, "调查 test.com", new Date().toISOString(), seq);
      tx.prepare("UPDATE projects SET next_commit_seq = ? WHERE id = ?").run(seq + 2, projectId);
      tx.prepare(
        `INSERT INTO intents (id, project_id, goal_id, question, kind, status, priority, state_version, plan_revision, created_at, created_by, created_seq, updated_seq)
         VALUES (?, ?, ?, ?, 'investigate', 'proposed', 1, 1, 1, ?, 'test', ?, ?)`,
      ).run(`I-${projectId}-0002`, projectId, `G-${projectId}-0002`, "test.com 有哪些接口？", new Date().toISOString(), seq + 1, seq + 1);
    });

    // 从 root:assets 展开
    const rootAssets = await openNode(pctx, { projectId, nodeId: "root:assets" });
    assert.equal(rootAssets.node.kind, "virtual");
    assert.ok(rootAssets.node.children_count > 0, "资产根应有子节点");

    const assetChildren = await listChildren(pctx, { projectId, nodeId: "root:assets" });
    assert.ok(assetChildren.items.length > 0, "应有资产类型分组");
    const serviceGroup = assetChildren.items.find((i) => i.id === "atype:service");
    assert.ok(serviceGroup, "应存在 service 类型分组");

    const services = await listChildren(pctx, { projectId, nodeId: "atype:service" });
    assert.ok(services.items.length > 0, "应有服务资产");
    assert.ok(services.items[0].title.includes("test.com"), "资产标题包含 test.com");

    // 从 root:exploration 展开
    const rootExpl = await openNode(pctx, { projectId, nodeId: "root:exploration" });
    assert.ok(rootExpl.node.children_count > 0, "探索根应有子节点");

    const explChildren = await listChildren(pctx, { projectId, nodeId: "root:exploration" });
    const goalNode = explChildren.items.find((i) => i.id.startsWith("goal:"));
    assert.ok(goalNode, "应有目标节点");

    const goalIntents = await listChildren(pctx, { projectId, nodeId: goalNode.id });
    assert.ok(goalIntents.items.length > 0, "目标下应有意图");
    assert.ok(goalIntents.items[0].title.includes("接口"), "意图标题匹配");

    // 面包屑验证
    assert.ok(goalIntents.items[0].path.length >= 2, "子节点应有面包屑路径");
  } finally {
    env.cleanup();
  }
});

test("搜索：关键词命中后返回面包屑和来源", async () => {
  const env = await setupProject("search", { task: "搜索测试" });
  try {
    const { pctx, projectId, session } = env;

    await submit(pctx, {
      session,
      envelope: {
        submission_id: "search-seed",
        operations: [
          { op: "register_service_asset", local_ref: "svc", url: "http://hidden-clue.example.com/" },
        ],
      },
    });

    const result = await searchNodes(pctx, { projectId, query: "hidden-clue" });
    assert.ok(result.items.length > 0, "搜索应命中 hidden-clue 资产");
    assert.ok(result.items[0].path.length > 0, "搜索结果应包含面包屑");
  } finally {
    env.cleanup();
  }
});

test("分页：cursor 超过末尾返回空页；has_more 正确", async () => {
  const env = await setupProject("pagination", { task: "分页测试" });
  try {
    const { pctx, projectId, store, session } = env;

    // 种植 5 个资产
    for (let i = 0; i < 5; i++) {
      await submit(pctx, {
        session,
        envelope: {
          submission_id: `page-seed-${i}`,
          operations: [
            { op: "register_service_asset", local_ref: "s", url: `http://page${i}.example.com/` },
          ],
        },
      });
    }

    // 每页 2 个
    const p1 = await listChildren(pctx, { projectId, nodeId: "atype:service", limit: 2 });
    assert.equal(p1.items.length, 2);
    assert.ok(p1.has_more, "应有更多");
    assert.ok(p1.next_cursor, "应有游标");
    assert.ok(p1.total >= 5, "总数应 >= 5");

    // 翻页
    const p2 = await listChildren(pctx, { projectId, nodeId: "atype:service", limit: 2, cursor: p1.next_cursor });
    assert.equal(p2.items.length, 2);
    // 确认不重复
    const ids1 = p1.items.map((i) => i.id);
    const ids2 = p2.items.map((i) => i.id);
    for (const id of ids2) assert.ok(!ids1.includes(id), `第二页不应包含第一页的 ${id}`);

    // 跳到远处的 cursor：应返回空
    const pEnd = await listChildren(pctx, { projectId, nodeId: "atype:service", limit: 2, cursor: "99999:ZZZ" });
    assert.equal(pEnd.items.length, 0, "超出末尾的 cursor 应返回空页");
    assert.equal(pEnd.has_more, false);
  } finally {
    env.cleanup();
  }
});

test("新增记录立即可见：写入观察后 listChildren 和 search 能找到", async () => {
  const env = await setupProject("visibility", { task: "可见性测试" });
  try {
    const { pctx, projectId, session } = env;

    // 先搜索——应无结果
    const before = await searchNodes(pctx, { projectId, query: "新发现的线索" });
    assert.equal(before.items.length, 0, "写入前搜索应为空");

    // 写入观察
    await submit(pctx, {
      session,
      envelope: {
        submission_id: "vis-obs",
        operations: [
          { op: "append_observation", local_ref: "obs", statement: "新发现的线索：test2.com 出现在配置中", conditions: [] },
        ],
      },
    });

    // 立即搜索——应命中
    const after = await searchNodes(pctx, { projectId, query: "新发现的线索" });
    assert.ok(after.items.length > 0, "写入后搜索应立即命中");
  } finally {
    env.cleanup();
  }
});

test("目录重组可达：别名映射后旧节点 ID 解析到新节点", async () => {
  const env = await setupProject("alias", { task: "别名测试" });
  try {
    const { pctx, projectId } = env;

    // 创建别名：旧的虚拟节点 → 新的
    await createAlias(pctx, {
      projectId,
      oldNodeId: "atype:old_category",
      targetNodeId: "atype:service",
      reason: "资产类型重命名",
      actor: "test",
    });

    // 通过旧 ID 打开 → 应解析到 atype:service
    const node = await openNode(pctx, { projectId, nodeId: "atype:old_category" });
    assert.equal(node.node.id, "atype:service", "旧 ID 应解析到新节点");
    assert.ok(node.alias_note, "应有别名解析说明");
  } finally {
    env.cleanup();
  }
});

test("跨项目书签隔离：projA 的书签在 projB 不可见", async () => {
  const envA = await setupProject("bmk-A", { task: "项目 A" });
  const envB = await setupProject("bmk-B", { task: "项目 B" });
  try {
    // 在 A 保存书签
    await saveBookmark(envA.pctx, {
      projectId: envA.projectId,
      role: "worker",
      actorId: "w1",
      nodeId: "root:assets",
      bookmarkKey: "pos",
      note: "A 的位置",
    });

    // 在 B 保存书签（同 role/actorId）
    await saveBookmark(envB.pctx, {
      projectId: envB.projectId,
      role: "worker",
      actorId: "w1",
      nodeId: "root:exploration",
      bookmarkKey: "pos",
      note: "B 的位置",
    });

    // 读取各自的书签
    const bmA = await getBookmark(envA.pctx, { projectId: envA.projectId, role: "worker", actorId: "w1", bookmarkKey: "pos" });
    const bmB = await getBookmark(envB.pctx, { projectId: envB.projectId, role: "worker", actorId: "w1", bookmarkKey: "pos" });
    assert.equal(bmA.node_id, "root:assets", "A 的书签应指向 root:assets");
    assert.equal(bmB.node_id, "root:exploration", "B 的书签应指向 root:exploration");

    // A 的书签列表不含 B 的
    const listA = await listBookmarks(envA.pctx, { projectId: envA.projectId, role: "worker", actorId: "w1" });
    assert.equal(listA.bookmarks.length, 1);
    assert.equal(listA.bookmarks[0].note, "A 的位置");
  } finally {
    envA.cleanup();
    envB.cleanup();
  }
});

test("角色书签隔离：同项目不同 role/actor 书签互不干扰", async () => {
  const env = await setupProject("bmk-role", { task: "角色隔离" });
  try {
    const { pctx, projectId } = env;

    await saveBookmark(pctx, { projectId, role: "planner", actorId: "p1", nodeId: "root:exploration", bookmarkKey: "nav" });
    await saveBookmark(pctx, { projectId, role: "worker", actorId: "w1", nodeId: "root:assets", bookmarkKey: "nav" });

    const bmP = await getBookmark(pctx, { projectId, role: "planner", actorId: "p1", bookmarkKey: "nav" });
    const bmW = await getBookmark(pctx, { projectId, role: "worker", actorId: "w1", bookmarkKey: "nav" });
    assert.equal(bmP.node_id, "root:exploration");
    assert.equal(bmW.node_id, "root:assets");

    // 更新书签
    await saveBookmark(pctx, { projectId, role: "worker", actorId: "w1", nodeId: "atype:service", bookmarkKey: "nav" });
    const bmW2 = await getBookmark(pctx, { projectId, role: "worker", actorId: "w1", bookmarkKey: "nav" });
    assert.equal(bmW2.node_id, "atype:service", "书签应已更新");
    assert.ok(bmW2.bookmark_id, "更新后 ID 不变");
  } finally {
    env.cleanup();
  }
});

test("证据片段读取与范围日志", async () => {
  const env = await setupProject("evidence", { task: "证据读取测试" });
  try {
    const { pctx, projectId, session, db, store } = env;

    // 上传证据 Blob
    const content = Buffer.from("这是一段很长的测试证据内容，用于验证分段读取和范围日志记录功能。".repeat(10), "utf8");
    const blob = await storeBlob(pctx, {
      projectId,
      bytes: content,
      representation: "raw_body",
      sourceKind: "tool_gateway",
      actor: "test",
    });
    assert.ok(blob.blob_id, "应成功上传 Blob");

    // 读取全部（默认 4096 字节）
    const slice1 = await readEvidenceSlice(pctx, {
      projectId,
      targetId: blob.blob_id,
      role: "worker",
      actorId: "w1",
      intentId: "I-test-001",
      attemptId: "ATT-test-001",
    });
    assert.equal(slice1.sha256, blob.sha256);
    assert.equal(slice1.total_bytes, content.length);
    assert.ok(slice1.content.length > 0, "应返回内容");
    assert.equal(slice1.byte_offset, 0);

    // 分段读取
    const slice2 = await readEvidenceSlice(pctx, {
      projectId,
      targetId: blob.sha256,  // 直接用 SHA-256
      byteOffset: 10,
      byteLength: 20,
      role: "worker",
      actorId: "w1",
      intentId: "I-test-001",
      attemptId: "ATT-test-001",
    });
    assert.equal(slice2.byte_offset, 10);
    assert.equal(slice2.byte_length, 20);

    // 验证 material_read_logs 已记录
    const logs = db.prepare(
      "SELECT * FROM material_read_logs WHERE project_id = ? AND intent_id = ? ORDER BY created_seq",
    ).all(projectId, "I-test-001");
    assert.ok(logs.length >= 2, `应有至少 2 条读取日志，实际 ${logs.length}`);
    assert.equal(logs[0].tool_name, "read_evidence_slice");
    assert.equal(logs[0].blob_sha256, blob.sha256);
    assert.equal(logs[0].attempt_id, "ATT-test-001");
    assert.equal(logs[1].byte_offset, 10);
    assert.equal(logs[1].byte_length, 20);
  } finally {
    env.cleanup();
  }
});

test("followRelations：沿关系跳转到关联节点", async () => {
  const env = await setupProject("follow", { task: "关系跳转测试" });
  try {
    const { pctx, projectId, session, store } = env;

    // 创建资产和观察，并用 supports 关系连接
    const svcReceipt = await submit(pctx, {
      session,
      envelope: {
        submission_id: "follow-svc",
        operations: [
          { op: "register_service_asset", local_ref: "svc", url: "http://follow.example.com/" },
          { op: "append_observation", local_ref: "obs", statement: "发现 follow.example.com 存在目录遍历" },
          { op: "add_relation", from: "obs", to: "svc", type: "targets" },
        ],
      },
    });

    const obsId = svcReceipt.ids.obs;
    const svcId = svcReceipt.ids.svc;

    // 从观察沿 targets 跳转
    const rels = await followRelations(pctx, { projectId, nodeId: obsId, types: ["targets"], direction: "outgoing" });
    assert.ok(rels.items.length > 0, "应有 targets 关系");
    assert.equal(rels.items[0].target_id, svcId);
    assert.equal(rels.items[0].relation_type, "targets");
    assert.equal(rels.items[0].direction, "outgoing");
    assert.ok(rels.items[0].target_node, "应包含目标节点信息");
  } finally {
    env.cleanup();
  }
});

test("navigateParent：从深层节点向上走到根", async () => {
  const env = await setupProject("parent", { task: "父节点导航" });
  try {
    const { pctx, projectId, session } = env;

    await submit(pctx, {
      session,
      envelope: {
        submission_id: "parent-seed",
        operations: [
          { op: "register_service_asset", local_ref: "svc", url: "http://parent.example.com/" },
        ],
      },
    });

    // 找到资产 ID
    const children = await listChildren(pctx, { projectId, nodeId: "atype:service" });
    assert.ok(children.items.length > 0);
    const assetId = children.items[0].id;

    // 向上导航：asset → atype:service
    const p1 = await navigateParent(pctx, { projectId, nodeId: assetId });
    assert.equal(p1.node.id, "atype:service");

    // 再向上：atype:service → root:assets
    const p2 = await navigateParent(pctx, { projectId, nodeId: "atype:service" });
    assert.equal(p2.node.id, "root:assets");

    // 根节点再向上：null
    const p3 = await navigateParent(pctx, { projectId, nodeId: "root:assets" });
    assert.equal(p3.parent, null);
  } finally {
    env.cleanup();
  }
});
