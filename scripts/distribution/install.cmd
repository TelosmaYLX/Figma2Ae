@echo off
rem Extra arguments are forwarded, e.g. install.cmd -InstallDirectory "C:\Program Files (x86)\Common Files\Adobe\CEP\extensions\F2A"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-f2a.ps1" %*
if errorlevel 1 (
  echo Installation failed. Check README.txt and the error above.
  pause
  exit /b 1
)
echo Installation complete.
pause
