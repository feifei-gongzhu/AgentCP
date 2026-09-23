from __future__ import annotations

import csv
import hashlib
import io
import ipaddress
import json
import re
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from uuid import uuid4
from xml.etree import ElementTree

from .database import ControlDatabase
from .schemas import now_iso
from .store import ProjectStore


MAX_PROFILE_ATTEMPTS = 3


MAX_ASSET_IMPORT_BYTES = 64 * 1024 * 1024
MAX_ASSET_XLSX_EXPANDED_BYTES = 256 * 1024 * 1024
MAX_ASSET_XLSX_ENTRIES = 10_000
MAX_ASSET_IMPORT_ROWS = 200_000
MAX_CANDIDATES_PER_ROW = 64
_URL_RE = re.compile(r"https?://[^\s<>\"'，。；、]+", re.IGNORECASE)
_HOST_RE = re.compile(
    r"(?<![@\w-])(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+"
    r"[A-Za-z]{2,63}(?::\d{1,5})?(?:/[^\s<>\"'，。；、]*)?"
)
_IP_RE = re.compile(
    r"(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?(?:/[^\s<>\"'，。；、]*)?"
)
_SENSITIVE_QUERY_MARKERS = {
    "access_token", "auth", "code", "credential", "key", "password",
    "secret", "session", "signature", "token",
}
_OFFICIAL_SOURCE_TYPES = {"official", "target", "manual"}


class AssetImportError(ValueError):
    pass


@dataclass(frozen=True)
class NormalizedCandidate:
    raw_target: str
    candidate_kind: str
    endpoint_key: str
    canonical_url: str | None
    hostname: str | None
    ip_address: str | None
    scheme: str | None
    port: int | None


@dataclass(frozen=True)
class ProfileAssignment:
    task_id: str
    asset_id: str
    endpoint_key: str
    seed_url: str
    hostname: str | None
    ip_address: str | None
    scheme: str | None
    port: int | None

    def as_payload(self) -> dict[str, Any]:
        return {
            "task_id": self.task_id,
            "asset_id": self.asset_id,
            "endpoint_key": self.endpoint_key,
            "seed_url": self.seed_url,
            "hostname": self.hostname,
            "ip_address": self.ip_address,
            "scheme": self.scheme,
            "port": self.port,
        }


def _id(prefix: str) -> str:
    return f"{prefix}-{uuid4().hex[:12]}"


def _default_port(scheme: str) -> int:
    return 443 if scheme == "https" else 80


def _safe_url(raw: str) -> tuple[str, str, int, str]:
    parsed = urlsplit(raw)
    scheme = parsed.scheme.casefold()
    if scheme not in {"http", "https"} or not parsed.hostname:
        raise AssetImportError("只支持 HTTP(S) URL")
    host = parsed.hostname.casefold().rstrip(".")
    try:
        port = parsed.port or _default_port(scheme)
    except ValueError as exc:
        raise AssetImportError("URL 端口非法") from exc
    if not 1 <= port <= 65535:
        raise AssetImportError("URL 端口非法")
    display_host = f"[{host}]" if ":" in host and not host.startswith("[") else host
    authority = display_host if port == _default_port(scheme) else f"{display_host}:{port}"
    query = [
        (
            key,
            "[REDACTED]" if any(marker in key.casefold() for marker in _SENSITIVE_QUERY_MARKERS) else value,
        )
        for key, value in parse_qsl(parsed.query, keep_blank_values=True)
    ]
    canonical = urlunsplit((
        scheme,
        authority,
        parsed.path or "/",
        urlencode(sorted(query)),
        "",
    ))
    return canonical, host, port, scheme


def normalize_asset_candidate(value: object) -> NormalizedCandidate | None:
    raw = str(value or "").strip().strip("()[]{}<>,，。；;\"'")
    if not raw or len(raw) > 4096:
        return None
    if raw.casefold().startswith(("http://", "https://")):
        try:
            canonical, host, port, scheme = _safe_url(raw)
        except AssetImportError:
            return None
        try:
            ip = str(ipaddress.ip_address(host))
        except ValueError:
            ip = None
        return NormalizedCandidate(
            raw_target=raw,
            candidate_kind="url",
            endpoint_key=f"web:{scheme}://{host}:{port}",
            canonical_url=canonical,
            hostname=None if ip else host,
            ip_address=ip,
            scheme=scheme,
            port=port,
        )

    candidate = raw.split("/", 1)[0]
    host_part = candidate
    port: int | None = None
    if candidate.count(":") == 1:
        host_part, port_text = candidate.rsplit(":", 1)
        if not port_text.isdigit():
            return None
        port = int(port_text)
        if not 1 <= port <= 65535:
            return None
    host = host_part.casefold().rstrip(".")
    try:
        ip = str(ipaddress.ip_address(host))
    except ValueError:
        ip = None
    if ip:
        return NormalizedCandidate(
            raw_target=raw,
            candidate_kind="ip",
            endpoint_key=f"ip:{ip}:{port or 0}",
            canonical_url=None,
            hostname=None,
            ip_address=ip,
            scheme=None,
            port=port,
        )
    if not _HOST_RE.fullmatch(raw) and not _HOST_RE.fullmatch(candidate):
        return None
    canonical_url = f"https://{host}{f':{port}' if port else ''}/"
    effective_port = port or 443
    return NormalizedCandidate(
        raw_target=raw,
        candidate_kind="hostname",
        endpoint_key=f"web:https://{host}:{effective_port}",
        canonical_url=canonical_url,
        hostname=host,
        ip_address=None,
        scheme="https",
        port=effective_port,
    )


def _safe_candidate_value(candidate: NormalizedCandidate) -> str:
    return candidate.canonical_url or candidate.endpoint_key


def _minimal_source_row(candidates: list[NormalizedCandidate]) -> str:
    return json.dumps(
        {
            "redacted": True,
            "asset_values": sorted(dict.fromkeys(
                _safe_candidate_value(candidate) for candidate in candidates
            )),
        },
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )


def extract_asset_candidates(row: object) -> list[NormalizedCandidate]:
    scalars: list[str] = []

    def collect(value: object) -> None:
        if isinstance(value, dict):
            for child in value.values():
                collect(child)
        elif isinstance(value, (list, tuple)):
            for child in value:
                collect(child)
        elif value is not None:
            scalars.append(str(value))

    collect(row)
    found: list[NormalizedCandidate] = []
    # Enterprise inventory identity is an endpoint, not an individual path.
    # A URL such as https://example.com/login also matches the hostname regex;
    # deduplicating by canonical URL would therefore create two provenance rows
    # for one observation.
    seen: set[str] = set()
    for text in scalars:
        fragments = [text.strip()]
        fragments.extend(_URL_RE.findall(text))
        fragments.extend(_HOST_RE.findall(text))
        fragments.extend(_IP_RE.findall(text))
        for fragment in fragments:
            candidate = normalize_asset_candidate(fragment)
            if candidate is None:
                continue
            if candidate.endpoint_key in seen:
                continue
            seen.add(candidate.endpoint_key)
            found.append(candidate)
            if len(found) >= MAX_CANDIDATES_PER_ROW:
                return found
    return found


def _csv_rows(data: bytes) -> list[tuple[str, int, dict[str, str]]]:
    text = data.decode("utf-8-sig", errors="replace")
    sample = text[:8192]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",;\t|")
    except csv.Error:
        dialect = csv.excel
    parsed = iter(csv.reader(io.StringIO(text), dialect))
    try:
        header_row = next(parsed)
    except StopIteration:
        return []
    headers = [
        str(value).strip() or f"column_{index + 1}"
        for index, value in enumerate(header_row)
    ]
    rows: list[tuple[str, int, dict[str, str]]] = []
    for row_number, values in enumerate(parsed, start=2):
        if not any(str(value).strip() for value in values):
            continue
        if len(rows) >= MAX_ASSET_IMPORT_ROWS:
            raise AssetImportError(f"资产文件超过 {MAX_ASSET_IMPORT_ROWS} 行限制")
        record = {
            headers[index] if index < len(headers) else f"column_{index + 1}": value
            for index, value in enumerate(values)
        }
        rows.append(("CSV", row_number, record))
    return rows


