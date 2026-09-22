"use strict";

import { state, ui } from "./modules/state.js";
import { truncateText, percent, formatEventTime, formatDuration, ageLabel } from "./modules/format.js";
import {
  $, el, cell, emptyRow, renderRows, preserveScroll, showToast,
  setBadge, setConnectionStatus,
} from "./modules/dom.js";
import { api } from "./modules/api.js";
import {
  renderAssetInventory,
  uploadAssetInventoryFile,
} from "./modules/asset-inventory.js";
import {
  normalizeMemberForSave,
  parseWorkerCommand,
  stripMemberTransientFields,
  summarizeTeamPresetDiff,
  validateMemberData,
} from "./modules/team-config.js";
import {
  downloadTechnologyProfile,
  downloadTechnologyWorkbook,
  renderTechnologyProfile,
} from "./modules/technology-profile.js";
import { ROUTES, routeFromHash } from "./modules/router.js";
/* ==========================================================================
   AgentCP 前端（app.js）
   原生 JS，无构建步骤。结构：
     1. 状态与工具   2. API    3. 路由    4. 任务中心
     5. 数据派生     6. 运行页  7. 配置页  8. 动作与事件绑定  9. 启动
   保留行为：requestGeneration 防竞态、5s 轮询、全部确认逻辑、
   secrets 只提交不回显、textContent 安全渲染、未知事件通用回退。
   ========================================================================== */

/* ---------- 1. 状态与工具 ---------- */

/* ---------- 2. API ---------- */
async function post(path, body, success) {
  try {
    const result = await api(path, { method: "POST", body: JSON.stringify({ vendor: state.vendor, ...body }) });
    showToast(success(result));
    await refresh();
    return result;
  } catch (error) { showToast(error.message, true); throw error; }
}

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
  defaultOption.textContent = state.defaultTeamPresetId
    ? "使用个人默认预设"
    : "使用默认项（当前为系统模板）";
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
  if (unavailable) {
    newSelect.value = "__system__";
    newSelect.disabled = true;
  } else {
    newSelect.disabled = false;
  }
}
function updateTeamPresetState(payload, preferredId = null) {
  state.teamPresets = payload.presets || [];
  state.defaultTeamPresetId = payload.default_preset_id || null;
  renderTeamPresetControls(preferredId);
}
/* ---------- 3. 路由 ---------- */
const routeNames = ROUTES;
function routeFromLocation() {
  return routeFromHash(location.hash);
}
function routeUrl(route) {
  const params = new URLSearchParams(location.search);
  if (state.vendor) params.set("vendor", state.vendor); else params.delete("vendor");
  const query = params.toString();
  return `${location.pathname}${query ? `?${query}` : ""}#${route}`;
}
function applyRoute(requested) {
  let route = routeNames.has(requested) ? requested : "hub";
  if (route === "run" && !state.vendor) route = "hub";
  if (route === "config" && !state.vendor && !state.newTaskMode) route = "hub";
  state.route = route;
  document.body.dataset.route = route;
  document.querySelectorAll("[data-view]").forEach(element => { element.hidden = element.dataset.view !== route; });
  document.querySelectorAll("[data-route-action]").forEach(element => {
    const visible = element.dataset.routeAction.split(/\s+/).includes(route);
    const contextHidden = element.id === "viewRunButton" && !state.runId;
    element.hidden = !visible || contextHidden;
  });
  document.querySelectorAll("[data-route-link]").forEach(link => {
    const linkRoute = link.dataset.routeLink;
    link.classList.toggle("active", linkRoute === route);
    const unavailable = (linkRoute === "config" && !state.vendor && !state.newTaskMode) || (linkRoute === "run" && !state.vendor);
    link.classList.toggle("disabled", unavailable);
    link.setAttribute("aria-disabled", String(unavailable));
  });
  $("newProjectBox").hidden = !state.newTaskMode;
  $("projectSelect").disabled = !state.projects.length;
  $("enterProjectButton").disabled = !state.vendor;
  const runActive = ["running", "paused", "awaiting_approval", "stopping"].includes(state.runStatus);
  $("startAuditButton").disabled = !state.vendor || !state.teamConfig || runActive;
  $("launchButton").disabled = !state.vendor || runActive;
  if (route === "hub") { $("routeEyebrow").textContent = "授权安全研究工作区"; $("projectTitle").textContent = "任务中心"; }
  else if (route === "config") { $("routeEyebrow").textContent = "目标 · 模型团队 · 黑板"; $("projectTitle").textContent = state.newTaskMode ? "新建审计任务" : `${state.vendor} · 项目配置`; }
  else { $("routeEyebrow").textContent = "实时审计过程 · 结论"; $("projectTitle").textContent = `${state.vendor} · 执行与结果`; }
  return route;
}
function navigate(route, { replace = false } = {}) {
  const resolved = applyRoute(route);
  history[replace ? "replaceState" : "pushState"]({}, "", routeUrl(resolved));
}
function canLeaveConfiguration() {
  return !(state.route === "config" && (state.targetDirty || state.teamDirty))
    || window.confirm("当前配置有未保存的修改，确定离开吗？");
}
async function goToHub() {
  if (!canLeaveConfiguration()) return;
  if (!state.vendor && state.projects.length) selectVendor(state.projects[0].vendor);
  state.newTaskMode = false;
  navigate("hub");
  renderProjectList();
}
async function requestRoute(route) {
  if (route === "hub") return goToHub();
  if (route === "config") {
    if (!state.vendor) { prepareNewTask(); navigate("config"); return; }
    navigate("config");
    if (!state.teamConfig) await refresh();
    return;
  }
  if (!state.vendor) { navigate("hub"); return showToast("请先选择项目", true); }
  if (!canLeaveConfiguration()) return;
  navigate("run");
  if (!state.teamConfig) await refresh();
}

/* ---------- 4. 任务中心 ---------- */
async function loadProjects(preferred = null) {
  try {
    const payload = await api("/api/projects");
    let presetPayload = { presets: [], default_preset_id: null };
    try {
      presetPayload = await api("/api/team-presets");
      state.teamPresetApiAvailable = true;
    } catch (error) {
      // Static frontend assets are served directly and can be refreshed while
      // a long-running old backend process is still active. Keep the project
      // center usable until that process can be restarted safely.
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
    $("enterProjectButton").disabled = !state.vendor;
    renderProjectList();
    applyRoute(state.route);
    setConnectionStatus("实时同步", true);
  } catch (error) { setConnectionStatus("连接异常", false); throw error; }
}
function renderProjectList() {
  const body = $("projectList");
  if (!state.projects.length) {
    emptyRow(body, 10, "还没有审计项目。点击右上角“新建审计任务”，先录入授权目标，再配置模型团队。");
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
      row.title = "点击进入项目配置";

      const nameTd = cell("", "");
      nameTd.append(el("span", "project-name", project.vendor));
      const goalTd = cell("", "");
      goalTd.append(el("div", "project-goal", project.current_task || project.goal || "尚未定义当前审计任务"));
      const statusTd = cell("", "");
      const badge = el("span");
      setBadge(badge, project.run_status || project.gate_status || "idle");
      statusTd.append(badge);
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
      const open = el("button", `button small ${awaiting ? "primary" : "secondary"} project-open`, awaiting ? "处理审批" : "配置");
      open.type = "button"; open.dataset.vendor = project.vendor; open.dataset.route = awaiting ? "run" : "config";
      const del = el("button", "button ghost small project-delete", "删除");
      del.type = "button"; del.dataset.vendor = project.vendor;
      wrap.append(open, del);
      actions.append(wrap);
      row.append(actions);
      body.append(row);
    });
  });
}

function selectVendor(vendor) {
  if (!state.projects.some(project => project.vendor === vendor)) return false;
  ++state.requestGeneration;
  state.vendor = vendor; state.newTaskMode = false;
  state.runId = null; state.runStatus = null; state.assetOffset = 0;
  state.teamDirty = false; state.configVendor = null; state.teamConfig = null;
  state.targetDirty = false; state.targetConfigVendor = null; state.targetConfig = null;
  state.secretStatus = {}; state.gateContext = null; state.gateSubmitting = false;
  state.derived = null; state.projectData = null; state.automationCache = null;
  state.auditCache = null; state.promptCache = null;
  ui.selected = { vulns: null, leads: null, directions: null, surface: null };
  ui.memberIndex = 0;
  $("gateApprovalCard").hidden = true;
  $("gateApprovalNote").value = "";
  $("projectSelect").value = vendor;
  updateSaveBar();
  renderProjectList();
  applyRoute(state.route);
  return true;
}
async function openProject(vendor = state.vendor) {
  if (!selectVendor(vendor)) return showToast("请选择有效项目", true);
  renderMemberList();
  renderMemberPanel();
  $("blackboardText").textContent = "正在读取项目黑板…";
  renderTargetEditor({ targets: [], out_of_scope: [], success_criteria: [] }, true);
  navigate("config");
  await refresh();
}

