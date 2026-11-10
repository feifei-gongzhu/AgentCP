# ui-M4-diagnostics 竣工记录 —— 系统诊断页与旧执行/变化流页清理

> 施工者只写本文件与自己独占的代码/测试文件；蓝图（../BLUEPRINT-UI.md，冻结契约 v1.1）
> 与实现冲突时先停工上报架构师，不得就地改契约。本记录同时履行蓝图 §c M4
> 「旧测试逐条迁移清单义务」与 §g 语义纪律保留清单的核对义务。

## 1. 基本信息

- 模块 ID / 阶段：ui-M4-diagnostics / 前端重构第二批（M4 工作台与系统诊断的「系统诊断」半边；
  工作台与 overview/coordination 清理归并行任务 task-10，不在本文件范围）
- 负责规范章节：BLUEPRINT-UI §1.5（系统诊断职责边界）、§g（旧 execution/changes 处置与语义纪律
  清单⑪–⑭）、§2.1–§2.5（token / 渲染器 / 编号解析 / 页面契约）；规范 §3.1/§3.2（AI 决策，
  程序不写死重试）、§10.1（意图九态）、§10.2（Attempt/租约/unknown 工具调用）、§14.2/§14.3
  （delivered≠applied、查看≠消费）、§15.1/§15.2（派生视图、快照+增量）、§18.5（delivered≠handled）、
  §20.2（运行指标全集）、§16.1（单规划在途）、§20.1（错误信封呈现）
- 独占文件（与蓝图 §c M4 一致；另 +1 个经 Lead 书面授权的共享测试迁移，见偏差 1）：
  - 新增：lib/ui/pages/diagnostics.page.mjs（1349 行）、test/ui-diagnostics.test.mjs（973 行）
  - 删除：lib/ui/pages/execution.page.mjs（1094 行）、lib/ui/pages/changes.page.mjs（471 行）、
    test/ui-execution.test.mjs（1083 行）
  - 迁移修改：test/change-log.test.mjs（仅删页面半边 207–499 行与页面专用 import/帮助器，
    B2 后端 3 用例原样保留；Lead 2026-11-06 书面授权）
  - 本记录
- 开工日期 / 竣工日期：2026-11-06 / 2026-11-06

## 2. 实现范围

- 端点（只读消费，无新端点）：
  - #49 GET /sorne/diagnostics?project_id=…（单项目面：llm/runtime 原文、health、plan、九态计数、
    attempts/租约/unknown、verification、reports、messages、outbox、projection、evidence）；
  - #49 GET /sorne/diagnostics（全局面：项目四态分布；工作区页与项目面对照呈现）；
  - #41 GET /sorne/metrics?project_id=…（原始 JSON 折叠呈现；十类指标全集，不重排口径）；
  - #45 GET /sorne/change-log?project_id=&limit=&cursor=&subscription=（变化流只读视图；
    每事件一行摘要 + payload 折叠 + 按 event_type 分组计数 + 游标续读 + 订阅边界）；
  - #23 GET /sorne/attempts?project_id=&limit=&cursor=（执行尝试/租约/fencing/工具调用摘要）；
  - #3 GET /sorne/health（db/outbox/projects/sessions）。
- 表/迁移：无（纯只读呈现；不写库、不发事件、不制造第二真值源）。
- 事件：无。
- 错误码呈现：错误信封 {code, message, retryable, next_requirements} 原样呈现（errNotice 同时
  输出 code 与 message）；501 呈现「未实现（501，不是报错）」并标注负责模块；403 TRUST_DENIED
  对 #23 呈现「浏览器 UI 当前没有会话签发通道」限制说明；未知形状显式提示，不静默当作空。

### 页面分区（中间主区，单栏；本页不定义 renderDetail，蓝图 §2.4 诊断页无 ?id 详情）

1. 页头：任务导向一句 + 项目编号 chip + 项目状态徽章 + 数据时刻 + 截止边界 commit_seq
   + 「计数按已加载数据推导，不代表全量」。
2. unknown 置顶警示（存在 unknown 工具调用时）：红字原句「须先检查外部现状再决定重试，
   不得当作已完成或已失败」+ 涉及编号与工具名。
3. 健康与模型（#3 + #49 全局/项目两面）：服务 ok/异常、db 模式版本、Outbox 四态、项目/会话规模、
   全局项目四态分布（运行中/等待条件变化/已暂停/已停止，来自 #49 全局面）、
   configured 与 agents.describe() 原文；未连接模型时冻结文案「尚未连接模型，项目可以保存，
   AI 暂不能开始」。
