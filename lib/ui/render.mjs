/**
 * Sorne —— 统一字段渲染器（lib/ui/render.mjs；M1 独占，M3–M6 唯一允许的取数渲染入口）。
 *
 * 蓝图 §2.2（冻结契约）。回应评审 §3（把数据库倒在屏幕上）与 §5（视觉语言缺失）：
 *   - 页面不得自写时间/哈希/编号/JSON 渲染逻辑（消灭 6 份 RECORD_ID_RE 类分叉的
 *     结构性手段——编号解析唯一实现在 lib/ui/record-ids.mjs，本文件经它渲染 chip）；
 *   - 时间本地化 + 相对（悬停 title=原始 ISO），绝不再裸出 UTC ISO 串；
 *   - 哈希缩略 + 复制完整值；空值渲染「—（未提供）」（未提供 ≠ 不存在）；
 *   - 对象/数组默认折叠（折叠不删记录：展开入口 + 「已折叠 n 项」计数）；
 *   - 词表驱动状态徽章（色点 + 中文标签 + 悬停英文原值）；未知值渲染
 *     「未知状态（<raw>）」；confirmed/insufficient/falsified 语义纪律措辞
 *     在 VOCAB 内为冻结原文（评审 §6 要求保留）；
 *   - LABELS 字段→中文标签全量映射；未登记字段降级为「原样键名 + 悬停提示
 *     『标签未登记』」，不省略、不猜测、不静默吞掉（同「未提供 ≠ 不存在」纪律）。
 *
 * 本文件不得 import 任何包或 Node 内置模块；只允许 import 同目录
 * record-ids.mjs（编号解析唯一实现）。React 的 createElement/Component 由外壳
 * 注入（bindRenderers），有状态折叠/排序组件在模块层定义一次（类型稳定，
 * 重渲染不丢交互状态）。
 */
import { parseRecordId, isEventId } from "./record-ids.mjs";

/* ── 渲染注入（外壳启动时 bindRenderers(React) 一次；测试注入宿主实现） ── */

let bound = null;

/** 绑定 { createElement, Component }（React 或测试宿主的等价实现）。 */
export function bindRenderers(reactLike) {
  if (!reactLike || typeof reactLike.createElement !== "function" || typeof reactLike.Component !== "function") {
    throw new Error("bindRenderers 需要 { createElement, Component }");
  }
  bound = reactLike;
}

function requireBound(caller) {
  if (!bound) {
    throw new Error(`render.${caller} 在 bindRenderers 之前不可用（外壳未注入渲染实现）`);
  }
  return bound;
}

/* ── LABELS：字段 → 中文标签（蓝图 §2.2：收录全部现役字段） ──────────── */

