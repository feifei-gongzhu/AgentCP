# 03 精读报告：store-evidence（证据与判断层）

> 范围：A2 证据存储（evidence）、D1 验证服务（verification）、D2 判断/状态机与去重（judgements、dedup）、B2 变化页与订阅（changes）。
> 方法：分配文件逐行通读（分段 read），按「入口 → 校验/授权 → 事务/持久化 → 事件 → 返回」追踪；对照 docs/BLUEPRINT.md、docs/modules/{A2,D1,D2,B2}.md、设计基线第九/十/十二章。
> 只读源码，未修改任何源码与测试，未运行 npm test。

## 1. 范围与文件清单

| 文件 | 行数 | 一句话职责 |
|---|---|---|
| lib/store/evidence.mjs | 1048 | §13 写入编排（staging→SHA-256→固定→库事务→回执）、Blob 去重/完整性、Capture/transforms/EvidenceAnchor、孤立 Blob 盘点 |
| lib/store/verification.mjs | 1339 | §8.3 验证任务与结果、§12.1 不可变 Manifest、§12.2 核心事务（版本校验→保存→条件应用）、§8.2 准入、#29 队列视图 |
| lib/store/judgements.mjs | 888 | §8.4 唯一状态机 applyStateTransition、§8.1 Fact 准入、§8.2 requires 前提判定、#30 漏洞台账 |
| lib/store/changes.mjs | 1125 | §14.2/§14.3 变化页与回执（delivered≠applied）、§15.2 订阅边界冻结签名、§15.5 动态订阅/强制通知、只读 change-log |
| lib/store/dedup.mjs | 883 | §7.1 版本化规范化、§7.2 模板推导/确认/拆分/撤回、§7.3 候选组归并与拆分（全部经 A1 提交操作注册） |

辅助交叉阅读（只读、非分配文件）：lib/db/migrations/0001-core-schema.mjs（冻结 DDL 约束）、lib/store/record-service.mjs（runSerial/操作注册表/getStore/GLOBAL_SEQ_SCOPE）、lib/store/records-read.mjs（locateRecord 前缀表）、lib/store/layout.mjs（目录与 Blob 路径）、lib/errors.mjs（ApiError/错误码）、lib/routes/{evidence,verification,changes,judgements}.routes.mjs、test/{evidence,verification,judgements,changes,change-log,cursor,multi-project}.test.mjs。

## 2. 模块职责与关键导出（逐文件）

**evidence.mjs**：常量 REPRESENTATIONS/SOURCE_KINDS/INTEGRITY_STATUS（31-41）；`getStore/closeAllStores`（86-112，模块内按库路径记忆句柄）；`stageBytes/fixBlobFile/registerBlob/storeBlob`（197-377，§13 四步可分别复用）；`readBlobBytes`（399-424，逐次哈希核对）；`verifyBlobIntegrity/findStorageAnomalies`（428-484）；`registerCapture/getCaptureDetail`（544-779）；`registerTransform`（783-875）；`validateEvidenceAnchorShape/resolveEvidenceAnchor`（882-1033）；ID 生成 `blobIdFor/captureIdFor`（144-153）。

**verification.mjs**：常量与词表 VERIFIER_OUTCOMES/KINDS、JOB_STATUSES、JUDGEMENT_SUBJECT_TABLES、SUBJECT_KINDS 与物理表/语义类型互转（52-102）、DEFAULT_ADMITTED_STATUS（105-109）、TRANSITION_ACTIONS 路由表（119-133）；策略注册 `registerVerificationPolicy/listVerificationPolicies` + 模块内注册 DEFAULT_VERIFICATION_POLICY（149-206）；状态机装配 `__installStateTransitionForTests/stateTransitionSource`（226-249）；`generateEvidenceManifest`（379）；`requestVerification`（536）；`submitVerificationResult`（853）；`listVerificationJobs`（1258）；`evaluateAdmission`（1305）；`manifestIdFor/semanticSubjectKind/subjectTableOf/toSemanticSubjectKind`（83-102, 292）。

**judgements.mjs**：状态目录 VULNERABILITY/HYPOTHESIS/FACT 与 REVIEW_STATUSES（36-55）；TRANSITIONS 合同表（92-136，含 vr_outcome/overturn_guard/gate/invalidates/advance_epoch）；`applyStateTransition`（271-472，§2.7 冻结签名唯一实现）；`parseRequiresState/evaluatePrerequisite`（499-617）；`record_fact` 经 `registerSubmissionOps("D2/judgements")` 注册（716-725，roles:["verifier"]）；`listVulnerabilities`（753-854）。

**changes.mjs**：FORCED_EVENT_TYPES/CONSUMER_ROLES/页与扫描上限（42-70）；游标编解码 `encodeCursor/parseCursor/assertCursorFor`（97-149）；focus/relation_rules 规范化与 `_sorne_state` 内部状态（158-331）；`getSubscriptionView`（387）、`readChangeLog`（420）、`createSubscription/updateSubscription`（555/600）、`openSubscriptionBoundary`（656，§2.7 冻结签名）、`readChangesPage`（808）、`acknowledgeConsumption`（982）、`isForcedNotification`（152）。

