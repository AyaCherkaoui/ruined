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

/** A required external API key is not set. Kept generic so any future integration can throw it for a clear 503 instead of crashing. */
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
