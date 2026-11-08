#!/usr/bin/env node
// build-catalog.mjs — builds the global exercise catalogue (the `data/exercises.json` format read by
// `bun run catalog:sync`) from the openGym catalogue text plus CC-licensed media matches.
//
// Usage:
//   node build-catalog.mjs <openGymPath> [--out=<dir>] [--refresh-candidates=<matches-by-source.json>]
//                          [--compound-legs-as-perna] [--all] [--verbose]
//
//   <openGymPath>   openGym repo root (or its `catalogue/` folder). Only `catalogue/exercises/*.json`
//                   and `catalogue/i18n/pt-BR.json` are read. `catalogue/media` is NEVER read: that media
//                   is licensed to openGym only.
//   --out           output folder (default: ./out next to this script)
//   --refresh-candidates
//                   rebuild the committed media-candidates.json snapshot from a matches-by-source.json
//                   produced by match-media.mjs, then build as usual.
//   --compound-legs-as-perna
//                   file squats/lunges/leg presses/deadlifts whose openGym target is "glutes" under PERNA
//                   instead of GLUTEO (off by default: bodyPart follows the target table below).
//   --all           ignore curated-list.json and output every openGym entry (plus the custom ones), with duplicate
//                   names suffixed "(variação N)": the pre-curation catalogue, for picking ids to add to the list.
//   --verbose       also print every legacy-map row with the new exercise name.
//
// Inputs kept next to this script (all committed):
//   curated-list.json       the openGym externalIds the shipped (lean) catalogue keeps, grouped by bodyPart, with their
//                           final names (checked), plus the ids existing workouts use (must stay in the list)
//   custom-exercises.json   exercises written for this project (externalId mt-NNNN, no media), appended as is
//   media-candidates.json   per exercise, the best Workout Guide / Everkinetic / wger match (score >= 0.75)
//   media-review.json       manual accept/reject decisions (required for every 0.75-0.85 candidate)
//   media-exclude.json      media URLs that failed to download permanently (skipped)
//   media-frame-exclude.json individual frames left out of a candidate (inconsistent style/framing; see README)
//   media-manual.json       hand-picked media for exercises the name matcher missed (same exercise, other name)
//   name-overrides.json     externalId -> pt-BR display name (wins over the automatic name rules)
//   legacy-exercise-map.csv old catalogue -> externalId (validated against the output)
//
// Outputs (in --out):
//   exercises.json          array sorted by name (see README.md for the shape)
//   media-manifest.json     [{path, url, license, attribution, transform, align}] — what src/media/fetch-media.ts
//                           (`bun run media:fetch`) downloads, colour-normalizes and crops per exercise folder; only
//                           the files the output exercises use
//   credits.json            [{source, license, url, attribution}] — for an in-app credits screen
//
// Every openGym record still goes through the same names, translations and media picks (and their checks); the
// curated list only selects which of them are written. Fails loudly (exit 1) on any value without a translation,
// an unreviewed 0.75-0.85 media candidate, an invalid media path, a bad curated-list.json / custom-exercises.json
// entry (unknown id, wrong group, stale name, missing required id, value outside the dictionaries), a duplicate
// display name in the curated output, or a legacy-map row pointing at an externalId that is not in the output.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const flags = Object.fromEntries(
  args.filter((a) => a.startsWith('--')).map((a) => {
    const [k, ...v] = a.replace(/^--/, '').split('=');
    return [k, v.length ? v.join('=') : true];
  }),
);
if (positional.length < 1) {
  console.error('usage: node build-catalog.mjs <openGymPath> [--out=<dir>] [--refresh-candidates=<matches-by-source.json>]');
  process.exit(1);
}

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const writeJson = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n');
const fail = (msg) => {
  console.error(`\nERROR: ${msg}`);
  process.exit(1);
};

// ---------------------------------------------------------------- locate inputs
const ogRoot = path.resolve(positional[0]);
const CATALOGUE = fs.existsSync(path.join(ogRoot, 'catalogue', 'exercises'))
  ? path.join(ogRoot, 'catalogue')
  : fs.existsSync(path.join(ogRoot, 'exercises'))
    ? ogRoot
    : fail(`openGym catalogue not found under ${ogRoot}`);
const OUT = path.resolve(typeof flags.out === 'string' ? flags.out : path.join(HERE, 'out'));
fs.mkdirSync(OUT, { recursive: true });

const FILES = {
  candidates: path.join(HERE, 'media-candidates.json'),
  review: path.join(HERE, 'media-review.json'),
  exclude: path.join(HERE, 'media-exclude.json'),
  frameExclude: path.join(HERE, 'media-frame-exclude.json'),
  manual: path.join(HERE, 'media-manual.json'),
  overrides: path.join(HERE, 'name-overrides.json'),
  legacy: path.join(HERE, 'legacy-exercise-map.csv'),
  curated: path.join(HERE, 'curated-list.json'),
  custom: path.join(HERE, 'custom-exercises.json'),
};
const ALL = !!flags.all;

// ---------------------------------------------------------------- openGym text
const records = fs
  .readdirSync(path.join(CATALOGUE, 'exercises'))
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => readJson(path.join(CATALOGUE, 'exercises', f)))
  .filter((r) => r.textSource === 'exercisedb' && r.name); // skips {id, variantOf} stubs and openGym-written entries
const ptBR = readJson(path.join(CATALOGUE, 'i18n', 'pt-BR.json'));
console.log(`openGym exercisedb records: ${records.length}`);
if (records.length !== 1324) console.warn(`WARNING: expected 1324 exercisedb records, found ${records.length}`);

