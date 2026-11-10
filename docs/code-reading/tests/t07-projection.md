# t07 测试精读 —— 投影快照 / 读取视图 / 报告视图

> 静态精读（未运行 npm test）；行号为当前工作区文件。两个测试文件全部读过，关键断言原文核对。

## ① 文件与用例数

| 文件 | 行数 | 用例数 | 侧重点 |
|---|---|---|---|
| test/projection.test.mjs | 1018 | 17 | B1：快照合同/可重建/追溯/场景13 无间隙/场景15 折叠依赖/planner_view/worker_view/records/磁盘故障/鉴权/B2 集成 |
| test/reports.test.mjs | 929 | 18 | F1：§19 起草稿/版本同步（确认/排除/争议/噪声）/分页/阶段报告/覆盖度/四向追溯/鉴权/原子性/重启 |

合计 **35 用例**；node:test 顶层 `test()`，无 describe；文件间进程隔离。

## ② 锁定的行为清单

**投影（projection.test.mjs）**
- 快照合同（:293-327）：§15.1 八字段、订阅四元组（available/id/revision/resume_cursor）、
  `content_commit_seq >= snapshot_commit_seq`、snapshots 行与 `maps/` 三处文件（最新入口/snapshots/<id>/map.md）。
- 可完全重建（:349-380）：同库两次生成 + 真实重启（closeStore + 同目录重启）后 `planner_view.content` deepEqual。
- 可追溯（:387-410）：三 kind 视图内收集全部编号 → 逐条 `GET /records/{id}` 200 且 id 回等（跳过 EVT）。
- 场景 13（:442-543）：5 轮 ×（3 真实提交 + 2 快照）并发；逐快照断言三条不变量（内容视图≥边界、边界内资产全在、
  边界后资产必有 `asset.discovered` 事件），并显式断言不变量 3 至少被行使一次（:520-523），再经 `/change-log` 做增量重放校验。
- 场景 15（:547-613）：`fold_since` 强制折叠后 requires 前提仍全量出现在 `folded_dependencies`；真实撤回后
  边界后 `dependency.changed` 事件、新快照不再列该依赖、`/records` 可见 retracted_at、按展开入口 `unfold_fold_since` 可展开。
- planner_view 七要素（:617-670）与无基线（:672-688）；exploration_map 方向/判断/未解决/边（:692-713）；
  worker_view 1–2 跳 + 五类强制项、超跳数 prerequisite_refs 仍随附（:717-808）、超预算 `not_provided` 计数与库一致（:810-848）；
  records 各类型/证据索引（:868-946）；磁盘故障不发布半成品（:950-970）；鉴权 400/404（:972-995）；B2 边界默认装配（:999-1018）。

**报告（reports.test.mjs）**
- v1 起草稿字段全量（:257-309，含 trace 四向 key、data_boundary、version_record.changed_fields=["created"]）。
- 版本同步：确认→v2（:337-370，confirmed_version 绑定 resultId、applied=true、v1 仍可读）；排除→falsified 且 v1 保留（:431-450）；
  争议→review=disputed（:452-469）；无关提交不增殖 A、相关证据使 B 切 v2（:473-505，`sync.changed` 断言）；反对证据→v2 且 evidence_revision+1（:507-521）。
- 列表游标分页 + summary 不受分页影响（:523-546）；阶段报告边界恰为 `next_commit_seq-1`、读取不增殖、refresh 显式 v2（:550-587）；
  覆盖度四方向/身份条件/未覆盖标记（:589-672）；Fact 与执行四向追溯（:674-775）；跨项目隔离/鉴权/参数面（:779-847）；
  TRIGGER 原子性 + 恢复（:851-886）；重启后 v1 历史与阶段报告可读（:888-929）。

## ③ 替身 / 隔离 / 时钟

- 真实栈：`apply()`（mock ctx）+ 真实 dispatcher/HTTP、真实 SQLite、`mkdtemp`+`SORNE_DATA_DIR`（各自 `bootServer` 复刻 helpers.mjs:28-83，
  projection 的 bootServer 不删目录以支持重启，:58-90）；finally 关服/关库/删目录。无模型调用、无网络外联。
- 唯一生产代码钩子：无（projection 头注释 :13-15 声明已移除 `__installBoundaryOpenerForTests`；该历史缺口在 :512-519 文档化）。
- 并发：场景 13 用真实 `Promise.all` 交替提交与快照（非 mock 交错）。
- 直写夹具：projection `seedRows`（goals/intents/attempts/tool_calls/plan_runs/plan_revisions/vulns/facts，:141-231，注释称
  「对应端点属 C1/C2/E1，尚未实装」——但 C1/C2 已实装，现为绕过状态机的捷径）；reports 只用真实端点（意图迁移走
  `transitionIntent` 文档化入口，:652-654），唯一 DB 直写是 TRIGGER 注入（:860-863）。
