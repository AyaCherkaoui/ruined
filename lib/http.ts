import { PlanNotFoundError } from "./coverage";

/** An error with an HTTP status the API layer can return as-is. */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * A required external API key (XAI_API_KEY, ELEVENLABS_API_KEY, RESEND_API_KEY, ...) is not set.
 * Thrown by lib/grok.ts, lib/elevenlabs.ts and lib/resend.ts so a missing key is a clear 503, not
 * a crash -- tasks 3/4 are meant to "work automatically once the keys are added to .env".
 */
export class MissingApiKeyError extends Error {
  constructor(public envVar: string) {
    super(`${envVar} is not configured. Add it to .env to enable this feature.`);
    this.name = "MissingApiKeyError";
  }
}

export function errorResponse(err: unknown): Response {
  if (err instanceof ApiError) return Response.json({ error: err.message, ...err.details }, { status: err.status });
  if (err instanceof PlanNotFoundError) return Response.json({ error: err.message }, { status: 404 });
  if (err instanceof MissingApiKeyError) return Response.json({ error: err.message }, { status: 503 });
  console.error(err);
  return Response.json({ error: "Internal server error" }, { status: 500 });
}
