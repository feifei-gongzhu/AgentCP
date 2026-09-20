from __future__ import annotations

from dataclasses import asdict

from .commits import CommitCoordinator, CommitPlanner
from .controller import Controller
from .schemas import ControllerAction, Decision, GateStatus
from .store import ProjectStore
from .quality import QualityLedger


class Scheduler:
    def __init__(self, store: ProjectStore):
        self.store = store
        self.controller = Controller()

    def _commit_decision(self, state, decision) -> None:
        plan = CommitPlanner().freeze_action(
            kind="scheduler_decision",
            payload={"state": asdict(state), "decision": asdict(decision)},
            source_type="deterministic_scheduler",
            source_id=decision.id,
            idempotency_key=f"scheduler_decision:{decision.id}",
            aggregate_type="decision",
            aggregate_id=f"project:{self.store.vendor}",
        )
        CommitCoordinator(self.store).submit(plan)

    def tick(self, minutes: int, serendipity: bool = False) -> str:
        with self.store.locked():
            state = self.store.load_state()
            if state.gate_status == GateStatus.AWAITING_APPROVAL.value:
                raise RuntimeError("强制门禁正在等待用户批准，禁止继续执行。请先运行 approve-gate。")
            state.elapsed_minutes += minutes
            if serendipity:
                state.serendipity_used_minutes += minutes

            facts = self.store.read_jsonl("facts.jsonl")
            verdicts = QualityLedger().latest_verdicts(self.store)
            facts = [
                {**item, "human_action": (verdicts.get(str(item.get("id"))) or {}).get("action")}
                for item in facts
            ]
            since_gate = state.elapsed_minutes - state.last_gate_elapsed_minutes
            gate_due = state.gate_interval_minutes > 0 and since_gate >= state.gate_interval_minutes
            decision = self.controller.evaluate(state, facts, gate_due=gate_due)
            if serendipity:
                decision.serendipity_minutes = minutes
                decision.reason = f"[状态: 消耗意外预算中] {decision.reason}"

            if gate_due:
                state.gate_status = GateStatus.AWAITING_APPROVAL.value
                state.gate_reason = decision.reason
            state.current_decision = decision.action
            self._commit_decision(state, decision)
            gate_status = "等待用户批准" if gate_due else f"运行中，距上次评估 {since_gate} min"
            return (
                "[控制器评估]\n"
                f"当前阶段: {state.phase} | 已用时间: {state.elapsed_minutes} min | 当前任务: {state.current_task}\n"
                f"资产状态: {state.asset_count} 个 / 漏洞点 {state.vulnerability_count} 个 | 上次发现: {state.last_discovery_at or '无'}\n"
                f"ROI 判断: {decision.action}\n理由: {decision.reason}\n"
                f"下一动作: {'请求用户确认' if gate_due else '继续当前'}\n"
            )

    def complete_subtask(self, summary: str, *, require_approval: bool = True) -> str:
        """Record subtask convergence; only explicit gates block execution."""
        with self.store.locked():
            state = self.store.load_state()
            if not require_approval and state.gate_status != GateStatus.AWAITING_APPROVAL.value:
                from .phase import reconcile_phase
                reconcile_phase(self.store, "subtask_completed_nonblocking")
                state = self.store.load_state()
                state.current_decision = ControllerAction.CONTINUE.value
                decision = Decision(
                    action=state.current_decision,
                    reason=f"子任务已完成：{summary}。候选结果已进入对应结果池，自动化不因待人工复核而暂停。",
                    phase=state.phase,
                )
                self._commit_decision(state, decision)
                return self.controller_text(state, decision, next_action="继续自动化；人工复核异步进行")
            previous_reason = state.gate_reason if state.gate_status == GateStatus.AWAITING_APPROVAL.value else None
            state.gate_status = GateStatus.AWAITING_APPROVAL.value
            completion_reason = f"子任务已完成：{summary}。按 V3.3 要求暂停并等待用户批准。"
            state.gate_reason = f"{previous_reason} | {completion_reason}" if previous_reason else completion_reason
            state.current_decision = ControllerAction.REQUEST_CONFIRMATION.value
            decision = Decision(action=state.current_decision, reason=state.gate_reason, phase=state.phase)
            self._commit_decision(state, decision)
            return self.controller_text(state, decision)

    def approve(self, action: str, reason: str) -> str:
        with self.store.locked():
            state = self.store.load_state()
            if state.gate_status != GateStatus.AWAITING_APPROVAL.value:
                raise RuntimeError("当前没有待批准的强制门禁。")
            allowed = {item.value for item in ControllerAction if item != ControllerAction.REQUEST_CONFIRMATION}
            if action not in allowed:
                raise ValueError(f"非法批准动作: {action}")
            decision = Decision(action=action, reason=reason, phase=state.phase)
            state.gate_status = GateStatus.RUNNING.value
            state.gate_reason = None
            state.last_gate_elapsed_minutes = state.elapsed_minutes
            state.task_started_elapsed_minutes = state.elapsed_minutes
            state.current_decision = action
            self._commit_decision(state, decision)
            return f"已批准: {action} | {reason}"

    @staticmethod
    def controller_text(state, decision, next_action: str = "请求用户确认") -> str:
        return (
            "[控制器评估]\n"
            f"当前阶段: {state.phase} | 已用时间: {state.elapsed_minutes} min | 当前任务: {state.current_task}\n"
            f"资产状态: {state.asset_count} 个 / 漏洞点 {state.vulnerability_count} 个 | 上次发现: {state.last_discovery_at or '无'}\n"
            f"ROI 判断: {decision.action}\n理由: {decision.reason}\n下一动作: {next_action}\n"
        )
