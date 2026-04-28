import { config } from './config.js';

const CODE_EXT = /\.(jsx?|tsx?|mjs|cjs|vue|svelte|css|scss|less|wasm)$/i;
/** Source files under a user-specified components folder (includes Angular templates). */
const COMPONENT_FILE_EXT = /\.(jsx?|tsx?|mjs|cjs|vue|svelte|html|css|scss|less)$/i;
const MAX_REPO_PATH_LEN = 400;
/** Cap GitHub fetches per analyze (configs + trace-linked files); not a full repo index */
const MAX_SNIPPETS_TOTAL = 12;
const MAX_EXCERPT_CHARS = 3600;
/** User-selected components folder: max source files; hard error if exceeded */
export const MAX_COMPONENT_FILES = 6;
const MAX_COMPONENT_FILE_CHARS = 16000;

const SKELETON_ROOT_FILES = [
  'package.json',
  'pnpm-workspace.yaml',
  'nx.json',
  'turbo.json',
  'tsconfig.json',
  'tsconfig.base.json',
];

const SKELETON_APP_FILES = [
  'angular.json',
  'project.json',
  'vite.config.ts',
  'vite.config.mts',
  'vite.config.js',
];

const SKELETON_ENTRY_FILES = [
  'src/main.ts',
  'src/main.tsx',
  'src/bootstrap.ts',
  'src/polyfills.ts',
];

/**
 * @param {string} input - "owner/repo", full github.com URL, tree/blob URL
 * @returns {{ owner: string, repo: string, ref: string | null } | null}
 */
