/**
 * Perf AI panel script.
 *
 * Talks to the service worker (background.js) for any chrome.debugger work
 * and to the configured backend for upload/analysis. Stores only the API
 * base URL, optional GitHub repo, and optional components folder path in
 * chrome.storage.local; never secrets.
 */

const els = {
  apiBaseUrl: document.getElementById('apiBaseUrl'),
  githubRepo: document.getElementById('githubRepo'),
  githubComponentsPath: document.getElementById('githubComponentsPath'),
  saveApi: document.getElementById('saveApi'),
  preset: document.getElementById('preset'),
  startBtn: document.getElementById('startBtn'),
  stopBtn: document.getElementById('stopBtn'),
  fileInput: document.getElementById('fileInput'),
  importBtn: document.getElementById('importBtn'),
  status: document.getElementById('status'),
  results: document.getElementById('results'),
  dashMeta: document.getElementById('dashMeta'),
  dashStats: document.getElementById('dashStats'),
  summary: document.getElementById('summary'),
  bottlenecks: document.getElementById('bottlenecks'),
  recommendations: document.getElementById('recommendations'),
  repoExcerptsWrap: document.getElementById('repoExcerptsWrap'),
  repoExcerpts: document.getElementById('repoExcerpts'),
  compact: document.getElementById('compact'),
};

const STORAGE_KEY = 'perfai.apiBaseUrl';
const STORAGE_GITHUB = 'perfai.githubRepo';
const STORAGE_COMPONENTS = 'perfai.githubComponentsPath';
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

function githubRepoTrimmed() {
  return (els.githubRepo.value || '').trim();
}

function githubComponentsPathTrimmed() {
  return (els.githubComponentsPath.value || '').trim().replace(/^\/+|\/+$/g, '');
}

async function loadApiBase() {
  const stored = await chrome.storage.local.get([STORAGE_KEY, STORAGE_GITHUB, STORAGE_COMPONENTS]);
  els.apiBaseUrl.value = stored[STORAGE_KEY] || 'http://localhost:8787';
  els.githubRepo.value = stored[STORAGE_GITHUB] || '';
  els.githubComponentsPath.value = stored[STORAGE_COMPONENTS] || '';
}

async function saveApiBase() {
  const v = (els.apiBaseUrl.value || '').trim();
  if (!v) return setStatus('API base URL is required', 'error');
  try {
    new URL(v);
  } catch {
    return setStatus('API base URL must be a valid URL', 'error');
  }
  const gh = githubRepoTrimmed();
  const comp = githubComponentsPathTrimmed();
  if (comp && !gh) {
    return setStatus('Set GitHub repo before using Components folder path', 'error');
  }
  if (comp.includes('..')) {
    return setStatus('Components path must not contain ..', 'error');
  }
  await chrome.storage.local.set({
    [STORAGE_KEY]: v,
    [STORAGE_GITHUB]: gh,
    [STORAGE_COMPONENTS]: comp,
  });
  setStatus('Saved settings (API, GitHub repo, optional components folder)');
}

function clearResults() {
  els.results.hidden = true;
  els.dashMeta.replaceChildren();
  els.dashStats.replaceChildren();
  els.dashStats.hidden = true;
  els.summary.textContent = '';
  els.bottlenecks.replaceChildren();
  els.recommendations.replaceChildren();
  els.repoExcerpts.replaceChildren();
  els.repoExcerptsWrap.hidden = true;
  els.compact.textContent = '';
}

function formatStat(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  return Number(n).toLocaleString();
}

function pill(text, className) {
  const s = document.createElement('span');
  s.className = className ? `meta-pill ${className}` : 'meta-pill';
  s.textContent = text;
  return s;
}

function renderDashMeta({ analysis, source, model }) {
  els.dashMeta.replaceChildren();
  const conf = analysis?.confidence;
  if (conf) {
    els.dashMeta.append(pill(`Confidence: ${conf}`, `conf-${conf}`));
  }
  const src = source === 'stub' ? 'Local stub' : source || '—';
  els.dashMeta.append(pill(model ? `${src} · ${model}` : String(src)));
}

function renderDashStats(compactSummary) {
  els.dashStats.replaceChildren();
  const t = compactSummary?.totals;
  if (!t) {
    els.dashStats.hidden = true;
    return;
  }
  els.dashStats.hidden = false;
  const specs = [
    { label: 'Trace events', value: formatStat(t.events) },
    { label: 'Window (ms)', value: formatStat(t.durationMs) },
    { label: 'Long tasks', value: formatStat(t.longTaskCount) },
  ];
  for (const { label, value } of specs) {
    const tile = document.createElement('div');
    tile.className = 'stat-tile';
    const val = document.createElement('div');
    val.className = 'stat-value';
    val.textContent = value;
    const lab = document.createElement('div');
    lab.className = 'stat-label';
    lab.textContent = label;
    tile.append(val, lab);
    els.dashStats.append(tile);
  }
}

