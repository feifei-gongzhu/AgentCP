# 05 agents 四角色与运行时 —— 代码精读报告

> 范围：lib/agents/*.mjs 全部 9 文件、3927 行，全部逐行读完（worker.mjs 分 6 段、runtime.mjs 分 2 段）；9 文件均通过 node --check。只读源码，未改任何源码，未运行 npm test / npm run ui。行号对应 2026-11-10 磁盘快照（无 git）。对照：docs/BLUEPRINT.md、docs/modules/AGENTS.md、AGENTS-realrun.md、docs/IMPLEMENTATION-PLAN.md、设计基线《基于分层记忆与持续探索的Agent系统设计方案》（只读）。

## 1. 范围与文件清单

| # | 文件 | 行数 | 一句话职责 |
|---|---|---|---|
| 1 | lib/agents/worker.mjs | 1567 | Worker：工具网关（register/start/complete/resolve）、真实 HTTP 探测、证据固定、发现即提交、完成建议+完成复核 |
| 2 | lib/agents/runtime.mjs | 524 | 运行时驱动：唤醒/水位、单飞、队列准入、租约清扫、runOnce 四角色编排、reload 热加载、启停 |
| 3 | lib/agents/planner.mjs | 402 | Planner：planner_view+变化流+recon+现有意图 → submit_plan → C1 receivePlanRevision |
| 4 | lib/agents/orchestrator.mjs | 376 | Orchestrator：工作面板+用户消息+验证策略 → submit_decision → E1 recordDecision+executeDecisionActions |
| 5 | lib/agents/model.mjs | 272 | LLM 客户端：OpenAI 兼容 /chat/completions、线格式归一化、提供方解析（store>env）、用量计数 |
| 6 | lib/agents/verifier.mjs | 243 | Verifier：独立会话审阅 Manifest/证据 → submit_result → D1 submitVerificationResult |
| 7 | lib/agents/recon.mjs | 225 | 只读侦察摘要：从本项目 captures/resources/blobs/assets 提炼指纹与已观测路径（带证据编号） |
| 8 | lib/agents/dsh-bridge.mjs | 164 | dsh 宿主只读工具桥接：注册 6 个 sorne_* 只读工具 |
| 9 | lib/agents/loop.mjs | 154 | 通用工具调用循环内核：tool_calls 回灌、步数/每步上限、错误回灌、trace、结果截断 |

## 2. 模块职责与关键导出（逐文件）

- loop.mjs：runAgentLoop({model,system,tools,opening,maxSteps=12,maxToolCallsPerStep=4,role})（loop.mjs:61）；返回 {stop_reason,steps,trace,final,finish_reason,error}，stop_reason∈{final,max_steps,provider_error}（:88-144）。内核不感知业务语义（:13）。工具抛错→{code,message} 作为 tool 结果回灌（:135-141）；未知工具→BAD_REQUEST（:125-129）。每步超限调用不执行但逐个回 RESOURCE_LIMIT tool 消息，避免悬空 id（:104-121）。结果截断 MAX_TOOL_RESULT_CHARS=3000，优先保留分页/控制字段（:17-50）。
- model.mjs：导出 normalizeAssistantMessage（:32）、toWireMessages（:85）、resolveModelProvider（:225）、missingProviderNotice（:264）、getLlmUsage（:27）。内部形状 tool_calls=[{id,name,arguments:对象}]，线格式补 type:"function"+function.arguments 字符串、tool 消息剥离 name（:66-128，依据真实 DeepSeek 422 历史）。HTTP：超时默认 120s、429 退避 20/40/60s（:167-172）、非 2xx 抛错（:180-182）、usage 记账（:183-198）。解析顺序 pctx.__modelProvider > <dataDir>/llm.json（per_role 覆盖）> env（:225-261）；无提供方返回 null，无规则兜底（:6-8）。历史工具参数超 1500 字符截断为合法 JSON（:76-83）。
- planner.mjs：PLANNER_ACTOR（:29）、runPlanner（:141）。供给面 plannerSupply（:81-139）：project_context、project_scope（allow/deny/pending+revision）、planner_view 经 compactView 裁剪（数组前 10、键前 30、字符串 1200，:44-64）、订阅边界、最近 10 事件（:83）、recon（:128）、现有 20 意图（:130）。工具 13 个：read_changes/read_record/submit_plan（:147-352）+ 分支摘要 4 + 主动阅读 8。submit_plan 幂等键 "PLAN-"+sha256(stableJson{project_id,plan_run_id,plan_revision,rationale,intents}).slice(0,32)（:217-225），input_boundary=snapshot_commit_seq（:232）。plan_request 正文按 plan_run_id 反查 orchestration_actions/decisions 回填（:354-381）。
- orchestrator.mjs：ORCHESTRATOR_ACTOR（:33）、runOrchestrator（:75）。输入面 orchestratorOverview（:80）、最近 10 事件（:81）、待处理用户消息≤4 并置 processing（:85-96）、recon（:329-350）、验证策略（:321-326）。工具 19 个：read_changes/read_record/read_blob/submit_decision（:98-214）、调度 6（:215-265）、主动阅读 8（:266-318）。submit_decision=recordDecision+executeDecisionActions（:202-213），source_message_id 触发消息闭环。read_blob 支持 sha256 或 B- 编号，文本≤4KB 内联、二进制只给哈希/字节数（:130-164）。
- worker.mjs：WORKER_ACTOR_PREFIX（:48）、MAX_EVIDENCE_BYTES=64MiB（:51）、MAX_CONTEXT_BODY_CHARS=600（:53）、runWorker（:465）。两条路径：runtime 传 attemptId+fencingToken 复用已派发 Attempt、actor 取 attempts.worker_id（:474-487）；否则 dispatchAttempt 条件领取（:491-500）。执行开始程序把意图 proposed→queued→running（ensureIntentRunning，:272-295,507-510）。工具 18 个（:518-1449）：read_record/register_tool_call/http_request/store_evidence/complete_tool_call/resolve_tool_call/submit_findings/propose_endpoint_template/report_progress/save_extraction_batch/extract_from_evidence/save_check_record+主动阅读 8（含 bookmark 跨 Attempt 继承 :1428-1448）。执行体 executeHttpProbe（:177-265）：redirect:manual、8s 超时、arrayBuffer 保留完整字节、全量响应头（getSetCookie 逐个保留 :153-170）、按声明 charset 解码并标注 mismatch（:115-150）。证据：buildExchangeRecord（:302-335，schema sorne.exchange_record/v1）、store_evidence（:662-888，raw_body/exchange_record 二选一、同表示幂等、超限显式截断）、图谱自动登记+模板提案（:805-864）。完成闭环：report_progress(completion)→Attempt 落定→程序 reviewCompletion 复核意图，被拒且 AI 未带证明时用最近提交回执兜底一次（deriveDeliverableProofs :426-458；:1184-1209）。收口：残留 running 工具调用标 unknown（:1465-1486）；final/max_steps/provider_error 时程序写 blocked 进展并 attemptLifecycle(cancel) 释放租约（:1491-1552，max_steps 另存检查点）。
- verifier.mjs：VERIFIER_ACTOR（:25）、runVerifier（:49）。输入面 verifierSupply（:37-47，先 pending/in_progress 再回退全量）+ getRecord(subject)+getProjectContext（:59-60）。工具 10 个：read_record/read_blob/submit_result（:62-138）、save_check_record、主动阅读 8。submit_result 把任务登记的三版本原样回传（policy_version/reviewed_manifest_id/reviewed_evidence_revision/claim_revision/expected_*，:117-136），由 D1 做 §12.2 校验；模型只给 outcome/checks/refs/limitations。
- recon.mjs：导出 buildReconSummary（:44）。纯只读：assets≤40（:75-92）、captures≤25 正文（:95-138）、exchange_record 头指纹≤80（:141-181）、resources 分组≤40（:184-200）、仅在本项目证据命中产品且存在匹配路径样本时给候选入口面（:203-219）；每条线索带 source_refs（:49-53），整体 evidence 去重（:220），异常记 summary.error 不阻断（:221-223）。
- dsh-bridge.mjs：registerDshTools(hostCtx,pctx)（:24）；hostCtx.get("tools") 不可用时返回空注册（:25-33）；注册 sorne_projects/overview/planner_view/record/change_log/verification_jobs 6 个只读工具（:35-139）；逐个注册失败不阻断（:143-151）；dispose 注销（:152-163）。
- runtime.mjs：startAgentRuntime（:146）→{started,reason,describe,reload,projects,runOnce,stop}（:506-523）。内部 projectWorkload（:35-82）、hasWork（:84-101）、admitProposedIntents（:113-139）、resumeWaitingProject（:217-253）、runOnce（:256-477）、tick（:479-496）、reload（:191-209）。状态：busy（项目×角色单飞）、lastHigh、outboxConsumed、drivenAttempts/drivenJobs（同一 Attempt/Job 每进程只驱动一轮，:156-163）、lastCoordinatorSignal/lastOrchestratorAt（协调者去重+5 分钟冷却）。

## 3. 数据模型与持久化结构

本模块不含任何 DDL/迁移（lib/agents 内无 CREATE/ALTER TABLE）；全部表由 lib/db/migrations/0001-core-schema.mjs 定义，agents 层只读写。写路径一律落入 store.runSerial（lib/db.mjs:63-72，BEGIN IMMEDIATE/COMMIT/ROLLBACK 串行短事务）。

| 表/约束 | 访问方与证据 |
|---|---|
| projects | runtime 读 status/state_version/next_commit_seq（runtime.mjs:38,213,220-227）；resumeWaitingProject 原始 UPDATE status+state_version+1 |
| outbox | runtime 读 MAX(commit_seq) 作水位（:40-42）；resume 时原始 INSERT（手工 EVT-项目-seq、event_index=1、payload.kind=project_lifecycle，:229-250）；增量回执经 consumeOutbox（:462-467） |
| intents | runtime 统计 runnable/孤儿（:49-68）、准入 transitionIntent(activate)（:113-139）；worker ensureIntentRunning（worker.mjs:272-295）；planner 经 C1 receivePlanRevision |
| attempts | runtime 取 leased/running+fencing_token（:376-380）；worker 校验 attempt↔intent 归属（worker.mjs:479-486） |
| tool_calls | worker 前置未落定检查（worker.mjs:599-608）、收口查 running（:1467-1483）、网关登记/落定/unknown |
| blobs/captures | worker 固定证据（blobs UNIQUE(project_id,sha256)、captures UNIQUE(project_id,tool_call_id) 幂等，lib/store/evidence.mjs:596-609）；recon 读 representation='exchange_record'（recon.mjs:141-149） |
| resources/assets | recon 聚合观测路径/资产（:75-92,184-200）；worker 经 A1 register_service_asset/register_http_resource（worker.mjs:110-127） |
| submissions | worker 兜底证明按 (project_id,submitter_id) 取最近一笔（commit_seq DESC,rowid DESC；注释记录过按不存在的 created_seq 排序的 SQL 错误，worker.mjs:428-433） |
| plan_runs/plan_revisions | runtime 取 pending/in_flight 触发规划（:77-79,341-350）；C1 接收后置 received（lib/store/intents.mjs:1300-1302） |
| orchestration_decisions/actions | orchestrator 唯一落库通道（:202-213）；planner 反查 request_planning 正文（planner.mjs:360-377） |
| messages/message_links | orchestrator 读待处理、置 processing、附件/引用以编号注入（:36-59,85-96） |
| verification_jobs/results/manifests | runtime 取待验证 job（:72-74,421-425）；verifier 读 jobView 的 expected.*/manifest.* 并提交（verifier.mjs:38-46,117-136） |
| snapshots / checkpoints | planner 生成 planner_view（:82）、桥接同法（dsh-bridge.mjs:73-77）；worker max_steps/阶段边界存检查点（worker.mjs:1500-1506、orchestrator.mjs:255-259） |

