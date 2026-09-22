from __future__ import annotations

import hashlib
import json
import re
import time
from collections import deque
from dataclasses import dataclass
from html.parser import HTMLParser
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qsl, urljoin, urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from .schemas import new_id, now_iso
from .store import ProjectStore
from .target_profile import canonical_target_url, record_target_profile


UA = "Mozilla/5.0 (compatible; AgentCP-mrecon/1.0; authorized-security-research)"
STATIC_EXTENSIONS = {
    ".css", ".js", ".png", ".jpg", ".jpeg", ".gif", ".ico", ".svg",
    ".webp", ".woff", ".woff2", ".ttf", ".eot", ".mp4", ".mp3",
}
DANGEROUS_CLICK_WORDS = (
    "logout", "signout", "delete", "remove", "disable", "revoke", "submit",
    "save", "update", "confirm", "transfer", "pay", "退出", "注销", "删除",
    "提交", "保存", "修改", "确认", "转账", "支付", "重置密码",
)


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        return None


class _SurfaceParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.links: list[str] = []
        self.forms: list[dict[str, Any]] = []
        self.scripts: list[str] = []
        self._form: dict[str, Any] | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = {key.casefold(): value or "" for key, value in attrs}
        lowered = tag.casefold()
        if lowered in {"a", "iframe", "link"}:
            value = values.get("href") or values.get("src")
            if value:
                self.links.append(value)
        if lowered == "script" and values.get("src"):
            self.scripts.append(values["src"])
        if lowered == "form":
            self._form = {
                "action": values.get("action", ""),
                "method": values.get("method", "GET").upper(),
                "parameters": [],
            }
            self.forms.append(self._form)
        elif lowered in {"input", "select", "textarea"} and self._form is not None:
            name = values.get("name", "").strip()
            if name:
                self._form["parameters"].append(name[:160])

    def handle_endtag(self, tag: str) -> None:
        if tag.casefold() == "form":
            self._form = None


@dataclass(frozen=True)
class MReconPolicy:
    max_pages: int = 300
    timeout_seconds: int = 20
    delay_seconds: float = 0.1
    max_body_bytes: int = 512 * 1024
    save_body_bytes: int = 64 * 1024
    max_js_files: int = 30
    max_js_bytes: int = 8 * 1024 * 1024
    browser_pages: int = 8
    browser_clicks: int = 10


def _script_surfaces(
    opener: Any,
    scripts: list[str],
    *,
    base_url: str,
    hosts: set[str],
    policy: MReconPolicy,
) -> list[dict[str, Any]]:
    """Extract SPA routes/APIs from bundles without putting bundle text in context."""

    api_patterns = (
        r'["\']((?:/gw/|/portal/|/usercenter/|/w/|/sso/|/api/)[A-Za-z0-9_/.-]+\.(?:do|view|action|json))["\']',
        r'["\'](/[A-Za-z0-9_/.-]+\.(?:do|view|action|json))["\']',
        r'(?:url|action)\s*:\s*["\']((?:/)?[A-Za-z0-9_/.-]+\.(?:do|view|action|json))["\']',
    )
    route_pattern = re.compile(r'path\s*:\s*["\']([^"\']+)["\']')
    found: dict[str, dict[str, Any]] = {}
    for raw in list(dict.fromkeys(scripts))[:policy.max_js_files]:
        script_url = urljoin(base_url, raw)
        if not _in_scope(script_url, hosts):
            continue
        try:
            response = opener.open(Request(script_url, headers={"User-Agent": UA}), timeout=policy.timeout_seconds)
            data = response.read(policy.max_js_bytes + 1)
            if len(data) > policy.max_js_bytes:
                continue
            source = data.decode("utf-8", errors="replace")
        except (HTTPError, OSError, URLError, ValueError):
            continue
        candidates: set[str] = set()
        for pattern in api_patterns:
            candidates.update(match.group(1) for match in re.finditer(pattern, source))
        for match in route_pattern.finditer(source):
            route = match.group(1)
            if route.startswith("/") and not route.startswith("//") and "." not in route.rsplit("/", 1)[-1]:
                candidates.add(route)
        for candidate in candidates:
            url = urljoin(base_url, candidate if candidate.startswith("/") else f"/{candidate}")
            try:
                url = canonical_target_url(url)
            except ValueError:
                continue
            if _in_scope(url, hosts) and not _static(url):
                found[url] = {
                    "url": url,
                    "method": "UNKNOWN",
                    "status": None,
                    "parameter_names": _parameter_names(url),
                    "function": _function_label(url),
                    "source": "js_bundle",
                    "discovered_from": script_url,
                }
    return list(found.values())


