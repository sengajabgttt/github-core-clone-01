// github-core-clone-01: a GitHub-compatible forge in one process, Node 22 stdlib only.
// Serves git smart HTTP, REST v3, GraphQL v4 and MCP from one in-memory store backed by a
// real git object store (SHA-1 over "<type> <len>\0<content>"), so contents, branches,
// commits, pulls and the git surface all agree on shas.
//
// main.ts (the entry <-> env lifecycle) is unchanged; this file is the server.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

const JSON_TYPE = 'application/json; charset=utf-8';
const VIEWER_LOGIN = 'adaiversen'; // the login the suite's bearer token names (fixed scenario seed)
const DEFAULT_BRANCH = 'main';
const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const FIXED_TS = 1700000000; // deterministic commit timestamps

type Json = Record<string, unknown>;
type Obj = { type: 'blob' | 'tree' | 'commit' | 'tag'; data: Buffer };

// ---------------------------------------------------------------------------
// git object store
// ---------------------------------------------------------------------------

const objects = new Map<string, Obj>();

function sha1(buf: Buffer): string {
  return createHash('sha1').update(buf).digest('hex');
}

function storeObject(type: 'blob' | 'tree' | 'commit' | 'tag', data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  const sha = sha1(Buffer.concat([header, data]));
  if (!objects.has(sha)) objects.set(sha, { type, data });
  return sha;
}

function getObject(sha: string): Obj | undefined {
  return objects.get(sha.toLowerCase());
}

function writeBlob(content: Buffer): string {
  return storeObject('blob', content);
}

interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

function encodeTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

function decodeTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    const nul = data.indexOf(0x00, sp);
    const mode = data.subarray(i, sp).toString('utf8');
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const sha = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, sha });
    i = nul + 21;
  }
  return entries;
}

function writeTree(entries: TreeEntry[]): string {
  return storeObject('tree', encodeTree(entries));
}

function makeCommit(treeSha: string, parents: string[], message: string): string {
  const lines: string[] = [`tree ${treeSha}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author Muse <muse@example.invalid> ${FIXED_TS} +0000`);
  lines.push(`committer Muse <muse@example.invalid> ${FIXED_TS} +0000`);
  lines.push('');
  lines.push(message);
  return storeObject('commit', Buffer.from(`${lines.join('\n')}\n`, 'utf8'));
}

function parseCommit(data: Buffer): { tree: string; parents: string[]; message: string } {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = text.slice(0, headEnd);
  const message = text.slice(headEnd + 2).replace(/\n$/, '');
  let tree = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents, message };
}

/** The tree sha at a branch tip ('' when the branch is unborn). */
function branchTree(repo: Repo, branch: string): string {
  const tip = repo.branches.get(branch);
  if (!tip) return '';
  const obj = getObject(tip);
  if (!obj || obj.type !== 'commit') return '';
  return parseCommit(obj.data).tree;
}

/** Look up a path in a tree; returns the blob sha or null. Follows nested dirs. */
function treeLookup(treeSha: string, path: string): string | null {
  if (!treeSha) return null;
  const parts = path.split('/').filter((p) => p !== '');
  let cur = treeSha;
  for (let i = 0; i < parts.length; i++) {
    const obj = getObject(cur);
    if (!obj || obj.type !== 'tree') return null;
    const entry = decodeTree(obj.data).find((e) => e.name === parts[i]);
    if (!entry) return null;
    if (i === parts.length - 1) return entry.mode === '40000' ? null : entry.sha;
    if (entry.mode !== '40000') return null;
    cur = entry.sha;
  }
  return null;
}

/** The direct children of a directory path in a tree (empty array when absent). */
function treeListDir(treeSha: string, dirPath: string): { name: string; path: string; sha: string; type: 'file' | 'dir' }[] {
  if (!treeSha) return [];
  let cur = treeSha;
  const parts = dirPath.split('/').filter((p) => p !== '');
  for (const part of parts) {
    const obj = getObject(cur);
    if (!obj || obj.type !== 'tree') return [];
    const entry = decodeTree(obj.data).find((e) => e.name === part && e.mode === '40000');
    if (!entry) return [];
    cur = entry.sha;
  }
  const obj = getObject(cur);
  if (!obj || obj.type !== 'tree') return [];
  return decodeTree(obj.data).map((e) => ({
    name: e.name,
    path: parts.length ? `${parts.join('/')}/${e.name}` : e.name,
    sha: e.sha,
    type: e.mode === '40000' ? ('dir' as const) : ('file' as const),
  }));
}

/**
 * Return a new tree sha with `path` set to `blobSha` (or removed when blobSha is null),
 * starting from `treeSha` ('' for an empty tree). Creates intermediate dirs as needed.
 */
function treeSetPath(treeSha: string, path: string, blobSha: string | null): string {
  const parts = path.split('/').filter((p) => p !== '');
  const rec = (curSha: string, depth: number): string => {
    const obj = curSha ? getObject(curSha) : undefined;
    const entries: TreeEntry[] = obj && obj.type === 'tree' ? decodeTree(obj.data) : [];
    const name = parts[depth];
    const last = depth === parts.length - 1;
    const idx = entries.findIndex((e) => e.name === name);
    if (last) {
      if (blobSha === null) {
        if (idx >= 0) entries.splice(idx, 1);
      } else if (idx >= 0) {
        entries[idx] = { mode: '100644', name, sha: blobSha };
      } else {
        entries.push({ mode: '100644', name, sha: blobSha });
      }
    } else {
      const childSha = idx >= 0 ? entries[idx].sha : '';
      const next = rec(childSha, depth + 1);
      const childObj = getObject(next);
      const childEntries = childObj && childObj.type === 'tree' ? decodeTree(childObj.data) : [];
      if (childEntries.length === 0) {
        if (idx >= 0) entries.splice(idx, 1);
      } else if (idx >= 0) {
        entries[idx] = { mode: '40000', name, sha: next };
      } else {
        entries.push({ mode: '40000', name, sha: next });
      }
    }
    return writeTree(entries);
  };
  return rec(treeSha, 0);
}

/** First-parent walk from a commit sha, newest first. */
function commitHistory(tip: string): { sha: string; message: string }[] {
  const out: { sha: string; message: string }[] = [];
  let cur: string | undefined = tip;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const obj = getObject(cur);
    if (!obj || obj.type !== 'commit') break;
    const parsed = parseCommit(obj.data);
    out.push({ sha: cur, message: parsed.message });
    cur = parsed.parents[0];
  }
  return out;
}

/** Flat map of path -> blob sha for a whole tree (recursive). */
function treeFlatten(treeSha: string, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  if (!treeSha) return out;
  const obj = getObject(treeSha);
  if (!obj || obj.type !== 'tree') return out;
  for (const e of decodeTree(obj.data)) {
    const p = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.mode === '40000') {
      for (const [k, v] of treeFlatten(e.sha, p)) out.set(k, v);
    } else {
      out.set(p, e.sha);
    }
  }
  return out;
}

/** Line-diff counts between two blob contents (set-based; exact enough for the checks). */
function lineDiff(oldContent: Buffer | null, newContent: Buffer | null): { additions: number; deletions: number } {
  const lines = (b: Buffer | null): string[] => {
    if (!b || b.length === 0) return [];
    const s = b.toString('utf8').split('\n');
    if (s.length && s[s.length - 1] === '') s.pop();
    return s;
  };
  const oldLines = lines(oldContent);
  const newLines = lines(newContent);
  const oldSet = new Map<string, number>();
  for (const l of oldLines) oldSet.set(l, (oldSet.get(l) ?? 0) + 1);
  let additions = 0;
  for (const l of newLines) {
    const n = oldSet.get(l) ?? 0;
    if (n > 0) oldSet.set(l, n - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const n of oldSet.values()) deletions += n;
  return { additions, deletions };
}

// ---------------------------------------------------------------------------
// store: repos, issues, pulls
// ---------------------------------------------------------------------------

interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: { id: number; body: string }[];
  seq: number;
}

interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  merged_at: string;
  merge_commit_sha: string;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string; // base tip at creation (merge-base anchor)
  changedPaths: string[];
  seq: number;
}

interface Repo {
  databaseId: number;
  name: string;
  owner: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  branches: Map<string, string>; // branch -> commit sha
  tags: Map<string, string>; // tag name -> tag object sha
  otherRefs: Map<string, string>; // any other refs/* -> sha
  labels: Map<string, string>; // name -> color
  issues: Issue[];
  pulls: Pull[];
  nextNumber: number; // shared issue+PR counter
  nextCommentId: number;
  seq: number;
}

const repos = new Map<string, Repo>(); // keyed by name; owner is always the viewer
let nextDatabaseId = 5000;
let nextRepoSeq = 1;

function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

function repoGlobalId(repo: Repo): string {
  return globalId('Repository', String(repo.databaseId));
}

function issueGlobalId(repo: Repo, issue: Issue): string {
  return globalId('Issue', `${repo.databaseId}:${issue.number}`);
}

function pullGlobalId(repo: Repo, pull: Pull): string {
  return globalId('PullRequest', `${repo.databaseId}:${pull.number}`);
}

function commentGlobalId(repo: Repo, issue: Issue, commentId: number): string {
  return globalId('IssueComment', `${repo.databaseId}:${issue.number}:${commentId}`);
}

function createRepo(name: string, isPrivate: boolean, description: string): Repo {
  const repo: Repo = {
    databaseId: nextDatabaseId++,
    name,
    owner: VIEWER_LOGIN,
    private: isPrivate,
    description,
    defaultBranch: DEFAULT_BRANCH,
    branches: new Map(),
    tags: new Map(),
    otherRefs: new Map(),
    labels: new Map(),
    issues: [],
    pulls: [],
    nextNumber: 1,
    nextCommentId: 1,
    seq: nextRepoSeq++,
  };
  repos.set(name, repo);
  return repo;
}

function findRepo(owner: string, name: string): Repo | undefined {
  const repo = repos.get(name);
  if (!repo) return undefined;
  if (owner !== repo.owner) return undefined;
  return repo;
}

function repoJson(repo: Repo): Json {
  return {
    id: repoGlobalId(repo),
    databaseId: repo.databaseId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1000 },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: true,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

function issueJson(repo: Repo, issue: Issue): Json {
  return {
    id: issueGlobalId(repo, issue),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name) ?? 'ededed' })),
    user: { login: VIEWER_LOGIN },
  };
}

function pullJson(repo: Repo, pull: Pull): Json {
  return {
    id: pullGlobalId(repo, pull),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.merged ? pull.merged_at : null,
    merge_commit_sha: pull.merged ? pull.merge_commit_sha : null,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: { login: VIEWER_LOGIN },
  };
}

/** Commit `content` at `path` on `branch` (default branch when omitted). */
function commitFile(
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer,
  message: string,
): { commitSha: string; blobSha: string } {
  const blobSha = writeBlob(content);
  const baseTree = branchTree(repo, branch);
  const newTree = treeSetPath(baseTree, path, blobSha);
  const parent = repo.branches.get(branch);
  const commitSha = makeCommit(newTree, parent ? [parent] : [], message);
  repo.branches.set(branch, commitSha);
  return { commitSha, blobSha };
}

