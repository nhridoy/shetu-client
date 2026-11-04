import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const script = new URL('../install.sh', import.meta.url).pathname;
const base = 'https://example.test/Terra-1.0.0';
const manifest = JSON.stringify({
  platforms: Object.fromEntries(
    ['macOS-Intel.app.tar.gz', 'macOS-Apple-Silicon.app.tar.gz', 'Linux-x64.AppImage', 'Linux-x64.deb',
      'Linux-ARM64.AppImage', 'Linux-ARM64.deb'].map((name) => [name, { url: `${base}-${name}` }]),
  ),
});
// Real tools the script needs; everything else on PATH is a stub.
const tools = ['cat', 'chmod', 'cp', 'grep', 'gzip', 'head', 'id', 'mkdir', 'mktemp', 'mv', 'rm', 'tar'];

// Runs install.sh against stubbed uname/sysctl/curl/apt-get so it can be tested anywhere.
async function run({ os = 'Darwin', arch = 'arm64', translated = '0', apt = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'terra-install-test-'));
  const bin = join(root, 'bin');
  const dest = join(root, 'dest');
  await mkdir(join(root, 'Terra.app', 'Contents'), { recursive: true });
  await writeFile(join(root, 'Terra.app', 'Contents', 'Info.plist'), 'new');
  await execFileAsync('tar', ['-czf', join(root, 'download'), '-C', root, 'Terra.app']);
  await mkdir(join(dest, 'Terra.app'), { recursive: true });
  await writeFile(join(dest, 'Terra.app', 'old'), 'old');
  await writeFile(join(root, 'manifest.json'), manifest);
  await mkdir(bin);
  for (const tool of tools)
    await symlink(execFileSync('sh', ['-c', `command -v ${tool}`]).toString().trim(), join(bin, tool));
  const stubs = {
    uname: `[ "$1" = -s ] && echo ${os} || echo ${arch}`,
    sysctl: `echo ${translated}`,
    sudo: `echo "sudo $*" >> '${root}/log'; exec "$@"`,
    curl: `echo "curl $*" >> '${root}/log'
case "$*" in *terra-latest.json*) cat '${root}/manifest.json'; exit ;; esac
while [ $# -gt 0 ]; do [ "$1" = -o ] && cp '${root}/download' "$2"; shift; done`,
    ...(apt ? { 'apt-get': `echo "apt-get $*" >> '${root}/log'` } : {}),
  };
  for (const [name, body] of Object.entries(stubs)) {
    await writeFile(join(bin, name), `#!/bin/sh\n${body}\n`);
    await chmod(join(bin, name), 0o755);
  }
  const env = { PATH: bin, HOME: root, TERRA_INSTALL_DIR: dest };
  const result = await execFileAsync(process.env.BASH ?? '/bin/bash', [script], { env }).catch((error) => error);
  const log = await readFile(join(root, 'log'), 'utf8').catch(() => '');
  return { result, dest, log };
}

test('macOS: installs the Apple Silicon build and replaces an existing copy', async () => {
  const { result, dest, log } = await run();
  assert.equal(result.code ?? 0, 0, result.stderr);
  assert.match(log, /macOS-Apple-Silicon\.app\.tar\.gz/);
  assert.equal(await readFile(join(dest, 'Terra.app', 'Contents', 'Info.plist'), 'utf8'), 'new');
  await assert.rejects(readFile(join(dest, 'Terra.app', 'old')));
});

test('macOS: installs the Intel build on Intel Macs', async () => {
  const { log } = await run({ arch: 'x86_64' });
  assert.match(log, /macOS-Intel\.app\.tar\.gz/);
});

test('macOS: picks Apple Silicon when the shell runs under Rosetta', async () => {
  const { log } = await run({ arch: 'x86_64', translated: '1' });
  assert.match(log, /macOS-Apple-Silicon\.app\.tar\.gz/);
});

test('Linux with apt: installs the .deb for the CPU through apt-get', async () => {
  const { result, log } = await run({ os: 'Linux', arch: 'aarch64', apt: true });
  assert.equal(result.code ?? 0, 0, result.stderr);
  assert.match(log, /curl .*Linux-ARM64\.deb/);
  assert.match(log, /apt-get install -y .*terra\.deb/);
});

test('Linux without apt: installs the AppImage as an executable', async () => {
  const { result, dest, log } = await run({ os: 'Linux', arch: 'x86_64' });
  assert.equal(result.code ?? 0, 0, result.stderr);
  assert.match(log, /curl .*Linux-x64\.AppImage/);
  execFileSync('test', ['-x', join(dest, 'terra')]);
});

test('refuses to run on other systems and unsupported CPUs', async () => {
  for (const options of [{ os: 'FreeBSD' }, { os: 'Linux', arch: 'riscv64' }]) {
    const { result, log } = await run(options);
    assert.notEqual(result.code ?? 0, 0);
    assert.equal(log, '');
  }
});
