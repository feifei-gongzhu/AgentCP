# Sorne 前端重构施工蓝图（BLUEPRINT-UI，冻结契约 v1.1）

> **变更记录**
> - v1.1（2026-11-06，独立评审 15 条意见修订）：①新增 §2.6-8 运行时热加载 `reload()`（修 J1
>   断链：PUT /llm/settings 与 explore-start 落实「配置后即启动运行时」）；②§1.5 端点号更正
>   （消息 #46/#47、诊断 #49，消除与号段表的矛盾）；③`lib/store/orchestrator.mjs`（recordDecision/
>   createPlanRequest 所在文件）与 `lib/store/projection.mjs` 划转 M2 增量修改，纠正
>   lib/agents/orchestrator.mjs（129 行）与 lib/store/orchestrator.mjs（1965 行）同名混淆；
>   ④消息附件契约（attachments + message_links 增 blob/capture 类别，AI 经既有 read_blob 读取）；
>   ⑤P0-1② 字面颜色闸扫描面扩至全部 UI 文件（含 client.js、test-ui-server.mjs、lib/ui/scope/editor.mjs）；
>   ⑥右侧详情槽位与返回栈规则冻结（§2.4-2，消除 history.back 两可）；⑦ui-shell 断言改为
>   「导航 id 集合」+ 终验 manifest 全集（消除中间态必红与并行矛盾）；⑧M4 增设旧测试逐条
>   迁移清单义务，§g 保留清单 11→14 条（补 resolved 不代表已测透/不写死固定重试/单规划在途）；
>   ⑨reviewed_evidence_revision 视图缺口修复落点（jobView.latest_result 补字段，M2+M6）；
>   ⑩报告「按需生成」（既有 #40 `?refresh=1`）与「导出」（新 #53）落点；⑪资产页五块信息
>   落点（asset_map 补 endpoint_templates 维度，M2 增量）；⑫MSG- 前缀入编号注册表；
>   ⑬P0-2③ 测试配方改走 D2 `register_service_asset` 路径；⑭游标清单剔除 worker-reports
>   （无列表端点）；⑮LABELS 覆盖闸与 FieldRow 未登记字段降级规则。
> - v1.0（2026-11-05，初始冻结）：围绕「创建一个探索项目，并持续与 AI 协作」重组前端。
>   最高输入：《前端重构要求-2026-11-05.md》（产品所有者八点要求，下称「要求」）、
>   《DeepSeek-UI评审与缺陷清单-2026-11-05.md》（外部评审，下称「评审」）。
>   规范准绳：《持续探索型渗透测试Agent系统-工程设计规范》（下称「规范」，§N 均指该文档）；
>   其语义纪律（§2 约束、§8 四层判断、§8.4 状态合同、§15.4 未提供≠不存在、§18 分层汇报、
>   §19 报告边界）**全部保留**，本蓝图只改变呈现与交互组织，不改语义。
>
> **与既有 `docs/BLUEPRINT.md`（后端冻结 v1.1）的关系**：不重写其内容。本文与之冲突处按下表
> 升版记录，冲突处**以本文为准**（依据要求文档头部「与既有蓝图冲突时，以本文为准」）：
>
> | 冲突点 | BLUEPRINT.md 旧契约 | 本蓝图新契约 |
> |---|---|---|
> | UI 信息架构（旧 §9） | 9 页平铺（总览/项目/资产/探索/执行/验证/漏洞/协调/报告） | 引导层（向导/项目列表）+ 工作区五页 + 系统诊断页（本文 §1/§7） |
> | 页面文件契约（旧 §2.6） | `{id,title,order,render(ctx)}`，ctx={React,h,api} | 保留 id/title/render；ctx 扩展为 `{React,h,api,router,ui,theme}`（本文 §2.5） |
> | 端点总数（旧 §5.1 写 44） | 44 端点 | 实测 45 个路由注册：44 + `GET /sorne/change-log`（B2 后补，见 §0）；本文再新增 8 个（§2.6，#46–#53），累计 53 |
> | `client.js` 冻结 | 冻结共享文件 | 本批一次性由 M1 升级后**重新冻结**（本文 §3.3） |
> | `test-ui-server.mjs` | 冻结共享文件 | 同上；硬编码深色背景 `#0b1220` 删除（评审 §1 实测根因之一） |
>
> 施工纪律沿用旧蓝图 §12：施工者只写自己独占的文件与竣工记录
> `docs/modules/<id>.md`；需要改冻结文件 → 停工上报架构师。规范与本文冲突时以规范为准并上报。

---

## 0. 工程现状核查（本蓝图定稿时实测，命令与结果）

| 事实 | 核查方式与结果 |
|---|---|
| 439 测试全绿 | `npm test`（= `node tools/check.mjs` + `node --test "test/*.test.mjs"`）exit 0，`# tests 439 / # pass 439 / # fail 0` |
| 端点注册数 | `grep -h "method: \"" lib/routes/*.routes.mjs \| wc -l` = **45**（旧蓝图写 44；多出的 1 个是 `GET /sorne/change-log`，lib/routes/changes.routes.mjs:77，随 test/change-log.test.mjs 引入） |
| 页面文件数 | `lib/ui/pages/` 下 **10 个** `.page.mjs`（旧蓝图 §9 的 9 页 + 变化流 changes.page.mjs，见 docs/modules/B2.md:175）。要求与评审所称「九页/十页」均以此为准 |
| 各页 id/order | overview 10 / projects 20 / assets 30 / exploration 40 / changes 45 / execution 50 / verification 60 / vulnerabilities 70 / coordination 80 / reports 90（逐文件 grep `id:` `title:` `order:`） |
| 编号正则 6 份副本 | `grep -n "RECORD_ID_RE" lib/ui/pages/*.page.mjs`：assets:461、coordination:1317、reports:1470、exploration:469、vulnerabilities:587、verification:598，六处均为 `/([A-Z][A-Z0-9]{0,6}-\d{1,8})/`，与评审 §4a 一致 |
| scope host 缺陷 | lib/store/scope.mjs:86–104 `matchScopeRule`：字符串 URL 规则只比对 scheme/端口/路径前缀，**不比对 host**；`hostMatches`（:79）的 `*.base` 子域通配只作用于裸主机/对象规则 |
| subject_kind 缺陷 | lib/store/verification.mjs:1248（jobView）、:970/:1065（结果视图）、:334（Manifest）均以**物理表名**作 `subject_kind`；lib/ui/pages/verification.page.mjs:852–889 字典只有单数四种 → `未知类型（vulnerabilities）` |
| 游标不一致 | `/changes` 读 `query.after`（changes.routes.mjs:97）；`/verification-jobs` 只读 `query.cursor`（verification.routes.mjs:121）而存储层信封回 `next_after`（verification.mjs:1209）；`/attempts` 两者都收（attempts.routes.mjs:123）；judgements 读 `cursor`。UI 测试把错误契约写死：test/ui-verification.test.mjs:641「next_after → after 参数」 |
| 编号格式两族并存 | 全局族 `PREFIX-nnnn`（record-service.mjs:191 `formatSeqId(prefix,n)`，0004 迁移后 A/O/H/V/F/R/EM/ATT/ASM/WR/TC 走此路）；项目内嵌族 `PREFIX-PRJ-0002-nnnn`（dedup.mjs:171、orchestrator.mjs:197 的三参 `formatSeqId`，以及 evidence/intents/projection/reports/reportgen/recovery/verification 的内联模板：B/CAP/I/SNAP/WR/RR/MR/CP/VR/VJ）。同一实体可能由两条路径产生两种格式（如资产经 record-service=A-0002，经 dedup=A-PRJ-0002-0002） |
| /records 前缀表缺口 | lib/store/records-read.mjs:16–33 只登记 A/ATT/B/CAP/EM/F/G/H/I/O/PRJ/R/SNAP/SR/T/V；兜底扫描表（:36–49）12 张表。**缺失**：WR/TC/VJ/VR/OD/OA/PR/CG/RES/SUBS/CP/ASM/M 等（tool_calls、worker_reports、verification_*、orchestration_*、plan_runs、checkpoints、subscriptions、resources 均不可定位）；且 RR- 前缀**跨两表**（reportgen.mjs:1014 → report_revisions；orchestrator.mjs:619 → report_receipts） |
| 事件编号 | `EVT-<PRJ>-<commit_seq>-<event_index>`（record-service.mjs:248 等）与 `evt-`（evidence.mjs:156）两种大小写并存，不属 /records |
| LLM 配置 | 仅环境变量 `SORNE_LLM_BASE_URL / SORNE_LLM_API_KEY / SORNE_LLM_MODEL`（lib/agents/model.mjs 头注释）；无持久化设置端点，无法从 UI 连接模型 |
| AI 运行时 | lib/agents/（AGENTS 模块，docs/modules/AGENTS.md）：四角色代理循环 + 唤醒条件 `hasWork`（runtime.mjs:60–70：active + 高水位/可派发意图/活跃 Attempt/待处理汇报/待验证任务）；规划入口 `createPlanRequest` 在 **lib/store/orchestrator.mjs:1788**（E1，1965 行；与 129 行的 lib/agents/orchestrator.mjs 是两个文件，本蓝图 v1.0 曾混淆引用，v1.1 更正）；`recordDecision` 同在 lib/store/orchestrator.mjs:912；无用户消息通道；**运行时只在进程启动时判定一次模型可用性**（index.js:57 调 startAgentRuntime；无模型时 runtime.mjs:82–92 返回永久 `started:false` 存根，runOnce 恒 skipped）——该限制由 §2.6-8 热加载契约解除 |
| 深色背景硬编码 | test-ui-server.mjs:68 `background:#0b1220`；client.js:78 `maxWidth:1080`；client.js:146–154 导航按钮无 aria-label |
| 项目创建信封 | `POST /projects {name, description, scope_rules}`（projects.routes.mjs:55–57 → record-service.mjs:1049 createProject）；生命周期 `pause/wait/resume/stop`（record-service.mjs:85–90） |

---

## a) 信息架构（要求 §1–§7）

### 1.1 全局结构

```text
启动
 ├─ 无任何项目 且 未配置模型 → 【引导层】首次使用向导（#/onboarding）
 │     ①连接模型（配置→测试连接→明确显示可用/失败原因）②创建项目（目标/允许/排除/附加资料可跳过）
 │     ③检查模型与工具可用 ④保存项目 / 开始探索
 ├─ 已有项目 → 【引导层】项目列表（#/projects）
 │     列：项目｜当前状态｜最近进展｜待处理事项｜最近活动
 └─ 点击项目 → 【工作区】（#/p/:projectId/…）
       顶栏：项目名称｜运行状态｜暂停/继续｜项目设置
       左侧导航：工作台 · 资产 · 探索 · 发现 · 报告（＋底部入口：系统诊断）
       中间：当前页主区          右侧：当前选中对象详情
```

