import { z } from 'zod'

const schema = z.object({
  JWT_SECRET: z.string().min(1, 'JWT_SECRET é obrigatório (base64)'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL é obrigatório'),
  DATABASE_SSL: z
    .string()
    .transform((v) => v === 'true' || v === '1')
    .default('false'),
  PORT: z.coerce.number().int().positive().default(8080),
  APP_TIMEZONE: z.string().default('America/Sao_Paulo'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
})

const parsed = schema.safeParse(process.env)

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n')
  console.error(`Configuração de ambiente inválida:\n${issues}`)
  process.exit(1)
}

export const env = parsed.data

/** O Java faz `Decoders.BASE64.decode(JWT_SECRET)` antes de assinar — reproduzir aqui. */
export const jwtSecretBytes = new Uint8Array(Buffer.from(env.JWT_SECRET, 'base64'))
