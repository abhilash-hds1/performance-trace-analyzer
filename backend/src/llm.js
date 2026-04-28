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
        required: ['action', 'rationale', 'codePointer', 'codeSuggestion'],
        properties: {
          action: { type: 'string' },
          rationale: { type: 'string' },
          codePointer: {
            type: ['string', 'null'],
            description:
              'Repo-relative path : line number, e.g. src/app/foo.component.ts:42. In component mode, line MUST match the numbered column in excerpts.',
          },
          codeSuggestion: {
            type: ['string', 'null'],
            description:
              'Optional concrete snippet: replacement code, config block, or minimal unified diff; must match excerpts',
          },
        },
      },
    },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
  },
};

const SYSTEM_PROMPT = [
  'You are a web performance analyst.',
  'You are given a compact summary derived from a Chrome performance trace.',
  'Optional repository excerpts are a SMALL subset: project configs / entrypoints plus files correlated to hot trace URLs.',
  'You do NOT have the full repository—never claim you analyzed every file.',
  'Identify likely bottlenecks (long tasks, layout/paint thrash, heavy scripts, slow resources, GC).',
  'Rules:',
  '- Use ONLY the compact summary and provided excerpts; do not invent URLs, stacks, or file contents.',
  '- When excerpts exist, set codePointer to path:line when inferable; in COMPONENT-FOCUSED MODE (user message) codePointer MUST be path:line using line numbers from the left column of excerpts.',
  '- For up to 3 highest-impact recommendations, set codeSuggestion to copy-pasteable replacement code grounded in excerpts; in component mode tie it to that path:line. Use null if you cannot ground it.',
  '- Prefer specificity (event names, durations) over generic advice.',
  '- Output strictly conforms to the provided JSON schema.',
].join(' ');

/**
 * Deterministic stub used when no API key is configured OR when the upstream
 * LLM call fails. Picks the worst long task / event and returns a structurally
 * correct analysis so the extension UI is never left empty.
 */
export function stubAnalysisFor(compactSummary, githubBundle = null) {
  return stubAnalysis(compactSummary, githubBundle);
}

function stubAnalysis(compactSummary, githubBundle = null) {
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
  const ghNote = githubBundle?.label
    ? ` Linked repo ${githubBundle.label}${githubBundle.ref ? `@${githubBundle.ref}` : ''} (${githubBundle.snippets?.length ? `${githubBundle.snippets.length} excerpt(s)` : 'no matching public files fetched'}).`
    : '';

  const pointer = githubBundle?.snippets?.[0]?.path || null;

  return {
    summary: `Stub analysis (no OPENAI_API_KEY). Trace has ${compactSummary.totals?.events ?? 0} events over ${compactSummary.totals?.durationMs ?? 0} ms.${ghNote}`,
    bottlenecks,
    recommendations: bottlenecks.length
      ? [
          {
            action: `Investigate ${bottlenecks[0].category} work on the main thread`,
            rationale: bottlenecks[0].evidence,
            codePointer: pointer,
            codeSuggestion: null,
          },
        ]
      : [],
    confidence: 'low',
  };
}

function parseOpenAIError(rawText) {
  let body = null;
  try {
    body = JSON.parse(rawText);
  } catch {
    return { code: null, message: rawText.slice(0, 300) };
  }
  const e = body?.error || {};
  return {
    code: e.code || e.type || null,
    message: e.message || rawText.slice(0, 300),
    type: e.type || null,
    param: e.param || null,
  };
}

function describeOpenAIError(status, parsed) {
  if (status === 429 && parsed.code === 'insufficient_quota') {
    return 'OpenAI account has no remaining quota. Add credits or a payment method at platform.openai.com -> Billing.';
  }
  if (status === 429) {
    return `OpenAI rate limit exceeded${parsed.message ? ': ' + parsed.message : ''}`;
  }
  if (status === 401) {
    return 'OpenAI rejected the API key (401). Check OPENAI_API_KEY in backend/.env.';
  }
  if (status === 404 && /model/i.test(parsed.message || '')) {
    return `OpenAI model not found: ${config.openai.model}. Check OPENAI_MODEL.`;
  }
  if (status === 400) {
    return `OpenAI rejected the request (400)${parsed.message ? ': ' + parsed.message : ''}`;
  }
  return `OpenAI HTTP ${status}${parsed.message ? ': ' + parsed.message : ''}`;
}

function isRetryable(status, code) {
  if (status === 429 && code !== 'insufficient_quota') return true;
  if (status >= 500 && status < 600) return true;
  return false;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(t);
        reject(new Error('aborted'));
      }, { once: true });
    }
  });
}

/**
 * Calls OpenAI Chat Completions with JSON-mode response_format. Uses fetch to
 * avoid an extra dependency. Returns parsed JSON conforming to ANALYSIS_SCHEMA.
 *
 * Retries transient 429 (rate-limit, NOT insufficient_quota) and 5xx with
 * exponential backoff. Honors `Retry-After` when present.
 */
