$ErrorActionPreference = 'Stop'
$workspace = Split-Path $PSScriptRoot -Parent
$rootPath = 'D:\harness-work\harness-compare-1024\reserve-supervisor-1026-v3'
$priorRoot = 'D:\harness-work\harness-compare-1024\reserve-supervisor-1025-v2'
$template = 'D:\harness-work\harness-compare-1024\continuation-1025-v6'
$source = Join-Path $workspace 'tools/benchmark-reviewed-queue.py'
$sourceHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
$receipt = Get-Content -LiteralPath (Join-Path $workspace 'reports/benchmark-reviewed-1026/check.json') -Raw | ConvertFrom-Json
$life = Get-Content -LiteralPath (Join-Path $workspace 'reports/benchmark-reviewed-1026/lifecycle.json') -Raw | ConvertFrom-Json
$qualified = Get-Content -LiteralPath (Join-Path $workspace 'reports/benchmark-reviewed-1026/prepared-qualification.json') -Raw | ConvertFrom-Json
if (-not $receipt.passed -or $receipt.sourceSHA256 -ne $sourceHash -or -not $life.passed -or $life.scenarios.Count -ne 11 -or -not $qualified.passed -or $qualified.sourceSHA256 -ne $sourceHash -or $qualified.checks -lt 50) { throw 'Current source requires functional, actual-main and generated-arm qualification receipts' }
$reviewFile = Join-Path $rootPath 'REVIEW.json'
$review = Get-Content -LiteralPath $reviewFile -Raw | ConvertFrom-Json
$priorState = Get-Content -LiteralPath (Join-Path $priorRoot 'STATE.json') -Raw | ConvertFrom-Json
if ($priorState.status -ne 'held' -or $null -ne $priorState.active -or $review.priorStateSHA256 -ne (Get-FileHash -LiteralPath (Join-Path $priorRoot 'STATE.json') -Algorithm SHA256).Hash.ToLowerInvariant()) { throw 'Prior hold changed; preserve its owner' }
$taskName = 'Atlias Benchmark Recovery'
$task = Get-ScheduledTask -TaskName $taskName
if ($task.State -ne 'Ready' -or $task.Description -ne ('Atlias benchmark recovery v1 | ' + $priorRoot) -or $task.Actions.Arguments -notlike ('*' + $priorRoot + '\bootstrap.py*')) { throw 'Prior native task is active or belongs to another owner' }
if (Test-Path -LiteralPath 'D:/harness-work/atlias-local-1003/LOCAL-ROLE.lock') { throw 'Central model lease is occupied' }
if (Get-NetTCPConnection -State Listen -LocalPort 11435 -ErrorAction SilentlyContinue) { throw 'Private model port is occupied' }
$installed = Join-Path $rootPath 'supervisor.py'
if ((Test-Path -LiteralPath $installed) -and (Get-FileHash -LiteralPath $installed -Algorithm SHA256).Hash.ToLowerInvariant() -ne $sourceHash) { throw 'Installed source differs; preserve it' }
Copy-Item -LiteralPath $source -Destination $installed
$pin = @{
  sourceSha256 = $sourceHash
  reviewSha256 = (Get-FileHash -LiteralPath $reviewFile -Algorithm SHA256).Hash.ToLowerInvariant()
  baseSha256 = (Get-FileHash -LiteralPath (Join-Path $priorRoot 'supervisor.py') -Algorithm SHA256).Hash.ToLowerInvariant()
  templatePreparedSha256 = (Get-FileHash -LiteralPath (Join-Path $template 'PREPARED.json') -Algorithm SHA256).Hash.ToLowerInvariant()
}
[IO.File]::WriteAllText((Join-Path $rootPath 'PINS.json'),($pin | ConvertTo-Json),[Text.UTF8Encoding]::new($false))
$bootstrap = @'
import hashlib,json,pathlib,runpy,sys,traceback
root=pathlib.Path(__file__).resolve().parent
with (root/'resident.log').open('a',encoding='utf-8',buffering=1) as output:
    sys.stdout=sys.stderr=output
    try:
        pin=json.loads((root/'PINS.json').read_text())
        source=root/'supervisor.py'
        template=root.parent/'continuation-1025-v6'
        base=root.parent/'reserve-supervisor-1025-v2/supervisor.py'
        sha=lambda f:hashlib.sha256(f.read_bytes()).hexdigest()
        for file,key in [(source,'sourceSha256'),(root/'REVIEW.json','reviewSha256'),(base,'baseSha256'),(template/'PREPARED.json','templatePreparedSha256')]:
            if sha(file)!=pin[key]: raise RuntimeError('Pinned reviewed continuation changed; refuse inference')
        sys.argv=[str(source),'run','--root',str(root),'--template',str(template)]
        runpy.run_path(str(source),run_name='__main__')
    except SystemExit: raise
    except BaseException:
        traceback.print_exc(file=output)
        raise SystemExit(1)
'@
$bootstrapPath = Join-Path $rootPath 'bootstrap.py'
[IO.File]::WriteAllText($bootstrapPath,$bootstrap,[Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $rootPath 'prior-scheduled-task.xml'),(Export-ScheduledTask -TaskName $taskName),[Text.UTF8Encoding]::new($false))
$action = New-ScheduledTaskAction -Execute $task.Actions.Execute -Argument ('-u -B "' + $bootstrapPath + '"') -WorkingDirectory $rootPath
$definition = New-ScheduledTask -Action $action -Trigger $task.Triggers -Principal $task.Principal -Settings $task.Settings -Description ('Atlias benchmark recovery v3 | ' + $rootPath)
Register-ScheduledTask -TaskName $taskName -InputObject $definition -Force | Out-Null
$saved = Get-ScheduledTask -TaskName $taskName
if ($saved.Actions.Execute -ne $task.Actions.Execute -or $saved.Settings.MultipleInstances -ne 'IgnoreNew' -or $saved.Settings.RestartCount -ne 3 -or $saved.Settings.ExecutionTimeLimit -ne 'PT0S') { throw 'Saved native settings differ from reviewed settings' }
[IO.File]::WriteAllText((Join-Path $rootPath 'scheduled-task.xml'),(Export-ScheduledTask -TaskName $taskName),[Text.UTF8Encoding]::new($false))
Start-ScheduledTask -TaskName $taskName
@{installed=$true;task=$taskName;sourceSha256=$sourceHash;remaining=@('mini-swe-agent','codex','pi');oldHoldPreserved=$true} | ConvertTo-Json