## 4. 主要调用链与数据流

### 4.1 装配与启停（跨 index.js → runtime / dsh-bridge）
index.js:apply() → startAgentRuntime(pctx,{hostCtx:ctx,logger})（index.js:57）→ resolveModelProvider（runtime.mjs:154）；有提供方 → startTimer()（:498-500），无 → 只记"未启动+原因"（:501-503）。→ registerDshTools(ctx,pctx)（index.js:65）注册 6 个只读工具。→ ctx.effect 清理：注销 /sorne 路由、agents.stop()、dshBridge.dispose()（index.js:67-78）。运行中配置变化：PUT /sorne/settings/llm → pctx.agents.reload()（lib/routes/llm.routes.mjs:33-35）、explore-start → reload()（lib/store/explore.mjs:36-37）。

### 4.2 单轮驱动 runtime.runOnce（8 阶段）
1. 租约清扫 sweepExecutionState（runtime.mjs:263-267，失败仅告警）。
2. 工作面快照 projectWorkload（:268；原始 SQL 计数 9 项：high_watermark/runnable_intents/live_attempts/orphaned_running_intents/pending_reports/pending_jobs/pending_user_messages/plan_in_flight）。
3. 唤醒判定 hasWork（:271,84-101）：active 看水位推进或任一待处理计数；waiting_for_change 只看用户消息；其它状态不派发。无工作 → {skipped:true,reason:"waiting_for_change"}，每项目只记一次日志（:272-277）。
4. 等待项目唤醒：waiting_for_change+用户消息 → resumeWaitingProject（:278-281）：单事务 UPDATE projects(active,state_version+1)+追加 resource_state.changed（cause=user_message）（:217-253）。
5. 水位与 Outbox 接手：先 lastHigh=load.high_watermark（:283）；首次接手 bootstrapOutbox 把存量事件置 skipped（:285-293）。
6. 队列准入 admitProposedIntents（:295-305）：proposed 且无任何 Attempt 的意图≤8 条 activate，程序只记队列账、不选方向（:103-112）。
7. 角色编排（顺序固定）：
   - Orchestrator（:307-371）：resolveModelProvider(role:"orchestrator")；信号指纹 [high,pending_reports,pending_user_messages,pending_jobs,runnable_intents] + 硬信号（含孤儿/plan_in_flight）判 needsCoordinator；单飞键 projectId:orchestrator；运行后若存在 pending/in_flight plan_run 且 planner 未忙 → Planner（:341-364，传 planRunId）。
   - Worker（:373-418）：取 leased/running Attempt ≤4；drivenAttempts 去重；并行 runWorker({attemptId,fencingToken})——未传 maxSteps（见 P1-1）。
   - Verifier（:420-455）：取 pending/in_progress job ≤4；drivenJobs 去重；串行 runVerifier。
