from __future__ import annotations

from collections import defaultdict
from io import BytesIO
from urllib.parse import urlsplit
from xml.sax.saxutils import escape, quoteattr
from zipfile import ZIP_DEFLATED, ZipFile


_INVALID_SHEET_NAME = str.maketrans({char: " " for char in "[]:*?/\\"})


def profile_hostname(url: object) -> str:
    try:
        return (urlsplit(str(url or "")).hostname or "未知主机").casefold()
    except ValueError:
        return "未知主机"


def group_profile_by_hostname(rows: list[dict]) -> list[tuple[str, list[dict]]]:
    grouped: dict[str, list[dict]] = defaultdict(list)
    for row in rows:
        grouped[profile_hostname(row.get("url"))].append(row)
    return [
        (hostname, sorted(items, key=lambda item: str(item.get("url") or "").casefold()))
        for hostname, items in sorted(grouped.items(), key=lambda item: item[0])
    ]


def _sheet_names(hostnames: list[str]) -> list[str]:
    names: list[str] = []
    used: set[str] = set()
    for hostname in hostnames:
        base = " ".join(hostname.translate(_INVALID_SHEET_NAME).split()).strip("' ") or "未知主机"
        base = base[:31]
        candidate = base
        sequence = 2
        while candidate.casefold() in used:
            suffix = f" ({sequence})"
            candidate = f"{base[:31 - len(suffix)]}{suffix}"
            sequence += 1
        used.add(candidate.casefold())
        names.append(candidate)
    return names


def _inline_cell(reference: str, value: object, style: int) -> str:
    text = escape(str(value or ""))
    return (
        f'<c r="{reference}" s="{style}" t="inlineStr">'
        f"<is><t xml:space=\"preserve\">{text}</t></is></c>"
    )


def _worksheet_xml(rows: list[dict]) -> tuple[str, str | None]:
    body = [
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
        '<sheetViews><sheetView workbookViewId="0">'
        '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'
        '</sheetView></sheetViews>',
        '<cols><col min="1" max="1" width="64" customWidth="1"/>'
        '<col min="2" max="2" width="32" customWidth="1"/>'
        '<col min="3" max="3" width="32" customWidth="1"/>'
        '<col min="4" max="5" width="20" customWidth="1"/>'
        '<col min="6" max="6" width="18" customWidth="1"/>'
        '<col min="7" max="7" width="14" customWidth="1"/>'
        '<col min="8" max="8" width="48" customWidth="1"/>'
        '<col min="9" max="10" width="18" customWidth="1"/>'
        '<col min="11" max="11" width="30" customWidth="1"/>'
        '<col min="12" max="13" width="48" customWidth="1"/></cols>',
        '<sheetData><row r="1" ht="24" customHeight="1">',
        _inline_cell("A1", "URL", 1),
        _inline_cell("B1", "功能", 1),
        _inline_cell("C1", "技术", 1),
        _inline_cell("D1", "版本", 1),
        _inline_cell("E1", "类别", 1),
        _inline_cell("F1", "验证状态", 1),
        _inline_cell("G1", "置信度", 1),
        _inline_cell("H1", "证据路径", 1),
        _inline_cell("I1", "目标评分", 1),
        _inline_cell("J1", "目标分类", 1),
        _inline_cell("K1", "风险标签", 1),
        _inline_cell("L1", "评分依据", 1),
        _inline_cell("M1", "建议测试", 1),
        "</row>",
    ]
    hyperlinks: list[str] = []
    relationships: list[str] = []
    for index, item in enumerate(rows, start=2):
        url = str(item.get("url") or "")
        technologies = item.get("technologies") or []
        if not isinstance(technologies, list):
            technologies = []
        if not technologies:
            legacy = item.get("technology_stack") or []
            if not isinstance(legacy, list):
                legacy = [legacy]
            technologies = [
                {
                    "technology": value,
                    "version": "",
                    "category": "other",
                    "verification_status": "reported",
                    "confidence": None,
                    "evidence_paths": [],
                }
                for value in legacy if value
            ]
        names = "; ".join(str(value.get("technology") or "") for value in technologies if value.get("technology"))
        versions = "; ".join(str(value.get("version") or "") for value in technologies if value.get("version"))
        categories = "; ".join(dict.fromkeys(
            str(value.get("category") or "other") for value in technologies
        ))
        statuses = "; ".join(dict.fromkeys(
            str(value.get("verification_status") or "reported") for value in technologies
        ))
        confidences = "; ".join(
            "" if value.get("confidence") is None else f"{float(value['confidence']):.2f}"
            for value in technologies
        )
        evidence = "; ".join(dict.fromkeys(
            str(path)
            for value in technologies
            for path in (value.get("evidence_paths") or [])
            if path
        ))
        body.extend([
            f'<row r="{index}">',
            _inline_cell(f"A{index}", url, 2),
            _inline_cell(f"B{index}", item.get("function") or "未说明", 0),
            _inline_cell(f"C{index}", names, 0),
            _inline_cell(f"D{index}", versions, 0),
            _inline_cell(f"E{index}", categories, 0),
            _inline_cell(f"F{index}", statuses, 0),
            _inline_cell(f"G{index}", confidences, 0),
            _inline_cell(f"H{index}", evidence, 0),
            _inline_cell(f"I{index}", "" if item.get("target_score") is None else item.get("target_score"), 0),
            _inline_cell(f"J{index}", item.get("profile_class") or "needs_review", 0),
            _inline_cell(f"K{index}", "; ".join(item.get("risk_tags") or []), 0),
            _inline_cell(f"L{index}", item.get("score_reason") or "", 0),
            _inline_cell(f"M{index}", "; ".join(item.get("recommended_tests") or []), 0),
            "</row>",
        ])
        if url.startswith(("http://", "https://")):
            relation_id = f"rId{len(relationships) + 1}"
            hyperlinks.append(f'<hyperlink ref="A{index}" r:id="{relation_id}"/>')
            relationships.append(
                f'<Relationship Id="{relation_id}" '
                'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" '
                f'Target={quoteattr(url)} TargetMode="External"/>'
            )
    body.append("</sheetData>")
    if rows:
        body.append(f'<autoFilter ref="A1:M{len(rows) + 1}"/>')
    if hyperlinks:
        body.append("<hyperlinks>" + "".join(hyperlinks) + "</hyperlinks>")
    body.append("</worksheet>")
    relations_xml = None
    if relationships:
        relations_xml = (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            + "".join(relationships)
            + "</Relationships>"
        )
    return "".join(body), relations_xml


