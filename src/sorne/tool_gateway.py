"""工具网关（实施方案 §6.1-6.4）：身份绑定、权限校验、参数验证、派发、审计。

权限取交集并在运行时强制（方案 §6.4）：

    有效权限 = 角色白名单（role_registry） ∩ 任务授权能力 ∩ 部署策略

- **角色白名单**来自 role_registry，无通配符；orchestrator/planner/reviewer
  默认无 Bash、无扫描、无受控网络。
- **任务授权能力**：P1 中执行会话绑定到（至多）一个已认领方向
  （task_id）；http_request 只面向授权范围内目标（guardian 同源的
  scope/out_of_scope 判定）。
- **部署策略**：当前为严格模式（网关 mediation 的工具循环一律过滤；
  方案 §6.4“不能悄悄退回拥有任意 Shell 的运行”）。

项目绑定（方案 §6.4）：project/run/job/角色由运行时凭据绑定
（``ToolGateway.from_extra`` 只读 DriverConfig.extra，extra 由
execution.run_member 从 TeamMember/调度上下文注入）；模型参数中的
``project_id``/``run_id``/``control_version`` 等同名服务端字段一律丢弃。

审计（方案 §8.2）：每次调用写入项目 ``tool_calls.jsonl``（附加日志，
不是第二套业务权威）；业务结果一律经 ``worker.submit_payload`` →
CommitPlanner → CommitCoordinator → Projector 提交链。

未实现/未到阶段能力返回 ``capability_missing`` 并说明缺口，不用假结果
代替（方案 §6.2 尾注）。
"""

from __future__ import annotations

import hashlib
import json
import re
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urljoin, urlsplit
from uuid import uuid4

from .context_compiler import redact_prompt
from .role_registry import get_role, role_allows_kind
from .schemas import now_iso
from .store import ProjectStore
from .tool_registry import TOOL_CATALOG, ToolSpec, capability_gap, get_tool


HTTP_TIMEOUT_SECONDS = 30
HTTP_MAX_REDIRECTS = 3
HTTP_DEFAULT_MAX_BYTES = 262_144
WORKSPACE_READ_LIMIT = 64_000
WORKSPACE_WRITE_LIMIT = 256_000

# 模型参数中出现即被丢弃并覆盖为服务端绑定值（P0-契约设计 §3.6）。
SERVER_AUTHORITY_ARGUMENT_FIELDS = (
    "project_id", "run_id", "job_id", "task_id", "control_version",
    "idempotency_key", "input_hash", "params_digest", "proposed_by",
    "claim_worker", "claim_version", "session",
)

_ALLOWED_READ_PREFIXES = (
    "evidence/", ".sorne-work/", "mrecon_observations.jsonl", "facts.jsonl",
    "intents.jsonl", "negative_evidence.jsonl", "human_verdicts.jsonl",
    "technology_observations.jsonl", "target.json", "checklist.json",
    "method_pack.json", "plan_batches.jsonl", "hypotheses.jsonl",
    # P2：计划任务图/覆盖账本/review 回流（只读）
    "plan_graphs.jsonl", "coverage_ledger.jsonl", "review_records.jsonl",
    "review_flags.jsonl",
)
_DENIED_READ_PREFIXES = (
    "control_plane.db", ".sorne-runtime/", "team_config.json",
    "prompt_snapshots/",
)


class ToolGatewayError(RuntimeError):
    pass


@dataclass
class GatewayIdentity:
    """服务端绑定的调用身份（绝不取自模型参数）。"""

    vendor: str
    member_name: str
    role: str
    run_id: str | None = None
    job_id: str | None = None
    task_id: str | None = None
    claim_worker: str | None = None
    claim_version: int | None = None
    control_version: int | None = None
    strict: bool = True

    def redacted(self) -> dict[str, Any]:
        return {
            "vendor": self.vendor,
            "member": self.member_name,
            "role": self.role,
            "run_id": self.run_id,
            "job_id": self.job_id,
            "task_id": self.task_id,
            "control_version": self.control_version,
            "strict": self.strict,
        }


@dataclass
class ToolCallAudit:
    tool_call_id: str
    tool_id: str
    status: str
    started_at: str
    ended_at: str | None = None
    error_kind: str | None = None
    duration_ms: int = 0
    identity: dict[str, Any] = field(default_factory=dict)
    input_digest: str | None = None
    output_summary: str | None = None


def _digest(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(value, ensure_ascii=False, sort_keys=True, default=str).encode("utf-8")
    ).hexdigest()[:16]


