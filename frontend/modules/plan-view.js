// 计划视图（实施方案 §11：任务依赖、委派角色、方法卡、结果；
// 可从任务跳到工具调用与证据）。
import { state, ui } from "./state.js";
import { $, el, cell, emptyRow } from "./dom.js";
import { chip } from "./ui.js";
import { formatEventTime } from "./format.js";

const DIRECTION_STATUS_LABELS = {
  open: "开放", queued: "排队", claimed: "已认领", waiting: "等待",
  completed: "完成", dismissed: "已否决", cancelled: "已取消", failed: "失败",
};

function directionStatusLabel(value) {
  return DIRECTION_STATUS_LABELS[String(value || "").toLowerCase()] || value || "—";
}

function roleTag(role) {
  return chip(role || "未委派", role ? "" : "warn");
}

function skillTags(skills, snapshot) {
  const wrap = el("div", "skill-tags");
  (skills || []).forEach(id => {
    const pinned = (snapshot || {})[id] || {};
    const tag = el("span", "pill", `${id}${pinned.version ? ` v${pinned.version}` : ""}`);
    tag.title = pinned.content_sha256
      ? `版本已固定 · sha ${String(pinned.content_sha256).slice(0, 12)}`
      : "方法卡（快照未固定）";
    wrap.append(tag);
  });
  if (!(skills || []).length) wrap.append(el("small", "text-dim", "无方法卡"));
  return wrap;
}

export function renderPlanView(planData, handlers = {}) {
  const data = planData || {};
  const plans = data.plans || [];
  const directions = data.directions || [];
  const skillCards = data.skill_cards || {};
  $("plansSummary").textContent = `${plans.length} 个计划版本 · ${directions.length} 个任务方向`;

  const batchesBody = $("planBatchesBody");
  batchesBody.replaceChildren();
  if (!plans.length) {
    emptyRow(batchesBody, 5, "尚无 planner 提交的计划图（等待第一个运行）");
  } else {
    plans.forEach(plan => {
      const row = el("tr");
      row.append(cell(plan.plan_id, "mono"));
      row.append(cell(plan.strategy_summary || "—"));
      row.append(cell(plan.proposed_by || "—"));
      row.append(cell(String(plan.task_count ?? "—"), "num"));
      row.append(cell(formatEventTime(plan.created_at)));
      batchesBody.append(row);
    });
  }

  const tasksBody = $("planTasksBody");
  const selected = ui.selected.plans;
  tasksBody.replaceChildren();
  if (!directions.length) {
    emptyRow(tasksBody, 5, "尚无任务（计划提交后按目标生成方向）");
  } else {
    directions.forEach(direction => {
      const row = el("tr");
      if (String(direction.id) === String(selected)) row.classList.add("selected");
      row.dataset.directionId = direction.id;
      const head = cell("");
      head.append(el("strong", "", direction.id));
      const deps = direction.depends_on || [];
      if (deps.length) {
        head.append(el("small", "text-dim", `依赖 ${deps.map(item => `${item.id}(${directionStatusLabel(item.status)})`).join("、")}`));
      } else {
        head.append(el("small", "text-dim", "无依赖"));
      }
      row.append(head);
      row.append(cell(direction.verb || "—"));
      row.append(cell(direction.target || "—"));
      const roleCell = cell("");
      roleCell.append(roleTag(direction.assigned_role));
      if (direction.tool_ref?.tool_id) {
        roleCell.append(el("small", "text-dim mono", direction.tool_ref.tool_id));
      }
      row.append(roleCell);
      row.append(cell(directionStatusLabel(direction.status)));
      tasksBody.append(row);
    });
  }

  renderPlanTaskDetail(directions, skillCards, handlers);
}

