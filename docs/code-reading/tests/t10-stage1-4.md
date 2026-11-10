# t10-stage1-4 测试精读报告

> 范围：test/stage1-project-context.test.mjs(789)、stage2-active-reading(446)、stage3-extraction-batch(487)、stage4-coverage-corrections(381)，共 2103 行。全部打开读过，关键断言原文核对。未运行 npm test。对照 docs/IMPLEMENTATION-PLAN.md §阶段 1–4 验收段（:11-14 表、:21-51 正文）与 01 基线 §一至§十六。行号为当前磁盘快照。

## ① 文件与用例数

| 文件 | 行数 | 用例数 | 起点行 | 跳过/only |
|---|---|---|---|---|
| stage1-project-context | 789 | 4 | :81,:135,:561,:673 | 0 / 0 |
| stage2-active-reading | 446 | 10 | :79,:141,:164,:206,:234,:257,:297,:320,:379,:412 | 0 / 0 |
| stage3-extraction-batch | 487 | 10 | :82,:121,:161,:190,:226,:263,:308,:345,:390,:440 | 0 / 0 |
| stage4-coverage-corrections | 381 | 7 | :87,:126,:152,:237,:272,:304,:341 | 0 / 0 |
| 合计 | 2103 | 31 | — | 全绿门禁的一部分（无 skip） |

## ② 锁定的行为清单（按实施计划阶段）

**阶段 1（图 1 项目与角色上下文；对应 01 §一/六/七/十六）**
- 1.1 目标解析：task 优先（goal_source=task）、task 仅空白回退 description（description_fallback）、两者皆空 goal_missing=true；createProject 与 startExploration 两处口径一致（:81-133，逐字段相等断言）。
- 1.2&1.3 上下文隔离：两个不同 task/范围项目（A 网络、B 本地 file://）分别跑 Planner/Orchestrator/Worker/Verifier，用录制模型捕获 system+messages+tools 全文（:68-79,:438-479），断言 ①无旧项目硬编码（oa.jou.edu.cn/在授权范围(SR-0002/通达 OA 2015_01）②scope_revision_id 严格不串 ③各自 task/description/allow/deny 都在输入中 ④对方 task/范围不出现（:490-557）；同时侦察摘要按项目过滤、线索带 source_refs、未命中产品指纹时 candidate_surface=0（:271-286）。
- 1.4 本地材料项目：范围外发现的域名经 register_asset 建档为 scope_status=pending（:582-611）；file:// 意图可接收并派发（leased，:614-641）；deny 目标→SCOPE_DENIED、未列目标→SCOPE_UNRESOLVED（:644-669）。
- 1.5 协调边界：assign_execution 携带 question 等改写字段→PRECONDITION_INVALID 且错误消息点明 revise_intent|request_planning（:710-730）；revise_intent+assign_execution 两个动作均 executed、库内 question/success_criteria 已更新、state_version>=3（:733-781）；overview.project_context 暴露统一 goal 与 allow 规则（:784-787）。

**阶段 2（主动阅读与可达性；对应 §二至§五、§十三）**
- 冷启动从 root:assets → atype:service → 资产、root:exploration → goal: → 意图逐层展开，校验 children_count/title/面包屑（:79-139）；搜索命中并返回 path（:141-162）；分页 limit=2 两页不重复、越界 cursor 返回空页且 has_more=false（:164-204）；写入观察后 search 立即可见（:206-232）；别名映射后旧节点 ID 解析到新节点并带 alias_note（:234-255）；书签跨项目隔离（:257-295）与同项目不同 role/actor 隔离+更新（:297-318）；readEvidenceSlice 分段读取并写 material_read_logs（tool_name/blob_sha256/attempt_id/offset/length，:320-377）；followRelations targets 出边（:379-410）；navigateParent 到根后 parent=null（:412-446）。

**阶段 3（自动批量保存；对应 §八/九/十五）**
- 200 条批次：status=committed、item_count=200、5 类各 40、库内条目数一致（:82-117）；getBatch 分页含 item_index/source_locator/confidence/has_more（:121-157）；500 条回执 JSON < 2048 字节且含 read_path（:161-186，直接对应"模型只收短回执"）；同键同内容幂等且库内仅 1 批（:190-222）；同键不同内容 IDEMPOTENCY_KEY_REUSED（:226-259）；markBatchPartial 置 partial、error_note、条目仍可读、重复标记不报错（:263-304）；searchNodes 命中 EI- 且 kinds 过滤（:308-341）；listItemsByCategory 按 category 游标分页 + 无过滤返回全部（:345-386）；EB/EI 经 locateRecord 定位、跨项目 null（:390-421）；范围外 http 探测经 /sorne/tool-calls 被拒（:440-487）。

**阶段 4（覆盖、修正、独立复核；对应 §五/九/十/十二）**
- saveCheckRecord 保存材料范围/方法/发现/未覆盖/适用条件并返回 CR- 编号与计数（:87-122）；仅 material_read_logs 无 check_records→unknown 且 note 说明"读取≠检查"（:126-148）；Mock 反证：原观察仍在、JC- 修正记录可查、依赖假设的意图被标 depends_on、无依赖意图不受影响（:152-233）；findAffectedIntents 区分 investigates/depends_on（:237-268）；listCheckRecords 分页（:272-300）；CR/JC locateRecord 定位与跨项目 null（:304-337）；coverage 由 unknown→partial→checked 提升且 check_count 递增（:341-381）。