// ---------------------------------------------------------------- dictionaries
// bodyPart is derived from the primary muscle (target); openGym's own bodyPart "cardio" wins.
const BODY_PART_BY_TARGET = {
  pectorals: 'PEITO',
  triceps: 'TRICEPS',
  lats: 'COSTAS',
  'upper back': 'COSTAS',
  traps: 'OMBRO',
  'levator scapulae': 'OMBRO',
  biceps: 'BICEPS',
  delts: 'OMBRO',
  quads: 'PERNA',
  hamstrings: 'PERNA',
  calves: 'PERNA',
  adductors: 'PERNA',
  abductors: 'GLUTEO',
  glutes: 'GLUTEO',
  forearms: 'ANTEBRACO',
  abs: 'ABDOMEN',
  'serratus anterior': 'ABDOMEN',
  spine: 'LOMBAR',
  'cardiovascular system': 'CARDIO',
};
const BODY_PARTS = ['PEITO', 'TRICEPS', 'COSTAS', 'BICEPS', 'OMBRO', 'PERNA', 'ANTEBRACO', 'ABDOMEN', 'GLUTEO', 'LOMBAR', 'CARDIO'];
// openGym targets most squats, lunges, leg presses and deadlifts at "glutes", so by the table above they land
// in GLUTEO. Opt-in: --compound-legs-as-perna moves those (by English name) to PERNA, as Brazilian gyms file them.
const COMPOUND_LEGS = /\b(squats?|leg press|lunges?|step-?ups?|split|hack|deadlifts?|good morning|pistol)\b/i;

const EQUIPMENT = {
  'body weight': 'Peso corporal',
  dumbbell: 'Halteres',
  cable: 'Polia',
  barbell: 'Barra',
  'leverage machine': 'Máquina',
  band: 'Elástico',
  'resistance band': 'Elástico',
  'smith machine': 'Smith',
  kettlebell: 'Kettlebell',
  weighted: 'Peso adicional',
  'stability ball': 'Bola suíça',
  'ez barbell': 'Barra W',
  assisted: 'Assistido',
  'sled machine': 'Máquina com anilhas',
  'medicine ball': 'Bola medicinal',
  rope: 'Corda',
  roller: 'Rolo de espuma',
  'bosu ball': 'BOSU',
  'olympic barbell': 'Barra olímpica',
  'wheel roller': 'Roda abdominal',
  'trap bar': 'Barra hexagonal',
  hammer: 'Marreta',
  'stationary bike': 'Bicicleta ergométrica',
  'upper body ergometer': 'Ergômetro de braço',
  'elliptical machine': 'Elíptico',
  'skierg machine': 'Ergômetro de esqui',
  'stepmill machine': 'Escada ergométrica',
  tire: 'Pneu',
  // not in openGym; values used by custom-exercises.json
  'rowing machine': 'Remo ergométrico',
  'ankle weight': 'Caneleira',
};

const TARGET = {
  abs: 'Abdômen',
  pectorals: 'Peitoral',
  biceps: 'Bíceps',
  glutes: 'Glúteos',
  delts: 'Deltoides',
  triceps: 'Tríceps',
  'upper back': 'Parte superior das costas',
  lats: 'Dorsais',
  calves: 'Panturrilhas',
  quads: 'Quadríceps',
  forearms: 'Antebraços',
  'cardiovascular system': 'Sistema cardiovascular',
  hamstrings: 'Posteriores de coxa',
  spine: 'Lombar',
  traps: 'Trapézio',
  adductors: 'Adutores',
  'serratus anterior': 'Serrátil anterior',
  abductors: 'Abdutores',
  'levator scapulae': 'Elevador da escápula',
};

const SECONDARY = {
  shoulders: 'Ombros',
  hamstrings: 'Posteriores de coxa',
  forearms: 'Antebraços',
  triceps: 'Tríceps',
  biceps: 'Bíceps',
  quadriceps: 'Quadríceps',
  calves: 'Panturrilhas',
  glutes: 'Glúteos',
  core: 'Core',
  chest: 'Peitoral',
  'hip flexors': 'Flexores do quadril',
  obliques: 'Oblíquos',
  'lower back': 'Lombar',
  rhomboids: 'Romboides',
  trapezius: 'Trapézio',
  'upper back': 'Parte superior das costas',
  traps: 'Trapézio',
  deltoids: 'Deltoides',
  'rear deltoids': 'Deltoide posterior',
  brachialis: 'Braquial',
  back: 'Costas',
  ankles: 'Tornozelos',
  feet: 'Pés',
  'rotator cuff': 'Manguito rotador',
  'latissimus dorsi': 'Dorsais',
  lats: 'Dorsais',
  soleus: 'Sóleo',
  'ankle stabilizers': 'Estabilizadores do tornozelo',
  wrists: 'Punhos',
  'upper chest': 'Peitoral superior',
  'wrist extensors': 'Extensores do punho',
  'wrist flexors': 'Flexores do punho',
  sternocleidomastoid: 'Esternocleidomastoideo',
  hands: 'Mãos',
  abdominals: 'Abdômen',
  'grip muscles': 'Músculos da pegada',
  'lower abs': 'Abdômen inferior',
  'inner thighs': 'Parte interna das coxas',
  shins: 'Tibial anterior',
  groin: 'Virilha',
};

const CATEGORY = {
  strength: 'Força',
  calisthenics: 'Calistenia',
  stretching: 'Alongamento',
  plyometrics: 'Pliometria',
  mobility: 'Mobilidade',
  cardio: 'Cardio',
  isometric: 'Isometria',
  olympic: 'Levantamento olímpico',
  yoga: 'Yoga',
  rehab: 'Reabilitação',
  combat: 'Luta',
};

const missing = new Map(); // "field: value" -> example id
function tr(dict, value, field, id) {
  const key = String(value ?? '').trim().toLowerCase();
  if (Object.hasOwn(dict, key)) return dict[key];
  missing.set(`${field}: "${value}"`, id);
  return null;
}

