import { migrate } from 'drizzle-orm/mysql2/migrator'
import { db, pool } from './client.ts'

await migrate(db, { migrationsFolder: './src/db/migrations' })

console.log('Migrations aplicadas.')

await pool.end()
