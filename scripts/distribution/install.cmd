@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-f2a.ps1" -PromptForMcp %*
set "f2aExitCode=%errorlevel%"
if not "%f2aExitCode%"=="0" echo F2A installation failed. See README.txt and the error above.
pause
exit /b %f2aExitCode%
