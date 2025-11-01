# Changes & How to Test Them

This document summarizes the code changes I made to the TaskFlow project, why they were made, and how to run and test them locally. It also lists troubleshooting tips for common errors you might encounter (Redis, migrations, JWT, etc.).

## Summary of major changes

- Implemented a Redis-backed distributed cache service with bulk operations and statistics:
  - File: `src/common/services/cache.service.ts`
  - Adds: `mset`, `mget`, `getStats`, improved error handling, graceful shutdown.

- Implemented a Redis-based distributed rate limiter and decorator/guard:
  - Files:
    - `src/common/services/rate-limiter.service.ts` (new/updated)
    - `src/common/decorators/rate-limit.decorator.ts` (metadata for per-route limits)
    - `src/common/guards/rate-limit.guard.ts` (uses `RateLimiterService`)
  - Usage: `@RateLimit({ limit, windowMs })` on controllers/routes.
  - Sets standard headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`.

- Added refresh-token support at the database and migration level:
  - Migration file: `src/database/migrations/1710752400000-CreateInitialSchema.ts`
  - Table: `refresh_tokens` (columns: `id`, `token`, `expires_at`, `is_revoked`, `user_id`, timestamps)

- Fixed and improved migration runner script to fallback and directly create tables when no migrations run:
  - File: `src/database/run-migrations.ts` (now creates `users`, `tasks`, and `refresh_tokens` if migrations are not executed)

- Tasks controller rate-limit configuration and other improvements:
  - File: `src/modules/tasks/tasks.controller.ts` (route-level rate limits applied)
  - `TasksModule` exports adjusted for repository injection by scheduled tasks
  - File: `src/modules/tasks/tasks.module.ts`

- Fixed DI issue for scheduled tasks queue (exports adjusted so `OverdueTasksService` can inject the `Task` repository):
  - Files: `src/queues/scheduled-tasks/overdue-tasks.service.ts`, `src/queues/scheduled-tasks/scheduled-tasks.module.ts`

- Misc small improvements:
  - `src/app.module.ts` updated to register and export `RateLimiterService` and `CacheService` providers
  - `.env` updated with `JWT_SECRET` and `JWT_REFRESH_SECRET` variables that the app requires


## Files changed / created (high-level)

- src/common/services/cache.service.ts (updated)
- src/common/services/rate-limiter.service.ts (new)
- src/common/guards/rate-limit.guard.ts (updated)
- src/common/decorators/rate-limit.decorator.ts (updated)
- src/common/services/cache.module.ts (if present) or CacheModule import changes
- src/modules/tasks/tasks.controller.ts (updated rate limits)
- src/modules/tasks/tasks.module.ts (exports fixed)
- src/app.module.ts (providers/exports adjusted)
- src/database/run-migrations.ts (updated)
- src/database/migrations/1710752400000-CreateInitialSchema.ts (contains refresh_tokens)
- src/queues/scheduled-tasks/overdue-tasks.service.ts (checked)
- src/queues/scheduled-tasks/scheduled-tasks.module.ts (imports verified)
- .env (added JWT secrets)

(There were ~20 edits overall — the list above contains the most relevant, high-impact files changed.)


## Environment / prerequisites

- Bun is the primary package runner used by this repository (scripts in `package.json` use Bun). The project previously had npm scripts too. Use the commands below for Bun-based workflows.
- PostgreSQL (ensure a database exists, e.g. `taskflow`)
- Redis (used by cache and rate limiter)

Make sure your `.env` (or environment) contains at least:

```properties
DB_HOST=localhost
DB_PORT=5432
DB_USERNAME=postgres
DB_PASSWORD=postgres
DB_DATABASE=taskflow

JWT_SECRET=<a strong secret>
JWT_REFRESH_SECRET=<another strong secret>
JWT_EXPIRATION=1d
JWT_REFRESH_EXPIRATION=7d

REDIS_HOST=localhost
REDIS_PORT=6379

