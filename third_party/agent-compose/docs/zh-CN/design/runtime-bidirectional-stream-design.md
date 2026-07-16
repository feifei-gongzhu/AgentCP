# Runtime 双向交互流设计

## 背景

agent-compose 当前 daemon 到 runtime 的执行边界以 `ExecStream` 为核心：

```go
ExecStream(context.Context, *Session, VMState, ExecSpec, ExecStreamWriter) (ExecResult, error)
```

这个接口能表达“一次性启动参数 + runtime 单向输出流”，但不能表达 stdin、TTY、窗口 resize、signal/cancel、agent 多轮输入、结构化运行事件等持续交互能力。因此当前 `exec`、`run --command`、loader command、cell、agent prompt 依赖 `command-request.json`、prompt file、script file、stdout marker、result file 等文件协议补足控制语义。

本设计的目标是在不破坏现有业务逻辑和产物结构的前提下，把底层执行边界升级为可双向交互的 runtime stream。第一阶段只实现 Docker driver 的完整链路，Microsandbox 和 BoxLite 通过清晰的 capability contract 预留后续接入。

## 目标

1. 保持普通 `exec`、`run --command`、`run --prompt`、loader、cell 的现有行为不变。
2. 新增底层双向流能力，支持 `stdin`、`stdin EOF`、`TTY`、`resize`、`signal/cancel`、`stdout/stderr`、`result`、`agent event`。
3. 优先打通 Docker driver 的 `exec/run -it` 链路。
4. 明确 `--command -it` 和 `--prompt -it` 的不同语义：
   - `--command -it` 是进程级 TTY attach，对齐 `docker exec -it`。
   - `--prompt -it` 是 agent 会话级多轮交互，不是裸进程 stdin/stdout。
5. 文件产物继续走现有挂载目录和文件落盘机制，不做 inline artifact。
6. 对外 API 保持稳定和丰富：unary、server-stream、bidirectional stream 三种形态都保留；内部实现逐步收敛到底层双向 stream。
7. `logs` / `logs --follow` 继续使用同一个对外接口，内部升级为“文件快照 + 实时 fanout”的观察流。

## 非目标

1. 第一阶段不实现 Microsandbox 和 BoxLite 的 stdin/TTY/resize。
2. 不把 workspace 大文件、artifact 文件主体、LLM facade HTTP/SSE 合并进 runtime stream。
3. 不把 `run --prompt -it` 映射成 `agent-compose exec <sandbox> -it codex` 或 `run --command "codex" -it`。
4. 不删除现有 `command-request.json`、`command-result.json`、`stdout.txt`、`stderr.txt`、`output.txt`、`transcript.txt` 等兼容产物。
5. 不废弃普通 `ExecStream` / `RunAgentStream` server-stream API；它们是 attach engine 的 server-stream projection。

## 总体模型

新模型分三层：

```text
CLI local stdin/stdout/tty
  <-> daemon external bidirectional RPC
  <-> daemon RuntimeInteraction contract
  <-> driver/native attach 或 runtime wrapper stream
  <-> guest process 或 agent SDK loop
```

对外接口保持三种使用形态：

```text
Exec / RunAgent
  -> 构造 attach start
  -> 执行内部双向 stream
  -> 聚合输出/result
  -> 返回 unary response

ExecStream / RunAgentStream
  -> 构造 attach start
  -> 执行内部双向 stream
  -> 关闭或不使用 stdin
  -> 将 attach output/result 投影成 server stream response

ExecAttach / RunAttach
  -> 直接暴露 bidirectional stream
  -> 支持 stdin/resize/human_message 等持续输入
```

实现层逐步归一：

```text
external API handlers
  -> daemon AttachEngine
  -> RuntimeInteraction
  -> Docker native attach 或 runtime wrapper framed stream
```

第一阶段为了降低风险，可以只让 `-it` 路径走 `ExecAttach` / `RunAttach` 内核；普通 unary/server-stream 仍保留现有路径。后续迁移时，handler 不应通过 RPC 调用自身的 `ExecAttach` / `RunAttach`，而应调用同一个 Go 内部 `AttachEngine`，避免协议栈递归和连接生命周期复杂化。

