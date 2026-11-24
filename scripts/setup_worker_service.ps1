# ==============================================================================
# BakuEstate-AI: Automated Windows Task Scheduler Service Registration
# Script: scripts/setup_worker_service.ps1
#
# Configures a resilient 24/7 background service for BakuEstate Local Worker
# managed by `src/worker/watchdog.py`. Runs under the interactive user session
# to ensure direct access to NVENC / QuickSync GPU hardware acceleration for FFmpeg.
# ==============================================================================

[CmdletBinding(DefaultParameterSetName = "Default")]
param(
    [Parameter(ParameterSetName = "Register")]
    [switch]$Register,

    [Parameter(ParameterSetName = "Unregister")]
    [switch]$Unregister,

    [Parameter(ParameterSetName = "Start")]
    [switch]$Start,

    [Parameter(ParameterSetName = "Stop")]
    [switch]$Stop,

    [Parameter(ParameterSetName = "Status")]
    [switch]$Status,

    [string]$TaskName = "BakuEstateWorkerService",
    [string]$PythonExe = "C:\Users\HP\AppData\Local\Programs\Python\Python313\python.exe",
    [string]$WorkingDir,
    [string]$LogFile
)

$ErrorActionPreference = "Stop"

# 1. Resolve project root and paths
if (-not $WorkingDir) {
    $WorkingDir = (Resolve-Path "$PSScriptRoot\..").Path
} else {
    $WorkingDir = (Resolve-Path $WorkingDir).Path
}

if (-not $LogFile) {
    $LogFile = Join-Path $WorkingDir "data\logs\worker_service.log"
}

$WatchdogScript = Join-Path $WorkingDir "src\worker\watchdog.py"
$StartupFolder = [Environment]::GetFolderPath('Startup')
$StartupBat = Join-Path $StartupFolder "$TaskName.bat"

# Ensure data\logs directory exists
$LogDir = Split-Path -Parent $LogFile
if (-not (Test-Path $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}

# Verify Python executable
if (-not (Test-Path $PythonExe)) {
    $foundPython = Get-Command "python" -ErrorAction SilentlyContinue
    if ($foundPython) {
        $PythonExe = $foundPython.Source
        Write-Host "[WARN] Specified Python 3.13 not found at default path. Using: $PythonExe" -ForegroundColor Yellow
    } else {
        Write-Error "Python executable not found at '$PythonExe' and not available in PATH."
        exit 1
    }
}

# Verify Watchdog script exists
if (-not (Test-Path $WatchdogScript)) {
    Write-Error "Watchdog script not found at '$WatchdogScript'."
    exit 1
}

# ------------------------------------------------------------------------------
# Action Handlers
# ------------------------------------------------------------------------------

# Handler: Status
if ($Status) {
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existing) {
        $taskInfo = Get-ScheduledTaskInfo -TaskName $TaskName
        Write-Host "==========================================================" -ForegroundColor Cyan
        Write-Host " BakuEstate Worker Service Status (Task Scheduler)" -ForegroundColor Cyan
        Write-Host "==========================================================" -ForegroundColor Cyan
        Write-Host "Task Name:        $($existing.TaskName)"
        Write-Host "State:            $($existing.State)"
        Write-Host "Last Run Time:    $($taskInfo.LastRunTime)"
        Write-Host "Next Run Time:    $($taskInfo.NextRunTime)"
        Write-Host "Last Task Result: $($taskInfo.LastTaskResult)"
        Write-Host "Log Output File:  $LogFile"
        Write-Host "==========================================================" -ForegroundColor Cyan
    } elseif (Test-Path $StartupBat) {
        Write-Host "==========================================================" -ForegroundColor Cyan
        Write-Host " BakuEstate Worker Service Status (User Startup)" -ForegroundColor Cyan
        Write-Host "==========================================================" -ForegroundColor Cyan
        Write-Host "Launcher File:    $StartupBat"
        Write-Host "Log Output File:  $LogFile"
        $running = Get-CimInstance Win32_Process -Filter "Name = 'python.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like "*watchdog.py*" }
        if ($running) {
            Write-Host "Process State:    RUNNING (PID: $($running.ProcessId))" -ForegroundColor Green
        } else {
            Write-Host "Process State:    STOPPED" -ForegroundColor Yellow
        }
        Write-Host "==========================================================" -ForegroundColor Cyan
    } else {
        Write-Host "Service '$TaskName' is NOT registered (neither in Task Scheduler nor Startup folder)." -ForegroundColor Yellow
    }
    exit 0
}

