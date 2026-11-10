/**
 * 阶段 1 验收测试：项目与角色上下文（IMPLEMENTATION-PLAN.md §阶段 1；01 号基线 §3/§15/§16/§17）。
 *
 * 覆盖验收点：
 *   1. 统一项目目标与补充说明：task 优先、task 为空回退 description、均为空显式标记 goal_missing=true；
 *   2. 两个不同项目（不同 task、description、allow/deny/pending 范围）下，Planner、Orchestrator、
 *      Worker、Verifier 四角色的模型输入各自包含本项目的目标、补充说明与范围规则，互不串味，
 *      且不含任何旧项目硬编码（oa.jou.edu.cn / SR-0002 / 通达 OA 2015_01）；
 *   3. 侦察摘要（buildReconSummary）按当前项目过滤，每条线索附带 source_refs 证据编号，
 *      不把无关产品的候选入口硬塞给其他项目；
 *   4. 仅含本地文件范围（file://）的项目可被规划与执行为材料检查任务；未授权网络动作被网关拒绝
 *      （SCOPE_DENIED / SCOPE_UNRESOLVED），而发现范围外资产仍可经 register_asset 建档为 pending；
 *   5. Orchestrator 职责边界：assign_execution 禁止静默改写意图字段（PRECONDITION_INVALID），
 *      必须通过 revise_intent 持久化修订（推进 state_version 与计划修订记录）或 request_planning 重新规划。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  closeStore,
  createProject,
  getProjectContext,
  getStore,
  submit,
} from "../lib/store/record-service.mjs";
import "../lib/store/dedup.mjs";
import "../lib/store/judgements.mjs";
import { startExploration } from "../lib/store/explore.mjs";
import { receivePlanRevision, transitionIntent, listIntents } from "../lib/store/intents.mjs";
import { dispatchAttempt, toolGateway } from "../lib/store/attempts.mjs";
import {
  executeDecisionActions,
  orchestratorOverview,
  recordDecision,
} from "../lib/store/orchestrator.mjs";
import { registerCapture, storeBlob } from "../lib/store/evidence.mjs";
import { requestVerification } from "../lib/store/verification.mjs";
import { issueSession } from "../lib/store/sessions.mjs";
import { buildReconSummary } from "../lib/agents/recon.mjs";
import { runPlanner } from "../lib/agents/planner.mjs";
import { runOrchestrator } from "../lib/agents/orchestrator.mjs";
import { runWorker } from "../lib/agents/worker.mjs";
import { runVerifier } from "../lib/agents/verifier.mjs";

async function withTempCtx(fn) {
  const dataDir = await mkdtemp(join(tmpdir(), "sorne-stage1-"));
  const pctx = {
    dataDir,
    config: {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    agents: {
      reload: async () => ({ reloaded: true, started: true }),
    },
  };
  try {
    await getStore(pctx);
    return await fn(pctx);
  } finally {
    await closeStore(pctx);
    await rm(dataDir, { recursive: true, force: true });
  }
}

/** 构造录制模型调用的桩：记录每次 chat({ system, messages, tools }) 的完整输入。 */
function makeRecordingModel(handler) {
  const calls = [];
  return {
    model: "mock-stage1-model",
    calls,
    describe: () => "mock:stage1",
    async chat(req) {
      calls.push(req);
      return handler(req, calls.length);
    },
  };
}

