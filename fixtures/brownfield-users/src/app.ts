import express, { type Express } from "express";
import { notFoundHandler, problemHandler } from "./http/problem.js";
import { createUsersRouter } from "./routes/users.js";
import { UserStore } from "./store.js";

export function createApp(deps: { store?: UserStore } = {}): Express {
  const store = deps.store ?? new UserStore();
  const app = express();
  app.use(express.json());
  app.use("/v1/users", createUsersRouter(store));
  app.use(notFoundHandler);
  app.use(problemHandler);
  return app;
}