- **引导层与工作区是外壳的两种布局**（M1 实现）：引导层无顶栏/左导航；工作区布局仅在
  `#/p/:pid/*` 下渲染。项目名称固定在顶栏，可经顶栏下拉切换项目（切到另一项目即
  `#/p/<另一项目>/workbench`）；切换页面不重新选项目，页面内筛选、展开位置、正在阅读的
  详情保存在模块状态中（keyed by hash），切走再切回不丢（要求 §2）。
- 资产、探索、发现、报告全部继承当前项目：所有取数请求带 `project_id`（要求 §2）。
- 模型未配置时：向导与工作台顶栏显示「尚未连接模型，项目可以保存，AI 暂不能开始」并给
  直达入口；**绝不以「服务正常」暗示 AI 可工作**（要求 §1；运行时 `agents.started=false`
  的原因串，index.js:56–58，须原样呈现）。

### 1.2 首次使用向导（M3；要求 §1、§3）

四步向导（步骤条可回退，第三步可整体跳过）：

| 步骤 | 内容 | 接口 | 失败呈现 |
|---|---|---|---|
| ① 连接模型 | 提供方（OpenAI 兼容）· Base URL · 模型名 · API Key；按角色高级配置（默认四角色共用同一套） | `PUT /llm/settings`、`POST /llm/test`（§2.6-1） | 测试连接失败显示真实错误（超时/401/模型不存在），可用/不可用二态明确 |
| ② 创建项目 | 目标（写入 description）、允许范围、排除范围（范围编辑器，M3 组件） | `POST /projects`（既有 #5） | 范围规则语法错误按后端 BAD_REQUEST 原文显示 |
| ③ 导入已有资料 | 可跳过。附加资产文件（原始字节） | `POST /evidence/blobs`（#11，rawBody）+ `POST /captures`（#12，source_kind=uploaded_file） | 上传失败不假装成功（EVIDENCE_NOT_COMMITTED 信封呈现） |
| ④ 检查并开始 | 显示模型可用状态 + 范围摘要；「保存项目」/「开始探索」 | `POST /projects/{id}/explore-start`（§2.6-3） | 未配置模型 → 409 `LLM_NOT_CONFIGURED` + next_requirements 呈现；已保存未开始 → 「项目已保存，AI 暂不能开始」 |

「开始探索」成功后直接进入 `#/p/:pid/workbench`，进展条（已接收目标 → 正在读取已有信息 →
正在制定计划 → 已分配任务 → 持续探索中）**每一段映射真实记录**（§2.6-3 冻结映射），失败显示
失败原因，不转圈（要求 §3）。初始计划展示并允许在对话中调整，不逐条审批（要求 §3）。

### 1.3 项目列表（M3；要求 §2）

- 只展示五列：项目｜当前状态｜最近进展｜待处理事项｜最近活动；数据来自 `GET /projects`
  的 summary 扩展（§2.6-5），全部「按已加载数据推导」口径标注。
- 行内入口：整行点击进入 `#/p/:pid/workbench`；「最近活动」列的编号 chip 直接跳对应详情。
- 真分页（cursor）；空列表 + 无模型 → 引导向导入口。（评审 §4d「十处加载更多是死代码」
  在此一并消灭：没有后端分页的列表一律不渲染「加载更多」。）

### 1.4 工作区布局（M1 外壳 + M4 工作台；要求 §4、§7）

| 区 | 内容 | 归属 |
|---|---|---|
| 顶栏 | 项目名称｜运行状态徽章｜暂停/继续按钮｜项目设置｜切换项目 | M1（外壳骨架）+ M4（状态与动作） |
| 左侧导航 | 工作台 / 资产 / 探索 / 发现 / 报告；底部独立入口「系统诊断」 | M1 |
| 中间 | 当前页主区 | M3–M6 |
| 右侧详情 | 当前选中的任务 / 发现 / 证据 / 资产 / 汇报（由 hash 参数 `?id=` 驱动；槽位与返回栈规则冻结于 §2.4-2，M1 提供容器，页面经 `renderDetail` 渲染） | M1 容器 + 各页自渲染 |

顶栏运行状态徽章区分五态（要求 §7；来自 #6/#41/#52 真实数据，非装饰）：
`正在探索（active 且有工作）`、`等待条件补齐（waiting_for_change，悬停/展开显示在等什么：无可派发意图/待验证积压原因）`、
`已暂停（paused）`、`系统异常（health 异常 / agents 未启动 / 投影滞后超限）`、`已停止（stopped）`。
暂停按钮点击后显示「正在暂停」与「仍有 N 个收尾中的操作（活跃 Attempt 数，来自 #23）」，
直到收尾完成转「已暂停」——不点击后假装全部停止（要求 §7）。资源达到限制时（RESOURCE_LIMIT /
metrics 中预算与容量类指标）显示限制值与处理入口（范围/预算调整 → 项目设置）。

工作台优先三类内容（要求 §4）：**正在做什么**（当前方向、任务、最新进展）、**得到了什么**
（新增资产、重要线索、确认漏洞）、**需要我做什么**（缺资料、访问条件不足、工具不可用、
需要澄清）。与 Orchestrator 的对话入口在工作台主区（消息闭环见 §6 P0-6）。

### 1.5 五页职责边界与系统诊断（要求 §6）

| 页面 | 只回答一个问题 | 数据来源（既有端点号） |
|---|---|---|
| 工作台 | 现在发生了什么，我需要做什么？ | #31 orchestrator/overview、#23 attempts、#16/#45 变化流、#29 验证队列、#38 汇报、#46/#47 消息、#49 诊断聚合 |
| 资产 | 我们知道目标的哪些信息？ | 五块信息各有落点：站点树 ← #13 asset_map 服务/主机层级节点；资产列表 ← #13 asset_type 分组（projection.mjs:218–250 已按类型分组）；技术栈 ← 同一 asset_type 分组视图（以资产类型聚合呈现，规范化技术栈画像属后续能力，页面如实标注口径）；接口 ← #13 的 endpoint_templates 维度（**由 §d-10 M2 增量补入快照**）+ #14 records(T-…)；文件及来源 ← #14 资产详情证据索引 + #43/#44 |
| 探索 | 为什么沿这些方向、推进到哪了？ | #13 exploration_map、#21 intents、#14 records；方向列表+局部分支图为主，完整大图为辅助视图 |
| 发现 | 有哪些值得关注的问题、证据到什么程度？ | #30 vulnerabilities、#29 verification-jobs、#14/#43/#44；疑似/已确认/待复核/已排除（falsified）四态徽章区分 |
| 报告 | 成果如何阅读和交付？ | 阅读 ← #39/#40 报告视图；**按需生成** ← #40 `GET /reports/milestones?refresh=1`（report-views.routes.mjs:10/:88 已支持，默认读取不增殖版本）；**导出** ← #53 `GET /reports/{id}/export`（§2.6-9）；跳转发现与证据 ← #14；生成报告不结束项目（规范 §19） |
| 系统诊断 | 系统内部现在健康吗？ | #49 诊断聚合（§2.6-4）、#41 metrics 全集、变化流一行摘要+payload 折叠、租约/工具调用/Outbox/消息投递明细 |

变化流、执行尝试、租约、消息投递、数据库状态**不再各占主页面**，全部收进右侧详情或
系统诊断（要求 §6）。

### 1.6 「查看信息」→「采取行动」（要求 §5；每行有唯一实现落点）

| 看到 | 能直接做 | 实现 |
|---|---|---|
| 某个资产 | 查看来源/相关发现/已开展的探索；向 AI 提出针对它的任务 | 资产详情右侧栏：counts（records-read.mjs assets 视图已有）+「就此资产向 AI 下任务」按钮 = 预填消息草稿（#49） |
| 某条探索方向 | 查看依据/进展/阻塞；要求解释、补充信息或暂缓 | 方向详情：basis_refs、resume_conditions 呈现；操作按钮 = 消息草稿（追问/暂缓理由）经 #49，或对 Attempt 暂缓（#24，经对话确认后由协调 AI 提交决定） |
| 某条疑似漏洞 | 查看证据、验证进度；请求复核或继续调查 | 发现详情：证据索引（#14 evidence_index）→ #43/#44；「请求复核」= 消息（#49）由 Orchestrator 转 #27 verification-requests——**用户操作不得直接改漏洞状态**（旧蓝图 §8.2 角色矩阵不变） |
| 某个受阻任务 | 了解缺什么；补充材料/调整条件/换方向 | 任务详情：resume_conditions + blockers；「补充材料」= 上传证据（#11/#12 得 B-/CAP- 编号）→ 随消息附件提交（`POST /messages` 的 `attachments`，§2.6-2——AI 上下文经附件编号经既有 read_record/read_blob 读取），或 `POST /attempts/{id}/context`（#35） |
| Worker 汇报 | 阅读摘要 → 展开关键记录 → 查看完整依据 | 三层展开（#38 分层读取），语义同规范 §18.3，不删不确定性 |
| 某份报告 | 跳转到对应发现、证据和后续探索 | 报告内编号全部渲染为 RecordIdChip（点击跳详情，不手抄编号；要求 §5 尾段） |

**关系导航一律通过点击完成**：全站编号渲染为完整编号 chip；「不要让用户复制 V-003 再去
另一个页面粘贴编号」（要求 §5）由 §2.3 统一编号解析保证。

---

## b) 冻结契约

### 2.1 双主题 token 表（lib/ui/theme.mjs；M1 独占）

**注入方式（冻结）**：M1 在外壳挂载时注入一份 `<style>`，定义
`html[data-sorne-theme="light"]{…}` 与 `html[data-sorne-theme="dark"]{…}` 两套 CSS 自定义属性，
并注入 `html{color-scheme:light dark}`；无显式选择时随 `prefers-color-scheme`，顶栏提供三态切换
（浅/深/跟随系统），选择存 localStorage（非授权类输入，旧蓝图 §9 允许）。
**禁止任何页面引用宿主 `--dsw-alias-*` 变量或书写字面颜色值**——评审 §1 的根因就是宿主变量
为空回退浅色值。检查（P0-1② 的永久闸，v1.1 收紧扫描面）：对**全部 UI 文件**——
`client.js`、`test-ui-server.mjs`、`lib/ui/pages/*.page.mjs`、`lib/ui/render.mjs`、
`lib/ui/router.mjs`、`lib/ui/record-ids.mjs`、`lib/ui/scope/editor.mjs`——执行
`grep -rnE "#[0-9a-fA-F]{3,8}\b|rgba?\(" <文件清单>`，必须 0 命中；唯一豁免 `lib/ui/theme.mjs`。
（现状反例：client.js:79/:84/:89 的 `var(--dsw-alias-text-primary, #1a2233)` 类回退写法——M1
重写时必须清除，闸对重写后的 client.js 同样生效。）该扫描作为 `test/ui-design.test.mjs`
的一条断言执行，文件清单以 §c 各模块 UI 文件为准（新增 UI 文件必须入闸，遗漏视为闸失效）。

**token 表（结构与阈值为冻结契约；hex 为初版实现值，M1 可微调，但必须通过 §6 P0-1 的
确定性对比度测试——测试是最终权威）**：

