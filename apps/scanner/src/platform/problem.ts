// One error contract (#5), as RFC 9457 application/problem+json with `code` and `request_id` extension members
// (BEST-PRACTICE-CHECK.md #5). NOTE: the pts-v2 README #5 example shows {"error":{code,message,request_id}}.
// This WIP follows the parent's Nov 24 11:38 AM instruction (problem+json). Swapping shapes = change problemBody() only.
export interface ProblemExtras {
  detail?: string; need?: string; batch_id?: string; card_id?: string; first_card_id?: string; count?: number;
  retry_after_s?: number; limit?: 'hourly' | 'minute' | 'global_minute' | 'global_hourly' | number; limit_bytes?: number; errors?: { field: string; message: string }[];
}

const TITLES: Record<string, string> = {
  // platform codes (pts-v2 base #5, #12)
  not_found: 'Not found', method_not_allowed: 'Method not allowed', internal: 'Something went wrong on our side',
  db_unavailable: 'Database check failed', invalid_request: 'The request is not valid',
  api_key_missing: 'An API key is needed', api_key_invalid: 'This API key is not valid', forbidden: 'This key is not allowed to do that',
  idempotency_key_missing: 'An Idempotency-Key header is needed', idempotency_mismatch: 'This Idempotency-Key was used with a different request',
  rate_limited: 'Rate limit reached',
};
export const registerProblemTitles = (t: Record<string, string>) => Object.assign(TITLES, t);

export class ApiError extends Error {
  constructor(public status: number, public code: string, public extras: ProblemExtras = {}, public headers: Record<string, string> = {}) { super(code); }
}
export const problem = (status: number, code: string, extras?: ProblemExtras, headers?: Record<string, string>) => new ApiError(status, code, extras, headers);

export function problemBody(err: ApiError, instance: string, requestId: string) {
  const body: Record<string, unknown> = {
    type: `https://paidtosort.com/problems/${err.code.replace(/_/g, '-')}`,
    title: TITLES[err.code] ?? err.code, status: err.status, code: err.code, instance, request_id: requestId,
  };
  for (const [k, v] of Object.entries(err.extras)) if (v !== undefined) body[k] = v;
  return body;
}

export function problemResponse(err: ApiError, instance: string, requestId: string) {
  return new Response(JSON.stringify(problemBody(err, instance, requestId)), {
    status: err.status, headers: { 'content-type': 'application/problem+json', 'cache-control': 'no-store', 'x-request-id': requestId, ...err.headers },
  });
}
