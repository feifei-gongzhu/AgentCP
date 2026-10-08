"""fscan 侦察适配器（实施方案 §6.6-3、§12-P3）。

引擎选择依据（§6.6-3：本机/容器兼容性、结构化输出、取消与恢复可行性）：

- **fscan（已选）**：单一静态 Go 二进制（linux/arm64 约 7.5MB），官方
  GitHub Release 附 checksums.txt（导入即校验 sha256）；``-f json`` 输出
  结构化 JSON 报告（hosts/ports/services/vulns），固定 argv + 进程组
  取消可行；MIT 许可。容器兼容性好（alpine 基镜像）。
- dddd：Python/GUI 优先，无官方容器镜像与 GitHub Release 资产，结构化
  输出与无人值守运行不满足——按方案“另一引擎随后接入”记入后续。

镜像来源：本环境 docker.io 不可达（P2 实测），官方二进制从 GitHub
Release 下载（sha256 与官方 checksums.txt 核对：v2.2.2 linux_arm64 =
cfa5a78a…64eb9fe），以本地构建镜像 ``sorne-engines/fscan:2.2.2`` 固定
（Dockerfile 见 tests/fixtures 或部署文档）。镜像摘要随导入登记在资源
仓库（poc/service 之外的首个外部引擎二进制来源记录）。

适配范围：``ip_scan``（主机/端口/服务识别）与 ``url_scan``（Web 存活/
标题/指纹）。fscan 无子域枚举模块——``subdomain_scan`` 由原生 DNS 采集
实现（web_collect.run_subdomain_scan），不冒充 fscan 能力。

安全基线：侦察用途固定 ``-nobr -nopoc``（口令爆破/POC 属 crack/poc 角色
的能力，recon 的引擎调用不得顺带执行，§13.1-5）；固定 argv、无 shell
拼接；``--cap-drop ALL``/资源上限沿用 docker_base_args。
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Callable

from ..cancellable_process import (
    ProcessCancelled,
    ProcessTimeout,
    run_cancellable_process,
)
from ..docker_command import docker_base_args
from .batch_state import ScanBatch, arguments_digest

DEFAULT_IMAGE = "sorne-engines/fscan:2.2.2"
FSCAN_VERSION = "2.2.2"
FSCAN_SOURCE_URL = (
    "https://github.com/shadow1ng/fscan/releases/download/"
    f"v{FSCAN_VERSION}/fscan_{FSCAN_VERSION}_linux_arm64"
)
FSCAN_BINARY_SHA256 = "cfa5a78adc0b310811af11c0b9bdaaeda0d8443d271ad2c0b28b8b52064eb9fe"
AVAILABILITY_CACHE_SECONDS = 15.0
SCAN_TIMEOUT_SECONDS = 420
MAX_TARGETS_PER_SCAN = 24

DESCRIPTOR: dict[str, Any] = {
    "id": "fscan-adapter",
    "name": "侦察扫描引擎（fscan）",
    "version": FSCAN_VERSION,
    "capabilities": ["url_scan", "ip_scan"],
    "runtime": "local-docker",
    "parser_version": "v1",
    "image_ref_env": "SORNE_FSCAN_IMAGE",
    "entrypoint": ["docker", "run", *docker_base_args(network="host")],
    "resource_class": "recon_scan",
    "cancellation": "process_group",
    "resume_strategy": "restart_remaining",
    "source": FSCAN_SOURCE_URL,
    "source_sha256": FSCAN_BINARY_SHA256,
    "license": "MIT（shadow1ng/fscan）",
}


class FscanUnavailable(RuntimeError):
    """运行环境不满足（Docker/镜像缺失）——capability_missing 语义。"""


class FscanExecutionError(RuntimeError):
    """引擎已运行但执行失败。"""


def image_ref() -> str:
    return str(os.environ.get("SORNE_FSCAN_IMAGE") or DEFAULT_IMAGE).strip() or DEFAULT_IMAGE


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
            f"镜像 {ref} 不在本地（构建/预取方法见 DESCRIPTOR.source；"
            "未预取即如实报缺口，不做假扫描）"
        )
    return True, ""


def availability_status() -> tuple[bool, str]:
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
        "version": FSCAN_VERSION,
        "capabilities": DESCRIPTOR["capabilities"],
    }


def _normalize_targets(arguments: dict[str, Any], *, mode: str) -> list[str]:
    targets = [
        str(item).strip() for item in (arguments.get("targets") or [])
        if str(item).strip()
    ]
    if not targets:
        raise FscanExecutionError(f"{mode} 需要至少一个目标（targets: string[]）")
    if len(targets) > MAX_TARGETS_PER_SCAN:
        raise FscanExecutionError(
            f"单次扫描目标数超过上限 {MAX_TARGETS_PER_SCAN}；请拆分批处理"
        )
    return targets


def _build_argv(
    *,
    mode: str,
    target: str,
    host_scratch: Path,
) -> list[str]:
    """单目标固定 argv（fscan 的 -u 为单 URL 语义；逐目标进程也使
    取消/恢复的粒度与批次账本一致）。"""
    args = [
        "docker", *docker_base_args(network="host"),
        "-v", f"{host_scratch.resolve()}:/sorne-scan:rw",
        image_ref(),
    ]
    args.extend(["-u", target] if mode == "url" else ["-h", target])
    args.extend([
        "-f", "json",
        "-o", "/sorne-scan/result.json",
        # 侦察安全基线：禁爆破、禁 POC、禁利用类模块（属其他角色能力）。
        "-nobr", "-nopoc", "-noredis",
        "-silent", "-nopg", "-nocolor", "-np",
        "-gt", "180",
        "-time", "3",
    ])
    return args


def parse_fscan_report(raw: str) -> dict[str, Any]:
    """解析 fscan ``-f json`` 报告（纯函数，供夹具测试）。

    结构（v2.2.2 实测）：{scan_time, summary, hosts[], ports[], services[],
    vulns[]}。hosts 元素含 target/status/details；services 的 details 含
    title/server/fingerprints/url 等。
    """
    text = str(raw or "").strip()
    if not text:
        return {"hosts": [], "ports": [], "services": [], "vulns": [], "summary": {}}
    try:
        report = json.loads(text)
    except json.JSONDecodeError as exc:
        raise FscanExecutionError(f"fscan JSON 报告解析失败: {exc}") from exc
    if not isinstance(report, dict):
        raise FscanExecutionError("fscan JSON 报告不是对象")

    def _rows(key: str) -> list[dict[str, Any]]:
        rows = report.get(key)
        if not isinstance(rows, list):
            return []
        return [row for row in rows if isinstance(row, dict)]

    hosts = [
        {
            "target": str(row.get("target") or ""),
            "status": str(row.get("status") or ""),
            "details": row.get("details") or {},
        }
        for row in _rows("hosts")
    ]
    ports = [
        {
            "target": str(row.get("target") or ""),
            "port": int((row.get("details") or {}).get("port") or 0),
            "status": str(row.get("status") or ""),
        }
        for row in _rows("ports")
        if (row.get("details") or {}).get("port")
    ]
    services: list[dict[str, Any]] = []
    for row in _rows("services"):
        details = row.get("details") or {}
        services.append({
            "target": str(row.get("target") or ""),
            "plugin": str(details.get("plugin") or ""),
            "protocol": str(details.get("protocol") or ""),
            "port": details.get("port"),
            "url": str(details.get("url") or ""),
            "title": str(details.get("title") or "")[:300],
            "server": str(details.get("server") or "")[:200],
            "status": details.get("status"),
            "fingerprints": [str(item) for item in (details.get("fingerprints") or [])][:12],
        })
    vulns = [
        {
            "target": str(row.get("target") or ""),
            "plugin": str((row.get("details") or {}).get("plugin") or row.get("plugin") or ""),
            "details": row.get("details") or {},
        }
        for row in _rows("vulns")
    ]
    return {
        "hosts": hosts,
        "ports": ports,
        "services": services,
        "vulns": vulns,
        "summary": report.get("summary") or {},
    }


def _write_evidence(store, name_stem: str, payload: bytes) -> str:
    evidence_root = store.path / "evidence" / "recon"
    evidence_root.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256(payload).hexdigest()
    destination = evidence_root / f"{digest}.{name_stem}"
    if not destination.exists():
        destination.write_bytes(payload)
    destination.with_name(destination.name + ".sha256").write_text(
        f"{digest}  {destination.name}\n", encoding="utf-8",
    )
    return f"evidence/recon/{destination.name}"


def run_recon_scan(
    store,
    arguments: dict[str, Any],
    *,
    mode: str,  # "url" | "ip"
    cancel_check: Callable[[], bool] | None = None,
    timeout_seconds: int = SCAN_TIMEOUT_SECONDS,
    runner: Callable[..., Any] | None = None,
) -> dict[str, Any]:
    """执行一次 fscan 侦察扫描（url_scan / ip_scan 共用，固定 argv）。

    ``runner`` 仅测试注入（替换子进程执行并返回 (report_text, stdout) 形
    Completed）；生产路径为 None → 真实 docker 执行。
    """
    if mode not in {"url", "ip"}:
        raise FscanExecutionError(f"未知扫描模式: {mode}")
    targets = _normalize_targets(arguments, mode=mode)
    available, reason = availability_status()
    if not available and runner is None:
        raise FscanUnavailable(
            f"capability_missing: fscan 运行环境不可用（{reason}）；"
            "扫描未执行，不得以其他结果冒充。"
        )

    digest = arguments_digest(f"fscan_{mode}_scan", {"targets": targets})
    batch = ScanBatch(store, f"fscan_{mode}_scan", digest, targets)
    batch.begin_run(f"fscan {mode} targets={len(targets)}")
    remaining = batch.remaining_targets()
    if not remaining:
        return {
            "engine": DESCRIPTOR["id"],
            "engine_version": FSCAN_VERSION,
            "mode": mode,
            "targets": targets,
            "no_hit": None,
            "batch": batch.summary(),
            "note": "批处理内全部目标已完成（§8.3 不重扫）；如需重扫请变更参数或清理批次。",
            "resumed": True,
        }

    host_scratch = store.path / ".sorne-work" / "fscan-scan" / digest
    host_scratch.mkdir(parents=True, exist_ok=True)
    argv: list[str] = []
    all_ports: list[dict[str, Any]] = []
    all_services: list[dict[str, Any]] = []
    all_hosts: list[dict[str, Any]] = []
    evidence_paths: list[str] = []
    summary_report: dict[str, Any] = {}
    interrupted = False
    for target in remaining:
        if cancel_check is not None and cancel_check():
            interrupted = True
            break
        batch.mark(target, "running")
        argv = _build_argv(mode=mode, target=target, host_scratch=host_scratch)
        header = (
            f"# Sorne {mode}_scan (fscan adapter)\n"
            f"# image: {image_ref()}\n"
            f"# argv: {json.dumps(argv, ensure_ascii=False)}\n"
            f"# target: {target}\n"
        )
        result_file = host_scratch / "result.json"
        if result_file.exists():
            result_file.unlink()
        report_text = ""
        stdout_text = ""
        try:
            if runner is not None:
                completed = runner(argv, timeout_seconds=timeout_seconds, cancel_check=cancel_check or (lambda: False))
                stdout_text = str(getattr(completed, "stdout", "") or "")
                # 测试注入路径：注入 stdout 作为报告文本。
                report_text = stdout_text
            else:
                completed = run_cancellable_process(
                    argv, timeout_seconds=timeout_seconds,
                    cancel_check=cancel_check or (lambda: False),
                )
                stdout_text = str(getattr(completed, "stdout", "") or "")
                report_text = (
                    result_file.read_text(encoding="utf-8", errors="replace")
                    if result_file.is_file() else ""
                )
            returncode = int(getattr(completed, "returncode", 0) or 0)
        except ProcessCancelled as exc:
            batch.note_interrupted([target])
            raise FscanExecutionError(
                "扫描已被取消；进程树已终止。已完成目标保留，被中断目标标记"
                " unknown_outcome，可按相同参数恢复（restart_remaining）。"
            ) from exc
        except ProcessTimeout as exc:
            batch.note_interrupted([target])
            raise FscanExecutionError(f"扫描超时（{exc.timeout_seconds}s）；已终止") from exc
        except FileNotFoundError as exc:
            raise FscanUnavailable(f"capability_missing: 找不到 docker 可执行文件: {exc}") from exc

        if not report_text.strip():
            stderr = str(getattr(completed, "stderr", "") or "")
            batch.mark(target, "failed", {"error": f"exit={returncode}: {stderr[:200]}"})
            continue
        parsed = parse_fscan_report(report_text)
        summary_report = parsed["summary"] or summary_report
        evidence_paths.append(_write_evidence(
            store, f"{mode}-scan.json",
            (header + "\n" + report_text).encode("utf-8", errors="replace"),
        ))
        _write_evidence(
            store, f"{mode}-scan.stdout.log",
            (header + "\n" + stdout_text[:100_000]).encode("utf-8", errors="replace"),
        )
        batch.mark(
            target, "completed",
            {"ports": len(parsed["ports"]), "services": len(parsed["services"])},
        )
        for row in parsed["ports"]:
            row["scan_target"] = target
        all_ports.extend(parsed["ports"])
        all_services.extend(parsed["services"])
        all_hosts.extend(parsed["hosts"])

    if interrupted:
        batch.note_interrupted([t for t in remaining if batch.status_of(t) == "running"])
        return {
            "engine": DESCRIPTOR["id"],
            "engine_version": FSCAN_VERSION,
            "mode": mode,
            "targets": targets,
            "scanned_targets": [t for t in remaining if batch.status_of(t) == "completed"],
            "hosts": all_hosts[:64],
            "ports": all_ports[:256],
            "port_count": len(all_ports),
            "services": all_services[:128],
            "service_count": len(all_services),
            "summary_report": summary_report,
            "no_hit": not all_ports and not all_services,
            "batch": batch.summary(),
            "evidence_path": evidence_paths[0] if evidence_paths else None,
            "evidence_paths": evidence_paths,
            "cancelled": True,
            "note": "扫描在批次中途被取消；已完成目标不重扫，剩余目标可按相同参数恢复。",
        }

    return {
        "engine": DESCRIPTOR["id"],
        "engine_version": FSCAN_VERSION,
        "image_ref": image_ref(),
        "parser_version": DESCRIPTOR["parser_version"],
        "mode": mode,
        "argv": argv,
        "targets": targets,
        "scanned_targets": remaining,
        "hosts": all_hosts[:64],
        "ports": all_ports[:256],
        "port_count": len(all_ports),
        "services": all_services[:128],
        "service_count": len(all_services),
        "summary_report": summary_report,
        "no_hit": not all_ports and not all_services,
        "batch": batch.summary(),
        "evidence_path": evidence_paths[0] if evidence_paths else None,
        "evidence_paths": evidence_paths,
        "returncode": 0,
        "note": (
            "开放端口/Web 指纹是采集观察；fscan 的 vulns 输出在本适配的侦察"
            "用途下被禁用（-nopoc），漏洞候选只能来自 poc_scan 与复核链。"
        ),
    }
