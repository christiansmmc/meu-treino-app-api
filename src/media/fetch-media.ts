/**
 * `bun run media:fetch` — baixa as imagens do catálogo listadas no manifesto
 * de mídia e grava em `MEDIA_DIR` a versão processada de cada uma: cor
 * normalizada (`normalize.ts`) e enquadramento por exercício (`frames.ts`).
 *
 *   bun run media:fetch [manifest] [mediaDir] [--concurrency=8] [--retries=3] [--timeout=30000]
 *                       [--max-fail-ratio=0.05] [--failures-out=<arquivo.json>] [--prune]
 *
 * manifest  array JSON de {path, url, license?, attribution?, transform?, align?};
 *           default $MEDIA_MANIFEST, senão `data/media-manifest.json` do repo
 * mediaDir  raiz de destino; default $MEDIA_DIR, senão `./media` (o mesmo default da API)
 * --prune   no fim (se as falhas ficaram dentro do limite), apaga de mediaDir os
 *           arquivos de mídia (extensões servidas pela API) e temporários `.tmp-*`
 *           que o manifesto não referencia; nunca toca no cache `.raw/`
 *
 * Não lê `src/env.ts` de propósito: roda sem `DATABASE_URL`/`JWT_SECRET` (no
 * stack é um container one-shot que só tem `MEDIA_DIR`).
 *
 * - Grupo = pasta do caminho (`sources/<fonte>/<id>/`): os frames de um
 *   exercício. O recorte usa a caixa de união de TODOS os frames do grupo, então
 *   o grupo é processado inteiro ou não é: se um frame falha, nenhum é gravado.
 * - Grupo com todos os arquivos já presentes (não vazios) é pulado: rodar de
 *   novo é barato e idempotente. Por isso o caminho de saída muda quando o
 *   processamento muda (`frame-N.v2.png`, versão em `build-catalog.mjs`) — a
 *   rota de mídia serve com cache `immutable`.
 * - Os bytes originais ficam em cache em `<mediaDir>/.raw/<sha256 da url>.<ext>`
 *   (a API não serve caminhos com segmento começando em `.`): reprocessar não
 *   baixa de novo.
 * - `transform` (`to-white` | `luma-to-alpha`) liga o processamento (só `.png`);
 *   `align` (`canvas` | `register`, default `canvas`) diz como alinhar os frames.
 *   Entrada sem `transform` é gravada como baixada.
 * - Cada arquivo é gravado num nome temporário na mesma pasta e renomeado
 *   (atômico): nunca fica um arquivo pela metade no caminho final.
 * - Erros transitórios (rede, timeout, 408/429/5xx) têm retry com backoff
 *   exponencial; conteúdo inválido (HTML, PNG corrompido) não.
 * - Sai com 0, a não ser que o manifesto seja inválido (2) ou as falhas
 *   passem de --max-fail-ratio do manifesto (1).
 */
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rmdir, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MEDIA_CONTENT_TYPES, isValidMediaPath, mediaExtension } from '../shared/media-paths.ts'
import { type MediaAlign, frameGroup, isMediaAlign } from './frames.ts'
import { type MediaTransform, decodeAlpha, encodeWhitePng, isMediaTransform, isPng } from './normalize.ts'

const DEFAULT_MANIFEST = fileURLToPath(new URL('../../data/media-manifest.json', import.meta.url))
/** Cache dos bytes originais, dentro de mediaDir. */
const RAW_DIR = '.raw'

interface ManifestEntry {
  path: string
  url: string
  license?: string
  attribution?: string
  transform: MediaTransform | null
  align: MediaAlign
}

interface Group {
  dir: string
  entries: ManifestEntry[]
  transform: MediaTransform | null
  align: MediaAlign
}

interface Failure {
  path: string
  url: string
  error: string
}

const argv = process.argv.slice(2)
const positional = argv.filter((a) => !a.startsWith('--'))
const flags = new Map(
  argv
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const [k, ...v] = a.slice(2).split('=')
      return [k!, v.length ? v.join('=') : 'true'] as const
    }),
)
const num = (name: string, def: number): number => {
  const v = flags.get(name)
  const n = v === undefined ? def : Number(v)
  if (!Number.isFinite(n) || n < 0) {
    console.error(`--${name}=${v} inválido`)
    process.exit(2)
  }
  return n
}

