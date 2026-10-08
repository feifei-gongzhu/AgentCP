"""口令验证适配器（实施方案 §6.6-4、§12-P3；原生实现）。

对**已授权**的口令类服务验证凭据组合：凭据一律以 ``credential_ref`` 引用
（RuntimeSecretStore），明文口令绝不进入参数、记录、证据或日志。

验证是**有副作用的敏感动作**（登录尝试），恢复语义严于只读采集（§8.3）：

- 逐 (target, username, password) 组合记录尝试状态；崩溃后重启只对未尝试
  组合继续（**不**自动重试 unknown_outcome——登录请求是否已执行不明，
  重复尝试可能触发锁定，须用户显式以新批次重跑）。
- 单次调用尝试数有硬上限（MAX_ATTEMPTS_PER_CALL）；命中后同目标立即停止。
- 结果分类保守：``verified`` 需要正向证据（Basic 401→2xx；表单登录后
  会话 Cookie 变化 + 登出基线差异），否则 ``rejected``/``unresolved``。
  命中也只是 risk_lead 候选，升级由 Guardian/人工复核决定。
- 证据文件中的口令一律替换为 ``[REDACTED]``（用户名保留供复核）。
"""

from __future__ import annotations

import hashlib
import html
import json
import re
import time
from typing import Any, Callable
from urllib.parse import urljoin, urlparse

from .web_collect import NO_REDIRECT_OPENER, fetch_url

MAX_ATTEMPTS_PER_CALL = 8
MAX_TARGETS_PER_CALL = 6
ATTEMPT_INTERVAL_SECONDS = 0.4


class CredentialCheckError(RuntimeError):
    pass


def native_availability() -> tuple[bool, str]:
    """原生凭据验证的运行时可用性（凭据引用缺失在执行时如实报错）。"""
    return True, ""


class CredentialRefError(RuntimeError):
    """凭据引用缺失/格式非法——不做任何尝试即失败。"""


def parse_credential_payload(raw: str) -> list[dict[str, str]]:
    """解析凭据引用内容：JSON pairs 数组或 ``user:pass`` 行列表。

    只接受显式结构；拒绝空字段。调用方不得把解析结果写日志。
    """
    text = str(raw or "").strip()
    if not text:
        raise CredentialRefError("credential_ref 引用的凭据为空")
    pairs: list[dict[str, str]] = []
    if text.startswith("{"):
        try:
            data = json.loads(text)
        except json.JSONDecodeError as exc:
            raise CredentialRefError(f"credential_ref 引用的 JSON 凭据格式非法: {exc}") from exc
        if not isinstance(data, dict) or not isinstance(data.get("pairs"), list):
            raise CredentialRefError("credential_ref 引用的 JSON 需要 {pairs:[{username,password}]}")
        source = data["pairs"]
    elif "\n" in text or ":" in text:
        source = [
            {"username": line.split(":", 1)[0], "password": line.split(":", 1)[1]}
            if ":" in line else None
            for line in (item.strip() for item in text.splitlines())
            if line.strip()
        ]
    else:
        raise CredentialRefError(
            "credential_ref 引用内容无法解析：需要 JSON {pairs:[...]} 或 user:pass 行"
        )
    for item in source:
        if not isinstance(item, dict):
            continue
        username = str(item.get("username") or "").strip()
        password = str(item.get("password") or "")
        if username and password:
            pairs.append({"username": username, "password": password})
    if not pairs:
        raise CredentialRefError("credential_ref 引用中没有可用凭据对（username/password 均需非空）")
    if len(pairs) > MAX_ATTEMPTS_PER_CALL:
        raise CredentialRefError(
            f"单次验证凭据对超过上限 {MAX_ATTEMPTS_PER_CALL}；请拆分批次"
        )
    return pairs


class _FormDescriptor:
    __slots__ = ("action", "method", "fields", "password_field")

    def __init__(self, action: str, method: str, fields: list[tuple[str, str]], password_field: str) -> None:
        self.action = action
        self.method = method.upper()
        self.fields = fields
        self.password_field = password_field


_FORM_RE = re.compile(r"<form\b[^>]*>", re.IGNORECASE)
_INPUT_RE = re.compile(r"<input\b[^>]*>", re.IGNORECASE)


