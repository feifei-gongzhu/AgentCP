/**
 * 页面：资产（lib/ui/pages/assets.page.mjs；M5 独占重写；BLUEPRINT-UI §1.5 / §g assets）。
 *
 * 回答一个问题：我们知道目标的哪些信息？五块信息各有落点（要求 §6）：
 *   1. 站点树 —— asset_map 快照的服务/主机层级节点（discovered_from 关系），关系缺失时按类型平铺；
 *   2. 资产列表 —— 快照的资产类型分组真表格（行点击 → 右侧详情 ?id=资产编号）；
 *   3. 技术栈 —— 分层技术栈画像（产品 → 版本 → 证据）：同一产品的多条指纹/版本
 *      线索合并为产品节点、版本未知显式标注、叶节点保留资产编号可下钻；合并只影响
 *      展示，不删除/不改写任何资产记录（见 lib/store/tech-stack.mjs）；
 *   4. 接口 —— 快照的接口模板维度（候选/已确认分列）+ 持久记录（模板编号 chip）；
 *   5. 文件及来源 —— 资产记录（#14）的来源计数与关联编号，采集详情经 #44 读取，
 *      原始字节入口指向 #43（本页不内联字节）。
 *
 * 页面契约：纯 ESM、零 import、不用浏览器本地存储；有状态部分收敛为单个
 * React.Component 子类；颜色全部走设计系统 token；编号一律经 ui.RecordIdChip
 * （唯一实现是 lib/ui/record-ids.mjs，本页不含任何编号正则）；时间/哈希/折叠/表格
 * 由 ui 渲染器负责。右侧详情由 renderDetail(ctx) 渲染（外壳槽位契约），并通过
 * POST /sorne/messages 提交「就此资产向 AI 下任务」的预填消息草稿（要求 §5）。
 *
 * 语义纪律（冻结原文见渲染器 VOCAB）：未提供 ≠ 不存在（「—（未提供）」）；
 * 数据时刻 / 截止边界（提交序号）/ 不代表全量；折叠不删记录（保留计数与展开入口）；
 * 501 未实现 ≠ 报错（呈现未实现态，其余区块照常可用）。
 */

/* ── 展示用中文标签（仅映射；未知值原样呈现，不猜测语义） ───────────── */

const ASSET_TYPE_LABELS = {
  domain: "域名",
  host: "主机",
  service: "服务",
  url: "URL",
  static_resource: "静态资源",
  port: "端口",
  ip: "IP 地址",
  certificate: "证书",
  technology: "技术组件",
  endpoint: "接口",
  other: "其他",
};

const RELATION_LABELS = {
  discovered_from: "发现来源",
  targets: "指向",
  supports: "支持",
  contradicts: "反对",
  requires: "前提",
  derived_from: "派生自",
  related_to: "相关",
};

const LIMIT_LABELS = {
  edges: "关系边",
  exploration_nodes: "探索判断",
  recent_events: "近期事件",
};

const FOLDING_SECTION_LABELS = {
  folded_assets: "折叠资产",
  folded_dependencies: "折叠分支前提",
  omitted_edges: "省略关系边",
  omitted_nodes: "省略判断节点",
};

