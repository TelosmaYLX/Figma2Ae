@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-f2a.ps1"
if errorlevel 1 (
  echo Installation failed. Check README.txt and the error above.
  pause
  exit /b 1
)
echo Installation complete.
pause
