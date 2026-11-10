# t13 · ui-workbench / ui-diagnostics 测试精读

## ① 文件与用例数
- test/ui-workbench.test.mjs：1361 行，29 个 test()，238 处 assert；其中 2 个真实服务用例（:1271、:1313），其余 fakeApi。
- test/ui-diagnostics.test.mjs：973 行，27 个 test()，192 处 assert；1 个真实服务用例（:935）。
- 无 skip/todo/only（grep 0）；无 setTimeout；setInterval 仅在自动刷新用例被桩替换（diagnostics:706-716，finally 恢复 :756-759）。

## ② 锁定的行为清单（按模块/场景）
- 工作台：页面契约（:604-620：源码正则禁 import/require/localStorage/钩子/RECORD_ID_RE/字面色/--dsw，id/title/order=20/renderDetail）；manifest 与旧页删除（:622-638）；7 项指标与精确拼接计数、不读 /metrics（:644-666）；进展条六段/失败原因/读取中无假进度（:699-721、:723-736、:738-757）；三区 J2 与未处理汇报进右栏（:763-819）；对话 J4/J5 三段/附件校验/发送后重读/未处理态（:825-915）；消息游标分页（:921-943）；>8 条显式截断提示（:945-961）；J6 暂停与 waiting_for_change（:962-999）；右栏交接卡/关键记录/完整依据/基线链/非 WR 编号（:1009-1158）；501/500/403/未知形状/空态（:1164-1238）；语义冻结原句（:1244-1265）；真实服务 #46→#47 与 #38 三层（:1271-1361）。
- 诊断页：页面契约与初始加载（:408-433）；健康/模型两态（:437-461）；语义原句（:465-482）；#49 九态/计划/受阻族/验证/汇报消息（:486-498）；Outbox/投影 null≠0/证据完整性（:500-512）；#41 原始 JSON 折叠（:514-526）；租约四态（:530-559）；过期/中断/unknown 置顶（:561-572）；筛选与游标分页（:574-602）；工具调用六态/摘要物化/not_provided（:606-669）；观察摘要与只读边界（:673-700）；自动刷新（:704-760）；变化流摘要/payload/游标/订阅边界/降级（:764-866）；501/403/500/无项目（:870-931）；真实服务（:935-973）。

## ③ 测试替身 / 隔离 / 时钟手法
- 不用 React 运行时：自写 createElement + Component 基类，直接实例化类组件并同步 setState（workbench:113-119；diagnostics:119-122）；flush 固定 24 轮 setImmediate（workbench:142-155；diagnostics:147-152），真实服务用 waitUntil 240 轮 setImmediate 轮询（workbench:142-157；diagnostics:154-161）。
- 真实渲染器经 bindRenderers 注入（workbench:47-56；diagnostics:54-71），断言打到 ui.formatTime/StatusBadge/RecordIdChip/FieldRow 输出。
- fakeApi：workbench 支持 query 子集匹配（:250-278），详情用 queryApi 按完整 path 精确分发（:574-598）；diagnostics 只按完整 path 精确匹配（:224-234），把 project_id/limit/cursor 编码硬编码进 handler 键（:240-247）。
- 路由桩：workbench makeCtx 记录 open/openRecord（:306-328）；diagnostics makeRouter 提供 __notify 但无人调用（:77-97）。
- 时钟：两文件都在模块加载时 NOW=Date.now()，ISO(offset) 构造相对时间（workbench:332-333；diagnostics:238/:360）；租约时长断言只匹配数字（/剩余约 1 分 d{1,2} 秒/，diagnostics:534），未伪造 Date.now。真实服务 withTestServer：mkdtemp 临时 dataDir + 进程级 SORNE_DATA_DIR 注入 + finally 清理（test/helpers.mjs:5/:28-90）。
- 隔离：fake 用例不占端口；真实服务用独立临时目录；诊断自动刷新用例替换 global.setInterval/clearInterval（:711-716）并 try/finally 恢复（:756-759）。

