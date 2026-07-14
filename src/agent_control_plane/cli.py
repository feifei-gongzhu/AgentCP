from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

from .guardian import Guardian
from .automation import AutomationEngine
from .lifecycle import project_execution_lock, require_initialized_project
from .protocol import AutomationHttpClient
from .metrics import collect_metrics
from .dashboard import render_dashboard
from .scheduler import Scheduler
from .schemas import Fact, Hint, Lesson
from .store import ProjectStore
from .team import run_team
from .webapp import serve
from .worker import run_worker


def cmd_init(args: argparse.Namespace) -> None:
    store = ProjectStore(args.vendor)
    store.init()
    print(f"已初始化项目: projects/{args.vendor}")


def cmd_add_fact(args: argparse.Namespace) -> None:
    store = ProjectStore(args.vendor)
    fact = Fact(
        title=args.title,
        category=args.category,
        evidence=args.evidence,
        business_impact=args.business_impact,
        reproduction_steps=args.reproduction_step,
        evidence_path=args.evidence_path,
    )
    fact = Guardian().review(fact)
    store.append_jsonl("facts.jsonl", fact)
    store.append_fact_to_blackboard(fact)

    state = store.load_state()
    state.fact_count += 1
    if fact.status == "vulnerability":
        state.vulnerability_count += 1
    state.last_discovery_at = fact.created_at
    store.save_state(state)

    print(f"已写入 Fact: {fact.id} | 状态: {fact.status}")
    for note in fact.quality_notes:
        print(f"- {note}")


def cmd_assess(args: argparse.Namespace) -> None:
    store = ProjectStore(args.vendor)
    state = store.load_state()
    facts = store.read_jsonl("facts.jsonl")
    decision = Scheduler(store).controller.evaluate(state, facts, gate_due=True)
    store.append_jsonl("decision_log.jsonl", decision)
    state.gate_status = "awaiting_approval"
    state.gate_reason = decision.reason
    state.current_decision = decision.action
    store.save_state(state)
    print(f"ROI 判断: {decision.action}")
    print(f"理由: {decision.reason}")


def cmd_tick(args: argparse.Namespace) -> None:
    store = ProjectStore(args.vendor)
    print(Scheduler(store).tick(args.minutes, serendipity=args.serendipity))


def cmd_add_lesson(args: argparse.Namespace) -> None:
    store = ProjectStore(args.vendor)
    lesson = Lesson(pattern=args.pattern, expiry_conditions=args.expiry)
    store.append_jsonl("lessons.jsonl", lesson)
    print(f"已写入 Lesson: {lesson.id}")


def cmd_add_hint(args: argparse.Namespace) -> None:
    if args.server:
        hint = AutomationHttpClient(args.server).add_hint(args.vendor, args.content, args.target, args.priority)
        print(f"已写入 Hint: {hint['id']}")
        return
    store = ProjectStore(args.vendor)
    hint = Hint(content=args.content, target=args.target, priority=args.priority)
    store.append_jsonl("hints.jsonl", hint)
    print(f"已写入 Hint: {hint.id}")


def cmd_dashboard(args: argparse.Namespace) -> None:
    store = ProjectStore(args.vendor)
    output = render_dashboard(store)
    print(f"已生成可视化仪表盘: {output}")


def cmd_metrics(args: argparse.Namespace) -> None:
    result = (
        AutomationHttpClient(args.server).metrics(args.vendor)
        if args.server
        else collect_metrics(ProjectStore(args.vendor))
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))


def cmd_run_worker(args: argparse.Namespace) -> None:
    store = ProjectStore(args.vendor)
    output = run_worker(
        store=store,
        role=args.role,
        backend=args.backend,
        model=args.model,
        profile=args.profile,
        timeout=args.timeout,
        sandbox=args.codex_sandbox,
        base_url=args.base_url,
        api_key_env=args.api_key_env,
        auth_mode=args.auth_mode,
        dangerously_bypass_sandbox=args.codex_dangerously_bypass_sandbox,
        dry_run=args.dry_run,
        apply_output=Path(args.apply_output) if args.apply_output else None,
    )
    print(output)


