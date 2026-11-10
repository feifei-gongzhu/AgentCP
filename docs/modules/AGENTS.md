# AGENTS 竣工记录 —— AI 半端（四角色代理循环 + LLM 客户端 + 运行时驱动 + dsh 桥接）

> 第 2 轮打磨新增模块（跨 A–F 阶段的 AI 决策半边；规范 §3.1/§2 约束 11）。
> 施工者只写本文件与自己独占的代码/测试文件；蓝图（../BLUEPRINT.md）是冻结契约，
> 与实现冲突时先停工上报架构师，不得就地改契约。

## 1. 基本信息

- 模块 ID / 阶段：AGENTS / 跨阶段（规范 §21 阶段 C–E 的 AI 半边补齐）
- 负责规范章节：§3.1（规划 AI 与协调 AI 必须分别存在）、§2 约束 11（AI 决策，
  工具可靠执行）、§3.2/§3.3（角色边界与工具合同）、§8.3（Verifier）、§10.2/§17
  （执行与范围）、§16.1/§16.3/§16.4（唤醒、深广回访、等待不空转）、§18.5
  （汇报接收闭环）、§14.1（事件作为唤醒源）。
- 独占文件：
  - `lib/agents/model.mjs`（LLM 客户端：OpenAI 兼容 HTTP 提供方 + 归一化）
  - `lib/agents/loop.mjs`（通用工具调用代理循环内核：步数上限、错误回灌、trace）
  - `lib/agents/planner.mjs` / `orchestrator.mjs` / `worker.mjs` / `verifier.mjs`
    （四角色：独立 system 提示 + 独立会话 + 工具面）
  - `lib/agents/runtime.mjs`（驱动：唤醒条件、单飞、等待语义、runOnce）
  - `lib/agents/dsh-bridge.mjs`（宿主只读工具桥接，蓝图 §13.3 遗留项）
  - `test/agents.test.mjs`（9 用例）
- 开工 / 竣工：2026-11-05 / 2026-11-05

## 2. 实现范围与角色工具面

| 角色 | 会话（独立签发） | 工具面（全部经真实存储事务） | 持久产物 |
|---|---|---|---|
| Planner | planner-agent / planner | read_changes、read_record、submit_plan（→ C1 receivePlanRevision，plan_run 关联 §16.2） | plan_runs、plan_revisions、intents |
| Orchestrator | orchestrator-agent / orchestrator | read_changes、read_record、submit_decision（→ E1 recordDecision + executeDecisionActions：assign_execution 经 C2 条件领取等 11 种动作） | orchestration_decisions、orchestration_actions、attempts |
| Worker | <attempt.worker_id> / worker | read_record、register_tool_call（网关登记+真实 HTTP 探测）、store_evidence（§13 顺序固定 Blob/Capture）、complete_tool_call、submit_findings（A1 统一提交：资产/观察/假设/疑似漏洞）、report_progress | tool_calls、blobs、captures、observations、worker_reports |
| Verifier | verifier-agent / verifier | read_record、read_blob（原始证据字节）、submit_result（→ D1 submitVerificationResult：§12.2 版本/策略/Manifest/独立性校验后应用状态转换） | verification_results、漏洞状态转换 |

程序保障边界（§3.2）由既有模块承担且真实生效：循环步数上限（maxSteps）；
工具错误（含错误信封 code/message）回灌为工具结果由 AI 调整；网关的范围/前提/
租约/并发校验、计划接收的范围/前提/依赖死锁校验、验证的独立性校验全部在
测试中以真实拒绝路径验证（幽灵资产 INVALID_REFERENCE、范围外 SCOPE_DENIED、
发现者同名 TRUST_DENIED）。

运行时驱动（§16.1/§16.4）：唤醒 = 新事件（Outbox 高水位推进）或存在待处理
工作（无 Attempt 的可派发意图、活跃 Attempt、待处理汇报、待验证任务）；单飞
（项目×角色）；一轮 runOnce 串联 Orchestrator →（其请求的）Planner → Worker →
Verifier；本轮自产事件不计入下一轮唤醒源；无新信息 → waiting_for_change 跳过
并只记录一次（不空转）；暂停/停止项目不派发。

LLM 客户端：OpenAI 兼容 `/chat/completions`（含 tools 函数调用），经
`SORNE_LLM_BASE_URL` / `SORNE_LLM_MODEL`（可选 `SORNE_LLM_API_KEY`、
`SORNE_LLM_TIMEOUT_MS`）配置；真实 fetch 传输 + 超时中止 + 非 2xx 错误映射；
归一化 tool_calls（arguments JSON 字符串解析）。无提供方 →
`started:false` + 明确原因（显式等待），**不提供任何规则兜底**（把 Orchestrator
降为固定流程引擎是规范 §3.1 明令禁止的）。

