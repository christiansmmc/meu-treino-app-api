import type { Context } from 'hono'
import { ZodError, type ZodSchema, type z } from 'zod'

/**
 * Equivalente ao `@RequestBody @Valid` do Spring: corpo ilegível vira
 * MALFORMED_JSON_REQUEST, corpo inválido vira VALIDATION_ERROR (via ZodError).
 */
export async function parseBody<T extends ZodSchema>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    throw new MalformedJsonError()
  }
  return schema.parse(raw)
}

export class MalformedJsonError extends Error {}

export function parseIdParam(value: string | undefined): number | null {
  if (!value) return null
  if (!/^\d+$/.test(value)) return null
  const id = Number(value)
  return Number.isSafeInteger(id) ? id : null
}

export function isZodError(err: unknown): err is ZodError {
  return err instanceof ZodError
}

/** Aceita chave ausente OU `null` como "não preenchido". */
export function optionalNullable<T extends ZodSchema>(schema: T) {
  return schema.nullish().transform((v) => (v === undefined ? null : v))
}