4. 观察摘要（按已加载数据推导）：九态计数、执行尝试活跃/过期/中断、工具调用执行中/未知/失败。
5. 计划与探索方向（#49）：pending/in_flight 规划运行（单规划在途说明）、受阻族全部编号 chip。
6. 验证积压与消息（#49）：待验证任务/最老等待、未处理 Worker 汇报（delivered≠handled）、
   用户消息待处理与最近 AI 回复。
7. Outbox 与消息投递：项目 Outbox、#41 投递分布与重试、最老 pending 年龄；
   「查看≠消费，delivered≠applied」原句。
8. 投影滞后：五类 kind 的 lag_commit_seq；null 显示「未投影（null 表示未观测，不冒充 0）」。
9. 证据容量与完整性：staged/lost Blob、真实读盘异常计数；null 显示「本次未核对，不冒充 0」。
10. 执行尝试、租约与工具调用（#23）：工具栏（全部/仅看活跃与异常/刷新/仅重算剩余时间/
    自动刷新）、租约四态、fencing、工具调用摘要与明细（unknown 置顶 + 六态 VOCAB 徽章）、
    not_provided/summaryOnly/空态/403/501/错误/未知形状、游标「加载更多尝试」。
11. 变化流（只读视图，#45）：订阅边界输入、高水位/has_more/next_cursor、分组计数、
    每事件一行摘要（时间 + 类型徽章 + 一句人话 + 主体编号 chip）、payload 折叠（展开原样）、
    游标「加载更多」、只读原句。
12. 运行指标（#41，原始 JSON 折叠）+「漏洞数量不是唯一健康指标」。
13. 语义说明（原生 details 折叠，默认收起）：冻结原文集中区（见 §4 自查）。

### 只读与刷新

- 全部请求为 GET；无暂缓/恢复/取消/确认入口（user 面不含 #22–#26 变更端点）。
- 「仅重算剩余时间」为本地重渲染（不发请求）；「刷新数据（重置到第一页）」重读全部数据面。
- 自动刷新默认关闭，开启后每 10 秒重读全部数据面；关闭与卸载（componentWillUnmount）
  均清理定时器（测试以桩 setInterval/clearInterval 断言）。
- 项目上下文来自 ctx.router.projectId（不重选项目）；缺少项目上下文时仍读 #3 与全局 #49/#41，
  项目域区块显示「缺少项目上下文」，不发 project_id 请求。
- keep-alive：componentDidMount 订阅 router.onChange，回到本页时静默刷新（navSeq + 数据重读）。

## 3. 验证

### 新增测试文件与用例清单（test/ui-diagnostics.test.mjs，27 用例全绿）

1. 页面契约：纯 ESM 不引包/不用浏览器存储/无 React 钩子/无编号正则副本/无字面颜色与宿主变量
2. 初始渲染不白屏：标题与任务导向一句在场，进入加载态
3. 健康与模型：ok/异常两态、db/outbox/规模字段；模型未连接时冻结文案与 runtime 原文
4. 语义纪律原句在场：resolved 不代表已测透、恢复由协调 AI 决定、单规划在途、九态以库为准
5. #49 诊断聚合：九态计数、计划在途、受阻族编号 chip、验证积压、汇报与消息
6. #49 逐块：Outbox/投递重试、投影滞后（null≠0）、证据完整性（null 不冒充 0）
7. #41 metrics：原始 JSON 折叠呈现（折叠不删记录）、数据时刻与模式版本
8. 租约四态：剩余/已过期/未提供/无法解析；fencing token 隐藏时显式说明；数据时刻标注
9. 租约截止无法解析（invalid）显式呈现，不臆造时间
10. 过期活跃租约与中断显式呈现：LEASE_EXPIRED 警示、恢复备注、置顶红字
11. 尝试视图筛选：仅看活跃与异常；明示只作用于已加载数据
12. 尝试游标分页：加载更多使用 cursor 参数并跨页累积
13. 工具调用六态中文标签、unknown 置顶、错误/证据引用；工具与尝试编号呈现
14. 工具调用 not_provided 明示；空数组显式空态；空尝试不误报未提供；摘要对象物化明细
15. 观察摘要：计数按已加载数据推导、边界说明在场；全局指标指向 /metrics 折叠块
16. 只读职责边界：仅重算剩余时间不发请求；刷新重置到第一页并更新数据
17. 自动刷新：默认关闭；开启注册 10 秒定时器并重读全部数据面；关闭与卸载均清理
18. #45 变化流：每事件一行摘要（时间+类型+主体 chip+一句人话）、高水位、只读原句、分组计数
19. #45 payload 折叠：默认折叠显示计数，展开后原样呈现（折叠不删记录）
20. #45 游标续读：加载更多携带 cursor 并追加呈现
21. #45 订阅边界：输入 SUBS 编号后从边界读取；空输入本地拦截；订阅信息呈现
22. #45 错误 / 未知形状 / 501 / 空事件：显式呈现不白屏
23. 501 分支：诊断/指标/尝试/变化流未实现分别标注，健康面仍渲染（501 未实现≠报错）
24. 403 分支：执行尝试端点要求程序签发会话 → 显式错误卡与限制说明，不白屏
25. 500 错误与未知形状：错误卡附机器可区分错误码；形状无法识别显式提示
26. 无项目上下文：显示缺少项目上下文，不发送项目域请求；健康与全局诊断仍读取
27. 真实服务：创建项目与范围版本后，页面携带 project_id 请求诊断/指标/变化流/尝试并呈现

