"""DOM 契约扩展测试：app.js + modules/*.js 的静态 DOM 引用必须在 index.html 存在且唯一。"""
from __future__ import annotations

import re
from collections import Counter
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
FRONTEND = ROOT / "frontend"
INDEX_HTML = (FRONTEND / "index.html").read_text(encoding="utf-8")
HTML_IDS = set(re.findall(r'id="([^"]+)"', INDEX_HTML))

JS_FILES = sorted(FRONTEND.glob("*.js")) + sorted((FRONTEND / "modules").glob("*.js"))
ALL_JS_BY_FILE = {path: path.read_text(encoding="utf-8") for path in JS_FILES}
ALL_JS = "\n".join(ALL_JS_BY_FILE.values())


def _static_literal_ids(source: str) -> set[str]:
    """收集 $("id") 与 document.getElementById("id") 的静态字面量引用。

    排除动态拼接（含 ${ 或 ' + ）的引用——它们不是静态契约。
    """
    ids: set[str] = set()
    for match in re.findall(r'\$\("([^"]+)"\)', source):
        if "${" not in match:
            ids.add(match)
    for match in re.findall(r'getElementById\("([^"]+)"\)', source):
        if "${" not in match:
            ids.add(match)
    return ids


def test_all_getelementby_id_references_exist() -> None:
    per_file = {path.name: _static_literal_ids(text) for path, text in ALL_JS_BY_FILE.items()}
    missing = {
        name: sorted(ids - HTML_IDS)
        for name, ids in per_file.items()
        if ids - HTML_IDS
    }
    assert not missing, f"JS 静态 DOM 引用在 index.html 中缺失：{missing}"


def test_no_duplicate_ids_in_index_html() -> None:
    dupes = [(id_, count) for id_, count in Counter(re.findall(r'id="([^"]+)"', INDEX_HTML)).items() if count > 1]
    assert not dupes, f"index.html 存在重复 id：{dupes}"


def test_modules_dom_references_covered() -> None:
    """modules/ 下每个模块单独校验，报错能定位到具体文件。"""
    module_files = sorted((FRONTEND / "modules").glob("*.js"))
    assert module_files, "frontend/modules 不应为空"
    for path in module_files:
        ids = _static_literal_ids(path.read_text(encoding="utf-8"))
        missing = sorted(ids - HTML_IDS)
        assert not missing, f"{path.name} 引用了 index.html 缺失的 id：{missing}"


def _finding_tab_config_keys() -> set[str]:
    block = re.search(r"const FINDING_TAB_CONFIG = \{(.*?)\n\};", ALL_JS, re.S)
    assert block, "app.js 中找不到 FINDING_TAB_CONFIG 定义"
    return set(re.findall(r"^  (\w+): \{", block.group(1), re.M))


def _clear_tab_values() -> set[str]:
    return set(re.findall(r'data-clear-tab="([^"]+)"', INDEX_HTML))


def _finding_filter_state_keys() -> set[str]:
    block = re.search(r"findingFilters: \{(.*?)\n  \},", ALL_JS, re.S)
    assert block, "state.js 中找不到 findingFilters 定义"
    return set(re.findall(r"^    (\w+): \{", block.group(1), re.M))


def test_clear_tab_values_match_finding_tab_config() -> None:
    """已知缺陷：index.html 攻击面页签写成 surfaces（复数），
    而 FINDING_TAB_CONFIG / findingFilters 的键是 surface（单数），
    导致清除筛选按钮永远不显示、即使点击也因 filters 未定义而失效。
    """
    config_keys = _finding_tab_config_keys()
    filter_keys = _finding_filter_state_keys()
    assert config_keys == filter_keys, f"FINDING_TAB_CONFIG 与 findingFilters 键失配：{config_keys} vs {filter_keys}"
    assert _clear_tab_values() == config_keys, (
        f"data-clear-tab 值 {sorted(_clear_tab_values())} 与 FINDING_TAB_CONFIG 键 {sorted(config_keys)} 失配"
    )


def test_surface_clear_tab_button_is_reachable() -> None:
    """契约层面复现：渲染查询选择器必须能命中 index.html 中的按钮。"""
    config_keys = _finding_tab_config_keys()
    values = _clear_tab_values()
    # 渲染与点击都以 config 键拼选择器；surfaces 按钮两边都对不上即不可达。
    for key in config_keys:
        assert key in values, f"FINDING_TAB_CONFIG 键 {key} 没有 data-clear-tab 匹配，清除筛选按钮不可达"
