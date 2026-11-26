// Biomes: a palette document per biome in the Unreal project (Config/Biomes/<id>.json, ww-biome-palette/1).
// The Builder edits it; Unreal builds a test world from it and renders the preview. Ranges come from the project's
// own field table (Config/Biomes/fields.json), never from a copy here.
import path from 'node:path';
import { readFile, writeFile, rename, readdir, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const ID = /^[a-z0-9][a-z0-9-]{0,40}$/;
const VIEWS = { 'eye-b': 'eye-b,150,-100,12,200,-4', low: 'low,-120,160,6,120,0', overview: 'overview,-380,-380,70,45,-14' };

async function readJson(file) {
  return JSON.parse((await readFile(file, 'utf8')).replace(/^﻿/, ''));
}

function fail(status, message, details) {
  return Object.assign(new Error(message), { status, details });
}

export function createBiomes(config) {
  const dir = path.join(config.project, 'Config', 'Biomes');
  const looksDir = path.join(config.project, 'Config', 'Looks');
  const fieldsFile = path.join(dir, 'fields.json');
  const viewsRoot = path.join(config.project, 'Views');
  const script = path.join(config.project, 'Tools', 'meadow-look.ps1');
  const preview = { running: null, last: null };

  const fileOf = (id) => {
    if (!ID.test(id) || id === 'fields') throw fail(404, 'no such biome');
    return path.join(dir, `${id}.json`);
  };

  async function fields() {
    const table = await readJson(fieldsFile);
    if (table.schema !== 'ww-biome-palette-fields/1') throw fail(500, `${fieldsFile} is not a ww-biome-palette-fields/1 table`);
    return table;
  }

  async function looks() {
    const out = [];
    for (const name of (await readdir(looksDir)).sort()) {
      if (!name.endsWith('.json') || name === 'fields.json') continue;
      const doc = await readJson(path.join(looksDir, name));
      if (doc.schema === 'ww-look/1' && ID.test(doc.id)) out.push({ id: doc.id, label: doc.label || doc.id });
    }
    return out;
  }

  async function list() {
    const out = [];
    for (const name of (await readdir(dir)).sort()) {
      if (!name.endsWith('.json') || name === 'fields.json') continue;
      const doc = await readJson(path.join(dir, name));
      if (doc.schema === 'ww-biome-palette/1') out.push({ id: doc.id, label: doc.label || doc.id });
    }
    return out;
  }

  // The same checks for the page and the save: every id is a mesh Unreal exported, every number is in the table's range.
  async function validate(id, document) {
    const table = await fields();
    const problems = [];
    if (!document || document.schema !== 'ww-biome-palette/1') problems.push({ key: 'schema', message: 'schema must be ww-biome-palette/1' });
    if (document?.id !== id) problems.push({ key: 'id', message: `id must be "${id}", the file's name` });
    const catalog = await readJson(config.catalog).catch(() => ({ meshes: [] }));
    const known = new Set(catalog.meshes.map((mesh) => mesh.id));
    const roleKeys = table.roles.map((role) => role.key);
    for (const [role, ids] of Object.entries(document?.roles || {})) {
      if (!roleKeys.includes(role)) problems.push({ key: `roles.${role}`, message: `unknown role "${role}"` });
      else if (!Array.isArray(ids)) problems.push({ key: `roles.${role}`, message: 'must be a list of asset ids' });
      else for (const asset of ids) if (!known.has(asset)) problems.push({ key: `roles.${role}`, message: `not in Unreal's catalogue: ${asset}` });
    }
    for (const role of ['tree', 'grass']) {
      if (!(document?.roles?.[role]?.length > 0)) problems.push({ key: `roles.${role}`, message: `a biome needs at least one ${role}` });
    }
    for (const row of table.fields) {
      const value = document?.[row.group]?.[row.key];
      if (value === undefined) continue;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < row.min || value > row.max) {
        problems.push({ key: `${row.group}.${row.key}`, message: `"${row.label}" must be ${row.min} to ${row.max}, not ${value}` });
      } else if (row.whole && !Number.isInteger(value)) {
        problems.push({ key: `${row.group}.${row.key}`, message: `"${row.label}" must be a whole number` });
      }
    }
    const lookIds = new Set((await looks()).map((look) => look.id));
    for (const look of document?.looks || []) if (!lookIds.has(look)) problems.push({ key: 'looks', message: `no such look: ${look}` });
    return problems;
  }

  async function save(id, document) {
    const file = fileOf(id);
    const problems = await validate(id, document);
    if (problems.length) throw fail(422, problems[0].message, problems);
    const text = JSON.stringify(document, null, 2) + '\n';
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, text, 'utf8');
    await rename(temp, file);
    return { ok: true, saved: true };
  }

  const previewDir = (id, look) => path.join(viewsRoot, `meadow-${`biome${id}`.replace(/[^A-Za-z0-9]/g, '')}-${look}-ub`);

  // One Unreal run at a time. The command is fixed here; the request only picks a biome id and a look id that exist.
  async function startPreview(id, look) {
    fileOf(id);
    if (preview.running) throw fail(409, 'A preview is already rendering.');
    if (config.unreal?.running) throw fail(409, `Unreal is busy (${config.unreal.running}). One run at a time.`);
    if (!(await looks()).some((each) => each.id === look)) throw fail(422, `no such look: ${look}`);
    const started = Date.now();
    const lines = [];
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Pack', `biome:${id}`, '-Look', look, '-Run', 'ub', '-Views', `${VIEWS['eye-b']};${VIEWS.low};${VIEWS.overview}`];
    const child = spawn('powershell.exe', args, { windowsHide: true });
    preview.running = { id, look, started: new Date(started).toISOString() };
    if (config.unreal) config.unreal.running = `previewing biome ${id}`;
    const collect = (chunk) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) if (/probe |build |views /.test(line)) lines.push(line.trim().slice(0, 400));
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const finish = async (exit, error) => {
      const images = [];
      for (const view of Object.keys(VIEWS)) {
        const info = await stat(path.join(previewDir(id, look), `${view}.png`)).catch(() => null);
        if (info && info.mtimeMs >= started) images.push(view);
      }
      const world = lines.some((line) => line.includes('probe verdict wwWorld pass'));
      const views = lines.some((line) => line.includes('probe verdict wwViews pass'));
      preview.last = { id, look, ok: world && views && images.length > 0, exit, error, seconds: (Date.now() - started) / 1000, worldVerdict: world, viewsVerdict: views, images, lines, finished: new Date().toISOString() };
      preview.running = null;
      if (config.unreal) config.unreal.running = null;
    };
    child.on('error', (error) => finish(null, error.message));
    child.on('close', (exit) => finish(exit, null));
    return { ok: true, started: true };
  }

  // Returns true when the request was one of ours.
  handle.looks = looks;
  return handle;
  async function handle(req, res, url, send, readBody, serveFile) {
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] === 'previews' && req.method === 'GET') {
      const [, id, look, name] = parts;
      if (!ID.test(id || '') || !ID.test(look || '') || !/^[a-z-]+\.png$/.test(name || '') || !(name.slice(0, -4) in VIEWS)) return send(res, 404, { ok: false, error: 'not found' }), true;
      return serveFile(res, path.join(previewDir(id, look), name)), true;
    }
    if (parts[0] !== 'api' || parts[1] !== 'biomes') return false;
    if (parts.length === 2 && req.method === 'GET') return send(res, 200, { ok: true, biomes: await list(), looks: await looks(), fields: await fields() }), true;
    if (parts[2] === 'preview' && parts.length === 3 && req.method === 'GET') return send(res, 200, { ok: true, running: preview.running, last: preview.last }), true;
    const id = parts[2];
    if (parts.length === 3 && req.method === 'GET') {
      const document = await readJson(fileOf(id)).catch((error) => { throw error.code === 'ENOENT' ? fail(404, 'no such biome') : error; });
      return send(res, 200, { ok: true, document, problems: await validate(id, document) }), true;
    }
    if (parts.length === 3 && req.method === 'PUT') return send(res, 200, await save(id, (await readBody(req)).document)), true;
    if (parts.length === 4 && parts[3] === 'check' && req.method === 'POST') return send(res, 200, { ok: true, problems: await validate(id, (await readBody(req)).document) }), true;
    if (parts.length === 4 && parts[3] === 'preview' && req.method === 'POST') return send(res, 202, await startPreview(id, `${(await readBody(req)).look || ''}`)), true;
    return false;
  }
}
