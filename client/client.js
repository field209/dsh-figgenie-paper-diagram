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
        border: '1px solid rgba(127,127,127,.28)',
        borderRadius: '6px',
        background: '#fff',
        overflow: 'auto',
        maxHeight: '58vh',
        position: 'relative',
        outline: 'none',
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
      const a = anchor(from, edge.from.port);
      const b = anchor(to, edge.to.port);
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
      const spot = textLayout(node);
      return '<text x="' + num(spot.x) + '" y="' + num(spot.y)
        + '" font-size="' + num(node.fs) + '" text-anchor="' + spot.anchor + '" fill="' + node.color + '"' + weight + italic + '>'
        + esc(node.label) + '</text>';
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
      const markerFor = (edge) => {
        const kind = edge.arrowKind || 'block';
        if (edge.arrow === 'none' || kind === 'none') return null;
        const key = edge.stroke + '|' + kind;
        if (!markers.has(key)) markers.set(key, { id: 'arw' + (markers.size + 1), stroke: edge.stroke, kind });
        return markers.get(key).id;
      };
      for (const edge of model.edges) markerFor(edge);
      const idFor = (edge) => markerFor(edge);
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
      for (const node of model.nodes) {
        const box = num(node.x) + ',' + num(node.y) + ',' + num(node.w) + ',' + num(node.h);
        const prefix = node.container ? 'c:' : 'n:';
        const kind = node.container ? 'container' : 'node';
        lines.push('  <g id="' + prefix + node.id + '" data-kind="' + kind + '" data-shape="' + node.kind
          + '" data-box="' + box + '"' + rotationOf(node) + '>');
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
        const text = Array.from(group.children).find((child) => child.tagName.toLowerCase() === 'text');
        if (!shape) continue;
        const tag = shape.tagName.toLowerCase();
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
        return text.length * size * 0.55;
      }
    }

    /* ------------------------------------------------------------ editor */

    const HANDLES = [
      ['nw', 0, 0], ['n', 0.5, 0], ['ne', 1, 0], ['e', 1, 0.5],
      ['se', 1, 1], ['s', 0.5, 1], ['sw', 0, 1], ['w', 0, 0.5],
    ];

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

      const svgRef = useRef(null);
      const modelRef = useRef(null);
      const zoomRef = useRef(zoom);
      const dragRef = useRef(null);
      const historyRef = useRef({ stack: [], index: -1 });

      useEffect(() => { modelRef.current = model; }, [model]);
      useEffect(() => { zoomRef.current = zoom; }, [zoom]);

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
          const before = JSON.stringify(drag.before);
          if (before !== JSON.stringify(current)) commit(current);
        };
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
      }, [commit]);

      const removeSelected = useCallback(() => {
        const current = modelRef.current;
        if (!current || selected === null) return;
        const next = clone(current);
        if (selected.type === 'node') {
          next.nodes = next.nodes.filter((n) => n.id !== selected.id);
          next.edges = next.edges.filter((e) => e.from.id !== selected.id && e.to.id !== selected.id);
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
        const collection = selected.type === 'node' ? next.nodes : next.edges;
        const target = collection.find((entry) => entry.id === selected.id);
        if (!target) return;
        Object.assign(target, patch);
        if (selected.type === 'node' && patch.label !== undefined) {
          target.w = Math.max(target.w, Math.round(measureLabel(patch.label, target.fs, target.bold) + 14));
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
      for (const edge of model.edges) {
        const kind = edge.arrowKind || 'block';
        if (edge.arrow === 'none' || kind === 'none') continue;
        const key = edge.stroke + '|' + kind;
        if (!edMarkers.has(key)) edMarkers.set(key, { id: 'ed' + (edMarkers.size + 1), stroke: edge.stroke, kind });
      }
      const markerForEdge = (edge) => {
        const entry = edMarkers.get(edge.stroke + '|' + (edge.arrowKind || 'block'));
        return entry ? 'url(#' + entry.id + ')' : undefined;
      };
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
      model.nodes.map((node) => h('g', {
        key: node.id,
        opacity: 1,
        transform: node.rot ? 'rotate(' + node.rot + ' ' + (node.x + node.w / 2) + ' ' + (node.y + node.h / 2) + ')' : undefined,
      },
        shapeFor(node),
        node.label !== ''
          ? (() => {
            const spot = textLayout(node);
            return h('text', {
              x: spot.x,
              y: spot.y,
              fontSize: node.fs,
              textAnchor: spot.anchor,
              fill: node.color,
              fontWeight: node.bold ? 600 : 400,
              fontStyle: node.italic ? 'italic' : 'normal',
              pointerEvents: 'none',
              style: { fontFamily: FONT },
            }, node.label);
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
            h('input', {
              style: styles.field,
              value: selectedNode.label,
              onChange: (event) => patchSelected({ label: event.target.value }),
            }),
          ),
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

      const palette = SHAPE_GROUPS.map((group) => h('div', {
        key: group,
        style: { display: 'flex', alignItems: 'flex-start', gap: '4px', marginBottom: '2px' },
      },
      h('span', { style: { ...styles.meta, width: '26px', flex: '0 0 auto', paddingTop: '3px' } }, group),
      h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '3px' } },
        SHAPES.filter((shape) => shape.group === group).map((shape) => h('button', {
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
          h('span', { style: { flex: '1 1 auto' } }),
          h('button', { style: styles.button, onClick: undo, title: 'Ctrl+Z' }, '↶'),
          h('button', { style: styles.button, onClick: redo, title: 'Ctrl+Shift+Z' }, '↷'),
          h('button', { style: styles.button, onClick: removeSelected, disabled: selected === null }, '删除'),
        ),
        h('div', { style: { padding: '2px 0 4px' } }, palette),
        eyedropper
          ? h('div', { style: { ...styles.row, background: 'rgba(64,132,255,.12)', borderRadius: '6px', padding: '4px 8px' } },
            h('span', null, '吸管：点击画布任意位置取色'),
            h('button', { style: styles.small, onClick: () => setEyedropper(null) }, '取消'))
          : null,
        h('div', { style: styles.canvas }, canvas),
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
          h('button', { style: styles.small, onClick: () => setZoom((z) => Math.max(0.5, Math.round((z - 0.5) * 10) / 10)) }, '－'),
          h('span', { style: styles.meta }, zoom.toFixed(1) + '×'),
          h('button', { style: styles.small, onClick: () => setZoom((z) => Math.min(6, Math.round((z + 0.5) * 10) / 10)) }, '＋'),
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

    function Panel() {
      const [state, setState] = useState({ status: 'loading', root: '', figures: [], error: null });
      const [selected, setSelected] = useState(null);
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
            }, () => h(Panel))));
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
      __test: { svgFromModel, parseSvg, routeEdge, hexRgb, rgbHex, rgbHsv, hsvRgb },
    };
  },
});
