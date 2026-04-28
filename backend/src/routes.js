import { reduceTrace } from './reducer.js';
import { analyzeCompactSummary, stubAnalysisFor } from './llm.js';
import {
  parseGithubRepo,
  githubContextKey,
  fetchRepoSnippets,
  fetchGithubComponentsFolder,
  normalizeGithubComponentsPath,
  githubCorrelationPayload,
  stripInternalAnalysisFields,
} from './github.js';

const TRACE_BODY_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    traceEvents: { type: 'array' },
    metadata: { type: 'object' },
    meta: { type: 'object' },
  },
};

function shapeTraceInput(body) {
  if (Array.isArray(body)) return { traceEvents: body, meta: {} };
  if (body && Array.isArray(body.traceEvents)) {
    return { traceEvents: body.traceEvents, meta: body.meta || body.metadata || {} };
  }
  return null;
}

export async function registerRoutes(fastify, { store }) {
  fastify.get('/health', async () => ({
    ok: true,
    storedTraces: store.size(),
    uptimeSec: Math.floor(process.uptime()),
  }));

  fastify.post(
    '/traces',
    {
      schema: {
        body: TRACE_BODY_SCHEMA,
      },
    },
    async (req, reply) => {
      const shaped = shapeTraceInput(req.body);
      if (!shaped) {
        return reply.code(400).send({ error: 'Expected { traceEvents: [...] } or array of events' });
      }
      if (shaped.traceEvents.length === 0) {
        return reply.code(400).send({ error: 'traceEvents is empty' });
      }

      const { compactSummary, stats } = reduceTrace(shaped);
      const stored = store.put({
        traceEvents: shaped.traceEvents,
        meta: { ...shaped.meta, stats },
      });

      return reply.code(201).send({
        traceId: stored.id,
        createdAt: stored.createdAt,
        expiresAt: stored.expiresAt,
        stats,
        compactSummary,
      });
    },
  );

  fastify.get('/traces/:id', async (req, reply) => {
    const entry = store.get(req.params.id);
    if (!entry) return reply.code(404).send({ error: 'trace not found or expired' });
    const { compactSummary, stats } = reduceTrace({ traceEvents: entry.traceEvents });
    return {
      traceId: entry.id,
      createdAt: entry.createdAt,
      expiresAt: entry.expiresAt,
      stats,
      compactSummary,
    };
  });

  fastify.post('/traces/:id/analyze', async (req, reply) => {
    const id = req.params.id;
    const entry = store.get(id);
    if (!entry) return reply.code(404).send({ error: 'trace not found or expired' });

    const force = req.query && (req.query.force === '1' || req.query.force === 'true');
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const parsed =
      parseGithubRepo(body.githubRepo) || parseGithubRepo(entry.meta?.githubRepo);
    const fromBody =
      body.githubComponentsPath != null ? String(body.githubComponentsPath).trim() : '';
    const fromMeta =
      entry.meta?.githubComponentsPath != null
        ? String(entry.meta.githubComponentsPath).trim()
        : '';
    const trimmedComp = fromBody || fromMeta;
    let componentsPathNorm = null;
    if (trimmedComp) {
      componentsPathNorm = normalizeGithubComponentsPath(trimmedComp);
      if (!componentsPathNorm) {
        return reply.code(400).send({
          error:
            'Invalid githubComponentsPath: use a repo-relative folder (no .., no leading slash). Example: slow-shop-angular/src/app/components',
        });
      }
    }

    if (componentsPathNorm && !parsed) {
      return reply
        .code(400)
        .send({ error: 'githubComponentsPath requires githubRepo (org/repo or github.com URL).' });
    }

    const analyzeGithubKey = githubContextKey(parsed, componentsPathNorm) ?? null;

    if (!force) {
      const cached = store.getAnalysis(id);
      const cachedKey = cached?.analyzeGithubKey ?? null;
      if (cached && cachedKey === analyzeGithubKey) {
        return { traceId: id, cached: true, ...stripInternalAnalysisFields(cached) };
      }
    }

    const { compactSummary } = reduceTrace({ traceEvents: entry.traceEvents });

    let githubBundle = null;
    if (parsed && componentsPathNorm) {
      const comp = await fetchGithubComponentsFolder(parsed, componentsPathNorm);
      if (comp.error) {
        return reply.code(400).send({ error: comp.error });
      }
      githubBundle = {
        mode: 'components',
        label: `${parsed.owner}/${parsed.repo}`,
        ref: parsed.ref,
        componentsPath: componentsPathNorm,
        snippets: comp.snippets,
        pathsAttempted: comp.pathsAttempted,
      };
    } else if (parsed) {
      const { snippets, pathsAttempted } = await fetchRepoSnippets(parsed, compactSummary);
      githubBundle = {
        mode: 'auto',
        label: `${parsed.owner}/${parsed.repo}`,
        ref: parsed.ref,
        snippets,
        pathsAttempted,
      };
    }

    const githubCorrelation = githubCorrelationPayload(githubBundle);

    try {
      const result = await analyzeCompactSummary(compactSummary, { githubBundle });
      store.setAnalysis(id, { ...result, analyzeGithubKey, githubCorrelation });
      return {
        traceId: id,
        cached: false,
        ...stripInternalAnalysisFields({ ...result, analyzeGithubKey, githubCorrelation }),
      };
    } catch (err) {
      req.log.error(
        { err: { message: err.message, status: err.status, code: err.code } },
        'analyze failed; falling back to deterministic stub',
      );
      const fallback = {
        source: 'stub',
        model: null,
        analysis: stubAnalysisFor(compactSummary, githubBundle),
        upstreamError: {
          message: err.message,
          status: err.status || null,
          code: err.code || null,
        },
      };
      store.setAnalysis(id, { ...fallback, analyzeGithubKey, githubCorrelation });
      return reply.code(200).send({
        traceId: id,
        cached: false,
        ...stripInternalAnalysisFields({ ...fallback, analyzeGithubKey, githubCorrelation }),
      });
    }
  });

  fastify.delete('/traces/:id', async (req, reply) => {
    const entry = store.get(req.params.id);
    if (!entry) return reply.code(404).send({ error: 'trace not found' });
    store.delete(req.params.id);
    return reply.code(204).send();
  });
}