`ExecStream` / `RunAgentStream` 不标记为 legacy/deprecated。它们的长期定位是只读 server-stream projection，适合不需要 stdin 的 SDK/UI 调用。

## Driver 能力矩阵

第一阶段只要求 Docker 完整支持交互。其他 driver 必须能报告明确的 unsupported capability，不能静默降级成普通 `ExecStream`。

| driver | stdin | stdout/stderr | TTY | resize | 第一阶段策略 |
|---|---:|---:|---:|---:|---|
| Docker | 支持 | 已有基础 | 支持 | 支持 | 完整实现 |
| Microsandbox | 待确认 | 已有输出事件基础 | 待确认 | 待确认 | 返回 unsupported |
| BoxLite | 当前 Go/FFI 未暴露 stdin | 已有 stdout/stderr 回调 | FFI 有 `tty` 字段但未接通 | 未暴露 | 返回 unsupported |

建议新增 driver 扩展接口：

```go
type RuntimeInteractionCapabilities struct {
    NativeExec    bool
    WrapperStream bool
    Stdin         bool
    StdinEOF      bool
    TTY           bool
    Resize        bool
    Signal        bool
    Artifacts     bool
    AgentTurns    bool
}

type RuntimeInteractor interface {
    InteractionCapabilities() RuntimeInteractionCapabilities
    OpenInteraction(ctx context.Context, session *Session, vmState VMState, spec RuntimeStartSpec) (RuntimeInteraction, error)
}
```

`BoxRuntime` 可以先保持原有接口不变，通过类型断言识别是否实现 `RuntimeInteractor`：

```go
if interactor, ok := runtime.(RuntimeInteractor); ok {
    // 使用新双向能力
}
```

没有实现或 capability 不满足时，daemon 返回结构化错误。

## RuntimeInteraction Contract

底层 contract 表达执行事实，不绑定具体入口。

```go
type RuntimeOperationKind string

const (
    RuntimeOperationCommand RuntimeOperationKind = "command"
    RuntimeOperationAgent   RuntimeOperationKind = "agent"
)

type RuntimeStartSpec struct {
    OperationID string
    Kind        RuntimeOperationKind
    Origin      string
    Command     *RuntimeCommandSpec
    Agent       *RuntimeAgentSpec
    Cwd         string
    Env         map[string]string
    AttachStdin bool
    TTY         bool
    Rows        uint32
    Cols        uint32
    TimeoutMs   int64
    ArtifactDir string
}

type RuntimeInteraction interface {
    Send(RuntimeInputFrame) error
    CloseSend() error
    Recv() (RuntimeOutputFrame, error)
    Wait() (RuntimeResult, error)
}
```

输入帧：

| frame | 用途 |
|---|---|
| `stdin` | process stdin bytes |
| `stdin_eof` | 关闭 process stdin |
| `resize` | TTY rows/cols |
| `signal` | SIGINT/SIGTERM/KILL 或 driver 等价控制 |
| `human_message` | agent prompt interactive 的下一轮用户输入 |
| `cancel` | 取消 operation |

输出帧：

| frame | 用途 |
|---|---|
| `started` | runtime 已启动 operation |
| `stdout` | process stdout 或 TTY 合流 bytes |
| `stderr` | 非 TTY process stderr |
| `agent_event` | agent message/tool/progress 等结构化事件 |
| `agent_turn_completed` | agent 一轮结束，CLI 可显示下一轮输入提示 |
| `result` | operation 最终结果 |
| `error` | protocol/driver/runtime 错误 |

## Docker Native Attach

`--command -it` 走 Docker native exec attach。

Docker exec create 需要设置：

```go
containerapi.ExecOptions{
    AttachStdin:  spec.AttachStdin,
    OpenStdin:    spec.AttachStdin,
    AttachStdout: true,
    AttachStderr: !spec.TTY,
    Tty:          spec.TTY,
    Cmd:          append([]string{spec.Command}, spec.Args...),
    Env:          dockerEnvList(spec.Env),
    WorkingDir:   spec.Cwd,
}
```

数据处理规则：

1. 非 TTY：使用 Docker stdcopy 拆 stdout/stderr。
2. TTY：stdout/stderr 合流，按 terminal bytes 投影为 stdout。
3. stdin：CLI 发来的 bytes 写入 hijacked connection。
4. stdin EOF：关闭写方向或关闭 attach stdin。
5. resize：调用 Docker exec resize API。
6. context cancel/client disconnect：关闭 attach connection，并尽力 signal/终止远端 exec。

