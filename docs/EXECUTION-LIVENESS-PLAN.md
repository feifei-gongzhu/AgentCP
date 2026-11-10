# 执行态对账施工方案（孤儿意图 + 模型恢复）

依据 01 号基线第六、十、十一、十二、十四至十七章。原件保持只读。本方案把两个表面不同、实为同根的缺陷合并处理：**执行健康状态只存在于瞬时日志与进程内存，没有落成可对账的持久事实**，于是控制器（Orchestrator/Planner/Verifier）和界面都在基于过期或缺失的状态做判断。

与 GPT 的 `INTENT-LIVENESS-PLAN.md` 相比，本方案采纳其正确骨架（确定性对账、有界重试、接搁置回溯、无新事件恢复验收），但砍掉三处过度设计（独立的 retry 调度表、回溯 UI、六类原因全表），只建承重墙。

## 0. 论文依据与根因

- [PentestGPT PTT §5.3](https://arxiv.org/html/2308.06782v2)：任务树上每个节点的状态（to-do / done / dead-end）是「已发生事实」的确定性函数，由控制器每步回写并据此选下一步。
- [MemWalker §3](https://arxiv.org/html/2310.05029v1)：系统始终知道「在树的哪个节点」，分支探空则确定性回溯到父节点换兄弟分支。

两篇共同骨架：**探索状态是一棵树，节点状态由确定性对账维护，死分支回溯换路，LLM 只在自洽的树上导航。**

三个病症同根（事实未持久化为可对账记录）：

1. **孤儿意图**：取消 attempt 不回写 intent 状态（[attempts.mjs:941](../lib/store/attempts.mjs:941) 只 UPDATE attempts），意图冻结在 `running`。实况：I-PRJ-0003-0011、0013 名下 attempt 全 cancelled，全库 0 活跃 attempt。
2. **模型崩溃不自动恢复**：调度指纹在模型调用**前**写入进程内存（[runtime.mjs:327](../lib/agents/runtime.mjs:327)），`provider_error` 后只 `log.error`（[runtime.mjs:333](../lib/agents/runtime.mjs:333)）。进程存活 + API 故障时，指纹仍在内存、无新事件改变指纹 → 下一轮 `signalChanged=false` 永久跳过。
3. **界面把「配了」当「连得上」**：`configured` 纯读本地 llm.json（[diagnostics.mjs:214](../lib/store/diagnostics.mjs:214)），从不反映最近一次 API 调用成败。系统**根本没有**模型健康的持久记录可显示。

## 1. 统一的结构化原因码（对账分流的前提）

当前 Worker 未完成收尾对 `final` / `max_steps` / `provider_error` 全部走同一个 `attemptLifecycle(action:"cancel")`（[worker.mjs:1550](../lib/agents/worker.mjs:1550)），reason 仅人类文本，对账器无结构化依据区分「该重试」与「该搁置」。先补原因码，精简为三类：

| reason_code | 触发事实 | 对账去向 | 论文概念 |
|---|---|---|---|
| `retryable` | 模型超时 / 429 / 5xx / 进程中断 / 租约过期 | 意图回 `queued`，**不消费方向失败预算** | 有界重试 |
| `reassign` | 协调者主动取消以换执行者 | 意图回 `queued`，保留取消原因 | 换执行者 |
| `dead_end` | 方向显式放弃 / 记录表明必要条件不满足 | 意图 `blocked` + 写 branch_shelving 带唤醒条件 | 回溯 / dead-end |

落地：
- `attemptLifecycle` 的 `cancel` 动作（[attempts.mjs:914](../lib/store/attempts.mjs:914)）新增可选入参 `reason_code`，写进 `recovery_note` JSON（已是 JSON，见 [attempts.mjs:945](../lib/store/attempts.mjs:945)），默认 `reassign` 保持旧语义。
- Worker 收尾（[worker.mjs:1553](../lib/agents/worker.mjs:1553)）按 `outcome.stop_reason` 映射：`provider_error`→`retryable`，`max_steps`→`retryable`（已存检查点，见 [worker.mjs:1509](../lib/agents/worker.mjs:1509)），`final`→`reassign`。
- recovery.mjs 的 sweep（过期租约→interrupted，[recovery.mjs:585](../lib/store/recovery.mjs:585)）对应 `retryable`。
- **关键不变式**：模型中断绝不可映射为 `dead_end`，否则会把健康方向误判为不可达永久搁置（正是 PRJ-0003 的风险）。

## 2. 确定性对账原语 `reconcileIntentLiveness`

强制不变式：**意图 `running` ⟺ 名下至少一个 `leased`/`running` 的 attempt**。

1. 把 `transitionIntent`（[intents.mjs:1468](../lib/store/intents.mjs:1468)）事务体内的写入（状态校验、state_version、历史、Outbox）提取为**事务内同步原语** `applyIntentTransition(db, ...)`，`transitionIntent` 改为薄包装。新增 `reconcileIntentLiveness(db, { projectId, intentId, triggerAttemptId })`，入参为事务句柄 `db`（**禁止再调 `runSerial`**，会死锁）。
2. 对账逻辑（纯 `db` 同步）：
   - 重读意图当前状态；非 `running` 直接返回（幂等）。
   - 查名下活跃 attempt；仍有则保留（尊重 GPT §2.1「还有其他活跃 Attempt 的意图不动」）。
   - 无活跃 attempt → 读触发 attempt 的 `recovery_note.reason_code` 分流：`retryable`/`reassign` → `applyIntentTransition(db, action:"requeue")`；`dead_end` → `applyIntentTransition(db, action:"block")` + 同事务写 branch_shelving。
3. **新增意图转换边**：当前 [intents.mjs:48](../lib/store/intents.mjs:48) 的 `running` 无「退回 queued」出边。新增 `requeue: { to: "queued", from: ["running"] }`。`block` 复用现有 blocked 边。
4. 接入点（都在已有事务内，零新 runSerial）：
   - attempt 落终态的事务尾部：`attemptLifecycle` 的 cancel（[attempts.mjs:941](../lib/store/attempts.mjs:941)）、recovery sweep（[recovery.mjs:585](../lib/store/recovery.mjs:585)）。
   - Orchestrator tick 开头的兜底全项目扫描（见 §4）。

## 3. 模型健康持久记录 + 失败不消费指纹

`model.mjs` 是纯 provider（无 DB 访问），健康记录在**包一层的运行时**做，不污染 provider。

1. **新迁移 0013**：`provider_health(project_scope TEXT, provider TEXT, last_success_at, last_error_at, last_error_kind, consecutive_failures INTEGER, next_retry_at, updated_at)`。`last_error_kind ∈ {rate_limit, timeout, server_error, auth_error, config_error, unknown}`。
   - httpProvider 已能区分：429（[model.mjs:167](../lib/agents/model.mjs:167)）、超时 AbortError（[model.mjs:162](../lib/agents/model.mjs:162)）、HTTP !ok（[model.mjs:180](../lib/agents/model.mjs:180)）。让 chat 抛出带 `kind` 字段的错误，运行时据此写健康记录。
2. **失败不消费指纹**：把 [runtime.mjs:327](../lib/agents/runtime.mjs:327) 的 `lastCoordinatorSignal.set` 从模型调用**前**挪到**成功后**；`provider_error` 时不记指纹 → 下一轮 `signalChanged` 自然为真，重试。
3. **退避 + 共享冷却**：每 tick 调模型前检查 `provider_health.next_retry_at`；未到则该 provider 全角色跳过（Orchestrator/Planner/Verifier 共享冷却，不轮流打满挂掉的 API）。退避用 model.mjs 已有的 20s×n（[model.mjs:134](../lib/agents/model.mjs:134)）同款，连续失败递增。
4. **区分故障类型**：`auth_error`/`config_error` 不退避重试（重试无用），标记为「需用户处理」，配置更新（llm.json 写入事件）后清零重试。

## 4. 把对账与健康接进运行时读取之前

在 `runOnce` 读 workload、调模型之前（[runtime.mjs:295](../lib/agents/runtime.mjs:295) 队列准入之后）插入：
1. recovery sweep（已有）→ 过期租约 interrupted。
2. **全项目孤儿兜底扫描**：对每个 `running` 且无活跃 attempt 的意图调 `reconcileIntentLiveness`（覆盖正常写路径漏网的历史记录）。
3. 修 **workload 过滤器**（[runtime.mjs:52-53](../lib/agents/runtime.mjs:52)）：当前「可派发 = proposed/queued 且**从未有 attempt**」，回到 queued 的意图有历史 attempt 会被永久漏掉（GPT §3.1 catch 正确）。改为「proposed/queued 且无活跃 attempt 且无未到期退避」。同步改 [orchestrator.mjs:1875](../lib/store/orchestrator.mjs:1875) 的 dispatchable 统计口径。
4. **移除** Orchestrator 提示词里「手动修复孤儿」那条（[orchestrator.mjs:70](../lib/agents/orchestrator.mjs:70)）——对账已确定性完成，LLM 回归导航职责；保留 `orphaned_running_intents` 作为不变式告警（正常应恒为 0）。

## 5. 界面两层状态

1. diagnostics `llm` 块（[diagnostics.mjs:217](../lib/store/diagnostics.mjs:217)）新增 `reachable`（读 provider_health：`next_retry_at` 未到或最近成功）、`last_error_kind`、`next_retry_at`。`configured` 保留原义。
2. 工作台（[workbench.page.mjs:819](../lib/ui/pages/workbench.page.mjs:819)）两层并列：
   - 项目层：「运行中」/「等待接续」
   - 模型层：「模型可用」/「模型暂不可用（429，预计 30s 后重试）」/「需更新凭据」
   - 意图层：孤儿对账后显示「等待重新派发」而非虚假「执行中」。
3. 恢复后健康记录自动翻正，UI 无需手动刷新即反映真实态。

## 6. 回归与存量修复（全部本地、不碰网络）

- **隔离库复现**：取消、过期、失败、暂停、正常完成五种 attempt 收尾，验证对账后零孤儿、历史/事件只写一次、幂等（重复 tick 不重复转换）。覆盖「还有另一个活跃 attempt 时不动意图」「完成后复核前崩溃」「同时派发与取消」。
- **无新事件恢复（核心验收，GPT §4 采纳）**：本地注入一个「中途抛 provider_error、恢复后正常」的替身 provider（经 `pctx.__modelProvider`，见 [model.mjs:223](../lib/agents/model.mjs:223)）。让一项工作停在半截，恢复 provider，**期间不发消息、不重启、不点继续**。断言：(a) 工作台先显示模型故障与等待原因；(b) 原工作自动续跑并提交结果；(c) 故障前已发出的外部动作不被盲目重放（unknown 工具调用先核查，§10.2）；(d) 模型中断未消费该方向失败预算、未写成 dead_end。
- **退避验收**：连续失败递增退避，退避期禁止派发，到点可被调度发现；`auth_error` 不盲目重试、配置更新后清零。
- **存量归位**：对 I-PRJ-0003-0011、0013 用数据库副本做**只读预演**，展示旧状态、触发 attempt、recovery_note、拟转换、归类（二者为 429/中断 → `retryable` → requeue，**非** dead_end）。预演确认后走同一对账事务归位，检查 state_version。
- **门禁**：`npm test` 加上述场景，不调用真实模型。

## 7. 砍掉的过度设计（YAGNI）

- GPT §2.4 独立 retry 调度表 + 复杂退避策略 → 复用 model.mjs 已有退避 + provider_health.next_retry_at，不新建调度表。真观察到重派风暴再加。
- GPT §3.3 Intent→Goal 回溯 UI + 兄弟候选列表 → UI 增强非 bug 修复，推后。
- GPT §1 六类收尾原因 → 精简为三类；产生不出来的类别不建死代码。

## 施工顺序

1. 原因码（§1）——其余一切的前提。
2. 迁移 0013 provider_health（§3.1）。
3. `reconcileIntentLiveness` + requeue 边 + workload 过滤修复（§2、§4）——闭合孤儿。
4. 健康记录接线 + 失败不消费指纹 + 退避（§3、§4）——闭合模型恢复。
5. 界面两层状态（§5）。
6. 测试 + 存量归位（§6）。