export const LABELS = Object.freeze({
  // 通用身份
  id: "编号",
  project_id: "项目编号",
  name: "名称",
  description: "目标 / 描述",
  status: "状态",
  kind: "类型",
  title: "标题 / 问题",
  summary: "摘要 / 依据",
  note: "说明",
  source: "来源",
  created_at: "创建时间",
  created_by: "创建者",
  created_seq: "创建提交序号",
  updated_seq: "更新提交序号",
  updated_at: "更新时间",
  valid_from_seq: "生效提交序号",
  retracted_at: "撤回时刻",
  schema_version: "模式版本",
  commit_seq: "提交序号",
  // 项目 / 范围
  current_scope_revision: "当前范围版本",
  next_commit_seq: "下一提交序号",
  state_version: "状态版本",
  revision: "范围版本号",
  rules: "范围规则",
  allow: "允许（allow）",
  deny: "拒绝（deny，优先）",
  pending: "待判断（pending）",
  history: "历史版本",
  configured: "是否已配置范围",
  scope: "范围",
  scope_status: "范围状态",
  current: "当前版本",
  // 计数类
  counts: "计数",
  assets: "资产数",
  observations: "观察数",
  hypotheses: "假设数",
  vulnerabilities: "漏洞数",
  submissions: "提交数",
  outbox_pending: "待发送事件数",
  projects: "项目数",
  sessions: "会话",
  active: "活跃",
  count: "数量",
  total: "总计",
  // 健康 / 运行
  ok: "服务正常",
  service: "服务名",
  version: "版本",
  checked_at: "检查时刻",
  db: "数据库",
  outbox: "Outbox（事务性事件）",
  sent: "已发送",
  failed: "失败",
  skipped: "已跳过",
  // 分页信封
  has_more: "是否还有更多",
  next_cursor: "下一页游标",
  next_after: "下一页游标（旧字段，兼容保留）",
  cursor: "当前游标",
  high_watermark: "高水位",
  // 意图 / 执行
  intents: "意图（探索方向）",
  goal_id: "目标编号",
  priority: "优先级",
  resume_conditions: "恢复条件（补齐即可续跑）",
  depends_on: "依赖",
  prereq_intent_ids: "前置意图",
  lease_expires_at: "租约到期时刻",
  lease_remaining_ms: "租约剩余（毫秒）",
  attempt_id: "执行尝试编号",
  intent_id: "意图编号",
  worker_id: "执行者",
  attempts: "执行尝试",
  // 验证
  latest_result: "最近验证结果",
  outcome: "验证结论",
  applied: "是否已应用",
  verifier_identity: "验证者身份",
  reviewed_evidence_revision: "已复核证据版本",
  reviewed_manifest_id: "已复核证据清单编号",
  claim_revision: "判断版本",
  subject_id: "主体编号",
  subject_kind: "主体类型",
  subject_table: "主体物理表",
  result: "验证结果",
  decision: "处理决定",
  mismatches: "不匹配项",
  deduplicated: "是否幂等去重",
  plan_request_id: "规划请求编号",
  // 记录视图
  view: "视图",
  table: "物理表",
  relations: "关系",
  evidence_index: "证据索引",
  edges: "关系边",
  truncated: "是否截断",
  capture_id: "采集编号",
  sha256: "内容哈希（sha256）",
  bytes: "字节数",
  content_type: "内容类型",
  read_path: "读取路径",
  original_input: "原始输入",
  activity_seq: "活动提交序号",
  relation_type: "关系类型",
  conditions: "条件",
  requires_state: "前置状态",
  from: "起点编号",
  to: "终点编号",
  // 资产 / 记录视图扩展（/records 各表视图字段，B1 实测）
  asset_type: "资产类型",
  canonicalization_version: "规范化版本",
  canonical_key: "规范化键",
  resources: "资源数",
  captures: "采集数",
  intents_targeting: "指向该资产的意图数",
  expand: "展开入口",
  record_path: "记录读取路径",
  evidence_bytes_path_template: "证据字节读取路径模板",
  detail: "详情",
  hint: "提示",
  // 变化流 / Outbox
  events: "事件列表",
  event_id: "事件编号",
  event_type: "事件类型",
  subject_ids: "主体编号列表",
  changed_fields: "变更字段",
  cause_refs: "起因引用",
  payload: "事件负载",
  delivery_status: "投递状态",
  delivery_attempts: "投递次数",
  handling_status: "处理状态",
  generated_at: "生成时刻",
  snapshot_commit_seq: "快照提交序号",
  snapshot_id: "快照编号",
  // 汇报（§18.3）
  execution_status: "执行状态",
  task_question: "任务问题",
  actual_outcome: "实际结果",
  content: "内容",
  omitted_sections: "省略章节",
  source_manifest_id: "证据清单编号",
  source_commit_boundary: "证据截止边界",
  replaces_report_id: "取代汇报编号",
  base_report_id: "基线汇报编号",
  important_findings: "重要发现",
  blockers: "阻塞",
  unresolved_questions: "未解决问题",
  proposed_next_actions: "建议后续动作",
  material_conditions: "重要条件",
  contradictions: "矛盾",
  evidence_refs: "证据引用",
  full_record_pointer: "完整记录指针",
  // 项目列表 summary（§2.6-5）
  latest_progress: "最近进展",
  last_activity_at: "最近活动",
  unhandled_reports: "未处理汇报数",
  pending_verification: "待验证数",
  blocked_intents: "受阻方向数",
  // 错误信封（lib/errors.mjs §20.1）
  code: "错误码",
  message: "消息",
  retryable: "可重试",
  next_requirements: "下一步所需条件",
  module: "所属模块",
  endpoint: "端点",
  spec: "规范章节",
  error: "错误",
  // 信封包装键（端点响应的包装对象名）
  project: "项目",
  record: "记录",
});

/* ── VOCAB：词表驱动的状态徽章（语义纪律措辞为冻结原文，不得改写） ───── */

const TONES = Object.freeze({
  suspected: "--sorne-status-suspected",
  confirmed: "--sorne-status-confirmed",
  falsified: "--sorne-status-falsified",
  review: "--sorne-status-review",
  unknown: "--sorne-status-unknown",
  ok: "--sorne-status-ok",
});

