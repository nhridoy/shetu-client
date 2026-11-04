import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const script = new URL('../install.ps1', import.meta.url).pathname;
let pwsh = true;
try {
  execFileSync('pwsh', ['-Version']);
} catch {
  pwsh = false;
}
const manifest = JSON.stringify({
  platforms: {
    'windows-x86_64': { url: 'https://example.test/Terra-1.0.0-Windows-x64-Setup.exe' },
    'windows-aarch64': { url: 'https://example.test/Terra-1.0.0-Windows-ARM64-Setup.exe' },
  },
});

// Functions shadow cmdlets in PowerShell, so the script runs without network or a real installer.
async function run(exitCode) {
  const log = join(await mkdtemp(join(tmpdir(), 'terra-install-ps-')), 'log');
  const command = `
function Invoke-WebRequest { param([switch]$UseBasicParsing, [Parameter(Position = 0)]$Uri, $OutFile)
  Add-Content '${log}' "download $Uri"
  if ($OutFile) { Set-Content $OutFile 'exe' } else { [pscustomobject]@{ Content = '${manifest}' } } }
function Start-Process { param($FilePath, $ArgumentList, [switch]$Wait, [switch]$PassThru)
  Add-Content '${log}' "run $FilePath $ArgumentList"; [pscustomobject]@{ ExitCode = ${exitCode} } }
. '${script}'`;
  const result = await execFileAsync('pwsh', ['-NoProfile', '-Command', command]).catch((error) => error);
  return { result, log: await readFile(log, 'utf8') };
}

test('Windows: downloads the installer for this CPU and runs it silently', { skip: !pwsh && !process.env.CI && 'pwsh not installed' }, async () => {
  const { result, log } = await run(0);
  assert.equal(result.code ?? 0, 0, result.stderr);
  const arch = process.arch === 'arm64' ? 'ARM64' : 'x64';
  assert.match(log, new RegExp(`download https://example\\.test/Terra-1\\.0\\.0-Windows-${arch}-Setup\\.exe`));
  assert.match(log, new RegExp(`run .*Terra-Windows-${arch}-Setup\\.exe /S`));
});

test('Windows: fails when the installer fails', { skip: !pwsh && !process.env.CI && 'pwsh not installed' }, async () => {
  const { result } = await run(2);
  assert.notEqual(result.code ?? 0, 0);
  assert.match(result.stderr, /exited with code 2/);
});
