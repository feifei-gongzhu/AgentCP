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
  delete normalized.backend;
  return normalized;
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