export const VOCAB = Object.freeze({
  // §8.4 漏洞状态合同——三句纪律措辞为冻结原文（评审 §6 / 规范 §8.4）。
  vulnerability_status: Object.freeze({
    suspected: { label: "疑似", tone: "suspected" },
    confirmed: { label: "已确认（限指定条件）", tone: "confirmed" },
    falsified: { label: "已证伪（不等于历史上不存在）", tone: "falsified" },
    inconclusive: { label: "证据不足：未确认，不伪装成已排除", tone: "unknown" },
  }),
  review_status: Object.freeze({
    clear: { label: "无争议", tone: "ok" },
    pending: { label: "待复核", tone: "review" },
    disputed: { label: "有争议", tone: "unknown" },
  }),
  // §8.3 验证结论四值；insufficient 措辞纪律同上。
  outcome: Object.freeze({
    supported: { label: "支持（验证通过）", tone: "confirmed" },
    falsified: { label: "推翻（不等于历史上不存在）", tone: "falsified" },
    insufficient: { label: "证据不足：未确认，不伪装成已排除", tone: "unknown" },
    conflicting: { label: "相互矛盾", tone: "unknown" },
  }),
  job_status: Object.freeze({
    pending: { label: "待验证", tone: "review" },
    in_progress: { label: "验证中", tone: "review" },
    completed: { label: "已完成", tone: "ok" },
    superseded: { label: "已被取代", tone: "falsified" },
  }),
  attempt_status: Object.freeze({
    leased: { label: "已租约", tone: "review" },
    running: { label: "执行中", tone: "ok" },
    suspended: { label: "已挂起", tone: "suspected" },
    interrupted: { label: "被打断（待恢复）", tone: "suspected" },
    completed: { label: "已完成", tone: "ok" },
    failed: { label: "已失败", tone: "unknown" },
    cancelled: { label: "已取消", tone: "falsified" },
  }),
  tool_call_status: Object.freeze({
    planned: { label: "已计划", tone: "review" },
    running: { label: "执行中", tone: "ok" },
    succeeded: { label: "已成功", tone: "ok" },
    failed: { label: "已失败", tone: "unknown" },
    // 规范 §10.2：unknown 工具调用警示——徽章文字为冻结原文。
    unknown: { label: "结果未知（须先检查外部现状再决定重试，不得当作已完成或已失败）", tone: "unknown" },
    cancelled: { label: "已取消", tone: "falsified" },
  }),
  intent_status: Object.freeze({
    proposed: { label: "已提议", tone: "review" },
    queued: { label: "已入队", tone: "review" },
    running: { label: "执行中", tone: "ok" },
    resolved: { label: "已解决", tone: "ok" },
    blocked: { label: "受阻（等待条件补齐）", tone: "suspected" },
    awaiting_review: { label: "待复核", tone: "review" },
    deferred: { label: "已暂缓", tone: "falsified" },
    obsolete: { label: "已废弃", tone: "falsified" },
    cancelled: { label: "已取消", tone: "falsified" },
  }),
  project_status: Object.freeze({
    active: { label: "运行中", tone: "ok" },
    waiting_for_change: { label: "等待条件变化", tone: "suspected" },
    paused: { label: "已暂停", tone: "falsified" },
    stopped: { label: "已停止", tone: "falsified" },
  }),
  // D1 语义化主体类型（P0-4 联动；历史物理表名值由后端映射，页面不再出现
  // 「未知类型（vulnerabilities）」）。
  subject_kind: Object.freeze({
    observation: { label: "观察", tone: "review" },
    hypothesis: { label: "假设", tone: "suspected" },
    fact: { label: "事实", tone: "ok" },
    vulnerability: { label: "漏洞", tone: "confirmed" },
  }),
  report_kind: Object.freeze({
    progress: { label: "进展汇报", tone: "review" },
    handoff: { label: "交接汇报", tone: "suspected" },
    blocked: { label: "受阻汇报", tone: "suspected" },
    completion: { label: "完成汇报（不自动确认漏洞、不结束项目）", tone: "ok" },
  }),
  // §2.6-2 消息状态：收到 ≠ 已处理（delivered ≠ handled 纪律）。
  message_status: Object.freeze({
    received: { label: "已接收（尚未处理）", tone: "review" },
    processing: { label: "处理中", tone: "review" },
    answered: { label: "已答复", tone: "ok" },
    failed: { label: "处理失败", tone: "unknown" },
  }),
  scope_kind: Object.freeze({
    allow: { label: "允许", tone: "ok" },
    deny: { label: "拒绝（优先）", tone: "confirmed" },
    pending: { label: "待判断", tone: "suspected" },
  }),
  // 开放词表：未知值原样显示（开放枚举不伪装成「未知状态」告警）。
  event_type: Object.freeze({ __openEnded: true }),
});

