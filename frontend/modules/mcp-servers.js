// 外部 MCP 服务器面板（实施方案 §9、§12-P5）：注册条目（transport/连接
// 配置引用/enabled/visible_roles/健康状态/工具缓存/版本）列表 + 注册表单 +
// 健康检查/启停/移除。可见性由服务端强制，本面板只是操作入口。
import { state } from "./state.js";
import { $, el, cell, emptyRow, showToast } from "./dom.js";
import { api } from "./api.js";
import { chip } from "./ui.js";
import { formatEventTime } from "./format.js";

const HEALTH_TONE = { healthy: "ok", unhealthy: "bad", unknown: "" };

function parseVisibleRoles(raw) {
  return raw.split(/[,，]/).map(item => item.trim()).filter(Boolean);
}

export function renderMcpServersPanel(data, onChanged) {
  const servers = (data && data.servers) || [];
  const body = $("mcpServersBody");
  const note = $("mcpServersPanelNote");
  body.replaceChildren();
  if (note) {
    const healthy = servers.filter(item => (item.health || {}).status === "healthy").length;
    note.textContent = servers.length
      ? `共 ${servers.length} 个 · 健康 ${healthy}`
      : "尚无外部 MCP 服务器";
  }
  if (!servers.length) {
    emptyRow(body, 7, "尚未注册（stdio 命令或 http 端点；visible_roles 服务端强制）");
    return;
  }
  servers.forEach(entry => {
    const row = el("tr");
    row.append(cell(entry.id, "mono"));
    row.append(cell(entry.transport || "—"));
    row.append(cell(entry.name || "—"));
    const rolesCell = cell("");
    (entry.visible_roles || []).forEach(role => rolesCell.append(chip(role)));
    row.append(rolesCell);
    const healthCell = cell("");
    const health = entry.health || {};
    healthCell.append(chip(health.status || "unknown", HEALTH_TONE[health.status] || ""));
    if (health.checked_at) {
      healthCell.append(el("small", "text-dim", formatEventTime(health.checked_at)));
    }
    row.append(healthCell);
    const cache = entry.tool_cache || {};
    const cacheCell = cell("");
    cacheCell.append(el("span", "", `${(cache.tools || []).length} 个工具`));
    if (cache.server_version || cache.server_name) {
      cacheCell.append(el("small", "text-dim mono", `${cache.server_name || "?"} ${cache.server_version || ""}`.trim()));
    }
    row.append(cacheCell);
    const actionCell = cell("");
    const check = el("button", "btn ghost sm", "健康检查");
    check.type = "button";
    check.title = "真实握手（initialize + tools/list）并刷新工具缓存";
    check.addEventListener("click", async () => {
      check.disabled = true;
      try {
        const result = await api("/api/mcp/servers/health", {
          method: "POST",
          body: JSON.stringify({ vendor: state.vendor, id: entry.id }),
        });
        const status = (result.entry?.health || {}).status || "?";
        showToast(`健康检查完成：${status === "healthy" ? "健康" : `异常（${status}）`}`, status !== "healthy");
        if (onChanged) await onChanged();
      } catch (error) {
        showToast(error.message, true);
      } finally {
        check.disabled = false;
      }
    });
    actionCell.append(check);
    const toggle = el("button", "btn ghost sm", entry.enabled ? "停用" : "启用");
    toggle.type = "button";
    toggle.addEventListener("click", async () => {
      toggle.disabled = true;
      try {
        await api("/api/mcp/servers/enabled", {
          method: "POST",
          body: JSON.stringify({ vendor: state.vendor, id: entry.id, enabled: !entry.enabled }),
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
    const remove = el("button", "btn danger sm", "移除");
    remove.type = "button";
    remove.addEventListener("click", async () => {
      if (!window.confirm(`移除外部 MCP 服务器 ${entry.id}？（角色调用会立即被拒）`)) return;
      remove.disabled = true;
      try {
        await api("/api/mcp/servers/remove", {
          method: "POST",
          body: JSON.stringify({ vendor: state.vendor, id: entry.id }),
        });
        showToast(`已移除 ${entry.id}`);
        if (onChanged) await onChanged();
      } catch (error) {
        showToast(error.message, true);
      } finally {
        remove.disabled = false;
      }
    });
    actionCell.append(remove);
    row.append(actionCell);
    const detail = (health.detail || "").slice(0, 200);
    row.title = `注册 ${formatEventTime(entry.registered_at)} · 连接配置 mcp_servers/connections/${entry.connection_config_ref || entry.id}.json${detail ? ` · ${detail}` : ""}`;
    body.append(row);
  });
}

export function initMcpRegister(onChanged) {
  const button = $("mcpRegisterButton");
  if (!button) return;
  button.addEventListener("click", async () => {
    const payload = {
      vendor: state.vendor,
      id: $("mcpServerIdInput").value.trim(),
      name: $("mcpServerNameInput").value.trim(),
      transport: $("mcpTransportSelect").value,
      command: $("mcpCommandInput").value.trim(),
      args: $("mcpArgsInput").value.trim().split(/\s+/).filter(Boolean),
      url: $("mcpUrlInput").value.trim(),
      visible_roles: parseVisibleRoles($("mcpVisibleRolesInput").value),
      enabled: true,
    };
    if (!payload.id || !payload.name || !payload.visible_roles.length) {
      showToast("服务器 ID、名称与可见角色必填（visible_roles 为空不会暴露给任何角色）", true);
      return;
    }
    if (payload.transport === "stdio" && !payload.command) {
      showToast("stdio transport 需要启动命令", true);
      return;
    }
    if (payload.transport === "http" && !payload.url) {
      showToast("http transport 需要端点 URL", true);
      return;
    }
    button.disabled = true;
    try {
      const result = await api("/api/mcp/servers", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      showToast(`已注册 ${result.entry.id}；下一步点“健康检查”完成真实握手并缓存工具`);
      ["mcpServerIdInput", "mcpServerNameInput", "mcpCommandInput", "mcpArgsInput", "mcpUrlInput", "mcpVisibleRolesInput"]
        .forEach(id => { $(id).value = ""; });
      if (onChanged) await onChanged();
    } catch (error) {
      showToast(error.message, true);
    } finally {
      button.disabled = false;
    }
  });
}
