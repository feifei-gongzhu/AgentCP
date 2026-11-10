/**
 * 代理运行时驱动（规范 §16.1/§16.4/§1；蓝图 §2.6-8 热加载）。
 *
 * 职责：在插件进程内把四个 AI 角色（Planner/Orchestrator/Worker/Verifier）
 * 的循环接到真实工作队列上——唤醒、单飞、资源边界与等待语义：
 *   - 唤醒条件（§16.1/§2.6-2）：有新事件（Outbox 高水位推进）、存在待处理汇报/
 *     可派发意图/待验证任务、已租约待执行的 Attempt、或存在待处理用户消息时唤醒
 *     对应角色；等待中的项目（waiting_for_change）收到用户消息视为条件变化唤醒
 *     （要求 §8/J4；程序据此 resume，事件与 lifecycle 同法落库）；无新信息不空转。
 *   - 单飞：同项目同角色一次只跑一个循环；同项目最多一个规划在途由
 *     plan_runs 状态与 E1 供给面共同保证（§16.1）。
 *   - 无模型提供方 → 显式等待（started:false + 原因），绝不以固定剧本替代
 *     AI（§3.1）；存储与工具端点不受影响。
 *   - 热加载（§2.6-8 冻结契约）：reload() 重新解析提供方（store > env，按角色
 *     per_role 覆盖）——未配置→有配置：启动 tick；有配置→无配置：停 tick、
 *     started=false、原因更新（不丢 lastHigh 水位，恢复后不重放已处理事件，
 *     §16.4）；reload 单飞不重入，与 runOnce 并发安全。调用点：PUT/POST LLM
 *     设置成功后、explore-start 入口（经 pctx.agents.reload?.()）。
 *   - 循环失败不崩溃驱动：记录错误并等下一轮（错误本身也是事件源）。
 */
import { getStore } from "../store/record-service.mjs";
import { sweepExecutionState, reconcileProjectOrphans } from "../store/attempts.mjs";
import { bootstrapOutbox, consumeOutbox } from "../store/outbox-consumer.mjs";
import { allocateEventSeq, countPendingUserMessages } from "../store/messages.mjs";
import { transitionIntent } from "../store/intents.mjs";
import { missingProviderNotice, resolveModelProvider } from "./model.mjs";
import { recordProviderSuccess, recordProviderFailure, providerInBackoff, resetProviderForRetry } from "../store/provider-health.mjs";
import { runOrchestrator } from "./orchestrator.mjs";
import { runPlanner } from "./planner.mjs";
import { runVerifier } from "./verifier.mjs";
import { runWorker } from "./worker.mjs";

const DEFAULT_TICK_MS = 5000;

/** 项目工作面快照（只读；判定是否有可唤醒的工作）。 */
async function projectWorkload(pctx, projectId) {
  const store = await getStore(pctx);
  return store.runSerial((db) => {
    const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId);
    if (!project) return null;
    const high = db
      .prepare("SELECT MAX(commit_seq) AS c FROM outbox WHERE project_id = ?")
      .get(projectId).c || 0;
    return {
      status: project.status,
      state_version: project.state_version,
      high_watermark: high,
      // 可派发意图 = proposed/queued 且无活跃（leased/running）Attempt。状态过滤已排除
      // 等复核/已结案的意图；改用「无活跃 attempt」而非「从未有 attempt」，否则对账后
      // 退回 queued 的意图（带历史 cancelled attempt）会被永久漏掉（执行态对账）。
      runnable_intents: db
        .prepare(
          `SELECT COUNT(*) AS c FROM intents i
           WHERE i.project_id = ? AND i.status IN ('proposed','queued')
             AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.intent_id = i.id AND a.project_id = i.project_id AND a.status IN ('leased','running'))`,
        )
        .get(projectId).c,
      live_attempts: db
        .prepare("SELECT COUNT(*) AS c FROM attempts WHERE project_id = ? AND status IN ('leased','running')")
        .get(projectId).c,
      // 孤儿执行：intent 仍 running 但没有任何 leased/running Attempt。典型来源：
      // Attempt 租约到期被 sweep 置 interrupted 后，意图没人接手；若不给唤醒信号，
      // 项目会永久停在「running 但无执行」的假活跃状态（本轮实测 9 条 / 20 分钟）。
      orphaned_running_intents: db
        .prepare(
          `SELECT COUNT(*) AS c FROM intents i
           WHERE i.project_id = ? AND i.status = 'running'
             AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.intent_id = i.id AND a.project_id = i.project_id AND a.status IN ('leased','running'))`,
        )
        .get(projectId).c,
      pending_reports: db
        .prepare("SELECT COUNT(*) AS c FROM worker_reports WHERE project_id = ? AND handling_status = 'pending'")
        .get(projectId).c,
      pending_jobs: db
        .prepare("SELECT COUNT(*) AS c FROM verification_jobs WHERE project_id = ? AND status IN ('pending','in_progress')")
        .get(projectId).c,
      // M2（§2.6-2）：待处理用户消息（received/processing）单独构成唤醒条件
      pending_user_messages: countPendingUserMessages(db, projectId),
      plan_in_flight: db
        .prepare("SELECT COUNT(*) AS c FROM plan_runs WHERE project_id = ? AND status IN ('pending','in_flight')")
        .get(projectId).c,
    };
  });
}

