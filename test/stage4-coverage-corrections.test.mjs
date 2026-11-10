/**
 * 阶段 4 验收测试——覆盖、证据修正与独立复核（01 号基线 §五、§九、§十、§十二）。
 *
 * 覆盖：
 *   1. 检查记录保存：Worker 按意图/Attempt 保存检查记录，含材料范围、方法、发现、
 *      未覆盖部分与适用条件。
 *   2. 覆盖状态：仅有 material_read_logs 无 check_records → unknown（读取≠检查）。
 *   3. Mock 反证场景：同一字符串先被观察，后发现属于 Mock 配置——观察仍在、
 *      解释得到修正、独立复核有来源、共享资产但无依赖的任务可继续。
 *   4. 受影响意图：修正判断时按 basis_refs/prerequisite_refs 查找依赖意图，
 *      区分「调查」与「依赖成立」。
 *   5. 修正历史可追溯：correctJudgement 保留原观察和反证，修正记录可查。
 *   6. 记录可达：CR/JC 编号经 locateRecord 可定位。
 *   7. 仅读取过材料时覆盖记录显示 unknown。
 *
 * 并行安全：mkdtemp + SORNE_DATA_DIR 注入。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getStore, closeStore, submit } from "../lib/store/record-service.mjs";
import { issueSession } from "../lib/store/sessions.mjs";
import {
  saveCheckRecord,
  listCheckRecords,
  getCoverageForMaterial,
  correctJudgement,
  findAffectedIntents,
  listCorrections,
} from "../lib/store/coverage.mjs";
import { locateRecord } from "../lib/store/records-read.mjs";
import "../lib/store/dedup.mjs";
import "../lib/store/judgements.mjs";

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "sorne-stage4-"));
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
    ).run(`PRJ-${name}`, name, "覆盖与修正测试", "", new Date().toISOString());
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

async function seedIntentWithBasis(env, intentSuffix, { basisRefs = "[]", prereqRefs = "[]", question = "测试意图" } = {}) {
  const { store, projectId } = env;
  const intentId = `I-${projectId}-${intentSuffix}`;
  await store.runSerial((tx) => {
    const seq = tx.prepare("SELECT next_commit_seq AS n FROM projects WHERE id = ?").get(projectId).n;
    tx.prepare("UPDATE projects SET next_commit_seq = ? WHERE id = ?").run(seq + 1, projectId);
    tx.prepare(
      `INSERT INTO intents (id, project_id, question, kind, status, priority, state_version, plan_revision, basis_refs, prerequisite_refs, created_at, created_by, created_seq, updated_seq)
       VALUES (?, ?, ?, 'investigate', 'proposed', 1, 1, 1, ?, ?, ?, 'test', ?, ?)`,
    ).run(intentId, projectId, question, basisRefs, prereqRefs, new Date().toISOString(), seq, seq);
  });
  return intentId;
}

/* ── 1. 检查记录保存 ──────────────────────────────────────────────── */

test("saveCheckRecord：保存检查记录含材料范围、方法、发现与未覆盖部分", async () => {
  const env = await setupProject("check1");
  try {
    const { pctx, projectId } = env;
    const intentId = await seedIntentWithBasis(env, "0002", { question: "检查 app.js" });

    const result = await saveCheckRecord(pctx, {
      projectId,
      intentId,
      attemptId: "ATT-test-001",
      materialIds: ["EI-test-001", "EI-test-002"],
      materialRange: { lines: "1-200", file: "app.js" },
      checkMethod: "接口名称及调用位置",
      findingsEntryIds: ["O-test-001"],
      uncoveredParts: ["服务端行为", "权限边界"],
      applicableConditions: ["应用正常运行"],
      coverageStatus: "partial",
      note: "仅检查了前端代码的接口引用",
      actor: "test-worker",
    });

    assert.ok(result.check_record_id.startsWith("CR-"));
    assert.equal(result.coverage_status, "partial");
    assert.equal(result.material_count, 2);
    assert.equal(result.findings_count, 1);
    assert.equal(result.uncovered_count, 2);

    // 列出检查记录
    const listed = await listCheckRecords(pctx, { projectId, intentId });
    assert.equal(listed.items.length, 1);
    assert.deepEqual(listed.items[0].uncovered_parts, ["服务端行为", "权限边界"]);
    assert.equal(listed.items[0].check_method, "接口名称及调用位置");
  } finally {
    env.cleanup();
  }
});

/* ── 2. 覆盖状态：仅有读取日志无检查记录 → unknown ──────────────── */

