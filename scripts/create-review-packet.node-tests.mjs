// Run with node --test; the filename intentionally stays outside Vitest's defaults.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { captureSource, createPacket, verifyPacket } from './create-review-packet.mjs';
import { runTrustedReviewPacket } from '../tools/run-trusted-review-packet.mjs';

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
  // Git traverses Windows junctions but lists a POSIX directory symlink itself.
  // Include that platform's Git-visible path so this exercises the link guard.
  const linkedSource = process.platform === 'win32' ? 'linked/file.js' : 'linked';
  assert.throws(() => captureSource({ ...f.options, files: [linkedSource] }), /Links|junction/);
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

// Deliberately invalid, synthetic material: these fixtures contain no usable key.
function privateKeyFixtures() {
  const header = ['-----BEGIN ', 'RSA ', 'PRIVATE', ' KEY-----'].join('');
  const material = ['SYNTHETIC', 'NOT', 'A', 'KEY', '0123456789'].join('-');
  return { header, material, values: [
    `prefix ${header} ${material}`,
    JSON.stringify({ message: `${header}\n${material}` }),
    JSON.stringify({ private_key: `${header}\n${material}` }),
  ] };
}

test('withholds inline and JSON-escaped PEM headers in current and historical source', t => {
  const f = fixture(t);
  const { values, material } = privateKeyFixtures();
  for (const value of values) {
    fs.writeFileSync(path.join(f.root, 'example.js'), `${value}\n`);
    assert.throws(() => createPacket(f.options), error => /Suspected secret/.test(error.message) && !error.message.includes(material));
    assert.equal(fs.existsSync(f.options.out), false);
    f.git(['commit', '-am', 'synthetic invalid private material']);
    const unsafeBase = f.git(['rev-parse', 'HEAD']).trim();
    fs.writeFileSync(path.join(f.root, 'example.js'), 'export const amount = 1;\n');
    assert.throws(() => createPacket({ ...f.options, base: unsafeBase }), error => /Suspected secret in baseline/.test(error.message) && !error.message.includes(material));
    assert.equal(fs.existsSync(f.options.out), false);
  }
});

test('withholds private-key fields and prefixed identifiers without a PEM marker', t => {
  const f = fixture(t);
  const { material } = privateKeyFixtures();
  const values = [
    JSON.stringify({ ['private_key']: material }), `privateKey = "${material}"`,
    `GOOGLE_PRIVATE_KEY='${material}'`, `service_private_key=${material}`,
  ];
  for (const value of values) {
    fs.writeFileSync(path.join(f.root, 'example.js'), `${value}\n`);
    assert.throws(() => createPacket(f.options), error => /Suspected credential assignment/.test(error.message) && !error.message.includes(material));
    assert.equal(fs.existsSync(f.options.out), false);
  }
  f.git(['commit', '-am', 'synthetic private field baseline']);
  const unsafeBase = f.git(['rev-parse', 'HEAD']).trim();
  fs.writeFileSync(path.join(f.root, 'example.js'), 'export const amount = 1;\n');
  assert.throws(() => createPacket({ ...f.options, base: unsafeBase }), error => /Suspected credential assignment in baseline/.test(error.message) && !error.message.includes(material));
});

test('withholds embedded private material in cumulative diff before output creation', t => {
  const f = fixture(t);
  const { header, material } = privateKeyFixtures();
  // Source bodies are safe: the synthetic path appears only in diff/metadata.
  // This isolates the cumulative-diff guard from the source-content guard.
  for (const name of [`inline-${header}-fixture.txt`, ['diff-private_key', '=', material, '.txt'].join('')]) {
    const filename = path.join(f.root, name);
    fs.writeFileSync(filename, 'safe baseline\n');
    f.git(['add', name]);
    f.git(['commit', '-m', 'synthetic diff-path fixture']);
    const base = f.git(['rev-parse', 'HEAD']).trim();
    fs.writeFileSync(filename, 'safe change\n');
    assert.throws(() => createPacket({ ...f.options, base, files: ['example.js', name] }), error => /Suspected (?:secret|credential assignment) in cumulative diff/.test(error.message) && !error.message.includes(material) && !error.message.includes(header));
    assert.equal(fs.existsSync(f.options.out), false);
    f.git(['checkout', '--', name]);
  }
});

