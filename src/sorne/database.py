from __future__ import annotations

import json
import hashlib
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator
from uuid import uuid4


SCHEMA_VERSION = 7


_ASSET_TERMINAL_STATUSES = (
    "profiled",
    "pending_profile",
    "unreachable",
    "blocked",
    "non_web",
    "duplicate",
    "invalid",
    "out_of_scope",
    "stale",
    "needs_review",
)


_ASSET_SCHEMA_V4 = (
    """
    CREATE TABLE IF NOT EXISTS asset_import_files (
        id TEXT PRIMARY KEY,
        logical_source TEXT NOT NULL,
        source_type TEXT NOT NULL,
        file_name TEXT NOT NULL,
        file_sha256 TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        generation INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('importing','completed','failed')),
        row_count INTEGER NOT NULL DEFAULT 0,
        candidate_count INTEGER NOT NULL DEFAULT 0,
        imported_at TEXT NOT NULL,
        completed_at TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE(logical_source, generation),
        UNIQUE(logical_source, file_sha256)
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_asset_import_files_source
        ON asset_import_files(logical_source, generation DESC)
    """,
    """
    CREATE TABLE IF NOT EXISTS source_rows (
        id TEXT PRIMARY KEY,
        import_file_id TEXT NOT NULL REFERENCES asset_import_files(id) ON DELETE CASCADE,
        sheet_name TEXT NOT NULL,
        row_number INTEGER NOT NULL CHECK(row_number > 0),
        raw_json TEXT NOT NULL,
        raw_sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(import_file_id, sheet_name, row_number)
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_source_rows_import
        ON source_rows(import_file_id, sheet_name, row_number)
    """,
    """
    CREATE TABLE IF NOT EXISTS candidates (
        id TEXT PRIMARY KEY,
        source_row_id TEXT NOT NULL REFERENCES source_rows(id) ON DELETE CASCADE,
        import_file_id TEXT NOT NULL REFERENCES asset_import_files(id) ON DELETE CASCADE,
        logical_source TEXT NOT NULL,
        source_type TEXT NOT NULL,
        generation INTEGER NOT NULL,
        candidate_kind TEXT NOT NULL,
        ordinal INTEGER NOT NULL DEFAULT 0,
        raw_target TEXT,
        canonical_url TEXT,
        hostname TEXT,
        ip_address TEXT,
        scheme TEXT,
        port INTEGER CHECK(port IS NULL OR (port BETWEEN 1 AND 65535)),
        endpoint_key TEXT,
        terminal_status TEXT NOT NULL CHECK(terminal_status IN (
            'profiled','pending_profile','unreachable','blocked','non_web',
            'duplicate','invalid','out_of_scope','stale','needs_review'
        )),
        terminal_reason TEXT,
        is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(source_row_id, ordinal)
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_candidates_endpoint
        ON candidates(endpoint_key, is_active, terminal_status)
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_candidates_source
        ON candidates(logical_source, generation, is_active)
    """,
    """
    CREATE TABLE IF NOT EXISTS enterprise_assets (
        id TEXT PRIMARY KEY,
        asset_type TEXT NOT NULL,
        endpoint_key TEXT NOT NULL UNIQUE,
        canonical_url TEXT,
        hostname TEXT,
        ip_address TEXT,
        scheme TEXT,
        port INTEGER CHECK(port IS NULL OR (port BETWEEN 1 AND 65535)),
        status TEXT NOT NULL,
        source_count INTEGER NOT NULL DEFAULT 0,
        official_source INTEGER NOT NULL DEFAULT 0 CHECK(official_source IN (0,1)),
        authoritative_candidate_id TEXT REFERENCES candidates(id),
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}'
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_enterprise_assets_status
        ON enterprise_assets(status, endpoint_key)
    """,
    """
    CREATE TABLE IF NOT EXISTS provenance (
        id TEXT PRIMARY KEY,
        asset_id TEXT NOT NULL REFERENCES enterprise_assets(id) ON DELETE CASCADE,
        candidate_id TEXT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
        source_row_id TEXT NOT NULL REFERENCES source_rows(id) ON DELETE CASCADE,
        import_file_id TEXT NOT NULL REFERENCES asset_import_files(id) ON DELETE CASCADE,
        logical_source TEXT NOT NULL,
        source_type TEXT NOT NULL,
        generation INTEGER NOT NULL,
        sheet_name TEXT NOT NULL,
        row_number INTEGER NOT NULL,
        observed_value TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(asset_id, candidate_id)
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_provenance_asset
        ON provenance(asset_id, source_type, logical_source)
    """,
    """
    CREATE TABLE IF NOT EXISTS asset_edges (
        id TEXT PRIMARY KEY,
        parent_asset_id TEXT REFERENCES enterprise_assets(id) ON DELETE CASCADE,
        child_asset_id TEXT NOT NULL REFERENCES enterprise_assets(id) ON DELETE CASCADE,
        relation_type TEXT NOT NULL,
        discovery_method TEXT NOT NULL,
        evidence_path TEXT,
        confidence REAL NOT NULL DEFAULT 0.5 CHECK(confidence BETWEEN 0 AND 1),
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        UNIQUE(parent_asset_id, child_asset_id, relation_type, discovery_method)
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_asset_edges_parent
        ON asset_edges(parent_asset_id, relation_type, child_asset_id)
    """,
    """
    CREATE TABLE IF NOT EXISTS scope_decisions (
        id TEXT PRIMARY KEY,
        candidate_id TEXT NOT NULL UNIQUE REFERENCES candidates(id) ON DELETE CASCADE,
        scope_root TEXT,
        in_scope INTEGER NOT NULL CHECK(in_scope IN (0,1)),
        reason TEXT NOT NULL,
        decided_at TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS validation_attempts (
        id TEXT PRIMARY KEY,
        asset_id TEXT NOT NULL REFERENCES enterprise_assets(id) ON DELETE CASCADE,
        outcome TEXT NOT NULL,
        detail TEXT,
        attempted_at TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS profile_tasks (
        id TEXT PRIMARY KEY,
        asset_id TEXT NOT NULL REFERENCES enterprise_assets(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(asset_id)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS profile_urls (
        id TEXT PRIMARY KEY,
        profile_task_id TEXT NOT NULL REFERENCES profile_tasks(id) ON DELETE CASCADE,
        url TEXT NOT NULL,
        function TEXT,
        technology_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        UNIQUE(profile_task_id, url)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS commit_outbox (
        id TEXT PRIMARY KEY,
        aggregate_type TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','committed','failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        committed_at TEXT,
        error TEXT
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_commit_outbox_pending
        ON commit_outbox(status, created_at)
    """,
)

# ---------------------------------------------------------------------------
# V7：URL 级画像工作项。资产端点（enterprise_assets/profile_tasks）只做身份
# 与汇总；待办、派发、按用途独立的尝试次数与 Run 栅栏全部由工作项层表达。
# 逻辑身份 = canonical_url + purpose + task_version（版本仅在明确重评/目标
# 变更/既有失效机制触发时变化）。多来源不生成多份同用途待办：来源历史记录
# 在 profile_work_item_sources 子表。
# ---------------------------------------------------------------------------
_PROFILE_SCHEMA_V7 = (
    """
    CREATE TABLE IF NOT EXISTS profile_work_items (
        id TEXT PRIMARY KEY,
        asset_id TEXT NOT NULL REFERENCES enterprise_assets(id) ON DELETE CASCADE,
        profile_task_id TEXT NOT NULL REFERENCES profile_tasks(id) ON DELETE CASCADE,
        canonical_url TEXT NOT NULL,
        purpose TEXT NOT NULL CHECK(purpose IN ('collect','review')),
        source_reason TEXT NOT NULL CHECK(source_reason IN (
            'baseline','discovered','incremental','needs_review'
        )),
        status TEXT NOT NULL CHECK(status IN (
            'pending','dispatched','partial','completed','consumed','exhausted','dropped'
        )),
        task_version INTEGER NOT NULL DEFAULT 1,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_dispatch_run_id TEXT,
        last_dispatch_job_id TEXT,
        last_error TEXT,
        completed_at TEXT,
        legacy_source INTEGER NOT NULL DEFAULT 0 CHECK(legacy_source IN (0,1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(canonical_url, purpose, task_version)
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_profile_work_items_status
        ON profile_work_items(purpose, status, attempts, last_dispatch_run_id)
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_profile_work_items_asset
        ON profile_work_items(asset_id, status)
    """,
    """
    CREATE TABLE IF NOT EXISTS profile_work_item_sources (
        work_item_id TEXT NOT NULL REFERENCES profile_work_items(id) ON DELETE CASCADE,
        source_reason TEXT NOT NULL CHECK(source_reason IN (
            'baseline','discovered','incremental','needs_review'
        )),
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        PRIMARY KEY(work_item_id, source_reason)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS profile_dispatches (
        id TEXT PRIMARY KEY,
        work_item_id TEXT NOT NULL REFERENCES profile_work_items(id) ON DELETE CASCADE,
        run_id TEXT,
        job_id TEXT NOT NULL,
        dispatched_at TEXT NOT NULL,
        counted INTEGER NOT NULL DEFAULT 1 CHECK(counted IN (0,1)),
        UNIQUE(job_id, work_item_id)
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_profile_dispatches_item
        ON profile_dispatches(work_item_id, dispatched_at)
    """,
    """
    CREATE TABLE IF NOT EXISTS profile_postprocess_receipts (
        job_id TEXT PRIMARY KEY,
        processed_at TEXT NOT NULL,
        summary_json TEXT NOT NULL DEFAULT '{}'
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS profile_migration_meta (
        name TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        completed_at TEXT NOT NULL,
        input_sha256 TEXT,
        imported INTEGER NOT NULL DEFAULT 0,
        merged INTEGER NOT NULL DEFAULT 0,
        skipped INTEGER NOT NULL DEFAULT 0,
        conflicts INTEGER NOT NULL DEFAULT 0,
        report_json TEXT
    )
    """,
)


_COMMIT_SCHEMA_V6 = (
    """
    CREATE TABLE IF NOT EXISTS commit_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        idempotency_key TEXT NOT NULL UNIQUE,
        event_type TEXT NOT NULL,
        aggregate_type TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        run_id TEXT,
        job_id TEXT,
        control_version INTEGER,
        payload_json TEXT NOT NULL,
        payload_sha256 TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN (
            'pending','projecting','retry_wait','committed','blocked','discarded'
        )),
        attempts INTEGER NOT NULL DEFAULT 0,
        available_at TEXT NOT NULL,
        lease_owner TEXT,
        lease_expires_at TEXT,
        last_error TEXT,
        occurred_at TEXT NOT NULL,
        enqueued_at TEXT NOT NULL,
        projected_at TEXT
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_commit_events_head
        ON commit_events(status, sequence, available_at, lease_expires_at)
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_commit_events_source
        ON commit_events(source_type, source_id)
    """,
    """
    CREATE TABLE IF NOT EXISTS commit_plans (
        plan_id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL UNIQUE REFERENCES commit_events(event_id) ON DELETE CASCADE,
        plan_version INTEGER NOT NULL,
        plan_json TEXT NOT NULL,
        plan_sha256 TEXT NOT NULL,
        action_count INTEGER NOT NULL,
        created_at TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS projection_receipts (
        event_id TEXT NOT NULL REFERENCES commit_events(event_id) ON DELETE CASCADE,
        action_key TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        sink_type TEXT NOT NULL,
        sink_path TEXT NOT NULL,
        content_sha256 TEXT NOT NULL,
        byte_count INTEGER NOT NULL DEFAULT 0,
        completed_at TEXT NOT NULL,
        PRIMARY KEY(event_id, action_key)
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_projection_receipts_sink
        ON projection_receipts(sink_path, completed_at)
    """,
    """
    CREATE TABLE IF NOT EXISTS projection_baselines (
        path TEXT PRIMARY KEY,
        media_type TEXT NOT NULL,
        content_blob BLOB NOT NULL,
        sha256 TEXT NOT NULL,
        through_sequence INTEGER NOT NULL DEFAULT 0,
        captured_at TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS projector_meta (
        id INTEGER PRIMARY KEY CHECK(id=1),
        baseline_sequence INTEGER NOT NULL DEFAULT 0,
        last_projected_sequence INTEGER NOT NULL DEFAULT 0,
        recovery_completed_at TEXT,
        last_success_at TEXT,
        last_error TEXT,
        fatal_error TEXT,
        updated_at TEXT NOT NULL
    )
    """,
    """
    CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_commit_event
        ON jobs(commit_event_id) WHERE commit_event_id IS NOT NULL
    """,
)