8. 消费回执 + 收尾水位（:457-476）：把本轮输入边界内增量事件写 applied（本轮自产事件留到下一轮），再用 post.high 作为新 lastHigh（避免自产事件自唤醒）。
tick()（:479-496）枚举全部项目顺序 runOnce，单项目异常不终止其余项目。

### 4.3 角色内部链路（跨 agents → store）
- Planner：plannerSupply（B1 generateSnapshot + B2 readChangeLog + C1 listIntents + 项目上下文/范围 + recon）→ runAgentLoop（planner.mjs:400）→ read_record/read_changes/submit_plan → C1 receivePlanRevision → plan_runs.received + 事件 plan.received。
- Orchestrator：orchestratorOverview（E1）+ 消息置 processing → 循环 → submit_decision → recordDecision（决定+动作落库、orchestration.decision_recorded）→ executeDecisionActions（assign_execution→C2 条件领取；request_verification→D1；request_planning→plan_runs 等）→ 决定持久化后消息置 handled+自动回复（lib/store/messages.mjs）。
- Worker：generateWorkerContext（B1，12k 字符预算，worker.mjs:513）→ 循环 → register_tool_call/http_request → 工具网关（lib/store/attempts.mjs:1189+：租约/fencing/范围/前提/并发/预算/unknown 校验）→ 真实 HTTP →（本应）自动固定证据 → store_evidence（A2 storeBlob+registerCapture）→ complete_tool_call → submit_findings → A1 submit（观察/假设/漏洞/关系/资产同事务）→ report_progress → C2 落定 Attempt → C1 reviewCompletion（意图 resolved/awaiting_review）。
- Verifier：verifierSupply（D1 job+记录+项目上下文）→ 循环 → read_record/read_blob（A2 readBlobBytes）→ submit_result → D1 submitVerificationResult（§12.2 事务：版本/Manifest/策略/独立性→应用状态转换+同事务 Outbox）。