/** 顶栏运行状态词表（要求 §7 五态 + 正在暂停过渡态 + 状态未知；冻结标签）。 */
export const RUN_STATUS = Object.freeze({
  exploring: { label: "正在探索", tone: "ok" },
  waiting: { label: "等待条件补齐", tone: "suspected" },
  pausing: { label: "正在暂停", tone: "suspected" },
  paused: { label: "已暂停", tone: "falsified" },
  abnormal: { label: "系统异常", tone: "unknown" },
  stopped: { label: "已停止", tone: "falsified" },
  unknown: { label: "状态未知", tone: "unknown" },
});

/* ── 时间：本地化 + 相对（悬停 title=原始 ISO；绝不裸出 UTC ISO 串） ──── */

function pad2(n) {
  return String(n).padStart(2, "0");
}

/**
 * formatTime(iso, { mode = "relative-local", now } = {})
 *   mode="relative-local"：如「3 分钟前 · 14:32:05」；跨天含日期。
 *   mode="absolute"：「2026-11-05 14:32:05（本地）」。
 *   悬停 title=原始 ISO。空值 → 「—（未提供）」；无法解析 → 「时间无法解析：<raw>」。
 */
export function formatTime(iso, { mode = "relative-local", now } = {}) {
  if (iso === null || iso === undefined || iso === "") return "—（未提供）";
  const raw = String(iso);
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return `时间无法解析：${raw}`;
  const hh = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  const datePart = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const abs = `${datePart} ${hh}`;
  if (mode === "absolute") return `${abs}（本地）`;
  const ref = typeof now === "number" ? now : Date.now();
  const diffMs = ref - d.getTime();
  let rel;
  if (diffMs < 60_000) {
    rel = "刚刚";
  } else if (diffMs < 3_600_000) {
    rel = `${Math.floor(diffMs / 60_000)} 分钟前`;
  } else if (diffMs < 86_400_000) {
    rel = `${Math.floor(diffMs / 3_600_000)} 小时前`;
  } else if (diffMs < 30 * 86_400_000) {
    rel = `${Math.floor(diffMs / 86_400_000)} 天前`;
  } else {
    rel = datePart;
  }
  const sameDay = new Date(ref).toDateString() === d.toDateString();
  return sameDay ? `${rel} · ${hh}` : `${rel} · ${abs}`;
}

/* ── 哈希：缩略 + 复制完整值；空值 → 「—（未提供）」 ─────────────────── */

function looksLikeSha256(v) {
  return typeof v === "string" && /^[0-9a-f]{64}$/i.test(v);
}

/**
 * formatHash(value, { prefix = 10 } = {})
 *   sha256 形态渲染「sha256:ab12cd34ef…」，附「复制」按钮（复制完整值，
 *   aria-label=复制完整哈希值）；其余长字符串同样缩略；空值 → 「—（未提供）」。
 *   复制经 navigator.clipboard，不可用时静默不报（完整值始终在悬停 title 中）。
 */
export function formatHash(value, { prefix = 10 } = {}) {
  const { createElement: h } = requireBound("formatHash");
  if (value === null || value === undefined || value === "") {
    return h("span", { title: "该字段未提供值（未提供 ≠ 不存在）" }, "—（未提供）");
  }
  const full = String(value);
  const isSha = looksLikeSha256(full);
  const shown = full.length > prefix + 2 ? `${full.slice(0, prefix)}…` : full;
  const text = isSha ? `sha256:${shown}` : shown;
  const copy = () => {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        navigator.clipboard.writeText(full);
      }
    } catch { /* 剪贴板不可用：完整值仍在悬停 title 中 */ }
  };
  return h(
    "span",
    { style: { display: "inline-flex", alignItems: "center", gap: 4 } },
    h("code", {
      title: `完整值：${full}`,
      style: {
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 13,
        wordBreak: "break-all",
      },
    }, text),
    h("button", {
      type: "button",
      "aria-label": "复制完整哈希值",
      title: "复制完整值",
      onClick: copy,
      style: {
        fontSize: 13,
        padding: "1px 6px",
        borderRadius: 4,
        border: "1px solid var(--sorne-border-strong)",
        background: "transparent",
        color: "var(--sorne-text-secondary)",
        cursor: "pointer",
      },
    }, "复制"),
  );
}

