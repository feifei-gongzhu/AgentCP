# Sorne 施工蓝图（冻结契约 v1.1）

> **变更记录**
> - v1.1（独立评审修订，15 条意见全数采纳）：①冻结 router/http 支持 rawBody 路由（证据字节流式上传，不再被 256KiB JSON 预读上限卡死）；②DDL 新增 `evidence_manifests` 表并外键绑定 job/result 的 Manifest 引用（§12.1）；③snapshots.kind 新增 `planner_view`（§15.3 Planner 视图落点），端点 #13 扩展；④新增 §2.7 跨模块冻结签名（B2→B1 `openSubscriptionBoundary`、D2→D1 `applyStateTransition`），消除同阶段并行互等；⑤§5.2 目录程序义务（assets/ 逻辑目录 + work/ 工作区）归 A2 新文件 `lib/store/layout.mjs`；⑥§7 新增 §20.3 末段端到端贯穿验收（F2 `test/e2e-lifecycle.test.mjs`）；⑦新增端点 #43/#44（原始证据字节与采集详情读取，§8.3/§18.3 落点），端点总数 42→44；⑧intents 恢复条件以部分表达式索引 `idx_intents_resume` 等效落实（§6.3）；⑨§6.2 逻辑表行数更正为 23（→37 物理表）；⑩README 测试命令更正为 glob 形式；⑪§8.3 发现者≠验证者操作化修正（不限制续验/复核的请求发起者）；⑫信任检查先于路由匹配（404 不泄露路由存在性）；⑬openDatabase 同文件单飞 + 迁移事务内版本复查；⑭§16.3 深广回访归入 E1 负责章节。
> - v1：初始冻结。

> 本蓝图是 sorne 工程施工期的唯一依据。最高准绳是《持续探索型渗透测试Agent系统-工程设计规范》
> （下称「规范」，章节号 §N 均指该文档）。蓝图与规范冲突时，以规范为准并如实上报架构师；
> 无法确定的事项写入 §14 风险清单，不得编造。
>
> 蓝图冻结范围：模块地图与文件所有权（§3）、DDL（§4）、API 注册表（§5）、事件目录（§6）、
> 验收映射（§7）、角色权限模型（§8）、UI 信息架构（§9）。施工者**只写**自己独占的代码/测试
> 文件与本模块的竣工记录 `docs/modules/<id>.md`（模板见 `docs/modules/_TEMPLATE.md`），
> **不改蓝图、不改冻结共享文件**。确需变更：停工 → 上报架构师 → 批准后由架构师改蓝图并记录。

---

## 1. 工程事实与总则

### 1.1 工程事实

- 根目录：`/Users/thorneye/Documents/Agentcp/sorne/`（本目录）。
- 旧工程 `/Users/thorneye/Documents/Sorne/Sorne`（Python）**整代废弃，零迁移**，仅保留产品名 Sorne。
- 插件形态：dsh（DeepSeek Harness）插件，参照 `dsh-mrecon` 参考实现：
  - 服务半端 `index.js` 运行于 Harness 进程，`export const name = "sorne"`、`inject = ["webServer"]`，
    以 `kind:"prefix"` 注册 `/sorne`；
  - 客户端半端 `client.js` 经 `dsh.client.inject = ["@deepseek-ai/dsh-client-runtime"]`（platform web）注入；
  - `peerDependencies` 只声明宿主面：`@deepseek-ai/cordis`、`@deepseek-ai/dsh-host-webserver`。
- 运行时：Node ≥ 22.5（`node:sqlite` `DatabaseSync`；本骨架在 Node 22.23.2 验证）。
- 模块体系：全 ESM（`"type":"module"`），无构建步骤、无前端打包依赖，前端 React 由宿主注入、内联样式。
- 数据根：环境变量 `SORNE_DATA_DIR` 覆盖，默认 `~/.sorne`；项目目录按规范 §5.2 布局：
  `evidence/{blobs/sha256/ab/<hash>, staging/}`、`assets/`、`maps/`、`reports/`、`work/<intent>/<attempt>/`、`state/`。

### 1.2 统一门禁（整个施工期不变）

```bash
npm run check   # tools/check.mjs：对全部源文件执行 node --check（新增文件自动纳入）
npm test        # check && node --test "test/*.test.mjs"
```

注意：`node --test test/`（目录实参）在本机 Node 22.23.2 会把目录当模块执行而报
`MODULE_NOT_FOUND`，故统一用带引号的 glob `"test/*.test.mjs"`（Node runner 自行展开，
跨 shell 稳定）。语义与任务要求的「跑 test/ 全部测试」一致。

测试硬性规则（并行安全）：每个测试文件独立 `mkdtemp` 临时目录（`test/helpers.mjs`）、
`listen(0)` 随机端口、finally 关服务删目录、不留后台进程、不触碰 `~/.sorne`。

### 1.3 冻结共享文件清单（施工者不得修改；变更需架构师批准）

| 文件 | 作用 |
|---|---|
| `package.json` | dsh 清单、scripts、peerDeps |
| `index.js` | 插件入口、`/sorne` 前缀注册、pctx |
| `client.js` | 工作台外壳（页面加载契约见 §2.6） |
| `test-ui-server.mjs` | UI 测试宿主（§10.2） |
| `lib/http.mjs` | 信任边界 + HTTP 基元 |
| `lib/errors.mjs` | §20.1 错误码注册表 + 错误信封 |
| `lib/db.mjs` | DatabaseSync 封装、迁移框架、runSerial 串行短事务 |
| `lib/router.mjs` | 路由装载/匹配/分发 |
| `lib/stub.mjs` | 501 桩工厂 |
| `lib/routes/ui.routes.mjs` | UI manifest + 页面静态路由（基础设施） |
| `lib/ui/pages/*.page.mjs` 的加载协议 | 页面契约（§2.6）；页面文件本身归各前端模块 |
| `lib/db/migrations/0001-core-schema.mjs` | 全量 DDL（§4 唯一权威实现；修正需批准） |
| `test/helpers.mjs` | 测试并行安全工具 |
| `tools/check.mjs` | check 门禁 |
| `docs/BLUEPRINT.md`、`docs/modules/_TEMPLATE.md` | 本蓝图与竣工记录模板 |

模块施工 = 在自己独占的文件内实装 + 新增自己的路由/存储/页面/测试文件。路由与页面
靠目录扫描自动挂载（§2.2/§2.6），因此**新增文件不需要改任何共享文件**。

### 1.4 目录树（骨架现状）

```text
sorne/
├── package.json / index.js / client.js / test-ui-server.mjs / README.md / .gitignore
├── docs/BLUEPRINT.md、docs/modules/_TEMPLATE.md
├── lib/
│   ├── http.mjs / errors.mjs / db.mjs / router.mjs / stub.mjs
│   ├── db/migrations/0001-core-schema.mjs        # 全量 DDL（迁移 1）
│   ├── routes/*.routes.mjs                       # 14 个路由文件 = 44 端点（§5）
│   ├── store/*.mjs                               # 18 个模块存储/服务骨架（合同注释在文件头）
│   └── ui/pages/*.page.mjs                       # 9 个工作台页面（§9）
├── test/helpers.mjs、test/smoke.test.mjs          # 冒烟（起步即绿，14 用例）
└── tools/check.mjs
```

---

## 2. 基础技术契约

### 2.1 插件形态与信任边界

- `index.js`：`name="sorne"`，`inject=["webServer"]`；`apply(ctx)` 同步注册
  `{kind:"prefix", path:"/sorne", handler}`（路由装载用异步 import，dispatcher 等待同一
  Promise，首个请求前完成）。`ctx.effect` 内注册并在 dispose 时反注册。
- 信任边界（`lib/http.mjs`，与参考实现同模型）：
  - **分发顺序（冻结于 `lib/router.mjs`）**：连接层信任检查（回环 + 无转发头）
    **先于路由匹配**——非回环或携带 `Forwarded` / `X-Forwarded-*` / `X-Real-IP` /
    `X-Forwarded-Host` 的请求对已知与未知路径一致返回 `403 TRUST_DENIED`，不泄露
    路由存在性；随后路由未命中返回 404；变更操作再检查 `Origin` 与 `Host` 同源且
    Origin 主机为回环（回环机器内的第二道检查），拒绝同样返回 403。
- 外部页面、JS 与工具输出一律作为数据处理，不修改系统角色权限或范围规则（§11.2）。

