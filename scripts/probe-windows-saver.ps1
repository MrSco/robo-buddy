param([int]$Seconds=22, [switch]$Idle)
Add-Type @"
using System;
using System.Text;
using System.Diagnostics;
using System.Runtime.InteropServices;
public class IdleProbe {
 [DllImport("user32.dll")] public static extern IntPtr GetThreadDesktop(uint id);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr h,int index,StringBuilder text,int size,out int needed);
 [DllImport("user32.dll")] public static extern IntPtr GetShellWindow();
 [DllImport("user32.dll",EntryPoint="SystemParametersInfoW")] public static extern bool GetTimeout(uint action,uint param,ref uint value,uint flags);
 [DllImport("user32.dll",EntryPoint="SystemParametersInfoW")] public static extern bool SetTimeout(uint action,uint param,IntPtr value,uint flags);
 public delegate bool EnumProc(IntPtr h,IntPtr p);
 [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc fn,IntPtr p);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h,StringBuilder s,int n);
 public static string[] Titles(){var list=new System.Collections.Generic.List<string>();EnumWindows((h,p)=>{var s=new StringBuilder(4096);GetWindowText(h,s,s.Capacity);if(s.ToString().StartsWith("Robo Buddy"))list.Add(s.ToString());return true;},IntPtr.Zero);return list.ToArray();}
 [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h,uint msg,IntPtr w,IntPtr l);
 [DllImport("user32.dll")] public static extern void keybd_event(byte key,byte scan,uint flags,UIntPtr extra);
 public static string Desktop(uint tid){var s=new StringBuilder(256);int n;return GetUserObjectInformation(GetThreadDesktop(tid),2,s,512,out n)?s.ToString():"?";}
}
"@
$before = @(Get-Process | Where-Object { $_.ProcessName -match 'robo-buddy|ROBO-B|glmatrix' } | Select-Object -ExpandProperty Id)
$savedTimeout=[uint32]0
[IdleProbe]::GetTimeout(14,0,[ref]$savedTimeout,0) | Out-Null
try {
 if($Idle){
  [IdleProbe]::keybd_event(0x10,0,0,[UIntPtr]::Zero);Start-Sleep -Milliseconds 200;[IdleProbe]::keybd_event(0x10,0,2,[UIntPtr]::Zero)
  [IdleProbe]::SetTimeout(15,15,[IntPtr]::Zero,2) | Out-Null
 } else {
 [IdleProbe]::PostMessage([IdleProbe]::GetShellWindow(),0x112,[IntPtr]0xf140,[IntPtr]0) | Out-Null
 }
 for($i=0;$i -lt $Seconds;$i++) {
  $ps=Get-Process | Where-Object { $_.ProcessName -match 'robo-buddy|ROBO-B|glmatrix' }
  foreach($p in $ps) { [pscustomobject]@{sec=$i;pid=$p.Id;name=$p.ProcessName;desktops=@($p.Threads | ForEach-Object { [IdleProbe]::Desktop($_.Id) } | Sort-Object -Unique)} | ConvertTo-Json -Compress }
  [pscustomobject]@{sec=$i;windows=[IdleProbe]::Titles()} | ConvertTo-Json -Compress
  if($i -eq $(if($Idle){28}else{12})){[IdleProbe]::keybd_event(0x10,0,0,[UIntPtr]::Zero);Start-Sleep -Milliseconds 200;[IdleProbe]::keybd_event(0x10,0,2,[UIntPtr]::Zero)}
  Start-Sleep -Seconds 1
 }
} finally {
 if($Idle){[IdleProbe]::SetTimeout(15,$savedTimeout,[IntPtr]::Zero,2) | Out-Null}
 Get-Process | Where-Object { $_.ProcessName -match '^(robo-buddy\.scr|ROBO-B~1\.SCR|glmatrix\.scr)$' -and $_.Id -notin $before } | Stop-Process -Force
}
