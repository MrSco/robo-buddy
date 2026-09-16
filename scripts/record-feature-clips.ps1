<#
.SYNOPSIS
    Robo Buddy Website Feature Reel Video Capture Tool
.DESCRIPTION
    Interactively records short 1080p 60/30fps video clips for the website's Desktop Feature Reel.
    Uses ffmpeg with hardware acceleration or libx264, web-optimized for HTML5 autoplay.
#>

param(
    [string]$ClipId,
    [int]$Duration = 8
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$VideoDir = Join-Path $RepoRoot "website\public\videos"

if (-not (Test-Path $VideoDir)) {
    New-Item -ItemType Directory -Force -Path $VideoDir | Out-Null
}

# Ensure ffmpeg is available
$ffmpeg = (Get-Command ffmpeg -ErrorAction SilentlyContinue)?.Source
if (-not $ffmpeg) {
    Write-Host "ffmpeg is required but was not found in PATH." -ForegroundColor Red
    Write-Host "Install it via: choco install ffmpeg or winget install Gyan.FFmpeg" -ForegroundColor Yellow
    exit 1
}

$Clips = @(
    @{
        Id = "music-dancing"
        Title = "Beat Dancing (WASAPI Audio Reactor)"
        Desc = "Play Spotify, YouTube, or music. Buddy detects beat and dances hip-hop."
        DefaultDuration = 8
    },
    @{
        Id = "window-physics"
        Title = "Window Furniture & Ragdoll Physics"
        Desc = "Grab Buddy and fling him onto open app windows or watch him climb."
        DefaultDuration = 8
    },
    @{
        Id = "clippy-context"
        Title = "Clippy Mode (Context Companion & Chips)"
        Desc = "Focus VS Code or Chrome. Buddy chimes in with tips and interactive action chips."
        DefaultDuration = 8
    },
    @{
        Id = "screensaver-havoc"
        Title = "Screensaver Destruction & Void"
        Desc = "Trigger Screensaver mode. Buddy smashes desktop tiles or glass cutouts."
        DefaultDuration = 8
    },
    @{
        Id = "webcam-mocap"
        Title = "Webcam Motion Capture (Mirror Tracking)"
        Desc = "Open Settings -> Mocap. Turn on Mirror and move your hands/body in front of camera."
        DefaultDuration = 8
    },
    @{
        Id = "voice-chat"
        Title = "AI Voice & Chat (Neural TTS + LLM)"
        Desc = "Open Talk drawer or trigger AI voice response with Piper local neural TTS."
        DefaultDuration = 8
    }
)

if (-not $ClipId) {
    Clear-Host
    Write-Host "=========================================================" -ForegroundColor Cyan
    Write-Host "   Robo Buddy Website Demo Capture Tool (ffmpeg)         " -ForegroundColor White
    Write-Host "=========================================================" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Select a clip to capture:" -ForegroundColor Yellow
    for ($i = 0; $i -lt $Clips.Count; $i++) {
        $c = $Clips[$i]
        Write-Host "  [$($i + 1)] $($c.Title)" -ForegroundColor Green
        Write-Host "      → $($c.Desc)" -ForegroundColor Gray
    }
    Write-Host "  [7] Custom Clip Name" -ForegroundColor Magenta
    Write-Host "  [8] Import from Windows Captures (Win + Alt + R recordings)" -ForegroundColor Yellow
    Write-Host "  [Q] Quit" -ForegroundColor Red
    Write-Host ""

    $choice = Read-Host "Enter selection [1-8, Q]"
    if ($choice -match "^[Qq]$") { exit 0 }

    if ($choice -eq "8") {
        $capturesDir = [System.IO.Path]::Combine([Environment]::GetFolderPath("MyVideos"), "Captures")
        if (-not (Test-Path $capturesDir)) {
            Write-Host "Captures folder not found at $capturesDir" -ForegroundColor Red
            exit 1
        }
        $latest = Get-ChildItem -Path $capturesDir -Filter "*.mp4" | Sort-Object LastWriteTime -Descending | Select-Object -First 5
        if (-not $latest) {
            Write-Host "No MP4 recordings found in $capturesDir" -ForegroundColor Red
            exit 1
        }
        Write-Host "`nRecent captures:" -ForegroundColor Yellow
        for ($k = 0; $k -lt $latest.Count; $k++) {
            Write-Host "  [$($k + 1)] $($latest[$k].Name) ($([math]::Round($latest[$k].Length / 1MB, 1)) MB)"
        }
        $vidPick = Read-Host "Pick recording to import [1-$($latest.Count)]"
        $idx = [int]$vidPick - 1
        $srcFile = $latest[$idx].FullName

        Write-Host "`nSelect destination clip for this video:" -ForegroundColor Yellow
        for ($i = 0; $i -lt $Clips.Count; $i++) {
            Write-Host "  [$($i + 1)] $($Clips[$i].Id).mp4"
        }
        $destPick = Read-Host "Pick destination [1-$($Clips.Count)]"
        $targetId = $Clips[[int]$destPick - 1].Id
        $targetPath = Join-Path $VideoDir "$targetId.mp4"

        Write-Host "Encoding & optimizing for web..." -ForegroundColor Cyan
        & $ffmpeg -y -i $srcFile -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2" -c:v libx264 -crf 20 -preset fast -pix_fmt yuv420p -movflags +faststart -an $targetPath
        Write-Host "✓ Successfully imported to $targetPath!" -ForegroundColor Green
        exit 0
    }

    if ($choice -eq "7") {
        $ClipId = Read-Host "Enter custom clip name (without .mp4)"
    } else {
        $num = [int]$choice - 1
        if ($num -ge 0 -and $num -lt $Clips.Count) {
            $ClipId = $Clips[$num].Id
            $Duration = $Clips[$num].DefaultDuration
        } else {
            Write-Host "Invalid selection." -ForegroundColor Red
            exit 1
        }
    }

    $durInput = Read-Host "Enter duration in seconds (default $Duration)"
    if ($durInput -match "^\d+$") {
        $Duration = [int]$durInput
    }
}

$OutputPath = Join-Path $VideoDir "$ClipId.mp4"

# Query primary monitor bounds
Add-Type -AssemblyName System.Windows.Forms
$primary = [System.Windows.Forms.Screen]::PrimaryScreen
$w = $primary.Bounds.Width
$h = $primary.Bounds.Height
$x = $primary.Bounds.X
$y = $primary.Bounds.Y

Write-Host ""
Write-Host "Target Clip:    $ClipId.mp4" -ForegroundColor Cyan
Write-Host "Duration:       $Duration seconds" -ForegroundColor Cyan
Write-Host "Primary Screen: ${w}x${h} at ($x, $y)" -ForegroundColor Cyan
Write-Host "Destination:    $OutputPath" -ForegroundColor Cyan
Write-Host ""
Write-Host "Prepare your window / Buddy on the primary screen now!" -ForegroundColor Yellow

for ($sec = 5; $sec -gt 0; $sec--) {
    Write-Host "Recording starts in $sec seconds..." -ForegroundColor Magenta
    Start-Sleep -Seconds 1
}

Write-Host ""
Write-Host "● RECORDING STARTED... ($Duration seconds)" -ForegroundColor Red -BackgroundColor White
Write-Host "Perform the actions on your screen now!" -ForegroundColor Yellow

# Launch ffmpeg gdigrab on primary monitor
& $ffmpeg -y -f gdigrab -framerate 30 -offset_x $x -offset_y $y -video_size "${w}x${h}" -i desktop -t $Duration -vf "scale=1920:1080:flags=lanczos" -c:v libx264 -crf 20 -preset fast -pix_fmt yuv420p -movflags +faststart -an $OutputPath

if (Test-Path $OutputPath) {
    $sizeMb = [math]::Round((Get-Item $OutputPath).Length / 1MB, 2)
    Write-Host ""
    Write-Host "=========================================================" -ForegroundColor Green
    Write-Host "✓ SUCCESS! Clip recorded and optimized:" -ForegroundColor Green
    Write-Host "  File: $OutputPath ($sizeMb MB)" -ForegroundColor White
    Write-Host "  The clip is now ready and will play automatically on the site!" -ForegroundColor Green
    Write-Host "=========================================================" -ForegroundColor Green
} else {
    Write-Host "Recording failed or output was not created." -ForegroundColor Red
}
