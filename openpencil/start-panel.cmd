@echo off
setlocal
where node >nul 2>&1
if errorlevel 1 goto no_node
set "F2A_OP_SCRIPT=%~dp0..\scripts\openpencil-panel.cjs"
powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -Command "$q = [char]34; Start-Process -FilePath 'node' -ArgumentList @($q + $env:F2A_OP_SCRIPT + $q, '--mcp', '--auto-exit') -WindowStyle Hidden"
exit /b 0
:no_node
echo [F2A] Node.js 20+ was not found in PATH. Please install Node.js first.
pause
exit /b 1
