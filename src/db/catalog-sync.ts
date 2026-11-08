/**
 * `bun run catalog:sync` — sincroniza o catálogo global de exercícios com
 * `data/exercises.json` (+ `data/legacy-exercise-map.csv`, opcional).
 *
 * Tudo numa transação só, idempotente (rodar duas vezes seguidas não muda nada
 * na segunda):
 *
 * 1. Upsert dos exercícios do arquivo por `external_id`: insere os novos,
 *    atualiza os que mudaram e limpa `archived_at` (um exercício que volta ao
 *    catálogo deixa de estar arquivado).
 * 2. Todo exercício GLOBAL (`client_id IS NULL`) fora do arquivo — inclui os
 *    legados do CSV antigo, que não têm `external_id` — sai do catálogo:
 *    - é legado (sem `external_id`) e casa com uma linha do mapa legado por
 *      (nome, body_part) → os `workout_exercise`/`workout_record_exercise` que
 *      apontam pra ele passam a apontar pro exercício novo, e o antigo é apagado;
 *    - senão, ninguém referencia → apagado;
 *    - senão → `archived_at = now()`: some de `GET /exercises`, mas continua
 *      existindo pros joins de treino/histórico.
 *
 * Exercícios custom de cliente (`client_id` não nulo) nunca são tocados.
 *
 * Flags: `--dry-run` (roda tudo e faz rollback, só pra ver os números),
 * `--allow-empty` (permite arquivo vazio, que arquivaria/apagaria o catálogo
 * global inteiro — bloqueado por padrão) e `--if-changed` (o modo do boot, ver
 * abaixo).
 *
 * Atalho do boot (`--if-changed`, `src/boot.ts`): todo sync completo grava em
 * `catalog_sync_state` o hash da entrada (arquivo + mapa legado + versão do
 * sync) e uma impressão digital dos exercícios globais do banco. Se no boot os
 * dois batem, nada mudou desde o último sync e ele é pulado — o sync completo
 * sem mudança custa ~25 idas e voltas e ~1,3 MB de upload a cada cold start
 * (3,4 s com 120 ms de latência até o banco; o atalho, 1,5 s, contando a
 * conexão). Qualquer mudança no arquivo, no código do sync
 * (CATALOG_SYNC_VERSION) ou nos exercícios globais do banco (restore de dump,
 * SQL manual: a impressão digital é um md5 do conteúdo) faz o sync completo
 * rodar. A conferência roda dentro da mesma transação, depois do
 * mesmo `pg_advisory_xact_lock`: um boot concorrente espera o sync em
 * andamento e enxerga o estado já gravado. O CLI sem flag sempre faz o sync
 * completo.
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isNull, sql as dsql } from 'drizzle-orm'
import { z } from 'zod'
import { env } from '../env.ts'
import { isValidMediaPath } from '../shared/media.ts'
import { type Tx, db, sql } from './client.ts'
import { BODY_PARTS, type BodyPart, catalogSyncState, exercise } from './schema.ts'

const DATA_DIR = fileURLToPath(new URL('../../data/', import.meta.url))
export const CATALOG_FILE = join(DATA_DIR, 'exercises.json')
export const LEGACY_MAP_FILE = join(DATA_DIR, 'legacy-exercise-map.csv')

/** Chave arbitrária e fixa do `pg_advisory_xact_lock`: dois boots simultâneos não sincronizam juntos. */
const SYNC_LOCK_KEY = 7_311_002_501

/** 11 colunas por linha → 5.500 parâmetros por INSERT, bem abaixo do limite de 65.535. */
const UPSERT_BATCH_SIZE = 500

/**
 * Entra no hash da entrada (`catalogContentHash`). Incrementar quando o sync
 * passar a gravar algo diferente para o mesmo arquivo (coluna nova, regra de
 * arquivamento...): o próximo boot faz o sync completo mesmo sem mudança no
 * `exercises.json`.
 */
export const CATALOG_SYNC_VERSION = 1

/** Linha única de `catalog_sync_state`. */
const SYNC_STATE_ID = 1

// --- Entrada ----------------------------------------------------------------

/** Texto opcional: string vazia vira NULL. */
const optionalText = z
  .string()
  .trim()
  .max(255)
  .nullish()
  .transform((v) => (v ? v : null))

