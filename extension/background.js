/**
 * Perf AI service worker.
 *
 * Owns the chrome.debugger lifecycle and CDP `Tracing` calls. The DevTools
 * panel sends runtime messages here; raw trace data never round-trips through
 * the panel — we POST directly to the configured backend.
 *
 * Important constraints (see docs/ARCHITECTURE.md and .cursor/rules):
 *  - Always detach the debugger after `Tracing.tracingComplete` or on error.
 *  - Never store secrets here; only `apiBaseUrl` lives in chrome.storage.local.
 *  - Chrome shows the "controlled by automated test software" banner while
 *    we are attached.
 */

const DEBUGGER_VERSION = '1.3';

const PRESETS = {
  safe: {
    label: 'Safe',
    categories: [
      'devtools.timeline',
      'disabled-by-default-devtools.timeline',
      'disabled-by-default-devtools.timeline.frame',
      'loading',
      'rail',
      'blink.user_timing',
    ],
  },
  deep: {
    label: 'Deep (higher PII risk)',
    categories: [
      'devtools.timeline',
      'disabled-by-default-devtools.timeline',
      'disabled-by-default-devtools.timeline.frame',
      'disabled-by-default-devtools.timeline.stack',
      'disabled-by-default-v8.cpu_profiler',
      'loading',
      'rail',
      'blink.user_timing',
      'v8',
    ],
  },
};

const sessions = new Map();

function getSession(tabId) {
  let s = sessions.get(tabId);
  if (!s) {
    s = { active: false, events: [], startedAt: 0, preset: 'safe' };
    sessions.set(tabId, s);
  }
  return s;
}

function debuggerSend(target, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(target, method, params, (result) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(`${method}: ${err.message}`));
      else resolve(result);
    });
  });
}

function debuggerAttach(target) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach(target, DEBUGGER_VERSION, () => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(`attach: ${err.message}`));
      else resolve();
    });
  });
}

function debuggerDetach(target) {
  return new Promise((resolve) => {
    chrome.debugger.detach(target, () => {
      void chrome.runtime.lastError;
      resolve();
    });
  });
}

function onDebuggerEvent(source, method, params) {
  const tabId = source.tabId;
  if (tabId == null) return;
  const session = sessions.get(tabId);
  if (!session) return;

  if (method === 'Tracing.dataCollected') {
    if (params && Array.isArray(params.value)) {
      for (const e of params.value) session.events.push(e);
    }
  } else if (method === 'Tracing.tracingComplete') {
    session.tracingCompleteResolve?.();
  }
}

function onDebuggerDetach(source, reason) {
  const tabId = source.tabId;
  if (tabId == null) return;
  const session = sessions.get(tabId);
  if (!session) return;
  session.active = false;
  session.detachReason = reason;
}

chrome.debugger.onEvent.addListener(onDebuggerEvent);
chrome.debugger.onDetach.addListener(onDebuggerDetach);

async function startRecording({ tabId, preset }) {
  if (typeof tabId !== 'number') throw new Error('tabId required');
  const session = getSession(tabId);
  if (session.active) throw new Error('already recording on this tab');

  const target = { tabId };
  await debuggerAttach(target);
  session.active = true;
  session.events = [];
  session.startedAt = Date.now();
  session.preset = PRESETS[preset] ? preset : 'safe';

  const cats = PRESETS[session.preset].categories;
  await debuggerSend(target, 'Tracing.start', {
    transferMode: 'ReportEvents',
    traceConfig: {
      includedCategories: cats,
      recordMode: 'recordAsMuchAsPossible',
    },
  });

  return { ok: true, preset: session.preset, startedAt: session.startedAt };
}

async function stopRecording({ tabId, apiBaseUrl }) {
  if (typeof tabId !== 'number') throw new Error('tabId required');
  if (!apiBaseUrl) throw new Error('apiBaseUrl required');
  const session = sessions.get(tabId);
  if (!session || !session.active) throw new Error('no active recording on this tab');

  const target = { tabId };
  const completed = new Promise((resolve) => {
    session.tracingCompleteResolve = resolve;
  });

  try {
    await debuggerSend(target, 'Tracing.end');
    await Promise.race([
      completed,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Tracing.tracingComplete timeout')), 30000)),
    ]);
  } finally {
    await debuggerDetach(target);
    session.active = false;
  }

  const traceEvents = session.events;
  session.events = [];

  const upload = await uploadTrace(apiBaseUrl, {
    traceEvents,
    meta: {
      source: 'cdp',
      preset: session.preset,
      capturedAt: session.startedAt,
      durationMs: Date.now() - session.startedAt,
    },
  });
  return { ok: true, eventCount: traceEvents.length, upload };
}

async function uploadTrace(apiBaseUrl, body) {
  const url = `${apiBaseUrl.replace(/\/$/, '')}/traces`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`upload failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function analyzeTrace({ apiBaseUrl, traceId, force }) {
  if (!apiBaseUrl) throw new Error('apiBaseUrl required');
  if (!traceId) throw new Error('traceId required');
  const url = `${apiBaseUrl.replace(/\/$/, '')}/traces/${encodeURIComponent(traceId)}/analyze${force ? '?force=1' : ''}`;
  const res = await fetch(url, { method: 'POST' });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`analyze failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json();
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg && msg.type) {
        case 'perfai/start':
          sendResponse({ ok: true, data: await startRecording(msg) });
          break;
        case 'perfai/stop':
          sendResponse({ ok: true, data: await stopRecording(msg) });
          break;
        case 'perfai/upload':
          sendResponse({ ok: true, data: await uploadTrace(msg.apiBaseUrl, { traceEvents: msg.traceEvents, meta: msg.meta || { source: 'import' } }) });
          break;
        case 'perfai/analyze':
          sendResponse({ ok: true, data: await analyzeTrace(msg) });
          break;
        case 'perfai/status': {
          const s = msg.tabId != null ? sessions.get(msg.tabId) : null;
          sendResponse({ ok: true, data: { active: Boolean(s && s.active), preset: s?.preset || 'safe' } });
          break;
        }
        default:
          sendResponse({ ok: false, error: `unknown message type: ${msg && msg.type}` });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err.message || String(err) });
    }
  })();
  return true;
});