### 2.2 路由与模块挂载协议

- 每个后端模块拥有 `lib/routes/<area>.routes.mjs`，导出
  `export const routes = [{ method, path, handler }]`；
- `path` 以 `/sorne` 开头，支持单段参数 `:name`（如 `/sorne/records/:id`）；
- `handler(pctx, req, res, { params, query, body })`：返回值 ≠ `undefined` → 200 JSON；
  需要非 JSON 响应时自行结束 `res` 并返回 `undefined`；抛 `ApiError` → 统一错误信封；
- **rawBody 路由**：`{ rawBody: true }` 声明的变更路由，dispatcher 不预读不解析请求体
  （流保持未消费），handler 自行以 `http.readRawBody(req, maxBytes)` 流式读取并自定上限；
  用于证据字节等非 JSON 大载荷（#11 POST /evidence/blobs，§5.3/§13——JSON 预读的
  256KiB 默认上限不得约束证据上传）；`maxBodyBytes` 仅覆盖 JSON 预读上限；
- 未实装端点由 `lib/stub.mjs` 的 `stub(moduleId, method, path, specRef)` 返回
  `501 {"code":"NOT_IMPLEMENTED","module":...,"endpoint":...,"spec":...}`；
  **模块竣工验收项：其名下端点不再返回 NOT_IMPLEMENTED**；
- `pctx = { logger, dataDir, pluginDir, version }`。

### 2.3 存储与迁移协议

- `openDatabase({file})`（`lib/db.mjs`）：WAL、`foreign_keys=ON`、`busy_timeout=5000`，
  自动应用迁移到最新 `schema_version`；
- 迁移文件 `lib/db/migrations/NNNN-<name>.mjs` 导出 `{version, description, up(db)}`；
  迁移 0001 已含全量 DDL（§4），后续迁移仅在确实需要 schema 演进时新增（编号顺延，
  先处理历史数据冲突再启用新约束，§6.3）；
- **所有写入必须经过受控写入服务** `store.runSerial(fn)` 串行短事务；事务体 `fn(db)`
  必须同步，不得在 BEGIN 与 COMMIT 之间 `await`（§5.1）；
- 同一库文件的并发 `openDatabase`：进程内单飞返回**同一受控句柄**（单一串行写队列）；
  跨进程由 `BEGIN IMMEDIATE` + 迁移事务内版本复查兜底，不重复建表；
- 稳定编号由 `id_sequences(project_id, kind, next_val)` 事务内分配（§6.1）；显示短编号
  （A-001 / I-012 / V-003）由前缀 + 序列构成，真实身份不得依赖可变标题或路径；
- `commit_seq`：项目级单调序（`projects.next_commit_seq` 事务内取出并推进）；
  同一提交内多事件用 `event_index` 区分（§14.1）；
- 写锁不当作业务权限；agent 不直连数据库，一切变更经 Record Service（§5.1）。

### 2.4 错误信封

```json
{ "code": "STALE_STATE", "message": "...", "retryable": false,
  "receipt": {...}, "next_requirements": [...] }
```

`receipt`：已保存内容的回执（提交实际已成功时必须带回，不得用错误掩盖，§20.1）；
`next_requirements`：解除错误所需的下一步条件。§20.1 的 13 码注册表见 §5.3。

### 2.5 提交信封与回执（§11.1，A1 实装）

```json
// 请求
{ "submission_id": "SUB-0007", "attempt_id": "ATT-001",
  "operations": [ {"op":"append_observation","local_ref":"obs1","capture_id":"CAP-001","payload":{}},
                  {"op":"propose_hypothesis","local_ref":"hyp1","payload":{}},
                  {"op":"add_relation","from":"obs1","type":"supports","to":"hyp1"} ] }
// 回执
{ "submission_id":"SUB-0007", "commit_seq":42,
  "ids":{"obs1":"O-0031","hyp1":"H-0012"}, "accepted_operations":[...],
  "warnings":[...], "result_hash":"..." }
```

幂等：同 `(project_id, submitter_id, submission_id)` + 相同请求摘要 → 原回执；
同 ID 不同内容 → `IDEMPOTENCY_KEY_REUSED`。重试必须同 ID；新的独立采集用新编号。

### 2.6 UI 加载契约（多文件，骨架已定型）

**决策**：多页面工作台采用「冻结外壳 + 服务半端供页面模块」的多文件组织。理由：宿主
client 半端只保证注入单入口 `client.js`（参考实现证据：`dsh.client.inject` 仅指向
dsh-client-runtime，页面 JS 由服务半端 webServer 提供）；单文件会让六个前端模块
（A3/B3/C3/D3/E3/F3）串行争抢 `client.js`，违反并行所有权。

- `client.js`（冻结外壳）：`window.__ModuleLoader__.load({id:"sorne", factory})`；
  factory 内 `require("react")`；`apply(ctx)` 注入 `settings.section`（id `sorne`，
  与参考实现同插槽、同信任模型）；渲染外壳 = 标题栏 + 左侧导航 + 页面容器 +
  `SectionErrorBoundary`（单页异常不白屏）；
- 外壳启动时 `GET /sorne/ui/manifest`（由冻结的 `lib/routes/ui.routes.mjs` 扫描
  `lib/ui/pages/*.page.mjs` 生成）→ 逐个 `import(file)` 动态加载页面模块；
- **页面模块契约**：`lib/ui/pages/<id>.page.mjs` 为纯 ESM，不得 import 任何包或
  Node 内置模块，导出 `export default { id, title, order, render(ctx) }`；
  `ctx = { React, h, api }`（React/h 由外壳注入；`api` 为同源 `/sorne/*` fetch 封装）；
- 页面文件按 §9 归属各前端模块；manifest 按 `order` 排序；
- 页面加载失败降级为错误卡片，不拖垮外壳；
- 无构建、内联样式、文案中文；样式变量用 `--dsw-alias-*` 带回退值。

### 2.7 跨模块冻结签名（同阶段并行模块之间的调用契约）

同阶段模块并行施工时，跨模块依赖**只允许调用以下冻结签名**（实现方在自己独占文件内
导出，调用方 import；签名变更需架构师批准）：

| 签名 | 实现方 → 调用方 | 语义 |
|---|---|---|
| `openSubscriptionBoundary(pctx, { projectId, focus, scope }) → { subscription_id, subscription_revision, resume_cursor, snapshot_commit_seq }`（`lib/store/changes.mjs`） | B2 → B1 | 在一致读视图内建立或更新订阅边界并推进 `subscription_revision`（§15.2）；B1 的 `GET /snapshots/{kind}` 以返回值组装快照响应，不自行写 subscriptions 表 |
| `applyStateTransition(db, { project_id, subject_kind, subject_id, expected: { state_version, claim_revision, evidence_revision, assessment_epoch }, action, verification_result_id })`（`lib/store/judgements.mjs`） | D2 → D1 | §8.4 状态转换合同的**唯一实现**：按前提校验并在调用方事务内写入新状态/版本/review；前提不满足抛 `STALE_STATE` / `CLAIM_CHANGED` / `PRECONDITION_INVALID`。D1 的 §12.2 核心事务在完成身份/Manifest/版本校验后调用它应用转换，**不得另行实现状态机** |

---

## 3. a) 模块地图（规范 §21 阶段 A–F）

每阶段 2–3 个模块（后端 + 前端）；**同一阶段内文件所有权互斥**（下表「独占文件」），
跨阶段不得修改他人文件。共享文件见 §1.3。每个模块的存储骨架文件头含合同注释。

### 阶段 A：持久记录和证据底座

> 规范 §21 原文：实现 Blob、Capture、核心实体、关系、幂等提交与 Outbox。
> 完成标准：并发提交、重复请求和提交中断后数据可恢复，历史证据不被覆盖。

