# 01 store-core 核心记录层精读报告

> 只读精读：lib/store/orchestrator.mjs、intents.mjs、attempts.mjs、record-service.mjs 及其依赖的迁移与跨模块调用点。
> 引用格式 `文件:行号`；未修改任何源码，仅本文件落盘。

## 1. 范围与文件清单

| 文件 | 行数 | 一句话职责 |
|---|---|---|
| lib/store/record-service.mjs | 1382 | A1 统一记录服务：受控句柄/runSerial、统一提交信封与幂等、提交操作注册表、项目与范围版本、基础操作（资产/观察/假设/漏洞/关系/证据集） |
| lib/store/intents.mjs | 1735 | C1 意图与计划接收：计划信封校验、范围/前提/依赖死锁、意图九态状态机+历史、完成建议复核、意图列表游标 |
| lib/store/attempts.mjs | 1483 | C2 执行运行时与工具网关：sweep、派发/条件领取、租约心跳、进展与完成建议、ToolCall 状态机与范围/前提闸门 |
| lib/store/orchestrator.mjs | 2216 | E1 协调服务：决定+动作持久化与逐项核对、工作面板/供给块、单动作糖衣（追问/上下文/规划请求）、汇报回执门控 |

依赖对照（非分配但为结论必需）：lib/db.mjs（runSerial 事务壳）、lib/db/migrations/0001/0002/0003/0004/0006、lib/store/scope.mjs（范围判定）、lib/store/records-read.mjs（另一套 locateRecord）、lib/routes/{submissions,plans,attempts,orchestrator}.routes.mjs（角色鉴权）、docs/modules/{A1,C1,C2,E1}.md、规范 §5.1/§6/§9.2/§10/§11/§14/§16/§17/§18.5/§20。

## 2. 模块职责与关键导出

- record-service.mjs：`getStore/closeStore:103-119`（进程内单句柄缓存、单串行队列，lib/db.mjs:62-81 BEGIN IMMEDIATE/同步事务体）；`submit:847-949`（§11.1 幂等信封）；`registerSubmissionOps:277-297` 操作注册表（append/modify+roles，越权由引擎拒）；项目面 `createProject:1180/deleteProject:1220/updateProjectLifecycle:1277/createScopeRevision:1329/getProjectScope:1359/buildProjectContext:1023`。内置 7 个操作（record-service.mjs:767-775），全部 worker 角色。
- intents.mjs：`receivePlanRevision:597-1364`（#20 计划接收）；`listIntents:1368`/`getIntentStateHistory:1445`（#21 视图）；`transitionIntent:1468`（状态与历史唯一写入点）；`reviewCompletion:1569`（完成建议程序检查）。常量 `INTENT_STATUSES:31/INTENT_TRANSITIONS:46`（九态，终态无出边）。
- attempts.mjs：`sweepExecutionState:368`；`dispatchAttempt:553`（#22）；`listAttempts:741`（#23）；`attemptLifecycle:788`（#24 heartbeat/suspend/resume/cancel）；`reportProgress:978`（#25）；`toolGateway:1189`（#26 register/start/complete/mark_unknown/resolve/cancel）。
- orchestrator.mjs：`recordDecision:1075`+`executeDecisionActions:1348`（#32）；`reconcilePendingDecisions:1387`（重启核对+陈旧规划清扫）；`buildSupplySnapshot:1464`；`orchestratorOverview:1591`（#31）；#33-36 糖衣 `recordReportReceipt:2101/createFollowup:1974/attachAttemptContext:2009/createPlanRequest:2039`。

## 3. 数据模型与持久化结构

