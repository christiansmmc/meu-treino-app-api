/**
 * BCrypt com cost 10 — mesmo default do `BCryptPasswordEncoder` do Spring
 * Security, então hashes antigos (`$2a$10$...`) continuam validando.
 */
const COST = 10

export function hashPassword(plain: string): Promise<string> {
  return Bun.password.hash(plain, { algorithm: 'bcrypt', cost: COST })
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  try {
    return await Bun.password.verify(plain, hash)
  } catch {
    return false
  }
}
