// 七角色卡与团队迁移（实施方案 §11 / §10，P4）。
// 角色卡七要素：职责 / 模型 / 运行时 / 能力 / 技能 / 当前任务 / 健康状态。
import { state } from "./state.js";
import { $, el, cell, emptyRow, showToast } from "./dom.js";
import { api } from "./api.js";
import { chip } from "./ui.js";

export const HEALTH_LABELS = {
  ready: "就绪",
  running: "执行中",
  waiting_dependency: "等待依赖",
  no_matching_task: "无匹配任务",
  capability_missing: "能力缺失",
  blocked: "受阻",
  disabled: "未启用",
};
const HEALTH_TONES = {
  ready: "ok",
  running: "info",
  waiting_dependency: "warn",
  no_matching_task: "",
  capability_missing: "danger",
  blocked: "danger",
  disabled: "",
};

export function healthChip(health) {
  return chip(HEALTH_LABELS[health] || health, HEALTH_TONES[health] || "");
}

function kv(label, value, title) {
  const row = el("div", "kv");
  row.append(el("span", "", label));
  const strong = el("b", "", value);
  if (title) strong.title = title;
  row.append(strong);
  return row;
}

export function roleCard(card) {
  const node = el("article", `role-card tone-${HEALTH_TONES[card.health] || ""}`);
  node.dataset.role = card.role;

  const head = el("div", "role-card-head");
  head.append(el("strong", "", `${card.display_name} · ${card.role}`));
  head.append(healthChip(card.health));
  node.append(head);

  node.append(el("p", "role-duty", card.duty));
  node.append(el("p", "role-deliverable text-dim", `产出：${card.deliverable}`));

  const member = card.member;
  const modelLine = member
    ? `${member.type || "codex"} · ${member.model || "默认模型"}`
    : "未配置成员";
  node.append(kv("模型", modelLine));
  node.append(kv(
    "运行时",
    member ? `${member.runtime_mode || "local-docker"} / ${member.sandbox || "read-only"}` : "—",
  ));

  const caps = card.capabilities || {};
  const capRow = el("div", "role-caps");
  const missing = caps.missing || [];
  const capText = `${(caps.effective || []).length}/${(caps.all || []).length} 项能力可用`;
  capRow.append(el("span", "text-dim", "能力"));
  const capStrong = el("b", "", capText);
  if ((caps.all || []).length) {
    capStrong.title = `白名单：${(caps.all || []).join("、")}`;
  }
  capRow.append(capStrong);
  if (missing.length) {
    capRow.append(el("small", "text-dim", `缺口：${missing.join("、")}`));
  }
  node.append(capRow);

  const skills = card.skills || [];
  const skillRow = el("div", "role-skills");
  skillRow.append(el("span", "text-dim", "技能"));
  if (skills.length) {
    skills.forEach(skill => {
      const tag = el("span", `pill${skill.status === "active" ? " ok" : " warn"}`, skill.title || skill.skill_id);
      tag.title = `${skill.skill_id} v${skill.version} · ${skill.status === "active" ? "可用" : "工具缺口"}`;
      skillRow.append(tag);
    });
  } else {
    skillRow.append(el("small", "text-dim", "无专属技能卡"));
  }
  node.append(skillRow);

  const tasks = (card.current_tasks || []).filter(task => ["running", "queued", "cancelling", "failed"].includes(task.status));
  const taskRow = el("div", "role-tasks");
  taskRow.append(el("span", "text-dim", "当前任务"));
  if (tasks.length) {
    tasks.slice(0, 3).forEach(task => {
      const line = el("small", "", `${task.status} · ${task.verb || "task"} ${task.target || ""}`);
      if (task.error) line.title = task.error;
      taskRow.append(line);
    });
    if (tasks.length > 3) taskRow.append(el("small", "text-dim", `另有 ${tasks.length - 3} 个`));
  } else {
    taskRow.append(el("small", "text-dim", "无进行中任务"));
  }
  node.append(taskRow);

  const reason = el("p", "role-health-reason");
  const engines = Object.entries(card.engine_states || {});
  if (engines.length) {
    engines.forEach(([capability, engineState]) => {
      if (!engineState.available) {
        const gapLine = el("small", "text-dim", `${capability}：${engineState.reason || "适配器不可用"}`);
        reason.append(gapLine);
      }
    });
  }
  reason.append(el("small", "", card.health_reason));
  node.append(reason);
  return node;
}

