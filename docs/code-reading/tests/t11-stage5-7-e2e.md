# t11 · 阶段 5–7 与端到端 / 修复回归测试精读

> 范围：6 个测试文件、共 30 个用例（2153 行），全部逐文件读完；只读源码，未运行 npm test。
> 行号以当前工作区文件为准。

## ① 文件与用例数

| 文件 | 行数 | 用例数 | 主题 |
|---|---|---|---|
| `test/stage5-summary-lifecycle.test.mjs` | 316 | 7 | §十三 分支摘要生命周期（水位/发布/即时判断/stale/定位） |
| `test/stage6-checkpoint-scheduling.test.mjs` | 348 | 9 | §十一/§十四–§十六 检查点、搁置、唤醒、等待、交接幂等 |
| `test/stage7-end-to-end.test.mjs` | 556 | 2 | §十七 贯穿场景（存储级串联）+ 跨项目隔离 |
| `test/e2e-lifecycle.test.mjs` | 428 | 1 | §20.3 末段端到端：保存→派发→确认→恢复→再次规划（真实 HTTP） |
| `test/fix-deepening.test.mjs` | 192 | 4 | 深化纠偏回归：虚拟节点摘要、unresolved 分页、角色开场导航 |
| `test/fix-reachability.test.mjs` | 313 | 7 | 可达性纠偏回归：游标、批次展开、搜索、截断保护、摘要接入、自动 stale |

## ② 锁定的行为清单

**阶段 5（摘要）**
- `stage5:89` beginRefresh 写入 refreshing + 数字水位；publish 后 `covered_commit_seq === refresh_input_seq`（:106）；状态断言被放宽为 `["current","stale"]`（:107）。
- `stage5:121` 刷新期间追加观察 → 发布后 **stale** + `has_unsummarized=true`（:147-148）。
- `stage5:160` `live_judgement_states` 直接读库：改 hypotheses.status 后无需刷新即反映（:188-199）。
- `stage5:209` 20 次 submit 不自动重写语义摘要；手动 `markStale` 后进入 pending 列表（:239-245）。
- `stage5:250` beginRefresh 程序生成 sub_entries（只含本 goal 意图）；`:270` listPendingRefreshes 只返 stale；`:298` BS 编号可经 locateRecord 定位且跨项目不可见。

**阶段 6（检查点与调度）**
- `stage6:87` 阶段边界检查点：CP- 前缀、intent/current_question/boundary 齐备，latestCheckpoint 同号。
- `stage6:113` 检查点实时重建：改意图状态后新 CP 反映新状态、编号不同。
- `stage6:139` shelveBranch 记录 reason/scope/reconsider/wake；重复搁置幂等（already_shelved，:160-166）。
- `stage6:179` resumeBranch → resumed + previous_reason；搁置列表清空。
- `stage6:208` 搁置后新 observation.appended 事件使 evaluateWakeConditions 报可唤醒。
- `stage6:249` 空项目 has_pending_work=false；`:264` 同 submission_id 重发返回原编号（提交幂等）；`:298` SH 编号可定位；`:320` recoverContext 聚合 checkpoint/waiting/wake/shelved 四块。

**阶段 7（存储级串联，单用例）**
- `stage7:104` 按 §17 清单顺序断言：项目上下文（:111-116）→ 201 条批量提取、回执 <2KB、幂等重放（:137-170）→ 无编号搜索找到隐蔽 test2.com（:175-188）→ 观察/假设/依赖意图（:192-235）→ Mock 反证修正、原观察保留、两个受影响意图（:256-279）→ 覆盖 read≠checked（:281-311）→ 摘要（:315-348）→ 检查点 + recoverContext（:352-375）→ 旧检查点状态失效（:379-391）→ 交接幂等（:398-419）→ 搁置/唤醒/恢复（:424-465）→ Planner 沿索引与定位（:469-494）→ 综合恢复（:499-504）。
- `stage7:513` 跨项目隔离：B 搜索看不到 A 的观察、项目上下文目标不互串。

**端到端（真实 HTTP + 真实重启）**
- `e2e-lifecycle:93` 单用例全链路：user 建项目+范围 → planner #20 → runtime #22 → #11/#12 固定证据（sha 可核对 :151-161）→ #26 register/start/complete → #10 即时提交（suspected 可读 :210-216）→ #27/#28 独立验证 → confirmed + 确认版本对象（:240-271）→ 真实关库关服重启（:315-331）→ #42 drill 七步（中断/unknown/Checkpoint refs 含已确认漏洞 :336-353）→ 同 submission_id 恢复回执（:355-371）→ fencing 递增重派（:373-379）→ #36/#20 第二版计划以已确认漏洞为前提并派发放行（:381-414）→ 项目仍 active、metrics 可用（:415-421）。

