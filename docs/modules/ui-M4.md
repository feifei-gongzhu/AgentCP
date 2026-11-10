# ui-M4 竣工记录 —— M4 工作台（产品中心）与旧协调面板清理

> 施工者只写本文件与自己独占的代码/测试文件；蓝图（../BLUEPRINT-UI.md，冻结契约 v1.1）是冻结契约，
> 与实现冲突时先停工上报架构师，不得就地改契约。本记录覆盖 task-10（工作台半边）；
> 同一 M4 模块的系统诊断页与旧执行/变化流页清理由并行施工卡（task-11）交付，边界见 §5 偏差 1。

## 1. 基本信息

- 模块 ID / 阶段：ui-M4 / 前端重构第二批（M4 工作台与系统诊断——工作台半边）
- 负责规范章节：§1.4（工作区布局与顶栏状态/动作）、§1.5（工作台「现在发生了什么，我需要做什么」）、
  §2.4-2（右侧详情槽位）、§2.5（页面模块契约与注册表）、§2.6-2/§2.6-3/§2.6-4/§2.6-6（消息、进展条映射、诊断聚合、游标）、
  §e J1/J2/J4/J5/J6、§f P0-1②/P0-2②/P0-3/P0-6（UI 半边）、§g（旧页处置与 ⑪–⑭ 语义迁移）
- 独占文件（与蓝图 §c M4 清单一致，差异见 §5 偏差 1）：
  - 新增 「lib/ui/pages/workbench.page.mjs」（1980 行）
  - 新增 「test/ui-workbench.test.mjs」（1366 行，29 用例 / 238 条断言）
  - 删除 「lib/ui/pages/overview.page.mjs」「lib/ui/pages/coordination.page.mjs」「test/ui-coordination.test.mjs」
  - 本记录
- 开工日期 / 竣工日期：2026-11-06 / 2026-11-06
- 说明：系统诊断页（lib/ui/pages/diagnostics.page.mjs、test/ui-diagnostics.test.mjs）与
  lib/ui/pages/execution.page.mjs、lib/ui/pages/changes.page.mjs、test/ui-execution.test.mjs 的删除
  不在本卡 write_scopes，由 task-11 执行；终验 manifest 恰为 §2.5 注册表 8 个 id（双方落盘后已满足）。

## 2. 实现范围

- 端点（只消费，不加端点）：
  - #31 「GET /sorne/orchestrator/overview?project_id=」——三区「正在做什么/得到了什么/需要我做什么」的数据面；
  - #23 「GET /sorne/attempts?project_id=&limit=50」——活跃 Attempt、租约到期、J6 收尾计数；
  - #29 「GET /sorne/verification-jobs?project_id=&limit=50」——待验证任务与最长等待时长；
  - #45 「GET /sorne/change-log?project_id=&limit=20」——最新进展（最近 3 条）与新增记录推导；
  - #46 「POST /sorne/messages」/ #47 「GET /sorne/messages?project_id=&limit=50[&cursor=]」——对话与三段闭环、消息游标续读；
  - #38 「GET /sorne/worker-reports/{id}?project_id=&layer=handoff_card|key_records|full_basis[&page=]」——右栏三层汇报、基线下钻、分页续读；
  - #49 「GET /sorne/diagnostics?project_id=」——项目状态、计划在途、投影滞后、Outbox、pending_user、健康与模型状态；
  - #14 「GET /records/{id}」由外壳记录覆盖层（M1）承担：工作台只产出完整编号 chip 与读取入口（openRecord），
    不重复实现第二套记录详情。
- 表/迁移：无（只读消费）。
- 事件：无（不写库）。
- 错误码呈现：NOT_IMPLEMENTED(501)→「未实现」卡片并附原始 message（501 未实现 ≠ 报错）；
  TRUST_DENIED / INTERNAL_ERROR / NOT_FOUND / INVALID_REFERENCE(消息附件) / BAD_REQUEST 全部经错误信封原样呈现（附 code 前缀）。

### 2.1 页面结构（对照施工要点逐条）