TTY transcript 必须标记 `tty=true`，不能假装 stderr 可可靠拆分。

## `--command -it` 外部语义

命令：

```bash
agent-compose exec <sandbox> -it bash
agent-compose run <agent> --command bash -it
```

语义：

1. `-i/--interactive` 表示 attach local stdin。
2. `-t/--tty` 表示分配 TTY，要求 `-i`。
3. `--json` 与 `-i/-t` 互斥。
4. 不启用 `-i` 时沿用普通 server-stream 行为。
5. driver 不支持时返回明确 unsupported 错误。

`run --command -it` 仍然创建 ProjectRun，维护 run status，写 run transcript，执行完成后进入 succeeded/failed/canceled。

## `--prompt -it` 外部语义

`run --prompt -it` 不是进程级 TTY，而是 agent 会话级多轮交互：

```text
CLI sends first human message
runtime agent SDK streams assistant/tool/progress events
runtime sends agent_turn_completed
CLI prints local input prompt
CLI sends next human message
...
CLI sends /exit or EOF
runtime sends final result
```

这条路径必须接入现有 prompt runner，而不是让用户显式执行 Codex CLI。

第一阶段建议优先支持 Codex provider，因为当前 `CodexRunner` 已经具备有利基础：

1. 使用 `@openai/codex-sdk`。
2. `runStreamed` 能产生事件流。
3. 已保存 provider session id。
4. 下次运行可以 `resumeThread`。

runtime 侧需要从一次性方法：

```ts
runPrompt(promptText): Promise<AgentResult>
```

演进出交互式 session loop：

```ts
interface AgentInteractiveRunner {
  start(): Promise<AgentSessionInfo>
  runTurn(prompt: string): AsyncIterable<AgentEvent>
  close(): Promise<AgentResult>
}
```

Codex 实现可以复用同一个 thread，每次用户输入调用一次 `thread.runStreamed(prompt)`。每轮完成后 runtime 发送 `agent_turn_completed`，daemon/CLI 才显示下一轮输入提示。

Provider 能力必须 capability 化：

| provider | prompt interactive 第一阶段策略 |
|---|---|
| Codex | 优先实现 |
| Claude | 确认 SDK session/continue 能力后接入 |
| Gemini | 确认 SDK session/continue 能力后接入 |
| OpenCode | 确认能力后接入 |

如果 provider 不支持 agent turn loop，应返回明确错误。

### `--prompt -it` 与 output schema

多轮交互中 output schema 容易产生歧义。建议第一阶段：

1. `--prompt -it` 禁止 output schema；或
2. 只允许显式结束命令触发最终结构化结果。

为了降低复杂度，第一阶段推荐禁止 output schema。

## 外部 Connect API

现有 unary 和 server-stream API 不能承载 client stdin/resize/human message，因此需要新增双向 RPC。但新增 RPC 不意味着废弃原接口；对外接口应保持稳定且语义分层清晰。

```proto
service ExecService {
  rpc Exec(ExecRequest) returns (ExecResponse);
  rpc ExecStream(ExecRequest) returns (stream ExecStreamResponse);
  rpc ExecAttach(stream ExecAttachRequest) returns (stream ExecAttachResponse);
}

service RunService {
  rpc RunAgent(RunAgentRequest) returns (RunAgentResponse);
  rpc StartRun(StartRunRequest) returns (StartRunResponse);
  rpc RunAgentStream(RunAgentRequest) returns (stream RunAgentStreamResponse);
  rpc RunAttach(stream RunAttachRequest) returns (stream RunAttachResponse);
}
```

接口定位：

| 接口形态 | 外部语义 | 内部目标实现 |
|---|---|---|
| `Exec` / `RunAgent` | 一次请求，一次响应 | attach engine + output/result 聚合 |
| `ExecStream` / `RunAgentStream` | 一次请求，持续输出，无持续 stdin | attach engine + server-stream projection |
| `ExecAttach` / `RunAttach` | 双向持续交互 | attach engine 直接投影 |

`ExecAttach` 和 `RunAttach` 可以共享相似 frame：

