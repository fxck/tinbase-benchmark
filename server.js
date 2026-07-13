'use strict';

/**
 * tinbase benchmark — tinbase as a Supabase-compatible API layer over a MANAGED
 * Zerops PostgreSQL, benchmarked THROUGH the official @supabase/supabase-js SDK.
 *
 *  - Boots tinbase (REST + Auth + Storage + Studio) as a child process, pointed
 *    at the managed `db` service via `--database-url` (new in tinbase 0.10). The
 *    data is durable in the managed Postgres, not an in-process engine.
 *  - Points the unmodified supabase-js client at tinbase (`createClient`) — the
 *    same call you'd use against hosted Supabase — and runs every benchmark
 *    workload through `supabase.from(...).insert()/.select()`.
 *  - Reverse-proxies the Supabase API + Studio (`/_/`) through this origin, so the
 *    BROWSER can also talk to tinbase with supabase-js (see public/app.js).
 *  - Streams live throughput / latency to the dashboard over SSE.
 */

const path = require('path');
const { spawn, execFileSync } = require('child_process');
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { createClient } = require('@supabase/supabase-js');

const APP_PORT = Number(process.env.PORT) || 3000;
const TB_PORT = 54321;
const TB_URL = `http://127.0.0.1:${TB_PORT}`;
const SECRET =
  process.env.TINBASE_JWT_SECRET ||
  'super-secret-jwt-token-with-at-least-32-characters-long';
// tinbase runs against this managed Postgres (Zerops `db`) instead of an
// embedded engine. Must be the SUPERUSER connection: tinbase bootstraps the
// anon/authenticated/service_role roles, which needs CREATEROLE.
const DATABASE_URL = process.env.DATABASE_URL;
const TB_BIN = path.join(__dirname, 'node_modules', '.bin', 'tinbase');
const READSET = 20000; // rows seeded for read-oriented workloads

let ANON_KEY = null;
let SERVICE_KEY = null;
let tbReady = false;
let running = false;
let sb = null; // the supabase-js client under test (service_role)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// tinbase lifecycle
// ---------------------------------------------------------------------------

function loadKeys() {
  const out = execFileSync(TB_BIN, ['keys'], {
    env: { ...process.env, TINBASE_JWT_SECRET: SECRET },
    encoding: 'utf8',
  });
  const jwts = out.match(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g) || [];
  ANON_KEY = jwts[0];
  SERVICE_KEY = jwts[1];
  if (!ANON_KEY || !SERVICE_KEY) throw new Error('could not parse tinbase keys');
}

