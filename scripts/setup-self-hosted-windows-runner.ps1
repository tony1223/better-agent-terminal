<#
.SYNOPSIS
  Turns a Windows machine into a self-hosted GitHub Actions runner that can build
  this repo's Tauri release bundle.

.DESCRIPTION
  Windows is the release critical path. On v3.1.53 the Windows leg took 7.1 min
  against macOS's 4.6, and most of the gap is work a reused machine would not
  repeat: `Setup Rust` 39s (macOS: 8s), `Cache Rust build outputs` 25s (macOS:
  8s), and ~130s of cargo. The lever is not more cores or fewer lines — measured
  locally, the whole 34k-line crate front-ends in 4.5s and -j 1/2/4/8/16 spans
  only 184/170/153/163/170s. It is keeping src-tauri/target between runs so
  CARGO_INCREMENTAL can cache at codegen-unit level inside our crate: 196.9s cold
  -> 10.3-12.8s warm.

  GitHub's hosted runners cannot do that (a fresh VM every time, and
  Swatinem/rust-cache strips incremental/ before saving), which is the entire
  reason this script exists.

  What the release workflow installs for itself, and this script therefore does
  NOT: Rust (dtolnay/rust-toolchain), Node (actions/setup-node), pnpm
  (pnpm/action-setup). All three work unchanged on a self-hosted runner.

  What no action can install, and this script therefore must:
    - Git for Windows      many workflow steps use `shell: bash`
    - VS Build Tools       link.exe + Windows SDK for the msvc target
    - long path support    deep cargo paths blow past MAX_PATH otherwise
    - Defender exclusion   real-time scanning of target/ dominates Windows builds
    - the runner itself, as a service so it survives reboots

.PARAMETER Token
  A runner registration token. Short-lived (about one hour), so mint it right
  before running this:

    gh api --method POST repos/<owner>/<repo>/actions/runners/registration-token --jq .token

.PARAMETER Repo
  owner/repo to register against.

.PARAMETER RunnerDir
  Where the runner is installed. Defaults to C:\runner.

.PARAMETER Labels
  Extra labels beyond the automatic self-hosted/Windows/X64. The release workflow
  matches on whatever you put in the WIN_RUNNER_LABELS repo variable.

.PARAMETER ServiceAccount
  Windows account the runner service logs on as. Defaults to the current user,
  because a real user profile is the path of least surprise for rustup, cargo and
  %LOCALAPPDATA%\tauri. Prompts for the password unless -UseNetworkService.

.PARAMETER UseNetworkService
  Run the service as NT AUTHORITY\NETWORK SERVICE instead, with no password.

.EXAMPLE
  .\setup-self-hosted-windows-runner.ps1 -Repo tony1223/better-agent-terminal -Token AXXX...
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Repo,
  [string]$Token,
  [string]$RunnerDir = 'C:\runner',
  [string[]]$Labels = @('bat-win'),
  [string]$ServiceAccount = "$env:USERDOMAIN\$env:USERNAME",
  [System.Security.SecureString]$ServicePassword,
  [switch]$UseNetworkService,
  [switch]$SkipBuildTools
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Step([string]$m) { Write-Host "`n=== $m ===" -ForegroundColor Cyan }
function Ok([string]$m)   { Write-Host "  [ok]   $m" -ForegroundColor Green }
function Info([string]$m) { Write-Host "  ..     $m" -ForegroundColor Gray }
function Warn([string]$m) { Write-Host "  [warn] $m" -ForegroundColor Yellow }

# ---------------------------------------------------------------- preconditions
Step 'Checking preconditions'

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
      ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run this in an elevated PowerShell. Installing a service, editing the long-path policy and adding a Defender exclusion all require it.'
}
Ok 'elevated'

if (-not $Token) {
  Write-Host ''
  Write-Host 'No -Token given. Registration tokens last about an hour, so mint one now on a machine with gh authenticated:' -ForegroundColor Yellow
  Write-Host ''
  Write-Host "  gh api --method POST repos/$Repo/actions/runners/registration-token --jq .token" -ForegroundColor White
  Write-Host ''
  Write-Host 'then re-run with -Token <that value>.' -ForegroundColor Yellow
  exit 1
}

if ([Environment]::Is64BitOperatingSystem -eq $false) { throw 'x64 Windows required.' }
Ok "$([Environment]::OSVersion.VersionString), x64"

