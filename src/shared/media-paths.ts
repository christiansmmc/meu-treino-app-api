/**
 * Caminhos de mídia sem nada de banco: o `media:fetch` importa daqui e roda só
 * com isto + `src/media/` (estágio `media` do Dockerfile, que fica em cache
 * enquanto o manifesto não muda). `media.ts` reexporta tudo.
 */

/** Prefixo público de `GET /api/media/*` (ver `modules/media.routes.ts`). */
export const MEDIA_ROUTE_PREFIX = '/api/media/'

/** Única allowlist de extensões: o sync rejeita o que a rota de mídia não serviria. */
export const MEDIA_CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
}

/**
 * Segmento de caminho aceitável dentro de `MEDIA_DIR`: não vazio, não começa
 * com `.` (barra `.`, `..` e dotfiles) e sem separador, `:` (drive letter no
 * Windows) ou caractere de controle.
 */
export function isSafeMediaSegment(segment: string): boolean {
  return (
    segment.length > 0 &&
    !segment.startsWith('.') &&
    !/[\\/:\u0000-\u001f\u007f]/.test(segment)
  )
}

/** Extensão (minúscula, com ponto) do caminho, ou `''`. */
export function mediaExtension(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot).toLowerCase() : ''
}

/** Caminho relativo a `MEDIA_DIR` válido para gravar no banco (usado pelo `catalog:sync`). */
export function isValidMediaPath(path: string): boolean {
  return (
    path.split('/').every(isSafeMediaSegment) && mediaExtension(path) in MEDIA_CONTENT_TYPES
  )
}

/**
 * Caminho relativo a `MEDIA_DIR` (qualquer layout, ex.:
 * `sources/workout-guide/bench-press/frame-1.png`) → path origin-relative
 * servido pela API (`/api/media/sources/workout-guide/bench-press/frame-1.png`).
 *
 * Origin-relative de propósito: a API não sabe sob qual host/proxy está
 * publicada, e o cliente já conhece a própria base URL. Cada segmento é
 * percent-encoded para que nomes com espaço/acento continuem URLs válidas.
 */
export function mediaUrl(relativePath: string | null | undefined): string | null {
  if (!relativePath) return null
  const segments = relativePath.split('/').filter((s) => s.length > 0)
  if (segments.length === 0) return null
  return MEDIA_ROUTE_PREFIX + segments.map(encodeURIComponent).join('/')
}

export function mediaUrls(relativePaths: readonly string[] | null | undefined): string[] {
  if (!relativePaths) return []
  return relativePaths.map(mediaUrl).filter((u): u is string => u !== null)
}
