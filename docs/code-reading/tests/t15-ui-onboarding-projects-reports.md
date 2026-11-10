# t15 ui-onboarding / ui-projects / ui-reports 测试精读

> 范围：test/ui-onboarding.test.mjs（916 行 / 20 test）、test/ui-projects.test.mjs（644 行 / 16 test）、test/ui-reports.test.mjs（1320 行 / 28 test），合计 64 test。全部读过；核对断言原文与实现映射。未运行测试、未改源码。

## ① 文件与用例数

| 文件 | 行数 | 用例 | 覆盖主体 |
|---|---|---|---|
| test/ui-onboarding.test.mjs | 916 | 20 | 四步向导 J1：模型设置/测试、创建项目+范围、导入资料、explore-start、409/404、回退、真实服务 J1 |
| test/ui-projects.test.mjs | 644 | 16 | 项目列表：契约、列、行/编号 chip、分页、空态/未连接横幅、数据时刻、降级、真实服务 |
| test/ui-reports.test.mjs | 1320 | 28 | 报告页：漏洞报告列表/分页、501/5xx/未知形状、阶段报告五分区+按需生成、覆盖缺口、语义折叠、详情（RR-/MR-/V-）、历史版本、导出、真实服务全链路 |

## ② 锁定的行为

**onboarding**：页面契约（无静态 import/require/localStorage/钩子/编号正则/字面颜色/宿主变量，:273-288）；J1 未连接横幅+直达（:290-301）；横幅四步全程可见（:303-328）；设置 404→状态未知（:330-342）；PUT 提交体 {base_url,model,api_key,per_role} 且 key 不回显/仅掩码（:344-383）；per_role 仅提交覆盖角色、测试失败原文（:385-405）；范围编辑器三区与通配符提示、JSON 错误本地拦截、提交 scope_rules（:407-478）；服务端 BAD_REQUEST 原文（:480-497）；已建项目回退改范围走 scope-revisions 不重复创建、名称/目标锁定（:499-535）；第③步可跳过零上传（:536-559）；导入 = raw bytes + capture（query project_id/representation/source_kind、body source_kind/response_body_blob/method/tool_call_id，:561-603）；导入失败 EVIDENCE_NOT_COMMITTED 不假装成功（:605-634）；explore-start 200 进入工作区（:636-661）；409 文案 + next_requirements + 去连接入口（:663-694）；404 呈现「接口不可用」（:696-721）；保存项目不重复提交（:723-748）；逐步回退并保留已创建项目（:750-781）；无 router/ui 降级（:783-797）；真实服务 J1 全链路含 scope 校验与真实上传（:834-916）。

**projects**：契约（:259-274）；表头六列 = 项目/当前状态/最近进展/待处理事项/最近活动/操作（:280-288）；中文徽章+完整编号 chip+openRecord 不截断（:290-326）；行点击进工作区（:328-344）；待处理仅非零/全零显 —（:346-365）；summary 缺失→未提供≠不存在（:367-376）；错误卡+重试（:378-396）；真分页 cursor 携带/累积/结束消失（:402-426）；无 has_more 不渲染加载更多（:428-435）；空库三步引导+未连接横幅+直达（:441-478）；数据时刻/按已加载数据推导/无裸 UTC（:480-489）；无 ui/router 降级（:495-507）；真实服务 manifest order 10/summary 形体/空态（:513-559）与创建后五列+行点击（:561-617）；创建/删除界面字段与删除二次确认（:618-644，未真发 DELETE）。