1. **顶部 4 张卡 + 6 项指标**
   - 卡：项目状态（词表徽章 + 活跃尝试数）、探索进展（排队/执行中意图 + 活跃尝试）、待你处理
     （受阻 + 待验证 + 未处理汇报合计，计数按已加载数据推导）、系统健康（#49 health.ok + 模型 configured 三态）。
   - 指标：意图九态（以库为准）、活跃尝试（#23）、待验证（#29，含最长已等待）、未处理汇报（#31）、
     待处理消息（#47/#49，服务端 pending_user 优先）、提交边界/Outbox（#45 高水位 + #49 outbox.pending）。
   - 明确不渲染 /metrics 原始 JSON（归系统诊断页，评审 P1-5）；单测断言工作台不请求 /sorne/metrics。
2. **进展条（J1，§2.6-3 冻结映射）** 六段逐段用真实记录事实判定并写明证据，读取中只显示
   「正在读取进展（读取完成前不显示进度，不转圈）」，不出现百分比/假动画：
   | 段 | 判定（本页实现） | 段内证据示例 |
   |---|---|---|
   | 已接收目标 | 项目存在且 plan_run 待处理/在途 > 0，或已有意图/提交 | 规划请求：待处理 0 + 在途 1（诊断聚合）；项目 PRJ-… |
   | 正在读取已有信息 | #49 projection.planner_view 滞后 > 0（null=未投影，不冒充 0） | planner_view 投影滞后 N 个提交（高水位 #…） |
   | 正在制定计划 | #49 plan_runs_pending+in_flight > 0，或最近计划修订已接收 | 规划调用在途 N 个（同项目默认最多一个规划调用在途（§16.1）） |
   | 已分配任务 | #31 counts_by_status 的 queued/running > 0 或 #23 活跃 Attempt > 0 | 排队/执行中意图 N 个 · 活跃尝试 M 个（按已加载数据推导） |
   | 持续探索中 | 高水位 > 0 且（已加载事件 > 0 或活跃 Attempt > 0） | 提交边界 #… · 已加载事件 N 条（最近 …） |
   | 失败 | 最近计划修订 received_status ∈ {rejected, partial} 或 #49 llm.runtime 含 error/failed | 原因：计划接收状态 …（plan PR-…） |
3. **三区**
   - 正在做什么：#31 活跃意图（编号 chip/词表徽章/类别/优先级/问题/最近尝试/受阻原因）+ #23 活跃 Attempt
     （编号/状态/intent/worker/租约到期）+ #45 最新 3 条事件（页码/类型/主体 chip/时间）；
   - 得到了什么：#31 important_findings（疑似漏洞状态与复核**原样**呈现、不提升；假设原样状态）+
     「近期新增记录（按已加载事件推导，不代表全量）」；
   - 需要我做什么：受阻方向（缺什么 + 恢复条件 + 汇报编号）、待验证任务（等待时长）、未处理汇报
     （编号按钮 → 右栏 renderDetail ?id=）、待澄清/已暂缓计数、待完成动作（逐项核对不盲目重放）。
4. **对话（J4/J5）**：输入 + #46 发送；#47 列表按时间正序；每条用户消息三段：
   ① 已接收（状态 + 时间）② 对应任务（links：决定/意图/尝试/验证任务/汇报编号 chip）③ AI 处理结果
   （reply_to 链的 AI 回复；未闭环时明示「尚未处理（收到 ≠ 已处理…）」）；附件可选（先 #11/#12 上传，
   以 attachments kind=blob|capture 提交，页面本地校验 B-/CAP-/sha256，坏附件整条拒绝不半提交）；
   消息分页：首屏 50 条 + 「已加载 N 条…更早消息可加载更多」+ cursor 续读追加（不静默截断）。
5. **J6 暂停反馈**：项目状态 paused 且 #23 活跃 Attempt > 0 → 「正在暂停，仍有 N 个收尾中的操作
   （活跃 Attempt 数，来自 #23）——收尾完成前不假装全部停止」；归零后 → 「已暂停（无收尾中的操作）」；
   waiting_for_change → 「等待条件补齐：…不是结束；原因见顶栏与系统诊断」。暂停/继续按钮在冻结外壳顶栏（M1），
   本页不重复实现动作（偏差 2）。