## 5. 关键不变量、并发/事务/幂等/错误处理

| 编号 | 不变量 | 实现位置 | 结论 |
|---|---|---|---|
| I1 | 每个 tool_call id 必有且仅有一条 tool 应答（不得截断留悬空） | loop.mjs:102-121 | 成立（含每步上限丢弃路径） |
| I2 | 工具错误/未知工具不终止循环，以错误信封回灌 | loop.mjs:125-141 | 成立 |
| I3 | 每步上限与总步数上限是程序资源边界 | loop.mjs:88,104 | 每步成立；总步数在 Worker 生产路径为 Infinity（P1-1） |
| I4 | 提交幂等键由内容确定性派生（重试返原回执，不同内容由 A1/C1 拒绝） | worker.mjs:96-99,1095-1103；planner.mjs:217-225 | 成立（stableJson 把 undefined 归 null，语义级轻微碰撞可接受） |
| I5 | 同一 tool_call 只固定一种表示；同表示重复调用幂等 | worker.mjs:686-701,882-885 + captures UNIQUE(project_id,tool_call_id)（evidence.mjs:596-609） | 成立（内存 probeCache 负责同 Run，DB 唯一键负责跨进程） |
| I6 | 证据链顺序 staging→固定→登记→complete，complete 前必须有证据 | worker.mjs:736-802,902-911 | 部分成立：自动固定失效时不强制（P0-1），靠模型自觉先 store_evidence |
| I7 | 租约/fencing：工具调用、进展、生命周期都带 fencing_token，网关逐次校验 | runtime.mjs:376-380,400-403；worker.mjs:541-557,902-911,1472-1479 | 成立（校验在 attempts.mjs assertLiveLease） |
| I8 | 范围/前提"拒绝优先"、动作前逐跳校验（agents 层不自行判范围） | 网关 attempts.mjs:1211-1220 | 成立 |
| I9 | unknown 未 resolve 前不得同身份重试、不得 completion | attempts.mjs:1223-1235 + worker.mjs:1465-1486 | 部分成立："同身份"仅 tool_name+args_digest，register_tool_call 的 purpose 可变即可绕过（P2-6） |
| I10 | 完成只是建议：程序复核后意图才 resolved；一句完成不 resolved | worker.mjs:1184-1209 → C1 reviewCompletion | 成立 |
| I11 | 同项目同角色单飞；同 Attempt/Job 每进程只驱动一次 | runtime.mjs:326-330,390-394,431-435 | 成立（仅进程内；蓝图为单进程插件） |
| I12 | 无新信息不空转；本轮自产事件不作下轮唤醒源 | runtime.mjs:84-101,283,457-476 | 成立（但 P1-2 反例：该跑却不跑） |
| I13 | 不以程序固定流程替代 AI；无提供方显式等待 | model.mjs:225-261；runtime.mjs:257-260 | 成立（唯一程序化决策是"队列准入记账"，注释明确不选方向 runtime.mjs:103-112） |
| I14 | 身份由程序签发会话决定，模型自报忽略 | 各角色 issueSession；D1 用 session.actor 判独立性（lib/store/verification.mjs:910） | 成立（verifierIdentity 仅为结果元数据） |
| I15 | 角色会话有 TTL、不无界累积 | orchestrator.mjs:79,planner.mjs:144,worker.mjs:489,verifier.mjs:53 | 不成立（P1-3） |
| I16 | 模型上下文成本受控（结果截断/视图裁剪/历史参数截断/body 摘要） | loop.mjs:17-50、model.mjs:76-83、planner.mjs:44-64、worker.mjs:53,513 | 成立；供给侧仍有未预算化项（P2-8） |

错误处理约定：程序拒绝一律作为工具结果回灌并保留 error.code 与 next_requirements（loop.mjs:136-138；worker.mjs:111-118）；reviewCompletion 拒绝被转成可回灌对象并附"补齐后可重新提交证明"（worker.mjs:408-419）。运行时对角色异常一律"记录+等下一轮"，不崩溃驱动（runtime.mjs:174,330-370,405-414,442-454,490-494）。

## 6. 与文档/设计基线的对应与偏差