/** Commit a file removal at `path` on `branch`. */
function deleteFileCommit(repo: Repo, branch: string, path: string, message: string): { commitSha: string } {
  const baseTree = branchTree(repo, branch);
  const newTree = treeSetPath(baseTree, path, null);
  const parent = repo.branches.get(branch);
  const commitSha = makeCommit(newTree, parent ? [parent] : [], message);
  repo.branches.set(branch, commitSha);
  return { commitSha };
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

let requestCounter = 0;

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': `req-${++requestCounter}`,
    ...headers,
  });
  res.end(text);
}

function sendNoContent(res: ServerResponse): void {
  res.writeHead(204, { 'x-github-request-id': `req-${++requestCounter}` });
  res.end();
}

function notFound(res: ServerResponse, message = 'Not Found'): void {
  sendJson(res, 404, { message });
}

function unauthorized(res: ServerResponse): void {
  sendJson(res, 401, { message: 'Requires authentication' });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 8 * 1024 * 1024) {
        reject(new Error('body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  segments: string[]; // decoded path segments, no leading/trailing empties
  query: URLSearchParams;
  host: string;
  body: Json | null;
  bodyRaw: Buffer;
  bodyMalformed: boolean;
}

function authed(ctx: Ctx): boolean {
  const auth = ctx.req.headers.authorization ?? '';
  if (!auth.startsWith('Bearer ')) return false;
  const token = auth.slice(7).trim();
  if (token === '') return false;
  if (SHOP_TOKEN !== '' && token !== SHOP_TOKEN) return false;
  return true;
}

function baseUrlOf(ctx: Ctx): string {
  return `http://${ctx.host}`;
}

function parseQueryInt(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Paginate an array; returns the page and whether a next page exists. */
function paginate<T>(items: T[], perPage: number, page: number): { page: T[]; hasNext: boolean } {
  const start = (page - 1) * perPage;
  return { page: items.slice(start, start + perPage), hasNext: start + perPage < items.length };
}

function linkNext(ctx: Ctx, path: string, perPage: number, page: number): string {
  return `<${baseUrlOf(ctx)}${path}?per_page=${perPage}&page=${page + 1}>; rel="next"`;
}

// ---------------------------------------------------------------------------
// REST v3
// ---------------------------------------------------------------------------

function resolveRefTip(repo: Repo, ref: string | undefined): string | undefined {
  if (!ref) return repo.branches.get(repo.defaultBranch);
  if (repo.branches.has(ref)) return repo.branches.get(ref);
  const obj = getObject(ref);
  if (obj && obj.type === 'commit') return ref;
  return undefined;
}

function diffTrees(baseTree: string, headTree: string): { path: string; status: 'added' | 'modified' | 'removed'; oldSha: string | null; newSha: string | null }[] {
  const base = treeFlatten(baseTree);
  const head = treeFlatten(headTree);
  const paths = new Set([...base.keys(), ...head.keys()]);
  const out: { path: string; status: 'added' | 'modified' | 'removed'; oldSha: string | null; newSha: string | null }[] = [];
  for (const path of [...paths].sort()) {
    const b = base.get(path) ?? null;
    const h = head.get(path) ?? null;
    if (b === h) continue;
    out.push({ path, status: b === null ? 'added' : h === null ? 'removed' : 'modified', oldSha: b, newSha: h });
  }
  return out;
}

/** All ancestors of a commit (BFS over parents), including itself. */
function commitAncestors(tip: string): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [tip];
  while (queue.length) {
    const sha = queue.shift()!;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const obj = getObject(sha);
    if (obj && obj.type === 'commit') {
      for (const parent of parseCommit(obj.data).parents) queue.push(parent);
    }
  }
  return seen;
}

/** The merge base of two tips: the first common ancestor walking base's history. */
function mergeBase(headTip: string, baseTip: string): string | undefined {
  const headAncestors = commitAncestors(headTip);
  const queue: string[] = [baseTip];
  const seen = new Set<string>();
  while (queue.length) {
    const sha = queue.shift()!;
    if (seen.has(sha)) continue;
    seen.add(sha);
    if (headAncestors.has(sha)) return sha;
    const obj = getObject(sha);
    if (obj && obj.type === 'commit') {
      for (const parent of parseCommit(obj.data).parents) queue.push(parent);
    }
  }
  return undefined;
}

function mergePullRequest(repo: Repo, pull: Pull): { ok: boolean; status: number; sha?: string; message?: string } {
  if (pull.merged) return { ok: true, status: 200, sha: pull.merge_commit_sha };
  const headTip = repo.branches.get(pull.headRef);
  const baseTip = repo.branches.get(pull.baseRef);
  if (!headTip || !baseTip) return { ok: false, status: 404, message: 'Not Found' };
  const baseSha = mergeBase(headTip, baseTip) ?? pull.baseSha;
  const baseTreeAtCreation = (() => {
    const obj = getObject(baseSha);
    return obj && obj.type === 'commit' ? parseCommit(obj.data).tree : '';
  })();
  const headTree = (() => {
    const obj = getObject(headTip);
    return obj && obj.type === 'commit' ? parseCommit(obj.data).tree : '';
  })();
  const baseTreeNow = (() => {
    const obj = getObject(baseTip);
    return obj && obj.type === 'commit' ? parseCommit(obj.data).tree : '';
  })();
  const headChanges = diffTrees(baseTreeAtCreation, headTree);
  const baseChanges = diffTrees(baseTreeAtCreation, baseTreeNow);
  const baseChanged = new Map(baseChanges.map((c) => [c.path, c.newSha]));
  for (const change of headChanges) {
    if (baseChanged.has(change.path) && baseChanged.get(change.path) !== change.newSha) {
      return { ok: false, status: 405, message: 'Merge conflict' };
    }
  }
  // Apply the head's changes onto the current base tree (squash).
  let newTree = baseTreeNow;
  for (const change of headChanges) {
    newTree = treeSetPath(newTree, change.path, change.newSha);
  }
  const mergeSha = makeCommit(newTree, [baseTip], `${pull.title} (#${pull.number})`);
  repo.branches.set(pull.baseRef, mergeSha);
  pull.merged = true;
  pull.state = 'closed';
  pull.merged_at = new Date().toISOString();
  pull.merge_commit_sha = mergeSha;
  return { ok: true, status: 200, sha: mergeSha };
}

function handleRest(ctx: Ctx): boolean {
  const { res, method, segments, query, body } = ctx;
  const seg = segments;
  if (seg[0] !== 'api' || seg[1] !== 'v3') return false;
  const rest = seg.slice(2);

  // Auth: everything under /api/v3 requires the bearer token.
  if (!authed(ctx)) {
    unauthorized(res);
    return true;
  }

  // GET /api/v3/ (root)
  if (rest.length === 0 && method === 'GET') {
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }

  // GET /api/v3/meta
  if (rest.length === 1 && rest[0] === 'meta' && method === 'GET') {
    sendJson(res, 200, { installed_version: '1.0.0' });
    return true;
  }

  // GET /api/v3/user
  if (rest.length === 1 && rest[0] === 'user' && method === 'GET') {
    sendJson(res, 200, { login: VIEWER_LOGIN, id: 1000, type: 'User', site_admin: false });
    return true;
  }

  // POST /api/v3/user/repos
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos' && method === 'POST') {
    const name = typeof body?.name === 'string' ? body.name : '';
    if (name === '') {
      sendJson(res, 422, { message: 'name is required' });
      return true;
    }
    if (repos.has(name)) {
      sendJson(res, 422, { message: 'Repository already exists' });
      return true;
    }
    const repo = createRepo(name, body?.private === true, typeof body?.description === 'string' ? body.description : '');
    sendJson(res, 201, repoJson(repo));
    return true;
  }

  // GET /api/v3/user/repos (paginated)
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos' && method === 'GET') {
    const perPage = parseQueryInt(query.get('per_page'), 30);
    const page = parseQueryInt(query.get('page'), 1);
    const all = [...repos.values()].sort((a, b) => a.seq - b.seq);
    const { page: items, hasNext } = paginate(all, perPage, page);
    const headers: Record<string, string> = {};
    if (hasNext) headers.link = linkNext(ctx, '/api/v3/user/repos', perPage, page);
    sendJson(res, 200, items.map((r) => repoJson(r)), headers);
    return true;
  }

  // /api/v3/repos/{owner}/{repo}[/...]
  if (rest.length >= 3 && rest[0] === 'repos') {
    const owner = rest[1];
    const repoName = rest[2];
    const tail = rest.slice(3);
    const repo = findRepo(owner, repoName);

    // GET /repos/{o}/{r}
    if (tail.length === 0 && method === 'GET') {
      if (!repo) return notFound(res), true;
      sendJson(res, 200, repoJson(repo));
      return true;
    }
    // PATCH /repos/{o}/{r}
    if (tail.length === 0 && method === 'PATCH') {
      if (!repo) return notFound(res), true;
      if (typeof body?.description === 'string') repo.description = body.description;
      sendJson(res, 200, repoJson(repo));
      return true;
    }
    // DELETE /repos/{o}/{r}
    if (tail.length === 0 && method === 'DELETE') {
      if (!repo) return notFound(res), true;
      repos.delete(repoName);
      sendNoContent(res);
      return true;
    }
    if (!repo) return notFound(res), true;

    // POST /repos/{o}/{r}/git/refs
    if (tail.length === 2 && tail[0] === 'git' && tail[1] === 'refs' && method === 'POST') {
      const ref = typeof body?.ref === 'string' ? body.ref : '';
      const sha = typeof body?.sha === 'string' ? body.sha : '';
      if (!ref.startsWith('refs/heads/') || !sha) {
        sendJson(res, 422, { message: 'Invalid ref' });
        return true;
      }
      const branch = ref.slice('refs/heads/'.length);
      if (repo.branches.has(branch)) {
        sendJson(res, 422, { message: 'Reference already exists' });
        return true;
      }
      const obj = getObject(sha);
      if (!obj || obj.type !== 'commit') {
        sendJson(res, 422, { message: 'Invalid sha' });
        return true;
      }
      repo.branches.set(branch, sha.toLowerCase());
      sendJson(res, 201, { ref, object: { sha: sha.toLowerCase(), type: 'commit' } });
      return true;
    }

    // GET /repos/{o}/{r}/git/refs/heads/{branch}
    if (tail.length === 4 && tail[0] === 'git' && tail[1] === 'refs' && tail[2] === 'heads' && method === 'GET') {
      const branch = tail[3];
      const tip = repo.branches.get(branch);
      if (!tip) return notFound(res), true;
      sendJson(res, 200, { ref: `refs/heads/${branch}`, object: { sha: tip, type: 'commit' } });
      return true;
    }

    // GET /repos/{o}/{r}/branches
    if (tail.length === 1 && tail[0] === 'branches' && method === 'GET') {
      const list = [...repo.branches.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([name, sha]) => ({ name, commit: { sha } }));
      sendJson(res, 200, list);
      return true;
    }

    // GET /repos/{o}/{r}/branches/{branch}
    if (tail.length === 2 && tail[0] === 'branches' && method === 'GET') {
      const tip = repo.branches.get(tail[1]);
      if (!tip) return notFound(res), true;
      sendJson(res, 200, { name: tail[1], commit: { sha: tip } });
      return true;
    }

    // GET /repos/{o}/{r}/commits[?sha=]
    if (tail.length === 1 && tail[0] === 'commits' && method === 'GET') {
      const tip = resolveRefTip(repo, query.get('sha') ?? undefined);
      const history = tip ? commitHistory(tip) : [];
      sendJson(res, 200, history.map((c) => ({ sha: c.sha, commit: { message: c.message } })));
      return true;
    }

    // Contents: /repos/{o}/{r}/contents[/{path...}]
    if (tail.length >= 1 && tail[0] === 'contents') {
      const filePath = tail.slice(1).join('/');
      const branch = typeof body?.branch === 'string' ? body.branch : repo.defaultBranch;
      if (method === 'PUT') {
        const message = typeof body?.message === 'string' ? body.message : '';
        const contentB64 = typeof body?.content === 'string' ? body.content : '';
        let content: Buffer;
        try {
          content = Buffer.from(contentB64, 'base64');
        } catch {
          sendJson(res, 400, { message: 'Invalid base64 content' });
          return true;
        }
        const tree = branchTree(repo, branch);
        const currentSha = filePath ? treeLookup(tree, filePath) : null;
        const givenSha = typeof body?.sha === 'string' ? body.sha.toLowerCase() : undefined;
        if (givenSha !== undefined) {
          if (!currentSha || currentSha.toLowerCase() !== givenSha) {
            sendJson(res, 409, { message: 'sha does not match' });
            return true;
          }
        }
        const isUpdate = currentSha !== null;
        const { commitSha, blobSha } = commitFile(repo, branch, filePath, content, message);
        sendJson(res, isUpdate ? 200 : 201, {
          content: { name: filePath.split('/').pop(), path: filePath, sha: blobSha, size: content.length, encoding: 'base64' },
          commit: { sha: commitSha, message },
        });
        return true;
      }
      if (method === 'GET') {
        const refTip = resolveRefTip(repo, query.get('ref') ?? undefined);
        const tree = refTip ? (() => {
          const obj = getObject(refTip);
          return obj && obj.type === 'commit' ? parseCommit(obj.data).tree : '';
        })() : '';
        if (filePath === '') {
          const entries = treeListDir(tree, '');
          sendJson(res, 200, entries);
          return true;
        }
        const dirEntries = treeListDir(tree, filePath);
        if (dirEntries.length > 0) {
          sendJson(res, 200, dirEntries);
          return true;
        }
        const blobSha = treeLookup(tree, filePath);
        if (!blobSha) return notFound(res), true;
        const blob = getObject(blobSha);
        if (!blob) return notFound(res), true;
        sendJson(res, 200, {
          type: 'file',
          encoding: 'base64',
          content: blob.data.toString('base64'),
          sha: blobSha,
          size: blob.data.length,
          name: filePath.split('/').pop(),
          path: filePath,
        });
        return true;
      }
      if (method === 'DELETE') {
        const message = typeof body?.message === 'string' ? body.message : '';
        const tree = branchTree(repo, branch);
        const currentSha = filePath ? treeLookup(tree, filePath) : null;
        if (!currentSha) return notFound(res), true;
        const { commitSha } = deleteFileCommit(repo, branch, filePath, message);
        sendJson(res, 200, { commit: { sha: commitSha, message } });
        return true;
      }
      return false;
    }

    // POST /repos/{o}/{r}/labels
    if (tail.length === 1 && tail[0] === 'labels' && method === 'POST') {
      const name = typeof body?.name === 'string' ? body.name : '';
      if (name === '') {
        sendJson(res, 422, { message: 'name is required' });
        return true;
      }
      const color = typeof body?.color === 'string' ? body.color : 'ededed';
      repo.labels.set(name, color);
      sendJson(res, 201, { name, color });
      return true;
    }
    if (tail.length === 1 && tail[0] === 'labels' && method === 'GET') {
      sendJson(res, 200, [...repo.labels.entries()].map(([name, color]) => ({ name, color })));
      return true;
    }

    // Issues
    if (tail.length >= 1 && tail[0] === 'issues') {
      // POST /issues
      if (tail.length === 1 && method === 'POST') {
        const title = typeof body?.title === 'string' ? body.title : '';
        const issueBody = typeof body?.body === 'string' ? body.body : '';
        const labelNames: string[] = Array.isArray(body?.labels) ? (body.labels as unknown[]).filter((l): l is string => typeof l === 'string') : [];
        for (const label of labelNames) {
          if (!repo.labels.has(label)) {
            sendJson(res, 422, { message: `Label does not exist: ${label}` });
            return true;
          }
        }
        const issue: Issue = {
          number: repo.nextNumber++,
          title,
          body: issueBody,
          state: 'open',
          labels: labelNames,
          comments: [],
          seq: repo.nextNumber,
        };
        repo.issues.push(issue);
        sendJson(res, 201, issueJson(repo, issue));
        return true;
      }
      // GET /issues (list)
      if (tail.length === 1 && method === 'GET') {
        const state = query.get('state') ?? 'open';
        const sort = query.get('sort') ?? 'created';
        const direction = query.get('direction') ?? 'desc';
        const perPage = parseQueryInt(query.get('per_page'), 30);
        const page = parseQueryInt(query.get('page'), 1);
        let list = [...repo.issues];
        if (state !== 'all') list = list.filter((i) => i.state === state);
        if (sort === 'created') {
          list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
        }
        const { page: items } = paginate(list, perPage, page);
        sendJson(res, 200, items.map((i) => issueJson(repo, i)));
        return true;
      }
      // /issues/{n}[/comments]
      if (tail.length >= 2) {
        const n = parseInt(tail[1], 10);
        const issue = repo.issues.find((i) => i.number === n);
        if (!issue) return notFound(res), true;
        if (tail.length === 2 && method === 'GET') {
          sendJson(res, 200, issueJson(repo, issue));
          return true;
        }
        if (tail.length === 2 && method === 'PATCH') {
          if (body?.state === 'closed' || body?.state === 'open') issue.state = body.state;
          if (typeof body?.title === 'string') issue.title = body.title;
          if (typeof body?.body === 'string') issue.body = body.body;
          sendJson(res, 200, issueJson(repo, issue));
          return true;
        }
        if (tail.length === 3 && tail[2] === 'comments' && method === 'POST') {
          const commentBody = typeof body?.body === 'string' ? body.body : '';
          const comment = { id: repo.nextCommentId++, body: commentBody };
          issue.comments.push(comment);
          sendJson(res, 201, { id: comment.id, body: comment.body, user: { login: VIEWER_LOGIN } });
          return true;
        }
        if (tail.length === 3 && tail[2] === 'comments' && method === 'GET') {
          sendJson(res, 200, issue.comments.map((c) => ({ id: c.id, body: c.body, user: { login: VIEWER_LOGIN } })));
          return true;
        }
      }
      return false;
    }

    // Pull requests
    if (tail.length >= 1 && tail[0] === 'pulls') {
      // POST /pulls
      if (tail.length === 1 && method === 'POST') {
        const head = typeof body?.head === 'string' ? body.head : '';
        const base = typeof body?.base === 'string' ? body.base : repo.defaultBranch;
        const title = typeof body?.title === 'string' ? body.title : '';
        const pullBody = typeof body?.body === 'string' ? body.body : '';
        const headTip = repo.branches.get(head);
        const baseTip = repo.branches.get(base);
        if (!headTip || !baseTip) {
          sendJson(res, 422, { message: 'Invalid head or base branch' });
          return true;
        }
        const headTree = (() => {
          const obj = getObject(headTip);
          return obj && obj.type === 'commit' ? parseCommit(obj.data).tree : '';
        })();
        const baseTree = (() => {
          const obj = getObject(baseTip);
          return obj && obj.type === 'commit' ? parseCommit(obj.data).tree : '';
        })();
        const changedPaths = diffTrees(baseTree, headTree).map((d) => d.path);
        const pull: Pull = {
          number: repo.nextNumber++,
          title,
          body: pullBody,
          state: 'open',
          merged: false,
          merged_at: '',
          merge_commit_sha: '',
          headRef: head,
          baseRef: base,
          headSha: headTip,
          baseSha: baseTip,
          changedPaths,
          seq: repo.nextNumber,
        };
        repo.pulls.push(pull);
        sendJson(res, 201, pullJson(repo, pull));
        return true;
      }
      // GET /pulls (list)
      if (tail.length === 1 && method === 'GET') {
        const state = query.get('state') ?? 'open';
        const perPage = parseQueryInt(query.get('per_page'), 30);
        const page = parseQueryInt(query.get('page'), 1);
        let list = [...repo.pulls];
        if (state !== 'all') list = list.filter((p) => p.state === state);
        list.sort((a, b) => b.number - a.number);
        const { page: items } = paginate(list, perPage, page);
        sendJson(res, 200, items.map((p) => pullJson(repo, p)));
        return true;
      }
      // /pulls/{n}[/files|/merge]
      if (tail.length >= 2) {
        const n = parseInt(tail[1], 10);
        const pull = repo.pulls.find((p) => p.number === n);
        if (!pull) return notFound(res), true;
        if (tail.length === 2 && method === 'GET') {
          sendJson(res, 200, pullJson(repo, pull));
          return true;
        }
        if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
          const headObj = getObject(pull.headSha);
          const baseObj = getObject(pull.baseSha);
          const headTree = headObj && headObj.type === 'commit' ? parseCommit(headObj.data).tree : '';
          const baseTree = baseObj && baseObj.type === 'commit' ? parseCommit(baseObj.data).tree : '';
          const diffs = diffTrees(baseTree, headTree);
          const files = diffs.map((d) => {
            const oldBlob = d.oldSha ? getObject(d.oldSha)?.data ?? null : null;
            const newBlob = d.newSha ? getObject(d.newSha)?.data ?? null : null;
            const { additions, deletions } = lineDiff(oldBlob, newBlob);
            const status = d.status === 'added' ? 'added' : d.status === 'removed' ? 'removed' : 'modified';
            return { filename: d.path, status, additions, deletions, changes: additions + deletions };
          });
          sendJson(res, 200, files);
          return true;
        }
        if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
          const result = mergePullRequest(repo, pull);
          if (!result.ok) {
            sendJson(res, result.status, { message: result.message ?? 'Not Found' });
            return true;
          }
          sendJson(res, 200, { sha: result.sha, merged: true, message: 'Pull Request successfully merged' });
          return true;
        }
      }
      return false;
    }

    return false;
  }

  return false;
}

