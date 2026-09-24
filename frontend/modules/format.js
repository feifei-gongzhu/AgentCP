export function truncateText(value, limit = 260) {
  const text = String(value || "").trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

export function percent(value) {
  return value == null ? "—" : `${Math.round(Number(value) * 100)}%`;
}

export function formatEventTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

export function formatDuration(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const whole = Math.floor(seconds);
  if (whole < 60) return `${whole} 秒`;
  const minutes = Math.floor(whole / 60);
  if (minutes < 60) return `${minutes} 分 ${whole % 60} 秒`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分`;
}

export function ageLabel(value) {
  if (!value) return "时间未知";
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return "时间未知";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "刚刚";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

export function formatEventShort(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const month = String(d.getMonth() + 1);
  const day = String(d.getDate());
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${month}/${day} ${hh}:${mm}`;
}