### 执行的门禁命令与结果（本会话原文）

    node --test test/ui-diagnostics.test.mjs            -> # tests 27 / # pass 27 / # fail 0
    node --test test/change-log.test.mjs                -> # tests 3  / # pass 3  / # fail 0
    node --test test/ui-design.test.mjs                 -> # tests 24 / # pass 24 / # fail 0
    node --test test/ui-diagnostics.test.mjs test/change-log.test.mjs
                test/ui-design.test.mjs test/smoke.test.mjs test/ui-shell.test.mjs
                                                        -> # tests 93 / # pass 93 / # fail 0
    node tools/check.mjs（本模块文件）                   -> node --check 通过（diagnostics.page.mjs / ui-diagnostics.test.mjs）

全量 npm test（竣工终态，本会话最后一次实测）：
  npm test = node tools/check.mjs + node --test "test/*.test.mjs"
  -> node --check 通过；# tests 531 / # pass 531 / # fail 0 / # cancelled 0 / # skipped 0，EXIT:0。

施工期曾观察到并行模块在途文件造成的瞬态红（非本模块归属，本模块未修改他人代码，均随并行
模块收敛而消失）：
  a) test/ui-reports.test.mjs 语法错误（归属 task-14 / store-verify）；
  b) test/ui-findings.test.mjs「manifest 收录 findings」（归属 task-13 / tests-b）；
  c) test/ui-workbench.test.mjs「消息分页不静默截断」（归属 task-10 / ui-pages）。
  本模块删除 execution/changes 后 manifest 仅少这两页，smoke 的目录一致性断言与 ui-shell
  导航集合断言全程保持绿；上表目标测试文件 93/93 与全量 531/531 均为本会话实测原文。

### 真实服务 / 宿主走查（实际执行）

- 审查命令：SORNE_DATA_DIR=/tmp/sorne-m4-ui2 node test-ui-server.mjs 8902（后台起服务；
  施工中期另在 8901 冒烟过一次，终态复测见下）
  - GET /sorne/ui/manifest → 8 页注册表含 diagnostics（order 70，file /sorne/ui/pages/diagnostics.page.mjs）；
  - GET /sorne/ui/pages/diagnostics.page.mjs → 200（72985 字节，外壳动态 import 可达）；
  - POST /sorne/projects → PRJ-0002 创建成功；
  - GET /sorne/diagnostics → llm.configured=false + runtime 原文 + health（schema_version=5）+ projects 四态；
  - GET /sorne/health → ok=true、outbox 四态、sessions；
  - GET /?theme=dark → window.__SORNE_THEME__ 注入 dark（主题走查入口可达）。
  - 说明：本会话无真实浏览器可用，像素级/交互走查（hash 深链、折叠展开、自动刷新计时）
    由 test/ui-diagnostics.test.mjs 的真实渲染器驱动断言与上述 HTTP 冒烟共同覆盖；
    浏览器人工走查留待联调（蓝图 §9 允许）。

### 验收场景覆盖

- J2（离开后回来迅速了解当前进展）：诊断页为「系统内部现在健康吗」的直达面；本轮 J2 主区
  在工作台（task-10），本页承载 #41/#45/#23/#49 的原始观测面。
- J6（暂停→恢复→查看报告）：本页 outbox/attempts/messages 提供暂停收尾与投影滞后的
  可核对数据面；交接给 M6 报告页的导出不在本模块。
