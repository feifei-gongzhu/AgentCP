# ui-M5 竣工记录 —— 资产与探索页（前端重构 M5）

> 施工者只写本文件与自己独占的代码/测试文件；蓝图（../BLUEPRINT-UI.md，冻结契约 v1.1）
> 是冻结契约，与实现冲突时先停工上报架构师，不得就地改契约。

## 1. 基本信息

- 模块 ID / 阶段：ui-M5 / 前端重构（M5「资产与探索」；M1/M2 竣工后并行）
- 负责规范章节：§15.1/§15.2/§15.3（Map 快照、订阅边界、折叠纪律）、§10.1（意图合同/方向）、
  §7.2（接口模板可修正判断）、§8.2/§8.4（状态不夸大呈现）、§11.2（#13/#14 读取）、
  §13/§8.3（#43/#44 证据读取入口）、§18.6（消息闭环的「采取行动」半边）、
  BLUEPRINT-UI §1.5（五页职责边界）、§1.6（查看信息→采取行动）、§2.2–§2.5（渲染器/编号/路由/
  页面契约）、§2.4-2（右侧详情槽位）、§g（旧页处置与语义纪律保留清单）、§e-J5、
  §f P0-1②（字面颜色闸）/P0-2②（编号解析唯一实现，前端半边）
- 独占文件（与蓝图 §c M5 一致，未增删）：
  - `lib/ui/pages/assets.page.mjs`（重写）
  - `lib/ui/pages/exploration.page.mjs`（重写）
  - `test/ui-maps.test.mjs`（重写，沿用原名）
  - 本竣工记录
- 开工日期 / 竣工日期：2026-11-06 / 2026-11-06

## 2. 实现范围

- 端点（只消费，无新端点；号段以 docs/modules/ui-M2.md §6 最终映射为准）：
  - `GET /sorne/snapshots/asset_map?project_id=&fold_since=`（#13；五块 + 折叠展开）
  - `GET /sorne/snapshots/exploration_map?project_id=`（#13；方向分组/依据/未解决问题/关系边）
  - `GET /sorne/intents?project_id=&limit=&cursor=`（#21；方向合同字段）
  - `GET /sorne/records/{id}?project_id=`（#14；资产/方向详情与关系边）
  - `GET /sorne/captures/{id}?project_id=`（#44；采集详情：请求 URL/响应字节/读取入口）
  - `POST /sorne/messages`（#46；下任务/追问/建议暂缓草稿）——任务卡写「消息草稿（#49）」，
    按 BLUEPRINT-UI v1.1 变更记录②更正：#46/#47 是消息、#49 是系统诊断（见 §5 偏差 1）。
  - `GET /sorne/evidence/blobs/{sha256}`（#43）仅作为「原始字节读取入口」呈现（不内联字节）。
- 表/迁移：无新增（只读消费既有表与迁移 0001–0006）。
- 事件：无新增（页面只读；消息提交走 #46 既有事件）。
- 错误码：仅呈现既有注册表（NOT_IMPLEMENTED→「未实现」态、INTERNAL_ERROR/RESOURCE_LIMIT→错误卡、
  INVALID_REFERENCE/NOT_FOUND→详情与消息错误原文、TRUST_DENIED→错误卡），未新增业务码。

### 2.1 资产页（五块落点，对应要求 §6 / 蓝图 §1.5）

| 块 | 数据来源与呈现 |
|---|---|
| 站点树 | #13 asset_map groups[].assets + content.edges（discovered_from：from 发现自 to → to 为父）；构树并防环/限深 4 层；关系缺失时按资产类型平铺并注明「关系缺失不等于资产不存在」 |
| 资产列表 | 按 asset_type 分组的真表格（ui.DataTable：编号 chip/规范身份/范围状态徽章/活动提交序号/创建提交序号）；行点击 → #/p/:pid/assets?id=<编号>（右栏详情）；分组折叠块保留「已折叠 N 项 + 样本 + 展开本组（fold_since 续读）」 |
| 技术栈 | 同一 asset_type 分组视图 + 计数；口径如实标注「以资产类型聚合（规范化技术栈画像属后续能力，本块不冒充）」；未登记类型原样呈现 |
| 接口 | #13 content.endpoint_templates（M2 §d-10 增量）：candidate/confirmed 分列（T- chip/方法/路径模板/置信度/服务资产 chip）；split/withdrawn 折叠为计数 + 展开入口；服务端 note/expand 原文呈现；维度缺失时显式「未提供」 |
| 文件及来源 | #14 资产记录 counts（资源/采集/观察/漏洞/指向意图）+ relations.edges 关联编号 chips；采集编号 → #44 读取（请求 URL 原样、响应字节 ui.formatHash、读取入口指向 #43）；记录不可读时如实呈现读取失败/未实现 |