| 模块 | 名称 | 负责章节 | 独占文件 | 施工要点 |
|---|---|---|---|---|
| **A1** | 幂等提交与统一记录服务 | §5.1 §6.1 §6.2 §6.3 §11.1 §11.3 §13(数据库侧) §16.4 §17(范围表) §20.1 | `lib/store/record-service.mjs`、`lib/store/sessions.mjs`、`lib/routes/health.routes.mjs`、`lib/routes/projects.routes.mjs`、`test/submissions.test.mjs`；（`lib/db/migrations/0001-core-schema.mjs` 归其维护，DDL 冻结） | runSerial 串行短事务全量落地；submission_id 幂等（请求摘要比对→原回执/IDEMPOTENCY_KEY_REUSED）；local_ref→正式 ID；commit_seq 事务内分配；业务记录+Outbox 同事务（§2.10/§14.1）；追加型不查版本、修改型查 expected_version（STALE_STATE，§11.3）；项目生命周期 active/waiting_for_change/paused/stopped（§16.4）；范围版本表（§17）；会话与角色签发（§8）；health 扩展为 db/schema/outbox 检查 |
| **A2** | 证据存储与采集记录 | §5.2 §5.3 §5.4 §13 §11.2(blobs/captures) §8.3(证据读取) §18.3(完整依据层) | `lib/store/evidence.mjs`、`lib/store/layout.mjs`、`lib/routes/evidence.routes.mjs`、`test/evidence.test.mjs` | §13 写入顺序：staging→哈希校验→固定 `evidence/blobs/sha256/<ab>/<hash>`→库事务登记→回执；数据库不得引用未固定文件（EVIDENCE_NOT_COMMITTED）；Blob 不可变、内容寻址、去重不删采集历史；Capture 注明表示形式；EvidenceAnchor 绑定版本与解码（§5.4）；transforms 派生链；孤立 Blob 可识别；存储不可用不造假记录；`POST /evidence/blobs` 为 rawBody 路由（流式上传，自定上限）；`GET /evidence/blobs/{sha256}` 提供原始证据字节、`GET /captures/{id}` 提供采集详情（验证与完整依据层读取）；`lib/store/layout.mjs` 承担 §5.2 程序义务：assets/ 人可浏览逻辑目录（文件名映射处理非法字符与路径穿越、URL 冲突用资源编号消歧、最新版本入口标明采集编号、逻辑路径不承担证据身份）与 `work/<intent>/<attempt>/` 工作区 |
| **A3** | 工作台外壳与项目页 | §5.2 §20.2(视图) §16.4(状态视图) | `lib/ui/pages/overview.page.mjs`、`lib/ui/pages/projects.page.mjs`、`test/ui-shell.test.mjs` | 外壳契约已冻结（§2.6）；总览页=health/metrics/项目状态（metrics 端点 F2 前为 501，页面按「未实现」态呈现）；项目页=创建/列表/详情/范围版本/生命周期操作；未实现端点显示明确状态而非报错；中文文案 |

### 阶段 B：Map 与读取协议

> 规范 §21 原文：实现资产/探索投影、局部上下文、快照边界、变化页和动态订阅。
> 完成标准：每条视图内容可追到持久记录；快照加增量不丢消息；Map 可完全重建。

| 模块 | 名称 | 负责章节 | 独占文件 | 施工要点 |
|---|---|---|---|---|
| **B1** | 投影与记录读取 | §15.1–§15.4 §11.2(records/contexts) | `lib/store/projection.mjs`、`lib/store/records-read.mjs`、`lib/routes/snapshots.routes.mjs`、`test/projection.test.mjs` | Map 只投影、可完全重建；一致读视图 + 异步投影标注 commit_seq；快照接口同返 snapshot_commit_seq/content/subscription_id/subscription_revision/resume_cursor（§15.2，快照后从 S 重放，无间隙）——订阅边界经 §2.7 冻结签名 `openSubscriptionBoundary`（B2 实现）建立/更新，B1 不直接写 subscriptions 表；`GET /snapshots/{kind}` 的 kind 含 `planner_view`（§15.3 Planner 视图：分组资产骨架、活跃/受阻方向、等待验证线索、确认漏洞、覆盖缺口、预算与自上次规划以来的变化）；Worker 视图 1–2 跳 + 强制项（§15.4），超预算分层读取并明示未提供；折叠保留计数与展开入口 |
| **B2** | 变化页与订阅 | §14.2 §14.3 §15.2(订阅边界) §15.5 §11.2(changes/acks) | `lib/store/changes.mjs`、`lib/routes/changes.routes.mjs`、`test/changes.test.mjs` | Outbox 消费：路由/去重/重试/游标；变化页 events+next_cursor+high_watermark+has_more；不能跳过未处理事件推进；游标过期→CURSOR_EXPIRED+重同步；delivered≠applied（receipt_kind 分存）；动态订阅随新边扩展、强制通知（范围收缩/前提撤回/执行取消）；**必须导出** §2.7 冻结签名 `openSubscriptionBoundary`（B1 快照端点调用） |
| **B3** | 地图工作台页 | §15.1 §15.3 | `lib/ui/pages/assets.page.mjs`、`lib/ui/pages/exploration.page.mjs`、`test/ui-maps.test.mjs` | 渲染 asset-map/exploration-map 快照；标注 snapshot_commit_seq 与折叠省略；按编号经 /records/{id} 展开；不在前端改写路径/清洗规则 |

### 阶段 C：执行与及时写回

> 规范 §21 原文：实现意图、Attempt、租约、工具网关、执行中提交及恢复。
> 完成标准：worker 未结束时发现已经可被其他任务读取；中断不会丢失已提交成果或盲目重复未知操作。

| 模块 | 名称 | 负责章节 | 独占文件 | 施工要点 |
|---|---|---|---|---|
| **C1** | 意图与计划接收 | §10.1 §16.2 §11.2(plan-revisions) | `lib/store/intents.mjs`、`lib/routes/plans.routes.mjs`、`test/intents.test.mjs` | Intent 合同字段全量（§10.1）；状态机+历史；计划接收检查对象存在/范围有效/前提版本有效/依赖死锁（DEPENDENCY_CYCLE）；幂等接收；前提失效只拒绝或挂起受影响部分，不因无关新增废弃整计划（§20.3 场景 10）；完成建议检查必要产物，一句「完成」不关项目 |
| **C2** | 执行运行时与工具网关 | §10.2 §17 §3.2(程序保障) | `lib/store/attempts.mjs`、`lib/store/scope.mjs`、`lib/routes/attempts.routes.mjs`、`test/attempts.test.mjs`、`test/scope.test.mjs` | 条件领取（部分唯一索引）+ 心跳续租 + 单调 fencing token；过期阻止旧执行（LEASE_EXPIRED）并通知 Orchestrator；迟到提交留档不改新 Attempt、不再获工具权限（场景 17）；ToolCall planned→running→succeeded/failed/unknown，unknown 先检查再重试（场景 18）；范围版本化、拒绝优先、派发与动作前逐跳校验（§17）；用户停止立即生效、历史保留（场景 20）；子 agent 统一登记 |
| **C3** | 执行监控页 | §10 §20.2 | `lib/ui/pages/execution.page.mjs`、`test/ui-execution.test.mjs` | 队列/租约/工具调用状态视图；unknown 与受阻显式呈现；租约剩余时间展示 |

### 阶段 D：验证准入

> 规范 §21 原文：实现 Observation/Hypothesis/Fact/Vulnerability 分层、Verifier 权限、Manifest、证据版本检查和争议复核。
> 完成标准：发现者不能自行确认；新证据与旧确认竞争时不会覆盖最新依据。

| 模块 | 名称 | 负责章节 | 独占文件 | 施工要点 |
|---|---|---|---|---|
| **D1** | 验证服务与准入 | §8.3 §12 §11.2(verification-*) | `lib/store/verification.mjs`、`lib/routes/verification.routes.mjs`、`test/verification.test.mjs` | 验证请求含判断/条件/原始证据索引/反对证据/策略版本；去重键=判断+条件快照+策略版本+所审阅证据版本（§7.3）；**Manifest 服务**：按证据集版本生成不可变 `evidence_manifests`（成员/条件/判断版本/策略版本，§12.1），`reviewed_manifest_id` 外键绑定；verifier 经 `GET /evidence/blobs/{sha256}` / `GET /captures/{id}` 读取原始证据（§8.3）；§12.2 核心事务原子实现（校验→保存→事务内读三版本→匹配才应用→同事务 Outbox），状态转换经 §2.7 冻结签名 `applyStateTransition`（D2 唯一实现）应用；§12.3 五种竞争情形全测；仅 verifier 会话可交结果；发现者不得确认自己的判断（§8.3 硬约束，见 §8.3） |
| **D2** | 判断分层与漏洞状态机 | §8.1 §8.2 §8.4 §7.1 §7.2 §7.3 | `lib/store/judgements.mjs`、`lib/store/dedup.mjs`、`lib/routes/judgements.routes.mjs`、`test/judgements.test.mjs` | 四类语义边界（非同记录流水线；原观察永留；一观察多判断）；漏洞判断不得写 Fact 绕过验证；**§8.4 状态转换合同的唯一实现**：导出 §2.7 冻结签名 `applyStateTransition` 供 D1 的 §12.2 事务调用，全系统只有这一套状态机；confirmed≠持续存在；review 独立；候选组不替代漏洞身份、误合并可拆分；规范化版本化保留原始输入；模板可修正不丢样本；IP/域名经解析关系相连不合并 |
| **D3** | 验证与漏洞页 | §8 | `lib/ui/pages/verification.page.mjs`、`lib/ui/pages/vulnerabilities.page.mjs`、`test/ui-verification.test.mjs` | 验证队列（Manifest、outcome、等待时长）；漏洞台账（状态与复核状态分列、条件与证据入口）；中文文案不夸大状态 |