**修复回归**
- `fix-deepening:56` atype 虚拟节点摘要含类型与计数；`:82` unresolved 25 项分 20+5 两页且不重复；`:115` openNode 摘要含语义文本/表名，stale 时标注「待刷新」；`:152` 注入 recording model 驱动 runPlanner/runOrchestrator，断言开场 prompt 含 root:assets/root:exploration/recover_context。
- `fix-reachability:51` 资产子节点 25 条分页无重复；`:103` 批次展开 children_count=25、两页 10+15；`:144` 搜索可按 extractor_name 命中批次；`:170` 直测 `loop.__test__.toolResultMessage` 截断后保留 next_cursor/has_more/total + `_truncated`；`:196` openNode 接入语义摘要；`:234` 提交观察后自动 current→stale（:258-261 先把摘要手动置 current 再验证）；`:286` extraction_items 面包屑含批次。

## ③ 测试替身 / 隔离 / 时钟手法

- **隔离**：5 个文件各自复制一套 `setupProject`（mkdtemp + SORNE_DATA_DIR 注入 + finally close/rm）：stage5:45-87、stage6:42-69、stage7:46-80、fix-deepening:24-40、fix-reachability:24-47；e2e-lifecycle 用 helpers `makeTempDir` + 自建 `bootServer`（:61-86，与 recovery/scope 重复）。全部随机端口 / 独立临时目录，无共享 ~/.sorne。
- **层次**：stage5/6/7 与 fix-* 直接调用存储层 API（无 HTTP、无角色会话校验）；只有 e2e-lifecycle 走真实 HTTP 端点 + 真实会话 + 真实重启，是本组唯一的"端到端"。
- **故障注入**：e2e-lifecycle 是真实「过期租约写库 → revoke 会话 → closeStore/closeAllStores → server.close → 同目录 apply 重启」（:315-331）；stage7 的"Worker 崩溃"只有一句注释（:362）与一次 `recoverContext` 读（:365-375），**没有进程退出/关闭句柄/重启**。
- **模型替身**：本组全部不用真实 LLM；fix-deepening:153-177 注入 recording model 驱动 runPlanner/runOrchestrator（唯一角色提示面测试）；其余为脚本化直接调用。实施计划 §7 的"真实模型验证"落在 `tools/real-model-verify.mjs`，不在本组测试内。
- **时钟**：无 fake timers；仅 e2e:319-322 把 `lease_expires_at` 写成过去 ISO；stage5/6/7 无时间相关断言，`oldest_*` 类字段最多断言非负。
- **状态注入**：多处绕过状态机直写库行：stage7:380（UPDATE intents status='cancelled'）、:396（改回 proposed）、fix-deepening:129-131/139-141（手改 refresh_status）、fix-reachability:258-261（手改成 current）、stage7:285-289（手插 material_read_logs，created_seq 写死 1）。这些是"为了让断言可跑"的跨层直写，削弱"阶段串联"的说服力。

## ④ 断言质量（过拟合 / 放宽 / 假绿）

- **publishRefresh「放宽断言」的固化链（重点）**：stage5:107 用 `["current","stale"]` 二选一放行；stage7:343 直接硬断言 `refresh_status === "stale"`，把"发布即 stale"写成了期望；fix-reachability:258-261 与 fix-deepening:129-131 必须先手工 `UPDATE branch_summaries SET refresh_status='current'` 才能测试后续行为（否则 current 永远不可达）。即：实现缺陷（主报告 P1，summaries.mjs:227-233）被三处测试联合固化，修 bug 必须同步改这三处。
- **过拟合实现文案**：stage6:344 `note.includes("恢复入口")`、stage7:369 同款；fix-deepening:136/144 断言「待刷新」三字；fix-deepening:178-188 断言 prompt 含字面 node id/tool 名——改提示词或文案即碎。
- **弱断言/同义反复**：stage7:154 回执 <2KB 尚可，但验收 6 只断言 `handoff2.ids.final_obs === finalObsId`（:419），没有"不产生新任务/事件"的库内断言；验收 10 只断言 recoverContext 字段存在 + shelved=0（:499-504），无"不引入无效重跑"的 attempts/captures 计数；e2e:421 `A + B >= 1 === true`。
- **假绿（已确认）**：
  1. `stage7:540` 跨项目泄露断言 `searchB.items.filter((r) => r.text?.includes(...))`——`briefNode` 产物只有 title/record_kind 等（reading.mjs:231-239），没有 `text` 字段，谓词恒 false、`leakedResults` 恒空 → 该断言永远通过，隔离未被真正验证（更该断言 items.length===0 或 record_kind 集合）。
  2. `stage7:438` `wakeBefore` 计算后从未断言（死变量）。
  3. `stage7:58` 范围规则写成 `{ pattern: "*.webapp.local" }`，而 `matchScopeRule`（scope.mjs:23/125-139）只认 host/scheme/port/path_prefix；该规则在真实闸门中永不匹配，但测试只断言 `scope.rules.allow.length > 0`（:115-116），全程未触发范围判定 → 「范围」形同虚设。
  4. `e2e-lifecycle:93` 单测试 428 行，任一阶段失败都只能定位到同一用例；无 `t.diagnostic`/子测试分节。
  5. `fix-reachability:170` 直接 import `lib/agents/loop.mjs` 的 `__test__` 内部函数做白盒断言，实现重构即碎。
  6. stage5/6 的夹具用直写 SQL 造意图/项目（stage5:45-87、stage6:51-83），无状态机/事件，与 e2e 的真实链路存在测试语义落差。