/* ── 编号 chip：完整编号按钮（不截断项目段；点击 → router.openRecord） ── */

/**
 * RecordIdChip(id, { projectId, navigate } = {})
 *   - 解析成功 → <button aria-label=完整编号>完整编号</button>；点击 →
 *     navigate(id)（= router.openRecord，打开 #/records 覆盖层）；
 *   - 事件编号（evt-/EVT-）→ 降级文本 chip + title 指向系统诊断变化流；
 *   - 无法解析 → 纯文本 chip + title 说明，绝不静默给错记录（评审 §4a）；
 *   - 前缀未登记（后端 M2 扩展前）→ 仍可点击，title 说明定位以服务端为准。
 *   aria-label 恒为完整编号（可访问性基线，蓝图 §2.1）。
 */
export function RecordIdChip(id, { projectId, navigate } = {}) {
  const { createElement: h } = requireBound("RecordIdChip");
  const raw = id === null || id === undefined ? "" : String(id);
  if (!raw) return h("span", null, "—（未提供）");

  if (isEventId(raw)) {
    return h("span", {
      title: "事件编号（不属记录读取）；可在系统诊断页的变化流中查看",
      style: { whiteSpace: "nowrap" },
    }, raw);
  }

  const parsed = parseRecordId(raw);
  if (!parsed) {
    return h("span", {
      title: "不是可解析的记录编号；已按原样显示，不猜测目标记录",
      style: { whiteSpace: "nowrap" },
    }, raw);
  }

  const kindHint = parsed.kindLabel ? `${parsed.kindLabel} · ` : "";
  const segHint = parsed.projectSeq ? "项目内编号 · " : "";
  const tableHint = parsed.table ? "" : "（前缀未登记，定位以服务端为准）";

  const doOpen = (e) => {
    if (e && typeof e.preventDefault === "function") e.preventDefault();
    if (e && typeof e.stopPropagation === "function") e.stopPropagation();
    if (typeof navigate === "function") navigate(parsed.id);
  };

  return h("button", {
    type: "button",
    "aria-label": `查看记录 ${parsed.id}${parsed.kindLabel ? `（${parsed.kindLabel}）` : ""}`,
    title: `${segHint}${kindHint}记录编号 ${parsed.id}${tableHint ? ` · ${tableHint}` : ""}`,
    onClick: doOpen,
    style: {
      display: "inline-flex",
      alignItems: "center",
      gap: 4,
      padding: "1px 8px",
      fontSize: 13,
      borderRadius: 999,
      border: "1px solid var(--sorne-border-strong)",
      background: "var(--sorne-bg-subtle)",
      color: "var(--sorne-text-primary)",
      cursor: "pointer",
      whiteSpace: "nowrap",
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    },
  }, parsed.id);
}

/* ── 有状态折叠 / 表格（模块层定义一次，类型稳定） ───────────────────── */

let FoldableToggleClass = null;
let TableBodyClass = null;

function getFoldableToggleClass() {
  const { createElement: h, Component } = requireBound("FoldableObject");
  if (!FoldableToggleClass) {
    FoldableToggleClass = class FoldableToggle extends Component {
      constructor(props) {
        super(props);
        this.state = { open: Boolean(props && props.defaultOpen) };
      }
      render() {
        const open = this.state.open;
        const value = this.props.childValue;
        const level = this.props.level || 0;
        const isArray = Array.isArray(value);
        const entries = isArray
          ? value.map((v, i) => [String(i), v])
          : Object.keys(value || {}).map((k) => [k, value[k]]);
        const count = entries.length;
        const rows = open
          ? h("div", { style: { paddingLeft: 14, borderLeft: "2px solid var(--sorne-border)" } },
              entries.map(([k, v]) => h("div", { key: k, style: { padding: "2px 0" } },
                v !== null && typeof v === "object"
                  ? h(FoldableToggleClass, {
                      key: `obj-${k}`,
                      label: k,
                      childValue: v,
                      level: level + 1,
                      defaultOpen: false,
                    })
                  : FieldRow(k, v),
              )))
          : null;
        return h("div", null,
          h("button", {
            type: "button",
            "aria-expanded": open ? "true" : "false",
            "aria-label": `${this.props.label ? `${this.props.label}：` : ""}${isArray ? "数组" : "对象"}${count} 项，${open ? "折叠" : "展开"}`,
            onClick: () => this.setState({ open: !open }),
            style: {
              display: "inline-flex", alignItems: "center", gap: 6,
              background: "transparent", border: "none", cursor: "pointer",
              color: "var(--sorne-text-secondary)", fontSize: 13, padding: "2px 0",
              fontFamily: "inherit",
            },
          },
            h("span", { "aria-hidden": "true" }, open ? "▾" : "▸"),
            this.props.label ? h("span", { style: { fontWeight: 600 } }, String(this.props.label)) : null,
            h("span", null, `${isArray ? `[${count} 个元素]` : `{${count} 项}`}`),
            !open && count > 0
              ? h("span", { title: "折叠不删记录；点开展开查看全部" }, `已折叠 ${count} 项`)
              : null,
          ),
          rows,
        );
      }
    };
  }
  return FoldableToggleClass;
}

