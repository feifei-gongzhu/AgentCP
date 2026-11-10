/**
 * F2 —— §20.3 末段端到端贯穿验收（蓝图 §7 末行，F2 主责、全阶段配合）。
 *
 * 受控测试环境内验证「保存 → 派发 → 确认 → 恢复 → 再次规划」全链路：
 *   保存   —— user 建项目与范围 → planner #20 计划 → runtime #22 派发 →
 *             worker #11/#12 固定证据与采集 → #26 工具调用全程 → #10 即时提交
 *             发现（资产/观察/suspected 漏洞/supports 边）；执行未结束发现已可
 *             被其他任务读取（§4/§2 约束 1）；
 *   派发   —— 上述分配-租约-工具网关链路本身（fencing token、范围与前提过闸）；
 *   确认   —— orchestrator #27 发起独立验证（D1 Manifest+任务）→ verifier
 *             #43/#44 读取原始证据 → #28 提交 supported（发现者≠verifier）→
 *             漏洞 confirmed（§12.2 同事务应用）；项目继续运行不因此结束
 *             （§1/§20.3 场景 22 语义）；
 *   恢复   —— 第二意图执行中「进程退出」（真实故障注入：过期租约真实库行 +
 *             关库关服→同目录重启→重签会话）→ #42 drill 执行 §18.2 七步 →
 *             中断 Attempt、unknown 工具调用、Checkpoint、幂等回执恢复；
 *   再次规划 —— orchestrator #36 请求规划 → planner #20 提交第二版计划（新意图
 *             以已确认漏洞为前提，§16.3 确认可立即产生后续方向）→ runtime 派发
 *             成功（前提有效放行）。
 *
 * 全链路经真实 HTTP 端点与真实事务（A1/C1/C2/A2/D1/D2/E1/B1/F2 已交付实装），
 * 不 mock 任何事务、投递或恢复；不依赖真实漏洞数量作为通过条件（§20.3 末段）。
 *
 * 并行安全：独立 mkdtemp + 随机端口；finally 关服关句柄删目录，不留后台进程。
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";

import { apply } from "../index.js";
import { issueSession, revokeSession } from "../lib/store/sessions.mjs";
import { closeStore, getStore } from "../lib/store/record-service.mjs";
import { closeAllStores } from "../lib/store/evidence.mjs";
import { registerVerificationPolicy } from "../lib/store/verification.mjs";
import { makeTempDir } from "./helpers.mjs";

const QUIET = { info: () => {}, warn: () => {}, error: () => {} };

async function call(base, method, path, { body, session, rawBody } = {}) {
  const headers = { origin: base };
  if (body !== undefined || rawBody !== undefined) headers["content-type"] = "application/json";
  if (session) headers["x-sorne-session"] = session.session_token;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: rawBody !== undefined ? rawBody : body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, body: json };
}

/** 重启演练服务器：close() 只关服不删目录（模拟进程退出再拉起）。 */
async function bootServer(dataDir) {
  const prev = process.env.SORNE_DATA_DIR;
  process.env.SORNE_DATA_DIR = dataDir;
  let route;
  try {
    const registered = [];
    apply({
      webServer: { register: (o) => (registered.push(o), () => {}) },
      logger: QUIET,
      effect: (fn) => fn(),
    });
    route = registered[registered.length - 1];
  } finally {
    if (prev === undefined) delete process.env.SORNE_DATA_DIR;
    else process.env.SORNE_DATA_DIR = prev;
  }
  const server = http.createServer((req, res) => route.handler(req, res));
  await new Promise((r, j) => {
    server.once("error", j);
    server.listen(0, "127.0.0.1", r);
  });
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => server.close(r)),
  };
}

const sess = (project_id, actor, role) => issueSession({ project_id, actor, role });

let counter = 0;
const sid = (tag) => `${tag}-E2E-${Date.now().toString(36)}-${(counter += 1)}`;

