# t04 · 变化流/Outbox/游标/消息 测试精读

> 任务 task-15。只读测试源码，未运行 npm test。范围合计 1570 行、24 个 node:test 用例。
> 一句话结论：这组测试是本项目质量最高的部分——真实 HTTP + 真实 SQLite + 真实重启/TRIGGER 故障注入，关键不变量（不跳事件、delivered≠applied、事务原子性）都有结果态与库内行级断言；主要问题是 ack 边界洞「越界到扫描区间内但越过未投递溢出事件」无用例、cursor 契约面 7 个端点只做字段存在性假绿、以及若干净事件序号被实现变更即碎的过拟合。

## ① 文件与用例数

| 文件 | 行数 | 用例数 | 用例行号 |
|---|---|---|---|
| test/changes.test.mjs | 786 | 13 | 141/172/207/244/316/373/415/465/511/566/630/690/746 |
| test/change-log.test.mjs | 196 | 3 | 33/93/161 |
| test/cursor.test.mjs | 231 | 3 | 88/129/207 |
| test/messages.test.mjs | 296 | 4 | 72/146/215/264 |
| test/outbox-consumer.test.mjs | 61 | 1 | 17 |

## ② 锁定的行为清单（按场景）

- **B2 变化流**：订阅四元组/版本/游标形态（changes:141-168）；过滤流 scanned 计数且游标覆盖已扫描区间（172-203）；页上限截断时溢出匹配重扫、不重不漏（207-240，断言 seen==["5:1","6:1","7:1"]）；delivered≠applied 分存与升级、重投递/attempts 可观测、重复确认幂等（244-312）；场景14 重复投递不回退两消费者独立游标（316-369）；场景16 新边扩展关注集并跨批次生效（373-411）；强制通知无视 event_types 过滤（415-461）；CURSOR_EXPIRED + next_requirements + 重同步（465-507）；确认不得跳过未投递/未扫描事件（511-562）；openSubscriptionBoundary 四字段形状、边界≥MAX(seq)、同 focus 版本推进/异 focus 新订阅（566-626）；真实关库重启后游标/回执持久、applied 不重投、新事件补投（630-686）；投递事务原子性（690-742）；权限矩阵：无会话/user/跨项目/非消费者本人 403， #19 可读，参数 400（746-786）。
- **change-log 只读视图**：事件按 (commit_seq,event_index) 有序、信封齐备、游标续读并集==全量（change-log:33-91）；订阅锚点/resume_cursor 等价/游标跨订阅 400/订阅跨项目 403/缺参 400/幽灵项目 404（93-159）；三次读取前后 receipts/outbox 状态/订阅 last_cursor+focus 逐字段不变（161-195）。
- **游标统一**：verification-jobs 真实两页翻页 + after 别名同果 + 非法游标 400（cursor:88-127）；8 个冻结端点断言 next_cursor/has_more 存在与参数被读取（129-205）；旧形体 /projects 无信封、health/metrics/diagnostics 无信封、worker-reports 单条 404（207-231）。
- **消息闭环**：received→runOnce→决定关联→handled，links 含 orchestration_decision/plan_run，AI 回复 source_decision_id 对齐，未闭环不显示已答复（messages:72-144）；附件经 read_blob 真实读到字节（202 断言 text===content）、坏附件 INVALID_REFERENCE 整条拒绝不半提交（183-190）；waiting_for_change 项目收到用户消息→active+resource_state.changed.cause=user_message（215-262）；content 限长/refs 校验/cursor 翻页去重/跨项目 404（264-296）。
- **Outbox 消费者**：bootstrap 存量置 skipped、consume 增量写 applied+置 sent、重复消费 marked_sent=0 幂等（outbox-consumer:17-61）。

## ③ 测试替身 / 隔离 / 时钟手法

