@echo off
:: This simulates EXACTLY how Claude Code calls the hook
:: It uses cmd.exe /c with the full path, just like the hooks config

echo === Simulating Claude Code Hook Invocation ===
echo.

:: Get the exact command from settings.json and run it
echo Running: cmd.exe /c "C:\Users\Per.Joachims\.claude\claude-attn\notify.cmd" start
echo.

cmd.exe /c "C:\Users\Per.Joachims\.claude\claude-attn\notify.cmd" start

echo.
echo Exit code: %errorlevel%
echo.

:: Check results
echo Checking session files:
dir "C:\Users\Per.Joachims\.claude\claude-attn\sessions\*.json" 2>nul
