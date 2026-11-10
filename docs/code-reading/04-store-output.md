# 04 store-output 输出与运维层精读报告

> 范围：lib/store 的报告/消息/指标/诊断/会话/LLM 配置/Outbox 消费/布局共 9 个文件。
> 精读方式：逐行 read（大文件分段），仅只读源码；未运行 npm test / npm run ui。
> 行号引用格式 `file:line`（均对应当前工作区文件）。

## 1. 范围与文件清单

| 文件 | 行数 | 一句话职责 |
|---|---|---|
| lib/store/reports.mjs | 1039 | E2 分层汇报服务：#37 提交（清单生成/覆盖检查/幂等/事件同事务）与 #38 三层读取（交接卡分页） |
| lib/store/reportgen.mjs | 1428 | F1 报告服务：#39 漏洞报告（草稿/版本同步/历史）与 #40 阶段报告（覆盖度/边界）+ #53 导出读取与 Markdown 渲染 |
| lib/store/messages.mjs | 465 | M2 用户消息通道：#46 入库（附件/引用校验）+ #47 列表（游标）+ 单条读取 + 事务内闭环写点 |
| lib/store/metrics.mjs | 469 | F2 §20.2 十类运行指标只读聚合 + 演练报告路径 |
| lib/store/llm-settings.mjs | 262 | LLM 连接配置存储（<dataDir>/llm.json）、脱敏视图、连接测试、store>env 解析辅助 |
| lib/store/diagnostics.mjs | 242 | M2 #49 诊断聚合（全局四态分布 / 单项目健康块 + 计划/意图/租约/汇报/消息/投影/证据） |
| lib/store/sessions.mjs | 111 | A1 进程内会话与角色签发/解析/撤销（不落库） |
| lib/store/outbox-consumer.mjs | 62 | §14 Outbox 消费闭环：bootstrap 置 skipped、增量写 applied 回执并置 sent |
| lib/store/layout.mjs | 279 | A2 §5.2 目录布局唯一实现：safeSegment、项目树、证据/工作区路径、assets/ 逻辑入口物化 |

