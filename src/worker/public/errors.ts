/**
 * RFC 9457 problem details.
 *
 * Every failure a third-party integrator can hit comes back in one shape, with
 * a stable machine-readable `code` they can branch on and a `request_id` they
 * can quote in a support thread. The alternative — ad-hoc `{error: "..."}`
 * strings — forces integrators to match on prose that we are then unable to
 * reword without breaking them.
 *
 * `type` is a URI per the RFC. It is a documentation link, not a namespace to
 * dereference at runtime.
 */

export type ProblemCode =
  | "unauthorized"
  | "forbidden"
  | "insufficient_scope"
  | "not_found"
  | "method_not_allowed"
  | "invalid_request"
  | "validation_failed"
  | "version_conflict"
  | "idempotency_conflict"
  | "rate_limited"
  | "not_configured"
  | "internal_error";

const STATUS_BY_CODE: Record<ProblemCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  insufficient_scope: 403,
  not_found: 404,
  method_not_allowed: 405,
  invalid_request: 400,
  validation_failed: 422,
  version_conflict: 409,
  idempotency_conflict: 409,
  rate_limited: 429,
  not_configured: 501,
  internal_error: 500
};

const TITLE_BY_CODE: Record<ProblemCode, string> = {
  unauthorized: "Not authenticated",
  forbidden: "Not permitted",
  insufficient_scope: "Insufficient scope",
  not_found: "Not found",
  method_not_allowed: "Method not allowed",
  invalid_request: "Invalid request",
  validation_failed: "Validation failed",
  version_conflict: "Version conflict",
  idempotency_conflict: "Idempotency key reused",
  rate_limited: "Rate limit exceeded",
  not_configured: "Capability not configured",
  internal_error: "Internal error"
};

const DOCS_BASE = "https://developers.creative-agent.dev/errors";

export class ApiProblem extends Error {
  constructor(
    public code: ProblemCode,
    public detail: string,
    /** Field-level failures, for `validation_failed`. */
    public errors?: Array<{ field: string; message: string }>
  ) {
    super(detail);
  }

  get status(): number {
    return STATUS_BY_CODE[this.code];
  }

  toResponse(requestId: string): Response {
    const body: Record<string, unknown> = {
      type: `${DOCS_BASE}/${this.code}`,
      title: TITLE_BY_CODE[this.code],
      status: this.status,
      detail: this.detail,
      code: this.code,
      request_id: requestId
    };
    if (this.errors?.length) body.errors = this.errors;
    return new Response(JSON.stringify(body), {
      status: this.status,
      headers: {
        // The RFC's media type, so generic clients recognise it as an error
        // document rather than a resource.
        "content-type": "application/problem+json; charset=utf-8",
        // Error bodies carry a request id and depend on the credential, so they
        // must not be cached or shared between callers.
        "cache-control": "no-store",
        "x-request-id": requestId
      }
    });
  }
}

export const problem = {
  unauthorized: (detail = "A valid API key or embed token is required.") =>
    new ApiProblem("unauthorized", detail),
  forbidden: (detail: string) => new ApiProblem("forbidden", detail),
  scope: (scope: string) =>
    new ApiProblem("insufficient_scope", `This credential is missing the "${scope}" scope.`),
  notFound: (what: string) => new ApiProblem("not_found", `${what} does not exist.`),
  invalid: (detail: string) => new ApiProblem("invalid_request", detail),
  validation: (errors: Array<{ field: string; message: string }>) =>
    new ApiProblem("validation_failed", "One or more fields are invalid.", errors),
  conflict: (detail: string) => new ApiProblem("version_conflict", detail),
  rateLimited: () =>
    new ApiProblem("rate_limited", "Too many requests. Retry after a short delay."),
  notConfigured: (what: string) =>
    new ApiProblem("not_configured", `${what} is not configured on this deployment.`),
  methodNotAllowed: () => new ApiProblem("method_not_allowed", "This method is not supported here.")
};

/** Correlates a client-visible failure with the structured server log. */
export function newRequestId(): string {
  return `req_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}
