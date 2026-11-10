# 06 · API 传输层与数据库迁移 —— 代码精读报告

> 任务：task-6（共享任务板）。范围：HTTP 传输层、路由契约、错误信封、SQLite DDL 与迁移、校验工具。
> 方法：逐行阅读下列文件（大文件分段 read），按需 grep 交叉核对 store 调用与被调用点；只读源码，未运行 npm test / npm run ui，未改任何源码。
> 结论一句话：传输层骨架（前缀注册 → 回环/同源信任 → 路由匹配 → 请求体 → 统一错误信封）与迁移框架实现完整、44 个蓝图端点全部实装、迁移 0001–0011 可干净地迁移到 schema_version=11；主要风险集中在「Agent 面写端点缺会话/角色面」「A1 用户面端点不校验会话项目域」「GET 带写副作用」「迁移/错误码缺少强制守卫」四处，未发现 P0 级阻断缺陷。

## 1. 范围与文件清单（全部已读）

| 文件 | 行数 | 一句话职责 |
|---|---|---|
| index.js | 82 | 插件入口：注册 /sorne 前缀、异步装载路由、启动 AI 运行时与 dsh 工具桥、effect 反注册 |
| lib/http.mjs | 137 | 信任边界基元（回环/转发头/同源 Origin）、JSON/原始体读取、路径解析、JSON/文本响应 |
| lib/router.mjs | 129 | 扫描 lib/routes/*.routes.mjs、路径匹配、分发顺序、错误信封序列化 |
| lib/errors.mjs | 75 | §20.1 13 业务码 + 6 传输/桩码注册表、ApiError 状态与 retryable 映射 |
| lib/db.mjs | 113 | node:sqlite 受控句柄：WAL/FK/busy_timeout、迁移框架、runSerial 串行短事务 |
| lib/stub.mjs | 24 | 施工期 501 桩工厂（当前路由面零使用，仅 smoke 直测） |
| lib/routes/*.routes.mjs（24 个） | 2845 | 见下；实际 24 个而非任务描述的 25 个（`lib/routes` 下无第 25 个文件） |
| lib/db/migrations/*.mjs（11 个） | 1205 | 0001 全量 DDL（684 行）+ 0002–0011 schema 演进 |
| tools/check.mjs / contrast-check.mjs / mock-target.mjs / real-model-verify.mjs | 45/39/117/198 | 语法门禁、WCAG 对比度门禁、回环漏洞靶标、真实模型端到端验证脚本 |

路由文件（行数）：asset-tree 136、attempts 213、changes 176、diagnostics 31、evidence 91、explore 33、extraction 81、health 54、judgements 88、lineage 217、llm 130、messages 140、metrics 93、orchestrator 186、plans 112、projects 269、reading 160、report-export 71、report-views 94、reports 104、snapshots 90、toolcalls 77、ui 69、verification 130。
迁移文件（行数）：0001 684、0002 42、0003 33、0004 66、0005 51、0006 10、0007 102、0008 70、0009 60、0010 45、0011 42。

## 2. 模块职责与关键导出（逐文件）

- **index.js**：导出 `name/inject/apply/resolveDataDir/__test__`。apply 同步完成：resolveDataDir（SORNE_DATA_DIR 覆盖，默认 ~/.sorne）→ `loadRouteFiles(ROUTES_DIR)`（不 await，索引 :48）→ `createDispatcher({routes})` → `startAgentRuntime`（失败仅日志，:55-64）→ `registerDshTools` → `ctx.effect` 内 `webServer.register({kind:"prefix",path:"/sorne"})`（:67-78）。
- **lib/http.mjs**：`MAX_REQUEST_BODY_BYTES=256KiB`、`isLoopback/isLoopbackConnection/isSameOriginLoopback/isTrustedRequest/hasForwardedAddress`、`sendJson/sendText/readJsonBody/readRawBody/parsePathname`。信任模型=回环 socket + 无转发头；变更额外要求 Origin 与 Host 同源且 Origin 主机回环。
- **lib/router.mjs**：`loadRouteFiles`（按文件名排序 import，校验 routes 形状）、`createDispatcher`（分发顺序：前缀过滤 → 回环信任 → 路由匹配 → 变更同源 → 读请求体 → handler；`result!==undefined` 自动 200 JSON；ApiError→信封，其余→500）。
- **lib/errors.mjs**：`SPEC_ERROR_CODES(13)`、`TRANSPORT_ERROR_CODES(6)`、`ERROR_META`、`ApiError/apiError`；业务码默认 422、传输码 403/404/400/413/500/501。
- **lib/db.mjs**：`listMigrations`、`openDatabase({file})`；句柄含 `{db,path,schemaVersion,runSerial,migrate,close}`；每次迁移在 `BEGIN IMMEDIATE` 事务内复查版本后执行并写 schema_version。
- **lib/stub.mjs**：`stub(moduleId,method,path,specRef,opts)` 返回 501 NOT_IMPLEMENTED 的路由对象（含 rawBody/maxBodyBytes 透传）。
- **lib/routes/**：每个文件导出 `routes = [{method,path,handler,rawBody?,maxBodyBytes?}]`；额外导出 `REPORT_LAYERS`（reports）、`D2_CANONICALIZATION_VERSION`（judgements）。装载入口统一为 index.js，模块间不 import 路由文件。
- **迁移**：每个文件导出 `{version,description,up(db)}`；版本与文件名前缀一一对应（1..11，已用内存库实测）。
- **tools/**：check.mjs 对 index.js/client.js/test-ui-server.mjs + lib/test/tools 递归 `node --check`；contrast-check.mjs 读 theme.mjs 的 TOKENS/CONTRAST_PAIRS 以 WCAG 公式判对比度；mock-target.mjs 仅绑 127.0.0.1 的故意漏洞靶标（/ /admin /api/echo /robots.txt /gbk /backup.zip /health），导出 `startMockTarget`；real-model-verify.mjs 用临时库 + 靶标 + 真实运行时跑 N 轮并统计工具/证据/意图。

## 3. 数据模型与持久化结构

- 迁移实测（`openDatabase({file:":memory:"})` 只读检查）：全部 11 个迁移顺序应用，schemaVersion=11，52 张业务表（含 schema_version），33 个显式索引，`PRAGMA foreign_key_check` 0 违规，`integrity_check=ok`。
- **单库多项目**：库文件固定 `<dataDir>/state/sorne.sqlite`（record-service.mjs:98-100，layout.mjs:56），所有表以 `project_id` 逻辑隔离，主键多为全局 TEXT（§6.1 稳定编号）。
- **0001（684 行，冻结全量 DDL）**：39 张表覆盖 §6.2 全部逻辑表；关键约束/索引：assets 身份 UNIQUE(project,type,canon_version,key)（:58-72）、captures UNIQUE(project,tool_call_id)（:160）、outbox UNIQUE(project,commit_seq,event_index)+pending 部分索引（:482-501）、attempts 部分唯一索引 `idx_attempts_active_assignment WHERE status IN ('leased','running')`（:354-355）、intents 调度/恢复条件部分索引（:327-333）、evidence_memberships UNIQUE(project,subject,member_kind,member_id)（:461）、submissions 初始全局 PK 后被 0002 重建、relations 正反查索引（:295-296）。
- **0002**：submissions 主键改为 `(project_id,submitter_id,id)` 身份域（:20-40），新 PK 严格弱于旧全局 PK，历史行原样搬移。
- **0003** intent_state_history：每次状态变化一行（from/to/action/reason/via/commit_seq）+ (project,intent,commit_seq) 索引。
- **0004**：14 类全局格式编号（project/asset/observation/hypothesis/vulnerability/fact/relation/membership/scope_revision/subscription/attempt/tool_call/worker_report/assignment）从 `id_sequences('_global',kind)` 取号；按历史裸编号最大值与旧项目序列水位抬基线（:45-65）。与运行时代码的 kind 名与前缀逐一核对一致（record-service.mjs:485/550/569/596/343/440/1162、attempts.mjs:622/649/996/1266、changes.mjs:499-512、judgements.mjs:677）。
- **0005** messages/message_links（delivered≠handled 状态机；复合主键防重复关联）；**0006** projects.task 列；**0007** reading_node_aliases/reading_branch_overrides/reading_bookmarks（按 role+actor+attempt 隔离的唯一书签）/material_read_logs；**0008** extraction_batches（UNIQUE(project,idempotency_key)）+items（UNIQUE(batch,item_index)）；**0009** check_records + judgement_corrections；**0010** branch_summaries（UNIQUE(project,branch_id)，refresh_status 三值）；**0011** branch_shelving（无 (project,branch_id) 唯一约束）。
- `schema_version` 表由 db.mjs:33-39 以 `CREATE TABLE IF NOT EXISTS` 建立（不在 0001），字段 version/description/applied_at。
- 索引缺口（实测）：以下 16 张带 project_id 的表没有以 project_id 打头的索引——candidate_groups/checkpoints/facts/goals/hypotheses/memberships/observations/orchestration_decisions/plan_runs/report_receipts/snapshots/subscriptions/template_members/verification_results/vulnerabilities/worker_reports；单库多项目下按项目过滤的视图/报表查询会退化为全表扫描（P2）。

## 4. 主要调用链与数据流

1. **读视图（以项目列表摘要为例）**：浏览器 `GET /sorne/projects?include=summary` → 宿主 webServer 前缀命中 index.js:68-72 → `dispatch(pctx,req,res)`（router.mjs:62）→ 前缀过滤 :64-68 → `isLoopbackConnection` :71（socket 回环 + 无转发头）→ 路由匹配 :79-88（method+段数+参数）→ GET 无 Origin 检查 :93-102 → 无 body :106-108 → `projects.routes.mjs:137-143` handler → `userPlane`（:27-38，无会话=user；非 user 会话 403）→ `listProjectsSummary` → `getStore(pctx)`（record-service.mjs:103-109）→ `store.runSerial` 内分页查询（projects:89-130，含每项目 3 次 COUNT 的 N+1）→ 返回对象 → dispatcher `sendJson(200)`（router.mjs:110）。
2. **写提交（幂等）**：`POST /sorne/submissions` → 信任/同源 :93-102 → `readJsonBody` 256KiB 上限 :106-108 → projects.routes.mjs:257-267 `sessionFromRequest`（sessions.mjs:96-100，进程内 token 注册表）→ `submit(pctx,{session,envelope})`：runSerial 单事务内按 (project,submitter,submission_id) 查 request_digest → 同摘要返回原回执 / 不同摘要 `IDEMPOTENCY_KEY_REUSED`；分配 local_ref→正式 ID、commit_seq、写业务行+outbox（0002 主键、0001 outbox 唯一约束）→ 回执 → 200 JSON。
3. **证据原始字节（rawBody 跨模块边界）**：`POST /sorne/evidence/blobs` → dispatcher 因 `route.rawBody` 不预读（router.mjs:105-108）→ evidence.routes.mjs:27-50 自调 `readRawBody(req, evidence.evidenceMaxBytes())`（默认 64MiB，evidence.mjs:43-49）→ `evidence.storeBlob`：staging→sha256→固定 `evidence/blobs/sha256/<ab>/<hash>`→DB 事务登记（DB 不引用未固定文件，EVIDENCE_NOT_COMMITTED）→ 回执。下载 `GET /evidence/blobs/:sha256` 自行 writeHead 后 `return undefined`（evidence.routes.mjs:54-73），遵守 router 的「自行结束响应」契约。
4. **快照（GET 带写副作用）**：`GET /sorne/snapshots/:kind` → snapshots.routes.mjs:49-59 → `projection.generateSnapshot` → `openSubscriptionBoundary`（B2 冻结签名，写/推进 subscriptions）→ `readView` 一致读视图生成内容 → `runSerial` 分配 SNAP 编号 → 写 maps/ 文件 → `runSerial` 插 snapshots 行 → 返回带 subscription/resume_cursor 信封。
5. **会话/角色面**：会话由 `issueSession`（sessions.mjs:40-64，192bit 随机 token，仅进程内）签发，经 `x-sorne-session` 头解析；planner/orchestrator/worker/verifier/runtime 端点分别在 plans:73-92、orchestrator.routes:98-186、attempts.routes:81-211、verification.routes:49-90、reports.routes:28-47 做角色校验；worker 面的 Attempt 归属在 attempts.routes.mjs:52-68（worker 只能操作自己 Attempt，否则 TRUST_DENIED）。
6. **错误路径**：handler 抛 `ApiError` → router.mjs:112-114 `error.toJSON()`（code/message/retryable/...extra，errors.mjs:63-70）；其余异常 → logger.warn + 500 INTERNAL_ERROR（:116-126）；非 /sorne 前缀与未命中路由→ JSON 404。

## 5. 关键不变量、并发/事务/幂等/错误处理

- **信任顺序**：/sorne 前缀内，连接层信任先于路由匹配（未知路径也 403，router.mjs:70-78）；变更请求在路由命中后、读体前做同源 Origin 检查（:93-102），故 404 不泄露、坏来源不消耗请求体。
- **请求体**：仅变更请求预读；rawBody 路由流保持未消费（router.mjs:105-108）；空体→`{}`、坏 JSON→BAD_REQUEST、超限→REQUEST_TOO_LARGE（http.mjs:74-105）。
- **响应契约**：handler 返回非 undefined 即 200 JSON；自行写响应者返回 undefined；错误信封必带 code/message/retryable（除 router.mjs:65-67 的前缀外 404）。
- **事务**：所有路由写操作都经 store 层 `runSerial`（grep：lib/routes 内 0 处 INSERT/UPDATE/DELETE），单连接单队列、`BEGIN IMMEDIATE`/COMMIT/ROLLBACK、事务体要求同步（db.mjs:63-81）；迁移逐版本在独立事务内「事务内复查版本→up→写 schema_version」，并发/跨进程安全（db.mjs:83-99）。
- **幂等**：submissions 以身份域 + request_digest（蓝图 §11.1，schema 由 0002 校正）；extraction_batches UNIQUE(project,idempotency_key)；outbox UNIQUE(project,commit_seq,event_index)；工单/动作幂等键在各自 store（orchestration_actions UNIQUE(project,idempotency_key) 0001:618）。
- **编号**：`id_sequences(project_id,kind,next_val)` 事务内分配，0010 起首值为 2、1 号保留空洞（record-service.mjs:168-191，A1.md 偏差 7）；全局格式编号用 `_global` 作用域，内嵌项目编号与 fencing 仍按项目域。
- **迁移纪律**：0001 冻结不动，后续演进只新增迁移（0002/0003/0004/0005 等均按「先保留历史行再启用新约束」处理）；未做前向兼容守卫（见 §7 P2-7）。
- **数据库安全**：WAL、foreign_keys=ON、busy_timeout=5000（db.mjs:58-60）；写锁不作为业务权限（权限在路由/会话层）。


## 6. 与文档/设计基线的对应与偏差

- **对应**：BLUEPRINT §2.1/§2.2/§2.3/§2.4 的信任顺序、rawBody 协议、迁移协议、错误信封均按文档实现；§5.1 的 44 个端点全部实装（无 501 桩）；§4.2 的 §6.3 约束与索引逐条可对回 0001；§8.2 角色矩阵在 planner/orchestrator/worker/verifier/runtime 面上落实。
- **端点注册表漂移**：BLUEPRINT §5.1=44 + BLUEPRINT-UI §2.6=#45–#53（累计 53）→ 实际装载 77 个注册（实测 `loadRouteFiles`）：53 个编号端点 + 6 个路径别名（messages #46/#47 与 llm #50–#52 各一套别名）+ DELETE /projects/:id + 阶段 2–7 新增 17 个端点（reading 9、extraction 4、asset-tree 1、lineage 1、GET tool-calls/captures 2）。其中 17 个阶段端点在任何 docs 中均无注册（docs 全文检索无这些路径），仅存在于代码注释与测试，属契约漂移（P2-22）。
- **0005 编号与蓝图 §2.8 偏差**：蓝图原计划 0005-llm-settings/0006-messages，实际合并为 0005-messages（llm 配置落 `<dataDir>/llm.json`），已在 docs/modules/ui-M2.md §5 偏差 1 登记。
- **0002/0004 为规范优先的复盘演进**：A1.md §5 偏差 1/6 已登记（submissions 身份域、全局编号），0001 本体未改。
- **A2 actor 过渡方案**：evidence 写端点的 `created_by` 取 `x-sorne-actor` 头（evidence.routes.mjs:47/80；缺省 unknown），A2.md:130-134 已登记为「会话解析未纳入 §2.7 冻结签名」的未获批偏差。
- **多连接写同一库**：record-service 与 evidence 各自缓存句柄（record-service.mjs:96-109、evidence.mjs:82-100），与蓝图 §2.3「单一串行写队列」有界差异（SQLite BEGIN IMMEDIATE 保证原子性，跨连接顺序不保证），A2.md:135-139 已登记。
- **spec 码之外的业务码**：LLM_NOT_CONFIGURED 未登记进 errors.mjs（lib/store/explore.mjs:44-55，BLUEPRINT-UI.md:430 有定义），错误码注册表只作文档、无强制消费（P2-10）。
- **新增（未在蓝图但文档化）**：change-log #45 与 #46–#53 见 BLUEPRINT-UI §0/§2.6；本模块实现与之一致（含 409/next_requirements、key 不回传、导出 Content-Disposition）。

## 7. 问题清单

> 未发现 P0 阻断项（已核对：44 端点全实装、迁移全新库可应用到 11、44+13 端点路由无重复、全部路由写操作均经 store 事务、信任顺序与蓝图一致）。

**P1 重要**

1. [bug] `lib/routes/projects.routes.mjs:148-186`：`POST /projects` 先 `createProject` 落库（:157-163），随后可选写 LLM 配置 `writeLlmSettings`（:172-178）；后者可抛 BAD_REQUEST（llm-settings.mjs:115/118 校验 base_url/model）。此时项目已提交但响应为 4xx/5xx 且无 receipt，违反 BLUEPRINT §2.4/§20.1「提交已成功时不得用错误掩盖、必须带回执」；客户端重试会重复建项目（项目创建非幂等）。建议：把 LLM 写入放项目事务之前校验、或失败时回执中携带已建 project 并显式标注部分成功。
2. [不一致] 写端点未接会话/角色面：evidence 写（`lib/routes/evidence.routes.mjs:27-50` blob、`:76-82` capture）、extraction 写（`lib/routes/extraction.routes.mjs:8-19,23-40,56-66`，readPlane 允许无会话）、reading 书签（`lib/routes/reading.routes.mjs:111-129`，且 :118-119 允许 body.role/body.actor_id 覆盖会话身份）。蓝图 §8.2 把这些端点划给 worker/verifier；§11.1 要求 actor 由会话决定。现状任何回环同源进程可写证据/批次/他人书签并自报 actor；未登记偏差（A2 只覆盖 evidence 的 actor 来源）。建议三端点接入 sessionFromRequest + 角色校验，bookmark 的 role/actor 只取会话。
3. [风险] `index.js:48-49`：`loadRouteFiles` 的 Promise 未被 await/catch；任一路由文件 import 失败时 `routesReady` 拒绝，在首个请求到来前无 rejection 处理者（router.mjs:59-61 只派生、:79 才 await）→ Node 默认 unhandledRejection 可终止宿主进程。建议 apply 内 `.catch(err => …日志+降级空路由或 503)`。
4. [不一致] A1 用户面端点不校验会话项目域：`projects.routes.mjs:27-38` 的 userPlane 只判角色；DELETE /projects/:id（:190-201）、POST /projects/:id/lifecycle（:213-225）、POST /scope-revisions（:228-243，body.project_id 直用）、GET /projects/:id（:204-210）、GET /projects/:id/scope（:246-253）均不比对 `session.project_id`；`messages.routes.mjs:69-83` 的 body.project_id 分支与 :88-103 别名路径同样绕过；`explore.routes.mjs:27-31` 也不比对 params.id。当前生产无 user 角色会话签发通道（grep：仅测试 issueSession role=user），故为潜在越权（持有 user 会话者可跨项目写/删）；与 §11.2 冲突，应在 userPlane 统一校验。审查依据：同类只读面 intents:17-33 / snapshots:16-32 均做了校验，形成不一致。

**P2 次要**

5. [bug] `lib/routes/lineage.routes.mjs:195`：判断 `m.stance === "oppose"`，但 DDL CHECK 只允许 supports/contradicts/neutral（0001:456），全库无 oppose 写入（grep）→ 反证边永远渲染为「证明」。
6. [风险] GET 带写副作用且不受 Origin 检查（router.mjs:93-102）：`GET /snapshots/:kind`（snapshots.routes.mjs:49-59 → projection.mjs:1280-1284 写 subscriptions、:1310/:1349-1361 写 SNAP 行与 maps/ 文件）；`GET /reports/milestones?refresh=1`（report-views.routes.mjs:84-91）生成 report_revisions。跨站 GET（img/导航）即可触发写与磁盘增长；建议改为显式 POST 或要求自定义头。
7. [风险] `lib/db.mjs:83-99` 迁移无前向/重复守卫：旧代码打开更高版本库时静默成功（只看 MAX(version)，schemaVersion 可大于代码最新），重复/乱序 version 会被 `m.version <= have` 静默跳过；`listMigrations:18-31` 只校验 version/up 存在。建议启动时校验「代码最新版本 == 库版本」或区分可前向字段。
8. [风险] `lib/db.mjs:63-81` runSerial 不校验事务体同步性：传入 async fn 会先 COMMIT 再执行后续 await，原子性静默失效（当前 78 处调用 grep 均为同步、0 处 async，属无守卫的约束）；嵌套 runSerial 会永久排队（同一 queue 自等待）。建议运行时断言返回值非 thenable。
9. [风险] `lib/db.mjs:41-53`：单飞只覆盖「并发打开同一文件」；首次打开 settle 后再次 openDatabase 会新建连接（与 record-service/evidence 的模块内缓存叠加成多连接多队列），与蓝图 §2.3「单一串行写队列」表述有界差异（A2 已登记，非新问题）。
10. [不一致] 错误码注册表无强制：`lib/errors.mjs:12-37` 导出 SPEC/TRANSPORT 码但无消费方；`ApiError`（:53-62）对未知码回落 500（且保留未知 code），`lib/store/explore.mjs:44-55` 的 LLM_NOT_CONFIGURED 依赖 extra.status 才不是 500。建议 ApiError 对未知码直接抛配置错误，并补「所有 apiError 码∈注册表」的测试。
11. [不一致] `lib/router.mjs:64-68`：非 /sorne 前缀的 404 信封缺少 `retryable`，与其余信封（§2.4 要求必带）不一致（webServer 前缀下该分支实际不可达）。
12. [bug] `lib/http.mjs:41-51`：变更 Origin 只接受 `http:` 且 `isLoopback(parsed.hostname)`；Node URL 对 IPv6 回环返回 hostname `"[::1]"`（实测），而连接层明确信任 `::1`（:14-19）→ 来自 ::1 的变更请求必然 403；若宿主以 HTTPS 提供 UI，所有变更同样 403。建议按 `URL.hostname` 去括号后比较，并允许宿主协议。
13. [不一致] `lib/http.mjs:22-29` 只拒绝 Forwarded / x-forwarded-for / x-real-ip / x-forwarded-host，蓝图 §2.1 写「X-Forwarded-*」全族（如 x-forwarded-proto 未被检查）。
14. [风险] `lib/http.mjs:74-105` 与 `:116-137` 仅监听 data/end/error，不处理 `aborted`/`close`：客户端中断时 Promise 不 settle，dispatcher 挂起（无超时）；建议监听 aborted 后 reject。
15. [死代码] `lib/http.mjs:31-33` `isTrustedRequest` 无调用方；`lib/stub.mjs` 在路由面零引用（44 端点全实装，仅 smoke.test.mjs:64-77 直测工厂），作为施工期遗留可保留但应注明。
16. [风险] 静默截断与无分页：`asset-tree.routes.mjs:54-56` captures LIMIT 1000、`:125-131` 把已加载数当总数且无 truncated 标记；`toolcalls.routes.mjs:10-14/26-36` limit clamp 500、captures 2000 无 has_more/next_cursor；与 §2.6-6「列表分页走游标不静默截断」冲突（对照 lineage.routes.mjs:198-204 正确返回 truncated）。
17. [风险] 多条语句的只读视图无一致读边界：asset-tree:48-56、lineage:35-192、toolcalls:24-36、health:26-41 直接逐条 `store.db.prepare` 读（未用 runSerial/readView），语句间可插入提交，且响应不带 commit_seq 边界标注（B1 对 /snapshots 有「一致读视图」要求，此四处为自建视图）。
18. [风险] 以写事务跑纯读：`projects.routes.mjs:89-130`（/projects?include=summary）与 `changes.mjs:425`（/change-log）在 `runSerial`（BEGIN IMMEDIATE）内做只读查询，持写锁并与写队列串行；summary 还每项目 3 次 COUNT（:53-86）N+1。
19. [bug] `lib/routes/reading.routes.mjs:52` `JSON.parse(query.filter)` 未保护 → 非法 JSON 抛 SyntaxError 被 router 归为 500 INTERNAL_ERROR（应为 400）；:51/66/102-103 用裸 `Number(...)` 未校验（NaN 下传 store）；:39/49/77/90/101 二次 `decodeURIComponent`（router 已解码），与其它路由不一致。
20. [风险] 256KiB JSON 上限（http.mjs:12）对所有 JSON 端点生效且无路由声明 maxBodyBytes（router.mjs:106-108；stub 支持但无实装路由使用）；批量提交/抽取批次等大 JSON 载荷会 413，rawBody 仅证据上传自定 64MiB。
21. [不一致] 冗余索引（列序与既有 UNIQUE 相同）：`idx_outbox_page` vs UNIQUE(project,commit_seq,event_index)（0001:498/500）、`idx_extraction_items_batch` vs UNIQUE(batch_id,item_index)（0008:63/66）、`idx_branch_summaries_branch` vs UNIQUE(project,branch_id)（0010:38/42-43）。
22. [不一致] 阶段 2–7 的 17 个端点未进入任何 API 注册表文档（见 §6），且 reading/extraction/asset-tree/lineage/tool-calls 的 HTTP 层无测试（见 §8）。
23. [不一致/风险] `lib/routes/health.routes.mjs:43-50` 存储检查失败仍返回 HTTP 200 + `{ok:false}`；脚本化监控按状态码判定会漏报。建议 503 或文档固化该语义。
24. [bug/工具] `tools/real-model-verify.mjs:7` 用法写 `--rounds N`，:25 只解析 `--rounds=N`（`--rounds 3` 被忽略回落 6）；`:92` 以 `process.cwd()/sorne-data/llm.json` 定位配置，非仓库根运行即失败。
25. [风险] `lib/db/migrations/0011-branch-shelving.mjs:15-41` 无 (project_id,branch_id) 唯一约束，与 0010 branch_summaries 的「每分支一条」语义不对齐：同一分支可存在多条 status='shelved' 行（store 侧是否保证未验证，故列风险而非 bug）。


## 8. 测试覆盖映射

**已覆盖（真实 HTTP / 真实 SQLite，随机端口 + 临时数据目录）**
- `test/smoke.test.mjs`：插件入口形状与 /sorne 前缀注册（:30-46）；health（:50-57）；变更缺 Origin / Origin 非回环同源 → 403 TRUST_DENIED（:89-105）；x-forwarded-for 拒绝（:155-163）；信任检查先于路由匹配（:142-163）；未注册路由 404 JSON（:107-112）；rawBody 路由超过 256KiB 原始字节可达 handler（:165-196）；迁移到最新 schema_version + §6.2 表/§6.3 索引存在 + migrate 幂等（:233-291）；并发 openDatabase 单飞同句柄（:293-309）；runSerial 提交与回滚（:311-340）；UI manifest/页面源与非法文件名（:198-229）。
- `test/multi-project.test.mjs`：0004 迁移升级路径（手工建 0001–0003 历史库 + 旧序列水位 → 打开后 `_global` 基线 = max(历史最大+1, 水位, 2)，:198-320）；跨项目编号不冲突的端到端 HTTP 用例。
- `test/cursor.test.mjs`：/changes、/change-log、/intents、/reports/vulnerabilities、/attempts、/verification-jobs、/projects(summary)、/reports 的 next_cursor/has_more/cursor 与 after 别名（含非法游标 400）。
- `test/evidence.test.mjs`：blob rawBody 上传/下载、413 上限、404、场景 23/25。
- 其余端点各有业务测试（真实路由）：submissions、changes、intents、attempts、scope、verification、judgements、reports、worker-reports、orchestrator、recovery、projects-crud（含 DELETE confirm）、projects-summary、change-log、diagnostics、messages、llm-settings、explore-start、report-export、e2e-lifecycle、stage1–7（多数直接调用 store）。
- 工具：`tools/contrast-check.mjs` 由 ui-design.test.mjs:216+ 以子进程断言；`tools/mock-target.mjs` 由 agents-realrun.test.mjs 多处使用并断言只允许绑 127.0.0.1；`tools/check.mjs` 由 `npm test` 首段执行。

**无测试（明确缺口）**
- 传输层负路径：坏 JSON 体 400、JSON 体 >256KiB 的 413、非法百分号编码路径（`parsePathname` 抛错→500）、HEAD、HTTP 方法不匹配（现返回 404 而非 405）、`Forwarded`/`x-real-ip`/`x-forwarded-host` 三个非测试覆盖的转发头、HTTPS/IPv6 Origin 场景、rawBody 超限、请求体中途中止。
- 路由装载失败（index.js:48 无 catch）与逐路由 500 分支无测试。
- DB：更高版本库被旧代码打开（前向兼容）、重复/乱序 version、schema_version 行内容、异步/嵌套 runSerial 守卫。
- 4 组端点 HTTP 层 0 覆盖：`GET /projects/:id/asset-tree`、`GET /projects/:id/lineage`、`GET /tool-calls`、`GET /captures`（grep 测试目录无路径引用；仅前端页面引用）；reading 9 端点、extraction 4 端点的路由层也未测（stage2/stage3 测试直接调 store）。
- 错误码注册表完整性、DELETE /projects/:id 之外的用户面跨项目校验均无测试。

## 9. 不确定点与需 Lead 交叉确认的问题

1. `lib/routes` 实际 24 个文件，任务描述写 25 个——请确认是否有一个文件被删除/改名而非遗漏（本报告已覆盖全部 24 个）。
2. P1-4 的严重度取决于「生产是否会签发 user 角色会话」：当前 grep 仅测试调用 `issueSession(role:"user")`，UI 走无会话请求。若宿主/dsh 桥后续引入 user 会话，则跨项目写/删立即成为真实越权；请确认设计意图。
3. P1-2：evidence 的 actor 来源已在 docs/modules/A2.md §5 偏差 3 登记，但 extraction/reading 的「无会话 + body 自报 role/actor」没有任何竣工记录登记；请确认是遗漏登记还是有意为之。
4. GET 带写副作用（snapshots、reports?refresh=1）：B1 文档只登记了 maps/ 目录写入，未讨论 GET 语义与跨站可触发问题；请与架构师确认是否接受（若接受，建议在 BLUEPRINT/UI 文档固化）。
5. asset-tree/lineage/toolcalls 三个只读视图端点不属 BLUEPRINT §3 任何模块的独占文件清单，也无 API 注册表条目；请确认归属模块与文档补登记责任方。
6. 0011 branch_shelving 无 (project_id,branch_id) 唯一约束是否与阶段 6 store 的「每分支唯一搁置行」假设冲突，需读 `lib/store/scheduling.mjs` 的读者交叉确认（不在本卡分配范围，未下结论）。
7. 0004 迁移的 kind 清单已与 grep 到的 GLOBAL_SEQ_SCOPE 调用逐一核对一致；但 E1/D1/F1 的项目内嵌编号（ACT/VJ/VR/EVM/RPT 等）未逐个读 store 验证，「不受影响」结论依赖代码注释与 grep，请其他卡交叉确认。
8. P2-7 前向兼容守卫属运维策略（旧代码打开新库是拒绝启动还是告警），需架构师定调，本卡不建议直接改冻结的 lib/db.mjs。

