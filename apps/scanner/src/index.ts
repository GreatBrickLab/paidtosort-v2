// Worker entry (local wrangler dev only in this WIP; deploys go through Web Boss).
import { createApp, type Env } from './app';
const app = createApp();
export default { fetch: (req: Request, env: Env, ctx: ExecutionContext) => app.fetch(req, env, ctx) };
