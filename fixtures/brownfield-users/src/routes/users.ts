import { Router } from "express";
import { z } from "zod";
import { ProblemError } from "../http/problem.js";
import type { UserStore } from "../store.js";

const CreateUser = z.object({
  email: z.email(),
  name: z.string().min(1).max(200),
});

const UserParams = z.object({ id: z.string().regex(/^\d+$/, "id must be numeric") });

export function createUsersRouter(store: UserStore): Router {
  const usersRouter = Router();

  // TODO: this grows without bound — needs pagination.
  usersRouter.get("/", (_req, res) => {
    res.json({ data: store.list() });
  });

  // Legacy endpoint kept for the mobile app (pre-dates the API standards).
  usersRouter.get("/getUserByEmail", (req, res) => {
    const email = String(req.query.email);
    const user = store.findByEmail(email);
    if (!user) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(user);
  });

  usersRouter.get("/:id", (req, res) => {
    const { id } = UserParams.parse(req.params);
    const user = store.get(id);
    if (!user) throw new ProblemError(404, "not-found", "User not found", `No user with id ${id}`);
    res.json({ data: user });
  });

  usersRouter.post("/", (req, res) => {
    const input = CreateUser.parse(req.body);
    const user = store.create(input);
    res.status(201).location(`/v1/users/${user.id}`).json({ data: user });
  });

  usersRouter.delete("/:id", (req, res) => {
    const { id } = UserParams.parse(req.params);
    store.remove(id);
    res.json({ deleted: true });
  });

  return usersRouter;
}
