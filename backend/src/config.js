import 'dotenv/config';

function parseIntEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function parseOriginsEnv(raw) {
  if (!raw) return ['chrome-extension://*'];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export const config = Object.freeze({
  port: parseIntEnv('PORT', 8787),
  host: process.env.HOST || '127.0.0.1',
  allowedOrigins: parseOriginsEnv(process.env.ALLOWED_EXTENSION_ORIGINS),
  openai: {
    apiKey: (process.env.OPENAI_API_KEY || '').trim(),
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  },
  maxTraceBytes: parseIntEnv('MAX_TRACE_BYTES', 25 * 1024 * 1024),
  traceTtlMs: parseIntEnv('TRACE_TTL_MS', 30 * 60 * 1000),
  github: {
    clientId: process.env.GITHUB_CLIENT_ID || '',
    clientSecret: process.env.GITHUB_CLIENT_SECRET || '',
    /** Optional PAT for private repos and higher rate limits on Contents API */
    token: (process.env.GITHUB_TOKEN || '').trim(),
  },
});

export function hasOpenAI() {
  return Boolean(config.openai.apiKey);
}
