# tinbase benchmark (dashboard)

A benchmark **client** for the [tinbase](https://www.tinbase.dev) backend. It drives
tinbase through the unmodified **[@supabase/supabase-js](https://github.com/supabase/supabase-js)**
SDK and streams live throughput + latency percentiles to a canvas dashboard.

This repo is *only the dashboard*. tinbase itself runs as a separate service — see
[**tinbase-zerops**](https://github.com/fxck/tinbase-zerops) — against a managed
Postgres:

```
this dashboard ──(supabase-js)──►  tinbase  ──►  managed PostgreSQL
   server-side: http://tinbase:3000
   browser:     tinbase's public subdomain
```

The dashboard holds no tinbase dependency. It mints the anon / service_role keys
from the shared `TINBASE_JWT_SECRET` (they're HMAC-signed Supabase JWTs) and talks to
tinbase over HTTP like any other client.

## What it does

- **Benchmarks through supabase-js** — each workload is a real
  `supabase.from('bench').insert()/.select()` call:
  - **Bulk insert** — write throughput.
  - **Point select (by id)** — indexed single-row reads.
  - **Filtered query** — `n>=? order limit` over an indexed column.
- **Live chart + percentiles** — ops/sec sampled every 150 ms; p50/p95/p99/max per run.
- **Browser demo** — a panel runs supabase-js *in the browser*, cross-origin against
  tinbase, proving client-side wire compatibility.
- **Links to Studio** — tinbase's dashboard on its own subdomain.

## Configuration

- `TINBASE_JWT_SECRET` (required) — shared with the tinbase service; used to mint keys.
- `TINBASE_INTERNAL_URL` (default `http://tinbase:3000`) — server-side benchmark target.
- `TINBASE_PUBLIC_URL` — tinbase's public URL for the browser demo + Studio link.

## Run it locally

```bash
npm install
export TINBASE_JWT_SECRET="same-secret-as-tinbase"
export TINBASE_INTERNAL_URL="http://localhost:54321"   # a running tinbase
export TINBASE_PUBLIC_URL="http://localhost:54321"
node server.js        # dashboard → http://localhost:3000
```

You need a tinbase instance to point at — run [tinbase-zerops](https://github.com/fxck/tinbase-zerops)
locally (`npm start`) against any Postgres.

## Deploy to Zerops

One click via the recipe in [`.zerops-recipe/`](./.zerops-recipe). Each tier
provisions three services — `db` (managed Postgres), `tinbase` (from
tinbase-zerops), and `dashboard` (this repo) — and wires them automatically. Tiers:
AI Agent · Remote CDE · Local · Stage · Small Production · HA Production.

## How it's wired

- [`server.js`](./server.js) — mints keys from the shared secret, points supabase-js
  at the tinbase service, runs the benchmark engine, streams SSE. No tinbase embedded.
- [`public/`](./public) — dependency-free dashboard (canvas charts) + browser supabase-js demo.
- [`zerops.yaml`](./zerops.yaml) — `dashboard` + `dashboarddev` setups; points at the
  `tinbase` service via internal DNS and its public subdomain.