**dedup.mjs**：CANONICALIZATION_VERSION/TEMPLATE_RULE_VERSION（32-35）；纯函数 `canonicalizeServiceIdentity`（50-92）、`canonicalizeHttpResource`（100-125）、`derivePathTemplate`（128-152）；内部 `insertRelationD2/ensureAsset`（197-264）；7 个提交操作 opRegisterServiceAsset/opRegisterHttpResource/opObserveResolution/opProposeEndpointTemplate/opReviseEndpointTemplate/opMergeCandidateGroup/opSplitCandidateGroup（268-859），registerSubmissionOps("D2/dedup")（875-883）。

## 3. 数据模型与持久化结构

无本层新增迁移（最新为 0011；D2 记录称 schema_version=3 为交付时快照）。全部落在 0001 冻结 DDL：

- blobs（0001:122-138）：UNIQUE(project_id, sha256) 内容寻址；storage_status CHECK(staged/fixed/orphan/lost)；representation 六值枚举。代码只写 'fixed'（evidence.mjs:290）与 'lost'（532），staged/orphan 为未使用枚举值。
- captures（0001:141-161）：UNIQUE(project_id, tool_call_id) 为幂等键；外键 response_body_blob→blobs；integrity_status 无 CHECK（代码插入即 'verified'，631）。
- transforms（0001:164-177）：UNIQUE(project_id, source_kind, source_id, transform_name, transform_version, parameters)，派生产物 derived_blob_id 外键；派生链按「源+变换+版本+参数」幂等（evidence.mjs:838-844）。
- evidence_manifests（0001:379-394）：UNIQUE(project_id, subject_id, evidence_revision, claim_revision, policy_version) 即不可变锚；members/conditions 为 JSON（含 withdrawn/disputed 全量）。
- verification_jobs（0001:397-420）：UNIQUE(project_id, dedup_key) 承担 §7.3 去重；expected_{state_version,evidence_revision,assessment_epoch} 为申请时快照；evidence_manifest_id 外键。
- verification_results（0001:423-447）：不可变结果行；applied 位后续置 1（verification.mjs:1127）；reviewed_manifest_id NOT NULL 外键。
- evidence_memberships（0001:450-463）：UNIQUE(project_id, subject_id, member_kind, member_id)；D1 只读消费（verification.mjs:388-394）。
- outbox（0001:482-499）：UNIQUE(project_id, commit_seq, event_index) 是事件序号唯一性的硬约束；delivery_status 全局而非按消费者。
- consumer_receipts（0001:504-512）：PK(consumer_id, subscription_revision, event_id)，receipt_kind delivered/applied 分存。
- subscriptions（0001:515-530）：无扫描区间/种子列 → changes.mjs 用 focus JSON 保留键 `_sorne_state`（72, 286-331）承载 boundary_seq/scan_from/scan_through/seeds/grown，对外视图剥离。
- 资产/模板/候选组：assets UNIQUE(project_id, asset_type, canonicalization_version, canonical_key)（0001:58-71）；resources UNIQUE(project_id, method, url_exact)（74-90）；endpoint_templates UNIQUE(project_id, method, service_asset_id, path_template)（93-108）；template_members UNIQUE(template_id, resource_id)（109-119）；memberships UNIQUE(group_id, member_id)（264-274）；relations 无通用去重键（277-296）。
- 文件布局：evidence/blobs/sha256/<ab>/<hash> 与 staging（layout.mjs:64-73）；stored_path 存相对数据根路径（98-100）；assets/ 逻辑入口与 sidecar（175-266）。

## 4. 主要调用链与数据流

**L1 证据上传（#11 POST /evidence/blobs）**：evidence.routes.mjs:29-49 rawBody 流式读取 → `storeBlob`（evidence.mjs:341）：参数校验（project/representation/source_kind，342-348）→ 项目存在性前置（350-353）→ `stageBytes`（197-216：随机名 staging + fsync + 内存算 SHA-256）→ 可选 expected_sha256 对照（355-365，不符删暂存并 BAD_REQUEST）→ `fixBlobFile`（220-252：目标已存在则读盘验哈希不覆盖；否则 mkdir+rename+目录 fsync）→ `registerBlob`（256-322，`runSerial`：UNIQUE(project,sha256) 命中即返回原回执+表示形式告警；未命中分配 commit_seq 与 `B-<PRJ>-NNNN` 后 INSERT 一行）→ 回执。跨模块边界：只依赖 layout（路径）与 db/errors；首步 DB 失败留下孤立文件（设计允许，13-14、findStorageAnomalies）。

