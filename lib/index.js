/**
 * figgenie-paper-diagram — a DSH bundle that provides the FigGenie skill and a
 * preview surface for the figures it draws.
 *
 * Host side: the skill provider (session catalog) plus five `/dsh-figgenie/*`
 * routes the sidebar panel uses to list, render, check and export figures.
 * Client side: `client/client.js` registers the right-sidebar tab.
 */
import { readFileSync, readdirSync, statSync, mkdirSync, createReadStream, writeFileSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, sep, extname, resolve, relative, isAbsolute, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

/** Cordis plugin identity. */
export const name = 'figgenie-paper-diagram';

/** Registries used by this plugin. */
export const inject = ['skills'];

/** Skill directory name under `assets/`. */
const SKILL_NAME = 'figgenie-paper-diagram';

/** Standard precedence rank for packaged skill providers. */
const SKILL_RANK = 600;

/** Provider label reported in the session skill catalog. */
const PROVIDER = 'figgenie';

const DESCRIPTION =
  'Draw publication-quality paper figures as SVG the way top venues draw them — ' +
  'systems architecture and mechanism figures (OSDI/NSDI/SOSP/ASPLOS) and AI-venue ' +
  'Figure 1 / teaser / pipeline figures (ICLR/ICML/NeurIPS/CVPR/ACL/AAAI). ' +
  'Workflow: brief → figure spec → hand-drawn SVG → render/lint → caption. ' +
  '中文：画论文插图、架构图、机制图、Figure 1、原理图、示意图，或把已有图重画成顶会风格。';

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u;

const assetRoot = fileURLToPath(new URL('../assets/', import.meta.url));
const scriptsRoot = join(assetRoot, SKILL_NAME, 'scripts');

function readSkill(skillName) {
  const directory = join(assetRoot, skillName);
  const locator = join(directory, 'SKILL.md');
  const raw = readFileSync(locator, 'utf8');
  const match = FRONTMATTER.exec(raw);
  return {
    directory,
    locator,
    content: (match === null ? raw : raw.slice(match[0].length)).trim(),
  };
}

function registerSkill(ctx) {
  const initial = readSkill(SKILL_NAME);
  const candidate = {
    name: SKILL_NAME,
    description: DESCRIPTION,
    invocation: { modelInvocable: true, userInvocable: true },
    provider: PROVIDER,
    source: 'bundled',
    rank: SKILL_RANK,
    resourceBase: { kind: 'directory', path: initial.directory.split(sep).join('/') },
    locator: initial.locator,
  };

  const provider = {
    name: PROVIDER,
    list: () => Promise.resolve([candidate]),
    async get(entry) {
      const { rank: _rank, locator, ...summary } = entry;
      const fresh = readSkill(entry.name);
      return { ...summary, locator, content: fresh.content };
    },
  };

  ctx.skills.registerProvider(() => provider);
}

/* ------------------------------------------------------------------ preview */

const MIME = {
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.pdf': 'application/pdf',
  '.drawio': 'application/xml; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '__pycache__', 'site-packages', 'venv', '.venv']);

/** Hidden directories and files are never figure sources. */
function isHidden(name) {
  return name.startsWith('.');
}

/** Run a python script and collect stdout/stderr. */
function runPython(python, args, options = {}) {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(python, args, { windowsHide: true, cwd: options.cwd });
    } catch (error) {
      resolvePromise({ code: -1, stdout: '', stderr: String(error) });
      return;
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
    }, options.timeout ?? 120_000);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolvePromise({ code: -1, stdout, stderr: String(error) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    });
  });
}

/** Keep a client-supplied relative path inside the configured root. */
function containedFile(root, requested) {
  const full = resolve(root, requested);
  const rel = relative(root, full);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
  try {
    const stat = statSync(full);
    return stat.isFile() ? { full, stat } : null;
  } catch {
    return null;
  }
}

/** Walk the workspace for figure sources, newest first. */
function listFigures(root, limit = 300) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 6 || found.length >= limit) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (found.length >= limit) return;
      const full = join(dir, entry.name);
      if (isHidden(entry.name)) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(full, depth + 1);
        continue;
      }
      const ext = extname(entry.name).toLowerCase();
      if (ext !== '.svg' && ext !== '.drawio') continue;
      try {
        const stat = statSync(full);
        found.push({
          path: relative(root, full).split(sep).join('/'),
          name: entry.name,
          ext,
          size: stat.size,
          mtime: stat.mtimeMs,
        });
      } catch { /* vanished */ }
    }
  };
  walk(root, 0);
  found.sort((a, b) => b.mtime - a.mtime);
  return found;
}

