import { eq } from 'drizzle-orm'
import type { Context, MiddlewareHandler } from 'hono'
import { db } from '../db/client.ts'
import { client as clientTable, users } from '../db/schema.ts'
import { AppError, ErrorType } from '../shared/errors.ts'
import type { AuthVariables, ClientRow } from '../types.ts'
import { verifyToken } from './jwt.ts'

/**
 * Equivalente ao `JwtAuthenticationFilter` + `SecurityConfig` do Java:
 * exige `Authorization: Bearer <jwt>`, carrega o usuário e o client associado.
 */
export const requireAuth: MiddlewareHandler<AuthVariables> = async (c, next) => {
  const header = c.req.header('Authorization')
  if (!header || !header.startsWith('Bearer ')) {
    throw new AppError(ErrorType.LOGGED_USER_NOT_FOUND, 401)
  }

  const payload = await verifyToken(header.slice(7))
  if (!payload) {
    throw new AppError(ErrorType.LOGGED_USER_NOT_FOUND, 401)
  }

  const rows = await db
    .select({ user: users, client: clientTable })
    .from(users)
    .leftJoin(clientTable, eq(clientTable.userId, users.id))
    .where(eq(users.email, payload.sub))
    .limit(1)

  const row = rows[0]
  if (!row) {
    throw new AppError(ErrorType.LOGGED_USER_NOT_FOUND, 401)
  }

  c.set('jwt', { sub: payload.sub, roles: payload.roles })
  c.set('user', row.user)
  c.set('client', row.client)

  await next()
}

/** Equivalente ao `@PreAuthorize("hasRole('USER')")`. */
export const requireUserRole: MiddlewareHandler<AuthVariables> = async (c, next) => {
  const user = c.get('user')
  if (!user || user.role !== 'USER') {
    throw new AppError(ErrorType.CLIENT_DONT_HAVE_ACCESS, 403)
  }
  await next()
}

/** Equivalente ao `ClientService.getLoggedUser()`. */
export function loggedClient(c: Context<AuthVariables>): ClientRow {
  const client = c.get('client')
  if (!client) {
    throw new AppError(ErrorType.CLIENT_NOT_FOUND, 401)
  }
  return client
}