// ---------------------------------------------------------------- pt-BR names
// The openGym pt-BR names are LLM translations, mostly fine but with a few systematic habits that read
// oddly in a Brazilian gym ("no cabo" for cable, "faixa elástica", "máquina Smith", "(máquina)").
// These rules run on the lowercased name; name-overrides.json then fixes individual names.
const NAME_RULES = [
  // the ExerciseDB figure gender is not a different exercise for us (nameEn keeps it)
  [/\s*\((masculino|feminino)\)/g, ''],
  [/\s+(masculino|feminino)$/, ''],
  [/\bv\.\s*(\d+)/g, '(variação $1)'],
  [/\bna máquina smith\b/g, 'no smith'],
  [/\bmáquina smith\b/g, 'smith'],
  [/\bno cabo\b/g, 'na polia'],
  [/\btríceps pulley (.*?)\s*na polia\b/g, 'tríceps pulley $1'], // "pulley" already says cable
  [/\bfaixa elástica\b/g, 'elástico'],
  [/\bcrucifixo invertido\b/g, 'crucifixo inverso'],
  [/\bbom dia\b/g, 'good morning'],
  [/\bpress militar\b/g, 'desenvolvimento militar'],
  [/\b(torção russa|giro russo)\b/g, 'russian twist'],
  [/\b(elevação de )?panturrilha burro\b/g, 'panturrilha burrinho'],
  [/\bbarra (ez|sz)\b/g, 'barra w'],
  [/\b45 graus\b/g, '45°'],
  [/\s*\(sled\)/g, ''],
  [/^(leg press.*?) no sled\b/, '$1'],
  [/\bno sled\b/g, 'na máquina'],
  [/^hack squat\b/, 'agachamento hack'],
  [/^kickback de tríceps\b/, 'tríceps coice', (r) => r.target === 'triceps'],
  [/^kickback\b/, 'tríceps coice', (r) => r.target === 'triceps'],
  [/^((?:cadeira|mesa|leg press)\b.*?) \(máquina\)$/, '$1'],
  [/ \(máquina\)/g, ' na máquina'],
  [/\bextensão de tríceps (.*?)acima da cabeça ?/g, 'tríceps francês $1'],
  [/\bbraços retos\b/g, 'braços estendidos'],
  [/(?<!com )\bpeso corporal\b/g, 'com peso corporal'],
  [/\blevantamento terra pernas\b/g, 'levantamento terra com pernas'],
  [/(?<!com )\bpernas semiestendidas\b/g, 'com pernas semiestendidas'],
  // a v-bar on rows/pulldowns is the "triângulo" handle (on pushdowns it stays "barra V")
  [/\(barra v\)/g, '(triângulo)', (r, s) => /\b(remada|puxada)\b/.test(s)],
  [/\bbarra v\b/g, 'triângulo', (r, s) => /\b(remada|puxada)\b/.test(s)],
  [/\bbola de (exercício|estabilidade)\b/g, 'bola suíça'],
  [/\bna bosu\b/g, 'no bosu'],
  [/\bpegada paralela\b/g, 'pegada neutra'],
];

// Words that keep a capital (or are acronyms) inside a sentence-case name.
const KEEP_CASE = {
  smith: 'Smith', scott: 'Scott', zercher: 'Zercher', jefferson: 'Jefferson', pendlay: 'Pendlay',
  bradford: 'Bradford', arnold: 'Arnold', pallof: 'Pallof', zottman: 'Zottman', thibaudeau: 'Thibaudeau',
  gironda: 'Gironda', janda: 'Janda', svend: 'Svend', tate: 'Tate', otis: 'Otis', frankenstein: 'Frankenstein',
  londres: 'Londres', jm: 'JM', ez: 'EZ', trx: 'TRX', bosu: 'BOSU',
  v: 'V', y: 'Y', t: 'T', w: 'W', l: 'L',
};