# Handler: Start
if ($Start) {
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existing) {
        Write-Host "Starting Scheduled Task '$TaskName'..." -ForegroundColor Green
        Start-ScheduledTask -TaskName $TaskName
        Write-Host "Task '$TaskName' started successfully." -ForegroundColor Green
    } elseif (Test-Path $StartupBat) {
        Write-Host "Starting Worker via Startup script: $StartupBat..." -ForegroundColor Green
        Start-Process "cmd.exe" -ArgumentList "/c ""`"$StartupBat`"""" -WindowStyle Hidden
        Write-Host "Worker daemon started." -ForegroundColor Green
    } else {
        Write-Host "Cannot start: Task '$TaskName' is not registered. Run with -Register first." -ForegroundColor Yellow
    }
    exit 0
}

# Handler: Stop
if ($Stop) {
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existing) {
        Write-Host "Stopping Scheduled Task '$TaskName'..." -ForegroundColor Yellow
        Stop-ScheduledTask -TaskName $TaskName
        Write-Host "Task '$TaskName' stopped." -ForegroundColor Yellow
    }
    $running = Get-CimInstance Win32_Process -Filter "Name = 'python.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like "*watchdog.py*" -or $_.CommandLine -like "*local_worker.py*" }
    if ($running) {
        foreach ($proc in $running) {
            Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
            Write-Host "Killed process PID $($proc.ProcessId)" -ForegroundColor Yellow
        }
    }
    Write-Host "Worker daemon stopped." -ForegroundColor Yellow
    exit 0
}

# Handler: Unregister
if ($Unregister) {
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existing) {
        Write-Host "Unregistering Scheduled Task '$TaskName'..." -ForegroundColor Yellow
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "Task '$TaskName' removed successfully." -ForegroundColor Green
    }
    if (Test-Path $StartupBat) {
        Remove-Item -Path $StartupBat -Force
        Write-Host "Removed Startup launcher '$StartupBat'." -ForegroundColor Green
    }
    exit 0
}

# Handler: Register (Default)
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host " Registering BakuEstate Worker Windows Scheduled Task" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "Task Name:        $TaskName"
Write-Host "Python Executable: $PythonExe"
Write-Host "Working Directory:$WorkingDir"
Write-Host "Target Script:    $WatchdogScript"
Write-Host "Log File:         $LogFile"
Write-Host "User Principal:   $env:USERNAME (GPU NVENC/QuickSync enabled)"
Write-Host "----------------------------------------------------------"

# Construct Action executing cmd.exe redirecting output to log file
$ActionArguments = "/c ""`"$PythonExe`" `"$WatchdogScript`" >> `"$LogFile`" 2>&1"""
$Action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument $ActionArguments -WorkingDirectory $WorkingDir

# Trigger: Run at user logon
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

# Principal: Interactive user with elevated privileges for NVENC GPU driver access
$Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest

# Settings: Never stop on battery, restart on failure, run indefinitely
$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Days 0) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1)

try {
    # Unregister existing task if present
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existing) {
        Write-Host "Updating existing Scheduled Task '$TaskName'..." -ForegroundColor Yellow
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    }

    Register-ScheduledTask `
        -TaskName $TaskName `
        -Action $Action `
        -Trigger $Trigger `
        -Principal $Principal `
        -Settings $Settings `
        -Description "BakuEstate-AI 24/7 Resilient Local Worker Daemon supervised by watchdog.py with GPU NVENC/QuickSync support." `
        -Force | Out-Null

    Write-Host "[SUCCESS] Scheduled Task '$TaskName' registered successfully!" -ForegroundColor Green
    Write-Host "To start the task immediately, run:" -ForegroundColor White
    Write-Host "  powershell -ExecutionPolicy Bypass -File scripts\setup_worker_service.ps1 -Start" -ForegroundColor Cyan
    Write-Host "To inspect logs, run:" -ForegroundColor White
    Write-Host "  Get-Content data\logs\worker_service.log -Tail 50 -Wait" -ForegroundColor Cyan
} catch {
    Write-Host "[INFO] Task Scheduler registration requires elevated admin rights ($_)." -ForegroundColor Yellow
    Write-Host "[INFO] Falling back to Windows User Startup folder registration..." -ForegroundColor Cyan

    $BatContent = "@echo off`r`ncd /d `"$WorkingDir`"`r`n`"$PythonExe`" `"$WatchdogScript`" >> `"$LogFile`" 2>&1`r`n"
    Set-Content -Path $StartupBat -Value $BatContent -Encoding ASCII
    Write-Host "[SUCCESS] Registered BakuEstate Worker Service in User Startup folder!" -ForegroundColor Green
    Write-Host "Launcher Script:  $StartupBat"
    Write-Host "Log Output File:  $LogFile"
    Write-Host "The worker will automatically run on every Windows user login." -ForegroundColor Green
    Write-Host "To start it immediately without waiting for next login, run:" -ForegroundColor White
    Write-Host "  powershell -ExecutionPolicy Bypass -File scripts\setup_worker_service.ps1 -Start" -ForegroundColor Cyan
}