/**
 * FoldableObject(value, { summary, level = 0, defaultOpen = false } = {})
 *   对象/数组默认折叠：显示「{n 项}」/「[m 个元素]」+「已折叠 n 项」计数；
 *   点击展开递归渲染全部内容（展开不删记录）；嵌套对象默认再折叠；
 *   超过 8 层以 JSON 文本呈现（超长显式标注截断，完整值以原始记录为准）。
 *   标量原样返回字符串。
 */
export function FoldableObject(value, { summary, level = 0, defaultOpen = false } = {}) {
  const { createElement: h } = requireBound("FoldableObject");
  if (value === null || value === undefined) return "—（未提供）";
  if (typeof value !== "object") return String(value);

  if (level >= 8) {
    let text;
    try { text = JSON.stringify(value, null, 2); } catch { text = String(value); }
    const clipped = text.length > 4000
      ? `${text.slice(0, 4000)}\n…（显示已截断，完整值以原始记录为准）`
      : text;
    return h("pre", {
      style: {
        margin: "4px 0", padding: "8px", borderRadius: 6,
        background: "var(--sorne-bg-subtle)",
        border: "1px solid var(--sorne-border)",
        fontSize: 13, overflow: "auto", maxHeight: 320, whiteSpace: "pre-wrap",
      },
    }, clipped);
  }

  const Toggle = getFoldableToggleClass();
  return h(Toggle, {
    label: summary !== undefined && level > 0 ? String(summary) : "",
    childValue: value,
    level,
    defaultOpen,
  });
}

/* ── 状态徽章（词表驱动；未知值显式呈现，不猜测） ───────────────────── */

function toneVars(tone) {
  const base = TONES[tone] || TONES.unknown;
  return {
    background: `var(${base}-bg)`,
    color: `var(${base}-fg)`,
    dot: `var(${base}-fg)`,
  };
}

/**
 * StatusBadge(vocabKey, value)
 *   词表驱动徽章：色点 + 中文标签 + 悬停英文原值。
 *   未知值 → 「未知状态（<raw>）」红色调 + title 说明（测试视为失败信号，
 *   P0-4 联动）；开放词表（event_type）未知值原样显示不告警。
 */
export function StatusBadge(vocabKey, value) {
  const { createElement: h } = requireBound("StatusBadge");
  const vocab = VOCAB[vocabKey];
  if (!vocab) {
    return h("span", {
      title: `词表缺失：${vocabKey}（应补登 lib/ui/render.mjs VOCAB，不得猜测语义）`,
      style: { ...toneVars("unknown"), padding: "1px 8px", borderRadius: 999, fontSize: 13 },
    }, `未知状态（词表 ${vocabKey} 缺失）`);
  }
  const raw = value === null || value === undefined || value === "" ? "" : String(value);
  const entry = Object.prototype.hasOwnProperty.call(vocab, raw) ? vocab[raw] : null;
  if (!entry) {
    if (vocab.__openEnded) {
      return h("span", {
        title: "开放词表：原样显示原始值（开放枚举，不伪装成异常）",
        style: {
          padding: "1px 8px", borderRadius: 999, fontSize: 13,
          border: "1px solid var(--sorne-border)",
          color: "var(--sorne-text-secondary)",
          background: "var(--sorne-bg-subtle)",
        },
      }, raw || "—（未提供）");
    }
    return h("span", {
      title: `词表 ${vocabKey} 中无「${raw}」条目；按未知状态呈现（P0-4：应补登词表，不得静默猜测语义）`,
      style: { ...toneVars("unknown"), padding: "1px 8px", borderRadius: 999, fontSize: 13 },
    }, `未知状态（${raw}）`);
  }
  const vars = toneVars(entry.tone);
  return h("span", {
    title: `原始值：${raw || "（空）"}`,
    style: {
      display: "inline-flex", alignItems: "center", gap: 5,
      padding: "1px 8px", borderRadius: 999, fontSize: 13,
      background: vars.background, color: vars.color,
      whiteSpace: "normal",
    },
  },
    h("span", {
      "aria-hidden": "true",
      style: {
        width: 7, height: 7, borderRadius: "50%", background: vars.dot,
        display: "inline-block", flex: "0 0 auto",
      },
    }),
    entry.label,
  );
}