**L2 采集登记（#12 POST /captures）**：evidence.routes.mjs:76-83（actor 取 x-sorne-actor）→ `registerCapture`（544）：字段/枚举校验（545-566）→ 三个 Blob 引用解析为行（`requireFixedBlob` 513-526，未 fixed 抛 EVIDENCE_NOT_COMMITTED）→ resource/attempt 外键存在性（576-583）→ `verifyBlobIntegrity` 真实读盘（586-593，失败 `markBlobLost` 并拒绝）→ `runSerial`（596-709）：按 (project,tool_call_id) 查重（同内容返回原回执、异内容 IDEMPOTENCY_KEY_REUSED）→ 分配 commit_seq/CAP 编号 → INSERT captures → 同事务 outbox `capture.completed`（event_index 0）→ 同 URL 前次采集比对，内容不同则 event_index 1 追加 `resource.content_changed`（672-699）→ 事务外尽力物化 assets/ 逻辑入口（716-731，失败仅告警）。

**L3 验证请求（#27）**：verification.routes.mjs:47-68（角色 worker/orchestrator/verifier；body 禁带 project_id）→ `requestVerification`（536）：策略注册检查（551）→ 条件快照归一（552/476-497，无条件时以条件摘要合成 `cond:<sha24>`）→ `runSerial`：`requireJudgementSubject`（332-350，locateRecord→判断类三表+读行）→ raw/opposing 证据引用校验（499-528，raw 必须 blobs/captures 且≥1）→ §7.3 去重键 sha256(canonicalJson{subject,condition,policy,version,evidence_revision})（571-579，命中返回原 job）→ `manifestInTransaction`（653-703，按当前 evidence_revision+claim_revision+policy_version 生成/幂等返回不可变 Manifest）→ 分配 commit_seq、INSERT verification_jobs（expected 三版本来自事务内 subject 行）→ 声明一致性告警（628-638：未声明反对证据但库内有 active contradicts 成员）→ 返回 jobView（705-762）。

**L4 验证结果（#28，§12.2 核心事务）**：verification.routes.mjs:70-91（仅 verifier 会话）→ `submitVerificationResult`（853）：形状校验（860-882）→ 计算内容摘要（resultDigest 774-796）→ 事务外解析状态机装配（890，动态 import judgements）→ `runSerial`（893）：job 存在/superseded 检查（895-907）→ 重读 subject 并做发现者自证检查（908-919）→ claim/策略/Manifest/reviewed_evidence_revision/expected 三版本逐项校验（920-953）→ 证据引用校验（954-955）→ 必需检查覆盖度（958-969）→ 传输级幂等（972-982，rowDigest 比对历史结果行）→ 分配 commit_seq/VR 编号 → 先 INSERT verification_results（applied=0，1009-1039，为 D2 回读结果行）→ 事务内读 subject 三版本并与 job.expected 比对（988-999）→ 分支 A 全匹配且必需检查通过：查 TRANSITION_ACTIONS 得 action，调用 `applyStateTransition`（1042-1068），out.downgraded→no_transition（捕获 D2 的 extra.detail.allowed_from），否则 applied=true 并把 D2 返回事件并入 sink → 分支 B 版本不匹配：decision=stale_evidence/claim_changed/stale_state，仅在证据基线/判断核心移动时置 review（1088-1113）→ 分支 C 匹配但必需检查失败：decision=checks_failed 并置 review（1114-1123）→ 置 applied、job.status=completed、state_version+1（1126-1132）→ 同事务 emit `verification.completed`（review_before/after、decision、applied）+ D2 事件，`flushEvents`（1134-1167）→ 事务提交后：版本竞争分支用错误信封（STALE_EVIDENCE/CLAIM_CHANGED/STALE_STATE）**带回执**抛出（1194-1215，§20.1）。

**L5 状态机（D2 唯一实现）**：`applyStateTransition`（judgements.mjs:271）：解析 action→TRANSITIONS 表（284-291）→ 应用型转换先回读 verification_result（295-323）：outcome 匹配、检查项（192-212）、发现者≠提交者（215-226）、审阅证据版本一致性；`assertExpectedMatch` 四版本（144-172，STALE_STATE/CLAIM_CHANGED/STALE_EVIDENCE）→ 起点状态与 overturn 守卫（329-340）→ 计算目标状态（mark_insufficient 三分流 346-360）→ UPDATE 状态/review/state_version/updated_seq/confirmed_version（379-415）→ 组装事件：requires 入边枚举（229-252）→ `dependency.changed`/`judgement.invalidated`/`vulnerability.state_changed`|`judgement.state_changed`（418-459），返回事件给调用方在同事务 flush（D1 1042-1086）。