test('does not echo sensitive source filenames when rejecting current or historical content', t => {
  const f = fixture(t);
  const { material } = privateKeyFixtures();
  const name = ['source-private_key', '=', material, '.txt'].join('');
  const filename = path.join(f.root, name);
  fs.writeFileSync(filename, JSON.stringify({ ['private_key']: material }));
  f.git(['add', name]);
  const options = { ...f.options, files: ['example.js', name] };
  assert.throws(() => createPacket(options), error => /Suspected credential assignment in selected source/.test(error.message) && !error.message.includes(material) && !error.message.includes(name));
  f.git(['commit', '-m', 'synthetic sensitive filename and content']);
  const base = f.git(['rev-parse', 'HEAD']).trim();
  fs.writeFileSync(filename, 'safe current source\n');
  assert.throws(() => createPacket({ ...options, base }), error => /Suspected credential assignment in baseline source/.test(error.message) && !error.message.includes(material) && !error.message.includes(name));
  assert.equal(fs.existsSync(f.options.out), false);
});

test('withholds inline PEMs and private-key fields from verification logs', t => {
  const f = fixture(t);
  const { metadata, metadataPath } = check(f);
  const { values, material } = privateKeyFixtures();
  for (const value of [...values, JSON.stringify({ ['private_key']: material }), `+private_key="${material}"`]) {
    fs.writeFileSync(metadata.outputFile, `${value}\n`);
    assert.throws(() => createPacket({ ...f.options, phase: 'review', checks: [metadataPath] }), error => /Suspected (?:secret|credential assignment) in check output/.test(error.message) && !error.message.includes(material));
    assert.equal(fs.existsSync(f.options.out), false);
  }
});

test('allows private-key placeholders and exact environment references', t => {
  const f = fixture(t);
  for (const expression of ['"<redacted>"', '"[REDACTED]"', '"${GOOGLE_PRIVATE_KEY}"', '"env(GOOGLE_PRIVATE_KEY)"',
    'Deno.env.get("GOOGLE_PRIVATE_KEY");', 'process.env.GOOGLE_PRIVATE_KEY;']) {
    fs.writeFileSync(path.join(f.root, 'example.js'), ['private_key', ' = ', expression, '\n'].join(''));
    assert.doesNotThrow(() => captureSource(f.options));
  }
});

