import { and, eq, inArray, isNull, or } from 'drizzle-orm'
import { Hono } from 'hono'
import { loggedClient, requireAuth, requireUserRole } from '../auth/middleware.ts'
import { db } from '../db/client.ts'
import { BODY_PARTS, type BodyPart, exercise } from '../db/schema.ts'
import { AppError, ErrorType, argumentTypeMismatch } from '../shared/errors.ts'
import { exerciseFirstImage, mediaUrl, mediaUrls } from '../shared/media.ts'
import { parseIdParam } from '../shared/validate.ts'
import type { AuthVariables } from '../types.ts'

export const exerciseRoutes = new Hono<AuthVariables>()

exerciseRoutes.use('*', requireAuth, requireUserRole)

/**
 * Ordenação em JS com collation pt-BR (acentos/maiúsculas não bagunçam a
 * ordem: "Abdominal", "Agachamento", "Árvore"...). Não dá pra confiar na
 * collation do banco: o default do Postgres local (en_US) e o do Neon (C.UTF-8)
 * ordenam diferente, e uma collation ICU explícita depende do build.
 */
const collator = new Intl.Collator('pt-BR', { sensitivity: 'base', numeric: true })

exerciseRoutes.get('/', async (c) => {
  const client = loggedClient(c)

  const raw = c.req.queries('body_part') ?? []
  const invalid = raw.filter((v) => !(BODY_PARTS as readonly string[]).includes(v))
  if (invalid.length > 0) {
    // Mesmo comportamento do `MethodArgumentTypeMismatchException` do Spring.
    return argumentTypeMismatch(c)
  }
  const bodyParts = raw as BodyPart[]

  // Catálogo global (client_id NULL) + exercícios custom do próprio cliente,
  // sem os arquivados (saíram do catálogo; só existem para o histórico).
  const filters = [
    or(isNull(exercise.clientId), eq(exercise.clientId, client.id)),
    isNull(exercise.archivedAt),
  ]
  if (bodyParts.length > 0) filters.push(inArray(exercise.bodyPart, bodyParts))

  const rows = await db
    .select({
      id: exercise.id,
      name: exercise.name,
      bodyPart: exercise.bodyPart,
      equipment: exercise.equipment,
      target: exercise.target,
      image: exerciseFirstImage,
    })
    .from(exercise)
    .where(and(...filters))

  rows.sort((a, b) => collator.compare(a.name, b.name) || a.id - b.id)

  return c.json(
    rows.map((row) => ({
      id: row.id,
      name: row.name,
      bodyPart: row.bodyPart,
      equipment: row.equipment,
      target: row.target,
      imageUrl: mediaUrl(row.image),
    })),
  )
})

/** Detalhe — inclui arquivados (o histórico pode linkar pra eles). */
exerciseRoutes.get('/:id', async (c) => {
  const client = loggedClient(c)
  const id = parseIdParam(c.req.param('id'))
  if (id === null) return argumentTypeMismatch(c)

  // Mesma regra de acesso de `shared/exercise-access.ts`: global ou do próprio cliente.
  const [row] = await db
    .select()
    .from(exercise)
    .where(
      and(eq(exercise.id, id), or(isNull(exercise.clientId), eq(exercise.clientId, client.id))),
    )
    .limit(1)

  if (!row) throw new AppError(ErrorType.EXERCISE_NOT_FOUND, 404)

  const images = mediaUrls(row.images)

  return c.json({
    id: row.id,
    name: row.name,
    nameEn: row.nameEn,
    bodyPart: row.bodyPart,
    equipment: row.equipment,
    target: row.target,
    secondaryMuscles: row.secondaryMuscles ?? [],
    category: row.category,
    instructions: row.instructions ?? [],
    images,
    videoUrl: mediaUrl(row.video),
    imageUrl: images[0] ?? null,
    // Crédito da licença das imagens (CC BY-SA): o app exibe junto da mídia.
    mediaAttribution: row.mediaAttribution,
  })
})
