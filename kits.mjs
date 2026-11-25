// Kits: an inventory of the asset and animation packs that have been bought or downloaded, read from the archives
// themselves (nothing is unpacked). For each archive: what it holds by file type, its licence files, and for
// animation packs every clip by category. kits.registry.json (tracked) adds what a file listing cannot know: who made
// it, what it is for, and where it stands in the Unreal project.
//
//   GET  /api/kits        the last scan merged with the registry
//   POST /api/kits/scan   read the archives again (WW_KITS_DIR, default the user's Downloads folder)
//
// The scan is kept in data/kits.json ("ww-kits/1"), which stays on this machine like the rest of data/.
import path from 'node:path';
import os from 'node:os';
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';

const SKIP = /\.(exe|msi|ini)$|^PRIME|GetFWVer|Setup/i;
const ARCHIVE = /\.(zip|unitypackage)$/i;
// Windows' own tar (bsdtar) reads zip archives; a tar from Git or MSYS earlier on the PATH does not.
const TAR = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';

function list(archive) {
  // Windows ships bsdtar as tar.exe, which lists zip archives; a .unitypackage is a gzipped tar.
  return new Promise((resolve) => {
    execFile(TAR, ['-tf', archive], { maxBuffer: 256 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
      resolve(error ? [] : stdout.split(/\r?\n/).filter(Boolean));
    });
  });
}

function extract(archive, entry, limit = 96 * 1024 * 1024) {
  return new Promise((resolve) => {
    execFile(TAR, ['-xOf', archive, entry], { maxBuffer: limit, encoding: 'buffer', windowsHide: true }, (error, stdout) => {
      resolve(error ? null : stdout);
    });
  });
}

// The animation names inside a .glb: its first chunk is JSON.
function glbAnimations(buffer) {
  if (!buffer || buffer.length < 20 || buffer.readUInt32LE(0) !== 0x46546c67) return [];
  const length = buffer.readUInt32LE(12);
  try {
    const json = JSON.parse(buffer.subarray(20, 20 + length).toString('utf8'));
    return (json.animations || []).map((a) => a.name).filter(Boolean);
  } catch {
    return [];
  }
}

const KINDS = [
  ['animation', /anim|motion|combat|locomotion/i],
  ['character', /character|outfit|mannequin|npc/i],
  ['weapon', /weapon|sword|shield/i],
  ['nature', /nature|forest|tree|foliage/i],
  ['building', /village|building|house|viking|medieval/i],
  ['prop', /prop|kit/i],
];

// What a clip is for, from its name: the buckets the controller work is planned against.
const CLIP_USE = [
  ['attack', /attack|slash|chop|stab|thrust|combo|strike|swing|bash|kick|punch|spin|lunge|shoot|cast|slam|sweep/i],
  ['dodge-roll', /dodge|roll|sidestep|dash|flip|backstep|slide/i],
  ['jump', /jump|fall|land/i],
  ['sprint-run-walk', /sprint|run|walk|jog|strafe|sneak|crouch|march|crawl/i],
  ['block-parry', /block|parry|guard|shield/i],
  ['hit-death', /hit|death|die|stagger|knock|stun|recoil|get_up|wound/i],
  ['idle-turn', /idle|turn|stance|look/i],
];

function clipUse(name) {
  for (const [use, pattern] of CLIP_USE) if (pattern.test(name)) return use;
  return 'other';
}

