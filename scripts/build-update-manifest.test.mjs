import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { buildUpdateManifest } from './build-update-manifest.mjs';

const bundles = {
  'linux-x86_64': 'Terra.AppImage',
  'windows-x86_64': 'Terra-setup.exe',
  'darwin-x86_64': 'Terra.app.tar.gz',
  'darwin-aarch64': 'Terra.app.tar.gz',
};
const execFileAsync = promisify(execFile);
const signature = (platform) => Buffer.from([
  'untrusted comment: signature from tauri secret key',
  Buffer.concat([Buffer.from('Ed'), Buffer.alloc(72)]).toString('base64'),
  `trusted comment: file:${platform}`,
  Buffer.alloc(64).toString('base64'),
  '',
].join('\n')).toString('base64');

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'terra-updater-test-'));
  const assetsDir = join(root, 'assets');
  const outputDir = join(root, 'publish');
  for (const [platform, name] of Object.entries(bundles)) {
    const dir = join(assetsDir, platform);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, name), platform);
    await writeFile(join(dir, `${name}.sig`), signature(platform));
  }
  await writeFile(join(assetsDir, 'linux-x86_64', 'Terra.deb'), 'package');
  await writeFile(join(assetsDir, 'linux-x86_64', 'Terra.deb.sig'), signature('linux-x86_64-deb'));
  return { assetsDir, outputDir };
}

test('builds a complete manifest with literal signatures and unique URLs', async () => {
  const { assetsDir, outputDir } = await fixture();
  await buildUpdateManifest({ version: '1.0.1', tag: 'v1.0.1', assetsDir, outputDir });
  const manifest = JSON.parse(await readFile(join(outputDir, 'terra-latest.json'), 'utf8'));
  assert.equal(manifest.version, '1.0.1');
  assert.deepEqual(Object.keys(manifest.platforms).sort(), [...Object.keys(bundles), 'linux-x86_64-deb'].sort());
  assert.equal(manifest.platforms['linux-x86_64-deb'].signature, signature('linux-x86_64-deb'));
  assert.equal(
    manifest.platforms['linux-x86_64-deb'].url,
    'https://github.com/nhridoy/terra-client/releases/download/v1.0.1/linux-x86_64-Terra.deb',
  );
  assert.equal(manifest.platforms['linux-x86_64'].signature, signature('linux-x86_64'));
  assert.equal(
    manifest.platforms['darwin-aarch64'].url,
    'https://github.com/nhridoy/terra-client/releases/download/v1.0.1/darwin-aarch64-Terra.app.tar.gz',
  );
});

test('rejects a missing required signature without publishing a manifest', async () => {
  const { assetsDir, outputDir } = await fixture();
  await writeFile(join(assetsDir, 'linux-x86_64', 'Terra.AppImage.sig'), '');
  await assert.rejects(
    buildUpdateManifest({ version: '1.0.1', tag: 'v1.0.1', assetsDir, outputDir }),
    /signature/i,
  );
  await assert.rejects(readFile(join(outputDir, 'terra-latest.json')));
});

test('rejects a .deb without a signature so .deb installs never get an unsigned update', async () => {
  const { assetsDir, outputDir } = await fixture();
  await writeFile(join(assetsDir, 'linux-x86_64', 'Terra.deb.sig'), '');
  await assert.rejects(
    buildUpdateManifest({ version: '1.0.1', tag: 'v1.0.1', assetsDir, outputDir }),
    /signature/i,
  );
});

test('rejects non-minisign text and truncated base64 signatures', async () => {
  const { assetsDir, outputDir } = await fixture();
  const path = join(assetsDir, 'linux-x86_64', 'Terra.AppImage.sig');
  await writeFile(path, 'not a signature');
  await assert.rejects(
    buildUpdateManifest({ version: '1.0.1', tag: 'v1.0.1', assetsDir, outputDir }),
    /signature/i,
  );
  await writeFile(path, Buffer.from('untrusted comment: x\nabc').toString('base64'));
  await assert.rejects(
    buildUpdateManifest({ version: '1.0.1', tag: 'v1.0.1', assetsDir, outputDir }),
    /signature/i,
  );
});

test('rejects a missing platform and tag/version mismatch', async () => {
  const { assetsDir, outputDir } = await fixture();
  await assert.rejects(
    buildUpdateManifest({ version: '1.0.1', tag: 'v1.0.2', assetsDir, outputDir }),
    /version/i,
  );
  await assert.rejects(
    buildUpdateManifest({ version: '1.0.1', tag: 'v1.0.1', assetsDir: join(assetsDir, 'linux-x86_64'), outputDir }),
    /missing/i,
  );
});

test('CLI creates the manifest when invoked by a relative script path', async () => {
  const { assetsDir, outputDir } = await fixture();
  const notesFile = join(assetsDir, 'release-notes.md');
  await writeFile(notesFile, 'Fixed terminal rendering.\n');
  await execFileAsync(process.execPath, [
    'scripts/build-update-manifest.mjs',
    '--version', '1.0.1', '--tag', 'v1.0.1',
    '--assets', assetsDir, '--output', outputDir, '--notes-file', notesFile,
  ], { cwd: new URL('..', import.meta.url) });
  const manifest = JSON.parse(await readFile(join(outputDir, 'terra-latest.json'), 'utf8'));
  assert.equal(manifest.version, '1.0.1');
  assert.equal(manifest.notes, 'Fixed terminal rendering.\n');
});

test('stages distributable bundles but excludes unpacked app internals', async () => {
  const { assetsDir, outputDir } = await fixture();
  const appInternal = join(assetsDir, 'darwin-x86_64', 'Terra.app', 'Contents', 'MacOS');
  await mkdir(appInternal, { recursive: true });
  await writeFile(join(appInternal, 'Terra'), 'binary');
  await writeFile(join(assetsDir, 'linux-x86_64', 'Terra.deb'), 'package');
  await buildUpdateManifest({ version: '1.0.1', tag: 'v1.0.1', assetsDir, outputDir });
  const published = await readdir(outputDir);
  assert.ok(published.includes('linux-x86_64-Terra.deb'));
  assert.ok(!published.includes('darwin-x86_64-Terra'));
});
