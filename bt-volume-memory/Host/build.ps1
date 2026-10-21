# ============================================================================
#  Build VolumeHelper.exe (net462) and place it next to VolumeHelper.cs.
#
#  Why net462: EchoMusic runs on Windows and every Win10/11 already ships the
#  .NET Framework 4.8 runtime, so the helper needs NO extra dependency on the
#  user's machine while staying tiny (tens of KB).
#
#  This file is deliberately ASCII-only: PowerShell 5.1 decodes .ps1 as ANSI
#  unless the file carries a UTF-8 BOM, so non-ASCII text here would become
#  mojibake. See AGENTS.md / the project notes for the .bat equivalent of this
#  trap (cmd.exe decodes batch files with the OEM code page).
#
#  Usage:  powershell -ExecutionPolicy Bypass -File build.ps1 [-Clean]
# ============================================================================

[CmdletBinding()]
param(
  [switch]$Clean
)

$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$proj = Join-Path $here 'VolumeHelper.csproj'
$destExe = Join-Path $here 'VolumeHelper.exe'

# Build artifacts must NOT land in Host\ -- publish.mjs mirrors the whole plugin
# directory to the public repo, so obj/ and bin/ would be published for real.
$tmpRoot = Join-Path $env:TEMP 'volume-helper-build'
$objDir = Join-Path $tmpRoot 'obj'
$binDir = Join-Path $tmpRoot 'bin'

function Find-DotNet {
  $cmd = Get-Command dotnet -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source) { return $cmd.Source }
  $candidates = @(
    (Join-Path $env:ProgramFiles 'dotnet\dotnet.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'dotnet\dotnet.exe')
  )
  foreach ($c in $candidates) { if ($c -and (Test-Path $c)) { return $c } }
  throw 'dotnet CLI not found. Install the .NET SDK, or build with MSBuild + the .NET Framework 4.6.2 targeting pack.'
}

if ($Clean -and (Test-Path $tmpRoot)) {
  Remove-Item -Recurse -Force $tmpRoot
}
New-Item -ItemType Directory -Force -Path $objDir, $binDir | Out-Null

$dotnet = Find-DotNet
Write-Host "[build] dotnet     : $dotnet"
Write-Host "[build] project    : $proj"

# Trailing separators matter for BaseIntermediateOutputPath/BaseOutputPath.
$objArg = '-p:BaseIntermediateOutputPath=' + $objDir + [IO.Path]::DirectorySeparatorChar
$binArg = '-p:BaseOutputPath=' + $binDir + [IO.Path]::DirectorySeparatorChar

& $dotnet build $proj -c Release --nologo -v minimal $objArg $binArg
if ($LASTEXITCODE -ne 0) { throw "dotnet build failed with exit code $LASTEXITCODE" }

$built = Join-Path $binDir 'Release\net462\VolumeHelper.exe'
if (-not (Test-Path $built)) { throw "Build reported success but $built is missing." }

Copy-Item -Force $built $destExe

$hash = (Get-FileHash -Algorithm SHA256 -Path $destExe).Hash.ToLowerInvariant()
$size = (Get-Item $destExe).Length
Write-Host ''
Write-Host "[ok] $destExe"
Write-Host "[ok] size   : $size bytes"
Write-Host "[ok] sha256 : $hash"
Write-Host ''
Write-Host 'Note: the host stores its launch consent keyed by plugin version + exe hash,'
Write-Host 'so a rebuilt helper asks the user for permission again on next launch.'
