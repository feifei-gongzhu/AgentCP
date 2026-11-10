# t02-attempts 测试精读报告

> 只读精读：test/attempts.test.mjs、test/records-ids.test.mjs、test/subject-kind.test.mjs；未运行测试、未改源码。
> 引用格式 `文件:行号`。

## ① 文件与用例数

| 文件 | 行数 | test() 用例数 | 主题 |
|---|---|---|---|
| test/attempts.test.mjs | 1175 | 17 | C2 执行运行时与工具网关：派发/租约/fencing/生命周期/完成建议/子 agent/预算/前提/事务注入/视图/停止/paused/越权 |
| test/records-ids.test.mjs | 209 | 2 | /records 编号前缀定位（两族编号、扩展前缀、RR 双表、evt- 404） |
| test/subject-kind.test.mjs | 231 | 3 | verification subject_kind 语义化（词表、漏洞/假设任务、outbox payload） |

合计 22 用例，全部真实 HTTP + 真实 SQLite，无 mock 存储。

## ② 锁定的行为清单

**attempts.test.mjs（按用例）**
1. 派发/条件领取（:186-266）：ATT 编号形态、status=leased、idempotent=false/true、同分配不同 worker → IDEMPOTENCY_KEY_REUSED（:213-219）、suspend 释放租约后可再派发且 fencing 严格递增（:231-232）、resume 撞部分唯一索引 → PRECONDITION_INVALID（:234-240）、worker 派发 403（:255-260）、意图不存在 INVALID_REFERENCE（:263-265）。
2. 心跳/过期（:270-322）：短 TTL 真实等待后心跳 LEASE_EXPIRED（:281-289）、renewed_until 严格变大（:297）、expireLease 后心跳失败但 attempt 转 interrupted 且 outbox 有 lease_expired 通知（payload.decision_needed_by=orchestrator，:308-321）。
3. 场景 17（:326-434）：迟到完成建议 late=true 不改新 Attempt（d2 仍 leased，:388-396）、迟到证据经 A1 提交可保存（:372-381）、旧 token 登记 LEASE_EXPIRED（:399-404）、旧执行者越权触碰新 Attempt 403（:415-420）、新执行者正常登记（:422-428）、历史 2 条（:431-433）。
4. 场景 18（:438-508）：mark_unknown → 同身份重试 PRECONDITION_INVALID+提示 resolve（:470-477）、resolve 缺 check_note=400（:480-485）、resolve 后重试为新 TC（:502-507）。重启注入（:510-590）：关库关服重开 → interrupted/unknown=1/cancelled=1（:549-553）、事件重启后仍在（:556-560）、resolve 后新派发（:563-584）。
5. complete（:594-673）：坏证据引用 INVALID_REFERENCE（:621-626）、真实观察编号作 evidence_refs 且 touched_targets=allowed（:640-647）、重复落定 idempotent=true（:649-655）、改判 PRECONDITION_INVALID（:657-663）、failed 带 error（:666-672）。
6. 完成建议（:677-715）：未终态调用时 PRECONDITION_INVALID（:690-696）、全部终态后 Attempt completed 且 intent 仍 queued（:702-712）、attempt_completed 事件存在（:713-714）。
7. 取消（:719-756）：running→unknown、planned→cancelled（:740-747）、尝试/调用历史行保留（:749-753）、recovery_note.reason 落库（:754-755）。
8. 子 agent（:760-809）：created_by=agent（:788）、统一并发上限 2→第三个 RESOURCE_LIMIT retryable（:797-802）、过期租约继承 LEASE_EXPIRED（:804-808）。
9. 预算（:813-835）：max_tool_calls=2 耗尽后 RESOURCE_LIMIT retryable=false（:827-834）。
10. 项目上限（:839-857）：max_active_attempts=1 时第二个**不同**分配 RESOURCE_LIMIT retryable=true（:852-856）。
11. 前提（:861-935）：文本 requires_state=status=supported 放行→rejected 后工具登记阻断（:879-902）、撤回 requires 边后放行（:904-914）、confirmed+review=pending 阻止派发（:916-928）、prerequisite_refs 不存在 INVALID_REFERENCE（:930-934）。
12. 事务注入（:939-959）：CREATE TRIGGER 对 outbox RAISE(ABORT) → 派发 500 且 attempts 计数 0（:947-955），删 trigger 后成功（:956-958）。
13. 队列视图（:963-1032）：by_status/unknown 明细（:992-996）、seconds_remaining>0、fencing_token 对 runtime/本人 worker 可见、user 与匿名不可见（:997-1022）、limit/after 分页（:999-1006）、跨项目 403（:1027-1030）。
14. 停止（:1036-1101）：新派发 PRECONDITION_INVALID、sweep 后 interrupted+unknown（:1064-1067）、心跳/新动作 422（:1070-1081）、在途调用可 resolve 实际结果（:1084-1089）、迟到 progress 留档（:1092-1097）。
15. paused（:1105-1146）：新派发/新工具动作拒，心跳与在途 complete 仍允许（:1127-1145）。
16. worker 越权（:1150-1175）：非本人 Attempt 的 progress/tool-calls 403，本人 200。