export function parseGithubRepo(input) {
  if (!input || typeof input !== 'string') return null;
  const s = input.trim();
  if (!s) return null;

  const short = /^([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)$/.exec(s);
  if (short) return { owner: short[1], repo: short[2], ref: null };

  let href = s;
  if (!/^https?:\/\//i.test(href)) href = `https://${href}`;

  let u;
  try {
    u = new URL(href);
  } catch {
    return null;
  }

  const host = u.hostname.toLowerCase();
  if (host !== 'github.com' && host !== 'www.github.com') return null;

  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return null;

  const owner = parts[0];
  let repo = parts[1];
  if (repo.endsWith('.git')) repo = repo.slice(0, -4);

  let ref = null;
  if (parts[2] === 'tree' && parts[3]) ref = parts[3];
  else if (parts[2] === 'blob' && parts[3]) ref = parts[3];

  return { owner, repo, ref };
}

/**
 * Stable cache key for analyze requests (includes optional components folder path).
 * @param {{ owner: string, repo: string, ref: string | null } | null} parsed
 * @param {string | null} [componentsFolder] - normalized repo-relative path from `normalizeGithubComponentsPath`
 */
export function githubContextKey(parsed, componentsFolder = null) {
  if (!parsed) return null;
  const { owner, repo, ref } = parsed;
  const base = `${owner.toLowerCase()}/${repo.toLowerCase()}`;
  const r = ref ? `#${ref}` : '';
  const c =
    componentsFolder && typeof componentsFolder === 'string' && componentsFolder.length > 0
      ? `#c:${componentsFolder}`
      : '';
  return `${base}${r}${c}`;
}

/**
 * @param {string | null | undefined} raw
 * @returns {string | null} normalized repo-relative path, or null if unset/invalid
 */
export function normalizeGithubComponentsPath(raw) {
  if (raw == null || typeof raw !== 'string') return null;
  const s = raw.trim().replace(/^\/+|\/+$/g, '');
  if (!s) return null;
  if (s.includes('..')) return null;
  if (s.length > MAX_REPO_PATH_LEN) return null;
  return s;
}

function githubFetchHeaders() {
  const token = (config.github.token || '').trim();
  return {
    accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

function excerptWithLineNumbers(text) {
  const lines = text.split(/\r\n?|\n/);
  const w = Math.max(2, String(lines.length).length);
  return lines.map((line, i) => `${String(i + 1).padStart(w, ' ')}|${line}`).join('\n');
}

function isComponentSourceFilename(name) {
  return typeof name === 'string' && COMPONENT_FILE_EXT.test(name);
}

/**
 * @returns {Promise<object[] | null>} directory entries, or null if not a directory / error
 */
async function listRepoDirectory({ owner, repo, ref }, dirPath) {
  const apiPath = apiContentsPath(dirPath);
  const refQ = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${apiPath}${refQ}`;
  const res = await fetch(url, { headers: githubFetchHeaders() });
  if (!res.ok) return null;
  let data;
  try {
    data = await res.json();
  } catch {
    return null;
  }
  if (!Array.isArray(data)) return null;
  return data;
}

/**
 * Recursive collect; stops and returns error if more than maxFiles source files found.
 * @returns {Promise<{ ok: true, paths: string[] } | { ok: false, error: string }>}
 */
async function collectComponentSourcePaths(parsed, rootPath, maxFiles) {
  const paths = [];

  async function walk(relPath) {
    const items = await listRepoDirectory(parsed, relPath);
    if (!items) {
      return { ok: false, error: `Cannot list path "${relPath}" (not found, not a directory, or no access).` };
    }
    const sorted = [...items].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    for (const item of sorted) {
      if (!item || item.type === 'symlink') continue;
      if (item.type === 'file' && isComponentSourceFilename(item.name)) {
        paths.push(item.path);
        if (paths.length > maxFiles) {
          return {
            ok: false,
            error: `Components folder has more than ${maxFiles} source files (${paths.length} found). Narrow the folder (max ${maxFiles}).`,
          };
        }
      } else if (item.type === 'dir') {
        if (item.name.startsWith('.')) continue;
        const sub = await walk(item.path);
        if (!sub.ok) return sub;
      }
    }
    return { ok: true };
  }

  const root = rootPath.replace(/^\/+|\/+$/g, '');
  const first = await listRepoDirectory(parsed, root);
  if (!first) {
    return {
      ok: false,
      error: `Components path "${rootPath}" is not a directory or could not be read from GitHub.`,
    };
  }
  const w = await walk(root);
  if (!w.ok) return w;
  if (paths.length === 0) {
    return {
      ok: false,
      error: `No component source files (.ts, .tsx, .html, .css, .vue, etc.) found under "${rootPath}".`,
    };
  }
  return { ok: true, paths };
}

/**
 * @returns {Promise<{ path: string, excerpt: string, truncated: boolean } | null>}
 */
async function fetchOneFileMaxChars({ owner, repo, ref, path }, maxChars) {
  const apiPath = apiContentsPath(path);
  const refQ = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${apiPath}${refQ}`;

  const res = await fetch(url, { headers: githubFetchHeaders() });

  if (!res.ok) return null;

  let data;
  try {
    data = await res.json();
  } catch {
    return null;
  }

  if (!data || data.type !== 'file' || typeof data.content !== 'string') return null;

  let text;
  try {
    text = Buffer.from(data.content, 'base64').toString('utf8');
  } catch {
    return null;
  }

  const truncated = text.length > maxChars;
  const raw = truncated ? `${text.slice(0, maxChars)}\n/* … truncated … */` : text;
  const excerpt = excerptWithLineNumbers(raw);

  return { path, excerpt, truncated };
}

/**
 * Fetch up to MAX_COMPONENT_FILES full (line-numbered) files under folderPath. Errors if > max files.
 * @returns {Promise<{ snippets: object[], pathsAttempted: string[], error?: string }>}
 */
export async function fetchGithubComponentsFolder(parsed, folderPath) {
  if (!parsed || !folderPath) {
    return { snippets: [], pathsAttempted: [], error: 'GitHub repo and components path are required.' };
  }
  const collected = await collectComponentSourcePaths(parsed, folderPath, MAX_COMPONENT_FILES);
  if (!collected.ok) {
    return { snippets: [], pathsAttempted: [], error: collected.error };
  }
  const paths = collected.paths;
  const snippets = [];
  for (const path of paths) {
    const row = await fetchOneFileMaxChars({ ...parsed, path }, MAX_COMPONENT_FILE_CHARS);
    if (row) {
      snippets.push({
        ...row,
        kind: 'component',
      });
    }
  }
  if (snippets.length === 0) {
    return {
      snippets: [],
      pathsAttempted: paths,
      error: 'Could not load file contents from GitHub (private repo needs GITHUB_TOKEN, or paths invalid).',
    };
  }
  return { snippets, pathsAttempted: paths };
}

function shouldExcludeRepoPath(p) {
  const x = p.replace(/\\/g, '/').toLowerCase();
  return (
    x.includes('node_modules') ||
    x.includes('.angular/cache') ||
    x.includes('/vite/deps') ||
    x.includes('vite/deps/') ||
    /^chunk-[a-z0-9_-]+\.(js|mjs)$/i.test(x.split('/').pop() || '')
  );
}

/** Vite dev: pathname contains /@fs/ + absolute disk path → normalize to forward slashes */
function viteFsAbsoluteFromUrl(url) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(url).pathname);
  } catch {
    return null;
  }
  const idx = pathname.toLowerCase().indexOf('/@fs/');
  if (idx === -1) return null;
  let rest = pathname.slice(idx + '/@fs/'.length);
  try {
    rest = decodeURIComponent(rest);
  } catch {
    /* keep */
  }
  return rest.replace(/\\/g, '/');
}

function pathPartsAfterDrive(norm) {
  const parts = norm.split('/').filter(Boolean);
  if (parts.length && /^[A-Za-z]:$/.test(parts[0])) return parts.slice(1);
  return parts;
}

/**
 * Map absolute fs path (from Vite @fs) to repo-relative path using clone folder = GitHub repo name.
 */
function repoRelativeFromFsPath(fsPath, repoFolderName) {
  const norm = fsPath.replace(/\\/g, '/');
  if (!norm || norm.length > MAX_REPO_PATH_LEN) return null;
  if (norm.includes('..')) return null;
  if (shouldExcludeRepoPath(norm)) return null;
  if (!CODE_EXT.test(norm)) return null;

  const clean = pathPartsAfterDrive(norm);
  const rname = repoFolderName.toLowerCase();
  const idx = clean.findIndex((p) => p.toLowerCase() === rname);
  if (idx >= 0) {
    const rel = clean.slice(idx + 1).join('/');
    if (rel && !shouldExcludeRepoPath(rel) && CODE_EXT.test(rel)) return rel;
  }

  const srcIdx = clean.indexOf('src');
  if (srcIdx >= 1) {
    const withPkg = clean.slice(srcIdx - 1).join('/');
    if (
      withPkg &&
      !shouldExcludeRepoPath(withPkg) &&
      CODE_EXT.test(withPkg)
    ) {
      return withPkg;
    }
    const fromSrc = clean.slice(srcIdx).join('/');
    if (fromSrc && !shouldExcludeRepoPath(fromSrc) && CODE_EXT.test(fromSrc)) return fromSrc;
  }
  return null;
}

function collectPackageRootsBeforeSrc(fsPathStrings) {
  const roots = new Set();
  for (const fsPath of fsPathStrings) {
    const norm = fsPath.replace(/\\/g, '/');
    if (shouldExcludeRepoPath(norm)) continue;
    const clean = pathPartsAfterDrive(norm);
    const srcIdx = clean.indexOf('src');
    if (srcIdx >= 1) roots.add(clean[srcIdx - 1]);
  }
  return [...roots];
}

/** e.g. .../slow-shop-angular/node_modules/... or .../slow-shop-angular/.angular/cache/... */
function packageFolderBeforeMarker(norm, markerLower) {
  const lower = norm.toLowerCase();
  const i = lower.indexOf(markerLower);
  if (i === -1) return null;
  const before = norm.slice(0, i).replace(/\/+$/, '');
  return before.split('/').filter(Boolean).pop() || null;
}

function inferPackageRootsFromTraceFsPaths(fsPaths) {
  const roots = new Set(collectPackageRootsBeforeSrc(fsPaths));
  for (const fs of fsPaths) {
    const norm = fs.replace(/\\/g, '/');
    const nm = packageFolderBeforeMarker(norm, '/node_modules/');
    if (nm) roots.add(nm);
    const ng = packageFolderBeforeMarker(norm, '/.angular/cache/');
    if (ng) roots.add(ng);
  }
  return [...roots];
}

/** Repo-relative paths to try for project layout (bounded; not a full tree walk). */
export function buildSkeletonCandidatePaths(packageRoots) {
  const out = [];
  for (const f of SKELETON_ROOT_FILES) out.push(f);
  for (const f of SKELETON_APP_FILES) out.push(f);
  for (const root of packageRoots) {
    for (const f of [...SKELETON_ROOT_FILES, ...SKELETON_APP_FILES, ...SKELETON_ENTRY_FILES]) {
      out.push(`${root}/${f}`);
    }
  }
  return [...new Set(out)];
}

export function packageRootsFromCompactSummary(parsed, compactSummary) {
  if (!parsed || !compactSummary) return [];
  const urls = [];
  for (const t of compactSummary.topLongTasks || []) {
    if (t.url) urls.push(t.url);
  }
  for (const u of compactSummary.topUrls || []) {
    if (u.url) urls.push(u.url);
  }
  for (const t of compactSummary.topEvents || []) {
    if (t.url) urls.push(t.url);
  }
  const fsPaths = [];
  for (const url of urls) {
    const fs = viteFsAbsoluteFromUrl(url);
    if (fs) fsPaths.push(fs);
  }
  return inferPackageRootsFromTraceFsPaths(fsPaths);
}

/** Root-relative dev URLs: polyfills.js, main.js, styles.css */
function bareDevAssetCandidates(pathname, packageRoots) {
  const path = pathname.replace(/^\/+/, '');
  if (!path || path.includes('/') || path.includes('..')) return [];
  if (!CODE_EXT.test(path)) return [];
  const base = path.toLowerCase();
  const primary = [];
  const fallback = [];

  const addUnderRoots = (fn) => {
    for (const root of packageRoots) fn(root);
  };

  if (base === 'main.js' || base === 'main.ts') {
    addUnderRoots((root) => {
      primary.push(`${root}/src/main.ts`, `${root}/src/main.js`);
    });
    fallback.push('src/main.ts', 'src/main.js');
  }
  if (base === 'polyfills.js' || base === 'polyfills.ts') {
    addUnderRoots((root) => {
      primary.push(`${root}/src/polyfills.ts`, `${root}/src/polyfills.js`);
    });
    fallback.push('src/polyfills.ts', 'src/polyfills.js');
  }
  if (base === 'styles.css' || base === 'styles.scss') {
    addUnderRoots((root) => {
      primary.push(`${root}/src/styles.css`, `${root}/src/styles.scss`);
    });
    fallback.push('src/styles.css', 'src/styles.scss');
  }
  addUnderRoots((root) => primary.push(`${root}/src/${path}`));
  fallback.push(`src/${path}`);

  const out = [...primary, ...fallback].filter(
    (p) => p && !shouldExcludeRepoPath(p) && p.length <= MAX_REPO_PATH_LEN,
  );
  return [...new Set(out)];
}

function pathnameOnlyCandidates(url, repoFolderName, packageRoots) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(url).pathname);
  } catch {
    return [];
  }
  if (pathname.toLowerCase().includes('/@fs/')) return [];

  let path = pathname.replace(/^\/+/, '');
  if (!path || path.includes('..')) return [];
  if (path.length > MAX_REPO_PATH_LEN) return [];

  const out = [];

  if (!path.includes('/') && CODE_EXT.test(path)) {
    out.push(...bareDevAssetCandidates(pathname, packageRoots));
  } else {
    if (!CODE_EXT.test(path)) return [];
    if (shouldExcludeRepoPath(path)) return [];
    out.push(path);
    const idx = path.toLowerCase().split('/').indexOf(repoFolderName.toLowerCase());
    if (idx >= 0) {
      const tail = path.split('/').slice(idx + 1).join('/');
      if (tail && !shouldExcludeRepoPath(tail)) out.push(tail);
    }
  }

  return out;
}