| token | 浅色值 | 深色值 | 用途 | 对比度目标（对各自 canvas/surface） |
|---|---|---|---|---|
| `--sorne-bg-canvas` | #f6f7f9 | #0f1520 | 页面底 | — |
| `--sorne-bg-surface` | #ffffff | #171f2e | 卡片/面板 | — |
| `--sorne-bg-raised` | #ffffff | #1d2637 | 弹层/详情栏 | — |
| `--sorne-bg-subtle` | #eef0f3 | #222c40 | 分隔区/表头 | — |
| `--sorne-text-primary` | #17202e | #e8edf6 | 正文/标题 | **≥ 7:1**（AA AAA 目标，硬门槛 4.5） |
| `--sorne-text-secondary` | #46536b | #b6c1d4 | 次要正文/说明 | **≥ 4.5:1** |
| `--sorne-text-muted` | #5d6a80 | #93a1b8 | 辅助信息（可读处） | **≥ 4.5:1**（仅装饰性分隔文字可 3:1） |
| `--sorne-border` | #d7dce3 | #2c3850 | 装饰边框 | — |
| `--sorne-border-strong` | #9aa4b2 | #55637f | 控件边框/焦点前态 | ≥ 3:1（非文本 UI 组件，WCAG 1.4.11） |
| `--sorne-brand` | #1d4ed8 | #3b82f6 | 主按钮底/激活导航 | — |
| `--sorne-on-brand` | #ffffff | #0a101c | 主按钮文字 | **≥ 4.5:1（对 --sorne-brand）** |
| `--sorne-focus-ring` | #1d4ed8 | #93c5fd | 焦点环 | 环对相邻底 ≥ 3:1；焦点环**永不置 none**（评审 §5：0 个 focus ring 必须消灭） |
| `--sorne-status-suspected` | 前景 #92400e / 底 #fef3c7 | 前景 #fcd34d / 底 #3a2c08 | 疑似（琥珀） | **≥ 4.5:1** |
| `--sorne-status-confirmed` | 前景 #b91c1c / 底 #fee2e2 | 前景 #f87171 / 底 #3d1414 | 已确认（红） | **≥ 4.5:1** |
| `--sorne-status-falsified` | 前景 #374151 / 底 #e5e7eb | 前景 #cbd5e1 / 底 #1f2937 | 已证伪（灰） | **≥ 4.5:1** |
| `--sorne-status-review` | 前景 #1d4ed8 / 底 #dbeafe | 前景 #93c5fd / 底 #14243f | 待复核（蓝点） | **≥ 4.5:1** |
| `--sorne-status-unknown` | 前景 #b91c1c / 底 #fee2e2 | 前景 #f87171 / 底 #3d1414 | unknown/过期/异常（红点） | **≥ 4.5:1** |
| `--sorne-status-ok` | 前景 #166534 / 底 #dcfce7 | 前景 #86efac / 底 #0d2b16 | 正常/运行中 | **≥ 4.5:1** |

排版基线（冻结）：正文 ≥ 14px（评审 §1：现全页最小 12px 是可读性缺陷）、行高 ≥ 1.55、
导航与按钮 ≥ 13px；页面内容区随窗口自适应（移除 1080px 死宽度），最大 1440px 居中。
可访问性基线：全部可点击元素 `role`/`aria-label`（编号 chip 的 aria-label 为完整编号），
`:focus-visible` 显示焦点环，读屏可遍历（评审 §5 全部采纳）。

### 2.2 lib/ui/ 渲染器 API（lib/ui/render.mjs；M1 独占，M3–M6 唯一允许的取数渲染入口）

页面不得自写时间/哈希/编号/JSON 渲染逻辑（消灭 6 份 RECORD_ID_RE 类分叉的结构性手段）。
冻结导出：

```js
export function formatTime(iso, { mode = "relative-local" } = {})
  // "3 分钟前 · 14:32:05"；mode="absolute" 给 "2026-11-05 14:32:05（本地）"；
  // 悬停 title=原始 ISO；绝不再裸出 UTC ISO 串（评审 §3）。
export function formatHash(value, { prefix = 10 } = {})
  // "sha256:ab12cd34ef…"，附复制按钮（复制完整值）；空值渲染 "—（未提供）"。
export function RecordIdChip(id, { projectId, navigate })
  // 完整编号按钮（不截断项目段）；点击 → router.openRecord(id)；
  // 无法解析的编号样式降级为纯文本 chip + title 说明，绝不静默给错记录。
export function FoldableObject(value, { summary, level = 0, defaultOpen = false })
  // 对象/数组默认折叠：显示 "{n 项}" / "[m 个元素]" + 摘要键名；展开递归；
  // 展开不删记录（折叠不删记录 = 语义纪律），带「已折叠 n 项」计数。
export function StatusBadge(vocabKey, value)
  // 词表驱动的状态徽章（色点+中文标签+悬停英文值）；未知值渲染
  // "未知状态（<raw>）" 且测试视为失败信号（P0-4 联动）。
export function FieldRow(label, value, { renderer })
  // 字段行：LABELS 提供中文标签；布尔 → 是/否；null/空 → "—（未提供）"
  // （语义纪律：未提供 ≠ 不存在，悬停提示）。
export function DataTable({ columns, rows, rowKey, onRowClick, sortable })
  // 真表格（评审 P2-9）：列头排序、行状态徽章列、行内点击进详情。
export function EmptyState({ title, hint, actions })
export const LABELS   // 字段→中文标签全量映射（收录全部现役字段，含
                      // schema_version="模式版本"、commit_seq="提交序号"…）
export const VOCAB    // 词表：vulnerability_status / review_status / outcome / job_status /
                      // attempt_status / tool_call_status / intent_status / project_status /
                      // subject_kind / report_kind / message_status / scope_kind / event_type
```

**LABELS 覆盖闸与降级规则（v1.1 冻结，回应评审 §3「schema_version 裸奔」类问题的机制化）**：
①`test/ui-design.test.mjs` 内置 §2.6 各端点样例响应 fixtures，逐字段断言 `LABELS` 有中文标签
（显式豁免清单随 fixtures 维护）；新增端点/字段联调时必须补 fixture——漏登记即测试红。
②FieldRow 对未登记字段的**冻结降级**：原样显示字段键名 + 悬停提示「标签未登记」，不省略、
不猜测、不静默吞掉（未提供 ≠ 不存在 同纪律）。

语义纪律词表（**冻结原文，不得改写**——评审 §6 要求保留的措辞全部迁入 VOCAB/详情模板）：
- confirmed 永远带「（限指定条件）」；insufficient 写「证据不足：未确认，不伪装成已排除」；
  falsified 标注「不等于历史上不存在」（规范 §8.4）。
- unknown 工具调用置顶并红字「须先检查外部现状再决定重试，不得当作已完成或已失败」（规范 §10.2）。
- 每个数据面标「数据时刻 / 截止边界（commit_seq）/ 不代表全量」；每个计数注明「按已加载数据推导」。
- delivered ≠ handled（消息/汇报状态分列）；折叠不删记录；501 未实现 ≠ 报错（呈现「未实现」态）。
- 每页正文只留任务导向一句；规范解释收进「语义说明」折叠区，全站「§」≤ 2/页（评审 P2-10）。

### 2.3 统一编号解析（lib/ui/record-ids.mjs + lib/store/records-read.mjs）

**前端（唯一实现，冻结）**——`lib/ui/record-ids.mjs` 全站唯一正则来源：

```js
// 事件编号（不属 /records）：evt-<PRJ>-<commit_seq>-<event_index>，大小写两种前缀并存
export const EVENT_ID_RE = /^[Ee][Vv][Tt]-[A-Za-z0-9-]+$/;
// 记录编号：全局族 PREFIX-nnnn 与项目内嵌族 PREFIX-PRJ-nnnn-nnnn，整体匹配（非子串）
//   例：A-0002、V-0003、TC-0009 ｜ A-PRJ-0002-0002、I-PRJ-0002-0001、WR-PRJ-0002-0003
export const RECORD_ID_RE =
  /^([A-Z][A-Z0-9]{0,5})(?:-PRJ-(\d{1,8}))?-(\d{1,8})$/;
// 解析失败 → null；RecordIdChip 对 null 渲染降级文本 chip（不猜测、不截断匹配）
export function parseRecordId(text) { … }
// 客户端前缀表（与后端 PREFIX_TABLES 同步的只读镜像，供 chip 悬停显示目标类型；定位仍以
// /records 服务端为准）：{ A:"assets", O:"observations", … 完整见 §2.3-后端 }
```

修复语义（P0-2）：匹配必须**整体**成功（旧实现 `String.split(RECORD_ID_RE)` 对
`A-PRJ-0002-0002` 取子串 `PRJ-0002` → 静默打开项目记录，评审 §4a CDP 实测）；两族格式
必须都能解析；解析出的目标类型以前缀表显示（A → 「资产」），点开 `#/records/:id?project=:pid`。

**后端（/records/{id} 前缀表扩展，M2 独占）**——`lib/store/records-read.mjs`：

| 变更 | 内容 |
|---|---|
| PREFIX_TABLES 新增 | `WR→worker_reports`、`TC→tool_calls`、`VJ→verification_jobs`、`VR→verification_results`、`OD→orchestration_decisions`、`OA→orchestration_actions`、`PR→plan_runs`、`CG→candidate_groups`、`RES→resources`、`SUBS→subscriptions`、`CP→checkpoints`、`ASM→attempts`、`M→memberships`、`MSG→messages`（随 §2.6-2 新表同步登记，消息编号 chip 经 /records 展开） |
| RR 双表前缀 | `RR→[report_revisions, report_receipts]`（两写点同名前缀：reportgen.mjs:1014 / orchestrator.mjs:619）——locateRecord 按序探测，命中即返回；回应答带 `note:"RR 前缀跨两类记录，按存储定位"` |
| locateRecord | 前缀正则改为 `^([A-Za-z]+)-(?:PRJ-\d{1,8}-)?(\d{1,8})$` 同型两族；兜底扫描表扩至上表全部物理表；`evt-`/`EVT-` 一律 404 + hint 指向 `/changes`（维持现状语义） |
| 新增表视图 | 每个新可定位表补紧凑视图（kind/status/created_at/created_by/created_seq + 关键引用：worker_reports 带 intent_id/attempt_id/kind、tool_calls 带 status/evidence_refs、verification_jobs/results 带 subject_id/outcome/applied、orchestration_decisions/actions 带 action_kind/status、plan_runs 带 status、checkpoints 带 processed_boundary、messages 带 direction/status/reply_to） |

### 2.4 hash 路由表（lib/ui/router.mjs；M1 独占）