function autoName(rec) {
  const raw = ptBR[rec.id]?.name || rec.name;
  let s = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  for (const [re, rep, cond] of NAME_RULES) {
    if (cond && !cond(rec, s)) continue;
    s = s.replace(re, rep);
  }
  s = s.replace(/\s+/g, ' ').replace(/\s+([,)])/g, '$1').replace(/\(\s+/g, '(').trim();
  s = s.replace(/[\p{L}\p{N}]+/gu, (w) => KEEP_CASE[w] ?? w);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------------------------------------------------------------- media
const SOURCES = ['workoutGuide', 'everkinetic', 'wger'];
const SOURCE_DIR = { workoutGuide: 'workout-guide', everkinetic: 'everkinetic', wger: 'wger' };
// score decides; this only breaks near-ties (Workout Guide: 3 consistent frames; Everkinetic: same line art, CC BY-SA 4.0)
const PRIORITY = { workoutGuide: 0.04, everkinetic: 0.01, wger: 0 };
const AUTO_ACCEPT = 0.85;
const REVIEW_MIN = 0.75;
const WGER_MAX_FRAMES = 4;
// wger images are user uploads whose declared CC license cannot be verified. A visual check of the matched
// ones found re-uploaded commercial stock renders (one with a "TRAINING" watermark), unflagged AI art and
// stock-style photos, so only images credited to Everkinetic (its CC BY-SA line art, re-hosted by wger) are used.
const WGER_TRUSTED_AUTHORS = new Set(['Everkinetic']);
// Colour normalization done by src/media/fetch-media.ts after the download, so every frame is white strokes on a
// transparent background (the app can tint all of them the same way):
//   to-white       already white on transparent (Workout Guide; some strokes are 254, not 255) -> RGB = 255, alpha kept
//   luma-to-alpha  opaque black line art on white (Everkinetic, and the Everkinetic images re-hosted by wger)
//                  -> alpha = (255 - luma) * alpha / 255, RGB = 255
// CC BY-SA requires indicating changes: the attributions below say "cores adaptadas" / "colours adapted".
const TRANSFORM = { workoutGuide: 'to-white', everkinetic: 'luma-to-alpha', wger: 'luma-to-alpha' };
// How fetch-media lines up the frames of one exercise folder before cropping them all to the union box:
//   canvas    the frames already share one canvas (Workout Guide: 512x512, figure drawn in place)
//   register  each frame is cropped tight to its own drawing upstream, so sizes differ (Everkinetic) -> every frame
//             is translated onto the first by the shift that best overlaps the strokes
const ALIGN = { workoutGuide: 'canvas', everkinetic: 'register', wger: 'register' };
// Version of the processing done by src/media/fetch-media.ts (colour transform + align/crop/pad/downscale), part of
// every media path (frame-<n>.v2.png). The API serves media with an immutable cache and fetch-media skips files already
// on disk, so processed bytes must never reuse a path: bump this whenever src/media/normalize.ts or frames.ts change
// their output. (v1 was frame-<n>-white.png: colour transform only, upstream canvas.)
const MEDIA_VERSION = 'v2';
// PNG only: the normalization decodes PNG and nothing else.
const RASTER = /\.png$/i;

if (typeof flags['refresh-candidates'] === 'string') refreshCandidates(path.resolve(flags['refresh-candidates']));

/** Rebuilds media-candidates.json from match-media.mjs' matches-by-source.json (CC sources only, score >= 0.75). */
function refreshCandidates(matchesPath) {
  const bySource = readJson(matchesPath);
  const ids = new Set(records.map((r) => r.id));
  const out = {};
  for (const id of [...ids].sort()) {
    const row = bySource[id];
    if (!row) continue;
    const list = [];
    for (const s of SOURCES) {
      const c = row[s];
      if (!c || c.score < REVIEW_MIN) continue;
      let frames;
      let adaptedFrom = null;
      if (s === 'workoutGuide') {
        frames = (c.pngUrls ?? []).map((url) => ({ url, license: 'CC BY-SA 4.0', author: 'Bryl Lim' }));
        adaptedFrom = /first frame adapted from Everkinetic \(([^)]+)\)/.exec(c.attribution ?? '')?.[1] ?? null;
      } else if (s === 'everkinetic') {
        frames = c.imageUrls.map((url) => ({ url, license: 'CC BY-SA 4.0', author: 'Everkinetic' }));
      } else {
        frames = c.images.map((i) => ({ url: i.url, license: i.license, author: i.author || null, ai: !!i.ai, style: i.style ?? null }));
      }
      list.push({ source: s, sourceId: String(c.sourceId), sourceName: c.sourceName, score: c.score, frames, ...(adaptedFrom ? { adaptedFrom } : {}) });
    }
    if (list.length) out[id] = list;
  }
  writeJson(FILES.candidates, {
    note: 'Generated by build-catalog.mjs --refresh-candidates from match-media.mjs output. CC-licensed sources only (Workout Guide, Everkinetic, wger); score >= 0.75; openGym exercisedb entries only.',
    generated: new Date().toISOString(),
    candidates: out,
  });
  console.log(`refreshed ${FILES.candidates}: ${Object.keys(out).length} exercises with candidates`);
}

const candidates = readJson(FILES.candidates).candidates;
const reviewList = fs.existsSync(FILES.review) ? readJson(FILES.review) : [];
const review = new Map(reviewList.map((r) => [`${r.externalId}|${r.source}|${r.sourceId}`, r]));
const manualList = fs.existsSync(FILES.manual) ? readJson(FILES.manual) : [];
const manual = new Map();
for (const m of manualList) {
  if (!records.some((r) => r.id === m.externalId)) fail(`media-manual.json: unknown externalId ${m.externalId}`);
  if (!SOURCES.includes(m.source) || !m.frames?.length) fail(`media-manual.json: bad entry for ${m.externalId}`);
  if (manual.has(m.externalId)) fail(`media-manual.json: duplicate externalId ${m.externalId}`);
  manual.set(m.externalId, { ...m, score: 1, manual: true });
}
const excluded = new Set((fs.existsSync(FILES.exclude) ? readJson(FILES.exclude) : []).map((e) => (typeof e === 'string' ? e : e.url)));

// Frames left out of a candidate: { reasons: {code: text}, frames: {"<source>/<sourceId>": {"<n>": "<code>"}} }, n = the
// 1-based upstream frame number. Decided by a visual review of contact sheets, triaged by stroke metrics (README).
const frameExcludeFile = fs.existsSync(FILES.frameExclude) ? readJson(FILES.frameExclude) : { reasons: {}, frames: {} };
const frameExclude = new Map(); // "<source>/<sourceId>" -> Map(n -> reason)
for (const [key, byFrame] of Object.entries(frameExcludeFile.frames ?? {})) {
  const [source, ...rest] = key.split('/');
  if (!SOURCES.includes(source) || !rest.length) fail(`media-frame-exclude.json: bad key "${key}" (expected <source>/<sourceId>)`);
  const m = new Map();
  for (const [n, reason] of Object.entries(byFrame)) {
    if (!/^[1-9]\d*$/.test(n)) fail(`media-frame-exclude.json: bad frame number "${n}" in "${key}"`);
    if (!Object.hasOwn(frameExcludeFile.reasons ?? {}, reason)) fail(`media-frame-exclude.json: unknown reason "${reason}" in "${key}"`);
    m.set(Number(n), reason);
  }
  frameExclude.set(key, m);
}
const frameExcludeUsed = new Set();

/**
 * Frames actually used from a candidate, each with `n` = its 1-based upstream number: raster only, minus the frames in
 * media-frame-exclude.json; for wger, non-AI images by a trusted author, same author/style as the first.
 */