/**
 * Map script/resource URLs from the compact summary to likely repo-relative paths.
 * @param {{ owner: string, repo: string }} parsed - GitHub coordinates; repo name anchors disk paths (clone folder).
 */
export function candidateRepoPathsFromSummary(compactSummary, { maxPaths = 32, parsed } = {}) {
  const seen = new Set();
  const out = [];
  const repoFolderName = parsed?.repo || '';

  function pushCandidates(candidates) {
    for (const path of candidates) {
      if (!path || path.includes('..')) continue;
      if (path.length > MAX_REPO_PATH_LEN) continue;
      if (shouldExcludeRepoPath(path)) continue;
      if (!CODE_EXT.test(path)) continue;
      if (seen.has(path)) continue;
      seen.add(path);
      out.push(path);
      if (out.length >= maxPaths) return true;
    }
    return false;
  }

  const urls = [];
  for (const t of compactSummary.topLongTasks || []) {
    if (t.url) urls.push(t.url);
  }
  for (const u of compactSummary.topUrls || []) {
    if (u.url) urls.push(u.url);
  }
  for (const t of compactSummary.topEvents || []) {
    if (t.url) urls.push(t.url);
  }

  const fsPaths = [];
  for (const url of urls) {
    const fs = viteFsAbsoluteFromUrl(url);
    if (fs) fsPaths.push(fs);
  }
  const packageRoots = inferPackageRootsFromTraceFsPaths(fsPaths);

  for (const url of urls) {
    const fs = viteFsAbsoluteFromUrl(url);
    if (fs && repoFolderName) {
      const rel = repoRelativeFromFsPath(fs, repoFolderName);
      if (rel && pushCandidates([rel])) break;
    }
    if (repoFolderName) {
      const fromPath = pathnameOnlyCandidates(url, repoFolderName, packageRoots);
      if (fromPath.length && pushCandidates(fromPath)) break;
    }
  }

  return out.slice(0, maxPaths);
}

