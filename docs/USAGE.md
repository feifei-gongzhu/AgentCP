# 渗透测试黑板控制平面详细使用手册

本手册面向本地研发、单机自动化和基于 HTTP 协议的调度模式。

> 当前授权策略按项目所有者要求固定为 `authorization=authorized` 和 `scope=["*"]`。每次项目初始化或加载时都会保持该设定。

## 1. 核心工作流

```text
初始化项目
  → 选择 Worker 团队
  → 启动 Stigmergy 自动化迭代
  → Worker 认领 Job / Intent
  → Worker 输出结构化候选结果
  → SQLite 持久化候选结果
  → Reviewer 可选审计
  → Guardian 确定性质量检查
  → Dispatcher 串行写入黑板
  → 进入强制门禁
  → 用户批准
  → 守护进程自动开始下一迭代
```

Worker 不直接修改黑板，Worker 之间不直接通信。所有协作都通过 Fact、Intent、Hint、Job 和共享黑板完成。

## 2. 环境要求

### 必需

- Python 3.10 或更高版本。
- macOS、Linux 或 Windows。
- 至少一个可用的模型后端，或使用 mock 团队。

### 按需

- Codex CLI：使用 `codex` Worker。
- Claude CLI：使用 `claude-cli` Worker。
- Ollama：使用本地模型。
- Docker：使用默认的本地 Docker 隔离模式或 Container Worker。
- agent-compose：仅选择“CT agent-compose”运行模式时需要。

### 运行模式

项目配置中的每个角色都可以独立选择运行模式：

- **本地 Docker（默认）**：Sorne 直接创建本地容器并运行模型，不启动 agent-compose daemon。需要预先构建 `agent-compose-guest:latest`，项目位于容器 `/workspace`，可选目标源码只读挂载到 `/target`。
- **CT agent-compose（可选）**：使用仓库内 vendored agent-compose 的 daemon、session 与 sandbox。只有选择该模式时才需要构建其 Go 二进制。
- **本地 CLI**：直接调用本机 Claude Code、Codex CLI、Ollama 或兼容 HTTP API，不要求 Docker。该模式没有容器级隔离，应继续使用 `read-only` 或 `workspace-write` 权限，并仅向可信目标开放。

每个角色下方还提供独立的“Agent 专属提示词”编辑器。内容保存在当前项目的 `team_config.json`，不会影响其他项目或其他 Agent；运行时会作为每次调用的第一段持久指令注入，自动重试也不会删除。项目所有者在运行界面提交的实时指令仍具有更高优先级。不要在提示词中填写 API Key。

### 角色化上下文编译

黑板继续保存完整项目记忆，但 Worker 不再读取整块黑板。调用模型前，系统按角色生成任务胶囊：

- Executor / Pentester：当前唯一 Intent，以及与其 ID、URL、域名或文件直接关联的 Fact、负向证据、人工结论和技术观察；上下文预算 12,000 字符。
- Reason / Metacog：近期攻击面摘要、有效负向证据、方向、假设、经验和覆盖缺口；上下文预算 18,000 字符。
- Reviewer：本轮候选及其关联漏洞、人工结论和反例记忆；上下文预算 20,000 字符。
- WAF Analyst：当前唯一 WAF 分支及直接相关的阻断证据；上下文预算 12,000 字符。

Agent 专属提示词、实时项目所有者指令和当前 Executor Intent 不参与可选记忆裁剪。重试不会重新灌入增长后的全局黑板，只追加最多 2,000 字符的错误和工具动作增量。

每次真实调用前都会生成本地脱敏快照：

```text
projects/{项目名}/prompt_snapshots.jsonl
projects/{项目名}/prompt_snapshots/P-xxxxxxxxxxxx.txt
```

快照记录 Prompt SHA-256、字符数、角色预算、实际选中的黑板记录 ID 和未注入数量。打开“执行与结果 → 模型上下文审计”即可查看；API Key、Authorization 和常见密钥字段不会原样进入可视快照。

