<#
.SYNOPSIS
  Startup smoke for a packaged VSIX in a disposable VS Code profile.

.DESCRIPTION
  Installs the VSIX into a fresh user-data/extensions root, seeds a legacy task
  store (a recurring task without an overlap setting, and one with an explicit
  "not allowed"), starts VS Code, and checks that the extension activated, the
  legacy task was migrated to "allowed", the explicit choice survived, and the
  one-time notice marker was written. Only processes whose command line holds
  the unique root name are stopped; the root is deleted afterwards. The normal
  VS Code profile is never touched.
#>
param(
  [Parameter(Mandatory)][string]$Vsix,
  [int]$WaitSeconds = 45
)
$ErrorActionPreference = 'Stop'
$code = (Get-Command code).Source
$exe = Join-Path (Split-Path (Split-Path $code)) 'Code.exe'
$name = "copilot-scheduler-smoke-$([guid]::NewGuid().ToString('N').Substring(0,8))"
$root = Join-Path $env:TEMP $name
$failures = @()
New-Item -ItemType Directory -Path $root, "$root\ext", "$root\ws" | Out-Null
$storage = "$root\user\User\globalStorage\yamapan.copilot-scheduler"
New-Item -ItemType Directory -Force -Path $storage | Out-Null
# A Preview build must never edit the real argv.json from this disposable profile.
Set-Content -LiteralPath "$root\user\User\settings.json" -Value '{ "copilotScheduler.autoEnableProposedApi": false }' -Encoding UTF8
$now = (Get-Date).ToString('o')
$tasks = @(
  @{ id = 'legacy-recurring'; name = 'legacy recurring'; prompt = 'hello'; cronExpression = '0 3 * * *'; scope = 'global'; promptSource = 'inline'; enabled = $false; createdAt = $now; updatedAt = $now },
  @{ id = 'explicit-off'; name = 'explicit off'; prompt = 'hello'; cronExpression = '0 4 * * *'; scope = 'global'; promptSource = 'inline'; enabled = $false; allowOverlappingRuns = $false; createdAt = $now; updatedAt = $now }
)
ConvertTo-Json -InputObject $tasks -Depth 5 | Set-Content "$storage\scheduledTasks.json" -Encoding UTF8
try {
  & $code --user-data-dir "$root\user" --extensions-dir "$root\ext" --install-extension (Resolve-Path $Vsix).Path | Out-Null
  Start-Process -FilePath $exe -ArgumentList @('--user-data-dir', "$root\user", '--extensions-dir', "$root\ext", '--new-window', "$root\ws", '--disable-workspace-trust', '--skip-welcome') | Out-Null
  Start-Sleep -Seconds $WaitSeconds
  $logs = Get-ChildItem "$root\user\logs" -Recurse -Filter '*.log' -ErrorAction SilentlyContinue
  if (-not ($logs | Select-String -Pattern '_doActivateExtension yamapan\.copilot-scheduler')) { $failures += 'extension did not activate' }
  $saved = Get-Content "$storage\scheduledTasks.json" -Raw | ConvertFrom-Json
  if (($saved | Where-Object id -eq 'legacy-recurring').allowOverlappingRuns -ne $true) { $failures += 'legacy task was not migrated to allowed' }
  if (($saved | Where-Object id -eq 'explicit-off').allowOverlappingRuns -ne $false) { $failures += 'explicit off was not preserved' }
  if (-not (Test-Path "$storage\overlap-default-v1-notified")) { $failures += 'migration notice marker missing' }
}
finally {
  Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($name) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 4
  for ($i = 0; $i -lt 5 -and (Test-Path -LiteralPath $root); $i++) {
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $root) { Start-Sleep -Seconds 2 }
  }
}
if ($failures.Count -gt 0) { $failures | ForEach-Object { Write-Error $_ -ErrorAction Continue }; exit 1 }
Write-Output 'Startup smoke passed: activated, migrated, notice recorded.'
