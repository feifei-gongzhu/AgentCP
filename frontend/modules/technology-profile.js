import { state, ui } from "./state.js";
import { $, cell, el, showToast } from "./dom.js";
import { percent } from "./format.js";

export function technologyHostname(value) {
  try {
    return new URL(String(value || "")).hostname.toLowerCase() || "未知主机";
  } catch (_error) {
    return "未知主机";
  }
}

export function groupTechnologyProfile(profile) {
  const groups = new Map();
  (Array.isArray(profile) ? profile : []).forEach(item => {
    const hostname = technologyHostname(item.url);
    if (!groups.has(hostname)) groups.set(hostname, []);
    groups.get(hostname).push(item);
  });
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([hostname, items]) => [
      hostname,
      items.sort((left, right) => String(left.url || "").localeCompare(String(right.url || ""))),
    ]);
}

export function technologyStatusLabel(value) {
  return ({
    confirmed: "已确认",
    suspected: "疑似",
    conflict: "版本冲突",
    reported: "模型报告",
  })[value] || value || "模型报告";
}

export function renderTechnologyProfile(profile, routineGroups = []) {
  const container = $("technologyProfileList");
  container.replaceChildren();
  const rows = Array.isArray(profile) ? profile : [];
  const actionable = rows.filter(item => item.profile_class !== "routine_network_info");
  const groups = groupTechnologyProfile(actionable);
  const routines = Array.isArray(routineGroups) ? routineGroups : [];
  $("technologyProfileCount").textContent = String(rows.length);
  $("technologyProfileSummary").textContent = rows.length || routines.length
    ? `${groups.length} 个主机名 · ${actionable.filter(item => item.profile_class === "priority_target").length} 个优先目标 · ${routines.reduce((sum, item) => sum + Number(item.member_count || 0), 0)} 条常规网络信息。`
    : "尚未形成目标画像；请在团队配置中启用“目标画像采集”角色后启动运行。";
  if (!rows.length && !routines.length) {
    container.append(el("div", "empty-state", "尚未发现可下载的目标功能。"));
    return;
  }
  groups.forEach(([hostname, items]) => {
    const details = document.createElement("details");
    details.className = "technology-host-group";
    details.title = "按主机名折叠";
    details.dataset.hostname = hostname;
    details.open = ui.expandedTechnologyHosts.has(hostname);
    const technologies = new Set(items.flatMap(item =>
      (item.technologies || []).map(technology => technology.technology).filter(Boolean)
    ));
    const summary = document.createElement("summary");
    const identity = el("span", "technology-host-identity");
    identity.append(el("strong", "mono", hostname), el("small", "", `${items.length} 个 URL`));
    summary.append(identity, el("span", "technology-host-meta", `${technologies.size} 项技术`));
    details.append(summary);

    const tableWrap = el("div", "table-wrap");
    const table = el("table", "data-table technology-profile-table");
    const head = document.createElement("thead");
    const headRow = document.createElement("tr");
    ["评分", "URL", "功能与标签", "技术与验证"].forEach(label => {
      const node = document.createElement("th");
      node.textContent = label;
      headRow.append(node);
    });
    head.append(headRow);
    const body = document.createElement("tbody");
    items.forEach(item => {
      const row = document.createElement("tr");
      const score = item.profile_class === "priority_target" && item.target_score != null
        ? String(item.target_score)
        : "—";
      const urlCell = cell(item.url, "mono target-profile-url");
      urlCell.title = item.url || "";
      const technologyCell = cell("", "technology-stack");
      const technologyList = el("div", "technology-list");
      const itemTechnologies = Array.isArray(item.technologies) ? item.technologies : [];
      if (!itemTechnologies.length) {
        technologyList.append(el("span", "", "尚未识别"));
      } else {
        itemTechnologies.forEach(technology => {
          const entry = el("div", "technology-item");
          entry.append(el(
            "strong",
            "",
            `${technology.technology || "未知技术"}${technology.version ? ` ${technology.version}` : ""}`,
          ));
          entry.append(el(
            "span",
            `technology-status ${technology.verification_status || "reported"}`,
            technologyStatusLabel(technology.verification_status),
          ));
          const metadata = [];
          if (technology.confidence != null) metadata.push(`置信度 ${percent(technology.confidence)}`);
          if ((technology.evidence_paths || []).length) metadata.push(`${technology.evidence_paths.length} 份证据`);
          if (metadata.length) entry.append(el("small", "", metadata.join(" · ")));
          technologyList.append(entry);
        });
      }
      technologyCell.append(technologyList);
      const functionCell = cell("", "target-profile-function");
      functionCell.append(el("strong", "", item.function || "未说明"));
      const tags = Array.isArray(item.risk_tags) ? item.risk_tags : [];
      if (tags.length) functionCell.append(el("small", "", tags.join(" · ")));
      if (item.score_reason) functionCell.append(el("small", "", item.score_reason));
      row.append(cell(score, "target-score"), urlCell, functionCell, technologyCell);
      body.append(row);
    });
    table.append(head, body);
    tableWrap.append(table);
    details.append(tableWrap);
    details.addEventListener("toggle", () => {
      if (details.open) ui.expandedTechnologyHosts.add(hostname);
      else ui.expandedTechnologyHosts.delete(hostname);
    });
    container.append(details);
  });
  if (routines.length) {
    const details = document.createElement("details");
    details.className = "technology-host-group routine-network-groups";
    const total = routines.reduce((sum, item) => sum + Number(item.member_count || 0), 0);
    const summary = document.createElement("summary");
    summary.append(
      el("strong", "", "常规网络信息"),
      el("span", "technology-host-meta", `${total} 条 · 不评分`),
    );
    details.append(summary);
    const wrap = el("div", "table-wrap");
    const table = el("table", "data-table technology-profile-table");
    const head = document.createElement("thead");
    const headerRow = document.createElement("tr");
    ["分类", "数量", "主机", "URL 模式", "代表 URL"].forEach(label => {
      const node = document.createElement("th"); node.textContent = label; headerRow.append(node);
    });
    head.append(headerRow);
    const body = document.createElement("tbody");
    routines.forEach(item => {
      const row = document.createElement("tr");
      row.append(
        cell(item.label || "常规网络信息"),
        cell(String(item.member_count || 0), "num"),
        cell(item.hostname || "—", "mono"),
        cell(item.url_pattern || "—", "mono"),
        cell((item.representative_urls || []).join("\n") || "—", "mono"),
      );
      body.append(row);
    });
    table.append(head, body); wrap.append(table); details.append(wrap); container.append(details);
  }
}