function sendJSON(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * Register the `/dsh-figgenie/*` routes.
 * @param ctx - Context carrying the web server.
 * @param config - `{ root, python, cacheDir }`.
 */
function registerRoutes(ctx, config) {
  // The marketplace build ships no machine-specific path: the scan root falls
  // back to the host's working directory (the open workspace) and can be pinned
  // to an absolute path through the plugin's `root` config.
  const root = config.root === undefined || config.root === ''
    ? (process.env.DSH_WORKSPACE ?? process.cwd())
    : resolve(config.root);
  const python = config.python ?? (process.platform === 'win32' ? 'py' : 'python3');
  const cacheDir = resolve(config.cacheDir ?? join(tmpdir(), 'dsh-figgenie-previews'));
  try { mkdirSync(cacheDir, { recursive: true }); } catch { /* read-only tmp */ }

  const route = (path, handler) => ({ kind: 'prefix', path, handler });

  const list = (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const dirParam = url.searchParams.get('dir');
    const base = dirParam === null ? root : resolve(root, dirParam);
    if (relative(root, base).startsWith('..')) return sendJSON(res, 403, { error: 'outside workspace' });
    try {
      return sendJSON(res, 200, { root, dir: base, figures: listFigures(base) });
    } catch (error) {
      return sendJSON(res, 500, { error: String(error) });
    }
  };

  const file = (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const target = containedFile(root, url.searchParams.get('p') ?? '');
    if (target === null) return sendJSON(res, 404, { error: 'not found' });
    const type = MIME[extname(target.full).toLowerCase()] ?? 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'content-length': target.stat.size, 'cache-control': 'no-store' });
    createReadStream(target.full).pipe(res);
  };

  const preview = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const requested = url.searchParams.get('p') ?? '';
    const scale = Math.min(Math.max(Number(url.searchParams.get('scale') ?? '3') || 3, 1), 8);
    const target = containedFile(root, requested);
    if (target === null) return sendJSON(res, 404, { error: 'not found' });
    if (extname(target.full).toLowerCase() !== '.svg') return sendJSON(res, 415, { error: 'only .svg can be rendered' });

    const key = requested.replace(/[^a-zA-Z0-9._-]+/g, '_') + '.' + scale + '.' + Math.round(target.stat.mtimeMs) + '.png';
    const out = join(cacheDir, key);
    try {
      const cached = statSync(out);
      if (cached.isFile() && cached.mtimeMs >= target.stat.mtimeMs) {
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': cached.size, 'cache-control': 'no-store' });
        createReadStream(out).pipe(res);
        return;
      }
    } catch { /* not cached yet */ }

    const result = await runPython(python, [join(scriptsRoot, 'render.py'), target.full, '-o', out, '--scale', String(scale)]);
    if (result.code !== 0) {
      return sendJSON(res, 500, { error: 'render failed', code: result.code, stderr: result.stderr.slice(-4000), stdout: result.stdout.slice(-2000) });
    }
    try {
      const stat = statSync(out);
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': stat.size, 'cache-control': 'no-store' });
      createReadStream(out).pipe(res);
    } catch {
      sendJSON(res, 500, { error: 'render produced no file' });
    }
  };

  const check = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const target = containedFile(root, url.searchParams.get('p') ?? '');
    if (target === null) return sendJSON(res, 404, { error: 'not found' });
    const out = join(cacheDir, 'lint-' + process.pid + '-' + Date.now() + '.json');
    const args = [join(scriptsRoot, 'lint.py'), target.full, '--report', out, '--quiet'];
    const spec = url.searchParams.get('spec');
    if (spec !== null) {
      const specFile = containedFile(root, spec);
      if (specFile !== null) args.push('--spec', specFile.full);
    }
    const result = await runPython(python, args);
    let report = null;
    try { report = JSON.parse(readFileSync(out, 'utf8')); } catch { /* no report */ }
    return sendJSON(res, 200, {
      ok: result.code === 0,
      code: result.code,
      report,
      stderr: result.stderr.slice(-4000),
    });
  };

  const pdf = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const target = containedFile(root, url.searchParams.get('p') ?? '');
    if (target === null) return sendJSON(res, 404, { error: 'not found' });
    const out = join(cacheDir, 'export-' + process.pid + '-' + Date.now() + '.pdf');
    const result = await runPython(python, [join(scriptsRoot, 'export_pdf.py'), target.full, '-o', out]);
    if (result.code !== 0) return sendJSON(res, 500, { error: 'pdf export failed', stderr: result.stderr.slice(-4000) });
    try {
      const stat = statSync(out);
      const base = target.full.split(sep).pop().replace(/\.svg$/i, '') + '.pdf';
      res.writeHead(200, {
        'content-type': 'application/pdf',
        'content-length': stat.size,
        'content-disposition': 'attachment; filename="' + encodeURIComponent(base) + '"',
      });
      createReadStream(out).pipe(res);
    } catch {
      sendJSON(res, 500, { error: 'export produced no file' });
    }
  };

  const drawio = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const target = containedFile(root, url.searchParams.get('p') ?? '');
    if (target === null) return sendJSON(res, 404, { error: 'not found' });
    const out = join(cacheDir, 'drawio-' + process.pid + '-' + Date.now() + '.drawio');
    const result = await runPython(python, [join(scriptsRoot, 'svg2drawio.py'), target.full, '-o', out]);
    if (result.code !== 0) return sendJSON(res, 500, { error: 'drawio export failed', stderr: result.stderr.slice(-4000) });
    try {
      const stat = statSync(out);
      const base = target.full.split(sep).pop().replace(/\.svg$/i, '') + '.drawio';
      res.writeHead(200, {
        'content-type': 'application/xml; charset=utf-8',
        'content-length': stat.size,
        'content-disposition': 'attachment; filename="' + encodeURIComponent(base) + '"',
      });
      createReadStream(out).pipe(res);
    } catch {
      sendJSON(res, 500, { error: 'export produced no file' });
    }
  };

  /** Read a request body with a hard size cap. */
  const readBody = (req, limit = 12 * 1024 * 1024) => new Promise((resolvePromise, reject) => {
    let total = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

  /** Write the figure back: SVG plus the editable model beside it. */
  const save = async (req, res) => {
    if (req.method !== 'POST') return sendJSON(res, 405, { error: 'POST only' });
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch (error) {
      return sendJSON(res, 400, { error: 'unreadable body: ' + String(error && error.message ? error.message : error) });
    }
    const requested = typeof payload.path === 'string' ? payload.path : '';
    const target = resolve(root, requested);
    const rel = relative(root, target);
    if (requested === '' || rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      return sendJSON(res, 403, { error: 'outside workspace' });
    }
    if (extname(target).toLowerCase() !== '.svg') return sendJSON(res, 400, { error: 'path must end in .svg' });
    const svg = typeof payload.svg === 'string' ? payload.svg : '';
    if (!svg.includes('<svg')) return sendJSON(res, 400, { error: 'svg payload missing' });

    try {
      mkdirSync(dirname(target), { recursive: true });
      const temp = target + '.tmp-' + process.pid + '-' + Date.now();
      writeFileSync(temp, svg, 'utf8');
      renameSync(temp, target);
    } catch (error) {
      return sendJSON(res, 500, { error: 'write failed: ' + String(error) });
    }

    let modelPath = null;
    if (payload.model !== undefined && payload.model !== null) {
      modelPath = target.replace(/\.svg$/i, '.edit.json');
      try { writeFileSync(modelPath, JSON.stringify(payload.model, null, 2) + '\n', 'utf8'); } catch { modelPath = null; }
    }

    const reportFile = join(cacheDir, 'save-' + process.pid + '-' + Date.now() + '.json');
    // lint only: check.py would render and drop three sibling files next to the
    // figure on every save, and the panel already renders its own preview
    const linted = await runPython(python, [join(scriptsRoot, 'lint.py'), target, '--report', reportFile, '--quiet']);
    let report = null;
    try { report = JSON.parse(readFileSync(reportFile, 'utf8')); } catch { /* no report */ }

    return sendJSON(res, 200, {
      ok: linted.code === 0 && (report?.errors ?? 0) === 0,
      path: rel.split(sep).join('/'),
      modelPath: modelPath === null ? null : relative(root, modelPath).split(sep).join('/'),
      bytes: Buffer.byteLength(svg),
      report,
    });
  };

  /** Return the stored editor model, when the figure has one. */
  const model = (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const target = containedFile(root, url.searchParams.get('p') ?? '');
    if (target === null) return sendJSON(res, 404, { error: 'not found' });
    const sidecar = target.full.replace(/\.svg$/i, '.edit.json');
    try {
      const parsed = JSON.parse(readFileSync(sidecar, 'utf8'));
      return sendJSON(res, 200, { model: parsed, path: relative(root, sidecar).split(sep).join('/') });
    } catch {
      return sendJSON(res, 200, { model: null });
    }
  };

  const disposers = [
    ctx.webServer.register(route('/dsh-figgenie/list', list)),
    ctx.webServer.register(route('/dsh-figgenie/file', file)),
    ctx.webServer.register(route('/dsh-figgenie/preview', preview)),
    ctx.webServer.register(route('/dsh-figgenie/check', check)),
    ctx.webServer.register(route('/dsh-figgenie/pdf', pdf)),
    ctx.webServer.register(route('/dsh-figgenie/drawio', drawio)),
    ctx.webServer.register(route('/dsh-figgenie/save', save)),
    ctx.webServer.register(route('/dsh-figgenie/model', model)),
  ];
  return () => { for (const dispose of disposers) { try { dispose(); } catch { /* gone */ } } };
}

/**
 * Register the FigGenie skill and, when a web server is present, its preview routes.
 * @param ctx - Context carrying the skill registry.
 * @param config - Optional `{ root, python, cacheDir }`.
 */
export function apply(ctx, config = {}) {
  registerSkill(ctx);

  ctx.inject(['webServer'], (webCtx) => {
    const server = webCtx.webServer;
    if (server === undefined || typeof server.register !== 'function') return;
    try {
      const dispose = registerRoutes(webCtx, config);
      webCtx.effect(() => dispose, 'figgenie: preview routes');
    } catch (error) {
      console.warn('[figgenie] preview routes unavailable:', error);
    }
  });
}