test('refuses bare shortcut and Supabase secret credentials without an Authorization header', t => {
  const f = fixture(t);
  for (const credential of ['shiba_sc_' + 'b'.repeat(64), 'sb_secret_' + 'z'.repeat(32), 'npm_' + 'x'.repeat(32),
    '//registry.npmjs.org/:_authToken=npm_' + 'y'.repeat(32), `_authToken="npm_${'z'.repeat(32)}"`]) {
    fs.writeFileSync(path.join(f.root, 'example.js'), credential);
    assert.throws(() => captureSource(f.options), error => /Suspected secret/.test(error.message) && !error.message.includes(credential));
    fs.writeFileSync(path.join(f.root, 'example.js'), 'export const amount = 1;\n');
  }
  for (const filename of ['.npmrc', '.npmrc.local']) {
    const protectedFile = path.join(f.root, filename);
    fs.writeFileSync(protectedFile, `//registry.npmjs.org/:_authToken=npm_${'q'.repeat(32)}\n`);
    f.git(['add', filename]);
    assert.throws(() => captureSource({ ...f.options, files: [filename] }), /Protected path/);
    assert.equal(captureSource(f.options).exclusions.find((item) => item.path === filename)?.reason, 'protected-path-content-not-read');
    fs.rmSync(protectedFile);
    f.git(['reset', '--', filename]);
  }
  fs.writeFileSync(path.join(f.root, 'example.js'), '_authToken=${NPM_TOKEN}\n');
  assert.doesNotThrow(() => captureSource(f.options));
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
    assert.throws(() => captureSource(options), error => /Suspected credential assignment/.test(error.message) && !error.message.includes(malformed), malformed);
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

test('withholds prefixed credential assignments before publishing source or cumulative diff', t => {
  const f = fixture(t);
  const synthetic = ['synthetic', 'credential', '0123456789'].join('-');
  const assignments = [
    `POSTGRES_PASSWORD="${synthetic}"`, `SUPABASE_SERVICE_ROLE_KEY='${synthetic}'`,
    `STRIPE_SECRET_KEY=${synthetic}`, `GOOGLE_CLIENT_SECRET="${synthetic}"`,
    `process.env.POSTGRES_PASSWORD = "${synthetic}"`, `$env:POSTGRES_PASSWORD = "${synthetic}"`,
    `{"SUPABASE_SERVICE_ROLE_KEY":"${synthetic}"}`, `databasePassword = "${synthetic}"`,
    `message = "POSTGRES_PASSWORD=${synthetic}"`, `{"message":"SUPABASE_SECRET=${synthetic}"}`,
  ];
  for (const assignment of assignments) {
    fs.writeFileSync(path.join(f.root, 'example.js'), `${assignment}\n`);
    assert.throws(() => createPacket(f.options), error => /Suspected credential assignment/.test(error.message) && !error.message.includes(synthetic));
    assert.equal(fs.existsSync(f.options.out), false);
  }
});

test('withholds prefixed credentials from historical source, logs and check metadata', t => {
  const f = fixture(t);
  const synthetic = ['synthetic', 'historical', '0123456789'].join('-');
  const assignment = `POSTGRES_PASSWORD="${synthetic}"\n`;
  fs.writeFileSync(path.join(f.root, 'example.js'), assignment);
  f.git(['commit', '-am', 'synthetic historical credential']);
  const unsafeBase = f.git(['rev-parse', 'HEAD']).trim();
  fs.writeFileSync(path.join(f.root, 'example.js'), 'export const amount = 1;\n');
  assert.throws(() => createPacket({ ...f.options, base: unsafeBase }), error => /Suspected credential assignment/.test(error.message) && !error.message.includes(synthetic));
  const { metadata, metadataPath } = check(f);
  for (const output of [assignment, `+${assignment}`, `$env:POSTGRES_PASSWORD = "${synthetic}"\n`]) {
    fs.writeFileSync(metadata.outputFile, output);
    assert.throws(() => createPacket({ ...f.options, phase: 'review', checks: [metadataPath] }), error => /Suspected credential assignment/.test(error.message) && !error.message.includes(synthetic));
  }
  fs.writeFileSync(metadata.outputFile, 'synthetic check complete\n');
  metadata.command = `synthetic checker POSTGRES_PASSWORD=${synthetic}`;
  fs.writeFileSync(metadataPath, JSON.stringify(metadata));
  assert.throws(() => createPacket({ ...f.options, phase: 'review', checks: [metadataPath] }), /Suspected credential assignment/);
  assert.equal(fs.existsSync(f.options.out), false);
});

test('allows prefixed credential env references and explicit placeholders', t => {
  const f = fixture(t);
  for (const reference of ['${POSTGRES_PASSWORD}', 'env(POSTGRES_PASSWORD)', '<redacted>', '[REDACTED]', 'example-password']) {
    fs.writeFileSync(path.join(f.root, 'example.js'), `POSTGRES_PASSWORD="${reference}"\n`);
    assert.doesNotThrow(() => captureSource(f.options));
  }
});

test('allows only exact built-in environment reads for credential variables', t => {
  const f = fixture(t);
  for (const expression of ["Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');", 'Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");', 'process.env.POSTGRES_PASSWORD;']) {
    fs.writeFileSync(path.join(f.root, 'example.js'), ['const serviceRoleKey', ' = ', expression, '\n'].join(''));
    assert.doesNotThrow(() => captureSource(f.options));
  }
  for (const expression of [
    "Deno.env.get('lowercase_name');", "prefixDeno.env.get('SUPABASE_SERVICE_ROLE_KEY');",
    "Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')suffix;", "Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') + 'synthetic-value';",
    "Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? 'synthetic-value';", 'process.env.POSTGRES_PASSWORD + "synthetic-value";',
    "Deno.env.get('NAME', 'synthetic-value');", "Deno.env.get('NAME')\n + 'synthetic-value';",
  ]) {
    fs.writeFileSync(path.join(f.root, 'example.js'), ['const serviceRoleKey', ' = ', expression, '\n'].join(''));
    assert.throws(() => captureSource(f.options), /Suspected credential assignment/);
  }
});

function npmLockfile(count = 1200) {
  const packages = { '': { name: 'synthetic-packet-fixture', version: '1.0.0' } };
  for (let index = 0; index < count; index++) packages[`node_modules/synthetic-package-${index}`] = {
    version: '1.0.0', resolved: `https://registry.npmjs.org/synthetic-package-${index}/-/synthetic-package-${index}-1.0.0.tgz`,
    integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
  };
  packages['node_modules/synthetic-lock-end-marker'] = { version: '1.0.0' };
  return JSON.stringify({ name: 'synthetic-packet-fixture', version: '1.0.0', lockfileVersion: 3, requires: true, packages }, null, 2) + '\n';
}

test('includes complete oversized validated npm lockfile baseline and current bytes', t => {
  const f = fixture(t);
  const lockfile = npmLockfile();
  assert.ok(Buffer.byteLength(lockfile) > 256 * 1024 && Buffer.byteLength(lockfile) <= 512 * 1024);
  const filename = path.join(f.root, 'package-lock.json');
  fs.writeFileSync(filename, lockfile);
  f.git(['add', 'package-lock.json']);
  f.git(['commit', '-m', 'synthetic lock baseline']);
  const base = f.git(['rev-parse', 'HEAD']).trim();
  fs.writeFileSync(filename, lockfile.replace('"version": "1.0.0"', '"version": "1.0.1"'));
  const result = createPacket({ ...f.options, base, files: ['example.js', 'package-lock.json'] });
  const manifest = JSON.parse(fs.readFileSync(path.join(result.output, 'manifest.json')));
  const entry = manifest.files.find(file => file.path === 'package-lock.json');
  assert.equal(entry.baseline.bytes, Buffer.byteLength(lockfile));
  assert.equal(entry.current.bytes, Buffer.byteLength(lockfile));
  const body = fs.readFileSync(path.join(result.output, 'evidence.md'), 'utf8');
  assert.equal(body.split('synthetic-lock-end-marker').length - 1, 2);
  assert.equal(verifyPacket({ root: f.root, directory: result.output }).valid, true);
});

test('keeps lockfile exception narrow and checks original BOM bytes, format, secrets and upper bound', t => {
  const f = fixture(t);
  const lockfile = npmLockfile();
  for (const name of ['large.txt', 'nested/package-lock.json']) {
    const absolute = path.join(f.root, name);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, lockfile);
    f.git(['add', name]);
    assert.throws(() => captureSource({ ...f.options, files: ['example.js', name] }), /oversized/i);
    f.git(['rm', '-f', name]);
  }
  const filename = path.join(f.root, 'package-lock.json');
  fs.writeFileSync(filename, lockfile);
  f.git(['add', 'package-lock.json']);
  const options = { ...f.options, files: ['example.js', 'package-lock.json'] };
  for (const bad of [
    'x'.repeat(270000), JSON.stringify({ packages: {}, padding: 'x'.repeat(270000) }),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('x'.repeat(256 * 1024))]),
    lockfile.replace('"lockfileVersion": 3', '"lockfileVersion": 1'),
  ]) {
    fs.writeFileSync(filename, bad);
    assert.throws(() => captureSource(options), /validated npm lockfile/);
  }
  const synthetic = ['synthetic', 'lock', '0123456789'].join('-');
  fs.writeFileSync(filename, lockfile.replace('"version": "1.0.0"', `"POSTGRES_PASSWORD": "${synthetic}"`));
  assert.throws(() => captureSource(options), error => /Suspected credential assignment/.test(error.message) && !error.message.includes(synthetic));
  for (const bad of [Buffer.concat([Buffer.from(lockfile), Buffer.from([0xff])]), lockfile + '\0']) {
    fs.writeFileSync(filename, bad);
    assert.throws(() => captureSource(options), /Invalid UTF-8|Binary/);
  }
  fs.writeFileSync(filename, npmLockfile(2000));
  assert.throws(() => captureSource(options), /oversized/i);
});