/* ---------- 5. 数据派生（分类、关联、标签） ---------- */
const coverageLabels = {
  api_endpoint: "接口路由挖掘", listening_port_service: "外网端口与服务识别",
  priv_esc_path: "越权与鉴权边界", asset_web_directory: "目录与资产暴破",
  framework_config: "框架指纹与配置缺陷", parser_target: "输入解析与反序列化测试",
  supply_chain_third_party: "供应链与三方组件识别", credential_leak: "外泄凭据检索",
  cloud_entitlement: "云原生边界探测", business_logic: "业务逻辑黑盒对抗",
  ipc_endpoint: "进程通信入口", listening_port: "监听端口", lpe_path: "本地提权路径",
  asset: "资产识别", electron_config: "客户端框架配置", supply_chain: "供应链组件",
  entitlement: "权限声明", deeplink: "深链与生命周期入口",
};
const coverageStatusLabels = { unverified: "未验证", observed: "已观察", verified: "已验证" };
const roleLabels = {
  reason: "推理规划", metacog: "盲点检查", executor: "执行验证",
  pentester: "执行验证", reviewer: "质量复核", waf_analyst: "WAF 对抗分析",
  profile_mapper: "目标画像采集",
};
const stageLabels = {
  profile: "前置画像采集",
  profile_incremental: "增量画像补充",
  swarm: "并发执行",
  review: "结果复核",
  commit: "写入黑板",
  finished: "已结束",
};
const jobStatusLabels = {
  queued: "排队中", running: "运行中", completed: "已完成", restricted: "模型策略受限",
  failed: "失败", cancelled: "已取消", paused: "已暂停",
  cancelling: "正在取消", stopping: "正在停止", stopped: "已停止",
};
function roleLabel(value) { return roleLabels[value] || value || "模型角色"; }
function stageLabel(value) { return stageLabels[value] || value || "—"; }
function jobStatusLabel(value) { return jobStatusLabels[value] || value || "等待中"; }
function phaseLabel(value) {
  return ({ intake: "目标接入", phase_0_5_probe: "可达性探测", recon: "攻击面侦察", hunt: "漏洞狩猎", verify: "证据验证", report: "结果报告" })[value] || value || "目标接入";
}
function hypothesisStatusLabel(value) {
  return ({ proposed: "候选", selected: "已选中", testing: "验证中", supported: "已支持", blocked: "受阻", rejected: "已证伪", completed: "已完成" })[value] || value || "候选";
}
function verbLabel(value) {
  return ({ inspect: "检查", reason: "推理", verify: "验证", execute: "执行", review: "复核", exploit: "验证利用" })[value] || value || "执行";
}
function factClassification(fact) {
  if (fact.classification) return fact.classification;
  if (fact.status === "vulnerability") return "vulnerability";
  const attackSurfaceCategories = new Set(["asset", "listening_port", "electron_config", "supply_chain", "entitlement", "deeplink"]);
  const impact = Number(fact.impact_score || 0);
  if (attackSurfaceCategories.has(fact.category) && impact < 0.4) return "attack_surface";
  return "risk_lead";
}
function classificationLabel(value) {
  return ({ attack_surface: "攻击面", risk_lead: "线索", vulnerability: "漏洞", same_root_vulnerability: "同源漏洞", negative_evidence: "负向证据", inconclusive: "证据不足" })[value] || value || "攻击面";
}
function latestVerdictMap(project) {
  const result = {};
  (project.human_verdicts || []).forEach(item => { result[item.finding_id] = item; });
  return result;
}
function verdictLabel(verdict) {
  if (!verdict) return "待人工复核";
  const action = ({ accepted: "人工认可", adjusted: "人工调级", same_root: "同源漏洞", refuted: "已驳斥", reclassified: "已降级", retest_requested: "要求复验" })[verdict.action] || verdict.action;
  const master = verdict.duplicate_of_finding_id ? ` · 主漏洞 ${verdict.duplicate_of_finding_id}` : "";
  return `${action} · ${classificationLabel(verdict.final_classification)} · ${verdict.final_severity || "unknown"}${master}`;
}
function evidenceForFact(fact, indexedEvidence) {
  const configured = String(fact.evidence_path || "").replace(/\/+$/, "");
  return (indexedEvidence || []).filter(item =>
    item.fact_id === fact.id || Boolean(configured && (item.path === configured || String(item.path || "").startsWith(`${configured}/`)))
  );
}
function riskLeadFromDirection(direction) {
  const intent = direction.intent || {};
  const risk = String(intent.risk_level || "unknown").toLowerCase();
  const active = ["open", "claimed", "released", "completed"].includes(direction.status);
  const meaningful = ["critical", "high", "medium"].includes(risk) || intent.requires_human_confirmation;
  if (!active || !meaningful) return null;
  return {
    id: direction.id,
    title: intent.hypothesis || intent.target || "未指定目标",
    severity: risk,
    classification: "risk_lead",
    business_impact: intent.expected_business_impact || intent.success_criteria || "需要验证是否能形成具体业务危害闭环",
    impact_score: risk === "critical" ? 0.9 : risk === "high" ? 0.75 : 0.55,
    confidence: direction.status === "claimed" ? 0.45 : 0.35,
    __direction: true,
    intent_id: direction.id,
    hypothesis_id: intent.hypothesis_id || null,
    source_fact_ids: Array.isArray(intent.source_fact_ids) ? intent.source_fact_ids : [],
    direction_status: direction.status,
    terminal_reason: direction.terminal_reason,
    created_at: direction.created_at,
    updated_at: direction.updated_at,
  };
}
function riskLeadLifecycle(item) {
  if (item.__pending) return { key: "pending_commit", label: "待收敛", detail: "模型结果尚未写入黑板" };
  if (item.__direction) {
    if (item.direction_status === "completed") return { key: "completed", label: "验证已完成", detail: item.__confirmedVulnerabilities?.length ? "该方向已转化为漏洞" : "该方向已结束，但未形成已验证漏洞" };
    if (item.direction_status === "claimed") return { key: "validating", label: "验证中", detail: "执行器已认领" };
    const cooldown = String(item.terminal_reason || "").match(/^policy_blocked_until:(.+)$/);
    if (cooldown && new Date(cooldown[1]).getTime() > Date.now()) return { key: "blocked", label: "模型策略冷却", detail: `${formatEventTime(cooldown[1])} 后可重新调度` };
    const createdAt = new Date(item.created_at || item.updated_at || 0).getTime();
    const stale = Number.isFinite(createdAt) && createdAt > 0 && Date.now() - createdAt >= 24 * 60 * 60 * 1000;
    if (stale) return { key: "stale", label: "已积压", detail: "等待超过 24 小时，需调度或人工处理" };
    if (item.direction_status === "released") return { key: "queued", label: "已释放重排", detail: "前次未闭环，等待重新认领" };
    return { key: "queued", label: "排队验证", detail: "等待执行器认领" };
  }
  if (item.intent_id) return { key: "queued", label: "待关联验证", detail: `已关联方向 ${item.intent_id}` };
  return { key: "unscheduled", label: "待转验证", detail: "尚未生成可执行验证方向" };
}
function riskLeadIdentity(item) {
  const normalize = value => String(value || "").replace(/^\[(?:候选|待验证|执行中)\]\s*/, "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
  return `${normalize(item.title)}${normalize(item.business_impact)}`;
}
function deduplicateRiskLeads(items) {
  const priority = { validating: 6, pending_commit: 5, queued: 4, unscheduled: 3, stale: 2, completed: 1 };
  const selected = new Map();
  items.forEach(item => {
    const key = riskLeadIdentity(item);
    const lifecycle = riskLeadLifecycle(item);
    const current = selected.get(key);
    const currentLifecycle = current ? riskLeadLifecycle(current) : null;
    const score = (item.__confirmedVulnerabilities?.length ? 100 : 0) + (priority[lifecycle.key] || 0);
    const currentScore = current ? (current.__confirmedVulnerabilities?.length ? 100 : 0) + (priority[currentLifecycle.key] || 0) : -1;
    if (!current || score > currentScore) selected.set(key, item);
  });
  return [...selected.values()].sort((left, right) => {
    const confirmedDiff = Number(Boolean(right.__confirmedVulnerabilities?.length)) - Number(Boolean(left.__confirmedVulnerabilities?.length));
    if (confirmedDiff) return confirmedDiff;
    const stateDiff = (priority[riskLeadLifecycle(right).key] || 0) - (priority[riskLeadLifecycle(left).key] || 0);
    return stateDiff || String(right.updated_at || right.created_at || "").localeCompare(String(left.updated_at || left.created_at || ""));
  });
}
function vulnerabilityReferenceSet(vulnerability, directionById, hypothesisById) {
  const refs = new Set();
  const add = value => { if (value) refs.add(String(value)); };
  const addMany = values => (Array.isArray(values) ? values : []).forEach(add);
  add(vulnerability.intent_id); add(vulnerability.hypothesis_id);
  const direction = directionById.get(vulnerability.intent_id);
  if (direction) {
    const intent = direction.intent || {};
    add(direction.id); add(intent.id); add(intent.hypothesis_id); add(intent.parent_id); add(intent.chain_id);
    addMany(intent.source_fact_ids);
  }
  const hypothesis = hypothesisById.get(vulnerability.hypothesis_id);
  if (hypothesis) { add(hypothesis.id); addMany(hypothesis.parent_fact_ids); addMany(hypothesis.intent_ids); }
  return refs;
}
function vulnerabilityLinksForLead(lead, vulnerabilities, directionById, hypothesisById) {
  const leadRefs = [lead.id, lead.intent_id, lead.hypothesis_id, ...(Array.isArray(lead.source_fact_ids) ? lead.source_fact_ids : [])].filter(Boolean).map(String);
  return vulnerabilities.filter(vulnerability => {
    const refs = vulnerabilityReferenceSet(vulnerability, directionById, hypothesisById);
    if (leadRefs.some(reference => refs.has(reference))) return true;
    const leadEvidence = String(lead.evidence_path || "").replace(/\/+$/g, "");
    const vulnerabilityEvidence = String(vulnerability.evidence_path || "").replace(/\/+$/g, "");
    return Boolean(leadEvidence && vulnerabilityEvidence && leadEvidence === vulnerabilityEvidence);
  });
}
function projectTypeOption(value) {
  const text = String(value || "").toLowerCase();
  if (text.includes("web") || text.includes("api") || text.includes("网站") || text.includes("网页")) return "Web渗透";
  if (text.includes("client") || text.includes("客户端") || text.includes("electron")) return "客户端";
  return "Web渗透";
}
function isModelPolicyRestriction(value) {
  const text = String(value?.error || value || "").toLowerCase();
  return text.includes("flagged for possible cybersecurity risk") || text.includes("trusted access for cyber") || text.includes("content policy") || text.includes("safety policy refusal");
}
// 汇总一次刷新所需的全量派生数据，供各标签页与详情面板使用
function buildDerived(project, automation, evidenceResult) {
  const jobs = automation.jobs || [];
  const pendingFactRows = jobs
    .filter(job => job.status === "completed" && !job.committed_at && job.result?.payload?.kind === "fact")
    .map(job => ({ ...job.result.payload, __pending: true, __member: job.member_name }));
  const factRows = [...project.facts, ...pendingFactRows];
  const directionRiskLeads = (project.directions || []).map(riskLeadFromDirection).filter(Boolean);
  const attackIntel = factRows.filter(fact => factClassification(fact) === "attack_surface");
  const vulnerabilities = factRows.filter(fact => factClassification(fact) === "vulnerability");
  const directionById = new Map((project.directions || []).map(direction => [direction.id, direction]));
  const hypothesisById = new Map((project.hypotheses || []).map(hypothesis => [hypothesis.id, hypothesis]));
  const rawRiskLeads = [...factRows.filter(fact => factClassification(fact) === "risk_lead"), ...directionRiskLeads]
    .map(lead => ({ ...lead, __confirmedVulnerabilities: vulnerabilityLinksForLead(lead, vulnerabilities, directionById, hypothesisById) }));
  const riskLeads = deduplicateRiskLeads(rawRiskLeads);
  const sourceLeadsByVulnerability = new Map(vulnerabilities.map(vulnerability => [
    vulnerability.id,
    riskLeads.filter(lead => (lead.__confirmedVulnerabilities || []).some(item => item.id === vulnerability.id)),
  ]));
  const directionRows = (project.directions || []).map(direction => ({
    ...direction.intent,
    direction_id: direction.id,
    direction_status: direction.status,
    terminal_reason: direction.terminal_reason,
    confirmed_vulnerabilities: vulnerabilities.filter(vulnerability => vulnerabilityReferenceSet(vulnerability, directionById, hypothesisById).has(direction.id)),
  }));
  return {
    pendingFactRows, factRows, attackIntel, vulnerabilities, riskLeads, rawRiskLeads,
    directionRows, directionById, hypothesisById, sourceLeadsByVulnerability,
    verdicts: latestVerdictMap(project),
    indexedEvidence: evidenceResult.evidence || [],
  };
}

/* ---------- 6. 运行页 ---------- */
function selectTab(name) {
  ui.tab = name;
  document.querySelectorAll(".tab-nav .tab").forEach(button => button.classList.toggle("active", button.dataset.tab === name));
  document.querySelectorAll("[data-tab-panel]").forEach(panel => { panel.hidden = panel.dataset.tabPanel !== name; });
}
function selectDiag(name) {
  ui.diag = name;
  document.querySelectorAll(".diag-tab").forEach(button => button.classList.toggle("active", button.dataset.diag === name));
  document.querySelectorAll("[data-diag-panel]").forEach(panel => { panel.hidden = panel.dataset.diagPanel !== name; });
}
function severityChip(value, extraText = "") {
  const chip = el("span", `severity ${String(value || "unknown").toLowerCase()}`, `${value || "unknown"}${extraText}`);
  return chip;
}
function itemRow({ title, chips = [], meta = [], selected = false, pending = false, onClick }) {
  const row = el("button", `item-row${selected ? " selected" : ""}`);
  row.type = "button";
  const head = el("div", "item-head");
  chips.forEach(chip => head.append(chip));
  if (pending) head.append(el("span", "pending-tag", "候选"));
  head.append(el("span", "item-title", title));
  row.append(head);
  if (meta.length) {
    const metaRow = el("div", "item-meta");
    meta.forEach(text => metaRow.append(el("span", "", text)));
    row.append(metaRow);
  }
  row.addEventListener("click", onClick);
  return row;
}
function detailSection(label, ...nodes) {
  const section = el("div", "detail-section");
  section.append(el("span", "", label));
  nodes.forEach(node => section.append(node));
  return section;
}
function evidenceLinks(matches) {
  const wrap = el("div", "detail-links");
  matches.forEach(item => {
    const button = el("button", "detail-link evidence-open", `查看证据 · ${item.path}`);
    button.type = "button";
    button.dataset.path = item.path;
    button.title = `SHA-256 ${item.sha256 || "未索引"}`;
    wrap.append(button);
  });
  return wrap;
}

/* ----- 第一层：状态栏 / 门禁 / 上下文 ----- */
function renderRunStatus(data, automation, metrics) {
  const run = automation.run || null;
  $("phaseValue").textContent = phaseLabel(data.phase);
  setBadge($("sbGateBadge"), data.gate_status || "idle");
  setBadge($("sbRunBadge"), run?.status || "idle");
  $("sbElapsed").textContent = formatDuration(run?.elapsed_seconds);
  $("runSummary").textContent = run ? `${run.id} · ${run.team} · ${stageLabel(run.stage)} · workers ${run.max_workers} · wave ${run.wave ?? 1}/${run.max_waves ?? "?"}` : "暂无自动化运行";
  setBadge($("runBadge"), run?.status || "idle");

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

  $("currentTask").textContent = data.current_task || "尚未定义当前任务";
  $("decisionValue").textContent = data.current_decision || "continue";
  $("gateReason").textContent = data.gate_reason || "尚未触发强制节拍";
  setBadge($("gateBadge"), data.gate_status === "awaiting_approval" ? "awaiting_approval" : run?.status || "idle");
}
function renderMetrics(project, data, metrics, automation) {
  const jobs = automation.jobs || [];
  const declaredAssets = new Set((project.target.targets || []).map(value => String(value).trim().toLowerCase()).filter(Boolean)).size;
  const assetTotal = metrics.assets?.total ?? Math.max(data.asset_count ?? 0, declaredAssets);
  const pendingFacts = metrics.quality.pending_facts ?? state.derived.pendingFactRows.length;
  $("assetMetric").textContent = assetTotal;
  $("assetMetricNote").textContent = metrics.assets ? `${metrics.assets.declared} 个目标 · ${metrics.assets.discovered} 个新发现` : `${declaredAssets} 个已配置目标`;
  $("factMetric").textContent = metrics.quality.facts;
  $("factMetricNote").textContent = pendingFacts ? `${metrics.quality.facts} 已入库 · ${pendingFacts} 待提交` : `${metrics.quality.facts} 条已提交到黑板`;
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
    : runStopped
      ? (run.error || "运行已由用户停止")
      : runFailed
        ? (run.error || failedJob?.error)
        : restrictedJob?.error || failedJob?.error;
  if (!error) { alert.hidden = true; alert.replaceChildren(); return; }
  const policyRestricted = !runFailed && !runStopped && Boolean(restrictedJob || isModelPolicyRestriction(failedJob));
  const title = el(
    "strong",
    "",
    budgetPaused
      ? "运行已安全暂停"
      : runStopped
        ? "运行已停止"
        : runFailed
          ? "运行失败"
          : policyRestricted
            ? "模型策略受限"
            : "模型任务失败",
  );
  const detail = el("span", "", truncateText(error, 900));
  detail.title = String(error);
  alert.replaceChildren(title, detail);
  alert.hidden = false;
}

/* ----- 第三层：漏洞（列表 + 详情 + 人工裁决） ----- */
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
  const chips = el("div", "detail-chips");
  chips.append(severityChip(fact.severity));
  [fact.id, classificationLabel("vulnerability"), `置信度 ${percent(fact.confidence)}`, `影响力 ${percent(fact.impact_score)}`]
    .forEach(text => chips.append(el("span", "chip", text)));
  if (fact.__pending) chips.append(el("span", "chip", `候选 · 来自 ${fact.__member} · 尚未写入黑板`));
  nodes.push(chips);
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
  if (matches.length) nodes.push(detailSection(`证据（${matches.length} 份）`, evidenceLinks(matches)));
  else nodes.push(detailSection("证据", el("p", "", fact.evidence_path ? `证据未进入索引：${fact.evidence_path}` : "漏洞未声明证据路径")));
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

/* ----- 第三层：风险线索 / 方向 / 攻击面 ----- */
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
function findLead(id) {
  return (state.derived?.riskLeads || []).find(item => item.id === id) || null;
}
function renderLeadDetail() {
  const panel = $("leadDetail");
  const item = findLead(ui.selected.leads);
  if (!item) {
    ui.selected.leads = null;
    panel.replaceChildren(el("div", "empty-state", "选择左侧线索查看完整信息。"));
    return;
  }
  const lifecycle = riskLeadLifecycle(item);
  const nodes = [el("div", "detail-title", item.title)];
  const chips = el("div", "detail-chips");
  chips.append(severityChip(item.severity));
  [item.id, lifecycle.label, `置信度 ${percent(item.confidence)}`, `影响力 ${percent(item.impact_score)}`, `创建于 ${formatEventTime(item.created_at || item.updated_at)}`]
    .forEach(text => chips.append(el("span", "chip", text)));
  if (item.__pending) chips.append(el("span", "chip", `候选 · 来自 ${item.__member}`));
  nodes.push(chips);
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
function directionStatusInfo(intent) {
  const terminalReason = String(intent.terminal_reason || "");
  const humanDismissed = intent.direction_status === "cancelled" && terminalReason.startsWith("human_dismissed:");
  const policyCooling = intent.direction_status === "released" && terminalReason.startsWith("policy_blocked_until:") && new Date(terminalReason.slice("policy_blocked_until:".length)).getTime() > Date.now();
  return {
    humanDismissed, policyCooling,
    label: humanDismissed ? "人工否决" : policyCooling ? "模型策略冷却" : intent.direction_status || "open",
  };
}
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
      list.append(itemRow({
        title: `${verbLabel(intent.verb)} · ${intent.target || "未指定目标"}`,
        chips: [],
        selected: ui.selected.directions === intent.direction_id,
        meta: [
          intent.direction_id,
          status.label,
          intent.confirmed_vulnerabilities.length ? `已证实 ${intent.confirmed_vulnerabilities.length} 个漏洞` : "未产生漏洞",
        ],
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
  const chips = el("div", "detail-chips");
  [intent.direction_id, status.label, `潜在风险 ${intent.risk_level || "未知"}`, `操作风险 ${intent.action_safety_risk || "low"}`]
    .forEach(text => chips.append(el("span", "chip", text)));
  nodes.push(chips);
  nodes.push(detailSection("成功标准", el("p", "", intent.success_criteria || "未指定")));
  if (intent.expected_business_impact) nodes.push(detailSection("预期业务影响", el("p", "", intent.expected_business_impact)));
  if (intent.terminal_reason) {
    nodes.push(detailSection("终止原因", el("p", "mono", status.humanDismissed ? intent.terminal_reason.replace(/^human_dismissed:/, "") : intent.terminal_reason)));
  }
  const confirmed = intent.confirmed_vulnerabilities || [];
  if (confirmed.length) {
    const wrap = el("div", "detail-links");
    confirmed.forEach(vulnerability => {
      const button = el("button", "detail-link", `${vulnerability.id} · ${truncateText(vulnerability.title, 60)}`);
      button.type = "button";
      button.addEventListener("click", () => selectVulnerability(vulnerability.id, { switchTab: true }));
      wrap.append(button);
    });
    nodes.push(detailSection(`论证结果（${confirmed.length} 个已验证漏洞）`, wrap));
  } else {
    nodes.push(detailSection("论证结果", el("p", "", "该方向尚未产生已验证漏洞。")));
  }
  const action = el("div", "detail-section");
  if (status.humanDismissed) {
    // 人工否决是终态：模型重评不能撤销；只有这里的显式人工恢复可以。
    const restore = el("button", "button small secondary direction-restore", "恢复该方向");
    restore.type = "button";
    restore.dataset.directionId = intent.direction_id;
    restore.title = "重新评分不会自动恢复该方向；确认后它重新开放调度，画像方向将按最新评估对齐";
    action.append(restore);
  } else {
    const dismiss = el("button", "button small danger direction-dismiss", "删除方向");
    dismiss.type = "button";
    dismiss.dataset.directionId = intent.direction_id;
    action.append(dismiss);
  }
  nodes.push(action);
  panel.replaceChildren(...nodes);
}
function renderSurfaceList() {
  const list = $("surfaceList");
  const { attackIntel } = state.derived;
  preserveScroll(list, () => {
    list.replaceChildren();
    if (!attackIntel.length) {
      list.append(el("div", "empty-state", "暂无攻击面情报。已观察的资产、配置、服务与入口会出现在这里。"));
      return;
    }
    [...attackIntel].reverse().slice(0, 80).forEach(fact => {
      const category = el("span", "chip", coverageLabels[fact.category] || fact.category || "攻击面");
      list.append(itemRow({
        title: fact.title,
        chips: [category],
        pending: fact.__pending,
        selected: ui.selected.surface === fact.id,
        meta: [fact.id, `置信度 ${percent(fact.confidence)}`],
        onClick: () => { ui.selected.surface = fact.id; renderSurfaceList(); renderSurfaceDetail(); },
      }));
    });
  });
}
function renderSurfaceDetail() {
  const panel = $("surfaceDetail");
  const { attackIntel, indexedEvidence } = state.derived;
  const fact = attackIntel.find(item => item.id === ui.selected.surface) || null;
  if (!fact) {
    ui.selected.surface = null;
    panel.replaceChildren(el("div", "empty-state", "选择左侧条目查看完整信息。"));
    return;
  }
  const nodes = [el("div", "detail-title", fact.title)];
  const chips = el("div", "detail-chips");
  chips.append(el("span", "chip", coverageLabels[fact.category] || fact.category || "攻击面"));
  [fact.id, `置信度 ${percent(fact.confidence)}`, `影响力 ${percent(fact.impact_score)}`]
    .forEach(text => chips.append(el("span", "chip", text)));
  if (fact.__pending) chips.append(el("span", "chip", `候选 · 来自 ${fact.__member} · 尚未写入黑板`));
  nodes.push(chips);
  nodes.push(detailSection("价值说明", el("p", "", fact.business_impact || "暂无价值说明")));
  const matches = evidenceForFact(fact, indexedEvidence);
  if (matches.length) nodes.push(detailSection(`证据（${matches.length} 份）`, evidenceLinks(matches)));
  panel.replaceChildren(...nodes);
}

/* ----- 第三层：假设 / 证据 ----- */
function renderHypotheses(project) {
  const hypotheses = project.hypotheses || [];
  const methodPack = project.method_pack || {};
  const planBatches = project.plan_batches || [];
  $("hypothesesCount").textContent = String(hypotheses.length);
  $("methodPackSummary").textContent = methodPack.name
    ? `已加载 ${methodPack.name} ${methodPack.version || ""}，包含 ${(methodPack.dimensions || []).length} 个攻击面维度 · ${hypotheses.length} 个假设 · ${planBatches.length} 个计划批次。列表展示最新假设与其确定性优先分。`
    : "尚未加载项目方法包。每个假设都会经过价值、可达性、信息增益、新颖度、前置成熟度和成本评分。";
  renderRows($("hypothesesBody"), [...hypotheses].reverse().slice(0, 40), 7, item => {
    const row = document.createElement("tr");
    row.append(
      cell(item.statement || item.title), cell(item.target),
      cell(coverageLabels[item.dimension] || item.dimension),
      cell(percent(item.score ?? item.priority_score)),
      cell(item.evidence_maturity || "假设"),
      cell(hypothesisStatusLabel(item.status)),
      cell(item.source || "方法包"),
    );
    return row;
  });
}
function renderEvidenceTab() {
  const { indexedEvidence, pendingFactRows } = state.derived;
  const indexedPaths = new Set(indexedEvidence.map(item => item.path));
  const pendingEvidence = pendingFactRows
    .map(fact => ({ fact_id: `候选 · ${fact.__member}`, path: fact.evidence_path, size_bytes: "待索引", sha256: "待提交", pending: true }))
    .filter(item => item.path && !indexedPaths.has(item.path));
  const evidence = [...indexedEvidence, ...pendingEvidence];
  $("evidenceCount").textContent = String(indexedEvidence.length);
  $("evidenceSummary").textContent = pendingEvidence.length
    ? `${indexedEvidence.length} 份已索引 · ${pendingEvidence.length} 份待审查（候选结果尚未写入黑板）`
    : "Fact 关联的原始文件、大小和 SHA-256。";
  renderRows($("evidenceBody"), evidence, 5, item => {
    const row = document.createElement("tr");
    row.append(
      cell(item.fact_id), cell(item.path),
      cell(item.pending ? String(item.size_bytes) : `${Number(item.size_bytes || 0).toLocaleString()} B`),
      cell(item.sha256, "hash"),
    );
    const action = cell("");
    const button = el("button", "button ghost small evidence-open", "查看");
    button.type = "button";
    button.dataset.path = item.path;
    action.append(button);
    row.append(action);
    return row;
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

/* ----- 第四层：运行诊断 ----- */
function workerLabel(job) {
  const raw = String(job.member_name || "worker");
  const role = job.role || "";
  const slotMatch = raw.match(/#(\d+)$/);
  const slot = slotMatch ? ` ${slotMatch[1]}` : "";
  const base = { reason: "推理员", metacog: "盲点检查员", executor: "执行器", pentester: "执行器", reviewer: "复核员", waf_analyst: "WAF 分析员" }[role] || "工作线程";
  return `${base}${slot}`;
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
  if (intent) return { verb: intent.verb || "execute", target: intent.target || "未指定目标", success_criteria: intent.success_criteria || "", evidence_sink: intent.evidence_sink || "", risk_level: intent.risk_level || "unknown" };
  const defaults = {
    reason: ["分析黑板并生成审计方向", "产出可执行 Intent 或有证据的 Fact"],
    metacog: ["检查盲点、反例与高价值路径", "补充或修正当前审计方向"],
    reviewer: ["审查候选结果与证据质量", "决定接受、驳回或请求人工确认"],
  };
  const fallback = defaults[job.role] || [`执行 ${job.role || "worker"} 角色任务`, "返回结构化候选结果"];
  return { verb: job.role || "worker", target: fallback[0], success_criteria: fallback[1], evidence_sink: "", risk_level: "" };
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
  if (event?.event_type === "model_tool_started") return `正在执行工具：${data.tool_name || "Claude Tool"} · ${truncateText(data.input_summary, 100)}`;
  if (event?.event_type === "model_tool_completed") return data.is_error ? `工具执行失败：${data.tool_name || "Claude Tool"}` : `工具已完成：${data.tool_name || "Claude Tool"}，等待下一步`;
  if (event?.event_type === "model_assistant_update") return `Claude 正在分析：${truncateText(data.text, 100)}`;
  if (event?.event_type === "model_stream_result") return "Claude 已返回最终结果，正在持久化";
  if (event?.event_type === "model_stream_started") return "Claude 会话已建立，等待第一个工具动作";
  if (job.status === "running") return data.elapsed_seconds == null ? "等待 Claude CLI 返回" : `等待 Claude CLI 返回 · ${data.elapsed_seconds}s / ${data.timeout_seconds || "?"}s`;
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
  $("jobsCount").textContent = String(jobs.length);
  const wrap = $("jobsBody").closest(".table-wrap");
  preserveScroll(wrap, () => {
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
      activity.append(el("span", "", job.last_heartbeat_at ? `AgentCP 调度心跳 ${formatEventTime(job.last_heartbeat_at)}` : "尚未收到 AgentCP 调度心跳"));
      if (job.status === "running") activity.append(el("small", "", "工具事件来自 Claude stream-json；调度心跳与工具进度独立"));
      if (job.error) {
        const errorNode = el("code", "", truncateText(job.error, 220));
        errorNode.title = String(job.error);
        activity.append(errorNode);
      }
      const visibleStatus = job.status === "failed" && isModelPolicyRestriction(job) ? "模型策略受限" : jobStatusLabel(job.status);
      row.append(
        cell(workerLabel(job)), cell(roleLabel(job.role)), modelCell, taskCell,
        cell(stageLabel(job.stage)), cell(visibleStatus, `job-status ${job.status || ""}`),
        cell(`${job.attempts ?? 0}/${job.max_attempts ?? "?"}`), activity,
      );
      return row;
    });
  });
}
// 事件类型是开放集合：已知类型做友好渲染，未知类型走通用回退，不丢弃
function friendlyEvent(event) {
  const type = event.event_type || event.action || "event";
  const data = event.data || event.details || {};
  const member = data.member || data.member_name || "模型任务";
  const activity = data.activity || {};
  const activityTarget = activity.target || null;
  if (type === "model_local_guest_image_build_started") return { kind: "started", title: "正在构建本地运行镜像", summary: data.image || "agent-compose-guest:latest", detail: "首次使用本地 Docker 时只构建一次；并发 Worker 会等待并复用该镜像。" };
  if (type === "model_local_guest_image_build_progress") return { kind: "waiting", title: "本地镜像构建中", summary: data.image || "agent-compose-guest:latest", detail: data.text };
  if (type === "model_local_guest_image_build_completed") return { kind: "completed", title: "本地运行镜像已就绪", summary: data.image || "agent-compose-guest:latest" };
  if (type === "model_stream_started") return { kind: "started", title: "Claude 会话已建立", summary: member, meta: [data.session_id && `会话 ${data.session_id}`, Array.isArray(data.tools) && data.tools.length && `可用工具 ${data.tools.length} 个`].filter(Boolean).join(" · ") };
  if (type === "model_agent_compose_log") return { kind: "assistant", title: "模型实时输出", summary: member, meta: activityTarget && `当前任务：${activityTarget}`, detail: data.text };
  if (type === "model_agent_compose_status") return { kind: data.status === "failed" ? "failed" : "waiting", title: "模型运行状态", summary: member, meta: data.status ? `状态：${data.status}` : "agent-compose 运行中" };
  if (type === "model_agent_compose_run_completed") return { kind: "completed", title: "模型任务完成", summary: member, meta: data.duration_ms != null ? `耗时 ${(Number(data.duration_ms) / 1000).toFixed(1)}s` : "agent-compose 已返回结果" };
  if (type === "model_tool_started") return { kind: "tool-running", title: "正在执行工具", summary: data.tool_name || "Claude Tool", meta: activityTarget && `任务目标：${activityTarget}`, detail: data.input_summary || "工具未提供参数摘要" };
  if (type === "model_tool_completed") return { kind: data.is_error ? "failed" : "tool-completed", title: data.is_error ? "工具执行失败" : "工具执行完成", summary: data.tool_name || "Claude Tool", meta: data.tool_use_id && `调用 ${data.tool_use_id}`, detail: data.output_summary || "工具未提供结果摘要" };
  if (type === "model_assistant_update") return { kind: "assistant", title: "Claude 阶段输出", summary: member, detail: data.text };
  if (type === "model_stream_result") return { kind: data.is_error ? "failed" : "completed", title: data.is_error ? "Claude 返回错误结果" : "Claude 已返回最终结果", summary: member, meta: [data.duration_ms != null && `耗时 ${(Number(data.duration_ms) / 1000).toFixed(1)}s`, data.num_turns != null && `${data.num_turns} 轮`].filter(Boolean).join(" · ") };
  if (type === "model_call_started") return { kind: "started", title: "正在调用模型", summary: activityTarget || `${member} · ${data.model || "默认模型"}`, meta: [data.driver && `驱动 ${data.driver}`, data.endpoint && `服务 ${data.endpoint}`, data.attempt && `第 ${data.attempt}/${data.max_attempts || "?"} 次`, data.timeout_seconds && `超时 ${data.timeout_seconds}s`].filter(Boolean).join(" · "), detail: activity.success_criteria && `成功标准：${activity.success_criteria}${activity.evidence_sink ? ` · 证据输出：${activity.evidence_sink}` : ""}` };
  if (type === "model_context_compiled") return { kind: "completed", title: "任务上下文已编译", summary: member, meta: [data.prompt_chars != null && `Prompt ${Number(data.prompt_chars).toLocaleString()} 字符`, data.context_chars != null && `任务上下文 ${Number(data.context_chars).toLocaleString()}/${Number(data.context_budget_chars || 0).toLocaleString()}`].filter(Boolean).join(" · "), detail: data.snapshot_id ? `审计快照 ${data.snapshot_id}；可在“Prompt 审计”中查看。` : "已按角色与当前任务筛选黑板记录。" };
  if (type === "model_call_completed") return { kind: "completed", title: "模型调用完成", summary: member, meta: data.duration_seconds == null ? "已收到并持久化模型响应" : `耗时 ${data.duration_seconds}s · 已收到并持久化模型响应` };
  if (type === "model_call_failed") return { kind: "failed", title: /402|insufficient balance/i.test(data.error || "") ? "模型账户余额不足，已停止重试" : data.retryable ? "模型调用失败，可重试" : "模型调用失败，已停止重试", summary: member, meta: [data.duration_seconds != null && `耗时 ${data.duration_seconds}s`, data.status && `任务状态 ${data.status}`].filter(Boolean).join(" · "), error: data.error };
  if (type === "model_policy_restricted") return { kind: "waiting", title: "模型策略受限", summary: member, meta: [data.duration_seconds != null && `耗时 ${data.duration_seconds}s`, "已停止重试，其他并发结果继续收敛"].filter(Boolean).join(" · "), detail: data.error };
  if (type === "model_policy_fallback_started") return { kind: "waiting", title: "历史版本提示词降级记录", summary: member, meta: "当前版本已禁用此降级；新调用与重试始终携带 Agent 专属提示词", detail: data.reason || "该事件由旧版本运行产生" };
  if (["model_call_retry", "model_call_retried", "model_retry_scheduled", "model_call_retry_scheduled"].includes(type)) return { kind: "retry", title: "已安排模型重试", summary: member, meta: data.next_attempt ? `下一次：第 ${data.next_attempt}/${data.max_attempts || "?"} 次` : "即将重新调用模型服务" };
  if (type === "model_thinking_progress") return { kind: "thinking", title: "模型思考中", summary: activityTarget || member, meta: data.estimated_tokens != null ? `已思考 ${data.estimated_tokens} tokens` : "模型正在分析上下文和规划执行步骤", detail: "模型 Extended Thinking 进行中，思考完成后将开始工具调用。" };
  if (type === "model_call_waiting") return { kind: "waiting", title: "等待模型运行时新事件", summary: activityTarget || member, meta: data.elapsed_seconds == null ? "AgentCP 调度心跳正常" : `已等待 ${data.elapsed_seconds}s / ${data.timeout_seconds || "?"}s · AgentCP 调度心跳正常`, detail: "这是调度心跳；任务行会继续保留最近一次模型工具动作。" };
  if (type === "run_execution_budget_paused") return { kind: "waiting", title: "运行预算不足，已安全暂停", summary: `下一阶段：${data.next_stage || "待定"}`, meta: `剩余 ${data.remaining_seconds ?? 0}s · 完整调用需要 ${data.required_seconds ?? "?"}s`, detail: "没有创建新的模型任务；已完成结果和未完成待办均已持久化，可恢复运行继续。" };
  if (type === "run_execution_budget_renewed") return { kind: "completed", title: "运行预算已续签", summary: data.execution_deadline ? `新截止时间：${formatEventTime(data.execution_deadline)}` : "可继续执行", meta: data.lease_seconds ? `新增预算 ${formatDuration(data.lease_seconds)}` : "" };
  return null;
}
function renderEvent(event) {
  const friendly = friendlyEvent(event);
  const row = document.createElement("div");
  row.className = `event-row${friendly ? ` model-event ${friendly.kind}` : ""}`;
  const time = el("time", "", formatEventTime(event.created_at));
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
function renderDiagnostics(project, automation, auditResult, promptResult) {
  renderJobsPanel(automation);
  const events = [
    ...(automation.events || []).filter(event => event.event_type !== "model_agent_compose_log"),
    ...(auditResult.audit || []).map(item => ({ created_at: item.created_at, event_type: `api:${item.action}`, data: item.details })),
  ].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 50);
  $("eventsCount").textContent = String(events.length);
  preserveScroll($("eventsList"), () => {
    $("eventsList").replaceChildren();
    events.forEach(event => $("eventsList").append(renderEvent(event)));
    if (!events.length) $("eventsList").append(el("div", "empty-state", "暂无运行事件"));
  });
  const promptSnapshots = [...(promptResult?.snapshots || [])].reverse();
  $("promptSnapshotsCount").textContent = String(promptSnapshots.length);
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
  $("researchMemoryCount").textContent = String(counterfactualRows.length + lessonRows.length);
  renderRows($("researchMemoryBody"), memoryRows, 5, item => {
    const row = document.createElement("tr");
    row.append(cell(item.type), cell(item.target), cell(item.content), cell(item.condition), cell(item.status));
    return row;
  });
  const data = project.state;
  const coverageEntries = Object.entries(data.attack_surface_coverage || {});
  $("coverageList").replaceChildren();
  coverageEntries.forEach(([name, statusValue]) => {
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
  const metrics = state.metricsCache || {};
  $("verifiedCoverage").textContent = metrics.coverage ? `${metrics.coverage.verified}/${metrics.coverage.dimensions}` : "0";
  const wafAssessments = project.waf_assessments || [];
  $("wafAssessmentsCount").textContent = String(wafAssessments.length);
  renderRows($("wafAssessmentsBody"), wafAssessments, 5, item => {
    const row = document.createElement("tr");
    row.append(cell(item.target), cell(item.original_hypothesis), cell(item.status), cell((item.signals || []).join("；") || "等待刻画"), cell(`${item.used_minutes ?? 0}/${item.budget_minutes ?? 12} min`));
    return row;
  });
  const negativeEvidence = project.negative_evidence || [];
  $("negativeEvidenceCount").textContent = String(negativeEvidence.length);
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
  // 诊断摘要：默认只看异常数量与最近事件
  const jobs = automation.jobs || [];
  const anomalies = jobs.filter(job => ["failed", "cancelled", "restricted"].includes(job.status)).length;
  const latest = events[0];
  const latestText = latest ? (friendlyEvent(latest)?.title || latest.event_type || "事件") : "无事件";
  const summary = $("diagSummary");
  summary.textContent = anomalies ? `异常 ${anomalies} · 最近：${latestText}` : `无异常 · ${latestText}`;
  summary.classList.toggle("has-anomaly", anomalies > 0);
}

/* ---------- 7. 配置页：测试目标 ---------- */
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
  $("saveTargetButton").disabled = !state.vendor;
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
  $("uploadClientArtifactButton").disabled = !state.vendor || !file;
  const artifact = state.targetConfig?.uploaded_artifact;
  $("clientUploadStatus").textContent = artifact
    ? `当前文件：${artifact.name} · ${Number(artifact.size || 0).toLocaleString()} bytes · SHA-256 ${String(artifact.sha256 || "").slice(0, 16)}…`
    : state.vendor ? (file ? `待上传：${file.name} · ${file.size.toLocaleString()} bytes` : "请选择文件。单文件默认上限 2 GiB。") : "请先创建或选择项目，再上传文件。";
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
// 浏览器刷新/关闭标签页的离开保护：仅在有未保存修改时注册；
// 使用标准 preventDefault + returnValue，提示文案由浏览器决定
function beforeUnloadHandler(event) {
  event.preventDefault();
  event.returnValue = "";
}
function updateBeforeUnload() {
  if (state.targetDirty || state.teamDirty) window.addEventListener("beforeunload", beforeUnloadHandler);
  else window.removeEventListener("beforeunload", beforeUnloadHandler);
}

/* ---------- 7. 配置页：Agent 团队编辑器 ---------- */
const MEMBER_FIELD_IDS = ["mName", "mRole", "mMaxRunning", "mPriority", "mType", "mModel", "mBaseUrl", "mApiKeyEnv", "mAuthMode", "mRuntimeMode", "mSandbox"];
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
  if (!members.length) list.append(el("div", "empty-state", "暂无角色。点击下方“添加角色”。"));
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
  $("mMaxRunning").disabled = false;
  $("mMaxRunning").title = "该角色可创建的并发执行单元数；实际同时运行数量仍受运行页“全局并发”控制。";
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
  // 有未通过解析的草稿时优先回显草稿，否则显示已保存的合法命令
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
  // 后端约束：ollama 只能跑本地 CLI，container 只能跑本地 Docker，均锁定运行模式
  if (ollama) $("mRuntimeMode").value = "local-cli";
  if (container) $("mRuntimeMode").value = "local-docker";
  $("mRuntimeMode").disabled = ollama || container;
  $("mMaxRunning").disabled = false;
  $("mMaxRunning").title = "该角色可创建的并发执行单元数；实际同时运行数量仍受运行页“全局并发”控制。";
  // Container 不需要模型连接与会话密钥，只编辑 extra.image / extra.worker_command
  $("fModel").hidden = container;
  $("fBaseUrl").hidden = container;
  $("fApiKeyEnv").hidden = ollama || container;
  $("fAuthMode").hidden = ollama || container;
  $("fSecret").hidden = ollama || container;
  $("containerGroup").hidden = !container;
  // 依赖提示按后端类型分别说明，避免误导（例如 openai-compatible 不是本地可执行文件）
  const note = $("localCliNote");
  if (container) {
    note.textContent = "Container Worker 由本地 Docker 启动指定镜像，运行模式已锁定为本地 Docker。";
    note.hidden = false;
  } else if (ollama) {
    note.textContent = "Ollama 依赖本机已启动的 Ollama 服务，仅支持本地 CLI 模式，运行模式已锁定。";
    note.hidden = false;
  } else if ($("mRuntimeMode").value === "local-cli") {
    const localCliHints = {
      "codex": "本地 CLI 模式会直接调用宿主机上的 codex CLI，请确保它已安装并在启动 AgentCP 服务的进程 PATH 中，否则会报“未找到可执行文件”。",
      "claude-cli": "本地 CLI 模式会直接调用宿主机上的 claude CLI，请确保它已安装并在启动 AgentCP 服务的进程 PATH 中，否则会报“未找到可执行文件”。",
      "openai-compatible": "openai-compatible 通过 HTTP 请求服务地址指向的模型 API，不依赖本地可执行文件，无需安装 CLI。",
    };
    note.textContent = localCliHints[type] || `本地 CLI 模式会直接调用宿主机上的 ${type}，请确保它已安装并在启动 AgentCP 服务的进程 PATH 中。`;
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
// 保存前校验全部成员：返回第一个有问题的成员及其问题，不依赖后端报错
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
// 在当前编辑面板上显示某个成员的字段错误
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
  member.auth_mode = $("mAuthMode").value;
  member.runtime_mode = $("mRuntimeMode").value;
  member.sandbox = $("mSandbox").value;
  member.custom_prompt = $("mCustomPrompt").value;
  member.__secret = $("mSecret").value.trim();
  if (member.type === "container") {
    // 只覆盖前端认识的两个键，network/cpus/memory/pass_env 等其余 extra 字段原样保留
    const parsed = parseWorkerCommand($("mContainerCommand").value);
    const previousExtra = member.extra || {};
    if (parsed.error) {
      // 解析失败：保留合法的旧 worker_command，但原始草稿必须留存，
      // 切换成员后再回来时输入框仍显示用户的原始输入，而不是被旧值覆盖
      member.extra = {
        ...previousExtra,
        image: $("mContainerImage").value.trim(),
        worker_command: previousExtra.worker_command ?? [],
      };
      member.__workerCommandDraft = $("mContainerCommand").value;
      member.__workerCommandError = parsed.error;
    } else {
      member.extra = {
        ...previousExtra,
        image: $("mContainerImage").value.trim(),
        worker_command: parsed.value,
      };
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

/* ---------- 主渲染 ---------- */
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
  const { vulnerabilities, riskLeads, directionRows, attackIntel, pendingFactRows, rawRiskLeads } = state.derived;

  renderRunStatus(data, automation, metrics);
  renderMetrics(project, data, metrics, automation);
  renderGateApproval(data, automation);
  renderRunFailure(automation);
  $("goalText").textContent = project.target.goal || `授权模式：${project.target.authorization_mode} · scope ${JSON.stringify(project.target.scope)}`;

  // 结果标签计数与摘要
  const committedVulns = vulnerabilities.filter(fact => !fact.__pending);
  const pendingVulns = vulnerabilities.length - committedVulns.length;
  $("vulnerabilitiesCount").textContent = pendingVulns ? `${committedVulns.length}+${pendingVulns}候选` : String(committedVulns.length);
  const leadLifecycleCounts = riskLeads.reduce((counts, item) => { const key = riskLeadLifecycle(item).key; counts[key] = (counts[key] || 0) + 1; return counts; }, {});
  const confirmedLeadCount = riskLeads.filter(item => item.__confirmedVulnerabilities?.length).length;
  const duplicateCount = rawRiskLeads.length - riskLeads.length;
  $("riskLeadsCount").textContent = String(riskLeads.length);
  $("leadsSummary").textContent = `已证实 ${confirmedLeadCount} · 验证中 ${leadLifecycleCounts.validating || 0} · 积压 ${leadLifecycleCounts.stale || 0}${duplicateCount ? ` · 合并重复 ${duplicateCount}` : ""}；超过 24 小时未闭环标记为积压。`;
  const provenDirectionCount = directionRows.filter(item => item.confirmed_vulnerabilities.length).length;
  $("intentsCount").textContent = String(directionRows.length);
  $("directionsSummary").textContent = `已证实 ${provenDirectionCount} 条方向产生漏洞。人工否决会停止后续调度；审计记录和理由仍保留。`;
  const pendingIntel = attackIntel.filter(fact => fact.__pending).length;
  $("attackIntelCount").textContent = String(attackIntel.length);
  $("surfaceSummary").textContent = `已观察资产、配置、服务与入口${pendingIntel ? ` · ${pendingIntel} 条候选待收敛` : ""}；技术识别只属于攻击面，不会直接计为漏洞。`;

  renderVulnList();
  renderVulnDetail();
  renderLeadList();
  renderLeadDetail();
  renderDirectionList();
  renderDirectionDetail();
  renderSurfaceList();
  renderSurfaceDetail();
  renderHypotheses(project);
  renderEvidenceTab();
  renderTechnologyProfile(
    project.enriched_target_profile || [],
    project.routine_target_groups || [],
  );
  renderAssetInventory(assetResult);

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
    jobs: (automation?.jobs || []).map(job => [
      job.id, job.status, job.attempts, job.commit_state,
      job.committed_at, job.error,
    ]),
  });
}

async function refreshRunTelemetry() {
  if (!state.vendor || !state.projectData || !state.automationCache) {
    await refresh();
    return;
  }
  const requestedVendor = state.vendor;
  const generation = ++state.requestGeneration;
  try {
    const vendor = encodeURIComponent(requestedVendor);
    const [automation, metricsResult] = await Promise.all([
      api(`/api/automation/status?vendor=${vendor}&compact=1`),
      api(`/api/metrics?vendor=${vendor}`),
    ]);
    if (generation !== state.requestGeneration || requestedVendor !== state.vendor) return;
    if (telemetrySignature(automation) !== telemetrySignature(state.automationCache)) {
      await refresh();
      return;
    }
    state.automationCache = automation;
    state.metricsCache = metricsResult.metrics;
    state.runId = automation.run?.id || null;
    state.runStatus = automation.run?.status || null;
    renderRunStatus(state.projectData.state, automation, metricsResult.metrics);
    renderMetrics(state.projectData, state.projectData.state, metricsResult.metrics, automation);
    renderGateApproval(state.projectData.state, automation);
    renderRunFailure(automation);
    renderDiagnostics(
      state.projectData,
      automation,
      state.auditCache || { audit: [] },
      state.promptCache || { snapshots: [] },
    );
    setConnectionStatus("实时同步", true);
  } catch (error) {
    if (generation !== state.requestGeneration || requestedVendor !== state.vendor) return;
    setConnectionStatus("连接异常", false);
    showToast(error.message, true);
  }
}

/* ---------- 空工作区 / 新建任务 ---------- */
const projectActionIds = [
  "saveTargetButton", "uploadClientArtifactButton", "launchButton", "cancelButton",
  "importAssetInventoryButton",
  "hintButton", "addRoleButton", "saveTeamButton", "copyBoard", "removeMemberButton",
  "enterProjectButton", "startAuditButton", "gateContinueButton", "gateStopButton", "submitFindingReview",
];
function setProjectControlsEnabled(enabled) {
  projectActionIds.forEach(id => { $(id).disabled = !enabled; });
  if (enabled) $("cancelButton").disabled = true;
}
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
  $("projectTitle").textContent = "创建第一个项目";
  $("currentTask").textContent = "尚未初始化项目";
  $("goalText").textContent = "请先填写目标并创建项目";
  $("phaseValue").textContent = "—";
  $("sbElapsed").textContent = "—";
  $("decisionValue").textContent = "—";
  $("gateReason").textContent = "尚无控制器评估";
  $("gateApprovalCard").hidden = true;
  $("gateApprovalNote").value = "";
  setBadge($("gateBadge"), "idle"); setBadge($("sbGateBadge"), "idle");
  setBadge($("sbRunBadge"), "idle"); setBadge($("runBadge"), "idle");
  $("runSummary").textContent = "暂无自动化运行";
  $("runProgressBar").style.width = "0%";
  $("runProgressText").textContent = "暂无 Job";
  $("runFailure").hidden = true; $("runFailure").replaceChildren();
  ["assetMetric", "factMetric", "vulnMetric"].forEach(id => { $(id).textContent = "0"; });
  $("coverageMetric").textContent = "0%";
  ["vulnerabilitiesCount", "riskLeadsCount", "intentsCount", "attackIntelCount", "hypothesesCount", "evidenceCount", "technologyProfileCount", "jobsCount", "eventsCount", "promptSnapshotsCount", "researchMemoryCount", "wafAssessmentsCount", "negativeEvidenceCount"].forEach(id => { $(id).textContent = "0"; });
  $("verifiedCoverage").textContent = "0";
  ["vulnList", "leadList", "directionList", "surfaceList", "technologyProfileList", "coverageList"].forEach(id => $(id).replaceChildren());
  ["vulnDetailInfo", "leadDetail", "directionDetail", "surfaceDetail"].forEach(id => $(id).replaceChildren(el("div", "empty-state", "请先创建项目。")));
  $("reviewBox").hidden = true;
  emptyRow($("hypothesesBody"), 7); emptyRow($("evidenceBody"), 5);
  emptyRow($("jobsBody"), 8); emptyRow($("promptSnapshotsBody"), 7);
  emptyRow($("researchMemoryBody"), 5); emptyRow($("wafAssessmentsBody"), 5); emptyRow($("negativeEvidenceBody"), 5);
  $("eventsList").replaceChildren(el("div", "empty-state", "暂无运行事件"));
  $("diagSummary").textContent = "暂无异常";
  $("diagSummary").classList.remove("has-anomaly");
  ["qualitySystemVulns", "qualityReviewed", "qualityConfirmed", "qualitySameRoot", "qualityRefuted"].forEach(id => { $(id).textContent = "0"; });
  $("qualityFalsePositiveRate").textContent = "—";
  $("qualitySample").textContent = "样本 0";
  $("qualityRuleSuggestions").textContent = "尚未形成重复误报规则建议。";
  $("evidencePreview").textContent = "选择一份证据查看内容";
  $("promptSnapshotPreview").textContent = "选择一次模型调用查看实际上下文";
  $("leadsSummary").textContent = "待验证发现，超过 24 小时标记为积压；已转化漏洞会明确标记。";
  $("directionsSummary").textContent = "人工否决会将方向标记为“人工否决”并停止后续调度；审计记录和理由仍保留。";
  $("surfaceSummary").textContent = "已观察资产、配置、服务与入口；技术识别只属于攻击面，不会直接计为漏洞。";
  $("methodPackSummary").textContent = "尚未加载项目方法包。";
  $("evidenceSummary").textContent = "Fact 关联的原始文件、大小和 SHA-256。";
  $("technologyProfileSummary").textContent = "按应用资产汇总有证据来源的技术指纹。";
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
  applyRoute("config");
}

/* ---------- 8. 动作 ---------- */
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
  $("startAuditButton").disabled = true;
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
    navigate("run");
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
    // 批准后 Run ID 可能变化：立即以响应为准，即使随后的 refresh 失败也不保留旧 Run
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
    navigate("hub", { replace: true });
    if (!state.vendor) renderEmptyWorkspace();
    renderProjectList();
    applyRoute("hub");
    showToast(`项目 ${vendor} 已删除${state.vendor ? `，已选择 ${state.vendor}` : "，现在可以创建新任务"}`);
  } catch (error) {
    showToast(error.message, true);
    await loadProjects(vendor);
    applyRoute("hub");
  }
}

/* ---------- 事件绑定 ---------- */
$("refreshButton").addEventListener("click", refresh);
$("enterProjectButton").addEventListener("click", () => openProject());
$("newTaskButton").addEventListener("click", () => { prepareNewTask(); navigate("config"); });
$("returnHubButton").addEventListener("click", goToHub);
$("backConfigButton").addEventListener("click", () => requestRoute("config"));
$("viewRunButton").addEventListener("click", () => requestRoute("run"));
$("startAuditButton").addEventListener("click", launchAudit);
$("launchButton").addEventListener("click", launchAudit);
$("projectSelect").addEventListener("change", event => { if (selectVendor(event.target.value)) navigate("hub", { replace: true }); });
document.querySelectorAll("[data-route-link]").forEach(link => link.addEventListener("click", event => {
  event.preventDefault();
  if (link.classList.contains("disabled")) return;
  requestRoute(link.dataset.routeLink);
}));
// 任务中心：行点击进配置，按钮分流，删除走完整确认流程
$("projectList").addEventListener("click", async event => {
  const deleteButton = event.target.closest(".project-delete");
  if (deleteButton) { await deleteProject(deleteButton.dataset.vendor); return; }
  const openButton = event.target.closest(".project-open");
  if (openButton) {
    if (openButton.dataset.route === "run") {
      if (!selectVendor(openButton.dataset.vendor)) return;
      navigate("run");
      await refresh();
    } else {
      await openProject(openButton.dataset.vendor);
    }
    return;
  }
  const row = event.target.closest("tr[data-vendor]");
  if (row) await openProject(row.dataset.vendor);
});
// 结果标签与诊断标签
document.querySelector(".tab-nav").addEventListener("click", event => {
  const tab = event.target.closest(".tab");
  if (tab) selectTab(tab.dataset.tab);
});
document.querySelector(".diag-nav").addEventListener("click", event => {
  const tab = event.target.closest(".diag-tab");
  if (tab) selectDiag(tab.dataset.diag);
});
// 证据与 Prompt 预览（事件委托，路径一律 encodeURIComponent）
// 从详情面板点击证据时，先切到证据标签页再加载预览，避免在隐藏面板里更新
document.querySelector(".results-panel").addEventListener("click", async event => {
  const evidenceButton = event.target.closest(".evidence-open");
  if (!evidenceButton) return;
  const inDetail = Boolean(evidenceButton.closest(".detail-panel"));
  if (inDetail) selectTab("evidence");
  try { await openEvidence(evidenceButton.dataset.path, { scroll: !inDetail }); }
  catch (error) { showToast(error.message, true); }
});
$("promptSnapshotsBody").addEventListener("click", async event => {
  const button = event.target.closest(".prompt-snapshot-open");
  if (!button) return;
  try { await openPromptSnapshot(button.dataset.path); } catch (error) { showToast(error.message, true); }
});
$("expandTechnologyHosts").addEventListener("click", () => {
  document.querySelectorAll(".technology-host-group").forEach(group => {
    group.open = true;
    ui.expandedTechnologyHosts.add(group.dataset.hostname);
  });
});
$("collapseTechnologyHosts").addEventListener("click", () => {
  document.querySelectorAll(".technology-host-group").forEach(group => {
    group.open = false;
    ui.expandedTechnologyHosts.delete(group.dataset.hostname);
  });
});
$("downloadTechnologyXlsx").addEventListener("click", downloadTechnologyWorkbook);
$("downloadTechnologyCsv").addEventListener("click", () => downloadTechnologyProfile("csv"));
$("downloadTechnologyJson").addEventListener("click", () => downloadTechnologyProfile("json"));
// 运行控制
$("cancelButton").addEventListener("click", async () => {
  if (state.runId) await post("/api/automation/cancel", { run_id: state.runId, reason: "用户从 Web 控制台取消" }, () => "运行已取消");
});
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
// 方向人工否决/恢复：必须填写理由
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
// 人工漏洞裁决：必须填写理由，same_root 必须选主漏洞
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
  if (event.target.id === "mType" && event.target.value === "ollama") {
    showToast("Ollama 仅支持本地 CLI 模式，运行模式已自动切换为本地 CLI。");
  }
  if (event.target.id === "mType" && event.target.value === "container") {
    showToast("Container Worker 仅支持本地 Docker 模式，运行模式已锁定。");
  }
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
  const result = await api("/api/team-presets/apply", {
    method: "POST",
    body: JSON.stringify({ vendor: state.vendor, preset_id: preset.id }),
  });
  state.secretStatus = result.secret_status || {};
  state.teamDirty = false;
  renderTeamEditor(result.config, true);
  showToast(`已应用预设“${preset.name}”，项目团队快照已保存`);
});
$("saveAsTeamPresetButton").addEventListener("click", async () => {
  if (!state.vendor || !state.teamConfig) return showToast("请先创建并加载项目", true);
  try { requireValidTeamConfiguration(); }
  catch (error) { return showToast(error.message, true); }
  const name = window.prompt("请输入新团队预设名称：");
  if (name === null) return;
  if (!name.trim()) return showToast("预设名称不能为空", true);
  const result = await api("/api/team-presets/save", {
    method: "POST",
    body: JSON.stringify({
      vendor: state.vendor,
      name: name.trim(),
      config: collectTeamConfig(),
      secrets: collectRuntimeSecrets(),
    }),
  });
  updateTeamPresetState(result, result.preset.id);
  showToast(`已创建个人团队预设“${result.preset.name}”`);
});
$("updateTeamPresetButton").addEventListener("click", async () => {
  const preset = selectedTeamPreset();
  if (!state.vendor || !preset) return showToast("请先选择要更新的预设", true);
  try { requireValidTeamConfiguration(); }
  catch (error) { return showToast(error.message, true); }
  if (!window.confirm(`用当前项目团队覆盖预设“${preset.name}”？\n\n${summarizeTeamPresetDiff(preset.config, collectTeamConfig())}`)) return;
  const result = await api("/api/team-presets/save", {
    method: "POST",
    body: JSON.stringify({
      vendor: state.vendor,
      preset_id: preset.id,
      name: preset.name,
      config: collectTeamConfig(),
      secrets: collectRuntimeSecrets(),
    }),
  });
  updateTeamPresetState(result, preset.id);
  showToast(`预设“${preset.name}”已更新`);
});
$("defaultTeamPresetButton").addEventListener("click", async () => {
  const preset = selectedTeamPreset();
  if (!preset) return;
  const nextDefault = preset.is_default ? null : preset.id;
  const result = await api("/api/team-presets/default", {
    method: "POST",
    body: JSON.stringify({ preset_id: nextDefault }),
  });
  updateTeamPresetState(result, preset.id);
  showToast(nextDefault ? `“${preset.name}”已设为新项目默认预设` : "已取消个人默认预设");
});
$("duplicateTeamPresetButton").addEventListener("click", async () => {
  const preset = selectedTeamPreset();
  if (!preset) return;
  const name = window.prompt("请输入复制后的预设名称：", `${preset.name} 副本`);
  if (name === null) return;
  if (!name.trim()) return showToast("预设名称不能为空", true);
  const result = await api("/api/team-presets/duplicate", {
    method: "POST",
    body: JSON.stringify({ preset_id: preset.id, name: name.trim() }),
  });
  updateTeamPresetState(result, result.preset.id);
  showToast(`已复制为“${result.preset.name}”`);
});
$("renameTeamPresetButton").addEventListener("click", async () => {
  const preset = selectedTeamPreset();
  if (!preset) return;
  const name = window.prompt("请输入新的预设名称：", preset.name);
  if (name === null || name.trim() === preset.name) return;
  if (!name.trim()) return showToast("预设名称不能为空", true);
  const result = await api("/api/team-presets/rename", {
    method: "POST",
    body: JSON.stringify({ preset_id: preset.id, name: name.trim() }),
  });
  updateTeamPresetState(result, preset.id);
  showToast(`预设已重命名为“${name.trim()}”`);
});
$("deleteTeamPresetButton").addEventListener("click", async () => {
  const preset = selectedTeamPreset();
  if (!preset) return;
  if (!window.confirm(`确认删除个人预设“${preset.name}”？\n\n已应用到项目的团队快照不会受影响；该预设专属的钥匙串密钥别名会一并清除。`)) return;
  const result = await api("/api/team-presets/delete", {
    method: "POST",
    body: JSON.stringify({ preset_id: preset.id }),
  });
  updateTeamPresetState(result);
  showToast(`预设“${preset.name}”已删除`);
});
$("addRoleButton").addEventListener("click", () => {
  if (!state.vendor || !state.teamConfig?.members) return showToast("请先创建并加载项目", true);
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
  try { requireValidTeamConfiguration(); }
  catch (error) { return showToast(error.message, true); }
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
$("target-setup").addEventListener("input", event => {
  if (event.target.id === "newProjectName") return;
  if (event.target.closest(".team-editor")) return;
  if (event.target.closest(".asset-import-bar")) return;
  state.targetDirty = true;
  updateSaveBar();
});
$("targetProjectType").addEventListener("change", renderClientUpload);
$("clientArtifactFile").addEventListener("change", renderClientUpload);
$("importAssetInventoryButton").addEventListener(
  "click",
  () => uploadAssetInventoryFile(refresh),
);
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
  if (!state.vendor) return showToast("请先创建并选择客户端项目", true);
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
      body: JSON.stringify({
        vendor,
        target: collectTargetConfig(),
        preset_id: $("newProjectPreset").value,
      }),
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
    navigate("config", { replace: true });
    await refresh();
    showToast(`项目 ${result.vendor} 已创建，目标配置已生效`);
  } catch (error) {
    showToast(error.message, true);
    if (createdVendor) {
      await loadProjects(createdVendor);
      navigate("config", { replace: true });
      await refresh();
    }
  } finally { $("createProjectButton").disabled = false; $("createProjectButton").classList.remove("busy"); }
});
$("copyBoard").addEventListener("click", async () => {
  await navigator.clipboard.writeText($("blackboardText").textContent);
  showToast("黑板内容已复制");
});

/* ---------- 9. 启动 ---------- */
window.addEventListener("hashchange", async () => {
  const route = routeFromLocation();
  const requestedVendor = new URLSearchParams(location.search).get("vendor");
  if (state.route === "config" && route !== "config" && !canLeaveConfiguration()) { navigate("config", { replace: true }); return; }
  if (route === "config" && !requestedVendor) { prepareNewTask(); applyRoute("config"); return; }
  if (route === "run" && !requestedVendor) { navigate("hub", { replace: true }); return; }
  if (requestedVendor !== state.vendor) {
    if (!selectVendor(requestedVendor)) { navigate("hub", { replace: true }); return; }
  }
  applyRoute(route);
  if (route !== "hub" && state.vendor && !state.teamConfig) await refresh();
});
async function boot() {
  try {
    const initialRoute = routeFromLocation();
    const requestedVendor = new URLSearchParams(location.search).get("vendor");
    await loadProjects();
    if (initialRoute === "config" && !requestedVendor) { prepareNewTask(); navigate("config", { replace: true }); }
    else if (initialRoute === "run" && !requestedVendor) { navigate("hub", { replace: true }); }
    else if (initialRoute !== "hub" && state.vendor) {
      applyRoute(initialRoute);
      await refresh();
      navigate(initialRoute, { replace: true });
    }
    else {
      navigate("hub", { replace: true });
      if (!state.projects.length) { renderEmptyWorkspace(); renderProjectList(); applyRoute("hub"); showToast("请先创建第一个审计任务"); }
    }
    state.timer = setInterval(() => {
      if (state.route === "run") refreshRunTelemetry();
      else if (state.route === "hub") loadProjects(state.vendor).catch(error => showToast(error.message, true));
    }, 5000);
  } catch (error) {
    setConnectionStatus("连接异常", false);
    showToast(error.message, true);
  }
}
boot();
