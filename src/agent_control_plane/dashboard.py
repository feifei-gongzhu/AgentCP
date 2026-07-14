from __future__ import annotations

import html
import json
from pathlib import Path

from .database import ControlDatabase
from .lifecycle import project_execution_lock, require_initialized_project
from .metrics import collect_metrics
from .store import BLACKBOARD_FILE, ProjectStore


def _escape(value: object) -> str:
    return html.escape("" if value is None else str(value))


def _rows(items: list[dict], columns: list[tuple[str, str]]) -> str:
    if not items:
        return f'<tr><td colspan="{len(columns)}" class="empty">暂无记录</td></tr>'
    return "".join(
        "<tr>" + "".join(f"<td>{_escape(item.get(key, ''))}</td>" for key, _ in columns) + "</tr>"
        for item in reversed(items)
    )


def render_dashboard(store: ProjectStore) -> Path:
    with project_execution_lock(store):
        require_initialized_project(store)
        return _render_dashboard_locked(store)


def _render_dashboard_locked(store: ProjectStore) -> Path:
    state = store.load_state().__dict__
    target = store.read_json("target.json")
    facts = store.read_jsonl("facts.jsonl")
    intents = store.read_jsonl("intents.jsonl")
    decisions = store.read_jsonl("decision_log.jsonl")
    blackboard = store.read_text(BLACKBOARD_FILE)
    database_path = store.path / "control_plane.db"
    latest_run = None
    automation_jobs: list[dict] = []
    if database_path.exists():
        database = ControlDatabase(database_path)
        latest_run = database.latest_run()
        if latest_run:
            automation_jobs = database.list_jobs(latest_run["id"])
        directions = database.list_directions()
    else:
        directions = []
    gate_waiting = state.get("gate_status") == "awaiting_approval"
    gate_class = "blocked" if gate_waiting else "running"
    gate_label = "等待用户批准" if gate_waiting else "运行中"

    fact_columns = [("id", "ID"), ("status", "级别"), ("title", "发现"), ("business_impact", "业务影响")]
    intent_columns = [("id", "ID"), ("verb", "动作"), ("target", "目标"), ("risk_level", "风险"), ("status", "状态")]
    decision_columns = [("created_at", "时间"), ("action", "决策"), ("reason", "理由")]
    job_columns = [("id", "Job"), ("stage", "阶段"), ("member_name", "Worker"), ("status", "状态"), ("attempts", "尝试")]
    direction_rows = [
        {
            "id": item["id"],
            "status": item["status"],
            "verb": item["intent"].get("verb", ""),
            "target": item["intent"].get("target", ""),
            "claimed_by": item.get("claimed_by") or "",
        }
        for item in directions
    ]
    direction_columns = [("id", "Intent"), ("status", "租约状态"), ("verb", "动作"), ("target", "目标"), ("claimed_by", "认领者")]
    coverage = state.get("attack_surface_coverage", {})
    run_view = latest_run or {}
    metrics = collect_metrics(store)
    coverage_html = "".join(
        f'<div class="command"><strong>{_escape(name)}</strong><br><span class="muted">{_escape(status)}</span></div>'
        for name, status in coverage.items()
    )

    document = f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>{_escape(store.vendor)} · V2.0 并发渗透黑板</title>
  <style>
    :root {{ color-scheme: dark; --bg:#080b10; --panel:#111721; --line:#253142; --text:#e8eef7; --muted:#8b9aae; --accent:#49d6a3; --warn:#ffb454; --danger:#ff6577; }}
    * {{ box-sizing:border-box }} body {{ margin:0; background:radial-gradient(circle at top right,#162032 0,var(--bg) 36%); color:var(--text); font:14px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace }}
    main {{ width:min(1500px,94vw); margin:34px auto 80px }}
    header {{ display:flex; justify-content:space-between; gap:24px; align-items:end; margin-bottom:22px }}
    h1 {{ margin:0; font-size:28px }} h2 {{ font-size:15px; margin:0 0 14px; letter-spacing:.08em; color:#b9c7d8 }}
    .eyebrow,.muted {{ color:var(--muted) }} .eyebrow {{ text-transform:uppercase; letter-spacing:.18em; margin-bottom:6px }}
    .gate {{ border:1px solid; padding:10px 14px; border-radius:8px; font-weight:700 }} .gate.running {{ color:var(--accent); border-color:#245c4d; background:#0c201b }} .gate.blocked {{ color:var(--danger); border-color:#713542; background:#2a1118 }}
    .metrics {{ display:grid; grid-template-columns:repeat(5,1fr); gap:12px; margin-bottom:12px }}
    .card,.panel {{ background:linear-gradient(180deg,#131b27,#0f151e); border:1px solid var(--line); border-radius:10px; box-shadow:0 14px 45px #0005 }}
    .card {{ padding:16px }} .card small {{ color:var(--muted); display:block }} .card strong {{ display:block; font-size:22px; margin-top:6px }}
    .notice {{ padding:16px 18px; margin:12px 0; border-left:3px solid var(--warn) }}
    .grid {{ display:grid; grid-template-columns:1.15fr .85fr; gap:12px; margin-top:12px }} .panel {{ padding:18px; overflow:hidden }} .wide {{ grid-column:1/-1 }}
    table {{ width:100%; border-collapse:collapse }} th,td {{ border-bottom:1px solid #202a39; padding:9px 8px; text-align:left; vertical-align:top }} th {{ color:var(--muted); font-size:12px }}
    pre {{ white-space:pre-wrap; overflow:auto; max-height:600px; padding:15px; background:#090d13; border:1px solid #202a39; border-radius:7px; color:#cbd8e8 }}
    code {{ color:#8ee8c8 }} .empty {{ color:var(--muted); text-align:center; padding:22px }}
    .commands {{ display:grid; gap:8px }} .command {{ padding:10px 12px; background:#090d13; border:1px solid #202a39; border-radius:6px; overflow:auto }}
    @media(max-width:900px) {{ .metrics,.grid {{ grid-template-columns:1fr }} .wide {{ grid-column:auto }} header {{ align-items:start; flex-direction:column }} }}
  </style>
</head>
<body><main>
  <header>
    <div><div class="eyebrow">parallel workers / two-tier blackboard / v2.0</div><h1>{_escape(store.vendor)}</h1><div class="muted">授权模式：{_escape(target.get('authorization_mode'))} · scope: {_escape(json.dumps(target.get('scope'), ensure_ascii=False))}</div></div>
    <div class="gate {gate_class}">{gate_label}</div>
  </header>
  <section class="metrics">
    <div class="card"><small>当前阶段</small><strong>{_escape(state.get('phase'))}</strong></div>
    <div class="card"><small>已用时间</small><strong>{_escape(state.get('elapsed_minutes'))} min</strong></div>
    <div class="card"><small>资产总数</small><strong>{_escape(state.get('asset_count'))}</strong></div>
    <div class="card"><small>高危指纹</small><strong>{_escape(state.get('high_risk_fingerprint_count'))}</strong></div>
    <div class="card"><small>确认漏洞</small><strong>{_escape(state.get('vulnerability_count'))}</strong></div>
  </section>
  <section class="panel notice"><strong>攻击面覆盖率：</strong>{metrics['coverage']['coverage_rate']:.0%} · <strong>验证覆盖率：</strong>{metrics['coverage']['verification_coverage_rate']:.0%} · <strong>发现验证率：</strong>{metrics['quality']['validation_rate']:.0%} · <strong>Job 成功率：</strong>{metrics['automation']['job_success_rate']:.0%}</section>
  <section class="panel notice"><strong>当前任务：</strong>{_escape(state.get('current_task'))}<br><strong>ROI 决策：</strong>{_escape(state.get('current_decision'))}<br><span class="muted">{_escape(state.get('gate_reason') or '未触发强制节拍')}</span></section>
  <div class="grid">
    <section class="panel wide"><h2>发现与证据分级</h2><table><thead><tr>{''.join(f'<th>{label}</th>' for _,label in fact_columns)}</tr></thead><tbody>{_rows(facts,fact_columns)}</tbody></table></section>
    <section class="panel wide"><h2>可执行 Intent</h2><table><thead><tr>{''.join(f'<th>{label}</th>' for _,label in intent_columns)}</tr></thead><tbody>{_rows(intents,intent_columns)}</tbody></table></section>
    <section class="panel wide"><h2>Intent 方向租约</h2><table><thead><tr>{''.join(f'<th>{label}</th>' for _,label in direction_columns)}</tr></thead><tbody>{_rows(direction_rows,direction_columns)}</tbody></table></section>
    <section class="panel"><h2>十维攻击面覆盖</h2><div class="commands">{coverage_html}</div></section>
    <section class="panel"><h2>自动化运行</h2><div class="commands"><div class="command"><strong>{_escape(run_view.get('id', '暂无运行'))}</strong><br><span class="muted">{_escape(run_view.get('status', 'idle'))} / {_escape(run_view.get('stage', '-'))}</span></div></div><table><thead><tr>{''.join(f'<th>{label}</th>' for _,label in job_columns)}</tr></thead><tbody>{_rows(automation_jobs,job_columns)}</tbody></table></section>
    <section class="panel"><h2>控制器决策日志</h2><table><thead><tr>{''.join(f'<th>{label}</th>' for _,label in decision_columns)}</tr></thead><tbody>{_rows(decisions[-20:],decision_columns)}</tbody></table></section>
    <section class="panel"><h2>并发 Worker 操作</h2><div class="commands">
      <div class="command"><code>python3 agentcp run-team {_escape(store.vendor)} --team default --max-workers 4 --dry-run</code></div>
      <div class="command"><code>python3 agentcp run-team {_escape(store.vendor)} --team default --max-workers 4</code></div>
      <div class="command"><code>python3 agentcp tick {_escape(store.vendor)} --minutes 15</code></div>
      <div class="command"><code>python3 agentcp approve-gate {_escape(store.vendor)} --action continue --reason "用户批准继续"</code></div>
    </div></section>
    <section class="panel wide"><h2>双层项目黑板</h2><pre>{_escape(blackboard)}</pre></section>
  </div>
</main></body></html>"""
    output = store.path / "dashboard.html"
    output.write_text(document, encoding="utf-8")
    return output