| 文档声明 | 代码事实 | 判断 |
|---|---|---|
| BLUEPRINT §3 阶段 E：Planner/Orchestrator 独立 LLM+工具、E1 九工具端点化 | 四角色独立 SYSTEM/会话/工具面；submit_decision 映射 E1（orchestrator.mjs:202-213） | 一致 |
| BLUEPRINT §8.1/§8.3：会话由程序签发、发现者不得自证、仅 verifier 会话交结果 | 角色均 issueSession；D1 用 session.actor 判 TRUST_DENIED（verification.mjs:910-919）；verifier 无变更类工具 | 一致 |
| BLUEPRINT §13.3：dsh 侧仅工具桥接、无模型 API | dsh-bridge 只注册只读工具；模型一律走 HTTP 提供方（model.mjs:9-16） | 一致（偏差已在 AGENTS.md §5-2 登记） |
| 蓝图 §2.6-8 热加载：未配置→启动、清配置→停 tick 且不重放水位 | runtime.mjs:191-209（单飞 reload、保留 lastHigh） | 一致；llm-settings.test.mjs:220-256 覆盖 |
| 蓝图 §2.6-2：用户消息作条件变化唤醒、delivered≠handled | runtime.mjs:84-101,217-253；orchestrator.mjs:85-96 + submit_decision(source_message_id) | 一致（但 P1-2 失败路径会卡住） |
| AGENTS.md："Worker 工具面 = read_record/register_tool_call/store_evidence/complete_tool_call/submit_findings/report_progress" | 实际 18 个工具（http_request、resolve_tool_call、主动阅读 8、extraction、coverage、模板、书签） | 文档过期（P2-9） |
| AGENTS.md："test/agents.test.mjs（9 用例）" | 实际 10 个 test（agents.test.mjs:129,175,208,312,402,449,502,524,604,649） | 文档过期 |
| AGENTS.md §5-3："Worker 真实执行体仅 http_probe（GET）" | 已有 http_request（POST/PUT/PATCH/DELETE/HEAD/OPTIONS，worker.mjs:581-660） | 文档过期 |
| AGENTS-realrun.md："MAX_CONTEXT_BODY_CHARS=2000 字符" | 代码为 600（worker.mjs:53） | 文档/常量不一致 |
| AGENTS-realrun.md 行号锚（executeHttpProbe L134-201、report_progress L700-780） | 现为 L177-265、L1144-1211 | 行号过期（该文件自述"保留第 2 轮内容"） |
| IMPLEMENTATION-PLAN.md:106："Worker HTTP probe 证据固定 ✅ autoFixEvidence（§四）工作正常，3 captures + 3 blobs" | 当前 autoFixEvidence 在模块作用域不存在（嵌套于 reviewIntentCompletion 体内），调用必抛 ReferenceError 并被吞（worker.mjs:338,346,562-571,644-652） | 与实测结论矛盾（P0-1；worker.mjs mtime 18:25 晚于文档 17:25，指向后续改动引入的回归） |
| 设计基线 §六："Orchestrator 拥有运行安排最终决定权；Planner 与 Orchestrator 不构成每次工作都必须经过的双重审批链" | runtime 固定顺序 Orchestrator→(Planner)→Worker→Verifier（runtime.mjs:255,307-455），带 5 分钟冷却与信号去重；Planner 仅在 plan_runs 在途时运行 | 基本一致（不是双重审批，Planner 无在途不跑）；但编排序列是程序固定而非 Orchestrator 自由调度，建议显式登记为本模块偏差 |
| 设计基线 §六："程序负责队列、并发限制、消息投递和执行状态维护" | admitProposedIntents 队列记账、网关并发/预算、MAX_WORKERS_PER_TICK=4、verifier≤4、messages 状态机 | 一致 |
| 设计基线 §八"工具产物批量持久化，模型只收短回执" | save_extraction_batch / extract_from_evidence 返回批次回执（worker.mjs:1247-1341） | 一致 |
| 设计基线 §十"覆盖记录围绕具体工作保存、可批量提交" | save_check_record（worker.mjs:1344-1380、verifier.mjs:140-176） | 一致 |
| 设计基线 §十一"阶段交接/恢复入口" | worker max_steps 检查点、orchestrator save_checkpoint/recover_context（orchestrator.mjs:255-265） | 一致 |
| 规范 §16.3 成本信号（预算/等待/积压） | 只有 5 分钟冷却+信号指纹；无 token 预算、无单轮调用上限、无 max_tokens 传递（loop.mjs:92 只传 system/messages/tools/tag；model.mjs:143 的 max_tokens 无调用方） | 成本控制不完整（P2-3） |

## 7. 问题清单

### P0（阻断）

