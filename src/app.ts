import { Hono } from 'hono'
import { compress } from 'hono/compress'
import { cors } from 'hono/cors'
import { authRoutes } from './modules/auth.routes.ts'
import { clientRoutes } from './modules/clients.routes.ts'
import { exerciseLoadRoutes } from './modules/exercise-loads.routes.ts'
import { exerciseRoutes } from './modules/exercises.routes.ts'
import { serveMedia } from './modules/media.routes.ts'
import { workoutExerciseRoutes } from './modules/workout-exercises.routes.ts'
import { workoutRecordRoutes } from './modules/workout-records.routes.ts'
import { workoutRoutes } from './modules/workouts.routes.ts'
import { onError, onNotFound } from './shared/errors.ts'
import { MEDIA_ROUTE_PREFIX } from './shared/media.ts'
import type { AuthVariables } from './types.ts'

export const app = new Hono<AuthVariables>()

app.use('*', cors({ origin: '*', allowMethods: ['*'], allowHeaders: ['*'] }))

// gzip/deflate conforme `Accept-Encoding` (o `HttpClient` do Dart manda gzip e
// descompacta sozinho). `/api/media/*` fica de fora: JPG/MP4 já são
// comprimidos, e recomprimir em stream derrubaria Content-Length e Range.
const compressJson = compress()
app.use('*', (c, next) =>
  c.req.path.startsWith(MEDIA_ROUTE_PREFIX) ? next() : compressJson(c, next),
)

app.get('/api/health', (c) => c.json({ status: 'OK' }))

// Público (sem `requireAuth`): imagens são carregadas por `Image.network`/<img>.
app.get(`${MEDIA_ROUTE_PREFIX}*`, serveMedia)

app.route('/api/authenticate', authRoutes)
app.route('/api/clients', clientRoutes)
app.route('/api/exercises', exerciseRoutes)
app.route('/api/exercise-loads', exerciseLoadRoutes)
app.route('/api/workouts', workoutRoutes)
app.route('/api/workout-exercises', workoutExerciseRoutes)
app.route('/api/workout-record', workoutRecordRoutes)

app.onError(onError)
app.notFound(onNotFound)
