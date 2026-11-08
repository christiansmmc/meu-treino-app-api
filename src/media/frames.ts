/**
 * Enquadramento dos frames de um exercício (uma pasta do manifesto, ex.:
 * `sources/everkinetic/0004/`), depois da normalização de cor:
 *
 * 1. **Alinhamento** (`align` no manifesto):
 *    - `canvas`: os frames já compartilham a mesma tela (Workout Guide: 512×512,
 *      a figura desenhada na mesma posição) → usados como estão;
 *    - `register`: cada frame vem recortado rente ao próprio desenho, com
 *      tamanhos diferentes (Everkinetic) → cada frame é transladado sobre o
 *      primeiro pela posição que maximiza a sobreposição do traço (correlação do
 *      alfa, do grosso para o fino). A escala já é a mesma entre os frames de um
 *      exercício (espessura do traço igual), então só há translação.
 * 2. **Recorte pela UNIÃO**: a caixa do traço de todos os frames juntos (nunca
 *    frame a frame, senão a animação pularia), + margem uniforme de 6% do lado
 *    maior, centralizada num quadrado transparente.
 * 3. **Redução**: lado ≤ 512 px por média de área (box filter) — como a cor é
 *    sempre branca, a média do alfa é exatamente a média em alfa
 *    pré-multiplicado. Nunca amplia.
 *
 * Tudo em JS puro sobre `Uint8Array`/`Float32Array` (sem dependência nativa).
 */
import type { AlphaImage } from './normalize.ts'

export const MEDIA_ALIGNS = ['canvas', 'register'] as const
export type MediaAlign = (typeof MEDIA_ALIGNS)[number]

export function isMediaAlign(value: unknown): value is MediaAlign {
  return (MEDIA_ALIGNS as readonly unknown[]).includes(value)
}

/** Lado máximo da saída (px). */
export const MAX_SIDE = 512
/** Margem em volta da caixa de união, fração do lado maior da caixa. */
export const PADDING = 0.06
/** Alfa acima disto conta como traço para a caixa (ignora poeira quase invisível). */
const INK_THRESHOLD = 16
/** Lado aproximado da imagem na busca exaustiva do alinhamento. */
const SEARCH_SIDE = 256

export interface Offset {
  x: number
  y: number
}

interface Box {
  x0: number
  y0: number
  x1: number // exclusivo
  y1: number // exclusivo
}

function inkBox(img: AlphaImage): Box | null {
  const { width: w, height: h, alpha } = img
  let x0 = w
  let y0 = h
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) {
      if (alpha[row + x]! > INK_THRESHOLD) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        y1 = y
      }
    }
  }
  return x1 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1 }
}

// ---------------------------------------------------------------- alinhamento

interface Plane {
  w: number
  h: number
  d: Float32Array
}

/** Reduz por um fator inteiro (média de área; o que passa da borda conta como transparente). */
function shrink(img: AlphaImage, f: number): Plane {
  const w = Math.ceil(img.width / f)
  const h = Math.ceil(img.height / f)
  const d = new Float32Array(w * h)
  for (let y = 0; y < img.height; y++) {
    const row = y * img.width
    const out = Math.floor(y / f) * w
    for (let x = 0; x < img.width; x++) d[out + Math.floor(x / f)]! += img.alpha[row + x]!
  }
  const norm = 1 / (255 * f * f)
  for (let i = 0; i < d.length; i++) d[i]! *= norm
  return { w, h, d }
}

/** Box blur 3×3 aplicado 3 vezes (≈ gaussiano σ 1,4): tolera diferenças finas de traço entre os frames. */
function blur(p: Plane): Plane {
  let d = p.d
  for (let pass = 0; pass < 3; pass++) {
    const t = new Float32Array(d.length)
    for (let y = 0; y < p.h; y++) {
      const row = y * p.w
      for (let x = 0; x < p.w; x++) {
        t[row + x] = ((x > 0 ? d[row + x - 1]! : 0) + d[row + x]! + (x + 1 < p.w ? d[row + x + 1]! : 0)) / 3
      }
    }
    const o = new Float32Array(d.length)
    for (let y = 0; y < p.h; y++) {
      for (let x = 0; x < p.w; x++) {
        const i = y * p.w + x
        o[i] = ((y > 0 ? t[i - p.w]! : 0) + t[i]! + (y + 1 < p.h ? t[i + p.w]! : 0)) / 3
      }
    }
    d = o
  }
  return { w: p.w, h: p.h, d }
}

/**
 * Melhor translação (dx, dy) de `b` sobre `a` dentro da janela dada:
 * maximiza Σ a(x+dx, y+dy)·b(x, y) (só os pixels não nulos de `b`). Empate: a
 * primeira na ordem de varredura (determinístico).
 */
