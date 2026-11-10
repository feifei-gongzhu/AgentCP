# t08 · recovery / scope / diagnostics / llm-settings 测试精读

> 范围：4 个测试文件、共 30 个用例（recovery 12、scope 11、diagnostics 3、llm-settings 4），全部逐文件读完。
> 只读源码，未运行 npm test；结论均以当前文件行号为据。

## ① 文件与用例数

| 文件 | 行数 | 用例数 | 测试对象 |
|---|---|---|---|
| `test/recovery.test.mjs` | 728 | 12 | §20.2 指标、§18.1 Checkpoint、§18.2 七步恢复、场景 12/21/24、drill 端点 |
| `test/scope.test.mjs` | 558 | 11 | §17 范围匹配/三区/派发与逐跳闸门/场景 20、requires_state 谓词 |
| `test/diagnostics.test.mjs` | 162 | 3 | 诊断聚合（全局/单项目/404） |
| `test/llm-settings.test.mjs` | 265 | 4 | LLM 配置写入/脱敏/连接测试/解析顺序/热加载 |

## ② 锁定的行为清单

**recovery（真实端点 + 真实关库关服重启）**
1. `:210` 十类指标键齐全 + 数值可核对（重复意图=2、验证队列、孤立 Blob=1），并断言指标收集前后 outbox 行数不变（`:276-278`）。
2. `:284` /metrics 访问面：匿名 200、会话项目域 403 TRUST_DENIED。
3. `:303` Checkpoint 十一项逐项断言 + 关键结论在 `refs` + `CP-<pid>-` 编号 + 库行核对（`:324-350`）。
4. `:354` 新 Checkpoint 实时重建（旧快照不含新观察、`processed_boundary` 单调）。
5. `:371` 七步恢复：真实 `closeStore+closeAllStores+server.close` 后同目录重启（`:398-409`），断言步骤 1 degraded/缺失文件=1、步骤 2 pending≥1、步骤 3 中断 1 个 Attempt、步骤 4 unknown=1、步骤 6 演练生成 Checkpoint、步骤 7 不自动派发（`:437-445`）。
6. `:455` 场景 12：scope.revised 同事务落 Outbox → 重启后 drill 步骤 2 保留 → /changes 补投递 → consumer-acks applied。
7. `:517` 场景 24：同 submission_id 重发返回同 commit_seq/result_hash，outbox 与 submissions 行数不变。
8. `:550` 场景 21：有工作→active 不变；经真实 `transitionIntent cancel` 清空后在 drill 中 active→waiting；再 drill 幂等（wake_signals=[]、attempts 不变）；新计划事件作唤醒信号→恢复 active 并可派发。
9. `:619` blocked 意图不构成可执行工作，但进待重评估/可恢复清单；受阻恢复率指标经真实状态机核对（0.5）。
10. `:652` drill 鉴权（匿名/worker 403、跨项目 403、user/runtime 200）；`:674` 重复演练不重复中断（第二次 interrupted=0）。
11. `:704` 存储级 `runRecovery`：steps 序号 [1..7]、前三步标题原文、`drill:false`。

**scope（真实 A1 端点执行范围收缩/停止）**
1. `:155` 匹配单元语义：URL 端口默认值、通配子域不含裸域、URL 条目不匹配裸主机、对象条目缺 host 不匹配。
2. `:189` P0-5 跨 host 不匹配（deny/pending/allow 三态向量）+ `:217` `/v1/*` 前缀通配与 `/v10` 边界（仅字符串 URL 条目）。
3. `:239` 未配置范围：带目标派发与工具动作均 422 SCOPE_UNRESOLVED。
4. `:266` 三区优先级：deny 压过 allow、explicit_pending、unlisted，并断言 `assets.scope_status` 回写 allowed/denied/pending。
5. `:312` 场景 20：收缩前登记+启动放行 → 新版本 deny 后 register/start 均 SCOPE_DENIED → 已发出 complete 附 `touched_targets.verdict=denied` 与警告 + outbox `scope_violation_observed`（`:371`）→ 用户 stop 后工具与派发均 PRECONDITION_INVALID → 历史行保留。
6. `:401` 多目标任一 deny 整体拒绝；`:442` register 与 start 之间收缩在 start 被拦；未重申目标时 `targets_recheck=not_redeclared` 且放行（`:462-468`）。
7. `:473` `source_type=official` 自报字段不绕过授权；`:497` `requires_state=scope_status=allowed` 收缩后派发 PRECONDITION_INVALID；`:527` URL 条目的 scheme/端口/路径越界均 SCOPE_UNRESOLVED。

