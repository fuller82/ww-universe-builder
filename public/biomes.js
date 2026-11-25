// Biomes: choose which assets fill each role, set the ground and scatter numbers, and ask Unreal for a preview.
// Ranges and role names come from the project's field table; the server and Unreal judge, this page only edits.
const $ = (id) => document.getElementById(id);
const state = { fields: null, looks: [], meshes: new Map(), saved: null, draft: null, id: null, pickerRole: null };

async function api(method, url, body) {
  const response = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const answer = await response.json();
  if (!response.ok || answer.ok === false) throw Object.assign(new Error(answer.error || `${method} ${url} failed (${response.status})`), { details: answer.details });
  return answer;
}

function message(text, error = false) {
  const box = $('biome-message');
  box.hidden = !text;
  box.textContent = text || '';
  box.classList.toggle('error', error);
}

const dirty = () => JSON.stringify(state.draft) !== JSON.stringify(state.saved);

function updateState() {
  const changed = dirty();
  $('biome-save').disabled = !changed;
  $('biome-revert').disabled = !changed;
  $('preview-run').disabled = changed;
  $('biome-state').textContent = changed ? 'Unsaved changes. Save before a preview: Unreal reads the saved file.' : 'Saved.';
}

function meshCard(id, { removable, onClick }) {
  const mesh = state.meshes.get(id);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'card' + (mesh ? '' : ' missing');
  button.title = removable ? `${id}\nClick to remove` : id;
  const image = document.createElement('img');
  image.loading = 'lazy';
  image.alt = '';
  if (mesh?.thumb) image.src = `/thumbs/${mesh.thumb}`;
  const body = document.createElement('div');
  body.className = 'body';
  body.append(
    Object.assign(document.createElement('div'), { className: 'name', textContent: mesh ? mesh.name : id }),
    Object.assign(document.createElement('div'), { className: 'meta', textContent: mesh ? `${mesh.pack} · ${mesh.sizeMeters[2].toFixed(1)} m tall` : 'not in the catalogue' }));
  button.append(image, body);
  button.addEventListener('click', onClick);
  return button;
}

function renderRoles() {
  const root = $('biome-roles');
  root.replaceChildren();
  for (const role of state.fields.roles) {
    const ids = state.draft.roles[role.key] || [];
    const section = document.createElement('section');
    section.className = 'role';
    const head = document.createElement('div');
    head.className = 'role-head';
    const add = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Add…' });
    add.addEventListener('click', () => openPicker(role));
    head.append(
      Object.assign(document.createElement('h2'), { className: 'heading', textContent: `${role.label} (${ids.length})` }),
      Object.assign(document.createElement('span'), { className: 'muted small', textContent: role.help }),
      Object.assign(document.createElement('span'), { className: 'spacer' }), add);
    const strip = document.createElement('div');
    strip.className = 'grid strip';
    for (const id of ids) {
      strip.append(meshCard(id, { removable: true, onClick: () => {
        state.draft.roles[role.key] = state.draft.roles[role.key].filter((each) => each !== id);
        renderRoles();
        updateState();
      } }));
    }
    if (!ids.length) strip.append(Object.assign(document.createElement('div'), { className: 'muted small empty', textContent: 'None chosen.' }));
    section.append(head, strip);
    root.append(section);
  }
}

function renderFields() {
  const root = $('biome-fields');
  root.replaceChildren();
  let group = null;
  for (const row of state.fields.fields) {
    if (row.group !== group) {
      group = row.group;
      root.append(Object.assign(document.createElement('div'), { className: 'group', textContent: group }));
    }
    const value = state.draft[row.group]?.[row.key] ?? row.default;
    const label = document.createElement('label');
    label.title = row.help;
    const text = document.createElement('span');
    const readout = Object.assign(document.createElement('b'), { textContent: `${value} ${row.unit}` });
    text.append(`${row.label} `, readout);
    const input = Object.assign(document.createElement('input'), { type: 'range', min: row.min, max: row.max, step: row.step, value });
    input.addEventListener('input', () => {
      state.draft[row.group] = state.draft[row.group] || {};
      state.draft[row.group][row.key] = Number(input.value);
      readout.textContent = `${input.value} ${row.unit}`;
      updateState();
    });
    label.append(text, input);
    root.append(label);
  }
}

function renderPicker() {
  const role = state.pickerRole;
  const query = $('picker-search').value.trim().toLowerCase();
  const approvedOnly = $('picker-approved').checked, anyRole = $('picker-any-role').checked;
  const chosen = new Set(state.draft.roles[role.key] || []);
  const list = [...state.meshes.values()].filter((mesh) =>
    (anyRole || (mesh.role || mesh.suggestedRole) === role.key) &&
    (!approvedOnly || mesh.status === 'approved') && mesh.status !== 'rejected' &&
    (!query || mesh.name.toLowerCase().includes(query) || mesh.pack.toLowerCase().includes(query)))
    .sort((a, b) => a.pack.localeCompare(b.pack) || a.name.localeCompare(b.name));
  $('picker-title').textContent = `Add ${role.label.toLowerCase()} (${list.length} offered)`;
  $('picker-grid').replaceChildren(...list.map((mesh) => {
    const card = meshCard(mesh.id, { removable: false, onClick: () => {
      const ids = state.draft.roles[role.key] = state.draft.roles[role.key] || [];
      if (chosen.has(mesh.id)) ids.splice(ids.indexOf(mesh.id), 1);
      else ids.push(mesh.id);
      renderPicker();
      updateState();
    } });
    card.classList.toggle('selected', chosen.has(mesh.id));
    return card;
  }));
}

