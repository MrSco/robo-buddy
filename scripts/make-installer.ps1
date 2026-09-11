# Builds the Windows installer and copies it to release\.
# Usage (from the repo root):  pwsh scripts/make-installer.ps1
# Needs: Node + pnpm, Rust (the gnu toolchain this repo is set up for), and `pnpm install` done once.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
pnpm tauri build
$version = (Get-Content "$root\src-tauri\tauri.conf.json" | ConvertFrom-Json).version
# dist\ is Vite's frontend output; installers go to release\.
New-Item -ItemType Directory -Force "$root\release" | Out-Null
$setup = Get-ChildItem "$root\src-tauri\target\release\bundle\nsis\*$version*-setup.exe" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
$msi = Get-ChildItem "$root\src-tauri\target\release\bundle\msi\*$version*.msi" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
Copy-Item $setup.FullName "$root\release\RoboBuddy-Setup-$version.exe" -Force
Copy-Item $msi.FullName "$root\release\RoboBuddy-$version.msi" -Force
Write-Host "Installer: release\RoboBuddy-Setup-$version.exe"
Write-Host "MSI:       release\RoboBuddy-$version.msi"