**L6 变化页（#16）**：changes.routes.mjs:106-121 → `readChangesPage`（808）：`runSerial`（810）→ 订阅行/项目/消费者本人校验（811-817）→ 起始位置=显式游标（`assertCursorFor` 校验订阅归属、版本、保留底线 113-149）或 last_cursor（821-826）→ 循环按 500 一批扫描（849-899）：已 applied 跳过并计数、强制通知直接命中、event_types 过滤、`eventMatches`（775-797：关注集/邻接边/relation.added 扩展 grown）；批内两遍判定后按 (commit_seq,event_index) 归位；页上限截断时游标停在第 limit 个匹配事件，溢出留待下页（902-913）→ 同事务写 delivered 回执（INSERT OR IGNORE，931 redelivered=changes===0）+ outbox.delivery_status='sent'/attempts+1（932-935）→ 持久化 grown/scan_through（937-950）→ 返回 events/next_cursor/high_watermark/has_more/scanned。**L6' 只读 change-log**：`readChangeLog`（420-495）用 runSerial 只读扫描 outbox，不写回执、不动游标（422-424 注释、代码无 UPDATE）。

**L7 消费确认（#17）**：changes.routes.mjs:123-141 → `acknowledgeConsumption`（982）：仅 applied、需 boundary 或 event_ids（986-999）→ `runSerial`：订阅/消费者校验 → boundary 解析并校验「不越过 state.scan_through」（1013-1026）→ 覆盖集合=（边界内该消费者已投递回执）∪（显式 event_ids 且必须已投递，1027-1061）→ 幂等写 applied 回执（ON CONFLICT→applied，1086-1102）→ last_cursor 只前进不回退（1104-1110，仅在 boundary 提供时写）。

**L8 资产去重（提交信封内）**：submissions 引擎 `precheckOps`（record-service.mjs:824-838）按 op.roles 校验 → 操作上下文 ctx（305-336）→ dedup 操作：`ensureAsset`（237-264，INSERT OR IGNORE+查回，靠 UNIQUE 而非先查后插）→ resources / template → members；模板修订走 expected_state_version 乐观锁（539-549）；候选组归并建 memberships + duplicate_of/equivalent_to 关系并保留全部原节点（664-774）；拆分删除成员关系+撤回合并边（776-859）。

## 5. 关键不变量、并发/事务/幂等/错误处理

- **事务**：所有写都在 `runSerial`（lib/db.mjs:63-81，BEGIN IMMEDIATE，事务体同步）内；事件与业务行同事务（§2 约束 10）。evidence 模块持有独立句柄缓存（evidence.mjs:82-100），与 A1 storeCache 形成同进程两条队列，靠 BEGIN IMMEDIATE+busy_timeout 串行化（A2.md 偏差 4 已记；同步事务不 await，故不能真正交错）。
- **证据不可变**：目标路径已存在且哈希不符 → 拒绝覆盖（evidence.mjs:224-234）；读取每次都验哈希（416-422）；登记只 INSERT 不 UPDATE 内容（287-302）。未提交/未固定不可引用（requireFixedBlob 513-526、readBlobBytes 404-408）。
- **幂等键**：captures 用 (project, tool_call_id)（evidence.mjs:597-621，同 ID 异内容 IDEMPOTENCY_KEY_REUSED）；blobs 用内容哈希；transforms 用六元组（838-852）；verification_jobs 用 dedup_key（verification.mjs:571-589，键含 evidence_revision 使「续验」可开新 job）；verification_results 用内容摘要（972-982）；consumer_receipts 复合主键（changes.mjs:927-931、1096-1100）；assets/resources/templates 靠 DDL 唯一约束。
- **乐观锁/版本水位**：判断类三版本+assessment_epoch（judgements.mjs:144-172）；state_version 是行级版本（可变对象）；模板/候选组 expected_*（dedup.mjs:539-549、697-707、789-797）。注意：D1 直接写 review 不推进 state_version（见 P1-2）。manifest/job 的 expected 快照与 subject 现状比对决定 applied/stale 分支（verification.mjs:993-1002）。
- **去重键确定性**：canonicalJson 递归排序键（verification.mjs:258-263、changes.mjs:81-86）用于 dedup_key/manifest content_hash；但 evidence 的 transform 幂等键直接 JSON.stringify（836），键序敏感（P2-1）。
- **Outbox 唯一性**：UNIQUE(project_id, commit_seq, event_index)；A2 用 0/1（evidence.mjs:654/685），D1 用 1..n（flushEvents 308-329，event_id 前缀 evt-d1-），A1/操作层用 EVT- 前缀（record-service.mjs:250-253）；每个 commit_seq 只由单一生产者写入，因此不撞唯一键。
- **游标分页**：verification_jobs / vulnerabilities / change-log 用 (created_seq, id) 或 (commit_seq, event_index) 稳定二元组；changes 用不透明 token 内嵌订阅号+版本，版本不匹配→CURSOR_EXPIRED（changes.mjs:121-147）。
- **错误码映射**：BAD_REQUEST（形状）、INVALID_REFERENCE（跨项目/不存在）、EVIDENCE_NOT_COMMITTED（未固定/lost）、IDEMPOTENCY_KEY_REUSED、STALE_STATE/STALE_EVIDENCE/CLAIM_CHANGED、PRECONDITION_INVALID、CURSOR_EXPIRED、RESOURCE_LIMIT、TRUST_DENIED（403，授权类复用，§20.1 无授权码）；存储故障映射 INTERNAL_ERROR(retryable=true)（evidence.mjs:63-70）。
- **错误信封不掩盖已提交**：版本竞争分支事务已提交后用错误 + receipt 返回（verification.mjs:1194-1215）。


