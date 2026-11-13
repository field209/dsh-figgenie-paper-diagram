#!/usr/bin/env python3
"""SVG -> .drawio: an editable diagram file instead of a flat picture.

Every primitive that draw.io models natively becomes a real cell -- rectangles,
rounded rectangles, ellipses, straight arrows and text -- so the result can be
re-laid out, recoloured and retyped in draw.io / diagrams.net. Curves, paths and
bitmaps cannot be expressed as native cells without losing their shape, so those
elements are embedded as small inline-SVG image cells: still selectable and
scalable, but not node-editable.

Groups mirror the figure contract: a ``<g id="n:...">`` element becomes a draw.io
group whose children keep their relative arrangement.

    svg2drawio.py fig.svg -o fig.drawio
    svg2drawio.py fig.svg -o fig.drawio --compressed   # base64 + deflate payload

Requires lxml only.
"""

from __future__ import annotations

import argparse
import base64
import math
import re
import sys
import zlib
from pathlib import Path
from urllib.parse import unquote, urlparse
from xml.sax.saxutils import escape, quoteattr

from lxml import etree

SVG_NS = "http://www.w3.org/2000/svg"
XLINK_NS = "http://www.w3.org/1999/xlink"
NSMAP = {"svg": SVG_NS, "xlink": XLINK_NS}

IDENT = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)  # a, b, c, d, e, f


def localname(el):
    """Local tag name of an element, or None for comments and processing instructions."""
    try:
        return etree.QName(el).localname
    except (ValueError, TypeError):
        return None


# --------------------------------------------------------------------------- maths


def mat_mul(m1, m2):
    """Return m1 * m2 (apply m2 first, then m1)."""
    a1, b1, c1, d1, e1, f1 = m1
    a2, b2, c2, d2, e2, f2 = m2
    return (
        a1 * a2 + c1 * b2,
        b1 * a2 + d1 * b2,
        a1 * c2 + c1 * d2,
        b1 * c2 + d1 * d2,
        a1 * e2 + c1 * f2 + e1,
        b1 * e2 + d1 * f2 + f1,
    )


def apply(m, x, y):
    a, b, c, d, e, f = m
    return (a * x + c * y + e, b * x + d * y + f)


TRANSFORM_RE = re.compile(r"([a-zA-Z]+)\s*\(([^)]*)\)")


def parse_transform(text):
    m = IDENT
    if not text:
        return m
    for name, raw in TRANSFORM_RE.findall(text):
        nums = [float(v) for v in re.split(r"[\s,]+", raw.strip()) if v]
        if name == "translate" and nums:
            m = mat_mul(m, (1, 0, 0, 1, nums[0], nums[1] if len(nums) > 1 else 0.0))
        elif name == "scale" and nums:
            sx = nums[0]
            sy = nums[1] if len(nums) > 1 else sx
            m = mat_mul(m, (sx, 0, 0, sy, 0, 0))
        elif name == "rotate" and nums:
            angle = math.radians(nums[0])
            cos, sin = math.cos(angle), math.sin(angle)
            rot = (cos, sin, -sin, cos, 0, 0)
            if len(nums) >= 3:
                cx, cy = nums[1], nums[2]
                m = mat_mul(m, (1, 0, 0, 1, cx, cy))
                m = mat_mul(m, rot)
                m = mat_mul(m, (1, 0, 0, 1, -cx, -cy))
            else:
                m = mat_mul(m, rot)
        elif name == "matrix" and len(nums) >= 6:
            m = mat_mul(m, tuple(nums[:6]))
        elif name == "skewX" and nums:
            m = mat_mul(m, (1, 0, math.tan(math.radians(nums[0])), 1, 0, 0))
        elif name == "skewY" and nums:
            m = mat_mul(m, (1, math.tan(math.radians(nums[0])), 0, 1, 0, 0))
    return m


# --------------------------------------------------------------------------- style


INHERITED = ("fill", "stroke", "stroke-width", "stroke-dasharray", "font-family",
             "font-size", "font-weight", "font-style", "text-anchor", "opacity",
             "marker-start", "marker-end")


