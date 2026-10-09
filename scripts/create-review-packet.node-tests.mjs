// Run with node --test; the filename intentionally stays outside Vitest's defaults.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
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

function privateFixture(t) {
  const f = fixture(t);
  const privateFile = path.join(f.root, '.env.example');
  fs.writeFileSync(privateFile, 'SYNTHETIC_PRIVATE_FIXTURE');
  fs.utimesSync(privateFile, 1, 1);
  f.git(['add', '.env.example']);
  f.git(['commit', '-m', 'private metadata baseline']);
  f.options.base = f.git(['rev-parse', 'HEAD']).trim();
  return { ...f, privateFile };
}

function forbidPrivateReads(t, f) {
  let reads = 0;
  const originalRead = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    const name = String(file);
    if (name === f.privateFile || name.startsWith(path.join(f.root, 'private') + path.sep)) {
      reads++;
      throw new Error('private bytes must not be read');
    }
    return originalRead(file, ...args);
  });
  return () => assert.equal(reads, 0);
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

test('rejects changed protected scope without reading or exporting its content', t => {
  const f = fixture(t);
  const privateFile = path.join(f.root, '.env.example');
  fs.writeFileSync(privateFile, 'SYNTHETIC_PRIVATE_FIXTURE');
  fs.utimesSync(privateFile, 1, 1);
  f.git(['add', '.env.example']);
  f.git(['commit', '-m', 'private metadata baseline']);
  const options = { ...f.options, base: f.git(['rev-parse', 'HEAD']).trim() };
  fs.writeFileSync(privateFile, 'SYNTHETIC_CHANGED_FIXTURE');
  let reads = 0;
  const originalRead = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (file === privateFile) { reads++; throw new Error('private bytes must not be read'); }
    return originalRead(file, ...args);
  });
  assert.throws(() => createPacket(options), /INCOMPLETE.*protected/i);
  assert.equal(reads, 0);
  assert.equal(fs.existsSync(options.out), false);
});

test('binds unchanged protected metadata and rejects same-size edits with restored mtime', t => {
  const f = privateFixture(t);
  const assertUnread = forbidPrivateReads(t, f);
  const source = captureSource(f.options);
  const excluded = source.exclusions.find(item => item.path === '.env.example');
  assert.equal(excluded.metadata.changed, false);
  assert.equal(excluded.metadata.assurance, 'unchanged-non-racy-git-stat-metadata');
  assert.equal(excluded.metadata.index.objectId, excluded.metadata.baseline.objectId);
  const packet = createPacket(f.options);
  assert.equal(verifyPacket({ root: f.root, directory: packet.output }).valid, true);
  fs.writeFileSync(f.privateFile, 'X'.repeat(Number(excluded.metadata.workingStat.size)));
  // Same byte length and cached mtime still cannot hide the changed ctime.
  assert.equal(fs.statSync(f.privateFile).size, Number(excluded.metadata.workingStat.size));
  fs.utimesSync(f.privateFile, 1, 1);
  assert.throws(() => verifyPacket({ root: f.root, directory: packet.output }), /INCOMPLETE.*protected/i);
  assertUnread();
});

test('rejects staged and committed protected changes including a HEAD hidden by baseline index and worktree', t => {
  const f = privateFixture(t);
  const assertUnread = forbidPrivateReads(t, f);
  fs.writeFileSync(f.privateFile, 'synthetic changed staging');
  f.git(['add', '.env.example']);
  fs.writeFileSync(f.privateFile, 'SYNTHETIC_PRIVATE_FIXTURE');
  fs.utimesSync(f.privateFile, 1, 1);
  assert.throws(() => captureSource(f.options), /INCOMPLETE.*protected/i);
  f.git(['commit', '-m', 'changed protected HEAD']);
  f.git(['restore', `--source=${f.options.base}`, '--staged', '--worktree', '--', '.env.example']);
  assert.throws(() => captureSource(f.options), /INCOMPLETE.*protected/i);
  assert.equal(fs.existsSync(f.options.out), false);
  assertUnread();
});

test('rejects protected additions, deletions, executable changes and index trust flags', async t => {
  for (const mutation of ['add', 'delete', 'mode', 'assume-unchanged', 'skip-worktree']) {
    await t.test(mutation, sub => {
      const f = privateFixture(sub);
      const assertUnread = forbidPrivateReads(sub, f);
      if (mutation === 'add') { fs.writeFileSync(path.join(f.root, '.npmrc'), 'synthetic fixture'); f.git(['add', '.npmrc']); }
      if (mutation === 'delete') { f.git(['rm', '.env.example']); fs.writeFileSync(f.privateFile, 'synthetic ignored replacement'); }
      if (mutation === 'mode') f.git(['update-index', '--chmod=+x', '.env.example']);
      if (mutation === 'assume-unchanged' || mutation === 'skip-worktree') f.git(['update-index', `--${mutation}`, '.env.example']);
      assert.throws(() => createPacket(f.options), /INCOMPLETE.*protected/i);
      assert.equal(fs.existsSync(f.options.out), false);
      assertUnread();
    });
  }
});

test('rejects racily-clean protected stats, parser uncertainty and mid-capture metadata changes', t => {
  const f = privateFixture(t);
  const assertUnread = forbidPrivateReads(t, f);
  const indexPath = path.join(f.root, '.git', 'index');
  const indexTime = fs.statSync(indexPath).mtime;
  fs.utimesSync(indexPath, 1, 1);
  assert.throws(() => captureSource(f.options), /INCOMPLETE.*protected/i);
  fs.utimesSync(indexPath, indexTime, indexTime);
  const originalExec = childProcess.execFileSync;
  childProcess.execFileSync = (command, args, ...options) => {
    const result = originalExec(command, args, ...options);
    if (command === 'git' && args.includes('--debug')) return Buffer.from(`${result}  unknown: 1\n`);
    return result;
  };
  syncBuiltinESMExports();
  try { assert.throws(() => captureSource(f.options), /INCOMPLETE.*protected/i); }
  finally { childProcess.execFileSync = originalExec; syncBuiltinESMExports(); }
  const originalRead = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    const bytes = originalRead(file, ...args);
    if (file === path.join(f.root, 'example.js')) fs.utimesSync(f.privateFile, 1, 1);
    return bytes;
  });
  assert.throws(() => createPacket(f.options), /INCOMPLETE.*protected/i);
  assert.equal(fs.existsSync(f.options.out), false);
  assertUnread();
});

