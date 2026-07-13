# tinbase benchmark — Zerops recipe

See the [root README](../README.md) · backend: **[tinbase.dev](https://www.tinbase.dev)** · SDK: **[@supabase/supabase-js](https://github.com/supabase/supabase-js)**

## Recipe metadata

- **Name:** <!-- #ZEROPS_EXTRACT_START:name# -->tinbase benchmark<!-- #ZEROPS_EXTRACT_END:name# -->
- **Shape:** <!-- #ZEROPS_EXTRACT_START:shape# -->app<!-- #ZEROPS_EXTRACT_END:shape# --> — you fork and deploy your own copy
- **Environments:** `AI Agent` · `Remote (CDE)` · `Local` · `Stage` · `Small Production` · `HA Production`

## Tagline

<!-- #ZEROPS_EXTRACT_START:intro# -->
Three services: the tinbase backend, a managed Postgres under it, and a dashboard
that benchmarks tinbase through the unmodified @supabase/supabase-js SDK — live in
the browser. tinbase and the benchmark are separate services, wired over Zerops.
<!-- #ZEROPS_EXTRACT_END:intro# -->

## Overview

<!-- #ZEROPS_EXTRACT_START:description# -->
[tinbase](https://www.tinbase.dev) is a Supabase-compatible backend — PostgREST,
GoTrue auth, Storage, Realtime and a Studio dashboard — that speaks the same wire
protocol as hosted Supabase, so `@supabase/supabase-js` talks to it unchanged. As of
0.10 it runs against an external Postgres (`--database-url`). This recipe wires it
to a **managed Zerops PostgreSQL**, so the data is durable and managed while tinbase
supplies the Supabase-shaped API and Studio.

Crucially, the pieces are kept as **separate services**, the way you'd actually run
them:

- **`tinbase`** — the real backend, deployed as its own service (from the
  [tinbase-zerops](https://github.com/fxck/tinbase-zerops) repo), bound to `db`,
  with REST + Studio on its own subdomain.
- **`db`** — the managed PostgreSQL the backend runs against.
- **`dashboard`** — our benchmark *client* (this repo). It doesn't embed or proxy
  tinbase; it drives it through supabase-js: server-side over the internal network
  (`http://tinbase:3000`) and, in a live panel, from the browser against tinbase's
  public subdomain. It mints the anon / service_role keys from the shared
  `TINBASE_JWT_SECRET`, so it needs no tinbase dependency of its own.

Three workloads — bulk insert, point-select by id, and an indexed filtered query —
each a real `supabase.from(...).insert()/.select()` call, stream throughput and
p50/p95/p99 latency to a canvas dashboard over SSE. Because tinbase is stateless
(its data is in `db`), both runtime services scale horizontally — see the HA tier.
<!-- #ZEROPS_EXTRACT_END:description# -->

## Features

<!-- #ZEROPS_EXTRACT_START:features# -->
- **Real separation of concerns** — tinbase (the product) and the benchmark (our client) are distinct services, not one process; wired over Zerops' internal network.
- **Supabase API over a managed database** — durable, backed-up Postgres; tinbase is the API layer, not the store.
- **Unmodified supabase-js** — every workload is a real `supabase.from(...).insert()/.select()` call, server-side and in the browser (cross-origin, CORS-clean).
- **Keys minted from a shared secret** — the dashboard derives the anon / service_role JWTs from `TINBASE_JWT_SECRET`; no tinbase dependency in the client.
- **Live throughput + real percentiles** — canvas chart sampled every 150 ms; p50/p95/p99/max per run.
- **Studio on its own subdomain** — tinbase's dashboard for table editing, SQL, and live logs against the managed db.
- **Horizontally scalable** — tinbase holds no state, so the HA tier runs many backend + dashboard containers over one HA Postgres.
- **One recipe, three services** — `db` + `tinbase` (from tinbase-zerops) + `dashboard` (this repo), deployed together.
<!-- #ZEROPS_EXTRACT_END:features# -->

## First-run setup

<!-- #ZEROPS_EXTRACT_START:takeover-guide# -->
**Open the dashboard.** Its subdomain is the benchmark UI. Pick a workload, set
operations + concurrency, hit **Run benchmark**. **Open Studio ↗** links to
tinbase's own subdomain (`/_/`).

**Secrets and wiring are automatic.** `TINBASE_JWT_SECRET` is generated once as a
**project** variable, shared by `tinbase` (which signs the keys) and `dashboard`
(which mints matching keys). `DATABASE_URL` for tinbase is built from the managed
db's superuser credentials. The dashboard finds tinbase at `http://tinbase:3000`
(internal) and `${tinbase_zeropsSubdomain}` (browser).

**tinbase connects to `db` as the superuser** — it bootstraps the `anon` /
`authenticated` / `service_role` roles on first start, which needs `CREATEROLE`.
This is expected for a Supabase-shaped role model.
<!-- #ZEROPS_EXTRACT_END:takeover-guide# -->

## Knowledge base

<!-- #ZEROPS_EXTRACT_START:knowledge-base# -->
### Architecture

```
                         @supabase/supabase-js
                          (server + browser)
                                  │
   dashboard ───────────────────►│
   (this repo)   http://tinbase:3000  /  ${tinbase_zeropsSubdomain}
                                  ▼
                              tinbase ──► db  (managed PostgreSQL)
                     (tinbase-zerops repo, --database-url)
```

- **tinbase** builds from [tinbase-zerops](https://github.com/fxck/tinbase-zerops)
  (`zeropsSetup: tinbase`) and runs `tinbase start --host 0.0.0.0 --port 3000`,
  reading `DATABASE_URL`. It applies `supabase/migrations/*.sql` idempotently.
- **dashboard** builds from this repo (`zeropsSetup: dashboard`) and benchmarks
  tinbase through supabase-js. Keys are minted locally from `TINBASE_JWT_SECRET`.
- **db** is the managed PostgreSQL; only `tinbase` connects to it.

### Why tinbase needs the superuser, and why keys are shared

tinbase creates the PostgREST role model on the target database, which needs
`CREATEROLE` — so `DATABASE_URL` uses `${db_superUser}`. The anon / service_role
keys are HMAC-signed Supabase JWTs derived from `TINBASE_JWT_SECRET`; the dashboard
mints them from the same project-level secret, so it never has to call tinbase to
fetch keys. Every container that signs or mints keys must share that secret →
project scope.

### Scaling

tinbase keeps no state (it's in `db`), so both runtime services scale horizontally.
The **HA Production** tier runs 2–4 `tinbase` and 2–4 `dashboard` containers behind
the Zerops L7 balancer over one HA Postgres; `http://tinbase:3000` load-balances
across the tinbase containers via internal DNS. (Realtime CDC fan-out across many
tinbase instances is still maturing upstream; the benchmark exercises REST.)

### Environment variables

- `TINBASE_JWT_SECRET` (project, auto-generated) — shared signing secret.
- `DATABASE_URL` (tinbase, wired) — `postgresql://${db_superUser}:${db_superUserPassword}@${db_hostname}:${db_port}/${db_dbName}`.
- `TINBASE_INTERNAL_URL` (dashboard) — `http://tinbase:3000`.
- `TINBASE_PUBLIC_URL` (dashboard) — `${tinbase_zeropsSubdomain}` (browser demo + Studio link).

### Troubleshooting

- **Dashboard stuck on "booting tinbase…"** — it can't reach the tinbase service; check that `tinbase` is deployed and healthy and that `TINBASE_INTERNAL_URL` is `http://tinbase:3000`.
- **`permission denied to create role` in tinbase logs** — `DATABASE_URL` isn't the superuser.
- **Browser panel fails but server-side works** — the browser hits tinbase's public subdomain cross-origin; ensure `tinbase` has subdomain access enabled (the recipe sets it).
<!-- #ZEROPS_EXTRACT_END:knowledge-base# -->