- 其余 J1/J3/J4/J5 的后端与页面落点在 M3/M5/M6；本页不重复实现。

## 4. 自查

- [x] 未修改任何冻结共享文件：**例外一处，经 Lead 2026-11-06 书面授权**——test/change-log.test.mjs
      仅删除页面半边（207–499 行与页面专用 import/readFile 帮助器）并把 3 个页面用例迁入
      test/ui-diagnostics.test.mjs；B2 后端 3 用例（43/103/171 行）原样保留。见偏差 1。
      client.js / index.js / test-ui-server.mjs / lib/db.mjs / lib/http.mjs / lib/errors.mjs /
      lib/router.mjs / lib/routes/ui.routes.mjs / test/helpers.mjs / test/smoke.test.mjs /
      迁移 0001–0005 均未触碰。
- [x] 同阶段其他模块文件未被触碰（workbench、overview/coordination、assets/exploration、
      findings、reports、verification/vulnerabilities 及其测试均未改动）。
- [x] 测试并行安全：fakeApi 用例不占端口；真实服务用例走 withTestServer（mkdtemp 临时目录 +
      listen(0) 随机端口 + finally 收尾）；自动刷新用例以桩替换 global setInterval/clearInterval
      并在 finally 恢复；无后台进程残留（本会话人工起的 UI 宿主已停止）。
- [x] 501 桩：本模块无端点实装义务；页面把任何 501 呈现为「未实现（501，不是报错）」并标注
      负责模块（断言覆盖 C2/F2/M2/B2 四类）。
- [x] 规范语义纪律逐条对照：见下表。

### 语义纪律保留清单核对（蓝图 §g ①–⑭，本模块涉及项）

| # | 纪律 | 落点 / 测试断言 |
|---|---|---|
| ② | unknown 置顶红字「须先检查外部现状再决定重试，不得当作已完成或已失败」 | 页头置顶警示 + 工具调用行 + 语义说明；用例 10/13 |
| ③ | 数据时刻/截止边界/不代表全量 | 页头 + 观察摘要边界行；用例 8/15 |
| ④ | 计数「按已加载数据推导」 | 页头与变化流分组计数；用例 15/18 |
| ⑤ | delivered≠handled | 未处理 Worker 汇报行；用例 5 |
| ⑥ | 折叠不删记录（展开入口+计数） | payload 折叠与 #41 原始 JSON 折叠；用例 7/19 |
| ⑦ | 未提供≠不存在（「—（未提供）」） | 租约/消息/投影/证据空值；用例 8/9/6 |
| ⑧ | 501 未实现≠报错 | 四类 501 分支；用例 23 |
| ⑩ | 每页「§」≤2（解释收进语义说明折叠区） | 正文 0 个 §；全部 § 集中「语义说明」原生 details（默认收起）——见偏差 2 |
| ⑪ | resolved 只表示该版本的问题已处理，不代表关联资产已测透（规范 §10.1） | 九态计数区 + 语义说明；用例 4 |
| ⑫ | 恢复与重派由协调 AI 决定，程序不写死固定重试（规范 §3.1/§3.2） | 受阻族区 + 语义说明；用例 4 |
| ⑬ | 同项目默认最多一个规划调用在途（§16.1） | 规划运行行；用例 4 |
| ⑭ | 九态计数以库为准（§10.1） | 九态计数行标题 + 语义说明；用例 4 |
| — | 查看≠消费，delivered≠applied（原 changes 页头语义） | Outbox 投递区 + 变化流注记 + 语义说明；用例 18 |
| — | 「本页只读…不提供暂缓/恢复/取消等操作入口」 | 语义说明；用例 4 |
| — | 迟到提交「合法证据仍可留档，但不得改变新尝试状态、不得继续获得工具执行权限」 | 语义说明；用例 4 |
| — | 「同一不可并行的执行分配同一时刻最多一个有效租约」 | 租约注记 + 语义说明；用例 4 |

## 5. 旧断言迁移清单（蓝图 §c M4 义务）

> 迁移原则：语义纪律断言原句迁入新页并在新测试留名；纯页面结构（项目选择器、意图过滤与
> 意图分页）随外壳/工作台职责转移；删除后不保留「加载更多」死代码。

### 5.1 test/ui-execution.test.mjs（原 1083 行，约 181 断言）