def style_map(el, inherited):
    """Presentation attributes, then `style`, then inherited values."""
    values = dict(inherited)
    for key in INHERITED:
        raw = el.get(key)
        if raw is not None:
            values[key] = raw
    style = el.get("style")
    if style:
        for part in style.split(";"):
            if ":" in part:
                key, value = part.split(":", 1)
                values[key.strip()] = value.strip()
    return values


def colour(value, fallback="none"):
    if value is None:
        return fallback
    value = value.strip()
    if value in ("", "none", "transparent"):
        return "none"
    if value.startswith("url("):
        return fallback
    if value.startswith("#") and len(value) == 9:  # #rrggbbaa
        return value[:7]
    if value.startswith("rgb"):
        return value
    return value


def number(value, fallback=0.0):
    if value is None:
        return fallback
    match = re.match(r"\s*(-?\d*\.?\d+)", str(value))
    return float(match.group(1)) if match else fallback


def stroke_width(styles):
    width = number(styles.get("stroke-width"), 1.0)
    return 0.0 if colour(styles.get("stroke")) == "none" else max(width, 0.0)


def edge_style(styles, width):
    """A connector that keeps the figure's arrowheads (SVG markers)."""
    stroke = colour(styles.get("stroke")) or "#000000"
    start = "block" if styles.get("marker-start") else "none"
    end = "block" if styles.get("marker-end") else "none"
    dash = ""
    raw = styles.get("stroke-dasharray")
    if raw and raw not in ("none", "0"):
        parts = [number(v) for v in re.findall(r"-?\d*\.?\d+", raw)]
        if parts:
            pattern = " ".join(fmt(v) for v in parts)
            dash = f"dashed=1;dashPattern={pattern};"
    return (f"startArrow={start};startFill={1 if start != 'none' else 0};"
            f"endArrow={end};endFill={1 if end != 'none' else 0};"
            f"html=1;rounded=0;strokeColor={stroke};strokeWidth={fmt(width)};{dash}")


# --------------------------------------------------------------------------- cells


class Cell:
    __slots__ = ("kind", "style", "value", "x", "y", "w", "h", "points", "children", "rot")

    def __init__(self, kind, style, value="", x=0.0, y=0.0, w=0.0, h=0.0, points=None, rot=0.0):
        self.kind = kind
        self.style = style
        self.value = value
        self.x = x
        self.y = y
        self.w = w
        self.h = h
        self.points = points or []
        self.children = []
        self.rot = rot

    def bbox(self):
        boxes = []
        if self.kind == "vertex" and (self.w or self.h):
            boxes.append((self.x, self.y, self.x + self.w, self.y + self.h))
        for x, y in self.points:
            boxes.append((x, y, x, y))
        for child in self.children:
            boxes.append(child.bbox())
        if not boxes:
            return (0.0, 0.0, 0.0, 0.0)
        return (min(b[0] for b in boxes), min(b[1] for b in boxes),
                max(b[2] for b in boxes), max(b[3] for b in boxes))

    def shift(self, dx, dy):
        self.x -= dx
        self.y -= dy
        self.points = [(x - dx, y - dy) for x, y in self.points]
        for child in self.children:
            child.shift(dx, dy)


def fmt(value):
    text = f"{value:.2f}".rstrip("0").rstrip(".")
    return text if text not in ("-0", "") else "0"


