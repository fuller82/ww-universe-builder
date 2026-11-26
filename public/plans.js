// Biome drawer: draw one biome as a plan (ww-biome-plan/1): painted areas with heights, slopes, zones, rivers, paths,
// ramps and anchors, in world metres (x right, y down). The server checks and saves it; Unreal builds and judges it.
// Ranges, kinds and defaults come from the server's field table; this page holds no copy of them.
const $ = (id) => document.getElementById(id);
const NS = 'http://www.w3.org/2000/svg';
// Draw order after the land outline, bottom to top.
const LAYERS = ['areas', 'slopes', 'zones', 'rivers', 'paths', 'ramps', 'anchors'];
const LINES = ['rivers', 'paths', 'ramps'];
const NAMES = { land: 'Land outline', areas: 'Areas (paint order)', slopes: 'Slopes', zones: 'Zones', rivers: 'Rivers', paths: 'Paths', ramps: 'Ramps', anchors: 'Anchors' };
const TOOLS = [['areas', 'Area', 'area'], ['slopes', 'Slope', 'slope'], ['zones', 'Zone', 'zone'], ['paths', 'Path', 'path'], ['rivers', 'River', 'river'], ['ramps', 'Ramp', 'ramp'], ['anchors', 'Anchor', 'anchor'], ['land', 'Land outline', 'land']];
const ZONE_LOOK = { forest: ['#1f5a2e', 0.45], clearing: ['#e9e2a0', 0.5], settlement: ['#b0703c', 0.55], pond: ['#2f7fc4', 0.85] };
const MARKS = { spawn: '#d42a2a', landmark: '#7a2ad4', viewpoint: '#d48a2a', naturalBridge: '#222222', bridge: '#6b4a2a', waterfall: '#2f9fd4', site: '#c2408a' };

const state = {
  fields: null, looks: [], biomes: [], id: null, doc: null, saved: '', revision: null,
  last: '', undo: [], redo: [], sel: null, vertex: null, tool: null, problems: [],
  view: { x: 0, y: 0, scale: 1 }, fitted: false, started: false,
};

async function api(method, url, body) {
  const response = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const answer = await response.json();
  if (!response.ok || answer.ok === false) throw Object.assign(new Error(answer.error || `${method} ${url} failed (${response.status})`), { details: answer.details, code: answer.code });
  return answer;
}

function message(text, error = false) {
  const box = $('plan-message');
  box.hidden = !text;
  box.textContent = text || '';
  box.classList.toggle('error', error);
}

function make(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function svg(tag, attributes = {}, ...children) {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attributes)) if (value !== undefined && value !== null) node.setAttribute(key, value);
  node.append(...children);
  return node;
}

// ---- the document ----

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const good = (point) => Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]);
const number = (value, fallback) => (Number.isFinite(value) ? value : fallback);
const size = () => [number(state.doc?.sizeMeters?.width, 1016), number(state.doc?.sizeMeters?.length, 1016)];
const listOf = (coll) => (Array.isArray(state.doc?.[coll]) ? state.doc[coll] : []);
const featureOf = (sel) => (!sel || !state.doc ? null : sel.coll === 'land' ? (isObject(state.doc.land) ? state.doc.land : null) : (isObject(listOf(sel.coll)[sel.i]) ? listOf(sel.coll)[sel.i] : null));
const shapesOf = (feature) => (Array.isArray(feature.shapes) ? feature.shapes.filter(isObject) : [feature]);
const dirty = () => state.last !== state.saved;
const round = (value) => Math.round(value * 10) / 10;

// The point lists of a feature that can be edited: rings (closed), lines (open), or an anchor's one or two points.
function partsOf(coll, feature) {
  if (coll === 'anchors') return [{ points: [feature.at, feature.to].filter(Array.isArray), fixed: true, closed: false }];
  if (LINES.includes(coll)) return Array.isArray(feature.line) ? [{ points: feature.line, closed: false, least: 2 }] : [];
  const out = [];
  for (const shape of shapesOf(feature)) {
    if (Array.isArray(shape.outer)) out.push({ points: shape.outer, closed: true, least: 3 });
    for (const hole of Array.isArray(shape.holes) ? shape.holes : []) if (Array.isArray(hole)) out.push({ points: hole, closed: true, least: 3 });
  }
  return out;
}

function everyId() {
  const ids = new Set();
  for (const coll of LAYERS) for (const each of listOf(coll)) if (isObject(each) && typeof each.id === 'string') ids.add(each.id);
  return ids;
}

function freshId(base) {
  const ids = everyId();
  for (let n = 1; ; n += 1) if (!ids.has(`${base}-${n}`)) return `${base}-${n}`;
}

function setPath(object, dotted, value) {
  const keys = dotted.split('.');
  let at = object;
  for (const key of keys.slice(0, -1)) {
    if (!isObject(at[key])) {
      if (value === undefined) return;
      at[key] = {};
    }
    at = at[key];
  }
  if (value === undefined) delete at[keys.at(-1)];
  else at[keys.at(-1)] = value;
  if (keys.length === 2 && isObject(object[keys[0]]) && !Object.keys(object[keys[0]]).length) delete object[keys[0]];
}
const getPath = (object, dotted) => dotted.split('.').reduce((at, key) => (isObject(at) ? at[key] : undefined), object);

// Every finished edit is one undo step: the document before it is kept as text.
function commit() {
  const now = JSON.stringify(state.doc);
  if (now === state.last) return;
  state.undo.push(state.last);
  if (state.undo.length > 300) state.undo.shift();
  state.redo = [];
  state.last = now;
  afterChange();
}

function step(from, to) {
  if (!from.length) return;
  to.push(state.last);
  state.last = from.pop();
  state.doc = JSON.parse(state.last);
  state.vertex = null;
  if (!featureOf(state.sel)) state.sel = null;
  afterChange();
}

let checkTimer = null;
function afterChange() {
  renderAll();
  clearTimeout(checkTimer);
  checkTimer = setTimeout(check, 350);
}

