# t12 ui-shell / ui-design 测试精读

> 范围：test/ui-shell.test.mjs（1011 行）、test/ui-design.test.mjs（979 行）、test-ui-server.mjs（178 行）。全部读过；核对断言原文与实现映射。未运行测试、未改源码。

## ① 文件与用例数

| 文件 | 行数 | 用例数 | 定位 |
|---|---|---|---|
| test/ui-shell.test.mjs | 1011 | 22 个 test（含 1 个真实服务用例；主题对比度循环产生 2 例） | 外壳集成：双布局/路由/keep-alive/详情槽/覆盖层/顶栏/门控/a11y/降级 |
| test/ui-design.test.mjs | 979 | 24 个 test | 设计系统：token 对比度、字面颜色闸、编号解析、渲染器、词表、LABELS、theme/router 纯函数 |
| test-ui-server.mjs | 178 | 0（人工走查宿主，不进 npm test） | 独立 UI 宿主：真实 dispatcher + client.js + React UMD + 自建 /sorne/ui/lib 静态服务 |

## ② 锁定的行为清单

**ui-shell（按区块）**：引导/工作区导航恰为冻结白名单、旧 id 不入导航（:509-538）；页面未落地占位卡+归属模块（:540-551）；空/未知 hash→#/projects、未知项目 404→重定向+提示（:555-573）；导航 aria-current 与页面切换（:575-591）；keep-alive 隐藏不卸载/状态保留（:595-620）；右侧详情有前驱 back、深链 replace 两分支（:624-656）；覆盖层读取/关闭回来源页、Esc、缺 project 报错（:660-713）；LLM 门控三态（:717-754）；顶栏五态+waiting 理由+health 异常（:758-830）；暂停 in-flight「正在暂停 + 1 个执行中尝试在收尾」→回执已暂停、提交体 action=pause（:832-867）；按钮 aria-label/覆盖层 dialog+aria-modal（:871-896）；双主题元素树对比度（:918-940）；页面/manifest 加载失败不白屏（:944-967）；真实服务 register_asset→/records→前端解析一致（:971-1011）。

**ui-design**：双主题 25 对 token 对比度 + tools/contrast-check.mjs 子进程（:166-227）；字面颜色/宿主 --dsw-alias 闸（:231-275）；A-PRJ-0002-0002 整体解析、两族×前缀表、事件编号与 21 个反例、6 位前缀降级（:279-348）；编号解析唯一实现闸（:352-373）；formatTime/formatHash/RecordIdChip/FoldableObject/StatusBadge/VOCAB/FieldRow/DataTable/EmptyState（:379-625）；LABELS fixtures 覆盖闸（:738-761）；theme 句柄/持久化/onChange/CSS 注入（:773-823）；router.parseHash 全表、createRouter 返回栈与 openRecord、client 白名单文本比对（:862-979）。