_COMMIT_SCHEMA_V6_TABLES = {
    "commit_events", "commit_plans", "projection_receipts",
    "projection_baselines", "projector_meta",
}

_ASSET_SCHEMA_V4_TABLES = {
    "asset_import_files",
    "source_rows",
    "candidates",
    "enterprise_assets",
    "provenance",
    "asset_edges",
    "scope_decisions",
    "validation_attempts",
    "profile_tasks",
    "profile_urls",
    "commit_outbox",
}

_ASSET_SCHEMA_REQUIRED_COLUMNS = {
    "asset_import_files": {
        "id", "logical_source", "source_type", "file_name", "file_sha256",
        "file_size", "generation", "status", "row_count", "candidate_count",
        "imported_at", "completed_at", "metadata_json",
    },
    "source_rows": {
        "id", "import_file_id", "sheet_name", "row_number", "raw_json",
        "raw_sha256", "created_at",
    },
    "candidates": {
        "id", "source_row_id", "import_file_id", "logical_source", "source_type",
        "generation", "candidate_kind", "ordinal", "raw_target", "canonical_url",
        "hostname", "ip_address", "scheme", "port", "endpoint_key",
        "terminal_status", "terminal_reason", "is_active", "metadata_json",
        "created_at", "updated_at",
    },
    "enterprise_assets": {
        "id", "asset_type", "endpoint_key", "canonical_url", "hostname",
        "ip_address", "scheme", "port", "status", "source_count",
        "official_source", "authoritative_candidate_id", "first_seen_at",
        "last_seen_at", "metadata_json",
    },
    "provenance": {
        "id", "asset_id", "candidate_id", "source_row_id", "import_file_id",
        "logical_source", "source_type", "generation", "sheet_name", "row_number",
        "observed_value", "created_at",
    },
    "asset_edges": {
        "id", "parent_asset_id", "child_asset_id", "relation_type",
        "discovery_method", "evidence_path", "confidence", "metadata_json", "created_at",
    },
    "scope_decisions": {
        "id", "candidate_id", "scope_root", "in_scope", "reason", "decided_at",
    },
    "validation_attempts": {"id", "asset_id", "outcome", "detail", "attempted_at"},
    "profile_tasks": {"id", "asset_id", "status", "attempts", "created_at", "updated_at"},
    "profile_urls": {
        "id", "profile_task_id", "url", "function", "technology_json", "created_at",
    },
    "commit_outbox": {
        "id", "aggregate_type", "aggregate_id", "event_type", "payload_json",
        "status", "attempts", "created_at", "committed_at", "error",
    },
}

_ASSET_SCHEMA_REQUIRED_INDEXES = {
    "idx_asset_import_files_source": ("logical_source", "generation"),
    "idx_source_rows_import": ("import_file_id", "sheet_name", "row_number"),
    "idx_candidates_endpoint": ("endpoint_key", "is_active", "terminal_status"),
    "idx_candidates_source": ("logical_source", "generation", "is_active"),
    "idx_enterprise_assets_status": ("status", "endpoint_key"),
    "idx_provenance_asset": ("asset_id", "source_type", "logical_source"),
    "idx_asset_edges_parent": ("parent_asset_id", "relation_type", "child_asset_id"),
    "idx_commit_outbox_pending": ("status", "created_at"),
}

_ASSET_SCHEMA_REQUIRED_FOREIGN_KEYS = {
    "source_rows": {("import_file_id", "asset_import_files", "id", "CASCADE")},
    "candidates": {
        ("source_row_id", "source_rows", "id", "CASCADE"),
        ("import_file_id", "asset_import_files", "id", "CASCADE"),
    },
    "provenance": {
        ("asset_id", "enterprise_assets", "id", "CASCADE"),
        ("candidate_id", "candidates", "id", "CASCADE"),
        ("source_row_id", "source_rows", "id", "CASCADE"),
        ("import_file_id", "asset_import_files", "id", "CASCADE"),
    },
    "profile_tasks": {("asset_id", "enterprise_assets", "id", "CASCADE")},
    "profile_urls": {("profile_task_id", "profile_tasks", "id", "CASCADE")},
}

_ASSET_SCHEMA_REQUIRED_UNIQUE_KEYS = {
    "asset_import_files": {
        ("logical_source", "generation"),
        ("logical_source", "file_sha256"),
    },
    "source_rows": {("import_file_id", "sheet_name", "row_number")},
    "candidates": {("source_row_id", "ordinal")},
    "enterprise_assets": {("endpoint_key",)},
    "provenance": {("asset_id", "candidate_id")},
    "scope_decisions": {("candidate_id",)},
    "profile_tasks": {("asset_id",)},
    "profile_urls": {("profile_task_id", "url")},
}


def direction_intent_projection_event_id(direction_id: str) -> str:
    """Deterministic projection-event id for a scheduler-registered direction."""
    return f"EV-DIRINT-{hashlib.sha256(str(direction_id).encode('utf-8')).hexdigest()[:20]}"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _lease_deadline(seconds: int) -> str:
    return (datetime.now(timezone.utc) + timedelta(seconds=seconds)).isoformat()


