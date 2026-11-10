# t03-intents-plan 测试精读报告

> 只读精读：test/intents.test.mjs、test/orchestrator.test.mjs；未运行测试、未改源码。引用格式 `文件:行号`。

## ① 文件与用例数

| 文件 | 行数 | test() 用例数 | 主题 |
|---|---|---|---|
| test/intents.test.mjs | 1343 | 30 | C1 计划接收（合同字段/幂等/范围/前提/依赖环/修订/九态历史/完成建议/#21 视图/鉴权/重启） |
| test/orchestrator.test.mjs | 1200 | 22 | E1 协调服务（工作面板/决定幂等/动作失败隔离/回执门控/单规划在途/场景 29/30/32/策略/角色面/引用校验） |

合计 52 用例；两文件均为真实 HTTP + 真实 SQLite + 真实重启，无存储 mock。

## ② 锁定的行为清单

**intents.test.mjs**
1. 迁移（:229-248）：schema_version≥3、intent_state_history 表与索引存在、migrate() 幂等。
2. 合同全字段（:253-342）：intents 19 个字段逐列断言、scope_revision=项目当前范围行编号（:307）、语义边恰为 targets/requires/derived_from（:321）、plan.received+relation.added+dependency.changed 三事件（:326-328）、首条历史 from=null→proposed 且 via=plan:r1（:333-336）、plan_runs→received（:340-341）。
3. 原子回滚（:344-384）：幽灵 goal 引用 → INVALID_REFERENCE，intents/plan_revisions/submissions 计数 0、outbox 不增、next_commit_seq 不变（:373-383）。
4. 信封自报拒绝（:386-397）；幂等接收 deepEqual 整回执+单事件（:401-421）；异内容 IDEMPOTENCY_KEY_REUSED 且回执带摘要、原内容仍可取原回执（:423-448）；同 run 同 revision 换壳拒绝（:450-468）。
5. 范围（:470-554）：无范围 SCOPE_UNRESOLVED→配范围后接收且意图记范围版本；不存在范围版本 INVALID_REFERENCE；denied 资产仅该意图 SCOPE_DENIED（partial，被拒意图不落库 :549-553）。
6. 前提（:556-700）：规划期前提失效→blocked+恢复条件+intent.blocked 事件+历史 action=suspend_on_reception（:558-611）；无关新增不废计划（accepted，:613-640）；reject 策略逐意图拒（:642-673）；前提引用不存在 422（:675-686）；对无版本字段对象声明期望 BAD_REQUEST（:688-700）。
7. 依赖死锁（:702-800）：同计划互前提、跨计划修订闭环（回滚后 state_version 与 prerequisite_refs 不变 :777-779）、自引用，三者均 DEPENDENCY_CYCLE。
8. 疑似重复（:802-831）：仅告警含"疑似重复/不强制合并"，两意图并存。
9. 修订（:833-920）：STALE_STATE；成功修订 state_version=2、requires 旧边 retracted+新边、dependency.changed(superseded) 恰 1 条（:886-896）；终态 resolved 不可修订 PRECONDITION_INVALID。
10. 九态（:922-971）：proposed→queued→running→resolved 完整历史四元组 deepEqual（:962-965）、resolved 无出边、intent.completed 事件。
11. 完成建议（:973-1188）：零/部分产物拒绝并列出 missing_deliverables 与 next_requirements（:998-1017）、伪产物 INVALID_REFERENCE（:1022-1052）、齐备→resolved 且项目 active、其余意图不动、仍可接收后续计划（:1054-1106）、无交付物→awaiting_review 且无 intent.completed、复核后 resolve（:1108-1140）、执行期前提失效（JSON expected_*）拒绝完成（:1142-1188）。
12. #21 视图（:1190-1243）：kind/status 过滤、非法值 BAD_REQUEST、limit=2 游标取全 5 不重不漏、include_history 每条≥1、priority_min。
13. 鉴权（:1245-1290）：#20 无会话/worker/orchestrator→403，跨项目读 403，缺 project_id 400，planner 会话自带项目 200。
14. 重启幂等（:1292-1343）：成功接收→关库关服→重签会话重发→deepEqual 原回执，库内 intent/plan.received/submission 各 1。

