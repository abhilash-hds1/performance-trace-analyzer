/**
 * Deterministic trace reducer.
 *
 * Input: Chrome DevTools / CDP `Tracing` output. Either:
 *   - { traceEvents: TraceEvent[], metadata?: object }
 *   - TraceEvent[] (Chrome array form)
 *
 * Output: a bounded `compactSummary` suitable for LLM input.
 *
 * Goals (per docs/ARCHITECTURE.md):
 *   - Never send full traceEvents to the model.
 *   - Surface the worst long tasks, slowest events, and URL/script hints.
 *   - Stay within byte/element caps regardless of trace size.
 */

const LONG_TASK_MIN_DURATION_MS = 50;
const TOP_EVENTS = 25;
const TOP_LONG_TASKS = 15;
const TOP_URLS = 25;
const TOP_FRAMES = 10;
const MAX_STRING_LEN = 240;

function trimStr(s) {
  if (typeof s !== 'string') return s;
  return s.length > MAX_STRING_LEN ? s.slice(0, MAX_STRING_LEN - 1) + '\u2026' : s;
}

function asEvents(input) {
  if (Array.isArray(input)) return input;
  if (input && Array.isArray(input.traceEvents)) return input.traceEvents;
  return [];
}

function safeNum(n) {
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

function pickUrl(args) {
  if (!args || typeof args !== 'object') return null;
  const data = args.data && typeof args.data === 'object' ? args.data : null;
  return (
    (data && (data.url || data.documentURL || data.scriptName || data.fileName)) ||
    args.url ||
    args.documentURL ||
    null
  );
}

function bucketCategory(name, cat) {
  const c = (cat || '').toLowerCase();
  const n = (name || '').toLowerCase();
  if (n.includes('runtask') || n === 'task') return 'task';
  if (n.includes('layout') || n.includes('reflow')) return 'layout';
  if (n.includes('paint') || n.includes('composite')) return 'paint';
  if (n.includes('parsehtml') || n.includes('parsecss')) return 'parse';
  if (n.includes('evaluatescript') || n.includes('functioncall') || n.includes('v8.')) return 'script';
  if (c.includes('devtools.timeline') && n.includes('xhr')) return 'network';
  if (c.includes('netlog') || n.includes('resource') || n.includes('request')) return 'network';
  if (n.includes('gc') || n.includes('majorgc') || n.includes('minorgc')) return 'gc';
  return 'other';
}

/**
 * @param {*} input - parsed JSON trace
 * @returns {{
 *   compactSummary: object,
 *   stats: { totalEvents: number, durationMs: number },
 * }}
 */
export function reduceTrace(input) {
  const events = asEvents(input);
  const totalEvents = events.length;

  let minTs = Number.POSITIVE_INFINITY;
  let maxTs = Number.NEGATIVE_INFINITY;
  const durByName = new Map();
  const countByCategory = new Map();
  const urlCounts = new Map();
  const longTasks = [];
  const topEvents = [];
  const frameCounts = new Map();

  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (!e || typeof e !== 'object') continue;
    const ts = safeNum(e.ts);
    const dur = safeNum(e.dur);
    if (ts) {
      if (ts < minTs) minTs = ts;
      if (ts > maxTs) maxTs = ts;
    }
    const name = typeof e.name === 'string' ? e.name : 'unknown';
    const cat = typeof e.cat === 'string' ? e.cat : '';
    const phase = e.ph;

    const bucket = bucketCategory(name, cat);
    countByCategory.set(bucket, (countByCategory.get(bucket) || 0) + 1);

    if (dur > 0 && (phase === 'X' || phase === 'x' || phase === 'B' || phase === 'E')) {
      durByName.set(name, (durByName.get(name) || 0) + dur);

      const durationMs = dur / 1000;
      const url = pickUrl(e.args);

      if (durationMs >= LONG_TASK_MIN_DURATION_MS) {
        longTasks.push({
          name,
          category: bucket,
          durationMs: Number(durationMs.toFixed(2)),
          tsMs: Number((ts / 1000).toFixed(2)),
          url: url ? trimStr(url) : null,
        });
      }

      topEvents.push({
        name,
        category: bucket,
        durationMs: Number(durationMs.toFixed(2)),
        url: url ? trimStr(url) : null,
      });
    }

    if (e.args && typeof e.args === 'object') {
      const url = pickUrl(e.args);
      if (url && typeof url === 'string') {
        urlCounts.set(url, (urlCounts.get(url) || 0) + 1);
      }
      const frame = e.args.frame || (e.args.data && e.args.data.frame);
      if (frame && typeof frame === 'string') {
        frameCounts.set(frame, (frameCounts.get(frame) || 0) + 1);
      }
    }
  }

  topEvents.sort((a, b) => b.durationMs - a.durationMs);
  longTasks.sort((a, b) => b.durationMs - a.durationMs);

  const topUrls = [...urlCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_URLS)
    .map(([url, count]) => ({ url: trimStr(url), count }));

  const topFrames = [...frameCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_FRAMES)
    .map(([frame, count]) => ({ frame, count }));

  const totalDurationByName = [...durByName.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_EVENTS)
    .map(([name, micro]) => ({ name, totalMs: Number((micro / 1000).toFixed(2)) }));

  const durationMs = Number.isFinite(minTs) && Number.isFinite(maxTs)
    ? Number(((maxTs - minTs) / 1000).toFixed(2))
    : 0;

  const compactSummary = {
    schemaVersion: 1,
    totals: {
      events: totalEvents,
      durationMs,
      longTaskCount: longTasks.length,
      categoryCounts: Object.fromEntries(countByCategory),
    },
    topLongTasks: longTasks.slice(0, TOP_LONG_TASKS),
    topEvents: topEvents.slice(0, TOP_EVENTS),
    topEventTotalsMs: totalDurationByName,
    topUrls,
    topFrames,
  };

  return {
    compactSummary,
    stats: { totalEvents, durationMs },
  };
}
