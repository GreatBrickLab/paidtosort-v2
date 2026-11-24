// Entry for mounting the scanner inside pts-v2's Pages Functions router (functions/api/[[path]].js).
// Built into pages-bundle/scanner.mjs by `npm run bundle:pages` (pts-v2 CI has no npm install step).
//
// AUTH IS FAIL-CLOSED: until Accounts and Security's verifier replaces DenyAllVerifier, every scanner route answers
// 401 on every host. The fake local verifier is used ONLY when SCANNER_LOCAL_TEST=1 (set in .dev.vars, never in
// Cloudflare) AND the request comes to a loopback host, so it can't switch on in preview or production by accident.
import { createApp, type Env } from './app';
import { DenyAllVerifier, FakeLocalVerifier } from './platform/auth';

export interface PagesEnv extends Env { SCANNER_LOCAL_TEST?: string }

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const deny = new DenyAllVerifier();
const shared = createApp({ verifier: deny, log: () => {} }); // the pts-v2 router writes the one log line
let local: ReturnType<typeof createApp> | null = null;

export function handleScanner(request: Request, env: PagesEnv, ctx?: ExecutionContext): Promise<Response> | Response {
  const host = new URL(request.url).hostname;
  if (env.SCANNER_LOCAL_TEST === '1' && LOOPBACK.has(host)) {
    local ??= createApp({ verifier: FakeLocalVerifier.fromJson(env.DEV_AUTH_TOKENS), log: () => {} });
    return local.fetch(request, env, ctx);
  }
  return shared.fetch(request, env, ctx);
}
