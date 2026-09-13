param([string]$Exe = "$PSScriptRoot/../src-tauri/target/debug/robo-buddy.exe")
$ErrorActionPreference = 'Stop'
$Exe = [IO.Path]::GetFullPath($Exe)
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class BuddyRecoveryTest {
 [DllImport("user32.dll", EntryPoint="SystemParametersInfoW", SetLastError=true)]
 static extern bool Get(uint action, uint param, out int value, uint flags);
 [DllImport("user32.dll", EntryPoint="SystemParametersInfoW", SetLastError=true)]
 static extern bool Set(uint action, uint param, IntPtr value, uint flags);
 public static bool Active() { int value; if (!Get(16, 0, out value, 0)) throw new Exception("read active failed"); return value != 0; }
 public static bool Secure() { int value; if (!Get(0x76, 0, out value, 0)) throw new Exception("read secure failed"); return value != 0; }
 public static void Active(bool value) { if (!Set(17, value ? 1u : 0u, IntPtr.Zero, 2)) throw new Exception("set active failed"); }
}
'@
if ([BuddyRecoveryTest]::Secure()) { throw 'Run this test only with a non-password-protected saver. No lock setting was changed.' }
$original = [BuddyRecoveryTest]::Active()
$desktop = 'HKCU:\Control Panel\Desktop'
function Preferences {
    Get-ItemProperty $desktop | Select-Object 'SCRNSAVE.EXE', ScreenSaveActive, ScreenSaveTimeOut, ScreenSaverIsSecure | ConvertTo-Json -Compress
}
$before = Preferences
function Start-Guard {
    $start = [Diagnostics.ProcessStartInfo]::new($Exe, '--idle-saver-guard')
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $process = [Diagnostics.Process]::Start($start)
    $line = $process.StandardOutput.ReadLineAsync()
    if (-not $line.Wait(7000) -or -not $line.Result) {
        if (-not $process.HasExited) { $process.Kill(); $process.WaitForExit() }
        throw "Recovery helper did not acknowledge startup (exit $($process.ExitCode))."
    }
    if ([BuddyRecoveryTest]::Active()) { throw 'Windows saver was not suppressed.' }
    if ((Preferences) -ne $before) { throw 'Helper changed persisted Windows preferences.' }
    return $process
}
function Close-Guard($process) {
    $process.StandardInput.Close()
    if (-not $process.WaitForExit(7000)) { $process.Kill(); throw 'Recovery helper did not exit.' }

}
try {
    foreach ($enabled in @($true, $false)) {
        [BuddyRecoveryTest]::Active($enabled)
        $guard = Start-Guard
        Close-Guard $guard
        if ([BuddyRecoveryTest]::Active() -ne $enabled) { throw "Did not restore original enabled=$enabled." }
        Write-Host "PASS: enabled=$enabled restored on pipe closure; registry unchanged."
    }
    [BuddyRecoveryTest]::Active($true)
    $guard = Start-Guard
    [BuddyRecoveryTest]::Active($true)
    Close-Guard $guard
    if (-not [BuddyRecoveryTest]::Active()) { throw 'User re-enable was overwritten.' }
    Write-Host 'PASS: external re-enable respected.'
    # Kill an actual parent without cleanup. Windows closes its pipe handles and the helper
    # restores the saver independently, just as when the resident heap crashes.
    $escapedExe = $Exe.Replace("'", "''")
    $parentCode = @"
`$info = [Diagnostics.ProcessStartInfo]::new('$escapedExe', '--idle-saver-guard')
`$info.UseShellExecute = `$false
`$info.CreateNoWindow = `$true
`$info.RedirectStandardInput = `$true
`$info.RedirectStandardOutput = `$true
`$child = [Diagnostics.Process]::Start(`$info)
`$line = `$child.StandardOutput.ReadLine()
if (-not `$line) { exit 2 }
[Console]::WriteLine(`$child.Id)
[Console]::Out.Flush()
`$child.WaitForExit()
"@
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($parentCode))
    $parentInfo = [Diagnostics.ProcessStartInfo]::new((Get-Process -Id $PID).Path, "-NoProfile -EncodedCommand $encoded")
    $parentInfo.UseShellExecute = $false
    $parentInfo.CreateNoWindow = $true
    $parentInfo.RedirectStandardOutput = $true
    $parent = [Diagnostics.Process]::Start($parentInfo)
    try {
        $ready = $parent.StandardOutput.ReadLineAsync()
        if (-not $ready.Wait(7000) -or -not $ready.Result) { throw 'Crash test parent did not become ready.' }
        if ([BuddyRecoveryTest]::Active()) { throw 'Crash test did not suppress Windows saver.' }
        $parent.Kill()
        $parent.WaitForExit()
        $deadline = (Get-Date).AddSeconds(7)
        while (-not [BuddyRecoveryTest]::Active() -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 100 }
        if (-not [BuddyRecoveryTest]::Active()) { throw 'Windows saver did not recover after parent crash.' }
        Write-Host 'PASS: forced parent termination restores Windows saver without resident cleanup.'
    } finally {
        if (-not $parent.HasExited) { $parent.Kill(); $parent.WaitForExit() }
    }
    if ((Preferences) -ne $before) { throw 'Persisted Windows settings changed.' }
} finally {
    if ($guard -and -not $guard.HasExited) { $guard.StandardInput.Close(); $guard.WaitForExit(7000) | Out-Null }
    [BuddyRecoveryTest]::Active($original)
}

