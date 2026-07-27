import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { authRoutes } from './modules/auth.routes.ts'
import { clientRoutes } from './modules/clients.routes.ts'
import { exerciseRoutes } from './modules/exercises.routes.ts'
import { workoutExerciseRoutes } from './modules/workout-exercises.routes.ts'
import { workoutRecordRoutes } from './modules/workout-records.routes.ts'
import { workoutRoutes } from './modules/workouts.routes.ts'
import { onError, onNotFound } from './shared/errors.ts'
import type { AuthVariables } from './types.ts'

export const app = new Hono<AuthVariables>()

app.use('*', cors({ origin: '*', allowMethods: ['*'], allowHeaders: ['*'] }))

app.get('/api/health', (c) => c.json({ status: 'OK' }))

app.route('/api/authenticate', authRoutes)
app.route('/api/clients', clientRoutes)
app.route('/api/exercises', exerciseRoutes)
app.route('/api/workouts', workoutRoutes)
app.route('/api/workout-exercises', workoutExerciseRoutes)
app.route('/api/workout-record', workoutRecordRoutes)

app.onError(onError)
app.notFound(onNotFound)