test('retains log and total evidence limits when including a larger lockfile', t => {
  const f = fixture(t);
  const { metadata, metadataPath } = check(f);
  fs.writeFileSync(metadata.outputFile, 'x'.repeat(256 * 1024 + 1));
  assert.throws(() => createPacket({ ...f.options, phase: 'review', checks: [metadataPath] }), /oversized/i);
  const files = ['example.js', 'package-lock.json'];
  fs.writeFileSync(path.join(f.root, 'package-lock.json'), npmLockfile());
  for (let index = 0; index < 19; index++) {
    const name = `synthetic-large-${index}.txt`;
    fs.writeFileSync(path.join(f.root, name), 'x'.repeat(220000));
    files.push(name);
  }
  f.git(['add', ...files]);
  f.git(['commit', '-m', 'synthetic aggregate boundary']);
  assert.throws(() => createPacket({ ...f.options, base: f.git(['rev-parse', 'HEAD']).trim(), files }), /Oversized evidence: complete packet/);
});

test('records Git modes and rejects same-byte mode and staging changes in packets and checks', t => {
  const f = fixture(t);
  const { metadataPath } = check(f);
  const result = createPacket({ ...f.options, phase: 'review', checks: [metadataPath] });
  const manifest = JSON.parse(fs.readFileSync(path.join(result.output, 'manifest.json')));
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.files[0].baseline.gitMode, '100644');
  assert.equal(manifest.files[0].current.gitMode, '100644');
  assert.equal(manifest.files[0].index.mode, '100644');
  const original = captureSource(f.options).identity.sourceDigest;
  if (process.platform !== 'win32') {
    fs.chmodSync(path.join(f.root, 'example.js'), 0o755);
    assert.notEqual(captureSource(f.options).identity.sourceDigest, original);
    assert.throws(() => verifyPacket({ root: f.root, directory: result.output }), /Stale/);
    fs.chmodSync(path.join(f.root, 'example.js'), 0o644);
  }
  f.git(['config', 'core.fileMode', 'false']);
  f.git(['update-index', '--chmod=+x', 'example.js']);
  assert.notEqual(captureSource(f.options).identity.sourceDigest, original);
  assert.throws(() => verifyPacket({ root: f.root, directory: result.output }), /Stale/);
  assert.throws(() => createPacket({ ...f.options, phase: 'review', checks: [metadataPath], out: path.join(f.temp, 'stale-mode') }), /Stale check/);
});

