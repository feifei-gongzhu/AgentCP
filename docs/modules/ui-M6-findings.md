# ui-M6-findings 竣工记录 —— 发现页（M6 发现半边）

> 施工者只写本文件与自己独占的代码/测试文件；蓝图（../BLUEPRINT-UI.md，冻结契约 v1.1）
> 与实现冲突时先停工上报架构师，不得就地改契约。

## 1. 基本信息

- 模块 ID / 阶段：ui-M6-findings / 前端重构第二批（M6「发现与报告」的发现半边；
  报告页 reports.page.mjs 不在本任务卡范围，归 M6 报告施工单元）
- 负责规范章节：BLUEPRINT-UI §1.5 发现（#30/#29/#14/#43/#44）、§1.6「请求复核」行动落点、
  §2.2 语义纪律、§2.4-2 右侧详情槽位、§e-J3、§f P0-3（游标）/P0-4（subject_kind）、
  §g 旧页处置（verification/vulnerabilities → 发现页）
- 独占文件（与任务卡 write_scopes 一致）：
  - 新增：lib/ui/pages/findings.page.mjs、test/ui-findings.test.mjs
  - 删除：lib/ui/pages/verification.page.mjs、lib/ui/pages/vulnerabilities.page.mjs、
    test/ui-verification.test.mjs（删除前语义断言逐条迁移，见 §3）
  - 本记录
- 开工日期 / 竣工日期：2026-11-06 / 2026-11-06

## 2. 实现范围

- 端点（既有，无新增）：#30 GET /sorne/vulnerabilities（列表、status/review 服务端过滤、
  cursor 分页）；#29 GET /sorne/verification-jobs（subject_id 过滤；cursor 主路径 +
  after 兼容）；#14 GET /sorne/records/{id}（记录 + evidence_index）；#44
  GET /sorne/captures/{id}；#43 GET /sorne/evidence/blobs/{sha256}；#21
  GET /sorne/intents（后续探索关联）；#46 POST /sorne/projects/{id}/messages（请求复核）。
- 表/迁移：无（只读消费既有端点；消息写入走 #46 既有实现）。
- 事件：无新增事件；请求复核经 #46 产生既有 message.received 语义（delivered≠handled）。
- 错误码：只呈现服务端信封（BAD_REQUEST / TRUST_DENIED / NOT_FOUND / INTERNAL_ERROR 等），
  不新增错误码。

### 实现要点

- 主表用 ui.DataTable（真表格、aria-sort、行点击）：列 = 发现（编号 chip + 类别/位置 +
  适用条件）/ 状态徽章（vulnerability_status）/ 复核状态徽章（review_status）/ 证据入口
  （支持·反对·共计数按钮 → 详情）/ 确认版本（ui.FoldableObject 默认折叠、显示折叠计数）。
- 行点击与证据入口均 router.open("#/p/:pid/findings?id=V-…")（§2.4-2 push 详情）。
- 详情（renderDetail(ctx)，从 ctx.router.params.id 取编号）：GET /records/{id} 得记录 +
  evidence_index；每条证据成员可展开：成员记录（#14）→ capture_id → 采集（#44）→
  response_body_blob.sha256 → 原始字节（#43，按需读取，页面不复制内容）。
- 验证经过（#29）：Manifest 编号/成员数/证据集版本/内容哈希（ui.formatHash）、
  outcome 徽章、applied 三态（false 显式红字「未应用——验证意见已保存，标记需复核，
  不覆盖新结论」）、等待时长（仅非终态任务、按 waiting_ms 或创建时刻）、
  reviewed_evidence_revision 显示实际值（未提供才显示「—（未提供）」）。
- 加载更多（验证区）：信封 next_cursor→cursor 主路径；仅 next_after 的旧信封→after
  兼容（P0-3 双分支；旧 ui-verification.test.mjs:641 写死 after 的错误契约随删测移除）。
- 「请求复核」= 展开编辑框（预填待核实判断/条件）→ POST /sorne/projects/{id}/messages；
  回执显示消息状态（received → 「已接收（尚未处理）」）+「本页不直接修改漏洞状态」；
  页面不调用 /verification-requests、/verification-results、/lifecycle。
- 后续探索：GET /intents?project_id=&limit=100，按 basis_refs/prerequisite_refs
  引用当前发现过滤，显式标注「按已加载意图推导，不代表全量」。
- 语义纪律：状态/复核/结论全部经 ui.StatusBadge 词表（confirmed「已确认（限指定条件）」、
  inconclusive「证据不足：未确认，不伪装成已排除」、falsified「已证伪（不等于历史上不存在）」）；
  「数据时刻 / 已加载数据推导 / 不代表全量」「—（未提供）」、折叠计数与展开入口齐备；
  每页可见「§」2 处（语义说明折叠区内）。
