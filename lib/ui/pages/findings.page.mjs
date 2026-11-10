/**
 * 页面：发现（lib/ui/pages/findings.page.mjs；M6 独占新增；BLUEPRINT-UI §1.5 发现 / §e-J3）。
 *
 * 只回答一个问题：有哪些值得关注的问题、证据到什么程度？
 *   - 主表（ui.DataTable，端点 #30 GET /vulnerabilities）：状态与复核状态分列
 *     （四态徽章 + 三态复核徽章），条件与证据入口、确认版本 JSON 折叠；
 *     行点击 → 右栏发现详情（?id=，§2.4-2 槽位契约）。
 *   - 详情：适用条件、证据索引（#14 evidence_index → #44 采集 → #43 原始字节）、
 *     验证经过（#29：Manifest / outcome / applied=0 未应用警示 / 等待时长 /
 *     reviewed_evidence_revision 实际值）、后续探索（#21 intents 按 basis_refs 关联）。
 *   - 「请求复核」= 发消息（#46）由协调 AI 转 #27 验证请求；页面没有任何直接改
 *     漏洞状态的入口（旧蓝图 §8.2 角色矩阵不变）。
 *   - 验证区「加载更多」用游标：主路径 cursor，兼容 next_after → after（P0-3）。
 *
 * 语义纪律（冻结原文，经设计系统词表/文案呈现，本页不改写）：
 * confirmed 永远带「（限指定条件）」、insufficient「证据不足：未确认，不伪装成已排除」、
 * falsified「不等于历史上不存在」；未应用意见显式保留不隐藏；数据时刻/已加载数据推导/
 * 不代表全量；未提供 ≠ 不存在（「—（未提供）」）；折叠不删记录。
 *
 * 页面契约（§2.5）：纯 ESM、不 import 任何包或 Node 内置模块、不使用浏览器本地存储、
 * 不用 React 钩子；export default { id, title, order, render, renderDetail }；
 * ctx = { React, h, api, router, ui, theme }；页面不自写编号/时间/哈希/JSON 渲染。
 */

function btnStyle(variant, disabled) {
  const base = {
    fontSize: 13, padding: "5px 12px", borderRadius: 6,
    border: "1px solid var(--sorne-border-strong)",
    background: "var(--sorne-bg-surface)", color: "var(--sorne-text-primary)",
    fontFamily: "inherit", lineHeight: 1.55,
  };
  if (variant === "primary") {
    base.background = "var(--sorne-brand)";
    base.color = "var(--sorne-on-brand)";
    base.borderColor = "var(--sorne-brand)";
  }
  if (variant === "quiet") {
    base.border = "1px solid transparent";
    base.background = "transparent";
    base.color = "var(--sorne-text-secondary)";
  }
  if (disabled) {
    base.opacity = 0.55;
    base.cursor = "default";
  } else {
    base.cursor = "pointer";
  }
  return base;
}

function errorMessage(e) {
  const err = e || {};
  const msg = err.message ? String(err.message) : String(err);
  return err.code ? `${err.code} · ${msg}` : msg;
}

/** 游标适配（P0-3）：规范名 next_cursor/cursor 优先；旧信封 next_after → after 兼容。 */
function cursorOf(data) {
  const d = data && typeof data === "object" ? data : {};
  if (typeof d.next_cursor === "string" && d.next_cursor) return { value: d.next_cursor, param: "cursor" };
  if (typeof d.next_after === "string" && d.next_after) return { value: d.next_after, param: "after" };
  return { value: null, param: "cursor" };
}

function mergeById(prev, next) {
  const seen = new Set(prev.map((r) => r && r.id).filter(Boolean));
  const out = [...prev];
  for (const r of next) {
    if (r && r.id && !seen.has(r.id)) {
      out.push(r);
      seen.add(r.id);
    }
  }
  return out;
}

/** 时长格式化：按已提供/可解析的毫秒数；不臆造。 */
function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (d > 0) return `${d} 天 ${h} 小时`;
  if (h > 0) return `${h} 小时 ${m} 分`;
  if (m > 0) return `${m} 分 ${s} 秒`;
  return `${s} 秒`;
}

function waitTextOf(job) {
  const status = job && job.status;
  if (status !== "pending" && status !== "in_progress") return null;
  if (typeof job.waiting_ms === "number" && Number.isFinite(job.waiting_ms)) {
    return `已等待约 ${formatDuration(job.waiting_ms)}（自任务创建时刻计）`;
  }
  if (!job.created_at) return "—（未提供）";
  const t = Date.parse(job.created_at);
  if (Number.isNaN(t)) return `时间无法解析：${job.created_at}`;
  return `已等待约 ${formatDuration(Date.now() - t)}（自任务创建时刻计）`;
}

function conditionsText(conditions) {
  if (!Array.isArray(conditions) || !conditions.length) return null;
  return conditions.map((c) => (typeof c === "string" ? c : JSON.stringify(c))).join("；");
}

function ver(value) {
  return value === null || value === undefined || value === "" ? "—（未提供）" : String(value);
}

/** 证据立场中文：只映射已知三者，未知原样（不写「未知类型」类猜测文案）。 */
function stanceLabel(stance) {
  if (stance === "supports") return "支持";
  if (stance === "contradicts") return "反对";
  if (stance === "neutral") return "中性";
  return stance ? String(stance) : "—（未提供）";
}