**records-ids.test.mjs**：两族资产编号正则 A-\d+ / A-PRJ-\d{4}-\d{4}（:64、:76）且 /records 均可定位（:79-84）；13 类扩展前缀定位+紧凑视图字段（:144-160）；RR 双表带 version/report_kind（:162-178）；SUBS/MSG 可定位（:180-195）；EVT-/evt- 404+hint 指向 /changes（:197-202）；不存在编号 404（:204-206）。

**subject-kind.test.mjs**：词表四值与双向映射、未登记表返回 null（:89-101）；漏洞任务 subject_kind=vulnerability 且 ≠物理表名、subject_table=vulnerabilities（:146-149）；reviewed_manifest_id/reviewed_evidence_revision 提交后进入 latest_result（:179-181）；假设任务 subject_kind=hypothesis 且 outbox payload 同语义+subject_table（:211-228）。

## ③ 测试替身/隔离/时钟手法

- 隔离：helpers.mjs:19-21 mkdtemp + SORNE_DATA_DIR 注入，helpers.mjs:28-83 用 mock ctx 调真实 apply() 起随机端口 server，helpers.mjs:86-93 withTestServer finally 关服删目录；attempts.test.mjs 自建 bootServer/withServer（:56-94）并额外在 finally 调 closeStore（:91）——因重启演练需真实关库（:539-548）。
- 替身：无 stub/mock；LLM 与网络均不涉及。库级"注入"直连受控句柄：expireLease 把 lease_expires_at 改过去（:169-177）、seedIntent 直插 intents 行（:110-134）、直接改 resource_policy（:844-850）/hypotheses.status（:883-894）。属白盒注入，不替代事务语义。
- 时钟：两条路径——真实短 TTL+setTimeout(1050ms)（:281-283）与库行过期（:300、:805）；前者真实但有 1s 墙钟开销，方向安全（只会更晚过期）；无 fake timer。
- 故障注入：真实 SQLite TRIGGER RAISE(ABORT)（:945-951），断言 500 与零残留（:952-955），随后 DROP TRIGGER 复跑成功（:956-958）。
- 重启：revokeSession→server.close→closeStore→同目录 bootServer→重签会话（:539-546），非进程级崩溃（见④）。

## ④ 断言质量（过拟合/同义反复/放宽/假绿）