def cmd_run_team(args: argparse.Namespace) -> None:
    output = run_team(
        ProjectStore(args.vendor),
        team_name=args.team,
        timeout=args.timeout,
        dry_run=args.dry_run,
        max_workers=args.max_workers,
    )
    print(output)


def cmd_config_gate(args: argparse.Namespace) -> None:
    store = ProjectStore(args.vendor)
    state = store.load_state()
    if args.interval is not None:
        if args.interval <= 0:
            raise ValueError("V2.0 强制门禁不可关闭，间隔必须大于 0。")
        state.gate_interval_minutes = args.interval
    if args.reset:
        state.last_gate_elapsed_minutes = state.elapsed_minutes
    store.save_state(state)
    print(f"强制门禁间隔: {state.gate_interval_minutes} min | 状态: {state.gate_status} | 上次评估: {state.last_gate_elapsed_minutes} min")


def cmd_complete_subtask(args: argparse.Namespace) -> None:
    print(Scheduler(ProjectStore(args.vendor)).complete_subtask(args.summary))


def cmd_approve_gate(args: argparse.Namespace) -> None:
    if args.server:
        print(AutomationHttpClient(args.server).approve_gate(args.vendor, args.action, args.reason))
        return
    print(Scheduler(ProjectStore(args.vendor)).approve(args.action, args.reason))


def cmd_automate(args: argparse.Namespace) -> None:
    if args.server:
        client = AutomationHttpClient(args.server, timeout=max(args.timeout, 30))
        run_id = client.start(args.vendor, args.team, args.timeout, args.max_workers)
        print(f"自动化运行: {run_id}")
        print(client.run(args.vendor, run_id))
        return
    engine = AutomationEngine(ProjectStore(args.vendor))
    run_id = engine.start(args.team, timeout=args.timeout, max_workers=args.max_workers)
    print(f"自动化运行: {run_id}")
    print(engine.run(run_id))


def cmd_automation_resume(args: argparse.Namespace) -> None:
    if args.server:
        client = AutomationHttpClient(args.server)
        run_id = client.resume(args.vendor, args.run_id)
        print(client.run(args.vendor, run_id))
        return
    engine = AutomationEngine(ProjectStore(args.vendor))
    run_id = engine.resume(args.run_id)
    print(engine.run(run_id))


def cmd_automation_status(args: argparse.Namespace) -> None:
    status = (
        AutomationHttpClient(args.server).status(args.vendor, args.run_id)
        if args.server
        else AutomationEngine(ProjectStore(args.vendor)).status(args.run_id)
    )
    print(json.dumps(status, ensure_ascii=False, indent=2))


def cmd_automation_cancel(args: argparse.Namespace) -> None:
    if args.server:
        AutomationHttpClient(args.server).cancel(args.vendor, args.run_id, args.reason)
    else:
        AutomationEngine(ProjectStore(args.vendor)).cancel(args.run_id, args.reason)
    print(f"已取消自动化运行: {args.run_id}")


def cmd_automation_daemon(args: argparse.Namespace) -> None:
    if args.server:
        _remote_daemon(args)
        return
    engine = AutomationEngine(ProjectStore(args.vendor))
    print(f"自动化守护进程已启动: {args.vendor}")
    try:
        while True:
            state = engine.store.load_state()
            if state.gate_status == "awaiting_approval":
                if args.once:
                    print("已到达强制门禁，等待用户批准。")
                    return
                time.sleep(args.poll_interval)
                continue
            active = engine.db.latest_resumable_run()
            if active:
                run_id = engine.resume(active["id"])
            else:
                run_id = engine.start(args.team, timeout=args.timeout, max_workers=args.max_workers)
            print(engine.run(run_id))
            if args.once:
                return
    except KeyboardInterrupt:
        print("自动化守护进程已停止。")


