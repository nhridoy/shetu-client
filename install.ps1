# Installs the latest Terra on Windows. In PowerShell:
#   irm https://raw.githubusercontent.com/nhridoy/terra-client/main/install.ps1 | iex
# PowerShell downloads carry no "downloaded from the internet" mark, so SmartScreen
# does not stop the unsigned installer the way it does for a browser download.
# Runs in a child scope so the preferences below don't leak into the user's session.
& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue' # the progress bar makes downloads very slow in Windows PowerShell 5.1

  $platform, $arch = switch ([string][System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture) {
    'X64' { 'windows-x86_64', 'x64' }
    'Arm64' { 'windows-aarch64', 'ARM64' }
    default { throw "Terra install failed: no Windows build for $_ CPUs" }
  }
  # GitHub serves the manifest as application/octet-stream, so Content arrives as bytes.
  $content = (Invoke-WebRequest -UseBasicParsing 'https://github.com/nhridoy/terra-client/releases/latest/download/terra-latest.json').Content
  if ($content -is [byte[]]) { $content = [System.Text.Encoding]::UTF8.GetString($content) }
  $manifest = $content | ConvertFrom-Json
  $url = [string]$manifest.platforms.$platform.url
  if (-not $url.StartsWith('https://github.com/nhridoy/terra-client/releases/download/')) {
    throw "Terra install failed: no Windows $arch build in the latest release"
  }

  $installer = Join-Path ([System.IO.Path]::GetTempPath()) "Terra-Setup-$([guid]::NewGuid()).exe"
  Write-Host "Downloading Terra (Windows $arch)..."
  try {
    Invoke-WebRequest -UseBasicParsing $url -OutFile $installer
    $process = Start-Process -FilePath $installer -ArgumentList '/S' -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "Terra install failed: installer exited with code $($process.ExitCode)" }
  } finally {
    Remove-Item $installer -ErrorAction SilentlyContinue
  }
  Write-Host 'Terra installed. Open it from the Start menu.'
}