6. **右栏详情 renderDetail（§2.4-2）**：?id= 为 WR- 编号时渲染三层汇报——
   第一层交接卡（分组/行内编号 chip/分页续读/omitted_from_this_page 显式列明 + 读取入口）、
   第二层关键记录（按需 #38 layer=key_records：发现清单带库内状态/status_note、重要尝试、正反证据、
   前提变化、条件、阻塞、AI 建议标注、遗漏分区 read_pointer、expand_pointer）、第三层完整依据
   （按需 layer=full_basis：evidence_refs[{ref,read_pointer}] 原样、完整记录入口、manifest 折叠）；
   另有 boundary（Manifest/提交边界/项目当前边界）、relative_to_base（新增/移除/未变 + 读取基线）、
   base_report 下钻链（链面包屑 + 返回上一份）。非 WR- 编号：给「打开记录」入口（openRecord），
   不重复实现第二套详情（避免与外壳记录覆盖层争真值源）。
7. **语义纪律**：所有 ⑪–⑭ 原句与「收到 ≠ 已处理 / 未提供 ≠ 不存在 / 501 未实现 ≠ 报错 / 折叠不删记录 /
   基线不依赖对话记忆（§18.6）」收进「语义说明」折叠区（正文只留任务导向一句 + 两条纪律，§ 计数符合 P2-10）。

## 3. 验证

### 3.1 新增测试文件与用例清单（test/ui-workbench.test.mjs，29 用例）
1. M4 页面契约：纯 ESM 不引包、不用浏览器存储、无钩子、无编号正则副本、无字面颜色值、order=20
2. M4 页面在 UI manifest 中按注册表顺序提供（真实服务；并断言 overview/coordination 旧页已删除）
3. 顶部 4 张卡与 6 项指标：计数全部来自端点并注明按已加载数据推导；原始 metrics JSON 不进工作台
4. 未处理汇报按 §18.5 语义过滤：handled 不属于待办；刷新按钮以 project_id 重读面板
5. J1 进展条：六段按冻结映射逐段呈现，每段来自真实记录事实（不假进度、不转圈）
6. J1 进展条失败段：计划被拒绝时显示原因（不转圈、不静默）
7. J1 读取中不显示假进度：端点未返回前只提示「正在读取进展」，不渲染百分比与转圈文案
8. J2 三区：当前方向/活跃 Attempt/最新进展、重要新发现原样状态、新增记录按已加载事件推导
9. 未处理汇报点击进入右栏详情（renderDetail ?id=WR-…）：不是跳走整页
10. J4 对话三段：已接收 → 对应任务 → AI 处理结果；状态收到 ≠ 已处理；links 与附件编号 chip
11. J4 发送：#46 携带 project_id 与 content；attachments 校验 B-/CAP- 编号；发送后重读 #47
12. J4 附件校验：非证据编号本地拒绝、不整条发送；超 16 项本地拦截
13. J5 调整探索重点：发送内容经 #46 持久化，页面提示对应任务由 AI 决定后出现（不假装已处理）
14. 消息分页不静默截断：#47 首屏标注已加载条数，更早消息以 cursor 续读并追加
15. 长列表不静默截断：意图/尝试/未处理汇报超过 8 条时显式标注仅显示前 8 条
16. J6 暂停反馈：paused 且仍有活跃 Attempt → 「正在暂停，仍有 N 个收尾中的操作」；归零后转「已暂停（无收尾中的操作）」
17. J6 顶栏五态之外：waiting_for_change 呈现「等待条件补齐，不是结束」
18. 详情·交接卡层：分组（编号 chip）、relative_to_base、boundary、分页与 omitted 不静默截断
19. 详情·关键记录层（按需 #38）：db 状态注记、AI 建议标注、遗漏分区与完整依据入口
20. 详情·完整依据层（按需 #38）：read_pointer 原样、manifest 折叠、完整记录入口
21. 详情·基线读取与下钻链：读取基线直达 key_records 层，返回上一份清空链
22. 详情·非汇报编号：不重复实现第二套详情，给记录覆盖层入口
23. 501 分支：工作概览/执行尝试/验证队列/变化流/消息/诊断各自标注「未实现」，其余区块仍渲染
24. 错误分支：500 错误卡附错误码；403 会话缺口如实呈现；诊断不可用不拖垮工作台
25. 未知形状：工作概览为空对象时三区显式「未提供/无」，不静默当作空
26. 空态：无项目上下文与空消息列表都显式呈现（不白屏、不假装有数据）
27. 语义纪律冻结原文留名：resolved 不代表已测透、恢复由协调 AI 决定、单规划在途、九态以库为准（+ §18.6 两句）
28. 真实服务：创建项目 → 工作台按 router.projectId 取数；页面发消息经 #46 → #47 呈现「已接收」
29. 真实服务：#38 真实汇报三层（直写 worker_reports 行）在右栏详情呈现交接卡与关键记录层