**reports**：契约含「页面不得改写/清洗展示值」正则禁 toLowerCase/decodeURIComponent/.replace（:630-654，争议点）；初始两区加载态（:656-663）；漏洞列表列/状态复核分列/版本计数/截止边界/编号 chip/无§（:669-697）；分页（:699-719）；501「未实现不是报错」（:721-735）；5xx 错误码原文、其余区不受影响（:737-751）；未知形状（:753-761）；空态 0 计数不等于未提供（:763-781）；阶段报告五分区/边界/版本切换/读取不携带 refresh（:787-810）；历史版本按钮导航 MR-（:812-821）；refresh=1 生成、版本推进、不结束项目（:823-841）；覆盖缺口表与折叠口径（:847-869）；语义说明折叠且正文 §=0（:875-892）；详情：RR- 经 /records 解析 subject+version 再读 #39、§19 内容集、reviewed_evidence_revision 实际值（:902-946）；历史版本提示+边界切换+版本按钮导航（:948-969）；MR- 详情读 #40（:971-997）；V- 兼容直开（:999-1007）；详情 404/无法识别编号（:1009-1023）；行/chip 导航且页面不自行请求 /records（:1029-1048）；详情内全部编号 chip（:1050-1068）；导出成功 = 下载链接 href/download 名/同源说明（:1081-1097）与失败 404 含服务端 note、不出链接（:1099-1119）；单版主体（:1125-1148）；五分区缺失→—（未提供）（:1150-1167）；覆盖取当前版本（:1169-1180）；无覆盖块显式未提供（:1182-1191）；真实服务 manifest/漏洞/阶段报告/生成/详情/真实导出（:1254-1309）与未知编号 404（:1311-1320）。

## ③ 替身 / 隔离 / 渲染手法

- 三文件共用同一模式：最小 createElement + Component 基类 → mountPage 按「树路径」缓存实例（onboarding:77-191、projects:81-173、reports:93-215），绑定 M1 真实渲染器（bindRenderers + 真实 render/record-ids），断言打到真实渲染输出。
- 挂载仿真的保真边界：class setState 只改 state 不触发重渲染，需 flush() 的 setImmediate 轮询后再 rerender（onboarding:92-127）；实例按路径复用（模拟 React 同位协调）。**这与 React 自动重渲染语义不同**，同步 setState 的可见性由测试 flush 兜底。
- fakeApi：onboarding/projects 按「METHOD 基路径」匹配（忽略 query，query 由 handler 第二参 path 自检），reports 按「METHOD 完整路径含 query」精确匹配（reports:245）→ 后者的 API query 契约被写死。
- fake 错误信封：三文件 apiError 均额外挂 e.body（onboarding:205-211、projects:187-193、reports:231-238 还挂 e.detail），**比生产 client.js api()（client.js:68-83，只留 message/code）宽**；这是本组最关键的系统性假绿来源。
- 真实服务适配器各自重写：onboarding makeRealApi（:803-832）、projects 内联两份（:529-553、:579-600）、reports realApi（:1197-1225）；reports 版最接近生产（credentials same-origin + headers 合并），但仍额外挂 body。四份实现互不一致，改动 api 契约需改四处。
- 隔离：fake 用例不占端口；真实用例走 helpers.withTestServer（mkdtemp + listen(0) + 恢复 SORNE_DATA_DIR + rm）；reports/onboarding 用 waitUntil/setImmediate 轮询等待真实往返（reports:145-152 最多 400 轮；onboarding:852-855、903-905 手写 100 轮），无 fake timers，时序敏感。
- 页面模块经绝对 file URL 动态 import（onboarding:34-37 等），范围编辑器经相对 file URL import（页面自身 new URL("../scope/editor.mjs", import.meta.url)）在 Node 下成立；**浏览器宿主下的可达性不在测试网内**。

## ④ 断言质量