**test-ui-server**：mock ctx 调 index.apply 挂真实 /sorne（:41-60）；页面 HTML 无字面颜色、?theme= 注入 __SORNE_THEME__（:74-113）；/sorne/ui/lib/* 与 /lib/ui/* 路径白名单+穿越防护（:122-158）；SORNE_DATA_DIR 默认 mkdtemp（:35-38）。

## ③ 替身 / 隔离 / 渲染手法

- **ui-shell 自建迷你渲染器**（:53-266）：createElement→元素树，类组件实例化并模拟 setState/forceUpdate/componentDidMount/DidUpdate/WillUnmount；reconcile **无 key 时按「同位置+同类型」复用实例**（:118-128，注释明确 React 语义）；无 DOM/CSS 级联/焦点/事件冒泡，Esc 靠直接调用根 div 的 onKeyDown（:893）。
- **fakeWindow**：location.hash 赋值 push 历史并同步派发 hashchange；history.back 依赖自建栈与 idx（:270-303），隔离良好。
- **fakeApi**：按 "METHOD 路径模板" 匹配（:307-327），记录全部 calls，未配置请求直接 reject；返回对象或抛 Error{status}（:563-567、:743-747）——**不构造后端错误信封**。
- **依赖注入**：bootShell 注入 loadLibModule（真实 import lib/ui/*.mjs，:445/:462）、importPageModule（假页面模块 :468）、fetchManifest（可失败 :463-467）；client.js 经临时 globalThis.window 加载并在 finally 恢复（:390-423），避免污染全局。
- **ui-design**：miniH + hydrate 自建 hydration 树（:89-148），bindRenderers 注入真实 render.mjs（:102）；LABELS fixtures 为手写对象（:631-717）；contrast-check 用 spawnSync 同步子进程（:216-227）。
- **隔离**：ui-design 声明并实践"不占端口、不建临时目录、不动 SORNE_DATA_DIR"（:22-23）；ui-shell 唯一真实用例走 helpers.withTestServer（mkdtemp + listen(0) + 恢复 env + rm）。test-ui-server 默认临时数据目录（:35-38），但**若外部已设 SORNE_DATA_DIR 则直接使用该目录**（:36），人工运行有写入真实数据目录的风险。

## ④ 断言质量（过拟合 / 同义反复 / 放宽 / 假绿）

- **无 HTML 字符串与 golden 文件**：两文件都断言元素树文本（host.text()/treeText/正则），无快照文件，故不存在传统 golden 脆性；代价是文本匹配粒度过粗：host.text() 拼接**整棵树含 display:none 的 keep-alive 隐藏页与占位卡**（ui-shell:213-217），如 :765/:775/:784 的 /正在探索/、/已暂停/、/已产生的证据与记录仍保留/ 是全文匹配，若隐藏页含同词会假绿；更稳妥应按可见 pageHost/aside 作用域取文本。
- **文案过拟合（有意的语义冻结）**：大量逐字断言冻结原文（ui-shell:784、:798、:858；ui-design:487-529），改文案即红；对"语义纪律冻结"是收益，但散落各处使文案重构成本高，建议集中断言 VOCAB/常量。
- **同义反复/弱断言**：
  - ui-design:959-968「白名单常量一致」实际只 assert.match(client, /"workbench"/) 等**文本包含**，注释或任意字符串即可满足，未用 client.js 已导出的 __test__.WORKSPACE_PAGES（client.js:1348-1354）与 router 导出做 deepEqual → 无法发现白名单真实漂移。
  - ui-design:450-451 对无 navigate 的 RecordIdChip 只断言"点击不抛错"，**容忍可点击死按钮**（实现 render.mjs:464-468 空操作）。
  - ui-design:584-611 DataTable 用词表 scope_kind 渲染值 candidate/confirmed（均不在 scope_kind 的 allow/deny/pending 中），StatusBadge 实际输出「未知状态（…）」却无断言；badge 列的中文标签/冻结措辞在该用例中未验证。
  - ui-design:293-323 前缀表断言只用客户端表自身 key，未与后端 records-read.mjs PREFIX_TABLES 对照 → 表过期（缺 BMK/BS/CR/EB/EI/JC/MRL/SH）仍全绿。
- **被放宽/失效的闸**：ui-design:352-373 唯一实现闸的 allowedDuringTransition 含 5 个已删除旧页（verification/vulnerabilities/coordination 等；仓库中已不存在），豁免已成死清单；且仅匹配字面 RECORD_ID_RE，换名复制正则即绕过。ui-design:246-264 字面颜色闸对含 --dsw-alias 的页面整文件跳过（当前 0 个，规则仍在），逐行匹配也会误伤注释/示例字符串；扫描面不含 test/ui-*.test.mjs 本身。
- **假绿（替身掩盖生产缺陷，最关键）**：
  1. **P0（/sorne/ui/lib 无静态路由）无法被发现**：ui-shell 注入 loadLibModule（:445/:462）；test-ui-server 自行服务该路径并注入（test-ui-server.mjs:109、:122-158）。client.js 的生产加载器 defaultLoadLibModule（client.js:266-279）与页面相对 import 在测试中 **0 覆盖**。
  2. **错误信封缺陷被替身补齐**：页面测试的 fake apiError(status,body) 额外挂 e.body（test/ui-onboarding.test.mjs:205-211、test/ui-projects.test.mjs:187-193），而真实 client.js api() 不挂 body（client.js:68-83）→ test/ui-onboarding.test.mjs:663-694 断言 next_requirements 呈现，在真实网络路径下必不成立（典型假绿）；ui-shell 的 fakeApi 只造 Error{status}，从未覆盖 409/code 分支。
  3. **顶栏 attempts 截断不可见**：所有 fixtures 恒 has_more:false 且 ≤2 条（ui-shell:488-504、:762、:818），Topbar 只取默认 50 条首页（client.js:378-386）的缺陷无从暴露。
  4. **主题组件无交互测试**：ui-design:773-797 只测句柄，Topbar ThemeSwitch 的 aria-pressed/重渲染缺陷（client.js:646-662）无断言。
  5. **formatTime 边界**：只测 3 天内（ui-design:379-401），>30 天重复日期与未来时间（render.mjs:355-369）未覆盖。
  6. **Esc/键盘**：直接调用 root.props.onKeyDown（ui-shell:893），未验证真实焦点前提（实现绑在内层 div，client.js:1155）。
- **对比度测试的边界**：ui-shell:899-916 只收集"有显式 color var() 且有直接文本子节点"的元素，背景缺失时**默认按 canvas token 计算**（:906-910）→ 卡片(surface/raised)上的文本对比度未被真实合成；:928 只要 ≥8 对即通过，非全量可见文本（ui-M1.md 偏差 10 自述无头环境无 computed style）。

## ⑤ 覆盖缺口

1. 真实宿主模块加载（P0）：defaultLoadLibModule、manifest file 相对/绝对 URL、页面内 new URL(../scope/editor.mjs, import.meta.url)、/sorne/ui/lib 404 降级卡的实际触发路径全部未测。
2. 引导层编号 chip 的项目参数（projects/onboarding 点击 chip → #/records/:id 无 ?project）未测；ui-design:910-914 只验证 openRecord 在 router.projectId 已存在时携带项目。
3. 详情 ?id= 切换时的数据重取未测（ui-design:930-936 只测深链关闭；ui-shell:624-656 只测单一 id）。
4. 项目设置抽屉、切换项目菜单、主题三态按钮、SettingsDrawer 的 Esc 优先级均无用例。
5. 深链 #/records/:id 的底衬/关闭落点（无应用内前驱时）未测：现有覆盖层用例都先在工作区页再改 hash（ui-shell:660-713）。
6. 错误信封 retryable/next_requirements 的真实 api() 路径、409 LLM_NOT_CONFIGURED 在 shell 层的呈现未测。
7. lifecycle 的 expected_state_version（乐观锁）未测；暂停后收尾轮询语义被 in-flight 用例固化为「回执即已暂停」（ui-shell:832-867）。
8. >50 attempts / >50 blocked intents 的分页截断未测；证据二进制经 api() 文本化（findings）未测。
9. scope/editor.mjs 的 openScopeRulesEditor 抽屉模式、onSaved/onDone 回执未测（仅经 onboarding 内嵌路径间接覆盖）。
10. 向导导入重试/幂等键（Date.now 生成 tool_call_id）未测；首启是否落 #/onboarding 未测。
11. 真实浏览器 a11y（焦点圈定、键盘 Tab 顺序、prefers-color-scheme 首帧、真实 computed style）未测；test-ui-server 自身仅人工走查，无自动化断言（模块 404、theme 参数、穿越防护 libFileFor 均无用例）。

## ⑥ 与实现文件映射

| 测试锁定面 | 实现文件:行 |
|---|---|
| 双布局/白名单/占位卡/keep-alive/详情槽/覆盖层/Esc | client.js:109-132、905-913、1010-1101、1117-1305 |
| resolveRunStatus 五态与暂停交互 | client.js:138-231、357-436、447-566 |
| LLM 门控 | client.js:235-262、469-475、510-521 |
| Router 解析/返回栈/openRecord | lib/ui/router.mjs:86-157、172-282 |
| 编号解析/前缀镜像 | lib/ui/record-ids.mjs:30-139 |
| 渲染器/词表/LABELS | lib/ui/render.mjs:44-331、345-848 |
| 主题 token/CSS/句柄 | lib/ui/theme.mjs:33-148、156-196、231-295 |
| 字面颜色闸/编号唯一实现闸 | test/ui-design.test.mjs:231-275、352-373 ↔ 全站 UI 文件 |
| 宿主与静态服务 | test-ui-server.mjs:74-171 ↔ index.js:apply、lib/routes/ui.routes.mjs:45-69 |

**结论**：测试质量整体较好（无 golden、真模块、真类组件、真实服务兜底、隔离干净），能守住冻结文案、路由返回栈、编号整体匹配与 token 对比度；主要风险集中在三处：**替身形状比生产宽**（loadLibModule 注入、fake error 挂 body）导致 P0/P1 假绿；**全文文本断言**跨隐藏页串扰；**闸的过渡豁免与文本包含式断言**已随旧页删除而失效但仍绿灯。
