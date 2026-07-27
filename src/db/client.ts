import { drizzle } from 'drizzle-orm/mysql2'
import mysql from 'mysql2/promise'
import { env } from '../env.ts'
import * as schema from './schema.ts'

export const pool = mysql.createPool({
  uri: env.DATABASE_URL,
  // Datas viajam em UTC; a formatação para `YYYY-MM-DD` usa APP_TIMEZONE na saída.
  timezone: 'Z',
  connectionLimit: 10,
  supportBigNumbers: true,
  decimalNumbers: false,
  // Aiven / provedores gerenciados exigem TLS. Habilita via env DATABASE_SSL=true.
  ...(env.DATABASE_SSL ? { ssl: { rejectUnauthorized: false } } : {}),
})

export const db = drizzle(pool, { schema, mode: 'default' })

export type Db = typeof db
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
