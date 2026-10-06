import express, { type Express } from "express";

/**
 * Harness contract: export createApp() returning the Express app.
 * Do not call listen() here — the harness boots the app itself to probe it.
 */
export function createApp(): Express {
  const app = express();
  app.use(express.json());
  return app;
}
