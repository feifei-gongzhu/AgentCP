// 工具健康检查与技能路由解释（实施方案 §11）。
// 失败按真实原因展示（capability_missing / 网关拒绝 / 引擎缺口），
// 不把失败统一显示成“AI 出错”。
import { state } from "./state.js";
import { $, el, cell, emptyRow, showToast } from "./dom.js";
import { api } from "./api.js";
import { chip } from "./ui.js";

export function renderToolsPanel(toolsData) {
  const data = toolsData || {};
  const engines = data.engines || {};
  const tools = data.tools || [];
  const skills = data.skills || [];

  const enginesBody = $("enginesBody");
  enginesBody.replaceChildren();
  const engineIds = Object.keys(engines);
  if (!engineIds.length) {
    emptyRow(enginesBody, 4, "无引擎适配器登记");
  } else {
    engineIds.forEach(id => {
      const engine = engines[id] || {};
      const row = el("tr");
      row.append(cell(id, "mono"));
      row.append(cell(engine.adapter || "—"));
      row.append(cell(engine.available ? "可用" : (engine.reason || "不可用"),
        engine.available ? "engine-ok" : "engine-gap"));
      const roles = [...new Set(tools.filter(tool => tool.id === id).flatMap(tool => tool.roles || []))];
      row.append(cell(roles.join("、") || "—"));
      enginesBody.append(row);
    });
  }

  const toolsBody = $("toolsBody");
  toolsBody.replaceChildren();
  if (!tools.length) {
    emptyRow(toolsBody, 5, "工具目录为空");
  } else {
    tools.forEach(tool => {
      const row = el("tr");
      row.append(cell(tool.id, "mono"));
      row.append(cell(String(tool.description || "").slice(0, 90)));
      const stateCell = cell("");
      if (!tool.implemented) {
        stateCell.append(chip("能力未接入", ""));
      } else if (tool.available) {
        stateCell.append(chip("可用", "ok"));
      } else {
        stateCell.append(chip("引擎缺口", "danger"));
        stateCell.append(el("small", "text-dim", String(tool.engine_gap || "").slice(0, 80)));
      }
      row.append(stateCell);
      row.append(cell(tool.visible_to_model ? "模型可见" : "不可见"));
      row.append(cell((tool.roles || []).join("、") || "—"));
      toolsBody.append(row);
    });
  }

  const skillsBody = $("skillsBody");
  skillsBody.replaceChildren();
  if (!skills.length) {
    emptyRow(skillsBody, 5, "无技能卡");
  } else {
    skills.forEach(skill => {
      const row = el("tr");
      row.append(cell(skill.skill_id, "mono"));
      row.append(cell(`v${skill.version}`));
      row.append(cell((skill.roles || []).join("、")));
      const statusCell = cell("");
      statusCell.append(chip(
        skill.status === "active" ? "可用" : "工具缺口",
        skill.status === "active" ? "ok" : "warn",
      ));
      if ((skill.unavailable_capabilities || []).length) {
        statusCell.append(el("small", "text-dim",
          skill.unavailable_capabilities.map(item => item.capability).join("、")));
      }
      row.append(statusCell);
      row.append(cell(String(skill.description || "").slice(0, 90)));
      skillsBody.append(row);
    });
  }
}

// ── 技能路由解释（为什么命中 / 为什么缺口）──────────────────────────
export function initRoutingPlayground() {
  const button = $("routingExplainButton");
  const input = $("routingFeaturesInput");
  const roleSelect = $("routingRoleSelect");
  const output = $("routingExplanation");
  if (!button || !input || !output) return;
  button.addEventListener("click", async () => {
    const features = input.value.split(/[\n,，]/).map(item => item.trim()).filter(Boolean);
    if (!features.length) {
      showToast("请先输入特征（逗号或换行分隔）", true);
      return;
    }
    output.replaceChildren(el("div", "text-dim", "正在解释路由…"));
    try {
      const params = new URLSearchParams();
      params.set("vendor", state.vendor || "");
      features.forEach(feature => params.append("features", feature));
      if (roleSelect?.value) params.set("role", roleSelect.value);
      const result = await api(`/api/skills/routing?${params.toString()}`);
      renderRoutingExplanation(output, result.explanation || {});
    } catch (error) {
      output.replaceChildren();
      output.append(el("div", "alert-error", error.message));
    }
  });
}

export function renderRoutingExplanation(container, explanation) {
  container.replaceChildren();
  if (explanation.note) container.append(el("p", "text-dim", explanation.note));
  const matches = explanation.matches || [];
  if (!matches.length) {
    container.append(el("div", "empty-state", "没有命中任何技能卡（记录为方法缺口，不伪造技能）"));
    return;
  }
  const list = el("div", "routing-list");
  matches.forEach(match => {
    const row = el("div", `routing-row ${match.status === "active" ? "ok" : "gap"}`);
    row.append(chip(
      match.status === "active" ? "命中" : "缺口",
      match.status === "active" ? "ok" : "warn",
    ));
    row.append(el("strong", "", `${match.skill_id}${match.version ? ` v${match.version}` : ""}`));
    if (match.score != null) row.append(el("small", "text-dim", `评分 ${match.score}`));
    const reasons = match.reasons || match.matched_features || [];
    if (reasons.length) row.append(el("small", "text-dim", Array.isArray(reasons) ? reasons.join("、") : String(reasons)));
    container.append(row);
  });
  container.append(list);
}