### 阶段 E：持续规划

> 规范 §21 原文：实现独立 Planner AI 与 Orchestrator AI、协调工具、持久计划与协调决定、分层汇报处理、深广回访安排和依赖恢复。
> 完成标准：确认漏洞后可生成后续意图；受阻方向可由 Orchestrator 根据新条件组织恢复；传输恢复无需盲目重做业务决定；无变化时不会无限空转。

| 模块 | 名称 | 负责章节 | 独占文件 | 施工要点 |
|---|---|---|---|---|
| **E1** | 协调服务与决定持久化 | §3.1 §3.3 §16.1 §16.3 §16.4 §18.5(接收端) §18.6 | `lib/store/orchestrator.mjs`、`lib/routes/orchestrator.routes.mjs`、`test/orchestrator.test.mjs` | §3.3 九工具全端点化（§5.2 映射）；决定+动作（独立幂等编号）持久化；重启逐项核对动作实际完成情况不盲目重放（场景 30）；回执只在决定持久化后 handled，delivered≠处理（场景 29）；overview 工作面板（§18.6，base_report 相对变化）；**深广回访与预算（§16.3）**：程序经 overview/plan-requests 供给资源用量、等待时长、重复尝试与验证积压信息，支持 AI 设置方向预算与并行限制；相同条件反复失败时把「继续/追问/换方法/暂缓/重规划」作为协调决定持久化，不写死固定流水线；确认漏洞可立即产生后续方向、以漏洞成立为前提的执行等待前提有效；受阻可检索/交接/恢复，不写死重试次数（场景 32）；唤醒信号与单规划在途（§16.1）；等待条件变化不空转（§16.4） |
| **E2** | 分层汇报服务 | §18.3 §18.4 §18.5 | `lib/store/reports.mjs`、`lib/routes/reports.routes.mjs`、`test/worker-reports.test.mjs` | 三层汇报；WorkerReport 字段=§18.3 合同；source_manifest+commit_boundary 时效；交接卡预算：分页/分组/展开入口，不删不确定性（场景 28）；程序覆盖检查（新漏洞/待验证/撤回/阻塞/unknown 必须列入或显式清单，否则退回，场景 26）；状态以库为准，suspected 不得写成 confirmed（场景 27）；重复投递不重复建分配；base_report 基线（场景 31） |
| **E3** | 协调面板页 | §18.6 | `lib/ui/pages/coordination.page.mjs`、`test/ui-coordination.test.mjs` | 工作面板视图：活跃计划/意图状态/未处理汇报/重要发现/待决事项/限制；按层展开汇报（交接卡→关键记录→完整依据） |

### 阶段 F：报告、运行观测与长期演练

> 规范 §21 原文：实现漏洞持续报告、阶段快照、覆盖缺口、运行指标及长时间恢复演练。
> 完成标准：从任何漏洞或事实都能追溯来源、执行、证据和后续方向；报告与 Map 状态一致且有版本边界。

| 模块 | 名称 | 负责章节 | 独占文件 | 施工要点 |
|---|---|---|---|---|
| **F1** | 报告服务 | §19 | `lib/store/reportgen.mjs`、`lib/routes/report-views.routes.mjs`、`test/reports.test.mjs` | suspected 起草稿、持续更新；确认版本/排除/争议同步当前视图、历史保留；阶段报告注明数据截止版本与时间；覆盖度按资产/功能/方向/身份条件记录；生成后探索继续（场景 22）；任何漏洞/事实可四向追溯（来源/执行/证据/后续） |
| **F2** | 运行观测与恢复 | §20.2 §18.1 §18.2 §20.3(末段端到端) §1(运行/等待分离) | `lib/store/metrics.mjs`、`lib/store/recovery.mjs`、`lib/routes/metrics.routes.mjs`、`test/recovery.test.mjs`、`test/e2e-lifecycle.test.mjs` | §20.2 指标全集；Checkpoint（§18.1，快照为派生资料、关键结论带编号引用）；恢复顺序七步（§18.2）；drill 端点做重启故障注入演练（场景 12/24）；waiting_for_change 不空转（场景 21）；`test/e2e-lifecycle.test.mjs` 承担 §20.3 末段的**端到端贯穿验收**：受控测试环境内验证「保存→派发→确认→恢复→再次规划」全链路（不依赖真实漏洞数量作为通过条件） |
| **F3** | 报告与覆盖度页 | §19 | `lib/ui/pages/reports.page.mjs`、`test/ui-reports.test.mjs` | 报告视图（当前+历史版本切换）；覆盖缺口展示；数据截止边界明示 |

**文件所有权核查**：同阶段内无重叠文件；跨阶段无重叠；共享文件全部在 §1.3 冻结清单。
前端测试文件分别命名为 `test/ui-*.test.mjs`，互不冲突。

---

## 4. b) DDL 清单（§6.2 全部逻辑表 + §6.3 全部约束与索引）

权威实现：`lib/db/migrations/0001-core-schema.mjs`（迁移 1，schema_version=1）。
下表逐行对应 §6.2 的 23 个逻辑表行 → 37 张物理表 + 2 张基表；多态引用（relations 端点、
basis_refs 等 TEXT JSON 数组）由 Record Service 校验存在性（INVALID_REFERENCE）。

### 4.1 §6.2 逻辑表 → 物理表

