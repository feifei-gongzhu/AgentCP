"use strict";
/* ==========================================================================
   Sorne 0.0.4 前端（app.js）
   七区工作台：项目中心 / 总览 / 发现 / 方向 / 资产与画像 / 运行与诊断 / 设置。
   保留行为：requestGeneration 防竞态、5s 轮询（遥测签名比对）、全部确认流程、
   secrets 只提交不回显、textContent 安全渲染、未知事件通用回退。
   ========================================================================== */
import { state, ui } from "./modules/state.js";
import { truncateText, percent, formatEventTime, formatDuration, ageLabel } from "./modules/format.js";
import { $, el, cell, emptyRow, renderRows, preserveScroll, showToast, setBadge, setConnectionStatus } from "./modules/dom.js";
import { api } from "./modules/api.js";
import { ICONS, badge, severityChip, chip, itemRow, detailSection, statCard } from "./modules/ui.js";
import {
  buildDerived, directionStatusInfo, verdictLabel, riskLeadLifecycle,
  phaseLabel, roleLabel, roleShort, stageLabel, jobStatusLabel, verbLabel,
  coverageLabels, coverageStatusLabels, hypothesisStatusLabel, isModelPolicyRestriction,
} from "./modules/derive.js";
import { friendlyEvent, renderEvent } from "./modules/events.js";
import { renderAssetInventory, uploadAssetInventoryFile } from "./modules/asset-inventory.js";
import {
  normalizeMemberForSave, parseWorkerCommand, stripMemberTransientFields,
  summarizeTeamPresetDiff, validateMemberData,
} from "./modules/team-config.js";
import { downloadTechnologyProfile, downloadTechnologyWorkbook, renderTechnologyProfile } from "./modules/technology-profile.js";
import { routeFromHash } from "./modules/router.js";

/* ---------- 工具 ---------- */
const PAGE_META = {
  projects: { eyebrow: "Sorne 工作台", title: "项目中心" },
  overview: { eyebrow: "实时状态 · 结论 · 控制", title: "总览" },
  findings: { eyebrow: "已验证结果与待验证线索", title: "发现" },
  directions: { eyebrow: "验证方向与假设池", title: "方向" },
  assets: { eyebrow: "暴露面底座 · 技术画像", title: "资产与画像" },
  runs: { eyebrow: "Job 队列 · 事件 · 审计", title: "运行与诊断" },
  settings: { eyebrow: "目标 · 模型团队 · 黑板", title: "项目设置" },
};
async function post(path, body, success) {
  try {
    const result = await api(path, { method: "POST", body: JSON.stringify({ vendor: state.vendor, ...body }) });
    showToast(success(result));
    await refresh();
    return result;
  } catch (error) { showToast(error.message, true); throw error; }
}
function evidenceForFact(fact, indexedEvidence) {
  const configured = String(fact.evidence_path || "").replace(/\/+$/, "");
  return (indexedEvidence || []).filter(item =>
    item.fact_id === fact.id || Boolean(configured && (item.path === configured || String(item.path || "").startsWith(`${configured}/`)))
  );
}
function projectTypeOption(value) {
  const text = String(value || "").toLowerCase();
  if (text.includes("web") || text.includes("api") || text.includes("网站") || text.includes("网页")) return "Web渗透";
  if (text.includes("client") || text.includes("客户端") || text.includes("electron")) return "客户端";
  return "Web渗透";
}

/* ---------- 路由 ---------- */
function routeFromLocation() { return routeFromHash(location.hash); }
function routeUrl(route) {
  const params = new URLSearchParams(location.search);
  if (state.vendor) params.set("vendor", state.vendor); else params.delete("vendor");
  const query = params.toString();
  return `${location.pathname}${query ? `?${query}` : ""}#${route}`;
}
function applyRoute(requested) {
  let route = requested;
  if (["overview", "findings", "directions", "assets", "runs", "settings"].includes(route) && !state.vendor && !state.newTaskMode) route = "projects";
  if (route === "settings" && !state.vendor && !state.newTaskMode) route = "projects";
  state.route = route;
  document.querySelectorAll("[data-view]").forEach(node => { node.hidden = node.dataset.view !== route; });
  document.querySelectorAll("[data-route-link]").forEach(link => {
    link.classList.toggle("active", link.dataset.routeLink === route);
    const isProjectOnly = link.hasAttribute("data-project-only");
    if (isProjectOnly) link.classList.toggle("disabled", !state.vendor && !state.newTaskMode);
  });
  const meta = PAGE_META[route] || PAGE_META.projects;
  $("routeEyebrow").textContent = state.vendor ? `${state.vendor} · ${meta.eyebrow}` : meta.eyebrow;
  $("pageTitle").textContent = state.newTaskMode && route === "settings" ? "新建审计任务" : meta.title;
  $("projectNav").hidden = !state.vendor && !state.newTaskMode;
  $("projectSelect").disabled = !state.projects.length;
  const runActive = ["running", "paused", "awaiting_approval", "stopping"].includes(state.runStatus);
  $("launchButton").disabled = !state.vendor || runActive;
  return route;
}
function navigate(route, { replace = false } = {}) {
  const resolved = applyRoute(route);
  history[replace ? "replaceState" : "pushState"]({}, "", routeUrl(resolved));
}
function canLeaveSettings() {
  return !(state.route === "settings" && (state.targetDirty || state.teamDirty))
    || window.confirm("当前配置有未保存的修改，确定离开吗？");
}
async function requestRoute(route) {
  if (route !== "settings" && !canLeaveSettings()) return;
  if (route === "settings" && !state.vendor && !state.newTaskMode) { prepareNewTask(); navigate("settings"); return; }
  navigate(route);
  if (route !== "projects" && state.vendor && !state.projectData) await refresh();
}
function selectVendor(vendor) {
  if (!state.projects.some(item => item.vendor === vendor)) return false;
  state.vendor = vendor;
  state.newTaskMode = false;
  state.projectData = null;
  state.derived = null;
  ui.selected = { vulns: null, leads: null, directions: null, surface: null };
  return true;
}
async function openProject(vendor, route = "overview") {
  if (!selectVendor(vendor || state.vendor)) return showToast("项目不存在或尚未初始化", true);
  navigate(route);
  await refresh();
}

/* ---------- 项目中心 ---------- */
async function loadProjects(preferred = null) {
  try {
    const payload = await api("/api/projects");
    let presetPayload = { presets: [], default_preset_id: null };
    try {
      presetPayload = await api("/api/team-presets");
      state.teamPresetApiAvailable = true;
    } catch (error) {
      // 静态前端可与旧后端共存：预设接口未启用时项目中心保持可用。
      state.teamPresetApiAvailable = false;
      console.info("团队预设接口尚未启用；继续使用现有项目接口。", error);
    }
    const select = $("projectSelect");
    const requested = new URLSearchParams(location.search).get("vendor");
    state.projects = payload.projects || [];
    state.qualitySummary = payload.quality_summary || null;
    updateTeamPresetState(presetPayload);
    select.replaceChildren();
    const qualitySummary = state.qualitySummary || {};
    $("hubFalsePositiveRate").textContent = qualitySummary.false_positive_rate == null ? "暂无样本" : percent(qualitySummary.false_positive_rate);
    $("hubReviewedCount").textContent = qualitySummary.reviewed ?? 0;
    $("hubRefutedCount").textContent = qualitySummary.false_positives ?? 0;
    $("hubSampleQuality").textContent = qualitySummary.sample_quality || "样本严重不足";
    state.projects.forEach(project => {
      const option = document.createElement("option");
      option.value = project.vendor; option.textContent = project.vendor;
      select.append(option);
    });
    const desired = preferred || state.vendor || requested;
    state.vendor = state.projects.some(item => item.vendor === desired) ? desired : state.projects[0]?.vendor || null;
    select.disabled = !state.projects.length;
    if (state.vendor) select.value = state.vendor;
    // 项目中心也要反映当前项目的门禁与运行状态（此前仅在项目页刷新时更新）。
    const active = state.projects.find(item => item.vendor === state.vendor);
    if (active && !state.projectData) {
      setBadge($("gateBadge"), active.gate_status === "awaiting_approval" ? "awaiting_approval" : (active.run_status || "idle"));
      setBadge($("runBadge"), active.run_status || "idle");
    }
    renderProjectList();
    applyRoute(state.route);
    setConnectionStatus("实时同步", true);
  } catch (error) { setConnectionStatus("连接异常", false); throw error; }
}
function renderProjectList() {
  const body = $("projectList");
  if (!state.projects.length) {
    emptyRow(body, 10, "还没有审计项目。点击左上角“新建审计任务”，先录入授权目标，再配置模型团队。");
    return;
  }
  preserveScroll(body.closest(".table-wrap"), () => {
    body.replaceChildren();
    state.projects.forEach(project => {
      const row = document.createElement("tr");
      row.dataset.vendor = project.vendor;
      row.classList.toggle("selected", project.vendor === state.vendor);
      const awaiting = project.gate_status === "awaiting_approval";
      row.classList.toggle("needs-approval", awaiting);
      row.title = "点击进入项目工作台";
      const nameTd = cell("", "");
      nameTd.append(el("span", "project-name", project.vendor));
      const goalTd = cell("", "");
      goalTd.append(el("div", "project-goal", project.current_task || project.goal || "尚未定义当前审计任务"));
      const statusTd = cell("", "");
      statusTd.append(badge(project.run_status || project.gate_status || "idle"));
      const quality = project.quality_metrics || {};
      const qualityText = quality.false_positive_rate == null
        ? "暂无样本"
        : `${percent(quality.false_positive_rate)}（复核 ${quality.reviewed ?? 0}）`;
      row.append(
        nameTd, goalTd,
        cell(phaseLabel(project.phase)), statusTd,
        cell(String(project.target_count ?? 0), "num"),
        cell(String(project.fact_count ?? 0), "num"),
        cell(String(project.vulnerability_count ?? 0), "num"),
        cell(qualityText),
        cell(project.updated_at ? formatEventTime(project.updated_at) : "尚未更新", "updated-cell"),
      );
      const actions = cell("", "actions-col");
      const wrap = el("div", "row-actions");
      const open = el("button", `button small ${awaiting ? "primary" : "secondary"} project-open`, awaiting ? "处理审批" : "进入");
      open.type = "button"; open.dataset.vendor = project.vendor; open.dataset.route = awaiting ? "overview" : "settings";
      const del = el("button", "button ghost small project-delete", "删除");
      del.type = "button"; del.dataset.vendor = project.vendor;
      wrap.append(open, del);
      actions.append(wrap);
      row.append(actions);
      body.append(row);
    });
  });
}

/* ---------- 团队预设 ---------- */
function selectedTeamPreset() {
  const id = $("teamPresetSelect").value || state.selectedTeamPresetId;
  return state.teamPresets.find(item => item.id === id) || null;
}
function renderTeamPresetControls(preferredId = null) {
  const selected = preferredId || state.selectedTeamPresetId;
  const select = $("teamPresetSelect");
  select.replaceChildren();
  if (!state.teamPresets.length) {
    const option = document.createElement("option");
    option.value = ""; option.textContent = "尚无个人预设";
    select.append(option);
  } else {
    state.teamPresets.forEach(preset => {
      const option = document.createElement("option");
      option.value = preset.id;
      option.textContent = `${preset.name}${preset.is_default ? "（默认）" : ""}`;
      select.append(option);
    });
  }
  const resolved = state.teamPresets.some(item => item.id === selected)
    ? selected
    : state.defaultTeamPresetId || state.teamPresets[0]?.id || "";
  select.value = resolved;
  state.selectedTeamPresetId = resolved || null;
  const preset = selectedTeamPreset();
  const unavailable = !state.teamPresetApiAvailable;
  const disabled = !preset || unavailable;
  ["applyTeamPresetButton", "updateTeamPresetButton", "defaultTeamPresetButton",
    "duplicateTeamPresetButton", "renameTeamPresetButton", "deleteTeamPresetButton"]
    .forEach(id => { $(id).disabled = disabled || (id === "applyTeamPresetButton" && !state.vendor); });
  $("saveAsTeamPresetButton").disabled = unavailable || !state.vendor || !state.teamConfig;
  $("defaultTeamPresetButton").textContent = preset?.is_default ? "取消默认" : "设为默认";
  $("teamPresetStatus").textContent = unavailable
    ? "当前后端仍是旧版本；项目与正在运行的任务不受影响。为避免中断任务，个人预设暂不可操作，服务下次重启后自动启用。"
    : preset
    ? `${preset.name} · ${preset.config?.members?.length || 0} 个角色${preset.is_default ? " · 新项目默认使用" : ""}；密钥别名 ${Object.values(preset.secret_status || {}).filter(Boolean).length} 个已就绪。`
    : "尚无个人预设。可以将当前项目团队另存为预设；真实 API Key 不会写入预设文件。";
  const newSelect = $("newProjectPreset");
  const previousNew = newSelect.value;
  newSelect.replaceChildren();
  const defaultOption = document.createElement("option");
  defaultOption.value = "";
  defaultOption.textContent = state.defaultTeamPresetId ? "使用个人默认预设" : "使用默认项（当前为系统模板）";
  newSelect.append(defaultOption);
  const systemOption = document.createElement("option");
  systemOption.value = "__system__"; systemOption.textContent = "使用系统默认模板";
  newSelect.append(systemOption);
  state.teamPresets.forEach(item => {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = item.name + (item.is_default ? "（默认）" : "");
    newSelect.append(option);
  });
  if ([...newSelect.options].some(option => option.value === previousNew)) newSelect.value = previousNew;
  if (unavailable) { newSelect.value = "__system__"; newSelect.disabled = true; }
  else newSelect.disabled = false;
}
function updateTeamPresetState(payload, preferredId = null) {
  state.teamPresets = payload.presets || [];
  state.defaultTeamPresetId = payload.default_preset_id || null;
  renderTeamPresetControls(preferredId);
}

