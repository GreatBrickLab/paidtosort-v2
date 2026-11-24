// Entry for mounting the scanner inside pts-v2's Pages Functions router (functions/api/[[path]].js).
// Built into pages-bundle/scanner.mjs by `npm run bundle:pages` (pts-v2 CI has no npm install step).
//
// FAIL-CLOSED: createApp() defaults to DenyAllVerifier (every call 401) and to no recognizer (503) until Accounts and
// Security wires its verifier in and sets RECOGNIZER. There is no local-test switch in shipped code; tests inject fakes
// through tests/helpers only.
import { createApp, type Env } from './app';

const app = createApp({ log: () => {} }); // the pts-v2 router writes the one log line

export function handleScanner(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> | Response {
  return app.fetch(request, env, ctx);
}
