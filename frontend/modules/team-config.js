// 角色目录（与后端 role_registry 双契约对齐：七角色 + 迁移期旧角色）。
// index.html 的职责下拉、卡片标签与校验提示共用这一份，避免多处漂移。
export const ROLE_OPTIONS = [
  { value: "planner", label: "规划（planner）", legacy: false },
  { value: "orchestrator", label: "编排（orchestrator）", legacy: false },
  { value: "recon", label: "侦察（recon）", legacy: false },
  { value: "crack", label: "口令验证（crack）", legacy: false },
  { value: "poc", label: "组件验证（poc）", legacy: false },
  { value: "operator", label: "综合执行（operator）", legacy: false },
  { value: "reviewer", label: "复核（reviewer）", legacy: false },
  { value: "reason", label: "推理（reason，旧）", legacy: true },
  { value: "metacog", label: "盲点（metacog，旧）", legacy: true },
  { value: "executor", label: "执行（executor，旧）", legacy: true },
  { value: "waf_analyst", label: "WAF（waf_analyst，旧）", legacy: true },
  { value: "profile_mapper", label: "画像服务（profile_mapper，旧）", legacy: true },
];

export const SEVEN_ROLES = ROLE_OPTIONS.filter(option => !option.legacy).map(option => option.value);

// 保存前角色规范化：接受 pentester 别名与未知前后缀，其他保持原值
// （未知角色由服务端 role_registry 拒绝，前端不静默映射回 executor）。
export function normalizeRoleValue(value) {
  const raw = String(value || "").trim();
  if (raw === "pentester") return "executor";
  return raw;
}

export function isLegacyRole(value) {
  const normalized = normalizeRoleValue(value);
  return ROLE_OPTIONS.some(option => option.value === normalized && option.legacy);
}

export function parseWorkerCommand(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return { value: [], error: null };
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (!Array.isArray(parsed)) {
        return { value: null, error: "worker_command 的 JSON 必须是数组" };
      }
      return { value: parsed.map(item => String(item)), error: null };
    } catch (_error) {
      return { value: null, error: "worker_command 的 JSON 数组格式不正确" };
    }
  }
  return {
    value: trimmed.split(/\r?\n/).map(item => item.trim()).filter(Boolean),
    error: null,
  };
}

export function validateMemberData(member, allMembers) {
  const problems = [];
  const name = String(member.name || "").trim();
  if (!name) {
    problems.push({ errorId: "eName", controlId: "mName", message: "名称必填", label: "名称" });
  } else if (allMembers.filter(item => String(item.name || "").trim() === name).length > 1) {
    problems.push({ errorId: "eName", controlId: "mName", message: "名称不能与其他角色重复", label: "名称" });
  }
  if (!normalizeRoleValue(member.role)) {
    problems.push({ errorId: null, controlId: "mRole", message: "职责必填（七角色或迁移期旧角色）", label: "职责" });
  }
  const type = member.type || member.backend || "codex";
  const model = String(member.model || "").trim();
  const baseUrl = String(member.base_url || "").trim();
  const apiKeyEnv = String(member.api_key_env || "").trim();
  if ((type === "openai-compatible" || type === "claude-cli") && !model) {
    problems.push({ errorId: "eModel", controlId: "mModel", message: `${type} 必须填写模型`, label: "模型" });
  }
  if (type === "openai-compatible" && !baseUrl) {
    problems.push({ errorId: "eBaseUrl", controlId: "mBaseUrl", message: "openai-compatible 必须填写服务地址", label: "服务地址" });
  }
  if (type === "claude-cli" && baseUrl && !apiKeyEnv) {
    problems.push({ errorId: "eApiKeyEnv", controlId: "mApiKeyEnv", message: "自定义服务地址时必须填写密钥环境变量", label: "密钥环境变量" });
  }
  if (type === "codex" && /(?:^|\/)anthropic(?:\/|$)/i.test(baseUrl)) {
    problems.push({
      errorId: "eBaseUrl",
      controlId: "mBaseUrl",
      message: "Codex 使用 Responses 协议，不能连接 Anthropic 协议地址；请选择 Claude CLI 或更换服务地址",
      label: "服务地址",
    });
  }
  if (type === "ollama" && member.runtime_mode !== "local-cli") {
    problems.push({ errorId: null, controlId: "mRuntimeMode", message: "Ollama 仅支持本地 CLI 模式", label: "运行模式" });
  }
  if (type === "container") {
    if (!String(member.extra?.image || "").trim()) {
      problems.push({ errorId: "eContainerImage", controlId: "mContainerImage", message: "Container Worker 必须填写 Worker 镜像", label: "Worker 镜像" });
    }
    if (member.__workerCommandError) {
      problems.push({ errorId: "eContainerCommand", controlId: "mContainerCommand", message: member.__workerCommandError, label: "启动命令" });
    }
    if (member.runtime_mode !== "local-docker") {
      problems.push({ errorId: null, controlId: "mRuntimeMode", message: "Container Worker 仅支持本地 Docker 模式", label: "运行模式" });
    }
  }
  return problems;
}

export function normalizeMemberForSave(member) {
  const normalized = { ...member };
  normalized.type = normalized.type || normalized.backend || "codex";
  normalized.role = normalizeRoleValue(normalized.role);
  delete normalized.backend;
  return normalized;
}

// 迁移期提示（不阻塞保存）：旧六角色仍可运行，但新项目默认七角色。
export function roleAdvisories(member) {
  const advisories = [];
  if (isLegacyRole(member.role)) {
    advisories.push(`${normalizeRoleValue(member.role)} 是迁移期旧角色；旧项目可继续运行，新项目建议使用七角色并在设置页执行团队迁移`);
  }
  return advisories;
}

export function stripMemberTransientFields(member) {
  Object.keys(member).forEach(key => {
    if (key.startsWith("__")) delete member[key];
  });
}

function comparableMember(member) {
  const value = structuredClone(member || {});
  delete value.secret_alias;
  stripMemberTransientFields(value);
  return value;
}

export function summarizeTeamPresetDiff(currentConfig, presetConfig) {
  const current = new Map(
    (currentConfig?.members || []).map(item => [item.name, comparableMember(item)]),
  );
  const incoming = new Map(
    (presetConfig?.members || []).map(item => [item.name, comparableMember(item)]),
  );
  const added = [...incoming.keys()].filter(name => !current.has(name));
  const removed = [...current.keys()].filter(name => !incoming.has(name));
  const changed = [...incoming.keys()].filter(name =>
    current.has(name)
    && JSON.stringify(current.get(name)) !== JSON.stringify(incoming.get(name)),
  );
  const lines = [];
  if (added.length) lines.push(`新增：${added.join("、")}`);
  if (removed.length) lines.push(`移除：${removed.join("、")}`);
  if (changed.length) lines.push(`修改：${changed.join("、")}`);
  return lines.length
    ? lines.join("\n")
    : "团队配置内容相同，仅会同步预设关联的钥匙串密钥。";
}
