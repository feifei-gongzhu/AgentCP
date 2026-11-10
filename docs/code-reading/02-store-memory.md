# 02 · store-memory 记忆与阅读层精读报告

> 精读范围：lib/store 下 9 个记忆/阅读/恢复/范围/调度模块；只读源码，未修改任何文件。
> 行号以当前工作区文件为准（`file:line`）。

## 1. 范围与文件清单

| 文件 | 行数 | 一句话职责 |
|---|---|---|
| `lib/store/projection.mjs` | 1523 | 三种 Map 快照（asset_map/exploration_map/planner_view）+ Worker 任务快照：一致读视图、折叠、规模上限、分层预算、文件落盘 |
| `lib/store/records-read.mjs` | 840 | 编号→物理表定位（`locateRecord`）与 `GET /records/{id}` 记录视图/证据索引/1 跳关系边 |
| `lib/store/reading.mjs` | 948 | 主动阅读协议：虚拟节点树、分页子节点、搜索、关系跳转、证据片段、隔离书签 |
| `lib/store/recovery.mjs` | 659 | §18.1 接手检查点、§1/§16.4 等待判定、§18.2 恢复七步（`runRecovery`） |
| `lib/store/coverage.mjs` | 374 | 检查记录（check_records）、材料覆盖状态、判断修正与受影响意图 |
| `lib/store/summaries.mjs` | 358 | 分支语义摘要生命周期：固定输入水位/发布/即时判断状态/stale 列表 |
| `lib/store/scope.mjs` | 359 | 目标解析与范围规则匹配、派发闸门与逐动作闸门、`assets.scope_status` 回写 |
| `lib/store/explore.mjs` | 164 | M2 开始探索（热加载 → 生命周期 → 建 plan_run） |
| `lib/store/scheduling.mjs` | 258 | 分支搁置/恢复/唤醒条件、阶段边界检查点包装、恢复上下文聚合 |

## 2. 模块职责与关键导出

- **projection.mjs**：`SNAPSHOT_SCHEMA_VERSION=1`（`:31`）、`normalizeSnapshotKind`（`:60`）、`generateSnapshot`（`:1264`）、`generateWorkerContext`（`:1430`）。内部：`readView`（`:97`，同步 BEGIN/COMMIT 一致读）、`buildAssetSkeleton`（`:208`，活动度折叠+拓扑边+折叠依赖）、`buildEndpointTemplates`（`:326`）、`buildExplorationMap`（`:390`）、`buildPlannerView`（`:505`，§15.3 七要素）、`collectNeighbors`（`:695`，1–2 跳无向闭包）、`buildWorkerView`（`:723`，5 项强制+5 层降级）、`writeSnapshotFiles`（`:1203`，临时文件+rename）、`insertSnapshotRow`（`:1236`）。
- **records-read.mjs**：`locateRecord`（`:115`，前缀表→RR 双表→40 表兜底）、`getRecord`（`:758`）。`VIEWS`（`:253`–`:749`）覆盖 40+ 表；`READ_PATHS` 只给读取入口不返回字节（`:158`）。
- **reading.mjs**：`createAlias`（`:84`）、`openNode`（`:502`）、`listChildren`（`:579`）、`searchNodes`（`:610`）、`followRelations`（`:670`）、`navigateParent`（`:722`）、`readEvidenceSlice`（`:745`）、`saveBookmark/getBookmark/listBookmarks`（`:843/:896/:921`）。虚拟节点 `root:assets | atype:* | root:exploration | goal:* | ungrouped:intents | judgements[:k] | unresolved`（`:100`）。
- **recovery.mjs**：`createCheckpoint`（`:80`）、`latestCheckpoint`（`:270`）、`assessWaiting`（`:299`）、`ensureWaitingState`（`:372`）、`runRecovery`（`:571`，七步）。
- **coverage.mjs**：`saveCheckRecord`（`:56`）、`listCheckRecords`（`:111`）、`getCoverageForMaterial`（`:167`）、`correctJudgement`（`:231`）、`findAffectedIntents`（`:337`）、`listCorrections`（`:346`）。
- **summaries.mjs**：`beginRefresh`（`:162`）、`publishRefresh`（`:207`）、`getSummary`（`:268`）、`markStale`（`:314`）、`listPendingRefreshes`（`:339`）；程序生成 `collectSubEntries`（`:56`）、`snapshotJudgementStates`（`:75`）、`countUnsummarized`（`:110`）。
- **scope.mjs**：`parseTarget`（`:43`）、`matchScopeRule`（`:93`）、`evaluateTarget`（`:171`）、`checkActionTargets`（`:213`）、`checkIntentTargets`（`:296`）、`persistAssetScopeVerdicts`（`:267`）、`targetOfAsset`（`:254`）。
- **explore.mjs**：`startExploration`（`:28`）。
- **scheduling.mjs**：`shelveBranch`（`:64`）、`resumeBranch`（`:126`）、`listShelvedBranches`（`:155`）、`evaluateWakeConditions`（`:185`）、`phaseBoundaryCheckpoint`（`:225`）、`recoverContext`（`:236`）。