**orchestrator.test.mjs**
1. 空面板（:244-279）：12 个顶层键齐备、全中文注记、读取不产生事件/决定；跨项目/匿名/角色（:281-299）。
2. 真实链路面板（:302-341）：未处理汇报 delivered 与 pending 并存、意图 latest_attempt、key_changes 含 plan.received/resource_state.changed、supply 计数。
3. 重要发现以库为准（:343-362）：suspected 不提升。
4. 决定幂等（:365-426）：同 decision_id+同内容 idempotent、不重复建 Attempt；异内容/动作键复用均 IDEMPOTENCY_KEY_REUSED。
5. 动作失败隔离（:428-462）：暂停期 assign 执行期失败落 failed（错误码/next_requirements 原样保存），followup 仍 executed，tool_result 1/1。
6. 回执门控（:464-504）：无持久化决定 accepted→PRECONDITION_INVALID；handle_report→handled；#33 coordinated 补录。
7. needs_clarification/deferred（:506-547）：followup_ref 关联；deferred 缺 note→400。
8. 并行上限（:549-580）：set_execution_limits 后面板/供给同步、第二派发 RESOURCE_LIMIT。
9. 场景 29（:582-636）：两次真实重启，pending→handled 持久。
10. 场景 30（:638-732）：行级夹具构造 interrupted 态+真实 dispatchAttempt 效果，overview 触发核对→reconciled=true 不重放、pending 动作补齐、attempt 唯一、追问事件仅 1 条；补充用例全 pending 恰执行一次（:734-781）。
11. 场景 32（:783-849）：供给含 condition_gaps/重复尝试 note；四动作执行成功；读取概览不自动重派（:829-847）。
12. 追问/上下文（:851-908）：坏引用 422、事件 subject_ids 含 attempt/obs、观察内容不变。
13. 单规划在途（:910-959）：第二请求 422+detail.in_flight_plan_run_id；planner 提交后 run received、可再请求；陈旧 run 清扫（:961-1000）。
14. 策略（:1002-1037）、验证积压（:1039-1098）、base_report 线索（:1100-1122）、角色面（:1124-1150）、引用校验（:1152-1177）、waiting 不空转（:1179-1200）。

## ③ 测试替身/隔离/时钟手法

- 隔离：intents 用 helpers.withTestServer（mkdtemp+随机端口，helpers.mjs:19-21/86-93）包一层把 dataDir 写进进程级 env `__SORNE_TEST_DATA_DIR__`（intents.test.mjs:208-220），供 dbOf()/confirmedVulnerability 直连；orchestrator 自建 bootServer/withServer（:57-102），close() 内一并 closeStore（:82-85）。
- 替身：无 HTTP/存储 mock；LLM 不涉及。白盒库注入：intents 直插 goals（:262-266）、直接 UPDATE vulnerabilities=confirmed/state_version=3（:155-161，绕过 D1 状态机）、addSupportingEvidence 用真实 A1 逻辑触发 review=pending（:171-184）；orchestrator 直插 orchestration_decisions/actions 构造中断窗口（:212-240）、直改 plan_runs.created_at 制造陈旧 run（:976-981）、直改 worker_reports.base_report_id（:1110-1113）。
- 时钟：无 fake timer；陈旧用真实行时间回拨（orchestrator:976-981），其余依赖真实执行顺序。
- 重启：真实关库关服→同目录 bootServer→重签会话（intents:1298-1325；orchestrator:582-636、638-732、961-1000）。

## ④ 断言质量（过拟合/放宽/假绿）

