"""nuclei 组件验证适配器（实施方案 §6.5-6.6、§12-P2）。

真实执行路径：``docker run``（固定 argv，无 shell 拼接）拉起
``projectdiscovery/nuclei`` 镜像，``-json -irr`` 输出 JSONL（含每条命中的
请求/响应），适配层解析为结构化命中并把原始输出与逐命中请求/响应证据
落盘到 ``evidence/poc/``（sha256 边车）。取消走进程树终止（cancellable_process）。

运行可用性 = Docker 守护进程可达 ∧ 镜像本地存在。任一不满足时网关得到
``capability_missing``（带缺口说明）——不做固定返回成功的假适配。
镜像标签需在实施环境预取后固定（``NUCLEI_IMAGE`` 常量 / 环境变量
``SORNE_NUCLEI_IMAGE`` 覆盖；本环境无外网，未预取镜像即如实报缺口）。
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Callable, Iterable

from ..cancellable_process import (
    ProcessCancelled,
    ProcessTimeout,
    run_cancellable_process,
)
from ..docker_command import docker_base_args

# 默认镜像引用：官方镜像仓库名；具体标签以部署环境预取并固定为准。
# 不假设某版本参数稳定（方案 §6.6 尾注）；版本探测结果随每次扫描记录。
DEFAULT_IMAGE = "projectdiscovery/nuclei:latest"
AVAILABILITY_CACHE_SECONDS = 15.0

# 工具描述符（方案 §6.5；镜像摘要与版本在运行环境核实后回填 recorded_* 字段）
DESCRIPTOR: dict[str, Any] = {
    "id": "nuclei-adapter",
    "name": "组件验证引擎",
    "version": "1",
    "capabilities": ["poc_scan"],
    "runtime": "local-docker",
    "parser_version": "v1",
    "image_ref_env": "SORNE_NUCLEI_IMAGE",
    "entrypoint": ["docker", "run", *docker_base_args(network="host")],
    "resource_class": "component_scan",
    "cancellation": "process_group",
    "resume_strategy": "adapter_defined",
    "source": "projectdiscovery/nuclei（官方镜像仓库）",
    "license": "以镜像仓库随行许可证为准（实施环境核实后登记）",
}

MAX_TARGETS_PER_SCAN = 32
SCAN_TIMEOUT_SECONDS = 600


class NucleiUnavailable(RuntimeError):
    """运行环境不满足（Docker/镜像缺失）——capability_missing 语义。"""


class NucleiExecutionError(RuntimeError):
    """引擎已运行但执行失败（非零退出且无可用输出）。"""


def image_ref() -> str:
    return str(os.environ.get("SORNE_NUCLEI_IMAGE") or DEFAULT_IMAGE).strip() or DEFAULT_IMAGE


_availability_cache: dict[str, Any] = {"at": 0.0, "value": None}
_availability_lock = threading.Lock()


def reset_availability_cache() -> None:
    with _availability_lock:
        _availability_cache["at"] = 0.0
        _availability_cache["value"] = None


def _docker_available() -> tuple[bool, str]:
    try:
        probe = subprocess.run(
            ["docker", "version", "--format", "{{.Server.Version}}"],
            capture_output=True, text=True, timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return False, f"Docker 守护进程不可达: {exc}"
    if probe.returncode != 0:
        return False, f"Docker 守护进程不可用: {probe.stderr.strip()[:200]}"
    return True, ""


def _image_present(ref: str) -> tuple[bool, str]:
    try:
        probe = subprocess.run(
            ["docker", "image", "inspect", ref],
            capture_output=True, text=True, timeout=15,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return False, f"镜像检查失败: {exc}"
    if probe.returncode != 0:
        return False, (
            f"镜像 {ref} 不在本地（先 docker pull 预取；"
            "未预取即如实报缺口，不做假扫描）"
        )
    return True, ""


def availability_status() -> tuple[bool, str]:
    """(available, reason)。带短 TTL 缓存，探测失败按不可用处理。"""
    now = time.monotonic()
    with _availability_lock:
        cached = _availability_cache["value"]
        if cached is not None and now - float(_availability_cache["at"]) < AVAILABILITY_CACHE_SECONDS:
            return cached
    docker_ok, docker_reason = _docker_available()
    if not docker_ok:
        value = (False, docker_reason)
    else:
        image_ok, image_reason = _image_present(image_ref())
        value = (image_ok, image_reason if not image_ok else "")
    with _availability_lock:
        _availability_cache["at"] = now
        _availability_cache["value"] = value
    return value


def describe_status() -> dict[str, Any]:
    available, reason = availability_status()
    return {
        "adapter": DESCRIPTOR["id"],
        "image_ref": image_ref(),
        "available": available,
        "reason": reason,
    }


def engine_version() -> str | None:
    """镜像内 nuclei 版本（缓存到进程内；失败返回 None，不阻断扫描）。"""
    cached = _engine_version_cache.get("value")
    if cached is not None:
        return cached
    try:
        probe = subprocess.run(
            ["docker", "run", "--rm", image_ref(), "-version"],
            capture_output=True, text=True, timeout=60,
        )
        if probe.returncode == 0:
            for line in (probe.stdout or "").splitlines():
                if "nuclei" in line.casefold():
                    _engine_version_cache["value"] = line.strip()[:200]
                    return _engine_version_cache["value"]
    except (OSError, subprocess.TimeoutExpired):
        pass
    return None


_engine_version_cache: dict[str, Any] = {"value": None}


def _decode_http_block(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        return json.dumps(value, ensure_ascii=False)
    return str(value)


def _maybe_base64(text: str) -> str:
    """nuclei 部分版本把 request/response 以 base64 输出；尝试解码。"""
    stripped = text.strip()
    if not stripped or len(stripped) % 4 != 0:
        return text
    try:
        decoded = base64.b64decode(stripped, validate=True).decode("utf-8")
    except Exception:  # noqa: BLE001 —— 非 base64 内容原样返回
        return text
    # 只有解码结果看起来像 HTTP 传输时才替换，避免误伤普通文本
    if "\r\n" in decoded or decoded.startswith(("GET ", "POST ", "HTTP/")):
        return decoded
    return text


def parse_nuclei_jsonl(lines: Iterable[str]) -> list[dict[str, Any]]:
    """解析 nuclei ``-json`` 输出为结构化命中（纯函数，供夹具测试）。

    ``-irr``（include request/response）时每条命中带 request/response 原文，
    适配层将其写入逐命中证据文件；这里只做归一化，不判真伪——命中与
    “证据实际支持”的区分是研判层与复核的职责（方案 §6.6-2）。
    """
    hits: list[dict[str, Any]] = []
    for line in lines:
        text = str(line or "").strip()
        if not text or not text.startswith("{"):
            continue
        try:
            raw = json.loads(text)
        except json.JSONDecodeError:
            continue
        if not isinstance(raw, dict):
            continue
        info = raw.get("info") if isinstance(raw.get("info"), dict) else {}
        request = _maybe_base64(_decode_http_block(raw.get("request")))
        response = _maybe_base64(_decode_http_block(raw.get("response")))
        hits.append({
            "template_id": str(raw.get("template-id") or raw.get("templateID") or ""),
            "template_name": str(info.get("name") or ""),
            "severity": str(info.get("severity") or "unknown"),
            "description": str(info.get("description") or "")[:500],
            "references": [str(item) for item in (info.get("reference") or [])][:8],
            "type": str(raw.get("type") or ""),
            "host": str(raw.get("host") or ""),
            "matched_at": str(raw.get("matched-at") or raw.get("matched") or ""),
            "matcher_name": str(raw.get("matcher-name") or raw.get("matcher_status") or ""),
            "matcher_status": bool(raw.get("matcher-status") or raw.get("matcher_status")),
            "extracted_results": [
                str(item) for item in (raw.get("extracted-results") or [])[:20]
            ],
            "curl_command": str(raw.get("curl-command") or "")[:1000],
            "request": request[:60_000],
            "response": response[:120_000],
            "timestamp": str(raw.get("timestamp") or ""),
        })
    return hits


def _write_evidence_file(destination: Path, payload: bytes) -> str:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if not destination.exists():
        destination.write_bytes(payload)
    digest = hashlib.sha256(payload).hexdigest()
    destination.with_name(destination.name + ".sha256").write_text(
        f"{digest}  {destination.name}\n", encoding="utf-8",
    )
    return destination.name


def _write_hit_evidence(
    evidence_root: Path,
    index: int,
    hit: dict[str, Any],
    run_header: str,
) -> str:
    blocks = [run_header.rstrip()]
    if hit.get("request"):
        blocks.append("# request\r\n" + hit["request"].rstrip())
    if hit.get("response"):
        blocks.append("# response\r\n" + hit["response"].rstrip())
    transcript = ("\r\n\r\n".join(blocks) + "\r\n").encode("utf-8", errors="replace")
    digest = hashlib.sha256(transcript).hexdigest()
    name = _write_evidence_file(evidence_root / f"{digest}.hit-{index}.http", transcript)
    # 返回相对项目根的路径（evidence/<subdir>/<file>）
    return f"{evidence_root.parent.name}/{evidence_root.name}/{name}"


def _build_argv(
    *,
    targets: list[str],
    template_ids: list[str],
    templates_dir: Path | None,
) -> list[str]:
    args = ["docker", *docker_base_args(network="host")]
    if templates_dir is not None and templates_dir.is_dir():
        args.extend(["-v", f"{templates_dir.resolve()}:/templates:ro"])
    args.append(image_ref())
    args.extend(["-json", "-irr", "-silent", "-duc", "-nb"])
    if templates_dir is not None and templates_dir.is_dir():
        args.extend(["-t", "/templates"])
    for template_id in template_ids:
        args.extend(["-t", str(template_id)])
    for target in targets:
        args.extend(["-u", str(target)])
    return args


def run_scan(
    store,
    arguments: dict[str, Any],
    *,
    cancel_check: Callable[[], bool] | None = None,
    timeout_seconds: int = SCAN_TIMEOUT_SECONDS,
    evidence_subdir: str = "poc",
    runner: Callable[..., Any] | None = None,
) -> dict[str, Any]:
    """执行一次组件验证扫描并落盘证据。

    ``runner`` 仅用于测试注入（替换子进程执行函数注入真实 nuclei JSONL
    样本）；生产路径为 None → 真实 docker 执行。
    """
    targets = [
        str(item).strip() for item in (arguments.get("targets") or []) if str(item).strip()
    ]
    template_ids = [
        str(item).strip() for item in (arguments.get("template_ids") or []) if str(item).strip()
    ]
    if not targets:
        raise NucleiExecutionError("poc_scan 需要至少一个目标（targets: string[]）")
    if len(targets) > MAX_TARGETS_PER_SCAN:
        raise NucleiExecutionError(
            f"单次扫描目标数超过上限 {MAX_TARGETS_PER_SCAN}；请拆分批处理"
        )
    available, reason = availability_status()
    if not available and runner is None:
        raise NucleiUnavailable(
            f"capability_missing: nuclei 运行环境不可用（{reason}）；"
            "扫描未执行，不得以其他结果冒充。"
        )

    evidence_root = store.path / "evidence" / evidence_subdir
    templates_dir = store.path / ".sorne-work" / "nuclei-templates"
    argv = _build_argv(
        targets=targets, template_ids=template_ids,
        templates_dir=templates_dir if templates_dir.is_dir() else None,
    )
    run_header = (
        "# Sorne poc_scan (nuclei adapter)\n"
        f"# image: {image_ref()}\n"
        f"# argv: {json.dumps(argv, ensure_ascii=False)}\n"
        f"# targets: {', '.join(targets)}\n"
        f"# templates: {', '.join(template_ids) or '(bundled)'}\n"
    )
    try:
        if runner is not None:
            completed = runner(argv, timeout_seconds=timeout_seconds, cancel_check=cancel_check or (lambda: False))
        else:
            completed = run_cancellable_process(
                argv,
                timeout_seconds=timeout_seconds,
                cancel_check=cancel_check or (lambda: False),
            )
    except ProcessCancelled as exc:
        raise NucleiExecutionError("扫描已被取消；进程树已终止，未产生可用结果") from exc
    except ProcessTimeout as exc:
        raise NucleiExecutionError(f"扫描超时（{exc.timeout_seconds}s）；已终止") from exc
    except FileNotFoundError as exc:
        raise NucleiUnavailable(f"capability_missing: 找不到 docker 可执行文件: {exc}") from exc

    stdout = str(getattr(completed, "stdout", "") or "")
    stderr = str(getattr(completed, "stderr", "") or "")
    returncode = int(getattr(completed, "returncode", 0) or 0)
    hits = parse_nuclei_jsonl(stdout.splitlines())
    if returncode != 0 and not hits:
        raise NucleiExecutionError(
            f"nuclei 退出码 {returncode}: {stderr.strip()[:500] or stdout.strip()[:500]}"
        )

    raw_bytes = (run_header + "\n" + stdout).encode("utf-8", errors="replace")
    digest = hashlib.sha256(raw_bytes).hexdigest()
    raw_name = _write_evidence_file(evidence_root / f"{digest}.jsonl", raw_bytes)
    hit_evidence_paths: list[str] = []
    for index, hit in enumerate(hits, start=1):
        hit_evidence_paths.append(
            _write_hit_evidence(evidence_root, index, hit, run_header)
        )

    return {
        "engine": DESCRIPTOR["id"],
        # 版本探测只在真实 docker 路径执行（测试注入 runner 时不伪造版本）；
        # 探测失败记录 None，不阻断扫描结果。
        "engine_version": engine_version() if runner is None else None,
        "image_ref": image_ref(),
        "parser_version": DESCRIPTOR["parser_version"],
        "argv": argv,
        "targets": targets,
        "template_ids": template_ids,
        "hit_count": len(hits),
        "no_hit": not hits,
        "hits": [
            {
                key: hit[key]
                for key in (
                    "template_id", "template_name", "severity", "description",
                    "host", "matched_at", "matcher_name", "matcher_status",
                    "extracted_results", "curl_command", "timestamp",
                )
            }
            for hit in hits
        ],
        "evidence_path": f"evidence/{evidence_subdir}/{raw_name}",
        "evidence_sha256": digest,
        "hit_evidence_paths": hit_evidence_paths,
        "returncode": returncode,
        "stderr_tail": stderr.strip()[-500:],
        "note": (
            "命中仅为候选：区分引擎声称命中与证据实际支持由独立研判与复核完成；"
            "请求/响应原文见 hit_evidence_paths 与原始输出 evidence_path。"
        ),
    }
