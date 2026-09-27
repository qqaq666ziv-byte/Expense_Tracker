// Run with node --test; the filename intentionally stays outside Vitest's defaults.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { captureSource, createPacket, verifyPacket } from './create-review-packet.mjs';

function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'expense-review-packet-'));
  const root = path.join(temp, 'repo');
  fs.mkdirSync(root);
  const git = args => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init']);
  git(['config', 'user.email', 'test@example.invalid']);
  git(['config', 'user.name', 'Review packet test']);
  fs.writeFileSync(path.join(root, 'example.js'), 'export const amount = 1;\n');
  git(['add', 'example.js']);
  git(['commit', '-m', 'baseline']);
  const base = git(['rev-parse', 'HEAD']).trim();
  const options = { root, base, files: ['example.js'], goal: 'Check the bounded example change', out: path.join(temp, 'packet'), phase: 'plan' };
  t.after(() => {
    assert.equal(path.dirname(temp), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(temp).startsWith('expense-review-packet-'));
    fs.rmSync(temp, { recursive: true, force: true });
  });
  return { temp, root, git, options };
}

function check(fixture) {
  const identity = captureSource(fixture.options).identity;
  const outputFile = path.join(fixture.temp, 'check.log');
  fs.writeFileSync(outputFile, '1 test passed\n');
  const metadata = { command: 'node --test example.test.mjs', cwd: fixture.root, exitCode: 0,
    sourceDigestBefore: identity.sourceDigest, sourceDigestAfter: identity.sourceDigest, scopeDigest: identity.scopeDigest,
    startedAt: '2026-09-27T00:00:00.000Z', endedAt: '2026-09-27T00:00:01.000Z', outputFile, truncated: false };
  const metadataPath = path.join(fixture.temp, 'check.json');
  fs.writeFileSync(metadataPath, JSON.stringify(metadata));
  return { metadata, metadataPath };
}

test('captures dirty tracked bytes, baseline and cumulative diff with a verifiable identity', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'example.js'), 'export const amount = 2;\n');
  const { metadataPath } = check(f);
  const result = createPacket({ ...f.options, phase: 'review', checks: [metadataPath] });
  assert.equal(verifyPacket({ root: f.root, directory: result.output }).valid, true);
  const body = fs.readFileSync(path.join(result.output, 'evidence.md'), 'utf8');
  assert.match(body, /-export const amount = 1;/);
  assert.match(body, /\+export const amount = 2;/);
  assert.match(body, /1 test passed/);
  assert.throws(() => createPacket(f.options), /immutable/);
});

test('rejects traversal, Windows separators, absolute paths and protected source', t => {
  const f = fixture(t);
  for (const unsafe of ['../example.js', 'src/../example.js', 'C:/outside.js', '/outside.js', 'src\\example.js', '.env']) {
    assert.throws(() => captureSource({ ...f.options, files: [unsafe] }), /Unsafe|Protected/);
  }
  assert.throws(() => createPacket({ ...f.options, out: path.join(f.root, 'packet') }), /outside/);
  assert.throws(() => createPacket({ ...f.options, out: f.temp }), /cannot contain/);
  const protectedOut = path.join(f.temp, '.codex', 'packet');
  assert.throws(() => createPacket({ ...f.options, out: protectedOut }), /Protected output/);
  assert.equal(fs.existsSync(protectedOut), false);
});

test('requires explicit staging of new files and includes staged additions', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'new.js'), 'export const added = true;\n');
  const options = { ...f.options, files: ['example.js', 'new.js'] };
  assert.throws(() => captureSource(options), /Untracked/);
  f.git(['add', 'new.js']);
  const result = createPacket(options);
  const manifest = JSON.parse(fs.readFileSync(path.join(result.output, 'manifest.json')));
  assert.equal(manifest.files[1].baseline, null);
  assert.ok(manifest.files[1].current.sha256);
});

