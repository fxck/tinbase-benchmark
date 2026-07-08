# tinbase benchmark — Zerops recipe

See the [root README](../README.md) · backend: **[tinbase.dev](https://www.tinbase.dev)**

## Recipe metadata

- **Name:** <!-- #ZEROPS_EXTRACT_START:name# -->tinbase benchmark<!-- #ZEROPS_EXTRACT_END:name# -->
- **Shape:** <!-- #ZEROPS_EXTRACT_START:shape# -->app<!-- #ZEROPS_EXTRACT_END:shape# --> — you fork and deploy your own copy
- **Environments:** `Local` · `Stage` · `Small Production` — a single always-on Node service; there is no HA tier because tinbase keeps its Postgres in-process (one database per container)

## Tagline

<!-- #ZEROPS_EXTRACT_START:intro# -->
A live benchmark for tinbase — a Supabase-compatible backend that runs Postgres
in-process. Hammer the REST API with insert/select/filter workloads and watch
throughput and p50/p95/p99 latency stream to the browser in real time.
<!-- #ZEROPS_EXTRACT_END:intro# -->

## Overview

<!-- #ZEROPS_EXTRACT_START:description# -->
tinbase is a Supabase-compatible backend — PostgREST, GoTrue auth, Storage and
Realtime — that runs an entire Postgres **inside the Node process** (PGlite, i.e.
Postgres compiled to WASM), with no Docker and no separate database server. This
recipe turns that into a benchmark you can actually see: one Node service boots
tinbase, reverse-proxies its Studio and REST API through a single public URL, and
then drives the REST layer with configurable workloads while streaming live
throughput and latency percentiles to a dependency-free canvas dashboard.

Three workloads ship in the box — bulk row inserts (write throughput), point
selects by primary key (indexed reads), and a filtered/ordered/limited query over
an indexed column. You control the operation count and the concurrency; the server
runs the load against the loopback REST API, times every request, and reports
ops/sec plus p50/p95/p99/max latency. The embedded **Studio** (`/_/`) rides the
same origin, so you can browse the `bench` table, run SQL, and watch server logs
while a run is in flight.

Because the database lives in the process, the whole backend is one container with
nothing else to provision. The tiers here scale that single service — a light
Local box to try it, a single-node Stage, and a Small Production setup with a
public subdomain — rather than adding infrastructure.
<!-- #ZEROPS_EXTRACT_END:description# -->

## Features

<!-- #ZEROPS_EXTRACT_START:features# -->
- **Zero-infrastructure backend** — tinbase runs Postgres in-process (PGlite/WASM); no Docker, no managed database, nothing else to provision.
- **Live throughput chart** — ops/sec sampled every 150 ms and drawn on a dependency-free canvas line chart as the run progresses.
- **Real latency percentiles** — every request is timed; p50/p95/p99/max are reported per run, not just an average.
- **Three workloads** — bulk insert, point-select by id, and an indexed filtered query, each exercising a different code path.
- **Server-side load generator** — the benchmark runs Node → loopback REST, so numbers reflect the backend, not browser/network noise.
- **Studio in the box** — the Supabase-style dashboard is proxied at `/_/` on the same URL for table editing, SQL, and live logs.
- **Supabase-wire-compatible** — the same PostgREST endpoints the official supabase-js SDK speaks; the REST API is public with the anon key.
- **One repo, one click** — a single monolithic Node service deploys as a complete project from this recipe.
<!-- #ZEROPS_EXTRACT_END:features# -->

## First-run setup

<!-- #ZEROPS_EXTRACT_START:takeover-guide# -->
**Nothing to configure — just open the app.** The public URL is the `app`
service's subdomain (or attach your own domain in Project → Public Access). The
dashboard, the REST API, and the Studio all share that one origin. Pick a
workload, set operations + concurrency, and hit **Run benchmark**.

**The JWT secret is generated for you.** `TINBASE_JWT_SECRET` is created as a
project secret on first import (`<@generateRandomString(<48>)>`). tinbase derives
the `anon` and `service_role` keys from it; the dashboard reads the anon key from
`/api/status` and shows it in the Connection panel. You never set it by hand.

**Open Studio to inspect data.** Click **Open Studio ↗** (or visit `/_/`) to
browse the `bench` table, run SQL, and watch live logs while a benchmark runs. The
`bench` table has RLS disabled, so the anon key can read it directly.

**Data is per-container and ephemeral.** PGlite persists to the container disk
(`/var/www/.tinbase`), so a redeploy or container cycle starts from an empty table
(migrations re-run automatically). That is intentional for a benchmark — keep the
service at **one container** (see the knowledge base).
<!-- #ZEROPS_EXTRACT_END:takeover-guide# -->

## Knowledge base

<!-- #ZEROPS_EXTRACT_START:knowledge-base# -->
### Architecture

One runtime service, no managed dependencies:

- **app** (Node) — an Express server that (1) spawns `tinbase start` as a child
  process on `127.0.0.1:54321`, (2) reverse-proxies every non-app path (`/_/`,
  `/rest`, `/auth`, `/storage`, `/realtime`, …) to it, and (3) runs the benchmark
  engine: a worker pool that drives the loopback REST API, times each request, and
  streams progress to the browser over Server-Sent Events. tinbase reads
  `supabase/migrations/*.sql` on start (the `bench` table + `reset_bench()` RPC),
  exactly like the Supabase CLI.

### Why there is no HA tier

tinbase stores its Postgres **in the process** (PGlite). Two app containers would
each hold a *separate* database, so a load balancer spreading requests across them
would read and write inconsistent data. Every tier therefore pins
`minContainers: 1` / `maxContainers: 1`. If you need a shared, horizontally-scaled
Postgres, that is a different architecture — point supabase-js at a managed
`postgresql` service instead of the in-process engine.

### Engine: wasm vs native

`TINBASE_ENGINE` selects the storage engine:

- **wasm** (default) — PGlite, Postgres compiled to WASM. Bundled in the npm
  package, single-threaded, and runs on the Alpine/musl runtime Zerops uses. This
  is what the tiers ship.
- **native** — tinbase's embedded Postgres. Faster and multi-connection, but the
  binary is glibc-only and **will not run on the musl-based `nodejs` runtime**
  (`initdb ENOENT`). Only set `TINBASE_ENGINE=native` on a glibc base image.

### Environment variables

- `TINBASE_JWT_SECRET` (secret, auto-generated) — signs the anon / service_role JWTs. Set as a project secret via `<@generateRandomString(<48>)>`; injected into `app`.
- `TINBASE_ENGINE` (optional) — `wasm` (default) or `native`. Leave unset on Zerops.
- `PORT` (automatic) — the public HTTP port; the app binds `0.0.0.0:3000`.

### Troubleshooting

- **Dashboard says "booting tinbase…" and never turns ready** — check the service logs for `[tinbase]`. On `native` engine you'll see `initdb ENOENT`; switch to `wasm` (unset `TINBASE_ENGINE`).
- **Numbers look low on write workloads** — expected: PGlite is single-threaded, so concurrent inserts serialize through one WASM instance. That is a real property of the in-process engine, not a bug — raise concurrency to watch latency climb while throughput plateaus.
- **Empty `bench` table after a redeploy** — by design; the in-process database is recreated and migrations re-run on every container start.
<!-- #ZEROPS_EXTRACT_END:knowledge-base# -->