- 0001 冻结 DDL 承载全部业务表：projects（next_commit_seq/state_version）、scope_revisions、assets（唯一身份域）、relations（valid_from_seq/retracted_at，双索引 0001:295-296）、observations、hypotheses、vulnerabilities（status/review/claim_revision/evidence_revision/assessment_epoch）、evidence_memberships、submissions、outbox（UNIQUE(project_id,commit_seq,event_index)+页序/待发送索引）、intents（九态 CHECK、dispatch/status/resume 索引 0001:327-333）、attempts（UNIQUE(project_id,fencing_token)+部分唯一索引 idx_attempts_active_assignment 0001:354-355）、tool_calls、plan_runs/plan_revisions、orchestration_decisions/actions（UNIQUE(project_id,idempotency_key)）、worker_reports/report_receipts、id_sequences(project_id,kind)。
- 迁移演进：0002 把 submissions 主键改为 (project_id,submitter_id,id) 身份域（幂等域落地）；0003 新增 intent_state_history(id/project_id/intent_id/from_status/to_status/action/reason/via/actor/commit_seq) 及其索引；0004 把"裸全局编号"（A/O/H/V/F/R/EM/SR/SUBS/ATT/TC/WR/ASM/PRJ）改从 `id_sequences('_global',kind)` 取号并按历史行抬基线；0006 加 projects.task。
- 编号约定（两套并存）：A1/C2/E1 的 allocateSeq 首值为 2（record-service.mjs:178-191、attempts.mjs:119-132、orchestrator.mjs:185-198），1 号为固定空洞（A1.md 偏差 7）；C1 的 nextSeq 首值为 1（intents.mjs:125-138）。EVT 事件 id 有三族：`EVT-<PRJ>-<6位序号>`（record-service.mjs:250、orchestrator.mjs:221、messages.mjs:96）、`EVT-<PRJ>-<commit_seq>-<event_index>`（attempts.mjs:153）、`evt-<PRJ>-<commit_seq>-<i>`/`evt-d1-…`（intents.mjs:182、verification.mjs:309）；ui/record-ids.mjs:33 已知两族并存。
- 分页/游标键：intents 用 (created_seq,id) 复合键（intents.mjs:1397-1418）；attempts 用 created_seq 单键（attempts.mjs:756-774，依赖"一派发一事务一 commit_seq"保证唯一）。

## 4. 主要调用链与数据流

**A1 统一提交（#10）**：route `POST /sorne/submissions` → sess（worker）→ `submit`(847) → 事务外 `validateEnvelopeShape:782`（禁信封自报 project_id/actor/role、submission_id/local_ref 形状）→ `precheckOps:824`（未知操作/角色越权，失败不进入事务、不耗 commit_seq）→ `runSerial` → 项目存在 → 身份域幂等查询 submissions(864-875，同摘要回原回执/异内容 IDEMPOTENCY_KEY_REUSED) → attempt_id 存在性(876-885) → `allocateCommitSeq` → 逐操作 handler（校验→INSERT/UPDATE→ctx.emit）→ receipt+result_hash → `flushEvents:240` 写 outbox（event_id 取"event"全局序号、event_index=i+1）→ 分支摘要 stale（920-930）→ INSERT submissions 回执 → COMMIT。跨边界：handler 内 `insertRelation/advanceEvidenceRevision/applyEvidenceMembership`（341-473）；`getStore`→lib/db.mjs:63 runSerial。

**C1 计划接收（#20）**：route(plans.routes.mjs:76-91 校验 planner 角色) → `receivePlanRevision` → 形状校验(461) → runSerial → 身份域幂等(609-624) → 范围解析(634-658：计划级 scope_revision 或项目 current，缺失 SCOPE_UNRESOLVED) → 计划级前提求值(660-683，失效但无人引用只告警) → plan_run 复用/新建(686-721) → 同 run 同 revision 去重(725-737) → 预留 local_ref→I 编号(750-754) → 逐意图：引用解析(756-777)、目标资产 scope_status=denied 逐意图拒(787-804)、前提失效 suspend/reject 分流(824-860)、同问题告警(861-874)、INSERT intents+history(875-919)、targets/requires/derived_from 边(920-961)、intent.blocked(962-968)；revise 走 976-1233（STALE_STATE、终态拒、前提重评估、requires 边收缩、state_version+1）→ 被拒意图被引用则整单 INVALID_REFERENCE(1236-1255) → `assertNoDependencyCycle:383` 三色 DFS（DEPENDENCY_CYCLE 整单回滚）→ 汇总 received_status、写 plan_revisions、plan_runs→received(1271-1302) → plan.received 事件 → submissions 回执(1346-1362)。