test('binds owner execute transitions in both directions when Git ignores file modes', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t);
  const filename = path.join(f.root, 'example.js');
  f.git(['config', 'core.fileMode', 'false']);
  for (const [beforeMode, afterMode, beforeGitMode, afterGitMode] of [
    [0o755, 0o655, '100755', '100644'], [0o655, 0o755, '100644', '100755'],
  ]) {
    fs.chmodSync(filename, beforeMode);
    const before = captureSource(f.options);
    const { metadataPath } = check(f);
    const options = { ...f.options, out: path.join(f.temp, `owner-mode-${beforeMode}`), phase: 'review', checks: [metadataPath] };
    const packet = createPacket(options);
    const manifest = JSON.parse(fs.readFileSync(path.join(packet.output, 'manifest.json')));
    assert.equal(manifest.files[0].baseline.gitMode, '100644');
    assert.equal(manifest.files[0].current.gitMode, beforeGitMode);
    assert.equal(manifest.files[0].index.mode, '100644');
    fs.chmodSync(filename, afterMode);
    const after = captureSource(f.options);
    assert.equal(after.entries[0].current.gitMode, afterGitMode);
    assert.equal(after.entries[0].current.sha256, before.entries[0].current.sha256);
    assert.deepEqual(after.entries[0].index, before.entries[0].index);
    assert.equal(after.status, before.status);
    assert.equal(after.diff, before.diff);
    assert.equal(after.identity.cumulativeDiffSha256, before.identity.cumulativeDiffSha256);
    assert.notEqual(after.identity.sourceDigest, before.identity.sourceDigest);
    assert.throws(() => verifyPacket({ root: f.root, directory: packet.output }), /Stale/);
    assert.throws(() => createPacket({ ...options, out: path.join(f.temp, `stale-owner-mode-${beforeMode}`) }), /Stale check/);
  }
});

