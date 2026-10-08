// 资源仓库面板（实施方案 §7.2：五类分类管理，来源/许可/版本/哈希/启停/
// 导入验证/回滚；拒绝明文凭据导入由服务端强制）。
import { state } from "./state.js";
import { $, el, cell, emptyRow, showToast } from "./dom.js";
import { api } from "./api.js";
import { chip } from "./ui.js";
import { formatEventTime } from "./format.js";

const CATEGORY_LABELS = {
  fingerprint_rules: "指纹规则",
  js_clue_rules: "JS 线索规则",
  service_dictionaries: "服务字典",
  poc_templates: "POC 模板",
  skill_docs: "技能文档",
};

export function renderResourcesPanel(resourcesData, onChanged) {
  const data = resourcesData || {};
  const resources = data.resources || [];
  const status = data.status || {};
  const body = $("resourcesBody");
  const note = $("resourcesPanelNote");
  body.replaceChildren();
  const counts = status.categories || {};
  if (note) {
    note.textContent = Object.entries(counts)
      .map(([category, count]) => `${CATEGORY_LABELS[category] || category} ${count}`)
      .join(" · ");
  }
  if (!resources.length) {
    emptyRow(body, 7, "尚无资源（内置种子会在首次访问时登记）");
    return;
  }
  resources.forEach(entry => {
    const row = el("tr");
    row.append(cell(entry.id, "mono"));
    row.append(cell(CATEGORY_LABELS[entry.category] || entry.category));
    row.append(cell(`${entry.name} · v${entry.version ?? 1}`));
    const sourceCell = cell("");
    sourceCell.append(el("span", "", entry.source || "—"));
    if (entry.source_url) sourceCell.append(el("small", "text-dim mono", String(entry.source_url).slice(0, 40)));
    row.append(sourceCell);
    row.append(cell(entry.license || "—"));
    row.append(cell(String(entry.sha256 || "").slice(0, 12), "mono"));
    const actionCell = cell("");
    const toggle = el("button", `btn ghost sm`, entry.enabled ? "停用" : "启用");
    toggle.type = "button";
    toggle.addEventListener("click", async () => {
      toggle.disabled = true;
      try {
        await api("/api/resources/enabled", {
          method: "POST",
          body: JSON.stringify({ vendor: state.vendor, resource_id: entry.id, enabled: !entry.enabled }),
        });
        showToast(`${entry.name} 已${!entry.enabled ? "启用" : "停用"}`);
        if (onChanged) await onChanged();
      } catch (error) {
        showToast(error.message, true);
      } finally {
        toggle.disabled = false;
      }
    });
    actionCell.append(toggle);
    if (Number(entry.version ?? 1) > 1) {
      const rollback = el("button", "btn danger sm", "回滚");
      rollback.type = "button";
      rollback.title = "回退到上一版本（当前版本保留在历史）";
      rollback.addEventListener("click", async () => {
        rollback.disabled = true;
        try {
          const result = await api("/api/resources/rollback", {
            method: "POST",
            body: JSON.stringify({ vendor: state.vendor, resource_id: entry.id }),
          });
          showToast(`已回滚到 v${result.entry?.version ?? "?"}`);
          if (onChanged) await onChanged();
        } catch (error) {
          showToast(error.message, true);
        } finally {
          rollback.disabled = false;
        }
      });
      actionCell.append(rollback);
    }
    row.append(actionCell);
    row.title = `导入 ${formatEventTime(entry.imported_at)} · by ${entry.imported_by || "—"} · sha256 ${entry.sha256 || "?"}`;
    body.append(row);
  });
}

export function initResourceImport(onChanged) {
  const button = $("resourceImportButton");
  if (!button) return;
  button.addEventListener("click", async () => {
    const payload = {
      vendor: state.vendor,
      category: $("resourceCategorySelect").value,
      resource_id: $("resourceIdInput").value.trim(),
      name: $("resourceNameInput").value.trim(),
      source: $("resourceSourceInput").value.trim(),
      source_url: $("resourceUrlInput").value.trim(),
      license: $("resourceLicenseInput").value.trim(),
      content: $("resourceContentInput").value,
      enabled: true,
    };
    if (!payload.resource_id || !payload.name || !payload.source || !payload.license) {
      showToast("资源 ID、名称、来源与许可均必填（来源/许可不明不得进入研究闭环）", true);
      return;
    }
    if (!payload.content.trim()) {
      showToast("请粘贴资源内容（JSON）", true);
      return;
    }
    button.disabled = true;
    try {
      const result = await api("/api/resources/import", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      showToast(`已导入 ${result.entry.name} v${result.entry.version}（sha256 ${String(result.entry.sha256).slice(0, 10)}）`);
      $("resourceContentInput").value = "";
      if (onChanged) await onChanged();
    } catch (error) {
      showToast(error.message, true);
    } finally {
      button.disabled = false;
    }
  });
}
