"""前端安全契约：渲染只走 textContent、无 innerHTML 注入用户数据、错误可展示。"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FRONTEND = ROOT / "frontend"
INDEX_HTML = (FRONTEND / "index.html").read_text(encoding="utf-8")
APP_JS = (FRONTEND / "app.js").read_text(encoding="utf-8")
MODULE_FILES = sorted((FRONTEND / "modules").glob("*.js"))
MODULES_JS = {path.name: path.read_text(encoding="utf-8") for path in MODULE_FILES}
ALL_JS = APP_JS + "\n" + "\n".join(MODULES_JS.values())

# app.js:2094 是唯一 innerHTML：仅用静态 ICONS 字典填 SVG 图标，不含用户数据。
STATIC_ICON_LINE = re.compile(r'node\.innerHTML = ICONS\[node\.dataset\.icon\] \|\| ""')


def test_no_innerhtml_with_uncontrolled_data() -> None:
    sinks = [f"{name}:{i + 1}: {line.strip()}"
             for name, text in [("app.js", APP_JS), *MODULES_JS.items()]
             for i, line in enumerate(text.splitlines())
             if re.search(r"\binnerHTML\b|\binsertAdjacentHTML\b|\bdocument\.write\b|\bouterHTML\b", line)]
    violations = [sink for sink in sinks if not STATIC_ICON_LINE.search(sink)]
    assert not violations, f"存在未经 textContent 的 HTML 注入点：{violations}"


def test_icon_map_is_static_literal() -> None:
    """唯一 innerHTML 的数据源 ICONS 必须是纯静态 SVG 字面量（定义在 modules/ui.js）。"""
    ui_js = MODULES_JS["ui.js"]
    start = ui_js.index("ICONS")
    start = ui_js.index("{", start)
    end = ui_js.index("\n};", start)
    block = ui_js[start:end]
    assert "<svg" in block
    # 不允许模板插值或运行时拼接进入图标 HTML
    assert "${" not in block
    assert "=>" not in block


def test_dom_helper_renders_text_content() -> None:
    dom_js = MODULES_JS["dom.js"]
    assert "if (text != null) node.textContent = text;" in dom_js
    # 工厂函数 el() 只设置 className/textContent，不触碰 HTML
    assert "innerHTML" not in dom_js


def test_toast_renders_error_via_text_content() -> None:
    dom_js = MODULES_JS["dom.js"]
    assert "toast.textContent = message;" in dom_js


def test_api_errors_are_parsed_and_thrown() -> None:
    """api() 必须解析 JSON 并把 error 字段抛给 UI 展示。"""
    api_js = MODULES_JS["api.js"]
    assert "JSON.parse(raw)" in api_js
    assert "throw new Error(payload.error" in api_js


def test_index_html_has_no_inline_script_handlers() -> None:
    """静态 HTML 不应携带内联事件处理器（onclick= 等是最直接的 XSS 面）。"""
    inline = re.findall(r'on(?:click|error|load|mouseover|submit|input|change)=', INDEX_HTML)
    assert not inline, f"index.html 含内联事件处理器：{inline}"


def test_dashboard_link_in_index_uses_static_markup() -> None:
    """index.html 中 <script> 只允许引入本地静态资源。"""
    scripts = re.findall(r"<script[^>]*src=\"([^\"]+)\"", INDEX_HTML)
    assert scripts, "index.html 应引用 app.js"
    for src in scripts:
        assert not re.match(r"^[a-z]+://", src), f"不允许外链脚本：{src}"
