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

export function errorResponse(err: unknown): Response {
  if (err instanceof ApiError) return Response.json({ error: err.message, ...err.details }, { status: err.status });
  if (err instanceof PlanNotFoundError) return Response.json({ error: err.message }, { status: 404 });
  console.error(err);
  return Response.json({ error: "Internal server error" }, { status: 500 });
}
