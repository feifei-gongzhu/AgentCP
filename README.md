# AgentCP 安全研究引擎 V3.1

> 完整安装、模型配置、自动化、远程协议、恢复与排错请阅读 [docs/USAGE.md](docs/USAGE.md)。

这是一个并发安全研究黑板控制平面。V3 将 Method Pack、PlanBatch 假设组合、同一 Run 多波执行、反事实、长期 Lesson 记忆、确定性 Guardian 与人工裁决组成一个可恢复的工程化系统。每个 Worker 可独立选择 AgentCP 本地 Docker、CT `agent-compose` 或本地 CLI；`agent-compose` 是可选运行时，不再是系统前置条件。

## 核心约束

- Reason、Metacog、Reviewer 可并发运行，批次结束后再统一经过 Guardian 写入黑板。
- Executor 独占 Intent 认领权，实际执行后必须将原始结果写入 `evidence/`，证据文件通过路径、非空和 SHA-256 校验后才能关联 Fact。
- 自动化使用 Stigmergy 循环：Worker 无状态，只通过 Fact / Intent / Hint 共享状态。
- 任务队列持久化在 SQLite，支持租约、心跳、重试、崩溃恢复和取消。
- 项目所有测试目标按所有者声明统一视为已授权，代码中固定为 `authorization=authorized` 和 `scope=["*"]`。
- 每完成一个子任务，或同一节拍达到 15 分钟，立即进入 `awaiting_approval`。
- 待批准时，继续计时和 Worker 写回都会被代码拒绝。
- 漏洞假设的潜在危害与验证动作的操作风险分开裁决；只有高/严重操作风险才触发人工门禁。
- Web 与客户端 Method Pack 各自提供十维攻击面、动态检查清单和初始假设组合。Reason/Metacog 以 PlanBatch 一次提交多条正交假设，由确定性评分选择。
- Reason 产生的新方向会在同一 Run 下一波立即交给 Executor，不再等下次人工启动。
- 模型只能提出漏洞候选，不能决定漏洞成立。Guardian 只降不升：必须同时满足安全边界突破（因子 A）与可复核证据（因子 B），才能进入“系统漏洞池”。
- 进入系统漏洞池后仍须人工认可、调级、驳斥、降级或要求复测；人工驳斥不会篡改系统原判，而是形成独立的长期质量账本和反例记忆。
- `stop_loss` 是 Run 级终结态。控制版本（fencing token）会拒绝停止前 Worker 的迟到写回，避免已止损运行被自动续期复活。
- 超时、认证失败、WAF 阻断等结果作为有作用域、有时效的负向证据保存；有效期内自动剪枝，失效或环境变化后允许重新验证。
- WAF 不等于放弃。系统会建立独立的受预算约束的 WAF 刻画分支；每轮只改变一个抽象变量族，耗尽预算仍无稳定差分时自动止损。

## 双层黑板

每个项目的主黑板为：

```text
projects/{厂商名}/项目黑板_知识库.md
```

文件顶部是机器可读 YAML 控制层，下方是 Markdown 工作层。项目同时生成：

```text
目标信息.md
检查清单.yaml
项目黑板_知识库.md
决策日志.md
facts.jsonl
intents.jsonl
evidence.jsonl
negative_evidence.jsonl
human_verdicts.jsonl
refutation_memories.jsonl
waf_assessments.jsonl
waf_events.jsonl
hypotheses.jsonl
plan_batches.jsonl
counterfactuals.jsonl
lessons.jsonl
phase_events.jsonl
decision_log.jsonl
state.json
```

## 可信发现生命周期

```text
Executor 原始证据
  → Evidence Normalizer（验证证据文件与结构化指标）
  → Guardian A+B 确定性裁决
  → 系统漏洞池
  → 人工认可 / 调级 / 驳斥 / 降级 / 要求复测
  → 长期误报率与反例记忆
```

长期质量账本按“项目哈希 + 发现哈希”记录最新人工结论，不保存目标、域名或证据正文。重复出现的驳斥模式只生成规则候选，不会直接改写 Guardian；规则仍需历史回放和人工批准后才能启用。

## 快速开始

推荐从 Web 控制台初始化目标：

```bash
git clone https://github.com/feifei-gongzhu/AgentCP.git
cd AgentCP
docker build -t agent-compose-guest:latest -f third_party/agent-compose/guest-images/Dockerfile.agent-compose-guest third_party/agent-compose
python3 agentcp serve --host 127.0.0.1 --port 8765
```

打开 `/frontend/` 后按三级流程使用：