**P0-1 [bug] 证据自动固定链路整体不可达，失败被 try/catch 静默吞掉；提示词仍告诉模型"已自动固定"**
- 位置：worker.mjs:338（reviewIntentCompletion 函数体开始）→ :340-346 在**其函数体内**声明 async function autoFixEvidence → :407 关闭 autoFix 体 → :408-419 是 reviewIntentCompletion 真正的主体 → :419 关闭 reviewIntentCompletion。模块作用域因此没有 autoFixEvidence 绑定；两个调用点 :562、:644 都在 try{} 内（catch 见 :568-571、:650-652）。
- 证据：逐行花括号深度扫描显示 autoFixEvidence 声明深度=1，同级 reviewIntentCompletion/deriveDeliverableProofs=0；grep -rn autoFixEvidence lib/ 仅返回 :346,562,644（无模块级定义）；node --check 通过（嵌套函数是合法语法，门禁不报）；IMPLEMENTATION-PLAN.md:106 的真实运行结论与当前码矛盾且文档早于 worker.mjs mtime。
- 现象链：① 每次 register_tool_call/http_request 调 autoFixEvidence 抛 ReferenceError → 被 catch{} 静默降级为"无证据" probeCache 条目，回执无 evidence 字段；② 该 tool_call 停留 planned/running → 下一次 http_request 被前置检查拒绝（:599-608）；③ 循环结束程序把残留 running 标 unknown（:1465-1486），unknown 未 resolve 阻塞 completion（attempts.mjs:1223-1235）；④ SYSTEM 与开场白仍写"证据已自动固定（blob_id/capture_id 持久引用）——无需再调 store_evidence + complete_tool_call"（:59-60,576,657,1457），模型按提示跳过落定 → 与规范 §13、§2 约束 1 冲突。
- 建议：把 autoFixEvidence 提为与 reviewIntentCompletion 同级的模块级函数；catch 里把失败写入 trace/回执（不静默）；补断言"register_tool_call 回执必含 evidence 或显式 error"。

### P1（重要）

**P1-1 [风险] Worker 循环在生产运行时没有步数上限**
- runtime.mjs:398-404 调 runWorker 未传 maxSteps → worker.mjs:467 默认 maxSteps=Infinity → loop.mjs:88 while(step<maxSteps) 无界。runtime.mjs:156-158 注释仍按"每 tick 一轮 maxSteps=14"解释成本护栏；IMPLEMENTATION-PLAN.md:95,115 的"max_steps=6"只出现在 test/agents-realrun.test.mjs:298,354,404 等显式传参用例。grep 无任何运行时/环境变量入口（runOrchestrator/runPlanner/runVerifier 默认 10，只有 Worker 无限）。
- 影响：模型持续返回 tool_calls 或反复触发可回灌错误时无限消耗 token，Attempt 永不落定，只能等租约到期被 sweep。建议：runtime 传 per-role 预算（env 或 resource_policy 或配置），并写入 runOnce summary 便于诊断。

**P1-2 [bug] 协调者信号指纹在调用前推进：一次 provider_error / 未提交决定的 final 会让该项目长期不再被唤醒**
- runtime.mjs:312-328 在 await runOrchestrator 之前就 lastCoordinatorSignal.set；:332-337 只在 provider_error/final 时记日志，不回退指纹。signalChanged 是 needsCoordinator 的与条件（:326）；若同一项目无新事件且待处理计数恒定（如 pending_reports=1 或 messages.status='processing' 不变），指纹不变 → Orchestrator 不再运行，worker_reports.handling_status / messages 永久滞留，直到出现新事件或用户再发消息。
- 影响：单次模型/网络抖动即造成"该跑却不跑"，与 §16.4"等待条件变化不空转"不同。建议：仅当 stop_reason==="final" 且 trace 中有成功 submit_decision 时才推进指纹；provider_error 时删除指纹并设短退避，避免热循环。

**P1-3 [风险/不一致] 角色会话 TTL 名不副实：每轮新建且从不解析，注册表无界增长**
- 每轮新建 issueSession：orchestrator.mjs:79、planner.mjs:144、worker.mjs:489（另 :493 runtime 会话）、verifier.mjs:53；清理只发生在 lib/store/sessions.mjs:71-76（resolveSession）与 :102-110（activeSessionCount），而后者只在 /health（lib/routes/health.routes.mjs:41）与 diagnostics（lib/store/diagnostics.mjs:61）被调用。角色会话直接以对象传 store，从不经 HTTP 解析 → TTL 永不触发。
- 影响：5s tick 下每项目每轮 2-4 个会话对象，长时间运行内存单调增长；orchestrator.mjs:77-78,143 所称"TTL 避免角色会话无界累积"在实现上不成立。建议：角色复用固定 per-(project,role) 会话，或 runtime 每 N 轮调用 activeSessionCount() 清扫。

### P2（次要）