test("阶段 1.1：统一项目目标解析（task 优先、description 回退、均空显式标记 goal_missing）", async () => {
  await withTempCtx(async (pctx) => {
    // 1) 同时提供 task 与 description → 优先使用 task，不丢弃 description
    const p1 = await createProject(pctx, {
      actor: "user",
      name: "项目-主目标优先",
      task: "验证网关鉴权绕过与租户隔离边界",
      description: "补充背景：测试环境位于内网隔离区，仅供授权核查",
      scopeRules: { allow: ["https://api.tenant-a.internal/*"], deny: [], pending: [] },
    });
    assert.equal(p1.project.goal, "验证网关鉴权绕过与租户隔离边界");
    assert.equal(p1.project.goal_source, "task");
    assert.equal(p1.project.goal_missing, false);
    assert.equal(p1.project.description, "补充背景：测试环境位于内网隔离区，仅供授权核查");

    const exp1 = await startExploration(pctx, { projectId: p1.project.id });
    assert.equal(exp1.goal, "验证网关鉴权绕过与租户隔离边界");
    assert.equal(exp1.goal_source, "task");
    assert.equal(exp1.goal_missing, false);

    // 2) task 为空、description 非空 → 回退使用 description
    const p2 = await createProject(pctx, {
      actor: "user",
      name: "项目-描述回退",
      task: "   ",
      description: "历史项目：仅在 description 中填写了接口盘点目标",
      scopeRules: { allow: ["https://legacy.tenant-b.internal/*"], deny: [], pending: [] },
    });
    assert.equal(p2.project.goal, "历史项目：仅在 description 中填写了接口盘点目标");
    assert.equal(p2.project.goal_source, "description_fallback");
    assert.equal(p2.project.goal_missing, false);

    const exp2 = await startExploration(pctx, { projectId: p2.project.id });
    assert.equal(exp2.goal, "历史项目：仅在 description 中填写了接口盘点目标");
    assert.equal(exp2.goal_source, "description_fallback");
    assert.equal(exp2.goal_missing, false);

    // 3) task 与 description 均为空 → 显式标记 goal_missing = true
    const p3 = await createProject(pctx, {
      actor: "user",
      name: "项目-目标缺失",
      task: "",
      description: "",
    });
    assert.equal(p3.project.goal, "");
    assert.equal(p3.project.goal_source, "missing");
    assert.equal(p3.project.goal_missing, true);

    const exp3 = await startExploration(pctx, { projectId: p3.project.id });
    assert.equal(exp3.goal_missing, true);
    assert.equal(exp3.goal_source, "missing");
  });
});