function hasWork(load, lastHigh, coordinatorPending, executionReconciled) {
  if (!load) return false;
  if (load.status !== "active" && load.status !== "waiting_for_change") return false; // 暂停/停止不派发（§16.4）
  const pendingWork =
    load.high_watermark > lastHigh
    || load.runnable_intents > 0
    || load.live_attempts > 0
    || load.orphaned_running_intents > 0
    || load.plan_in_flight > 0
    || load.pending_reports > 0
    || load.pending_jobs > 0
    // active 项目同样必须被「待处理用户消息」唤醒：否则项目空转（无尝试/无汇报）时
    // 用户消息永远停在 received（J4 闭环失败）。消息读取本身仍只由 Orchestrator 做。
    || load.pending_user_messages > 0
    || coordinatorPending;
  if (load.status === "active") return pendingWork;
  // 本轮对账恢复了可派工作时才唤醒，避免等待操作自身产生的事件导致反复唤醒。
  return load.pending_user_messages > 0 || (executionReconciled && load.runnable_intents > 0);
}

/**
 * 队列准入（P0 意图闭环的程序半边）：把「已提出但从未派发」的意图置 queued
 * （proposed→queued = activate，§10.1 合法链路）。
 *
 * 为什么要程序做：Planner 新建意图是 proposed（这是领域语义，测试钉死，不能改成创建即
 * queued）；而 E1 的 wake_signals.dispatchable_intents 只统计 queued，导致 Orchestrator
 * 看到「0 个可派发意图」，真实运行停摆。程序只做**队列准入记账**，不选方向、不派发：
 * 派发仍由 Orchestrator AI 判断（assign_execution），执行由 C2 条件领取。
 * 已有 Attempt 的意图不在此列（它们在等执行结果/复核）。失败逐条忽略并记录。
 */
async function admitProposedIntents(pctx, projectId) {
  const store = await getStore(pctx);
  const rows = store.db
    .prepare(
      `SELECT i.id FROM intents i
       WHERE i.project_id = ? AND i.status = 'proposed'
         AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.intent_id = i.id AND a.project_id = i.project_id)
       ORDER BY i.priority DESC, i.created_seq LIMIT 8`,
    )
    .all(projectId);
  const activated = [];
  for (const row of rows) {
    try {
      const out = await transitionIntent(pctx, {
        projectId,
        actor: "runtime",
        intentId: row.id,
        action: "activate",
        via: "queue_admission",
      });
      activated.push({ intent_id: row.id, status: out.intent ? out.intent.status : "queued" });
    } catch {
      /* 并发/状态已变化：下一轮再试，不阻断本轮回合 */
    }
  }
  return activated;
}

/**
 * startAgentRuntime(pctx, {hostCtx, tickMs})
 * 返回 { started, reason?, describe(), reload(), stop(), runOnce(projectId), projects() }。
 * runOnce 供测试与受控宿主显式驱动一轮（不依赖定时器）。
 */
