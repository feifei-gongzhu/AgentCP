from __future__ import annotations

"""方向防重语义回归：claim_version 条件更新、supersede 单事务、人工否决围栏。

历史问题族（tests/test_profile_directions.py 第五/六/七轮反例）：
- 同一 Run 复用同一成员名的旧 Worker，凭旧认领（无版本/旧版本）回调
  心跳或完成，会改写已被重新认领的新方向；
- supersede 曾在事务外分两步做"取消旧版本 + 注册新版本"，中间失败会
  留下"旧版本已取消、新版本未注册"的方向真空；
- 人工否决（human_dismissed）曾可被模型侧重评分绕过重新入队。

本文件挑新角度覆盖，不复制旧用例：旧版本回调注入策略冷却、伪造未来
版本、事务中途注入异常验证整体回滚、有效租约对 supersede 的保护、以及
Worker 输出路径（apply_worker_output）的模型侧重评绕行。
"""

from pathlib import Path

import pytest

from src.sorne import store as store_module
from src.sorne.database import ControlDatabase
from src.sorne.store import ProjectStore
from src.sorne.target_profile import (
    record_target_assessments,
    record_target_profile,
    seed_priority_target_directions,
)


def _project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, vendor: str = "reg-direction") -> ProjectStore:
    monkeypatch.setattr(store_module, "PROJECTS", tmp_path / "projects")
    store = ProjectStore(vendor)
    store.init()
    return store


def _profile_url(store: ProjectStore, url: str) -> None:
    recorded = record_target_profile(
        store, [{"url": url, "function": "后台管理入口", "technology_stack": ["Vue"]}],
        proposed_by="test",
    )
    assert recorded


def _assess(store: ProjectStore, url: str, score: int, tests=None) -> None:
    recorded = record_target_assessments(store, [{
        "url": url,
        "profile_class": "priority_target",
        "target_score": score,
        "risk_tags": ["upload"],
        "score_reason": "后台高影响入口",
        "recommended_tests": tests or ["upload_validation"],
    }], proposed_by="test")
    assert recorded


def _reclaimed_direction(database: ControlDatabase, worker: str):
    """构造"被重新认领过"的方向：认领 V1 → 人工停止 → 恢复 → 再认领 V2。"""
    direction_id, _ = database.register_direction({
        "verb": "verify",
        "target": "https://example.com/admin",
        "hypothesis": "同一逻辑方向的假设",
        "success_criteria": "形成可复核证据",
        "priority_score": 0.8,
    })
    first = database.claim_direction(worker, lease_seconds=30)
    assert first is not None and first["id"] == direction_id
    database.dismiss_direction(direction_id, "人工停止旧认领")
    database.restore_direction(direction_id, "人工恢复")
    second = database.claim_direction(worker, lease_seconds=30)
    assert second is not None and second["id"] == direction_id
    return direction_id, first["claim_version"], second["claim_version"]


# ---------------------------------------------------------------------------
# 角度一：旧版本回调不能把新认领打成"策略冷却"（released）。
# ---------------------------------------------------------------------------