class Emitter:
    def __init__(self, base_dir: Path, viewport=None, metrics=None, pictures="auto"):
        self.base_dir = base_dir
        self.root: list[Cell] = []
        self.viewport = viewport          # (x, y, w, h) of the page, or None
        self.metrics = metrics
        self.pictures = pictures
        self.gradients: dict[str, tuple[str, str, str]] = {}
        self.shared_defs: list[bytes] = []

    PICTURE_SPLIT_MAX = 24

    # -- defs: gradients and clip paths ------------------------------------
    def collect_defs(self, root):
        """Index paints that draw.io can carry natively."""
        for node in root.iter():
            tag = localname(node)
            if tag not in ("linearGradient", "radialGradient"):
                continue
            gid = node.get("id")
            if not gid:
                continue
            stops = []
            for stop in node:
                if localname(stop) != "stop":
                    continue
                paint = stop.get("stop-color")
                if paint is None:
                    inline = stop.get("style") or ""
                    match = re.search(r"stop-color\s*:\s*([^;]+)", inline)
                    paint = match.group(1).strip() if match else None
                stops.append(colour(paint, "#000000"))
            if len(stops) < 2:
                continue
            if tag == "radialGradient":
                continue  # draw.io has no radial gradient; keep it as a picture
            x1, y1 = number(node.get("x1"), 0.0), number(node.get("y1"), 0.0)
            x2, y2 = number(node.get("x2"), 1.0), number(node.get("y2"), 0.0)
            if abs(x2 - x1) >= abs(y2 - y1):
                direction = "east" if x2 >= x1 else "west"
            else:
                direction = "south" if y2 >= y1 else "north"
            self.gradients[gid] = (stops[0], stops[-1], direction)
        defs = [n for n in root.iter() if localname(n) == "defs"]
        self.shared_defs = [etree.tostring(d) for d in defs]

    def paint(self, styles):
        """Return (fill, stroke, extra style) resolving gradient references."""
        fill = colour(styles.get("fill"), "#ffffff")
        stroke = colour(styles.get("stroke"), "none")
        extra = ""
        match = re.fullmatch(r"url\(\s*#([^)\s]+)\s*\)", str(styles.get("fill", "")).strip())
        if match and match.group(1) in self.gradients:
            first, last, direction = self.gradients[match.group(1)]
            fill = first
            extra = f"gradientColor={last};gradientDirection={direction};"
        opacity = styles.get("fill-opacity")
        if opacity not in (None, "", "1", "1.0"):
            try:
                extra += f"opacity={int(round(float(opacity) * 100))};"
            except ValueError:
                pass
        return fill, stroke, extra

    # -- text -------------------------------------------------------------
    @staticmethod
    def text_width(text, size, weight):
        width = 0.0
        for char in text:
            wide = ord(char) > 0x2E80 or char in "\uff0c\u3002\u3001\uff1b\uff1a\uff08\uff09\u3010\u3011\u300a\u300b\u201c\u201d\u2018\u2019"
            width += size * (1.0 if wide else (0.62 if weight in ("bold", "600", "700") else 0.55))
        return width, size * 0.75, size * 0.25

    def collect_texts(self, el, inherited, out):
        """Walk the tree once so every label can be measured in one batch."""
        styles = style_map(el, inherited)
        if localname(el) == "text":
            text = "".join(el.itertext())
            if text.strip():
                out.append((text, number(styles.get("font-size"), 12.0),
                            str(styles.get("font-weight", "normal")).strip(),
                            str(styles.get("font-family", "Arial")).split(",")[0].strip().strip("'\"")))
            return
        for child in el:
            if isinstance(child.tag, str):
                self.collect_texts(child, styles, out)

    def emit_text(self, text, el, matrix, styles, rotation):
        if not text.strip():
            return None
        size = number(styles.get("font-size"), 12.0)
        weight = str(styles.get("font-weight", "normal")).strip()
        family = str(styles.get("font-family", "Arial")).split(",")[0].strip().strip("'\"")
        ink = colour(styles.get("fill"), "#000000")
        if ink == "none":
            ink = "#000000"

        anchor = str(styles.get("text-anchor", "start"))
        x = number(el.get("x"), 0.0)
        y = number(el.get("y"), 0.0)
        px, py = apply(matrix, x, y)

        if self.metrics is not None:
            width, ascent, descent = self.metrics.measure(text, size, weight, family)
        else:
            width, ascent, descent = self.text_width(text, size, weight)
        spacing = number(styles.get("letter-spacing"), 0.0)
        if spacing:
            width += spacing * max(len(text) - 1, 0)
        height = max(ascent + descent, size * 0.75)
        if anchor == "middle":
            left = px - width / 2
        elif anchor == "end":
            left = px - width
        else:
            left = px
        top = py - ascent

        style = (
            "text;html=1;whiteSpace=nowrap;spacing=0;"
            f"align={ {'start': 'left', 'end': 'right'}.get(anchor, 'center') if anchor != 'start' else 'left' };"
            "verticalAlign=middle;"
            f"fillColor=none;strokeColor=none;fontSize={fmt(size)};"
            f"fontFamily={family};fontColor={ink};"
        )
        if weight in ("bold", "600", "700", "800", "900", "bolder"):
            style += "fontStyle=1;"
        if str(styles.get("font-style", "")).startswith("italic"):
            style += "fontStyle=3;" if "fontStyle=1;" in style else "fontStyle=2;"
        if abs(rotation) > 0.01:
            style += f"rotation={fmt(rotation)};"
        return Cell("vertex", style, value=text, x=left, y=top, w=width, h=height)

    # -- media fallback ---------------------------------------------------
    def split_picture(self, el, matrix):
        """Freeze a flat group piece by piece when the pieces are few.

        A heat map or a banded texture is a handful of neighbouring regions:
        keeping each one its own cell lets the author move, reorder and swap
        them.  Thousands of mesh cells stay a single picture.
        """
        if self.pictures == "single":
            return None
        children = [c for c in el if isinstance(c.tag, str)]
        if not (1 < len(children) <= self.PICTURE_SPLIT_MAX):
            return None
        if not all(localname(c) in ("g", "a") for c in children):
            return None
        if self.pictures == "auto" and any(self.has_native(c) for c in children):
            return None
        cells = []
        for child in children:
            child_matrix = mat_mul(matrix, parse_transform(child.get("transform")))
            bbox = self.flat_bbox(child, child_matrix)
            if not bbox:
                continue
            cell = self.inline_svg_cell(child, child_matrix, bbox)
            if cell is not None:
                cells.append(cell)
        return cells if len(cells) > 1 else None

    def inline_svg_cell(self, el, matrix, bbox):
        """Freeze one element into an inline-SVG image cell."""
        x0, y0, x1, y1 = bbox
        width = max(x1 - x0, 1.0)
        height = max(y1 - y0, 1.0)
        clone = etree.fromstring(etree.tostring(el))
        wrapper = etree.Element(f"{{{SVG_NS}}}svg", nsmap=NSMAP)
        wrapper.set("viewBox", f"{fmt(x0)} {fmt(y0)} {fmt(width)} {fmt(height)}")
        wrapper.set("width", f"{fmt(width)}pt")
        wrapper.set("height", f"{fmt(height)}pt")
        inner = etree.SubElement(wrapper, f"{{{SVG_NS}}}g")
        inner.set("transform", "matrix({},{},{},{},{},{})".format(*(fmt(v) for v in matrix)))
        inner.append(clone)
        raw = etree.tostring(wrapper)
        data = base64.b64encode(raw).decode("ascii")
        # draw.io renders an SVG data URI only inside an HTML label; putting it
        # in a shape=image cell silently yields nothing.
        value = (f'<img src="data:image/svg+xml;base64,{data}" '
                 f'width="{fmt(width)}" height="{fmt(height)}">')
        style = ("text;html=1;whiteSpace=wrap;spacing=0;align=center;verticalAlign=middle;"
                 "fillColor=none;strokeColor=none;overflow=hidden;")
        return Cell("vertex", style, value=value, x=x0, y=y0, w=width, h=height)

    @staticmethod
    def path_points(raw):
        """Absolute points a path passes through: endpoints, curve controls and arc bulges."""
        tokens = re.findall(r"[MmLlHhVvCcSsQqTtAaZz]|-?\d*\.?\d+(?:[eE][-+]?\d+)?", raw or "")
        points = []
        x = y = 0.0
        start = (0.0, 0.0)
        command = "M"
        index = 0
        arity = {"M": 2, "L": 2, "H": 1, "V": 1, "C": 6, "S": 4, "Q": 4, "T": 2, "A": 7}
        while index < len(tokens):
            token = tokens[index]
            if token.isalpha():
                command = token
                index += 1
                if command in "Zz":
                    x, y = start
                    points.append((x, y))
                continue
            upper = command.upper()
            count = arity.get(upper)
            if count is None:
                break
            chunk = tokens[index:index + count]
            if len(chunk) < count or any(part.isalpha() for part in chunk):
                break
            args = [float(part) for part in chunk]
            index += count
            relative = command.islower()
            if upper == "H":
                x = args[0] + (x if relative else 0.0)
                points.append((x, y))
            elif upper == "V":
                y = args[0] + (y if relative else 0.0)
                points.append((x, y))
            elif upper == "A":
                rx, ry = abs(args[0]), abs(args[1])
                end_x = args[5] + (x if relative else 0.0)
                end_y = args[6] + (y if relative else 0.0)
                # the sweep can bulge a full radius away from both ends
                points.extend([(x - rx, y - ry), (x + rx, y + ry),
                               (end_x - rx, end_y - ry), (end_x + rx, end_y + ry)])
                x, y = end_x, end_y
                points.append((x, y))
            else:
                pairs = [(args[i] + (x if relative else 0.0), args[i + 1] + (y if relative else 0.0))
                         for i in range(0, count, 2)]
                if upper == "M":
                    start = pairs[0]
                points.extend(pairs)
                x, y = pairs[-1]
        return points

    def path_bbox(self, el, matrix, pad=1.0):
        """Bbox from the path's own command stream, so arcs and curves land right."""
        points = self.path_points(el.get("d") or el.get("points") or "")
        if not points:
            return None
        width = stroke_width(style_map(el, {}))
        pts = [apply(matrix, px, py) for px, py in points]
        grown = pad + width
        return (min(p[0] for p in pts) - grown, min(p[1] for p in pts) - grown,
                max(p[0] for p in pts) + grown, max(p[1] for p in pts) + grown)

    # -- what draw.io can model natively ----------------------------------
    NATIVE = frozenset({"rect", "circle", "ellipse", "line", "text", "image"})

    def has_native(self, el):
        for node in el.iter():
            tag = localname(node)
            if tag in self.NATIVE:
                return True
            # a straight stroked path is a connector, not a picture: freezing the
            # group it lives in would lose the arrow and often flatten it to nothing
            if tag == "path":
                styles = style_map(node, {})
                raw = node.get("d", "")
                if (colour(styles.get("fill"), "none") == "none"
                        and colour(styles.get("stroke"), "none") != "none"
                        and re.fullmatch(r"[\sMLHVZmlhvcz0-9.,+-]*", raw)
                        and not re.search(r"[CQSAcqsa]", raw)):
                    return True
        return False

    def flat_bbox(self, el, matrix):
        """Union bbox of a subtree made only of shapes."""
        boxes = []
        for child in el:
            tag = localname(child)
            child_matrix = mat_mul(matrix, parse_transform(child.get("transform")))
            if tag in ("g", "a"):
                inner = self.flat_bbox(child, child_matrix)
                if inner:
                    boxes.append(inner)
                continue
            box = self.path_bbox(child, child_matrix)
            if box:
                boxes.append(box)
        if not boxes:
            return None
        return (min(b[0] for b in boxes), min(b[1] for b in boxes),
                max(b[2] for b in boxes), max(b[3] for b in boxes))

    # -- primitives -------------------------------------------------------
    def emit(self, el, matrix, inherited):
        tag = localname(el)
        styles = style_map(el, inherited)
        outer = matrix  # the picture wrapper must stop above this element,
                        # because the cloned element keeps its own transform
        matrix = mat_mul(matrix, parse_transform(el.get("transform")))
        angle = math.degrees(math.atan2(matrix[1], matrix[0])) if (matrix[1] or matrix[0]) else 0.0

        if tag == "g" or tag == "a":
            # A subtree with no natively-modelled primitive (a shaded mesh, a
            # gradient, a texture) would otherwise explode into thousands of
            # invisible edges: keep it as one picture cell instead.
            if not self.has_native(el):
                split = self.split_picture(el, matrix)
                if split:
                    return split
                bbox = self.flat_bbox(el, matrix)
                if bbox:
                    return self.inline_svg_cell(el, matrix, bbox)
                return None
            children = []
            for child in el:
                cell = self.emit(child, matrix, styles)
                if cell is None:
                    continue
                if isinstance(cell, list):
                    children.extend(cell)
                else:
                    children.append(cell)
            if not children:
                return None
            gid = el.get("id")
            if gid and len(children) > 1:
                group = Cell("group", "group")
                group.children = children
                return group
            return children[0] if len(children) == 1 else children

        fill, stroke, extra = self.paint(styles)
        width = stroke_width(styles)

        if tag == "rect":
            sx = math.hypot(matrix[0], matrix[1]) or 1.0
            sy = math.hypot(matrix[2], matrix[3]) or 1.0
            w = number(el.get("width")) * sx
            h = number(el.get("height")) * sy
            if w <= 0 or h <= 0:
                return None
            if abs(angle) > 0.01:
                # draw.io turns a cell about its own centre, so place the cell by
                # the turned centre instead of the turned top-left corner
                cx, cy = apply(matrix,
                               number(el.get("x")) + number(el.get("width")) / 2.0,
                               number(el.get("y")) + number(el.get("height")) / 2.0)
                x, y = cx - w / 2.0, cy - h / 2.0
            else:
                x, y = apply(matrix, number(el.get("x")), number(el.get("y")))
            rx = number(el.get("rx"), number(el.get("ry"), 0.0))
            style = (f"rounded={1 if rx > 0 else 0};arcSize={max(4, min(50, int(rx / max(min(w, h), 1) * 100)))};"
                     f"whiteSpace=wrap;html=1;fillColor={fill};strokeColor={stroke};strokeWidth={fmt(width)};"
                     f"{extra}")
            if abs(angle) > 0.01:
                style += f"rotation={fmt(angle)};"
            return Cell("vertex", style, x=x, y=y, w=w, h=h)

        if tag in ("circle", "ellipse"):
            cx, cy = apply(matrix, number(el.get("cx")), number(el.get("cy")))
            if tag == "circle":
                rx = ry = number(el.get("r"))
            else:
                rx, ry = number(el.get("rx")), number(el.get("ry"))
            style = (f"ellipse;whiteSpace=wrap;html=1;fillColor={fill};"
                     f"strokeColor={stroke};strokeWidth={fmt(width)};{extra}")
            return Cell("vertex", style, x=cx - rx, y=cy - ry, w=rx * 2, h=ry * 2)

        if tag == "line":
            p1 = apply(matrix, number(el.get("x1")), number(el.get("y1")))
            p2 = apply(matrix, number(el.get("x2")), number(el.get("y2")))
            style = edge_style(styles, width)
            return Cell("edge", style, points=[p1, p2])

        if tag == "polyline":
            raw = el.get("points", "")
            nums = [float(v) for v in re.findall(r"-?\d*\.?\d+", raw)]
            pts = [apply(matrix, x, y) for x, y in zip(nums[0::2], nums[1::2])]
            if len(pts) < 2:
                return None
            if fill != "none":
                # a filled polyline is a face: an edge would drop the fill
                bbox = self.path_bbox(el, matrix)
                return self.inline_svg_cell(el, matrix, bbox) if bbox else None
            style = edge_style(styles, width)
            return Cell("edge", style, points=pts)

        if tag == "path":
            raw = el.get("d", "")
            if (fill == "none" and stroke != "none"
                    and re.fullmatch(r"[\sMLHVCZmlhvcz0-9.,+-]*", raw)
                    and not re.search(r"[CQSAcqsa]", raw)):
                pts = self.straight_path_points(raw, matrix)
                if pts:
                    style = edge_style(styles, width)
                    return Cell("edge", style, points=pts)
            bbox = self.path_bbox(el, matrix)
            return self.inline_svg_cell(el, matrix, bbox) if bbox else None

        if tag == "polygon":
            bbox = self.path_bbox(el, matrix)
            return self.inline_svg_cell(el, matrix, bbox) if bbox else None

        if tag == "text":
            content = "".join(el.itertext())
            return self.emit_text(content, el, matrix, styles, angle)

        if tag == "image":
            return self.emit_image(el, matrix)

        if tag in ("defs", "title", "desc", "metadata", "style", "clipPath", "marker"):
            return None

        bbox = self.path_bbox(el, matrix)
        return self.inline_svg_cell(el, matrix, bbox) if bbox else None

    @staticmethod
    def straight_path_points(raw, matrix):
        tokens = re.findall(r"[MLHVZmlhvz]|-?\d*\.?\d+", raw.replace(",", " "))
        pts, cursor, start = [], [0.0, 0.0], None
        command = None
        index = 0
        while index < len(tokens):
            token = tokens[index]
            if token.isalpha():
                command = token
                index += 1
                continue
            relative = command.islower()
            upper = command.upper()
            if upper == "Z":
                if start is not None:
                    pts.append(apply(matrix, *start))
                index += 1
                continue
            if upper == "H":
                x = float(token)
                cursor[0] = cursor[0] + x if relative else x
                index += 1
            elif upper == "V":
                y = float(token)
                cursor[1] = cursor[1] + y if relative else y
                index += 1
            elif upper in ("M", "L"):
                if index + 1 >= len(tokens):
                    break
                x, y = float(token), float(tokens[index + 1])
                cursor = [cursor[0] + x, cursor[1] + y] if relative else [x, y]
                if upper == "M":
                    start = list(cursor)
                index += 2
            else:
                return None
            pts.append(apply(matrix, *cursor))
        return pts if len(pts) >= 2 else None

    def emit_image(self, el, matrix):
        href = el.get(f"{{{XLINK_NS}}}href") or el.get("href") or ""
        href = href.strip()
        if not href or href.startswith(("http://", "https://")):
            return None
        data = None
        if href.startswith("data:"):
            data = href
        else:
            path = self.base_dir / unquote(urlparse(href).path)
            try:
                payload = path.read_bytes()
            except OSError:
                return None
            suffix = path.suffix.lower().lstrip(".") or "png"
            mime = "image/jpeg" if suffix in ("jpg", "jpeg") else f"image/{suffix}"
            data = f"data:{mime};base64,{base64.b64encode(payload).decode('ascii')}"
        x, y = apply(matrix, number(el.get("x")), number(el.get("y")))
        w, h = number(el.get("width")), number(el.get("height"))
        return Cell("vertex", f"shape=image;html=1;imageAspect=0;image={data};", x=x, y=y, w=w, h=h)


