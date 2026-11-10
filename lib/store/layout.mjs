/**
 * A2 —— 文件布局服务（规范 §5.2 目录布局的程序义务）。
 *
 * 落地解释（多项目单库）：数据库为共享单库（<dataDir>/state/sorne.sqlite，与
 * 骨架冒烟测试一致），每个项目在 <dataDir>/projects/<目录名>/ 下拥有 §5.2 的
 * 文件树；§5.2 的 state/（数据库等服务状态）由数据根承担。规范明确「目录命名
 * 为建议选型，核心行为不得依赖某个文件名」，本文件是目录程序义务的唯一实现，
 * 其他模块（A1 记录服务 / C2 执行运行时 / B1 投影）应复用此处导出的路径函数。
 *
 * 程序义务（§5.2）：
 *   - assets/ 人可浏览逻辑目录由程序生成：文件名映射处理非法字符与路径穿越；
 *   - 不同 URL 映射冲突时使用资源编号消歧；
 *   - 最新版本入口必须同时标明采集编号（sidecar <文件名>.capture.json）；
 *   - 逻辑路径不承担历史证据身份（sidecar 保留 url_exact 全量信息）；
 *   - work/<intent>/<attempt>/ 执行工作区；
 *   - 目录仅用于资料组织和浏览，不是真值来源。
 */
import { createHash } from "node:crypto";
import { access, constants, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, relative, dirname, basename } from "node:path";

/** 段内非法字符（含分隔符与 Windows 保留字符）；路径穿越靠逐段清洗 + 拒绝段级 ".." 。 */
const SEGMENT_ILLEGAL = /[\x00-\x1f\x7f\u2028\u2029\/\\:*?"<>|]/g;
const ASSET_SIDECAR_SUFFIX = ".capture.json";
const MAX_VERSION_HISTORY = 200;

function hash8(text) {
  return createHash("sha256").update(String(text), "utf8").digest("hex").slice(0, 8);
}

/**
 * 任意字符串 → 安全的单个路径段：
 * 替换非法字符、去掉首尾点与空白、折叠下划线、拒绝 "."/".."、超长截断并追加
 * 内容哈希保持唯一。返回值永不含路径分隔符，也永不为 "." 或 ".."。
 */
export function safeSegment(raw, { max = 96 } = {}) {
  const text = String(raw ?? "");
  let seg = text.replace(SEGMENT_ILLEGAL, "_").trim().replace(/^[.\s]+|[.\s]+$/g, "");
  seg = seg.replace(/_{2,}/g, "_");
  if (!seg || seg === "." || seg === "..") seg = "_";
  if (seg.length > max) seg = `${seg.slice(0, max)}-${hash8(text)}`;
  return seg;
}

/** 项目目录名：程序分配的项目编号通常已安全；不安全时清洗 + 哈希防碰撞。 */
export function projectDirName(projectId) {
  const raw = String(projectId ?? "");
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(raw) && raw !== "." && raw !== ".." && !raw.includes("..")) {
    return raw;
  }
  return `${safeSegment(raw)}-${hash8(raw)}`;
}

/** 数据根布局：共享数据库文件（单库多项目）。 */
export function stateDbPath(dataDir) {
  return join(dataDir, "state", "sorne.sqlite");
}

/** 项目根目录：<dataDir>/projects/<目录名>/。 */
export function projectDir(dataDir, projectId) {
  return join(dataDir, "projects", projectDirName(projectId));
}

/** 证据目录（§5.2）：evidence/blobs/sha256/<ab>/<完整哈希> 与 evidence/staging/。 */
export function evidenceDirs(dataDir, projectId) {
  const root = join(projectDir(dataDir, projectId), "evidence");
  return { root, blobsRoot: join(root, "blobs", "sha256"), staging: join(root, "staging") };
}

/** 固定 Blob 的绝对路径（内容寻址：前两位十六进制作分桶目录）。 */
export function blobPath(dataDir, projectId, sha256) {
  return join(evidenceDirs(dataDir, projectId).blobsRoot, String(sha256).slice(0, 2), String(sha256));
}