## ⑤ 覆盖缺口

1. **stage7 是否真串联七阶段**：串联的是存储 API 与 §17 验收点，但（a）无 HTTP/角色权限面；（b）无真实进程崩溃/重启（仅 recoverContext 读）；（c）无真实模型（计划 §7 要求另跑真实模型）；（d）范围闸门未执行、范围规则形态还是错的（见 ④.3）；（e）修正/覆盖两条链路只是在测试里直调存储函数，生产面不可达（主报告 P1）。结论：stage7 是「存储层七阶段串联脚本」，不是端到端验收；真正的端到端只有 e2e-lifecycle 一条。
2. **阶段 5**：current 状态实际不可达（无任何测试能自然产出 current）；无刷新并发（两个 beginRefresh 同时）、无 asset_type 分支、无预算/增量提示（计划 §5.2「按访问需求、重要性和预算刷新」）的断言。
3. **阶段 6**：交接去重只测 submission 幂等，未测 handoff 任务/事件去重；无阶段边界自动 checkpoint；wake 只覆盖 observation.appended，未覆盖「相关任务结果/目标调整」；evaluateWakeConditions 的事件类型注入/畸形值无负例；resume 的 resume_note 丢失（scheduling.mjs:126-149）未被发现。
4. **e2e-lifecycle**：无范围 deny 负例（范围只在创建时配置）；无 confirm 后再次验证/复核并发；无真实模型；metrics 断言过弱；finally 里 srv.close() 之后才 closeStore，异常早退可能有句柄残留。
5. **fix-* 回归**：只验证被修点，未加 HTTP/角色层回归；fix-reachability:234-285 的自动 stale 只验证「全项目批量置 stale」的粗粒度行为，与「按分支标记」（计划 §十三）不一致处无测试。
6. **缺失整体**：发布 current、摘要并发、唤醒类型目录校验、checkpoint 阅读位置、恢复错误码（裸 Error → 500）在本组均无对应用例。

## ⑥ 与实现文件映射

| 测试文件 | 主要实现 | 关联实现/端点 |
|---|---|---|
| stage5-summary-lifecycle | lib/store/summaries.mjs、lib/store/reading.mjs（lookupSummary/openNode）、lib/store/records-read.mjs（locateRecord BS） | lib/agents/planner.mjs 摘要工具（生产唯一调用方） |
| stage6-checkpoint-scheduling | lib/store/recovery.mjs（createCheckpoint/latestCheckpoint/assessWaiting）、lib/store/scheduling.mjs、lib/store/records-read.mjs（SH 定位） | lib/store/attempts.mjs（sweep 未在此测）、lib/agents/orchestrator.mjs 调度工具 |
| stage7-end-to-end | lib/store/extraction.mjs、coverage.mjs、summaries.mjs、scheduling.mjs、recovery.mjs、reading.mjs、record-service.mjs、records-read.mjs | 无端点；全部存储级 |
| e2e-lifecycle | index.js（apply）、lib/routes/*、lib/store/{record-service,evidence,verification,recovery,metrics}.mjs | #3/#4/#10/#11/#12/#20/#22/#26/#27/#28/#30/#36/#42/#43/#44/#41 等真实端点 |
| fix-deepening | lib/store/reading.mjs（openNode/listChildren）、lib/store/summaries.mjs（lookupSummary） | lib/agents/planner.mjs、lib/agents/orchestrator.mjs（recording model 驱动） |
| fix-reachability | lib/store/reading.mjs（listChildren/searchNodes/openNode）、lib/store/summaries.mjs、lib/store/extraction.mjs、lib/agents/loop.mjs（toolResultMessage） | lib/store/record-service.mjs（自动 stale 触发，record-service.mjs:919-930） |