def _browser_surfaces(
    seeds: list[str],
    *,
    hosts: set[str],
    policy: MReconPolicy,
) -> tuple[list[dict[str, Any]], str | None]:
    """Capture rendered DOM and XHR/fetch metadata when Playwright is available."""

    if policy.browser_pages <= 0:
        return [], None
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        return [], "playwright_not_installed"

    captured: dict[tuple[str, str], dict[str, Any]] = {}
    error: str | None = None
    try:
        with sync_playwright() as playwright:
            try:
                browser = playwright.chromium.launch(
                    channel="chrome", headless=True, args=["--no-sandbox"],
                )
            except Exception:
                # Windows 发行包安装 Playwright Chromium 即可运行，不强制用户另装 Chrome。
                browser = playwright.chromium.launch(headless=True, args=["--no-sandbox"])
            context = browser.new_context(
                user_agent=UA, viewport={"width": 1440, "height": 900}, ignore_https_errors=True,
            )
            page = context.new_page()
            page.set_default_timeout(policy.timeout_seconds * 1000)
            source_page = [""]

            def on_response(response: Any) -> None:
                request = response.request
                if request.resource_type not in {"xhr", "fetch"} or not _in_scope(response.url, hosts):
                    return
                try:
                    url = canonical_target_url(response.url)
                except ValueError:
                    return
                method = str(request.method or "GET").upper()
                captured[(method, url)] = {
                    "url": url,
                    "method": method,
                    "status": int(response.status),
                    "content_type": str(response.headers.get("content-type") or "")[:200],
                    "response_size": None,
                    "parameter_names": _parameter_names(response.url, request.post_data or ""),
                    "function": _function_label(url),
                    "technology_stack": [],
                    "source": "browser_xhr",
                    "discovered_from": source_page[0],
                }

            page.on("response", on_response)
            for seed in list(dict.fromkeys(seeds))[:policy.browser_pages]:
                source_page[0] = seed
                try:
                    page.goto(seed, wait_until="domcontentloaded", timeout=policy.timeout_seconds * 1000)
                    page.wait_for_timeout(1200)
                    for href in page.eval_on_selector_all("a,iframe", "els => els.map(e => e.href || e.src)"):
                        try:
                            url = canonical_target_url(str(href))
                        except ValueError:
                            continue
                        if _in_scope(url, hosts) and not _static(url):
                            captured.setdefault(("GET", url), {
                                "url": url, "method": "GET", "status": None,
                                "parameter_names": _parameter_names(url),
                                "function": _function_label(url), "technology_stack": [],
                                "source": "browser_dom", "discovered_from": seed,
                            })
                    clicked = 0
                    for element in page.query_selector_all("a[href], button, [onclick]"):
                        if clicked >= policy.browser_clicks:
                            break
                        try:
                            text = " ".join(filter(None, (
                                element.get_attribute("href"), element.get_attribute("onclick"),
                                element.get_attribute("class"), (element.inner_text() or "")[:80],
                            ))).casefold()
                            if any(word in text for word in DANGEROUS_CLICK_WORDS):
                                continue
                            if element.evaluate("e => !!e.closest('form')"):
                                continue
                            element.click(timeout=3000)
                            page.wait_for_timeout(700)
                            clicked += 1
                        except Exception:
                            continue
                except Exception:
                    continue
            browser.close()
    except Exception as exc:
        error = f"{type(exc).__name__}: {exc}"[:500]
    return list(captured.values()), error