/* ── 字段行（LABELS 中文标签；未登记字段降级不吞掉） ─────────────────── */

/** id 形态字段的自动 chip 限定：键名为 id/_id/_ref/_refs/…_ref 形态，避免
    把恰好长得像编号的业务文本（如项目名）误渲染成可点击 chip。 */
function isIdLikeKey(key) {
  return /(^|_)(id|ref|refs|cursor)$/.test(key) || /_id$/.test(key) || /_refs$/.test(key);
}

/**
 * FieldRow(label, value, { renderer } = {})
 *   label 为字段键名：经 LABELS 映射为中文标签；未登记 → 原样键名 + 悬停
 *   「标签未登记」（不省略、不猜测、不静默吞掉）。
 *   值：布尔 → 是/否；null/空 → 「—（未提供）」（悬停提示未提供 ≠ 不存在）；
 *   时间形态字段（*_at）→ formatTime；哈希字段 → formatHash；
 *   id 形态的可解析编号 → RecordIdChip；对象 → FoldableObject。
 */
export function FieldRow(label, value, { renderer } = {}) {
  const { createElement: h } = requireBound("FieldRow");
  const key = String(label);
  const zh = Object.prototype.hasOwnProperty.call(LABELS, key) ? LABELS[key] : null;
  const labelText = zh || key;

  let content;
  if (renderer) {
    content = renderer(value);
  } else if (typeof value === "boolean") {
    content = value ? "是" : "否";
  } else if (value === null || value === undefined || value === "") {
    content = h("span", {
      title: "该字段未提供值（未提供 ≠ 不存在）",
      style: { color: "var(--sorne-text-muted)" },
    }, "—（未提供）");
  } else if (/_at$/.test(key) && typeof value === "string" && !Number.isNaN(new Date(value).getTime())) {
    content = h("span", { title: `原始值：${value}` }, formatTime(value));
  } else if (/(sha256|hash)/.test(key) && typeof value === "string") {
    content = formatHash(value);
  } else if (typeof value === "object") {
    content = FoldableObject(value, { level: 1 });
  } else if (typeof value === "string" && isIdLikeKey(key) && parseRecordId(value)) {
    content = RecordIdChip(value, {});
  } else {
    content = String(value);
  }

  return h("div", {
    style: {
      display: "flex", gap: 8, padding: "3px 0",
      alignItems: "baseline", lineHeight: 1.55,
    },
  },
    h("span", {
      title: zh ? undefined : "标签未登记（应补登 LABELS，未登记字段不省略、不猜测）",
      style: {
        flex: "0 0 170px", color: zh ? "var(--sorne-text-secondary)" : "var(--sorne-text-muted)",
        fontSize: 13,
      },
    }, `${labelText}${zh ? "" : "（标签未登记）"}`),
    h("span", {
      style: {
        flex: "1 1 auto", minWidth: 0, fontSize: 14,
        color: "var(--sorne-text-primary)", wordBreak: "break-word",
      },
    }, content),
  );
}

/* ── 真表格（评审 P2-9：排序、状态徽章列、行内点击进详情） ──────────── */

function compareValues(a, b) {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), "zh-Hans-CN");
}

/**
 * DataTable({ columns, rows, rowKey, onRowClick, sortable = true } = {})
 *   columns: [{ key, label, badge?: vocabKey, value?(row), render?(row) }]
 *   真表格（<table>）：表头排序按钮（aria-sort）、行点击进详情（onRowClick）。
 *   空行/空列 → EmptyState（注明按已加载数据推导，不代表全量）。
 */
