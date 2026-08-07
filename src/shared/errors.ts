import type { Context, ErrorHandler, NotFoundHandler } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { ZodError } from 'zod'
import { MalformedJsonError } from './validate.ts'

/**
 * Mesmos códigos/mensagens do `ErrorType` do backend Java — o cliente Flutter
 * exibe `errorMessage ?? message` direto na tela.
 */
export const ErrorType = {
  WORKOUT_EXERCISE_NOT_FOUND: { code: '001', message: 'Exercício não encontrado no treino.' },
  CLIENT_DONT_HAVE_ACCESS: {
    code: '002',
    message: 'Você não tem permissão para acessar essa informação.',
  },
  WORKOUT_NOT_FOUND: { code: '003', message: 'Treino não encontrado.' },
  INVALID_CREDENTIALS: {
    code: '004',
    message: 'Credenciais inválidas. Verifique seu e-mail e senha.',
  },
  LOGGED_USER_NOT_FOUND: {
    code: '005',
    message: 'Sessão expirada ou inválida. Faça login para continuar.',
  },
  CLIENT_NOT_FOUND: { code: '006', message: 'Nenhum cliente encontrado com o e-mail informado.' },
  EXERCISE_NOT_FOUND: { code: '007', message: 'Exercício não encontrado.' },
  INVALID_PASSWORD: { code: '008', message: 'Senha incorreta.' },
  // Mensagem hardcoded porque `ErrorType` inteiro é estático — se
  // `PASSWORD_MIN_LENGTH` (`clients.routes.ts`) mudar, atualizar aqui junto.
  SHORT_PASSWORD: { code: '009', message: 'A senha precisa ter pelo menos 6 caracteres.' },
} as const

export interface ErrorTypeEntry {
  readonly code: string
  readonly message: string
}

export class AppError extends Error {
  readonly code: string
  readonly status: ContentfulStatusCode
  readonly details: Record<string, unknown> | null

  constructor(
    errorType: ErrorTypeEntry,
    status: ContentfulStatusCode = 400,
    details: Record<string, unknown> | null = null,
  ) {
    super(errorType.message)
    this.code = errorType.code
    this.status = status
    this.details = details
  }

  static throwIf(condition: boolean, errorType: ErrorTypeEntry, status: ContentfulStatusCode = 400) {
    if (condition) throw new AppError(errorType, status)
  }

  static throwIfNot(
    condition: boolean,
    errorType: ErrorTypeEntry,
    status: ContentfulStatusCode = 400,
  ) {
    if (!condition) throw new AppError(errorType, status)
  }
}

/** Formato exato do `GlobalExceptionHandler.ErrorResponse` do Java. */
export interface ErrorResponse {
  code: string
  message: string
  details: Record<string, unknown> | null
  path: string
  timestamp: string
}

/** `LocalDateTime.now()` do Java: sem timezone, sem `Z`. */
function localDateTimeNow(): string {
  const now = new Date()
  const pad = (n: number, size = 2) => String(n).padStart(size, '0')
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}` +
    `.${pad(now.getMilliseconds(), 3)}000`
  )
}

function body(
  c: Context,
  code: string,
  message: string,
  details: Record<string, unknown> | null = null,
): ErrorResponse {
  return {
    code,
    message,
    details,
    path: new URL(c.req.url).pathname,
    timestamp: localDateTimeNow(),
  }
}

export function validationErrorBody(c: Context, error: ZodError) {
  const errors = error.issues.map((issue) => {
    const path = issue.path.join('.')
    return path ? `${path}: ${issue.message}` : issue.message
  })
  return body(c, 'VALIDATION_ERROR', 'Existem erros de validação nos campos enviados.', { errors })
}

export const onError: ErrorHandler = (err, c) => {
  if (err instanceof AppError) {
    return c.json(body(c, err.code, err.message, err.details), err.status)
  }

  if (err instanceof ZodError) {
    return c.json(validationErrorBody(c, err), 400)
  }

  if (err instanceof MalformedJsonError) {
    return malformedJson(c)
  }

  if (err instanceof HTTPException) {
    if (err.status === 405) {
      return c.json(
        body(
          c,
          'METHOD_NOT_SUPPORTED',
          'A operação solicitada não é permitida para este recurso.',
        ),
        405,
      )
    }
    if (err.status === 400) {
      return c.json(
        body(c, 'MALFORMED_JSON_REQUEST', 'O corpo da requisição está mal formatado ou é inválido.'),
        400,
      )
    }
  }

  console.error('Exception occurred:', err)
  return c.json(
    body(c, 'INTERNAL_SERVER_ERROR', 'Ocorreu um erro inesperado. Tente novamente mais tarde.'),
    500,
  )
}

export const onNotFound: NotFoundHandler = (c) =>
  c.json(body(c, 'NOT_FOUND', 'O recurso solicitado não foi encontrado.'), 404)

export function malformedJson(c: Context) {
  return c.json(
    body(c, 'MALFORMED_JSON_REQUEST', 'O corpo da requisição está mal formatado ou é inválido.'),
    400,
  )
}

export function argumentTypeMismatch(c: Context) {
  return c.json(
    body(c, 'ARGUMENT_TYPE_MISMATCH', 'Um dos parâmetros informados está com um formato inválido.'),
    400,
  )
}
