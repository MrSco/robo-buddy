# PowerShell build script for Robo Buddy Marketing & Docs Website
$ErrorActionPreference = "Stop"

Write-Host "==> Syncing 3D models to website public folder..." -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path "website/public/models" | Out-Null
Copy-Item "public/characters/rocco/rocco.glb" "website/public/models/rocco.glb" -Force

Write-Host "==> Building Astro website..." -ForegroundColor Cyan
Push-Location "website"
try {
    pnpm run build
    Write-Host "==> Website build successful! Output in website/dist" -ForegroundColor Green
} finally {
    Pop-Location
}