**C2 派发（#22）**：route(runtime 角色) → `dispatchAttempt` → ①`sweepExecutionState`(368→373：stopped 撤销执行权/过期租约→interrupted+running 调用 unknown+resource_state.changed) ②独立事务 `persistAssetScopeVerdicts`(565-570，scope.mjs:267) ③主事务：项目状态闸(575-585)→意图存在/非终态(586-599)→`checkIntentTargets`(scope.mjs:296 拒绝优先，写 assets.scope_status)→`checkPrerequisites`(603→241，requires 边+prerequisite_refs，判断类失效/复核门)→项目活跃数上限(604-617)→assignment 句柄(618-622)→**同分配活跃租约幂等分流**(623-646)→fencing(项目序列)/ATT(全局序列)/commit_seq→INSERT attempts（撞部分唯一索引 catch 分流，672-698）→ resource_state.changed(kind=attempt_leased)→回执含 fencing_token。

**C2 工具网关（#26）**：route(worker/runtime+本人 Attempt) → `toolGateway` → sweep → 事务内：load attempt/project/intent → register(1202-1286：活租约闸→目标数上限→checkActionTargets→checkPrerequisites→同身份 unknown 未 resolve 拦截→并发上限/预算→INSERT planned→回执 declared_targets)；start(1287-1322：重申目标范围复检→planned→running 条件 UPDATE)；settle 族(1323-1449：仅提供 token 时校验、允许租约失效后落定实际结果；complete 校验 outcome/证据引用/touched_targets 事后判定并逐违规发 scope_violation 事件)。

**C2 进展（#25）**：`reportProgress` → sweep → 事务：load attempt→迟到判定(989-1012，token 不符/租约失效/stopped)→INSERT worker_reports(handling=pending, content.late)→非迟到 completion 校验全部工具终态→UPDATE attempts completed→resource_state.changed(kind=…)。

**E1 决定（#32）**：route(orchestrator 角色) → `recordDecision` → 形状校验(1079-1123：rationale/1..16 动作/幂等键唯一)→runSerial：项目存在→input_report_ids/EVT 事件引用存在性(1134-1154)→逐动作 `validateActionPayload`(341-534，含 assign_execution 禁静默改写意图字段)→决定级幂等比对 `contentDigestPart`(1160-1189)→动作幂等键全局唯一(1192-1206)→INSERT decisions/actions→orchestration.decision_recorded 事件→M2 同事务 linkDecisionAndReplyInTx(1266-1279，消息 handled+AI 回复)→随后 `executeDecisionActions:1348` 逐 pending 动作：委托型(assign/lifecycle/verification/revise_intent) 先 `verifyDelegatedEffect:545` 核对实际效果（已完成标 reconciled 不重放）再 `applyDelegatedAction:787` 调 C2/C1/D1 真实事务，最后单独事务写动作 status/result；原子型（followup/attach_context/handle_report/set_execution_limits/record_strategy/request_planning）效果+状态同一事务(982-998)→`refreshDecisionToolResult`→`linkMessageTaskRefs:1307` 补任务面关联。跨边界：E1→C2 dispatch/lifecycle、C1 receivePlanRevision(role=planner)、D1 requestVerification、messages.mjs。

**E1 面板（#31）**：`orchestratorOverview` 先 `reconcilePendingDecisions`(1596，写操作：补执行中断决定+把超过 30min 的 in_flight plan_run 置 rejected 1441-1446)，再单事务装配 active_plan/intents/pending_reports/important_findings/pending_items/constraints/execution/supply/wake_signals/key_changes（均按库最新状态与有界条数）。

## 5. 关键不变量、并发/事务/幂等/错误处理