## 3. 数据模型与持久化结构

**0001 核心表（本块用到）**：`snapshots`（kind CHECK 含 report；snapshot_commit_seq、content_ref(相对数据根)、schema_version、folding_notes、created_seq=生成边界）；`checkpoints`（content 十一项、processed_boundary、created_seq=事件高水位）；`outbox`（UNIQUE(project_id,commit_seq,event_index)、idx_outbox_page/pending）；`id_sequences`（PK(project_id,kind)，快照/检查点/书签/检查记录等编号）；`projects.next_commit_seq/current_scope_revision`；`scope_revisions.rules`(JSON allow/deny/pending)。

**后续迁移**：
- 0007：`reading_node_aliases` PK(project_id,old_node_id)；`reading_branch_overrides`（本块代码未使用）；`reading_bookmarks` **UNIQUE(project_id,role,actor_id,attempt_id,bookmark_key)**；`material_read_logs`（role/actor/intent/attempt/tool_name/target_id/blob_sha256/byte_offset/byte_length/total_bytes/locator_json）。
- 0009：`check_records`（material_ids/range、check_method、findings、uncovered、applicable_conditions、coverage_status CHECK checked|partial|unknown）；`judgement_corrections`（原/新解释、反证、保留观察、affected_intent_ids）。
- 0010：`branch_summaries` **UNIQUE(project_id,branch_id)**、refresh_status CHECK current|refreshing|stale、refresh_input_seq、covered_commit_seq、judgement_snapshot_json、sub_entries_json。
- 0011：`branch_shelving`、shelve_reason CHECK 7 值、status CHECK shelved|reconsidering|resumed|closed（后两值代码未用）、wake_on_event_types_json。
- 迁移框架 `lib/db.mjs`：`schema_version` 表 + runSerial(BEGIN IMMEDIATE) 内版本复查（`lib/db.mjs:35,84-99`）。

## 4. 主要调用链与数据流