外部依赖（只读交叉核对，不计入分配行数）：lib/routes/{messages,llm,metrics,diagnostics,reports,report-views,report-export,health}.routes.mjs、
lib/db/migrations/{0001,0002,0004,0005}.mjs、lib/db.mjs、lib/agents/{model,orchestrator,runtime}.mjs、
lib/store/{record-service,records-read,evidence,recovery,attempts,explore,orchestrator}.mjs、对应 test/*.test.mjs。

## 2. 模块职责与关键导出（逐文件）

- reports.mjs：导出 `REPORT_KINDS`/`FINDING_TYPE_TABLES`/`DEFAULT_HANDOFF_BUDGET`/`MIN|MAX_HANDOFF_BUDGET`、
  `collectAttemptRecords`（执行窗口归因 v1）、`coverageGaps`（程序覆盖检查）、`submitWorkerReport`、
  `readWorkerReport`、`__testables`。内部含编号分配（`WR-<PRJ>-NNNN`/`WRM-…`）、覆盖类别映射、
  交接卡分组与分页、基线差异视图。
- reportgen.mjs：导出 `REPORT_SCHEMA_VERSION`、`reportFingerprint`、`buildSubjectTrace`（四向追溯）、
  `buildVulnerabilityReportContent`、`buildMilestoneReportContent`、`syncVulnerabilityReports`、
  `generateMilestoneReport`、`getVulnerabilityReportView`、`getMilestoneReportView`、
  `readReportRevisionForExport`、`renderReportMarkdown`。
- messages.mjs：导出 `MESSAGE_DIRECTIONS/STATUSES`、`ATTACHMENT_KINDS`、上限常量、`linkKindForTable`、
  `createUserMessage`、`listMessages`、`getMessage`、`linkDecisionAndReplyInTx`（仅供 decided 事务内调用）、
  `linkRecordsToMessage`、`countPendingUserMessages`、`oldestPendingUserMessage`、`markMessageProcessing`、
  `allocateEventSeq`（与 explore/runtime 共用 event 序列）、`messageRowView`。
- metrics.mjs：导出 `METRICS_SCHEMA_VERSION`、`collectMetrics`（唯读）、`drillReportPath`。
- llm-settings.mjs：导出 `LLM_FILE_NAME/LLM_ROLES`、`llmSettingsPath`、`maskApiKey`、`readLlmSettings`、
  `writeLlmSettings`（进程内按 dataDir 串行 + tmp/rename）、`sanitizedView`、`resolveEffectiveConfig`、
  `envConfig`、`testLlmConnection`。
- diagnostics.mjs：导出 `buildDiagnostics`（仅一个入口；health 块/单项目块为内部函数）。
- sessions.mjs：导出 `ROLES`、`SESSION_HEADER`、`issueSession`、`resolveSession`、
  `revokeSessionsForProject`、`revokeSession`、`sessionFromRequest`、`activeSessionCount`。
  存储载体 = 进程内 `Map`（sessions.mjs:34），不落库（冻结 DDL 无 sessions 表）。
- outbox-consumer.mjs：导出 `bootstrapOutbox`、`consumeOutbox`，消费者常量 `sorne-runtime`（:14）。
- layout.mjs：导出 `safeSegment`、`projectDirName`、`stateDbPath`、`projectDir`、`evidenceDirs`、
  `blobPath`、`ensureWorkspace`、`ensureProjectTree`、`relToDataDir`、`materializeAssetEntry`、
  `rebuildAssetEntries`。

## 3. 数据模型与持久化结构

本层不新增表（除 0005 属 M2），全部写冻结 DDL 或文件：

- `messages`（0005-messages.mjs:26-38）：id/project_id/direction(user|ai)/content/status(received|processing|
  handled|failed)/reply_to 自引用/source_decision_id/created_*；索引 `(project_id, created_seq, id)` 与 `reply_to`。
- `message_links`（:42-48）：主键 `(message_id, link_kind, ref_id)`，label 人读；`ref_id` 有索引（:49）。
- `worker_reports`（0001:622-643）：kind 四态 CHECK、replaces/base、source_manifest_id、source_commit_boundary（TEXT）、
  content/omitted_sections JSON、delivery_status（无 CHECK）、handling_status 四态 CHECK。
  分层汇报与 C2 进展行（content.source=attempt_progress）**共表共存**（attempts.mjs:996-1031 写 WR-NNNN 全局号）。
- `report_revisions`（0001:658-671）：report_kind∈{vulnerability,milestone}、version TEXT（实际 `vN`）、
  content_ref（相对 dataDir 的文件路径）、basis_refs/data_boundary JSON 文本、created_seq 取生成依据边界；
  UNIQUE `(project_id, report_kind, subject_id, version)`。
- `outbox`/`consumer_receipts`（0001:482-512）：outbox 六字段 + delivery_status 四态 CHECK + attempts；
  receipts 复合主键 `(consumer_id, subscription_revision, event_id)`，receipt_kind∈{delivered,applied}。
- `submissions`（0002 改为 `(project_id, submitter_id, id)` 复合主键）：E2 复用作幂等域（reports.mjs:730-745）。
- `snapshots`（0001:533-545）：metrics 投影滞后/未消费发现边界只读该表 snapshot_commit_seq。
- `projects.next_commit_seq` 是 commit_seq 水位；各模块自带一份同构的 `nextCommitSeq`/`allocateSeq` 本地实现
  （reports.mjs:150-163、messages.mjs:69-82/119-126、reportgen.mjs:107-120），未复用 A1 内部件（冻结文件未导出）。
- 文件布局（layout.mjs）：`<dataDir>/state/sorne.sqlite`（:55-57）、`<dataDir>/projects/<dir>/`
  {assets,maps,reports,work,evidence/blobs/sha256,evidence/staging}（:64-95）；reportgen 内容文件落
  `reports/vulnerabilities/<vid>/vN.json`（:889-896）与 `reports/milestones/<MR-id>/content.json`（:898-905）；
  演练报告落 `<dataDir>/work/recovery/drills/<stamp>.json`（metrics.mjs:466-469，见 P2-20）。
- LLM 配置为文件 `<dataDir>/llm.json`（llm-settings.mjs:22-29），camelCase 主键 + 可选 per_role + note/updated_at；
  无 llm_settings 表（0005 迁移头注释登记该偏差）。

## 4. 主要调用链与数据流

### 4.1 用户消息闭环（M2）
`POST /sorne/messages` → messages.routes.mjs:67-84（`userPlane` 角色面 :17-28、`projectOf` 归属 :31-44）
→ `createUserMessage`（messages.mjs:238-304）：项目存在（:244-247）→ `validateAttachments`（:168-208，
blob 按 B- 编号或 sha256、capture 按 `locateRecord`，整条拒绝）→ `validateRefs`（:211-231）→ reply_to 存在性
（:251-261）→ `nextCommitSeq`/`nextMessageSeq`（:262-263）→ INSERT messages(status=received) → message_links（:273-279）
→ `emitMessageEvent`（message.received，:84-109）→ `messageRowView`。
**跨模块边界**：`locateRecord` 来自 records-read.mjs:115；事件编号序列 `allocateEventSeq` 与 A1/explore/runtime 共用（:119-126）。
唤醒链：runtime.projectWorkload 取 `countPendingUserMessages`（runtime.mjs:76）→ hasWork（:97）→ Orchestrator 面板读取
并 `markMessageProcessing`（agents/orchestrator.mjs:85-96）→ `submit_decision(source_message_id)` → E1 recordDecision
→ `linkDecisionAndReplyInTx`（messages.mjs:377-416，同一事务：link decision → handled → 追加 ai 回复 → message.handled）；
动作执行后 `linkRecordsToMessage` 补链（:422-436）。
等待项目唤醒：runtime.resumeWaitingProject（runtime.mjs:217-253）自行 allocateEventSeq + resource_state.changed(cause=user_message)。
读面：`GET /messages` `listMessages`（messages.mjs:307-344）、`GET /messages/{id}` `getMessage`（:347-368）。

### 4.2 LLM 配置与运行时
`PUT /llm/settings` 或 `POST /settings/llm`（llm.routes.mjs:95-112）→ `writeLlmSettings`（llm-settings.mjs:95-104，
按 dataDir 进程内串行）→ `writeLlmSettingsSync`（:106-141：baseUrl 必填 http(s)、model 必填、apiKey 缺省保留/空串清除、
tmp+rename）→ `reloadAgents`（routes:32-42）→ `pctx.agents.reload()`（runtime.mjs:191-209）→
`resolveModelProvider`（agents/model.mjs:225-261：注入替身 > store(`readLlmSettings`+`resolveEffectiveConfig` per_role) > env）
→ 四角色循环每轮重新解析（runtime.mjs:307/349/403/440）。
诊断读取面：`buildDiagnostics`（diagnostics.mjs:205-241）读 `readLlmSettings`+envConfig 得 `configured`，
`getLlmUsage` 取进程内 token 累计（model.mjs:25-29、183-198）。

### 4.3 分层汇报（E2）
`POST /worker-reports`（reports.routes.mjs:28-48，仅 worker 会话）→ `submitWorkerReport`（reports.mjs:470-748）：
`validateReportShape`（:403-463）→ `requestDigest`（:472）→ **单个 runSerial 事务**内：项目存在 → submissions 幂等
（:478-490）→ attempt 存在/worker 归属（:491-505）→ replaces/base 存在（:506-519）→ boundary 上界（:520-530）→
important_findings 引用/类型/状态以库为准（:531-551）→ evidence_refs 存在（:552-558）→ `collectAttemptRecords`
（:235-312，窗口清单 + content_hash）→ `coverageGaps`（:360-399）→ INSERT worker_reports + 事件（:608-701）→
submissions 回执/result_hash（:702-745）。
读面 `GET /worker-reports/{id}`（reports.routes:49-102 鉴权 + layer/page/budget 校验）→ `readWorkerReport`
（reports.mjs:886-1037）：handoff_card 分组分页（:770-854）、key_records、full_basis（重算 manifest，:915-916）。

### 4.4 报告视图与导出（F1）
`GET /reports/vulnerabilities`（report-views.routes.mjs:64-79）→ `getVulnerabilityReportView`（reportgen.mjs:1124-1242）
→ `syncVulnerabilityReports`（:936-1046）：`readView` 一致读内构建全部漏洞内容+版本历史（:942-959）→ 逐漏洞指纹比对
（:963-975，一致即跳过）→ 写 `reports/vulnerabilities/<vid>/vN.json`（原子，:993-994）→ `runSerial` 插 report_revisions
（:1006-1028，UNIQUE 冲突时升版本重试 3 次）。列表再走游标分页（:1141-1210）。
`GET /reports/milestones`（:80-93）→ `getMilestoneReportView`（:1248-1292）→ 必要时 `generateMilestoneReport`
（:1054-1098：readView 内容 → 分配 MR 号 → 写 content.json → insertRevisionRow）。
`GET /reports/{id}/export`（report-export.routes.mjs:33-70）→ `readReportRevisionForExport`（:1302-1319）→
`renderReportMarkdown`（:1391-1428）。
派生资料边界：不发事件、不消耗业务 commit_seq、行 created_seq 取数据截止边界（:907-929）。

### 4.5 指标、诊断与 Outbox 消费
`GET /metrics`（metrics.routes.mjs:49-67）→ `collectMetrics`（metrics.mjs:429-464）：十块只读 SQL + 磁盘核对
（evidence_store 经 A2 `findStorageAnomalies`，:389-420）。
`GET /diagnostics`（diagnostics.routes.mjs:14-29）→ `buildDiagnostics`（diagnostics.mjs:205-241）：
health 块（:44-63）+ 单项目块（:65-202，计划/意图/租约/验证/汇报/消息/outbox/投影/证据）。
运行时消费：每轮首次 `bootstrapOutbox`（runtime.mjs:285-293）→ 处理后 `consumeOutbox`（:457-471）写 applied 回执并置 sent。
layout 物化：capture 登记事务后调用 `materializeAssetEntry`（evidence.mjs:715-731，失败仅告警不回滚已提交事实）。

## 5. 关键不变量、并发/事务/幂等/错误处理

1. **事务边界**：messages 的单条写链路在一个 `runSerial` 内（messages.mjs:243-303）；决定闭环的写点在 E1 事务内调用、
   不另开事务（messages.mjs:370-416 头注释）；E2 提交把清单/覆盖检查/落库/事件/幂等回执放在同一 `runSerial`
   （reports.mjs:474-747）；reportgen 用显式 `readView`（BEGIN/COMMIT，:85-99）+ 文件先行 + `runSerial` 落行
   （§13 同法）。`runSerial` 事务体必须同步（db.mjs:63-81）。
2. **幂等键**：E2 = `(project_id, submitter_id, submission_id)` + 请求摘要 → 原回执 / `IDEMPOTENCY_KEY_REUSED`
   （reports.mjs:478-490，submissions 复合主键见 0002 迁移）；报告版本 = UNIQUE 槽 + 3 次升号重试
   （reportgen.mjs:980-1033）；消息通道无提交幂等键（每次 POST 产生新消息，语义上正确）。
3. **提交序/水位**：项目 `next_commit_seq` 事务内分配（reports.mjs:150-154、messages.mjs:78-82、reportgen.mjs:102-120）；
   outbox 唯一键 `(project_id, commit_seq, event_index)`（0001:498），event_index 用同事务 `COUNT(*)+1`（messages.mjs:87-99）
   或固定 1（reports.mjs:674-677）。
4. **只读面**：metrics/diagnostics 不写库不发事件（metrics.mjs:34-35、diagnostics.mjs:23-28）；reportgen 的写仅限
   派生资料（report_revisions + reports/ 文件），不改业务对象状态（reportgen.mjs:22-33）。
5. **文件/库顺序**：先原子写文件再落行（layout.mjs:121-125、reportgen.mjs:126-130），行不引用未固定文件；漏洞报告
   失败留下的同号文件由下次同步覆盖回收，里程碑目录不回收（reportgen.mjs:1075-1096，见 P2-10）。
6. **分页/游标**：`<created_seq>:<id>` 不透明游标 + `has_more`/`next_cursor`（messages.mjs:322-343、
   reportgen.mjs:1141-1210）；消息查询的排序与续读谓词在 id 平局时方向不一致（messages.mjs:327-333，P2-4）；
   两处均无 `CURSOR_EXPIRED`（该码目前无产生方）。
7. **归属/授权**：路由层做会话项目域校验（messages.routes:31-44、report-views:23-39、metrics.routes:36-45、
   diagnostics.routes:22-28、reports.routes:53-76）；存储层仅做「项目存在」校验，`readWorkerReport` 自身不做项目/角色
   校验（reports.mjs:886-892，P2-16）。
8. **错误映射**：`ApiError` 按注册表状态码返回，其它异常统一 500 `INTERNAL_ERROR`（router.mjs:112-123）——
   因此未对可选字段做防御会变成 500（见 P1-1）。
9. **保密**：响应面 `sanitizedView` 永不含明文 key（llm-settings.mjs:144-174），但落盘文件为明文且未收紧权限（P1-5）。


## 6. 与文档/设计基线的对应与偏差

> 注：`docs/BLUEPRINT.md` 只有 §1–§14；代码注释中引用的 `§15.x/§16.x` 指向设计规范
> 《持续探索型渗透测试 Agent 系统-工程设计规范》的 §15（Map 投影/订阅）与 §16（AI 规划/协调/长期探索）。
> 本层直接对应规范 §14.2/§14.3（Outbox/回执）、§16.1（唤醒）、§16.4（等待）、§19（报告）、§20.2（指标）、§5.2（布局）。

- **BLUEPRINT §4 DDL**：本层用到 `messages`/`message_links`（0005）、`worker_reports`、`report_revisions`、
  `outbox`、`consumer_receipts`、`submissions`、`snapshots`、`projects`、`id_sequences`，均无新增列/迁移。
  两处形态偏差已登记：E2 汇报 `delivery_status` 写 `pending` 而 DDL 默认 `delivered`（reports.mjs:647、E2.md 偏差 7）；
  `report_revisions.data_boundary` 声明为 TEXT 默认 ''，实际存 JSON 对象字符串（reportgen.mjs:923-927，读面 parseJson）。
- **BLUEPRINT §2.3 迁移纪律 / §2.8**：蓝图原计划 `0005-llm-settings`（表）+ `0006-messages`；实现改为 llm.json 文件 +
  messages 占 0005（0005-messages.mjs:14-17 头注释、ui-M2.md 偏差 1）。本层 llm-settings.mjs 的存储决策与该偏差一致。
- **BLUEPRINT §5 端点注册表**：本层负责/参与的 #3、#37-#41、#46/#47/#47b、#49、#50-#53 全部实装，路由文件内无 `stub()`。
  路径偏差按 ui-M2.md §6 登记（#50/#51/#52 双路径别名；#46/#47 施工要点路径为主 + 蓝图 `projects/{id}/messages` 别名）。
- **BLUEPRINT §6 事件目录**：本层写 `worker_report.submitted`（reports.mjs:669-701）、`message.received`、
  `message.handled`（messages.mjs:280-296/401-414）；后两者为 M2 新增、蓝图 §6 目录未列（ui-M2.md 已登记）。
  reportgen 不发事件（目录无 report.*，F1.md 偏差 2 已登记）。`resource_state.changed` 由 runtime 复用（不在本层文件内）。
- **规范 §14.2/§14.3（至少一次、delivered≠applied、游标）**：outbox-consumer 实现「bootstrap 置 skipped、增量写
  applied 并置 sent」，但把「本轮扫描到的全部事件」记为 applied，且运行时只把少数事件送入模型（见 P1-3）——与
  §14.3「投递确认与业务处理确认分开保存…未保存对应结果前不能记为 applied」张力明显；E2 的 delivered≠handled 纪律
  （reports.mjs:14-16、messages.mjs:5-8）则落实到位（handling_status 只由 E1 决定事务后置 handled）。
- **规范 §16.1/§16.4（唤醒与等待）**：runtime 把待处理用户消息纳入唤醒（runtime.mjs:75-100），messages 契约一致；
  但「未处理汇报」信号未排除 C2 进展行，与 F2 的等待判定口径不一致（P1-4）。
- **规范 §19（报告）**：suspected 起草稿、版本同步、历史保留、阶段报告五块 + 覆盖度、四向追溯、生成后探索继续
  均有代码与用例支撑（reportgen.mjs:507-598/720-885、test/reports.test.mjs）；偏差见 F1.md 偏差 1-3。
- **规范 §20.2（指标）**：十类指标逐条落地并附口径 note（metrics.mjs:3-35）；保存延迟被拆成三个可核对分量
  （F2.md 偏差 3 已登记）。「冲突类型/受阻恢复率」等口径为库内事实，无虚构。
- **规范 §5.2（目录布局）**：layout.mjs 是唯一实现且行为符合「程序生成文件名/路径穿越处理/冲突消歧/sidecar 标采集编号/
  逻辑路径不承担证据身份」（:10-17、:175-266）。偏差：演练报告写在 `<dataDir>/work/`（P2-20）；`blobPath` 未做 sha256
  形态校验（P2-23）。
- **模块竣工记录 vs 代码**：E2.md §2 自称「§18.4 七类必须保留内容…全部承载」——handoff_card 分组（reports.mjs:770-823）
  只含 material_conditions/contradictions/significant_attempts/unresolved_questions/blockers/decisions_needed，
  `prerequisite_changes` 仅出现在 key_records（:983），交接卡层缺失（P2-25）。F2.md §2 指标表与代码一致；
  ui-M2.md 的消息词表/路径偏差与代码一致。


## 7. 问题清单

> 分级：P0 阻断（数据损坏/安全绕过/核心链路不可用）；P1 重要（语义违规、可绕过的不变量、可观测性失真、
> 明确可触发的错误码错配）；P2 次要（死代码、口径/形状不一致、潜在脆弱点、性能与运维风险）。均为静态阅读结论，
> 附 file:line 依据；未运行测试验证。

### P0
- 无。本层未发现会直接损坏数据或使核心链路不可用的缺陷。

### P1
1. **[bug] reports.mjs:532 —— 缺省 `important_findings` 触发 500 而非 400**
   现象：`submitWorkerReport` 直接 `for (const f of body.important_findings)`；`validateReportShape`（:430-443）
   仅对数组字段做 `asArray` 校验且不赋值/不要求必填，字段缺省时此处抛 `TypeError: not iterable`。
   依据：router.mjs:112-123 把非 ApiError 映射为 500 INTERNAL_ERROR；契约要求「字段必须是数组」应为 BAD_REQUEST。
   影响：worker 第一次漏写该字段即 500（无 next_requirements），且 500 message 泄露 JS 异常文本。
   建议：`(body.important_findings || [])` 或在校验阶段声明必填（§18.3 合同字段）。
   测试缺口：worker-reports.test.mjs:205-220 的 `reportBody` 恒带 `important_findings: []`，无用例。
2. **[risk/不变量] reports.mjs:520-530 + :235-270 —— source_commit_boundary 只校验上界，可置 0 使覆盖检查形同虚设**
   现象：仅拒绝 `boundary > latest`；`collectAttemptRecords` 的窗口是 `(max(attempt.created_seq, lo), boundary]`，
   声明 `source_commit_boundary: 0`（或任何小于 attempt 起点的值）时 tool_calls/judgement 窗口为空 →
   `coverageGaps` 无缺口 → 汇报通过（仅回执附 warning `newer_records_since_boundary`，:584-606）。
   依据：§18.4「程序根据 source_manifest 检查…未覆盖项退回」，场景 26 的保障被「自行声明极早边界」绕过。
   建议：增加下界校验（`boundary >= attempt.created_seq`，或与`attempts`起点的 commit_seq 比较），或对
   `boundary < attempt.created_seq` 明确回退。测试缺口：worker-reports.test.mjs:725-759 的「老 boundary」用例
   声明的是「发现提交之前」的值，且用 omitted_sections 兜底，无法区分窗口是否为空。
3. **[不一致] outbox-consumer.mjs:39-52 + runtime.mjs:457-471 —— 扫描即 applied，且回执边界语义过弱**
   现象：`consumeOutbox` 对 `(from, through]` 的**全部** outbox 行写 `receipt_kind='applied'` 并把 pending 置 sent；
   而运行时本轮只把部分事件（如变化页 10 条，orchestrator.mjs:81）送进模型，其余仅被扫过。
   `boundary` 只存 `log:<commit>:<index>` 字符串，不记录覆盖集合/连续消费边界。
   依据：规范 §14.3「投递确认与业务处理确认分开保存…模型未保存对应结果或明确暂缓处理记录前，不能记为 applied」；
   本模块头注释（:1-11）自身也把「扫描」当作已处理。
   建议：扫描级回执记 `delivered`，applied 仅在对应语义结果落库后写；或至少把 scanned/marked_sent 与 applied 分离，
   在回执 boundary 中写入覆盖区间。影响：`consumer_receipts` 无法作为「哪些事件真的被处理」的证据。
4. **[不一致] diagnostics.mjs:129-133 / runtime.mjs:69-71 vs recovery.mjs:316-323 —— 未处理汇报三套口径**
   现象：C2 进展行写入 `worker_reports` 时 `handling_status='pending'`（attempts.mjs:996-1031），且除 E1 对具体汇报
   调 `handle_report` 外无处置路径（orchestrator.mjs:722、:2194 仅按 id 更新）。diagnostics 与 runtime 用
   `handling_status='pending'` 全量计数（含进展行），recovery 显式排除 `content.source='attempt_progress'`。
   影响：`#49 reports.unhandled_worker_reports` 与 F2 等待判定/P1 面板口径不一致；每写一条进展即抬高 runtime 的
   `pending_reports` 唤醒信号（runtime.mjs:69-71、:312-325），进展行永不被 handle → 该信号长期非零。
   建议：统一为「分层汇报」口径（content.source='layered_report'）或让 C2 进展行使用独立 handling 语义。
5. **[风险/保密] llm-settings.mjs:135-139 —— API key 明文落盘、权限未收紧、默认数据目录未忽略**
   现象：`mkdirSync` + `writeFileSync`（经 rename）无 chmod，实测工作区 `sorne-data/llm.json` 为 `-rw-r--r--`（0644）
   且含明文 key；`.gitignore` 只含 node_modules/*.log/.DS_Store，未排除 `sorne-data/`；默认数据根为
   `~/.sorne`（index.js:31-34）同样是明文。蓝图 §10-4 只冻结「响应永不回显明文 key」，落盘保密无约束。
   建议：写文件时 `chmod 0600`（并修正已有文件权限），文档登记「本地明文存储」边界，仓库忽略示例数据目录。


### P2
1. **[死代码] reportgen.mjs:138-146** `latestRevisionRow` 全仓无调用者（grep 仅定义处）；与 `revisionHistoryRows` 的排序假设相同（见 P2-3）。
2. **[死代码] reports.mjs:78-85 REF_TABLES、:95 MAX_HANDOFF_PAGES** 均无使用（后者原用于防极端分页循环，实际上限在路由 :86-88）；
   **messages.mjs:26 MESSAGE_STATUSES** 无引用；**reports.mjs:856 `boundaryView(db, projectId, row, manifest)` 的 manifest 参数未使用**（调用处 :969/:989/:1032 仍传值）。
3. **[潜在 bug] reportgen.mjs:143/153 —— `CAST(version AS INTEGER)` 对 'vN' 恒为 0**
   已用 node:sqlite 内存库验证：`CAST('v1'/'v2'/'v10' AS INTEGER)` 全部为 0，故 `ORDER BY CAST(version AS INTEGER)`
   实际退化为 rowid 序。当前版本行按号递增插入，故「最后一行 = 最新版本」成立（:1217/:1267 依赖此隐式契约）；
   一旦出现乱序插入（并发重试、迁移回填）即取错 current 版本。建议改 `CAST(substr(version,2) AS INTEGER)` 或存整数列。
4. **[潜在 bug] messages.mjs:327-333 —— 排序与续读谓词方向不一致**
   `ORDER BY created_seq DESC, id`（同 seq 内 id 升序）配合 `(created_seq < ? OR (created_seq = ? AND id < ?))`（按降序设想）。
   当前每条消息独占 commit_seq，平局不可达；若未来同 commit_seq 多消息，续读会漏行。改为 `id >` 或排序加 `id DESC`。
5. **[潜在 bug] reportgen.mjs:915-916 + :1001-1004 —— full_basis 的 `newer_records_since_boundary` 恒为 0**
   `fresh` 用与清单相同的 boundary 重算（:918），总数与 `manifestStored.counts.total` 相等（base 汇报时更小），
   `max(0, diff)` 恒 0；字段永远显示「边界后无新记录」，与提交回执里同名字段（真实增量）语义不同。
6. **[不一致] diagnostics.mjs:44-63 vs health.routes.mjs:18-42 —— 宣称「同构」的 health 块缺字段**
   诊断块无 `version`（health 返回 `pctx.version`），outbox 计数写法也不同（health 直接 `outbox[r.s]=c`，诊断加 `r.s in outbox` 守卫）。
   页面若按 #3 形状消费需容忍缺失；建议抽公共 healthBlock。
7. **[风险] metrics.mjs:429-436 + 各块早退 —— 指定不存在项目返回 200 空摘要且形状缩水**
   `projectId` 不校验存在性（对比 messages.mjs:310-312 NOT_FOUND、diagnostics.mjs:228-233 NOT_FOUND）；
   `projectIds.length===0` 时 `projection_lag`（:172-173）无 `high_watermark`、`conflicts`（:326）无 `note`、
   `unconsumed_findings`（:205-207）无 `boundary_kind`、`duplicate_intents`/`repeated_execution`/`verification_queue`/
   `blocked_recovery` 同样丢 note → 同一端点两种响应形状。
8. **[口径 bug] metrics.mjs:170-232 —— 全项目模式混算项目级 commit_seq**
   `projection_lag` 用全局 `MAX(commit_seq)` 作为高水位去减各 kind 快照的 `snapshot_commit_seq`；
   `unconsumed_findings` 用全局 `MAX(snapshot_commit_seq)` 当边界。二者都是项目级序列，未指定 `project_id` 时
   得到的 lag/未消费数不可解释。建议全项目模式逐项目计算或明确标注「不聚合」。
9. **[风险/性能] metrics.mjs:389-420 + diagnostics.mjs:172-180 —— 每次请求全量读盘哈希**
   `findStorageAnomalies`（evidence.mjs:460-484）遍历 blobs 表并逐个 `readFile+sha256`，O(证据总字节)；
   `/metrics`、`/diagnostics` 每次调用都执行（且 diagnostics 在单项目面每次都做）。证据量增大后页面轮询会拖住事件循环
   （同步 SQLite 读之外的异步读盘），建议加缓存/TTL 或按需开关。
10. **[不一致] reportgen.mjs:1054-1098 —— 阶段报告生成无版本槽重试，失败留不可回收孤立文件**
    `versionNum` 在事务外计算（:1063-1065），并发两次 refresh 可能撞 UNIQUE 直接抛错（500）；对比
    `syncVulnerabilityReports` 有 3 次升号重试（:980-1033）。且文件路径含新分配的 MR 号（:1076-1082），
    入库失败后该目录不会被后续同号覆盖（漏洞报告按 vid 路径可回收，:984）。
11. **[死状态] outbox `delivery_status='failed'` 与 messages `status='failed'` 无写入方**
    outbox 仅 changes.mjs:933 置 sent、outbox-consumer 置 skipped/sent；failed 只被读取（recovery.mjs:459、metrics.mjs:143-149）
    → 指标恒 0。messages 的 failed（0005 CHECK）只在词表出现（messages.mjs:26/459），无写入路径，
    「处理失败」只能表现为长期 processing。
12. **[风险] sessions.mjs:66-76/102-111 —— 过期会话惰性清理，注册表可无界增长**
    过期项仅在 `resolveSession` 或 `activeSessionCount`（health/diagnostics 调用）时删除；四角色循环每次 run 都
    `issueSession(ttl 30min)`（agents/orchestrator.mjs:79、planner.mjs:144、verifier.mjs:53、worker.mjs:489/493）且从不 revoke；
    无 UI 轮询的常驻进程里 Map 只会增长（TTL 只阻止解析，不释放内存）。建议定时清扫或运行结束 revoke。
13. **[风险] llm-settings.mjs:32-36 —— maskApiKey 短 key 暴露过多**
    `length <= 8` 才全掩码；9 字符 key 会显示「前 3 + 后 4」共 7 字符（注释称「短 key 全掩码」）。建议阈值提到 ≥12 或按长度分层。
14. **[不一致] llm-settings.mjs:120-133/144-174 —— 无法通过 API 清除配置；note/anthropicBaseUrl 只写不读**
    写入强制 `baseUrl` + `model`，无清除/停用语义（只能删文件，且 UI 无入口）；`note` 持久化后 `sanitizedView` 不回显，
    `anthropicBaseUrl` 仅在 normalize/merge 存在、无任何消费者（model.mjs 只用 baseUrl/apiKey/model）。
15. **[风险] llm.routes.mjs:45-63 + llm-settings.mjs:205-223 —— 连接测试对显式 baseUrl 无 scheme/host 校验**
    写入路径校验 http(s)（:114），测试端点直接用请求体 baseUrl 发 fetch（仅信任边界为回环），可当任意 URL 探针；
    返回体截断 400 字符但可能回显目标端内容。建议复用同一 URL 校验。
16. **[不一致] reports.mjs:886-1037 —— 存储级读取入口不做归属校验**
    `readWorkerReport` 只按 id 读取（:889），项目域校验全在路由（reports.routes.mjs:53-76）；同文件其它公共入口
    （submitWorkerReport/getVulnerabilityReportView 等）都在存储层校验项目存在/归属。跨模块复用（F2/E1/UI）时易漏鉴权。
17. **[不一致] messages.mjs:354-357 —— 回复查询未按项目域限定**
    `SELECT * FROM messages WHERE reply_to = ?` 无 `project_id` 条件；当前消息 ID 内嵌项目（MSG-<PRJ>-nnnn）不串项目，
    但违背「所有读写按项目域」的统一口径，建议补 `AND project_id = ?`。
18. **[不一致] reports.mjs:210-216 vs :1019-1027 —— sha256 证据引用的提交面与读面不一致**
    `refExists` 要求 `RECORD_ID_RE`（B-/CAP- 等编号），64 位哈希会被 INVALID_REFERENCE 拒绝；
    full_basis 渲染却为 `/^[a-f0-9]{64}$/` 生成 /evidence/blobs 读取入口。若契约只允许编号，应删掉读面分支；
    若要支持哈希，提交面应放宽（messages 附件已支持 sha256，可参照）。
19. **[风险/性能] reportgen.mjs:1124-1242 —— 列表 GET 惰性同步全部漏洞**
    列表请求对**全部**漏洞执行 sync（:1139 传 `onlySubjectId: null`），逐条读盘指纹比对、必要时写文件+落行；
    漏洞规模大时单次读放大为 O(N) 文件 I/O 与可能的多写。分页只作用于呈现（注释已声明），建议改为按页/定时同步。
20. **[风险/布局] metrics.mjs:466-469 —— 演练报告路径偏离 §5.2 项目树**
    写 `<dataDir>/work/recovery/drills/<stamp>.json`，而 §5.2 的 `work/` 是 `<dataDir>/projects/<id>/work/`；
    文件名不含项目号，同毫秒两项目演练会互相覆盖（recovery.mjs:651-657 直接覆盖写）。建议加项目号并归入项目树。
21. **[潜在约束] reportgen.mjs:85-99 —— readView 直接对共享连接 exec BEGIN/COMMIT**
    未走 `runSerial` 队列；若将来在 runSerial 事务体内调用会「cannot start a transaction within a transaction」。
    当前调用点（sync/generate/view）均在事务外，属隐式调用约束，建议注释固化或提供只读快照 API。
22. **[风险] layout.mjs:71-73 —— blobPath 不校验 sha256 形态**
    `join(blobsRoot, sha.slice(0,2), sha)`：若传入含 `../` 的字符串会越界（当前唯一调用方 evidence.mjs 用服务端计算的哈希，
    不可达）；与 `safeSegment` 的穿越防护不一致，建议断言 `/^[0-9a-f]{64}$/`。
23. **[风险] layout.mjs:144-151 hostSegment 无哈希消歧**
    非法字符被替换为 `_`，形如 `a:b` 与 `a_b` 的主机会落入同一目录（仅影响人读视图，事实与 sidecar 不受影响）；
    assets 视图可重建，优先级低。
24. **[不一致/文档] E2.md §2 自称 §18.4 七类内容「全部承载」**
    handoff_card 分组（reports.mjs:770-823）没有 `prerequisite_changes` 分组（仅 key_records :983 有），交接卡层缺失该字段；
    建议补组或在文档改为「跨层承载」。
25. **[不一致/文档] E2.md:21 声称与 C2 进展行「共享同项目 worker_report 序列」**
    reports.mjs:610 用项目作用域 `id_sequences(project_id,'worker_report')` 生成 `WR-<PRJ>-NNNN`；
    C2 用 `_global` 作用域（attempts.mjs:996，GLOBAL_SEQ_SCOPE）生成 `WR-NNNN`。两者序列行不同、仅因编号形态不同而不撞主键；
    「共享序列」的说法不成立（编号唯一性不受影响）。
26. **[风险] messages.mjs:238-304 —— 无「消息永不被处理」的出口**
    stopped 项目仍可持久化消息（符合规范），但状态只会停在 received/processing（status 'failed' 无写入方）；
    diagnostics/runtime 会把它计入 pending_user（messages.mjs:439-443、runtime.mjs:76）。
    建议提供「取消/过期」路径或在停止项目时明确标注消息不再处理。


## 8. 测试覆盖映射

| 被测行为 | 测试 | 覆盖情况 |
|---|---|---|
| 消息闭环（received→handled+AI 回复+links） | test/messages.test.mjs:72-144 | 完整（真实 runtime + 脚本模型） |
| 附件（blob 经 read_blob 真读字节、坏附件整条拒绝） | messages.test.mjs:146-213 | 完整；上限 16 项/256 字符边界未测 |
| 用户消息唤醒（waiting_for_change→active + 事件） | messages.test.mjs:215-262 | 完整 |
| 消息列表游标/校验（content 限长、refs、翻页） | messages.test.mjs:264-296 | 主路径覆盖；id 平局续读（P2-4）未测 |
| 会话签发/过期/角色 | test/submissions.test.mjs:262-291；recovery/attempts/changes/e2e 各自 revoke | 过期与越权有覆盖；**无 sessions 专属用例**：`revokeSessionsForProject`、`sessionFromRequest` 数组头、ttl 边界（=0/负值）无测试 |
| 分层汇报 26/27/28/31 场景与幂等/事件/时序/重启/鉴权 | test/worker-reports.test.mjs（20 用例） | 场景覆盖充分；**缺**：important_findings 缺省（P1-1）、boundary=0 绕过（P1-2）、sha256 evidence_refs（P2-18）、page 越界（paginate 静默夹取，reports.mjs:842） |
| 报告版本（起草/确认/排除/争议/无关提交不增殖/游标/覆盖度/四向追溯/跨项目/原子性/重启） | test/reports.test.mjs（18 用例） | 覆盖度高；**缺**：并发 sync 版本槽（P2-10 的 vuln 分支已测重试，milestone 分支未测）、版本乱序（P2-3）、内容文件缺失的 milestone 读取、内联折叠上限（64/100） |
| 报告导出（字节一致/下载头/历史/404/缺文件） | test/report-export.test.mjs:41-116 | 完整（2 用例） |
| 诊断聚合（全局/单项目/404/unknown 置顶/null≠0） | test/diagnostics.test.mjs:49-162 | 覆盖 #49；**缺**：与 /health 形状同构（P2-6）、`configured` 的 per_role 边界 |
| 指标全集与访问面 | test/recovery.test.mjs:210-303 | 十类指标真实数据核对 + 访问面 403；**缺**：不存在项目（P2-7）、全项目聚合口径（P2-8）、failed 计数（P2-11）、读盘开销无断言 |
| LLM 设置（写入/脱敏/别名/清除 key/连接测试/provider 顺序/热加载） | test/llm-settings.test.mjs（4 用例） | 主链路完整；**缺**：并发写队列（llm-settings.mjs:92-104）、损坏文件容错、无法清除配置（P2-14）、maskApiKey 短 key、文件权限（P1-5） |
| Outbox 消费（bootstrap/增量/幂等） | test/outbox-consumer.test.mjs:17-60 | 单用例覆盖三态；**缺**：扫描≠applied 的语义断言（P1-3）、非法参数校验（:30-32） |
| layout（assets/ 穿越与消歧、work 工作区） | test/evidence.test.mjs:662-780；reports.test.mjs:36 | 核心行为覆盖；**缺**：`rebuildAssetEntries`、`ensureProjectTree`、`hostSegment` 碰撞、`blobPath` 越界（P2-22/23） |
| 页面消费（报告/诊断/工作台/引导页） | test/ui-reports / ui-diagnostics / ui-workbench / ui-onboarding | 只验证 HTTP 契约消费，不覆盖存储层不变量 |

未覆盖但风险较高的行为（建议补测）：P1-1、P1-2、P1-3、P1-4（三处计数口径差异）、P2-8（全项目指标）、
P2-12（会话注册表增长）。

## 9. 不确定点与需 Lead 交叉确认

1. **boundary 下界（P1-2）**：规范只要求 `source_commit_boundary` 用于「判定时效性」，未明说下界。
   我按「覆盖检查可被自行声明的极早边界绕过」记 P1；若评审认为 worker 端点属受信角色、且 §18.3 允许
   任意历史边界，则降为 P2。请确认是否要求 `boundary >= attempt.created_seq`。
2. **applied 回执语义（P1-3）**：`consumeOutbox` 的写法是否是有意的「批量处理回执」？§14.3 允许「一批事件共享一次业务
   处理回执」但要求列明覆盖集合与连续消费边界；当前只存单条 `log:<commit>:<index>` 字符串。请确认是否需扩展
   `boundary` 结构（会改 outbox-consumer 与 consumer_receipts 语义，涉及 B2）。
3. **C2 进展行与分层汇报共存（P1-4）**：C2 进展行是否应继续以 `worker_reports` 行 + `handling_status='pending'` 表达？
   若保留，需要统一 diagnostics/runtime/recovery 的「未处理汇报」口径（或给进展行单独的 handling 词表）。
4. **llm.json 落盘保密（P1-5）**：仓库内 `sorne-data/llm.json` 含明文 key（本次未打印内容）；是否需要
   （a）代码 chmod 0600 + （b）`.gitignore` 排除数据目录 + （c）文档标注本地明文边界？属安全策略，需 Lead 决策。
5. **存储级导出的鉴权层（P2-16）**：`readWorkerReport` 不做项目校验，是否按项目既有约定「鉴权只在路由层」？
   若是，建议在函数头注释显式声明；若否，需补校验。
6. **报告 current 版本的隐式契约（P2-3）**：`history[history.length-1]` 当 current 依赖 rowid 与版本号同序；
   是否接受该隐式假设（测试钉死 v1→v2→v3 顺序，未覆盖乱序）。
7. **指标/诊断的全量读盘（P2-9）**：是否接受 `/metrics`、`/diagnostics` 每次请求 O(证据字节) 的开销？
   若 UI 高频轮询（诊断页 10s 自动刷新，见 ui-diagnostics 用例），真实大证据库下需缓存或降级策略。
8. **与 BLUEPRINT §15/§16 的对照范围**：`docs/BLUEPRINT.md` 仅到 §14；本报告按代码注释把 §15/§16 解释为
   设计规范的 §15（投影/订阅，归 B1/B2）与 §16（规划/协调/唤醒，归 E1/runtime）。本层只消费 `snapshots`
   （metrics 投影滞后、diagnostics 投影块）与写入唤醒信号，若 Lead 需要的是蓝图 §15/§16 的其它章节，请指示。