export function renderRoleCards(health) {
  const wrap = $("roleCards");
  const note = $("roleCardsNote");
  if (!wrap) return;
  const cards = health?.roles || [];
  wrap.replaceChildren();
  if (!cards.length) {
    wrap.append(el("div", "empty-state", "尚无角色健康数据（先创建项目）"));
  } else {
    cards.forEach(card => wrap.append(roleCard(card)));
  }
  if (note) {
    const counts = {};
    cards.forEach(card => { counts[card.health] = (counts[card.health] || 0) + 1; });
    note.textContent = cards.length
      ? Object.entries(counts).map(([key, count]) => `${HEALTH_LABELS[key] || key} ${count}`).join(" · ")
      : "";
  }
}

// ── 运行视图：角色分工（紧凑条） ────────────────────────────────────
export function renderRunRoleBreakdown(health, automation) {
  const wrap = $("runRoleBreakdown");
  if (!wrap) return;
  wrap.replaceChildren();
  const cards = health?.roles || [];
  if (!cards.length) {
    wrap.append(el("div", "empty-state", "尚无角色数据"));
    return;
  }
  const jobs = automation?.jobs || [];
  cards.forEach(card => {
    const node = el("div", `role-strip-item tone-${HEALTH_TONES[card.health] || ""}`);
    node.append(el("strong", "", card.display_name));
    node.append(healthChip(card.health));
    const roleJobs = jobs.filter(job => String(job.role) === card.role);
    const running = roleJobs.filter(job => ["running", "queued"].includes(job.status)).length;
    const done = roleJobs.filter(job => job.status === "completed").length;
    node.append(el("small", "text-dim", running ? `执行中 ${running}` : done ? `本轮完成 ${done}` : "空闲"));
    node.title = card.health_reason;
    wrap.append(node);
  });
}

// ── 旧团队迁移（§10）───────────────────────────────────────────────
const ROLE_MIGRATION_HINT = {
  reason: "→ planner（主要继承者，复制模型配置与专属 Prompt）",
  metacog: "→ planner（反事实/盲点检查并入规划阶段）",
  executor: "→ operator（主要）/recon/crack/poc",
  waf_analyst: "→ operator 专项技能 + planner 重规划",
  profile_mapper: "→ recon（画像服务已内置）",
  reviewer: "→ reviewer（新语义：action/finding review）",
};

