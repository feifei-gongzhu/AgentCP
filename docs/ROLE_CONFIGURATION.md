# 项目级角色配置完整说明

## 1. 配置保存在哪里

前端“人工控制 → 项目级角色配置”保存后，会生成：

```text
projects/{项目名}/team_config.json
```

启动自动化时，如果团队填写 `default` 或 `project`，系统会优先读取当前项目的 `team_config.json`；项目没有单独配置时，才读取 `teams/default.json`。

前端支持两种密钥来源：

- “密钥变量”填写环境变量名称。
- “会话 API Key”直接填写真实密钥；macOS 保存到系统钥匙串，其他系统仅保存在当前服务进程内存。

会话密钥不会进入项目文件、SQLite、审计日志或 API 响应。macOS 服务重启后会从系统钥匙串恢复；其他系统服务重启后需要重新输入。

## 2. 推荐的标准角色

| 职责 | 用途 | 推荐后端 | 推荐沙箱 | 推荐并发 |
|---|---|---|---|---|
| `reason` | 分析目标、提出高价值测试方向，主要产生 Intent | `codex` 或 `openai-compatible` | `read-only` | 1–2 |
| `metacog` | 查盲点、纠偏、止损、补充反事实假设 | `codex` 或 `openai-compatible` | `read-only` | 1 |
| `executor` | 认领 Intent，实际执行并把原始证据写入 `evidence/` | `codex` 或 `container` | `workspace-write` | 1–3 |
| `reviewer` | 审核候选结果、证据质量和业务影响 | `codex` 或 `openai-compatible` | `read-only` | 1 |
| `pentester` | 与 `executor` 使用相同的 Intent 认领与执行调度 | `codex` 或 `container` | `workspace-write` | 1–3 |

`openai-compatible` 只发送一次 HTTP 模型请求，没有本地工具循环，适合 Reason、Metacog 和 Reviewer。它不能代替需要运行命令、读取目标源码、访问测试目标和落盘证据的 Executor。

## 3. 前端字段说明

### 名称

Worker 的唯一标识，例如：

```text
reason-main
metacog-blindspot
executor-primary
reviewer-quality
```

同一项目内不能重名。

### 职责

选择 `reason`、`metacog`、`executor`、`reviewer` 或 `pentester`。职责决定加载哪个角色 Prompt，也决定自动化调度阶段。

### 后端

- `codex`：调用本机 Codex CLI，支持 Agent 工具循环和沙箱。
- `claude-cli`：调用本机 Claude CLI。
- `openai-compatible`：直接调用兼容 Chat Completions 的 HTTP API。
- `ollama`：调用本机或远程 Ollama `/api/generate`。
- `container`：在受限 Docker 容器内运行 Worker。

### 模型

填写服务商或中转站提供的**实际模型 ID**，例如 `your-model-id`。不要填写网页展示名称，也不要自行猜测模型别名。

- `codex` 留空：使用当前 Codex CLI 默认模型。
- `openai-compatible`：必须填写。
- `ollama`：必须填写。
- 中转站：建议始终显式填写中转站控制台提供的模型 ID。

### 服务地址

填写 API 根地址，不填写具体方法路径。

Chat Completions 中转站示例：

```text
https://relay.example.com/v1
```

系统最终请求：

```text
https://relay.example.com/v1/chat/completions
```

因此不要填写：

```text
https://relay.example.com/v1/chat/completions
```

否则会拼成重复路径。

如果中转站给出的根地址包含租户路径，必须完整保留，例如：

```text
https://relay.example.com/openai/company-a/v1
```

### 密钥变量

这里填写环境变量名，不是真实 Key。例如：

```text
AGENTCP_RELAY_API_KEY
```

真实密钥必须在启动 AgentCP 服务的同一个终端环境中设置：

```bash
export AGENTCP_RELAY_API_KEY="你的中转站密钥"
python3 agentcp serve --host 127.0.0.1 --port 8765
```

如果服务已经运行，再执行 `export` 不会改变现有服务进程的环境变量；需要停止服务后，从已经设置变量的终端重新启动。

### 沙箱

- `read-only`：可以分析文件，不允许修改工作区。适合 Reason、Metacog、Reviewer。
- `workspace-write`：允许在项目工作区写入证据。适合 Executor。
- `danger-full-access`：宿主机高风险模式，不建议使用。

沙箱字段只对 `codex` 有直接作用。`openai-compatible` 和 `ollama` 是单次 HTTP 请求，不会因此获得本地工具能力。

### 并发

`max_running` 表示这个角色在一次迭代中最多生成多少个 Job。例如 Executor 并发为 3，会尝试认领最多 3 个开放 Intent。

实际同时运行数还受“启动真实模型团队”里的全局并发数限制：

```text
实际并发 ≤ 全局并发数
```

建议先使用：

```text
Reason 1 / Metacog 1 / Executor 1 / Reviewer 1 / 全局并发 3
```