test("getCoverageForMaterial：仅有 read_logs 无 check_records → unknown", async () => {
  const env = await setupProject("coverage-unknown");
  try {
    const { pctx, projectId, db, store } = env;

    // 模拟一条 material_read_log（阶段 2 的工具读取记录）
    await store.runSerial((tx) => {
      tx.prepare(
        `INSERT INTO material_read_logs
           (id, project_id, role, actor_id, tool_name, target_id, target_kind, created_at, created_by, created_seq)
         VALUES (?, ?, 'worker', 'test-actor', 'read_evidence_slice', ?, 'blob', ?, 'test', 1)`,
      ).run("MRL-test-001", projectId, "B-target-001", new Date().toISOString());
    });

    const coverage = await getCoverageForMaterial(pctx, { projectId, materialId: "B-target-001" });
    assert.equal(coverage.coverage_status, "unknown");
    assert.equal(coverage.read_count, 1);
    assert.equal(coverage.check_count, 0);
    assert.ok(coverage.note.includes("工具返回过它"), "应说明读取不等于检查");
  } finally {
    env.cleanup();
  }
});

/* ── 3. Mock 反证场景 ─────────────────────────────────────────────── */

test("Mock 反证：观察仍在、解释修正、独立复核有来源、无依赖的任务可继续", async () => {
  const env = await setupProject("mock-disproof");
  try {
    const { pctx, projectId, db, store, session } = env;

    // 1) Worker 提交观察："app.js 中出现 test2.com"
    const sub1 = await submit(pctx, {
      session,
      envelope: {
        submission_id: "obs-mock-1",
        operations: [
          { op: "register_asset", local_ref: "a1", asset_type: "domain", canonicalization_version: "v1", canonical_key: "test2.com" },
          { op: "append_observation", local_ref: "obs1", statement: "app.js 第 42 行出现 test2.com" },
          { op: "propose_hypothesis", local_ref: "hyp1", statement: "test2.com 可能是实际使用的后端服务" },
          { op: "add_relation", from: "obs1", type: "supports", to: "hyp1" },
        ],
      },
    });
    const obsId = sub1.ids.obs1;
    const hypId = sub1.ids.hyp1;
    const assetId = sub1.ids.a1;

    // 2) 基于此假设创建两个意图——一个依赖假设成立，一个共享资产但无依赖
    const dependentIntent = await seedIntentWithBasis(env, "dep1", {
      question: "调查 test2.com 的后端服务",
      prereqRefs: JSON.stringify([{ ref: hypId, requires_state: "suspected" }]),
    });
    const independentIntent = await seedIntentWithBasis(env, "ind1", {
      question: "扫描 test2.com 的开放端口",
      basisRefs: "[]",
      prereqRefs: "[]",
    });

    // 3) 后来发现 test2.com 属于 Mock 配置 → 修正判断
    const sub2 = await submit(pctx, {
      session,
      envelope: {
        submission_id: "obs-mock-2",
        operations: [
          { op: "append_observation", local_ref: "obs2", statement: "test2.com 出现在 __mocks__/config.json，属于测试 Mock 配置" },
        ],
      },
    });
    const counterObsId = sub2.ids.obs2;

    const correction = await correctJudgement(pctx, {
      projectId,
      subjectId: hypId,
      subjectKind: "hypothesis",
      originalInterpretation: "test2.com 可能是实际使用的后端服务",
      correctedInterpretation: "test2.com 是测试 Mock 配置中的占位域名，非实际后端服务",
      correctionReason: "发现 test2.com 出现在 __mocks__/config.json，属于 Mock 配置",
      counterEvidenceIds: [counterObsId],
      preservedObservationIds: [obsId],
      actor: "test-worker",
    });

    assert.ok(correction.correction_id.startsWith("JC-"));

    // 4) 原观察仍在
    const obsRow = db.prepare("SELECT * FROM observations WHERE id = ?").get(obsId);
    assert.ok(obsRow, "原始观察应仍然存在（不被删除）");
    assert.equal(obsRow.statement, "app.js 第 42 行出现 test2.com");

    // 5) 受影响意图：依赖假设的意图被标记，共享资产但无依赖的不受影响
    const affected = correction.affected_intents;
    const depAffected = affected.find((i) => i.id === dependentIntent);
    assert.ok(depAffected, "依赖假设的意图应被标记为受影响");
    assert.equal(depAffected.dependency_type, "depends_on");
    const indAffected = affected.find((i) => i.id === independentIntent);
    assert.ok(!indAffected, "共享资产但无依赖的意图不应受影响");

    // 6) 修正记录可查
    const corrections = await listCorrections(pctx, { projectId, subjectId: hypId });
    assert.equal(corrections.corrections.length, 1);
    assert.equal(corrections.corrections[0].correction_reason, "发现 test2.com 出现在 __mocks__/config.json，属于 Mock 配置");
    assert.deepEqual(corrections.corrections[0].counter_evidence_ids, [counterObsId]);
    assert.deepEqual(corrections.corrections[0].preserved_observation_ids, [obsId]);
  } finally {
    env.cleanup();
  }
});

/* ── 4. findAffectedIntents：区分调查与依赖 ──────────────────────── */