def _scope_hosts(seed: str, configured: list[str] | None) -> set[str]:
    values = configured or []
    result = {
        str(urlsplit(value if "://" in value else f"https://{value}").netloc).casefold()
        for value in values if str(value).strip()
    }
    if urlsplit(seed).netloc:
        result.add(urlsplit(seed).netloc.casefold())
    return {item for item in result if item}


def normalize_mrecon_seed(value: str) -> str:
    raw = str(value or "").strip()
    return canonical_target_url(raw if "://" in raw else f"https://{raw}")


def _in_scope(url: str, hosts: set[str]) -> bool:
    try:
        return urlsplit(url).netloc.casefold() in hosts
    except ValueError:
        return False


def _static(url: str) -> bool:
    path = urlsplit(url).path.casefold()
    return any(path.endswith(item) for item in STATIC_EXTENSIONS)


def _function_label(url: str, *, form: bool = False) -> str:
    path = urlsplit(url).path.casefold()
    rules = (
        (("upload", "import"), "文件上传/导入接口"),
        (("download", "export"), "文件下载/导出接口"),
        (("admin", "manage", "console"), "后台管理入口"),
        (("login", "signin", "sso"), "用户认证入口"),
        (("password", "reset", "forgot"), "密码重置功能"),
        (("user", "account", "member"), "用户/账户功能"),
        (("order", "trade", "payment", "pay"), "订单/交易功能"),
        (("search", "query", "list"), "查询/列表接口"),
        (("news", "article", "notice"), "常规网络信息"),
    )
    for markers, label in rules:
        if any(marker in path for marker in markers):
            return label
    if form:
        return "表单提交接口"
    return "页面/接口"


def _observation_kind(source: str, status: object) -> str:
    """Classify how an entry came to be known.

    - ``requested``: the URL was actually fetched and a status was observed
      (http_crawl / browser_xhr).
    - ``inferred``: the entry was extracted from bundle or page text; it was
      never requested (js_bundle).
    - ``observed_not_requested``: the entry was seen verbatim in real content
      (a link, a form, rendered DOM) but its endpoint was not exercised.
    """
    if source == "js_bundle":
        return "inferred"
    if source in {"http_crawl", "browser_xhr"}:
        return "requested"
    return "observed_not_requested"


def _fingerprints(headers: dict[str, str], body: str) -> list[str]:
    haystack = " ".join([*headers.values(), body[:40_000]]).casefold()
    rules = (
        ("nginx", "Nginx"), ("apache", "Apache"), ("tomcat", "Tomcat"),
        ("weblogic", "WebLogic"), ("spring", "Spring"), ("asp.net", "ASP.NET"),
        ("jquery", "jQuery"), ("vue", "Vue"), ("react", "React"),
        ("angular", "Angular"), ("wordpress", "WordPress"),
    )
    return [label for marker, label in rules if marker in haystack]


def _parameter_names(url: str, body: str = "") -> list[str]:
    names = {key for key, _value in parse_qsl(urlsplit(url).query, keep_blank_values=True)}
    if body:
        try:
            parsed = json.loads(body)
        except (TypeError, ValueError):
            parsed = None
        if isinstance(parsed, dict):
            names.update(str(key) for key in parsed)
        else:
            names.update(key for key, _value in parse_qsl(body, keep_blank_values=True))
    return sorted(item[:160] for item in names if item)[:80]


def _save_http_evidence(
    store: ProjectStore,
    *,
    url: str,
    status: int,
    headers: dict[str, str],
    body: bytes,
    policy: MReconPolicy,
) -> str:
    """Persist a bounded HTTP transcript outside prompts and blackboard text."""

    parsed = urlsplit(url)
    request_target = urlunsplit(("", "", parsed.path or "/", parsed.query, ""))
    response_headers = "\r\n".join(f"{key}: {value}" for key, value in headers.items())
    truncated = len(body) > policy.save_body_bytes
    transcript_head = (
        f"GET {request_target} HTTP/1.1\r\n"
        f"Host: {parsed.netloc}\r\n"
        f"User-Agent: {UA}\r\n\r\n"
        f"HTTP/1.1 {status}\r\n{response_headers}\r\n"
        f"X-AgentCP-Body-Truncated: {'true' if truncated else 'false'}\r\n\r\n"
    ).encode("utf-8", errors="replace")
    transcript = transcript_head + body[:policy.save_body_bytes]
    digest = hashlib.sha256(transcript).hexdigest()
    relative = Path("evidence") / "mrecon" / f"{digest}.http"
    destination = store.path / relative
    if not destination.exists():
        destination.write_bytes(transcript)
    return str(relative)


