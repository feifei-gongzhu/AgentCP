"""原生 Web 采集适配器：目录采集（dir_scan）与 JS 资产采集（js_scan）。

实施方案 §6.6-4（P3）：补齐目录/JS 采集能力。两者是**原生真实实现**
（受控 HTTP 请求 + 结构化记录 + 证据落盘），不是外部引擎包装：

- ``dir_scan``：资源仓库字典驱动的路径探测；每个目标先取**随机路径基线**
  （§7A.1 目录研判的输入契约：路径、状态码、响应摘要、重定向、基线/
  随机路径对照、内容指纹）；与基线同形的记录标记 ``same_as_baseline``
  （统一错误页/catch-all 的判别交给目录研判分析器，不在采集层下结论）。
- ``js_scan``：抓取入口页 → 解析 ``<script src>`` → 受限抓取 JS 文件，
  记录内容哈希/大小/来源页，并按资源仓库 JS 线索规则提取端点、凭据形状、
  source map 与内网引用线索（规则命中是**观察**，真伪判别交给 JS 研判）。

公共纪律：固定参数（无 shell 拼接）、逐目标批次状态（§8.3 restart_remaining）、
取消检查逐请求进行、证据 sha256 边车落盘、秘密绝不进入记录。
"""

from __future__ import annotations

import hashlib
import json
import re
import socket
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urljoin, urlsplit

from .. import resource_repository
from .batch_state import ScanBatch, arguments_digest


class CollectError(RuntimeError):
    pass


def native_availability() -> tuple[bool, str]:
    """原生采集能力的运行时可用性（无外部引擎依赖；字典/规则缺口的
    capability_missing 在执行时按资源仓库状态如实报出）。"""
    return True, ""


REQUEST_TIMEOUT_SECONDS = 12
MAX_BYTES_PER_RESPONSE = 262_144
MAX_WORDS_PER_TARGET = 160
MAX_JS_FILES_PER_TARGET = 24
MAX_JS_BYTES = 512_000
MAX_TARGETS_PER_SCAN = 16


class _NoFollowRedirect(urllib.request.HTTPRedirectHandler):
    """不跟随重定向：location 由采集层显式记录（登录跳转等判别交给分析器）。"""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D102
        return None


NO_REDIRECT_OPENER = urllib.request.build_opener(_NoFollowRedirect())


def _redact(text: str) -> str:
    """对不可信的抓取内容做形状脱敏（JWT/长令牌形态压缩；§7A.4）。"""
    import re as _re

    text = _re.sub(
        r"eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}",
        "[REDACTED-JWT]", text,
    )
    text = _re.sub(
        r"(?i)(authorization|api[_-]?key|secret[_-]?key)\s*[:=]\s*['\"][A-Za-z0-9._+/=\-]{12,}['\"]",
        r"\1=[REDACTED]", text,
    )
    return text


def fetch_url(
    url: str,
    *,
    method: str = "GET",
    headers: dict[str, str] | None = None,
    body: str | None = None,
    timeout: int = REQUEST_TIMEOUT_SECONDS,
    max_bytes: int = MAX_BYTES_PER_RESPONSE,
    opener: urllib.request.OpenerDirector | None = None,
) -> dict[str, Any]:
    """单次受控请求（默认不跟随重定向；记录 location）。异常转为 error 记录。"""
    data = body.encode("utf-8") if body is not None else None
    request = urllib.request.Request(
        url, method=method.upper(), data=data,
        headers={"User-Agent": "Sorne-collect/1.0", **(headers or {})},
    )
    try:
        with (opener or NO_REDIRECT_OPENER).open(request, timeout=timeout) as response:
            body_bytes = response.read(max_bytes + 1)[:max_bytes]
            return {
                "ok": True,
                "status": int(response.status),
                "headers": {str(k): str(v) for k, v in response.headers.items()},
                "body": body_bytes,
                "url": url,
                "error": "",
            }
    except urllib.error.HTTPError as exc:
        try:
            body_bytes = exc.read(max_bytes + 1)[:max_bytes]
        except (OSError, ValueError):
            body_bytes = b""
        return {
            "ok": True,
            "status": int(exc.code),
            "headers": {str(k): str(v) for k, v in (exc.headers or {}).items()},
            "body": body_bytes,
            "url": url,
            "error": "",
        }
    except (urllib.error.URLError, TimeoutError, OSError, socket.timeout) as exc:
        return {
            "ok": False, "status": None, "headers": {}, "body": b"",
            "url": url, "error": f"{type(exc).__name__}: {exc}",
        }


