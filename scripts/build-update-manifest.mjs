import { execFile } from 'node:child_process';
import { copyFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';

const REPOSITORY = 'nhridoy/terra-client';
const execFileAsync = promisify(execFile);
// [manifest key, artifact directory, bundle extension]. The updater looks up
// `{os}-{arch}-{bundle_type}` first, so .deb installs get their own entry.
const REQUIRED = [
  ['linux-x86_64', 'linux-x86_64', '.AppImage'],
  ['linux-x86_64-deb', 'linux-x86_64', '.deb'],
  ['linux-aarch64', 'linux-aarch64', '.AppImage'],
  ['linux-aarch64-deb', 'linux-aarch64', '.deb'],
  ['windows-x86_64', 'windows-x86_64', '.exe'],
  ['windows-aarch64', 'windows-aarch64', '.exe'],
  ['darwin-x86_64', 'darwin-x86_64', '.app.tar.gz'],
  ['darwin-aarch64', 'darwin-aarch64', '.app.tar.gz'],
];
// Download names people recognise ("Apple Silicon", not "darwin-aarch64").
const LABELS = {
  'linux-x86_64': 'Linux-x64',
  'linux-aarch64': 'Linux-ARM64',
  'windows-x86_64': 'Windows-x64',
  'windows-aarch64': 'Windows-ARM64',
  'darwin-x86_64': 'macOS-Intel',
  'darwin-aarch64': 'macOS-Apple-Silicon',
};

async function filesUnder(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function decodeBase64(value, expectedLength) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error('invalid signature base64');
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== expectedLength || decoded.toString('base64') !== value)
    throw new Error('invalid signature length');
  return decoded;
}

function decodeSignature(signature) {
  const encoded = signature.trim();
  const decoded = Buffer.from(encoded, 'base64');
  if (!encoded || decoded.toString('base64') !== encoded)
    throw new Error('invalid updater signature encoding');
  const lines = decoded.toString('utf8').trimEnd().split('\n');
  if (lines.length !== 4 || !lines[0].startsWith('untrusted comment: ') || !lines[2].startsWith('trusted comment: '))
    throw new Error('invalid minisign signature format');
  const signatureBytes = decodeBase64(lines[1], 74);
  if (!['ED', 'Ed'].includes(signatureBytes.subarray(0, 2).toString()))
    throw new Error('invalid minisign signature algorithm');
  decodeBase64(lines[3], 64);
  return decoded;
}

async function verifyWithMinisign(bundle, signatureBytes, publicKey) {
  const temporary = await mkdtemp(join(tmpdir(), 'terra-update-verify-'));
  try {
    const keyPath = join(temporary, 'updater.pub');
    const signaturePath = join(temporary, 'artifact.minisig');
    await writeFile(keyPath, Buffer.from(publicKey, 'base64'));
    await writeFile(signaturePath, signatureBytes);
    await execFileAsync('minisign', ['-Vm', bundle, '-p', keyPath, '-x', signaturePath]);
  } catch (error) {
    throw new Error(`updater signature verification failed for ${basename(bundle)}: ${error.message}`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function buildUpdateManifest({ version, tag, assetsDir, outputDir, notes = '', publicKey = null }) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) || tag !== `v${version}`)
    throw new Error('release tag/version mismatch');
  const platforms = {};
  const staged = [];
  for (const [platform, dirName, extension] of REQUIRED) {
    const dir = join(assetsDir, dirName);
    let files;
    try {
      files = await filesUnder(dir);
    } catch {
      throw new Error(`missing ${platform} artifacts`);
    }
    const bundles = files.filter((path) => path.endsWith(extension) && !path.endsWith('.sig'));
    if (bundles.length !== 1) throw new Error(`missing or ambiguous ${platform} bundle`);
    const bundle = bundles[0];
    const signatureFile = `${bundle}.sig`;
    if (!files.includes(signatureFile)) throw new Error(`missing ${platform} signature`);
    const signature = (await readFile(signatureFile, 'utf8')).trim();
    const signatureBytes = decodeSignature(signature);
    if (publicKey) await verifyWithMinisign(bundle, signatureBytes, publicKey);
    const assetName = `Terra-${version}-${LABELS[dirName]}${extension === '.exe' ? '-Setup.exe' : extension}`;
    platforms[platform] = {
      signature,
      url: `https://github.com/${REPOSITORY}/releases/download/${tag}/${encodeURIComponent(assetName)}`,
    };
    staged.push({ source: bundle, destination: assetName });
    staged.push({ source: signatureFile, destination: `${assetName}.sig` });
    if (dirName.startsWith('darwin-'))
      for (const path of files.filter((file) => file.endsWith('.dmg')))
        staged.push({ source: path, destination: `Terra-${version}-${LABELS[dirName]}.dmg` });
  }
  const names = staged.map((asset) => asset.destination);
  if (new Set(names).size !== names.length) throw new Error('duplicate release asset name');
  await mkdir(outputDir, { recursive: true });
  for (const asset of staged) await copyFile(asset.source, join(outputDir, asset.destination));
  const manifest = {
    version,
    notes,
    pub_date: new Date().toISOString(),
    platforms,
  };
  const temporary = join(outputDir, '.terra-latest.json.tmp');
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`);
  await rename(temporary, join(outputDir, 'terra-latest.json'));
  return manifest;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = Object.fromEntries(
    process.argv.slice(2).reduce((pairs, value, index, values) => {
      if (index % 2 === 0) pairs.push([value.replace(/^--/, ''), values[index + 1]]);
      return pairs;
    }, []),
  );
  if (!args.version || !args.tag || !args.assets || !args.output)
    throw new Error('usage: node build-update-manifest.mjs --version V --tag vV --assets DIR --output DIR');
  const updaterConfig = args['pubkey-config']
    ? JSON.parse(await readFile(args['pubkey-config'], 'utf8'))
    : null;
  await buildUpdateManifest({
    version: args.version,
    tag: args.tag,
    assetsDir: args.assets,
    outputDir: args.output,
    notes: args['notes-file'] ? await readFile(args['notes-file'], 'utf8') : (args.notes ?? ''),
    publicKey: updaterConfig?.plugins?.updater?.pubkey ?? null,
  });
}