```proto
message RuntimeAttachFrame {
  string operation_id = 1;
  uint64 seq = 2;
  oneof frame {
    RuntimeAttachStart start = 10;
    RuntimeAttachStdin stdin = 11;
    RuntimeAttachStdinEOF stdin_eof = 12;
    RuntimeAttachResize resize = 13;
    RuntimeAttachSignal signal = 14;
    RuntimeAttachHumanMessage human_message = 15;
    RuntimeAttachStdout stdout = 20;
    RuntimeAttachStderr stderr = 21;
    RuntimeAttachAgentEvent agent_event = 22;
    RuntimeAttachAgentTurnCompleted agent_turn_completed = 23;
    RuntimeAttachResult result = 24;
    RuntimeAttachError error = 25;
  }
}
```

`--command -it` 使用 `stdin/stdout/stderr/resize/signal/result`。

`--prompt -it` 使用 `human_message/agent_event/agent_turn_completed/result`。

实现要求：

1. handler 层只做协议适配、权限/参数校验、错误映射。
2. 执行语义下沉到内部 `AttachEngine`，不在 handler 之间互相发 RPC。
3. server-stream projection 不支持持续 stdin；它可以在 start 后立即 close send 或不打开 stdin。
4. unary projection 必须设置输出聚合上限，大输出完整内容以 transcript/log artifact 为准。
5. 本次新增的 `ExecAttach` / `RunAttach` 是新的对外能力；其他既有接口不做破坏性调整。

## CLI TTY 行为

CLI 需要新增 `-t/--tty`，并保留 `-i/--interactive`。

本地 TTY 流程：

1. 校验 `-t` 必须与 `-i` 一起使用。
2. `-t` 时检查 stdin/stdout 是 terminal。
3. 进入 raw mode。
4. 获取初始 terminal size，发送 start frame。
5. goroutine A：local stdin bytes -> request stdin frame。
6. goroutine B：SIGWINCH -> resize frame。
7. goroutine C：daemon response stdout/stderr -> local stdout/stderr。
8. 退出、错误或 cancel 时恢复 terminal mode。

`run --prompt -it` 的 CLI 行为不是 raw terminal。它应在 agent turn 完成后显示简单输入提示符，例如：

```text
agent> 
```

用户输入一行后作为下一轮 human message 发送。`/exit` 或 EOF 结束会话。

## 文件产物与双写

文件产物继续走文件和挂载目录，不做 inline artifact。

执行输出必须双写：

```text
runtime output
  -> 当前 attach/server stream response
  -> transcript/log 文件
```

对 `logs --follow` 还需要增加第三路 daemon 内部实时 fanout：

```text
runtime output
  -> 当前 attach/server stream response
  -> transcript/log 文件
  -> daemon RunLogHub subscribers
```

文件是 source of truth，内存 `RunLogHub` 只是实时加速通道。publish 失败不能让 run 失败；文件写入失败则应按现有执行错误处理。

command wrapper 当前已经天然适合双写。子进程输出处理应抽象为 sink：

```text
child stdout chunk
  -> emit RuntimeStdout frame
  -> write stdout.txt
  -> write output.txt
  -> append stdout/output capture
```

stderr 同理。

必须继续生成的文件：

| 文件 | 兼容要求 |
|---|---|
| `command-request.json` | 保留，内容可由新 start spec mirror 生成 |
| `command-result.json` | 保留，内容来自 RuntimeResult mirror |
| `stdout.txt` | 保留 |
| `stderr.txt` | 保留 |
| `output.txt` | 保留 |
| `transcript.txt` | 保留 |
| prompt/system/schema 文件 | prompt 路径继续保留 |
| agent session state | 继续写 provider session id |

prompt interactive 可以新增 per-turn artifact，但不能删除旧文件：

```text
state/agents/providers/codex.json
state/agents/transcript.txt
state/agents/turns/<turn-id>/prompt.txt
state/agents/turns/<turn-id>/result.json
```

## Logs 观察流

`logs` 和 `logs --follow` 对外继续复用 `FollowRunLogs`：

```proto
rpc FollowRunLogs(FollowRunLogsRequest) returns (stream RunLogChunk);
```

内部实现分两段：