### 3.2 执行的门禁命令与结果（原文摘录）
    $ node tools/check.mjs
    node --check 通过：116 个源文件

    $ node --test test/ui-workbench.test.mjs
    # tests 29
    # pass 29
    # fail 0

    $ node --test test/smoke.test.mjs      → # tests 17 / # pass 17 / # fail 0
    $ node --test test/ui-design.test.mjs  → # tests 24 / # pass 24 / # fail 0
    $ node --test test/ui-shell.test.mjs   → # tests 22 / # pass 22 / # fail 0
    $ node --test test/ui-diagnostics.test.mjs（并行 task-11 文件，回归确认）→ # tests 27 / # pass 27

    $ npm test        # = node tools/check.mjs + node --test "test/*.test.mjs"
    # tests 531
    # pass 531
    # fail 0
    （竣工前最后一次全量；施工中曾出现 ui-maps/ui-findings 的并行瞬态红，归属 M5/M6 施工文件并及时转绿，
    本卡未修改他人文件，见 §5 偏差 6。）

- 真实宿主冒烟（实际执行，非仅单测）：
    $ SORNE_DATA_DIR=/tmp/m4-ui-data node test-ui-server.mjs 8906
    GET /sorne/ui/manifest →
      {"pages":[onboarding 5, projects 10, workbench 20, assets 30, exploration 40, findings 50, reports 60, diagnostics 70]}
      （manifest 恰为 §2.5 注册表 8 个 id，旧 overview/coordination 已不在）
    GET /sorne/ui/pages/workbench.page.mjs → 200，content-type: text/javascript; charset=utf-8，109513 字节
    GET /sorne/diagnostics → 200
- P0 判据落点：
  - P0-1②（字面颜色闸）：test/ui-design.test.mjs 全量扫描含本页 0 命中（页内仅 --sorne-* token）。
  - P0-2②（编号解析唯一实现）：本页 0 处 RECORD_ID_RE；chip 全部经 ui.RecordIdChip，行内编号经
    ui.parseRecordId 整体解析（分隔符切分，失败片段原样），项目段族 A-PRJ-… 不截断。
  - P0-3（游标统一）：消息首屏 + 游标续读、意图/尝试/汇报超限显式标注不静默截断（测试 14/15）。
  - P0-6（消息闭环 UI 半边）：三段式呈现 + links + 未闭环不得显示为已答复（测试 10/13）。
- 验收场景覆盖（§e 本模块半边）：
  - J1：进展条六段映射（测试 5/6/7）+ 真实服务首屏（测试 28）；
  - J2：三区计数来自端点并注明按已加载数据推导（测试 3/8）；
  - J4：消息三段 + 附件 + 发送/回读（测试 10/11/12/14/28）；
  - J5：对话调整重点经 #46 持久化、任务由 AI 决定后出现（测试 13）；
  - J6：暂停反馈收尾计数与归零转态（测试 16/17）；顶栏状态与动作在 ui-shell（M1）已有 4 用例。

## 4. 自查

- [x] 未修改任何冻结共享文件（blueprint §c：client.js、test-ui-server.mjs、index.js、lib/http.mjs、
      lib/errors.mjs、lib/db.mjs、lib/router.mjs、lib/stub.mjs、lib/routes/ui.routes.mjs、0001–0004 迁移、
      test/helpers.mjs、tools/check.mjs、docs/BLUEPRINT*.md、record-service.mjs、agents loop/planner/worker/verifier/dsh-bridge
      均未触碰；test/smoke.test.mjs 未改——其页面源用例由 Lead 改为按 manifest 取页面，见 §5 偏差 4）
- [x] 同阶段其他模块文件未被触碰：只新建/删除本卡 write_scopes 内文件；M5 的 assets/exploration/ui-maps、
      M6 的 findings/reports、task-11 的 diagnostics/execution/changes 均未改动（施工期其并行瞬态红见偏差 6）
- [x] 测试并行安全：29 用例中 fakeApi 用例不占端口；真实服务用例走 withTestServer（独立 mkdtemp +
      listen(0) 随机端口 + finally 收尾删目录）；无后台进程残留（宿主冒烟进程已 pkill，未留定时器）