1. **事务边界**：所有变更经 `store.runSerial`（BEGIN IMMEDIATE→同步 fn→COMMIT/ROLLBACK，lib/db.mjs:63-81）；事务体内禁止 await。嵌套风险由实现自律规避：orchestratorOverview 的 reconcile 在自身 read 事务之前完成，dispatch 的 sweep/范围持久化/主事务顺序 await，未见同队列重入死锁路径。
2. **幂等键**：(project_id,submitter_id,submission_id)+请求摘要（887-875，0002 主键）；C1 计划幂等同法但对整信封取摘要(600)；E1 决定幂等（同 decision_id+内容等价）与动作幂等 UNIQUE(project_id,idempotency_key)；#22 同 assignment+intent+worker 活跃期幂等分流；#26 register 无幂等键（重试即新调用，§10.2 语义）。
3. **乐观锁/版本水位**：revise_hypothesis/retract_relation/意图 revise/项目生命周期/verify 各以 expected_* 校验，不符 STALE_STATE；commit_seq 项目级事务内分配，事件与业务同事务；updated_seq/state_version 各自推进。
4. **租约/围栏**：fencing token 项目内单调且 UNIQUE；活租约 = status leased/running 且 lease_expires_at>now；心跳为 token+状态+租约三条件 UPDATE(815-832)；所有新执行动作先 assertLiveLease(1138-1170)；落定类动作允许租约失效后记录实际结果；stopped 项目 sweep 立即撤销执行权、paused 阻止新动作但允许心跳/落定。
5. **范围/前提闸门**：派发（意图目标资产）+ register/start（逐目标）+ complete(touched_targets 事后判定) 三层，拒绝优先、范围未判定即拒（scope.mjs:212-249）；前提校验含 requires 边、prerequisite_refs、判断类失效/复核标记（attempts.mjs:241-355）。
6. **错误码映射**：§20.1 13 码来自 errors.mjs；本组模块产生 INVALID_REFERENCE/IDEMPOTENCY_KEY_REUSED/STALE_STATE/PRECONDITION_INVALID/LEASE_EXPIRED/RESOURCE_LIMIT/SCOPE_DENIED/SCOPE_UNRESOLVED/DEPENDENCY_CYCLE，授权拒绝复用 TRUST_DENIED(403)（A1.md 偏差 4 已记录）；动作失败以 status=failed+result.error 落库并由 #32/#34-36 以 receipt 原样转达（orchestrator.mjs:999-1022、1959-1971）。
7. **delivered≠handled**：worker_reports.handling_status 只由 handle_report 动作(721-726)/#33 门控(2131-2171)在决定持久化后改 handled；report_receipts 与 outbox 同事务。
8. **历史不可删/终态不可绕**：attempts/tool_calls/intents 状态只改行不删行；intent 状态与历史唯一写入点为 transitionIntent/receivePlanRevision/reviewCompletion（intents.mjs:1463-1467 自述）。

## 6. 与文档/设计基线的对应与偏差

**已逐条对齐**：§5.1 串行短事务（lib/db.mjs:62-81 → 全部写路径）；§6.1 稳定编号+通用字段（id_sequences 事务内取号、allocSeq 首值 2 的保留决策见 record-service.mjs:168-177）；§6.3 约束驱动（assets 唯一身份域、submissions 身份域 0002、attempts 部分唯一索引、outbox 页序/待发送索引）；§11.1 信封/回执（submit 返回 submission_id/commit_seq/ids/accepted_operations/warnings/result_hash）；§11.3 append/modify 分流；§10.1 九态+历史（0003+INTENT_TRANSITIONS）；§10.2 Attempt/租约/fencing/unknown；§16.4 生命周期与"停止立即生效"（sweep）；§18.5 delivered≠handled；§3.3 决定持久化+逐项核对；§20.1 错误码与 receipt/next_requirements；蓝图 §5 端点 #10/#20-#26/#31-#36 均实装且角色在 route 层校验（plans/attempts/orchestrator.routes）。

**文档已登记偏差**（不重复计为本轮问题）：迁移 0002/0003/0004/0006（A1.md 偏差 1/6/7、C1.md 偏差 1）；新增事件 relation.added（A1.md 偏差 2）；资源状态统一走 resource_state.changed+payload.kind（A1.md 偏差 3、C2.md 偏差 7）；#25 进展落 worker_reports（C2.md 偏差 1）；完成建议 C2 只终结 Attempt、意图级复核在 C1（C1.md 偏差 5、C2.md 偏差 2）；tool_calls 无 args 列→start 重申目标集契约（C2.md 偏差 3）；intents.scope_revision 存 SR 行号（C1.md 偏差 4）；规划请求/清扫无 outbox 事件（E1.md 偏差 4）；sequence 1 号空洞（A1.md 偏差 7）。