function openPicker(role) {
  state.pickerRole = role;
  $('picker-search').value = '';
  renderPicker();
  $('picker').showModal();
}

async function loadBiome(id) {
  const answer = await api('GET', `/api/biomes/${id}`);
  state.id = id;
  state.saved = answer.document;
  state.draft = structuredClone(answer.document);
  state.draft.roles = state.draft.roles || {};
  renderFields();
  renderRoles();
  updateState();
  message(answer.problems.length ? `The saved file has problems: ${answer.problems.map((problem) => problem.message).join('; ')}` : '', answer.problems.length > 0);
  showPreview((await api('GET', '/api/biomes/preview')).last);
}

function showPreview(last) {
  const images = $('preview-images');
  images.replaceChildren();
  $('preview-lines').hidden = true;
  if (!last || last.id !== state.id) return;
  $('preview-state').textContent = `${last.ok ? 'Rendered' : 'Did not pass'} · look ${last.look} · ${last.seconds.toFixed(0)} s · world verdict ${last.worldVerdict ? 'pass' : 'missing'}, views verdict ${last.viewsVerdict ? 'pass' : 'missing'}`;
  for (const view of last.images) {
    const figure = document.createElement('figure');
    const image = Object.assign(document.createElement('img'), { src: `/previews/${last.id}/${last.look}/${view}.png?t=${Date.parse(last.finished)}`, alt: `${view} view` });
    figure.append(image, Object.assign(document.createElement('figcaption'), { className: 'muted small', textContent: view }));
    images.append(figure);
  }
  const lines = $('preview-lines');
  lines.textContent = last.lines.join('\n');
  lines.hidden = last.ok;
}

async function runPreview() {
  const button = $('preview-run');
  button.disabled = true;
  try {
    await api('POST', `/api/biomes/${state.id}/preview`, { look: $('preview-look').value });
    const started = Date.now();
    for (;;) {
      $('preview-state').textContent = `Unreal is building and rendering… ${Math.round((Date.now() - started) / 1000)} s`;
      await new Promise((resolve) => setTimeout(resolve, 2500));
      const status = await api('GET', '/api/biomes/preview');
      if (status.running) continue;
      showPreview(status.last);
      break;
    }
  } catch (error) {
    $('preview-state').textContent = error.message;
  } finally {
    updateState();
  }
}

async function start() {
  const [catalog, biomes] = await Promise.all([fetch('/api/catalog').then((response) => response.json()), api('GET', '/api/biomes')]);
  if (catalog.ok) for (const mesh of catalog.meshes) state.meshes.set(mesh.id, mesh);
  state.fields = biomes.fields;
  state.looks = biomes.looks;
  $('biome').replaceChildren(...biomes.biomes.map((biome) => Object.assign(document.createElement('option'), { value: biome.id, textContent: biome.label })));
  $('preview-look').replaceChildren(...biomes.looks.map((look) => Object.assign(document.createElement('option'), { value: look.id, textContent: look.label })));
  if (biomes.biomes.length) await loadBiome(biomes.biomes[0].id);
  else message('No biome files yet in Config/Biomes.', true);
}

for (const button of document.querySelectorAll('.section[data-section]')) {
  button.addEventListener('click', () => {
    for (const each of document.querySelectorAll('.section[data-section]')) {
      each.classList.toggle('current', each === button);
      $(`section-${each.dataset.section}`).hidden = each !== button;
    }
    $('refresh').hidden = button.dataset.section !== 'assets';
    $('generated').hidden = button.dataset.section !== 'assets';
    if (button.dataset.section === 'biomes' && !state.fields) start().catch((error) => message(error.message, true));
  });
}

$('biome').addEventListener('change', (event) => loadBiome(event.target.value).catch((error) => message(error.message, true)));
$('biome-revert').addEventListener('click', () => loadBiome(state.id));
$('biome-save').addEventListener('click', async () => {
  try {
    await api('PUT', `/api/biomes/${state.id}`, { document: state.draft });
    await loadBiome(state.id);
  } catch (error) {
    message(error.details ? error.details.map((problem) => problem.message).join('; ') : error.message, true);
  }
});
$('preview-run').addEventListener('click', runPreview);
$('picker-close').addEventListener('click', () => { $('picker').close(); renderRoles(); });
$('picker').addEventListener('close', renderRoles);
for (const id of ['picker-search', 'picker-approved', 'picker-any-role']) $(id).addEventListener('input', renderPicker);