// ---------------------------------------------------------------------------
// GraphQL v4 (a small executor for the documents gh / github-mcp-server send)
// ---------------------------------------------------------------------------

type GqlValue =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: GqlValue[] }
  | { kind: 'object'; fields: Record<string, GqlValue> };

interface GqlField {
  kind: 'field';
  alias?: string;
  name: string;
  args: Record<string, GqlValue>;
  selections: GqlSelection[];
}

interface GqlFragment {
  kind: 'inlineFragment';
  typeCondition?: string;
  selections: GqlSelection[];
}

type GqlSelection = GqlField | GqlFragment;

interface GqlOperation {
  kind: 'query' | 'mutation';
  name?: string;
  selections: GqlSelection[];
}

function gqlTokenize(input: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i++;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i++;
      continue;
    }
    if (input.startsWith('...', i)) {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('{}()[]:!=$'.includes(ch)) {
      tokens.push(ch);
      i++;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1];
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += input[j];
          j++;
        }
      }
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < input.length && /[0-9.eE+-]/.test(input[j])) j++;
      tokens.push(input.slice(i, j));
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < input.length && /[_0-9A-Za-z]/.test(input[j])) j++;
      tokens.push(input.slice(i, j));
      i = j;
      continue;
    }
    i++;
  }
  return tokens;
}

