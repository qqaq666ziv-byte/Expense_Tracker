#!/usr/bin/env node
// Install only after independent review and pinning; never bootstrap trust by
// executing this file from the contributor checkout under review.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const fail = message => { throw new Error(message); };
const samePath = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
const within = (root, candidate) => samePath(root, candidate) || (!path.relative(root, candidate).startsWith(`..${path.sep}`)
  && path.relative(root, candidate) !== '..' && !path.isAbsolute(path.relative(root, candidate)));

function absoluteWithoutLinks(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\x00-\x1f]/.test(value)) fail('An explicit absolute path is required.');
  const resolved = path.resolve(value);
  let cursor = path.parse(resolved).root;
  for (const part of resolved.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    if (fs.lstatSync(cursor).isSymbolicLink() || !samePath(fs.realpathSync(cursor), cursor)) fail('Trusted tool paths cannot contain links or junctions.');
  }
  return resolved;
}

export function runTrustedReviewPacket({ root, builder, expectedSha256, args = [] }) {
  root = absoluteWithoutLinks(root);
  builder = absoluteWithoutLinks(builder);
  if (!fs.statSync(root).isDirectory()) fail('Review root must be a directory.');
  if (within(root, builder)) fail('Use an independently installed builder outside the contributor checkout.');
  if (!/^[a-f0-9]{64}$/i.test(expectedSha256 ?? '')) fail('An independently recorded builder SHA-256 is required.');
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg === '--root' || arg.startsWith('--root='))) {
    fail('Pass builder arguments after --; the launcher supplies the review root.');
  }
  const stat = fs.lstatSync(builder);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 256 * 1024) fail('Unsafe or oversized installed builder.');
  const bytes = fs.readFileSync(builder);
  if (createHash('sha256').update(bytes).digest('hex') !== expectedSha256.toLowerCase()) fail('Installed builder does not match the independent SHA-256; no code executed.');

  // Execute the verified bytes, rather than reopening the candidate pathname.
  // The snapshot is outside the checkout and .mjs cannot load package hooks.
  const tempRoot = absoluteWithoutLinks(os.tmpdir());
  if (within(root, tempRoot)) fail('Trusted snapshot temporary directory must be outside the contributor checkout; no code executed.');
  const scratch = fs.mkdtempSync(path.join(tempRoot, 'trusted-review-builder-'));
  try {
    const snapshot = path.join(scratch, 'create-review-packet.mjs');
    fs.writeFileSync(snapshot, bytes, { flag: 'wx', mode: 0o600 });
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    delete env.NODE_PATH;
    return execFileSync(process.execPath, [snapshot, '--root', root, ...args], {
      cwd: scratch, env, encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && samePath(path.resolve(process.argv[1]), fileURLToPath(import.meta.url))) {
  try {
    const separator = process.argv.indexOf('--', 2);
    if (separator === -1) fail('Separate launcher options and builder arguments with --.');
    const { values } = parseArgs({ args: process.argv.slice(2, separator), options: {
      root: { type: 'string' }, builder: { type: 'string' }, sha256: { type: 'string' },
    } });
    process.stdout.write(runTrustedReviewPacket({ root: values.root, builder: values.builder,
      expectedSha256: values.sha256, args: process.argv.slice(separator + 1) }));
  } catch (error) {
    // Avoid forwarding evidence or child-process output on failure.
    process.stderr.write(`${error instanceof Error && !Object.hasOwn(error, 'stderr') ? error.message : 'Trusted builder failed; no packet accepted.'}\n`);
    process.exitCode = 1;
  }
}