- [x] 501 桩：本卡无归属端点；页面消费面 501 呈现（六数据面 + #38 三层）已测且语义为「未实现 ≠ 报错」
- [x] 规范语义纪律逐条对照：⑪⑫⑬⑭ 原句在测试 27 留名；confirmed/insufficient/falsified 由 VOCAB 冻结原文承担；
      unknown 工具调用红字纪律由 M4 诊断页（task-11）承载并在 ui-diagnostics 用例断言；delivered≠handled、
      未提供≠不存在、折叠不删记录、501 未实现≠报错、计数按已加载数据推导、数据时刻/截止边界均在本页或折叠区呈现

## 5. 偏差与已知问题（如实登记，回报架构师）

1. **M4 由两张施工卡分担**：本卡（task-10）交付工作台页与 overview/coordination 旧页清理；
   蓝图 §c M4 的系统诊断页（diagnostics.page.mjs/test/ui-diagnostics.test.mjs）与 execution/changes 旧页删除
   由 task-11 并行交付。两卡共用 M4 模块记录空间：本文件只记录工作台半边；诊断页竣工记录见其负责人文件
   （docs/modules/ui-M4-diagnostics.md 或 ui-M4 内补记，由架构师合并时统一）。终验 8 id 全集断言已可执行。
2. **J6 顶栏状态与暂停动作归 M1 冻结外壳**：蓝图 §1.4 将「顶栏状态与动作」记为 M1 骨架 + M4 深化；但 client.js
   本批已重新冻结，ui-M1 偏差 6 亦记录同一边界。本页实现「暂停过渡态 + 收尾计数（#23）+ 等待条件补齐」
   的如实呈现，不重复实现暂停按钮（避免两处动作与两套状态源）；暂停/继续交互在 ui-shell 用例覆盖。
3. **消息状态词表与 VOCAB 的差异**：M2 实际词表是 received→processing→handled|failed（ui-M2 偏差 2 已报，
   blueprint 原文 answered 未采用）；M1 冻结的 VOCAB.message_status 仍是 received/processing/answered/failed。
   本页对 handled 使用页内局部词表 + 状态色 token 呈现「已处理（handled；决定已持久化）」，其余走
   ui.StatusBadge；未改 M1 冻结 render.mjs。请架构师在 M1/M2 词表收敛时同步（页面只改一处映射）。
4. **旧页删除与冻结 smoke 的时序**：删除 overview.page.mjs 会使 test/smoke.test.mjs 原「页面源用例」
   （钉死 overview.page.mjs 200）变红；该文件为冻结共享文件、不在本卡 write_scopes，已上报 Lead，
   由 Lead 改为「从 manifest 取第一个页面文件」后本卡才执行删除。**本卡未改 smoke。**
5. **旧 ui-coordination 断言迁移中的「废弃」项**（每项给理由；领域语义未丢）：
   - 页面内项目选择器（自动选首项目/切项目/项目游标累积，旧用例 23）：新外壳以 hash 路由承载项目上下文
     （顶栏切项目 → #/p/<pid>/workbench，keep-alive 按项目组重建），页面不再自持项目选择器；
     语义由 ui-shell「切页不重选项目/切项目重读」用例承载，本卡在真实服务用例断言「按 router.projectId 取数」。
   - 手动输入汇报编号/记录编号展开（旧用例 14/16 的输入框与 Enter 提交）：导航由路由承担（评审 §4d），
     工作台改为列表点击 + ?id= 详情 + 编号 chip；「空输入本地拦截」语义迁移为消息发送的本地拦截（测试 11）。
   - 旧 E1/E2「防御形态」断言（数组键六要素、扁平汇报 + DDL TEXT content、{report:{}} 包装，旧用例 4/13）：
     M2 落地信封已稳定（reports.mjs readWorkerReport 恒三盒；orchestrator overview 恒对象嵌套），过渡期
     格式防御不进入新页；未删领域断言（状态不提升/三层不删不确定项等均在测试 8/18/19/20 重述）。
   - E1 constraints 原样 JSON（旧用例 3 末段「关键限制」区）：项目状态由顶栏徽章 + 4 卡呈现，范围版本归
     项目设置（M3 范围编辑器），并行上限归诊断页 #49 计数；按评审 §3「不要把数据库倾倒到屏幕」不再逐字段铺 JSON。
   - 「面板 has_more 不完整提示」（旧用例 4 尾段）：由 #31 pending_reports.has_more 与诊断页聚合承载；
     工作台对长列表改为「仅显示前 N 条 + 指向完整页」显式标注（测试 15）。
   - 记录 501 呈现（旧用例 19 的记录展开分支）：记录覆盖层属外壳（M1），其 501/404 呈现由 ui-shell 用例覆盖。
