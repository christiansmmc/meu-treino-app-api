import { and, asc, desc, eq, gte, inArray, isNull, or } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { loggedClient, requireAuth, requireUserRole } from '../auth/middleware.ts'
import { db } from '../db/client.ts'
import {
  RECORD_EXERCISE_STATUS,
  exercise,
  workout,
  workoutRecord,
  workoutRecordExercise,
  workoutRecordExerciseSet,
} from '../db/schema.ts'
import { AppError, ErrorType, argumentTypeMismatch } from '../shared/errors.ts'
import { exerciseLoadSchema } from '../shared/schemas.ts'
import { startOfMonthInAppTimezone, toLocalDate, toNumber } from '../shared/serialize.ts'
import { parseBody, parseIdParam } from '../shared/validate.ts'
import type { AuthVariables, ClientRow } from '../types.ts'
import { findOwnedWorkout } from './workouts.routes.ts'

const PERIODS = ['CURRENT_MONTH', 'LAST_3_MONTHS', 'ALL', 'LAST'] as const

const createSchema = z.object({
  workoutId: z.number().int().positive(),
  exercises: z.array(
    z.object({
      exerciseId: z.number().int().positive(),
      status: z.enum(RECORD_EXERCISE_STATUS),
      note: z.string().nullish(),
      exerciseSets: z
        .array(
          z.object({
            set: z.number().int(),
            reps: z.number().int().nullish(),
            exerciseLoad: exerciseLoadSchema.nullish(),
            note: z.string().nullish(),
          }),
        )
        .nullish(),
    }),
  ),
})

export const workoutRecordRoutes = new Hono<AuthVariables>()

workoutRecordRoutes.use('*', requireAuth, requireUserRole)

/** Monta o payload "full detail" — mesmo shape do `WorkoutRecordToFindWorkoutRecordVM`. */
async function buildDetail(recordId: number) {
  const [record] = await db
    .select({
      id: workoutRecord.id,
      createdAt: workoutRecord.createdAt,
      workoutId: workout.id,
      workoutName: workout.name,
    })
    .from(workoutRecord)
    .innerJoin(workout, eq(workout.id, workoutRecord.workoutId))
    .where(eq(workoutRecord.id, recordId))
    .limit(1)

  if (!record) return null

  const exercises = await db
    .select({
      id: workoutRecordExercise.id,
      note: workoutRecordExercise.note,
      status: workoutRecordExercise.status,
      exerciseId: exercise.id,
      exerciseName: exercise.name,
      bodyPart: exercise.bodyPart,
    })
    .from(workoutRecordExercise)
    .innerJoin(exercise, eq(exercise.id, workoutRecordExercise.exerciseId))
    .where(eq(workoutRecordExercise.workoutRecordId, record.id))
    .orderBy(asc(workoutRecordExercise.id))

  const sets =
    exercises.length === 0
      ? []
      : await db
          .select({
            id: workoutRecordExerciseSet.id,
            set: workoutRecordExerciseSet.setNumber,
            reps: workoutRecordExerciseSet.reps,
            exerciseLoad: workoutRecordExerciseSet.exerciseLoad,
            note: workoutRecordExerciseSet.note,
            parentId: workoutRecordExerciseSet.workoutRecordExerciseId,
          })
          .from(workoutRecordExerciseSet)
          .innerJoin(
            workoutRecordExercise,
            eq(workoutRecordExercise.id, workoutRecordExerciseSet.workoutRecordExerciseId),
          )
          .where(eq(workoutRecordExercise.workoutRecordId, record.id))
          .orderBy(asc(workoutRecordExerciseSet.setNumber), asc(workoutRecordExerciseSet.id))

  const setsByExercise = new Map<number, typeof sets>()
  for (const set of sets) {
    const list = setsByExercise.get(set.parentId) ?? []
    list.push(set)
    setsByExercise.set(set.parentId, list)
  }

  return {
    id: record.id,
    date: toLocalDate(record.createdAt),
    workout: { id: record.workoutId, name: record.workoutName },
    workoutRecordExercises: exercises.map((ex) => ({
      id: ex.id,
      note: ex.note,
      status: ex.status,
      exercise: { id: ex.exerciseId, name: ex.exerciseName, bodyPart: ex.bodyPart },
      workoutRecordExerciseSets: (setsByExercise.get(ex.id) ?? []).map((s) => ({
        id: s.id,
        set: s.set,
        reps: s.reps,
        exerciseLoad: toNumber(s.exerciseLoad),
        note: s.note,
      })),
    })),
  }
}

/**
 * Igual à mesma checagem em `workouts.routes.ts` e `workout-exercises.routes.ts`:
 * exercício global (`clientId` nulo) ou do próprio cliente. Sem isso, qualquer
 * cliente autenticado podia anexar o `exerciseId` de outro (bigserial
 * sequencial) a um registro do seu próprio treino — vazando o nome do
 * exercício alheio no corpo 201 de `POST /workout-record` e em
 * `GET /workout-record/last` (ambos montados por `buildDetail`) e, pior,
 * criando uma FK que `DELETE /clients` não consegue apagar quando o dono do
 * exercício sai.
 */