def _json_rows(data: bytes) -> list[tuple[str, int, object]]:
    try:
        payload = json.loads(data.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise AssetImportError(f"JSON 文件无法解析: {exc}") from exc
    values = payload if isinstance(payload, list) else payload.get("assets", [payload]) if isinstance(payload, dict) else [payload]
    return [("JSON", index, value) for index, value in enumerate(values, start=1)]


def _xlsx_rows(data: bytes) -> list[tuple[str, int, dict[str, str]]]:
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as exc:
        raise AssetImportError("XLSX 文件损坏或格式不受支持") from exc
    entries = archive.infolist()
    if len(entries) > MAX_ASSET_XLSX_ENTRIES:
        raise AssetImportError("XLSX 文件包含过多内部条目")
    if sum(item.file_size for item in entries) > MAX_ASSET_XLSX_EXPANDED_BYTES:
        raise AssetImportError("XLSX 文件解压后体积超过安全限制")
    namespace = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    relationships_ns = {
        "r": "http://schemas.openxmlformats.org/package/2006/relationships",
    }
    shared: list[str] = []
    if "xl/sharedStrings.xml" in archive.namelist():
        root = ElementTree.fromstring(archive.read("xl/sharedStrings.xml"))
        for item in root.findall("m:si", namespace):
            shared.append("".join(node.text or "" for node in item.iterfind(".//m:t", namespace)))
    workbook = ElementTree.fromstring(archive.read("xl/workbook.xml"))
    rels = ElementTree.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
    targets = {
        item.attrib["Id"]: item.attrib["Target"]
        for item in rels.findall("r:Relationship", relationships_ns)
    }
    result: list[tuple[str, int, dict[str, str]]] = []
    for sheet in workbook.findall("m:sheets/m:sheet", namespace):
        name = sheet.attrib.get("name", "Sheet")
        relation_id = sheet.attrib.get("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id")
        target = targets.get(str(relation_id), "")
        if not target:
            continue
        path = target.lstrip("/") if target.startswith("/xl/") else f"xl/{target.lstrip('/')}"
        if path not in archive.namelist():
            continue
        root = ElementTree.fromstring(archive.read(path))
        table: list[list[str]] = []
        for row in root.findall(".//m:sheetData/m:row", namespace):
            cells: dict[int, str] = {}
            for cell in row.findall("m:c", namespace):
                reference = cell.attrib.get("r", "A1")
                letters = "".join(char for char in reference if char.isalpha())
                column = 0
                for char in letters:
                    column = column * 26 + ord(char.upper()) - 64
                cell_type = cell.attrib.get("t")
                value_node = cell.find("m:v", namespace)
                inline = cell.find("m:is", namespace)
                value = ""
                if inline is not None:
                    value = "".join(node.text or "" for node in inline.iterfind(".//m:t", namespace))
                elif value_node is not None:
                    value = value_node.text or ""
                    if cell_type == "s":
                        try:
                            value = shared[int(value)]
                        except (ValueError, IndexError):
                            value = ""
                cells[max(0, column - 1)] = value
            if cells:
                width = max(cells) + 1
                table.append([cells.get(index, "") for index in range(width)])
        if not table:
            continue
        headers = [
            str(value).strip() or f"column_{index + 1}"
            for index, value in enumerate(table[0])
        ]
        for row_number, values in enumerate(table[1:], start=2):
            if not any(str(value).strip() for value in values):
                continue
            if len(result) >= MAX_ASSET_IMPORT_ROWS:
                raise AssetImportError(f"资产文件超过 {MAX_ASSET_IMPORT_ROWS} 行限制")
            result.append((
                name,
                row_number,
                {
                    headers[index] if index < len(headers) else f"column_{index + 1}": value
                    for index, value in enumerate(values)
                },
            ))
    return result


def parse_asset_file(filename: str, data: bytes) -> list[tuple[str, int, object]]:
    if not data:
        raise AssetImportError("资产文件为空")
    if len(data) > MAX_ASSET_IMPORT_BYTES:
        raise AssetImportError(f"资产文件超过 {MAX_ASSET_IMPORT_BYTES} bytes 限制")
    suffix = Path(filename).suffix.casefold()
    if suffix in {".csv", ".tsv", ".txt"}:
        rows = _csv_rows(data)
    elif suffix == ".json":
        rows = _json_rows(data)
    elif suffix == ".xlsx":
        rows = _xlsx_rows(data)
    else:
        raise AssetImportError("仅支持 CSV、TSV、JSON 和 XLSX 资产文件")
    if len(rows) > MAX_ASSET_IMPORT_ROWS:
        raise AssetImportError(f"资产文件超过 {MAX_ASSET_IMPORT_ROWS} 行限制")
    return rows


def _scope_roots(store: ProjectStore) -> tuple[set[str], set[str]]:
    target = store.read_json("target.json")
    roots: set[str] = set()
    excluded: set[str] = set()
    for value in target.get("targets", []):
        parsed = urlsplit(str(value) if "://" in str(value) else f"https://{value}")
        if parsed.hostname:
            roots.add(parsed.hostname.casefold().rstrip("."))
    for value in target.get("out_of_scope", []):
        parsed = urlsplit(str(value) if "://" in str(value) else f"https://{value}")
        if parsed.hostname:
            excluded.add(parsed.hostname.casefold().rstrip("."))
    return roots, excluded


def _in_scope(candidate: NormalizedCandidate, source_type: str, store: ProjectStore) -> tuple[bool, str]:
    host = candidate.hostname or candidate.ip_address or ""
    roots, excluded = _scope_roots(store)
    if any(host == item or host.endswith(f".{item}") for item in excluded):
        return False, "命中项目不收范围"
    if source_type in _OFFICIAL_SOURCE_TYPES:
        return True, "项目所有者明确提供的资产来源"
    if any(host == item or host.endswith(f".{item}") for item in roots):
        return True, "与项目所有者明确目标同域"
    return False, "关联发现尚未得到项目所有者明确授权"


def asset_value_in_scope(store: ProjectStore, value: object) -> bool:
    candidate = normalize_asset_candidate(value)
    if candidate is None:
        return False
    roots, excluded = _scope_roots(store)
    host = candidate.hostname or candidate.ip_address or ""
    if any(host == item or host.endswith(f".{item}") for item in excluded):
        return False
    if not roots:
        return True
    return _in_scope(candidate, "discovered", store)[0]


def _assignment_accepts(
    assignment: dict[str, Any],
    candidate: NormalizedCandidate,
) -> bool:
    if str(assignment.get("endpoint_key") or "") == candidate.endpoint_key:
        return True
    assigned_ip = str(assignment.get("ip_address") or "")
    if assigned_ip and candidate.ip_address == assigned_ip:
        assigned_port = int(assignment.get("port") or 0)
        return assigned_port in {0, int(candidate.port or 0)}
    return False


class AssetInventory:
    def __init__(self, store: ProjectStore):
        self.store = store
        self.database = ControlDatabase(store.path / "control_plane.db")

    def import_file(
        self,
        *,
        filename: str,
        data: bytes,
        logical_source: str,
        source_type: str = "official",
    ) -> dict[str, Any]:
        rows = parse_asset_file(filename, data)
        return self._import_rows(
            filename=filename,
            data=data,
            rows=rows,
            logical_source=logical_source,
            source_type=source_type,
        )

    def sync_declared_targets(self) -> dict[str, Any]:
        target = self.store.read_json("target.json")
        values = [{"target": value} for value in target.get("targets", [])]
        data = json.dumps(values, ensure_ascii=False, sort_keys=True).encode("utf-8")
        rows = [("target.json", index, row) for index, row in enumerate(values, start=1)]
        result = self._import_rows(
            filename="target.json",
            data=data,
            rows=rows,
            logical_source="project-targets",
            source_type="target",
        )
        self.adopt_existing_profile()
        self.ensure_profile_migration()
        return result

    def prepare_run(self) -> None:
        """Release incomplete profile tasks once at the start of a new Run.

        Failed or partial tasks must not be selected again inside the same controller
        loop, otherwise a persistently failing endpoint creates an unbounded
        incremental-profile cycle. A new user-started Run is the retry fence.
        """
        # 迁移未完成时不允许任何画像调度派发（enqueue_profile_job_atomic
        # 也会再次校验标记）。
        self.ensure_profile_migration()
        now = now_iso()
        # 回收派发残留：Job 已终结（含取消/崩溃）但工作项仍 dispatched 的，
        # 退回 partial 参与下一轮重试，不留下永久占用。
        with self.database.connect() as db:
            db.execute(
                """
                UPDATE profile_work_items
                SET status='partial',updated_at=?
                WHERE status='dispatched' AND (
                    last_dispatch_job_id IS NULL
                    OR last_dispatch_job_id NOT IN (
                        SELECT id FROM jobs
                        WHERE status IN ('queued','running','cancelling')
                    )
                )
                """,
                (now,),
            )
        with self.database.connect() as db:
            db.execute(
                """
                UPDATE profile_tasks SET status='partial',updated_at=?
                WHERE status='pending' AND attempts >= ?
                """,
                (now, MAX_PROFILE_ATTEMPTS),
            )
            db.execute(
                """
                UPDATE profile_tasks SET status='pending',updated_at=?
                WHERE (
                    status='failed'
                    OR (
                        status='partial'
                        AND EXISTS (
                            SELECT 1 FROM validation_attempts v
                            WHERE v.asset_id=profile_tasks.asset_id
                              AND v.outcome='profile_partial'
                        )
                    )
                )
                  AND attempts < ?
                  AND asset_id IN (
                    SELECT id FROM enterprise_assets
                    WHERE status NOT IN ('out_of_scope','invalid','stale','duplicate')
                  )
                """,
                (now, MAX_PROFILE_ATTEMPTS),
            )
        self.reconcile_profile_state()

    def reconcile_profile_state(self) -> None:
        """Project the authoritative profile task state onto enterprise assets."""

        now = now_iso()
        with self.database.connect() as db:
            db.execute(
                """
                UPDATE enterprise_assets
                SET status=CASE (
                    SELECT p.status FROM profile_tasks p WHERE p.asset_id=enterprise_assets.id
                )
                  WHEN 'pending' THEN 'pending_profile'
                  WHEN 'profiled' THEN 'profiled'
                  WHEN 'partial' THEN 'partial'
                  WHEN 'failed' THEN 'blocked'
                  ELSE status
                END,
                last_seen_at=?
                WHERE status NOT IN ('out_of_scope','invalid','stale','duplicate')
                  AND EXISTS (
                    SELECT 1 FROM profile_tasks p WHERE p.asset_id=enterprise_assets.id
                  )
                """,
                (now,),
            )

    def adopt_existing_profile(self) -> None:
        """Backfill the V4 read model from the existing JSONL profile.

        Existing projects must not pay for the same baseline merely because the
        asset pipeline was introduced later. A historical partial baseline stays
        explicitly partial; it is visible to coverage but is not silently treated
        as a brand-new pending task.
        """
        from .target_profile import load_profile_state, target_profile

        rows = target_profile(self.store)
        if not rows:
            return
        state = load_profile_state(self.store)
        complete = state.get("baseline_status") == "complete"
        by_endpoint: dict[str, list[dict[str, Any]]] = {}
        for row in rows:
            candidate = normalize_asset_candidate(row.get("url"))
            if candidate is not None:
                by_endpoint.setdefault(candidate.endpoint_key, []).append(row)
        now = now_iso()
        with self.database.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                for endpoint_key, profile_rows in by_endpoint.items():
                    asset = db.execute(
                        "SELECT id FROM enterprise_assets WHERE endpoint_key=?",
                        (endpoint_key,),
                    ).fetchone()
                    if asset is None:
                        continue
                    task = db.execute(
                        "SELECT id,status FROM profile_tasks WHERE asset_id=?",
                        (asset["id"],),
                    ).fetchone()
                    if task is None or task["status"] not in {"pending", "failed"}:
                        continue
                    status = "profiled" if complete else "partial"
                    db.execute(
                        "UPDATE profile_tasks SET status=?,updated_at=? WHERE id=?",
                        (status, now, task["id"]),
                    )
                    db.execute(
                        "UPDATE enterprise_assets SET status=?,last_seen_at=? WHERE id=?",
                        (status, now, asset["id"]),
                    )
                    for row in profile_rows:
                        db.execute(
                            """
                            INSERT INTO profile_urls(
                                id,profile_task_id,url,function,technology_json,created_at
                            ) VALUES (?,?,?,?,?,?)
                            ON CONFLICT(profile_task_id,url) DO NOTHING
                            """,
                            (
                                _id("APU"), task["id"], str(row["url"]),
                                str(row.get("function") or ""),
                                json.dumps(row.get("technology_stack") or [], ensure_ascii=False),
                                now,
                            ),
                        )
                db.execute("COMMIT")
            except Exception:
                db.execute("ROLLBACK")
                raise

    def _import_rows(
        self,
        *,
        filename: str,
        data: bytes,
        rows: Iterable[tuple[str, int, object]],
        logical_source: str,
        source_type: str,
    ) -> dict[str, Any]:
        logical_source = str(logical_source or filename).strip()[:240]
        source_type = str(source_type or "official").strip().casefold()
        if source_type not in {"official", "target", "manual", "discovered"}:
            raise AssetImportError("非法资产来源类型")
        digest = hashlib.sha256(data).hexdigest()
        now = now_iso()
        with self.database.connect() as db:
            existing = db.execute(
                "SELECT * FROM asset_import_files WHERE logical_source=? AND file_sha256=?",
                (logical_source, digest),
            ).fetchone()
            if existing:
                result = dict(existing)
                result.update({"duplicate": True, "assets": self.summary()})
                return result
            generation_row = db.execute(
                "SELECT coalesce(max(generation),0)+1 AS generation FROM asset_import_files WHERE logical_source=?",
                (logical_source,),
            ).fetchone()
            generation = int(generation_row["generation"])
            import_id = _id("AIF")
            db.execute("BEGIN IMMEDIATE")
            try:
                db.execute(
                    """
                    INSERT INTO asset_import_files(
                        id,logical_source,source_type,file_name,file_sha256,file_size,
                        generation,status,imported_at
                    ) VALUES (?,?,?,?,?,?,?,'importing',?)
                    """,
                    (import_id, logical_source, source_type, filename[:240], digest, len(data), generation, now),
                )
                db.execute(
                    """
                    UPDATE candidates SET is_active=0,terminal_status='stale',updated_at=?
                    WHERE logical_source=? AND is_active=1
                    """,
                    (now, logical_source),
                )
                row_count = 0
                candidate_count = 0
                asset_ids: set[str] = set()
                for sheet_name, row_number, raw_row in rows:
                    row_count += 1
                    serialized_row = json.dumps(
                        raw_row, ensure_ascii=False, sort_keys=True, default=str,
                    )
                    extracted_candidates = extract_asset_candidates(raw_row)
                    raw_json = _minimal_source_row(extracted_candidates)
                    source_row_id = _id("ASR")
                    db.execute(
                        """
                        INSERT INTO source_rows(
                            id,import_file_id,sheet_name,row_number,raw_json,raw_sha256,created_at
                        ) VALUES (?,?,?,?,?,?,?)
                        """,
                        (
                            source_row_id, import_id, str(sheet_name)[:240], int(row_number),
                            raw_json, hashlib.sha256(serialized_row.encode("utf-8")).hexdigest(), now,
                        ),
                    )
                    for ordinal, candidate in enumerate(extracted_candidates):
                        candidate_count += 1
                        candidate_id = _id("AC")
                        scope_ok, scope_reason = _in_scope(candidate, source_type, self.store)
                        existing_asset = db.execute(
                            "SELECT * FROM enterprise_assets WHERE endpoint_key=?",
                            (candidate.endpoint_key,),
                        ).fetchone()
                        terminal_status = (
                            "out_of_scope" if not scope_ok
                            else "duplicate" if existing_asset
                            else "pending_profile"
                        )
                        db.execute(
                            """
                            INSERT INTO candidates(
                                id,source_row_id,import_file_id,logical_source,source_type,generation,
                                candidate_kind,ordinal,raw_target,canonical_url,hostname,ip_address,
                                scheme,port,endpoint_key,terminal_status,terminal_reason,is_active,
                                metadata_json,created_at,updated_at
                            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,'{}',?,?)
                            """,
                            (
                                candidate_id, source_row_id, import_id, logical_source, source_type,
                                generation, candidate.candidate_kind, ordinal,
                                _safe_candidate_value(candidate),
                                candidate.canonical_url, candidate.hostname, candidate.ip_address,
                                candidate.scheme, candidate.port, candidate.endpoint_key,
                                terminal_status, None if scope_ok else scope_reason, now, now,
                            ),
                        )
                        db.execute(
                            """
                            INSERT INTO scope_decisions(id,candidate_id,scope_root,in_scope,reason,decided_at)
                            VALUES (?,?,?,?,?,?)
                            """,
                            (_id("ASD"), candidate_id, None, int(scope_ok), scope_reason, now),
                        )
                        if existing_asset:
                            asset_id = str(existing_asset["id"])
                            db.execute(
                                """
                                UPDATE enterprise_assets SET source_count=source_count+1,
                                    official_source=max(official_source,?),last_seen_at=?,
                                    canonical_url=coalesce(canonical_url,?),
                                    authoritative_candidate_id=?,
                                    status=CASE
                                      WHEN ?=1 AND status IN ('stale','out_of_scope')
                                        THEN 'pending_profile'
                                      ELSE status
                                    END
                                WHERE id=?
                                """,
                                (
                                    int(source_type in _OFFICIAL_SOURCE_TYPES), now,
                                    candidate.canonical_url, candidate_id, int(scope_ok), asset_id,
                                ),
                            )
                        else:
                            asset_id = _id("EA")
                            db.execute(
                                """
                                INSERT INTO enterprise_assets(
                                    id,asset_type,endpoint_key,canonical_url,hostname,ip_address,
                                    scheme,port,status,source_count,official_source,
                                    authoritative_candidate_id,first_seen_at,last_seen_at,metadata_json
                                ) VALUES (?,?,?,?,?,?,?,?,?,1,?,?,?,?,?)
                                """,
                                (
                                    asset_id, candidate.candidate_kind, candidate.endpoint_key,
                                    candidate.canonical_url, candidate.hostname, candidate.ip_address,
                                    candidate.scheme, candidate.port,
                                    "pending_profile" if scope_ok else "out_of_scope",
                                    int(source_type in _OFFICIAL_SOURCE_TYPES), candidate_id, now, now,
                                    "{}",
                                ),
                            )
                        asset_ids.add(asset_id)
                        db.execute(
                            """
                            INSERT INTO provenance(
                                id,asset_id,candidate_id,source_row_id,import_file_id,logical_source,
                                source_type,generation,sheet_name,row_number,observed_value,created_at
                            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
                            """,
                            (
                                _id("AP"), asset_id, candidate_id, source_row_id, import_id,
                                logical_source, source_type, generation, str(sheet_name)[:240],
                                int(row_number), _safe_candidate_value(candidate)[:4096], now,
                            ),
                        )
                        if scope_ok:
                            db.execute(
                                """
                                INSERT INTO profile_tasks(id,asset_id,status,attempts,created_at,updated_at)
                                VALUES (?,?,'pending',0,?,?)
                                ON CONFLICT(asset_id) DO UPDATE SET
                                  status=CASE WHEN profile_tasks.status='profiled' THEN 'profiled' ELSE 'pending' END,
                                  updated_at=excluded.updated_at
                                """,
                                (_id("APT"), asset_id, now, now),
                            )
                            if candidate.canonical_url:
                                # 每个 URL 采集工作项与端点任务同事务创建；
                                # 同 URL 多来源只保留一份同用途待办。
                                self._ensure_work_item(
                                    db,
                                    asset_id=asset_id,
                                    canonical_url=candidate.canonical_url,
                                    purpose="collect",
                                    source_reason=(
                                        "baseline"
                                        if source_type in _OFFICIAL_SOURCE_TYPES
                                        else "discovered"
                                    ),
                                    now=now,
                                )
                db.execute(
                    """
                    UPDATE enterprise_assets SET status='stale'
                    WHERE id IN (
                      SELECT a.id FROM enterprise_assets a
                      WHERE NOT EXISTS (
                        SELECT 1 FROM provenance p
                        JOIN candidates c ON c.id=p.candidate_id
                        WHERE p.asset_id=a.id AND c.is_active=1
                      )
                    )
                    """
                )
                db.execute(
                    """
                    UPDATE enterprise_assets SET
                      source_count=(
                        SELECT count(*) FROM provenance p
                        JOIN candidates c ON c.id=p.candidate_id
                        WHERE p.asset_id=enterprise_assets.id AND c.is_active=1
                      ),
                      official_source=CASE WHEN EXISTS (
                        SELECT 1 FROM provenance p
                        JOIN candidates c ON c.id=p.candidate_id
                        WHERE p.asset_id=enterprise_assets.id AND c.is_active=1
                          AND p.source_type IN ('official','target','manual')
                      ) THEN 1 ELSE 0 END
                    """
                )
                event_payload = json.dumps(
                    {"rows": row_count, "candidates": candidate_count},
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                )
                event_id = f"EV-AI-{hashlib.sha256(import_id.encode()).hexdigest()[:20]}"
                plan_json = json.dumps(
                    {"version": 1, "event_id": event_id, "actions": []},
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                )
                db.execute(
                    """
                    INSERT INTO commit_events(
                        event_id,idempotency_key,event_type,aggregate_type,aggregate_id,
                        source_type,source_id,payload_json,payload_sha256,status,attempts,
                        available_at,occurred_at,enqueued_at,projected_at
                    ) VALUES (?,?,?,?,?,?,?,?,?,'committed',0,?,?,?,?)
                    """,
                    (
                        event_id, f"asset_import:{import_id}", "asset_import_completed",
                        "asset_import", import_id, "asset_import", import_id, event_payload,
                        hashlib.sha256(event_payload.encode()).hexdigest(), now, now, now, now,
                    ),
                )
                db.execute(
                    """
                    INSERT INTO commit_plans(
                        plan_id,event_id,plan_version,plan_json,plan_sha256,
                        action_count,created_at
                    ) VALUES (?,?,?,?,?,0,?)
                    """,
                    (
                        f"CP-AI-{hashlib.sha256(import_id.encode()).hexdigest()[:20]}",
                        event_id, 1, plan_json,
                        hashlib.sha256(plan_json.encode()).hexdigest(), now,
                    ),
                )
                db.execute(
                    """
                    UPDATE asset_import_files SET status='completed',row_count=?,
                        candidate_count=?,completed_at=? WHERE id=?
                    """,
                    (row_count, candidate_count, now, import_id),
                )
                db.execute("COMMIT")
            except Exception:
                db.execute("ROLLBACK")
                raise
        self.reconcile_profile_state()
        return {
            "id": import_id,
            "logical_source": logical_source,
            "source_type": source_type,
            "generation": generation,
            "row_count": row_count,
            "candidate_count": candidate_count,
            "asset_count": len(asset_ids),
            "duplicate": False,
            "assets": self.summary(),
        }

    def summary(self) -> dict[str, Any]:
        with self.database.connect() as db:
            counts = {
                row["status"]: int(row["count"])
                for row in db.execute(
                    "SELECT status,count(*) AS count FROM enterprise_assets GROUP BY status"
                ).fetchall()
            }
            task_counts = {
                row["status"]: int(row["count"])
                for row in db.execute(
                    "SELECT status,count(*) AS count FROM profile_tasks GROUP BY status"
                ).fetchall()
            }
            totals = db.execute(
                """
                SELECT
                  (SELECT count(*) FROM enterprise_assets) AS assets,
                  (SELECT count(*) FROM candidates WHERE is_active=1) AS candidates,
                  (SELECT count(*) FROM asset_import_files WHERE status='completed') AS imports,
                  (SELECT count(*) FROM asset_edges) AS relations,
                  (SELECT count(*) FROM commit_events WHERE status='committed') AS commit_events
                """
            ).fetchone()
            # 分口径指标：每个数字有明确单位与过滤条件（实施规格 5.4）。
            scope_counts = db.execute(
                """
                SELECT
                  (SELECT count(*) FROM enterprise_assets
                   WHERE status NOT IN ('out_of_scope','invalid','stale','duplicate')
                  ) AS active_scope,
                  (SELECT count(*) FROM profile_work_items wi
                   JOIN enterprise_assets a ON a.id=wi.asset_id
                   WHERE wi.status IN ('pending','partial')
                     AND a.status NOT IN ('out_of_scope','invalid','stale','duplicate')
                  ) AS pending_work
                """
            ).fetchone()
        return {
            "total": int(totals["assets"]),
            # 底座资产记录数（含各状态）——与 total 同值但语义显式命名。
            "inventory_record_count": int(totals["assets"]),
            # 范围内且未失效的有效端点数。
            "active_scope_endpoint_count": int(scope_counts["active_scope"]),
            "stale_asset_count": int(counts.get("stale", 0)),
            "out_of_scope_asset_count": int(counts.get("out_of_scope", 0)),
            # 待画像工作项数（URL 级），不等于资产数。
            "profile_pending_work_count": int(scope_counts["pending_work"]),
            "active_candidates": int(totals["candidates"]),
            "imports": int(totals["imports"]),
            "relations": int(totals["relations"]),
            "commit_events": int(totals["commit_events"]),
            "by_status": counts,
            "profile_tasks": task_counts,
        }

    def list_assets(self, limit: int = 1000, offset: int = 0) -> list[dict[str, Any]]:
        safe_limit = max(1, min(int(limit), 5000))
        safe_offset = max(0, int(offset))
        with self.database.connect() as db:
            rows = db.execute(
                """
                SELECT a.*,p.status AS profile_status,p.attempts AS profile_attempts,
                    (SELECT count(*) FROM provenance v WHERE v.asset_id=a.id) AS provenance_count,
                    (SELECT count(*) FROM validation_attempts v
                     WHERE v.asset_id=a.id) AS validation_attempt_count,
                    (SELECT outcome FROM validation_attempts v
                     WHERE v.asset_id=a.id ORDER BY attempted_at DESC LIMIT 1) AS last_validation_outcome,
                    (SELECT count(*) FROM profile_urls u
                     JOIN profile_tasks t ON t.id=u.profile_task_id WHERE t.asset_id=a.id) AS url_count
                FROM enterprise_assets a
                LEFT JOIN profile_tasks p ON p.asset_id=a.id
                ORDER BY a.official_source DESC,a.status,a.endpoint_key,a.id
                LIMIT ? OFFSET ?
                """,
                (safe_limit, safe_offset),
            ).fetchall()
        result: list[dict[str, Any]] = []
        for row in rows:
            item = dict(row)
            item["metadata"] = json.loads(item.pop("metadata_json") or "{}")
            result.append(item)
        return result

    def imports(self) -> list[dict[str, Any]]:
        with self.database.connect() as db:
            return [
                dict(row) for row in db.execute(
                    "SELECT * FROM asset_import_files ORDER BY imported_at DESC"
                ).fetchall()
            ]

    def pending_profile_assignments(self, limit: int = 100) -> list[dict[str, Any]]:
        with self.database.connect() as db:
            rows = db.execute(
                """
                SELECT p.id AS task_id,a.id AS asset_id,a.endpoint_key,a.canonical_url,
                    a.hostname,a.ip_address,a.scheme,a.port
                FROM profile_tasks p JOIN enterprise_assets a ON a.id=p.asset_id
                WHERE p.status='pending'
                  AND p.attempts < ?
                  AND a.status NOT IN ('out_of_scope','invalid','stale','duplicate')
                ORDER BY a.official_source DESC,a.first_seen_at,a.endpoint_key
                LIMIT ?
                """,
                (MAX_PROFILE_ATTEMPTS, max(1, min(int(limit), 1000))),
            ).fetchall()
        assignments: list[dict[str, Any]] = []
        for row in rows:
            seed_url = str(row["canonical_url"] or "")
            if not seed_url:
                host = str(row["hostname"] or row["ip_address"] or "")
                if not host:
                    continue
                display_host = f"[{host}]" if ":" in host and not host.startswith("[") else host
                port = int(row["port"] or 0)
                seed_url = f"https://{display_host}{f':{port}' if port else ''}/"
            assignments.append(ProfileAssignment(
                task_id=str(row["task_id"]),
                asset_id=str(row["asset_id"]),
                endpoint_key=str(row["endpoint_key"]),
                seed_url=seed_url,
                hostname=str(row["hostname"]) if row["hostname"] else None,
                ip_address=str(row["ip_address"]) if row["ip_address"] else None,
                scheme=str(row["scheme"]) if row["scheme"] else None,
                port=int(row["port"]) if row["port"] is not None else None,
            ).as_payload())
        return assignments

    def profile_assignments_for_seeds(
        self,
        seed_urls: list[str],
    ) -> list[dict[str, Any]]:
        pending = self.pending_profile_assignments(limit=1000)
        selected: list[dict[str, Any]] = []
        used: set[str] = set()
        for seed in seed_urls:
            candidate = normalize_asset_candidate(seed)
            if candidate is None:
                continue
            assignment = next(
                (
                    item for item in pending
                    if str(item["task_id"]) not in used
                    and _assignment_accepts(item, candidate)
                ),
                None,
            )
            if assignment is None:
                with self.database.connect() as db:
                    row = db.execute(
                        """
                        SELECT p.id AS task_id,a.id AS asset_id,a.endpoint_key,
                            a.hostname,a.ip_address,a.scheme,a.port
                        FROM profile_tasks p JOIN enterprise_assets a ON a.id=p.asset_id
                        WHERE a.status NOT IN ('out_of_scope','invalid','stale','duplicate')
                          AND (
                            a.endpoint_key=?
                            OR (? IS NOT NULL AND a.ip_address=? AND coalesce(a.port,0) IN (0,?))
                            OR (? IS NOT NULL AND a.hostname=? AND coalesce(a.port,0) IN (0,?))
                          )
                        ORDER BY a.endpoint_key=? DESC LIMIT 1
                        """,
                        (
                            candidate.endpoint_key,
                            candidate.ip_address, candidate.ip_address, candidate.port or 0,
                            candidate.hostname, candidate.hostname, candidate.port or 0,
                            candidate.endpoint_key,
                        ),
                    ).fetchone()
                if row is not None:
                    assignment = {
                        "task_id": str(row["task_id"]),
                        "asset_id": str(row["asset_id"]),
                        "endpoint_key": str(row["endpoint_key"]),
                        "seed_url": str(seed),
                        "hostname": row["hostname"],
                        "ip_address": row["ip_address"],
                        "scheme": row["scheme"],
                        "port": row["port"],
                    }
            if assignment is None:
                continue
            selected_item = dict(assignment)
            selected_item["seed_url"] = str(seed)
            selected.append(selected_item)
            used.add(str(assignment["task_id"]))
        return selected

    def pending_profile_seeds(self, limit: int = 100) -> list[str]:
        return [
            str(item["seed_url"])
            for item in self.pending_profile_assignments(limit=limit)
        ]

    def filter_profile_records(
        self,
        assignments: list[dict[str, Any]],
        records: list[dict[str, Any]],
    ) -> tuple[list[dict[str, Any]], list[str], list[dict[str, str]]]:
        accepted: list[dict[str, Any]] = []
        discovered: list[str] = []
        rejected: list[dict[str, str]] = []
        for row in records[:200]:
            if not isinstance(row, dict):
                continue
            raw_url = str(row.get("url") or "").strip()
            candidate = normalize_asset_candidate(raw_url)
            if candidate is None:
                rejected.append({"url": raw_url, "reason": "invalid_url"})
                continue
            scope_ok = asset_value_in_scope(self.store, raw_url)
            scope_reason = "当前项目范围允许" if scope_ok else "目标不在当前项目授权范围"
            if not scope_ok:
                rejected.append({"url": raw_url, "reason": scope_reason})
                continue
            if assignments and not any(
                _assignment_accepts(assignment, candidate)
                for assignment in assignments
            ):
                discovered.append(candidate.canonical_url or raw_url)
                rejected.append({"url": raw_url, "reason": "outside_profile_assignment"})
                continue
            safe = dict(row)
            safe["url"] = candidate.canonical_url or raw_url
            accepted.append(safe)
        return accepted, list(dict.fromkeys(discovered)), rejected

    def register_discovered_urls(
        self,
        values: list[object],
        *,
        parent_url: str | None = None,
        relation_type: str = "model_discovered",
        discovery_method: str = "worker_output",
        evidence_path: str = "",
        confidence: float = 0.5,
    ) -> list[str]:
        normalized = [
            candidate for value in values
            if (candidate := normalize_asset_candidate(value)) is not None
        ]
        if not normalized:
            return []
        payload = [{"url": _safe_candidate_value(item)} for item in normalized]
        material = json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")
        discovery_identity = (
            str(parent_url),
            relation_type,
            discovery_method,
            hashlib.sha256(material).hexdigest(),
        )
        logical_source = (
            "discovery:"
            + hashlib.sha256(
                "\x1f".join(discovery_identity).encode()
            ).hexdigest()[:20]
        )
        self._import_rows(
            filename="worker-discovery.json",
            data=material,
            rows=[("worker", index, row) for index, row in enumerate(payload, start=1)],
            logical_source=logical_source,
            source_type="discovered",
        )
        parent = normalize_asset_candidate(parent_url) if parent_url else None
        now = now_iso()
        in_scope_urls: list[str] = []
        with self.database.connect() as db:
            parent_row = (
                db.execute(
                    "SELECT id FROM enterprise_assets WHERE endpoint_key=?",
                    (parent.endpoint_key,),
                ).fetchone()
                if parent else None
            )
            for child in normalized:
                child_row = db.execute(
                    "SELECT id,status FROM enterprise_assets WHERE endpoint_key=?",
                    (child.endpoint_key,),
                ).fetchone()
                if child_row is None:
                    continue
                parent_id = parent_row["id"] if parent_row else None
                edge = db.execute(
                    """
                    SELECT id FROM asset_edges
                    WHERE parent_asset_id IS ? AND child_asset_id=?
                      AND relation_type=? AND discovery_method=?
                    """,
                    (
                        parent_id,
                        child_row["id"],
                        relation_type[:120],
                        discovery_method[:120],
                    ),
                ).fetchone()
                if edge:
                    db.execute(
                        """
                        UPDATE asset_edges SET confidence=max(confidence,?),
                            evidence_path=CASE WHEN ?='' THEN evidence_path ELSE ? END
                        WHERE id=?
                        """,
                        (
                            max(0.0, min(1.0, float(confidence))),
                            evidence_path[:1000],
                            evidence_path[:1000],
                            edge["id"],
                        ),
                    )
                else:
                    db.execute(
                        """
                        INSERT INTO asset_edges(
                            id,parent_asset_id,child_asset_id,relation_type,discovery_method,
                            evidence_path,confidence,metadata_json,created_at
                        ) VALUES (?,?,?,?,?,?,?,'{}',?)
                        """,
                        (
                            _id("AE"), parent_id, child_row["id"],
                            relation_type[:120], discovery_method[:120], evidence_path[:1000],
                            max(0.0, min(1.0, float(confidence))), now,
                        ),
                    )
                if child_row["status"] != "out_of_scope" and child.canonical_url:
                    in_scope_urls.append(child.canonical_url)
        return list(dict.fromkeys(in_scope_urls))

    def record_profile_result(
        self,
        assignments_or_seed_urls: list[dict[str, Any] | str],
        records: list[dict[str, Any]],
        *,
        complete: bool,
        error: str | None = None,
    ) -> None:
        now = now_iso()
        with self.database.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                self._apply_profile_result(
                    db, assignments_or_seed_urls, records, complete, error, now,
                )
                db.execute("COMMIT")
            except Exception:
                db.execute("ROLLBACK")
                raise

    @staticmethod
    def _apply_profile_result(
        db: Any,
        assignments_or_seed_urls: list[dict[str, Any] | str],
        records: list[dict[str, Any]],
        complete: bool,
        error: str | None,
        now: str,
    ) -> None:
        for value in assignments_or_seed_urls:
            assignment: dict[str, Any] | None = None
            asset = None
            task = None
            if isinstance(value, dict) and value.get("task_id"):
                assignment = dict(value)
                task = db.execute(
                    "SELECT id,asset_id,status FROM profile_tasks WHERE id=?",
                    (str(value["task_id"]),),
                ).fetchone()
                if task is not None:
                    asset = db.execute(
                        "SELECT * FROM enterprise_assets WHERE id=?",
                        (str(task["asset_id"]),),
                    ).fetchone()
            else:
                normalized = normalize_asset_candidate(value)
                if normalized is None:
                    continue
                asset = db.execute(
                    """
                    SELECT * FROM enterprise_assets
                    WHERE endpoint_key=?
                       OR (? IS NOT NULL AND ip_address=? AND coalesce(port,0) IN (0,?))
                       OR (? IS NOT NULL AND hostname=? AND coalesce(port,0) IN (0,?))
                    ORDER BY endpoint_key=? DESC LIMIT 1
                    """,
                    (
                        normalized.endpoint_key,
                        normalized.ip_address, normalized.ip_address, normalized.port or 0,
                        normalized.hostname, normalized.hostname, normalized.port or 0,
                        normalized.endpoint_key,
                    ),
                ).fetchone()
                if asset is not None:
                    task = db.execute(
                        "SELECT id,asset_id,status FROM profile_tasks WHERE asset_id=?",
                        (asset["id"],),
                    ).fetchone()
                    assignment = {
                        "task_id": str(task["id"]) if task else "",
                        "asset_id": str(asset["id"]),
                        "endpoint_key": str(asset["endpoint_key"]),
                        "hostname": asset["hostname"],
                        "ip_address": asset["ip_address"],
                        "scheme": asset["scheme"],
                        "port": asset["port"],
                    }
            if asset is None or task is None or assignment is None:
                continue
            matching_records = [
                record for record in records
                if (
                    (child := normalize_asset_candidate(record.get("url"))) is not None
                    and _assignment_accepts(assignment, child)
                )
            ]
            effective_error = str(error or "").strip()
            status = (
                "failed" if effective_error
                else "profiled" if complete and matching_records
                else "partial"
            )
            updated = db.execute(
                """
                UPDATE profile_tasks SET status=?,attempts=attempts+1,updated_at=?
                WHERE id=? AND status IN ('pending','partial')
                """,
                (status, now, task["id"]),
            )
            transitioned = updated.rowcount > 0
            if not transitioned and str(task["status"]) != "profiled":
                continue
            if transitioned:
                asset_status = {
                    "failed": "blocked",
                    "profiled": "profiled",
                    "partial": "partial",
                }[status]
                db.execute(
                    "UPDATE enterprise_assets SET status=?,last_seen_at=? WHERE id=?",
                    (asset_status, now, asset["id"]),
                )
                db.execute(
                    """
                    INSERT INTO validation_attempts(id,asset_id,outcome,detail,attempted_at)
                    VALUES (?,?,?,?,?)
                    """,
                    (
                        _id("AVA"),
                        asset["id"],
                        "profile_failed" if status == "failed" else "profile_complete" if status == "profiled" else "profile_partial",
                        effective_error[:2000] or None,
                        now,
                    ),
                )
            for record in matching_records:
                url = str(record.get("url") or "").strip()
                child = normalize_asset_candidate(url)
                if child is None:
                    continue
                db.execute(
                    """
                    INSERT INTO profile_urls(
                        id,profile_task_id,url,function,technology_json,created_at
                    ) VALUES (?,?,?,?,?,?)
                    ON CONFLICT(profile_task_id,url) DO UPDATE SET
                      function=CASE
                        WHEN excluded.function IS NULL OR excluded.function='' THEN profile_urls.function
                        WHEN profile_urls.function IS NULL OR profile_urls.function='' THEN excluded.function
                        WHEN instr(profile_urls.function,excluded.function)>0 THEN profile_urls.function
                        ELSE profile_urls.function || '；' || excluded.function
                      END,
                      technology_json=excluded.technology_json
                    """,
                    (
                        _id("APU"), task["id"], url,
                        str(record.get("function") or "").strip(),
                        json.dumps(record.get("technology_stack") or [], ensure_ascii=False),
                        now,
                    ),
                )

    # ------------------------------------------------------------------
    # V7 URL 工作项：SQLite 是画像待办/派发/尝试次数/Run 栅栏的唯一权威。
    # ------------------------------------------------------------------

    _MIGRATION_NAME = "legacy_profile_state_v1"

    @staticmethod
    def _ensure_work_item(
        db: Any,
        *,
        asset_id: str,
        canonical_url: str,
        purpose: str,
        source_reason: str,
        now: str,
        initial_status: str = "pending",
        initial_attempts: int = 0,
        legacy: bool = False,
        initial_run_id: str | None = None,
    ) -> tuple[dict[str, Any], bool]:
        """Idempotently ensure one work item; returns (row, created).

        逻辑身份 = canonical_url + purpose + task_version（默认 1）。已存在的
        同身份条目不重建、不改状态（调用方按冲突规则显式处理）；来源历史
        记录进子表，多来源不生成多份同用途待办。
        """
        task = db.execute(
            "SELECT id FROM profile_tasks WHERE asset_id=?", (asset_id,),
        ).fetchone()
        if task is None:
            db.execute(
                """
                INSERT INTO profile_tasks(id,asset_id,status,attempts,created_at,updated_at)
                VALUES (?,?,'pending',0,?,?)
                """,
                (_id("APT"), asset_id, now, now),
            )
            task = db.execute(
                "SELECT id FROM profile_tasks WHERE asset_id=?", (asset_id,),
            ).fetchone()
        existing = db.execute(
            """
            SELECT * FROM profile_work_items
            WHERE canonical_url=? AND purpose=? AND task_version=1
            """,
            (canonical_url, purpose),
        ).fetchone()
        if existing is not None:
            db.execute(
                """
                INSERT INTO profile_work_item_sources(
                    work_item_id,source_reason,first_seen_at,last_seen_at
                ) VALUES (?,?,?,?)
                ON CONFLICT(work_item_id,source_reason) DO UPDATE SET
                  last_seen_at=excluded.last_seen_at
                """,
                (str(existing["id"]), source_reason, now, now),
            )
            return dict(existing), False
        item_id = _id("PWI")
        db.execute(
            """
            INSERT INTO profile_work_items(
                id,asset_id,profile_task_id,canonical_url,purpose,source_reason,status,
                task_version,attempts,last_dispatch_run_id,last_error,completed_at,
                legacy_source,created_at,updated_at
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """,
            (
                item_id, asset_id, str(task["id"]), canonical_url, purpose,
                source_reason, initial_status, 1, max(0, int(initial_attempts)),
                initial_run_id, None, None, int(legacy), now, now,
            ),
        )
        db.execute(
            """
            INSERT INTO profile_work_item_sources(
                work_item_id,source_reason,first_seen_at,last_seen_at
            ) VALUES (?,?,?,?)
            """,
            (item_id, source_reason, now, now),
        )
        row = db.execute(
            "SELECT * FROM profile_work_items WHERE id=?", (item_id,),
        ).fetchone()
        return dict(row), True

    def _ensure_asset_and_task(
        self, db: Any, candidate: NormalizedCandidate, now: str,
    ) -> str:
        """Find or bootstrap the endpoint asset (and its profile task)."""
        asset = db.execute(
            "SELECT id FROM enterprise_assets WHERE endpoint_key=?",
            (candidate.endpoint_key,),
        ).fetchone()
        if asset is None:
            asset_id = _id("EA")
            db.execute(
                """
                INSERT INTO enterprise_assets(
                    id,asset_type,endpoint_key,canonical_url,hostname,ip_address,
                    scheme,port,status,source_count,official_source,
                    authoritative_candidate_id,first_seen_at,last_seen_at,metadata_json
                ) VALUES (?,?,?,?,?,?,?,?,?,0,0,NULL,?,?,'{}')
                """,
                (
                    asset_id, candidate.candidate_kind, candidate.endpoint_key,
                    candidate.canonical_url, candidate.hostname, candidate.ip_address,
                    candidate.scheme, candidate.port, "pending_profile", now, now,
                ),
            )
            return asset_id
        return str(asset["id"])

    # -- 迁移 --------------------------------------------------------

    def ensure_profile_migration(self) -> None:
        with self.database.connect() as db:
            row = db.execute(
                "SELECT 1 FROM profile_migration_meta WHERE name=?",
                (self._MIGRATION_NAME,),
            ).fetchone()
        if row is None:
            self.migrate_legacy_profile_state()

    def migration_report(self) -> dict[str, Any]:
        with self.database.connect() as db:
            row = db.execute(
                "SELECT report_json FROM profile_migration_meta WHERE name=?",
                (self._MIGRATION_NAME,),
            ).fetchone()
        if row is None:
            return {}
        try:
            value = json.loads(str(row["report_json"] or "{}"))
        except json.JSONDecodeError:
            return {}
        return value if isinstance(value, dict) else {}

    def migrate_legacy_profile_state(self) -> dict[str, Any]:
        """Import the legacy JSON queue into URL work items (idempotent).

        应用层迁移：读 profile_state.json，走现有 URL 规范化与范围判定后写入
        SQLite；数据与完成标记在同一事务原子提交（事务回滚即整体未发生，
        重跑安全）。冲突规则见各分支注释；全部处置计入迁移报告。
        """
        from .target_profile import profile_policy, target_profile

        json_path = self.store.path / "profile_state.json"
        raw = json_path.read_text(encoding="utf-8") if json_path.exists() else None
        try:
            state = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            state = {}
        if not isinstance(state, dict):
            state = {}
        pending_urls = [str(item) for item in state.get("pending_seed_urls") or [] if str(item).strip()]
        completed_urls = [str(item) for item in state.get("completed_seed_urls") or [] if str(item).strip()]
        review_attempts = {
            str(url): int(count)
            for url, count in (state.get("needs_review_attempts") or {}).items()
            if isinstance(count, int) and count >= 0
        }
        incremental_run_id = str(state.get("incremental_attempted_run_id") or "") or None
        review_run_id = str(state.get("needs_review_attempted_run_id") or "") or None
        review_cap = max(0, int(profile_policy(self.store)["needs_review_max_attempts"]))
        # 已有画像结果（JSONL 采集记录 + SQLite profile_urls）用于判定旧
        # completed 是否有结果佐证。
        profiled_urls = {str(item.get("url") or "") for item in target_profile(self.store)}

        report: dict[str, Any] = {
            "imported_pending": 0,
            "imported_completed": 0,
            "imported_consumed": 0,
            "imported_review": 0,
            "merged": 0,
            "skipped_invalid": 0,
            "skipped_out_of_scope": 0,
            "conflicts": [],
        }
        now = now_iso()
        with self.database.connect() as db:
            existing_marker = db.execute(
                "SELECT 1 FROM profile_migration_meta WHERE name=?",
                (self._MIGRATION_NAME,),
            ).fetchone()
            if existing_marker is not None:
                return self.migration_report()
            db.execute("BEGIN IMMEDIATE")
            try:
                def ensure_item_for_url(
                    url: str, *, purpose: str, source_reason: str,
                ) -> tuple[dict[str, Any] | None, str]:
                    """Returns (item_row_or_None, disposition)."""
                    candidate = normalize_asset_candidate(url)
                    if candidate is None or not candidate.canonical_url:
                        return None, "invalid"
                    if not asset_value_in_scope(self.store, url):
                        asset = db.execute(
                            "SELECT id FROM enterprise_assets WHERE endpoint_key=?",
                            (candidate.endpoint_key,),
                        ).fetchone()
                        if asset is None:
                            return None, "out_of_scope"
                        item, created = self._ensure_work_item(
                            db,
                            asset_id=str(asset["id"]),
                            canonical_url=candidate.canonical_url,
                            purpose=purpose,
                            source_reason=source_reason,
                            now=now,
                            initial_status="dropped",
                            legacy=True,
                        )
                        if created:
                            db.execute(
                                """
                                UPDATE profile_work_items SET last_error=?
                                WHERE id=?
                                """,
                                ("迁移处置：URL 不在当前项目授权范围", item["id"]),
                            )
                        return item, "dropped_out_of_scope"
                    asset_id = self._ensure_asset_and_task(db, candidate, now)
                    item, created = self._ensure_work_item(
                        db,
                        asset_id=asset_id,
                        canonical_url=candidate.canonical_url,
                        purpose=purpose,
                        source_reason=source_reason,
                        now=now,
                        initial_status="pending",
                        legacy=True,
                    )
                    return item, "created" if created else "existing"

                for url in pending_urls:
                    item, disposition = ensure_item_for_url(
                        url, purpose="collect", source_reason="incremental",
                    )
                    if disposition == "invalid":
                        report["skipped_invalid"] += 1
                        continue
                    if disposition == "out_of_scope":
                        report["skipped_out_of_scope"] += 1
                        continue
                    if disposition == "dropped_out_of_scope":
                        report["skipped_out_of_scope"] += 1
                        continue
                    if item is None:
                        continue
                    if str(item["status"]) in {"completed", "consumed"}:
                        # 已有成功/已消费结果不被旧 pending 降级。
                        report["conflicts"].append({
                            "url": item["canonical_url"], "kind": "pending_vs_completed",
                            "resolution": "kept_existing",
                        })
                        report["merged"] += 1
                        continue
                    db.execute(
                        """
                        UPDATE profile_work_items
                        SET status='pending',last_dispatch_run_id=coalesce(?,last_dispatch_run_id),
                            updated_at=?
                        WHERE id=?
                        """,
                        (incremental_run_id, now, item["id"]),
                    )
                    report["imported_pending"] += 1

                for url in completed_urls:
                    item, disposition = ensure_item_for_url(
                        url, purpose="collect", source_reason="incremental",
                    )
                    if disposition == "invalid":
                        report["skipped_invalid"] += 1
                        continue
                    if disposition in {"out_of_scope", "dropped_out_of_scope"}:
                        report["skipped_out_of_scope"] += 1
                        continue
                    if item is None:
                        continue
                    has_result = (
                        item["canonical_url"] in profiled_urls
                        or db.execute(
                            "SELECT 1 FROM profile_urls WHERE url=?",
                            (item["canonical_url"],),
                        ).fetchone() is not None
                    )
                    final_status = "completed" if has_result else "consumed"
                    if str(item["status"]) in {"completed", "consumed"}:
                        report["merged"] += 1
                        continue
                    db.execute(
                        """
                        UPDATE profile_work_items
                        SET status=?,completed_at=CASE WHEN ?='completed' THEN ? ELSE completed_at END,
                            last_dispatch_run_id=coalesce(?,last_dispatch_run_id),updated_at=?
                        WHERE id=?
                        """,
                        (
                            final_status, final_status, now,
                            incremental_run_id, now, item["id"],
                        ),
                    )
                    if final_status == "completed":
                        report["imported_completed"] += 1
                    else:
                        report["imported_consumed"] += 1

                for url, count in review_attempts.items():
                    item, disposition = ensure_item_for_url(
                        url, purpose="review", source_reason="needs_review",
                    )
                    if disposition == "invalid":
                        report["skipped_invalid"] += 1
                        continue
                    if disposition in {"out_of_scope", "dropped_out_of_scope"}:
                        report["skipped_out_of_scope"] += 1
                        continue
                    if item is None:
                        continue
                    if str(item["status"]) == "completed":
                        report["conflicts"].append({
                            "url": item["canonical_url"], "kind": "review_vs_completed",
                            "resolution": "kept_completed",
                        })
                        continue
                    attempts = max(int(item["attempts"] or 0), count)
                    status = (
                        item["status"]
                        if str(item["status"]) in {"partial", "exhausted"}
                        else ("exhausted" if attempts >= review_cap else "pending")
                    )
                    db.execute(
                        """
                        UPDATE profile_work_items
                        SET attempts=?,status=?,last_dispatch_run_id=coalesce(?,last_dispatch_run_id),
                            updated_at=?
                        WHERE id=?
                        """,
                        (attempts, status, review_run_id, now, item["id"]),
                    )
                    report["imported_review"] += 1

                db.execute(
                    """
                    INSERT INTO profile_migration_meta(
                        name,version,completed_at,input_sha256,imported,merged,
                        skipped,conflicts,report_json
                    ) VALUES (?,1,?,?,?,?,?,?,?)
                    """,
                    (
                        self._MIGRATION_NAME, now,
                        hashlib.sha256(raw.encode("utf-8")).hexdigest() if raw else None,
                        report["imported_pending"] + report["imported_completed"]
                        + report["imported_consumed"] + report["imported_review"],
                        report["merged"],
                        report["skipped_invalid"] + report["skipped_out_of_scope"],
                        len(report["conflicts"]),
                        json.dumps(report, ensure_ascii=False),
                    ),
                )
                db.execute("COMMIT")
            except Exception:
                db.execute("ROLLBACK")
                raise
        return report

    # -- 待办查询 ------------------------------------------------------

    def _pending_work_items(
        self,
        *,
        purpose: str,
        run_id: str | None,
        limit: int,
        cap: int,
    ) -> list[dict[str, Any]]:
        """Schedulable work items.

        Run 栅栏只对增量/复核生效（run_id 非 None 时）；基础画像允许同一
        Run 多轮补充，调用方传 run_id=None。栅栏 SQL 显式处理 NULL，
        新任务（从未派发）不会被 ``NULL != :run`` 遗漏。
        """
        query = [
            """
            SELECT wi.id,wi.asset_id,wi.profile_task_id,wi.canonical_url,wi.purpose,
                   wi.source_reason,wi.status,wi.attempts,wi.legacy_source,
                   a.endpoint_key,a.hostname,a.ip_address,a.scheme,a.port,
                   a.official_source
            FROM profile_work_items wi
            JOIN enterprise_assets a ON a.id=wi.asset_id
            WHERE wi.purpose=? AND wi.status IN ('pending','partial')
              AND wi.attempts < ?
              AND a.status NOT IN ('out_of_scope','invalid','stale','duplicate')
            """
        ]
        params: list[Any] = [purpose, cap]
        if run_id is not None:
            query.append(
                " AND (wi.last_dispatch_run_id IS NULL OR wi.last_dispatch_run_id <> ?)"
            )
            params.append(run_id)
        query.append(
            " ORDER BY a.official_source DESC,a.first_seen_at,wi.canonical_url LIMIT ?"
        )
        params.append(max(0, int(limit)))
        if limit <= 0:
            return []
        with self.database.connect() as db:
            rows = [dict(row) for row in db.execute("".join(query), params).fetchall()]
        return rows

    def pending_collect_work_items(
        self, *, run_id: str | None = None, limit: int = 1000,
    ) -> list[dict[str, Any]]:
        return self._pending_work_items(
            purpose="collect", run_id=run_id, limit=limit, cap=MAX_PROFILE_ATTEMPTS,
        )

    def pending_review_work_items(
        self, *, run_id: str | None, limit: int, cap: int,
    ) -> list[dict[str, Any]]:
        return self._pending_work_items(
            purpose="review", run_id=run_id, limit=limit, cap=max(0, int(cap)),
        )

    def sync_needs_review_work_items(self) -> int:
        """Upsert review items from current needs_review assessments."""
        from .target_profile import target_assessments

        now = now_iso()
        created = 0
        with self.database.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                for assessment in target_assessments(self.store):
                    if str(assessment.get("profile_class")) != "needs_review":
                        continue
                    url = str(assessment.get("url") or "").strip()
                    candidate = normalize_asset_candidate(url)
                    if candidate is None or not candidate.canonical_url:
                        continue
                    if not asset_value_in_scope(self.store, url):
                        continue
                    asset_id = self._ensure_asset_and_task(db, candidate, now)
                    _item, was_created = self._ensure_work_item(
                        db,
                        asset_id=asset_id,
                        canonical_url=candidate.canonical_url,
                        purpose="review",
                        source_reason="needs_review",
                        now=now,
                    )
                    created += int(was_created)
                db.execute("COMMIT")
            except Exception:
                db.execute("ROLLBACK")
                raise
        return created

    def exhausted_review_urls(self) -> list[str]:
        from .target_profile import profile_policy

        cap = max(0, int(profile_policy(self.store)["needs_review_max_attempts"]))
        with self.database.connect() as db:
            rows = db.execute(
                """
                SELECT canonical_url FROM profile_work_items
                WHERE purpose='review' AND (status='exhausted' OR attempts >= ?)
                ORDER BY canonical_url
                """,
                (cap,),
            ).fetchall()
        return [str(row["canonical_url"]) for row in rows]

    def record_review_queue_count(
        self, urls: list[str], run_id: str | None = None,
    ) -> list[str]:
        """旧 mark_needs_review_queued 的 SQLite 委托：排队时记账。

        正常调度路径的计数发生在派发事务（enqueue_profile_job_atomic）；
        本方法只服务于兼容入口/测试的“排队即计数”语义。
        """
        from .target_profile import profile_policy

        cap = max(0, int(profile_policy(self.store)["needs_review_max_attempts"]))
        queued: list[str] = []
        now = now_iso()
        with self.database.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                for value in urls:
                    url = str(value or "").strip()
                    candidate = normalize_asset_candidate(url)
                    if candidate is None or not candidate.canonical_url:
                        continue
                    row = db.execute(
                        """
                        SELECT id,attempts,status FROM profile_work_items
                        WHERE canonical_url=? AND purpose='review' AND task_version=1
                        """,
                        (candidate.canonical_url,),
                    ).fetchone()
                    if row is None:
                        continue
                    db.execute(
                        """
                        UPDATE profile_work_items
                        SET attempts=attempts+1,
                            status=CASE WHEN attempts+1>=? AND status IN ('pending','partial','dispatched')
                                THEN 'exhausted' ELSE status END,
                            last_dispatch_run_id=coalesce(?,last_dispatch_run_id),
                            updated_at=?
                        WHERE id=?
                        """,
                        (cap, run_id, now, row["id"]),
                    )
                    queued.append(candidate.canonical_url)
                db.execute("COMMIT")
            except Exception:
                db.execute("ROLLBACK")
                raise
        return queued

    def add_work_items(
        self,
        values: list[object],
        *,
        purpose: str = "collect",
        source_reason: str = "incremental",
    ) -> list[str]:
        """旧 queue_incremental_profile_urls 的 SQLite 委托（单一写路径）。

        completed 的同身份条目跳过（与旧队列“已知 URL 不重复排队”一致）；
        consumed（旧队列已消费但无结果）允许重新激活补采。
        """
        added: list[str] = []
        now = now_iso()
        with self.database.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                for value in values:
                    url = str(value or "").strip()
                    candidate = normalize_asset_candidate(url)
                    if candidate is None or not candidate.canonical_url:
                        continue
                    if not asset_value_in_scope(self.store, url):
                        continue
                    asset_id = self._ensure_asset_and_task(db, candidate, now)
                    item, created = self._ensure_work_item(
                        db,
                        asset_id=asset_id,
                        canonical_url=candidate.canonical_url,
                        purpose=purpose,
                        source_reason=source_reason,
                        now=now,
                    )
                    if created:
                        added.append(candidate.canonical_url)
                        continue
                    status = str(item["status"])
                    if status == "completed":
                        continue
                    if status in {"consumed", "dropped", "exhausted"}:
                        db.execute(
                            """
                            UPDATE profile_work_items
                            SET status='pending',attempts=0,last_error=NULL,updated_at=?
                            WHERE id=?
                            """,
                            (now, item["id"]),
                        )
                        added.append(candidate.canonical_url)
                db.execute("COMMIT")
            except Exception:
                db.execute("ROLLBACK")
                raise
        return added

    def work_items_by_ids(self, work_item_ids: list[str]) -> list[dict[str, Any]]:
        if not work_item_ids:
            return []
        placeholders = ",".join("?" for _ in work_item_ids)
        with self.database.connect() as db:
            rows = [
                dict(row)
                for row in db.execute(
                    f"""
                    SELECT wi.id,wi.asset_id,wi.profile_task_id,wi.canonical_url,wi.purpose,
                           wi.source_reason,wi.status,wi.attempts,wi.legacy_source,
                           a.endpoint_key,a.hostname,a.ip_address,a.scheme,a.port,
                           a.official_source
                    FROM profile_work_items wi
                    JOIN enterprise_assets a ON a.id=wi.asset_id
                    WHERE wi.id IN ({placeholders})
                      AND wi.status IN ('pending','partial')
                      AND wi.attempts < ?
                      AND a.status NOT IN ('out_of_scope','invalid','stale','duplicate')
                    ORDER BY a.official_source DESC,a.first_seen_at,wi.canonical_url
                    """,
                    [*work_item_ids, MAX_PROFILE_ATTEMPTS],
                ).fetchall()
            ]
        return rows

    # -- 派发与结果回写 ------------------------------------------------

    @staticmethod
    def work_item_assignments(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Derive job payload assignments (one per endpoint asset) from items."""
        by_asset: dict[str, dict[str, Any]] = {}
        for item in items:
            asset_id = str(item["asset_id"])
            current = by_asset.get(asset_id)
            if current is None:
                current = {
                    "task_id": str(item["profile_task_id"]),
                    "asset_id": asset_id,
                    "endpoint_key": str(item["endpoint_key"]),
                    "seed_url": str(item["canonical_url"]),
                    "hostname": item["hostname"],
                    "ip_address": item["ip_address"],
                    "scheme": item["scheme"],
                    "port": item["port"],
                }
                by_asset[asset_id] = current
        return list(by_asset.values())

    def record_job_profile_result(
        self,
        job: dict[str, Any],
        records: list[dict[str, Any]],
        *,
        complete: bool,
        error: str | None = None,
    ) -> bool:
        """Job-keyed idempotent write-back for profile results.

        覆盖 _commit_candidates 之后处理窗口：按 job_id 唯一回执保证“业务
        结果已投影、任务状态未更新时崩溃”的恢复路径能补齐且不重复；同
        Job 的技术重试与结果重放只应用一次（端点层 attempts 也只递增一次）。
        """
        job_id = str(job.get("id") or "")
        if not job_id:
            return False
        now = now_iso()
        with self.database.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                existing = db.execute(
                    "SELECT 1 FROM profile_postprocess_receipts WHERE job_id=?",
                    (job_id,),
                ).fetchone()
                if existing is not None:
                    db.execute("COMMIT")
                    return False
                assignments = list((job.get("payload") or {}).get("profile_assignments") or [])
                self._apply_profile_result(
                    db, assignments, records, complete, error, now,
                )
                accepted_urls = set()
                for record in records:
                    candidate = normalize_asset_candidate(record.get("url"))
                    accepted_urls.add(
                        candidate.canonical_url
                        or str(record.get("url") or "").strip()
                    )
                from .target_profile import profile_policy

                review_cap = max(0, int(profile_policy(self.store)["needs_review_max_attempts"]))
                dispatched = db.execute(
                    """
                    SELECT wi.* FROM profile_work_items wi
                    JOIN profile_dispatches pd ON pd.work_item_id=wi.id
                    WHERE pd.job_id=?
                    """,
                    (job_id,),
                ).fetchall()
                finalized = 0
                for item in dispatched:
                    cap = (
                        MAX_PROFILE_ATTEMPTS
                        if str(item["purpose"]) == "collect"
                        else review_cap
                    )
                    matched = str(item["canonical_url"]) in accepted_urls
                    if error:
                        new_status = (
                            "exhausted" if int(item["attempts"] or 0) >= cap else "partial"
                        )
                    elif complete and matched:
                        new_status = "completed"
                    elif matched:
                        new_status = "partial"
                    else:
                        # kind=none / 无匹配记录：不能当作成功画像。
                        new_status = (
                            "exhausted" if int(item["attempts"] or 0) >= cap else "partial"
                        )
                    db.execute(
                        """
                        UPDATE profile_work_items
                        SET status=?,last_error=?,completed_at=?,
                            last_dispatch_job_id=?,updated_at=?
                        WHERE id=?
                        """,
                        (
                            new_status,
                            str(error or "").strip()[:2000] or None,
                            now if new_status == "completed" else None,
                            job_id, now, item["id"],
                        ),
                    )
                    finalized += 1
                db.execute(
                    """
                    INSERT INTO profile_postprocess_receipts(job_id,processed_at,summary_json)
                    VALUES (?,?,?)
                    """,
                    (
                        job_id, now,
                        json.dumps({
                            "assignments": len(assignments),
                            "records": len(records),
                            "work_items": finalized,
                            "complete": bool(complete),
                            "error": str(error or "").strip()[:500] or None,
                        }, ensure_ascii=False),
                    ),
                )
                db.execute("COMMIT")
                return True
            except Exception:
                db.execute("ROLLBACK")
                raise

    def recover_profile_postprocess(self, database: Any = None) -> int:
        """Re-run postprocess for committed profile jobs missing receipts.

        恢复依据是**成功投影**而非“候选已被消费”：只有存在 commit event 且
        该事件 status='committed' 的 Job 才允许补跑后处理。被人工指令栅栏
        拒绝、被 stop_run 丢弃或仍在投影中的候选（mark_job_committed 也会
        写 committed_at，但没有提交事件）不得在恢复中重新生效。
        记录来源是提交事件冻结的**已过滤载荷**（worker_payload），不是
        Job 原始结果。
        """
        db = database or self.database
        rows = db.list_all_jobs()
        recovered = 0
        for job in rows:
            if str(job.get("stage")) not in {"profile", "profile_incremental"}:
                continue
            if job.get("status") != "completed" or not job.get("committed_at"):
                continue
            commit_event_id = str(job.get("commit_event_id") or "")
            if not commit_event_id:
                # 无提交事件 = 候选被拒绝/丢弃，而不是成功投影。
                continue
            with self.database.connect() as conn:
                event_row = conn.execute(
                    """
                    SELECT payload_json,status FROM commit_events WHERE event_id=?
                    """,
                    (commit_event_id,),
                ).fetchone()
                done = conn.execute(
                    "SELECT 1 FROM profile_postprocess_receipts WHERE job_id=?",
                    (str(job["id"]),),
                ).fetchone()
            if done is not None:
                continue
            if event_row is None or str(event_row["status"]) != "committed":
                # 事件被丢弃或尚未投影完成：等待投影路径处理，不在恢复中生效。
                continue
            try:
                event_payload = json.loads(str(event_row["payload_json"]))
            except json.JSONDecodeError:
                continue
            worker_payload = event_payload.get("worker_payload")
            if not isinstance(worker_payload, dict):
                continue
            records = (
                worker_payload.get("records")
                if isinstance(worker_payload.get("records"), list) else []
            )
            complete = bool(worker_payload.get("exploration_complete", False))
            if self.record_job_profile_result(
                job, records, complete=complete, error=None,
            ):
                recovered += 1
        return recovered