6. **并行施工瞬态（非本卡缺陷，如实记录）**：施工期间全量 npm test 曾出现
   「test/ui-maps.test.mjs::真实服务…截止边界」与「test/ui-findings.test.mjs::真实服务…成员记录」两条红，
   均为 M5/M6 并行落盘时序（其页面/测试正在改写）；本卡名下 29 用例与 ui-design/ui-shell/smoke 全程绿，
   未修改他人文件；M5/M6 收敛后全量 531/531 全绿。
7. **已知限制**：a) 工作台不自动刷新（手动「刷新」；变化流/租约明细归诊断页），刷新会重读六数据面并保留
   已加载消息分页位置之外的输入；b) 意图/尝试各只渲染前 8 条、未处理汇报前 8 条、待验证前 6 条、消息首屏
   50 条（均有显式标注 + 指向完整页/游标续读）；c) 最近进展只呈现最近 3 条事件（明示）；d) #31 为 501 时
   三区退化为「未实现」卡片、卡片/进展条改用 #49/#23/#45 事实（降级不冒充）；e) 详情只处理 WR- 汇报，
   其它编号交外壳覆盖层（单一真值源）；f) 消息 AI 回复质量依赖 Orchestrator 循环（无模型时如实停在
   「已接收」，不假装处理）。

## 6. 旧测试逐条迁移清单（ui-coordination.test.mjs，24 用例 / 约 259 断言）

> 迁移分类：**W** = 迁入 test/ui-workbench.test.mjs（本卡）；**D** = 迁入 test/ui-diagnostics.test.mjs（task-11，
> M4 诊断半边，已落盘并绿）；**X** = 随旧页废弃（理由见 §5 偏差 5，领域语义另行落点）。行号为旧文件实测出处
> （删除前 read 记录）。

