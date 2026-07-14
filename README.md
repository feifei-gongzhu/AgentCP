# 渗透测试黑板控制平面 V2.0

> 完整安装、模型配置、自动化、远程协议、恢复与排错请阅读 [docs/USAGE.md](docs/USAGE.md)。

这是一个从零实现的并发渗透测试黑板控制平面。产品核心是本项目的 V2.0 方法论、确定性控制器与可恢复的多代理执行系统。

## 核心约束

- Reason、Metacog、Reviewer 可并发运行，批次结束后再统一经过 Guardian 写入黑板。
- Executor 独占 Intent 认领权，实际执行后必须将原始结果写入 `evidence/`，证据文件通过路径、非空和 SHA-256 校验后才能关联 Fact。
- 自动化使用 Stigmergy 循环：Worker 无状态，只通过 Fact / Intent / Hint 共享状态。
- 任务队列持久化在 SQLite，支持租约、心跳、重试、崩溃恢复和取消。
- 项目所有测试目标按所有者声明统一视为已授权，代码中固定为 `authorization=authorized` 和 `scope=["*"]`。
- 每完成一个子任务，或同一节拍达到 15 分钟，立即进入 `awaiting_approval`。
- 待批准时，继续计时和 Worker 写回都会被代码拒绝。
- 高危或严重 Intent 必须等待用户确认。
- 发现必须有可复核证据、复现步骤和具体业务影响，才能升级为 vulnerability。

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
decision_log.jsonl
state.json
```

## 快速开始

推荐从 Web 控制台初始化目标：

```bash
git clone https://github.com/feifei-gongzhu/AgentCP.git
cd AgentCP
python3 agentcp serve --host 127.0.0.1 --port 8765
```

打开 `/frontend/` 后按三级流程使用：

1. 在“任务中心”选择已有项目，或创建新的审计任务；项目可在这里删除。
2. 进入“项目配置”，填写目标、模型角色和会话 API Key，并核对项目黑板。
3. 点击“开始审计”，系统保存未提交配置、启动真实模型团队，然后进入“执行与结果”查看队列、事件、证据和发现。

授权字段会自动固定为 `authorized / *`。

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