export function renderMigrationPanel(preview, onChanged) {
  const wrap = $("migrationPanel");
  const section = $("migrationSection");
  if (!wrap || !section) return;
  const legacyCount = Number(preview?.legacy_member_count || 0);
  const archive = preview?.archive || null;
  const showPanel = Boolean(legacyCount || archive || preview?.needed);
  section.hidden = !showPanel;
  wrap.replaceChildren();
  if (!showPanel) return;

  if (legacyCount) {
    const intro = el("p", "", `检测到 ${legacyCount} 个旧六角色成员；迁移到七角色团队前请先阅读预览。`);
    wrap.append(intro);
    const table = el("div", "table-scroll");
    const tbody = el("tbody");
    (preview.mappings || []).forEach(mapping => {
      const row = el("tr");
      row.append(cell(`${mapping.member_name} · ${mapping.legacy_role}`));
      row.append(cell(ROLE_MIGRATION_HINT[mapping.legacy_role] || `→ ${mapping.primary_target}`));
      row.append(cell(mapping.prompt_copied ? "复制" : "归档不复制"));
      row.append(cell((mapping.manual_steps || []).join("；") || "—"));
      tbody.append(row);
    });
    const thead = el("thead");
    const headRow = el("tr");
    ["旧成员", "迁移映射", "专属 Prompt", "需要人工适配"].forEach(title => headRow.append(el("th", "", title)));
    thead.append(headRow);
    const tableNode = el("table", "dt");
    tableNode.append(thead, tbody);
    table.append(tableNode);
    wrap.append(table);
    (preview.notes || []).forEach(note => wrap.append(el("p", "text-dim", note)));
    if (preview.active_run) {
      const warn = el("p", "alert-error", `运行 ${preview.active_run.run_id} 处于 ${preview.active_run.status}：${preview.active_run.reason}`);
      wrap.append(warn);
    }
    const actions = el("div", "btn-group");
    const execute = el("button", "btn primary sm", "执行迁移");
    execute.type = "button";
    execute.addEventListener("click", async () => {
      if (!window.confirm("确认执行迁移？原团队配置会保存回退副本；运行中的旧 Run 不会被热切换。")) return;
      execute.disabled = true;
      try {
        const result = await api("/api/team/migration", {
          method: "POST",
          body: JSON.stringify({ vendor: state.vendor, action: "execute" }),
        });
        showToast(result.executed
          ? `迁移完成；回退副本在 ${result.archive_dir}`
          : "团队已是七角色配置，未重复迁移（幂等）");
        if (onChanged) await onChanged();
      } catch (error) {
        showToast(error.message, true);
      } finally {
        execute.disabled = false;
      }
    });
    actions.append(execute);
    wrap.append(actions);
  } else if (archive) {
    wrap.append(el("p", "", `项目曾执行过迁移（${archive.migrated_at || "时间未知"}）；当前团队无旧角色。`));
  }

  if (archive) {
    const rollbackBox = el("div", "migration-rollback");
    rollbackBox.append(el("p", "text-dim", `回退副本：${archive.archive_dir}${archive.rolled_back ? "（已回退）" : ""}`));
    const rollback = el("button", "btn danger sm", "回退团队配置");
    rollback.type = "button";
    rollback.disabled = Boolean(archive.rolled_back);
    rollback.addEventListener("click", async () => {
      if (!window.confirm("确认回退？只恢复团队配置文件；迁移期间产生的新证据与数据库保持原样。")) return;
      try {
        const result = await api("/api/team/migration", {
          method: "POST",
          body: JSON.stringify({ vendor: state.vendor, action: "rollback" }),
        });
        showToast(`已从 ${result.archive_dir} 恢复团队配置`);
        if (onChanged) await onChanged();
      } catch (error) {
        showToast(error.message, true);
      }
    });
    rollbackBox.append(rollback);
    wrap.append(rollbackBox);
  }
}

export function renderRunBlockPanel(health, automation) {
  const wrap = $("runBlockPanel");
  if (!wrap) return;
  wrap.replaceChildren();
  const jobs = automation?.jobs || [];
  const failed = jobs.filter(job => job.status === "failed");
  const blockedRoles = (health?.roles || []).filter(card =>
    ["blocked", "capability_missing", "waiting_dependency"].includes(card.health)
  );
  const cancelEvents = (automation?.events || []).filter(event =>
    String(event.event_type || "").includes("cancel") || String(event.event_type || "").includes("stop")
  ).slice(0, 5);
  const run = automation?.run || null;
  const blocks = [];
  failed.forEach(job => {
    blocks.push(`任务 ${job.id}（${job.role}）失败：${String(job.error || "未知错误").slice(0, 160)}`);
  });
  blockedRoles.forEach(card => blocks.push(`${card.display_name}：${card.health_reason}`));
  if (run && ["cancelled", "stopped"].includes(run.status)) {
    blocks.unshift(`运行 ${run.id} 已${run.status === "cancelled" ? "取消" : "停止"}：${run.error || "原因未记录"}`);
  }
  cancelEvents.forEach(event => {
    const data = event.data || {};
    blocks.push(`${event.event_type}：${data.reason || "（无原因记录）"}`);
  });
  if (!blocks.length) {
    wrap.append(el("div", "empty-state", "当前没有阻塞或取消记录"));
    return;
  }
  const list = el("ul", "block-list");
  blocks.slice(0, 12).forEach(text => list.append(el("li", "", text)));
  wrap.append(list);
}