| # | 旧用例（断言组） | 旧断言要点（逐条） | 去向 |
|---|---|---|---|
| 1 | 页面契约（:566-591） | 不引包/不用 require/localStorage/React 钩子；不改写展示值（toLowerCase/decodeURIComponent/replace）；id=coordination/order=80/title；初始渲染不白屏 | **W 测试 1**（对 workbench 页重述：零 import、零存储、无钩子、无编号正则、无字面颜色、order=20、renderDetail 存在）；旧 coordination 的 id/order/title 断言 → **X**（文件删除；manifest 全集断言移终验） |
| 2 | manifest 顺序（:593-606） | manifest 含 coordination、file 路径、order 80、vulnerabilities<coordination<reports | **W 测试 2**（manifest 含 workbench、order 20、projects<workbench<assets；并断言 overview/coordination 旧页已删）；旧「vuln<coord<reports」→ **X**（改由 §2.5 注册表顺序与终验 8 id 全集断言承载） |
| 3 | E1 六要素对象嵌套（:610-672） | 六区块标题；活跃计划 received_status 中文 + §16.1 原文；九态计数行 + 九态原句；意图行/最近尝试/受阻汇报/has_more 提示；汇报 total/has_more/条目/基线处理状态/delivered≠handled 两句；发现 vuln+hyp 类型与当前状态原样/两条以库为准句；待决事项/需补充/已暂缓/不盲目重放/不写死流程；constraints note + JSON 原样；数据时刻 | 计划/意图/汇报/发现/待决/语义句 → **W 测试 5/8/27**；has_more 面板不完整提示 → **D**（诊断聚合/变化流分页）；constraints JSON 原样 → **X**（§5 偏差 5：状态归顶栏+卡、范围归项目设置、并行上限归诊断）；「不盲目重放」句 → **W 测试 8**（待完成动作区保留原文） |
| 4 | 防御形态数组键 + 未提供显式 + has_more（:674-696） | 数组键意图/限制渲染；四区块「未提供 ≠ 不存在」各一条；panel has_more 提示 | 未提供显式 → **W 测试 25**（工作概览空对象 → 三区显式未提供）；数组键防御 → **X**（§5 偏差 5 过渡格式）；has_more 提示 → **D** |
| 5 | 未处理汇报过滤 handled（:698-720） | 混合 handled/pending/needs_clarification/无状态 → 仅非 handled 呈现 | **W 测试 4**（页面按 §18.5 过滤 handled；服务端 #31 已 pending-only，双保险） |
| 6 | 面板刷新（:722-741） | 刷新按钮携 project_id 重读 #31，两次调用 | **W 测试 4**（刷新 → #31 调用计数 2） |
| 7 | E2 交接卡层（:743-781） | 元数据/投递与处理分列/提交人；boundary Manifest+提交边界+项目当前边界；relative_to_base 新增/移除/未变 + 读取基线按钮；分组 header/关键发现/阻塞；关键发现行内编号可点；pagination/ai/status 三条 note；omitted 分区 + 续读入口；分页按钮 | **W 测试 18**（全套；文案改为本页实现措辞，语义等价） |
| 8 | 交接卡分页续读（:783-805） | 点击 page=2 请求；第 2 页分组追加；第 1 页仍可见；读完后按钮消失 | **W 测试 18**（同套断言） |
| 9 | E2 关键记录层（:807-861） | 默认收起不请求；展开按需层；任务问题/实际完成/执行状态；发现清单 db 状态 + status_note；重要尝试/正反证据/前提变化/未解决/条件/阻塞；AI 建议标注；遗漏分区 + CAP 入口；证据引用 + expand_pointer 直达；收起恢复 | **W 测试 19**（同套断言；CAP 入口 → openRecord 而非页面内记录区） |
| 10 | E2 完整依据层（:863-907） | 默认收起不请求；证据引用 read_pointer 原样 + 读取入口；完整记录入口；manifest 原样；层 note；点击 read_pointer 原样读取 | **W 测试 20**（同；read_pointer 记录/采集 → openRecord 覆盖层 = 原样读取的落点） |
| 11 | 基线读取与下钻（:909-939） | base_read_pointer 直达 key_records；链显示 WR-0003 → 本汇报；返回上一份清空链；交接卡往返两次 | **W 测试 21**（同套） |
| 12 | expand_pointer/omitted 他汇报层入口（:941-969） | WR-0002 key_records 入口直达对应层 | **W 测试 19/21**（同汇报 expand_pointer + 他汇报 base 下钻共用 routeRef 分支；旧独立用例合并，路径等价断言保留） |
| 13 | 扁平汇报防御形态（:971-1017） | 顶层字段 + content JSON 双路；{report:{}} 包装；changes_since_base 防御键 | **X**（§5 偏差 5：M2 落地信封恒三盒，过渡格式防御不进入新页；§19 最小内容集语义由测试 18/19/20 承接） |
| 14 | 手动展开汇报 + 空输入/Enter（:1019-1039） | 空输入本地拦截不发请求；Enter 提交携 project_id 与 layer | **X**（导航改路由点击；本地拦截语义 → **W 测试 11**；带 project_id/layer 的请求断言 → **W 测试 18/19/20**） |
| 15 | 面板汇报编号点击展开（:1041-1054） | 面板编号点击经 #38 展开 | **W 测试 9**（点击 → ?id= 右栏详情；#38 请求由测试 18 断言） |
| 16 | 手动展开记录 + 发现编号点击（:1056-1077） | 空输入拦截；发现编号点击 /records/{id} 携 project_id | 发现编号点击 → **W 测试 8**（chip 化；openRecord 由测试 19/20/22 断言）；手动输入 → **X**（导航改路由；拦截语义 → 测试 11） |
| 17 | 遗漏分区纯编号 CAP-0007（:1079-1098） | CAP 编号经 /records/{id} 展开 | **W 测试 19**（CAP-0007 → openRecord("CAP-0007")；外壳覆盖层执行 /records 读取） |
| 18 | 接收端语义说明（:1100-1124） | 基线不依赖对话记忆/Planner 视野/折叠不改原始关系/回执只在决定持久化后 handled/阅读中断仍待处理/状态以库为准/页面只读 | 基线与折叠两句 → **W 测试 27**（§18.6 两句原句）；回执/handled/delivered 句 → **W 测试 10/27**；Planner 视野句 → **X**（协调面板专属说明；Planner 能力在探索页/AGENTS 记录）；只读边界 → **W 测试 18**（详情尾部只读句） |
| 19 | 501 分支（:1126-1167） | 面板 501 标注 E1；汇报 501 标注 E2；层 501；记录 501 标注 B1；其余区块仍渲染 | 面板/汇报 → **W 测试 23**（六数据面 + 详情 501）；层 501 → **W 测试 23**（详情层未实现态由 renderLayerBody 覆盖）；记录 501 → **X**（外壳覆盖层，ui-shell 用例覆盖） |
| 20 | 错误分支（:1169-1219） | 500 错误卡附 code；403 会话缺口说明；404 汇报不存在；层错误独立、交接卡不受影响 | **W 测试 24**（500/403/诊断不可用）+ **W 测试 23**（层独立错误由 renderLayerBody 分支断言） |
| 21 | 未知形状（:1221-1238） | 面板形状无法识别；汇报形状无法识别 | **W 测试 25**（工作概览空对象显式未提供）+ **W 测试 18/19/20 的 unrecognized 分支**（详情形状无法识别由 renderUnavailable 断言，测试 23 覆盖 501 分支同路径） |
| 22 | 空态（:1240-1280） | 无项目显式空态且不发面板请求；E1 空信封各区块空清单显式；constraints 对象非空态文案 | 无项目/空清单 → **W 测试 26** + **测试 25**；constraints 对象 → **X**（§5 偏差 5） |
| 23 | 项目选择（:1282-1322） | 自动选首项目/#31 携 project_id；项目游标累积；切项目新 project_id 重读且旧数据不残留 | **X**（页面内项目选择器随外壳路由移除，§5 偏差 5）；「按 project_id 取数/切项目重建」→ **W 测试 28**（真实服务 router.projectId）+ ui-shell 切页/切项目用例 |
| 24 | 真实服务集成（:1324-1462） | 创建项目 → 页面自动选择并携 project_id；#31/#38 200/501 双分支；直写 worker_reports → 真实三层（handoff/key_records/full_basis） | **W 测试 28**（真实 #31/#47 + 页面发消息闭环）+ **W 测试 29**（直写真实 worker_reports → 真实 #38 交接卡/关键记录层；full_basis 分支由测试 20 的按需请求断言） |

