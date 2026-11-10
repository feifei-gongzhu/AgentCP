/**
 * B2 —— 变化页与订阅（Event Dispatcher 的消费面）。
 *
 * 规范落点：
 *   - §11.2：GET /changes（按消费者权限读取变化页）、POST /consumer-acks（持久确认消费结果）；
 *   - §14.2 至少一次投递与幂等效果：重复投递允许（redelivered 标记 + 至少一次重读），
 *     重复 event_id 不重复应用（consumer_receipts 复合主键去重；已 applied 的事件不再投递）；
 *     「网络已发出」≠「消费者已处理」——投递确认（delivered）由服务端在变化页事务内写入，
 *     业务处理确认（applied）仅经 POST /consumer-acks 在消费者提交处理结果后写入；
 *     模型消费者必须以已保存的计划/执行结果为前提再确认（阶段 E 调用方合同，本模块
 *     不替 AI 判断「已处理」，只提供回执机制与前提校验）；
 *   - §14.3 游标：不透明 token（订阅号+订阅版本+(commit_seq,event_index)）；过滤流跳过
 *     无关事件但 next_cursor 覆盖已扫描区间；消费不得跳过未处理事件直接推进（applied
 *     确认不得越过未投递事件/未扫描区间）；每个消费者独立游标（订阅行 last_cursor +
 *     按消费者的回执）；变化页返回 events/next_cursor/high_watermark/has_more；历史游标
 *     过期或订阅规则改变 → CURSOR_EXPIRED + 明确重同步要求（取得新快照及边界后续读）；
 *   - §15.2 订阅边界（冻结签名 openSubscriptionBoundary，B1 快照端点调用）：
 *     在一致读视图（runSerial 串行事务）内建立或更新订阅边界并推进 subscription_revision，
 *     返回 { subscription_id, subscription_revision, resume_cursor, snapshot_commit_seq }；
 *   - §15.5 动态订阅：订阅以关注节点种子为基础，随新边扩展（relation.added 事件带端点信息；
 *     与已关注节点有边相连的新资产事件不被过滤）；范围收缩（scope.revised）、前提撤回
 *     （dependency.changed）与执行取消/资源状态变化（resource_state.changed，含用户停止）
 *     属强制通知，无视 focus.event_types 过滤投递。
 *
 * 程序侧只做规范交给程序的保障（权限、前提、资源上限、幂等、可靠投递、原子性）；
 * 事件对任务的意义、是否追问/重规划等判断留给 AI 角色（§3.2）。
 *
 * 内部状态存放说明（冻结 DDL 无新增列，见竣工记录）：subscriptions.focus 在调用方
 * focus 之外附加保留键 `_sorne_state`（边界序号 / 扫描区间 / 种子与动态扩展集），
 * 对外视图一律剥离该键。
 */
import { createHash } from "node:crypto";

import { apiError } from "../errors.mjs";
import { closeStore as _closeStore, getStore, GLOBAL_SEQ_SCOPE, RELATION_TYPES } from "./record-service.mjs";

export { _closeStore as closeStoreForTest };

/* ── 常量与目录 ───────────────────────────────────────────────────── */

/** §15.5 强制通知事件类型（范围收缩/前提撤回/资源与执行状态变化）。 */
export const FORCED_EVENT_TYPES = Object.freeze([
  "scope.revised",
  "dependency.changed",
  "resource_state.changed",
]);

/** §15.5 新边事件类型（A1 落地；payload.endpoints 携带两端点）。 */
export const RELATION_ADDED_EVENT = "relation.added";

/** 可建立/消费订阅的角色（蓝图 §8.2：user 面不参与消费流；GET /subscriptions/:id 另放行只读）。 */
export const CONSUMER_ROLES = Object.freeze([
  "planner",
  "orchestrator",
  "worker",
  "verifier",
  "runtime",
  "projection",
]);

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;
/** 单次变化页最多扫描的事件数（资源上限，§3.2 程序保障；到顶即 has_more=true）。 */
export const MAX_SCAN_PER_PAGE = 5000;
/** focus.subject_ids 上限（资源上限）。 */
export const MAX_FOCUS_SUBJECTS = 500;
/** 单条 SQL IN 列表分块大小（SQLite 参数上限保守值）。 */
const SQL_CHUNK = 100;
/** 变化页扫描的原始批大小。 */
const SCAN_BATCH = 500;

const STATE_KEY = "_sorne_state";
const SUBSCRIPTION_ID_RE = /^SUBS-\d+$/;

/* ── 基础工具 ─────────────────────────────────────────────────────── */

function sha256Hex(text) {
  return createHash("sha256").update(text).digest("hex");
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

/** 位置比较：a/b 为 [commit_seq, event_index]。 */
function posGt(a, b) {
  return a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);
}
function posGe(a, b) {
  return a[0] > b[0] || (a[0] === b[0] && a[1] >= b[1]);
}

/** 游标 token：c:<订阅号>:<订阅版本>:<commit_seq>:<event_index>（§14.3 等价不透明 token）。 */
function encodeCursor(subscriptionId, revision, pos) {
  return `c:${subscriptionId}:${revision}:${pos[0]}:${pos[1]}`;
}

function parseCursor(token) {
  if (typeof token !== "string") return null;
  const m = /^c:([^:]+):(\d+):(\d+):(\d+)$/.exec(token);
  if (!m) return null;
  return {
    subscriptionId: m[1],
    revision: Number(m[2]),
    position: [Number(m[3]), Number(m[4])],
  };
}