**A. Map 快照（§15.1/§15.2）**：`GET /sorne/snapshots/:kind` → `snapshots.routes.mjs:36` readPlane（会话项目域 403）→ `generateSnapshot` →
①`openBoundary` 动态 import `changes.mjs.openSubscriptionBoundary`（`:73-79`）取订阅边界 S（B2 事务内建立/更新订阅，返回 snapshot_commit_seq）→
②`readView`（`:97-111`）在同步 BEGIN/COMMIT 内取 `contentCommitSeq=projects.next_commit_seq-1` 并生成 content → ③`allocateSnapshotSeq`（`:1178`）在 runSerial 内分配 `SNAP-<pid>-NNNN` → ④落 `maps/snapshots/<id>/{content.json,map.md}` + 最新入口 `maps/*.md`（`:1203`）→ ⑤runSerial 插 `snapshots` 行（created_seq=S，`:1236`）→ 响应 subscription 四元组（`:1371-1385`）。
**B. Worker 任务快照**：`GET /contexts/:intentId` → `generateWorkerContext`（`:1430`）→ 同样的 边界→一致读→落盘→落行；内部种子=intent+目标资产+goal，`collectNeighbors` 无向 1–2 跳（`:695`），5 项强制内容（`:764-949`），5 级降级（`:1003-1065`），文件与快照行 kind=context。
**C. 记录读取**：`GET /records/:id` → `getRecord`（records-read:758）→ `locateRecord`（:115）→ 逐表 `(id, project_id)` 命中 → `VIEWS[table]` 组装 + `evidenceIndexForObservation/Judgement`（:193/:231）+ `relationEdges`（:162，limit 50）。跨项目/不存在统一 404（:771-781）。
**D. 阅读协议**：`/reading/*` 路由 / 四角色工具 → reading.mjs。虚拟节点由查询实时计算（`:266-378`），记录节点子节点 `:382-498`；面包屑 `buildBreadcrumb`（`:192`）递归 `recordParent`（`:142`）；游标为 `created_seq:id`（`:215-229`）；证据片段 `readEvidenceSlice`（`:745`）→ `evidence.readBlobBytes` → 可选写 `material_read_logs`（`:802-825`，失败吞掉不阻断读数）。
**E. 摘要生命周期**：planner 工具 → `beginRefresh`（summaries:162）→ `ensureSummary`（:132，懒建行）→ runSerial 内取 `watermark=next_commit_seq-1` 写入 `refresh_input_seq`、状态 refreshing → `publishRefresh`（:207）写摘要、`covered_commit_seq=refresh_input_seq`、`refresh_input_seq=NULL`，按 `newWatermark>covered` 定 current/stale；`getSummary`（:268）实时重算判断状态与未汇总数。写入侧：`record-service.mjs:919-930` 在提交事务内把 `refresh_status='current'` 的分支全部改 stale。阅读层 `lookupSummary`（reading:21）按 branch_id 读摘要并附加「摘要待刷新」。
**F. 恢复七步（§18.2）**：`POST /recovery/drill` → `runRecovery`（recovery:571）→ 1 `findStorageAnomalies`+schema_version（:396）→ 2 outbox/subscriptions 清单（:435）→ 3+4 `sweepExecutionState`（attempts.mjs，真实事务，:473）→ 5 范围/前提/资源清单（:482）→ 6 `latestCheckpoint`/无则 `createCheckpoint`+边界后事件数（:515）→ 7 可恢复清单 + `ensureWaitingState`（:535）→ `updateProjectLifecycle`（record-service:1277）落事件。运行时启动另只做 sweep（`lib/agents/runtime.mjs:264`）。
**G. 调度唤醒**：orchestrator 工具 → `shelveBranch` 写 `branch_shelving`（:64）/ `resumeBranch`（:126）；`evaluateWakeConditions`（:185）扫描 `outbox.commit_seq > shelving.created_seq` 且 event_type ∈ wake_on_event_types。
**H. 范围解析**：派发 `attempts.mjs:601` → `checkIntentTargets`（scope:296）→ 逐资产 `targetOfAsset`→`evaluateTarget`（:171）→ `loadRules`（:146，读 projects.current_scope_revision → scope_revisions.rules）→ `matchScopeRule`（:93）；工具登记/启动 `checkActionTargets`（:213）；`persistAssetScopeVerdicts`（:267）在独立小事务回写 `assets.scope_status`。
**I. 覆盖记录**：worker/verifier 工具 `save_check_record` → `saveCheckRecord`（coverage:56）写 `check_records`；`getCoverageForMaterial`（:167）合并 `material_read_logs`（由阅读层写）与 `check_records`；`correctJudgement`（:231）写 `judgement_corrections` 并计算受影响意图。
**J. 开始探索**：`POST /projects/:id/explore-start` → `startExploration`（explore:28）→ `pctx.agents.reload()`（:36）→ stopped/paused 拒绝（:58）→ 幂等查询在途 plan_run（:70-89）→ waiting→active 手写事务+outbox（:94-121）→ `createPlanRequest`（orchestrator:2039，事务内再查一次在途并建 `plan_runs(in_flight)`）。

## 5. 关键不变量、并发/事务/幂等/错误处理