**diagnostics / llm-settings**
- `:49` 全局四态分组、llm 未配置不冒充可用、全局面不含 project 块；`:72` 单项目十块计数与库内事实一致、unknown 工具调用带 §10.2 纪律警示、未投影记 null；`:155` 未知项目 404 且无分页信封。
- llm：`:68` llm.json 落盘结构、所有响应不含明文 key、apiKey 缺省保留/空串清除、baseUrl/model 校验；`:125` 真实 OpenAI 兼容 stub 的成功/401/拒绝连接三态；`:180` store>env 与 per_role 覆盖；`:220` 热加载：未配置 started=false → PUT 后 started=true 且 runOnce 可驱动 → 删 llm.json 后 started=false 且 runOnce skipped。
## ③ 测试替身 / 隔离 / 时钟手法

- **隔离**：四文件均用 `makeTempDir`（`test/helpers.mjs:19` 的 `mkdtempSync`）+ 随机端口 `listen(0)`；recovery/scope 自带 `bootServer` 副本（recovery:57-82、scope:53-78），diagnostics/llm 用 `helpers.withTestServer`（helpers:28-93）。收尾：关服→`closeStore/closeAllStores`→`rmSync`（recovery:90-100、scope:80-90，helpers:75-80）。
- **进程重启替身**：不 mock，真实 `revokeSession`+`closeStore`+`closeAllStores`+`server.close` 后再对同一 dataDir `apply()` 起新服务（recovery:398-409、`bootServer` 复用同目录）。
- **时间/租约**：只把 `attempts.lease_expires_at` 写成过去 ISO 注入过期（recovery:193-200），不用 fake timers；「年龄」类断言只用 `>=0`（recovery:263、diagnostics:138,146）。
- **外部依赖替身**：llm-settings 用本地 `http` OpenAI 兼容 stub（:33-52），401 与连接拒绝为真实网络失败；不发真实 LLM 请求。
- **真实状态机优先**：recovery 场景 21 经 C1 `transitionIntent` 取消/阻塞并断言 `intent_state_history.via='transition'`（:573-585、:627-630）；scope 经 A1 端点写范围版本、经 A2 #10 建资产。反例：scope 的意图用直写 SQL 夹具（`seedIntent` scope:106-126）、diagnostics 的受阻意图/Attempt/unknown 调用/汇报全为直写行（diagnostics:108-131）。

## ④ 断言质量（过拟合 / 同义反复 / 被放宽 / 假绿）

- **被放宽**：recovery 幂等用例 `outbox2 - outbox1 <= 1`（:694）——允许 1 条新事件，若七步产生额外事件会被放过；diagnostics `schema_version >= 5`（:62）不校验当前迁移版本；recovery `events_after_boundary >= 0`（:436）恒真、`pending_total >= 1` 类断言偏弱。
- **同义反复/弱断言**：`assert.equal(proj.outbox.pending >= 1, true)`（diagnostics:145）；`assert.ok(m.outbox.by_status.total > 0)`（recovery:264）；`assert.ok(Number.isInteger(c.processed_boundary))`（recovery:339，只能证明是数字）。
- **过拟合实现文案**：diagnostics:59 `/绝不以「服务正常」暗示/`、recovery:440 `/不自动派发/`、scope:521 `/scope_status=allowed/`、diagnostics:143 §10.2 原文字串——改文案即碎，属契约自证而非行为断言。
- **假绿风险（真实存在）**：
  1. `test/recovery.test.mjs:704-727` 残留死代码——`:706-711` 构造 `project=null` 的 IIFE 后 `void`，实际未创建任何项目；该用例只在空库上验 steps 序号/标题，与「七步真实恢复」名不符（同文件其余用例才覆盖）。
  2. `test/diagnostics.test.mjs:108-131` `store.runSerial(...)` **未 await**，随后 `:133` 立刻发 GET /diagnostics；当前靠微任务顺序偶然通过，属潜在 flake（若驱动改为 await 顺序变化即失败）。
  3. `test/scope.test.mjs:109` 直写意图编号（`I-` + 8000~9999 随机数）：意图 id 是全局主键，两个意图随机碰撞（约 1/1999）时 INSERT 抛约束错误（flake），且绕开 C1 真实状态机。
  4. `test/llm-settings.test.mjs:220-265` 同时存在两个 runtime（`withTestServer` 的 apply 内建 runtime + 测试自建 `rt`）共用同一 dataDir/llm.json；且 helpers:42 `effect: (fn) => fn()` 丢弃 index.js 返回的 disposer，服务内 runtime 不会被 `stop()`（timer 有 unref，不挂进程，但会继续 tick/请求 stub）——热加载断言的干净程度存疑。
