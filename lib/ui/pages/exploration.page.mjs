/**
 * 页面：探索（lib/ui/pages/exploration.page.mjs；M5 独占重写；BLUEPRINT-UI §1.5 / §g exploration）。
 *
 * 回答一个问题：为什么沿这些方向、推进到哪了？
 *   - 方向列表为主视图：每条方向呈现目标（target_asset_ids）、依据（basis_refs）、
 *     前提（prerequisite_refs）、进展（提交序号 / 状态版本 / 计划修订）、阻塞
 *     （resume_conditions）、后续（依赖它的方向）；
 *   - 局部分支图为第二视图（view=graph）：所选方向及其直接依据/目标/前提（1 跳），
 *     关系以真实编号 chip 呈现；完整大图为辅助视图（view=full，全部关系边与判断清单）；
 *   - 数据来源：#13 exploration_map（方向分组/依据/未解决问题/关系边）+
 *     #21 intents（完整意图合同：恢复条件、预算、成功标准等）+#14 records（详情）。
 *   - 操作 = 消息草稿（追问 / 建议暂缓）：POST /sorne/messages，由协调 AI 决策；
 *     用户操作不直接改方向状态（恢复与重派由协调 AI 决定，程序不写死固定重试）。
 *
 * 页面契约：纯 ESM、零 import、不用浏览器本地存储；有状态部分收敛为单个
 * React.Component 子类；颜色全走设计系统 token；编号一律经 ui.RecordIdChip
 * （唯一实现 lib/ui/record-ids.mjs，本页不含编号正则）；时间/徽章/字段由 ui 渲染器负责。
 * 右侧详情由 renderDetail(ctx) 渲染（外壳槽位契约）。
 *
 * 语义纪律（冻结原文见渲染器 VOCAB）：resolved 只表示该版本的问题已处理，不代表
 * 关联资产已测透（规范 §10.1）；恢复与重派由协调 AI 决定，程序不写死固定重试
 * （规范 §3.1/§3.2）；未提供 ≠ 不存在；数据时刻 / 截止边界 / 不代表全量；折叠不删记录。
 */

const KIND_LABELS = {
  investigate: "调查",
  collect: "采集",
  verify: "验证",
  revisit: "回访",
};

const RELATION_LABELS = {
  targets: "指向",
  supports: "支持",
  contradicts: "反对",
  requires: "前提",
  derived_from: "派生自",
  discovered_from: "发现来源",
  related_to: "相关",
};

const EDGE_GROUP_LABELS = {
  requires: "前提关系（requires）",
  supports: "支持关系（supports）",
  contradicts: "反对关系（contradicts）",
  targets: "指向关系（targets）",
  derived_from: "派生关系（derived_from）",
  discovered_from: "发现来源（discovered_from）",
  related_to: "相关关系（related_to）",
};

function kindLabel(kind) {
  if (kind === null || kind === undefined || kind === "") return "—（未提供）";
  const raw = String(kind);
  return KIND_LABELS[raw] ? KIND_LABELS[raw] + "（" + raw + "）" : "未登记类型（" + raw + "）";
}

function relationLabel(type) {
  if (!type) return "—（未提供）";
  const raw = String(type);
  return RELATION_LABELS[raw] || raw;
}

function errorMessage(e) {
  const err = e || {};
  const msg = err.message ? String(err.message) : String(err);
  return err.code ? err.code + " · " + msg : msg;
}

function isUnimplemented(e) {
  return Boolean(e && (e.code === "NOT_IMPLEMENTED" || e.status === 501));
}

function asArray(v) {
  return Array.isArray(v) ? v.filter((x) => x !== null && x !== undefined && x !== "") : [];
}

/* ── 样式（全部为设计系统 token；正文 13–14px） ────────────────────── */

const WRAP = { display: "flex", flexDirection: "column", gap: 14, width: "100%" };
const CARD = {
  border: "1px solid var(--sorne-border)",
  borderRadius: 8,
  background: "var(--sorne-bg-surface)",
  padding: "10px 14px",
  display: "flex",
  flexDirection: "column",
  gap: 6,
};
const ROW = { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "baseline" };
const H2 = { margin: 0, fontSize: 17, color: "var(--sorne-text-primary)" };
const H3 = { margin: "2px 0", fontSize: 14.5, color: "var(--sorne-text-primary)" };
const H4 = { margin: "2px 0", fontSize: 14, color: "var(--sorne-text-primary)" };
const HINT = { fontSize: 13.5, lineHeight: 1.6, color: "var(--sorne-text-secondary)" };
const MUTED = { fontSize: 13, lineHeight: 1.6, color: "var(--sorne-text-muted)" };