async function check() {
  if (!state.doc) return;
  const id = state.id, text = state.last;
  try {
    const answer = await api('POST', `/api/plans/${id}/check`, { document: state.doc });
    if (id !== state.id || text !== state.last) return;
    state.problems = answer.problems;
    renderProblems();
    updateState();
  } catch (error) {
    message(error.message, true);
  }
}

// ---- the canvas ----

const canvas = $('plan-svg');
let drawQueued = false;
function schedule() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => { drawQueued = false; draw(); });
}

function applyView() {
  const box = canvas.getBoundingClientRect();
  if (!box.width || !box.height) return;
  canvas.setAttribute('viewBox', `${state.view.x} ${state.view.y} ${box.width * state.view.scale} ${box.height * state.view.scale}`);
}

function fit() {
  const box = canvas.getBoundingClientRect();
  if (!box.width || !box.height || !state.doc) return;
  const [width, length] = size();
  state.view.scale = Math.max(width / Math.max(box.width - 32, 50), length / Math.max(box.height - 32, 50));
  state.view.x = width / 2 - (box.width * state.view.scale) / 2;
  state.view.y = length / 2 - (box.height * state.view.scale) / 2;
  state.fitted = true;
  applyView();
  schedule();
}

function zoomAt(clientX, clientY, factor) {
  const box = canvas.getBoundingClientRect();
  const before = toWorld(clientX, clientY, false);
  state.view.scale = Math.min(20, Math.max(0.01, state.view.scale * factor));
  state.view.x = before[0] - (clientX - box.left) * state.view.scale;
  state.view.y = before[1] - (clientY - box.top) * state.view.scale;
  applyView();
  schedule();
}

function toWorld(clientX, clientY, clamp = true) {
  const box = canvas.getBoundingClientRect();
  const x = state.view.x + (clientX - box.left) * state.view.scale, y = state.view.y + (clientY - box.top) * state.view.scale;
  if (!clamp) return [x, y];
  const [width, length] = size();
  return [round(Math.min(width, Math.max(0, x))), round(Math.min(length, Math.max(0, y)))];
}

const ringPath = (ring, closed = true) => {
  const points = ring.filter(good);
  return points.length ? `M${points.map(([x, y]) => `${x},${y}`).join('L')}${closed ? 'Z' : ''}` : '';
};
const shapePath = (feature) => shapesOf(feature).map((shape) => [shape.outer, ...(Array.isArray(shape.holes) ? shape.holes : [])].filter(Array.isArray).map((ring) => ringPath(ring)).join('')).join('');
const linePoints = (feature) => (Array.isArray(feature.line) ? feature.line.filter(good).map(([x, y]) => `${x},${y}`).join(' ') : '');

function boundsOf(parts) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const part of parts) for (const point of part.points) if (good(point)) {
    minX = Math.min(minX, point[0]); maxX = Math.max(maxX, point[0]);
    minY = Math.min(minY, point[1]); maxY = Math.max(maxY, point[1]);
  }
  return minX === Infinity ? null : { minX, minY, maxX, maxY };
}