/* ---------- 总览 ---------- */
function renderRunStatus(data, automation, metrics) {
  const run = automation.run || null;
  $("phaseValue").textContent = phaseLabel(data.phase);
  setBadge($("runBadge"), run?.status || "idle");
  setBadge($("gateBadge"), data.gate_status === "awaiting_approval" ? "awaiting_approval" : run?.status || "idle");
  $("sbElapsed").textContent = formatDuration(run?.elapsed_seconds);
  $("runSummary").textContent = run ? `${run.id} · ${run.team} · ${stageLabel(run.stage)} · 并发 ${run.max_workers} · wave ${run.wave ?? 1}/${run.max_waves ?? "?"}` : "暂无自动化运行";
  const jobs = automation.jobs || [];
  const terminalJobs = jobs.filter(job => ["completed", "failed", "restricted", "cancelled", "cancelling"].includes(job.status));
  const completedJobs = jobs.filter(job => job.status === "completed").length;
  const failedJobs = jobs.filter(job => ["failed", "cancelled", "cancelling"].includes(job.status)).length;
  const restrictedJobs = jobs.filter(job => job.status === "restricted").length;
  const currentRun = metrics.automation.current_run || {
    jobs: jobs.length, finished_jobs: terminalJobs.length, completed_jobs: completedJobs,
    failed_jobs: failedJobs, restricted_jobs: restrictedJobs,
    progress_rate: jobs.length ? terminalJobs.length / jobs.length : 0,
  };
  const rate = Math.round((currentRun.progress_rate || 0) * 100);
  $("runProgressBar").style.width = `${rate}%`;
  $("runProgressText").textContent = currentRun.jobs
    ? `${currentRun.finished_jobs}/${currentRun.jobs} 已结束 · ${currentRun.completed_jobs} 成功 / ${currentRun.failed_jobs} 失败${currentRun.restricted_jobs ? ` / ${currentRun.restricted_jobs} 策略受限` : ""} · ${rate}%`
    : "暂无 Job";
  $("cancelButton").disabled = !run || ["completed", "failed", "cancelled", "stopping", "stopped"].includes(run.status);
  const runActive = ["running", "paused", "awaiting_approval", "stopping"].includes(run?.status);
  $("launchButton").disabled = !state.vendor || runActive;
  $("currentTaskBadge").textContent = phaseLabel(data.phase);
  $("currentTask").textContent = data.current_task || "尚未定义当前任务";
  $("decisionValue").textContent = data.current_decision || "continue";
  $("gateReason").textContent = data.gate_reason || "尚未触发强制节拍";
}
function renderMetrics(project, data, metrics) {
  const assetsBlock = metrics.assets || {};
  const assetTotal = assetsBlock.active_scope_endpoint_count ?? data.asset_count ?? 0;
  $("assetMetric").textContent = assetTotal;
  $("assetMetricNote").textContent = metrics.assets
    ? `目标 ${assetsBlock.declared_target_count ?? metrics.assets.declared} · 底座记录 ${assetsBlock.inventory_record_count ?? 0} · 待画像 ${assetsBlock.profile_pending_work_count ?? 0}`
    : `${new Set((project.target.targets || []).map(value => String(value).trim().toLowerCase()).filter(Boolean)).size} 个已配置目标`;
  const pendingFacts = metrics.quality.pending_facts ?? (state.derived?.pendingFactRows || []).length;
  $("factMetric").textContent = metrics.quality.facts;
  $("factMetricNote").textContent = pendingFacts ? `${pendingFacts} 条候选待提交` : "全部已提交到黑板";
  $("vulnMetric").textContent = metrics.quality.vulnerabilities;
  $("vulnMetricNote").textContent = `系统漏洞池 · ${project.quality_metrics?.pending ?? 0} 待人工复核`;
  $("coverageMetric").textContent = `${Math.round(metrics.coverage.coverage_rate * 100)}%`;
  $("coverageMetricNote").textContent = `${metrics.coverage.covered}/${metrics.coverage.dimensions} 个维度已观察`;
}
function renderGateApproval(data, automation) {
  const card = $("gateApprovalCard");
  const run = automation.run || null;
  const awaiting = data.gate_status === "awaiting_approval";
  state.gateContext = { visible: awaiting, awaiting, run, data };
  card.hidden = !awaiting;
  if (!awaiting) return;
  $("gateApprovalReason").textContent = data.gate_reason || run?.error || "自动化运行已暂停，必须由用户明确批准后才能继续。";
  $("gateApprovalPhase").textContent = phaseLabel(data.phase);
  $("gateApprovalElapsed").textContent = formatDuration(run?.elapsed_seconds);
  $("gateApprovalAssets").textContent = `${data.asset_count ?? 0} / ${data.vulnerability_count ?? 0}`;
  $("gateApprovalHighRisk").textContent = data.high_risk_fingerprint_count ?? 0;
  $("gateApprovalDiscovery").textContent = data.last_discovery_at ? formatEventTime(data.last_discovery_at) : "无";
  $("gateApprovalRun").textContent = run ? `${run.id} · ${run.status}` : "无可恢复运行";
  setBadge($("gateApprovalRunBadge"), "awaiting_approval");
  $("gateContinueButton").textContent = run?.status === "paused" ? "批准并恢复运行" : ["completed", "failed", "stopped", "cancelled"].includes(run?.status) ? "批准并开始下一轮" : "批准继续";
  $("gateStopButton").textContent = ["completed", "failed", "stopped", "cancelled"].includes(run?.status) ? "确认止损，不再续跑" : "止损并终止运行";
  $("gateContinueButton").disabled = state.gateSubmitting;
  $("gateStopButton").disabled = state.gateSubmitting;
}
function renderRunFailure(automation) {
  const alert = $("runFailure");
  const run = automation.run || {};
  const jobs = automation.jobs || [];
  const failedJob = [...jobs].reverse().find(job => job.error && ["failed", "cancelled"].includes(job.status));
  const restrictedJob = [...jobs].reverse().find(job => job.error && job.status === "restricted");
  const budgetPaused = run.status === "paused" && run.error === "execution_budget_exhausted";
  const runFailed = run.status === "failed";
  const runStopped = ["stopped", "cancelled"].includes(run.status);
  const error = budgetPaused
    ? "当前执行预算不足以安全启动下一阶段；所有结果和待办均已保留，可恢复运行继续处理。"
    : runStopped ? (run.error || "运行已由用户停止")
    : runFailed ? (run.error || failedJob?.error)
    : restrictedJob?.error || failedJob?.error;
  if (!error) { alert.hidden = true; alert.replaceChildren(); return; }
  const policyRestricted = !runFailed && !runStopped && Boolean(restrictedJob || isModelPolicyRestriction(failedJob));
  const title = el("strong", "", budgetPaused ? "运行已安全暂停" : runStopped ? "运行已停止" : runFailed ? "运行失败" : policyRestricted ? "模型策略受限" : "模型任务失败");
  const detail = el("span", "", truncateText(error, 900));
  detail.title = String(error);
  alert.replaceChildren(title, detail);
  alert.hidden = false;
}
function renderCoverage(data) {
  const entries = Object.entries(data.attack_surface_coverage || {});
  $("coverageList").replaceChildren();
  const verified = entries.filter(([, value]) => value === "verified").length;
  $("coverageSummaryChip").textContent = `${verified}/${entries.length} 已验证`;
  entries.forEach(([name, statusValue]) => {
    const row = el("div", `coverage-row ${statusValue}`);
    const track = el("div", "coverage-track");
    track.append(document.createElement("i"));
    row.append(
      el("span", "", coverageLabels[name] || name),
      track,
      el("small", "", coverageStatusLabels[statusValue] || statusValue),
    );
    $("coverageList").append(row);
  });
}
function renderRecentEvents(automation, auditResult) {
  const events = [
    ...(automation.events || []).filter(event => event.event_type !== "model_agent_compose_log"),
    ...(auditResult.audit || []).map(item => ({ created_at: item.created_at, event_type: `api:${item.action}`, data: item.details })),
  ].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 12);
  preserveScroll($("recentEvents"), () => {
    $("recentEvents").replaceChildren();
    events.forEach(event => $("recentEvents").append(renderEvent(event)));
    if (!events.length) $("recentEvents").append(el("div", "empty-state", "暂无运行事件"));
  });
}