**本轮对照出的文档-代码偏差（详见 §7）**：C2 头注释声称执行前提按 requires_state 谓词（status/review/scope_status）校验（attempts.mjs:26-28），但 C1 落库的是 JSON 期望（intents.mjs:941），C2 只解析文本谓词（attempts.mjs:219-228），故计划声明的前提版本/状态期望在派发与工具动作前不生效（P1-2）；C2 头注释声称同分配重复派发幂等（attempts.mjs:547-552），但幂等查询在资源上限检查之后（P1-1）且只覆盖活跃租约（P2-13）；蓝图 §6 事件目录中 worker_report.submitted 未由 C2 产出（已由 C2.md 偏差 7 覆盖，不另计）。

## 7. 问题清单

**P0 阻断：无**（本组模块未发现会导致数据破坏/不可恢复的缺陷）。

**P1 重要**
1. [bug] attempts.mjs:604-617 资源上限检查先于 623-639 同分配幂等查询：项目已设 max_active_attempts 且活跃数达上限时，runtime 对**同一 assignment/intent/worker** 的传输重试被 RESOURCE_LIMIT 拒绝（而非返回原 Attempt），违反 attempts.mjs:547-552 与规范 §16.2「完全相同的分配按幂等规则处理」。依据：核对顺序在代码上明确；attempts.test.mjs:839 只测"第二个不同分配被拒"，未测此路径。建议：先做 assignment 幂等分流，再判上限。
2. [不一致] 执行前提的载体语法三套互不兼容，导致闸门语义分裂：C1 把期望写成 JSON（intents.mjs:941，形如 {"expected_status":"verified"}）；C2 只解析 `status=/review=/scope_status=` 文本（attempts.mjs:219-228）；C1 完成复核用 JSON.parse（intents.mjs:1594-1625），对文本形态 catch 后静默跳过（intents.mjs:1605-1609）；D2 另有受控语法（judgements.mjs:499-534，&/，分隔）。后果：计划接收后若前提期望（如 expected_state_version/expected_status）失效，派发与工具动作前不会按该期望拒绝（只有 rejected/falsified/disputed/pending 启发式仍生效），规范 §9.2/§17「动作前重查必要前提」被削弱；两处闸门各自理解的格式不同 → 任一形态总有一道闸门静默放行。测试只覆盖文本形态（attempts.test.mjs:880、scope.test.mjs:508）与 JSON 形态的完成复核（intents.test.mjs:1150），无交叉用例。建议：定义单一 requires_state 语法（建议 JSON+向后兼容文本），C2/C1/D2 共用一个解析器。
3. [bug] orchestrator.mjs:1839-1843 面板 `execution.active_attempts[].lease_remaining_ms` 用 `ageMs(lease_expires_at, now)`（=max(0, now-expiry)）计算未来到期时间 → 恒为 0（过期时也 0），与字段名和 UI 文案（lib/ui/render.mjs:116「租约剩余（毫秒）」）不符；测试 orchestrator.test.mjs:331 只断言 typeof number，未断言数值。后果：Orchestrator AI 依据错误供给判断租约余量（§16.3/§18.6）。建议：改为 `Math.max(0, Date.parse(expiry)-now)`。
4. [bug] orchestrator.mjs:1160-1189 决定级幂等摘要不对称：既有侧 `contentDigestPart(...)` 未传 sourceMessageId（默认 null），新请求侧传 sourceMessageId（1176）；只要重试携带 source_message_id 就必然 digest 不等 → 抛 IDEMPOTENCY_KEY_REUSED，而非 §3.3/§11.1 要求的"原状态返回"。当前生产调用（lib/agents/orchestrator.mjs:209 只传 source_message_id、不传 decision_id）未同时给两参数，故为潜伏缺陷；#32 端点允许二者并存，且无测试覆盖该组合。建议：既有侧从 message_links 反查来源消息，或在决定行持久化 source_message_id。
5. [不一致/风险] 事件引用校验只认 "EVT-" 前缀（orchestrator.mjs:1145-1153）：C1 事件 id 为 `evt-<PRJ>-<commit_seq>-<i>`（intents.mjs:182），D1 为 `evt-d1-…`（verification.mjs:309），此类引用既不校验存在性也不校验形状，任意非 EVT- 字符串都会被持久化进 decisions.input_event_refs；测试仅覆盖 "EVT-NOPE"（orchestrator.test.mjs:1169）。违反 §11.2/§20.1「引用不存在的对象 → INVALID_REFERENCE」。建议：统一事件编号格式（或按 `/^(EVT|evt)(-d1)?-/i` 识别并查 outbox）。