def _location_of(headers: dict[str, str]) -> str:
    for key, value in headers.items():
        if key.casefold() == "location":
            return value
    return ""


def _body_fingerprint(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()


def _write_evidence(store, subdir: str, name_stem: str, payload: bytes) -> str:
    evidence_root = store.path / "evidence" / subdir
    evidence_root.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256(payload).hexdigest()
    destination = evidence_root / f"{digest}.{name_stem}"
    if not destination.exists():
        destination.write_bytes(payload)
    destination.with_name(destination.name + ".sha256").write_text(
        f"{digest}  {destination.name}\n", encoding="utf-8",
    )
    return f"evidence/{subdir}/{destination.name}"


def _load_wordlist(store, *, kind: str, fallback_note: str) -> list[str]:
    """按字典类别（dir_wordlist / subdomain_wordlist）加载首个匹配的启用资源。"""
    for content, entry in resource_repository.load_all_active(store, "service_dictionaries"):
        if not isinstance(content, dict) or content.get("kind") != kind:
            continue
        words = [str(word).strip().strip("/") for word in (content.get("words") or [])]
        words = [word for word in words if word]
        if words:
            return words
    raise CollectError(
        f"capability_missing: 没有启用的 {kind} 服务字典资源（{fallback_note}）。"
        "请在资源仓库启用或导入对应类别的字典后重试；不得以空字典冒充采集。"
    )


def _normalize_targets(arguments: dict[str, Any]) -> list[str]:
    targets = [
        str(item).strip() for item in (arguments.get("targets") or [])
        if str(item).strip()
    ]
    if not targets:
        raise CollectError("需要至少一个目标（targets: string[]）")
    if len(targets) > MAX_TARGETS_PER_SCAN:
        raise CollectError(
            f"单次采集目标数超过上限 {MAX_TARGETS_PER_SCAN}；请拆分批处理"
        )
    for target in targets:
        parsed = urlsplit(target if "://" in target else f"http://{target}")
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise CollectError(f"目标必须是 http(s) URL: {target}")
    return targets


def _random_control_path() -> str:
    import secrets

    return f"sorne-baseline-{secrets.token_hex(8)}"


# ── 目录采集 ─────────────────────────────────────────────────────────

def run_dir_scan(
    store,
    arguments: dict[str, Any],
    *,
    cancel_check: Callable[[], bool] | None = None,
    wordlist_override: list[str] | None = None,
    fetcher: Callable[..., dict[str, Any]] | None = None,
) -> dict[str, Any]:
    cancel = cancel_check or (lambda: False)
    targets = _normalize_targets(arguments)
    words = wordlist_override if wordlist_override is not None else _load_wordlist(
        store, kind="dir_wordlist", fallback_note="dir_scan 需要目录字典",
    )
    words = words[:MAX_WORDS_PER_TARGET]
    fetch = fetcher or fetch_url

    digest = arguments_digest("dir_scan", {"targets": targets, "words": len(words)})
    batch = ScanBatch(store, "dir_scan", digest, targets)
    batch.begin_run(f"dir_scan words={len(words)}")
    remaining = batch.remaining_targets()

    records: list[dict[str, Any]] = []
    evidence_paths: list[str] = []
    interrupted = False
    dictionary_meta = {"word_count": len(words), "words_capped": words[:MAX_WORDS_PER_TARGET] == words}
    for target in remaining:
        if cancel():
            interrupted = True
            break
        batch.mark(target, "running")
        baseline_path = _random_control_path()
        baseline = fetch(f"{target.rstrip('/')}/{baseline_path}")
        baseline_fp = _body_fingerprint(baseline["body"]) if baseline["ok"] else ""
        baseline_record = {
            "control_path": baseline_path,
            "status": baseline.get("status"),
            "length": len(baseline.get("body") or b""),
            "fingerprint": baseline_fp,
            "error": baseline.get("error") or "",
        }
        target_records: list[dict[str, Any]] = []
        target_error = ""
        for word in words:
            if cancel():
                interrupted = True
                break
            url = f"{target.rstrip('/')}/{word}"
            response = fetch(url)
            if not response.get("ok"):
                target_error = str(response.get("error") or "request_failed")
                break
            body = response.get("body") or b""
            record = {
                "target": target,
                "path": f"/{word}",
                "url": url,
                "status": response.get("status"),
                "length": len(body),
                "content_type": next(
                    (v for k, v in response["headers"].items() if k.casefold() == "content-type"), ""
                ),
                "location": _location_of(response["headers"]),
                "fingerprint": _body_fingerprint(body),
                # 与基线同形（同状态码+同内容指纹）= 统一错误页/catch-all 候选；
                # 判别归目录研判分析器，采集层只给对照事实。
                "same_as_baseline": (
                    response.get("status") == baseline_record["status"]
                    and _body_fingerprint(body) == baseline_fp
                ),
            }
            target_records.append(record)
        if interrupted:
            batch.note_interrupted([target])
            break
        evidence_path = _write_evidence(
            store, "dir",
            f"target-{hashlib.sha256(target.encode()).hexdigest()[:12]}.json",
            json.dumps(
                {"target": target, "baseline": baseline_record, "records": target_records},
                ensure_ascii=False, indent=1,
            ).encode("utf-8"),
        )
        if target_error:
            batch.mark(target, "failed", {"error": target_error[:300]})
        else:
            batch.mark(
                target, "completed",
                {"records": len(target_records), "evidence": evidence_path},
            )
            evidence_paths.append(evidence_path)
        records.extend(target_records)

    result = {
        "engine": "sorne-native-dir-collect",
        "engine_version": "1",
        "parser_version": "v1",
        "targets": targets,
        "dictionary": dictionary_meta,
        "records": records[:256],
        "record_count": len(records),
        "no_hit": not any(
            record["status"] not in {404}
            and not record["same_as_baseline"]
            for record in records
        ),
        "batch": batch.summary(),
        "evidence_path": evidence_paths[0] if evidence_paths else None,
        "evidence_paths": evidence_paths,
        "cancelled": interrupted,
        "resumed": bool(batch.summary()["completed"]) and not evidence_paths,
        "resume_note": (
            "批处理按目标粒度记录状态；未完成目标可在下一次调用以相同参数恢复"
            "（restart_remaining），已完成目标不重扫（§8.3）；已完成目标的逐目标"
            "记录见 evidence_paths 与批次账本 target_summaries。"
        ),
    }
    if not evidence_paths and batch.record.get("target_summaries"):
        result["target_summaries"] = batch.record["target_summaries"]
    return result


# ── JS 采集 ──────────────────────────────────────────────────────────

_SCRIPT_SRC_RE = re.compile(
    r"<script[^>]+src=[\"']([^\"']+)[\"']", re.IGNORECASE,
)


def _load_js_rules(store) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    loaded = resource_repository.load_active(store, "js_clue_rules")
    if loaded is None:
        raise CollectError(
            "capability_missing: 没有启用的 JS 线索规则资源；"
            "请在资源仓库启用或导入 js_clue_rules 后重试。"
        )
    content, entry = loaded
    rules = []
    for rule in content:
        try:
            rules.append({
                "rule_id": str(rule["rule_id"]),
                "kind": str(rule["kind"]),
                "pattern": re.compile(str(rule["pattern"])),
            })
        except (KeyError, re.error):
            continue
    if not rules:
        raise CollectError(
            f"capability_missing: JS 线索规则资源 {entry.get('id')} 无有效规则。"
        )
    return rules, {"resource_id": entry.get("id"), "version": entry.get("version")}


# 脱敏标记的补漏规则：内容先脱敏再提取（§7A.4），秘密形状字面量被替换
# 成标记后仍要作为“疑似敏感信息”线索出现（值不进模型，形状与位置保留）。
_REDACTION_MARKER_RULES: list[dict[str, Any]] = [
    {
        "rule_id": "js-redacted-jwt",
        "kind": "secret_shape",
        "pattern": re.compile(r"\[REDACTED-JWT\]"),
        "description": "JWT 形状字面量（值已在采集层脱敏）",
    },
    {
        "rule_id": "js-redacted-credential",
        "kind": "secret_shape",
        "pattern": re.compile(r"(?i)(authorization|api[_-]?key|secret[_-]?key)\s*[:=]\s*\[REDACTED\]"),
        "description": "凭据形状字面量（值已在采集层脱敏）",
    },
]


def _extract_js_leads(text: str, rules: list[dict[str, Any]]) -> list[dict[str, Any]]:
    leads: list[dict[str, Any]] = []
    for rule in [*rules, *_REDACTION_MARKER_RULES]:
        for match in rule["pattern"].finditer(text):
            snippet = match.group(0)[:240]
            leads.append({
                "rule_id": rule["rule_id"],
                "kind": rule["kind"],
                # 观察到的原文片段 + 字节位置（§7A.1：每条结论引用具体文件位置）
                "snippet": snippet,
                "offset": match.start(),
                "observed": True,  # 规则命中是观察；含义/真伪由 JS 研判判别
            })
            if len(leads) >= 200:
                return leads
    return leads


def run_js_scan(
    store,
    arguments: dict[str, Any],
    *,
    cancel_check: Callable[[], bool] | None = None,
    fetcher: Callable[..., dict[str, Any]] | None = None,
    rule_override: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    cancel = cancel_check or (lambda: False)
    targets = _normalize_targets(arguments)
    fetch = fetcher or fetch_url
    if rule_override is not None:
        rules = [
            {"rule_id": str(r["rule_id"]), "kind": str(r["kind"]),
             "pattern": re.compile(str(r["pattern"]))}
            for r in rule_override
        ]
        rules_meta = {"resource_id": "override", "version": None}
    else:
        rules, rules_meta = _load_js_rules(store)

    digest = arguments_digest("js_scan", {"targets": targets, "rules": len(rules)})
    batch = ScanBatch(store, "js_scan", digest, targets)
    batch.begin_run(f"js_scan rules={len(rules)}")
    remaining = batch.remaining_targets()

    files: list[dict[str, Any]] = []
    interrupted = False
    for target in remaining:
        if cancel():
            interrupted = True
            break
        batch.mark(target, "running")
        page = fetch(target, max_bytes=MAX_BYTES_PER_RESPONSE * 2)
        if not page.get("ok"):
            batch.mark(target, "failed", {"error": str(page.get("error") or "")[:300]})
            continue
        page_text = (page.get("body") or b"").decode("utf-8", errors="replace")
        script_urls: list[str] = []
        for src in _SCRIPT_SRC_RE.findall(page_text):
            absolute = urljoin(target, src)
            if urlsplit(absolute).scheme in {"http", "https"}:
                script_urls.append(absolute)
        script_urls = script_urls[:MAX_JS_FILES_PER_TARGET]
        target_files: list[dict[str, Any]] = []
        for script_url in script_urls:
            if cancel():
                interrupted = True
                break
            response = fetch(script_url, max_bytes=MAX_JS_BYTES)
            if not response.get("ok"):
                target_files.append({
                    "source_url": script_url, "source_page": target,
                    "fetch_error": str(response.get("error") or "")[:200],
                    "content_sha256": None, "size": None, "leads": [],
                })
                continue
            body = response.get("body") or b""
            text = body.decode("utf-8", errors="replace")
            # 抓取到的内容是不可信输入：脱敏后再进入记录与证据（§7A.4）。
            safe_text = _redact(text)
            leads = _extract_js_leads(safe_text, rules)
            evidence_path = _write_evidence(
                store, "js",
                f"js-{hashlib.sha256(script_url.encode()).hexdigest()[:12]}.txt",
                safe_text[:MAX_JS_BYTES].encode("utf-8", errors="replace"),
            )
            target_files.append({
                "source_url": script_url,
                "source_page": target,
                "content_sha256": _body_fingerprint(body),
                "size": len(body),
                "truncated": len(body) >= MAX_JS_BYTES,
                "evidence_path": evidence_path,
                "leads": leads,
                "fetch_error": "",
            })
        if interrupted:
            batch.note_interrupted([target])
            break
        batch.mark(target, "completed", {"files": len(target_files)})
        files.extend(target_files)

    result = {
        "engine": "sorne-native-js-collect",
        "engine_version": "1",
        "parser_version": "v1",
        "targets": targets,
        "rules": rules_meta,
        "files": files[:128],
        "file_count": len(files),
        "lead_count": sum(len(item.get("leads") or []) for item in files),
        "no_hit": not any((item.get("leads") or []) for item in files),
        "batch": batch.summary(),
        "cancelled": interrupted,
        "resumed": bool(batch.summary()["completed"]) and not files,
        "resume_note": "逐目标批次状态见 batch；未完成目标以相同参数恢复执行。",
    }
    if not files and batch.record.get("target_summaries"):
        result["target_summaries"] = batch.record["target_summaries"]
    return result


# ── 子域名枚举（原生 DNS 解析，fscan 不含子域模块）───────────────────

def run_subdomain_scan(
    store,
    arguments: dict[str, Any],
    *,
    cancel_check: Callable[[], bool] | None = None,
    resolver: Callable[[str], list[str]] | None = None,
) -> dict[str, Any]:
    """子域名枚举：服务字典 + DNS 解析（真实解析记录，无猜测）。

    ``resolver(host) -> [ip...]`` 供测试注入；生产路径用
    ``socket.getaddrinfo``。仅对授权范围内的根域执行（网关侧已校验）。
    """
    cancel = cancel_check or (lambda: False)

    def _resolve(host: str) -> list[str]:
        try:
            infos = socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)
        except (socket.gaierror, OSError, UnicodeError):
            return []
        seen: list[str] = []
        for info in infos:
            ip = info[4][0]
            if ip not in seen:
                seen.append(ip)
        return seen

    resolve = resolver or _resolve
    raw_targets = [
        str(item).strip() for item in (arguments.get("targets") or [])
        if str(item).strip()
    ]
    if not raw_targets:
        raise CollectError("subdomain_scan 需要至少一个根域（targets: string[]）")
    if len(raw_targets) > 8:
        raise CollectError("单次子域枚举根域数超过上限 8；请拆分批处理")
    for target in raw_targets:
        host = urlsplit(target if "://" in target else f"http://{target}").hostname or target
        if not host or "/" in host or " " in host:
            raise CollectError(f"非法根域: {target}")

    words = _load_wordlist(
        store, kind="subdomain_wordlist", fallback_note="subdomain_scan 需要子域字典",
    )[:512]
    digest = arguments_digest("subdomain_scan", {"targets": raw_targets, "words": len(words)})
    batch = ScanBatch(store, "subdomain_scan", digest, raw_targets)
    batch.begin_run(f"subdomain_scan words={len(words)}")
    records: list[dict[str, Any]] = []
    interrupted = False
    for root in batch.remaining_targets():
        if cancel():
            interrupted = True
            break
        batch.mark(root, "running")
        host = urlsplit(root if "://" in root else f"http://{root}").hostname or root
        root_ips = resolve(host)
        found: list[dict[str, Any]] = [{
            "subdomain": host, "ips": root_ips[:8], "source": "root",
        }]
        for word in words:
            if cancel():
                interrupted = True
                break
            candidate = f"{word}.{host}"
            ips = resolve(candidate)
            if ips:
                found.append({
                    "subdomain": candidate, "ips": ips[:8], "source": "dns_dictionary",
                })
        if interrupted:
            batch.note_interrupted([root])
            break
        records.extend(found)
        batch.mark(root, "completed", {"resolved": len(found)})

    evidence_path = _write_evidence(
        store, "subdomain", "subdomains.json",
        json.dumps({"records": records}, ensure_ascii=False, indent=1).encode("utf-8"),
    )
    return {
        "engine": "sorne-native-dns-subdomain",
        "engine_version": "1",
        "parser_version": "v1",
        "targets": raw_targets,
        "records": records[:256],
        "record_count": len(records),
        "no_hit": not any(item["source"] == "dns_dictionary" for item in records),
        "batch": batch.summary(),
        "evidence_path": evidence_path,
        "cancelled": interrupted,
        "note": (
            "记录为 DNS 解析观察（字典命中 + 解析 IP）；子域服务是否在授权范围内"
            "由后续任务的目标校验决定，不在采集层扩张攻击面。"
        ),
    }