const manifestPath = positional[0] ?? process.env.MEDIA_MANIFEST ?? DEFAULT_MANIFEST
const mediaDir = positional[1] ?? process.env.MEDIA_DIR ?? './media'
const CONCURRENCY = Math.max(1, Math.floor(num('concurrency', 8)))
const RETRIES = Math.floor(num('retries', 3))
const TIMEOUT_MS = num('timeout', 30_000)
const MAX_FAIL_RATIO = num('max-fail-ratio', 0.05)
const FAILURES_OUT = flags.get('failures-out')
const PRUNE = flags.get('prune') === 'true'
const USER_AGENT = 'meu-treino-media-fetch/2.0'

function invalidManifest(message: string): never {
  console.error(`media:fetch: manifesto ${manifestPath}: ${message}`)
  process.exit(2)
}

async function loadManifest(file: string): Promise<Group[]> {
  let data: unknown
  try {
    data = JSON.parse(await Bun.file(file).text())
  } catch (e) {
    invalidManifest(`não foi possível ler (${(e as Error).message})`)
  }
  if (!Array.isArray(data)) invalidManifest('tem que ser um array JSON')

  const byPath = new Map<string, ManifestEntry>()
  for (const [i, e] of data.entries()) {
    const raw = e as Partial<Record<keyof ManifestEntry, unknown>>
    if (typeof raw?.path !== 'string' || typeof raw.url !== 'string' || !/^https?:\/\//.test(raw.url)) {
      invalidManifest(`[${i}] precisa de "path" (string) e "url" http(s)`)
    }
    // Mesma regra que o catalog:sync aplica aos caminhos gravados no banco.
    if (!isValidMediaPath(raw.path)) invalidManifest(`[${i}] caminho inválido "${raw.path}"`)
    const transform = raw.transform ?? null
    if (transform !== null && !isMediaTransform(transform)) {
      invalidManifest(`[${i}] transform desconhecido ${JSON.stringify(transform)}`)
    }
    if (transform !== null && !raw.path.toLowerCase().endsWith('.png')) {
      invalidManifest(`[${i}] transform "${transform}" só vale para .png ("${raw.path}")`)
    }
    const align = raw.align ?? 'canvas'
    if (!isMediaAlign(align)) invalidManifest(`[${i}] align desconhecido ${JSON.stringify(align)}`)
    const entry: ManifestEntry = {
      path: raw.path,
      url: raw.url,
      license: typeof raw.license === 'string' ? raw.license : undefined,
      attribution: typeof raw.attribution === 'string' ? raw.attribution : undefined,
      transform,
      align,
    }
    const prev = byPath.get(entry.path)
    if (prev && (prev.url !== entry.url || prev.transform !== entry.transform || prev.align !== entry.align)) {
      invalidManifest(`"${entry.path}" aparece com URLs/transforms/aligns diferentes`)
    }
    byPath.set(entry.path, entry)
  }

  const groups = new Map<string, Group>()
  for (const entry of byPath.values()) {
    const dir = entry.path.slice(0, entry.path.lastIndexOf('/') + 1)
    const g = groups.get(dir)
    if (!g) {
      groups.set(dir, { dir, entries: [entry], transform: entry.transform, align: entry.align })
    } else if (g.transform !== entry.transform || g.align !== entry.align) {
      invalidManifest(`os frames de "${dir}" têm transform/align diferentes (o grupo é processado junto)`)
    } else {
      g.entries.push(entry)
    }
  }
  for (const g of groups.values()) g.entries.sort((a, b) => a.path.localeCompare(b.path, 'en', { numeric: true }))
  return [...groups.values()]
}

async function fileSize(p: string): Promise<number> {
  try {
    const s = await stat(p)
    return s.isFile() ? s.size : 0
  } catch {
    return 0
  }
}

