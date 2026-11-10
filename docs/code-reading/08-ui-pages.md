# 08 · ui-pages 重页面精读（workbench / diagnostics / reports / exploration / assets）

> 阅读方式：逐文件整读（大文件分段 read），只读源码；本报告是本次唯一写盘文件，未修改任何源码、未运行 npm test / npm run ui。
> 代码行号对应当前工作区快照（项目无 git，2026-11-10）。蓝图为《BLUEPRINT-UI v1.1》，模块记录见 docs/modules/ui-M*.md。
> 结论一句话：五页把「只读、不制造第二真值源」的纪律落实得相当彻底（零 import、零字面颜色、501/未提供/占位口径齐全），
> 但工作台右栏存在一条真实的异步竞态（P1-1），系统诊断的轮询在 keep-alive 隐藏态下持续运行且无请求序号保护（P1-2/P1-3），
> 另有若干死代码与文档/契约漂移（P2）。

## 1. 范围与文件清单

| # | 文件 | 行数 | 一句话职责 |
|---|---|---|---|
| 1 | lib/ui/pages/workbench.page.mjs | 1931 | 工作台：三区（正在做什么/得到了什么/需要我做什么）+ 进展条 + 四卡/指标 + 消息闭环 + 汇报三层右栏详情 |
| 2 | lib/ui/pages/diagnostics.page.mjs | 1445 | 系统诊断：健康/模型、九态计数、计划、验证积压、Outbox、投影滞后、证据完整性、租约/工具调用、变化流只读视图、metrics 原始 JSON |
| 3 | lib/ui/pages/reports.page.mjs | 1423 | 报告阅读与交付：漏洞报告列表/单版、阶段报告五分区 + 按需生成（refresh=1）、覆盖缺口、Markdown 导出、右栏报告详情 |
| 4 | lib/ui/pages/exploration.page.mjs | 1116 | 探索：方向列表/局部分支图/完整大图/链路图 + 方向详情（合同字段 + 关系边 + 消息草稿） |
| 5 | lib/ui/pages/assets.page.mjs | 1107 | 资产：资产快照（资产列表/技术栈/接口/资产目录）+ 采集读取 + 资产详情（来源、相关发现、消息草稿） |