| §6.2 逻辑表 | 物理表 | 关键列（除 §6.1 通用字段外） |
|---|---|---|
| projects / scope_revisions | `projects`、`scope_revisions` | status∈{active,waiting_for_change,paused,stopped}；next_commit_seq；rules(JSON: allow/deny/pending) |
| goals | `goals` | parent_goal_id 自引用、statement、constraint_refs |
| assets / resources | `assets`、`resources` | asset_type+canonicalization_version+canonical_key；resources 保留 method/url_exact/scheme/host/port/path_exact/query_exact |
| endpoint_templates / template_members | `endpoint_templates`、`template_members` | status∈{candidate,confirmed,split,withdrawn}；member 保留 captured_from |
| captures / blobs / transforms | `captures`、`blobs`、`transforms` | blob.representation∈{raw_body,decoded_body,request_record,exchange_record,derived,uploaded_file}、storage_status、source_kind；capture.tool_call_id/condition_snapshot_id/integrity_status；transform 派生链五元组 |
| observations | `observations` | capture_id、anchor(EvidenceAnchor JSON)、statement、conditions |
| hypotheses | `hypotheses` | status∈{open,testing,supported,rejected,inconclusive} + claim_revision/evidence_revision/assessment_epoch |
| facts | `facts` | status∈{verified,disputed,superseded,retracted}、verification_refs + 三版本字段 |
| vulnerabilities | `vulnerabilities` | status∈{suspected,confirmed,falsified,inconclusive}、review∈{clear,pending,disputed}、location/category/impact/conditions/confirmed_version + 三版本字段 |
| candidate_groups / memberships | `candidate_groups`、`memberships` | group_key(asset+location+category)；member_kind+member_id |
| relations | `relations` | relation_type∈§9.1 九类 + duplicate_of/equivalent_to（§7.3）；conditions、requires_state、valid_from_seq、retracted_at |
| intents | `intents` | §10.1 全字段：kind∈{collect,investigate,verify,revisit}、status 九态、priority、budget、resume_conditions、plan_revision |
| attempts / tool_calls | `attempts`、`tool_calls` | attempt.assignment_id、fencing_token、lease_expires_at、status 七态；tool_call.status∈{planned,running,succeeded,failed,unknown,cancelled}、evidence_refs |
| verification_jobs / results | `verification_jobs`、`verification_results`、`evidence_manifests`（§12.1 支撑表，D1 维护） | job.dedup_key、expected_state_version/expected_evidence_revision/expected_assessment_epoch；result=§8.3 VerificationResult 全字段、applied；evidence_manifests 为不可变证据清单（subject+claim_revision+policy_version+evidence_revision+members+conditions+content_hash），job.evidence_manifest_id 与 result.reviewed_manifest_id 外键绑定（§12.1 reviewed_evidence_revision 必须绑定不可变 Manifest） |
| evidence_memberships | `evidence_memberships` | subject+member_kind+member_id、stance∈{supports,contradicts,neutral}、status∈{active,withdrawn,disputed} |
| submissions | `submissions` | submitter_id、request_digest、receipt、commit_seq、accepted_operations、warnings、result_hash |
| outbox / consumer_receipts | `outbox`、`consumer_receipts` | outbox=§14.1 Event 全字段 + delivery_status/attempts；receipts.receipt_kind∈{delivered,applied} |
| subscriptions | `subscriptions` | focus、relation_rules、scope、subscription_revision、last_cursor |
| snapshots / checkpoints | `snapshots`、`checkpoints` | snapshot.kind∈{asset_map, exploration_map, planner_view(§15.3), context, report}、snapshot_commit_seq、folding_notes；checkpoint.content(§18.1 字段)、processed_boundary |
| plan_runs / plan_revisions | `plan_runs`、`plan_revisions` | run.input_snapshot_id/input_boundary/status；revision.intents_created/updated、received_status∈{pending,accepted,partial,rejected,suspended} |
| orchestration_decisions / actions | `orchestration_decisions`、`orchestration_actions` | decision.input_report_ids/input_event_refs/rationale/tool_result；action.action_kind、idempotency_key、status、result |
| worker_reports / report_receipts | `worker_reports`、`report_receipts` | report=§18.3 WorkerReport 全字段（kind 四态、replaces/base、source_manifest_id、omitted_sections、delivery/handling_status）；receipt.receipt_kind∈{accepted,needs_clarification,deferred,coordinated} |
| report_revisions | `report_revisions` | report_kind∈{vulnerability,milestone}、subject_id、version、content_ref、data_boundary |
| （支撑表） | `id_sequences`、`schema_version` | 稳定编号分配；迁移版本（§6.3） |

### 4.2 §6.3 约束与索引 → DDL 对象（一一对应）

| §6.3 要求 | DDL 对象（0001 迁移） |
|---|---|
| assets：`(project_id, asset_type, canonicalization_version, canonical_key)` 唯一；并发创建靠约束 | `UNIQUE (project_id, asset_type, canonicalization_version, canonical_key)`；并发用 `INSERT … ON CONFLICT` 捕获，不先查后插 |
| submissions：`(project_id, submitter_id, submission_id)` 唯一，存请求摘要与回执 | `submissions` 表 + `UNIQUE (project_id, submitter_id, id)` + request_digest/receipt 列 |
| blobs：哈希唯一（存储权限域=项目），存字节数与表示 | `UNIQUE (project_id, sha256)` + byte_size + representation |
| captures：采集操作 ID 去重，不对 URL+Blob 建唯一 | `UNIQUE (project_id, tool_call_id)`；无 URL+Blob 唯一键（一次工具调用多表示时登记多个 tool_call） |
| relations：正反查索引；条件与历史不被通用去重键忽略 | `idx_relations_from (project_id, from_id, relation_type)`、`idx_relations_to (project_id, to_id, relation_type)`；表上**无** (from,to,type) 唯一约束 |
| evidence_memberships：对象×成员防重复；反对关系/条件变化仍算变更 | `UNIQUE (project_id, subject_id, member_kind, member_id)`；stance/status 变化经更新行实现（仍推进 evidence_revision） |
| outbox：event_id 唯一；`(project_id, commit_seq, event_index)` 与待发送状态索引 | `event_id TEXT PRIMARY KEY`；`idx_outbox_page`、`idx_outbox_pending`（部分索引 pending） |
| consumer_receipts：`(consumer_id, subscription_revision, event_id)` 唯一 | 复合主键 `PRIMARY KEY (consumer_id, subscription_revision, event_id)` |
| attempts：事务条件领取 + fencing token 保证单一有效执行者 | 部分唯一索引 `idx_attempts_active_assignment ON attempts(project_id, assignment_id) WHERE status IN ('leased','running')` + `UNIQUE (project_id, fencing_token)` + 服务层条件 UPDATE（心跳/续租） |
| intents：索引状态、优先级、可运行时间；相似性不做唯一 | `idx_intents_dispatch (project_id, status, priority, runnable_at)`、`idx_intents_status`；无相似性唯一键 |
| intents：索引「恢复条件」 | 恢复条件为 JSON 数组（TEXT）无法直接 B-tree，以**等效结构**落实：部分表达式索引 `idx_intents_resume ON intents(project_id, status) WHERE status IN ('blocked','deferred','obsolete') AND resume_conditions != '[]'`，加速「带未满足恢复条件的可恢复意图」检索（§10.1/§9.2） |
| 迁移有 schema_version；先处理历史冲突再启用新约束；不给旧线索补 confirmed | `schema_version` 表 + `lib/db.mjs` 迁移框架；0001 为初始全量，后续迁移编号顺延 |

---

## 5. c) API 注册表（§11.2 全部端点 + §3.3 协调工具映射 + §20.1 错误码）

### 5.1 端点全集（44 个；全部已预接线，未实装者返回 501 NOT_IMPLEMENTED）

前缀 `/sorne`；除标注外均为规范 §11.2 最小集的对应或其直接支撑。`§` 列为规范依据。

| # | 端点 | 归属 | § | 用途 |
|---|---|---|---|---|
| 1 | GET `/ui/manifest` | 冻结 | §2.6 | UI 页面清单 |
| 2 | GET `/ui/pages/{file}` | 冻结 | §2.6 | UI 页面模块源 |
| 3 | GET `/health` | A1 | §20.2 | 健康检查（骨架已实装基础版） |
| 4 | GET `/projects` | A1 | §6.2 | 项目列表 |
| 5 | POST `/projects` | A1 | §6.2 | 创建项目 |
| 6 | GET `/projects/{id}` | A1 | §6.2 | 项目详情 |
| 7 | POST `/projects/{id}/lifecycle` | A1 | §16.4 | 暂停/停止/恢复 |
| 8 | POST `/scope-revisions` | A1 | §17 | 新范围版本 |
| 9 | GET `/projects/{id}/scope` | A1 | §17 | 当前范围 |
| 10 | POST `/submissions` | A1 | §11.1 | 幂等提交（§11.2） |
| 11 | POST `/evidence/blobs` | A2 | §11.2 §5.3 §13 | 上传并固定 Blob（**rawBody 路由**：原始字节流式上传，不受 JSON 预读上限约束，A2 自定上限并落 staging） |
| 12 | POST `/captures` | A2 | §11.2 | 建立采集记录 |
| 13 | GET `/snapshots/{kind}` | B1 | §15.2 §15.3 | asset_map / exploration_map / **planner_view** 快照+订阅边界（经 §2.7 openSubscriptionBoundary） |
| 14 | GET `/records/{id}` | B1 | §11.2 | 按编号读记录与证据索引 |
| 15 | GET `/contexts/{intentId}` | B1 | §11.2 §15.4 | 任务快照与必要约束 |
| 16 | GET `/changes` | B2 | §11.2 §14.3 | 变化页 |
| 17 | POST `/consumer-acks` | B2 | §11.2 §14.3 | 持久确认消费结果 |
| 18 | POST `/subscriptions` | B2 | §15.5 | 建立动态订阅 |
| 19 | GET `/subscriptions/{id}` | B2 | §15.5 | 订阅边界与版本 |
| 20 | POST `/plan-revisions` | C1 | §11.2 §16.2 | 接收 planner 新意图/计划修订 |
| 21 | GET `/intents` | C1 | §10.1 | 意图列表（状态/优先级过滤） |
| 22 | POST `/attempts` | C2 | §3.3 §10.2 | 创建执行分配+租约 |
| 23 | GET `/attempts` | C2 | §10.2 | 队列与租约视图 |
| 24 | POST `/attempts/{id}/lifecycle` | C2 | §3.3 §10.2 | 暂缓/恢复/取消 |
| 25 | POST `/attempts/{id}/progress` | C2 | §11.2 | 进展/阻塞/完成建议 |
| 26 | POST `/tool-calls` | C2 | §10.2 §17 | 工具调用登记与执行（网关） |
| 27 | POST `/verification-requests` | D1 | §11.2 §8.3 | 请求独立验证（可先建 suspected） |
| 28 | POST `/verification-results` | D1 | §11.2 §12.2 | 仅验证身份可调用 |
| 29 | GET `/verification-jobs` | D1 | §8.3 | 验证队列视图 |
| 30 | GET `/vulnerabilities` | D2 | §8.2 | 漏洞台账视图 |
| 31 | GET `/orchestrator/overview` | E1 | §3.3 §18.6 | 工作概览 |
| 32 | POST `/orchestration-decisions` | E1 | §11.2 §3.3 | 保存协调决定与动作 |
| 33 | POST `/report-receipts` | E1 | §11.2 §3.3 | 汇报接收回执 |
| 34 | POST `/attempts/{id}/followups` | E1 | §3.3 §18.5 | 追问 worker |
| 35 | POST `/attempts/{id}/context` | E1 | §3.3 | 补充任务上下文 |
| 36 | POST `/plan-requests` | E1 | §3.3 §16.1 | 请求（重新）规划 |
| 37 | POST `/worker-reports` | E2 | §11.2 §18.3 | 提交分层汇报 |
| 38 | GET `/worker-reports/{id}` | E2 | §11.2 §18.3 | 按层读取汇报 |
| 39 | GET `/reports/vulnerabilities` | F1 | §19 | 漏洞报告视图 |
| 40 | GET `/reports/milestones` | F1 | §19 | 阶段报告视图 |
| 41 | GET `/metrics` | F2 | §20.2 | 运行指标 |
| 42 | POST `/recovery/drill` | F2 | §18.2 | 恢复演练触发 |
| 43 | GET `/evidence/blobs/{sha256}` | A2 | §8.3 §18.3 | 按哈希读取原始证据字节（验证与完整依据层） |
| 44 | GET `/captures/{id}` | A2 | §18.3 | 采集详情：请求/响应引用、条件快照与完整性状态 |