1. **快照无间隙**：先边界 S 后一致读；`content_commit_seq < S` 时拒绝发布（projection:1301-1307、1457-1462）；快照不消耗项目 commit_seq（created_seq=S）；文件先原子落盘再落库行，落库失败只留可识别孤立文件（:1338-1361）。`readView` 事务体必须同步（无 await），但**绕过 runSerial 队列**（doc 见 `lib/db.mjs:5-6` 的「所有变更必须经 runSerial」——只读例外）。
2. **投影只读/可重建**：只读业务表，不写 subscriptions（B2 边界），只写 snapshots+id_sequences；所有规模上限显式计入 `edges_omitted/not_provided`（projection:34-47、:826-833、:1051-1065）。
3. **项目域隔离**：`locateRecord` 每条 SQL 带 `project_id`，不存在与跨项目一律 404（records-read:115-145、:771-781）；路由层会话项目域不一致 403（`snapshots.routes.mjs:24-34`）。
4. **书签隔离**：存储层以 (project_id,role,actor_id,attempt_id,bookmark_key) 唯一键 upsert，SELECT-then-UPDATE/INSERT 均在 runSerial 内（reading:853-893），并发安全。
5. **摘要水位**：设计不变量是「刷新开始固定输入水位，发布仅推进到该水位」；`covered_commit_seq` 只取 `refresh_input_seq`，晚于水位内容只影响 status 判定（summaries:229-249）。`getSummary` 的关键判断状态实时从记录读，不等摘要（:285-288）。
6. **检查点派生且无副作用**：实时从结构化记录重建、不消耗 commit_seq、不发事件（recovery:5-12、:259-263）；`refs` 汇集所有关键编号（:201-215）。
7. **恢复不自动派发**：七步只产出清单/评估，分配由 AI 提交（recovery:535-563）；步骤 3/4 经 C2 `sweepExecutionState` 真实事务修改（:473-479）。
8. **范围三态**：deny 优先 → 显式 pending → allow → 未列出=pending；缺范围/不可解析一律 pending，不默认放行（scope:183-209、:230-246）。每次判定实时读当前 scope_revision（:146-162），已发出操作不回滚、由 complete 事后判定。
9. **幂等/重入**：`shelveBranch` 已搁置返回既有（scheduling:80-90）；`runRecovery` 可重入（tests 验证）；explore 在途幂等返回（explore:70-89）；删除/编号由 id_sequences 事务内分配。
10. **错误处理**：projection/records-read/reading/coverage/summaries/scope 统一 `apiError`（含 retryable/next_requirements）；**recovery 与 scheduling 内部抛裸 `Error` + `code` 属性**（recovery:84-86、:93-95、:103-105、:304），路由层只认 `ApiError`，其余落 500 INTERNAL_ERROR（`lib/router.mjs:111-127`）。

## 6. 与文档/设计基线的对应与偏差