- **锁定不变量较扎实的点**：幂等重发同 attempt id（:204-210）；fencing 严格大于（:232、:368、:579）；迟到提交 late=true 且新 Attempt 仍 leased（:389-396）；unknown→resolve→新 TC（:469-507）；事件与业务同事务（:939-959）；user/匿名不泄露 fencing_token（:1009-1022）；越权 403 与归属校验（:415-420、:1150-1175）。这些断言读库侧状态或回执编号，难以被实现轻易"做成真"。
- **过拟合文案**：多处 assert.match(message, /中文片段/)——/部分唯一索引/（:240）、/未终态/（:696）、/统一并发/（:802）、/预算/（:834）、/停止/（:1061、:1081）、/fencing token 不匹配/（:413）。文案调整即红，属实现细节耦合；建议改断错误码+detail 字段。
- **同义反复/无信息断言**：assert.equal(d2.attempt.id !== d1.attempt.id, true)（:231、:1031）应改 assert.notEqual；大量 assert.equal(res.status,200) 之外的实现等价断言少，部分用例（records-ids）以"存在字段"为主（:154-159），不校验字段值。
- **被放宽/未锁定**：resume 用例不传 fencing_token（:234-236、:247-250），与实现 attemptLifecycle resume 分支不校验 token 一致——该宽松行为被测试固化而非被质疑；register 的 args_digest/targets 一致性未断言（start 只传 targets，:355-358）。
- **假绿风险（条件式跳过）**：records-ids 的 RR 断言包在 `if (reportId)`（:172-178），报告侧未产出即整块跳过；subject-kind 的 outbox payload 断言包在 `if (ev)`（:224-228），事件缺失则全部跳过；subject-kind 无原始证据被拒只断 status=400 不断 code（:131），错误码契约未锁定。
- **"崩溃"语义偏差**：场景 18 重启用例只做"过期租约+关库关服"（:537-541），没有内存中未提交事务，验证的是 sweep 识别而非崩溃半状态；真正的半状态由 trigger 注入用例覆盖另一面，注释称"进程崩溃"偏强。
- **时钟与假绿**：真实 1050ms 等待（:283）只影响耗时，不会造成假绿；但 `seconds_remaining>0`（:201、:996）依赖默认 30min TTL，若默认值被调小可能抖动。
- **夹具与生产编号不一致**：records-ids 直插的 I-/ATT-/TC-/WR-/CP-/PR-/OD-/OA- 行使用 `PREFIX-PRJ-数字-0001` 形态（:102-130），而生产 C1/C2 是 I-PRJ-0002（无第二段）与全局族 ATT-0002；这些用例主要验证 records-read 兜底扫描，不能证明生产编号族可定位（第一用例的双真实族路径已部分缓解）。
- **本应暴露但未暴露的实现缺陷**（主报告 P1/P2 对照）：max_active_attempts=1 只测"不同分配被拒"（:839-857），未测"同分配幂等重发"，故 dispatch 先判上限后判幂等的顺序缺陷（attempts.mjs:604-646）无法被测出；requires_state 只测文本形态（:880），未测 C1 写入的 JSON 期望（intents.mjs:941）在派发闸门被忽略；队列视图只测 attemptView.seconds_remaining，未测 orchestratorOverview.lease_remaining_ms 恒 0（orchestrator.mjs:1842）。

## ⑤ 覆盖缺口

- 无并发真并发：所有"并发领取/越权"都是顺序请求，部分唯一索引的并发撞索引路径（catch 分支 attempts.mjs:672-698）未被真实并发触发；多进程/多句柄并发亦未测。
- 无 register 传输重试/重复登记用例（无幂等键语义、预算与完成闸门的连带影响未测）。
- #24 suspend 在 paused/stopped 项目下的边界、resume 后的前提/范围重检未测（测试只有正常路径）。
- 无常量边界：lease_ttl_ms 的 min/max/BAD_REQUEST、targets 上限 64、MAX_ACTIONS_PER_DECISION 等本文件不涉及；attempts 的 TTL 上下界未断言。
- 无 overview/面板（#31）的 lease_remaining_ms、wake_signals 等字段值断言（只在 orchestrator.test 测结构）。
- records-ids：VJ/VR/CG/RES/M 等前缀仅注释承诺，实际断言的是直插子集；RR 依赖 F1 条件式；被跳过的分支无独立用例兜底。
- subject-kind：文件头称"四处写点（任务行、Manifest 行与内容哈希、事件 payload、回执/准入视图）"，实测只覆盖 jobView 两处与 outbox 一处；observation/fact 两值只有纯函数断言，真实服务路径未覆盖。

## ⑥ 与实现文件映射

- attempts.test.mjs ↔ lib/store/attempts.mjs（dispatchAttempt:553、sweepExecutionState:368、attemptLifecycle:788、reportProgress:978、toolGateway:1189、attemptView:456）、lib/store/scope.mjs（checkActionTargets:213）、lib/routes/attempts.routes.mjs（requireRole:27、assertAttemptOwnership:52）、lib/store/sessions.mjs（issueSession/revokeSession）、index.js apply、lib/db.mjs runSerial、lib/store/record-service.mjs submit（迟到证据留档）、0001 DDL（idx_attempts_active_assignment、UNIQUE(project_id,fencing_token)）。
- records-ids.test.mjs ↔ lib/store/records-read.mjs（PREFIX_TABLES:21-60、RR_PREFIX_TABLES:62-64、FALLBACK_TABLES:66-84、evt- 404 分支:777-778）、record-service register_asset、dedup register_service_asset、F1 reports、B2 subscriptions、M2 messages、D1 verification。
- subject-kind.test.mjs ↔ lib/store/verification.mjs（SUBJECT_KINDS/semanticSubjectKind/subjectTableOf/toSemanticSubjectKind、jobView、verification.completed payload）、lib/db.mjs openDatabase、lib/store/layout.mjs stateDbPath、A1 submissions、A2 evidence/blobs。