**P2 次要**
6. [bug] intents.mjs:975-992 revise 项缺 intent_id 时未经形状校验即绑定 SQL 参数：`resolveRef(item.intent_id)` 为 undefined → node:sqlite 抛 ERR_INVALID_ARG_TYPE（本机 v22.23.2 实测）→ 500 INTERNAL_ERROR，而非 BAD_REQUEST；validatePlanEnvelope(461-513)/validateIntentFields(542-552) 均未强制 revise 的 intent_id/expected_state_version。建议：在信封校验中补齐必填。
7. [不一致] attempts.mjs:1364-1390 complete 的 touched_targets 违规事件在业务事务内逐条 `allocateCommitSeq`：同一事务内 tool_calls.updated_seq 用 1339 的 seq，而 outbox 事件 commit_seq 更大，违反 §14.1「一事务一 commit_seq、事件 event_index 区分」的惯例（该事务每次触碰违规目标还消耗一个 commit_seq）。建议：用同一 commitSeq + 递增 event_index。
8. [风险] attempts.mjs:1293-1301 start 用请求重新派生的 targets 做范围复检，却不比对 register 时的 declared_targets/args_digest（库内无 args 列是既有偏差）：执行运行时可以少报/不报目标完成 start，闸门降级为 complete 的 touched_targets 事后告警。建议：至少比对 targets 集合是 register 目标集的子集（或用 args_digest 重申）。
9. [风险/测试缺口] attempts.mjs:1202-1286 register 无幂等键：传输重试会产生重复 planned 调用（占用 max_tool_calls 预算、并阻塞 completion 的"全部终态"检查），只能靠 cancel 清理。建议：接受 caller 侧 idempotency_key 或按 (attempt,tool_name,args_digest,最近时间窗) 复用。
10. [不一致] intents.mjs:1177-1226 revise 的 targets/derived_from 只"缺啥补啥"、从不撤回被移除项（requires 反而会 retract，1145-1160）：intents.target_asset_ids/basis_refs JSON 与 relations 边分叉，读取/血缘侧（records-read/projection）会出现已被移除的目标。建议：对 targets/derived_from 也做 superseded 撤回。
11. [死代码] record-service.mjs:920-924 staleTriggerTypes 含 "hypothesis.revised"，但修订实际发 hypothesis.proposed（758）；orchestrator.mjs:1317 过滤 action.status "reconciled"，而 action 状态枚举仅 pending/executed/failed/skipped（0001:611-612），且 reconciled 是 result 字段（963-965、1429）→ 两处分支不可达。建议：清理或统一命名。
12. [风险] record-service.mjs:487-516 资产归并依赖 INSERT OR IGNORE 后的 SELECT 回读：若 OR IGNORE 因身份唯一键以外的约束（NOT NULL/CHECK/FK 等）被忽略，回读 row 为 undefined → row.id 抛 TypeError（500），而非可区分错误。建议：改用 ON CONFLICT(身份列) DO NOTHING 或判定 changes 后显式处理未命中。
13. [bug/不一致] intents.mjs:1300-1302 计划接收无条件把 plan_run 置 'received'：已被 reconcile 判为 'rejected' 的陈旧 run（orchestrator.mjs:1441-1446）可被迟到计划"复活"，无状态机校验（§16.1 传输恢复语义）。建议：接收时校验 run.status ∈ {pending,in_flight}。
14. [风险] orchestrator.mjs:2149-2170 #33 自动回溯只扫最近 200 条决定：引用更早决定的汇报会被误判"尚无持久化决定"而 PRECONDITION_INVALID。建议：按 report_id 反查 report_receipts/worker_reports 的引用链，或允许显式 decision_id（已有）+ 在错误里给出候选。
15. [不一致] orchestrator.mjs:1434-1448 陈旧 plan_run 置 rejected 只更新状态与 updated_seq，不发任何 outbox 事件：§14.1「业务变更与 Outbox 同事务」的变更通知面缺失（E1.md 偏差 4 已承认无 plan.run.rejected 类型，但此处连通用 resource_state.changed 也未发）。
16. [性能/风险] 0001 冻结 DDL 缺 E1 热查询索引：worker_reports 无 (project_id,handling_status)/(attempt_id) 索引（0001:622-643），orchestration_actions 无 decision_id 索引（0001:604-619），report_receipts 无 report_id 索引（0001:644-655）；而 overview/supply/#33 门控按这些列全表扫（orchestrator.mjs:1701、293、2089），表行随运行无界增长。建议：新增迁移补索引（不改 0001）。
17. [bug] intents.mjs:1662-1692 未声明交付物的重复完成建议：写入 from_status==to_status 的历史行、不推进 state_version，且 `flushEvents` 传空 events（1674）但已消耗 commit_seq → 产生无 outbox 事件的 commit_seq 空洞（§14.1 稳定提交顺序的可审计性受影响）。
18. [风险] #22 幂等只覆盖活跃租约（attempts.mjs:623-646 + 部分唯一索引 0001:354-355）：同 assignment 在 Attempt 终止（completed/failed/cancelled/interrupted）后重试会新建 Attempt；E1 侧靠 verifyDelegatedEffect（orchestrator.mjs:547-557，按 assignment 查历史任一行）兜底，但直接调用 #22 的客户端会重复执行同一分配。建议：按 assignment 查历史并在同 intent+worker 时返回原 Attempt 或明确语义。
19. [风险/性能] intents.mjs:399-418 每次计划接收都把项目全部 intents 装入内存建依赖图（上限 20000 节点/200000 边，超限 RESOURCE_LIMIT），大项目下每次接收 O(N) 全表扫；建议仅加载 touched 的传递闭包（SQL 递归 CTE）或增量校验。

