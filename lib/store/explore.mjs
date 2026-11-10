/**
 * M2 —— 开始探索（蓝图 §2.6-3 端点 #48；要求 §3「开始探索之后展示真实进展」）。
 *
 * 语义（冻结）：
 *   1. 入口先调 pctx.agents.reload?.()（§2.6-8 热加载）——支持「先保存项目 →
 *      后连接模型 → 开始探索」与「先配置模型 → 再开始」两种顺序，进程内无死路；
 *      reload 后仍无可用提供方（store+env 均无）→ 409 LLM_NOT_CONFIGURED +
 *      next_requirements（呈现「尚未连接模型，项目可以保存，AI 暂不能开始」，
 *      不以「服务正常」暗示 AI 可工作）；
 *   2. stopped / paused 项目 → PRECONDITION_INVALID（先 resume，沿用生命周期约束；
 *      用户显式停止/暂停的项目不得被开始动作越过）；
 *   3. waiting_for_change → 程序置回 active（用户显式开始探索即条件满足）；
 *   4. 已 active/waiting 且存在 pending/in_flight plan_run → 幂等返回既有
 *      （不重复建，§16.1 单规划在途）；否则经 E1 createPlanRequest 建立规划
 *      请求与 plan_run（in_flight）——目标即项目 description（向导第 ② 步写入），
 *      不新建表；目标为空时以默认问题发起（明确标注）。
 *
 * 本模块不替代 AI 决策：探索方向由 Planner 决定（§3.1），这里只建立规划入口。
 */
import { apiError } from "../errors.mjs";
import { getStore, resolveProjectGoal } from "./record-service.mjs";
import { createPlanRequest } from "./orchestrator.mjs";
import { allocateEventSeq } from "./messages.mjs";

const DEFAULT_QUESTION = "项目尚未配置具体探索目标（goal_missing=true）：基于当前授权范围与既有资产开展首轮盘点规划";