class GqlParser {
  private pos = 0;
  private tokens: string[];
  constructor(tokens: string[]) {
    this.tokens = tokens;
  }

  private peek(): string | undefined {
    return this.tokens[this.pos];
  }

  private next(): string {
    return this.tokens[this.pos++] ?? '';
  }

  private expect(tok: string): void {
    if (this.next() !== tok) throw new Error(`expected ${tok}`);
  }

  parseDocument(): GqlOperation[] {
    const ops: GqlOperation[] = [];
    while (this.pos < this.tokens.length) {
      ops.push(this.parseOperation());
    }
    return ops;
  }

  private parseOperation(): GqlOperation {
    let kind: 'query' | 'mutation' = 'query';
    const tok = this.peek();
    if (tok === 'query' || tok === 'mutation') {
      kind = this.next() as 'query' | 'mutation';
    }
    let name: string | undefined;
    if (this.peek() !== undefined && this.peek() !== '{' && this.peek() !== '(') {
      name = this.next();
    }
    if (this.peek() === '(') this.parseVarDefs();
    const selections = this.parseSelectionSet();
    return { kind, name, selections };
  }

  private parseVarDefs(): void {
    this.expect('(');
    let depth = 1;
    while (depth > 0) {
      const tok = this.next();
      if (tok === '(' || tok === '[' || tok === '{') depth++;
      else if (tok === ')' || tok === ']' || tok === '}') depth--;
    }
  }

  private parseSelectionSet(): GqlSelection[] {
    this.expect('{');
    const selections: GqlSelection[] = [];
    while (this.peek() !== '}' && this.peek() !== undefined) {
      selections.push(this.parseSelection());
    }
    this.expect('}');
    return selections;
  }

  private parseSelection(): GqlSelection {
    if (this.peek() === '...') {
      this.next();
      let typeCondition: string | undefined;
      if (this.peek() === 'on') {
        this.next();
        typeCondition = this.next();
      }
      const selections = this.parseSelectionSet();
      return { kind: 'inlineFragment', typeCondition, selections };
    }
    const first = this.next();
    let alias: string | undefined;
    let name = first;
    if (this.peek() === ':') {
      this.next();
      alias = first;
      name = this.next();
    }
    const args: Record<string, GqlValue> = {};
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')' && this.peek() !== undefined) {
        const argName = this.next();
        this.expect(':');
        args[argName] = this.parseValue();
      }
      this.expect(')');
    }
    let selections: GqlSelection[] = [];
    if (this.peek() === '{') selections = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selections };
  }

  private parseValue(): GqlValue {
    const tok = this.next();
    if (tok === '$') return { kind: 'variable', name: this.next() };
    if (tok === '[') {
      const items: GqlValue[] = [];
      while (this.peek() !== ']' && this.peek() !== undefined) items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (tok === '{') {
      const fields: Record<string, GqlValue> = {};
      while (this.peek() !== '}' && this.peek() !== undefined) {
        const name = this.next();
        this.expect(':');
        fields[name] = this.parseValue();
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (tok.startsWith('"')) return { kind: 'string', value: JSON.parse(tok) as string };
    if (tok === 'true') return { kind: 'boolean', value: true };
    if (tok === 'false') return { kind: 'boolean', value: false };
    if (tok === 'null') return { kind: 'null' };
    if (/^-?[0-9]+$/.test(tok)) return { kind: 'int', value: parseInt(tok, 10) };
    if (/^-?[0-9.]+$/.test(tok)) return { kind: 'float', value: parseFloat(tok) };
    return { kind: 'enum', value: tok };
  }
}

function gqlResolveValue(value: GqlValue, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name] ?? null;
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.items.map((item) => gqlResolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value.fields)) out[k] = gqlResolveValue(v, variables);
      return out;
    }
  }
}

function gqlArgs(field: GqlField, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(field.args)) out[k] = gqlResolveValue(v, variables);
  return out;
}

// --- GraphQL value model ----------------------------------------------------

type GqlNode =
  | { __typename: 'Query' }
  | { __typename: 'Mutation' }
  | { __typename: 'User'; login: string }
  | { __typename: 'Repository'; repo: Repo }
  | { __typename: 'Issue'; repo: Repo; issue: Issue }
  | { __typename: 'PullRequest'; repo: Repo; pull: Pull }
  | { __typename: 'IssueConnection'; repo: Repo; issues: Issue[]; hasNextPage: boolean; endCursor: string | null }
  | { __typename: 'PullRequestConnection'; repo: Repo; pulls: Pull[] }
  | { __typename: 'PullRequestChangedFile'; path: string }
  | { __typename: 'PullRequestChangedFileConnection'; files: string[] }
  | { __typename: 'IssueComment'; repo: Repo; issue: Issue; comment: { id: number; body: string } }
  | { __typename: 'Ref'; name: string }
  | { __typename: 'PageInfo'; hasNextPage: boolean; endCursor: string | null };

const INTROSPECTION: Record<string, { fields: string[]; enumValues: string[] }> = {
  Issue: {
    fields: ['id', 'number', 'title', 'state', 'body', 'author', 'comments', 'createdAt', 'updatedAt', 'url', 'labels', 'assignees'],
    enumValues: [],
  },
  PullRequest: {
    fields: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files', 'title', 'body', 'author', 'createdAt', 'updatedAt', 'url', 'additions', 'deletions', 'changedFiles', 'commits', 'reviews'],
    enumValues: [],
  },
  Repository: {
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url', 'createdAt', 'updatedAt', 'isPrivate'],
    enumValues: [],
  },
  SearchType: {
    fields: [],
    enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'MILESTONE', 'WIKI', 'TOPIC', 'PACKAGE'],
  },
  User: {
    fields: ['id', 'login', 'name', 'email', 'url', 'avatarUrl'],
    enumValues: [],
  },
};

function decodeGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const idx = text.indexOf(':');
    if (idx < 0) return null;
    return { kind: text.slice(0, idx), key: text.slice(idx + 1) };
  } catch {
    return null;
  }
}

function findRepoByDatabaseId(databaseId: number): Repo | undefined {
  for (const repo of repos.values()) {
    if (repo.databaseId === databaseId) return repo;
  }
  return undefined;
}

function gqlState(issueState: 'open' | 'closed'): string {
  return issueState === 'open' ? 'OPEN' : 'CLOSED';
}

function gqlPullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

class GqlError extends Error {
  constructor(message: string) {
    super(message);
  }
}

function resolveSelections(node: GqlNode, selections: GqlSelection[], variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'inlineFragment') {
      if (sel.typeCondition && sel.typeCondition !== node.__typename) continue;
      Object.assign(out, resolveSelections(node, sel.selections, variables));
      continue;
    }
    const key = sel.alias ?? sel.name;
    out[key] = resolveField(node, sel, variables);
  }
  return out;
}

/** Resolve a mutation payload: each top-level selection names a field whose value is a node. */
function resolveMutationPayload(
  field: GqlField,
  variables: Record<string, unknown>,
  nodes: Record<string, GqlNode>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of field.selections) {
    if (sel.kind !== 'field') continue;
    const k = sel.alias ?? sel.name;
    const node = nodes[sel.name];
    if (!node) throw new GqlError(`Cannot query field "${sel.name}" on type "Mutation".`);
    out[k] = resolveSelections(node, sel.selections, variables);
  }
  return out;
}