- **真实优先**：全部用真实 `http.createServer` + 真实 dispatcher + 真实 SQLite；独立 mkdtemp 临时目录 + listen(0)（changes:59-84 的私有 bootServer 供重启用；其余 withTestServer）。
- **故障注入是真的**：重启=关服+closeStore+同目录重开+运行时重签会话（changes:630-686）；事务失败=真实 SQLite `CREATE TRIGGER … RAISE(ABORT)` 在 consumer_receipts 插入点注入（changes:712-714），不是 mock 事务。
- **模型替身**：messages 用 scripted `reactiveModel`（messages:43-70）按 system 提示里的角色名路由脚本化 tool_calls，经 `pctx.__modelProvider`（:108）注入；存储/Outbox/运行时/工具网关全真实，唯一替身是 LLM 输出，符合 AGENTS 模块先例。
- **时钟**：不 mock 时间；顺序断言一律基于 (commit_seq,event_index)，无 sleep，确定性好。
- **隔离缺陷**：`outbox-consumer.test.mjs:58` 调用的 `closeAllStores()` 来自 `evidence.mjs:13`（只关 A2 的句柄），本用例用的是 record-service 的 `getStore` 句柄，实际未关闭（该文件也未调 `closeStore`）。macOS 上 rm 仍成功，属句柄泄漏型隔离瑕疵，不污染其他文件（dataDir 唯一）。
- changes 用 `getStore({dataDir})` 在同一进程内与服务器共享连接做库内断言（changes:120-123、586），只在请求间隙读取，无并发竞争，但依赖「同进程同库同连接」这一实现事实。

## ④ 断言质量（过拟合 / 同义反复 / 放宽 / 假绿）

- **强项**：不只是 HTTP 状态，而是库内行级结果断言——receipts 的 receipt_kind 升级（changes:286-289）、outbox.delivery_attempts==2（:272-275）、focus/last_cursor 回滚前后逐字段相等（:722-731）、重启后仍 applied 被过滤+新事件补投（:662-673）；change-log 用「分页并集 == 全量集合」真正证明不漏事件（change-log:75-85）；messages 用 AI 工具看到的字节 `text === content`（messages:202）证明附件闭环不是假绿。
- **过拟合**：硬编码提交序号与事件号——snapshot_commit_seq==2（changes:153）、high_watermark {commit_seq:3,event_index:1}（:165）、页结果 ["5:1","6:1","7:1"]（:233）、事件串 "asset.discovered@3:1"（:393/409）、next_cursor 正则锁定 c:/log: 编码（changes:152/166/194/496、change-log:62）。一旦 A1 增加建项目事件、调整提交序或改游标编码，这些用例会成片变红；维护时若为省事放宽，会同时削弱「不跳事件」的核心断言（假绿风险）。
- **条件断言/放宽**：cursor.test:171 `if (ch1.body.next_cursor)` 才翻第二页、:198 `if (at.body.next_after)` 才比对；:196-197 只断言 `"has_more" in body`（存在性而非值）→ 契约面可能假绿。change-log 排序断言仅覆盖 page1 的两条相邻事件（:53-61），page2 只比并集。outbox-consumer 多处 `>= 1`（:35/37/49/51/54）属弱计数，重复事件/重复回执也能通过；但随后 pending==0 与 receipts>=1 部分补强。
- **依赖错误文本**：changes:717-719 断言 500 + message 含 /注入/（TRIGGER 错误原文透传）；实现若改为包装错误消息仍绿但防护力下降——建议补断言「无半状态」为主、文本为辅。
- **无跳过/无同义反复**：无 test.skip/todo；断言基本都是「结果态 vs 期望常量」，不是把实现表达式搬进断言。测试文件内用例串行（node:test 默认），无同文件并发竞争。


## ⑤ 覆盖缺口