§11.2 的 15 个最小端点全部覆盖：#11、#12、#10、#27、#28、#20、#25、#37、#38、#32、
#33、#15、#14、#16、#17。#43/#44 为规范 §8.3（验证可以读取原始证据）与 §18.3
（完整依据层：执行记录、采集、请求响应、文件）在 API 面的落点。

### 5.2 §3.3 协调工具合同 → 端点映射（9/9）

| §3.3 工具能力 | 端点 |
|---|---|
| 读取工作概览 | GET `/orchestrator/overview`（#31） |
| 读取汇报或记录 | GET `/worker-reports/{id}`（#38）、GET `/records/{id}`（#14） |
| 分配执行 | POST `/attempts`（#22） |
| 补充任务上下文 | POST `/attempts/{id}/context`（#35） |
| 追问 worker | POST `/attempts/{id}/followups`（#34） |
| 暂缓、恢复或取消执行 | POST `/attempts/{id}/lifecycle`（#24） |
| 请求规划 | POST `/plan-requests`（#36） |
| 请求独立验证 | POST `/verification-requests`（#27） |
| 处理汇报 | POST `/report-receipts`（#33） |

协调决定持久化：`orchestration_decisions`（输入汇报/事件引用、理由、拟执行动作、工具
结果）+ `orchestration_actions`（每动作独立幂等编号）；重启后逐项核对，不盲目重放（§3.3）。

### 5.3 §20.1 错误码注册表（冻结于 `lib/errors.mjs`）

| 错误码 | 语义要点 | 主要产生端点 |
|---|---|---|
| INVALID_REFERENCE | 引用不存在的对象 | #10 及所有写端点 |
| SCOPE_DENIED | 目标在明确拒绝范围 | #26 及派发 |
| SCOPE_UNRESOLVED | 范围未判定/缺目标范围 | #26、#8 |
| EVIDENCE_NOT_COMMITTED | 引用未固定/未保存证据 | #12、#10 |
| IDEMPOTENCY_KEY_REUSED | 同 ID 不同内容 | #10、#32（动作幂等键） |
| STALE_STATE | expected_state_version 不匹配 | #10（修改型操作） |
| STALE_EVIDENCE | reviewed_evidence_revision 不匹配 | #28 |
| CLAIM_CHANGED | claim_revision/assessment_epoch 已推进 | #28、#10 |
| LEASE_EXPIRED | 租约过期/fencing token 失效 | #25、#26 |
| PRECONDITION_INVALID | requires 前提不满足 | #22、#26 |
| RESOURCE_LIMIT | 资源/预算上限 | #26、#22 |
| CURSOR_EXPIRED | 游标过期/订阅规则变化需重同步 | #16 |
| DEPENDENCY_CYCLE | 调度前提图成环 | #20 |

传输层码（非 §20.1）：TRUST_DENIED(403)、NOT_FOUND(404)、BAD_REQUEST(400)、
REQUEST_TOO_LARGE(413)、INTERNAL_ERROR(500)；施工期过渡码 NOT_IMPLEMENTED(501)。
错误信封必须带 retryable，提交已成功时带 receipt（§20.1）。

---

## 6. d) 事件目录（§14.1 必要事件全集 + 规范他处明确要求的事件）

Outbox `Event` 字段（§14.1 原文）：event_id、project_id、commit_seq、event_index、
event_type、subject_ids[]、changed_fields[]、cause_refs[]、producer_id、schema_version、
payload、created_at。payload 以编号和紧凑摘要为主，不放完整响应包。

| event_type | 依据 | 说明 |
|---|---|---|
| `asset.discovered` | §14.1 资产发现 | 新资产节点（含来源血缘） |
| `capture.completed` | §14.1 采集完成 | Capture 登记完成 |
| `resource.content_changed` | §14.1 相关内容变化 | 同 URL 新版本内容 |
| `observation.appended` | §14.1 观察/线索新增 | Observation 追加 |
| `hypothesis.proposed` | §14.1 观察/线索新增 | Hypothesis 建立/修订 |
| `evidence_set.revised` | §14.1 证据集变化 | evidence_revision 推进 |
| `verification.completed` | §14.1 验证完成 | VerificationResult 保存（含未应用意见） |
| `judgement.invalidated` | §14.1 判断失效 | superseded/retracted/推翻 |
| `intent.blocked` | §14.1 意图受阻 | 阻塞及原因 |
| `intent.completed` | §14.1 意图完成 | resolved（不含项目关闭语义） |
| `scope.revised` | §14.1 范围变更 | 新范围版本生效 |
| `resource_state.changed` | §14.1 资源状态变化 | 预算/容量/租约等资源状态 |
| `dependency.changed` | §9.2「产生依赖变化事件」 | requires 边失效/恢复（强制通知类） |
| `vulnerability.state_changed` | §8.4「发布确认事件」「发布修正事件」 | 状态转换（suspected→confirmed 等）与修正 |
| `orchestration.decision_recorded` | §3.3「每次协调决定持久保存」 | 决定+动作落库通知 |
| `worker_report.submitted` | §11.2「提交汇报通知」、§18.5 | 汇报持久化事件 |
| `plan.received` | §16.1/§16.2 唤醒与计划接收 | 计划被接收/部分接收/拒绝 |

投递语义（§14.2/§14.3）：至少一次 + 消费幂等（重复 event_id 不重复派发/不重复应用）；
delivered 与 applied 分开确认；变化页 next_cursor 覆盖已扫描区间。

---

## 7. e) 验收映射表（规范 §20.3 全部场景）

规范 §20.3 共 **32 行**场景（任务描述写「30 个」，以规范为准全量映射）。测试覆盖真实
事务与重启故障注入，不只用 mock（§20.3 末段）。

