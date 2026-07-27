import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { loggedClient, requireAuth, requireUserRole } from '../auth/middleware.ts'
import { db } from '../db/client.ts'
import { BODY_PARTS, type BodyPart, exercise } from '../db/schema.ts'
import { argumentTypeMismatch } from '../shared/errors.ts'
import type { AuthVariables } from '../types.ts'

export const exerciseRoutes = new Hono<AuthVariables>()

exerciseRoutes.use('*', requireAuth, requireUserRole)

exerciseRoutes.get('/', async (c) => {
  const client = loggedClient(c)

  const raw = c.req.queries('body_part') ?? []
  const invalid = raw.filter((v) => !(BODY_PARTS as readonly string[]).includes(v))
  if (invalid.length > 0) {
    // Mesmo comportamento do `MethodArgumentTypeMismatchException` do Spring.
    return argumentTypeMismatch(c)
  }
  const bodyParts = raw as BodyPart[]

  // Catálogo global (client_id NULL) + exercícios custom do próprio cliente.
  const visible = or(isNull(exercise.clientId), eq(exercise.clientId, client.id))

  const where =
    bodyParts.length > 0 ? and(visible, inArray(exercise.bodyPart, bodyParts)) : visible

  const rows = await db
    .select({ id: exercise.id, name: exercise.name, bodyPart: exercise.bodyPart })
    .from(exercise)
    .where(where)
    // O Java ordenava por `body_part` (VARCHAR) — ordem alfabética; `id` desempata.
    .orderBy(sql`CAST(${exercise.bodyPart} AS CHAR)`, asc(exercise.id))

  return c.json(rows)
})