# --------------------------------------------------------------------------- writing


def serialise(cells):
    parts = []
    counter = itertools_counter()

    def emit_cell(cell, parent):
        cid = next(counter)
        if cell.kind == "group":
            x0, y0, x1, y1 = cell.bbox()
            style = "group;pointerEvents=0;"
            parts.append(
                f'<mxCell id="{cid}" value="" style={quoteattr(style)} vertex="1" parent="{parent}">'
                f'<mxGeometry x="{fmt(x0)}" y="{fmt(y0)}" width="{fmt(max(x1 - x0, 1))}" '
                f'height="{fmt(max(y1 - y0, 1))}" as="geometry"/></mxCell>'
            )
            for child in cell.children:
                child.shift(x0, y0)
                emit_cell(child, cid)
            return cid

        if cell.kind == "edge":
            points = cell.points
            if len(points) < 2:
                return None
            (sx, sy), (tx, ty) = points[0], points[-1]
            geometry = (
                f'<mxGeometry width="{fmt(abs(tx - sx))}" height="{fmt(abs(ty - sy))}" relative="1" as="geometry">'
                f'<mxPoint x="{fmt(sx)}" y="{fmt(sy)}" as="sourcePoint"/>'
                f'<mxPoint x="{fmt(tx)}" y="{fmt(ty)}" as="targetPoint"/>'
            )
            middle = points[1:-1]
            if middle:
                arr = "".join(f'<mxPoint x="{fmt(x)}" y="{fmt(y)}"/>' for x, y in middle)
                geometry += f'<Array as="points">{arr}</Array>'
            geometry += "</mxGeometry>"
            parts.append(
                f'<mxCell id="{cid}" value="" style={quoteattr(cell.style)} edge="1" parent="{parent}">'
                f"{geometry}</mxCell>"
            )
            return cid

        geometry = (
            f'<mxGeometry x="{fmt(cell.x)}" y="{fmt(cell.y)}" width="{fmt(max(cell.w, 1))}" '
            f'height="{fmt(max(cell.h, 1))}" as="geometry"/>'
        )
        value = quoteattr(cell.value) if cell.value else '""'
        parts.append(
            f'<mxCell id="{cid}" value={value} style={quoteattr(cell.style)} vertex="1" parent="{parent}">'
            f"{geometry}</mxCell>"
        )
        return cid

    for cell in cells:
        emit_cell(cell, "1")
    return "".join(parts)