| 文档依据 | 文档说法 | 代码实际 | 结论 |
|---|---|---|---|
| BLUEPRINT §4「DDL 清单」 | 37 物理表 + schema_version/id_sequences（0001 为权威） | 0007/0009/0010/0011 又新增 7 表（reading_*、material_read_logs、check_records、judgement_corrections、branch_summaries、branch_shelving） | 偏差：蓝图未回写阶段 2/4/5/6 的 DDL，§4 清单已过期（P2 文档债） |
| BLUEPRINT §5.1/§5.3、BLUEPRINT-UI §2.6（44→53 端点） | 端点号段固定，无 `/reading/*` | 实际新增 9 个 `/sorne/reading/*` 路由（`reading.routes.mjs`），且 summaries/coverage/checkpoint 无 HTTP 端点 | 偏差：契约清单未覆盖阅读端点；摘要/覆盖/检查点只有存储级 API（供 AI 工具/测试） |
| 实施计划 §2 第 2 条 | 「子节点和搜索支持过滤…响应包含所属路径、来源、相关意图」 | `filter` 参数被 `virtualChildren`/`recordChildren` 完全忽略（reading:266、:382）；子节点只有 id/title/status/path，无 source/相关意图 | 不一致（P2） |
| 实施计划 §5 第 2 条 / 基线 §十三 | 「刷新开始时固定输入水位，发布时仅推进该水位」 | `publishRefresh` 先 `allocateCommitSeq` 再取 watermark（summaries:227-233），而 `beginRefresh` 自己也推进了 commit_seq（:168-170），故 `newWatermark > coveredSeq` **恒真** → 发布后永远 stale，current 不可达 | 明确 bug（P1）；测试用「current 或 stale」放行并以手工 UPDATE 兜底（stage5:120-121、fix-reachability:264-276） |
| 实施计划 §6 第 1 条 | 「接手能力接入正常执行和启动」「检查点持久化…阅读位置」 | 启动只调 `sweepExecutionState`（runtime.mjs:264），`runRecovery` 仅 drill 端点/AI 工具触发；checkpoint content 无阅读位置字段（recovery:217-257） | 部分偏差（P2） |
| 实施计划 §4 第 3 条 / 基线 §十二 | 修正判断时保留观察与反证、筛选受影响任务 | `correctJudgement/findAffectedIntents/listCorrections/getCoverageForMaterial` 仅测试调用，无生产路由/工具 | 功能未接线（P1） |
| docs/modules/B1.md §2 | 快照 folding_notes 含折叠/省略说明 | `buildFoldingNotes` 对 planner_view 读 `content.groups/edges_omitted`，但 planner_view content 的这两项在 `asset_skeleton` 内（projection:641-690 vs :1388-1414） | 不一致（P2，测试只断言 folded_dependencies 一条） |
| B1.md 「偏差」小节 | maps/ 写入、snapshots.created_seq=边界、intents.kind→intent_kind | 代码与之一致 | 无新增偏差 |
| 基线 §十 | 工具实际读取范围 vs Worker 声明检查范围分别保留 | reading 写 material_read_logs、coverage 写 check_records，两表分离且覆盖合并逻辑区分「读过≠检查过」（coverage:188-198） | 一致（但合并查询无生产入口） |
| F2.md / §18.1/§18.2 | 七步顺序、checkpoint 十一项、等待判定口径 | recovery 与文档基本一致；`assessWaiting` 口径与 runtime.projectWorkload 不一致（见 §7） | 文档内自洽、跨模块口径不一致 |

## 7. 问题清单

### P0（阻断/安全）
1. **[bug|安全] 对象式范围规则的 path_prefix 无路径边界，越权放行** — `lib/store/scope.mjs:135-137`
   现象：`{host:"app.example.com", path_prefix:"/api"}` 对 `/api-secret`、`/apix` 也返回匹配（`startsWith` 无分隔符校验）；同文件字符串 URL 规则却做了边界校验（`:114-121`）。allow 规则因此可放行同主机下任意前缀相邻路径（deny/pending 同理会误判）。
   依据：scope.mjs 文件头 `:20-26` 明确支持对象条目；`evaluateTarget` 以 allow 命中即 allowed（`:204-208`）。
   建议：与字符串分支统一为「`path === prefix || startsWith(prefix + "/")`」，并补 `/api` vs `/apix` 负向用例（现 scope.test:182 只有正向）。

### P1（重要）
2. **[bug] publishRefresh 永远发布为 stale，current 状态不可达** — `lib/store/summaries.mjs:227-233`（配合 `:167-170`）
   现象：publish 先 `allocateCommitSeq` 把 next_commit_seq 推进，再 `currentWatermark()`，必然 `newWatermark > coveredSeq`；`beginRefresh` 自身也消耗 commit_seq。结果：`listPendingRefreshes` 永远包含所有已发布分支，阅读层摘要永远带「（摘要待刷新）」（reading.mjs:21-27、:557-559），planner 反复看到待刷新。
   依据：手算 N→N+1→N+2；测试已「绕行」——stage5:120-121 断言 `["current","stale"]` 任一，fix-reachability:264-276 直接在 stale 时手工 UPDATE 成 current。
   建议：publish 用「分配前的 watermark」或本次分配的 commitSeq-1 作为比较基准；测试改为强断言。
