import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";

export const PROBLEM_CONTENT_TYPE = "application/problem+json";
const PROBLEM_BASE = "https://api.sf/problems";

export interface ProblemDocument {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
}

/** Throw this anywhere in a handler; the error middleware renders it as RFC 7807. */
export class ProblemError extends Error {
  constructor(
    readonly status: number,
    readonly slug: string,
    readonly title: string,
    readonly detail?: string,
  ) {
    super(detail ?? title);
  }
}

function isBodyParseError(err: unknown): boolean {
  return err instanceof SyntaxError && "status" in err && err.status === 400;
}

export function toProblem(err: unknown, instance: string): ProblemDocument {
  if (err instanceof ProblemError) {
    return {
      type: `${PROBLEM_BASE}/${err.slug}`,
      title: err.title,
      status: err.status,
      ...(err.detail !== undefined ? { detail: err.detail } : {}),
      instance,
    };
  }
  if (err instanceof ZodError) {
    return {
      type: `${PROBLEM_BASE}/validation`,
      title: "Request failed validation",
      status: 422,
      detail: err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
      instance,
    };
  }
  if (isBodyParseError(err)) {
    return { type: `${PROBLEM_BASE}/malformed-json`, title: "Malformed JSON body", status: 400, instance };
  }
  return { type: `${PROBLEM_BASE}/internal`, title: "Internal Server Error", status: 500, instance };
}

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new ProblemError(404, "not-found", "Resource not found", `No route for ${req.method} ${req.path}`));
};

export const problemHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const problem = toProblem(err, req.originalUrl);
  res.status(problem.status).type(PROBLEM_CONTENT_TYPE).json(problem);
};