| # | §20.3 场景 | 主责 | 配合 | 测试（文件 · 用例名） |
|---|---|---|---|---|
| 1 | 两个 worker 同时提交同一个精确资产 | A1 | — | test/submissions.test.mjs · 并发提交同一精确资产得一节点两来源 |
| 2 | 同一提交因网络失败重复发送 | A1 | — | test/submissions.test.mjs · 重复发送返回原回执不重复建事件 |
| 3 | 同一 ID 配不同提交内容 | A1 | — | test/submissions.test.mjs · IDEMPOTENCY_KEY_REUSED 拒绝不覆盖 |
| 4 | 同 URL JS 内容变化 | A2 | B1 | test/evidence.test.mjs · 保留两版本旧行号锚点可读 |
| 5 | 两次响应仅 Token 不同 | A2 | — | test/evidence.test.mjs · 两份原始证据仍在派生 Diff 降噪 |
| 6 | 数字路径推断错误 | D2 | A2 | test/judgements.test.mjs · 模板拆分不丢样本与引用 |
| 7 | 同参数同类别出现不同问题 | D2 | — | test/judgements.test.mjs · 候选聚合不被迫合成一个漏洞 |
| 8 | verifier 审阅后新反对证据先提交 | D1 | A1 | test/verification.test.mjs · STALE_EVIDENCE 拒绝直接应用旧结论 |
| 9 | 确认后新相关证据提交 | D1 | A1 | test/verification.test.mjs · review=pending 且依赖不放行 |
| 10 | 新增无关备注导致全局版本变化 | A1 | D1 | test/submissions.test.mjs · 无关备注不推进 evidence_revision |
| 11 | 漏洞被推翻，但下游事实有独立证据 | D2 | D1 | test/judgements.test.mjs · 保留下游事实重查必要依赖 |
| 12 | 数据提交后通知前进程退出 | A1 | B2/F2 | test/submissions.test.mjs + test/recovery.test.mjs · 重启后 Outbox 补投递 |
| 13 | 快照生成期间出现新发现 | B1 | A1 | test/projection.test.mjs · 快照加增量无间隙 |
| 14 | 消费者重复收到事件 | B2 | — | test/changes.test.mjs · 重复 event 幂等不重复调度 |
| 15 | 折叠分支的前提失效 | B1 | C2 | test/projection.test.mjs · 折叠节点仍触发依赖处理 |
| 16 | 新资产通过新边关联旧任务 | B2 | — | test/changes.test.mjs · 动态订阅交给相关任务 |
| 17 | worker 租约过期后回报 | C2 | A1 | test/attempts.test.mjs · 证据留档不改新 Attempt 状态 |
| 18 | 工具执行中崩溃 | C2 | — | test/attempts.test.mjs · 记录 unknown 检查后再重试 |
| 19 | Worker 发现漏洞后上下文压缩 | A1 | D2 | test/submissions.test.mjs · 漏洞即时持久化后续意图可引用 |
| 20 | 用户停止或范围收缩 | C2 | A1 | test/scope.test.mjs · 后续动作被程序阻止历史保留 |
| 21 | 没有新方向且条件未变化 | F2 | E1 | test/recovery.test.mjs · 项目等待不无限重复任务 |
| 22 | 漏洞确认并生成报告 | D1 | E1/F1 | test/verification.test.mjs · 确认后项目继续 planner 可安排后续 |
| 23 | Blob 写入成功但事务失败 | A2 | A1 | test/evidence.test.mjs · 业务无半条引用孤立 Blob 可识别 |
| 24 | 数据库成功但 HTTP 回执丢失 | A1 | — | test/submissions.test.mjs · 同 submission_id 恢复回执 |
| 25 | 磁盘满或证据存储不可用 | A2 | — | test/evidence.test.mjs · 不创建无证据的成功记录工作受阻 |
| 26 | worker 汇报遗漏本次新增漏洞 | E2 | — | test/worker-reports.test.mjs · 覆盖检查退回或要求列明 |
| 27 | 摘要把疑似漏洞写为已确认 | E2 | — | test/worker-reports.test.mjs · 状态以库为准阻止升级 |
| 28 | 一批重要发现超出摘要预算 | E2 | — | test/worker-reports.test.mjs · 显式分组分页不静默截断 |
| 29 | 读完汇报但保存决定前中断 | E1 | — | test/orchestrator.test.mjs · 汇报恢复后仍待处理 |
| 30 | 多个动作部分执行后中断 | E1 | — | test/orchestrator.test.mjs · 逐项恢复不重复完成动作 |
| 31 | 新汇报依赖已不在上下文的旧汇报 | E2 | — | test/worker-reports.test.mjs · base_report 读基线 |
| 32 | worker 受阻但其他任务有相关信息 | E1 | — | test/orchestrator.test.mjs · 检索交接恢复不固定重试 |
| — | **端到端贯穿**（§20.3 末段）：受控测试环境验证「保存、派发、确认、恢复和再次规划」全过程，不依赖真实漏洞数量作为通过条件 | F2 | 全阶段模块 | test/e2e-lifecycle.test.mjs · 保存→派发→确认→恢复→再次规划全链路 |

---

## 8. f) 角色与权限模型

依据：§11.1（project_id、actor、角色权限由服务端会话决定，不能信任模型自报）、
§8.3（验证身份独立，发现者不能假冒 verifier）、§2.6（发现者不能自行确认自己的漏洞）、
§3.2（程序负责权限/前提/资源/租约，不替代 AI 判断）。

### 8.1 会话

- 会话由**程序**签发（运行时为每个 planner/orchestrator/worker/verifier 会话建立；
  UI 使用 `user` 会话），绑定 `{ session_token, project_id, actor, role }`；
  A1 实装 `lib/store/sessions.mjs` + 请求头承载；签发通道只对回环进程内可用，不经公网端点。
- 客户端与模型自报的 project_id/actor/role 一律忽略，以会话为准。

### 8.2 角色与权限矩阵

| 角色 | 可调用端点（§5.1 编号） | 可执行 submission 操作 | 绝对禁止 |
|---|---|---|---|
| planner | #36 由 E1 转交；#20 提交计划；#13/#14 只读 | plan/intent 类操作 | 直接改数据库；确认漏洞；扩大授权 |
| orchestrator | #31–#36、#27（发起验证）、#38、#14 只读 | 协调决定/动作/回执 | 绕过范围、证据准入、资源上限、独立验证 |
| worker | #11、#12、#10、#25、#37、#15、#14 只读、#26 经网关 | append_observation / propose_hypothesis / 建 suspected 漏洞 / 关系 | 自己确认漏洞；改共享 Map；越执行边界 |
| verifier | #28、#11/#12（范围内补采）、#14 只读 | verification 结果提交 | 扩展授权；无证据确认；用规划优先级替代真实性判断 |
| runtime（程序） | #22–#26、#17、租约维护 | 执行分配/租约/工具调用 | 自选探索方向；以固定剧本替代 AI 协调 |
| projection（程序） | 只读 + #13 快照生成 | — | 成为第二真值源 |
| user（UI） | #3–#9、#21、#23、#29、#30、#39–#42 及各只读视图 | 项目/范围/生命周期管理 | 代替验证流程改漏洞状态 |

### 8.3 硬约束（程序校验，测试必测）

1. **验证身份独立（§8.3/§2.6）**：`POST /verification-results` 仅 verifier 会话可调用；
   worker/发现者会话不得调用，也不能假冒 verifier 身份提交结果——独立性由**调用身份和
   服务权限**落实。
2. **发现者不得自证（§2.6）**：对同一判断，其**发现者（判断创建者，created_by）与
   应用型验证结果（supported→confirmed / falsified 应用）的提交者不得为同一 actor**；
   worker 的 submission 操作集中不含漏洞状态确认类操作，suspected→confirmed 只能由
   §12.2 核心事务在独立验证 supported + 版本匹配后应用。
3. **续验与复核不受 requested_by 限制（§7.3/§8.4）**：verifier 自发或受托发起的续验
   （新证据到来时请求续验）、falsified→重新调查路径中同 verifier 的新一轮验证，均属
   规范允许的独立验证；约束针对的是「发现者确认自己」，不针对验证请求的发起者身份。

---

## 9. g) UI 信息架构（9 页面，文案中文）

外壳与导航由冻结 `client.js` 提供；页面归各前端模块（§3）。每页数据来源端点如下：