test('rejects untracked protected scope before Git can read a private ignore file and skips ignored private subtrees', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, 'private'));
  fs.writeFileSync(path.join(f.root, 'private', '.gitignore'), 'fixture.txt\n');
  fs.writeFileSync(path.join(f.root, 'private', 'fixture.txt'), 'SYNTHETIC_PRIVATE_FIXTURE');
  const assertUnread = forbidPrivateReads(t, f);
  const originalExec = childProcess.execFileSync;
  let publicDiffs = 0;
  childProcess.execFileSync = (command, args, ...options) => {
    if (command === 'git') {
      assert.equal(args.includes('--exclude-standard'), false);
      if (args.includes('diff') || args.includes('status')) {
        const paths = args.slice(args.indexOf('--') + 1);
        assert.ok(paths.length > 0);
        assert.ok(paths.every(file => !file.includes('private') && !file.startsWith('.env')));
        publicDiffs++;
      }
      if (args.includes('show')) assert.ok(args.every(arg => !arg.includes('.env') && !arg.includes('private/')));
      if (args.includes('check-ignore')) {
        assert.ok(!String(options[0].input).includes('private/'));
      }
    }
    return originalExec(command, args, ...options);
  };
  syncBuiltinESMExports();
  try {
    assert.throws(() => createPacket(f.options), /INCOMPLETE.*protected/i);
    fs.writeFileSync(path.join(f.root, '.gitignore'), 'private/\n.env\n');
    f.git(['add', '.gitignore']); f.git(['commit', '-m', 'ignore private fixture']);
    const options = { ...f.options, base: f.git(['rev-parse', 'HEAD']).trim() };
    fs.writeFileSync(path.join(f.root, '.env'), 'SYNTHETIC_IGNORED_FIXTURE');
    const packet = createPacket(options);
    assert.equal(verifyPacket({ root: f.root, directory: packet.output }).valid, true);
    assert.ok(publicDiffs > 0);
  } finally { childProcess.execFileSync = originalExec; syncBuiltinESMExports(); }
  assertUnread();
});

test('rejects control-character Git names instead of truncating a protected subtree at a tab', t => {
  const f = fixture(t);
  const privateDirectory = path.join(f.root, 'public\t', 'private');
  fs.mkdirSync(privateDirectory, { recursive: true });
  const privateFile = path.join(privateDirectory, 'fixture.txt');
  fs.writeFileSync(privateFile, 'SYNTHETIC_PRIVATE_FIXTURE');
  f.git(['add', 'public\t/private/fixture.txt']);
  f.git(['commit', '-m', 'unsupported path metadata']);
  const options = { ...f.options, base: f.git(['rev-parse', 'HEAD']).trim() };
  fs.writeFileSync(privateFile, 'SYNTHETIC_PRIVATE_CHANGE');
  const originalRead = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    assert.notEqual(file, privateFile, 'private bytes must never be read');
    return originalRead(file, ...args);
  });
  assert.throws(() => createPacket(options), /INCOMPLETE.*Git path metadata/i);
  assert.equal(fs.existsSync(options.out), false);
});

test('blocks protected directory discovery before subprocess gitfile I/O', { skip: process.platform !== 'linux' && 'Linux strace regression; other platforms unverified' }, async t => {
  for (const parent of ['', 'public/']) {
    for (const ignored of [false, true]) {
      await t.test(`${parent}private, ${ignored ? 'ignored' : 'unignored'}`, sub => {
        const f = fixture(sub);
        const relative = `${parent}private`;
        if (parent) {
          fs.mkdirSync(path.join(f.root, 'public'));
          fs.writeFileSync(path.join(f.root, 'public', 'anchor.txt'), 'public synthetic baseline\n');
          f.git(['add', 'public/anchor.txt']);
        }
        if (ignored) {
          fs.writeFileSync(path.join(f.root, '.gitignore'), `${relative}/\n`);
          f.git(['add', '.gitignore']);
        }
        if (parent || ignored) f.git(['commit', '-m', 'synthetic discovery baseline']);
        const options = { ...f.options, base: f.git(['rev-parse', 'HEAD']).trim() };
        const directory = path.join(f.root, relative);
        fs.mkdirSync(directory);
        fs.writeFileSync(path.join(directory, '.git'), 'gitdir: ../missing-synthetic-git-dir\n');
        fs.writeFileSync(path.join(directory, '.gitignore'), 'fixture.txt\n');
        fs.writeFileSync(path.join(directory, 'fixture.txt'), 'SYNTHETIC_PRIVATE_FIXTURE\n');
        const globalConfig = path.join(f.temp, 'synthetic-global-config');
        fs.writeFileSync(globalConfig, '');
        const trace = (name, command, args) => {
          const output = path.join(f.temp, `${name}.trace`);
          execFileSync('strace', ['-f', '-yy', '-e', 'trace=open,openat,read,pread64,mmap', '-o', output, command, ...args],
            { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'],
              env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: globalConfig } });
          return fs.readFileSync(output, 'utf8').split('\n').filter(line => line.includes(`${directory}/`) || line.includes(`<${directory}>`));
        };
        // Positive control proves the tracer observes Git's indirect reads;
        // a parent-only fs.readFileSync trap would miss these syscalls.
        const unsafe = trace('unsafe-discovery', 'git', ['-C', f.root, 'ls-files', '--others', '--directory', '-z']);
        assert.ok(unsafe.some(line => line.includes(`${directory}/.git`) && /\bread\(/.test(line)));
        const program = `import { createPacket, verifyPacket } from ${JSON.stringify(new URL('./create-review-packet.mjs', import.meta.url).href)};
          const options = ${JSON.stringify(options)};
          ${ignored ? 'const packet = createPacket(options); if (!verifyPacket({root: options.root, directory: packet.output}).valid) throw Error("invalid synthetic packet");'
            : 'let incomplete = false; try { createPacket(options); } catch (error) { incomplete = /INCOMPLETE.*protected/i.test(error.message); } if (!incomplete) throw Error("expected protected INCOMPLETE");'}`;
        const accesses = trace('packet-discovery', process.execPath, ['--input-type=module', '-e', program]);
        assert.deepEqual(accesses, [], 'packet and its subprocesses must not open/read a protected subtree');
        if (!ignored) assert.equal(fs.existsSync(options.out), false);
      });
    }
  }
});

test('does not let index trust flags hide a directory replacing a tracked public file', async t => {
  for (const flag of ['assume-unchanged', 'skip-worktree']) {
    await t.test(flag, sub => {
      const f = fixture(sub);
      const container = path.join(f.root, 'container.txt');
      fs.writeFileSync(container, 'public synthetic baseline\n');
      f.git(['add', 'container.txt']);
      f.git(['commit', '-m', 'tracked public file']);
      const options = { ...f.options, base: f.git(['rev-parse', 'HEAD']).trim() };
      f.git(['update-index', `--${flag}`, 'container.txt']);
      fs.rmSync(container);
      const directory = path.join(container, 'private');
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, '.git'), 'gitdir: ../missing-synthetic-git-dir\n');
      const originalRead = fs.readFileSync;
      sub.mock.method(fs, 'readFileSync', (file, ...args) => {
        assert.equal(String(file).startsWith(directory + path.sep), false, 'protected bytes must not be read');
        return originalRead(file, ...args);
      });
      assert.throws(() => createPacket(options), /INCOMPLETE.*protected/i);
      assert.equal(fs.existsSync(options.out), false);
    });
  }
});