| hash | 页面/状态 | 归属 |
|---|---|---|
| `#/onboarding` | 首次使用向导 | M3 |
| `#/projects` | 项目列表（无项目时为默认落点） | M3 |
| `#/p/:pid/workbench` | 工作台（进入项目默认页） | M4 |
| `#/p/:pid/assets` / `#/p/:pid/assets?id=<编号>` | 资产列表 / 资产详情（右侧栏） | M5 |
| `#/p/:pid/exploration` / `…?id=<I-/ATT-编号>` | 探索方向列表 / 方向详情；`&view=graph` 局部分支图，`view=full` 完整大图（辅助） | M5 |
| `#/p/:pid/findings` / `…?id=<V-编号>` | 发现台账 / 发现详情 | M6 |
| `#/p/:pid/reports` / `…?id=<RR-/MR-编号>` | 报告 / 报告详情 | M6 |
| `#/p/:pid/diagnostics` | 系统诊断 | M4 |
| `#/records/:id?project=:pid` | 记录展开覆盖层（外壳级；任何页可跳，关闭回到来源 hash） | M1 |

规则（冻结）：路由为唯一页面状态入口——刷新/分享/回退/前进全部成立（评审 §4d「无 hash 路由」
修复）；未知 `:pid` → 重定向 `#/projects` 并提示；未知 hash → `#/projects`。

**§2.4-2 右侧详情槽位与返回栈（v1.1 冻结，M3–M6 共同依赖的实现契约）**

- **ctx.router API（冻结）**：`{ hash, page, projectId, params: { id?, view? }, open(hash),
  replace(hash), back(), openRecord(id) }`；`openRecord(id)` = `open("#/records/<id>?project=<当前项目>")`。
- **详情槽位分工（冻结）**：M1 外壳渲染中间/右侧两栏容器；页面模块可选导出
  `renderDetail(ctx)`——当 hash 带 `params.id` 且页面定义了 `renderDetail` 时，外壳把
  `renderDetail(ctx)` 渲染进右栏，`render(ctx)` 只渲染中间栏；未定义 `renderDetail` 的页面
  （如探索大图态）单栏自渲染。右栏宽度、关闭按钮、键盘 Esc 均由 M1 容器统一提供。
- **返回栈规则（冻结，消除两可）**：
  1. 应用内导航一律 `pushState`（M1 维护会话内应用内导航标记栈）；点行打开详情 =
     push `#/p/:pid/<page>?id=X`；关闭详情 = **若当前栈顶条目存在同页基（同 `:pid/<page>`、无 id）
     的应用内前驱 → `history.back()`，否则 `location.replace` 到该页列表 hash**
     （覆盖深链直开详情、刷新后无前驱两种情形——深链关闭详情落到列表态，阅读位置由
     §2.4 会话态保留）。
  2. `#/records/:id` 覆盖层：打开 = 在当前 hash 之上 push；关闭 = 存在应用内前驱 →
     `history.back()` 回到来源页（含其 `?id=` 详情态），否则落到 `#/p/:project/workbench`。
  3. 浏览器原生返回/前进键行为与上述 push/replace 一致（不劫持）。
- J3 的「返回原位、阅读位置不丢」测试以本规则为实现依据（§e-J3）。

### 2.5 页面模块契约与注册表（M1 一次登记）

沿用旧蓝图 §2.6 的加载协议（`GET /ui/manifest` 扫描 `lib/ui/pages/*.page.mjs`、动态 import、
失败降级错误卡片；lib/routes/ui.routes.mjs 冻结不改）。契约升级为：

```js
export default {
  id,            // 冻结 id 集合见下表
  title,         // 中文
  order,         // 冻结值见下表（manifest 排序；引导层两页不走左导航，order 仅决定 manifest 顺序）
  render(ctx),   // ctx = { React, h, api, router, ui, theme }
  renderDetail?, // 可选（v1.1）：右侧详情渲染（§2.4-2 槽位契约）
};
// 不得 import 任何包或 Node 内置模块（保持旧契约）；
// ui = §2.2 渲染器 + §2.3 编号解析；router = §2.4/§2.4-2；theme = 主题切换句柄。
```

**注册表（页面文件归 §3 各模块；断言规则 v1.1 修订——消除与「六模块并行」的中间态矛盾）**：

| id | title | order | 布局 | 归属 | 文件 |
|---|---|---|---|---|---|
| `onboarding` | 首次使用 | 5 | 引导层 | M3 | lib/ui/pages/onboarding.page.mjs |
| `projects` | 项目 | 10 | 引导层 | M3 | lib/ui/pages/projects.page.mjs（重写） |
| `workbench` | 工作台 | 20 | 工作区·左导航 | M4 | lib/ui/pages/workbench.page.mjs |
| `assets` | 资产 | 30 | 工作区·左导航 | M5 | lib/ui/pages/assets.page.mjs（重写） |
| `exploration` | 探索 | 40 | 工作区·左导航 | M5 | lib/ui/pages/exploration.page.mjs（重写） |
| `findings` | 发现 | 50 | 工作区·左导航 | M6 | lib/ui/pages/findings.page.mjs |
| `reports` | 报告 | 60 | 工作区·左导航 | M6 | lib/ui/pages/reports.page.mjs（重写） |
| `diagnostics` | 系统诊断 | 70 | 工作区·独立入口（槽位） | M4 | lib/ui/pages/diagnostics.page.mjs |

即「六页 = projects/workbench/assets/exploration/findings/reports，向导 onboarding 由 M3
以引导层页承载，诊断页槽位 = diagnostics」。

**断言规则（v1.1 冻结，回应评审「8 id 全集断言与旧页并存期必红」）**：
①M1 竣工时 `test/ui-shell.test.mjs` 断言的是**导航可达集合**而非 manifest 全集——工作区态左
导航渲染的 id 恰为 `{workbench, assets, exploration, findings, reports}`、引导态恰为
`{onboarding, projects}`、诊断页经独立入口可达；旧 id 页面（overview/execution/…）在过渡期
即使仍在 manifest 也不得出现在任何导航面（外壳按本表 id 白名单渲染导航）。②manifest 恰为
上表 8 个 id 的**全集断言移至终验**（§9）：M4/M6 删除各自旧页文件后由架构师终验执行。
③旧页 order 与新页冲突（projects 10 vs 旧 overview 10 等）在过渡期不影响导航断言
（旧 id 不入导航白名单）；终验时冲突随旧文件删除消失。

### 2.6 M2 新端点形状（端点号顺延：既有 45 个注册 = 旧 #1–#44 + change-log 记 #45；本批新增 8 个：#46–#53）

所有新端点与现有 user 面一致：回环 + 同源信任边界由 dispatcher 统一实施（lib/http.mjs 冻结），
不在端点内另设会话；错误信封沿用 lib/errors.mjs。除 llm/test 外全部要求 `project_id` 归属校验
（不存在/跨项目 → 404，不泄露存在性，与 records-read.mjs:6 合同一致）。

**§2.6-1 LLM 设置与连接测试**（#50 GET / #51 PUT /llm/settings、#52 POST /llm/test；迁移 0005；测试 test/llm-settings.test.mjs）

```text
GET  /sorne/llm/settings
  → { configured: bool, base_url, model, api_key_set: bool, api_key_hint: "sk-…abcd",
      per_role: { planner?: {model}, orchestrator?: {model}, worker?: {model}, verifier?: {model} },
      source: "store" | "env" | "none", updated_at }
  // api_key 只写不读：响应永不含明文 key（冻结安全约束）
PUT  /sorne/llm/settings  { base_url, model, api_key?, per_role? }
  → 同 GET 形体；校验 base_url 为 http(s) URL、model 非空；api_key 缺省=保留原值，空串=清除
POST /sorne/llm/test  { base_url?, model? }   // 缺省用已存配置
  → { ok: true, latency_ms, model } | { ok: false, error: { code, message }, latency_ms }
  // 真实最小 chat 请求（max_tokens=1，10s 超时）；不落日志含 key
```
存储：新表 `llm_settings(scope TEXT PRIMARY KEY, base_url, model, api_key, updated_at)`，
`scope='default'` + 可选四角色行；解析顺序 store > 环境变量（model.mjs `resolveModelProvider`
改造为该顺序）。**PUT 成功后必须调用 `pctx.agents.reload()`**（§2.6-8 热加载契约）——否则
运行时保持启动时的 `started:false` 存根（index.js:57 只在进程启动判定一次），J1 断链。
API key 存库的前提是信任边界为回环-only（旧蓝图 §2.1）；风险 §10-4。

**§2.6-2 消息与唤醒（用户 ↔ 主 AI 闭环，含资料附件）**（#46/#47；迁移 0006；测试 test/messages.test.mjs）

```text
POST /sorne/projects/{id}/messages
     { content: string(1..8000), reply_to?: "MSG-…",
       attachments?: [{ kind: "blob"|"capture", ref: "<B-…/CAP-… 编号或 blob sha256>" }] }   // ≤16 项
  → { message: { id: "MSG-<PRJ>-nnnn", direction: "user", status: "received",
                 content, attachments: [...已校验回显], created_at, created_by: "user" },
      state: "queued_for_orchestrator" }
  // attachments 逐项校验存在于本项目（blob 按 sha256、capture 按编号），不存在 →
  // INVALID_REFERENCE（信封 next_requirements 指向 #11/#12 上传），拒绝整条消息（不半提交）
GET  /sorne/projects/{id}/messages?cursor=&limit=
  → { messages: [{ id, direction: "user"|"ai", content, status,
                   reply_to, attachments, created_at,
                   links: [{ kind: "intent"|"attempt"|"orchestration_decision"|"verification_job"
                              |"worker_report"|"blob"|"capture", ref_id, label }] }],
      next_cursor, has_more }
```
- 新表：`messages(id, project_id, direction, content, status, reply_to, created_at, created_by, created_seq)`
  （id 形如 `MSG-PRJ-0002-0001`，项目内嵌族）与
  `message_links(message_id, link_kind, ref_id)`（复合主键；link_kind 含
  `blob`/`capture`——**资料半边的闭环契约**：用户上传的证据经附件进入消息，编号即关联）。
- status 词表：`received → processing → answered | failed`（ai 回复到达=answered）。
  **delivered ≠ handled 纪律照搬**：收到≠已处理，闭环由 links + ai 回复证明（P0-6）。
- **AI 如何得知并读取资料（冻结）**：Orchestrator 循环读取待处理用户消息时，附件以
  `[blob B-…/sha256]`、`[capture CAP-…]` 编号列表注入上下文；模型经既有工具
  `read_record`（GET /records/{id}，含 evidence_index）与 `read_blob`（GET /evidence/blobs/{sha256}）
  获取字节——不复制内容进消息、不新增取数通道。
- 唤醒（要求 §4/§8）：`hasWork`（runtime.mjs:60）增加条件「存在 status=received 的用户消息」；
  Orchestrator 循环（lib/agents/orchestrator.mjs）作出决定时以 `source_message_id` 调
  **lib/store/orchestrator.mjs 的 `recordDecision`（:912）**——M2 对该函数做增量扩展：可选
  `source_message_id` 参数，并在**决定持久化同一 runSerial 事务内**写 `message_links`
  （decision/intent/attempt…）后追加 AI 回复消息（direction=ai, reply_to=…）。
  脚本化模型替身驱动 `runOnce` 验证闭环（test/messages.test.mjs），不依赖真实 LLM。

