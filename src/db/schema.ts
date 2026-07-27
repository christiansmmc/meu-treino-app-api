import { sql } from 'drizzle-orm'
import {
  bigint,
  datetime,
  decimal,
  foreignKey,
  index,
  int,
  mysqlEnum,
  mysqlTable,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core'

export const BODY_PARTS = [
  'PEITO',
  'TRICEPS',
  'COSTAS',
  'BICEPS',
  'OMBRO',
  'PERNA',
  'ANTEBRACO',
  'ABDOMEN',
  'GLUTEO',
  'LOMBAR',
  'CARDIO',
] as const

export const RECORD_EXERCISE_STATUS = ['COMPLETED', 'PARTIAL', 'SKIPPED', 'MODIFIED'] as const

export const ROLES = ['USER', 'ADMIN'] as const

export type BodyPart = (typeof BODY_PARTS)[number]
export type RecordExerciseStatus = (typeof RECORD_EXERCISE_STATUS)[number]

const createdAt = () =>
  datetime('created_at', { mode: 'date' }).notNull().default(sql`CURRENT_TIMESTAMP`)

const updatedAt = () =>
  datetime('updated_at', { mode: 'date' })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`)

export const users = mysqlTable(
  'users',
  {
    id: bigint('id', { mode: 'number' }).autoincrement().primaryKey(),
    email: varchar('email', { length: 255 }).notNull(),
    password: varchar('password', { length: 255 }).notNull(),
    role: mysqlEnum('role', ROLES).notNull().default('USER'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    emailUnique: uniqueIndex('users_email_unique').on(t.email),
  }),
)

export const client = mysqlTable(
  'client',
  {
    id: bigint('id', { mode: 'number' }).autoincrement().primaryKey(),
    firstName: varchar('first_name', { length: 255 }).notNull(),
    lastName: varchar('last_name', { length: 255 }),
    weight: decimal('weight', { precision: 5, scale: 2 }),
    height: decimal('height', { precision: 3, scale: 2 }),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    userUnique: uniqueIndex('client_user_id_unique').on(t.userId),
  }),
)

export const exercise = mysqlTable(
  'exercise',
  {
    id: bigint('id', { mode: 'number' }).autoincrement().primaryKey(),
    name: varchar('name', { length: 255 }).notNull(),
    bodyPart: mysqlEnum('body_part', BODY_PARTS).notNull(),
    /** NULL = exercício global do catálogo; não-null = custom do cliente. */
    clientId: bigint('client_id', { mode: 'number' }).references(() => client.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    bodyPartIdx: index('exercise_body_part_idx').on(t.bodyPart),
    clientIdx: index('exercise_client_id_idx').on(t.clientId),
  }),
)

export const workout = mysqlTable(
  'workout',
  {
    id: bigint('id', { mode: 'number' }).autoincrement().primaryKey(),
    name: varchar('name', { length: 255 }).notNull(),
    listOrder: int('list_order').notNull().default(0),
    clientId: bigint('client_id', { mode: 'number' })
      .notNull()
      .references(() => client.id),
    deletedAt: datetime('deleted_at', { mode: 'date' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    listIdx: index('workout_client_deleted_order_idx').on(t.clientId, t.deletedAt, t.listOrder),
  }),
)

export const workoutExercise = mysqlTable(
  'workout_exercise',
  {
    id: bigint('id', { mode: 'number' }).autoincrement().primaryKey(),
    sets: int('sets'),
    reps: int('reps'),
    exerciseLoad: decimal('exercise_load', { precision: 5, scale: 2 }),
    listOrder: int('list_order').notNull().default(0),
    workoutId: bigint('workout_id', { mode: 'number' })
      .notNull()
      .references(() => workout.id, { onDelete: 'cascade' }),
    exerciseId: bigint('exercise_id', { mode: 'number' })
      .notNull()
      .references(() => exercise.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    orderIdx: index('workout_exercise_workout_order_idx').on(t.workoutId, t.listOrder),
  }),
)

export const workoutRecord = mysqlTable(
  'workout_record',
  {
    id: bigint('id', { mode: 'number' }).autoincrement().primaryKey(),
    workoutId: bigint('workout_id', { mode: 'number' })
      .notNull()
      .references(() => workout.id),
    deletedAt: datetime('deleted_at', { mode: 'date' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    workoutCreatedIdx: index('workout_record_workout_created_idx').on(t.workoutId, t.createdAt),
  }),
)

export const workoutRecordExercise = mysqlTable(
  'workout_record_exercise',
  {
    id: bigint('id', { mode: 'number' }).autoincrement().primaryKey(),
    note: varchar('note', { length: 255 }),
    status: mysqlEnum('status', RECORD_EXERCISE_STATUS).notNull(),
    exerciseId: bigint('exercise_id', { mode: 'number' })
      .notNull()
      .references(() => exercise.id),
    workoutRecordId: bigint('workout_record_id', { mode: 'number' })
      .notNull()
      .references(() => workoutRecord.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    recordIdx: index('workout_record_exercise_record_idx').on(t.workoutRecordId),
  }),
)

export const workoutRecordExerciseSet = mysqlTable(
  'workout_record_exercise_set',
  {
    id: bigint('id', { mode: 'number' }).autoincrement().primaryKey(),
    setNumber: int('set_number').notNull(),
    reps: int('reps'),
    exerciseLoad: decimal('exercise_load', { precision: 5, scale: 2 }),
    note: varchar('note', { length: 255 }),
    workoutRecordExerciseId: bigint('workout_record_exercise_id', { mode: 'number' }).notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    exerciseIdx: index('workout_record_exercise_set_exercise_idx').on(t.workoutRecordExerciseId),
    // Nome explícito: o padrão do Drizzle passaria dos 64 chars do MySQL.
    recordExerciseFk: foreignKey({
      name: 'wr_exercise_set_wr_exercise_fk',
      columns: [t.workoutRecordExerciseId],
      foreignColumns: [workoutRecordExercise.id],
    }).onDelete('cascade'),
  }),
)
