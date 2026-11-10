# t09 测试精读 —— 分层汇报 / 项目生命周期 / 导出 / 探索启动

> 静态精读结论（未运行 npm test，避免污染环境）；行号均为当前工作区文件。
> 7 个测试文件全部打开读过，关键断言按原文核对。

## ① 文件与用例数

| 文件 | 行数 | 用例数 | 侧重 |
|---|---|---|---|
| test/worker-reports.test.mjs | 1035 | 20 | E2 #37/#38 覆盖检查/幂等/事件/三层读取/鉴权 |
| test/multi-project.test.mjs | 320 | 2 | 0004 全局序列/多项目编号不撞/迁移抬基线 |
| test/projects-crud.test.mjs | 54 | 1 | 项目创建（含初始范围）与删除（confirm/清库/清文件） |
| test/projects-summary.test.mjs | 132 | 1 | #4 summary 五列 + 游标分页 + 旧形体兼容 |
| test/report-export.test.mjs | 116 | 2 | #53 导出（生成→导出同源/历史版本/跨项目/缺文件） |
| test/explore-start.test.mjs | 140 | 3 | #48 未配置 409 / reload 后建 plan_run / 生命周期约束 |
| test/asset-map-templates.test.mjs | 146 | 1 | asset_map 快照 endpoint_templates 维度 |

合计 **30 个用例**；全部为 node:test 顶层 `test()`（无 describe 分层），文件间按 node --test 进程隔离。

## ② 锁定的行为清单（按模块/场景）

**E2 分层汇报（worker-reports.test.mjs）**
- 覆盖检查五类缺口都「先拒后收」：new_vulnerability :229-278、pending_hypothesis :280-303、
  unknown_tool_call :305-330、C2 blocked 进展行 :332-376、retraction（fact+raw retracts 边）:378-421。
  退回 = 422 `PRECONDITION_INVALID` + `detail.missing` 命中具体编号，且 worker_reports/submissions 均不落行（:242-247）。
- 满足路径三类：important_findings（:250-258）、omitted_sections 分类清单+read_pointer（:267-277）、
  blockers/unresolved_questions/significant_attempts 的结构化引用（:321-329/:354-357/:413-420）。
- 状态以库为准：声明 confirmed 而库为 suspected → 422 `STALE_STATE`+`detail.db_status/declared_status`（:433-442）；
  读取面 `key_records.important_findings[].db.status` 与交接卡渲染取库当前值（:459-473）；类型标错 → 400（:476-492）。
- 交接卡预算：budget=500 逐页翻到 has_more=false，30 条语句/条件/矛盾在页并集内（:533-558）；budget 可调（:560-564）；越界 400（:565-566）。
- base_report：`relative_to_base` 三集合、include_base 基线全文、基线 handling_status=pending（:606-617）；幽灵基线 422（:619-625）。
- 幂等/事件/原子性/重启：同 submission_id 原回执（idempotent/result_hash，:643-649、:930-934）、不重复落库/发事件/建分配（:650-658）、
  改内容 → `IDEMPOTENCY_KEY_REUSED`（:660-665）；事件 payload 含 covered_record_ids/source_manifest_id（:688-698）；
  TRIGGER RAISE 全回滚且同 ID 可重交（:849-897）；重启后可读+重交原回执（:902-937）。
- 鉴权：无会话/非 worker/非本人/跨项目 Attempt（:951-971）；GET 跨项目 404、缺 project_id 400、user 面只读 200（:986-995）。
- completion 不改意图/尝试（:811-828）；C2 进展行降级视图（:830-845）；replaces 保留旧行（:998-1035）。

**多项目编号（multi-project.test.mjs）**：3 个项目各自快照 SUBS/范围 SR/提交 A,O,H,V,R,EM/派发 ATT,ASM/汇报 WR/工具 TC
全部 200 且跨项目编号唯一（:67-194）；fencing 每项目首 token=2（:191-193）；0004 迁移对 v1→v3 历史库抬基线并续号（:198-315）。

**项目生命周期/摘要**：创建记录 name/description/task + 初始范围 allow（projects-crud:27-39）；删除缺 confirm → 422，
带 confirm 后清库/清 `projects/<id>` 目录/再读 404（:41-53）；summary 五列计数与最近进展、limit=1 游标两页、旧形体外加字段不混入（projects-summary:95-129）。

**导出**：`#40 refresh=1` 生成 MR- 后 `#53` 返回 text/markdown+attachment，含数据截止边界与漏洞编号（report-export:57-77）；
`version=v1` 可导出历史、`v9` → 404（:79-87）；跨项目/未知 id 404、删除内容文件 → 404+note（:91-115）。

**探索启动**：未配置 → 409 `LLM_NOT_CONFIGURED`+next_requirements 指向设置端点、项目仍可读（explore-start:47-62）；
PUT 设置后 `reload.started=true`，explore-start 建 `PR-` plan_run（in_flight），重复调用 deduped 同一 run（:64-106）；
stopped → 422 需 resume，waiting_for_change → 开始后 active（:108-140）。

**资产模板维度**：asset_map 的 `endpoint_templates` 分 candidate/confirmed、`{n}` 数字折叠、expand 入口、
split 后被拆模板折叠为计数且新 candidate 出现（asset-map-templates:94-145）。

## ③ 测试替身 / 隔离 / 时钟手法

- 真实栈：`apply()`（mock ctx）+ 真实 dispatcher + 真实 SQLite + `listen(0)` 随机端口 + `mkdtemp`+SORNE_DATA_DIR（helpers.mjs:19-93）。
  worker-reports 自建 `bootServer/withServer` 复刻同一套并额外支持「关服+closeStore+同目录重启」（:59-110）。
