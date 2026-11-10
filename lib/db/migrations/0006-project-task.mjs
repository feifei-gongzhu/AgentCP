/**
 * 0006 —— projects.task：创建项目时显式记录「测试任务」，与 name/description（测试目标）分开。
 * 规范 §6.1 要求持久对象字段稳定；把任务写进 description 会丢失语义，故加列。
 */
export const version = 6;
export const description = "projects.task：项目级测试任务字段（M3 创建项目）";

export function up(db) {
  db.exec("ALTER TABLE projects ADD COLUMN task TEXT NOT NULL DEFAULT ''");
}
