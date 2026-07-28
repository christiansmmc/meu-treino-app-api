import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { db, sql } from './client.ts'

await migrate(db, { migrationsFolder: './src/db/migrations' })

console.log('Migrations aplicadas.')

await sql.end()