test('rejects a tracked-file directory replacement under an ignored ancestor before subprocess gitfile I/O', { skip: process.platform !== 'linux' && 'Linux strace regression; other platforms unverified' }, t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, 'public'));
  fs.writeFileSync(path.join(f.root, 'public', 'container.txt'), 'public synthetic baseline\n');
  fs.writeFileSync(path.join(f.root, '.gitignore'), 'public/\n');
  f.git(['add', '-f', 'public/container.txt', '.gitignore']);
  f.git(['commit', '-m', 'tracked file under ignored ancestor']);
  const options = { ...f.options, base: f.git(['rev-parse', 'HEAD']).trim() };
  const container = path.join(f.root, 'public', 'container.txt');
  fs.rmSync(container);
  fs.mkdirSync(container);
  fs.writeFileSync(path.join(container, '.git'), 'gitdir: ../missing-synthetic-git-dir\n');
  const globalConfig = path.join(f.temp, 'synthetic-global-config');
  fs.writeFileSync(globalConfig, '');
  const trace = (name, command, args) => {
    const output = path.join(f.temp, `${name}.trace`);
    execFileSync('strace', ['-f', '-yy', '-e', 'trace=open,openat,read,pread64,mmap', '-o', output, command, ...args],
      { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: globalConfig } });
    return fs.readFileSync(output, 'utf8').split('\n').filter(line => line.includes(`${container}/.git`));
  };
  const unsafe = trace('unsafe-diff', 'git', ['-C', f.root, 'diff', '--name-only', options.base, '--', 'public/container.txt']);
  assert.ok(unsafe.some(line => /\bread\(/.test(line)));
  const program = `import {createPacket} from ${JSON.stringify(new URL('./create-review-packet.mjs', import.meta.url).href)};
    let incomplete = false; try {createPacket(${JSON.stringify(options)});} catch (error) {incomplete = /INCOMPLETE.*protected/i.test(error.message);}
    if (!incomplete) throw Error("expected protected INCOMPLETE");`;
  assert.deepEqual(trace('packet-diff', process.execPath, ['--input-type=module', '-e', program]), []);
  assert.equal(fs.existsSync(options.out), false);
});

test('uses literal Git pathspecs for bracket names and never includes a matched protected path', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'choice[1].txt'), 'old literal choice\n');
  fs.writeFileSync(path.join(f.root, '.en[v]'), 'old public source\n');
  fs.writeFileSync(path.join(f.root, '.env'), 'old protected fixture\n');
  fs.utimesSync(path.join(f.root, '.env'), 1, 1);
  f.git(['--literal-pathspecs', 'add', 'choice[1].txt', '.en[v]', '.env']);
  f.git(['commit', '-m', 'literal baseline']);
  const base = f.git(['rev-parse', 'HEAD']).trim();
  fs.writeFileSync(path.join(f.root, 'choice[1].txt'), 'new literal choice\n');
  fs.writeFileSync(path.join(f.root, '.en[v]'), 'new public source\n');
  const withheld = 'UNSELECTED-SYNTHETIC-CONTENT';
  const result = createPacket({ ...f.options, base, files: ['example.js', 'choice[1].txt', '.en[v]'] });
  const evidence = fs.readFileSync(path.join(result.output, 'evidence.md'), 'utf8');
  assert.match(evidence, /\+new literal choice/);
  assert.match(evidence, /\+new public source/);
  assert.equal(evidence.includes(withheld), false);
  assert.equal(verifyPacket({ root: f.root, directory: result.output }).valid, true);
  fs.writeFileSync(path.join(f.root, '.env'), withheld);
  assert.throws(() => verifyPacket({ root: f.root, directory: result.output }), /INCOMPLETE.*protected/i);
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
  const syntheticToken = 'ghp_' + 'x'.repeat(32);
  fs.writeFileSync(path.join(f.root, 'example.js'), syntheticToken);
  assert.throws(() => captureSource(f.options), error => /Suspected secret/.test(error.message) && !error.message.includes(syntheticToken));
  f.git(['commit', '-am', 'unsafe fixture']);
  const unsafeBase = f.git(['rev-parse', 'HEAD']).trim();
  fs.writeFileSync(path.join(f.root, 'example.js'), 'safe\n');
  assert.throws(() => captureSource({ ...f.options, base: unsafeBase }), /Suspected secret/);
  f.git(['reset', f.options.base, '--', 'example.js']);
  const { metadataPath, metadata } = check(f);
  fs.writeFileSync(metadata.outputFile, syntheticToken);
  assert.throws(() => createPacket({ ...f.options, phase: 'review', checks: [metadataPath] }), /Suspected secret/);
});