/* ---------- 发现：漏洞 / 线索 / 攻击面 ---------- */
function renderVulnList() {
  const list = $("vulnList");
  const { vulnerabilities, verdicts } = state.derived;
  preserveScroll(list, () => {
    list.replaceChildren();
    if (!vulnerabilities.length) {
      list.append(el("div", "empty-state", "系统漏洞池为空。Guardian 已验证的发现会出现在这里。"));
      return;
    }
    vulnerabilities.forEach(fact => {
      const verdict = verdicts[fact.id];
      const row = itemRow({
        title: fact.title,
        chips: [severityChip(fact.severity)],
        pending: fact.__pending,
        selected: ui.selected.vulns === fact.id,
        meta: [
          `${fact.id}`,
          `置信度 ${percent(fact.confidence)}`,
          verdict ? `✓ ${verdictLabel(verdict)}` : "待人工复核",
        ],
        onClick: () => selectVulnerability(fact.id),
      });
      row.querySelector(".item-meta").lastChild.className = verdict ? "verdict-tag" : "verdict-tag missing";
      list.append(row);
    });
  });
}
function selectVulnerability(id, { switchTab = false } = {}) {
  ui.selected.vulns = id;
  if (switchTab) selectTab("vulns");
  renderVulnList();
  renderVulnDetail();
}
function renderVulnDetail() {
  const info = $("vulnDetailInfo");
  const box = $("reviewBox");
  const { vulnerabilities, verdicts, indexedEvidence, sourceLeadsByVulnerability } = state.derived;
  const fact = vulnerabilities.find(item => item.id === ui.selected.vulns) || null;
  if (!fact) {
    ui.selected.vulns = null;
    info.replaceChildren(el("div", "empty-state", vulnerabilities.length ? "选择左侧漏洞查看完整信息。" : "暂无系统漏洞。"));
    box.hidden = true;
    return;
  }
  const nodes = [];
  nodes.push(el("div", "detail-title", fact.title));
  const chipsRow = el("div", "detail-chips");
  chipsRow.append(severityChip(fact.severity));
  [fact.id, `置信度 ${percent(fact.confidence)}`, `影响力 ${percent(fact.impact_score)}`]
    .forEach(text => chipsRow.append(chip(text)));
  if (fact.__pending) chipsRow.append(chip(`候选 · 来自 ${fact.__member} · 尚未写入黑板`, "warn"));
  nodes.push(chipsRow);
  nodes.push(detailSection("已验证危害", el("p", "", fact.business_impact || "尚未形成漏洞闭环")));
  const steps = Array.isArray(fact.reproduction_steps) ? fact.reproduction_steps.filter(Boolean) : [];
  if (steps.length) {
    const ol = document.createElement("ol");
    steps.forEach(step => ol.append(el("li", "", step)));
    nodes.push(detailSection(`复现方式（${steps.length} 步）`, ol));
  } else {
    nodes.push(detailSection("复现方式", el("p", "", "缺少结构化复现步骤")));
  }
  const matches = evidenceForFact(fact, indexedEvidence);
  if (matches.length) {
    const wrap = el("div", "detail-links");
    matches.forEach(item => {
      const button = el("button", "detail-link evidence-open", `查看证据 · ${item.path}`);
      button.type = "button"; button.dataset.path = item.path;
      button.title = `SHA-256 ${item.sha256 || "未索引"}`;
      wrap.append(button);
    });
    nodes.push(detailSection(`证据（${matches.length} 份）`, wrap));
  } else {
    nodes.push(detailSection("证据", el("p", "", fact.evidence_path ? `证据未进入索引：${fact.evidence_path}` : "漏洞未声明证据路径")));
  }
  const sourceLeads = sourceLeadsByVulnerability.get(fact.id) || [];
  if (sourceLeads.length) nodes.push(detailSection("来源", el("p", "", `由 ${sourceLeads.length} 条风险线索论证转化`)));
  info.replaceChildren(...nodes);
  if (fact.__pending) { box.hidden = true; $("submitFindingReview").disabled = true; return; }
  box.hidden = false;
  $("submitFindingReview").disabled = false;
  $("reviewFindingName").textContent = ` · ${fact.id}`;
  const verdict = verdicts[fact.id];
  if (["info", "low", "medium", "high", "critical"].includes(verdict?.final_severity || fact.severity)) {
    $("reviewSeverity").value = verdict?.final_severity || fact.severity;
  }
  syncDuplicateReviewOptions();
}
function syncDuplicateReviewOptions() {
  const vulnerabilities = (state.derived?.vulnerabilities || []).filter(fact => !fact.__pending);
  const selected = ui.selected.vulns;
  const previous = $("reviewDuplicateOf").value;
  $("reviewDuplicateOf").replaceChildren();
  vulnerabilities.filter(fact => fact.id !== selected).forEach(fact => {
    const option = document.createElement("option");
    option.value = fact.id;
    option.textContent = `${fact.id} · ${fact.title}`;
    $("reviewDuplicateOf").append(option);
  });
  if (vulnerabilities.some(fact => fact.id === previous && fact.id !== selected)) $("reviewDuplicateOf").value = previous;
  const sameRoot = $("reviewAction").value === "same_root";
  $("reviewDuplicateOfLabel").hidden = !sameRoot;
  $("reviewDuplicateOf").disabled = !sameRoot;
}
function renderLeadList() {
  const list = $("leadList");
  const { riskLeads } = state.derived;
  preserveScroll(list, () => {
    list.replaceChildren();
    if (!riskLeads.length) {
      list.append(el("div", "empty-state", "暂无风险线索。待验证发现会出现在这里。"));
      return;
    }
    [...riskLeads].reverse().forEach(item => {
      const lifecycle = riskLeadLifecycle(item);
      const confirmed = item.__confirmedVulnerabilities?.length;
      list.append(itemRow({
        title: item.title,
        chips: [severityChip(item.severity)],
        pending: item.__pending,
        selected: ui.selected.leads === item.id,
        meta: [
          lifecycle.label,
          confirmed ? `已证实为漏洞（${confirmed}）` : "未转化",
          ageLabel(item.created_at || item.updated_at),
        ],
        onClick: () => { ui.selected.leads = item.id; renderLeadList(); renderLeadDetail(); },
      }));
    });
  });
}
function renderLeadDetail() {
  const panel = $("leadDetail");
  const item = (state.derived?.riskLeads || []).find(lead => lead.id === ui.selected.leads) || null;
  if (!item) {
    ui.selected.leads = null;
    panel.replaceChildren(el("div", "empty-state", "选择左侧线索查看完整信息。"));
    return;
  }
  const lifecycle = riskLeadLifecycle(item);
  const nodes = [el("div", "detail-title", item.title)];
  const chipsRow = el("div", "detail-chips");
  chipsRow.append(severityChip(item.severity));
  [item.id, lifecycle.label, `置信度 ${percent(item.confidence)}`, `影响力 ${percent(item.impact_score)}`, `创建于 ${formatEventTime(item.created_at || item.updated_at)}`]
    .forEach(text => chipsRow.append(chip(text)));
  if (item.__pending) chipsRow.append(chip(`候选 · 来自 ${item.__member}`, "warn"));
  nodes.push(chipsRow);
  nodes.push(detailSection("待验证危害", el("p", "", item.business_impact || "尚未形成漏洞闭环")));
  nodes.push(detailSection("验证状态", el("p", "", `${lifecycle.label} · ${lifecycle.detail}`)));
  const confirmed = item.__confirmedVulnerabilities || [];
  if (confirmed.length) {
    const wrap = el("div", "detail-links");
    confirmed.forEach(vulnerability => {
      const button = el("button", "detail-link", `${vulnerability.id} · ${truncateText(vulnerability.title, 60)}`);
      button.type = "button";
      button.title = vulnerability.title;
      button.addEventListener("click", () => selectVulnerability(vulnerability.id, { switchTab: true }));
      wrap.append(button);
    });
    nodes.push(detailSection(`已证实为漏洞（${confirmed.length}）`, wrap));
  } else {
    nodes.push(detailSection("漏洞转化", el("p", "", "尚未证实为漏洞；仍保留为待验证线索。")));
  }
  if (item.terminal_reason) nodes.push(detailSection("终止原因", el("p", "mono", item.terminal_reason)));
  panel.replaceChildren(...nodes);
}
function renderSurfaceList() {
  const list = $("surfaceList");
  const { attackIntel } = state.derived;
  preserveScroll(list, () => {
    list.replaceChildren();
    if (!attackIntel.length) {
      list.append(el("div", "empty-state", "暂无攻击面情报。已观察资产与服务会出现在这里。"));
      return;
    }
    [...attackIntel].reverse().forEach(fact => {
      list.append(itemRow({
        title: fact.title,
        chips: fact.__pending ? [chip(`候选 · ${fact.__member}`, "warn")] : [],
        selected: ui.selected.surface === fact.id,
        meta: [
          fact.id,
          fact.category || "—",
          ageLabel(fact.created_at || fact.updated_at),
        ],
        onClick: () => { ui.selected.surface = fact.id; renderSurfaceList(); renderSurfaceDetail(); },
      }));
    });
  });
}
function renderSurfaceDetail() {
  const panel = $("surfaceDetail");
  const fact = (state.derived?.attackIntel || []).find(item => item.id === ui.selected.surface) || null;
  if (!fact) {
    ui.selected.surface = null;
    panel.replaceChildren(el("div", "empty-state", "选择左侧条目查看完整信息。"));
    return;
  }
  const nodes = [el("div", "detail-title", fact.title)];
  const chipsRow = el("div", "detail-chips");
  [fact.id, fact.category].forEach(text => chipsRow.append(chip(text)));
  if (fact.__pending) chipsRow.append(chip(`候选 · 来自 ${fact.__member}`, "warn"));
  nodes.push(chipsRow);
  nodes.push(detailSection("观察说明", el("p", "", fact.evidence || "暂无观察说明")));
  nodes.push(detailSection("业务影响", el("p", "", fact.business_impact || "尚未评估业务影响")));
  const matches = evidenceForFact(fact, state.derived.indexedEvidence);
  if (matches.length) {
    const wrap = el("div", "detail-links");
    matches.forEach(item => {
      const button = el("button", "detail-link evidence-open", `查看证据 · ${item.path}`);
      button.type = "button"; button.dataset.path = item.path;
      wrap.append(button);
    });
    nodes.push(detailSection(`证据（${matches.length} 份）`, wrap));
  }
  panel.replaceChildren(...nodes);
}

/* ---------- 方向 + 假设 ---------- */
function renderDirectionList() {
  const list = $("directionList");
  const { directionRows } = state.derived;
  preserveScroll(list, () => {
    list.replaceChildren();
    if (!directionRows.length) {
      list.append(el("div", "empty-state", "方向池为空。验证方向与执行状态会出现在这里。"));
      return;
    }
    [...directionRows].reverse().forEach(intent => {
      const status = directionStatusInfo(intent);
      const chipsRow = [];
      if (intent.confirmed_vulnerabilities.length) chipsRow.push(chip(`已证实 ${intent.confirmed_vulnerabilities.length} 漏洞`, "danger"));
      if (status.humanDismissed) chipsRow.push(chip("人工否决", "warn"));
      if (status.policyCooling) chipsRow.push(chip("策略冷却", "warn"));
      list.append(itemRow({
        title: `${verbLabel(intent.verb)} · ${intent.target || "未指定目标"}`,
        chips: chipsRow,
        selected: ui.selected.directions === intent.direction_id,
        meta: [intent.direction_id, status.label, intent.claimed_by ? `认领 ${intent.claimed_by}` : ""].filter(Boolean),
        onClick: () => { ui.selected.directions = intent.direction_id; renderDirectionList(); renderDirectionDetail(); },
      }));
    });
  });
}
function renderDirectionDetail() {
  const panel = $("directionDetail");
  const intent = (state.derived?.directionRows || []).find(item => item.direction_id === ui.selected.directions) || null;
  if (!intent) {
    ui.selected.directions = null;
    panel.replaceChildren(el("div", "empty-state", "选择左侧方向查看完整信息。"));
    return;
  }
  const status = directionStatusInfo(intent);
  const nodes = [el("div", "detail-title", `${verbLabel(intent.verb)} · ${intent.target || "未指定目标"}`)];
  const chipsRow = el("div", "detail-chips");
  [intent.direction_id, status.label, `潜在风险 ${intent.risk_level || "未知"}`, `操作风险 ${intent.action_safety_risk || "low"}`,
   intent.claimed_by ? `认领 ${intent.claimed_by}` : "未认领"]
    .forEach(text => chipsRow.append(chip(text)));
  nodes.push(chipsRow);
  nodes.push(detailSection("成功标准", el("p", "", intent.success_criteria || "未指定")));
  if (intent.expected_business_impact) nodes.push(detailSection("预期业务影响", el("p", "", intent.expected_business_impact)));
  if (intent.source_hypothesis) {
    nodes.push(detailSection("来源假设", el("p", "",
      `${intent.source_hypothesis.id} · ${truncateText(intent.source_hypothesis.statement || intent.source_hypothesis.title || "", 220)}`)));
  }
  if (intent.terminal_reason) {
    nodes.push(detailSection("终止原因", el("p", "mono", status.humanDismissed ? intent.terminal_reason.replace(/^human_dismissed:/, "") : intent.terminal_reason)));
  }
  const confirmed = intent.confirmed_vulnerabilities || [];
  if (confirmed.length) {
    const wrap = el("div", "detail-links");
    confirmed.forEach(vulnerability => {
      const button = el("button", "detail-link", `${vulnerability.id} · ${truncateText(vulnerability.title, 60)}`);
      button.type = "button";
      button.addEventListener("click", () => { navigate("findings"); selectVulnerability(vulnerability.id, { switchTab: true }); });
      wrap.append(button);
    });
    nodes.push(detailSection(`论证结果（${confirmed.length} 个已验证漏洞）`, wrap));
  } else {
    const negatives = intent.candidate_negative_evidence || [];
    nodes.push(detailSection("论证结果", el("p", "",
      negatives.length
        ? "尚未形成已验证漏洞；下方为按相同目标匹配到的候选负向结论（同目标不等于该方向的结论）。"
        : "该方向尚未产生已验证漏洞。")));
  }
  const candidateNegatives = intent.candidate_negative_evidence || [];
  if (candidateNegatives.length) {
    const wrap = el("div", "detail-links");
    candidateNegatives.forEach(item => {
      wrap.append(chip(`${item.id || "负向"} · ${item.evidence_type || "未知类型"} · ${truncateText(item.reason || item.hypothesis || "", 90)}`, "info"));
    });
    nodes.push(detailSection(`候选负向结论（${candidateNegatives.length} 条 · 按 target 匹配）`, wrap));
  }
  const action = el("div", "detail-section");
  if (status.humanDismissed) {
    const restore = el("button", "button small secondary direction-restore", "恢复该方向");
    restore.type = "button";
    restore.dataset.directionId = intent.direction_id;
    restore.title = "重新评分不会自动恢复该方向；确认后它重新开放调度";
    action.append(restore);
  } else {
    const dismiss = el("button", "button small danger direction-dismiss", "人工否决");
    dismiss.type = "button";
    dismiss.dataset.directionId = intent.direction_id;
    dismiss.title = "停止该方向的后续调度；审计记录和理由仍保留";
    action.append(dismiss);
  }
  nodes.push(action);
  panel.replaceChildren(...nodes);
}
function renderHypotheses(project) {
  const hypotheses = project.hypotheses || [];
  const methodPack = project.method_pack || {};
  const planBatches = project.plan_batches || [];
  $("methodPackSummary").textContent = methodPack.name
    ? `已加载 ${methodPack.name} ${methodPack.version || ""}，${(methodPack.dimensions || []).length} 个攻击面维度 · ${hypotheses.length} 个假设 · ${planBatches.length} 个计划批次。`
    : "尚未加载项目方法包。每个假设都会经过价值、可达性、信息增益、新颖度、前置成熟度和成本评分。";
  renderRows($("hypothesesBody"), [...hypotheses].slice(0, 40), 7, item => {
    const row = document.createElement("tr");
    row.append(
      cell(item.statement || item.title), cell(item.target),
      cell(coverageLabels[item.dimension] || item.dimension),
      cell(percent(item.score ?? item.priority_score), "num"),
      cell(item.evidence_maturity || "假设"),
      cell(hypothesisStatusLabel(item.status)),
      cell(item.source || "方法包"),
    );
    return row;
  });
}

