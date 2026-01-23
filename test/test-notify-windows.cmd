@echo off
:: Test script that simulates how Claude Code calls the notify hook
:: This mimics: cmd.exe /c "C:\...\notify.cmd start"

echo === Testing Windows Notify Script ===
echo.

:: Test 1: Check if PowerShell script exists
set "PS_SCRIPT=%USERPROFILE%\.claude\claude-attn\get-claude-pid.ps1"
echo Test 1: Checking if PS script exists at %PS_SCRIPT%
if exist "%PS_SCRIPT%" (
    echo   PASS: Script exists
) else (
    echo   FAIL: Script not found
    exit /b 1
)
echo.

:: Test 2: Run PowerShell script directly
echo Test 2: Running PowerShell script directly
echo   Command: powershell -NoProfile -ExecutionPolicy Bypass -File "%PS_SCRIPT%"
for /f "usebackq delims=" %%P in (`powershell -NoProfile -ExecutionPolicy Bypass -File "%PS_SCRIPT%"`) do (
    echo   Result: %%P
    set "TEST_PID=%%P"
)
if defined TEST_PID (
    echo   PASS: Got PID %TEST_PID%
) else (
    echo   FAIL: No PID returned
)
echo.

:: Test 3: Verify the PID is a valid process
echo Test 3: Verifying PID %TEST_PID% is a valid process
tasklist /FI "PID eq %TEST_PID%" /NH 2>nul | findstr /i "%TEST_PID%" >nul
if %errorlevel%==0 (
    echo   PASS: Process exists
    tasklist /FI "PID eq %TEST_PID%" /FO CSV /NH
) else (
    echo   FAIL: Process not found
)
echo.

:: Test 4: Run the actual notify script with "start" action
echo Test 4: Running notify.cmd start
set "NOTIFY_SCRIPT=%USERPROFILE%\.claude\claude-attn\notify.cmd"
call "%NOTIFY_SCRIPT%" start
echo   Exit code: %errorlevel%
echo.

:: Test 5: Check if session file was created
echo Test 5: Checking for session files
set "SESSIONS_DIR=%USERPROFILE%\.claude\claude-attn\sessions"
dir "%SESSIONS_DIR%\*.json" 2>nul
echo.

echo === Tests Complete ===
