"""DOM 契约测试：确保 app.js 及 modules 中所有静态 DOM 引用在 index.html 中存在。

上次事故（5 个 ID 缺失导致白屏）以后不会再被漏检——每次改 HTML 或 JS 后
跑全量测试，本文件会在 collection 阶段就报出断裂引用。
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "frontend"

INDEX_HTML = (FRONTEND / "index.html").read_text(encoding="utf-8")
HTML_IDS = set(re.findall(r'id="([^"]+)"', INDEX_HTML))

# 收集 app.js + modules/*.js 中所有 $("id") 形式的静态引用
JS_FILES = sorted(FRONTEND.glob("*.js")) + sorted((FRONTEND / "modules").glob("*.js"))
ALL_JS = "\n".join(f.read_text(encoding="utf-8") for f in JS_FILES)
JS_IDS = set(re.findall(r'\$\("([^"]+)"\)', ALL_JS))

# 排除动态拼接的引用（包含 ${ 或 ' + 的不算）
DYNAMIC_PATTERN = re.compile(r'\$\("(?:[^"]*\$\{[^"]*)"\)')


def test_no_missing_dom_ids() -> None:
    missing = sorted(JS_IDS - HTML_IDS)
    assert not missing, (
        f"app.js 引用了 {len(missing)} 个 index.html 中不存在的 id：{missing}。"
        "请在 HTML 中添加对应节点，或移除无效引用。"
    )


def test_no_duplicate_ids_in_html() -> None:
    from collections import Counter
    ids = re.findall(r'id="([^"]+)"', INDEX_HTML)
    dupes = [(id_, count) for id_, count in Counter(ids).items() if count > 1]
    assert not dupes, f"index.html 中存在重复 id：{dupes}"


def test_no_inline_font_size_on_headings() -> None:
    """页面标题不应被行内 font-size 覆盖，排版由 CSS 统一控制。"""
    violations = re.findall(r'<h[12][^>]*style="[^"]*font-size', INDEX_HTML)
    assert not violations, f"发现行内 font-size 覆盖标题：{violations}"


def test_no_undefined_css_variables() -> None:
    """检查 CSS 中使用的 --s-* 变量是否都有定义。"""
    css = (FRONTEND / "styles.css").read_text(encoding="utf-8")
    defined = set(re.findall(r'(--s-[\w-]+)\s*:', css))
    used = set(re.findall(r'var\((--s-[\w-]+)', css))
    undefined = sorted(used - defined)
    assert not undefined, f"CSS 中使用了未定义的变量：{undefined}"


def test_color_scheme_matches_layout() -> None:
    """工作区是暖白，color-scheme 应为 light。"""
    assert "color-scheme: light" in css_content(), (
        "color-scheme 应为 light 以匹配暖白工作区"
    )


def css_content() -> str:
    return (FRONTEND / "styles.css").read_text(encoding="utf-8")
