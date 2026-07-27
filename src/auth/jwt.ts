import { SignJWT, jwtVerify } from 'jose'
import { jwtSecretBytes } from '../env.ts'

const ALG = 'HS256'
/** Mesma validade do Java: 30 dias. */
const EXPIRATION_SECONDS = 60 * 60 * 24 * 30

export interface JwtPayload {
  sub: string
  roles: string[]
  iat: number
  exp: number
}

export async function signToken(email: string, roles: string[]): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({ roles })
    .setProtectedHeader({ alg: ALG })
    .setSubject(email)
    .setIssuedAt(now)
    .setExpirationTime(now + EXPIRATION_SECONDS)
    .sign(jwtSecretBytes)
}

export async function verifyToken(token: string): Promise<JwtPayload | null> {
  try {
    const { payload } = await jwtVerify(token, jwtSecretBytes, { algorithms: [ALG] })
    if (typeof payload.sub !== 'string' || !payload.sub) return null
    const roles = Array.isArray(payload.roles) ? (payload.roles as string[]) : []
    return {
      sub: payload.sub,
      roles,
      iat: payload.iat ?? 0,
      exp: payload.exp ?? 0,
    }
  } catch {
    return null
  }
}
