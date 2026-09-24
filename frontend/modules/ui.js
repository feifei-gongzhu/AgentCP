// 共享 UI 原语：图标、徽章、条目行、详情区块。状态一律双色编码（点色+文字）。
import { el } from "./dom.js";

export const ICONS = {
  projects: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/></svg>',
  overview: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2" y="2" width="12" height="12" rx="2"/><path d="M5 8.5l2 2 4-4.5"/></svg>',
  findings: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M8 1.5l5.5 2v4c0 3.2-2.2 5.6-5.5 7-3.3-1.4-5.5-3.8-5.5-7v-4z"/><path d="M8 5v3M8 10.2v.3"/></svg>',
  directions: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="6"/><path d="M10.5 5.5l-1.6 3.6-3.4 1.4 1.6-3.6z"/></svg>',
  assets: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2" y="3" width="12" height="4" rx="1"/><rect x="2" y="9" width="12" height="4" rx="1"/><path d="M4.5 5h.01M4.5 11h.01"/></svg>',
  runs: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2 8.5h3l1.5-4 2.5 8L11 8.5h3"/></svg>',
  settings: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2.5 6.5a5.8 5.8 0 0 1 .9-2l-1-1.7 1.7-1 1 1.7a5.8 5.8 0 0 1 2-.9L7.6.8h1.9l.5 1.8a5.8 5.8 0 0 1 2 .9l1.7-1 1 1.7-1.7 1a5.8 5.8 0 0 1 .9 2l1.8.5v1.9l-1.8.5a5.8 5.8 0 0 1-.9 2l1.7 1-1 1.7-1.7-1a5.8 5.8 0 0 1-2 .9l-.5 1.8H7.6l-.5-1.8a5.8 5.8 0 0 1-2-.9l-1.7 1-1-1.7 1-1.7a5.8 5.8 0 0 1-.9-2L.7 10V8.1z" transform="translate(1.5 -.3) scale(.85)"/><circle cx="8" cy="8.5" r="2"/></svg>',
};

const STATUS_TONE = {
  running: "ok", completed: "ok", profiled: "ok", succeeded: "ok", committed: "ok",
  awaiting_approval: "warn", paused: "warn", queued: "info", released: "info",
  open: "info", claimed: "info", pending: "info", projecting: "info", partial: "warn",
  failed: "danger", cancelled: "danger", stopped: "danger", stopping: "danger",
  blocked: "danger", rejected: "danger", exhausted: "muted", restricting: "warn",
  restricted: "warn", cancelled_by_user: "danger", idle: "muted", none: "muted",
};
export function toneForStatus(status) {
  return STATUS_TONE[String(status || "").toLowerCase()] || "muted";
}
export function badge(text, tone) {
  const node = el("span", `badge tone-${tone || toneForStatus(text)}`);
  node.append(el("i", "badge-dot"), el("span", "badge-text", String(text || "—")));
  return node;
}
const SEVERITY_LABEL = { critical: "严重", high: "高危", medium: "中危", low: "低危", info: "信息", unknown: "未定级" };
export function severityChip(severity) {
  const key = String(severity || "unknown").toLowerCase();
  const node = el("span", `sev sev-${key}`);
  node.append(el("i", "sev-dot"), el("span", "", SEVERITY_LABEL[key] || key));
  return node;
}
export function chip(text, tone = "") {
  return el("span", `chip${tone ? ` tone-${tone}` : ""}`, text);
}
export function itemRow({ title, chips = [], meta = [], pending = false, selected = false, onClick }) {
  const row = el("button", `item-row${selected ? " selected" : ""}${pending ? " pending" : ""}`);
  row.type = "button";
  if (pending) row.append(el("span", "pending-dot"));
  const head = el("div", "item-title", title);
  row.append(head);
  if (chips.length) {
    const chipRow = el("div", "item-chips");
    chips.forEach(node => chipRow.append(node));
    row.append(chipRow);
  }
  if (meta.length) {
    const metaRow = el("div", "item-meta");
    meta.forEach(text => metaRow.append(el("span", "", text)));
    row.append(metaRow);
  }
  if (onClick) row.addEventListener("click", onClick);
  return row;
}
export function detailSection(label, ...nodes) {
  const section = el("div", "detail-section");
  section.append(el("span", "detail-label", label));
  nodes.forEach(node => section.append(node));
  return section;
}
export function statCard(label, value, note = "", tone = "") {
  const card = el("div", `stat-card${tone ? ` tone-${tone}` : ""}`);
  card.append(el("span", "stat-label", label));
  card.append(el("strong", "stat-value", value));
  if (note) card.append(el("small", "stat-note", note));
  return card;
}