- **跳过/待办**：四文件无 `skip/todo`；llm-settings:255-256 的 `skipped` 是运行时行为字段，不是测试跳过。
- **范围越权负例**：跨 host 三态向量（scope:189-215）与 `/v1/*` 前缀边界（:224-234）质量高，但**只覆盖字符串 URL 条目**；对象条目 `{host, path_prefix}` 仅一条正向（:182），无 `/api` vs `/apix` 负例 → 恰好漏掉实现 `scope.mjs:135-137` 的路径前缀越界缺陷（见主报告 P0）。
- **恢复可重入**：recovery:674-699 断言第二次演练 `interrupted=0` 且事件增量为 0/1，可重入语义基本锁定；但未断言 Checkpoint 不重复生成、等待状态不重复转换。

## ⑤ 覆盖缺口

1. **scope 对象规则 path_prefix 边界**无负例（唯一正向 :182），实现越权缺陷无回归闸。
2. **范围闸门危险分支**：`matchScopeRule` 的 `entry.scheme/port/path_prefix` 与裸主机组合、deny 与 pending 同时命中（`evaluateTarget` 顺序）未测；跨主机 allow+deny 重叠未测。
3. **重定向**只在 register 层用「另一个 URL 的第二次调用」模拟（scope:426-437），无实际 3xx/工具内部展开的逐跳复核用例。
4. **recovery 错误路径**：`createCheckpoint` 的项目/意图/Attempt 不存在（recovery.mjs:84-105 抛裸 Error→500）、`runRecovery` 对不存在 projectId 静默返回空 steps（recovery.mjs:576-579）、`ensureWaitingState` 对 stopped/paused 的行为，均无用例。
5. **Checkpoint 内容缺口未测**：无「阅读位置」（reading_bookmarks）与关键依据 state_version/evidence_version 断言；与实施计划 §6.1 的差距不会被测试发现。
6. **assessWaiting 口径**：orphaned running 意图、plan_run 在途、attempt_progress 汇报排除（recovery.mjs:316-327）无对应用例。
7. **diagnostics**：paused/stopped 分组、projection 非空时的滞后数值、多项目并存、诊断端点信任面（非回环）均未覆盖。
8. **llm-settings**：文件权限/明文落盘的安全边界、超时分支（头注释声称覆盖但 :125-167 只有 401 与 ECONNREFUSED）、非法 per_role、短 key 掩码、并发 PUT 均未覆盖。
9. **数据目录隔离的反向断言**：各文件都清理临时目录，但无「不触碰 ~/.sorne」的显式断言（依赖 helpers 约定）。

## ⑥ 与实现文件映射

| 测试文件 | 主要实现 | 关联实现 |
|---|---|---|
| recovery.test.mjs | `lib/store/recovery.mjs`（七步/检查点/等待）、`lib/store/metrics.mjs`（十类指标） | `lib/routes/metrics.routes.mjs`(#41/#42)、`lib/store/attempts.mjs`(sweep)、`lib/store/intents.mjs`(transitionIntent)、`lib/store/evidence.mjs`(findStorageAnomalies/closeAllStores)、`lib/store/layout.mjs`(evidenceDirs)、`index.js`(apply/reload) |
| scope.test.mjs | `lib/store/scope.mjs`（parseTarget/matchScopeRule/evaluateTarget/checkIntentTargets/checkActionTargets/persistAssetScopeVerdicts） | `lib/store/attempts.mjs`(派发与 tool-calls 网关闸门)、`lib/store/record-service.mjs`(scope-revisions/lifecycle)、`lib/routes/attempts.routes.mjs` |
| diagnostics.test.mjs | `lib/store/diagnostics.mjs` | `lib/routes/diagnostics.routes.mjs`(#49)、`lib/agents/runtime.mjs`(describe/reload) |
| llm-settings.test.mjs | `lib/store/llm-settings.mjs`（readLlmSettings/maskApiKey/落盘） | `lib/agents/model.mjs`(resolveModelProvider/missingProviderNotice)、`lib/agents/runtime.mjs`(startAgentRuntime/reload/runOnce/stop)、`lib/routes/llm.routes.mjs`(#46/#47 设置与 test)、`index.js` apply |
