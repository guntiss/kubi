#!/usr/bin/env node
// Drafts the next CHANGELOG.md entry from the commits since the last version
// tag. It only ever writes the file: bumping, tagging and pushing stay manual,
// so there is always a chance to edit the prose before it becomes a release.
//
//   node scripts/changelog.js            # preview the entry on stdout
//   node scripts/changelog.js --write    # insert it into CHANGELOG.md
//   node scripts/changelog.js --write --release patch
//
// Without --release the entry is headed "Unreleased". With one, the heading
// carries the version that bump would produce, so the file is ready for the
// `npm version` that follows.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CHANGELOG = path.join(ROOT, 'CHANGELOG.md');

const git = (...args) =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();

// Keep a Changelog's sections, in the order the spec lists them. Anything the
// classifier cannot place lands in Changed, which is the least wrong default:
// it claims the commit altered behavior without claiming it added or fixed.
const SECTIONS = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security'];
const FALLBACK = 'Changed';

// Commits here are written as prose ("Fix: namespace filter...", "Replace
// retired Shields badges..."), not Conventional Commits, so classification
// keys off the leading verb as well as the conventional prefixes. First match
// wins, so the more specific patterns come first.
const RULES = [
  [/^(?:sec(?:urity)?|vuln)\b/i, 'Security'],
  [/^(?:feat|feature|add|introduce|implement|support)\b/i, 'Added'],
  [/^(?:fix|bugfix|repair|correct|resolve)\b/i, 'Fixed'],
  [/^(?:remove|delete|drop|exclude)\b/i, 'Removed'],
  [/^(?:deprecate)\b/i, 'Deprecated'],
  [/^(?:change|update|replace|rename|refactor|improve|bump|tweak|adjust|move|simplify)\b/i, 'Changed'],
];

// Housekeeping that a reader of the changelog gains nothing from. Release
// commits matter most: npm version's own commit would otherwise show up as an
// entry in the very release it creates.
const SKIP = [
  /^\d+\.\d+\.\d+$/,                    // npm version's default commit subject
  /^v\d+\.\d+\.\d+$/,
  /^release\b/i,
  /^changelog\b/i,
  /^merge\b/i,
  /^wip\b/i,
  /^(?:chore|ci|build|docs|style|test)(?:\([^)]*\))?[:!]/i,
];

function parseArgs(argv) {
  const opts = { write: false, release: null, from: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--write' || arg === '-w') opts.write = true;
    else if (arg === '--release') {
      const level = argv[++i];
      if (!['patch', 'minor', 'major'].includes(level)) {
        fail(`--release expects patch, minor or major (got ${level ?? 'nothing'})`);
      }
      opts.release = level;
    } else if (arg === '--from') opts.from = argv[++i];
    else if (arg === '--help' || arg === '-h') {
      // Only the header block, which stops at the first non-comment line.
      const lines = fs.readFileSync(__filename, 'utf8').split('\n').slice(1);
      const end = lines.findIndex((l) => !l.startsWith('//'));
      console.log(lines.slice(0, end === -1 ? lines.length : end)
        .map((l) => l.replace(/^\/\/ ?/, '')).join('\n').trim());
      process.exit(0);
    } else fail(`unknown argument: ${arg}`);
  }
  return opts;
}

const fail = (msg) => { console.error(`changelog: ${msg}`); process.exit(1); };

// The last v-tag reachable from HEAD. Falls back to the root commit on a repo
// that has never been tagged, so a first run still produces something.
function lastTag() {
  try {
    return git('describe', '--tags', '--abbrev=0', '--match', 'v*');
  } catch {
    return null;
  }
}

function commitsSince(ref) {
  const range = ref ? `${ref}..HEAD` : 'HEAD';
  const out = git('log', range, '--no-merges', '--format=%s');
  return out ? out.split('\n').filter(Boolean) : [];
}

function classify(subject) {
  for (const [pattern, section] of RULES) {
    if (pattern.test(subject)) return section;
  }
  return FALLBACK;
}

// Strips a conventional-commit prefix and any bare leading verb-colon ("Fix:"),
// then restores sentence case and a full stop, so entries read as prose rather
// than as a log dump.
function tidy(subject) {
  let text = subject
    .replace(/^(?:\w+)(?:\([^)]*\))?!?:\s*/, '')
    .trim();
  if (!text) text = subject.trim();
  text = text.charAt(0).toUpperCase() + text.slice(1);
  if (!/[.!?]$/.test(text)) text += '.';
  return text;
}

function nextVersion(level) {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const [major, minor, patch] = pkg.version.split('.').map(Number);
  if ([major, minor, patch].some(Number.isNaN)) fail(`cannot parse version "${pkg.version}"`);
  if (level === 'major') return `${major + 1}.0.0`;
  if (level === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

function render(subjects, heading) {
  const grouped = new Map();
  for (const subject of subjects) {
    const section = classify(subject);
    if (!grouped.has(section)) grouped.set(section, []);
    grouped.get(section).push(`- ${tidy(subject)}`);
  }

  const parts = [`## [${heading}] — ${new Date().toISOString().slice(0, 10)}`];
  for (const section of SECTIONS) {
    if (!grouped.has(section)) continue;
    parts.push('', `### ${section}`, '', ...grouped.get(section));
  }
  return parts.join('\n') + '\n';
}

// The entry goes directly above the topmost "## [" heading, which keeps the
// file's intro paragraph intact and the releases in newest-first order.
function insert(entry) {
  const existing = fs.readFileSync(CHANGELOG, 'utf8');
  const at = existing.indexOf('\n## [');
  if (at === -1) fail('found no "## [" release heading in CHANGELOG.md');
  const head = existing.slice(0, at + 1);
  const tail = existing.slice(at + 1);
  fs.writeFileSync(CHANGELOG, `${head}${entry}\n${tail}`);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const since = opts.from ?? lastTag();
  const subjects = commitsSince(since).filter(
    (s) => !SKIP.some((pattern) => pattern.test(s)),
  );

  if (subjects.length === 0) {
    console.error(`changelog: no changelog-worthy commits since ${since ?? 'the first commit'}`);
    process.exit(1);
  }

  const heading = opts.release ? nextVersion(opts.release) : 'Unreleased';
  const entry = render(subjects, heading);

  if (!opts.write) {
    console.log(entry);
    console.error(`changelog: ${subjects.length} commit(s) since ${since ?? 'the first commit'}; rerun with --write to insert`);
    return;
  }

  insert(entry);
  console.error(`changelog: wrote "${heading}" to CHANGELOG.md — edit it, then commit and bump:`);
  console.error(`  git add CHANGELOG.md && git commit -m "Changelog for ${heading}"`);
  console.error(`  npm version ${opts.release ?? '<patch|minor|major>'} && git push --follow-tags`);
}

main();