def _attr(tag: str, name: str) -> str:
    match = re.search(
        rf"{name}\s*=\s*[\"']([^\"']*)[\"']", tag, re.IGNORECASE,
    )
    return html.unescape(match.group(1)) if match else ""


def _parse_login_form(page_url: str, body_text: str) -> _FormDescriptor | None:
    """从页面解析疑似登录表单（含 password 输入的那个 form）。"""
    for form_match in _FORM_RE.finditer(body_text):
        end = body_text.find("</form>", form_match.end())
        segment = body_text[form_match.end(): end if end > 0 else len(body_text)]
        if len(segment) > 200_000:
            return None
        password_field = ""
        fields: list[tuple[str, str]] = []
        for input_tag in _INPUT_RE.findall(segment):
            input_type = _attr(input_tag, "type").casefold()
            name = _attr(input_tag, "name")
            if not name:
                continue
            if input_type == "password":
                password_field = name
            elif input_type in {"hidden", "text", "email"}:
                fields.append((name, _attr(input_tag, "value")))
        if not password_field:
            continue
        action = _attr(form_match.group(0), "action") or page_url
        method = _attr(form_match.group(0), "method") or "POST"
        return _FormDescriptor(
            action=urljoin(page_url, action), method=method,
            fields=fields, password_field=password_field,
        )
    return None


def _session_cookie_names(headers: dict[str, str]) -> set[str]:
    names: set[str] = set()
    for key, value in headers.items():
        if key.casefold() != "set-cookie":
            continue
        first = value.split(";", 1)[0]
        if "=" in first:
            name = first.split("=", 1)[0].strip()
            if re.search(r"(?i)(sess|token|auth|jsession|phpsess|asp\.net|remember)", name):
                names.add(name)
    return names


def _redact_password(text: str, password: str) -> str:
    if password and len(password) >= 2:
        text = text.replace(password, "[REDACTED]")
    # 兜底：URL/表单编码形态的口令也替换。
    from urllib.parse import quote

    quoted = quote(password, safe="")
    if quoted and quoted != password:
        text = text.replace(quoted, "[REDACTED]")
    return text


def verify_basic(
    target: str,
    pair: dict[str, str],
    *,
    fetcher: Callable[..., dict[str, Any]],
) -> dict[str, Any]:
    """HTTP Basic 验证：先匿名取 401 挑战，再带凭据重试。"""
    import base64

    anonymous = fetcher(target)
    if not anonymous.get("ok"):
        return {"outcome": "error", "error": str(anonymous.get("error") or ""), "evidence": anonymous}
    if anonymous.get("status") != 401:
        return {
            "outcome": "not_applicable",
            "error": f"目标未要求 Basic 认证（状态 {anonymous.get('status')}）",
            "evidence": anonymous,
        }
    token = base64.b64encode(
        f"{pair['username']}:{pair['password']}".encode("utf-8")
    ).decode("ascii")
    response = fetcher(
        target,
        headers={"Authorization": f"Basic {token}"},
        opener=NO_REDIRECT_OPENER,
    )
    if not response.get("ok"):
        return {"outcome": "error", "error": str(response.get("error") or ""), "evidence": response}
    verified = response.get("status") in range(200, 300)
    return {
        "outcome": "verified" if verified else "rejected",
        "status": response.get("status"),
        "evidence": response,
        "verification_predicate": (
            f"匿名请求 401 → Basic 凭据后 {response.get('status')}"
            if verified else
            f"Basic 凭据后仍 {response.get('status')}"
        ),
    }