## 6. 与文档/设计基线的对应与偏差

- 设计基线**第九章（原始证据/观察/解释/漏洞）**：内容哈希存储与历史绑定（evidence.mjs:220-252、resolveEvidenceAnchor 938-1033 强制 blob_hash+representation+transform 绑定）、派生不覆盖原始（representation='derived'、transforms 链）、矛盾证据分别保留（evidence_memberships 全量入 Manifest，verification.mjs:388-394）、去重不抹去身份（captures 多次采集、merge 只加关系不删节点）——**落实**。偏差：派生链在 derived_bytes 分支可指向非 derived Blob（P1-3）。
- 设计基线**第十章（有范围的工作记录与覆盖）**：本层不设「已分析」全局标签，覆盖/读取范围由独立模块（reading/coverage）承担；本层仅以 evidence_memberships/Manifest/检查项表达「审阅了什么」——**一致**，无本层偏差。
- 设计基线**第十二章（变化处理与提前行动）**：「新产物保存后立即可查询」「判断修正后依据关系找受影响任务并通知」→ Outbox+变化页+依赖事件。落实点：changes.mjs:775-797 动态匹配、FORCED_EVENT_TYPES 42-46、judgements.mjs:229-252 依赖枚举；**偏差**：部分会破坏 requires 前提的转换不发 dependency.changed（P2-6）。
- BLUEPRINT **§2.7 冻结签名**：两处均按签名导出——applyStateTransition（judgements.mjs:271，D1 默认动态装配 verification.mjs:237-249）与 openSubscriptionBoundary（changes.mjs:656，B1 projection.mjs:75-76 调用）；未发现签名被破坏。
- BLUEPRINT **§5.1 端点**：#11/#12/#43/#44（evidence.routes）、#27/#28/#29（verification.routes）、#30（judgements.routes）、#16–#19（changes.routes）全部实装；额外新增 GET /sorne/change-log（changes.routes.mjs:75-104，B2.md 偏差 10 已上报）。
- BLUEPRINT **§6 事件目录**：capture.completed / resource.content_changed / verification.completed / vulnerability.state_changed / judgement.invalidated / dependency.changed / relation.added / asset.discovered 与目录对齐；judgement.state_changed 为新增类型（judgements.mjs:453-459，D2.md 偏差 1 已上报目录遗漏）。
- BLUEPRINT **§8.2/§8.3 硬约束**：仅 verifier 可交结果（verification.routes.mjs:82-88）、发现者不自证（verification.mjs:910-919 + judgements.mjs:215-226 双重）、续验不受 requested_by 限制（#27 角色面含 verifier）——**落实**。偏差：evidence 路由无会话/角色校验、actor 取请求头（P2-2，A2.md 偏差 3 已记录但未收口）。
- 模块文档与本层代码的**后置漂移**（文档未更新，实现已变）：D1.md:95 称策略注册表「无内置策略」，代码已内置 DEFAULT_VERIFICATION_POLICY 并在模块加载时注册（verification.mjs:186-206）；D2.md 偏差 5 称 RES/T/CG 编号「不经 locateRecord 前缀解析」，records-read.mjs:40/49/54 已登记 M/RES/T/CG 前缀（两族编号均可定位）。

## 7. 问题清单

### P0 阻断
未发现 P0。核心不变量（证据不可变、事务原子、发现者不自证、版本竞争不覆盖新结论、delivered≠applied）在代码路径上均有真实实现与故障注入测试支撑。

### P1 重要

1. **[bug] D1 与 D2 对「检查项未通过」判定不一致；非必需检查失败会导致提交整体回滚、结果不落库**
   - 位置：verification.mjs:970（failedRequired 只筛 policy.required_checks）、1000（checksPass=failedRequired.length===0）；judgements.mjs:192-212（assertRequiredChecksPass 对 checks 中任何 passed=false 抛 PRECONDITION_INVALID）、304-305（confirm 路径必经）。
   - 现象：outcome=supported、全部必需检查通过但某项非必需检查 passed=false → D1 判定 checksPass=true 并调用状态机 → D2 抛 PRECONDITION_INVALID（detail 无 allowed_from，1062 的降级不触发）→ runSerial 回滚 → verification_results 行不存在，客户端收到 422。
   - 依据：D1.md:36 承诺「passed=false → 保存意见不应用并置复核」；§12.2「保存不可变结果 → 决定是否应用」的顺序语义；§20.1 不用错误掩盖已保存。测试 test/verification.test.mjs:731 的失败项恰为 required，未覆盖本分支。
   - 建议：把「必需检查通过」的唯一判定收编码（如 policy required_checks 传给 D2，或 D1 用同一谓词），并补「非必需检查失败 + supported」用例。

