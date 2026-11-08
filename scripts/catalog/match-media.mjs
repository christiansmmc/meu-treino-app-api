// match-media.mjs — match openGym exercises to openly licensed (CC BY-SA) exercise media.
//
// Copied into meu-treino-app-api/scripts/catalog from the media research step, with the one non-open
// source removed. Its matches-by-source.json feeds `node build-catalog.mjs <og> --refresh-candidates=...`.
//
// Usage:
//   node match-media.mjs <openGymExercisesDir> <downloadDir> <outDir> [--refresh] [--accept=0.75]
//
// Sources (metadata is downloaded into <downloadDir> on first run, or with --refresh):
//   workoutGuide  bryllim/workout-guide          CC BY-SA 4.0   302 exercises x 3 frames (SVG/PNG 512x512)
//   wger          wger.de API                    CC BY-SA 3.0 / 4.0 per image (see license fields)
//   everkinetic   everkinetic/data               CC BY-SA 4.0   ~270 exercises x 2 frames (SVG/PNG)
//
// Writes: <outDir>/matches.json          openGymId -> chosen match (score >= accept)
//         <outDir>/matches-by-source.json openGymId -> best candidate per source (score >= 0.5)
//         <outDir>/report.txt            the full console report
// Never reads openGym/catalogue/media (that media is licensed for openGym only).

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flags = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? true];
}));
if (args.length < 3) {
  console.error('usage: node match-media.mjs <openGymExercisesDir> <downloadDir> <outDir> [--refresh] [--accept=0.75]');
  process.exit(1);
}
const [OG_DIR, DL_DIR, OUT_DIR] = args.map((p) => path.resolve(p));
const ACCEPT = Number(flags.accept ?? 0.75);
fs.mkdirSync(OUT_DIR, { recursive: true });

const out = [];
const log = (...a) => { const s = a.join(' '); out.push(s); console.log(s); };

