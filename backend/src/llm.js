import { config, hasOpenAI } from './config.js';

/**
 * JSON schema the model must conform to. Kept small and stable so the UI can
 * render results without parsing free-form prose.
 */
export const ANALYSIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'bottlenecks', 'recommendations', 'confidence'],
  properties: {
    summary: { type: 'string' },
    bottlenecks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'category', 'evidence', 'impact'],
        properties: {
          title: { type: 'string' },
          category: {
            type: 'string',
            enum: ['script', 'layout', 'paint', 'parse', 'network', 'gc', 'task', 'other'],
          },
          evidence: { type: 'string' },
          impact: { type: 'string', enum: ['low', 'medium', 'high'] },
          suspectUrl: { type: ['string', 'null'] },
        },
      },
    },
    recommendations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['action', 'rationale'],
        properties: {
          action: { type: 'string' },
          rationale: { type: 'string' },
          codePointer: { type: ['string', 'null'] },
        },
      },
    },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
  },
};

const SYSTEM_PROMPT = [
  'You are a web performance analyst.',
  'You are given a compact summary derived from a Chrome performance trace.',
  'Identify likely bottlenecks (long tasks, layout/paint thrash, heavy scripts, slow resources, GC).',
  'Rules:',
  '- Use ONLY information present in the provided summary; do not invent URLs or stacks.',
  '- Prefer specificity (event names, durations) over generic advice.',
  '- Output strictly conforms to the provided JSON schema.',
].join(' ');

/**
 * Deterministic stub used when no API key is configured. Picks the worst
 * long task / event and returns a structurally-correct analysis so the
 * extension UI can be developed end-to-end without spending on inference.
 */
function stubAnalysis(compactSummary) {
  const worstLong = compactSummary.topLongTasks?.[0];
  const worstEvent = compactSummary.topEvents?.[0];
  const bottlenecks = [];
  if (worstLong) {
    bottlenecks.push({
      title: `Long task in ${worstLong.name} (${worstLong.durationMs} ms)`,
      category: worstLong.category || 'task',
      evidence: `Long task ${worstLong.name} ran for ${worstLong.durationMs} ms at t=${worstLong.tsMs} ms.`,
      impact: worstLong.durationMs >= 200 ? 'high' : 'medium',
      suspectUrl: worstLong.url || null,
    });
  } else if (worstEvent) {
    bottlenecks.push({
      title: `Slow event: ${worstEvent.name} (${worstEvent.durationMs} ms)`,
      category: worstEvent.category || 'other',
      evidence: `${worstEvent.name} dominated ${worstEvent.durationMs} ms.`,
      impact: 'medium',
      suspectUrl: worstEvent.url || null,
    });
  }
  return {
    summary: `Stub analysis (no OPENAI_API_KEY). Trace has ${compactSummary.totals?.events ?? 0} events over ${compactSummary.totals?.durationMs ?? 0} ms.`,
    bottlenecks,
    recommendations: bottlenecks.length
      ? [
          {
            action: `Investigate ${bottlenecks[0].category} work on the main thread`,
            rationale: bottlenecks[0].evidence,
            codePointer: null,
          },
        ]
      : [],
    confidence: 'low',
  };
}

/**
 * Calls OpenAI Chat Completions with JSON-mode response_format. Uses fetch to
 * avoid an extra dependency. Returns parsed JSON conforming to ANALYSIS_SCHEMA.
 */
async function callOpenAI(compactSummary, { signal } = {}) {
  const url = `${config.openai.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const body = {
    model: config.openai.model,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          'Analyze this compact performance summary and respond with JSON matching this schema:',
          JSON.stringify(ANALYSIS_SCHEMA),
          'Compact summary:',
          JSON.stringify(compactSummary),
        ].join('\n\n'),
      },
    ],
    temperature: 0.2,
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.openai.apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`OpenAI HTTP ${res.status}`);
    err.status = res.status;
    err.body = text.slice(0, 500);
    throw err;
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content || '{}';
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('OpenAI returned non-JSON content');
  }
  return parsed;
}

export async function analyzeCompactSummary(compactSummary, { signal } = {}) {
  if (!hasOpenAI()) {
    return { source: 'stub', model: null, analysis: stubAnalysis(compactSummary) };
  }
  const analysis = await callOpenAI(compactSummary, { signal });
  return { source: 'openai', model: config.openai.model, analysis };
}
