/**
 * A1 —— 健康检查路由（蓝图 §5 端点 #3；规范 §20.2 视图侧基础）。
 *
 * 阶段 A 竣工形态：在基础版本之上扩展为
 *   - db：受控句柄可打开、schema_version；
 *   - outbox：pending / sent / failed / skipped / total（积压可见，§20.2 Outbox 积压）；
 *   - projects / sessions：规模观测。
 * 任一存储检查失败时 ok=false 并带错误说明，不用「发生错误」掩盖状态（§20.1 精神）。
 * 归属模块：A1（幂等提交与统一记录服务）。
 */
import { getStore } from "../store/record-service.mjs";
import { activeSessionCount } from "../store/sessions.mjs";

export const routes = [
  {
    method: "GET",
    path: "/sorne/health",
    async handler(pctx) {
      const base = {
        ok: true,
        service: "sorne",
        version: pctx.version,
        checked_at: new Date().toISOString(),
      };
      try {
        const store = await getStore(pctx);
        const db = store.db;
        const rows = db
          .prepare("SELECT delivery_status AS s, COUNT(*) AS c FROM outbox GROUP BY delivery_status")
          .all();
        const outbox = { pending: 0, sent: 0, failed: 0, skipped: 0, total: 0 };
        for (const r of rows) {
          outbox[r.s] = r.c;
          outbox.total += r.c;
        }
        return {
          ...base,
          db: { ok: true, schema_version: store.schemaVersion },
          outbox,
          projects: db.prepare("SELECT COUNT(*) AS c FROM projects").get().c,
          sessions: { active: activeSessionCount() },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        try {
          pctx.logger.warn(`[sorne] /health 存储检查失败: ${message}`);
        } catch {
          /* 测试宿主可能没有 logger */
        }
        return { ...base, ok: false, db: { ok: false, error: message } };
      }
    },
  },
];
