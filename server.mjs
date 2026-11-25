// Universe Builder (Unreal): the authoring tool for Whispering Worlds on the Unreal port.
// Node built-ins only, no build step. The Builder edits data files; Unreal builds, renders and judges.
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, rename, mkdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { createBiomes } from './biomes.mjs';
import { createKits } from './kits.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const config = {
  port: Number(process.env.PORT || 8790),
  host: process.env.WW_BUILDER_HOST || '127.0.0.1',
  token: process.env.WW_BUILDER_TOKEN || '',
  project: path.resolve(process.env.WW_UNREAL_PROJECT || path.join(here, '..', 'whispering-worlds-unreal')),
  editor: process.env.WW_UNREAL_EDITOR || 'C:\\Program Files\\Epic Games\\UE_5.8\\Engine\\Binaries\\Win64\\UnrealEditor-Cmd.exe',
};
config.catalog = path.join(config.project, 'Saved', 'Catalog', 'catalog.json');
config.thumbs = path.join(config.project, 'Saved', 'Catalog', 'thumbs');
config.roles = path.join(config.project, 'Config', 'Assets', 'roles.json');

const biomes = createBiomes(config);
const kits = createKits(config, here);

const isLoopback =['127.0.0.1', 'localhost', '::1'].includes(config.host);
if (!isLoopback && !config.token) {
  console.error('Refusing to listen beyond this machine without WW_BUILDER_TOKEN.');
  process.exit(1);
}

export const ROLES = ['tree', 'bush', 'flower', 'grass', 'mushroom', 'rock', 'cliff', 'building', 'prop', 'creature', 'ignore'];
export const STATUSES = ['unreviewed', 'approved', 'rejected'];
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(data);
}

function tokenMatches(text) {
  const given = Buffer.from(text || '');
  const want = Buffer.from(config.token);
  return given.length === want.length && timingSafeEqual(given, want);
}

// A bearer header (agents, scripts) or the cookie the sign-in sets (the page, and its images, which cannot send a header).
function authorised(req) {
  if (!config.token) return true;
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ') && tokenMatches(header.slice(7))) return true;
  const cookie = /(?:^|;\s*)ub_token=([^;]+)/.exec(req.headers.cookie || '');
  return Boolean(cookie) && tokenMatches(decodeURIComponent(cookie[1]));
}

// Sign-in: a slow answer on a wrong token, and a cookie scripts cannot read on a right one.
async function login(req, res) {
  const body = await readBody(req, 4096);
  if (!config.token || !tokenMatches(`${body.token || ''}`)) {
    await new Promise((resolve) => setTimeout(resolve, 800));
    return send(res, 401, { ok: false, code: 'unauthorized', error: 'That token is not right.' });
  }
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Set-Cookie': `ub_token=${encodeURIComponent(config.token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000` });
  res.end(JSON.stringify({ ok: true }));
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function readBody(req, limit = 1 << 20) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('request too large'), { status: 413 });
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

async function loadRoles() {
  const doc = await readJson(config.roles, { schema: 'ww-asset-roles/1', assets: {} });
  if (doc.schema !== 'ww-asset-roles/1' || typeof doc.assets !== 'object') {
    throw Object.assign(new Error(`${config.roles} is not a ww-asset-roles/1 document`), { status: 500 });
  }
  return doc;
}

async function saveRoles(doc) {
  // Sorted keys so the file diffs cleanly in version control.
  const assets = Object.fromEntries(Object.keys(doc.assets).sort().map((id) => [id, doc.assets[id]]));
  const text = JSON.stringify({ schema: 'ww-asset-roles/1', assets }, null, 2) + '\n';
  await mkdir(path.dirname(config.roles), { recursive: true });
  const temp = `${config.roles}.${process.pid}.tmp`;
  await writeFile(temp, text, 'utf8');
  await rename(temp, config.roles);
}

// The catalogue as Unreal exported it, with the operator's roles laid over it.
async function catalogue() {
  const catalog = await readJson(config.catalog, null);
  if (!catalog) return { ok: false, code: 'no_catalog', error: 'No catalogue yet: press Refresh from Unreal.' };
  if (catalog.schema !== 'ww-unreal-catalog/1') return { ok: false, code: 'bad_catalog', error: `Unsupported catalogue schema ${catalog.schema}` };
  const roles = await loadRoles();
  const known = new Set(catalog.meshes.map((mesh) => mesh.id));
  const meshes = catalog.meshes.map((mesh) => {
    const mine = roles.assets[mesh.id] || {};
    return { ...mesh, role: mine.role || null, status: mine.status || 'unreviewed' };
  });
  const orphans = Object.keys(roles.assets).filter((id) => !known.has(id));
  return { ok: true, generated: catalog.generated, root: catalog.root, packs: catalog.packs, meshes, orphans, roles: ROLES, statuses: STATUSES };
}

