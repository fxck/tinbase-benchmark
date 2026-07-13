# tinbase benchmark

A live benchmark that puts **[tinbase](https://www.tinbase.dev)** — a
Supabase-compatible backend (PostgREST + GoTrue + Storage + Realtime + Studio) — in
front of a **managed PostgreSQL**, and drives it through the unmodified
**[@supabase/supabase-js](https://github.com/supabase/supabase-js)** SDK.

```
@supabase/supabase-js  →  tinbase (REST / Auth / Storage / Studio)  →  managed PostgreSQL
```

tinbase 0.10's `--database-url` lets it serve the Supabase API on top of a Postgres
you already run, instead of an embedded engine — so the data is durable and managed,
while tinbase supplies the Supabase-shaped API and Studio. The app boots tinbase
against the database, reverse-proxies its Studio (`/_/`) and REST API through one
public origin, then hammers the REST API with configurable workloads and streams
live **throughput** and **latency percentiles** (p50/p95/p99) to a canvas dashboard
over Server-Sent Events.

## What it does

- **tinbase over a managed Postgres** — durable, backed-up data; tinbase is the
  Supabase-compatible API layer, not the database.
- **Benchmarks through supabase-js** — each workload is a real
  `supabase.from('bench').insert()/.select()` call, the same SDK you'd use against
  hosted Supabase:
  - **Bulk insert** — write throughput.
  - **Point select (by id)** — indexed single-row reads.
  - **Filtered query** — `n>=? order limit` over an indexed column.
- **Runs in the browser too** — a panel drives supabase-js client-side against the
  same origin, proving end-to-end wire compatibility.
- **Studio in the box** — browse the `bench` table, run SQL, watch logs at `/_/`.

## Run it locally

```bash
npm install
# point it at any Postgres (needs a role with CREATEROLE for tinbase's bootstrap):
export DATABASE_URL="postgresql://user:pass@host:5432/dbname"
export TINBASE_JWT_SECRET="any-32+-char-string"
node server.js
# dashboard → http://localhost:3000   ·   studio → http://localhost:3000/_/
```

tinbase creates the `anon` / `authenticated` / `service_role` roles on first start,
so `DATABASE_URL` must use a **superuser** (or a role with `CREATEROLE`).

## Deploy to Zerops

One click via the recipe in [`.zerops-recipe/`](./.zerops-recipe) — pick an
environment tier (AI Agent · Remote CDE · Local · Stage · Small Production · HA
Production) and deploy. Each tier provisions a managed `db` and wires `DATABASE_URL`
automatically. See that folder for details.

## How it's wired

- [`server.js`](./server.js) — boots `tinbase start --database-url $DATABASE_URL`,
  proxies the Supabase API + Studio, runs the supabase-js benchmark engine, streams SSE.
- [`supabase/migrations/0001_bench.sql`](./supabase/migrations/0001_bench.sql) —
  the `bench` table + index + a `reset_bench()` RPC; tinbase applies it on start,
  exactly like the Supabase CLI.
- [`public/`](./public) — dependency-free dashboard (vanilla canvas charts) + a
  browser-side supabase-js demo.
- [`zerops.yaml`](./zerops.yaml) — Zerops build/run pipeline (Ubuntu runtime; `app`
  + `appdev` setups; `DATABASE_URL` wired from the managed `db`).
