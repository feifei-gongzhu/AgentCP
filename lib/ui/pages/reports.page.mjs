/**
 * 页面：报告（lib/ui/pages/reports.page.mjs；M6 重写；BLUEPRINT-UI 1.5 / e-J6 / g）。
 *
 * 只回答「成果如何阅读和交付？」：
 *   - 阅读：漏洞报告（端点 39，当前与历史版本、单份详情）与阶段报告（端点 40，五分区
 *     与覆盖缺口）；每个版本明示数据截止边界（提交边界 + 生成时间），边界之后提交的
 *     发现不在该版本内（不代表全量）；
 *   - 按需生成：阶段报告生成按钮走既有端点 40 的 refresh=1（读取默认不增殖版本）；
 *     生成报告不结束项目，报告是持续探索的引用入口；
 *   - 导出：端点 53 按报告版本导出 Markdown（下载）；失败如实呈现 404 与下一步条件，
 *     不虚报导出成功；内容文件不可读时可先生成携带最新边界的新版本再导出；
 *   - 追溯：报告内全部编号经 ui.RecordIdChip 渲染（点击 openRecord 打开记录覆盖层，
 *     跳转发现/证据/意图），页面不复制编号、不让用户手抄编号。
 *
 * 设计系统（唯一取数渲染入口）：
 *   - 时间/编号/状态/字段全部经 ctx.ui（formatTime / RecordIdChip / StatusBadge /
 *     FieldRow / FoldableObject / EmptyState）；页面不写编号正则、不写颜色字面量、
 *     只引用 --sorne-* 主题 token；正文 13–14px；
 *   - 解释性规范段落收进「语义说明」折叠区（折叠不删记录，展开可见全部计数）；
 *     页面正文只保留任务导向一句与数据口径，可见区域不出现规范章节引用。
 *
 * 页面契约（BLUEPRINT-UI 2.4-2 / 2.5，冻结）：纯 ESM、不 import 任何包或 Node 内置
 * 模块、不用浏览器本地存储；export default { id, title, order, render(ctx),
 * renderDetail(ctx) }；有状态部分为 React.Component 子类；路由变化经
 * router.onChange 订阅（keep-alive 外壳切走再切回时保留交互状态）。
 *
 * 数据来源：GET /sorne/records/{RR-|MR-}（端点 14，报告版本行 → 主体与版本）→
 * GET /sorne/reports/vulnerabilities?id=&version=（端点 39）或
 * GET /sorne/reports/milestones?version=（端点 40）；导出端点 53。
 * 测试：test/ui-reports.test.mjs（fakeApi 精确形状 + withTestServer 真实服务）。
 */

/* ── 内联样式（全部经主题 token；禁止字面颜色值） ─────────────────── */

const WRAP = { display: "flex", flexDirection: "column", gap: 12, width: "100%" };
const CARD = {
  background: "var(--sorne-bg-surface)",
  border: "1px solid var(--sorne-border)",
  borderRadius: 8,
  padding: "10px 12px",
  display: "flex",
  flexDirection: "column",
  gap: 6,
};
const MUTED = { fontSize: 13, color: "var(--sorne-text-secondary)", lineHeight: 1.6 };
const SMALL = { fontSize: 13, color: "var(--sorne-text-muted)", lineHeight: 1.6 };
const SECTION_TITLE = { fontSize: 14, fontWeight: 700, color: "var(--sorne-text-primary)", margin: 0 };
const ROW = { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" };
const STACK = { display: "flex", flexDirection: "column", gap: 4 };
const TABLE = { width: "100%", borderCollapse: "collapse", fontSize: 13.5, lineHeight: 1.55 };
const TH = {
  textAlign: "left",
  padding: "6px 8px",
  fontSize: 13,
  color: "var(--sorne-text-secondary)",
  background: "var(--sorne-bg-subtle)",
  borderBottom: "1px solid var(--sorne-border)",
  whiteSpace: "nowrap",
};
const TD = {
  padding: "6px 8px",
  verticalAlign: "top",
  color: "var(--sorne-text-primary)",
  borderBottom: "1px solid var(--sorne-border)",
};
const NOTICE = {
  border: "1px solid var(--sorne-border-strong)",
  borderRadius: 8,
  background: "var(--sorne-bg-subtle)",
  color: "var(--sorne-text-secondary)",
  padding: "8px 10px",
  fontSize: 13,
  lineHeight: 1.6,
};
const ALERT = {
  border: "1px solid var(--sorne-status-unknown-fg)",
  borderRadius: 8,
  background: "var(--sorne-bg-surface)",
  color: "var(--sorne-status-unknown-fg)",
  padding: "8px 10px",
  fontSize: 13,
  lineHeight: 1.6,
};
const MONO = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 13, wordBreak: "break-all" };

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
  if (variant === "chip") {
    base.borderRadius = 999;
    base.padding = "1px 10px";
  }
  if (disabled) {
    base.opacity = 0.55;
    base.cursor = "default";
  } else {
    base.cursor = "pointer";
  }
  return base;
}

/* ── 错误信封（端点统一 {code,message,retryable,next_requirements}） ─── */

function errorInfo(e) {
  const err = e || {};
  const code = typeof err.code === "string" ? err.code : "";
  const status = typeof err.status === "number" ? err.status : null;
  const message = err && err.message ? String(err.message) : String(err);
  const body = err && err.body && typeof err.body === "object" ? err.body : null;
  const detail = (err && err.detail && typeof err.detail === "object" ? err.detail : null)
    || (body && body.detail && typeof body.detail === "object" ? body.detail : null);
  const note = detail && typeof detail.note === "string" ? detail.note : "";
  const module = (detail && typeof detail.module === "string" ? detail.module : "")
    || (err && typeof err.module === "string" ? err.module : "")
    || (body && typeof body.module === "string" ? body.module : "");
  return {
    code,
    status,
    message,
    note,
    module,
    notImpl: code === "NOT_IMPLEMENTED" || status === 501,
    notFound: code === "NOT_FOUND" || status === 404,
  };
}

function errText(info) {
  return info.code ? info.code + " · " + info.message : info.message;
}

/* ── 数据口径与安全取值 ──────────────────────────────────────────── */