- 唯一模型替身：explore-start 的本地 OpenAI 兼容 stub（explore-start:20-31，固定 choices，用毕即关）；存储/事务/路由零 mock。
- 时钟：无 fake timers、无时钟注入；唯一性靠 `Date.now()+counter`（worker-reports:112-113）；迁移用真实时间戳与手工库。
- 直写夹具（绕生产写路径，均有注释）：retracted fact+retracts 边（worker-reports:396-405）、漏洞状态演进（:461）、
  summary 的受阻意图与未处理汇报行（projects-summary:82-93）、报告内容文件删除（report-export:110）。
- 会话为进程内注册表：重启用例在 phase2 重签会话（worker-reports:923-925）；`SORNE_DATA_DIR` 进出保存/恢复（:60-70、helpers:30-31/77-78）。

## ④ 断言质量（过拟合 / 同义反复 / 被放宽 / 假绿）

- **强项**：负例与正例成对（422→修正→200）、副作用计数（`countRows`，:246-247/:650-658）、
  事件 payload 逐字段（:688-698）、真实 TRIGGER 回滚、重启幂等 `result_hash` 相等（:930-934）、跨项目 404 不泄露。
- **过拟合/文案绑定**：`match(.../按已加载数据推导/)`（projects-summary:109）、`/建议/`（worker-reports:791）、
  导出 Markdown 中文标题（report-export:71-73）、`{n}` 折叠词表（asset-map-templates:111）——实现改文案即红，且不证明语义。
- **弱断言/近同义反复**：asset-map-templates:144 `includes("资产组") || markdown.length > 0` 恒真；
  report-export:85 `/v1|版本：v1/` 过宽；worker-reports:826 仅 `attempt.status !== "completed"`（interrupted 也会过，
  应断言具体状态集）；worker-reports:277 显式清单路径只断言 `judgement_records>=2`，未断言具体缺口被清单覆盖。
- **被放宽的夹具（重要）**：worker-reports:945-947 为 project B 传 `{withScope:false}`，注释称「A1 createProject 的 SR
  项目内序列导致同库第二带范围项目跨项目主键冲突——A1 既有缺陷」；但 record-service.mjs:1160-1162 已改用
  `GLOBAL_SEQ_SCOPE`（0004 迁移）。该规避与注释已过期：掩盖的是**已修复**缺陷，副作用是「第二个项目带初始范围」路径不再被覆盖。
- **假绿风险**：(a) report-export:62/70 的「同源」只比较视图↔导出（两者同读一份 content 文件），未与
  `report_revisions.data_boundary` 行比对，属部分同义反复；(b) boundary 时效用例（worker-reports:725-759）用
  omitted_sections 兜底，无法区分清单窗口是否为空——实现侧 boundary=0 即可使窗口为空、覆盖检查空转，测试察觉不到；
  (c) C2 进展行用例只查 #38 视图（:830-845），未断言 runtime/diagnostics 的「未处理汇报」计数是否把进展行算入；
  (d) 触发器用例断言 500（:873-874），钉住的是错误映射而非业务语义。

## ⑤ 覆盖缺口

- 分层汇报：`important_findings` 缺省（当前实现 :532 会 500）、boundary 下界/0、sha256 形式 evidence_refs、
  page 越过总页数（实现静默夹取）、单组自身超预算、并发同 submission_id。
- 生命周期：仅 stop/resume；缺 pause、删除项目时活跃执行/跨项目数据保留、delete 幂等。
- 导出：只覆盖阶段报告（MR-）；缺漏洞报告（RR-）导出、version 形态非法（`vX`）400、并发 refresh 版本槽。
- 探索启动：缺项目不存在 404、非 user 会话 403、resume 之后**成功**启动（现用例只断言 denied）、paused 态、
  waiting 下 dedupe 与新建的区分。
- 多项目：迁移用例钉 `schemaVersion>=7`（multi-project:264），新增迁移即需改测试；未覆盖跨进程 fencing 唯一域。
- 摘要/模板：各 1 个用例，无空项目、`last_activity_at` 时序、withdrawn 折叠、样本上限、markdown 精确形态。

## ⑥ 与实现文件映射

| 测试 | 主要实现 |
|---|---|
| worker-reports.test.mjs | lib/store/reports.mjs（形状 :403-463、幂等 :478-490、boundary :520-530、状态 :531-551、清单/覆盖 :235-399、落库回执 :608-745、三层视图 :770-1037）+ lib/routes/reports.routes.mjs（鉴权 #37/#38 :28-102） |
| multi-project.test.mjs | lib/db/migrations/0004 + record-service `GLOBAL_SEQ_SCOPE/allocateSeq`（:160-191）+ intents/attempts/subscriptions 各取号点 |
| projects-crud / projects-summary | record-service `createProject/deleteProject`（:1160-1213 起）+ lib/routes/projects.routes.mjs（#4 summary/#5/#6/删除） |
| report-export.test.mjs | lib/store/reportgen.mjs（生成 :1054-1098、导出读取 :1302-1319、Markdown :1391-1428）+ lib/routes/report-export.routes.mjs |
| explore-start.test.mjs | lib/store/explore.mjs + lib/routes/llm.routes.mjs（#50-52）+ runtime.reload + diagnostics #49 |
| asset-map-templates.test.mjs | lib/store/projection.mjs（asset_map）+ lib/store/dedup.mjs（propose/revise_endpoint_template）+ lib/routes/snapshots.routes.mjs |