/** 记录自身的后续探索关联：意图的 basis_refs / prerequisite_refs 引用该发现。 */
function relatedIntents(intents, subjectId) {
  const out = [];
  for (const it of intents) {
    if (!it || typeof it !== "object") continue;
    const bases = Array.isArray(it.basis_refs) ? it.basis_refs : [];
    const prereqs = Array.isArray(it.prerequisite_refs) ? it.prerequisite_refs : [];
    if (bases.includes(subjectId) || prereqs.includes(subjectId)) out.push(it);
  }
  return out;
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export default {
  id: "findings",
  title: "发现",
  order: 50,

  render({ React, h, api, router, ui, theme }) {
    const ComponentBase =
      React && typeof React.Component === "function"
        ? React.Component
        : class PageComponentBase {
            constructor(props) {
              this.props = props || {};
            }
          };

    class FindingsBody extends ComponentBase {
      constructor(props) {
        super(props);
        this.state = {
          list: { phase: "loading", rows: [], total: null, nextCursor: null, hasMore: false, error: null, note: "" },
          filter: { status: "", review: "" },
          dataAt: null,
        };
        this.loadSeq = 0;
        this.load = this.load.bind(this);
      }

      componentDidMount() {
        this.load(null, { append: false });
      }

      projectId() {
        const r = this.props.router;
        return r && typeof r.projectId === "string" ? r.projectId : "";
      }

      buildPath(cursor, filter) {
        const pid = this.projectId();
        const q = new URLSearchParams({ project_id: pid, limit: "50" });
        if (filter.status) q.set("status", filter.status);
        if (filter.review) q.set("review", filter.review);
        if (cursor) q.set("cursor", cursor);
        return `/sorne/vulnerabilities?${q.toString()}`;
      }

      async load(cursor, { append }) {
        const { api } = this.props;
        if (typeof api !== "function") {
          this.setState({ list: { phase: "error", rows: [], total: null, nextCursor: null, hasMore: false, error: { message: "当前宿主未提供 API 通道" }, note: "" } });
          return;
        }
        const pid = this.projectId();
        if (!pid) {
          this.setState({ list: { phase: "empty", rows: [], total: null, nextCursor: null, hasMore: false, error: null, note: "缺少项目上下文" } });
          return;
        }
        const seq = ++this.loadSeq;
        this.setState((prev) => ({
          list: { ...prev.list, phase: append ? prev.list.phase : "loading", error: null },
        }));
        try {
          const data = await api(this.buildPath(cursor, this.state.filter));
          if (seq !== this.loadSeq) return;
          const rows = data && Array.isArray(data.vulnerabilities) ? data.vulnerabilities : null;
          if (!rows) {
            this.setState({ list: { phase: "unrecognized", rows: [], total: null, nextCursor: null, hasMore: false, error: null, note: "" }, dataAt: new Date().toISOString() });
            return;
          }
          const c = cursorOf(data);
          this.setState((prev) => ({
            list: {
              phase: "ready",
              rows: append ? mergeById(prev.list.rows, rows) : rows,
              total: typeof data.total === "number" ? data.total : null,
              nextCursor: c.value,
              hasMore: Boolean(data.has_more) || Boolean(c.value),
              error: null,
              note: typeof data.note === "string" ? data.note : "",
            },
            dataAt: new Date().toISOString(),
          }));
        } catch (e) {
          if (seq !== this.loadSeq) return;
          this.setState({ list: { phase: "error", rows: [], total: null, nextCursor: null, hasMore: false, error: e, note: "" }, dataAt: new Date().toISOString() });
        }
      }

      setFilter(patch) {
        const filter = { ...this.state.filter, ...patch };
        this.setState({ filter });
        this.load(null, { append: false });
      }

      detailHash(row) {
        const pid = this.projectId();
        return `#/p/${encodeURIComponent(pid)}/findings?id=${encodeURIComponent(row.id)}`;
      }

      openDetail(row) {
        const r = this.props.router;
        if (r && typeof r.open === "function") r.open(this.detailHash(row));
      }

      openRecord(id) {
        const r = this.props.router;
        if (r && typeof r.openRecord === "function") r.openRecord(id);
      }

      columns() {
        const { ui } = this.props;
        return [
          {
            key: "subject",
            label: "发现（编号与内容）",
            render: (row) => {
              const cond = conditionsText(row.conditions);
              return h("div", { style: { display: "flex", flexDirection: "column", gap: 2 } },
                h("div", { style: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" } },
                  ui.RecordIdChip(row.id, { projectId: this.projectId(), navigate: (id) => this.openRecord(id) })),
                h("div", { style: { fontSize: 13, color: "var(--sorne-text-secondary)", wordBreak: "break-all" } },
                  `类别：${row.category || "—（未提供）"} · 位置：${row.location || "—（未提供）"}`),
                h("div", { style: { fontSize: 13, color: "var(--sorne-text-muted)", wordBreak: "break-all" } },
                  `适用条件：${cond || "—（未提供）"}`));
            },
          },
          {
            key: "status",
            label: "状态",
            badge: "vulnerability_status",
            value: (row) => row.status,
          },
          {
            key: "review",
            label: "复核状态",
            badge: "review_status",
            value: (row) => row.review,
          },
          {
            key: "evidence",
            label: "证据入口",
            render: (row) => {
              const ev = row.evidence && typeof row.evidence === "object" ? row.evidence : null;
              const counts = ev
                ? `支持 ${ev.supports ?? "—"} · 反对 ${ev.contradicts ?? "—"} · 共 ${ev.total ?? "—"}`
                : "—（未提供）";
              return h("button", {
                type: "button",
                "aria-label": `查看发现 ${row.id} 的证据索引`,
                title: "打开发现详情，按证据索引经 /records 与采集读取原始证据",
                onClick: (e) => {
                  if (e && typeof e.stopPropagation === "function") e.stopPropagation();
                  this.openDetail(row);
                },
                style: { ...btnStyle("quiet"), textAlign: "left", whiteSpace: "normal" },
              }, counts);
            },
          },
          {
            key: "confirmed_version",
            label: "确认版本",
            render: (row) => {
              if (row.confirmed_version === null || row.confirmed_version === undefined || row.confirmed_version === "") {
                return "—（未提供）";
              }
              const version = row.confirmed_version;
              return h("span", {
                onClick: (e) => {
                  if (e && typeof e.stopPropagation === "function") e.stopPropagation();
                },
              }, ui.FoldableObject(version, { summary: "确认版本", level: 1 }));
            },
          },
        ];
      }

      renderTable() {
        const { h, ui } = this.props;
        return ui.DataTable({
          columns: this.columns(),
          rows: this.state.list.rows,
          rowKey: (row) => row.id,
          onRowClick: (row) => this.openDetail(row),
        });
      }

      render() {
        const { h, ui, router } = this.props;
        const { list, filter, dataAt } = this.state;
        const pid = this.projectId();

        if (!ui || typeof ui.formatTime !== "function" || typeof ui.StatusBadge !== "function") {
          return h("div", { style: WRAP },
            h("div", { role: "alert", style: CARD },
              h("div", { style: { fontWeight: 600 } }, "渲染器未就绪"),
              h("div", null, "发现页依赖设计系统渲染器（ui.StatusBadge / ui.DataTable / ui.RecordIdChip 等）；当前宿主未提供，页面降级呈现，不做数据猜测。")));
        }

        const children = [];
        children.push(h("div", { key: "head", style: { display: "flex", flexDirection: "column", gap: 4 } },
          h("h2", { style: { margin: 0, fontSize: 17, color: "var(--sorne-text-primary)" } }, "发现"),
          h("div", { style: { fontSize: 14, lineHeight: 1.6, color: "var(--sorne-text-secondary)" } },
            "哪些问题值得关注、证据到什么程度。状态与复核状态分列；点击行查看证据与验证经过。")));

        if (!pid) {
          children.push(ui.EmptyState({ key: "noproj", title: "缺少项目上下文", hint: "发现页在工作区内按当前项目读取；请从项目列表进入项目。" }));
          return h("div", { style: WRAP }, ...children);
        }

        // 服务端过滤（#30 status/review 参数）：筛选改变后回到第一页。
        const filters = [
          { key: "all", label: "全部", patch: { status: "", review: "" } },
          { key: "suspected", label: "疑似", patch: { status: "suspected", review: "" } },
          { key: "confirmed", label: "已确认", patch: { status: "confirmed", review: "" } },
          { key: "falsified", label: "已证伪", patch: { status: "falsified", review: "" } },
          { key: "inconclusive", label: "证据不足", patch: { status: "inconclusive", review: "" } },
          { key: "pending-review", label: "待复核", patch: { status: "", review: "pending" } },
          { key: "disputed", label: "有争议", patch: { status: "", review: "disputed" } },
        ];
        children.push(h("div", { key: "filters", role: "group", "aria-label": "按状态与复核状态筛选", style: { display: "flex", gap: 6, flexWrap: "wrap" } },
          filters.map((f) => h("button", {
            key: f.key,
            type: "button",
            "aria-pressed": filter.status === f.patch.status && filter.review === f.patch.review ? "true" : "false",
            onClick: () => this.setFilter(f.patch),
            style: btnStyle(
              filter.status === f.patch.status && filter.review === f.patch.review ? "primary" : null,
              false,
            ),
          }, f.label))));

        if (list.phase === "loading") {
          children.push(h("div", { key: "loading", role: "status", style: MUTED }, "正在读取发现台账…"));
          return h("div", { style: WRAP }, ...children);
        }
        if (list.phase === "error") {
          children.push(h("div", { key: "error", role: "alert", style: { ...CARD, borderStyle: "dashed" } },
            h("div", { style: { fontWeight: 600, color: "var(--sorne-status-unknown-fg)" } }, "发现台账加载失败"),
            h("div", { style: MUTED }, errorMessage(list.error)),
            h("button", { type: "button", onClick: () => this.load(null, { append: false }), style: btnStyle(null) }, "重试")));
          return h("div", { style: WRAP }, ...children);
        }
        if (list.phase === "unrecognized") {
          children.push(h("div", { key: "shape", role: "alert", style: CARD },
            "台账响应形状无法识别（缺少 vulnerabilities 数组）——已按空列表呈现，不做猜测。"));
        }
        if (!list.rows.length) {
          children.push(ui.EmptyState({
            key: "empty",
            title: "暂无发现",
            hint: "worker 提交观察/疑似漏洞后，这里按状态与证据程度呈现；台账按已加载数据推导，不代表全量。",
          }));
        } else {
          children.push(h("div", { key: "table", style: { overflowX: "auto" } }, this.renderTable()));
          if (list.hasMore && list.nextCursor) {
            children.push(h("button", {
              key: "more",
              type: "button",
              "aria-label": "加载更多发现",
              onClick: () => this.load(list.nextCursor, { append: true }),
              style: btnStyle(null),
            }, "加载更多发现"));
          }
        }

        const loaded = list.rows.length;
        children.push(h("div", { key: "meta", style: { fontSize: 13, color: "var(--sorne-text-muted)" } },
          `数据时刻：${ui.formatTime(dataAt)} · 已加载 ${loaded}${typeof list.total === "number" ? ` / 共 ${list.total}` : ""} 条` +
          ` · 计数按已加载数据推导${list.hasMore ? "，不代表全量（还有未加载页）" : "，不代表全量"}`));

        if (list.note) {
          children.push(h("div", { key: "note", style: { fontSize: 13, color: "var(--sorne-text-secondary)", lineHeight: 1.6 } },
            `台账口径：${list.note}`));
        }

        children.push(h("details", { key: "semantics", style: SEMANTICS },
          h("summary", { style: { cursor: "pointer", fontSize: 13, color: "var(--sorne-text-secondary)" } }, "语义说明"),
          h("div", { style: { marginTop: 6, fontSize: 13, lineHeight: 1.7, color: "var(--sorne-text-secondary)" } },
            "confirmed 表示在指定条件下得到确认，不代表持续存在（规范 §8.2）；falsified 不等于历史上不存在，insufficient 不写作已排除（规范 §8.4）。",
            "复核状态（clear/pending/disputed）独立于结论状态，依赖检查不能只看状态字符串；本页不提供任何直接修改漏洞状态的入口。")));

        return h("div", { style: WRAP }, ...children);
      }
    }

    return h(FindingsBody, { React, h, api, router, ui, theme });
  },

  renderDetail({ React, h, api, router, ui, theme }) {
    const ComponentBase =
      React && typeof React.Component === "function"
        ? React.Component
        : class PageComponentBase {
            constructor(props) {
              this.props = props || {};
            }
          };

    class FindingDetail extends ComponentBase {
      constructor(props) {
        super(props);
        const id = props && props.subjectId ? props.subjectId : "";
        this.state = {
          id,
          record: { phase: "loading", data: null, error: null },
          jobs: { phase: "loading", items: [], nextCursor: null, cursorParam: "cursor", error: null },
          intents: { phase: "loading", items: [], error: null },
          members: {},
          blobs: {},
          compose: { open: false, content: "", phase: "idle", message: "", error: null },
        };
        this.loadSeq = 0;
      }

      projectId() {
        const r = this.props.router;
        return r && typeof r.projectId === "string" ? r.projectId : "";
      }

      componentDidMount() {
        this.loadRecord();
        this.loadJobs(null);
        this.loadIntents();
      }

      async loadRecord() {
        const { api } = this.props;
        const { id } = this.state;
        if (typeof api !== "function" || !id) {
          this.setState({ record: { phase: "error", data: null, error: { message: "缺少发现编号或 API 通道" } } });
          return;
        }
        this.setState({ record: { phase: "loading", data: null, error: null } });
        try {
          const data = await api(`/sorne/records/${encodeURIComponent(id)}?project_id=${encodeURIComponent(this.projectId())}`);
          this.setState({ record: { phase: "ready", data, error: null } });
        } catch (e) {
          this.setState({ record: { phase: "error", data: null, error: e } });
        }
      }

      async loadJobs(cursor) {
        const { api } = this.props;
        const { id } = this.state;
        if (typeof api !== "function" || !id) return;
        const param = this.state.jobs.cursorParam || "cursor";
        const q = new URLSearchParams({ project_id: this.projectId(), subject_id: id, limit: "20" });
        if (cursor) q.set(param, cursor);
        try {
          const data = await api(`/sorne/verification-jobs?${q.toString()}`);
          const rows = data && Array.isArray(data.jobs) ? data.jobs : null;
          if (!rows) {
            this.setState({ jobs: { phase: "unrecognized", items: [], nextCursor: null, cursorParam: param, error: null } });
            return;
          }
          const c = cursorOf(data);
          this.setState((prev) => ({
            jobs: {
              phase: "ready",
              items: cursor ? [...prev.jobs.items, ...rows] : rows,
              nextCursor: c.value,
              cursorParam: c.param,
              error: null,
            },
          }));
        } catch (e) {
          this.setState((prev) => ({ jobs: { ...prev.jobs, phase: "error", error: e } }));
        }
      }

      async loadIntents() {
        const { api } = this.props;
        if (typeof api !== "function") return;
        try {
          const data = await api(`/sorne/intents?project_id=${encodeURIComponent(this.projectId())}&limit=100`);
          const rows = data && Array.isArray(data.intents) ? data.intents : [];
          this.setState({ intents: { phase: "ready", items: rows, error: null } });
        } catch (e) {
          this.setState({ intents: { phase: "error", items: [], error: e } });
        }
      }

      /** 证据索引下钻：#14 成员记录 → #44 采集 → #43 原始字节（按需，逐成员缓存）。 */
      async expandMember(member) {
        const { api } = this.props;
        const memberId = member && member.member_id;
        if (typeof api !== "function" || !memberId) return;
        const prev = this.state.members[memberId] || {};
        this.setState((s) => ({ members: { ...s.members, [memberId]: { ...prev, phase: "loading", error: null } } }));
        try {
          const rec = await api(`/sorne/records/${encodeURIComponent(memberId)}?project_id=${encodeURIComponent(this.projectId())}`);
          const record = rec && rec.record ? rec.record : null;
          let capture = null;
          if (record && record.capture_id) {
            try {
              const cap = await api(`/sorne/captures/${encodeURIComponent(record.capture_id)}?project_id=${encodeURIComponent(this.projectId())}`);
              capture = cap && cap.capture ? cap.capture : cap;
            } catch (e) {
              capture = { error: e };
            }
          }
          this.setState((s) => ({ members: { ...s.members, [memberId]: { phase: "ready", record, capture, error: null } } }));
        } catch (e) {
          this.setState((s) => ({ members: { ...s.members, [memberId]: { phase: "error", record: null, capture: null, error: e } } }));
        }
      }

      async readBlob(sha256) {
        const { api } = this.props;
        if (typeof api !== "function" || !sha256) return;
        this.setState((s) => ({ blobs: { ...s.blobs, [sha256]: { phase: "loading", data: null, error: null } } }));
        try {
          const data = await api(`/sorne/evidence/blobs/${encodeURIComponent(sha256)}?project_id=${encodeURIComponent(this.projectId())}`);
          this.setState((s) => ({ blobs: { ...s.blobs, [sha256]: { phase: "ready", data, error: null } } }));
        } catch (e) {
          this.setState((s) => ({ blobs: { ...s.blobs, [sha256]: { phase: "error", data: null, error: e } } }));
        }
      }

      openRecord(id) {
        const r = this.props.router;
        if (r && typeof r.openRecord === "function") r.openRecord(id);
      }

      openCompose() {
        const record = this.state.record.data && this.state.record.data.record ? this.state.record.data.record : {};
        const conditions = conditionsText(record.conditions) || "—（未提供）";
        const content = [
          `请为 ${this.state.id} 安排一次独立验证复核。`,
          `待核实判断：${record.category || "—（未提供）"} @ ${record.location || "—（未提供）"}`,
          `适用条件：${conditions}`,
          "请说明结论与证据缺口；本请求由协调 AI 转交验证流程，不由用户直接改状态。",
        ].join("\n");
        this.setState({ compose: { open: true, content, phase: "idle", message: "", error: null } });
      }

      /** 请求复核 = 用户消息（#46）；由协调 AI 转 #27，页面不直接改状态。 */
      async sendReviewRequest() {
        const { api } = this.props;
        const { compose } = this.state;
        const content = String(compose.content || "").trim();
        if (typeof api !== "function") return;
        if (!content) {
          this.setState((s) => ({ compose: { ...s.compose, phase: "error", error: { message: "请填写复核请求内容" } } }));
          return;
        }
        this.setState((s) => ({ compose: { ...s.compose, phase: "sending", error: null } }));
        try {
          const data = await api(`/sorne/projects/${encodeURIComponent(this.projectId())}/messages`, {
            method: "POST",
            body: JSON.stringify({ content }),
          });
          const status = data && data.message && data.message.status ? data.message.status : "received";
          this.setState((s) => ({ compose: { ...s.compose, phase: "sent", message: status, error: null } }));
        } catch (e) {
          this.setState((s) => ({ compose: { ...s.compose, phase: "error", error: e } }));
        }
      }

      renderJobs() {
        const { h, ui } = this.props;
        const { jobs } = this.state;
        const children = [h("div", { key: "title", style: SECTION_TITLE }, "验证经过")];
        if (jobs.phase === "loading") {
          children.push(h("div", { key: "loading", style: MUTED }, "正在读取验证任务…"));
          return children;
        }
        if (jobs.phase === "error") {
          children.push(h("div", { key: "err", style: { ...MUTED, color: "var(--sorne-status-unknown-fg)" } },
            `验证任务读取失败：${errorMessage(jobs.error)}`));
          return children;
        }
        if (!jobs.items.length) {
          children.push(h("div", { key: "none", style: MUTED },
            "尚无验证任务；验证由协调/验证角色经验证请求流程发起，本页不直接提交验证结果。"));
          return children;
        }
        children.push(h("div", { key: "list", style: { display: "flex", flexDirection: "column", gap: 8 } },
          jobs.items.map((job, jobIdx) => {
            const wait = waitTextOf(job);
            const manifest = job.manifest && typeof job.manifest === "object" ? job.manifest : null;
            const result = job.latest_result && typeof job.latest_result === "object" ? job.latest_result : null;
            const block = [
              h("div", { key: "head", style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" } },
                h("span", { style: { fontWeight: 600 } }, job.id || "—（编号未提供）"),
                ui.StatusBadge("job_status", job.status),
                job.subject_kind ? ui.StatusBadge("subject_kind", job.subject_kind) : null,
                h("span", { style: { fontSize: 13, color: "var(--sorne-text-muted)" } },
                  `判断修订：${ver(job.claim_revision)} · 条件快照：${ver(job.condition_snapshot_id)}`)),
              h("div", { key: "policy", style: { fontSize: 13, color: "var(--sorne-text-secondary)" } },
                `策略：${ver(job.policy_id)}（版本 ${ver(job.policy_version)}） · 预期版本：状态 ${ver(job.expected && job.expected.state_version)} · 证据集 ${ver(job.expected && job.expected.evidence_revision)} · 评估纪元 ${ver(job.expected && job.expected.assessment_epoch)}`),
              h("div", { key: "manifest", style: { fontSize: 13, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" } },
                "所审阅证据清单（Manifest）：",
                manifest
                  ? h("span", { style: { display: "inline-flex", gap: 4, alignItems: "center", flexWrap: "wrap" } },
                      `${ver(manifest.id)} · 成员 ${ver(manifest.members_count)} · 证据集版本 ${ver(manifest.evidence_revision)} · 内容哈希 `,
                      ui.formatHash(manifest.content_hash))
                  : ver(job.evidence_manifest_id)),
              wait ? h("div", { key: "wait", style: { fontSize: 13, color: "var(--sorne-text-secondary)" } }, `等待时长：${wait}`) : null,
              result ? this.renderResult(result, ui, h) : h("div", { key: "noresult", style: MUTED },
                "该任务尚无验证结论；结论由验证身份经验证结果提交流程给出。"),
            ];
            return h("div", { key: job.id || `job-${jobIdx}`, style: CARD }, block.filter(Boolean));
          })));
        if (jobs.nextCursor) {
          children.push(h("button", {
            key: "more",
            type: "button",
            "aria-label": "加载更多验证任务",
            onClick: () => this.loadJobs(jobs.nextCursor),
            style: btnStyle(null),
          }, "加载更多验证任务"));
        }
        return children;
      }

      renderResult(result, ui, h) {
        const revisions = [
          `验证者：${ver(result.verifier_identity)}`,
          `审阅清单：${ver(result.reviewed_manifest_id)}`,
          `审阅证据集版本：${ver(result.reviewed_evidence_revision)}`,
        ].join(" · ");
        return h("div", { key: "result", style: { display: "flex", flexDirection: "column", gap: 3, borderTop: "1px dashed var(--sorne-border)", paddingTop: 6 } },
          h("div", { style: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" } },
            "验证结论：", ui.StatusBadge("outcome", result.outcome)),
          h("div", { style: { fontSize: 13, color: "var(--sorne-text-secondary)", wordBreak: "break-all" } }, revisions),
          result.applied === true
            ? h("div", { style: { fontSize: 13, color: "var(--sorne-text-secondary)" } }, "状态转换：已应用（预期版本全部匹配且检查通过）。")
            : result.applied === false
              ? h("div", { role: "alert", style: { fontSize: 13, fontWeight: 600, color: "var(--sorne-status-unknown-fg)" } },
                  "状态转换：未应用——验证意见已保存，标记需复核，不覆盖新结论。")
              : h("div", { style: { fontSize: 13, color: "var(--sorne-text-muted)" } }, "状态转换：—（未提供）"));
      }

      renderEvidence() {
        const { h, ui } = this.props;
        const data = this.state.record.data;
        const index = data && Array.isArray(data.evidence_index) ? data.evidence_index : [];
        if (!index.length) return [h("div", { key: "title", style: SECTION_TITLE }, "证据索引"), h("div", { key: "none", style: MUTED }, "—（未提供）")];
        return [
          h("div", { key: "title", style: SECTION_TITLE }, "证据索引"),
          h("div", { key: "list", style: { display: "flex", flexDirection: "column", gap: 8 } },
            index.map((member, i) => {
              const mid = member.member_id;
              const detail = this.state.members[mid] || { phase: "idle" };
              return h("div", { key: `${mid}-${i}`, style: CARD },
                h("div", { style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" } },
                  h("span", { style: { fontSize: 13, color: "var(--sorne-text-secondary)" } },
                    `${stanceLabel(member.stance)} · ${member.member_kind || "—（未提供）"} · 状态 ${member.status || "—（未提供）"}`),
                  mid ? ui.RecordIdChip(mid, { projectId: this.projectId(), navigate: (id) => this.openRecord(id) }) : null,
                  h("button", {
                    type: "button",
                    "aria-label": `读取证据成员 ${mid} 的采集与原始证据`,
                    onClick: () => this.expandMember(member),
                    style: btnStyle("quiet"),
                  }, detail.phase === "ready" ? "收起采集明细" : "读取采集与原始证据")),
                detail.phase === "loading" ? h("div", { style: MUTED }, "正在读取采集与原始字节…") : null,
                detail.phase === "error" ? h("div", { style: { ...MUTED, color: "var(--sorne-status-unknown-fg)" } },
                  `读取失败：${errorMessage(detail.error)}`) : null,
                detail.phase === "ready" ? this.renderMemberDetail(member, detail, ui, h) : null);
            }))
        ];
      }

      renderMemberDetail(member, detail, ui, h) {
        const record = detail.record || {};
        const capture = detail.capture || null;
        const blob = capture && capture.response_body_blob ? capture.response_body_blob : null;
        const sha = blob && (blob.sha256 || blob.hash) ? (blob.sha256 || blob.hash) : null;
        const blobState = sha ? this.state.blobs[sha] : null;
        return h("div", { style: { marginTop: 6, display: "flex", flexDirection: "column", gap: 3, fontSize: 13 } },
          h("div", { style: MUTED }, `成员记录：${record.statement || record.id || "—（未提供）"}`),
          record.capture_id
            ? h("div", { style: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" } },
                "采集：", ui.RecordIdChip(record.capture_id, { projectId: this.projectId(), navigate: (id) => this.openRecord(id) }))
            : h("div", { style: MUTED }, "采集：—（未提供）"),
          capture && capture.error
            ? h("div", { style: { ...MUTED, color: "var(--sorne-status-unknown-fg)" } }, `采集读取失败：${errorMessage(capture.error)}`)
            : null,
          capture && !capture.error
            ? h("div", { style: { display: "flex", flexDirection: "column", gap: 2, color: "var(--sorne-text-secondary)" } },
                h("div", null, `条件快照：${ver(capture.condition_snapshot_id)} · 完整性：${ver(capture.integrity_status)}`),
                h("div", { style: { display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap", wordBreak: "break-all" } },
                  "响应体：", blob ? ui.formatHash(sha) : "—（未提供）"),
                blob
                  ? h("div", { style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" } },
                      h("button", {
                        type: "button",
                        "aria-label": `读取原始证据字节 ${sha}`,
                        onClick: () => this.readBlob(sha),
                        style: btnStyle("quiet"),
                      }, "读取原始字节"),
                      h("span", { style: MUTED }, "原始字节按需读取，不在页面缓存复制"))
                  : null)
            : null,
          blobState && blobState.phase === "loading" ? h("div", { style: MUTED }, "正在读取原始字节…") : null,
          blobState && blobState.phase === "error" ? h("div", { style: { ...MUTED, color: "var(--sorne-status-unknown-fg)" } },
            `原始字节读取失败：${errorMessage(blobState.error)}`) : null,
          blobState && blobState.phase === "ready"
            ? h("pre", { style: { margin: "4px 0", padding: 8, borderRadius: 6, background: "var(--sorne-bg-subtle)", border: "1px solid var(--sorne-border)", fontSize: 13, overflow: "auto", maxHeight: 240, whiteSpace: "pre-wrap" } },
                typeof blobState.data === "string" ? blobState.data.slice(0, 2000) : blobState.data && blobState.data.raw ? String(blobState.data.raw).slice(0, 2000) : safeJson(blobState.data).slice(0, 2000))
            : null);
      }

      renderCompose() {
        const { h, ui } = this.props;
        const compose = this.state.compose;
        return h("div", { key: "compose", style: { display: "flex", flexDirection: "column", gap: 6 } },
          h("div", { style: SECTION_TITLE }, "请求复核"),
          h("div", { style: { fontSize: 13, color: "var(--sorne-text-secondary)" } },
            "请求复核以用户消息提交，由协调 AI 转为独立验证请求；页面不直接修改漏洞状态。"),
          !compose.open
            ? h("button", { type: "button", onClick: () => this.openCompose(), style: btnStyle(null) }, "请求复核（经协调 AI）")
            : h("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
                h("textarea", {
                  "aria-label": "复核请求内容",
                  value: compose.content,
                  rows: 5,
                  onChange: (e) => this.setState((s) => ({ compose: { ...s.compose, content: e.target.value } })),
                  style: { width: "100%", boxSizing: "border-box", padding: "6px 9px", fontSize: 13, fontFamily: "inherit", borderRadius: 6, border: "1px solid var(--sorne-border-strong)", background: "var(--sorne-bg-surface)", color: "var(--sorne-text-primary)" },
                }),
                h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
                  h("button", {
                    type: "button",
                    disabled: compose.phase === "sending",
                    onClick: () => this.sendReviewRequest(),
                    style: btnStyle("primary", compose.phase === "sending"),
                  }, compose.phase === "sending" ? "正在提交…" : "发送复核请求"),
                  h("button", { type: "button", onClick: () => this.setState((s) => ({ compose: { ...s.compose, open: false } })), style: btnStyle("quiet") }, "取消")),
                compose.phase === "error" ? h("div", { role: "alert", style: { fontSize: 13, color: "var(--sorne-status-unknown-fg)" } }, errorMessage(compose.error)) : null,
                compose.phase === "sent"
                  ? h("div", { role: "status", style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: 13, color: "var(--sorne-text-secondary)" } },
                      "已提交：", ui.StatusBadge("message_status", compose.message),
                      "消息已交协调 AI（尚未处理，不等于已答复）；本页不直接修改漏洞状态。")
                  : null));
      }

      renderFollowUps() {
        const { h, ui } = this.props;
        const { intents } = this.state;
        const related = relatedIntents(intents.items || [], this.state.id);
        const children = [h("div", { key: "title", style: SECTION_TITLE }, "后续探索")];
        if (intents.phase === "loading") {
          children.push(h("div", { key: "loading", style: MUTED }, "正在读取意图…"));
          return children;
        }
        if (intents.phase === "error") {
          children.push(h("div", { key: "err", style: { ...MUTED, color: "var(--sorne-status-unknown-fg)" } },
            `意图读取失败：${errorMessage(intents.error)}`));
          return children;
        }
        children.push(h("div", { key: "note", style: { fontSize: 13, color: "var(--sorne-text-muted)" } },
          "按已加载意图推导（basis_refs / prerequisite_refs 引用该发现），不代表全量。"));
        if (!related.length) {
          children.push(h("div", { key: "none", style: MUTED }, "—（未提供）"));
          return children;
        }
        children.push(h("div", { key: "list", style: { display: "flex", flexDirection: "column", gap: 4 } },
          related.map((it) => h("div", { key: it.id, style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: 13 } },
            ui.RecordIdChip(it.id, { projectId: this.projectId(), navigate: (id) => this.openRecord(id) }),
            ui.StatusBadge("intent_status", it.status),
            h("span", { style: { color: "var(--sorne-text-secondary)" } }, it.question || "—（未提供）")))));
        return children;
      }

      render() {
        const { h, ui } = this.props;
        const { id, record } = this.state;
        if (!ui || typeof ui.StatusBadge !== "function") {
          return h("div", { role: "alert", style: CARD }, "渲染器未就绪：详情依赖设计系统组件。");
        }
        if (!id) {
          return h("div", { style: CARD }, h("div", { style: { fontWeight: 600 } }, "未选择发现"),
            h("div", { style: MUTED }, "从台账点击一行，或使用 ?id= 深链打开发现详情。"));
        }
        const children = [h("div", { key: "head", style: { display: "flex", flexDirection: "column", gap: 4 } },
          h("div", { style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" } },
            h("h3", { style: { margin: 0, fontSize: 16, color: "var(--sorne-text-primary)" } }, "发现详情"),
            ui.RecordIdChip(id, { projectId: this.projectId(), navigate: (recId) => this.openRecord(recId) })),
          h("div", { style: { fontSize: 13, color: "var(--sorne-text-muted)" } }, "详情为只读视图；请求复核走消息，由协调 AI 转验证流程。"))];

        if (record.phase === "loading") {
          children.push(h("div", { key: "loading", role: "status", style: MUTED }, `正在读取记录 ${id}…`));
          return h("div", { style: DETAIL_WRAP }, ...children);
        }
        if (record.phase === "error") {
          children.push(h("div", { key: "err", role: "alert", style: CARD },
            h("div", { style: { fontWeight: 600, color: "var(--sorne-status-unknown-fg)" } }, "记录读取失败"),
            h("div", { style: MUTED }, errorMessage(record.error)),
            h("button", { type: "button", onClick: () => this.loadRecord(), style: btnStyle(null) }, "重试")));
          return h("div", { style: DETAIL_WRAP }, ...children);
        }

        const data = record.data || {};
        const subject = data.record && typeof data.record === "object" ? data.record : {};
        const cond = conditionsText(subject.conditions);
        children.push(h("div", { key: "summary", style: { ...CARD, display: "flex", flexDirection: "column", gap: 4 } },
          h("div", { style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" } },
            ui.StatusBadge("vulnerability_status", subject.status),
            ui.StatusBadge("review_status", subject.review),
            h("span", { style: { fontSize: 13, color: "var(--sorne-text-secondary)" } },
              `${subject.category || "—（未提供）"} @ ${subject.location || "—（未提供）"}`)),
          h("div", { style: { fontSize: 13 } }, `适用条件：${cond || "—（未提供）"}`),
          h("div", { style: { fontSize: 13, color: "var(--sorne-text-secondary)" } },
            `判断修订：${ver(subject.claim_revision)} · 证据集版本：${ver(subject.evidence_revision)} · 评估纪元：${ver(subject.assessment_epoch)}`),
          subject.confirmed_version !== null && subject.confirmed_version !== undefined
            ? h("div", { style: { fontSize: 13 } }, "确认版本（限指定条件）：", ui.FoldableObject(subject.confirmed_version, { summary: "确认版本", level: 1 }))
            : h("div", { style: { fontSize: 13, color: "var(--sorne-text-muted)" } }, "确认版本：—（未提供）")));
        children.push(h("div", { key: "evidence", style: { display: "flex", flexDirection: "column", gap: 4 } }, ...this.renderEvidence()));
        children.push(h("div", { key: "verification", style: { display: "flex", flexDirection: "column", gap: 6 } }, ...this.renderJobs()));
        children.push(h("div", { key: "followups", style: { display: "flex", flexDirection: "column", gap: 4 } }, ...this.renderFollowUps()));
        children.push(h("div", { key: "compose", style: { ...CARD, display: "flex", flexDirection: "column", gap: 6 } }, this.renderCompose()));
        children.push(h("div", { key: "meta", style: { fontSize: 13, color: "var(--sorne-text-muted)" } },
          `数据时刻：${ui.formatTime(new Date().toISOString())} · 记录、证据索引与验证任务均按本次读取推导`));
        return h("div", { style: DETAIL_WRAP }, ...children);
      }
    }

    const subjectId = router && router.params && router.params.id ? String(router.params.id) : "";
    return h(FindingDetail, { React, h, api, router, ui, theme, subjectId });
  },
};

const WRAP = { display: "flex", flexDirection: "column", gap: 12, width: "100%" };
const DETAIL_WRAP = { display: "flex", flexDirection: "column", gap: 10, fontSize: 13 };
const MUTED = { fontSize: 13, color: "var(--sorne-text-secondary)", lineHeight: 1.6 };
const SECTION_TITLE = { fontSize: 13, fontWeight: 600, color: "var(--sorne-text-primary)" };
const CARD = {
  padding: "8px 10px", borderRadius: 8, fontSize: 13, lineHeight: 1.6,
  border: "1px solid var(--sorne-border)", background: "var(--sorne-bg-surface)",
};
const SEMANTICS = {
  marginTop: 4, padding: "8px 10px", borderRadius: 8,
  border: "1px dashed var(--sorne-border-strong)", fontSize: 13,
};
