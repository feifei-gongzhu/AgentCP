export const $ = id => document.getElementById(id);

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export function cell(text, className = "") {
  return el("td", className, text ?? "—");
}

export function emptyRow(body, columns, text = "暂无记录") {
  body.replaceChildren();
  const row = document.createElement("tr");
  const td = cell(text, "empty-row");
  td.colSpan = columns;
  row.append(td);
  body.append(row);
}

export function renderRows(body, items, columns, mapper) {
  if (!items.length) return emptyRow(body, columns);
  body.replaceChildren();
  [...items].reverse().slice(0, 60).forEach(item => body.append(mapper(item)));
}

export function preserveScroll(node, fn) {
  if (!node) {
    fn();
    return;
  }
  const top = node.scrollTop;
  const left = node.scrollLeft;
  fn();
  node.scrollTop = top;
  node.scrollLeft = left;
}

export function showToast(message, isError = false) {
  const toast = $("toast");
  toast.textContent = message;
  toast.className = `toast show${isError ? " error" : ""}`;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.className = "toast"; }, 4200);
}

export function setBadge(element, value) {
  const normalized = String(value || "idle").toLowerCase();
  element.textContent = normalized;
  const blocked = ["awaiting_approval", "paused", "failed", "cancelled", "stopping", "stopped"].includes(normalized);
  element.className = `status-badge ${blocked ? "blocked" : normalized === "completed" ? "completed" : normalized === "running" ? "running" : "neutral"}`;
}

export function setConnectionStatus(text, online = false) {
  $("connectionText").textContent = text;
  $("connectionText").parentElement.classList.toggle("online", online);
}