- P0-4：不再自造 subject_kind 字典型标签，统一 ui.StatusBadge("subject_kind", …)；
  源文件与渲染文本均不含「未知类型（」。

## 3. 验证

### 新增测试文件与用例清单（test/ui-findings.test.mjs，17 用例）

1. M6 页面契约：纯 ESM 不引包、无存储/钩子、无编号正则副本、无字面颜色值/宿主变量、
   注册表 id/title/order、render+renderDetail 齐备；源文件不含「未知类型（」。
2. 主表四态/三态徽章分列（冻结文案）与行点击 → #/p/PRJ-0001/findings?id=V-0002。
3. 条件逐条、证据计数入口、确认版本折叠计数与展开内容（折叠不删记录）。
4. 服务端筛选 #30 status/review 参数并重置第一页。
5. 主表游标分页：加载更多带 cursor、跨页累积、已加载/总数标注。
6. 数据时刻/按已加载数据推导/不代表全量；§ 引用 ≤2。
7. 空态、无项目（不发请求）、错误态、形状无法识别。
8. 详情条件/版本字段实际值/确认版本折叠与「—（未提供）」。
9. 详情证据索引 #14 → 采集 #44 → 原始字节 #43；成员 chip → openRecord（J3 页面半边）。
10. 验证经过：Manifest 摘要、outcome 徽章、applied=0 警示、等待时长、reviewed_evidence_revision 实际值、无结论诚实呈现。
11. P0-4 永久闸：旧物理表名（vulnerabilities）与未知 subject_kind 均不出现「未知类型（」，未知状态显式呈现。
12. 验证区加载更多 cursor 主路径（next_cursor→cursor）跨页累积。
13. 验证区加载更多 after 兼容路径（仅 next_after→after）。
14. 后续探索按 basis_refs/prerequisite_refs 关联并注明按已加载意图推导。
15. 请求复核只发 #46 用户消息；回执 delivered≠handled；不调用任何改状态端点。
16. 详情错误卡可重试、无 id 深链缺参不白屏。
17. 真实服务：manifest 收录 findings（旧 verification/vulnerabilities 已不在）；真实 #30 台账渲染 suspected 与条件；详情 #29 空队列诚实呈现、证据成员展开呈现观察记录。

### 旧测试语义断言迁移清单（删 test/ui-verification.test.mjs 前逐条核对）

| 旧断言（语义纪律原文/判据） | 旧落点 | 新落点 |
|---|---|---|
| confirmed 永远带「（限指定条件）」 | ui-verification.test.mjs 漏洞台账用例（旧 706 一带）/旧 vulnerabilities 页 :757-763 | test/ui-findings.test.mjs 用例 2（渲染文本断言）；实现为 ui.VOCAB.vulnerability_status.confirmed |
| insufficient「证据不足：未确认，不伪装成已排除」 | 旧验证结论用例（旧 528 一带）/旧页 :867-880 | 用例 2（徽章文本）；ui.VOCAB.vulnerability_status.inconclusive 与 outcome.insufficient |
| falsified「不等于历史上不存在」 | 旧验证结论用例/旧页 :867-880 | 用例 2；VOCAB 两处词表 |
| 未应用意见警示（applied=0 显式保留意见，不隐藏） | 旧「验证结论 outcome」用例（旧 528-545） | 用例 10（详情验证经过红字 + 「意见已保存、标记需复核、不覆盖新结论」） |
| 按已加载数据推导 / 不代表全量 | 旧「验证观察摘要」用例（旧 617-640） | 用例 6（列表页脚）+ 用例 14（后续探索）+ 用例 10（详情数据时刻） |
| （新增）已提交 reviewed_evidence_revision 必须显示实际值 | 旧测试无（评审 §7b / 蓝图 §d-2 后端补齐后的页面义务） | 用例 10：审阅证据集版本：7，且断言不出现「—（未提供）」 |
| 旧游标错误契约（next_after → after 参数写死） | ui-verification.test.mjs:641 | 用例 12+13 双分支替代（P0-3 ③） |
| 旧页其余 UI 断言（项目选择器/501 桩/刷新/摘要计数/台账筛选等） | ui-verification.test.mjs 全文 | 随旧页删除而作废（页面职责并入发现页后由本文件 17 用例重新覆盖：筛选/分页/空态/错误/详情/证据/验证/消息）；不再保留「项目选择器」断言——项目上下文由外壳顶栏与路由提供（M1 职责） |

