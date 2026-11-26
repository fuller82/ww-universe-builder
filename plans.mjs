// Biome drawer: a plan document per drawn biome in the Unreal project (Config/Plans/<id>.json, ww-biome-plan/1).
// The Builder draws and saves it; Unreal turns it into ground, renders it and judges it (Docs/BIOME-PLAN.md there).
// The ranges below are transcribed from Unreal's reader, WWReadBiomePlan in Source/WhisperingWorlds/World/WWBiomePlan.cpp:
// the reader is the truth, and this table moves to the project's own Config/Plans/fields.json once that file exists.
import path from 'node:path';
import { readFile, writeFile, rename, readdir, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const FEATURE_ID = /^[a-z0-9-]{1,48}$/;
// The build names its own views for each drawing (probe wwPlanViews); these come first when present, the rest follow by name.
const VIEWS = ['overview', 'spawn', 'climb', 'way-up', 'shelf', 'river', 'site', 'viewpoint', 'summit'];
const VIEW_NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;
const MOST_POINTS = 8192;
const MOST_PROBLEMS = 200;

const row = (path, label, unit, min, max, step, fallback, more = {}) => ({ path, label, unit, min, max, step, default: fallback, ...more });

// One definition for the page's property panels and the checks. `default` is what Unreal uses when the member is absent.
export const FIELDS = {
  schema: 'ww-biome-plan-fields/1',
  source: 'Source/WhisperingWorlds/World/WWBiomePlan.cpp (WWReadBiomePlan)',
  views: VIEWS,
  kinds: {
    areas: ['floor', 'shelf', 'plateau', 'outcrop', 'rise'],
    edge: ['cliff', 'bank'],
    zones: ['forest', 'clearing', 'settlement', 'pond'],
    paths: ['road', 'trail'],
    anchors: ['spawn', 'landmark', 'viewpoint', 'naturalBridge', 'bridge', 'waterfall', 'site'],
  },
  // Anchor kinds that have two feet (`at` and `to`).
  spans: ['naturalBridge', 'bridge'],
  most: { areas: 250, ramps: 250, zones: 250, slopes: 250, paths: 250, rivers: 250 },
  plan: [
    row('sizeMeters.width', 'Width', 'm', 64, 16384, 1, null, { required: true }),
    row('sizeMeters.length', 'Length', 'm', 64, 16384, 1, null, { required: true }),
    row('ground.heightMeters', 'Ground height', 'm', 0, 200, 0.1, 6),
    row('ground.rollMeters', 'Ground roll', 'm', 0, 10, 0.1, 1.2),
    row('ground.rollWavelengthMeters', 'Roll wavelength', 'm', 10, 500, 1, 90),
    row('edges.faceDegrees', 'Cliff face angle', 'deg', 45, 80, 1, 62),
    row('edges.scallopMeters', 'Cliff line wander', 'm', 0, 20, 0.5, 5),
    row('edges.scallopWavelengthMeters', 'Wander wavelength', 'm', 10, 300, 1, 48),
    row('edges.coastDegrees', 'Coast cliff angle', 'deg', 45, 80, 1, 66),
    row('sea.levelMeters', 'Sea level', 'm', -50, 200, 0.1, 0),
    row('sea.floorMeters', 'Sea floor', 'm', -80, 200, 0.1, -8),
  ],
  areas: [
    row('heightMeters', 'Height', 'm', 0, 200, 0.1, null, { required: true }),
    row('rollMeters', 'Roll', 'm', 0, 10, 0.1, null),
    row('tilt.degrees', 'Tilt', 'deg', 0, 12, 0.5, 0, { requiredWith: 'tilt' }),
    row('tilt.towardDegrees', 'Tilt rises toward', 'deg', -360, 360, 5, 0, { requiredWith: 'tilt' }),
    row('edge.degrees', 'Edge angle (cliff)', 'deg', 45, 80, 1, null, { when: ['edge.kind', 'cliff'] }),
    row('edge.degrees', 'Edge angle (bank)', 'deg', 4, 35, 1, 16, { when: ['edge.kind', 'bank'] }),
  ],
  slopes: [row('degrees', 'Hillside angle', 'deg', 4, 35, 1, 18)],
  zones: [row('depthMeters', 'Depth (ponds)', 'm', 0.3, 12, 0.1, 2)],
  paths: [
    row('halfWidthMeters', 'Half width', 'm', 0.8, 12, 0.1, 2.5),
    row('maxGradeDegrees', 'Steepest grade', 'deg', 4, 30, 1, 14),
  ],
  rivers: [
    row('halfWidthMeters', 'Half width', 'm', 1.5, 40, 0.1, 6),
    row('depthMeters', 'Depth', 'm', 0.3, 6, 0.1, 1.4),
  ],
  ramps: [
    row('halfWidthMeters', 'Half width', 'm', 2, 40, 0.1, 7),
    row('shoulderMeters', 'Shoulder', 'm', 1, 40, 0.5, 8),
  ],
  anchors: [],
  land: [],
};

function fail(status, message, details, code) {
  return Object.assign(new Error(message), { status, details, code });
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const dig = (object, dotted) => dotted.split('.').reduce((at, key) => (isObject(at) ? at[key] : undefined), object);

// The document as the hand-written sample is laid out: two-space indent, a point or a ring of points on one line.
export function formatPlan(value, indent = '') {
  const numbers = (list) => list.every((each) => typeof each === 'number');
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    if (numbers(value)) return `[${value.join(', ')}]`;
    if (value.every((each) => Array.isArray(each) && each.length > 0 && numbers(each))) return `[${value.map((point) => `[${point.join(', ')}]`).join(', ')}]`;
    return `[\n${value.map((each) => `${indent}  ${formatPlan(each, `${indent}  `)}`).join(',\n')}\n${indent}]`;
  }
  if (isObject(value)) {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined);
    if (!keys.length) return '{}';
    return `{\n${keys.map((key) => `${indent}  ${JSON.stringify(key)}: ${formatPlan(value[key], `${indent}  `)}`).join(',\n')}\n${indent}}`;
  }
  return JSON.stringify(value);
}