1. **ack 越界洞只测了两种、漏了第三种（最需要补）**。已覆盖：确认未投递事件→PRECONDITION_INVALID（changes:526-533）；边界越过已扫描区间→PRECONDITION_INVALID（:536-542，用的是 99999）。**未覆盖**：「边界落在已扫描区间内、但越过本页未投递的溢出匹配事件」。实现只用 `posGt(boundary, state.scan_through)` 把关（lib/store/changes.mjs:1017），而 scan_through 是扫描末位置（changes.mjs:843/862/941），可严格大于本页游标 cutPos（:906-908 溢出时取第 limit 个匹配事件）。可复现：用例 207 场景中 limit=1 读到 (5,1)（next_cursor 只到 (5,1)），此时 scan_through=(7,1)；直接 `POST /consumer-acks {boundary:"c:<sub>:1:7:1"}`（即该页响应的 high_watermark，changes:958 暴露）→ 通过，last_cursor 被推进到 (7,1)（changes.mjs:1104-1109），客户端从 last_cursor 续读即**永久跳过** (6,1)/(7,1) 两条已匹配未投递事件。用例 207 只测翻页、用例 536 只测 >scan_through，两者都不覆盖该窗口；建议补用例并加「确认边界 ≤ 已投递最大位置」守卫。
2. change-log：limit 上下界（1..200）与非法 limit 400 未测；携带会话但会话项目域不一致的 403 分支（routes/changes.routes.mjs:87-92）未测。
3. cursor：仅 verification-jobs 做了真实两页深翻页（cursor:106-121），其余 7 个端点（/change-log、/intents、/vulnerabilities、/attempts、/projects、/reports、/changes）只断言字段存在/参数被读取，未验证「翻页不重不漏」——与 changes.test 对 /changes 的深度覆盖形成反差。
4. messages：跨项目 404 用的是不存在的 PRJ-9999（messages:293），无法区分「消息不存在」与「跨项目拒绝」；未测 status=failed/processing 中间态、reply_to 多级回复链、attachments 的 capture 类附件、decision/intent/attempt 类 refs。
5. outbox-consumer：仅 1 用例；未测 bootstrap 二次执行（跨重启不重复 skipped）、自定义 consumerId、throughCommitSeq 非整数抛错（outbox-consumer.mjs:31-32）；断言硬编码 consumer_id 'sorne-runtime'（:53）耦合实现常量。
6. changes：未测 SCAN_BATCH/MAX_SCAN_PER_PAGE 扫描上限触发（scanned.scan_cap）；未测 subscription_revision>1 后旧版本回执隔离；缺「边界 == scan_through 且确实已全部投递」的正例（与缺 1 互补）。
7. 重试/失败语义：delivery_attempts 固定断言 =2（changes:275），无 outbox delivery_status='failed' 用例；无 ack 只传 event_ids 时的 recordBoundary 取最大位置用例（changes.mjs:1066-1085）。

## ⑥ 与实现文件映射

- changes.test.mjs ↔ `lib/store/changes.mjs`（readChangesPage:808-、acknowledgeConsumption:982-、openSubscriptionBoundary:656-、getSubscriptionView:600-）、`lib/routes/changes.routes.mjs:105-175`、`lib/routes/snapshots.routes.mjs`。
- change-log.test.mjs ↔ `lib/routes/changes.routes.mjs:75-104` + `lib/store/changes.mjs:420-`（readChangeLog：log:/c: 游标、订阅锚点、只读）。
- cursor.test.mjs ↔ 各列表端点：verification.routes.mjs:95-127、changes.routes.mjs:77-121、plans.routes.mjs:96-110、judgements.routes.mjs:69-84、attempts.routes.mjs:100-135、projects.routes.mjs:135-143、report-views.routes.mjs:65-92。
- messages.test.mjs ↔ `lib/routes/messages.routes.mjs`、`lib/store/messages.mjs`、`lib/agents/runtime.mjs`（runOnce/唤醒）、`lib/agents/model.mjs`（normalizeAssistantMessage：messages:23/67）。
- outbox-consumer.test.mjs ↔ `lib/store/outbox-consumer.mjs:17-63`（CONSUMER_ID:14、bootstrap:17-26、consume:29-62）。