1. 在“任务中心”选择已有项目，或创建新的审计任务；项目可在这里删除。
2. 进入“项目配置”，填写目标、模型角色、运行模式和会话 API Key。新角色默认使用“本地 Docker”；完全不需要 Docker 时选择“本地 CLI”，需要 CT 编排能力时再选择“CT agent-compose”。
   每个 Agent 还可配置独立的项目级专属提示词；它随团队配置持久保存并在该 Agent 每次执行时注入。运行中提交的项目所有者实时指令优先级更高。
3. 点击“开始审计”，系统保存未提交配置、启动真实模型团队，然后进入“执行与结果”查看队列、事件、证据和发现。

授权字段会自动固定为 `authorized / *`。

`third_party/agent-compose` 保留上游 AGPL-3.0 许可证和原始来源。`build/` 与 `.cache/` 是本地产物，不会提交到 Git。只有显式选择 `agent-compose` 模式时才需要构建其二进制；默认本地 Docker 只需要本地 guest image。

## 三种本地运行模式

- `local-docker`（默认）：AgentCP 直接创建和回收本地容器，不启动 agent-compose daemon。项目挂载为 `/workspace`，目标源码挂载为只读 `/target`。
- `agent-compose`：显式使用 vendored CT agent-compose 的 daemon、session 和 sandbox 能力。该模式需要先构建 `third_party/agent-compose/build/agent-compose`。
- `local-cli`：不使用 Docker，直接调用本机 Codex CLI、Claude Code、Ollama 或 OpenAI-compatible 接口。该模式保留超时、取消、密钥脱敏和工具事件，但隔离强度低于容器模式。旧配置中的 `host-native` 会自动迁移为此模式。

Claude 本地 CLI 仍会隔离用户级路由变量和设置，不读取或修改 CCSwitch。`danger-full-access` 在本机 Claude 模式下仍被禁止。

也可以继续使用 CLI：

```bash
python3 agentcp init production-security
python3 agentcp run-team production-security --team default --max-workers 4 --dry-run
```

启动一次完整自动化迭代：

```bash
python3 agentcp automate production-security --team default --max-workers 4
```

持续守护模式会自动运行，在强制门禁处等待，用户批准后自动开始下一迭代：

```bash
python3 agentcp automation-daemon production-security --team default --max-workers 4
```

查看持久化运行状态：

```bash
python3 agentcp automation-status production-security
```

取消运行：

```bash
python3 agentcp automation-cancel production-security --run-id R-xxxxxxxxxxxx --reason "用户停止"
```

推进 15 分钟会强制停止：

```bash
python3 agentcp tick production-security --minutes 15
```

用户明确批准后才能继续：

```bash
python3 agentcp approve-gate production-security --action continue --reason "同意继续当前高价值路径"
```

使调度器只通过 HTTP 协议访问控制平面：

```bash
export AGENTCP_SERVER_TOKEN="一个随机长密钥"
python3 agentcp serve --host 127.0.0.1 --port 8765
python3 agentcp automation-daemon production-security --server http://127.0.0.1:8765
```

子任务完成时主动触发强制节拍：

```bash
python3 agentcp complete-subtask production-security --summary "完成资产去重和高危指纹筛选"
```

写入一个候选发现：

```bash
python3 agentcp add-fact production-security \
  --title "管理端命令注入" \
  --category "command_execution" \
  --evidence "运行 PoC 后观察到回显，服务端日志返回可复核的命令执行标记。" \
  --business-impact "攻击者可控制服务端进程并读取高价值业务数据。" \
  --reproduction-step "发送受控请求" \
  --reproduction-step "核对服务端日志标记"
```

## 本地控制台

```bash
python3 agentcp serve --host 127.0.0.1 --port 8765
```

打开 `http://127.0.0.1:8765/frontend/`。控制台使用“任务中心 → 项目配置 → 执行与结果”的渐进流程，支持实时项目状态、并发 Job、事件流、证据内容、Fact / Intent、十维覆盖、Hint、门禁审批、真实模型团队启动和安全项目删除。

角色配置可直接在前端增删和修改。保存后生成 `projects/{项目名}/team_config.json`，下一次以 `default` 团队启动时自动使用项目配置。真实 API Key 可在“会话 API Key”中注入后端进程内存，不写入配置文件、数据库、日志或页面响应；服务重启后需要重新注入。

AgentCP 的 Claude 子进程始终隔离用户级/本地级路由配置；角色配置中转站时，以前端项目配置为准。这个过程不会读取或改动 CCSwitch。

构建受限容器 Executor：

```bash
docker build -t agentcp-worker:latest worker-container
python3 agentcp automate production-security --team production-container --max-workers 4
```

真实执行前建议使用 `--dry-run` 预览各并发 Worker 上下文。

## 验证

```bash
python3 -m compileall -q src
.venv/bin/python -m pytest -q
```

如本机未安装 pytest，可先执行编译检查和 CLI 烟测。
