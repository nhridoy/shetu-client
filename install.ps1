# Installs the latest Terra on Windows. In PowerShell:
#   irm https://raw.githubusercontent.com/nhridoy/terra-client/main/install.ps1 | iex
# PowerShell downloads carry no "downloaded from the internet" mark, so SmartScreen
# does not stop the unsigned installer the way it does for a browser download.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # the progress bar makes downloads very slow in Windows PowerShell 5.1

$arch = if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq 'Arm64') { 'ARM64' } else { 'x64' }
$manifest = Invoke-WebRequest -UseBasicParsing 'https://github.com/nhridoy/terra-client/releases/latest/download/terra-latest.json'
$url = ([regex]::Match([string]$manifest.Content, "https://[^`"]*-Windows-$arch-Setup\.exe")).Value
if (-not $url) { throw "Terra install failed: no Windows $arch build in the latest release" }

$installer = Join-Path ([System.IO.Path]::GetTempPath()) "Terra-Windows-$arch-Setup.exe"
Write-Host "Downloading Terra (Windows $arch)..."
Invoke-WebRequest -UseBasicParsing $url -OutFile $installer
try {
  $process = Start-Process -FilePath $installer -ArgumentList '/S' -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw "Terra install failed: installer exited with code $($process.ExitCode)" }
} finally {
  Remove-Item $installer -ErrorAction SilentlyContinue
}
Write-Host 'Terra installed. Open it from the Start menu.'