2. **[bug/不一致] D1 直接 UPDATE review，绕过 §8.4 唯一状态机且不推进 state_version**
   - 位置：verification.mjs:1106-1112（版本不匹配且非 confirmed 时直接 UPDATE 该表 SET review='pending'）、1117-1123（checks_failed 同法）；对照 1099-1104 的 confirmed 分支走 D2 require_review（judgements.mjs:112、391-395、382 均 bump state_version）。
   - 依据：verification.mjs:31-41、D1.md:89 声明「D2 唯一实现，本模块不另行实现状态机」；0001:230-250 把 state_version 定义为可变对象的版本水位（§11.3 乐观锁）。同一次写入在两条分支下版本语义不同，review 变化对按 state_version 判定的并发方不可见。
   - 建议：为 vulnerabilities 增加 from=[suspected,inconclusive,falsified] 的 review 置位动作并入 TRANSITIONS 表，或由 D2 提供受控子动作；D1 不再直接写表。

3. **[bug] registerTransform(derived_bytes) 不校验派生 Blob 的 representation，可让派生链指向原始 Blob**
   - 位置：evidence.mjs:813-822（bytes 分支 storeBlob 后按 sha 查回行，未校验 representation）；对照 823-831（derived_sha256 分支显式拒绝非 derived）。
   - 现象：若派生字节此前已以 raw_body（或 uploaded_file）登记，storeBlob 内容寻址去重返回原行，transforms.derived_blob_id 指向原始 Blob，违反 §5.3「原始与派生不混称」；A2.md:52-56 声称「derived Blob 强制 representation=derived」。
   - 测试缺口：test/evidence.test.mjs:412-433 的降噪产物为新内容，未覆盖同字节已登记场景。
   - 建议：bytes 分支复用 828-830 的校验（或拒绝/独立登记并告警）。

4. **[bug] 模板拆分插入新模板未处理唯一约束冲突 → 未捕获 SQLite 错误（500）**
   - 位置：dedup.mjs:597-604（split 时对每个 target 用普通 INSERT 写 endpoint_templates）；约束：0001:107 UNIQUE(project_id, method, service_asset_id, path_template)。
   - 现象：split_targets 目标 path_template 已存在（此前拆分已产生同名模板，或同一次提交两个 target 推导出同一模板）→ SQLITE_CONSTRAINT 直接冒泡（非 ApiError）→ HTTP 500 INTERNAL_ERROR，事务回滚，无 §20.1 语义码。
   - 依据：同类处理在 opProposeEndpointTemplate 用 INSERT OR IGNORE+查回（460-489），split 分支未沿用；§11.3 修改型应返回可区分业务错误。
   - 建议：与 propose 同法（OR IGNORE+查回合并成员），或预检冲突抛 PRECONDITION_INVALID/INVALID_REFERENCE。

5. **[风险] ack 边界守卫只看扫描区间、不看已投递截断点 → 可能永久跳过「已扫描未投递」事件**
   - 位置：changes.mjs:1017-1026（boundary > state.scan_through 才拒绝）；941-942 把 scan_through 推进到本批**已判定末位** lastPos；而 906-908 的投递截断点是第 pageLimit 个匹配事件 cutPos；1104-1110 用 boundary 推进 last_cursor。
   - 现象：一页内匹配数 > pageLimit 时，cutPos 与 lastPos 之间事件已扫描但未投递；客户端若以 high_watermark（或任何 ≤scan_through 的位置）构造边界（token 内容可自造：订阅号+版本可从响应获知）即被接受并推进 last_cursor，这些匹配事件此后不再出现在该消费者变化页（outbox 仍在，change-log 仍可读）。
   - 依据：§14.3「消费不得跳过未处理事件直接推进」；B2.md:57-60 声称「服务端只对已读区间签发可确认边界」「客户端无法构造越过未读区间的合法确认」——代码校验弱于该声明。测试 test/changes.test.mjs:511 只覆盖「越过 scan_through」与「未投递 event_id」。
   - 建议：以「最后投递位置」（每订阅持久化 delivered_through 或 consumer_receipts 最大位置）作为 ack 上界，或仅接受服务端签发过的 next_cursor 序列；补溢出页场景的越界 ack 用例。


### P2 次要