test("§20.3 末段端到端：保存 → 派发 → 确认 → 恢复 → 再次规划（受控环境全链路）", async () => {
  registerVerificationPolicy({
    id: "policy-e2e-xss",
    version: "v1",
    required_checks: ["reproduce", "evidence_reviewed"],
    description: "端到端贯穿验证策略：复现 + 原始证据审阅",
  });
  const dataDir = makeTempDir("sorne-e2e-life-");
  let srv = await bootServer(dataDir);
  const issued = [];
  try {
    /* ── 保存（一）：项目、范围与第一版计划（user → planner） ────────── */
    const projRes = await call(srv.base, "POST", "/sorne/projects", {
      body: { name: "端到端贯穿项目", scope_rules: { allow: ["*.example.test"], deny: [], pending: [] } },
    });
    assert.equal(projRes.status, 200, JSON.stringify(projRes.body));
    const project = projRes.body.project;
    const planner = sess(project.id, "planner-e2e", "planner");
    const worker = sess(project.id, "w-e2e", "worker");
    const orchestrator = sess(project.id, "orch-e2e", "orchestrator");
    const verifier = sess(project.id, "verify-e2e", "verifier");
    const runtime = sess(project.id, "rt-e2e", "runtime");
    issued.push(planner, worker, orchestrator, verifier, runtime);

    const plan1 = await call(srv.base, "POST", "/sorne/plan-revisions", {
      body: {
        submission_id: sid("PLAN"),
        plan_revision: "r1",
        intents: [
          {
            op: "create",
            local_ref: "i1",
            question: "登录入口是否存在反射型 XSS？",
            kind: "investigate",
            rationale: "页面 JS 引用了未净化的回显参数",
            success_criteria: "给出可核验的回显证据或明确缺口",
            target_asset_ids: [],
          },
        ],
      },
      session: planner,
    });
    assert.equal(plan1.status, 200, JSON.stringify(plan1.body));
    const intent1 = plan1.body.ids.i1;
    assert.ok(intent1, "计划接收分配正式编号");

    /* ── 派发（一）：runtime 条件领取 + 工具网关全程 ─────────────────── */
    const dispatch1 = await call(srv.base, "POST", "/sorne/attempts", {
      body: { intent_id: intent1, worker_id: "w-e2e", assignment_id: "E2E-ASM-1" },
      session: runtime,
    });
    assert.equal(dispatch1.status, 200, JSON.stringify(dispatch1.body));
    const attempt1 = dispatch1.body.attempt.id;
    const fencing1 = dispatch1.body.fencing_token;
    assert.ok(Number.isInteger(fencing1) && fencing1 >= 1, "fencing token 单调分配");

    // 工具调用全程（planned→running→succeeded）与原始证据固定（§13 顺序）
    const evidence = "HTTP/1.1 200 OK\r\nX-Echo: <script>alert(1)</script>";
    const sha = createHash("sha256").update(evidence).digest("hex");
    const toolCallId = `TC-E2E-${counter}`;
    const up = await call(
      srv.base,
      "POST",
      `/sorne/evidence/blobs?project_id=${encodeURIComponent(project.id)}&representation=raw_body&source_kind=tool_gateway`,
      { rawBody: evidence },
      // 注意：rawBody 走原始字节流（#11 rawBody 路由）
    );
    assert.equal(up.status, 200, JSON.stringify(up.body));
    assert.equal(up.body.sha256, sha, "内容寻址哈希可核对");
    const cap = await call(srv.base, "POST", "/sorne/captures", {
      body: {
        project_id: project.id,
        tool_call_id: toolCallId,
        attempt_id: attempt1,
        request_url_exact: "https://login.example.test/api/echo?m=hi",
        method: "GET",
        response_body_blob: up.body.blob_id,
        condition_snapshot_id: "COND-未登录",
        integrity_status: "verified",
      },
    });
    assert.equal(cap.status, 200, JSON.stringify(cap.body));

    const regTool = await call(srv.base, "POST", "/sorne/tool-calls", {
      body: { action: "register", attempt_id: attempt1, tool_name: "http.fetch", fencing_token: fencing1, args: { url: "https://login.example.test/api/echo?m=hi" } },
      session: worker,
    });
    assert.equal(regTool.status, 200, JSON.stringify(regTool.body));
    const tcId = regTool.body.tool_call.id;
    const startTool = await call(srv.base, "POST", "/sorne/tool-calls", {
      body: { action: "start", attempt_id: attempt1, tool_call_id: tcId, fencing_token: fencing1, targets: ["https://login.example.test/api/echo?m=hi"] },
      session: worker,
    });
    assert.equal(startTool.status, 200, JSON.stringify(startTool.body));
    const doneTool = await call(srv.base, "POST", "/sorne/tool-calls", {
      body: { action: "complete", attempt_id: attempt1, tool_call_id: tcId, fencing_token: fencing1, outcome: "succeeded", evidence_refs: [cap.body.capture_id] },
      session: worker,
    });
    assert.equal(doneTool.status, 200, JSON.stringify(doneTool.body));

    /* ── 保存（二）：发现即时持久化（§2 约束 1：不等执行结束） ───────── */
    const finding = await call(srv.base, "POST", "/sorne/submissions", {
      body: {
        submission_id: sid("FIND"),
        attempt_id: attempt1,
        operations: [
          { op: "register_asset", local_ref: "a", asset_type: "host", canonicalization_version: "v1", canonical_key: "login.example.test" },
          { op: "append_observation", local_ref: "o", capture_id: cap.body.capture_id, statement: "回显参数原样返回未净化", conditions: ["未登录身份"] },
          { op: "report_vulnerability", local_ref: "v", asset_id: "a", category: "xss", location: "/api/echo?m=", conditions: ["未登录身份"] },
          { op: "add_relation", from: "o", type: "supports", to: "v" },
        ],
      },
      session: worker,
    });
    assert.equal(finding.status, 200, JSON.stringify(finding.body));
    const vulnId = finding.body.ids.v;
    // 执行尚未结束，发现已可被其他任务读取（§4：不得以执行未结束扣留已提交发现）
    const record = await call(srv.base, "GET", `/sorne/records/${vulnId}?project_id=${project.id}`);
    assert.equal(record.status, 200, JSON.stringify(record.body));
    const ledger = await call(srv.base, "GET", `/sorne/vulnerabilities?project_id=${project.id}`);
    assert.equal(ledger.status, 200);
    const vRow = (ledger.body.vulnerabilities || []).find((v) => v.id === vulnId);
    assert.ok(vRow, "漏洞台账可见新发现");
    assert.equal(vRow.status, "suspected", "疑似阶段即可被引用，不得自动升级（§8.2）");

    /* ── 确认：独立验证（发现者≠verifier）→ §12.2 同事务应用 ────────── */
    const jobRes = await call(srv.base, "POST", "/sorne/verification-requests", {
      body: {
        subject_id: vulnId,
        policy_id: "policy-e2e-xss",
        policy_version: "v1",
        conditions: ["未登录身份下的反射位置"],
        raw_evidence_refs: [cap.body.capture_id],
      },
      session: orchestrator,
    });
    assert.equal(jobRes.status, 200, JSON.stringify(jobRes.body));
    const job = jobRes.body.job;
    assert.ok(job.evidence_manifest_id, "任务绑定不可变 Manifest（§12.1）");

    // verifier 读取原始证据（§8.3：验证可以读取原始证据）
    const blobBytes = await call(srv.base, "GET", `/sorne/evidence/blobs/${sha}?project_id=${project.id}`);
    assert.equal(blobBytes.status, 200);
    assert.ok(String(blobBytes.body.raw ?? "").includes("X-Echo"), "原始字节可读且内容可核对");
    const capDetail = await call(srv.base, "GET", `/sorne/captures/${cap.body.capture_id}?project_id=${project.id}`);
    assert.equal(capDetail.status, 200);

    const verdict = await call(srv.base, "POST", "/sorne/verification-results", {
      body: {
        job_id: job.id,
        claim_revision: job.claim_revision,
        verifier_identity: "verifier-e2e",
        verifier_kind: "llm_agent",
        policy_version: job.policy_version,
        reviewed_manifest_id: job.evidence_manifest_id,
        reviewed_evidence_revision: job.expected.evidence_revision,
        expected_state_version: job.expected.state_version,
        expected_assessment_epoch: job.expected.assessment_epoch,
        outcome: "supported",
        checks: [
          { name: "reproduce", passed: true, note: "同一条件下复现回显" },
          { name: "evidence_reviewed", passed: true, note: "审阅了 Manifest 全部成员与原始响应" },
        ],
        supporting_refs: [cap.body.capture_id],
        opposing_refs: [],
        limitations: "仅覆盖未登录身份条件",
        suggested_followups: ["检查登录后身份下是否仍可回显"],
      },
      session: verifier,
    });
    assert.equal(verdict.status, 200, JSON.stringify(verdict.body));
    assert.equal(verdict.body.subject.status, "confirmed", "独立验证 supported + 版本匹配 → confirmed（§8.4）");
    // 确认版本（对象形态：绑定验证结果与版本四元组，限指定条件）经台账核对
    const ledgerAfter = await call(srv.base, "GET", `/sorne/vulnerabilities?project_id=${project.id}`);
    const confirmedRow = (ledgerAfter.body.vulnerabilities || []).find((v) => v.id === vulnId);
    assert.equal(confirmedRow.status, "confirmed");
    const cv = confirmedRow.confirmed_version;
    assert.ok(cv && typeof cv === "object" && cv.verification_result_id, "记录确认版本（限指定条件）");
    assert.equal(confirmedRow.review, "clear");

    // 项目继续运行：确认不结束项目（§1/§20.3 场景 22 语义）
    const projAfter = await call(srv.base, "GET", `/sorne/projects/${project.id}`);
    assert.equal(projAfter.status, 200);
    assert.equal(projAfter.body.project.status, "active", "漏洞确认后项目继续（planner 可安排后续方向）");

    /* ── 恢复：第二意图执行中「进程退出」→ 重启 → §18.2 七步 ────────── */
    const plan2 = await call(srv.base, "POST", "/sorne/plan-revisions", {
      body: {
        submission_id: sid("PLAN"),
        plan_revision: "r2",
        intents: [
          {
            op: "create",
            local_ref: "i2",
            question: "会话管理是否存在同类反射面？",
            kind: "investigate",
            rationale: "沿已确认 XSS 的入口向会话相关接口扩展",
            success_criteria: "枚举会话接口回显面或明确缺口",
          },
        ],
      },
      session: planner,
    });
    assert.equal(plan2.status, 200, JSON.stringify(plan2.body));
    const intent2 = plan2.body.ids.i2;
    const dispatch2 = await call(srv.base, "POST", "/sorne/attempts", {
      body: { intent_id: intent2, worker_id: "w-e2e", assignment_id: "E2E-ASM-2" },
      session: runtime,
    });
    assert.equal(dispatch2.status, 200, JSON.stringify(dispatch2.body));
    const attempt2 = dispatch2.body.attempt.id;
    const reg2 = await call(srv.base, "POST", "/sorne/tool-calls", {
      body: { action: "register", attempt_id: attempt2, tool_name: "http.fetch", fencing_token: dispatch2.body.fencing_token, args: { url: "https://login.example.test/api/session" } },
      session: worker,
    });
    assert.equal(reg2.status, 200, JSON.stringify(reg2.body));
    const start2 = await call(srv.base, "POST", "/sorne/tool-calls", {
      body: { action: "start", attempt_id: attempt2, tool_call_id: reg2.body.tool_call.id, fencing_token: dispatch2.body.fencing_token, targets: ["https://login.example.test/api/session"] },
      session: worker,
    });
    assert.equal(start2.status, 200, JSON.stringify(start2.body));

    // 故障注入：租约到期写为过去（真实库行）→ 进程退出（关库关服）
    {
      const store = await getStore({ dataDir });
      await store.runSerial((db) => {
        db.prepare("UPDATE attempts SET lease_expires_at = ? WHERE id = ?").run(
          new Date(Date.now() - 60_000).toISOString(),
          attempt2,
        );
      });
      await closeStore({ dataDir });
    }
    for (const s of issued) revokeSession(s.session_token);
    await srv.close();
    closeAllStores();

    // 同目录重启（持久对象独立于会话：目标/意图/知识/证据均在库中，§1）
    srv = await bootServer(dataDir);
    const runtime2 = sess(project.id, "rt-e2e", "runtime");
    const worker2 = sess(project.id, "w-e2e", "worker");
    issued.push(runtime2, worker2);

    const drill = await call(srv.base, "POST", "/sorne/recovery/drill", { body: {}, session: runtime2 });
    assert.equal(drill.status, 200, JSON.stringify(drill.body));
    const steps = Object.fromEntries(drill.body.drill.steps.map((s) => [s.key, s]));
    const leaseStep = steps.expired_leases.detail.per_project.find((p) => p.project_id === project.id);
    assert.ok(
      leaseStep.interrupted_attempts.some((a) => a.attempt_id === attempt2),
      "重启后过期租约被标记中断（§18.2 步骤 3）",
    );
    const toolStep = steps.unfinished_tool_calls;
    assert.ok(
      toolStep.detail.remaining.some((t) => t.tool_call_id === reg2.body.tool_call.id && t.status === "unknown"),
      "在途工具调用结果未知被标记 unknown（步骤 4：先检查现状再决定重试）",
    );
    const cpStep = steps.checkpoint_and_changes.detail.projects.find((p) => p.project_id === project.id);
    assert.ok(cpStep.checkpoint && cpStep.checkpoint.checkpoint_id, "演练读取/生成 Checkpoint（步骤 6）");
    assert.equal(cpStep.checkpoint_generated_now, true, "重启后项目尚无快照，演练按 §18.2 步骤 6 生成");
    
    assert.ok(cpStep.checkpoint.refs.includes(vulnId), "Checkpoint 关键结论带编号引用（已确认漏洞）");

    // 幂等回执恢复（场景 24 语义在端到端链路中的配合面）
    const receiptRetry = await call(srv.base, "POST", "/sorne/submissions", {
      body: {
        submission_id: finding.body.submission_id,
        attempt_id: attempt1,
        operations: [
          { op: "register_asset", local_ref: "a", asset_type: "host", canonicalization_version: "v1", canonical_key: "login.example.test" },
          { op: "append_observation", local_ref: "o", capture_id: cap.body.capture_id, statement: "回显参数原样返回未净化", conditions: ["未登录身份"] },
          { op: "report_vulnerability", local_ref: "v", asset_id: "a", category: "xss", location: "/api/echo?m=", conditions: ["未登录身份"] },
          { op: "add_relation", from: "o", type: "supports", to: "v" },
        ],
      },
      session: worker2,
    });
    assert.equal(receiptRetry.status, 200, JSON.stringify(receiptRetry.body));
    assert.equal(receiptRetry.body.commit_seq, finding.body.commit_seq, "同 submission_id 恢复原回执");
    assert.equal(receiptRetry.body.ids.v, vulnId, "映射稳定不重复创建");

    // 中断后重派由 AI 决定、程序执行：runtime 以新分配句柄重派第二意图（fencing 递增）
    const dispatch3 = await call(srv.base, "POST", "/sorne/attempts", {
      body: { intent_id: intent2, worker_id: "w-e2e", assignment_id: "E2E-ASM-2-RETRY" },
      session: runtime2,
    });
    assert.equal(dispatch3.status, 200, JSON.stringify(dispatch3.body));
    assert.ok(dispatch3.body.fencing_token > dispatch2.body.fencing_token, "新 Attempt 携更高 fencing token，旧执行历史保留（§18.2 步骤 7）");

    /* ── 再次规划：确认漏洞立即产生后续方向（§16.3） ───────────────── */
    const planReq = await call(srv.base, "POST", "/sorne/plan-requests", {
      body: { question: "已确认 XSS 之后的深入与扩展方向？", record_refs: [vulnId], urgency: "normal" },
      session: sess(project.id, "orch-e2e-2", "orchestrator"),
    });
    assert.equal(planReq.status, 200, JSON.stringify(planReq.body));

    const plan3 = await call(srv.base, "POST", "/sorne/plan-revisions", {
      body: {
        submission_id: sid("PLAN"),
        plan_revision: "r3",
        intents: [
          {
            op: "create",
            local_ref: "i3",
            question: "已确认 XSS 是否影响管理端入口？",
            kind: "verify",
            rationale: "以已确认漏洞为前提的后续方向（§16.3）",
            success_criteria: "管理端入口受影响性结论或排除依据",
            prerequisite_refs: [vulnId],
          },
        ],
      },
      session: sess(project.id, "planner-e2e-2", "planner"),
    });
    assert.equal(plan3.status, 200, JSON.stringify(plan3.body));
    const intent3 = plan3.body.ids.i3;

    // 前提有效（confirmed & review=clear）→ 派发放行；项目保持运行（再次规划不结束探索）
    const dispatch4 = await call(srv.base, "POST", "/sorne/attempts", {
      body: { intent_id: intent3, worker_id: "w-e2e", assignment_id: "E2E-ASM-3" },
      session: runtime2,
    });
    assert.equal(dispatch4.status, 200, JSON.stringify(dispatch4.body));
    const projFinal = await call(srv.base, "GET", `/sorne/projects/${project.id}`);
    assert.equal(projFinal.body.project.status, "active", "探索持续：全链路走通后项目仍在运行（§1 不得自动结束）");

    // 运行观测面在全链路后可用（§20.2）
    const metrics = await call(srv.base, "GET", `/sorne/metrics?project_id=${project.id}`);
    assert.equal(metrics.status, 200);
    assert.equal(metrics.body.unconsumed_findings.vulnerabilities + metrics.body.unconsumed_findings.observations >= 1, true);
  } finally {
    await srv.close();
    await closeStore({ dataDir });
    closeAllStores();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