/** 开始探索（#48）。返回 { project, plan_request_id, plan_run_id, deduped, reload }。 */
export async function startExploration(pctx, { projectId, actor = "user", role = "user" }) {
  const store = await getStore(pctx);
  const project = store.db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId);
  if (!project) {
    throw apiError("NOT_FOUND", `项目不存在：${projectId}`);
  }
  // §2.6-8：入口热加载（句柄缺 reload 时安全跳过；跳过事实在响应 reload 字段如实标注）
  let reload = null;
  if (pctx.agents && typeof pctx.agents.reload === "function") {
    reload = await pctx.agents.reload();
  } else {
    reload = { reloaded: false, started: false, reason: "运行时句柄不支持热加载（旧存根），重启进程后生效" };
  }
  const providerReady = Boolean(reload && reload.started);

  if (!providerReady) {
    throw apiError(
      "LLM_NOT_CONFIGURED",
      "尚未连接模型，项目可以保存，AI 暂不能开始",
      {
        status: 409,
        retryable: true,
        next_requirements: [
          "配置模型：POST /sorne/settings/llm { base_url, model, api_key } 或前往引导页连接模型",
          "配置成功后再次调用本端点（运行时已热加载，无需重启进程）",
        ],
      },
    );
  }

  if (project.status === "stopped" || project.status === "paused") {
    throw apiError(
      "PRECONDITION_INVALID",
      `项目当前状态为 ${project.status}，开始探索需先恢复（POST /sorne/projects/${projectId}/lifecycle {action:"resume"}）`,
      {
        detail: { project_status: project.status },
        next_requirements: ["先经生命周期 resume 恢复项目，再开始探索"],
      },
    );
  }

  // 幂等：已有在途规划 → 返回既有（不重复建，§16.1）
  const inFlight = store.db
    .prepare(
      "SELECT id, status, created_at FROM plan_runs WHERE project_id = ? AND status IN ('pending','in_flight') ORDER BY created_seq LIMIT 1",
    )
    .get(projectId);
  if (inFlight) {
    const brief = projectBrief(store.db, projectId);
    return {
      project: brief,
      goal: brief?.goal ?? "",
      goal_source: brief?.goal_source ?? "missing",
      goal_missing: Boolean(brief?.goal_missing),
      plan_request_id: null,
      plan_run_id: inFlight.id,
      plan_run_status: inFlight.status,
      deduped: true,
      reload,
      note: "已存在在途规划（§16.1 单规划在途），幂等返回既有；planner 提交后进展经 GET /sorne/intents 与 GET /sorne/changes 呈现",
    };
  }

  const goalInfo = resolveProjectGoal(project);
  const question = goalInfo.goal || DEFAULT_QUESTION;
  // waiting_for_change → active（用户显式开始探索即条件满足；事件与 lifecycle 同法落库）
  if (project.status === "waiting_for_change") {
    await store.runSerial((db) => {
      const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId);
      if (!row || row.status !== "waiting_for_change") return null;
      const commitSeq = Number(db.prepare("SELECT next_commit_seq AS n FROM projects WHERE id = ?").get(projectId).n);
      const now = new Date().toISOString();
      db.prepare(
        "UPDATE projects SET next_commit_seq = ?, status = 'active', state_version = state_version + 1, updated_seq = ? WHERE id = ?",
      ).run(commitSeq + 1, commitSeq, projectId);
      const eventSeq = allocateEventSeq(db, projectId);
      db.prepare(
        `INSERT INTO outbox (event_id, project_id, commit_seq, event_index, event_type, subject_ids,
           changed_fields, cause_refs, producer_id, schema_version, payload, delivery_status,
           delivery_attempts, created_at)
         VALUES (?, ?, ?, 1, 'resource_state.changed', ?, ?, ?, 'm2/explore-start', 1, ?, 'pending', 0, ?)`,
      ).run(
        `EVT-${projectId}-${String(eventSeq).padStart(6, "0")}`,
        projectId,
        commitSeq,
        JSON.stringify([projectId]),
        JSON.stringify(["status"]),
        JSON.stringify([projectId]),
        JSON.stringify({ kind: "project_lifecycle", from: "waiting_for_change", to: "active", action: "resume", cause: "explore_start" }),
        now,
      );
      return null;
    });
  }
  const session = { project_id: projectId, actor, role };
  const noteSuffix = goalInfo.goal_missing
    ? "（目标缺失 goal_missing=true：task 与 description 均为空）"
    : goalInfo.goal_source === "description_fallback"
      ? "（task 为空，回退使用 description 作为探索目标）"
      : "（主目标取自项目 task）";
  const request = await createPlanRequest(pctx, {
    session,
    question,
    recordRefs: [],
    changes: [],
    urgency: "",
    note: `经开始探索端点发起（首次/重新规划入口）${noteSuffix}`,
  });
  const planRun = request.plan_run ?? request.action?.result ?? null;
  const brief = projectBrief(store.db, projectId);
  return {
    project: brief,
    goal: goalInfo.goal,
    goal_source: goalInfo.goal_source,
    goal_missing: goalInfo.goal_missing,
    plan_request_id: request.decision_id ?? null,
    plan_run_id: planRun?.plan_run_id ?? null,
    plan_run_status: planRun?.plan_run_id ? "in_flight" : null,
    deduped: false,
    reload,
    note: "规划请求已持久化并建立 plan_run（in_flight）；进展条各段映射真实记录（plan_runs/intents/attempts/变化流），失败显示原因不转圈",
  };
}

function projectBrief(db, projectId) {
  const p = db.prepare("SELECT id, name, description, task, status, current_scope_revision, created_at FROM projects WHERE id = ?").get(projectId);
  if (!p) return null;
  const goalInfo = resolveProjectGoal(p);
  return {
    ...p,
    task: p.task ?? "",
    goal: goalInfo.goal,
    goal_source: goalInfo.goal_source,
    goal_missing: goalInfo.goal_missing,
    goal_note: goalInfo.goal_note,
  };
}