3. **[bug] evaluateWakeConditions 事件类型字符串拼进 SQL（注入/畸形输入崩溃）** — `lib/store/scheduling.mjs:196-204`
   现象：`wake_on_event_types_json` 来自 orchestrator 工具入参（orchestrator.mjs:228、233），以 `'...'` 直接拼 `IN (...)`；含 `'` 的值可改变语义或抛 SQLite 错误；也没有事件目录校验。
   建议：改 `?` 占位符，并按 `changes.mjs`/蓝图 §6 事件目录校验类型白名单。
4. **[不一致] 判断修正/覆盖查询链路无生产入口** — `lib/store/coverage.mjs:167-211、:231-341`
   现象：`grep` 全仓，`correctJudgement/findAffectedIntents/listCorrections/getCoverageForMaterial/listCheckRecords` 仅被 `test/stage4-*` 调用；worker/verifier 只接 `saveCheckRecord`。计划 §4.3（Mock 反证修正、受影响任务重校验）在产品面不可达，`judgement_corrections` 在实际运行中无写入方。
   建议：补端点或 AI 工具（至少 verifier/orchestrator 可用），或明确降级为库内能力并在计划中标注。
5. **[不一致] 书签「角色/执行身份隔离」可被请求参数覆盖** — `lib/routes/reading.routes.mjs:112-131、:133-146`；`lib/store/reading.mjs:921-948`
   现象：写/读书签用 `body.role || role`、`body.actor_id || actor`、`query.role || role` 覆盖会话身份；`listBookmarks` 不带 role/actor 时返回**整个项目**所有身份的书签（上限 100，无 total 语义）。records-read 注释称书签「只经身份校验接口读取」（records-read.mjs:651-652），与路由行为不符。
   建议：变更面身份只取会话；`listBookmarks` 强制 role/actor（或显式授权项），并按存储隔离模型补 HTTP 层测试。
6. **[不一致] recovery/scheduling 抛裸 Error，路由返回 500 而非 NOT_FOUND/INVALID_REFERENCE** — `lib/store/recovery.mjs:84-86、:93-95、:103-105、:304`
   现象：`Object.assign(new Error(...), {code:"NOT_FOUND"})` 不是 `ApiError`；`lib/router.mjs:111-127` 只识别 ApiError，其余统一 500 且 code=INTERNAL_ERROR。经 AI 工具路径则只能字符串化，调用方无法按码处理。
   建议：统一 `apiError`（含 next_requirements）。
7. **[风险] ensureSummary 先查后插 + UNIQUE 冲突未处理** — `lib/store/summaries.mjs:132-155`
   现象：存在性 SELECT 在 runSerial 之外，两个并发 `beginRefresh` 可同时判定不存在，第二个 INSERT 触发 `UNIQUE(project_id,branch_id)`（0010）→ 抛 SQLite 错误（500）。
   建议：把存在性判断移入 runSerial 并改 `INSERT ... ON CONFLICT DO NOTHING` 后重读。

