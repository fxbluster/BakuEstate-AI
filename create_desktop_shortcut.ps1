$WshShell = New-Object -ComObject WScript.Shell
$DesktopPath = [Environment]::GetFolderPath('Desktop')
$ShortcutPath = Join-Path $DesktopPath "Baku Estate AI.lnk"

$Shortcut = $WshShell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = "C:\Users\HP\BakuEstate-AI\START_BAKU_ESTATE.bat"
$Shortcut.WorkingDirectory = "C:\Users\HP\BakuEstate-AI"
$Shortcut.IconLocation = "C:\Users\HP\BakuEstate-AI\assets\logo.ico,0"
$Shortcut.Description = "Baku Estate AI - 1-Click Autonomous Video Engine"
$Shortcut.WindowStyle = 1
$Shortcut.Save()

Write-Host "SHORTCUT_SUCCESS: $ShortcutPath"
