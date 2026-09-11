import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const generated = new Set(['node_modules', '.pnpm-store', 'dist', 'coverage', '__pycache__']);
const forbiddenDirectories = new Set(['.data', '.tmp', '.backups', '.runtime', '.bu-home', 'uploads', 'secrets', 'backups']);
const extensions = new Set(['.ts', '.vue', '.json', '.yaml', '.yml', '.toml', '.md', '.mjs', '.cjs', '.css', '.html', '.py', '.sh', '.prisma', '.conf']);
const dotfiles = new Set(['.gitignore', '.dockerignore', '.gitattributes', '.gitleaks.toml']);
const extensionlessFiles = new Set(['LICENSE']);
const rules = [
  ['private-key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g],
  ['provider-token', /\b(?:AKIA[A-Z0-9]{16}|AKID[A-Za-z0-9]{28,40}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-[A-Za-z0-9_-]{24,})\b/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\b/g],
  ['private-network-address', /\b(?:10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}\b/g],
  ['personal-windows-path', /[A-Z]:[\\/]Users[\\/][^\s"'<>]+/gi],
  ['identity-number-candidate', /(?<![\w])\d{6}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?![\w])/g],
  ['mobile-number-candidate', /(?<![\w\d])1[3-9]\d{9}(?![\w\d])/g],
];
const failures = [];
const checked = new Set();

function fail(path, rule, line) {
  failures.push({ path, rule, ...(line ? { line } : {}) });
}

function allowed(path) {
  const name = path.split('/').at(-1);
  if (path === 'sc/badge.png' || dotfiles.has(path) || extensionlessFiles.has(path) || name.endsWith('.env.example')) return true;
  if (path.startsWith('apps/api/prisma/migrations/') && name === 'migration.sql') return true;
  if (path.startsWith('infra/Dockerfile.')) return true;
  return extensions.has(name.slice(name.lastIndexOf('.')));
}

function walk(folder) {
  for (const item of readdirSync(folder, { withFileTypes: true })) {
    const full = resolve(folder, item.name);
    const path = relative(root, full).replaceAll('\\', '/');
    if (item.isSymbolicLink() || lstatSync(full).isSymbolicLink()) {
      fail(path, 'symlink');
      continue;
    }
    if (item.isDirectory()) {
      if (item.name === '.git' && folder === root) continue;
      if (generated.has(item.name)) continue;
      if (forbiddenDirectories.has(item.name)) {
        fail(path, 'private-runtime-directory');
        continue;
      }
      walk(full);
      continue;
    }
    if (/\.(?:tsbuildinfo|pyc)$/.test(path)) continue;
    if (!allowed(path) || (/\.env(?:\.|$)/.test(item.name) && !item.name.endsWith('.env.example'))) {
      fail(path, 'unapproved-file-type');
      continue;
    }
    checked.add(path);
    if (path === 'sc/badge.png') continue;
    const bytes = readFileSync(full);
    if (bytes.includes(0)) {
      fail(path, 'unexpected-binary');
      continue;
    }
    const content = bytes.toString('utf8');
    for (const [rule, regex] of rules) {
      for (const match of content.matchAll(regex)) {
        fail(path, rule, content.slice(0, match.index).split('\n').length);
      }
    }
  }
}

walk(root);
let hasOwnGit = false;
try {
  hasOwnGit = resolve(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()) === root;
} catch {}
if (hasOwnGit) {
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root }).toString().split('\0').filter(Boolean);
  for (const path of tracked) {
    if (!checked.has(path)) fail(path, 'tracked-file-excluded-from-release');
  }
}
console.log(JSON.stringify({ checkedFiles: checked.size, ownGitRepository: hasOwnGit, failures }, null, 2));
if (failures.length) process.exitCode = 1;