读取时同时交叉核对（不属于本卡写入范围，仅作为契约依据）：client.js（外壳/槽位/api）、lib/ui/router.mjs、
lib/ui/render.mjs（渲染器契约）、lib/routes/*.mjs 与 lib/store/*.mjs（端点与数据形状）、docs/BLUEPRINT-UI.md、
docs/modules/ui-M4.md、ui-M4-diagnostics.md、ui-M5.md、ui-M6-reports.md 及对应测试。

## 2. 模块职责与关键导出

### 2.1 workbench.page.mjs（1931 行）

**导出/结构**
- 唯一导出一份页面对象：id=workbench、title=工作台、order=20、render(ctx)、renderDetail(ctx)（:202-205、:1324）。
- render 内定义 WorkbenchBody（React.Component 子类，缺 React 时降级基类，:208-212），状态是六个独立数据面
  overview/attempts/verification/changes/messages/diagnostics，每个形如 {phase,data,error}（:218-223），
  外加 compose 与 dataAt；每个端点各有一个递增序号（:227-232）。
- renderDetail 定义 WorkbenchDetail：phase 含 loading/ready/other/notimpl/error/unrecognized、三层 layers.keyRecords/fullBasis、chain、seq（:1330-1348）。

**取数与数据流（入口 → 端点 → 派生视图）**
- 挂载：componentDidMount → refreshAll()，再订阅 router.onChange（:237-241）。refreshAll 在无 projectId 时只把 overview 置 ready-null（:258-271），随后并发发六个 GET：
  #31 /sorne/orchestrator/overview?project_id=（:290）、#23 /sorne/attempts?…&limit=50（:299）、
  #29 /sorne/verification-jobs?…&limit=50（:308）、#45 /sorne/change-log?…&limit=20（:317）、
  #47 /sorne/messages?…&limit=50（:326）、#49 /sorne/diagnostics?…（:378）。
  每个 load 用 const mine = ++this.seqXxx，回调里 if (mine === this.seqXxx) 丢弃旧响应（:287-382）；501 被映射为 notimpl 态（:88-90、:292）。
- 派生视图全部由已加载数据本地计算：projectStatus/planCounts/intentCounts/activeIntents/blockedIntents/pendingReports/pendingItems/findings/latestPlanRevision/highWatermark/health/llm（:447-575）；
  进展条六段 progressStages()（:585-670）严格按冻结映射用真实事实判定，读取中不显示假进度（:668-669）。
- 对话：sendMessage 本地校验空内容/附件编号后 POST /sorne/messages（:409-443），成功后清空输入并重读 #47；loadMoreMessages 用 next_cursor 续读并按 id 去重合并（:341-373）。
- 右栏：loadReport(reportId,{asBase,chain}) 读 /sorne/worker-reports/{id}?project_id=&layer=handoff_card（:1384-1385），
  loadLayer 按需读 layer=key_records|full_basis（:1410-1413），loadHandoffPage 按 page 续读并合并分组（:1433-1457），
  routeRef(pointer) 解析 read_pointer（:1461-1496），popChain 回退基线链（:1498-1503）。

**渲染结构**：header（刷新/数据时刻/未连接模型徽章/语义说明折叠，:681-746）→ 暂停过渡态（:837-867）→ 进展条（:750-790）→ 指标卡网格（:794-828）→ 三区（:871-1129）→ 对话（:1133-1267）→ 页脚口径（:1313-1315）。

**精读发现**（详见 §7）：右栏「读取基线 → 直达 key_records」路径有竞态（P1-1）；renderIndicators 与 todoCount 死代码（P2-10）；
header/蓝图仍写「4 张卡 + 6 项指标」而实现是一格 7 项（P2-11）；loadMore 按钮只看 has_more 不看 cursor（P2-1）。

### 2.2 diagnostics.page.mjs（1445 行）

- 导出：default { id:"diagnostics", title:"系统诊断", order:70, render }（:64-67）；无 renderDetail（诊断页单栏）。
- 结构：DiagnosticsBody 一个类组件（:77-104），状态含 diag/global/metrics/health/log/attempts 六个数据面 + subscriptionInput/dataAt/auto/navSeq；
  另用 loadToolRows 读 /sorne/tool-calls?limit=200 与 /sorne/captures?limit=200 两个明细端点（:318-357）。
- 取数：loadAll（:133-141）并发 6 个：/sorne/diagnostics?project_id=（:150-152）、/sorne/diagnostics 全局（:172）、
  /sorne/metrics（:189-191）、/sorne/health（:209）、/sorne/change-log（:240-243，mode=head/more/subscription）、/sorne/attempts（:284-285）；
  自动刷新开关用 setInterval(10s) 调 loadAll({reset:true,silent:true})（:373-390），默认关闭（:97）。
- 派生：derivedAttempts(nowMs) 本地算活跃/过期/中断/unknown/running/failed 与 attention 过滤（:418-431）；
  leaseStateOf 四态：absent/live/expired/invalid，按本次渲染时刻计算（:1371-1379）。
- 渲染：页头（:454-464）→ 逐块 health/summary/plan/intents/verification/outbox/projection/evidence/attempts/log/metrics（:493-502）→ 语义说明折叠（:504-524）。
- 形状防御：extractDiagnostics/extractChangeLog/extractMetrics/extractAttempts 对未知形状返回 null → 「形状无法识别」态（:1170-1222）；
  change-log 事件字段归一 camelCase（:1176-1204）。
- 精读发现：无请求序号保护 + 隐藏态仍轮询（P1-2/P1-3）；toolRows 静默截断 200（P2-15）；尝试读取失败清空已加载 items（P2-2）。

### 2.3 reports.page.mjs（1423 行）

- 导出：default { id:"reports", title:"报告", order:60, render, renderDetail }（:239-242、:880）；ReportsPage 与 ReportDetail 两个类组件。
- 主区数据流：漏洞列表 loadVulns(cursor,{append}) → /sorne/reports/vulnerabilities?project_id=（:318-319），cursor 续读 + mergeRows 按 id 去重（:305-385）；
  阶段报告 loadMilestone({refresh}) → /sorne/reports/milestones?project_id=&refresh=1（:404-405），refresh=1 为唯一的显式生成路径；
  渲染漏洞表（:576-608）、阶段报告五分区 + 版本切换（:677-760）、覆盖缺口表（:764-849）、语义说明（:853-859）。
- 详情数据流（两跳）：先 /sorne/records/{id} 校验 kind=report_revisions 取 report_kind/subject_id/version（:935-960），
  再分派 /sorne/reports/vulnerabilities?id=&version=（:976-978）或 /sorne/reports/milestones?version=（:1009-1010）；
  V- 编号可直达最新版（:930-932）；导出先 GET /sorne/reports/{id}/export?project_id=&version=（Accept: text/markdown，:1056-1062），成功后渲染 anchor 下载（:1183-1189）。
- 错误信封：errorInfo 解析 code/status/message/note/module/notImpl/notFound（:122-143），但依赖 err.body/err.detail（宿主 api 不提供，见 P2-4）。
- 精读发现：导出失败丢失服务端 note/module（P2-4）；漏洞表行点击与 chip 点击冒泡双导航（P2-5）；列表请求失败清空已加载 rows（P2-6）；
  generateError 与 navSeq 只写不读（P2-10）。

### 2.4 exploration.page.mjs（1116 行）

- 导出：default { id:"exploration", title:"探索", order:40, render, renderDetail }（:205-208、:934）；ExplorationBody + DirectionDetail。
- 主区数据流：loadMap → /sorne/snapshots/exploration_map?project_id=（:272）；loadIntents → /sorne/intents?project_id&limit=200 + cursor（:295-298）；
  loadChain → /sorne/projects/{id}/lineage（:340）。三路各有 mapSeq/intentSeq/chainSeq 序号守卫（:226-228、:269、:293、:337）。
- 合并：intentRows 以意图端点为主、快照 briefs 兜底（:485-496）；groups 按快照 directions 分组并用意图全字段覆盖 brief（:512-541）。
- 视图：view=chain 渲染自绘链路图（:349-468，节点/边 SVG + 缩放 0.5-1.6，:453-455）；view=list 方向列表（:732-818）；
  view=graph 只画所选方向一跳邻接（:820-851）；view=full 全部关系边分组 + 判断清单（:853-916）；未登记视图回退 list（:605-607）。
- 详情：DirectionDetail 读 /sorne/records/{id}?project_id=（:972），展示合同字段（FieldRow：success_criteria/deliverables/budget/resume_conditions/
  condition_requirements/state_version/plan_revision/scope_revision/updated_seq，:1044-1060）、关系边（:1067-1081）、消息草稿
  （追问/建议暂缓 → POST /sorne/messages，:997-1016）。
- 精读发现：append 无去重（P2-7）；view=chain 不在冻结路由表且无测试（P2-8）；navSeq 死字段（P2-10）。

### 2.5 assets.page.mjs（1107 行）

- 导出：default { id:"assets", title:"资产", order:30, render, renderDetail }（:258-261、:910）；AssetsBody + AssetDetail。
- 主区数据流：loadSnapshot → /sorne/snapshots/asset_map?project_id=&fold_since=（:318-331）；loadTree → /sorne/projects/{id}/asset-tree（:473）；
  loadRecordFor → /sorne/records/{id}?project_id=（:360）；三路 seq 守卫（:279-281、:328、:357、:470）。
- 渲染：页头 → 加载/未实现/错误/未知形状分支（:411-439）→ renderTree 资产目录（:482-533，sites/tech/js/pages/interfaces/files）→
  折叠「明细表」：快照头 + 资产列表（DataTable，:609-665，含 folded 计数/样本/unfold_fold_since）+ 技术栈（:667-720，product/technology 结构化列表）+
  接口模板 candidate/confirmed（:722-774）→ 页脚数据时刻/截止边界（:459-462）。
- 详情：AssetDetail 读 /sorne/records/{id}，展示字段/计数/相关发现/已开展探索/关系边（:938-1076）+ 预填消息草稿 POST /sorne/messages（:963-981）。
- 采集读取：输入 CAP- 编号 → GET /sorne/captures/{id}?project_id=，展示 request_url_exact/integrity_status/响应 sha256/字节入口/派生链（:836-903）。
- 精读发现：renderSiteTree 与 renderSources 已断链成死代码、record 请求随之空转（P2-9）；header 仍称「五块信息」但测试明确要求只保留三块（P2-9）；
  capture 读取无 seq 守卫（P2-13）；asset-tree 错误无重试（P2-14）。

## 3. 数据模型与持久化结构（页面只读；无本批新增表）

五页均不写库（唯一写操作是用户主动发送消息 POST /sorne/messages，落库由服务端消息服务完成）。页面消费的持久结构：

| 端点/视图 | 页面用途 | 底层表/字段（依据） |
|---|---|---|
| #31 /sorne/orchestrator/overview | 工作台三区/卡/进展条 | projects、plan_runs、plan_revisions（latest_plan_revisions 按 created_seq DESC，:1604-1610 in lib/store/orchestrator.mjs）、intents、attempts、worker_reports、verification_jobs、pending 统计 |
| #23 /sorne/attempts | 工作台活跃尝试/诊断租约 | attempts：status/lease_expires_at/fencing_token/worker_id/created_seq；分页 next_cursor(created_seq)，user 角色隐藏 fencing（lib/store/attempts.mjs:741-784） |
| #29 /sorne/verification-jobs | 工作台待验证/诊断积压 | verification_jobs：status/created_at/subject_id/policy_id/policy_version |
| #45 /sorne/change-log | 工作台最新进展/诊断变化流 | 事件表（outbox/change 视图）：commit_seq/event_index/event_type/subject_ids/changed_fields/producer_id/created_at/payload；游标 log:seq:idx 或订阅游标；高水位对象（lib/store/changes.mjs:420-460） |
| #47 /sorne/messages | 工作台对话三段/消息分页 | 0005-messages：messages(id,direction,content,status∈received/processing/handled/failed,reply_to,created_at,created_by,created_seq) + message_links（附件以 link_kind=blob/capture 表达）；idx_messages_project / idx_messages_reply（migrations/0005-messages.mjs:26-49） |
| #49 /sorne/diagnostics | 工作台健康/诊断页全部聚合 | 只读聚合：llm/health/projects（全局）/project{status,plan,intents{by_status,blocked_ids},attempts,verification,reports,messages,outbox,projection（null=未投影）,evidence（integrity_anomalies 可为 null）}；generated_at 为数据时刻（lib/store/diagnostics.mjs:158-218） |
| #41 /sorne/metrics + #3 /sorne/health | 诊断 Outbox/投影/metrics 原始 JSON | outbox.by_status、pending_oldest_age_ms、retry_attempts；projection_lag.per_kind[kind].lag_commits；schema_version（lib/store/metrics.mjs:137-197/450-451） |
| #13 /sorne/snapshots/asset_map、exploration_map | 资产/探索主视图 | snapshots(id,project_id,kind∈五种,scope,snapshot_commit_seq,content_ref,schema_version,folding_notes,…；migrations/0001:533-545)；asset_map content 含 groups/edges/endpoint_templates/totals/edges_omitted/folding_notes/projection_scope（lib/store/projection.mjs:308/319-328/1292-1333） |
| /sorne/projects/{id}/asset-tree | 资产目录 | 由 assets/captures/tool_calls 聚合的 site 视图，含 asset_map_md/sites[].tech/js/pages/interfaces/files（lib/routes/asset-tree.routes.mjs:58-132） |
| #21 /sorne/intents | 探索方向合同字段 | intents：question/kind/priority/status/state_version/plan_revision/updated_seq/basis_refs/prerequisite_refs/target_asset_ids/resume_conditions/… |
| #14 /sorne/records/{id} + #38 三层 | 三个详情页 | records-read 视图 + relations.edges；worker_reports 三层（handoff_card/key_records/full_basis，含 pagination/omitted_from_this_page/read_pointer/relative_to_base/boundary，lib/store/reports.mjs:886-1018） |
| #39/#40/#53 报告 | 报告页 | report_revisions(id,report_kind∈vulnerability/milestone,subject_id,version,content_ref,basis_refs,data_boundary,created_*；migrations/0001:658-671) + vulnerabilities/facts/coverage 只读派生；导出读取 content_ref 指向的 reports/ 文件 |
| #43/#44 | 资产采集读取 | evidence blobs 按 sha256；captures(id,request_url_exact,integrity_status,tool_call_id,…) |

要点：页面把 null 与 0 严格区分（diagnostics 的 projection/evidence、assets 的 folded、reports 的 data_boundary），
所有快照/聚合都标注 snapshot_commit_seq 与 generated_at；页面不做本地迁移、不缓存到 localStorage（契约禁止）。

## 4. 主要调用链与数据流（跨模块边界）

**壳层边界（所有页面共有）**：client.js 的 ensurePageEl 以「groupKey|pageId」缓存页面元素（client.js:1071-1080），groupKey 为 p|projectId 或 guide（:1123-1126），
切项目时 pruneCaches 丢弃旧实例（:1091-1101）；页面元素放进 display:none 的 host 保留挂载（:1141-1145，keep-alive）；
右栏 ensureDetailEl 以「groupKey|pageId|params.id」为 key（:1081-1090），hash 的 ?id= 变化即换新详情实例（:1148-1152）；ctx={React,h,api,router,ui,theme}（:1060-1070）。

**工作台**：mount → refreshAll → 六路 GET 并发 → 每路 seq 守卫后 setState → 派生视图 → 三区/进展条/指标。
用户消息：onClick → 本地校验（空内容/附件）→ POST /sorne/messages → 成功后 loadMessages 重读 #47 → 渲染三段（已接收→对应任务→AI 结果）。
右栏：点击未处理汇报编号 → openDetail 改 hash ?id=WR-… → 外壳换详情实例 → loadReport（layer=handoff_card）→ 展开层时按需 #38；
读取 relative_to_base 的「读取基线」→ routeRef → loadReport(base,{asBase:true}) + loadLayer("keyRecords")（这条链有竞态，见 P1-1）。
跨模块：只通过 ctx.api（client.js:59-85 的 fetch 包装，统一错误信封 err.status/err.code）与 ctx.router（lib/ui/router.mjs:172-282，含 params/query/open/back/openRecord/onChange）。

**系统诊断**：mount/loadAll → 6+2 路并发（diag/global/metrics/health/log/attempts + tool-calls/captures）→ setState → 逐块渲染。
分页：变化流「加载更多」用 next_cursor 追加（:1060-1066）；尝试「加载更多」用 attempts.nextCursor append（:880-888）。
轮询：toggleAutoRefresh 注册 10s interval，每 tick 调 loadAll({reset:true,silent:true})（:373-390），tick 会重置变化流到 head、尝试回到第一页。

**报告**：主区 mount → loadVulns + loadMilestone 并发；「生成阶段报告」→ loadMilestone({refresh:true}) → #40 refresh=1；
版本按钮/列表行 → openReport 改 hash ?id=RR-/MR- → 详情实例 → /records 解析 → #39/#40 → 导出按钮 → #53 校验 → anchor 下载。
跨模块：报告详情是唯一「两跳取数」的详情页（hash 契约 ?id=RR-/MR- 与端点以 subject/version 取数的折中，见 ui-M6-reports 偏差 1）。

**探索**：mount → loadMap + loadIntents（+ view=chain 时 loadChain）→ 合并 groups → 按 view 渲染；视图切换 go() 改 hash（保留 id/view）。
方向详情 → /records → 合同字段 + relations.edges；消息草稿 POST /sorne/messages。router.onChange 时按新 view 重读 map/intents。

**资产**：mount → loadSnapshot + loadRecordFor(仅当 ?id=) + loadTree → 渲染目录与三块明细；fold_since 变化经 router.onChange 重读快照；
行点击 → openDetail 改 hash ?id= → 详情实例读 /records；无 ?id 时 loadRecordFor 不发请求（:352-356），但详情态下该请求的 state 只被死代码 renderSources 消费（P2-9）。

**性能观察**：工作台 6 并发 + 详情按需；诊断正常一次 8 个请求、自动刷新每 10s 再来 8 个（含 limit=200 的 tool-calls/captures），
且因 keep-alive 隐藏不卸载，切到其他页后仍持续（P1-2）；报告/探索/资产均为一次性加载 + 手动刷新，无轮询（与 ui-M6/M5 记录一致）。

## 5. 空态 / 错误态 / 501 / 形状防御口径

- 501 未实现 ≠ 报错：五页都以 isNotImplemented/isUnimplemented（code=NOT_IMPLEMENTED 或 status=501）单列 notimpl/notimplemented 态并继续渲染其余区块
  （workbench:88-90/292/1271-1277；diagnostics:1146-1148/468-471/827-833；reports:140/529-535；exploration:70-72/662-667/685-690；assets:80-82/416-420/535-543）。
- 未提供 ≠ 不存在：缺失字段统一「—（未提供）」（workbench numText/:96-100；diagnostics renderProjection null≠0 :745-765；reports boundaryText :165-176；
  exploration chipList :153-157；assets folded/接口模板 omitted :722-772），并有「空态 / 未提供 / 形状无法识别」三种可区分文案。
- 形状防御：五个页面各自对响应做形状判定（workbench 仅对 messages/attempts 等数组键做防御；diagnostics extract* 返回 null→unrecognized；
  reports 检查 reports/report 键；exploration 检查 content.directions/edges/judgements 与 intents 数组；assets 检查 content.groups）；不合法响应不被当作空数据。
- 空态：workbench 用 ui.EmptyState（:1247-1250）；exploration EmptyState（:737-742）；reports EmptyState（:549-554/486-491）；
  diagnostics 以「（暂无执行尝试/当前区间暂无事件/无工具调用记录）」文案区分；assets 用 EmptyState + 「分组为 0 是准确计数」（:617-624）。
- 错误态：错误卡/错误行都带错误码原文（errorMessage/errMessage/errNotice），且强调「其余区块独立降级」（各页 load 分面实现）；右栏详情按层独立降级（workbench:1700-1715）。
- 只读纪律：页面不提供改状态/重试流程写死入口；报告导出与消息发送是仅有的两个副作用按钮（导出为 GET 但服务端按 refresh 语义可能增殖版本，仅显式生成触发）。
- 数据口径：每页页脚/页头都有「数据时刻 / 截止边界（commit_seq）/ 按已加载数据推导 / 不代表全量」四类标注
  （workbench:699-702/1313-1315；diagnostics:459-463/526-528；reports:861-871；exploration:617-622；assets:459-462）。

## 6. 与 BLUEPRINT-UI 及各模块记录的对应与偏差

**对应**
- 页面注册表与 order 完全一致：workbench 20 / assets 30 / exploration 40 / reports 60 / diagnostics 70，且不引包、无 React 钩子、无 localStorage、无编号正则副本
  （BLUEPRINT-UI §2.5；测试 ui-workbench/ui-maps/ui-reports「页面契约」用例）。
- 数据面职责与 §1.5 一致：工作台 #31/#23/#29/#45/#47/#49；资产 #13/#14/#43/#44；探索 #13/#21/#14；报告 #39/#40/#53；诊断 #49/#41/#45/#23/#3。
- 语义纪律原句（resolved、恢复由协调 AI、单规划在途、九态以库为准、delivered≠handled、折叠不删记录、501≠报错）均落到页面折叠区或正文（各页 §5 引用行）。
- 编号唯一实现：五页都只经 ui.parseRecordId 与 ui.RecordIdChip（workbench:145-178；diagnostics navigateRecord:1140-1144；reports classifyReportId:231-237；exploration chip:140-151；assets chip:147-158）。

**偏差/漂移（逐条，均需 Lead 确认文档归属）**
1. 「4 张卡 + 6 项指标」对 7 项单行指标：BLUEPRINT-UI §1.4 与 workbench 头注释（:10-12）仍写 4 卡 + 6 指标；实现是 7 格网格（:806-820），renderIndicators 返回 null（:830-832），
   测试名也沿用旧说法但断言 7 个标签（test/ui-workbench.test.mjs:644-666）。属文档/注释滞后的不一致（P2-11）。
2. 资产页「五块信息」对三块可见：BLUEPRINT-UI §1.5 要求站点树 + 文件及来源；实现只渲染资产目录/资产列表/技术栈/接口，站点树 renderSiteTree 与来源 renderSources 未被调用（assets:577-607/776-834 死代码），
   测试明确「不再渲染站点树/文件及来源（按操作员要求只保留资产/技术栈/接口）」（test/ui-maps.test.mjs:708-718）。属后续操作口径覆盖蓝图 + 头注释未同步（P2-9）。
3. 消息端点路径：蓝图 §2.6-2 为 /sorne/projects/{id}/messages，页面实际走 /sorne/messages（workbench:290/326/430；exploration:1007；assets:973）；
   服务端两条路径同体别名，ui-M2 偏差 2 已登记。页面与实现一致，蓝图未回填。
4. 消息状态词表 answered 对 handled：蓝图 §2.6-2 为 received→processing→answered|failed；实现/C 端为 handled，workbench 用页内局部词表承接 handled（:180-198、:110-113），
   M1 VOCAB.message_status 仍是 answered（ui-M4 偏差 3 已报）。
5. 探索 view=chain 不在冻结路由表：BLUEPRINT-UI §2.4 只登记 view=graph|full（:294）；页面新增链路图视图与 /sorne/projects/{id}/lineage 数据面（:349-468），头注释未提，测试亦无覆盖（P2-8）。
6. 诊断页数据面与 #49 的 project.attempts 块：§2.6-4 的聚合块含 attempts{active_leases,expired,unknown_tool_calls}；页面不读该块，改读 #23 明细 + /tool-calls//captures（:318-357、:895-958），
   ui-M4-diagnostics 偏差 8 只说明了不读 #31/#21/#29，未登记这一处「聚合块未消费」。功能不缺失（更细），但契约面存在未用字段。
7. 版式基线：§2.1 冻结「正文 ≥14px、按钮/导航 ≥13px」；五页的表格/图/次要行大量使用 11.5-13.5px（diagnostics 表头 12/单元格 12.5 :910-932；exploration 链路节点 10.5-12.5 :431-442；
   assets 目录 12.5 :501-532；reports 表 13 :50-84；workbench 指标 12.5-13 :824-825），测试只测 token 对比度，未测字号（P2-12）。
8. 模块记录行数漂移：ui-M4.md 记 workbench 1980 行、诊断 1349 行，实际 1931/1445；不影响契约，但文档自洽性待架构师合并时校正。

## 7. 问题清单

### P0（阻断）
未发现。依据：五页均为只读消费面，唯一写操作是用户主动 POST /sorne/messages（服务端校验/落库），
页面无事务、无本地持久化、无幂等键写入；右栏详情与列表均为 GET；导出核对后给 anchor 下载。
即使 P1-1 竞态导致右栏卡在 loading，也不写坏数据、不产生第二真值源。

### P1（重要）

**P1-1｜bug｜工作台右栏「读取基线」后按层直达的竞态（层永久 loading / 错误串层）**
- 位置：lib/ui/pages/workbench.page.mjs:1461-1496（routeRef）、:1364-1396（loadReport 的 setState）、:1398-1430（loadLayer 读 this.state.id/projectId）。
- 现象：点击 relative_to_base 的「读取基线」（:1739-1744 → routeRef(rel.base_read_pointer)）时，routeRef 先调 loadReport(targetId,{asBase:true})（:1478），
  紧接着同步调 loadLayer("keyRecords")（:1479）；loadReport 内 :1376-1382 的 setState 在当前 React 事件批处理里尚未生效，
  loadLayer :1401 读到的 this.state.id 仍是旧汇报编号、:1410 用旧编号拼 /sorne/worker-reports/{旧 id}?layer=key_records。
  请求返回后 :1414 守卫 this.state.id !== id 成立 → return，layer 停在 :1405-1409 写入的 phase=loading，界面永久「正在读取本层…」；
  若该请求 reject，:1425-1429 的 catch 没有 id 守卫，会把旧汇报的层错误写进新汇报的层。
- 依据：client.js 使用真实 React（:52-53 require("react")），类组件 setState 在事件内批处理；该路径未被测试捕获，因为最小宿主把 setState 实现为同步
  （test/ui-workbench.test.mjs:113-119），所以「读取基线直达 key_records」用例（:1120-1148）恒过。
- 建议：routeRef 改为 async 并 await loadReport 后再 loadLayer；或 loadLayer 显式接收 reportId/projectId 参数，layers 状态按 (reportId,layer) 键控并加 seq 守卫。

**P1-2｜风险｜系统诊断 10 秒轮询在 keep-alive 隐藏态持续运行**
- 位置：lib/ui/pages/diagnostics.page.mjs:373-390（setInterval/stop）、:114-117（仅 unmount 清理）、:133-141（loadAll 一次 6 路）+ :318-325（再 2 路 limit=200）。
- 现象：外壳对页面做 keep-alive——隐藏页以 display:none 保留挂载（client.js:1141-1145），componentWillUnmount 不会在切页时触发；
  因此开启自动刷新后切到工作台/资产等页，诊断页仍每 10 秒发 8 个请求（diagnostics/global/metrics/health/change-log/attempts/tool-calls/captures），
  直到切项目（groupKey 变更 pruneCaches，client.js:1091-1101）或关闭标签页，无可见性判断。
- 依据：ui-M4-diagnostics 偏差 7 已登记「自动刷新仍为轮询 10 秒」，但未登记隐藏态继续轮询；测试「自动刷新：默认关闭；开启注册 10 秒定时器…关闭与卸载均清理」
  只验证 timer 注册/清理，未验证隐藏/可见行为。
- 建议：接 visibilitychange 或由壳层传递 active 状态；隐藏时暂停并保留开关，可见时恢复；或至少把轮询收敛到变化流/尝试两路。

**P1-3｜bug/风险｜系统诊断所有数据面无请求序号，自动刷新与手动操作可相互覆盖/重复追加**
- 位置：lib/ui/pages/diagnostics.page.mjs:220-268（loadLog）、:270-316（loadAttempts）、:133-141（loadAll）、:99/:127（navSeq 只加不读）。
- 现象：①连续点击「加载更多」（:1060-1066）两次，:241 读到同一个 nextCursor，:252 直接 [...prev.log.events, ...page.events] 拼接，
  没有按 event_id/commit_seq+event_index 去重 → 事件行重复；②自动刷新 tick 的 head 重置与用户「从订阅边界读取」（:396-409）并发时，
  各自成功回调用自己的 closure anchor 覆盖（:246-262），后到的旧响应可把区间/事件改回旧状态，anchor 与 events 可能不一致；
  ③loadAttempts 的 reset（append=false，:280-282 清空 items）与 append 并发时，后到响应覆盖先前累积，可能丢失或多出已加载页。
- 依据：同批页面里 workbench（:287-382）、exploration（:269/:293/:337）、reports（:309/:393）、assets（:328/:357/:470）都实现了 seq 守卫或 id 守卫，
  诊断页是唯一例外；navSeq 存在但从未参与判断。测试只覆盖单次点击的正常顺序（ui-diagnostics:586-600、:795-809），未覆盖并发。
- 建议：为 log/attempts/diag/global/metrics/health 各加递增 seq（同 workbench 模式），append 去重；自动刷新与手动操作互斥或合并请求。

### P2（次要）

**P2-1｜bug｜工作台「加载更多消息」按钮与 cursor 判空不一致**：按钮条件只看 messages.data.has_more（workbench:1256），
点进 loadMoreMessages 却在 next_cursor 非 string 时静默 return（:345-346）。若响应 has_more=true 而 next_cursor 为 null（违反 §2.6-6 但防御代码存在），
按钮点击无任何反馈。建议按钮条件同时要求 cursor 存在（:1251-1255 的进度文案同理）。

**P2-2｜不一致｜系统诊断「加载更多尝试」失败会清空已加载数据**：loadAttempts 失败分支固定 items/toolCalls/toolRows/nextCursor 置空（diagnostics:312-314），
append 续读失败同样清空整页；对照 workbench 消息续读失败保留已有 data 只附 error（workbench:370-372）。违背页面自述「游标续读不跳过区间」。

**P2-3｜不一致｜自动刷新静默重置变化流区间**：每 tick loadAll({reset:true})（diagnostics:133-141）→ loadLog mode=head，anchor 被改回「项目全部事件（从头）」（:229-234），
用户选定的「订阅 SUBS… 快照边界之后」区间与已加载更多页被丢弃；自动刷新开关处没有提示（:808-812）。

**P2-4｜不一致｜报告页错误信封解析依赖宿主不提供的字段**：errorInfo 读 err.body.detail / err.detail / err.module（reports:122-143），
宿主 api 只设置 err.status/err.code/message（client.js:68-83）；服务端导出 404 的 detail.note（report-export.routes.mjs:63-70「内容文件不可读，refresh=1 可生成新版本」）
与前缀模块信息永远无法呈现，页面只能用静态「可先…再导出」文案（reports:1191-1197）。建议 api 透传解析后的 body 或页面改用固定口径。

**P2-5｜风险｜报告漏洞表 chip 点击触发双导航**：行 onClick=openReport（reports:585-595），行内漏洞编号 chip 与报告版本 chip 也是按钮（:596/603-606）；
点击 chip 冒泡后先 openRecord 再 openReport（或反向），hash 被覆盖一次，用户可能丢失记录覆盖层。建议 chip navigate 内 stopPropagation 或行点击排除按钮目标。

**P2-6｜一致性｜报告漏洞列表失败清空已加载 rows**：loadVulns catch 将 rows/summary/note 全置空（reports:356-371），append 失败同样；
与「游标续读不静默截断」口径冲突，且用户已读内容消失。建议保留 rows，仅在顶部显示错误与重试。

**P2-7｜风险｜探索意图 append 无去重**：loadIntents append 直接 [...prev.rows, ...rows]（exploration:305-310），双击「加载更多方向」或游标重叠会产生重复方向行
（key=row-<id> 重复触发 React key 警告）；对照 workbench loadMoreMessages 有 seen 去重（workbench:351-357）、reports mergeRows 去重（reports:374-385）。

**P2-8｜不一致｜探索 view=chain 超出冻结路由契约且无测试**：BLUEPRINT-UI §2.4 仅登记 view=graph|full（:294），页面新增链路图视图与 /sorne/projects/{id}/lineage 数据面
（exploration:349-468、:334-347），页面头注释（:4-13）未列；ui-maps.test.mjs 中无 chain/lineage 用例（grep 无命中）。刷新/分享仍可用（query 通用解析，router:108-110），
但契约与测试缺口需架构师确认是否纳入。

**P2-9｜死代码+不一致｜资产页两块旧视图已断链但未清理**：renderSiteTree（assets:577-607）与 renderSources（:776-834）定义后无人调用（render 只调 renderTree/renderAssetList/renderTechStack/renderTemplates，:448-457）；
loadRecordFor 与 record 状态（:288、:348-367、:386）只被 renderSources 消费 → 详情态多一次 /records 请求；头注释仍称「五块信息各有落点」（:4-10）与 BLUEPRINT-UI §1.5，
而测试明确「不再渲染站点树/文件及来源（按操作员要求只保留资产/技术栈/接口）」（ui-maps:708-718）。建议删除死代码与空转请求，并同步头注释/蓝图。

**P2-10｜死代码/死字段｜工作台与诊断等页存在未使用的成员/字段**：workbench renderIndicators（:830-832）与 todoCount（:578-582）未使用；diagnostics INTENT_STATUS_ORDER（:53-56）未使用；
reports milestone.generateError 只写不读（:274/:400/:417/:431/:447）；workbench 以外的 navSeq 均为只写不读（diagnostics:99/127、assets:277/303、exploration:224/249、reports:278/300）。
若 navSeq 原意是请求版本水位，应按 P1-3 接线；否则删除。

**P2-11｜不一致｜「4 张卡 + 6 项指标」与实际 7 格网格不符**：workbench 头注释 :10-12、BLUEPRINT-UI :113-114、测试名（ui-workbench:644）仍所述旧结构；
实现把 7 项合并成一格网格（:806-820），renderIndicators 返回 null（:830-832），测试断言 7 个标签（ui-workbench:651-653）。属文档滞后，建议统一为「4 卡 + 6 指标（合并为 7 格）」或拆回两段。

**P2-12｜不一致｜字号低于 §2.1 冻结基线（正文 ≥14px）**：diagnostics 表头 12/单元格 12.5（:910-932）、MUTED 13（:1419）、按钮 13（:1438-1444）；
exploration 链路节点 10.5-12.5（:431-442）；assets 目录 12.5（:501-532）；reports 表 13-13.5（:50-84）；workbench 指标 12.5-13（:824-825）。
ui-design 测试只测 token 对比度（test/ui-design.test.mjs:166-178），未测字号。若紧凑表格/图例属豁免，应在蓝图与测试写明，否则按基线调大。

**P2-13｜风险｜资产采集读取无序号守卫**：readCapture（assets:887-903）连续点击/改动编号时，旧响应后到会覆盖新结果，
state.capture.id 与 data 可能不一致（同页其他三路都有 seq：:328/:357/:470）。

**P2-14｜不一致｜资产目录（asset-tree）失败无重试**：renderTree 错误分支只显示「读取失败：…」（assets:486-490），而 loadTree 只在 componentDidMount 调用（:289），
无重试按钮；对照快照错误（:422-430）、探索快照/意图错误都有重试（exploration:669-695）。

**P2-15｜一致性｜诊断工具调用表静默截断 200 条**：/tool-calls 与 /captures 固定 limit=200（diagnostics:323-324），表格只渲染已加载行（:907-953），
没有「仅前 200 条/不代表全量」标注；页面其他区块反复强调「不静默截断」，此处口径不一致（服务端 clamp 上限 500，见 toolcalls.routes.mjs）。

**P2-16｜不一致｜#49 的 project.attempts 聚合块未被消费**：BLUEPRINT-UI §2.6-4 冻结的 attempts{active_leases,expired,unknown_tool_calls}（含 unknown 置顶纪律）在诊断页未使用，
页面改由 #23 + /tool-calls 重算（diagnostics:418-431、:895-958）；功能不缺但契约面有空转字段（ui-M4-diagnostics 偏差 8 未覆盖此点）。

**P2-17｜一致性｜工作台各数据面刷新失败会清空旧内容**：settle 在 loading 时先 data:null（workbench:283-285），失败后保持 null；
刷新一次失败会把已展示的三区内容换成错误卡（对照：数据面独立降级但已读数据不保留）。属可接受取舍，但与「已加载数据推导」文案略冲突，建议失败时保留上次 data 并标注陈旧。

## 8. 测试覆盖映射

阅读完成声明：§1 五个文件均已整读（大文件按 read offset/limit 分段读完，非 grep 片段推断）。

| 页面 | 主测试 | 用例数 | 已覆盖的关键行为 | 未覆盖/缺口 |
|---|---|---|---|---|
| workbench | test/ui-workbench.test.mjs | 29 | 页面契约（零 import/无钩子/无字面色/order）、六端点取数与 501/错误/未知形状、J1 进展条六段与失败段、J2 三区、J4/J5 消息三段与附件本地校验、J6 暂停反馈、未处理汇报 handled 过滤、右栏三层/分页/基线链/非汇报编号、真实服务 #31/#23/#29/#45/#47/#49 与真实 #38 | 基线「读取基线→key_records」竞态（宿主 setState 同步掩盖，:113-119）；刷新失败旧内容清空；loadMore 按钮 cursor 不一致；行数级 7 项指标与旧测试名不符 |
| diagnostics | test/ui-diagnostics.test.mjs | 27 | #49 九态/计划/受阻族/验证/汇报消息、#41 metrics 折叠、#49 逐块 Outbox/投影 null≠0/证据、健康两态与模型未连接、#45 摘要/高水位/只读/分组/游标续读/订阅边界、租约四态、尝试筛选与置顶异常、工具调用 not_provided/摘要物化、自动刷新注册与清理、403 会话缺口 | 隐藏态轮询（P1-2）、请求并发/重复追加（P1-3）、/tool-calls 与 /captures 两个明细端点（toolRows 表无单测）、loadAttempts 失败清空、自动刷新重置订阅区间 |
| reports | test/ui-reports.test.mjs | 28 | 列表状态/边界/版本 chip/分页、五分区与空态、覆盖缺口、按需生成 refresh=1、详情两跳（RR-/MR-/V-）、历史版本提示、导出成功/失败（404 与 note 文案）、真实服务生成+导出、语义折叠区 | errorInfo 依赖 body/detail 的现实宿主行为（P2-4）；chip 冒泡双导航（P2-5）；append 失败清空（P2-6） |
| exploration+assets | test/ui-maps.test.mjs | 23 | 两页页面契约、资产快照六要素/折叠组/空态/501/错误/项目切换、详情字段/计数/关系边/消息草稿、探索列表分组与字段、图/全图视图、501 降级、方向详情 404/无 id、真实服务五块与方向呈现 | exploration view=chain 与 /lineage 零覆盖（P2-8）；assets asset-tree（目录）零覆盖与失败无重试（P2-14）；capture 读取无测试（P2-13）；资产页「只保留三块」由测试反向锁定，无正向 asset-tree 断言 |
| 跨页契约 | test/ui-design.test.mjs、test/ui-shell.test.mjs | — | 主题 token 对比度、无字面颜色/宿主变量扫描、manifest/导航可达集合、右栏槽位与 keep-alive、返回栈、路由 | 字号基线（P2-12）未断言；页面在隐藏态的资源行为未断言 |

覆盖结论：主路径与错误/501/空态覆盖较好，缺口集中在「并发/时序」与「真实外壳 keep-alive 行为」两类——这正对应 P1-1/P1-2/P1-3。

## 9. 不确定点与需 Lead 交叉确认的问题

1. **P1-1 的宿主批处理前提**：我在 client.js 使用真实 React（require("react")，:52-53）的前提下判定 setState 在事件内批处理导致竞态；
   若生产宿主的 React 版本/并发模式不同（例如 legacy 同步 flush），症状会不同。需 Lead 在真实宿主里点一次「读取基线」复现确认（测试宿主同步 setState，必然测不出）。
2. **keep-alive 隐藏态轮询是否是产品接受行为**：ui-M4-diagnostics 偏差 7 只登记「仍为轮询」，未说隐藏是否应停；若产品接受后台轮询，P1-2 降级为 P2，但建议至少补隐藏/可见测试。
3. **诊断页是否应消费 #49 的 project.attempts 聚合块**（P2-16）：现状改读 #23 明细更细但契约字段空转；需架构师定「#49 聚合是权威快照，明细页可另读」的口径。
4. **探索 view=chain 的定位**（P2-8）：是 M5 自加的可用视图还是应补进 BLUEPRINT-UI §2.4 的冻结路由表？若保留，需要 ui-maps 补链路图/lineage 用例并更新页面头注释。
5. **资产页五块→三块的最终口径**（P2-9）：测试显示是「按操作员要求」删除，但 §1.5 蓝图与页面头注释仍写五块；需 Lead 决定是回填蓝图/注释还是恢复两块（恢复则需接线死代码）。
6. **字号基线适用范围**（P2-12）：§2.1 写正文 ≥14px，但全站表格/图例普遍 11.5-13.5px；需设计系统 owner 明确表格/图例/链路图是否豁免，并在 ui-design 测试中固化。
7. **P2-4 错误信封透传**：宿主 api 只暴露 code/status/message，页面对 body.detail.note/module 的解析是死路；需确认是「改进 api 透传 body」还是「页面删掉 detail 解析」。
8. **文档行数/结构漂移**：ui-M4.md 记 workbench 1980 行、诊断 1349 行，实际 1931/1445；BLUEPRINT-UI 变更记录（v1.1）未回填消息路径/状态词表；这些属文档维护，不影响代码正确性，但终验走查会碰到。

---
附：本次精读未修改任何源码；未运行 npm test / npm run ui；报告为唯一写盘文件。
