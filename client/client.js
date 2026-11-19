/**
 * figgenie-paper-diagram — browser side.
 *
 * One right-sidebar tab with two modes: a figure list that renders PNG
 * previews through the host's /dsh-figgenie routes, and a canvas editor that
 * reads the figure back into an editable model, lets the user move boxes, draw
 * connectors and retype labels, then writes the SVG (plus a .edit.json sidecar)
 * back through /dsh-figgenie/save.
 */
window.__ModuleLoader__.load({
  id: 'dsh-figgenie-paper-diagram',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

    const API = '/dsh-figgenie';
    const TAB_ID = 'figgenie-preview';
    const TAB_KIND = 'figgenie-preview';
    const TAB_TITLE = '插图';

    const FONT = "'TeX Gyre Heros', 'Helvetica Neue', Helvetica, Arimo, Arial, sans-serif";
    const INK = '#16202c';
    const MUTED = '#6b7a8d';
    const SWATCHES = ['#ffffff', '#f6f8fb', '#eef2f7', '#dbe4ee', '#e08a1e', '#c86a1a',
      '#2f7d4f', '#3f7fbf', '#e05252', '#16202c', '#6b7a8d'];

    // -- colour -------------------------------------------------------------

    const RECENT_MAX = 10;

    function hexRgb(input) {
      const found = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(input || '').trim());
      if (!found) return null;
      let text = found[1];
      if (text.length === 3) text = text.split('').map((c) => c + c).join('');
      return {
        r: parseInt(text.slice(0, 2), 16),
        g: parseInt(text.slice(2, 4), 16),
        b: parseInt(text.slice(4, 6), 16),
      };
    }

    function rgbHex(rgb) {
      const clip = (v) => Math.max(0, Math.min(255, Math.round(v)));
      return '#' + [rgb.r, rgb.g, rgb.b].map((v) => clip(v).toString(16).padStart(2, '0')).join('');
    }

    function rgbHsv(rgb) {
      const r = rgb.r / 255;
      const g = rgb.g / 255;
      const b = rgb.b / 255;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const span = max - min;
      let hue = 0;
      if (span > 0) {
        if (max === r) hue = ((g - b) / span) % 6;
        else if (max === g) hue = (b - r) / span + 2;
        else hue = (r - g) / span + 4;
        hue *= 60;
        if (hue < 0) hue += 360;
      }
      return { h: hue, s: max === 0 ? 0 : span / max, v: max };
    }

    function hsvRgb(hue, sat, val) {
      const c = val * sat;
      const hp = (((hue % 360) + 360) % 360) / 60;
      const x = c * (1 - Math.abs((hp % 2) - 1));
      const table = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][Math.floor(hp) % 6];
      const m = val - c;
      return { r: (table[0] + m) * 255, g: (table[1] + m) * 255, b: (table[2] + m) * 255 };
    }

    function hsvHex(hue, sat, val) {
      return rgbHex(hsvRgb(hue, sat, val));
    }

    function normalizeColour(input) {
      const rgb = hexRgb(input);
      return rgb ? rgbHex(rgb) : null;
    }

    /** Hue ring plus a saturation/value square: any colour in two drags. */
    function ColorWheel({ value, onChange, size = 132 }) {
      const ring = 19;
      // the square must fit the ring's hole: its diagonal cannot exceed the hole
      const inner = Math.round((size - ring * 2) * 0.64);
      const rgb = hexRgb(value) || { r: 255, g: 255, b: 255 };
      const hsv = rgbHsv(rgb);
      const hueRef = useRef(hsv.h);
      if (hsv.s > 0.02 && hsv.v > 0.02) hueRef.current = hsv.h;
      const hue = hueRef.current;

      const fromRing = (event, element) => {
        const box = element.getBoundingClientRect();
        const dx = event.clientX - box.left - box.width / 2;
        const dy = event.clientY - box.top - box.height / 2;
        const deg = ((Math.atan2(dy, dx) * 180) / Math.PI + 90 + 360) % 360;
        hueRef.current = deg;
        onChange(hsvHex(deg, Math.max(hsv.s, 0.15), Math.max(hsv.v, 0.2)));
      };

      const fromSquare = (event, element) => {
        const box = element.getBoundingClientRect();
        const sat = Math.max(0, Math.min(1, (event.clientX - box.left) / box.width));
        const val = 1 - Math.max(0, Math.min(1, (event.clientY - box.top) / box.height));
        onChange(hsvHex(hueRef.current, sat, val));
      };

      const drag = (handler) => ({
        onPointerDown: (event) => {
          event.preventDefault();
          event.stopPropagation();
          event.currentTarget.setPointerCapture(event.pointerId);
          handler(event, event.currentTarget);
        },
        onPointerMove: (event) => {
          if (event.buttons === 1) handler(event, event.currentTarget);
        },
      });

      return h('div', { style: { position: 'relative', width: size + 'px', height: size + 'px', touchAction: 'none' } },
        h('div', {
          title: '色相',
          style: {
            position: 'absolute', inset: 0, borderRadius: '50%', cursor: 'crosshair',
            background: 'conic-gradient(#ff0000, #ffff00, #00ff00, #00ffff, #0000ff, #ff00ff, #ff0000)',
            WebkitMask: 'radial-gradient(circle at 50% 50%, transparent ' + (size / 2 - ring) + 'px, #000 ' + (size / 2 - ring + 1) + 'px)',
          },
          ...drag(fromRing),
        }),
        h('div', {
          title: '饱和度 / 明度',
          style: {
            position: 'absolute',
            left: (size - inner) / 2, top: (size - inner) / 2, width: inner + 'px', height: inner + 'px',
            borderRadius: '4px', cursor: 'crosshair', touchAction: 'none',
            background: 'linear-gradient(to top, #000, rgba(0,0,0,0)), linear-gradient(to right, #fff, '
              + hsvHex(hue, 1, 1) + ')',
            border: '1px solid rgba(127,127,127,.45)',
          },
          ...drag(fromSquare),
        }),
      );
    }

    function Swatch({ colour, active, onClick, size = 15 }) {
      return h('button', {
        key: colour,
        title: colour,
        onClick,
        style: {
          width: size + 'px', height: size + 'px', padding: 0, borderRadius: '3px', cursor: 'pointer',
          background: colour,
          border: active ? '2px solid #4084ff' : '1px solid rgba(127,127,127,.45)',
        },
      });
    }

    /** One colour control: chip, hex box, and an expandable wheel. */
    function ColorRow({ label, value, onChange, open, onToggle, recent, extracted, extra }) {
      const set = (colour) => {
        const clean = normalizeColour(colour);
        if (clean) onChange(clean);
      };
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
        h('div', { style: styles.row },
          h('span', { style: styles.label }, label),
          h('button', {
            title: '打开色盘',
            onClick: onToggle,
            style: {
              width: '24px', height: '18px', padding: 0, cursor: 'pointer', borderRadius: '3px',
              background: value, border: open ? '2px solid #4084ff' : '1px solid rgba(127,127,127,.5)',
            },
          }),
          h('input', {
            style: { ...styles.field, width: '80px' },
            value,
            onChange: (event) => set(event.target.value),
          }),
          ...(extra || []),
        ),
        open
          ? h('div', { style: { display: 'flex', gap: '10px', flexWrap: 'wrap', padding: '2px 0 4px' } },
            h(ColorWheel, { value, onChange: (colour) => onChange(colour) }),
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', flex: '1 1 140px', minWidth: '140px' } },
              recent.length
                ? h('div', { style: styles.row },
                  h('span', { style: styles.label }, '最近'),
                  recent.map((colour) => h(Swatch, {
                    colour, active: colour === value, onClick: () => set(colour),
                  })))
                : null,
              extracted.length
                ? h('div', { style: styles.row },
                  h('span', { style: styles.label }, '图中'),
                  extracted.slice(0, 14).map((colour) => h(Swatch, {
                    colour, active: colour === value, onClick: () => set(colour),
                  })))
                : null,
              h('div', { style: styles.row },
                h('span', { style: styles.label }, '预设'),
                SWATCHES.map((colour) => h(Swatch, {
                  colour, active: colour === value, onClick: () => set(colour),
                }))),
            ),
          )
          : null,
      );
    }

    const styles = {
      root: {
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        padding: '12px',
        height: '100%',
        boxSizing: 'border-box',
        overflow: 'auto',
        fontSize: '12px',
        color: 'inherit',
      },
      row: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' },
      meta: { opacity: 0.65, fontSize: '11px', wordBreak: 'break-all' },
      list: {
        display: 'flex',
        flexDirection: 'column',
        gap: '2px',
        maxHeight: '190px',
        overflow: 'auto',
        border: '1px solid rgba(127,127,127,.28)',
        borderRadius: '6px',
        padding: '4px',
      },
      item: (active) => ({
        textAlign: 'left',
        padding: '5px 7px',
        borderRadius: '4px',
        border: 'none',
        background: active ? 'rgba(64,132,255,.16)' : 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        font: 'inherit',
        display: 'flex',
        flexDirection: 'column',
        gap: '1px',
      }),
      button: {
        padding: '4px 8px',
        borderRadius: '5px',
        border: '1px solid rgba(127,127,127,.35)',
        background: 'rgba(127,127,127,.10)',
        color: 'inherit',
        cursor: 'pointer',
        font: 'inherit',
      },
      small: {
        padding: '2px 6px',
        borderRadius: '4px',
        border: '1px solid rgba(127,127,127,.35)',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        font: 'inherit',
        lineHeight: 1.5,
      },
      primary: {
        padding: '4px 9px',
        borderRadius: '5px',
        border: '1px solid rgba(64,132,255,.55)',
        background: 'rgba(64,132,255,.18)',
        color: 'inherit',
        cursor: 'pointer',
        font: 'inherit',
      },
      stage: {
        border: '1px solid rgba(127,127,127,.28)',
        borderRadius: '6px',
        padding: '6px',
        minHeight: '120px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(127,127,127,.06)',
        overflow: 'auto',
      },
      canvas: {
        display: 'flex',
        justifyContent: 'center',
        padding: '4px 0',
      },
      stage: {
        position: 'relative',
        overflow: 'auto',
        width: '100%',
        maxWidth: '58vh',
        aspectRatio: '1 / 1',
        border: '1px solid rgba(127,127,127,.28)',
        borderRadius: '6px',
        background: 'rgba(127,127,127,.06)',
        outline: 'none',
      },
      stageInner: {
        boxSizing: 'border-box',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 'max-content',
        minWidth: '100%',
        minHeight: '100%',
        padding: '12px',
      },
      img: { maxWidth: '100%', height: 'auto', display: 'block' },
      error: { color: '#e05252', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
      findings: { display: 'flex', flexDirection: 'column', gap: '3px', maxHeight: '150px', overflow: 'auto' },
      finding: (severity) => ({
        borderLeft: '3px solid ' + (severity === 'error' ? '#e05252' : severity === 'warn' ? '#d9a03c' : '#7f8ea3'),
        padding: '2px 6px',
        background: 'rgba(127,127,127,.07)',
        borderRadius: '3px',
        wordBreak: 'break-word',
      }),
      field: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '3px 6px',
        borderRadius: '4px',
        border: '1px solid rgba(127,127,127,.35)',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
      },
      label: { opacity: 0.7, fontSize: '11px', minWidth: '46px' },
    };

    async function getJSON(url) {
      const response = await fetch(url, { headers: { accept: 'application/json' } });
      const text = await response.text();
      let parsed;
      try { parsed = text === '' ? {} : JSON.parse(text); } catch { parsed = { raw: text }; }
      if (!response.ok) {
        const detail = parsed && (parsed.error || parsed.stderr) ? ' — ' + (parsed.error || parsed.stderr) : '';
        throw new Error('HTTP ' + response.status + detail);
      }
      return parsed;
    }

    async function postJSON(url, body) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const text = await response.text();
      let parsed;
      try { parsed = text === '' ? {} : JSON.parse(text); } catch { parsed = { raw: text }; }
      if (!response.ok) throw new Error(parsed && parsed.error ? parsed.error : 'HTTP ' + response.status);
      return parsed;
    }

    function collectFindings(report) {
      if (report === null || typeof report !== 'object') return [];
      const source = Array.isArray(report.findings) ? report.findings
        : Array.isArray(report.issues) ? report.issues
          : Array.isArray(report.diagnostics) ? report.diagnostics
            : [];
      return source.map((entry) => ({
        severity: String(entry.severity ?? entry.level ?? entry.kind ?? 'info').toLowerCase(),
        message: String(entry.message ?? entry.code ?? entry.rule ?? JSON.stringify(entry)),
      }));
    }

    /* ------------------------------------------------------------ model maths */

    const num = (value) => {
      const rounded = Math.round(Number(value) * 100) / 100;
      return String(rounded);
    };

    const esc = (text) => String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

    const clone = (value) => JSON.parse(JSON.stringify(value));

    function uid(model, prefix) {
      let index = 1;
      const taken = new Set(model.nodes.map((n) => n.id).concat(model.edges.map((e) => e.id)));
      while (taken.has(prefix + index)) index += 1;
      return prefix + index;
    }

    const PORTS = ['l', 'r', 't', 'b'];

    function rotatePoint(point, centre, degrees) {
      const angle = ((Number(degrees) || 0) * Math.PI) / 180;
      if (!angle) return point;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const dx = point[0] - centre[0];
      const dy = point[1] - centre[1];
      return [centre[0] + dx * cos - dy * sin, centre[1] + dx * sin + dy * cos];
    }

    function baseAnchor(node, port) {
      const cx = node.x + node.w / 2;
      const cy = node.y + node.h / 2;
      if (port === 'l') return [node.x, cy];
      if (port === 'r') return [node.x + node.w, cy];
      if (port === 't') return [cx, node.y];
      if (port === 'b') return [cx, node.y + node.h];
      return [cx, cy];
    }

    /** Shapes whose edge should meet the outline, not the bounding box corner. */
    const RIM_KINDS = new Set(['ellipse', 'circle', 'umlUseCase', 'diamond']);

    /**
     * Where a connector should meet `node` when it heads toward `other`: on the
     * ellipse/diamond outline, so a use-case fan looks like it lands on the oval.
     */
    function rimAnchor(node, other) {
      const cx = node.x + node.w / 2;
      const cy = node.y + node.h / 2;
      const ox = other.x + other.w / 2;
      const oy = other.y + other.h / 2;
      if (Math.abs(ox - cx) < 0.01 && Math.abs(oy - cy) < 0.01) return [cx, cy];
      const angle = Math.atan2(oy - cy, ox - cx);
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const rx = node.w / 2;
      const ry = node.h / 2;
      if (node.kind === 'diamond') {
        const scale = 1 / (Math.abs(cos) / rx + Math.abs(sin) / ry);
        return [cx + cos * scale, cy + sin * scale];
      }
      return [cx + cos * rx, cy + sin * ry];
    }

    function anchor(node, port) {
      const centre = [node.x + node.w / 2, node.y + node.h / 2];
      return rotatePoint(baseAnchor(node, port), centre, node.rot);
    }

    function nearestPort(node, point) {
      const sides = PORTS.map((port) => {
        const [ax, ay] = anchor(node, port);
        return { port, gap: Math.hypot(ax - point[0], ay - point[1]) };
      });
      sides.sort((a, b) => a.gap - b.gap);
      return sides[0].port;
    }

    function nodeAt(model, point) {
      for (let index = model.nodes.length - 1; index >= 0; index -= 1) {
        const node = model.nodes[index];
        const centre = [node.x + node.w / 2, node.y + node.h / 2];
        const local = rotatePoint(point, centre, -(Number(node.rot) || 0));
        if (local[0] >= node.x && local[0] <= node.x + node.w
          && local[1] >= node.y && local[1] <= node.y + node.h) return node;
      }
      return null;
    }

    /** Route between two nodes: straight, elbow (orthogonal) or curved. */
    function routeEdge(model, edge) {
      const from = model.nodes.find((n) => n.id === edge.from.id);
      const to = model.nodes.find((n) => n.id === edge.to.id);
      if (!from || !to) {
        const points = edge.points && edge.points.length > 1 ? edge.points : [[0, 0], [0, 0]];
        return { points, d: 'M' + points.map((p) => num(p[0]) + ',' + num(p[1])).join(' L') };
      }
      if (!edge.from.port) edge.from.port = nearestPort(from, anchor(to, 'l'));
      if (!edge.to.port) edge.to.port = nearestPort(to, anchor(from, 'r'));
      const spin = (node, point) => {
        if (!node.rot) return point;
        return rotatePoint(point, [node.x + node.w / 2, node.y + node.h / 2], node.rot);
      };
      const a = spin(from, RIM_KINDS.has(from.kind) ? rimAnchor(from, to) : baseAnchor(from, edge.from.port));
      const b = spin(to, RIM_KINDS.has(to.kind) ? rimAnchor(to, from) : baseAnchor(to, edge.to.port));
      const route = edge.route || 'elbow';
      if (route === 'straight') {
        return { points: [a, b], d: 'M' + num(a[0]) + ',' + num(a[1]) + ' L' + num(b[0]) + ',' + num(b[1]) };
      }
      if (route === 'curve') {
        const horizontalFrom = edge.from.port === 'l' || edge.from.port === 'r';
        const horizontalTo = edge.to.port === 'l' || edge.to.port === 'r';
        const pull = Math.max(12, Math.min(48, (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1])) / 3));
        const c1 = horizontalFrom
          ? [a[0] + (edge.from.port === 'l' ? -pull : pull), a[1]]
          : [a[0], a[1] + (edge.from.port === 't' ? -pull : pull)];
        const c2 = horizontalTo
          ? [b[0] + (edge.to.port === 'l' ? -pull : pull), b[1]]
          : [b[0], b[1] + (edge.to.port === 't' ? -pull : pull)];
        const d = 'M' + num(a[0]) + ',' + num(a[1])
          + ' C' + num(c1[0]) + ',' + num(c1[1]) + ' ' + num(c2[0]) + ',' + num(c2[1])
          + ' ' + num(b[0]) + ',' + num(b[1]);
        return { points: [a, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], b], d };
      }
      const horizontal = (edge.from.port === 'l' || edge.from.port === 'r')
        && (edge.to.port === 'l' || edge.to.port === 'r');
      const vertical = (edge.from.port === 't' || edge.from.port === 'b')
        && (edge.to.port === 't' || edge.to.port === 'b');
      let points;
      if (Math.abs(a[1] - b[1]) < 0.6 && Math.abs(a[0] - b[0]) > 0.6) {
        points = [a, b];
      } else if (Math.abs(a[0] - b[0]) < 0.6 && Math.abs(a[1] - b[1]) > 0.6) {
        points = [a, b];
      } else if (horizontal) {
        const mid = (a[0] + b[0]) / 2;
        points = [a, [mid, a[1]], [mid, b[1]], b];
      } else if (vertical) {
        const mid = (a[1] + b[1]) / 2;
        points = [a, [a[0], mid], [b[0], mid], b];
      } else {
        points = [a, [b[0], a[1]], b];
      }
      return { points, d: 'M' + points.map((p) => num(p[0]) + ',' + num(p[1])).join(' L') };
    }

    function edgeMid(points) {
      const middle = Math.floor((points.length - 1) / 2);
      const a = points[middle];
      const b = points[middle + 1] ?? points[middle];
      return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    }

    /* ------------------------------------------------------------ shapes */

    /** The shape library: flow-chart, data, basic and UML primitives. */
    const SHAPES = [
      { id: 'box', label: '矩形', group: '流程' },
      { id: 'rounded', label: '圆角', group: '流程' },
      { id: 'term', label: '起止', group: '流程' },
      { id: 'diamond', label: '判断', group: '流程' },
      { id: 'parallelogram', label: '数据', group: '流程' },
      { id: 'hexagon', label: '准备', group: '流程' },
      { id: 'trapezoid', label: '手动操作', group: '流程' },
      { id: 'triangle', label: '合并', group: '流程' },
      { id: 'subroutine', label: '子流程', group: '流程' },
      { id: 'delay', label: '延时', group: '流程' },
      { id: 'display', label: '显示', group: '流程' },
      { id: 'manualInput', label: '手动输入', group: '流程' },
      { id: 'offpage', label: '跨页', group: '流程' },
      { id: 'document', label: '文档', group: '数据' },
      { id: 'cyl', label: '数据库', group: '数据' },
      { id: 'note', label: '注释', group: '数据' },
      { id: 'multiDoc', label: '多文档', group: '数据' },
      { id: 'internalStorage', label: '内部存储', group: '数据' },
      { id: 'cloud', label: '云', group: '基础' },
      { id: 'ellipse', label: '椭圆', group: '基础' },
      { id: 'circle', label: '圆形', group: '基础' },
      { id: 'octagon', label: '八边形', group: '基础' },
      { id: 'pentagon', label: '五边形', group: '基础' },
      { id: 'star', label: '星形', group: '基础' },
      { id: 'callout', label: '对话气泡', group: '基础' },
      { id: 'arrowBlock', label: '块箭头', group: '基础' },
      { id: 'text', label: '纯文字', group: '基础' },
      { id: 'umlActor', label: '参与者', group: 'UML' },
      { id: 'umlClass', label: '类', group: 'UML' },
      { id: 'umlObject', label: '对象', group: 'UML' },
      { id: 'umlPackage', label: '包', group: 'UML' },
      { id: 'umlComponent', label: '组件', group: 'UML' },
      { id: 'umlInterface', label: '接口', group: 'UML' },
      { id: 'umlUseCase', label: '用例', group: 'UML' },
      { id: 'umlState', label: '状态', group: 'UML' },
      { id: 'umlInit', label: '初始节点', group: 'UML' },
      { id: 'umlFinal', label: '终止节点', group: 'UML' },
      { id: 'umlNote', label: 'UML 注释', group: 'UML' },
    ];

    const SHAPE_GROUPS = ['流程', '数据', '基础', 'UML'];

    /** Arrow heads, in the same order ProcessOn offers them. */
    const ARROWS = [
      { id: 'block', label: '实心' },
      { id: 'open', label: '开口' },
      { id: 'diamond', label: '菱形' },
      { id: 'dot', label: '圆点' },
      { id: 'none', label: '无' },
    ];

    const ARROW_HEADS = {
      block: { refX: 9.2, size: 4.6, body: (c) => '<path d="M0,1 L10,5 L0,9 z" fill="' + c + '"/>' },
      open: { refX: 9.6, size: 4.6, body: (c) => '<path d="M0,1 L10,5 L0,9" fill="none" stroke="' + c + '" stroke-width="1.5" stroke-linecap="round"/>' },
      diamond: { refX: 10, size: 4.6, body: (c) => '<path d="M0,5 L5,1 L10,5 L5,9 z" fill="' + c + '"/>' },
      dot: { refX: 9, size: 3.4, body: (c) => '<circle cx="5" cy="5" r="4" fill="' + c + '"/>' },
    };

    const DASHES = [
      { id: 'solid', label: '实线', value: '' },
      { id: 'dashed', label: '虚线', value: '3 2' },
      { id: 'dotted', label: '点线', value: '1 2' },
    ];

    const ROUTES = [
      { id: 'straight', label: '直线' },
      { id: 'elbow', label: '折线' },
      { id: 'curve', label: '曲线' },
    ];

    /**
     * Stand-alone line objects. A line is not a node: it has two points, a
     * stroke, a dash pattern and arrow heads, so it can be dragged as a whole
     * without pretending to be a box.
     */
    const LINES = [
      { id: 'line', label: '直线', dash: '', arrow: 'none' },
      { id: 'line-dashed', label: '虚线', dash: '3 2', arrow: 'none' },
      { id: 'line-dotted', label: '点线', dash: '1 2', arrow: 'none' },
      { id: 'arrow', label: '箭头', dash: '', arrow: 'end' },
      { id: 'arrow-dashed', label: '虚线箭头', dash: '3 2', arrow: 'end' },
      { id: 'arrow-double', label: '双向箭头', dash: '', arrow: 'both' },
      { id: 'arrow-double-dashed', label: '双向虚线', dash: '3 2', arrow: 'both' },
    ];

    const LINE_GROUP = '线条';

    function polyline(points, close) {
      return 'M' + points.map((p) => num(p[0]) + ',' + num(p[1])).join(' L') + (close ? ' z' : '');
    }

    function roundedRect(x, y, w, h, r) {
      const radius = Math.max(0, Math.min(r, w / 2, h / 2));
      return 'M' + num(x + radius) + ',' + num(y)
        + ' H' + num(x + w - radius) + ' A' + num(radius) + ',' + num(radius) + ' 0 0 1 ' + num(x + w) + ',' + num(y + radius)
        + ' V' + num(y + h - radius) + ' A' + num(radius) + ',' + num(radius) + ' 0 0 1 ' + num(x + w - radius) + ',' + num(y + h)
        + ' H' + num(x + radius) + ' A' + num(radius) + ',' + num(radius) + ' 0 0 1 ' + num(x) + ',' + num(y + h - radius)
        + ' V' + num(y + radius) + ' A' + num(radius) + ',' + num(radius) + ' 0 0 1 ' + num(x + radius) + ',' + num(y) + ' z';
    }

    function circlePath(cx, cy, r) {
      return 'M' + num(cx - r) + ',' + num(cy) + ' A' + num(r) + ',' + num(r) + ' 0 1 0 ' + num(cx + r) + ',' + num(cy)
        + ' A' + num(r) + ',' + num(r) + ' 0 1 0 ' + num(cx - r) + ',' + num(cy) + ' z';
    }

    /** Where a node's label sits: compartments and actors need their own spot. */
    function textLayout(node) {
      const spot = baseTextLayout(node);
      const dx = Number(node.labelDx) || 0;
      const dy = Number(node.labelDy) || 0;
      return dx === 0 && dy === 0 ? spot : { x: spot.x + dx, y: spot.y + dy, anchor: spot.anchor };
    }

    const WIDE = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uff60]/;

    /** Greedy line breaking: latin words stay whole, CJK breaks anywhere. */
    function wrapParagraph(text, size, bold, maxWidth) {
      const units = [];
      let word = '';
      for (const ch of text) {
        if (WIDE.test(ch)) {
          if (word) { units.push(word); word = ''; }
          units.push(ch);
        } else if (ch === ' ') {
          if (word) { units.push(word); word = ''; }
          units.push(' ');
        } else {
          word += ch;
        }
      }
      if (word) units.push(word);
      const lines = [];
      let line = '';
      for (const unit of units) {
        if (line === '') {
          line = unit === ' ' ? '' : unit;
          continue;
        }
        if (measureLabel((line + unit).trimEnd(), size, bold) <= maxWidth) {
          line += unit;
          continue;
        }
        lines.push(line.trimEnd());
        line = unit === ' ' ? '' : unit;
      }
      lines.push(line.trimEnd());
      return lines;
    }

    /** The rendered lines of a label: paragraph boxes wrap, the rest do not. */
    function textLines(node) {
      const label = String(node.label ?? '');
      if (!node.wrap) return label.split('\n');
      const width = Math.max(8, node.w - 4);
      const out = [];
      for (const para of label.split('\n')) {
        if (para === '') { out.push(''); continue; }
        out.push(...wrapParagraph(para, node.fs, node.bold, width));
      }
      return out.length ? out : [''];
    }

    function lineHeightOf(node) {
      return node.fs * (Number(node.lh) || 1.25);
    }

    function lineAnchorX(node) {
      const align = node.align ?? 'center';
      if (align === 'left') return node.x + 2;
      if (align === 'right') return node.x + node.w - 2;
      return node.x + node.w / 2;
    }

    function firstBaseline(node, count) {
      const block = count * lineHeightOf(node);
      const top = node.y + Math.max(0, (node.h - block) / 2);
      return top + node.fs * 0.98;
    }

    function baseTextLayout(node) {
      const cx = node.x + node.w / 2;
      const baseline = node.y + node.h / 2 + node.fs * 0.264;
      if (node.container) return { x: cx, y: node.y + node.fs * 1.35, anchor: 'middle' };
      if (node.kind === 'umlActor') return { x: cx, y: node.y + node.h * 0.97, anchor: 'middle' };
      if (node.kind === 'umlClass' || node.kind === 'umlObject') {
        return { x: cx, y: node.y + node.fs * 1.55, anchor: 'middle' };
      }
      if (node.kind === 'umlPackage') return { x: cx, y: node.y + node.h * 0.62, anchor: 'middle' };
      if (node.kind === 'cyl') return { x: cx, y: node.y + node.h * 0.52, anchor: 'middle' };
      if (node.kind === 'multiDoc') return { x: cx, y: node.y + node.h * 0.55, anchor: 'middle' };
      if (node.kind === 'umlInit' || node.kind === 'umlFinal') {
        return { x: cx, y: node.y + node.h + node.fs + 1.5, anchor: 'middle' };
      }
      if (node.kind === 'umlInterface') return { x: node.x + node.w * 0.58, y: node.y + node.h / 2 - 2.6, anchor: 'start' };
      return { x: cx, y: baseline, anchor: 'middle' };
    }

    /** One filled outline plus optional unfilled detail lines, in page units. */
    function nodeGeom(node) {
      const x = node.x;
      const y = node.y;
      const w = node.w;
      const h = node.h;
      const right = x + w;
      const bottom = y + h;
      const cx = x + w / 2;
      const cy = y + h / 2;
      const kind = node.kind;
      if (kind === 'ellipse' || kind === 'circle') {
        return { shape: 'ellipse', cx, cy, rx: w / 2, ry: h / 2, extra: [] };
      }
      if (kind === 'diamond') {
        return { shape: 'path', d: polyline([[cx, y], [right, cy], [cx, bottom], [x, cy]], true), extra: [] };
      }
      if (kind === 'parallelogram') {
        const cut = Math.min(w * 0.18, 14);
        return { shape: 'path', d: polyline([[x + cut, y], [right, y], [right - cut, bottom], [x, bottom]], true), extra: [] };
      }
      if (kind === 'hexagon') {
        const cut = Math.min(w * 0.15, 12);
        return {
          shape: 'path',
          d: polyline([[x + cut, y], [right - cut, y], [right, cy], [right - cut, bottom], [x + cut, bottom], [x, cy]], true),
          extra: [],
        };
      }
      if (kind === 'trapezoid') {
        const cut = Math.min(w * 0.15, 12);
        return { shape: 'path', d: polyline([[x + cut, y], [right - cut, y], [right, bottom], [x, bottom]], true), extra: [] };
      }
      if (kind === 'triangle') {
        return { shape: 'path', d: polyline([[cx, y], [right, bottom], [x, bottom]], true), extra: [] };
      }
      if (kind === 'manualInput') {
        const lift = Math.min(h * 0.4, 10);
        return { shape: 'path', d: polyline([[x, y + lift], [right, y], [right, bottom], [x, bottom]], true), extra: [] };
      }
      if (kind === 'offpage') {
        const tip = Math.min(h * 0.3, 8);
        return { shape: 'path', d: polyline([[x, y], [right, y], [right, bottom - tip], [cx, bottom], [x, bottom - tip]], true), extra: [] };
      }
      if (kind === 'display') {
        const tip = Math.min(w * 0.2, 12);
        return { shape: 'path', d: polyline([[x, y], [right - tip, y], [right, cy], [right - tip, bottom], [x, bottom]], true), extra: [] };
      }
      if (kind === 'delay') {
        const r = Math.min(h / 2, w / 2);
        return {
          shape: 'path',
          d: 'M' + num(x) + ',' + num(y) + ' L' + num(right - r) + ',' + num(y)
            + ' A' + num(r) + ',' + num(r) + ' 0 0 1 ' + num(right - r) + ',' + num(bottom)
            + ' L' + num(x) + ',' + num(bottom) + ' z',
          extra: [],
        };
      }
      if (kind === 'document') {
        const wave = Math.min(h * 0.18, 5);
        return {
          shape: 'path',
          d: 'M' + num(x) + ',' + num(y) + ' L' + num(right) + ',' + num(y)
            + ' L' + num(right) + ',' + num(bottom - wave)
            + ' Q' + num(x + w * 0.75) + ',' + num(bottom + wave * 1.8)
            + ' ' + num(x + w * 0.5) + ',' + num(bottom - wave * 0.2)
            + ' Q' + num(x + w * 0.25) + ',' + num(bottom - wave * 2.2)
            + ' ' + num(x) + ',' + num(bottom - wave) + ' z',
          extra: [],
        };
      }
      if (kind === 'cyl') {
        const ry = Math.min(h * 0.22, 9);
        const rx = Math.min(w / 2, 24);
        return {
          shape: 'path',
          d: 'M' + num(x) + ',' + num(y + ry) + ' A' + num(rx) + ',' + num(ry) + ' 0 0 1 ' + num(right) + ',' + num(y + ry)
            + ' L' + num(right) + ',' + num(bottom - ry)
            + ' A' + num(rx) + ',' + num(ry) + ' 0 0 1 ' + num(x) + ',' + num(bottom - ry) + ' z',
          extra: ['M' + num(x) + ',' + num(y + ry) + ' A' + num(rx) + ',' + num(ry) + ' 0 0 0 ' + num(right) + ',' + num(y + ry)],
        };
      }
      if (kind === 'note' || kind === 'umlNote') {
        const fold = Math.min(w * 0.22, h * 0.35, 10);
        return {
          shape: 'path',
          d: polyline([[x, y], [right - fold, y], [right, y + fold], [right, bottom], [x, bottom]], true),
          extra: [polyline([[right - fold, y], [right - fold, y + fold], [right, y + fold]], false)],
        };
      }
      if (kind === 'cloud') {
        return {
          shape: 'path',
          d: 'M' + num(x + w * 0.18) + ',' + num(y + h * 0.64)
            + ' C' + num(x - w * 0.02) + ',' + num(y + h * 0.3) + ' ' + num(x + w * 0.2) + ',' + num(y + h * 0.06) + ' ' + num(x + w * 0.38) + ',' + num(y + h * 0.22)
            + ' C' + num(x + w * 0.46) + ',' + num(y - h * 0.04) + ' ' + num(x + w * 0.74) + ',' + num(y + h * 0.02) + ' ' + num(x + w * 0.78) + ',' + num(y + h * 0.26)
            + ' C' + num(x + w * 1.04) + ',' + num(y + h * 0.3) + ' ' + num(x + w * 1.02) + ',' + num(y + h * 0.78) + ' ' + num(x + w * 0.8) + ',' + num(y + h * 0.82)
            + ' C' + num(x + w * 0.72) + ',' + num(y + h * 1.02) + ' ' + num(x + w * 0.3) + ',' + num(y + h * 1.02) + ' ' + num(x + w * 0.22) + ',' + num(y + h * 0.82)
            + ' C' + num(x + w * 0.04) + ',' + num(y + h * 0.86) + ' ' + num(x + w * 0.02) + ',' + num(y + h * 0.7) + ' ' + num(x + w * 0.18) + ',' + num(y + h * 0.64) + ' z',
          extra: [],
        };
      }
      if (kind === 'octagon') {
        const cut = Math.min(w, h) * 0.29;
        return {
          shape: 'path',
          d: polyline([
            [x + cut, y], [right - cut, y], [right, y + cut], [right, bottom - cut],
            [right - cut, bottom], [x + cut, bottom], [x, bottom - cut], [x, y + cut],
          ], true),
          extra: [],
        };
      }
      if (kind === 'pentagon') {
        return {
          shape: 'path',
          d: polyline([[cx, y], [right, y + h * 0.38], [x + w * 0.81, bottom], [x + w * 0.19, bottom], [x, y + h * 0.38]], true),
          extra: [],
        };
      }
      if (kind === 'star') {
        const outer = Math.min(w, h) / 2;
        const inner = outer * 0.42;
        const points = [];
        for (let step = 0; step < 10; step += 1) {
          const radius = step % 2 === 0 ? outer : inner;
          const angle = -Math.PI / 2 + (step * Math.PI) / 5;
          points.push([cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius]);
        }
        return { shape: 'path', d: polyline(points, true), extra: [] };
      }
      if (kind === 'callout') {
        const body = y + h * 0.82;
        const tail = polyline([[x + w * 0.24, body], [x + w * 0.16, y + h], [x + w * 0.42, body]], true);
        return { shape: 'path', d: roundedRect(x, y, w, h * 0.82, Math.min(5, w * 0.12)) + ' ' + tail, extra: [] };
      }
      if (kind === 'arrowBlock') {
        const neck = y + h * 0.25;
        const low = y + h * 0.75;
        const shaft = x + w * 0.6;
        return {
          shape: 'path',
          d: polyline([[x, neck], [shaft, neck], [shaft, y], [right, cy], [shaft, bottom], [shaft, low], [x, low]], true),
          extra: [],
        };
      }
      if (kind === 'multiDoc') {
        const step = Math.min(h * 0.09, 4);
        const wave = Math.min(h * 0.14, 4);
        const sheet = (dy) => 'M' + num(x) + ',' + num(y + dy) + ' L' + num(right) + ',' + num(y + dy)
          + ' L' + num(right) + ',' + num(bottom - wave + dy)
          + ' Q' + num(x + w * 0.75) + ',' + num(bottom + wave * 1.6 + dy)
          + ' ' + num(x + w * 0.5) + ',' + num(bottom - wave * 0.2 + dy)
          + ' Q' + num(x + w * 0.25) + ',' + num(bottom - wave * 2 + dy)
          + ' ' + num(x) + ',' + num(bottom - wave + dy) + ' z';
        return { shape: 'path', d: sheet(step * 2), extra: [sheet(step), sheet(0)] };
      }
      if (kind === 'internalStorage') {
        const line = x + Math.min(w * 0.22, 14);
        return {
          shape: 'rect',
          x, y, w, h, rx: 0,
          extra: [
            'M' + num(line) + ',' + num(y) + ' V' + num(bottom),
            'M' + num(line + 3) + ',' + num(y) + ' V' + num(bottom),
          ],
        };
      }
      if (kind === 'umlActor') {
        const head = Math.min(w * 0.2, h * 0.13);
        const headCy = y + head + 1;
        const hip = y + h * 0.56;
        return {
          shape: 'path',
          d: circlePath(cx, headCy, head),
          extra: [
            'M' + num(cx) + ',' + num(headCy + head) + ' V' + num(hip),
            'M' + num(cx - w * 0.3) + ',' + num(y + h * 0.42) + ' H' + num(cx + w * 0.3),
            'M' + num(cx) + ',' + num(hip) + ' L' + num(cx - w * 0.22) + ',' + num(y + h * 0.78),
            'M' + num(cx) + ',' + num(hip) + ' L' + num(cx + w * 0.22) + ',' + num(y + h * 0.78),
          ],
        };
      }
      if (kind === 'umlClass' || kind === 'umlObject') {
        const rows = kind === 'umlClass' ? [0.34, 0.67] : [0.34];
        return {
          shape: 'rect',
          x, y, w, h, rx: 0,
          extra: rows.map((at) => 'M' + num(x) + ',' + num(y + h * at) + ' H' + num(right)),
        };
      }
      if (kind === 'umlPackage') {
        const tab = x + w * 0.42;
        const shelf = y + h * 0.18;
        return {
          shape: 'path',
          d: polyline([[x, y], [tab, y], [tab, shelf], [right, shelf], [right, bottom], [x, bottom]], true),
          extra: [],
        };
      }
      if (kind === 'umlComponent') {
        const box = (top) => 'M' + num(x + 2) + ',' + num(top) + ' h8 v5 h-8 z';
        return {
          shape: 'rect',
          x, y, w, h, rx: 0,
          extra: [box(y + h * 0.24), box(bottom - h * 0.24 - 5)],
        };
      }
      if (kind === 'umlInterface') {
        const radius = Math.min(w * 0.18, h * 0.32);
        return {
          shape: 'ellipse',
          cx: x + radius + 2, cy, rx: radius, ry: radius,
          extra: ['M' + num(x + radius * 2 + 2) + ',' + num(cy) + ' H' + num(right)],
        };
      }
      if (kind === 'umlUseCase') {
        return { shape: 'ellipse', cx, cy, rx: w / 2, ry: h / 2, extra: [] };
      }
      if (kind === 'umlState') {
        return { shape: 'rect', x, y, w, h, rx: Math.min(5, h / 2), extra: [] };
      }
      if (kind === 'umlInit') {
        const radius = Math.min(w, h) / 2;
        return { shape: 'ellipse', cx, cy, rx: radius, ry: radius, extra: [], fill: node.stroke };
      }
      if (kind === 'umlFinal') {
        const radius = Math.min(w, h) / 2;
        const inner = radius * 0.62;
        return {
          shape: 'ellipse', cx, cy, rx: radius, ry: radius, extra: [],
          extraFills: [{ d: circlePath(cx, cy, inner), fill: node.stroke }],
        };
      }
      if (kind === 'text') {
        return { shape: 'rect', x, y, w, h, rx: 0, extra: [], bare: true };
      }
      const rx = kind === 'term' ? Math.min(h / 2, w / 2) : kind === 'rounded' ? Math.min(4, h / 2) : 0;
      const extra = kind === 'subroutine'
        ? [
          'M' + num(x + 5) + ',' + num(y) + ' L' + num(x + 5) + ',' + num(bottom),
          'M' + num(right - 5) + ',' + num(y) + ' L' + num(right - 5) + ',' + num(bottom),
        ]
        : [];
      return { shape: 'rect', x, y, w, h, rx, extra };
    }

    function nodeShapeSvg(node) {
      const geom = nodeGeom(node);
      const dash = node.dash ? ' stroke-dasharray="' + node.dash + '"' : '';
      const fill = geom.fill ?? node.fill;
      const paint = geom.bare
        ? 'fill="none" stroke="none"'
        : 'fill="' + fill + '" stroke="' + node.stroke + '" stroke-width="' + num(node.sw) + '"' + dash;
      const detail = (d) => '<path d="' + d + '" fill="none" stroke="' + node.stroke + '" stroke-width="' + num(node.sw) + '"' + dash + '/>';
      const solid = (item) => '<path d="' + item.d + '" fill="' + item.fill + '" stroke="none"/>';
      const fine = (geom.extraFills ?? []).map(solid).join('');
      if (geom.shape === 'ellipse') {
        return '<ellipse cx="' + num(geom.cx) + '" cy="' + num(geom.cy)
          + '" rx="' + num(geom.rx) + '" ry="' + num(geom.ry) + '" ' + paint + '/>'
          + geom.extra.map(detail).join('') + fine;
      }
      if (geom.shape === 'path') {
        return '<path d="' + geom.d + '" ' + paint + '/>' + geom.extra.map(detail).join('') + fine;
      }
      const radius = geom.rx > 0 ? ' rx="' + num(geom.rx) + '"' : '';
      return '<rect x="' + num(geom.x) + '" y="' + num(geom.y) + '" width="' + num(geom.w)
        + '" height="' + num(geom.h) + '"' + radius + ' ' + paint + '/>' + geom.extra.map(detail).join('') + fine;
    }

    function nodeTextSvg(node) {
      if (node.label === '') return '';
      const weight = node.bold ? ' font-weight="600"' : '';
      const italic = node.italic ? ' font-style="italic"' : '';
      const lines = textLines(node);
      const step = lineHeightOf(node);
      const spot = textLayout(node);
      const wrapped = Boolean(node.wrap);
      const anchor = wrapped ? ({ left: 'start', right: 'end' }[node.align ?? 'center'] ?? 'middle') : spot.anchor;
      const x = wrapped ? lineAnchorX(node) : spot.x;
      const top = wrapped ? firstBaseline(node, lines.length) : spot.y;
      return lines.map((line, index) => '<text x="' + num(x) + '" y="' + num(top + index * step)
        + '" font-size="' + num(node.fs) + '" text-anchor="' + anchor + '" fill="' + node.color + '"'
        + weight + italic + '>' + esc(line) + '</text>').join('');
    }

    function rotationOf(node) {
      const angle = Number(node.rot) || 0;
      if (Math.abs(angle) < 0.01) return '';
      const cx = num(node.x + node.w / 2);
      const cy = num(node.y + node.h / 2);
      return ' transform="rotate(' + num(angle) + ' ' + cx + ' ' + cy + ')"';
    }

    /** Serialise the model back into the house SVG dialect. */
    function svgFromModel(model) {
      const markers = new Map();
      const markerId = (stroke, kind) => {
        if (!kind || kind === 'none') return null;
        const key = stroke + '|' + kind;
        if (!markers.has(key)) markers.set(key, { id: 'arw' + (markers.size + 1), stroke, kind });
        return markers.get(key).id;
      };
      for (const edge of model.edges) {
        if (edge.arrow !== 'none') markerId(edge.stroke, edge.arrowKind || 'block');
      }
      for (const line of model.lines ?? []) {
        if (line.arrow && line.arrow !== 'none') markerId(line.stroke || INK, line.arrowKind || 'block');
      }
      const idFor = (edge) => markerId(edge.stroke, edge.arrowKind || 'block');
      const lines = [];
      lines.push('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + num(model.w) + ' ' + num(model.h)
        + '" width="' + num(model.w) + 'pt" height="' + num(model.h) + 'pt"\n     font-family="' + FONT + '">');
      lines.push('  <defs>');
      for (const marker of markers.values()) {
        const head = ARROW_HEADS[marker.kind] || ARROW_HEADS.block;
        lines.push('    <marker id="' + marker.id + '" viewBox="0 0 10 10" refX="' + head.refX + '" refY="5" markerWidth="'
          + head.size + '" markerHeight="' + head.size + '" orient="auto-start-reverse">\n      '
          + head.body(marker.stroke) + '\n    </marker>');
      }
      lines.push('  </defs>');
      lines.push('  <rect x="0" y="0" width="' + num(model.w) + '" height="' + num(model.h) + '" fill="' + (model.background ?? '#ffffff') + '"/>');
      // Free segments (fishbone spine and bones, calipers, brackets): drawn
      // under the labels and never attached to two nodes.
      for (const line of model.lines ?? []) {
        const dash = line.dash ? ' stroke-dasharray="' + line.dash + '"' : '';
        const d = 'M' + line.points.map((p) => num(p[0]) + ',' + num(p[1])).join(' L');
        const arrow = line.arrow || 'none';
        const marker = arrow === 'none' ? null : markerId(line.stroke || INK, line.arrowKind || 'block');
        const startMarker = marker && (arrow === 'start' || arrow === 'both') ? ' marker-start="url(#' + marker + ')"' : '';
        const endMarker = marker && (arrow === 'end' || arrow === 'both') ? ' marker-end="url(#' + marker + ')"' : '';
        lines.push('  <g id="l:' + line.id + '" data-line="1" data-arrow="' + arrow
          + '" data-arrow-kind="' + (line.arrowKind || 'block') + '">');
        lines.push('    <path d="' + d + '" fill="none" stroke="' + (line.stroke || INK)
          + '" stroke-width="' + num(line.sw ?? 0.9) + '"' + dash + startMarker + endMarker + '/>');
        lines.push('  </g>');
      }
      for (const node of model.nodes) {
        const box = num(node.x) + ',' + num(node.y) + ',' + num(node.w) + ',' + num(node.h);
        const prefix = node.container ? 'c:' : 'n:';
        const kind = node.container ? 'container' : 'node';
        const offset = (Number(node.labelDx) || 0) !== 0 || (Number(node.labelDy) || 0) !== 0
          ? ' data-label-offset="' + num(Number(node.labelDx) || 0) + ' ' + num(Number(node.labelDy) || 0) + '"'
          : '';
        const para = node.wrap
          ? ' data-wrap="1" data-align="' + (node.align ?? 'center') + '" data-lh="' + num(Number(node.lh) || 1.25)
            + '" data-text="' + esc(node.label).replace(/\n/g, '&#10;') + '"'
          : '';
        lines.push('  <g id="' + prefix + node.id + '" data-kind="' + kind + '" data-shape="' + node.kind
          + '" data-box="' + box + '"' + offset + para + rotationOf(node) + '>');
        lines.push('    ' + nodeShapeSvg(node));
        const text = nodeTextSvg(node);
        if (text !== '') lines.push('    ' + text);
        lines.push('  </g>');
      }
      for (const edge of model.edges) {
        const { d, points } = routeEdge(model, edge);
        const dash = edge.dash ? ' stroke-dasharray="' + edge.dash + '"' : '';
        const marker = idFor(edge);
        const startMarker = marker !== null && edge.arrow === 'both' ? ' marker-start="url(#' + marker + ')"' : '';
        const endMarker = marker !== null && edge.arrow !== 'none' ? ' marker-end="url(#' + marker + ')"' : '';
        lines.push('  <g id="e:' + edge.id + '" data-from="' + edge.from.id + '" data-to="' + edge.to.id
          + '" data-arrow="' + (edge.arrow || 'end') + '" data-arrow-kind="' + (edge.arrowKind || 'block')
          + '" data-route="' + (edge.route || 'elbow') + '">');
        lines.push('    <path d="' + d + '" fill="none" stroke="' + edge.stroke + '" stroke-width="' + num(edge.sw)
          + '"' + dash + startMarker + endMarker + '/>');
        if (edge.label) {
          const mid = edgeMid(points);
          const vertical = Math.abs(points[0][0] - points[points.length - 1][0]) < 0.6;
          const x = vertical ? mid[0] + 4 : mid[0];
          const y = vertical ? mid[1] + 2 : mid[1] - 4.5;
          lines.push('    <text x="' + num(x) + '" y="' + num(y) + '" font-size="6.5" text-anchor="'
            + (vertical ? 'start' : 'middle') + '" fill="' + (edge.labelColor || MUTED) + '" font-style="italic">' + esc(edge.label) + '</text>');
        }
        lines.push('  </g>');
      }
      lines.push('</svg>');
      return lines.join('\n') + '\n';
    }

    /* ------------------------------------------------------------ fishbone */

    /** Parse "类别: 原因1, 原因2" lines into fishbone categories. */
    function parseFishboneSpec(text) {
      const lines = String(text ?? '').split(/\r?\n/);
      const categories = [];
      for (const raw of lines) {
        const line = raw.trim();
        if (line === '' || line.startsWith('#')) continue;
        const cut = line.search(/[:：]/);
        const name = (cut === -1 ? line : line.slice(0, cut)).trim();
        if (name === '') continue;
        const rest = cut === -1 ? '' : line.slice(cut + 1);
        const causes = rest.split(/[,，;；]/).map((item) => item.trim()).filter((item) => item !== '');
        categories.push({ name, causes });
      }
      return categories;
    }

    /**
     * A cause-effect (Ishikawa) diagram: a spine that runs into the effect box,
     * one diagonal bone per category, and short ticks for each cause. Bones are
     * free segments, so the labels stay ordinary text nodes the canvas can drag.
     */
    function buildFishbone({ effect, categories, accent, width: fixedWidth }) {
      const colour = accent || '#c0392b';
      const cats = (categories && categories.length ? categories : [{ name: '类别', causes: [] }]).slice(0, 10);
      const categoryFont = 7.4;
      const causeFont = 6.8;
      const depth = cats.reduce((most, cat) => Math.max(most, cat.causes.length), 0);
      const sideSpan = Math.max(44, 22 + depth * 21);
      const headW = Math.max(96, measureLabel(effect, 7.6, true) + 22);
      const headH = 34;
      const originX = 30;
      // Keep the plate inside the double-column band papers use, then let the
      // bones get steeper rather than letting the canvas grow past it. A caller
      // that inserts into an existing figure can hand in a width instead.
      const natural = Math.max(430, Math.min(603, 30 + cats.length * 74 + 34 + headW + 18));
      const width = fixedWidth ? Math.max(240, Math.round(fixedWidth)) : natural;
      const spineLen = Math.max(110, width - 30 - 34 - headW - 18);
      const half = Math.max(34, sideSpan * 0.62);
      const height = Math.max(150, sideSpan * 2 + 56);
      const spineY = 0;
      const spineEnd = originX + spineLen;

      const nodes = [];
      const lines = [];
      let counter = 0;
      const nextId = (prefix) => prefix + (counter += 1);

      const textNode = (label, x, y, size, bold, colourOf) => {
        const w = measureLabel(label, size, bold) + 2;
        const h = size * 1.5;
        nodes.push({
          id: nextId('t'),
          kind: 'text',
          x: x - w / 2,
          y: y - h * 0.62,
          w,
          h,
          label,
          fs: size,
          fill: 'none',
          stroke: 'none',
          sw: 0,
          dash: '',
          color: colourOf || INK,
          bold: Boolean(bold),
          italic: false,
          rot: 0,
        });
        return { w, h };
      };

      lines.push({ id: nextId('l'), points: [[originX, spineY], [spineEnd, spineY]], stroke: INK, sw: 1.2, dash: '' });

      const upper = Math.ceil(cats.length / 2);
      cats.forEach((cat, index) => {
        const top = index < upper;
        const slot = top ? index : index - upper;
        const slots = top ? upper : cats.length - upper;
        const attach = originX + 22 + (spineLen - 44) * ((slot + 0.5) / slots);
        const dir = top ? -1 : 1;
        const boneEndX = attach - half;
        const boneEndY = spineY + dir * sideSpan;
        lines.push({
          id: nextId('l'),
          points: [[attach, spineY], [boneEndX, boneEndY]],
          stroke: colour,
          sw: 1.05,
          dash: '',
        });
        // the category sits just past the tip of its bone, clear of the ticks
        textNode(cat.name, boneEndX - 2, boneEndY + dir * 10, categoryFont, true, colour);
        const boneDx = boneEndX - attach;
        const boneDy = boneEndY - spineY;
        cat.causes.forEach((cause, position) => {
          const count = cat.causes.length;
          const t = count === 1 ? 0.55 : 0.3 + 0.48 * (position / (count - 1));
          const px = attach + boneDx * t;
          const py = spineY + boneDy * t;
          lines.push({
            id: nextId('l'),
            points: [[px, py], [px - 14, py]],
            stroke: MUTED,
            sw: 0.7,
            dash: '',
          });
          // The label sits level with its tick and clear of it: right edge a
          // few points left of the tick's outer end, so the tick never runs
          // through the words and the pair still reads as one unit.
          textNode(cause, px - 18 - measureLabel(cause, causeFont, false) / 2, py, causeFont, false, MUTED);
        });
      });

      nodes.push({
        id: nextId('n'),
        kind: 'term',
        x: spineEnd + 16,
        y: spineY - headH / 2,
        w: headW,
        h: headH,
        label: effect,
        fill: '#fdf3ef',
        stroke: colour,
        sw: 1.2,
        dash: '',
        fs: 7.6,
        color: INK,
        bold: true,
        italic: false,
        rot: 0,
      });

      // Shift everything so the drawing starts at the margin: fishbone math is
      // centred on y = 0, while the canvas needs a positive box.
      const box = { width: Number(width.toFixed(2)), height: Number((Math.max(height, depth * 21 + 74)).toFixed(2)) };
      const dy = box.height / 2;
      const dx = 6;
      for (const node of nodes) {
        node.x = Number((node.x + dx).toFixed(2));
        node.y = Number((node.y + dy).toFixed(2));
      }
      for (const line of lines) {
        line.points = line.points.map((p) => [Number((p[0] + dx).toFixed(2)), Number((p[1] + dy).toFixed(2))]);
      }

      return {
        v: 1,
        w: box.width,
        h: box.height,
        background: '#ffffff',
        nodes,
        edges: [],
        lines,
      };
    }

    /* ------------------------------------------------------------ svg input */

    function parsePoints(d) {
      const tokens = String(d).match(/[MLHVZmlhvz]|-?\d*\.?\d+/g) ?? [];
      const points = [];
      let cursor = [0, 0];
      let start = [0, 0];
      let command = 'M';
      let index = 0;
      const take = () => Number(tokens[index++]);
      while (index < tokens.length) {
        if (/[MLHVZmlhvz]/.test(tokens[index])) { command = tokens[index++]; continue; }
        const relative = command === command.toLowerCase();
        const upper = command.toUpperCase();
        if (upper === 'M' || upper === 'L') {
          const x = take();
          const y = take();
          cursor = relative ? [cursor[0] + x, cursor[1] + y] : [x, y];
          if (upper === 'M') start = cursor;
          points.push(cursor);
          command = upper === 'M' ? (relative ? 'l' : 'L') : command;
        } else if (upper === 'H') {
          const x = take();
          cursor = [relative ? cursor[0] + x : x, cursor[1]];
          points.push(cursor);
        } else if (upper === 'V') {
          const y = take();
          cursor = [cursor[0], relative ? cursor[1] + y : y];
          points.push(cursor);
        } else if (upper === 'Z') {
          cursor = start;
          points.push(cursor);
        } else {
          index += 1;
        }
      }
      return points;
    }

    function bboxOf(points) {
      const xs = points.map((p) => p[0]);
      const ys = points.map((p) => p[1]);
      return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    }

    function parseSvg(text) {
      const parsed = new DOMParser().parseFromString(text, 'image/svg+xml');
      const root = parsed.documentElement;
      const viewBox = (root.getAttribute('viewBox') ?? '0 0 504 150').trim().split(/[\s,]+/).map(Number);
      const model = {
        v: 1,
        w: viewBox[2] || 504,
        h: viewBox[3] || 150,
        background: '#ffffff',
        nodes: [],
        edges: [],
        lines: [],
      };
      const attr = (el, name, fallback) => {
        const value = el.getAttribute(name);
        return value === null ? fallback : value;
      };
      const numAttr = (el, name, fallback) => {
        const value = Number(el.getAttribute(name));
        return Number.isFinite(value) ? value : fallback;
      };

      const groups = Array.from(root.children).filter((child) => child.tagName.toLowerCase() === 'g');
      const containers = groups.length > 0 ? groups : Array.from(root.children);
      for (const group of containers) {
        const id = attr(group, 'id', '');
        const shape = Array.from(group.children).find((child) => ['rect', 'ellipse', 'circle', 'path', 'line'].includes(child.tagName.toLowerCase()));
        const texts = Array.from(group.children).filter((child) => child.tagName.toLowerCase() === 'text');
        const text = texts[0];
        const declaredKind = group.getAttribute('data-shape') || '';
        const hiddenShape = shape !== undefined
          && attr(shape, 'fill', 'none') === 'none' && attr(shape, 'stroke', 'none') === 'none';
        if (declaredKind === 'text' || (hiddenShape && texts.length > 0)) {
          // A paragraph or caption is all glyphs: the box it saves is a placeholder.
          if (texts.length === 0) continue;
          const box = (group.getAttribute('data-box') || '').split(/[\s,]+/).map(Number);
          const first = texts[0];
          const node = {
            id: id.replace(/^[nc]:/, '') || 'n' + (model.nodes.length + 1),
            container: false,
            kind: 'text',
            x: box.length === 4 ? box[0] : numAttr(first, 'x', 0),
            y: box.length === 4 ? box[1] : numAttr(first, 'y', 0) - numAttr(first, 'font-size', 7),
            w: box.length === 4 ? box[2] : Math.max(12, measureLabel(texts.map((el) => el.textContent ?? '').join(' '), numAttr(first, 'font-size', 7), attr(first, 'font-weight', '') !== '')),
            h: box.length === 4 ? box[3] : numAttr(first, 'font-size', 7) * 1.4,
            fill: 'none',
            stroke: INK,
            sw: 0.6,
            dash: '',
            label: group.hasAttribute('data-text')
              ? group.getAttribute('data-text')
              : texts.map((el) => el.textContent ?? '').join('\n'),
            fs: numAttr(first, 'font-size', 7),
            color: attr(first, 'fill', INK),
            bold: attr(first, 'font-weight', '') !== '',
            italic: attr(first, 'font-style', '') === 'italic',
            wrap: attr(group, 'data-wrap', '') === '1',
            align: attr(group, 'data-align', 'center'),
            lh: numAttr(group, 'data-lh', 1.25),
          };
          const turned = /rotate\(\s*(-?[\d.]+)/.exec(group.getAttribute('transform') || '');
          node.rot = turned ? Number(turned[1]) : 0;
          model.nodes.push(node);
          continue;
        }
        const tag = shape.tagName.toLowerCase();
        const isConnector = group.getAttribute('data-from') !== null && group.getAttribute('data-to') !== null;
        // A stroked, unfilled path with no endpoints and no label is a free
        // segment (fishbone bone, tick, divider) rather than a shape.
        const looksLikeLine = !isConnector
          && (tag === 'line' || (tag === 'path' && attr(shape, 'fill', 'none') === 'none'))
          && text === undefined;
        if (group.getAttribute('data-line') !== null || looksLikeLine) {
          const points = tag === 'line'
            ? [[numAttr(shape, 'x1', 0), numAttr(shape, 'y1', 0)], [numAttr(shape, 'x2', 0), numAttr(shape, 'y2', 0)]]
            : parsePoints(attr(shape, 'd', 'M0,0 L0,0'));
          if (points.length >= 2) {
            const startHead = attr(shape, 'marker-start', '') !== '';
            const endHead = attr(shape, 'marker-end', '') !== '';
            model.lines.push({
              id: id.replace(/^l:/, '') || 'l' + (model.lines.length + 1),
              points,
              stroke: attr(shape, 'stroke', INK),
              sw: numAttr(shape, 'stroke-width', 0.9),
              dash: attr(shape, 'stroke-dasharray', ''),
              arrow: attr(group, 'data-arrow', startHead && endHead ? 'both' : (endHead ? 'end' : (startHead ? 'start' : 'none'))),
              arrowKind: (attr(group, 'data-arrow', 'none') === 'none') ? '' : attr(group, 'data-arrow-kind', 'block'),
            });
            continue;
          }
        }
        if (group.getAttribute('data-from') !== null && group.getAttribute('data-to') !== null) {
          const points = parsePoints(attr(shape, 'd', 'M0,0 L0,0'));
          model.edges.push({
            id: id.replace(/^e:/, '') || 'e' + (model.edges.length + 1),
            from: { id: group.getAttribute('data-from'), port: 'r' },
            to: { id: group.getAttribute('data-to'), port: 'l' },
            points,
            label: text ? (text.textContent ?? '').trim() : '',
            labelColor: text ? attr(text, 'fill', MUTED) : MUTED,
            stroke: attr(shape, 'stroke', INK),
            sw: numAttr(shape, 'stroke-width', 1.1),
            dash: attr(shape, 'stroke-dasharray', ''),
            arrow: attr(group, 'data-arrow',
              shape.getAttribute('marker-end') ? (shape.getAttribute('marker-start') ? 'both' : 'end') : 'none'),
            arrowKind: attr(group, 'data-arrow-kind', 'block'),
            route: attr(group, 'data-route', 'elbow'),
          });
          continue;
        }
        let node = null;
        if (tag === 'rect') {
          const w = numAttr(shape, 'width', 0);
          const hgt = numAttr(shape, 'height', 0);
          const rx = numAttr(shape, 'rx', 0);
          const fill = attr(shape, 'fill', '#ffffff');
          if (w >= model.w - 0.5 && hgt >= model.h - 0.5) {
            model.background = fill;
            continue;
          }
          node = {
            id: id.replace(/^[nc]:/, '') || 'n' + (model.nodes.length + 1),
            container: id.startsWith('c:'),
            kind: rx >= hgt / 2 - 0.2 ? 'term' : rx > 0 ? 'rounded' : 'box',
            x: numAttr(shape, 'x', 0),
            y: numAttr(shape, 'y', 0),
            w,
            h: hgt,
            fill,
            stroke: attr(shape, 'stroke', INK),
            sw: numAttr(shape, 'stroke-width', 0.56),
            dash: attr(shape, 'stroke-dasharray', ''),
            label: text ? (text.textContent ?? '').trim() : '',
            fs: text ? numAttr(text, 'font-size', 7) : 7,
            color: text ? attr(text, 'fill', INK) : INK,
            bold: text ? attr(text, 'font-weight', '') !== '' : false,
            italic: text ? attr(text, 'font-style', '') === 'italic' : false,
          };
        } else if (tag === 'ellipse' || tag === 'circle') {
          const w = tag === 'circle' ? numAttr(shape, 'r', 10) * 2 : numAttr(shape, 'rx', 10) * 2;
          const hgt = tag === 'circle' ? w : numAttr(shape, 'ry', 10) * 2;
          node = {
            id: id.replace(/^[nc]:/, '') || 'n' + (model.nodes.length + 1),
            container: id.startsWith('c:'),
            kind: 'ellipse',
            x: numAttr(shape, 'cx', 0) - w / 2,
            y: numAttr(shape, 'cy', 0) - hgt / 2,
            w,
            h: hgt,
            fill: attr(shape, 'fill', '#ffffff'),
            stroke: attr(shape, 'stroke', INK),
            sw: numAttr(shape, 'stroke-width', 0.56),
            dash: attr(shape, 'stroke-dasharray', ''),
            label: text ? (text.textContent ?? '').trim() : '',
            fs: text ? numAttr(text, 'font-size', 7) : 7,
            color: text ? attr(text, 'fill', INK) : INK,
            bold: false,
            italic: false,
          };
        } else if (tag === 'path') {
          const points = parsePoints(attr(shape, 'd', ''));
          if (points.length < 3) continue;
          const [x0, y0, x1, y1] = bboxOf(points);
          node = {
            id: id.replace(/^[nc]:/, '') || 'n' + (model.nodes.length + 1),
            container: id.startsWith('c:'),
            kind: 'diamond',
            x: x0,
            y: y0,
            w: x1 - x0,
            h: y1 - y0,
            fill: attr(shape, 'fill', '#ffffff'),
            stroke: attr(shape, 'stroke', INK),
            sw: numAttr(shape, 'stroke-width', 0.56),
            dash: attr(shape, 'stroke-dasharray', ''),
            label: text ? (text.textContent ?? '').trim() : '',
            fs: text ? numAttr(text, 'font-size', 7) : 7,
            color: text ? attr(text, 'fill', INK) : INK,
            bold: false,
            italic: false,
          };
        }
        const box = (group.getAttribute('data-box') || '').split(/[\s,]+/).map(Number);
        if (node && box.length === 4 && box.every((value) => Number.isFinite(value))) {
          node.x = box[0];
          node.y = box[1];
          node.w = box[2];
          node.h = box[3];
        }
        if (node) {
          const declared = group.getAttribute('data-shape') || group.getAttribute('data-kind');
          if (declared && SHAPES.some((entry) => entry.id === declared)) node.kind = declared;
          const turned = /rotate\(\s*(-?[\d.]+)/.exec(group.getAttribute('transform') || '');
          node.rot = turned ? Number(turned[1]) : 0;
          const offset = (group.getAttribute('data-label-offset') || '').split(/[\s,]+/).map(Number);
          if (offset.length === 2 && offset.every((value) => Number.isFinite(value))) {
            node.labelDx = offset[0];
            node.labelDy = offset[1];
          }
          model.nodes.push(node);
        }
      }

      // Resolve connector ports from the geometry the file already has.
      for (const edge of model.edges) {
        const from = model.nodes.find((n) => n.id === edge.from.id);
        const to = model.nodes.find((n) => n.id === edge.to.id);
        if (!from || !to || !edge.points || edge.points.length < 2) continue;
        edge.from.port = nearestPort(from, edge.points[0]);
        edge.to.port = nearestPort(to, edge.points[edge.points.length - 1]);
      }
      return model;
    }

    /* ------------------------------------------------------------ measurement */

    let measureCanvas = null;
    function measureLabel(text, size, bold) {
      try {
        if (measureCanvas === null) measureCanvas = document.createElement('canvas');
        const context = measureCanvas.getContext('2d');
        context.font = (bold ? '600 ' : '') + size * 4 + 'px ' + FONT;
        return context.measureText(text).width / 4;
      } catch {
        // No canvas (headless test harness): count wide glyphs — CJK and
        // full-width punctuation sit on a 1em square, not on 0.55em.
        let units = 0;
        for (const ch of text) units += /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uff60]/.test(ch) ? 1 : 0.55;
        return units * size;
      }
    }

    /* ------------------------------------------------------------ editor */

    const HANDLES = [
      ['nw', 0, 0], ['n', 0.5, 0], ['ne', 1, 0], ['e', 1, 0.5],
      ['se', 1, 1], ['s', 0.5, 1], ['sw', 0, 1], ['w', 0, 0.5],
    ];

    /** Zoom limits shared by the buttons and the wheel. */
    const clampZoom = (value) => Math.min(8, Math.max(0.2, value));
    const trimZoom = (value) => String(Math.round(value * 100) / 100);

    function Editor({ path, onClose, onSaved }) {
      const [model, setModel] = useState(null);
      const [error, setError] = useState(null);
      const [selected, setSelected] = useState(null);
      const [zoom, setZoom] = useState(2);
      const [tool, setTool] = useState('select');
      const [saving, setSaving] = useState(false);
      const [message, setMessage] = useState(null);
      const [findings, setFindings] = useState([]);
      const [sizeDraft, setSizeDraft] = useState({});
      const [colourOpen, setColourOpen] = useState(null);
      const [eyedropper, setEyedropper] = useState(null);
      const [recent, setRecent] = useState([]);
      const [fbOpen, setFbOpen] = useState(false);
      const [fbEffect, setFbEffect] = useState('结论不可复现');
      const [fbSpec, setFbSpec] = useState(DEFAULT_FISHBONE_SPEC);

      const svgRef = useRef(null);
      const stageRef = useRef(null);
      const labelInputRef = useRef(null);
      const [focusLabel, setFocusLabel] = useState(null);
      const modelRef = useRef(null);
      const zoomRef = useRef(zoom);
      const zoomAnchor = useRef(null);
      const dragRef = useRef(null);
      const historyRef = useRef({ stack: [], index: -1 });

      useEffect(() => { modelRef.current = model; }, [model]);
      useEffect(() => { zoomRef.current = zoom; }, [zoom]);

      // Double-clicking a shape jumps into its text field instead of hunting for it.
      useEffect(() => {
        if (focusLabel === null) return;
        const field = labelInputRef.current;
        if (field) {
          field.focus();
          field.select();
        }
        setFocusLabel(null);
      }, [focusLabel]);

      /**
       * Wheel zoom keeps the point under the cursor still: remember where that
       * point sits inside the scrolling stage, then restore it after the size
       * change lands.
       */
      useEffect(() => {
        const stage = stageRef.current;
        if (!stage) return undefined;
        const onWheel = (event) => {
          if (event.ctrlKey && event.deltaY === 0) return;
          event.preventDefault();
          const factor = Math.exp(-event.deltaY * (event.shiftKey ? 0.0004 : 0.0015));
          const next = clampZoom(zoomRef.current * factor);
          if (Math.abs(next - zoomRef.current) < 0.002) return;
          const box = stage.getBoundingClientRect();
          zoomAnchor.current = {
            x: event.clientX - box.left + stage.scrollLeft,
            y: event.clientY - box.top + stage.scrollTop,
            cursorX: event.clientX - box.left,
            cursorY: event.clientY - box.top,
            zoom: zoomRef.current,
          };
          setZoom(next);
        };
        stage.addEventListener('wheel', onWheel, { passive: false });
        return () => stage.removeEventListener('wheel', onWheel);
      }, [model]);

      useEffect(() => {
        const stage = stageRef.current;
        const anchor = zoomAnchor.current;
        if (!stage || !anchor) return;
        zoomAnchor.current = null;
        const ratio = zoom / anchor.zoom;
        stage.scrollLeft = anchor.x * ratio - anchor.cursorX;
        stage.scrollTop = anchor.y * ratio - anchor.cursorY;
      }, [zoom]);

      /** Colours already used by the figure — the quickest palette to reuse. */
      const extracted = useMemo(() => {
        if (!model) return [];
        const list = [];
        const push = (colour) => {
          const clean = normalizeColour(colour);
          if (clean && list.indexOf(clean) === -1) list.push(clean);
        };
        if (model.background) push(model.background);
        model.nodes.forEach((node) => { push(node.fill); push(node.stroke); push(node.color); });
        model.edges.forEach((edge) => { push(edge.stroke); push(edge.labelColor); });
        return list;
      }, [model]);

      const remember = useCallback((next) => {
        const history = historyRef.current;
        const snapshot = JSON.stringify(next);
        if (history.stack[history.index] === snapshot) return;
        history.stack = history.stack.slice(0, history.index + 1).concat([snapshot]);
        if (history.stack.length > 60) history.stack.shift();
        history.index = history.stack.length - 1;
      }, []);

      const commit = useCallback((next) => {
        remember(next);
        setModel(next);
      }, [remember]);

      /** Canvas size: typed in pt, committed on blur or Enter. */
      const resizeCanvas = useCallback((axis, raw) => {
        const current = modelRef.current;
        if (current === null) return;
        const value = Math.max(20, Math.min(4000, Math.round(Number(raw))));
        if (!Number.isFinite(value) || Math.abs(current[axis] - value) < 0.5) return;
        commit({ ...current, [axis]: value });
      }, [commit]);

      /** Shrink the page to the drawing (plus a small margin). */
      const fitCanvas = useCallback(() => {
        const current = modelRef.current;
        if (current === null || current.nodes.length === 0) return;
        const margin = 8;
        const right = Math.max(...current.nodes.map((node) => node.x + node.w));
        const bottom = Math.max(...current.nodes.map((node) => node.y + node.h));
        const round = (value, pad) => Math.ceil((value + pad) / 2) * 2;
        commit({ ...current, w: round(right, margin), h: round(bottom, margin) });
      }, [commit]);

      /** Move the drawing so it sits in the middle of the page. */
      const centerCanvas = useCallback(() => {
        const current = modelRef.current;
        if (current === null || current.nodes.length === 0) return;
        const left = Math.min(...current.nodes.map((node) => node.x));
        const top = Math.min(...current.nodes.map((node) => node.y));
        const right = Math.max(...current.nodes.map((node) => node.x + node.w));
        const bottom = Math.max(...current.nodes.map((node) => node.y + node.h));
        const dx = Math.round(((current.w - (right - left)) / 2 - left) * 10) / 10;
        const dy = Math.round(((current.h - (bottom - top)) / 2 - top) * 10) / 10;
        if (Math.abs(dx) < 0.05 && Math.abs(dy) < 0.05) return;
        commit({
          ...current,
          nodes: current.nodes.map((node) => ({ ...node, x: node.x + dx, y: node.y + dy })),
        });
      }, [commit]);

      const undo = useCallback(() => {
        const history = historyRef.current;
        if (history.index <= 0) return;
        history.index -= 1;
        setModel(JSON.parse(history.stack[history.index]));
      }, []);

      const redo = useCallback(() => {
        const history = historyRef.current;
        if (history.index >= history.stack.length - 1) return;
        history.index += 1;
        setModel(JSON.parse(history.stack[history.index]));
      }, []);

      useEffect(() => {
        let cancelled = false;
        setModel(null);
        setError(null);
        setSelected(null);
        setMessage(null);
        setFindings([]);
        (async () => {
          try {
            let next = null;
            try {
              const stored = await getJSON(API + '/model?p=' + encodeURIComponent(path));
              if (stored && stored.model && Array.isArray(stored.model.nodes)) next = stored.model;
            } catch { /* no sidecar */ }
            if (next === null) {
              const response = await fetch(API + '/file?p=' + encodeURIComponent(path));
              if (!response.ok) throw new Error('读不到文件：HTTP ' + response.status);
              next = parseSvg(await response.text());
            }
            if (cancelled) return;
            historyRef.current = { stack: [JSON.stringify(next)], index: 0 };
            setModel(next);
          } catch (problem) {
            if (!cancelled) setError(String(problem && problem.message ? problem.message : problem));
          }
        })();
        return () => { cancelled = true; };
      }, [path]);

      const pointOf = useCallback((event) => {
        const element = svgRef.current;
        if (!element) return [0, 0];
        const rect = element.getBoundingClientRect();
        const scale = zoomRef.current;
        return [
          Math.round(((event.clientX - rect.left) / scale) * 10) / 10,
          Math.round(((event.clientY - rect.top) / scale) * 10) / 10,
        ];
      }, []);

      const rememberColour = useCallback((input) => {
        const clean = normalizeColour(input);
        if (!clean) return;
        setRecent((list) => [clean].concat(list.filter((c) => c !== clean)).slice(0, RECENT_MAX));
      }, []);

      /** Raster of the current model, used by the eyedropper. */
      const rasterRef = useRef({ key: null, canvas: null });
      const ensureRaster = useCallback(() => new Promise((resolve) => {
        const current = modelRef.current;
        if (!current) { resolve(null); return; }
        const key = JSON.stringify([current.w, current.h, current.background, current.nodes, current.edges]);
        if (rasterRef.current.key === key && rasterRef.current.canvas) {
          resolve(rasterRef.current);
          return;
        }
        const scale = 2;
        const blob = new Blob([svgFromModel(current)], { type: 'image/svg+xml;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const image = new Image();
        image.onload = () => {
          const surface = document.createElement('canvas');
          surface.width = Math.max(1, Math.round(current.w * scale));
          surface.height = Math.max(1, Math.round(current.h * scale));
          const ctx = surface.getContext('2d');
          ctx.fillStyle = current.background || '#ffffff';
          ctx.fillRect(0, 0, surface.width, surface.height);
          ctx.drawImage(image, 0, 0, surface.width, surface.height);
          URL.revokeObjectURL(url);
          rasterRef.current = { key, canvas: surface, scale };
          resolve(rasterRef.current);
        };
        image.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
        image.src = url;
      }), []);

      useEffect(() => {
        const move = (event) => {
          const drag = dragRef.current;
          const current = modelRef.current;
          if (!drag || !current) return;
          const point = pointOf(event);
          if (drag.mode === 'move') {
            const node = current.nodes.find((n) => n.id === drag.id);
            if (!node) return;
            const dx = point[0] - drag.origin[0];
            const dy = point[1] - drag.origin[1];
            const snappedX = event.shiftKey ? Math.round((drag.x + dx) / 10) * 10 : Math.round((drag.x + dx) * 10) / 10;
            const snappedY = event.shiftKey ? Math.round((drag.y + dy) / 10) * 10 : Math.round((drag.y + dy) * 10) / 10;
            const next = clone(current);
            const target = next.nodes.find((n) => n.id === drag.id);
            target.x = Math.max(0, Math.min(next.w - target.w, snappedX));
            target.y = Math.max(0, Math.min(next.h - target.h, snappedY));
            setModel(next);
          } else if (drag.mode === 'move-line') {
            const next = clone(current);
            const target = (next.lines ?? []).find((line) => line.id === drag.id);
            if (!target) return;
            const dx = point[0] - drag.origin[0];
            const dy = point[1] - drag.origin[1];
            target.points = drag.points.map(([x, y]) => [
              Math.round((x + dx) * 10) / 10,
              Math.round((y + dy) * 10) / 10,
            ]);
            setModel(next);
          } else if (drag.mode === 'move-label') {
            const next = clone(current);
            const target = next.nodes.find((n) => n.id === drag.id);
            if (!target) return;
            target.labelDx = Math.round((drag.dx + point[0] - drag.origin[0]) * 10) / 10;
            target.labelDy = Math.round((drag.dy + point[1] - drag.origin[1]) * 10) / 10;
            setModel(next);
          } else if (drag.mode === 'resize') {
            const next = clone(current);
            const target = next.nodes.find((n) => n.id === drag.id);
            if (!target) return;
            const centre = [drag.cx, drag.cy];
            const local = rotatePoint(point, centre, -(drag.rot || 0));
            const [hx, hy] = drag.handle;
            const right = drag.x + drag.w;
            const bottom = drag.y + drag.h;
            let x0 = drag.x;
            let y0 = drag.y;
            let x1 = right;
            let y1 = bottom;
            if (hx === 0) x0 = Math.min(local[0], right - 12);
            if (hx === 1) x1 = Math.max(local[0], drag.x + 12);
            if (hy === 0) y0 = Math.min(local[1], bottom - 10);
            if (hy === 1) y1 = Math.max(local[1], drag.y + 10);
            if (drag.rot) {
              // keep the pivot still, otherwise a rotated box slides while resizing
              x0 += centre[0] - (x0 + x1) / 2;
              y0 += centre[1] - (y0 + y1) / 2;
            }
            target.x = x0;
            target.y = y0;
            target.w = x1 - x0;
            target.h = y1 - y0;
            if (target.kind === 'text' && !target.wrap && drag.h > 0) {
              // a text object's size is its type size: dragging a corner scales it
              const ratio = target.h / drag.h;
              target.fs = Math.max(3, Math.min(48, Math.round((drag.fs ?? target.fs) * ratio * 10) / 10));
              target.w = Math.max(12, Math.round(measureLabel(target.label, target.fs, target.bold) + 6));
            }
            setModel(next);
          } else if (drag.mode === 'rotate') {
            const next = clone(current);
            const target = next.nodes.find((n) => n.id === drag.id);
            if (!target) return;
            const degrees = (Math.atan2(point[1] - drag.cy, point[0] - drag.cx) * 180) / Math.PI + 90;
            const angle = event.shiftKey ? Math.round(degrees / 15) * 15 : Math.round(degrees * 10) / 10;
            target.rot = ((angle % 360) + 360) % 360;
            setModel(next);
          } else if (drag.mode === 'edge') {
            setModel((previous) => {
              if (!previous) return previous;
              const next = clone(previous);
              next.preview = { from: drag.from, to: point };
              return next;
            });
          } else if (drag.mode === 'draw-line') {
            setModel((previous) => {
              if (!previous) return previous;
              const next = clone(previous);
              const [sx, sy] = drag.start;
              let ex = point[0];
              let ey = point[1];
              if (event.shiftKey) {
                // Shift locks the segment to the dominant axis.
                if (Math.abs(ex - sx) >= Math.abs(ey - sy)) ey = sy;
                else ex = sx;
              }
              next.previewLine = {
                points: [[sx, sy], [ex, ey]],
                dash: drag.variant.dash,
                arrow: drag.variant.arrow,
                arrowKind: 'block',
              };
              return next;
            });
          }
        };
        const up = (event) => {
          const drag = dragRef.current;
          const current = modelRef.current;
          dragRef.current = null;
          if (!drag || !current) return;
          if (drag.mode === 'edge') {
            const point = pointOf(event);
            const target = nodeAt(current, point);
            const next = clone(current);
            delete next.preview;
            if (target && target.id !== drag.from.id) {
              const source = next.nodes.find((n) => n.id === drag.from.id);
              next.edges.push({
                id: uid(next, 'e'),
                from: { id: drag.from.id, port: drag.from.port },
                to: { id: target.id, port: nearestPort(source, anchor(target, 'l')) },
                label: '',
                labelColor: MUTED,
                stroke: INK,
                sw: 1.1,
                dash: '',
                arrow: 'end',
                arrowKind: 'block',
                route: 'elbow',
              });
              commit(next);
            } else {
              setModel(next);
            }
            return;
          }
          if (drag.mode === 'draw-line') {
            const next = clone(current);
            const previewLine = next.previewLine;
            delete next.previewLine;
            const [a, b] = previewLine ? previewLine.points : [null, null];
            if (a && b && Math.hypot(b[0] - a[0], b[1] - a[1]) >= 6) {
              if (!Array.isArray(next.lines)) next.lines = [];
              const id = uid(next, 'l');
              next.lines.push({
                id,
                points: [a, b].map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]),
                stroke: INK,
                sw: 0.9,
                dash: previewLine.dash,
                arrow: previewLine.arrow,
                arrowKind: 'block',
              });
              commit(next);
              setSelected({ type: 'line', id });
              setTool('select');
            } else {
              setModel(next);
            }
            return;
          }
          const before = JSON.stringify(drag.before);
          if (before !== JSON.stringify(current)) commit(current);        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        return () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
        };
      }, [commit, pointOf]);

      const startMove = useCallback((event, node) => {
        if (tool !== 'select') return;
        event.stopPropagation();
        setSelected({ type: 'node', id: node.id });
        dragRef.current = {
          mode: 'move',
          id: node.id,
          origin: pointOf(event),
          x: node.x,
          y: node.y,
          before: clone(modelRef.current),
        };
      }, [pointOf, tool]);

      /** Drag a label away from its shape: the text moves, the box stays. */
      const startMoveLabel = useCallback((event, node) => {
        if (tool !== 'select') return;
        event.stopPropagation();
        setSelected({ type: 'node', id: node.id });
        dragRef.current = {
          mode: 'move-label',
          id: node.id,
          origin: pointOf(event),
          dx: Number(node.labelDx) || 0,
          dy: Number(node.labelDy) || 0,
          before: clone(modelRef.current),
        };
      }, [pointOf, tool]);

      /** A free segment (fishbone spine, bone, caliper) drags as a whole. */
      const startMoveLine = useCallback((event, line) => {
        if (tool !== 'select') return;
        event.stopPropagation();
        setSelected({ type: 'line', id: line.id });
        dragRef.current = {
          mode: 'move-line',
          id: line.id,
          origin: pointOf(event),
          points: line.points.map((point) => [point[0], point[1]]),
          before: clone(modelRef.current),
        };
      }, [pointOf, tool]);

      const startResize = useCallback((event, node, handle) => {
        event.stopPropagation();
        dragRef.current = {
          mode: 'resize',
          id: node.id,
          handle,
          x: node.x,
          y: node.y,
          w: node.w,
          h: node.h,
          rot: Number(node.rot) || 0,
          fs: node.fs,
          cx: node.x + node.w / 2,
          cy: node.y + node.h / 2,
          before: clone(modelRef.current),
        };
      }, []);

      const startRotate = useCallback((event, node) => {
        event.stopPropagation();
        setSelected({ type: 'node', id: node.id });
        dragRef.current = {
          mode: 'rotate',
          id: node.id,
          cx: node.x + node.w / 2,
          cy: node.y + node.h / 2,
          rot: Number(node.rot) || 0,
          before: clone(modelRef.current),
        };
      }, []);

      const startEdge = useCallback((event, node, port) => {
        event.stopPropagation();
        dragRef.current = {
          mode: 'edge',
          from: { id: node.id, port },
          before: clone(modelRef.current),
        };
      }, []);

      const addNode = useCallback((kind, point) => {
        const current = modelRef.current;
        if (!current) return;
        const next = clone(current);
        const sizes = {
          diamond: [44, 28], text: [40, 18], star: [36, 34], octagon: [40, 30], pentagon: [40, 30],
          callout: [52, 30], arrowBlock: [56, 28], multiDoc: [40, 30], internalStorage: [44, 28],
          umlActor: [26, 40], umlClass: [60, 40], umlObject: [60, 30], umlPackage: [56, 38],
          umlComponent: [56, 32], umlInterface: [56, 24], umlUseCase: [56, 26], umlState: [52, 26],
          umlInit: [14, 14], umlFinal: [14, 14], umlNote: [48, 30],
        };
        const [wide, tall] = sizes[kind] || [40, 22];
        const node = {
          id: uid(next, 'n'),
          kind,
          x: Math.round(point[0] - wide / 2),
          y: Math.round(point[1] - tall / 2),
          w: wide,
          h: tall,
          rot: 0,
          fill: kind === 'text' ? 'none' : (kind === 'term' || kind === 'ellipse' || kind === 'circle' ? '#eef2f7' : '#ffffff'),
          stroke: INK,
          sw: 0.56,
          dash: '',
          label: kind === 'diamond' ? 'cond?' : kind === 'text' ? '文字' : kind === 'umlActor' ? 'actor' : 'Label',
          fs: 7,
          color: INK,
          bold: false,
          italic: false,
        };
        next.nodes.push(node);
        commit(next);
        setSelected({ type: 'node', id: node.id });
        setTool('select');
        if (kind === 'text') setFocusLabel(node.id);
      }, [commit]);

      /**
       * Insert a fishbone into the figure being edited — the same builder the
       * panel uses, but dropped below the existing content and merged into the
       * model, so its bones and labels are ordinary editable objects.
       */
      /** Drop a standalone text object in the middle of the canvas and start typing. */
      const addText = useCallback(() => {
        const current = modelRef.current;
        if (!current) return;
        const next = clone(current);
        const node = {
          id: uid(next, 'n'),
          kind: 'text',
          wrap: false,
          align: 'center',
          lh: 1.25,
          x: Math.round(current.w / 2 - 40),
          y: Math.round(current.h / 2 - 9),
          w: 80,
          h: 18,
          rot: 0,
          fill: 'none',
          stroke: INK,
          sw: 0.56,
          dash: '',
          label: '\u6587\u5b57',
          fs: 8,
          color: INK,
          bold: false,
          italic: false,
        };
        next.nodes.push(node);
        commit(next);
        setSelected({ type: 'node', id: node.id });
        setFocusLabel(node.id);
        setMessage('\u8f93\u5165\u6587\u5b57\uff0c\u56de\u8f66\u786e\u8ba4\uff1b\u62d6\u56db\u89d2\u6539\u5927\u5c0f\uff0c\u5b57\u53f7\u8ddf\u7740\u53d8\u3002');
      }, [commit]);

      const insertFishbone = useCallback(() => {
        const current = modelRef.current;
        if (!current) return;
        const categories = parseFishboneSpec(fbSpec);
        if (!categories.length) {
          setMessage('没有解析到类别，格式是「类别: 原因1, 原因2」');
          return;
        }
        const built = buildFishbone({
          effect: fbEffect.trim() || '结果',
          categories,
          width: Math.max(240, Math.min(current.w - 24, 640)),
        });
        let minX = Infinity;
        let minY = Infinity;
        let maxY = -Infinity;
        for (const node of built.nodes) {
          minX = Math.min(minX, node.x);
          minY = Math.min(minY, node.y);
          maxY = Math.max(maxY, node.y + node.h);
        }
        for (const line of built.lines) {
          for (const [x, y] of line.points) {
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxY = Math.max(maxY, y);
          }
        }
        const bottoms = current.nodes.map((node) => node.y + node.h);
        for (const line of current.lines ?? []) for (const [, y] of line.points) bottoms.push(y);
        const top = bottoms.length
          ? Math.max(...bottoms) + 18
          : Math.max(12, (current.h - built.h) / 2);
        const dx = 12 - minX;
        const dy = top - minY;
        const next = clone(current);
        next.lines = next.lines ?? [];
        const round = (value) => Math.round(value * 10) / 10;
        for (const node of built.nodes) {
          next.nodes.push({ ...node, id: uid(next, 'n'), x: round(node.x + dx), y: round(node.y + dy) });
        }
        for (const line of built.lines) {
          next.lines.push({
            ...line,
            id: uid(next, 'l'),
            points: line.points.map(([x, y]) => [round(x + dx), round(y + dy)]),
          });
        }
        next.h = Math.max(next.h, Math.ceil(top + built.h + 12));
        next.w = Math.max(next.w, Math.ceil(24 + built.w));
        commit(next);
        setSelected(null);
        setFbOpen(false);
        setMessage('鱼骨图已插入，骨头和标签都可以直接拖。');
      }, [commit, fbEffect, fbSpec]);

      const removeSelected = useCallback(() => {
        const current = modelRef.current;
        if (!current || selected === null) return;
        const next = clone(current);
        if (selected.type === 'node') {
          next.nodes = next.nodes.filter((n) => n.id !== selected.id);
          next.edges = next.edges.filter((e) => e.from.id !== selected.id && e.to.id !== selected.id);
        } else if (selected.type === 'line') {
          next.lines = (next.lines ?? []).filter((l) => l.id !== selected.id);
        } else {
          next.edges = next.edges.filter((e) => e.id !== selected.id);
        }
        commit(next);
        setSelected(null);
      }, [commit, selected]);

      const patchSelected = useCallback((patch) => {
        const current = modelRef.current;
        if (!current || selected === null) return;
        const next = clone(current);
        const collection = selected.type === 'node' ? next.nodes
          : selected.type === 'line' ? (next.lines ?? []) : next.edges;
        const target = collection.find((entry) => entry.id === selected.id);
        if (!target) return;
        Object.assign(target, patch);
        if (selected.type === 'node' && patch.label !== undefined) {
          if (target.wrap) {
            // wrapped text keeps the width the author gave it and grows in height
            const count = textLines(target).length;
            target.h = Math.max(target.h, Math.round(count * lineHeightOf(target) + 2));
          } else {
            target.w = Math.max(target.w, Math.round(measureLabel(patch.label, target.fs, target.bold) + 14));
          }
        }
        commit(next);
      }, [commit, selected]);

      const sampleColour = useCallback(async (event) => {
        const target = eyedropper;
        if (!target) return;
        const point = pointOf(event);
        const raster = await ensureRaster();
        if (!raster) { setEyedropper(null); setMessage('取色失败：无法栅格化当前图'); return; }
        const ctx = raster.canvas.getContext('2d');
        const px = Math.round(point[0] * raster.scale);
        const py = Math.round(point[1] * raster.scale);
        if (px < 0 || py < 0 || px >= raster.canvas.width || py >= raster.canvas.height) return;
        const pixel = ctx.getImageData(px, py, 1, 1).data;
        const colour = rgbHex({ r: pixel[0], g: pixel[1], b: pixel[2] });
        rememberColour(colour);
        if (target === 'fill') patchSelected({ fill: colour });
        else if (target === 'text') patchSelected({ color: colour });
        else if (target === 'edge-label') patchSelected({ labelColor: colour });
        else patchSelected({ stroke: colour });
        setEyedropper(null);
      }, [eyedropper, ensureRaster, pointOf, rememberColour, patchSelected]);

      const save = useCallback(async () => {
        const current = modelRef.current;
        if (!current) return;
        setSaving(true);
        setMessage(null);
        try {
          const svg = svgFromModel(current);
          const result = await postJSON(API + '/save', { path, svg, model: { ...current, preview: undefined } });
          setFindings(collectFindings(result.report));
          setMessage(result.ok ? '已保存 ' + result.path : '已保存，但检查有阻断项');
          if (onSaved) onSaved(result.path);
        } catch (problem) {
          setMessage('保存失败：' + String(problem && problem.message ? problem.message : problem));
        } finally {
          setSaving(false);
        }
      }, [onSaved, path]);

      useEffect(() => {
        const handler = (event) => {
          const meta = event.ctrlKey || event.metaKey;
          if (meta && event.key.toLowerCase() === 'z') { event.preventDefault(); if (event.shiftKey) redo(); else undo(); return; }
          if (meta && event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); return; }
          if (meta && event.key.toLowerCase() === 's') { event.preventDefault(); save(); return; }
          if ((event.key === 'Delete' || event.key === 'Backspace') && selected !== null) { event.preventDefault(); removeSelected(); return; }
          if (event.key === 'Escape') { setSelected(null); setTool('select'); setEyedropper(null); setColourOpen(null); return; }
          if (selected !== null && selected.type === 'node' && event.key.startsWith('Arrow')) {
            event.preventDefault();
            const step = event.shiftKey ? 5 : 1;
            const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
            const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
            const current = modelRef.current;
            const node = current && current.nodes.find((n) => n.id === selected.id);
            if (node) patchSelected({ x: node.x + dx, y: node.y + dy });
          }
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
      }, [patchSelected, redo, removeSelected, save, selected, undo]);

      if (error !== null) {
        return h('div', { style: styles.root },
          h('div', { style: styles.row }, h('strong', null, '编辑器'), h('button', { style: styles.button, onClick: onClose }, '返回预览')),
          h('div', { style: styles.error }, error));
      }
      if (model === null) return h('div', { style: styles.root }, h('div', { style: styles.meta }, '载入中…'));

      const selectedNode = selected && selected.type === 'node' ? model.nodes.find((n) => n.id === selected.id) : null;
      const selectedEdge = selected && selected.type === 'edge' ? model.edges.find((e) => e.id === selected.id) : null;
      const selectedLine = selected && selected.type === 'line' ? (model.lines ?? []).find((l) => l.id === selected.id) : null;
      const scale = zoom;
      const handleSize = 6 / scale;
      const portRadius = 3.2 / scale;

      const shapeFor = (node) => {
        const geom = nodeGeom(node);
        const common = {
          fill: geom.fill ?? (geom.bare ? 'none' : node.fill),
          stroke: geom.bare ? 'none' : node.stroke,
          strokeWidth: node.sw,
          strokeDasharray: node.dash || undefined,
        };
        const handlers = {
          onPointerDown: (event) => startMove(event, node),
          style: { cursor: tool === 'select' ? 'move' : 'crosshair' },
        };
        const detail = (d, index) => h('path', {
          key: 'd' + index, d, fill: 'none', stroke: node.stroke, strokeWidth: node.sw,
          strokeDasharray: node.dash || undefined, pointerEvents: 'none',
        });
        const solid = (item, index) => h('path', {
          key: 's' + index, d: item.d, fill: item.fill, stroke: 'none', pointerEvents: 'none',
        });
        const fills = (geom.extraFills ?? []).map(solid);
        if (geom.shape === 'ellipse') {
          return h('g', { key: node.id },
            h('ellipse', { cx: geom.cx, cy: geom.cy, rx: geom.rx, ry: geom.ry, ...common, ...handlers }),
            geom.extra.map(detail),
            fills);
        }
        if (geom.shape === 'path') {
          return h('g', { key: node.id },
            h('path', { d: geom.d, ...common, ...handlers }),
            geom.extra.map(detail),
            fills);
        }
        return h('g', { key: node.id },
          h('rect', {
            x: geom.x, y: geom.y, width: geom.w, height: geom.h,
            rx: geom.rx || undefined, ...common, ...handlers,
          }),
          geom.extra.map(detail),
          fills);
      };

      const preview = model.preview;

      // One marker per (colour, head shape) pair actually used.
      const edMarkers = new Map();
      const registerMarker = (stroke, kind) => {
        if (!stroke || !kind || kind === 'none') return;
        const key = stroke + '|' + kind;
        if (!edMarkers.has(key)) edMarkers.set(key, { id: 'ed' + (edMarkers.size + 1), stroke, kind });
      };
      for (const edge of model.edges) {
        if (edge.arrow !== 'none') registerMarker(edge.stroke, edge.arrowKind || 'block');
      }
      for (const line of model.lines ?? []) {
        if (line.arrow && line.arrow !== 'none') registerMarker(line.stroke || INK, line.arrowKind || 'block');
      }
      const markerFor = (stroke, kind) => {
        const entry = edMarkers.get(stroke + '|' + (kind || 'block'));
        return entry ? 'url(#' + entry.id + ')' : undefined;
      };
      const markerForEdge = (edge) => markerFor(edge.stroke, edge.arrowKind);
      const headBody = (marker) => {
        if (marker.kind === 'open') {
          return h('path', { d: 'M0,1 L10,5 L0,9', fill: 'none', stroke: marker.stroke, strokeWidth: 1.5, strokeLinecap: 'round' });
        }
        if (marker.kind === 'diamond') {
          return h('path', { d: 'M0,5 L5,1 L10,5 L5,9 z', fill: marker.stroke });
        }
        if (marker.kind === 'dot') {
          return h('circle', { cx: 5, cy: 5, r: 4, fill: marker.stroke });
        }
        return h('path', { d: 'M0,1 L10,5 L0,9 z', fill: marker.stroke });
      };

      const canvas = h('svg', {
        ref: svgRef,
        width: model.w * scale,
        height: model.h * scale,
        viewBox: '0 0 ' + model.w + ' ' + model.h,
        style: {
          display: 'block',
          background: model.background ?? '#ffffff',
          userSelect: 'none',
          cursor: eyedropper ? 'crosshair' : undefined,
        },
        onPointerDown: (event) => {
          if (eyedropper) { sampleColour(event); return; }
          if (tool === 'select') { setSelected(null); return; }
          if (tool.startsWith('draw:')) {
            const variant = LINES.find((entry) => 'draw:' + entry.id === tool);
            if (variant) {
              dragRef.current = {
                mode: 'draw-line',
                variant,
                start: pointOf(event),
                before: clone(modelRef.current),
              };
            }
            return;
          }
          addNode(tool, pointOf(event));
        },
      },
      h('defs', null,
        Array.from(edMarkers.values()).map((marker) => {
          const head = ARROW_HEADS[marker.kind] || ARROW_HEADS.block;
          return h('marker', {
            key: marker.id, id: marker.id, viewBox: '0 0 10 10', refX: head.refX, refY: 5,
            markerWidth: head.size, markerHeight: head.size, orient: 'auto-start-reverse',
          }, headBody(marker));
        }),
        h('marker', {
          id: 'ed-preview', viewBox: '0 0 10 10', refX: 9.2, refY: 5,
          markerWidth: 4.6, markerHeight: 4.6, orient: 'auto-start-reverse',
        }, h('path', { d: 'M0,1 L10,5 L0,9 z', fill: 'rgba(64,132,255,.9)' })),
      ),
      (model.lines ?? []).map((line) => {
        const d = 'M' + line.points.map((p) => num(p[0]) + ',' + num(p[1])).join(' L');
        const active = selected !== null && selected.type === 'line' && selected.id === line.id;
        const head = line.arrow || 'none';
        const marker = head === 'none' ? undefined : markerFor(line.stroke || INK, line.arrowKind || 'block');
        return h('g', { key: 'l:' + line.id },
          h('path', {
            d,
            fill: 'none',
            stroke: line.stroke || INK,
            strokeWidth: line.sw ?? 0.9,
            strokeDasharray: line.dash || undefined,
            strokeLinecap: 'round',
            markerStart: head === 'start' || head === 'both' ? marker : undefined,
            markerEnd: head === 'end' || head === 'both' ? marker : undefined,
            pointerEvents: 'none',
          }),
          active
            ? h('path', {
              d, fill: 'none', stroke: 'rgba(64,132,255,.85)',
              strokeWidth: (line.sw ?? 0.9) + 2 / scale,
              strokeDasharray: '3 2', pointerEvents: 'none',
            })
            : null,
          h('path', {
            d,
            fill: 'none',
            stroke: 'transparent',
            strokeWidth: Math.max(7 / scale, (line.sw ?? 0.9) + 4 / scale),
            strokeLinecap: 'round',
            style: { cursor: tool === 'select' ? 'move' : 'crosshair' },
            onPointerDown: (event) => startMoveLine(event, line),
          }));
      }),
      model.previewLine
        ? h('path', {
          key: 'preview-line',
          d: 'M' + model.previewLine.points.map((p) => num(p[0]) + ',' + num(p[1])).join(' L'),
          fill: 'none',
          stroke: 'rgba(64,132,255,.85)',
          strokeWidth: 0.9,
          strokeDasharray: model.previewLine.dash || '3 2',
          pointerEvents: 'none',
        })
        : null,
      model.nodes.map((node) => h('g', {
        key: node.id,
        opacity: 1,
        transform: node.rot ? 'rotate(' + node.rot + ' ' + (node.x + node.w / 2) + ' ' + (node.y + node.h / 2) + ')' : undefined,
        onDoubleClick: (event) => {
          event.stopPropagation();
          setSelected({ type: 'node', id: node.id });
          setFocusLabel(node.id);
        },
      },
        shapeFor(node),
        node.label !== ''
          ? (() => {
            const spot = textLayout(node);
            // A pure text object is dragged by its glyphs; any other label can be
            // dragged once its shape is selected, which moves the text off the box.
            const bare = node.kind === 'text';
            const selectedHere = selected !== null && selected.type === 'node' && selected.id === node.id;
            const grab = bare || selectedHere;
            const lines = textLines(node);
            const step = lineHeightOf(node);
            const anchor = node.wrap
              ? ({ left: 'start', right: 'end' }[node.align ?? 'center'] ?? 'middle')
              : spot.anchor;
            const x = node.wrap ? lineAnchorX(node) : spot.x;
            const top = node.wrap ? firstBaseline(node, lines.length) : spot.y;
            const handlers = {
              pointerEvents: grab ? 'auto' : 'none',
              onPointerDown: grab
                ? (event) => (bare ? startMove(event, node) : startMoveLabel(event, node))
                : undefined,
              style: { fontFamily: FONT, cursor: grab && tool === 'select' ? 'move' : undefined },
            };
            return h('text', {
              fill: node.color,
              fontWeight: node.bold ? 600 : 400,
              fontStyle: node.italic ? 'italic' : 'normal',
              ...handlers,
            }, lines.map((line, index) => h('tspan', {
              key: index,
              x,
              y: top + index * step,
              fontSize: node.fs,
              textAnchor: anchor,
            }, line)));
          })()
          : null,
      )),
      model.edges.map((edge) => {
        const { d, points } = routeEdge(model, edge);
        const active = selected && selected.type === 'edge' && selected.id === edge.id;
        const hit = 'M' + points.map((p) => p[0] + ',' + p[1]).join(' L');
        return h('g', { key: edge.id },
          h('path', {
            d,
            fill: 'none',
            stroke: edge.stroke,
            strokeWidth: edge.sw,
            strokeDasharray: edge.dash || undefined,
            markerEnd: edge.arrow === 'none' ? undefined : markerForEdge(edge),
            markerStart: edge.arrow === 'both' ? markerForEdge(edge) : undefined,
            pointerEvents: 'none',
          }),
          h('path', {
            d: hit,
            fill: 'none',
            stroke: active ? 'rgba(64,132,255,.75)' : 'transparent',
            strokeWidth: Math.max(8 / scale, 4),
            style: { cursor: 'pointer' },
            onPointerDown: (event) => { event.stopPropagation(); setSelected({ type: 'edge', id: edge.id }); },
          }),
          edge.label
            ? h('text', {
              x: Math.abs(points[0][0] - points[points.length - 1][0]) < 0.6
                ? edgeMid(points)[0] + 4 : edgeMid(points)[0],
              y: Math.abs(points[0][0] - points[points.length - 1][0]) < 0.6
                ? edgeMid(points)[1] + 2 : edgeMid(points)[1] - 4.5,
              fontSize: 6.5,
              textAnchor: Math.abs(points[0][0] - points[points.length - 1][0]) < 0.6 ? 'start' : 'middle',
              fill: edge.labelColor || MUTED,
              fontStyle: 'italic',
              pointerEvents: 'none',
              style: { fontFamily: FONT },
            }, edge.label)
            : null,
        );
      }),
      preview
        ? h('line', {
          x1: anchor(model.nodes.find((n) => n.id === preview.from.id) ?? { x: 0, y: 0, w: 0, h: 0 }, preview.from.port)[0],
          y1: anchor(model.nodes.find((n) => n.id === preview.from.id) ?? { x: 0, y: 0, w: 0, h: 0 }, preview.from.port)[1],
          x2: preview.to[0],
          y2: preview.to[1],
          stroke: 'rgba(64,132,255,.9)',
          strokeWidth: 1 / scale,
          strokeDasharray: (4 / scale) + ' ' + (3 / scale),
          markerEnd: 'url(#ed-preview)',
          pointerEvents: 'none',
        })
        : null,
      selectedNode
        ? h('g', {
          pointerEvents: 'none',
          transform: selectedNode.rot
            ? 'rotate(' + selectedNode.rot + ' ' + (selectedNode.x + selectedNode.w / 2) + ' ' + (selectedNode.y + selectedNode.h / 2) + ')'
            : undefined,
        },
          h('rect', {
            x: selectedNode.x - 1 / scale,
            y: selectedNode.y - 1 / scale,
            width: selectedNode.w + 2 / scale,
            height: selectedNode.h + 2 / scale,
            fill: 'none',
            stroke: 'rgba(64,132,255,.9)',
            strokeWidth: 1 / scale,
            strokeDasharray: (3 / scale) + ' ' + (2 / scale),
          }),
          h('line', {
            x1: selectedNode.x + selectedNode.w / 2,
            y1: selectedNode.y,
            x2: selectedNode.x + selectedNode.w / 2,
            y2: selectedNode.y - 16 / scale,
            stroke: 'rgba(64,132,255,.9)',
            strokeWidth: 1 / scale,
          }),
          h('circle', {
            cx: selectedNode.x + selectedNode.w / 2,
            cy: selectedNode.y - 16 / scale,
            r: portRadius + 0.6 / scale,
            fill: '#fff',
            stroke: 'rgba(64,132,255,.95)',
            strokeWidth: 1 / scale,
            style: { cursor: 'grab' },
            pointerEvents: 'all',
            onPointerDown: (event) => startRotate(event, selectedNode),
          }),
          HANDLES.map(([name, fx, fy]) => h('rect', {
            key: name,
            x: selectedNode.x + selectedNode.w * fx - handleSize / 2,
            y: selectedNode.y + selectedNode.h * fy - handleSize / 2,
            width: handleSize,
            height: handleSize,
            fill: '#fff',
            stroke: 'rgba(64,132,255,.95)',
            strokeWidth: 1 / scale,
            style: { cursor: 'nwse-resize' },
            pointerEvents: 'all',
            onPointerDown: (event) => startResize(event, selectedNode, [fx, fy]),
          })),
          PORTS.map((port) => {
            const [px, py] = baseAnchor(selectedNode, port);
            return h('circle', {
              key: port,
              cx: px,
              cy: py,
              r: portRadius,
              fill: 'rgba(64,132,255,.95)',
              stroke: '#fff',
              strokeWidth: 1 / scale,
              style: { cursor: 'crosshair' },
              pointerEvents: 'all',
              onPointerDown: (event) => startEdge(event, selectedNode, port),
            });
          }),
        )
        : null,
      );

      const inspector = selectedNode
        ? h('div', { style: styles.root },
          h('div', { style: styles.row },
            h('span', { style: styles.label }, '文字'),
            selectedNode.kind === 'text'
              ? h('textarea', {
                ref: labelInputRef,
                style: { ...styles.field, minHeight: '46px', resize: 'vertical', fontFamily: FONT },
                value: selectedNode.label,
                onChange: (event) => patchSelected({ label: event.target.value }),
              })
              : h('input', {
                ref: labelInputRef,
                style: styles.field,
                value: selectedNode.label,
                onChange: (event) => patchSelected({ label: event.target.value }),
              }),
            h('button', {
              style: styles.small,
              title: '把文字挪回图形中间',
              onClick: () => patchSelected({ labelDx: 0, labelDy: 0 }),
            }, '文字复位'),
          ),
          selectedNode.kind === 'text'
            ? h('div', { style: styles.row },
              h('button', {
                style: selectedNode.wrap ? styles.primary : styles.button,
                title: '按框宽自动折行；拖四角改框，不改字号',
                onClick: () => patchSelected({
                  wrap: !selectedNode.wrap,
                  h: Math.max(selectedNode.h, Math.round(selectedNode.fs * (selectedNode.lh ?? 1.25) * 1.4 + 2)),
                }),
              }, '自动换行'),
              h('select', {
                style: { ...styles.field, width: 'auto' },
                value: selectedNode.align ?? 'center',
                disabled: !selectedNode.wrap,
                onChange: (event) => patchSelected({ align: event.target.value }),
              },
              h('option', { value: 'left' }, '左对齐'),
              h('option', { value: 'center' }, '居中'),
              h('option', { value: 'right' }, '右对齐'),
              ),
              h('span', { style: styles.label }, '行距'),
              h('input', {
                style: { ...styles.field, width: '56px' },
                type: 'number', step: '0.05', min: '0.8', max: '3',
                value: selectedNode.lh ?? 1.25,
                onChange: (event) => patchSelected({
                  lh: Math.max(0.8, Math.min(3, Number(event.target.value) || 1.25)),
                }),
              }),
            )
            : null,
          h('div', { style: styles.row },
            h('span', { style: styles.label }, '字号'),
            h('input', {
              style: { ...styles.field, width: '64px' },
              type: 'number', step: '0.5', min: '4', max: '24',
              value: selectedNode.fs,
              onChange: (event) => patchSelected({ fs: Number(event.target.value) || 7 }),
            }),
            h('button', {
              style: selectedNode.bold ? styles.primary : styles.button,
              onClick: () => patchSelected({ bold: !selectedNode.bold }),
            }, 'B'),
            h('button', {
              style: selectedNode.italic ? styles.primary : styles.button,
              onClick: () => patchSelected({ italic: !selectedNode.italic }),
            }, 'I'),
            h('span', { style: styles.label }, '形状'),
            h('select', {
              style: { ...styles.field, width: 'auto' },
              value: selectedNode.kind,
              onChange: (event) => patchSelected({ kind: event.target.value }),
            },
            ['流程', '数据', '基础', 'UML'].map((group) => h('optgroup', { key: group, label: group },
              SHAPES.filter((shape) => shape.group === group)
                .map((shape) => h('option', { key: shape.id, value: shape.id }, shape.label)))),
            ),
          ),
          h('div', { style: styles.row },
            h('span', { style: styles.label }, '旋转'),
            h('input', {
              style: { ...styles.field, width: '64px' },
              type: 'number', step: '15', min: '0', max: '359',
              value: Math.round(Number(selectedNode.rot) || 0),
              onChange: (event) => patchSelected({ rot: (((Number(event.target.value) || 0) % 360) + 360) % 360 }),
            }),
            h('button', {
              style: styles.button,
              title: '逆时针 15°',
              onClick: () => patchSelected({ rot: (((Number(selectedNode.rot) || 0) - 15) % 360 + 360) % 360 }),
            }, '↺'),
            h('button', {
              style: styles.button,
              title: '顺时针 15°',
              onClick: () => patchSelected({ rot: ((Number(selectedNode.rot) || 0) + 15) % 360 }),
            }, '↻'),
            h('button', {
              style: styles.button,
              title: '恢复水平',
              onClick: () => patchSelected({ rot: 0 }),
            }, '重置'),
          ),
          h('label', { style: { ...styles.row, gap: '6px', cursor: 'pointer' } },
            h('input', {
              type: 'checkbox',
              checked: Boolean(selectedNode.container),
              onChange: (event) => patchSelected({ container: event.target.checked }),
            }),
            h('span', { style: styles.meta }, '容器（可容纳其它图形，导出为 c: 组）'),
          ),
          h(ColorRow, {
            label: '填充',
            value: selectedNode.fill,
            onChange: (colour) => { rememberColour(colour); patchSelected({ fill: colour }); },
            open: colourOpen === 'node-fill',
            onToggle: () => setColourOpen(colourOpen === 'node-fill' ? null : 'node-fill'),
            recent,
            extracted,
            extra: [h('button', {
              style: eyedropper === 'fill' ? styles.primary : styles.button,
              title: '从画布上取色',
              onClick: () => setEyedropper(eyedropper === 'fill' ? null : 'fill'),
            }, '吸管')],
          }),
          h(ColorRow, {
            label: '描边',
            value: selectedNode.stroke,
            onChange: (colour) => { rememberColour(colour); patchSelected({ stroke: colour }); },
            open: colourOpen === 'node-stroke',
            onToggle: () => setColourOpen(colourOpen === 'node-stroke' ? null : 'node-stroke'),
            recent,
            extracted,
            extra: [h('button', {
              style: eyedropper === 'stroke' ? styles.primary : styles.button,
              title: '从画布上取色',
              onClick: () => setEyedropper(eyedropper === 'stroke' ? null : 'stroke'),
            }, '吸管')],
          }),
          h(ColorRow, {
            label: '文字色',
            value: selectedNode.color ?? INK,
            onChange: (colour) => { rememberColour(colour); patchSelected({ color: colour }); },
            open: colourOpen === 'node-color',
            onToggle: () => setColourOpen(colourOpen === 'node-color' ? null : 'node-color'),
            recent,
            extracted,
            extra: [h('button', {
              style: eyedropper === 'text' ? styles.primary : styles.button,
              title: '从画布上取色',
              onClick: () => setEyedropper(eyedropper === 'text' ? null : 'text'),
            }, '吸管')],
          }),
          h('div', { style: styles.row },
            h('span', { style: styles.label }, '线宽'),
            h('input', {
              style: { ...styles.field, width: '60px' },
              type: 'number', step: '0.1', min: '0',
              value: selectedNode.sw,
              onChange: (event) => patchSelected({ sw: Number(event.target.value) || 0.5 }),
            }),
            DASHES.map((entry) => h('button', {
              key: entry.id,
              title: entry.label,
              style: (selectedNode.dash || '') === entry.value ? styles.primary : styles.button,
              onClick: () => patchSelected({ dash: entry.value }),
            }, entry.label)),
            h('input', {
              style: { ...styles.field, width: '58px' },
              placeholder: '自定 3 2',
              value: selectedNode.dash,
              onChange: (event) => patchSelected({ dash: event.target.value }),
            }),
          ),
        )
        : selectedEdge
          ? h('div', { style: styles.root },
            h('div', { style: styles.row },
              h('span', { style: styles.label }, '标签'),
              h('input', {
                style: styles.field,
                value: selectedEdge.label,
                placeholder: '可留空',
                onChange: (event) => patchSelected({ label: event.target.value }),
              }),
            ),
            h('div', { style: styles.row },
              h('span', { style: styles.label }, '箭头'),
              h('select', {
                style: { ...styles.field, width: 'auto' },
                value: selectedEdge.arrow,
                onChange: (event) => patchSelected({ arrow: event.target.value }),
              },
              h('option', { value: 'end' }, '终点'),
              h('option', { value: 'both' }, '两端'),
              h('option', { value: 'start' }, '起点'),
              h('option', { value: 'none' }, '无'),
              ),
              h('span', { style: styles.label }, '箭头样式'),
              h('select', {
                style: { ...styles.field, width: 'auto' },
                value: selectedEdge.arrowKind || 'block',
                onChange: (event) => patchSelected({ arrowKind: event.target.value }),
              },
              ARROWS.map((entry) => h('option', { key: entry.id, value: entry.id }, entry.label)),
              ),
              h('span', { style: styles.label }, '走线'),
              h('select', {
                style: { ...styles.field, width: 'auto' },
                value: selectedEdge.route || 'elbow',
                onChange: (event) => patchSelected({ route: event.target.value }),
              },
              ROUTES.map((entry) => h('option', { key: entry.id, value: entry.id }, entry.label)),
              ),
            ),
            h(ColorRow, {
              label: '颜色',
              value: selectedEdge.stroke,
              onChange: (colour) => { rememberColour(colour); patchSelected({ stroke: colour }); },
              open: colourOpen === 'edge',
              onToggle: () => setColourOpen(colourOpen === 'edge' ? null : 'edge'),
              recent,
              extracted,
              extra: [h('button', {
                style: eyedropper === 'edge' ? styles.primary : styles.button,
                title: '从画布上取色',
                onClick: () => setEyedropper(eyedropper === 'edge' ? null : 'edge'),
              }, '吸管')],
            }),
            h(ColorRow, {
              label: '标签色',
              value: selectedEdge.labelColor || MUTED,
              onChange: (colour) => { rememberColour(colour); patchSelected({ labelColor: colour }); },
              open: colourOpen === 'edge-label',
              onToggle: () => setColourOpen(colourOpen === 'edge-label' ? null : 'edge-label'),
              recent,
              extracted,
              extra: [h('button', {
                style: eyedropper === 'edge-label' ? styles.primary : styles.button,
                title: '从画布上取色',
                onClick: () => setEyedropper(eyedropper === 'edge-label' ? null : 'edge-label'),
              }, '吸管')],
            }),
            h('div', { style: styles.row },
              h('span', { style: styles.label }, '线条'),
              DASHES.map((entry) => h('button', {
                key: entry.id,
                title: entry.label,
                style: (selectedEdge.dash || '') === entry.value ? styles.primary : styles.button,
                onClick: () => patchSelected({ dash: entry.value }),
              }, entry.label)),
              h('span', { style: styles.label }, '线宽'),
              h('input', {
                style: { ...styles.field, width: '56px' },
                type: 'number', step: '0.1', min: '0',
                value: selectedEdge.sw,
                onChange: (event) => patchSelected({ sw: Number(event.target.value) || 0.5 }),
              }),
              h('input', {
                style: { ...styles.field, width: '56px' },
                placeholder: '自定 3 2',
                value: selectedEdge.dash,
                onChange: (event) => patchSelected({ dash: event.target.value }),
              }),
            ),
          )
          : selectedLine
            ? h('div', { style: styles.root },
              h('div', { style: styles.row },
                h('span', { style: styles.label }, '线段'),
                h('span', { style: styles.meta }, '从 ('
                  + num(selectedLine.points[0][0]) + ', ' + num(selectedLine.points[0][1]) + ') 到 ('
                  + num(selectedLine.points[1][0]) + ', ' + num(selectedLine.points[1][1]) + ')'),
                h('span', { style: { flex: '1 1 auto' } }),
                h('button', { style: styles.button, onClick: removeSelected }, '删除'),
              ),
              h(ColorRow, {
                label: '颜色',
                value: selectedLine.stroke || INK,
                onChange: (colour) => { rememberColour(colour); patchSelected({ stroke: colour }); },
                open: colourOpen === 'line',
                onToggle: () => setColourOpen(colourOpen === 'line' ? null : 'line'),
                recent,
                extracted,
                extra: [h('button', {
                  style: eyedropper === 'line' ? styles.primary : styles.button,
                  title: '从画布上取色',
                  onClick: () => setEyedropper(eyedropper === 'line' ? null : 'line'),
                }, '吸管')],
              }),
              h('div', { style: styles.row },
                h('span', { style: styles.label }, '线条'),
                DASHES.map((entry) => h('button', {
                  key: entry.id,
                  title: entry.label,
                  style: (selectedLine.dash || '') === entry.value ? styles.primary : styles.button,
                  onClick: () => patchSelected({ dash: entry.value }),
                }, entry.label)),
                h('span', { style: styles.label }, '线宽'),
                h('input', {
                  style: { ...styles.field, width: '56px' },
                  type: 'number', step: '0.1', min: '0',
                  value: selectedLine.sw ?? 0.9,
                  onChange: (event) => patchSelected({ sw: Number(event.target.value) || 0.5 }),
                }),
              ),
              h('div', { style: styles.row },
                h('span', { style: styles.label }, '箭头'),
                h('select', {
                  style: styles.field,
                  value: selectedLine.arrow || 'none',
                  onChange: (event) => patchSelected({ arrow: event.target.value }),
                },
                  h('option', { value: 'none' }, '无'),
                  h('option', { value: 'end' }, '终点'),
                  h('option', { value: 'start' }, '起点'),
                  h('option', { value: 'both' }, '两端')),
                h('span', { style: styles.label }, '样式'),
                h('select', {
                  style: styles.field,
                  value: selectedLine.arrowKind || 'block',
                  onChange: (event) => patchSelected({ arrowKind: event.target.value }),
                }, ARROWS.map((entry) => h('option', { key: entry.id, value: entry.id }, entry.label))),
              ),
              h('div', { style: styles.meta }, '拖动这条线可以整体移动——鱼骨的脊线、斜骨和刻度都是这种线段。'),
            )
            : h('div', { style: styles.meta }, '点选一个方框或连线来改样式；从选中框四周的蓝点拖出可以拉一条新连线。');

      /** A 26×18 preview of a shape, used by the palette and the kind picker. */
      const shapeIcon = (kind) => {
        const sample = { x: 2, y: 2, w: 22, h: 14, kind, fill: '#e9eef6', stroke: '#3a4658', sw: 1, dash: '' };
        const geom = nodeGeom(sample);
        const common = { fill: geom.bare ? 'none' : sample.fill, stroke: sample.stroke, strokeWidth: 1 };
        const body = geom.shape === 'ellipse'
          ? h('ellipse', { cx: geom.cx, cy: geom.cy, rx: geom.rx, ry: geom.ry, ...common })
          : geom.shape === 'path'
            ? h('path', { d: geom.d, ...common })
            : h('rect', { x: geom.x, y: geom.y, width: geom.w, height: geom.h, rx: geom.rx || undefined, ...common });
        return h('svg', { key: kind, width: 26, height: 18, viewBox: '0 0 26 18' },
          body,
          geom.extra.map((d, index) => h('path', {
            key: index, d, fill: 'none', stroke: sample.stroke, strokeWidth: 1,
          })));
      };

      /** A 26×18 preview of a stand-alone line: dash pattern plus arrow heads. */
      const lineIcon = (variant) => {
        const ended = variant.arrow === 'end' || variant.arrow === 'both';
        const started = variant.arrow === 'both';
        return h('svg', { key: variant.id, width: 26, height: 18, viewBox: '0 0 26 18' },
          h('path', {
            d: 'M' + (started ? 6 : 3) + ',9 L' + (ended ? 20 : 23) + ',9',
            fill: 'none', stroke: '#3a4658', strokeWidth: 1,
            strokeDasharray: variant.dash || undefined,
          }),
          ended ? h('path', { d: 'M20,9 L16,6.6 L16,11.4 z', fill: '#3a4658' }) : null,
          started ? h('path', { d: 'M6,9 L10,6.6 L10,11.4 z', fill: '#3a4658' }) : null);
      };

      const palette = [...SHAPE_GROUPS, LINE_GROUP].map((group) => h('div', {
        key: group,
        style: { display: 'flex', alignItems: 'flex-start', gap: '4px', marginBottom: '2px' },
      },
      h('span', { style: { ...styles.meta, width: '26px', flex: '0 0 auto', paddingTop: '3px' } }, group),
      h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '3px' } },
        group === LINE_GROUP
          ? LINES.map((variant) => h('button', {
            key: variant.id,
            title: variant.label + '：在画布上拖出长度',
            onClick: () => setTool('draw:' + variant.id),
            style: {
              padding: '1px', lineHeight: 0, cursor: 'pointer', borderRadius: '3px',
              background: tool === 'draw:' + variant.id ? 'rgba(64,132,255,.16)' : 'transparent',
              border: tool === 'draw:' + variant.id ? '1px solid rgba(64,132,255,.85)' : '1px solid transparent',
            },
          }, lineIcon(variant)))
          : SHAPES.filter((shape) => shape.group === group).map((shape) => h('button', {
            key: shape.id,
            title: shape.label,
            onClick: () => setTool(shape.id),
            style: {
              padding: '1px', lineHeight: 0, cursor: 'pointer', borderRadius: '3px',
              background: tool === shape.id ? 'rgba(64,132,255,.16)' : 'transparent',
              border: tool === shape.id ? '1px solid rgba(64,132,255,.85)' : '1px solid transparent',
            },
          }, shapeIcon(shape.id))))));


      /** A pt field that only commits on blur or Enter, so typing is not undoable noise. */
      const sizeInput = (axis, hint) => {
        const value = Math.round(model[axis]);
        const draft = sizeDraft[axis];
        const apply = () => {
          const raw = draft === undefined ? String(value) : draft;
          resizeCanvas(axis, raw);
          setSizeDraft((previous) => {
            const next = { ...previous };
            delete next[axis];
            return next;
          });
        };
        return h('label', { style: { display: 'flex', alignItems: 'center', gap: '3px' } },
          h('span', { style: styles.meta }, hint),
          h('input', {
            style: { ...styles.field, width: '62px' },
            type: 'number', min: '20', max: '4000', step: '1',
            value: draft === undefined ? String(value) : draft,
            onFocus: () => setSizeDraft((previous) => ({ ...previous, [axis]: String(value) })),
            onChange: (event) => setSizeDraft((previous) => ({ ...previous, [axis]: event.target.value })),
            onBlur: apply,
            onKeyDown: (event) => { if (event.key === 'Enter') { event.preventDefault(); apply(); } },
          }));
      };

      return h('div', { style: styles.root },
        h('div', { style: styles.row },
          h('button', { style: styles.button, onClick: onClose }, '返回预览'),
          h('strong', { style: { flex: '1 1 auto', wordBreak: 'break-all' } }, path),
          h('button', { style: styles.primary, onClick: save, disabled: saving }, saving ? '保存中…' : '保存'),
        ),
        h('div', { style: styles.row },
          h('span', { style: styles.label }, '工具'),
          h('button', {
            style: tool === 'select' ? styles.primary : styles.button,
            onClick: () => setTool('select'),
          }, '选择'),
          h('span', { style: styles.meta }, '点图形后按 Delete 删除，拖蓝点连线'),
          h('button', {
            style: styles.button,
            title: '加一行独立文字：生成后直接打字，拖四角缩放字号',
            onClick: addText,
          }, '文字'),
          h('button', {
            style: fbOpen ? styles.primary : styles.button,
            title: '往这张图里插入一张鱼骨图（脊线、斜骨和刻度都是可拖动的线段）',
            onClick: () => setFbOpen(!fbOpen),
          }, '鱼骨图'),
          h('span', { style: { flex: '1 1 auto' } }),
          h('button', { style: styles.button, onClick: undo, title: 'Ctrl+Z' }, '↶'),
          h('button', { style: styles.button, onClick: redo, title: 'Ctrl+Shift+Z' }, '↷'),
          h('button', { style: styles.button, onClick: removeSelected, disabled: selected === null }, '删除'),
        ),
        h('div', { style: { padding: '2px 0 4px' } }, palette),
        fbOpen
          ? h('div', { style: { ...styles.row, alignItems: 'flex-start', flexWrap: 'wrap', gap: '6px', background: 'rgba(64,132,255,.10)', borderRadius: '6px', padding: '6px 8px' } },
            h('span', { style: styles.label }, '结果'),
            h('input', {
              style: { ...styles.field, width: '180px' },
              value: fbEffect,
              onChange: (event) => setFbEffect(event.target.value),
            }),
            h('textarea', {
              style: { ...styles.field, width: '100%', minHeight: '84px', fontFamily: 'inherit', fontSize: '12px' },
              value: fbSpec,
              onChange: (event) => setFbSpec(event.target.value),
            }),
            h('button', { style: styles.primary, onClick: insertFishbone }, '插入到这张图'),
            h('button', { style: styles.button, onClick: () => setFbSpec(DEFAULT_FISHBONE_SPEC) }, '恢复 6M 示例'),
            h('span', { style: styles.meta }, '每行「类别: 原因1, 原因2」，插到现有内容下方，之后当普通图形改。'))
          : null,
        eyedropper
          ? h('div', { style: { ...styles.row, background: 'rgba(64,132,255,.12)', borderRadius: '6px', padding: '4px 8px' } },
            h('span', null, '吸管：点击画布任意位置取色'),
            h('button', { style: styles.small, onClick: () => setEyedropper(null) }, '取消'))
          : null,
        h('div', { style: styles.canvas },
          h('div', { ref: stageRef, style: styles.stage },
            h('div', { style: styles.stageInner }, canvas))),
        h('div', { style: styles.row },
          h('span', { style: styles.label }, '画布'),
          sizeInput('w', '宽'),
          h('span', { style: styles.meta }, '×'),
          sizeInput('h', '高'),
          h('span', { style: styles.meta }, 'pt'),
          h('button', { style: styles.small, onClick: fitCanvas, title: '把画布缩到图形外沿（留 8pt 边）' }, '适应内容'),
          h('button', { style: styles.small, onClick: centerCanvas, title: '把图形挪到画布正中' }, '居中'),
          h('span', { style: { flex: '1 1 auto' } }),
          h('span', { style: styles.label }, '缩放'),
          h('button', {
            style: styles.small,
            onClick: () => setZoom((z) => clampZoom(Math.round((z - 0.25) * 100) / 100)),
            title: '滚轮也能缩放，以鼠标位置为中心',
          }, '－'),
          h('span', { style: styles.meta, title: '滚轮缩放，按住 Shift 微调' }, trimZoom(zoom) + '×'),
          h('button', { style: styles.small, onClick: () => setZoom((z) => clampZoom(Math.round((z + 0.25) * 100) / 100)) }, '＋'),
          h('button', { style: styles.small, onClick: () => setZoom(2), title: '回到 2×' }, '复位'),
        ),
        h('div', { style: styles.row },
          h('span', { style: { flex: '1 1 auto' } }),
          h('span', { style: styles.meta }, model.nodes.length + ' 个图形 · ' + model.edges.length + ' 条连线'),
        ),
        message !== null ? h('div', { style: styles.meta }, message) : null,
        findings.length > 0
          ? h('div', { style: styles.findings },
            findings.slice(0, 20).map((finding, index) => h('div', {
              key: index,
              style: styles.finding(finding.severity),
            }, '[' + finding.severity + '] ' + finding.message)))
          : null,
        h('div', { style: { borderTop: '1px solid rgba(127,127,127,.25)', paddingTop: '8px' } }, inspector),
      );
    }

    /* ------------------------------------------------------------ preview panel */

    const DEFAULT_FISHBONE_SPEC = [
      '人: 记录不完整, 复核缺失',
      '机: 采集延迟, 资源争抢',
      '料: 样本偏差, 标注漂移',
      '法: 口径不一致, 步骤遗漏',
      '测: 指标含糊, 阈值拍脑袋',
      '环: 环境变化, 依赖升级',
    ].join('\n');

    /**
     * A render error inside the tab would otherwise leave an empty pane with no
     * hint of what went wrong — show the message instead.
     */
    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
        this.retry = () => this.setState({ error: null });
      }

      static getDerivedStateFromError(error) {
        return { error };
      }

      render() {
        if (this.state.error) {
          const message = this.state.error && this.state.error.message
            ? this.state.error.message
            : String(this.state.error);
          return h('div', { style: styles.root },
            h('strong', null, '插图面板出错'),
            h('div', { style: styles.error }, message),
            h('button', { style: styles.button, onClick: this.retry }, '重试'));
        }
        return this.props.children;
      }
    }

    function Panel() {
      const [state, setState] = useState({ status: 'loading', root: '', figures: [], error: null });      const [selected, setSelected] = useState(null);
      const [scale, setScale] = useState(3);
      const [check, setCheck] = useState({ status: 'idle', ok: null, findings: [], error: null });
      const [busy, setBusy] = useState(false);
      const [editing, setEditing] = useState(false);
      const [stamp, setStamp] = useState(Date.now());
      const [importing, setImporting] = useState(false);
      const fileRef = useRef(null);

      const load = useCallback(async () => {
        setState((previous) => ({ ...previous, status: 'loading', error: null }));
        try {
          const data = await getJSON(API + '/list');
          setState({ status: 'ready', root: data.root || '', figures: data.figures || [], error: null });
          setSelected((current) => current ?? (data.figures && data.figures[0] ? data.figures[0].path : null));
        } catch (error) {
          setState({ status: 'error', root: '', figures: [], error: String(error && error.message ? error.message : error) });
        }
      }, []);

      useEffect(() => { load(); }, [load]);

      const previewUrl = useMemo(() => {
        if (selected === null) return null;
        return API + '/preview?scale=' + scale + '&p=' + encodeURIComponent(selected) + '&t=' + stamp;
      }, [selected, scale, stamp]);

      const runCheck = useCallback(async () => {
        if (selected === null) return;
        setBusy(true);
        setCheck({ status: 'running', ok: null, findings: [], error: null });
        try {
          const data = await getJSON(API + '/check?p=' + encodeURIComponent(selected));
          setCheck({ status: 'done', ok: data.ok === true, findings: collectFindings(data.report), error: null });
        } catch (error) {
          setCheck({ status: 'error', ok: null, findings: [], error: String(error && error.message ? error.message : error) });
        } finally {
          setBusy(false);
        }
      }, [selected]);

      const exportPdf = useCallback(() => {
        if (selected === null) return;
        window.open(API + '/pdf?p=' + encodeURIComponent(selected), '_blank');
      }, [selected]);

      const exportDrawio = useCallback(() => {
        if (selected === null) return;
        window.open(API + '/drawio?p=' + encodeURIComponent(selected), '_blank');
      }, [selected]);

      const copyPath = useCallback(() => {
        if (selected === null) return;
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(selected).catch(() => {});
        }
      }, [selected]);

      /** Open a figure that lives outside the workspace. */
      const pickFile = useCallback(() => {
        if (fileRef.current !== null) {
          fileRef.current.value = '';
          fileRef.current.click();
        }
      }, []);

      const onFilePicked = useCallback(async (event) => {
        const file = event.target.files && event.target.files[0];
        if (!file) return;
        setImporting(true);
        setState((previous) => ({ ...previous, error: null }));
        try {
          const text = await file.text();
          if (!text.includes('<svg')) {
            throw new Error('这个文件里没有 <svg>，请选一张 SVG 图。');
          }
          const saved = await postJSON(API + '/import', { name: file.name, svg: text });
          const data = await getJSON(API + '/list');
          setState({ status: 'ready', root: data.root || '', figures: data.figures || [], error: null });
          setSelected(saved.path);
          setEditing(true);
        } catch (error) {
          setState((previous) => ({
            ...previous,
            status: previous.figures.length > 0 ? previous.status : 'ready',
            error: String(error && error.message ? error.message : error),
          }));
        } finally {
          setImporting(false);
        }
      }, []);

      if (editing && selected !== null) {
        return h(Editor, {
          path: selected,
          onClose: () => { setEditing(false); load(); },
          onSaved: () => { setStamp(Date.now()); setCheck({ status: 'idle', ok: null, findings: [], error: null }); },
        });
      }

      const figures = state.figures;

      const current = figures.find((figure) => figure.path === selected) || null;

      return h('div', { style: styles.root },
        h('input', {
          ref: fileRef,
          type: 'file',
          accept: '.svg,image/svg+xml',
          style: { display: 'none' },
          onChange: onFilePicked,
        }),
        h('div', { style: styles.row },
          h('strong', null, TAB_TITLE),
          h('button', { style: styles.button, onClick: load, title: '重新扫描工作区' }, '刷新'),
          h('button', {
            style: styles.button,
            onClick: pickFile,
            disabled: importing,
            title: '从电脑里选一张 SVG 打开（会复制到工作区 figures/imported/）',
          }, importing ? '读取…' : '打开文件'),
          h('span', { style: { flex: '1 1 auto' } }),
          h('button', {
            style: styles.primary,
            onClick: () => setEditing(true),
            disabled: selected === null,
            title: '在侧栏里直接编辑这张图',
          }, '编辑'),
        ),
        state.status === 'ready' && state.root !== '' ? h('div', { style: styles.meta }, '工作区：' + state.root) : null,
        state.status === 'error' ? h('div', { style: styles.error }, state.error) : null,
        state.status === 'loading' ? h('div', { style: styles.meta }, '扫描中…') : null,
        state.status === 'ready' && figures.length === 0
          ? h('div', { style: styles.meta }, '工作区里还没有 .svg 图。让模型画一张，或把图保存到工作区后点“刷新”。')
          : null,
        figures.length > 0
          ? h('div', { style: styles.list },
            figures.map((figure) => h('button', {
              key: figure.path,
              style: styles.item(figure.path === selected),
              onClick: () => {
                setSelected(figure.path);
                setCheck({ status: 'idle', ok: null, findings: [], error: null });
              },
              title: figure.path,
            },
            h('span', null, figure.name),
            h('span', { style: styles.meta }, figure.path),
            )),
          )
          : null,
        h('div', { style: styles.row },
          h('span', { style: styles.meta }, '倍率'),
          [1, 2, 3, 4, 6].map((value) => h('button', {
            key: value,
            style: value === scale ? styles.primary : styles.button,
            onClick: () => setScale(value),
          }, value + '×')),
        ),
        h('div', { style: styles.stage },
          previewUrl !== null && selected !== null
            ? h('img', { src: previewUrl, style: styles.img, alt: current ? current.name : 'preview' })
            : h('span', { style: styles.meta }, '选择一张图以预览'),
        ),
        h('div', { style: styles.row },
          h('button', { style: styles.primary, onClick: runCheck, disabled: busy || selected === null }, busy ? '检查中…' : '检查'),
          h('button', { style: styles.button, onClick: exportPdf, disabled: selected === null }, '导出 PDF'),
          h('button', { style: styles.button, onClick: exportDrawio, disabled: selected === null }, '导出 .drawio'),
          h('button', { style: styles.button, onClick: copyPath, disabled: selected === null }, '复制路径'),
        ),
        check.status === 'error' ? h('div', { style: styles.error }, check.error) : null,
        check.status === 'done'
          ? h('div', null,
            h('div', { style: { marginBottom: '5px' } },
              check.ok ? '检查通过（无阻断性问题）' : '检查发现阻断性问题',
              check.findings.length > 0 ? ' · ' + check.findings.length + ' 条' : '',
            ),
            check.findings.length > 0
              ? h('div', { style: styles.findings },
                check.findings.slice(0, 40).map((finding, index) => h('div', {
                  key: index,
                  style: styles.finding(finding.severity),
                }, '[' + finding.severity + '] ' + finding.message)))
              : null,
          )
          : null,
      );
    }

    function Title() {
      return h('span', null, TAB_TITLE);
    }

    const pluginName = 'figgenie-preview';

    function apply(ctx) {
      try {
        ctx.inject(['sidebarRightTabs'], (client) => {
          const tabs = client.sidebarRightTabs;
          if (tabs === undefined || typeof tabs.register !== 'function') return;
          const disposers = [];
          try {
            disposers.push(tabs.register({
              id: TAB_ID,
              kind: TAB_KIND,
              title: () => TAB_TITLE,
              guide: [{
                id: TAB_ID,
                order: 30,
                title: () => TAB_TITLE,
                description: () => '预览工作区的 SVG 插图，运行排版检查，并直接在画布里改方框、连线与文字',
              }],
            }));
            disposers.push(client.slots.inject('sidebar.right.pane.tab', () => client.slots.register({
              name: 'sidebar.right.pane.tab',
              key: TAB_ID,
            }, () => h(PanelBoundary, null, h(Panel)))));
            disposers.push(client.slots.inject('sidebar.right.pane.tab.title', () => client.slots.register({
              name: 'sidebar.right.pane.tab.title',
              key: TAB_ID,
            }, Title)));
          } catch (error) {
            console.warn('[figgenie] preview tab registration failed:', error);
            for (const dispose of disposers) { try { dispose(); } catch { /* gone */ } }
            return;
          }
          return () => {
            for (const dispose of disposers) { try { dispose(); } catch { /* gone */ } }
          };
        });
      } catch (error) {
        console.warn('[figgenie] preview tab unavailable:', error);
      }
    }

    return {
      name: pluginName,
      inject: ['slots'],
      apply,
      /** Exposed for the offline round-trip check; not part of the client API. */
      __test: { svgFromModel, parseSvg, routeEdge, hexRgb, rgbHex, rgbHsv, hsvRgb, buildFishbone, parseFishboneSpec },
    };
  },
});