- **强断言（真正的行为锁定）**：整回执 deepEqual 幂等（intents:413/447、1323）；整单回滚四连断言含"next_commit_seq 不变"（intents:373-383）；九态历史序列 deepEqual（intents:962-965）；requires 边收缩+superseded 计数（intents:886-896）；场景 30 的 reconciled/attempt 唯一/事件恰一次（orchestrator:694-722）；决定重试不重复建 Attempt（orchestrator:394-403）；概览读取零事件/零决定（orchestrator:266-277、1192-1198）。
- **过拟合实现文案/数组**：orchestrator:456-457 assert.match(/禁止新派发/) + deepEqual(next_requirements, ["项目恢复 active 后重新派发"])（整句实现文案）；intents:588 /review/、:667 /失效/、:822 "疑似重复/不强制合并"、:336 /^plan:r1$/（via 形态）；orchestrator:808 /不写死重试策略/。
- **被放宽**：角色面用例 orchestrator:1146-1148 用 `assert.notEqual(ok.status,403)` 放行（500 也算过），且无会话用例只看 status 不看 code（:1139-1140）；record_strategy 非法值只断 400 不断 BAD_REQUEST（:1035）；intents 多数错误断言已锁定 code，较扎实。
- **假绿/半断言**：orchestrator:331 lease_remaining_ms 仅 typeof number（值恒为 0 的缺陷照过，即主报告 P1-3）；orchestrator:726 `void eventsBefore`（采集后未用，疑似删掉的"不产生事件"断言）；orchestrator:90 keepDir 参数无使用点（死选项）。
- **夹具绕过与生产形状不一致**：intents:155-161 直改 vulnerabilities=confirmed 绕过 D1 验证状态机；orchestrator:212-240 直插决定/动作绕过 recordDecision 的记录期校验与幂等（用例注释已承认）；两文件均因"A1 第二个带范围项目撞 SR 主键"的**已过时注释**而用 withScope:false 规避（intents:1250-1253、orchestrator:113-117），当前 record-service 已用全局 SR 序列（record-service.mjs:1162），该规避使本文件不再对 0004 修复施加回归压力（multi-project.test 覆盖）。
- **P1-1（同分配幂等 vs 资源上限）为何未暴露**：本组两文件从不"设 max_active_attempts 后重发同一 assignment"——orchestrator:549-580 设上限后第二派发用**不同意图**、无 assignment_id（新 ASM），命中 RESOURCE_LIMIT 正是期望值；attempts.test.mjs:839-857 同样只测不同分配。故 dispatchAttempt 先判上限（attempts.mjs:604-617）后查幂等（:623-646）的顺序缺陷无任何用例触达。
- **P1-2（requires_state 双语法）为何未暴露**：intents 的前提用例只发生在**接收期**（JSON expected_* 由 C1 求值）与**完成复核期**（intents:1142-1188 由 reviewCompletion 的 JSON.parse 生效）；orchestrator 派发的是无前提意图。没有任何用例"计划接收成功后、派发前把前提状态改坏"，因此 C2 用文本谓词解析 JSON 期望并静默放行（attempts.mjs:219-228）不被发现；C2 文本形态自身由 attempts.test.mjs:880 覆盖，两组测试之间无交叉断言。

## ⑤ 覆盖缺口

- 跨 C1→C2 的端到端：计划声明 prerequisite（JSON）→接收→前提失效→派发/工具动作应被拒（P1-2）；同 assignment 在 max_active_attempts=1 下重试（P1-1）。
- 决定重试携带 source_message_id（P1-4）、非 EVT- 事件引用（P1-5，orchestrator:1169 只测 EVT-NOPE）；revise 缺 intent_id 的错误码（P2-6）；rejected plan_run 被迟到计划"复活"（P2-13，单规划用例只走正常 run）；>200 条决定回溯（P2-14）；陈旧 run 清扫无事件断言（P2-15，实现也确实不发）；重复完成建议的同值历史/空洞 commit_seq（P2-17）。
- 回执/板面：recordReportReceipt 的 resume_conditions 写入 content 未测（orchestrator:2199-2207）；pending_reports 超过 reportLimit 的 has_more 未测；reconcile 的 100 条决定上限未测。
- 意图：awaiting_review 无交付物的重复完成建议路径（intents:1662-1692）未测；defer/resume/obsolete/cancel 状态迁移未逐条覆盖；修订移除 target_asset_ids 后的边未收缩（P2-10）未测；include_history 跨多页/多历史行未测；#20 的 plan_run_id 指向已 rejected run 未测。
- 面板：execution.lease_remaining_ms 数值、suspended_attempts、unknown_tool_calls 明细、wake_signals.orphaned_running_intents 等字段只有结构断言（orchestrator:302-341）。

## ⑥ 与实现文件映射

- intents.test.mjs ↔ lib/store/intents.mjs（receivePlanRevision:597、transitionIntent:1468、reviewCompletion:1569、listIntents:1368）、lib/store/record-service.mjs（submit/资产/漏洞/关系）、0003 迁移、lib/routes/plans.routes.mjs（#20 角色/csv/int 校验）、lib/store/records-read.mjs（locateRecord）、lib/db.mjs（openDatabase/migrate）。
- orchestrator.test.mjs ↔ lib/store/orchestrator.mjs（recordDecision:1075、executeDecisionActions:1348、reconcilePendingDecisions:1387、buildSupplySnapshot:1464、orchestratorOverview:1591、createFollowup:1974、attachAttemptContext:2009、createPlanRequest:2039、recordReportReceipt:2101）、lib/store/attempts.mjs（dispatchAttempt/sweep）、lib/store/verification.mjs（registerVerificationPolicy/requestVerification）、lib/routes/orchestrator.routes.mjs、lib/store/messages.mjs（M2 事件/回执）。
