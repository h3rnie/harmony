// Vercel Function (Node.js runtime) for /api/live. All logic lives in server/fetchRoutes.ts and the shared cores;
// `vite dev` serves the same route through the Vite plugins instead.
import { handleLive, pickEnv } from '../server/fetchRoutes.ts'

export default {
  fetch(req: Request): Promise<Response> {
    return handleLive(req, pickEnv(process.env), 'live')
  },
}