/** 校验 token 属于该订阅且版本未过期（§14.3：过期/规则变化 → CURSOR_EXPIRED）。 */
function assertCursorFor(db, projectId, sub, token) {
  const parsed = parseCursor(token);
  if (!parsed) {
    throw apiError("BAD_REQUEST", `游标格式非法：${String(token).slice(0, 80)}`);
  }
  if (parsed.subscriptionId !== sub.id) {
    throw apiError("BAD_REQUEST", `游标不属于订阅 ${sub.id}（游标订阅：${parsed.subscriptionId}）`);
  }
  if (parsed.revision !== sub.subscription_revision) {
    throw apiError(
      "CURSOR_EXPIRED",
      `游标属于订阅版本 ${parsed.revision}，当前版本已推进到 ${sub.subscription_revision}（订阅规则变化或快照边界更新），不得直接续读（§14.3）`,
      {
        detail: {
          cursor_subscription_revision: parsed.revision,
          current_subscription_revision: sub.subscription_revision,
        },
        next_requirements: [
          "重新取得快照与订阅边界（GET /snapshots/{kind} 或 POST /subscriptions 更新），以新 resume_cursor 从快照边界之后续读",
          "被跳过区间由新快照内容覆盖，不得沿用旧游标或猜测边界",
        ],
      },
    );
  }
  // 保留底线检查（commit_seq 粒度）：游标所在提交序号早于项目现存最早事件的提交序号
  // → 该区间事件可能已不在保留范围，历史游标过期（首版不清理 outbox，此守卫在启用
  // 清理后自动触发；event_index 粒度不比较，避免快照边界 token (s,0) 被误判）。
  const floor = db
    .prepare("SELECT MIN(commit_seq) AS c FROM outbox WHERE project_id = ?")
    .get(projectId);
  if (floor && typeof floor.c === "number" && parsed.position[0] < floor.c) {
    throw apiError("CURSOR_EXPIRED", "游标早于事件保留底线，历史事件已不可续读，需重新同步（§14.3）", {
      next_requirements: ["以新快照与订阅边界重新同步后续读"],
    });
  }
  return parsed;
}

/** §15.5 强制通知判定（导出供测试与后续模块核对）。 */
export function isForcedNotification(event) {
  return FORCED_EVENT_TYPES.includes(event.event_type);
}

/* ── focus 规范化与内部状态 ───────────────────────────────────────── */

function normalizeFocus(focus) {
  const src = focus === undefined || focus === null ? {} : focus;
  if (typeof src !== "object" || Array.isArray(src)) {
    throw apiError("BAD_REQUEST", "focus 必须是 JSON 对象（§15.5：关注对象与关系规则）");
  }
  if (Object.prototype.hasOwnProperty.call(src, STATE_KEY)) {
    throw apiError(`BAD_REQUEST`, `focus 不得携带保留键 ${STATE_KEY}（内部状态由服务端维护）`);
  }
  const out = {
    subject_ids: [],
    event_types: [],
    relation_types: [],
    consumer_id: null,
    intent_id: null,
    kept: {},
  };
  for (const [k, v] of Object.entries(src)) {
    if (v === undefined || v === null || v === "") continue;
    switch (k) {
      case "subject_ids": {
        if (!Array.isArray(v)) throw apiError("BAD_REQUEST", "focus.subject_ids 必须是字符串数组");
        if (v.length > MAX_FOCUS_SUBJECTS) {
          throw apiError("RESOURCE_LIMIT", `focus.subject_ids 超过上限 ${MAX_FOCUS_SUBJECTS}`);
        }
        out.subject_ids = [...new Set(v.map(String))];
        for (const s of out.subject_ids) {
          if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(s)) {
            throw apiError("BAD_REQUEST", `focus.subject_ids 成员格式非法：${s}`);
          }
        }
        break;
      }
      case "event_types": {
        if (!Array.isArray(v)) throw apiError("BAD_REQUEST", "focus.event_types 必须是字符串数组");
        out.event_types = [...new Set(v.map(String))];
        break;
      }
      case "relation_types": {
        if (!Array.isArray(v)) throw apiError("BAD_REQUEST", "focus.relation_types 必须是字符串数组");
        for (const t of v) {
          if (!RELATION_TYPES.includes(t)) {
            throw apiError("BAD_REQUEST", `focus.relation_types 含未知关系类型：${t}（§9.1/§7.3 目录）`);
          }
        }
        out.relation_types = [...new Set(v)];
        break;
      }
      case "consumer_id": {
        const s = String(v);
        if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(s)) {
          throw apiError("BAD_REQUEST", "focus.consumer_id 格式非法");
        }
        out.consumer_id = s;
        break;
      }
      case "intent_id": {
        const s = String(v);
        if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(s)) {
          throw apiError("BAD_REQUEST", "focus.intent_id 格式非法");
        }
        out.intent_id = s;
        break;
      }
      default:
        out.kept[k] = v; // 调用方（B1 等）自有字段原样保留
    }
  }
  return out;
}

function normalizeRelationRules(rules) {
  if (rules === undefined || rules === null) return [];
  if (!Array.isArray(rules)) throw apiError("BAD_REQUEST", "relation_rules 必须是数组");
  const types = [];
  for (const r of rules) {
    if (typeof r === "string") {
      if (!RELATION_TYPES.includes(r)) {
        throw apiError("BAD_REQUEST", `relation_rules 含未知关系类型：${r}`);
      }
      types.push(r);
      continue;
    }
    if (r && typeof r === "object" && Array.isArray(r.types)) {
      for (const t of r.types) {
        if (!RELATION_TYPES.includes(t)) {
          throw apiError("BAD_REQUEST", `relation_rules 含未知关系类型：${t}`);
        }
        types.push(t);
      }
      continue;
    }
    throw apiError("BAD_REQUEST", "relation_rules 成员必须是类型字符串或 { types: [...] }");
  }
  return [...new Set(types)];
}

function normalizeScope(scope) {
  if (scope === undefined || scope === null) return {};
  if (typeof scope !== "object" || Array.isArray(scope)) {
    throw apiError("BAD_REQUEST", "scope 必须是 JSON 对象");
  }
  return scope;
}

/** 订阅身份键：focus（规范化）+ scope 的内容摘要（openSubscriptionBoundary 的「建立或更新」判定）。 */
function boundaryKeyOf(focusNorm, scopeNorm) {
  return sha256Hex(
    canonicalJson({
      focus: {
        ...focusNorm.kept,
        subject_ids: [...focusNorm.subject_ids].sort(),
        event_types: [...focusNorm.event_types].sort(),
        relation_types: [...focusNorm.relation_types].sort(),
        consumer_id: focusNorm.consumer_id ?? "",
        intent_id: focusNorm.intent_id ?? "",
      },
      scope: scopeNorm,
    }),
  );
}

function seedsOf(focusNorm) {
  const seeds = new Set(focusNorm.subject_ids);
  if (focusNorm.intent_id) seeds.add(focusNorm.intent_id);
  return [...seeds];
}

