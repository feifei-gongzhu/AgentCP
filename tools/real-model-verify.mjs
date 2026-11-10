/**
 * 真实模型验证脚本（纠偏建议 #6）。
 *
 * 场景：模型从零开始，面对预埋隐藏线索的探索项目，
 * 验证是否能自主导航、发现证据、形成完整链路。
 *
 * 用法：node tools/real-model-verify.mjs [--rounds N] [--verbose]
 *
 * 前置：sorne-data/llm.json 已配置。
 */
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockTarget } from "./mock-target.mjs";
import { createProject, getStore, closeStore } from "../lib/store/record-service.mjs";
import { createPlanRequest } from "../lib/store/orchestrator.mjs";
import { issueSession } from "../lib/store/sessions.mjs";
import { startAgentRuntime } from "../lib/agents/runtime.mjs";
import { getLlmUsage } from "../lib/agents/model.mjs";
import { submit } from "../lib/store/record-service.mjs";
import "../lib/store/dedup.mjs";
import "../lib/store/judgements.mjs";

const args = process.argv.slice(2);
const MAX_ROUNDS = Number(args.find(a => a.startsWith("--rounds="))?.split("=")[1]) || 6;
const VERBOSE = args.includes("--verbose");
const LOG = {
  info: (...a) => VERBOSE && console.log("[info]", ...a),
  warn: (...a) => console.warn("[warn]", ...a),
  error: (...a) => console.error("[ERROR]", ...a),
};

/* ── 辅助：结果分析 ─────────────────────────────────────────── */

function analyzeTrace(db, projectId) {
  const toolCalls = db.prepare(
    "SELECT tool_name, status, COUNT(*) AS c FROM tool_calls WHERE project_id = ? GROUP BY tool_name, status ORDER BY c DESC",
  ).all(projectId);
  const navCalls = db.prepare(
    `SELECT tool_name, COUNT(*) AS c FROM tool_calls
     WHERE project_id = ? AND tool_name IN ('read_open','read_children','read_search','read_follow','read_parent','read_evidence_slice','bookmark_save','bookmark_read')
     GROUP BY tool_name ORDER BY c DESC`,
  ).all(projectId);
  const captures = db.prepare("SELECT COUNT(*) AS c FROM captures WHERE project_id = ?").get(projectId).c;
  const blobs = db.prepare("SELECT COUNT(*) AS c FROM blobs WHERE project_id = ?").get(projectId).c;
  const intents = db.prepare("SELECT id, question, status FROM intents WHERE project_id = ?").all(projectId);
  const attempts = db.prepare("SELECT id, intent_id, status FROM attempts WHERE project_id = ?").all(projectId);
  const observations = db.prepare("SELECT COUNT(*) AS c FROM observations WHERE project_id = ?").get(projectId).c;
  const hypotheses = db.prepare("SELECT COUNT(*) AS c FROM hypotheses WHERE project_id = ?").get(projectId).c;
  const extractions = db.prepare("SELECT COUNT(*) AS c FROM extraction_batches WHERE project_id = ?").get(projectId).c;
  const summaries = db.prepare("SELECT branch_id, refresh_status FROM branch_summaries WHERE project_id = ?").all(projectId);
  return { toolCalls, navCalls, captures, blobs, intents, attempts, observations, hypotheses, extractions, summaries };
}

function printReport(analysis, usage, elapsed) {
  console.log("\n══════════════════════════════════════════════════════");
  console.log("  真实模型验证报告");
  console.log("══════════════════════════════════════════════════════\n");
  console.log("⏱  耗时:", (elapsed / 1000).toFixed(1), "秒");
  console.log("📊 LLM 用量:", JSON.stringify(usage));
  console.log("\n── 工具调用统计 ──");
  for (const r of analysis.toolCalls) console.log(`  ${r.tool_name} [${r.status}]: ${r.c}`);
  console.log("\n── 导航工具使用 ──");
  if (analysis.navCalls.length === 0) {
    console.log("  ❌ 未使用任何导航工具（read_open/read_children/read_search）");
  } else {
    for (const r of analysis.navCalls) console.log(`  ✅ ${r.tool_name}: ${r.c} 次`);
  }
  console.log("\n── 证据链路 ──");
  console.log(`  Captures: ${analysis.captures}, Blobs: ${analysis.blobs}`);
  console.log(`  Observations: ${analysis.observations}, Hypotheses: ${analysis.hypotheses}`);
  console.log(`  Extraction Batches: ${analysis.extractions}`);
  console.log("\n── 意图状态 ──");
  for (const i of analysis.intents) console.log(`  ${i.id}: ${i.status} — ${i.question.slice(0, 60)}`);
  console.log("\n── 尝试状态 ──");
  for (const a of analysis.attempts) console.log(`  ${a.id}: ${a.status} (intent: ${a.intent_id})`);
  console.log("\n── 摘要状态 ──");
  for (const s of analysis.summaries) console.log(`  ${s.branch_id}: ${s.refresh_status}`);
  const hasNav = analysis.navCalls.length > 0;
  const hasEvidence = analysis.captures > 0 && analysis.blobs > 0;
  const hasObs = analysis.observations > 0;
  console.log("\n── 验证结论 ──");
  console.log(`  自主导航: ${hasNav ? "✅ 通过" : "❌ 未触发"}`);
  console.log(`  证据固定: ${hasEvidence ? "✅ 通过" : "❌ 未触发"}`);
  console.log(`  观察记录: ${hasObs ? "✅ 通过" : "❌ 未触发"}`);
  console.log("══════════════════════════════════════════════════════\n");
}

