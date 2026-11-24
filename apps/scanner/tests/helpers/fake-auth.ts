// TEST ONLY. Maps opaque in-memory `pts_test_…` tokens to principals. Injected by tests/helpers/harness.ts; never shipped
// in the Pages bundle and never selected by an env var.
import type { AuthVerifier, Principal } from '../../src/platform/auth';

/**
 * Test/dev stand-in. Takes a map of opaque bearer tokens to principals (from the gitignored .dev.vars locally, or
 * built in memory by tests). It only accepts tokens shaped `pts_test_…`; no hashing, no storage, no issuance.
 */
export class FakeLocalVerifier implements AuthVerifier {
  constructor(private tokens: Record<string, Principal>) {}
  async verify(request: Request): Promise<Principal | null> {
    const m = /^Bearer\s+(pts_test_[A-Za-z0-9]{16,64})$/i.exec(request.headers.get('authorization') ?? '');
    return m ? this.tokens[m[1]] ?? null : null;
  }
}