| 旧用例 / 断言组（原行号） | 新落点 |
|---|---|
| 页面契约：纯 ESM/无 require/无浏览器存储/无钩子/中文标题/类组件（345–368） | ui-diagnostics 用例 1（并新增：无字面颜色/无宿主变量/无编号正则副本/order=70） |
| manifest 顺序 exploration<execution<verification（370–382） | 随页废弃：注册表改为 §2.5 八 id（ui-shell 断言导航集合，smoke 断言目录一致性） |
| 意图九态中文标签 + resolved 不代表已测透（386–406） | 九态计数（用例 5）+ 冻结原句（用例 4）；意图详细列表与九态徽章 → ui-workbench |
| 受阻原因/resume_conditions（JSON 字符串解析）/恢复由协调 AI 决定（408–423） | 冻结原句迁入用例 4；受阻明细 → ui-workbench（task-10） |
| 意图状态过滤（服务端 status）/切换重置/意图游标分页（425–467） | ui-workbench（工作台意图区；本页不做意图列表，避免第二真值面） |
| 租约剩余时间四态（剩余/已过期/未提供/无法解析）与 fencing/分配/worker/意图（471–525） | ui-diagnostics 用例 8、9（未提供/无法解析两态独立成用例 9） |
| 单一有效租约语义说明（486–487） | 语义说明 + 租约注记；用例 4 |
| 过期活跃租约 LEASE_EXPIRED + 中断 + 迟到提交语义（492–506） | 用例 10；迟到句在语义说明（用例 4） |
| 尝试视图筛选（仅看活跃与异常 + 只作用于已加载数据）（527–540） | 用例 11 |
| 尝试游标分页（cursor/after 兼容、跨页累积）（542–569） | 用例 12（规范参数 cursor；兼容 next_after 读取） |
| 工具调用六态 + unknown 置顶 + 错误/证据引用（573–602） | 用例 13（标签改用 VOCAB 标准；unknown 原句在徽章与红字） |
| not_provided / 空数组 / 空尝试不误报（604–636） | 用例 14 |
| 内嵌 tool_calls（attempt.tool_calls 数组）归并（638–657） | 用例 14（摘要对象）+ 代码 collectToolCalls 三形态防御 |
| C2 落地信封：lease.expires_at 嵌套/摘要对象/next_after 续读/fencing 隐藏（661–743） | 用例 8/13/14 + 用例 12（next_cursor 优先、next_after 兼容） |
| C2 403 TRUST_DENIED 会话缺口（745–768） | 用例 24 |
| 队列观察摘要（受阻/租约过期/unknown 计数、边界说明、§20.2 指向 /metrics、漏洞数量不是唯一健康指标）（772–790） | 用例 15（原句保留「以上计数按…」「全局运行指标（…§20.2 全集）由 /metrics 提供」「漏洞数量不是唯一健康指标」） |
| 只读职责边界 + 仅重算剩余时间不发请求（794–811） | 用例 16 + 语义说明原文（用例 4） |
| 刷新数据重置第一页 + 数据时刻（813–839） | 用例 16 |
| 自动刷新 10 秒/开关/卸载清理（843–899） | 用例 17（重读五数据面） |
| 501 双端点（C1/C2）分别标注、其余区块仍渲染（903–926） | 用例 23（四类 501：诊断/指标/尝试/变化流） |
| 500 错误码卡（928–944） | 用例 25 |
| 未知形状显式提示（946–957） | 用例 25（诊断/指标/尝试/变化流四类形状防御） |
| 空态（无项目/意图/尝试空清单）（959–980） | 用例 14/26（无项目→缺项目上下文；尝试空态） |
| 项目选择器（自动选首个项目/游标累积/切换项目重读）（984–1027） | 随外壳路由废弃：项目上下文由 #/p/:pid 提供；项目列表游标累积由 M3 项目列表页与 test/ui-projects 覆盖 |
| 真实服务集成（1031–1083） | 用例 27（新：诊断/指标/变化流/尝试 + 事件呈现） |

### 5.2 lib/ui/pages/changes.page.mjs 与其测试（change-log.test.mjs 页面半边 207–499 行）