async function assertExercisesExist(client: ClientRow, ids: number[]) {
  if (ids.length === 0) return
  const rows = await db
    .select({ id: exercise.id })
    .from(exercise)
    .where(
      and(
        inArray(exercise.id, ids),
        or(isNull(exercise.clientId), eq(exercise.clientId, client.id)),
      ),
    )

  const found = new Set(rows.map((r) => r.id))
  for (const id of ids) {
    if (!found.has(id)) throw new AppError(ErrorType.EXERCISE_NOT_FOUND, 404)
  }
}

workoutRecordRoutes.post('/', async (c) => {
  const client = loggedClient(c)
  const vm = await parseBody(c, createSchema)

  await findOwnedWorkout(client, vm.workoutId, ErrorType.WORKOUT_NOT_FOUND)
  await assertExercisesExist(
    client,
    vm.exercises.map((e) => e.exerciseId),
  )

  const recordId = await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(workoutRecord)
      .values({
        workoutId: vm.workoutId,
        createdAt: new Date(),
      })
      .returning({ id: workoutRecord.id })

    const id = inserted!.id

    for (const ex of vm.exercises) {
      const [insertedExercise] = await tx
        .insert(workoutRecordExercise)
        .values({
          note: ex.note ?? null,
          status: ex.status,
          exerciseId: ex.exerciseId,
          workoutRecordId: id,
        })
        .returning({ id: workoutRecordExercise.id })

      const sets = ex.exerciseSets ?? []
      if (sets.length > 0) {
        await tx.insert(workoutRecordExerciseSet).values(
          sets.map((set) => ({
            setNumber: set.set,
            reps: set.reps ?? null,
            exerciseLoad: set.exerciseLoad != null ? String(set.exerciseLoad) : null,
            note: set.note ?? null,
            workoutRecordExerciseId: insertedExercise!.id,
          })),
        )
      }
    }

    return id
  })

  const detail = await buildDetail(recordId)

  c.header('Location', '/api/workout-record')
  return c.json(detail, 201)
})

workoutRecordRoutes.get('/simple', async (c) => {
  const client = loggedClient(c)

  const workoutIdParam = c.req.query('workoutId')
  const periodParam = c.req.query('period')

  let workoutId: number | null = null
  if (workoutIdParam !== undefined && workoutIdParam !== '') {
    workoutId = parseIdParam(workoutIdParam)
    if (workoutId === null) return argumentTypeMismatch(c)
  }

  if (periodParam !== undefined && periodParam !== '') {
    if (!(PERIODS as readonly string[]).includes(periodParam)) return argumentTypeMismatch(c)
  }

  const filters = [
    eq(workout.clientId, client.id),
    isNull(workout.deletedAt),
    isNull(workoutRecord.deletedAt),
  ]

  if (workoutId !== null) filters.push(eq(workout.id, workoutId))

  // `LAST` e `ALL` não restringem a data — mesmo comportamento do Java.
  if (periodParam === 'CURRENT_MONTH') {
    filters.push(gte(workoutRecord.createdAt, startOfMonthInAppTimezone(0)))
  } else if (periodParam === 'LAST_3_MONTHS') {
    filters.push(gte(workoutRecord.createdAt, startOfMonthInAppTimezone(3)))
  }

  const rows = await db
    .select({
      id: workoutRecord.id,
      createdAt: workoutRecord.createdAt,
      workoutId: workout.id,
      workoutName: workout.name,
      workoutListOrder: workout.listOrder,
    })
    .from(workoutRecord)
    .innerJoin(workout, eq(workout.id, workoutRecord.workoutId))
    .where(and(...filters))
    .orderBy(desc(workoutRecord.createdAt), desc(workoutRecord.id))

  return c.json(
    rows.map((row) => ({
      id: row.id,
      date: toLocalDate(row.createdAt),
      workout: { id: row.workoutId, name: row.workoutName, listOrder: row.workoutListOrder },
    })),
  )
})

workoutRecordRoutes.get('/last', async (c) => {
  const client = loggedClient(c)

  const workoutId = parseIdParam(c.req.query('workoutId'))
  if (workoutId === null) return argumentTypeMismatch(c)

  await findOwnedWorkout(client, workoutId, ErrorType.WORKOUT_NOT_FOUND)

  const [last] = await db
    .select({ id: workoutRecord.id })
    .from(workoutRecord)
    .where(and(eq(workoutRecord.workoutId, workoutId), isNull(workoutRecord.deletedAt)))
    // `id` desempata sessões do mesmo instante.
    .orderBy(desc(workoutRecord.createdAt), desc(workoutRecord.id))
    .limit(1)

  // Sem registros: 200 com corpo `null` literal — não 204, não 404.
  if (!last) return c.json(null)

  return c.json(await buildDetail(last.id))
})

workoutRecordRoutes.delete('/:id', async (c) => {
  const client = loggedClient(c)
  const id = parseIdParam(c.req.param('id'))
  if (id === null) return argumentTypeMismatch(c)

  const [row] = await db
    .select({ id: workoutRecord.id, clientId: workout.clientId })
    .from(workoutRecord)
    .innerJoin(workout, eq(workout.id, workoutRecord.workoutId))
    .where(and(eq(workoutRecord.id, id), isNull(workoutRecord.deletedAt)))
    .limit(1)

  if (!row) throw new AppError(ErrorType.WORKOUT_NOT_FOUND, 400)
  AppError.throwIfNot(row.clientId === client.id, ErrorType.WORKOUT_NOT_FOUND)

  await db
    .update(workoutRecord)
    .set({ deletedAt: new Date() })
    .where(eq(workoutRecord.id, row.id))

  return c.body(null, 204)
})