/* ---------- 运行诊断 ---------- */
function workerLabel(job) {
  const raw = String(job.member_name || "worker");
  const slotMatch = raw.match(/#(\d+)$/);
  const slot = slotMatch ? ` ${slotMatch[1]}` : "";
  return `${roleShort(job.role)}${slot}`;
}
function modelInfoForJob(job) {
  const member = job.payload?.member || {};
  return {
    model: job.model || member.model || job.result?.model || "默认模型",
    driver: job.driver || member.type || member.backend || job.backend || null,
  };
}
function activityForJob(job) {
  const intent = job.payload?.direction?.intent;
  if (intent) return { verb: intent.verb || "execute", target: intent.target || "未指定目标", success_criteria: intent.success_criteria || "", evidence_sink: intent.evidence_sink || "" };
  const defaults = {
    reason: ["分析黑板并生成审计方向", "产出可执行 Intent 或有证据的 Fact"],
    metacog: ["检查盲点、反例与高价值路径", "补充或修正当前审计方向"],
    reviewer: ["审查候选结果与证据质量", "决定接受、驳回或请求人工确认"],
    profile_mapper: ["遍历目标可点击功能并识别技术栈", "产出 URL、功能、技术栈画像"],
    waf_analyst: ["刻画 WAF 干扰分支", "产出等价差异验证 Intent"],
  };
  const fallback = defaults[job.role] || [`执行 ${job.role || "worker"} 角色任务`, "返回结构化候选结果"];
  return { verb: job.role || "worker", target: fallback[0], success_criteria: fallback[1], evidence_sink: "" };
}
function latestModelSignal(job, events) {
  const matching = [...events].reverse().filter(event => event.job_id === job.id);
  const progressTypes = ["model_tool_started", "model_tool_completed", "model_assistant_update", "model_stream_result"];
  if (["completed", "failed", "restricted", "cancelled"].includes(job.status)) return matching.find(event => ["model_call_completed", "model_call_failed", "model_policy_restricted"].includes(event.event_type)) || matching[0];
  if (job.status === "queued") return matching.find(event => ["model_retry_scheduled", "model_call_failed"].includes(event.event_type)) || matching[0];
  const startIndex = matching.findIndex(event => event.event_type === "model_call_started");
  const currentAttempt = startIndex < 0 ? matching : matching.slice(0, startIndex + 1);
  return currentAttempt.find(event => progressTypes.includes(event.event_type)) || currentAttempt.find(event => ["model_stream_started", "model_call_started", "model_call_waiting"].includes(event.event_type));
}
function jobSignalText(job, event) {
  const data = event?.data || {};
  if (event?.event_type === "model_tool_started") return `正在执行工具：${data.tool_name || "模型工具"} · ${truncateText(data.input_summary, 100)}`;
  if (event?.event_type === "model_tool_completed") return data.is_error ? `工具执行失败：${data.tool_name || "模型工具"}` : `工具已完成：${data.tool_name || "模型工具"}，等待下一步`;
  if (event?.event_type === "model_assistant_update") return `模型分析中：${truncateText(data.text, 100)}`;
  if (event?.event_type === "model_stream_result") return "模型已返回最终结果，正在持久化";
  if (event?.event_type === "model_stream_started") return "模型会话已建立，等待第一个工具动作";
  if (job.status === "running") return data.elapsed_seconds == null ? "等待模型返回" : `等待模型返回 · ${data.elapsed_seconds}s / ${data.timeout_seconds || "?"}s`;
  if (job.status === "queued") return job.attempts ? "等待下一次重试" : "等待 Worker 领取";
  if (job.status === "completed") return "模型结果已接收并持久化";
  if (job.status === "restricted") return "模型策略受限，未产生候选结果";
  if (job.status === "cancelled") return "任务已取消";
  if (job.status === "failed") return isModelPolicyRestriction(job) ? "模型策略受限" : "模型任务失败";
  return job.status || "等待状态更新";
}
function renderJobsPanel(automation) {
  const jobs = automation.jobs || [];
  const automationEvents = automation.events || [];
  preserveScroll($("jobsBody").closest(".table-wrap"), () => {
    renderRows($("jobsBody"), jobs, 8, job => {
      const row = document.createElement("tr");
      const model = modelInfoForJob(job);
      const modelCell = cell(model.model, "job-model");
      if (model.driver) modelCell.append(el("small", "", model.driver));
      const task = activityForJob(job);
      const taskCell = cell("", "job-task");
      taskCell.append(el("strong", "", `${verbLabel(task.verb)} · ${task.target}`));
      if (task.success_criteria) taskCell.append(el("small", "", `成功标准：${task.success_criteria}`));
      if (task.evidence_sink) taskCell.append(el("small", "", `证据输出：${task.evidence_sink}`));
      const signal = latestModelSignal(job, automationEvents);
      const activity = cell("", "job-activity");
      activity.append(el("strong", "", jobSignalText(job, signal)));
      activity.append(el("span", "", job.last_heartbeat_at ? `调度心跳 ${formatEventTime(job.last_heartbeat_at)}` : "尚未收到调度心跳"));
      if (job.error) {
        const errorNode = el("code", "", truncateText(job.error, 220));
        errorNode.title = String(job.error);
        activity.append(errorNode);
      }
      const visibleStatus = job.status === "failed" && isModelPolicyRestriction(job) ? "模型策略受限" : jobStatusLabel(job.status);
      row.append(
        cell(workerLabel(job)), cell(roleLabel(job.role)), modelCell, taskCell,
        cell(stageLabel(job.stage)), cell(visibleStatus, `job-status ${job.status || ""}`),
        cell(`${job.attempts ?? 0}/${job.max_attempts ?? "?"}`, "num"), activity,
      );
      return row;
    });
  });
}
async function openEvidence(path, { scroll = true } = {}) {
  const vendor = encodeURIComponent(state.vendor);
  const encodedPath = encodeURIComponent(path);
  const preview = $("evidencePreview");
  preview.textContent = "正在读取证据…";
  const result = await api(`/api/evidence/content?vendor=${vendor}&path=${encodedPath}`);
  preview.textContent = `${result.path}${result.truncated ? "（仅显示前 64 KiB）" : ""}\n\n${result.content}`;
  if (scroll) preview.scrollIntoView({ behavior: "smooth", block: "center" });
}
async function openPromptSnapshot(path) {
  const vendor = encodeURIComponent(state.vendor);
  const encodedPath = encodeURIComponent(path);
  const preview = $("promptSnapshotPreview");
  preview.textContent = "正在读取快照…";
  const result = await api(`/api/prompts/content?vendor=${vendor}&path=${encodedPath}`);
  preview.textContent = `${result.path}${result.truncated ? "（仅显示前 256 KiB）" : ""}\n\n${result.content}`;
  preview.scrollIntoView({ behavior: "smooth", block: "center" });
}
function renderDiagnostics(project, automation, auditResult, promptResult) {
  renderJobsPanel(automation);
  const events = [
    ...(automation.events || []).filter(event => event.event_type !== "model_agent_compose_log"),
    ...(auditResult.audit || []).map(item => ({ created_at: item.created_at, event_type: `api:${item.action}`, data: item.details })),
  ].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 50);
  $("eventsCountChip").textContent = `${events.length} 条`;
  preserveScroll($("eventsList"), () => {
    $("eventsList").replaceChildren();
    events.forEach(event => $("eventsList").append(renderEvent(event)));
    if (!events.length) $("eventsList").append(el("div", "empty-state", "暂无运行事件"));
  });
  const promptSnapshots = [...(promptResult?.snapshots || [])].reverse();
  renderRows($("promptSnapshotsBody"), promptSnapshots, 7, item => {
    const row = document.createElement("tr");
    const manifest = item.context_manifest || {};
    const omitted = Object.values(manifest.omitted_counts || {}).reduce((sum, value) => sum + Number(value || 0), 0);
    const action = cell("");
    const button = el("button", "button ghost small prompt-snapshot-open", "查看");
    button.type = "button";
    button.dataset.path = item.prompt_path;
    action.append(button);
    row.append(
      cell(formatEventTime(item.created_at)), cell(item.member), cell(roleLabel(item.role)),
      cell(`${Number(item.prompt_chars || 0).toLocaleString()} 字符`),
      cell(`${Number(manifest.rendered_context_chars || 0).toLocaleString()} / ${Number(manifest.budget_chars || 0).toLocaleString()}`),
      cell(omitted ? `${omitted} 条未注入` : "无"), action,
    );
    return row;
  });
  const counterfactualRows = (project.counterfactuals || []).map(item => ({ type: "反事实", target: item.target, content: item.claim, condition: item.falsification_criteria, status: hypothesisStatusLabel(item.status) }));
  const lessonRows = (project.lessons || []).map(item => ({ type: "经验", target: item.target, content: item.pattern, condition: (item.expiry_conditions || []).join("、") || item.valid_until || "人工解除", status: item.valid_until && new Date(item.valid_until).getTime() <= Date.now() ? "已失效" : "有效" }));
  const memoryRows = [...counterfactualRows, ...lessonRows].reverse().slice(0, 30);
  $("researchMemoryCountChip").textContent = `${counterfactualRows.length + lessonRows.length}`;
  renderRows($("researchMemoryBody"), memoryRows, 5, item => {
    const row = document.createElement("tr");
    row.append(cell(item.type), cell(item.target), cell(item.content), cell(item.condition), cell(item.status));
    return row;
  });
  const wafAssessments = project.waf_assessments || [];
  $("wafCountChip").textContent = `${wafAssessments.length}`;
  renderRows($("wafAssessmentsBody"), wafAssessments, 5, item => {
    const row = document.createElement("tr");
    row.append(cell(item.target), cell(item.original_hypothesis), cell(item.status), cell((item.signals || []).join("；") || "等待刻画"), cell(`${item.used_minutes ?? 0}/${item.budget_minutes ?? 12} min`, "num"));
    return row;
  });
  const negativeEvidence = project.negative_evidence || [];
  $("negativeCountChip").textContent = `${negativeEvidence.length}`;
  renderRows($("negativeEvidenceBody"), negativeEvidence, 5, item => {
    const row = document.createElement("tr");
    const validUntil = item.valid_until ? new Date(item.valid_until) : null;
    const active = !validUntil || validUntil.getTime() > Date.now();
    row.append(
      cell(item.target), cell(item.hypothesis), cell(item.reason),
      cell(validUntil && !Number.isNaN(validUntil.getTime()) ? validUntil.toLocaleString() : "未设置"),
      cell(active ? "有效期内剪枝" : "已失效，可重新验证"),
    );
    return row;
  });
  const indexed = state.derived?.indexedEvidence || [];
  $("evidenceCountChip").textContent = `${indexed.length}`;
  const indexedPaths = new Set(indexed.map(item => item.path));
  const pendingEvidence = (state.derived?.pendingFactRows || [])
    .map(fact => ({ fact_id: `候选 · ${fact.__member}`, path: fact.evidence_path, size_bytes: "待索引", sha256: "待提交" }))
    .filter(item => item.path && !indexedPaths.has(item.path));
  renderRows($("evidenceBody"), [...indexed, ...pendingEvidence], 5, item => {
    const row = document.createElement("tr");
    row.append(
      cell(item.fact_id), cell(item.path, "mono"),
      cell(item.pending ? String(item.size_bytes) : `${Number(item.size_bytes || 0).toLocaleString()} B`, "num"),
      cell(item.sha256, "mono"),
    );
    const action = cell("");
    if (!item.pending) {
      const button = el("button", "button ghost small evidence-open", "查看");
      button.type = "button";
      button.dataset.path = item.path;
      action.append(button);
    }
    row.append(action);
    return row;
  });
}