// The same checks for the page and the save, in the reader's order and with its key paths. Unlike the reader, which
// stops at the first fault, this lists them all. Members the reader does not know are left alone, as it leaves them.
export function validatePlan(id, plan) {
  const problems = [];
  const say = (key, message) => { if (problems.length < MOST_PROBLEMS) problems.push({ key, message }); };
  if (!isObject(plan)) return [{ key: '', message: 'the document is not a JSON object' }];
  if (plan.schema !== 'ww-biome-plan/1') say('schema', 'must be "ww-biome-plan/1"');
  if (typeof plan.id !== 'string' || !ID.test(plan.id)) say('id', 'must be a name of 1 to 48 characters: a-z, 0-9 and -');
  else if (plan.id !== id) say('id', `must be "${id}", the file's name`);
  // The reader takes a plan with no biome; a build cannot, and says so when asked.
  if (plan.biome !== undefined && (typeof plan.biome !== 'string' || !ID.test(plan.biome))) say('biome', 'must name the palette that dresses it (Config/Biomes/<biome>.json)');
  if (plan.label !== undefined && typeof plan.label !== 'string') say('label', 'must be text');

  const numbers = (object, rows, at) => {
    for (const each of rows) {
      if (each.when && dig(object, each.when[0]) !== each.when[1]) continue;
      const value = dig(object, each.path);
      const key = at ? `${at}.${each.path}` : each.path;
      if (value === undefined) {
        if (each.required || (each.requiredWith && object[each.requiredWith] !== undefined)) say(key, 'is required');
        continue;
      }
      if (typeof value !== 'number' || !Number.isFinite(value)) say(key, 'must be a number');
      else if (value < each.min || value > each.max) say(key, `must be ${each.min} to ${each.max}, not ${value}`);
    }
  };
  for (const group of ['sizeMeters', 'ground', 'edges', 'sea']) {
    if (plan[group] !== undefined && !isObject(plan[group])) say(group, 'must be an object');
  }
  if (!isObject(plan.sizeMeters)) say('sizeMeters', 'is required: {"width": metres, "length": metres}');
  numbers(plan, FIELDS.plan.filter((each) => isObject(plan[each.path.split('.')[0]])), '');
  if (isObject(plan.sea)) {
    const level = typeof plan.sea.levelMeters === 'number' ? plan.sea.levelMeters : 0, floor = typeof plan.sea.floorMeters === 'number' ? plan.sea.floorMeters : -8;
    if (floor > level - 1) say('sea.floorMeters', `must lie 1 m or more under sea.levelMeters (${level})`);
  }
  const size = (value) => (typeof value === 'number' && value >= 64 && value <= 16384 ? value : Infinity);
  const width = size(plan.sizeMeters?.width), length = size(plan.sizeMeters?.length);

  const point = (value, key) => {
    if (!Array.isArray(value) || value.length !== 2 || !value.every((each) => typeof each === 'number' && Number.isFinite(each))) return say(key, 'must be [x, y] in metres'), false;
    const [x, y] = value;
    if (x < 0 || y < 0 || x > width || y > length) return say(key, `(${x}, ${y}) lies outside the biome's ${width} by ${length} metres`), false;
    return true;
  };
  const ring = (value, key, least) => {
    if (!Array.isArray(value)) return say(key, 'must be a list of [x, y] points'), false;
    if (value.length < least || value.length > MOST_POINTS) return say(key, `holds ${value.length} points; it needs ${least} to ${MOST_POINTS}`), false;
    let good = true;
    value.forEach((each, index) => { if (!point(each, `${key}[${index}]`)) good = false; });
    return good;
  };
  const shape = (object, key) => {
    ring(object.outer, `${key}.outer`, 3);
    if (object.holes === undefined) return;
    if (!Array.isArray(object.holes)) return say(`${key}.holes`, 'must be a list of rings');
    object.holes.forEach((hole, index) => ring(hole, `${key}.holes[${index}]`, 3));
  };
  const shapes = (object, key) => {
    if (object.shapes === undefined) return shape(object, key);
    if (!Array.isArray(object.shapes)) return say(`${key}.shapes`, 'must be a list of shapes');
    if (!object.shapes.length) return say(`${key}.shapes`, 'holds no shape');
    object.shapes.forEach((each, index) => {
      if (!isObject(each)) say(`${key}.shapes[${index}]`, 'must be an object with an outer ring');
      else shape(each, `${key}.shapes[${index}]`);
    });
  };
  const line = (object, key, least) => {
    if (!ring(object.line, `${key}.line`, least)) return;
    let metres = 0;
    for (let index = 0; index + 1 < object.line.length; index += 1) metres += Math.hypot(object.line[index + 1][0] - object.line[index][0], object.line[index + 1][1] - object.line[index][1]);
    if (least && metres < 4) say(`${key}.line`, `is ${metres.toFixed(1)} m long; it needs 4 m or more`);
  };

  // One set of names over every list: an id is used once in the document.
  const ids = new Set();
  const each = (member, check) => {
    const list = plan[member];
    if (list === undefined) return;
    if (!Array.isArray(list)) return say(member, 'must be a list');
    if (list.length > FIELDS.most[member]) say(member, `holds ${list.length} ${member}; the most is ${FIELDS.most[member]}`);
    list.forEach((object, index) => {
      const key = `${member}[${index}]`;
      if (!isObject(object)) return say(key, 'must be an object');
      if (typeof object.id !== 'string' || !FEATURE_ID.test(object.id)) say(`${key}.id`, 'must be a name of 1 to 48 characters: a-z, 0-9 and -');
      else if (ids.has(object.id)) say(`${key}.id`, `"${object.id}" is used twice`);
      else ids.add(object.id);
      numbers(object, FIELDS[member], key);
      check(object, key);
    });
  };
  const oneOf = (value, list, key) => { if (!list.includes(value)) say(key, `must be ${list.map((kind) => `"${kind}"`).join(', ').replace(/, ([^,]*)$/, ' or $1')}`); };

  if (plan.land !== undefined) {
    if (!isObject(plan.land)) say('land', 'must be a shape');
    else shapes(plan.land, 'land');
  }
  each('areas', (area, key) => {
    if (area.kind !== undefined && typeof area.kind !== 'string') say(`${key}.kind`, 'must be text');
    if (area.tilt !== undefined && !isObject(area.tilt)) say(`${key}.tilt`, 'must be an object');
    if (area.edge !== undefined) {
      if (!isObject(area.edge)) say(`${key}.edge`, 'must be an object');
      else oneOf(area.edge.kind, FIELDS.kinds.edge, `${key}.edge.kind`);
    }
    shapes(area, key);
  });
  each('slopes', (slope, key) => shapes(slope, key));
  each('ramps', (ramp, key) => line(ramp, key, 2));
  each('paths', (way, key) => {
    if (way.kind !== undefined) oneOf(way.kind, FIELDS.kinds.paths, `${key}.kind`);
    line(way, key, 2);
  });
  each('rivers', (river, key) => line(river, key, 2));
  each('zones', (zone, key) => {
    oneOf(zone.kind, FIELDS.kinds.zones, `${key}.kind`);
    shapes(zone, key);
  });
  each('anchors', (anchor, key) => {
    oneOf(anchor.kind, FIELDS.kinds.anchors, `${key}.kind`);
    point(anchor.at, `${key}.at`);
    if (anchor.to !== undefined) point(anchor.to, `${key}.to`);
    else if (FIELDS.spans.includes(anchor.kind)) say(`${key}.to`, 'a bridge needs its far foot');
    if (anchor.label !== undefined && typeof anchor.label !== 'string') say(`${key}.label`, 'must be text');
  });
  return problems;
}

