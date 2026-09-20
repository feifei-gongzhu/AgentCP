import { state } from "./state.js";
import { $, cell, emptyRow, showToast } from "./dom.js";

export function renderAssetInventory(payload) {
  const summary = payload?.summary || {};
  const statuses = summary.by_status || {};
  const tasks = summary.profile_tasks || {};
  const assets = Array.isArray(payload?.assets) ? payload.assets : [];
  const pagination = payload?.pagination || {};
  state.assetInventory = payload || null;
  state.assetOffset = Number(pagination.offset || 0);
  $("assetInventoryBadge").textContent = `${summary.total || 0} assets`;
  $("assetInventoryTotal").textContent = String(summary.total || 0);
  $("assetInventoryPending").textContent = String((tasks.pending || 0) + (tasks.failed || 0));
  $("assetInventoryProfiled").textContent = String((tasks.profiled || 0) + (tasks.partial || 0));
  $("assetInventoryOutOfScope").textContent = String(statuses.out_of_scope || 0);
  $("assetInventoryNote").textContent = summary.imports
    ? `${summary.imports} 个导入版本 · ${summary.active_candidates || 0} 个当前候选 · ${summary.relations || 0} 条发现关系`
    : "尚未导入企业资产文件；手工填写的测试目标会自动进入资产底座。";

  const body = $("assetInventoryBody");
  const total = Number(pagination.total ?? summary.total ?? 0);
  const count = Number(pagination.count ?? assets.length);
  const offset = Number(pagination.offset || 0);
  $("assetPaginationText").textContent = count
    ? `当前 ${offset + 1}–${offset + count} 条，共 ${total} 条`
    : `当前没有资产，共 ${total} 条`;
  $("assetPreviousPage").disabled = offset <= 0;
  $("assetNextPage").disabled = !pagination.has_more;
  if (!assets.length) {
    emptyRow(body, 6, "当前没有归一化资产。");
    return;
  }
  body.replaceChildren();
  assets.forEach(asset => {
    const row = document.createElement("tr");
    const endpoint = asset.canonical_url || asset.hostname || asset.ip_address || asset.endpoint_key;
    row.append(
      cell(endpoint, "mono"),
      cell(asset.asset_type || "unknown"),
      cell(asset.status || "unknown"),
      cell(asset.profile_status || "—"),
      cell(String(asset.url_count || 0)),
      cell(String(asset.provenance_count || 0)),
    );
    body.append(row);
  });
}

export async function uploadAssetInventoryFile(refresh) {
  if (!state.vendor) {
    showToast("请先创建并选择项目", true);
    return;
  }
  const file = $("assetInventoryFile").files?.[0];
  if (!file) {
    showToast("请选择资产文件", true);
    return;
  }
  const logicalSource = $("assetLogicalSource").value.trim() || file.name;
  const query = new URLSearchParams({
    vendor: state.vendor,
    filename: file.name,
    logical_source: logicalSource,
    source_type: "official",
  });
  const button = $("importAssetInventoryButton");
  button.disabled = true;
  button.classList.add("busy");
  try {
    const response = await fetch(`/api/assets/import?${query}`, {
      method: "POST",
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: file,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || `HTTP ${response.status}`);
    }
    $("assetInventoryFile").value = "";
    showToast(payload.import?.duplicate
      ? "该来源的相同文件已经导入，无需重复处理"
      : `资产导入完成：${payload.import?.asset_count || 0} 个统一资产`);
    state.assetOffset = 0;
    await refresh();
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.disabled = false;
    button.classList.remove("busy");
  }
}
