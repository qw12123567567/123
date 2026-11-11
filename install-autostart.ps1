$ErrorActionPreference = 'Stop'
$ledgerLauncher = Join-Path $PSScriptRoot 'start.ps1'
$ledgerRunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$ledgerEntry = 'DeviceLedgerLocal'
$ledgerArguments = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$ledgerLauncher`""
$ledgerPrevious = $null
try {
    $ledgerPrevious = Get-ItemPropertyValue -Path $ledgerRunKey -Name $ledgerEntry -ErrorAction Stop
} catch {
    $ledgerPrevious = $null
}
if ($ledgerPrevious -and $ledgerPrevious -notlike "*$ledgerLauncher*") {
    throw 'A different application already uses the startup entry name.'
}
New-Item -Path $ledgerRunKey -Force -ErrorAction Stop | Out-Null
New-ItemProperty -Path $ledgerRunKey -Name $ledgerEntry -Value $ledgerArguments -PropertyType String -Force -ErrorAction Stop | Out-Null
if ((Get-ItemPropertyValue -Path $ledgerRunKey -Name $ledgerEntry -ErrorAction Stop) -ne $ledgerArguments) {
    throw 'Startup registration verification failed.'
}
Write-Host 'Verified: the local device ledger starts in the background at your Windows sign-in.'