PORT=3000
NODE_ENV=development
```


## How to run (quick)

1. Install dependencies with Bun (or use npm if you prefer):

```bash
bun install
# or
npm install
```

2. Build TypeScript (important prior to some migration steps):

```bash
bun run build
# or
npm run build
```

3. Run migrations.

Two options are provided in this repo:

- Standard: run formal TypeORM migrations (if configured):

```bash
bun run migration:run
# or
npm run migration:run
```

- Fallback/custom script (safe): this script will attempt to run migrations and, if none run, will create required tables directly (users, tasks, refresh_tokens):

```bash
bun run migration:custom
# or
npm run migration:custom
```

4. Seed initial data (optional but recommended):

```bash
bun run seed
# or
npm run seed
```

5. Start the development server:

```bash
bun run start:dev
# or
npm run start:dev
```

Open Swagger docs at: http://localhost:3000/api


## How to test the main flows (curl/Postman)

1. Register a user

POST http://localhost:3000/auth/register

Body (JSON):
```json
{
  "email": "test@example.com",
  "password": "Password123!",
  "name": "Test User"
}
```

2. Login to get an access token and refresh token

POST http://localhost:3000/auth/login

Body (JSON):
```json
{ "email": "test@example.com", "password": "Password123!" }
```

Response should include an `accessToken` (use with `Authorization: Bearer <token>`) and a `refreshToken`.

3. Create a task (authenticated)

POST http://localhost:3000/tasks
Headers: `Authorization: Bearer <accessToken>`

Body (JSON):
```json
{
  "title": "My task",
  "description": "Do the thing",
  "priority": "HIGH",
  "dueDate": "2025-12-01T00:00:00Z"
}
```

4. Get tasks

GET http://localhost:3000/tasks
Headers: `Authorization: Bearer <accessToken>`


## Rate limiting

- You can apply per-route rate limits using the `@RateLimit({ limit, windowMs })` decorator.
- Common headers returned on responses:
  - `X-RateLimit-Limit`
  - `X-RateLimit-Remaining`
  - `X-RateLimit-Reset`

Examples in the code:
- `POST /tasks` — more restrictive write limit
- `GET /tasks` — standard listing limit
- `GET /tasks/:id` — higher limit for lookups


## Cache service

- The `CacheService` now uses Redis and supports `set`, `get`, `delete`, `clear`, `has` plus `mset`, `mget`, and `getStats`.
- Use `namespace` when setting cache entries to group keys (e.g. `users`, `tasks`).


## Troubleshooting (common errors & fixes)

1. ECONNREFUSED to Redis (server logs show `ECONNREFUSED 127.0.0.1:6379`)
   - Ensure Redis is installed and running.
   - On Windows you can run Redis via WSL or install a Windows port.
   - Quick WSL start example:

```bash
# in WSL
sudo service redis-server start
redis-cli ping
```

2. JwtStrategy requires a secret or key
   - Ensure `JWT_SECRET` (and `JWT_REFRESH_SECRET`) are present in your `.env` and the app restarted.

3. Migrations not creating tables
   - Run `bun run migration:custom` to force creation if `migration:run` reports "no migrations pending".

4. Port 3000 already in use
   - Run `netstat -ano | findstr :3000` (Windows) and kill any process using that port.


## Verification checklist (quick)

- [ ] `.env` contains DB, Redis and JWT settings
- [ ] Redis is running and reachable at `REDIS_HOST:REDIS_PORT`
- [ ] PostgreSQL `taskflow` database is created and migrations ran (or custom script executed)
- [ ] App server starts without errors
- [ ] Use Postman/Swagger to register/login and create a task
- [ ] Rate limit headers appear when calling the endpoints
- [ ] Cache stats are available via `CacheService.getStats()` (programmatic)


## Next steps / Suggestions

- Add a health-check endpoint (database, redis, queue) and wire it to a monitoring system.
- Add global exception filter / structured logging to centralize error handling.
- Add integration tests for rate limiter and cache behavior.
- Add more TypeORM migrations for incremental DB changes and remove direct-table creation fallback once migrations are stable.


---

If you want, I can:
- Generate a short script to run the common verification steps automatically.
- Add a `README.md` (project root) merging these changes into the main repository README.
- Help you run the Postman / curl tests right now (I can run sample curl commands here and show expected output).

Tell me which of the above you'd like me to do next.