async function writeAtomic(dest: string, body: Uint8Array): Promise<void> {
  await mkdir(dirname(dest), { recursive: true })
  const tmp = join(dirname(dest), `.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`)
  try {
    await writeFile(tmp, body)
    await rename(tmp, dest)
  } catch (e) {
    await unlink(tmp).catch(() => {})
    throw e
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/** Conteúdo que não serve (não é PNG, PNG corrompido, frame vazio): tentar de novo não adianta. */
class ContentError extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const isTransient = (e: unknown) =>
  e instanceof HttpError ? e.status === 408 || e.status === 429 || e.status >= 500 : !(e instanceof ContentError)

async function download(entry: ManifestEntry): Promise<Uint8Array> {
  const res = await fetch(entry.url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'user-agent': USER_AGENT, accept: 'image/*,video/*;q=0.9,*/*;q=0.5' },
    redirect: 'follow',
  })
  if (!res.ok) throw new HttpError(res.status, `HTTP ${res.status}`)
  const type = res.headers.get('content-type') ?? ''
  if (/^text\/html/i.test(type)) throw new ContentError(`content-type inesperado ${type}`)
  const body = new Uint8Array(await res.arrayBuffer())
  if (body.byteLength === 0) throw new Error('corpo vazio')
  if (entry.transform && !isPng(body)) throw new ContentError('não é um arquivo PNG')
  return body
}

async function downloadWithRetry(entry: ManifestEntry): Promise<Uint8Array> {
  let lastError: unknown
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      return await download(entry)
    } catch (e) {
      lastError = e
      if (!isTransient(e) || attempt === RETRIES) break
      await sleep(500 * 2 ** attempt + Math.random() * 250)
    }
  }
  throw lastError
}

const root = resolve(mediaDir)
const rawRoot = join(root, RAW_DIR)
const rawPath = (entry: ManifestEntry) =>
  join(rawRoot, createHash('sha256').update(entry.url).digest('hex').slice(0, 40) + mediaExtension(entry.path))
const destPath = (entry: ManifestEntry) => join(root, ...entry.path.split('/'))

const stats = {
  groupsProcessed: 0,
  groupsSkipped: 0,
  groupsRegistered: 0,
  written: 0,
  skipped: 0,
  downloaded: 0,
  fromCache: 0,
  bytesDownloaded: 0,
  bytesWritten: 0,
  bytesPresent: 0,
}
const failures: Failure[] = []

/** Bytes originais: do cache `.raw/` ou baixados (e guardados no cache). */
async function rawBytes(entry: ManifestEntry): Promise<Uint8Array> {
  const cached = rawPath(entry)
  if ((await fileSize(cached)) > 0) {
    stats.fromCache++
    return new Uint8Array(await readFile(cached))
  }
  const body = await downloadWithRetry(entry)
  await writeAtomic(cached, body)
  stats.downloaded++
  stats.bytesDownloaded += body.byteLength
  return body
}