def test_stale_claim_version_cannot_push_new_claim_into_cooldown(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """[P1] 历史坑：旧 Worker 的 finish/heartbeat 曾能改写重新认领后的方向。

    已有反例覆盖 outcome="cancelled"；本角度针对 outcome="released"——
    旧版本回调若成功，会把别人的新认领强行打成 policy_blocked_until 冷却，
    属于"借尸还魂"式的执行权劫持，且症状更隐蔽（方向看似还活着）。
    """
    database = ControlDatabase(tmp_path / "stale-release.db")
    direction_id, old_version, new_version = _reclaimed_direction(database, "R-run-1:executor-primary")
    cooldown = "policy_blocked_until:2999-01-01T00:00:00+00:00"
    reason_before = database.get_direction(direction_id)["terminal_reason"]

    # 旧版本回调试图以"策略冷却"终结新认领：必须被条件更新拒绝。
    assert not database.finish_direction(
        direction_id, "R-run-1:executor-primary",
        outcome="released", reason=cooldown, claim_version=old_version,
    )
    current = database.get_direction(direction_id)
    assert current["status"] == "claimed"
    assert current["terminal_reason"] == reason_before, "旧版本回调不得写入终态原因"
    assert int(current["claim_version"]) == int(new_version)
    # 冷却未生效：他人不可认领，但当前持有者的心跳照常工作。
    assert database.claim_direction("executor-other") is None
    assert database.heartbeat_direction(
        direction_id, "R-run-1:executor-primary", lease_seconds=30,
        claim_version=new_version,
    )

    # 对照：正确版本执行同样的冷却释放，语义正常生效。
    assert database.finish_direction(
        direction_id, "R-run-1:executor-primary",
        outcome="released", reason=cooldown, claim_version=new_version,
    )
    released = database.get_direction(direction_id)
    assert released["status"] == "released"
    assert str(released["terminal_reason"]).startswith("policy_blocked_until:")
    assert database.claim_direction("executor-b") is None, "真实冷却期内不可认领"


# ---------------------------------------------------------------------------
# 角度二：条件更新的版本匹配必须精确——伪造未来版本 / 冒名 Worker 均拒绝。
# ---------------------------------------------------------------------------

def test_conditional_update_rejects_wrong_worker_and_future_version(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """[P1] 历史坑：条件更新只校验 worker 名时，重名即可劫持；只校验版本号
    时，猜测一个更大的版本号即可抢占尚未发生的下一次认领。
    """
    database = ControlDatabase(tmp_path / "strict-match.db")
    worker = "R-run-1:executor-primary"
    direction_id, _old, current_version = _reclaimed_direction(database, worker)
    before = database.get_direction(direction_id)

    # 正确版本 + 错误 Worker：拒绝，且租约未被改写。
    assert not database.heartbeat_direction(
        direction_id, "R-run-1:executor-impostor", lease_seconds=300,
        claim_version=current_version,
    )
    # 正确 Worker + 未来版本（抢先占用下一次认领的版本号）：拒绝。
    assert not database.heartbeat_direction(
        direction_id, worker, lease_seconds=300,
        claim_version=int(current_version) + 1,
    )
    assert not database.finish_direction(
        direction_id, worker, outcome="completed",
        claim_version=int(current_version) + 1,
    )
    after = database.get_direction(direction_id)
    assert after["lease_expires_at"] == before["lease_expires_at"], (
        "被拒绝的心跳不得延长租约"
    )
    assert after["status"] == "claimed"

    # 兼容语义：不带版本的旧客户端回调（claim_version=None）仍按旧规则放行。
    assert database.heartbeat_direction(direction_id, worker, lease_seconds=60)
    # 真正的持有者 + 当前版本：照常生效。
    assert database.finish_direction(
        direction_id, worker, outcome="completed", claim_version=current_version,
    )
    assert database.get_direction(direction_id)["status"] == "completed"


# ---------------------------------------------------------------------------
# 角度三：supersede 单事务性——事务中途失败必须整体回滚。
# ---------------------------------------------------------------------------

def test_supersede_rolls_back_retire_when_registration_fails_mid_transaction(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """[P1] 历史坑：supersede 曾是"先取消旧方向、再注册新方向"两步操作；
    中间失败会留下目标真空（旧方向已死、新方向未生）。

    本角度在事务内部（旧版本 UPDATE 已执行、新版本 INSERT 之后）注入
    异常，验证"取消旧版本"也随之回滚。
    """
    database = ControlDatabase(tmp_path / "atomic-supersede.db")
    old_id, _ = database.register_direction({
        "verb": "verify",
        "target": "https://example.com/admin",
        "hypothesis": "旧版本假设",
        "success_criteria": "形成可复核证据",
        "priority_score": 0.6,
    })
    replacement_payload = {
        "verb": "verify",
        "target": "https://example.com/admin",
        "hypothesis": "新版本假设",
        "success_criteria": "形成可复核证据",
        "priority_score": 0.95,
    }

    def explode(*_args, **_kwargs):
        raise RuntimeError("注入：投影事件写入失败")

    monkeypatch.setattr(database, "_insert_direction_intent_projection", explode)
    with pytest.raises(RuntimeError, match="注入"):
        database.supersede_and_register_direction(
            replacement_payload,
            retire_direction_id=old_id,
            retire_reason="superseded_by_assessment:A-2",
            version_suffix="A-2",
        )
    monkeypatch.undo()

    # 整体回滚：旧方向仍 open，没有半成品新方向，也没有遗留投影事件。
    assert database.get_direction(old_id)["status"] == "open"
    assert len(database.list_directions()) == 1
    with database.connect() as db:
        pending = db.execute(
            "SELECT count(*) FROM commit_events WHERE event_type='record_direction_intent'"
        ).fetchone()[0]
    assert pending == 0

    # 故障清除后同一调用成功：旧 cancelled、新 open，一次到位。
    payload, new_id, _event_id, replaced = database.supersede_and_register_direction(
        replacement_payload,
        retire_direction_id=old_id,
        retire_reason="superseded_by_assessment:A-2",
        version_suffix="A-2",
    )
    assert replaced is True and new_id is not None
    assert database.get_direction(old_id)["status"] == "cancelled"
    assert database.get_direction(str(new_id))["status"] == "open"


def test_supersede_never_breaks_valid_lease_and_wins_after_expiry(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """[P1] 历史坑：替代清理与执行中租约的竞态——曾出现把有效租约的执行
    中方向直接取消、或等租约过期后旧方向复活为双可认领。

    直接打到原子原语：有效租约期间 supersede 必须拒绝（快照失效返回
    False 且零副作用）；租约过期后同一调用必须一次完成替代。
    """
    database = ControlDatabase(tmp_path / "lease-supersede.db")
    old_id, _ = database.register_direction({
        "verb": "verify",
        "target": "https://example.com/admin",
        "hypothesis": "旧版本假设",
        "success_criteria": "形成可复核证据",
        "priority_score": 0.6,
    })
    claimed = database.claim_direction("executor-a", lease_seconds=3600)
    assert claimed is not None and claimed["id"] == old_id

    result = database.supersede_and_register_direction(
        {
            "verb": "verify",
            "target": "https://example.com/admin",
            "hypothesis": "新版本假设",
            "success_criteria": "形成可复核证据",
            "priority_score": 0.95,
        },
        retire_direction_id=old_id,
        retire_reason="superseded_by_assessment:A-2",
        version_suffix="A-2",
    )
    # 有效租约：拒绝替代，零副作用。
    assert result == (None, None, None, False)
    assert database.get_direction(old_id)["status"] == "claimed"
    assert len(database.list_directions()) == 1

    # 租约过期后：同一调用原子完成替代，旧方向不得复活为第二个可认领版本。
    with database.connect() as db:
        db.execute(
            "UPDATE directions SET lease_expires_at='2000-01-01T00:00:00+00:00' WHERE id=?",
            (old_id,),
        )
    _payload, new_id, _event_id, replaced = database.supersede_and_register_direction(
        {
            "verb": "verify",
            "target": "https://example.com/admin",
            "hypothesis": "新版本假设",
            "success_criteria": "形成可复核证据",
            "priority_score": 0.95,
        },
        retire_direction_id=old_id,
        retire_reason="superseded_by_assessment:A-2",
        version_suffix="A-2",
    )
    assert replaced is True
    old_after = database.get_direction(old_id)
    assert old_after["status"] == "cancelled"
    assert str(old_after["terminal_reason"]).startswith("superseded_by_assessment:")
    next_claim = database.claim_direction("executor-b")
    assert next_claim is not None and next_claim["id"] == new_id
    assert database.claim_direction("executor-c") is None, "不得形成第二个可认领版本"


# ---------------------------------------------------------------------------
# 角度四：人工否决不被"模型侧重评"绕过——Worker 输出路径（非直接落盘）。
# ---------------------------------------------------------------------------

def test_human_dismissal_fence_blocks_model_side_reevaluation_via_worker_output(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """[P1] 历史坑：人工否决曾可被重新评分绕过。

    既有反例用 record_target_assessments 直写评估文件、且只改分数；
    本角度走真实模型输出通道 apply_worker_output（automation_job 来源 +
    幂等键），并同时大幅提高分数与更换建议专项（实质变化更强）——
    围栏仍必须生效，只有显式人工恢复可以重新入队。
    """
    from src.sorne.worker import apply_worker_output

    store = _project(tmp_path, monkeypatch, vendor="dismiss-model-path")
    database = ControlDatabase(store.path / "control_plane.db")
    url = "https://example.com/admin"
    _profile_url(store, url)
    _assess(store, url, 60)
    assert seed_priority_target_directions(store, database) == 1
    direction_id = database.list_directions()[0]["id"]

    dismissed = database.dismiss_direction(direction_id, "人工判断不值得继续验证")
    assert dismissed["status"] == "cancelled"

    # 模型侧通过 Worker 输出提交一次"实质变化"的重评：更高分 + 新建议专项。
    apply_worker_output(
        store,
        {
            "kind": "target_profile_batch",
            "records": [{"url": url, "function": "后台管理入口", "technology_stack": ["Vue"]}],
            "assessments": [{
                "url": url, "profile_class": "priority_target", "target_score": 98,
                "risk_tags": ["upload", "auth"], "score_reason": "模型重评：高影响入口",
                "recommended_tests": ["auth_bypass", "ssrf_validation"],
            }],
            "routine_groups": [],
            "exploration_complete": True,
        },
        source_type="automation_job", source_id="J-reeval-1",
        idempotency_key="job:J-reeval-1:profile",
    )
    # 重评确实已生效为最新评估……
    rows = [r for r in store.read_jsonl("target_assessments.jsonl") if r["url"] == url]
    assert rows[-1]["target_score"] == 98

    # ……但播种被人工否决围栏挡住：不新建、不复活任何可认领方向。
    assert seed_priority_target_directions(store, database) == 0
    open_items = [
        item for item in database.list_directions()
        if item["status"] in {"open", "released", "claimed"}
    ]
    assert open_items == []

    # 只有显式人工恢复才能重新入队（恢复后按最新评估替代为 98 分版本）。
    restored = database.restore_direction(direction_id, "人工复核后恢复")
    assert restored["status"] == "open"
    assert seed_priority_target_directions(store, database) == 1
    final = [
        item for item in database.list_directions() if item["status"] == "open"
    ]
    assert len(final) == 1
    assert final[0]["intent"]["target_score"] == 98
