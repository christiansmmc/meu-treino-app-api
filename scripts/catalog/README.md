# Exercise catalogue builder

Builds the global exercise catalogue that `bun run catalog:sync` loads (`data/exercises.json` and
`data/legacy-exercise-map.csv`) and the media manifest that `bun run media:fetch` downloads
(`data/media-manifest.json`), from the [openGym](https://github.com/DuarteSantos8/openGym) catalogue
text plus CC BY-SA illustrations. Licences: see [NOTICE.md](../../NOTICE.md) at the repo root.

Requirements: Node 20+ for the build. Nothing here imports from `src/`; the media downloader lives in the
app (`src/media/fetch-media.ts`, `bun run media:fetch`) because it also runs in production.

## Regenerate

```bash
cd scripts/catalog

# 1. Build the catalogue (offline; reads only catalogue/exercises and catalogue/i18n/pt-BR.json).
#    The shipped catalogue is built with --compound-legs-as-perna.
node build-catalog.mjs /path/to/openGym --compound-legs-as-perna
#    -> out/exercises.json, out/media-manifest.json, out/credits.json
#    prints the bodyPart distribution and media stats; exits 1 on any untranslated value,
#    unreviewed media candidate, invalid media path, bad media-frame-exclude.json entry or bad legacy-map row
#    add --verbose to list every legacy-map row with its new exercise name

# 2. Download + process the media and check every URL (skips folders whose files are all present)
cd ../..
bun run media:fetch scripts/catalog/out/media-manifest.json scripts/catalog/out/media \
  --failures-out=scripts/catalog/out/media-failures.json
#    then look at the result on a dark background (contact sheet), especially any folder whose
#    frames or media-frame-exclude.json entries changed

# 3. Copy into the app
cp scripts/catalog/out/exercises.json scripts/catalog/out/media-manifest.json scripts/catalog/out/credits.json \
   scripts/catalog/legacy-exercise-map.csv data/
```

In production `bun run media:fetch` (no arguments) reads `data/media-manifest.json` and writes into
`MEDIA_DIR` (or `MEDIA_MANIFEST` / positional arguments; options `--concurrency=8 --retries=3
--timeout=30000 --max-fail-ratio=0.05 --prune`). It caches the upstream bytes in `MEDIA_DIR/.raw/`,
processes each exercise folder as one group (colour `transform`, `align`, union crop, square, ≤ 512 px;
see below), writes each file atomically and exits non-zero only when failures exceed
`--max-fail-ratio`. `--prune` then deletes the media files (and stale `.tmp-*`) under `MEDIA_DIR` that
the manifest no longer lists, e.g. the previous version's paths after a release; it never touches
`.raw/` or non-media files. See the app README for details.

If a URL fails permanently, add it to `media-exclude.json` (`["https://...", ...]` or
`[{"url": "...", "reason": "..."}]`) and rebuild: the exercise falls back to its next accepted candidate
or ends up without images, so no exercise points at a missing file.

### Refreshing the media candidates (optional, needs network)

`media-candidates.json` is a committed snapshot, so builds are reproducible. To rematch against the
current upstream data:

```bash
node match-media.mjs /path/to/openGym/catalogue/exercises .cache/dl .cache/match
node build-catalog.mjs /path/to/openGym --refresh-candidates=.cache/match/matches-by-source.json
```

New candidates scored 0.75–0.85 make the build fail until each has a decision in `media-review.json`.

## Files

| File | Purpose |
|---|---|
| `build-catalog.mjs` | The build. Translation dictionaries, pt-BR name rules, media selection |
| `name-overrides.json` | `externalId -> name`; wins over the automatic name rules |
| `media-candidates.json` | Best Workout Guide / Everkinetic / wger match per exercise (score ≥ 0.75) |
| `media-review.json` | Manual `accept`/`reject` with a reason: every 0.75–0.85 candidate, plus rejects of wrong auto-accepted ones |
| `media-manual.json` | Hand-picked media (full frame URLs + reason) for common exercises the name matcher missed because the source uses another name, e.g. Face Pull, Pec Deck, Hip Thrust |
| `media-exclude.json` | Media URLs to skip (permanent download failures) |
| `media-frame-exclude.json` | Single frames left out of a candidate (inconsistent line style or framing), with a reason code; see "Frame consistency" |
| `legacy-exercise-map.csv` | Old catalogue (`old_name,old_body_part`) -> new `external_id`; validated by the build |
| `match-media.mjs` | Name matcher that produces the candidates (CC sources only) |

The downloader is `src/media/fetch-media.ts` in the app (`bun run media:fetch`).

## Rules the build applies

- **Exercises**: the 1,324 openGym entries with `"textSource": "exercisedb"`. `externalId` is the openGym id.
- **Text**: `name` is the pt-BR name in sentence case after the wording rules and overrides (duplicates get
  "(variação N)"); `nameEn` is the English name as is; `instructions` are pt-BR (English if missing).
  `equipment`, `target`, `secondaryMuscles` and `category` go through explicit dictionaries.
- **bodyPart** comes from `target` (pectorals→PEITO, lats/upper back→COSTAS, delts/traps/levator
  scapulae→OMBRO, quads/hamstrings/calves/adductors→PERNA, glutes/abductors→GLUTEO, abs/serratus→ABDOMEN,
  spine→LOMBAR, forearms→ANTEBRACO, cardiovascular system or openGym bodyPart "cardio"→CARDIO).
  openGym targets most squats, lunges, leg presses and deadlifts at glutes, so they would land in GLUTEO;
  `--compound-legs-as-perna` (used for the shipped catalogue) files those under PERNA instead, by English
  name (squat, lunge, leg press, step-up, split, hack, deadlift, good morning, pistol): 89 exercises.
- **Media**: an entry in `media-manual.json` wins. Otherwise candidates scored ≥ 0.85 are accepted unless
  `media-review.json` rejects them; 0.75–0.85 need an explicit accept. The highest score wins (near-ties:
  Workout Guide, then Everkinetic, then wger). PNG files only; wger only for images credited to Everkinetic
  (see NOTICE.md). Frames listed in `media-frame-exclude.json` are dropped (see "Frame consistency"); a
  candidate left with no frame falls back to the next one. Files are shared between exercises under
  `sources/<source>/<id>/frame-<n>.v2.png`, `n` being the upstream frame number (so an exercise can have
  `frame-1.v2.png` and `frame-3.v2.png`). One frame left = static image in the app; two or more = flip-book.
- **Colour normalization**: every manifest entry has a `transform` that `media:fetch` applies after the
  download, so all frames end up as white strokes on a transparent background:
  - `to-white` (Workout Guide: already white on transparent, but some strokes are RGB 254) → RGB = 255, alpha kept;
  - `luma-to-alpha` (Everkinetic, and Everkinetic images re-hosted by wger: opaque black on white) →
    alpha = (255 − luma) × alpha / 255, RGB = 255.

  CC BY-SA requires indicating changes, so the credits say so: `mediaAttribution` ends in "(cores
  adaptadas)", the manifest's `attribution` in "colours adapted: ...", and `credits.json` describes the
  colour change per source; NOTICE.md lists every change (colour, crop, resize).
