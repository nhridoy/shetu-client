import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const script = new URL('../install.sh', import.meta.url).pathname;
const manifest = JSON.stringify({
  platforms: {
    'darwin-x86_64': { url: 'https://example.test/Terra-1.0.0-macOS-Intel.app.tar.gz' },
    'darwin-aarch64': { url: 'https://example.test/Terra-1.0.0-macOS-Apple-Silicon.app.tar.gz' },
  },
});

// Runs install.sh against stubbed uname/sysctl/curl so it can be tested off a Mac.
async function run({ os = 'Darwin', arch = 'arm64', translated = '0' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'terra-install-test-'));
  const bin = join(root, 'bin');
  const apps = join(root, 'Applications');
  await mkdir(join(root, 'Terra.app', 'Contents'), { recursive: true });
  await writeFile(join(root, 'Terra.app', 'Contents', 'Info.plist'), 'new');
  await execFileAsync('tar', ['-czf', join(root, 'app.tar.gz'), '-C', root, 'Terra.app']);
  await mkdir(join(apps, 'Terra.app'), { recursive: true });
  await writeFile(join(apps, 'Terra.app', 'old'), 'old');
  await writeFile(join(root, 'manifest.json'), manifest);
  await mkdir(bin);
  const stubs = {
    uname: `[ "$1" = -s ] && echo ${os} || echo ${arch}`,
    sysctl: `echo ${translated}`,
    curl: `echo "$@" >> '${root}/curl.log'
case "$*" in *terra-latest.json*) cat '${root}/manifest.json' ;; *) cat '${root}/app.tar.gz' ;; esac`,
  };
  for (const [name, body] of Object.entries(stubs)) {
    await writeFile(join(bin, name), `#!/bin/sh\n${body}\n`);
    await chmod(join(bin, name), 0o755);
  }
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TERRA_INSTALL_DIR: apps };
  const result = await execFileAsync('bash', [script], { env }).catch((error) => error);
  const curlLog = await readFile(join(root, 'curl.log'), 'utf8').catch(() => '');
  return { result, apps, curlLog };
}

test('installs the Apple Silicon build and replaces an existing copy', async () => {
  const { result, apps, curlLog } = await run();
  assert.equal(result.code ?? 0, 0, result.stderr);
  assert.match(curlLog, /macOS-Apple-Silicon\.app\.tar\.gz/);
  assert.equal(await readFile(join(apps, 'Terra.app', 'Contents', 'Info.plist'), 'utf8'), 'new');
  await assert.rejects(readFile(join(apps, 'Terra.app', 'old')));
});

test('installs the Intel build on Intel Macs', async () => {
  const { curlLog } = await run({ arch: 'x86_64' });
  assert.match(curlLog, /macOS-Intel\.app\.tar\.gz/);
});

test('picks Apple Silicon when the shell runs under Rosetta', async () => {
  const { curlLog } = await run({ arch: 'x86_64', translated: '1' });
  assert.match(curlLog, /macOS-Apple-Silicon\.app\.tar\.gz/);
});

test('refuses to run outside macOS', async () => {
  const { result, curlLog } = await run({ os: 'Linux' });
  assert.notEqual(result.code ?? 0, 0);
  assert.equal(curlLog, '');
});
