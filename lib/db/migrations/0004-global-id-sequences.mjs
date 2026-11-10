/**
 * 0004 —— 全局格式实体编号改由全局序列分配（规范 §6.1/§6.3）。
 *
 * 背景：0001 的所有业务表 id 是全局 TEXT PRIMARY KEY，而编号分配一直按
 * (project_id, kind) 项目作用域取号。凡编号形如 `PREFIX-nnnn`（不内嵌项目
 * 编号）的实体——A/O/H/V/F/R/EM/SR/SUBS/ATT/TC/WR/ASM——每个新项目的首笔
 * 写入都会复用 2 号，与第一个项目撞全局主键（第二个项目起快照/范围版本/
 * 提交必然 UNIQUE constraint failed）。修复后这类编号统一从
 * `id_sequences ('_global', kind)` 取号（与项目编号 PRJ 的既有做法一致）；
 * 编号内嵌项目编号的实体（EVT-/B-/CAP-/I-/SNAP-/WR-<PRJ>-… 等）与唯一域
 * 为 (project_id, …) 的 fencing token 仍用项目作用域，不受本迁移影响。
 *
 * §6.3 迁移要求：先处理历史数据再启用新约束——历史库中不可能存在重复 id
 * （撞主键的写入在当时已失败回滚），因此无需清洗行数据；只需把全局序列
 * 基线抬到「历史已用最大号 + 1」（同时不低于各项目原序列水位，防止重发
 * 已消耗过的号），历史编号全部保留、不改写映射。
 */
export const version = 4;
export const description =
  "全局格式实体编号（A/O/H/V/F/R/EM/SR/SUBS/ATT/TC/WR/ASM）改由 _global 序列分配并按历史数据抬升基线";

/** 全局序列作用域（与 lib/store/record-service.mjs 的 GLOBAL_SEQ_SCOPE 一致）。 */
const GLOBAL_SCOPE = "_global";

/** 需要迁移到全局序列的（kind → 历史行扫描）清单：表、列、编号前缀。 */
const GLOBAL_FORMAT_KINDS = [
  // 项目编号本就使用 _global 序列；一并抬基线可覆盖「手工恢复/搬移的库缺
  // _global 行」的情形（否则首个 createProject 会与历史 PRJ-0002 撞主键）。
  { kind: "project", table: "projects", column: "id", prefix: "PRJ" },
  { kind: "asset", table: "assets", column: "id", prefix: "A" },
  { kind: "observation", table: "observations", column: "id", prefix: "O" },
  { kind: "hypothesis", table: "hypotheses", column: "id", prefix: "H" },
  { kind: "vulnerability", table: "vulnerabilities", column: "id", prefix: "V" },
  { kind: "fact", table: "facts", column: "id", prefix: "F" },
  { kind: "relation", table: "relations", column: "id", prefix: "R" },
  { kind: "membership", table: "evidence_memberships", column: "id", prefix: "EM" },
  { kind: "scope_revision", table: "scope_revisions", column: "id", prefix: "SR" },
  { kind: "subscription", table: "subscriptions", column: "id", prefix: "SUBS" },
  { kind: "attempt", table: "attempts", column: "id", prefix: "ATT" },
  { kind: "tool_call", table: "tool_calls", column: "id", prefix: "TC" },
  { kind: "worker_report", table: "worker_reports", column: "id", prefix: "WR" },
  { kind: "assignment", table: "attempts", column: "assignment_id", prefix: "ASM" },
];

export function up(db) {
  for (const { kind, table, column, prefix } of GLOBAL_FORMAT_KINDS) {
    // 历史行中该前缀「裸全局格式」编号的最大序号（PREFIX-nnnn；内嵌项目的
    // PREFIX-<PRJ>-nnnn 形态不属此序列域，正则天然排除）。
    const rows = db.prepare(`SELECT ${column} AS id FROM ${table}`).all();
    let maxUsed = 1;
    const re = new RegExp(`^${prefix}-(\\d+)$`);
    for (const row of rows) {
      const m = typeof row.id === "string" ? re.exec(row.id) : null;
      if (m) maxUsed = Math.max(maxUsed, Number(m[1]));
    }
    // 各项目原序列水位（取号可能因回滚留下空洞，水位不低于已用最大号）。
    const seq = db
      .prepare("SELECT MAX(next_val) AS n FROM id_sequences WHERE kind = ? AND project_id != ?")
      .get(kind, GLOBAL_SCOPE);
    const nextVal = Math.max(maxUsed + 1, (seq && seq.n) || 1, 2);
    db.prepare(
      `INSERT INTO id_sequences (project_id, kind, next_val) VALUES (?, ?, ?)
       ON CONFLICT (project_id, kind) DO UPDATE SET next_val = MAX(next_val, excluded.next_val)`,
    ).run(GLOBAL_SCOPE, kind, nextVal);
  }
}