class ControlDatabase:
    """每项目 SQLite 控制库。

    JSONL/Markdown 继续作为人可读导出，SQLite 负责自动化任务的可恢复状态。
    """

    def __init__(self, path: Path):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.initialize()

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.path, timeout=30, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA secure_delete=ON")
        connection.execute("PRAGMA busy_timeout=30000")
        try:
            yield connection
        finally:
            connection.close()

    def initialize(self) -> None:
        with self.connect() as db:
            db.executescript(
                """
                CREATE TABLE IF NOT EXISTS schema_meta (
                    version INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS automation_runs (
                    id TEXT PRIMARY KEY,
                    project TEXT NOT NULL,
                    team TEXT NOT NULL,
                    status TEXT NOT NULL,
                    stage TEXT NOT NULL,
                    timeout_seconds INTEGER NOT NULL,
                    max_workers INTEGER NOT NULL,
                    completed_task_count INTEGER NOT NULL DEFAULT 0,
                    low_value_streak INTEGER NOT NULL DEFAULT 0,
                    no_direction_streak INTEGER NOT NULL DEFAULT 0,
                    control_version INTEGER NOT NULL DEFAULT 1,
                    wave INTEGER NOT NULL DEFAULT 1,
                    max_waves INTEGER NOT NULL DEFAULT 4,
                    execution_deadline TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    error TEXT
                );
                CREATE TABLE IF NOT EXISTS jobs (
                    id TEXT PRIMARY KEY,
                    run_id TEXT NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,
                    stage TEXT NOT NULL,
                    member_name TEXT NOT NULL,
                    role TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    result_json TEXT,
                    status TEXT NOT NULL,
                    attempts INTEGER NOT NULL DEFAULT 0,
                    max_attempts INTEGER NOT NULL DEFAULT 3,
                    worker_id TEXT,
                    lease_expires_at TEXT,
                    last_heartbeat_at TEXT,
                    error TEXT,
                    committed_at TEXT,
                    commit_error TEXT,
                    control_version INTEGER NOT NULL DEFAULT 1,
                    wave INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_jobs_claim
                    ON jobs(run_id, stage, status, lease_expires_at, created_at);
                CREATE TABLE IF NOT EXISTS events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    run_id TEXT,
                    job_id TEXT,
                    event_type TEXT NOT NULL,
                    data_json TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS directions (
                    id TEXT PRIMARY KEY,
                    fingerprint TEXT NOT NULL UNIQUE,
                    intent_json TEXT NOT NULL,
                    status TEXT NOT NULL,
                    claimed_by TEXT,
                    lease_expires_at TEXT,
                    terminal_reason TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_directions_claim
                    ON directions(status, lease_expires_at, created_at);
                """
            )
            meta_rows = db.execute("SELECT version FROM schema_meta").fetchall()
            if not meta_rows:
                db.execute("INSERT INTO schema_meta(version) VALUES (3)")
                current_version = 3
            elif len(meta_rows) != 1:
                raise RuntimeError("schema_meta 必须且只能包含一条版本记录")
            else:
                current_version = int(meta_rows[0]["version"])
            if current_version > SCHEMA_VERSION:
                raise RuntimeError(f"不支持的数据库版本: {current_version}")

            scrubbed_sensitive_data = False
            db.execute("BEGIN IMMEDIATE")
            try:
                self._ensure_column(db, "automation_runs", "control_version", "INTEGER NOT NULL DEFAULT 1")
                self._ensure_column(db, "automation_runs", "wave", "INTEGER NOT NULL DEFAULT 1")
                self._ensure_column(db, "automation_runs", "max_waves", "INTEGER NOT NULL DEFAULT 4")
                self._ensure_column(db, "automation_runs", "execution_deadline", "TEXT")
                self._ensure_column(db, "jobs", "control_version", "INTEGER NOT NULL DEFAULT 1")
                self._ensure_column(db, "jobs", "wave", "INTEGER NOT NULL DEFAULT 1")
                self._ensure_column(db, "jobs", "commit_state", "TEXT NOT NULL DEFAULT 'none'")
                self._ensure_column(db, "jobs", "commit_event_id", "TEXT")
                self._ensure_column(db, "jobs", "commit_enqueued_at", "TEXT")
                self._ensure_column(db, "jobs", "commit_projected_at", "TEXT")
                self._ensure_column(db, "directions", "terminal_reason", "TEXT")
                # 方向认领版本：每次认领自增。心跳/完成回写校验该版本，
                # 防止恢复后同认领者名称（run_id:member 跨波次复用）的
                # 旧 Worker 回调取消或影响新认领。
                self._ensure_column(db, "directions", "claim_version", "INTEGER NOT NULL DEFAULT 0")
                # Always replay idempotent DDL. This safely repairs missing tables and
                # ordinary indexes even when an earlier local draft already stamped
                # the database as V4.
                for statement in _ASSET_SCHEMA_V4:
                    try:
                        db.execute(statement)
                    except sqlite3.OperationalError as exc:
                        if (
                            statement.lstrip().upper().startswith("CREATE INDEX")
                            and "no such column" in str(exc).casefold()
                        ):
                            continue
                        raise
                self._repair_safe_asset_columns(db)
                for statement in _ASSET_SCHEMA_V4:
                    db.execute(statement)
                self._validate_asset_schema(db)
                if current_version < 5:
                    self._scrub_asset_source_values(db)
                    scrubbed_sensitive_data = True
                for statement in _COMMIT_SCHEMA_V6:
                    db.execute(statement)
                self._migrate_commit_schema_v6(db, current_version)
                self._validate_commit_schema_v6(db)
                # V7 只做 DDL（表/列/索引/约束）；旧 JSON 队列的数据导入由
                # 应用层 AssetInventory.migrate_legacy_profile_state 完成，
                # 避免数据库初始化反向依赖高层画像模块。
                for statement in _PROFILE_SCHEMA_V7:
                    db.execute(statement)
                foreign_key_errors = db.execute("PRAGMA foreign_key_check").fetchall()
                if foreign_key_errors:
                    raise RuntimeError(
                        f"资产数据库外键检查失败: {len(foreign_key_errors)} 条异常"
                    )
                quick_check = db.execute("PRAGMA quick_check").fetchone()
                if quick_check is None or str(quick_check[0]).casefold() != "ok":
                    raise RuntimeError(f"资产数据库完整性检查失败: {quick_check[0] if quick_check else 'unknown'}")
                db.execute("UPDATE schema_meta SET version=?", (SCHEMA_VERSION,))
                db.execute("COMMIT")
            except Exception:
                db.execute("ROLLBACK")
                raise
            if scrubbed_sensitive_data:
                # Secure-delete removes overwritten cells; checkpoint + VACUUM also
                # prevents old source values from surviving in WAL or free pages.
                db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
                db.execute("VACUUM")

    @staticmethod
    def _ensure_column(
        db: sqlite3.Connection,
        table: str,
        column: str,
        declaration: str,
    ) -> None:
        names = {str(row["name"]) for row in db.execute(f"PRAGMA table_info({table})").fetchall()}
        if column not in names:
            db.execute(f"ALTER TABLE {table} ADD COLUMN {column} {declaration}")

    @classmethod
    def _repair_safe_asset_columns(cls, db: sqlite3.Connection) -> None:
        safe_columns = {
            "asset_import_files": {
                "row_count": "INTEGER NOT NULL DEFAULT 0",
                "candidate_count": "INTEGER NOT NULL DEFAULT 0",
                "completed_at": "TEXT",
                "metadata_json": "TEXT NOT NULL DEFAULT '{}'",
            },
            "candidates": {
                "terminal_reason": "TEXT",
                "is_active": "INTEGER NOT NULL DEFAULT 1",
                "metadata_json": "TEXT NOT NULL DEFAULT '{}'",
            },
            "enterprise_assets": {
                "source_count": "INTEGER NOT NULL DEFAULT 0",
                "official_source": "INTEGER NOT NULL DEFAULT 0",
                "authoritative_candidate_id": "TEXT",
                "metadata_json": "TEXT NOT NULL DEFAULT '{}'",
            },
            "asset_edges": {
                "evidence_path": "TEXT",
                "confidence": "REAL NOT NULL DEFAULT 0.5",
                "metadata_json": "TEXT NOT NULL DEFAULT '{}'",
            },
            "profile_tasks": {"attempts": "INTEGER NOT NULL DEFAULT 0"},
            "profile_urls": {"technology_json": "TEXT NOT NULL DEFAULT '[]'"},
            "commit_outbox": {
                "attempts": "INTEGER NOT NULL DEFAULT 0",
                "committed_at": "TEXT",
                "error": "TEXT",
            },
        }
        present = {
            str(row["name"])
            for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
        }
        for table, columns in safe_columns.items():
            if table not in present:
                continue
            for name, declaration in columns.items():
                cls._ensure_column(db, table, name, declaration)

    @staticmethod
    def _index_columns(db: sqlite3.Connection, table: str) -> tuple[set[tuple[str, ...]], dict[str, tuple[str, ...]]]:
        unique: set[tuple[str, ...]] = set()
        named: dict[str, tuple[str, ...]] = {}
        for row in db.execute(f"PRAGMA index_list({table})").fetchall():
            name = str(row["name"])
            columns = tuple(
                str(item["name"])
                for item in db.execute(f'PRAGMA index_info("{name}")').fetchall()
            )
            named[name] = columns
            if int(row["unique"]):
                unique.add(columns)
        return unique, named

    @classmethod
    def _validate_asset_schema(cls, db: sqlite3.Connection) -> None:
        present = {
            str(row["name"])
            for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
        }
        missing_tables = sorted(_ASSET_SCHEMA_V4_TABLES - present)
        if missing_tables:
            raise RuntimeError(f"资产数据库缺少表: {', '.join(missing_tables)}")
        indexes_by_table: dict[str, dict[str, tuple[str, ...]]] = {}
        for table, required in _ASSET_SCHEMA_REQUIRED_COLUMNS.items():
            actual = {
                str(row["name"])
                for row in db.execute(f"PRAGMA table_info({table})").fetchall()
            }
            missing = sorted(required - actual)
            if missing:
                raise RuntimeError(f"资产数据库表 {table} 缺少列: {', '.join(missing)}")
            unique, named = cls._index_columns(db, table)
            indexes_by_table[table] = named
            required_unique = _ASSET_SCHEMA_REQUIRED_UNIQUE_KEYS.get(table, set())
            missing_unique = sorted(required_unique - unique)
            if missing_unique:
                raise RuntimeError(f"资产数据库表 {table} 缺少唯一约束: {missing_unique}")
        all_named = {
            name: columns
            for table_indexes in indexes_by_table.values()
            for name, columns in table_indexes.items()
        }
        for name, columns in _ASSET_SCHEMA_REQUIRED_INDEXES.items():
            if all_named.get(name) != columns:
                raise RuntimeError(
                    f"资产数据库索引 {name} 结构异常: expected={columns}, actual={all_named.get(name)}"
                )
        for table, required in _ASSET_SCHEMA_REQUIRED_FOREIGN_KEYS.items():
            actual = {
                (
                    str(row["from"]), str(row["table"]), str(row["to"]),
                    str(row["on_delete"]).upper(),
                )
                for row in db.execute(f"PRAGMA foreign_key_list({table})").fetchall()
            }
            missing = required - actual
            if missing:
                raise RuntimeError(f"资产数据库表 {table} 缺少外键: {sorted(missing)}")

    @staticmethod
    def _scrub_asset_source_values(db: sqlite3.Connection) -> None:
        def safe_candidate(row: sqlite3.Row) -> str:
            if row["canonical_url"]:
                return str(row["canonical_url"])
            host = str(row["hostname"] or row["ip_address"] or "")
            port = int(row["port"] or 0)
            return f"{host}:{port}" if host and port else host

        candidates = db.execute(
            "SELECT id,source_row_id,canonical_url,hostname,ip_address,port FROM candidates"
        ).fetchall()
        safe_by_id: dict[str, str] = {}
        by_source_row: dict[str, list[str]] = {}
        for row in candidates:
            value = safe_candidate(row)
            safe_by_id[str(row["id"])] = value
            by_source_row.setdefault(str(row["source_row_id"]), []).append(value)
            db.execute("UPDATE candidates SET raw_target=? WHERE id=?", (value, row["id"]))
        for row in db.execute("SELECT id FROM source_rows").fetchall():
            values = sorted(dict.fromkeys(
                value for value in by_source_row.get(str(row["id"]), []) if value
            ))
            minimal = json.dumps(
                {"redacted": True, "asset_values": values},
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            )
            db.execute("UPDATE source_rows SET raw_json=? WHERE id=?", (minimal, row["id"]))
        for row in db.execute("SELECT id,candidate_id FROM provenance").fetchall():
            db.execute(
                "UPDATE provenance SET observed_value=? WHERE id=?",
                (safe_by_id.get(str(row["candidate_id"]), ""), row["id"]),
            )

    @staticmethod
    def _canonical_json(value: object) -> str:
        return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))

    @classmethod
    def _migrate_commit_schema_v6(
        cls,
        db: sqlite3.Connection,
        current_version: int,
    ) -> None:
        now = _now()
        db.execute(
            """
            INSERT INTO projector_meta(
                id,baseline_sequence,last_projected_sequence,updated_at
            ) VALUES (1,0,0,?) ON CONFLICT(id) DO NOTHING
            """,
            (now,),
        )
        if current_version < 6:
            for row in db.execute("SELECT * FROM commit_outbox ORDER BY created_at,id").fetchall():
                legacy_id = str(row["id"])
                event_id = f"EV-V5-{legacy_id}"
                payload = {
                    "legacy_outbox_id": legacy_id,
                    "event_type": str(row["event_type"]),
                    "payload": json.loads(str(row["payload_json"] or "{}")),
                }
                payload_json = cls._canonical_json(payload)
                plan = {
                    "version": 1,
                    "event_id": event_id,
                    "actions": [],
                    "legacy": True,
                }
                plan_json = cls._canonical_json(plan)
                db.execute(
                    """
                    INSERT INTO commit_events(
                        event_id,idempotency_key,event_type,aggregate_type,aggregate_id,
                        source_type,source_id,payload_json,payload_sha256,status,attempts,
                        available_at,occurred_at,enqueued_at,projected_at
                    ) VALUES (?,?,?,?,?,?,?,?,?,'committed',0,?,?,?,?)
                    ON CONFLICT(idempotency_key) DO NOTHING
                    """,
                    (
                        event_id, f"v5:commit_outbox:{legacy_id}", str(row["event_type"]),
                        str(row["aggregate_type"]), str(row["aggregate_id"]),
                        "legacy_outbox", legacy_id, payload_json,
                        hashlib.sha256(payload_json.encode("utf-8")).hexdigest(),
                        str(row["created_at"]), str(row["created_at"]),
                        str(row["created_at"]), str(row["committed_at"] or row["created_at"]),
                    ),
                )
                db.execute(
                    """
                    INSERT INTO commit_plans(
                        plan_id,event_id,plan_version,plan_json,plan_sha256,
                        action_count,created_at
                    ) VALUES (?,?,?,?,?,0,?) ON CONFLICT(event_id) DO NOTHING
                    """,
                    (
                        f"CP-V5-{legacy_id}", event_id, 1, plan_json,
                        hashlib.sha256(plan_json.encode("utf-8")).hexdigest(),
                        str(row["created_at"]),
                    ),
                )
            db.execute(
                """
                UPDATE jobs SET commit_state=CASE
                    WHEN committed_at IS NOT NULL AND commit_error IS NULL THEN 'projected'
                    WHEN committed_at IS NOT NULL AND commit_error IS NOT NULL THEN 'rejected'
                    ELSE 'none'
                END,
                commit_enqueued_at=CASE WHEN committed_at IS NOT NULL THEN committed_at ELSE commit_enqueued_at END,
                commit_projected_at=CASE
                    WHEN committed_at IS NOT NULL AND commit_error IS NULL THEN committed_at
                    ELSE commit_projected_at
                END
                WHERE commit_state='none'
                """
            )

    @classmethod
    def _validate_commit_schema_v6(cls, db: sqlite3.Connection) -> None:
        present = {
            str(row["name"])
            for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
        }
        missing = sorted(_COMMIT_SCHEMA_V6_TABLES - present)
        if missing:
            raise RuntimeError(f"提交数据库缺少 V6 表: {', '.join(missing)}")
        required_columns = {
            "commit_events": {
                "sequence", "event_id", "idempotency_key", "event_type",
                "aggregate_type", "aggregate_id", "source_type", "source_id",
                "run_id", "job_id", "control_version", "payload_json",
                "payload_sha256", "status", "attempts", "available_at",
                "lease_owner", "lease_expires_at", "last_error", "occurred_at",
                "enqueued_at", "projected_at",
            },
            "commit_plans": {
                "plan_id", "event_id", "plan_version", "plan_json",
                "plan_sha256", "action_count", "created_at",
            },
            "projection_receipts": {
                "event_id", "action_key", "idempotency_key", "sink_type",
                "sink_path", "content_sha256", "byte_count", "completed_at",
            },
            "projection_baselines": {
                "path", "media_type", "content_blob", "sha256",
                "through_sequence", "captured_at",
            },
            "projector_meta": {
                "id", "baseline_sequence", "last_projected_sequence",
                "recovery_completed_at", "last_success_at", "last_error",
                "fatal_error", "updated_at",
            },
        }
        required_columns["jobs"] = {
            "commit_state", "commit_event_id", "commit_enqueued_at", "commit_projected_at",
        }
        indexes_by_table: dict[str, dict[str, tuple[str, ...]]] = {}
        unique_by_table: dict[str, set[tuple[str, ...]]] = {}
        for table, required in required_columns.items():
            actual = {
                str(row["name"])
                for row in db.execute(f"PRAGMA table_info({table})").fetchall()
            }
            missing_columns = sorted(required - actual)
            if missing_columns:
                raise RuntimeError(f"提交数据库表 {table} 缺少列: {missing_columns}")
            unique, named = cls._index_columns(db, table)
            unique_by_table[table] = unique
            indexes_by_table[table] = named
        required_unique = {
            "commit_events": {("event_id",), ("idempotency_key",)},
            "commit_plans": {("plan_id",), ("event_id",)},
            "projection_receipts": {
                ("event_id", "action_key"),
                ("idempotency_key",),
            },
        }
        for table, expected in required_unique.items():
            missing_unique = sorted(expected - unique_by_table[table])
            if missing_unique:
                raise RuntimeError(
                    f"提交数据库表 {table} 缺少唯一约束: {missing_unique}"
                )
        named_indexes = {
            name: columns
            for table_indexes in indexes_by_table.values()
            for name, columns in table_indexes.items()
        }
        expected_indexes = {
            "idx_commit_events_head": (
                "status", "sequence", "available_at", "lease_expires_at",
            ),
            "idx_commit_events_source": ("source_type", "source_id"),
            "idx_projection_receipts_sink": ("sink_path", "completed_at"),
            "idx_jobs_commit_event": ("commit_event_id",),
        }
        for name, expected in expected_indexes.items():
            if named_indexes.get(name) != expected:
                raise RuntimeError(
                    f"提交数据库索引 {name} 结构异常: "
                    f"expected={expected}, actual={named_indexes.get(name)}"
                )
        expected_foreign_keys = {
            "commit_plans": {("event_id", "commit_events", "event_id", "CASCADE")},
            "projection_receipts": {
                ("event_id", "commit_events", "event_id", "CASCADE"),
            },
        }
        for table, expected in expected_foreign_keys.items():
            actual = {
                (
                    str(row["from"]), str(row["table"]), str(row["to"]),
                    str(row["on_delete"]).upper(),
                )
                for row in db.execute(f"PRAGMA foreign_key_list({table})").fetchall()
            }
            missing_foreign_keys = expected - actual
            if missing_foreign_keys:
                raise RuntimeError(
                    f"提交数据库表 {table} 缺少外键: "
                    f"{sorted(missing_foreign_keys)}"
                )

    def create_run(
        self,
        project: str,
        team: str,
        timeout_seconds: int,
        max_workers: int,
        *,
        execution_lease_seconds: int = 900,
        max_waves: int = 4,
        initial_stage: str = "swarm",
    ) -> str:
        run_id = f"R-{uuid4().hex[:12]}"
        now = _now()
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            active = db.execute(
                """
                SELECT id,status FROM automation_runs
                WHERE project=? AND status IN ('running','paused','stopping')
                ORDER BY created_at DESC LIMIT 1
                """,
                (project,),
            ).fetchone()
            if active is not None:
                db.execute("ROLLBACK")
                raise RuntimeError(
                    f"项目已有未结束运行 {active['id']} ({active['status']})，"
                    "请先恢复、批准或取消该运行。"
                )
            previous = db.execute(
                """
                SELECT completed_task_count,low_value_streak,no_direction_streak,control_version
                FROM automation_runs WHERE project=? ORDER BY created_at DESC LIMIT 1
                """,
                (project,),
            ).fetchone()
            counters = (
                int(previous["completed_task_count"]),
                int(previous["low_value_streak"]),
                int(previous["no_direction_streak"]),
            ) if previous else (0, 0, 0)
            control_version = int(previous["control_version"]) + 1 if previous else 1
            db.execute(
                """
                INSERT INTO automation_runs(
                    id,project,team,status,stage,timeout_seconds,max_workers,
                    completed_task_count,low_value_streak,no_direction_streak,control_version,
                    wave,max_waves,execution_deadline,
                    created_at,updated_at,error
                ) VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, NULL)
                """,
                (
                    run_id, project, team, initial_stage, timeout_seconds, max_workers,
                    *counters, control_version, max(1, max_waves),
                    _lease_deadline(max(60, execution_lease_seconds)), now, now,
                ),
            )
            self._event(db, run_id, None, "run_created", {"team": team})
            db.execute("COMMIT")
        return run_id

    def enqueue_job(
        self,
        run_id: str,
        stage: str,
        member_name: str,
        role: str,
        payload: dict[str, Any],
        max_attempts: int = 3,
        wave: int | None = None,
    ) -> str:
        job_id = f"J-{uuid4().hex[:12]}"
        now = _now()
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            run = db.execute(
                "SELECT status,control_version,wave FROM automation_runs WHERE id=?",
                (run_id,),
            ).fetchone()
            if run is None or run["status"] != "running":
                db.execute("ROLLBACK")
                raise RuntimeError(f"运行 {run_id} 不接受新任务。")
            db.execute(
                """
                INSERT INTO jobs(
                    id,run_id,stage,member_name,role,payload_json,status,attempts,max_attempts,
                    control_version,wave,created_at,updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?)
                """,
                (
                    job_id, run_id, stage, member_name, role,
                    json.dumps(payload, ensure_ascii=False), max_attempts,
                    int(run["control_version"]), int(wave or run["wave"]), now, now,
                ),
            )
            self._event(db, run_id, job_id, "job_queued", {"stage": stage, "member": member_name})
            db.execute("COMMIT")
        return job_id

    def enqueue_profile_job_atomic(
        self,
        run_id: str,
        stage: str,
        member_name: str,
        role: str,
        payload: dict[str, Any],
        work_item_ids: list[str],
        max_attempts: int = 3,
        wave: int | None = None,
        run_fence: bool = False,
        collect_cap: int = 3,
        review_cap: int = 2,
    ) -> str:
        """Create one profile job and mark its work items dispatched atomically.

        工作项置 dispatched、尝试次数 +1、派发回执与 Job 插入在同一事务。
        事务内重新校验每个工作项在**当前时刻**仍可派发（状态 pending/partial
        且 attempts 未达对应用途上限；``run_fence=True`` 时还要求未被本 Run
        派发过）——调度器持旧查询结果重复派发同一工作项时整体回滚并抛错，
        不会创建第二个 Job、也不会重复扣预算。``UNIQUE(job_id, work_item_id)``
        只防同 Job 重复，跨 Job 的防重依赖这里的事务内条件校验。
        尝试次数只在派发回执为新插入时递增；同一派发的技术重试与重放不重复
        计数。Run 栅栏只应由增量/复核调度传入（基础画像允许多轮，传 False）。
        """
        job_id = f"J-{uuid4().hex[:12]}"
        now = _now()
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                run = db.execute(
                    "SELECT status,control_version,wave FROM automation_runs WHERE id=?",
                    (run_id,),
                ).fetchone()
                if run is None or run["status"] != "running":
                    raise RuntimeError(f"运行 {run_id} 不接受新任务。")
                marker = db.execute(
                    "SELECT 1 FROM profile_migration_meta WHERE name='legacy_profile_state_v1'",
                ).fetchone()
                if marker is None:
                    raise RuntimeError(
                        "画像队列迁移未完成：请先完成 legacy JSON 导入"
                        "（AssetInventory.ensure_profile_migration）再派发画像任务"
                    )
                # 事务内条件校验：快照失效（已被他方派发/预算耗尽/栅栏命中）
                # 时整体回滚，不产生“半派发”。
                for work_item_id in work_item_ids:
                    row = db.execute(
                        """
                        SELECT purpose,status,attempts,last_dispatch_run_id
                        FROM profile_work_items WHERE id=?
                        """,
                        (work_item_id,),
                    ).fetchone()
                    if row is None:
                        raise RuntimeError(
                            f"画像工作项不再可派发（不存在）: {work_item_id}"
                        )
                    cap = review_cap if str(row["purpose"]) == "review" else collect_cap
                    if str(row["status"]) not in {"pending", "partial"}:
                        raise RuntimeError(
                            f"画像工作项不再可派发（状态 {row['status']}）: {work_item_id}"
                        )
                    if int(row["attempts"] or 0) >= int(cap):
                        raise RuntimeError(
                            f"画像工作项不再可派发（预算已耗尽）: {work_item_id}"
                        )
                    if run_fence and str(row["last_dispatch_run_id"] or "") == str(run_id):
                        raise RuntimeError(
                            f"画像工作项不再可派发（本 Run 已派发过）: {work_item_id}"
                        )
                db.execute(
                    """
                    INSERT INTO jobs(
                        id,run_id,stage,member_name,role,payload_json,status,attempts,max_attempts,
                        control_version,wave,created_at,updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?)
                    """,
                    (
                        job_id, run_id, stage, member_name, role,
                        json.dumps(payload, ensure_ascii=False), max_attempts,
                        int(run["control_version"]), int(wave or run["wave"]), now, now,
                    ),
                )
                for work_item_id in work_item_ids:
                    inserted = db.execute(
                        """
                        INSERT OR IGNORE INTO profile_dispatches(
                            id,work_item_id,run_id,job_id,dispatched_at
                        ) VALUES (?,?,?,?,?)
                        """,
                        (f"PD-{uuid4().hex[:12]}", work_item_id, run_id, job_id, now),
                    )
                    if inserted.rowcount == 1:
                        updated = db.execute(
                            """
                            UPDATE profile_work_items
                            SET status='dispatched',attempts=attempts+1,
                                last_dispatch_run_id=?,last_dispatch_job_id=?,updated_at=?
                            WHERE id=? AND status IN ('pending','partial')
                            """,
                            (run_id, job_id, now, work_item_id),
                        )
                        if updated.rowcount != 1:
                            raise RuntimeError(
                                f"画像工作项不再可派发（并发状态变化）: {work_item_id}"
                            )
                self._event(db, run_id, job_id, "job_queued", {"stage": stage, "member": member_name})
                self._event(db, run_id, job_id, "profile_work_dispatched", {
                    "work_item_count": len(work_item_ids),
                })
                db.execute("COMMIT")
            except Exception:
                db.execute("ROLLBACK")
                raise
        return job_id

    def register_direction(
        self,
        intent: dict[str, Any],
        *,
        record_intent_projection: bool = False,
        initial_status: str = "open",
        initial_terminal_reason: str | None = None,
        hypothesis_payload: dict[str, Any] | None = None,
    ) -> tuple[str, bool]:
        """Register a direction; optionally enqueue its intents.jsonl projection.

        ``initial_status='released'`` + ``initial_terminal_reason`` 用于继承
        同一测试未到期的策略冷却：新版本以冷却态注册，不可被立即认领。
        ``record_intent_projection`` 在同一事务内写入待投影事件，交由既有
        Projector 幂等补写 intents.jsonl——SQLite 提交成功而文件写入失败时
        记录不会丢失。
        """
        if initial_status not in {"open", "released"}:
            raise ValueError(f"非法初始方向状态: {initial_status}")
        identity = "\x1f".join(
            str(intent.get(key, "")).strip().casefold()
            for key in ("verb", "target", "hypothesis", "success_criteria", "chain_id", "sequence")
        )
        fingerprint = hashlib.sha256(identity.encode("utf-8")).hexdigest()
        direction_id = str(intent.get("id") or f"I-{uuid4().hex[:12]}")
        now = _now()
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            existing = db.execute("SELECT id FROM directions WHERE fingerprint=?", (fingerprint,)).fetchone()
            if existing:
                self._event(db, None, None, "direction_duplicate", {"direction_id": existing["id"]})
                db.execute("COMMIT")
                return str(existing["id"]), False
            db.execute(
                """
                INSERT INTO directions(id,fingerprint,intent_json,status,terminal_reason,created_at,updated_at)
                VALUES (?,?,?,?,?,?,?)
                """,
                (
                    direction_id, fingerprint, json.dumps(intent, ensure_ascii=False),
                    initial_status, initial_terminal_reason, now, now,
                ),
            )
            if record_intent_projection:
                self._insert_direction_intent_projection(
                    db, direction_id, intent, hypothesis_payload=hypothesis_payload,
                )
            self._event(db, None, None, "direction_registered", {"direction_id": direction_id})
            db.execute("COMMIT")
        return direction_id, True

    @classmethod
    def _insert_direction_intent_projection(
        cls,
        db: sqlite3.Connection,
        direction_id: str,
        intent_payload: dict[str, Any],
        hypothesis_payload: dict[str, Any] | None = None,
    ) -> str:
        """Pending projection event for a scheduler-registered direction.

        必须与方向 INSERT 处于同一事务：SQLite 是权威，intents.jsonl/
        hypotheses.jsonl 只是投影；文件写入失败时事件保持 pending，由既有
        Projector（后台循环或恢复入口）以幂等回执补写，不依赖调用方紧跟着
        写文件。载荷结构：{"intent": ..., "hypothesis": ... | null}。
        """
        event_id = direction_intent_projection_event_id(direction_id)
        now = _now()
        action = {
            "action_key": "record_direction_intent:0",
            "kind": "record_direction_intent",
            "payload": {
                "intent": intent_payload,
                "hypothesis": hypothesis_payload,
            },
        }
        plan_json = cls._canonical_json({"version": 1, "event_id": event_id, "actions": [action]})
        payload_json = cls._canonical_json({
            "kind": "record_direction_intent",
            "payload": action["payload"],
        })
        db.execute(
            """
            INSERT INTO commit_events(
                event_id,idempotency_key,event_type,aggregate_type,aggregate_id,
                source_type,source_id,run_id,job_id,control_version,payload_json,
                payload_sha256,status,attempts,available_at,occurred_at,enqueued_at
            ) VALUES (?,?,?,?,?,?,?,NULL,NULL,NULL,?,?,'pending',0,?,?,?)
            ON CONFLICT(idempotency_key) DO NOTHING
            """,
            (
                event_id, f"direction_intent:{direction_id}", "record_direction_intent",
                "direction_intent", direction_id, "profile_scheduler", direction_id,
                payload_json, hashlib.sha256(payload_json.encode("utf-8")).hexdigest(),
                now, now, now,
            ),
        )
        db.execute(
            """
            INSERT INTO commit_plans(
                plan_id,event_id,plan_version,plan_json,plan_sha256,action_count,created_at
            ) VALUES (?,?,?,?,?,1,?)
            ON CONFLICT(event_id) DO NOTHING
            """,
            (
                f"CP-DIRINT-{hashlib.sha256(str(direction_id).encode('utf-8')).hexdigest()[:20]}",
                event_id, 1, plan_json,
                hashlib.sha256(plan_json.encode("utf-8")).hexdigest(), now,
            ),
        )
        return event_id

    def claim_direction(self, worker_id: str, lease_seconds: int = 60) -> dict[str, Any] | None:
        now = _now()
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                """
                SELECT * FROM directions
                WHERE status='open'
                    OR (
                        status='released' AND (
                            terminal_reason IS NULL
                            OR terminal_reason NOT LIKE 'policy_blocked_until:%'
                            OR substr(terminal_reason, length('policy_blocked_until:') + 1) <= ?
                        )
                    )
                    OR (status='claimed' AND lease_expires_at < ?)
                ORDER BY
                    CASE
                        WHEN json_extract(intent_json, '$.requires_human_confirmation') THEN 0
                        ELSE 1
                    END,
                    CAST(coalesce(json_extract(intent_json, '$.priority_score'), 0) AS REAL) DESC,
                    CASE lower(coalesce(json_extract(intent_json, '$.risk_level'), 'low'))
                        WHEN 'critical' THEN 0
                        WHEN 'high' THEN 1
                        WHEN 'medium' THEN 2
                        WHEN 'low' THEN 3
                        ELSE 4
                    END,
                    CAST(coalesce(json_extract(intent_json, '$.target_score'), -1) AS INTEGER) DESC,
                    created_at,
                    id
                LIMIT 1
                """,
                (now, now),
            ).fetchone()
            if row is None:
                db.execute("COMMIT")
                return None
            db.execute(
                """
                UPDATE directions SET status='claimed',claimed_by=?,lease_expires_at=?,
                    claim_version=claim_version+1,updated_at=? WHERE id=?
                """,
                (worker_id, _lease_deadline(lease_seconds), now, row["id"]),
            )
            self._event(db, None, None, "direction_claimed", {"direction_id": row["id"], "worker_id": worker_id})
            db.execute("COMMIT")
            result = dict(row)
            result["intent"] = json.loads(result.pop("intent_json"))
            result.update({
                "status": "claimed",
                "claimed_by": worker_id,
                "claim_version": int(row["claim_version"] or 0) + 1,
            })
            return result

    def heartbeat_direction(
        self,
        direction_id: str,
        worker_id: str,
        lease_seconds: int = 60,
        claim_version: int | None = None,
    ) -> bool:
        with self.connect() as db:
            result = db.execute(
                """
                UPDATE directions SET lease_expires_at=?,updated_at=?
                WHERE id=? AND claimed_by=? AND status='claimed'
                  AND (? IS NULL OR claim_version=?)
                """,
                (
                    _lease_deadline(lease_seconds), _now(), direction_id, worker_id,
                    claim_version, claim_version,
                ),
            )
            return result.rowcount == 1

    def finish_direction(
        self,
        direction_id: str,
        worker_id: str,
        success: bool | None = None,
        *,
        outcome: str | None = None,
        reason: str | None = None,
        claim_version: int | None = None,
    ) -> bool:
        with self.connect() as db:
            status = outcome or ("completed" if success else "released")
            if status not in {
                "completed", "rejected", "exhausted", "blocked", "cancelled", "released",
            }:
                raise ValueError(f"非法 Intent 终态: {status}")
            updated = db.execute(
                """
                UPDATE directions SET status=?,claimed_by=NULL,lease_expires_at=NULL,
                    terminal_reason=?,updated_at=?
                WHERE id=? AND claimed_by=? AND status='claimed'
                  AND (? IS NULL OR claim_version=?)
                """,
                (
                    status, reason, _now(), direction_id, worker_id,
                    claim_version, claim_version,
                ),
            )
            if updated.rowcount != 1:
                return False
            self._event(db, None, None, "direction_finished", {
                "direction_id": direction_id, "status": status, "reason": reason,
            })
            return True

    def list_directions(self) -> list[dict[str, Any]]:
        with self.connect() as db:
            rows = [dict(row) for row in db.execute("SELECT * FROM directions ORDER BY created_at,id").fetchall()]
        for row in rows:
            row["intent"] = json.loads(row.pop("intent_json"))
        return rows

    def get_direction(self, direction_id: str) -> dict[str, Any] | None:
        with self.connect() as db:
            row = db.execute("SELECT * FROM directions WHERE id=?", (direction_id,)).fetchone()
        if row is None:
            return None
        result = dict(row)
        result["intent"] = json.loads(result.pop("intent_json"))
        return result

    def dismiss_direction(self, direction_id: str, reason: str) -> dict[str, Any]:
        """Human-reject a direction and fence every not-yet-committed job bound to it."""
        reason = reason.strip()
        if not reason:
            raise ValueError("人工否决方向必须填写理由。")
        now = _now()
        terminal_reason = f"human_dismissed:{reason[:1000]}"
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            direction = db.execute(
                "SELECT * FROM directions WHERE id=?", (direction_id,)
            ).fetchone()
            if direction is None:
                db.execute("ROLLBACK")
                raise RuntimeError(f"方向不存在: {direction_id}")
            if direction["status"] == "cancelled" and str(direction["terminal_reason"] or "").startswith("human_dismissed:"):
                db.execute("COMMIT")
                return self.get_direction(direction_id) or {}

            matched_jobs = db.execute(
                """
                SELECT id,run_id,status FROM jobs
                WHERE json_extract(payload_json, '$.direction.id')=?
                  AND committed_at IS NULL
                  AND status IN ('queued','running','completed','cancelling')
                """,
                (direction_id,),
            ).fetchall()
            db.execute(
                """
                UPDATE directions SET status='cancelled',claimed_by=NULL,lease_expires_at=NULL,
                    terminal_reason=?,updated_at=? WHERE id=?
                """,
                (terminal_reason, now, direction_id),
            )
            db.execute(
                """
                UPDATE jobs SET status='cancelled',error=?,worker_id=NULL,
                    lease_expires_at=NULL,updated_at=?
                WHERE json_extract(payload_json, '$.direction.id')=?
                  AND committed_at IS NULL AND status IN ('queued','completed')
                """,
                (terminal_reason, now, direction_id),
            )
            db.execute(
                """
                UPDATE jobs SET status='cancelling',error=?,updated_at=?
                WHERE json_extract(payload_json, '$.direction.id')=?
                  AND committed_at IS NULL AND status='running'
                """,
                (terminal_reason, now, direction_id),
            )
            for job in matched_jobs:
                next_status = "cancelling" if job["status"] == "running" else "cancelled"
                self._event(db, job["run_id"], job["id"], "job_human_cancelled", {
                    "direction_id": direction_id,
                    "status": next_status,
                    "reason": reason[:1000],
                })
            self._event(db, None, None, "direction_human_dismissed", {
                "direction_id": direction_id,
                "reason": reason[:1000],
                "affected_jobs": len(matched_jobs),
            })
            db.execute("COMMIT")
        return self.get_direction(direction_id) or {}

    def supersede_and_register_direction(
        self,
        intent: dict[str, Any],
        *,
        retire_direction_id: str,
        retire_reason: str,
        version_suffix: str,
        cooldown_reason: str | None = None,
    ) -> tuple[dict[str, Any] | None, str | None, str | None, bool]:
        """Atomically retire one direction version and register its replacement.

        单事务完成两步：①旧版本条件取消（claimed 仅限租约已过期；
        open/released 直接取消）；②新版本注册（指纹去重与版本化链在同一
        事务内判定，并写入待投影事件交由既有 Projector 补写 intents.jsonl）。
        任一条件不满足即**整体回滚**——快照失效时调用方必须推迟处理，
        不得在事务外重试创建。``cooldown_reason`` 非空时新版本以
        released+冷却态注册（同一测试未到期的策略冷却不被重评分清除）。
        成功返回（实际注册载荷, 新方向 ID, 投影事件 ID, True）；
        快照失效返回 (None, None, None, False)。
        """
        now = _now()

        def fingerprint_of(payload: dict[str, Any]) -> str:
            identity = "\x1f".join(
                str(payload.get(key, "")).strip().casefold()
                for key in ("verb", "target", "hypothesis", "success_criteria", "chain_id", "sequence")
            )
            return hashlib.sha256(identity.encode("utf-8")).hexdigest()

        base_chain = str(intent.get("chain_id") or "")
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                row = db.execute(
                    "SELECT status FROM directions WHERE id=?", (retire_direction_id,),
                ).fetchone()
                retired = False
                if row is not None:
                    status = str(row["status"])
                    if status == "claimed":
                        retired = db.execute(
                            """
                            UPDATE directions SET status='cancelled',claimed_by=NULL,
                                lease_expires_at=NULL,terminal_reason=?,updated_at=?
                            WHERE id=? AND status='claimed'
                              AND lease_expires_at IS NOT NULL AND lease_expires_at<=?
                            """,
                            (retire_reason[:1000], now, retire_direction_id, now),
                        ).rowcount == 1
                    elif status in {"open", "released"}:
                        retired = db.execute(
                            """
                            UPDATE directions SET status='cancelled',claimed_by=NULL,
                                lease_expires_at=NULL,terminal_reason=?,updated_at=?
                            WHERE id=? AND status!='claimed'
                            """,
                            (retire_reason[:1000], now, retire_direction_id),
                        ).rowcount == 1
                if not retired:
                    db.execute("ROLLBACK")
                    return None, None, None, False

                base_payload = dict(intent)
                for chain in (base_chain, f"{base_chain}#{version_suffix}"):
                    candidate = dict(base_payload)
                    candidate["chain_id"] = chain
                    existing = db.execute(
                        "SELECT id,status FROM directions WHERE fingerprint=?",
                        (fingerprint_of(candidate),),
                    ).fetchone()
                    if existing is None:
                        direction_id = str(candidate.get("id") or f"I-{uuid4().hex[:12]}")
                        db.execute(
                            """
                            INSERT INTO directions(
                                id,fingerprint,intent_json,status,terminal_reason,
                                created_at,updated_at
                            ) VALUES (?,?,?,?,?,?,?)
                            """,
                            (
                                direction_id, fingerprint_of(candidate),
                                json.dumps(candidate, ensure_ascii=False),
                                "released" if cooldown_reason else "open",
                                cooldown_reason, now, now,
                            ),
                        )
                        event_id = self._insert_direction_intent_projection(
                            db, direction_id, candidate,
                        )
                        self._event(db, None, None, "direction_superseded", {
                            "direction_id": retire_direction_id,
                            "replacement_id": direction_id,
                            "reason": retire_reason[:1000],
                        })
                        self._event(db, None, None, "direction_registered", {
                            "direction_id": direction_id,
                        })
                        db.execute("COMMIT")
                        return candidate, direction_id, event_id, True
                    if str(existing["status"]) not in {
                        "cancelled", "completed", "rejected", "exhausted", "blocked",
                    }:
                        # 指纹命中仍可调度的方向：幂等场景，整体回滚推迟。
                        break
                    # 命中终态历史：换版本化链重试（下一轮循环）。
                db.execute("ROLLBACK")
                return None, None, None, False
            except Exception:
                db.execute("ROLLBACK")
                raise

    def restore_direction(self, direction_id: str, reason: str) -> dict[str, Any]:
        """Human-restore a previously human-dismissed direction by re-opening it.

        恢复对**所有类型**的方向生效：状态回到 open、清空认领与租约，
        立即重新参与调度（下一个 Worker 可认领）。原方向绑定的已取消
        Job 不复活，由新认领产生新任务。画像方向重新开放后，后续播种
        仍会按最新评估对齐（实质变化时替代）。模型侧重评不能触发本入口。
        """
        reason = reason.strip()
        if not reason:
            raise ValueError("人工恢复方向必须填写理由。")
        now = _now()
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            direction = db.execute(
                "SELECT status,terminal_reason FROM directions WHERE id=?",
                (direction_id,),
            ).fetchone()
            if direction is None:
                db.execute("ROLLBACK")
                raise RuntimeError(f"方向不存在: {direction_id}")
            if direction["status"] != "cancelled" or not str(
                direction["terminal_reason"] or ""
            ).startswith("human_dismissed:"):
                db.execute("ROLLBACK")
                raise RuntimeError(f"方向 {direction_id} 不处于人工否决状态，不能恢复")
            db.execute(
                """
                UPDATE directions SET status='open',claimed_by=NULL,
                    lease_expires_at=NULL,terminal_reason=?,updated_at=? WHERE id=?
                """,
                (f"human_restored:{reason[:1000]}", now, direction_id),
            )
            self._event(db, None, None, "direction_human_restored", {
                "direction_id": direction_id,
                "reason": reason[:1000],
            })
            db.execute("COMMIT")
        return self.get_direction(direction_id) or {}

    def cancel_expired_claimed_direction(self, direction_id: str, reason: str) -> bool:
        """Cancel a claimed direction only if its lease has already expired.

        条件更新在数据库层判定租约过期，与 claim_direction 的可重领条件
        使用同一时钟语义，避免降级清理与重新认领之间的竞态。
        """
        now = _now()
        with self.connect() as db:
            updated = db.execute(
                """
                UPDATE directions SET status='cancelled',claimed_by=NULL,
                    lease_expires_at=NULL,terminal_reason=?,updated_at=?
                WHERE id=? AND status='claimed'
                  AND lease_expires_at IS NOT NULL AND lease_expires_at<=?
                """,
                (reason[:1000], now, direction_id, now),
            )
            cancelled = updated.rowcount == 1
            if cancelled:
                self._event(db, None, None, "direction_expired_claim_cancelled", {
                    "direction_id": direction_id,
                    "reason": reason[:1000],
                })
            return cancelled

    def job_status(self, job_id: str) -> str | None:
        with self.connect() as db:
            row = db.execute("SELECT status FROM jobs WHERE id=?", (job_id,)).fetchone()
            return str(row["status"]) if row else None

    def set_direction_status(
        self,
        direction_id: str,
        status: str,
        reason: str | None = None,
    ) -> bool:
        if status not in {
            "open", "released", "completed", "rejected", "exhausted", "blocked", "cancelled",
        }:
            raise ValueError(f"非法 Intent 状态: {status}")
        with self.connect() as db:
            updated = db.execute(
                """
                UPDATE directions SET status=?,claimed_by=NULL,lease_expires_at=NULL,
                    terminal_reason=?,updated_at=? WHERE id=? AND status!='claimed'
                """,
                (status, reason, _now(), direction_id),
            )
            if updated.rowcount != 1:
                return False
            self._event(db, None, None, "direction_status_changed", {
                "direction_id": direction_id, "status": status, "reason": reason,
            })
            return True

    def claim_job(
        self,
        run_id: str,
        stage: str,
        worker_id: str,
        lease_seconds: int = 60,
        wave: int | None = None,
    ) -> dict[str, Any] | None:
        now = _now()
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                """
                SELECT jobs.* FROM jobs
                JOIN automation_runs ON automation_runs.id=jobs.run_id
                WHERE jobs.run_id=? AND jobs.stage=? AND jobs.attempts < jobs.max_attempts
                  AND automation_runs.status='running'
                  AND jobs.control_version=automation_runs.control_version
                  AND (? IS NULL OR jobs.wave=?)
                  AND (jobs.status='queued' OR (jobs.status='running' AND jobs.lease_expires_at < ?))
                ORDER BY jobs.created_at, jobs.id LIMIT 1
                """,
                (run_id, stage, wave, wave, now),
            ).fetchone()
            if row is None:
                db.execute("COMMIT")
                return None
            db.execute(
                """
                UPDATE jobs SET status='running', attempts=attempts+1, worker_id=?,
                    lease_expires_at=?, last_heartbeat_at=?, updated_at=?, error=NULL
                WHERE id=?
                """,
                (worker_id, _lease_deadline(lease_seconds), now, now, row["id"]),
            )
            self._event(db, run_id, row["id"], "job_claimed", {"worker_id": worker_id})
            db.execute("COMMIT")
            claimed = dict(row)
            claimed.update({"status": "running", "worker_id": worker_id, "attempts": int(row["attempts"]) + 1})
            claimed["payload"] = json.loads(claimed.pop("payload_json"))
            return claimed

    def heartbeat(
        self,
        job_id: str,
        worker_id: str,
        lease_seconds: int = 60,
        control_version: int | None = None,
    ) -> bool:
        now = _now()
        with self.connect() as db:
            if control_version is None:
                row = db.execute("SELECT control_version FROM jobs WHERE id=?", (job_id,)).fetchone()
                control_version = int(row["control_version"]) if row else -1
            result = db.execute(
                """
                UPDATE jobs SET lease_expires_at=?, last_heartbeat_at=?, updated_at=?
                WHERE id=? AND worker_id=? AND status='running' AND control_version=?
                  AND EXISTS (
                    SELECT 1 FROM automation_runs
                    WHERE automation_runs.id=jobs.run_id
                      AND automation_runs.status='running'
                      AND automation_runs.control_version=jobs.control_version
                  )
                """,
                (_lease_deadline(lease_seconds), now, now, job_id, worker_id, control_version),
            )
            return result.rowcount == 1

    def complete_job(
        self,
        job_id: str,
        worker_id: str,
        result: dict[str, Any],
        control_version: int | None = None,
    ) -> None:
        now = _now()
        with self.connect() as db:
            row = db.execute(
                "SELECT run_id,control_version FROM jobs WHERE id=?", (job_id,)
            ).fetchone()
            if row is None:
                raise RuntimeError(f"任务不存在: {job_id}")
            expected_version = int(row["control_version"]) if control_version is None else control_version
            updated = db.execute(
                """
                UPDATE jobs SET status='completed', result_json=?, lease_expires_at=NULL,
                    updated_at=? WHERE id=? AND worker_id=? AND status='running'
                    AND control_version=?
                    AND EXISTS (
                      SELECT 1 FROM automation_runs
                      WHERE automation_runs.id=jobs.run_id
                        AND automation_runs.status='running'
                        AND automation_runs.control_version=jobs.control_version
                    )
                """,
                (json.dumps(result, ensure_ascii=False), now, job_id, worker_id, expected_version),
            )
            if updated.rowcount != 1:
                self._event(db, row["run_id"], job_id, "stale_write_rejected", {
                    "worker_id": worker_id, "control_version": expected_version,
                })
                raise RuntimeError(f"任务控制版本或租约已失效: {job_id}")
            self._event(db, row["run_id"], job_id, "job_completed", {})

    def fail_job(
        self,
        job_id: str,
        worker_id: str,
        error: str,
        *,
        retryable: bool = True,
        control_version: int | None = None,
    ) -> str:
        now = _now()
        with self.connect() as db:
            row = db.execute(
                """
                SELECT jobs.run_id,jobs.status AS job_status,jobs.attempts,jobs.max_attempts,jobs.control_version,
                    automation_runs.status AS run_status,
                    automation_runs.control_version AS run_control_version
                FROM jobs JOIN automation_runs ON automation_runs.id=jobs.run_id WHERE jobs.id=?
                """,
                (job_id,),
            ).fetchone()
            if row is None:
                raise RuntimeError(f"任务不存在: {job_id}")
            expected_version = int(row["control_version"]) if control_version is None else control_version
            stale = (
                row["job_status"] != "running"
                or
                row["run_status"] != "running"
                or int(row["run_control_version"]) != expected_version
                or int(row["control_version"]) != expected_version
            )
            next_status = (
                "cancelled"
                if stale
                else "failed"
                if not retryable or int(row["attempts"]) >= int(row["max_attempts"])
                else "queued"
            )
            updated = db.execute(
                """
                UPDATE jobs SET status=?, error=?, worker_id=NULL, lease_expires_at=NULL,
                    updated_at=? WHERE id=? AND worker_id=? AND status IN ('running','cancelling')
                """,
                (next_status, error, now, job_id, worker_id),
            )
            if updated.rowcount != 1:
                self._event(db, row["run_id"], job_id, "stale_write_rejected", {
                    "worker_id": worker_id,
                    "control_version": expected_version,
                    "operation": "fail_job",
                })
                raise RuntimeError(f"任务控制版本或租约已失效: {job_id}")
            self._event(db, row["run_id"], job_id, "job_failed", {"status": next_status, "error": error})
            if stale:
                self._event(db, row["run_id"], job_id, "stale_write_rejected", {
                    "worker_id": worker_id, "control_version": expected_version,
                })
            return next_status

    def restrict_job(
        self,
        job_id: str,
        worker_id: str,
        reason: str,
        *,
        control_version: int | None = None,
    ) -> str:
        """Finish a claimed job that the upstream model refused by policy.

        This is a terminal provider limitation, not a runtime failure and not a
        candidate result. Keeping it distinct prevents identical retries and
        keeps run health/error metrics honest.
        """
        now = _now()
        with self.connect() as db:
            row = db.execute(
                """
                SELECT jobs.run_id,jobs.status AS job_status,jobs.control_version,
                    automation_runs.status AS run_status,
                    automation_runs.control_version AS run_control_version
                FROM jobs JOIN automation_runs ON automation_runs.id=jobs.run_id WHERE jobs.id=?
                """,
                (job_id,),
            ).fetchone()
            if row is None:
                raise RuntimeError(f"任务不存在: {job_id}")
            expected_version = int(row["control_version"]) if control_version is None else control_version
            stale = (
                row["job_status"] != "running"
                or row["run_status"] != "running"
                or int(row["run_control_version"]) != expected_version
                or int(row["control_version"]) != expected_version
            )
            next_status = "cancelled" if stale else "restricted"
            updated = db.execute(
                """
                UPDATE jobs SET status=?, error=?, worker_id=NULL, lease_expires_at=NULL,
                    updated_at=? WHERE id=? AND worker_id=? AND status IN ('running','cancelling')
                """,
                (next_status, reason, now, job_id, worker_id),
            )
            if updated.rowcount != 1:
                raise RuntimeError(f"任务控制版本或租约已失效: {job_id}")
            self._event(db, row["run_id"], job_id, "job_policy_restricted", {
                "status": next_status,
                "reason": reason,
            })
            if stale:
                self._event(db, row["run_id"], job_id, "stale_write_rejected", {
                    "worker_id": worker_id, "control_version": expected_version,
                })
            return next_status

    def add_event(
        self,
        run_id: str | None,
        job_id: str | None,
        event_type: str,
        data: dict[str, Any],
    ) -> None:
        with self.connect() as db:
            self._event(db, run_id, job_id, event_type, data)

    def list_jobs(
        self,
        run_id: str,
        stage: str | None = None,
        wave: int | None = None,
    ) -> list[dict[str, Any]]:
        query = "SELECT * FROM jobs WHERE run_id=?"
        params: list[Any] = [run_id]
        if stage:
            query += " AND stage=?"
            params.append(stage)
        if wave is not None:
            query += " AND wave=?"
            params.append(wave)
        query += " ORDER BY created_at,id"
        with self.connect() as db:
            rows = [dict(row) for row in db.execute(query, params).fetchall()]
        for row in rows:
            row["payload"] = json.loads(row.pop("payload_json"))
            row["result"] = json.loads(row["result_json"]) if row.get("result_json") else None
        return rows

    def set_run_stage(self, run_id: str, stage: str) -> None:
        with self.connect() as db:
            updated = db.execute(
                "UPDATE automation_runs SET stage=?,updated_at=? WHERE id=? AND status IN ('running','paused')",
                (stage, _now(), run_id),
            )
            if updated.rowcount != 1:
                return
            self._event(db, run_id, None, "run_stage_changed", {"stage": stage})

    def advance_run_wave(self, run_id: str) -> int:
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                "SELECT status,wave,max_waves FROM automation_runs WHERE id=?", (run_id,)
            ).fetchone()
            if row is None or row["status"] != "running":
                db.execute("ROLLBACK")
                raise RuntimeError(f"运行 {run_id} 不能进入下一波")
            next_wave = int(row["wave"]) + 1
            if next_wave > int(row["max_waves"]):
                db.execute("ROLLBACK")
                raise RuntimeError(f"运行 {run_id} 已达最大波次")
            db.execute(
                "UPDATE automation_runs SET wave=?,stage='swarm',updated_at=? WHERE id=?",
                (next_wave, _now(), run_id),
            )
            self._event(db, run_id, None, "run_wave_advanced", {"wave": next_wave})
            db.execute("COMMIT")
            return next_wave

    def open_direction_count(self) -> int:
        with self.connect() as db:
            row = db.execute(
                """
                SELECT COUNT(*) AS count FROM directions
                WHERE status='open'
                    OR (
                        status='released' AND (
                            terminal_reason IS NULL
                            OR terminal_reason NOT LIKE 'policy_blocked_until:%'
                            OR substr(terminal_reason, length('policy_blocked_until:') + 1) <= ?
                        )
                    )
                """,
                (_now(),),
            ).fetchone()
            return int(row["count"])

    def set_run_status(self, run_id: str, status: str, error: str | None = None) -> bool:
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            current = db.execute(
                "SELECT status FROM automation_runs WHERE id=?", (run_id,)
            ).fetchone()
            if current is None:
                db.execute("ROLLBACK")
                raise RuntimeError(f"运行不存在: {run_id}")
            current_status = str(current["status"])
            if current_status in {"stopped", "cancelled", "completed", "failed"}:
                if status != current_status:
                    db.execute("ROLLBACK")
                    raise RuntimeError(f"终结运行 {run_id} 不能从 {current_status} 变为 {status}")
                db.execute("COMMIT")
                return False
            updated = db.execute(
                """
                UPDATE automation_runs SET status=?,error=?,updated_at=?
                WHERE id=? AND status=?
                """,
                (status, error, _now(), run_id, current_status),
            )
            if updated.rowcount != 1:
                db.execute("ROLLBACK")
                return False
            self._event(db, run_id, None, "run_status_changed", {"status": status, "error": error})
            db.execute("COMMIT")
            return True

    def renew_run_execution_deadline(self, run_id: str, lease_seconds: int) -> str:
        deadline = _lease_deadline(max(60, int(lease_seconds)))
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            updated = db.execute(
                """
                UPDATE automation_runs SET execution_deadline=?,updated_at=?
                WHERE id=? AND status='paused'
                """,
                (deadline, _now(), run_id),
            )
            if updated.rowcount != 1:
                db.execute("ROLLBACK")
                raise RuntimeError(f"运行 {run_id} 不能续签执行预算")
            self._event(db, run_id, None, "run_execution_budget_renewed", {
                "execution_deadline": deadline,
                "lease_seconds": max(60, int(lease_seconds)),
            })
            db.execute("COMMIT")
        return deadline

    def update_run_counters(
        self,
        run_id: str,
        *,
        completed_delta: int = 0,
        low_value: bool | None = None,
        no_direction: bool | None = None,
    ) -> None:
        with self.connect() as db:
            row = db.execute(
                "SELECT completed_task_count,low_value_streak,no_direction_streak FROM automation_runs WHERE id=?",
                (run_id,),
            ).fetchone()
            if row is None:
                raise RuntimeError(f"运行不存在: {run_id}")
            low_streak = int(row["low_value_streak"])
            no_streak = int(row["no_direction_streak"])
            if low_value is not None:
                low_streak = low_streak + 1 if low_value else 0
            if no_direction is not None:
                no_streak = no_streak + 1 if no_direction else 0
            db.execute(
                """
                UPDATE automation_runs SET completed_task_count=completed_task_count+?,
                    low_value_streak=?,no_direction_streak=?,updated_at=? WHERE id=?
                """,
                (completed_delta, low_streak, no_streak, _now(), run_id),
            )

    def accept_commit_plan(
        self,
        *,
        event: dict[str, Any],
        plan: dict[str, Any],
        job_id: str | None = None,
        control_version: int | None = None,
    ) -> dict[str, Any]:
        now = _now()
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                existing = db.execute(
                    "SELECT * FROM commit_events WHERE idempotency_key=?",
                    (event["idempotency_key"],),
                ).fetchone()
                if existing is not None:
                    if str(existing["payload_sha256"]) != str(event["payload_sha256"]):
                        raise RuntimeError("相同幂等键对应不同提交载荷")
                    db.execute("COMMIT")
                    return dict(existing)
                run_id = event.get("run_id")
                if job_id:
                    job = db.execute(
                        """
                        SELECT j.*,r.status AS run_status,r.control_version AS run_control_version
                        FROM jobs j JOIN automation_runs r ON r.id=j.run_id WHERE j.id=?
                        """,
                        (job_id,),
                    ).fetchone()
                    if job is None or job["status"] != "completed":
                        raise RuntimeError(f"Job {job_id} 不接受候选提交")
                    if control_version is None or (
                        int(job["control_version"]) != int(control_version)
                        or int(job["run_control_version"]) != int(control_version)
                    ):
                        raise RuntimeError(f"Job {job_id} 控制版本已失效")
                    if job["run_status"] not in {"running", "paused"}:
                        raise RuntimeError(f"运行 {job['run_id']} 不接受候选提交")
                    if job["commit_state"] in {"enqueued", "projected"}:
                        existing = db.execute(
                            "SELECT * FROM commit_events WHERE event_id=?",
                            (job["commit_event_id"],),
                        ).fetchone()
                        db.execute("COMMIT")
                        return dict(existing) if existing else {}
                    run_id = str(job["run_id"])
                db.execute(
                    """
                    INSERT INTO commit_events(
                        event_id,idempotency_key,event_type,aggregate_type,aggregate_id,
                        source_type,source_id,run_id,job_id,control_version,payload_json,
                        payload_sha256,status,attempts,available_at,occurred_at,enqueued_at
                    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'pending',0,?,?,?)
                    """,
                    (
                        event["event_id"], event["idempotency_key"], event["event_type"],
                        event["aggregate_type"], event["aggregate_id"], event["source_type"],
                        event["source_id"], run_id, job_id, control_version,
                        event["payload_json"], event["payload_sha256"], now,
                        event["occurred_at"], now,
                    ),
                )
                db.execute(
                    """
                    INSERT INTO commit_plans(
                        plan_id,event_id,plan_version,plan_json,plan_sha256,
                        action_count,created_at
                    ) VALUES (?,?,?,?,?,?,?)
                    """,
                    (
                        plan["plan_id"], event["event_id"], plan["plan_version"],
                        plan["plan_json"], plan["plan_sha256"], plan["action_count"], now,
                    ),
                )
                if job_id:
                    updated = db.execute(
                        """
                        UPDATE jobs SET commit_state='enqueued',commit_event_id=?,
                            commit_enqueued_at=?,commit_error=NULL,updated_at=?
                        WHERE id=? AND status='completed' AND commit_state='none'
                        """,
                        (event["event_id"], now, now, job_id),
                    )
                    if updated.rowcount != 1:
                        raise RuntimeError(f"Job {job_id} 提交状态发生并发变化")
                    self._event(db, run_id, job_id, "job_commit_enqueued", {
                        "event_id": event["event_id"],
                        "idempotency_key": event["idempotency_key"],
                    })
                db.execute("COMMIT")
                return dict(db.execute(
                    "SELECT * FROM commit_events WHERE event_id=?", (event["event_id"],)
                ).fetchone())
            except Exception:
                db.execute("ROLLBACK")
                raise

    def recover_commit_leases(self) -> int:
        now = _now()
        with self.connect() as db:
            updated = db.execute(
                """
                UPDATE commit_events SET status='pending',lease_owner=NULL,
                    lease_expires_at=NULL,last_error=coalesce(last_error,'投影租约过期')
                WHERE status='projecting' AND lease_expires_at IS NOT NULL
                  AND lease_expires_at<=?
                """,
                (now,),
            )
            return int(updated.rowcount)

    def claim_next_commit(self, worker_id: str, lease_seconds: int = 30) -> dict[str, Any] | None:
        now = _now()
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                """
                SELECT e.*,p.plan_id,p.plan_version,p.plan_json,p.plan_sha256,p.action_count
                FROM commit_events e JOIN commit_plans p ON p.event_id=e.event_id
                WHERE (
                    e.status='pending'
                    OR (e.status='retry_wait' AND e.available_at<=?)
                    OR (
                      e.status='projecting'
                      AND (e.lease_expires_at IS NULL OR e.lease_expires_at<=?)
                    )
                )
                AND NOT EXISTS (
                    SELECT 1 FROM commit_events earlier
                    WHERE earlier.aggregate_type=e.aggregate_type
                      AND earlier.aggregate_id=e.aggregate_id
                      AND earlier.sequence<e.sequence
                      AND earlier.status IN ('pending','projecting','retry_wait')
                )
                ORDER BY e.sequence LIMIT 1
                """,
                (now, now),
            ).fetchone()
            if row is None:
                db.execute("COMMIT")
                return None
            deadline = _lease_deadline(lease_seconds)
            updated = db.execute(
                """
                UPDATE commit_events SET status='projecting',attempts=attempts+1,
                    lease_owner=?,lease_expires_at=?,last_error=NULL
                WHERE event_id=? AND status IN ('pending','retry_wait','projecting')
                """,
                (worker_id, deadline, row["event_id"]),
            )
            if updated.rowcount != 1:
                db.execute("ROLLBACK")
                return None
            db.execute("COMMIT")
            result = dict(row)
            result["lease_owner"] = worker_id
            result["lease_expires_at"] = deadline
            return result

    def commit_projection_rejection_reason(self, event_id: str, worker_id: str) -> str | None:
        """Return why a claimed event is no longer authorized to mutate project state."""

        with self.connect() as db:
            row = db.execute(
                """
                SELECT e.status,e.lease_owner,e.run_id,e.control_version,
                    r.status AS run_status,r.control_version AS run_control_version
                FROM commit_events e
                LEFT JOIN automation_runs r ON r.id=e.run_id
                WHERE e.event_id=?
                """,
                (event_id,),
            ).fetchone()
        if row is None:
            return "提交事件不存在"
        if row["status"] != "projecting" or row["lease_owner"] != worker_id:
            return "投影租约已失效"
        if not row["run_id"]:
            return None
        if row["run_status"] not in {"running", "paused"}:
            return f"运行状态已变更为 {row['run_status'] or 'missing'}"
        if (
            row["control_version"] is None
            or int(row["control_version"]) != int(row["run_control_version"])
        ):
            return "运行控制版本已失效"
        return None

    def discard_claimed_commit_event(self, event_id: str, worker_id: str, reason: str) -> None:
        now = _now()
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                "SELECT job_id FROM commit_events WHERE event_id=? AND status='projecting' AND lease_owner=?",
                (event_id, worker_id),
            ).fetchone()
            if row is None:
                db.execute("ROLLBACK")
                raise RuntimeError(f"提交事件 {event_id} 投影租约已失效")
            db.execute(
                """
                UPDATE commit_events SET status='discarded',last_error=?,
                    lease_owner=NULL,lease_expires_at=NULL WHERE event_id=?
                """,
                (reason[:4000], event_id),
            )
            if row["job_id"]:
                db.execute(
                    """
                    UPDATE jobs SET commit_state='rejected',commit_error=?,
                        committed_at=?,updated_at=? WHERE id=? AND commit_event_id=?
                    """,
                    (reason[:4000], now, now, row["job_id"], event_id),
                )
            db.execute("COMMIT")

    def projection_receipt_exists(self, event_id: str, action_key: str) -> bool:
        with self.connect() as db:
            return db.execute(
                "SELECT 1 FROM projection_receipts WHERE event_id=? AND action_key=?",
                (event_id, action_key),
            ).fetchone() is not None

    def record_projection_receipt(
        self,
        *,
        event_id: str,
        action_key: str,
        idempotency_key: str,
        sink_type: str,
        sink_path: str,
        content_sha256: str,
        byte_count: int,
    ) -> None:
        with self.connect() as db:
            db.execute(
                """
                INSERT INTO projection_receipts(
                    event_id,action_key,idempotency_key,sink_type,sink_path,
                    content_sha256,byte_count,completed_at
                ) VALUES (?,?,?,?,?,?,?,?)
                ON CONFLICT(event_id,action_key) DO NOTHING
                """,
                (
                    event_id, action_key, idempotency_key, sink_type, sink_path,
                    content_sha256, max(0, int(byte_count)), _now(),
                ),
            )

    def complete_commit_event(self, event_id: str, worker_id: str) -> None:
        now = _now()
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            event = db.execute(
                "SELECT sequence,job_id,status,lease_owner FROM commit_events WHERE event_id=?",
                (event_id,),
            ).fetchone()
            if event is None:
                db.execute("ROLLBACK")
                raise RuntimeError(f"提交事件不存在: {event_id}")
            if event["status"] == "committed":
                db.execute("COMMIT")
                return
            if event["status"] != "projecting" or event["lease_owner"] != worker_id:
                db.execute("ROLLBACK")
                raise RuntimeError(f"提交事件 {event_id} 投影租约已失效")
            db.execute(
                """
                UPDATE commit_events SET status='committed',projected_at=?,lease_owner=NULL,
                    lease_expires_at=NULL,last_error=NULL WHERE event_id=?
                """,
                (now, event_id),
            )
            if event["job_id"]:
                db.execute(
                    """
                    UPDATE jobs SET commit_state='projected',commit_projected_at=?,
                        commit_error=NULL,updated_at=?
                    WHERE id=? AND commit_event_id=?
                    """,
                    (now, now, event["job_id"], event_id),
                )
            db.execute(
                """
                UPDATE projector_meta SET last_projected_sequence=max(last_projected_sequence,?),
                    last_success_at=?,last_error=NULL,updated_at=? WHERE id=1
                """,
                (int(event["sequence"]), now, now),
            )
            db.execute("COMMIT")

    def fail_commit_event(
        self,
        event_id: str,
        worker_id: str,
        error: str,
        *,
        max_attempts: int = 5,
    ) -> str:
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                "SELECT attempts,lease_owner FROM commit_events WHERE event_id=? AND status='projecting'",
                (event_id,),
            ).fetchone()
            if row is None or row["lease_owner"] != worker_id:
                db.execute("ROLLBACK")
                raise RuntimeError(f"提交事件 {event_id} 投影租约已失效")
            status = "blocked" if int(row["attempts"]) >= max_attempts else "retry_wait"
            available_at = _lease_deadline(min(300, 2 ** min(int(row["attempts"]), 8)))
            db.execute(
                """
                UPDATE commit_events SET status=?,available_at=?,lease_owner=NULL,
                    lease_expires_at=NULL,last_error=? WHERE event_id=?
                """,
                (status, available_at, str(error)[:4000], event_id),
            )
            db.execute(
                "UPDATE projector_meta SET last_error=?,fatal_error=?,updated_at=? WHERE id=1",
                (str(error)[:4000], str(error)[:4000] if status == "blocked" else None, _now()),
            )
            db.execute("COMMIT")
            return status

    def commit_event_counts(self) -> dict[str, int]:
        with self.connect() as db:
            return {
                str(row["status"]): int(row["count"])
                for row in db.execute(
                    "SELECT status,count(*) AS count FROM commit_events GROUP BY status"
                ).fetchall()
            }

    def mark_projection_recovery_complete(self) -> None:
        now = _now()
        with self.connect() as db:
            db.execute(
                """
                UPDATE projector_meta
                SET recovery_completed_at=?,last_success_at=?,
                    last_error=NULL,updated_at=?
                WHERE id=1
                """,
                (now, now, now),
            )

    def mark_job_committed(self, job_id: str, error: str | None = None) -> None:
        with self.connect() as db:
            db.execute(
                """
                UPDATE jobs SET committed_at=?,commit_error=?,
                    commit_state=CASE WHEN ? IS NULL THEN 'projected' ELSE commit_state END,
                    updated_at=? WHERE id=?
                """,
                (_now() if error is None else None, error, error, _now(), job_id),
            )
            row = db.execute("SELECT run_id FROM jobs WHERE id=?", (job_id,)).fetchone()
            self._event(
                db,
                row["run_id"] if row else None,
                job_id,
                "job_committed" if error is None else "job_commit_deferred",
                {"error": error},
            )

    def reject_job_candidate(self, job_id: str, error: str) -> None:
        """Permanently consume a malformed candidate instead of pausing forever."""
        now = _now()
        with self.connect() as db:
            event = db.execute(
                "SELECT commit_event_id FROM jobs WHERE id=?",
                (job_id,),
            ).fetchone()
            db.execute(
                "UPDATE jobs SET committed_at=?,commit_error=?,commit_state='rejected',updated_at=? WHERE id=?",
                (now, error, now, job_id),
            )
            if event and event["commit_event_id"]:
                db.execute(
                    """
                    UPDATE commit_events SET status='discarded',last_error=?,
                        lease_owner=NULL,lease_expires_at=NULL
                    WHERE event_id=? AND status!='committed'
                    """,
                    (error[:4000], event["commit_event_id"]),
                )
            row = db.execute("SELECT run_id FROM jobs WHERE id=?", (job_id,)).fetchone()
            self._event(
                db,
                row["run_id"] if row else None,
                job_id,
                "job_commit_rejected",
                {"error": error},
            )

    def finish_run(self, run_id: str, status: str, error: str | None = None) -> None:
        with self.connect() as db:
            updated = db.execute(
                """
                UPDATE automation_runs SET status=?,stage='finished',error=?,updated_at=?
                WHERE id=? AND status IN ('running','paused')
                """,
                (status, error, _now(), run_id),
            )
            if updated.rowcount != 1:
                return
            self._event(db, run_id, None, "run_finished", {"status": status, "error": error})

    def cancel_run(self, run_id: str, reason: str) -> None:
        self.stop_run(run_id, reason)

    def stop_run(self, run_id: str, reason: str) -> None:
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            run = db.execute(
                "SELECT status,control_version FROM automation_runs WHERE id=?", (run_id,)
            ).fetchone()
            if run is None:
                db.execute("ROLLBACK")
                raise RuntimeError(f"运行不存在: {run_id}")
            if run["status"] in {"stopped", "cancelled", "completed", "failed"}:
                db.execute("COMMIT")
                return
            next_version = int(run["control_version"]) + 1
            now = _now()
            db.execute(
                """
                UPDATE automation_runs SET status='stopping',control_version=?,error=?,updated_at=?
                WHERE id=?
                """,
                (next_version, reason, now, run_id),
            )
            db.execute(
                """
                UPDATE jobs SET status='cancelled',error=?,worker_id=NULL,
                    lease_expires_at=NULL,updated_at=?
                WHERE run_id=? AND status='queued'
                """,
                (reason, now, run_id),
            )
            db.execute(
                """
                UPDATE jobs SET status='cancelling',error=?,updated_at=?
                WHERE run_id=? AND status='running'
                """,
                (reason, now, run_id),
            )
            db.execute(
                """
                UPDATE commit_events SET status='discarded',last_error=?,
                    lease_owner=NULL,lease_expires_at=NULL
                WHERE run_id=? AND status IN ('pending','retry_wait')
                """,
                (f"run_stopped:{reason}"[:4000], run_id),
            )
            db.execute(
                """
                UPDATE jobs SET commit_state='rejected',commit_error=?,
                    committed_at=?,updated_at=?
                WHERE run_id=? AND commit_state='enqueued'
                  AND commit_event_id IN (
                    SELECT event_id FROM commit_events
                    WHERE run_id=? AND status='discarded'
                  )
                """,
                (f"run_stopped:{reason}"[:4000], now, now, run_id, run_id),
            )
            db.execute(
                """
                UPDATE directions SET status='cancelled',claimed_by=NULL,lease_expires_at=NULL,
                    terminal_reason=?,updated_at=?
                WHERE status='claimed' AND claimed_by LIKE ?
                """,
                (reason, now, f"{run_id}:%"),
            )
            self._event(db, run_id, None, "run_stopping", {
                "reason": reason, "control_version": next_version,
            })
            db.execute(
                "UPDATE automation_runs SET status='stopped',stage='finished',updated_at=? WHERE id=?",
                (_now(), run_id),
            )
            self._event(db, run_id, None, "run_stopped", {
                "reason": reason, "control_version": next_version,
            })
            db.execute("COMMIT")

    def get_run(self, run_id: str) -> dict[str, Any] | None:
        with self.connect() as db:
            row = db.execute("SELECT * FROM automation_runs WHERE id=?", (run_id,)).fetchone()
            return dict(row) if row else None

    def latest_resumable_run(self) -> dict[str, Any] | None:
        with self.connect() as db:
            row = db.execute(
                "SELECT * FROM automation_runs WHERE status IN ('running','paused') ORDER BY created_at DESC LIMIT 1"
            ).fetchone()
            return dict(row) if row else None

    def latest_run(self) -> dict[str, Any] | None:
        with self.connect() as db:
            row = db.execute("SELECT * FROM automation_runs ORDER BY created_at DESC LIMIT 1").fetchone()
            return dict(row) if row else None

    def list_runs(self) -> list[dict[str, Any]]:
        with self.connect() as db:
            return [dict(row) for row in db.execute("SELECT * FROM automation_runs ORDER BY created_at").fetchall()]

    def list_all_jobs(self) -> list[dict[str, Any]]:
        with self.connect() as db:
            rows = [dict(row) for row in db.execute("SELECT * FROM jobs ORDER BY created_at,id").fetchall()]
        for row in rows:
            row["payload"] = json.loads(row.pop("payload_json"))
            row["result"] = json.loads(row["result_json"]) if row.get("result_json") else None
        return rows

    def event_count(self, event_type: str) -> int:
        with self.connect() as db:
            row = db.execute("SELECT COUNT(*) AS count FROM events WHERE event_type=?", (event_type,)).fetchone()
            return int(row["count"])

    def events(self, run_id: str) -> list[dict[str, Any]]:
        with self.connect() as db:
            rows = db.execute("SELECT * FROM events WHERE run_id=? ORDER BY id", (run_id,)).fetchall()
        events = [dict(row) for row in rows]
        for event in events:
            event["data"] = json.loads(event.pop("data_json"))
        return events

    @staticmethod
    def _event(
        db: sqlite3.Connection,
        run_id: str | None,
        job_id: str | None,
        event_type: str,
        data: dict[str, Any],
    ) -> None:
        db.execute(
            "INSERT INTO events(run_id,job_id,event_type,data_json,created_at) VALUES (?,?,?,?,?)",
            (run_id, job_id, event_type, json.dumps(data, ensure_ascii=False), _now()),
        )