test('creates private packet outputs under umask 022 without changing existing parent permissions', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t);
  const parentMode = fs.statSync(f.temp).mode & 0o777;
  const previousUmask = process.umask(0o022);
  try {
    const packet = createPacket(f.options);
    assert.equal(fs.statSync(packet.output).mode & 0o777, 0o700);
    for (const name of ['manifest.json', 'evidence.md']) {
      assert.equal(fs.statSync(path.join(packet.output, name)).mode & 0o777, 0o600);
    }
    assert.equal(fs.statSync(f.temp).mode & 0o777, parentMode);
    assert.equal(verifyPacket({ root: f.root, directory: packet.output }).valid, true);
  } finally {
    process.umask(previousUmask);
  }
});

test('rejects stage and unstage of unchanged working bytes', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'example.js'), 'export const amount = 2;\n');
  const packet = createPacket(f.options);
  f.git(['add', 'example.js']);
  assert.throws(() => verifyPacket({ root: f.root, directory: packet.output }), /Stale/);
  const staged = createPacket({ ...f.options, out: path.join(f.temp, 'staged') });
  f.git(['reset', '--', 'example.js']);
  assert.throws(() => verifyPacket({ root: f.root, directory: staged.output }), /Stale/);
});

test('binds index blob IDs when working bytes, status and cumulative diff remain the same', t => {
  const f = fixture(t);
  const filename = path.join(f.root, 'example.js');
  fs.writeFileSync(filename, 'export const amount = 2;\n');
  f.git(['add', 'example.js']);
  fs.writeFileSync(filename, 'export const amount = 1;\n');
  const before = captureSource(f.options);
  const packet = createPacket(f.options);
  fs.writeFileSync(filename, 'export const amount = 3;\n');
  f.git(['add', 'example.js']);
  fs.writeFileSync(filename, 'export const amount = 1;\n');
  const after = captureSource(f.options);
  assert.equal(after.status, before.status);
  assert.equal(after.identity.cumulativeDiffSha256, before.identity.cumulativeDiffSha256);
  assert.notEqual(after.identity.sourceDigest, before.identity.sourceDigest);
  assert.throws(() => verifyPacket({ root: f.root, directory: packet.output }), /Stale/);
});

