// 运行事件流渲染：已知类型友好渲染，未知类型通用回退（开放集合不丢弃）。
import { el } from "./dom.js";
import { truncateText, formatEventTime, formatEventShort, formatDuration } from "./format.js";

const STATUS_CN = {
  idle: "空闲", running: "运行中", completed: "已完成", paused: "已暂停",
  awaiting_approval: "等待审批", stopping: "正在停止", stopped: "已停止",
  failed: "失败", cancelled: "已取消", restricted: "策略受限",
};
const STAGE_CN = {
  swarm: "并发执行", review: "结果复核", commit: "结果提交",
  profile: "基础画像", profile_incremental: "增量画像", mrecon: "前置采集", finished: "已结束",
};
function stageCn(value) { return STAGE_CN[value] || value || ""; }

function friendlyEvent(event) {
  const type = event.event_type || event.action || "event";
  const data = event.data || event.details || {};
  const member = data.member || data.member_name || "模型任务";
  const activity = data.activity || {};
  const activityTarget = activity.target || null;
  if (type === "model_local_guest_image_build_started") return { kind: "started", title: "正在构建本地运行镜像", summary: data.image || "agent-compose-guest:latest", detail: "首次使用本地 Docker 时只构建一次；并发 Worker 会等待并复用该镜像。" };
  if (type === "model_local_guest_image_build_progress") return { kind: "waiting", title: "本地镜像构建中", summary: data.image || "agent-compose-guest:latest", detail: data.text };
  if (type === "model_local_guest_image_build_completed") return { kind: "completed", title: "本地运行镜像已就绪", summary: data.image || "agent-compose-guest:latest" };
  if (type === "model_stream_started") return { kind: "started", title: "模型会话已建立", summary: member, meta: [data.session_id && `会话 ${data.session_id}`, Array.isArray(data.tools) && data.tools.length && `可用工具 ${data.tools.length} 个`].filter(Boolean).join(" · ") };
  if (type === "model_agent_compose_log") return { kind: "assistant", title: "模型实时输出", summary: member, meta: activityTarget && `当前任务：${activityTarget}`, detail: data.text };
  if (type === "model_agent_compose_status") return { kind: data.status === "failed" ? "failed" : "waiting", title: "模型运行状态", summary: member, meta: data.status ? `状态：${data.status}` : "agent-compose 运行中" };
  if (type === "model_agent_compose_run_completed") return { kind: "completed", title: "模型任务完成", summary: member, meta: data.duration_ms != null ? `耗时 ${(Number(data.duration_ms) / 1000).toFixed(1)}s` : "agent-compose 已返回结果" };
  if (type === "model_tool_started") return { kind: "tool-running", title: "正在执行工具", summary: data.tool_name || "模型工具", meta: activityTarget && `任务目标：${activityTarget}`, detail: data.input_summary || "工具未提供参数摘要" };
  if (type === "model_tool_completed") return { kind: data.is_error ? "failed" : "tool-completed", title: data.is_error ? "工具执行失败" : "工具执行完成", summary: data.tool_name || "模型工具", meta: data.tool_use_id && `调用 ${data.tool_use_id}`, detail: data.output_summary || "工具未提供结果摘要" };
  if (type === "model_assistant_update") return { kind: "assistant", title: "模型阶段输出", summary: member, detail: data.text };
  if (type === "model_stream_result") return { kind: data.is_error ? "failed" : "completed", title: data.is_error ? "模型返回错误结果" : "模型已返回最终结果", summary: member, meta: [data.duration_ms != null && `耗时 ${(Number(data.duration_ms) / 1000).toFixed(1)}s`, data.num_turns != null && `${data.num_turns} 轮`].filter(Boolean).join(" · ") };
  if (type === "model_call_started") return { kind: "started", title: "正在调用模型", summary: activityTarget || `${member} · ${data.model || "默认模型"}`, meta: [data.driver && `驱动 ${data.driver}`, data.endpoint && `服务 ${data.endpoint}`, data.attempt && `第 ${data.attempt}/${data.max_attempts || "?"} 次`, data.timeout_seconds && `超时 ${data.timeout_seconds}s`].filter(Boolean).join(" · "), detail: activity.success_criteria && `成功标准：${activity.success_criteria}${activity.evidence_sink ? ` · 证据输出：${activity.evidence_sink}` : ""}` };
  if (type === "model_context_compiled") return { kind: "completed", title: "任务上下文已编译", summary: member, meta: [data.prompt_chars != null && `Prompt ${Number(data.prompt_chars).toLocaleString()} 字符`, data.context_chars != null && `任务上下文 ${Number(data.context_chars).toLocaleString()}/${Number(data.context_budget_chars || 0).toLocaleString()}`].filter(Boolean).join(" · "), detail: data.snapshot_id ? `审计快照 ${data.snapshot_id}；可在“Prompt 审计”中查看。` : "已按角色与当前任务筛选黑板记录。" };
  if (type === "model_call_completed") return { kind: "completed", title: "模型调用完成", summary: member, meta: data.duration_seconds == null ? "已收到并持久化模型响应" : `耗时 ${data.duration_seconds}s · 已收到并持久化模型响应` };
  if (type === "model_call_failed") return { kind: "failed", title: /402|insufficient balance/i.test(data.error || "") ? "模型账户余额不足，已停止重试" : data.retryable ? "模型调用失败，可重试" : "模型调用失败，已停止重试", summary: member, meta: [data.duration_seconds != null && `耗时 ${data.duration_seconds}s`, data.status && `任务状态 ${data.status}`].filter(Boolean).join(" · "), error: data.error };
  if (type === "model_policy_restricted") return { kind: "waiting", title: "模型策略受限", summary: member, meta: [data.duration_seconds != null && `耗时 ${data.duration_seconds}s`, "已停止重试，其他并发结果继续收敛"].filter(Boolean).join(" · "), detail: data.error };
  if (type === "model_policy_fallback_started") return { kind: "waiting", title: "历史版本提示词降级记录", summary: member, meta: "当前版本已禁用此降级；新调用与重试始终携带 Agent 专属提示词", detail: data.reason || "该事件由旧版本运行产生" };
  if (["model_call_retry", "model_call_retried", "model_retry_scheduled", "model_call_retry_scheduled"].includes(type)) return { kind: "retry", title: "已安排模型重试", summary: member, meta: data.next_attempt ? `下一次：第 ${data.next_attempt}/${data.max_attempts || "?"} 次` : "即将重新调用模型服务" };
  if (type === "model_thinking_progress") return { kind: "thinking", title: "模型思考中", summary: activityTarget || member, meta: data.estimated_tokens != null ? `已思考 ${data.estimated_tokens} tokens` : "模型正在分析上下文和规划执行步骤", detail: "模型 Extended Thinking 进行中，思考完成后将开始工具调用。" };
  if (type === "model_call_waiting") return { kind: "waiting", title: "等待模型运行时新事件", summary: activityTarget || member, meta: data.elapsed_seconds == null ? "Sorne 调度心跳正常" : `已等待 ${data.elapsed_seconds}s / ${data.timeout_seconds || "?"}s · Sorne 调度心跳正常`, detail: "这是调度心跳；任务行会继续保留最近一次模型工具动作。" };
  if (type === "run_execution_budget_paused") return { kind: "waiting", title: "运行预算不足，已安全暂停", summary: `下一阶段：${data.next_stage || "待定"}`, meta: `剩余 ${data.remaining_seconds ?? 0}s · 完整调用需要 ${data.required_seconds ?? "?"}s`, detail: "没有创建新的模型任务；已完成结果和未完成待办均已持久化，可恢复运行继续。" };
  if (type === "run_execution_budget_renewed") return { kind: "completed", title: "运行预算已续签", summary: data.execution_deadline ? `新截止时间：${formatEventTime(data.execution_deadline)}` : "可继续执行", meta: data.lease_seconds ? `新增预算 ${formatDuration(data.lease_seconds)}` : "" };
  if (type === "profile_incremental_scheduled") return { kind: "started", title: "增量画像已排程", summary: `${(data.work_item_urls || []).length} 个 URL`, meta: (data.needs_review_recheck_urls || []).length ? `含 ${data.needs_review_recheck_urls.length} 个复核 URL` : "" };
  if (type === "profile_work_dispatched") return { kind: "started", title: "画像工作项已派发", summary: `${data.work_item_count ?? 0} 个 URL 工作项` };
  if (type === "jev_shadow_recorded") return { kind: "completed", title: "JEV 影子分类已留档", summary: `${data.targets ?? 0} 个目标`, meta: data.skipped ? `跳过 ${data.skipped}` : "", detail: "影子数据只进评估记录 classification_provenance，不影响调度。" };
  if (type === "jev_shadow_failed") return { kind: "waiting", title: "JEV 影子调用失败", summary: member, detail: data.error };
  // 内部生命周期事件：给可读标题，不再直接输出原始 JSON。
  if (type === "run_created") return { kind: "started", title: "运行已创建", summary: data.team ? `团队 ${data.team}` : "" };
  if (type === "run_finished") return { kind: data.status === "failed" ? "failed" : "completed", title: "运行已结束", summary: STATUS_CN[data.status] || data.status || "", detail: data.error };
  if (type === "run_stopping") return { kind: "waiting", title: "运行正在停止", summary: "不再派发新任务；进行中的任务安全收尾" };
  if (type === "run_stopped") return { kind: "failed", title: "运行已停止", summary: STATUS_CN[data.status] || data.status || "" };
  if (type === "run_status_changed") return { kind: "waiting", title: "运行状态变更", summary: STATUS_CN[data.status] || data.status || "" };
  if (type === "run_stage_changed") return { kind: "started", title: "进入新阶段", summary: stageCn(data.stage) };
  if (type === "run_wave_advanced") return { kind: "started", title: "进入下一波并发", summary: data.wave != null ? `第 ${data.wave} 波` : "" };
  if (type === "job_queued") return { kind: "started", title: "任务已排队", summary: data.member || member, meta: data.stage ? `阶段 ${stageCn(data.stage)}` : "" };
  if (type === "job_claimed") return { kind: "started", title: "任务已认领", summary: data.worker_id || member };
  if (type === "job_completed") return { kind: "completed", title: "任务执行完成", summary: member };
  if (type === "job_failed") return { kind: "failed", title: "任务执行失败", summary: member, detail: data.error };
  if (type === "job_policy_restricted") return { kind: "waiting", title: "任务策略受限", summary: member, detail: data.error };
  if (type === "job_human_cancelled") return { kind: "failed", title: "任务已人工取消", summary: member };
  if (type === "job_committed") return { kind: "completed", title: "结果已提交黑板", summary: member };
  if (type === "job_commit_enqueued") return { kind: "completed", title: "结果提交已排队", summary: member };
  if (type === "direction_registered") return { kind: "started", title: "验证方向已生成", summary: data.direction_id || "" };
  if (type === "direction_finished") return { kind: "completed", title: "验证方向已结束", summary: data.direction_id || "", detail: data.reason || data.terminal_reason };
  if (type === "direction_claimed") return { kind: "started", title: "方向已被认领", summary: data.direction_id || "", meta: data.worker_id ? `认领方 ${data.worker_id}` : "" };
  if (type === "direction_status_changed") return { kind: "waiting", title: "方向状态变更", summary: data.direction_id || "", meta: data.status || "" };
  if (type === "stale_write_rejected") return { kind: "waiting", title: "过期写入被拒绝", summary: "旧上下文结果已按 Run 栅栏拦截", detail: data.reason || data.error };
    if (type === "api:gate_approved") return { kind: "completed", title: "门禁已批准", summary: data.action === "stop_loss" ? "止损结束" : data.action === "continue" ? "继续执行" : data.action || "", detail: data.reason };
  if (type === "api:automation_launched") return { kind: "started", title: "自动化运行已启动", summary: data.run_id || "" };
  if (type === "api:automation_cancelled") return { kind: "failed", title: "运行已取消", summary: data.run_id || "" };
  if (type === "api:finding_human_reviewed") return { kind: "completed", title: "人工结论已提交", summary: data.finding_id || "" };
  if (type === "api:direction_human_dismissed") return { kind: "waiting", title: "方向已人工否决", summary: data.direction_id || "" };
  if (type === "api:direction_human_restored") return { kind: "started", title: "方向已恢复", summary: data.direction_id || "" };
  if (type === "api:target_updated") return { kind: "completed", title: "目标配置已更新" };
  if (type === "api:project_initialized") return { kind: "completed", title: "项目已初始化" };
  if (type === "api:config_updated") return { kind: "completed", title: "团队配置已保存" };
  return null;
}
function renderEvent(event) {
  const friendly = friendlyEvent(event);
  const row = document.createElement("div");
  row.className = `event-row${friendly ? ` model-event kind-${friendly.kind}` : ""}`;
  const time = el("time", "", formatEventShort(event.created_at));
  time.title = formatEventTime(event.created_at);
  if (!friendly) {
    row.append(time, el("strong", "", event.event_type || event.action), el("small", "", JSON.stringify(event.data || event.details || {})));
    return row;
  }
  const content = el("div", "model-event-content");
  const heading = el("div", "model-event-heading");
  heading.append(el("strong", "", friendly.title), el("span", "", friendly.summary));
  content.append(heading);
  if (friendly.meta) content.append(el("small", "", friendly.meta));
  if (friendly.detail) content.append(el("p", "model-event-detail", friendly.detail));
  if (friendly.error) {
    const errorNode = el("code", "", truncateText(friendly.error, 700));
    errorNode.title = String(friendly.error);
    content.append(errorNode);
  }
  row.append(time, content);
  return row;
}
export { friendlyEvent, renderEvent };