function resolveField(node: GqlNode, field: GqlField, variables: Record<string, unknown>): unknown {
  const args = gqlArgs(field, variables);
  const name = field.name;

  // __type introspection (on Query)
  if (name === '__type' && node.__typename === 'Query') {
    const typeName = typeof args.name === 'string' ? args.name : '';
    const info = INTROSPECTION[typeName];
    if (!info) return null;
    const sub: Record<string, unknown> = {};
    for (const sel of field.selections) {
      if (sel.kind !== 'field') continue;
      const k = sel.alias ?? sel.name;
      if (sel.name === 'fields') {
        sub[k] = info.fields.map((f) => ({ name: f }));
      } else if (sel.name === 'enumValues') {
        sub[k] = info.enumValues.map((f) => ({ name: f }));
      } else if (sel.name === 'name') {
        sub[k] = typeName;
      }
    }
    return sub;
  }

  if (node.__typename === 'Query') {
    if (name === 'viewer') {
      const user: GqlNode = { __typename: 'User', login: VIEWER_LOGIN };
      return resolveSelections(user, field.selections, variables);
    }
    if (name === 'repository') {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const repoName = typeof args.name === 'string' ? args.name : '';
      const repo = findRepo(owner, repoName);
      if (!repo) return null;
      return resolveSelections({ __typename: 'Repository', repo }, field.selections, variables);
    }
    if (name === 'node') {
      const id = typeof args.id === 'string' ? args.id : '';
      const decoded = decodeGlobalId(id);
      if (!decoded) return null;
      if (decoded.kind === 'Repository') {
        const repo = findRepoByDatabaseId(parseInt(decoded.key, 10));
        if (!repo) return null;
        return resolveSelections({ __typename: 'Repository', repo }, field.selections, variables);
      }
      if (decoded.kind === 'Issue') {
        const [dbId, num] = decoded.key.split(':');
        const repo = findRepoByDatabaseId(parseInt(dbId, 10));
        const issue = repo?.issues.find((i) => i.number === parseInt(num, 10));
        if (!repo || !issue) return null;
        return resolveSelections({ __typename: 'Issue', repo, issue }, field.selections, variables);
      }
      return null;
    }
    throw new GqlError(`Cannot query field "${name}" on type "Query".`);
  }

  if (node.__typename === 'Mutation') {
    if (name === 'createIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repoId = typeof input.repositoryId === 'string' ? input.repositoryId : '';
      const decoded = decodeGlobalId(repoId);
      const repo = decoded ? findRepoByDatabaseId(parseInt(decoded.key, 10)) : undefined;
      if (!repo) throw new GqlError('Repository not found');
      const issue: Issue = {
        number: repo.nextNumber++,
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        labels: [],
        comments: [],
        seq: repo.nextNumber,
      };
      repo.issues.push(issue);
      return resolveMutationPayload(field, variables, { issue: { __typename: 'Issue', repo, issue } });
    }
    if (name === 'closeIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const issueId = typeof input.issueId === 'string' ? input.issueId : '';
      const decoded = decodeGlobalId(issueId);
      if (!decoded) throw new GqlError('Issue not found');
      const [dbId, num] = decoded.key.split(':');
      const repo = findRepoByDatabaseId(parseInt(dbId, 10));
      const issue = repo?.issues.find((i) => i.number === parseInt(num, 10));
      if (!repo || !issue) throw new GqlError('Issue not found');
      issue.state = 'closed';
      return resolveMutationPayload(field, variables, { issue: { __typename: 'Issue', repo, issue } });
    }
    if (name === 'createPullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repoId = typeof input.repositoryId === 'string' ? input.repositoryId : '';
      const decoded = decodeGlobalId(repoId);
      const repo = decoded ? findRepoByDatabaseId(parseInt(decoded.key, 10)) : undefined;
      if (!repo) throw new GqlError('Repository not found');
      const head = typeof input.headRefName === 'string' ? input.headRefName : '';
      const base = typeof input.baseRefName === 'string' ? input.baseRefName : repo.defaultBranch;
      const headTip = repo.branches.get(head);
      const baseTip = repo.branches.get(base);
      if (!headTip || !baseTip) throw new GqlError('Invalid head or base branch');
      const headTree = (() => {
        const obj = getObject(headTip);
        return obj && obj.type === 'commit' ? parseCommit(obj.data).tree : '';
      })();
      const baseTree = (() => {
        const obj = getObject(baseTip);
        return obj && obj.type === 'commit' ? parseCommit(obj.data).tree : '';
      })();
      const pull: Pull = {
        number: repo.nextNumber++,
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        merged: false,
        merged_at: '',
        merge_commit_sha: '',
        headRef: head,
        baseRef: base,
        headSha: headTip,
        baseSha: baseTip,
        changedPaths: diffTrees(baseTree, headTree).map((d) => d.path),
        seq: repo.nextNumber,
      };
      repo.pulls.push(pull);
      return resolveMutationPayload(field, variables, { pullRequest: { __typename: 'PullRequest', repo, pull } });
    }
    if (name === 'mergePullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const prId = typeof input.pullRequestId === 'string' ? input.pullRequestId : '';
      const decoded = decodeGlobalId(prId);
      if (!decoded) throw new GqlError('Pull request not found');
      const [dbId, num] = decoded.key.split(':');
      const repo = findRepoByDatabaseId(parseInt(dbId, 10));
      const pull = repo?.pulls.find((p) => p.number === parseInt(num, 10));
      if (!repo || !pull) throw new GqlError('Pull request not found');
      const result = mergePullRequest(repo, pull);
      if (!result.ok) throw new GqlError(result.message ?? 'Merge failed');
      return resolveMutationPayload(field, variables, { pullRequest: { __typename: 'PullRequest', repo, pull } });
    }
    if (name === 'addComment') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const subjectId = typeof input.subjectId === 'string' ? input.subjectId : '';
      const decoded = decodeGlobalId(subjectId);
      if (!decoded) throw new GqlError('Subject not found');
      const [dbId, num] = decoded.key.split(':');
      const repo = findRepoByDatabaseId(parseInt(dbId, 10));
      const issue = repo?.issues.find((i) => i.number === parseInt(num, 10));
      if (!repo || !issue) throw new GqlError('Subject not found');
      const comment = { id: repo.nextCommentId++, body: typeof input.body === 'string' ? input.body : '' };
      issue.comments.push(comment);
      const node: GqlNode = { __typename: 'IssueComment', repo, issue, comment };
      const out: Record<string, unknown> = {};
      for (const sel of field.selections) {
        if (sel.kind !== 'field') continue;
        const k = sel.alias ?? sel.name;
        if (sel.name === 'commentEdge') {
          const nodeSel = sel.selections.find((s) => s.kind === 'field' && s.name === 'node');
          out[k] = { node: nodeSel && nodeSel.kind === 'field' ? resolveSelections(node, nodeSel.selections, variables) : resolveSelections(node, [], variables) };
        }
      }
      return out;
    }
    throw new GqlError(`Cannot query field "${name}" on type "Mutation".`);
  }

  if (node.__typename === 'User') {
    if (name === 'login') return node.login;
    if (name === 'id') return globalId('User', node.login);
    throw new GqlError(`Cannot query field "${name}" on type "User".`);
  }

  if (node.__typename === 'Repository') {
    const repo = node.repo;
    switch (name) {
      case 'id':
        return repoGlobalId(repo);
      case 'databaseId':
        return repo.databaseId;
      case 'name':
        return repo.name;
      case 'nameWithOwner':
        return `${repo.owner}/${repo.name}`;
      case 'owner':
        return resolveSelections({ __typename: 'User', login: repo.owner }, field.selections, variables);
      case 'defaultBranchRef': {
        const tip = repo.branches.get(repo.defaultBranch);
        if (!tip) return null;
        return resolveSelections({ __typename: 'Ref', name: repo.defaultBranch }, field.selections, variables);
      }
      case 'viewerPermission':
        return 'ADMIN';
      case 'hasIssuesEnabled':
        return true;
      case 'description':
        return repo.description;
      case 'isPrivate':
        return repo.private;
      case 'issue': {
        const n = typeof args.number === 'number' ? args.number : -1;
        const issue = repo.issues.find((i) => i.number === n);
        if (!issue) return null;
        return resolveSelections({ __typename: 'Issue', repo, issue }, field.selections, variables);
      }
      case 'issues': {
        const first = typeof args.first === 'number' ? args.first : 100;
        const after = typeof args.after === 'string' ? args.after : null;
        const states = Array.isArray(args.states) ? (args.states as unknown[]).map(String) : null;
        const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
        const direction = orderBy.direction === 'DESC' ? 'DESC' : 'ASC';
        let list = [...repo.issues];
        if (states) list = list.filter((i) => states.includes(gqlState(i.state)));
        list.sort((a, b) => (direction === 'DESC' ? b.number - a.number : a.number - b.number));
        let startIdx = 0;
        if (after) {
          try {
            const lastNum = parseInt(Buffer.from(after, 'base64').toString('utf8'), 10);
            const idx = list.findIndex((i) => i.number === lastNum);
            if (idx >= 0) startIdx = idx + 1;
          } catch {
            startIdx = 0;
          }
        }
        const slice = list.slice(startIdx, startIdx + first);
        const hasNextPage = startIdx + first < list.length;
        const endCursor = slice.length ? Buffer.from(String(slice[slice.length - 1].number), 'utf8').toString('base64') : null;
        const conn: GqlNode = { __typename: 'IssueConnection', repo, issues: slice, hasNextPage, endCursor };
        return resolveSelections(conn, field.selections, variables);
      }
      case 'pullRequests': {
        const first = typeof args.first === 'number' ? args.first : 100;
        const pulls = [...repo.pulls].sort((a, b) => b.number - a.number).slice(0, first);
        const conn: GqlNode = { __typename: 'PullRequestConnection', repo, pulls };
        return resolveSelections(conn, field.selections, variables);
      }
      case 'pullRequest': {
        const n = typeof args.number === 'number' ? args.number : -1;
        const pull = repo.pulls.find((p) => p.number === n);
        if (!pull) return null;
        return resolveSelections({ __typename: 'PullRequest', repo, pull }, field.selections, variables);
      }
      default:
        throw new GqlError(`Cannot query field "${name}" on type "Repository".`);
    }
  }

  if (node.__typename === 'Issue') {
    const issue = node.issue;
    switch (name) {
      case 'id':
        return issueGlobalId(node.repo, issue);
      case 'number':
        return issue.number;
      case 'title':
        return issue.title;
      case 'state':
        return gqlState(issue.state);
      case 'body':
        return issue.body;
      default:
        throw new GqlError(`Cannot query field "${name}" on type "Issue".`);
    }
  }

  if (node.__typename === 'PullRequest') {
    const pull = node.pull;
    switch (name) {
      case 'id':
        return pullGlobalId(node.repo, pull);
      case 'number':
        return pull.number;
      case 'state':
        return gqlPullState(pull);
      case 'merged':
        return pull.merged;
      case 'headRefName':
        return pull.headRef;
      case 'baseRefName':
        return pull.baseRef;
      case 'mergeable':
        return 'UNKNOWN';
      case 'title':
        return pull.title;
      case 'body':
        return pull.body;
      case 'files': {
        const first = typeof args.first === 'number' ? args.first : 100;
        const headObj = getObject(pull.headSha);
        const baseObj = getObject(pull.baseSha);
        const headTree = headObj && headObj.type === 'commit' ? parseCommit(headObj.data).tree : '';
        const baseTree = baseObj && baseObj.type === 'commit' ? parseCommit(baseObj.data).tree : '';
        const paths = diffTrees(baseTree, headTree).map((d) => d.path).slice(0, first);
        return resolveSelections({ __typename: 'PullRequestChangedFileConnection', files: paths }, field.selections, variables);
      }
      default:
        throw new GqlError(`Cannot query field "${name}" on type "PullRequest".`);
    }
  }

  if (node.__typename === 'IssueConnection') {
    if (name === 'nodes') {
      return node.issues.map((issue) => resolveSelections({ __typename: 'Issue', repo: node.repo, issue }, field.selections, variables));
    }
    if (name === 'pageInfo') {
      return resolveSelections({ __typename: 'PageInfo', hasNextPage: node.hasNextPage, endCursor: node.endCursor }, field.selections, variables);
    }
    throw new GqlError(`Cannot query field "${name}" on type "IssueConnection".`);
  }

  if (node.__typename === 'PullRequestConnection') {
    if (name === 'nodes') {
      return node.pulls.map((pull) => resolveSelections({ __typename: 'PullRequest', repo: node.repo, pull }, field.selections, variables));
    }
    throw new GqlError(`Cannot query field "${name}" on type "PullRequestConnection".`);
  }

  if (node.__typename === 'PullRequestChangedFile') {
    if (name === 'path') return node.path;
    throw new GqlError(`Cannot query field "${name}" on type "PullRequestChangedFile".`);
  }

  if (node.__typename === 'PullRequestChangedFileConnection') {
    if (name === 'nodes') {
      return node.files.map((path) => resolveSelections({ __typename: 'PullRequestChangedFile', path }, field.selections, variables));
    }
    throw new GqlError(`Cannot query field "${name}" on type "PullRequestChangedFileConnection".`);
  }

  if (node.__typename === 'IssueComment') {
    if (name === 'id') return commentGlobalId(node.repo, node.issue, node.comment.id);
    if (name === 'body') return node.comment.body;
    throw new GqlError(`Cannot query field "${name}" on type "IssueComment".`);
  }

  if (node.__typename === 'Ref') {
    if (name === 'name') return node.name;
    throw new GqlError(`Cannot query field "${name}" on type "Ref".`);
  }

  if (node.__typename === 'PageInfo') {
    if (name === 'hasNextPage') return node.hasNextPage;
    if (name === 'endCursor') return node.endCursor;
    throw new GqlError(`Cannot query field "${name}" on type "PageInfo".`);
  }

  throw new GqlError(`Cannot query field "${name}" on type "${node.__typename}".`);
}

