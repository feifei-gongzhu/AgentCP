# 画像队列 SQLite 化（Schema V7）迁移说明

## 背景

V7 之前，"哪些 URL 还没画像完"存在两份并行状态源：

- `profile_state.json`（`pending_seed_urls` / `completed_seed_urls` /
  `needs_review_attempts` / `*attempted_run_id`）——URL 级增量队列；
- SQLite `profile_tasks`（按资产端点、`UNIQUE(asset_id)`）——端点级任务。

端点级表无法表达同一资产下多个 URL 的独立进度（同主机 `/a`、`/b` 会被
合并），调度器需要手工缝合两条车道（`legacy_pending + asset_pending`）。

## V7 数据模型

| 表 | 职责 |
|---|---|
| `enterprise_assets` / `profile_tasks` | 资产身份与端点级汇总（保留兼容） |
| `profile_work_items` | URL 工作项：`canonical_url + purpose(collect/review) + task_version` 为逻辑身份；status/attempts（按用途独立）/last_dispatch_run_id（Run 栅栏）/last_error/completed_at/legacy_source |
| `profile_work_item_sources` | 同一工作项的多来源历史（多来源不生成多份同用途待办） |
| `profile_dispatches` | 工作项×Job 派发回执（UNIQUE 保证重放不重复计数） |
| `profile_postprocess_receipts` | 按 Job 幂等的画像结果后处理回执 |
| `profile_migration_meta` | 旧 JSON 导入标记 + 迁移报告（计数/冲突/输入摘要） |

关键语义：

- **Run 栅栏只作用于增量与复核**（`last_dispatch_run_id`，SQL 显式处理
  NULL）；基础画像允许同一 Run 内多轮补充。
- **业务尝试在派发事务中计一次**（`enqueue_profile_job_atomic`：工作项
  置 dispatched + attempts+1 + Job 创建同一事务）；Job 技术重试与结果
  重放不重复扣预算。
- `consumed` 状态仅迁移使用：旧队列已消费但无结果佐证，不计成功、不在
  迁移后自动重跑；`add_work_items` 可显式重新激活。
- 旧 JSON 队列字段成为迁移前归档；`queue_incremental_profile_urls` 等
  旧入口委托 SQLite（单一写路径），`profile_state.json` 只保留基础阶段
  统计（`baseline_passes` 等控制阶段，不拥有待办身份）。

## 迁移执行

- **Schema（DDL）**：`ControlDatabase.initialize` 在打开旧库时自动升级
  到 V7（只建新表，不动旧数据）。
- **数据导入（应用层）**：`AssetInventory.migrate_legacy_profile_state()`
  读取 `profile_state.json` → 复用现有 URL 规范化与范围判定 → 写入工作项
  → 数据与 `profile_migration_meta` 标记同一事务原子提交；重复执行幂等
  （标记存在即返回既有报告）。`prepare_run` / `sync_declared_targets`
  自动触发；迁移标记缺失时 `enqueue_profile_job_atomic` 拒绝派发。
- 手动执行（演练/排查）：`.venv/bin/python -c "from src.sorne.store import
  ProjectStore; from src.sorne.asset_inventory import AssetInventory;
  print(AssetInventory(ProjectStore('项目名')).migrate_legacy_profile_state())"`

## 备份与回滚

- 迁移前用 `sorne backup 项目名 输出.zip`（SQLite backup API + 校验）。
- **回滚单位 = 代码 + 数据库 + 相关文件的组合**：仅回滚 Git commit 不会
  回滚数据库。失败时保持服务停止、保存失败现场，恢复匹配备份组合后再启动。
- 若新版本已接受新的业务写入，先保存新增数据再制定恢复方案，不要直接
  覆盖为迁移前备份。

## 实际迁移记录（klook，2026-09-23）

- 备份：`backup_project` 243 文件、86 committed 事件，恢复演练通过
  （隔离目录恢复 + FK/quick_check 干净）。
- 演练（klook-mig-drill 副本）：imported_pending=2、imported_completed=9、
  imported_consumed=0、imported_review=1、merged=0、skipped=0、conflicts=0；
  重跑幂等；同 URL 双用途并存验证（`affsrv/health` collect=completed +
  review=exhausted）。
- 真实迁移：与演练逐项一致；服务以新代码重启后 `/readyz` 报
  schema_version=7、outbox 无积压。