const MAX_CODE_SUGGESTION_CHARS = 6000;

function normalizeAnalysisOutput(analysis) {
  if (!analysis || typeof analysis !== 'object' || !Array.isArray(analysis.recommendations)) return;
  for (const r of analysis.recommendations) {
    if (!r) continue;
    if (r.codeSuggestion === undefined) r.codeSuggestion = null;
    if (typeof r.codeSuggestion === 'string' && r.codeSuggestion.length > MAX_CODE_SUGGESTION_CHARS) {
      r.codeSuggestion =
        r.codeSuggestion.slice(0, MAX_CODE_SUGGESTION_CHARS) + '\n/* … truncated … */';
    }
  }
}

function buildUserContent(compactSummary, githubBundle) {
  const chunks = [
    'Analyze this compact performance summary and respond with JSON matching this schema:',
    JSON.stringify(ANALYSIS_SCHEMA),
    'Compact summary:',
    JSON.stringify(compactSummary),
  ];

  if (githubBundle?.label) {
    const refPart = githubBundle.ref ? ` @ ${githubBundle.ref}` : '';
    chunks.push(
      `Linked GitHub repository for correlation: ${githubBundle.label}${refPart}`,
    );
    if (githubBundle.snippets?.length) {
      if (githubBundle.mode === 'components') {
        chunks.push(
          'COMPONENT-FOCUSED MODE: Analysis is LIMITED to the files below (entire folder scan, max 6 source files). Each file is shown with LINE NUMBERS as "  N|line text" — the N is the authoritative line number.',
          `Components folder (repo-relative): ${githubBundle.componentsPath || '(unknown)'}`,
          'Rules: Only recommend edits in these files. Every performance fix that changes code MUST set codePointer to `path:line` where path exactly matches the file path below and line matches N. codeSuggestion should be the concrete replacement or new code for that spot.',
        );
        for (const s of githubBundle.snippets) {
          chunks.push(`--- file: ${s.path} (full file, line-numbered) ---\n${s.excerpt}`);
        }
      } else {
        chunks.push(
          'Repository excerpts below are partial (not the full codebase). Label [skeleton] = configs/layout; [trace] = hot URL–linked source.',
        );
        const sk = githubBundle.snippets.filter((s) => s.kind === 'skeleton');
        const tr = githubBundle.snippets.filter((s) => s.kind === 'trace');
        if (sk.length) {
          chunks.push('--- [skeleton] Project / build excerpts ---');
          for (const s of sk) {
            chunks.push(`--- file: ${s.path} ---\n${s.excerpt}`);
          }
        }
        if (tr.length) {
          chunks.push('--- [trace] Hot-path correlated files ---');
          for (const s of tr) {
            chunks.push(`--- file: ${s.path} ---\n${s.excerpt}`);
          }
        }
      }
    } else if (githubBundle.pathsAttempted?.length) {
      chunks.push(
        'No file excerpts were fetched (missing paths on the branch, private repo without server token, or rate limit). Trace-derived paths tried: ' +
          githubBundle.pathsAttempted.join(', '),
      );
    } else {
      chunks.push(
        'No source-looking paths were derived from trace URLs for this repo. Give repository-level performance guidance without inventing file contents.',
      );
    }
  }

  return chunks.join('\n\n');
}

async function callOpenAI(compactSummary, { signal, maxRetries = 2, githubBundle = null } = {}) {
  const url = `${config.openai.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const body = {
    model: config.openai.model,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: buildUserContent(compactSummary, githubBundle),
      },
    ],
    temperature: 0.2,
  };

  let attempt = 0;
  while (true) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.openai.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });

    if (res.ok) {
      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content || '{}';
      try {
        const parsed = JSON.parse(content);
        normalizeAnalysisOutput(parsed);
        return parsed;
      } catch {
        throw new Error('OpenAI returned non-JSON content');
      }
    }

    const text = await res.text().catch(() => '');
    const parsed = parseOpenAIError(text);
    const retryable = isRetryable(res.status, parsed.code) && attempt < maxRetries;

    if (!retryable) {
      const err = new Error(describeOpenAIError(res.status, parsed));
      err.status = res.status;
      err.code = parsed.code;
      err.body = text.slice(0, 500);
      throw err;
    }

    const retryAfterHeader = res.headers.get('retry-after');
    const retryAfterMs = retryAfterHeader && /^\d+$/.test(retryAfterHeader)
      ? Number(retryAfterHeader) * 1000
      : Math.min(8000, 500 * Math.pow(2, attempt));
    attempt += 1;
    await sleep(retryAfterMs, signal);
  }
}

export async function analyzeCompactSummary(compactSummary, { signal, githubBundle = null } = {}) {
  if (!hasOpenAI()) {
    return { source: 'stub', model: null, analysis: stubAnalysis(compactSummary, githubBundle) };
  }
  const analysis = await callOpenAI(compactSummary, { signal, githubBundle });
  return { source: 'openai', model: config.openai.model, analysis };
}
