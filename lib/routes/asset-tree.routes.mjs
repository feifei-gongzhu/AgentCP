/**
 * 资产目录树（按站点组织）：GET /sorne/projects/:id/asset-tree
 *
 * 用户视角的「收集资料目录」：每个站点一个目录，下分技术栈 / JS / 页面 / 接口 / 文件。
 * 数据来自持久表（assets/resources/endpoint_templates/captures），不读取投影猜测；
 * 同一 URL 去重后按类型归类，保留原始 URL 与可点击的记录编号。
 */
import { apiError } from "../errors.mjs";
import { getStore } from "../store/record-service.mjs";
import { buildTechStack } from "../store/tech-stack.mjs";

function hostOf(url) {
  try {
    const u = new URL(String(url));
    return u.host;
  } catch {
    return null;
  }
}

function pathOf(url) {
  try {
    return new URL(String(url)).pathname || "/";
  } catch {
    return String(url || "");
  }
}

function classify(url) {
  const p = pathOf(url).toLowerCase();
  if (/\.js(?:$|\?)/.test(p)) return "js";
  if (/\.css(?:$|\?)/.test(p) || /\.(ico|png|jpg|jpeg|gif|svg|woff2?|ttf|eot)(?:$|\?)/.test(p)) return "files";
  if (/(?:\/api\/|gateway|login_code|ispirit|interface|upload|action=)/.test(p)) return "interfaces";
  if (p === "/" || p.endsWith("/") || /\.(php|html?|jsp|asp)(?:$|\?)/.test(p)) return "pages";
  return "files";
}

function fileNode(ref, id, url, extra = {}) {
  return { id, ref, name: pathOf(url) || url, url, kind: extra.kind || "url", ...extra };
}

export const routes = [
  {
    method: "GET",
    path: "/sorne/projects/:id/asset-tree",
    async handler(pctx, req, res, { params }) {
      const pid = params.id;
      const store = await getStore(pctx);
      const project = store.db.prepare("SELECT * FROM projects WHERE id = ?").get(pid);
      if (!project) throw apiError("NOT_FOUND", `项目不存在：${pid}`);

      const assets = store.db.prepare("SELECT * FROM assets WHERE project_id = ? ORDER BY created_seq").all(pid);
      const resources = store.db.prepare("SELECT * FROM resources WHERE project_id = ? ORDER BY created_seq").all(pid);
      const templates = store.db.prepare("SELECT * FROM endpoint_templates WHERE project_id = ? ORDER BY created_seq").all(pid);
      const captures = store.db.prepare(
        "SELECT id, attempt_id, request_url_exact FROM captures WHERE project_id = ? ORDER BY created_seq DESC LIMIT 1000",
      ).all(pid);

      const sites = new Map();
      const ensureSite = (host) => {
        const h = host || "(未知站点)";
        if (!sites.has(h)) sites.set(h, { host: h, js: [], pages: [], interfaces: [], files: [], urls: new Set() });
        return sites.get(h);
      };
      const addUrl = (site, url, ref) => {
        const u = String(url || "");
        if (!u) return;
        if (site.urls.has(u)) return;
        site.urls.add(u);
        const cls = classify(u);
        site[cls].push(fileNode(ref, ref, u, { kind: cls }));
      };

      for (const r of resources) {
        const host = r.host || hostOf(r.url_exact);
        if (!host) continue;
        const site = ensureSite(host);
        addUrl(site, r.url_exact, r.id);
      }
      for (const c of captures) {
        const host = hostOf(c.request_url_exact);
        if (!host) continue;
        const site = ensureSite(host);
        addUrl(site, c.request_url_exact, c.id);
      }
      for (const a of assets) {
        if (a.asset_type !== "product" && a.asset_type !== "technology") continue;
        const host = hostOf(a.canonical_key) || hostOf(a.original_input);
        if (!host) continue;
        // 技术栈不再按站点平铺；跨站点分层画像由 tech_stack 统一返回（§7.1）。
        ensureSite(host);
      }
      const defaultSite = Array.from(sites.values())[0];
      for (const t of templates) {
        const svc = assets.find((a) => a.id === t.service_asset_id);
        const host = svc ? (hostOf(svc.canonical_key) || hostOf(svc.original_input)) : null;
        const site = (host && sites.get(host)) || defaultSite;
        if (!site) continue;
        site.interfaces.push({
          id: t.id, ref: t.id, name: (t.method || "GET") + " " + (t.path_template || "—"),
          kind: "interface", detail: t.status || "",
        });
      }
      for (const site of sites.values()) delete site.urls;

      const list = Array.from(sites.values()).map((s) => ({
        ...s,
        counts: {
          js: s.js.length, pages: s.pages.length,
          interfaces: s.interfaces.length, files: s.files.length,
        },
      }));
      list.sort((a, b) => b.counts.pages + b.counts.interfaces + b.counts.js - (a.counts.pages + a.counts.interfaces + a.counts.js));
      return {
        project_id: pid,
        generated_at: new Date().toISOString(),
        asset_map_md: {
          name: "asset_map.md",
          summary: `站点 ${list.length} · 资产 ${assets.length} · 接口 ${templates.length} · 采集 ${captures.length}`,
        },
        tech_stack: buildTechStack(assets),
        counts: {
          sites: list.length,
          assets: assets.length,
          interfaces: templates.length,
          resources: resources.length,
          captures: captures.length,
        },
        sites: list,
      };
    },
  },
];
