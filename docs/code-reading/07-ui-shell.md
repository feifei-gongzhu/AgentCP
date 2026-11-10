# 07 ui-shell 前端外壳与页面 —— 代码精读报告

> 阅读范围：client.js + lib/ui/{render,router,theme,record-ids}.mjs + lib/ui/scope/editor.mjs + lib/ui/pages/{onboarding,projects,findings}.page.mjs。
> 全部 9 个文件已逐行读完（1363/848/282/295/152/424/1049/605/872 行，合计约 5890 行）；交叉核对后端 routes/store 与 BLUEPRINT-UI。只读源码，未运行测试、未改源码。

## 1. 范围与文件清单

| 文件 | 行数 | 一句话职责 |
|---|---|---|
| client.js | 1363 | dsh web 客户端入口：双布局外壳、顶栏/导航/详情槽/记录覆盖层、keep-alive 页面装载、主题与设计系统注入 |
| lib/ui/render.mjs | 848 | 统一渲染器（LABELS/VOCAB/时间/哈希/编号 chip/折叠/徽章/字段行/表格/空态），经 bindRenderers 注入 React |
| lib/ui/router.mjs | 282 | 冻结 hash 路由表解析 + 返回栈（navLog）+ openRecord/open/replace/back 句柄 |
| lib/ui/theme.mjs | 295 | 24 个颜色 token × 明暗双主题、对比度契约与 WCAG 计算、CSS 注入、theme 三态句柄 |
| lib/ui/record-ids.mjs | 152 | 全站唯一编号正则（整体匹配两族）+ 事件编号排除 + 前缀→物理表/中文类型镜像表 |
| lib/ui/scope/editor.mjs | 424 | 范围三区文本编辑器（allow/deny/pending），文本↔规则纯函数、保存 POST /scope-revisions、§2.7 冻结签名 |
| lib/ui/pages/onboarding.page.mjs | 1049 | 四步向导（连接模型→创建项目→导入资料→检查开始），消费 /llm/*、/projects、/evidence、/explore-start |
| lib/ui/pages/projects.page.mjs | 605 | 项目列表五列 + 创建/删除 + 真游标分页 + 无模型横幅/空态引导 |
| lib/ui/pages/findings.page.mjs | 872 | 发现台账（#30）+ 右侧详情（#14/#29/#43/#44/#21/#46），请求复核走用户消息 |

## 2. 模块职责与关键导出

- client.js：工厂 `window.__ModuleLoader__.load({id:"sorne"})`；导出 `apply(ctx)`（向 `settings.section` 槽注入 SornePanel）、`inject=["slots"]`、`__test__`。内部纯函数 `resolveRunStatus`（138-231，五态+正在暂停+状态未知）、`resolveLlmGate`（235-262，三态门控）、`createShellRuntime`（317-1314）返回 {Shell, SornePanel, Topbar, RecordOverlay, SettingsDrawer}。常量 WORKSPACE_PAGES/GUIDE_PAGES/DIAGNOSTICS_PAGE/RECORDS_PAGE/PAGE_LABELS/SLOT_OWNERS（109-132）与 router.mjs 导出为一份冻结白名单。
- render.mjs：`bindRenderers({createElement,Component})`（28-33）为唯一注入点；导出 LABELS（44-218，约 170 字段）、VOCAB（231-320，12 词表）+RUN_STATUS（323-331）、formatTime（345）、formatHash（384）、RecordIdChip（440）、FoldableObject（563）、StatusBadge（610）、FieldRow（675）、DataTable（741）、EmptyState（832）。有状态类（FoldableToggle/TableBody）模块级缓存一次（494-495、748），保证重渲染不丢交互态。
- router.mjs：`parseHash`（86-144）、`pageBaseHash`（147-151）、`recordHash`（154-157）、`createRouter`（172-282，handle 含 hash/page/projectId/recordId/params/query/open/replace/back/openRecord/onChange/isInAppHistory + `__test__`）。`navLog` 记账 201-209，`back` 256-263 有前驱走 history.back() 否则 replace(fallback)。
- theme.mjs：TOKENS（33-58）、CONTRAST_PAIRS（67-93，25 对）、relativeLuminance/contrastRatio/tokenHex/evaluateContrast（104-148）、BASE_CSS（156-172）、buildThemeCss/ensureThemeStyle（175-196）、createThemeHandle（231-295，localStorage key "sorne-theme"，三态，matchMedia 跟随；applyToDocument 使用全局 document 而非注入 doc）。
- record-ids.mjs：RECORD_ID_RE=`^([A-Z][A-Z0-9]{0,5})(?:-PRJ-(\d{1,8}))?-(\d{1,8})$`（30）、EVENT_ID_RE（37）、PREFIX_TABLES（46-78，30 项）、PREFIX_LABELS（81-113）、parseRecordId（123）、isEventId（142）、hasProjectSegment（147）。
- scope/editor.mjs：`scopeRulesToText`（41）、`parseScopeRulesText`（59）、`createScopeEditorElement`（385）、`openScopeRulesEditor`（402，§2.7 冻结签名实现）；类组件按 ComponentBase 身份缓存（119-135、353）避免输入焦点丢失。
- onboarding.page.mjs：default {id:"onboarding",title:"首次使用",order:5,render}；单类 OnboardingBody，状态 step/llm/modelForm/test/proj/editor/imports/start；动态 import 范围编辑器（36-53）。
- projects.page.mjs：default {id:"projects",title:"项目",order:10,render}；ProjectsBody，`load` 用 `++loadSeq` 丢弃过期响应（295、305、328）。
- findings.page.mjs：default {id:"findings",title:"发现",order:50,render,renderDetail}；列表类 FindingsBody + 详情类 FindingDetail；游标适配 `cursorOf`（58-63，next_cursor/cursor 主路径、next_after/after 兼容）。

## 3. 数据模型与持久化结构

外壳与页面**不直接读写数据库**，只经 `/sorne/*` HTTP 端点（client.js:59-85 的 api()）。涉及的真值结构（后端核对）：

- projects：id,name,description,task,status,current_scope_revision,state_version,next_commit_seq,created_seq,created_at（lib/store/record-service.mjs:1194-1199）；UI 读 /projects?include=summary 的五列字段来自 projects + outbox 最近事件 + 三个 COUNT（projects.routes.mjs:52-130）。
- scope_revisions：id,project_id,revision,rules(JSON {allow,deny,pending}),summary,created_seq；当前版本挂在 projects.current_scope_revision（record-service.mjs:1160-1172、1329-1356）；范围判定在读取时解析（lib/store/scope.mjs:146-210，未配置→pending/unconfigured、未列出→pending/unlisted）。
- outbox：event_type,subject_ids,created_at,commit_seq 供 "最近进展" 摘要（projects.routes.mjs:52-71）；UI 再经 EVENT_TYPE_LABELS 映射中文（projects.page.mjs:88-109）。
- vulnerabilities：id,location,category,status,review,impact,conditions,confirmed_version,state_version,claim_revision,evidence_revision,assessment_epoch；台账另附 evidence 计数（supports/contradicts/total）与 candidate_groups（lib/store/judgements.mjs:729-843）；证据计数来自 evidence_memberships(status='active')。
- verification_jobs / verification_results / evidence_manifests：jobView 输出 waiting_ms、manifest{id,evidence_revision,members_count,content_hash}、latest_result{outcome,applied,verifier_identity,reviewed_manifest_id,reviewed_evidence_revision}（lib/store/verification.mjs:705-761）。
- records 读取信封：{record, evidence_index, relations{edges,truncated}, expand, note?}（lib/store/records-read.mjs:780-839）；evidence_index 成员含 member_id/member_kind/stance/status（:234-247）。
- blobs/captures：blobs 以 sha256 为主键事实，captures 以 (project_id,tool_call_id) 幂等（lib/store/evidence.mjs:544-608）；GET /evidence/blobs/:sha256 返回 application/octet-stream 原始字节 + x-sorne-* 头（lib/routes/evidence.routes.mjs:52-73）。
- 客户端本地持久化仅 theme：localStorage["sorne-theme"]∈{light,dark,system}（theme.mjs:200、279）；页面契约禁止其它浏览器存储（onboarding.page.mjs:28-33 等）。
- 与蓝图偏差（后端侧，供交叉参考）：LLM 配置实际存 <dataDir>/llm.json（lib/store/llm-settings.mjs:1-16）而非蓝图 §2.6-1 的 llm_settings 表；迁移编号为 0005-messages/0006-project-task/0007…0011（lib/db/migrations/），蓝图 §2.8 的 0005-llm-settings 未落地（已在 docs/modules/ui-M2.md 偏差节自述）。UI 只依赖 GET/PUT /llm/settings 响应形体，未因存储形态而分叉。

## 4. 主要调用链与数据流（跨模块边界已标）

**A. 启动装载（宿主 → 外壳）**：ModuleLoader 加载 client.js → factory 取 React → createShellRuntime(realDeps) → apply 注册 settings.section 槽（1326-1343）→ Shell.componentDidMount 并行 loadLibModule(theme/record-ids/render/router)（940-980）→ createThemeHandle + ensureThemeStyle（948-951）→ createRouter（952）→ bindRenderers（953）→ 组装 ctx.ui（954-969）→ 订阅 router.onChange（970）→ redirectIfNeeded（treat 空/未知 hash → replace #/projects，998-1008）→ loadManifest：GET /sorne/ui/manifest（1010-1046）→ 对白名单 id 逐个动态 import(item.file) → setState pages。

**B. 路由 → 重渲染（keep-alive）**：location.hash 变化 → hashchange → syncNavLog + applyHash + notify（router.mjs:201-222）→ Shell.onRouterChange：trackUnderlay（记录覆盖层底衬，992-997）→ redirect → forceUpdate（985-989）→ render 计算 layoutPage/groupKey（1117-1125，groupKey=guide 或 `p|<pid>`）→ pruneCaches（跨项目/跨布局清缓存，1091-1101）→ 按导航白名单 + 激活页 + diagnostics 逐个 ensurePageEl（1138-1146）→ 页面元素 keep-alive（非激活 display:none）。

**C. 顶栏取数（工作区才挂载）**：Topbar.componentDidMount/项目切换 → loadAll 并行 5 个 GET：/projects/{pid}、/attempts?project_id、/intents?project_id&status=blocked、/diagnostics?project_id、/health、/llm/settings（357-407）→ resolveRunStatus/resolveLlmGate 纯函数转徽章与门控（454-475）→ 暂停/继续 POST /projects/{pid}/lifecycle {action}（411-436）→ 成功后再拉一轮 loadAll（408-410）。

**D. 右侧详情槽位（§2.4-2）**：hash 带 params.id 且页面有 renderDetail → ensureDetailEl 按 `group|page|detailId` 缓存元素（1081-1090）→ 右栏渲染 + 外壳统一关闭按钮（1266-1284）→ 关闭 = router.back(fallback 页列表 hash)（1280）→ navLog≥2 走 history.back，否则 replace（router.mjs:256-263）。

**E. 记录覆盖层（外壳级）**：任意 RecordIdChip 点击 → navigate(id) → router.openRecord(id)（render.mjs:464-468；router.mjs:265-268）→ hash `#/records/:id?project=:pid` → 底衬页保持（992-997、1118-1122）→ RecordOverlay GET /records/{id}?project_id=...（799-809）→ 渲染 record 头字段/其余字段 Foldable/relations/evidence_index/expand（854-898）→ 关闭 back 回来源页（1287-1294）。

**F. 向导 J1（onboarding）**：GET /llm/settings 预填（172-205）→ PUT /llm/settings {base_url,model,api_key?,per_role?}（218-261）→ POST /llm/test {baseUrl,model}（263-302）→ 动态 import 范围编辑器（390-403）→ POST /projects {name,description,scope_rules}（451-500）→ 可选 POST /evidence/blobs?project_id&representation=uploaded_file&source_kind=third_party_import（raw octet-stream，596-606）→ POST /captures {project_id,tool_call_id,request_url_exact,method:"IMPORT",source_kind,response_body_blob:sha256}（608-618）→ POST /projects/{id}/explore-start（699-742）→ router.open `#/p/{id}/workbench`（715）。

**G. 项目列表**：GET /sorne/projects?include=summary&limit=50[&cursor]（287-334）→ 行渲染五列+操作列（495-597）→ 创建 POST /projects {name,description,target,task,llm?}（221-267，route 侧 target→初始 allow 范围，projects.routes.mjs:152-163）→ 删除 DELETE /projects/{id}?confirm=delete（269-285；route 要求显式确认，projects.routes.mjs:188-201）。

**H. 发现页**：GET /vulnerabilities?project_id&limit=50[&status|review][&cursor]（175-224）→ DataTable（列：编号/状态/复核/证据/确认版本，247-322）→ 行点击 push `#/p/:pid/findings?id=...`（232-245）→ 详情：GET /records/{V}?project_id（463-477）→ 证据索引下钻 GET /records/{member}→GET /captures/{capture_id}→GET /evidence/blobs/{sha256}（520-555）→ GET /verification-jobs?project_id&subject_id&limit=20[&cursor|after]（479-506）→ GET /intents?project_id&limit=100 客户端按 basis_refs/prerequisite_refs 过滤（508-518、120-129）→ 「请求复核」POST /projects/{id}/messages {content}（575-595）。

## 5. 关键不变量、并发/事务/幂等/错误处理

- **页面元素 render 一次 + keep-alive**：外壳按 `groupKey|pageId` 缓存元素（1071-1080），ctx 按 group 缓存（1060-1070）；groupKey 含 pid，切项目整组重建（1123-1126），保证项目数据边界。页面自身只订阅 router.onChange 做刷新（如 onboarding:154-170、projects:170-191）。
- **返回栈规则**：open=hash 赋值（push）；replace=replaceState+navLog 重置（router.mjs:240-250）；back 依赖 navLog≥2（:256-263）。未知/空 hash 与未知项目 404 均 replace #/projects 并提示（client.js:998-1008、373-375、1205-1208）。
- **导航白名单冻结**：外壳 WORKSPACE_PAGES/GUIDE_PAGES（client.js:109-111）与 router.mjs 导出（36-42）一致，manifest 中旧 id 不加载不入导航（1013、1019-1031）。
- **取数范围**：所有工作区/详情读请求显式携带 project_id（client.js:360/378/387/395、findings:472/484/528/533/550），无 project 时明确报错或空态（findings:190-194、client.js:800-804），不跨项目猜测。
- **分页**：projects 用 next_cursor+has_more 且仅 has_more 时渲染「加载更多」（projects:476-484）；findings 列表同（findings:392-400），验证区兼容 next_after→after（58-63、483-485）；过期响应用 loadSeq 丢弃（projects:295、findings:195、201）。
- **事务边界不在 UI**：UI 只发 HTTP，事务/幂等由后端保证：createProject/scope 修订/删除均单 runSerial（record-service.mjs:1180/1329/1217+）；capture 幂等键 (project_id,tool_call_id)（evidence.mjs:596-608）。
- **错误处理**：api() 统一把非 2xx 转 Error{status,code}，但**只保留 message/code**，丢弃信封其余字段（client.js:68-83）；页面各自用 errorMessage() 拼 code · message（如 onboarding:95-99、projects:65-69、findings:51-55），未呈现 retryable/next_requirements（与 BLUEPRINT-UI §2.2 的「错误信封原样呈现」及 ui-M1.md:28-29 自述不符）。
- **XSS**：全站仅 React createElement 文本/属性渲染，无 dangerouslySetInnerHTML / innerHTML（grep 0 命中）；编号/文本均按文本节点插入，无 HTML 拼接，转义由 React 保证。
- **a11y**：按钮普遍有 aria-label；nav aria-current；dialog role/aria-modal；但焦点管理、键盘可达性不完整（见 §7 P2）。
- **主题**：token 唯一来源 theme.mjs（字面颜色闸有测试），首帧 applyToDocument（291-294）；但句柄只写全局 document（theme.mjs:253-257），未用注入 doc。


## 6. 与文档/设计基线的对应与偏差

**一致（抽查）**：①token/双主题与对比度契约按 BLUEPRINT-UI §2.1 落地（theme.mjs:33-93），字面颜色闸只豁免 theme.mjs；②编号整体匹配与事件编号排除符合 §2.3（record-ids.mjs:30-37、123-139），"A-PRJ-0002-0002 不截断为 PRJ-0002"；③路由表与返回栈规则符合 §2.4/§2.4-2（router.mjs:86-144、201-263，client.js:1148-1152、1266-1284）；④页面模块契约 {id,title,order,render,renderDetail?} 与 ctx={React,h,api,router,ui,theme} 一致（client.js:1060-1070 与各页 render 签名）；⑤manifest 8 页面与注册表 order 一致（ui.routes.mjs:23-43 + 各页 id/order）；⑥词表语义纪律原文落在 VOCAB（render.mjs:233-317）且被页面复用（findings:265-275、559、623-624、662、798）。⑦/api 契约与后端一致：lifecycle action pause/resume/stop（record-service.mjs:87-92）、scope-revisions {project_id,rules,summary}（projects.routes.mjs:228-243）、messages {content}（messages.routes.mjs:85-103）、explore-start 409 LLM_NOT_CONFIGURED（explore.mjs:43-56）。

**偏差（代码 vs 文档）**：
1. **设计系统模块无真实宿主静态路由**（P0）：client 经动态 import `/sorne/ui/lib/<name>.mjs` 或相对 `lib/ui/<name>.mjs`（client.js:266-279）加载 theme/render/router/record-ids，但插件自有的 UI 路由只服务 manifest 与 pages（lib/routes/ui.routes.mjs:45-69）；scope 编辑器的两个候选 URL 同样不可达（onboarding.page.mjs:36-53）。ui-M1.md:172-178 已自述该偏差"留待联调与架构师定夺"；ui.routes.mjs 被冻结禁改（BLUEPRINT-UI:631）。真实 dsh 宿主下前端将落入「设计系统模块不可加载」降级卡（client.js:1107-1115），产品不可用。
2. **第 6 列"操作/删除" vs §1.3「只展示五列」**（BLUEPRINT-UI:107-111）：projects.page.mjs:499-506 渲染 6 列，测试 test/ui-projects.test.mjs:287 已把它固化为契约；另 §1.3 说编号 chip 在"最近活动"列（:109），实现放在"最近进展"列（projects.page.mjs:111-136、560-563）。
3. **首启不自动进向导**：BLUEPRINT-UI §1.1（:70）"无任何项目且未配置模型 → #/onboarding"，实现 DEFAULT_HASH 恒为 #/projects（client.js:134），空库只由项目列表空态引导（projects.page.mjs:441-468）。
4. **§2.7 范围编辑器未被项目设置复用**：蓝图冻结签名要求 M4 项目设置抽屉与向导共用（BLUEPRINT-UI:540；ui-M4.md:200 亦自称"项目设置（M3 范围编辑器）"），但 client.js SettingsDrawer 只有只读范围（664-784，758 明确写"当前为只读呈现"），`openScopeRulesEditor` 全仓无调用方（editor.mjs:402-424）；已建项目在 UI 内没有任何范围修订入口。
5. **暂停收尾语义**：BLUEPRINT-UI §1.4（:125-126）要求"正在暂停 + 仍有 N 个收尾中操作，直到收尾完成转已暂停"；实现只在 POST 在途期间显示 pausing（client.js:411-436、477-481），回执后重拉详情即按 project.status 显示"已暂停"，不再跟踪 attempts（ui-M1.md:38 自述"直至回执"，与蓝图不一致）。
6. **错误信封**：ui-M1.md:28-29 称"信封 {code,message,retryable,next_requirements} 原样呈现"，实际 api() 只保留 message/code（client.js:68-83），next_requirements/retryable 处处丢失；onboarding.page.mjs:719 的 `e.body.next_requirements` 分支恒不执行（后端把字段放在顶层，errors.mjs:63-70）。
7. **客户端前缀镜像滞后**：BLUEPRINT-UI §2.3 要求 PREFIX_TABLES 与后端同步；客户端 30 项（record-ids.mjs:46-78）缺后端已登记的 BMK/BS/CR/EB/EI/JC/MRL/SH（records-read.mjs:21-60，且这些编号已在 extraction.mjs:154、coverage.mjs:77、reading.mjs:879、summaries.mjs:144、scheduling.mjs:95 实际产生）。
8. **LLM 配置存储偏离蓝图**（后端已登记，供交叉）：蓝图 §2.6-1/§2.8 为 llm_settings 表 + 迁移 0005；实现为 <dataDir>/llm.json，迁移 0005 被 messages 占用（llm-settings.mjs:1-16、ui-M2.md 偏差节）。UI 无感知。
9. **ui-M6-findings.md:38 声称"详情从 ctx.router.params.id 取编号"**：实现只在构造时取一次进 state（findings.page.mjs:436-450），props 变化不重取（见 §7 P1-3）。


## 7. 问题清单

### P0 阻断
1. **[风险/不一致] 真实 dsh 宿主下前端不可用（设计系统与范围编辑器模块无同源加载路径）** — client.js:266-279、940-980、1107-1115；lib/routes/ui.routes.mjs:45-69；onboarding.page.mjs:36-53。现象：client 动态 import `/sorne/ui/lib/{theme,record-ids,render,router}.mjs` 或相对 `lib/ui/*`，插件自身只注册 manifest 与 `/sorne/ui/pages/:file` 两条 UI 路由，两者在真实宿主均不可达 → 外壳固定在"设计系统模块不可加载"降级卡，全部页面/顶栏/详情不可用。依据：ui-M1.md:172-178 已承认该偏差"留待联调"，但 BLUEPRINT-UI:631 又冻结 ui.routes.mjs 不可改，形成闭环缺口；测试宿主通过注入 loadLibModule（test-ui-server.mjs:109、test/ui-shell.test.mjs:462）绕开了默认加载器，故无测试暴露。建议：联调前由架构师在"宿主静态服务 /sorne/ui/lib"或"随 client 打包内联 lib/ui + scope/editor"间定案（需变更冻结文件），并补一条走 defaultLoadLibModule 的集成测试。

### P1 重要
2. **[bug] 引导层编号 chip 打开记录覆盖层时丢失 project 参数** — projects.page.mjs:123-130、onboarding.page.mjs:684-688；router.mjs:265-268；client.js:1292-1294、799-804。现象：chip 的 navigate 只传 id，`router.openRecord` 取 `handle.projectId`；在 `#/projects`/`#/onboarding` 下 projectId 为 null，hash 变成 `#/records/A-…` 无 ?project → 覆盖层报"缺少 project 参数"，无法查看项目列表中的记录。依据：BLUEPRINT-UI:109 要求列表编号 chip 直达详情；test/ui-projects.test.mjs:317-322 只断言 openRecord 收到完整 id，fake router 不校验项目参数。建议：navigate 内用行/项目的 id 显式拼 `#/records/<id>?project=<pid>`（或扩展 openRecord(id, {projectId})）。
3. **[bug] 发现详情切换记录时展示旧数据** — findings.page.mjs:436-450、463-477；client.js:1081-1090、1148-1152、1266-1284。现象：FindingDetail 在 constructor 把 props.subjectId 存入 state.id，无 componentDidUpdate；外壳按 id 缓存 detail 元素但左右栏位置不变，React 对"同类型同位置"复用实例并只更新 props → 详情面板打开时再点另一行，面板标题/hash 已换而正文仍是旧发现（记录/证据/验证任务都不重拉）。依据：ui-M6-findings.md:38 自述"从 ctx.router.params.id 取编号"，实际只构造时取一次；test/ui-findings.test.mjs 无切 id 用例。建议：以 `componentDidUpdate(prev)` 比较 props.subjectId 重新 load，或让外壳给 detail 元素加 `key=detailId`。
4. **[不一致] 错误信封字段在 api() 层被丢弃，页面承诺的 next_requirements/retryable 永不呈现** — client.js:68-83；errors.mjs:63-70；onboarding.page.mjs:717-729；reports.page.mjs:120-133。现象：非 2xx 只映射 message/status/code，不挂 payload；onboarding 的 LLM_NOT_CONFIGURED 分支 `e.body.next_requirements` 恒空（死代码），用户看不到"下一步：配置模型"；reports 的 errorInfo 里的 detail/body 取法同样失效。依据：BLUEPRINT-UI:28-29 与 ui-M1.md:28-29 声称信封原样呈现；后端信封把字段放在 JSON 顶层（errors.mjs:63-70）。建议：api() 保留 `err.body = data` 并透传 retryable/next_requirements，补测试断言页面文本出现 next_requirements。
5. **[不一致/功能缺口] §2.7 范围编辑器无调用方，已建项目在 UI 内无法修订范围** — scope/editor.mjs:402-424（openScopeRulesEditor）；client.js:664-784（项目设置抽屉只读，:758）；BLUEPRINT-UI:540；ui-M4.md:200。现象：向导第②步之外没有任何范围编辑入口；SettingsDrawer 只列当前规则并文案称"由 M3 提供…当前为只读呈现"，而 M3 的冻结签名导出全仓 0 调用。依据：蓝图要求 M4 项目设置抽屉与向导共用同一编辑器、M4 不得自实现第二份；验收场景 J6/§1.6 涉及范围调整。建议：由 M4 在项目设置抽屉内 `openScopeRulesEditor({...ctx, project, scope, onSaved, mount})`，或明确改契约并记录。
6. **[风险] 顶栏运行状态由"第一页 attempts"推导，>50 条尝试后会误报"等待条件补齐/收尾中 N 个"** — client.js:378-386（GET /attempts 不带 limit/status，filter leased/running 后取 length）；lib/store/attempts.mjs:741-744（默认 limit=50）、762-766（按 created_seq 升序取前 50）；resolveRunStatus:194-231（attemptsActive===0 → 等待）。现象：项目历史 attempt 超过一页时，活跃租约若不在最旧 50 条内则被判为"当前没有执行中的尝试"，暂停收尾计数同样少报。依据：BLUEPRINT-UI §1.4 要求状态来自真实数据、§7 不假装停止。建议：改读带 status 过滤/精确计数的端点（如 diagnostics.project.attempts.active_leases 已在 M2 提供）或翻页聚合 has_more。
7. **[风险] 暂停操作未做收尾跟踪，回执后即显示"已暂停"** — client.js:411-436、138-231（pausing 仅 lifecycle.phase=pausing 时）、406-410。现象：POST lifecycle 返回后立即重拉，project.status=paused 覆盖 pausing，活跃 attempts 尚在收尾也显示"已暂停"且不显示 N。依据：BLUEPRINT-UI:125-126 明确"直到收尾完成转已暂停"；ui-M1.md:38 只承诺"直至回执"。建议：pause 后保持 pausing 并轮询 attempts/diagnostics 直至活跃为 0（或改用服务端"收尾中"状态字段）。

### P2 次要
8. **[bug] 深链 `#/records/:id` 直接打开时底衬是"records 页面模块未就绪"占位页 + 引导导航** — client.js:992-997、1117-1146、905-913、1287-1294。现象：underlay 为空时 layoutPage=records，isWorkspace=false，nav 退回 GUIDE_PAGES，并把 records 当页面槽渲染占位卡（PAGE_LABELS/SLOT_OWNERS 均无 records）；关闭时 fallback `:1293` 生成 `#/p//workbench` → 解析为 unknown → 再 replace #/projects。测试 test/ui-shell.test.mjs:694-713 均从工作区页进入，未覆盖初始即 records 的深链。
9. **[bug] 主题切换三态按钮 aria-pressed/高亮不更新** — client.js:646-662（current=theme.mode() 为渲染快照）、970（只订阅 router，不订阅 theme.onChange）、theme.mjs:270-282（set 仅写 document 属性并通知 theme listeners）。点击后 html 主题变化但按钮状态陈旧，直到 Topbar 因其他 setState 重渲染。测试未覆盖 ThemeSwitch 交互。
10. **[bug] formatTime 超 30 天重复日期、未来时间显示"刚刚"** — render.mjs:363-369（rel=datePart 后又拼 abs，输出"2026-10-01 · 2026-10-01 14:32:05（本地）"）、355-357（diffMs<60000 含负值）。test/ui-design.test.mjs:379-401 只覆盖 3 天内。
11. **[死交互] FieldRow 渲染的编号 chip 点击无动作；RecordIdChip 的 projectId 形参从未使用** — render.mjs:697-698（`RecordIdChip(value,{})` 无 navigate）、464-468（navigate 非函数即空操作）、440。现象：记录覆盖层头字段/项目设置"编号"等 FieldRow 路径出现可聚焦按钮但点击无反应，违反"可点击即有行为"的一致性。建议：FieldRow 透传 navigate，或对无 navigate 场景渲染非按钮 chip。
12. **[不一致] 原始证据字节按 JSON 文本读取** — findings.page.mjs:545-555 走 client.js:59-85 的 api()（res.text()+JSON.parse）；lib/routes/evidence.routes.mjs:52-73 返回 application/octet-stream。二进制证据被当 UTF-8 显示、2000 字符截断、真实字节丢失；仅载荷为文本时"碰巧可用"。建议：单独 fetch/arrayBuffer 并按 content-type/字节长度呈现哈希与下载入口。
13. **[风险/幂等] 向导导入 capture 幂等键随时间戳变化；项目创建/范围保存无幂等键或版本前置条件** — onboarding.page.mjs:612（tool_call_id 由 wizard-import-时间戳-序号 组成，每次重试重新生成）、451-500（POST /projects 无幂等键）、scope/editor.mjs:180-187（POST /scope-revisions 无 expected revision）。超时重发/双击（受 creating 标志部分缓解）可产生重复 capture/project 或覆盖并发范围修订。
14. **[死代码/测试缺口] `openScopeRulesEditor` 与"抽屉模式"未使用且无 aria-modal/焦点管理** — editor.mjs:214-236（drawerMode 仅 role=dialog，无遮罩/aria-modal/焦点圈定）、402-424；测试仅经 onboarding 覆盖内嵌模式（ui-onboarding:407-478）。
15. **[a11y] Esc/键盘可达性不完整** — client.js:1047-1059 的 onKeyDown 绑在根 div（1154-1156），焦点不在插件根内（如 body）时 Esc 无效；ProjectSwitcher（601-644）role=menu 无方向键/Esc/外点关闭；SettingsDrawer（700-716）虽有 role=dialog/aria-modal 但无焦点圈定，且 Esc 被 `params.id` 详情分支抢先（1050-1057）；DataTable 行点击无键盘等价（render.mjs:798-809，发现页另有证据按钮可兜底）。
16. **[风险] 详情元素缓存无上限** — client.js:934、1081-1090 按 detailId 持续累积，pruneCaches 仅在其他 group 渲染时清理（1091-1101）；同一项目长期浏览大量记录详情，元素缓存随访问记录数线性增长。
17. **[不一致] 客户端前缀表滞后后端（见 §6-7）** — record-ids.mjs:46-78 vs records-read.mjs:21-60；后果仅是 chip 悬停缺中文类型/显示"前缀未登记"，服务端仍可定位（records-read.mjs:132-135 兜底），不影响跳转。
18. **[不一致] 向导"范围未配置"文案与实际落库语义不符** — onboarding.page.mjs:437-447 声称未配置时全部待判断；但创建项目总会提交 `scope_rules:{allow:[],deny:[],pending:[]}`（451-481，编辑器初始值），createProject 据此写入"已配置但空规则"的版本（record-service.mjs:1184-1206），判定变为 configured/unlisted 而非 unconfigured（scope.mjs:183-186、209）。安全效果相同（均为 pending），仅口径/诊断信息不同。
19. **[边缘] 路径形态歧义：`#/p/:pid/records` 被 parseHash 当作合法 records 页** — router.mjs:44-49（KNOWN_PAGES 含 records）、125-135；client.js:1290（recordId 为 null）→ 读取 `/sorne/records/null?project_id=…` 报 404 文案。建议 records 页仅接受 `/records/:id` 形态。
20. **[标签bug] "收起采集明细"实际重新拉取而非收起** — findings.page.mjs:688-693（detail.phase==="ready" 时文案"收起"，onClick 仍 expandMember 重新请求）。建议改为切换 display 或本地折叠。
21. **[测试缺口] 列表/验证区"加载更多"失败会清空列表或无可重试** — findings.page.mjs:220-223（load more 出错把 rows 置空）、597-609（验证区错误仅文字无重试按钮）。projects.page.mjs:329-332 保留 rows 但 phase=error 时整块被错误卡替换（425-438）。


## 8. 测试覆盖映射

覆盖本模块的测试（均在 test/，只读核对用例名与断言，未运行）：
- **test/ui-shell.test.mjs（22 用例）**：双布局导航白名单/占位卡（509-554）、未知 hash/项目 404 重定向（555-575）、导航切换与 aria-current（575-595）、keep-alive 隐藏/状态保留（595-620）、详情槽位与两种返回栈（624-656）、记录覆盖层读/关/Esc/缺 project（660-713）、LLM 门控三态（717-754）、顶栏五态与暂停交互（758-867）、aria/dialog/主题对比度（871-942）、页面/manifest 加载失败降级（944-970）、真实服务 /records 端到端（971-1010）。覆盖面：外壳布局、路由、门控、返回栈、加载失败。
- **test/ui-design.test.mjs（24 用例）**：token 对比度双主题、CSS 注入、字面颜色闸（231-278）、编号解析两族/反例/唯一实现（279-378）、render 各组件（379-618）、LABELS 覆盖闸（738-772）、theme 三态与持久化（773-798）、router.parseHash/返回栈/navLog（862-958）。覆盖面：设计系统单组件与契约。
- **test/ui-onboarding.test.mjs（22 用例）**：页面契约（273-289）、未连接横幅与未知态（290-343）、保存设置/per_role/测试连接（344-406）、范围编辑器三区/通配符/JSON 错误/BAD_REQUEST（407-498）、已建项目改范围出新版本（499-535）、第③步导入成功/失败（561-635）、第④步成功/409/404/保存（636-749）、步骤回退（750-782）、无 router/ui 降级（783-833）、真实服务 J1（834+）。覆盖面：向导全链路与真实编辑器模块。
- **test/ui-projects.test.mjs（17 用例）**：六列表头（280-288）、状态徽章/完整编号 chip/openRecord（290-326）、行点击进入工作区（328-344）、待处理计数与 summary 缺失（346-377）、加载/错误重试（378-401）、真分页与"无 has_more 不渲染加载更多"（402-440）、空态引导/未连接横幅/数据时刻/无 ui·router 降级（441-512）、真实服务列表与创建（513-617）、创建/删除二次确认（618+）。
- **test/ui-findings.test.mjs（17 用例）**：契约与注册表（344-366）、四态/三态徽章与行点击（367-395）、条件/证据入口/确认版本折叠（396-421）、服务端筛选（422-439）、列表分页（440-459）、边界口径（460-473）、空/无项目/错误/形状（474-500）、详情字段/证据→采集→字节/验证经过/未应用警示/reviewed_evidence_revision（501-579）、P0-4 禁词（565-579）、验证区 cursor 与 after 兼容双分支（580-609）、后续探索（610-619）、请求复核只发消息（620-642）、详情错误重试（643-665）、真实服务（666+）。
- 其它：test/smoke.test.mjs:198-232（manifest 与目录一致、page 源可服务）、:351-392（client __ModuleLoader__ 注册、全部页面形状可渲染）；test-ui-server.mjs 提供浏览器宿主与 /sorne/ui/lib（109-160）。

**无测试覆盖的行为（缺口）**：defaultLoadLibModule 真实候选 URL 路径（测试全部注入 loadLibModule）；SettingsDrawer（项目设置抽屉）与 ProjectSwitcher 功能、ThemeSwitch 交互与 aria-pressed；深链 `#/records/:id` 的底衬/关闭落点；详情 `?id=` 切换时组件重取；引导层 chip 的项目参数；Topbar 在 >50 attempts 下的状态判定；暂停收尾轮询；formatTime >30 天/未来时间；FieldRow 无 navigate chip；原始字节二进制读取；向导导入重试幂等；scope/editor 的 openScopeRulesEditor 抽屉模式；lifecycle 的 expected_state_version；首启空库是否落 #/onboarding；`#/p/:pid/records` 歧义形态。

## 9. 不确定点与需 Lead 交叉确认

1. **真实 dsh 宿主能否以任何方式解析 client 的相对动态 import / 提供 /sorne/ui/lib 静态服务**：ui-M1.md 明确"无法在本仓验证"，但这是前端能否在真实产品中活下来的 P0 前提；请 Lead 结合 dsh 宿主源码/联调记录裁决（若无，需要走冻结文件变更）。
2. **详情 id 切换的旧数据（P1-3）**：结论依赖"React 同类型同位置复用实例"的标准语义；建议 Lead 用真实 React（test-ui-server + 浏览器）复现一次"详情打开时点另一行"确认，而非只依赖本报告推断。
3. **顶栏活跃尝试计数（P1-6）**：是否允许改读 diagnostics 聚合/新增 count 端点，或必须保持现有端点集合（蓝图端点表冻结），需架构口径。
4. **项目列表第 6 列删除入口**：蓝图 §1.3"只展示五列"与 M3 施工卡"删除接口"冲突，测试已固化六列；请确认以测试/施工卡为准并在蓝图登记偏差。
5. **首启落点**：§1.1 向导 vs 恒定 #/projects，属于产品体验取舍；需确认是否要 M3 之外（外壳）实现"无项目且未配置模型 → #/onboarding"的重定向（涉及冻结外壳）。
6. **范围编辑器归属**：§2.7 冻结签名已实现但无调用方；请确认是 M4 欠接线（则 §7-5 为 P1 实现遗漏）还是契约已被有意搁置（则应在 BLUEPRINT-UI/ui-M4 明文记录）。
7. **P2-17 前缀镜像**：阶段 2-6 新增 BMK/BS/CR/EB/EI/JC/MRL/SH 是否要求前端登记（BLUEPRINT-UI §2.3 只列到 M2 批次的 14 个前缀）；若定位以服务端为准，可降级为 P2 文案问题。
8. **本报告未覆盖**：reports/workbench/assets/exploration/diagnostics 五个页面文件与 lib/routes 全量实现（属其他块）；其中 reports.page 同样依赖 err.body 与详情节点的模式，建议 Lead 指派对应读块交叉验证 §7-3/§7-4 是否为跨页共性问题。

