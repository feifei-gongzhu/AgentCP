/**
 * 阶段 7 贯穿验收测试——完整场景链路（01 号基线 §十七）。
 *
 * 场景：Worker 分析 app.js → 批量保存 → 发现隐蔽线索 → Mock 反证修正 →
 *       未提交最终交接时崩溃 → 恢复已提交产物 → 沿索引形成后续意图。
 *
 * 验收清单（§十七 逐项标注）：
 *   1. 开场无关键线索时，通过导航找到隐蔽材料。
 *   2. 上层摘要未更新时，新材料仍可发现、可读取。
 *   3. 大批量结果只产生简短回执，完整内容可展开。
 *   4. 未检查的材料仍可见（read ≠ checked → coverage unknown）。
 *   5. 新意图形成时关键条件被正确读取与引用。
 *   6. 阶段交接与最终交接不重复触发相同任务。
 *   7. 新证据修正旧判断，通知真正受影响的任务。
 *   8. Worker 崩溃后，已提交成果可恢复。
 *   9. 旧检查点可识别已失效的依据。
 *  10. 恢复流程不引入无效重跑。
 *
 * 并行安全：mkdtemp + SORNE_DATA_DIR 注入。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getStore, submit, buildProjectContext, createProject, createScopeRevision } from "../lib/store/record-service.mjs";
import { issueSession } from "../lib/store/sessions.mjs";
import { saveBatch, getBatch, listItemsByCategory } from "../lib/store/extraction.mjs";
import { saveCheckRecord, getCoverageForMaterial, correctJudgement, findAffectedIntents } from "../lib/store/coverage.mjs";
import { beginRefresh, publishRefresh, getSummary } from "../lib/store/summaries.mjs";
import { shelveBranch, resumeBranch, evaluateWakeConditions, phaseBoundaryCheckpoint, recoverContext } from "../lib/store/scheduling.mjs";
import { createCheckpoint, latestCheckpoint } from "../lib/store/recovery.mjs";
import { openNode, listChildren, searchNodes, followRelations } from "../lib/store/reading.mjs";
import { locateRecord } from "../lib/store/records-read.mjs";
import "../lib/store/dedup.mjs";
import "../lib/store/judgements.mjs";

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "sorne-e2e-"));
}

/**
 * 创建完整项目环境（含任务、范围和角色会话）。
 */