1. **[不一致] transform 幂等键用 JSON.stringify 而非 canonicalJson**（evidence.mjs:836-844）：参数对象键序不同 → 生成重复 transform 行（DDL 唯一键按字符串比较，同样不合并）。建议复用本仓 canonicalJson。
2. **[不一致] GET /captures/{id} 无项目域**（evidence.mjs:737-740；evidence.routes.mjs:84-90）：任意本地调用可用另一方项目编号读采集详情，与 readBlobBytes 的多项目消歧（399-403）及 §11.2「所有读写校验项目访问权」相反；A2.md 只记录了 actor 过渡方案。evidence 路由整体无会话/角色（29-49），与 §8.2 权限矩阵（worker/verifier 可用 #11/#12）未接上。
3. **[不一致] json_pointer "/" 直接返回整文档**（evidence.mjs:1013）：RFC 6901 中 "/" 指向空字符串键；现实现使「定位到根」与「定位到键 ""」不可区分（建议按 RFC 抛路径不存在，或以 "" 明确表示整文档）。
4. **[不一致] #29 outcome 过滤在分页之后**（verification.mjs:1282-1285）：count 为过滤后数量、has_more 依未过滤页；带 outcome 时一页可能不足 limit 而 has_more=true，客户端无法用 count 判断是否需要续读。另 jobView 每 job 2 次查询（705-762），limit=200 时 N+1。
5. **[测试缺口/重复] Manifest 生成有两份实现**：generateEvidenceManifest（verification.mjs:379-452）与 manifestInTransaction（653-703）逻辑重复、返回形状不同（view vs row，但 requestVerification 630 用 parseJson 处理 row）。两份已出现差异（导出体未返回 created 标记），建议收敛为一个事务内函数。
6. **[不一致] 变更事件覆盖不完整**：TRANSITIONS 中会破坏 requires 前提的 mark_conflicting（review→disputed，judgements.mjs:111）、mark_insufficient（confirmed→review=pending，110、346-360）、hypotheses.mark_inconclusive（supported→inconclusive，129）均无 gate/invalidates，不发 dependency.changed；同样 confirm/support 的「前提恢复」也不发（94-99、122）。与模块头声明「影响 requires 前提的转换追发 dependency.changed」（27-28）及 §9.2 事件释义「requires 边失效/恢复」不一致；C2 执行边界重查可缓解，但等待方依赖通知（changes.mjs:42-46 列为强制通知）。
7. **[不一致] 枚举死值/状态不联动**：blobs.storage_status 的 'staged'/'orphan' 从未写入（evidence.mjs:290 固定 'fixed'；528-536 只写 'lost'）；captures.integrity_status 插入即 'verified'（631），Blob 后续 lost/mismatch 时采集行不变，§18.3 的完整性状态会与 blob 行不一致。
8. **[风险] verifier_identity 未与会话 actor 绑定**（verification.mjs:861、1023）：审计字段可自报；独立性判定实际用 created_by（910），故不构成绕过，但「谁验证的」记录不可信。
9. **[不一致] 编号双轨**：dedup 生成 A-/RES-/T-/CG-/M-/R-<PRJ>-NNNN（dedup.mjs:171-173，项目内序列），A1 生成 A-nnnn/R-nnnn（record-service.mjs:343、485，_global 序列）；records-read 兼容两族（records-read.mjs:108-131），但同一实体类别存在两种编号形态，跨模块拼装/诊断脚本需同时处理（D2.md 偏差 5 的历史成因）。
10. **[风险] 循环依赖**：records-read.mjs:14 → verification.mjs:47 → records-read.mjs。当前仅函数级使用（无顶层执行），安全但脆弱；若任一方在顶层求值对方符号会 TDZ 失败。
11. **[性能] readChangeLog 用 runSerial（BEGIN IMMEDIATE）做只读扫描**（changes.mjs:425）：planner/orchestrator/dsh-bridge 轮询（agents/*.mjs:81、107、113）会与写事务争抢写锁，属可用性问题而非正确性问题。
12. **[限制] 模板 split 后 status='split' 为终态**（dedup.mjs:559-573）：命中 split 状态后 confirm/withdraw/split 全部被拒，与 §7.2「模板可修正」及 D2.md:83 描述存在张力；建议允许对 split 后残留模板再修订。
13. **[不一致] propose_endpoint_template 未校验样本同服务**（dedup.mjs:445-448 只取 resources[0] 的 service_asset_id，仅校验 method 一致）：可把不同服务的样本聚合进同一 service_asset_id 的模板；复用既有模板时事件仍写 from:null/to:'candidate'（508-525），与模板实际状态（可能已 confirmed）不符。
14. **[不一致] EvidenceAnchor 的 text_encoding 只在 line_range 校验**（evidence.mjs:901-913）：其他定位符携带非法编码被静默忽略；另 locator_type='whole' 不校验 locator 是否存在。
15. **[观测] changes 的全局 delivery_status/attempts 为跨消费者共享**（changes.mjs:932-935；0001:494-496）：任一消费者投递即置 sent，多消费者场景下该字段只表达「最早投递视角」（B2.md 偏差 3 已记）。

## 8. 测试覆盖映射

| 模块 | 测试文件 / 用例数 | 覆盖要点 | 主要缺口 |
|---|---|---|---|
| evidence | test/evidence.test.mjs 23 例 | §13 全链路（95）、rawBody 上限（130/148）、内容去重（174）、表示形式/expected_sha256（191）、场景 25 存储不可用（219）、不可变保护（247）、读取与完整性（270/305）、场景 4/5/23（322/394/436）、captures 幂等与事件（472/524/571/602）、采集详情（630）、assets 布局（664/704/757）、EvidenceAnchor 四类定位符（770）、多项目隔离（848）、重启（872） | derived_bytes 复用既有 raw Blob（P1-3）；getCaptureDetail 跨项目（P2-2）；transform 参数键序幂等（P2-1）；json_pointer "/"（P2-3） |
| verification | test/verification.test.mjs 32 例 | 五要素/去重键四成分/角色面/Manifest 不可变/检查项/确认与应用/五竞争情形/幂等重交/并发/重启/事务原子性/队列视图/D2 集成（D2_LANDED 时执行 1367-1379）/装配来源（1381） | 非必需检查失败 + supported（P1-1）；D1 直写 review 的版本语义（P1-2）；outcome 过滤×分页（P2-4）；verifier_identity 伪造（P2-8） |
| judgements | test/judgements.test.mjs 28 例 | 规范化/模板推导纯函数、一观察多判断、Fact 准入、状态机各转换与前提、overturn、atomic TRIGGER、重启、evaluatePrerequisite、场景 6/7/11/19 黑盒、#30 台账 | 拆分冲突路径（P1-4）；split 终态再修订（P2-12）；跨服务模板聚合（P2-13）；dependency.changed 缺失（P2-6） |
| changes | test/changes.test.mjs 13 例 + change-log.test.mjs 3 例 + cursor.test.mjs 验证队列分页 | 边界四元组、过滤/截断不丢、delivered≠applied、场景 14/16、强制通知、CURSOR_EXPIRED、ack 不越界、边界签名、重启、投递原子性、权限；change-log 只读性与锚点续读 | 溢出页场景下 ack 越界（P1-5）；多消费者 delivery_status 语义；readChangeLog 写锁开销（P2-11） |
| dedup | 复用 test/judgements.test.mjs（1003-1106、1106-1220、1223-1336） | 服务规范化归并、资源精确身份、IP/域名不合并、模板拆分不丢样本、确认/撤回版本检查、候选组合并不替代身份 | 拆分唯一冲突（P1-4）；重复 merge 产生重复 duplicate_of 边（dedup.mjs:738-753 无去重）；group_key 拼接歧义（648-650） |

跨模块：test/multi-project.test.mjs 覆盖 0004 全局序列与跨项目编号；test/e2e-lifecycle.test.mjs 端到端贯穿；test/cursor.test.mjs 覆盖验证队列真实翻页。**本层无「虚构大断言」问题**：故障注入均为真实注入（占位文件、删文件、TRIGGER RAISE、关库重启），与文档声明一致。

## 9. 不确定点与需 Lead 交叉确认

1. **检查项语义归属**（P1-1）：D2 的「任何 failed 检查都阻止确认」是否是 §8.4「必要检查通过」的有意更严格解释？若是，D1 的 checksPass 应改为同一谓词；若否，D2 应只看 policy.required_checks。当前两处实现不自洽，需要架构判断。
2. **P1-2 的修法**：为 review 置位增加 D2 动作是否会污染 §8.4 合同表（表只列漏洞结论转换）？亦可接受「D1 直写但 bump state_version + 发事件」，需定一致规则。
3. **ack 边界的预期合同**（P1-5）：是否允许客户端以 high_watermark 作为 ack 边界？若允许，则需在 readChangesPage 中把 scan_through 收敛为 cutPos 并对未投递溢出事件做显式「未达到」标注；若不允许，需持久化已签发 token 序列。
4. **dependency.changed 的触发集合**（P2-6）：确认/复核置位是否应由 C1/E1 的 resume 机制承担（intents.mjs:283/294 也发 dependency.changed），而非 D2？需与 C1 负责人对齐事件责任边界。
5. **evidence 路由的会话接入**（P2-2）：A2.md 偏差 3 已列协调项，后来 sessions 已可用；是否应在阶段验收时切换（影响 actor 可信度与 §11.2 合规）。
6. **register_fact 与验证结果的关联强度**（judgements.mjs:633-712）：当前只校验引用行 outcome=supported，不校验「该 VR 针对的判断与本条 fact 语义相关」——按 §3.2 语义判断归 AI，但程序面是否应至少要求 VR 的 subject 与 fact 建立关系（verifies 边）？需评审。
7. **未核实项**：本次未运行测试（按任务禁令），测试运行态结论均来自源码与用例名映射；D2 集成用例 1367 在 D2_LANDED=true 时执行（judgements.mjs 存在），未实测其当前是否绿。

