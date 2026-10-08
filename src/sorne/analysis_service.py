"""独立 AI 研判服务（实施方案 §7A.1-7A.4；P0-契约设计 §3.5）。

服务骨架 + POC 分析器（P2）。核心纪律：

- **异步附加**：原始扫描结果先落盘可见；研判任务入队（queued），不阻塞
  原始结果的提交。失败/取消保留原始产物并显式呈现缺失状态。
- **复用执行设施**：模型调用走 ``drivers.run_driver``（与 execution.run_member
  同一通道）；秘密解析复用 ``RuntimeSecretStore``；Prompt 脱敏快照复用
  ``context_compiler.persist_prompt_snapshot``；取消走 cancel_check + 租约
  迟到 fencing（``finish_analysis_job`` 校验租约持有者）。
- **幂等缓存不是额度**：input_hash = sha256(原始证据 × 分析器版本 × 模型
  配置版本 × 上下文版本)；相同输入复用结果，用户重分析生成新版本并保留
  旧记录。不设次数/费用/Token 配置项（§7A.4）。
- **不冒充角色**：分析任务不使用任何七角色身份；输出为独立 analysis_record。
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Callable
from uuid import uuid4

from .analysis_registry import (
    ANALYSIS_SCHEMA_VERSION,
    AnalyzerSpec,
    analyzer_enabled,
    build_domain_input,
    get_analyzer,
    validate_model_output,
)
from .context_compiler import persist_prompt_snapshot
from .database import ControlDatabase
from .drivers import DriverConfig, run_driver
from .memory import active_negative_evidence
from .schemas import now_iso
from .store import ProjectStore


DEFAULT_ANALYZER_TIMEOUT_SECONDS = 300
DEFAULT_MAX_JOBS_PER_DRAIN = 4


class AnalysisServiceError(RuntimeError):
    pass


def _canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)


def _file_digest(path: Path) -> str:
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError:
        return "missing"


def _active_negative_refs(store: ProjectStore, targets: list[str]) -> list[str]:
    refs: list[str] = []
    lowered = [str(t).casefold() for t in targets if str(t)]
    for item in active_negative_evidence(store):
        target = str(item.get("target") or "").casefold()
        if not lowered or any(target in t or t in target for t in lowered):
            refs.append(str(item.get("id") or ""))
    return [r for r in refs if r][:8]


class AnalysisService:
    def __init__(self, store: ProjectStore, database: ControlDatabase | None = None):
        self.store = store
        self.database = database or ControlDatabase(store.path / "control_plane.db")

    # ── 配置解析（§7A.4：项目覆盖 → 团队规划成员继承 → 不可用）────────
    def resolve_model_config(self, analyzer_kind: str) -> tuple[dict[str, Any] | None, str]:
        config_path = self.store.path / "analysis_config.json"
        config = {}
        if config_path.is_file():
            try:
                config = json.loads(config_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                config = {}
        analyzers = config.get("analyzers") if isinstance(config, dict) else {}
        override = (
            analyzers.get(analyzer_kind)
            if isinstance(analyzers, dict) else None
        )
        if isinstance(override, dict) and override.get("model"):
            version = _canonical(override)
            return {
                "type": str(override.get("type") or "openai-compatible"),
                "model": str(override.get("model")),
                "base_url": override.get("base_url"),
                "api_key_env": override.get("api_key_env"),
                "timeout_seconds": int(override.get("timeout_seconds") or DEFAULT_ANALYZER_TIMEOUT_SECONDS),
                "member_name": f"analysis:{analyzer_kind}",
                "source": "analysis_config",
            }, version
        # 继承项目模型配置：优先 planner（规划类模型，适合解释类任务），
        # 其次 reviewer；复制模型/运行时配置，不复制明文密钥（秘密走引用）。
        try:
            from .team import load_team

            members = load_team("default", self.store)
        except Exception:  # noqa: BLE001 —— 无团队配置时无可继承模型
            members = []
        for role in ("planner", "reviewer", "reason"):
            member = next((m for m in members if m.role == role and m.model), None)
            if member is None:
                continue
            resolved = {
                "type": member.type or member.backend,
                "model": member.model,
                "base_url": member.base_url,
                "api_key_env": member.api_key_env,
                "timeout_seconds": DEFAULT_ANALYZER_TIMEOUT_SECONDS,
                "member_name": f"analysis:{analyzer_kind}",
                "source": f"team:{role}:{member.name}",
            }
            return resolved, _canonical(resolved)
        return None, "unconfigured"

    def _runtime_secret_for(self, member_name: str) -> tuple[str | None, dict[str, str]]:
        from .runtime_secrets import RuntimeSecretStore

        secret = RuntimeSecretStore.get(self.store.vendor, member_name)
        if secret:
            return "SORNE_RUNTIME_API_KEY", {"SORNE_RUNTIME_API_KEY": secret}
        return None, {}

    # ── 输入组装与入队 ────────────────────────────────────────────────
    def enqueue_from_tool_result(
        self,
        *,
        analyzer_kind: str,
        tool_id: str,
        tool_call_id: str,
        result: dict[str, Any],
        run_id: str | None = None,
        source_task_id: str | None = None,
        identity_refs: list[str] | None = None,
    ) -> dict[str, Any] | None:
        """扫描结果落盘后入队分析任务（异步；绝不阻塞原始结果返回）。"""
        spec = get_analyzer(analyzer_kind)
        if spec is None:
            raise AnalysisServiceError(f"未知分析器: {analyzer_kind}")
        enabled, disabled_reason = analyzer_enabled(self.store, analyzer_kind)
        if not enabled:
            return {"skipped": True, "reason": disabled_reason}
        if tool_id not in spec.trigger_tools:
            return {
                "skipped": True,
                "reason": f"工具 {tool_id} 不是 {analyzer_kind} 分析器的触发源",
            }
        targets = [str(t) for t in (result.get("targets") or []) if str(t)]
        evidence_refs: list[str] = []
        for path in [
            result.get("evidence_path"),
            *(result.get("hit_evidence_paths") or []),
            *(result.get("evidence_paths") or []),
        ]:
            if path:
                evidence_refs.append(str(path))
        digests = [
            _file_digest(self.store.path / path)
            for path in evidence_refs[:16]
        ]
        profiles = self._target_profiles(targets)
        model_config, model_version = self.resolve_model_config(analyzer_kind)
        domain_input = build_domain_input(
            analyzer_kind, result,
            evidence_loader=self._evidence_excerpt,
            profile_loader=lambda: profiles,
        )
        input_payload = {
            "project_id": self.store.vendor,
            "run_id": run_id,
            "source_task_id": source_task_id,
            "source_tool_call_id": tool_call_id,
            "analyzer_kind": analyzer_kind,
            "source_result_refs": [
                {"tool_id": tool_id, "tool_call_id": tool_call_id,
                 "evidence_path": result.get("evidence_path"),
                 "hit_count": result.get("hit_count")},
            ],
            "evidence_refs": evidence_refs,
            "target_profile_refs": [str(p.get("id") or p.get("url")) for p in profiles[:12]],
            "identity_refs": [str(r) for r in (identity_refs or [])],
            "active_negative_evidence_refs": _active_negative_refs(self.store, targets),
            "domain_input": domain_input,
        }
        context_version = self._context_version()
        input_hash = hashlib.sha256(
            "\x1f".join([
                _canonical(digests), spec.prompt_version,
                model_version, context_version,
                _canonical({"targets": targets, "tool": tool_id}),
            ]).encode("utf-8")
        ).hexdigest()
        input_payload["input_hash"] = input_hash
        job, created = self.database.enqueue_analysis_job(
            analyzer_kind, input_payload, input_hash,
            run_id=run_id, source_task_id=source_task_id,
            source_tool_call_id=tool_call_id,
        )
        return {
            "analysis_job_id": job.get("id"),
            "analyzer_kind": analyzer_kind,
            "created": created,
            "input_hash": input_hash,
            "model_configured": model_config is not None,
            "note": (
                "研判任务已入队（异步附加记录）；原始结果已先行提交可见。"
                if created else "相同输入已有排队/完成的分析任务（幂等复用，不是额度）。"
            ),
        }

    def _evidence_excerpt(self, path: str) -> str:
        try:
            return (self.store.path / str(path)).read_text(encoding="utf-8", errors="replace")[:4_000]
        except OSError:
            return ""

    def _target_profiles(self, targets: list[str]) -> list[dict[str, Any]]:
        from .target_profile import target_assessments
        from .technologies import technology_profile

        profiles: list[dict[str, Any]] = []
        lowered = [str(t).casefold() for t in targets]
        for row in target_assessments(self.store):
            url = str(row.get("url") or "").casefold()
            if not lowered or any(url.startswith(t) or t in url for t in lowered):
                profiles.append({
                    "id": row.get("id"), "url": row.get("url"),
                    "profile_class": row.get("profile_class"),
                    "function": row.get("function"),
                })
            if len(profiles) >= 12:
                break
        tech = technology_profile(self.store)
        if isinstance(tech, dict):
            for key, value in tech.items():
                if any(t.casefold() in str(key).casefold() for t in lowered) and value:
                    profiles.append({"id": f"tech:{key}", "technology": value})
                    if len(profiles) >= 20:
                        break
        return profiles

    def _context_version(self) -> str:
        facts = self.store.read_jsonl("facts.jsonl")
        negatives = self.store.read_jsonl("negative_evidence.jsonl")
        material = {
            "fact_count": len(facts),
            "last_fact": str((facts[-1] or {}).get("id")) if facts else "",
            "negative_count": len(negatives),
            "last_negative": str((negatives[-1] or {}).get("id")) if negatives else "",
        }
        return hashlib.sha256(_canonical(material).encode("utf-8")).hexdigest()

    # ── 执行（租约 + 取消 + 快照 + 迟到 fencing）────────────────────────
    def drain(
        self,
        *,
        worker_id: str | None = None,
        max_jobs: int = DEFAULT_MAX_JOBS_PER_DRAIN,
        cancel_check: Callable[[], bool] | None = None,
        force: bool = False,
    ) -> list[str]:
        """处理排队中的分析任务（有界批量）。``force=True`` 供用户重分析：
        忽略“同输入已完成”的复用语义——已完成任务不会被 claim，重分析走
        enqueue 的 force 语义生成新输入上下文（时间戳计入 hash）。"""
        summaries: list[str] = []
        worker = worker_id or f"analysis-{uuid4().hex[:8]}"
        for _ in range(max(0, int(max_jobs))):
            if cancel_check is not None and cancel_check():
                summaries.append("研判批处理被取消")
                break
            job = self.database.claim_analysis_job(worker)
            if job is None:
                break
            summaries.append(self._run_claimed(job, worker, cancel_check=cancel_check))
        return summaries

    def reanalyze(self, analysis_record_id: str, *, reason: str = "user_reanalysis") -> dict[str, Any]:
        """用户重分析：以原记录输入生成新版本（旧记录保留，§7A.3）。"""
        records = self.database.list_analysis_records(limit=200)
        source = next(
            (r for r in records if str(r.get("id")) == str(analysis_record_id)), None,
        )
        if source is None:
            raise AnalysisServiceError(f"分析记录不存在: {analysis_record_id}")
        job = self.database.get_analysis_job(str(source.get("job_id") or ""))
        if job is None:
            raise AnalysisServiceError("原分析任务不可追溯，无法重分析")
        # 新 input_hash：计入重分析理由与时间 → 生成 version+1 新记录。
        base_input = dict(job.get("input") or {})
        input_hash = hashlib.sha256(
            (str(source.get("input_hash")) + f"|reanalysis:{reason}:{now_iso()}").encode("utf-8")
        ).hexdigest()
        base_input["reanalysis_of"] = str(source.get("id"))
        base_input["reanalysis_reason"] = reason
        # 版本链：新版本挂在原记录的 lineage_root 上（旧记录保留，§7A.3）。
        base_input["lineage_root"] = str(source.get("lineage_root") or source.get("id"))
        new_job, created = self.database.enqueue_analysis_job(
            str(source.get("analyzer_kind")), base_input, input_hash,
            run_id=source.get("run_id"),
            source_task_id=source.get("source_task_id"),
            source_tool_call_id=source.get("source_tool_call_id"),
        )
        return {
            "analysis_job_id": new_job.get("id"),
            "reanalysis_of": str(source.get("id")),
            "created": created,
        }

    def _run_claimed(
        self,
        job: dict[str, Any],
        worker_id: str,
        *,
        cancel_check: Callable[[], bool] | None = None,
    ) -> str:
        job_id = str(job.get("id"))
        kind = str(job.get("analyzer_kind"))
        spec = get_analyzer(kind)
        try:
            if spec is None:
                raise AnalysisServiceError(f"未知分析器: {kind}")
            enabled, disabled_reason = analyzer_enabled(self.store, kind)
            if not enabled:
                status = self.database.finish_analysis_job(
                    job_id, worker_id, status="cancelled",
                    error=f"analyzer_disabled:{disabled_reason}",
                )
                return f"[{kind}] 分析任务 {job_id} 已取消（{disabled_reason}）"
            model_config, _version = self.resolve_model_config(kind)
            if model_config is None:
                raise AnalysisServiceError(
                    "缺少可用模型配置：analysis_config.json 未覆盖且团队无可继承的"
                    "规划/复核成员模型。分析未执行，不以空结果冒充（§7A.5）。"
                )
            if cancel_check is not None and cancel_check():
                status = self.database.finish_analysis_job(
                    job_id, worker_id, status="cancelled", error="cancelled_before_run",
                )
                return f"[{kind}] 分析任务 {job_id} 已取消（{status}）"

            prompt = spec.prompt_text() + "\n\n# 待分析输入（服务端组装；含证据节选）\n" + _canonical(job.get("input"))
            snapshot = persist_prompt_snapshot(
                self.store, prompt,
                {
                    "compiler_version": "analysis-service-v1",
                    "analyzer_kind": kind,
                    "analysis_job_id": job_id,
                },
                member_name=str(model_config.get("member_name") or f"analysis:{kind}"),
                role=f"analysis:{kind}",
                runtime_mode="analysis",
            )
            api_key_env, env = self._runtime_secret_for(
                str(model_config.get("member_name") or f"analysis:{kind}"),
            )
            config = DriverConfig(
                type=str(model_config.get("type") or "openai-compatible"),
                model=model_config.get("model"),
                base_url=model_config.get("base_url"),
                # 与 execution.run_member 相同的优先级：运行时秘密（按分析
                # 成员名引用解析）优先于继承配置里的 api_key_env——继承的
                # 环境变量名在分析会话里通常未设置，反之秘密已解析则直接
                # 注入 SORNE_RUNTIME_API_KEY。
                api_key_env=api_key_env
                or str(model_config.get("api_key_env") or "")
                or "OPENAI_API_KEY",
                env=env,
                extra={
                    "runtime_mode": "local-cli",
                    "project_path": str(self.store.path.resolve()),
                    "member_name": model_config.get("member_name"),
                    "analysis_job_id": job_id,
                },
            )
            payload = run_driver(
                config, prompt,
                timeout=int(model_config.get("timeout_seconds") or DEFAULT_ANALYZER_TIMEOUT_SECONDS),
                cancel_check=cancel_check,
            )
            # 迟到 fencing：取消竞态下放弃写回（记录仍留在租约中由恢复回收）。
            current = self.database.get_analysis_job(job_id)
            if current is None or current.get("status") != "running" or current.get("worker_id") != worker_id:
                return f"[{kind}] 分析任务 {job_id} 迟到结果被 fencing 拒绝（任务已被取消或换手）"
            problems = validate_model_output(kind, payload)
            if problems:
                raise AnalysisServiceError(
                    "分析输出不符合 §7A.2 契约: " + "; ".join(problems[:8])
                )
            record = self._assemble_record(spec, job, payload, model_config, snapshot)
            inserted = self.database.insert_analysis_record(
                kind, str(job.get("input_hash")), record,
                job_id=job_id, run_id=job.get("run_id"),
                source_task_id=job.get("source_task_id"),
                source_tool_call_id=job.get("source_tool_call_id"),
                model_id=str(model_config.get("model")),
                prompt_version=spec.prompt_version,
                schema_version=ANALYSIS_SCHEMA_VERSION,
                lineage_root=(job.get("input") or {}).get("lineage_root"),
            )
            self.database.finish_analysis_job(
                job_id, worker_id, status="completed", record_id=inserted["analysis_id"],
            )
            return (
                f"[{kind}] 分析完成: {inserted['analysis_id']} "
                f"(version {inserted['version']}, {len(record['observations'])} 条观察)"
            )
        except Exception as exc:  # noqa: BLE001 —— 分析失败必须落状态而不是静默丢失
            error = f"{type(exc).__name__}: {exc}"
            status = self.database.finish_analysis_job(
                job_id, worker_id, status="failed", error=error[:1000], retryable=False,
            )
            return f"[{kind}] 分析任务 {job_id} 失败（{status}）: {error[:300]}"

    def _assemble_record(
        self,
        spec: AnalyzerSpec,
        job: dict[str, Any],
        model_payload: dict[str, Any],
        model_config: dict[str, Any],
        snapshot: dict[str, Any],
    ) -> dict[str, Any]:
        record = dict(model_payload)
        # 服务端权威字段（模型值一律覆盖，P0-契约设计 §3.6）
        record["kind"] = "analysis_record"
        record["analyzer_kind"] = spec.kind
        record["source_result_ids"] = [
            str(ref.get("tool_call_id"))
            for ref in (job.get("input") or {}).get("source_result_refs", [])
            if isinstance(ref, dict)
        ]
        record["evidence_refs"] = (job.get("input") or {}).get("evidence_refs") or []
        record["recommended_followups"] = [
            {
                **(item if isinstance(item, dict) else {}),
                "adopted": False,
                "adopted_by_task_id": None,
                "not_adopted_reason": None,
            }
            for item in (model_payload.get("recommended_followups") or [])
        ]
        record["analysis_status"] = "completed"
        record["model_id"] = str(model_config.get("model"))
        record["prompt_version"] = spec.prompt_version
        record["schema_version"] = ANALYSIS_SCHEMA_VERSION
        record["input_hash"] = str(job.get("input_hash"))
        record["model_analysis"] = True  # §7A.5：明确是模型分析，不伪装原始事实
        record["prompt_snapshot_id"] = snapshot.get("id")
        record["created_at"] = now_iso()
        record.pop("analysis_id", None)
        record.pop("version", None)
        return record

    # ── 查询与采纳登记（§7A.5）────────────────────────────────────────
    def query_records(
        self,
        *,
        analyzer_kind: str | None = None,
        limit: int = 30,
    ) -> list[dict[str, Any]]:
        rows = self.database.list_analysis_records(analyzer_kind, limit=limit)
        for row in rows:
            row["record"]["model_analysis"] = True
        return rows

    def mark_followup(
        self,
        analysis_id: str,
        followup_index: int,
        *,
        adopted: bool,
        task_id: str | None = None,
        reason: str | None = None,
    ) -> dict[str, Any]:
        """登记建议采纳状态（防重复创建同一验证，§7A.5）。

        只更新 analysis_records 表内最新版本的记录 JSON；历史版本保持原样。
        """
        with self.database.connect() as db:
            row = db.execute(
                "SELECT id, record_json FROM analysis_records WHERE id=?",
                (str(analysis_id),),
            ).fetchone()
            if row is None:
                raise AnalysisServiceError(f"分析记录不存在: {analysis_id}")
            record = json.loads(row["record_json"])
            followups = record.get("recommended_followups") or []
            if not isinstance(followups, list) or not (0 <= int(followup_index) < len(followups)):
                raise AnalysisServiceError(f"建议索引越界: {followup_index}")
            followups[int(followup_index)].update({
                "adopted": bool(adopted),
                "adopted_by_task_id": str(task_id) if adopted else None,
                "not_adopted_reason": None if adopted else str(reason or "not specified")[:500],
            })
            record["recommended_followups"] = followups
            db.execute(
                "UPDATE analysis_records SET record_json=? WHERE id=?",
                (json.dumps(record, ensure_ascii=False), str(analysis_id)),
            )
        return {"analysis_id": str(analysis_id), "followup_index": int(followup_index), "adopted": bool(adopted)}

    def cancel_for_run(self, run_id: str, reason: str) -> int:
        return self.database.cancel_analysis_jobs_for_run(run_id, reason)


def drain_project(
    store: ProjectStore,
    database: ControlDatabase | None = None,
    *,
    max_jobs: int = DEFAULT_MAX_JOBS_PER_DRAIN,
    cancel_check: Callable[[], bool] | None = None,
) -> list[str]:
    return AnalysisService(store, database).drain(max_jobs=max_jobs, cancel_check=cancel_check)