def itertools_counter():
    value = 2
    while True:
        yield str(value)
        value += 1


def build(svg_path: Path, name: str, compressed: bool, measure: str = "auto", pictures: str = "auto"):
    tree = etree.parse(str(svg_path))
    root = tree.getroot()
    viewbox = root.get("viewBox")
    if viewbox:
        vx, vy, vw, vh = (float(v) for v in re.split(r"[\s,]+", viewbox.strip()))
    else:
        vx, vy = 0.0, 0.0
        vw, vh = number(root.get("width"), 300.0), number(root.get("height"), 200.0)

    metrics = None
    if measure != "off":
        try:
            from text_metrics import TextMetrics
            metrics = TextMetrics(prefer=measure)
        except Exception:
            metrics = None

    emitter = Emitter(svg_path.parent, viewport=(vx, vy, vw, vh), metrics=metrics, pictures=pictures)
    emitter.collect_defs(root)
    if metrics is not None:
        labels: list[tuple[str, float, str, str]] = []
        emitter.collect_texts(root, {}, labels)
        metrics.prewarm(labels)

    cells = []
    for child in root:
        cell = emitter.emit(child, IDENT, {})
        if cell is None:
            continue
        if isinstance(cell, list):
            cells.extend(cell)
        else:
            cells.append(cell)

    body = serialise(cells)
    model = (
        f'<mxGraphModel dx="800" dy="600" grid="1" gridSize="8" guides="1" tooltips="1" connect="1" '
        f'arrows="1" fold="1" page="1" pageScale="1" pageWidth="{fmt(vw)}" pageHeight="{fmt(vh)}" '
        f'math="0" shadow="0"><root><mxCell id="0"/><mxCell id="1" parent="0"/>{body}</root></mxGraphModel>'
    )

    if compressed:
        raw = zlib.compress(body.encode("utf-8"), 9)
        encoded = base64.b64encode(raw).decode("ascii")
        payload = escape(encoded)
    else:
        payload = model

    title = escape(name)
    stamp = __import__("datetime").datetime.now(__import__("datetime").timezone.utc)
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        f'<mxfile host="DSH" modified="{stamp.isoformat(timespec="seconds")}" '
        f'type="device"><diagram id="figgenie" name="{title}">'
        f"{payload}</diagram></mxfile>\n"
    )