### P2（次要）
8. **[bug] planner_view 的 folding_notes 读错层级** — `projection.mjs:1388-1414` vs content 结构 `:641-690`：`content.groups/edges_omitted` 对 planner_view 不存在，缺失「折叠资产」「边省略」两条快照元数据（资产骨架内部仍有数据，仅元数据不全）。
9. **[bug] Worker 视图 neighbors.edges 会重复计数** — `projection.mjs:695-721`：每个 hop 都对 frontier 端点重查全部边上推；第 2 跳会重新收集第 1 跳边（B 在 frontier 时 A–B 再次命中），`edges_total`/`edges_omitted` 失真。建议用 `Set(relation id)` 去重。
10. **[不一致] 静默截断，违反「不能只看首页就认为已看全部」** — `reading.mjs:696-697`（`LIMIT 200`，无 has_more/truncated）、`:484-497`（通用记录子节点 LIMIT lim，total=items.length、has_more 恒 false）；`searchNodes` `total` 只是页长（`:661`）；`listBookmarks` 上限 100 无 total（`:932-947`）；`coverage.listCheckRecords` `total` 只是页长（`:154`）。
11. **[bug] listChildren 的 filter 被忽略且路由解析无保护** — `reading.mjs:266/382` 形参未用；`reading.routes.mjs:46-49` `JSON.parse(query.filter)` 无 try，畸形 JSON 直接 500。
12. **[死代码] markStale 生产无调用者** — `summaries.mjs:314-334` 只被测试引用；自动 stale 由 `record-service.mjs:919-930` 触发，但**不区分分支**：任何触发事件把全项目 `current` 摘要一律改 stale。
13. **[不一致] asset_type 分支的摘要能力空转** — `summaries.mjs:56-70、:75-127`：`snapshotJudgementStates` 的 intents 查询固定用 `goal_id=branchId`，`countUnsummarized` 对非 goal 直接返回 0；`beginRefresh` 的 branchKind 入参（`:173-174`）与 `ensureSummary` 忽略 branch_kind 的行值（`:135-137`）不一致，getSummary 用行值重算（`:286-288`）→ 同分支不同请求口径不同。
14. **[不一致] createCheckpoint 与计划 §6.1 的接手内容有缺口** — `recovery.mjs:217-257`：无「阅读位置」（reading_bookmarks 未纳入）、无关键依据的 state_version/evidence_revision 版本水位（仅 confirmed_version）；attemptId 无 intentId 时按 id 取 intent 未带 project 过滤（`:107`）。
15. **[不一致] resumeBranch 丢弃 resume_note、不推进 commit_seq/updated_seq、不发事件** — `scheduling.mjs:126-149`：`resumeNote` 仅回显；表无 resumed_by 列，恢复动作在变化流/审计上不可见（§十四要求保留再考虑记录）。
16. **[风险] assessWaiting 与 runtime.projectWorkload 口径不一致** — `recovery.mjs:307-336` 未计 `orphaned_running_intents`（runtime.mjs:70-78 计入）；等待判定可能把「running 意图无 lease」的项目判为无可执行工作，而 waiting 下 runtime 只被用户消息唤醒（runtime.mjs:96-108）→ 潜在停摆。
17. **[风险] explore 开始探索 TOCTOU 与硬编码状态** — `explore.mjs:70-89` 在 await reload/建请求前先查在途；`:94-121` 手写 lifecycle 事务（复制 A1 语义，未带 expectedStateVersion）；`:145` `plan_run_status` 恒返回 "in_flight"。
18. **[风险] 空提交：多模块消耗 commit_seq 但不发 outbox 事件** — reading 的别名/书签/读日志（reading.mjs:55-59、:863、:877）、summaries:170、scheduling:92、coverage:74/245。outbox MAX(commit_seq) < `next_commit_seq-1`，使 `eventHighWatermark`（recovery:70-72）与进程高水位不一致（当前消费端按事件游标读取尚不丢消息，但「提交边界」语义被稀释）。
19. **[风险] 恢复/演练对不存在项目静默成功** — `recovery.mjs:576-579`：projectId 查不到时 `projectIds=[]`，仍返回 200 与空 steps（drill 路由 metrics.routes 未补 404）。
20. **[风险] readEvidenceSlice 无长度上限/无角色闸门/全量读入内存** — `reading.mjs:791-798`（`byte_length` 仅 `Math.min(byteLength, total-off)`，仍可整块返回）、`role` 只写日志不参与判定（`:802`）；读取日志写失败被静默吞掉（`:822-825`），§十的「工具记录实际读取范围」可能缺行。
21. **[风险] getRecord 无一致读事务；locateRecord 未知前缀全表兜底** — records-read:758-840 多次查询无 BEGIN，视图与关系边可能跨提交；`:132-134` 未知前缀按 40 表全扫（每次面包屑/搜索定位都触发）。
22. **[不一致] 阅读书签可被 /records 定位但无视图** — records-read:26 前缀登记 + `:651-652` 注释称不经 /records 泄露，实际 `VIEWS` 无 reading_bookmarks，GET /records/BMK-… 返回 id/created_by 等元数据（项目内存在性泄露，内容不泄露）。

## 8. 测试覆盖映射

