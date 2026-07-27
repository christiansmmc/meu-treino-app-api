import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { signToken } from '../auth/jwt.ts'
import { verifyPassword } from '../auth/password.ts'
import { db } from '../db/client.ts'
import { users } from '../db/schema.ts'
import { AppError, ErrorType } from '../shared/errors.ts'
import { parseBody } from '../shared/validate.ts'

const authenticateSchema = z.object({
  email: z.string().trim().min(1),
  password: z.string().min(1),
})

export const authRoutes = new Hono()

authRoutes.post('/', async (c) => {
  const dto = await parseBody(c, authenticateSchema)

  const [user] = await db.select().from(users).where(eq(users.email, dto.email)).limit(1)

  if (!user || !(await verifyPassword(dto.password, user.password))) {
    throw new AppError(ErrorType.INVALID_CREDENTIALS, 401)
  }

  const token = await signToken(user.email, [user.role])

  return c.json({ token })
})