**§2.6-3 开始探索**（#48；无新表；测试 test/explore-start.test.mjs）

```text
POST /sorne/projects/{id}/explore-start  {}
  → 200 { project, plan_request_id, deduped?: true }
  → 409 { code: "LLM_NOT_CONFIGURED", message: "尚未连接模型，项目可以保存，AI 暂不能开始",
           next_requirements: ["配置模型：PUT /sorne/llm/settings 或前往引导页连接模型"] }
```
语义（冻结）：端点先调 `pctx.agents.reload()`（§2.6-8），reload 后仍无可用提供方（store+env
均无）→ 409；**reload 成功即同进程内启动运行时**——支持「先保存项目 → 后连接模型 → 开始
探索」与「先配置模型 → 再开始」两种顺序，进程内无死路。已 active 且存在 pending/in_flight
的 plan_run → 幂等返回既有（不重复建）；否则调用 E1 `createPlanRequest`
（**lib/store/orchestrator.mjs:1788**，§16.1 单规划在途语义）并确保项目处于 active。目标即项目
description（向导第 ② 步写入），不新建表。
**进展条真实映射（M4 呈现契约，每段有真实记录引用，禁止假进度）**：

| 段 | 判定（全部来自端点） |
|---|---|
| 已接收目标 | 项目存在（#6）且 plan_request 已建（explore-start 回执/`GET /diagnostics`） |
| 正在读取已有信息 | planner_view 快照边界落后于高水位（#13 planner_view / #41 投影滞后） |
| 正在制定计划 | plan_runs status ∈ {pending, in_flight} |
| 已分配任务 | 存在 queued/running intents（#21）或活跃 attempts（#23） |
| 持续探索中 | `GET /changes` 高水位推进 / 近期事件时间戳更新 |
| 失败 | plan_runs.received_status=rejected/partial 或 agents 错误 → 显示原因，不转圈 |

**§2.6-4 诊断聚合**（#49；无新表；测试 test/diagnostics.test.mjs）

```text
GET /sorne/diagnostics                      → 全局聚合
GET /sorne/diagnostics?project_id=PRJ-0002  → 单项目聚合
  → { generated_at,
      llm: { configured, runtime: <agents.describe() 原文> },
      health: <#3 响应体>,
      projects?: { active, waiting_for_change, paused, stopped },        // 无 project_id 时
      project?: { status, current_scope_revision,
        plan:     { plan_runs_pending, plan_runs_in_flight },
        intents:  { by_status: {...}, blocked_ids: [...] },
        attempts: { active_leases, expired, unknown_tool_calls: [...] }, // unknown 置顶（纪律）
        verification: { pending_jobs, oldest_wait_seconds },
        reports:  { unhandled_worker_reports },
        messages: { pending_user, last_ai_reply_at },
        outbox:   { pending, oldest_pending_age_s, failed },
        projection: { <kind>: lag_commit_seq | null },                   // null=未投影，不冒充 0
        evidence: { staged_blobs, integrity_anomalies } } }
```
所有计数「库内可核对、带中文 note 口径说明」（沿 metrics.mjs:1–40 的口径纪律）。
实现：新 lib/routes/diagnostics.routes.mjs + lib/store/diagnostics.mjs（只读聚合，不写库）。

**§2.6-5 项目列表 summary 扩展**（既有 #4；测试 test/projects-summary.test.mjs）

```text
GET /sorne/projects?cursor=&limit=&include=summary
  → { projects: [{ id, name, description, status,
                   latest_progress,        // 最近一条事件的一句话摘要（event_type + 主体编号）
                   last_activity_at,
                   pending: { unhandled_reports, pending_verification, blocked_intents } }],
      next_cursor, has_more }
```
评审 §4d「GET /projects 无分页」修复；无 `include=summary` 时保持旧形体（兼容 change-log
等既有调用方）。

**§2.6-6 游标统一**（无新表；测试 test/cursor.test.mjs）

- 信封统一：所有列表端点返回 `next_cursor`（无更多页=null）+ `has_more`；`/changes` 额外保留
  `high_watermark`（§14.3）。
- 查询参数统一为 `cursor`；`/changes` 与 `/attempts` 继续接受 `after` 别名（既有调用方兼容），
  `/verification-jobs` 增加 `cursor` 读取并继续接受 `after`；响应体 `next_after` 字段保留一个
  版本作兼容回填（与 `next_cursor` 同值），标注 deprecated。
- **分页端点清单（v1.1 按实测校正，逐个登记进 test/cursor.test.mjs）**：#16 `/changes`、
  #45 `/change-log`、#21 `/intents`（intents.mjs:1440 next_cursor）、#30 `/vulnerabilities`
  （judgements.mjs:850）、#23 `/attempts`（routes 已双参数兼容）、#29 `/verification-jobs`
  （本次修复）、#4 `/projects`（本次新增分页）、#39 漏洞报告版本列表（reportgen.mjs:1206）。
  **明确单对象、无列表分页可验**（清单中不得出现）：`/worker-reports`（reports.routes.mjs:51
  仅有 `GET /worker-reports/:id` 单条，工作台未处理汇报清单来自 #31/#49）、`/metrics`、
  `/health`、`/diagnostics`、`/snapshots/{kind}`。发现清单与实现不一致即修。

**§2.6-7 编号注册表扩展**：见 §2.3 后端段（lib/store/records-read.mjs，M2）。

**§2.6-8 运行时热加载（v1.1 新增，解除 J1 断链）**

现状（§0 实证）：`startAgentRuntime` 仅在 index.js:57 进程启动时调用一次；无模型时
runtime.mjs:82–92 返回**永久存根**（`started:false`、`runOnce` 恒 skipped、无 `reload`）——
进程启动后才配置模型永远无法启动 AI。

冻结契约（M2，lib/agents/runtime.mjs 增量）：

- 运行时句柄新增 `reload(): Promise<{ started: boolean, reason?: string }>`：
  重新执行 `resolveModelProvider`（§2.6-1 的 store > env 顺序）；
  - 原未配置、reload 后有配置 → 替换内部 provider，`started=true`，启动 tick 定时器；
  - 原 started、reload 后无配置 → 停止 tick，`started=false`，reason 更新为缺配置说明
    （不丢 `lastHigh` 水位，恢复后不重放已处理事件，§16.4）；
  - reload 与 runOnce 并发安全（单飞，不重入）。
- 调用点（冻结）：①`PUT /llm/settings` 成功后；②`POST /explore-start` 入口处（§2.6-3）；
  两者经 `pctx.agents?.reload?.()`（句柄缺 reload 时安全跳过，兼容旧存根）。
- 测试：`test/llm-settings.test.mjs::保存设置后运行时热加载`（未配置启动 → PUT →
  `started===true` 且 runOnce 可驱动脚本化模型；再清除配置 → `started===false`）；
  `test/explore-start.test.mjs::配置前 409、配置后同进程 explore-start 成功`。

**§2.6-9 报告生成与导出（v1.1 新增，落实要求 §6「按需生成阶段报告并导出」）**

- **按需生成——零新端点**：既有 #40 `GET /sorne/reports/milestones?refresh=1` 已实现
  （report-views.routes.mjs:10 注释、:49–50 refreshFlag、:88 传参；reportgen.mjs:1054
  `generateMilestoneReport`、默认读取不增殖版本）。M6 报告页「生成阶段报告」按钮调它；
  确认版漏洞报告按 §19 随验证同步，不提供手动生成入口（不造第二真值源）。
- **导出——新端点 #53**：`GET /sorne/reports/{id}/export?project_id=` → 以
  `text/markdown; charset=utf-8` + `Content-Disposition: attachment` 流式返回该报告版本的
  内容文件（content_ref 指向 §5.2 布局 `reports/…` 目录文件；M2 经 lib/store/reportgen.mjs
  读取，文件缺失 → 404 + note「内容文件不可读，refresh=1 可生成新版本」，沿 reportgen
  既有口径）；归属校验同 §2.6 通用规则。测试：`test/report-export.test.mjs`（生成 → 导出
  字节与视图内容一致；跨项目 404 不泄露）。

### 2.7 跨模块冻结签名（沿用旧蓝图 §2.7 机制）

| 签名 | 实现方 → 调用方 | 语义 |
|---|---|---|
| `openScopeRulesEditor({ project, scope, onSaved }) → void`（lib/ui/scope/editor.mjs，M3 导出） | M3 → M4 | 项目设置抽屉与向导共用同一范围编辑器（允许/排除/待判断三区 + 通配符提示 `*.host` 与 `host/path/*`）；保存调 `POST /scope-revisions`（#8）。M4 不得自实现第二份编辑器 |

### 2.8 迁移编号分配

| 迁移 | 内容 | 归属 |
|---|---|---|
| 0001–0004 | 冻结（0004=全局编号序列基线，是两族编号并存的由来，见 §0） | — |
| **0005-llm-settings** | `llm_settings` 表 | M2 |
| **0006-messages** | `messages`、`message_links` 表 | M2 |
| 0007+ | 留空；任何后续 schema 演进须先走架构师变更流程，编号顺延 | — |

迁移纪律不变（lib/db.mjs：事务内版本复查；先处理历史数据再启用新约束）。

---

## c) 文件所有权（六模块互斥；本批一次性定型）

### M1 设计系统与外壳

- `client.js`（本批一次性重写：双布局外壳 + hash 路由接线 + 主题注入 + ctx 扩展；完成后重新冻结）
- `test-ui-server.mjs`（删除 `#0b1220` 硬编码深色背景，改为 token 驱动中性底 + `?theme=light|dark` 参数）
- `lib/ui/theme.mjs`、`lib/ui/render.mjs`、`lib/ui/record-ids.mjs`、`lib/ui/router.mjs`（均新增）
- `test/ui-shell.test.mjs`（重写：双布局、路由、注册表 8 id、键盘可达、aria）
- `test/ui-design.test.mjs`（新增：token 对比度断言、字面颜色 grep、渲染器单测、编号解析全用例）

### M2 后端修复与新接口

- 修复：`lib/store/scope.mjs`（host 比对 + 路径通配）、`lib/store/verification.mjs`（subject_kind
  语义化 + 游标统一 + **jobView.latest_result 补 reviewed_evidence_revision/reviewed_manifest_id**，
  见 §d-2）、`lib/routes/verification.routes.mjs`（cursor）、`lib/store/records-read.mjs`
  （前缀表与视图扩展）
- 新增：`lib/routes/llm.routes.mjs`、`lib/store/llm-settings.mjs`、`lib/routes/messages.routes.mjs`、
  `lib/store/messages.mjs`、`lib/routes/explore.routes.mjs`、`lib/store/explore.mjs`、
  `lib/routes/diagnostics.routes.mjs`、`lib/store/diagnostics.mjs`、`lib/routes/report-export.routes.mjs`（#53）、
  `lib/db/migrations/0005-llm-settings.mjs`、`lib/db/migrations/0006-messages.mjs`