export function startAgentRuntime(pctx, { hostCtx, tickMs, logger } = {}) {
  const log = logger || pctx.logger || { info: () => {}, warn: () => {}, error: () => {} };
  const state = {
    stopped: false,
    timer: null,
    busy: new Set(), // `${projectId}:${role}`
    lastHigh: new Map(), // projectId → 已处理事件高水位（无变化不空转，§16.4）
    waitingLogged: new Set(),
    provider: resolveModelProvider(pctx, { logger: log }),
    reloadInFlight: null, // reload 单飞（§2.6-8 不重入）
    // 成本护栏（R19）：同一 Attempt/Job 在本进程内只驱动一次完整 LLM 循环。
    // 之前每个 tick 都对「仍 leased」的 attempt 重新起一轮 maxSteps=14 的循环，
    // lease 10 分钟内可跑上百轮（实测 7 分钟 8.9M tokens、余额 5.93→5.41 CNY）。
    drivenAttempts: new Map(), // attemptId → { at, fencing }
    drivenJobs: new Set(), // verification jobId
    lastPlannerSignal: new Map(),
    lastCoordinatorSignal: new Map(), // projectId → 上次 Orchestrator 运行时的信号指纹
    pendingCoordinator: new Set(), // 退避或失败时保留只由新事件触发的工作
    lastOrchestratorAt: new Map(), // projectId → 上次 Orchestrator 运行时间（仅事件唤醒时的 5 分钟冷却）
    outboxConsumed: new Map(), // projectId → 已消费事件高水位（§14 消费闭环）
  };

  const describe = () => (state.provider ? `agents:${state.provider.describe()}` : "agents:not-configured");

  function startTimer() {
    if (state.timer || state.stopped) return;
    const interval = Number.isInteger(tickMs) && tickMs > 0 ? tickMs
      : Number(process.env.SORNE_AGENT_TICK_MS) > 0 ? Number(process.env.SORNE_AGENT_TICK_MS)
      : DEFAULT_TICK_MS;
    state.timer = setInterval(() => {
      tick().catch((error) => log.error?.(`[sorne-agents] tick 失败：${String(error?.message ?? error)}`));
    }, interval);
    state.timer.unref?.();
  }

  function stopTimer() {
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = null;
    }
  }

  /**
   * 热加载（§2.6-8）：重新解析提供方并按结果启停 tick。
   * 未配置→有配置：启动运行时；有配置→无配置：停止 tick、保留 lastHigh 水位
   * （恢复后不重放已处理事件）；单飞不重入（并发 reload 共享同一次解析）。
   */
  function reload({ configChanged = false } = {}) {
    if (state.reloadInFlight) return state.reloadInFlight;
    state.reloadInFlight = (async () => {
      const prev = Boolean(state.provider);
      const next = resolveModelProvider(pctx, { logger: log });
      state.provider = next;
      // 显式配置刷新必须解除同 key 的 auth/config 永久阻断；真实调用成功前保持
      // “连通性未验证”，不把配置动作冒充为服务恢复。
      if (next && configChanged) {
        const retryKeys = new Set();
        if (typeof next.describe === "function") retryKeys.add(next.describe());
        for (const role of ["orchestrator", "planner", "worker", "verifier"]) {
          const roleProvider = resolveModelProvider(pctx, { role, logger: log }) || next;
          if (roleProvider && typeof roleProvider.describe === "function") retryKeys.add(roleProvider.describe());
        }
        await Promise.all([...retryKeys].map((key) => resetProviderForRetry(pctx, key)));
      }
      if (next && !prev) {
        startTimer();
        log.info?.(`[sorne-agents] 模型已配置，运行时热启动（${next.describe()}）`);
      } else if (!next && prev) {
        stopTimer();
        log.info?.("[sorne-agents] 模型配置已清除，运行时转入等待（保留事件高水位，恢复后不重放）");
      }
      return { started: Boolean(next), ...(next ? {} : { reason: missingProviderNotice() }) };
    })().finally(() => {
      state.reloadInFlight = null;
    });
    return state.reloadInFlight;
  }

  async function listProjects() {
    const store = await getStore(pctx);
    return store.runSerial((db) => db.prepare("SELECT id, status FROM projects ORDER BY created_at, rowid").all());
  }

  /** 等待中的项目出现新条件 → 唤醒（程序 resume，事件与 lifecycle 同法）。 */
  async function resumeWaitingProject(projectId, cause = "work_reconciled") {
    const store = await getStore(pctx);
    return store.runSerial((db) => {
      const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId);
      if (!project || project.status !== "waiting_for_change") return null;
      const commitSeq = Number(db.prepare("SELECT next_commit_seq AS n FROM projects WHERE id = ?").get(projectId).n);
      db.prepare("UPDATE projects SET next_commit_seq = ?, status = 'active', state_version = state_version + 1, updated_seq = ? WHERE id = ?").run(
        commitSeq + 1,
        commitSeq,
        projectId,
      );
      const eventSeq = allocateEventSeq(db, projectId);
      db.prepare(
        `INSERT INTO outbox (event_id, project_id, commit_seq, event_index, event_type, subject_ids,
           changed_fields, cause_refs, producer_id, schema_version, payload, delivery_status,
           delivery_attempts, created_at)
         VALUES (?, ?, ?, 1, 'resource_state.changed', ?, ?, ?, 'm2/runtime', 1, ?, 'pending', 0, ?)`,
      ).run(
        `EVT-${projectId}-${String(eventSeq).padStart(6, "0")}`,
        projectId,
        commitSeq,
        JSON.stringify([projectId]),
        JSON.stringify(["status"]),
        JSON.stringify([projectId]),
        JSON.stringify({
          kind: "project_lifecycle",
          from: "waiting_for_change",
          to: "active",
          action: "resume",
          cause,
          note: cause === "user_message"
            ? "等待中的项目收到用户消息，视为条件变化唤醒（要求 §8；delivered ≠ handled）"
            : "等待中的项目出现已对账的可执行工作，视为条件变化并自动恢复",
        }),
        new Date().toISOString(),
      );
      return { from: "waiting_for_change", to: "active" };
    });
  }

  /** 单项目一轮：Orchestrator → （其请求的）Planner → Worker → Verifier。 */
  async function runOnce(projectId) {
    const provider = state.provider;
    if (!provider) {
      return { skipped: true, reason: missingProviderNotice() };
    }
    // 过期租约清扫（C2 既有入口、幂等、不发 LLM 调用）：没有这一步，过期 lease 会
    // 一直计入 live_attempts，让驱动永远「有工作」并把成本烧在重复循环上。
    let executionReconciled = false;
    try {
      const swept = await sweepExecutionState(pctx, projectId);
      executionReconciled = swept.interrupted.length > 0;
    } catch (error) {
      log.warn?.("[sorne-agents] 租约清扫失败：" + String(error?.message ?? error));
    }
    // 孤儿兜底对账（确定性、幂等、不发 LLM 调用）：把 running 但无活跃 attempt 的意图
    // 按 reason_code 退回 queued 或搁置，让 Orchestrator 面对自洽的树（执行态对账）。
    try {
      const rec = await reconcileProjectOrphans(pctx, projectId);
      if (rec.reconciled.length) {
        executionReconciled = true;
        log.info?.("[sorne-agents] 孤儿对账：" + rec.reconciled.map((r) => r.intent_id + "→" + r.action).join("、"));
      }
    } catch (error) {
      log.warn?.("[sorne-agents] 孤儿对账失败：" + String(error?.message ?? error));
    }
    const load = await projectWorkload(pctx, projectId);
    if (!load) return { skipped: true, reason: "项目不存在" };
    const lastHigh = state.lastHigh.get(projectId) ?? -1;
    if (!hasWork(load, lastHigh, state.pendingCoordinator.has(projectId), executionReconciled)) {
      if (!state.waitingLogged.has(projectId)) {
        state.waitingLogged.add(projectId);
        log.info?.(`[sorne-agents] 项目 ${projectId} 无新信息，进入等待（§16.4，不空转）`);
      }
      return { skipped: true, reason: "waiting_for_change" };
    }
    if (load.status === "waiting_for_change") {
      const cause = load.pending_user_messages > 0 ? "user_message" : "work_reconciled";
      const resumed = await resumeWaitingProject(projectId, cause);
      if (resumed) log.info?.(`[sorne-agents] 项目 ${projectId} 因${cause === "user_message" ? "用户消息" : "可执行工作恢复"}唤醒（waiting_for_change → active）`);
    }
    state.waitingLogged.delete(projectId);
    state.lastHigh.set(projectId, load.high_watermark);
    // §14 消费闭环：首次接手把存量事件标记 skipped（快照已覆盖），之后按高水位增量写 applied。
    if (!state.outboxConsumed.has(projectId)) {
      try {
        const boot = await bootstrapOutbox(pctx, { projectId, throughCommitSeq: load.high_watermark });
        log.info?.("[sorne-agents] Outbox 接手（" + projectId + "）：存量 " + boot.bootstrap_skipped + " 条置 skipped");
      } catch (error) {
        log.warn?.("[sorne-agents] Outbox 接手失败：" + String(error?.message ?? error));
      }
      state.outboxConsumed.set(projectId, load.high_watermark);
    }
    const summary = { project_id: projectId, roles: [] };
    // P0 意图闭环：先把「已提出但从未派发」的意图做队列准入（proposed→queued），
    // 让 E1 的 dispatchable_intents 信号如实，派发决定仍由 Orchestrator AI 做出。
    try {
      summary.queue_admission = await admitProposedIntents(pctx, projectId);
      if (summary.queue_admission.length) {
        log.info?.("[sorne-agents] 队列准入：意图置 queued " + summary.queue_admission.map((x) => x.intent_id).join("、"));
      }
    } catch (error) {
      log.warn?.("[sorne-agents] 队列准入失败：" + String(error?.message ?? error));
      summary.queue_admission = [];
    }
    // 角色提供方：per_role 高级覆盖优先，缺省回落默认档（蓝图 §2.6-1）
    const orchModel = resolveModelProvider(pctx, { role: "orchestrator", logger: log }) || provider;

    // 1) Orchestrator：只在「有新信息/新协调需求」时运行；仅有在途 Attempt 不构成
    // 调用理由（Worker 自己会继续，Orchestrator 重复读面板是纯成本）。用信号指纹
    // （高水位 + 各类待处理计数）去重：同一状态不重复调用，新报告/新消息/新事件才再跑。
    const coordinatorSignal = [load.high_watermark, load.pending_reports, load.pending_user_messages, load.pending_jobs, load.runnable_intents].join("|");
    const signalChanged = state.lastCoordinatorSignal.get(projectId) !== coordinatorSignal;
    const hardCoordinatorSignal =
      load.pending_reports > 0
      || load.pending_user_messages > 0
      || load.pending_jobs > 0
      || load.runnable_intents > 0
      || load.orphaned_running_intents > 0
      || load.plan_in_flight > 0;
    const lastOrchAt = state.lastOrchestratorAt.get(projectId) ?? 0;
    // 仅有新事件（如 Worker 刚产生 capture）且无待处理项时，Orchestrator 最多 5 分钟一次；
    // 有汇报/消息/验证/可派意图则立即响应。避免「每条 capture 唤醒一次面板重读」。
    const needsCoordinator = state.pendingCoordinator.has(projectId) || hardCoordinatorSignal
      || (load.high_watermark > lastHigh && Date.now() - lastOrchAt > 5 * 60 * 1000);
    const orchKey = orchModel && typeof orchModel.describe === "function" ? orchModel.describe() : "orchestrator";
    const orchBackoff = await providerInBackoff(pctx, orchKey);
    if (needsCoordinator && signalChanged) state.pendingCoordinator.add(projectId);
    if (needsCoordinator && signalChanged && orchBackoff.in_backoff) {
      log.info?.("[sorne-agents] Orchestrator 跳过：provider 退避中（" + orchKey + (orchBackoff.needs_user ? "，需用户处理" : "，至 " + orchBackoff.until) + "）");
    }
    if (needsCoordinator && signalChanged && !orchBackoff.in_backoff && !state.busy.has(`${projectId}:orchestrator`)) {
      state.lastOrchestratorAt.set(projectId, Date.now());
      state.busy.add(`${projectId}:orchestrator`);
      try {
        const outcome = await runOrchestrator(pctx, { projectId, model: orchModel });
        if (outcome.stop_reason === "provider_error") {
          // 失败不消费指纹：不记 lastCoordinatorSignal，下一轮 signalChanged 仍为真会重试。
          await recordProviderFailure(pctx, orchKey, outcome.error?.kind || "unknown");
          log.error?.("[sorne-agents] Orchestrator provider_error（" + (outcome.error?.kind || "unknown") + "）：" + String(outcome.error?.message ?? outcome.error ?? "unknown"));
        } else {
          // 成功才记指纹：同一状态不重复调用；模型恢复后能自动续上。
          state.lastCoordinatorSignal.set(projectId, coordinatorSignal);
          state.pendingCoordinator.delete(projectId);
          await recordProviderSuccess(pctx, orchKey);
        }
        if (outcome.stop_reason === "final") {
          log.warn?.("[sorne-agents] Orchestrator final（未提交决定？finish_reason=" + (outcome.finish_reason ?? "?") + "）：" + String(outcome.final ?? "").slice(0, 200));
        }
        summary.roles.push({ role: "orchestrator", stop_reason: outcome.stop_reason, steps: outcome.steps });
      } catch (error) {
        log.error?.(`[sorne-agents] Orchestrator 循环失败（${projectId}）：${String(error?.message ?? error)}`);
        summary.roles.push({ role: "orchestrator", error: String(error?.message ?? error) });
      } finally {
        state.busy.delete(`${projectId}:orchestrator`);
      }
    }

    // Planner 必须独立驱动 pending/in_flight plan_run。若把它嵌在 Orchestrator
    // 成功分支内，Planner 的一次 provider_error 会因协调器指纹已消费而永久失联。
    const store = await getStore(pctx);
    const pendingRun = store.db
      .prepare(
        "SELECT id FROM plan_runs WHERE project_id = ? AND status IN ('pending','in_flight') ORDER BY created_seq LIMIT 1",
      )
      .get(projectId);
    const plannerSignal = pendingRun ? `${pendingRun.id}|${coordinatorSignal}` : null;
    if (pendingRun && state.lastPlannerSignal.get(projectId) !== plannerSignal && !state.busy.has(`${projectId}:planner`)) {
      const planModel = resolveModelProvider(pctx, { role: "planner", logger: log }) || provider;
      const planKey = planModel && typeof planModel.describe === "function" ? planModel.describe() : "planner";
      const planBackoff = await providerInBackoff(pctx, planKey);
      if (planBackoff.in_backoff) {
        log.info?.("[sorne-agents] Planner 跳过：provider 退避中（" + planKey + (planBackoff.needs_user ? "，需用户处理" : "，至 " + planBackoff.until) + "）");
      } else if (!state.busy.has(`${projectId}:planner`) && state.lastPlannerSignal.get(projectId) !== plannerSignal) {
        state.busy.add(`${projectId}:planner`);
        try {
          const plan = await runPlanner(pctx, { projectId, model: planModel, planRunId: pendingRun.id });
          if (plan.stop_reason === "provider_error") {
            await recordProviderFailure(pctx, planKey, plan.error?.kind || "unknown");
            log.error?.("[sorne-agents] Planner provider_error（" + (plan.error?.kind || "unknown") + "）：" + String(plan.error?.message ?? plan.error ?? "unknown"));
          } else {
            state.lastPlannerSignal.set(projectId, plannerSignal);
            await recordProviderSuccess(pctx, planKey);
          }
          if (plan.stop_reason === "final") {
            log.warn?.("[sorne-agents] Planner final（未提交计划？finish_reason=" + (plan.finish_reason ?? "?") + "）：" + String(plan.final ?? "").slice(0, 200));
          }
          summary.roles.push({ role: "planner", plan_run_id: pendingRun.id, stop_reason: plan.stop_reason, steps: plan.steps });
        } catch (error) {
          log.error?.(`[sorne-agents] Planner 循环失败（${projectId}）：${String(error?.message ?? error)}`);
          summary.roles.push({ role: "planner", plan_run_id: pendingRun.id, error: String(error?.message ?? error) });
        } finally {
          state.busy.delete(`${projectId}:planner`);
        }
      }
    }

    // 2) Worker：已租约但尚无本驱动在跑的 Attempt（§10.2 执行面）。
    //    fencing token 随 Attempt 一并取出（网关动作须校验持有者，§10.2）。
    const attempts = store.db
      .prepare(
        "SELECT a.id, a.intent_id, a.fencing_token FROM attempts a WHERE a.project_id = ? AND a.status IN ('leased','running') ORDER BY a.created_seq LIMIT 4",
      )
      .all(projectId);
    // 清理已终态 Attempt 的驱动记录；同一 Attempt 只驱动一轮（成本护栏，R19）。
    const activeAttemptIds = new Set(attempts.map((a) => a.id));
    for (const id of state.drivenAttempts.keys()) {
      if (!activeAttemptIds.has(id)) state.drivenAttempts.delete(id);
    }
    const MAX_WORKERS_PER_TICK = 4;
    const workerTasks = [];
    for (const att of attempts) {
      if (workerTasks.length >= MAX_WORKERS_PER_TICK) break;
      const key = `${projectId}:worker:${att.id}`;
      if (state.busy.has(key)) continue;
      if (state.drivenAttempts.has(att.id)) continue;
      const workerModel = resolveModelProvider(pctx, { role: "worker", logger: log }) || provider;
      const workerKey = workerModel && typeof workerModel.describe === "function" ? workerModel.describe() : "worker";
      const workerBackoff = await providerInBackoff(pctx, workerKey);
      if (workerBackoff.in_backoff || state.busy.has(key) || state.drivenAttempts.has(att.id)) continue;
      state.drivenAttempts.set(att.id, { at: Date.now(), fencing: att.fencing_token });
      state.busy.add(key);
      workerTasks.push(
        (async () => {
          try {
            const outcome = await runWorker(pctx, {
              projectId,
              intentId: att.intent_id,
              attemptId: att.id,
              fencingToken: att.fencing_token,
              model: workerModel,
            });
            if (outcome.stop_reason === "provider_error") {
              state.drivenAttempts.delete(att.id);
              await recordProviderFailure(pctx, workerKey, outcome.error?.kind || "unknown");
              log.error?.("[sorne-agents] Worker provider_error（" + (outcome.error?.kind || "unknown") + "）：" + String(outcome.error?.message ?? outcome.error ?? "unknown"));
            } else {
              await recordProviderSuccess(pctx, workerKey);
            }
            summary.roles.push({ role: "worker", attempt_id: att.id, stop_reason: outcome.stop_reason, steps: outcome.steps });
          } catch (error) {
            state.drivenAttempts.delete(att.id);
            log.error?.(`[sorne-agents] Worker 循环失败（${projectId}/${att.id}）：${String(error?.message ?? error)}`);
            summary.roles.push({ role: "worker", attempt_id: att.id, error: String(error?.message ?? error) });
          } finally {
            state.busy.delete(key);
          }
        })(),
      );
    }
    if (workerTasks.length) await Promise.all(workerTasks);

    // 3) Verifier：待验证任务（独立身份；发现者不得自证，§8.3）
    const jobs = store.db
      .prepare(
        "SELECT id FROM verification_jobs WHERE project_id = ? AND status IN ('pending','in_progress') ORDER BY created_seq LIMIT 4",
      )
      .all(projectId);
    const activeJobIds = new Set(jobs.map((j) => j.id));
    for (const id of state.drivenJobs) {
      if (!activeJobIds.has(id)) state.drivenJobs.delete(id);
    }
    for (const job of jobs) {
      const key = `${projectId}:verifier:${job.id}`;
      if (state.busy.has(key)) continue;
      if (state.drivenJobs.has(job.id)) continue; // 同一 job 只驱动一轮（成本护栏，R19）
      const verifierModel = resolveModelProvider(pctx, { role: "verifier", logger: log }) || provider;
      const verifierKey = verifierModel && typeof verifierModel.describe === "function" ? verifierModel.describe() : "verifier";
      const verifierBackoff = await providerInBackoff(pctx, verifierKey);
      if (verifierBackoff.in_backoff || state.busy.has(key) || state.drivenJobs.has(job.id)) continue;
      state.drivenJobs.add(job.id);
      state.busy.add(key);
      try {
        const outcome = await runVerifier(pctx, {
          projectId,
          jobId: job.id,
          model: verifierModel,
        });
        if (outcome.stop_reason === "provider_error") {
          state.drivenJobs.delete(job.id);
          await recordProviderFailure(pctx, verifierKey, outcome.error?.kind || "unknown");
          log.error?.("[sorne-agents] Verifier provider_error（" + (outcome.error?.kind || "unknown") + "）：" + String(outcome.error?.message ?? outcome.error ?? "unknown"));
        } else {
          await recordProviderSuccess(pctx, verifierKey);
        }
        if (outcome.stop_reason === "final") {
          log.warn?.("[sorne-agents] Verifier final（未提交结果？finish_reason=" + (outcome.finish_reason ?? "?") + "）：" + String(outcome.final ?? "").slice(0, 200));
        }
        summary.roles.push({ role: "verifier", job_id: job.id, stop_reason: outcome.stop_reason, steps: outcome.steps });
      } catch (error) {
        state.drivenJobs.delete(job.id);
        log.error?.(`[sorne-agents] Verifier 循环失败（${projectId}/${job.id}）：${String(error?.message ?? error)}`);
        summary.roles.push({ role: "verifier", job_id: job.id, error: String(error?.message ?? error) });
      } finally {
        state.busy.delete(key);
      }
    }

    // §14 消费闭环：把本轮输入边界（load.high）内的增量事件写 applied 回执并置 sent。
    // 本轮自身写入的事件留到下一轮（避免把未处理的输入误标为已应用）。
    const prevConsumed = state.outboxConsumed.get(projectId) ?? load.high_watermark;
    if (load.high_watermark > prevConsumed) {
      try {
        summary.outbox = await consumeOutbox(pctx, {
          projectId,
          fromCommitSeq: prevConsumed,
          throughCommitSeq: load.high_watermark,
        });
        state.outboxConsumed.set(projectId, load.high_watermark);
      } catch (error) {
        log.warn?.("[sorne-agents] Outbox 消费回执失败：" + String(error?.message ?? error));
      }
    }
    // 本轮自身写入的事件不再作为下一轮的唤醒源（只有外部新事件或剩余工作才唤醒；
    // 剩余工作由 workload 的计数面判定，§16.4 不因自产事件空转）。
    const post = await projectWorkload(pctx, projectId);
    if (post) state.lastHigh.set(projectId, post.high_watermark);
    return summary;
  }

  async function tick() {
    if (state.stopped) return;
    let rows = [];
    try {
      rows = await listProjects();
    } catch (error) {
      log.warn?.(`[sorne-agents] 项目枚举失败：${String(error?.message ?? error)}`);
      return;
    }
    for (const row of rows) {
      if (state.stopped) break;
      try {
        await runOnce(row.id);
      } catch (error) {
        log.error?.(`[sorne-agents] ${row.id} 一轮失败：${String(error?.message ?? error)}`);
      }
    }
  }

  if (state.provider) {
    startTimer();
    log.info?.(`[sorne-agents] 代理运行时已启动（${state.provider.describe()}）`);
  } else {
    log.info?.(`[sorne-agents] 代理运行时未启动：${missingProviderNotice()}`);
  }
  void hostCtx;

  return {
    // started/reason 为实时视图（reload 热切换后如实反映，§2.6-8）
    get started() {
      return Boolean(state.provider);
    },
    get reason() {
      return state.provider ? undefined : missingProviderNotice();
    },
    describe,
    providerKey() {
      return state.provider && typeof state.provider.describe === "function" ? state.provider.describe() : null;
    },
    reload,
    projects: listProjects,
    runOnce,
    stop() {
      state.stopped = true;
      stopTimer();
      log.info?.("[sorne-agents] 代理运行时已停止");
    },
  };
}