function bestShift(a: Plane, b: Plane, xMin: number, xMax: number, yMin: number, yMax: number): Offset {
  const px: number[] = []
  const py: number[] = []
  const pv: number[] = []
  for (let y = 0; y < b.h; y++) {
    for (let x = 0; x < b.w; x++) {
      const v = b.d[y * b.w + x]!
      if (v > 1e-4) {
        px.push(x)
        py.push(y)
        pv.push(v)
      }
    }
  }
  let best = -1
  let bx = 0
  let by = 0
  for (let dy = yMin; dy <= yMax; dy++) {
    for (let dx = xMin; dx <= xMax; dx++) {
      let s = 0
      for (let k = 0; k < pv.length; k++) {
        const x = px[k]! + dx
        const y = py[k]! + dy
        if (x >= 0 && y >= 0 && x < a.w && y < a.h) s += a.d[y * a.w + x]! * pv[k]!
      }
      if (s > best) {
        best = s
        bx = dx
        by = dy
      }
    }
  }
  return { x: bx, y: by }
}

/** FFT complexa radix-2 in-place (n potência de 2); `invert` = inversa sem normalizar. */
function fft(re: Float64Array, im: Float64Array, invert: boolean): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j]!, re[i]!]
      ;[im[i], im[j]] = [im[j]!, im[i]!]
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((invert ? 2 : -2) * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k]!
        const ai = im[i + k]!
        const br = re[i + k + len / 2]! * cr - im[i + k + len / 2]! * ci
        const bi = re[i + k + len / 2]! * ci + im[i + k + len / 2]! * cr
        re[i + k] = ar + br
        im[i + k] = ai + bi
        re[i + k + len / 2] = ar - br
        im[i + k + len / 2] = ai - bi
        const t = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = t
      }
    }
  }
}

/** FFT 2D de um quadrado n×n (linhas, depois colunas). */
function fft2d(re: Float64Array, im: Float64Array, n: number, invert: boolean): void {
  const r = new Float64Array(n)
  const i = new Float64Array(n)
  for (let y = 0; y < n; y++) {
    r.set(re.subarray(y * n, y * n + n))
    i.set(im.subarray(y * n, y * n + n))
    fft(r, i, invert)
    re.set(r, y * n)
    im.set(i, y * n)
  }
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) {
      r[y] = re[y * n + x]!
      i[y] = im[y * n + x]!
    }
    fft(r, i, invert)
    for (let y = 0; y < n; y++) {
      re[y * n + x] = r[y]!
      im[y * n + x] = i[y]!
    }
  }
}

/**
 * Busca exaustiva (correlação cruzada via FFT): a translação de `b` sobre `a`,
 * entre todas as que ainda sobrepõem as duas imagens, que maximiza
 * Σ a(x+dx, y+dy)·b(x, y). Empate: a primeira na ordem de varredura.
 */
function bestShiftGlobal(a: Plane, b: Plane): Offset {
  let n = 1
  while (n < Math.max(a.w + b.w, a.h + b.h)) n <<= 1
  const ar = new Float64Array(n * n)
  const ai = new Float64Array(n * n)
  const br = new Float64Array(n * n)
  const bi = new Float64Array(n * n)
  for (let y = 0; y < a.h; y++) for (let x = 0; x < a.w; x++) ar[y * n + x] = a.d[y * a.w + x]!
  for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++) br[y * n + x] = b.d[y * b.w + x]!
  fft2d(ar, ai, n, false)
  fft2d(br, bi, n, false)
  // A · conj(B) → correlação circular; n ≥ a + b evita que deslocamentos válidos se misturem
  for (let k = 0; k < n * n; k++) {
    const re = ar[k]! * br[k]! + ai[k]! * bi[k]!
    const im = ai[k]! * br[k]! - ar[k]! * bi[k]!
    ar[k] = re
    ai[k] = im
  }
  fft2d(ar, ai, n, true)
  let best = -Infinity
  let bx = 0
  let by = 0
  for (let dy = -(b.h - 1); dy <= a.h - 1; dy++) {
    const row = ((dy + n) % n) * n
    for (let dx = -(b.w - 1); dx <= a.w - 1; dx++) {
      const s = ar[row + ((dx + n) % n)]!
      if (s > best + 1e-9) {
        best = s
        bx = dx
        by = dy
      }
    }
  }
  return { x: bx, y: by }
}

/**
 * Posição do canto superior esquerdo de `b` nas coordenadas de `a` que melhor
 * sobrepõe os dois desenhos: busca exaustiva numa versão de ~256 px (a essa
 * escala o traço ainda decide; mais grosso, a massa do desenho domina e o
 * resultado erra) e refino local em ½ da resolução.
 */
