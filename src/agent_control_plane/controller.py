from __future__ import annotations

from .schemas import ControllerAction, Decision, GateStatus, ProjectState


class Controller:
    def evaluate(self, state: ProjectState, recent_facts: list[dict], gate_due: bool = False) -> Decision:
        if state.gate_status == GateStatus.AWAITING_APPROVAL.value:
            return Decision(
                action=ControllerAction.REQUEST_CONFIRMATION.value,
                phase=state.phase,
                reason=state.gate_reason or "已触发强制节拍，必须获得用户批准后才能继续。",
            )

        if gate_due:
            spent = state.elapsed_minutes - state.last_gate_elapsed_minutes
            return Decision(
                action=ControllerAction.REQUEST_CONFIRMATION.value,
                phase=state.phase,
                reason=f"同一执行节拍已达 {spent} 分钟，按 V3.2 强制暂停并请求用户批准。",
            )

        if state.fact_count == 0 and state.elapsed_minutes >= 45:
            return Decision(
                action=ControllerAction.SWITCH_TARGET.value,
                phase=state.phase,
                reason="已投入 45 分钟仍无有效事实进入黑板，当前路径 ROI 过低。",
            )

        if state.serendipity_used_minutes > state.serendipity_budget_minutes:
            return Decision(
                action=ControllerAction.REQUEST_CONFIRMATION.value,
                phase=state.phase,
                reason="意外预算已耗尽，继续追踪低概率线索需要人工确认。",
            )

        has_recent_vulnerability = bool(
            recent_facts and any(
                item.get("status") == "vulnerability"
                and item.get("human_action") not in {"refuted", "reclassified"}
                for item in recent_facts[-3:]
            )
        )

        if has_recent_vulnerability:
            return Decision(
                action=ControllerAction.CONTINUE.value,
                phase=state.phase,
                reason="最近事实中存在已验证漏洞，应继续围绕证据链收敛并准备报告。",
            )

        return Decision(
            action=ControllerAction.CONTINUE.value,
            phase=state.phase,
            reason="未触发止损或切换条件。",
        )