function draw() {
  canvas.replaceChildren();
  const plan = state.doc;
  if (!plan) return;
  const px = state.view.scale; // metres per screen pixel
  const [width, length] = size();
  const heights = [number(plan.ground?.heightMeters, 6), ...listOf('areas').filter(isObject).map((area) => number(area.heightMeters, 0))];
  const low = Math.min(...heights), high = Math.max(...heights);
  // Low ground is meadow green, high ground pale stone (the look of Tools/plan/plan-to-svg.mjs in the Unreal project).
  const shade = (height) => {
    const t = high > low ? (height - low) / (high - low) : 0;
    const mix = (a, b) => Math.round(a + (b - a) * t);
    return `rgb(${mix(96, 226)},${mix(148, 214)},${mix(84, 186)})`;
  };
  const hit = (coll, i) => ({ 'data-coll': coll, 'data-i': i });
  const label = (x, y, text, pixels = 12) => {
    const node = svg('text', { x, y, 'font-size': pixels * px, 'text-anchor': 'middle', fill: '#1c1c1c', stroke: '#ffffff', 'stroke-width': 3 * px, 'paint-order': 'stroke', class: 'plan-label' });
    node.textContent = text;
    return node;
  };

  canvas.append(svg('defs', {}, svg('pattern', { id: 'plan-hatch', patternUnits: 'userSpaceOnUse', width: 7, height: 7, patternTransform: `rotate(45) scale(${px})` },
    svg('line', { x1: 0, y1: 0, x2: 0, y2: 7, stroke: '#3a3320', 'stroke-width': 2.2, 'stroke-opacity': 0.75 }))));

  // 1. Sea and land: with a land outline, ground outside it is sea.
  const land = isObject(plan.land) ? plan.land : null;
  canvas.append(svg('rect', { width, height: length, fill: land ? '#2c6a96' : shade(heights[0]) }));
  if (land) canvas.append(svg('path', { d: shapePath(land), fill: shade(heights[0]), 'fill-rule': 'evenodd', stroke: '#e6d9a8', 'stroke-width': 2.5, class: 'fixed-stroke', ...hit('land', 0) }));
  canvas.append(svg('rect', { width, height: length, fill: 'none', stroke: '#0c0e10', 'stroke-width': 1.5, class: 'fixed-stroke quiet' }));

  // 2. Areas in paint order: a later one lies on top. Dark stroke for a cliff edge, dashed for a bank.
  listOf('areas').forEach((area, i) => {
    if (!isObject(area)) return;
    const cliff = (area.edge?.kind || 'cliff') === 'cliff';
    canvas.append(svg('path', { d: shapePath(area), fill: shade(number(area.heightMeters, 0)), 'fill-rule': 'evenodd', stroke: cliff ? '#4a3b2a' : '#7c8f5a', 'stroke-width': cliff ? 3 : 1.6, 'stroke-dasharray': cliff ? null : '6 5', class: 'fixed-stroke', ...hit('areas', i) }));
  });
  // 3. Slopes, hatched: edges inside are walkable hillside.
  listOf('slopes').forEach((slope, i) => {
    if (isObject(slope)) canvas.append(svg('path', { d: shapePath(slope), fill: 'url(#plan-hatch)', 'fill-rule': 'evenodd', stroke: '#3a3320', 'stroke-width': 1.2, 'stroke-dasharray': '3 3', class: 'fixed-stroke', ...hit('slopes', i) }));
  });
  // 4. Zones, tinted by what the ground is for.
  listOf('zones').forEach((zone, i) => {
    if (!isObject(zone)) return;
    const [colour, opacity] = ZONE_LOOK[zone.kind] || ['#888888', 0.4];
    canvas.append(svg('path', { d: shapePath(zone), fill: colour, 'fill-opacity': opacity, 'fill-rule': 'evenodd', stroke: colour, 'stroke-width': 1.5, class: 'fixed-stroke', ...hit('zones', i) }));
  });
  // 5 to 7. Rivers (blue), paths (tan) and ramps (pale bars), at their real widths, with a wider unseen line to tap.
  const stroke = (coll, i, feature, attributes, fallback) => {
    const points = linePoints(feature);
    const wide = 2 * number(feature.halfWidthMeters, fallback);
    canvas.append(svg('polyline', { points, fill: 'none', 'stroke-width': wide, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', ...attributes }));
    canvas.append(svg('polyline', { points, fill: 'none', stroke: '#000', 'stroke-opacity': 0, 'stroke-width': Math.max(wide, 16 * px), 'stroke-linecap': 'round', class: 'tap', ...hit(coll, i) }));
    return points;
  };
  const defaults = (coll, key) => state.fields[coll].find((each) => each.path === key)?.default;
  listOf('rivers').forEach((river, i) => {
    if (!isObject(river)) return;
    const points = stroke('rivers', i, river, { stroke: '#2f7fc4', 'stroke-opacity': 0.9 }, defaults('rivers', 'halfWidthMeters') ?? 6);
    canvas.append(svg('polyline', { points, fill: 'none', stroke: '#bfe0f7', 'stroke-width': 1, class: 'fixed-stroke quiet' }));
  });
  listOf('paths').forEach((way, i) => {
    if (!isObject(way)) return;
    const points = stroke('paths', i, way, { stroke: '#c9a36a' }, defaults('paths', 'halfWidthMeters') ?? 2.5);
    canvas.append(svg('polyline', { points, fill: 'none', stroke: '#7a5a2e', 'stroke-width': 1.6, 'stroke-dasharray': way.kind === 'trail' ? '5 4' : null, class: 'fixed-stroke quiet' }));
  });
  listOf('ramps').forEach((ramp, i) => {
    if (!isObject(ramp)) return;
    const points = stroke('ramps', i, ramp, { stroke: '#f4ecd2' }, defaults('ramps', 'halfWidthMeters') ?? 7);
    canvas.append(svg('polyline', { points, fill: 'none', stroke: '#6d5a3a', 'stroke-width': 1.6, 'stroke-dasharray': '5 4', class: 'fixed-stroke quiet' }));
  });
  // Area names sit on the part later areas have not covered (plan-to-svg's rule).
  for (const area of listOf('areas')) {
    if (!isObject(area) || area.kind === 'outcrop') continue;
    const ring = (shapesOf(area)[0]?.outer || []).filter(good);
    if (ring.length < 3) continue;
    const cx = ring.reduce((sum, p) => sum + p[0], 0) / ring.length, cy = ring.reduce((sum, p) => sum + p[1], 0) / ring.length;
    const edge = ring[Math.floor(ring.length * 0.45)];
    canvas.append(label(edge[0] + (cx - edge[0]) * 0.12, edge[1] + (cy - edge[1]) * 0.12, `${area.id} ${area.heightMeters} m`));
  }
  // 8. Anchors: a dot and its name; a bridge is drawn to its far foot.
  listOf('anchors').forEach((anchor, i) => {
    if (!isObject(anchor) || !good(anchor.at)) return;
    const colour = MARKS[anchor.kind] || '#000000';
    if (good(anchor.to)) canvas.append(svg('line', { x1: anchor.at[0], y1: anchor.at[1], x2: anchor.to[0], y2: anchor.to[1], stroke: colour, 'stroke-width': 4, class: 'fixed-stroke quiet' }));
    canvas.append(svg('circle', { cx: anchor.at[0], cy: anchor.at[1], r: 6 * px, fill: colour, stroke: '#ffffff', 'stroke-width': 2, class: 'fixed-stroke quiet' }));
    canvas.append(svg('circle', { cx: anchor.at[0], cy: anchor.at[1], r: 14 * px, fill: '#000', 'fill-opacity': 0, class: 'tap', ...hit('anchors', i) }));
    canvas.append(label(anchor.at[0], anchor.at[1] - 11 * px, anchor.label ? `${anchor.id}: ${anchor.label}` : `${anchor.id}`));
  });
  // A 100 m bar at the low-left corner of the biome.
  canvas.append(svg('line', { x1: 20, y1: length - 22, x2: 120, y2: length - 22, stroke: '#111', 'stroke-width': 3, class: 'fixed-stroke quiet' }), label(70, length - 22 - 7 * px, '100 m'));

  // The selected feature: its outline, a handle on every point, a smaller one on every edge to add a point there,
  // and a square to move the whole thing.
  const feature = featureOf(state.sel);
  if (feature && !state.tool) {
    const parts = partsOf(state.sel.coll, feature);
    for (const part of parts) canvas.append(svg('path', { d: ringPath(part.points, part.closed), fill: 'none', stroke: '#e3b341', 'stroke-width': 2.5, class: 'fixed-stroke quiet' }));
    parts.forEach((part, p) => {
      if (part.fixed) return;
      const count = part.points.length;
      for (let v = 0; v < (part.closed ? count : count - 1); v += 1) {
        const a = part.points[v], b = part.points[(v + 1) % count];
        if (!good(a) || !good(b) || Math.hypot(b[0] - a[0], b[1] - a[1]) < 22 * px) continue;
        const cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2;
        canvas.append(svg('circle', { cx, cy, r: 3.5 * px, fill: '#14171a', stroke: '#e3b341', 'stroke-width': 1.5, class: 'fixed-stroke quiet' }));
        canvas.append(svg('circle', { cx, cy, r: 10 * px, fill: '#000', 'fill-opacity': 0, class: 'tap handle', 'data-handle': 'mid', 'data-p': p, 'data-v': v }));
      }
    });
    parts.forEach((part, p) => part.points.forEach((point, v) => {
      if (!good(point)) return;
      const chosen = state.vertex && state.vertex.p === p && state.vertex.v === v;
      canvas.append(svg('circle', { cx: point[0], cy: point[1], r: (chosen ? 7 : 5.5) * px, fill: chosen ? '#ffffff' : '#e3b341', stroke: '#14171a', 'stroke-width': 1.5, class: 'fixed-stroke quiet' }));
      canvas.append(svg('circle', { cx: point[0], cy: point[1], r: 13 * px, fill: '#000', 'fill-opacity': 0, class: 'tap handle', 'data-handle': 'vertex', 'data-p': p, 'data-v': v }));
    }));
    const box = boundsOf(parts);
    if (box) {
      // Under a small feature, so it never sits on one of its points; inside a large one, so it stays on the biome.
      const small = box.maxY - box.minY < 90 * px;
      const cx = (box.minX + box.maxX) / 2, cy = small ? box.maxY + 26 * px : (box.minY + box.maxY) / 2 + 22 * px, half = 8 * px;
      canvas.append(svg('rect', { x: cx - half, y: cy - half, width: 2 * half, height: 2 * half, rx: 2 * px, fill: '#14171a', stroke: '#e3b341', 'stroke-width': 2, class: 'fixed-stroke quiet' }));
      canvas.append(svg('path', { d: `M${cx - half * 0.6},${cy}H${cx + half * 0.6}M${cx},${cy - half * 0.6}V${cy + half * 0.6}`, stroke: '#e3b341', 'stroke-width': 1.5, class: 'fixed-stroke quiet' }));
      canvas.append(svg('rect', { x: cx - 2 * half, y: cy - 2 * half, width: 4 * half, height: 4 * half, fill: '#000', 'fill-opacity': 0, class: 'tap handle', 'data-handle': 'move' }));
    }
  }
  // The feature being drawn.
  if (state.tool?.points.length) {
    const points = state.tool.points;
    canvas.append(svg('path', { d: ringPath(points, false), fill: 'none', stroke: '#e3b341', 'stroke-width': 2.5, 'stroke-dasharray': '6 4', class: 'fixed-stroke quiet' }));
    for (const point of points) canvas.append(svg('circle', { cx: point[0], cy: point[1], r: 4.5 * px, fill: '#e3b341', stroke: '#14171a', 'stroke-width': 1.5, class: 'fixed-stroke quiet' }));
  }
}

// ---- pointer: pan, pinch, tap, drag ----

const pointers = new Map();
let gesture = null;

function cancelGesture() {
  // A second finger landing mid-drag turns it into a pinch: put the document back as it was.
  if (gesture && (gesture.type === 'vertex' || gesture.type === 'move')) {
    state.doc = JSON.parse(state.last);
    state.vertex = null;
  }
  gesture = null;
}

function startPinch() {
  const [a, b] = [...pointers.values()];
  const midX = (a.x + b.x) / 2, midY = (a.y + b.y) / 2;
  return { type: 'pinch', distance: Math.max(Math.hypot(b.x - a.x, b.y - a.y), 1), scale: state.view.scale, world: toWorld(midX, midY, false) };
}

canvas.addEventListener('pointerdown', (event) => {
  if (!state.doc || (event.pointerType === 'mouse' && event.button !== 0)) return;
  canvas.setPointerCapture(event.pointerId);
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (pointers.size >= 2) {
    cancelGesture();
    if (pointers.size === 2) gesture = startPinch();
    schedule();
    return;
  }
  const target = event.target instanceof Element ? event.target : null;
  const handle = target?.dataset.handle;
  const feature = featureOf(state.sel);
  if (handle && feature && !state.tool) {
    const parts = partsOf(state.sel.coll, feature);
    if (handle === 'move') {
      gesture = { type: 'move', from: toWorld(event.clientX, event.clientY, false), parts, original: parts.map((part) => part.points.map((point) => [...point])), box: boundsOf(parts) };
      return;
    }
    const p = Number(target.dataset.p);
    let v = Number(target.dataset.v);
    if (handle === 'mid') {
      const points = parts[p].points, a = points[v], b = points[(v + 1) % points.length];
      v += 1;
      points.splice(v, 0, [round((a[0] + b[0]) / 2), round((a[1] + b[1]) / 2)]);
    }
    state.vertex = { p, v };
    gesture = { type: 'vertex', point: parts[p].points[v] };
    schedule();
    return;
  }
  const coll = target?.dataset.coll;
  gesture = { type: 'pan', x: event.clientX, y: event.clientY, view: { ...state.view }, moved: false, hit: coll ? { coll, i: Number(target.dataset.i) } : null };
});

canvas.addEventListener('pointermove', (event) => {
  if (!pointers.has(event.pointerId)) return;
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (!gesture) return;
  if (gesture.type === 'pinch') {
    if (pointers.size < 2) return;
    const box = canvas.getBoundingClientRect();
    const [a, b] = [...pointers.values()];
    const midX = (a.x + b.x) / 2, midY = (a.y + b.y) / 2;
    state.view.scale = Math.min(20, Math.max(0.01, gesture.scale * gesture.distance / Math.max(Math.hypot(b.x - a.x, b.y - a.y), 1)));
    state.view.x = gesture.world[0] - (midX - box.left) * state.view.scale;
    state.view.y = gesture.world[1] - (midY - box.top) * state.view.scale;
    applyView();
    schedule();
  } else if (gesture.type === 'pan') {
    const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y;
    if (!gesture.moved && Math.hypot(dx, dy) < 5) return;
    gesture.moved = true;
    state.view.x = gesture.view.x - dx * state.view.scale;
    state.view.y = gesture.view.y - dy * state.view.scale;
    applyView();
  } else if (gesture.type === 'vertex') {
    const [x, y] = toWorld(event.clientX, event.clientY);
    gesture.point[0] = x;
    gesture.point[1] = y;
    schedule();
  } else if (gesture.type === 'move' && gesture.box) {
    // The whole feature keeps its shape: the shift stops where its bounds meet the biome's edge.
    const [width, length] = size();
    const now = toWorld(event.clientX, event.clientY, false);
    const dx = Math.min(width - gesture.box.maxX, Math.max(-gesture.box.minX, now[0] - gesture.from[0]));
    const dy = Math.min(length - gesture.box.maxY, Math.max(-gesture.box.minY, now[1] - gesture.from[1]));
    gesture.parts.forEach((part, p) => part.points.forEach((point, v) => {
      point[0] = round(gesture.original[p][v][0] + dx);
      point[1] = round(gesture.original[p][v][1] + dy);
    }));
    schedule();
  }
});

function release(event) {
  if (!pointers.has(event.pointerId)) return;
  pointers.delete(event.pointerId);
  const ended = gesture;
  if (!ended) return;
  if (ended.type === 'pinch') {
    if (pointers.size < 2) gesture = null;
    return;
  }
  gesture = null;
  if (event.type === 'pointercancel') {
    state.doc = JSON.parse(state.last);
    return renderAll();
  }
  if (ended.type === 'pan') {
    if (!ended.moved) tap(event, ended.hit);
    return;
  }
  commit();
  renderAll();
}
canvas.addEventListener('pointerup', release);
canvas.addEventListener('pointercancel', release);
canvas.addEventListener('wheel', (event) => {
  if (!state.doc) return;
  event.preventDefault();
  zoomAt(event.clientX, event.clientY, Math.exp(Math.max(-120, Math.min(120, event.deltaY)) * 0.0022));
}, { passive: false });
canvas.addEventListener('contextmenu', (event) => event.preventDefault());
new ResizeObserver(() => {
  if (!state.doc) return;
  if (!state.fitted) fit();
  else applyView();
}).observe(canvas);

function tap(event, hit) {
  if (state.tool) {
    const tool = state.tool, now = Date.now();
    const again = tool.points.length && now - tool.at < 450 && Math.hypot(event.clientX - tool.x, event.clientY - tool.y) < 10;
    if (again) return finishTool();
    tool.points.push(toWorld(event.clientX, event.clientY));
    Object.assign(tool, { at: now, x: event.clientX, y: event.clientY });
    if (tool.coll === 'anchors') return finishTool();
    renderTool();
    return schedule();
  }
  select(hit);
}

function select(sel) {
  state.sel = sel && featureOf(sel) ? sel : null;
  state.vertex = null;
  renderAll();
}

// ---- drawing a new feature ----

function startTool(coll) {
  state.tool = { coll, points: [], at: 0, x: 0, y: 0 };
  state.sel = null;
  state.vertex = null;
  renderAll();
}

function cancelTool() {
  state.tool = null;
  renderAll();
}

function finishTool() {
  const tool = state.tool;
  if (!tool) return;
  const least = tool.coll === 'anchors' ? 1 : LINES.includes(tool.coll) ? 2 : 3;
  if (tool.points.length < least) return message(`That needs ${least} points or more; keep clicking, or Cancel.`, true);
  const plan = state.doc, points = tool.points;
  let feature;
  if (tool.coll === 'land') feature = { outer: points };
  else if (tool.coll === 'areas') feature = { id: freshId('area'), kind: 'shelf', heightMeters: round(number(plan.ground?.heightMeters, 6) + 10), edge: { kind: 'cliff' }, outer: points };
  else if (tool.coll === 'slopes') feature = { id: freshId('slope'), outer: points };
  else if (tool.coll === 'zones') feature = { id: freshId('zone'), kind: 'forest', outer: points };
  else if (tool.coll === 'paths') feature = { id: freshId('path'), kind: 'trail', line: points };
  else if (tool.coll === 'rivers') feature = { id: freshId('river'), line: points };
  else if (tool.coll === 'ramps') feature = { id: freshId('ramp'), line: points };
  else feature = { id: freshId('anchor'), kind: 'landmark', at: points[0] };
  state.tool = null;
  if (tool.coll === 'land') {
    plan.land = feature;
    state.sel = { coll: 'land', i: 0 };
  } else {
    if (!Array.isArray(plan[tool.coll])) plan[tool.coll] = [];
    plan[tool.coll].push(feature);
    state.sel = { coll: tool.coll, i: plan[tool.coll].length - 1 };
  }
  message('');
  commit();
  renderAll();
}

function renderTool() {
  const bar = $('plan-hint');
  bar.hidden = !state.tool;
  if (!state.tool) return;
  const tool = state.tool, name = TOOLS.find(([coll]) => coll === tool.coll)[2];
  const least = tool.coll === 'anchors' ? 1 : LINES.includes(tool.coll) ? 2 : 3;
  const done = make('button', { type: 'button', className: 'good', textContent: 'Done', disabled: tool.points.length < least });
  done.addEventListener('click', finishTool);
  const back = make('button', { type: 'button', textContent: 'Undo point', disabled: !tool.points.length });
  back.addEventListener('click', () => { tool.points.pop(); tool.at = 0; renderTool(); schedule(); });
  const cancel = make('button', { type: 'button', textContent: 'Cancel' });
  cancel.addEventListener('click', cancelTool);
  const text = tool.coll === 'anchors' ? 'New anchor: click where it stands.' : `New ${name}: click its points (${tool.points.length} so far, ${least} or more). Double-click or Done to finish.`;
  bar.replaceChildren(make('span', { textContent: text }), done, back, cancel);
}

// ---- panels ----

function deleteVertex() {
  const feature = featureOf(state.sel);
  if (!feature || !state.vertex) return;
  const part = partsOf(state.sel.coll, feature)[state.vertex.p];
  if (!part || part.fixed || part.points.length <= part.least) return;
  part.points.splice(state.vertex.v, 1);
  state.vertex = null;
  commit();
  renderAll();
}

function deleteFeature() {
  if (!featureOf(state.sel)) return;
  if (state.sel.coll === 'land') delete state.doc.land;
  else state.doc[state.sel.coll].splice(state.sel.i, 1);
  state.sel = null;
  state.vertex = null;
  commit();
  renderAll();
}

function reorder(by) {
  const areas = listOf('areas'), from = state.sel.i, to = from + by;
  if (state.sel.coll !== 'areas' || to < 0 || to >= areas.length) return;
  areas.splice(to, 0, ...areas.splice(from, 1));
  state.sel = { coll: 'areas', i: to };
  commit();
  renderAll();
}

// A number from the field table: empty means "absent", which is Unreal's default.
function numberRow(object, row, onSet) {
  const value = getPath(object, row.path);
  const input = make('input', { type: 'number', min: row.min, max: row.max, step: row.step, value: value ?? '', placeholder: row.required ? 'required' : row.default === null ? 'the plan\'s' : `${row.default} (default)` });
  input.addEventListener('change', () => {
    const typed = input.value.trim() === '' ? undefined : Number(input.value);
    onSet(row, Number.isFinite(typed) ? typed : undefined);
    commit();
    renderAll();
  });
  return make('label', { title: `${row.min} to ${row.max} ${row.unit}` }, `${row.label} (${row.unit})`, input);
}

function textRow(labelText, value, onSet, placeholder = '') {
  const input = make('input', { type: 'text', value: value ?? '', placeholder, autocomplete: 'off', spellcheck: false });
  input.addEventListener('change', () => { onSet(input.value.trim()); commit(); renderAll(); });
  return make('label', {}, labelText, input);
}

function selectRow(labelText, options, value, onSet) {
  const select = make('select');
  const shown = value ?? '';
  if (!options.some(([each]) => each === shown)) options = [...options, [shown, shown ? `${shown} (not offered)` : '(none)']];
  select.replaceChildren(...options.map(([each, text]) => make('option', { value: each, textContent: text })));
  select.value = value ?? '';
  select.addEventListener('change', () => { onSet(select.value); commit(); renderAll(); });
  return make('label', {}, labelText, select);
}

function renderSelected() {
  const root = $('plan-selected');
  const feature = featureOf(state.sel);
  if (!feature) {
    root.replaceChildren(make('div', { className: 'muted small', textContent: 'Nothing selected. Click a feature on the drawing or in the list; drag its points; the small dots on its edges add a point.' }));
    return;
  }
  const coll = state.sel.coll, kinds = state.fields.kinds;
  const rows = [];
  if (coll !== 'land') rows.push(textRow('Id (a-z, 0-9, -)', feature.id, (value) => { feature.id = value; }));
  if (coll === 'areas') {
    rows.push(selectRow('Kind (a label)', kinds.areas.map((kind) => [kind, kind]), feature.kind ?? 'shelf', (value) => { feature.kind = value; }));
    rows.push(selectRow('Edge', [['', `default (cliff)`], ...kinds.edge.map((kind) => [kind, kind])], feature.edge?.kind ?? '', (value) => {
      if (value) feature.edge = { kind: value };
      else delete feature.edge;
    }));
  }
  if (coll === 'zones') rows.push(selectRow('Kind', kinds.zones.map((kind) => [kind, kind]), feature.kind, (value) => { feature.kind = value; if (value !== 'pond') delete feature.depthMeters; }));
  if (coll === 'paths') rows.push(selectRow('Kind', [['', 'default (road)'], ...kinds.paths.map((kind) => [kind, kind])], feature.kind ?? '', (value) => { if (value) feature.kind = value; else delete feature.kind; }));
  if (coll === 'anchors') {
    rows.push(selectRow('Kind', kinds.anchors.map((kind) => [kind, kind]), feature.kind, (value) => {
      feature.kind = value;
      // A bridge has two feet: give it a far foot to drag when it becomes one.
      if (state.fields.spans.includes(value) && !good(feature.to) && good(feature.at)) {
        const [width] = size();
        feature.to = [round(Math.min(width, feature.at[0] + 30)), feature.at[1]];
      } else if (!state.fields.spans.includes(value)) delete feature.to;
    }));
    rows.push(textRow('Label', feature.label, (value) => { if (value) feature.label = value; else delete feature.label; }, 'what stands here'));
  }
  for (const row of state.fields[coll] || []) {
    if (row.when && getPath(feature, row.when[0]) !== row.when[1]) continue;
    if (coll === 'zones' && row.path === 'depthMeters' && feature.kind !== 'pond') continue;
    rows.push(numberRow(feature, row, (each, value) => {
      setPath(feature, each.path, value);
      // A tilt is both numbers or neither.
      if (each.path.startsWith('tilt.')) {
        if (value === undefined) delete feature.tilt;
        else for (const key of ['degrees', 'towardDegrees']) if (feature.tilt[key] === undefined) feature.tilt[key] = 0;
      }
    }));
  }
  const parts = partsOf(coll, feature);
  const count = parts.reduce((sum, part) => sum + part.points.length, 0);
  const info = make('div', { className: 'muted small', textContent: coll === 'anchors' ? 'Drag its dot to move it.' : `${count} points${parts.length > 1 ? ` in ${parts.length} rings` : ''}. Drag a point; tap one to choose it.` });
  const buttons = make('div', { className: 'row wrap' });
  if (coll === 'areas') {
    const earlier = make('button', { type: 'button', textContent: 'Paint earlier', disabled: state.sel.i === 0, title: 'Move down the paint order: later areas lie on top' });
    earlier.addEventListener('click', () => reorder(-1));
    const later = make('button', { type: 'button', textContent: 'Paint later', disabled: state.sel.i >= listOf('areas').length - 1, title: 'Move up the paint order' });
    later.addEventListener('click', () => reorder(1));
    buttons.append(earlier, later, make('span', { className: 'muted small', textContent: `${state.sel.i + 1} of ${listOf('areas').length}` }));
  }
  const chosen = state.vertex ? parts[state.vertex.p] : null;
  const removePoint = make('button', { type: 'button', textContent: 'Delete point', disabled: !chosen || chosen.fixed || chosen.points.length <= chosen.least });
  removePoint.addEventListener('click', deleteVertex);
  const remove = make('button', { type: 'button', className: 'bad', textContent: coll === 'land' ? 'Delete land outline' : 'Delete feature' });
  remove.addEventListener('click', deleteFeature);
  if (coll !== 'anchors') buttons.append(removePoint);
  buttons.append(remove);
  root.replaceChildren(make('div', { className: 'group', textContent: coll === 'land' ? 'Land outline' : `${coll.slice(0, -1)} ${feature.id ?? ''}` }), ...rows, info, buttons);
}

function renderPlanProps() {
  const root = $('plan-props');
  const plan = state.doc;
  if (!plan) return root.replaceChildren();
  const rows = [
    textRow('Label', plan.label, (value) => { if (value) plan.label = value; else delete plan.label; }),
    selectRow('Biome palette', state.biomes.map((id) => [id, id]), plan.biome ?? '', (value) => { plan.biome = value; }),
  ];
  let group = null;
  for (const row of state.fields.plan) {
    const name = row.path.split('.')[0];
    if (name !== group) {
      group = name;
      rows.push(make('div', { className: 'group', textContent: { sizeMeters: 'Size', ground: 'Ground', edges: 'Edges', sea: 'Sea' }[name] || name }));
    }
    rows.push(numberRow(plan, row, (each, value) => setPath(plan, each.path, value)));
  }
  root.replaceChildren(...rows);
}

function renderFeatures() {
  const root = $('plan-features');
  root.replaceChildren();
  if (!state.doc) return;
  const entry = (coll, i, text) => {
    const button = make('button', { type: 'button', className: 'feature' + (state.sel?.coll === coll && state.sel.i === i ? ' current' : ''), textContent: text });
    button.addEventListener('click', () => { if (state.tool) state.tool = null; select({ coll, i }); });
    return button;
  };
  if (isObject(state.doc.land)) root.append(make('div', { className: 'group', textContent: NAMES.land }), entry('land', 0, 'land'));
  for (const coll of LAYERS) {
    const list = listOf(coll);
    if (!list.length) continue;
    root.append(make('div', { className: 'group', textContent: `${NAMES[coll]} (${list.length})` }));
    list.forEach((feature, i) => {
      if (!isObject(feature)) return root.append(make('div', { className: 'muted small', textContent: `${coll}[${i}] is not an object` }));
      const more = coll === 'areas' ? ` · ${feature.kind ?? 'shelf'} · ${feature.heightMeters} m` : feature.kind ? ` · ${feature.kind}` : '';
      root.append(entry(coll, i, `${coll === 'areas' ? `${i + 1}. ` : ''}${feature.id}${more}`));
    });
  }
}

function renderProblems() {
  const root = $('plan-problems');
  root.hidden = !state.problems.length;
  root.replaceChildren(make('div', { className: 'group', textContent: `Problems (${state.problems.length})` }), ...state.problems.slice(0, 40).map((problem) => {
    const button = make('button', { type: 'button', className: 'problem', textContent: `${problem.key}: ${problem.message}` });
    button.addEventListener('click', () => {
      const found = /^(\w+)\[(\d+)\]/.exec(problem.key);
      if (found) select({ coll: found[1], i: Number(found[2]) });
      else if (problem.key.startsWith('land')) select({ coll: 'land', i: 0 });
      else $('plan-details').open = true;
    });
    return button;
  }));
}

function updateState() {
  const changed = dirty(), has = Boolean(state.doc);
  $('plan-save').disabled = !has || !changed;
  $('plan-revert').disabled = !has || !changed;
  $('plan-undo').disabled = !state.undo.length;
  $('plan-redo').disabled = !state.redo.length;
  $('plan-new').disabled = !has;
  $('plan-build').disabled = !has || changed || building;
  $('plan-state').textContent = !has ? '' : changed ? 'Unsaved changes. Save before a build: Unreal reads the saved file.' : state.problems.length ? 'Saved, with problems Unreal will refuse.' : 'Saved.';
}

function renderAll() {
  for (const button of $('plan-tools').children) {
    button.classList.toggle('current', state.tool?.coll === button.dataset.coll);
    button.disabled = !state.doc || (button.dataset.coll === 'land' && isObject(state.doc.land));
  }
  renderTool();
  renderFeatures();
  renderSelected();
  renderPlanProps();
  updateState();
  schedule();
}

// ---- load, save, new ----

async function loadPlan(id) {
  const answer = await api('GET', `/api/plans/${id}`);
  Object.assign(state, { id, doc: answer.document, revision: answer.revision, undo: [], redo: [], sel: null, vertex: null, tool: null, problems: answer.problems, fitted: false });
  state.saved = state.last = JSON.stringify(state.doc);
  $('plan').value = id;
  message('');
  renderProblems();
  renderAll();
  fit();
  showBuild((await api('GET', '/api/plans/build')).last);
}

async function loadList(choose) {
  const answer = await api('GET', '/api/plans');
  Object.assign(state, { fields: answer.fields, looks: answer.looks, biomes: answer.biomes });
  $('plan').replaceChildren(...answer.plans.map((plan) => make('option', { value: plan.id, textContent: plan.label && plan.label !== plan.id ? `${plan.id}: ${plan.label}` : plan.id })));
  $('plan-look').replaceChildren(...answer.looks.map((look) => make('option', { value: look.id, textContent: look.label })));
  const id = choose && answer.plans.some((plan) => plan.id === choose) ? choose : answer.plans[0]?.id;
  if (id) await loadPlan(id);
  else message('No plan files yet in Config/Plans.', true);
}

function sayRefusal(error) {
  if (error.details?.length) {
    state.problems = error.details;
    renderProblems();
    message(`Not saved: ${error.details.length} problem${error.details.length === 1 ? '' : 's'}, listed on the left. First: ${error.details[0].key}: ${error.details[0].message}`, true);
  } else message(error.message, true);
}

async function save() {
  try {
    const answer = await api('PUT', `/api/plans/${state.id}`, { document: state.doc, revision: state.revision });
    state.revision = answer.revision;
    state.saved = state.last;
    state.problems = [];
    renderProblems();
    message('Saved.');
    updateState();
  } catch (error) {
    sayRefusal(error);
  }
}

async function newPlan() {
  const id = (window.prompt('Name for the new plan (a-z, 0-9 and -). It starts as a copy of the drawing open now, as it is on screen.', `${state.id}-2`) || '').trim();
  if (!id) return;
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(id)) return message('A plan name is 1 to 48 characters: a-z, 0-9 and -, not starting with -.', true);
  const document = { ...structuredClone(state.doc), id };
  if (document.label) document.label = `${document.label} (copy)`;
  delete document.drawnBy;
  try {
    await api('PUT', `/api/plans/${id}`, { document, create: true });
    await loadList(id);
    message(`Created ${id} from a copy.`);
  } catch (error) {
    sayRefusal(error);
  }
}

// ---- build ----

let building = false;
function showBuild(last) {
  const images = $('plan-images'), verdicts = $('plan-verdicts'), guide = $('plan-guide'), lines = $('plan-lines');
  images.replaceChildren();
  for (const each of [verdicts, guide, lines]) each.hidden = true;
  if (!last || last.id !== state.id) {
    if (!building) $('plan-build-state').textContent = '';
    return;
  }
  $('plan-build-state').textContent = `${last.ok ? 'Built and rendered' : 'Did not pass'} · look ${last.look} · ${last.seconds.toFixed(0)} s · world verdict ${last.worldVerdict ? 'pass' : 'missing'}, views verdict ${last.viewsVerdict ? 'pass' : 'missing'}${last.error ? ` · ${last.error}` : ''}`;
  for (const view of last.images) {
    images.append(make('figure', {}, make('img', { src: `/plan-views/${view}.png?t=${Date.parse(last.finished)}`, alt: `${view} view`, loading: 'lazy' }), make('figcaption', { className: 'muted small', textContent: view })));
  }
  verdicts.textContent = last.verdicts.join('\n') || 'No verdict line was printed.';
  verdicts.hidden = false;
  guide.textContent = last.guide.join('\n');
  guide.hidden = !last.guide.length;
  lines.textContent = last.lines.join('\n');
  lines.hidden = last.ok || !last.lines.length;
}

async function runBuild() {
  building = true;
  updateState();
  try {
    await api('POST', `/api/plans/${state.id}/build`, { look: $('plan-look').value });
    const started = Date.now();
    for (;;) {
      $('plan-build-state').textContent = `Unreal is building and rendering… ${Math.round((Date.now() - started) / 1000)} s`;
      await new Promise((resolve) => setTimeout(resolve, 2500));
      const status = await api('GET', '/api/plans/build');
      if (status.running) continue;
      building = false;
      showBuild(status.last);
      break;
    }
  } catch (error) {
    $('plan-build-state').textContent = error.message;
  } finally {
    building = false;
    updateState();
  }
}

// ---- wiring ----

$('plan-tools').replaceChildren(...TOOLS.map(([coll, text]) => {
  const button = make('button', { type: 'button', textContent: text, disabled: true });
  button.dataset.coll = coll;
  button.addEventListener('click', () => (state.tool?.coll === coll ? cancelTool() : startTool(coll)));
  return button;
}));

$('plan').addEventListener('change', (event) => {
  if (dirty() && !window.confirm('Leave this plan without saving? The changes will be lost.')) {
    event.target.value = state.id;
    return;
  }
  loadPlan(event.target.value).catch((error) => message(error.message, true));
});
$('plan-save').addEventListener('click', save);
$('plan-revert').addEventListener('click', () => loadPlan(state.id).catch((error) => message(error.message, true)));
$('plan-new').addEventListener('click', newPlan);
$('plan-undo').addEventListener('click', () => step(state.undo, state.redo));
$('plan-redo').addEventListener('click', () => step(state.redo, state.undo));
$('plan-fit').addEventListener('click', fit);
const middle = () => { const box = canvas.getBoundingClientRect(); return [box.left + box.width / 2, box.top + box.height / 2]; };
$('plan-zoom-in').addEventListener('click', () => zoomAt(...middle(), 1 / 1.4));
$('plan-zoom-out').addEventListener('click', () => zoomAt(...middle(), 1.4));
$('plan-build').addEventListener('click', runBuild);

document.addEventListener('keydown', (event) => {
  if ($('section-drawer').hidden || !state.doc || event.target.closest?.('input, select, textarea')) return;
  const key = event.key.toLowerCase();
  if ((event.ctrlKey || event.metaKey) && key === 'z') { event.preventDefault(); return event.shiftKey ? step(state.redo, state.undo) : step(state.undo, state.redo); }
  if ((event.ctrlKey || event.metaKey) && key === 'y') { event.preventDefault(); return step(state.redo, state.undo); }
  if (key === 'escape') return state.tool ? cancelTool() : select(null);
  if (key === 'enter' && state.tool) return finishTool();
  if ((key === 'delete' || key === 'backspace') && state.vertex) { event.preventDefault(); deleteVertex(); }
});
window.addEventListener('beforeunload', (event) => { if (state.doc && dirty()) event.preventDefault(); });

// The section buttons are switched by biomes.js; the drawer loads the first time it is shown.
document.querySelector('.section[data-section="drawer"]').addEventListener('click', () => {
  if (state.started) return requestAnimationFrame(() => (state.fitted ? applyView() : fit()));
  state.started = true;
  loadList().catch((error) => { state.started = false; message(error.message, true); });
});
