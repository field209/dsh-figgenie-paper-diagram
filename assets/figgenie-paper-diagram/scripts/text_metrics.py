"""Text metrics for the SVG -> draw.io converter.

The preview pipeline rasterises the SVG in Chromium, so Chromium is also the
authority on how wide a label actually is.  Measuring there keeps the draw.io
label boxes the same size as the picture the author already approved, instead
of guessing 0.55em per latin glyph.

Backends, best first:

1. ``chromium`` - one headless page, canvas ``measureText`` per string.  Exact,
   including font fallback (Inter -> system sans, CJK -> sans-serif) and bold.
2. ``fonttools`` - resolve the family to a real TTF and sum advance widths.
   Good for latin faces, misses fallback chains.
3. ``heuristic`` - the old em-width estimate.  Never raises, always available.

Every backend returns ``(width, ascent, descent)`` in user units, so callers
can size and baseline a label box without extra arithmetic.
"""

from __future__ import annotations

import os
import subprocess
import sys
from functools import lru_cache
from pathlib import Path

CJK_RANGES = ((0x1100, 0x115F), (0x2E80, 0xA4CF), (0xAC00, 0xD7A3),
              (0xF900, 0xFAFF), (0xFE30, 0xFE4F), (0xFF00, 0xFF60),
              (0xFFE0, 0xFFE6), (0x1F300, 0x1F64F))
WIDE_PUNCT = "，。、；：（）【】《》“”‘’…—"


def _is_wide(char: str) -> bool:
    code = ord(char)
    return char in WIDE_PUNCT or any(low <= code <= high for low, high in CJK_RANGES)


def _heuristic(text: str, size: float, weight: str) -> tuple[float, float, float]:
    factor = 0.62 if weight in ("bold", "600", "700", "800", "900", "bolder") else 0.55
    width = sum(size * (1.0 if _is_wide(c) else factor) for c in text)
    return width, size * 0.75, size * 0.25


# -- backend 1: chromium ---------------------------------------------------

_CHROMIUM_SCRIPT = r"""
import json, sys
from playwright.sync_api import sync_playwright

payload = json.load(sys.stdin)
with sync_playwright() as play:
    browser = play.chromium.launch(args=["--no-sandbox", "--disable-dev-shm-usage"])
    page = browser.new_page()
    page.set_content("<html><body></body></html>")
    result = page.evaluate(
        '''(items) => {
            const ctx = document.createElement('canvas').getContext('2d');
            return items.map(([text, size, weight, family]) => {
                const quoted = family.split(',').map(f => '"' + f.trim() + '"').join(', ');
                ctx.font = weight + ' ' + size + 'px ' + quoted + ', sans-serif';
                const m = ctx.measureText(text);
                return [m.width, m.actualBoundingBoxAscent, m.actualBoundingBoxDescent];
            });
        }''',
        payload,
    )
    browser.close()
print(json.dumps(result))
"""


class TextMetrics:
    def __init__(self, prefer: str = "auto"):
        self.backend = "heuristic"
        self.cache: dict[tuple, tuple[float, float, float]] = {}
        self._browser_ready = False
        if prefer == "auto":
            if self._probe_chromium():
                self.backend = "chromium"
            elif self._probe_fonttools():
                self.backend = "fonttools"
        elif prefer == "chromium" and self._probe_chromium():
            self.backend = "chromium"
        elif prefer == "fonttools" and self._probe_fonttools():
            self.backend = "fonttools"

    # -- probing ---------------------------------------------------------
    def _probe_chromium(self) -> bool:
        if os.environ.get("FIGGENIE_NO_BROWSER"):
            return False
        try:
            import playwright.sync_api  # noqa: F401
        except Exception:
            return False
        self._browser_ready = True
        return True

    def _probe_fonttools(self) -> bool:
        try:
            from PIL import ImageFont  # noqa: F401
        except Exception:
            return False
        return True

    # -- batch measurement ----------------------------------------------
    def prewarm(self, items: list[tuple[str, float, str, str]]) -> None:
        """Measure every label once, in a single browser round-trip."""
        todo = []
        for text, size, weight, family in items:
            key = (text, round(size, 2), weight, family)
            if key in self.cache or key in todo:
                continue
            todo.append(key)
        if not todo:
            return
        if self.backend == "chromium":
            try:
                payload = [[t, s, w, f] for (t, s, w, f) in todo]
                import json
                proc = subprocess.run(
                    [sys.executable, "-c", _CHROMIUM_SCRIPT],
                    input=json.dumps(payload).encode("utf-8"),
                    capture_output=True, timeout=180,
                )
                if proc.returncode == 0:
                    rows = json.loads(proc.stdout.decode("utf-8").strip().splitlines()[-1])
                    for key, row in zip(todo, rows):
                        width, ascent, descent = (float(v) for v in row)
                        if width > 0:
                            self.cache[key] = (width, ascent or key[1] * 0.75,
                                               descent or key[1] * 0.25)
                else:
                    self.backend = "fonttools" if self._probe_fonttools() else "heuristic"
            except Exception:
                self.backend = "fonttools" if self._probe_fonttools() else "heuristic"
        for key in todo:
            if key not in self.cache:
                self.cache[key] = self._measure_one(*key)

    def _measure_one(self, text, size, weight, family):
        if self.backend == "fonttools":
            try:
                from PIL import ImageFont
                font = self._font(family, weight)
                if font is not None:
                    width = font.getlength(text) * size / self._unit(family, weight)
                    return width, size * 0.75, size * 0.25
            except Exception:
                pass
        return _heuristic(text, size, weight)

    # -- pillow helpers ---------------------------------------------------
    _FONT_FILES = {
        "arial": ("arial.ttf", "arialbd.ttf"),
        "helvetica": ("arial.ttf", "arialbd.ttf"),
        "helvetica neue": ("arial.ttf", "arialbd.ttf"),
        "inter": ("segoeui.ttf", "segoeuib.ttf"),
        "segoe ui": ("segoeui.ttf", "segoeuib.ttf"),
        "roboto": ("segoeui.ttf", "segoeuib.ttf"),
        "dejavu sans": ("DejaVuSans.ttf", "DejaVuSans-Bold.ttf"),
        "calibri": ("calibri.ttf", "calibrib.ttf"),
        "cambria": ("cambria.ttc", "cambriab.ttf"),
        "times new roman": ("times.ttf", "timesbd.ttf"),
        "courier new": ("cour.ttf", "courbd.ttf"),
        "consolas": ("consola.ttf", "consolab.ttf"),
    }
    _CJK_FILES = ("msyh.ttc", "simhei.ttf", "simsun.ttc", "NotoSansCJK-Regular.ttc")

    def _font(self, family, weight):
        from PIL import ImageFont
        bold = weight in ("bold", "600", "700", "800", "900", "bolder")
        regular, heavy = self._FONT_FILES.get(family.strip().lower(), (None, None))
        names = [heavy if bold else regular, regular, *self._CJK_FILES]
        roots = [Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts", Path("/usr/share/fonts")]
        for name in names:
            if not name:
                continue
            for root in roots:
                path = root / name
                if path.is_file():
                    return ImageFont.truetype(str(path), 100)
        return None

    @lru_cache(maxsize=None)
    def _unit(self, family, weight):
        return 100.0  # we loaded the font at 100px, so lengths come out at 100px

    # -- public -----------------------------------------------------------
    def measure(self, text: str, size: float, weight: str, family: str):
        key = (text, round(size, 2), weight, family)
        if key not in self.cache:
            self.cache[key] = self._measure_one(*key)
        return self.cache[key]
