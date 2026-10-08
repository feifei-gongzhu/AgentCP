"""大文件压力：1 万行 JSONL 读取耗时；10MB 目标文件上传校验路径边界。

说明：1 万行 JSONL 直接在 tmp 中整块构造（单次写盘），
再计时走产品读取路径 store.read_jsonl；10MB 上传用内存流真实走
_store_client_upload 的校验与落盘路径（无需 HTTP 传输）。
"""
from __future__ import annotations

import hashlib
import io
import time
from pathlib import Path

import pytest

from src.sorne import webapp as webapp_module
from src.sorne.store import ProjectStore

JSONL_ROWS = 10_000
UPLOAD_BYTES = 10 * 1024 * 1024  # 10MB
READ_TIMEOUT = 30.0
UPLOAD_TIMEOUT = 60.0


def test_read_10k_jsonl_rows_is_bounded() -> None:
    store = ProjectStore("stress-large")
    store.init()
    lines = "".join(
        f'{{"id": "row-{i}", "content": "压测行内容-{i}", "index": {i}}}\n'
        for i in range(JSONL_ROWS)
    )
    (store.path / "facts.jsonl").write_text(lines, encoding="utf-8")

    started = time.monotonic()
    rows = store.read_jsonl("facts.jsonl")
    elapsed = time.monotonic() - started

    assert len(rows) == JSONL_ROWS, f"读取行数不符: {len(rows)}"
    assert rows[0]["id"] == "row-0" and rows[-1]["id"] == f"row-{JSONL_ROWS - 1}"
    assert elapsed < READ_TIMEOUT, f"1 万行读取耗时 {elapsed:.2f}s 超上限"
    print(f"\n[大文件] {JSONL_ROWS} 行 JSONL read_jsonl: {elapsed:.2f}s")


def test_10mb_client_upload_boundary_and_durability(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = ProjectStore("stress-upload")
    store.init()
    # 目标文件为客户端项目类型才允许上传。
    target = store.read_json("target.json")
    target["project_type"] = "客户端测试"
    store.write_json("target.json", target)

    payload = bytes([0x41 + (i % 26) for i in range(UPLOAD_BYTES)])

    # 边界一：上限设为 10MB，content_length = 10MB+1 必须在读流前被拒绝。
    monkeypatch.setenv("SORNE_MAX_CLIENT_UPLOAD_BYTES", str(UPLOAD_BYTES))
    started = time.monotonic()
    with pytest.raises(webapp_module.WebAppError, match="超过大小限制"):
        webapp_module._store_client_upload(
            store, "boundary.apk", io.BytesIO(payload + b"x"), UPLOAD_BYTES + 1,
        )
    reject_seconds = time.monotonic() - started
    # 超限拒绝发生在创建 uploads 目录之前，不得留下任何落盘痕迹。
    assert not (store.path / "uploads").exists(), "超限上传不得创建上传目录"

    # 边界二：恢复默认上限（2GB），真实 10MB 流完整落盘。
    monkeypatch.delenv("SORNE_MAX_CLIENT_UPLOAD_BYTES")
    stream = io.BytesIO(payload)
    started = time.monotonic()
    artifact, saved_target = webapp_module._store_client_upload(
        store, "target-client.apk", stream, UPLOAD_BYTES, "客户端测试",
    )
    upload_seconds = time.monotonic() - started

    assert artifact["size"] == UPLOAD_BYTES
    assert artifact["sha256"] == hashlib.sha256(payload).hexdigest()
    assert saved_target["uploaded_artifact"]["name"] == "target-client.apk"
    on_disk = store.path / "uploads" / Path(artifact["path"]).name
    assert on_disk.is_file() and on_disk.stat().st_size == UPLOAD_BYTES
    assert not list((store.path / "uploads").glob("*.part")), "存在未清理的临时上传文件"

    assert reject_seconds < 5.0, f"超限拒绝耗时异常 {reject_seconds:.2f}s"
    assert upload_seconds < UPLOAD_TIMEOUT, f"10MB 落盘耗时 {upload_seconds:.2f}s 超上限"
    print(f"\n[大文件] 10MB 上传校验拒绝={reject_seconds:.3f}s 落盘={upload_seconds:.2f}s")