## 8. 测试覆盖映射

- **A1 record-service**：test/submissions.test.mjs（24 例：迁移/项目 CRUD/生命周期/范围版本/会话与角色/幂等重发与原回执/同 ID 异内容/身份域/并发同资产/commit_seq 连续/证据集版本/证据成员去重/修改型 STALE_STATE/INVALID_REFERENCE 整组回滚/attempt_id 引用/故障注入回滚/疑似漏洞状态不提升/dependency.changed/内容相同≠同一事件/重启后 Outbox+回执恢复/health）；test/multi-project.test.mjs（跨项目编号全局唯一、0004 迁移抬基线）；test/smoke.test.mjs:233-350（schema_version/核心表索引/并发 openDatabase 单飞/runSerial 提交回滚）；test/projects-crud.test.mjs（删除项目清库清文件）。
- **C1 intents**：test/intents.test.mjs（约 30 例：0003 表存在/计划合同全字段+事件+语义边/引用缺失整单回滚/信封自报拒绝/幂等与 ID 冲突/范围 SCOPE_UNRESOLVED/denied 部分接收/前提失效挂起与 reject 策略/无关新增不废计划/前提引用与期望字段校验/依赖死锁（同计划、跨修订、自引用）/疑似重复告警/修订 STALE_STATE+requires 收缩/终态不可修订/九态状态机与历史/完成建议（缺产物、伪产物、齐备 resolved、无交付物 awaiting_review、前提失效）/列表游标与 include_history/角色与跨项目 403/重启后回执恢复）。
- **C2 attempts**：test/attempts.test.mjs（16 例：派发幂等+部分唯一索引+fencing 单调/心跳与过期 LEASE_EXPIRED+同事务通知/场景 17 迟到留档且不改新 Attempt/场景 18 unknown→resolve(check_note) 后重试/真实重启注入/complete 与证据引用+重复落定幂等/完成建议工具终态门/取消状态与历史保留/子 agent 统一登记与并发上限/预算继承/项目 max_active_attempts/前提校验（文本 requires_state 与复核标记）/Outbox 写入失败整事务回滚/队列视图与游标+user 角色不泄露 token/用户停止与 paused/worker 越权 403）；test/scope.test.mjs（deny 优先、pending/unlisted、scope_status 谓词）；test/multi-project.test.mjs（双项目派发/汇报/工具调用）。
- **E1 orchestrator**：test/orchestrator.test.mjs（22 例：空面板结构/真实链路面板/delivered≠handled/重要发现以库为准/决定幂等与动作键冲突/动作失败不阻断/回执门控/needs_clarification 与 deferred/set_execution_limits/场景 29（读汇报后中断）/场景 30（多动作部分执行后重启核对、动作恰执行一次）/场景 32（受阻+供给）/追问与上下文/单规划在途与陈旧清扫/record_strategy/验证积压/base_report 线索/角色面/引用校验/waiting 不空转）；test/messages.test.mjs（source_message_id 闭环与回复）；test/stage1-project-context.test.mjs 1.5（revise_intent 持久化修订）；test/recovery.test.mjs（transitionIntent 驱动等待/受阻恢复率）；test/e2e-lifecycle.test.mjs、test/stage7-end-to-end.test.mjs、test/agents*.test.mjs（四角色真实存储链路）。

