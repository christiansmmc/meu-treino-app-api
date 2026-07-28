import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { loggedClient, requireAuth } from '../auth/middleware.ts'
import { hashPassword } from '../auth/password.ts'
import { db } from '../db/client.ts'
import { client as clientTable, users } from '../db/schema.ts'
import { AppError } from '../shared/errors.ts'
import { toNumber } from '../shared/serialize.ts'
import { parseBody } from '../shared/validate.ts'
import type { AuthVariables } from '../types.ts'

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

export const clientRoutes = new Hono<AuthVariables>()

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
  const client = loggedClient(c)
  const user = c.get('user')

  return c.json({
    firstName: client.firstName,
    lastName: client.lastName,
    weight: toNumber(client.weight),
    height: toNumber(client.height),
    user: { email: user.email },
  })
})
