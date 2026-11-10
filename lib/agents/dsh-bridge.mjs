/**
 * dsh 工具桥接（蓝图 §13.3 遗留项的落地；参考实现 dsh-mrecon 的同型模式）。
 *
 * 宿主经 ctx.get("tools").register() 允许插件向**宿主会话的模型**暴露工具。
 * 本桥接只注册只读工具（sorne_*）：宿主对话 AI 可读取 Sorne 工作台状态，
 * 但一切变更仍必须经各角色端点与权限面（§11.2：外部页面/JS/工具输出作为
 * 数据处理，不修改系统角色权限或范围规则）。
 * fs/tools 不可用时仅跳过注册（同参考实现），不影响插件其它能力。
 */
import { getProjectDetail, listProjects } from "../store/record-service.mjs";
import { generateSnapshot } from "../store/projection.mjs";
import { getRecord } from "../store/records-read.mjs";
import { readChangeLog } from "../store/changes.mjs";
import { listVerificationJobs } from "../store/verification.mjs";

function okRender(args, value) {
  return [{ type: "text", text: JSON.stringify(value, null, 2) }];
}

/**
 * registerDshTools(hostCtx, pctx)：宿主无 tools 服务时静默跳过。
 * 返回 { registered: string[], dispose() }（dispose 注销已注册工具）。
 */
export function registerDshTools(hostCtx, pctx) {
  let tools = null;
  try {
    tools = hostCtx && typeof hostCtx.get === "function" ? hostCtx.get("tools") : null;
  } catch {
    tools = null; // 宿主无该服务（蓝图 §14.1：真实宿主行为待联调，不强求）
  }
  if (!tools || typeof tools.register !== "function") {
    return { registered: [], dispose() {} };
  }

  const defs = [
    {
      name: "sorne_projects",
      description: "列出 Sorne 持续探索工作台的项目（编号/名称/状态）。只读，不触发任何执行。",
      parameters: { type: "object", properties: {}, required: [] },
      output: { schema: { type: "array", items: { type: "object", additionalProperties: true } }, render: okRender },
      async execute() {
        return (await listProjects(pctx)).projects.map((p) => ({ id: p.id, name: p.name, status: p.status }));
      },
    },
    {
      name: "sorne_overview",
      description: "读取某项目的规模观测（资产/观察/假设/漏洞计数与 Outbox 积压）。只读。",
      parameters: {
        type: "object",
        properties: { project_id: { type: "string", description: "项目编号（PRJ-…）" } },
        required: ["project_id"],
      },
      output: { schema: { type: "object", additionalProperties: true }, render: okRender },
      async execute(args) {
        return getProjectDetail(pctx, String(args.project_id || ""));
      },
    },
    {
      name: "sorne_planner_view",
      description:
        "读取某项目的 Planner 视图快照（§15.3：分组资产骨架、活跃/受阻方向、等待验证线索、确认漏洞、覆盖缺口）。只读。",
      parameters: {
        type: "object",
        properties: {
          project_id: { type: "string" },
          kind: { type: "string", enum: ["asset_map", "exploration_map", "planner_view"], description: "快照种类（默认 planner_view）" },
        },
        required: ["project_id"],
      },
      output: { schema: { type: "object", additionalProperties: true }, render: okRender },
      async execute(args) {
        const kind = args.kind || "planner_view";
        const view = await generateSnapshot(pctx, {
          projectId: String(args.project_id || ""),
          kind,
          actor: "dsh-bridge",
        });
        return {
          snapshot_id: view.snapshot_id,
          snapshot_commit_seq: view.snapshot_commit_seq,
          subscription: view.subscription ?? null,
          content: view.content,
        };
      },
    },
    {
      name: "sorne_record",
      description: "按编号读取 Sorne 持久记录与证据索引（A-…/O-…/H-…/V-…/CAP-… 等）。只读。",
      parameters: {
        type: "object",
        properties: { project_id: { type: "string" }, id: { type: "string", description: "记录编号" } },
        required: ["project_id", "id"],
      },
      output: { schema: { type: "object", additionalProperties: true }, render: okRender },
      async execute(args) {
        return getRecord(pctx, { projectId: String(args.project_id || ""), id: String(args.id || "") });
      },
    },
    {
      name: "sorne_change_log",
      description: "按游标读取某项目的事件流（只读视图：业务变化的 Outbox 事件，不写投递回执）。",
      parameters: {
        type: "object",
        properties: {
          project_id: { type: "string" },
          after: { type: "string", description: "上一页 next_cursor（log:<seq>:<idx>；省略则从头）" },
          limit: { type: "integer", description: "页大小（默认 20）" },
        },
        required: ["project_id"],
      },
      output: { schema: { type: "object", additionalProperties: true }, render: okRender },
      async execute(args) {
        const page = await readChangeLog(pctx, {
          projectId: String(args.project_id || ""),
          after: typeof args.after === "string" && args.after ? args.after : null,
          limit: Number.isInteger(args.limit) ? args.limit : 20,
        });
        return {
          events: page.events,
          next_cursor: page.next_cursor,
          has_more: page.has_more,
          read_only: page.read_only,
        };
      },
    },
    {
      name: "sorne_verification_jobs",
      description: "列出某项目的独立验证任务与最新结论（§8.3 队列视图）。只读。",
      parameters: {
        type: "object",
        properties: { project_id: { type: "string" } },
        required: ["project_id"],
      },
      output: { schema: { type: "object", additionalProperties: true }, render: okRender },
      async execute(args) {
        return listVerificationJobs(pctx, { projectId: String(args.project_id || ""), limit: 20 });
      },
    },
  ];

  const registered = [];
  const disposers = [];
  for (const def of defs) {
    try {
      const dispose = tools.register(def);
      registered.push(def.name);
      if (typeof dispose === "function") disposers.push(dispose);
    } catch {
      // 宿主注册失败不阻断其余工具（蓝图 §14.1 真实宿主差异）
    }
  }
  return {
    registered,
    dispose() {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          /* 宿主侧注销失败由宿主治理 */
        }
      }
    },
  };
}