另：快照六要素（快照编号/模式版本/截止提交序号/生成时刻/投影范围/折叠省略说明）+ 订阅边界
（订阅编号/修订/resume_cursor）+「异步投影不代表数据库当前版本」+「本 Map 是派生阅读视图、
可由持久记录完全重建、不是真值来源」；projection_scope 裸串转页头可读行（项目/折叠边界/上限）；
页脚「数据时刻 · 截止边界（提交序号）· 列表与计数按已加载快照推导」。

### 2.2 探索页（方向列表 + 分支图 + 大图）

- 方向列表（主视图）：按 exploration_map.content.directions（目标分组）与 ungrouped_intents 分组；
  意图合同以 #21 为准并回退 #13 摘要（任一端点未实现/出错都不白屏）。每条方向呈现：编号 chip、
  intent_status 词表徽章、类别/优先级、问题、目标（target_asset_ids）、依据（basis_refs）、
  前提（prerequisite_refs）、进展（更新提交序号/状态版本/计划修订）、阻塞（resume_conditions，来自
  意图合同或快照 unresolved.blocked_intents）、后续（依赖它的方向 ids）。
- 局部分支图 `view=graph`：所选方向（或无选中时每条方向）及其直接依据/目标/前提（1 跳），
  以「前提 ──▶ 方向 ──▶ 依据/目标」列式节点 + 真实编号 chip 呈现；明示「局部视图只含直接邻接，
  不代表全量」。视图切换经 router.open 改 hash（?view=graph|full，刷新/分享可复现）。
- 完整大图 `view=full`（辅助）：判断清单（假设/事实/漏洞，状态徽章）+ 全部关系边按 relation_type
  分组（含撤回边「已撤回，历史保留」）+ 关系边总数/省略计数/服务端 omitted_note（不静默截断）。
- 语义说明（§ 计数 = 2/页，符合评审 P2-10）：`resolved 只表示该版本的问题已处理，不代表关联资产
  已测透（规范 §10.1）`、`恢复与重派由协调 AI 决定，程序不写死固定重试（规范 §3.1/§3.2）`；
  另有「状态以持久记录为准、疑似不写作已确认」「折叠不删记录」「未提供 ≠ 不存在」。

### 2.3 右侧详情（renderDetail，§2.4-2 槽位）

- 资产详情：ui.FieldRow（编号/资产类型/规范化键/原始输入/范围状态/规范化版本/活动与创建序号/
  创建时间与者）+ 来源与关联计数 + 来源编号 chips + 相关发现（V/H/F chips）+ 已开展的探索
  （I/ATT chips）+ 关系边（中文标签、from→to chip、撤回标记、requires_state）+「就此资产向 AI 下任务」
  （预填草稿 `请针对资产 <编号>（<规范身份>）安排下一步探索：`；发送 → POST /sorne/messages；
  成功呈现消息编号 chip + message_status 徽章 +「收到 ≠ 已处理」；失败/空内容如实呈现）。
- 方向详情：合同字段（question/kind/status/priority/success_criteria/deliverables/budget/
  resume_conditions/condition_requirements/state_version/plan_revision/scope_revision/updated_seq/
  created_at）+ 目标/依据/前提 chips + 关系边 +「追问 AI」「建议暂缓」两个按钮（分别填预填草稿）
  + 发送（POST /sorne/messages）+ 结果/失败呈现；明示「用户操作不直接改方向状态」。

### 2.4 页面契约与纪律

- 零 import、无浏览器存储、无 React 钩子；`export default { id, title, order, render, renderDetail }`
  （assets 30/资产、exploration 40/探索）；
- 编号一律 ui.RecordIdChip（页内零 RECORD_ID_RE；点击 router.openRecord 完整编号）；时间/哈希/字段/
  表格/空态均由 lib/ui/render.mjs 提供；颜色全部 var(--sorne-*)（页内零字面颜色）；
- 正文 13–14px；中文；每页 § ≤ 2（exploration 页 2 处：§10.1 与 §3.1/§3.2；assets 页 2 处：
  §15.2 与 §15.3）。

## 3. 验证

### 3.1 测试文件与用例清单（test/ui-maps.test.mjs，23 用例全部通过）