function emptyBlock(container, message) {
  const p = document.createElement('p');
  p.className = 'empty-placeholder';
  p.textContent = message;
  container.append(p);
}

function renderGithubCorrelation(githubCorrelation) {
  els.repoExcerpts.replaceChildren();
  if (!githubCorrelation?.label) {
    els.repoExcerptsWrap.hidden = true;
    return;
  }
  els.repoExcerptsWrap.hidden = false;

  const meta = document.createElement('p');
  meta.className = 'repo-excerpts-meta';
  const refBit = githubCorrelation.ref ? ` @ ${githubCorrelation.ref}` : '';
  const n = githubCorrelation.snippets?.length ?? 0;
  if (githubCorrelation.mode === 'components' && githubCorrelation.componentsPath) {
    meta.textContent = `${githubCorrelation.label}${refBit} · components folder "${githubCorrelation.componentsPath}" · ${n} full line-numbered file(s)`;
  } else {
    meta.textContent = `${githubCorrelation.label}${refBit} · ${n} excerpt(s) (configs + trace-linked files; not the full repo)`;
  }
  els.repoExcerpts.append(meta);

  const tried = githubCorrelation.pathsAttempted || [];
  if (tried.length > 0 && n === 0) {
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.style.marginTop = '8px';
    hint.textContent =
      'Trace-derived paths did not load from the API (wrong branch, private repo without token, or paths differ from the repo). Tried: ' +
      tried.join(', ');
    els.repoExcerpts.append(hint);
  }

  for (const s of githubCorrelation.snippets || []) {
    const card = document.createElement('article');
    card.className = 'snippet-card';
    const title = document.createElement('h4');
    title.className = 'snippet-path';
    const tag =
      s.kind === 'skeleton' ? '[config] ' : s.kind === 'component' ? '[component] ' : '[trace] ';
    title.textContent = tag + s.path + (s.truncated ? ' (truncated)' : '');
    const pre = document.createElement('pre');
    pre.className = 'snippet-code';
    pre.textContent = s.excerpt || '';
    card.append(title, pre);
    els.repoExcerpts.append(card);
  }
}