- **Framing**: `media:fetch` processes all files of a folder together, so the flip-book frames stay aligned
  and the figure fills the app's square tile:
  1. align the frames by the manifest's `align`: `canvas` (Workout Guide: the frames share one 512×512
     canvas, used as is) or `register` (Everkinetic: each frame is cropped tight to its own drawing upstream,
     with different sizes, so each is translated onto the first by the shift that best overlaps the strokes,
     an FFT cross-correlation at ~256 px refined at ½ resolution; scale is already equal between frames);
  2. crop to the UNION bounding box of the strokes of all frames (never per frame), add a uniform 6% margin
     (of the box's longer side) and centre it on a transparent square;
  3. downscale to at most 512 px by area averaging (never upscale). Output: 8-bit grey+alpha PNG, grey 255.
- **Versioned paths**: the API serves media with an immutable cache and `media:fetch` skips folders whose
  files exist, so processed bytes must never reuse a path. `MEDIA_VERSION` in `build-catalog.mjs` (now `v2`)
  is part of every path: bump it whenever `src/media/normalize.ts` or `src/media/frames.ts` change their
  output, rebuild, and run `media:fetch --prune` once after the release to delete the old version.
  (v1 = `frame-<n>-white.png`: colour transform only, upstream canvas.)

## Frame consistency (`media-frame-exclude.json`)

The Workout Guide frames of one exercise are not one drawing in three poses: frame 1 is usually traced
from Everkinetic in a clean line style, while frames 2 and 3 were drawn separately in other styles. A
review of contact sheets of all 152 Workout Guide folders (all frames side by side on a dark background,
plus an overlay of the frames) found:

- `bold-outline` (72 frames, 69 of them frame 2): heavy strokes, often hollow (opaque edges around a
  semi-transparent core, e.g. bench-press frame 2) and usually at another scale;
- `thin-strokes` (132 frames): thinner, doubled or partly translucent strokes that read faint or grey next
  to frame 1;
- `framing` (14 frames): same style, but a different view, scale, mirroring or position, so the animation
  jumps (e.g. ab-wheel, deadlift, walking-lunge frame 3);
- `composite` (1): inchworm frame 1 shows two poses side by side.

Rule: keep only frames drawn in the style of the exercise's first frame and at its framing; drop the rest
(219 of 456 Workout Guide frames; frame 2 in 133 folders, frame 3 in 84). Result: 76 folders static, 67
with 2 frames, 9 with 3. The Everkinetic frames (133 folders) are one consistent style and, once registered,
line up (bench, machine and floor coincide), so none is excluded.

Triage that produced the style entries, then confirmed visually (a few borderline frames were kept or
dropped by eye): on the normalized alpha, take the stroke pixels (alpha > 16) and compute the share at
alpha 17–63 (the anti-aliased edge, "fringe") and at ≥ 240 ("solid"). All first frames sit on one line,
solid ≈ 0.957 − 3.73 × fringe, with fringe 0.07–0.14. A frame with fringe < 0.03 is `bold-outline`
(resampled art, no anti-aliased edge); one with fringe outside 0.07–0.14 or more than 0.10 off the line is
`thin-strokes`. `framing` and `composite` are visual decisions (overlay of the frames on the shared canvas).
Registration is not used for Workout Guide: it would cancel real motion (a squat's bottom frame would be
shifted up onto the standing torso).

When the candidates change (new matches, `media-manual.json`), review the new folders the same way and add
their entries; the build fails on an unknown reason code or a frame number the candidate does not have, and
warns about entries no exercise uses.

## Output shape (`out/exercises.json`)

```json
{
  "externalId": "0025",
  "name": "Supino reto com barra",
  "nameEn": "barbell bench press",
  "bodyPart": "PEITO",
  "equipment": "Barra",
  "target": "Peitoral",
  "secondaryMuscles": ["Tríceps", "Ombros"],
  "category": "Força",
  "instructions": ["Deite-se em um banco ...", "..."],
  "images": ["sources/workout-guide/bench-press/frame-1.v2.png", "sources/workout-guide/bench-press/frame-3.v2.png"],
  "video": null,
  "mediaAttribution": "Ilustração: Bryl Lim (Workout Guide), adaptada de Everkinetic — CC BY-SA 4.0 (cores adaptadas)"
}
```

`out/media-manifest.json` entry:

```json
{
  "path": "sources/everkinetic/0004/frame-1.v2.png",
  "url": "https://raw.githubusercontent.com/everkinetic/data/main/dist/png/0004-relaxation.png",
  "license": "CC BY-SA 4.0",
  "attribution": "Everkinetic (http://everkinetic.com, https://github.com/everkinetic/data); colours adapted: ...",
  "transform": "luma-to-alpha",
  "align": "register"
}
```

Display note: after `media:fetch`, every frame (Workout Guide and Everkinetic alike) is white line art on a
transparent, square background (≤ 512 px, the strokes of all frames filling ~89% of the side), and all frames
of an exercise have the same size and alignment. Show it on a dark surface, or tint it to the theme colour
(Flutter: `Image.network(url, color: onSurface, colorBlendMode: BlendMode.srcIn)`); the same treatment works
for all frames.
