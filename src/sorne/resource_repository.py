"""资源仓库（实施方案 §7.2）。

指纹规则、JS 线索规则、服务字典、POC 模板、技能文档五类资源的分类管理：
每类资源条目具备**来源、许可、版本、哈希、启停、导入验证与回滚**。

纪律（方案 §7.2）：

- 不把参考配置中的用户密钥、Cookie、项目数据和账号结果导入 Sorne；
  导入校验拒绝包含明文凭据形状的内容。
- 速查命令、下载器、WebShell 资源不属于默认自动研究闭环，不注册、
  不自动执行；资源对齐不等于自动加载。
- 回滚只回退版本指针与启停状态，历史版本文件保留（可审计）。
- 内置种子资源随仓库版本化分发；用户导入同 ID 资源时生成新版本而不是
  覆盖内置内容，内置版本仍可回滚恢复。
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any

from .schemas import now_iso


CATEGORIES = (
    "fingerprint_rules",   # §7.1 双轨指纹规则（被动模式 + 主动路径探针）
    "js_clue_rules",       # §7A.1 JS 线索提取规则（端点/凭据形状/路由）
    "service_dictionaries",  # 目录字典 / 子域名字典等服务字典
    "poc_templates",       # POC 模板集合（如 nuclei 模板目录）
    "skill_docs",          # 技能文档（引用 skill_registry 版本化卡片）
)

INDEX_PATH = ("resources", "index.json")
FILES_DIR = ("resources", "files")

# 导入校验拒绝的明文凭据形状（不把密钥/Cookie 当资源内容入库）。
_FORBIDDEN_PATTERNS = tuple(
    re.compile(pattern, re.IGNORECASE) for pattern in (
        # 键名后允许一个可选的闭合引号：JSON 键值形状（"password": "..."）
        # 与文本形状（password=...）都要命中（P4 导入界面实测发现前者漏检）。
        r"api[_-]?key['\"]?\s*[:=]\s*['\"]?[A-Za-z0-9_\-]{16,}['\"]?",
        r"authorization['\"]?\s*[:=]\s*['\"]?(bearer|basic)\s+[A-Za-z0-9._+/=\-]{8,}",
        r"cookie['\"]?\s*[:=]\s*['\"]?[A-Za-z0-9_%\-]{4,}=[^;'\"]{8,}",
        r"-----BEGIN [A-Z ]*PRIVATE KEY-----",
        r"password['\"]?\s*[:=]\s*['\"]?[^'\"}{]{6,}['\"]?(?=[,}\]]|$)",
    )
)


class ResourceRepositoryError(RuntimeError):
    pass


# ── 内置种子（随仓库版本化；license 与仓库一致）────────────────────────

BUNDLED_FINGERPRINT_RULES: list[dict[str, Any]] = [
    {
        "rule_id": "fp-shiro-rememberme",
        "technology": "Apache Shiro",
        "category": "framework",
        "version": 1,
        "passive": [
            {"source": "cookie", "pattern": r"rememberMe=deleteMe"},
        ],
        "active": None,
    },
    {
        "rule_id": "fp-spring-actuator",
        "technology": "Spring Boot Actuator",
        "category": "framework",
        "version": 1,
        "passive": [{"source": "header", "pattern": r"X-Application-Context"}],
        "active": {
            "paths": ["/actuator/health", "/actuator"],
            # 命中必须由内容标记证明，不能只凭状态码（方案 §7.1）。
            "marker_pattern": r"(\"status\"\s*:\s*\"(UP|DOWN)\")|(_links|actuator)",
        },
    },
    {
        "rule_id": "fp-spring-whitelabel",
        "technology": "Spring Framework",
        "category": "framework",
        "version": 1,
        "passive": [
            {"source": "body", "pattern": r"Whitelabel Error Page"},
            {"source": "header", "pattern": r"(?i)server\s*:\s*.*(?<!jetty)"},
        ],
        "active": None,
    },
    {
        "rule_id": "fp-druid-console",
        "technology": "Alibaba Druid Console",
        "category": "middleware",
        "version": 1,
        "passive": [{"source": "body", "pattern": r"druid.*(index|login)"}],
        "active": {
            "paths": ["/druid/index.html"],
            "marker_pattern": r"DruidStatView|druid-index|Login.*druid|druid",
        },
    },
    {
        "rule_id": "fp-nacos-console",
        "technology": "Nacos",
        "category": "middleware",
        "version": 1,
        "passive": [{"source": "body", "pattern": r"nacos.*(console|login)"}],
        "active": {
            "paths": ["/nacos/"],
            "marker_pattern": r"nacos",
        },
    },
    {
        "rule_id": "fp-thinkphp",
        "technology": "ThinkPHP",
        "category": "framework",
        "version": 1,
        "passive": [
            {"source": "header", "pattern": r"(?i)x-powered-by\s*:\s*ThinkPHP"},
            {"source": "body", "pattern": r"ThinkPHP"},
        ],
        "active": None,
    },
    {
        "rule_id": "wp-login",
        "technology": "WordPress",
        "category": "cms",
        "version": 1,
        "passive": [{"source": "body", "pattern": r"wp-content|wp-includes"}],
        "active": {
            "paths": ["/wp-login.php"],
            "marker_pattern": r"wp-login|WordPress",
        },
    },
]

BUNDLED_JS_CLUE_RULES: list[dict[str, Any]] = [
    {
        "rule_id": "js-api-path",
        "kind": "endpoint",
        "pattern": r"[\"'`](/(?:api|v\d+|rest|graphql|gateway|service)[A-Za-z0-9_\-/.]{2,120})[\"'`]",
        "description": "前端代码中声明的 API 路径（观察值，不等于真实可用接口）",
    },
    {
        "rule_id": "js-jwt-token",
        "kind": "secret_shape",
        "pattern": r"eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}",
        "description": "JWT 形状字面量——只是形状命中，真伪需人工/后续验证判别",
    },
    {
        "rule_id": "js-access-key",
        "kind": "secret_shape",
        "pattern": r"(?i)(access[_-]?key|secret[_-]?key|app[_-]?key|token)[\"']?\s*[:=]\s*[\"'][A-Za-z0-9_\-]{12,64}[\"']",
        "description": "访问键/密钥形状的硬编码（可能是占位值，须判别真伪）",
    },
    {
        "rule_id": "js-sourcemap",
        "kind": "sourcemap",
        "pattern": r"sourceMappingURL=([^\s\"']+\.map)",
        "description": "Source map 引用（源码暴露线索）",
    },
    {
        "rule_id": "js-internal-host",
        "kind": "internal_ref",
        "pattern": r"(?i)(https?://(?:10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|localhost)[A-Za-z0-9_.:\-/]{1,80})",
        "description": "内网地址引用（推断的内部拓扑线索）",
    },
]

BUNDLED_DIR_WORDLIST: list[str] = [
    "admin", "login", "api", "backup", "backups", "bak", "config", "console",
    "dashboard", "data", "db", "debug", "deploy", "doc", "docs", "download",
    "downloads", "dump", "files", "git", "health", "images", "include",
    "includes", "install", "js", "lib", "logs", "manager", "metrics", "monitor",
    "old", "phpmyadmin", "private", "public", "release", "reports", "robots.txt",
    "scripts", "secret", "server-status", "sitemap.xml", "source", "sql",
    "static", "stats", "swagger", "swagger-ui", "temp", "test", "tmp", "upload",
    "uploads", "user", "vendor", "web-inf", ".git/config", ".env", "actuator",
    "druid", "nacos", "graphql", "api-docs", "v2/api-docs",
]

BUNDLED_SUBDOMAIN_WORDLIST: list[str] = [
    "www", "mail", "remote", "blog", "web", "api", "dev", "staging", "stage",
    "test", "portal", "admin", "vpn", "ns1", "ns2", "mx", "smtp", "ftp", "git",
    "ci", "jenkins", "jira", "wiki", "docs", "app", "apps", "m", "mobile",
    "shop", "store", "sso", "auth", "id", "oa", "crm", "erp", "cdn", "static",
    "img", "images", "assets", "media", "video", "download", "dl", "files",
    "monitor", "grafana", "kibana", "es", "redis", "mysql", "db", "internal",
    "intranet", "corporate", "hr", "support", "help", "status",
]


def _bundled_entries() -> list[dict[str, Any]]:
    return [
        {
            "id": "builtin-web-fingerprints",
            "category": "fingerprint_rules",
            "name": "内置 Web 指纹规则（双轨）",
            "content": BUNDLED_FINGERPRINT_RULES,
        },
        {
            "id": "builtin-js-leads",
            "category": "js_clue_rules",
            "name": "内置 JS 线索规则",
            "content": BUNDLED_JS_CLUE_RULES,
        },
        {
            "id": "dirs-common",
            "category": "service_dictionaries",
            "name": "常用 Web 目录字典",
            "content": {"kind": "dir_wordlist", "words": BUNDLED_DIR_WORDLIST},
        },
        {
            "id": "subdomains-common",
            "category": "service_dictionaries",
            "name": "常用子域名字典",
            "content": {"kind": "subdomain_wordlist", "words": BUNDLED_SUBDOMAIN_WORDLIST},
        },
        {
            "id": "nuclei-bundled-templates",
            "category": "poc_templates",
            "name": "nuclei 模板目录（项目本地 .sorne-work/nuclei-templates）",
            "content": {"engine": "nuclei", "path": ".sorne-work/nuclei-templates"},
        },
        {
            "id": "skill-cards-bundled",
            "category": "skill_docs",
            "name": "内置技能卡（skill_registry 版本化）",
            "content": {"registry": "skill_registry", "note": "版本以 skill_registry 快照为准"},
        },
    ]


# ── 存取 ─────────────────────────────────────────────────────────────

def _index_path(store) -> Path:
    return store.path.joinpath(*INDEX_PATH)


def _files_root(store) -> Path:
    return store.path.joinpath(*FILES_DIR)


def _load_index(store) -> list[dict[str, Any]]:
    path = _index_path(store)
    if not path.is_file():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    return data if isinstance(data, list) else []


def _save_index(store, entries: list[dict[str, Any]]) -> None:
    path = _index_path(store)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(entries, ensure_ascii=False, indent=2), encoding="utf-8",
    )


def _write_version_file(store, resource_id: str, version: int, content: Any) -> tuple[str, str]:
    """写入一个版本内容文件，返回 (相对路径, sha256)。"""
    destination = _files_root(store) / resource_id / f"v{int(version)}.json"
    destination.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(content, ensure_ascii=False, indent=2).encode("utf-8")
    destination.write_bytes(payload)
    digest = hashlib.sha256(payload).hexdigest()
    relative = destination.relative_to(store.path).as_posix()
    return relative, digest


def _forbidden_secret_hits(content: Any) -> list[str]:
    text = json.dumps(content, ensure_ascii=False)
    return [pattern.pattern for pattern in _FORBIDDEN_PATTERNS if pattern.search(text)]


# ── 校验（按类别的结构校验；§7.2 导入验证）─────────────────────────────

def validate_content(category: str, content: Any) -> list[str]:
    problems: list[str] = []
    if category not in CATEGORIES:
        problems.append(f"未知资源类别: {category}")
        return problems
    hits = _forbidden_secret_hits(content)
    if hits:
        problems.append(
            "资源内容包含明文凭据形状（"
            + "; ".join(hits[:3])
            + "）；凭据必须走秘密存储引用，不得作为资源导入"
        )
    if category == "fingerprint_rules":
        if not isinstance(content, list) or not content:
            problems.append("fingerprint_rules 必须是非空规则数组")
        else:
            for index, rule in enumerate(content):
                if not isinstance(rule, dict):
                    problems.append(f"规则 #{index} 必须是对象")
                    continue
                for field in ("rule_id", "technology"):
                    if not str(rule.get(field) or "").strip():
                        problems.append(f"规则 #{index} 缺少 {field}")
                passive = rule.get("passive")
                if passive is not None:
                    if not isinstance(passive, list):
                        problems.append(f"规则 #{index} passive 必须是数组")
                    else:
                        for item in passive:
                            if not isinstance(item, dict) or str(item.get("source") or "") not in {
                                "header", "cookie", "body",
                            } or not str(item.get("pattern") or "").strip():
                                problems.append(
                                    f"规则 #{index} 的 passive 项需要 source(header|cookie|body) 与 pattern"
                                )
                            else:
                                try:
                                    re.compile(str(item["pattern"]))
                                except re.error as exc:
                                    problems.append(f"规则 #{index} passive 正则无效: {exc}")
                active = rule.get("active")
                if active is not None:
                    if not isinstance(active, dict) or not isinstance(active.get("paths"), list) or not active.get("paths"):
                        problems.append(f"规则 #{index} active 需要 paths 数组")
                    elif not str(active.get("marker_pattern") or "").strip():
                        problems.append(
                            f"规则 #{index} active 需要 marker_pattern（状态码命中不等于技术确认）"
                        )
                    else:
                        try:
                            re.compile(str(active["marker_pattern"]))
                        except re.error as exc:
                            problems.append(f"规则 #{index} active 正则无效: {exc}")
    elif category == "js_clue_rules":
        if not isinstance(content, list) or not content:
            problems.append("js_clue_rules 必须是非空规则数组")
        else:
            for index, rule in enumerate(content):
                if not isinstance(rule, dict) or not str(rule.get("rule_id") or "").strip() \
                        or not str(rule.get("pattern") or "").strip():
                    problems.append(f"规则 #{index} 需要 rule_id 与 pattern")
                elif str(rule.get("kind") or "") not in {
                    "endpoint", "secret_shape", "sourcemap", "internal_ref", "route",
                }:
                    problems.append(f"规则 #{index} kind 必须是 endpoint|secret_shape|sourcemap|internal_ref|route")
                else:
                    try:
                        re.compile(str(rule["pattern"]))
                    except re.error as exc:
                        problems.append(f"规则 #{index} 正则无效: {exc}")
    elif category == "service_dictionaries":
        if not isinstance(content, dict) or not isinstance(content.get("words"), list) or not content["words"]:
            problems.append("service_dictionaries 内容需要 {kind, words[]} 且 words 非空")
        elif any(not isinstance(word, str) or not word.strip() for word in content["words"]):
            problems.append("字典 words 必须是非空字符串")
    elif category == "poc_templates":
        if not isinstance(content, dict) or not str(content.get("engine") or "").strip():
            problems.append("poc_templates 内容需要 engine 标识")
    elif category == "skill_docs":
        if not isinstance(content, dict):
            problems.append("skill_docs 内容需要对象（引用 skill_registry）")
    return problems


# ── 公共 API ─────────────────────────────────────────────────────────

def ensure_defaults(store) -> dict[str, Any]:
    """幂等注册内置种子资源；用户已导入同 ID 资源时不覆盖。"""
    created: list[str] = []
    for entry in _bundled_entries():
        problems = validate_content(entry["category"], entry["content"])
        if problems:  # 内置内容出厂前已校验；失败是编程错误
            raise ResourceRepositoryError(f"内置资源 {entry['id']} 校验失败: {problems}")
        existing = find_resource(store, entry["id"])
        if existing is not None:
            continue
        import_resource(
            store,
            category=entry["category"],
            resource_id=entry["id"],
            name=entry["name"],
            content=entry["content"],
            version=1,
            source="sorne-bundled",
            source_url="https://github.com/（随 Sorne 仓库分发）",
            license="Sorne 仓库内置（同仓库许可）",
            imported_by="system:ensure_defaults",
        )
        created.append(entry["id"])
    return {"registered": created}


def find_resource(store, resource_id: str) -> dict[str, Any] | None:
    return next(
        (item for item in _load_index(store) if str(item.get("id")) == str(resource_id)),
        None,
    )


def import_resource(
    store,
    *,
    category: str,
    resource_id: str,
    name: str,
    content: Any,
    version: int | None = None,
    source: str = "user-import",
    source_url: str = "",
    license: str = "",
    imported_by: str = "user",
    enabled: bool = True,
    validate: bool = True,
) -> dict[str, Any]:
    """导入/升级资源（同 ID 生成新版本；旧版本保留供回滚）。

    ``validate=False`` 只用于内置种子的受控路径；用户导入一律校验。
    """
    resource_id = str(resource_id or "").strip()
    if not resource_id or not re.fullmatch(r"[A-Za-z0-9_.\-]{2,64}", resource_id):
        raise ResourceRepositoryError(f"资源 ID 非法: {resource_id!r}")
    if not str(name or "").strip():
        raise ResourceRepositoryError("资源必须提供名称")
    if not str(source or "").strip():
        raise ResourceRepositoryError("资源必须登记来源（source）")
    if not str(license or "").strip():
        raise ResourceRepositoryError(
            "资源必须登记许可信息；来源/许可不明的资源不得进入默认研究闭环"
        )
    problems = validate_content(category, content) if validate else []
    if problems:
        raise ResourceRepositoryError("导入验证失败: " + "; ".join(problems[:6]))

    entries = _load_index(store)
    existing = next(
        (item for item in entries if str(item.get("id")) == resource_id), None,
    )
    if existing is not None and str(existing.get("category")) != category:
        raise ResourceRepositoryError(
            f"资源 {resource_id} 已存在于类别 {existing.get('category')}，不能改挂 {category}"
        )
    if existing is not None:
        next_version = int(existing.get("version") or 1) + 1
    else:
        next_version = int(version or 1)
    if version is not None and existing is None:
        next_version = int(version)
    relative, digest = _write_version_file(store, resource_id, next_version, content)
    history = list((existing or {}).get("history") or [])
    if existing is not None:
        history.append({
            "version": int(existing.get("version") or 1),
            "sha256": existing.get("sha256"),
            "file": existing.get("file"),
            "source": existing.get("source"),
            "license": existing.get("license"),
            "imported_at": existing.get("imported_at"),
        })
    entry = {
        "id": resource_id,
        "category": category,
        "name": str(name),
        "version": next_version,
        "file": relative,
        "sha256": digest,
        "enabled": bool(enabled),
        "source": str(source),
        "source_url": str(source_url or ""),
        "license": str(license),
        "imported_by": str(imported_by),
        "imported_at": now_iso(),
        "history": history,
    }
    if existing is None:
        entries.append(entry)
    else:
        entries = [entry if str(item.get("id")) == resource_id else item for item in entries]
    _save_index(store, entries)
    return entry


def set_enabled(store, resource_id: str, *, enabled: bool) -> dict[str, Any]:
    entries = _load_index(store)
    updated: dict[str, Any] | None = None
    for index, item in enumerate(entries):
        if str(item.get("id")) == str(resource_id):
            item = dict(item)
            item["enabled"] = bool(enabled)
            entries[index] = item
            updated = item
            break
    if updated is None:
        raise ResourceRepositoryError(f"资源不存在: {resource_id}")
    _save_index(store, entries)
    return updated


def rollback(store, resource_id: str) -> dict[str, Any]:
    """回滚到上一版本：恢复内容指针与来源/许可元数据，保留回滚前版本。"""
    entries = _load_index(store)
    target_index = next(
        (i for i, item in enumerate(entries) if str(item.get("id")) == str(resource_id)),
        None,
    )
    if target_index is None:
        raise ResourceRepositoryError(f"资源不存在: {resource_id}")
    current = entries[target_index]
    history = list(current.get("history") or [])
    if not history:
        raise ResourceRepositoryError(f"资源 {resource_id} 没有可回滚的历史版本")
    previous = history[-1]
    previous_file = store.path / str(previous.get("file") or "")
    if not previous_file.is_file():
        raise ResourceRepositoryError(
            f"历史版本文件缺失（可能已被外部删除）: {previous.get('file')}"
        )
    rolled_back_from = {
        "version": current.get("version"),
        "sha256": current.get("sha256"),
        "file": current.get("file"),
        "source": current.get("source"),
        "license": current.get("license"),
        "imported_at": current.get("imported_at"),
    }
    restored = dict(current)
    restored.update({
        "version": int(previous.get("version") or 1),
        "file": previous.get("file"),
        "sha256": previous.get("sha256"),
        "source": previous.get("source") or current.get("source"),
        "license": previous.get("license") or current.get("license"),
        "imported_at": now_iso(),
        "imported_by": f"rollback:{current.get('imported_by') or 'unknown'}",
        "history": history[:-1] + [rolled_back_from],
    })
    entries[target_index] = restored
    _save_index(store, entries)
    return restored


def list_resources(store, *, category: str | None = None) -> list[dict[str, Any]]:
    entries = _load_index(store)
    if category:
        entries = [item for item in entries if str(item.get("category")) == category]
    return entries


def load_active(
    store,
    category: str,
    *,
    resource_id: str | None = None,
) -> tuple[Any, dict[str, Any]] | None:
    """加载当前启用的资源内容（带完整性校验）。返回 (content, entry)。

    没有任何启用资源时返回 None——调用方（引擎适配层）据此显式报缺口，
    不得用内置硬编码绕过启停语义。
    """
    entries = load_all_active(store, category, resource_id=resource_id)
    return entries[0] if entries else None


def load_all_active(
    store,
    category: str,
    *,
    resource_id: str | None = None,
) -> list[tuple[Any, dict[str, Any]]]:
    """该类别全部启用且校验通过的资源（同类别多资源共存时按导入顺序）。"""
    results: list[tuple[Any, dict[str, Any]]] = []
    candidates = [
        item for item in _load_index(store)
        if str(item.get("category")) == category and bool(item.get("enabled"))
    ]
    if resource_id is not None:
        candidates = [item for item in candidates if str(item.get("id")) == str(resource_id)]
    for entry in candidates:
        path = store.path / str(entry.get("file") or "")
        if not path.is_file():
            continue
        raw = path.read_bytes()
        if hashlib.sha256(raw).hexdigest() != str(entry.get("sha256") or ""):
            # 哈希不一致：资源被视为损坏，跳过（导入验证/回滚可修复）。
            continue
        try:
            content = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            continue
        results.append((content, entry))
    return results


def status(store) -> dict[str, Any]:
    entries = _load_index(store)
    return {
        "categories": {
            category: sum(1 for item in entries if item.get("category") == category)
            for category in CATEGORIES
        },
        "resources": entries,
    }