function usableFrames(c) {
  const key = `${c.source}/${c.sourceId}`;
  const skip = frameExclude.get(key);
  if (skip) {
    frameExcludeUsed.add(key);
    for (const n of skip.keys()) if (n > c.frames.length) fail(`media-frame-exclude.json: "${key}" has no frame ${n} (${c.frames.length} frames)`);
  }
  let frames = c.frames
    .map((f, i) => ({ ...f, n: i + 1 }))
    .filter((f) => RASTER.test(new URL(f.url).pathname) && !skip?.has(f.n));
  if (c.source === 'wger') {
    frames = frames.filter((f) => !f.ai && WGER_TRUSTED_AUTHORS.has(f.author));
    if (frames.length) {
      const main = frames[0];
      frames = frames.filter((f) => f.author === main.author && f.style === main.style).slice(0, WGER_MAX_FRAMES);
    }
  }
  return frames;
}

const safeSegment = (s) => s.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+/, '').replace(/-+$/, '') || 'x';

/** `sources/<source>/<id>/frame-<n>.<version>.png`, n = upstream frame number (gaps where frames are excluded). */
function mediaPath(c, n, url) {
  const ext = path.extname(new URL(url).pathname).toLowerCase();
  return `sources/${SOURCE_DIR[c.source]}/${safeSegment(c.sourceId)}/frame-${n}.${MEDIA_VERSION}${ext}`;
}

const unreviewed = [];
/**
 * Best accepted candidate for one exercise, or null. `info` (per exercise, summed over the output exercises in the
 * report) gets the kind of pick and the accepted candidates skipped.
 */
function pickMedia(rec, info) {
  const list = (candidates[rec.id] ?? []).filter((c) => SOURCES.includes(c.source));
  if (manual.has(rec.id)) list.unshift(manual.get(rec.id));
  const ok = [];
  for (const c of list) {
    const decision = review.get(`${rec.id}|${c.source}|${c.sourceId}`);
    let accepted;
    if (c.manual) accepted = true;
    else if (decision) accepted = decision.decision === 'accept';
    else if (c.score >= AUTO_ACCEPT) accepted = true;
    else if (c.score >= REVIEW_MIN) {
      unreviewed.push(`${rec.id} "${rec.name}" -> ${c.source} ${c.sourceId} "${c.sourceName}" (${c.score})`);
      accepted = false;
    } else accepted = false;
    if (!accepted) continue;
    const frames = usableFrames(c);
    if (!frames.length) {
      info.skippedNoUsableFrames++;
      continue;
    }
    if (frames.some((f) => excluded.has(f.url))) {
      info.skippedExcludedUrl++;
      continue;
    }
    ok.push({ c, frames, decision });
  }
  const key = (x) => (x.c.manual ? 10 : 0) + x.c.score + PRIORITY[x.c.source]; // a manual pick wins
  ok.sort((a, b) => key(b) - key(a));
  const best = ok[0];
  if (!best) return null;
  info.kind = best.c.manual ? 'pickedManual' : best.decision ? 'pickedReviewed' : 'pickedAutoAccepted';
  return best;
}

const manifest = new Map(); // path -> entry
const CHANGE_NOTE_EN = {
  'to-white': 'colours adapted: strokes normalized to pure white',
  'luma-to-alpha': 'colours adapted: black strokes on white converted to white strokes on a transparent background',
};
function manifestAttribution(c, f) {
  const change = CHANGE_NOTE_EN[TRANSFORM[c.source]];
  let credit;
  if (c.source === 'workoutGuide') {
    credit =
      'Bryl Lim, Workout Guide (https://github.com/bryllim/workout-guide)' +
      (f.n === 1 && c.adaptedFrom ? `; adapted from Everkinetic (${c.adaptedFrom}), CC BY-SA 4.0: rasterized, recolored and vector-traced` : '');
  } else if (c.source === 'everkinetic') {
    credit = 'Everkinetic (http://everkinetic.com, https://github.com/everkinetic/data)';
  } else {
    credit = `${f.author ?? 'wger.de contributors'}, via wger.de (https://wger.de)`;
  }
  return change ? `${credit}; ${change}` : credit;
}
function exerciseAttribution(c, frames) {
  const changed = TRANSFORM[c.source] ? ' (cores adaptadas)' : '';
  if (c.source === 'workoutGuide') {
    return c.adaptedFrom
      ? `Ilustração: Bryl Lim (Workout Guide), adaptada de Everkinetic — CC BY-SA 4.0${changed}`
      : `Ilustração: Bryl Lim (Workout Guide) — CC BY-SA 4.0${changed}`;
  }
  if (c.source === 'everkinetic') return `Ilustração: Everkinetic — CC BY-SA 4.0${changed}`;
  const authors = [...new Set(frames.map((f) => f.author ?? 'colaboradores do wger.de'))].join(', ');
  const licenses = [...new Set(frames.map((f) => f.license))].join(' / ');
  return `Imagem: ${authors} via wger.de — ${licenses}${changed}`;
}

// ---------------------------------------------------------------- build
const overrides = Object.fromEntries(
  Object.entries(fs.existsSync(FILES.overrides) ? readJson(FILES.overrides) : {}).filter(([k]) => /^\d+$/.test(k)),
);
for (const id of Object.keys(overrides)) if (!records.some((r) => r.id === id)) fail(`name-overrides.json: unknown externalId ${id}`);

