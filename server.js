'use strict';

/**
 * Benchmark dashboard — a pure CLIENT of the tinbase backend.
 *
 * tinbase runs as its own service (hostname `tinbase`) against the managed
 * Postgres. This app does not embed or proxy it; it just points the official
 * @supabase/supabase-js client at tinbase and benchmarks it:
 *
 *   - server-side: supabase-js → http://tinbase:3000  (internal network)
 *   - browser:     supabase-js → tinbase's public subdomain  (see public/app.js)
 *
 * The anon / service_role keys are minted here from the shared TINBASE_JWT_SECRET
 * (the same HMAC-signed Supabase tokens tinbase itself issues) so this service
 * needs no tinbase dependency at all.
 */

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const APP_PORT = Number(process.env.PORT) || 3000;
const SECRET = process.env.TINBASE_JWT_SECRET;
const TINBASE_INTERNAL = process.env.TINBASE_INTERNAL_URL || 'http://tinbase:3000';
const TINBASE_PUBLIC = process.env.TINBASE_PUBLIC_URL || TINBASE_INTERNAL;
const READSET = 20000;

// --- mint the Supabase-style JWTs tinbase accepts, from the shared secret ------
function mintKey(role) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = enc({ alg: 'HS256', typ: 'JWT' });
  const body = enc({ iss: 'supabase', ref: 'tinbase', role, iat: 1700000000, exp: 2000000000 });
  const sig = crypto.createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}
const ANON_KEY = SECRET ? mintKey('anon') : null;
const SERVICE_KEY = SECRET ? mintKey('service_role') : null;

let tbReady = false;
let running = false;

const sb = createClient(TINBASE_INTERNAL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// data helpers — all through the SDK, against the tinbase service
// ---------------------------------------------------------------------------
async function waitReady() {
  for (let i = 0; i < 120; i++) {
    const { error } = await sb.from('bench').select('id', { head: true, count: 'exact' });
    if (!error) return true;
    await sleep(1000);
  }
  throw new Error('tinbase service did not become reachable in time');
}
async function countRows() {
  const { count } = await sb.from('bench').select('id', { count: 'exact', head: true });
  return count || 0;
}
async function resetTable() {
  await sb.rpc('reset_bench');
}
async function bulkSeed(count, onBatch) {
  const BATCH = 1000;
  let inserted = 0;
  while (inserted < count) {
    const size = Math.min(BATCH, count - inserted);
    const rows = new Array(size);
    for (let i = 0; i < size; i++) rows[i] = { label: 'seed', n: Math.floor(Math.random() * 1000) };
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
    snippet: "await supabase\n  .from('bench')\n  .insert({ label: 'bench', n })",
    op: (i) => sb.from('bench').insert({ label: 'bench', n: i % 1000 }),
  },
  select: {
    label: 'Point select (by id)',
    snippet: "await supabase\n  .from('bench')\n  .select('*')\n  .eq('id', id)\n  .single()",
    op: (i) => sb.from('bench').select('*').eq('id', 1 + (i % READSET)).single(),
  },
  filter: {
    label: 'Filtered query (indexed + order + limit)',
    snippet: "await supabase\n  .from('bench')\n  .select('id, label, n')\n  .gte('n', lo)\n  .order('n')\n  .limit(20)",
    op: (i) => sb.from('bench').select('id,label,n').gte('n', i % 900).order('n', { ascending: true }).limit(20),
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
      emit('prepare', { message: `Seeding ${total.toLocaleString()} rows via supabase-js…`, done, total }));
  }
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function runBenchmark({ workload, total, concurrency }, emit) {
  const spec = WORKLOADS[workload];
  await prepare(workload, emit);

  const latencies = new Float64Array(total);
  let next = 0, done = 0, errors = 0;
  const startedAt = performance.now();
  let lastTick = startedAt, lastDone = 0;

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
        emit('progress', {
          done, total, errors,
          elapsedMs: now - startedAt,
          instThroughput: ((done - lastDone) / (now - lastTick)) * 1000,
          avgThroughput: (done / (now - startedAt)) * 1000,
        });
        lastTick = now; lastDone = done;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker));

  const durationMs = performance.now() - startedAt;
  const sorted = Array.from(latencies).sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    workload, workloadLabel: spec.label, count: total, concurrency, errors, durationMs,
    throughput: (total / durationMs) * 1000,
    latency: {
      min: sorted[0], mean: sum / sorted.length,
      p50: percentile(sorted, 50), p95: percentile(sorted, 95),
      p99: percentile(sorted, 99), max: sorted[sorted.length - 1],
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
    engine: 'tinbase → managed Zerops PostgreSQL',
    anonKey: ANON_KEY,
    tinbaseUrl: TINBASE_PUBLIC,
    studioUrl: TINBASE_PUBLIC.replace(/\/$/, '') + '/_/',
    readset: READSET,
    workloads: Object.fromEntries(
      Object.entries(WORKLOADS).map(([k, v]) => [k, { label: v.label, snippet: v.snippet }])),
  });
});

app.post('/api/reset', express.json(), async (_req, res) => {
  if (!tbReady) return res.status(503).json({ error: 'tinbase not ready' });
  try { await resetTable(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get('/api/run', async (req, res) => {
  if (!tbReady) return res.status(503).end('tinbase not ready');
  if (running) return res.status(409).end('a benchmark is already running');
  const workload = String(req.query.workload || 'insert');
  if (!WORKLOADS[workload]) return res.status(400).end('unknown workload');
  const total = Math.max(1, Math.min(500000, Number(req.query.total) || 20000));
  const concurrency = Math.max(1, Math.min(256, Number(req.query.concurrency) || 32));

  res.writeHead(200, {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
    Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
  });
  const emit = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  running = true;
  emit('start', { workload, workloadLabel: WORKLOADS[workload].label, snippet: WORKLOADS[workload].snippet, total, concurrency });
  try {
    emit('done', await runBenchmark({ workload, total, concurrency }, emit));
  } catch (e) {
    emit('error', { message: String(e && e.message ? e.message : e) });
  } finally {
    running = false;
    res.end();
  }
});

app.use('/assets', express.static(path.join(__dirname, 'public')));
app.get('/vendor/supabase.js', (_req, res) =>
  res.sendFile(path.join(__dirname, 'node_modules', '@supabase', 'supabase-js', 'dist', 'umd', 'supabase.js')));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------
(async function main() {
  app.listen(APP_PORT, '0.0.0.0', () => console.log(`benchmark dashboard on :${APP_PORT}`));
  if (!SECRET) return console.error('TINBASE_JWT_SECRET not set — cannot mint keys');
  console.log(`[dashboard] benchmarking tinbase at ${TINBASE_INTERNAL} (public: ${TINBASE_PUBLIC})`);
  try {
    await waitReady();
    if ((await countRows()) === 0) {
      await sb.from('bench').insert(Array.from({ length: 5 }, (_, i) => ({ label: 'demo', n: i })));
    }
    tbReady = true;
    console.log('[dashboard] tinbase reachable — ready');
  } catch (e) {
    console.error('[dashboard] tinbase not reachable:', e.message);
  }
})();
