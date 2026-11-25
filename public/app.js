// Assets: browse what the Unreal project holds, give each mesh a role, approve or reject it.
// The catalogue is Unreal's export; this page only writes roles and review status.
const $ = (id) => document.getElementById(id);
const state = { meshes: [], roles: [], statuses: [], selected: new Set(), shown: [] };

async function api(method, url, body) {
  const response = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const answer = await response.json();
  if (!response.ok || answer.ok === false) throw new Error(answer.error || `${method} ${url} failed (${response.status})`);
  return answer;
}

function message(text, error = false) {
  const box = $('message');
  box.hidden = !text;
  box.textContent = text || '';
  box.classList.toggle('error', error);
}

function fillSelect(select, options, keep) {
  const previous = keep ? select.value : null;
  select.replaceChildren(...options.map(([value, label]) => Object.assign(document.createElement('option'), { value, textContent: label })));
  if (previous !== null && options.some(([value]) => value === previous)) select.value = previous;
}

const effectiveRole = (mesh) => mesh.role || mesh.suggestedRole;

function applyFilters() {
  const query = $('search').value.trim().toLowerCase();
  const pack = $('pack').value, role = $('role').value, status = $('status').value, sort = $('sort').value;
  let list = state.meshes.filter((mesh) =>
    (!pack || mesh.pack === pack) &&
    (!role || effectiveRole(mesh) === role) &&
    (!status || mesh.status === status) &&
    (!query || mesh.name.toLowerCase().includes(query) || mesh.folder.toLowerCase().includes(query)));
  if (sort === 'height') list = [...list].sort((a, b) => b.sizeMeters[2] - a.sizeMeters[2]);
  else if (sort === 'triangles') list = [...list].sort((a, b) => b.triangles - a.triangles);
  else list = [...list].sort((a, b) => a.name.localeCompare(b.name) || a.pack.localeCompare(b.pack));
  state.shown = list;
  render();
}

function card(mesh) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'card' + (state.selected.has(mesh.id) ? ' selected' : '');
  button.dataset.id = mesh.id;
  button.title = mesh.id;
  const image = document.createElement('img');
  image.loading = 'lazy';
  image.alt = '';
  if (mesh.thumb) image.src = `/thumbs/${mesh.thumb}`;
  const body = document.createElement('div');
  body.className = 'body';
  const name = Object.assign(document.createElement('div'), { className: 'name', textContent: mesh.name });
  const [x, y, z] = mesh.sizeMeters;
  const meta = Object.assign(document.createElement('div'), {
    className: 'meta',
    textContent: `${mesh.pack} · ${z.toFixed(1)} m tall · ${Math.max(x, y).toFixed(1)} m wide · ${mesh.triangles.toLocaleString()} tris`,
  });
  const tags = document.createElement('div');
  tags.className = 'tags';
  tags.append(Object.assign(document.createElement('span'), { className: 'tag' + (mesh.role ? '' : ' guess'), textContent: effectiveRole(mesh) }));
  if (mesh.status !== 'unreviewed') tags.append(Object.assign(document.createElement('span'), { className: `tag ${mesh.status}`, textContent: mesh.status }));
  body.append(name, meta, tags);
  button.append(image, body);
  return button;
}

function render() {
  $('grid').replaceChildren(...state.shown.map(card));
  const approved = state.meshes.filter((mesh) => mesh.status === 'approved').length;
  const rejected = state.meshes.filter((mesh) => mesh.status === 'rejected').length;
  $('summary').innerHTML = '';
  $('summary').append(
    line('Meshes', state.meshes.length), line('Approved', approved), line('Rejected', rejected),
    line('Unreviewed', state.meshes.length - approved - rejected));
  updateActions();
}

function line(label, value) {
  const row = document.createElement('div');
  row.append(`${label}: `, Object.assign(document.createElement('b'), { textContent: value.toLocaleString() }));
  return row;
}

function updateActions() {
  const selected = state.selected.size;
  $('count').textContent = `${state.shown.length.toLocaleString()} shown · ${selected.toLocaleString()} selected`;
  for (const id of ['approve', 'reject', 'unreview', 'set-role', 'select-none']) $(id).disabled = selected === 0;
}

async function load() {
  const answer = await fetch('/api/catalog').then((response) => response.json());
  if (!answer.ok) {
    state.meshes = [];
    render();
    message(answer.error, true);
    return;
  }
  message('');
  state.meshes = answer.meshes;
  state.roles = answer.roles;
  state.statuses = answer.statuses;
  $('generated').textContent = `Catalogue exported ${new Date(answer.generated).toLocaleString()}`;
  const packs = [...new Set(answer.meshes.map((mesh) => mesh.pack))].sort();
  fillSelect($('pack'), [['', 'All packs'], ...packs.map((pack) => [pack, `${pack} (${answer.meshes.filter((mesh) => mesh.pack === pack).length})`])], true);
  fillSelect($('role'), [['', 'All roles'], ...answer.roles.map((role) => [role, role])], true);
  fillSelect($('status'), [['', 'Any review state'], ...answer.statuses.map((status) => [status, status])], true);
  fillSelect($('set-role'), [['', 'choose…'], ...answer.roles.map((role) => [role, role]), ['__clear', 'back to the guess']], false);
  for (const id of [...state.selected]) if (!answer.meshes.some((mesh) => mesh.id === id)) state.selected.delete(id);
  applyFilters();
}

async function change(body) {
  try {
    await api('PUT', '/api/assets/role', { ids: [...state.selected], ...body });
    await load();
  } catch (error) {
    message(error.message, true);
  }
}

let lastClicked = null;
$('grid').addEventListener('click', (event) => {
  const element = event.target.closest('.card');
  if (!element) return;
  const id = element.dataset.id;
  if (event.shiftKey && lastClicked) {
    // Shift-click selects the run between the last click and this one.
    const ids = state.shown.map((mesh) => mesh.id);
    const [from, to] = [ids.indexOf(lastClicked), ids.indexOf(id)].sort((a, b) => a - b);
    if (from >= 0) for (const each of ids.slice(from, to + 1)) state.selected.add(each);
  } else if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  lastClicked = id;
  for (const each of $('grid').children) each.classList.toggle('selected', state.selected.has(each.dataset.id));
  updateActions();
});

for (const id of ['search', 'pack', 'role', 'status', 'sort']) $(id).addEventListener('input', applyFilters);
$('select-all').addEventListener('click', () => { for (const mesh of state.shown) state.selected.add(mesh.id); render(); });
$('select-none').addEventListener('click', () => { state.selected.clear(); render(); });
$('approve').addEventListener('click', () => change({ status: 'approved' }));
$('reject').addEventListener('click', () => change({ status: 'rejected' }));
$('unreview').addEventListener('click', () => change({ status: 'unreviewed' }));
$('set-role').addEventListener('change', (event) => {
  const value = event.target.value;
  if (value) change({ role: value === '__clear' ? null : value });
});

$('refresh').addEventListener('click', async () => {
  const button = $('refresh');
  button.disabled = true;
  try {
    await api('POST', '/api/catalog/refresh');
    message('Asking Unreal for the catalogue…');
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const status = await api('GET', '/api/catalog/refresh');
      if (status.running) continue;
      if (!status.last?.ok) throw new Error(`Unreal's export did not pass: ${status.last?.error || status.last?.lines?.slice(-1)[0] || 'no verdict line'}`);
      await load();
      message(`Catalogue refreshed in ${status.last.seconds.toFixed(0)} s.`);
      break;
    }
  } catch (error) {
    message(error.message, true);
  } finally {
    button.disabled = false;
  }
});

load().catch((error) => message(error.message, true));