export function register(a: AlphaImage, b: AlphaImage): Offset {
  const maxDim = Math.max(a.width, a.height, b.width, b.height)
  const f = Math.max(1, Math.ceil(maxDim / SEARCH_SIDE))
  const est = bestShiftGlobal(blur(shrink(a, f)), blur(shrink(b, f)))
  if (f <= 2) return { x: est.x * f, y: est.y * f }
  const pa = blur(shrink(a, 2))
  const pb = blur(shrink(b, 2))
  const cx = Math.round((est.x * f) / 2)
  const cy = Math.round((est.y * f) / 2)
  const r = Math.ceil(f / 2) + 1
  const fine = bestShift(pa, pb, cx - r, cx + r, cy - r, cy + r)
  return { x: fine.x * 2, y: fine.y * 2 }
}

// ---------------------------------------------------------------- recorte + redução

/** Pesos da média de área de `n` amostras para `m` (m ≤ n): por saída, [início, pesos...]. */
function areaWeights(n: number, m: number): { start: number; w: Float32Array }[] {
  const scale = n / m
  const out: { start: number; w: Float32Array }[] = []
  for (let o = 0; o < m; o++) {
    const s0 = o * scale
    const s1 = (o + 1) * scale
    const start = Math.floor(s0)
    const end = Math.min(n, Math.ceil(s1))
    const w = new Float32Array(end - start)
    for (let i = start; i < end; i++) w[i - start] = (Math.min(s1, i + 1) - Math.max(s0, i)) / scale
    out.push({ start, w })
  }
  return out
}

/** Reduz um quadrado `n`×`n` para `m`×`m` por média de área (separável). */
function areaResize(src: Uint8Array, n: number, m: number): Uint8Array {
  if (m === n) return src
  const ws = areaWeights(n, m)
  const tmp = new Float32Array(n * m) // n linhas × m colunas
  for (let y = 0; y < n; y++) {
    const row = y * n
    for (let o = 0; o < m; o++) {
      const { start, w } = ws[o]!
      let s = 0
      for (let k = 0; k < w.length; k++) s += src[row + start + k]! * w[k]!
      tmp[y * m + o] = s
    }
  }
  const out = new Uint8Array(m * m)
  for (let o = 0; o < m; o++) {
    const { start, w } = ws[o]!
    for (let x = 0; x < m; x++) {
      let s = 0
      for (let k = 0; k < w.length; k++) s += tmp[(start + k) * m + x]! * w[k]!
      out[o * m + x] = Math.min(255, Math.round(s))
    }
  }
  return out
}

export interface FramedGroup {
  frames: AlphaImage[]
  /** Translação aplicada a cada frame (coordenadas do primeiro). */
  offsets: Offset[]
  /** Caixa de união do traço, antes da margem (px da origem). */
  box: { width: number; height: number }
  /** Lado do quadrado antes da redução (px da origem). */
  side: number
}

/**
 * Alinha (se `register`), recorta pela união, centraliza num quadrado com
 * margem e reduz para ≤ `MAX_SIDE`. Todos os frames saem do mesmo tamanho e
 * na mesma posição relativa. Lança se nenhum frame tiver traço.
 */
export function frameGroup(frames: AlphaImage[], align: MediaAlign): FramedGroup {
  if (frames.length === 0) throw new Error('grupo sem frames')
  const offsets: Offset[] = frames.map((f, i) =>
    i > 0 && align === 'register' ? register(frames[0]!, f) : { x: 0, y: 0 },
  )

  let union: Box | null = null
  frames.forEach((f, i) => {
    const b = inkBox(f)
    if (!b) return
    const o = offsets[i]!
    const s = { x0: b.x0 + o.x, y0: b.y0 + o.y, x1: b.x1 + o.x, y1: b.y1 + o.y }
    union = union
      ? { x0: Math.min(union.x0, s.x0), y0: Math.min(union.y0, s.y0), x1: Math.max(union.x1, s.x1), y1: Math.max(union.y1, s.y1) }
      : s
  })
  if (!union) throw new Error('nenhum frame tem traço')
  const u: Box = union
  const bw = u.x1 - u.x0
  const bh = u.y1 - u.y0
  const longest = Math.max(bw, bh)
  const pad = Math.round(longest * PADDING)
  const side = longest + 2 * pad
  // origem da caixa de união dentro do quadrado
  const ox = Math.floor((side - bw) / 2)
  const oy = Math.floor((side - bh) / 2)
  const target = Math.min(side, MAX_SIDE)

  const out = frames.map((f, i) => {
    const canvas = new Uint8Array(side * side)
    const dx = offsets[i]!.x - u.x0 + ox
    const dy = offsets[i]!.y - u.y0 + oy
    const xs = Math.max(0, -dx)
    const xe = Math.min(f.width, side - dx)
    if (xe > xs) {
      for (let y = Math.max(0, -dy); y < Math.min(f.height, side - dy); y++) {
        canvas.set(f.alpha.subarray(y * f.width + xs, y * f.width + xe), (y + dy) * side + xs + dx)
      }
    }
    return { width: target, height: target, alpha: areaResize(canvas, side, target) }
  })
  return { frames: out, offsets, box: { width: bw, height: bh }, side }
}