const mediaPath = z
  .string()
  .trim()
  .max(512)
  .refine(isValidMediaPath, {
    message:
      'caminho de mídia inválido (relativo a MEDIA_DIR, sem "..", "/" inicial ou "\\", com extensão jpg/jpeg/png/webp/gif/svg/mp4)',
  })

const catalogItemSchema = z.object({
  externalId: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(255),
  nameEn: optionalText,
  bodyPart: z.enum(BODY_PARTS),
  equipment: optionalText,
  target: optionalText,
  secondaryMuscles: z.array(z.string().trim().min(1)).nullish().transform((v) => v ?? []),
  category: optionalText,
  instructions: z.array(z.string().trim().min(1)).nullish().transform((v) => v ?? []),
  images: z.array(mediaPath).nullish().transform((v) => v ?? []),
  video: mediaPath.nullish().transform((v) => v ?? null),
  /** Crédito exigido pela licença da mídia (CC BY-SA etc.); texto livre. */
  mediaAttribution: z
    .string()
    .trim()
    .max(5000)
    .nullish()
    .transform((v) => (v ? v : null)),
})

const catalogSchema = z.array(catalogItemSchema)

export type CatalogItem = z.infer<typeof catalogItemSchema>

export interface LegacyMapRow {
  oldName: string
  oldBodyPart: BodyPart
  externalId: string
}

export function parseCatalog(json: unknown): CatalogItem[] {
  const parsed = catalogSchema.safeParse(json)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 20)
      .map((i) => `  - [${i.path.join('.')}] ${i.message}`)
      .join('\n')
    const more = parsed.error.issues.length > 20 ? `\n  ... (+${parsed.error.issues.length - 20})` : ''
    throw new Error(`exercises.json inválido:\n${issues}${more}`)
  }

  const seen = new Set<string>()
  const duplicated = new Set<string>()
  for (const item of parsed.data) {
    if (seen.has(item.externalId)) duplicated.add(item.externalId)
    seen.add(item.externalId)
  }
  if (duplicated.size > 0) {
    throw new Error(`externalId duplicado em exercises.json: ${[...duplicated].slice(0, 20).join(', ')}`)
  }

  return parsed.data
}

/** CSV mínimo (RFC 4180): vírgula, aspas duplas com `""` de escape, CRLF ou LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false

  const input = text.replace(/^﻿/, '')
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"'
          i++
        } else {
          quoted = false
        }
      } else {
        field += ch
      }
    } else if (ch === '"') {
      quoted = true
    } else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else {
      field += ch
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  // Linhas em branco (inclusive a final) não contam.
  return rows.filter((r) => r.some((f) => f.trim().length > 0))
}

const LEGACY_MAP_HEADER = ['old_name', 'old_body_part', 'external_id']

export function parseLegacyMap(text: string): LegacyMapRow[] {
  const [header, ...rows] = parseCsv(text)
  const normalizedHeader = header?.map((h) => h.trim().toLowerCase())
  if (!normalizedHeader || normalizedHeader.join(',') !== LEGACY_MAP_HEADER.join(',')) {
    throw new Error(
      `legacy-exercise-map.csv: cabeçalho esperado "${LEGACY_MAP_HEADER.join(',')}", veio "${header?.join(',') ?? ''}"`,
    )
  }

  const result: LegacyMapRow[] = []
  const seen = new Set<string>()
  rows.forEach((fields, index) => {
    const line = index + 2
    if (fields.length !== 3) {
      throw new Error(`legacy-exercise-map.csv linha ${line}: esperava 3 colunas, veio ${fields.length}`)
    }
    const [oldName = '', oldBodyPart = '', externalId = ''] = fields.map((f) => f.trim())
    if (!oldName || !externalId) {
      throw new Error(`legacy-exercise-map.csv linha ${line}: old_name e external_id são obrigatórios`)
    }
    if (!(BODY_PARTS as readonly string[]).includes(oldBodyPart)) {
      throw new Error(`legacy-exercise-map.csv linha ${line}: old_body_part inválido "${oldBodyPart}"`)
    }
    const key = legacyKey(oldName, oldBodyPart)
    if (seen.has(key)) {
      throw new Error(`legacy-exercise-map.csv linha ${line}: (${oldName}, ${oldBodyPart}) repetido`)
    }
    seen.add(key)
    result.push({ oldName, oldBodyPart: oldBodyPart as BodyPart, externalId })
  })
  return result
}

/** Casamento tolerante a caixa/espaços (não a acentos) entre o exercício antigo e o mapa. */
function legacyKey(name: string, bodyPart: string): string {
  return `${bodyPart}::${name.trim().replace(/\s+/g, ' ').toLocaleLowerCase('pt-BR')}`
}