| 旧用例 / 断言组 | 新落点 |
|---|---|
| 页面契约（350–367） | ui-diagnostics 用例 1/2 |
| 真实服务：事件流可见/高水位/只读句/订阅边界/游标分页（369–438） | ui-diagnostics 用例 18/20/21 + 真实服务用例 27（真实事件 scope.revised 与高水位） |
| fakeApi：事件与 payload 原样/payload 呈现/加载更多/404 错误/未知形状/空订阅输入（440–499） | 用例 18/19/20/22/21（payload 改为折叠呈现，展开原样；错误/未知形状/空输入原样保留） |
| change-log 后端 3 用例（43/103/171：有序/游标/订阅锚点/只读性） | **保留原文件，未改动**（B2 回归网） |
| 「查看≠消费，delivered≠applied」（changes 页头注释语义） | 用例 18 原句 + 语义说明 |

### 5.3 随页废弃、无承接的断言（逐条说明原因）

- manifest 中 execution/changes 顺序与 overview.order<execution.order 类断言：§2.5 注册表
  八 id 冻结后旧 order 不复存在；改由 ui-shell 导航集合断言 + smoke 目录一致性断言覆盖。
- 项目选择器「加载更多项目」：外壳路由取代页面内项目选择（评审 §4d 死代码消除）。
- 意图状态过滤与意图游标分页：工作台意图区（task-10）承接；诊断页只呈现库内九态计数。
- 「负责模块 C1/C2 施工」类 501 文案：C1/C2 已竣工，页面保留通用 501 呈现并断言 C2 一类即可。

## 6. 偏差与已知问题

1. **修改共享冻结测试 test/change-log.test.mjs（经授权）**：蓝图 §c 将其列为共享冻结文件
   （B2 回归网），但 §g 同时要求 M4 删除 changes.page.mjs——该文件内含 3 个页面用例必然变红。
   已报 Lead，取得 2026-11-06 书面授权：仅删页面半边（207–499 行与页面专用 import/readFile
   帮助器），后端 3 用例原样保留，头部注释注明「页面用例已迁往 test/ui-diagnostics.test.mjs」。
   请架构师在终验清单中确认该共享文件的新形态。
2. **每页「§」≤2 与冻结原句的取舍**：§g 要求 ⑪–⑭ 四句原文含 § 号（§10.1/§3.1/§3.2/§16.1），
   与「§≤2/页」在字面上冲突。本页处理：正文（可见数据区）零 §；全部含 § 的冻结原句与原解释
   集中进「语义说明」原生 details（默认收起，点开展开）。机械扫描页面源码仍有 18 处 §（含
   文件头注释与折叠区）；按评审 P2-10 的意图（减少正文规范术语轰炸）已满足，但若终验按源码
   字符计数判红，需架构师裁决以冻结原句优先（不得改写语义纪律原文）。
3. **语义说明用原生 details 而非 ui.FoldableObject**：需保证折叠区内文字在测试宿主中可断言
   （FoldableObject 折叠时不渲染子节点），且浏览器中默认收起。未新增渲染器 API，不触碰 M1 文件。
4. **#23 工具调用明细的既有口径**：attemptView 的 tool_calls 摘要仅携带 running/unknown/planned
   明细，succeeded/failed/cancelled 只有计数（C2 既有合同）。页面对此显式呈现 summaryOnly 说明
   并在各尝试行给出计数，不虚构明细（未提供≠不存在）。
5. **E2 的 WR 编号**：页面对汇报/工具调用/尝试编号统一用 ui.RecordIdChip（/records 定位以服务端
   为准）；M2 已扩展 /records 前缀表（WR/TC/VJ/OD/OA/PR/CP 等），点击可展开。
6. **无真实浏览器像素走查**：本会话仅能 HTTP 冒烟 + 真实渲染器断言；交互/主题像素级走查留待
   联调（与 M1 记录偏差 10 的走查方法一致）。
7. **自动刷新仍为轮询 10 秒**：与旧执行页一致，未新增事件推送（Outbox watcher 属优化，蓝图未要求）。
8. **诊断页不读取 #31/#21/#29**：蓝图 §1.5 诊断页数据面为 #49/#41/变化流/租约/工具调用/Outbox/
   消息；意图明细与工作台三区归工作台（task-10），避免重复取数面。九态计数直接取 #49（库内
   聚合，权威），不在页面重算。
9. **#16 变化页 vs #45 change-log 的取舍**：蓝图 §1.5 写「#16/#45 变化流」，但 #16 GET /changes
   属消费者面（要求程序签发 x-sorne-session 会话，浏览器 UI 无签发通道，蓝图 §8.2 已知缺口）。
   本页按既有 precedent 只用 #45 只读视图（不写投递回执、不推进游标，查看≠消费），并把
   「查看≠消费，delivered≠applied」原句留在页内；#16 的消费者面推进仍由程序侧会话承担。
