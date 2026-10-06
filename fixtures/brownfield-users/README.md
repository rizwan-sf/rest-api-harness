# users-service (brownfield fixture)

A small existing Express + Zod API used as the starting point for brownfield harness tasks.
It is *mostly* compliant, but carries legacy debt the harness baseline will record:

- `GET /v1/users/getUserByEmail` — verb in path, unvalidated `req.query`, non-RFC 7807 404
- `DELETE /v1/users/:id` — returns a JSON body instead of `204 No Content`
- `GET /v1/users` — unpaginated
