import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { loggedClient, requireAuth, requireUserRole } from '../auth/middleware.ts'
import { db } from '../db/client.ts'
import { workout, workoutExercise } from '../db/schema.ts'
import { toNumber } from '../shared/serialize.ts'
import type { AuthVariables } from '../types.ts'

const MAX_EXERCISE_IDS = 100

/** `?exerciseIds=588,845` → ids distintos, na ordem pedida. */
const exerciseIdsSchema = z
  .string({ required_error: 'exerciseIds é obrigatório' })
  .regex(/^\d+(,\d+)*$/, 'exerciseIds deve ser uma lista de ids separados por vírgula')
  .transform((value) => [...new Set(value.split(',').map(Number))])
  .refine((ids) => ids.length <= MAX_EXERCISE_IDS, `no máximo ${MAX_EXERCISE_IDS} ids`)

interface ExerciseLoadEntry {
  workoutExerciseId: number
  workoutId: number
  workoutName: string
  load: number | null
  loadUpdatedAt: string | null
}

export const exerciseLoadRoutes = new Hono<AuthVariables>()

exerciseLoadRoutes.use('*', requireAuth, requireUserRole)

/**
 * A carga de cada exercício pedido em todos os treinos ativos do cliente.
 * Um item por id pedido, na ordem pedida (`entries: []` quando o exercício não
 * está em treino nenhum). As entradas vêm da carga mudada por último para a
 * mais antiga; as que nunca tiveram carga ficam no fim.
 */
exerciseLoadRoutes.get('/', async (c) => {
  const client = loggedClient(c)
  const exerciseIds = exerciseIdsSchema.parse(c.req.query('exerciseIds'))

  const rows = await db
    .select({
      exerciseId: workoutExercise.exerciseId,
      workoutExerciseId: workoutExercise.id,
      workoutId: workout.id,
      workoutName: workout.name,
      load: workoutExercise.exerciseLoad,
      loadUpdatedAt: workoutExercise.loadUpdatedAt,
    })
    .from(workoutExercise)
    .innerJoin(workout, eq(workout.id, workoutExercise.workoutId))
    .where(
      and(
        eq(workout.clientId, client.id),
        isNull(workout.deletedAt),
        inArray(workoutExercise.exerciseId, exerciseIds),
      ),
    )
    .orderBy(sql`${workoutExercise.loadUpdatedAt} desc nulls last`, desc(workoutExercise.id))

  const byExercise = new Map<number, ExerciseLoadEntry[]>()
  for (const row of rows) {
    const list = byExercise.get(row.exerciseId) ?? []
    list.push({
      workoutExerciseId: row.workoutExerciseId,
      workoutId: row.workoutId,
      workoutName: row.workoutName,
      load: toNumber(row.load),
      loadUpdatedAt: row.loadUpdatedAt?.toISOString() ?? null,
    })
    byExercise.set(row.exerciseId, list)
  }

  return c.json(exerciseIds.map((exerciseId) => ({ exerciseId, entries: byExercise.get(exerciseId) ?? [] })))
})
