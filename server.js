'use strict';

/**
 * tinbase benchmark server.
 *
 *  - Boots tinbase (Supabase-compatible, in-process Postgres) as a child process.
 *  - Reverse-proxies the whole Supabase API surface + the Studio (`/_/`) through
 *    this public origin, so the dashboard and Studio share one URL.
 *  - Runs server-side benchmark workloads against the loopback REST API and
 *    streams live throughput / latency to the browser over SSE.
 */

const path = require('path');
const { spawn, execFileSync } = require('child_process');
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

const APP_PORT = Number(process.env.PORT) || 3000;
const TB_PORT = 54321;
const TB_URL = `http://127.0.0.1:${TB_PORT}`;
const SECRET =
  process.env.TINBASE_JWT_SECRET ||
  'super-secret-jwt-token-with-at-least-32-characters-long';
const TB_BIN = path.join(__dirname, 'node_modules', '.bin', 'tinbase');
// wasm (PGlite) is the default: pure WASM Postgres, bundled in the npm package,
// runs on musl/Alpine. `native` (embedded Postgres) needs a glibc host.
const TB_ENGINE = process.env.TINBASE_ENGINE || 'wasm';
const READSET = 20000; // rows seeded for read-oriented workloads

let ANON_KEY = null;
let SERVICE_KEY = null;
let tbReady = false;
let running = false; // one benchmark at a time

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const authHeaders = () => ({
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
});

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
    ['start', '--engine', TB_ENGINE, '--host', '127.0.0.1',
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
  for (let i = 0; i < 90; i++) {
    try {
      const r = await fetch(`${TB_URL}/rest/v1/bench?limit=1`, {
        headers: authHeaders(),
      });
      if (r.ok) return true;
    } catch (_) {
      /* not up yet */
    }
    await sleep(1000);
  }
  throw new Error('tinbase did not become ready in time');
}

// ---------------------------------------------------------------------------
// REST helpers
// ---------------------------------------------------------------------------

async function countRows() {
  const r = await fetch(`${TB_URL}/rest/v1/bench?select=id`, {
    method: 'HEAD',
    headers: { ...authHeaders(), Prefer: 'count=exact' },
  });
  const cr = r.headers.get('content-range') || '*/0';
  return Number(cr.split('/')[1] || 0);
}

async function resetTable() {
  await fetch(`${TB_URL}/rest/v1/rpc/reset_bench`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: '{}',
  });
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
    await fetch(`${TB_URL}/rest/v1/bench`, {
      method: 'POST',
      headers: {
        ...authHeaders(),
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(rows),
    });
    inserted += size;
    if (onBatch) onBatch(inserted, count);
  }
}

// ---------------------------------------------------------------------------
// Benchmark engine
// ---------------------------------------------------------------------------

const WORKLOADS = {
  insert: {
    label: 'Bulk insert',
    op: (i) =>
      fetch(`${TB_URL}/rest/v1/bench`, {
        method: 'POST',
        headers: {
          ...authHeaders(),
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({ label: 'bench', n: i % 1000 }),
      }),
  },
  select: {
    label: 'Point select (by id)',
    op: (i) =>
      fetch(
        `${TB_URL}/rest/v1/bench?id=eq.${1 + (i % READSET)}&select=*`,
        { headers: authHeaders() }
      ),
  },
  filter: {
    label: 'Filtered query (indexed + order + limit)',
    op: (i) =>
      fetch(
        `${TB_URL}/rest/v1/bench?n=gte.${i % 900}&select=id,label,n&order=n.asc&limit=20`,
        { headers: authHeaders() }
      ),
  },
};

async function prepare(workload, emit) {
  if (workload === 'insert') {
    emit('prepare', { message: 'Resetting table…' });
    await resetTable();
    return;
  }
  // read workloads need a deterministic working set of contiguous ids
  const have = await countRows();
  if (have !== READSET) {
    emit('prepare', { message: `Seeding ${READSET.toLocaleString()} rows…`, done: 0, total: READSET });
    await resetTable();
    await bulkSeed(READSET, (done, total) =>
      emit('prepare', { message: `Seeding ${total.toLocaleString()} rows…`, done, total })
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
      try {
        const res = await spec.op(i);
        if (!res.ok) errors++;
        // drain body so the socket is reusable
        await res.arrayBuffer();
      } catch (_) {
        errors++;
      }
      latencies[i] = performance.now() - t0;
      done++;

      const now = performance.now();
      if (now - lastTick >= 150) {
        const inst = ((done - lastDone) / (now - lastTick)) * 1000;
        emit('progress', {
          done,
          total,
          errors,
          elapsedMs: now - startedAt,
          instThroughput: inst,
          avgThroughput: (done / (now - startedAt)) * 1000,
        });
        lastTick = now;
        lastDone = done;
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, total) }, worker)
  );

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

// Our own routes first, then everything else proxies to tinbase.
app.get('/health', (_req, res) =>
  res.json({ ok: true, tbReady })
);

app.get('/api/status', (_req, res) => {
  res.json({
    tbReady,
    running,
    anonKey: ANON_KEY,
    engine: TB_ENGINE === 'wasm' ? 'wasm (PGlite — Postgres in WASM)' : TB_ENGINE,
    restBase: '/rest/v1',
    studioPath: '/_/',
    readset: READSET,
    workloads: Object.fromEntries(
      Object.entries(WORKLOADS).map(([k, v]) => [k, v.label])
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

// Server-Sent Events benchmark run.
app.get('/api/run', async (req, res) => {
  if (!tbReady) return res.status(503).end('tinbase not ready');
  if (running) return res.status(409).end('a benchmark is already running');

  const workload = String(req.query.workload || 'insert');
  if (!WORKLOADS[workload]) return res.status(400).end('unknown workload');
  const total = Math.max(1, Math.min(500000, Number(req.query.total) || 10000));
  const concurrency = Math.max(1, Math.min(256, Number(req.query.concurrency) || 16));

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const emit = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  running = true;
  emit('start', { workload, workloadLabel: WORKLOADS[workload].label, total, concurrency });
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
app.get('/', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

// Everything else (Studio at /_/, /rest, /auth, /storage, /realtime, …) → tinbase.
const proxy = createProxyMiddleware({
  target: TB_URL,
  changeOrigin: true,
  ws: true,
  logLevel: 'warn',
});
app.use((req, res, next) => {
  if (req.path === '/' || req.path.startsWith('/api/') || req.path.startsWith('/assets/')) {
    return next();
  }
  return proxy(req, res, next);
});

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

(async function main() {
  const server = app.listen(APP_PORT, '0.0.0.0', () =>
    console.log(`benchmark dashboard on :${APP_PORT}`)
  );
  server.on('upgrade', proxy.upgrade); // websockets → tinbase (Studio logs, realtime)

  try {
    loadKeys();
    startTinbase();
    await waitReady();
    tbReady = true;
    console.log('[tinbase] ready — REST + Studio live');
  } catch (e) {
    console.error('[tinbase] failed to start:', e);
    // dashboard still serves; /api/status reports tbReady=false
  }
})();