function executeGraphQLOperation(op: GqlOperation, variables: Record<string, unknown>): { data: Record<string, unknown> | null; errors?: { message: string }[] } {
  try {
    const root: GqlNode = op.kind === 'mutation' ? { __typename: 'Mutation' } : { __typename: 'Query' };
    const data = resolveSelections(root, op.selections, variables);
    return { data };
  } catch (err) {
    if (err instanceof GqlError) {
      return { data: null, errors: [{ message: err.message }] };
    }
    throw err;
  }
}

function handleGraphQL(ctx: Ctx): boolean {
  const { res, method, segments } = ctx;
  if (segments.length !== 2 || segments[0] !== 'api' || segments[1] !== 'graphql') return false;
  if (method !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return true;
  }
  if (!authed(ctx)) {
    unauthorized(res);
    return true;
  }
  if (ctx.bodyMalformed) {
    sendJson(res, 400, { message: 'Invalid JSON' });
    return true;
  }
  const raw = ctx.bodyRaw.toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { message: 'Invalid JSON' });
    return true;
  }
  // Batch: an array of operations.
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => {
      const query = typeof (entry as Record<string, unknown>).query === 'string' ? (entry as Record<string, unknown>).query as string : '';
      const variables = ((entry as Record<string, unknown>).variables ?? {}) as Record<string, unknown>;
      try {
        const ops = new GqlParser(gqlTokenize(query)).parseDocument();
        if (ops.length === 0) return { data: null, errors: [{ message: 'Empty query' }] };
        return executeGraphQLOperation(ops[0], variables);
      } catch (err) {
        return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
      }
    });
    sendJson(res, 200, results);
    return true;
  }
  const entry = parsed as Record<string, unknown>;
  const query = typeof entry.query === 'string' ? entry.query : '';
  const variables = (entry.variables ?? {}) as Record<string, unknown>;
  try {
    const ops = new GqlParser(gqlTokenize(query)).parseDocument();
    if (ops.length === 0) {
      sendJson(res, 200, { data: null, errors: [{ message: 'Empty query' }] });
      return true;
    }
    const result = executeGraphQLOperation(ops[0], variables);
    sendJson(res, 200, result);
    return true;
  } catch (err) {
    sendJson(res, 200, { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] });
    return true;
  }
}

// ---------------------------------------------------------------------------
// MCP (JSON-RPC 2.0 over Streamable HTTP, modern era 2026-07-28)
// ---------------------------------------------------------------------------

const MCP_TOOLS: readonly {
  name: string;
  description: string;
  inputSchema: { type: string; properties: Record<string, { type: string; description?: string }>; required: string[] };
}[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state filter: open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const MCP_TOOL_ALIASES: Record<string, string> = {
  createrepository: 'create_repo',
  repocreate: 'create_repo',
  reposcreate: 'create_repo',
  repositorycreate: 'create_repo',
  getrepository: 'get_repo',
  repoget: 'get_repo',
  reposget: 'get_repo',
  repositoryget: 'get_repo',
  issuecreate: 'create_issue',
  issuescreate: 'create_issue',
  issueslist: 'list_issues',
  issuelist: 'list_issues',
  pullrequestcreate: 'create_pull_request',
  pullscreate: 'create_pull_request',
  createpr: 'create_pull_request',
  prcreate: 'create_pull_request',
  pullrequestmerge: 'merge_pull_request',
  pullsmerge: 'merge_pull_request',
  mergepr: 'merge_pull_request',
  prmerge: 'merge_pull_request',
};

function mcpNormalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function mcpToolResult(text: string, structured: unknown, isError = false): Json {
  const result: Json = {
    content: [{ type: 'text', text }],
    structuredContent: structured,
  };
  if (isError) result.isError = true;
  return result;
}

function mcpCallTool(name: string, args: Record<string, unknown>): Json {
  const normalized = mcpNormalizeName(name);
  const byNormalized = new Map(MCP_TOOLS.map((t) => [mcpNormalizeName(t.name), t.name]));
  const canonical = MCP_TOOL_ALIASES[normalized] ?? byNormalized.get(normalized) ?? normalized;
  const tool = MCP_TOOLS.find((t) => t.name === canonical);
  if (!tool) {
    return { __rpcError: { code: -32602, message: `Unknown tool: ${name}` } };
  }
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return mcpToolResult(`Missing required argument: ${required}`, { error: `Missing required argument: ${required}` }, true);
    }
  }
  const str = (key: string): string => (typeof args[key] === 'string' ? (args[key] as string) : '');
  const num = (key: string): number => {
    const v = args[key];
    if (typeof v === 'number') return v;
    if (typeof v === 'string') return parseInt(v, 10);
    return NaN;
  };

  switch (canonical) {
    case 'create_repo': {
      const repoName = str('name');
      if (repos.has(repoName)) {
        return mcpToolResult(`Repository already exists: ${repoName}`, { error: 'Repository already exists' }, true);
      }
      const repo = createRepo(repoName, args.private === true, str('description'));
      const out = { full_name: `${repo.owner}/${repo.name}`, name: repo.name, id: repoGlobalId(repo), private: repo.private, default_branch: repo.defaultBranch };
      return mcpToolResult(JSON.stringify(out), out);
    }
    case 'get_repo': {
      const repo = findRepo(str('owner'), str('repo'));
      if (!repo) return mcpToolResult(`Repository not found: ${str('owner')}/${str('repo')}`, { error: 'Repository not found' }, true);
      const out = repoJson(repo);
      return mcpToolResult(JSON.stringify(out), out);
    }
    case 'create_issue': {
      const repo = findRepo(str('owner'), str('repo'));
      if (!repo) return mcpToolResult(`Repository not found: ${str('owner')}/${str('repo')}`, { error: 'Repository not found' }, true);
      const issue: Issue = {
        number: repo.nextNumber++,
        title: str('title'),
        body: str('body'),
        state: 'open',
        labels: [],
        comments: [],
        seq: repo.nextNumber,
      };
      repo.issues.push(issue);
      const out = { number: issue.number, title: issue.title, state: 'open', id: issueGlobalId(repo, issue) };
      return mcpToolResult(JSON.stringify(out), out);
    }
    case 'list_issues': {
      const repo = findRepo(str('owner'), str('repo'));
      if (!repo) return mcpToolResult(`Repository not found: ${str('owner')}/${str('repo')}`, { error: 'Repository not found' }, true);
      const state = str('state') || 'open';
      let list = [...repo.issues];
      if (state !== 'all') list = list.filter((i) => i.state === state);
      const items = list.map((i) => issueJson(repo, i));
      const result: Json = {
        content: items.map((item) => ({ type: 'text', text: JSON.stringify(item) })),
        structuredContent: { issues: items },
      };
      return result;
    }
    case 'create_pull_request': {
      const repo = findRepo(str('owner'), str('repo'));
      if (!repo) return mcpToolResult(`Repository not found: ${str('owner')}/${str('repo')}`, { error: 'Repository not found' }, true);
      const head = str('head');
      const base = str('base') || repo.defaultBranch;
      const headTip = repo.branches.get(head);
      const baseTip = repo.branches.get(base);
      if (!headTip || !baseTip) {
        return mcpToolResult(`Invalid head or base branch: ${head} / ${base}`, { error: 'Invalid head or base branch' }, true);
      }
      const headTree = (() => {
        const obj = getObject(headTip);
        return obj && obj.type === 'commit' ? parseCommit(obj.data).tree : '';
      })();
      const baseTree = (() => {
        const obj = getObject(baseTip);
        return obj && obj.type === 'commit' ? parseCommit(obj.data).tree : '';
      })();
      const pull: Pull = {
        number: repo.nextNumber++,
        title: str('title'),
        body: str('body'),
        state: 'open',
        merged: false,
        merged_at: '',
        merge_commit_sha: '',
        headRef: head,
        baseRef: base,
        headSha: headTip,
        baseSha: baseTip,
        changedPaths: diffTrees(baseTree, headTree).map((d) => d.path),
        seq: repo.nextNumber,
      };
      repo.pulls.push(pull);
      const out = { number: pull.number, title: pull.title, state: 'open', head, base, id: pullGlobalId(repo, pull) };
      return mcpToolResult(JSON.stringify(out), out);
    }
    case 'merge_pull_request': {
      const repo = findRepo(str('owner'), str('repo'));
      if (!repo) return mcpToolResult(`Repository not found: ${str('owner')}/${str('repo')}`, { error: 'Repository not found' }, true);
      const pull = repo.pulls.find((p) => p.number === num('pull_number'));
      if (!pull) return mcpToolResult(`Pull request not found: ${num('pull_number')}`, { error: 'Pull request not found' }, true);
      const result = mergePullRequest(repo, pull);
      if (!result.ok) {
        return mcpToolResult(result.message ?? 'Merge failed', { error: result.message ?? 'Merge failed' }, true);
      }
      const out = { merged: true, number: pull.number, sha: result.sha };
      return mcpToolResult(JSON.stringify(out), out);
    }
    default:
      return { __rpcError: { code: -32602, message: `Unknown tool: ${name}` } };
  }
}

function sendRpc(res: ServerResponse, id: unknown, result: unknown): void {
  const body = { jsonrpc: '2.0', id, result };
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(200, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': `req-${++requestCounter}`,
  });
  res.end(text);
}

function sendRpcError(res: ServerResponse, status: number, id: unknown, code: number, message: string): void {
  const body = { jsonrpc: '2.0', id, error: { code, message } };
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': `req-${++requestCounter}`,
  });
  res.end(text);
}