async function processGroup(group: Group): Promise<void> {
  const dests = group.entries.map(destPath)
  const sizes = await Promise.all(dests.map(fileSize))
  if (sizes.every((s) => s > 0)) {
    stats.groupsSkipped++
    stats.skipped += sizes.length
    stats.bytesPresent += sizes.reduce((a, b) => a + b, 0)
    return
  }
  const settled = await Promise.allSettled(group.entries.map(rawBytes))
  if (settled.some((r) => r.status === 'rejected')) {
    settled.forEach((r, i) => {
      const { path, url } = group.entries[i]!
      const error = r.status === 'rejected' ? errorMessage(r.reason) : 'não processado: outro frame do grupo falhou'
      failures.push({ path, url, error })
    })
    return
  }
  const raws = settled.map((r) => (r as PromiseFulfilledResult<Uint8Array>).value)
  try {
    let outputs: Uint8Array[]
    if (group.transform) {
      const transform = group.transform
      try {
        const framed = frameGroup(
          raws.map((r) => decodeAlpha(r, transform)),
          group.align,
        )
        outputs = framed.frames.map(encodeWhitePng)
        if (group.align === 'register' && raws.length > 1) stats.groupsRegistered++
      } catch (e) {
        // Original inválido: tira do cache para a próxima execução baixar de novo.
        await Promise.all(group.entries.map((en) => unlink(rawPath(en)).catch(() => {})))
        throw new ContentError(`${transform}: ${(e as Error).message}`)
      }
    } else {
      outputs = raws
    }
    await Promise.all(outputs.map((body, i) => writeAtomic(dests[i]!, body)))
    stats.groupsProcessed++
    stats.written += outputs.length
    stats.bytesWritten += outputs.reduce((a, b) => a + b.byteLength, 0)
  } catch (e) {
    const msg = errorMessage(e)
    for (const entry of group.entries) failures.push({ path: entry.path, url: entry.url, error: msg })
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? (e.name === 'TimeoutError' ? `timeout depois de ${TIMEOUT_MS} ms` : e.message) : String(e)
}

/**
 * Apaga de `root` os arquivos de mídia (extensões de `MEDIA_CONTENT_TYPES`) e
 * temporários `.tmp-*` que não estão em `keep`, e as pastas que ficarem vazias.
 * Não entra em `.raw/` nem segue symlinks; qualquer outro arquivo fica.
 */
async function prune(keep: Set<string>): Promise<{ files: number; bytes: number }> {
  let files = 0
  let bytes = 0
  async function walk(dir: string, rel: string): Promise<boolean> {
    let empty = true
    for (const d of await readdir(dir, { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${d.name}` : d.name
      const abs = join(dir, d.name)
      if (d.isDirectory()) {
        if (!rel && d.name === RAW_DIR) {
          empty = false
          continue
        }
        if (await walk(abs, relPath)) await rmdir(abs).catch(() => {})
        else empty = false
        continue
      }
      const prunable =
        d.isFile() && !keep.has(relPath) && (d.name.startsWith('.tmp-') || mediaExtension(d.name) in MEDIA_CONTENT_TYPES)
      if (!prunable) {
        empty = false
        continue
      }
      bytes += await fileSize(abs)
      await unlink(abs)
      files++
      if (files <= 10) console.log(`  - ${relPath}`)
    }
    return empty
  }
  await walk(root, '')
  return { files, bytes }
}

const groups = await loadManifest(manifestPath)
const total = groups.reduce((a, g) => a + g.entries.length, 0)
const started = Date.now()

let next = 0
async function worker() {
  while (next < groups.length) {
    await processGroup(groups[next++]!)
    const done = stats.groupsProcessed + stats.groupsSkipped
    if (done > 0 && done % 50 === 0) console.log(`  ${done}/${groups.length} grupos`)
  }
}

console.log(
  `media:fetch: ${total} arquivos (${groups.length} grupos) de ${manifestPath} em ${root} (concorrência ${CONCURRENCY})`,
)
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, groups.length) }, worker))

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`
console.log(
  `media:fetch: ${((Date.now() - started) / 1000).toFixed(1)} s — ${stats.written} gravados em ${stats.groupsProcessed} grupos ` +
    `(${mb(stats.bytesWritten)}; ${stats.groupsRegistered} grupos alinhados por registro), ` +
    `${stats.skipped} já presentes em ${stats.groupsSkipped} grupos (${mb(stats.bytesPresent)}), ${failures.length} falharam; ` +
    `originais: ${stats.downloaded} baixados (${mb(stats.bytesDownloaded)}), ${stats.fromCache} do cache ${RAW_DIR}/`,
)
if (failures.length) {
  console.log('falhas:')
  for (const f of failures) console.log(`  ${f.path} <- ${f.url}: ${f.error}`)
}
if (FAILURES_OUT && FAILURES_OUT !== 'true') {
  await writeFile(FAILURES_OUT, JSON.stringify(failures, null, 2) + '\n')
  console.log(`falhas gravadas em ${FAILURES_OUT}`)
}

const ratio = total ? failures.length / total : 0
if (ratio > MAX_FAIL_RATIO) {
  console.error(`media:fetch: falhas demais: ${failures.length}/${total} (> ${(MAX_FAIL_RATIO * 100).toFixed(0)}%)`)
  if (PRUNE) console.error('media:fetch: --prune ignorado por causa das falhas')
  process.exit(1)
}

if (PRUNE) {
  if (dirname(root) === root) {
    console.error(`media:fetch: --prune recusado na raiz do sistema de arquivos (${root})`)
    process.exit(2)
  }
  const keep = new Set(groups.flatMap((g) => g.entries.map((e) => e.path)))
  const pruned = await prune(keep)
  console.log(`media:fetch: --prune apagou ${pruned.files} arquivos não referenciados (${mb(pruned.bytes)})`)
}