- **过拟合/文案脆性**：大量逐字冻结句（onboarding:296/404/496；projects:392/488；reports:796-804/852-865/1114-1116）。对语义纪律是收益，但 reports 把「禁止改写展示值」写成源码正则禁 toLowerCase/decodeURIComponent/.replace（reports:639）——把实现风格当契约，后续合法格式化即红；reports 的 fakeApi 以含 query 的完整路径为 key（:245/:616-617），任何合法 query 增删（如 limit/排序）都会红。
- **同义反复**：onboarding:297-300 在第①步点「去连接模型」后断言 currentStep 仍为 1——点击前后相同，无法证明动作生效；reports:1273-1275 的 waitUntil().catch(e => { throw e }) 为空转发，属噪声。
- **放宽/自适应**：onboarding:898-915 真实 explore-start 接受「探索已开始」或「接口不可用（404）」两种结果（M2 竣工前的过渡断言，端点已实装后仍保留，实际只走成功分支，404 分支已死）；projects 真实用例只读列表，DELETE ?confirm=delete 只有 fake 二次确认（:618-644），真实删除契约未验证；reports 真实用例对阶段报告只断言「已确认成果|未确认线索」存在。
- **假绿风险**：
  1. **错误信封断言不可迁移到生产**：onboarding:690 断言 next_requirements 呈现依赖 fake body；projects:392 断言 INTERNAL_ERROR 原文、reports:1102-1116 断言 detail.note——均依赖 fake 补齐的字段；真实 client.js api() 不挂 body，这三处行为在真实浏览器必不成立。
  2. **引导层 chip 项目参数**：makeCtx 的 openRecord 只记 id（onboarding:249、projects:231），不建模 projectId；onboarding 导入 chip（:596）与项目列表 chip（:290-326）的真实覆盖层跳转（丢 project 参数 → 报缺少 project 参数）不可见。
  3. **报告 fixture 即真值**：reports 手写约 300 行 #39/#40/#14 信封（:295-611），真实端点字段若漂移不会红；真实服务只做浅断言兜底。
  4. **六列契约与蓝图冲突被固化**：projects:280-288 断言恰为六列（含「操作」），但同文件头注释 :8 称「五列恰为…」、BLUEPRINT-UI §1.3:107-111 要求「只展示五列」→ 测试把已知偏差锁成契约（需架构确认）。
  5. **白盒调用**：onboarding:592/627/893 直接 t.inst().onFilesSelected(...) 调用内部方法，绕过文件 input onChange；方法改名即红，且 input 事件路径无覆盖。
- **范围编辑器与生命周期**：编辑器经真实实现动态 import 覆盖内嵌模式（三区/通配/JSON 错误/保存/版本），但 openScopeRulesEditor 抽屉签名、onSaved/onDone 回执、与项目设置抽屉接线无用例；三文件均未测 /projects/:id/lifecycle（生命周期只在 ui-shell 覆盖，且该处锁定「回执即已暂停」而非收尾轮询）。

## ⑤ 覆盖缺口

1. 生产 api() 的错误信封字段（retryable/next_requirements/detail/module）与页面呈现——所有信封断言依赖 fake 挂 body。
2. 引导层编号 chip 的 project 参数与记录覆盖层真实跳转。
3. 项目删除真实端点（DELETE ?confirm=delete 缺确认时的 PRECONDITION_INVALID 分支）、创建失败/重名等错误路径的真实契约。
4. 报告详情：历史版本 404/越界版本、content_available=false（内容文件缺失）的导出降级、导出非 404 失败（403/500）、历史版本导出、history 分页（history_total 很大）。
5. 阶段报告生成失败的呈现、refresh 后版本号非单调/refreshed=false 分支；#39/#40 真实响应与 fixture 的字段漂移无自动校验。
6. 向导第③步多文件、部分失败、重试（幂等键 Date.now 生成）与真实宿主下范围编辑器动态 import 可达性。
7. 真实浏览器交互（文件选择器、键盘 Tab、焦点）与 React 真实重渲染时序（本组挂载仿真不自动重渲染）。
8. 本组未覆盖项目/报告页在 keep-alive 下的刷新语义（onNav/路由订阅），属 shell 测试面。

## ⑥ 实现映射

| 锁定面 | 实现 |
|---|---|
| 向导四步/J1/范围编辑器/导入/explore-start | lib/ui/pages/onboarding.page.mjs:110-1016；lib/ui/scope/editor.mjs:41-424 |
| 项目列表六列/创建/删除二次确认/分页/空态 | lib/ui/pages/projects.page.mjs:138-605 |
| 报告列表/五分区/生成/详情/历史/导出 | lib/ui/pages/reports.page.mjs（render/renderDetail） |
| 错误信封形状 | client.js:59-85（生产）vs 三测试文件的 fake apiError（更宽） |
| 编号 chip/路由 | lib/ui/render.mjs:440-490；router.mjs:265-268 |
| 真实服务与隔离 | test/helpers.mjs:19-91（mkdtemp/listen(0)/env 恢复/rm） |

**结论**：三文件对 J1/J2/J3 主路径与语义纪律的锁定较扎实（真实现渲染器、真实服务兜底、隔离干净），但共同存在「替身信封比生产宽」「mock router 不建模项目上下文」「报告 fixture 自证」三类假绿；项目列表把六列（vs 蓝图五列）锁成契约，报告页把实现风格（禁 replace/toLowerCase）锁成契约，属需架构复核的过拟合。
