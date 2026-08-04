import { and, eq, isNull, or, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { loggedClient, requireAuth, requireUserRole } from '../auth/middleware.ts'
import { db } from '../db/client.ts'
import { exercise, workout, workoutExercise } from '../db/schema.ts'
import { AppError, ErrorType, argumentTypeMismatch } from '../shared/errors.ts'
import { parseBody, parseIdParam } from '../shared/validate.ts'
import type { AuthVariables } from '../types.ts'
import { findOwnedWorkout } from './workouts.routes.ts'

const createSchema = z.object({
  sets: z.number().int().nullish(),
  reps: z.number().int().nullish(),
  exerciseLoad: z.number().nullish(),
  workout: z.object({ id: z.number().int().positive() }),
  exercise: z.object({ id: z.number().int().positive() }),
})

const updateSchema = z.object({
  sets: z.number().int(),
  reps: z.number().int(),
  load: z.number().nullable(),
})

export const workoutExerciseRoutes = new Hono<AuthVariables>()

workoutExerciseRoutes.use('*', requireAuth, requireUserRole)

workoutExerciseRoutes.post('/', async (c) => {
  const client = loggedClient(c)
  const dto = await parseBody(c, createSchema)

  const owned = await findOwnedWorkout(client, dto.workout.id)

  const [found] = await db
    .select({ id: exercise.id })
    .from(exercise)
    .where(
      and(
        eq(exercise.id, dto.exercise.id),
        or(isNull(exercise.clientId), eq(exercise.clientId, client.id)),
      ),
    )
    .limit(1)

  if (!found) throw new AppError(ErrorType.EXERCISE_NOT_FOUND, 404)

  const [maxOrder] = await db
    .select({ value: sql<number | null>`MAX(${workoutExercise.listOrder})` })
    .from(workoutExercise)
    .where(eq(workoutExercise.workoutId, owned.id))

  const listOrder =
    maxOrder?.value === null || maxOrder?.value === undefined ? 0 : maxOrder.value + 1

  await db.insert(workoutExercise).values({
    sets: dto.sets ?? null,
    reps: dto.reps ?? null,
    exerciseLoad: dto.exerciseLoad != null ? String(dto.exerciseLoad) : null,
    listOrder,
    workoutId: owned.id,
    exerciseId: found.id,
  })

  c.header('Location', '/api/workout-exercises/')
  return c.body(null, 201)
})

workoutExerciseRoutes.patch('/:id', async (c) => {
  const client = loggedClient(c)
  const id = parseIdParam(c.req.param('id'))
  if (id === null) return argumentTypeMismatch(c)

  const dto = await parseBody(c, updateSchema)

  const [row] = await db
    .select({ id: workoutExercise.id, clientId: workout.clientId })
    .from(workoutExercise)
    .innerJoin(workout, eq(workout.id, workoutExercise.workoutId))
    .where(eq(workoutExercise.id, id))
    .limit(1)

  if (!row) throw new AppError(ErrorType.WORKOUT_EXERCISE_NOT_FOUND, 404)
  AppError.throwIfNot(row.clientId === client.id, ErrorType.CLIENT_DONT_HAVE_ACCESS)

  await db
    .update(workoutExercise)
    .set({
      sets: dto.sets,
      reps: dto.reps,
      exerciseLoad: dto.load !== null ? String(dto.load) : null,
    })
    .where(eq(workoutExercise.id, row.id))

  return c.body(null, 200)
})

workoutExerciseRoutes.delete('/:id', async (c) => {
  const client = loggedClient(c)
  const id = parseIdParam(c.req.param('id'))
  if (id === null) return argumentTypeMismatch(c)

  // Igual ao Java: sem dono correspondente, a operação é ignorada silenciosamente.
  const [row] = await db
    .select({ id: workoutExercise.id, clientId: workout.clientId })
    .from(workoutExercise)
    .innerJoin(workout, eq(workout.id, workoutExercise.workoutId))
    .where(eq(workoutExercise.id, id))
    .limit(1)

  if (row && row.clientId === client.id) {
    await db.delete(workoutExercise).where(eq(workoutExercise.id, row.id))
  }

  return c.body(null, 204)
})