class ToolGateway:
    def __init__(
        self,
        store: ProjectStore,
        identity: GatewayIdentity,
        *,
        cancel_check: Callable[[], bool] | None = None,
    ):
        self.store = store
        self.identity = identity
        self.cancel_check = cancel_check or (lambda: False)
        self._compat_executor: Callable[[str], tuple[str, bool]] | None = None
        spec = get_role(identity.role)
        if spec is None:
            raise ToolGatewayError(f"工具网关拒绝未知角色: {identity.role}")
        self.role_spec = spec

    # ── 身份绑定 ─────────────────────────────────────────────────────
    @classmethod
    def from_extra(
        cls,
        extra: dict[str, Any],
        *,
        cancel_check: Callable[[], bool] | None = None,
    ) -> "ToolGateway | None":
        """从运行时路由数据（DriverConfig.extra）构造网关。

        extra 由 execution.run_member 注入（成员配置 + 调度绑定），不经手
        模型输出。缺少 role/project_path 时返回 None（调用方退回原有行为）。
        """
        role = str(extra.get("role") or "").strip()
        project_path = str(extra.get("project_path") or "").strip()
        if not role or not project_path:
            return None
        path = Path(project_path)
        vendor = path.name
        store = ProjectStore(vendor)
        def _optional_int(key: str) -> int | None:
            raw = extra.get(key)
            return int(raw) if raw is not None else None
        identity = GatewayIdentity(
            vendor=vendor,
            member_name=str(extra.get("member_name") or role),
            role=role,
            run_id=extra.get("run_id") or None,
            job_id=extra.get("job_id") or None,
            task_id=extra.get("task_id") or None,
            claim_worker=extra.get("claim_worker") or None,
            claim_version=_optional_int("claim_version"),
            control_version=_optional_int("control_version"),
            strict=bool(extra.get("tool_strict", True)),
        )
        return cls(store, identity, cancel_check=cancel_check)

    def bind_compat_executor(self, executor: Callable[[str], tuple[str, bool]]) -> None:
        """旧角色迁移期 Bash 通路的执行适配（仅 compat_bash 白名单角色可用）。"""
        self._compat_executor = executor

    # ── 权限交集（§6.4）──────────────────────────────────────────────
    def granted_capabilities(self) -> frozenset[str]:
        """角色白名单 ∩ 已实现能力 ∩ 部署策略（严格模式）。"""
        effective = self.role_spec.effective_capabilities()
        if not self.identity.strict:
            # 严格模式关闭仅存在于显式部署策略，当前没有任何入口设置；
            # 保留分支使策略位置显式可见，而不是散落在各执行器里。
            return effective
        return effective

    def authorize(self, capability_id: str) -> tuple[bool, str]:
        capability_id = str(capability_id or "").strip()
        alias = {"Bash": "compat_bash"}.get(capability_id, capability_id)
        if alias not in TOOL_CATALOG:
            return False, f"capability_missing: 能力 {capability_id} 不在工具目录中"
        if alias not in self.role_spec.capabilities:
            return False, (
                f"permission_denied: 角色 {self.identity.role} 无能力 {alias}；"
                "本次调用已被运行时网关拒绝（角色白名单不含该能力）。"
            )
        if alias not in self.granted_capabilities():
            return False, capability_gap(alias)
        return True, ""

    def tool_definitions(self) -> list[dict[str, Any]]:
        """模型可见工具契约（由注册表生成；Prompt 不手写另一份）。"""
        definitions: list[dict[str, Any]] = []
        for capability_id in sorted(self.granted_capabilities()):
            spec = TOOL_CATALOG[capability_id]
            if not spec.visible_to_model:
                continue
            definitions.append({
                "type": "function",
                "function": {
                    "name": spec.callable_name,
                    "description": spec.description,
                    "parameters": spec.parameters,
                },
            })
        if "compat_bash" in self.granted_capabilities():
            spec = TOOL_CATALOG["compat_bash"]
            definitions.append({
                "type": "function",
                "function": {
                    "name": "Bash",
                    "description": spec.description,
                    "parameters": spec.parameters,
                },
            })
        return definitions

    # ── 参数验证 + 派发 + 审计 ────────────────────────────────────────
    def dispatch(self, name: str, arguments: dict[str, Any] | None) -> tuple[str, bool]:
        name = str(name or "").strip()
        arguments = dict(arguments or {})
        dropped = [key for key in SERVER_AUTHORITY_ARGUMENT_FIELDS if key in arguments]
        for key in dropped:
            arguments.pop(key)
        allowed, reason = self.authorize(name)
        tool_call_id = f"TC-{_digest((name, now_iso(), self.identity.member_name))}"
        audit = ToolCallAudit(
            tool_call_id=tool_call_id,
            tool_id={"Bash": "compat_bash"}.get(name, name),
            status="started",
            started_at=now_iso(),
            identity=self.identity.redacted(),
            input_digest=_digest(arguments),
        )
        if not allowed:
            audit.status = "rejected"
            audit.error_kind = "permission_denied" if reason.startswith("permission_denied") else "capability_missing"
            self._audit(audit, output=reason, dropped_server_fields=dropped)
            return reason, True
        spec = get_tool({"Bash": "compat_bash"}.get(name, name))
        assert spec is not None
        validation_error = _validate_arguments(spec, arguments)
        if validation_error:
            audit.status = "rejected"
            audit.error_kind = "invalid_arguments"
            message = f"invalid_arguments: {validation_error}"
            self._audit(audit, output=message, dropped_server_fields=dropped)
            return message, True
        executor = self._executor_for(spec.id)
        started = time.monotonic()
        try:
            if self.cancel_check():
                raise ToolGatewayError("任务已被调度器取消")
            result = executor(arguments)
            audit.status = "ok"
            output = json.dumps(result, ensure_ascii=False, default=str)
        except ToolGatewayError as exc:
            audit.status = "failed"
            message = str(exc)
            audit.error_kind = (
                "capability_missing" if message.startswith("capability_missing")
                else "approval_required" if message.startswith("approval_required")
                else "gateway_error"
            )
            output = f"tool_error: {exc}"
        except Exception as exc:  # noqa: BLE001 —— 工具错误必须回传模型而不是中断循环
            audit.status = "failed"
            message = f"{type(exc).__name__}: {exc}"
            audit.error_kind = (
                "capability_missing" if message.startswith("capability_missing")
                else type(exc).__name__
            )
            output = f"tool_error: {message}"
        audit.duration_ms = int((time.monotonic() - started) * 1000)
        is_error = audit.status != "ok"
        if len(output) > 12_000:
            output = output[:6_000] + "\n... [工具输出已截断] ...\n" + output[-4_000:]
        output = redact_prompt(output)
        self._audit(audit, output=output, dropped_server_fields=dropped)
        return output, is_error

    def _audit(
        self,
        audit: ToolCallAudit,
        *,
        output: str,
        dropped_server_fields: list[str] | None = None,
    ) -> None:
        audit.ended_at = now_iso()
        record = {
            "tool_call_id": audit.tool_call_id,
            "tool_id": audit.tool_id,
            "project_id": self.identity.vendor,
            "run_id": self.identity.run_id,
            "job_id": self.identity.job_id,
            "task_id": self.identity.task_id,
            "role": self.identity.role,
            "member": self.identity.member_name,
            "control_version": self.identity.control_version,
            "status": audit.status,
            "error_kind": audit.error_kind,
            "started_at": audit.started_at,
            "ended_at": audit.ended_at,
            "duration_ms": audit.duration_ms,
            "input_digest": audit.input_digest,
            "dropped_server_fields": dropped_server_fields or [],
            "output_summary": output[:600],
        }
        try:
            self.store.append_jsonl("tool_calls.jsonl", record)
        except OSError:
            # 审计落盘失败不阻断工具回环；业务提交链仍有自身的持久化校验。
            pass

    def _executor_for(self, capability_id: str) -> Callable[[dict[str, Any]], Any]:
        executors: dict[str, Callable[[dict[str, Any]], Any]] = {
            "project_summary": self._tool_project_summary,
            "route_candidates": self._tool_route_candidates,
            "query_results": self._tool_query_results,
            "query_http": self._tool_query_http,
            "list_facts": self._tool_list_facts,
            "target_profile_query": self._tool_target_profile_query,
            "query_evidence": self._tool_query_evidence,
            "rule_query": self._tool_rule_query,
            "analysis_query": self._tool_analysis_query,
            "tool_query": self._tool_tool_query,
            "submit_plan": self._tool_submit_plan,
            "submit_dispatch": self._tool_submit_dispatch,
            "query_execution": self._tool_query_execution,
            "finish_task": self._tool_finish_task,
            "poc_scan": self._tool_poc_scan,
            "http_request": self._tool_http_request,
            "session_ref": self._tool_session_ref,
            "record_finding": self._tool_record_finding,
            "upsert_fact": self._tool_upsert_fact,
            "technology_observe": self._tool_technology_observe,
            "negative_evidence_submit": self._tool_negative_evidence_submit,
            "submit_review": self._tool_submit_review,
            "load_skill": self._tool_load_skill,
            "skill_query": self._tool_skill_query,
            "workspace_read": self._tool_workspace_read,
            "workspace_list": self._tool_workspace_list,
            "workspace_write": self._tool_workspace_write,
            "helper_recipe": self._tool_helper_recipe,
            "compat_bash": self._tool_compat_bash,
        }
        executor = executors.get(capability_id)
        if executor is None:
            raise ToolGatewayError(capability_gap(capability_id))
        return executor

    # ── 项目读取 ─────────────────────────────────────────────────────
    def _tool_project_summary(self, arguments: dict[str, Any]) -> dict[str, Any]:
        state = self.store.load_state()
        target = self.store.read_json("target.json")
        from .database import ControlDatabase

        active_run = None
        database_path = self.store.path / "control_plane.db"
        if database_path.exists():
            database = ControlDatabase(database_path)
            run_id = self.identity.run_id
            run = database.get_run(run_id) if run_id else None
            if run is None:
                run = database.latest_resumable_run()
            if run is not None:
                active_run = {
                    "run_id": run["id"],
                    "status": run["status"],
                    "stage": run.get("stage"),
                    "wave": run.get("wave"),
                }
        return {
            "vendor": self.identity.vendor,
            "phase": state.phase,
            "current_task": state.current_task,
            "asset_count": state.asset_count,
            "fact_count": state.fact_count,
            "vulnerability_count": state.vulnerability_count,
            "pending_human_review_count": state.pending_human_review_count,
            "gate_status": state.gate_status,
            "authorization": target.get("authorization"),
            "scope": target.get("scope"),
            "out_of_scope": target.get("out_of_scope"),
            "targets": (target.get("targets") or [])[:50],
            "goal": target.get("goal"),
            "active_run": active_run,
        }

    def _tool_route_candidates(self, arguments: dict[str, Any]) -> dict[str, Any]:
        limit = _bound_int(arguments.get("limit"), default=20, minimum=1, maximum=100)
        from .database import ControlDatabase
        from .target_profile import target_assessments

        directions: list[dict[str, Any]] = []
        database_path = self.store.path / "control_plane.db"
        if database_path.exists():
            directions = [
                {
                    "direction_id": item.get("id"),
                    "verb": (item.get("intent") or {}).get("verb"),
                    "target": (item.get("intent") or {}).get("target"),
                    "hypothesis": (item.get("intent") or {}).get("hypothesis"),
                    "status": item.get("status"),
                    "priority_score": (item.get("intent") or {}).get("priority_score"),
                }
                for item in ControlDatabase(database_path).list_directions()
                if item.get("status") in {"open", "released"}
            ]
        facts = [
            {
                "fact_id": item.get("id"),
                "title": item.get("title"),
                "classification": item.get("classification"),
                "severity": item.get("severity"),
                "target": (item.get("assets") or [])[:3],
            }
            for item in self.store.read_jsonl("facts.jsonl")
            if item.get("classification") in {"risk_lead", "vulnerability"}
        ]
        priority = [
            {
                "url": item.get("url"),
                "profile_class": item.get("profile_class"),
                "function": item.get("function"),
            }
            for item in target_assessments(self.store)
            if item.get("profile_class") == "priority_target"
        ]
        return {
            "open_directions": directions[:limit],
            "open_direction_count": len(directions),
            "candidate_facts": list(reversed(facts))[:limit],
            "priority_targets": priority[:limit],
        }

    def _tool_query_results(self, arguments: dict[str, Any]) -> dict[str, Any]:
        from .mrecon import compact_mrecon_rows
        from .target_profile import target_assessments

        keyword = str(arguments.get("keyword") or "").strip().casefold()
        url_prefix = str(arguments.get("url") or "").strip().casefold()
        limit = _bound_int(arguments.get("limit"), default=30, minimum=1, maximum=200)

        def match(row: dict[str, Any]) -> bool:
            blob = json.dumps(row, ensure_ascii=False).casefold()
            url = str(row.get("url") or "").casefold()
            if url_prefix and not url.startswith(url_prefix):
                return False
            return not keyword or keyword in blob

        observations = [row for row in compact_mrecon_rows(self.store) if match(row)]
        assessments = [row for row in target_assessments(self.store) if match(row)]
        technology = [
            row for row in self.store.read_jsonl("technology_observations.jsonl")
            if match(row)
        ]
        return {
            "mrecon_observations": observations[:limit],
            "target_assessments": assessments[:limit],
            "technology_observations": technology[:limit],
            "counts": {
                "mrecon": len(observations),
                "assessments": len(assessments),
                "technology": len(technology),
            },
        }

    def _tool_query_http(self, arguments: dict[str, Any]) -> dict[str, Any]:
        from .mrecon import compact_mrecon_rows

        keyword = str(arguments.get("keyword") or "").strip().casefold()
        status = arguments.get("status")
        limit = _bound_int(arguments.get("limit"), default=30, minimum=1, maximum=200)
        rows = []
        for row in compact_mrecon_rows(self.store):
            url = str(row.get("url") or "").casefold()
            blob = json.dumps(row, ensure_ascii=False).casefold()
            if keyword and keyword not in blob and keyword not in url:
                continue
            if status is not None and row.get("status") != int(status):
                continue
            rows.append(row)
        return {
            "http_records": rows[:limit],
            "total": len(rows),
            "note": "记录来自既有采集（mrecon）；如需新的请求对照请使用 http_request。",
        }

    def _tool_list_facts(self, arguments: dict[str, Any]) -> dict[str, Any]:
        classification = str(arguments.get("classification") or "").strip()
        limit = _bound_int(arguments.get("limit"), default=30, minimum=1, maximum=200)
        rows = []
        for item in self.store.read_jsonl("facts.jsonl"):
            if classification and item.get("classification") != classification:
                continue
            rows.append({
                key: item.get(key)
                for key in (
                    "id", "title", "category", "classification", "status",
                    "severity", "confidence", "assets", "evidence_path",
                    "review_status", "created_at",
                )
                if item.get(key) not in (None, "", [], {})
            })
        return {"facts": list(reversed(rows))[:limit], "total": len(rows)}

    def _tool_target_profile_query(self, arguments: dict[str, Any]) -> dict[str, Any]:
        from .target_profile import routine_target_groups, target_assessments

        url_prefix = str(arguments.get("url") or "").strip().casefold()
        profile_class = str(arguments.get("profile_class") or "").strip()
        limit = _bound_int(arguments.get("limit"), default=30, minimum=1, maximum=200)
        rows = []
        for row in target_assessments(self.store):
            if url_prefix and not str(row.get("url") or "").casefold().startswith(url_prefix):
                continue
            if profile_class and row.get("profile_class") != profile_class:
                continue
            rows.append({
                key: row.get(key)
                for key in ("id", "url", "profile_class", "function", "technology_stack", "created_at")
                if row.get(key) not in (None, "", [], {})
            })
        return {
            "assessments": rows[:limit],
            "routine_groups": routine_target_groups(self.store)[:20],
        }

    def _tool_query_evidence(self, arguments: dict[str, Any]) -> dict[str, Any]:
        prefix = str(arguments.get("path_prefix") or "").strip().casefold()
        limit = _bound_int(arguments.get("limit"), default=50, minimum=1, maximum=200)
        records = [
            {
                key: item.get(key)
                for key in ("id", "fact_id", "path", "sha256", "size_bytes", "created_at")
                if item.get(key) not in (None, "", [], {})
            }
            for item in self.store.read_jsonl("evidence.jsonl")
            if not prefix or str(item.get("path") or "").casefold().startswith(prefix)
        ]
        # 工具网关/mrecon 直接落盘的证据文件没有 fact 关联登记，按文件系统
        # 补充（evidence/ 下的实际文件，带大小与修改时间）。
        seen_paths = {str(item.get("path")) for item in records}
        evidence_root = self.store.path / "evidence"
        if evidence_root.is_dir():
            for file in sorted(evidence_root.rglob("*")):
                if not file.is_file() or file.name.endswith(".sha256"):
                    continue
                relative = file.relative_to(self.store.path).as_posix()
                if prefix and not relative.casefold().startswith(prefix):
                    continue
                if relative in seen_paths:
                    continue
                stat = file.stat()
                if stat.st_size == 0:
                    continue
                records.append({
                    "path": relative,
                    "size_bytes": stat.st_size,
                    "created_at": None,
                    "source": "filesystem",
                })
                if len(records) >= limit * 2:
                    break
        return {"evidence_records": list(reversed(records))[:limit], "total": len(records)}

    def _tool_rule_query(self, arguments: dict[str, Any]) -> dict[str, Any]:
        def _read_optional(name: str) -> dict[str, Any]:
            path = self.store.path / name
            if not path.is_file():
                return {}
            try:
                value = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                return {}
            return value if isinstance(value, dict) else {}

        checklist = _read_optional("checklist.json")
        method_pack = _read_optional("method_pack.json")
        return {
            "checklist": checklist,
            "method_pack_dimensions": sorted(
                str(item.get("dimension") or item.get("id") or "")
                for item in (method_pack.get("hypotheses") or method_pack.get("dimensions") or [])
                if isinstance(item, dict)
            )[:40],
            "note": "检查清单红线与方法包约束高于任何角色自主判断。",
        }

    def _tool_tool_query(self, arguments: dict[str, Any]) -> dict[str, Any]:
        capability_id = str(arguments.get("capability_id") or "").strip()
        if capability_id:
            spec = get_tool(capability_id)
            if spec is None:
                return {"capability": capability_id, "available": False, "gap": capability_gap(capability_id)}
            return {
                "capability": spec.id,
                "category": spec.category,
                "description": spec.description,
                "parameters": spec.parameters,
                "implemented": spec.implemented,
                "available_from_phase": spec.available_from_phase,
                "granted_to_current_role": spec.id in self.role_spec.capabilities,
                "available_in_current_session": spec.id in self.granted_capabilities(),
            }
        return {
            "catalog": [
                {
                    "capability": spec.id,
                    "category": spec.category,
                    "implemented": spec.implemented,
                    "available_from_phase": spec.available_from_phase,
                    "granted_to_current_role": spec.id in self.role_spec.capabilities,
                }
                for spec in sorted(TOOL_CATALOG.values(), key=lambda item: (item.category, item.id))
            ],
            "role_granted": sorted(self.granted_capabilities()),
        }

    # ── 计划协调 ─────────────────────────────────────────────────────
    def _tool_submit_plan(self, arguments: dict[str, Any]) -> dict[str, Any]:
        plan = arguments.get("plan")
        if not isinstance(plan, dict):
            raise ToolGatewayError("submit_plan 需要 plan 对象")
        kind = str(plan.get("kind") or "plan_batch")
        if kind != "plan_batch":
            raise ToolGatewayError(f"submit_plan 只接受 plan_batch（收到 {kind}）")
        if not role_allows_kind(self.identity.role, "plan_batch"):
            raise ToolGatewayError(f"角色 {self.identity.role} 不允许输出 plan_batch")
        tasks = plan.get("tasks")
        if isinstance(tasks, list) and tasks:
            # P2 任务图路径（方案 §4.2-4.3）：depends_on 显式校验（环/缺失
            # 父任务/跨项目/能力/授权范围）+ 方向注册（胶囊字段入 v8 列）。
            from .plan_graph import PlanGraphError, submit_plan_graph
            from .database import ControlDatabase

            database_path = self.store.path / "control_plane.db"
            if not database_path.exists():
                raise ToolGatewayError("当前项目没有控制平面数据库")
            try:
                record = submit_plan_graph(
                    self.store,
                    ControlDatabase(database_path),
                    plan,
                    proposed_by=self.identity.member_name,
                    run_id=self.identity.run_id,
                )
            except PlanGraphError as exc:
                raise ToolGatewayError(f"计划被拒绝（未入库任何任务）: {exc}") from exc
            return {
                "accepted": True,
                "plan_id": record["plan_id"],
                "tasks": [
                    {
                        "task_key": item["task_key"],
                        "direction_id": item["direction_id"],
                        "created": item["created"],
                    }
                    for item in record["tasks"]
                ],
                "note": (
                    "任务图已注册为方向（depends_on 已校验；依赖满足前不可认领）。"
                    "派发由编排角色 submit_dispatch 激活，本工具不派发。"
                ),
            }
        payload = dict(plan)
        payload["kind"] = "plan_batch"
        payload["proposed_by"] = self.identity.member_name
        message = self._submit_through_commit_chain(payload)
        return {"accepted": True, "message": message}

    def _tool_submit_dispatch(self, arguments: dict[str, Any]) -> dict[str, Any]:
        from .database import ControlDatabase

        database_path = self.store.path / "control_plane.db"
        if not database_path.exists():
            raise ToolGatewayError("当前项目没有控制平面数据库")
        database = ControlDatabase(database_path)
        direction_id = str(arguments.get("direction_id") or "").strip()
        reason = str(arguments.get("reason") or "").strip()
        if not direction_id or not reason:
            raise ToolGatewayError("submit_dispatch 需要 direction_id 与 reason")
        changed = database.prioritize_direction(
            direction_id,
            1_000_000.0,
            reason=reason,
            run_id=self.identity.run_id,
        )
        if not changed:
            direction = database.get_direction(direction_id)
            if direction is None:
                raise ToolGatewayError(f"方向 {direction_id} 不存在；dispatch 只激活已有任务，不创建新任务")
            raise ToolGatewayError(
                f"方向 {direction_id} 当前状态为 {direction.get('status')}，不可派发"
            )
        return {
            "dispatched": direction_id,
            "note": "已提升该方向认领优先级；不创建重复任务、不改写计划语义。",
        }

    def _tool_query_execution(self, arguments: dict[str, Any]) -> dict[str, Any]:
        from .database import ControlDatabase

        limit = _bound_int(arguments.get("limit"), default=30, minimum=1, maximum=200)
        database_path = self.store.path / "control_plane.db"
        if not database_path.exists():
            return {"run": None, "jobs": []}
        database = ControlDatabase(database_path)
        run = database.get_run(self.identity.run_id) if self.identity.run_id else None
        if run is None:
            run = database.latest_resumable_run()
        jobs = []
        if run is not None:
            for job in database.list_jobs(str(run["id"])):
                jobs.append({
                    "job_id": job.get("id"),
                    "stage": job.get("stage"),
                    "role": job.get("role"),
                    "member": job.get("member_name"),
                    "status": job.get("status"),
                    "error": str(job.get("error") or "")[:200] or None,
                    "wave": job.get("wave"),
                })
        return {
            "run": {
                "run_id": run["id"],
                "status": run["status"],
                "stage": run.get("stage"),
                "wave": run.get("wave"),
                "control_version": run.get("control_version"),
            } if run else None,
            "jobs": list(reversed(jobs))[:limit],
            "pending_approvals": self._pending_approvals()[:20],
            "waiting_dependencies": [
                {
                    "direction_id": item.get("id"),
                    "verb": (item.get("intent") or {}).get("verb"),
                    "blockers": database.direction_dependencies(str(item.get("id"))),
                }
                for item in database.list_directions()
                if item.get("status") in {"open", "released"}
                and (item.get("depends_on") or [])
                and any(
                    blocker.get("status") != "completed"
                    for blocker in database.direction_dependencies(str(item.get("id")))
                )
            ][:20],
            "analysis_jobs": [
                {
                    "analysis_job_id": job.get("id"),
                    "analyzer_kind": job.get("analyzer_kind"),
                    "status": job.get("status"),
                    "source_task_id": job.get("source_task_id"),
                }
                for job in database.list_analysis_jobs()
                if job.get("status") in {"queued", "running", "failed"}
            ][:20],
        }

    def _pending_approvals(self) -> list[dict[str, Any]]:
        """待审批动作（reviewer action_review 的输入来源；服务端组装）。"""
        rows = [
            item for item in self.store.read_jsonl("pending_approvals.jsonl")
            if not item.get("resolved_at")
        ]
        from .database import ControlDatabase

        database_path = self.store.path / "control_plane.db"
        database = (
            ControlDatabase(database_path)
            if database_path.exists() else None
        )
        result: list[dict[str, Any]] = []
        for row in rows[-40:]:
            ticket = (
                database.find_action_ticket(
                    task_id=str(row.get("task_id") or ""),
                    tool_id=str(row.get("tool_id") or ""),
                    params_digest=str(row.get("params_digest") or ""),
                    control_version=int(row.get("control_version") or 0),
                )
                if database is not None else None
            )
            entry = dict(row)
            entry["approved"] = ticket is not None
            result.append(entry)
        return result

    def _tool_finish_task(self, arguments: dict[str, Any]) -> dict[str, Any]:
        from .database import ControlDatabase

        outcome = str(arguments.get("outcome") or "").strip()
        reason = str(arguments.get("reason") or "").strip()
        if outcome not in {"completed", "blocked"}:
            raise ToolGatewayError("finish_task 的 outcome 只能是 completed 或 blocked")
        database_path = self.store.path / "control_plane.db"
        if not database_path.exists():
            raise ToolGatewayError("当前项目没有控制平面数据库")
        database = ControlDatabase(database_path)
        if self.identity.task_id and self.identity.claim_worker:
            # 执行角色：只终结本次绑定任务，按认领者+认领版本校验
            # （旧认领结果不得终结新认领）。
            task_id = self.identity.task_id
            worker = self.identity.claim_worker
            claim_version = self.identity.claim_version
        elif self.identity.run_id and arguments.get("direction_id"):
            # 编排角色：只允许终结“当前运行内”已认领任务（claimed_by 以
            # run_id 为前缀），不越运行、不碰他人项目。
            task_id = str(arguments.get("direction_id") or "").strip()
            direction = database.get_direction(task_id) if task_id else None
            if direction is None or direction.get("status") != "claimed":
                raise ToolGatewayError(
                    f"任务 {task_id or '(空)'} 不存在或未被认领，无法声明终态"
                )
            if not str(direction.get("claimed_by") or "").startswith(f"{self.identity.run_id}:"):
                raise ToolGatewayError(
                    f"任务 {task_id} 不属于当前运行 {self.identity.run_id}，拒绝跨运行终结"
                )
            worker = str(direction.get("claimed_by"))
            claim_version = None
        else:
            raise ToolGatewayError(
                "finish_task 需要本次绑定任务（执行角色）或当前运行内的 direction_id（编排角色）"
            )
        finished = database.finish_direction(
            task_id,
            worker,
            outcome=outcome,
            reason=f"finish_task:{reason}"[:500],
            claim_version=claim_version,
        )
        if not finished:
            direction = database.get_direction(task_id)
            raise ToolGatewayError(
                "任务终态声明未生效：方向可能已不在原认领（当前状态 "
                f"{(direction or {}).get('status')}）；旧认领结果不得终结新认领。"
            )
        self._after_direction_finished(database, task_id, outcome)
        return {"task_id": task_id, "outcome": outcome, "reason": reason}

    def _after_direction_finished(
        self,
        database,
        task_id: str,
        outcome: str,
    ) -> None:
        """方向终态后的服务端钩子（覆盖账本 + 无命中级联取消）。

        尽力执行：钩子失败不改变任务终态本身，异常记录到事件里。
        """
        try:
            from .coverage_ledger import record_direction_coverage
            from .plan_graph import cascade_cancel_on_no_hit, direction_has_hit

            direction = database.get_direction(task_id)
            if direction is None:
                return
            record_direction_coverage(
                self.store, direction, has_hit=direction_has_hit(self.store, task_id),
            )
            if outcome == "completed":
                cancelled = cascade_cancel_on_no_hit(self.store, database, task_id)
                if cancelled:
                    database.add_event(self.identity.run_id, None, "direction_cascade_cancelled", {
                        "parent": task_id,
                        "cancelled": cancelled,
                        "via": "finish_task",
                    })
        except Exception as exc:  # noqa: BLE001 —— 钩子失败不吞掉任务终态
            try:
                database.add_event(self.identity.run_id, None, "direction_hook_error", {
                    "direction_id": task_id,
                    "error": f"{type(exc).__name__}: {exc}"[:500],
                })
            except Exception:
                pass

    # ── 受控验证 ─────────────────────────────────────────────────────
    def _tool_session_ref(self, arguments: dict[str, Any]) -> dict[str, Any]:
        from .runtime_secrets import RuntimeSecretStore

        member_names: list[str] = []
        try:
            from .team import load_team

            member_names = [item.name for item in load_team("default", self.store)]
        except Exception:  # noqa: BLE001 —— 团队配置缺失时退化为空清单
            member_names = []
        status = RuntimeSecretStore.status(self.store.vendor, member_names)
        available = sorted(name for name, present in status.items() if present)
        return {
            "available_session_refs": available,
            "note": "凭据只以引用名出现；明文由网关解析后注入请求，绝不回显。",
        }

    def _resolve_session(self, session_ref: str) -> dict[str, str]:
        from .runtime_secrets import RuntimeSecretStore

        secret = RuntimeSecretStore.get(self.store.vendor, session_ref)
        if not secret:
            return {}
        headers: dict[str, str] = {}
        first = secret.strip()
        if re.fullmatch(r"[A-Za-z0-9._~+/=-]{8,}", first) and "=" not in first and "." not in first:
            headers["Authorization"] = f"Bearer {first}"
        if "Authorization" not in headers:
            headers["Cookie"] = first
        return headers

    def _scope_hosts(self) -> set[str]:
        target = self.store.read_json("target.json")
        entries = [str(value or "").strip() for value in (target.get("scope") or [])]
        hosts = {
            str(urlsplit(value if "://" in value else f"https://{value}").netloc).casefold()
            for value in entries
            if value
        }
        return {item for item in hosts if item}

    def _check_target_authorization(self, url: str) -> None:
        target = self.store.read_json("target.json")
        if target.get("authorization") != "authorized":
            raise ToolGatewayError("项目尚未确认授权范围，http_request 已拒绝")
        parsed = urlsplit(url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ToolGatewayError(f"仅允许 http(s) URL: {url}")
        scope = self._scope_hosts()
        wildcard = any(str(item).strip() == "*" for item in (target.get("scope") or []))
        if not scope and not wildcard:
            raise ToolGatewayError("授权范围为空，http_request 已拒绝")
        if not wildcard:
            netloc = parsed.netloc.casefold()
            # 授权条目不带端口时按主机匹配（本地夹具/端口变化场景）；
            # 条目显式带端口时仍要求端口一致。
            portless_scope = {item.split(":", 1)[0] for item in scope if ":" not in item}
            host_only = netloc.split(":", 1)[0]
            if netloc not in scope and host_only not in portless_scope:
                raise ToolGatewayError(
                    f"目标 {parsed.netloc} 不在授权范围内（scope: {sorted(scope)}）"
                )
        lowered = url.casefold()
        for denied in target.get("out_of_scope") or []:
            denied_text = str(denied).strip().casefold()
            if denied_text and denied_text in lowered:
                raise ToolGatewayError(f"目标命中不收范围: {denied}")

    def _tool_http_request(self, arguments: dict[str, Any]) -> dict[str, Any]:
        url = str(arguments.get("url") or "").strip()
        method = str(arguments.get("method") or "GET").strip().upper()
        if method not in {"GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"}:
            raise ToolGatewayError(f"不支持的 HTTP 方法: {method}")
        headers = {
            str(key): str(value)
            for key, value in dict(arguments.get("headers") or {}).items()
        }
        for forbidden in ("Authorization", "Cookie"):
            headers.pop(forbidden, None)
        session_headers: dict[str, str] = {}
        session_ref = str(arguments.get("session_ref") or "").strip()
        if session_ref:
            session_headers = self._resolve_session(session_ref)
            if not session_headers:
                raise ToolGatewayError(f"会话引用 {session_ref} 不存在或未配置秘密")
        body = arguments.get("body")
        body_text = str(body) if body is not None else None
        max_bytes = _bound_int(
            arguments.get("max_bytes"), default=HTTP_DEFAULT_MAX_BYTES,
            minimum=1_000, maximum=4_000_000,
        )

        redirect_chain: list[str] = []
        current = url
        status: int | None = None
        raw = b""
        response_headers: dict[str, str] = {}
        opener = urllib.request.build_opener(_NoRedirect())
        for hop in range(HTTP_MAX_REDIRECTS + 1):
            self._check_target_authorization(current)
            if self.cancel_check():
                raise ToolGatewayError("任务已被调度器取消")
            request = urllib.request.Request(
                current,
                data=body_text.encode("utf-8") if (body_text is not None and method in {"POST", "PUT", "PATCH"}) else None,
                headers={**headers, **session_headers},
                method=method,
            )
            try:
                with opener.open(request, timeout=HTTP_TIMEOUT_SECONDS) as response:
                    status = int(response.status)
                    raw = response.read(max_bytes + 1)
                    response_headers = {str(key): str(value) for key, value in response.headers.items()}
            except urllib.error.HTTPError as exc:
                status = int(exc.code)
                raw = exc.read(max_bytes + 1)
                response_headers = {str(key): str(value) for key, value in (exc.headers or {}).items()}
            except urllib.error.URLError as exc:
                raise ToolGatewayError(f"请求失败: {exc.reason}") from exc
            except (TimeoutError, OSError) as exc:
                raise ToolGatewayError(f"请求失败: {exc}") from exc
            location = next(
                (
                    value for key, value in response_headers.items()
                    if key.casefold() == "location"
                ),
                None,
            )
            if status in {301, 302, 303, 307, 308} and location:
                if hop >= HTTP_MAX_REDIRECTS:
                    raise ToolGatewayError(
                        f"重定向超过 {HTTP_MAX_REDIRECTS} 跳: {redirect_chain + [location]}"
                    )
                current = urljoin(current, location)
                redirect_chain.append(current)
                continue
            break
        if status is None:
            raise ToolGatewayError("请求未产生响应")
        truncated = len(raw) > max_bytes
        raw = raw[:max_bytes]
        evidence_path = self._write_http_evidence(
            url=current,
            original_url=url,
            method=method,
            request_headers={
                **headers,
                **({"X-Sorne-Session-Ref": session_ref} if session_ref else {}),
            },
            status=int(status),
            response_headers=response_headers,
            body=raw,
            truncated=truncated,
            redirect_chain=redirect_chain,
        )
        text_preview = raw[:4_000].decode("utf-8", errors="replace")
        return {
            "url": current,
            "original_url": url,
            "redirect_chain": redirect_chain,
            "status": int(status),
            "headers": {
                key: value for key, value in list(response_headers.items())[:30]
            },
            "body_preview": text_preview,
            "body_bytes": len(raw),
            "body_truncated": truncated,
            "evidence_path": evidence_path,
            "note": "请求/响应已落盘证据；body_preview 仅供判读，复核以证据文件为准。",
        }

    def _write_http_evidence(
        self,
        *,
        url: str,
        original_url: str,
        method: str,
        request_headers: dict[str, str],
        status: int,
        response_headers: dict[str, str],
        body: bytes,
        truncated: bool,
        redirect_chain: list[str],
    ) -> str:
        parsed = urlsplit(url)
        request_block = "\r\n".join(
            [f"{method} {parsed.path or '/'}{'?' + parsed.query if parsed.query else ''} HTTP/1.1", f"Host: {parsed.netloc}"]
            + [f"{key}: {value}" for key, value in request_headers.items()]
        )
        response_block = "\r\n".join(
            [f"HTTP/1.1 {status}"]
            + [f"{key}: {value}" for key, value in response_headers.items()]
            + [f"X-Sorne-Body-Truncated: {'true' if truncated else 'false'}"]
        )
        head = (
            f"# Sorne tool_gateway http_request\r\n"
            f"# original_url: {original_url}\r\n"
            f"# redirect_chain: {', '.join(redirect_chain) or '(none)'}\r\n"
            f"# role: {self.identity.role} member: {self.identity.member_name}\r\n"
            f"# run: {self.identity.run_id or '-'} task: {self.identity.task_id or '-'}\r\n"
            "\r\n" + request_block + "\r\n\r\n" + response_block + "\r\n\r\n"
        ).encode("utf-8", errors="replace")
        transcript = head + body
        digest = hashlib.sha256(transcript).hexdigest()
        relative = Path("evidence") / "gateway" / f"{digest}.http"
        destination = self.store.path / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        if not destination.exists():
            destination.write_bytes(transcript)
            destination.with_name(destination.name + ".sha256").write_text(
                f"{digest}  {destination.name}\n", encoding="utf-8"
            )
        return relative.as_posix()

    # ── 业务提交（一律经提交链）───────────────────────────────────────
    def _submit_through_commit_chain(self, payload: dict[str, Any]) -> str:
        from .worker import submit_payload

        # 幂等键按“单次工具调用”粒度生成：同一 Job 内多次 record_finding 是
        # 多条不同候选，不能共用一个键被去重吞掉；提交链自身的
        # ON CONFLICT 语义保证崩溃重放不产生重复投影。
        idempotency_key = (
            f"tool:{self.identity.job_id or self.identity.member_name}:"
            f"{uuid4().hex[:12]}:{payload.get('kind', 'unknown')}"
        )
        # 注意不传 job_id：job 通道只在 Job 完成后接受候选（complete_job →
        # _commit_candidates 语义）；工具循环内的提交发生在 Job 运行中，
        # 因此按 Run 级 fencing（run_id + control_version，投影期校验运行
        # 状态与控制版本）走链；审计与 source_id 仍记录 job_id 供溯源。
        return submit_payload(
            self.store,
            payload,
            source_type="tool_gateway",
            source_id=self.identity.job_id or self.identity.member_name,
            idempotency_key=idempotency_key,
            run_id=self.identity.run_id,
            job_id=None,
            control_version=self.identity.control_version,
        )

    def _tool_record_finding(self, arguments: dict[str, Any]) -> dict[str, Any]:
        payload = {
            key: arguments.get(key)
            for key in (
                "title", "category", "classification", "evidence", "business_impact",
                "reproduction_steps", "evidence_path", "severity", "confidence",
                "assets", "intent_id", "hypothesis_id",
            )
            if arguments.get(key) is not None
        }
        payload["kind"] = "fact"
        payload["proposed_by"] = self.identity.member_name
        if self.identity.task_id and not payload.get("intent_id"):
            payload["intent_id"] = self.identity.task_id
        message = self._submit_through_commit_chain(payload)
        return {"accepted": True, "message": message}

    def _tool_upsert_fact(self, arguments: dict[str, Any]) -> dict[str, Any]:
        updates_fact_id = str(arguments.get("updates_fact_id") or "").strip()
        if not updates_fact_id:
            raise ToolGatewayError("upsert_fact 需要 updates_fact_id")
        known = {
            str(item.get("id")) for item in self.store.read_jsonl("facts.jsonl")
        }
        if updates_fact_id not in known:
            raise ToolGatewayError(f"被更新的事实 {updates_fact_id} 不存在")
        payload = {
            key: arguments.get(key)
            for key in (
                "title", "category", "classification", "evidence", "business_impact",
                "reproduction_steps", "evidence_path", "severity", "confidence",
                "assets",
            )
            if arguments.get(key) is not None
        }
        payload["kind"] = "fact"
        payload["proposed_by"] = self.identity.member_name
        payload["updates_fact_id"] = updates_fact_id
        message = self._submit_through_commit_chain(payload)
        return {
            "accepted": True,
            "message": message,
            "note": "更新以链接到原事实的追加版本记录提交；原记录不删除。",
        }

    def _tool_technology_observe(self, arguments: dict[str, Any]) -> dict[str, Any]:
        observations = arguments.get("observations")
        if not isinstance(observations, list) or not observations:
            raise ToolGatewayError("technology_observe 需要 observations 数组")
        payload = {
            "kind": "none",
            "reason": "technology observation via tool gateway",
            "technology_observations": observations,
            "proposed_by": self.identity.member_name,
        }
        message = self._submit_through_commit_chain(payload)
        return {"accepted": True, "message": message, "observations": len(observations)}

    def _tool_negative_evidence_submit(self, arguments: dict[str, Any]) -> dict[str, Any]:
        payload = {
            key: arguments.get(key)
            for key in (
                "hypothesis", "target", "reason", "method", "outcome",
                "evidence_type", "evidence_paths",
            )
            if arguments.get(key) is not None
        }
        payload["kind"] = "negative_evidence"
        payload["proposed_by"] = self.identity.member_name
        message = self._submit_through_commit_chain(payload)
        return {"accepted": True, "message": message}

    # ── 本地辅助（受限）──────────────────────────────────────────────
    def _resolve_read_path(self, raw: str) -> Path:
        relative = Path(str(raw or "").strip())
        if relative.is_absolute() or ".." in relative.parts:
            raise ToolGatewayError("workspace_read 只接受项目内相对路径，禁止绝对路径或 ..")
        posix = relative.as_posix()
        if any(posix.startswith(prefix) for prefix in _DENIED_READ_PREFIXES):
            raise ToolGatewayError(f"路径不在允许读取范围: {posix}")
        if not any(posix == item or posix.startswith(item) for item in _ALLOWED_READ_PREFIXES):
            raise ToolGatewayError(f"路径不在允许读取范围: {posix}")
        resolved = (self.store.path / relative).resolve()
        try:
            resolved.relative_to(self.store.path.resolve())
        except ValueError as exc:
            raise ToolGatewayError(f"路径越界: {posix}") from exc
        return resolved

    def _tool_workspace_read(self, arguments: dict[str, Any]) -> dict[str, Any]:
        path = self._resolve_read_path(arguments.get("path"))
        if not path.is_file():
            raise ToolGatewayError(f"文件不存在: {arguments.get('path')}")
        limit = _bound_int(
            arguments.get("max_bytes"), default=WORKSPACE_READ_LIMIT,
            minimum=100, maximum=1_000_000,
        )
        data = path.read_bytes()[:limit]
        text = data.decode("utf-8", errors="replace")
        return {
            "path": str(arguments.get("path")),
            "bytes": len(data),
            "truncated": path.stat().st_size > len(data),
            "content": text,
        }

    def _tool_workspace_list(self, arguments: dict[str, Any]) -> dict[str, Any]:
        raw = str(arguments.get("path") or "").strip() or "."
        relative = Path(raw)
        if relative.is_absolute() or ".." in relative.parts:
            raise ToolGatewayError("workspace_list 只接受项目内相对路径")
        posix = relative.as_posix()
        if posix == ".":
            roots = ("evidence", ".sorne-work")
        else:
            if not any(posix == item or posix.startswith(item) for item in _ALLOWED_READ_PREFIXES):
                raise ToolGatewayError(f"路径不在允许列出范围: {posix}")
            roots = (posix,)
        entries: list[str] = []
        for root in roots:
            base = self.store.path / root
            if not base.is_dir():
                continue
            for item in sorted(base.rglob("*")):
                if item.is_file():
                    entries.append(item.relative_to(self.store.path).as_posix())
                if len(entries) >= 500:
                    break
        return {"entries": entries[:500], "total": len(entries)}

    def _tool_workspace_write(self, arguments: dict[str, Any]) -> dict[str, Any]:
        raw = str(arguments.get("path") or "").strip()
        content = str(arguments.get("content") or "")
        if len(content.encode("utf-8")) > WORKSPACE_WRITE_LIMIT:
            raise ToolGatewayError(f"单次写入超过上限 {WORKSPACE_WRITE_LIMIT} 字节")
        relative = Path(raw)
        if relative.is_absolute() or ".." in relative.parts:
            raise ToolGatewayError("workspace_write 只接受相对路径")
        posix = relative.as_posix()
        if not posix.startswith(".sorne-work/"):
            raise ToolGatewayError(
                "workspace_write 只允许写入 .sorne-work/；证据落盘请使用工具自带证据机制或 evidence_sink"
            )
        destination = (self.store.path / relative).resolve()
        try:
            destination.relative_to((self.store.path / ".sorne-work").resolve())
        except ValueError as exc:
            raise ToolGatewayError(f"路径越界: {posix}") from exc
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(content, encoding="utf-8")
        return {"written": posix, "bytes": len(content.encode("utf-8"))}

    def _tool_helper_recipe(self, arguments: dict[str, Any]) -> dict[str, Any]:
        # 配方注册表当前为空（首批引擎适配在 P2/P3 落地后登记固定 argv 配方）。
        # 返回真实空态而不是伪造可用配方；无配方时该能力不出现在模型可见列表。
        return {
            "recipes": [],
            "reason": (
                "当前未注册任何辅助命令配方；任意命令不会默认开放。"
                "配方将以固定 argv 形式登记并按角色白名单放行。"
            ),
        }

    def _tool_compat_bash(self, arguments: dict[str, Any]) -> dict[str, Any]:
        command = str(arguments.get("command") or "").strip()
        if not command:
            raise ToolGatewayError("Bash command is empty")
        if self._compat_executor is None:
            raise ToolGatewayError(
                "compat_bash 未绑定执行宿主（仅迁移期旧角色的本地 Docker 工具循环可用）"
            )
        output, is_error = self._compat_executor(command)
        return {"output": output, "is_error": is_error}

    # ── 采集扫描：nuclei 组件验证（§6.6-2，P2）────────────────────────
    def _tool_poc_scan(self, arguments: dict[str, Any]) -> dict[str, Any]:
        targets = [
            str(item).strip() for item in (arguments.get("targets") or [])
            if str(item).strip()
        ]
        if not targets:
            raise ToolGatewayError("poc_scan 需要至少一个目标（targets: string[]）")
        for target in targets:
            self._check_target_authorization(target)
        template_ids = [
            str(item).strip() for item in (arguments.get("template_ids") or [])
            if str(item).strip()
        ]
        ticket = self._enforce_action_approval("poc_scan", arguments)
        from .engine_adapters import nuclei_adapter

        result = nuclei_adapter.run_scan(
            self.store,
            {"targets": targets, "template_ids": template_ids},
            cancel_check=self.cancel_check,
        )
        # 请求/响应证据已由适配层落盘（evidence/poc/，sha256 边车）。
        # 独立研判异步入队：不阻塞本结果返回；失败也只登记缺口（§7A.2）。
        analysis_note = {"skipped": True, "reason": "未入队"}
        try:
            from .analysis_service import AnalysisService

            analysis_note = AnalysisService(self.store).enqueue_from_tool_result(
                analyzer_kind="poc",
                tool_id="poc_scan",
                tool_call_id=f"{self.identity.task_id or self.identity.member_name}:poc_scan",
                result=result,
                run_id=self.identity.run_id,
                source_task_id=self.identity.task_id,
            )
        except Exception as exc:  # noqa: BLE001 —— 原始结果优先；研判缺失显式可见
            analysis_note = {
                "skipped": True,
                "reason": f"研判入队失败（原始结果不受影响）: {type(exc).__name__}: {exc}",
            }
        result["analysis_enqueued"] = analysis_note
        if ticket is not None:
            result["approved_via_ticket"] = ticket["id"]
        return result

    def _enforce_action_approval(
        self,
        tool_id: str,
        arguments: dict[str, Any],
    ) -> dict[str, Any] | None:
        """高操作安全风险任务的动作审批（§3.4）：绑定方向声明
        requires_human_confirmation 时，需 reviewer 的 action_review 票据
        （approve）且绑定字段完全一致才放行。其余方向沿用既有门禁语义。"""
        task_id = self.identity.task_id
        if not task_id:
            return None
        from .database import ControlDatabase

        database_path = self.store.path / "control_plane.db"
        if not database_path.exists():
            return None
        database = ControlDatabase(database_path)
        direction = database.get_direction(task_id)
        intent = (direction or {}).get("intent") or {}
        if not bool(intent.get("requires_human_confirmation")):
            return None
        params_digest = _digest({"tool_id": tool_id, **arguments})
        if self.identity.control_version is None:
            raise ToolGatewayError(
                "approval_required: 审批票必须绑定控制版本；本次会话缺少运行绑定，"
                "请在自动化运行内发起审批。"
            )
        ticket = database.find_action_ticket(
            task_id=task_id,
            tool_id=tool_id,
            params_digest=params_digest,
            control_version=int(self.identity.control_version),
        )
        if ticket is None:
            self.store.append_jsonl("pending_approvals.jsonl", {
                "task_id": task_id,
                "tool_id": tool_id,
                "params_digest": params_digest,
                "control_version": int(self.identity.control_version),
                "requested_by": self.identity.member_name,
                "created_at": now_iso(),
            })
            raise ToolGatewayError(
                "approval_required: 本任务声明了需要人工确认的操作安全风险；"
                "缺少匹配的 action_review approve 票据"
                f"（task_id={task_id}, tool_id={tool_id}, "
                f"params_digest={params_digest[:16]}…, "
                f"control_version={self.identity.control_version}）。"
                "票据由 reviewer 经 submit_review(action_review) 签发；"
                "参数或控制版本变化后旧票据失效。"
            )
        return ticket

    # ── review 两模式（§3.4）──────────────────────────────────────────
    def _tool_submit_review(self, arguments: dict[str, Any]) -> dict[str, Any]:
        mode = str(arguments.get("mode") or "").strip()
        payload = arguments.get("payload")
        if mode not in {"action_review", "finding_review"}:
            raise ToolGatewayError("submit_review 的 mode 只能是 action_review 或 finding_review")
        if not isinstance(payload, dict):
            raise ToolGatewayError("submit_review 需要 payload 对象")
        if not role_allows_kind(self.identity.role, "review_record"):
            raise ToolGatewayError(
                f"角色 {self.identity.role} 不允许输出 review_record；"
                "动作审批与发现复核只归 reviewer。"
            )
        payload = dict(payload)
        payload["kind"] = "review_record"
        payload["mode"] = mode
        payload["proposed_by"] = self.identity.member_name
        if mode == "action_review":
            # 票据绑定字段全部服务端注入/校验（§3.6）：模型值丢弃。
            task_id = str(self.identity.task_id or payload.get("task_id") or "").strip()
            if not task_id:
                raise ToolGatewayError(
                    "action_review 需要绑定任务：请在本任务会话内提交，或提供 task_id"
                )
            tool_id = str(payload.get("tool_id") or "").strip()
            params_digest = str(payload.get("params_digest") or "").strip()
            if not tool_id or not params_digest:
                raise ToolGatewayError(
                    "action_review 缺少 tool_id/params_digest（来自待审批清单；"
                    "可用 query_execution 查看 pending_approvals）"
                )
            if self.identity.control_version is None:
                raise ToolGatewayError(
                    "审批票必须绑定控制版本：请自动化运行内执行审批"
                )
            payload["task_id"] = task_id
            payload["tool_id"] = tool_id
            payload["params_digest"] = params_digest
            payload["control_version"] = int(self.identity.control_version)
            payload["run_id"] = self.identity.run_id
        else:
            payload["run_id"] = self.identity.run_id
        # 入链前校验：非法载荷在工具边界拒绝，不产生投毒的重试事件。
        from .worker import validate_review_payload

        validate_review_payload(self.store, mode, payload)
        # 服务端绑定标记：apply 分支据此区分网关提交（票据字段可信）与
        # 模型直接输出（拒绝签发票据）。
        payload["server_bound"] = True
        message = self._submit_through_commit_chain(payload)
        return {
            "accepted": True,
            "message": message,
            "note": (
                "action_review 票据仅绑定 (task_id, tool_id, params_digest, control_version)；"
                "参数或控制版本变化后不得复用。finding_review 不改变 Guardian 判定。"
            ) if mode == "action_review" else
            "finding_review 只是证据充分性建议；不删除原始命中、不确认漏洞。",
        }

    # ── 知识：技能加载与路由（§5.3）───────────────────────────────────
    def _tool_load_skill(self, arguments: dict[str, Any]) -> dict[str, Any]:
        from .skill_registry import get_skill, skill_status

        skill_id = str(arguments.get("skill_id") or "").strip()
        card = get_skill(skill_id)
        if card is None:
            raise ToolGatewayError(
                f"技能卡 {skill_id} 不存在；未覆盖特征应记录为方法缺口，不伪造技能"
            )
        if self.identity.role not in card.roles:
            raise ToolGatewayError(
                f"技能卡 {card.id} 的角色白名单不含 {self.identity.role}"
                f"（允许: {', '.join(card.roles)}）"
            )
        return {
            **skill_status(card),
            "body": card.body,
            "note": "版本与内容哈希已固定返回；任务快照中的哈希可用于事后核对。",
        }

    def _tool_skill_query(self, arguments: dict[str, Any]) -> dict[str, Any]:
        from .skill_router import route_skills

        features = [str(item) for item in (arguments.get("features") or []) if str(item).strip()]
        if not features:
            raise ToolGatewayError("skill_query 需要 features 数组")
        return route_skills(features, role=self.identity.role)

    # ── 独立研判查询（§7A.5）──────────────────────────────────────────
    def _tool_analysis_query(self, arguments: dict[str, Any]) -> dict[str, Any]:
        from .analysis_registry import analyzer_status
        from .analysis_service import AnalysisService

        analyzer_kind = str(arguments.get("analyzer_kind") or "").strip() or None
        limit = _bound_int(arguments.get("limit"), default=20, minimum=1, maximum=100)
        service = AnalysisService(self.store)
        rows = service.query_records(analyzer_kind=analyzer_kind, limit=limit)
        return {
            "analyzers": analyzer_status(),
            "records": [
                {
                    "analysis_id": row.get("id"),
                    "analyzer_kind": row.get("analyzer_kind"),
                    "version": row.get("version"),
                    "analysis_status": row.get("analysis_status"),
                    "model_id": row.get("model_id"),
                    "prompt_version": row.get("prompt_version"),
                    "input_hash": str(row.get("input_hash"))[:16],
                    "source_task_id": row.get("source_task_id"),
                    "created_at": row.get("created_at"),
                    "record": row.get("record"),
                }
                for row in rows
            ],
            "note": (
                "以上为独立 AI 研判层的模型分析（model_analysis=true），"
                "不是原始事实；候选判断与 confirmed 漏洞状态严格分开。"
            ),
        }


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        return None


def _validate_arguments(spec: ToolSpec, arguments: dict[str, Any]) -> str | None:
    """按目录 Schema 校验参数（§6.3：不允许 extra_args 绕过）。"""
    schema = spec.parameters or {}
    if schema.get("type") == "object":
        properties = schema.get("properties") or {}
        if schema.get("additionalProperties") is False:
            unknown = [key for key in arguments if key not in properties]
            if unknown:
                return f"包含未定义参数: {', '.join(sorted(unknown))}"
        for required in schema.get("required") or []:
            if required not in arguments or arguments[required] in (None, "", [], {}):
                return f"缺少必填参数: {required}"
        for key, rule in properties.items():
            if key not in arguments or arguments[key] is None:
                continue
            value = arguments[key]
            expected = rule.get("type")
            if expected == "string" and not isinstance(value, str):
                return f"参数 {key} 必须是字符串"
            if expected == "integer":
                if isinstance(value, bool) or not isinstance(value, int):
                    return f"参数 {key} 必须是整数"
            if expected == "number":
                if isinstance(value, bool) or not isinstance(value, (int, float)):
                    return f"参数 {key} 必须是数字"
            if expected == "array":
                if not isinstance(value, list):
                    return f"参数 {key} 必须是数组"
            if expected == "object":
                if not isinstance(value, dict):
                    return f"参数 {key} 必须是对象"
            enum = rule.get("enum")
            if enum and isinstance(value, str) and value not in enum:
                return f"参数 {key} 只能取值: {', '.join(enum)}"
    return None


def _bound_int(value: Any, *, default: int, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return max(minimum, min(maximum, parsed))
