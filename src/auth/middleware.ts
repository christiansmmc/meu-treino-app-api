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

  // `sub` é o e-mail, não um id estável: `DELETE /clients` faz hard delete da
  // linha em `users`, o que libera o e-mail para re-cadastro. Sem esta
  // checagem, um token de até 30 dias emitido para a conta antiga autentica
  // como QUALQUER UM que reusar aquele e-mail depois — sem senha.
  //
  // `iat` (JWT, sempre inteiro em segundos) é comparado contra `createdAt`
  // também truncado para segundos — não `payload.iat * 1000 < createdAt.getTime()`
  // direto. Cadastro e login acontecem em requisições HTTP separadas, mas
  // podem cair no mesmo segundo (o smoke faz isso sempre): `iat` arredonda
  // para baixo, então um `createdAt` com milissegundos à frente dentro
  // daquele mesmo segundo faria a comparação em ms rejeitar um token
  // legítimo emitido segundos depois do cadastro. Comparar segundo-a-segundo
  // elimina esse falso positivo sem abrir a janela que a checagem existe
  // para fechar.
  //
  // `iat` é sempre gravado por `signToken`, mas tratamos a ausência como
  // inválida (em vez de deixar `undefined` virar `NaN` e a comparação abaixo
  // silenciosamente não barrar nada) — falha fechada, não aberta.
  const issuedAtSeconds = typeof payload.iat === 'number' ? payload.iat : Number.NaN
  const createdAtSeconds = Math.floor(row.user.createdAt.getTime() / 1000)
  if (!Number.isFinite(issuedAtSeconds) || issuedAtSeconds < createdAtSeconds) {
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