async function setRoles(body) {
  const ids = Array.isArray(body.ids) ? body.ids : [];
  if (!ids.length || ids.length > 5000 || ids.some((id) => typeof id !== 'string' || !id.startsWith('/Game/'))) {
    throw Object.assign(new Error('ids must be 1 to 5000 asset ids under /Game/'), { status: 422 });
  }
  if (body.role !== undefined && body.role !== null && !ROLES.includes(body.role)) {
    throw Object.assign(new Error(`role must be one of ${ROLES.join(', ')}`), { status: 422 });
  }
  if (body.status !== undefined && !STATUSES.includes(body.status)) {
    throw Object.assign(new Error(`status must be one of ${STATUSES.join(', ')}`), { status: 422 });
  }
  const catalog = await readJson(config.catalog, { meshes: [] });
  const known = new Set(catalog.meshes.map((mesh) => mesh.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length) throw Object.assign(new Error(`not in the catalogue: ${unknown.slice(0, 3).join(', ')}`), { status: 422 });
  const doc = await loadRoles();
  for (const id of ids) {
    const entry = { ...(doc.assets[id] || {}) };
    if (body.role !== undefined) {
      if (body.role === null) delete entry.role;
      else entry.role = body.role;
    }
    if (body.status !== undefined) {
      if (body.status === 'unreviewed') delete entry.status;
      else entry.status = body.status;
    }
    if (Object.keys(entry).length) doc.assets[id] = entry;
    else delete doc.assets[id];
  }
  await saveRoles(doc);
  return { ok: true, changed: ids.length };
}

// One refresh at a time; the command is fixed here and takes nothing from the request.
const refresh = { running: false, last: null };
function startRefresh() {
  if (refresh.running) return { ok: false, code: 'busy', error: 'A refresh is already running.' };
  refresh.running = true;
  const started = Date.now();
  const lines = [];
  const child = spawn(config.editor, [path.join(config.project, 'WhisperingWorlds.uproject'), '-run=WWExportCatalog', '-unattended', '-nosplash', '-stdout'], { windowsHide: true });
  const collect = (chunk) => {
    for (const line of chunk.toString('utf8').split(/\r?\n/)) {
      if (line.includes('probe ')) lines.push(line.replace(/^\[.*?\]\[.*?\]/, '').trim());
    }
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const finish = (exit, error) => {
    refresh.running = false;
    refresh.last = { ok: exit === 0 && lines.some((line) => line.includes('probe verdict wwCatalog pass')), exit, error, seconds: (Date.now() - started) / 1000, lines, finished: new Date().toISOString() };
  };
  child.on('error', (error) => finish(null, error.message));
  child.on('close', (exit) => finish(exit, null));
  return { ok: true, started: true };
}

async function serveFile(res, file) {
  try {
    const info = await stat(file);
    if (!info.isFile()) return send(res, 404, { ok: false, error: 'not found' });
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Content-Length': info.size, 'Cache-Control': 'no-cache' });
    createReadStream(file).pipe(res);
  } catch {
    send(res, 404, { ok: false, error: 'not found' });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://local');
    const route = `${req.method} ${url.pathname}`;
    if (route === 'POST /api/login') return login(req, res);
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/thumbs/')) {
      if (!authorised(req)) return send(res, 401, { ok: false, code: 'unauthorized', error: 'Bearer token required.' });
    }
    if (url.pathname.startsWith('/previews/') && !authorised(req)) return send(res, 401, { ok: false, code: 'unauthorized', error: 'Bearer token required.' });
    if (await biomes(req, res, url, send, readBody, serveFile)) return;
    if (await kits(req, res, url, send)) return;
    if (route === 'GET /api/catalog') return send(res, 200, await catalogue());
    if (route === 'PUT /api/assets/role') return send(res, 200, await setRoles(await readBody(req)));
    if (route === 'POST /api/catalog/refresh') {
      const answer = startRefresh();
      return send(res, answer.ok ? 202 : 409, answer);
    }
    if (route === 'GET /api/catalog/refresh') return send(res, 200, { ok: true, running: refresh.running, last: refresh.last });
    if (route === 'GET /api/config') return send(res, 200, { ok: true, project: config.project, rolesFile: config.roles, tokenRequired: Boolean(config.token) });
    if (req.method === 'GET' && url.pathname.startsWith('/thumbs/')) {
      const name = url.pathname.slice('/thumbs/'.length);
      if (!/^[0-9a-f]{8}\.png$/.test(name)) return send(res, 404, { ok: false, error: 'not found' });
      return serveFile(res, path.join(config.thumbs, name));
    }
    if (req.method === 'GET') {
      const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (!/^[A-Za-z0-9._-]+$/.test(name)) return send(res, 404, { ok: false, error: 'not found' });
      return serveFile(res, path.join(here, 'public', name));
    }
    send(res, 404, { ok: false, error: 'not found' });
  } catch (error) {
    send(res, error.status || 500, { ok: false, error: error.message });
  }
});

server.listen(config.port, config.host, () => {
  console.log(`Universe Builder (Unreal) on http://${config.host}:${config.port}  project=${config.project}`);
});