// Deliberately invalid, synthetic material: these fixtures contain no usable key.
function privateKeyFixtures() {
  const header = ['-----BEGIN ', 'RSA ', 'PRIVATE', ' KEY-----'].join('');
  const material = ['SYNTHETIC', 'NOT', 'A', 'KEY', '0123456789'].join('-');
  return { header, material, values: [
    `prefix ${header} ${material}`,
    JSON.stringify({ message: `${header}\n${material}` }),
    JSON.stringify({ ['private_key']: `${header}\n${material}` }),
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
    JSON.stringify({ ['private_key']: material }), ['privateKey', ' = "', material, '"'].join(''),
    ['GOOGLE_PRIVATE_KEY', "='", material, "'"].join(''), ['service_private_key', '=', material].join(''),
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
  for (const value of [...values, JSON.stringify({ ['private_key']: material }), ['+private_key', '="', material, '"'].join('')]) {
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

function credentialUris() {
  const credential = ['synthetic', 'uri', 'credential', '0123456789'].join('-');
  const authority = `fixture-user:${credential}@db.example.invalid`;
  const protocols = ['http', 'https', 'postgres', 'postgresql', 'mysql', 'mariadb', 'mongodb', 'mongodb+srv',
    'redis', 'rediss', 'amqp', 'amqps', 'ftp', 'ftps', 'sftp', 'ssh', 'ws', 'wss', 'custom+db'];
  const uri = ['postgresql', '://', authority, '/fixture'].join('');
  return { credential, values: [
    ...protocols.map(protocol => [protocol, '://', authority, '/fixture'].join('')),
    ['redis', '://', credential, '@cache.example.invalid/0'].join(''),
    ['postgresql', '://fixture%3Auser:', credential, '%2F%40part@db.example.invalid/fixture'].join(''),
    ['postgresql', '://fixture-user%3A', credential, '%40db.example.invalid/fixture'].join(''),
    uri.replaceAll('/', '\\/'),
    uri.replaceAll(':', '\\u003a').replaceAll('/', '\\u002f').replaceAll('@', '\\u0040'),
    encodeURIComponent(uri), encodeURIComponent(encodeURIComponent(uri)),
    [...uri].map(character => `%${character.charCodeAt(0).toString(16).padStart(2, '0')}`).join(''),
    ["postgresql", '://fixture-user:', credential, '%2Fpart@db.example.invalid/fixture'].join(''),
    ['postgresql', '://:', credential, '@db.example.invalid/fixture'].join(''),
    ['postgresql', '%3A%2F%2Ffixture-user%3A', credential, '%40db.example.invalid/fixture'].join('').replaceAll('/', '\\/'),
    ['postgresql', '://fixture-user:', credential, '%zz@db.example.invalid/fixture'].join(''),
    ['unrelated%zz ', uri].join(''),
    ['postgresql', '://fixture-user:', credential, "!$&'()*+,;=@[::1]/fixture"].join(''),
    ['postgresql', '://fixture-user:', credential, "\\!\\$\\&\\'\\(\\)\\*\\+\\,\\;\\=@db.example.invalid/fixture"].join(''),
    ["const connection = 'postgresql", '://fixture-user:', credential, "\\'part@db.example.invalid/fixture';"].join(''),
  ] };
}

function mixedUri(intro, encodedPassword, encodedAt = '@', encodedUsername = '') {
  return `{"DATABASE_URL":"${intro}fixture${encodedUsername}-user:synthetic${encodedPassword}password${encodedAt}db.example.invalid/fixture"}`;
}

const escapedUriIntros = [String.raw`postgresql:\/\/`, String.raw`postgresql\u003a\u002f\u002f`,
  // The URI remains invisible after JSON unescaping, requiring the percent
  // phase to expose its scheme while preserving every userinfo octet.
  [...'postgresql'].map(character => `%${character.charCodeAt(0).toString(16)}`).join('') + String.raw`:\/\/`];

test('withholds mixed JSON escapes and percent-space credentials in source and baseline', t => {
  const f = fixture(t);
  for (const intro of escapedUriIntros) {
    const value = mixedUri(intro, '%20');
    fs.writeFileSync(path.join(f.root, 'example.js'), value);
    assert.throws(() => createPacket(f.options), error => /Suspected secret in selected source/.test(error.message)
      && !error.message.includes('synthetic') && !error.message.includes('fixture-user'));
    assert.equal(fs.existsSync(f.options.out), false);
  }
  f.git(['commit', '-am', 'synthetic mixed JSON and percent-space baseline']);
  const base = f.git(['rev-parse', 'HEAD']).trim();
  fs.writeFileSync(path.join(f.root, 'example.js'), 'export const amount = 1;\n');
  assert.throws(() => createPacket({ ...f.options, base }), error => /Suspected secret in baseline source/.test(error.message)
    && !error.message.includes('synthetic') && !error.message.includes('fixture-user'));
  assert.equal(fs.existsSync(f.options.out), false);
});

test('withholds every percent octet in userinfo after JSON slash or ASCII unescaping', t => {
  const f = fixture(t);
  for (const [introIndex, intro] of escapedUriIntros.entries()) {
    // Includes C0/C1 controls, all whitespace and authority delimiters, plus
    // printable and opaque octets. Decoding an octet must never hide userinfo.
    for (let octet = 0; octet <= 255; octet++) {
      const encoded = `%${octet.toString(16).padStart(2, '0')}`;
      for (const position of ['username', 'password']) {
        fs.writeFileSync(path.join(f.root, 'example.js'), mixedUri(intro, position === 'password' ? encoded : '', '@', position === 'username' ? encoded : ''));
        assert.throws(() => captureSource(f.options), error => /Suspected secret/.test(error.message)
          && !error.message.includes('synthetic') && !error.message.includes('fixture'),
        `synthetic percent-octet ${octet}, intro ${introIndex}, ${position}`);
      }
    }
  }
  assert.equal(fs.existsSync(f.options.out), false);
});

test('withholds mixed encoded controls and delimiters in JSON logs and metadata', t => {
  const f = fixture(t);
  const { metadata, metadataPath } = check(f);
  const boundaries = ['%00', '%09', '%0a', '%0b', '%0c', '%0d', '%1f', '%20', '%22', '%23',
    '%2f', '%3c', '%3e', '%3f', '%5c', '%60', '%7f', '%85', '%a0', '%c2%a0', '%e2%80%a8'];
  for (const intro of escapedUriIntros) {
    for (const encoded of boundaries) {
      for (const layer of [1, 2]) {
        const encodedPart = layer === 1 ? encoded : encoded.replaceAll('%', '%25');
        const value = mixedUri(intro, encodedPart, layer === 1 ? '%40' : '%2540');
        // An additional JSON wrapper also exercises escaped backslashes. The
        // synthetic log and metadata each use the production checkText path.
        fs.writeFileSync(metadata.outputFile, JSON.stringify({ database: value, unrelated: '%zz' }));
        assert.throws(() => createPacket({ ...f.options, phase: 'review', checks: [metadataPath] }), error => /Suspected secret in check output/.test(error.message)
          && !error.message.includes('synthetic') && !error.message.includes('fixture-user'));
        assert.equal(fs.existsSync(f.options.out), false);
        fs.writeFileSync(metadata.outputFile, 'safe synthetic check output\n');
        fs.writeFileSync(metadataPath, JSON.stringify({ ...metadata, command: value }));
        assert.throws(() => createPacket({ ...f.options, phase: 'review', checks: [metadataPath] }), error => /Suspected secret in check metadata/.test(error.message)
          && !error.message.includes('synthetic') && !error.message.includes('fixture-user'));
        assert.equal(fs.existsSync(f.options.out), false);
        fs.writeFileSync(metadataPath, JSON.stringify(metadata));
      }
    }
  }
});

test('keeps real JSON URI path query and fragment boundaries separate from userinfo', t => {
  const f = fixture(t);
  for (const uri of [String.raw`https:\/\/docs.example.invalid\/synthetic%20path/contact@example.invalid`,
    String.raw`https:\/\/docs.example.invalid\/path?email=contact%40example.invalid`,
    String.raw`https\u003a\u002f\u002fdocs.example.invalid/path#contact%40example.invalid`,
    String.raw`postgresql:\/\/db.example.invalid/fixture?note=synthetic%0apassword%40example.invalid`]) {
    fs.writeFileSync(path.join(f.root, 'example.js'), `{"DATABASE_URL":"${uri}"}`);
    assert.doesNotThrow(() => captureSource(f.options));
  }
  fs.writeFileSync(path.join(f.root, 'example.js'), '%5cuD800 %5cuDC00 %5cud800%5cudc00\n');
  assert.doesNotThrow(() => captureSource(f.options));
});

test('retains percent outside JSON escape coverage without decoding userinfo boundaries', t => {
  const f = fixture(t);
  const { metadata, metadataPath } = check(f);
  for (const intro of escapedUriIntros) {
    for (const encoded of ['%20', '%00', '%22', '%2f', '%3f', '%5c']) {
      const value = encodeURIComponent(mixedUri(intro, encoded));
      fs.writeFileSync(path.join(f.root, 'example.js'), value);
      assert.throws(() => createPacket(f.options), error => /Suspected secret in selected source/.test(error.message)
        && !error.message.includes('synthetic') && !error.message.includes('fixture'));
      assert.equal(fs.existsSync(f.options.out), false);
      fs.writeFileSync(path.join(f.root, 'example.js'), 'export const amount = 1;\n');
      fs.writeFileSync(metadata.outputFile, value);
      assert.throws(() => createPacket({ ...f.options, phase: 'review', checks: [metadataPath] }), /Suspected secret in check output/);
      assert.equal(fs.existsSync(f.options.out), false);
    }
  }
  for (const token of ['%5C%2F', '%5Cu002f', '%5C%75%30%30%32%66']) {
    fs.writeFileSync(path.join(f.root, 'example.js'), mixedUri(`postgresql:${token}${token}`, '%20', '%40'));
    assert.throws(() => captureSource(f.options), /Suspected secret/);
  }
  for (const token of ['%5C%2F', '%5Cu002f', '%5Cu0020', '%5Cu00a0', '%5Cu2028']) {
    for (const position of ['username', 'password']) {
      fs.writeFileSync(path.join(f.root, 'example.js'), mixedUri(escapedUriIntros[0], position === 'password' ? token : '', '%40', position === 'username' ? token : ''));
      assert.throws(() => captureSource(f.options), /Suspected secret/);
    }
  }
});

test('withholds credential-bearing URIs across protocols and userinfo encodings', t => {
  const f = fixture(t);
  const { credential, values } = credentialUris();
  for (const uri of values) {
    fs.writeFileSync(path.join(f.root, 'example.js'), `DATABASE_URL=${uri}\n`);
    assert.throws(() => createPacket(f.options), error => /Suspected secret/.test(error.message) && !error.message.includes(credential));
    assert.equal(fs.existsSync(f.options.out), false);
  }
  f.git(['commit', '-am', 'synthetic encoded URI baseline']);
  const base = f.git(['rev-parse', 'HEAD']).trim();
  fs.writeFileSync(path.join(f.root, 'example.js'), 'export const amount = 1;\n');
  assert.throws(() => createPacket({ ...f.options, base }), /Suspected secret in baseline source/);
});

test('withholds credential URIs from check output and metadata', t => {
  const f = fixture(t);
  const { metadata, metadataPath } = check(f);
  const { credential, values } = credentialUris();
  for (const [index, uri] of values.entries()) {
    fs.writeFileSync(metadata.outputFile, JSON.stringify({ database: uri }));
    assert.throws(() => createPacket({ ...f.options, phase: 'review', checks: [metadataPath] }), error => /Suspected secret/.test(error.message) && !error.message.includes(credential), `synthetic URI fixture ${index}`);
    assert.equal(fs.existsSync(f.options.out), false);
  }
  fs.writeFileSync(metadata.outputFile, 'safe synthetic check output\n');
  metadata.command = ['inspect ', values[2]].join('');
  fs.writeFileSync(metadataPath, JSON.stringify(metadata));
  assert.throws(() => createPacket({ ...f.options, phase: 'review', checks: [metadataPath] }), /Suspected secret in check metadata/);
});

test('withholds encoded credential URIs appearing only in cumulative diff metadata', t => {
  const f = fixture(t);
  const { credential } = credentialUris();
  const name = ['postgresql', '%3A%2F%2Ffixture-user%3A', credential, '%40db.example.invalid.txt'].join('');
  const filename = path.join(f.root, name);
  fs.writeFileSync(filename, 'safe baseline\n');
  f.git(['add', name]);
  f.git(['commit', '-m', 'synthetic encoded URI path']);
  const base = f.git(['rev-parse', 'HEAD']).trim();
  fs.writeFileSync(filename, 'safe current\n');
  assert.throws(() => createPacket({ ...f.options, base, files: ['example.js', name] }), error => /Suspected secret in cumulative diff/.test(error.message) && !error.message.includes(credential));
  assert.equal(fs.existsSync(f.options.out), false);
});

test('withholds credential URIs in omitted and untracked path errors without echoing them', t => {
  const f = fixture(t);
  const { credential } = credentialUris();
  const name = ['postgresql', '%3A%2F%2Ffixture-user%3A', credential, '%40db.example.invalid.txt'].join('');
  fs.writeFileSync(path.join(f.root, name), 'safe synthetic source\n');
  for (const files of [['example.js'], ['example.js', name]]) {
    assert.throws(() => createPacket({ ...f.options, files }), error => /Suspected secret/.test(error.message) && !error.message.includes(credential) && !error.message.includes(name));
  }
  assert.equal(fs.existsSync(f.options.out), false);
});

test('allows credential-free URIs and fails closed on ambiguous encoded userinfo', t => {
  const f = fixture(t);
  for (const uri of [['postgresql', '://db.example.invalid/fixture'].join(''),
    'https://docs.example.invalid/users/contact@example.invalid', 'https://docs.example.invalid/?email=contact@example.invalid',
    'https://docs.example.invalid/path?fixture=user:value@example.invalid', 'mailto:public-user@example.invalid']) {
    fs.writeFileSync(path.join(f.root, 'example.js'), `DATABASE_URL=${uri}\n`);
    assert.doesNotThrow(() => captureSource(f.options));
  }
  // Username-only or fully encoded ambiguous authorities are deliberately
  // rejected, never silently removed from an otherwise successful packet.
  const ambiguous = ['custom+db', '%3A%2F%2Fpublic-user%40db.example.invalid'].join('');
  fs.writeFileSync(path.join(f.root, 'example.js'), ambiguous);
  assert.throws(() => createPacket(f.options), /Suspected secret/);
  assert.equal(fs.existsSync(f.options.out), false);
});

test('scans bounded long scheme-like text without repeated suffix backtracking', { timeout: 10000 }, t => {
  const f = fixture(t);
  for (const value of ['x'.repeat(250000), 'a+.-'.repeat(62500), 'x%3a%2f%2f_'.repeat(20000),
    'x%3a%5c%2f%5c%2f_'.repeat(14000)]) {
    fs.writeFileSync(path.join(f.root, 'example.js'), value);
    assert.doesNotThrow(() => captureSource(f.options));
  }
});

test('refuses bare shortcut and Supabase secret credentials without an Authorization header', t => {
  const f = fixture(t);
  for (const credential of ['shiba_sc_' + 'b'.repeat(64), 'sb_secret_' + 'z'.repeat(32), 'npm_' + 'x'.repeat(32),
    ['//registry.npmjs.org/:_authToken', '=npm_', 'y'.repeat(32)].join(''), ['_authToken', '="npm_', 'z'.repeat(32), '"'].join('')]) {
    fs.writeFileSync(path.join(f.root, 'example.js'), credential);
    assert.throws(() => captureSource(f.options), error => /Suspected secret/.test(error.message) && !error.message.includes(credential));
    fs.writeFileSync(path.join(f.root, 'example.js'), 'export const amount = 1;\n');
  }
  for (const filename of ['.npmrc', '.npmrc.local']) {
    const protectedFile = path.join(f.root, filename);
    fs.writeFileSync(protectedFile, ['//registry.npmjs.org/:_authToken', '=npm_', 'q'.repeat(32), '\n'].join(''));
    f.git(['add', filename]);
    assert.throws(() => captureSource({ ...f.options, files: [filename] }), /Protected path/);
    assert.throws(() => captureSource(f.options), /INCOMPLETE.*protected/i);
    fs.rmSync(protectedFile);
    f.git(['reset', '--', filename]);
  }
  fs.writeFileSync(path.join(f.root, 'example.js'), ['_authToken', '=${NPM_TOKEN}\n'].join(''));
  assert.doesNotThrow(() => captureSource(f.options));
  assert.equal(fs.existsSync(f.options.out), false);
});

test('allows exact Supabase env references while rejecting malformed references and secret values', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, 'supabase'));
  const configFile = path.join(f.root, 'supabase', 'config.toml');
  const reference = 'env(SUPABASE_AUTH_EXTERNAL_APPLE_SECRET)';
  fs.writeFileSync(configFile, ['secret', ' = "', reference, '"\n'].join(''));
  f.git(['add', 'supabase/config.toml']);
  const options = { ...f.options, files: ['example.js', 'supabase/config.toml'] };
  const packet = createPacket(options);
  assert.equal(verifyPacket({ root: f.root, directory: packet.output }).valid, true);
  assert.ok(fs.readFileSync(path.join(packet.output, 'evidence.md'), 'utf8').includes(reference));
  for (const malformed of [
    'env(supabase_secret)', 'env(1INVALID_NAME)', 'ENV(SUPABASE_SECRET)',
    'prefixenv(SUPABASE_SECRET)', 'env(SUPABASE_SECRET)suffix',
    'env( SUPABASE_SECRET)', ['env(SUPABASE_SECRET', '=', 'actual)'].join(''), 'actual-secret-value-12345',
  ]) {
    fs.writeFileSync(configFile, ['secret', ' = "', malformed, '"\n'].join(''));
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
    ['POSTGRES_PASSWORD', '="', synthetic, '"'].join(''), ['SUPABASE_SERVICE_ROLE_KEY', "='", synthetic, "'"].join(''),
    ['STRIPE_SECRET_KEY', '=', synthetic].join(''), ['GOOGLE_CLIENT_SECRET', '="', synthetic, '"'].join(''),
    ['process.env.POSTGRES_PASSWORD', ' = "', synthetic, '"'].join(''), ['$env:POSTGRES_PASSWORD', ' = "', synthetic, '"'].join(''),
    JSON.stringify({ ['SUPABASE_SERVICE_ROLE_KEY']: synthetic }), ['databasePassword', ' = "', synthetic, '"'].join(''),
    ['message = "POSTGRES_PASSWORD', '=', synthetic, '"'].join(''), JSON.stringify({ message: ['SUPABASE_SECRET', '=', synthetic].join('') }),
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
  const assignment = ['POSTGRES_PASSWORD', '="', synthetic, '"\n'].join('');
  fs.writeFileSync(path.join(f.root, 'example.js'), assignment);
  f.git(['commit', '-am', 'synthetic historical credential']);
  const unsafeBase = f.git(['rev-parse', 'HEAD']).trim();
  fs.writeFileSync(path.join(f.root, 'example.js'), 'export const amount = 1;\n');
  assert.throws(() => createPacket({ ...f.options, base: unsafeBase }), error => /Suspected credential assignment/.test(error.message) && !error.message.includes(synthetic));
  f.git(['reset', f.options.base, '--', 'example.js']);
  const { metadata, metadataPath } = check(f);
  for (const output of [assignment, `+${assignment}`, ['$env:POSTGRES_PASSWORD', ' = "', synthetic, '"\n'].join('')]) {
    fs.writeFileSync(metadata.outputFile, output);
    assert.throws(() => createPacket({ ...f.options, phase: 'review', checks: [metadataPath] }), error => /Suspected credential assignment/.test(error.message) && !error.message.includes(synthetic));
  }
  fs.writeFileSync(metadata.outputFile, 'synthetic check complete\n');
  metadata.command = ['synthetic checker POSTGRES_PASSWORD', '=', synthetic].join('');
  fs.writeFileSync(metadataPath, JSON.stringify(metadata));
  assert.throws(() => createPacket({ ...f.options, phase: 'review', checks: [metadataPath] }), /Suspected credential assignment/);
  assert.equal(fs.existsSync(f.options.out), false);
});

test('allows prefixed credential env references and explicit placeholders', t => {
  const f = fixture(t);
  for (const reference of ['${POSTGRES_PASSWORD}', 'env(POSTGRES_PASSWORD)', '<redacted>', '[REDACTED]', 'example-password']) {
    fs.writeFileSync(path.join(f.root, 'example.js'), ['POSTGRES_PASSWORD', '="', reference, '"\n'].join(''));
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

function credentialExpressionFixtures() {
  const material = ['SYNTHETIC', 'LITERAL', 'ONLY', '0123456789'].join('_');
  const reference = '${DB_PASS}';
  const defaults = ['-', ':-', ':=', ':+'].map(operator => '${DB_PASS' + operator + material + '}');
  const envExpressions = [
    ...defaults.flatMap(body => [body, JSON.stringify(body), `'${body}'`, '`' + body + '`']),
    `${reference}${material}`, `"${reference}${material}"`, `"${reference}" + "${material}"`,
    `${reference} + ${material}`, `"${reference}"\n // synthetic comment\n + "${material}"`,
    `"env(DB_PASS)" + "${material}"`, `"<redacted>" || "${material}"`,
    `"example-password".concat("${material}")`, "'${db_pass}'",
    `"${reference}"\n /* synthetic comment */\n ?? "${material}"`,
    `"${reference}"\n${'// synthetic padding\n'.repeat(100)} + "${material}"`,
    ...['\r', '\u2028', '\u2029'].map(ending => `"${reference}" // synthetic comment${ending} + "${material}"`),
    '"${DB_PASS}"\n`SYNTHETIC_ONLY`',
    'env(DB_PASS)\n```\nSYNTHETIC_ONLY\n```\n;',
  ];
  const templateExpressions = [
    '`' + material + '`', '`short`', '`' + material + '\nsecond-line`',
    '`' + material + '${process.env.API_SECRET}`', '`' + '${process.env.API_SECRET}' + material + '`',
    '`' + '${process.env.API_SECRET || "' + material + '"}`',
    '`' + '${Deno.env.get("API_SECRET") ?? "' + material + '"}`',
    '`' + '${NOT_AN_ENV_READ}`', '`' + '\\${process.env.API_SECRET}`',
    '`' + '${process.env.API_SECRET}` + "' + material + '"',
    '`' + '${process.env.API_SECRET}`\n + "' + material + '"',
    '`' + material + '\\`suffix`',
    '`' + '\\u0024{process.env.API_SECRET}`',
  ];
  // Deliberately invalid base64 padding, not a usable Basic user:password pair.
  const token = 'A'.repeat(31) + '===';
  const assignments = envExpressions.map(expression => ['POSTGRES_PASSWORD', ' = ', expression].join(''));
  const templates = templateExpressions.map(expression => ['API_SECRET', ' = ', expression].join(''));
  const basics = [
    ['Authorization', ': Basic ', token].join(''),
    JSON.stringify({ ['Authorization']: `Basic ${token}` }),
    ['Proxy-Authorization', ' = "bAsIc\t', token, '"'].join(''),
    ['authorization', " = 'Basic ", token, "'"].join(''),
    ['Authorization', ' = `Basic ', token, '`'].join(''),
    JSON.stringify({ headers: { ['authorization']: `Basic\t${token}` } }),
    ['Authorization', ' = "Basic ${BASIC_AUTH:-', material, '}"'].join(''),
    ['Authorization', ' = `Basic ${process.env.BASIC_AUTH}', material, '`'].join(''),
    ['Authorization', ' = "Basic ${BASIC_AUTH}" + "', material, '"'].join(''),
    ['AUTHORIZATION', ': bAsIc ', token].join(''),
    JSON.stringify({ ['Authorization']: 'Basic\t' + token }).replace('Basic', '\\u0042asic'),
    ['Authorization', ' = "Basic ', token].join(''),
    ['Authorization', ' = `\\u0042asic ', token, '`'].join(''),
  ];
  return { material, token, assignments, templates, basics, values: [...assignments, ...templates, ...basics] };
}

test('rejects credential environment defaults and composed references as complete expressions', t => {
  const f = fixture(t);
  const { material, assignments } = credentialExpressionFixtures();
  for (const assignment of assignments) {
    fs.writeFileSync(path.join(f.root, 'example.js'), `${assignment}\n`);
    assert.throws(() => createPacket(f.options), error => /Suspected credential assignment/.test(error.message) && !error.message.includes(material));
    assert.equal(fs.existsSync(f.options.out), false);
  }
  fs.writeFileSync(path.join(f.root, 'example.js'), ['_authToken', ' = "${NPM_TOKEN:-', material, '}"\n'].join(''));
  assert.throws(() => captureSource(f.options), /Suspected credential assignment/);
});

test('preserves original credential literal boundaries with escaped keys and body delimiters', t => {
  const f = fixture(t);
  const safeSource = fs.readFileSync(path.join(f.root, 'example.js'));
  const { metadata, metadataPath } = check(f);
  const material = ['SYNTHETIC', 'BODY', 'ONLY'].join('_');
  const values = [
    ['{"API_\\u0053ECRET"', ':', '"${DB_PASS}\\u0022,\\u0022', material, '"}'].join(''),
    ['{"\\u0041uthorization"', ':', '"\\u0042asic ${BASIC_AUTH}\\u0022,\\u0022', material, '"}'].join(''),
    ['{"API_\\u0053ECRET"', ':', '"${DB_PASS}\\",\\"', material, '"}'].join(''),
  ];
  for (const value of values.flatMap(value => [value, JSON.stringify({ message: value })])) {
    fs.writeFileSync(path.join(f.root, 'example.js'), `${value}\n`);
    assert.throws(() => createPacket(f.options), error => /Suspected/.test(error.message) && !error.message.includes(material));
    assert.equal(fs.existsSync(f.options.out), false);
    fs.writeFileSync(path.join(f.root, 'example.js'), safeSource);
    fs.writeFileSync(metadata.outputFile, value);
    assert.throws(() => createPacket({ ...f.options, checks: [metadataPath] }), /Suspected/);
    fs.writeFileSync(metadata.outputFile, 'safe synthetic check\n');
    fs.writeFileSync(metadataPath, JSON.stringify({ ...metadata, command: value }));
    assert.throws(() => createPacket({ ...f.options, checks: [metadataPath] }), /Suspected/);
    fs.writeFileSync(metadataPath, JSON.stringify(metadata));
  }
});

test('rejects static and non-pure credential template literals without evaluating them', t => {
  const f = fixture(t);
  const { material, templates } = credentialExpressionFixtures();
  for (const assignment of templates) {
    fs.writeFileSync(path.join(f.root, 'example.js'), `${assignment}\n`);
    assert.throws(() => createPacket(f.options), error => /Suspected credential assignment/.test(error.message) && !error.message.includes(material));
    assert.equal(fs.existsSync(f.options.out), false);
  }
});

test('rejects Basic authorization bodies across raw quoted JSON and template fields', t => {
  const f = fixture(t);
  const { material, token, basics } = credentialExpressionFixtures();
  for (const assignment of basics) {
    fs.writeFileSync(path.join(f.root, 'example.js'), `${assignment}\n`);
    assert.throws(() => createPacket(f.options), error => /Suspected (?:credential assignment|Basic authorization)/.test(error.message)
      && !error.message.includes(material) && !error.message.includes(token));
    assert.equal(fs.existsSync(f.options.out), false);
  }
});

test('keeps complete environment references placeholders and dynamic non-Basic headers usable', t => {
  const f = fixture(t);
  const expressions = ['${DB_PASS}', '"${DB_PASS}"', "'${DB_PASS}'", 'env(DB_PASS)', '"env(DB_PASS)"',
    'process.env.DB_PASS;', "Deno.env.get('DB_PASS');", '"<redacted>"', '"[REDACTED]"', '"example-password"', '""',
    '`' + '${process.env.API_SECRET}`', '`' + "${Deno.env.get('API_SECRET')}`", 'true', 'false', 'null', 'undefined'];
  for (const expression of expressions) {
    fs.writeFileSync(path.join(f.root, 'example.js'), ['API_SECRET', ' = ', expression, '\n'].join(''));
    assert.doesNotThrow(() => captureSource(f.options));
  }
  for (const expression of ['tokenFromCaller', "request.headers.get('Authorization')", '"Public public-value"',
    '"Basic ${BASIC_AUTH}"', '`' + '${process.env.AUTHORIZATION}`', '`Basic ' + '${process.env.BASIC_AUTH}`']) {
    fs.writeFileSync(path.join(f.root, 'example.js'), ['Authorization', ' = ', expression, '\n'].join(''));
    assert.doesNotThrow(() => captureSource(f.options));
  }
});

test('does not grant typed-primitive exemptions to credential strings or Basic text', t => {
  const f = fixture(t);
  for (const body of ['true', 'false', 'null', 'undefined', '12345']) {
    const values = [
      ['API_SECRET', ' = "', body, '"'].join(''),
      ['API_SECRET', ' = `', body, '`'].join(''),
      ['Authorization', ': Basic ', body].join(''),
      ['API_SECRET', ' = ', body, ' || "SYNTHETIC_ONLY"'].join(''),
    ];
    if (body === '12345') values.push(['API_SECRET', ' = ', body].join(''));
    for (const value of values) {
      fs.writeFileSync(path.join(f.root, 'example.js'), `${value}\n`);
      assert.throws(() => captureSource(f.options), /Suspected/);
    }
  }
});

test('checks generated packet blocks independently while rejecting unsafe or unclosed blocks', t => {
  const f = fixture(t);
  const expressions = ['"${DB_PASS}"', '"env(DB_PASS)"', '`' + '${process.env.API_SECRET}`', 'false'];
  for (const [index, expression] of expressions.entries()) {
    fs.writeFileSync(path.join(f.root, 'example.js'), ['API_SECRET', ' = ', expression, '\n'].join(''));
    const packet = createPacket({ ...f.options, out: path.join(f.temp, `allowed-${index}`) });
    assert.equal(verifyPacket({ root: f.root, directory: packet.output }).valid, true);
    const filename = path.join(packet.output, 'evidence.md');
    const original = fs.readFileSync(filename);
    fs.appendFileSync(filename, ['\n```text\n', 'API_SECRET', ' = "SYNTHETIC_ONLY"\n```\n'].join(''));
    assert.throws(() => verifyPacket({ root: f.root, directory: packet.output }), /Suspected credential assignment/);
    fs.writeFileSync(filename, original);
    fs.appendFileSync(filename, '\n````text\nsafe synthetic block\n```\n');
    assert.throws(() => verifyPacket({ root: f.root, directory: packet.output }), /Unclosed evidence block/);
  }
});

test('withholds credential defaults templates and Basic bodies in logs and check metadata', t => {
  const f = fixture(t);
  const { metadata, metadataPath } = check(f);
  const { material, token, values } = credentialExpressionFixtures();
  for (const value of values) {
    fs.writeFileSync(metadata.outputFile, `${value}\n`);
    assert.throws(() => createPacket({ ...f.options, phase: 'review', checks: [metadataPath] }), error => /Suspected/.test(error.message)
      && !error.message.includes(material) && !error.message.includes(token));
    assert.equal(fs.existsSync(f.options.out), false);
    fs.writeFileSync(metadata.outputFile, 'safe synthetic check output\n');
    fs.writeFileSync(metadataPath, JSON.stringify({ ...metadata, command: value }));
    assert.throws(() => createPacket({ ...f.options, phase: 'review', checks: [metadataPath] }), error => /Suspected/.test(error.message)
      && !error.message.includes(material) && !error.message.includes(token));
    assert.equal(fs.existsSync(f.options.out), false);
    fs.writeFileSync(metadataPath, JSON.stringify(metadata));
  }
});

test('withholds credential expression regressions in pinned baselines and diff metadata', t => {
  const f = fixture(t);
  const { material, token, assignments, templates, basics } = credentialExpressionFixtures();
  for (const value of [assignments[0], templates[0], basics[0]]) {
    fs.writeFileSync(path.join(f.root, 'example.js'), value);
    f.git(['commit', '-am', 'synthetic credential expression baseline']);
    const base = f.git(['rev-parse', 'HEAD']).trim();
    fs.writeFileSync(path.join(f.root, 'example.js'), 'export const amount = 1;\n');
    assert.throws(() => createPacket({ ...f.options, base }), error => /Suspected/.test(error.message)
      && !error.message.includes(material) && !error.message.includes(token));
    assert.equal(fs.existsSync(f.options.out), false);
  }
  f.git(['commit', '-am', 'safe synthetic current and baseline']);
  for (const name of [['API_SECRET', '=', material, '.txt'].join(''), ['Authorization', '=Basic ', token, '.txt'].join('')]) {
    fs.writeFileSync(path.join(f.root, name), 'safe synthetic source\n');
    f.git(['add', name]);
    f.git(['commit', '-m', 'synthetic diff path']);
    const base = f.git(['rev-parse', 'HEAD']).trim();
    fs.writeFileSync(path.join(f.root, name), 'safe changed source\n');
    assert.throws(() => createPacket({ ...f.options, base, files: ['example.js', name] }), error => /Suspected.*cumulative diff/.test(error.message)
      && !error.message.includes(material) && !error.message.includes(token));
    f.git(['checkout', '--', name]);
  }
});

test('bounds repeated safe-reference scanning and fails closed on long ambiguous continuation', { timeout: 10000 }, t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'example.js'), ['API_SECRET', '="${DB_PASS}";\n'].join('').repeat(4000));
  assert.doesNotThrow(() => captureSource(f.options));
  fs.writeFileSync(path.join(f.root, 'example.js'), 'x' + '\\u0078'.repeat(20000));
  assert.doesNotThrow(() => captureSource(f.options));
  fs.writeFileSync(path.join(f.root, 'example.js'), ['API_SECRET', '="${DB_PASS}";'].join('').repeat(4000));
  assert.doesNotThrow(() => captureSource(f.options));
  fs.writeFileSync(path.join(f.root, 'example.js'), ['API_SECRET', '="${DB_PASS}"\n', '// synthetic comment\n'.repeat(100), ' + "SYNTHETIC_ONLY";\n'].join(''));
  assert.throws(() => createPacket(f.options), /Suspected credential assignment/);
  assert.equal(fs.existsSync(f.options.out), false);
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
  fs.writeFileSync(filename, lockfile.replace('"version": "1.0.0"', ['"POSTGRES_PASSWORD"', ': "', synthetic, '"'].join('')));
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

test('rejects unrepresented index blobs even when working bytes, status and cumulative diff remain the same', t => {
  const f = fixture(t);
  const filename = path.join(f.root, 'example.js');
  const packet = createPacket(f.options);
  let beforeStatus;
  for (const amount of [2, 3]) {
    fs.writeFileSync(filename, `export const amount = ${amount};\n`);
    f.git(['add', 'example.js']);
    fs.writeFileSync(filename, 'export const amount = 1;\n');
    const status = f.git(['status', '--porcelain=v1', '--untracked-files=no']);
    if (beforeStatus) assert.equal(status, beforeStatus);
    beforeStatus = status;
    assert.equal(f.git(['diff', f.options.base, '--', 'example.js']), '');
    assert.throws(() => captureSource(f.options), /Unrepresented index contents/);
    assert.throws(() => createPacket({ ...f.options, out: path.join(f.temp, `hidden-stage-${amount}`) }), /Unrepresented index contents/);
    assert.throws(() => verifyPacket({ root: f.root, directory: packet.output }), /Unrepresented index contents|Stale/);
  }
});

test('rejects hidden staged credentials and partial staging without publishing their contents', t => {
  const f = fixture(t);
  const { metadataPath } = check(f);
  const filename = path.join(f.root, 'example.js');
  const { values, credential } = credentialUris();
  for (const staged of [`DATABASE_URL=${values[2]}\n`, 'export const amount = 2;\n']) {
    fs.writeFileSync(filename, staged);
    f.git(['add', 'example.js']);
    for (const working of ['export const amount = 1;\n', 'export const amount = 3;\n']) {
      fs.writeFileSync(filename, working);
      assert.throws(() => createPacket(f.options), error => /Unrepresented index contents/.test(error.message) && !error.message.includes(credential));
      assert.throws(() => createPacket({ ...f.options, phase: 'review', checks: [metadataPath] }), /Unrepresented index contents/);
      assert.equal(fs.existsSync(f.options.out), false);
    }
  }
});

test('allows fully represented baseline or current index contents, including original BOM bytes', t => {
  const f = fixture(t);
  const filename = path.join(f.root, 'example.js');
  fs.writeFileSync(filename, 'export const amount = 2;\n');
  const unstaged = createPacket(f.options);
  assert.equal(verifyPacket({ root: f.root, directory: unstaged.output }).valid, true);
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('export const amount = 3;\n')]);
  fs.writeFileSync(filename, bom);
  f.git(['add', 'example.js']);
  const staged = createPacket({ ...f.options, out: path.join(f.temp, 'fully-staged') });
  assert.equal(verifyPacket({ root: f.root, directory: staged.output }).valid, true);
  f.git(['reset', '--', 'example.js']);
  assert.throws(() => verifyPacket({ root: f.root, directory: staged.output }), /Stale/);
});

test('rejects staged additions and deleted working files whose index content is unrepresented', t => {
  const f = fixture(t);
  const added = path.join(f.root, 'added.js');
  fs.writeFileSync(added, 'export const amount = 2;\n');
  f.git(['add', 'added.js']);
  fs.writeFileSync(added, 'export const amount = 3;\n');
  assert.throws(() => createPacket({ ...f.options, files: ['example.js', 'added.js'] }), /Unrepresented index contents/);
  f.git(['reset', '--', 'added.js']);
  fs.unlinkSync(added);
  fs.writeFileSync(path.join(f.root, 'example.js'), 'export const amount = 2;\n');
  f.git(['add', 'example.js']);
  fs.unlinkSync(path.join(f.root, 'example.js'));
  assert.throws(() => createPacket(f.options), /Unrepresented index contents/);
  assert.equal(fs.existsSync(f.options.out), false);
});

test('rejects normalized index bytes when actual current bytes and baseline do not represent them', t => {
  const f = fixture(t);
  const filename = path.join(f.root, 'example.js');
  fs.writeFileSync(filename, 'export const amount = 2;\n');
  f.git(['add', 'example.js']);
  f.git(['config', 'core.autocrlf', 'true']);
  fs.writeFileSync(filename, 'export const amount = 2;\r\n');
  assert.equal(f.git(['diff', '--', 'example.js']), '');
  assert.throws(() => createPacket(f.options), /Unrepresented index contents/);
  assert.equal(fs.existsSync(f.options.out), false);
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

test('rejects a third staged blob introduced during packet capture with unchanged worktree bytes', t => {
  const f = fixture(t);
  const { metadata, metadataPath } = check(f);
  const read = fs.readFileSync;
  const filename = path.join(f.root, 'example.js');
  t.mock.method(fs, 'readFileSync', function (file, ...args) {
    const bytes = read.call(fs, file, ...args);
    if (file === metadata.outputFile) {
      const original = read.call(fs, filename);
      fs.writeFileSync(filename, 'export const hidden = 2;\n');
      f.git(['add', 'example.js']);
      fs.writeFileSync(filename, original);
    }
    return bytes;
  });
  assert.throws(() => createPacket({ ...f.options, phase: 'review', checks: [metadataPath] }), /Unrepresented index contents/);
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