function renderAnalysis({ analysis, source, model, compactSummary, upstreamError, githubCorrelation }) {
  els.results.hidden = false;
  renderDashMeta({ analysis, source, model });
  renderDashStats(compactSummary);

  els.summary.textContent = analysis?.summary || '(no summary)';
  if (source === 'stub' && upstreamError) {
    const code = upstreamError.code ? ` [${upstreamError.code}]` : '';
    setStatus(
      `OpenAI call failed${code}: ${upstreamError.message}. Falling back to local stub analysis.`,
      'warn',
    );
  } else if (source === 'stub') {
    setStatus('Analysis uses local stub (no OPENAI_API_KEY on backend)', 'warn');
  } else {
    setStatus(`Analyzed via ${source}${model ? ' / ' + model : ''}`);
  }

  els.bottlenecks.replaceChildren();
  const bottlenecks = analysis?.bottlenecks || [];
  if (bottlenecks.length === 0) {
    emptyBlock(els.bottlenecks, 'No bottlenecks listed in this analysis.');
  } else {
    for (const b of bottlenecks) {
      const card = document.createElement('article');
      card.className = 'bottleneck-card';
      const tags = document.createElement('div');
      tags.className = 'card-tags';
      const cat = document.createElement('span');
      cat.className = 'badge';
      cat.textContent = b.category || 'other';
      const impact = document.createElement('span');
      impact.className = `badge impact-${b.impact || 'low'}`;
      impact.textContent = b.impact || 'low';
      tags.append(cat, impact);
      const title = document.createElement('h4');
      title.className = 'card-title';
      title.textContent = b.title || '';
      const evidence = document.createElement('p');
      evidence.className = 'card-evidence';
      evidence.textContent = b.evidence || '';
      card.append(tags, title, evidence);
      if (b.suspectUrl) {
        const u = document.createElement('div');
        u.className = 'card-url';
        u.textContent = b.suspectUrl;
        card.append(u);
      }
      els.bottlenecks.append(card);
    }
  }

  els.recommendations.replaceChildren();
  const recs = analysis?.recommendations || [];
  if (recs.length === 0) {
    emptyBlock(els.recommendations, 'No recommendations yet. Try a richer trace or LLM analysis.');
  } else {
    recs.forEach((r, i) => {
      const card = document.createElement('article');
      card.className = 'fix-card';
      const idx = document.createElement('div');
      idx.className = 'fix-index';
      idx.textContent = String(i + 1);
      idx.setAttribute('aria-hidden', 'true');
      const body = document.createElement('div');
      body.className = 'fix-body';
      const action = document.createElement('p');
      action.className = 'fix-action';
      action.textContent = r.action || '';

      const exactWrap = document.createElement('div');
      exactWrap.className = 'fix-exact-wrap';
      const exactHeader = document.createElement('div');
      exactHeader.className = 'fix-exact-header';
      const exactTitle = document.createElement('span');
      exactTitle.className = 'fix-exact-title';
      exactTitle.textContent = 'Exact fix';
      exactHeader.append(exactTitle);

      const text = (r.codeSuggestion || '').trim();
      if (text) {
        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'fix-copy-btn';
        copyBtn.textContent = 'Copy';
        copyBtn.addEventListener('click', () => {
          navigator.clipboard.writeText(text).then(
            () => {
              copyBtn.textContent = 'Copied';
              setTimeout(() => {
                copyBtn.textContent = 'Copy';
              }, 1600);
            },
            () => setStatus('Could not copy to clipboard', 'error'),
          );
        });
        exactHeader.append(copyBtn);
        const sug = document.createElement('pre');
        sug.className = 'fix-suggestion';
        sug.textContent = text;
        exactWrap.append(exactHeader, sug);
      } else {
        const missing = document.createElement('p');
        missing.className = 'fix-exact-missing';
        missing.textContent =
          'No copy-paste snippet for this item (stub mode, or the model lacked grounded file context). Use the description and file location below, or link a GitHub repo and re-analyze.';
        exactWrap.append(exactHeader, missing);
      }

      body.append(action, exactWrap);

      if (r.codePointer) {
        const ptr = document.createElement('div');
        ptr.className = 'fix-pointer';
        const plab = document.createElement('span');
        plab.className = 'fix-pointer-label';
        plab.textContent = 'File: ';
        ptr.append(plab, document.createTextNode(r.codePointer));
        body.append(ptr);
      }

      const rat = document.createElement('p');
      rat.className = 'fix-rationale';
      rat.textContent = r.rationale || '';
      body.append(rat);

      card.append(idx, body);
      els.recommendations.append(card);
    });
  }

  renderGithubCorrelation(githubCorrelation);

  if (compactSummary) {
    els.compact.textContent = JSON.stringify(compactSummary, null, 2);
  }
}

async function uploadAndAnalyze(traceEvents, meta) {
  const apiBaseUrl = (els.apiBaseUrl.value || '').trim();
  if (!apiBaseUrl) throw new Error('Set the API base URL first');
  const gh = githubRepoTrimmed();
  const comp = githubComponentsPathTrimmed();
  if (comp && !gh) throw new Error('Set GitHub repo when using Components folder path');
  if (comp.includes('..')) throw new Error('Components path must not contain ..');
  setStatus('Uploading trace...');
  const upload = await sendMessage({
    type: 'perfai/upload',
    apiBaseUrl,
    traceEvents,
    meta: {
      ...meta,
      ...(gh ? { githubRepo: gh } : {}),
      ...(comp ? { githubComponentsPath: comp } : {}),
    },
  });
  lastTraceId = upload.traceId;
  setStatus(`Uploaded (${upload.stats.totalEvents} events). Analyzing...`);
  const analyze = await sendMessage({
    type: 'perfai/analyze',
    apiBaseUrl,
    traceId: upload.traceId,
    ...(gh ? { githubRepo: gh } : {}),
    ...(comp ? { githubComponentsPath: comp } : {}),
  });
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
    const gh = githubRepoTrimmed();
    const comp = githubComponentsPathTrimmed();
    if (comp && !gh) return setStatus('Set GitHub repo when using Components folder path', 'error');
    if (comp.includes('..')) return setStatus('Components path must not contain ..', 'error');
    const result = await sendMessage({
      type: 'perfai/stop',
      tabId,
      apiBaseUrl,
      ...(gh ? { githubRepo: gh } : {}),
      ...(comp ? { githubComponentsPath: comp } : {}),
    });
    lastTraceId = result.upload?.traceId || null;
    setStatus(`Captured ${result.eventCount} events. Analyzing...`);
    const analyze = await sendMessage({
      type: 'perfai/analyze',
      apiBaseUrl,
      traceId: lastTraceId,
      ...(gh ? { githubRepo: gh } : {}),
      ...(comp ? { githubComponentsPath: comp } : {}),
    });
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