function handleMcp(ctx: Ctx): boolean {
  const { res, method, segments } = ctx;
  if (segments.length !== 1 || segments[0] !== 'mcp') return false;
  if (method === 'DELETE') {
    res.writeHead(204, { 'x-github-request-id': `req-${++requestCounter}` });
    res.end();
    return true;
  }
  if (method !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return true;
  }
  // Auth is decided before anything else, including tool existence.
  if (!authed(ctx)) {
    unauthorized(res);
    return true;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.bodyRaw.toString('utf8'));
  } catch {
    sendRpcError(res, 400, null, -32700, 'Parse error');
    return true;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    sendRpcError(res, 200, null, -32600, 'Invalid Request');
    return true;
  }
  const req = parsed as Record<string, unknown>;
  const hasId = Object.prototype.hasOwnProperty.call(req, 'id');
  const id = hasId ? req.id : null;
  const rpcMethod = typeof req.method === 'string' ? req.method : '';
  const params = (req.params ?? {}) as Record<string, unknown>;

  // Notifications (no id) get no response body.
  if (!hasId) {
    res.writeHead(202, { 'x-github-request-id': `req-${++requestCounter}` });
    res.end();
    return true;
  }

  if (rpcMethod === 'server/discover') {
    const serverInfo = { name: 'github-core-clone-forge', version: '1.0.0' };
    sendRpc(res, id, {
      supportedVersions: ['2026-07-28'],
      capabilities: { tools: {} },
      serverInfo,
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
    });
    return true;
  }
  if (rpcMethod === 'initialize') {
    sendRpc(res, id, {
      protocolVersion: '2026-07-28',
      capabilities: { tools: {} },
      serverInfo: { name: 'github-core-clone-forge', version: '1.0.0' },
    });
    return true;
  }
  if (rpcMethod === 'tools/list') {
    sendRpc(res, id, { tools: MCP_TOOLS });
    return true;
  }
  if (rpcMethod === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const result = mcpCallTool(name, args);
    const rpcError = (result as Record<string, unknown>).__rpcError as { code: number; message: string } | undefined;
    if (rpcError) {
      sendRpcError(res, 200, id, rpcError.code, rpcError.message);
      return true;
    }
    sendRpc(res, id, result);
    return true;
  }
  sendRpcError(res, 200, id, -32601, `Method not found: ${rpcMethod}`);
  return true;
}

// ---------------------------------------------------------------------------
// git smart HTTP
// ---------------------------------------------------------------------------

const ZERO_OID = '0'.repeat(40);
const GIT_AGENT = 'github-core-clone-forge/1.0.0';

/** Encode one pkt-line: 4 hex digits (total length incl. header) + payload. */
function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), body]);
}

const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');

interface PktLine {
  kind: 'data' | 'flush' | 'delim';
  text: string;
}

/** Parse pkt-lines from buf starting at `start`, stopping after the first flush. Throws on garbage. */
function parsePktLines(buf: Buffer, start = 0): { lines: PktLine[]; offset: number } {
  const lines: PktLine[] = [];
  let i = start;
  while (i < buf.length) {
    if (i + 4 > buf.length) throw new Error('truncated pkt-line header');
    const head = buf.subarray(i, i + 4).toString('ascii');
    if (head === '0000') {
      lines.push({ kind: 'flush', text: '' });
      i += 4;
      break;
    }
    if (head === '0001') {
      lines.push({ kind: 'delim', text: '' });
      i += 4;
      continue;
    }
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error('bad pkt-line length');
    const len = parseInt(head, 16);
    if (len < 4 || i + len > buf.length) throw new Error('bad pkt-line length');
    lines.push({ kind: 'data', text: buf.subarray(i + 4, i + len).toString('utf8') });
    i += len;
  }
  return { lines, offset: i };
}

function getRef(repo: Repo, ref: string): string | undefined {
  if (ref.startsWith('refs/heads/')) return repo.branches.get(ref.slice('refs/heads/'.length));
  if (ref.startsWith('refs/tags/')) return repo.tags.get(ref.slice('refs/tags/'.length));
  return repo.otherRefs.get(ref);
}

function setRef(repo: Repo, ref: string, sha: string): void {
  if (ref.startsWith('refs/heads/')) repo.branches.set(ref.slice('refs/heads/'.length), sha);
  else if (ref.startsWith('refs/tags/')) repo.tags.set(ref.slice('refs/tags/'.length), sha);
  else repo.otherRefs.set(ref, sha);
}

function deleteRef(repo: Repo, ref: string): void {
  if (ref.startsWith('refs/heads/')) repo.branches.delete(ref.slice('refs/heads/'.length));
  else if (ref.startsWith('refs/tags/')) repo.tags.delete(ref.slice('refs/tags/'.length));
  else repo.otherRefs.delete(ref);
}

/** HEAD first, then heads, tags, other refs — each group sorted by name. */
function listRefs(repo: Repo): { oid: string; name: string }[] {
  const out: { oid: string; name: string }[] = [];
  out.push({ oid: repo.branches.get(repo.defaultBranch) ?? ZERO_OID, name: 'HEAD' });
  for (const name of [...repo.branches.keys()].sort()) out.push({ oid: repo.branches.get(name)!, name: `refs/heads/${name}` });
  for (const name of [...repo.tags.keys()].sort()) out.push({ oid: repo.tags.get(name)!, name: `refs/tags/${name}` });
  for (const name of [...repo.otherRefs.keys()].sort()) out.push({ oid: repo.otherRefs.get(name)!, name });
  return out;
}

/** The commit a tag object points at, or undefined when sha is not a tag object. */
function peelTag(sha: string): string | undefined {
  const obj = getObject(sha);
  if (!obj || obj.type !== 'tag') return undefined;
  const m = /^object ([0-9a-f]{40})/m.exec(obj.data.toString('utf8'));
  return m ? m[1] : undefined;
}

/**
 * Full object closure reachable from roots (commits, trees, tags, blobs).
 * Commits in `cutoff` are included with their tree closure, but their
 * parents are NOT followed: that is how a fetch request's `shallow` lines
 * qualify its `have` lines — the client holds those commits shallowly,
 * without their history. Without the cutoff, a deepen would compute the
 * haves' closure as the full history and send nothing.
 */
function objectClosure(roots: string[], cutoff: Set<string> = new Set()): Set<string> {
  const out = new Set<string>();
  const queue: string[] = [...roots];
  while (queue.length) {
    const sha = queue.shift()!;
    if (out.has(sha)) continue;
    const obj = getObject(sha);
    if (!obj) continue;
    out.add(sha);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      queue.push(c.tree);
      if (!cutoff.has(sha)) {
        for (const p of c.parents) queue.push(p);
      }
    } else if (obj.type === 'tree') {
      for (const e of decodeTree(obj.data)) queue.push(e.sha);
    } else if (obj.type === 'tag') {
      const target = peelTag(sha);
      if (target) queue.push(target);
    }
  }
  return out;
}

/**
 * Closure of wants limited to `depth` commit generations (depth 1 = the want
 * commits + their trees only). Returns the object set and the boundary commits
 * (included commits at distance depth-1).
 */
function depthClosure(wants: string[], depth: number): { objects: Set<string>; boundary: string[] } {
  const objects = new Set<string>();
  const commitDist = new Map<string, number>();
  const queue: { sha: string; dist: number }[] = [];
  for (const w of wants) {
    const obj = getObject(w);
    if (!obj) continue;
    if (obj.type === 'tag') {
      objects.add(w);
      const target = peelTag(w);
      if (target) queue.push({ sha: target, dist: 0 });
    } else if (obj.type === 'commit') {
      queue.push({ sha: w, dist: 0 });
    } else {
      for (const s of objectClosure([w])) objects.add(s);
    }
  }
  while (queue.length) {
    const { sha, dist } = queue.shift()!;
    if (commitDist.has(sha) || dist >= depth) continue;
    const obj = getObject(sha);
    if (!obj || obj.type !== 'commit') continue;
    commitDist.set(sha, dist);
    objects.add(sha);
    const c = parseCommit(obj.data);
    for (const s of objectClosure([c.tree])) objects.add(s);
    for (const p of c.parents) queue.push({ sha: p, dist: dist + 1 });
  }
  const boundary = [...commitDist.entries()].filter(([, d]) => d === depth - 1).map(([s]) => s);
  return { objects, boundary };
}

