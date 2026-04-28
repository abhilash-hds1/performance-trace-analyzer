import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config } from './config.js';
import { createTraceStore } from './store.js';
import { registerRoutes } from './routes.js';

function originAllowed(origin, patterns) {
  if (!origin) return true;
  for (const p of patterns) {
    if (p === '*' || p === origin) return true;
    if (p.endsWith('*')) {
      const prefix = p.slice(0, -1);
      if (origin.startsWith(prefix)) return true;
    }
  }
  return false;
}

export async function buildApp() {
  const fastify = Fastify({
    logger: { level: process.env.LOG_LEVEL || 'info' },
    bodyLimit: config.maxTraceBytes,
    disableRequestLogging: false,
  });

  await fastify.register(cors, {
    origin: (origin, cb) => {
      if (originAllowed(origin, config.allowedOrigins)) {
        cb(null, true);
        return;
      }
      cb(new Error('Origin not allowed'), false);
    },
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    credentials: false,
    maxAge: 86400,
  });

  fastify.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body, done) => {
      if (!body) return done(null, undefined);
      done(null, undefined);
    },
  );

  fastify.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    return payload;
  });

  const store = createTraceStore({ ttlMs: config.traceTtlMs });
  await registerRoutes(fastify, { store });
  return fastify;
}

async function main() {
  const app = await buildApp();
  try {
    await app.listen({ port: config.port, host: config.host });
    app.log.info(
      { port: config.port, host: config.host, model: config.openai.model, openaiConfigured: Boolean(config.openai.apiKey) },
      'perf-trace-analyzer backend listening',
    );
  } catch (err) {
    app.log.error(err, 'failed to start');
    process.exit(1);
  }
}

const entry = process.argv[1] ? resolve(process.argv[1]) : '';
const here = fileURLToPath(import.meta.url);
if (entry && resolve(entry) === here) {
  main();
}