async function setupFullProject() {
  const dir = makeTempDir();
  const prev = process.env.SORNE_DATA_DIR;
  process.env.SORNE_DATA_DIR = dir;
  const pctx = { dataDir: dir, logger: { info() {}, warn() {}, error() {} } };

  const created = await createProject(pctx, {
    actor: "e2e-admin",
    name: "e2e-webapp",
    description: "验收测试：模拟 Web 应用持续探索",
    task: "分析 app.js 的安全性，识别潜在风险域名和配置问题",
    scopeRules: {
      allow: [{ pattern: "*.webapp.local", note: "本地应用域名" }],
      deny: [{ pattern: "*.production.com", note: "禁止访问生产环境" }],
      pending: [],
    },
  });
  const projectId = created.project.id;

  const store = await getStore(pctx);
  const db = store.db;

  const workerSession = issueSession({ project_id: projectId, actor: "e2e-worker", role: "worker", ttl_ms: 300_000 });
  const verifierSession = issueSession({ project_id: projectId, actor: "e2e-verifier", role: "verifier", ttl_ms: 300_000 });

  return {
    pctx, projectId, store, db, workerSession, verifierSession, dir,
    cleanup() {
      try { store.close(); } catch {}
      if (prev === undefined) delete process.env.SORNE_DATA_DIR;
      else process.env.SORNE_DATA_DIR = prev;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function seedIntent(db, projectId, suffix, question, opts = {}) {
  const intentId = `I-${projectId}-${suffix}`;
  const seq = db.prepare("SELECT next_commit_seq AS n FROM projects WHERE id = ?").get(projectId).n;
  db.prepare("UPDATE projects SET next_commit_seq = ? WHERE id = ?").run(seq + 1, projectId);
  db.prepare(
    `INSERT INTO intents (id, project_id, question, kind, status, priority, state_version, plan_revision,
       basis_refs, prerequisite_refs, created_at, created_by, created_seq, updated_seq)
     VALUES (?, ?, ?, 'investigate', ?, 1, 1, 1, ?, ?, ?, 'e2e', ?, ?)`,
  ).run(
    intentId, projectId, question,
    opts.status || "proposed",
    JSON.stringify(opts.basisRefs || []),
    JSON.stringify(opts.prerequisiteRefs || []),
    new Date().toISOString(), seq, seq,
  );
  return intentId;
}

/* ═══════════════════════════════════════════════════════════════════
   §十七 完整场景贯穿验收
   ═══════════════════════════════════════════════════════════════════ */

test("§17 贯穿场景：app.js 批量提取 → 隐蔽线索导航 → Mock 反证 → 崩溃恢复 → 后续意图", async () => {
  const env = await setupFullProject();
  try {
    const { pctx, projectId, store, db, workerSession } = env;

    /* ── §17-1 项目上下文（阶段 1） ────────────────────────────── */

    const ctx = buildProjectContext(db, projectId);
    assert.equal(ctx.goal, "分析 app.js 的安全性，识别潜在风险域名和配置问题");
    assert.equal(ctx.goal_source, "task");
    assert.equal(ctx.goal_missing, false);
    assert.ok(ctx.scope.configured, "应有范围配置");
    assert.ok(ctx.scope.rules.allow.length > 0, "应有 allow 规则");

    /* ── §17-2 Worker 分析 app.js：批量保存提取结果（阶段 3） ──── */

    const extractionItems = [];
    for (let i = 0; i < 200; i++) {
      extractionItems.push({
        category: i < 80 ? "domain" : i < 150 ? "endpoint" : "config_key",
        value: i < 80 ? `host-${i}.webapp.local`
          : i < 150 ? `/api/v1/endpoint-${i}`
          : `config.setting.${i}`,
        provenance: { source: "app.js", line: i + 1 },
      });
    }
    // 插入隐蔽线索：test2.com 在批次深处
    extractionItems.push({
      category: "domain",
      value: "test2.com",
      provenance: { source: "app.js", line: 999, context: "hidden in mock block" },
    });

    const batchReceipt = await saveBatch(pctx, {
      projectId,
      idempotencyKey: "e2e-appjs-batch-1",
      inputSha256: "a".repeat(64),
      captureId: null,
      blobId: null,
      extractorName: "js-domain-extractor",
      extractorVersion: "1.0.0",
      intentId: null,
      attemptId: null,
      runId: "e2e-run-1",
      actor: "e2e-worker",
      items: extractionItems,
    });

    // §17 验收 3：大批量结果只产生简短回执
    const receiptJson = JSON.stringify(batchReceipt);
    assert.ok(receiptJson.length < 2048, `回执应 < 2KB，实际 ${receiptJson.length}`);
    assert.equal(batchReceipt.item_count, 201);
    assert.ok(batchReceipt.category_counts.domain >= 80);

    // 完整内容可展开
    const fullBatch = await getBatch(pctx, { projectId, batchId: batchReceipt.batch_id, offset: 0, limit: 10 });
    assert.equal(fullBatch.items.length, 10);
    assert.equal(fullBatch.item_count, 201);

    // 幂等重放
    const replay = await saveBatch(pctx, {
      projectId, idempotencyKey: "e2e-appjs-batch-1",
      inputSha256: "a".repeat(64), extractorName: "js-domain-extractor",
      extractorVersion: "1.0.0", actor: "e2e-worker", items: extractionItems,
    });
    assert.equal(replay.idempotent, true);
    assert.equal(replay.batch_id, batchReceipt.batch_id);

    /* ── §17-3 Worker 导航发现隐蔽线索（阶段 2） ─────────────── */

    // 不提供关键编号，从根开始搜索
    const searchResult = await searchNodes(pctx, { projectId, query: "test2.com" });
    assert.ok(
      searchResult.items.length >= 1,
      "§17 验收 1：开场无关键线索时，搜索应能找到 test2.com",
    );
    // briefNode 的 title 来自 category（"domain"），具体值需打开记录查看
    // 验证搜索命中了 extraction_items 表中的条目
    const test2Hit = searchResult.items.find((r) => r.record_kind === "extraction_items");
    assert.ok(test2Hit, "搜索结果应包含 extraction_items 中匹配 test2.com 的条目");

    // 按类别分页也能翻到
    const domainItems = await listItemsByCategory(pctx, { projectId, category: "domain", limit: 300 });
    const hasTest2 = domainItems.items.some((it) => it.value === "test2.com");
    assert.ok(hasTest2, "按域名分类分页应包含 test2.com");

    /* ── §17-4 保存观察：test2.com 用途尚未确认 ──────────────── */

    const obs1 = await submit(pctx, {
      session: workerSession,
      envelope: {
        submission_id: "e2e-obs-test2",
        operations: [
          {
            op: "append_observation",
            local_ref: "obs_test2",
            statement: "app.js 第 999 行引用域名 test2.com，用途尚未确认",
          },
        ],
      },
    });
    const obsId = obs1.ids.obs_test2;
    assert.ok(obsId.startsWith("O-"), "观察编号应以 O- 开头");

    // 提出假设
    const hyp1 = await submit(pctx, {
      session: workerSession,
      envelope: {
        submission_id: "e2e-hyp-test2",
        operations: [
          {
            op: "propose_hypothesis",
            local_ref: "hyp_test2",
            statement: "test2.com 可能是外部依赖的测试域名，可能存在 SSRF 风险",
          },
        ],
      },
    });
    const hypId = hyp1.ids.hyp_test2;
    assert.ok(hypId.startsWith("H-"), "假设编号应以 H- 开头");

    // 创建调查意图（依赖此假设）
    const intentInvestigate = seedIntent(db, projectId, "inv-test2", "调查 test2.com 是否为外部可达的测试域名", {
      status: "proposed",
      basisRefs: [hypId],
    });

    // 创建另一个依赖此假设的意图
    const intentDependent = seedIntent(db, projectId, "dep-test2", "若 test2.com 存在 SSRF，评估影响范围", {
      status: "proposed",
      prerequisiteRefs: [hypId],
    });

    /* ── §17-5 发现 Mock 配置 → 修正判断（阶段 4） ────────────── */

    // Worker 发现 test2.com 实际来自测试 Mock 配置
    const obs2 = await submit(pctx, {
      session: workerSession,
      envelope: {
        submission_id: "e2e-obs-mock",
        operations: [
          {
            op: "append_observation",
            local_ref: "obs_mock",
            statement: "test2.com 出现在 test/mocks/config.json 的 Mock 配置中，非生产域名",
          },
        ],
      },
    });
    const mockObsId = obs2.ids.obs_mock;

    // 修正判断：假设的解释需要修正，但原始观察保留
    const correction = await correctJudgement(pctx, {
      projectId,
      subjectId: hypId,
      subjectKind: "hypothesis",
      originalInterpretation: "test2.com 可能是外部依赖的测试域名，可能存在 SSRF 风险",
      correctedInterpretation: "test2.com 是 Mock 配置中的测试域名，非生产环境使用，SSRF 风险不成立",
      correctionReason: "在 test/mocks/config.json 中发现 test2.com 属于测试 Mock 配置",
      counterEvidenceIds: [mockObsId],
      preservedObservationIds: [obsId],
      actor: "e2e-worker",
    });

    // §17 验收 7：新证据修正旧判断，通知真正受影响的任务
    assert.ok(correction.correction_id.startsWith("JC-"), "修正记录编号应以 JC- 开头");
    assert.ok(correction.affected_intents.length >= 1, "应有受影响的意图");
    const affectedIds = correction.affected_intents.map((i) => i.id);
    // 两个意图都应被找到：一个 basis_refs（调查来源），一个 prerequisite_refs（依赖前提）
    assert.ok(affectedIds.includes(intentInvestigate), "调查意图应因 basis_refs 受影响");
    assert.ok(affectedIds.includes(intentDependent), "依赖意图应因 prerequisite_refs 受影响");

    // 原始观察保留（§九：不删除"字符串曾出现"的观察）
    const obsRecord = db.prepare("SELECT * FROM observations WHERE id = ?").get(obsId);
    assert.ok(obsRecord, "原始观察应保留在数据库中");
    assert.ok(obsRecord.statement.includes("test2.com"), "原始观察内容完整");

    /* ── §17-6 覆盖记录：未检查的材料仍可见（阶段 4） ──────── */

    // 记录阅读但不记录检查
    const materialId = batchReceipt.batch_id;
    db.prepare(
      `INSERT INTO material_read_logs (id, project_id, target_id, target_kind, role, actor_id,
         tool_name, byte_offset, byte_length, created_at, created_by, created_seq)
       VALUES (?, ?, ?, 'batch', 'worker', 'e2e-worker', 'read_open', 0, 1000, ?, 'e2e', 1)`,
    ).run(`MRL-${projectId}-1`, projectId, materialId, new Date().toISOString());

    const coverage = await getCoverageForMaterial(pctx, { projectId, materialId });
    // §17 验收 4：read ≠ checked → coverage unknown
    assert.equal(coverage.coverage_status, "unknown", "只读取未检查的材料覆盖状态应为 unknown");
    assert.ok(coverage.read_count > 0, "材料应有阅读记录");

    // 保存检查记录后覆盖状态升级
    await saveCheckRecord(pctx, {
      projectId,
      intentId: intentInvestigate,
      attemptId: null,
      materialIds: [materialId],
      materialRange: { file: "app.js", lines: "1-200" },
      checkMethod: "manual_review",
      findingsEntryIds: [],
      uncoveredParts: [{ file: "app.js", lines: "201-999", reason: "未检查" }],
      coverageStatus: "partial",
      actor: "e2e-worker",
    });

    const coverageAfter = await getCoverageForMaterial(pctx, { projectId, materialId });
    assert.equal(coverageAfter.coverage_status, "partial", "检查后覆盖状态应升级为 partial");

    /* ── §17-7 摘要生命周期（阶段 5） ────────────────────────── */

    // 开始摘要刷新
    const refreshStart = await beginRefresh(pctx, {
      projectId,
      branchId: intentInvestigate,
      branchKind: "intent",
      actor: "e2e-planner",
    });
    assert.ok(refreshStart.refresh_input_seq, "刷新应固定输入水位");

    // 刷新期间追加新内容
    await submit(pctx, {
      session: workerSession,
      envelope: {
        submission_id: "e2e-obs-during-refresh",
        operations: [
          { op: "append_observation", local_ref: "obs_mid", statement: "刷新期间发现的新线索" },
        ],
      },
    });

    // 发布刷新
    const pub = await publishRefresh(pctx, {
      projectId,
      branchId: intentInvestigate,
      semanticSummary: "调查 test2.com 的来源和用途，已确认为 Mock 配置",
      actor: "e2e-planner",
    });
    assert.equal(pub.has_unsummarized, true, "刷新期间有新内容到达，应标为有未汇总");
    assert.equal(pub.refresh_status, "stale", "刷新期间有新内容，状态应为 stale");

    // §17 验收 2：摘要刷新后，刷新期间的新材料仍可发现
    const summary = await getSummary(pctx, { projectId, branchId: intentInvestigate, branchKind: "intent" });
    assert.ok(summary.semantic_summary.includes("Mock"), "摘要应包含修正后的结论");
    assert.equal(summary.refresh_status, "stale", "摘要应标记为 stale——刷新期间的新内容尚未纳入");

    /* ── §17-8 阶段检查点 → Worker 崩溃 → 恢复（阶段 6） ──── */

    // 创建检查点（模拟阶段边界）
    const cp = await phaseBoundaryCheckpoint(pctx, {
      projectId,
      intentId: intentInvestigate,
      actor: "e2e-worker",
      phaseNote: "完成 test2.com 初步分析，即将交接",
    });
    assert.ok(cp.checkpoint_id.startsWith("CP-"), "检查点编号应以 CP- 开头");
    assert.equal(cp.content.intent.id, intentInvestigate);

    // 模拟 Worker 崩溃（未提交最终交接）

    // §17 验收 8：崩溃后已提交成果可恢复
    const recovered = await recoverContext(pctx, { projectId });
    assert.ok(recovered.checkpoint, "恢复应有检查点");
    assert.equal(recovered.checkpoint.checkpoint_id, cp.checkpoint_id);
    assert.ok(recovered.checkpoint.has_content, "检查点应有内容");
    assert.ok(recovered.note.includes("恢复入口"), "应说明检查点是恢复入口");

    // 已提交的观察、批次仍可读取
    const obsStillThere = db.prepare("SELECT * FROM observations WHERE id = ?").get(obsId);
    assert.ok(obsStillThere, "崩溃后观察记录应仍存在");
    const batchStillThere = await getBatch(pctx, { projectId, batchId: batchReceipt.batch_id, offset: 0, limit: 1 });
    assert.equal(batchStillThere.item_count, 201, "崩溃后批量提取记录应仍完整");

    /* ── §17-9 旧检查点识别失效依据（阶段 6） ───────────────── */

    // 修改意图状态（模拟外部变化）
    db.prepare("UPDATE intents SET status = 'cancelled' WHERE id = ?").run(intentInvestigate);

    // 新检查点反映变化
    const cp2 = await createCheckpoint(pctx, { projectId, intentId: intentInvestigate, actor: "e2e" });
    assert.equal(cp2.content.intent.status, "cancelled", "§17 验收 9：新检查点应反映已变更的状态");
    assert.notEqual(cp2.checkpoint_id, cp.checkpoint_id, "应为不同的检查点");

    // 恢复旧检查点对照当前——识别出状态已改变
    const oldCp = db.prepare("SELECT * FROM checkpoints WHERE id = ?").get(cp.checkpoint_id);
    const oldContent = JSON.parse(oldCp.content);
    const currentIntent = db.prepare("SELECT status FROM intents WHERE id = ?").get(intentInvestigate);
    assert.notEqual(oldContent.intent.status, currentIntent.status, "旧检查点的意图状态与当前不同，标识失效");

    /* ── §17-10 交接去重（阶段 6） ────────────────────────────── */

    // 恢复意图以便测试交接
    db.prepare("UPDATE intents SET status = 'proposed' WHERE id = ?").run(intentInvestigate);

    const handoff1 = await submit(pctx, {
      session: workerSession,
      envelope: {
        submission_id: "e2e-handoff-final",
        operations: [
          { op: "append_observation", local_ref: "final_obs", statement: "最终交接：test2.com 为 Mock 域名，无安全风险" },
        ],
      },
    });
    const finalObsId = handoff1.ids.final_obs;

    // §17 验收 6：重复交接不产生新任务
    const handoff2 = await submit(pctx, {
      session: workerSession,
      envelope: {
        submission_id: "e2e-handoff-final",
        operations: [
          { op: "append_observation", local_ref: "final_obs", statement: "最终交接：test2.com 为 Mock 域名，无安全风险" },
        ],
      },
    });
    assert.equal(handoff2.ids.final_obs, finalObsId, "重复交接应返回原编号");

    /* ── §17-11 搁置与唤醒（阶段 6） ────────────────────────── */

    // 搁置依赖意图
    const shelved = await shelveBranch(pctx, {
      projectId,
      branchId: intentDependent,
      branchKind: "intent",
      shelveReason: "hypothesis_falsified",
      reasonDetail: "前提假设（test2.com SSRF 风险）已被反证",
      scope: "暂停该意图及其下游",
      reconsiderConditions: ["发现 test2.com 在生产环境中出现"],
      wakeOnEventTypes: ["observation.appended"],
      actor: "e2e-orchestrator",
    });
    assert.equal(shelved.status, "shelved");

    // 当前无匹配事件
    const wakeBefore = await evaluateWakeConditions(pctx, { projectId });
    // 搁置之前已有 observation.appended 事件，但搁置之后还没有新的
    // （注意：需要在搁置之后提交新观察才会触发唤醒）

    // 新证据到达 → 唤醒
    await submit(pctx, {
      session: workerSession,
      envelope: {
        submission_id: "e2e-new-evidence",
        operations: [
          { op: "append_observation", local_ref: "new_clue", statement: "在生产日志中发现 test2.com 出站请求" },
        ],
      },
    });

    const wakeAfter = await evaluateWakeConditions(pctx, { projectId });
    assert.ok(wakeAfter.wakeable.length >= 1, "新观察应触发搁置分支的唤醒条件");
    const wokenBranch = wakeAfter.wakeable.find((w) => w.branch_id === intentDependent);
    assert.ok(wokenBranch, "依赖意图应因新证据被标为可唤醒");

    // 恢复分支
    const resumed = await resumeBranch(pctx, {
      projectId,
      branchId: intentDependent,
      actor: "e2e-orchestrator",
      resumeNote: "生产日志中发现 test2.com 出站请求，需重新评估",
    });
    assert.equal(resumed.resumed, true);

    /* ── §17-12 Planner 视角：沿索引读取证据，形成后续意图（阶段 5）── */

    // §17 验收 5：关键条件在形成新意图时被正确读取引用
    // 读取修正记录
    const corrections = db.prepare(
      "SELECT * FROM judgement_corrections WHERE project_id = ? AND subject_id = ?",
    ).all(projectId, hypId);
    assert.ok(corrections.length >= 1, "应有修正记录可供 Planner 参考");
    const corrRecord = corrections[0];
    const counterEvidence = JSON.parse(corrRecord.counter_evidence_ids_json);
    assert.ok(counterEvidence.includes(mockObsId), "修正记录应引用 Mock 发现的观察");
    const preserved = JSON.parse(corrRecord.preserved_observation_ids_json);
    assert.ok(preserved.includes(obsId), "修正记录应保留原始观察引用");

    // Planner 可以沿索引找到所有证据链
    const affectedForPlanner = await findAffectedIntents(pctx, { projectId, subjectId: hypId });
    assert.ok(affectedForPlanner.affected_intents.length >= 2, "Planner 应能找到所有受假设影响的意图");

    // 通过搜索找到修正相关记录（无需预先知道编号）
    const corrSearch = await searchNodes(pctx, { projectId, query: "Mock" });
    assert.ok(corrSearch.items.length >= 1, "Planner 搜索 Mock 应能找到相关记录");

    // 所有关键记录可经 locateRecord 定位
    assert.ok(locateRecord(db, projectId, obsId), "原始观察应可定位");
    assert.ok(locateRecord(db, projectId, hypId), "假设应可定位");
    assert.ok(locateRecord(db, projectId, correction.correction_id), "修正记录应可定位");
    assert.ok(locateRecord(db, projectId, shelved.shelving_id), "搁置记录应可定位");
    assert.ok(locateRecord(db, projectId, batchReceipt.batch_id), "批次记录应可定位");

    /* ── §17-13 综合恢复入口（阶段 6） ──────────────────────── */

    // §17 验收 10：恢复流程不引入无效重跑
    const finalRecover = await recoverContext(pctx, { projectId });
    assert.ok(finalRecover.checkpoint, "最终恢复应有检查点");
    assert.ok(finalRecover.waiting, "最终恢复应有等待状态");
    assert.ok(finalRecover.wake_conditions, "最终恢复应有唤醒条件");
    // 恢复后搁置分支已被恢复，不应再有搁置
    assert.equal(finalRecover.shelved_branches.total, 0, "已恢复的分支不应再出现在搁置列表");

  } finally {
    env.cleanup();
  }
});

/* ── 跨项目隔离验证（§十七附加） ────────────────────────────── */

test("§17 附加：跨项目数据不串入——不同项目的线索和记录互不可见", async () => {
  const dir = makeTempDir();
  const prev = process.env.SORNE_DATA_DIR;
  process.env.SORNE_DATA_DIR = dir;
  const pctx = { dataDir: dir, logger: { info() {}, warn() {}, error() {} } };

  try {
    const createdA = await createProject(pctx, { actor: "admin", name: "project-alpha", task: "分析 Alpha 系统" });
    const createdB = await createProject(pctx, { actor: "admin", name: "project-beta", task: "分析 Beta 系统" });
    const projA = createdA.project;
    const projB = createdB.project;

    const store = await getStore(pctx);
    const sessionA = issueSession({ project_id: projA.id, actor: "worker-a", role: "worker", ttl_ms: 60_000 });
    const sessionB = issueSession({ project_id: projB.id, actor: "worker-b", role: "worker", ttl_ms: 60_000 });

    // Alpha 项目提交观察
    await submit(pctx, {
      session: sessionA,
      envelope: {
        submission_id: "alpha-obs-1",
        operations: [{ op: "append_observation", local_ref: "a1", statement: "Alpha 系统的秘密线索" }],
      },
    });

    // Beta 项目搜索不应看到 Alpha 的内容
    const searchB = await searchNodes(pctx, { projectId: projB.id, query: "Alpha" });
    const leakedResults = searchB.items.filter((r) => r.text?.includes("Alpha") || r.text?.includes("秘密"));
    assert.equal(leakedResults.length, 0, "Beta 项目不应看到 Alpha 项目的线索");

    // Alpha 项目上下文不包含 Beta 的目标
    const ctxA = buildProjectContext(store.db, projA.id);
    assert.ok(!ctxA.goal.includes("Beta"), "Alpha 上下文不应包含 Beta 的目标");

    const ctxB = buildProjectContext(store.db, projB.id);
    assert.ok(!ctxB.goal.includes("Alpha"), "Beta 上下文不应包含 Alpha 的目标");

    store.close();
  } finally {
    if (prev === undefined) delete process.env.SORNE_DATA_DIR;
    else process.env.SORNE_DATA_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