def build_profile_workbook(rows: list[dict]) -> bytes:
    groups = group_profile_by_hostname(rows)
    if not groups:
        raise ValueError("当前没有可导出的目标画像")
    sheet_names = _sheet_names([hostname for hostname, _items in groups])
    workbook_sheets = "".join(
        f'<sheet name={quoteattr(name)} sheetId="{index}" r:id="rId{index}"/>'
        for index, name in enumerate(sheet_names, start=1)
    )
    workbook_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        f"<sheets>{workbook_sheets}</sheets></workbook>"
    )
    workbook_rels = "".join(
        f'<Relationship Id="rId{index}" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" '
        f'Target="worksheets/sheet{index}.xml"/>'
        for index in range(1, len(groups) + 1)
    )
    workbook_rels += (
        f'<Relationship Id="rId{len(groups) + 1}" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" '
        'Target="styles.xml"/>'
    )
    content_overrides = "".join(
        f'<Override PartName="/xl/worksheets/sheet{index}.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        for index in range(1, len(groups) + 1)
    )
    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/xl/workbook.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        '<Override PartName="/xl/styles.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
        f"{content_overrides}</Types>"
    )
    styles = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        '<fonts count="3"><font><sz val="11"/><name val="Arial"/></font>'
        '<font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Arial"/></font>'
        '<font><u/><color rgb="FF2563EB"/><sz val="11"/><name val="Arial"/></font></fonts>'
        '<fills count="3"><fill><patternFill patternType="none"/></fill>'
        '<fill><patternFill patternType="gray125"/></fill>'
        '<fill><patternFill patternType="solid"><fgColor rgb="FF2563EB"/>'
        '<bgColor indexed="64"/></patternFill></fill></fills>'
        '<borders count="2"><border/><border><bottom style="thin">'
        '<color rgb="FFD9E1EA"/></bottom></border></borders>'
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
        '<cellXfs count="3">'
        '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyAlignment="1">'
        '<alignment vertical="top" wrapText="1"/></xf>'
        '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyAlignment="1">'
        '<alignment vertical="center"/></xf>'
        '<xf numFmtId="0" fontId="2" fillId="0" borderId="1" xfId="0" applyAlignment="1">'
        '<alignment vertical="top" wrapText="1"/></xf>'
        '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/>'
        '</cellStyles></styleSheet>'
    )
    output = BytesIO()
    with ZipFile(output, "w", ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", content_types)
        archive.writestr(
            "_rels/.rels",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" '
            'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
            'Target="xl/workbook.xml"/></Relationships>',
        )
        archive.writestr("xl/workbook.xml", workbook_xml)
        archive.writestr(
            "xl/_rels/workbook.xml.rels",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            f"{workbook_rels}</Relationships>",
        )
        archive.writestr("xl/styles.xml", styles)
        for index, (_hostname, items) in enumerate(groups, start=1):
            sheet_xml, relations_xml = _worksheet_xml(items)
            archive.writestr(f"xl/worksheets/sheet{index}.xml", sheet_xml)
            if relations_xml:
                archive.writestr(f"xl/worksheets/_rels/sheet{index}.xml.rels", relations_xml)
    return output.getvalue()