- P2-1 [死代码] model.mjs:207 的"429 限流耗尽"throw 不可达：attempt==MAX_RETRIES 时 :167 的 attempt<MAX_RETRIES 为假，落到 :180-182 抛 HTTP 429。
- P2-2 [风险] 429 之外无重试：model.mjs:160-163 超时、:180-182 5xx 均立即失败；429 退避 20/40/60s 在 tick 内同步阻塞，叠加 120s 超时，无整体 deadline/熔断。
- P2-3 [不一致/风险] 成本护栏不完整：loop.mjs:92 从不传 maxTokens/temperature（model.mjs:135-145 支持但无调用方）；llmUsageTotals.calls 只在响应含 usage 时自增（:183-186），无 usage 的响应不计次；全仓无 token 预算。
- P2-4 [死代码] orchestrator.mjs:36-47 loadPendingUserMessages 定义后无调用（grep 仅定义处），runOrchestrator 在 :85-96 用 store.db.prepare 重写一遍且未走 runSerial（与 helper 相反）。
- P2-5 [死代码] runtime.mjs:504 void hostCtx：startAgentRuntime 的 hostCtx 完全未使用（index.js:57 传入、:65 另行注册桥接）。
- P2-6 [风险] unknown"同身份"判据可绕过：网关按 tool_name+args_digest 判（attempts.mjs:1223-1235），register_tool_call 的 args 为 {url,purpose}（worker.mjs:541-548），purpose 由模型自由填写 → 换 purpose 即 digest 变化，:1229 的 unknown 阻止失效，可在未核查时重试同一 GET（违反 §10.2 场景 18 意图）。
- P2-7 [不一致] 提示声称的前置检查只对 http_request 实现：worker.mjs:60 与 :604 文案说"程序会拒绝在上一个调用未落定时开新探测"，实际检查只在 http_request.execute（:599-608），register_tool_call.execute（:539-548）没有。
- P2-8 [风险] 供给面未预算化：planner.mjs:128 把 buildReconSummary 全量放入 supply，:385 JSON.stringify(supply) 注入（compactView 只作用于 planner_view.content，:113）；orchestrator.mjs:352-372 把 overview/recon/策略/消息直接 JSON 化，与 worker.mjs:513 的 12k 预算不一致。
- P2-9 [不一致] 模块文档滞后：AGENTS.md 工具面缺 http_request/resolve_tool_call/extraction/coverage/主动阅读 8/分支摘要 4/调度 6；"9 用例"实为 10；"仅 http_probe（GET）"已被取代；未记录 recon.mjs、ensureIntentRunning、reviewCompletion 闭环、drivenAttempts、MAX_WORKERS_PER_TICK、admitProposedIntents。AGENTS-realrun.md 常量/行号过期。IMPLEMENTATION-PLAN.md:106 autoFix 结论失真。
- P2-10 [风险] tick 无单飞：runtime.mjs:173-175 用 setInterval 直接触发 async tick（:479-496），单轮含多次 LLM 调用远超 5s，重叠轮次并存；busy 只保护同项目同角色，两个 tick 仍各自读 projectWorkload、写 state.lastHigh（:283,475 可能互相回退水位）、重复队列准入与 outbox 消费。建议加 state.ticking 门闩或改自调度 setTimeout 链。
- P2-11 [风险] recon.mjs 在事件循环上做同步 I/O：:110（≤25 个 capture body）与 :152（≤80 个 exchange_record）用 readFileSync，每次 Planner/Orchestrator 运行都执行，单文件上限 64MiB，可阻塞进程数秒到数十秒。建议改异步读取+并发/字节预算。
- P2-12 [不一致] recon.mjs:16-29 内嵌通达 OA 7 条候选入口（产品特化知识进通用模块）；虽满足"命中产品且本项目有匹配路径样本才附带"（:203-219），但与其文件头"严禁写死特定项目 URL/主机"（:6-9）存在张力。建议外置为配置/数据文件。
- P2-13 [不一致] runtime.mjs:271-277 对暂停/停止项目也返回 reason="waiting_for_change"（hasWork 在 :86 已排除非 active/waiting），排障会被误导。建议按 load.status 给具体原因。
- P2-14 [风险] verifier.mjs:38-46 任务发现冗余且可能拿已失效 job：先查 pending/in_progress、取不到再查全量并继续执行（:44），随后 submit_result 会被 D1 以 superseded/PRECONDITION_INVALID 拒绝（verification.mjs:903-907），浪费一轮 LLM；两次 listVerificationJobs 为两次事务扫描。
- P2-15 [风险] worker.mjs:452-457 deriveDeliverableProofs 把"最近一次提交的全部编号"当作每个交付物的证明（record_ids 共用），只校验编号存在性，证明力弱于 AI 显式 deliverables_proof（已标注 proof_source，属兜底非伪造）。
- P2-16 [测试缺口] 关键行为无断言：自动证据固定、每步上限丢弃路径、recon 输出、drivenAttempts 成本护栏、孤儿意图唤醒、unknown 重试门、429 重试（详见 §8）。

## 8. 测试覆盖映射

| 测试文件 | 覆盖到本模块的行为（行号） | 说明 |
|---|---|---|
| test/agents.test.mjs（10 用例/839 行） | ①Planner submit_plan 落库+幽灵资产拒绝回灌（:129-171）；②Orchestrator submit_decision→C2 条件领取建租约（:175-204）；③Worker 网关+范围校验+探测→证据→观察→完成复核（:208-308）；④Verifier 独立 supported→confirmed 与 TRUST_DENIED（:312-398）；⑤循环内核 maxSteps/未知工具/错误回灌（:402-445）；⑥HTTP 提供方真实传输与 500 映射、无提供方等待（:449-520)；⑦runOnce 两轮+收尾等待（:524-600）；⑧dsh 桥接注册/执行/注销（:604-639）；⑨env 提供方端到端 runOnce（:649-839） | 四角色主链路均有真实事务断言 |
| test/agents-realrun.test.mjs（481 行） | 线格式严格校验、GBK/二进制证据完整性、raw_body 逐字节、确定性幂等、完成闭环 resolved/awaiting_review、每步上限 RESOURCE_LIMIT（:199）、真实模型/靶标 | 覆盖 I1/I4/I5/I6/I10 |
| test/llm-settings.test.mjs:220-256 | reload 热启动/停止、started/runOnce 行为 | 覆盖热加载契约 |
| test/messages.test.mjs（296 行） | 用户消息闭环（received→决策→handled→自动回复）、附件 read_blob 真读字节、唤醒（active 与 waiting_for_change） | 覆盖 §2.6-2；但见缺口 T3 |
| test/stage1-project-context.test.mjs:450-458 | project_context/scope 注入 worker | 供给面一致性 |
| test/explore-start.test.mjs:78-129 | explore-start 调 reload、waiting_for_change→active | 入口接线 |
| test/diagnostics.test.mjs、test/ui-* | agents.describe()/getLlmUsage 呈现 | 仅消费面 |