/** 行内 focus JSON（含内部状态）。 */
function focusJsonOf(focusNorm, state) {
  const publicFocus = {
    ...focusNorm.kept,
    subject_ids: focusNorm.subject_ids,
    event_types: focusNorm.event_types,
    relation_types: focusNorm.relation_types,
  };
  if (focusNorm.consumer_id) publicFocus.consumer_id = focusNorm.consumer_id;
  if (focusNorm.intent_id) publicFocus.intent_id = focusNorm.intent_id;
  publicFocus[STATE_KEY] = state;
  return JSON.stringify(publicFocus);
}

function rowFocus(row) {
  try {
    const parsed = JSON.parse(row.focus);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function rowState(row, focusNormFallback) {
  const raw = rowFocus(row)[STATE_KEY];
  if (
    raw &&
    typeof raw === "object" &&
    typeof raw.boundary_seq === "number" &&
    Array.isArray(raw.scan_from) &&
    Array.isArray(raw.scan_through) &&
    Array.isArray(raw.seeds) &&
    Array.isArray(raw.grown) &&
    typeof raw.boundary_key === "string"
  ) {
    return raw;
  }
  // 防御性重建（行数据异常时不扩大故障，按当前 focus 重派生种子）
  return {
    boundary_key: "",
    boundary_seq: 0,
    scan_from: [0, 0],
    scan_through: [0, 0],
    seeds: seedsOf(focusNormFallback || normalizeFocus({})),
    grown: [],
  };
}

/* ── 订阅行读取与视图 ─────────────────────────────────────────────── */

function loadSubscriptionRow(db, subscriptionId) {
  if (typeof subscriptionId !== "string" || !SUBSCRIPTION_ID_RE.test(subscriptionId)) {
    throw apiError("BAD_REQUEST", `订阅号格式非法：${subscriptionId}`);
  }
  const row = db.prepare("SELECT * FROM subscriptions WHERE id = ?").get(subscriptionId);
  if (!row) {
    throw apiError("NOT_FOUND", `订阅不存在：${subscriptionId}`);
  }
  return row;
}

/** 访问校验（§11.2：所有读写都校验项目与对象访问权；变更流仅消费者本人）。 */
function guardSubscription(session, row, { requireConsumer = true } = {}) {
  if (session.project_id !== row.project_id) {
    throw apiError(
      "TRUST_DENIED",
      `会话项目 ${session.project_id} 与订阅 ${row.id} 所属项目 ${row.project_id} 不一致，拒绝访问（§11.2）`,
    );
  }
  if (requireConsumer && session.actor !== row.consumer_id) {
    throw apiError(
      "TRUST_DENIED",
      `订阅 ${row.id} 的变化流仅其消费者 ${row.consumer_id} 本人可读取或确认（会话 actor=${session.actor}）`,
    );
  }
}

function subscriptionView(row) {
  const focus = rowFocus(row);
  const state = rowState(row);
  const publicFocus = { ...focus };
  delete publicFocus[STATE_KEY];
  return {
    id: row.id,
    project_id: row.project_id,
    consumer_id: row.consumer_id,
    status: row.status,
    focus: publicFocus,
    relation_rules: JSON.parse(row.relation_rules || "[]"),
    scope: JSON.parse(row.scope || "{}"),
    subscription_revision: row.subscription_revision,
    resume_cursor: encodeCursor(row.id, row.subscription_revision, [state.boundary_seq, 0]),
    last_cursor: row.last_cursor,
    snapshot_commit_seq: Math.max(0, state.boundary_seq - 1),
    watch: { seeds: state.seeds.length, grown: state.grown.length },
    created_at: row.created_at,
    created_by: row.created_by,
    updated_seq: row.updated_seq,
  };
}

/** GET /subscriptions/:id（#19）：订阅边界与版本（只读视图，项目内会话可读）。 */
export async function getSubscriptionView(pctx, { session, subscriptionId }) {
  const store = await getStore(pctx);
  const row = loadSubscriptionRow(store.db, subscriptionId);
  guardSubscription(session, row, { requireConsumer: false });
  return { subscription: subscriptionView(row) };
}

/* ── 变化流只读视图（工作台可达性；§14.3/§15.2 的读取面） ──────────── */

/** 项目作用域只读游标：log:<commit_seq>:<event_index>（无消费者语义，不写回执）。 */
function parseLogCursor(token) {
  const m = /^log:(\d+):(\d+)$/.exec(String(token));
  if (!m) return null;
  return [Number(m[1]), Number(m[2])];
}

/** 裸位置（兼容 <seq>:<idx> 形态，如快照夹具的 resume_cursor）。 */
function parseBarePosition(token) {
  const m = /^(\d+):(\d+)$/.exec(String(token));
  if (!m) return null;
  return [Number(m[1]), Number(m[2])];
}

/**
 * 变化流只读视图（GET /change-log）：把 §14.3 变化页的底层 Outbox 按项目呈现给
 * 工作台（user 面）。与消费者面 GET /changes（#16）的区别由设计保证：
 *   - 不写 delivered 回执、不推进 outbox 投递状态、不改订阅的 last_cursor/
 *     扫描区间/动态扩展集——查看不等于消费（§14.2/§14.3）；
 *   - 游标是项目作用域的 log:<seq>:<idx> 只读位置，也接受快照 resume_cursor
 *     （c:…）与订阅参数作起始边界（§15.2「从边界之后重放」的可视化）；
 *   - 不做 focus 过滤（呈现项目全部事件）；delivered/applied 仍只能由订阅
 *     消费者本人经 #16/#17 推进（蓝图 §8.2：user 面不参与消费流）。
 */
export async function readChangeLog(pctx, { projectId, subscriptionId, after, limit }) {
  if (typeof projectId !== "string" || !projectId.trim()) {
    throw apiError("BAD_REQUEST", "readChangeLog 需要 projectId");
  }
  const store = await getStore(pctx);
  return store.runSerial((db) => {
    const project = db.prepare("SELECT id FROM projects WHERE id = ?").get(projectId);
    if (!project) {
      throw apiError("NOT_FOUND", `项目不存在：${projectId}`);
    }

    // 订阅边界锚点（可选）：只读视图不要求请求者是订阅消费者（§11.2 项目访问权）
    let sub = null;
    let start = [0, 0];
    if (typeof subscriptionId === "string" && subscriptionId) {
      const row = loadSubscriptionRow(db, subscriptionId);
      if (row.project_id !== projectId) {
        throw apiError(
          "TRUST_DENIED",
          `订阅 ${subscriptionId} 不属于项目 ${projectId}，拒绝跨项目读取（§11.2）`,
        );
      }
      sub = subscriptionView(row);
      start = [rowState(row).boundary_seq, 0];
    }

    if (typeof after === "string" && after) {
      const parsed = parseLogCursor(after) || parseBarePosition(after) || parseCursor(after);
      if (!parsed) {
        throw apiError(
          "BAD_REQUEST",
          `游标格式非法：${after.slice(0, 80)}（允许 log:<seq>:<idx>、订阅游标 c:… 或 <seq>:<idx>）`,
        );
      }
      const pos = Array.isArray(parsed) ? parsed : parsed.position;
      const tokenSub = parseCursor(after);
      if (tokenSub && typeof subscriptionId === "string" && subscriptionId && tokenSub.subscriptionId !== subscriptionId) {
        throw apiError("BAD_REQUEST", `游标不属于订阅 ${subscriptionId}（游标订阅：${tokenSub.subscriptionId}）`);
      }
      start = pos;
    }

    const pageLimit = Math.max(
      1,
      Math.min(MAX_PAGE_LIMIT, Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_PAGE_LIMIT),
    );
    const rows = db
      .prepare(
        `SELECT * FROM outbox WHERE project_id = ? AND (commit_seq > ? OR (commit_seq = ? AND event_index > ?))
           ORDER BY commit_seq, event_index LIMIT ?`,
      )
      .all(projectId, start[0], start[0], start[1], pageLimit + 1);
    const hasMore = rows.length > pageLimit;
    const page = rows.slice(0, pageLimit);
    const lastPos = page.length
      ? [page[page.length - 1].commit_seq, page[page.length - 1].event_index]
      : start;
    const high = db
      .prepare(
        "SELECT commit_seq AS c, event_index AS i FROM outbox WHERE project_id = ? ORDER BY commit_seq DESC, event_index DESC LIMIT 1",
      )
      .get(projectId);
    return {
      project_id: projectId,
      read_only: true,
      subscription: sub,
      after_position: { commit_seq: start[0], event_index: start[1] },
      events: page.map(parseEventRow),
      next_cursor: `log:${lastPos[0]}:${lastPos[1]}`,
      high_watermark: high ? { commit_seq: high.c, event_index: high.i } : { commit_seq: 0, event_index: 0 },
      has_more: hasMore,
      note:
        "只读视图：不写投递回执、不改订阅游标；delivered/applied 仅订阅消费者本人经 GET /changes 与 POST /consumer-acks 推进（§14.2/§14.3，蓝图 §8.2）",
    };
  });
}

/* ── 边界建立/更新（§15.2；含 §2.7 冻结签名） ─────────────────────── */

function allocateSubscriptionSeq(db, _projectId) {
  // subscriptions.id 为全局 TEXT PRIMARY KEY 且编号形如 SUBS-nnnn（不内嵌项目编号）
  // → 必须从全局序列取号；沿用项目作用域会使第二个项目的首个订阅 SUBS-0002 与
  // 第一个项目撞全局主键（快照端点在第二个项目上必然 500）。
  db.prepare(
    "INSERT INTO id_sequences (project_id, kind, next_val) VALUES (?, 'subscription', 2) ON CONFLICT DO NOTHING",
  ).run(GLOBAL_SEQ_SCOPE);
  const row = db
    .prepare("SELECT next_val AS n FROM id_sequences WHERE project_id = ? AND kind = 'subscription'")
    .get(GLOBAL_SEQ_SCOPE);
  db.prepare(
    "UPDATE id_sequences SET next_val = ? WHERE project_id = ? AND kind = 'subscription'",
  ).run(row.n + 1, GLOBAL_SEQ_SCOPE);
  return `SUBS-${String(row.n).padStart(4, "0")}`;
}

/**
 * 在当前事务内写入新边界（建立或更新共用）：
 * 边界取 projects.next_commit_seq（该事务内已提交的全部事件 commit_seq 均小于它，
 * 之后分配的提交序号 ≥ 它——快照边界无间隙，§15.2）。
 */
function writeBoundary(db, { row, focusNorm, relationRules, scopeNorm, actor, bumpRevision }) {
  const project = db.prepare("SELECT next_commit_seq AS n FROM projects WHERE id = ?").get(row.project_id);
  if (!project) {
    throw apiError("NOT_FOUND", `项目不存在：${row.project_id}`);
  }
  const boundarySeq = project.n;
  const key = boundaryKeyOf(focusNorm, scopeNorm);
  const state = {
    boundary_key: key,
    boundary_seq: boundarySeq,
    scan_from: [boundarySeq, 0],
    scan_through: [boundarySeq, 0],
    seeds: seedsOf(focusNorm),
    grown: [],
  };
  const revision = bumpRevision ? row.subscription_revision + 1 : 1;
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE subscriptions SET focus = ?, relation_rules = ?, scope = ?, subscription_revision = ?,
       last_cursor = ?, updated_seq = ?, state_version = state_version + 1, status = 'active'
     WHERE id = ?`,
  ).run(
    focusJsonOf(focusNorm, state),
    JSON.stringify(relationRules),
    JSON.stringify(scopeNorm),
    revision,
    encodeCursor(row.id, revision, [boundarySeq, 0]),
    boundarySeq,
    row.id,
  );
  const updated = db.prepare("SELECT * FROM subscriptions WHERE id = ?").get(row.id);
  return { row: updated, boundarySeq, actor: actor || updated.created_by, now };
}

/** 会话面建立订阅（POST /subscriptions，#18）。 */
export async function createSubscription(pctx, { session, focus, relationRules, scope, projectId }) {
  if (projectId !== undefined && projectId !== null && projectId !== session.project_id) {
    throw apiError(
      "TRUST_DENIED",
      `请求项目 ${projectId} 与会话项目 ${session.project_id} 不一致；project_id 由服务端会话决定（§11.1）`,
    );
  }
  const focusNorm = normalizeFocus(focus);
  const rules = normalizeRelationRules(relationRules);
  const scopeNorm = normalizeScope(scope);
  const consumerId = focusNorm.consumer_id || session.actor;
  // 会话路径把消费者并入 focus（键稳定 + 视图自描述）；openSubscriptionBoundary 保持
  // 纯 focus+scope 身份（B1 不传会话），两条路径各自一致。
  focusNorm.consumer_id = consumerId;
  const store = await getStore(pctx);
  return store.runSerial((db) => {
    const project = db.prepare("SELECT id FROM projects WHERE id = ?").get(session.project_id);
    if (!project) {
      throw apiError("NOT_FOUND", `会话绑定的项目不存在：${session.project_id}`);
    }
    const id = allocateSubscriptionSeq(db, session.project_id);
    const now = new Date().toISOString();
    const boundarySeqPre = db
      .prepare("SELECT next_commit_seq AS n FROM projects WHERE id = ?")
      .get(session.project_id).n;
    db.prepare(
      `INSERT INTO subscriptions (id, project_id, consumer_id, focus, relation_rules, scope,
         subscription_revision, last_cursor, status, created_at, created_by, created_seq,
         updated_seq, state_version)
       VALUES (?, ?, ?, '{}', '[]', '{}', 1, '', 'active', ?, ?, ?, 0, 1)`,
    ).run(id, session.project_id, consumerId, now, session.actor, boundarySeqPre);
    const row = db.prepare("SELECT * FROM subscriptions WHERE id = ?").get(id);
    const written = writeBoundary(db, {
      row,
      focusNorm,
      relationRules: rules,
      scopeNorm,
      actor: session.actor,
      bumpRevision: false,
    });
    return { subscription: subscriptionView(written.row) };
  });
}

/** 会话面更新订阅规则（POST /subscriptions 携带 subscription_id）：显式规则变化 → 版本推进。 */
export async function updateSubscription(
  pctx,
  { session, subscriptionId, focus, relationRules, scope },
) {
  if (
    (focus === undefined || focus === null) &&
    relationRules === undefined &&
    (scope === undefined || scope === null)
  ) {
    throw apiError("BAD_REQUEST", "更新订阅至少提供 focus / relation_rules / scope 之一");
  }
  const store = await getStore(pctx);
  return store.runSerial((db) => {
    const row = loadSubscriptionRow(db, subscriptionId);
    guardSubscription(session, row);
    const currentFocus = (() => {
      const f = rowFocus(row);
      delete f[STATE_KEY];
      return f;
    })();
    const focusNorm = normalizeFocus(focus === undefined || focus === null ? currentFocus : focus);
    if (!focusNorm.consumer_id) focusNorm.consumer_id = row.consumer_id;
    const rules =
      relationRules === undefined
        ? normalizeRelationRules(JSON.parse(row.relation_rules || "[]"))
        : normalizeRelationRules(relationRules);
    const scopeNorm = normalizeScope(
      scope === undefined || scope === null ? JSON.parse(row.scope || "{}") : scope,
    );
    if (focusNorm.consumer_id && focusNorm.consumer_id !== row.consumer_id) {
      // 消费者改绑会移动回执归属，仅允许显式改绑且由现消费者本人执行（guard 已校验）
      db.prepare("UPDATE subscriptions SET consumer_id = ? WHERE id = ?").run(
        focusNorm.consumer_id,
        row.id,
      );
    }
    const written = writeBoundary(db, {
      row: db.prepare("SELECT * FROM subscriptions WHERE id = ?").get(row.id),
      focusNorm,
      relationRules: rules,
      scopeNorm,
      actor: session.actor,
      bumpRevision: true,
    });
    return { subscription: subscriptionView(written.row) };
  });
}

/**
 * §2.7 冻结跨模块签名（B1 → B2）：openSubscriptionBoundary
 * 在一致读视图内建立或更新订阅边界并推进 subscription_revision（§15.2）。
 * B1 的 GET /snapshots/{kind} 以返回值组装快照响应，不自行写 subscriptions 表。
 *
 * 身份：focus + scope 的规范化内容摘要作为订阅身份键——同键更新既有订阅（边界刷新、
 * 版本推进），异键建立新订阅。focus.consumer_id 可选（缺省用边界合成消费者）。
 */
export async function openSubscriptionBoundary(pctx, { projectId, focus, scope }) {
  if (typeof projectId !== "string" || !projectId.trim()) {
    throw apiError("BAD_REQUEST", "openSubscriptionBoundary 需要 projectId");
  }
  const focusNorm = normalizeFocus(focus);
  const scopeNorm = normalizeScope(scope);
  const key = boundaryKeyOf(focusNorm, scopeNorm);
  const store = await getStore(pctx);
  return store.runSerial((db) => {
    const project = db.prepare("SELECT id FROM projects WHERE id = ?").get(projectId);
    if (!project) {
      throw apiError("NOT_FOUND", `项目不存在：${projectId}`);
    }
    const candidates = db
      .prepare("SELECT * FROM subscriptions WHERE project_id = ?")
      .all(projectId);
    const existing = candidates.find((row) => rowState(row).boundary_key === key);
    if (existing) {
      const written = writeBoundary(db, {
        row: existing,
        focusNorm,
        relationRules: normalizeRelationRules(JSON.parse(existing.relation_rules || "[]")),
        scopeNorm,
        bumpRevision: true,
      });
      const state = rowState(written.row);
      return {
        subscription_id: written.row.id,
        subscription_revision: written.row.subscription_revision,
        resume_cursor: encodeCursor(written.row.id, written.row.subscription_revision, [
          state.boundary_seq,
          0,
        ]),
        snapshot_commit_seq: Math.max(0, state.boundary_seq - 1),
      };
    }
    const id = allocateSubscriptionSeq(db, projectId);
    const now = new Date().toISOString();
    const boundarySeqPre = db
      .prepare("SELECT next_commit_seq AS n FROM projects WHERE id = ?")
      .get(projectId).n;
    db.prepare(
      `INSERT INTO subscriptions (id, project_id, consumer_id, focus, relation_rules, scope,
         subscription_revision, last_cursor, status, created_at, created_by, created_seq,
         updated_seq, state_version)
       VALUES (?, ?, ?, '{}', '[]', '{}', 1, '', 'active', ?, 'boundary', ?, 0, 1)`,
    ).run(id, projectId, focusNorm.consumer_id || `boundary-${key.slice(0, 12)}`, now, boundarySeqPre);
    const written = writeBoundary(db, {
      row: db.prepare("SELECT * FROM subscriptions WHERE id = ?").get(id),
      focusNorm,
      relationRules: [],
      scopeNorm,
      bumpRevision: false,
    });
    const state = rowState(written.row);
    return {
      subscription_id: written.row.id,
      subscription_revision: written.row.subscription_revision,
      resume_cursor: encodeCursor(written.row.id, written.row.subscription_revision, [
        state.boundary_seq,
        0,
      ]),
      snapshot_commit_seq: Math.max(0, state.boundary_seq - 1),
    };
  });
}

/* ── 动态订阅匹配（§15.5） ────────────────────────────────────────── */

function parseEventRow(row) {
  return {
    event_id: row.event_id,
    commit_seq: row.commit_seq,
    event_index: row.event_index,
    event_type: row.event_type,
    subject_ids: JSON.parse(row.subject_ids || "[]"),
    changed_fields: JSON.parse(row.changed_fields || "[]"),
    cause_refs: JSON.parse(row.cause_refs || "[]"),
    producer_id: row.producer_id,
    schema_version: row.schema_version,
    payload: JSON.parse(row.payload || "{}"),
    created_at: row.created_at,
  };
}

/** 与关注集有边相连（任一方向、未撤回、类型受限时按允许类型）→ 视为已进入关注子图。 */
function neighborEdgeExists(db, projectId, subject, watchList, allowedTypes) {
  const typeSql =
    allowedTypes.length > 0 ? `AND relation_type IN (${allowedTypes.map(() => "?").join(",")})` : "";
  for (let i = 0; i < watchList.length; i += SQL_CHUNK) {
    const chunk = watchList.slice(i, i + SQL_CHUNK);
    const ph = chunk.map(() => "?").join(",");
    const sql =
      `SELECT 1 FROM relations WHERE project_id = ? AND retracted_at IS NULL ${typeSql} ` +
      `AND ((from_id = ? AND to_id IN (${ph})) OR (to_id = ? AND from_id IN (${ph}))) LIMIT 1`;
    const args = [projectId, ...allowedTypes, subject, ...chunk, subject, ...chunk];
    if (db.prepare(sql).get(...args)) return true;
  }
  return false;
}

function isAppliedBy(db, consumerId, eventId) {
  return Boolean(
    db
      .prepare(
        "SELECT 1 FROM consumer_receipts WHERE consumer_id = ? AND event_id = ? AND receipt_kind = 'applied' LIMIT 1",
      )
      .get(consumerId, eventId),
  );
}

/**
 * 事件是否命中订阅（§15.5）：
 *  1. 强制通知 → 命中（无视 event_types 过滤）；
 *  2. subject ∈ 关注集（种子 ∪ 动态扩展）→ 命中；
 *  3. relation.added 且任一端点 ∈ 关注集 → 命中，并把两端点并入动态扩展集；
 *  4. subject 与关注集任一成员有允许类型的未撤回边相连 → 命中
 *     （新资产经新边关联已关注节点时不被过滤，即使尚未进入旧子图）。
 */
function eventMatches(db, sub, watch, allowedTypes, event) {
  const watchList = [...watch.seeds, ...watch.grown];
  const inWatch = (id) => watch.seeds.has(id) || watch.grown.has(id);
  if (event.event_type === RELATION_ADDED_EVENT) {
    const endpoints = [event.payload?.endpoints?.from ?? event.subject_ids[0],
      event.payload?.endpoints?.to ?? event.subject_ids[1]]
      .filter((v, i, a) => typeof v === "string" && a.indexOf(v) === i);
    const touches = endpoints.some((id) => inWatch(id) ||
      neighborEdgeExists(db, sub.project_id, id, watchList, allowedTypes));
    if (!touches) return false;
    if (allowedTypes.length === 0 || allowedTypes.includes(event.payload?.relation_type)) {
      for (const id of endpoints) {
        if (!watch.seeds.has(id)) watch.grown.add(id);
      }
    }
    return true;
  }
  for (const subject of event.subject_ids) {
    if (inWatch(subject)) return true;
    if (neighborEdgeExists(db, sub.project_id, subject, watchList, allowedTypes)) return true;
  }
  return false;
}

/* ── 变化页（GET /changes，#16；§14.2/§14.3） ────────────────────── */

/**
 * 变化页：按 (commit_seq, event_index) 顺序扫描订阅事件流。
 *  - at-least-once：未 applied 的事件可重复出现（redelivered 标记）；已 applied 不再投递；
 *  - delivered 回执与 outbox 状态推进在本次事务内原子提交（§2 约束 10 的消费面）；
 *  - next_cursor 覆盖已扫描区间（过滤/已应用事件也被越过但不跳过未扫描内容）；
 *  - has_more 表示扫描未到头（含被过滤事件），客户端续读至 false 即追平。
 */
export async function readChangesPage(pctx, { session, subscriptionId, after, limit }) {
  const store = await getStore(pctx);
  return store.runSerial((db) => {
    const row = loadSubscriptionRow(db, subscriptionId);
    guardSubscription(session, row);
    if (row.status !== "active") {
      throw apiError("PRECONDITION_INVALID", `订阅 ${row.id} 状态为 ${row.status}，变化流不可读`);
    }
    const state = rowState(row);
    const consumerId = row.consumer_id;

    // 起始位置：显式游标（校验归属/版本/保留底线）或订阅 last_cursor（最近一次 applied 边界）
    let startPos;
    if (after === undefined || after === null || after === "") {
      const last = parseCursor(row.last_cursor);
      startPos = last ? last.position : [state.boundary_seq, 0];
    } else {
      startPos = assertCursorFor(db, row.project_id, row, after).position;
    }

    const pageLimit = Math.max(
      1,
      Math.min(MAX_PAGE_LIMIT, Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_PAGE_LIMIT),
    );
    const typeFilter = (() => {
      const f = rowFocus(row);
      return Array.isArray(f.event_types) && f.event_types.length > 0 ? new Set(f.event_types) : null;
    })();
    const allowedTypes = JSON.parse(row.relation_rules || "[]");
    const watch = { seeds: new Set(state.seeds), grown: new Set(state.grown) };

    const matched = []; // 按 (commit_seq, event_index) 顺序
    const coveredApplied = [];
    let examined = 0;
    let filteredIrrelevant = 0;
    let lastPos = startPos; // 已完成判定的事件末位置
    let hitScanCap = false;

    // 逐批完整判定（两遍：第二遍以批末关注集复核批内被暂缓事件，覆盖批内链式新边）；
    // 批间检查页上限与扫描上限。若匹配数超过页上限，游标截断在第 limit 个匹配事件，
    // 溢出匹配留在下一页重扫——绝不越过未投递的匹配事件推进（§14.3）。
    while (matched.length < pageLimit && examined < MAX_SCAN_PER_PAGE) {
      const batch = db
        .prepare(
          `SELECT * FROM outbox WHERE project_id = ? AND (commit_seq > ? OR (commit_seq = ? AND event_index > ?))
             ORDER BY commit_seq, event_index LIMIT ?`,
        )
        .all(row.project_id, lastPos[0], lastPos[0], lastPos[1], SCAN_BATCH);
      if (batch.length === 0) break;

      const deferred = [];
      const batchMatched = [];
      for (const raw of batch) {
        examined += 1;
        lastPos = [raw.commit_seq, raw.event_index];
        const event = parseEventRow(raw);
        if (isAppliedBy(db, consumerId, event.event_id)) {
          coveredApplied.push(event.event_id);
          continue;
        }
        if (isForcedNotification(event)) {
          batchMatched.push(event);
          continue;
        }
        if (typeFilter && !typeFilter.has(event.event_type)) {
          filteredIrrelevant += 1;
          continue;
        }
        if (eventMatches(db, row, watch, allowedTypes, event)) {
          batchMatched.push(event);
          continue;
        }
        deferred.push(event);
      }
      for (const event of deferred) {
        if (isAppliedBy(db, consumerId, event.event_id)) {
          coveredApplied.push(event.event_id);
          continue;
        }
        if (eventMatches(db, row, watch, allowedTypes, event)) {
          batchMatched.push(event);
        } else {
          filteredIrrelevant += 1;
        }
      }
      // 批内按 (commit_seq, event_index) 归位：第二遍晋升的事件可能与第一遍匹配交错，
      // 排序保证页内事件有序、截断游标不回退到已投递事件之前。
      batchMatched.sort((a, b) => a.commit_seq - b.commit_seq || a.event_index - b.event_index);
      matched.push(...batchMatched);
      if (batch.length < SCAN_BATCH) break;
      if (examined >= MAX_SCAN_PER_PAGE) hitScanCap = true;
    }
    if (examined >= MAX_SCAN_PER_PAGE) hitScanCap = true;

    const deliverCount = Math.min(matched.length, pageLimit);
    const delivered = matched.slice(0, deliverCount);
    const overflow = matched.length - deliverCount;
    // 游标终点：无溢出 → 已判定末位置；有溢出 → 第 deliverCount 个匹配事件（其后留待下页）
    const cutPos = overflow > 0 && delivered.length > 0
      ? [delivered[delivered.length - 1].commit_seq, delivered[delivered.length - 1].event_index]
      : lastPos;
    const moreRow = db
      .prepare(
        `SELECT 1 FROM outbox WHERE project_id = ? AND (commit_seq > ? OR (commit_seq = ? AND event_index > ?)) LIMIT 1`,
      )
      .get(row.project_id, cutPos[0], cutPos[0], cutPos[1]);
    const hasMore = Boolean(moreRow);
    const highRow = db
      .prepare(
        "SELECT commit_seq AS c, event_index AS i FROM outbox WHERE project_id = ? ORDER BY commit_seq DESC, event_index DESC LIMIT 1",
      )
      .get(row.project_id);
    const nextCursor = encodeCursor(row.id, row.subscription_revision, cutPos);

    // 投递回执（delivered）+ outbox 投递状态：与扫描判定同事务（§14.2/§14.3）
    const now = new Date().toISOString();
    for (const event of delivered) {
      const res = db
        .prepare(
          `INSERT OR IGNORE INTO consumer_receipts (consumer_id, subscription_revision, event_id,
             receipt_kind, boundary, created_at) VALUES (?, ?, ?, 'delivered', ?, ?)`,
        )
        .run(consumerId, row.subscription_revision, event.event_id, nextCursor, now);
      event.redelivered = res.changes === 0; // 已有 delivered 回执 → 至少一次语义下的重复投递
      db.prepare(
        "UPDATE outbox SET delivery_status = 'sent', delivery_attempts = delivery_attempts + 1 WHERE event_id = ?",
      ).run(event.event_id);
    }

    // 动态扩展与扫描区间持久化（无订阅版本推进：自动扩展不是消费者侧规则变化，§15.5）
    const nextState = {
      ...state,
      grown: [...watch.grown].filter((id) => !state.seeds.includes(id)),
      scan_through: posGe(lastPos, state.scan_through) ? lastPos : state.scan_through,
    };
    db.prepare("UPDATE subscriptions SET focus = ? WHERE id = ?").run(
      (() => {
        const f = rowFocus(row);
        f[STATE_KEY] = nextState;
        return JSON.stringify(f);
      })(),
      row.id,
    );

    return {
      subscription_id: row.id,
      subscription_revision: row.subscription_revision,
      consumer_id: consumerId,
      events: delivered,
      next_cursor: nextCursor,
      high_watermark: highRow ? { commit_seq: highRow.c, event_index: highRow.i } : { commit_seq: 0, event_index: 0 },
      has_more: hasMore,
      scanned: {
        examined,
        matched: delivered.length,
        overflow_deferred: overflow,
        filtered_irrelevant: filteredIrrelevant,
        already_applied: coveredApplied.length,
        scan_cap: hitScanCap,
      },
    };
  });
}

/* ── 消费确认（POST /consumer-acks，#17；§14.2/§14.3） ────────────── */

/**
 * 持久确认消费结果（业务处理确认 applied）。
 *  - 仅接受 receipt_kind="applied"：delivered 由服务端在变化页事务内记录（§14.3 分存）；
 *  - 边界确认不得越过未扫描区间（PRECONDITION_INVALID），事件确认必须是已投递事件
 *    （不得跳过未处理事件推进，§14.3）；
 *  - 幂等：重复确认不产生重复回执行、不回退游标（already_applied 计数）；
 *  - 一批合并处理的事件共享回执时，响应列明覆盖事件集合与连续消费边界（§14.3）。
 */
export async function acknowledgeConsumption(
  pctx,
  { session, subscriptionId, receiptKind, boundary, eventIds },
) {
  if (receiptKind !== undefined && receiptKind !== null && receiptKind !== "applied") {
    throw apiError(
      "BAD_REQUEST",
      `receipt_kind 仅接受 applied（delivered 由服务端在变化页投递时记录，§14.3 分存）`,
    );
  }
  const hasBoundary = typeof boundary === "string" && boundary.length > 0;
  const hasEventIds = Array.isArray(eventIds) && eventIds.length > 0;
  if (!hasBoundary && !hasEventIds) {
    throw apiError("BAD_REQUEST", "consumer-acks 需要 boundary（连续消费边界）或 event_ids（覆盖事件集合）之一");
  }
  if (eventIds !== undefined && eventIds !== null && !Array.isArray(eventIds)) {
    throw apiError("BAD_REQUEST", "event_ids 必须是数组");
  }
  const store = await getStore(pctx);
  return store.runSerial((db) => {
    const row = loadSubscriptionRow(db, subscriptionId);
    guardSubscription(session, row);
    const state = rowState(row);
    const consumerId = row.consumer_id;
    const revision = row.subscription_revision;
    const now = new Date().toISOString();

    // 覆盖集合 = 边界内已投递事件 ∪ 显式事件集（均为该消费者在本订阅版本下已投递的事件）
    const covered = new Set();
    let boundaryToken = null;
    let boundaryPos = null;
    if (hasBoundary) {
      const parsed = assertCursorFor(db, row.project_id, row, boundary);
      boundaryToken = boundary;
      boundaryPos = parsed.position;
      if (posGt(parsed.position, state.scan_through)) {
        throw apiError(
          "PRECONDITION_INVALID",
          `确认边界越过了本订阅已扫描区间（扫描至 (${state.scan_through[0]},${state.scan_through[1]})，确认到 (${parsed.position[0]},${parsed.position[1]})）；未读取的事件不能确认处理，不得跳过未处理事件推进（§14.3）`,
          {
            detail: { scanned_through: state.scan_through, requested: parsed.position },
            next_requirements: ["先以 GET /changes 读取到目标边界后再确认"],
          },
        );
      }
      const rows = db
        .prepare(
          `SELECT r.event_id AS eid FROM consumer_receipts r JOIN outbox o ON o.event_id = r.event_id
             WHERE r.consumer_id = ? AND r.subscription_revision = ?
               AND (o.commit_seq < ? OR (o.commit_seq = ? AND o.event_index <= ?))`,
        )
        .all(consumerId, revision, boundaryPos[0], boundaryPos[0], boundaryPos[1]);
      for (const r of rows) covered.add(r.eid);
    }
    if (hasEventIds) {
      for (const eid of eventIds) {
        const ev = db
          .prepare("SELECT event_id, project_id FROM outbox WHERE event_id = ?")
          .get(String(eid));
        if (!ev || ev.project_id !== row.project_id) {
          throw apiError("INVALID_REFERENCE", `事件不存在或不属于该项目：${eid}`);
        }
        const delivered = db
          .prepare(
            `SELECT 1 FROM consumer_receipts WHERE consumer_id = ? AND subscription_revision = ? AND event_id = ? LIMIT 1`,
          )
          .get(consumerId, revision, ev.event_id);
        if (!delivered) {
          throw apiError(
            "PRECONDITION_INVALID",
            `事件 ${ev.event_id} 尚未投递给消费者 ${consumerId}（订阅版本 ${revision}），不能确认处理（§14.3：不得跳过未处理事件推进）`,
            {
              detail: { event_id: ev.event_id },
              next_requirements: ["先以 GET /changes 读取该事件，再随批确认"],
            },
          );
        }
        covered.add(ev.event_id);
      }
    }

    let alreadyApplied = 0;
    const appliedNow = [];
    let recordBoundary = boundaryToken;
    if (!recordBoundary && covered.size > 0) {
      // 仅事件集确认：边界取覆盖集合中的最大事件位置（分块查询防参数上限）
      const ids = [...covered];
      let maxPos = null;
      for (let i = 0; i < ids.length; i += SQL_CHUNK) {
        const chunk = ids.slice(i, i + SQL_CHUNK);
        const rows = db
          .prepare(
            `SELECT commit_seq AS c, event_index AS i FROM outbox
               WHERE event_id IN (${chunk.map(() => "?").join(",")})
               ORDER BY commit_seq DESC, event_index DESC LIMIT 1`,
          )
          .all(...chunk);
        if (rows[0]) {
          const pos = [rows[0].c, rows[0].i];
          if (!maxPos || posGt(pos, maxPos)) maxPos = pos;
        }
      }
      if (maxPos) recordBoundary = encodeCursor(row.id, revision, maxPos);
    }
    for (const eid of covered) {
      const existing = db
        .prepare(
          "SELECT receipt_kind FROM consumer_receipts WHERE consumer_id = ? AND subscription_revision = ? AND event_id = ?",
        )
        .get(consumerId, revision, eid);
      if (existing && existing.receipt_kind === "applied") {
        alreadyApplied += 1;
        continue;
      }
      db.prepare(
        `INSERT INTO consumer_receipts (consumer_id, subscription_revision, event_id, receipt_kind, boundary, created_at)
           VALUES (?, ?, ?, 'applied', ?, ?)
           ON CONFLICT(consumer_id, subscription_revision, event_id) DO UPDATE SET receipt_kind = 'applied', boundary = excluded.boundary`,
      ).run(consumerId, revision, eid, recordBoundary || "", now);
      appliedNow.push(eid);
    }

    // last_cursor 只前进不回退（§14.3：按顺序处理过的事件位置）
    let lastCursor = row.last_cursor;
    if (boundaryToken) {
      const current = parseCursor(row.last_cursor);
      if (!current || posGt(boundaryPos, current.position)) lastCursor = boundaryToken;
      db.prepare("UPDATE subscriptions SET last_cursor = ? WHERE id = ?").run(lastCursor, row.id);
    }

    return {
      subscription_id: row.id,
      subscription_revision: revision,
      consumer_id: consumerId,
      receipt_kind: "applied",
      covered_event_ids: [...covered],
      covered_count: covered.size,
      applied_now: appliedNow.length,
      already_applied: alreadyApplied,
      boundary: recordBoundary,
      last_cursor: lastCursor,
    };
  });
}