// --- Sync -------------------------------------------------------------------

export interface SyncSummary {
  total: number
  inserted: number
  updated: number
  unchanged: number
  /** Exercícios antigos remapeados para um do catálogo (e apagados). */
  remapped: number
  remappedWorkoutExercises: number
  remappedRecordExercises: number
  /** Fora do catálogo e sem referência → apagados. */
  deleted: number
  /** Fora do catálogo e referenciados → arquivados nesta execução. */
  archived: number
  /** Já estavam arquivados e continuam (ainda referenciados). */
  alreadyArchived: number
  /** Linhas do mapa legado cujo external_id não está no arquivo (ignoradas). */
  unresolvedMappings: string[]
  /**
   * `skipIfUnchanged` e nada mudou desde o último sync completo
   * (`catalog_sync_state`): nenhuma linha foi lida ou escrita.
   */
  skipped: boolean
}

export interface SyncOptions {
  dryRun?: boolean
  allowEmpty?: boolean
  /**
   * Hash da entrada (`catalogContentHash`). Com ele, o sync completo grava o
   * estado em `catalog_sync_state` (menos no dry run).
   */
  contentHash?: string
  /** Pula o sync se `contentHash` e a impressão digital do banco batem com o estado gravado. */
  skipIfUnchanged?: boolean
}

class DryRunRollback extends Error {}

/**
 * Hash (sha256, hex) do que define o resultado do sync: a versão do código, o
 * `exercises.json` e o mapa legado, byte a byte.
 */
export function catalogContentHash(catalogBytes: Uint8Array, legacyMapBytes: Uint8Array | null): string {
  return createHash('sha256')
    .update(`catalog-sync:v${CATALOG_SYNC_VERSION}\n`)
    .update(catalogBytes)
    .update(legacyMapBytes ? '\nlegacy-map\n' : '\nno-legacy-map\n')
    .update(legacyMapBytes ?? new Uint8Array())
    .digest('hex')
}

/**
 * Impressão digital do catálogo global no banco: quantos exercícios e o md5,
 * em ordem de id, de id + external_id + todas as colunas que o sync grava +
 * "arquivado ou não". Qualquer diferença do que o último sync completo deixou
 * (restore de dump, SQL manual, linha legada nova) muda o valor e o boot faz o
 * sync completo. Sem timestamps (o texto de `timestamptz` depende do TimeZone
 * da sessão). Custa uma leitura das ~1.300 linhas no servidor (~10–25 ms no
 * Postgres local) e volta só o hash. Função, não constante: usa
 * `SYNCED_COLUMNS`, declarado mais abaixo.
 */
function globalFingerprint() {
  const columns = ['id', 'external_id', ...SYNCED_COLUMNS, 'archived_at IS NOT NULL'].join(', ')
  return dsql.raw(`(
    SELECT count(*)::text || ':' || coalesce(md5(string_agg(row(${columns})::text, ',' ORDER BY id)), '-')
    FROM exercise WHERE client_id IS NULL
  )`)
}

/** Estado gravado (ou `null`s, sem sync completo ainda) + a impressão digital atual, numa ida só. */
async function readSyncState(tx: Tx) {
  const [row] = await tx.execute<{
    content_hash: string | null
    db_fingerprint: string | null
    current_fingerprint: string
  }>(dsql`
    SELECT s.content_hash, s.db_fingerprint, ${globalFingerprint()} AS current_fingerprint
    FROM (SELECT 1) AS one
    LEFT JOIN ${catalogSyncState} AS s ON s.id = ${SYNC_STATE_ID}`)
  return row!
}

/** Grava o estado depois de um sync completo, com a impressão digital já com as mudanças dele. */
async function writeSyncState(tx: Tx, contentHash: string) {
  await tx.execute(dsql`
    INSERT INTO ${catalogSyncState} (id, content_hash, db_fingerprint, synced_at)
    VALUES (${SYNC_STATE_ID}, ${contentHash}, ${globalFingerprint()}, now())
    ON CONFLICT (id) DO UPDATE SET
      content_hash = excluded.content_hash,
      db_fingerprint = excluded.db_fingerprint,
      synced_at = excluded.synced_at`)
}

