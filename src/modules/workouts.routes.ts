import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { loggedClient, requireAuth, requireUserRole } from '../auth/middleware.ts'
import { db } from '../db/client.ts'
import { exercise, workout, workoutExercise } from '../db/schema.ts'
import {
  AppError,
  ErrorType,
  type ErrorTypeEntry,
  argumentTypeMismatch,
} from '../shared/errors.ts'
import { toNumber } from '../shared/serialize.ts'
import { parseBody, parseIdParam } from '../shared/validate.ts'
import type { AuthVariables, ClientRow } from '../types.ts'

const createWorkoutSchema = z.object({
  workoutName: z.string().trim().min(1),
  exercises: z
    .array(
      z.object({
        exerciseId: z.number().int().positive(),
        sets: z.number().int().nullish(),
        reps: z.number().int().nullish(),
        // No POST o campo é `load`; na resposta é `exerciseLoad` (inconsistência herdada).
        load: z.number().nullish(),
      }),
    )
    .min(1),
})

const updateWorkoutSchema = z.object({
  name: z.string().trim().min(1),
})

const listOrderSchema = z.array(
  z.object({
    id: z.number().int().positive(),
    listOrder: z.number().int(),
  }),
)

export const workoutRoutes = new Hono<AuthVariables>()

workoutRoutes.use('*', requireAuth, requireUserRole)

/** `WorkoutService.findById` + checagem de ownership do `WorkoutContext`. */
export async function findOwnedWorkout(
  client: ClientRow,
  id: number,
  ownershipError: ErrorTypeEntry = ErrorType.CLIENT_DONT_HAVE_ACCESS,
) {
  const [found] = await db
    .select()
    .from(workout)
    .where(and(eq(workout.id, id), isNull(workout.deletedAt)))
    .limit(1)

  if (!found) throw new AppError(ErrorType.WORKOUT_NOT_FOUND, 404)
  AppError.throwIfNot(found.clientId === client.id, ownershipError)

  return found
}

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

workoutRoutes.get('/', async (c) => {
  const client = loggedClient(c)

  const workouts = await db
    .select({ id: workout.id, name: workout.name, listOrder: workout.listOrder })
    .from(workout)
    .where(and(eq(workout.clientId, client.id), isNull(workout.deletedAt)))
    .orderBy(asc(workout.listOrder), asc(workout.id))

  if (workouts.length === 0) return c.json([])

  const rows = await db
    .select({
      workoutId: workoutExercise.workoutId,
      bodyPart: exercise.bodyPart,
    })
    .from(workoutExercise)
    .innerJoin(exercise, eq(exercise.id, workoutExercise.exerciseId))
    .where(
      inArray(
        workoutExercise.workoutId,
        workouts.map((w) => w.id),
      ),
    )

  const counters = new Map<number, { count: number; bodyParts: Set<string> }>()
  for (const row of rows) {
    const entry = counters.get(row.workoutId) ?? { count: 0, bodyParts: new Set<string>() }
    entry.count += 1
    entry.bodyParts.add(row.bodyPart)
    counters.set(row.workoutId, entry)
  }

  return c.json(
    workouts.map((w) => {
      const entry = counters.get(w.id)
      return {
        id: w.id,
        name: w.name,
        listOrder: w.listOrder,
        exerciseCount: entry?.count ?? 0,
        bodyParts: entry ? [...entry.bodyParts] : [],
      }
    }),
  )
})

workoutRoutes.post('/', async (c) => {
  const client = loggedClient(c)
  const vm = await parseBody(c, createWorkoutSchema)

  await assertExercisesExist(
    client,
    vm.exercises.map((e) => e.exerciseId),
  )

  const [maxOrder] = await db
    .select({ value: sql<number | null>`MAX(${workout.listOrder})` })
    .from(workout)
    .where(and(eq(workout.clientId, client.id), isNull(workout.deletedAt)))

  const listOrder = maxOrder?.value === null || maxOrder?.value === undefined ? 0 : maxOrder.value + 1

  const id = await db.transaction(async (tx) => {
    const [inserted] = await tx.insert(workout).values({
      name: vm.workoutName,
      listOrder,
      clientId: client.id,
    })

    const workoutId = inserted.insertId

    await tx.insert(workoutExercise).values(
      vm.exercises.map((e, index) => ({
        sets: e.sets ?? null,
        reps: e.reps ?? null,
        exerciseLoad: e.load != null ? String(e.load) : null,
        listOrder: index,
        workoutId,
        exerciseId: e.exerciseId,
      })),
    )

    return workoutId
  })

  c.header('Location', `/api/workouts/${id}`)
  return c.json({ id }, 201)
})

// Precisa vir antes de `/:id` para não ser capturada como path param.
workoutRoutes.patch('/list-order', async (c) => {
  const client = loggedClient(c)
  const dtos = await parseBody(c, listOrderSchema)

  await db.transaction(async (tx) => {
    for (const dto of dtos) {
      const owned = await findOwnedWorkout(client, dto.id)
      await tx
        .update(workout)
        .set({ listOrder: dto.listOrder })
        .where(eq(workout.id, owned.id))
    }
  })

  return c.body(null, 200)
})

workoutRoutes.get('/:id', async (c) => {
  const client = loggedClient(c)
  const id = parseIdParam(c.req.param('id'))
  if (id === null) return argumentTypeMismatch(c)

  const owned = await findOwnedWorkout(client, id)

  const rows = await db
    .select({
      id: workoutExercise.id,
      sets: workoutExercise.sets,
      reps: workoutExercise.reps,
      exerciseLoad: workoutExercise.exerciseLoad,
      listOrder: workoutExercise.listOrder,
      exerciseId: exercise.id,
      exerciseName: exercise.name,
      bodyPart: exercise.bodyPart,
    })
    .from(workoutExercise)
    .innerJoin(exercise, eq(exercise.id, workoutExercise.exerciseId))
    .where(eq(workoutExercise.workoutId, owned.id))
    .orderBy(asc(workoutExercise.listOrder), asc(workoutExercise.id))

  return c.json({
    id: owned.id,
    name: owned.name,
    workoutExercises: rows.map((row) => ({
      id: row.id,
      sets: row.sets,
      reps: row.reps,
      exerciseLoad: toNumber(row.exerciseLoad),
      listOrder: row.listOrder,
      exercise: {
        id: row.exerciseId,
        name: row.exerciseName,
        bodyPart: row.bodyPart,
      },
    })),
  })
})

workoutRoutes.patch('/:id', async (c) => {
  const client = loggedClient(c)
  const id = parseIdParam(c.req.param('id'))
  if (id === null) return argumentTypeMismatch(c)

  const dto = await parseBody(c, updateWorkoutSchema)
  const owned = await findOwnedWorkout(client, id)

  await db.update(workout).set({ name: dto.name }).where(eq(workout.id, owned.id))

  return c.body(null, 200)
})

workoutRoutes.delete('/:id', async (c) => {
  const client = loggedClient(c)
  const id = parseIdParam(c.req.param('id'))
  if (id === null) return argumentTypeMismatch(c)

  const owned = await findOwnedWorkout(client, id)

  await db.update(workout).set({ deletedAt: new Date() }).where(eq(workout.id, owned.id))

  return c.body(null, 204)
})
