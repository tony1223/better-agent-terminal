$ErrorActionPreference = 'Stop'

$packageArgs = @{
  packageName  = $env:ChocolateyPackageName
  softwareName = 'BetterAgentTerminal*'
  fileType     = 'exe'
  silentArgs   = '/S'
  validExitCodes = @(0)
}

[array]$key = Get-UninstallRegistryKey -SoftwareName $packageArgs['softwareName']

if ($key.Count -eq 1) {
  $key | ForEach-Object {
    # UninstallString may contain args (e.g. "/currentuser" for per-user NSIS installs)
    # Extract just the executable path
    $uninstallString = $_.UninstallString
    if ($uninstallString -match '^"([^"]+)"') {
      $packageArgs['file'] = $Matches[1]
    } else {
      $packageArgs['file'] = ($uninstallString -split ' /')[0]
    }
    Uninstall-ChocolateyPackage @packageArgs
  }
} elseif ($key.Count -eq 0) {
  Write-Warning "$($packageArgs['packageName']) has already been uninstalled by other means."
} elseif ($key.Count -gt 1) {
  Write-Warning "$($key.Count) matches found!"
  Write-Warning "The following is a log of packages that matched:"
  $key | ForEach-Object { Write-Warning "- $($_.DisplayName) $($_.DisplayVersion)" }
}
