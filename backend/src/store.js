import { randomUUID } from 'node:crypto';

/**
 * In-memory trace store with TTL eviction.
 * Production should use object storage with a shorter TTL; see docs/ARCHITECTURE.md.
 */
export function createTraceStore({ ttlMs }) {
  const traces = new Map();
  const analyses = new Map();

  function now() {
    return Date.now();
  }

  function evictExpired() {
    const t = now();
    for (const [id, entry] of traces) {
      if (entry.expiresAt <= t) {
        traces.delete(id);
        analyses.delete(id);
      }
    }
  }

  return {
    put({ traceEvents, meta }) {
      evictExpired();
      const id = randomUUID();
      const createdAt = now();
      traces.set(id, {
        id,
        createdAt,
        expiresAt: createdAt + ttlMs,
        meta: meta || {},
        traceEvents,
      });
      return { id, createdAt, expiresAt: createdAt + ttlMs };
    },
    get(id) {
      evictExpired();
      return traces.get(id) || null;
    },
    setAnalysis(id, analysis) {
      analyses.set(id, { ...analysis, cachedAt: now() });
    },
    getAnalysis(id) {
      return analyses.get(id) || null;
    },
    delete(id) {
      traces.delete(id);
      analyses.delete(id);
    },
    size() {
      return traces.size;
    },
  };
}
