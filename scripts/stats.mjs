// Download & traffic report for LUTviewer, built from GitHub's own data.
// Usage: npm run stats   (needs the GitHub CLI, signed in: gh auth login)
//
// GitHub only keeps traffic (views, visitors, referrers) for 14 days, so every
// run merges it into .stats/history.json; the longer you use this, the longer
// your history gets.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = '830prod/LUTviewer';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const historyFile = path.join(root, '.stats', 'history.json');

const gh = (endpoint) => JSON.parse(execFileSync('gh', ['api', endpoint], { encoding: 'utf8' }));
const c = { b: (s) => `\x1b[1m${s}\x1b[0m`, dim: (s) => `\x1b[2m${s}\x1b[0m`, blue: (s) => `\x1b[38;5;110m${s}\x1b[0m`, green: (s) => `\x1b[32m${s}\x1b[0m` };
const pad = (s, n) => String(s).padEnd(n);
const num = (n) => String(n).padStart(6);
const bar = (n, max, width = 28) => '█'.repeat(max ? Math.max(n ? 1 : 0, Math.round((n / max) * width)) : 0);

let history = { snapshots: [], views: {}, clones: {} };
try { history = { ...history, ...JSON.parse(fs.readFileSync(historyFile, 'utf8')) }; } catch { /* first run */ }

let releases, views, clones, referrers, paths;
try {
  releases = gh(`repos/${REPO}/releases?per_page=100`);
  views = gh(`repos/${REPO}/traffic/views`);
  clones = gh(`repos/${REPO}/traffic/clones`);
  referrers = gh(`repos/${REPO}/traffic/popular/referrers`);
  paths = gh(`repos/${REPO}/traffic/popular/paths`);
} catch (err) {
  console.error('Could not reach GitHub. Is the GitHub CLI installed and signed in? Try: gh auth login');
  process.exit(1);
}

// ---------- Downloads ----------
const perRelease = releases
  .filter((r) => !r.draft)
  .map((r) => ({
    tag: r.tag_name,
    date: r.published_at.slice(0, 10),
    downloads: r.assets.filter((a) => a.name.endsWith('.dmg')).reduce((s, a) => s + a.download_count, 0),
  }));
const total = perRelease.reduce((s, r) => s + r.downloads, 0);
const prev = history.snapshots.at(-1);
const since = prev ? total - prev.total : 0;

console.log(`\n${c.b('LUTviewer')} ${c.dim('· download report · ' + new Date().toLocaleString())}\n`);
console.log(`${c.b('Total downloads')}  ${c.green(c.b(total))}` + (prev ? c.dim(`   (+${since} since ${new Date(prev.at).toLocaleDateString()})`) : ''));
console.log('');
const maxD = Math.max(...perRelease.map((r) => r.downloads), 1);
for (const r of perRelease) console.log(`  ${pad(r.tag, 9)} ${c.dim(r.date)} ${num(r.downloads)}  ${c.blue(bar(r.downloads, maxD))}`);

// ---------- Traffic (merged into history so it outlives GitHub's 14 days) ----------
for (const v of views.views) history.views[v.timestamp.slice(0, 10)] = { count: v.count, uniques: v.uniques };
for (const v of clones.clones) history.clones[v.timestamp.slice(0, 10)] = { count: v.count, uniques: v.uniques };

console.log(`\n${c.b('GitHub page views')} ${c.dim('(last 14 days)')}  ${views.count} views · ${c.b(views.uniques)} unique visitors`);
const days = Object.keys(history.views).sort().slice(-14).filter((d) => history.views[d].count);
const maxV = Math.max(...days.map((d) => history.views[d].count), 1);
for (const d of days) {
  const v = history.views[d];
  console.log(`  ${c.dim(d)} ${num(v.count)} ${c.dim(`(${v.uniques} unique)`.padEnd(12))} ${c.blue(bar(v.count, maxV, 20))}`);
}

console.log(`\n${c.b('Where visitors came from')} ${c.dim('(last 14 days)')}`);
if (!referrers.length) console.log(c.dim('  No referrers yet'));
for (const r of referrers) console.log(`  ${pad(r.referrer, 28)} ${num(r.count)} ${c.dim(`(${r.uniques} unique)`)}`);

console.log(`\n${c.b('Most viewed pages')} ${c.dim('(last 14 days)')}`);
for (const p of paths.slice(0, 6)) console.log(`  ${pad(p.path.replace(`/${REPO}`, '') || '/', 28)} ${num(p.count)} ${c.dim(`(${p.uniques} unique)`)}`);

const allDays = Object.keys(history.views).sort();
if (allDays.length > 14) {
  const all = allDays.reduce((s, d) => s + history.views[d].count, 0);
  console.log(`\n${c.b('All recorded history')} ${c.dim(`(${allDays[0]} → ${allDays.at(-1)})`)}  ${all} page views`);
}

console.log(c.dim('\nWebsite visitors & Download-button clicks: https://830lutviewer.goatcounter.com'));
console.log(c.dim('Email sign-ups: Mailchimp → Audience → All contacts (https://us7.admin.mailchimp.com/audience/)\n'));

history.snapshots.push({ at: new Date().toISOString(), total, perRelease: Object.fromEntries(perRelease.map((r) => [r.tag, r.downloads])) });
fs.mkdirSync(path.dirname(historyFile), { recursive: true });
fs.writeFileSync(historyFile, JSON.stringify(history, null, 2));