test("阶段 1.2 & 1.3：两个不同项目的四角色上下文隔离、无硬编码目标且侦察摘要按证据追溯", async () => {
  await withTempCtx(async (pctx) => {
    // 创建项目 A：网络接口测试任务
    const projA = (
      await createProject(pctx, {
        actor: "user",
        name: "项目A-订单网关测试",
        task: "核查 order-gw.corp-alpha.test 的签名校验与越权订单读取",
        description: "项目A补充说明：仅允许访问 order-gw，禁止访问 billing-core",
        scopeRules: {
          allow: ["http://order-gw.corp-alpha.test/*"],
          deny: ["http://billing-core.corp-alpha.test/*"],
          pending: ["http://audit-log.corp-alpha.test/*"],
        },
      })
    ).project;

    // 创建项目 B：纯本地材料与配置文件检查任务
    const projB = (
      await createProject(pctx, {
        actor: "user",
        name: "项目B-离线配置材料审计",
        task: "检查本地归档配置与抓包材料中的明文凭据与脆弱签名算法",
        description: "项目B补充说明：纯本地材料分析任务，禁止发起任何外部网络请求",
        scopeRules: {
          allow: ["file:///workspace/archive-b/*"],
          deny: ["http://order-gw.corp-alpha.test/*"],
          pending: [],
        },
      })
    ).project;

    // 在项目 A 中写入一条真实证据与观察，验证 buildReconSummary 只提取项目 A 的证据且附带编号
    const workerSessA = issueSession({ project_id: projA.id, actor: "w-init-a", role: "worker" });
    const runtimeSessA = issueSession({ project_id: projA.id, actor: "runtime", role: "runtime" });
    const plannerSessA = issueSession({ project_id: projA.id, actor: "planner-a", role: "planner" });

    const assetSubA = await submit(pctx, {
      session: workerSessA,
      envelope: {
        submission_id: "SUB-STAGE1-A-ASSET",
        operations: [
          {
            op: "register_service_asset",
            local_ref: "svcA",
            url: "http://order-gw.corp-alpha.test/",
          },
          {
            op: "register_http_resource",
            local_ref: "resA",
            url: "http://order-gw.corp-alpha.test/v1/orders?id=100",
            method: "GET",
          },
        ],
      },
    });
    const svcAssetIdA = assetSubA.ids.svcA;
    const resIdA = assetSubA.ids.resA;

    const planRevA = await receivePlanRevision(pctx, {
      session: plannerSessA,
      envelope: {
        submission_id: "PLAN-STAGE1-A-1",
        plan_revision: "r1",
        intents: [
          {
            op: "create",
            local_ref: "iA1",
            question: "http://order-gw.corp-alpha.test/v1/orders 接口是否校验租户签名？",
            kind: "investigate",
            rationale: "核查项目A主目标",
            target_asset_ids: [svcAssetIdA],
            success_criteria: "明确签名校验行为并固定响应证据",
            deliverables: ["带采集证据的观察记录"],
          },
        ],
      },
    });
    const intentIdA = planRevA.ids.iA1;
    await transitionIntent(pctx, { projectId: projA.id, actor: "runtime", intentId: intentIdA, action: "activate", via: "test" });
    const dispatchA = await dispatchAttempt(pctx, {
      session: runtimeSessA,
      intentId: intentIdA,
      workerId: "w-init-a",
      assignmentId: "ASG-A-1",
    });

    const tcRegA = await toolGateway(pctx, {
      session: workerSessA,
      action: "register",
      attemptId: dispatchA.attempt.id,
      fencingToken: dispatchA.fencing_token,
      toolName: "http_probe",
      targets: ["http://order-gw.corp-alpha.test/v1/orders"],
    });
    await toolGateway(pctx, {
      session: workerSessA,
      action: "start",
      attemptId: dispatchA.attempt.id,
      toolCallId: tcRegA.tool_call.id,
      fencingToken: dispatchA.fencing_token,
      targets: ["http://order-gw.corp-alpha.test/v1/orders"],
    });
    const blobA = await storeBlob(pctx, {
      projectId: projA.id,
      bytes: Buffer.from("<html><head><title>OrderGateway Alpha v2.4</title></head><body>ok</body></html>", "utf8"),
      representation: "raw_body",
      sourceKind: "tool_gateway",
      actor: "w-init-a",
    });
    const capA = await registerCapture(
      pctx,
      {
        project_id: projA.id,
        tool_call_id: tcRegA.tool_call.id,
        attempt_id: dispatchA.attempt.id,
        resource_id: resIdA,
        request_url_exact: "http://order-gw.corp-alpha.test/v1/orders",
        method: "GET",
        response_body_blob: blobA.blob_id,
        source_kind: "tool_gateway",
      },
      { actor: "w-init-a" },
    );
    await toolGateway(pctx, {
      session: workerSessA,
      action: "complete",
      attemptId: dispatchA.attempt.id,
      toolCallId: tcRegA.tool_call.id,
      fencingToken: dispatchA.fencing_token,
      outcome: "succeeded",
      evidenceRefs: [capA.capture_id],
      touchedTargets: ["http://order-gw.corp-alpha.test/v1/orders"],
    });

    // 核查侦察摘要隔离与证据编号追溯
    const reconA = await buildReconSummary(pctx, projA.id);
    const reconB = await buildReconSummary(pctx, projB.id);
    assert.equal(reconA.project_id, projA.id);
    assert.equal(reconA.title, "OrderGateway Alpha v2.4");
    assert.ok(reconA.evidence.includes(capA.capture_id), "项目A侦察摘要必须包含真实采集编号");
    assert.ok(reconA.evidence.includes(resIdA), "项目A侦察摘要必须包含真实资源样本编号");
    assert.ok(
      reconA.clues.some((c) => c.kind === "title" && c.source_refs.includes(capA.capture_id)),
      "项目A每条提炼线索必须附带可追溯的证据编号",
    );
    assert.equal(reconA.candidate_surface.length, 0, "未命中特定产品指纹时不得硬塞候选入口面");

    assert.equal(reconB.project_id, projB.id);
    assert.equal(reconB.title, null, "项目B侦察摘要不得串入项目A的标题");
    assert.equal(reconB.observed_paths.length, 0, "项目B侦察摘要不得串入项目A的路径");
    assert.equal(reconB.evidence.length, 0, "项目B无采集时 evidence 应为空");

    // 为项目 B 登记本地文件资产与本地材料 Blob，建立材料检查意图
    const workerSessB = issueSession({ project_id: projB.id, actor: "w-init-b", role: "worker" });
    const plannerSessB = issueSession({ project_id: projB.id, actor: "planner-b", role: "planner" });
    const runtimeSessB = issueSession({ project_id: projB.id, actor: "runtime", role: "runtime" });

    const blobB = await storeBlob(pctx, {
      projectId: projB.id,
      bytes: Buffer.from("jwt_secret: hardcoded_dev_key_12345\n", "utf8"),
      representation: "uploaded_file",
      sourceKind: "worker_upload",
      actor: "w-init-b",
    });

    const assetSubB = await submit(pctx, {
      session: workerSessB,
      envelope: {
        submission_id: "SUB-STAGE1-B-ASSET",
        operations: [
          {
            op: "register_asset",
            local_ref: "fileAssetB",
            asset_type: "file",
            canonicalization_version: "v1",
            canonical_key: "file:///workspace/archive-b/config.yaml",
          },
        ],
      },
    });
    const fileAssetIdB = assetSubB.ids.fileAssetB;

    const planRevB = await receivePlanRevision(pctx, {
      session: plannerSessB,
      envelope: {
        submission_id: "PLAN-STAGE1-B-1",
        plan_revision: "r1",
        intents: [
          {
            op: "create",
            local_ref: "iB1",
            question: "检查本地文件 file:///workspace/archive-b/config.yaml 是否存在硬编码密钥",
            kind: "investigate",
            rationale: "本地配置材料检查，无需网络探测",
            target_asset_ids: [fileAssetIdB],
            success_criteria: "完成本地配置文件密钥核查并记录观察",
            deliverables: ["本地材料检查观察记录"],
          },
        ],
      },
    });
    const intentIdB = planRevB.ids.iB1;
    await transitionIntent(pctx, { projectId: projB.id, actor: "runtime", intentId: intentIdB, action: "activate", via: "test" });
    const dispatchB = await dispatchAttempt(pctx, {
      session: runtimeSessB,
      intentId: intentIdB,
      workerId: "w-init-b",
      assignmentId: "ASG-B-1",
    });

    // 为项目 A 与项目 B 各建立一条待验证漏洞与验证任务，供 Verifier 角色输入核查
    const findA = await submit(pctx, {
      session: workerSessA,
      envelope: {
        submission_id: "SUB-STAGE1-A-VULN",
        attempt_id: dispatchA.attempt.id,
        operations: [
          {
            op: "append_observation",
            local_ref: "obsA",
            statement: "order-gw 返回 200 且未校验 X-Tenant-Sig",
            capture_id: capA.capture_id,
            conditions: ["anonymous"],
          },
          {
            op: "report_vulnerability",
            local_ref: "vulnA",
            category: "broken_access_control",
            asset_id: svcAssetIdA,
            location: "/v1/orders",
            impact: "跨租户读取订单",
          },
          {
            op: "add_relation",
            from: "obsA",
            type: "supports",
            to: "vulnA",
          },
        ],
      },
    });
    const verJobA = await requestVerification(pctx, {
      session: issueSession({ project_id: projA.id, actor: "orch-a", role: "orchestrator" }),
      input: {
        subject_id: findA.ids.vulnA,
        policy_id: "default-verification",
        policy_version: "v1",
        conditions: ["anonymous"],
        raw_evidence_refs: [capA.capture_id],
        opposing_evidence_refs: [],
      },
    });

    const findB = await submit(pctx, {
      session: workerSessB,
      envelope: {
        submission_id: "SUB-STAGE1-B-VULN",
        attempt_id: dispatchB.attempt.id,
        operations: [
          {
            op: "append_observation",
            local_ref: "obsB",
            statement: "本地配置文件 config.yaml 含有明文签名私钥",
            conditions: ["local_archive"],
          },
          {
            op: "report_vulnerability",
            local_ref: "vulnB",
            category: "hardcoded_secret",
            asset_id: fileAssetIdB,
            location: "file:///workspace/archive-b/config.yaml",
            impact: "离线签名可被伪造",
          },
          {
            op: "add_relation",
            from: "obsB",
            type: "supports",
            to: "vulnB",
          },
        ],
      },
    });
    const verJobB = await requestVerification(pctx, {
      session: issueSession({ project_id: projB.id, actor: "orch-b", role: "orchestrator" }),
      input: {
        subject_id: findB.ids.vulnB,
        policy_id: "default-verification",
        policy_version: "v1",
        conditions: ["local_archive"],
        raw_evidence_refs: [blobB.blob_id],
        opposing_evidence_refs: [],
      },
    });

    // 分别捕获项目 A 与项目 B 下 Planner / Orchestrator / Worker / Verifier 的模型输入
    const noopModel = () =>
      makeRecordingModel(async () => ({
        content: "已完成检查",
        tool_calls: [],
        finish_reason: "stop",
      }));

    const plannerModelA = noopModel();
    const plannerModelB = noopModel();
    await runPlanner(pctx, { projectId: projA.id, model: plannerModelA, maxSteps: 1 });
    await runPlanner(pctx, { projectId: projB.id, model: plannerModelB, maxSteps: 1 });

    const orchModelA = noopModel();
    const orchModelB = noopModel();
    await runOrchestrator(pctx, { projectId: projA.id, model: orchModelA, maxSteps: 1 });
    await runOrchestrator(pctx, { projectId: projB.id, model: orchModelB, maxSteps: 1 });

    const workerModelA = noopModel();
    const workerModelB = noopModel();
    await runWorker(pctx, {
      projectId: projA.id,
      intentId: intentIdA,
      attemptId: dispatchA.attempt.id,
      fencingToken: dispatchA.fencing_token,
      model: workerModelA,
      maxSteps: 1,
    });
    await runWorker(pctx, {
      projectId: projB.id,
      intentId: intentIdB,
      attemptId: dispatchB.attempt.id,
      fencingToken: dispatchB.fencing_token,
      model: workerModelB,
      maxSteps: 1,
    });

    const verifierModelA = noopModel();
    const verifierModelB = noopModel();
    await runVerifier(pctx, { projectId: projA.id, jobId: verJobA.job.id, model: verifierModelA, maxSteps: 1 });
    await runVerifier(pctx, { projectId: projB.id, jobId: verJobB.job.id, model: verifierModelB, maxSteps: 1 });

    const serializeInput = (m) => {
      assert.equal(m.calls.length, 1);
      return JSON.stringify({
        system: m.calls[0].system,
        messages: m.calls[0].messages,
        tools: m.calls[0].tools,
      });
    };

    for (const [roleName, modelA, modelB] of [
      ["planner", plannerModelA, plannerModelB],
      ["orchestrator", orchModelA, orchModelB],
      ["worker", workerModelA, workerModelB],
      ["verifier", verifierModelA, verifierModelB],
    ]) {
      const textA = serializeInput(modelA);
      const textB = serializeInput(modelB);

      // 1) 严禁残留旧项目硬编码
      for (const legacy of ["oa.jou.edu.cn", "在授权范围（SR-0002", "通达 OA 2015_01"]) {
        assert.ok(!textA.includes(legacy), `角色 ${roleName} (项目A) 输入仍残留硬编码：${legacy}`);
        assert.ok(!textB.includes(legacy), `角色 ${roleName} (项目B) 输入仍残留硬编码：${legacy}`);
      }

      // 1b) 范围版本编号严格按项目隔离（项目 A 仅含自身 scope_revision_id，项目 B 仅含自身 scope_revision_id）
      assert.ok(
        textA.includes(projA.current_scope_revision),
        `角色 ${roleName} (项目A) 未收到项目A的 scope_revision_id (${projA.current_scope_revision})`,
      );
      assert.ok(
        !textA.includes(projB.current_scope_revision),
        `角色 ${roleName} (项目A) 串入了项目B的 scope_revision_id (${projB.current_scope_revision})`,
      );
      assert.ok(
        textB.includes(projB.current_scope_revision),
        `角色 ${roleName} (项目B) 未收到项目B的 scope_revision_id (${projB.current_scope_revision})`,
      );
      assert.ok(
        !textB.includes(projA.current_scope_revision),
        `角色 ${roleName} (项目B) 串入了项目A的 scope_revision_id (${projA.current_scope_revision})`,
      );

      // 2) 项目 A 四角色均拿到项目 A 的 task、description 与 allow/deny/pending 范围，且绝不出现项目 B 的目标或范围
      assert.ok(
        textA.includes("核查 order-gw.corp-alpha.test 的签名校验与越权订单读取"),
        `角色 ${roleName} (项目A) 未收到项目A的 task 主目标`,
      );
      assert.ok(
        textA.includes("项目A补充说明：仅允许访问 order-gw"),
        `角色 ${roleName} (项目A) 未收到项目A的 description 补充说明`,
      );
      assert.ok(
        textA.includes("http://order-gw.corp-alpha.test/*"),
        `角色 ${roleName} (项目A) 未收到项目A的 allow 范围`,
      );
      assert.ok(
        textA.includes("http://billing-core.corp-alpha.test/*"),
        `角色 ${roleName} (项目A) 未收到项目A的 deny 范围`,
      );
      assert.ok(
        !textA.includes("file:///workspace/archive-b"),
        `角色 ${roleName} (项目A) 串入了项目B的范围`,
      );
      assert.ok(
        !textA.includes("检查本地归档配置与抓包材料中的明文凭据"),
        `角色 ${roleName} (项目A) 串入了项目B的 task`,
      );

      // 3) 项目 B 四角色均拿到项目 B 的 task、description 与本地文件范围，且绝不出现项目 A 的 task
      assert.ok(
        textB.includes("检查本地归档配置与抓包材料中的明文凭据与脆弱签名算法"),
        `角色 ${roleName} (项目B) 未收到项目B的 task 主目标`,
      );
      assert.ok(
        textB.includes("项目B补充说明：纯本地材料分析任务"),
        `角色 ${roleName} (项目B) 未收到项目B的 description 补充说明`,
      );
      assert.ok(
        textB.includes("file:///workspace/archive-b/*"),
        `角色 ${roleName} (项目B) 未收到项目B的 allow 范围`,
      );
      assert.ok(
        !textB.includes("核查 order-gw.corp-alpha.test 的签名校验与越权订单读取"),
        `角色 ${roleName} (项目B) 串入了项目A的 task`,
      );
    }
  });
});