function startTinbase() {
  const child = spawn(
    TB_BIN,
    ['start', '--database-url', DATABASE_URL, '--host', '127.0.0.1',
      '--port', String(TB_PORT), '--dir', __dirname],
    {
      cwd: __dirname,
      env: { ...process.env, TINBASE_JWT_SECRET: SECRET },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  child.stdout.on('data', (d) => process.stdout.write(`[tinbase] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[tinbase] ${d}`));
  child.on('exit', (code) => {
    console.error(`[tinbase] exited with code ${code} — shutting down`);
    process.exit(1);
  });
  return child;
}

async function waitReady() {
  for (let i = 0; i < 120; i++) {
    const { error } = await sb
      .from('bench')
      .select('id', { head: true, count: 'exact' });
    if (!error) return true;
    await sleep(1000);
  }
  throw new Error('tinbase did not become ready in time');
}

// ---------------------------------------------------------------------------
// data helpers — all through the SDK
// ---------------------------------------------------------------------------

async function countRows() {
  const { count } = await sb
    .from('bench')
    .select('id', { count: 'exact', head: true });
  return count || 0;
}

async function resetTable() {
  await sb.rpc('reset_bench'); // exposed as POST /rest/v1/rpc/reset_bench
}

async function bulkSeed(count, onBatch) {
  const BATCH = 1000;
  let inserted = 0;
  while (inserted < count) {
    const size = Math.min(BATCH, count - inserted);
    const rows = new Array(size);
    for (let i = 0; i < size; i++) {
      rows[i] = { label: 'seed', n: Math.floor(Math.random() * 1000) };
    }
    // v2 insert() returns nothing by default (Prefer: return=minimal).
    await sb.from('bench').insert(rows);
    inserted += size;
    if (onBatch) onBatch(inserted, count);
  }
}

// ---------------------------------------------------------------------------
// Benchmark workloads — each is a supabase-js call, shown verbatim in the UI
// ---------------------------------------------------------------------------

const WORKLOADS = {
  insert: {
    label: 'Bulk insert',
    snippet:
      "await supabase\n  .from('bench')\n  .insert({ label: 'bench', n })",
    op: (i) => sb.from('bench').insert({ label: 'bench', n: i % 1000 }),
  },
  select: {
    label: 'Point select (by id)',
    snippet:
      "await supabase\n  .from('bench')\n  .select('*')\n  .eq('id', id)\n  .single()",
    op: (i) => sb.from('bench').select('*').eq('id', 1 + (i % READSET)).single(),
  },
  filter: {
    label: 'Filtered query (indexed + order + limit)',
    snippet:
      "await supabase\n  .from('bench')\n  .select('id, label, n')\n  .gte('n', lo)\n  .order('n')\n  .limit(20)",
    op: (i) =>
      sb.from('bench').select('id,label,n').gte('n', i % 900).order('n', { ascending: true }).limit(20),
  },
};

async function prepare(workload, emit) {
  if (workload === 'insert') {
    emit('prepare', { message: 'Resetting table…' });
    await resetTable();
    return;
  }
  const have = await countRows();
  if (have !== READSET) {
    emit('prepare', { message: `Seeding ${READSET.toLocaleString()} rows…`, done: 0, total: READSET });
    await resetTable();
    await bulkSeed(READSET, (done, total) =>
      emit('prepare', { message: `Seeding ${total.toLocaleString()} rows via supabase-js…`, done, total })
    );
  }
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function runBenchmark({ workload, total, concurrency }, emit) {
  const spec = WORKLOADS[workload];
  await prepare(workload, emit);

  const latencies = new Float64Array(total);
  let next = 0;
  let done = 0;
  let errors = 0;
  const startedAt = performance.now();
  let lastTick = startedAt;
  let lastDone = 0;

  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= total) break;
      const t0 = performance.now();
      const { error } = await spec.op(i);
      if (error) errors++;
      latencies[i] = performance.now() - t0;
      done++;

      const now = performance.now();
      if (now - lastTick >= 150) {
        const inst = ((done - lastDone) / (now - lastTick)) * 1000;
        emit('progress', {
          done, total, errors,
          elapsedMs: now - startedAt,
          instThroughput: inst,
          avgThroughput: (done / (now - startedAt)) * 1000,
        });
        lastTick = now;
        lastDone = done;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker));

  const durationMs = performance.now() - startedAt;
  const sorted = Array.from(latencies).sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);

  return {
    workload,
    workloadLabel: spec.label,
    count: total,
    concurrency,
    errors,
    durationMs,
    throughput: (total / durationMs) * 1000,
    latency: {
      min: sorted[0],
      mean: sum / sorted.length,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
      max: sorted[sorted.length - 1],
    },
  };
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const app = express();
app.disable('x-powered-by');

app.get('/health', (_req, res) => res.json({ ok: true, tbReady }));

app.get('/api/status', (_req, res) => {
  res.json({
    tbReady,
    running,
    sdk: '@supabase/supabase-js',
    anonKey: ANON_KEY,
    engine: 'managed Zerops PostgreSQL',
    restBase: '/rest/v1',
    studioPath: '/_/',
    readset: READSET,
    workloads: Object.fromEntries(
      Object.entries(WORKLOADS).map(([k, v]) => [k, { label: v.label, snippet: v.snippet }])
    ),
  });
});

app.post('/api/reset', express.json(), async (_req, res) => {
  if (!tbReady) return res.status(503).json({ error: 'tinbase not ready' });
  try {
    await resetTable();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get('/api/run', async (req, res) => {
  if (!tbReady) return res.status(503).end('tinbase not ready');
  if (running) return res.status(409).end('a benchmark is already running');

  const workload = String(req.query.workload || 'insert');
  if (!WORKLOADS[workload]) return res.status(400).end('unknown workload');
  const total = Math.max(1, Math.min(500000, Number(req.query.total) || 20000));
  const concurrency = Math.max(1, Math.min(256, Number(req.query.concurrency) || 32));

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const emit = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  running = true;
  emit('start', {
    workload,
    workloadLabel: WORKLOADS[workload].label,
    snippet: WORKLOADS[workload].snippet,
    total, concurrency,
  });
  try {
    const summary = await runBenchmark({ workload, total, concurrency }, emit);
    emit('done', summary);
  } catch (e) {
    emit('error', { message: String(e && e.message ? e.message : e) });
  } finally {
    running = false;
    res.end();
  }
});

app.use('/assets', express.static(path.join(__dirname, 'public')));
// serve the browser build of supabase-js so the dashboard can talk to tinbase
// with the very same SDK, client-side.
app.get('/vendor/supabase.js', (_req, res) =>
  res.sendFile(path.join(__dirname, 'node_modules', '@supabase', 'supabase-js', 'dist', 'umd', 'supabase.js'))
);
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Everything else (Studio at /_/, /rest, /auth, /storage, /realtime, …) → tinbase.
const proxy = createProxyMiddleware({ target: TB_URL, changeOrigin: true, ws: true, logLevel: 'warn' });
app.use((req, res, next) => {
  if (
    req.path === '/' ||
    req.path.startsWith('/api/') ||
    req.path.startsWith('/assets/') ||
    req.path.startsWith('/vendor/')
  ) return next();
  return proxy(req, res, next);
});

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

(async function main() {
  const server = app.listen(APP_PORT, '0.0.0.0', () =>
    console.log(`benchmark dashboard on :${APP_PORT}`)
  );
  server.on('upgrade', proxy.upgrade);

  try {
    if (!DATABASE_URL) throw new Error('DATABASE_URL is not set (managed db not wired)');
    loadKeys();
    // The headline: the unmodified official SDK, pointed at tinbase.
    sb = createClient(TB_URL, SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    startTinbase();
    await waitReady();
    // a few rows so the very first page load (and Studio) show real data, not [].
    if ((await countRows()) === 0) {
      await sb.from('bench').insert(
        Array.from({ length: 5 }, (_, i) => ({ label: 'demo', n: i })));
    }
    tbReady = true;
    console.log('[tinbase] ready — backed by managed Zerops PostgreSQL, REST + Studio live');
  } catch (e) {
    console.error('[tinbase] failed to start:', e);
  }
})();
