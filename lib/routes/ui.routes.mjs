/**
 * UI 静态路由（骨架冻结基础设施，不属于任何施工模块）。
 *
 * 页面加载契约（BLUEPRINT §2.6）：
 *   - GET /sorne/ui/manifest → { pages: [{id, title, order, file}] }
 *     扫描 lib/ui/pages/*.page.mjs 并执行模块取其 default 元数据；
 *   - GET /sorne/ui/pages/{file} → 以 text/javascript 提供页面模块源。
 * client.js 外壳按 manifest 动态 import(file)，页面模块在浏览器中以
 * ES module 加载，React 通过渲染上下文注入，页面自身不 import 任何包。
 */
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { apiError } from "../errors.mjs";
import { sendText } from "../http.mjs";

const PAGES_DIR = fileURLToPath(new URL("../ui/pages", import.meta.url));
const PAGE_FILE_RE = /^[A-Za-z0-9._-]+\.page\.mjs$/;

const moduleCache = new Map();

async function loadPages() {
  const files = (await readdir(PAGES_DIR)).filter((f) => f.endsWith(".page.mjs")).sort();
  const pages = [];
  for (const file of files) {
    if (!moduleCache.has(file)) {
      moduleCache.set(file, await import(pathToFileURL(join(PAGES_DIR, file)).href));
    }
    const def = moduleCache.get(file).default;
    if (!def || !def.id || typeof def.render !== "function") {
      throw apiError("INTERNAL_ERROR", `页面模块形状非法：${file}`);
    }
    pages.push({
      id: def.id,
      title: def.title || def.id,
      order: typeof def.order === "number" ? def.order : 100,
      file: `/sorne/ui/pages/${file}`,
    });
  }
  pages.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  return pages;
}

export const routes = [
  {
    method: "GET",
    path: "/sorne/ui/manifest",
    async handler() {
      return { pages: await loadPages() };
    },
  },
  {
    method: "GET",
    path: "/sorne/ui/pages/:file",
    async handler(pctx, req, res, { params }) {
      const file = basename(params.file);
      if (!PAGE_FILE_RE.test(file)) {
        throw apiError("NOT_FOUND", `非法页面文件名：${file}`);
      }
      const full = join(PAGES_DIR, file);
      if (!existsSync(full)) {
        throw apiError("NOT_FOUND", `页面不存在：${file}`);
      }
      sendText(res, 200, await readFile(full, "utf8"), "text/javascript; charset=utf-8");
      return undefined;
    },
  },
];
