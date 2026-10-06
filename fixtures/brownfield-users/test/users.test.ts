import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

describe("users", () => {
  it("creates and fetches a user", async () => {
    const app = createApp();
    const created = await request(app).post("/v1/users").send({ email: "ada@example.com", name: "Ada" });
    expect(created.status).toBe(201);
    expect(created.headers["location"]).toBe("/v1/users/1");

    const fetched = await request(app).get("/v1/users/1");
    expect(fetched.status).toBe(200);
    expect(fetched.body.data.email).toBe("ada@example.com");
  });

  it("rejects an invalid body with a 422 problem document", async () => {
    const res = await request(createApp()).post("/v1/users").send({ email: "nope", name: "Ada" });
    expect(res.status).toBe(422);
    expect(res.headers["content-type"]).toContain("application/problem+json");
    expect(res.body).toMatchObject({ type: "https://api.sf/problems/validation", status: 422, instance: "/v1/users" });
  });
});
