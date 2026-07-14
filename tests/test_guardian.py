from src.agent_control_plane.guardian import Guardian
from src.agent_control_plane.schemas import Fact, FactClassification
from src.agent_control_plane.store import ProjectStore
from src.agent_control_plane import store as store_module
from src.agent_control_plane.worker import apply_worker_output

import pytest
from pathlib import Path


def test_guardian_demotes_unverified_claim() -> None:
    fact = Fact(title="nodeIntegration 开启", category="electron_config", evidence="可能存在 RCE")
    reviewed = Guardian().review(fact)
    assert reviewed.status == "phenomenon"
    assert reviewed.quality_notes


def test_guardian_accepts_verified_evidence() -> None:
    fact = Fact(
        title="IPC 命令注入",
        category="ipc_endpoint",
        evidence="运行 PoC 后观察到 /tmp/pwned 被写入，日志返回命令执行成功。",
        business_impact="攻击者可在终端用户权限下执行任意命令并窃取本地业务数据。",
        reproduction_steps=["调用受影响 IPC 端点", "传入可控命令", "检查 /tmp/pwned"],
        evidence_path="evidence/ipc-command-execution.txt",
    )
    reviewed = Guardian().review(fact)
    assert reviewed.status == "vulnerability"
    assert reviewed.classification == FactClassification.VULNERABILITY.value
    assert reviewed.impact_score >= 0.7


def test_attack_surface_information_is_not_vulnerability() -> None:
    fact = Fact(
        title="证书 SAN 暴露多个子域名",
        category="asset",
        evidence="执行 openssl 证书读取后观察到 SAN 包含多个业务子域，并写入证据文件。",
        business_impact="该信息可用于扩展攻击面，但尚未形成漏洞闭环。",
        reproduction_steps=["读取证书", "核对 SAN 列表"],
        evidence_path="evidence/cert.txt",
        confidence=0.9,
        impact_score=0.8,
    )
    reviewed = Guardian().review(fact)
    assert reviewed.status == "phenomenon"
    assert reviewed.classification == FactClassification.ATTACK_SURFACE.value
    assert reviewed.impact_score <= 0.35


def test_guardian_requires_business_impact_and_reproduction() -> None:
    fact = Fact(
        title="已观察到命令执行",
        category="command_execution",
        evidence="运行 PoC 后观察到命令返回成功，且日志中写入了可核验的标记。",
    )
    reviewed = Guardian().review(fact)
    assert reviewed.status == "phenomenon"
    assert any("业务损失" in note for note in reviewed.quality_notes)


def test_missing_evidence_file_cannot_become_vulnerability(tmp_path: Path) -> None:
    fact = Fact(
        title="运行时验证结果",
        category="ipc_endpoint",
        evidence="运行验证命令后观察到目标返回成功，并在日志中记录了完整执行状态。",
        business_impact="攻击者可执行未授权操作并读取业务数据。",
        reproduction_steps=["执行验证请求", "核对响应和日志"],
        evidence_path="evidence/missing.txt",
    )
    reviewed = Guardian().review(fact, tmp_path)
    assert reviewed.status == "phenomenon"
    assert any("不存在" in note for note in reviewed.quality_notes)


def test_existing_evidence_is_hashed_and_linked(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(store_module, "PROJECTS", tmp_path / "projects")
    store = ProjectStore("production-security")
    store.init()
    evidence = store.path / "evidence" / "runtime.txt"
    evidence.write_text("command=verify\nexit_code=0\nobserved=success\n", encoding="utf-8")
    output = apply_worker_output(store, {
        "kind": "fact",
        "title": "运行时验证结果",
        "category": "ipc_endpoint",
        "evidence": "运行验证命令后观察到目标返回成功，并在日志中记录了完整执行状态。",
        "business_impact": "攻击者可执行未授权操作并读取业务数据。",
        "reproduction_steps": ["执行验证请求", "核对响应和日志"],
        "evidence_path": "evidence/runtime.txt",
        "severity": "high",
        "confidence": 0.9,
    })
    record = store.read_jsonl("evidence.jsonl")[0]
    assert "vulnerability" in output
    assert record["path"] == "evidence/runtime.txt"
    assert len(record["sha256"]) == 64


def test_evidence_directory_files_are_hashed_and_linked(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(store_module, "PROJECTS", tmp_path / "projects")
    store = ProjectStore("production-security")
    store.init()
    evidence_dir = store.path / "evidence" / "intake_recon"
    evidence_dir.mkdir()
    (evidence_dir / "a.txt").write_text("command=a\nobserved=success\n", encoding="utf-8")
    (evidence_dir / "b.txt").write_text("command=b\nobserved=success\n", encoding="utf-8")
    output = apply_worker_output(store, {
        "kind": "fact",
        "title": "基础侦察证据目录",
        "category": "asset",
        "evidence": "执行基础侦察后观察到两个目标均有响应，原始输出写入证据目录。",
        "business_impact": "攻击者可据此扩展后续攻击面。",
        "reproduction_steps": ["执行基础侦察", "核对证据目录"],
        "evidence_path": "evidence/intake_recon/",
        "severity": "low",
        "confidence": 0.8,
    })
    paths = {item["path"] for item in store.read_jsonl("evidence.jsonl")}
    assert "Fact" in output
    assert paths == {"evidence/intake_recon/a.txt", "evidence/intake_recon/b.txt"}
