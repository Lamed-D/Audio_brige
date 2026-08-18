$ErrorActionPreference = "Stop"
$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PythonPath = Join-Path $ProjectDir ".venv\Scripts\python.exe"
$WingetPackage = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe"

Set-Location -LiteralPath $ProjectDir

if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue) -and (Test-Path -LiteralPath $WingetPackage)) {
    $FfmpegBin = Get-ChildItem -LiteralPath $WingetPackage -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like "ffmpeg-*_build" } |
        ForEach-Object { Join-Path $_.FullName "bin" } |
        Where-Object { Test-Path -LiteralPath (Join-Path $_ "ffmpeg.exe") } |
        Select-Object -First 1

    if ($FfmpegBin) {
        $env:Path = "$FfmpegBin;$env:Path"
        Write-Host "FFmpeg found: $FfmpegBin" -ForegroundColor Green
    }
}

if (-not (Test-Path -LiteralPath $PythonPath)) {
    Write-Host "가상환경이 없습니다. 먼저 사용설명서의 설치 단계를 진행하세요." -ForegroundColor Yellow
    Write-Host "python -m venv .venv"
    Write-Host ".\.venv\Scripts\Activate.ps1"
    Write-Host "pip install -r requirements.txt"
    exit 1
}

& $PythonPath -m streamlit run (Join-Path $ProjectDir "app.py")