/**
 * Coluna a coluna, com qualificação explícita: dentro de `ON CONFLICT DO
 * UPDATE`, `"exercise".x` é a linha existente e `excluded.x` a proposta.
 * Linha idêntica (e não arquivada) não é reescrita — sem isso cada boot do
 * container regravaria milhares de linhas à toa.
 */
const SYNCED_COLUMNS = [
  'name',
  'name_en',
  'body_part',
  'equipment',
  'target',
  'secondary_muscles',
  'category',
  'instructions',
  'images',
  'video',
  'media_attribution',
] as const

const ROW_CHANGED = dsql.raw(
  `(${SYNCED_COLUMNS.map((c) => `"exercise"."${c}"`).join(', ')}) IS DISTINCT FROM ` +
    `(${SYNCED_COLUMNS.map((c) => `excluded."${c}"`).join(', ')}) ` +
    `OR "exercise"."archived_at" IS NOT NULL`,
)

function excluded(column: (typeof SYNCED_COLUMNS)[number]) {
  return dsql.raw(`excluded."${column}"`)
}

export async function syncCatalog(
  items: CatalogItem[],
  legacyMap: LegacyMapRow[],
  options: SyncOptions = {},
): Promise<SyncSummary> {
  if (items.length === 0 && !options.allowEmpty) {
    throw new Error(
      'exercises.json está vazio: isso arquivaria/apagaria o catálogo global inteiro. Use --allow-empty se for isso mesmo.',
    )
  }

  const summary: SyncSummary = {
    total: items.length,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    remapped: 0,
    remappedWorkoutExercises: 0,
    remappedRecordExercises: 0,
    deleted: 0,
    archived: 0,
    alreadyArchived: 0,
    unresolvedMappings: [],
    skipped: false,
  }

  const { contentHash } = options
  try {
    await db.transaction(async (tx) => {
      await tx.execute(dsql`SELECT pg_advisory_xact_lock(${SYNC_LOCK_KEY})`)

      // 0. Atalho do boot: depois do lock, para um boot concorrente ver o
      // estado que o sync em andamento acabou de gravar.
      if (options.skipIfUnchanged && contentHash && !options.dryRun) {
        const state = await readSyncState(tx)
        if (state.content_hash === contentHash && state.db_fingerprint === state.current_fingerprint) {
          summary.skipped = true
          summary.unchanged = items.length
          return
        }
      }

      // 1. Upsert em lotes.
      for (let i = 0; i < items.length; i += UPSERT_BATCH_SIZE) {
        const batch = items.slice(i, i + UPSERT_BATCH_SIZE)
        const written = await tx
          .insert(exercise)
          .values(
            batch.map((item) => ({
              externalId: item.externalId,
              name: item.name,
              nameEn: item.nameEn,
              bodyPart: item.bodyPart,
              equipment: item.equipment,
              target: item.target,
              secondaryMuscles: item.secondaryMuscles,
              category: item.category,
              instructions: item.instructions,
              images: item.images,
              video: item.video,
              mediaAttribution: item.mediaAttribution,
              clientId: null,
            })),
          )
          .onConflictDoUpdate({
            target: exercise.externalId,
            set: {
              name: excluded('name'),
              nameEn: excluded('name_en'),
              bodyPart: excluded('body_part'),
              equipment: excluded('equipment'),
              target: excluded('target'),
              secondaryMuscles: excluded('secondary_muscles'),
              category: excluded('category'),
              instructions: excluded('instructions'),
              images: excluded('images'),
              video: excluded('video'),
              mediaAttribution: excluded('media_attribution'),
              archivedAt: dsql`NULL`,
              updatedAt: dsql`now()`,
            },
            setWhere: ROW_CHANGED,
          })
          // `xmax = 0` só na linha recém-inserida; numa atualizada é o id da transação.
          .returning({ inserted: dsql<boolean>`(xmax = 0)` })

        for (const row of written) {
          if (row.inserted) summary.inserted += 1
          else summary.updated += 1
        }
      }
      summary.unchanged = items.length - summary.inserted - summary.updated

      // 2. Exercícios globais fora do arquivo.
      const globals = await tx
        .select({
          id: exercise.id,
          externalId: exercise.externalId,
          name: exercise.name,
          bodyPart: exercise.bodyPart,
        })
        .from(exercise)
        .where(isNull(exercise.clientId))

      const inCatalog = new Set(items.map((item) => item.externalId))
      const idByExternalId = new Map<string, number>()
      for (const row of globals) {
        if (row.externalId && inCatalog.has(row.externalId)) idByExternalId.set(row.externalId, row.id)
      }

      const targetByLegacyKey = new Map<string, number>()
      for (const entry of legacyMap) {
        const targetId = idByExternalId.get(entry.externalId)
        if (targetId === undefined) {
          summary.unresolvedMappings.push(`${entry.oldName} (${entry.oldBodyPart}) → ${entry.externalId}`)
          continue
        }
        targetByLegacyKey.set(legacyKey(entry.oldName, entry.oldBodyPart), targetId)
      }

      const stale = globals.filter((row) => !row.externalId || !inCatalog.has(row.externalId))

      const remaps: { old_id: number; new_id: number }[] = []
      const unmapped: number[] = []
      for (const row of stale) {
        // O mapa legado vale só para os exercícios antigos, sem `external_id`.
        // Um exercício do catálogo que saiu do arquivo é arquivado/apagado, nunca
        // remapeado por nome: "Panturrilha no leg press" (1391) casa com a linha
        // legada "Panturrilha no Leg Press" → 0738, e o histórico de quem usa o
        // 1391 passaria a apontar para outro exercício sem ninguém pedir.
        const targetId = row.externalId ? undefined : targetByLegacyKey.get(legacyKey(row.name, row.bodyPart))
        if (targetId !== undefined) remaps.push({ old_id: row.id, new_id: targetId })
        else unmapped.push(row.id)
      }

      // Listas de ids viajam como UM parâmetro jsonb, não como milhares de `$n`.
      //
      // Trava as linhas que vão ser remapeadas/apagadas ANTES de mexer nelas: a
      // API ainda no ar (a versão anterior, durante o deploy) pode estar
      // inserindo um `workout_exercise`/`workout_record_exercise` que aponta
      // para uma delas. Sem o lock, essa referência nova escapava do UPDATE de
      // remap / do NOT EXISTS e o DELETE estourava a FK, abortando o sync (e o
      // boot). Com ele, o sync espera o insert que já tinha travado a linha (e
      // a referência nova fica visível para os comandos seguintes, que então
      // arquivam em vez de apagar); um insert que chega depois espera o commit.
      const staleIds = stale.map((row) => row.id)
      if (staleIds.length > 0) {
        await tx.execute(dsql`
          SELECT id FROM exercise
          WHERE client_id IS NULL
            AND id IN (SELECT jsonb_array_elements_text(${JSON.stringify(staleIds)}::jsonb)::bigint)
          FOR UPDATE`)
      }

      if (remaps.length > 0) {
        const pairs = JSON.stringify(remaps)
        const we = await tx.execute(dsql`
          UPDATE workout_exercise AS t SET exercise_id = m.new_id, updated_at = now()
          FROM jsonb_to_recordset(${pairs}::jsonb) AS m(old_id bigint, new_id bigint)
          WHERE t.exercise_id = m.old_id`)
        const wre = await tx.execute(dsql`
          UPDATE workout_record_exercise AS t SET exercise_id = m.new_id, updated_at = now()
          FROM jsonb_to_recordset(${pairs}::jsonb) AS m(old_id bigint, new_id bigint)
          WHERE t.exercise_id = m.old_id`)
        const removed = await tx.execute(dsql`
          DELETE FROM exercise
          WHERE client_id IS NULL
            AND id IN (SELECT old_id FROM jsonb_to_recordset(${pairs}::jsonb) AS m(old_id bigint, new_id bigint))`)
        summary.remappedWorkoutExercises = we.count
        summary.remappedRecordExercises = wre.count
        summary.remapped = removed.count
      }

      if (unmapped.length > 0) {
        const ids = JSON.stringify(unmapped)
        const removed = await tx.execute(dsql`
          DELETE FROM exercise AS e
          WHERE e.client_id IS NULL
            AND e.id IN (SELECT jsonb_array_elements_text(${ids}::jsonb)::bigint)
            AND NOT EXISTS (SELECT 1 FROM workout_exercise WHERE exercise_id = e.id)
            AND NOT EXISTS (SELECT 1 FROM workout_record_exercise WHERE exercise_id = e.id)`)
        summary.deleted = removed.count

        const archived = await tx.execute(dsql`
          UPDATE exercise SET archived_at = now(), updated_at = now()
          WHERE client_id IS NULL
            AND archived_at IS NULL
            AND id IN (SELECT jsonb_array_elements_text(${ids}::jsonb)::bigint)`)
        summary.archived = archived.count
        summary.alreadyArchived = unmapped.length - summary.deleted - summary.archived
      }

      if (options.dryRun) throw new DryRunRollback()

      // Na mesma transação: o estado só existe se o sync inteiro commitou.
      if (contentHash) await writeSyncState(tx, contentHash)
    })
  } catch (err) {
    if (!(err instanceof DryRunRollback)) throw err
  }

  return summary
}

