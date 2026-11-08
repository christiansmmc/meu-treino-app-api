/**
 * Normalização de cor das imagens do catálogo: todo frame termina como traço
 * BRANCO sobre fundo TRANSPARENTE, para o app tingir qualquer um do mesmo jeito
 * (Flutter: `Image.network(url, color: ..., colorBlendMode: BlendMode.srcIn)`).
 *
 * A regra vem por arquivo no `media-manifest.json` (`transform`, definido por
 * `scripts/catalog/build-catalog.mjs`):
 *
 * - `to-white`: o arquivo já é traço branco sobre transparente (Workout Guide,
 *   onde parte do traço vem 254 em vez de 255) → RGB = 255, alfa mantido.
 * - `luma-to-alpha`: traço preto opaco sobre branco (Everkinetic) →
 *   alfa = (255 − luma) × alfa / 255, RGB = 255. Branco vira transparente,
 *   preto vira branco opaco, e o anti-aliasing cinza vira alfa intermediário.
 *
 * Como o RGB final é sempre 255, a imagem normalizada é só um plano de alfa
 * (`AlphaImage`); recorte, alinhamento e redução ficam em `frames.ts`.
 *
 * PNG puro em JS (`pngjs`, sem dependência nativa: roda no Bun do alpine).
 */
import { PNG } from 'pngjs'

export const MEDIA_TRANSFORMS = ['to-white', 'luma-to-alpha'] as const
export type MediaTransform = (typeof MEDIA_TRANSFORMS)[number]

export function isMediaTransform(value: unknown): value is MediaTransform {
  return (MEDIA_TRANSFORMS as readonly unknown[]).includes(value)
}

/** Frame normalizado: traço branco implícito, só o alfa (8 bits, linha a linha). */
export interface AlphaImage {
  width: number
  height: number
  alpha: Uint8Array
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

export function isPng(bytes: Uint8Array): boolean {
  return bytes.length > PNG_SIGNATURE.length && PNG_SIGNATURE.every((b, i) => bytes[i] === b)
}

/**
 * Decodifica o PNG (o pngjs já expande paleta, cinza, tRNS e 16 bits para RGBA
 * 8 bits) e aplica `transform`, devolvendo o plano de alfa. Lança se a entrada
 * não for um PNG válido.
 */
export function decodeAlpha(input: Uint8Array, transform: MediaTransform): AlphaImage {
  if (!isPng(input)) throw new Error('não é um arquivo PNG')
  const png = PNG.sync.read(Buffer.from(input.buffer, input.byteOffset, input.byteLength))
  const d = png.data
  const alpha = new Uint8Array(png.width * png.height)

  for (let i = 0, p = 0; p < alpha.length; i += 4, p++) {
    if (transform === 'luma-to-alpha') {
      // Luma Rec. 601 sobre os valores gamma-encoded, em inteiros.
      const luma = Math.round((299 * d[i]! + 587 * d[i + 1]! + 114 * d[i + 2]!) / 1000)
      alpha[p] = Math.round(((255 - luma) * d[i + 3]!) / 255)
    } else {
      alpha[p] = d[i + 3]!
    }
  }
  return { width: png.width, height: png.height, alpha }
}

/** PNG 8 bits cinza+alfa com o cinza sempre 255: metade do tamanho de RGBA sem perder nada. */
export function encodeWhitePng(image: AlphaImage): Buffer {
  const png = new PNG({ width: image.width, height: image.height })
  const d = png.data
  for (let i = 0, p = 0; p < image.alpha.length; i += 4, p++) {
    d[i] = 255
    d[i + 1] = 255
    d[i + 2] = 255
    d[i + 3] = image.alpha[p]!
  }
  // colorType 4 = cinza + alfa; a entrada continua sendo o buffer RGBA.
  return PNG.sync.write(png, { colorType: 4, inputColorType: 6 })
}