const mediaInfo = new Map(); // externalId -> { source, kind, skipped..., excludedFrames }, summed over the output in the report
const exercises = records.map((rec) => {
  const target = String(rec.target).toLowerCase();
  let bodyPart = String(rec.bodyPart).toLowerCase() === 'cardio' ? 'CARDIO' : BODY_PART_BY_TARGET[target];
  if (flags['compound-legs-as-perna'] && target === 'glutes' && COMPOUND_LEGS.test(rec.name)) bodyPart = 'PERNA';
  if (!bodyPart) missing.set(`bodyPart for target: "${rec.target}"`, rec.id);
  const pt = ptBR[rec.id] ?? {};
  const instructions = (pt.instructions?.length ? pt.instructions : rec.instructions ?? []).map((s) => String(s).trim()).filter(Boolean);

  const info = { source: null, kind: null, skippedNoUsableFrames: 0, skippedExcludedUrl: 0, excludedFrames: [] };
  mediaInfo.set(rec.id, info);
  const media = pickMedia(rec, info);
  let images = [];
  let mediaAttribution = null;
  if (media) {
    const { c, frames } = media;
    images = frames.map((f) => {
      const p = mediaPath(c, f.n, f.url);
      const prev = manifest.get(p);
      if (prev && prev.url !== f.url) fail(`media path collision: ${p} <- ${prev.url} and ${f.url}`);
      manifest.set(p, {
        path: p,
        url: f.url,
        license: f.license,
        attribution: manifestAttribution(c, f),
        transform: TRANSFORM[c.source] ?? null,
        align: ALIGN[c.source],
      });
      return p;
    });
    info.excludedFrames = [...(frameExclude.get(`${c.source}/${c.sourceId}`) ?? new Map()).values()];
    mediaAttribution = exerciseAttribution(c, frames);
    info.source = c.source;
  }

  return {
    externalId: rec.id,
    name: overrides[rec.id] ?? autoName(rec),
    nameEn: rec.name,
    bodyPart,
    equipment: tr(EQUIPMENT, rec.equipment, 'equipment', rec.id),
    target: tr(TARGET, rec.target, 'target', rec.id),
    secondaryMuscles: [...new Set((rec.secondaryMuscles ?? []).map((m) => tr(SECONDARY, m, 'secondaryMuscles', rec.id)))].filter(Boolean),
    category: tr(CATEGORY, rec.category, 'category', rec.id),
    instructions,
    images,
    video: null,
    mediaAttribution,
  };
});

if (missing.size) fail(`values without a translation (add them to the dictionaries in build-catalog.mjs):\n  ${[...missing].map(([k, id]) => `${k} (e.g. ${id})`).join('\n  ')}`);
if (unreviewed.length) fail(`${unreviewed.length} media candidates in the ${REVIEW_MIN}-${AUTO_ACCEPT} band have no decision in media-review.json:\n  ${unreviewed.join('\n  ')}`);
for (const e of exercises) if (!BODY_PARTS.includes(e.bodyPart)) fail(`invalid bodyPart ${e.bodyPart} for ${e.externalId}`);

// ---------------------------------------------------------------- curation
// The shipped catalogue is a curated (lean) subset: curated-list.json names the openGym ids to keep and
// custom-exercises.json adds exercises written for this project. Everything above ran over every openGym record, so a
// kept exercise is exactly what the full build produces for its id. --all skips the list (pre-curation catalogue).
const builtById = new Map(exercises.map((e) => [e.externalId, e]));
const curatedFile = readJson(FILES.curated);
const curatedNames = new Map(); // externalId -> the name curated-list.json shows for it
for (const [bp, rows] of Object.entries(curatedFile.groups ?? {})) {
  if (!BODY_PARTS.includes(bp)) fail(`curated-list.json: unknown group "${bp}"`);
  for (const row of rows) {
    const e = builtById.get(row.externalId);
    if (!e) fail(`curated-list.json: ${row.externalId} is not an openGym exercisedb externalId`);
    if (curatedNames.has(row.externalId)) fail(`curated-list.json: ${row.externalId} is listed twice`);
    if (e.bodyPart !== bp) fail(`curated-list.json: ${row.externalId} "${e.name}" is listed under ${bp}, but the build files it under ${e.bodyPart}`);
    curatedNames.set(row.externalId, row.name);
  }
}
if (!curatedNames.size) fail('curated-list.json: empty list');
for (const id of curatedFile.requiredIds ?? []) {
  if (!curatedNames.has(id)) fail(`curated-list.json: ${id} is used by existing workouts (requiredIds) but is not in the list`);
}

// custom exercises: already in the output shape and in pt-BR; the vocabulary must be the dictionaries' values
const CUSTOM_ID = /^mt-\d{4}$/;
const CUSTOM_KEYS = ['externalId', 'name', 'nameEn', 'bodyPart', 'equipment', 'target', 'secondaryMuscles', 'category', 'instructions', 'images', 'video', 'mediaAttribution'];
const values = (dict) => new Set(Object.values(dict));
const customExercises = (readJson(FILES.custom).exercises ?? []).map((c) => {
  const where = `custom-exercises.json ${c.externalId ?? '(no externalId)'}`;
  for (const k of Object.keys(c)) if (!CUSTOM_KEYS.includes(k)) fail(`${where}: unknown field "${k}"`);
  if (!CUSTOM_ID.test(c.externalId ?? '')) fail(`${where}: externalId must look like mt-0001 (never an openGym id)`);
  if (typeof c.name !== 'string' || !c.name.trim()) fail(`${where}: missing name`);
  if (!BODY_PARTS.includes(c.bodyPart)) fail(`${where}: invalid bodyPart "${c.bodyPart}"`);
  if (!values(EQUIPMENT).has(c.equipment)) fail(`${where}: equipment "${c.equipment}" is not a value of the EQUIPMENT dictionary`);
  if (!values(TARGET).has(c.target)) fail(`${where}: target "${c.target}" is not a value of the TARGET dictionary`);
  for (const m of c.secondaryMuscles ?? []) if (!values(SECONDARY).has(m)) fail(`${where}: secondary muscle "${m}" is not a value of the SECONDARY dictionary`);
  if (!values(CATEGORY).has(c.category)) fail(`${where}: category "${c.category}" is not a value of the CATEGORY dictionary`);
  if (!Array.isArray(c.instructions) || !c.instructions.length || c.instructions.some((s) => typeof s !== 'string' || !s.trim())) {
    fail(`${where}: instructions must be a non-empty list of steps`);
  }
  if (c.images?.length || c.video || c.mediaAttribution) fail(`${where}: custom exercises have no media (the manifest only covers openGym picks)`);
  return {
    externalId: c.externalId,
    name: c.name.trim(),
    nameEn: c.nameEn?.trim() || null,
    bodyPart: c.bodyPart,
    equipment: c.equipment,
    target: c.target,
    secondaryMuscles: [...new Set(c.secondaryMuscles ?? [])],
    category: c.category,
    instructions: c.instructions.map((s) => s.trim()),
    images: [],
    video: null,
    mediaAttribution: null,
  };
});
if (new Set(customExercises.map((c) => c.externalId)).size !== customExercises.length) fail('custom-exercises.json: duplicate externalId');

