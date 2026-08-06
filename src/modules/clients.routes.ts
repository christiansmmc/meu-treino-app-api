import { eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { requireAuth, requireUserRole, loggedClient } from '../auth/middleware.ts'
import { hashPassword, verifyPassword } from '../auth/password.ts'
import { db } from '../db/client.ts'
import { client as clientTable, exercise, users, workout, workoutRecord } from '../db/schema.ts'
import { AppError, ErrorType } from '../shared/errors.ts'
import { clientHeightSchema, clientWeightSchema } from '../shared/schemas.ts'
import { toNumber } from '../shared/serialize.ts'
import { parseBody } from '../shared/validate.ts'
import type { AuthVariables, ClientRow, UserRow } from '../types.ts'

const createClientSchema = z.object({
  firstName: z.string().trim().min(1),
  lastName: z.string().trim().nullish(),
  weight: z.number().nullish(),
  height: z.number().nullish(),
  user: z.object({
    email: z.string().trim().min(1),
    password: z.string().min(1),
  }),
})

const updateClientSchema = z
  .object({
    firstName: z.string().trim().min(1).optional(),
    lastName: z.string().trim().nullish(),
    weight: clientWeightSchema.nullish(),
    height: clientHeightSchema.nullish(),
  })
  .refine((dto) => Object.keys(dto).length > 0, {
    message: 'Informe ao menos um campo para atualizar.',
  })

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  // Mínimo alinhado com `FormValidators.validatePassword` do app Flutter.
  newPassword: z.string().min(6),
})

const deleteAccountSchema = z.object({
  password: z.string().min(1),
})

/**
 * Diferente dos outros módulos, este arquivo NÃO usa
 * `use('*', requireAuth, requireUserRole)`: `POST /` (cadastro) precisa ficar
 * público. Por isso cada rota declara suas próprias guards — uma rota nova
 * aqui que esquecer de listar `requireAuth`/`requireUserRole` fica pública
 * por padrão, sem nada estrutural para pegar o esquecimento.
 */
export const clientRoutes = new Hono<AuthVariables>()

/** Corpo de resposta compartilhado por `GET /` e `PATCH /`. */
function clientResponse(client: ClientRow, user: UserRow) {
  return {
    firstName: client.firstName,
    lastName: client.lastName,
    weight: toNumber(client.weight),
    height: toNumber(client.height),
    user: { email: user.email },
  }
}

/** Cadastro — público (mesma regra do `SecurityConfig` do Java). */
clientRoutes.post('/', async (c) => {
  const dto = await parseBody(c, createClientSchema)

  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, dto.user.email))
    .limit(1)

  if (existing) {
    throw new AppError(
      { code: 'EMAIL_ALREADY_EXISTS', message: 'Já existe uma conta com esse e-mail.' },
      400,
    )
  }

  const passwordHash = await hashPassword(dto.user.password)

  const id = await db.transaction(async (tx) => {
    const [userInsert] = await tx
      .insert(users)
      .values({
        email: dto.user.email,
        password: passwordHash,
        role: 'USER',
      })
      .returning({ id: users.id })

    const [clientInsert] = await tx
      .insert(clientTable)
      .values({
        firstName: dto.firstName.toLowerCase(),
        lastName: dto.lastName ? dto.lastName.toLowerCase() : null,
        weight: dto.weight != null ? String(dto.weight) : null,
        height: dto.height != null ? String(dto.height) : null,
        userId: userInsert!.id,
      })
      .returning({ id: clientTable.id })

    return clientInsert!.id
  })

  return c.json({ id })
})

clientRoutes.get('/', requireAuth, (c) => {
  return c.json(clientResponse(loggedClient(c), c.get('user')))
})

/**
 * Atualização parcial: só as chaves presentes no corpo são gravadas. `null`
 * explícito limpa o campo (peso e altura são opcionais no cadastro), e chave
 * ausente não mexe no valor atual — por isso o `values` é montado testando
 * `!== undefined` em vez de espalhar o dto.
 */
clientRoutes.patch('/', requireAuth, requireUserRole, async (c) => {
  const client = loggedClient(c)
  const user = c.get('user')
  const dto = await parseBody(c, updateClientSchema)

  const values: Partial<typeof clientTable.$inferInsert> = {}
  // `firstName` em lowercase, mesma regra do cadastro; o app capitaliza na exibição.
  if (dto.firstName !== undefined) values.firstName = dto.firstName.toLowerCase()
  if (dto.lastName !== undefined) values.lastName = dto.lastName ? dto.lastName.toLowerCase() : null
  if (dto.weight !== undefined) values.weight = dto.weight != null ? String(dto.weight) : null
  if (dto.height !== undefined) values.height = dto.height != null ? String(dto.height) : null

  const [updated] = await db
    .update(clientTable)
    .set(values)
    .where(eq(clientTable.id, client.id))
    .returning()

  return c.json(clientResponse(updated!, user))
})

/**
 * A sessão sobrevive à troca: o `sub` do JWT é o e-mail, que não muda aqui.
 */
clientRoutes.patch('/password', requireAuth, requireUserRole, async (c) => {
  const user = c.get('user')
  const dto = await parseBody(c, changePasswordSchema)

  const ok = await verifyPassword(dto.currentPassword, user.password)
  AppError.throwIfNot(ok, ErrorType.INVALID_PASSWORD)

  await db
    .update(users)
    .set({ password: await hashPassword(dto.newPassword) })
    .where(eq(users.id, user.id))

  return c.body(null, 204)
})

/**
 * Hard delete: o app promete "seus treinos e histórico são apagados junto".
 *
 * A ordem importa. `workout_exercise`, `workout_record_exercise` e
 * `workout_record_exercise_set` caem sozinhos por `onDelete: 'cascade'`, mas
 * `workout_record → workout` NÃO tem cascade no schema — apagar `workout`
 * primeiro violaria a FK. Os treinos são buscados sem filtrar `deletedAt`:
 * treino excluído por soft delete também tem que sair do banco aqui.
 *
 * Exercícios custom (`exercise.client_id`) só podem ser referenciados pelo
 * próprio dono — as três variantes de `assertExercisesExist` (em
 * `workouts.routes.ts`, `workout-exercises.routes.ts` e
 * `workout-records.routes.ts`) filtram por cliente — então saem junto sem
 * risco de órfão em `workout_record_exercise` de terceiro.
 */
clientRoutes.delete('/', requireAuth, requireUserRole, async (c) => {
  const client = loggedClient(c)
  const user = c.get('user')
  const dto = await parseBody(c, deleteAccountSchema)

  const ok = await verifyPassword(dto.password, user.password)
  AppError.throwIfNot(ok, ErrorType.INVALID_PASSWORD)

  await db.transaction(async (tx) => {
    const workouts = await tx
      .select({ id: workout.id })
      .from(workout)
      .where(eq(workout.clientId, client.id))
    const workoutIds = workouts.map((w) => w.id)

    if (workoutIds.length > 0) {
      await tx.delete(workoutRecord).where(inArray(workoutRecord.workoutId, workoutIds))
      await tx.delete(workout).where(inArray(workout.id, workoutIds))
    }

    await tx.delete(exercise).where(eq(exercise.clientId, client.id))
    await tx.delete(clientTable).where(eq(clientTable.id, client.id))
    await tx.delete(users).where(eq(users.id, user.id))
  })

  return c.body(null, 204)
})
