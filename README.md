# tinbase benchmark

A live benchmark dashboard for **[tinbase](https://www.tinbase.dev)** — a
Supabase-compatible backend (PostgREST + GoTrue + Storage + Realtime) that runs
**Postgres in-process**, no Docker, no separate database server.

The app boots tinbase inside the same Node process, reverse-proxies its
**Studio** (`/_/`) and REST API through one public origin, then hammers the REST
API with configurable workloads and streams live **throughput** and **latency
percentiles** (p50/p95/p99) to a canvas dashboard over Server-Sent Events.

## What it does

- One `nodejs` service. tinbase **is** the database (PGlite — Postgres compiled
  to WASM), so there is nothing else to provision.
- Three server-side workloads against the loopback REST API:
  - **Bulk insert** — row inserts, measures write throughput.
  - **Point select (by id)** — indexed single-row reads.
  - **Filtered query** — `n>=? order limit` over an indexed column.
- Adjustable operation count + concurrency; live ops/sec chart, latency
  percentiles, and a per-run history table.
- The embedded **Studio** is reachable at `/_/` on the same URL — browse the
  `bench` table, run SQL, watch logs while a benchmark is running.

## Run it locally

```bash
npm install
node server.js
# dashboard  → http://localhost:3000
# studio     → http://localhost:3000/_/
```

`TINBASE_JWT_SECRET` (any 32+ char string) fixes the anon / service_role keys;
`TINBASE_ENGINE` selects `wasm` (default, runs anywhere) or `native` (embedded
Postgres, glibc hosts only).

## Deploy to Zerops

One click via the recipe in [`.zerops-recipe/`](./.zerops-recipe) — pick an
environment tier and deploy. See that folder for details.

## How it's wired

- [`server.js`](./server.js) — boots tinbase as a child process, proxies the
  Supabase API + Studio, runs the benchmark engine, streams SSE.
- [`supabase/migrations/0001_bench.sql`](./supabase/migrations/0001_bench.sql) —
  the `bench` table + index + a `reset_bench()` RPC. tinbase applies it on start,
  exactly like the Supabase CLI.
- [`public/`](./public) — dependency-free dashboard (vanilla canvas charts).
- [`zerops.yaml`](./zerops.yaml) — Zerops build/run pipeline.
