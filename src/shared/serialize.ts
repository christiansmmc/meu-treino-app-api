import { env } from '../env.ts'

/**
 * Drizzle devolve `decimal` como string; o Java serializava `BigDecimal` como
 * number (`40.0`). Converter na saída para não quebrar o parse do cliente.
 */
export function toNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isNaN(n) ? null : n
}

const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: env.APP_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/**
 * `LocalDate` do Java → `"YYYY-MM-DD"`. Internamente derivado de `created_at`
 * (DATETIME em UTC) convertido para o fuso da aplicação.
 */
export function toLocalDate(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value)
  return dateFormatter.format(date)
}

const partsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: env.APP_TIMEZONE,
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})

function zoneOffsetMs(instant: Date): number {
  const parts = partsFormatter.formatToParts(instant)
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value ?? '0')
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24,
    get('minute'),
    get('second'),
  )
  return asUtc - instant.getTime()
}

/**
 * Instante UTC correspondente à meia-noite do primeiro dia do mês em
 * APP_TIMEZONE, deslocado `monthsAgo` meses. Usado nos filtros de período.
 */
export function startOfMonthInAppTimezone(monthsAgo = 0): Date {
  const now = new Date()
  const parts = partsFormatter.formatToParts(now)
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value ?? '0')

  const naive = Date.UTC(get('year'), get('month') - 1 - monthsAgo, 1, 0, 0, 0)
  // Duas passadas resolvem a borda de horário de verão.
  let instant = new Date(naive - zoneOffsetMs(now))
  instant = new Date(naive - zoneOffsetMs(instant))
  return instant
}