test("findAffectedIntents：区分 investigates 与 depends_on", async () => {
  const env = await setupProject("affected");
  try {
    const { pctx, projectId, store } = env;
    const hypId = "H-external-001";

    // 意图 A：basis_refs 包含假设（由假设提出 → investigates）
    await seedIntentWithBasis(env, "inv1", {
      question: "深入调查此假设",
      basisRefs: JSON.stringify([hypId]),
    });
    // 意图 B：prerequisite_refs 依赖假设成立（→ depends_on）
    await seedIntentWithBasis(env, "dep1", {
      question: "基于假设成立执行下一步",
      prereqRefs: JSON.stringify([{ ref: hypId, requires_state: "suspected" }]),
    });
    // 意图 C：无任何引用（不受影响）
    await seedIntentWithBasis(env, "none1", {
      question: "无关意图",
    });

    const result = await findAffectedIntents(pctx, { projectId, subjectId: hypId });
    assert.equal(result.affected_intents.length, 2);

    const inv = result.affected_intents.find((i) => i.dependency_type === "investigates");
    assert.ok(inv, "应有 investigates 类型");
    const dep = result.affected_intents.find((i) => i.dependency_type === "depends_on");
    assert.ok(dep, "应有 depends_on 类型");
  } finally {
    env.cleanup();
  }
});

/* ── 5. 检查记录分页 ─────────────────────────────────────────────── */

test("listCheckRecords：按意图过滤并游标分页", async () => {
  const env = await setupProject("paginate");
  try {
    const { pctx, projectId } = env;
    const intentId = await seedIntentWithBasis(env, "pg1", { question: "分页测试" });

    // 保存 5 条检查记录
    for (let i = 0; i < 5; i++) {
      await saveCheckRecord(pctx, {
        projectId,
        intentId,
        checkMethod: `方法 ${i}`,
        coverageStatus: i < 3 ? "checked" : "partial",
        actor: "test-worker",
      });
    }

    const page1 = await listCheckRecords(pctx, { projectId, intentId, limit: 3 });
    assert.equal(page1.items.length, 3);
    assert.equal(page1.has_more, true);
    assert.ok(page1.next_cursor);

    const page2 = await listCheckRecords(pctx, { projectId, intentId, cursor: page1.next_cursor, limit: 3 });
    assert.equal(page2.items.length, 2);
    assert.equal(page2.has_more, false);
  } finally {
    env.cleanup();
  }
});

/* ── 6. 记录可达：CR/JC 编号经 locateRecord 定位 ────────────────── */

test("locateRecord：CR 和 JC 编号可定位到对应表", async () => {
  const env = await setupProject("locate4");
  try {
    const { pctx, projectId, db } = env;
    const intentId = await seedIntentWithBasis(env, "loc1");

    const cr = await saveCheckRecord(pctx, {
      projectId, intentId,
      checkMethod: "定位测试",
      actor: "test-worker",
    });

    const jc = await correctJudgement(pctx, {
      projectId,
      subjectId: "H-fake-001",
      subjectKind: "hypothesis",
      correctionReason: "定位测试",
      actor: "test-worker",
    });

    const crLoc = locateRecord(db, projectId, cr.check_record_id);
    assert.ok(crLoc, "CR 编号应可定位");
    assert.equal(crLoc.table, "check_records");

    const jcLoc = locateRecord(db, projectId, jc.correction_id);
    assert.ok(jcLoc, "JC 编号应可定位");
    assert.equal(jcLoc.table, "judgement_corrections");

    // 跨项目不可见
    assert.equal(locateRecord(db, "PRJ-other", cr.check_record_id), null);
  } finally {
    env.cleanup();
  }
});

/* ── 7. 覆盖状态提升：有 check_record → checked/partial ─────────── */

test("getCoverageForMaterial：有 check_records 后覆盖状态提升", async () => {
  const env = await setupProject("cov-upgrade");
  try {
    const { pctx, projectId, store } = env;
    const intentId = await seedIntentWithBasis(env, "cov1");

    const materialId = "EI-material-001";

    // 起初无检查记录 → unknown
    const before = await getCoverageForMaterial(pctx, { projectId, materialId });
    assert.equal(before.coverage_status, "unknown");

    // 保存一条 partial 检查记录
    await saveCheckRecord(pctx, {
      projectId, intentId,
      materialIds: [materialId],
      checkMethod: "部分检查",
      coverageStatus: "partial",
      actor: "test-worker",
    });

    const partial = await getCoverageForMaterial(pctx, { projectId, materialId });
    assert.equal(partial.coverage_status, "partial");
    assert.equal(partial.check_count, 1);

    // 保存一条 checked 检查记录 → 提升到 checked
    await saveCheckRecord(pctx, {
      projectId, intentId,
      materialIds: [materialId],
      checkMethod: "完整检查",
      coverageStatus: "checked",
      actor: "test-worker",
    });

    const checked = await getCoverageForMaterial(pctx, { projectId, materialId });
    assert.equal(checked.coverage_status, "checked");
    assert.equal(checked.check_count, 2);
  } finally {
    env.cleanup();
  }
});