async function scanArchive(file, size) {
  const entries = await list(file);
  const files = entries.filter((e) => !e.endsWith('/'));
  const formats = {};
  for (const entry of files) {
    const ext = (path.extname(entry).slice(1) || 'none').toLowerCase();
    formats[ext] = (formats[ext] || 0) + 1;
  }
  const licences = files.filter((e) => /licen[sc]e|credits/i.test(path.basename(e))).slice(0, 6);
  const tops = {};
  for (const entry of files) {
    const parts = entry.split('/').filter(Boolean);
    const key = parts.length > 2 ? parts.slice(0, 2).join('/') : parts[0];
    tops[key] = (tops[key] || 0) + 1;
  }
  // Clips. Three layouts are known: one .fbx per clip in category folders (with a Male and a Female copy), Unreal
  // .uasset clips named AS_*, and one .glb holding every clip.
  const clips = new Map();
  const perClip = files.filter((e) => /\.fbx$/i.test(e) && /\/Male\/FBX\//.test(e) && !/all_animations/i.test(e));
  for (const entry of perClip) {
    const parts = entry.split('/');
    const name = path.basename(entry, '.fbx');
    clips.set(name, { name, category: parts[parts.length - 2], rootMotion: /_rootmotion$/.test(name) });
  }
  for (const entry of files.filter((e) => /\/AS_[^/]+\.uasset$/.test(e))) {
    const name = path.basename(entry, '.uasset');
    const short = name.replace(/^AS_/, '').replace(/^(SwordAndShield|SwordSword|SwordShield)Anim/, '');
    clips.set(name, { name: short, category: (short.split('_')[1] || 'Other').replace(/\d+$/, ''), rootMotion: /_RM$/.test(name) });
  }
  {
    // One .glb holding every clip (the Universal Animation Library) wins over any .fbx beside it.
    const glb = clips.size === 0 && files.find((e) => /\.glb$/i.test(e) && !/_RM\.glb$/i.test(e) && /UAL/i.test(e));
    if (glb) for (const name of glbAnimations(await extract(file, glb))) clips.set(name, { name, category: name.split('_')[0], rootMotion: false });
  }
  if (clips.size === 0 && /anim/i.test(path.basename(file))) {
    // A plain folder of .fbx clips (the archery pack): the category is the clip name's first word.
    for (const entry of files.filter((e) => /\.fbx$/i.test(e) && !/\/Weapon\//.test(e))) {
      const name = path.basename(entry, '.fbx');
      const words = name.split(/[_ ]/).filter(Boolean);
      clips.set(name, { name, category: words[1] || words[0] || 'Other', rootMotion: /RM|root/i.test(name) });
    }
  }
  const uses = {};
  const categories = {};
  for (const clip of clips.values()) {
    clip.use = clipUse(clip.name);
    uses[clip.use] = (uses[clip.use] || 0) + 1;
    categories[clip.category] = (categories[clip.category] || 0) + 1;
  }
  const name = path.basename(file);
  const kind = clips.size > 0 ? 'animation' : (KINDS.find(([, pattern]) => pattern.test(name)) || ['other'])[0];
  return {
    file: name,
    megabytes: Math.round(size / 1048576),
    entries: files.length,
    kind,
    formats,
    licences,
    folders: Object.entries(tops).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([folder, count]) => ({ folder, count })),
    clipCount: clips.size,
    clipUses: uses,
    clipCategories: categories,
    clips: [...clips.values()].sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name)),
  };
}

export function createKits(config, here) {
  const folder = process.env.WW_KITS_DIR || path.join(os.homedir(), 'Downloads');
  const saved = path.join(here, 'data', 'kits.json');
  const registryFile = path.join(here, 'kits.registry.json');
  let scanning = false;

  async function scan() {
    const kits = [];
    for (const name of (await readdir(folder)).sort()) {
      if (!ARCHIVE.test(name) || SKIP.test(name)) continue;
      const full = path.join(folder, name);
      const info = await stat(full);
      if (info.isFile()) kits.push(await scanArchive(full, info.size));
    }
    const result = { schema: 'ww-kits/1', scanned: new Date().toISOString(), folder, kits };
    await mkdir(path.dirname(saved), { recursive: true });
    await writeFile(saved, JSON.stringify(result));
    return result;
  }

  async function read() {
    let scanResult = { schema: 'ww-kits/1', scanned: null, folder, kits: [] };
    try { scanResult = JSON.parse(await readFile(saved, 'utf8')); } catch { /* not scanned yet */ }
    let registry = { kits: {} };
    try { registry = JSON.parse(await readFile(registryFile, 'utf8')); } catch { /* no notes yet */ }
    const kits = scanResult.kits.map((kit) => ({ ...kit, ...(registry.kits[kit.file] || {}), known: Boolean(registry.kits[kit.file]) }));
    const totals = { kits: kits.length, megabytes: 0, clips: 0, uses: {} };
    for (const kit of kits) {
      totals.megabytes += kit.megabytes;
      totals.clips += kit.clipCount;
      for (const [use, count] of Object.entries(kit.clipUses || {})) totals.uses[use] = (totals.uses[use] || 0) + count;
    }
    return { ok: true, scanned: scanResult.scanned, folder: scanResult.folder, scanning, totals, kits };
  }

  return async function route(req, res, url, send) {
    const key = `${req.method} ${url.pathname}`;
    if (key === 'GET /api/kits') { send(res, 200, await read()); return true; }
    if (key === 'POST /api/kits/scan') {
      if (scanning) { send(res, 409, { ok: false, error: 'A scan is already running.' }); return true; }
      scanning = true;
      try { await scan(); } finally { scanning = false; }
      send(res, 200, await read());
      return true;
    }
    return false;
  };
}