test('rejects omitted index-only mode and blob changes', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'unrelated.js'), 'export const unchanged = 1;\n');
  f.git(['add', 'unrelated.js']);
  f.git(['commit', '-m', 'synthetic extra baseline']);
  f.options.base = f.git(['rev-parse', 'HEAD']).trim();
  f.git(['config', 'core.fileMode', 'false']);
  f.git(['update-index', '--chmod=+x', 'unrelated.js']);
  assert.throws(() => captureSource(f.options), /allowlist omits changed.*unrelated.js/);
  f.git(['reset', '--', 'unrelated.js']);
  fs.writeFileSync(path.join(f.root, 'unrelated.js'), 'export const unchanged = 2;\n');
  f.git(['add', 'unrelated.js']);
  fs.writeFileSync(path.join(f.root, 'unrelated.js'), 'export const unchanged = 1;\n');
  assert.throws(() => captureSource(f.options), /allowlist omits changed.*unrelated.js/);
});

test('recomputes actual diff during freshness verification', t => {
  const f = fixture(t);
  const lines = Array.from({ length: 12 }, (_, index) => `line ${index}`);
  fs.writeFileSync(path.join(f.root, 'example.js'), lines.join('\n') + '\n');
  f.git(['commit', '-am', 'synthetic diff baseline']);
  f.options.base = f.git(['rev-parse', 'HEAD']).trim();
  lines[6] = 'changed line';
  fs.writeFileSync(path.join(f.root, 'example.js'), lines.join('\n') + '\n');
  const before = captureSource(f.options);
  const packet = createPacket(f.options);
  f.git(['config', 'diff.context', '0']);
  const after = captureSource(f.options);
  assert.equal(after.entries[0].current.sha256, before.entries[0].current.sha256);
  assert.equal(after.status, before.status);
  assert.notEqual(after.identity.cumulativeDiffSha256, before.identity.cumulativeDiffSha256);
  assert.throws(() => verifyPacket({ root: f.root, directory: packet.output }), /Stale/);
});

test('rejects index changes while building a packet before writing output', t => {
  const f = fixture(t);
  const { metadata, metadataPath } = check(f);
  f.git(['config', 'core.fileMode', 'false']);
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', function (filename, ...args) {
    const bytes = read.call(fs, filename, ...args);
    if (filename === metadata.outputFile) f.git(['update-index', '--chmod=+x', 'example.js']);
    return bytes;
  });
  assert.throws(() => createPacket({ ...f.options, phase: 'review', checks: [metadataPath] }), /Source changed while building/);
  assert.equal(fs.existsSync(f.options.out), false);
});

test('trusted launcher rejects malicious checkout and replacement bytes without executing them', t => {
  const f = fixture(t);
  const marker = path.join(f.temp, 'must-never-exist');
  const malicious = `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'executed');\n`;
  const candidate = path.join(f.root, 'contributor-builder.mjs');
  fs.writeFileSync(candidate, malicious);
  const digest = value => createHash('sha256').update(value).digest('hex');
  assert.throws(() => runTrustedReviewPacket({ root: f.root, builder: candidate, expectedSha256: digest(malicious) }), /outside the contributor checkout/);
  const installed = path.join(f.temp, 'installed-builder.mjs');
  const trusted = 'process.stdout.write("trusted fixture");\n';
  const pin = digest(trusted);
  fs.writeFileSync(installed, malicious);
  assert.throws(() => runTrustedReviewPacket({ root: f.root, builder: installed, expectedSha256: pin }), /no code executed/);
  assert.throws(() => runTrustedReviewPacket({ root: f.root, builder: installed }), /independently recorded/);
  assert.equal(fs.existsSync(marker), false);
});