- 接线（原 AGENTS 模块文件，本批划转 M2 增量修改，改后归 M2 维护）：
  `lib/agents/model.mjs`（设置读取顺序 store>env）、`lib/agents/runtime.mjs`（消息唤醒条件 +
  §2.6-8 `reload()`）、`lib/agents/orchestrator.mjs`（读用户消息与附件 / 回复）
- 既有文件增量（竣工文件划转 M2，v1.1 补记——message_links 同事务与 asset_map 模板维度的
  唯一合法落点）：**`lib/store/orchestrator.mjs`**（recordDecision 增可选 `source_message_id`
  并同事务写 message_links；不改动其余 E1 语义）、**`lib/store/projection.mjs`**（asset_map
  快照补 endpoint_templates 分组维度，§d-10；不改动折叠/边界语义）、
  `lib/routes/projects.routes.mjs`（#4 summary 扩展）、`lib/store/reportgen.mjs`（#53 导出读取，
  只增不改）
- 测试：`test/scope.test.mjs`（增量跨 host 用例）、`test/cursor.test.mjs`、`test/records-ids.test.mjs`、
  `test/subject-kind.test.mjs`、`test/messages.test.mjs`、`test/llm-settings.test.mjs`、
  `test/explore-start.test.mjs`、`test/diagnostics.test.mjs`、`test/projects-summary.test.mjs`、
  `test/report-export.test.mjs`、`test/asset-map-templates.test.mjs`（除 scope.test.mjs 外均新增）

### M3 引导与项目列表

- `lib/ui/pages/onboarding.page.mjs`（新增）、`lib/ui/pages/projects.page.mjs`（重写）
- `lib/ui/scope/editor.mjs`（新增；§2.7 冻结签名实现方）
- `test/ui-onboarding.test.mjs`（新增）、`test/ui-projects.test.mjs`（新增）

### M4 工作台与系统诊断

- `lib/ui/pages/workbench.page.mjs`（新增）、`lib/ui/pages/diagnostics.page.mjs`（新增）
- 删除（旧页处置，内容去向见 §d/§7）：`lib/ui/pages/overview.page.mjs`、
  `lib/ui/pages/coordination.page.mjs`、`lib/ui/pages/execution.page.mjs`、
  `lib/ui/pages/changes.page.mjs`；`test/ui-coordination.test.mjs`、`test/ui-execution.test.mjs`
- **旧测试逐条迁移清单义务（v1.1，与 M6 同标准）**：删除 ui-execution（约 181 断言）/
  ui-coordination（约 259 断言）前，M4 必须在竣工记录列出逐断言去向（迁入
  ui-workbench / ui-diagnostics / 随页废弃三类）；至少以下语义纪律断言必须原句迁移并在新测试
  留名（实测出处）：`resolved 只表示该版本的问题已处理，不代表关联资产已测透（规范 §10.1）`
  （ui-execution.test.mjs:405、ui-coordination.test.mjs:636）、`恢复与重派由协调 AI 决定，
  程序不写死固定重试（规范 §3.1/§3.2）`（ui-execution.test.mjs:422）、`同项目默认最多一个
  规划调用在途（§16.1）`（ui-coordination.test.mjs:625）、`九态计数以库为准（§10.1）`
  （ui-coordination.test.mjs:634）、变化流「查看≠消费，delivered≠applied」句（changes.page.mjs
  头注释语义，迁入 ui-diagnostics）。
- 测试：`test/ui-workbench.test.mjs`（新增）、`test/ui-diagnostics.test.mjs`（新增）

### M5 资产与探索

- `lib/ui/pages/assets.page.mjs`（重写）、`lib/ui/pages/exploration.page.mjs`（重写）
- `test/ui-maps.test.mjs`（重写，沿用原名）

### M6 发现与报告

- `lib/ui/pages/findings.page.mjs`（新增）
- `lib/ui/pages/reports.page.mjs`（重写）
- 删除：`lib/ui/pages/verification.page.mjs`、`lib/ui/pages/vulnerabilities.page.mjs`、
  `test/ui-verification.test.mjs`（其**语义纪律断言逐条迁移**至 ui-findings：confirmed 限指定条件/
  insufficient 不写作已排除/falsified 不等于不存在/未应用意见警示/按已加载数据推导，见
  test/ui-verification.test.mjs:630–647 现有断言清单；并新增
  `已提交 reviewed_evidence_revision 必须显示实际值` 断言——后端字段缺口由 §d-2 M2 补齐）
- 测试：`test/ui-findings.test.mjs`（新增）、`test/ui-reports.test.mjs`（重写）

### 共享文件（本批定型；除注明者外任何人不得修改）

`package.json`（不变）、`index.js`（不变）、`lib/http.mjs`、`lib/errors.mjs`、`lib/db.mjs`、
`lib/router.mjs`、`lib/stub.mjs`、`lib/routes/ui.routes.mjs`（不变——扫描协议兼容新页面）、
`lib/db/migrations/0001–0004`、`test/helpers.mjs`、`tools/check.mjs`、`docs/BLUEPRINT.md`（v1.1 后端
冻结不变）、`docs/BLUEPRINT-UI.md`（本文）、`lib/store/record-service.mjs`（不变——M2 新接口只调
既有入口）、`lib/agents/loop.mjs`、`lib/agents/planner.mjs`、`lib/agents/worker.mjs`、
`lib/agents/verifier.mjs`、`lib/agents/dsh-bridge.mjs`（不变）、`test/change-log.test.mjs`、
`test/changes.test.mjs`（B2 回归网，M2 改游标时必须保持其绿）、`test/projection.test.mjs`、
`test/intents.test.mjs`、`test/orchestrator.test.mjs`、`test/attempts.test.mjs`、
`test/e2e-lifecycle.test.mjs`、`test/recovery.test.mjs`（六路径与 §d-10/§d-11 的后端回归网，
无人修改，保持全绿）。
**互斥自查**：新页文件 8 个互不相同；每个旧页文件只被一个模块重写或删除；`test/ui-*.test.mjs`
命名一一对应；M2 与 M1–M6 无共同文件（verification.page.mjs 由 M6 删除、M2 只动其后端）。

---

## d) 后端增量清单（每项：端点 / 迁移 / 测试落点）

| # | 增量 | 端点 | 迁移 | 测试落点 |
|---|---|---|---|---|
| 1 | scope host 比对修复 + 通配符 | 无新端点（改 #8/#26/#22 共用的 `matchScopeRule`） | 无 | `test/scope.test.mjs` 新增三组用例：①URL 规则跨 host 一律不匹配（deny/pending/allow 三态各一：`https://app.example.test/admin` vs `https://evil.other.test/admin` → false；`https://legacy.example.test/` vs `https://app.example.test/api/echo` → false；allow 同理不放行）；②路径通配 `https://api.example.test/v1/*` 按前缀通配（评审 §7a：现 `*` 是字面量匹配不到任何东西）；③`*.example.test` 子域通配仅作用于裸主机/对象规则（现状语义保留，防止回归） |
| 2 | subject_kind 语义化 + reviewed_evidence_revision 视图缺口 | 无新端点（#29/#30 视图字段） | 无 | `test/subject-kind.test.mjs`：①jobView `subject_kind === "vulnerability"`（非 `vulnerabilities`），同时返回 `subject_table`；四处写点（verification.mjs:334/:970/:1065/:1248）全改；对照 `SUBJECT_KIND_LABELS` 四值断言；②**评审 §7b 后半（v1.1 补）**：jobView `latest_result` 补 `reviewed_evidence_revision` 与 `reviewed_manifest_id` 字段（实证：jobView latest_result 现仅 id/outcome/applied/verifier_identity/created_at，verification.mjs:676–683，提交过的值到不了视图 → 页面恒显「未提供」），断言提交后视图值与写入值一致 |
| 3 | 游标统一 | #16/#29 等（§2.6-6） | 无 | `test/cursor.test.mjs`：端点清单逐个验证「信封 next_cursor + has_more + 参数 cursor」；**验证队列真实服务翻页**用例（mkdtemp 起真服务，插入 >1 页任务，两次翻页取到不重复任务集）；既有 `test/changes.test.mjs`、`test/change-log.test.mjs` 必须保持绿 |
| 4 | messages 与唤醒（含附件） | #46 POST /projects/{id}/messages、#47 GET /projects/{id}/messages | 0006 | `test/messages.test.mjs`：闭环用例（发消息 → runOnce（脚本化模型）→ decision 关联 → AI 回复 → GET 呈现三态）；**附件用例（v1.1）**：上传 blob → 发消息带 `attachments:[{kind:"blob",ref:sha256}]` → runOnce → AI 回复引用该编号 → GET 呈现 links 含 blob/capture；附件引用不存在 → INVALID_REFERENCE 整条拒绝；唤醒用例（仅新消息即可触发 hasWork）；游标分页用例 |
| 5 | 开始探索 | #48 POST /projects/{id}/explore-start | 无 | `test/explore-start.test.mjs`：未配置模型 409 LLM_NOT_CONFIGURED；**配置后同进程成功**（入口处 §2.6-8 reload）；配置后建 plan_request（复用 createPlanRequest 幂等，lib/store/orchestrator.mjs:1788）；重复调用返回既有不重复建；stopped 项目需先 resume（沿用生命周期约束） |
| 6 | 诊断聚合 | #49 GET /diagnostics | 无 | `test/diagnostics.test.mjs`：全局与单项目形体；计数与库内事实一致（造 2 个 pending 任务断言 pending_jobs=2）；unknown tool_calls 置顶；404 未知项目 |
| 7 | records 扩展 | #14（既有） | 无 | `test/records-ids.test.mjs`：两族编号各前缀可定位（A-0002 与 A-PRJ-0002-0002 → assets）；RR 双表定位；新表紧凑视图字段存在；evt- 404 + hint；MSG- 可定位（§2.3）。**项目段编号配方（v1.1 修正）**：全局族 A-0002 走 `POST /submissions {op:"register_asset"}`（record-service 两参路径）；**项目段族 A-PRJ-… 必须走 D2 去重路径**——`POST /submissions {op:"register_service_asset"}`（dedup.mjs:875 注册的操作，ensureAsset :236–244 以三参 `formatSeqId("A", ctx.projectId, …)` 产出 `A-<PRJ>-nnnn`），照抄 record-service 配方拿不到目标形态 |
| 8 | LLM 设置与运行时热加载 | #50 GET /llm/settings、#51 PUT /llm/settings、#52 POST /llm/test | 0005 | `test/llm-settings.test.mjs`：写入读取、key 不回显、test 连接成功/失败两态（本地 OpenAI 兼容测试服务器，沿 agents.test.mjs 先例）、provider 解析顺序 store>env、**§2.6-8 reload 用例**（未配置启动 → PUT → started=true 且 runOnce 可驱动 → 清除配置 → started=false） |
| 9 | 项目列表 summary | #4 扩展 | 无 | `test/projects-summary.test.mjs`：summary 字段真实（造未处理汇报/待验证/受阻意图后断言计数）；cursor 分页；不带 include 时旧形体兼容 |
| 10 | asset_map 补 endpoint_templates 维度（v1.1，支撑要求 §6 资产页「接口」块） | 无新端点（#13 内容扩展） | 无 | `test/asset-map-templates.test.mjs`：asset_map 快照含 endpoint_templates 分组（status=candidate/confirmed 分列、折叠计数与展开入口，沿 §15.1 快照纪律）；**经 D2 `propose_endpoint_template` 操作造模板**（dedup.mjs:875）；不改动既有折叠/边界语义（test/projection.test.mjs 回归网保持绿） |
| 11 | 报告导出 | #53 GET /reports/{id}/export | 无 | `test/report-export.test.mjs`：生成（#40 refresh=1）→ 导出字节与视图内容一致；跨项目/未知 id 404 不泄露；内容文件缺失 → 404 + note（沿 reportgen 既有口径）。生成动作本身零新端点（§2.6-9） |