function apiContentsPath(repoPath) {
  return repoPath
    .split('/')
    .filter(Boolean)
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

/**
 * @returns {Promise<{ path: string, excerpt: string, truncated: boolean } | null>}
 */
async function fetchOneFile({ owner, repo, ref, path }) {
  const apiPath = apiContentsPath(path);
  const refQ = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${apiPath}${refQ}`;

  const res = await fetch(url, { headers: githubFetchHeaders() });

  if (!res.ok) return null;

  let data;
  try {
    data = await res.json();
  } catch {
    return null;
  }

  if (!data || data.type !== 'file' || typeof data.content !== 'string') return null;

  let text;
  try {
    text = Buffer.from(data.content, 'base64').toString('utf8');
  } catch {
    return null;
  }

  const truncated = text.length > MAX_EXCERPT_CHARS;
  const excerpt = truncated ? `${text.slice(0, MAX_EXCERPT_CHARS)}\n/* … truncated … */` : text;

  return { path, excerpt, truncated };
}

/**
 * Best-effort public (or token-authenticated) file reads: project skeleton first,
 * then trace-correlated paths. This is not a full-repository crawl.
 */
export async function fetchRepoSnippets(parsed, compactSummary) {
  if (!parsed) return { snippets: [], pathsAttempted: [] };

  const packageRoots = packageRootsFromCompactSummary(parsed, compactSummary);
  const skeletonPaths = buildSkeletonCandidatePaths(packageRoots);
  const tracePaths = candidateRepoPathsFromSummary(compactSummary, { parsed });
  const skeletonSet = new Set(skeletonPaths);

  const seen = new Set();
  const ordered = [];
  for (const p of skeletonPaths) {
    if (!seen.has(p)) {
      seen.add(p);
      ordered.push(p);
    }
  }
  for (const p of tracePaths) {
    if (!seen.has(p)) {
      seen.add(p);
      ordered.push(p);
    }
  }

  const snippets = [];
  for (const path of ordered) {
    const row = await fetchOneFile({ ...parsed, path });
    if (row) {
      snippets.push({
        ...row,
        kind: skeletonSet.has(path) ? 'skeleton' : 'trace',
      });
    }
    if (snippets.length >= MAX_SNIPPETS_TOTAL) break;
  }
  return { snippets, pathsAttempted: tracePaths };
}

/**
 * Payload returned to the extension so the panel can show fetched source (bounded on server).
 * @param {{ label: string, ref: string | null, snippets?: { path: string, excerpt: string, truncated: boolean }[], pathsAttempted?: string[] } | null} bundle
 */
export function githubCorrelationPayload(bundle) {
  if (!bundle?.label) return null;
  return {
    label: bundle.label,
    ref: bundle.ref,
    mode: bundle.mode || 'auto',
    componentsPath: bundle.componentsPath || null,
    pathsAttempted: bundle.pathsAttempted || [],
    snippets: (bundle.snippets || []).map((s) => ({
      path: s.path,
      truncated: Boolean(s.truncated),
      excerpt: s.excerpt,
      kind:
        s.kind === 'skeleton' ? 'skeleton' : s.kind === 'component' ? 'component' : 'trace',
    })),
  };
}

export function stripInternalAnalysisFields(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const { analyzeGithubKey: _k, ...rest } = obj;
  return rest;
}