// ---------------------------------------------------------------- downloads
const SRC_FILES = {
  workoutGuide: { file: 'workout-guide/manifest.json', url: 'https://raw.githubusercontent.com/bryllim/workout-guide/main/packages/workout-guide/manifest.json' },
  wger: { file: 'wger/exerciseinfo.json', url: 'https://wger.de/api/v2/exerciseinfo/?limit=1000' },
  everkinetic: { file: 'everkinetic/dist-exercises.json', url: 'https://raw.githubusercontent.com/everkinetic/data/main/dist/exercises.json' },
};
async function ensure(key) {
  const { file, url } = SRC_FILES[key];
  const p = path.join(DL_DIR, file);
  if (!fs.existsSync(p) || flags.refresh) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    fs.writeFileSync(p, await r.text());
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// ---------------------------------------------------------------- normalisation
const PHRASES = [
  [/\bfly'?s\b|\bflyes\b|\bflye\b|\bflies\b/g, 'fly'],
  [/\bpress[\s-]?ups?\b|\bpush[\s-]?ups?\b/g, 'pushup'],
  [/\bpull[\s-]?ups?\b/g, 'pullup'],
  [/\bchin[\s-]?ups?\b/g, 'chinup'],
  [/\bsit[\s-]?ups?\b/g, 'situp'],
  [/\bstep[\s-]?ups?\b/g, 'stepup'],
  [/\bstep[\s-]?downs?\b/g, 'stepdown'],
  [/\bpull[\s-]?downs?\b/g, 'pulldown'],
  [/\bpush[\s-]?downs?\b/g, 'pushdown'],
  [/\bskull[\s-]?crushers?\b/g, 'skullcrusher'],
  [/\bhyper[\s-]?extensions?\b/g, 'back extension'],
  [/\bcross[\s-]?overs?\b/g, 'crossover'],
  [/\bbenchpress\b/g, 'bench press'],
  [/\bhammercurls?\b/g, 'hammer curl'],
  [/\bdead[\s-]?lifts?\b/g, 'deadlift'],
  [/\brdl\b/g, 'romanian deadlift'],
  [/\bstiff[\s-]?legged\b/g, 'stiff leg'],
  [/\b(one|single|1)[\s-]?arms?(ed)?\b/g, 'onearm'],
  [/\b(one|single|1)[\s-]?legs?(ged)?\b/g, 'oneleg'],
  [/\bmilitary press\b/g, 'overhead press'],
  [/\btriceps?\b/g, 'triceps'],
  [/\bbiceps?\b/g, 'biceps'],
  [/\bcalves\b/g, 'calf'],
  [/\brear deltoids?\b/g, 'rear delt'],
  [/\bdeltoids?\b/g, 'delt'],
  [/\bbattling\b/g, 'battle'],
  [/\bjumping jacks?\b/g, 'jumping jack'],
  [/\brunning\b/g, 'run'],
  [/\bjogging\b|\bjog\b/g, 'run'],
  [/\bbalance dome\b/g, 'bosu'],
  [/\bswiss ball\b|\bexercise ball\b|\bphysio ball\b/g, 'stability ball'],
  [/\bsz[\s-]?bar\b|\bez[\s-]?bar(bell)?\b|\bez\b/g, 'ezbar'],
  [/\btrap[\s-]?bar\b|\bhex[\s-]?bar\b/g, 'trapbar'],
  [/\bbody[\s-]?weight\b/g, 'bodyweight'],
  [/\bleverage\b/g, 'lever'],
  [/\bwheel roller\b|\bab wheel\b|\bab roller\b/g, 'abwheel'],
  [/\bknees\b/g, 'knee'],
  // a plain "barbell/dumbbell row" is the bent-over row
  [/\bbent[\s-]?over\s+((?:barbell|dumbbell|cable|kettlebell|ezbar)\s+)?rows?\b/g, '$1row'],
  // the lying (close-grip) triceps extension is the skull crusher
  [/\blying (close grip )?triceps extensions?\b/g, 'skullcrusher'],
  [/\bcrunch floor\b/g, 'crunch'],
  [/\b(back|full) squats?\b/g, 'squat'],
  [/\bfront plank\b/g, 'plank'],
  // camera-angle and attachment details are not different exercises
  [/\b(front|back|side|rear) pov\b/g, ' '],
  [/\b(with )?(rope|v bar|straight bar|pro lat bar) attachment\b/g, ' '],
];
const STOP = new Set(['with', 'on', 'the', 'a', 'an', 'and', 'of', 'to', 'in', 'at', 'for', 'from', 'v', 'version', 'your', 'using', 'into', 'over-the', 'male', 'female']);
const KEEP_S = new Set(['triceps', 'biceps', 'press', 'cross', 'abs', 'lats', 'glutes', 'quads', 'delts', 'pecs', 'traps', 'obliques', 'hamstrings', 'bosu', 'plus', 'tabs', 'jacks', 'stairs', 'chess']);
const LOW_WEIGHT = new Map(Object.entries({
  chest: 0.2, pec: 0.2, pecs: 0.2, triceps: 0.2, biceps: 0.2, delt: 0.2, delts: 0.2, lat: 0.2, lats: 0.2,
  ab: 0.2, abs: 0.2, abdominal: 0.2, glute: 0.2, glutes: 0.2, hamstring: 0.2, hamstrings: 0.2, quad: 0.2, quads: 0.2,
  oblique: 0.2, obliques: 0.2, trap: 0.2, traps: 0.2, forearm: 0.2, muscle: 0.2, variation: 0.2, pov: 0.1,
  standing: 0.3, full: 0.25, rope: 0.3, attachment: 0.1, grip: 0.3, bench: 0.5, alternate: 0.6, alternating: 0.6, regular: 0.3, basic: 0.3, classic: 0.3,
  exercise: 0.2, movement: 0.2, normal: 0.3, simple: 0.3, both: 0.4, arms: 0.4,
}));
function stem(w) {
  if (KEEP_S.has(w) || w.length <= 3) return w;
  if (w.endsWith('ies') && w.length > 4) return w.slice(0, -3) + 'y';
  if (/(ss|sh|ch|x)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us')) return w.slice(0, -1);
  return w;
}
function tokenize(name) {
  let s = ` ${name.toLowerCase()} `
    .replace(/[’`]/g, "'")
    .replace(/°/g, ' ')
    .replace(/[()\[\],.;:!?"/+&_]/g, ' ')
    .replace(/(\w)-(\w)/g, '$1 $2')
    .replace(/-/g, ' ');
  // rowing -> row unless it is the rowing machine / ergometer
  if (!/machine|ergometer|erg\b|rower/.test(s) && !/^\s*rowing\s*$/.test(s)) s = s.replace(/\browing\b/g, 'row');
  for (const [re, rep] of PHRASES) s = s.replace(re, rep);
  return s.replace(/'/g, '').split(/\s+/).filter(Boolean)
    .filter((t) => !STOP.has(t) && !/^\d+$/.test(t))
    .map(stem);
}

// ---------------------------------------------------------------- equipment classes
// Each class lists the name tokens that only restate the equipment (removed before name similarity).
const CLASS_TOKENS = {
  barbell: ['barbell', 'olympic'], ez: ['ezbar', 'barbell', 'curl bar'], trapbar: ['trapbar'], landmine: ['landmine', 'barbell'],
  dumbbell: ['dumbbell'], kettlebell: ['kettlebell'], cable: ['cable', 'machine', 'pulley'], smith: ['smith', 'machine'],
  machine: ['lever', 'machine', 'sled'], band: ['band', 'banded', 'resistance', 'loop', 'mini'], ball: ['stability', 'ball'],
  bosu: ['bosu', 'ball'], medball: ['medicine', 'ball', 'slam', 'wall'], plate: ['plate', 'weight'], weighted: ['weighted'],
  bodyweight: ['bodyweight'], suspension: ['suspension', 'trx', 'trainer'], roller: ['roller', 'foam'], abwheel: ['abwheel'],
  rope: [], sandbag: ['sandbag'], cardio: [], unknown: [], assisted: [],
};
const OG_EQUIP = {
  'barbell': 'barbell', 'olympic barbell': 'barbell', 'ez barbell': 'ez', 'trap bar': 'trapbar', 'landmine': 'landmine',
  'dumbbell': 'dumbbell', 'kettlebell': 'kettlebell', 'cable': 'cable', 'smith machine': 'smith', 'leverage machine': 'machine',
  'sled machine': 'machine', 'assisted': 'assisted', 'body weight': 'bodyweight', 'weighted': 'weighted', 'band': 'band',
  'resistance band': 'band', 'suspension trainer': 'suspension', 'stability ball': 'ball', 'bosu ball': 'bosu',
  'medicine ball': 'medball', 'weight plate': 'plate', 'roller': 'roller', 'wheel roller': 'abwheel', 'rope': 'rope',
  'sandbag': 'sandbag', 'stationary bike': 'cardio', 'elliptical machine': 'cardio', 'skierg machine': 'cardio',
  'stepmill machine': 'cardio', 'upper body ergometer': 'cardio', 'macebell': 'macebell', 'tire': 'tire', 'hammer': 'hammer',
};
// [classA, classB, penalty] — soft compatibilities; equal classes have penalty 0.
const SOFT = [
  ['weighted', 'bodyweight', 0.05], ['weighted', 'plate', 0.05], ['assisted', 'bodyweight', 0.05], ['assisted', 'machine', 0.05],
];
function compat(ogClass, srcClasses) {
  let best = null;
  for (const c of srcClasses) {
    let p = null;
    if (c === ogClass) p = 0;
    else if (c === 'cardio' || ogClass === 'cardio') p = 0.03;
    // wger exercises with no equipment listed are bodyweight, machine or cable-stack moves
    else if (c === 'unknown') p = ['bodyweight', 'machine', 'assisted', 'weighted', 'cable'].includes(ogClass) ? 0.1 : null;
    else for (const [a, b, pen] of SOFT) if ((a === ogClass && b === c) || (b === ogClass && a === c)) p = pen;
    if (p !== null && (best === null || p < best)) best = p;
  }
  return best; // null = incompatible
}
function classFromName(tokens) {
  const has = (t) => tokens.includes(t);
  if (has('smith')) return 'smith';
  if (has('cable')) return 'cable';
  if (has('ezbar')) return 'ez';
  if (has('trapbar')) return 'trapbar';
  if (has('landmine')) return 'landmine';
  if (has('kettlebell')) return 'kettlebell';
  if (has('dumbbell')) return 'dumbbell';
  if (has('barbell')) return 'barbell';
  if (has('band') || has('banded')) return 'band';
  if (has('weighted')) return 'weighted';
  if (has('lever') || has('machine') || has('sled')) return 'machine';
  if (has('bosu')) return 'bosu';
  if (has('medicine')) return 'medball';
  if (has('stability') && has('ball')) return 'ball';
  if (has('suspension') || has('trx')) return 'suspension';
  if (has('bodyweight')) return 'bodyweight';
  return null;
}
function contentTokens(tokens, classes) {
  const drop = new Set(['bodyweight']);
  for (const c of classes) for (const t of CLASS_TOKENS[c] ?? []) drop.add(t);
  const kept = tokens.filter((t) => !drop.has(t));
  return kept.length ? kept : tokens; // never empty
}

// ---------------------------------------------------------------- similarity
function lev(a, b) {
  if (Math.abs(a.length - b.length) > 1) return 2;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return dp[a.length][b.length];
}
const wt = (t) => LOW_WEIGHT.get(t) ?? 1;
// weighted Jaccard over token sets; tokens >=5 chars at edit distance 1 count as equal
function similarity(A, B) {
  const a = [...new Set(A)], b = [...new Set(B)];
  const usedB = new Set();
  let inter = 0;
  for (const t of a) {
    let m = b.indexOf(t);
    if (m < 0 && t.length >= 5) m = b.findIndex((u, i) => !usedB.has(i) && u.length >= 5 && lev(t, u) === 1);
    if (m >= 0 && !usedB.has(m)) { usedB.add(m); inter += Math.min(wt(t), wt(b[m])); }
  }
  const total = a.reduce((s, t) => s + wt(t), 0) + b.reduce((s, t) => s + wt(t), 0) - inter;
  return total ? inter / total : 0;
}

// ---------------------------------------------------------------- load sources
const RAW = {
  workoutGuide: 'https://raw.githubusercontent.com/bryllim/workout-guide/main/packages/workout-guide/',
  everkinetic: 'https://raw.githubusercontent.com/everkinetic/data/main/dist/',
};
const WG_EQUIP = {
  Barbell: 'barbell', Dumbbell: 'dumbbell', Machine: 'machine', Cable: 'cable', Bodyweight: 'bodyweight', Cardio: 'cardio',
  Plate: 'plate', Kettlebell: 'kettlebell', 'Pull-up Bar': 'bodyweight', Bench: 'bodyweight', Wall: 'bodyweight',
  Chair: 'bodyweight', Doorway: 'bodyweight', Towel: 'bodyweight', Box: 'bodyweight', 'Stability Ball': 'ball',
  'Resistance Band': 'band',
};
const WGER_EQUIP = {
  Barbell: 'barbell', 'SZ-Bar': 'ez', Dumbbell: 'dumbbell', Kettlebell: 'kettlebell', 'Cable machine': 'cable',
  'Resistance band': 'band', 'Swiss Ball': 'ball', 'none (bodyweight exercise)': 'bodyweight',
};
const WGER_ACCESSORY = new Set(['Bench', 'Incline bench', 'Gym mat', 'Pull-up bar']);
const EK_EQUIP = {
  body: 'bodyweight', machine: 'machine', 'butterfly machine': 'machine', 'chest machine': 'machine',
  'bench press machine': 'machine', 't-bar machine': 'machine', barbell: 'barbell', dumbbell: 'dumbbell', dumbbells: 'dumbbell',
  dumbell: 'dumbbell', 'cable machine': 'cable', cable: 'cable', 'v-bar': 'cable', 'smith machine': 'smith',
  'swiss ball': 'ball', 'exercise ball': 'ball', 'stability ball': 'ball', 'exercise band': 'band', bands: 'band', band: 'band',
  'bosu ball': 'bosu', 'weight plate': 'plate', 'medicine ball': 'medball',
};
const EK_ACCESSORY = new Set(['bench', 'flat bench', 'incline bench', 'decline bench', 'parallel bars', 'pull-up bar', 'bar', 'hyperextension bench', 'balance board']);
const MACHINE_NAME = /\b(leg press|leg curl|leg extension|pec deck|butterfly|chest press|hack squat|machine)\b/i;

function finalize(source, item) {
  const tokens = tokenize(item.name);
  const nameClass = classFromName(tokens);
  let classes = nameClass ? [nameClass] : [...new Set(item.fieldClasses.filter(Boolean))];
  if (!classes.length) {
    classes = item.accessoryOnly ? ['bodyweight']
      : /pull[\s-]?down/i.test(item.name) ? ['cable']
      : MACHINE_NAME.test(item.name) ? ['machine'] : ['unknown'];
  }
  return { source, ...item, tokens, classes, content: contentTokens(tokens, classes) };
}

async function loadSources() {
  const src = {};
  const wg = await ensure('workoutGuide');
  src.workoutGuide = wg.map((e) => finalize('workoutGuide', {
    id: e.slug, name: e.name, fieldClasses: [WG_EQUIP[e.equipment] ?? 'unknown'],
    imageUrls: e.frames.map((f) => RAW.workoutGuide + f.path),
    pngUrls: e.frames.map((f) => RAW.workoutGuide + f.path.replace(/\.svg$/, '.png')),
    license: 'CC BY-SA 4.0',
    attribution: 'Workout Guide by Bryl Lim (https://github.com/bryllim/workout-guide), CC BY-SA 4.0' +
      (e.attribution?.source ? `; first frame adapted from Everkinetic (${e.attribution.source.url})` : ''),
  }));
  const wgerAll = (await ensure('wger')).results;
  src.wger = wgerAll.filter((e) => e.images.length).map((e) => {
    const tr = e.translations.find((t) => t.language === 2) ?? e.translations[0];
    const eq = e.equipment.map((q) => q.name);
    const imgs = [...e.images].sort((a, b) => (b.is_main - a.is_main) || (a.is_ai_generated - b.is_ai_generated));
    const lic = { 1: 'CC BY-SA 3.0', 2: 'CC BY-SA 4.0', 3: 'CC0 1.0', 4: 'CC BY 4.0', 5: 'ODbL' };
    return finalize('wger', {
      id: String(e.id), uuid: e.uuid, name: tr.name,
      fieldClasses: eq.filter((q) => !WGER_ACCESSORY.has(q)).map((q) => WGER_EQUIP[q] ?? 'unknown'),
      accessoryOnly: eq.length > 0 && eq.every((q) => WGER_ACCESSORY.has(q)),
      imageUrls: imgs.map((i) => i.image),
      videoUrls: e.videos.map((v) => v.video),
      images: imgs.map((i) => ({ url: i.image, license: lic[i.license] ?? String(i.license), author: i.license_author || null, ai: i.is_ai_generated, style: i.style })),
      license: [...new Set(imgs.map((i) => lic[i.license] ?? String(i.license)))].join(' / '),
      attribution: 'wger.de exercise images: ' + [...new Set(imgs.map((i) => i.license_author || 'wger.de contributors'))].join(', '),
    });
  });
  const ek = await ensure('everkinetic');
  src.everkinetic = ek.filter((e) => e.png?.length).map((e) => finalize('everkinetic', {
    id: e.id, name: e.title,
    fieldClasses: e.equipment.flatMap((q) => (q === 'barbell or dumbbell' ? ['barbell', 'dumbbell'] : EK_ACCESSORY.has(q) ? [] : [EK_EQUIP[q] ?? 'unknown'])),
    accessoryOnly: e.equipment.length > 0 && e.equipment.every((q) => EK_ACCESSORY.has(q)),
    imageUrls: e.png.map((p) => RAW.everkinetic + p),
    svgUrls: (e.svg ?? []).map((p) => RAW.everkinetic + p),
    license: 'CC BY-SA 4.0',
    attribution: 'Everkinetic (http://everkinetic.com, https://github.com/everkinetic/data), CC BY-SA 4.0',
  }));
  return src;
}

// ---------------------------------------------------------------- openGym
function loadOpenGym() {
  return fs.readdirSync(OG_DIR).filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(OG_DIR, f), 'utf8')))
    .filter((e) => e.name) // skip {id, variantOf} stubs
    .map((e) => {
      const tokens = tokenize(e.name);
      const cls = OG_EQUIP[e.equipment] ?? e.equipment;
      return { ...e, tokens, cls, content: contentTokens(tokens, [cls]) };
    });
}

function bestMatch(og, items) {
  let best = null;
  for (const it of items) {
    const pen = compat(og.cls, it.classes);
    if (pen === null) continue;
    const raw = similarity(og.content, it.content);
    const score = Math.max(0, raw - pen);
    if (!best || score > best.score + 1e-9 || (Math.abs(score - best.score) < 1e-9 && it.content.length < best.item.content.length)) {
      best = { item: it, score, raw, pen };
    }
  }
  return best;
}

// ---------------------------------------------------------------- run
const SOURCES = ['workoutGuide', 'wger', 'everkinetic'];
const PRIORITY = { workoutGuide: 0.04, wger: 0, everkinetic: -0.01 }; // tie-break only

const src = await loadSources();
const og = loadOpenGym();
log(`openGym entries with a name: ${og.length}`);
for (const s of SOURCES) log(`source ${s}: ${src[s].length} exercises with media`);
log(`accept threshold: ${ACCEPT}`);

const per = {}; // ogId -> {source: best}
for (const e of og) {
  per[e.id] = {};
  for (const s of SOURCES) per[e.id][s] = bestMatch(e, src[s]);
}
function choose(id) {
  let pick = null;
  for (const s of SOURCES) {
    const m = per[id][s];
    if (!m || m.score < ACCEPT) continue;
    const key = m.score + PRIORITY[s];
    if (!pick || key > pick.key) pick = { s, m, key };
  }
  return pick;
}

const CATS = new Set(['strength', 'calisthenics', 'plyometrics', 'olympic', 'cardio', 'isometric']);
const subsets = {
  'A: textSource=exercisedb': og.filter((e) => e.textSource === 'exercisedb'),
  'B: full catalogue, categories strength/calisthenics/plyometrics/olympic/cardio/isometric': og.filter((e) => CATS.has(e.category)),
  'C: whole catalogue (all categories)': og,
};
const pct = (n, d) => `${n} (${((100 * n) / d).toFixed(1)}%)`;
for (const [label, list] of Object.entries(subsets)) {
  log(`\n=== ${label}: ${list.length} entries`);
  const ths = [1, 0.9, 0.8, ACCEPT, 0.65];
  log(['source'.padEnd(14), ...ths.map((t) => (t === 1 ? 'exact(1.0)' : `>=${t}`).padStart(14)), 'distinct src'.padStart(14)].join(''));
  for (const s of SOURCES) {
    const row = ths.map((t) => pct(list.filter((e) => per[e.id][s] && per[e.id][s].score >= t - 1e-9).length, list.length).padStart(14));
    const distinct = new Set(list.filter((e) => per[e.id][s]?.score >= ACCEPT).map((e) => per[e.id][s].item.id)).size;
    log([s.padEnd(14), ...row, String(distinct).padStart(14)].join(''));
  }
  const anyRow = ths.map((t) => pct(list.filter((e) => SOURCES.some((s) => per[e.id][s]?.score >= t - 1e-9)).length, list.length).padStart(14));
  log(['ANY source'.padEnd(14), ...anyRow].join(''));
  const openRow = ths.map((t) => pct(list.filter((e) => ['workoutGuide', 'wger', 'everkinetic'].some((s) => per[e.id][s]?.score >= t - 1e-9)).length, list.length).padStart(14));
  log(['CC-only (WG+wger+EK)'.padEnd(14), ...openRow]);
  const chosenBy = {};
  for (const e of list) { const p = choose(e.id); if (p) chosenBy[p.s] = (chosenBy[p.s] || 0) + 1; }
  log(`chosen source at >=${ACCEPT} (best score, tie-break WG>wger>EK): ${JSON.stringify(chosenBy)}`);
}

// ---------------------------------------------------------------- examples
const fmt = (e, s, m) => `${m.score.toFixed(2)}  [${s}] og ${e.id} "${e.name}" (${e.equipment})  <->  "${m.item.name}" (${m.item.classes.join('/')})`;
const exdb = subsets['A: textSource=exercisedb'];
function sample(list, lo, hi, n, seed) {
  const c = [];
  for (const e of list) for (const s of SOURCES) { const m = per[e.id][s]; if (m && m.score >= lo && m.score < hi) c.push([e, s, m]); }
  let x = seed; const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
  return c.sort(() => rnd() - 0.5).slice(0, n);
}
log('\n=== Example matches (exercisedb subset), random sample per score band');
for (const [lo, hi, n] of [[0.999, 1.01, 5], [0.85, 0.999, 6], [0.75, 0.85, 12], [0.65, 0.75, 6]]) {
  log(`-- score in [${lo}, ${hi})`);
  for (const [e, s, m] of sample(exdb, lo, hi, n, 42 + Math.round(lo * 100))) log('  ' + fmt(e, s, m));
}

// ---------------------------------------------------------------- common gym exercises
// [query, canonical openGym id (the exercisedb entry where one exists) or null = search by name, equipment class]
const COMMON = [
  ['barbell bench press', '0025', 'barbell'], ['incline dumbbell press', '0314', 'dumbbell'], ['dumbbell fly', '0308', 'dumbbell'],
  ['cable crossover', '0155', 'cable'], ['push-up', '0662', 'bodyweight'], ['barbell squat', '0043', 'barbell'],
  ['leg press', '0739', 'machine'], ['leg extension', '0585', 'machine'], ['lying leg curl', '0586', 'machine'],
  ['romanian deadlift', '0085', 'barbell'], ['deadlift', '0032', 'barbell'], ['barbell hip thrust', null, 'barbell'],
  ['calf raise', '0605', 'machine'], ['lat pulldown', '0198', 'cable'], ['pull-up', '0652', 'bodyweight'],
  ['seated cable row', '0861', 'cable'], ['bent over barbell row', '0027', 'barbell'], ['dumbbell shoulder press', '0405', 'dumbbell'],
  ['lateral raise', '0334', 'dumbbell'], ['rear delt fly', '2487', 'dumbbell'], ['barbell shrug', '0095', 'barbell'],
  ['barbell curl', '0031', 'barbell'], ['hammer curl', '0313', 'dumbbell'], ['preacher curl', '0070', 'barbell'],
  ['triceps pushdown', '0201', 'cable'], ['overhead triceps extension', '0194', 'cable'], ['skull crusher', '0060', 'barbell'],
  ['dips', '0251', 'bodyweight'], ['crunch', '0274', 'bodyweight'], ['front plank', null, 'bodyweight'],
  ['hanging leg raise', '0472', 'bodyweight'], ['wrist curl', '0126', 'barbell'], ['back extension', '0489', 'bodyweight'],
  ['run', '0685', 'bodyweight'], ['bulgarian split squat', '2290', 'dumbbell'], ['lunge', '0336', 'dumbbell'],
];
const ogById = Object.fromEntries(og.map((e) => [e.id, e]));
log('\n=== Common gym exercises: best openGym entry, then best media per source (score)');
const commonOut = [];
let covered = 0, coveredOpen = 0, coveredWG = 0;
for (const [name, fixedId, cls] of COMMON) {
  const t = tokenize(name);
  const q = { content: contentTokens(t, cls ? [cls] : []), cls };
  let bestOg = fixedId && ogById[fixedId] ? { e: ogById[fixedId], sc: similarity(q.content, ogById[fixedId].content) } : null;
  if (!bestOg) for (const e of og) {
    if (cls && compat(e.cls, [cls]) === null) continue;
    const sc = similarity(q.content, e.content) - (cls ? compat(e.cls, [cls]) : 0);
    const better = !bestOg || sc > bestOg.sc + 1e-9 ||
      (Math.abs(sc - bestOg.sc) < 1e-9 && ((e.textSource === 'exercisedb') > (bestOg.e.textSource === 'exercisedb') ||
        ((e.textSource === 'exercisedb') === (bestOg.e.textSource === 'exercisedb') && e.name.length < bestOg.e.name.length)));
    if (better) bestOg = { e, sc };
  }
  const e = bestOg.e;
  const cells = SOURCES.map((s) => { const m = per[e.id][s]; return m ? `${s}=${m.score.toFixed(2)} "${m.item.name}"` : `${s}=-`; });
  const p = choose(e.id);
  if (p) covered++;
  if (['workoutGuide', 'wger', 'everkinetic'].some((s) => per[e.id][s]?.score >= ACCEPT)) coveredOpen++;
  if (per[e.id].workoutGuide?.score >= ACCEPT) coveredWG++;
  log(`${p ? 'OK ' : '-- '} ${name.padEnd(28)} -> og ${e.id} "${e.name}" (${e.equipment}, q=${bestOg.sc.toFixed(2)})\n      ${cells.join(' | ')}`);
  commonOut.push({ query: name, openGymId: e.id, openGymName: e.name, chosen: p ? { source: p.s, sourceId: p.m.item.id, score: +p.m.score.toFixed(3) } : null });
}
log(`common list covered (any source >= ${ACCEPT}): ${covered}/${COMMON.length}; CC-licensed only: ${coveredOpen}/${COMMON.length}; Workout Guide alone: ${coveredWG}/${COMMON.length}`);

// ---------------------------------------------------------------- write outputs
const pack = (s, m) => ({
  source: s, sourceId: m.item.id, sourceName: m.item.name, score: +m.score.toFixed(3),
  imageUrls: m.item.imageUrls,
  ...(m.item.pngUrls ? { pngUrls: m.item.pngUrls } : {}),
  ...(m.item.svgUrls ? { svgUrls: m.item.svgUrls } : {}),
  ...(m.item.videoUrls?.length ? { videoUrls: m.item.videoUrls } : {}),
  ...(m.item.images ? { images: m.item.images } : {}),
  license: m.item.license, attribution: m.item.attribution,
});
const matches = {}, bySource = {};
for (const e of og) {
  const p = choose(e.id);
  if (p) matches[e.id] = { openGymName: e.name, openGymEquipment: e.equipment, category: e.category, textSource: e.textSource, ...pack(p.s, p.m) };
  const row = {};
  for (const s of SOURCES) { const m = per[e.id][s]; if (m && m.score >= 0.5) row[s] = pack(s, m); }
  if (Object.keys(row).length) bySource[e.id] = { openGymName: e.name, openGymEquipment: e.equipment, ...row };
}
fs.writeFileSync(path.join(OUT_DIR, 'matches.json'), JSON.stringify({ acceptThreshold: ACCEPT, generated: new Date().toISOString(), count: Object.keys(matches).length, matches }, null, 1));
fs.writeFileSync(path.join(OUT_DIR, 'matches-by-source.json'), JSON.stringify(bySource, null, 1));
fs.writeFileSync(path.join(OUT_DIR, 'common-exercises.json'), JSON.stringify(commonOut, null, 1));
log(`\nwrote ${Object.keys(matches).length} chosen matches -> ${path.join(OUT_DIR, 'matches.json')}`);
fs.writeFileSync(path.join(OUT_DIR, 'report.txt'), out.join('\n') + '\n');
