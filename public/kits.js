// Kits: what has been bought or downloaded, read from the archives, with our notes on each. Animation packs open to
// show every clip, grouped by what it is for.
(() => {
  const $ = (id) => document.getElementById(id);
  const state = { data: null, open: new Set(), use: '' };
  const USES = ['attack', 'dodge-roll', 'jump', 'sprint-run-walk', 'block-parry', 'hit-death', 'idle-turn', 'other'];
  const USE_LABEL = { 'attack': 'Attacks', 'dodge-roll': 'Dodges and rolls', 'jump': 'Jumps', 'sprint-run-walk': 'Walk, run, sprint', 'block-parry': 'Block and parry', 'hit-death': 'Hits and deaths', 'idle-turn': 'Idles and turns', 'other': 'Other' };

  async function api(method, url) {
    const response = await fetch(url, { method });
    const answer = await response.json();
    if (!response.ok || answer.ok === false) throw new Error(answer.error || `${method} ${url} failed (${response.status})`);
    return answer;
  }

  const el = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; };

  function render() {
    const data = state.data;
    const box = $('kits-list');
    box.textContent = '';
    if (!data) return;
    $('kits-scanned').textContent = data.scanned ? `Read ${new Date(data.scanned).toLocaleString()} from ${data.folder}` : 'Not read yet: press Read the archives.';
    const totals = $('kits-totals');
    totals.textContent = '';
    totals.append(el('div', 'summary-row', `${data.totals.kits} kits, ${(data.totals.megabytes / 1024).toFixed(1)} GB, ${data.totals.clips} animation clips`));
    for (const use of USES) {
      const count = data.totals.uses[use] || 0;
      if (!count) continue;
      const row = el('button', 'use-filter' + (state.use === use ? ' current' : ''), `${USE_LABEL[use]}: ${count}`);
      row.type = 'button';
      row.addEventListener('click', () => { state.use = state.use === use ? '' : use; render(); });
      totals.append(row);
    }
    const kinds = ['animation', 'character', 'weapon', 'building', 'nature', 'prop', 'other'];
    const sorted = [...data.kits].sort((a, b) => kinds.indexOf(a.kind) - kinds.indexOf(b.kind) || (a.title || a.file).localeCompare(b.title || b.file));
    for (const kit of sorted) {
      if (state.use && !(kit.clipUses && kit.clipUses[state.use])) continue;
      const card = el('div', 'kit');
      const head = el('div', 'kit-head');
      head.append(el('span', 'kit-title', kit.title || kit.file), el('span', `kit-status status-${kit.status || 'downloaded'}`, kit.status || 'downloaded'), el('span', 'kit-kind', kit.kind));
      card.append(head);
      card.append(el('div', 'muted small', `${kit.maker || 'maker not recorded'}  ·  ${kit.megabytes} MB  ·  ${Object.entries(kit.formats).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([ext, n]) => `${n} ${ext}`).join(', ')}`));
      if (kit.use) card.append(el('div', 'kit-use', kit.use));
      if (kit.licence) card.append(el('div', 'small', `Licence: ${kit.licence}`));
      if (kit.unreal) card.append(el('div', 'small muted', `In Unreal: ${kit.unreal}`));
      if (!kit.known) card.append(el('div', 'small error', 'No notes yet: add this file to kits.registry.json.'));
      if (kit.clipCount) {
        const toggle = el('button', 'kit-toggle', `${state.open.has(kit.file) ? 'Hide' : 'Show'} ${kit.clipCount} clips`);
        toggle.type = 'button';
        toggle.addEventListener('click', () => { state.open.has(kit.file) ? state.open.delete(kit.file) : state.open.add(kit.file); render(); });
        card.append(toggle);
        card.append(el('div', 'small muted', USES.filter((u) => kit.clipUses[u]).map((u) => `${USE_LABEL[u]} ${kit.clipUses[u]}`).join('  ·  ')));
        if (state.open.has(kit.file)) {
          for (const use of USES) {
            if (state.use && use !== state.use) continue;
            const clips = kit.clips.filter((c) => c.use === use);
            if (!clips.length) continue;
            card.append(el('div', 'clip-use', `${USE_LABEL[use]} (${clips.length})`));
            card.append(el('div', 'clip-names', clips.map((c) => c.name + (c.rootMotion ? '*' : '')).join(', ')));
          }
          card.append(el('div', 'small muted', '* travels (root motion)'));
        }
      }
      box.append(card);
    }
  }

  async function load() {
    try { state.data = await api('GET', '/api/kits'); render(); } catch (error) { $('kits-scanned').textContent = error.message; }
  }

  $('kits-scan').addEventListener('click', async () => {
    $('kits-scan').disabled = true;
    $('kits-scanned').textContent = 'Reading the archives...';
    try { state.data = await api('POST', '/api/kits/scan'); render(); } catch (error) { $('kits-scanned').textContent = error.message; }
    $('kits-scan').disabled = false;
  });
  document.querySelector('.section[data-section="kits"]').addEventListener('click', load);
})();
