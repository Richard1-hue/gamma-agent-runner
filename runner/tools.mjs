/**
 * Gamma — runner/tools.mjs
 *
 * Safe, sandboxed tools that the agents may call, plus the security primitives
 * (path blacklist, traversal protection, DLP secret scanner, command allowlist)
 * and small git helpers used by the orchestrator.
 *
 * Nothing in here talks to the network.
 */

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

/* -------------------------------------------------------------------------- */
/* Errors & limits                                                            */
/* -------------------------------------------------------------------------- */

export class SecurityError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SecurityError';
  }
}

export const LIMITS = Object.freeze({
  MAX_READ_CHARS: 20_000, // per readFile call returned to the model
  MAX_READ_BYTES: 1_048_576, // never load more than 1 MB of a file
  MAX_WRITE_BYTES: 200 * 1024, // per writeFile call
  MAX_LIST_ENTRIES: 400,
  MAX_SEARCH_MATCHES: 80,
  MAX_COMMAND_OUTPUT: 8_000, // chars kept (tail) from a command
  COMMAND_TIMEOUT_MS: 120_000,
  MAX_SCAN_BYTES: 2_097_152, // DLP scanner reads at most 2 MB per file
});

/* -------------------------------------------------------------------------- */
/* Path rules                                                                 */
/* -------------------------------------------------------------------------- */

const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  '.gamma-workspace',
  'artifacts',
  '.venv',
  'venv',
  '__pycache__',
  '.cache',
  '.next',
  'coverage',
  'dist',
  'target',
]);

const IGNORED_FILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'Gemfile.lock',
  'poetry.lock',
  'Pipfile.lock',
  'uv.lock',
  'composer.lock',
  'Cargo.lock',
  'go.sum',
  '.DS_Store',
  'Thumbs.db',
]);

const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'tif', 'tiff', 'svgz', 'psd', 'sketch',
  'pdf', 'zip', 'gz', 'tgz', 'tar', 'bz2', 'xz', '7z', 'rar', 'jar', 'war', 'class',
  'exe', 'dll', 'so', 'dylib', 'bin', 'o', 'a', 'pyc', 'wasm',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'mp3', 'mp4', 'mov', 'avi', 'wav', 'ogg', 'webm', 'flac',
  'sqlite', 'db', 'parquet',
]);

const BLOCKED_NAME_RULES = [
  [/^\.env/i, '.env* files'],
  [/\.pem$/i, '*.pem files'],
  [/\.key$/i, '*.key files'],
  [/^id_rsa/i, 'id_rsa* files'],
  [/^id_(ed25519|ecdsa|dsa)/i, 'SSH private keys'],
  [/\.(p12|pfx|keystore|jks)$/i, 'key stores'],
  [/^\.(npmrc|netrc|pypirc)$/i, 'credential config files'],
];

const WRITE_PROTECTED_PREFIXES = [
  '.github/',
  'runner/',
  '.gamma-workspace/',
  'artifacts/',
  'node_modules/',
];
const WRITE_PROTECTED_FILES = new Set(['skills/gamma-rules.md']);

const toPosix = (p) => p.split(path.sep).join('/');

function isOutside(relative) {
  return relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative);
}

function isBinaryName(name) {
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  return BINARY_EXTENSIONS.has(ext);
}

/**
 * Hardcoded blacklist. Returns a human-readable reason if the path must never
 * be read or written by an agent, otherwise null.
 * Matches: .env*, *.pem, *.key, id_rsa*, and anything inside .git/
 */
export function isBlockedPath(rel) {
  const norm = toPosix(String(rel)).replace(/^\.\/+/, '');
  const segments = norm.split('/').filter(Boolean);
  for (const seg of segments) {
    if (seg.toLowerCase() === '.git') return '.git/ internals';
    for (const [re, reason] of BLOCKED_NAME_RULES) {
      if (re.test(seg)) return reason;
    }
  }
  return null;
}

/** Paths agents may read but must never modify. */
export function isWriteProtected(rel) {
  const norm = toPosix(String(rel)).replace(/^\.\/+/, '').toLowerCase();
  if (WRITE_PROTECTED_FILES.has(norm)) return true;
  return WRITE_PROTECTED_PREFIXES.some((p) => norm === p.slice(0, -1) || norm.startsWith(p));
}

