param(
    [int]$Minutes = 60,
    [string]$OutputPath = (Join-Path $PSScriptRoot '../output/sleep-probe.jsonl')
)
$ErrorActionPreference = 'Stop'
if ($Minutes -lt 1) { throw 'Minutes must be positive.' }
$OutputPath = [IO.Path]::GetFullPath($OutputPath)
New-Item -ItemType Directory -Path (Split-Path $OutputPath) -Force | Out-Null
# PowerShell cannot unload a type once a session has defined one, so a window that already ran an
# older copy of this script keeps that class and misses anything added since -- which surfaces as
# "does not contain a method named 'SaverRunning'". Naming the class after a hash of its own source
# gives every version of it a name of its own, so an old session simply defines the new one.
$probeSource = @'
using System;
using System.Runtime.InteropServices;
public static class __PROBE__ {
    [StructLayout(LayoutKind.Sequential)]
    struct LASTINPUTINFO { public uint size; public uint tick; }
    [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
    [DllImport("kernel32.dll")] static extern uint GetTickCount();
    [DllImport("user32.dll", EntryPoint="SystemParametersInfoW")]
    static extern bool SystemParametersInfo(uint action, uint param, out int value, uint flags);
    public static bool? SaverRunning() {
        int value;
        return SystemParametersInfo(0x72, 0, out value, 0) ? (bool?)(value != 0) : null;
    }
    public static double Seconds() {
        var info = new LASTINPUTINFO { size = (uint)Marshal.SizeOf<LASTINPUTINFO>() };
        if (!GetLastInputInfo(ref info)) throw new InvalidOperationException("Cannot read idle time");
        return unchecked(GetTickCount() - info.tick) / 1000.0;
    }
}
'@
$sha = [Security.Cryptography.SHA1]::Create()
$stamp = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($probeSource))).Replace('-', '').Substring(0, 8)
$sha.Dispose()
$probeName = "BuddyIdleProbe$stamp"
if (-not ($probeName -as [type])) { Add-Type ($probeSource -replace '__PROBE__', $probeName) }
$probe = $probeName -as [type]
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
        idleSeconds = $probe::Seconds()
        windowsSaverRunning = $probe::SaverRunning()
        requestsExitCode = $requestExit
        requests = $requests
        buddy = @(Get-Process -Name robo-buddy -ErrorAction SilentlyContinue | Select-Object Id,WorkingSet64,CPU)
        backdrop = @(Get-Process -Name glmatrix.scr -ErrorAction SilentlyContinue | Select-Object Id,WorkingSet64,CPU)
    } | ConvertTo-Json -Depth 4 -Compress | Add-Content -LiteralPath $OutputPath
    Start-Sleep -Seconds 5
}