test("阶段 1.4：仅含本地文件的项目可完成材料检查，未授权网络动作被网关拒绝，范围外发现可建档为 pending", async () => {
  await withTempCtx(async (pctx) => {
    const proj = (
      await createProject(pctx, {
        actor: "user",
        name: "纯本地材料审计项目",
        task: "对本地文件 file:///workspace/local-only/app.conf 做安全配置核查",
        description: "仅授权 file:///workspace/local-only/*，禁止一切外部网络请求",
        scopeRules: {
          allow: ["file:///workspace/local-only/*"],
          deny: ["http://forbidden.corp.example/*"],
          pending: [],
        },
      })
    ).project;

    const workerSess = issueSession({ project_id: proj.id, actor: "worker-local", role: "worker" });
    const plannerSess = issueSession({ project_id: proj.id, actor: "planner-local", role: "planner" });
    const runtimeSess = issueSession({ project_id: proj.id, actor: "runtime-local", role: "runtime" });

    // 1) 在本地材料中发现了一个范围外域名，允许通过 register_asset 建档（scope_status=pending），但不代表允许访问
    const regOut = await submit(pctx, {
      session: workerSess,
      envelope: {
        submission_id: "SUB-LOCAL-DISCOVER-1",
        operations: [
          {
            op: "register_asset",
            local_ref: "localFile",
            asset_type: "file",
            canonicalization_version: "v1",
            canonical_key: "file:///workspace/local-only/app.conf",
          },
          {
            op: "register_asset",
            local_ref: "discoveredRemote",
            asset_type: "domain",
            canonicalization_version: "v1",
            canonical_key: "unlisted-remote.example.com",
          },
        ],
      },
    });
    assert.ok(regOut.ids.localFile);
    assert.ok(regOut.ids.discoveredRemote);

    const store = await getStore(pctx);
    const remoteRow = store.db
      .prepare("SELECT scope_status FROM assets WHERE project_id = ? AND id = ?")
      .get(proj.id, regOut.ids.discoveredRemote);
    assert.equal(remoteRow.scope_status, "pending", "范围外发现的资产建档后应为 pending 状态");

    // 2) 规划针对本地文件的材料检查意图并成功派发
    const planOut = await receivePlanRevision(pctx, {
      session: plannerSess,
      envelope: {
        submission_id: "PLAN-LOCAL-1",
        plan_revision: "r1",
        intents: [
          {
            op: "create",
            local_ref: "iLocal",
            question: "核查 file:///workspace/local-only/app.conf 中的调试开关与密钥配置",
            kind: "investigate",
            rationale: "本地材料检查",
            target_asset_ids: [regOut.ids.localFile],
            success_criteria: "输出配置核查观察记录",
            deliverables: ["配置核查观察"],
          },
        ],
      },
    });
    const localIntentId = planOut.ids.iLocal;
    await transitionIntent(pctx, { projectId: proj.id, actor: "runtime", intentId: localIntentId, action: "activate", via: "test" });
    const disp = await dispatchAttempt(pctx, {
      session: runtimeSess,
      intentId: localIntentId,
      workerId: "worker-local",
      assignmentId: "ASG-LOCAL-1",
    });
    assert.equal(disp.attempt.status, "leased");

    // 3) 若尝试向 deny 范围目标发起工具调用 → 网关拒绝 SCOPE_DENIED
    await assert.rejects(
      () =>
        toolGateway(pctx, {
          session: workerSess,
          action: "register",
          attemptId: disp.attempt.id,
          fencingToken: disp.fencing_token,
          toolName: "http_probe",
          targets: ["http://forbidden.corp.example/api"],
        }),
      (err) => err.code === "SCOPE_DENIED",
    );

    // 4) 若尝试向未列出的外部网络目标发起工具调用 → 网关拒绝 SCOPE_UNRESOLVED
    await assert.rejects(
      () =>
        toolGateway(pctx, {
          session: workerSess,
          action: "register",
          attemptId: disp.attempt.id,
          fencingToken: disp.fencing_token,
          toolName: "http_probe",
          targets: ["http://unlisted-remote.example.com/"],
        }),
      (err) => err.code === "SCOPE_UNRESOLVED",
    );
  });
});