- 契约与注册（2）：M5 页面契约（源码禁则 + id/title/order + renderDetail）；M5 manifest（真实服务）。
- 资产页（11）：快照六要素+订阅边界+投影范围可读行+数据时刻/截止边界；五块齐全+真表格列头+
  范围徽章+模板分列+折叠计数+文件及来源入口；URL/路径原样；折叠计数+样本+展开入口+行点击 ?id=；
  文件及来源（#14 计数/编号 + #44 读取含 #43 入口 + 空编号本地拦截）；资产详情（字段/计数/相关发现/
  已开展探索/撤回边/chip→openRecord）；资产详情消息草稿（预填/POST/已接收≠已处理/失败/空内容）；
  快照 501（未实现≠报错+五块置空+记录 501）；快照 500 错误卡+重试；未知形状；空资产+无项目不发请求；
  项目切换不残留。
- 探索页（10）：方向列表（分组/目标/依据/前提/进展/阻塞/后续/徽章/两条语义纪律/派生视图说明）；
  J5 新意图经刷新进入列表且依据/前提随记录呈现 + 详情 hash 带 view/id；视图切换（graph/full）；
  快照 501 时列表回退意图端点、双 501 显式不可用；快照错误/未知形状/空方向空态；项目切换不残留；
  方向详情（合同字段/目标依据前提/关系边/追问与建议暂缓/POST/已接收≠已处理/失败）；方向详情 404
  与无 ?id；真实服务（资产/资源/模板经 D2 操作 + 计划接收经 C1 → 两页呈现真实记录，模板维度双分支）。

### 3.2 门禁命令与结果（原文尾部）

```
$ node --test test/ui-maps.test.mjs
1..23
# tests 23
# pass 23
# fail 0
# duration_ms 135.05

$ node --test test/ui-design.test.mjs      # P0-1② 字面颜色闸 + P0-2 编号解析（重写页已在扫描面内）
# tests 24
# pass 24
# fail 0

$ node --test test/ui-shell.test.mjs       # 外壳/路由/详情槽位/引导门控（未受本模块影响）
# tests 22
# pass 22
# fail 0

$ node tools/check.mjs
node --check 通过：116 个源文件

$ npm test                                  # 全量（施工终态，含并行落盘）
1..531
# tests 531
# pass 531
# fail 0
# duration_ms 2672
```

### 3.3 验收覆盖

