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
        return result

    def prepare_run(self) -> None:
        """Release incomplete profile tasks once at the start of a new Run.

        Failed or partial tasks must not be selected again inside the same controller
        loop, otherwise a persistently failing endpoint creates an unbounded
        incremental-profile cycle. A new user-started Run is the retry fence.
        """
        now = now_iso()
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
        return {
            "total": int(totals["assets"]),
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
                db.execute("COMMIT")
            except Exception:
                db.execute("ROLLBACK")
                raise