/**
 * Resolve a repo-relative path safely.
 *  - rejects null bytes, traversal (..), absolute paths outside the repo
 *  - rejects blacklisted paths (before and after symlink resolution)
 */
export async function resolveSafe(root, rel) {
  if (typeof rel !== 'string' || rel.trim() === '') {
    throw new Error('path must be a non-empty string');
  }
  if (rel.includes('\0')) throw new SecurityError('Null byte in path');

  const abs = path.resolve(root, rel);
  const relative = path.relative(root, abs);
  if (isOutside(relative)) throw new SecurityError(`Path escapes the repository: ${rel}`);

  const blocked = isBlockedPath(relative);
  if (blocked) throw new SecurityError(`Blocked path (${blocked}): ${toPosix(relative)}`);

  // Symlink / realpath protection: resolve the deepest existing ancestor.
  let probe = abs;
  while (!existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const realRoot = await fs.realpath(root);
  const realProbe = await fs.realpath(probe);
  const realRel = path.relative(realRoot, realProbe);
  if (isOutside(realRel)) throw new SecurityError(`Path resolves outside the repository: ${rel}`);
  const realBlocked = isBlockedPath(realRel);
  if (realBlocked) throw new SecurityError(`Blocked path (${realBlocked}) via symlink: ${rel}`);

  return { abs, rel: toPosix(relative) };
}

/* -------------------------------------------------------------------------- */
/* DLP / secret scanner                                                       */
/* -------------------------------------------------------------------------- */

const SECRET_PATTERNS = [
  { type: 'Anthropic API key', re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { type: 'OpenAI-style API key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/g },
  { type: 'GitHub token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/g },
  { type: 'GitHub fine-grained token', re: /\bgithub_pat_[A-Za-z0-9_]{50,}/g },
  { type: 'AWS access key ID', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { type: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { type: 'Slack token', re: /\bxox[baprs]-[0-9A-Za-z-]{10,}/g },
  { type: 'Stripe live key', re: /\b[sr]k_live_[0-9A-Za-z]{20,}/g },
  {
    type: 'Private key block',
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g,
  },
  { type: 'JSON Web Token', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
];

const ASSIGNMENT_RE =
  /(?:api[_-]?key|secret|token|passwd|password|private[_-]?key|access[_-]?key|auth[_-]?key)[A-Za-z0-9_-]*["']?\s*[:=]\s*["']([A-Za-z0-9+/=_.-]{24,})["']/gi;

const PLACEHOLDER_RE =
  /example|sample|placeholder|changeme|change-me|your[_-]|xxxx|\*{3,}|<[^>]+>|\$\{|process\.env|secrets\.|dummy|fake|test[_-]?key/i;

const RUNTIME_SECRET_ENV_NAMES = ['ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'GH_TOKEN'];

function shannonEntropy(s) {
  const freq = new Map();
  for (const ch of s) freq.set(ch, (freq.get(ch) || 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;
const redact = (s) => `${s.slice(0, 6)}…[redacted]`;

/**
 * Scan text for secrets. Returns [{ type, line, preview }] — previews are
 * always redacted so findings are safe to print or store.
 */
export function scanForSecrets(text) {
  const findings = [];
  if (typeof text !== 'string' || text.length === 0) return findings;

  for (const { type, re } of SECRET_PATTERNS) {
    for (const m of text.matchAll(re)) {
      findings.push({ type, line: lineOf(text, m.index), preview: redact(m[0]) });
    }
  }

  for (const m of text.matchAll(ASSIGNMENT_RE)) {
    const value = m[1];
    if (PLACEHOLDER_RE.test(m[0]) || PLACEHOLDER_RE.test(value)) continue;
    if (shannonEntropy(value) >= 3.8) {
      findings.push({
        type: 'High-entropy secret assignment',
        line: lineOf(text, m.index),
        preview: redact(value),
      });
    }
  }

  for (const name of RUNTIME_SECRET_ENV_NAMES) {
    const value = process.env[name];
    if (value && value.length >= 8 && text.includes(value)) {
      findings.push({ type: `Runtime secret value (${name})`, line: lineOf(text, text.indexOf(value)), preview: '[redacted]' });
    }
  }

  return findings;
}

/** Scan repo-relative files. Returns [{ file, type, line, preview }]. */
export async function scanFilesForSecrets(root, relPaths) {
  const out = [];
  for (const rel of relPaths) {
    const blocked = isBlockedPath(rel);
    if (blocked) {
      out.push({ file: rel, type: `Sensitive file modified (${blocked})`, line: 0, preview: '[n/a]' });
      continue;
    }
    const abs = path.resolve(root, rel);
    if (isOutside(path.relative(root, abs)) || !existsSync(abs)) continue;
    if (isBinaryName(rel)) continue;
    try {
      const st = await fs.stat(abs);
      if (!st.isFile()) continue;
      const fh = await fs.open(abs, 'r');
      try {
        const buf = Buffer.alloc(Math.min(st.size, LIMITS.MAX_SCAN_BYTES));
        await fh.read(buf, 0, buf.length, 0);
        if (buf.includes(0)) continue; // binary
        for (const f of scanForSecrets(buf.toString('utf8'))) out.push({ file: rel, ...f });
      } finally {
        await fh.close();
      }
    } catch {
      /* unreadable file: ignore */
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Command execution (allowlisted, shell-free, scrubbed environment)          */
/* -------------------------------------------------------------------------- */

const ALLOWED_BINARIES = new Set([
  'npm', 'node', 'pnpm', 'yarn', 'bun', 'deno',
  'python', 'python3', 'pytest', 'behave',
  'go', 'cargo', 'make', 'mvn', 'gradle', 'dotnet',
  'bundle', 'rspec', 'rake', 'ruby', 'php', 'composer',
  'cucumber', 'cucumber-js',
]);
const NPM_LIKE_SUBCOMMANDS = new Set(['test', 't', 'run', 'run-script', 'ci', 'install', 'i', 'ls']);
const FORBIDDEN_COMMAND_CHARS = /[;&|<>`$\n\r]/;
const EVAL_FLAGS = new Set(['-e', '--eval', '-p', '--print', '-c']);

export function tokenizeCommand(command) {
  const args = [];
  let cur = '';
  let quote = null;
  let started = false;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (cur || started) {
        args.push(cur);
        cur = '';
        started = false;
      }
    } else {
      cur += ch;
    }
  }
  if (quote) throw new Error('unbalanced quotes');
  if (cur || started) args.push(cur);
  return args;
}

/** Validate a command against the allowlist. Returns { ok, argv?, reason? }. */
export function validateCommand(command) {
  if (typeof command !== 'string' || command.trim() === '') return { ok: false, reason: 'empty command' };
  if (command.length > 300) return { ok: false, reason: 'command too long' };
  if (FORBIDDEN_COMMAND_CHARS.test(command)) {
    return { ok: false, reason: 'shell metacharacters (; & | < > ` $) are not allowed' };
  }
  let argv;
  try {
    argv = tokenizeCommand(command.trim());
  } catch (err) {
    return { ok: false, reason: err.message };
  }
  const bin = argv[0];
  if (!ALLOWED_BINARIES.has(bin)) return { ok: false, reason: `'${bin}' is not an allowed test/build runner` };
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(bin) && argv[1] && !NPM_LIKE_SUBCOMMANDS.has(argv[1])) {
    return { ok: false, reason: `'${bin} ${argv[1]}' is not allowed (allowed: ${[...NPM_LIKE_SUBCOMMANDS].join(', ')})` };
  }
  if (['node', 'python', 'python3', 'ruby', 'php', 'deno'].includes(bin) && argv.slice(1).some((a) => EVAL_FLAGS.has(a))) {
    return { ok: false, reason: 'inline code evaluation flags are not allowed' };
  }
  for (const a of argv.slice(1)) {
    if (/(^|[\\/])\.\.([\\/]|$)/.test(a) || path.isAbsolute(a)) {
      return { ok: false, reason: 'arguments may not reference parent or absolute paths' };
    }
  }
  return { ok: true, argv };
}

const SAFE_ENV_KEYS = [
  'PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'TZ',
  'JAVA_HOME', 'GOROOT', 'GOPATH', 'CARGO_HOME', 'RUSTUP_HOME', 'DOTNET_ROOT',
  'pythonLocation', 'Python_ROOT_DIR',
];

/** Environment for child processes: no API keys, no GitHub tokens. */
function scrubbedEnv() {
  const env = { CI: 'true', NODE_ENV: 'test' };
  for (const k of SAFE_ENV_KEYS) if (process.env[k]) env[k] = process.env[k];
  return env;
}

const tail = (s, n) => (s.length > n ? '…[earlier output truncated]\n' + s.slice(-n) : s);

/**
 * Run one allowlisted command without a shell.
 * Resolves with { command, exitCode, output, timedOut?, blocked?, notFound? } and never rejects.
 */
export function runCommand(root, command, { timeoutMs = LIMITS.COMMAND_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const verdict = validateCommand(command);
    if (!verdict.ok) {
      resolve({ command, exitCode: null, blocked: true, output: `BLOCKED: ${verdict.reason}` });
      return;
    }
    const [bin, ...args] = verdict.argv;
    let output = '';
    let settled = false;
    let timedOut = false;

    let child;
    try {
      child = spawn(bin, args, { cwd: root, env: scrubbedEnv(), shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ command, exitCode: null, notFound: err.code === 'ENOENT', output: `Failed to start: ${err.message}` });
      return;
    }

    const append = (d) => {
      output += d.toString('utf8');
      if (output.length > 400_000) output = output.slice(-200_000);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({ command, exitCode: null, notFound: err.code === 'ENOENT', output: `Failed to start: ${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({ command, exitCode: code, timedOut, output: tail(output, LIMITS.MAX_COMMAND_OUTPUT) });
    });
  });
}

export function formatCommandResult(r) {
  const status = r.blocked
    ? 'BLOCKED'
    : r.notFound
      ? 'NOT AVAILABLE (command not found)'
      : r.timedOut
        ? 'TIMED OUT'
        : `exit code ${r.exitCode}`;
  return `$ ${r.command}\n[${status}]\n${r.output}`;
}

/* -------------------------------------------------------------------------- */
/* Git helpers                                                                */
/* -------------------------------------------------------------------------- */

/** Paths never included in Gamma's changes/patch. */
export const PATHSPEC_EXCLUDES = [
  ':(exclude).gamma-workspace',
  ':(exclude)artifacts',
  ':(exclude)node_modules',
  ':(exclude,glob)**/node_modules/**',
];

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Files modified/added/deleted in the working tree (excluding Gamma's own dirs). */
export function listChangedFiles(root) {
  const raw = git(root, ['status', '--porcelain', '-z', '--untracked-files=all', '--', '.', ...PATHSPEC_EXCLUDES]);
  const parts = raw.split('\0').filter(Boolean);
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    const status = entry.slice(0, 2).trim() || '?';
    const file = entry.slice(3);
    if (status.startsWith('R') || status.startsWith('C')) i++; // skip the "from" path
    out.push({ status, path: file });
  }
  return out;
}

/** Stage everything Gamma changed (locally only) and return the staged diff. */
export function getStagedDiff(root, { maxChars = 80_000 } = {}) {
  git(root, ['add', '-A', '--', '.', ...PATHSPEC_EXCLUDES]);
  const stat = git(root, ['diff', '--cached', '--stat']).trim();
  const names = git(root, ['diff', '--cached', '--name-status']).split('\n').filter(Boolean);
  let diff = git(root, ['diff', '--cached', '--no-color']);
  const truncated = diff.length > maxChars;
  if (truncated) diff = diff.slice(0, maxChars) + '\n…[diff truncated]';
  return { stat, names, diff, truncated };
}

/* -------------------------------------------------------------------------- */
/* File walking                                                               */
/* -------------------------------------------------------------------------- */

async function* walk(root, startAbs, { maxDepth = 8 } = {}) {
  async function* rec(dirAbs, depth) {
    let entries;
    try {
      entries = await fs.readdir(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const abs = path.join(dirAbs, e.name);
      const rel = toPosix(path.relative(root, abs));
      if (e.isDirectory()) {
        if (IGNORED_DIRS.has(e.name) || isBlockedPath(rel)) continue;
        if (depth < maxDepth) yield* rec(abs, depth + 1);
      } else if (e.isFile()) {
        if (IGNORED_FILES.has(e.name) || isBinaryName(e.name) || isBlockedPath(rel)) continue;
        yield { abs, rel };
      }
    }
  }
  yield* rec(startAbs, 0);
}

/** Compact file tree used to seed the Scout agent. */
export async function buildTree(root, { maxEntries = 300, maxDepth = 5 } = {}) {
  const lines = [];
  let more = false;
  for await (const f of walk(root, root, { maxDepth })) {
    if (lines.length >= maxEntries) {
      more = true;
      break;
    }
    lines.push(f.rel);
  }
  if (more) lines.push(`…[tree truncated at ${maxEntries} entries]`);
  return lines.join('\n') || '(repository is empty)';
}

/* -------------------------------------------------------------------------- */
/* Tool implementations                                                       */
/* -------------------------------------------------------------------------- */

const escapeTag = (s) => s.replace(/<\/untrusted_repo_data/gi, '<\\/untrusted_repo_data');
const escapeAttr = (s) => String(s).replace(/"/g, '&quot;');

async function readTextFile(abs) {
  const st = await fs.stat(abs);
  if (!st.isFile()) throw new Error('Not a regular file');
  const fh = await fs.open(abs, 'r');
  try {
    const buf = Buffer.alloc(Math.min(st.size, LIMITS.MAX_READ_BYTES));
    await fh.read(buf, 0, buf.length, 0);
    if (buf.includes(0)) throw new Error('Binary file — refusing to read');
    return { text: buf.toString('utf8'), partial: st.size > LIMITS.MAX_READ_BYTES, size: st.size };
  } finally {
    await fh.close();
  }
}

function assertWritable(rel) {
  if (isWriteProtected(rel)) {
    throw new SecurityError(`Write-protected path: ${rel} (agents may not modify .github/, runner/, skills/gamma-rules.md, artifacts/ or .gamma-workspace/)`);
  }
}

function assertNoSecrets(text, what) {
  const findings = scanForSecrets(text);
  if (findings.length) {
    throw new SecurityError(
      `DLP block: ${what} looks like it contains a secret (${[...new Set(findings.map((f) => f.type))].join(', ')}). Remove it; use an environment variable or an obvious placeholder instead.`,
    );
  }
}

const handlers = {
  async listFiles(root, input) {
    const dir = typeof input.dir === 'string' && input.dir.trim() ? input.dir : '.';
    const maxDepth = Math.min(Math.max(Number.isInteger(input.maxDepth) ? input.maxDepth : 4, 0), 8);
    const { abs, rel } = dir === '.' ? { abs: root, rel: '' } : await resolveSafe(root, dir);
    const st = await fs.stat(abs).catch(() => null);
    if (!st || !st.isDirectory()) throw new Error(`Not a directory: ${dir}`);
    const lines = [];
    let more = false;
    for await (const f of walk(root, abs, { maxDepth })) {
      if (lines.length >= LIMITS.MAX_LIST_ENTRIES) {
        more = true;
        break;
      }
      lines.push(f.rel);
    }
    if (more) lines.push(`…[truncated at ${LIMITS.MAX_LIST_ENTRIES} entries — list a subdirectory for more]`);
    return `<untrusted_repo_data kind="file-list" dir="${escapeAttr(rel || '.')}">\n${escapeTag(lines.join('\n') || '(no files)')}\n</untrusted_repo_data>`;
  },

  async readFile(root, input) {
    const { abs, rel } = await resolveSafe(root, input.path);
    const { text, partial } = await readTextFile(abs);
    const lines = text.split('\n');
    const total = lines.length;
    const start = Math.max(1, Number.isInteger(input.startLine) ? input.startLine : 1);
    if (start > total) throw new Error(`startLine ${start} is beyond the end of the file (${total} lines)`);
    let end = Number.isInteger(input.endLine) ? Math.min(input.endLine, total) : total;
    if (end < start) end = start;
    let body = lines.slice(start - 1, end).join('\n');
    let truncated = false;
    if (body.length > LIMITS.MAX_READ_CHARS) {
      body = body.slice(0, LIMITS.MAX_READ_CHARS);
      end = start + body.split('\n').length - 1;
      truncated = true;
    }
    const attrs = `path="${escapeAttr(rel)}" lines="${start}-${end} of ${total}"${truncated || partial ? ' truncated="true"' : ''}`;
    const note = truncated
      ? `\n[Output truncated at ${LIMITS.MAX_READ_CHARS} characters. Read the next part with startLine=${end + 1}. Edit this file with replaceInFile, not writeFile.]`
      : partial
        ? '\n[File is larger than 1 MB; only the first 1 MB is available.]'
        : '';
    return `<untrusted_repo_data ${attrs}>\n${escapeTag(body)}\n</untrusted_repo_data>${note}`;
  },

  async writeFile(root, input, ctx) {
    if (typeof input.content !== 'string') throw new Error('content must be a string');
    const { abs, rel } = await resolveSafe(root, input.path);
    assertWritable(rel);
    const bytes = Buffer.byteLength(input.content, 'utf8');
    if (bytes > LIMITS.MAX_WRITE_BYTES) {
      throw new Error(`Content is ${bytes} bytes; the limit per write is ${LIMITS.MAX_WRITE_BYTES}. Split it into several files.`);
    }
    assertNoSecrets(input.content, 'content');
    let existed = false;
    if (existsSync(abs)) {
      const st = await fs.stat(abs);
      if (st.isDirectory()) throw new Error(`${rel} is a directory`);
      existed = true;
      if (st.size > LIMITS.MAX_READ_CHARS) {
        throw new Error(`${rel} is larger than a single readFile can return, so overwriting it could silently drop content. Use replaceInFile to make targeted edits.`);
      }
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, input.content, 'utf8');
    ctx.stats.written.add(rel);
    return `${existed ? 'Overwrote' : 'Created'} ${rel} (${bytes} bytes)`;
  },

  async replaceInFile(root, input, ctx) {
    if (typeof input.old_string !== 'string' || input.old_string === '') throw new Error('old_string must be a non-empty string');
    if (typeof input.new_string !== 'string') throw new Error('new_string must be a string');
    const { abs, rel } = await resolveSafe(root, input.path);
    assertWritable(rel);
    const { text, partial } = await readTextFile(abs);
    if (partial) throw new Error('File is larger than 1 MB; refusing to edit it.');
    const count = text.split(input.old_string).length - 1;
    if (count === 0) throw new Error('old_string was not found. Re-read the file and copy the text exactly.');
    if (count > 1 && input.replace_all !== true) {
      throw new Error(`old_string matches ${count} places. Add more surrounding context, or set replace_all=true.`);
    }
    assertNoSecrets(input.new_string, 'new_string');
    const updated = input.replace_all === true
      ? text.split(input.old_string).join(input.new_string)
      : text.replace(input.old_string, () => input.new_string);
    if (Buffer.byteLength(updated, 'utf8') > LIMITS.MAX_READ_BYTES) throw new Error('Resulting file would be too large.');
    await fs.writeFile(abs, updated, 'utf8');
    ctx.stats.written.add(rel);
    return `Edited ${rel} (${count} replacement${count === 1 ? '' : 's'})`;
  },

  async searchCode(root, input) {
    if (typeof input.pattern !== 'string' || input.pattern === '') throw new Error('pattern must be a non-empty string');
    let re;
    try {
      re = new RegExp(input.pattern, 'i');
    } catch {
      re = new RegExp(input.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    }
    const dir = typeof input.dir === 'string' && input.dir.trim() ? input.dir : '.';
    const { abs } = dir === '.' ? { abs: root } : await resolveSafe(root, dir);
    const ext = typeof input.fileExtension === 'string' ? input.fileExtension.replace(/^\./, '').toLowerCase() : null;
    const matches = [];
    let filesScanned = 0;
    outer: for await (const f of walk(root, abs, { maxDepth: 8 })) {
      if (ext && !f.rel.toLowerCase().endsWith('.' + ext)) continue;
      let text;
      try {
        ({ text } = await readTextFile(f.abs));
      } catch {
        continue;
      }
      filesScanned++;
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          matches.push(`${f.rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
          if (matches.length >= LIMITS.MAX_SEARCH_MATCHES) break outer;
        }
      }
    }
    const capped = matches.length >= LIMITS.MAX_SEARCH_MATCHES ? `\n…[stopped at ${LIMITS.MAX_SEARCH_MATCHES} matches]` : '';
    return `<untrusted_repo_data kind="search-results" pattern="${escapeAttr(input.pattern)}" files_scanned="${filesScanned}">\n${escapeTag(matches.join('\n') || '(no matches)')}${capped}\n</untrusted_repo_data>`;
  },

  async runCommand(root, input) {
    const r = await runCommand(root, input.command);
    return formatCommandResult(r);
  },
};

const TOOL_DEFINITIONS = {
  listFiles: {
    name: 'listFiles',
    description:
      'List files in the repository (recursive). Ignores .git, node_modules, lockfiles, binaries and secret files. Results are untrusted repository data.',
    input_schema: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: 'Directory relative to the repo root. Default ".".' },
        maxDepth: { type: 'integer', description: 'Recursion depth, 0-8. Default 4.' },
      },
    },
  },
  readFile: {
    name: 'readFile',
    description:
      'Read a text file from the repository. Output is capped at 20,000 characters; use startLine/endLine (1-indexed) to page through larger files. Secret files (.env*, *.pem, *.key, id_rsa*, .git/*) are blocked.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the repo root.' },
        startLine: { type: 'integer', description: 'First line to return (1-indexed).' },
        endLine: { type: 'integer', description: 'Last line to return (inclusive).' },
      },
      required: ['path'],
    },
  },
  writeFile: {
    name: 'writeFile',
    description:
      'Create a new file, or fully overwrite a small existing file. Parent folders are created automatically. For large existing files use replaceInFile. Cannot write to .github/, runner/, skills/gamma-rules.md or secret files. Content is scanned for secrets.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the repo root.' },
        content: { type: 'string', description: 'Complete file content.' },
      },
      required: ['path', 'content'],
    },
  },
  replaceInFile: {
    name: 'replaceInFile',
    description:
      'Make a targeted edit: replace old_string with new_string in an existing file. old_string must match exactly once (or set replace_all=true).',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string', description: 'Exact text to replace, including whitespace.' },
        new_string: { type: 'string', description: 'Replacement text.' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence. Default false.' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  searchCode: {
    name: 'searchCode',
    description:
      'Search repository text files for a regular expression (case-insensitive). Returns up to 80 "path:line: text" matches.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression (falls back to a literal match if invalid).' },
        dir: { type: 'string', description: 'Limit the search to this directory. Default ".".' },
        fileExtension: { type: 'string', description: 'Only search files with this extension, e.g. "js".' },
      },
      required: ['pattern'],
    },
  },
  runCommand: {
    name: 'runCommand',
    description:
      'Run ONE allowlisted test/build command (e.g. "npm test", "npm run lint", "pytest -q", "go test ./..."). No shell: pipes, &&, ; and redirects are rejected. 120s timeout. Secrets are not available to the command.',
    input_schema: {
      type: 'object',
      properties: { command: { type: 'string', description: 'The command line to run.' } },
      required: ['command'],
    },
  },
};

/**
 * Create a toolbox exposing only the named tools.
 * @param {{ root: string, allowed: string[] }} opts
 */
export function createToolbox({ root, allowed }) {
  const allowedSet = new Set(allowed);
  for (const name of allowedSet) {
    if (!TOOL_DEFINITIONS[name]) throw new Error(`Unknown tool: ${name}`);
  }
  const stats = { calls: 0, blocked: 0, written: new Set() };
  return {
    stats,
    definitions: allowed.map((n) => TOOL_DEFINITIONS[n]),
    /** Always resolves to { ok, content } — errors are returned to the model, not thrown. */
    async execute(name, input) {
      stats.calls++;
      if (!allowedSet.has(name)) return { ok: false, content: `Tool not available: ${name}` };
      try {
        const content = await handlers[name](root, input && typeof input === 'object' ? input : {}, { stats });
        return { ok: true, content };
      } catch (err) {
        if (err instanceof SecurityError) {
          stats.blocked++;
          return { ok: false, content: `SECURITY BLOCK: ${err.message}` };
        }
        return { ok: false, content: `Error: ${err.message}` };
      }
    },
  };
}
