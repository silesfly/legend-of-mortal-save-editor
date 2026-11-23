#!/usr/bin/env python3
"""Bundler for 활협전 세이브 에디터 v1.0.1 (zero-dependency)."""
import argparse
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC_HTML = ROOT / "src" / "editor-page.html"
SRC_DIR = ROOT / "src"
DIST_HTML = ROOT / "dist" / "LegendOfMortalSaveEditor-v1.0.1.html"
JS_FILES = ["nrbf-codec.js", "catalog-data.js", "editor-core.js", "editor-ui.js"]

HANZI_RE = re.compile(r"[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]")
KANA_RE = re.compile(r"[\u3040-\u30FF]")
URL_RE = re.compile(r"https?://")
SIMPLE_TAG_RE = re.compile(r"<script\b", re.IGNORECASE)
CLOSE_TAG_RE = re.compile(r"</script\s*>", re.IGNORECASE)
SCRIPT_BLOCK_RE = re.compile(r"<script\b[^>]*>(.*?)</script\s*>", re.IGNORECASE | re.DOTALL)


class BuildError(Exception):
    """Build or verification failure."""


def inline_scripts(html):
    """Inline each JS_FILES reference; replace `</script` safely via lambda."""
    result = html
    for name in JS_FILES:
        js_path = SRC_DIR / name
        if not js_path.is_file():
            raise BuildError(f"소스 파일을 찾을 수 없습니다: {js_path}")
        js_text = js_path.read_text(encoding="utf-8").replace("</script", "<\\/script")
        pattern = re.compile(
            r'<script\s+src="' + re.escape(name) + r'"\s*>\s*</script\s*>',
            re.IGNORECASE,
        )
        replacement = "<script>\n" + js_text + "\n</script>"
        result, count = pattern.subn(lambda _m, r=replacement: r, result)
        if count != 1:
            raise BuildError(f"{name}: script 태그 {count}개 발견 (1개여야 함)")
    return result


def verify(bundled):
    errors = []
    if re.search(r'<script\b[^>]*\bsrc\s*=', bundled, re.IGNORECASE):
        errors.append("외부 <script src= 태그가 남아 있습니다.")
    if re.search(r'<link\b[^>]*\brel\s*=\s*["\']stylesheet["\']', bundled, re.IGNORECASE):
        errors.append('외부 <link rel="stylesheet"> 태그가 남아 있습니다.')
    if "default-src 'none'" not in bundled:
        errors.append("CSP에 default-src 'none'이 없습니다.")
    if "connect-src 'none'" not in bundled:
        errors.append("CSP에 connect-src 'none'이 없습니다.")

    for label, rx in (("한자", HANZI_RE), ("일본어 가나", KANA_RE), ("외부 URL", URL_RE)):
        m = rx.search(bundled)
        if m:
            ctx = bundled[max(0, m.start() - 20):m.start() + 20]
            errors.append(f"{label} 검출: {ctx!r}")

    opens = len(SIMPLE_TAG_RE.findall(bundled))
    closes = len(CLOSE_TAG_RE.findall(bundled))
    if opens != closes:
        errors.append(f"script 태그 쌍 불일치: open={opens}, close={closes}")
    for body in SCRIPT_BLOCK_RE.findall(bundled):
        if "</script" in body.lower():
            errors.append("script 본문 내부에 </script 시퀀스가 남아 있습니다.")
            break

    if errors:
        raise BuildError("\n".join(errors))


def atomic_write(target, text):
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(target.name + f".tmp.{os.getpid()}")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, target)


def main():
    parser = argparse.ArgumentParser(description="활협전 세이브 에디터 단일 HTML 번들러")
    parser.add_argument("--check", action="store_true", help="기존 산출물 또는 새로 빌드한 결과를 검증")
    args = parser.parse_args()

    try:
        if args.check and DIST_HTML.is_file():
            existing = DIST_HTML.read_text(encoding="utf-8")
            verify(existing)
            print(f"[기존 산출물] 검증 통과 — {DIST_HTML.stat().st_size:,} 바이트")
            return 0
        if not SRC_HTML.is_file():
            raise BuildError(f"템플릿을 찾을 수 없습니다: {SRC_HTML}")
        bundled = inline_scripts(SRC_HTML.read_text(encoding="utf-8"))
        verify(bundled)
        atomic_write(DIST_HTML, bundled)
        print(f"[빌드 완료] {DIST_HTML} ({DIST_HTML.stat().st_size:,} 바이트)")
        return 0
    except BuildError as exc:
        sys.stderr.write(f"[빌드 오류]\n{exc}\n")
        return 1


if __name__ == "__main__":
    sys.exit(main())