**§g ⑪–⑭ 原句迁移落点（必须原句留名，已全部满足）**

| 原句（冻结原文） | 旧出处 | 新留名 |
|---|---|---|
| resolved 只表示该版本的问题已处理，不代表关联资产已测透（规范 §10.1） | ui-execution:405、ui-coordination:636 | test/ui-workbench.test.mjs:1255（测试 27）；ui-diagnostics 同句亦在（D 半边） |
| 恢复与重派由协调 AI 决定，程序不写死固定重试（规范 §3.1/§3.2） | ui-execution:422 | test/ui-workbench.test.mjs:1257（测试 27，页面语义说明折叠区原句） |
| 同项目默认最多一个规划调用在途（§16.1） | ui-coordination:625 | test/ui-workbench.test.mjs:1259（测试 27）+ :718（进展条段证据） |
| 九态计数以库为准（§10.1） | ui-coordination:634 | test/ui-workbench.test.mjs:1261（测试 27）+ :664（顶部指标行） |

**旧页内容去向（§g 对应行）**：overview.page.mjs → 健康状态→顶栏徽章（M1 已实现）、4 卡 6 指标→工作台顶部、
/metrics 原始 JSON→系统诊断页折叠（D）、「漏洞数量不是唯一健康指标」→诊断页语义说明（D）；
coordination.page.mjs → 工作面板六要素→工作台三区、未处理汇报与三层展开→工作台列表+右栏详情、
待决事项→「需要我做什么」、接收端语义→工作台语义说明折叠区 + 诊断页。

## 7. 留给后续阶段的接口预留

- M5/M6 页面若需要在工作台预填「就此资产/发现向 AI 下任务」的消息草稿：本页消息输入与 attachments
  契约已就绪（POST /sorne/messages），可经路由 query（如 ?draft=）或共享消息草稿模块扩展；本卡未实现跨页草稿。
- 若 M1 后续把 VOCAB.message_status 收敛为 received/processing/handled/failed，本页删除本地 handled 映射即可
  （单一函数 messageStatusNode）。
- 若评审要求工作台实时刷新：可在本页加 10s 轮询（仅重读 #31/#23/#29/#49，保留消息分页位置），
  当前按「手动刷新 + 诊断页明细」的首版范围。