/* ---------- 设置：目标 / 团队 ---------- */
function renderTargetEditor(target, force = false) {
  if (state.targetDirty && !force && state.targetConfigVendor === state.vendor) return;
  state.targetConfig = structuredClone(target || {});
  state.targetConfigVendor = state.vendor;
  if (!state.targetDirty || force) state.targetDirty = false;
  $("targetTargets").value = (state.targetConfig.targets || []).join("\n");
  $("targetPath").value = state.targetConfig.target_path || "";
  $("targetProjectType").value = projectTypeOption(state.targetConfig.project_type);
  $("targetMreconEnabled").checked = state.targetConfig.mrecon?.enabled !== false;
  $("targetGoal").value = state.targetConfig.goal || "";
  $("targetOutOfScope").value = (state.targetConfig.out_of_scope || []).join("\n");
  $("targetSuccessCriteria").value = (state.targetConfig.success_criteria || []).join("\n");
  $("targetNotes").value = state.targetConfig.notes || "";
  $("saveTargetButton").disabled = !state.vendor && !state.newTaskMode;
  updateSaveBar();
  renderClientUpload();
}
function renderClientUpload() {
  const visible = projectTypeOption($("targetProjectType").value) === "客户端";
  $("clientUploadPanel").hidden = !visible;
  $("webTargetField").hidden = visible;
  $("localTargetPathField").hidden = visible;
  if (!visible) return;
  const file = $("clientArtifactFile").files?.[0];
  $("uploadClientArtifactButton").disabled = (!state.vendor && !state.newTaskMode) || !file;
  const artifact = state.targetConfig?.uploaded_artifact;
  $("clientUploadStatus").textContent = artifact
    ? `当前文件：${artifact.name} · ${Number(artifact.size || 0).toLocaleString()} bytes · SHA-256 ${String(artifact.sha256 || "").slice(0, 16)}…`
    : state.vendor || state.newTaskMode ? (file ? `待上传：${file.name} · ${file.size.toLocaleString()} bytes` : "请选择文件。单文件默认上限 2 GiB。") : "请先创建或选择项目，再上传文件。";
}
function lines(id) { return $(id).value.split(/\r?\n/).map(item => item.trim()).filter(Boolean); }
function collectTargetConfig() {
  const client = projectTypeOption($("targetProjectType").value) === "客户端";
  return {
    targets: client ? [] : lines("targetTargets"),
    target_path: client ? (state.targetConfig?.uploaded_artifact ? state.targetConfig.target_path || "" : "") : $("targetPath").value.trim(),
    project_type: $("targetProjectType").value.trim(),
    goal: $("targetGoal").value.trim(),
    out_of_scope: lines("targetOutOfScope"),
    success_criteria: lines("targetSuccessCriteria"),
    notes: $("targetNotes").value.trim(),
    mrecon: {
      enabled: !client && $("targetMreconEnabled").checked,
      max_pages: Number(state.targetConfig?.mrecon?.max_pages) || 300,
      timeout_seconds: Number(state.targetConfig?.mrecon?.timeout_seconds) || 20,
      delay_seconds: Number(state.targetConfig?.mrecon?.delay_seconds) || 0.1,
      browser_pages: Number(state.targetConfig?.mrecon?.browser_pages ?? 8),
      browser_clicks: Number(state.targetConfig?.mrecon?.browser_clicks ?? 10),
    },
  };
}
function updateSaveBar() {
  $("targetDirtyFlag").hidden = !state.targetDirty;
  $("teamDirtyFlag").hidden = !state.teamDirty;
  $("saveBarClean").hidden = state.targetDirty || state.teamDirty;
  updateBeforeUnload();
}
function beforeUnloadHandler(event) { event.preventDefault(); event.returnValue = ""; }
function updateBeforeUnload() {
  if (state.targetDirty || state.teamDirty) window.addEventListener("beforeunload", beforeUnloadHandler);
  else window.removeEventListener("beforeunload", beforeUnloadHandler);
}
function currentMember() {
  const members = state.teamConfig?.members || [];
  if (!members.length) return null;
  ui.memberIndex = Math.min(Math.max(ui.memberIndex, 0), members.length - 1);
  return members[ui.memberIndex];
}
function renderTeamEditor(config, force = false) {
  if (state.teamDirty && !force && state.configVendor === state.vendor) return;
  state.teamConfig = structuredClone(config || { name: "project", members: [] });
  state.configVendor = state.vendor;
  if (!state.teamDirty || force) state.teamDirty = false;
  renderMemberList();
  renderMemberPanel();
  renderTeamPresetControls();
  updateSaveBar();
}
function renderMemberList() {
  const list = $("memberList");
  const members = state.teamConfig?.members || [];
  list.replaceChildren();
  members.forEach((member, index) => {
    const item = el("button", `member-item${index === ui.memberIndex ? " active" : ""}`);
    item.type = "button";
    item.dataset.index = String(index);
    item.setAttribute("role", "option");
    const head = el("div", "member-item-head");
    head.append(el("strong", "", member.name || `成员 ${index + 1}`));
    const saved = Boolean(state.secretStatus[member.name] || member.__secret);
    head.append(el("span", `secret-dot${saved ? " saved" : ""}`));
    head.querySelector(".secret-dot").title = saved ? "密钥已保存" : "未保存密钥";
    item.append(head, el("small", "", `${roleLabel(member.role)} · ${member.type || "codex"} · ${member.runtime_mode || "local-docker"}`));
    list.append(item);
  });
  if (!members.length) list.append(el("div", "empty-state", "暂无角色。点击上方“添加角色”。"));
}
function renderMemberPanel() {
  const member = currentMember();
  const empty = !member;
  $("memberPanelEmpty").hidden = !empty;
  $("memberPanel").hidden = empty;
  if (empty) return;
  $("memberPanelTitle").textContent = member.name || "未命名角色";
  $("mName").value = member.name || "";
  $("mRole").value = member.role || "executor";
  $("mMaxRunning").value = member.max_running ?? 1;
  $("mPriority").value = member.priority ?? 0;
  $("mType").value = member.type || member.backend || "codex";
  $("mModel").value = member.model || "";
  $("mBaseUrl").value = member.base_url || "";
  $("mApiKeyEnv").value = member.api_key_env || "";
  $("mAuthMode").value = member.auth_mode || "auto";
  $("mRuntimeMode").value = member.runtime_mode || "local-docker";
  $("mSandbox").value = member.sandbox || "read-only";
  $("mSecret").value = member.__secret || "";
  $("mSecretStatus").textContent = state.secretStatus[member.name]
    ? "已安全保存密钥；留空表示保持不变。"
    : "密钥只提交不回显；留空表示保持不变。";
  $("mCustomPrompt").value = member.custom_prompt || "";
  $("mPromptCount").textContent = `${$("mCustomPrompt").value.length}/30000`;
  const extra = member.extra || {};
  $("mContainerImage").value = extra.image || "";
  $("mContainerCommand").value = member.__workerCommandDraft ?? (Array.isArray(extra.worker_command)
    ? extra.worker_command.join("\n")
    : (extra.worker_command || ""));
  clearMemberErrors();
  applyMemberFieldVisibility();
  if (member.__workerCommandError) setMemberError("eContainerCommand", "mContainerCommand", member.__workerCommandError);
}
function applyMemberFieldVisibility() {
  const type = $("mType").value;
  const ollama = type === "ollama";
  const container = type === "container";
  const claude = type === "claude-cli";
  const claudeRelay = claude && Boolean($("mBaseUrl").value.trim());
  if (ollama) $("mRuntimeMode").value = "local-cli";
  if (container) $("mRuntimeMode").value = "local-docker";
  $("mRuntimeMode").disabled = ollama || container;
  $("fModel").hidden = container;
  $("fBaseUrl").hidden = container;
  const needsKey = !container && !ollama && !(claude && !claudeRelay);
  $("fApiKeyEnv").hidden = !needsKey;
  $("fAuthMode").hidden = !claudeRelay;
  $("fSecret").hidden = !needsKey;
  $("mApiKeyEnv").placeholder = claudeRelay ? "ANTHROPIC_AUTH_TOKEN（一般留空，自动注入）" : "OPENAI_API_KEY";
  $("containerGroup").hidden = !container;
  const note = $("localCliNote");
  if (container) {
    note.textContent = "Container Worker 由本地 Docker 启动指定镜像，运行模式已锁定为本地 Docker。";
    note.hidden = false;
  } else if (ollama) {
    note.textContent = "Ollama 依赖本机已启动的 Ollama 服务，仅支持本地 CLI 模式，运行模式已锁定。";
    note.hidden = false;
  } else if ($("mRuntimeMode").value === "local-cli") {
    const localCliHints = {
      "codex": "本地 CLI 模式会直接调用宿主机上的 codex CLI，请确保它已安装并在启动 Sorne 服务的进程 PATH 中。",
      "claude-cli": claudeRelay
        ? "claude 中转站模式：请在下方填入会话 API Key（保存到系统钥匙串），自动注入子进程。"
        : "本机 Claude 登录态：直接使用 claude CLI 已登录的账号，无需配置任何密钥。",
      "openai-compatible": "openai-compatible 通过 HTTP 请求服务地址指向的模型 API，不依赖本地可执行文件。",
    };
    note.textContent = localCliHints[type] || `本地 CLI 模式会直接调用宿主机上的 ${type}，请确保它已安装并在启动 Sorne 服务的进程 PATH 中。`;
    note.hidden = false;
  } else {
    note.hidden = true;
  }
}
function clearMemberErrors() {
  ["eName", "eModel", "eBaseUrl", "eApiKeyEnv", "eContainerImage", "eContainerCommand"].forEach(id => { $(id).hidden = true; $(id).textContent = ""; });
  ["mName", "mModel", "mBaseUrl", "mApiKeyEnv", "mContainerImage", "mContainerCommand", "mRuntimeMode"].forEach(id => $(id).classList.remove("invalid"));
}
function setMemberError(errorId, controlId, message) {
  const error = $(errorId);
  error.textContent = message;
  error.hidden = false;
  $(controlId).classList.add("invalid");
}
function validateAllMembers() {
  const members = state.teamConfig?.members || [];
  for (let index = 0; index < members.length; index++) {
    const problems = validateMemberData(members[index], members);
    if (problems.length) return { index, problems };
  }
  return null;
}
function focusMemberValidation(offender) {
  ui.memberIndex = offender.index;
  renderMemberList();
  renderMemberPanel();
  validateMemberForm(currentMember());
  const memberName = state.teamConfig.members[offender.index].name || "未命名角色";
  return `角色 ${memberName} 配置有问题：${offender.problems.map(problem => problem.label).join("、")}`;
}
function requireValidTeamConfiguration() {
  const member = currentMember();
  if (member && !$("memberPanel").hidden) syncMemberFromForm(member);
  const offender = validateAllMembers();
  if (offender) throw new Error(focusMemberValidation(offender));
}
function validateMemberForm(member) {
  clearMemberErrors();
  const problems = validateMemberData(member, state.teamConfig?.members || []);
  problems.forEach(problem => {
    if (problem.errorId) setMemberError(problem.errorId, problem.controlId, problem.message);
    else $(problem.controlId).classList.add("invalid");
  });
  return problems;
}
function syncMemberFromForm(member) {
  member.name = $("mName").value.trim();
  member.role = $("mRole").value;
  member.max_running = Number($("mMaxRunning").value) || 1;
  member.priority = Number($("mPriority").value) || 0;
  member.type = $("mType").value;
  member.model = $("mModel").value.trim() || null;
  member.base_url = $("mBaseUrl").value.trim() || null;
  member.api_key_env = $("mApiKeyEnv").value.trim() || null;
  if (member.type === "claude-cli" && !member.base_url) member.api_key_env = null;
  member.auth_mode = $("mAuthMode").value;
  member.runtime_mode = $("mRuntimeMode").value;
  member.sandbox = $("mSandbox").value;
  member.custom_prompt = $("mCustomPrompt").value;
  member.__secret = $("mSecret").value.trim();
  if (member.type === "container") {
    const parsed = parseWorkerCommand($("mContainerCommand").value);
    const previousExtra = member.extra || {};
    if (parsed.error) {
      member.extra = { ...previousExtra, image: $("mContainerImage").value.trim(), worker_command: previousExtra.worker_command ?? [] };
      member.__workerCommandDraft = $("mContainerCommand").value;
      member.__workerCommandError = parsed.error;
    } else {
      member.extra = { ...previousExtra, image: $("mContainerImage").value.trim(), worker_command: parsed.value };
      member.__workerCommandDraft = null;
      member.__workerCommandError = null;
    }
  } else {
    member.__workerCommandDraft = null;
    member.__workerCommandError = null;
  }
}
function collectTeamConfig() {
  if (!state.teamConfig) return { name: "project", members: [] };
  const member = currentMember();
  if (member && $("memberPanel").hidden === false) syncMemberFromForm(member);
  const members = (state.teamConfig.members || []).map(original => {
    const cloned = normalizeMemberForSave(original);
    stripMemberTransientFields(cloned);
    cloned.max_running = Number(cloned.max_running) || 1;
    cloned.priority = Number(cloned.priority) || 0;
    ["model", "base_url", "api_key_env"].forEach(field => { cloned[field] = cloned[field] || null; });
    cloned.env = original.env || {};
    cloned.dangerously_bypass_sandbox = false;
    return cloned;
  });
  return { name: "project", members };
}
function collectRuntimeSecrets() {
  const secrets = {};
  (state.teamConfig?.members || []).forEach(member => {
    if (member.name && member.__secret) secrets[member.name] = member.__secret;
  });
  return secrets;
}