## ④ 断言质量（过拟合 / 同义反复 / 被放宽 / 假绿）
- **P1-1 抓不到的根因**：最小宿主的 setState 是同步赋值（workbench:113-119），真实 React 的事件内批处理被压平；「读取基线直达 key_records」用例（:1120-1148）只断言请求被发出（:1134-1135），而文本断言 /已开始静态查看页面与 JS/ 在基线交接卡夹具里同样存在（baseHandoffFixture :545），并不来自 key_records；因此即使层因竞态卡在 loading/被丢弃，该用例仍会绿——典型假绿。
- **P1-3 无覆盖**：诊断页 fakeApi 严格顺序 resolve，测试只点一次「加载更多」（diagnostics:586-602、:795-813）；自动刷新用例只断言 4 个端点调用计数增加（:727-738），未覆盖与手动操作交叠、重复追加、请求乱序。
- 文本扁平化断言脆弱：nodeText 无分隔符拼接（workbench:167-177；diagnostics:174-182），如 /待你处理3 份汇报 · 0 条消息/（workbench:655）、/活跃尝试1 个/（:661）、/需要s*的决策/（:1079/:1082 用 s* 兜节点切分）——节点结构/空白一变即假红；反之含 .* 或交替分支的断言（:783、:1224）可假绿。
- findButton 取「最后一个包含该文案的按钮」（workbench:179-183）："读取基线" 同时命中"读取基线汇报"（:1027/:1131），依赖渲染顺序；chip 断言只验证 nodeText 含编号，不验证 aria-label/可访问性。
- 可见性未验证：语义原句在原生 details 内（workbench:1244-1265；diagnostics:465-482 对应页面语义 details），测试不断言折叠/展开，只断言虚拟树文本存在。
- 标题过度承诺：workbench「501 六数据面」用例（:1164）实际只断言 overview/attempts/messages 与通用句（:1177-1180），verification/change-log 的未实现态未断言；diagnostics 的 501 用例（:870-887）覆盖较全。
- 条件断言放宽：workbench manifest 用例对 projects/assets 用 if (projects) / if (assets)（:631-634），页面缺失时跳过而不红。
- 全局负断言过严：doesNotMatch(text, /%/)（workbench:720/:753）与 /#[0-9a-f]{6}/i（:735）；合法数据含百分号或 hex 片段会假红。
- 真实服务 #38 用例用 store.db 直插 worker_reports（workbench:1326-1342），绕过写端点；它验证读取渲染与「库内记录不存在」降级（:1354），非端到端写入链。
- 无 React key 重复警告捕获；无 unmount/keep-alive 行为断言（仅 diagnostics 自动刷新用例手工调 componentWillUnmount，:747-755）。

## ⑤ 覆盖缺口
- P1-1 基线 drill 的层渲染结果与 loading 终结未断言；P1-2 隐藏/可见轮询未覆盖；P1-3 并发/双「加载更多」/乱序未覆盖。
- 工作台 router.onChange（项目切换）、loadHandoffPage 失败、omitted read_pointer 路由、unmount 清理均无用例。
- 诊断页 router.onChange/项目切换、health/global/tool-calls 是否随自动刷新重读、空/非法游标、subscribe 与自动刷新交叠均无用例。
- 无 DOM 结构/视觉布局断言（DataTable 结构由渲染器自测），关键可访问性（aria-label/focus）未覆盖。

## ⑥ 与实现文件映射
- workbench 断言 ↔ lib/ui/pages/workbench.page.mjs：契约 :604 ↔ :202-205；指标 :644 ↔ :794-828；进展条 :699 ↔ :585-670；三区 :763 ↔ :871-1129；对话 :825 ↔ :1133-1267；右栏 :1009-1158 ↔ :1324-1881；501/错误 :1164-1238 ↔ :1271-1285。
- diagnostics 断言 ↔ lib/ui/pages/diagnostics.page.mjs：契约 :408 ↔ :64-67；健康 :437 ↔ :533-607；#49 :486 ↔ :609-790；租约 :530 ↔ :418-431/:792-889；工具调用 :606 ↔ :891-958；自动刷新 :704 ↔ :373-390；变化流 :764 ↔ :1002-1099；501/403/500 :870 ↔ :466-478/:827-841。
