param(
  [string]$Root = 'D:/harness-work/harness-compare-1024/reserve-supervisor-1025-v2',
  [string]$Template = 'D:/harness-work/harness-compare-1024/continuation-1025-v6'
)
$ErrorActionPreference = 'Stop'
$workspace = Split-Path $PSScriptRoot -Parent
$source = Join-Path $workspace 'tools/benchmark-reserve-supervisor.py'
$sourceHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
foreach ($receiptName in @('reserve-check.json','reserve-lifecycle.json','reserve-reboot.json')) {
  $receipt = Get-Content -LiteralPath (Join-Path $workspace ('reports/private-release-1025/' + $receiptName)) -Raw | ConvertFrom-Json
  if (-not $receipt.passed -or $receipt.sourceSha256 -ne $sourceHash) { throw ('Current source lacks a passing receipt: ' + $receiptName) }
}
$rootPath = [IO.Path]::GetFullPath($Root)
$templatePath = [IO.Path]::GetFullPath($Template)
if ($rootPath -ne 'D:\harness-work\harness-compare-1024\reserve-supervisor-1025-v2' -or $templatePath -ne 'D:\harness-work\harness-compare-1024\continuation-1025-v6') { throw 'Use the reviewed benchmark directories' }
[IO.Directory]::CreateDirectory($rootPath) | Out-Null
$installed = Join-Path $rootPath 'supervisor.py'
if ((Test-Path -LiteralPath $installed) -and (Get-FileHash -LiteralPath $installed -Algorithm SHA256).Hash.ToLowerInvariant() -ne $sourceHash) { throw 'Preserve the installed supervisor; do not replace its source during a run' }
Copy-Item -LiteralPath $source -Destination $installed
$pin = @{ sourceSha256=$sourceHash; templatePreparedSha256=(Get-FileHash -LiteralPath (Join-Path $templatePath 'PREPARED.json') -Algorithm SHA256).Hash.ToLowerInvariant(); installedAt=[DateTime]::UtcNow.ToString('o') }
[IO.File]::WriteAllText((Join-Path $rootPath 'PINS.json'),($pin | ConvertTo-Json),[Text.UTF8Encoding]::new($false))
$bootstrap = @'
import hashlib, json, pathlib, runpy, sys, traceback
root = pathlib.Path(__file__).resolve().parent
with (root/'resident.log').open('a', encoding='utf-8', buffering=1) as output:
    sys.stdout = sys.stderr = output
    try:
        pin = json.loads((root/'PINS.json').read_text())
        source = root/'supervisor.py'
        template = root.parent/'continuation-1025-v6'
        sha = lambda file: hashlib.sha256(file.read_bytes()).hexdigest()
        if sha(source) != pin['sourceSha256'] or sha(template/'PREPARED.json') != pin['templatePreparedSha256']:
            raise RuntimeError('Installed supervisor or template changed; refuse automatic inference')
        sys.argv = [str(source), 'run', '--root', str(root), '--template', str(template)]
        runpy.run_path(str(source), run_name='__main__')
    except SystemExit:
        raise
    except BaseException:
        traceback.print_exc(file=output)
        raise SystemExit(1)
'@
$bootstrapPath = Join-Path $rootPath 'bootstrap.py'
[IO.File]::WriteAllText($bootstrapPath,$bootstrap,[Text.UTF8Encoding]::new($false))
$pythonPath = (& python -c 'import sys; print(sys.executable)').Trim()
$pythonWindowless = Join-Path (Split-Path $pythonPath -Parent) 'pythonw.exe'
if (-not (Test-Path -LiteralPath $pythonWindowless)) { throw 'Windowless Python is required for sign-in recovery' }
$taskName = 'Atlias Benchmark Recovery'
$description = 'Atlias benchmark recovery v1 | ' + $rootPath
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing -and $existing.Description -ne $description) {
  $previousRoot = 'D:\harness-work\harness-compare-1024\reserve-supervisor-1025'
  $previousState = Get-Content -LiteralPath (Join-Path $previousRoot 'STATE.json') -Raw | ConvertFrom-Json
  if ($existing.Description -ne ('Atlias benchmark recovery v1 | '+$previousRoot) -or $existing.State -eq 'Running' -or $previousState.attempts.Count -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $previousRoot 'STOP'))) { throw 'An existing task belongs to another owner or is still active' }
}
$action = New-ScheduledTaskAction -Execute $pythonWindowless -Argument ('-u -B "' + $bootstrapPath + '"') -WorkingDirectory $rootPath
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity.Name
$principal = New-ScheduledTaskPrincipal -UserId $identity.User.Value -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 2) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -Priority 7
$definition = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description $description
if ($existing) { Register-ScheduledTask -TaskName $taskName -InputObject $definition -Force | Out-Null }
else { Register-ScheduledTask -TaskName $taskName -InputObject $definition | Out-Null }
$saved = Get-ScheduledTask -TaskName $taskName
if ($saved.Actions.Execute -ne $pythonWindowless -or $saved.Actions.Arguments -notlike '*bootstrap.py*' -or $saved.Settings.MultipleInstances -ne 'IgnoreNew' -or $saved.Settings.ExecutionTimeLimit -ne 'PT0S') { throw 'Saved task differs from the reviewed action' }
[IO.File]::WriteAllText((Join-Path $rootPath 'scheduled-task.xml'),(Export-ScheduledTask -TaskName $taskName),[Text.UTF8Encoding]::new($false))
Start-ScheduledTask -TaskName $taskName
@{ installed=$true; task=$taskName; atLogOn=$true; multipleInstances=[string]$saved.Settings.MultipleInstances; sourceSha256=$sourceHash } | ConvertTo-Json
