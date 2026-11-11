param([switch]$Foreground)

$ErrorActionPreference = 'Stop'
$ledgerAddress = 'http://127.0.0.1:4173'
$ledgerData = Join-Path $PSScriptRoot 'data'
$ledgerScript = Join-Path $PSScriptRoot 'server.mjs'
$ledgerNode = Get-Command node -ErrorAction SilentlyContinue
if (-not $ledgerNode) {
    $ledgerBundledNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
    if (-not (Test-Path -LiteralPath $ledgerBundledNode)) {
        throw 'Node.js 24 is required. Install it and run this launcher again.'
    }
    $ledgerExecutable = $ledgerBundledNode
} else {
    $ledgerExecutable = $ledgerNode.Source
}

try {
    $ledgerPage = Invoke-WebRequest -Uri $ledgerAddress -TimeoutSec 3 -UseBasicParsing
} catch {
    $ledgerPage = $null
}
if ($ledgerPage) {
    if (-not $ledgerPage.Content.Contains('/app.js') -or -not $ledgerPage.Content.Contains('id="app-shell"')) {
        throw 'Port 4173 is occupied by another application.'
    }
    Write-Host "Already running: $ledgerAddress" -ForegroundColor Green
    return
}

$env:HOST = '127.0.0.1'
$env:PORT = '4173'
New-Item -ItemType Directory -Path $ledgerData -Force | Out-Null
if ($Foreground) {
    & $ledgerExecutable $ledgerScript
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    return
}

$ledgerProcess = Start-Process -FilePath $ledgerExecutable `
    -ArgumentList ('"{0}"' -f $ledgerScript) `
    -WorkingDirectory $PSScriptRoot -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $ledgerData 'server.stdout.log') `
    -RedirectStandardError (Join-Path $ledgerData 'server.stderr.log') -PassThru
for ($ledgerAttempt = 0; $ledgerAttempt -lt 40; $ledgerAttempt++) {
    $ledgerProcess.Refresh()
    if ($ledgerProcess.HasExited) {
        $ledgerError = Get-Content -LiteralPath (Join-Path $ledgerData 'server.stderr.log') -Tail 12
        throw "Server exited: $ledgerError"
    }
    try {
        $ledgerPage = Invoke-WebRequest -Uri $ledgerAddress -TimeoutSec 2 -UseBasicParsing
        if ($ledgerPage.StatusCode -eq 200 -and $ledgerPage.Content.Contains('id="app-shell"')) {
            Write-Host "Running in background: $ledgerAddress" -ForegroundColor Green
            return
        }
    } catch {
        Start-Sleep -Milliseconds 250
    }
}
throw 'Server did not become ready. Check data/server.stderr.log.'