const catalogue = [...(ALL ? exercises : exercises.filter((e) => curatedNames.has(e.externalId))), ...customExercises];

if (ALL) {
  // duplicate display names: the lowest externalId keeps the name, the others get "(variação N)"
  const taken = new Map();
  for (const e of [...catalogue].sort((a, b) => a.externalId.localeCompare(b.externalId))) {
    let name = e.name;
    for (let n = 2; taken.has(name.toLocaleLowerCase('pt-BR')); n++) name = `${e.name} (variação ${n})`;
    if (name !== e.name) console.log(`  dedupe: ${e.externalId} "${e.name}" -> "${name}"`);
    e.name = name;
    taken.set(name.toLocaleLowerCase('pt-BR'), e.externalId);
  }
} else {
  // the curated list is small enough to name every exercise uniquely by hand: a duplicate is an error, not "(variação N)"
  const taken = new Map();
  for (const e of catalogue) {
    const key = e.name.toLocaleLowerCase('pt-BR');
    if (taken.has(key)) fail(`duplicate display name "${e.name}": ${taken.get(key)} and ${e.externalId} (fix it in name-overrides.json or custom-exercises.json)`);
    taken.set(key, e.externalId);
  }
  const stale = catalogue
    .filter((e) => curatedNames.has(e.externalId) && curatedNames.get(e.externalId) !== e.name)
    .map((e) => `${e.externalId}: list says "${curatedNames.get(e.externalId)}", build says "${e.name}"`);
  if (stale.length) fail(`curated-list.json names out of date (rename in name-overrides.json, then update the list):\n  ${stale.join('\n  ')}`);
}

// media paths must satisfy the API's isValidMediaPath (safe segments, allowed extension, <= 512 chars)
const SAFE_SEGMENT = (s) => s.length > 0 && !s.startsWith('.') && !/[\\/:\u0000-\u001f\u007f]/.test(s);
for (const [p, m] of manifest) {
  if (p.length > 512 || !p.split('/').every(SAFE_SEGMENT) || !/\.(jpg|jpeg|png|webp|gif)$/.test(p)) fail(`invalid media path ${p}`);
  if (m.transform && !p.endsWith('.png')) fail(`colour transform on a non-PNG file ${p}`);
}
// fetch-media processes a folder as one group (union crop), so all files of a folder must agree on transform/align
const folderMode = new Map();
for (const [p, m] of manifest) {
  const dir = p.slice(0, p.lastIndexOf('/'));
  const mode = `${m.transform}|${m.align}`;
  if ((folderMode.get(dir) ?? mode) !== mode) fail(`media folder ${dir} mixes transform/align values`);
  folderMode.set(dir, mode);
}
const unusedFrameExcludes = [...frameExclude.keys()].filter((k) => !frameExcludeUsed.has(k));
if (unusedFrameExcludes.length) console.warn(`WARNING: media-frame-exclude.json entries for candidates no exercise considers: ${unusedFrameExcludes.join(', ')}`);
for (const e of catalogue) if (e.name.length > 255) fail(`name too long for ${e.externalId}`);

catalogue.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR') || a.externalId.localeCompare(b.externalId));
// only the files the output exercises use (the manifest above covers every openGym pick)
const usedPaths = new Set(catalogue.flatMap((e) => e.images));
for (const p of usedPaths) if (!manifest.has(p)) fail(`media path ${p} has no manifest entry`);
const manifestList = [...manifest.values()].filter((m) => usedPaths.has(m.path)).sort((a, b) => a.path.localeCompare(b.path));
const manifestFolders = new Set(manifestList.map((m) => m.path.slice(0, m.path.lastIndexOf('/'))));

// media stats over the output exercises
const mediaBySource = { workoutGuide: 0, everkinetic: 0, wger: 0 };
const pickStats = { pickedManual: 0, pickedAutoAccepted: 0, pickedReviewed: 0, skippedNoUsableFrames: 0, skippedExcludedUrl: 0 };
const frameStats = { excludedFrames: 0, byReason: {} };
for (const e of catalogue) {
  const info = mediaInfo.get(e.externalId);
  if (!info) continue; // custom exercise
  pickStats.skippedNoUsableFrames += info.skippedNoUsableFrames;
  pickStats.skippedExcludedUrl += info.skippedExcludedUrl;
  if (!info.source) continue;
  mediaBySource[info.source]++;
  pickStats[info.kind]++;
  for (const reason of info.excludedFrames) {
    frameStats.excludedFrames++;
    frameStats.byReason[reason] = (frameStats.byReason[reason] ?? 0) + 1;
  }
}