def main(argv=None):
    parser = argparse.ArgumentParser(description="Convert an SVG figure into an editable .drawio diagram.")
    parser.add_argument("svg")
    parser.add_argument("-o", "--out", help="output .drawio path (default: alongside the SVG)")
    parser.add_argument("--name", help="page name (default: the SVG file stem)")
    parser.add_argument("--compressed", action="store_true", help="store the model deflated + base64 (drawio default)")
    parser.add_argument("--measure", choices=("auto", "chromium", "fonttools", "off"), default="auto",
                        help="how label widths are measured (default: chromium, then fonttools, then estimate)")
    parser.add_argument("--pictures", choices=("auto", "single", "split"), default="auto",
                        help="how unmapped artwork is frozen: auto splits few regions, single keeps one picture per group")
    args = parser.parse_args(argv)

    svg = Path(args.svg)
    if not svg.is_file():
        print(f"svg2drawio: not a file: {svg}", file=sys.stderr)
        return 2
    out = Path(args.out) if args.out else svg.with_suffix(".drawio")
    try:
        text = build(svg, args.name or svg.stem, args.compressed, args.measure, args.pictures)
    except etree.XMLSyntaxError as error:
        print(f"svg2drawio: invalid SVG: {error}", file=sys.stderr)
        return 2
    out.write_text(text, encoding="utf-8")
    cells = text.count("<mxCell ")
    print(f"wrote {out} ({cells} cells, {len(text)} chars)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