# Disk is the constraint that actually bites, and it bites late — halfway through
# linking, as an io error that reads like something else. Rough budget for one
# release build of this repo: ~4 GB Build Tools, ~0.2 GB runner, ~2 GB
# node_modules, ~1 GB pnpm store, ~8-12 GB target/, ~1 GB bundled runtimes,
# ~1 GB installer output, plus 0.8-1.6 GB of incremental state that grows over
# the first few builds. Call it 25 GB to be comfortable.
$freeGb = [math]::Round((Get-PSDrive ($RunnerDir[0])).Free / 1GB, 1)
if ($freeGb -lt 25) {
  Warn "only $freeGb GB free on $($RunnerDir[0]): — a release build of this repo wants ~20 GB and grows"
  Warn 'the runner will still install, but expect the first full build to be the thing that runs out'
} else {
  Ok "$freeGb GB free on $($RunnerDir[0]):"
}

# --------------------------------------------------------------- long path支援
# cargo nests target/<profile>/build/<pkg>-<hash>/out/... and this repo has 806
# dependencies. Without both of these, builds fail with io errors that read like
# corruption rather than "path too long".
Step 'Enabling long paths'
New-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' `
  -Name 'LongPathsEnabled' -Value 1 -PropertyType DWord -Force | Out-Null
Ok 'LongPathsEnabled = 1'

# ------------------------------------------------------------------- Defender
# Real-time scanning every .o and .rlib cargo writes is one of the largest
# single costs of a Windows Rust build. The runner work tree is build output from
# a repo we control, so excluding it trades no meaningful protection.
Step 'Excluding the runner work tree from Defender'
try {
  Add-MpPreference -ExclusionPath $RunnerDir -ErrorAction Stop
  Ok "excluded $RunnerDir"
} catch {
  Warn "could not add the exclusion ($($_.Exception.Message)). Builds still work, just slower."
}

# ----------------------------------------------------------------------- git
Step 'Git for Windows (provides the bash the workflow steps run in)'
if (Get-Command git -ErrorAction SilentlyContinue) {
  Ok "already present: $((git --version) -join '')"
} else {
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Info 'installing via winget'
    winget install --id Git.Git --source winget --silent `
      --accept-source-agreements --accept-package-agreements
  } else {
    throw 'git is missing and winget is unavailable. Install Git for Windows from https://git-scm.com/download/win and re-run.'
  }
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
              [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw 'git still not on PATH after install. Open a new elevated shell and re-run.'
  }
  Ok "installed: $((git --version) -join '')"
}
# Same reason as LongPathsEnabled, but git has its own switch and checkout is
# what first trips over it.
git config --system core.longpaths true
Ok 'git core.longpaths = true'

# --------------------------------------------------------------- build tools
# The msvc Rust target links with link.exe. rustup will happily install the
# toolchain without it and then fail at the link step with "linker `link.exe` not
# found", which is a confusing way to discover a 3 GB missing dependency.
Step 'MSVC build tools (link.exe + Windows SDK)'
if ($SkipBuildTools) {
  Warn 'skipped by -SkipBuildTools'
} else {
  $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
  $haveVc = $false
  if (Test-Path $vswhere) {
    $found = & $vswhere -latest -products '*' `
      -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
      -property installationPath 2>$null
    if ($found) { $haveVc = $true; Ok "already present: $found" }
  }
  if (-not $haveVc) {
    Info 'downloading the Build Tools bootstrapper (this installs several GB and takes a while)'
    $bootstrapper = Join-Path $env:TEMP 'vs_BuildTools.exe'
    Invoke-WebRequest -Uri 'https://aka.ms/vs/17/release/vs_BuildTools.exe' -OutFile $bootstrapper
    # Exactly the two components the msvc Rust target needs — the MSVC v143
    # compiler/linker and one Windows SDK — and nothing else. Deliberately NOT
    # --includeRecommended, which drags in ATL/MFC, CMake, the sanitizers and a
    # second MSVC version for several extra GB. A build VM is usually short on
    # disk long before it is short on anything else.
    $vsArgs = @(
      '--quiet', '--wait', '--norestart', '--nocache',
      '--add', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
      '--add', 'Microsoft.VisualStudio.Component.Windows11SDK.22621'
    )
    $p = Start-Process -FilePath $bootstrapper -ArgumentList $vsArgs -Wait -PassThru
    # 3010 is "success, reboot required" — fine, the runner service starts after.
    if ($p.ExitCode -notin @(0, 3010)) {
      throw "Build Tools installer exited $($p.ExitCode). Re-run it interactively to see why: $bootstrapper"
    }
    Ok "installed (exit $($p.ExitCode))"
  }
}

# -------------------------------------------------------------------- runner
Step "Installing the runner into $RunnerDir"
New-Item -ItemType Directory -Force -Path $RunnerDir | Out-Null