def verify_form(
    target: str,
    pair: dict[str, str],
    *,
    fetcher: Callable[..., dict[str, Any]],
) -> dict[str, Any]:
    """表单登录验证：登录前后对照（会话 Cookie 变化 + 响应差异）。"""
    page = fetcher(target, opener=NO_REDIRECT_OPENER)
    if not page.get("ok"):
        return {"outcome": "error", "error": str(page.get("error") or ""), "evidence": page}
    body_text = (page.get("body") or b"").decode("utf-8", errors="replace")
    form = _parse_login_form(target, body_text)
    if form is None:
        return {
            "outcome": "not_applicable",
            "error": "页面没有可解析的登录表单（无 password 输入）",
            "evidence": page,
        }
    fields = dict(form.fields)
    fields[form.password_field] = pair["password"]
    username_field = next(
        (name for name in fields if name != form.password_field
         and re.search(r"(?i)(user|account|email|name|login)", name)),
        None,
    )
    if username_field:
        fields[username_field] = pair["username"]
    from urllib.parse import quote

    encoded = "&".join(
        f"{name}={quote(str(value), safe='')}"
        for name, value in fields.items()
    )
    method = "POST" if form.method in {"POST", ""} else form.method
    login = fetcher(
        form.action, method=method, body=encoded,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        opener=NO_REDIRECT_OPENER,
    )
    if not login.get("ok"):
        return {"outcome": "error", "error": str(login.get("error") or ""), "evidence": login}
    baseline_cookies = _session_cookie_names(page.get("headers") or {})
    login_cookies = _session_cookie_names(login.get("headers") or {})
    new_cookies = login_cookies - baseline_cookies
    location = next(
        (v for k, v in (login.get("headers") or {}).items() if k.casefold() == "location"), ""
    )
    redirects_off_login = bool(location) and "login" not in location.casefold() and "signin" not in location.casefold()
    login_body = (login.get("body") or b"").decode("utf-8", errors="replace")
    still_login_form = _parse_login_form(target, login_body) is not None
    verified = bool(new_cookies) and (redirects_off_login or not still_login_form)
    # 表单重现（无新会话 Cookie、无离开登录页的重定向）= 凭据被拒绝的
    # 正向证据；其余模糊情形（如未知错误页）按 unresolved 不下结论。
    rejected = (not new_cookies) and still_login_form and not location
    unresolved = not verified and not rejected
    return {
        "outcome": "verified" if verified else "rejected" if rejected else "unresolved",
        "status": login.get("status"),
        "new_session_cookies": sorted(new_cookies),
        "redirect": location,
        "evidence": login,
        "verification_predicate": (
            f"登录后会话 Cookie {sorted(new_cookies)} 建立"
            + ("且离开登录表单" if not still_login_form else "且重定向离开登录页" if redirects_off_login else "")
            if verified else
            "登录响应未建立新会话 Cookie 且登录表单重现，判定凭据无效"
            if rejected else
            "登录响应无法判定（无新会话 Cookie 且表单/跳转形态不明确，unresolved）"
        ),
    }