/* ---------- 主渲染 / 刷新 ---------- */
const projectActionIds = [
  "saveTargetButton", "uploadClientArtifactButton", "launchButton", "cancelButton",
  "importAssetInventoryButton", "hintButton", "addRoleButton", "saveTeamButton", "copyBoard", "removeMemberButton",
  "gateContinueButton", "gateStopButton", "submitFindingReview",
];
function setProjectControlsEnabled(enabled) {
  projectActionIds.forEach(id => { $(id).disabled = !enabled; });
  if (enabled) $("cancelButton").disabled = true;
}
function renderProject(project, metrics, automation, config, evidenceResult, auditResult, promptResult, assetResult) {
  state.projectData = project;
  state.metricsCache = metrics;
  state.automationCache = automation;
  state.auditCache = auditResult;
  state.promptCache = promptResult;
  const data = project.state;
  state.runId = automation.run?.id || null;
  state.runStatus = automation.run?.status || null;
  $("interventionScopeNote").textContent = automation.run && ["running", "paused"].includes(automation.run.status)
    ? `关联运行 ${automation.run.id}；从下一次 Worker 调度开始生效`
    : "当前没有活动 Run；内容会保留并在下一轮开始时生效";
  setProjectControlsEnabled(true);
  state.derived = buildDerived(project, automation, evidenceResult);
  const { vulnerabilities, riskLeads, directionRows, attackIntel, rawRiskLeads } = state.derived;
  renderRunStatus(data, automation, metrics);
  renderMetrics(project, data, metrics, automation);
  renderGateApproval(data, automation);
  renderRunFailure(automation);
  $("goalText").textContent = project.target.goal || `授权模式：${project.target.authorization_mode} · scope ${JSON.stringify(project.target.scope)}`;
  const committedVulns = vulnerabilities.filter(fact => !fact.__pending);
  const pendingVulns = vulnerabilities.length - committedVulns.length;
  $("vulnerabilitiesCount").textContent = pendingVulns ? `${committedVulns.length}+${pendingVulns}` : String(committedVulns.length);
  const confirmedLeadCount = riskLeads.filter(item => item.__confirmedVulnerabilities?.length).length;
  $("riskLeadsCount").textContent = String(riskLeads.length);
  $("leadsSummary").textContent = `已证实 ${confirmedLeadCount} · 候选 ${riskLeads.filter(item => item.__pending).length} · 原始 ${rawRiskLeads.length} 条（含去重合并）`;
  $("attackIntelCount").textContent = String(attackIntel.length);
  $("surfaceSummary").textContent = `已观察资产、配置、服务与入口${attackIntel.filter(fact => fact.__pending).length ? ` · ${attackIntel.filter(fact => fact.__pending).length} 条候选待收敛` : ""}；技术识别只属于攻击面，不会直接计为漏洞。`;
  renderVulnList(); renderVulnDetail();
  renderLeadList(); renderLeadDetail();
  renderSurfaceList(); renderSurfaceDetail();
  const provenDirectionCount = directionRows.filter(item => item.confirmed_vulnerabilities.length).length;
  $("directionsSummary").textContent = `${directionRows.length} 条方向 · ${provenDirectionCount} 条已证实产生漏洞`;
  renderDirectionList(); renderDirectionDetail();
  renderHypotheses(project);
  renderCoverage(data);
  renderRecentEvents(automation, auditResult);
  renderTechnologyProfile(project.enriched_target_profile || [], project.routine_target_groups || []);
  renderAssetInventory(assetResult);
  // 导航计数徽章
  const findingsTotal = committedVulns.length + riskLeads.length;
  $("navFindingsCount").textContent = String(findingsTotal);
  $("navFindingsCount").hidden = !findingsTotal;
  $("navDirectionsCount").textContent = String(directionRows.length);
  $("navDirectionsCount").hidden = !directionRows.length;
  // 人工质量账本
  const quality = project.quality_metrics || {};
  const globalQuality = project.global_quality_metrics || {};
  $("qualitySystemVulns").textContent = quality.system_vulnerabilities ?? committedVulns.length;
  $("qualityReviewed").textContent = quality.reviewed ?? 0;
  $("qualityConfirmed").textContent = quality.confirmed ?? 0;
  $("qualitySameRoot").textContent = quality.same_root ?? 0;
  $("qualityRefuted").textContent = quality.false_positives ?? 0;
  $("qualityFalsePositiveRate").textContent = percent(globalQuality.false_positive_rate);
  $("qualitySample").textContent = `长期样本 ${globalQuality.sample_size ?? 0} · ${globalQuality.sample_quality || "样本严重不足"}`;
  const suggestions = globalQuality.rule_suggestions || [];
  $("qualityRuleSuggestions").textContent = suggestions.length ? `发现 ${suggestions.length} 个重复误报模式，已生成规则候选；需历史回放并由人工批准后启用。` : "尚未形成重复误报规则建议。";
  $("submitFindingReview").disabled = !committedVulns.length || !ui.selected.vulns;
  renderDiagnostics(project, automation, auditResult, promptResult);
  renderTeamEditor(config);
  renderTargetEditor(project.target);
  $("blackboardText").textContent = project.blackboard || "黑板为空";
  applyRoute(state.route);
}
async function refresh() {
  if (!state.vendor) return;
  const requestedVendor = state.vendor;
  const generation = ++state.requestGeneration;
  try {
    const vendor = encodeURIComponent(requestedVendor);
    const [project, metricsResult, automation, configResult, evidenceResult, auditResult, promptResult, assetResult] = await Promise.all([
      api(`/api/project/state?vendor=${vendor}`),
      api(`/api/metrics?vendor=${vendor}`),
      api(`/api/automation/status?vendor=${vendor}`),
      api(`/api/config?vendor=${vendor}`),
      api(`/api/evidence?vendor=${vendor}`),
      api(`/api/audit?vendor=${vendor}`),
      api(`/api/prompts?vendor=${vendor}`),
      api(`/api/assets?vendor=${vendor}&limit=${state.assetPageSize}&offset=${state.assetOffset}`),
    ]);
    if (generation !== state.requestGeneration || requestedVendor !== state.vendor) return;
    state.secretStatus = configResult.secret_status || {};
    renderProject(project, metricsResult.metrics, automation, configResult.config, evidenceResult, auditResult, promptResult, assetResult);
    setConnectionStatus("实时同步", true);
  } catch (error) {
    if (generation !== state.requestGeneration || requestedVendor !== state.vendor) return;
    setConnectionStatus("连接异常", false);
    showToast(error.message, true);
  }
}
function telemetrySignature(automation) {
  const run = automation?.run || {};
  return JSON.stringify({
    run: [run.id, run.status, run.stage, run.wave, run.error],
    jobs: (automation?.jobs || []).map(job => [job.id, job.status, job.attempts, job.commit_state, job.committed_at, job.error]),
  });
}
async function refreshRunTelemetry() {
  if (!state.vendor || !state.projectData || !state.automationCache) { await refresh(); return; }
  const requestedVendor = state.vendor;
  const generation = ++state.requestGeneration;
  try {
    const vendor = encodeURIComponent(requestedVendor);
    const [automation, metricsResult] = await Promise.all([
      api(`/api/automation/status?vendor=${vendor}&compact=1`),
      api(`/api/metrics?vendor=${vendor}`),
    ]);
    if (generation !== state.requestGeneration || requestedVendor !== state.vendor) return;
    if (telemetrySignature(automation) !== telemetrySignature(state.automationCache)) { await refresh(); return; }
    state.automationCache = automation;
    state.metricsCache = metricsResult.metrics;
    state.runId = automation.run?.id || null;
    state.runStatus = automation.run?.status || null;
    renderRunStatus(state.projectData.state, automation, metricsResult.metrics);
    renderMetrics(state.projectData, state.projectData.state, metricsResult.metrics, automation);
    renderGateApproval(state.projectData.state, automation);
    renderRunFailure(automation);
    renderDiagnostics(state.projectData, automation, state.auditCache || { audit: [] }, state.promptCache || { snapshots: [] });
    setConnectionStatus("实时同步", true);
  } catch (error) {
    if (generation !== state.requestGeneration || requestedVendor !== state.vendor) return;
    setConnectionStatus("连接异常", false);
    showToast(error.message, true);
  }
}

/* ---------- 空工作区 / 新建任务 ---------- */
function renderEmptyWorkspace() {
  state.vendor = null; state.runId = null; state.runStatus = null;
  state.teamConfig = null; state.configVendor = null; state.teamDirty = false;
  state.targetConfig = null; state.targetConfigVendor = null; state.targetDirty = false;
  state.secretStatus = {}; state.gateContext = null; state.gateSubmitting = false; state.derived = null;
  state.projectData = null; state.automationCache = null; state.auditCache = null; state.promptCache = null;
  state.assetInventory = null;
  setProjectControlsEnabled(false);
  $("projectSelect").disabled = true;
  renderAssetInventory(null);
  $("currentTask").textContent = "尚未初始化项目";
  $("goalText").textContent = "请先填写目标并创建项目";
  $("gateApprovalCard").hidden = true;
  $("gateApprovalNote").value = "";
  setBadge($("gateBadge"), "idle"); setBadge($("runBadge"), "idle");
  $("runSummary").textContent = "暂无自动化运行";
  $("runProgressBar").style.width = "0%";
  $("runProgressText").textContent = "暂无 Job";
  $("runFailure").hidden = true; $("runFailure").replaceChildren();
  ["assetMetric", "factMetric", "vulnMetric"].forEach(id => { $(id).textContent = "0"; });
  $("coverageMetric").textContent = "0%";
  ["vulnList", "leadList", "directionList", "surfaceList", "coverageList", "recentEvents"].forEach(id => $(id).replaceChildren());
  ["vulnDetailInfo", "leadDetail", "directionDetail", "surfaceDetail"].forEach(id => $(id).replaceChildren(el("div", "empty-state", "请先创建项目。")));
  $("reviewBox").hidden = true;
  emptyRow($("hypothesesBody"), 7); emptyRow($("jobsBody"), 8); emptyRow($("promptSnapshotsBody"), 7);
  emptyRow($("researchMemoryBody"), 5); emptyRow($("wafAssessmentsBody"), 5); emptyRow($("negativeEvidenceBody"), 5); emptyRow($("evidenceBody"), 5);
  $("eventsList").replaceChildren(el("div", "empty-state", "暂无运行事件"));
  ["qualitySystemVulns", "qualityReviewed", "qualityConfirmed", "qualitySameRoot", "qualityRefuted"].forEach(id => { $(id).textContent = "0"; });
  $("qualityFalsePositiveRate").textContent = "—";
  $("evidencePreview").textContent = "选择一份证据查看内容";
  $("promptSnapshotPreview").textContent = "选择一次模型调用查看实际上下文";
  $("memberList").replaceChildren();
  renderMemberPanel();
  $("blackboardText").textContent = "请先创建项目";
  renderTargetEditor({ targets: [], out_of_scope: [], success_criteria: [] }, true);
  updateSaveBar();
  setConnectionStatus("实时同步", true);
}
function prepareNewTask() {
  ++state.requestGeneration;
  state.vendor = null; state.newTaskMode = true;
  state.runId = null; state.runStatus = null;
  state.teamConfig = null; state.configVendor = null; state.teamDirty = false;
  state.targetConfigVendor = null; state.targetDirty = false;
  state.secretStatus = {}; state.gateContext = null; state.gateSubmitting = false; state.derived = null;
  state.projectData = null; state.automationCache = null; state.auditCache = null; state.promptCache = null;
  $("gateApprovalCard").hidden = true;
  $("gateApprovalNote").value = "";
  renderTargetEditor({ targets: [], out_of_scope: [], success_criteria: [] }, true);
  $("newProjectName").value = "";
  $("memberList").replaceChildren();
  renderMemberPanel();
  $("blackboardText").textContent = "项目创建后将自动初始化双层黑板";
  setProjectControlsEnabled(false);
  $("createProjectButton").disabled = false;
  renderTeamPresetControls();
  updateSaveBar();
}