# Pin nothing: the runner auto-updates itself anyway, so starting from latest
# only avoids an immediate self-update on first job.
$rel = Invoke-RestMethod -Uri 'https://api.github.com/repos/actions/runner/releases/latest' `
  -Headers @{ 'User-Agent' = 'bat-runner-setup' }
$version = $rel.tag_name.TrimStart('v')
$zipName = "actions-runner-win-x64-$version.zip"
$zipPath = Join-Path $RunnerDir $zipName

if (Test-Path (Join-Path $RunnerDir 'config.cmd')) {
  Ok 'runner binaries already unpacked'
} else {
  Info "downloading $zipName"
  Invoke-WebRequest -Uri "https://github.com/actions/runner/releases/download/v$version/$zipName" -OutFile $zipPath
  Info 'unpacking'
  Expand-Archive -Path $zipPath -DestinationPath $RunnerDir -Force
  Remove-Item $zipPath -Force
  Ok "unpacked runner $version"
}

# A runner that is already configured must be removed before reconfiguring, or
# config.cmd refuses. Do it explicitly rather than passing --replace, so an
# accidental re-run against the wrong repo is loud instead of silent.
if (Test-Path (Join-Path $RunnerDir '.runner')) {
  Warn 'this directory is already configured as a runner'
  Warn "to re-register: cd $RunnerDir; .\config.cmd remove --token <removal-token>"
  Warn 'leaving the existing configuration alone.'
} else {
  Step 'Registering with GitHub'
  $labelList = (@('bat-win') + $Labels | Select-Object -Unique) -join ','
  $configArgs = @(
    '--unattended',
    '--url', "https://github.com/$Repo",
    '--token', $Token,
    '--name', $env:COMPUTERNAME,
    '--labels', $labelList,
    '--runasservice'
  )
  if ($UseNetworkService) {
    Info 'service will run as NT AUTHORITY\NETWORK SERVICE'
  } else {
    if (-not $ServicePassword) {
      $ServicePassword = Read-Host -AsSecureString "Windows password for $ServiceAccount (the account the runner service logs on as)"
    }
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
      [Runtime.InteropServices.Marshal]::SecureStringToBSTR($ServicePassword))
    $configArgs += @('--windowslogonaccount', $ServiceAccount, '--windowslogonpassword', $plain)
    Info "service will run as $ServiceAccount"
  }

  Push-Location $RunnerDir
  try {
    & (Join-Path $RunnerDir 'config.cmd') @configArgs
    if ($LASTEXITCODE -ne 0) { throw "config.cmd exited $LASTEXITCODE" }
  } finally {
    Pop-Location
    if ($plain) { $plain = $null; [GC]::Collect() }
  }
  Ok "registered as $env:COMPUTERNAME with labels: self-hosted,Windows,X64,$labelList"
}

# -------------------------------------------------------------------- service
Step 'Runner service'
$svc = Get-Service -Name 'actions.runner.*' -ErrorAction SilentlyContinue
if (-not $svc) {
  Warn 'no runner service found. If config.cmd was skipped above this is expected.'
} else {
  foreach ($s in $svc) {
    if ($s.Status -ne 'Running') { Start-Service $s.Name }
    Set-Service -Name $s.Name -StartupType Automatic
    Ok "$($s.Name): $((Get-Service $s.Name).Status), startup Automatic"
  }
}

# ---------------------------------------------------------------------- next
Step 'Done — one step left, on GitHub'
Write-Host @"
  The runner is registered but the workflow still ignores it. Point the Windows
  legs at it by setting a repository variable:

    Settings -> Secrets and variables -> Actions -> Variables -> New

      Name:  WIN_RUNNER_LABELS
      Value: ["self-hosted","Windows","X64","bat-win"]

  or from a shell with gh authenticated:

    gh variable set WIN_RUNNER_LABELS --repo $Repo --body '["self-hosted","Windows","X64","bat-win"]'

  Clearing that variable sends the Windows legs straight back to windows-latest,
  which is what to do whenever this machine is off. To make that automatic
  instead, add a fine-grained PAT with Administration: Read as the secret
  RUNNER_STATUS_TOKEN — release.yml then checks the runner is online and falls
  back on its own. Without it, a job queued for an offline runner waits 24 hours
  before failing.

  First release on this runner is a cold build: nothing is cached yet, so expect
  hosted-runner timings. The win shows up from the second release, once
  src-tauri/target is warm and CARGO_INCREMENTAL has something to work with.
"@ -ForegroundColor White
