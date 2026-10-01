# Forward Email for the terminal: installer for Windows.
#
#   irm https://github.com/forwardemail/mail.forwardemail.net/releases/latest/download/install.ps1 | iex
#
# Downloads the standalone forwardemail.exe for this machine from the latest
# GitHub release, checks it against the release's SHA256SUMS.txt, installs it
# to %LOCALAPPDATA%\Programs\forwardemail (where it can update itself) and
# adds that folder to your PATH.
#
# Environment:
#   FORWARDEMAIL_VERSION      install this version (e.g. 0.15.0) instead of the latest
#   FORWARDEMAIL_INSTALL_DIR  install here instead of %LOCALAPPDATA%\Programs\forwardemail
#
# https://github.com/forwardemail/mail.forwardemail.net/blob/main/docs/CLI.md

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Repository = 'forwardemail/mail.forwardemail.net'
$Version = if ($env:FORWARDEMAIL_VERSION) { $env:FORWARDEMAIL_VERSION.TrimStart('v') } else { 'latest' }
$InstallDir = if ($env:FORWARDEMAIL_INSTALL_DIR) { $env:FORWARDEMAIL_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\forwardemail' }

$Arch = switch ($env:PROCESSOR_ARCHITECTURE) {
  'AMD64' { 'x64' }
  'ARM64' { 'arm64' }
  default { throw "Unsupported CPU $($env:PROCESSOR_ARCHITECTURE); install with npm instead: npm install -g forwardemail" }
}

$Asset = "forwardemail-win-$Arch.exe.gz"
$Base = if ($Version -eq 'latest') {
  "https://github.com/$Repository/releases/latest/download"
} else {
  "https://github.com/$Repository/releases/download/v$Version"
}

$Temp = Join-Path ([IO.Path]::GetTempPath()) ("forwardemail-" + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $Temp | Out-Null
try {
  Write-Host "Downloading $Asset ($Version)..."
  $Compressed = Join-Path $Temp $Asset
  $Sums = Join-Path $Temp 'SHA256SUMS.txt'
  Invoke-WebRequest -UseBasicParsing -Uri "$Base/$Asset" -OutFile $Compressed
  Invoke-WebRequest -UseBasicParsing -Uri "$Base/SHA256SUMS.txt" -OutFile $Sums

  $Expected = $null
  foreach ($Line in Get-Content $Sums) {
    $Parts = $Line -split '\s+', 2
    if ($Parts.Count -eq 2 -and $Parts[1].TrimStart('*') -eq $Asset) { $Expected = $Parts[0].ToLower() }
  }
  if (-not $Expected) { throw "SHA256SUMS.txt does not list $Asset" }
  $Actual = (Get-FileHash -Algorithm SHA256 -Path $Compressed).Hash.ToLower()
  if ($Actual -ne $Expected) { throw "Checksum mismatch for $Asset (expected $Expected, got $Actual)" }

  $Exe = Join-Path $Temp 'forwardemail.exe'
  $In = [IO.File]::OpenRead($Compressed)
  try {
    $Gzip = New-Object IO.Compression.GZipStream($In, [IO.Compression.CompressionMode]::Decompress)
    $Out = [IO.File]::Create($Exe)
    try { $Gzip.CopyTo($Out) } finally { $Out.Dispose(); $Gzip.Dispose() }
  } finally { $In.Dispose() }

  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  $Target = Join-Path $InstallDir 'forwardemail.exe'
  # A running copy cannot be overwritten, but it can be renamed out of the way.
  if (Test-Path $Target) {
    Remove-Item -Force -ErrorAction SilentlyContinue "$Target.old"
    Rename-Item -Path $Target -NewName 'forwardemail.exe.old'
  }
  Move-Item -Force -Path $Exe -Destination $Target
} finally {
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $Temp
}

$UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not (($UserPath -split ';') -contains $InstallDir)) {
  $NewPath = if ($UserPath) { "$UserPath;$InstallDir" } else { $InstallDir }
  [Environment]::SetEnvironmentVariable('Path', $NewPath, 'User')
  $env:Path = "$env:Path;$InstallDir"
  Write-Host "Added $InstallDir to your PATH (new terminals will pick it up)."
}

$Installed = & $Target --version
Write-Host "Installed Forward Email $Installed to $Target"
Write-Host 'Run: forwardemail'
