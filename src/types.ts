import type { client, users } from './db/schema.ts'

export type UserRow = typeof users.$inferSelect
export type ClientRow = typeof client.$inferSelect

export interface AuthVariables {
  Variables: {
    /** Payload do JWT já verificado. */
    jwt: { sub: string; roles: string[] }
    user: UserRow
    /** `null` quando o usuário autenticado ainda não tem client vinculado. */
    client: ClientRow | null
  }
}
