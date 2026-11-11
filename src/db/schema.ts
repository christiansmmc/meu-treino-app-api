import {
  bigint,
  bigserial,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core'

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

export const bodyPartEnum = pgEnum('body_part', BODY_PARTS)
export const recordExerciseStatusEnum = pgEnum('record_exercise_status', RECORD_EXERCISE_STATUS)
export const roleEnum = pgEnum('user_role', ROLES)

const createdAt = () => timestamp('created_at', { mode: 'date' }).notNull().defaultNow()

/** Postgres não tem `ON UPDATE`; Drizzle atualiza no ORM via `$onUpdate`. */
const updatedAt = () =>
  timestamp('updated_at', { mode: 'date' })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date())

export const users = pgTable(
  'users',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    email: varchar('email', { length: 255 }).notNull(),
    password: varchar('password', { length: 255 }).notNull(),
    role: roleEnum('role').notNull().default('USER'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    emailUnique: uniqueIndex('users_email_unique').on(t.email),
  }),
)

export const client = pgTable(
  'client',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    firstName: varchar('first_name', { length: 255 }).notNull(),
    lastName: varchar('last_name', { length: 255 }),
    weight: numeric('weight', { precision: 5, scale: 2 }),
    height: numeric('height', { precision: 3, scale: 2 }),
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

export const exercise = pgTable(
  'exercise',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    name: varchar('name', { length: 255 }).notNull(),
    bodyPart: bodyPartEnum('body_part').notNull(),
    /** NULL = exercício global do catálogo; não-null = custom do cliente. */
    clientId: bigint('client_id', { mode: 'number' }).references(() => client.id),
    /**
     * Id do exercício no catálogo de origem (ex.: `"0025"`). Chave do upsert de
     * `bun run catalog:sync`; NULL em exercícios custom e nos legados.
     */
    externalId: varchar('external_id', { length: 64 }),
    nameEn: varchar('name_en', { length: 255 }),
    equipment: varchar('equipment', { length: 255 }),
    target: varchar('target', { length: 255 }),
    secondaryMuscles: jsonb('secondary_muscles').$type<string[]>().notNull().default([]),
    category: varchar('category', { length: 255 }),
    instructions: jsonb('instructions').$type<string[]>().notNull().default([]),
    /**
     * Caminhos relativos a `MEDIA_DIR` (qualquer layout, ex.:
     * `sources/workout-guide/bench-press/frame-1.png`; um arquivo pode ser
     * compartilhado por vários exercícios); >1 = frames de animação.
     */
    images: jsonb('images').$type<string[]>().notNull().default([]),
    /** Caminho relativo a `MEDIA_DIR`, ou NULL. */
    video: varchar('video', { length: 512 }),
    /** Crédito exigido pela licença da mídia (ex.: CC BY-SA), exibido junto das imagens. */
    mediaAttribution: text('media_attribution'),
    /**
     * Exercício global que saiu do catálogo mas ainda é referenciado por algum
     * treino/registro: some de `GET /exercises`, continua resolvendo nos joins
     * do histórico e em `GET /exercises/:id`.
     */
    archivedAt: timestamp('archived_at', { mode: 'date', withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    bodyPartIdx: index('exercise_body_part_idx').on(t.bodyPart),
    clientIdx: index('exercise_client_id_idx').on(t.clientId),
    externalIdUnique: uniqueIndex('exercise_external_id_unique').on(t.externalId),
  }),
)

export const workout = pgTable(
  'workout',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    name: varchar('name', { length: 255 }).notNull(),
    listOrder: integer('list_order').notNull().default(0),
    clientId: bigint('client_id', { mode: 'number' })
      .notNull()
      .references(() => client.id),
    deletedAt: timestamp('deleted_at', { mode: 'date' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    listIdx: index('workout_client_deleted_order_idx').on(t.clientId, t.deletedAt, t.listOrder),
  }),
)

export const workoutExercise = pgTable(
  'workout_exercise',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    sets: integer('sets'),
    reps: integer('reps'),
    exerciseLoad: numeric('exercise_load', { precision: 5, scale: 2 }),
    /**
     * Quando a CARGA desta linha mudou por último (não `updated_at`, que muda
     * com séries, reps e reordenação). Decide qual carga sugerir quando o
     * mesmo exercício tem cargas diferentes em treinos diferentes. `null` =
     * nunca teve carga.
     */
    loadUpdatedAt: timestamp('load_updated_at', { mode: 'date' }),
    listOrder: integer('list_order').notNull().default(0),
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
    // FK sem índice: o `catalog:sync` remapeia/apaga exercícios por `exercise_id`,
    // e cada DELETE em `exercise` checa a FK aqui.
    exerciseIdx: index('workout_exercise_exercise_id_idx').on(t.exerciseId),
  }),
)

export const workoutRecord = pgTable(
  'workout_record',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    workoutId: bigint('workout_id', { mode: 'number' })
      .notNull()
      .references(() => workout.id),
    deletedAt: timestamp('deleted_at', { mode: 'date' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    workoutCreatedIdx: index('workout_record_workout_created_idx').on(t.workoutId, t.createdAt),
  }),
)

export const workoutRecordExercise = pgTable(
  'workout_record_exercise',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    note: varchar('note', { length: 255 }),
    status: recordExerciseStatusEnum('status').notNull(),
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
    // Mesmo motivo de `workout_exercise_exercise_id_idx`.
    exerciseIdx: index('workout_record_exercise_exercise_id_idx').on(t.exerciseId),
  }),
)

export const workoutRecordExerciseSet = pgTable(
  'workout_record_exercise_set',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    setNumber: integer('set_number').notNull(),
    reps: integer('reps'),
    exerciseLoad: numeric('exercise_load', { precision: 5, scale: 2 }),
    note: varchar('note', { length: 255 }),
    workoutRecordExerciseId: bigint('workout_record_exercise_id', { mode: 'number' })
      .notNull()
      .references(() => workoutRecordExercise.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => ({
    exerciseIdx: index('workout_record_exercise_set_exercise_idx').on(t.workoutRecordExerciseId),
  }),
)

/**
 * Último `catalog:sync` completo — uma linha só (`id = 1`). O boot compara o
 * hash de `data/exercises.json` (+ mapa legado + versão do sync) e uma
 * impressão digital dos exercícios globais no banco com o que está aqui: se os
 * dois batem, o catálogo já está sincronizado e o sync é pulado (poupa o
 * upsert de ~1.300 linhas a cada cold start). Ver `catalog-sync.ts`.
 */
export const catalogSyncState = pgTable('catalog_sync_state', {
  id: integer('id').primaryKey(),
  contentHash: varchar('content_hash', { length: 64 }).notNull(),
  dbFingerprint: text('db_fingerprint').notNull(),
  syncedAt: timestamp('synced_at', { mode: 'date', withTimezone: true }).notNull().defaultNow(),
})