def run_credential_check(
    store,
    arguments: dict[str, Any],
    *,
    resolve_secret: Callable[[str], str | None],
    cancel_check: Callable[[], bool] | None = None,
    fetcher: Callable[..., dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """执行口令验证（真实 HTTP 请求；凭据经引用解析，不落日志）。"""
    from .batch_state import ScanBatch, arguments_digest

    cancel = cancel_check or (lambda: False)
    fetch = fetcher or fetch_url
    targets = [
        str(item).strip() for item in (arguments.get("targets") or [])
        if str(item).strip()
    ]
    if not targets:
        raise CredentialCheckError("pwd_crack 需要至少一个目标（targets: string[]）")
    if len(targets) > MAX_TARGETS_PER_CALL:
        raise CredentialCheckError(
            f"单次验证目标数超过上限 {MAX_TARGETS_PER_CALL}；请拆分批处理"
        )
    for target in targets:
        parsed = urlparse(target if "://" in target else f"http://{target}")
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise CredentialCheckError(f"目标必须是 http(s) URL: {target}")
    credential_ref = str(arguments.get("credential_ref") or "").strip()
    if not credential_ref:
        raise CredentialRefError(
            "pwd_crack 必须提供 credential_ref（凭据引用）；不接受明文口令参数"
        )
    secret = resolve_secret(credential_ref)
    if not secret:
        raise CredentialRefError(
            f"credential_ref {credential_ref} 不存在或未配置秘密；"
            "请先在秘密存储登记凭据引用，不做任何尝试。"
        )
    pairs = parse_credential_payload(secret)

    digest = arguments_digest(
        "pwd_crack", {"targets": targets, "credential_ref": credential_ref,
                      "pair_count": len(pairs), "usernames": sorted(p["username"] for p in pairs)},
    )
    batch = ScanBatch(store, "pwd_crack", digest, [
        f"{target}|{pair['username']}" for target in targets for pair in pairs
    ])
    batch.begin_run(f"pwd_crack targets={len(targets)} pairs={len(pairs)}")
    # 有副作用动作：unknown_outcome 不自动重试（§8.3），只继续 pending。
    remaining = [key for key in batch.record["targets"] if batch.status_of(key) == "pending"]

    results: list[dict[str, Any]] = []
    verified_any = False
    interrupted = False
    for key in remaining:
        if cancel():
            interrupted = True
            break
        if verified_any:
            break  # 命中后停止：同一组合/目标不重复尝试
        target, username = key.split("|", 1)
        pair = next(p for p in pairs if p["username"] == username)
        batch.mark(key, "running")
        verify_method = "form"
        try:
            basic = verify_basic(target, pair, fetcher=fetch)
            if basic["outcome"] == "not_applicable":
                combined = verify_form(target, pair, fetcher=fetch)
            else:
                combined = basic
                verify_method = "basic"
        except Exception as exc:  # noqa: BLE001 —— 单组合失败不影响批次
            if cancel():
                # 请求因取消而中断：登录尝试是否已发出不明 → unknown_outcome，
                # 且不自动重试（§8.3 副作用动作审慎恢复）。
                batch.note_interrupted([key])
                interrupted = True
                break
            combined = {"outcome": "error", "error": f"{type(exc).__name__}: {exc}"}
        outcome = str(combined.get("outcome") or "error")
        # 证据：请求/响应摘要（口令脱敏）。响应体只留前 2KB。
        response = combined.get("evidence") or {}
        transcript = json.dumps({
            "target": target,
            "username": username,
            "password": "[REDACTED]",
            "method": verify_method,
            "outcome": outcome,
            "verification_predicate": combined.get("verification_predicate"),
            "request_status": response.get("status"),
            "response_headers": {
                k: v for k, v in (response.get("headers") or {}).items()
                if k.casefold() in {"location", "content-type", "set-cookie", "www-authenticate"}
            },
            "response_body_head": _redact_password(
                (response.get("body") or b"")[:2048].decode("utf-8", errors="replace"),
                pair["password"],
            ),
        }, ensure_ascii=False, indent=1)
        stem = f"cred-{hashlib.sha256(key.encode()).hexdigest()[:12]}.json"
        evidence_root = store.path / "evidence" / "cred"
        evidence_root.mkdir(parents=True, exist_ok=True)
        payload_bytes = transcript.encode("utf-8", errors="replace")
        evidence_digest = hashlib.sha256(payload_bytes).hexdigest()
        evidence_file = evidence_root / f"{evidence_digest}.{stem}"
        if not evidence_file.exists():
            evidence_file.write_bytes(payload_bytes)
        evidence_file.with_name(evidence_file.name + ".sha256").write_text(
            f"{evidence_digest}  {evidence_file.name}\n", encoding="utf-8",
        )
        outcome_record = {
            "target": target,
            "username": username,
            "outcome": outcome,
            "status": combined.get("status"),
            "verification_predicate": combined.get("verification_predicate"),
            "evidence_path": f"evidence/cred/{evidence_file.name}",
        }
        del pair  # 口令引用在此之后不再使用
        results.append(outcome_record)
        if outcome == "verified":
            verified_any = True
            batch.mark(key, "completed", {"outcome": "verified"})
        elif outcome == "error":
            batch.mark(key, "failed", {"error": str(combined.get("error") or "")[:200]})
        else:
            batch.mark(key, "completed", {"outcome": outcome})
        time.sleep(ATTEMPT_INTERVAL_SECONDS)

    if interrupted:
        running = [k for k in batch.record["targets"] if batch.status_of(k) == "running"]
        for key in running:
            # 登录尝试是否已发出不明：标记 unknown_outcome 且不自动重试。
            batch.record["targets"][key] = "unknown_outcome"
        batch.save()

    return {
        "engine": "sorne-native-credential-check",
        "engine_version": "1",
        "parser_version": "v1",
        "targets": targets,
        "credential_ref": credential_ref,
        "pair_count": len(pairs),
        "results": results,
        "verified": [r for r in results if r["outcome"] == "verified"],
        "verified_count": sum(1 for r in results if r["outcome"] == "verified"),
        "no_hit": not any(r["outcome"] == "verified" for r in results),
        "batch": batch.summary(),
        "cancelled": interrupted,
        "note": (
            "命中仅为候选（risk_lead 由 Guardian 复核决定升级）；凭据本体只在秘密"
            "存储中，证据/记录里口令已脱敏。unknown_outcome 的组合不会自动重试。"
        ),
    }