- 蓝图 §e-J5：ui-maps 的 J5 用例（fakeApi 双轮刷新 + 真实服务 C1 计划接收两处覆盖）。
- 蓝图 §f P0-1②：重写页面重新入闸（ui-design 扫描 lib/ui/pages/*.page.mjs 零字面颜色命中）；
  P0-2②：两页零 RECORD_ID_RE，ui-design「全站编号解析唯一实现」白名单随重写收缩。
- 蓝图 §g 语义纪律保留：confirmed 限指定条件、未提供≠不存在、折叠不删记录、501 未实现≠报错、
  数据时刻/截止边界/不代表全量、resolved 边界说明、不写死固定重试、编号全部 chip 可点。

## 4. 自查

- [x] 未修改任何冻结共享文件（client.js、index.js、test-ui-server.mjs、lib/db.mjs、lib/http.mjs、
      lib/errors.mjs、lib/router.mjs、lib/routes/ui.routes.mjs、test/helpers.mjs、test/smoke.test.mjs、
      迁移 0001–0006 均未触碰）；未修改 lib/ui/{theme,render,record-ids,router}.mjs 与他人页面/测试。
- [x] 同阶段其他模块文件未被触碰（M3 onboarding/projects、M4/M6 页面、M2 后端、ui-shell/ui-design）。
- [x] 测试并行安全：fakeApi 用例不占端口；真实服务用例 withTestServer（mkdtemp + listen(0) +
      finally 收尾）；会话为进程内 registry，无后台进程残留。
- [x] 本模块名下无 501 桩（只消费已实装端点；501 分支为展示态断言）。
- [x] 规范引用章节逐条对照（§2.1–§2.4、§3.3），无省略。

## 5. 偏差与已知问题

1. **消息端点号更正（如实上报）**：任务卡写「消息草稿（#49）」，BLUEPRINT-UI v1.1 变更记录②
   明确「消息 #46/#47、诊断 #49」；M2 已实装 POST /sorne/messages（#46 主路径）。本模块按真实端点
   #46 实现并锁定测试；建议架构师同步 §1.6 表内「#49」笔误。
2. **删除旧页内「项目选择器」**：旧 assets/exploration 自持 GET /projects 与「加载更多项目」游标；
   新 IA 中项目上下文属外壳顶栏（§1.1/§1.4，M1 已实装）。因此旧断言「自动选择首个项目」
   「加载更多项目游标累积」「项目列表 501 未实现」随旧页废弃（能力由 ui-shell/M3 承担）；
   本页保留「无项目 → 提示且不发请求」「项目切换后旧数据不残留」两条行为断言（资产/探索各一）。
3. **删除旧页「手动输入编号展开记录」**：按 §1.6「关系导航一律通过点击完成」与 §2.3 统一编号解析，
   改为全站编号 chip（点击 → 外壳 #/records/:id 覆盖层）。旧断言「空输入本地拦截/501/
   INVALID_REFERENCE/记录只读展示」落点转移为：chip → router.openRecord（本测试断言）、记录覆盖层
   读取与错误呈现（ui-shell 用例）、采集编号空值本地拦截（本测试保留同型断言）。
4. **旧「{snapshot:{…}} 包装与 content JSON 字符串」兼容废弃**：该兼容属 B1 未竣工期防御；B1 已竣工，
   真实信封平铺 content，页面改为「未知形状 → 显式提示」。同理废弃「顶层平铺 subscription_id」
   （真实信封嵌套 subscription{}，页面按嵌套读取）。
5. **LABELS 未登记字段的降级显示（跨模块待补，属实呈现）**：方向详情用 ui.FieldRow，其中
   question/success_criteria/deliverables/budget/condition_requirements/plan_revision/scope_revision
   尚未收录进 lib/ui/render.mjs 的 LABELS（M1 文件、非本模块可改），按冻结降级规则显示
   「键名（标签未登记）」+ 悬停提示。已用标题行、状态徽章、独立「目标/依据/前提」段缓解可读性；
   测试断言该降级存在，并在此登记为 M1 LABELS 覆盖闸待补项。
6. **探索分支图为「列式节点 + 文本箭头」而非图形库**：页面零 import 约束下不引入 SVG/图形库；
   view=graph 呈现 1 跳邻接（局部，明示不代表全量），view=full 为辅助清单式全量关系。
   视觉密度是取舍，不虚报「大图可视化」。
7. **分页/筛选边界**：方向列表一次取 #21 limit=200，has_more 时显式提示 +「加载更多方向」
   （cursor 续读，不静默截断）；资产列表以「快照分组 + 折叠桶」为准，不另做分页（快照有折叠与上限，
   edges_omitted 显式计数）。
8. **「文件及来源」的已知限制**：快照未提供「资产→采集」映射，未选中资产时本块只给入口说明；
   选中资产后可读 #14 计数/关联编号，并以 CAP 编号手输读 #44。若后端在 asset_map 补
   assets→captures 索引，可去掉手输步骤（留给后续后端增量）。
9. **真实服务测试的写端点路径**：helpers.request 不带会话头，本测试以 issueSession() + 会话头自行
   发请求（沿 M2 先例），按 §d-10 用 D2 操作路径（register_asset → register_http_resource →
   propose_endpoint_template）造模板，按 C1 plan-revisions 造方向。
10. **未覆盖项**：像素级视觉走查需 npm run ui 人工确认（不虚报自动化通过）；未测超大快照渲染性能；
    消息闭环的 AI 回复质量依赖 Orchestrator 循环（无模型时停在已接收，页面如实呈现）。
11. **留给后续**：无新增端点/表/事件；M6 发现页可复用 RecordIdChip 与消息草稿模式；
    M4 工作台可复用本页「来源与关联计数」模板。

## 6. 旧断言 → 新落点（test/ui-maps.test.mjs 重写前后逐条对照）

| # | 旧用例（B3，17 条） | 新落点 |
|---|---|---|
| 1 | B3 页面契约（纯 ESM/存储/钩子/中文标题） | M5 页面契约（增：无编号正则、无字面颜色、无宿主变量、renderDetail 必须导出） |
| 2 | B3 manifest 按顺序提供 | M5 manifest（assets 30 / exploration 40，真实服务） |
| 3 | 资产地图真实服务双分支（501/200） | 真实服务用例（B1 已竣工→真实形状断言；模板维度「存在/缺失」双分支保留防御） |
| 4 | 探索地图真实服务双分支 | 同上（探索半边，C1 计划接收后方向呈现） |
| 5 | 资产地图六要素/订阅边界/折叠 | 快照六要素用例（六要素+订阅边界+resume_cursor+投影范围可读行+派生视图说明） |
| 6 | URL 与路径原样展示 | URL/路径原样用例（整份文本反证：不小写/不解码/不重排） |
| 7 | 快照 501 → 未实现并标注模块 | 快照 501 用例（未实现≠报错、标注模块、五块如实置空） |
| 8 | 快照异常 → 错误卡；未知形状显式 | 快照 500 错误卡+重试；未知形状用例 |
| 9 | {snapshot:{…}} 包装 / content JSON 字符串兼容 | 随旧页废弃（B1 竣工后真实信封平铺；未知形状显式提示） |
| 10 | subscription{} 嵌套边界展示 | 快照六要素用例（嵌套读取保留；顶层平铺兼容废弃） |
| 11 | 自动选择项目/加载更多项目/切换重拉 | IA 变更：项目上下文归外壳顶栏（ui-shell）；本页新增「项目切换不残留」断言（资产+探索） |
| 12 | 项目列表空态 / 项目列表 501 | 随旧页废弃（空态归 M3 项目列表页；端点 501 归外壳门控） |
| 13 | 点击内容编号与折叠展开入口 → /records | 资产详情 chip→router.openRecord + 折叠「展开本组」fold_since 续读 + #/records 覆盖层（ui-shell） |
| 14 | 手动展开空输入/501/INVALID_REFERENCE | 改为点选无输入；同型保留「采集编号空值本地拦截（不发请求）」；记录错误呈现归外壳覆盖层 |
| 15 | 探索要素/方向/依据/漏洞/未解决问题/状态标签不夸大 | 方向列表用例 + 完整大图用例（判断清单、vulnerability_status 徽章） |
| 16 | 探索 501/异常/未知形状 | 探索 501（列表回退意图端点 + 双 501 不可用）、错误卡、未知形状 |
| 17 | 探索 URL 原样 + Map 派生说明 | 探索 list（派生视图/状态以库为准）+ full（漏洞 location @ /api/users 原样） |


## 7. 本轮整改：分层技术栈画像（2026-11-10，操作员验收反馈；契约偏差上报，待架构师确认）

**反馈现象**：资产页「技术栈」出现多个并列的「通达OA」（A-0002/A-0005/A-0007/A-0008 等），
一个技术栈被拆成 10 条平行条目，无法看出「通达OA → 2015/版本未知 → 证据」的层级。

**根因**（代码事实，非渲染 bug）：
1. assets 唯一身份是 `(project_id, asset_type, canonicalization_version, canonical_key)`
   （0001-core-schema.mjs:58-72），register_asset 只做字符串精确插入（record-service.mjs:477-514）；
2. 提示词要求 canonical_key 写「产品 版本」+ 入口/模板描述（worker.mjs:73、planner.mjs:76），
   自由文本不同即新资产 → 同产品按描述/证据分裂成多条 A- 编号；
3. asset-tree.routes.mjs:85-96 与 assets.page.mjs 旧 renderTechStack 均按 asset_type 平铺，
   树组件只有「站点→文件夹→叶子」两层；BLUEPRINT-UI §1.5/§g 原先把「规范化技术栈画像」
   明确列为后续能力——旧实现忠实执行了该延期合同。

**整改（只读归并 + 写入口径收敛，不改历史记录）**：
- 新增 `lib/store/tech-stack.mjs`：纯派生「产品 → 版本 → 证据」树；兼容历史自由文本
  （括注别名/2015版模板/版本未披露/版本未知）并支持新约定 `产品@版本`（未知写 `产品@unknown`）；
- `asset_map` / `planner_view` 快照 content 增加 `tech_stack`（AI 与 UI 共用同一棵树），
  对应 Markdown 增加「技术栈画像」摘要；
- `asset-tree` 响应增加顶层 `tech_stack`，移除站点下平铺的 `tech` 数组；
- 资产页「技术栈画像」改为可展开树：产品节点（含别名/版本数/证据数）→ 版本节点
  （版本号或「版本未知」）→ 证据叶（原始 canonical_key/original_input + 资产编号 chip 下钻）；
- recon 摘要增加 `tech_stack`（摘要节点 + 资产编号），提示词改为 `canonical_key 只写产品@版本`，
  入口/模板/证据描述写 original_input；
- 回归：`test/tech-stack.test.mjs`（纯归并 + 真实 asset_map/planner_view/asset-tree/recon）与
  `test/ui-maps.test.mjs`（10 条指纹归并为 4 个产品、通达OA 下分 2015/未知、证据 chip 下钻）。

**契约偏差上报（待架构师确认，未就地修改冻结蓝图）**：
- BLUEPRINT-UI §1.5/§g 仍写「技术栈画像能力后续」；本实现已提前提供该能力，
  建议架构师把该表述更新为「分层技术栈画像（产品 → 版本 → 证据）」。
- `GET /sorne/projects/:id/asset-tree` 的 `sites[].tech`、`sites[].counts.tech` 字段移除，
  改由顶层 `tech_stack` 承载（该端点为阶段 2–7 新增，未进入 BLUEPRINT-UI 注册表）。