1. `logs`：从 `LogsPath` 指向的文件读取 snapshot/tail，然后发送 final chunk。
2. `logs --follow`：先读取文件 snapshot/tail，再订阅 daemon 内部 `RunLogHub`，实时推送后续 chunk。

建议内部抽象：

```go
type RunLogPublisher interface {
    PublishRunLog(runID string, chunk RunLogChunk)
}

type RunLogSubscriber interface {
    SubscribeRunLog(runID string) (RunLogSubscription, func())
}
```

`RunLogChunk` 至少包含：

1. `RunID`
2. `Data`
3. `Offset`
4. `Stream`
5. `CreatedAt`

写入流程建议让 append 函数返回写入后的 offset：

```go
offset, err := appendProjectRunLogChunk(logsPath, chunk)
if err == nil {
    logHub.Publish(run.RunID, RunLogChunk{Data: chunk.Text, Offset: offset})
}
```

`FollowRunLogs(follow=true)` 的推荐顺序：

1. 先订阅 `RunLogHub`，避免订阅窗口内的新日志丢失。
2. 从文件按 `tail_lines` / `start_offset` 读取 backlog，记录最新 offset。
3. 消费 hub 消息，只发送 `msg.Offset > currentOffset` 的消息，避免重复。
4. 周期性检查 run 状态；terminal 后最后补读一次文件，再发送 final chunk。

这个设计允许多个 `logs --follow` 客户端同时观察同一个 run，也支持晚加入和断线后按 offset 恢复。它不直接消费 runtime attach stream，因为 attach stream 是执行会话，logs 是多消费者观察流，两者生命周期和 backpressure 语义不同。

## 状态机

### Command Attach

```text
Created
  -> Started
  -> Running
  -> StdinClosed
  -> Completed
  -> Closed
```

错误或断连进入：

```text
Running
  -> Canceling
  -> Failed/Canceled
  -> Closed
```

### Prompt Interactive

```text
Created
  -> AgentSessionStarted
  -> WaitingInput
  -> RunningTurn
  -> TurnCompleted
  -> WaitingInput
  -> Closing
  -> Completed
```

规则：

1. `RunningTurn` 时不接受新的 human message，除非后续明确支持 queued input。
2. `TurnCompleted` 后 daemon/CLI 才显示下一轮输入提示。
3. EOF 或 `/exit` 进入 Closing。
4. client disconnect 默认 cancel 当前 interactive foreground session。

## 兼容与废弃策略

1. 普通 `Exec`、`ExecStream`、`RunAgent`、`StartRun`、`RunAgentStream` 保留且对外语义不变。
2. `ExecStream` / `RunAgentStream` 不标记为 legacy/deprecated；它们是稳定的 server-stream projection。
3. 只有内部不再使用且确实对外不推荐的新旧字段，才考虑注释说明或 `deprecated = true`。
4. 文件产物不做破坏性删除。
5. 新 stream 的 result 是在线路径事实来源；旧 result file 是 mirror 和 crash recovery 依据。

## 技术难点

1. Docker hijack connection 的半关闭、cancel、stdin EOF 和 wait exit 顺序。
2. TTY raw mode 的恢复、SIGWINCH resize、Ctrl-C 行为。
3. TTY stdout/stderr 合流后的 transcript 表达。
4. Connect 双向流的 backpressure 和任一方向断开后的 runtime 清理。
5. Prompt interactive 中 agent turn boundary 的准确定义。
6. Provider SDK 多轮能力差异，尤其是 Claude/Gemini/OpenCode。
7. 新 stream 与旧 artifact 双写的一致性。
8. `RunLogHub` 与文件 offset 的去重、补偿和 backpressure。
9. unary projection 对大输出的内存上限和截断语义。

## 推荐第一阶段范围

1. 定义 internal `RuntimeInteraction` contract 和 capability matrix。
2. Docker 实现 native command attach。
3. 新增 `ExecAttach`，接通 `agent-compose exec <sandbox> -it ...`。
4. 新增 `RunAttach` 的 command 模式，接通 `run --command -it`。
5. Codex provider 实现 prompt interactive turn loop，接通 `run --prompt -it`。
6. `logs --follow` 从文件轮询升级为“文件 snapshot + RunLogHub 实时 fanout”。
7. Microsandbox/BoxLite 和非 Codex provider 返回明确 unsupported。