export function DataTable({ columns, rows, rowKey, onRowClick, sortable = true } = {}) {
  const { createElement: h, Component } = requireBound("DataTable");
  const cols = Array.isArray(columns) ? columns : [];
  const data = Array.isArray(rows) ? rows : [];
  if (!cols.length) return EmptyState({ title: "表格没有可显示的列", hint: null });
  if (!data.length) return EmptyState({ title: "暂无数据", hint: "本视图按已加载数据推导，不代表全量" });

  if (!TableBodyClass) {
    TableBodyClass = class TableBody extends Component {
      constructor(props) {
        super(props);
        this.state = { sortKey: "", sortDir: 1 };
      }
      sortedRows() {
        const { sortKey, sortDir } = this.state;
        if (!sortKey) return this.props.rows;
        const col = this.props.columns.find((c) => c.key === sortKey);
        const val = (row) => (col && typeof col.value === "function" ? col.value(row) : row[sortKey]);
        return [...this.props.rows].sort((a, b) => compareValues(val(a), val(b)) * sortDir);
      }
      render() {
        const { sortKey, sortDir } = this.state;
        const clickable = typeof this.props.onRowClick === "function";
        return h("table", {
          style: { width: "100%", borderCollapse: "collapse", fontSize: 13.5, lineHeight: 1.55 },
        },
          h("thead", null,
            h("tr", null,
              this.props.columns.map((c) => h("th", {
                key: c.key,
                scope: "col",
                "aria-sort": sortKey === c.key ? (sortDir === 1 ? "ascending" : "descending") : "none",
                style: {
                  textAlign: "left", padding: "6px 10px", fontSize: 13,
                  color: "var(--sorne-text-secondary)",
                  background: "var(--sorne-bg-subtle)",
                  borderBottom: "1px solid var(--sorne-border)",
                  whiteSpace: "nowrap",
                },
              },
                this.props.sortable
                  ? h("button", {
                      type: "button",
                      "aria-label": `按${c.label || c.key}排序`,
                      onClick: () => this.setState((prev) => (
                        prev.sortKey === c.key
                          ? { sortKey: c.key, sortDir: -prev.sortDir }
                          : { sortKey: c.key, sortDir: 1 }
                      )),
                      style: {
                        background: "transparent", border: "none", cursor: "pointer",
                        color: "inherit", fontSize: 13, padding: 0, fontWeight: 600,
                        fontFamily: "inherit",
                      },
                    }, `${c.label || c.key}${sortKey === c.key ? (sortDir === 1 ? " ↑" : " ↓") : ""}`)
                  : (c.label || c.key),
              )))),
          h("tbody", null,
            this.sortedRows().map((row, i) => {
              const key = this.props.rowKey ? this.props.rowKey(row, i) : i;
              return h("tr", {
                key,
                onClick: clickable ? () => this.props.onRowClick(row) : undefined,
                style: {
                  borderBottom: "1px solid var(--sorne-border)",
                  cursor: clickable ? "pointer" : "default",
                  background: "var(--sorne-bg-surface)",
                },
              },
                this.props.columns.map((c) => h("td", {
                  key: c.key,
                  style: { padding: "6px 10px", verticalAlign: "top", color: "var(--sorne-text-primary)" },
                },
                  c.badge
                    ? StatusBadge(c.badge, typeof c.value === "function" ? c.value(row) : row[c.key])
                    : (typeof c.render === "function"
                      ? c.render(row)
                      : (row[c.key] === null || row[c.key] === undefined || typeof row[c.key] !== "object"
                        ? String(row[c.key] ?? "—（未提供）")
                        : FoldableObject(row[c.key], { level: 1 })))),
                ));
            })));
      }
    };
  }

  return h(TableBodyClass, { columns: cols, rows: data, rowKey, onRowClick, sortable });
}

/* ── 空态（给引导而不是摆设；评审 P2-11） ───────────────────────────── */

export function EmptyState({ title, hint, actions } = {}) {
  const { createElement: h } = requireBound("EmptyState");
  return h("div", {
    role: "status",
    style: {
      padding: "18px 16px", borderRadius: 8,
      border: "1px dashed var(--sorne-border-strong)",
      color: "var(--sorne-text-secondary)", fontSize: 14, lineHeight: 1.6,
    },
  },
    h("div", { style: { fontWeight: 600, color: "var(--sorne-text-primary)" } }, title || "（暂无内容）"),
    hint ? h("div", { style: { marginTop: 4 } }, hint) : null,
    actions && actions.length
      ? h("div", { style: { marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" } }, actions)
      : null,
  );
}
