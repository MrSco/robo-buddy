param(
    [int]$Minutes = 60,
    [string]$OutputPath = (Join-Path $PSScriptRoot '../output/sleep-probe.jsonl')
)
$ErrorActionPreference = 'Stop'
if ($Minutes -lt 1) { throw 'Minutes must be positive.' }
$OutputPath = [IO.Path]::GetFullPath($OutputPath)
New-Item -ItemType Directory -Path (Split-Path $OutputPath) -Force | Out-Null
if (-not ('BuddyIdleProbe' -as [type])) {
    Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class BuddyIdleProbe {
    [StructLayout(LayoutKind.Sequential)]
    struct LASTINPUTINFO { public uint size; public uint tick; }
    [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
    [DllImport("kernel32.dll")] static extern uint GetTickCount();
    public static double Seconds() {
        var info = new LASTINPUTINFO { size = (uint)Marshal.SizeOf<LASTINPUTINFO>() };
        if (!GetLastInputInfo(ref info)) throw new InvalidOperationException("Cannot read idle time");
        return unchecked(GetTickCount() - info.tick) / 1000.0;
    }
}
'@
}
$until = (Get-Date).AddMinutes($Minutes)
Write-Host "Recording to $OutputPath. Leave input alone during the idle test. Ctrl+C stops recording."
Write-Host 'An administrator terminal is needed for the power-request portion; settings are not changed.'
while ((Get-Date) -lt $until) {
    $ErrorActionPreference = 'Continue'
    $requests = (& powercfg /requests 2>&1 | Out-String).Trim()
    $requestExit = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    [pscustomobject]@{
        at = (Get-Date).ToString('o')
        idleSeconds = [BuddyIdleProbe]::Seconds()
        requestsExitCode = $requestExit
        requests = $requests
        buddy = @(Get-Process -Name robo-buddy -ErrorAction SilentlyContinue | Select-Object Id,WorkingSet64,CPU)
        backdrop = @(Get-Process -Name glmatrix.scr -ErrorAction SilentlyContinue | Select-Object Id,WorkingSet64,CPU)
    } | ConvertTo-Json -Depth 4 -Compress | Add-Content -LiteralPath $OutputPath
    Start-Sleep -Seconds 5
}