无测试（或假绿）的行为：
- T1 自动证据固定 autoFixEvidence：无任何用例断言（grep -rn 自动固定 test/ 为空）。现有 Worker 用例都**显式**调 store_evidence（agents.test.mjs:217,551；agents-realrun:279,344,386,418），因此 P0-1 的降级完全绕过测试；一旦修复 autoFix，store_evidence 会命中内存幂等分支并返回另一种回执形状（{blob_id,capture_id,...} 而非 {blob,capture,...}，对比 worker.mjs:400-406 与 :865-881），现有断言 byName("store_evidence").result.capture.capture_id（agents.test.mjs:225,554）将失效——修复时必须同步改测试。
- T2 循环每步上限的丢弃路径（loop.mjs:104-121）：agents-realrun.test.mjs:199 的 RESOURCE_LIMIT 来自网关并发/预算（attempts.mjs:1242/1258），不是内核截断；maxToolCallsPerStep 无直接断言。
- T3 messages.test.mjs:215-259 唤醒用例自掩盖：首个 orchestrator 脚本闭包在 :225 引用 const wakeMsgId（:245 才初始化），首次 runOnce（:234）求值必抛 TDZ ReferenceError → 循环以 provider_error 收束；但用例只断言 idle.skipped（:236）、roles 含 orchestrator（:248）、项目 status（:252）、resume 事件（:257），这些在 provider_error 下同样成立 → 该用例并未真正验证"用户消息→决定→handled"。建议去掉该引用或断言消息最终为 handled。
- T4 recon.mjs：无单测；Planner/Orchestrator 侧以 .catch(()=>null) 静默降级（planner.mjs:128、orchestrator.mjs:329），失败与正确性均不可见。
- T5 runtime.mjs 的 drivenAttempts/drivenJobs 成本护栏、orphaned_running_intents 唤醒、协调者指纹去重、admitProposedIntents 的 8 条上限：无测试（grep -rn "drivenAttempts|孤儿" test/ 为空）。
- T6 model.mjs 429 重试/sleep：无测试（会真实 sleep 20s+）；toWireMessages 的历史参数截断（:76-83）无断言。
- T7 loop.mjs 的 toolResultMessage 截断：导出了 __test__（:154）但测试未引用（grep "__test__" test/agents.test.mjs 为空）。
- T8 dsh-bridge.mjs 注册失败分支（:143-151）与 dispose 内失败（:156-161）无覆盖。

## 9. 不确定点与需 Lead 交叉确认的问题

1. P0-1 是回归还是从未生效：静态证据指向"函数被误并入 reviewIntentCompletion 体内"；IMPLEMENTATION-PLAN.md:106 的 3 captures 记录要么发生在合并前、要么来自人工 store_evidence。请用一次受控运行（可用 tools/real-model-verify.mjs）确认当前 register_tool_call 回执是否从不含 evidence——决定 P0 紧急度与是否需要回滚 worker.mjs。
2. Worker 步数上限是否为有意的"生产无限"：worker.mjs:467 的 Infinity 与 runtime 注释/IMPLEMENTATION-PLAN 的 max_steps=6 矛盾。请确认预期值（6/10/14）与配置位置（env / resource_policy / per-role 设置）。
3. P1-2 指纹语义是否为"宁可少跑也不重复跑"的有意取舍？若接受，需要监督机制（如超过 N 分钟未推进就清空指纹）；请确认是否纳入本轮整改。
4. P1-3 会话模型：角色是否允许复用长生命周期会话？复用时 D1 的 session.actor 判据（verification.mjs:910）是否仍成立（同一 actor 不可自证，但不同 verifier 运行无法区分）？是否需保留"独立验证由独立会话提交"的既有语义。
5. §6 中"程序固定编排序列"（Orchestrator→Planner→Worker→Verifier）是否已作为已知偏差登记？我在 docs/modules/AGENTS.md 只找到"唤醒为轮询"的偏差，未找到该条，请 Lead 决定是否补登记。
6. planner.mjs:232 用 String(snapshot_commit_seq) 作为 input_boundary，若为 null 会变成字符串 "null"。C1 是否校验该字段（lib/store/intents.mjs receivePlanRevision）需 C1 精读者确认：若校验则是隐性 bug，若无校验属无害。
7. T3 的 TDZ 是否真的让用例"假绿"：我未运行测试（任务禁止），依据是 JS 作用域规则与断言集合，请以一次 node --test test/messages.test.mjs 核对。
8. P2-6 的 unknown 判据属 C2 合同（attempts.mjs:1223-1235），agents 层只能通过 args 形状影响。是否应在网关侧改为 (tool_name,url,method) 稳定键，需 C2 精读者确认改动边界。
