export function normalizeNewlines(value: unknown): string {
  return String(value || "").replace(/\r\n/g, "\n");
}

export function extractText(value: unknown): string {
  if (value == null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => extractText(item)).filter(Boolean).join("");
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") {
      return record.text;
    }
    if (typeof record.content === "string") {
      return record.content;
    }
    if (Array.isArray(record.content)) {
      return extractText(record.content);
    }
    if (typeof record.response === "string") {
      return record.response;
    }
    if (typeof record.result === "string") {
      return record.result;
    }
  }
  return "";
}

export function jsonString(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