- 时钟：无 fake timer；唯一性用 `Date.now()` 计数（reports:117），无 TTL/时间敏感断言。

## ④ 断言质量（过拟合 / 同义反复 / 放宽 / 假绿）

- **强项**：场景 13 是全仓最好的并发测试之一——不变量逐快照断言 + 「不变量 3 必须被行使」的自检（:520-523）+ 重放闭环；
  报告侧「边界 = next_commit_seq-1」精确断言（:561）、无关提交不增殖版本（:473-505）、TRIGGER 原子性（:851-886）。
- **复制实现缺陷的测试**：reports.test.mjs:251 的 `ORDER BY CAST(version AS INTEGER)` 与实现同源（`CAST('v2' AS INTEGER)`=0，
  排序退化为 rowid）；测试随后按 `rows[0]` 取 v1（:274-275/:366-374），故版本排序错误永远测不出来——P2「版本序」缺陷在测试中复刻。
- **过拟合/形状绑定**：快照不变量的 `shown` 只从 `content.groups[].assets/folded.sample_ids` 取（:486-493），视图结构一变即红；
  worker_view 断言依赖具体字段路径（:757-802）；报告断言绑定中文语义文案（:355/:447/:468）与精确对象形状（:290/:294/:644）。
- **弱断言**：
  - projection:312 `content_commit_seq >= snapshot_commit_seq`（实践中恒等，方向性检查几乎无约束力）；
  - projection:638 与 reports:638 式 `assert.equal(x, true)` 写法；reports:426 `assert.equal(ongoing_total>=1, true)`；
  - reports:774 `by_status.planned>=1 || running>=1`——注册后状态应为 planned，析取式放宽；
  - reports:851 用例标题称「恢复后孤立文件被回收」，但只断言行数与 v2 内容，未断言 v2 文件被同号重写/无多余文件（标题超出断言）。
- **被放宽的夹具（跨文件复现）**：reports.test.mjs:782-783 与 worker-reports.test.mjs:945-947 同样用 `{withScope:false}`
  规避「A1 createProject 跨项目 SR 编号冲突」，但 record-service.mjs:1160-1162 已改 `_global` 序列——注释过期、
  第二项目带初始范围的路径长期无测试覆盖。
- **可能的假绿**：projection 场景 13 不变量 1 的两边来自同一落盘流程（恒成立），真正约束在 2/3；重建用例只比对 `planner_view`
  的 `content`，未比对 asset_map/exploration_map 与 markdown。

## ⑤ 覆盖缺口

- 投影：`exploration_map`「超限显式省略计数」（头注释 :9 声称覆盖）实际只断言 `omitted===0`（:707），省略路径未行使；
  planner_view/探索图的折叠桶上限、`projection_scope` 过滤、订阅 `subscription_revision` 递增与 `resume_cursor` 边界值均未断言；
  `snapshots` 的 context/report kind、`records` 的其它类型（tool_calls/worker_reports/verification_*）未逐类覆盖；
  三 kind 的可重建性只测 planner_view；worker_view 只测 `max_chars=2000` 一档、未测 hops=1 默认。
- 报告：阶段报告并发 refresh 版本槽（实现无重试，会 500）未测；TRIGGER 注入只覆盖 vulnerability 分支，milestone 分支
  「失败留不可回收孤立目录」未测；漏洞报告内联折叠上限（64/100）与资产上限 100 未测；`report_revisions` 版本乱序/恢复场景未测；
  Fact trace 的 origin/execution/evidence 只断言 key 存在（:699-701），内容未验。
- 共同：两文件各自复刻 `bootServer`，与 helpers.mjs 漂移风险；无 `SORNE_AGENT_TICK_MS`/runtime 交互断言（本层属 B1/F1，可接受）。

## ⑥ 与实现文件映射

| 测试 | 实现 |
|---|---|
| projection.test.mjs | lib/store/projection.mjs（快照内容/折叠/planner_view/worker_view）、lib/store/changes.mjs `openSubscriptionBoundary`（§2.7 冻结签名）、lib/store/records-read.mjs（/records）、lib/routes/snapshots.routes.mjs（#13/#15）、lib/store/layout.mjs（maps/ 落盘） |
| reports.test.mjs | lib/store/reportgen.mjs（`syncVulnerabilityReports`/`generateMilestoneReport`/`buildSubjectTrace`/指纹与文件写入）、lib/routes/report-views.routes.mjs（#39/#40）、lib/store/verification.mjs（策略/结果 D1）、lib/store/intents.mjs `transitionIntent`（C1 存储级入口）、lib/store/layout.mjs `projectDir` |

> 结论：两文件质量高于同批平均（真实注入与不变量设计到位）；主要风险是「测试复刻实现排序缺陷」
> （reports:251）与「过期 A1 缺陷规避」两处系统性假绿，以及 exploration_map 省略路径的覆盖声明不实。