确认中转站限流和输出稳定后，再提高 Executor 并发。

### 优先级

数值越小越靠前。推荐：

```text
Reason 0
Metacog 1
Executor 1
Reviewer 2
```

Reviewer 仍会在候选结果产生后进入审查阶段，不会因为优先级较小而越过阶段约束。

## 4. 中转站方案 A：Chat Completions 兼容

如果中转站文档只明确支持：

```text
POST /v1/chat/completions
```

请选择 `openai-compatible`。

### 前端填写示例

| 字段 | 值 |
|---|---|
| 名称 | `reason-relay` |
| 职责 | `reason` |
| 后端 | `openai-compatible` |
| 模型 | 中转站提供的模型 ID |
| 服务地址 | `https://relay.example.com/v1` |
| 密钥变量 | `AGENTCP_RELAY_API_KEY` |
| 沙箱 | `read-only` |
| 并发 | `1` |
| 优先级 | `0` |

系统发送的请求包含：

```json
{
  "model": "your-model-id",
  "messages": [{"role": "user", "content": "..."}],
  "temperature": 0.2,
  "response_format": {"type": "json_object"}
}
```

鉴权头为：

```text
Authorization: Bearer ${AGENTCP_RELAY_API_KEY}
```

中转站必须满足：

1. 接受 Bearer Key。
2. 接受 `response_format: {"type":"json_object"}`，或至少不会拒绝该字段。
3. 返回 `choices[0].message.content`，并且 content 是 JSON 字符串。
4. 模型 ID 与中转站控制台完全一致。

### 推荐角色组合

```text
Reason    → openai-compatible 中转站
Metacog   → openai-compatible 中转站
Executor  → 本机 Codex 或 Container
Reviewer  → openai-compatible 中转站
```

这样可以让中转模型承担分析和审查，把真实工具执行、目标访问与证据落盘留给受沙箱控制的 Executor。

## 5. 中转站方案 B：Responses API 兼容

如果中转站明确支持 Responses API，并且希望保留 Codex 的 Agent 工具循环，请选择 `codex` 后端。

### 前端填写示例

| 字段 | 值 |
|---|---|
| 名称 | `executor-codex-relay` |
| 职责 | `executor` |
| 后端 | `codex` |
| 模型 | 中转站提供的模型 ID |
| 服务地址 | `https://relay.example.com/v1` |
| 密钥变量 | `AGENTCP_RELAY_API_KEY` |
| 沙箱 | `workspace-write` |
| 并发 | `1` |
| 优先级 | `1` |

AgentCP 会给 Codex CLI 注入一个自定义 Provider：

```text
wire_api = responses
base_url = https://relay.example.com/v1
env_key = AGENTCP_RELAY_API_KEY
```

中转站必须真实兼容 Responses API，而不只是把 Chat Completions 包装成相似格式。如果中转站只支持 `/chat/completions`，这种配置通常会失败，应改用方案 A。

## 6. 推荐的完整配置

适合先跑通系统的混合配置：

```text
reason-main
  职责: reason
  后端: openai-compatible
  模型: 中转站模型 ID
  服务地址: https://relay.example.com/v1
  密钥变量: AGENTCP_RELAY_API_KEY
  沙箱: read-only
  并发: 1
  优先级: 0

metacog-main
  职责: metacog
  后端: openai-compatible
  模型: 中转站模型 ID
  服务地址: https://relay.example.com/v1
  密钥变量: AGENTCP_RELAY_API_KEY
  沙箱: read-only
  并发: 1
  优先级: 1

executor-main
  职责: executor
  后端: codex
  模型: 留空，使用本机 Codex 默认模型
  服务地址: 留空
  密钥变量: OPENAI_API_KEY
  沙箱: workspace-write
  并发: 1
  优先级: 1

reviewer-main
  职责: reviewer
  后端: openai-compatible
  模型: 中转站模型 ID
  服务地址: https://relay.example.com/v1
  密钥变量: AGENTCP_RELAY_API_KEY
  沙箱: read-only
  并发: 1
  优先级: 2
```

如果中转站完整支持 Responses API，可以把 Executor 的服务地址和密钥变量也指向中转站。

## 7. 保存与启动

1. 在前端保存角色配置。
2. 在服务进程环境中设置真实密钥。
3. 确认“团队”填写 `default` 或 `project`。
4. 全局并发先设为 3。
5. 超时建议先设为 300–600 秒。
6. 点击“启动一轮真实审计”。

启动时会把目标信息、黑板上下文和相关源码内容发送给配置中的模型服务。使用中转站前，应确认其数据留存、日志、训练使用、地域和访问控制政策符合项目要求。

## 8. 连接测试

在不启动整个团队前，可以先测试 Chat Completions 中转站：