| 模块 | 主要测试 | 覆盖点 / 缺口 |
|---|---|---|
| projection + records-read | `test/projection.test.mjs`（18 例，经真实 HTTP） | 快照合同/kind 归一化/完全重建/场景 13 并发无间隙/场景 15 折叠依赖/planner_view 七要素/worker 视图与超预算/records 各类型与 404/磁盘故障/鉴权/B2 集成 |
| reading | `stage2-active-reading.test.mjs`（10）、`fix-deepening`（4）、`fix-reachability`（5） | 冷启动分层、搜索/面包屑、游标分页、新增可见、别名、书签隔离、证据片段+读日志、关系跳转/父节点、unresolved 分页、openNode 摘要 |
| summaries | `stage5-summary-lifecycle.test.mjs`（7）、fix-reachability 自动 stale | 水位推进（current/stale 放宽断言）、刷新期新增仍 stale、即时判断、不自动重写、子入口、BS 定位 |
| coverage | `stage4-coverage-corrections.test.mjs`（7） | check_record 保存/列表/覆盖合并/修正与受影响意图/CR、JC 定位（全部存储级直调） |
| recovery | `recovery.test.mjs`（12，含真实关库重启）、`stage6` 检查点 2 例、`e2e-lifecycle` | 七步、checkpoint 十一项、场景 12/21/24、drill 鉴权与幂等、指标 |
| scheduling | `stage6-checkpoint-scheduling.test.mjs`（9） | 检查点、搁置幂等、恢复、唤醒匹配、等待评估、SH 定位、recoverContext |
| scope | `scope.test.mjs`（11） | 匹配语义/P0-5 跨 host/路径通配/未配置/三区/场景 20/逐跳/自报字段/对象条目正向 |
| explore | `explore-start.test.mjs`（3） | 409/热加载后成功与幂等/stopped 与 waiting 转换 |

**无测试的行为**：①`publishRefresh` 的 current 路径（测试放宽）；②对象规则 `path_prefix` 的路径边界负例；③`evaluateWakeConditions` 的事件类型白名单/注入；④书签路由的身份覆盖与非法 `filter` JSON（9 个 `/reading/*` 路由**完全无 HTTP 层测试**）；⑤`resumeBranch` 的 resume_note/事件缺失；⑥checkpoint 缺阅读位置；⑦`assessWaiting` 与 runtime 口径差异；⑧`ensureSummary` 并发；⑨Worker neighbors 重复边与 planner_view folding_notes；⑩空提交对 outbox 高水位的影响。

## 9. 不确定点（需 Lead/作者交叉确认）

1. **publishRefresh 恒 stale 是否有意为之**：测试与 fix-reachability 都以「可能 stale」兜底并手工置 current，代码却无任何路径产出 current。是已知降级（接受 stale 优先），还是实现缺陷？若前者需在 docs/modules 明确，否则应修。
2. **对象式范围规则是否在真实授权面生效**：A1 `createScopeRevision` 对 rules 的校验函数（`record-service.mjs` 侧的 validateScopeRules）是否接受对象条目需确认；若只有字符串条目进入生产，则 P0 降级为潜在风险。
3. **判断修正链路是否有意只做库内能力**：计划 §4 验收用 `stage4` 测试直调通过，但产品面无入口，需确认是否属「库内能力+后续端点化」的既定取舍。
4. **9 个 `/reading/*` 端点的契约归属**：BLUEPRINT/§5.1 与 BLUEPRINT-UI §2.6 的端点号段都没有它们；需确认是否应回写 BLUEPRINT-UI 或收敛为 AI 工具（避免「文档 53 端点」与实测不一致）。
5. **readEvidenceSlice 的授权策略**：是否所有角色都允许读原始证据字节（当前仅项目域校验，role 只入日志），与 §18.3「验证/完整依据层」的意图是否一致。
6. **snapshots.kind 含 report 但 normalizeSnapshotKind 拒绝**：report 快照由 reportgen 直接落行（未在本块范围）；本块确认「context 只能走 /contexts」与 DDL 的 report 值并存是否预期。