/** Avisa (sem falhar) sobre caminhos de mídia que não existem em MEDIA_DIR. */
function reportMissingMedia(items: CatalogItem[]) {
  const root = resolve(env.MEDIA_DIR)
  if (!existsSync(root)) {
    console.warn(`catalog:sync: MEDIA_DIR (${root}) não existe; verificação de mídia pulada.`)
    return
  }
  // Um arquivo pode ser compartilhado entre exercícios: conta cada caminho uma vez só.
  const paths = [...new Set(items.flatMap((item) => (item.video ? [...item.images, item.video] : item.images)))]
  const missing = paths.filter((p) => !existsSync(join(root, p)))
  if (missing.length > 0) {
    console.warn(
      `catalog:sync: ${missing.length} de ${paths.length} arquivos de mídia não existem em ${root} ` +
        `(ex.: ${missing.slice(0, 5).join(', ')}). Eles vão responder 404 até o volume ser preenchido.`,
    )
  }
}

export function formatSummary(s: SyncSummary, dryRun = false): string {
  if (s.skipped) {
    return (
      `catalog:sync: ${s.total} exercícios no arquivo — sem mudança desde o último sync completo ` +
      `(mesmo hash e banco intacto), pulado. \`bun run catalog:sync\` força o sync completo.`
    )
  }
  const lines = [
    `catalog:sync${dryRun ? ' (DRY RUN — rollback, nada gravado)' : ''}: ${s.total} exercícios no arquivo`,
    `  inseridos=${s.inserted} atualizados=${s.updated} sem_mudança=${s.unchanged}`,
    `  remapeados=${s.remapped} (workout_exercise=${s.remappedWorkoutExercises}, workout_record_exercise=${s.remappedRecordExercises})`,
    `  apagados=${s.deleted} arquivados=${s.archived} já_arquivados=${s.alreadyArchived}`,
  ]
  if (s.unresolvedMappings.length > 0) {
    lines.push(
      `  AVISO: ${s.unresolvedMappings.length} linha(s) do mapa legado apontam para external_id fora do arquivo (ignoradas): ` +
        s.unresolvedMappings.slice(0, 10).join('; '),
    )
  }
  return lines.join('\n')
}