/* ---------- 动作 ---------- */
async function persistPendingConfiguration() {
  if (state.targetDirty) {
    const result = await api("/api/target", { method: "POST", body: JSON.stringify({ vendor: state.vendor, target: collectTargetConfig() }) });
    state.targetDirty = false;
    renderTargetEditor(result.target, true);
  }
  if (state.teamDirty) {
    requireValidTeamConfiguration();
    const config = collectTeamConfig();
    const secrets = collectRuntimeSecrets();
    const result = await api("/api/config", { method: "POST", body: JSON.stringify({ vendor: state.vendor, config, secrets }) });
    state.secretStatus = result.secret_status || state.secretStatus;
    (state.teamConfig?.members || []).forEach(member => stripMemberTransientFields(member));
    state.teamConfig = structuredClone(result.config || config);
    state.teamDirty = false;
    renderTeamEditor(state.teamConfig, true);
  }
  updateSaveBar();
}
async function launchAudit() {
  if (!state.vendor) return showToast("请先创建或选择项目", true);
  if (!state.teamConfig) return showToast("项目配置尚未加载完成", true);
  if (projectTypeOption(state.targetConfig?.project_type) === "客户端" && !state.targetConfig?.uploaded_artifact) return showToast("客户端项目必须先上传测试文件", true);
  const confirmed = window.confirm(`即将保存当前配置，并把 ${state.vendor} 的目标信息、黑板上下文及相关源码片段发送给团队配置中的真实模型服务。\n\n确认启动并发审计吗？`);
  if (!confirmed) return;
  $("launchButton").disabled = true;
  $("launchButton").classList.add("busy");
  try {
    await persistPendingConfiguration();
    const result = await api("/api/automation/launch", {
      method: "POST",
      body: JSON.stringify({ vendor: state.vendor, team: $("teamInput").value.trim() || "default", max_workers: Number($("workersInput").value), timeout: Number($("timeoutInput").value) }),
    });
    state.runId = result.run_id;
    state.runStatus = "running";
    showToast(`运行 ${result.run_id} 已启动`);
    await refresh();
    navigate("overview");
  } catch (error) { showToast(error.message, true); }
  finally { $("launchButton").classList.remove("busy"); applyRoute(state.route); }
}
function objectiveGateReason(action, context) {
  const data = context.data || {};
  const note = $("gateApprovalNote").value.trim();
  const decision = action === "continue" ? "批准继续" : "批准止损结束";
  const objective = `${decision}；阶段 ${phaseLabel(data.phase)}，已用 ${data.elapsed_minutes ?? 0} min，资产 ${data.asset_count ?? 0} 个，漏洞 ${data.vulnerability_count ?? 0} 个，敏感线索 ${data.high_risk_fingerprint_count ?? 0} 个。`;
  return note ? `${objective} 人工备注：${note}` : objective;
}
async function submitGateDecision(action) {
  const context = state.gateContext;
  if (!state.vendor || !context?.visible) return showToast("当前没有待批准的强制门禁", true);
  if (action === "stop_loss" && !window.confirm("确认止损结束？对应自动化运行会被终止，未完成任务不会继续。")) return;
  state.gateSubmitting = true;
  const continueButton = $("gateContinueButton");
  const stopButton = $("gateStopButton");
  continueButton.disabled = true;
  stopButton.disabled = true;
  const activeButton = action === "continue" ? continueButton : stopButton;
  const originalText = activeButton.textContent;
  activeButton.textContent = action === "continue" ? "正在批准并恢复…" : "正在止损并结束…";
  activeButton.classList.add("busy");
  try {
    const result = await api("/api/gate/approve", {
      method: "POST",
      body: JSON.stringify({ vendor: state.vendor, action, reason: objectiveGateReason(action, context), run_id: context.run?.id || "" }),
    });
    $("gateApprovalNote").value = "";
    if (result.run_id) state.runId = result.run_id;
    if (result.transition === "started_next_iteration" || result.resumed) state.runStatus = "running";
    else if (result.cancelled) state.runStatus = "cancelled";
    if (result.transition === "started_next_iteration") showToast(`门禁已批准，下一轮 ${result.run_id} 已启动`);
    else if (result.resumed) showToast(`门禁已批准，运行 ${result.run_id} 已恢复`);
    else if (result.cancelled) showToast(`止损已批准，运行 ${result.run_id} 已结束`);
    else showToast(action === "continue" ? "门禁已批准，可以继续执行" : "止损决定已提交");
    await refresh();
  } catch (error) { showToast(error.message, true); }
  finally {
    state.gateSubmitting = false;
    activeButton.textContent = originalText;
    activeButton.classList.remove("busy");
    if (state.gateContext?.visible) { continueButton.disabled = false; stopButton.disabled = false; }
  }
}
async function uploadClientFile(vendor, file, projectType = "客户端") {
  const query = new URLSearchParams({ vendor, filename: file.name, project_type: projectType });
  const response = await fetch(`/api/target/upload?${query}`, { method: "POST", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file });
  const raw = await response.text();
  let payload;
  try { payload = raw ? JSON.parse(raw) : {}; } catch (_error) { throw new Error(`HTTP ${response.status}：上传接口返回非 JSON 响应`); }
  if (!response.ok || !payload.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}
async function deleteProject(vendor) {
  if (!vendor) return showToast("当前没有可删除的项目", true);
  const confirmation = window.prompt(`删除项目会永久移除目标、配置、黑板、证据和运行记录。\n\n请输入项目名“${vendor}”确认删除：`);
  if (confirmation === null) return;
  if (confirmation !== vendor) return showToast("项目名不匹配，已取消删除", true);
  if (!window.confirm(`最后确认：永久删除项目“${vendor}”？此操作不可恢复。`)) return;
  ++state.requestGeneration;
  try {
    await api("/api/projects/delete", { method: "POST", body: JSON.stringify({ vendor, confirmation }) });
    state.vendor = null; state.newTaskMode = false;
    state.teamDirty = false; state.targetDirty = false;
    state.secretStatus = {}; state.runId = null; state.runStatus = null;
    await loadProjects();
    navigate("projects", { replace: true });
    if (!state.vendor) renderEmptyWorkspace();
    renderProjectList();
    applyRoute("projects");
    showToast(`项目 ${vendor} 已删除${state.vendor ? `，已选择 ${state.vendor}` : "，现在可以创建新任务"}`);
  } catch (error) {
    showToast(error.message, true);
    await loadProjects(vendor);
    applyRoute("projects");
  }
}

/* ---------- 标签切换 ---------- */
function selectTab(tab) {
  ui.tab = tab;
  document.querySelectorAll(".tab-btn").forEach(node => node.classList.toggle("active", node.dataset.tab === tab));
  document.querySelectorAll("[data-tab-panel]").forEach(node => { node.hidden = node.dataset.tabPanel !== tab; });
}

/* ---------- 事件绑定 ---------- */
document.querySelectorAll("[data-icon]").forEach(node => { node.innerHTML = ICONS[node.dataset.icon] || ""; });
$("refreshButton").addEventListener("click", refresh);
$("newTaskButton").addEventListener("click", async () => {
  if (!canLeaveSettings()) return;
  prepareNewTask();
  navigate("settings");
});
$("projectSelect").addEventListener("change", async event => {
  if (selectVendor(event.target.value)) { navigate("overview", { replace: true }); await refresh(); }
});
document.querySelectorAll("[data-route-link]").forEach(link => link.addEventListener("click", event => {
  event.preventDefault();
  requestRoute(link.dataset.routeLink);
}));
window.addEventListener("hashchange", async () => {
  const route = routeFromLocation();
  const requestedVendor = new URLSearchParams(location.search).get("vendor");
  if (state.route === "settings" && route !== "settings" && !canLeaveSettings()) { navigate("settings", { replace: true }); return; }
  if (route === "settings" && !requestedVendor && !state.vendor) { prepareNewTask(); applyRoute("settings"); return; }
  if (requestedVendor && requestedVendor !== state.vendor) {
    if (!selectVendor(requestedVendor)) { navigate("projects", { replace: true }); return; }
  }
  applyRoute(route);
  if (route !== "projects" && state.vendor && !state.projectData) await refresh();
});
// 项目中心表格
$("projectList").addEventListener("click", async event => {
  const deleteButton = event.target.closest(".project-delete");
  if (deleteButton) { await deleteProject(deleteButton.dataset.vendor); return; }
  const openButton = event.target.closest(".project-open");
  if (openButton) {
    const route = openButton.dataset.route || "overview";
    if (!selectVendor(openButton.dataset.vendor)) return;
    navigate(route);
    await refresh();
    return;
  }
  const row = event.target.closest("tr[data-vendor]");
  if (row) await openProject(row.dataset.vendor);
});
// 发现页标签
document.querySelector(".tab-bar").addEventListener("click", event => {
  const tab = event.target.closest(".tab-btn");
  if (tab) selectTab(tab.dataset.tab);
});
// 证据与 Prompt 预览（事件委托）
document.addEventListener("click", async event => {
  const evidenceButton = event.target.closest(".evidence-open");
  if (evidenceButton) {
    try { await openEvidence(evidenceButton.dataset.path); } catch (error) { showToast(error.message, true); }
    return;
  }
  const promptButton = event.target.closest(".prompt-snapshot-open");
  if (promptButton) {
    try { await openPromptSnapshot(promptButton.dataset.path); } catch (error) { showToast(error.message, true); }
  }
});
$("expandTechnologyHosts").addEventListener("click", () => {
  document.querySelectorAll(".technology-host-group").forEach(group => { group.open = true; ui.expandedTechnologyHosts.add(group.dataset.hostname); });
});
$("collapseTechnologyHosts").addEventListener("click", () => {
  document.querySelectorAll(".technology-host-group").forEach(group => { group.open = false; ui.expandedTechnologyHosts.delete(group.dataset.hostname); });
});
$("downloadTechnologyXlsx").addEventListener("click", downloadTechnologyWorkbook);
$("downloadTechnologyCsv").addEventListener("click", () => downloadTechnologyProfile("csv"));
$("downloadTechnologyJson").addEventListener("click", () => downloadTechnologyProfile("json"));
// 运行控制与门禁
$("cancelButton").addEventListener("click", async () => {
  if (state.runId) await post("/api/automation/cancel", { run_id: state.runId, reason: "用户从 Web 控制台取消" }, () => "运行已取消");
});
$("launchButton").addEventListener("click", launchAudit);
$("gateContinueButton").addEventListener("click", () => submitGateDecision("continue"));
$("gateStopButton").addEventListener("click", () => submitGateDecision("stop_loss"));
$("hintButton").addEventListener("click", async () => {
  const content = $("hintContent").value.trim();
  if (!content) return showToast("请填写项目所有者指令", true);
  await post("/api/hints", {
    content,
    target: $("hintTarget").value.trim() || null,
    priority: Number($("hintPriority").value),
    intervention_type: $("interventionType").value,
    run_id: state.runId || "",
    scope: "project",
  }, () => "最高优先级指令已写入；旧上下文结果将被拦截");
  $("hintContent").value = "";
});
// 方向人工否决/恢复
$("directionDetail").addEventListener("click", async event => {
  const dismissButton = event.target.closest(".direction-dismiss");
  if (dismissButton && !dismissButton.disabled) {
    const reason = window.prompt("请输入删除这个方向的理由。该方向会立即停止调度，但审计记录仍会保留：");
    if (reason === null) return;
    if (!reason.trim()) return showToast("必须填写删除理由", true);
    if (!window.confirm("确认人工否决并停止这个方向？")) return;
    await post("/api/directions/dismiss", { direction_id: dismissButton.dataset.directionId, reason: reason.trim() }, () => "方向已人工否决，不会再参与调度");
    return;
  }
  const restoreButton = event.target.closest(".direction-restore");
  if (!restoreButton) return;
  const restoreReason = window.prompt("请输入恢复这个方向的理由。恢复后它重新开放调度并可被认领；模型重评本身不能撤销人工否决：");
  if (restoreReason === null) return;
  if (!restoreReason.trim()) return showToast("必须填写恢复理由", true);
  if (!window.confirm("确认恢复该方向并允许重新排队？")) return;
  await post("/api/directions/restore", { direction_id: restoreButton.dataset.directionId, reason: restoreReason.trim() }, () => "方向已恢复，重新开放调度");
});
// 人工漏洞裁决
$("reviewAction").addEventListener("change", event => {
  const action = event.target.value;
  if (["accepted", "adjusted"].includes(action)) $("reviewClassification").value = "vulnerability";
  else if (action === "same_root") $("reviewClassification").value = "same_root_vulnerability";
  else if (action === "refuted") $("reviewClassification").value = "inconclusive";
  else if (action === "reclassified") $("reviewClassification").value = "risk_lead";
  else if (action === "retest_requested") $("reviewClassification").value = "inconclusive";
  syncDuplicateReviewOptions();
});
$("submitFindingReview").addEventListener("click", async () => {
  const findingId = ui.selected.vulns;
  const reason = $("reviewReason").value.trim();
  if (!findingId) return showToast("请先在左侧选择系统漏洞", true);
  if (!reason) return showToast("请填写人工判断或驳斥理由", true);
  const duplicateOf = $("reviewAction").value === "same_root" ? $("reviewDuplicateOf").value : null;
  if ($("reviewAction").value === "same_root" && !duplicateOf) return showToast("请选择同源主漏洞", true);
  const reasonCodes = $("reviewReasonCodes").value.split(",").map(item => item.trim()).filter(Boolean);
  const button = $("submitFindingReview");
  button.classList.add("busy");
  try {
    await post("/api/findings/review", {
      finding_id: findingId,
      action: $("reviewAction").value,
      final_classification: $("reviewClassification").value,
      final_severity: $("reviewSeverity").value,
      duplicate_of_finding_id: duplicateOf,
      reason,
      reason_codes: reasonCodes,
      applicable_scope: $("reviewScope").value,
    }, result => `人工结论已保存，长期误报率 ${percent(result.global_quality_metrics.false_positive_rate)}`);
    $("reviewReason").value = "";
    $("reviewReasonCodes").value = "";
  } finally { button.classList.remove("busy"); }
});
// 团队编辑器
$("memberList").addEventListener("click", event => {
  const item = event.target.closest(".member-item");
  if (!item) return;
  const current = currentMember();
  if (current && !$("memberPanel").hidden) syncMemberFromForm(current);
  ui.memberIndex = Number(item.dataset.index) || 0;
  renderMemberList();
  renderMemberPanel();
});
$("memberPanel").addEventListener("input", event => {
  const member = currentMember();
  if (!member) return;
  syncMemberFromForm(member);
  state.teamDirty = true;
  if (event.target.id === "mName") { $("memberPanelTitle").textContent = member.name || "未命名角色"; renderMemberList(); }
  if (event.target.id === "mCustomPrompt") $("mPromptCount").textContent = `${$("mCustomPrompt").value.length}/30000`;
  if (event.target.id === "mBaseUrl" && $("mType").value === "claude-cli") applyMemberFieldVisibility();
  if (["mName", "mModel", "mBaseUrl", "mApiKeyEnv", "mContainerImage", "mContainerCommand"].includes(event.target.id)) {
    event.target.classList.remove("invalid");
    const errorMap = { mName: "eName", mModel: "eModel", mBaseUrl: "eBaseUrl", mApiKeyEnv: "eApiKeyEnv", mContainerImage: "eContainerImage", mContainerCommand: "eContainerCommand" };
    $(errorMap[event.target.id]).hidden = true;
  }
  updateSaveBar();
});
$("memberPanel").addEventListener("change", event => {
  if (!["mRole", "mType", "mRuntimeMode"].includes(event.target.id)) return;
  const member = currentMember();
  if (!member) return;
  if (event.target.id === "mType" && event.target.value === "ollama") showToast("Ollama 仅支持本地 CLI 模式，运行模式已自动切换为本地 CLI。");
  if (event.target.id === "mType" && event.target.value === "container") showToast("Container Worker 仅支持本地 Docker 模式，运行模式已锁定。");
  if (event.target.id === "mRuntimeMode" && $("mType").value === "ollama" && event.target.value !== "local-cli") {
    event.target.value = "local-cli";
    showToast("Ollama 不能在容器运行模式下运行，已保持本地 CLI。");
  }
  if (event.target.id === "mRuntimeMode" && $("mType").value === "container" && event.target.value !== "local-docker") {
    event.target.value = "local-docker";
    showToast("Container Worker 仅支持本地 Docker 模式，已保持本地 Docker。");
  }
  syncMemberFromForm(member);
  state.teamDirty = true;
  applyMemberFieldVisibility();
  renderMemberList();
  updateSaveBar();
});
// 团队预设
$("teamPresetSelect").addEventListener("change", event => {
  state.selectedTeamPresetId = event.target.value || null;
  renderTeamPresetControls(state.selectedTeamPresetId);
});
$("applyTeamPresetButton").addEventListener("click", async () => {
  const preset = selectedTeamPreset();
  if (!state.vendor || !preset) return showToast("请先选择项目和团队预设", true);
  const current = collectTeamConfig();
  const diff = summarizeTeamPresetDiff(current, preset.config);
  if (!window.confirm(`将预设“${preset.name}”应用到项目 ${state.vendor}？\n\n${diff}\n\n项目配置会保存为独立快照，后续修改预设不会影响该项目。`)) return;
  const result = await api("/api/team-presets/apply", { method: "POST", body: JSON.stringify({ vendor: state.vendor, preset_id: preset.id }) });
  state.secretStatus = result.secret_status || {};
  state.teamDirty = false;
  renderTeamEditor(result.config, true);
  showToast(`已应用预设“${preset.name}”，项目团队快照已保存`);
});
$("saveAsTeamPresetButton").addEventListener("click", async () => {
  if (!state.vendor || !state.teamConfig) return showToast("请先创建并加载项目", true);
  try { requireValidTeamConfiguration(); } catch (error) { return showToast(error.message, true); }
  const name = window.prompt("请输入新团队预设名称：");
  if (name === null) return;
  if (!name.trim()) return showToast("预设名称不能为空", true);
  const result = await api("/api/team-presets/save", {
    method: "POST",
    body: JSON.stringify({ vendor: state.vendor, name: name.trim(), config: collectTeamConfig(), secrets: collectRuntimeSecrets() }),
  });
  updateTeamPresetState(result, result.preset.id);
  showToast(`已创建个人团队预设“${result.preset.name}”`);
});
$("updateTeamPresetButton").addEventListener("click", async () => {
  const preset = selectedTeamPreset();
  if (!state.vendor || !preset) return showToast("请先选择要更新的预设", true);
  try { requireValidTeamConfiguration(); } catch (error) { return showToast(error.message, true); }
  if (!window.confirm(`用当前项目团队覆盖预设“${preset.name}”？\n\n${summarizeTeamPresetDiff(preset.config, collectTeamConfig())}`)) return;
  const result = await api("/api/team-presets/save", {
    method: "POST",
    body: JSON.stringify({ vendor: state.vendor, preset_id: preset.id, name: preset.name, config: collectTeamConfig(), secrets: collectRuntimeSecrets() }),
  });
  updateTeamPresetState(result, preset.id);
  showToast(`预设“${preset.name}”已更新`);
});
$("defaultTeamPresetButton").addEventListener("click", async () => {
  const preset = selectedTeamPreset();
  if (!preset) return;
  const nextDefault = preset.is_default ? null : preset.id;
  const result = await api("/api/team-presets/default", { method: "POST", body: JSON.stringify({ preset_id: nextDefault }) });
  updateTeamPresetState(result, preset.id);
  showToast(nextDefault ? `“${preset.name}”已设为新项目默认预设` : "已取消个人默认预设");
});
$("duplicateTeamPresetButton").addEventListener("click", async () => {
  const preset = selectedTeamPreset();
  if (!preset) return;
  const name = window.prompt("请输入复制后的预设名称：", `${preset.name} 副本`);
  if (name === null) return;
  if (!name.trim()) return showToast("预设名称不能为空", true);
  const result = await api("/api/team-presets/duplicate", { method: "POST", body: JSON.stringify({ preset_id: preset.id, name: name.trim() }) });
  updateTeamPresetState(result, result.preset.id);
  showToast(`已复制为“${result.preset.name}”`);
});
$("renameTeamPresetButton").addEventListener("click", async () => {
  const preset = selectedTeamPreset();
  if (!preset) return;
  const name = window.prompt("请输入新的预设名称：", preset.name);
  if (name === null || name.trim() === preset.name) return;
  if (!name.trim()) return showToast("预设名称不能为空", true);
  const result = await api("/api/team-presets/rename", { method: "POST", body: JSON.stringify({ preset_id: preset.id, name: name.trim() }) });
  updateTeamPresetState(result, preset.id);
  showToast(`预设已重命名为“${name.trim()}”`);
});
$("deleteTeamPresetButton").addEventListener("click", async () => {
  const preset = selectedTeamPreset();
  if (!preset) return;
  if (!window.confirm(`确认删除个人预设“${preset.name}”？\n\n已应用到项目的团队快照不会受影响；该预设专属的钥匙串密钥别名会一并清除。`)) return;
  const result = await api("/api/team-presets/delete", { method: "POST", body: JSON.stringify({ preset_id: preset.id }) });
  updateTeamPresetState(result);
  showToast(`预设“${preset.name}”已删除`);
});
$("addRoleButton").addEventListener("click", () => {
  if (!state.teamConfig?.members) return showToast("请先创建并加载项目", true);
  const current = currentMember();
  if (current && !$("memberPanel").hidden) syncMemberFromForm(current);
  state.teamConfig.members.push({
    name: `worker-${state.teamConfig.members.length + 1}`, role: "executor", runtime_mode: "local-docker",
    custom_prompt: null, type: "codex", model: null, base_url: null, api_key_env: "OPENAI_API_KEY",
    auth_mode: "auto", sandbox: "workspace-write", max_running: 1, priority: 1, env: {},
    dangerously_bypass_sandbox: false,
  });
  ui.memberIndex = state.teamConfig.members.length - 1;
  state.teamDirty = true;
  renderMemberList();
  renderMemberPanel();
  updateSaveBar();
});
$("removeMemberButton").addEventListener("click", () => {
  const members = state.teamConfig?.members;
  if (!members?.length) return;
  members.splice(ui.memberIndex, 1);
  ui.memberIndex = Math.max(0, ui.memberIndex - 1);
  state.teamDirty = true;
  renderMemberList();
  renderMemberPanel();
  updateSaveBar();
});
$("saveTeamButton").addEventListener("click", async () => {
  if (!state.vendor || !state.teamConfig) return showToast("请先创建并加载项目", true);
  try { requireValidTeamConfiguration(); } catch (error) { return showToast(error.message, true); }
  const config = collectTeamConfig();
  const secrets = collectRuntimeSecrets();
  const result = await post("/api/config", { config, secrets }, () => "角色配置已保存，API Key 已安全写入系统钥匙串");
  state.secretStatus = result.secret_status || state.secretStatus;
  (state.teamConfig?.members || []).forEach(item => stripMemberTransientFields(item));
  state.teamConfig = structuredClone(result.config || config);
  state.teamDirty = false;
  renderTeamEditor(state.teamConfig, true);
  updateSaveBar();
});
// 目标配置
$("view-settings").addEventListener("input", event => {
  if (event.target.id === "newProjectName") return;
  if (event.target.closest(".team-editor")) return;
  if (event.target.closest(".asset-import-bar")) return;
  state.targetDirty = true;
  updateSaveBar();
});
$("targetProjectType").addEventListener("change", renderClientUpload);
$("clientArtifactFile").addEventListener("change", renderClientUpload);
$("importAssetInventoryButton").addEventListener("click", () => uploadAssetInventoryFile(refresh));
$("assetPreviousPage").addEventListener("click", async () => {
  state.assetOffset = Math.max(0, state.assetOffset - state.assetPageSize);
  await refresh();
});
$("assetNextPage").addEventListener("click", async () => {
  const next = state.assetInventory?.pagination?.next_offset;
  if (next == null) return;
  state.assetOffset = Number(next);
  await refresh();
});
$("uploadClientArtifactButton").addEventListener("click", async () => {
  if (!state.vendor && !state.newTaskMode) return showToast("请先创建或选择客户端项目", true);
  const file = $("clientArtifactFile").files?.[0];
  if (!file) return showToast("请选择要上传的客户端文件", true);
  const button = $("uploadClientArtifactButton");
  button.disabled = true;
  button.classList.add("busy");
  $("clientUploadStatus").textContent = `正在上传 ${file.name}…`;
  try {
    const payload = await uploadClientFile(state.vendor, file, $("targetProjectType").value);
    state.targetDirty = false;
    state.targetConfig = structuredClone(payload.target);
    $("clientArtifactFile").value = "";
    renderTargetEditor(payload.target, true);
    showToast(`客户端文件已上传：${payload.artifact.name}`);
  } catch (error) { showToast(error.message, true); renderClientUpload(); }
  finally { button.classList.remove("busy"); updateSaveBar(); }
});
$("saveTargetButton").addEventListener("click", async () => {
  if (!state.vendor) return showToast("请先创建项目", true);
  const target = collectTargetConfig();
  const result = await post("/api/target", { target }, () => "渗透目标已保存并同步到中央黑板上下文");
  state.targetDirty = false;
  renderTargetEditor(result.target, true);
  updateSaveBar();
});
$("createProjectButton").addEventListener("click", async () => {
  const vendor = $("newProjectName").value.trim();
  if (!vendor) return showToast("请填写新项目名称", true);
  const client = projectTypeOption($("targetProjectType").value) === "客户端";
  const file = $("clientArtifactFile").files?.[0];
  if (client && !file) return showToast("客户端项目必须选择一个测试文件", true);
  $("createProjectButton").disabled = true;
  $("createProjectButton").classList.add("busy");
  let createdVendor = null;
  try {
    const result = await api("/api/projects", {
      method: "POST",
      body: JSON.stringify({ vendor, target: collectTargetConfig(), preset_id: $("newProjectPreset").value }),
    });
    createdVendor = result.vendor;
    if (client) {
      $("clientUploadStatus").textContent = `项目已创建，正在上传 ${file.name}…`;
      await uploadClientFile(result.vendor, file, $("targetProjectType").value);
    }
    ++state.requestGeneration;
    state.newTaskMode = false;
    state.targetDirty = false;
    state.teamDirty = false;
    await loadProjects(result.vendor);
    $("newProjectName").value = "";
    navigate("settings", { replace: true });
    await refresh();
    showToast(`项目 ${result.vendor} 已创建，目标配置已生效`);
  } catch (error) {
    showToast(error.message, true);
    if (createdVendor) {
      await loadProjects(createdVendor);
      navigate("settings", { replace: true });
      await refresh();
    }
  } finally { $("createProjectButton").disabled = false; $("createProjectButton").classList.remove("busy"); }
});
$("copyBoard").addEventListener("click", async () => {
  await navigator.clipboard.writeText($("blackboardText").textContent);
  showToast("黑板内容已复制");
});

/* ---------- 启动 ---------- */
async function boot() {
  try {
    const initialRoute = routeFromLocation();
    const requestedVendor = new URLSearchParams(location.search).get("vendor");
    await loadProjects();
    if (!state.projects.length) {
      renderEmptyWorkspace();
      navigate("projects", { replace: true });
      showToast("请先创建第一个审计任务");
    } else if (["overview", "findings", "directions", "assets", "runs", "settings"].includes(initialRoute) && (state.vendor || requestedVendor)) {
      if (requestedVendor && requestedVendor !== state.vendor) selectVendor(requestedVendor);
      applyRoute(initialRoute);
      await refresh();
      navigate(initialRoute, { replace: true });
    } else {
      navigate("projects", { replace: true });
    }
    state.timer = setInterval(() => {
      if (state.route === "projects") loadProjects(state.vendor).catch(error => showToast(error.message, true));
      else refreshRunTelemetry();
    }, 5000);
  } catch (error) {
    setConnectionStatus("连接异常", false);
    showToast(error.message, true);
  }
}
boot();
