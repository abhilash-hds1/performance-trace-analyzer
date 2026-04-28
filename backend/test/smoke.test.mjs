import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/server.js';
import { reduceTrace } from '../src/reducer.js';

const sampleEvents = [
  { name: 'RunTask', cat: 'devtools.timeline', ph: 'X', ts: 1000, dur: 120000, args: { data: { url: 'https://example.com/app.js' } } },
  { name: 'Layout', cat: 'devtools.timeline', ph: 'X', ts: 130000, dur: 8000 },
  { name: 'EvaluateScript', cat: 'devtools.timeline', ph: 'X', ts: 140000, dur: 65000, args: { data: { url: 'https://example.com/big.js' } } },
  { name: 'Paint', cat: 'devtools.timeline', ph: 'X', ts: 210000, dur: 3000 },
];

test('reducer surfaces long tasks deterministically', () => {
  const { compactSummary, stats } = reduceTrace({ traceEvents: sampleEvents });
  assert.equal(stats.totalEvents, 4);
  assert.ok(compactSummary.totals.longTaskCount >= 2);
  const top = compactSummary.topLongTasks[0];
  assert.ok(top.durationMs >= 120, `expected >=120ms got ${top.durationMs}`);
  assert.equal(top.name, 'RunTask');
});

test('POST /traces then /analyze returns structured stub', async () => {
  process.env.OPENAI_API_KEY = '';
  const app = await buildApp();
  try {
    const upload = await app.inject({
      method: 'POST',
      url: '/traces',
      payload: { traceEvents: sampleEvents },
    });
    assert.equal(upload.statusCode, 201);
    const uploadBody = upload.json();
    assert.ok(uploadBody.traceId);
    assert.ok(uploadBody.compactSummary);

    const analyze = await app.inject({
      method: 'POST',
      url: `/traces/${uploadBody.traceId}/analyze`,
    });
    assert.equal(analyze.statusCode, 200);
    const body = analyze.json();
    assert.equal(body.source, 'stub');
    assert.ok(Array.isArray(body.analysis.bottlenecks));
    assert.ok(['low', 'medium', 'high'].includes(body.analysis.confidence));
  } finally {
    await app.close();
  }
});

test('400 when traceEvents missing/empty', async () => {
  const app = await buildApp();
  try {
    const empty = await app.inject({ method: 'POST', url: '/traces', payload: { traceEvents: [] } });
    assert.equal(empty.statusCode, 400);
    const bad = await app.inject({ method: 'POST', url: '/traces', payload: { foo: 1 } });
    assert.equal(bad.statusCode, 400);
  } finally {
    await app.close();
  }
});
