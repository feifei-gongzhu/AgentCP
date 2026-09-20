import { truncateText } from "./format.js";

export async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const raw = await response.text();
  let payload;
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch (_error) {
    throw new Error(`HTTP ${response.status}：服务返回了非 JSON 响应${raw ? ` · ${truncateText(raw, 180)}` : ""}`);
  }
  if (!response.ok || !payload.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}