def collect_mrecon(
    store: ProjectStore,
    seed_url: str,
    *,
    scope: list[str] | None = None,
    policy: MReconPolicy | None = None,
    proposed_by: str = "mrecon",
) -> list[dict[str, Any]]:
    """Run the embedded deterministic HTTP collector and persist compact observations.

    Large response bodies are kept outside model context under evidence/mrecon. The
    blackboard receives only compact URL/function/technology/request metadata.
    """

    policy = policy or MReconPolicy()
    seed = normalize_mrecon_seed(seed_url)
    hosts = _scope_hosts(seed, scope)
    opener = build_opener(_NoRedirect())
    queue: deque[str] = deque([seed])
    seen: set[str] = set()
    observations: list[dict[str, Any]] = []
    profile_rows: list[dict[str, Any]] = []
    evidence_dir = store.path / "evidence" / "mrecon"
    evidence_dir.mkdir(parents=True, exist_ok=True)

    while queue and len(seen) < max(1, policy.max_pages):
        url = queue.popleft()
        if url in seen or not _in_scope(url, hosts) or _static(url):
            continue
        seen.add(url)
        status = 0
        headers: dict[str, str] = {}
        body_bytes = b""
        final_url = url
        error = ""
        try:
            request = Request(url, headers={"User-Agent": UA})
            try:
                response = opener.open(request, timeout=policy.timeout_seconds)
            except HTTPError as exc:
                response = exc
            status = int(getattr(response, "status", getattr(response, "code", 0)) or 0)
            headers = {str(key): str(value) for key, value in response.headers.items()}
            location = headers.get("Location") or headers.get("location")
            if status in {301, 302, 303, 307, 308} and location:
                candidate = urljoin(url, location)
                if _in_scope(candidate, hosts) and candidate not in seen:
                    queue.appendleft(candidate)
            final_url = str(getattr(response, "url", url) or url)
            body_bytes = response.read(policy.max_body_bytes + 1)[:policy.max_body_bytes]
        except (OSError, URLError, ValueError) as exc:
            error = f"{type(exc).__name__}: {exc}"[:500]

        content_type = headers.get("Content-Type", headers.get("content-type", ""))
        body = body_bytes.decode("utf-8", errors="replace") if body_bytes else ""
        technologies = _fingerprints(headers, body)
        evidence_ref = ""
        if body_bytes or headers:
            evidence_ref = _save_http_evidence(
                store, url=url, status=status, headers=headers, body=body_bytes, policy=policy,
            )

        observation = {
            "id": new_id("MR"),
            "url": url,
            "final_url": final_url,
            "method": "GET",
            "status": status,
            "observation_kind": _observation_kind("http_crawl", status),
            "content_type": content_type[:200],
            "response_size": len(body_bytes),
            "parameter_names": _parameter_names(url),
            "function": _function_label(url),
            "technology_stack": technologies,
            "source": "http_crawl",
            "evidence_ref": evidence_ref,
            "error": error,
            "observed_at": now_iso(),
        }
        store.append_jsonl("mrecon_observations.jsonl", observation)
        observations.append(observation)
        profile_rows.append({
            "url": url,
            "function": observation["function"],
            "technology_stack": technologies,
        })

        if "html" in content_type.casefold() and status == 200:
            parser = _SurfaceParser()
            try:
                parser.feed(body)
            except Exception:
                parser = _SurfaceParser()
            for surface in _script_surfaces(
                opener, parser.scripts, base_url=final_url, hosts=hosts, policy=policy,
            ):
                surface_observation = {
                    "id": new_id("MR"), **surface,
                    "observation_kind": _observation_kind(str(surface.get("source") or ""), None),
                    "final_url": surface["url"],
                    "content_type": "", "response_size": None,
                    "technology_stack": technologies,
                    "evidence_ref": evidence_ref, "error": "", "observed_at": now_iso(),
                }
                store.append_jsonl("mrecon_observations.jsonl", surface_observation)
                observations.append(surface_observation)
                profile_rows.append({
                    "url": surface["url"],
                    "function": surface["function"],
                    "technology_stack": technologies,
                })
            for raw_link in [*parser.links, *parser.scripts]:
                candidate = urljoin(final_url, raw_link)
                try:
                    candidate = canonical_target_url(candidate)
                except ValueError:
                    continue
                if _in_scope(candidate, hosts) and candidate not in seen and not _static(candidate):
                    queue.append(candidate)
            for form in parser.forms:
                action = urljoin(final_url, str(form.get("action") or final_url))
                try:
                    action = canonical_target_url(action)
                except ValueError:
                    continue
                if not _in_scope(action, hosts):
                    continue
                form_observation = {
                    "id": new_id("MR"),
                    "url": action,
                    "final_url": action,
                    "method": str(form.get("method") or "GET"),
                    "status": None,
                    "observation_kind": _observation_kind("html_form", None),
                    "content_type": "",
                    "response_size": None,
                    "parameter_names": list(dict.fromkeys(form.get("parameters") or []))[:80],
                    "function": _function_label(action, form=True),
                    "technology_stack": technologies,
                    "source": "html_form",
                    "discovered_from": url,
                    "evidence_ref": evidence_ref,
                    "error": "",
                    "observed_at": now_iso(),
                }
                store.append_jsonl("mrecon_observations.jsonl", form_observation)
                observations.append(form_observation)
                profile_rows.append({
                    "url": action,
                    "function": form_observation["function"],
                    "technology_stack": technologies,
                })
                if action not in seen:
                    queue.append(action)
        if policy.delay_seconds:
            time.sleep(max(0.0, policy.delay_seconds))

    browser_seeds = [seed, *(str(item.get("url") or "") for item in profile_rows)]
    browser_rows, browser_error = _browser_surfaces(browser_seeds, hosts=hosts, policy=policy)
    for surface in browser_rows:
        browser_observation = {
            "id": new_id("MR"), **surface,
            "observation_kind": _observation_kind(
                str(surface.get("source") or ""), surface.get("status"),
            ),
            "final_url": surface["url"],
            "content_type": surface.get("content_type", ""),
            "response_size": surface.get("response_size"),
            "evidence_ref": "", "error": "", "observed_at": now_iso(),
        }
        store.append_jsonl("mrecon_observations.jsonl", browser_observation)
        observations.append(browser_observation)
        profile_rows.append({
            "url": surface["url"],
            "function": surface["function"],
            "technology_stack": surface.get("technology_stack") or [],
        })

    record_target_profile(store, profile_rows, proposed_by=proposed_by)
    store.append_jsonl("mrecon_runs.jsonl", {
        "id": new_id("MRRUN"),
        "seed_url": seed,
        "scope": sorted(hosts),
        "observation_count": len(observations),
        "page_count": len(seen),
        "browser_observation_count": len(browser_rows),
        "browser_error": browser_error,
        "completed_at": now_iso(),
    })
    return observations


def compact_mrecon_rows(store: ProjectStore, urls: list[str] | None = None) -> list[dict[str, Any]]:
    """Return compact mrecon observations, sorted by URL only.

    Scoring and classification are the profile_mapper AI's responsibility;
    this function stays deterministic and neutral — it collects facts, not
    judgments.
    """

    allowed = {canonical_target_url(value) for value in urls or []} if urls else None
    result: list[dict[str, Any]] = []
    for row in store.read_jsonl("mrecon_observations.jsonl"):
        try:
            url = canonical_target_url(str(row.get("url") or ""))
        except ValueError:
            continue
        if allowed is not None and url not in allowed:
            continue
        result.append({
            key: row.get(key)
            for key in (
                "id", "url", "method", "status", "content_type", "response_size",
                "parameter_names", "function", "technology_stack", "source",
                "observation_kind", "discovered_from", "evidence_ref",
            )
            if row.get(key) not in (None, "", [], {})
        })
    return sorted(result, key=lambda item: str(item.get("url") or ""))