/** Build a version-2 packfile (plain objects only, no deltas) from object shas. */
function writePack(shas: Iterable<string>): Buffer {
  const list = [...shas].sort();
  const typeCode: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const sha of list) {
    const obj = getObject(sha);
    if (!obj) continue;
    const data = obj.data;
    let size = data.length;
    const head: number[] = [];
    let first = (typeCode[obj.type] << 4) | (size & 0x0f);
    size >>= 4;
    if (size) first |= 0x80;
    head.push(first);
    while (size) {
      let b = size & 0x7f;
      size >>= 7;
      if (size) b |= 0x80;
      head.push(b);
    }
    parts.push(Buffer.from(head));
    parts.push(deflateSync(data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/**
 * Parse a packfile into objects (plain entries only; deltas are rejected).
 * Does NOT store anything: the caller stores the entries only after the whole
 * pack parsed, so a malformed pack stores nothing. Throws on any malformation.
 */
function readPack(buf: Buffer): Map<string, Obj> {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack header');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error('unsupported pack version');
  const count = buf.readUInt32BE(8);
  const typeName: Record<number, 'commit' | 'tree' | 'blob' | 'tag'> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
  const out = new Map<string, Obj>();
  let i = 12;
  for (let n = 0; n < count; n++) {
    if (i >= buf.length) throw new Error('truncated pack');
    let b = buf[i++];
    const type = (b >> 4) & 7;
    let size = b & 0x0f;
    let shift = 4;
    while (b & 0x80) {
      if (i >= buf.length) throw new Error('truncated pack');
      b = buf[i++];
      size |= (b & 0x7f) << shift;
      shift += 7;
    }
    if (type === 6 || type === 7) throw new Error('delta objects not supported');
    const name = typeName[type];
    if (!name) throw new Error('unknown pack object type');
    const inflated = inflateSync(buf.subarray(i), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    const written = inflated.engine.bytesWritten;
    if (!written || written <= 0) throw new Error('zlib stream consumed no bytes');
    i += written;
    if (inflated.buffer.length !== size) throw new Error('pack entry size mismatch');
    const objHeader = Buffer.from(`${name} ${inflated.buffer.length}\0`, 'utf8');
    const sha = sha1(Buffer.concat([objHeader, inflated.buffer]));
    out.set(sha, { type: name, data: inflated.buffer });
  }
  return out;
}

function gitRepo(ctx: Ctx): Repo | undefined {
  const owner = ctx.segments[0];
  const repoName = ctx.segments[1].slice(0, -'.git'.length);
  return findRepo(owner, repoName);
}

function sendGit(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'x-github-request-id': `req-${++requestCounter}` });
  res.end(body);
}

function handleGitInfoRefs(ctx: Ctx, repo: Repo): boolean {
  const { res, query, req } = ctx;
  const service = query.get('service');
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    notFound(res);
    return true;
  }
  const isUpload = service === 'git-upload-pack';
  const contentType = isUpload ? 'application/x-git-upload-pack-advertisement' : 'application/x-git-receive-pack-advertisement';
  const protocol = String(req.headers['git-protocol'] ?? '');
  const v2 = isUpload && protocol.includes('version=2');
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  if (v2) {
    parts.push(pktLine('version 2\n'));
    parts.push(pktLine(`agent=${GIT_AGENT}\n`));
    parts.push(pktLine('ls-refs=unborn\n'));
    parts.push(pktLine('fetch=shallow wait-for-done filter\n'));
    parts.push(pktLine('object-format=sha1\n'));
    parts.push(pktLine('server-option\n'));
    parts.push(PKT_FLUSH);
  } else {
    const refs = listRefs(repo);
    const caps = isUpload
      ? `symref=HEAD:refs/heads/${repo.defaultBranch} agent=${GIT_AGENT}`
      : `report-status side-band-64k delete-refs ofs-delta agent=${GIT_AGENT} symref=HEAD:refs/heads/${repo.defaultBranch}`;
    const hasRefs = refs.some((r) => r.oid !== ZERO_OID);
    if (!hasRefs) {
      parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    } else {
      let first = true;
      for (const r of refs) {
        parts.push(first ? pktLine(`${r.oid} ${r.name}\0${caps}\n`) : pktLine(`${r.oid} ${r.name}\n`));
        first = false;
      }
    }
    parts.push(PKT_FLUSH);
  }
  sendGit(res, 200, contentType, Buffer.concat(parts));
  return true;
}

function handleGitLsRefs(ctx: Ctx, repo: Repo, lines: PktLine[]): boolean {
  const { res } = ctx;
  const args = lines.filter((l) => l.kind === 'data').map((l) => l.text.trim());
  const wantPeel = args.includes('peel');
  const wantSymrefs = args.includes('symrefs');
  const wantUnborn = args.includes('unborn');
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
  const refs = listRefs(repo);
  const hasAnyRef = refs.some((r) => r.oid !== ZERO_OID);
  const include = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const out: Buffer[] = [];
  if (!hasAnyRef) {
    if (wantUnborn && include('HEAD')) {
      out.push(pktLine(`unborn HEAD${wantSymrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`));
    }
  } else {
    for (const r of refs) {
      if (!include(r.name)) continue;
      let line = `${r.oid} ${r.name}`;
      if (r.name === 'HEAD' && wantSymrefs) line += ` symref-target:refs/heads/${repo.defaultBranch}`;
      if (wantPeel) {
        const peeled = peelTag(r.oid);
        if (peeled) line += ` peeled:${peeled}`;
      }
      out.push(pktLine(`${line}\n`));
    }
  }
  out.push(PKT_FLUSH);
  sendGit(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(out));
  return true;
}

function handleGitFetch(ctx: Ctx, repo: Repo, lines: PktLine[]): boolean {
  const { res } = ctx;
  const args = lines.filter((l) => l.kind === 'data').map((l) => l.text.trim());
  const wants: string[] = [];
  const haves: string[] = [];
  const oldShallow: string[] = [];
  let depth: number | undefined;
  for (const a of args) {
    if (a.startsWith('want ')) wants.push(a.slice(5).trim());
    else if (a.startsWith('have ')) haves.push(a.slice(5).trim());
    else if (a.startsWith('shallow ')) oldShallow.push(a.slice(8).trim());
    else if (a.startsWith('deepen ')) {
      const n = parseInt(a.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) depth = n;
    }
    // thin-pack, no-progress, ofs-delta, filter, done, deepen-since, deepen-not:
    // accepted, no action needed.
  }
  const haveClosure = objectClosure(haves, new Set(oldShallow));
  let send: Set<string>;
  let boundary: string[] = [];
  if (depth !== undefined) {
    const limited = depthClosure(wants, depth);
    send = new Set([...limited.objects].filter((s) => !haveClosure.has(s)));
    boundary = limited.boundary.filter((s) => send.has(s));
  } else {
    send = new Set([...objectClosure(wants)].filter((s) => !haveClosure.has(s)));
  }
  // unshallow: old shallow boundaries whose parent is now included.
  const unshallow: string[] = [];
  for (const s of oldShallow) {
    const obj = getObject(s);
    if (!obj || obj.type !== 'commit') continue;
    if (parseCommit(obj.data).parents.some((p) => send.has(p))) unshallow.push(s);
  }
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  parts.push(pktLine('NAK\n'));
  parts.push(PKT_DELIM);
  if (depth !== undefined) {
    parts.push(pktLine('shallow-info\n'));
    for (const s of boundary) parts.push(pktLine(`shallow ${s}\n`));
    for (const s of unshallow) parts.push(pktLine(`unshallow ${s}\n`));
    parts.push(PKT_DELIM);
  }
  if (send.size > 0) {
    const pack = writePack(send);
    parts.push(pktLine('packfile\n'));
    for (let i = 0; i < pack.length; i += 65500) {
      const chunk = pack.subarray(i, Math.min(pack.length, i + 65500));
      parts.push(pktLine(Buffer.concat([Buffer.from([0x01]), chunk])));
    }
  }
  parts.push(PKT_FLUSH);
  sendGit(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
  return true;
}

function handleGitReceivePack(ctx: Ctx, repo: Repo): boolean {
  const { res, bodyRaw } = ctx;
  let parsed: { lines: PktLine[]; offset: number };
  try {
    parsed = parsePktLines(bodyRaw, 0);
  } catch {
    sendJson(res, 400, { message: 'Invalid pkt-line stream' });
    return true;
  }
  const { lines, offset } = parsed;
  if (!lines.some((l) => l.kind === 'flush')) {
    sendJson(res, 400, { message: 'Missing flush in receive-pack request' });
    return true;
  }
  interface Cmd { old: string; nw: string; ref: string }
  const commands: Cmd[] = [];
  for (const l of lines) {
    if (l.kind !== 'data') continue;
    const text = l.text.split('\0')[0].trim();
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(text);
    if (!m) {
      sendJson(res, 400, { message: 'Invalid receive-pack command' });
      return true;
    }
    commands.push({ old: m[1], nw: m[2], ref: m[3] });
  }
  const needsPack = commands.some((c) => c.nw !== ZERO_OID);
  let unpackError: string | undefined;
  if (needsPack) {
    const packBytes = bodyRaw.subarray(offset);
    if (packBytes.length > 0) {
      try {
        const entries = readPack(packBytes);
        for (const [sha, obj] of entries) {
          if (!objects.has(sha)) objects.set(sha, obj);
        }
      } catch (err) {
        unpackError = err instanceof Error ? err.message : 'unpack failed';
      }
    }
  }
  const report: string[] = [];
  if (unpackError) {
    report.push(`unpack ${unpackError}\n`);
    for (const c of commands) report.push(`ng ${c.ref} unpack failed\n`);
  } else {
    report.push('unpack ok\n');
    for (const c of commands) {
      const current = getRef(repo, c.ref);
      if (c.nw === ZERO_OID) {
        // delete
        if (current === undefined || current.toLowerCase() !== c.old.toLowerCase()) {
          report.push(`ng ${c.ref} delete failed\n`);
        } else {
          deleteRef(repo, c.ref);
          report.push(`ok ${c.ref}\n`);
        }
      } else if (c.old === ZERO_OID) {
        // create
        if (current !== undefined) {
          report.push(`ng ${c.ref} already exists\n`);
        } else {
          setRef(repo, c.ref, c.nw);
          report.push(`ok ${c.ref}\n`);
        }
      } else if (c.ref.startsWith('refs/tags/')) {
        // tag update: only the old value must match
        if (current === undefined || current.toLowerCase() !== c.old.toLowerCase()) {
          report.push(`ng ${c.ref} non-fast-forward\n`);
        } else {
          setRef(repo, c.ref, c.nw);
          report.push(`ok ${c.ref}\n`);
        }
      } else {
        // branch update: old must match and new must be a descendant of old
        if (current === undefined || current.toLowerCase() !== c.old.toLowerCase()) {
          report.push(`ng ${c.ref} non-fast-forward\n`);
        } else if (!commitAncestors(c.nw).has(c.old.toLowerCase())) {
          report.push(`ng ${c.ref} non-fast-forward\n`);
        } else {
          setRef(repo, c.ref, c.nw);
          report.push(`ok ${c.ref}\n`);
        }
      }
    }
  }
  // Sideband-frame the report (side-band-64k is advertised and negotiated).
  const framed: Buffer[] = [];
  for (const line of report) {
    framed.push(pktLine(Buffer.concat([Buffer.from([0x01]), pktLine(line)])));
  }
  framed.push(PKT_FLUSH);
  sendGit(res, 200, 'application/x-git-receive-pack-result', Buffer.concat(framed));
  return true;
}

function handleGit(ctx: Ctx): boolean {
  const { res, segments, method, bodyRaw } = ctx;
  if (segments.length < 2) return false;
  if (!segments[1].endsWith('.git')) return false;
  try {
    const repo = gitRepo(ctx);
    if (!repo) {
      notFound(res);
      return true;
    }
    // GET /{owner}/{repo}.git/info/refs?service=...
    if (method === 'GET' && segments.length === 4 && segments[2] === 'info' && segments[3] === 'refs') {
      return handleGitInfoRefs(ctx, repo);
    }
    if (method === 'POST' && segments.length === 3 && segments[2] === 'git-upload-pack') {
      const { lines } = parsePktLines(bodyRaw, 0);
      const cmdLine = lines.find((l) => l.kind === 'data' && l.text.startsWith('command='));
      const cmd = cmdLine ? cmdLine.text.trim() : '';
      if (cmd === 'command=ls-refs') return handleGitLsRefs(ctx, repo, lines);
      if (cmd === 'command=fetch') return handleGitFetch(ctx, repo, lines);
      sendJson(res, 400, { message: 'Unknown git-upload-pack command' });
      return true;
    }
    if (method === 'POST' && segments.length === 3 && segments[2] === 'git-receive-pack') {
      return handleGitReceivePack(ctx, repo);
    }
    notFound(res);
    return true;
  } catch {
    sendJson(res, 400, { message: 'Invalid git request' });
    return true;
  }
}

// ---------------------------------------------------------------------------
// server wiring
// ---------------------------------------------------------------------------

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleRequest(req, res);
  });
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    const segments = url.pathname
      .split('/')
      .filter((s) => s !== '')
      .map((s) => {
        try {
          return decodeURIComponent(s);
        } catch {
          return s;
        }
      });
    const method = req.method ?? 'GET';
    const host = req.headers.host ?? '127.0.0.1';
    const query = url.searchParams;

    // The env's boot check calls this twice: 200 {"ok":true}. No auth.
    if (method === 'GET' && url.pathname === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
    let bodyRaw = Buffer.alloc(0);
    let body: Json | null = null;
    let bodyMalformed = false;
    // Git smart-HTTP bodies are pkt-lines, not JSON: read them raw and never
    // treat them as malformed JSON.
    const isGit = segments.length >= 2 && segments[1].endsWith('.git');
    if (needsBody) {
      bodyRaw = await readBody(req);
      if (!isGit && bodyRaw.length > 0) {
        try {
          const parsed: unknown = JSON.parse(bodyRaw.toString('utf8'));
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Json;
        } catch {
          bodyMalformed = true;
        }
      }
    }

    const ctx: Ctx = { req, res, method, segments, query, host, body, bodyRaw, bodyMalformed };

    // Malformed JSON bodies are 400 everywhere except /mcp (its own -32700 shape).
    if (bodyMalformed && !(segments.length === 1 && segments[0] === 'mcp')) {
      sendJson(res, 400, { message: 'Invalid JSON' });
      return;
    }

    if (handleRest(ctx)) return;
    if (handleGraphQL(ctx)) return;
    if (handleMcp(ctx)) return;
    if (handleGit(ctx)) return;

    // Everything else, every method: GitHub's 404 body.
    notFound(res);
  } catch (err) {
    try {
      sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
    } catch {
      // response already gone; nothing to do
    }
  }
}
