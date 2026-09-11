# Builds the Windows installer and copies it to dist\.
# Usage (from the repo root):  pwsh scripts/make-installer.ps1
# Needs: Node + pnpm, Rust (the gnu toolchain this repo is set up for), and `pnpm install` done once.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
pnpm tauri build
$version = (Get-Content "$root\src-tauri\tauri.conf.json" | ConvertFrom-Json).version
New-Item -ItemType Directory -Force "$root\dist" | Out-Null
$setup = Get-ChildItem "$root\src-tauri\target\release\bundle\nsis\*-setup.exe" | Select-Object -First 1
$msi = Get-ChildItem "$root\src-tauri\target\release\bundle\msi\*.msi" | Select-Object -First 1
Copy-Item $setup.FullName "$root\dist\RoboBuddy-Setup-$version.exe" -Force
Copy-Item $msi.FullName "$root\dist\RoboBuddy-$version.msi" -Force
Write-Host "Installer: dist\RoboBuddy-Setup-$version.exe"
Write-Host "MSI:       dist\RoboBuddy-$version.msi"