### 执行的门禁命令与结果（原文摘录）

    $ node --test test/ui-findings.test.mjs test/ui-design.test.mjs test/ui-shell.test.mjs test/smoke.test.mjs
    1..80
    # tests 80
    # pass 80
    # fail 0

    $ node --test test/ui-findings.test.mjs
    1..17
    # tests 17
    # pass 17
    # fail 0

    $ node tools/check.mjs
    node --check 通过：116 个源文件

全量 npm test（= check + node --test "test/*.test.mjs"）本模块竣工时点结果（并行施工窗口）：
# tests 528 / # pass 527 / # fail 1。唯一失败为 test/ui-maps.test.mjs:886
「资产页：项目切换后按新 project_id 重读，旧资产不残留」——属 M5 资产页重写施工面
（该页与 ui-maps 测试正在并行改写），与 M6-findings 无关；本模块未修改其文件。
本模块唯一改动面（findings 页/测试/删除两旧页与旧测）在组合门禁 80 用例中全绿，
全量中 findings 相关用例（含真实服务）亦全绿。

### 验收场景覆盖

- J3：用例 9（发现详情 → 证据成员 → #44/#43 → 成员编号 openRecord 覆盖层），
  详情保持原位（返回栈关闭动作由 M1 ui-shell 覆盖层用例负责，本页只发起 push）。
- P0-3：用例 5（列表 cursor）、12/13（验证区 cursor + after 兼容）。
- P0-4：用例 1（源文件）/11（渲染文本）「未知类型（」0 次。
- §g verification/vulnerabilities 旧页内容去向：验证队列 → 发现详情「验证经过」；
  漏洞台账 → 发现页主表；游标修正 → 验证区双分支；reviewed_evidence_revision 视图值 → 详情显示。

### 真实服务 / 本地 UI 走查

- 真实服务用例：withTestServer 临时目录 + listen(0)；创建项目 → worker 提交（资产/观察/
  疑似漏洞/supports 边）→ 发现页渲染真实 #30 行（suspected、条件）、详情 #29 空队列与
  证据索引展开（node --test 通过）。
- 本地 UI 冒烟：SORNE_DATA_DIR=/tmp/… node test-ui-server.mjs 8901 →
  GET /sorne/ui/manifest 含 findings（order 50，注册表一致），
  旧 verification/vulnerabilities 已不在 manifest；/sorne/ui/pages/findings.page.mjs 200；
  /client.js 200；/ 200；收尾已杀进程并删除临时目录。

## 4. 自查

- [x] 未修改任何冻结共享文件（client.js、index.js、test-ui-server.mjs、lib/db.mjs、lib/http.mjs、
  lib/errors.mjs、lib/router.mjs、lib/routes/ui.routes.mjs、test/helpers.mjs、test/smoke.test.mjs、
  迁移 0001–0005 均未触碰）
- [x] 同阶段其他模块文件未被触碰（并发出现的 workbench/diagnostics 页等由其他施工者创建，本模块未改）
- [x] 测试并行安全：17 用例仅 1 个走 withTestServer（mkdtemp + listen(0) + finally 收尾），
  其余进程内 fakeApi 不占端口；无后台进程残留
- [x] 本模块名下无新增端点/无 501 桩
- [x] 规范引用章节逐条对照，无省略（语义纪律 6 条 + 边界口径 4 条均落在文案/断言）

## 5. 偏差与已知问题

1. M6 任务卡范围：本次只交付「发现」半边；reports.page.mjs 重写与
   test/ui-reports.test.mjs 重写属 M6 报告施工单元（全量门禁中该旧测试仍红，属其责任面）。
2. J3 返回栈断言归属：关闭详情/覆盖层回到原位由 M1 外壳（lib/ui/router.mjs
   返回栈 + client.js 详情槽位）实现，ui-shell 已有两分支用例；本页测试只验证
   「详情 push（?id=）」与「证据成员 openRecord」两个页面动作，未重复实现外壳断言。
3. 详情验证区未做服务端分页排序以外的高级过滤：按 subject_id + cursor 读取；
   「加载更多」在任务数少时只出现一页（测试覆盖双分支 mock）。
4. 后续探索关联为客户端过滤：GET /intents?limit=100 后按 basis_refs/prerequisite_refs
   过滤，超过 100 条时可能漏关联（页面标注「按已加载意图推导，不代表全量」；
   后续可由后端补 subject 过滤参数，不在本批契约内）。
5. 证据采集缺失的诚实降级：成员记录无 capture_id 时显示「采集：—（未提供）」，
   不伪造原始证据（真实服务用例覆盖该分支）。
6. 未做浏览器像素级走查：本轮以本地 harness HTTP 冒烟 + 测试宿主元素树断言为准；
   §10-1 允许的降级路径，终验时随整体 UI 走查复核。