/** work/<intent>/<attempt>/ 执行工作区（执行脚本、中间工作文件；§5.2）。 */
export async function ensureWorkspace(dataDir, projectId, intentId, attemptId) {
  const dir = join(
    projectDir(dataDir, projectId),
    "work",
    safeSegment(intentId),
    safeSegment(attemptId),
  );
  await mkdir(dir, { recursive: true });
  return dir;
}

/** 确保 §5.2 项目树全部目录存在（幂等）。 */
export async function ensureProjectTree(dataDir, projectId) {
  const base = projectDir(dataDir, projectId);
  const { blobsRoot, staging } = evidenceDirs(dataDir, projectId);
  for (const dir of [join(base, "assets"), join(base, "maps"), join(base, "reports"), join(base, "work"), blobsRoot, staging]) {
    await mkdir(dir, { recursive: true });
  }
  return base;
}

/** 相对数据根的路径（存入 blobs.stored_path，便于数据根整体搬迁）。 */
export function relToDataDir(dataDir, absolutePath) {
  return relative(dataDir, absolutePath);
}

async function pathExists(p) {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readSidecar(base) {
  try {
    const raw = await readFile(base + ASSET_SIDECAR_SUFFIX, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function atomicWriteFile(path, data) {
  const tmp = `${path}.tmp-${process.pid}-${hash8(`${path}:${Date.now()}:${Math.random()}`)}`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

/** URL path → 逻辑段列表（拒绝 "." 与 ".."，解码尽力而为、失败保留编码形态）。 */
function logicalSegments(pathname) {
  const out = [];
  for (const rawSeg of String(pathname || "").split("/")) {
    if (!rawSeg || rawSeg === "." || rawSeg === "..") continue;
    let seg = rawSeg;
    try {
      seg = decodeURIComponent(rawSeg);
    } catch {
      /* 非法编码保留原样，由 safeSegment 兜底 */
    }
    if (seg === "." || seg === "..") continue;
    out.push(seg);
  }
  return out;
}

function hostSegment(url) {
  const defaultPort =
    (url.protocol === "https:" && (url.port === "443" || url.port === "")) ||
    (url.protocol === "http:" && (url.port === "80" || url.port === ""));
  if (defaultPort) return safeSegment(url.hostname);
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return safeSegment(`${url.hostname}_${port}`);
}

function addDisambiguationSuffix(name, key) {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  return `${stem}--${safeSegment(key)}${ext}`;
}

/** 资源消歧键：优先真实资源编号；尚未建档资源以 URL 哈希代位（确定性）。 */
function resourceKey({ resource_id: resourceId, url_exact: urlExact }) {
  if (resourceId && typeof resourceId === "string") return resourceId;
  return `u${hash8(urlExact)}`;
}

/**
 * 物化 assets/ 逻辑入口（§5.2）：
 *   - 依据 url_exact 生成 <项目>/assets/<host>/<path...>/<文件名>；
 *   - 同逻辑路径被不同 URL 占用时，以资源编号消歧（<stem>--<资源编号><ext>）；
 *   - 最新入口内容 = 最新 Blob 字节副本（派生视图，不改变 blobs/ 真值）；
 *   - sidecar <文件名>.capture.json 标明采集编号、完整 URL 与版本历史，
 *     逻辑路径不承担历史证据身份。
 * 本函数只做视图物化：失败向上抛由调用方决定降级（视图可重建，不回滚事实）。
 */
export async function materializeAssetEntry(dataDir, projectId, entry) {
  let url;
  try {
    url = new URL(entry.url_exact);
  } catch {
    return { skipped: "url_not_parseable" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { skipped: "non_http_url" };
  }
  const segments = logicalSegments(url.pathname);
  const dirLike = String(url.pathname || "/").endsWith("/") || segments.length === 0;
  const name = dirLike ? "index" : safeSegment(segments[segments.length - 1]);
  const parentSegs = dirLike ? segments : segments.slice(0, -1);
  let dir = join(projectDir(dataDir, projectId), "assets", hostSegment(url), ...parentSegs.map((s) => safeSegment(s)));

  let target = join(dir, name);
  let disambiguated = false;
  let previous = await readSidecar(target);
  if (previous && previous.url_exact !== entry.url_exact) {
    // 不同 URL 映射到同一逻辑路径 → 资源编号消歧（§5.2）。
    disambiguated = true;
    target = join(dir, addDisambiguationSuffix(name, resourceKey(entry)));
    previous = await readSidecar(target);
    if (previous && previous.url_exact !== entry.url_exact) {
      target = join(dir, addDisambiguationSuffix(name, `h${hash8(entry.url_exact)}`));
      previous = await readSidecar(target);
    }
  } else if (!previous && (await pathExists(target))) {
    // 目标存在但不是本服务生成的入口（无 sidecar）→ 绝不覆盖未知文件。
    disambiguated = true;
    target = join(dir, addDisambiguationSuffix(name, resourceKey(entry)));
    previous = await readSidecar(target);
  }

  if (previous && previous.capture_id === entry.capture_id) {
    return {
      logical_path: relative(projectDir(dataDir, projectId), target),
      disambiguated,
      updated: "unchanged",
      capture_no: entry.capture_no,
    };
  }

  const bytes = await readFile(entry.source_blob_path);
  try {
    await mkdir(dir, { recursive: true });
  } catch (error) {
    // 同一逻辑路径先作为文件写入（如 /admin），后续又需要作为目录（如 /admin/x）：
    // 视图层必须消歧而不是报错或覆盖。采集事实与侧车语义不变（逻辑路径不承担证据身份）。
    if (!error || (error.code !== "EEXIST" && error.code !== "ENOTDIR")) throw error;
    // 兜底目录必须放在「已知是目录」的主机目录下（__entries/）：不能继续嵌在冲突的
    // 文件路径里（dirname(dir) 可能仍是文件，例如 .../index.php/xsrchrte0001）。
    const base = projectDir(dataDir, projectId);
    const entryName = basename(target);
    dir = join(base, "assets", hostSegment(url), "__entries", safeSegment(entryName));
    await mkdir(dir, { recursive: true });
    target = join(dir, safeSegment(entryName));
  }
  await atomicWriteFile(target, bytes);

  const history = new Map();
  for (const v of Array.isArray(previous?.versions) ? previous.versions : []) {
    if (v && v.capture_id) history.set(v.capture_id, v);
  }
  history.set(entry.capture_id, {
    capture_id: entry.capture_id,
    capture_no: entry.capture_no,
    sha256: entry.sha256,
    captured_at: entry.captured_at ?? null,
  });
  const versions = [...history.values()].slice(-MAX_VERSION_HISTORY);
  const sidecar = {
    capture_id: entry.capture_id,
    capture_no: entry.capture_no,
    url_exact: entry.url_exact,
    method: entry.method ?? "",
    resource_id: entry.resource_id ?? null,
    sha256: entry.sha256,
    representation: entry.representation ?? "",
    captured_at: entry.captured_at ?? null,
    updated_at: new Date().toISOString(),
    versions,
  };
  await atomicWriteFile(target + ASSET_SIDECAR_SUFFIX, JSON.stringify(sidecar, null, 2));
  return {
    logical_path: relative(projectDir(dataDir, projectId), target),
    disambiguated,
    updated: previous ? "new_version" : "created",
    capture_no: entry.capture_no,
  };
}

/** 重建项目 assets/ 视图（调用方提供来自数据库的采集与 Blob 信息；视图可完全重建）。 */
export async function rebuildAssetEntries(dataDir, projectId, entries) {
  const results = [];
  for (const entry of entries) {
    try {
      results.push(await materializeAssetEntry(dataDir, projectId, entry));
    } catch (error) {
      results.push({ error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}