function assetTypeLabel(type) {
  if (type === null || type === undefined || type === "") return "—（未提供）";
  const raw = String(type);
  return ASSET_TYPE_LABELS[raw] ? ASSET_TYPE_LABELS[raw] + "（" + raw + "）" : "未登记类型（" + raw + "）";
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
const H2 = { margin: 0, fontSize: 17, color: "var(--sorne-text-primary)" };
const H3 = { margin: "2px 0", fontSize: 14.5, color: "var(--sorne-text-primary)" };
const HINT = { fontSize: 13.5, lineHeight: 1.6, color: "var(--sorne-text-secondary)" };
const MUTED = { fontSize: 13, lineHeight: 1.6, color: "var(--sorne-text-muted)" };
const ROW = { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "baseline" };

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

function scopeStatusNode(ui, value) {
  if (value === null || value === undefined || value === "") return "—（未提供）";
  if (ui && typeof ui.StatusBadge === "function") return ui.StatusBadge("scope_kind", value);
  return String(value);
}

/** 编号 chip：唯一实现经 ui.RecordIdChip；点击走 router.openRecord（完整编号）。 */
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

function chipList(h, ui, router, ids, projectId) {
  const list = Array.isArray(ids) ? ids.filter((x) => x !== null && x !== undefined && x !== "") : [];
  if (!list.length) return h("span", { style: MUTED }, "—（未提供）");
  return h("span", { style: ROW }, ...list.map((id, i) => h("span", { key: String(id) + i }, chip(h, ui, router, id, projectId))));
}

/** 投影范围：不再裸串输出，转为页头可读行（项目 / 折叠边界 / 各列表上限）。 */
function projectionScopeText(scope) {
  if (!scope || typeof scope !== "object") return "—（未提供）";
  const parts = [];
  if (scope.project_id) parts.push("项目 " + String(scope.project_id));
  const fold = scope.fold_since;
  parts.push("折叠边界：" + (fold === null || fold === undefined ? "未启用" : "提交序号 " + String(fold)));
  if (scope.limits && typeof scope.limits === "object") {
    const items = Object.keys(scope.limits)
      .sort()
      .map((k) => (LIMIT_LABELS[k] || k) + " " + String(scope.limits[k]));
    if (items.length) parts.push("上限：" + items.join(" · "));
  }
  return parts.join(" · ");
}

/** 折叠/省略说明：数组（服务端聚合）或字符串（旧形体）都如实呈现，不静默截断。 */
function foldingNoteNodes(h, ui, notes, projectId) {
  if (notes === null || notes === undefined || notes === "") return h("div", { style: MUTED }, "（本快照未声明折叠或省略）");
  if (typeof notes === "string") return h("div", { style: HINT }, notes);
  if (!Array.isArray(notes)) return h("div", { style: HINT }, String(notes));
  if (!notes.length) return h("div", { style: MUTED }, "（无折叠或省略事项）");
  return h("ul", { style: { margin: "2px 0 0", paddingLeft: 18, ...HINT } },
    ...notes.map((note, i) => {
      const n = note || {};
      const section = FOLDING_SECTION_LABELS[n.section] || n.section || "说明";
      const count = n.total_folded !== undefined ? n.total_folded : (n.count !== undefined ? n.count : n.groups);
      const bits = [section];
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

/** 站点树：discovered_from 边（from 发现自 to → to 为父）构树；无关系时按类型平铺。 */
function discoveredForest(assets, edges) {
  const byId = new Map(assets.map((a) => [a.id, a]));
  const children = new Map();
  const childIds = new Set();
  for (const e of edges || []) {
    if (!e || e.relation_type !== "discovered_from") continue;
    const parent = e.to;
    const child = e.from;
    if (!byId.has(parent) || !byId.has(child) || parent === child) continue;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(child);
    childIds.add(child);
  }
  const roots = assets.filter((a) => !childIds.has(a.id));
  return { roots: roots.length ? roots : assets, children, byId, hasEdges: children.size > 0 };
}

function treeNode(h, ui, router, projectId, nodeId, forest, depth, seen) {
  const asset = forest.byId.get(nodeId);
  if (!asset) return null;
  if (depth > 4 || seen.has(nodeId)) {
    return h("li", { key: "t" + nodeId, style: MUTED },
      chip(h, ui, router, nodeId, projectId), "（层级过深或存在环，已折叠展示；点编号查看记录）");
  }
  seen.add(nodeId);
  const kids = forest.children.get(nodeId) || [];
  return h("li", { key: "t" + nodeId, style: { marginBottom: 2 } },
    h("span", { style: ROW },
      chip(h, ui, router, asset.id, projectId),
      h("span", { style: { fontSize: 13.5, color: "var(--sorne-text-primary)" } }, assetTypeLabel(asset.asset_type)),
      h("span", { style: MUTED }, "规范身份：" + String(asset.canonical_key === undefined ? "—（未提供）" : asset.canonical_key)),
      h("span", { style: MUTED }, "范围："),
      h("span", { style: MUTED }, scopeStatusNode(ui, asset.scope_status)),
    ),
    kids.length
      ? h("ul", { style: { margin: "2px 0 2px", paddingLeft: 18 } },
          ...kids.map((k) => treeNode(h, ui, router, projectId, k, forest, depth + 1, seen)))
      : null,
  );
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
  id: "assets",
  title: "资产",
  order: 30,

  render({ React, h, api, router, ui, theme }) {
    const ComponentBase = makeBase(React);

    class AssetsBody extends ComponentBase {
      constructor(props) {
        super(props);
        const q = props.router && props.router.query ? props.router.query : {};
        this.state = {
          snap: { phase: "loading", data: null, error: null, unknownShape: false },
          tree: { phase: "idle", data: null, error: null },
          record: { phase: "idle", data: null, error: null },
          foldSince: q.fold_since !== undefined && q.fold_since !== null && q.fold_since !== "" ? String(q.fold_since) : "",
          capture: { phase: "idle", id: "", data: null, error: null },
          dataAt: null,
          navSeq: 0,
        };
        this.loadSeq = 0;
        this.treeSeq = 0;
        this.recordSeq = 0;
        this.onNav = this.onNav.bind(this);
        this.unsubNav = null;
      }

      componentDidMount() {
        this.loadSnapshot();
        this.loadRecordFor();
        this.loadTree();
        const r = this.props.router;
        if (r && typeof r.onChange === "function") this.unsubNav = r.onChange(this.onNav);
      }

      componentWillUnmount() {
        if (typeof this.unsubNav === "function") this.unsubNav();
      }

      onNav() {
        const r = this.props.router;
        if (!r || r.page !== "assets") return;
        const q = r.query || {};
        const foldSince = q.fold_since !== undefined && q.fold_since !== null && q.fold_since !== "" ? String(q.fold_since) : "";
        this.setState((prev) => ({ navSeq: prev.navSeq + 1, foldSince }));
        this.loadSnapshot({ silent: true, foldSince });
        this.loadRecordFor({ silent: true });
      }

      projectId() {
        const r = this.props.router;
        return r && r.projectId ? r.projectId : null;
      }

      selectedId() {
        const r = this.props.router;
        return r && r.params && r.params.id ? String(r.params.id) : null;
      }

      snapshotPath(projectId, foldSince) {
        const q = new URLSearchParams({ project_id: projectId });
        if (foldSince !== "" && foldSince !== undefined && foldSince !== null) q.set("fold_since", String(foldSince));
        return "/sorne/snapshots/asset_map?" + q.toString();
      }

      async loadSnapshot({ silent, foldSince } = {}) {
        const { api } = this.props;
        const projectId = this.projectId();
        if (!projectId) return;
        const seq = ++this.loadSeq;
        if (!silent) this.setState((prev) => ({ snap: { ...prev.snap, phase: "loading", error: null, unknownShape: false } }));
        try {
          const data = await api(this.snapshotPath(projectId, foldSince === undefined ? this.state.foldSince : foldSince));
          if (seq !== this.loadSeq) return;
          const content = data && data.content && typeof data.content === "object" ? data.content : null;
          const shapeOk = Boolean(content && Array.isArray(content.groups));
          this.setState({
            snap: { phase: "ready", data: shapeOk ? data : null, error: null, unknownShape: !shapeOk },
            dataAt: new Date().toISOString(),
          });
        } catch (e) {
          if (seq !== this.loadSeq) return;
          this.setState({
            snap: { phase: isUnimplemented(e) ? "unimplemented" : "error", data: null, error: e, unknownShape: false },
            dataAt: new Date().toISOString(),
          });
        }
      }

      async loadRecordFor({ silent } = {}) {
        const { api } = this.props;
        const projectId = this.projectId();
        const id = this.selectedId();
        if (!projectId || !id) {
          this.recordSeq += 1;
          this.setState({ record: { phase: "idle", data: null, error: null } });
          return;
        }
        const seq = ++this.recordSeq;
        if (!silent) this.setState({ record: { phase: "loading", data: null, error: null } });
        try {
          const data = await api("/sorne/records/" + encodeURIComponent(id) + "?project_id=" + encodeURIComponent(projectId));
          if (seq !== this.recordSeq) return;
          this.setState({ record: { phase: "ready", data, error: null } });
        } catch (e) {
          if (seq !== this.recordSeq) return;
          this.setState({ record: { phase: isUnimplemented(e) ? "unimplemented" : "error", data: null, error: e } });
        }
      }

      openDetail(id) {
        const { router } = this.props;
        const projectId = this.projectId();
        if (!router || typeof router.open !== "function" || !projectId) return;
        router.open("#/p/" + encodeURIComponent(projectId) + "/assets?id=" + encodeURIComponent(String(id)));
      }

      expandGroup(foldSince) {
        const { router } = this.props;
        const projectId = this.projectId();
        if (foldSince === null || foldSince === undefined) return;
        if (!router || typeof router.open !== "function" || !projectId) return;
        router.open("#/p/" + encodeURIComponent(projectId) + "/assets?fold_since=" + encodeURIComponent(String(foldSince)));
      }

      render() {
        const { h, ui } = this.props;
        const { snap, record, dataAt } = this.state;

        if (!ui || typeof ui.formatTime !== "function" || typeof ui.FieldRow !== "function") {
          return h("div", { style: WRAP },
            h("div", { role: "alert", style: CARD },
              h("div", { style: H2 }, "渲染器未就绪"),
              h("div", { style: HINT }, "资产页依赖设计系统渲染器（时间/编号/字段/表格）。当前宿主未提供，页面以降级态呈现，不做数据猜测。"),
            ));
        }

        const projectId = this.projectId();
        const children = [];

        children.push(h("div", { key: "head", style: { display: "flex", flexDirection: "column", gap: 4 } },
          h("h2", { style: H2 }, "资产"),
        ));

        if (!projectId) {
          children.push(h("div", { key: "noproject", role: "status", style: CARD },
            h("div", { style: H3 }, "未选择项目"),
            h("div", { style: HINT }, "资产继承当前项目：请先在项目列表选择项目（#/projects），再回到本页。"),
          ));
          return h("div", { style: WRAP }, ...children);
        }

        if (snap.phase === "loading") {
          children.push(h("div", { key: "loading", role: "status", style: HINT }, "正在读取资产地图快照…"));
          return h("div", { style: WRAP }, ...children);
        }

        if (snap.phase === "unimplemented") {
          children.push(this.renderUnimplemented("资产地图快照未实现", snap.error));
          children.push(this.renderBlocksEmpty("未实现"));
          return h("div", { style: WRAP }, ...children);
        }

        if (snap.phase === "error") {
          children.push(h("div", { key: "err", role: "alert", style: CARD },
            h("div", { style: { ...H3, color: "var(--sorne-status-unknown-fg)" } }, "资产地图快照不可用"),
            h("div", { style: HINT }, errorMessage(snap.error)),
            h("div", null, h("button", { type: "button", "aria-label": "重试读取资产地图快照", onClick: () => this.loadSnapshot(), style: btnStyle(null) }, "重试")),
          ));
          children.push(this.renderBlocksEmpty("不可用"));
          return h("div", { style: WRAP }, ...children);
        }

        if (snap.unknownShape) {
          children.push(h("div", { key: "unknown", role: "alert", style: CARD },
            h("div", { style: H3 }, "资产地图快照形状无法识别"),
            h("div", { style: HINT }, "响应缺少快照内容（content.groups）——已按「无法识别」呈现，不猜测、不当作空资产；请稍后重试或检查投影服务。"),
          ));
          children.push(this.renderBlocksEmpty("形状无法识别"));
          return h("div", { style: WRAP }, ...children);
        }

        const data = snap.data || {};
        const content = data.content || {};
        const groups = Array.isArray(content.groups) ? content.groups : [];
        const edges = Array.isArray(content.edges) ? content.edges : [];
        const templates = content.endpoint_templates && typeof content.endpoint_templates === "object" ? content.endpoint_templates : null;
        const subscription = data.subscription && typeof data.subscription === "object" ? data.subscription : null;

        children.push(this.renderTree());
        children.push(h("details", { key: "detail-tables", style: { ...CARD, padding: "8px 12px" } },
          h("summary", { style: { cursor: "pointer", fontSize: 13, fontWeight: 600 } }, "明细表（逐项，备查）"),
          h("div", { style: { marginTop: 8 } },
            this.renderSnapshotHeader(data, subscription),
            this.renderAssetList(groups),
            this.renderTechStack(content),
            this.renderTemplates(templates),
          ),
        ));

        children.push(h("div", { key: "meta", style: MUTED },
          "数据时刻 " + ui.formatTime(dataAt) + " · 截止边界（提交序号）" + String(data.snapshot_commit_seq === undefined ? "—（未提供）" : data.snapshot_commit_seq)
          + " · 列表与计数按已加载快照推导" + (content.edges_omitted > 0 ? " · 不代表全量（关系边有省略）" : "") + "。",
        ));

        return h("div", { style: WRAP }, ...children);
      }

      async loadTree() {
        const pid = this.projectId();
        if (!pid) return;
        const seq = ++this.treeSeq;
        this.setState((p) => ({ tree: { ...p.tree, phase: "loading", error: null } }));
        try {
          const data = await this.props.api("/sorne/projects/" + encodeURIComponent(pid) + "/asset-tree");
          if (seq !== this.treeSeq) return;
          this.setState({ tree: { phase: "ready", data, error: null } });
        } catch (e) {
          if (seq !== this.treeSeq) return;
          this.setState({ tree: { phase: "error", data: null, error: e } });
        }
      }


      renderTree() {
        const { h, ui, router } = this.props;
        const st = this.state.tree;
        if (st.phase === "loading") return h("section", { key: "tree", style: CARD }, h("div", { style: HINT }, "正在整理资产目录…"));
        if (st.phase === "error") {
          return h("section", { key: "tree", style: CARD },
            h("h3", { style: H3 }, "资产目录"),
            h("div", { style: HINT }, "资产目录读取失败：" + errorMessage(st.error)));
        }
        const data = st.data;
        if (!data || !Array.isArray(data.sites)) return null;
        const projectId = this.projectId();
        const chip = (ref) => {
          if (!ref) return null;
          if (ui && typeof ui.RecordIdChip === "function") {
            return ui.RecordIdChip(ref, { projectId, navigate: (id) => router.openRecord(id) });
          }
          return h("span", { style: MUTED }, ref);
        };
        const fileRow = (item, idx) => h("div", {
          key: (item.ref || item.name || "f") + "-" + idx,
          style: { display: "flex", alignItems: "baseline", gap: 8, padding: "2px 0 2px 16px", fontSize: 12.5 },
        },
          h("span", { style: { fontFamily: "ui-monospace, Menlo, monospace", wordBreak: "break-all", flex: "1 1 auto" } }, item.name || item.url || "—"),
          chip(item.ref),
        );
        const folder = (key, label, items) => h("details", { key, open: true, style: { marginLeft: 14 } },
          h("summary", { style: { cursor: "pointer", fontSize: 13, fontWeight: 600, padding: "2px 0" } }, label + "/（" + items.length + "）"),
          items.length
            ? items.map((item, i) => fileRow(item, i))
            : h("div", { style: { fontSize: 12.5, color: "var(--sorne-text-muted)", paddingLeft: 16 } }, "（空）"),
        );
        return h("section", { key: "tree", style: CARD },
          h("div", { style: { display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" } },
            h("h3", { style: H3 }, "资产目录"),
            h("span", { style: MUTED }, "按站点组织；点编号打开记录。"),
          ),
          h("div", { style: { marginTop: 6, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12.5 } },
            h("div", { style: { fontWeight: 600 } }, "资产/"),
            h("div", { style: { paddingLeft: 14, color: "var(--sorne-text-secondary)" } },
              "asset_map.md", h("span", { style: { marginLeft: 8, color: "var(--sorne-text-muted)" } }, data.asset_map_md ? data.asset_map_md.summary : "")),
            data.sites.map((site) => h("details", { key: site.host, open: true, style: { marginLeft: 14, marginTop: 4 } },
              h("summary", { style: { cursor: "pointer", fontWeight: 600, fontSize: 13, padding: "2px 0" } }, site.host + "/"),
              folder("js", "JS", site.js || []),
              folder("pages", "页面", site.pages || []),
              folder("interfaces", "接口", site.interfaces || []),
              folder("files", "文件", site.files || []),
            )),
          ),
          h("div", { key: "tech-profile", style: { marginTop: 10, paddingTop: 8, borderTop: "1px solid var(--sorne-border)" } },
            h("div", { style: ROW },
              h("span", { style: H3 }, "技术栈画像"),
              h("span", { style: MUTED }, "跨站点知识：产品 → 版本 → 证据；技术归属站点经服务资产关系读取，不按站点重复平铺"),
            ),
            data.tech_stack
              ? this.renderTechStackTree(data.tech_stack, { keyPrefix: "asset-tree-tech" })
              : h("div", { style: MUTED }, "服务端未返回分层技术栈画像（旧响应形状）：未提供不等于不存在，逐条指纹仍可按编号读取。"),
          ),
        );
      }

      /** 分层技术栈画像：产品 → 版本 → 证据（叶子为资产编号 chip，可下钻）。 */
      renderTechStackTree(tree, { keyPrefix = "tech" } = {}) {
        const { h, ui, router } = this.props;
        const projectId = this.projectId();
        const chip = (ref) => {
          if (!ref) return null;
          if (ui && typeof ui.RecordIdChip === "function") {
            return ui.RecordIdChip(ref, { projectId, navigate: (id) => router.openRecord(id) });
          }
          return h("span", { style: MUTED }, ref);
        };
        const products = tree && Array.isArray(tree.products) ? tree.products : [];
        const s = tree && tree.summary ? tree.summary : {};
        const summaryLine =
          "产品 " + (s.products ?? products.length)
          + " · 版本节点 " + (s.version_nodes ?? 0)
          + " · 原始条目 " + (s.raw_assets ?? 0)
          + "（同产品合并 " + (s.merged_rows ?? 0) + " 条；版本未知节点 " + (s.unknown_version_nodes ?? 0) + " 个）";
        return h("div", { key: keyPrefix + "-root", style: { marginTop: 6, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12.5 } },
          h("div", { style: { color: "var(--sorne-text-secondary)", marginBottom: 4 } }, summaryLine),
          products.length
            ? products.map((p) => {
                const aliasText = Array.isArray(p.aliases) && p.aliases.length ? "（别名：" + p.aliases.join("、") + "）" : "";
                return h("details", { key: keyPrefix + "-p-" + p.key, open: true, style: { marginLeft: 8, marginTop: 2 } },
                  h("summary", { style: { cursor: "pointer", fontWeight: 600, padding: "2px 0" } },
                    p.product + aliasText + "　", h("span", { style: MUTED }, p.summary || "")),
                  (Array.isArray(p.versions) ? p.versions : []).map((v) => h("div", { key: keyPrefix + "-v-" + p.key + "-" + v.key, style: { marginLeft: 16, padding: "2px 0" } },
                    h("div", { style: { fontWeight: 500 } }, (v.label || "版本未知") + "（" + (v.count ?? 0) + " 条）"),
                    h("div", { style: { ...ROW, paddingLeft: 16, flexWrap: "wrap" } },
                      ...(Array.isArray(v.items) ? v.items : []).map((it, i) => h("span", { key: (it.id || "") + i }, chip(it.id))),
                    ),
                    v.omitted_note ? h("div", { style: { ...MUTED, paddingLeft: 16 } }, v.omitted_note) : null,
                  )),
                );
              })
            : h("div", { style: MUTED }, "（暂无技术栈证据）"),
        );
      }

      renderUnimplemented(title, error) {
        const { h } = this.props;
        const detail = error && error.message ? String(error.message) : "负责模块尚未实装该端点";
        return h("div", { key: "unimpl", role: "status", style: CARD },
          h("div", { style: H3 }, title),
          h("div", { style: HINT }, "该端点尚未实装（501 未实现 ≠ 报错）：未实现 ≠ 数据为空，页面其余区块照常可用。"),
          h("div", { style: MUTED }, "服务端说明：" + detail),
        );
      }

      renderBlocksEmpty(reason) {
        const { h } = this.props;
        return h("div", { key: "blocks-empty", style: CARD },
          h("div", { style: H3 }, "资产 / 技术栈 / 接口（快照" + reason + "）"),
          h("div", { style: HINT }, "快照不可用时本区如实置空——未提供不等于不存在；记录仍可按编号读取。"),
        );
      }

      renderSnapshotHeader(data, subscription) {
        const { h, ui } = this.props;
        const scope = projectionScopeText(data.projection_scope);
        return h("div", { key: "snap-head", style: CARD },
          h("div", { style: ROW },
            h("span", { style: H3 }, "资产快照"),
            h("span", { style: MUTED }, String(data.snapshot_id === undefined ? "—（未提供）" : data.snapshot_id)),
            h("span", { style: MUTED }, "数据截止 #" + String(data.snapshot_commit_seq === undefined ? "—（未提供）" : data.snapshot_commit_seq)),
            h("span", { style: MUTED }, ui.formatTime(data.generated_at)),
          ),
          h("details", { style: { marginTop: 2 } },
            h("summary", { style: { cursor: "pointer", fontSize: 13, color: "var(--sorne-text-secondary)" } }, "技术详情（投影范围 / 订阅边界）"),
            h("div", { style: { display: "flex", flexDirection: "column", gap: 3, marginTop: 6 } },
              h("div", { style: MUTED }, "投影范围：" + scope),
              h("div", { style: MUTED }, subscription && subscription.available
                ? "订阅边界：" + String(subscription.subscription_id) + "（修订 " + String(subscription.subscription_revision) + "）"
                : "订阅边界：—（未建立）"),
              h("div", { style: MUTED }, "异步投影不代表数据库当前版本；状态以持久记录为准。"),
            ),
          ),
        );
      }


      renderSiteTree(content, groups, edges) {
        const { h, ui, router } = this.props;
        const projectId = this.projectId();
        const assets = [];
        for (const g of groups) {
          if (!g || !Array.isArray(g.assets)) continue;
          for (const a of g.assets) if (a && a.id) assets.push({ ...a, asset_type: g.asset_type });
        }
        const forest = discoveredForest(assets, edges);
        const totals = content.totals && typeof content.totals === "object" ? content.totals : null;

        return h("div", { key: "tree", style: CARD },
          h("div", { style: ROW },
            h("span", { style: H3 }, "站点树"),
            h("span", { style: MUTED }, "服务 / 主机层级，按发现来源关系（discovered_from）构成"),
          ),
          forest.hasEdges
            ? h("ul", { style: { margin: "2px 0", paddingLeft: 18 } },
                ...forest.roots.map((a) => treeNode(h, ui, router, projectId, a.id, forest, 0, new Set())))
            : h("div", { style: HINT },
                "未记录 discovered_from 关系——站点树按资产类型平铺（关系缺失不等于资产不存在）：",
                h("ul", { style: { margin: "2px 0", paddingLeft: 18 } },
                  ...groups.map((g) => h("li", { key: "flat" + String(g.asset_type) },
                    assetTypeLabel(g.asset_type) + " · " + String(Array.isArray(g.assets) ? g.assets.length : 0) + " 个")))),
          h("div", { style: MUTED },
            "关系边 " + String(content.edges_total === undefined ? (Array.isArray(edges) ? edges.length : 0) : content.edges_total)
            + " 条" + (content.edges_omitted > 0 ? "，已省略 " + String(content.edges_omitted) + " 条（不静默截断，按编号经记录读取）" : "")
            + (totals ? " · 资产 " + String(totals.assets) + " 个 · 类型组 " + String(totals.groups) + " 个" : "") + "。",
          ),
        );
      }

      renderAssetList(groups) {
        const { h, ui, router } = this.props;
        const projectId = this.projectId();
        const totalVisible = groups.reduce((n, g) => n + (Array.isArray(g.assets) ? g.assets.length : 0), 0);
        const nodes = [h("div", { key: "list-head", style: ROW },
          h("span", { style: H3 }, "资产列表"),
          h("span", { style: MUTED }, "按资产类型分组的真表格 · 行点击打开右侧详情"),
        )];
        if (!totalVisible) {
          nodes.push(ui.EmptyState({
            title: "尚未发现资产",
            hint: "探索开始后新发现的资产会出现在这里；也可从项目设置或记录页核对范围与已有资料。未提供不等于不存在。",
          }));
          nodes.push(h("div", { key: "list-empty-note", style: MUTED }, "分组计数为 0 是准确计数；快照边界内的资产均已包含。"));
          return h("div", { key: "list", style: CARD }, ...nodes);
        }
        for (const g of groups) {
          const assets = Array.isArray(g.assets) ? g.assets : [];
          const folded = g.folded && typeof g.folded === "object" ? g.folded : null;
          nodes.push(h("div", { key: "grp" + String(g.asset_type), style: { display: "flex", flexDirection: "column", gap: 4 } },
            h("div", { style: ROW },
              h("span", { style: { fontSize: 14, fontWeight: 600, color: "var(--sorne-text-primary)" } }, assetTypeLabel(g.asset_type)),
              h("span", { style: MUTED }, "共 " + String(g.total === undefined ? assets.length : g.total) + " 个 · 本页可见 " + String(assets.length) + " 个"),
            ),
            assets.length
              ? ui.DataTable({
                  columns: [
                    { key: "id", label: "编号", render: (row) => chip(h, ui, router, row.id, projectId) },
                    { key: "canonical_key", label: "规范身份" },
                    { key: "scope_status", label: "范围状态", value: (row) => row.scope_status, render: (row) => scopeStatusNode(ui, row.scope_status) },
                    { key: "activity_seq", label: "活动提交序号" },
                    { key: "created_seq", label: "创建提交序号" },
                  ],
                  rows: assets,
                  rowKey: (row) => row.id,
                  onRowClick: (row) => this.openDetail(row.id),
                })
              : h("div", { style: MUTED }, "本组当前无可见资产。"),
            folded
              ? h("div", { key: "fold" + String(g.asset_type), style: ROW },
                  h("span", { style: MUTED },
                    "已折叠 " + String(folded.count) + " 项（活动提交序号小于折叠边界；折叠只影响展示，折叠不删记录）"),
                  Array.isArray(folded.sample_ids) && folded.sample_ids.length
                    ? h("span", { style: ROW }, "样本：", ...folded.sample_ids.map((id, i) => h("span", { key: "s" + i }, chip(h, ui, router, id, projectId))))
                    : null,
                  h("button", {
                    type: "button",
                    "aria-label": "展开本组折叠资产",
                    onClick: () => this.expandGroup(folded.unfold_fold_since),
                    style: btnStyle(null),
                  }, "展开本组"),
                )
              : null,
          ));
        }
        return h("div", { key: "list", style: CARD }, ...nodes);
      }

      renderTechStack(content) {
        const { h } = this.props;
        const stack = content && typeof content === "object" ? content.tech_stack : null;
        return h("div", { key: "stack", style: CARD },
          h("div", { style: ROW },
            h("span", { style: H3 }, "技术栈画像"),
            h("span", { style: MUTED },
              "口径：产品 → 版本 → 证据（同一产品的多条指纹合并；版本未知显式标注；合并只影响展示，资产记录不删除、不改写）"),
          ),
          stack
            ? this.renderTechStackTree(stack, { keyPrefix: "snapshot-tech" })
            : h("div", { style: MUTED },
                "快照未返回分层技术栈画像（旧快照形状）——未提供不等于不存在；可重试生成新快照，或按资产编号逐条读取。"),
        );
      }

      renderTemplates(templates) {
        const { h, ui, router } = this.props;
        const projectId = this.projectId();
        if (!templates) {
          return h("div", { key: "tpl", style: CARD },
            h("div", { style: H3 }, "接口（候选接口族）"),
            h("div", { style: HINT }, "服务端未返回接口模板维度（endpoint_templates）——未提供不等于不存在；模板记录仍可按模板编号经记录读取。"),
          );
        }
        const byStatus = templates.by_status && typeof templates.by_status === "object" ? templates.by_status : {};
        const sections = ["candidate", "confirmed"].map((status) => {
          const bucket = byStatus[status] && typeof byStatus[status] === "object" ? byStatus[status] : { total: 0, items: [], omitted: 0 };
          const items = Array.isArray(bucket.items) ? bucket.items : [];
          return { status, bucket, items };
        });
        const folded = templates.folded && typeof templates.folded === "object" ? templates.folded : null;
        const label = { candidate: "候选模板", confirmed: "已确认模板" };
        return h("div", { key: "tpl", style: CARD },
          h("div", { style: ROW },
            h("span", { style: H3 }, "接口（候选接口族）"),
            h("span", { style: MUTED }, "模板是可修正的判断：可确认、拆分或撤回；原始采集与路径来源保留，不因模板合并丢失"),
          ),
          ...sections.map(({ status, bucket, items }) => h("div", { key: "tpl-" + status, style: { display: "flex", flexDirection: "column", gap: 3 } },
            h("div", { style: ROW },
              h("span", { style: { ...H3, fontSize: 14 } }, label[status]),
              h("span", { style: MUTED }, "共 " + String(bucket.total === undefined ? items.length : bucket.total) + " 个"),
              bucket.omitted > 0 ? h("span", { style: MUTED }, "本页未列出 " + String(bucket.omitted) + " 个（按编号经记录读取，不静默截断）") : null,
            ),
            items.length
              ? ui.DataTable({
                  columns: [
                    { key: "id", label: "编号", render: (row) => chip(h, ui, router, row.id, projectId) },
                    { key: "method", label: "方法" },
                    { key: "path_template", label: "路径模板" },
                    { key: "confidence", label: "置信度", render: (row) => (row.confidence === null || row.confidence === undefined || row.confidence === "" ? "—（未提供）" : String(row.confidence)) },
                    { key: "service_asset_id", label: "服务资产", render: (row) => chip(h, ui, router, row.service_asset_id, projectId) },
                  ],
                  rows: items,
                  rowKey: (row) => row.id,
                  sortable: true,
                })
              : h("div", { style: MUTED }, "本状态暂无模板。"),
          )),
          h("div", { style: ROW },
            h("span", { style: MUTED },
              folded
                ? "已折叠：拆分 " + String(folded.split || 0) + " 个 · 撤回 " + String(folded.withdrawn || 0) + " 个（折叠不删记录）"
                : "已折叠：—（未提供）"),
          ),
          templates.expand && templates.expand.how ? h("div", { style: MUTED }, "展开入口：" + String(templates.expand.how)) : null,
          templates.note ? h("div", { style: MUTED }, String(templates.note)) : null,
        );
      }

      renderSources(record) {
        const { h, ui, router } = this.props;
        const projectId = this.projectId();
        const selected = this.selectedId();
        const head = h("div", { key: "src-head", style: ROW },
          h("span", { style: H3 }, "文件及来源"),
          h("span", { style: MUTED }, "来源计数与关联编号来自资产记录；采集详情经 #44 读取，原始字节入口指向 #43"),
        );
        if (!selected) {
          return h("div", { key: "src", style: CARD }, head,
            h("div", { style: HINT }, "在资产列表选择一行（或在右侧详情中打开资产）后，本块呈现该资产的来源文件与采集入口。"),
            h("div", { style: MUTED }, "原始字节经 GET /sorne/evidence/blobs/{sha256} 读取，采集详情经 GET /sorne/captures/{id} 读取；本页不内联字节内容。"),
          );
        }
        if (record.phase === "loading") {
          return h("div", { key: "src", style: CARD }, head, h("div", { style: HINT }, "正在读取记录 " + selected + "…"));
        }
        if (record.phase === "unimplemented" || record.phase === "error") {
          return h("div", { key: "src", style: CARD }, head,
            h("div", { style: MUTED }, "资产记录读取" + (record.phase === "unimplemented" ? "未实现" : "失败") + "：" + errorMessage(record.error)),
            h("div", { style: MUTED }, "未提供不等于不存在：文件与来源入口在记录可读后自动呈现。"),
          );
        }
        const data = record.data || {};
        const rec = data.record && typeof data.record === "object" ? data.record : {};
        const counts = rec.counts && typeof rec.counts === "object" ? rec.counts : null;
        const indexRows = Array.isArray(data.evidence_index) ? data.evidence_index : [];
        const relEdges = data.relations && Array.isArray(data.relations.edges) ? data.relations.edges : [];
        const sourceIds = [];
        for (const e of relEdges) {
          const other = e.from === rec.id ? e.to : e.from;
          if (other && other !== rec.id && !sourceIds.includes(other)) sourceIds.push(other);
        }
        return h("div", { key: "src", style: CARD }, head,
          h("div", { style: ROW }, "当前资产：", chip(h, ui, router, rec.id || selected, projectId),
            h("span", { style: MUTED }, "规范身份：" + String(rec.canonical_key === undefined ? "—（未提供）" : rec.canonical_key))),
          h("div", { style: HINT }, counts
            ? "来源计数（库内）：资源 " + String(counts.resources) + " · 采集 " + String(counts.captures) + " · 观察 " + String(counts.observations)
              + " · 漏洞 " + String(counts.vulnerabilities) + " · 指向此资产的意图 " + String(counts.intents_targeting)
            : "来源计数：—（未提供）"),
          h("div", { style: ROW }, "关联编号：", chipList(h, ui, router, sourceIds.slice(0, 12), projectId),
            sourceIds.length > 12 ? h("span", { style: MUTED }, "其余 " + String(sourceIds.length - 12) + " 个按编号经记录读取") : null),
          indexRows.length
            ? h("div", { style: { display: "flex", flexDirection: "column", gap: 2 } },
                h("div", { style: { ...H3, fontSize: 13.5 } }, "记录的证据索引"),
                ...indexRows.slice(0, 8).map((entry, i) => h("div", { key: "idx" + i, style: ROW },
                  chip(h, ui, router, entry.capture_id || entry.member_id || entry.membership_id, projectId),
                  entry.response_body_blob && entry.response_body_blob.sha256
                    ? h("span", { style: MUTED }, ui.formatHash(entry.response_body_blob.sha256))
                    : null,
                )))
            : null,
          h("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
            h("div", { style: { ...H3, fontSize: 13.5 } }, "读取采集详情（#44）"),
            h("div", { style: HINT }, "输入采集编号（CAP-…）读取请求/响应元数据；原始字节经 #43 按哈希读取，本块不内联字节。"),
            ...this.renderCaptureReader(),
          ),
        );
      }

      renderCaptureReader() {
        const { h } = this.props;
        const c = this.state.capture || { phase: "idle", id: "", data: null, error: null };
        return [
          h("div", { key: "cap-row", style: ROW },
            h("input", {
              key: "cap-input",
              type: "text",
              value: c.id,
              placeholder: "例如：CAP-0001",
              "aria-label": "采集编号",
              onChange: (e) => this.setState({ capture: { phase: "idle", id: e.target.value, data: null, error: null } }),
              style: INPUT,
            }),
            h("button", {
              key: "cap-btn",
              type: "button",
              "aria-label": "读取采集详情",
              onClick: () => this.readCapture(),
              style: btnStyle(null),
            }, "读取采集详情"),
          ),
          c.phase === "loading" ? h("div", { key: "cap-loading", style: MUTED }, "正在读取采集详情…") : null,
          c.phase === "error" ? h("div", { key: "cap-error", style: { ...MUTED, color: "var(--sorne-status-unknown-fg)" } },
            "采集详情读取失败：" + errorMessage(c.error)) : null,
          c.phase === "unimplemented" ? h("div", { key: "cap-unimpl", style: MUTED }, "采集详情未实现（501 未实现 ≠ 报错）。") : null,
          c.phase === "ready" && c.data ? this.renderCaptureData(c.data) : null,
        ];
      }

      renderCaptureData(data) {
        const { h, ui, router } = this.props;
        const projectId = this.projectId();
        const cap = data.capture && typeof data.capture === "object" ? data.capture : {};
        const body = data.response_body_blob && typeof data.response_body_blob === "object" ? data.response_body_blob : null;
        const reqRef = data.request_ref_blob && typeof data.request_ref_blob === "object" ? data.request_ref_blob : null;
        const pointers = data.read_pointers && typeof data.read_pointers === "object" ? data.read_pointers : {};
        const fallbackId = this.state.capture && this.state.capture.id ? this.state.capture.id : null;
        return h("div", { key: "cap-data", style: { display: "flex", flexDirection: "column", gap: 2, borderTop: "1px solid var(--sorne-border)", paddingTop: 6 } },
          h("div", { style: ROW }, "采集：", chip(h, ui, router, cap.capture_id || cap.id || fallbackId, projectId)),
          h("div", { style: MUTED }, "请求 URL（原样呈现，不改写、不清洗、不重排参数）：" + String(cap.request_url_exact === undefined ? "—（未提供）" : cap.request_url_exact)),
          h("div", { style: MUTED }, "完整性状态：" + String(cap.integrity_status === undefined ? "—（未提供）" : cap.integrity_status)),
          h("div", { style: ROW }, "响应字节：", body && body.sha256 ? ui.formatHash(body.sha256) : h("span", { style: MUTED }, "—（未提供）")),
          h("div", { style: MUTED }, "原始字节读取入口：" + String(pointers.response_body_bytes || "/sorne/evidence/blobs/{sha256}（#43）")),
          reqRef && reqRef.representation ? h("div", { style: MUTED }, "请求记录表示：" + String(reqRef.representation)) : null,
          Array.isArray(data.transforms) && data.transforms.length
            ? h("div", { style: MUTED }, "派生链 " + String(data.transforms.length) + " 条（原始证据保留，派生不覆盖原始）")
            : null,
        );
      }

      async readCapture() {
        const { api } = this.props;
        const projectId = this.projectId();
        const c = this.state.capture || {};
        const id = String(c.id || "").trim();
        if (!id) {
          this.setState({ capture: { phase: "error", id: c.id || "", data: null, error: { message: "请填写采集编号" } } });
          return;
        }
        this.setState({ capture: { phase: "loading", id, data: null, error: null } });
        try {
          const data = await api("/sorne/captures/" + encodeURIComponent(id) + "?project_id=" + encodeURIComponent(projectId));
          this.setState({ capture: { phase: "ready", id, data, error: null } });
        } catch (e) {
          this.setState({ capture: { phase: isUnimplemented(e) ? "unimplemented" : "error", id, data: null, error: e } });
        }
      }
    }

    return h(AssetsBody, { React, h, api, router, ui, theme });
  },

  /** 右侧详情：资产字段 + 来源/相关发现/已开展探索 + 「就此资产向 AI 下任务」消息草稿。 */
  renderDetail({ React, h, api, router, ui, theme }) {
    const ComponentBase = makeBase(React);

    class AssetDetail extends ComponentBase {
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
        const projectId = this.projectId();
        const id = this.targetId();
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
            draft: prev.draft === null
              ? "请针对资产 " + String(rec && rec.id ? rec.id : id) + "（" + String(rec && rec.canonical_key ? rec.canonical_key : "规范身份未提供") + "）安排下一步探索："
              : prev.draft,
          }));
        } catch (e) {
          if (seq !== this.seq) return;
          this.setState({ rec: { phase: isUnimplemented(e) ? "unimplemented" : "error", data: null, error: e } });
        }
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

      openRecord(fullId) {
        const r = this.props.router;
        if (r && typeof r.openRecord === "function") r.openRecord(fullId);
      }

      render() {
        const { h, ui } = this.props;
        const { rec, draft, msg } = this.state;
        if (!ui || typeof ui.FieldRow !== "function") {
          return h("div", { style: CARD }, h("div", { style: H3 }, "渲染器未就绪"), h("div", { style: HINT }, "详情依赖设计系统渲染器；当前宿主未提供。"));
        }
        const id = this.targetId();
        if (!id) return h("div", { style: CARD }, h("div", { style: HINT }, "未选择资产：在资产列表点击一行打开详情。"));
        if (rec.phase === "loading") return h("div", { style: CARD }, h("div", { style: HINT }, "正在读取资产记录 " + id + "…"));
        if (rec.phase === "unimplemented" || rec.phase === "error") {
          return h("div", { style: CARD },
            h("div", { style: H3 }, "资产 " + id + (rec.phase === "unimplemented" ? "读取未实现" : "读取失败")),
            h("div", { style: HINT }, errorMessage(rec.error)),
            h("div", { style: MUTED }, "未提供不等于不存在：可稍后重试或经记录编号核对。"),
          );
        }
        const data = rec.data || {};
        const r = data.record && typeof data.record === "object" ? data.record : {};
        const projectId = this.projectId();
        const edges = data.relations && Array.isArray(data.relations.edges) ? data.relations.edges : [];
        const findings = [];
        const explorations = [];
        const sources = [];
        for (const e of edges) {
          const other = e.from === r.id ? e.to : e.from;
          if (!other || other === r.id) continue;
          const prefix = String(other).split("-")[0];
          if (prefix === "V" || prefix === "H" || prefix === "F") findings.push(other);
          else if (prefix === "I" || prefix === "ATT") explorations.push(other);
          else sources.push(other);
        }
        const counts = r.counts && typeof r.counts === "object" ? r.counts : null;
        const msgStatus = msg.result && msg.result.message ? msg.result.message.status : null;

        const child = [];
        child.push(h("div", { key: "head", style: ROW },
          h("span", { style: H2 }, "资产详情"),
          chip(h, ui, this.props.router, r.id || id, projectId),
        ));
        child.push(h("div", { key: "fields", style: CARD },
          ui.FieldRow("id", r.id || id),
          ui.FieldRow("asset_type", r.asset_type),
          ui.FieldRow("canonical_key", r.canonical_key),
          ui.FieldRow("original_input", r.original_input),
          ui.FieldRow("scope_status", r.scope_status),
          ui.FieldRow("canonicalization_version", r.canonicalization_version),
          ui.FieldRow("activity_seq", r.activity_seq),
          ui.FieldRow("created_seq", r.created_seq),
          ui.FieldRow("created_at", r.created_at),
          ui.FieldRow("created_by", r.created_by),
        ));
        child.push(h("div", { key: "counts", style: CARD },
          h("div", { style: H3 }, "来源与关联（计数来自资产记录）"),
          h("div", { style: HINT }, counts
            ? "资源 " + String(counts.resources) + " · 采集 " + String(counts.captures) + " · 观察 " + String(counts.observations)
              + " · 漏洞 " + String(counts.vulnerabilities) + " · 指向此资产的意图 " + String(counts.intents_targeting)
            : "—（未提供）"),
          h("div", { style: ROW }, "来源编号：", chipList(h, ui, this.props.router, sources.slice(0, 10), projectId)),
        ));
        child.push(h("div", { key: "findings", style: CARD },
          h("div", { style: H3 }, "相关发现"),
          findings.length
            ? h("div", { style: ROW }, ...findings.map((x, i) => h("span", { key: "f" + i }, chip(h, ui, this.props.router, x, projectId))))
            : h("div", { style: MUTED }, "—（未提供）"),
          h("div", { style: MUTED }, "漏洞状态以库为准：已确认永远带「（限指定条件）」，证据不足不伪装成已排除。"),
        ));
        child.push(h("div", { key: "expl", style: CARD },
          h("div", { style: H3 }, "已开展的探索"),
          explorations.length
            ? h("div", { style: ROW }, ...explorations.map((x, i) => h("span", { key: "e" + i }, chip(h, ui, this.props.router, x, projectId))))
            : h("div", { style: MUTED }, "—（未提供）"),
        ));
        child.push(h("div", { key: "edges", style: CARD },
          h("div", { style: H3 }, "关系边"),
          edges.length
            ? h("div", { style: { display: "flex", flexDirection: "column", gap: 2 } },
                ...edges.slice(0, 12).map((e, i) => h("div", { key: "edge" + i, style: ROW },
                  h("span", { style: MUTED }, relationLabel(e.relation_type) + "："),
                  chip(h, ui, this.props.router, e.from, projectId),
                  h("span", { style: MUTED }, "→"),
                  chip(h, ui, this.props.router, e.to, projectId),
                  e.retracted_at ? h("span", { style: MUTED }, "（已撤回，历史保留）") : null,
                  e.requires_state ? h("span", { style: MUTED }, "前提状态：" + String(e.requires_state)) : null,
                )),
                data.relations && data.relations.truncated ? h("div", { style: MUTED }, "边数超出上限，其余按编号经记录读取（不静默截断）。") : null,
              )
            : h("div", { style: MUTED }, "—（未提供）"),
        ));
        child.push(h("div", { key: "msg", style: CARD },
          h("div", { style: H3 }, "就此资产向 AI 下任务"),
          h("div", { style: HINT }, "预填消息草稿：发送后进入消息闭环（已接收 ≠ 已处理；AI 处理结果经消息链接与回复呈现）。"),
          h("textarea", {
            "aria-label": "资产任务消息草稿",
            value: draft === null ? "" : draft,
            rows: 3,
            onChange: (e) => this.setState({ draft: e.target.value }),
            style: { ...INPUT, width: "100%", minWidth: 0, minHeight: 62, resize: "vertical" },
          }),
          h("div", { style: ROW },
            h("button", { type: "button", "aria-label": "发送资产任务消息", onClick: () => this.send(), style: btnStyle("primary") }, "发送消息"),
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

    return h(AssetDetail, { React, h, api, router, ui, theme });
  },
};