test("阶段 1.5：Orchestrator 意图调整必须走持久化修订（revise_intent）或重新规划，禁止 assign_execution 静默改写意图", async () => {
  await withTempCtx(async (pctx) => {
    const proj = (
      await createProject(pctx, {
        actor: "user",
        name: "协调边界验证项目",
        task: "验证 api.boundary.test 的权限边界",
        description: "协调者修订边界回归测试",
        scopeRules: { allow: ["http://api.boundary.test/*"], deny: [], pending: [] },
      })
    ).project;

    const plannerSess = issueSession({ project_id: proj.id, actor: "planner-1", role: "planner" });
    const orchSess = issueSession({ project_id: proj.id, actor: "orch-1", role: "orchestrator" });

    const planOut = await receivePlanRevision(pctx, {
      session: plannerSess,
      envelope: {
        submission_id: "PLAN-BOUNDARY-1",
        plan_revision: "r1",
        intents: [
          {
            op: "create",
            local_ref: "i1",
            question: "http://api.boundary.test/v1/profile 是否允许匿名访问？",
            kind: "investigate",
            rationale: "首轮入口核查",
            success_criteria: "得到匿名请求响应状态码与鉴权头要求",
            deliverables: ["响应观察记录"],
          },
        ],
      },
    });
    const intentId = planOut.ids.i1;
    await transitionIntent(pctx, { projectId: proj.id, actor: "runtime", intentId, action: "activate", via: "test" });

    // 1) assign_execution 携带 question / success_criteria / target_asset_ids 等意图改写字段时必须被拒绝
    await assert.rejects(
      () =>
        recordDecision(pctx, {
          session: orchSess,
          inputReportIds: [],
          inputEventRefs: [],
          rationale: "试图在派发时顺手改写意图问题",
          actions: [
            {
              action_kind: "assign_execution",
              idempotency_key: "ACT-SILENT-REWRITE",
              payload: {
                intent_id: intentId,
                worker_id: "worker-1",
                question: "被静默篡改的新问题",
              },
            },
          ],
        }),
      (err) => err.code === "PRECONDITION_INVALID" && /revise_intent|request_planning/.test(err.message),
    );

    // 2) 使用 revise_intent 持久化修订意图，再使用 assign_execution 派发
    const dec = await recordDecision(pctx, {
      session: orchSess,
      inputReportIds: [],
      inputEventRefs: [],
      rationale: "收到新线索，持久化修订意图的检查问题与完成条件后再派发",
      actions: [
        {
          action_kind: "revise_intent",
          idempotency_key: "ACT-REVISE-1",
          payload: {
            intent_id: intentId,
            expected_state_version: 2, // create(1) -> activate(2)
            question: "http://api.boundary.test/v1/profile 与 /v1/profile/export 是否允许匿名或低权限访问？",
            success_criteria: "分别给出两个端点的响应证据与鉴权差异结论",
          },
        },
        {
          action_kind: "assign_execution",
          idempotency_key: "ACT-ASSIGN-1",
          payload: {
            intent_id: intentId,
            worker_id: "worker-1",
            handoff_summary: "按修订后的意图执行检查",
          },
        },
      ],
    });

    const executed = await executeDecisionActions(pctx, { projectId: proj.id, decisionId: dec.id });
    assert.equal(executed.actions.length, 2);
    assert.equal(executed.actions[0].status, "executed", JSON.stringify(executed.actions[0]));
    assert.equal(executed.actions[0].result.intent_id, intentId);
    assert.equal(executed.actions[0].result.received_status, "accepted");
    assert.equal(executed.actions[1].status, "executed", JSON.stringify(executed.actions[1]));
    assert.ok(executed.actions[1].result.attempt_id);

    // 核查库中意图已持久化更新且版本推进
    const listed = await listIntents(pctx, { projectId: proj.id });
    const updatedIntent = listed.intents.find((i) => i.id === intentId);
    assert.ok(updatedIntent);
    assert.equal(
      updatedIntent.question,
      "http://api.boundary.test/v1/profile 与 /v1/profile/export 是否允许匿名或低权限访问？",
    );
    assert.equal(
      updatedIntent.success_criteria,
      "分别给出两个端点的响应证据与鉴权差异结论",
    );
    assert.ok(updatedIntent.state_version >= 3, "意图修订与派发后 state_version 应递增");

    // 核查 orchestratorOverview 同样暴露更新后的意图与统一 project_context
    const ov = await orchestratorOverview(pctx, { session: orchSess, projectId: proj.id });
    assert.equal(ov.project_context.goal, "验证 api.boundary.test 的权限边界");
    assert.equal(ov.project_context.goal_source, "task");
    assert.deepEqual(ov.project_context.scope.rules.allow, ["http://api.boundary.test/*"]);
  });
});