/**
 * Lê os arquivos padrão de `data/` e sincroniza. Usado pelo CLI e por
 * `src/boot.ts` (com `skipIfUnchanged`).
 */
export async function runCatalogSync(
  options: Pick<SyncOptions, 'dryRun' | 'allowEmpty' | 'skipIfUnchanged'> = {},
) {
  const catalogBytes = await Bun.file(CATALOG_FILE).bytes()
  const items = parseCatalog(JSON.parse(new TextDecoder().decode(catalogBytes)))
  const legacyMapFile = Bun.file(LEGACY_MAP_FILE)
  const legacyMapBytes = (await legacyMapFile.exists()) ? await legacyMapFile.bytes() : null
  const legacyMap = legacyMapBytes ? parseLegacyMap(new TextDecoder().decode(legacyMapBytes)) : []
  const contentHash = catalogContentHash(catalogBytes, legacyMapBytes)

  reportMissingMedia(items)

  const started = performance.now()
  const summary = await syncCatalog(items, legacyMap, { ...options, contentHash })
  console.log(formatSummary(summary, options.dryRun))
  console.log(
    `  (${Math.round(performance.now() - started)} ms, mapa legado: ${legacyMap.length} linha(s), ` +
      `hash ${contentHash.slice(0, 12)})`,
  )
  return summary
}

if (import.meta.main) {
  try {
    await runCatalogSync({
      dryRun: process.argv.includes('--dry-run'),
      allowEmpty: process.argv.includes('--allow-empty'),
      skipIfUnchanged: process.argv.includes('--if-changed'),
    })
  } finally {
    await sql.end()
  }
}
