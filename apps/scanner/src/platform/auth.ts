// AUTH STUB. Accounts and Security owns identity: sign-in, sessions, roles, API keys, secrets (Huddle, Nov 24 2026 11:43 AM CT).
// This file is ONLY the seam where A&S's future auth contract plugs in:
//     verify(request) -> Principal { user_id, role, scopes, ... }   or null (→ 401)
// Scope checks (→ 403) use the scopes A&S returns. Nothing here issues, stores, hashes or rotates keys, and there is no
// key table. Chris's rule (Nov 24 11:24 AM): everybody using the API needs a key, so every route runs this check.
// FakeLocalVerifier is for tests and local dev only. See BACKEND-REQUEST-AS-v2.md for what we ask A&S for.
import type { Context, MiddlewareHandler } from 'hono';
import { problem } from './problem';

export type Scope = 'scan:write' | 'batches:read' | 'batches:read_all' | 'exports:create' | 'batches:process';
// Roles per V2-SECURITY-CONTRACT.md §4. No partner role for now (Huddle 11:56 AM CT); every query stays scoped by owner
// so a scoped partner role can be added later without changing the scanner's access rules.
export type Role = 'sorter' | 'team' | 'admin' | 'pending';

export interface Principal {
  user_id: string; name: string; role: Role; scopes: Scope[];
  key_id: string | null; mode: 'test' | 'live';
}

/** The one interface A&S's auth replaces. Return null when the caller is not signed in / the key is not valid. */
export interface AuthVerifier { verify(request: Request): Promise<Principal | null> }

/**
 * Test/dev stand-in. Takes a map of opaque bearer tokens to principals (from the gitignored .dev.vars locally, or
 * built in memory by tests). It only accepts tokens shaped `pts_test_…`; no hashing, no storage, no issuance.
 */
export class FakeLocalVerifier implements AuthVerifier {
  constructor(private tokens: Record<string, Principal>) {}
  static fromJson(json: string | undefined) {
    try { const v = JSON.parse(json || '{}'); return new FakeLocalVerifier(v && typeof v === 'object' ? v : {}); } catch { return new FakeLocalVerifier({}); }
  }
  async verify(request: Request): Promise<Principal | null> {
    const m = /^Bearer\s+(pts_test_[A-Za-z0-9]{16,64})$/i.exec(request.headers.get('authorization') ?? '');
    return m ? this.tokens[m[1]] ?? null : null;
  }
}

/** Every request must carry a valid key (401 otherwise). Sets the principal for later checks. */
export function requireAuth(getVerifier: (c: Context) => AuthVerifier): MiddlewareHandler {
  return async (c, next) => {
    const hasHeader = /^Bearer\s+\S+$/i.test(c.req.header('authorization') ?? '');
    if (!hasHeader) throw problem(401, 'api_key_missing', { detail: 'Send Authorization: Bearer <your API key>.' }, { 'WWW-Authenticate': 'Bearer realm="paidtosort"' });
    const p = await getVerifier(c).verify(c.req.raw);
    if (!p) throw problem(401, 'api_key_invalid', { detail: 'The key is unknown, revoked or expired.' }, { 'WWW-Authenticate': 'Bearer realm="paidtosort", error="invalid_token"' });
    c.set('principal' as never, p as never);
    await next();
  };
}

export const principalOf = (c: Context): Principal => c.get('principal' as never) as Principal;
export const hasScope = (p: Principal, s: Scope) => p.scopes.includes(s);
/** Function-level check: 403 `forbidden` with `need` = the missing scope. Object-level checks live in scanner/access.ts. */
export function requireScope(c: Context, s: Scope): Principal {
  const p = principalOf(c);
  if (!hasScope(p, s)) throw problem(403, 'forbidden', { need: s, detail: `This key needs the ${s} scope.` });
  return p;
}

/** Fail-closed verifier for shared deploys until A&S's real verifier lands: every key is refused (401). */
export class DenyAllVerifier implements AuthVerifier {
  async verify(): Promise<Principal | null> { return null; }
}