test('refuses omitted dirty, untracked and committed changes while allowing unchanged unrelated files', t => {
  const f = fixture(t);
  const unrelated = path.join(f.root, 'unrelated.js');
  fs.writeFileSync(unrelated, 'unchanged dependency\n');
  f.git(['add', 'unrelated.js']);
  f.git(['commit', '-m', 'baseline with unrelated file']);
  f.options.base = f.git(['rev-parse', 'HEAD']).trim();
  const packet = createPacket(f.options);
  assert.equal(verifyPacket({ root: f.root, directory: packet.output }).valid, true);
  fs.writeFileSync(unrelated, 'dirty outside declared scope\n');
  assert.throws(() => captureSource(f.options), /allowlist omits changed/);
  assert.throws(() => verifyPacket({ root: f.root, directory: packet.output }), /Stale/);
  f.git(['commit', '-am', 'changed excluded file']);
  assert.throws(() => captureSource(f.options), /allowlist omits changed/);
  const all = captureSource({ ...f.options, files: ['example.js', 'unrelated.js'] });
  assert.equal(all.entries.length, 2);
  fs.writeFileSync(path.join(f.root, 'missing.js'), 'untracked\n');
  assert.throws(() => captureSource({ ...f.options, files: ['example.js', 'unrelated.js'] }), /missing.js/);
});

test('uses literal Git pathspecs for bracket names and never includes a matched protected path', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'choice[1].txt'), 'old literal choice\n');
  fs.writeFileSync(path.join(f.root, '.en[v]'), 'old public source\n');
  fs.writeFileSync(path.join(f.root, '.env'), 'old protected fixture\n');
  f.git(['--literal-pathspecs', 'add', 'choice[1].txt', '.en[v]', '.env']);
  f.git(['commit', '-m', 'literal baseline']);
  const base = f.git(['rev-parse', 'HEAD']).trim();
  fs.writeFileSync(path.join(f.root, 'choice[1].txt'), 'new literal choice\n');
  fs.writeFileSync(path.join(f.root, '.en[v]'), 'new public source\n');
  const withheld = 'UNSELECTED-SYNTHETIC-CONTENT';
  fs.writeFileSync(path.join(f.root, '.env'), withheld);
  const result = createPacket({ ...f.options, base, files: ['example.js', 'choice[1].txt', '.en[v]'] });
  const evidence = fs.readFileSync(path.join(result.output, 'evidence.md'), 'utf8');
  assert.match(evidence, /\+new literal choice/);
  assert.match(evidence, /\+new public source/);
  assert.equal(evidence.includes(withheld), false);
  assert.equal(verifyPacket({ root: f.root, directory: result.output }).valid, true);
});

test('retains deleted baseline source and committed feature differences', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'example.js'), 'export const amount = 3;\n');
  f.git(['commit', '-am', 'feature']);
  const committed = createPacket(f.options);
  assert.match(fs.readFileSync(path.join(committed.output, 'evidence.md'), 'utf8'), /\+export const amount = 3;/);
  f.git(['rm', 'example.js']);
  const deleted = createPacket({ ...f.options, out: path.join(f.temp, 'deleted') });
  const manifest = JSON.parse(fs.readFileSync(path.join(deleted.output, 'manifest.json')));
  assert.equal(manifest.files[0].current, null);
  assert.ok(manifest.files[0].baseline.sha256);
});

test('refuses junction escape and hard-linked source', t => {
  const f = fixture(t);
  const outside = path.join(f.temp, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'file.js'), 'outside\n');
  fs.symlinkSync(outside, path.join(f.root, 'linked'), 'junction');
  assert.throws(() => captureSource({ ...f.options, files: ['linked/file.js'] }), /Links|junction/);
  fs.unlinkSync(path.join(f.root, 'linked'));
  fs.unlinkSync(path.join(f.root, 'example.js'));
  fs.linkSync(path.join(outside, 'file.js'), path.join(f.root, 'example.js'));
  assert.throws(() => captureSource(f.options), /Unsafe/);
});

test('refuses secrets in current source, historical source and verification logs without echoing bytes', t => {
  const f = fixture(t);
  const secret = 'ghp_' + 'x'.repeat(32);
  fs.writeFileSync(path.join(f.root, 'example.js'), secret);
  assert.throws(() => captureSource(f.options), error => /Suspected secret/.test(error.message) && !error.message.includes(secret));
  f.git(['commit', '-am', 'unsafe fixture']);
  const unsafeBase = f.git(['rev-parse', 'HEAD']).trim();
  fs.writeFileSync(path.join(f.root, 'example.js'), 'safe\n');
  assert.throws(() => captureSource({ ...f.options, base: unsafeBase }), /Suspected secret/);
  const { metadataPath, metadata } = check(f);
  fs.writeFileSync(metadata.outputFile, secret);
  assert.throws(() => createPacket({ ...f.options, phase: 'review', checks: [metadataPath] }), /Suspected secret/);
});

