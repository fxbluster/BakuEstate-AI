# PowerShell execution wrapper for Baku Estate AI
$pyExe = "C:\Users\HP\AppData\Local\Programs\Python\Python313\python.exe"
if (Test-Path $pyExe) {
    & $pyExe "$PSScriptRoot\run_pipeline.py" @args
} else {
    python "$PSScriptRoot\run_pipeline.py" @args
}