function asObject(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : null;
}
function asArray(v) {
  return Array.isArray(v) ? v : [];
}
function asNumber(v, fallback) {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
function asText(v, fallback) {
  if (typeof v === "string" && v.trim()) return v;
  return fallback;
}

/** 数据截止边界文本：提交边界 + 生成时间（对象形态；缺失如实「—（未提供）」）。 */
function boundaryText(ui, boundary) {
  const b = asObject(boundary);
  if (!b) return "—（未提供）";
  const seq = b.snapshot_commit_seq;
  const seqText = typeof seq === "number" || (typeof seq === "string" && seq)
    ? "提交边界 " + seq
    : "提交边界 —（未提供）";
  const at = b.generated_at;
  const atText = at ? "生成于 " + ui.formatTime(at, { mode: "absolute" }) : "生成时间 —（未提供）";
  return seqText + " · " + atText;
}

/** 版本标签（vN）。 */
function versionLabel(version) {
  return version ? "（" + version + "）" : "";
}

/** 编号 chip（完整编号，点击 openRecord；不做子串匹配、不复制编号）。 */
function chipNode(ui, router, id) {
  if (!id || typeof id !== "string") return "—（未提供）";
  return ui.RecordIdChip(id, {
    projectId: router && router.projectId ? router.projectId : "",
    navigate: (ref) => {
      if (router && typeof router.openRecord === "function") router.openRecord(ref);
    },
  });
}

const STANCE_LABELS = { supports: "支持", contradicts: "反对", neutral: "中性" };
const MEMBERSHIP_LABELS = { active: "有效", withdrawn: "已撤回", disputed: "有争议" };
const MEMBER_KIND_LABELS = {
  observations: "观察",
  captures: "采集记录",
  blobs: "证据字节",
  hypotheses: "假设",
  facts: "事实",
  vulnerabilities: "漏洞",
};
const DIRECTION_LABELS = [
  ["collect", "搜集"],
  ["investigate", "调查"],
  ["verify", "验证"],
  ["revisit", "回访"],
];

function stanceLabel(v) {
  return STANCE_LABELS[v] || (v ? String(v) + "（未登记立场，按原值呈现）" : "—（未提供）");
}
function membershipLabel(v) {
  return MEMBERSHIP_LABELS[v] || (v ? String(v) + "（未登记状态）" : "—（未提供）");
}
function memberKindLabel(v) {
  return MEMBER_KIND_LABELS[v] || (v ? String(v) : "—（未提供）");
}

/** Markdown 导出响应（真实 client api 对非 JSON 响应返回 {raw}；测试替身可返回字符串）。 */
function markdownText(data) {
  if (typeof data === "string") return data;
  const obj = asObject(data);
  if (obj && typeof obj.raw === "string") return obj.raw;
  if (obj && typeof obj.markdown === "string") return obj.markdown;
  return "";
}

/** 报告编号分类（编号解析经 ui.parseRecordId，唯一实现；未知如实报错）。 */
function classifyReportId(ui, id) {
  const parsed = ui && typeof ui.parseRecordId === "function" ? ui.parseRecordId(id) : null;
  if (!parsed) return { kind: "unknown", id: String(id || "") };
  if (parsed.prefix === "V") return { kind: "vulnerability", id: parsed.id };
  if (parsed.prefix === "RR" || parsed.prefix === "MR") return { kind: "revision", id: parsed.id };
  return { kind: "unknown", id: parsed.id, label: parsed.kindLabel || parsed.prefix };
}

export default {
  id: "reports",
  title: "报告",
  order: 60,

  render({ React, h, api, router, ui, theme }) {
    const ComponentBase = React && typeof React.Component === "function"
      ? React.Component
      : class PageComponentBase {
          constructor(props) {
            this.props = props || {};
          }
        };

    class ReportsPage extends ComponentBase {
      constructor(props) {
        super(props);
        this.state = {
          vulns: {
            phase: "loading",
            rows: [],
            nextCursor: null,
            hasMore: false,
            summary: null,
            note: "",
            error: null,
            dataAt: null,
            unknownShape: false,
          },
          milestone: {
            phase: "loading",
            data: null,
            error: null,
            unknownShape: false,
            generating: false,
            generateError: null,
            refreshed: false,
            dataAt: null,
          },
          navSeq: 0,
        };
        this.onNav = this.onNav.bind(this);
        this.unsubNav = null;
        this.vulnSeq = 0;
        this.milestoneSeq = 0;
      }

      componentDidMount() {
        const routerNow = this.props.router;
        if (routerNow && typeof routerNow.onChange === "function") {
          this.unsubNav = routerNow.onChange(this.onNav);
        }
        this.loadVulns(null, { append: false });
        this.loadMilestone({});
      }

      componentWillUnmount() {
        if (typeof this.unsubNav === "function") this.unsubNav();
      }

      onNav() {
        this.setState((prev) => ({ navSeq: prev.navSeq + 1 }));
      }

      /* ── 漏洞报告（端点 39，摘要列表：cursor 分页不静默截断） ─────── */

      async loadVulns(cursor, { append }) {
        const { api } = this.props;
        const projectId = this.props.router ? this.props.router.projectId : "";
        if (!projectId) return;
        const seq = ++this.vulnSeq;
        this.setState((prev) => ({
          vulns: {
            ...prev.vulns,
            phase: append ? prev.vulns.phase : "loading",
            error: null,
            dataAt: prev.vulns.dataAt,
          },
        }));
        let path = "/sorne/reports/vulnerabilities?project_id=" + encodeURIComponent(projectId);
        if (cursor) path += "&cursor=" + encodeURIComponent(cursor);
        try {
          const data = await api(path);
          if (seq !== this.vulnSeq) return;
          const list = asObject(data) && Array.isArray(data.reports) ? data.reports : null;
          if (!list) {
            this.setState({
              vulns: {
                phase: "ready",
                rows: [],
                nextCursor: null,
                hasMore: false,
                summary: null,
                note: "",
                error: null,
                dataAt: new Date().toISOString(),
                unknownShape: true,
              },
            });
            return;
          }
          this.setState((prev) => {
            const merged = append ? this.mergeRows(prev.vulns.rows, list) : list;
            return {
              vulns: {
                phase: "ready",
                rows: merged,
                nextCursor: data && typeof data.next_cursor === "string" ? data.next_cursor : null,
                hasMore: Boolean(data && data.has_more),
                summary: asObject(data && data.summary),
                note: asText(data && data.note, ""),
                error: null,
                dataAt: new Date().toISOString(),
                unknownShape: false,
              },
            };
          });
        } catch (e) {
          if (seq !== this.vulnSeq) return;
          this.setState({
            vulns: {
              phase: errorInfo(e).notImpl ? "notimpl" : "error",
              rows: [],
              nextCursor: null,
              hasMore: false,
              summary: null,
              note: "",
              error: e,
              dataAt: new Date().toISOString(),
              unknownShape: false,
            },
          });
        }
      }

      mergeRows(prevRows, nextRows) {
        const seen = new Set(prevRows.map((r) => r && r.id).filter(Boolean));
        const out = prevRows.slice();
        for (const row of nextRows) {
          if (!row || typeof row !== "object") continue;
          const key = row.id || row.subject_id || row.report_id;
          if (key && seen.has(key)) continue;
          if (key) seen.add(key);
          out.push(row);
        }
        return out;
      }

      /* ── 阶段报告（端点 40，单份对象；refresh=1 为显式生成） ─────── */

      async loadMilestone({ refresh }) {
        const { api } = this.props;
        const projectId = this.props.router ? this.props.router.projectId : "";
        if (!projectId) return;
        const seq = ++this.milestoneSeq;
        this.setState((prev) => ({
          milestone: {
            ...prev.milestone,
            phase: refresh ? prev.milestone.phase : "loading",
            error: null,
            generating: Boolean(refresh),
            generateError: null,
            refreshed: false,
          },
        }));
        let path = "/sorne/reports/milestones?project_id=" + encodeURIComponent(projectId);
        if (refresh) path += "&refresh=1";
        try {
          const data = await api(path);
          if (seq !== this.milestoneSeq) return;
          if (!asObject(data) || !asObject(data.report)) {
            this.setState({
              milestone: {
                phase: "ready",
                data: null,
                error: null,
                unknownShape: true,
                generating: false,
                generateError: null,
                refreshed: false,
                dataAt: new Date().toISOString(),
              },
            });
            return;
          }
          this.setState({
            milestone: {
              phase: "ready",
              data,
              error: null,
              unknownShape: false,
              generating: false,
              generateError: null,
              refreshed: Boolean(data.refreshed),
              dataAt: new Date().toISOString(),
            },
          });
        } catch (e) {
          if (seq !== this.milestoneSeq) return;
          const info = errorInfo(e);
          this.setState((prev) => ({
            milestone: {
              ...prev.milestone,
              phase: info.notImpl ? "notimpl" : "error",
              data: null,
              error: e,
              unknownShape: false,
              generating: false,
              generateError: refresh ? e : null,
              refreshed: false,
              dataAt: new Date().toISOString(),
            },
          }));
        }
      }

      /* ── 导航（hash 为唯一详情状态：?id=RR-/MR- 编号） ──────────── */

      openReport(reportId) {
        const router = this.props.router;
        if (!router || typeof router.open !== "function") return;
        if (!reportId) return;
        router.open(
          "#/p/" + encodeURIComponent(router.projectId || "") + "/reports?id=" + encodeURIComponent(reportId),
        );
      }

      render() {
        const { h, ui, router } = this.props;
        const { vulns, milestone } = this.state;
        const projectId = router ? router.projectId : "";

        if (!ui || typeof ui.formatTime !== "function" || typeof ui.RecordIdChip !== "function") {
          return h("div", { style: WRAP },
            h("div", { role: "alert", style: ALERT },
              h("div", { style: { fontWeight: 600 } }, "渲染器未就绪"),
              h("div", null, "报告页依赖设计系统渲染器（时间/编号/状态/折叠）。当前宿主未提供，页面以降级态呈现，不做数据猜测。")));
        }

        const children = [];
        children.push(h("div", { key: "head", style: { display: "flex", flexDirection: "column", gap: 4 } },
          h("h2", { style: { margin: 0, fontSize: 17, color: "var(--sorne-text-primary)" } }, "报告"),
          h("div", { style: MUTED },
            "阅读当前与历史报告版本，按需生成阶段报告并导出 Markdown；报告是持续探索的引用入口，生成报告不结束项目。"),
        ));

        if (!projectId) {
          children.push(h("div", { key: "no-project", style: WRAP },
            ui.EmptyState({
              title: "缺少项目上下文",
              hint: "报告按项目读取；请从项目列表进入工作区后再打开报告页。",
            })));
          return h("div", { style: WRAP }, ...children);
        }

        children.push(this.renderVulnSection());
        children.push(this.renderMilestoneSection());
        children.push(this.renderCoverageSection());
        children.push(this.renderSemantics());
        children.push(this.renderDataMeta());

        return h("div", { style: WRAP }, ...children);
      }

      /* ── 漏洞报告区 ────────────────────────────────────────────── */

      renderVulnSection() {
        const { h, ui, router } = this.props;
        const vulns = this.state.vulns;
        const rows = asArray(vulns.rows);
        const summary = asObject(vulns.summary);

        const head = h("div", { key: "vuln-head", style: { display: "flex", flexDirection: "column", gap: 4 } },
          h("h3", { style: SECTION_TITLE }, "漏洞报告"),
          h("div", { style: MUTED }, "每个漏洞自疑似阶段即有两个文档版本；当前版本随状态/证据/条件/影响更新，历史版本保留可读回。"),
          h("div", { style: ROW },
            h("button", {
              type: "button",
              "aria-label": "刷新漏洞报告",
              onClick: () => this.loadVulns(null, { append: false }),
              style: btnStyle("quiet"),
            }, "刷新"),
            summary
              ? h("span", { style: SMALL },
                  "汇总（按已加载数据推导）：共 " + asNumber(summary.total, rows.length) + " 个报告主体")
              : h("span", { style: SMALL }, "汇总计数 —（未提供）")));

        const body = [];
        if (vulns.phase === "loading") {
          body.push(h("div", { key: "loading", role: "status", style: MUTED }, "正在读取漏洞报告…"));
        } else if (vulns.phase === "notimpl") {
          body.push(h("div", { key: "notimpl", role: "status", style: NOTICE },
            h("div", { style: { fontWeight: 600 } }, "漏洞报告未实现（不是报错）"),
            h("div", null, errText(errorInfo(vulns.error))),
            errorInfo(vulns.error).module
              ? h("div", { style: SMALL }, "负责模块：" + errorInfo(vulns.error).module)
              : null));
        } else if (vulns.phase === "error") {
          body.push(h("div", { key: "error", role: "alert", style: ALERT },
            h("div", { style: { fontWeight: 600 } }, "漏洞报告加载失败"),
            h("div", null, errText(errorInfo(vulns.error))),
            h("button", {
              type: "button",
              "aria-label": "重试加载漏洞报告",
              onClick: () => this.loadVulns(null, { append: false }),
              style: btnStyle(null),
            }, "重试")));
        } else if (vulns.unknownShape) {
          body.push(h("div", { key: "unknown", role: "alert", style: NOTICE },
            "漏洞报告响应形状无法识别（缺少 reports 数组）：不静默当作空，请稍后重试。"));
        } else if (!rows.length) {
          body.push(h("div", { key: "empty", style: WRAP },
            ui.EmptyState({
              title: "暂无漏洞报告",
              hint: "漏洞自疑似阶段起即应有报告草稿；确认、排除与争议会同步当前视图（历史版本保留）。",
            })));
        } else {
          body.push(this.renderVulnTable(rows));
          body.push(h("div", { key: "vuln-meta", style: SMALL },
            "已加载 " + rows.length + " 个报告主体 · 计数按已加载数据推导"
            + (vulns.hasMore ? " · 不代表全量（还有未加载页）" : "")));
          if (vulns.note) {
            body.push(ui.FoldableObject([vulns.note], { level: 1, summary: "服务端口径说明" }));
          }
          if (vulns.hasMore && vulns.nextCursor) {
            body.push(h("button", {
              key: "more",
              type: "button",
              "aria-label": "加载更多漏洞报告",
              onClick: () => this.loadVulns(vulns.nextCursor, { append: true }),
              style: btnStyle(null),
            }, "加载更多漏洞报告"));
          }
        }
        return h("section", { key: "vuln-section", style: CARD }, head, ...body);
      }

      renderVulnTable(rows) {
        const { h, ui, router } = this.props;
        const heads = ["漏洞编号", "状态", "复核状态", "当前版本", "版本数", "数据截止边界", "报告版本编号"];
        return h("table", { key: "vuln-table", style: TABLE },
          h("thead", null,
            h("tr", null, heads.map((label) => h("th", { key: label, scope: "col", style: TH }, label)))),
          h("tbody", null, rows.map((row, idx) => {
            const item = asObject(row) || {};
            const reportId = asText(item.report_id, "");
            const onRowClick = reportId && this.props.router && typeof this.props.router.open === "function"
              ? () => this.openReport(reportId)
              : undefined;
            return h("tr", {
              key: item.id || item.subject_id || "vuln-" + idx,
              onClick: onRowClick,
              style: {
                background: "var(--sorne-bg-surface)",
                cursor: onRowClick ? "pointer" : "default",
              },
            },
              h("td", { style: TD }, chipNode(ui, router, item.id || item.subject_id)),
              h("td", { style: TD }, ui.StatusBadge("vulnerability_status", item.status)),
              h("td", { style: TD }, ui.StatusBadge("review_status", item.review)),
              h("td", { style: TD }, asText(item.latest_version, "—（未提供）")),
              h("td", { style: TD }, String(asNumber(item.versions, "—（未提供）"))),
              h("td", { style: TD, title: "边界之后提交的发现不在该版本内，不代表全量" },
                boundaryText(ui, item.data_boundary)),
              h("td", { style: TD },
                reportId
                  ? chipNode(ui, router, reportId)
                  : h("span", { style: SMALL }, "—（未提供）")));
          })));
      }

      /* ── 阶段报告区（五分区 + 版本切换 + 按需生成） ─────────────── */

      renderMilestoneSection() {
        const { h, ui, router } = this.props;
        const ms = this.state.milestone;
        const data = asObject(ms.data);
        const report = data ? asObject(data.report) : null;
        const meta = data ? asObject(data.report_meta) : null;

        const actions = [
          h("button", {
            key: "refresh",
            type: "button",
            "aria-label": "刷新阶段报告",
            onClick: () => this.loadMilestone({}),
            style: btnStyle("quiet"),
          }, "刷新"),
          h("button", {
            key: "generate",
            type: "button",
            "aria-label": "生成阶段报告（refresh=1，数据截止到当前）",
            disabled: ms.generating,
            onClick: () => this.loadMilestone({ refresh: true }),
            style: btnStyle("primary", ms.generating),
          }, ms.generating ? "正在生成阶段报告…" : "生成阶段报告（数据截止到当前）"),
        ];
        if (report && meta && meta.report_id) {
          actions.push(h("button", {
            key: "open",
            type: "button",
            "aria-label": "阅读完整阶段报告",
            onClick: () => this.openReport(meta.report_id),
            style: btnStyle(null),
          }, "阅读完整阶段报告"));
        }

        const head = h("div", { key: "ms-head", style: { display: "flex", flexDirection: "column", gap: 4 } },
          h("h3", { style: SECTION_TITLE }, "阶段报告"),
          h("div", { style: MUTED }, "阶段报告注明数据截止版本与时间；读取默认不增殖版本，只有显式生成才推进新版本。"),
          h("div", { style: ROW }, ...actions));

        const body = [];
        if (ms.phase === "loading") {
          body.push(h("div", { key: "loading", role: "status", style: MUTED }, "正在读取阶段报告…"));
        } else if (ms.phase === "notimpl") {
          body.push(h("div", { key: "notimpl", role: "status", style: NOTICE },
            h("div", { style: { fontWeight: 600 } }, "阶段报告未实现（不是报错）"),
            h("div", null, errText(errorInfo(ms.error)))));
        } else if (ms.phase === "error") {
          body.push(h("div", { key: "error", role: "alert", style: ALERT },
            h("div", { style: { fontWeight: 600 } }, "阶段报告加载失败"),
            h("div", null, errText(errorInfo(ms.error))),
            h("button", {
              type: "button",
              "aria-label": "重试加载阶段报告",
              onClick: () => this.loadMilestone({}),
              style: btnStyle(null),
            }, "重试")));
        } else if (ms.unknownShape || !report) {
          body.push(h("div", { key: "unknown", role: "alert", style: NOTICE },
            "阶段报告响应形状无法识别（缺少 report 对象）：不静默当作空，请稍后重试。"));
        } else {
          body.push(this.renderMilestoneCard(data, report, meta));
        }
        return h("section", { key: "ms-section", style: CARD }, head, ...body);
      }

      renderMilestoneCard(data, report, meta) {
        const { h, ui, router } = this.props;
        const currentVersion = asText(data.current_version, "");
        const requestedVersion = asText(data.requested_version, currentVersion);
        const history = asArray(data.history);
        const confirmedObj = asObject(report.confirmed_findings);
        const leadsObj = asObject(report.unconfirmed_leads);
        const completedObj = asObject(report.completed_directions);
        const blockedObj = asObject(report.blocked_directions);
        const uncoveredObj = asObject(report.uncovered);
        const confirmed = confirmedObj || {};
        const leads = leadsObj || {};
        const completed = completedObj || {};
        const blocked = blockedObj || {};
        const uncovered = uncoveredObj || {};
        const exploration = asObject(report.exploration_continues) || {};
        const coverage = asObject(report.coverage) || {};

        const versionButtons = [];
        const currentRow = history.find((row) => row && row.version === currentVersion);
        const currentReportId = currentRow && currentRow.report_id ? currentRow.report_id : (meta && meta.report_id);
        versionButtons.push(h("button", {
          key: "current",
          type: "button",
          "aria-label": "打开当前版本阶段报告",
          disabled: requestedVersion === currentVersion,
          onClick: () => this.openReport(currentReportId),
          style: btnStyle("chip", requestedVersion === currentVersion),
        }, "当前版本" + versionLabel(currentVersion)));
        history.slice().reverse().forEach((row) => {
          const version = row && typeof row.version === "string" ? row.version : "";
          if (!version || version === currentVersion) return;
          versionButtons.push(h("button", {
            key: "v-" + version,
            type: "button",
            "aria-label": "打开历史版本阶段报告 " + version,
            onClick: () => this.openReport(row.report_id),
            style: btnStyle("chip", false),
          }, "历史版本" + versionLabel(version)));
        });

        const partition = (label, text) => h("div", { key: label, style: { fontSize: 13.5, lineHeight: 1.6 } },
          h("span", { style: { fontWeight: 600 } }, label + "："),
          text === null ? h("span", { style: SMALL }, "—（未提供）") : text);

        return h("div", { key: "ms-card", style: STACK },
          h("div", { style: ROW },
            h("span", { style: { fontSize: 13, fontWeight: 600, color: "var(--sorne-text-secondary)" } }, "版本："),
            ...versionButtons),
          h("div", { style: ROW },
            h("span", { style: { fontSize: 13, fontWeight: 600, color: "var(--sorne-text-secondary)" } }, "报告版本编号："),
            meta && meta.report_id ? chipNode(ui, router, meta.report_id) : h("span", { style: SMALL }, "—（未提供）")),
          h("div", { style: { fontWeight: 600, fontSize: 13.5 } },
            "数据截止边界：" + boundaryText(ui, report.data_boundary || (meta && meta.data_boundary))
            + "（边界之后提交的发现不在本版本内，不代表全量）"),
          data.refreshed
            ? h("div", { style: NOTICE }, "本次读取生成了携带最新数据截止边界的新版本（读取默认不增殖版本）。")
            : null,
          partition("已确认成果", confirmedObj
            ? "已确认漏洞 " + asArray(confirmed.vulnerabilities).length + " 条（共 " + asNumber(confirmed.vulnerabilities_total, 0) + "）；"
              + "已核实事实 " + asArray(confirmed.facts).length + " 条（共 " + asNumber(confirmed.facts_total, 0) + "）"
            : null),
          partition("未确认线索", leadsObj
            ? "未确认漏洞 " + asNumber(leads.vulnerabilities_total, 0) + " 条；"
              + "待检验假设 " + asNumber(leads.hypotheses_total, 0) + " 条；"
              + "待处理验证任务 " + asNumber(leads.pending_verification_jobs_total, 0) + " 个；"
              + "状态变化事实 " + asArray(leads.changed_facts).length + " 条"
            : null),
          partition("已完成方向", completedObj
            ? "已解决意图 " + asNumber(completed.total, 0) + " 条（resolved 只表示该版本的问题已处理，不代表关联资产已测透）"
            : null),
          partition("受阻方向", blockedObj
            ? "受阻/暂缓意图 " + asNumber(blocked.total, 0) + " 条（保留恢复条件，是否恢复由协调与规划决定）"
            : null),
          partition("未覆盖部分", uncoveredObj
            ? "资产共 " + asNumber(uncovered.total_assets, asNumber(coverage.total_assets, 0)) + " 个；"
              + "无任何测试方向 " + asNumber(uncovered.assets_without_direction, 0) + " 个；"
              + "无任何采集 " + asNumber(uncovered.assets_without_capture, 0) + " 个；"
              + "未覆盖部分是覆盖缺口的事实陈述，不是测完声明"
            : null),
          h("div", { style: SMALL },
            "进行中探索：" + asNumber(exploration.ongoing_total, 0) + " 条意图（报告生成后探索继续；后续方向由规划持续安排）"),
        );
      }

      /* ── 覆盖缺口区（端点 40 的 coverage 块，按资产/方向/身份条件） ── */

      renderCoverageSection() {
        const { h, ui, router } = this.props;
        const data = asObject(this.state.milestone.data);
        const report = data ? asObject(data.report) : null;
        const coverage = report ? asObject(report.coverage) : null;
        const uncovered = report ? asObject(report.uncovered) : null;
        const records = coverage ? asArray(coverage.records) : [];

        const recordsNodes = records.map((raw, idx) => {
          const rec = asObject(raw) || {};
          const asset = asObject(rec.asset) || {};
          const directions = asObject(rec.directions) || {};
          const identity = asObject(rec.identity_conditions) || {};
          const flags = asObject(rec.uncovered_flags) || {};
          const findings = asObject(rec.findings) ? asObject(asObject(rec.findings).vulnerabilities) : null;
          const directionText = DIRECTION_LABELS.map(([kind, label]) => {
            const d = asObject(directions[kind]);
            if (!d) return null;
            return label + " 共 " + asNumber(d.total, 0)
              + "（已解决 " + asNumber(d.resolved, 0)
              + "·受阻 " + asNumber(d.blocked, 0)
              + "·进行中 " + asNumber(d.ongoing, 0)
              + "·取消 " + asNumber(d.cancelled, 0) + "）";
          }).filter(Boolean).join("；") || "—（未提供）";
          return h("tr", { key: "cov-" + idx },
            h("td", { style: TD },
              chipNode(ui, router, asset.id),
              h("div", { style: SMALL },
                [asset.asset_type ? "类型 " + asset.asset_type : null,
                  asset.scope_status ? "范围 " + asset.scope_status : null,
                  asset.canonical_key || null].filter(Boolean).join(" · ") || "—（未提供）")),
            h("td", { style: TD }, directionText),
            h("td", { style: TD },
              "采集 " + asNumber(rec.captures, 0) + " · 观察 " + asNumber(rec.observations, 0)
              + " · 直接意图 " + asNumber(rec.intents_directed, 0),
              findings
                ? h("div", { style: SMALL },
                    "漏洞：疑似 " + asNumber(findings.suspected, 0)
                    + "·已确认 " + asNumber(findings.confirmed, 0)
                    + "·已证伪 " + asNumber(findings.falsified, 0)
                    + "·证据不足 " + asNumber(findings.inconclusive, 0))
                : null),
            h("td", { style: TD },
              asArray(identity.from_intents).length || asArray(identity.observed_in_captures).length
                ? h("div", { style: STACK },
                    h("div", null, "意图声明：" + (asArray(identity.from_intents).join("、") || "无")),
                    h("div", null, "采集中观察到：" + (asArray(identity.observed_in_captures).join("、") || "无")))
                : h("span", { style: SMALL }, "—（未提供）")),
            h("td", { style: TD },
              flags.no_direction || flags.no_capture
                ? h("span", null,
                    flags.no_direction ? "【未覆盖：无任何测试方向】" : null,
                    flags.no_capture ? "【未覆盖：无任何采集】" : null)
                : h("span", { style: SMALL }, "—")));
        });

        const aggregate = uncovered
          ? h("div", { style: MUTED },
              "未覆盖聚合：资产共 " + asNumber(uncovered.total_assets, asNumber(coverage && coverage.total_assets, 0)) + " 个，"
              + "无任何测试方向 " + asNumber(uncovered.assets_without_direction, 0) + " 个，"
              + "无任何采集 " + asNumber(uncovered.assets_without_capture, 0) + " 个。")
          : null;

        return h("section", { key: "coverage-section", style: CARD },
          h("h3", { style: SECTION_TITLE }, "覆盖缺口"),
          h("div", { style: MUTED }, "覆盖度按资产/测试方向/身份或条件记录完成情况；已执行过某个方向不代表该资产没有其他漏洞。"),
          aggregate,
          !this.state.milestone.data
            ? h("div", { style: SMALL }, "阶段报告尚未加载：覆盖度数据 —（未提供）；未提供不代表已覆盖。")
            : !coverage
              ? h("div", { style: SMALL }, "阶段报告未携带覆盖块：覆盖度数据 —（未提供）；未提供不代表已覆盖。")
              : records.length
                ? h("table", { key: "cov-table", style: TABLE },
                    h("thead", null, h("tr", null,
                      ["资产", "方向完成情况", "采集/观察/直接意图", "身份或条件", "未覆盖标记"].map((label) =>
                        h("th", { key: label, scope: "col", style: TH }, label)))),
                    h("tbody", null, ...recordsNodes))
                : h("div", { style: SMALL }, "（无资产覆盖记录：尚无资产或均未进入覆盖统计；未提供不代表已覆盖。）"),
          coverage && coverage.has_more
            ? h("div", { style: NOTICE },
                asText(coverage.folded_note, "资产数超出内联上限，仅呈现前若干条；其余按编号经记录读取（不静默截断）。"))
            : null,
          coverage && typeof coverage.coverage_note === "string" && coverage.coverage_note
            ? ui.FoldableObject([coverage.coverage_note], { level: 1, summary: "覆盖口径说明" })
            : null);
      }

      /* ── 语义说明（全部规范解释收进折叠区；折叠不删记录） ───────── */

      renderSemantics() {
        const { h, ui } = this.props;
        return h("section", { key: "semantics", style: CARD },
          h("h3", { style: SECTION_TITLE }, "语义说明"),
          h("div", { style: SMALL }, "解释性规范段落默认折叠（折叠不删记录，展开可见全部内容）。"),
          ui.FoldableObject(SEMANTICS.slice(), { level: 1, summary: "语义说明" }));
      }

      renderDataMeta() {
        const { h, ui } = this.props;
        const vulns = this.state.vulns;
        const ms = this.state.milestone;
        const parts = [];
        if (vulns.dataAt) parts.push("漏洞报告数据时刻 " + ui.formatTime(vulns.dataAt));
        if (ms.dataAt) parts.push("阶段报告数据时刻 " + ui.formatTime(ms.dataAt));
        return h("div", { key: "meta", style: SMALL },
          (parts.length ? parts.join(" · ") + " · " : "数据时刻 —（未提供） · ")
          + "计数按已加载数据推导 · 不代表全量");
      }
    }

    return h(ReportsPage, { React, h, api, router, ui, theme });
  },

  /* ════════════════════════════════════════════════════════════════
     右侧详情（hash ?id=RR-/MR-/V-）：单份报告版本 + 版本切换 + 导出
     ════════════════════════════════════════════════════════════════ */
  renderDetail({ React, h, api, router, ui }) {
    const ComponentBase = React && typeof React.Component === "function"
      ? React.Component
      : class DetailComponentBase {
          constructor(props) {
            this.props = props || {};
          }
        };

    class ReportDetail extends ComponentBase {
      constructor(props) {
        super(props);
        this.state = {
          phase: "loading",
          kind: "",
          id: "",
          resolved: null,
          envelope: null,
          error: null,
          exportState: { phase: "idle", href: "", error: null, chars: 0 },
        };
        this.seq = 0;
      }

      componentDidMount() {
        this.load();
      }

      async load() {
        const { api, ui, router } = this.props;
        const projectId = router && router.projectId ? router.projectId : "";
        const id = router && router.params ? router.params.id : "";
        if (!projectId || !ui) {
          this.setState({ phase: "error", error: { message: "缺少项目上下文或设计系统渲染器" } });
          return;
        }
        if (!id) {
          this.setState({ phase: "error", error: { message: "缺少报告编号（?id=RR-/MR-）" } });
          return;
        }
        const seq = ++this.seq;
        const cls = classifyReportId(ui, id);
        if (cls.kind === "unknown") {
          this.setState({
            phase: "error",
            id,
            error: { message: "无法识别的报告编号：" + cls.id + "（报告详情支持 RR-/MR-/V- 编号）" },
          });
          return;
        }
        if (cls.kind === "vulnerability") {
          await this.loadVulnerability(id, "", seq);
          return;
        }
        try {
          const located = await api(
            "/sorne/records/" + encodeURIComponent(id) + "?project_id=" + encodeURIComponent(projectId),
          );
          if (seq !== this.seq) return;
          const record = located && asObject(located.record);
          if (!record || record.kind !== "report_revisions") {
            this.setState({
              phase: "error",
              id,
              error: { message: "编号 " + id + " 不是报告版本记录（记录类型：" + (record && record.kind ? record.kind : "未知") + "）" },
            });
            return;
          }
          const reportKind = asText(record.report_kind, "");
          const subjectId = asText(record.subject_id, "");
          const version = asText(record.version, "");
          if (reportKind === "vulnerability") {
            await this.loadVulnerability(subjectId, version, seq);
          } else if (reportKind === "milestone") {
            await this.loadMilestone(version, seq);
          } else {
            this.setState({
              phase: "error",
              id,
              error: { message: "报告类型未识别：" + (reportKind || "—（未提供）") },
            });
          }
        } catch (e) {
          if (seq !== this.seq) return;
          const info = errorInfo(e);
          this.setState({
            phase: info.notImpl ? "notimpl" : info.notFound ? "notfound" : "error",
            id,
            error: e,
          });
        }
      }

      async loadVulnerability(subjectId, version, seq) {
        const { api } = this.props;
        const projectId = this.props.router.projectId;
        let path = "/sorne/reports/vulnerabilities?project_id=" + encodeURIComponent(projectId)
          + "&id=" + encodeURIComponent(subjectId);
        if (version) path += "&version=" + encodeURIComponent(version);
        try {
          const data = await api(path);
          if (seq !== this.seq) return;
          if (!asObject(data) || !asObject(data.report)) {
            this.setState({ phase: "unknown", id: subjectId, kind: "vulnerability", error: null });
            return;
          }
          this.setState({
            phase: "ready",
            kind: "vulnerability",
            id: subjectId,
            resolved: { subjectId, version },
            envelope: data,
            error: null,
          });
        } catch (e) {
          if (seq !== this.seq) return;
          const info = errorInfo(e);
          this.setState({
            phase: info.notImpl ? "notimpl" : info.notFound ? "notfound" : "error",
            kind: "vulnerability",
            id: subjectId,
            error: e,
          });
        }
      }

      async loadMilestone(version, seq) {
        const { api } = this.props;
        const projectId = this.props.router.projectId;
        let path = "/sorne/reports/milestones?project_id=" + encodeURIComponent(projectId);
        if (version) path += "&version=" + encodeURIComponent(version);
        try {
          const data = await api(path);
          if (seq !== this.seq) return;
          if (!asObject(data) || !asObject(data.report)) {
            this.setState({ phase: "unknown", kind: "milestone", id: version, error: null });
            return;
          }
          this.setState({
            phase: "ready",
            kind: "milestone",
            id: version,
            resolved: { version },
            envelope: data,
            error: null,
          });
        } catch (e) {
          if (seq !== this.seq) return;
          const info = errorInfo(e);
          this.setState({
            phase: info.notImpl ? "notimpl" : info.notFound ? "notfound" : "error",
            kind: "milestone",
            id: version,
            error: e,
          });
        }
      }

      openVersion(reportId) {
        const router = this.props.router;
        if (!router || typeof router.open !== "function" || !reportId) return;
        router.open(
          "#/p/" + encodeURIComponent(router.projectId || "") + "/reports?id=" + encodeURIComponent(reportId),
        );
      }

      async exportReport() {
        const { api } = this.props;
        const envelope = asObject(this.state.envelope);
        const meta = envelope ? asObject(envelope.report_meta) : null;
        const projectId = this.props.router.projectId;
        if (!meta || !meta.report_id) {
          this.setState({ exportState: { phase: "error", href: "", error: { message: "报告版本编号未提供，无法导出" }, chars: 0 } });
          return;
        }
        const version = asText(meta.version, asText(envelope.requested_version, ""));
        let href = "/sorne/reports/" + encodeURIComponent(meta.report_id) + "/export?project_id=" + encodeURIComponent(projectId);
        if (version) href += "&version=" + encodeURIComponent(version);
        this.setState({ exportState: { phase: "busy", href, error: null, chars: 0 } });
        try {
          const data = await api(href, { headers: { Accept: "text/markdown" } });
          const text = markdownText(data);
          this.setState({ exportState: { phase: "ok", href, error: null, chars: text.length } });
        } catch (e) {
          this.setState({ exportState: { phase: "error", href, error: e, chars: 0 } });
        }
      }

      render() {
        const { h, ui, router } = this.props;
        const state = this.state;
        if (!ui || typeof ui.formatTime !== "function") {
          return h("div", { style: ALERT }, "渲染器未就绪：报告详情依赖设计系统渲染器。");
        }
        const head = h("div", { key: "detail-head", style: { display: "flex", flexDirection: "column", gap: 4 } },
          h("h3", { style: { margin: 0, fontSize: 15, color: "var(--sorne-text-primary)" } }, "报告详情"),
          h("div", { style: SMALL },
            "报告版本：", state.kind === "vulnerability" ? "漏洞报告" : state.kind === "milestone" ? "阶段报告" : "—（未提供）"));

        if (state.phase === "loading") {
          return h("div", { style: STACK }, head, h("div", { role: "status", style: MUTED }, "正在读取报告版本…"));
        }
        if (state.phase === "notimpl") {
          return h("div", { style: STACK }, head,
            h("div", { role: "status", style: NOTICE },
              h("div", { style: { fontWeight: 600 } }, "该报告读取未实现（不是报错）"),
              h("div", null, errText(errorInfo(state.error)))));
        }
        if (state.phase === "notfound") {
          return h("div", { style: STACK }, head,
            h("div", { role: "alert", style: NOTICE },
              h("div", { style: { fontWeight: 600 } }, "报告版本不存在或不可读"),
              h("div", null, errText(errorInfo(state.error))),
              h("div", { style: SMALL }, "可返回报告列表重新选择；阶段报告新版本经「生成阶段报告」创建。")));
        }
        if (state.phase === "error") {
          return h("div", { style: STACK }, head,
            h("div", { role: "alert", style: ALERT },
              h("div", { style: { fontWeight: 600 } }, "报告详情加载失败"),
              h("div", null, errText(errorInfo(state.error)))));
        }
        if (state.phase === "unknown") {
          return h("div", { style: STACK }, head,
            h("div", { role: "alert", style: NOTICE },
              "报告响应形状无法识别（缺少 report 对象）：不静默当作空，请稍后重试。"));
        }

        const envelope = asObject(state.envelope) || {};
        const meta = asObject(envelope.report_meta) || {};
        const report = asObject(envelope.report) || {};
        const currentVersion = asText(envelope.current_version, "");
        const requestedVersion = asText(envelope.requested_version, "");
        const history = asArray(envelope.history);
        const isHistorical = Boolean(currentVersion && requestedVersion && requestedVersion !== currentVersion);

        const versionButtons = [];
        const currentRow = history.find((row) => row && row.version === currentVersion);
        const currentReportId = currentRow && currentRow.report_id ? currentRow.report_id : (meta.report_id || "");
        versionButtons.push(h("button", {
          key: "current",
          type: "button",
          "aria-label": "切换到当前版本",
          disabled: !isHistorical,
          onClick: () => this.openVersion(currentReportId),
          style: btnStyle("chip", !isHistorical),
        }, "当前版本" + versionLabel(currentVersion)));
        history.slice().reverse().forEach((row) => {
          const version = row && typeof row.version === "string" ? row.version : "";
          if (!version || version === currentVersion) return;
          const active = version === requestedVersion;
          versionButtons.push(h("button", {
            key: "v-" + version,
            type: "button",
            "aria-label": "切换到历史版本 " + version,
            onClick: () => this.openVersion(row.report_id),
            style: btnStyle("chip", active),
          }, "历史版本" + versionLabel(version)));
        });

        const boundary = report.data_boundary || meta.data_boundary;
        const exportState = state.exportState;

        return h("div", { style: STACK },
          head,
          h("div", { style: ROW },
            h("span", { style: { fontSize: 13, fontWeight: 600, color: "var(--sorne-text-secondary)" } }, "版本："),
            ...versionButtons),
          isHistorical
            ? h("div", { style: NOTICE },
                "正在查看历史版本" + versionLabel(requestedVersion)
                + "：历史版本保留供追溯，当前视图以最新版本" + versionLabel(currentVersion) + "为准。")
            : null,
          h("div", { style: { fontWeight: 600, fontSize: 13.5 } },
            "数据截止边界：" + boundaryText(ui, boundary)
            + "（边界之后提交的发现不在本版本内，不代表全量）"),
          h("div", { style: ROW },
            h("span", { style: { fontSize: 13, fontWeight: 600, color: "var(--sorne-text-secondary)" } }, "报告版本编号："),
            meta.report_id ? chipNode(ui, router, meta.report_id) : h("span", { style: SMALL }, "—（未提供）")),
          h("div", { style: SMALL },
            "生成时间 " + ui.formatTime(meta.created_at) + " · 生成者 " + asText(meta.created_by, "—（未提供）")
            + " · 内容文件 " + (meta.content_available === false ? "不可读（行元数据保留）" : "可读")),
          this.renderExport(meta, exportState),
          state.kind === "vulnerability"
            ? this.renderVulnerabilityReport(report)
            : this.renderMilestoneReport(report),
        );
      }

      renderExport(meta, exportState) {
        const { h, ui } = this.props;
        const info = exportState.phase === "error" ? errorInfo(exportState.error) : null;
        return h("div", { key: "export", style: { borderTop: "1px solid var(--sorne-border)", paddingTop: 6, display: "flex", flexDirection: "column", gap: 4 } },
          h("div", { style: { fontSize: 13, fontWeight: 600, color: "var(--sorne-text-primary)" } }, "导出"),
          h("div", { style: ROW },
            h("button", {
              type: "button",
              "aria-label": "导出本版本为 Markdown（先检查可导出性）",
              disabled: exportState.phase === "busy",
              onClick: () => this.exportReport(),
              style: btnStyle(null, exportState.phase === "busy"),
            }, exportState.phase === "busy" ? "正在检查导出…" : "导出本版本（Markdown）")),
          exportState.phase === "ok"
            ? h("div", { style: { display: "flex", flexDirection: "column", gap: 2 } },
                h("a", {
                  href: exportState.href,
                  download: (meta && meta.report_id ? meta.report_id : "report") + ".md",
                  style: { fontSize: 13, color: "var(--sorne-brand)" },
                }, "下载 Markdown 文件"),
                h("div", { style: SMALL },
                  "导出内容与当前视图同源（服务端按同一报告版本确定性渲染，共 " + exportState.chars + " 字符）。"))
            : null,
          info
            ? h("div", { role: "alert", style: ALERT },
                h("div", { style: { fontWeight: 600 } }, "导出失败：" + errText(info)),
                info.note ? h("div", null, info.note) : null,
                h("div", { style: SMALL },
                  "内容文件不可读时，可先生成携带最新截止边界的新版本（阶段报告「生成阶段报告」）后再导出；不虚报导出成功。"))
            : null);
      }

      renderEvidenceGroup(label, members, counts, kind) {
        const { h, ui, router } = this.props;
        const list = asArray(members);
        const c = asObject(counts);
        const total = c ? asNumber(kind === "supporting" ? c.supporting : c.opposing, list.length) : list.length;
        return h("div", { key: label, style: STACK },
          h("div", { style: { fontSize: 13, fontWeight: 600, color: "var(--sorne-text-primary)" } },
            label + "（" + total + " 条）"),
          list.length
            ? h("div", { style: STACK },
                list.map((raw, idx) => {
                  const m = asObject(raw) || {};
                  return h("div", { key: "m-" + idx, style: { fontSize: 13, lineHeight: 1.6 } },
                    chipNode(ui, router, m.member_id),
                    " " + memberKindLabel(m.member_kind)
                    + " · 立场 " + stanceLabel(m.stance)
                    + " · 成员状态 " + membershipLabel(m.membership_status),
                    m.statement ? h("div", { style: SMALL }, m.statement) : null);
                }))
            : h("div", { style: SMALL }, "—（未提供）"),
          c && typeof c.folded === "string" && c.folded
            ? h("div", { style: SMALL }, c.folded)
            : null);
      }

      renderVulnerabilityReport(report) {
        const { h, ui, router } = this.props;
        const subject = asObject(report.subject) || {};
        const asset = asObject(subject.asset);
        const verification = asObject(report.verification_conclusions) || {};
        const results = asArray(verification.results);
        const pendingJobs = asArray(verification.pending_jobs);
        const limitations = asArray(report.limitations);
        const trace = asObject(report.trace);

        return h("div", { key: "vuln-report", style: STACK },
          h("div", { style: ROW },
            h("span", { style: { fontSize: 13, fontWeight: 600, color: "var(--sorne-text-secondary)" } }, "漏洞编号："),
            chipNode(ui, router, subject.id)),
          h("div", { style: ROW },
            h("span", { style: { fontSize: 13, fontWeight: 600, color: "var(--sorne-text-secondary)" } }, "资产："),
            chipNode(ui, router, asset && asset.id),
            h("span", { style: SMALL }, asset && asset.missing ? "（资产记录缺失）" : "")),
          h("div", { style: ROW },
            ui.StatusBadge("vulnerability_status", subject.status),
            ui.StatusBadge("review_status", subject.review)),
          ui.FieldRow("claim_revision", subject.claim_revision),
          ui.FieldRow("evidence_revision", subject.evidence_revision),
          h("div", { style: { fontSize: 13, lineHeight: 1.6 } },
            "判断条件：" + (asArray(subject.conditions).length
              ? asArray(subject.conditions).join("；")
              : "—（未提供）：结论不可推广到未声明的条件")),
          subject.impact ? h("div", { style: { fontSize: 13, lineHeight: 1.6 } }, "影响：" + subject.impact) : null,
          subject.location || subject.category
            ? h("div", { style: SMALL },
                [subject.category ? "类别 " + subject.category : null,
                  subject.location ? "位置 " + subject.location : null].filter(Boolean).join(" · "))
            : null,
          this.renderEvidenceGroup("支持证据", report.supporting_evidence, report.evidence_counts, "supporting"),
          this.renderEvidenceGroup("反对证据", report.opposing_evidence, report.evidence_counts, "opposing"),
          asArray(report.other_evidence_members).length || asArray(report.historical_evidence_members).length
            ? ui.FoldableObject({
                other_evidence_members: asArray(report.other_evidence_members),
                historical_evidence_members: asArray(report.historical_evidence_members),
              }, { level: 1, summary: "其它/历史证据成员" })
            : null,
          h("div", { key: "verification", style: STACK },
            h("div", { style: { fontSize: 13, fontWeight: 600, color: "var(--sorne-text-primary)" } }, "验证结论"),
            results.length
              ? h("div", { style: STACK },
                  results.map((raw, idx) => {
                    const r = asObject(raw) || {};
                    return h("div", { key: "vr-" + idx, style: { borderTop: "1px solid var(--sorne-border)", paddingTop: 4, display: "flex", flexDirection: "column", gap: 2 } },
                      h("div", { style: ROW },
                        chipNode(ui, router, r.id),
                        chipNode(ui, router, r.job_id),
                        ui.StatusBadge("outcome", r.outcome),
                        h("span", { style: SMALL }, r.applied ? "已应用" : "未应用（保留意见，不覆盖新结论）")),
                      h("div", { style: SMALL },
                        "验证者 " + asText(r.verifier_identity, "—（未提供）")
                        + " · 类别 " + asText(r.verifier_kind, "—（未提供）")
                        + " · 策略版本 " + asText(r.policy_version, "—（未提供）")),
                      r.reviewed_manifest_id
                        ? h("div", { style: ROW },
                            h("span", { style: SMALL }, "已复核证据清单："),
                            chipNode(ui, router, r.reviewed_manifest_id))
                        : null,
                      ui.FieldRow("reviewed_evidence_revision", r.reviewed_evidence_revision),
                      r.limitations ? h("div", { style: SMALL }, "本次限制：" + r.limitations) : null);
                  }))
              : h("div", { style: SMALL }, "—（未提供）：尚无验证结论记录，未确认判断不构成确认")),
          pendingJobs.length
            ? h("div", { style: STACK },
                h("div", { style: { fontSize: 13, fontWeight: 600, color: "var(--sorne-text-primary)" } }, "待处理验证任务"),
                pendingJobs.map((raw, idx) => {
                  const job = asObject(raw) || {};
                  return h("div", { key: "job-" + idx, style: ROW },
                    chipNode(ui, router, job.id),
                    ui.StatusBadge("job_status", job.status),
                    h("span", { style: SMALL }, "策略 " + asText(job.policy_id, "—（未提供）") + "@" + asText(job.policy_version, "—（未提供）")));
                }))
            : null,
          h("div", { key: "limitations", style: STACK },
            h("div", { style: { fontSize: 13, fontWeight: 600, color: "var(--sorne-text-primary)" } }, "限制"),
            limitations.length
              ? h("div", { style: STACK }, limitations.map((text, idx) =>
                  h("div", { key: "lim-" + idx, style: { fontSize: 13, lineHeight: 1.6 } }, "· " + String(text))))
              : h("div", { style: SMALL }, "—（未提供）")),
          h("div", { key: "intents", style: STACK },
            h("div", { style: ROW },
              h("span", { style: { fontSize: 13, fontWeight: 600, color: "var(--sorne-text-secondary)" } }, "来源意图："),
              asArray(report.source_intents).length
                ? asArray(report.source_intents).map((raw, idx) => {
                    const it = asObject(raw) || {};
                    return h("span", { key: "src-" + idx }, chipNode(ui, router, it.intent_id));
                  })
                : h("span", { style: SMALL }, "—（未提供）")),
            h("div", { style: ROW },
              h("span", { style: { fontSize: 13, fontWeight: 600, color: "var(--sorne-text-secondary)" } }, "后续意图："),
              asArray(report.follow_up_intents).length
                ? asArray(report.follow_up_intents).map((raw, idx) => {
                    const it = asObject(raw) || {};
                    return h("span", { key: "fu-" + idx }, chipNode(ui, router, it.intent_id));
                  })
                : h("span", { style: SMALL }, "—（未提供）"))),
          trace
            ? h("div", { key: "trace", style: STACK },
                h("div", { style: { fontSize: 13, fontWeight: 600, color: "var(--sorne-text-primary)" } }, "四向追溯"),
                h("div", { style: SMALL }, "来源/执行/证据/后续方向；折叠不删记录，展开可见原始结构与计数。"),
                ui.FoldableObject(trace, { level: 1, summary: "四向追溯原始结构" }))
            : null,
          h("div", { style: SMALL },
            "报告内容文件：" + asText(report.report_kind, "—（未提供）") + " · 模式版本 " + asNumber(report.schema_version, "—（未提供）")));
      }

      renderMilestoneReport(report) {
        const { h, ui, router } = this.props;
        const project = asObject(report.project) || {};
        const confirmed = asObject(report.confirmed_findings) || {};
        const leads = asObject(report.unconfirmed_leads) || {};
        const completed = asObject(report.completed_directions) || {};
        const blocked = asObject(report.blocked_directions) || {};
        const uncovered = asObject(report.uncovered) || {};
        const coverage = asObject(report.coverage) || {};
        const exploration = asObject(report.exploration_continues) || {};

        const listItems = (items, render) => {
          const list = asArray(items);
          if (!list.length) return h("div", { style: SMALL }, "—（未提供）");
          return h("div", { style: STACK }, list.map((raw, idx) => h("div", { key: "it-" + idx, style: { fontSize: 13, lineHeight: 1.6 } }, render(asObject(raw) || {}, idx))));
        };

        return h("div", { key: "ms-report", style: STACK },
          h("div", { style: ROW },
            h("span", { style: { fontSize: 13, fontWeight: 600, color: "var(--sorne-text-secondary)" } }, "项目："),
            chipNode(ui, router, project.id),
            h("span", { style: SMALL }, asText(project.name, "—（未提供）"))),
          ui.FieldRow("status", project.status),
          h("div", { key: "p1", style: STACK },
            h("div", { style: { fontSize: 13, fontWeight: 600 } }, "已确认成果（" + asNumber(confirmed.vulnerabilities_total, 0) + " 条漏洞 / " + asNumber(confirmed.facts_total, 0) + " 条事实）"),
            listItems(confirmed.vulnerabilities, (v) => h("span", null,
              chipNode(ui, router, v.id), " " + asText(v.category, "—（未提供）") + " · 资产 ",
              chipNode(ui, router, v.asset_id),
              v.review ? " · 复核 " + v.review : "")),
            listItems(confirmed.facts, (f) => h("span", null,
              chipNode(ui, router, f.id), " " + asText(f.statement, "—（未提供）")))),
          h("div", { key: "p2", style: STACK },
            h("div", { style: { fontSize: 13, fontWeight: 600 } }, "未确认线索（" + asNumber(leads.vulnerabilities_total, 0) + " 条漏洞 / " + asNumber(leads.hypotheses_total, 0) + " 条假设 / " + asNumber(leads.pending_verification_jobs_total, 0) + " 个待验证）"),
            listItems(leads.vulnerabilities, (v) => h("span", null,
              chipNode(ui, router, v.id), " " + asText(v.category, "—（未提供）"),
              v.status ? h("span", null, " ", ui.StatusBadge("vulnerability_status", v.status)) : null)),
            listItems(leads.hypotheses, (x) => h("span", null,
              chipNode(ui, router, x.id), " " + asText(x.statement, "—（未提供）"),
              x.status ? h("span", null, " ", ui.StatusBadge("job_status", x.status)) : null)),
            listItems(leads.pending_verification_jobs, (j) => h("span", null,
              chipNode(ui, router, j.id), " 主体 ", chipNode(ui, router, j.subject_id), " ",
              j.status ? ui.StatusBadge("job_status", j.status) : null)),
            asArray(leads.changed_facts).length
              ? h("div", { style: SMALL }, "状态变化事实：" + asArray(leads.changed_facts).map((f) => (f && f.id) || "").filter(Boolean).join("、"))
              : null),
          h("div", { key: "p3", style: STACK },
            h("div", { style: { fontSize: 13, fontWeight: 600 } }, "已完成方向（" + asNumber(completed.total, 0) + " 条）"),
            h("div", { style: SMALL }, "resolved 只表示该版本的问题已处理，不代表关联资产已测透；已解决方向不代表该资产测透。"),
            listItems(completed.intents, (it) => h("span", null,
              chipNode(ui, router, it.id), " " + asText(it.question, "—（未提供）"),
              it.kind ? h("span", { style: SMALL }, " · " + it.kind) : null))),
          h("div", { key: "p4", style: STACK },
            h("div", { style: { fontSize: 13, fontWeight: 600 } }, "受阻方向（" + asNumber(blocked.total, 0) + " 条）"),
            listItems(blocked.intents, (it) => h("span", null,
              chipNode(ui, router, it.id), " " + asText(it.question, "—（未提供）"),
              asArray(it.resume_conditions).length
                ? h("span", { style: SMALL }, " · 恢复条件：" + asArray(it.resume_conditions).join("；"))
                : null))),
          h("div", { key: "p5", style: STACK },
            h("div", { style: { fontSize: 13, fontWeight: 600 } }, "未覆盖部分"),
            asObject(report.uncovered)
              ? h("div", { style: { fontSize: 13, lineHeight: 1.6 } },
                  "资产共 " + asNumber(uncovered.total_assets, asNumber(coverage.total_assets, 0)) + " 个；"
                  + "无任何测试方向 " + asNumber(uncovered.assets_without_direction, 0) + " 个；"
                  + "无任何采集 " + asNumber(uncovered.assets_without_capture, 0) + " 个。"
                  + "未覆盖部分是覆盖缺口的事实陈述，不是测完声明。")
              : h("div", { style: SMALL }, "—（未提供）")),
          h("div", { key: "explore", style: STACK },
            h("div", { style: { fontSize: 13, fontWeight: 600 } }, "报告生成后探索继续"),
            h("div", { style: { fontSize: 13, lineHeight: 1.6 } },
              "进行中探索 " + asNumber(exploration.ongoing_total, 0) + " 条意图；报告不是终点，后续方向由规划持续安排。")));
      }
    }

    return h(ReportDetail, { React, h, api, router, ui });
  },
};

/* ── 语义说明（全部规范解释的单一存放处；正文只保留任务导向与数据口径） ──
   本数组之外的页面文案不含章节引用；折叠区默认收起、展开不删记录。 */
const SEMANTICS = Object.freeze([
  "漏洞报告自疑似（suspected）阶段即形成草稿并持续更新；确认后生成对应确认版本；被排除或争议时同步更新当前视图，历史版本保留且可按版本读回（规范 §19）。",
  "阶段报告注明数据截止版本与时间：边界之后提交的发现不在该版本内，由后续版本承载；报告是持续探索的产物和引用入口，生成漏洞报告、阶段报告或成果汇总均不结束项目（规范 §19/§1）。",
  "覆盖度不能简化成「资产挂过一个 Fact 就已测」：应记录资产/功能/测试方向/身份或条件的完成情况；已经执行过某个方向不代表该资产没有其他漏洞（规范 §19）。",
  "任何漏洞或事实都能追溯来源、执行、证据和后续方向（规范 §21 阶段 F）；本页只读，不提供修改报告或漏洞状态的入口，状态变更经验证服务与受控流程（规范 §8.4）。",
  "报告与记录状态一致且有版本边界：每个版本的数据截止边界随版本展示，切换历史版本时边界同步切换，旧版本不冒充当前视图（规范 §15.1）。",
  "计数按已加载数据推导，不代表全量；未提供 ≠ 不存在：缺失字段以「—（未提供）」呈现，不臆造、不夸大状态（规范 §15.4）。",
  "折叠不删记录：语义说明与证据/追溯明细默认折叠，展开可见全部条目与计数；501 未实现呈现为「未实现」态，不是报错。",
]);