def _remote_daemon(args: argparse.Namespace) -> None:
    client = AutomationHttpClient(args.server, timeout=max(args.timeout, 30))
    print(f"远程自动化守护进程已启动: {args.server}")
    try:
        while True:
            state = client.project_state(args.vendor)["state"]
            if state.get("gate_status") == "awaiting_approval":
                if args.once:
                    print("已到达强制门禁，等待用户批准。")
                    return
                time.sleep(args.poll_interval)
                continue
            status = client.status(args.vendor)
            run = status.get("run")
            if run and run.get("status") in {"running", "paused"}:
                run_id = client.resume(args.vendor, run["id"])
            else:
                run_id = client.start(args.vendor, args.team, args.timeout, args.max_workers)
            print(client.run(args.vendor, run_id))
            if args.once:
                return
    except KeyboardInterrupt:
        print("远程自动化守护进程已停止。")


def cmd_serve(args: argparse.Namespace) -> None:
    serve(host=args.host, port=args.port)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="agent-control-plane")
    sub = parser.add_subparsers(required=True)

    init = sub.add_parser("init", help="初始化项目控制平面")
    init.add_argument("vendor")
    init.set_defaults(func=cmd_init)

    fact = sub.add_parser("add-fact", help="写入事实并经过 Guardian 质量门")
    fact.add_argument("vendor")
    fact.add_argument("--title", required=True)
    fact.add_argument("--category", required=True)
    fact.add_argument("--evidence", required=True)
    fact.add_argument("--business-impact", required=True)
    fact.add_argument("--reproduction-step", action="append", required=True)
    fact.add_argument("--evidence-path", required=True)
    fact.set_defaults(func=cmd_add_fact)

    assess = sub.add_parser("assess", help="执行一次控制器评估")
    assess.add_argument("vendor")
    assess.set_defaults(func=cmd_assess)

    tick = sub.add_parser("tick", help="推进时间并触发 15 分钟门禁")
    tick.add_argument("vendor")
    tick.add_argument("--minutes", type=int, default=15)
    tick.add_argument("--serendipity", action="store_true")
    tick.set_defaults(func=cmd_tick)

    lesson = sub.add_parser("add-lesson", help="写入带失效条件的教训")
    lesson.add_argument("vendor")
    lesson.add_argument("--pattern", required=True)
    lesson.add_argument("--expiry", action="append", required=True)
    lesson.set_defaults(func=cmd_add_lesson)

    hint = sub.add_parser("add-hint", help="写入人工 Hint，作为 Worker 介入的唯一通道")
    hint.add_argument("vendor")
    hint.add_argument("--content", required=True)
    hint.add_argument("--target")
    hint.add_argument("--priority", type=int, default=0)
    hint.add_argument("--server")
    hint.set_defaults(func=cmd_add_hint)

    dashboard = sub.add_parser("dashboard", help="生成项目可视化仪表盘")
    dashboard.add_argument("vendor")
    dashboard.set_defaults(func=cmd_dashboard)

    metrics = sub.add_parser("metrics", help="输出攻击面覆盖、验证率和自动化可靠性指标")
    metrics.add_argument("vendor")
    metrics.add_argument("--server")
    metrics.set_defaults(func=cmd_metrics)

    worker = sub.add_parser("run-worker", help="运行 Codex CLI Worker 并把结构化输出写回控制平面")
    worker.add_argument("vendor")
    worker.add_argument("--backend", default="codex", choices=["codex", "claude-cli", "openai-compatible", "ollama", "container", "mock"])
    worker.add_argument("--role", default="pentester", choices=["pentester", "reason", "metacog", "reviewer"])
    worker.add_argument("--model")
    worker.add_argument("--base-url")
    worker.add_argument("--api-key-env")
    worker.add_argument("--auth-mode", default="auto", choices=["auto", "bearer", "x-api-key"])
    worker.add_argument("--profile")
    worker.add_argument("--timeout", type=int, default=300)
    worker.add_argument("--codex-sandbox", default="read-only", choices=["read-only", "workspace-write", "danger-full-access"])
    worker.add_argument(
        "--codex-dangerously-bypass-sandbox",
        action="store_true",
        help="传给 Codex CLI 的 --dangerously-bypass-approvals-and-sandbox；只建议在 Docker/虚拟机中使用",
    )
    worker.add_argument("--dry-run", action="store_true", help="只打印将发送给 Worker 的 prompt")
    worker.add_argument("--apply-output", help="不调用 Codex，直接应用一个 Worker JSON 输出文件")
    worker.set_defaults(func=cmd_run_worker)

    team = sub.add_parser("run-team", help="并发运行多角色 Worker，批次结束后触发强制门禁")
    team.add_argument("vendor")
    team.add_argument("--team", default="default")
    team.add_argument("--timeout", type=int, default=300)
    team.add_argument("--max-workers", type=int, default=4)
    team.add_argument("--dry-run", action="store_true")
    team.set_defaults(func=cmd_run_team)

    gate = sub.add_parser("config-gate", help="配置不可关闭的强制门禁间隔")
    gate.add_argument("vendor")
    gate.add_argument("--interval", type=int, help="强制门禁间隔分钟")
    gate.add_argument("--reset", action="store_true", help="把上次门禁时间重置为当前已用时间")
    gate.set_defaults(func=cmd_config_gate)

    complete = sub.add_parser("complete-subtask", help="标记子任务完成并强制进入待批准状态")
    complete.add_argument("vendor")
    complete.add_argument("--summary", required=True)
    complete.set_defaults(func=cmd_complete_subtask)

    approve = sub.add_parser("approve-gate", help="用户批准控制器下一动作")
    approve.add_argument("vendor")
    approve.add_argument("--action", required=True, choices=["continue", "stop_loss", "switch_target", "switch_phase"])
    approve.add_argument("--reason", required=True)
    approve.add_argument("--server")
    approve.set_defaults(func=cmd_approve_gate)

    automate = sub.add_parser("automate", help="自动运行一次 Stigmergy 迭代")
    automate.add_argument("vendor")
    automate.add_argument("--team", default="default")
    automate.add_argument("--timeout", type=int, default=300)
    automate.add_argument("--max-workers", type=int, default=4)
    automate.add_argument("--server", help="通过 HTTP 协议调用控制平面，例如 http://127.0.0.1:8765")
    automate.set_defaults(func=cmd_automate)

    auto_resume = sub.add_parser("automation-resume", help="从 SQLite 持久化状态恢复未完成运行")
    auto_resume.add_argument("vendor")
    auto_resume.add_argument("--run-id")
    auto_resume.add_argument("--server")
    auto_resume.set_defaults(func=cmd_automation_resume)

    auto_status = sub.add_parser("automation-status", help="查看自动化运行、租约和事件")
    auto_status.add_argument("vendor")
    auto_status.add_argument("--run-id")
    auto_status.add_argument("--server")
    auto_status.set_defaults(func=cmd_automation_status)

    auto_cancel = sub.add_parser("automation-cancel", help="取消运行并停止认领新任务")
    auto_cancel.add_argument("vendor")
    auto_cancel.add_argument("--run-id", required=True)
    auto_cancel.add_argument("--reason", default="cancelled_by_user")
    auto_cancel.add_argument("--server")
    auto_cancel.set_defaults(func=cmd_automation_cancel)

    daemon = sub.add_parser("automation-daemon", help="持续运行自动化循环，门禁解除后自动开始下一迭代")
    daemon.add_argument("vendor")
    daemon.add_argument("--team", default="default")
    daemon.add_argument("--timeout", type=int, default=300)
    daemon.add_argument("--max-workers", type=int, default=4)
    daemon.add_argument("--poll-interval", type=int, default=3)
    daemon.add_argument("--once", action="store_true")
    daemon.add_argument("--server", help="使调度器只通过 HTTP 协议工作")
    daemon.set_defaults(func=cmd_automation_daemon)

    web = sub.add_parser("serve", help="启动带 API 的本地 Web 控制台")
    web.add_argument("--host", default="127.0.0.1")
    web.add_argument("--port", type=int, default=8765)
    web.set_defaults(func=cmd_serve)

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    is_local_project_command = (
        hasattr(args, "vendor")
        and args.func is not cmd_init
        and not getattr(args, "server", None)
    )
    if not is_local_project_command:
        args.func(args)
        return
    store = ProjectStore(args.vendor)
    with project_execution_lock(store):
        require_initialized_project(store)
        args.func(args)


if __name__ == "__main__":
    main()