test('trusted launcher executes verified snapshot despite candidate replacement and inherited module hooks', t => {
  const f = fixture(t);
  const marker = path.join(f.temp, 'must-never-exist');
  const malicious = `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'executed');\n`;
  const hook = path.join(f.temp, 'untrusted-hook.mjs');
  fs.writeFileSync(hook, malicious);
  const trusted = 'process.stdout.write(JSON.stringify({ root: process.argv[3], snapshot: import.meta.url, nodeOptions: process.env.NODE_OPTIONS ?? null, nodePath: process.env.NODE_PATH ?? null }));\n';
  const installed = path.join(f.temp, 'installed-builder.mjs');
  fs.writeFileSync(installed, trusted);
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', function (filename, ...args) {
    const bytes = read.call(fs, filename, ...args);
    if (filename === installed) fs.writeFileSync(installed, malicious);
    return bytes;
  });
  const oldOptions = process.env.NODE_OPTIONS;
  const oldPath = process.env.NODE_PATH;
  try {
    process.env.NODE_OPTIONS = `--import=${hook}`;
    process.env.NODE_PATH = f.root;
    const result = JSON.parse(runTrustedReviewPacket({ root: f.root, builder: installed,
      expectedSha256: createHash('sha256').update(trusted).digest('hex') }));
    assert.equal(result.root, f.root);
    assert.match(result.snapshot, /trusted-review-builder-/);
    assert.equal(result.nodeOptions, null);
    assert.equal(result.nodePath, null);
    assert.equal(fs.existsSync(marker), false);
  } finally {
    if (oldOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = oldOptions;
    if (oldPath === undefined) delete process.env.NODE_PATH; else process.env.NODE_PATH = oldPath;
  }
});

test('trusted launcher runs inspected packet builder copied outside the review checkout', t => {
  const f = fixture(t);
  const bytes = fs.readFileSync(new URL('./create-review-packet.mjs', import.meta.url));
  const installed = path.join(f.temp, 'installed-builder.mjs');
  fs.writeFileSync(installed, bytes);
  const result = JSON.parse(runTrustedReviewPacket({ root: f.root, builder: installed,
    expectedSha256: createHash('sha256').update(bytes).digest('hex'), args: ['--base', f.options.base, '--files', 'example.js', '--identity-only'] }));
  assert.deepEqual(result, captureSource(f.options).identity);
});

test('trusted launcher rejects checkout-local temporary directories before execution', t => {
  const f = fixture(t);
  const marker = path.join(f.temp, 'must-never-exist');
  const bytes = `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'executed');\n`;
  const installed = path.join(f.temp, 'independently-pinned-fixture.mjs');
  fs.writeFileSync(installed, bytes);
  const names = process.platform === 'win32' ? ['TEMP', 'TMP'] : ['TMPDIR'];
  const previous = names.map(name => process.env[name]);
  try {
    for (const name of names) process.env[name] = f.root;
    assert.throws(() => runTrustedReviewPacket({ root: f.root, builder: installed,
      expectedSha256: createHash('sha256').update(bytes).digest('hex') }), /temporary directory must be outside.*no code executed/);
    assert.equal(fs.existsSync(marker), false);
  } finally {
    names.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; });
  }
});

test('captures inspected builder tests, entrypoint and real npm lockfile as source without executing them', t => {
  const f = fixture(t);
  const files = [
    'scripts/create-review-packet.mjs', 'scripts/create-review-packet.node-tests.mjs',
    'tools/run-trusted-review-packet.mjs', 'tools/skills/codex-chatgpt-review/SKILL.md',
    'tools/skills/codex-chatgpt-review/INSTALLATION.md', 'supabase/functions/finance-shortcut-receive/index.ts', 'package-lock.json',
  ];
  for (const file of files) {
    const absolute = path.join(f.root, file);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, fs.readFileSync(new URL(`../${file}`, import.meta.url)));
  }
  f.git(['add', ...files]);
  f.git(['commit', '-m', 'inspected source capture fixture']);
  const base = f.git(['rev-parse', 'HEAD']).trim();
  const source = captureSource({ ...f.options, base, files: ['example.js', ...files] });
  assert.equal(source.entries.length, files.length + 1);
  assert.ok(source.entries.find(file => file.path === 'package-lock.json').current.bytes > 256 * 1024);
});