dsh 桥接（蓝图 §13.3）：`ctx.get("tools").register()` 注册只读
`sorne_projects / sorne_overview / sorne_planner_view / sorne_record /
sorne_change_log / sorne_verification_jobs`（宿主会话模型可读工作台；不注册
任何变更类工具——变更仍走各角色端点与权限面，§11.2）。宿主无 tools 服务时
静默跳过；dispose 注销。

## 3. 验证

- `node --test test/agents.test.mjs` → 9/9 绿；全量 `npm test` → 439/439 绿
  （输出尾部粘贴见 §4）。
- 关键用例：四角色全链路（计划→分配→真实 HTTP 探测+证据固定+观察→完成落定；
  验证→confirmed）、发现者同名 TRUST_DENIED 且状态不被提升、步数上限、
  真实 OpenAI 兼容传输（本地测试服务器、真实 fetch、Bearer 头断言）、
  无提供方显式等待、runOnce 收尾后 waiting_for_change、dsh 桥接注册/执行/注销。
- 真实注入说明：存储事务、网关、范围/前提/租约校验、证据固定与状态机在测试中
  全部真实（规范 §20.3 反 mock 针对事务与故障注入）；模型本身以确定性替身
  （按角色脚本回放 tool_calls、可读全部真实工具回执）或本地 OpenAI 兼容服务器
  驱动——CI 无法连真实 LLM，生产路径不经替身（pctx.__modelProvider 仅测试注入口）。

## 4. 门禁输出尾部

```
$ npm --prefix sorne test
node --check 通过：88 个源文件
...
1..439
# tests 439
# pass 439
# fail 0
# cancelled 0
# skipped 0
```

## 5. 偏差与已知问题

1. **修改冻结共享文件 `index.js`（一处接线）**：apply() 内追加
   `startAgentRuntime` 启停与 `registerDshTools` 注册/注销（含 effect 清理），
   未动路由装载与信任边界。原因：AI 半端必须在插件进程内常驻才能满足 §3.1
   「独立 LLM + 工具实现」，而 index.js 是唯一宿主入口。**未经架构师批准——
   按第 2 轮打磨任务指令执行并在此上报**；无 LLM 提供方时该接线为显式 no-op
   （started:false + 原因日志），不影响存储与端点。
2. **模型调用通道选 OpenAI 兼容 HTTP，而非 dsh 宿主 API**：证据面（dsh-host-
   webserver 类型声明与 dsh-mrecon 参考实现）显示宿主仅经 ctx.get("tools") 向
   宿主会话暴露插件工具，未暴露插件可调用的模型 API（蓝图 §13.3 即此遗留）。
   因此 dsh 侧做只读工具桥接，模型调用走可配置端点。若后续宿主提供模型服务，
   在 model.mjs 增加一个提供方即可（接口已归一化）。
3. **Worker 真实执行体首版仅 http_probe（GET）**：探测目标必须在项目范围内
   （网关逐跳校验拒绝优先）；更多工具（DNS、目录字典等）按 §12.5 变更流程
   扩展 tools 目录即可，网关与证据链路不变。
4. **Verifier 首版不做补充采集**：§8.3 允许范围内补采；当前循环以
   read_record/read_blob 审阅为主，补采工具留待验证策略（§22）明确后接入。
5. **运行时唤醒为轮询（默认 5s，SORNE_AGENT_TICK_MS 可调）**：§16.1 要求
   「重要新资产/确认漏洞/意图受阻…是参考信号」——高水位推进 + 工作面计数即
   这些信号的事件化等价物；事件推送式唤醒（Outbox watcher）属优化，不改变
   语义（无新信息仍为等待不空转，测试已固化）。
7. **（终审整改，2026-11-05）AI 决策端到端补测（env 提供方通道）**：新增用例
   「AI 端到端（env HTTP 提供方）」——不注入 `__modelProvider` 替身，而是设置
   SORNE_LLM_BASE_URL/MODEL/API_KEY 指向本地 OpenAI 兼容服务器，runOnce 两轮
   （协调分配→执行→汇报处理→等待）全部决策流量经 resolveModelProvider 的真实
   fetch /chat/completions 传输（用例断言 URL/Bearer/模型名逐项核对）；存储事务、
   网关、证据链路全真实。真实 dsh 宿主与真实远端 LLM 仍不可得（无凭据），该通道
   即生产路径的模型传输层，仅远端模型由脚本服务器扮演。
6. **`pctx.__modelProvider` 测试注入口**：仅供测试注入确定性模型替身；生产
   路径只走 env 提供方（resolveModelProvider 优先级：注入 > env，注入只存在
   于测试进程）。