如果本地 Docker 未启动、`docker` 命令不存在或本地镜像构建失败，运行事件流会直接显示具体准备阶段错误，不再表现为无原因等待。

## 3. 获取项目并准备 Python

```bash
git clone https://github.com/feifei-gongzhu/Sorne.git
cd Sorne
```

创建虚拟环境：

```bash
python3 -m venv .venv
```

macOS/Linux 激活：

```bash
source .venv/bin/activate
```

Windows PowerShell 激活：

```powershell
.venv\Scripts\Activate.ps1
```

安装测试依赖：

```bash
python -m pip install "pytest>=8"
```

运行回归测试：

```bash
python -m pytest -q
```

测试数量会随工程迭代变化，以全部通过为准。

## 4. 真实模型启动检查

正式运行前先确认 Codex CLI 和三个角色的 Prompt 能正常加载：

```bash
codex --version
python3 sorne init production-security
python3 sorne run-team production-security \
  --team default \
  --max-workers 3 \
  --dry-run
```

`--dry-run` 只预览上下文，不发送模型请求。确认无误后再启动真实自动化：

```bash
python3 sorne automate production-security \
  --team default \
  --max-workers 3 \
  --timeout 600
```

## 5. 项目初始化

```bash
python3 sorne init vendor-name
```

`vendor-name` 只能是安全的目录名，不能包含 `/`、`\` 或以 `.` 开头。

初始化后的核心文件：

```text
projects/vendor-name/
├── 目标信息.md
├── 检查清单.yaml
├── 项目黑板_知识库.md
├── 决策日志.md
├── target.json
├── checklist.json
├── state.json
├── facts.jsonl
├── intents.jsonl
├── hints.jsonl
├── evidence.jsonl
├── decision_log.jsonl
├── control_plane.db
├── dashboard.html
├── evidence/
├── findings/
└── reports/
```

### 目标信息

推荐在正式控制台的“目标配置”中填写。前端支持：

- 创建第一个项目或继续创建新项目。
- 每行填写一个 URL、域名、IP、应用包标识等测试目标。
- 填写本地源码绝对路径，供源码审计及只读容器挂载使用。
- 配置项目类型、业务目标、不收范围、成功条件和补充说明。
- 修改已有项目的目标，并同步更新 `target.json` 与 `目标信息.md`。

目标表单不提供授权模式开关。无论请求中传入什么值，服务端都会强制写回 `authorization=authorized`、`authorization_mode=owner_asserted_all_targets` 和 `scope=["*"]`。

可以在 `目标信息.md` 中写入：

- 客户端名称和版本。
- 操作系统。
- 安装位置。
- 测试账号。
- 目标业务价值。
- 成功条件。

`target.json` 中的授权字段会固定为：

```json
{
  "authorization": "authorized",
  "authorization_mode": "owner_asserted_all_targets",
  "scope": ["*"]
}
```

## 6. 团队配置

字段、角色搭配、中转站、密钥注入和排错的完整说明见 [ROLE_CONFIGURATION.md](ROLE_CONFIGURATION.md)。

### 前端配置（推荐）

打开正式控制台，在“人工控制 → 项目级角色配置”中可以直接：

- 添加或删除 Reason、Metacog、Executor、Reviewer。
- 选择 Codex、Claude CLI、OpenAI-compatible、Ollama 或 Container。
- 设置模型、服务地址、API Key 环境变量名、沙箱、并发数和优先级。
- 保存为项目级 `team_config.json`，下一次运行自动生效。
- 将当前团队另存为个人预设，更新、复制、重命名或删除预设。
- 设置新项目默认预设，或在新建项目时显式选择个人预设/系统模板。

前端支持两种密钥来源：填写环境变量名，或在“会话 API Key”中直接注入。会话 Key 不写入 `team_config.json`、SQLite、审计日志或 API 响应；macOS 会保存到系统钥匙串并在服务重启后自动恢复，其他系统仅保存在当前服务进程内存。Web 配置不能启用 `dangerously_bypass_sandbox`。

个人预设保存在 `user_presets/teams/{preset-id}.json`。预设 ID 不随重命名改变，文件包含 `schema_version`；真实 API Key 不写入预设，只记录与 macOS 钥匙串关联的稳定别名。应用预设前，界面会显示角色差异；应用后复制为项目级快照，因此后续更新预设不会悄悄修改已存在项目。

系统团队模板位于：

```text
teams/*.json
```

命令中的 `--team default` 对应：

```text
teams/default.json
```

### 基本格式

```json
{
  "name": "my-team",
  "members": [
    {
      "name": "reason-main",
      "type": "codex",
      "role": "reason",
      "model": null,
      "base_url": null,
      "api_key_env": "OPENAI_API_KEY",
      "sandbox": "read-only",
      "priority": 0,
      "max_running": 1,
      "env": {}
    }
  ]
}
```

### 字段说明

| 字段 | 说明 |
|---|---|
| `name` | Worker 的唯一名称 |
| `type` | `codex` / `claude-cli` / `openai-compatible` / `ollama` / `container` / `mock` |
| `role` | `reason` / `metacog` / `reviewer` / `pentester` |
| `model` | 模型名；`null` 表示使用 CLI 默认模型 |
| `base_url` | 第三方 OpenAI-compatible 地址 |
| `api_key_env` | 密钥所在的环境变量名 |
| `sandbox` | Codex 的 `read-only` / `workspace-write` / `danger-full-access` |
| `priority` | 数值越小越优先 |
| `max_running` | 该成员在一次自动化迭代中生成的并发 Job 数 |
| `env` | 非密钥环境变量；不要写入真实 Key |

### 并发数的两层控制

- `--max-workers 4`：整个迭代的线程并发上限。
- `member.max_running`：一个团队成员产生几个 Job。

例如，一个 Container Worker 设置 `max_running: 2`，会生成：

```text
container-static-analysis#1
container-static-analysis#2
```

## 7. 接入 Codex CLI

先检查 Codex：

```bash
codex --version
```

默认团队使用当前 Codex CLI 配置的默认模型：

```json
{
  "type": "codex",
  "model": null,
  "base_url": null,
  "sandbox": "read-only"
}
```

先预览 Prompt：

```bash
python3 sorne run-team vendor-name \
  --team default \
  --max-workers 3 \
  --dry-run
```

单 Worker 预览：

```bash
python3 sorne run-worker vendor-name \
  --backend codex \
  --role reason \
  --dry-run
```

如果必须让 Codex 将证据写入项目目录：

```json
{
  "sandbox": "workspace-write"
}
```

不建议在宿主机上启用：

```text
danger-full-access
dangerously_bypass_sandbox
```

## 8. 接入 OpenAI-compatible 模型

密钥只放在环境变量：

```bash
export OPENAI_API_KEY="your-key"
```

团队成员配置：

```json
{
  "name": "reason-compatible",
  "type": "openai-compatible",
  "role": "reason",
  "model": "your-model",
  "base_url": "https://provider.example.com/v1",
  "api_key_env": "OPENAI_API_KEY",
  "max_running": 1,
  "env": {}
}
```

请求目标是：

```text
{base_url}/chat/completions
```

因此 `base_url` 应该通常以 `/v1` 结尾，不要再写 `/chat/completions`。

## 9. Codex 连接第三方 Responses API

```bash
export OPENAI_API_KEY="your-key"
```

```json
{
  "name": "reason-codex-compatible",
  "type": "codex",
  "role": "reason",
  "model": "your-model",
  "base_url": "https://provider.example.com/compatible-mode/v1",
  "api_key_env": "OPENAI_API_KEY",
  "sandbox": "read-only",
  "env": {}
}
```

这种方式仍使用 Codex Agent 循环和工具，只是将模型提供者切换为第三方 Responses-compatible 服务。

## 10. 接入 Ollama

确保 Ollama 正在运行，然后配置：

```json
{
  "name": "metacog-local",
  "type": "ollama",
  "role": "metacog",
  "model": "qwen2.5-coder:7b",
  "base_url": "http://127.0.0.1:11434",
  "max_running": 1
}
```

Ollama Driver 调用：

```text
POST /api/generate
```

## 11. 接入 Claude CLI

先检查：

```bash
claude --version
```

配置：

```json
{
  "name": "reviewer-claude",
  "type": "claude-cli",
  "role": "reviewer",
  "model": null,
  "max_running": 1,
  "env": {}
}
```

## 12. Container Worker

仓库提供正式 Worker 镜像定义：

```bash
docker build -t sorne-worker:latest worker-container
export OPENAI_API_KEY="你的密钥"
python3 sorne automate production-security \
  --team production-container \
  --max-workers 4 \
  --timeout 600
```

容器只获得当前项目目录的写权限；目标源码通过 `/target` 只读挂载。运行时丢弃 Linux capabilities、启用 `no-new-privileges`，并限制 CPU、内存和 PID。

参考：

```text
teams/client-security.example.json
```

核心配置：

```json
{
  "name": "container-static-analysis",
  "type": "container",
  "role": "pentester",
  "max_running": 2,
  "extra": {
    "image": "your-worker-image:latest",
    "worker_command": ["worker-agent", "--json"],
    "network": "none",
    "cpus": "2",
    "memory": "2g",
    "pids_limit": 256,
    "workspace_write": true,
    "pass_env": []
  }
}
```

容器内的 `worker-agent --json` 必须：

1. 从 stdin 读取 Prompt。
2. 只在 stdout 输出一个符合 Schema 的 JSON 对象。
3. 将日志写入 stderr，不要混入 stdout。

默认容器限制：

- `--network none`。
- `--cap-drop ALL`。
- `no-new-privileges:true`。
- CPU、内存和 PID 限制。
- 工作区默认只读。
- 只透传 `pass_env` 指定的环境变量。

`workspace_write: true` 仅在 Worker 必须保存证据时开启。

## 13. 一次性团队运行

```bash
python3 sorne run-team vendor-name \
  --team default \
  --max-workers 3 \
  --timeout 300
```

`run-team` 适合：

- 调试 Prompt。
- 比较多模型结果。
- 快速验证团队配置。

正式自动化建议使用 `automate` 或 `automation-daemon`，因为它们具有 SQLite 持久化、租约、重试和恢复。

## 14. 运行一次自动化迭代

```bash
python3 sorne automate vendor-name \
  --team default \
  --max-workers 4 \
  --timeout 300
```

参数：

| 参数 | 含义 |
|---|---|
| `--team` | 团队配置名，不含 `.json` |
| `--max-workers` | 全局并发执行数 |
| `--timeout` | 单 Worker 最大执行秒数 |
| `--server` | 使用 HTTP 协议而不是本地直接模式 |

实际 Worker 超时上限不会超过项目门禁间隔。默认门禁为 15 分钟。

## 15. 自动化守护进程

本地模式：

```bash
python3 sorne automation-daemon vendor-name \
  --team default \
  --max-workers 4 \
  --timeout 300 \
  --poll-interval 3
```

守护进程会：

1. 查找未完成运行。
2. 有未完成运行时恢复。
3. 没有运行时创建新迭代。
4. 在强制门禁处等待。
5. 用户批准后自动开始下一迭代。

只跑一次：

```bash
python3 sorne automation-daemon vendor-name \
  --team default \
  --once
```

使用 `Ctrl+C` 停止守护进程。已持久化的 Job 不会丢失。

## 16. 强制门禁和审批

以下条件会进入 `awaiting_approval`：

- 一次 Stigmergy 迭代完成。
- 同一执行节拍达到 15 分钟。
- 产生 `high` 或 `critical` Intent。
- Reviewer 输出 `request_confirmation`。

门禁期间：

- 不能启动新自动化批次。
- Worker 候选结果不能继续提交黑板。
- 未提交候选仍保留在 SQLite。

批准继续：

```bash
python3 sorne approve-gate vendor-name \
  --action continue \
  --reason "当前路径仍具有高业务价值，批准继续"
```

可用动作：

| Action | 含义 |
|---|---|
| `continue` | 继续当前方向 |
| `stop_loss` | 当前方向止损 |
| `switch_target` | 切换目标 |
| `switch_phase` | 切换测试阶段 |

所有批准动作都会写入 `decision_log.jsonl` 和 `决策日志.md`。

## 17. 恢复、查看和取消

查看最新运行：

```bash
python3 sorne automation-status vendor-name
```

查看指定 Run：

```bash
python3 sorne automation-status vendor-name \
  --run-id R-xxxxxxxxxxxx
```

恢复未完成 Run：

```bash
python3 sorne automation-resume vendor-name \
  --run-id R-xxxxxxxxxxxx
```

取消：

```bash
python3 sorne automation-cancel vendor-name \
  --run-id R-xxxxxxxxxxxx \
  --reason "用户主动停止"
```

取消后：

- 不再认领新 Job。
- queued Job 转为 cancelled。
- Codex/Claude CLI 子进程会被主动终止。
- 已持久化候选结果保留。

## 18. Intent 方向租约

模型产生 Intent 后，调度器会：

1. 将 Intent 写入 `intents.jsonl`。
2. 计算 `verb + target + success_criteria + chain_id + sequence` 指纹。
3. 拦截重复方向。
4. 将唯一方向登记到 SQLite。
5. Reason Worker 认领一个开放方向。
6. Worker 运行期间持续续约。
7. 输出 Fact 时完成方向；输出 none/失败时释放方向。

长链路 Intent 可使用：

```json
{
  "parent_id": "I-parent",
  "chain_id": "RCE-CHAIN-01",
  "sequence": 3
}
```

## 19. 人工 Hint

Hint 是人工干预 Worker 的唯一正式通道。

```bash
python3 sorne add-hint vendor-name \
  --content "metacog：从更新链路与本地服务降级组合方向重新检查" \
  --target "update-service" \
  --priority 10
```

Hint 包含 `metacog` 时会强制触发一轮 Metacog。同一 Hint 不会重复触发。

## 20. 手动写入发现

```bash
python3 sorne add-fact vendor-name \
  --title "IPC 命令注入" \
  --category "ipc_endpoint" \
  --evidence "运行 PoC 后观察到命令返回 uid=0，日志中写入了可复核标记。" \
  --business-impact "攻击者可控制客户端进程并读取高价值业务数据。" \
  --reproduction-step "调用受影响 IPC" \
  --reproduction-step "传入测试 Payload" \
  --reproduction-step "检查命令输出和日志" \
  --evidence-path "evidence/ipc-command-execution.txt"
```

Guardian 会重新检查该发现，不会因为是人工输入就绕过质量门。

## 21. 工程指标

```bash
python3 sorne metrics vendor-name
```

输出包含：

- 十维攻击面覆盖率。
- 验证覆盖率。
- Fact 数量。
- phenomenon 数量。
- vulnerability 数量。
- 发现验证率。
- Intent 数量和重复拦截率。
- Job 数量、重试次数和成功率。

覆盖状态：

```text
unverified → observed → verified
```

## 22. 本地 HTTP 控制平面

生成一个随机长 Token，并作为环境变量：

```bash
export SORNE_SERVER_TOKEN="replace-with-a-long-random-token"
```

启动服务：

```bash
python3 sorne serve \
  --host 127.0.0.1 \
  --port 8765
```

打开控制台：

```text
http://127.0.0.1:8765/frontend/?vendor=vendor-name
```

### 远程调度器

在另一个终端设置相同 Token：

```bash
export SORNE_SERVER_TOKEN="replace-with-a-long-random-token"
```

然后：

```bash
python3 sorne automation-daemon vendor-name \
  --server http://127.0.0.1:8765 \
  --team default \
  --max-workers 4
```

远程查询：

```bash
python3 sorne automation-status vendor-name \
  --server http://127.0.0.1:8765

python3 sorne metrics vendor-name \
  --server http://127.0.0.1:8765
```

远程 Hint：

```bash
python3 sorne add-hint vendor-name \
  --server http://127.0.0.1:8765 \
  --content "metacog：检查 IPC 与更新链路的组合攻击面"
```

远程批准：

```bash
python3 sorne approve-gate vendor-name \
  --server http://127.0.0.1:8765 \
  --action continue \
  --reason "批准继续"
```

如未设置 `SORNE_SERVER_TOKEN`，API 在本地模式下不要求 Token。任何非本机部署都应强制设置 Token，并由反向代理提供 HTTPS。

## 23. 主要 HTTP API

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/project/state?vendor=...` | 项目、黑板和门禁状态 |
| GET | `/api/assets?vendor=...&limit=100&offset=0` | 分页读取企业资产、来源、画像任务和汇总；返回 `total/count/has_more/next_offset` |
| POST | `/api/assets/import?vendor=...&filename=...&logical_source=...&source_type=official` | 以原始请求体导入 CSV、TSV、TXT、JSON 或 XLSX |
| GET | `/api/target-profile/export?vendor=...` | 下载按主机名分工作表的画像 Excel |
| GET | `/api/automation/status?vendor=...` | Run / Job / Direction / Event |
| GET | `/api/metrics?vendor=...` | 工程指标 |
| GET | `/api/prompts?vendor=...` | 最近 100 次脱敏 Prompt 快照清单 |
| GET | `/api/prompts/content?vendor=...&path=prompt_snapshots/...` | 读取单次脱敏 Prompt |
| POST | `/api/automation/start` | 创建运行 |
| POST | `/api/automation/run` | 执行或恢复运行 |
| POST | `/api/automation/resume` | 将暂停运行恢复为 running |
| POST | `/api/automation/cancel` | 取消运行 |
| POST | `/api/gate/approve` | 批准门禁 |
| POST | `/api/hints` | 写入 Hint |

Token Header：

```text
Authorization: Bearer <SORNE_SERVER_TOKEN>
```

### 暴露面资产底座

“项目配置 → 暴露面资产底座”接受企业提供的 CSV、TSV、TXT、JSON 和
XLSX。导入不是把文件内容直接拼进 Prompt，而是先写入项目 SQLite：

1. 保存文件 SHA-256、逻辑来源和代际；
2. 保留工作表、行号、原始行 SHA-256 和已脱敏的最小资产投影，不持久化密码、Authorization、Cookie、API Key 或 URL 中的秘密参数原值；
3. 抽取并规范化 HTTP(S) URL、主机名和 IP，以协议、主机和端口形成稳定端点身份，合并多来源但保留完整 provenance；
4. 对新一代来源中消失且没有其他有效来源支持的资产标记 `stale`；
5. 对模型发现的关联域执行范围判定，范围外资产只入库、不进入画像 JSONL、主动画像、导出或后续模型上下文；
6. 将范围内待处理端点以 SQLite task assignment 交给前置 `profile_mapper`，把结果回写为 URL、功能、验证状态和技术栈。裸 IP 的 HTTPS seed 仅是访问表示，不改变原任务身份。

资产列表使用 `limit`/`offset` 稳定分页，默认每页 100、最大 500；前端明确显示当前区间和总数，不会再静默截断。没有可画像 Web endpoint 的客户端或源码项目会直接释放适用 Method Pack，不创建空画像分片。

项目 `target.json` 中的明确目标和界面手工/企业清单导入视为所有者提供的
范围；Worker 自主发现的资产只有与明确目标同域且未命中 `out_of_scope`
时才自动进入画像。失败任务在当前 Run 内不会无限重试；下一次由用户启动
新 Run 时才会重新释放。

SQLite 的内部 schema version 6 指的是提交 Outbox 数据模型版本，不是 Sorne 产品版本，也不是模型输出 JSON 的版本。V5 负责资产结构与敏感来源最小化；V6 在此基础上增加 CommitPlan、commit event、投影 receipt、lease 与恢复游标。旧项目启动后会先验证实际表、列、索引、唯一约束和外键：缺表或普通索引可幂等补齐，无法无损修复的结构异常会 fail closed，绝不会只因版本号正确就盖章。V5 清理过的 `raw_json`、`raw_target` 和 `observed_value` 不会恢复秘密原值；已有目标画像也不要求重新花费一次基础画像。

Worker 结果先在一个 SQLite 事务中校验 fencing token、写入冻结的
CommitPlan，并把 Job 标记为 `enqueued`；事务提交后投影器才写 JSONL、
Markdown 和派生状态。投影动作带稳定幂等键和 receipt，即使进程在文件
fsync 后、receipt 前崩溃，重启恢复也不会生成第二份领域记录。

## 24. 双层黑板

```text
projects/vendor-name/项目黑板_知识库.md
```

文件顶部为 YAML 控制层：

```yaml
vendor: vendor-name
phase: intake
elapsed_minutes: 15
asset_total: 12
high_risk_fingerprint_count: 3
current_decision: request_confirmation
gate_status: awaiting_approval
attack_surface_coverage:
  ipc_endpoint: verified
  listening_port: observed
```

下方为 Markdown 工作层：

- 当前测试路径。
- 资产与接口列表。
- 高价值发现。
- 线索与现象。
- 阻碍与止损。
- 截图和证据描述。

不建议 Worker 直接编辑黑板。应当由调度器通过结构化对象更新。

## 25. Guardian 结果分级

```text
phenomenon → lead/evidence → vulnerability
```

一个发现要升级为 vulnerability，至少需要：

- 没有“可能”“疑似”等投机表述。
- 不是 `static only` 或 `requires host`。
- 包含“执行了 X，观察到 Y”的实证。
- 完整复现步骤。
- 真实证据文件路径。
- 明确的业务影响。
- 足够长度的可审计证据描述。

降级为 phenomenon 的发现不会删除，后续可通过新的验证结果升级。

## 26. 十维客户端攻击面

| 维度 | Category |
|---|---|
| IPC / 本地通道 | `ipc_endpoint` |
| 网络监听 | `listening_port` |
| 提权路径 | `lpe_path` |
| 文件与路径信任 | `asset` |
| Electron / Web | `electron_config` |
| 协议、解析器和 FFI | `parser_target` |
| 供应链 | `supply_chain` |
| 凭证与密钥 | `credential_leak` |
| 设备权限与隐私 | `entitlement` |
| 生命周期和深链接 | `deeplink` |

Fact 进入黑板时会更新对应维度的 `observed` 或 `verified` 状态。

## 27. 备份与恢复

使用维护命令创建版本化、带 SHA-256 manifest 的备份，不要直接复制正在
使用 WAL 的数据库：

```bash
python3 sorne backup vendor-name --output exports/vendor-name.sorne-backup
python3 sorne verify-backup exports/vendor-name.sorne-backup
```

备份通过 SQLite online backup 获取一致快照，并排除 PID、日志、锁、
WAL/SHM、模型临时工作目录与运行时密钥缓存。项目存在活动 Run 时会
fail closed。

恢复默认禁止覆盖；替换恢复必须输入完整项目名，并且目标项目没有活动
Run：

```bash
python3 sorne restore exports/vendor-name.sorne-backup --confirm vendor-name
python3 sorne restore exports/vendor-name.sorne-backup --confirm vendor-name --replace
```

恢复会先在同文件系统隐藏 staging 中流式校验路径、类型、大小、压缩比、
文件摘要、JSON/JSONL、SQLite quick/FK 和 CommitPlan 摘要，再原子切换。

恢复未投影 Outbox 并刷新 Markdown/dashboard 派生视图：

```bash
python3 sorne rebuild-projections vendor-name --confirm vendor-name
```

先完成并复验备份、再删除源项目：

```bash
python3 sorne archive vendor-name \
  --output exports/vendor-name.sorne-backup \
  --confirm vendor-name
```

本地服务提供：

```text
GET /healthz
GET /readyz
```

`/readyz` 在首次 projector recovery 未完成、Schema/Outbox 异常或项目处于
维护切换时返回 503。外部模型、Docker 或 CLI 不可用只出现在依赖诊断中，
不会让控制台本身失去就绪状态。

## 28. 常见问题

### `强制门禁正在等待批准`

执行：

```bash
python3 sorne approve-gate vendor-name \
  --action continue \
  --reason "批准继续"
```

### `团队配置不存在`

确保：

```text
--team foo
```

对应：

```text
teams/foo.json
```

### Codex Driver 执行失败

检查：

```bash
codex --version
python3 sorne run-worker vendor-name --backend codex --role reason --dry-run
```

再检查 Codex 本身的登录或 Provider 配置。

### OpenAI-compatible 缺少密钥

确认 `api_key_env` 与实际环境变量同名：

```bash
export OPENAI_API_KEY="your-key"
```

不要把 Key 写入 `teams/*.json`。

### Job 一直 running

查看：

```bash
python3 sorne automation-status vendor-name
```

如 Worker 已崩溃，租约过期后任务会被重新认领。如需立即终止：

```bash
python3 sorne automation-cancel vendor-name \
  --run-id R-xxxxxxxxxxxx
```

### 候选结果延迟提交

通常是提交过程中触发了高危门禁。结果仍在 SQLite，批准门禁后执行：

```bash
python3 sorne automation-resume vendor-name \
  --run-id R-xxxxxxxxxxxx
```

### Container Worker 失败

检查：

```bash
docker version
docker image inspect your-worker-image:latest
```

确认镜像中存在 `worker_command` 指定的可执行文件。

## 29. 推荐的实战启动顺序

```bash
# 1. 初始化
python3 sorne init client-audit

# 2. 在前端“目标配置”填写测试目标（推荐）
# 或编辑 projects/client-audit/目标信息.md 与 target.json
# 编辑 projects/client-audit/检查清单.yaml

# 3. 预览三个角色的 Prompt
python3 sorne run-team client-audit \
  --team default \
  --max-workers 3 \
  --dry-run

# 4. 启动控制平面
export SORNE_SERVER_TOKEN="replace-with-a-long-random-token"
python3 sorne serve --host 127.0.0.1 --port 8765

# 5. 在另一个终端启动调度器
export SORNE_SERVER_TOKEN="replace-with-a-long-random-token"
python3 sorne automation-daemon client-audit \
  --server http://127.0.0.1:8765 \
  --team default \
  --max-workers 4 \
  --timeout 300

# 6. 查看正式控制台
# http://127.0.0.1:8765/frontend/?vendor=client-audit

# 7. 根据需要写入 Hint
python3 sorne add-hint client-audit \
  --server http://127.0.0.1:8765 \
  --content "metacog：从高业务影响倒推新的组合攻击路径"

# 8. 门禁审批
python3 sorne approve-gate client-audit \
  --server http://127.0.0.1:8765 \
  --action continue \
  --reason "批准进入下一迭代"

# 9. 查看指标
python3 sorne metrics client-audit \
  --server http://127.0.0.1:8765
```

## 30. 不建议的用法

- 不要让 Worker 直接编辑黑板。
- 不要将 API Key 写入团队 JSON。
- 不要在宿主机直接使用 `dangerously_bypass_sandbox`。
- 不要把 `run-team` 当成可恢复的生产队列。
- 不要手工删除 SQLite WAL 文件。
- 不要仅根据模型的“confirmed”就将现象当成漏洞。
- 不要在强制门禁期间直接修改 `state.json` 绕过审批。

## 31. 快速命令索引

```text
init                  初始化项目
run-worker            运行或预览单 Worker
run-team              一次性并发团队
automate              完整自动化迭代
automation-daemon     持续自动化守护进程
automation-status     查看 Run / Job / Lease / Event
automation-resume     恢复未完成运行
automation-cancel     取消运行
approve-gate          审批强制门禁
add-hint              人工干预
add-fact              手动提交发现
metrics               查看覆盖率和可靠性指标
dashboard             生成离线状态快照
serve                 启动 HTTP 控制平面
```