/* ── 主流程 ──────────────────────────────────────────────── */

async function main() {
  const llmFile = join(process.cwd(), "sorne-data", "llm.json");
  if (!existsSync(llmFile)) {
    console.error("❌ 未找到 sorne-data/llm.json，请先配置模型提供方");
    process.exit(1);
  }
  console.log("✓ llm.json:", JSON.parse(readFileSync(llmFile, "utf8")).model);

  const dataDir = mkdtempSync(join(tmpdir(), "sorne-realverify-"));
  const { copyFileSync: cp } = await import("node:fs");
  cp(llmFile, join(dataDir, "llm.json"));
  const pctx = { dataDir, logger: LOG };
  const target = await startMockTarget({ port: 0 });
  console.log("✓ Mock 靶标:", target.base);

  try {
    const created = await createProject(pctx, {
      actor: "user",
      name: "真实模型验证（自主导航）",
      description: [
        `对 ${target.base} 进行安全探索。`,
        "目标：发现未授权访问的管理入口和敏感信息泄露。",
        "提示：robots.txt 中可能有被禁止但可访问的路径。",
        "请从 root:assets 和 root:exploration 开始，沿分层记忆主动阅读和导航。",
      ].join("\n"),
      scopeRules: { allow: [target.base + "/", "127.0.0.1"], deny: [], pending: [] },
    });
    const projectId = created.project.id;
    console.log("✓ 项目:", projectId);

    // 预埋一条资产以验证导航发现能力
    const seedSession = issueSession({ project_id: projectId, actor: "seed", role: "worker", ttl_ms: 60_000 });
    await submit(pctx, {
      session: seedSession,
      envelope: {
        submission_id: "seed-assets-1",
        operations: [
          { op: "register_asset", local_ref: "target", canonical_key: target.base.replace("http://", ""), asset_type: "domain", canonicalization_version: "1" },
        ],
      },
    });
    console.log("✓ 预埋资产（等待模型自主探索）");

    await createPlanRequest(pctx, {
      session: issueSession({ project_id: projectId, actor: "orchestrator-agent", role: "orchestrator" }),
      question: `首次探索规划：${target.base} 安全评估——先阅读 robots.txt 找到隐藏路径，再逐一检查未授权访问`,
    });
    console.log("✓ 规划请求已创建");

    const rt = startAgentRuntime(pctx, { tickMs: 600_000, logger: LOG });
    if (!rt.started) {
      console.error("❌ 运行时启动失败:", rt.reason);
      process.exit(1);
    }
    console.log("✓ Agent 运行时启动:", rt.describe());
    const usageBefore = getLlmUsage();
    const t0 = Date.now();

    let resolved = false;
    for (let round = 1; round <= MAX_ROUNDS && !resolved; round++) {
      console.log(`\n── 第 ${round}/${MAX_ROUNDS} 轮 ──`);
      try {
        const summary = await rt.runOnce(projectId);
        if (summary?.skipped) {
          console.log("  跳过:", summary.reason);
          if (summary.reason === "waiting_for_change") break;
          continue;
        }
        for (const r of summary?.roles || []) {
          console.log(`  ${r.role}: stop=${r.stop_reason}, steps=${r.steps ?? "?"}`);
          if (r.error) console.log(`    错误: ${String(r.error).slice(0, 200)}`);
        }
      } catch (err) {
        console.error(`  轮次异常: ${err.message.slice(0, 300)}`);
      }
      const store = await getStore(pctx);
      resolved = Boolean(store.db.prepare(
        "SELECT 1 FROM intents WHERE project_id = ? AND status = 'resolved' LIMIT 1",
      ).get(projectId));
      if (resolved) console.log("  🎯 意图已 resolved！");
      // 诊断：每轮结束后输出关键状态
      const planRuns = store.db.prepare("SELECT id, status FROM plan_runs WHERE project_id = ?").all(projectId);
      const intents = store.db.prepare("SELECT id, status, question FROM intents WHERE project_id = ?").all(projectId);
      const attempts = store.db.prepare("SELECT id, status, intent_id FROM attempts WHERE project_id = ?").all(projectId);
      if (planRuns.length) console.log("  计划:", planRuns.map(p => `${p.id}[${p.status}]`).join(", "));
      if (intents.length) console.log("  意图:", intents.map(i => `${i.id}[${i.status}]`).join(", "));
      if (attempts.length) console.log("  尝试:", attempts.map(a => `${a.id}[${a.status}]`).join(", "));
    }

    const elapsed = Date.now() - t0;
    const usageAfter = getLlmUsage();
    const usage = {
      calls: usageAfter.calls - usageBefore.calls,
      prompt_tokens: usageAfter.prompt_tokens - usageBefore.prompt_tokens,
      completion_tokens: usageAfter.completion_tokens - usageBefore.completion_tokens,
    };
    rt.stop();
    const store = await getStore(pctx);
    const analysis = analyzeTrace(store.db, projectId);
    printReport(analysis, usage, elapsed);
    await closeStore(pctx);
  } finally {
    await target.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((err) => { console.error("致命错误:", err); process.exit(1); });