// ---------------------------------------------------------------- credits
const credits = [
  {
    source: 'ExerciseDB v1 (AscendAPI), via hasaneyldrm/exercises-dataset',
    license: 'MIT',
    url: 'https://github.com/hasaneyldrm/exercises-dataset',
    attribution: 'Nomes, músculos e instruções originais em inglês. Copyright (c) 2026 Hasan Emir Yıldırım.',
  },
  {
    source: 'openGym',
    license: 'AGPL-3.0',
    url: 'https://github.com/DuarteSantos8/openGym',
    attribution: 'Catálogo de exercícios e tradução para o português do Brasil (nomes e instruções). Copyright (C) 2026 Duarte Santos e colaboradores.',
  },
];
if (mediaBySource.workoutGuide) {
  credits.push({
    source: 'Workout Guide',
    license: 'CC BY-SA 4.0',
    url: 'https://github.com/bryllim/workout-guide',
    attribution:
      'Ilustrações de Bryl Lim (https://bryllim.com); parte dos quadros adaptada de Everkinetic. ' +
      'Cores adaptadas: traço normalizado para branco puro.',
  });
}
if (mediaBySource.everkinetic || mediaBySource.workoutGuide) {
  credits.push({
    source: 'Everkinetic',
    license: 'CC BY-SA 4.0',
    url: 'https://github.com/everkinetic/data',
    attribution:
      'Ilustrações de exercícios de Everkinetic (http://everkinetic.com). ' +
      'Cores adaptadas: traço preto sobre branco convertido em traço branco sobre fundo transparente.',
  });
}
const wgerByLicense = new Map();
for (const m of manifestList.filter((m) => m.path.startsWith('sources/wger/'))) {
  const author = m.attribution.replace(/, via wger\.de.*$/, '');
  if (!wgerByLicense.has(m.license)) wgerByLicense.set(m.license, new Set());
  wgerByLicense.get(m.license).add(author);
}
for (const [license, authors] of [...wgerByLicense].sort()) {
  credits.push({
    source: 'wger',
    license,
    url: 'https://wger.de',
    attribution: `Imagens de ${[...authors].sort().join(', ')}, via wger.de. Cores adaptadas: traço convertido em branco sobre fundo transparente.`,
  });
}

// ---------------------------------------------------------------- legacy map validation
// Every row must point at an exercise of the output: catalog:sync ignores (with a warning) a row whose target is not
// in exercises.json, and the old exercise would then be archived instead of remapped.
if (fs.existsSync(FILES.legacy)) {
  const byId = new Map(catalogue.map((e) => [e.externalId, e]));
  const lines = fs.readFileSync(FILES.legacy, 'utf8').split(/\r?\n/).filter((l) => l.trim());
  if (lines[0] !== 'old_name,old_body_part,external_id') fail('legacy-exercise-map.csv: bad header');
  const seen = new Set();
  console.log(`\nlegacy map (${lines.length - 1} rows):`);
  for (const line of lines.slice(1)) {
    const m = /^("(?:[^"]|"")*"|[^,]*),([A-Z]+),(\d+|mt-\d{4})$/.exec(line);
    if (!m) fail(`legacy-exercise-map.csv: cannot parse "${line}"`);
    const oldName = m[1].replace(/^"|"$/g, '').replace(/""/g, '"');
    if (!BODY_PARTS.includes(m[2])) fail(`legacy-exercise-map.csv: bad body part in "${line}"`);
    const e = byId.get(m[3]);
    if (!e) {
      fail(
        builtById.has(m[3])
          ? `legacy-exercise-map.csv: "${line}" points at ${m[3]} "${builtById.get(m[3]).name}", which is not in the curated list (retarget the row to a kept exercise or drop it)`
          : `legacy-exercise-map.csv: unknown externalId ${m[3]} in "${line}"`,
      );
    }
    const key = `${oldName.toLowerCase()}|${m[2]}`;
    if (seen.has(key)) fail(`legacy-exercise-map.csv: duplicate row "${line}"`);
    seen.add(key);
    if (flags.verbose) console.log(`  ${oldName} (${m[2]}) -> ${e.externalId} ${e.name} [${e.bodyPart}]`);
  }
}

// ---------------------------------------------------------------- write
writeJson(path.join(OUT, 'exercises.json'), catalogue);
writeJson(path.join(OUT, 'media-manifest.json'), manifestList);
writeJson(path.join(OUT, 'credits.json'), credits);

// ---------------------------------------------------------------- report
const dist = {};
for (const e of catalogue) dist[e.bodyPart] = (dist[e.bodyPart] ?? 0) + 1;
console.log('\nbodyPart distribution:');
for (const bp of BODY_PARTS) console.log(`  ${bp.padEnd(10)} ${String(dist[bp] ?? 0).padStart(5)}`);
const withMedia = catalogue.filter((e) => e.images.length).length;
console.log(
  `\nexercises: ${catalogue.length} (${catalogue.length - customExercises.length} openGym${ALL ? ', --all' : ` of ${exercises.length}, curated-list.json`} + ${customExercises.length} custom), ` +
    `with media: ${withMedia} (${((100 * withMedia) / catalogue.length).toFixed(1)}%)`,
);
console.log(`media by source: ${JSON.stringify(mediaBySource)}`);
console.log(`media picks: ${JSON.stringify(pickStats)}`);
const band = reviewList.filter((r) => r.score >= REVIEW_MIN && r.score < AUTO_ACCEPT);
console.log(`media-review.json: ${band.length} decisions in the ${REVIEW_MIN}-${AUTO_ACCEPT} band (${band.filter((r) => r.decision === 'accept').length} accepted, ${band.filter((r) => r.decision === 'reject').length} rejected), ${reviewList.length - band.length} explicit rejects of auto-accepted matches`);
const frameCounts = {};
for (const e of catalogue) if (e.images.length) frameCounts[e.images.length] = (frameCounts[e.images.length] ?? 0) + 1;
console.log(`media files in manifest: ${manifestList.length} in ${manifestFolders.size} folders (all openGym picks: ${manifest.size}); exercises by frame count: ${JSON.stringify(frameCounts)}`);
console.log(`media-frame-exclude.json: ${frameStats.excludedFrames} frames left out of the picked media (counted per exercise) ${JSON.stringify(frameStats.byReason)}`);
console.log(`name overrides applied: ${catalogue.filter((e) => Object.hasOwn(overrides, e.externalId)).length} (of ${Object.keys(overrides).length})`);
console.log(`\nwrote ${path.join(OUT, 'exercises.json')}, media-manifest.json, credits.json`);