端点号总表：#1–#44（旧蓝图 §5.1）+ #45 `GET /sorne/change-log`（已存在）+
#46/#47 messages、#48 explore-start、#49 diagnostics、#50/#51 llm settings、#52 llm/test、
#53 报告导出（M2 竣工时在 docs/modules/M2.md 登记最终号段映射；号段分配以本文为准）。

---

## e) 六条使用路径映射（要求 §8 验收场景；每条 页面→接口→测试）

**J1 新用户：连接模型 → 创建项目 → 开始探索**（含「先保存项目、后连接模型」顺序）
- 页面：向导①（连接模型）→②（创建项目）→③（导入资料，可跳过）→④（开始探索）→ 工作台进展条
- 接口：`PUT /llm/settings`（成功后 `pctx.agents.reload()`，§2.6-8——同进程内启动运行时）→ `POST /llm/test` → `POST /projects` →（可选）`POST /evidence/blobs`(#11)+`POST /captures`(#12) → `POST /projects/{id}/explore-start`(#48，入口处再 reload，§2.6-3) → `GET /changes`(#16/#45)+`GET /intents`(#21)+`GET /attempts`(#23)（进展条真实状态）→ `GET /diagnostics`(#49)
- 测试：`test/llm-settings.test.mjs::测试连接成功与失败两态`、`::保存设置后运行时热加载`；`test/explore-start.test.mjs::未配置模型返回 LLM_NOT_CONFIGURED 且 next_requirements 指向设置`、`::配置前 409、配置后同进程 explore-start 成功`、`::幂等不重复建规划请求`；`test/ui-onboarding.test.mjs::J1 未配置模型时显示『尚未连接模型，项目可以保存，AI 暂不能开始』并提供直达入口`、`::向导第③步可跳过`；`test/ui-workbench.test.mjs::进展条各段映射真实记录引用，失败显示原因不转圈`

**J2 离开后回来迅速了解当前进展**
- 页面：项目列表（五列）→ 工作台三区（正在做什么/得到了什么/需要我做什么）→ 右侧详情
- 接口：`GET /projects?include=summary`(#4) → `GET /orchestrator/overview`(#31)+`GET /attempts`(#23)+`GET /verification-jobs`(#29)+`GET /changes`(#16)+`GET /metrics`(#41) → `GET /records/{id}`(#14)
- 测试：`test/projects-summary.test.mjs::列表含状态/最近进展/待处理/最近活动且真实分页`；`test/ui-workbench.test.mjs::J2 三区计数全部来自端点并注明按已加载数据推导`；`test/ui-shell.test.mjs::刷新与直链 #/p/:pid/workbench 恢复到原页面`

**J3 从发现追溯到原始证据再回到原位**
- 页面：发现台账行内入口 → 发现详情（§2.4-2 右栏 renderDetail）→ 采集/原始证据（#/records 覆盖层）→ 关闭返回发现详情原位
- 接口：`GET /vulnerabilities`(#30) → `GET /records/{V-…}`(#14)（evidence_index）→ `GET /captures/{id}`(#44) → `GET /evidence/blobs/{sha256}`(#43)
- 测试：`test/ui-findings.test.mjs::J3 发现→证据→关闭覆盖层回到发现详情原位`（按 §2.4-2 返回栈规则断言：应用内前驱存在 → history.back 回 `?id=V-…` 态且阅读位置保留；**深链直开详情关闭 → 列表态**两分支都测）；`test/ui-design.test.mjs::A-PRJ-0002-0002 解析为资产而非 PRJ-0002（整体匹配）`；`test/records-ids.test.mjs::项目段编号与扩展前缀可定位`；`test/ui-verification.test.mjs` 的语义断言迁移后由 `test/ui-findings.test.mjs` 继承（「限指定条件」「不写作已排除」「不等于历史上不存在」三句原文出现）+ `已提交 reviewed_evidence_revision 必须显示实际值`

**J4 任务受阻 → 用户补充资料 → AI 接收并继续**（资料半边有契约，v1.1）
- 页面：工作台「需要我做什么」（受阻任务 + 缺什么）→ 任务详情 → 补充资料（上传）随消息附件提交 → 消息闭环三态 + 附件链接呈现
- 接口：`GET /attempts`(#23)+`GET /records/{I-…}`(#14)（resume_conditions）→ `POST /evidence/blobs`(#11)+`POST /captures`(#12) → `POST /projects/{id}/messages`(#46，`attachments` 带 B-/CAP- 编号，§2.6-2) 或 `POST /attempts/{id}/context`(#35) → `GET /projects/{id}/messages`(#47)（闭环+links 含 blob/capture）→ `GET /attempts`(#23)（状态变化）
- 测试：`test/messages.test.mjs::消息闭环：接收→关联任务→AI 回复`、`::附件消息闭环：上传资料经 attachments 进入 AI 上下文并可经 read_record/read_blob 读取`、`::附件引用不存在整条拒绝`；`test/ui-workbench.test.mjs::J4 消息发出后呈现已接收/对应任务/AI 处理结果与附件入口，不是孤立气泡`；`test/attempts.test.mjs`（既有）保证补充上下文与受阻恢复语义不回归

**J5 调整探索重点 → 计划/执行相应变化**
- 页面：工作台对话（「接下来优先研究登录相关功能」）→ 探索页方向列表出现新方向/优先级或既有方向调整，变化流给出计划接收事件
- 接口：`POST /projects/{id}/messages`(#46) → Orchestrator `recordDecision`(request_planning) → Planner（AGENTS 循环）→ `POST /plan-revisions`(#20) → `GET /intents`(#21)+`GET /changes`(#16 plan.received)+`GET /snapshots/exploration_map`(#13)
- 测试：`test/messages.test.mjs::调整重点经协调决定转规划请求`；`test/ui-maps.test.mjs::J5 新意图出现在探索方向列表且依据/前提随记录呈现`；既有 `test/intents.test.mjs`、`test/orchestrator.test.mjs` 保证计划接收/依赖语义不回归

**J6 暂停 → 恢复 → 查看报告（按需生成、导出），成果与关系完整保留**
- 页面：顶栏（暂停 → 「正在暂停，仍有 N 个收尾中的操作」→ 已暂停）→ 恢复 → 报告页（当前+历史版本、数据截止边界、生成/导出按钮）
- 接口：`POST /projects/{id}/lifecycle`(#7) → `GET /projects/{id}`(#6)+`GET /attempts`(#23)（收尾计数）→ `GET /reports/vulnerabilities`(#39)+`GET /reports/milestones`(#40，按需生成= `?refresh=1`，§2.6-9) → `GET /reports/{id}/export`(#53) → `GET /records/{id}`(#14)（报告内编号跳转）
- 测试：`test/ui-workbench.test.mjs::J6 暂停反馈收尾中操作数并在归零后转已暂停（不假装停止）`、`::顶栏五态与后端状态一一对应`；既有 `test/e2e-lifecycle.test.mjs`（保存→派发→确认→恢复→再次规划全链路）与 `test/recovery.test.mjs` 作为「成果与关系完整保留」的后端回归网；`test/ui-reports.test.mjs::阶段报告注明数据截止版本与时间`、`::生成阶段报告（refresh=1）后版本+1 且读取默认不增殖`、`::导出下载内容与视图一致`

---

## f) P0 修复确认表（每项给「死掉」的判定标准）

| # | 缺陷（评审出处） | 修复落点 | 「死掉」判定标准（测试名 / 检查脚本） |
|---|---|---|---|
| **P0-1** | 深色宿主下正文对比度 1.18:1（评审 §1；test-ui-server.mjs:68 硬编码深底 + 宿主变量为空） | §2.1 全量自有 token；test-ui-server.mjs 硬编码背景删除 | ①`node --test test/ui-design.test.mjs`，用例 `深色主题 token 对比度全部达标（正文/导航/按钮/状态徽章 ≥4.5:1，控件边框 ≥3:1）`——对 theme.mjs 声明的每对前景/背景以 WCAG 相对亮度公式**确定性计算**，任一 <4.5 失败；②同文件用例 `UI 文件无字面颜色值、无宿主变量引用`（v1.1 扫描面＝§2.1 全部 UI 文件清单含 client.js/test-ui-server.mjs/lib/ui/scope/editor.mjs，grep 断言 0 命中，theme.mjs 唯一豁免）；③`test/ui-shell.test.mjs::深浅两主题下导航项与正文计算样式对比度 ≥4.5`（jsdom/无头 DOM 取 computed style） |
| **P0-2** | 编号解析对项目段编号全错且 6 份副本（评审 §4a） | §2.3：lib/ui/record-ids.mjs 唯一实现 + records-read 前缀表扩展 | ①`test/ui-design.test.mjs::编号解析：A-PRJ-0002-0002 解析为资产（assets），绝不解析出 PRJ-0002`（两族格式 × 全部前缀用例表）；②`test/ui-design.test.mjs::全站编号解析唯一实现`——`grep -c "RECORD_ID_RE" lib/ui/pages/*.page.mjs` 必须 0 命中（旧 6 份副本所在页面已删除/重写）；③`test/records-ids.test.mjs::/records 支持项目段编号与扩展前缀`（真实服务：造项目→提交资产→`GET /records/A-PRJ-0002-0002` 返回 kind=assets） |
| **P0-3** | 验证队列「加载更多」真实服务下失效（评审 §4c；next_after/after/cursor 三套并存） | §2.6-6 游标统一 | ①`test/cursor.test.mjs::验证队列真实服务翻页`（不起 mock：helpers 起真服务造 >1 页任务，两次翻页断言任务集不重复且 next_cursor 推进）；②`test/cursor.test.mjs::全部列表端点信封统一`；③`test/ui-findings.test.mjs::加载更多使用 cursor 参数并跨页累积`（UI mock 双分支：cursor 主路径 + after 兼容路径，**写死单一错误参数的用例视为失败**——ui-verification.test.mjs:641 旧断言随文件重写移除） |
| **P0-4** | subject_kind 用物理表名，出现「未知类型（vulnerabilities）」（评审 §4b） | verification.mjs 四处写点语义化（§d-2） | ①`test/subject-kind.test.mjs::jobView subject_kind 为语义类型`（vulnerability/hypothesis/fact/observation 四值断言 + subject_table 并存）；②`test/ui-findings.test.mjs::验证队列不出现『未知类型』字样`——渲染后文本对 `未知类型（` 的匹配必须 0 次（该断言作为永久回归闸） |
| **P0-5** | scope URL 规则不比对 host，跨 host 的 deny/pending/allow 全部误匹配；路径 `*` 是字面量（评审 §7a） | scope.mjs `matchScopeRule` 重写（§d-1） | `test/scope.test.mjs` 新增用例组（全部为「应为 false 却返回 true」的死判据）：`URL 规则跨 host 的 deny 不匹配`、`URL 规则跨 host 的 pending 不误标`、`URL 规则跨 host 的 allow 不放行`（三个评审实测样本进测试向量）、`路径通配符按前缀通配`（`/v1/*` 匹配 `/v1/anything`）、`子域通配仅作用于裸主机规则`。既有同 host 用例必须保持绿 |
| **P0-6** | 消息发出后无接收/对应任务/AI 处理的闭环（要求 §4 尾段） | §2.6-2 messages（含附件）+ 唤醒 + links | ①`test/messages.test.mjs::消息闭环：接收→关联任务→AI 回复`（脚本化模型替身驱动 runOnce；断言 links 含 orchestration_decision 且 AI 回复 direction=ai）；②`test/messages.test.mjs::新用户消息单独构成唤醒条件`；③`test/ui-workbench.test.mjs::消息发出后可见 已接收/对应任务/AI 处理结果 三段，未闭环的消息状态不得显示为已答复`；④附件半边（v1.1）：`test/messages.test.mjs::附件消息闭环`——资料经 attachments 进入 AI 上下文（J4 资料被接收的可证测试） |

---

## g) 旧九页处置（内容去向；语义纪律零丢失）

> 旧 9 页 = 旧蓝图 §9 注册的 9 页；另有 changes.page.mjs（B2 后补）共 10 个文件，逐一定向：

| 旧页（id / 文件） | 去向 | 明细 |
|---|---|---|
| overview / overview.page.mjs | **删除**（M4） | 健康状态 → 顶栏徽章（M4）；「4 张卡 + 6 指标」重做（评审 P1-5）→ 工作台顶部；/metrics 原始 JSON 逐行铺开 → **系统诊断**（折叠，配合 #49 聚合）；「漏洞数量不是唯一健康指标」句保留在诊断页语义说明 |
| projects / projects.page.mjs | **重写**（M3） | 列表五列化 + 真分页 → 项目列表页；范围版本查看/编辑 → 范围编辑器组件（M3，经 §2.7 签名被 M4 项目设置复用）；生命周期操作 → 顶栏（M4） |
| assets / assets.page.mjs | **重写**（M5） | 五块信息落点（要求 §6，v1.1 补）：站点树 ← #13 服务/主机层级；资产列表 ← #13 分组 DataTable + 行内入口；技术栈 ← #13 asset_type 分组视图（口径标注：以资产类型聚合，画像能力后续）；接口 ← #13 模板维度（§d-10 M2 补入）+ #14 records(T-…)；文件及来源 ← #14 证据索引 + #43/#44。`project_id:… fold_since:… limits:…` 投影范围裸串 → 页头「数据时刻/截止边界」一行；`original_input/scope_status/activity_seq/created_seq` 裸字段 → FieldRow + LABELS |
| exploration / exploration.page.mjs | **重写**（M5） | 方向列表 + 局部分支图为主视图；完整大图降为辅助视图（`view=full`）；依据/进展/阻塞/后续逐方向呈现 |
| changes / changes.page.mjs | **删除**（M4） | 变化流 → 系统诊断：每事件一行摘要（时间+类型+主体编号 chip+一句人话），payload 折叠，按 event_type 分组（评审 P1-5）；「查看≠消费（delivered≠applied）」句原样保留 |
| execution / execution.page.mjs | **删除**（M4） | 队列/受阻/待办 → 工作台「正在做什么/需要我做什么」与任务详情；租约剩余时间、unknown 工具调用、工具调用明细 → 系统诊断；unknown 红字纪律原样迁移 |
| verification / verification.page.mjs | **删除**（M6） | 验证队列 → 发现页「验证」区（Manifest、outcome、等待时长、未应用意见警示）；游标统一后走 cursor；`reviewed_evidence_revision` 提交值必须显示实际值（后端缺口 §d-2 M2 补，页面侧 normalizeResult 读取字段名不变） |
| vulnerabilities / vulnerabilities.page.mjs | **删除**（M6） | 漏洞台账 → 发现页主表（状态与复核状态分列、条件与证据入口、确认版本 JSON 折叠）；confirmed（限指定条件）/insufficient/falsified 三句纪律原样迁移 |
| coordination / coordination.page.mjs | **删除**（M4） | 工作面板 → 工作台；未处理汇报与三层展开（交接卡→关键记录→完整依据）→ 工作台列表 + 右侧详情；「需要决策的待决事项」→ 工作台「需要我做什么」 |
| reports / reports.page.mjs | **重写**（M6） | 当前/历史版本切换、覆盖缺口、数据截止边界保留；**「生成阶段报告」按钮 ← #40 `?refresh=1`、「导出」← #53**（要求 §6 两动作落点，v1.1 补）；解释性段落（评审：8247 字 40 个 §）收进「语义说明」折叠区，正文只留任务导向一句 |

**语义纪律保留清单（重构验收项，逐条迁入新页并在测试中留名；v1.1 由 11 条扩至 14 条）**：
①确认/证伪/不足三句措辞；②unknown 置顶红字；③数据时刻/截止边界/不代表全量；④计数按已加载
数据推导；⑤delivered≠handled；⑥折叠不删记录（展开入口+计数）；⑦未提供≠不存在；
⑧501 未实现≠报错；⑨用户「请求复核」只能经验证流程（不得偷偷改状态）；⑩每页「§」≤2；
⑪`resolved 只表示该版本的问题已处理，不代表关联资产已测透（规范 §10.1）`；⑫`恢复与重派由
协调 AI 决定，程序不写死固定重试（规范 §3.1/§3.2）`；⑬`同项目默认最多一个规划调用在途
（§16.1）`；⑭九态计数以库为准（§10.1）。⑪–⑭ 实测出处：test/ui-execution.test.mjs:405/:422、
test/ui-coordination.test.mjs:625/:634/:636——M4 删测前逐句迁入 ui-workbench/ui-diagnostics；
①–⑩ 原文出处见 test/ui-verification.test.mjs:630–647 与各页现文案（M6/M4 重写时逐条搬移并在
竣工记录核对）。

---

## 9. 门禁与走查（不变项）

```bash
npm test        # node tools/check.mjs + node --test "test/*.test.mjs"（新测试文件自动纳入）
npm run ui      # 人工走查 http://127.0.0.1:8898/（M1 改造后支持 ?theme=light|dark）
node --test test/ui-design.test.mjs   # P0-1/P0-2 专项（token 对比度 + 编号解析）
node --test test/cursor.test.mjs      # P0-3 专项
node --test test/scope.test.mjs       # P0-5 专项
node --test test/messages.test.mjs    # P0-6 专项
```

竣工标准（六模块通用）：`npm test` 全绿（含改造后 439 条既有测试——**只许因页面重组而迁移
断言，不许静默删除领域断言**，迁移清单写入各模块竣工记录；M4 按 §c 的逐条迁移清单义务执行）；
本模块名下 P0 判据全过；竣工记录 `docs/modules/<id>.md`（M1–M6）按旧模板填写。

**并行性与终验（v1.1 修订）**：六模块文件互斥（§c 脚本已核）故可并行施工；M1 的 shell 测试
断言**导航 id 集合**（旧页即使仍在 manifest 也不入导航，§2.5），不存在中间态必红或对 M4/M6
删除时序的隐式依赖。终验（架构师执行）增加两项：①manifest 恰为 §2.5 注册表 8 个 id（旧页
文件此时应已全部删除）；②全站 `grep -rnE "#[0-9a-fA-F]{3,8}\b|rgba?\("`（§2.1 清单）0 命中。
联调依赖仅一条：M4/M5/M6 新页依赖 M1 的 ctx 形状与 M2 的端点——以 §2 契约为准先行并行
开工，联调在 M1/M2 竣工后进行。

## 10. 风险与待决（无法在本文定死的事项，如实记录）

1. **深色主题像素级验收依赖浏览器**：token 级对比度为确定性脚本可验（P0-1①②），但渲染后
   computed style 的第三道闸（P0-1③）需要 DOM 环境；ui-shell 测试宿主能否在无头环境稳定取
   computed style 待 M1 验证，若不能则该项降级为「走查清单项 + 人工确认」，不虚报自动化通过。
2. **RR- 前缀跨 report_revisions / report_receipts 两表**（§0）：按序探测可定位但语义含混；
   长期应拆前缀（新编号分配规则变更需走迁移），本批只做定位修复，不做历史编号改写（规范 §6.3
   历史编号保留映射）。
3. **两族编号并存是 0004 迁移的历史结果**（record-service 与 dedup 双路径）：统一到一族需要
   全量编号迁移，风险大于收益；P0-2 采用「两族都正确解析」而非「消灭一族」。同实体双路径
   （A 经 record-service 或 dedup）的格式差异在发现页/资产页以 chip 类型标注，不在本批收敛。
4. **api_key 存库**：信任边界为回环-only（旧蓝图 §2.1），库文件在 `~/.sorne`（0700 目录假设
   未显式实施）；若宿主部署形态变化（多用户共享机器），api_key 应移出库文件——留待实施评审
   （规范 §22），本批冻结「响应永不回显明文 key」。
5. **messages 的 AI 回复质量依赖 Orchestrator 循环**：闭环的「AI 处理结果」在无 LLM 配置时
   只能停在 received（`agents.started=false`）；UI 必须如实呈现「AI 暂不能开始」而非超时假象
   （与要求 §1 一致）。闭环测试用脚本化模型替身，不依赖真实服务（沿 AGENTS 模块先例）。
6. **dsh 真实宿主**：hash 路由依赖浏览器 `location.hash`，若宿主将来提供整页插槽或使用
   MemoryRouter 环境需回访 lib/ui/router.mjs（单文件，M1 维护）；settings.section 插槽假设
   沿用旧蓝图 §13.2。
7. **端点号段**：#46–#52 为本文预分配；M2 竣工时如有出入以竣工记录为准并回报架构师修订本表。
8. **进展条与「系统异常」态的阈值**（投影滞后多少算异常等）：首版取定性呈现（滞后>0 即显示
   数值不判级），分级阈值留实施评审。
9. **报告内容文件在磁盘**（§5.2 `reports/…` 布局）：#53 导出与报告视图同源依赖文件可读；
   文件缺失时按 reportgen 既有口径返回 404 + note（refresh=1 可重建），M6 不得虚报导出成功。
   磁盘异常属 §d-6 证据容量/完整性观测的组成部分。
