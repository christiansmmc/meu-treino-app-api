import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { env } from '../env.ts'
import * as schema from './schema.ts'

/**
 * Postgres client (postgres.js).
 *
 * `DATABASE_URL` já carrega `?sslmode=require` no Neon — mesmo sem `ssl: true`
 * explícito o driver honra a query string. Deixamos `prepare: false` porque o
 * Neon pooler não suporta prepared statements com o mesmo lifecycle.
 */
export const sql = postgres(env.DATABASE_URL, {
  max: 10,
  prepare: false,
  ssl: env.DATABASE_SSL ? 'require' : undefined,
})

export const db = drizzle(sql, { schema })

export type Db = typeof db
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
