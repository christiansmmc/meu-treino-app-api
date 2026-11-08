import { realpath, stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import type { Context } from 'hono'
import { env } from '../env.ts'
import {
  MEDIA_CONTENT_TYPES,
  MEDIA_ROUTE_PREFIX,
  isSafeMediaSegment,
  mediaExtension,
} from '../shared/media.ts'

/**
 * `GET /api/media/*` — arquivos do catálogo (imagens/vídeos) a partir de
 * `MEDIA_DIR`.
 *
 * Público de propósito: `<img>`/`Image.network` não mandam `Authorization`.
 * O conteúdo é o mesmo catálogo global para todo mundo, nada por usuário.
 *
 * Só extensões de `MEDIA_CONTENT_TYPES` são servidas; qualquer outra coisa
 * (inclusive arquivo inexistente, diretório, ou caminho que escape da raiz)
 * vira o 404 padrão da API — sem distinguir "não existe" de "não permitido".
 */

const CACHE_CONTROL = 'public, max-age=31536000, immutable'

/** Resolvido uma vez (realpath) — symlinks dentro de MEDIA_DIR não podem apontar pra fora. */
let mediaRootPromise: Promise<string | null> | null = null
function mediaRoot(): Promise<string | null> {
  mediaRootPromise ??= realpath(resolve(env.MEDIA_DIR)).catch(() => {
    // Sem MEDIA_DIR montado: tudo vira 404, e tentamos de novo na próxima
    // requisição (o volume pode aparecer depois do boot).
    mediaRootPromise = null
    return null
  })
  return mediaRootPromise
}

/**
 * Decodifica o resto da URL depois de `/api/media/` segmento a segmento e
 * rejeita qualquer coisa ambígua. Parte da URL crua (não de `c.req.path`) para
 * que `%2F`/`%5C` codificados dentro de um segmento não virem separadores
 * depois de decodificados.
 */
function parseSegments(rawPath: string): string[] | null {
  const rest = rawPath.slice(MEDIA_ROUTE_PREFIX.length)
  if (rest.length === 0) return null

  const segments: string[] = []
  for (const raw of rest.split('/')) {
    let segment: string
    try {
      segment = decodeURIComponent(raw)
    } catch {
      return null
    }
    if (!isSafeMediaSegment(segment)) return null
    segments.push(segment)
  }
  return segments
}

interface ByteRange {
  start: number
  end: number
}

/**
 * Só um intervalo (`bytes=a-b`, `bytes=a-`, `bytes=-n`). Múltiplos intervalos
 * ou cabeçalho malformado → `undefined` (responde o arquivo inteiro, que é o
 * permitido pela RFC 9110). Intervalo fora do arquivo → `null` (416).
 */
function parseRange(header: string | undefined, size: number): ByteRange | null | undefined {
  if (!header) return undefined
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return undefined
  const [, startRaw = '', endRaw = ''] = match
  if (startRaw === '' && endRaw === '') return undefined

  if (startRaw === '') {
    const suffix = Number(endRaw)
    if (suffix === 0) return null
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }

  const start = Number(startRaw)
  const end = endRaw === '' ? size - 1 : Math.min(Number(endRaw), size - 1)
  if (start >= size || start > end) return null
  return { start, end }
}

export async function serveMedia(c: Context) {
  const segments = parseSegments(new URL(c.req.url).pathname)
  if (!segments) return c.notFound()

  const contentType = MEDIA_CONTENT_TYPES[mediaExtension(segments[segments.length - 1]!)]
  if (!contentType) return c.notFound()

  const root = await mediaRoot()
  if (!root) return c.notFound()

  let filePath: string
  let size: number
  let mtime: Date
  try {
    filePath = await realpath(resolve(root, ...segments))
    if (!filePath.startsWith(root + sep)) return c.notFound()
    const info = await stat(filePath)
    if (!info.isFile()) return c.notFound()
    size = info.size
    mtime = info.mtime
  } catch {
    return c.notFound()
  }

  const etag = `W/"${size.toString(16)}-${mtime.getTime().toString(16)}"`
  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'Cache-Control': CACHE_CONTROL,
    'Accept-Ranges': 'bytes',
    ETag: etag,
    'Last-Modified': mtime.toUTCString(),
    'X-Content-Type-Options': 'nosniff',
  }
  if (contentType === 'image/svg+xml') {
    // SVG aberto direto no navegador executaria <script> no origin da API.
    headers['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'; sandbox"
  }

  if (c.req.header('If-None-Match') === etag) {
    return c.body(null, 304, headers)
  }

  const file = Bun.file(filePath)
  const range = parseRange(c.req.header('Range'), size)

  if (range === null) {
    return c.body(null, 416, { ...headers, 'Content-Range': `bytes */${size}` })
  }

  if (range) {
    // 206 explícito com o slice: não depende do auto-range do Bun.serve, que
    // muda entre versões; o Bun não reaplica Range sobre uma resposta 206.
    return new Response(file.slice(range.start, range.end + 1), {
      status: 206,
      headers: {
        ...headers,
        'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
        'Content-Length': String(range.end - range.start + 1),
      },
    })
  }

  return new Response(file, { status: 200, headers: { ...headers, 'Content-Length': String(size) } })
}
