import { sql } from 'drizzle-orm'
import { exercise } from '../db/schema.ts'

// Helpers puros de caminho/URL (sem banco): ver media-paths.ts.
export * from './media-paths.ts'

/**
 * Primeira imagem do exercício direto no SELECT (`images->>0`), para os joins
 * de treino/registro não carregarem o array inteiro de frames por linha.
 */
export const exerciseFirstImage = sql<string | null>`(${exercise.images} ->> 0)`
