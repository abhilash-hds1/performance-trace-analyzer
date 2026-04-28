/**
 * Perf AI panel script.
 *
 * Talks to the service worker (background.js) for any chrome.debugger work
 * and to the configured backend for upload/analysis. Stores only the API
 * base URL in chrome.storage.local; never secrets.
 */

const els = {
  apiBaseUrl: document.getElementById('apiBaseUrl'),
  saveApi: document.getElementById('saveApi'),
  preset: document.getElementById('preset'),
  startBtn: document.getElementById('startBtn'),
  stopBtn: document.getElementById('stopBtn'),
  fileInput: document.getElementById('fileInput'),
  importBtn: document.getElementById('importBtn'),
  status: document.getElementById('status'),
  results: document.getElementById('results'),
  summary: document.getElementById('summary'),
  bottlenecks: document.getElementById('bottlenecks'),
  recommendations: document.getElementById('recommendations'),
  compact: document.getElementById('compact'),
};

const STORAGE_KEY = 'perfai.apiBaseUrl';
const tabId = chrome.devtools?.inspectedWindow?.tabId;
let lastTraceId = null;

function setStatus(text, kind) {
  els.status.textContent = text || '';
  els.status.className = `status${kind ? ' ' + kind : ''}`;
}

function sendMessage(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (response) => {
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(err.message));
      if (!response || response.ok !== true) {
        return reject(new Error(response?.error || 'unknown error'));
      }
      resolve(response.data);
    });
  });
}

async function loadApiBase() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  els.apiBaseUrl.value = stored[STORAGE_KEY] || 'http://localhost:8787';
}

async function saveApiBase() {
  const v = (els.apiBaseUrl.value || '').trim();
  if (!v) return setStatus('API base URL is required', 'error');
  try {
    new URL(v);
  } catch {
    return setStatus('API base URL must be a valid URL', 'error');
  }
  await chrome.storage.local.set({ [STORAGE_KEY]: v });
  setStatus('Saved API base URL');
}

function clearResults() {
  els.results.hidden = true;
  els.summary.textContent = '';
  els.bottlenecks.replaceChildren();
  els.recommendations.replaceChildren();
  els.compact.textContent = '';
}

function renderAnalysis({ analysis, source, model, compactSummary }) {
  els.results.hidden = false;
  els.summary.textContent = analysis?.summary || '(no summary)';
  if (source === 'stub') {
    setStatus('Analysis uses local stub (no OPENAI_API_KEY on backend)', 'warn');
  } else {
    setStatus(`Analyzed via ${source}${model ? ' / ' + model : ''}`);
  }

  els.bottlenecks.replaceChildren(...(analysis?.bottlenecks || []).map((b) => {
    const li = document.createElement('li');
    const cat = document.createElement('span');
    cat.className = 'badge';
    cat.textContent = b.category;
    const impact = document.createElement('span');
    impact.className = `badge impact-${b.impact}`;
    impact.textContent = b.impact;
    const title = document.createElement('strong');
    title.textContent = b.title;
    const evidence = document.createElement('div');
    evidence.textContent = b.evidence;
    li.append(cat, impact, title, evidence);
    if (b.suspectUrl) {
      const u = document.createElement('div');
      u.className = 'badge';
      u.textContent = b.suspectUrl;
      li.append(u);
    }
    return li;
  }));

  els.recommendations.replaceChildren(...(analysis?.recommendations || []).map((r) => {
    const li = document.createElement('li');
    const action = document.createElement('strong');
    action.textContent = r.action;
    const rat = document.createElement('div');
    rat.textContent = r.rationale;
    li.append(action, rat);
    if (r.codePointer) {
      const c = document.createElement('code');
      c.textContent = r.codePointer;
      li.append(' ', c);
    }
    return li;
  }));

  if (compactSummary) {
    els.compact.textContent = JSON.stringify(compactSummary, null, 2);
  }
}

async function uploadAndAnalyze(traceEvents, meta) {
  const apiBaseUrl = (els.apiBaseUrl.value || '').trim();
  if (!apiBaseUrl) throw new Error('Set the API base URL first');
  setStatus('Uploading trace...');
  const upload = await sendMessage({ type: 'perfai/upload', apiBaseUrl, traceEvents, meta });
  lastTraceId = upload.traceId;
  setStatus(`Uploaded (${upload.stats.totalEvents} events). Analyzing...`);
  const analyze = await sendMessage({ type: 'perfai/analyze', apiBaseUrl, traceId: upload.traceId });
  renderAnalysis({ ...analyze, compactSummary: upload.compactSummary });
}

async function startRecording() {
  clearResults();
  if (typeof tabId !== 'number') return setStatus('No inspected tab', 'error');
  try {
    await sendMessage({ type: 'perfai/start', tabId, preset: els.preset.value });
    els.startBtn.disabled = true;
    els.stopBtn.disabled = false;
    setStatus('Recording... Chrome shows a debugger banner while attached.');
  } catch (err) {
    setStatus(err.message, 'error');
  }
}

async function stopRecording() {
  const apiBaseUrl = (els.apiBaseUrl.value || '').trim();
  if (!apiBaseUrl) return setStatus('Set the API base URL first', 'error');
  try {
    setStatus('Stopping & uploading...');
    const result = await sendMessage({ type: 'perfai/stop', tabId, apiBaseUrl });
    lastTraceId = result.upload?.traceId || null;
    setStatus(`Captured ${result.eventCount} events. Analyzing...`);
    const analyze = await sendMessage({ type: 'perfai/analyze', apiBaseUrl, traceId: lastTraceId });
    renderAnalysis({ ...analyze, compactSummary: result.upload?.compactSummary });
  } catch (err) {
    setStatus(err.message, 'error');
  } finally {
    els.startBtn.disabled = false;
    els.stopBtn.disabled = true;
  }
}

async function importFile() {
  const file = els.fileInput.files?.[0];
  if (!file) return setStatus('Choose a trace JSON file', 'error');
  clearResults();
  setStatus('Reading file...');
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const traceEvents = Array.isArray(parsed) ? parsed : parsed.traceEvents;
    if (!Array.isArray(traceEvents) || traceEvents.length === 0) {
      throw new Error('JSON must contain a non-empty traceEvents array (or be the array itself)');
    }
    await uploadAndAnalyze(traceEvents, { source: 'import', filename: file.name });
  } catch (err) {
    setStatus(err.message, 'error');
  }
}

els.saveApi.addEventListener('click', saveApiBase);
els.startBtn.addEventListener('click', startRecording);
els.stopBtn.addEventListener('click', stopRecording);
els.importBtn.addEventListener('click', importFile);
els.fileInput.addEventListener('change', () => {
  els.importBtn.disabled = !els.fileInput.files?.length;
});

loadApiBase().catch((err) => setStatus(err.message, 'error'));