function btnStyle(variant, disabled) {
  const base = {
    fontSize: 13,
    padding: "5px 12px",
    borderRadius: 6,
    border: "1px solid var(--sorne-border-strong)",
    background: "var(--sorne-bg-surface)",
    color: "var(--sorne-text-primary)",
    fontFamily: "inherit",
    lineHeight: 1.55,
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

const INPUT = {
  fontSize: 13.5,
  padding: "5px 8px",
  borderRadius: 6,
  border: "1px solid var(--sorne-border-strong)",
  background: "var(--sorne-bg-surface)",
  color: "var(--sorne-text-primary)",
  fontFamily: "inherit",
  minWidth: 160,
};

/* ── 展示辅助 ─────────────────────────────────────────────────────── */

function chip(h, ui, router, id, projectId) {
  if (id === null || id === undefined || id === "") return h("span", { style: MUTED }, "—（未提供）");
  if (ui && typeof ui.RecordIdChip === "function") {
    return ui.RecordIdChip(String(id), {
      projectId,
      navigate: (full) => {
        if (router && typeof router.openRecord === "function") router.openRecord(full);
      },
    });
  }
  return String(id);
}

function chipList(h, ui, router, ids, projectId, emptyText) {
  const list = asArray(ids);
  if (!list.length) return h("span", { style: MUTED }, emptyText || "—（未提供）");
  return h("span", { style: ROW }, ...list.map((id, i) => h("span", { key: String(id) + i }, chip(h, ui, router, id, projectId))));
}

function foldingNoteNodes(h, ui, notes, projectId) {
  if (notes === null || notes === undefined || notes === "") return h("div", { style: MUTED }, "（本快照未声明折叠或省略）");
  if (typeof notes === "string") return h("div", { style: HINT }, notes);
  if (!Array.isArray(notes)) return h("div", { style: HINT }, String(notes));
  if (!notes.length) return h("div", { style: MUTED }, "（无折叠或省略事项）");
  return h("ul", { style: { margin: "2px 0 0", paddingLeft: 18, ...HINT } },
    ...notes.map((note, i) => {
      const n = note || {};
      const section = n.section || "说明";
      const count = n.total_folded !== undefined ? n.total_folded : (n.count !== undefined ? n.count : n.groups);
      const bits = [String(section)];
      if (count !== undefined && count !== null) bits.push("已折叠 " + String(count) + " 项");
      if (n.groups !== undefined && n.total_folded !== undefined) bits.push(String(n.groups) + " 组");
      if (n.reason) bits.push(String(n.reason));
      return h("li", { key: "fn" + i },
        bits.join(" · "),
        Array.isArray(n.refs) && n.refs.length
          ? h("span", { style: ROW }, "（样本：", ...n.refs.map((id, j) => h("span", { key: "r" + j }, chip(h, ui, null, id, projectId))), "）")
          : null,
      );
    }));
}

function projectionScopeText(scope) {
  if (!scope || typeof scope !== "object") return "—（未提供）";
  const parts = [];
  if (scope.project_id) parts.push("项目 " + String(scope.project_id));
  const fold = scope.fold_since;
  if (fold !== undefined) parts.push("折叠边界：" + (fold === null ? "未启用" : "提交序号 " + String(fold)));
  if (scope.limits && typeof scope.limits === "object") {
    const items = Object.keys(scope.limits).sort().map((k) => k + " " + String(scope.limits[k]));
    if (items.length) parts.push("上限：" + items.join(" · "));
  }
  return parts.join(" · ");
}

function makeBase(React) {
  return React && typeof React.Component === "function"
    ? React.Component
    : class PageComponentBase {
        constructor(props) {
          this.props = props || {};
        }
      };
}

export default {
  id: "exploration",
  title: "探索",
  order: 40,

  render({ React, h, api, router, ui, theme }) {
    const ComponentBase = makeBase(React);

    class ExplorationBody extends ComponentBase {
      constructor(props) {
        super(props);
        const p = props.router && props.router.params ? props.router.params : {};
        this.state = {
          map: { phase: "loading", data: null, error: null, unknownShape: false },
          intents: { phase: "loading", rows: [], nextCursor: null, hasMore: false, error: null, unknownShape: false },
          view: p.view || "list",
          chain: { phase: "idle", data: null, error: null },
          zoom: 1,
          dataAt: null,
          navSeq: 0,
        };
        this.mapSeq = 0;
        this.intentSeq = 0;
        this.chainSeq = 0;
        this.onNav = this.onNav.bind(this);
        this.unsubNav = null;
      }

      componentDidMount() {
        this.loadMap();
        this.loadIntents();
        if (this.state.view === "chain") this.loadChain();
        const r = this.props.router;
        if (r && typeof r.onChange === "function") this.unsubNav = r.onChange(this.onNav);
      }

      componentWillUnmount() {
        if (typeof this.unsubNav === "function") this.unsubNav();
      }

      onNav() {
        const r = this.props.router;
        if (!r || r.page !== "exploration") return;
        const view = r.params && r.params.view ? String(r.params.view) : "list";
        this.setState((prev) => ({ navSeq: prev.navSeq + 1, view }));
        this.loadMap({ silent: true });
        this.loadIntents({ silent: true, append: false });
        if (view === "chain" && (this.state.chain.phase === "idle" || this.state.chain.phase === "error")) this.loadChain();
      }

      projectId() {
        const r = this.props.router;
        return r && r.projectId ? r.projectId : null;
      }

      selectedId() {
        const r = this.props.router;
        return r && r.params && r.params.id ? String(r.params.id) : null;
      }

      async loadMap({ silent } = {}) {
        const { api } = this.props;
        const projectId = this.projectId();
        if (!projectId) return;
        const seq = ++this.mapSeq;
        if (!silent) this.setState((prev) => ({ map: { ...prev.map, phase: "loading", error: null, unknownShape: false } }));
        try {
          const data = await api("/sorne/snapshots/exploration_map?project_id=" + encodeURIComponent(projectId));
          if (seq !== this.mapSeq) return;
          const content = data && data.content && typeof data.content === "object" ? data.content : null;
          const recognized = Boolean(content && (Array.isArray(content.directions) || Array.isArray(content.edges) || (content.judgements && typeof content.judgements === "object") || Array.isArray(content.ungrouped_intents)));
          this.setState({
            map: { phase: "ready", data: recognized ? data : null, error: null, unknownShape: !recognized },
            dataAt: new Date().toISOString(),
          });
        } catch (e) {
          if (seq !== this.mapSeq) return;
          this.setState({
            map: { phase: isUnimplemented(e) ? "unimplemented" : "error", data: null, error: e, unknownShape: false },
            dataAt: new Date().toISOString(),
          });
        }
      }

      async loadIntents({ silent, append, cursor } = {}) {
        const { api } = this.props;
        const projectId = this.projectId();
        if (!projectId) return;
        const seq = ++this.intentSeq;
        if (!silent) this.setState((prev) => ({ intents: { ...prev.intents, phase: append ? prev.intents.phase : "loading", error: null, unknownShape: false } }));
        const q = new URLSearchParams({ project_id: projectId, limit: "200" });
        if (cursor) q.set("cursor", String(cursor));
        try {
          const data = await api("/sorne/intents?" + q.toString());
          if (seq !== this.intentSeq) return;
          const rows = data && Array.isArray(data.intents) ? data.intents : null;
          if (!rows) {
            this.setState((prev) => ({ intents: { ...prev.intents, phase: "ready", unknownShape: true } }));
            return;
          }
          this.setState((prev) => ({
            intents: {
              phase: "ready",
              rows: append ? [...prev.intents.rows, ...rows] : rows,
              nextCursor: data && data.next_cursor ? data.next_cursor : null,
              hasMore: Boolean(data && data.has_more),
              error: null,
              unknownShape: false,
            },
          }));
        } catch (e) {
          if (seq !== this.intentSeq) return;
          this.setState((prev) => ({
            intents: { phase: isUnimplemented(e) ? "unimplemented" : "error", rows: append ? prev.intents.rows : [], nextCursor: null, hasMore: false, error: e, unknownShape: false },
          }));
        }
      }

      go(view) {
        const { router } = this.props;
        const projectId = this.projectId();
        if (!router || typeof router.open !== "function" || !projectId) return;
        const id = this.selectedId();
        let hash = "#/p/" + encodeURIComponent(projectId) + "/exploration?view=" + encodeURIComponent(view);
        if (id) hash += "&id=" + encodeURIComponent(id);
        router.open(hash);
        if (view === "chain") this.loadChain();
      }

      async loadChain({ silent } = {}) {
        const pid = this.projectId();
        if (!pid) return;
        const seq = ++this.chainSeq;
        if (!silent) this.setState((p) => ({ chain: { ...p.chain, phase: "loading", error: null } }));
        try {
          const data = await this.props.api("/sorne/projects/" + encodeURIComponent(pid) + "/lineage");
          if (seq !== this.chainSeq) return;
          this.setState({ chain: { phase: "ready", data, error: null } });
        } catch (e) {
          if (seq !== this.chainSeq) return;
          this.setState({ chain: { phase: "error", data: null, error: e } });
        }
      }

      renderChain() {
        const { h, ui, router } = this.props;
        const st = this.state.chain;
        if (st.phase === "loading") return h("div", { key: "chain-loading", role: "status", style: HINT }, "正在读取全链路…");
        if (st.phase === "error") {
          return h("div", { key: "chain-error", role: "alert", style: CARD },
            h("div", { style: H3 }, "全链路读取失败"),
            h("div", { style: HINT }, errorMessage(st.error)),
            h("button", { type: "button", "aria-label": "重试读取全链路", onClick: () => this.loadChain(), style: btnStyle(null) }, "重试"),
          );
        }
        const data = st.data;
        if (!data || !Array.isArray(data.nodes) || !data.nodes.length) {
          return h("div", { key: "chain-empty", style: CARD },
            h("div", { style: H3 }, "链路图"),
            h("div", { style: HINT }, "还没有可连接的记录：产生计划、意图、尝试或采集后，这里会按 计划 → 意图 → 尝试 → 采集 → 观察 → 假设/验证 → 漏洞 逐层展开。"),
          );
        }
        const KIND_COLORS = {
          start: "var(--sorne-brand)", plan: "var(--sorne-status-review-fg)", intent: "var(--sorne-status-ok-fg)",
          attempt: "var(--sorne-status-suspected-fg)", capture: "var(--sorne-brand)",
          observation: "var(--sorne-status-ok-fg)", hypothesis: "var(--sorne-status-suspected-fg)",
          verification: "var(--sorne-status-review-fg)", vulnerability: "var(--sorne-status-confirmed-fg)",
        };
        const KIND_TEXT = {
          start: "起点", plan: "计划", intent: "意图", attempt: "尝试", capture: "采集",
          observation: "观察", hypothesis: "假设", verification: "验证", vulnerability: "漏洞",
        };
        const byLayer = new Map();
        for (const n of data.nodes) {
          const l = Number(n.layer) || 0;
          if (!byLayer.has(l)) byLayer.set(l, []);
          byLayer.get(l).push(n);
        }
        const COL_W = 244, CARD_W = 214, CARD_H = 104, GAP_X = 78, GAP_Y = 22;
        const positions = new Map();
        let maxX = 0, maxY = 0;
        const layers = Array.from(byLayer.keys()).sort((a, b) => a - b);
        for (const layer of layers) {
          const arr = byLayer.get(layer).sort((a, b) => String(a.time || "").localeCompare(String(b.time || "")));
          arr.forEach((n, i) => {
            const x = layer * (COL_W + GAP_X);
            const y = i * (CARD_H + GAP_Y);
            positions.set(n.id, { x, y });
            maxX = Math.max(maxX, x + CARD_W);
            maxY = Math.max(maxY, y + CARD_H);
          });
        }
        const zoom = this.state.zoom || 1;
        const width = maxX + 40, height = maxY + 40;
        const edgeEls = [];
        for (const e of data.edges) {
          const a = positions.get(e.from), b = positions.get(e.to);
          if (!a || !b) continue;
          const x1 = a.x + CARD_W, y1 = a.y + CARD_H / 2;
          const x2 = b.x, y2 = b.y + CARD_H / 2;
          const dx = Math.max(40, Math.abs(x2 - x1) / 2);
          const d = "M" + x1 + "," + y1 + " C" + (x1 + dx) + "," + y1 + " " + (x2 - dx) + "," + y2 + " " + x2 + "," + y2;
          edgeEls.push(h("path", { key: "e-" + e.from + "-" + e.to + "-" + e.kind, d, fill: "none", stroke: "var(--sorne-border-strong)", strokeWidth: 1.4, opacity: 0.85 }));
          edgeEls.push(h("text", {
            key: "t-" + e.from + "-" + e.to + "-" + e.kind,
            x: (x1 + x2) / 2, y: (y1 + y2) / 2 - 4,
            fill: "var(--sorne-text-muted)", fontSize: 10, textAnchor: "middle",
          }, e.label || ""));
        }
        const nodeEls = data.nodes.map((n) => {
          const pos = positions.get(n.id);
          if (!pos) return null;
          const color = KIND_COLORS[n.kind] || "var(--sorne-border-strong)";
          const canOpen = n.ref && typeof router.openRecord === "function" && n.kind !== "start";
          return h("div", {
            key: "n-" + n.id,
            title: n.title + "\n" + (n.summary || "") + "\n" + n.id,
            onClick: canOpen ? () => router.openRecord(n.ref) : undefined,
            style: {
              position: "absolute", left: pos.x, top: pos.y, width: CARD_W, minHeight: CARD_H,
              boxSizing: "border-box", padding: "8px 10px", borderRadius: 8,
              background: "var(--sorne-bg-surface)", border: "1px solid var(--sorne-border)",
              borderLeft: "4px solid " + color, cursor: canOpen ? "pointer" : "default",
              overflow: "hidden", display: "flex", flexDirection: "column", gap: 3,
            },
          },
            h("div", { style: { display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: color, fontWeight: 700 } },
              h("span", null, KIND_TEXT[n.kind] || n.kind),
              n.status ? h("span", { style: { color: "var(--sorne-text-muted)", fontWeight: 400 } }, "· " + n.status) : null),
            h("div", {
              style: { fontSize: 12.5, fontWeight: 600, lineHeight: 1.35, color: "var(--sorne-text-primary)",
                display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" },
            }, n.title),
            h("div", {
              style: { fontSize: 11.5, lineHeight: 1.35, color: "var(--sorne-text-secondary)",
                display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" },
            }, n.summary || ""),
            h("div", { style: { marginTop: "auto", fontSize: 10.5, color: "var(--sorne-text-muted)", fontFamily: "ui-monospace, Menlo, monospace" } }, "#" + n.id),
          );
        });
        const legend = ["start", "plan", "intent", "attempt", "capture", "observation", "hypothesis", "verification", "vulnerability"];
        return h("div", { key: "chain", style: { ...CARD, display: "flex", flexDirection: "column", gap: 8, overflow: "hidden" } },
          h("div", { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
            h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
              legend.map((k) => h("span", { key: "lg-" + k, style: { display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11.5, color: "var(--sorne-text-secondary)" } },
                h("span", { style: { width: 9, height: 9, borderRadius: 2, background: KIND_COLORS[k], display: "inline-block" } }),
                KIND_TEXT[k]))),
            h("div", { style: { marginLeft: "auto", display: "flex", gap: 6 } },
              h("button", { type: "button", "aria-label": "放大链路图", onClick: () => this.setState((p) => ({ zoom: Math.min(1.6, (p.zoom || 1) + 0.1) })), style: btnStyle(null) }, "+"),
              h("button", { type: "button", "aria-label": "缩小链路图", onClick: () => this.setState((p) => ({ zoom: Math.max(0.5, (p.zoom || 1) - 0.1) })), style: btnStyle(null) }, "−"),
              h("button", { type: "button", "aria-label": "适应宽度", onClick: () => this.setState({ zoom: 1 }), style: btnStyle(null) }, "100%"),
            )),
          h("div", { style: { overflow: "auto", maxHeight: "62vh", border: "1px solid var(--sorne-border)", borderRadius: 8, background: "var(--sorne-bg-subtle)" } },
            h("div", { style: { position: "relative", width: width * zoom, height: height * zoom } },
              h("div", { style: { position: "absolute", left: 0, top: 0, width, height, transform: "scale(" + zoom + ")", transformOrigin: "top left" } },
                h("svg", { width, height, style: { position: "absolute", left: 0, top: 0, pointerEvents: "none" } }, ...edgeEls),
                ...nodeEls,
              ),
            ),
          ),
          h("div", { style: { fontSize: 11.5, color: "var(--sorne-text-muted)" } },
            "节点 " + data.nodes.length + " · 边 " + data.edges.length + (data.truncated ? " · 已达显示上限，完整记录请按编号打开" : "") + " · 点击节点打开对应记录"),
        );
      }

      openDetail(id) {
        const { router } = this.props;
        const projectId = this.projectId();
        if (!router || typeof router.open !== "function" || !projectId) return;
        const view = this.state.view || "list";
        router.open("#/p/" + encodeURIComponent(projectId) + "/exploration?view=" + encodeURIComponent(view) + "&id=" + encodeURIComponent(String(id)));
      }

      /* ── 数据合并：意图端点为主，快照为分组/阻塞补充；两侧都可降级 ── */

      mapContent() {
        const data = this.state.map.data;
        return (data && data.content) || null;
      }

      intentRows() {
        const intents = this.state.intents;
        const content = this.mapContent();
        if (intents.phase === "ready" && !intents.unknownShape) return intents.rows;
        if (content) {
          const briefs = [];
          for (const d of asArray(content.directions)) for (const it of asArray(d.intents)) briefs.push(it);
          for (const it of asArray(content.ungrouped_intents)) briefs.push(it);
          return briefs;
        }
        return [];
      }

      blockedConditions(id, intent) {
        const fromIntent = asArray(intent && intent.resume_conditions);
        if (fromIntent.length) return fromIntent;
        const content = this.mapContent();
        const blocked = content && content.unresolved ? asArray(content.unresolved.blocked_intents) : [];
        const hit = blocked.find((b) => b && b.id === id);
        return hit ? asArray(hit.resume_conditions) : [];
      }

      dependentsOf(id) {
        const rows = this.intentRows();
        return rows.filter((it) => asArray(it && it.prerequisite_refs).includes(id)).map((it) => it.id);
      }

      groups() {
        const content = this.mapContent();
        const rows = this.intentRows();
        const byId = new Map(rows.map((r) => [r && r.id, r]));
        const out = [];
        const seen = new Set();
        if (content) {
          for (const d of asArray(content.directions)) {
            const g = {
              goal_id: d.goal_id || null,
              statement: d.statement || "",
              status: d.status || null,
              intents: asArray(d.intents).map((b) => {
                const full = b && byId.get(b.id);
                return full ? { ...b, ...full } : b;
              }).filter(Boolean),
            };
            for (const it of g.intents) if (it && it.id) seen.add(it.id);
            out.push(g);
          }
          const ungrouped = asArray(content.ungrouped_intents).map((b) => {
            const full = b && byId.get(b.id);
            return full ? { ...b, ...full } : b;
          }).filter((x) => x && x.id && !seen.has(x.id));
          if (ungrouped.length) out.push({ goal_id: null, statement: "待归类方向", status: null, intents: ungrouped });
        }
        const leftovers = rows.filter((r) => r && r.id && !seen.has(r.id));
        if (leftovers.length) out.push({ goal_id: null, statement: content ? "待归类方向（意图端点补充）" : "全部方向（意图端点）", status: null, intents: leftovers });
        return out;
      }

      render() {
        const { h, ui } = this.props;
        const { map, intents, view, dataAt } = this.state;

        if (!ui || typeof ui.formatTime !== "function" || typeof ui.FieldRow !== "function") {
          return h("div", { style: WRAP },
            h("div", { role: "alert", style: CARD },
              h("div", { style: H2 }, "渲染器未就绪"),
              h("div", { style: HINT }, "探索页依赖设计系统渲染器（时间/编号/徽章/字段）。当前宿主未提供，页面以降级态呈现，不做数据猜测。"),
            ));
        }

        const projectId = this.projectId();
        const children = [];
        children.push(h("div", { key: "head", style: { display: "flex", flexDirection: "column", gap: 4 } },
          h("h2", { style: H2 }, "探索"),
          h("div", { style: HINT }, "这里回答：为什么沿这些方向、推进到哪了。方向列表为主视图，局部分支图看直接依据，完整大图为辅助视图。"),
        ));

        if (!projectId) {
          children.push(h("div", { key: "noproject", role: "status", style: CARD },
            h("div", { style: H3 }, "未选择项目"),
            h("div", { style: HINT }, "探索继承当前项目：请先在项目列表选择项目（#/projects），再回到本页。"),
          ));
          return h("div", { style: WRAP }, ...children);
        }

        children.push(this.renderViewSwitch(view));
        if (view === "chain") {
          children.push(this.renderChain());
          return h("div", { style: WRAP }, ...children);
        }
        if (map.phase !== "ready" || map.unknownShape) children.push(this.renderMapStatus(map));
        else children.push(this.renderSnapshotHeader(map.data));

        const content = this.mapContent();
        const rows = this.intentRows();
        const loading = (map.phase === "loading" && intents.phase === "loading");
        if (loading) {
          children.push(h("div", { key: "loading", role: "status", style: HINT }, "正在读取探索方向与快照…"));
          return h("div", { style: WRAP }, ...children);
        }

        if (intents.phase === "unimplemented" || intents.phase === "error") {
          children.push(this.renderIntentsStatus(intents));
        }
        if (intents.unknownShape) {
          children.push(h("div", { key: "intents-unknown", role: "alert", style: CARD },
            h("div", { style: H3 }, "意图队列形状无法识别"),
            h("div", { style: HINT }, "响应缺少 intents 数组——已按「无法识别」呈现，不猜测；方向列表回退为快照摘要（若有）。"),
          ));
        }

        if (!rows.length && map.phase !== "ready") {
          children.push(h("div", { key: "unavailable", style: CARD },
            h("div", { style: H3 }, "方向列表不可用"),
            h("div", { style: HINT }, "快照与意图端点均未提供数据：未实现 ≠ 没有方向，未提供 ≠ 不存在；稍后重试或经记录编号核对。"),
            h("div", null, h("button", { type: "button", "aria-label": "重试读取探索方向", onClick: () => { this.loadMap(); this.loadIntents(); }, style: btnStyle(null) }, "重试")),
          ));
          return h("div", { style: WRAP }, ...children);
        }

        if (view === "graph") children.push(this.renderGraph(content, rows));
        else if (view === "full") children.push(this.renderFull(content));
        else children.push(this.renderList(content, rows));

        if (intents.hasMore && intents.nextCursor) {
          children.push(h("div", { key: "more", style: CARD },
            h("div", { style: HINT }, "意图列表还有更多未加载（分页以 cursor 续读，不静默截断）——以下计数按已加载数据推导，不代表全量。"),
            h("button", { type: "button", "aria-label": "加载更多方向", onClick: () => this.loadIntents({ append: true, cursor: intents.nextCursor }), style: btnStyle(null) }, "加载更多方向"),
          ));
        }

        children.push(this.renderSemantics());
        children.push(h("div", { key: "meta", style: MUTED },
          "数据时刻 " + ui.formatTime(dataAt)
          + " · 截止边界（提交序号）" + String(map.data && map.data.snapshot_commit_seq !== undefined ? map.data.snapshot_commit_seq : "—（未提供）")
          + " · 已加载方向 " + String(rows.length) + " 条 · 计数与列表按已加载数据推导"
          + (content && content.edges_omitted > 0 ? " · 不代表全量（关系边有省略）" : "") + "。",
        ));
        return h("div", { style: WRAP }, ...children);
      }

      renderViewSwitch(view) {
        const { h } = this.props;
        const views = [
          { key: "chain", label: "链路图" },
          { key: "list", label: "方向列表" },
          { key: "graph", label: "局部分支图" },
          { key: "full", label: "完整大图（辅助视图）" },
        ];
        return h("div", { key: "views", style: ROW },
          h("span", { style: MUTED }, "视图："),
          ...views.map((v) => h("button", {
            key: v.key,
            type: "button",
            "aria-label": "切换到" + v.label,
            "aria-pressed": view === v.key ? "true" : "false",
            onClick: () => this.go(v.key),
            style: view === v.key ? { ...btnStyle(null), borderColor: "var(--sorne-brand)", color: "var(--sorne-brand)" } : btnStyle("quiet"),
          }, v.label)),
          h("button", {
            key: "refresh",
            type: "button",
            "aria-label": "刷新探索方向数据",
            onClick: () => this.refresh(),
            style: btnStyle("quiet"),
          }, "刷新"),
        );
      }

      refresh() {
        this.loadMap();
        this.loadIntents();
      }

      renderMapStatus(map) {
        const { h } = this.props;
        if (map.phase === "loading") return h("div", { key: "map-loading", role: "status", style: HINT }, "正在读取探索地图快照…");
        if (map.phase === "unimplemented") {
          return h("div", { key: "map-unimpl", role: "status", style: CARD },
            h("div", { style: H3 }, "探索地图快照未实现"),
            h("div", { style: HINT }, "该端点尚未实装（501 未实现 ≠ 报错）：方向列表按意图端点呈现，分支图暂不可用。"),
            h("div", { style: MUTED }, "服务端说明：" + (map.error && map.error.message ? String(map.error.message) : "负责模块尚未实装该端点")),
          );
        }
        if (map.phase === "error") {
          return h("div", { key: "map-error", role: "alert", style: CARD },
            h("div", { style: H3 }, "探索地图快照不可用"),
            h("div", { style: HINT }, errorMessage(map.error)),
            h("div", { style: MUTED }, "方向列表仍按意图端点呈现；快照恢复后分组与关系边自动补全。"),
            h("button", { type: "button", "aria-label": "重试读取探索地图快照", onClick: () => this.loadMap(), style: btnStyle(null) }, "重试快照"),
          );
        }
        return h("div", { key: "map-unknown", role: "alert", style: CARD },
          h("div", { style: H3 }, "探索地图快照形状无法识别"),
          h("div", { style: HINT }, "响应缺少探索内容（directions / judgements / edges）——已按「无法识别」呈现，不猜测、不当作空方向。"),
        );
      }

      renderIntentsStatus(intents) {
        const { h } = this.props;
        if (intents.phase === "unimplemented") {
          return h("div", { key: "intents-unimpl", role: "status", style: CARD },
            h("div", { style: H3 }, "意图队列未实现"),
            h("div", { style: HINT }, "该端点尚未实装（501 未实现 ≠ 报错）：方向列表回退为快照摘要（缺恢复条件等字段，未提供 ≠ 不存在）。"),
          );
        }
        return h("div", { key: "intents-error", role: "alert", style: CARD },
          h("div", { style: H3 }, "意图队列不可用"),
          h("div", { style: HINT }, errorMessage(intents.error)),
          h("button", { type: "button", "aria-label": "重试读取意图队列", onClick: () => this.loadIntents(), style: btnStyle(null) }, "重试意图"),
        );
      }

      renderSnapshotHeader(data) {
        const { h, ui } = this.props;
        const sub = data.subscription && typeof data.subscription === "object" ? data.subscription : null;
        return h("div", { key: "snap", style: CARD },
          h("div", { style: ROW },
            h("span", { style: H3 }, "探索地图快照"),
            h("span", { style: MUTED }, "快照编号：" + String(data.snapshot_id === undefined ? "—（未提供）" : data.snapshot_id)),
            h("span", { style: MUTED }, "模式版本：" + String(data.schema_version === undefined ? "—（未提供）" : data.schema_version)),
          ),
          h("div", { style: ROW },
            h("span", { style: MUTED }, "数据截止提交序号：" + String(data.snapshot_commit_seq === undefined ? "—（未提供）" : data.snapshot_commit_seq)),
            h("span", { style: MUTED }, "生成时刻：" + ui.formatTime(data.generated_at)),
          ),
          h("div", { style: MUTED }, "本页为只读派生视图：状态以持久记录为准，疑似不写作已确认。"),
          h("details", { style: { marginTop: 2 } },
            h("summary", { style: { cursor: "pointer", fontSize: 13, color: "var(--sorne-text-secondary)" } }, "技术详情（投影范围 / 订阅边界 / 折叠说明）"),
            h("div", { style: { display: "flex", flexDirection: "column", gap: 3, marginTop: 6 } },
              h("div", { style: MUTED }, "投影范围：" + projectionScopeText(data.projection_scope)),
              h("div", { style: MUTED }, sub && sub.available
                ? "订阅边界：" + String(sub.subscription_id) + "（修订 " + String(sub.subscription_revision) + "）"
                : "订阅边界：—（未建立）"),
              h("div", { style: MUTED }, sub && sub.available
                ? "resume_cursor：" + String(sub.resume_cursor === undefined ? "—（未提供）" : sub.resume_cursor)
                : "resume_cursor：—（未提供）"),
              h("div", { style: MUTED }, "从 resume_cursor 指向的边界之后重放事件的增量；异步投影不代表数据库当前版本。"),
              h("div", { style: MUTED }, "本 Map 是派生阅读视图，可由持久记录完全重建，不是事实与状态的真值来源；状态以持久记录为准，疑似不写作已确认。"),
              h("div", { style: { ...H3, fontSize: 13.5, marginTop: 4 } }, "折叠 / 省略说明"),
              foldingNoteNodes(h, ui, data.folding_notes, data.projection_scope && data.projection_scope.project_id),
              h("div", { style: MUTED }, "折叠只影响展示：折叠不删记录，被折叠节点仍参与依赖、范围、订阅与恢复检查。"),
            ),
          ),
        );
      }

      renderList(content, rows) {
        const { h, ui } = this.props;
        const projectId = this.projectId();
        const groups = this.groups();
        const nodes = [];
        if (!rows.length) {
          nodes.push(ui.EmptyState({
            title: "尚无探索方向",
            hint: "方向由 Planner 经计划接收（POST /plan-revisions）提交后进入队列；「开始探索」后会先建立目标再形成方向。未提供不等于不存在。",
          }));
          return h("div", { key: "list", style: CARD }, h("div", { style: H3 }, "方向列表"), ...nodes);
        }
        nodes.push(h("div", { key: "list-head", style: H3 }, "方向列表"));
        for (const g of groups) {
          nodes.push(h("div", { key: "g" + String(g.goal_id || g.statement), style: { display: "flex", flexDirection: "column", gap: 6 } },
            h("div", { style: ROW },
              h("span", { style: H4 }, g.statement || "（目标未提供）"),
              g.goal_id ? chip(h, ui, this.props.router, g.goal_id, projectId) : null,
              g.status ? h("span", { style: MUTED }, "目标状态：" + String(g.status)) : null,
              h("span", { style: MUTED }, "（本组 " + String(g.intents.length) + " 条方向）"),
            ),
            ...g.intents.map((it) => this.renderIntentRow(it, content, projectId)),
          ));
        }
        return h("div", { key: "list", style: CARD }, ...nodes);
      }

      renderIntentRow(it, content, projectId) {
        const { h, ui } = this.props;
        if (!it || !it.id) return null;
        const status = it.status;
        const blocked = status === "blocked" || status === "deferred";
        const conditions = blocked ? this.blockedConditions(it.id, it) : [];
        const targets = asArray(it.target_asset_ids);
        const basis = asArray(it.basis_refs);
        const prereq = asArray(it.prerequisite_refs);
        const dependents = this.dependentsOf(it.id);
        const question = it.question || "—（未提供）";
        const nextStep = status === "running" ? "正在执行，等待证据"
          : status === "queued" ? "已排队，等待派发"
            : status === "proposed" ? "等待入队"
              : blocked ? "等待条件补齐"
                : status === "resolved" ? "已结束（结果见记录）"
                  : "—（未提供）";
        return h("div", { key: "row-" + it.id, style: { ...CARD, gap: 6, background: "var(--sorne-bg-raised)" } },
          h("div", { style: ROW },
            chip(h, ui, this.props.router, it.id, projectId),
            ui.StatusBadge("intent_status", status),
            h("span", { style: MUTED }, "类别：" + kindLabel(it.kind)),
            h("span", { style: MUTED }, "优先级：" + String(it.priority === undefined ? "—" : it.priority)),
          ),
          h("div", { style: { fontSize: 12.5, color: "var(--sorne-text-secondary)" } }, "在查什么"),
          h("div", {
            title: question,
            style: {
              fontSize: 14, lineHeight: 1.6, color: "var(--sorne-text-primary)",
              display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden",
            },
          }, question),
          h("div", { style: ROW },
            h("span", { style: MUTED }, "下一步："),
            h("span", { style: { fontSize: 13.5, fontWeight: 600, color: "var(--sorne-text-primary)" } }, nextStep),
          ),
          h("div", { style: ROW }, h("span", { style: MUTED }, "目标："), chipList(h, ui, this.props.router, targets, projectId)),
          h("div", { style: ROW }, h("span", { style: MUTED }, "依据："), chipList(h, ui, this.props.router, basis, projectId)),
          h("details", { style: { marginTop: 2 } },
            h("summary", { style: { cursor: "pointer", fontSize: 13, color: "var(--sorne-text-secondary)" } }, "技术详情（前提 / 进展 / 阻塞 / 后续）"),
            h("div", { style: { display: "flex", flexDirection: "column", gap: 4, marginTop: 6 } },
              h("div", { style: ROW }, h("span", { style: MUTED }, "前提："), chipList(h, ui, this.props.router, prereq, projectId)),
              h("div", { style: MUTED },
                "更新提交 #" + String(it.updated_seq === undefined ? "—" : it.updated_seq)
                + " · 状态版本 " + String(it.state_version === undefined ? "—" : it.state_version)
                + " · 计划修订 " + String(it.plan_revision === undefined || it.plan_revision === null || it.plan_revision === "" ? "—" : it.plan_revision)),
              h("div", { style: ROW }, h("span", { style: MUTED }, "阻塞："),
                blocked
                  ? (conditions.length
                      ? h("span", { style: ROW }, ...conditions.map((c, i) => h("span", { key: "c" + i, style: HINT }, "· " + String(typeof c === "string" ? c : (c && c.description) || (c && c.kind) || "条件未注明"))))
                      : h("span", { style: MUTED }, "状态为" + String(status) + "，恢复条件未提供"))
                  : h("span", { style: MUTED }, "—（当前未阻塞）")),
              h("div", { style: ROW }, h("span", { style: MUTED }, "后续："), chipList(h, ui, this.props.router, dependents, projectId, "—（暂无）")),
            ),
          ),
          h("div", { style: ROW },
            h("button", { type: "button", "aria-label": "打开方向详情 " + it.id, onClick: () => this.openDetail(it.id), style: btnStyle(null) }, "查看方向详情"),
          ),
        );
      }

      renderGraph(content, rows) {
        const { h, ui } = this.props;
        const projectId = this.projectId();
        const selected = this.selectedId();
        const rowById = new Map(rows.map((r) => [r && r.id, r]));
        const focus = selected && rowById.get(selected) ? [rowById.get(selected)] : rows;
        const nodes = [h("div", { key: "graph-head", style: ROW },
          h("span", { style: H3 }, "局部分支图"),
          h("span", { style: MUTED }, selected
            ? "所选方向及其直接依据 / 目标 / 前提（1 跳）；完整关系见「完整大图」"
            : "每条方向与其直接依据 / 目标 / 前提（1 跳）；点方向编号看详情，完整关系见「完整大图」"),
        )];
        if (!focus.length) {
          nodes.push(h("div", { style: MUTED }, "（暂无方向可画；先让 Planner 提交计划）"));
        }
        for (const it of focus) {
          if (!it || !it.id) continue;
          nodes.push(h("div", { key: "gn-" + it.id, style: { ...CARD, gap: 4, background: "var(--sorne-bg-raised)" } },
            h("div", { style: ROW }, chip(h, ui, this.props.router, it.id, projectId), ui.StatusBadge("intent_status", it.status)),
            h("div", { style: HINT }, it.question || "—（未提供）"),
            h("div", { style: ROW },
              h("span", { style: MUTED }, "前提 ──▶ "),
              chipList(h, ui, this.props.router, asArray(it.prerequisite_refs), projectId),
              h("span", { style: MUTED }, "──▶ 方向 " + String(it.id) + " ──▶"),
            ),
            h("div", { style: ROW }, h("span", { style: MUTED }, "依据："), chipList(h, ui, this.props.router, asArray(it.basis_refs), projectId)),
            h("div", { style: ROW }, h("span", { style: MUTED }, "目标："), chipList(h, ui, this.props.router, asArray(it.target_asset_ids), projectId)),
            h("div", { style: MUTED }, "（局部视图只含直接邻接；不代表全量，边有省略时见完整大图计数。）"),
          ));
        }
        return h("div", { key: "graph", style: CARD }, ...nodes);
      }

      renderFull(content) {
        const { h, ui } = this.props;
        const projectId = this.projectId();
        const nodes = [h("div", { key: "full-head", style: ROW },
          h("span", { style: H3 }, "完整大图（辅助视图）"),
          h("span", { style: MUTED }, "全部关系边与判断清单；节点与边均可按编号打开记录"),
        )];
        const edges = content ? asArray(content.edges) : [];
        const judgements = content && content.judgements && typeof content.judgements === "object" ? content.judgements : null;
        if (judgements) {
          const inv = [];
          for (const key of ["hypotheses", "facts", "vulnerabilities"]) {
            const bucket = judgements[key];
            const items = bucket && Array.isArray(bucket.items) ? bucket.items : [];
            const label = key === "hypotheses" ? "假设" : key === "facts" ? "事实" : "漏洞";
            inv.push(h("div", { key: "inv-" + key, style: { display: "flex", flexDirection: "column", gap: 2 } },
              h("div", { style: H4 }, label + "（" + String(bucket && bucket.count !== undefined ? bucket.count : items.length) + "）"),
              items.length
                ? h("div", { style: { display: "flex", flexDirection: "column", gap: 3 } },
                    ...items.map((item, i) => h("div", { key: "j" + i, style: ROW },
                      chip(h, ui, this.props.router, item.id, projectId),
                      key === "vulnerabilities"
                        ? ui.StatusBadge("vulnerability_status", item.status)
                        : h("span", { style: MUTED }, "状态：" + String(item.status === undefined ? "—（未提供）" : item.status)),
                      h("span", { style: { ...MUTED, flex: "1 1 auto", minWidth: 0 } },
                        String(item.statement || item.category || ""),
                        key === "vulnerabilities" && item.location ? " @ " + String(item.location) : ""),
                    )))
                : h("div", { style: MUTED }, "—（未提供）"),
              bucket && bucket.omitted > 0 ? h("div", { style: MUTED }, "本视图未列出 " + String(bucket.omitted) + " 条（按编号经记录读取，不静默截断）") : null,
            ));
          }
          nodes.push(h("div", { key: "inv", style: { display: "flex", flexDirection: "column", gap: 6 } }, ...inv));
        }
        if (edges.length) {
          const byType = new Map();
          for (const e of edges) {
            const t = (e && e.relation_type) || "unknown";
            if (!byType.has(t)) byType.set(t, []);
            byType.get(t).push(e);
          }
          nodes.push(h("div", { key: "edges", style: { display: "flex", flexDirection: "column", gap: 4 } },
            ...Array.from(byType.entries()).map(([type, list]) => h("div", { key: "et-" + type, style: { display: "flex", flexDirection: "column", gap: 2 } },
              h("div", { style: H4 }, (EDGE_GROUP_LABELS[type] || type) + "（" + String(list.length) + "）"),
              ...list.slice(0, 12).map((e, i) => h("div", { key: "e" + i, style: ROW },
                chip(h, ui, this.props.router, e.from, projectId),
                h("span", { style: MUTED }, "—" + relationLabel(e.relation_type) + "→"),
                chip(h, ui, this.props.router, e.to, projectId),
                e.retracted_at ? h("span", { style: MUTED }, "（已撤回，历史保留）") : null,
              )),
              list.length > 12 ? h("div", { style: MUTED }, "本组其余 " + String(list.length - 12) + " 条按编号经记录读取（不静默截断）") : null,
            )),
          ));
        } else {
          nodes.push(h("div", { style: MUTED }, "（快照未携带关系边；未提供 ≠ 没有关系）"));
        }
        const total = content && content.edges_total !== undefined ? content.edges_total : edges.length;
        const omitted = content && content.edges_omitted ? content.edges_omitted : 0;
        nodes.push(h("div", { style: MUTED },
          "关系边共 " + String(total) + " 条" + (omitted > 0 ? "，本视图已省略 " + String(omitted) + " 条（不静默截断）" : "")
          + (content && content.omitted_note ? "；" + String(content.omitted_note) : "") + "。",
        ));
        return h("div", { key: "full", style: CARD }, ...nodes);
      }

      renderSemantics() {
        const { h } = this.props;
        return h("div", { key: "semantics", style: CARD },
          h("div", { style: H4 }, "语义说明"),
          h("div", { style: HINT }, "resolved 只表示该版本的问题已处理，不代表关联资产已测透（规范 §10.1）。"),
          h("div", { style: HINT }, "恢复与重派由协调 AI 决定，程序不写死固定重试（规范 §3.1/§3.2）；受阻/暂缓方向的恢复条件逐条列出。"),
          h("div", { style: MUTED }, "状态以持久记录为准：疑似不写作已确认；依据与前提都是持久编号，点开即读原始记录；本页只读，不提供直接改方向状态的入口。"),
          h("div", { style: MUTED }, "折叠只影响展示、折叠不删记录；未提供 ≠ 不存在；数据时刻与截止边界见页脚，列表与计数按已加载数据推导。"),
        );
      }
    }

    return h(ExplorationBody, { React, h, api, router, ui, theme });
  },

  /** 右侧详情：方向合同字段 + 依据/前提/目标 + 关系边 + 消息草稿（追问 / 建议暂缓）。 */
  renderDetail({ React, h, api, router, ui, theme }) {
    const ComponentBase = makeBase(React);

    class DirectionDetail extends ComponentBase {
      constructor(props) {
        super(props);
        this.state = {
          rec: { phase: "loading", data: null, error: null },
          draft: null,
          msg: { phase: "idle", error: null, result: null },
        };
        this.seq = 0;
      }

      componentDidMount() {
        this.load();
      }

      projectId() {
        const r = this.props.router;
        return r && r.projectId ? r.projectId : null;
      }

      targetId() {
        const r = this.props.router;
        return r && r.params && r.params.id ? String(r.params.id) : null;
      }

      async load() {
        const { api } = this.props;
        const id = this.targetId();
        const projectId = this.projectId();
        if (!id) {
          this.setState({ rec: { phase: "idle", data: null, error: null } });
          return;
        }
        const seq = ++this.seq;
        try {
          const data = await api("/sorne/records/" + encodeURIComponent(id) + "?project_id=" + encodeURIComponent(projectId));
          if (seq !== this.seq) return;
          const rec = data && data.record ? data.record : null;
          this.setState((prev) => ({
            rec: { phase: "ready", data, error: null },
            draft: prev.draft === null ? this.defaultDraft(rec, id) : prev.draft,
          }));
        } catch (e) {
          if (seq !== this.seq) return;
          this.setState({ rec: { phase: isUnimplemented(e) ? "unimplemented" : "error", data: null, error: e } });
        }
      }

      defaultDraft(rec, id) {
        return "关于探索方向 " + String(rec && rec.id ? rec.id : id) + "（" + String(rec && rec.question ? rec.question : "问题未提供") + "）：请解释当前进展与下一步建议：";
      }

      setDraftTo(kind) {
        const rec = this.state.rec.data && this.state.rec.data.record ? this.state.rec.data.record : null;
        const id = this.targetId();
        const base = this.defaultDraft(rec, id);
        if (kind === "ask") this.setState({ draft: base });
        else this.setState({ draft: "建议暂缓方向 " + String(id) + "：理由：" });
      }

      async send() {
        const { api } = this.props;
        const projectId = this.projectId();
        const content = String(this.state.draft === null ? "" : this.state.draft).trim();
        if (!content) {
          this.setState({ msg: { phase: "error", error: { message: "消息内容不能为空（预填草稿可修改后发送）" }, result: null } });
          return;
        }
        this.setState({ msg: { phase: "sending", error: null, result: null } });
        try {
          const result = await api("/sorne/messages", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ project_id: projectId, content }),
          });
          this.setState({ msg: { phase: "ready", error: null, result } });
        } catch (e) {
          this.setState({ msg: { phase: isUnimplemented(e) ? "unimplemented" : "error", error: e, result: null } });
        }
      }

      render() {
        const { h, ui } = this.props;
        const { rec, draft, msg } = this.state;
        if (!ui || typeof ui.FieldRow !== "function") {
          return h("div", { style: CARD }, h("div", { style: H3 }, "渲染器未就绪"), h("div", { style: HINT }, "详情依赖设计系统渲染器；当前宿主未提供。"));
        }
        const id = this.targetId();
        if (!id) return h("div", { style: CARD }, h("div", { style: HINT }, "未选择方向：在方向列表点击「查看方向详情」。" ));
        if (rec.phase === "loading") return h("div", { style: CARD }, h("div", { style: HINT }, "正在读取方向记录 " + id + "…"));
        if (rec.phase === "unimplemented" || rec.phase === "error") {
          return h("div", { style: CARD },
            h("div", { style: H3 }, "方向 " + id + (rec.phase === "unimplemented" ? "读取未实现" : "读取失败")),
            h("div", { style: HINT }, errorMessage(rec.error)),
            h("div", { style: MUTED }, "未提供不等于不存在：可稍后重试或经编号核对。"),
          );
        }
        const data = rec.data || {};
        const r = data.record && typeof data.record === "object" ? data.record : {};
        const projectId = this.projectId();
        const edges = data.relations && Array.isArray(data.relations.edges) ? data.relations.edges : [];
        const msgStatus = msg.result && msg.result.message ? msg.result.message.status : null;
        const child = [];
        child.push(h("div", { key: "head", style: ROW },
          h("span", { style: H2 }, "方向详情"),
          chip(h, ui, this.props.router, r.id || id, projectId),
        ));
        child.push(h("div", { key: "fields", style: CARD },
          ui.FieldRow("id", r.id || id),
          ui.FieldRow("question", r.question),
          ui.FieldRow("kind", r.kind, { renderer: (v) => kindLabel(v) }),
          ui.FieldRow("status", r.status, { renderer: (v) => (v === null || v === undefined || v === "" ? "—（未提供）" : ui.StatusBadge("intent_status", v)) }),
          ui.FieldRow("priority", r.priority),
          ui.FieldRow("success_criteria", r.success_criteria),
          ui.FieldRow("deliverables", r.deliverables),
          ui.FieldRow("budget", r.budget),
          ui.FieldRow("resume_conditions", r.resume_conditions),
          ui.FieldRow("condition_requirements", r.condition_requirements),
          ui.FieldRow("state_version", r.state_version),
          ui.FieldRow("plan_revision", r.plan_revision),
          ui.FieldRow("scope_revision", r.scope_revision),
          ui.FieldRow("updated_seq", r.updated_seq),
          ui.FieldRow("created_at", r.created_at),
        ));
        child.push(h("div", { key: "refs", style: CARD },
          h("div", { style: H3 }, "目标 / 依据 / 前提"),
          h("div", { style: ROW }, h("span", { style: MUTED }, "目标："), chipList(h, ui, this.props.router, r.target_asset_ids, projectId)),
          h("div", { style: ROW }, h("span", { style: MUTED }, "依据："), chipList(h, ui, this.props.router, r.basis_refs, projectId)),
          h("div", { style: ROW }, h("span", { style: MUTED }, "前提："), chipList(h, ui, this.props.router, r.prerequisite_refs, projectId)),
        ));
        child.push(h("div", { key: "edges", style: CARD },
          h("div", { style: H3 }, "关系边"),
          edges.length
            ? h("div", { style: { display: "flex", flexDirection: "column", gap: 2 } },
                ...edges.slice(0, 12).map((e, i) => h("div", { key: "e" + i, style: ROW },
                  h("span", { style: MUTED }, relationLabel(e.relation_type) + "："),
                  chip(h, ui, this.props.router, e.from, projectId),
                  h("span", { style: MUTED }, "→"),
                  chip(h, ui, this.props.router, e.to, projectId),
                  e.retracted_at ? h("span", { style: MUTED }, "（已撤回，历史保留）") : null,
                )),
                data.relations && data.relations.truncated ? h("div", { style: MUTED }, "边数超出上限，其余按编号经记录读取（不静默截断）。") : null,
              )
            : h("div", { style: MUTED }, "—（未提供）"),
        ));
        child.push(h("div", { key: "msg", style: CARD },
          h("div", { style: H3 }, "操作：消息草稿（追问 / 建议暂缓）"),
          h("div", { style: HINT }, "追问与暂缓都以消息提交，由协调 AI 决策（用户操作不直接改方向状态；恢复与重派由协调 AI 决定）。"),
          h("div", { style: ROW },
            h("button", { type: "button", "aria-label": "追问 AI（填草稿）", onClick: () => this.setDraftTo("ask"), style: btnStyle(null) }, "追问 AI"),
            h("button", { type: "button", "aria-label": "建议暂缓（填草稿）", onClick: () => this.setDraftTo("suspend"), style: btnStyle(null) }, "建议暂缓"),
          ),
          h("textarea", {
            "aria-label": "方向消息草稿",
            value: draft === null ? "" : draft,
            rows: 3,
            onChange: (e) => this.setState({ draft: e.target.value }),
            style: { ...INPUT, width: "100%", minWidth: 0, minHeight: 62, resize: "vertical" },
          }),
          h("div", { style: ROW },
            h("button", { type: "button", "aria-label": "发送方向消息", onClick: () => this.send(), style: btnStyle("primary") }, "发送消息"),
            msg.phase === "sending" ? h("span", { style: MUTED }, "正在发送…") : null,
          ),
          msg.phase === "error" ? h("div", { role: "alert", style: { ...MUTED, color: "var(--sorne-status-unknown-fg)" } }, "消息发送失败：" + errorMessage(msg.error)) : null,
          msg.phase === "unimplemented" ? h("div", { style: MUTED }, "消息端点未实现（501 未实现 ≠ 报错）。") : null,
          msg.phase === "ready" && msg.result && msg.result.message
            ? h("div", { style: ROW },
                "已提交：", chip(h, ui, this.props.router, msg.result.message.id, projectId),
                msgStatus ? ui.StatusBadge("message_status", msgStatus) : null,
                h("span", { style: MUTED }, "收到 ≠ 已处理" + (msg.result.state ? "（" + String(msg.result.state) + "）" : "") + "，等待协调 AI 处理。"),
              )
            : null,
        ));
        return h("div", { style: WRAP }, ...child);
      }
    }

    return h(DirectionDetail, { React, h, api, router, ui, theme });
  },
};