function saveTechnologyBlob(blob, extension) {
  const link = document.createElement("a");
  const blobUrl = URL.createObjectURL(blob);
  link.href = blobUrl;
  link.download = `${state.vendor || "target"}-technology-profile.${extension}`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 0);
}

export async function downloadTechnologyWorkbook() {
  const rows = Array.isArray(state.projectData?.enriched_target_profile)
    ? state.projectData.enriched_target_profile
    : [];
  if (!rows.length) return showToast("当前没有可下载的目标画像", true);
  const button = $("downloadTechnologyXlsx");
  button.classList.add("busy");
  try {
    const vendor = encodeURIComponent(state.vendor);
    const response = await fetch(`/api/target-profile/export?vendor=${vendor}`);
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || `HTTP ${response.status}`);
    }
    saveTechnologyBlob(await response.blob(), "xlsx");
    showToast("Excel 已按主机名分工作表下载");
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.classList.remove("busy");
  }
}

export function downloadTechnologyProfile(format) {
  const rows = Array.isArray(state.projectData?.enriched_target_profile)
    ? state.projectData.enriched_target_profile
    : [];
  if (!rows.length) return showToast("当前没有可下载的目标画像", true);
  let body;
  let type;
  if (format === "json") {
    body = JSON.stringify(rows.map(item => ({
      url: item.url,
      function: item.function,
      profile_class: item.profile_class,
      target_score: item.target_score,
      risk_tags: item.risk_tags || [],
      score_reason: item.score_reason || "",
      recommended_tests: item.recommended_tests || [],
      technologies: item.technologies || [],
    })), null, 2);
    type = "application/json;charset=utf-8";
  } else {
    const quote = value => {
      let text = String(value ?? "");
      if (/^[=+\-@]/.test(text)) text = `'${text}`;
      return `"${text.replaceAll('"', '""')}"`;
    };
    body = "\uFEFF" + [
      ["评分", "目标分类", "URL", "功能", "风险标签", "评分依据", "建议测试", "技术", "版本", "类别", "验证状态", "置信度", "证据路径"],
      ...rows.flatMap(item => {
        const technologies = item.technologies || [];
        return (technologies.length ? technologies : [{}]).map(technology => [
          item.target_score == null ? "" : item.target_score,
          item.profile_class || "needs_review",
          item.url,
          item.function,
          (item.risk_tags || []).join("; "),
          item.score_reason || "",
          (item.recommended_tests || []).join("; "),
          technology.technology || "",
          technology.version || "",
          technology.category || "",
          technologyStatusLabel(technology.verification_status),
          technology.confidence == null ? "" : technology.confidence,
          (technology.evidence_paths || []).join("; "),
        ]);
      }),
    ].map(row => row.map(quote).join(",")).join("\r\n");
    type = "text/csv;charset=utf-8";
  }
  saveTechnologyBlob(new Blob([body], { type }), format);
}