```bash
export RELAY_BASE_URL="https://relay.example.com/v1"
export AGENTCP_RELAY_API_KEY="你的中转站密钥"

curl "$RELAY_BASE_URL/chat/completions" \
  -H "Authorization: Bearer $AGENTCP_RELAY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "your-model-id",
    "messages": [{"role": "user", "content": "Return only: {\"kind\":\"none\",\"reason\":\"ok\"}"}],
    "response_format": {"type": "json_object"}
  }'
```

不要把命令输出、Shell 历史或截图中的真实 Key 提交到项目目录。

随后可预览团队 Prompt，不产生真实模型请求：

```bash
python3 agentcp run-team 项目名 --team default --max-workers 3 --dry-run
```

## 9. 常见错误

### 缺少环境变量

错误：

```text
缺少环境变量: AGENTCP_RELAY_API_KEY
```

原因是 Key 没有进入 AgentCP 服务进程。停止服务，在设置环境变量的同一个终端重新启动。

### 404

通常是 `base_url` 写成了完整接口地址。系统会自动追加 `/chat/completions`；把服务地址改成 API 根地址。

### 401 或 403

检查 Key、Bearer 鉴权、模型权限、来源 IP 白名单和中转站账户余额。密钥变量字段必须填写变量名，不能填写真实 Key。

### 400，提示 response_format 不支持

当前 `openai-compatible` Driver 固定请求 JSON Object 输出。如果中转站或模型不支持该参数，需要更换兼容模型/通道，或修改 Driver 后再使用。

### 模型不存在

不要使用网页产品名。复制中转站 API 文档或模型列表返回的精确模型 ID。

### Codex 中转配置失败，但 Chat Completions 正常

说明中转站大概率只兼容 Chat Completions，不兼容 Responses API。Reason、Metacog、Reviewer 改为 `openai-compatible`；Executor 保留本机 Codex 或 Container。

### 模型输出不是合法 JSON

说明中转站修改了输出、模型没有遵守结构化输出，或 `choices[0].message.content` 不是字符串。先用连接测试确认返回结构。

### Executor 没有运行

Executor 只认领开放 Intent。第一轮没有可执行方向时不会生成 Executor Job，这是正常调度行为。

### Container 在前端选了但启动失败

Container 还需要 `extra.image`、`extra.worker_command`、网络、资源和环境变量透传等高级字段。当前前端表格没有暴露这些高级字段，应使用 `teams/production-container.json` 作为模板编辑项目 `team_config.json`。

## 10. 安全建议

- 真实 Key 只填写在密码类型的“会话 API Key”输入框，不要填写到“密钥变量”、目标备注、`team_config.json` 或 `env` 字段。
- 不要把生产账号密码写进角色配置或目标备注。
- 中转站只用于允许发送的项目上下文；敏感源码优先使用本地模型或已审批的私有服务。
- Executor 使用 `workspace-write`，Reason、Metacog、Reviewer 使用 `read-only`。
- 宿主机不启用 `danger-full-access` 和沙箱绕过。
- 从低并发开始，避免中转站限流导致整轮任务失败。

## 11. Claude Code 与 Claude 格式中转站

选择 `claude-cli` 后端时，前端字段会按以下方式进入后端：

| 前端字段 | 后端实际行为 |
|---|---|
| 模型 | 传给 `claude --model` |
| 服务地址 | 设置为子进程的 `ANTHROPIC_BASE_URL` |
| 密钥变量 | 从服务环境读取对应变量 |
| 会话 API Key | 注入当前 Worker 子进程环境；不进入项目文件，macOS 使用系统钥匙串持久化 |
| 鉴权 `bearer` | 设置 `ANTHROPIC_AUTH_TOKEN` |
| 鉴权 `x-api-key` | 设置 `ANTHROPIC_API_KEY` |
| 沙箱 `read-only` | 使用 Claude `plan` 权限模式和只读工具集合 |
| 沙箱 `workspace-write` | 使用 Claude `auto` 权限模式 |

DeepSeek Claude Code 前端配置示例：

```text
后端：claude-cli
模型：deepseek-v4-pro
服务地址：https://api.deepseek.com/anthropic
密钥变量：留空
鉴权：bearer
会话 API Key：填写新生成的真实 Key
Reason / Metacog / Reviewer 沙箱：read-only
Executor 沙箱：workspace-write
```

保存后，后端会立即持有该会话密钥。下一次启动自动化时，Driver 使用上述地址、模型、鉴权和权限配置调用 Claude Code。页面刷新不会丢失会话密钥；macOS 服务重启后会自动恢复，其他系统重启后需要重新输入。

AgentCP 启动的所有 Claude 子进程都会排除 Claude 的 `user` / `local` 设置，并清理继承的 Anthropic、Bedrock、Vertex 与 Foundry 路由及模型变量；角色配置了中转站时，再仅注入当前角色在前端保存的地址、模型和会话 Key。因此 AgentCP 不会读取、修改或切换 CCSwitch 的配置；CCSwitch 中正在运行的其他任务也不属于 AgentCP 的进程管理范围。