**无测试覆盖的行为**（对应 §7）：#22 上限已满时的同分配幂等（P1-1）；requires_state JSON×文本跨闸门（P1-2）；lease_remaining_ms 数值（P1-3）；带 source_message_id 的决定重试（P1-4）；evt-/evt-d1- 事件引用校验（P1-5）；revise 缺 intent_id 的错误码（P2-6）；complete 违规事件 commit_seq（P2-7）；start 目标重报与 register 一致性（P2-8）；register 传输重试（P2-9）；revise 移除 target 的边收缩（P2-10）；rejected plan_run 被迟到计划复活（P2-13）；>200 条决定回溯（P2-14）；重复完成建议的历史/commit_seq（P2-17）；Attempt 终止后的同分配重试（P2-18）。

## 9. 不确定点与需 Lead 交叉确认

1. **意图状态机归属**：`dispatchAttempt` 只拒 obsolete/cancelled/resolved（attempts.mjs:594-599），允许对 proposed/blocked/awaiting_review 的意图派发；AI 循环由 lib/agents/worker.mjs:291-293 在派发后自行 activate/start。是否需要 #22 强制 queued/running，或由 E1 assign_execution 前先 transitionIntent？请 Lead 裁决 §10.1 状态机执行权。
2. **requires_state 规范载体**：C1 JSON（intents.mjs:941）/C2 文本谓词（attempts.mjs:219-228）/D2 受控语法（judgements.mjs:499-534）三套并存，代码注释各引 §9.1/§9.2/§8.2。需确认规范是否规定了唯一语法；若未规定，建议架构师定一种并统一解析器（P1-2 的修复前提）。
3. **#22 幂等语义边界**：§16.2「完全相同的分配按幂等规则处理」是否要求覆盖 Attempt 终止后的重试？现状仅活跃租约（P2-18），E1 靠 verifyDelegatedEffect 兜底；若要求强幂等需改索引/查询。
4. **决定重试的幂等键**：生产调用 lib/agents/orchestrator.mjs:203-211 既不传 decision_id 也不传幂等键，模型重试会新建决定并重复回复用户消息；M2 文档（docs/modules/ui-M2.md）是否要求由 source_message_id 派生决定幂等键？请确认（与 P1-4 同源）。
5. **plan_run 编号双前缀**：E1 建 run 用 `PR-<PRJ>-nnnn`（orchestrator.mjs:628），C1 建 run 用 `RUN-<PRJ>-nnnn`（intents.mjs:150-151），共用 kind="plan_run" 序列；编号不冲突但形态不一，records-read 仅登记 PR（records-read.mjs:46）。是否需统一或补前缀映射？
6. **deleteProject 的序列清理**：deleteProject 按 project_id 删所有表（record-service.mjs:1241-1252），含 id_sequences 的项目域序列（event/fencing 等）；是否应保留用于审计/防围栏回退？当前 PRJ id 不复用，风险低，请确认设计意图。
7. **overview 读路径写副作用**：orchestratorOverview 在 GET 内执行 reconcile（补执行已持久化动作、清扫陈旧 run，orchestrator.mjs:1596）。E1.md 偏差 5 已说明，但 UI 高频轮询时可能反复触发写事务；请确认是否应改为独立后台 tick 或由 F2 调用 reconcilePendingDecisions。
8. **未运行门禁**：按任务约束未执行 npm test/npm run ui；本报告的"测试覆盖"依据 test/*.test.mjs 用例清单与断言阅读，未做运行时验证（line 号基于当前工作区快照）。P1-1/P1-3/P1-4 建议由 Lead 指派者用最小用例复现确认。