| 页面（id / 标题） | 归属 | 数据来源端点 | 内容要点 |
|---|---|---|---|
| overview / 总览 | A3 | #3 /health、#41 /metrics、#4 /projects | 运行状态、指标卡、项目入口；运行状态与探索进展分开 |
| projects / 项目与范围 | A3 | #4–#9 | 创建/列表/详情、范围版本（允许/拒绝/待判断）、暂停/停止/恢复 |
| assets / 资产地图 | B3 | #13(asset_map)、#14 | 资产与来源拓扑；快照 commit_seq、折叠计数与展开 |
| exploration / 探索地图 | B3 | #13(exploration_map)、#14 | 方向、依据、漏洞与未解决问题 |
| execution / 执行与队列 | C3 | #23、#21 | 意图/尝试/租约/工具调用；unknown 与受阻显式呈现 |
| verification / 独立验证 | D3 | #29、#14 | 验证队列、Manifest、outcome 与等待时长 |
| vulnerabilities / 漏洞台账 | D3 | #30、#14 | 状态与复核状态分列；条件与证据入口 |
| coordination / 协调面板 | E3 | #31、#38 | 工作面板；按层展开汇报（交接卡→关键记录→完整依据） |
| reports / 报告与覆盖度 | F3 | #39、#40、#41 | 当前/历史报告版本、覆盖缺口、数据截止边界 |

UI 通用规则：未实装端点（501）呈现为「未实现」状态而非白屏；列表分页走游标不静默截断；
URL path 只展示不改写；授权类输入不落 localStorage。

---

## 10. h) 安装到 dsh 的步骤

### 10.1 安装（开发机）

1. 前置：Node ≥ 22.5；dsh（DeepSeek Harness）桌面版或本地宿主。
2. 将本目录作为插件接入 dsh（二选一，以所用 dsh 版本的实际机制为准）：
   - 开发链接：在 dsh 的插件/市场配置中指向本目录（参考实现使用
     `link:<插件绝对路径>` 的 sourceSpec 布局，安装后由 generation 清单反解）；
   - 或打包发布到 dsh 市场后安装。
3. 重启 dsh（`index.js` 半端在启动时注册 `/sorne` 前缀；改 `package.json` 需重装/重启）。
4. 客户端半端：`dsh.client.inject` 已在 `package.json` 声明，dsh web 平台加载 `client.js`
   并注入 `@deepseek-ai/dsh-client-runtime`；工作台出现在设置区「Sorne 持续探索工作台」。
5. 数据目录默认 `~/.sorne`（可用 `SORNE_DATA_DIR` 覆盖）。

### 10.2 无真实 dsh 的 UI 走查（冻结命令）

```bash
npm i --no-save react@18 react-dom@18   # 仅为测试宿主提供 React UMD，不进依赖树
npm run ui                                # 默认 http://127.0.0.1:8898/
```

宿主行为：mock ctx 调真实 `apply()` 挂 `/sorne/*` 路由；`/` 页面以 `__ModuleLoader__`
shim + React UMD 渲染真实 `client.js` 外壳与全部页面；数据目录为临时目录。
自动化用例可从控制台取 `window.__sorneTest__`（外壳内部组件）。

### 10.3 门禁

```bash
npm test   # check（全部源文件 node --check）+ node --test "test/*.test.mjs"
```

---

## 11. i) 各阶段完成标准（规范 §21 原文）

> 以下每条为规范原文引用；阶段验收 = 完成标准 + §7 验收映射表中该阶段主责场景全绿
> + 该阶段模块竣工记录齐备 + `npm test` 全绿。

- **阶段 A：持久记录和证据底座** —— 「实现 Blob、Capture、核心实体、关系、幂等提交与
  Outbox。完成标准：并发提交、重复请求和提交中断后数据可恢复，历史证据不被覆盖。」
- **阶段 B：Map 与读取协议** —— 「实现资产/探索投影、局部上下文、快照边界、变化页和
  动态订阅。完成标准：每条视图内容可追到持久记录；快照加增量不丢消息；Map 可完全重建。」
- **阶段 C：执行与及时写回** —— 「实现意图、Attempt、租约、工具网关、执行中提交及恢复。
  完成标准：worker 未结束时发现已经可被其他任务读取；中断不会丢失已提交成果或盲目重复
  未知操作。」
- **阶段 D：验证准入** —— 「实现 Observation/Hypothesis/Fact/Vulnerability 分层、Verifier
  权限、Manifest、证据版本检查和争议复核。完成标准：发现者不能自行确认；新证据与旧确认
  竞争时不会覆盖最新依据。」
- **阶段 E：持续规划** —— 「实现独立 Planner AI 与 Orchestrator AI、协调工具、持久计划
  与协调决定、分层汇报处理、深广回访安排和依赖恢复。完成标准：确认漏洞后可生成后续意图；
  受阻方向可由 Orchestrator 根据新条件组织恢复；传输恢复无需盲目重做业务决定；无变化时
  不会无限空转。」
- **阶段 F：报告、运行观测与长期演练** —— 「实现漏洞持续报告、阶段快照、覆盖缺口、运行
  指标及长时间恢复演练。完成标准：从任何漏洞或事实都能追溯来源、执行、证据和后续方向；
  报告与 Map 状态一致且有版本边界。」

阶段 A 的骨架前置自查（本蓝图定稿时）：DDL（§4）、迁移框架与串行事务（§2.3）、
幂等约束（submissions/blobs/captures 唯一键）、Outbox 表与索引、42 端点桩、会话/角色
模型（§8）、门禁与测试宿主（§10）均已就位；A1–A3 的**实现**仍属阶段 A 施工。

---

## 12. 施工流程与门禁

1. **领模块**：按阶段 A→F 顺序；同阶段最多 3 名工程师并行（§3 模块），各自只写独占文件。
2. **写码**：路由按 §2.2 放入自己的 `lib/routes/*.routes.mjs`；业务在 `lib/store/*.mjs`；
   前端页面按 §2.6；测试按 §1.2 并行安全规则。
3. **门禁**：`npm test` 必须全绿；该模块名下端点不再返回 NOT_IMPLEMENTED；
   §7 中主责场景有对应用例。
4. **竣工记录**：复制 `docs/modules/_TEMPLATE.md` 为 `<id>.md` 填写（含 `npm test`
   输出尾部原文粘贴）。
5. **冲突处理**：需要改冻结文件/蓝图 → 停工上报架构师；规范与蓝图冲突以规范为准并记录。
6. **阶段验收**：§11 完成标准 + 该阶段场景全绿 + 竣工记录齐备，由架构师确认后进入下一阶段。

---

## 13. 已知偏差与说明

1. `npm test` 使用 `node --test "test/*.test.mjs"` 而非 `node --test test/`：
   后者在 Node 22.23.2 将目录实参当模块执行（`MODULE_NOT_FOUND`），已实测；glob 语义等价。
2. `client.js` 注入插槽沿用参考实现的 `settings.section`（dsh 侧唯一有证据的插槽）；
   若真实 dsh 提供整页工作台插槽，只需改冻结 `client.js` 的 apply（一处）。
3. 工具网关首版以 HTTP 端点（#26）暴露；若 dsh `ctx.get("tools")` 桥接更合适（参考实现
   有此模式），在阶段 C 评审时决定，端点语义不变。
4. §20.3 实为 32 行场景（任务描述称 30），蓝图按规范全量映射。

## 14. 风险与待决（实施评审持续更新）

1. **dsh 真实宿主行为**：apply 是否接受异步、插槽清单、ModuleLoader 细节均从 dsh-mrecon
   参考实现推断；首次接入真实 dsh 联调时可能需要调整冻结文件（走 §12.5 变更流程）。
2. **node:sqlite 为实验特性**（Node 22.23.2 验证可用，引擎锁定 ≥22.5）；Node 大版本升级
   需回归 `npm test`。SQLite 单机串行写入满足 §5.1 首版；多实例部署需重新评估。
3. **会话签发载体**：进程内注册表（首版）与受控启动参数的取舍留给 A1 实现决策，
   §8 语义冻结。
4. **captures 以 tool_call_id 去重**：一次工具调用产生多个表示时需登记多个 tool_call
   （§6.3 直译；如实施评审认为需放宽为 (tool_call_id, representation) 复合键，走变更流程）。
5. **UI 测试宿主依赖本地 React UMD**（`npm i --no-save react@18 react-dom@18`），
   不进依赖树；未安装时宿主给出明确提示退出。
6. **§22 待实施评审配置**（规范原文清单）：历史迁移、部署形态、验证策略细节、并发与
   预算参数、资产类型与规范化迁移、用户展示入口——均不阻塞阶段 A–C 施工。