export function renderPlanTaskDetail(directions, skillCards, handlers = {}) {
  const panel = $("planTaskDetail");
  const selectedId = ui.selected.plans;
  const direction = directions.find(item => String(item.id) === String(selectedId)) || null;
  panel.replaceChildren();
  if (!direction) {
    panel.append(el("div", "placeholder", directions.length ? "选择任务查看依赖、方法卡、工具调用与结果" : "尚无任务"));
    return;
  }
  const nodes = [];
  nodes.push(el("div", "detail-title", `${direction.id} · ${direction.verb || "task"}`));
  const chips = el("div", "detail-chips");
  chips.append(chip(directionStatusLabel(direction.status)));
  chips.append(roleTag(direction.assigned_role));
  if (direction.tool_ref?.tool_id) chips.append(chip(direction.tool_ref.tool_id, "info"));
  nodes.push(chips);
  nodes.push(el("div", "detail-meta", `${direction.target || "—"} · ${direction.hypothesis || direction.goal || ""}`));

  // 依赖
  const deps = direction.depends_on || [];
  const depWrap = el("div", "");
  if (deps.length) {
    deps.forEach(dep => {
      const line = el("div", "detail-link-row");
      line.append(el("span", `pill ${dep.status === "completed" ? "ok" : "warn"}`, `${dep.id} · ${directionStatusLabel(dep.status)}`));
      if (dep.target) line.append(el("small", "text-dim", dep.target));
      depWrap.append(line);
    });
  } else {
    depWrap.append(el("p", "", "无依赖（depends_on 为空）"));
  }
  nodes.push(detailBlock("任务依赖", depWrap));

  // 方法卡（含任务固定版本快照）
  const skillWrap = el("div", "");
  const skillIds = direction.skill_ids || [];
  skillWrap.append(skillTags(skillIds, direction.skill_snapshot));
  skillIds.forEach(id => {
    const card = skillCards[id];
    if (!card) return;
    const line = el("div", "skill-card-line");
    line.append(el("strong", "", `${card.title} v${card.version}`));
    line.append(el("small", "text-dim", card.description || ""));
    if (card.status !== "active") {
      line.append(el("small", "text-dim", `工具缺口：${(card.unavailable_capabilities || []).map(item => item.capability).join("、") || "未知"}`));
    }
    skillWrap.append(line);
  });
  nodes.push(detailBlock("方法卡", skillWrap));

  // 工具调用（可跳证据：output_summary 含 evidence 路径）
  const calls = direction.tool_calls || [];
  const callWrap = el("div", "");
  if (calls.length) {
    calls.forEach(call => {
      const line = el("div", "tool-call-line");
      line.append(el("span", `pill ${call.status === "ok" ? "ok" : "danger"}`, call.tool_id));
      line.append(el("small", "text-dim mono", call.tool_call_id));
      line.append(el("small", "text-dim", `${call.status} · ${call.duration_ms ?? "?"}ms`));
      const summary = el("small", "text-dim mono", String(call.output_summary || "").slice(0, 160));
      summary.title = String(call.output_summary || "");
      line.append(summary);
      callWrap.append(line);
    });
  } else {
    callWrap.append(el("p", "", "尚无工具调用记录（方向未被认领或未执行工具）"));
  }
  nodes.push(detailBlock("工具调用", callWrap));

  // 结果（跳转到发现）
  const results = direction.results || [];
  const resultWrap = el("div", "detail-links");
  if (results.length) {
    results.forEach(result => {
      const button = el("button", "detail-link", `${result.fact_id} · ${result.title}`);
      button.type = "button";
      button.addEventListener("click", () => handlers.openFinding?.(result));
      resultWrap.append(button);
    });
  } else {
    resultWrap.append(el("p", "", "该方向尚未产出事实"));
  }
  nodes.push(detailBlock("结果", resultWrap));

  if (direction.terminal_reason) {
    nodes.push(detailBlock("终止原因", el("p", "mono", direction.terminal_reason)));
  }
  panel.append(...nodes);
}

function detailBlock(label, node) {
  const wrap = el("div", "detail-section");
  wrap.append(el("span", "detail-label", label));
  wrap.append(node);
  return wrap;
}

export function initPlanView(handlers = {}) {
  $("planTasksBody").addEventListener("click", event => {
    const row = event.target.closest("tr[data-direction-id]");
    if (!row) return;
    ui.selected.plans = row.dataset.directionId;
    // 重新着色选中行并重绘详情
    $("planTasksBody").querySelectorAll("tr").forEach(item => item.classList.toggle("selected", item === row));
    handlers.rerenderDetail?.();
  });
}
