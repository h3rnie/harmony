// Vercel Function (Node.js runtime) for /api/ask. All logic lives in server/fetchRoutes.ts and the shared cores;
// `vite dev` serves the same route through the Vite plugins instead.
import { handleAi, pickEnv } from '../server/fetchRoutes.ts'

export default {
  fetch(req: Request): Promise<Response> {
    return handleAi(req, pickEnv(process.env), 'ask')
  },
}
