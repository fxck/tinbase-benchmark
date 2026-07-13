# tinbase benchmark — Zerops recipe

See the [root README](../README.md) · backend: **[tinbase.dev](https://www.tinbase.dev)** · SDK: **[@supabase/supabase-js](https://github.com/supabase/supabase-js)**

## Recipe metadata

- **Name:** <!-- #ZEROPS_EXTRACT_START:name# -->tinbase benchmark<!-- #ZEROPS_EXTRACT_END:name# -->
- **Shape:** <!-- #ZEROPS_EXTRACT_START:shape# -->app<!-- #ZEROPS_EXTRACT_END:shape# --> — you fork and deploy your own copy
- **Environments:** `AI Agent` · `Remote (CDE)` · `Local` · `Stage` · `Small Production` · `HA Production` — the full dev-lifecycle ladder, from an agent-driven dev/stage pair up to a horizontally-scaled HA cluster

## Tagline

<!-- #ZEROPS_EXTRACT_START:intro# -->
tinbase gives you the Supabase API — REST, Auth, Storage, Studio — on top of a
Postgres you already run. This recipe points it at a managed Zerops PostgreSQL and
benchmarks it through the unmodified @supabase/supabase-js SDK, live in the browser.
<!-- #ZEROPS_EXTRACT_END:intro# -->

## Overview

<!-- #ZEROPS_EXTRACT_START:description# -->
[tinbase](https://www.tinbase.dev) is a Supabase-compatible backend — PostgREST,
GoTrue auth, Storage, Realtime and a Studio dashboard — that speaks the same wire
protocol as hosted Supabase, so the official `@supabase/supabase-js` SDK talks to
it unchanged. As of 0.10 it can run against **an external Postgres you already
run** (`--database-url`) instead of an embedded engine. This recipe wires it to a
**managed Zerops PostgreSQL** service, so your data is durable, backed-up and
scalable — while tinbase supplies the Supabase-shaped API and Studio on top.

The app is a live benchmark. A Node process boots tinbase against the managed `db`,
reverse-proxies the Supabase API + Studio through one public URL, and drives three
workloads — bulk insert, point-select by id, and an indexed filtered query —
**through supabase-js**, streaming throughput and p50/p95/p99 latency to a
dependency-free canvas dashboard over SSE. A side panel runs supabase-js *in the
browser* against the same origin, proving client-side compatibility too.

Because the data lives in the managed database, the tinbase container is
effectively stateless — which is why this recipe ships the whole ladder, including
a horizontally-scaled **HA Production** tier (many app containers, one HA Postgres)
that an in-process database could never support.
<!-- #ZEROPS_EXTRACT_END:description# -->

## Features

<!-- #ZEROPS_EXTRACT_START:features# -->
- **Supabase API over a managed database** — tinbase serves REST/Auth/Storage/Studio on top of a durable, backed-up Zerops PostgreSQL, not an ephemeral in-process engine.
- **Unmodified supabase-js** — every benchmark workload is a real `supabase.from(...).insert()/.select()` call; the exact SDK you'd use against hosted Supabase.
- **Runs in the browser too** — a panel drives `supabase-js` client-side against the same origin, proving end-to-end wire compatibility.
- **Live throughput + real percentiles** — ops/sec sampled every 150 ms on a canvas chart; p50/p95/p99/max reported per run, not just an average.
- **Three workloads** — bulk insert, point-select by id, and an indexed filtered query, each exercising a different path through PostgREST → Postgres.
- **Studio in the box** — the Supabase-style dashboard is proxied at `/_/` for table editing, SQL, and live logs against the managed db.
- **Stateless app tier** — state lives in the managed database, so the runtime scales horizontally; the HA tier proves it.
- **One repo, one click** — a single Node service + a managed Postgres deploy as a complete project from this recipe.
<!-- #ZEROPS_EXTRACT_END:features# -->

## First-run setup

<!-- #ZEROPS_EXTRACT_START:takeover-guide# -->
**Nothing to configure — just open the app.** The public URL is the `app`
service's subdomain (or attach your own domain in Project → Public Access). The
dashboard, the REST API, and the Studio all share that one origin. Pick a workload,
set operations + concurrency, and hit **Run benchmark**.

**Secrets are generated for you.** `TINBASE_JWT_SECRET` is created once as a
**project** secret (`<@generateRandomString(<48>)>`) so every app container agrees
on the anon / service_role keys — important for the multi-container HA tier. The
managed database credentials are wired automatically.

**tinbase connects to the managed db as the superuser.** `DATABASE_URL` in
`zerops.yaml` is built from `${db_superUser}` / `${db_superUserPassword}` — tinbase
bootstraps the `anon`, `authenticated` and `service_role` roles on first start,
which needs `CREATEROLE`. The regular database user is not privileged enough; this
is expected for a Supabase-shaped role model.

**Open Studio to inspect data.** Click **Open Studio ↗** (or visit `/_/`) to browse
the `bench` table, run SQL, and watch live logs — all against the managed Postgres.
<!-- #ZEROPS_EXTRACT_END:takeover-guide# -->

## Knowledge base

<!-- #ZEROPS_EXTRACT_START:knowledge-base# -->
### Architecture

```
@supabase/supabase-js  →  tinbase (REST/Auth/Storage/Studio)  →  managed Zerops PostgreSQL (db)
```

- **app** (Node, Ubuntu runtime) — spawns `tinbase start --database-url $DATABASE_URL`
  on `127.0.0.1:54321`, reverse-proxies every non-app path (`/_/`, `/rest`, `/auth`,
  `/storage`, `/realtime`, …) to it, and runs the benchmark engine: a worker pool
  that drives the loopback REST API through supabase-js, times each request, and
  streams progress over SSE.
- **db** (managed `postgresql`) — the real database. tinbase reads
  `supabase/migrations/*.sql` on start (the `bench` table + `reset_bench()` RPC)
  and applies them idempotently, exactly like the Supabase CLI. Data is durable
  across redeploys and container cycles.

### Why the superuser connection

tinbase creates the PostgREST role model (`anon`, `authenticated`, `service_role`)
on the target database. Creating roles needs the `CREATEROLE` attribute, which the
default Zerops database user lacks — so `DATABASE_URL` uses `${db_superUser}`. On a
regular user tinbase fails at startup with `permission denied to create role`.

### Scaling — and why an HA tier now exists

With state in the managed database, the tinbase container holds no durable data, so
it scales horizontally: the **HA Production** tier runs multiple `app` containers
against one HA Postgres. tinbase's bootstrap is idempotent and "never assumes an
empty or exclusive DB", so concurrent containers share the database safely for
REST / Auth / Storage. (Realtime CDC fan-out across many instances is still
maturing upstream — the benchmark exercises REST, which is unaffected.) All
containers must share `TINBASE_JWT_SECRET` (set at project scope) so they issue and
accept the same keys.

### Environment variables

- `TINBASE_JWT_SECRET` (project secret, auto-generated) — signs the anon / service_role JWTs; shared by every app container.
- `DATABASE_URL` (wired in `zerops.yaml`) — `postgresql://${db_superUser}:${db_superUserPassword}@${db_hostname}:${db_port}/${db_dbName}`.
- `PORT` (automatic) — public HTTP port; the app binds `0.0.0.0:3000`.

### Troubleshooting

- **`permission denied to create role` in logs** — `DATABASE_URL` is using a non-superuser. Use `${db_superUser}` / `${db_superUserPassword}`.
- **Dashboard stuck on "booting tinbase…"** — check the app logs for the `[tinbase] connecting to external postgres at db:5432/db` line; if absent, `DATABASE_URL` is unset or the `db` service isn't reachable yet (it has `priority: 10` so it starts first).
- **Write throughput looks modest** — each op is a full PostgREST → Postgres round-trip through supabase-js; raise concurrency to push it. Read workloads (point-select, filter) are much faster.
<!-- #ZEROPS_EXTRACT_END:knowledge-base# -->