test('refuses bare shortcut and Supabase secret credentials without an Authorization header', t => {
  const f = fixture(t);
  for (const credential of ['shiba_sc_' + 'b'.repeat(64), 'sb_secret_' + 'z'.repeat(32)]) {
    fs.writeFileSync(path.join(f.root, 'example.js'), credential);
    assert.throws(() => captureSource(f.options), error => /Suspected secret/.test(error.message) && !error.message.includes(credential));
  }
  assert.equal(fs.existsSync(f.options.out), false);
});

test('allows exact Supabase env references while rejecting malformed references and secret values', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, 'supabase'));
  const configFile = path.join(f.root, 'supabase', 'config.toml');
  const reference = 'env(SUPABASE_AUTH_EXTERNAL_APPLE_SECRET)';
  fs.writeFileSync(configFile, `secret = "${reference}"\n`);
  f.git(['add', 'supabase/config.toml']);
  const options = { ...f.options, files: ['example.js', 'supabase/config.toml'] };
  const packet = createPacket(options);
  assert.equal(verifyPacket({ root: f.root, directory: packet.output }).valid, true);
  assert.ok(fs.readFileSync(path.join(packet.output, 'evidence.md'), 'utf8').includes(reference));
  for (const malformed of [
    'env(supabase_secret)', 'env(1INVALID_NAME)', 'ENV(SUPABASE_SECRET)',
    'prefixenv(SUPABASE_SECRET)', 'env(SUPABASE_SECRET)suffix',
    'env( SUPABASE_SECRET)', 'env(SUPABASE_SECRET=actual)', 'actual-secret-value-12345',
  ]) {
    fs.writeFileSync(configFile, `secret = "${malformed}"\n`);
    assert.throws(() => captureSource(options), error => /Suspected credential assignment/.test(error.message) && !error.message.includes(malformed));
  }
});

test('rejects stale source, scope changes, tampered packet and stale check evidence', t => {
  const f = fixture(t);
  const { metadataPath } = check(f);
  const result = createPacket({ ...f.options, phase: 'review', checks: [metadataPath] });
  fs.writeFileSync(path.join(f.root, 'example.js'), 'changed\n');
  assert.throws(() => verifyPacket({ root: f.root, directory: result.output }), /Stale/);
  assert.throws(() => createPacket({ ...f.options, phase: 'review', checks: [metadataPath], out: path.join(f.temp, 'second') }), /Stale check/);
  f.git(['checkout', '--', 'example.js']);
  fs.writeFileSync(path.join(f.root, 'extra.js'), 'out of scope\n');
  assert.throws(() => verifyPacket({ root: f.root, directory: result.output }), /Stale/);
  fs.unlinkSync(path.join(f.root, 'extra.js'));
  fs.appendFileSync(path.join(result.output, 'evidence.md'), 'tampered');
  assert.throws(() => verifyPacket({ root: f.root, directory: result.output }), /modified|truncated/);
});

test('requires real complete check metadata in review phase and refuses in-repo logs', t => {
  const f = fixture(t);
  assert.throws(() => createPacket({ ...f.options, phase: 'review' }), /requires actual/);
  const { metadataPath, metadata } = check(f);
  metadata.truncated = true;
  fs.writeFileSync(metadataPath, JSON.stringify(metadata));
  assert.throws(() => createPacket({ ...f.options, checks: [metadataPath] }), /Incomplete/);
  metadata.truncated = false;
  metadata.outputFile = path.join(f.root, 'example.js');
  fs.writeFileSync(metadataPath, JSON.stringify(metadata));
  assert.throws(() => createPacket({ ...f.options, checks: [metadataPath] }), /outside the repository/);
});

test('captures failures honestly without claiming review PASS', t => {
  const f = fixture(t);
  const { metadataPath, metadata } = check(f);
  metadata.exitCode = 1;
  fs.writeFileSync(metadataPath, JSON.stringify(metadata));
  const result = createPacket({ ...f.options, phase: 'review', checks: [metadataPath] });
  const manifest = JSON.parse(fs.readFileSync(path.join(result.output, 'manifest.json')));
  assert.equal(manifest.checks[0].exitCode, 1);
  assert.equal(manifest.verdict, undefined);
  assert.equal(verifyPacket({ root: f.root, directory: result.output }).valid, true);
});