// The one command a build runs. Everything in it is fixed here or is an id that was checked against a file that exists.
export function buildCommand(project, { id, biome, look }) {
  for (const [name, value] of Object.entries({ id, biome, look })) {
    if (typeof value !== 'string' || !ID.test(value)) throw fail(422, `${name} is not a valid id`);
  }
  const script = path.join(project, 'Tools', 'meadow-look.ps1');
  return {
    command: 'powershell',
    args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Pack', `biome:${biome}`, '-Look', look, '-Plan', id, '-Run', 'ub'],
    views: path.join(project, 'Views', `meadow-${`biome${biome}`.replace(/[^A-Za-z0-9]/g, '')}-${look}-ub`),
  };
}

export function createPlans(config, { looks, run = spawn }) {
  const dir = path.join(config.project, 'Config', 'Plans');
  const build = { running: null, last: null };

  const fileOf = (id) => {
    if (!ID.test(id || '') || id === 'fields') throw fail(404, 'no such plan');
    return path.join(dir, `${id}.json`);
  };
  const revisionOf = (text) => createHash('sha256').update(text).digest('hex').slice(0, 20);

  // The file's text, or null when there is none.
  async function textOf(id) {
    return readFile(fileOf(id), 'utf8').catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
  }

  async function read(id) {
    const text = await textOf(id);
    if (text === null) throw fail(404, 'no such plan');
    let document;
    try {
      document = JSON.parse(text.replace(/^﻿/, ''));
    } catch (error) {
      throw fail(500, `${id}.json is not JSON: ${error.message}`);
    }
    return { document, revision: revisionOf(text) };
  }

  async function list() {
    const out = [];
    for (const name of (await readdir(dir).catch(() => [])).sort()) {
      if (!name.endsWith('.json') || name === 'fields.json' || !ID.test(name.slice(0, -5))) continue;
      const document = await readFile(path.join(dir, name), 'utf8').then((text) => JSON.parse(text.replace(/^﻿/, ''))).catch(() => null);
      if (document?.schema === 'ww-biome-plan/1') out.push({ id: name.slice(0, -5), label: document.label || document.id, biome: document.biome || null });
    }
    return out;
  }

  // The palettes a plan can name: the biome files the Biomes section edits.
  async function biomeIds() {
    const names = await readdir(path.join(config.project, 'Config', 'Biomes')).catch(() => []);
    return names.filter((name) => name.endsWith('.json') && name !== 'fields.json' && ID.test(name.slice(0, -5))).map((name) => name.slice(0, -5)).sort();
  }

  // Refused when the file on disk is not the one the page loaded (someone else, or Unreal's tools, wrote it since).
  async function save(id, body) {
    const file = fileOf(id);
    const current = await textOf(id);
    if (body.create) {
      if (current !== null) throw fail(409, `a plan named ${id} already exists`, undefined, 'exists');
    } else {
      if (current === null) throw fail(404, 'no such plan');
      if (body.revision !== revisionOf(current)) throw fail(409, 'The file changed on disk since it was loaded. Reload it before saving.', undefined, 'stale');
    }
    const problems = validatePlan(id, body.document);
    if (problems.length) throw fail(422, `${problems[0].key}: ${problems[0].message}`, problems, 'invalid');
    const text = formatPlan(body.document) + '\n';
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, text, 'utf8');
    await rename(temp, file);
    return { ok: true, saved: true, revision: revisionOf(text) };
  }

  // One Unreal run at a time, across the whole Builder. The request picks a plan id and a look id that exist; the
  // biome is read from the saved plan, never from the request.
  async function startBuild(id, look) {
    const { document } = await read(id);
    const problems = validatePlan(id, document);
    if (problems.length) throw fail(422, `the saved plan has problems: ${problems[0].key}: ${problems[0].message}`, problems, 'invalid');
    if (!(await looks()).some((each) => each.id === look)) throw fail(422, `no such look: ${look}`);
    if (typeof document.biome !== 'string') throw fail(422, 'the plan names no biome palette to dress it');
    const palette = await stat(path.join(config.project, 'Config', 'Biomes', `${document.biome}.json`)).catch(() => null);
    if (!palette?.isFile()) throw fail(422, `no such biome palette: ${document.biome}`);
    const { command, args, views } = buildCommand(config.project, { id, biome: document.biome, look });
    if (config.unreal.running) throw fail(409, `Unreal is busy (${config.unreal.running}). One run at a time.`, undefined, 'busy');
    config.unreal.running = `building plan ${id}`;
    const started = Date.now();
    const lines = [];
    build.running = { id, look, biome: document.biome, started: new Date(started).toISOString() };
    let done = false;
    const finish = async (exit, error) => {
      if (done) return;
      done = true;
      const images = [];
      const found = (await readdir(views).catch(() => [])).filter((name) => name.endsWith('.png') && VIEW_NAME.test(name.slice(0, -4))).map((name) => name.slice(0, -4)).sort();
      for (const view of [...VIEWS.filter((each) => found.includes(each)), ...found.filter((each) => !VIEWS.includes(each))]) {
        const info = await stat(path.join(views, `${view}.png`)).catch(() => null);
        if (info && info.isFile() && info.mtimeMs >= started) images.push(view);
      }
      const world = lines.some((each) => each.includes('probe verdict wwWorld pass'));
      const rendered = lines.some((each) => each.includes('probe verdict wwViews pass'));
      build.last = {
        id, look, biome: document.biome, ok: world && rendered && images.length > 0, exit, error, seconds: (Date.now() - started) / 1000,
        worldVerdict: world, viewsVerdict: rendered, images, dir: views, lines,
        verdicts: lines.filter((each) => each.includes('probe verdict ')), guide: lines.filter((each) => each.includes('probe wwWorldGuide ')),
        finished: new Date().toISOString(),
      };
      build.running = null;
      config.unreal.running = null;
    };
    let child;
    try {
      child = run(command, args, { windowsHide: true });
    } catch (error) {
      await finish(null, error.message);
      throw fail(500, `could not start the build: ${error.message}`);
    }
    const collect = (chunk) => {
      for (const each of chunk.toString('utf8').split(/\r?\n/)) if (/probe |build |views /.test(each)) lines.push(each.trim().slice(0, 400));
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (error) => finish(null, error.message));
    child.on('close', (exit) => finish(exit, null));
    return { ok: true, started: true };
  }

  const publicLast = () => (build.last ? { ...build.last, dir: undefined } : null);

  // Returns true when the request was one of ours.
  return async function handle(req, res, url, send, readBody, serveFile) {
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] === 'plan-views' && req.method === 'GET') {
      // Only a view of the last build, by its fixed name: the folder comes from that build, not from the request.
      const view = parts.length === 2 && parts[1].endsWith('.png') ? parts[1].slice(0, -4) : '';
      if (!build.last || !VIEW_NAME.test(view) || !build.last.images.includes(view)) return send(res, 404, { ok: false, error: 'not found' }), true;
      return serveFile(res, path.join(build.last.dir, `${view}.png`)), true;
    }
    if (parts[0] !== 'api' || parts[1] !== 'plans') return false;
    if (parts.length === 2 && req.method === 'GET') return send(res, 200, { ok: true, plans: await list(), looks: await looks(), biomes: await biomeIds(), fields: FIELDS }), true;
    if (parts[2] === 'build' && parts.length === 3 && req.method === 'GET') return send(res, 200, { ok: true, running: build.running, busy: config.unreal.running, last: publicLast() }), true;
    const id = parts[2];
    if (parts.length === 3 && req.method === 'GET') {
      const { document, revision } = await read(id);
      return send(res, 200, { ok: true, document, revision, problems: validatePlan(id, document) }), true;
    }
    if (parts.length === 3 && req.method === 'PUT') return send(res, 200, await save(id, await readBody(req, 8 << 20))), true;
    if (parts.length === 4 && parts[3] === 'check' && req.method === 'POST') {
      fileOf(id);
      return send(res, 200, { ok: true, problems: validatePlan(id, (await readBody(req, 8 << 20)).document) }), true;
    }
    if (parts.length === 4 && parts[3] === 'build' && req.method === 'POST') return send(res, 202, await startBuild(id, `${(await readBody(req)).look || ''}`)), true;
    return false;
  };
}
