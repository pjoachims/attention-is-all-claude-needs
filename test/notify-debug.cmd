@echo off
setlocal enabledelayedexpansion

echo DEBUG: Starting notify-debug.cmd
echo DEBUG: ACTION=%~1
echo DEBUG: USERPROFILE=%USERPROFILE%

set "PS_SCRIPT=%USERPROFILE%\.claude\claude-attn\get-claude-pid.ps1"
echo DEBUG: PS_SCRIPT=%PS_SCRIPT%

echo DEBUG: Checking if file exists...
if exist "%PS_SCRIPT%" (
    echo DEBUG: File exists
) else (
    echo DEBUG: File NOT found!
)

echo DEBUG: Running PowerShell...
echo DEBUG: Command: powershell -NoProfile -ExecutionPolicy Bypass -File "%PS_SCRIPT%"

for /f "usebackq delims=" %%P in (`powershell -NoProfile -ExecutionPolicy Bypass -File "%PS_SCRIPT%"`) do (
    echo DEBUG: Got PID: %%P
    set "SESSION_ID=ppid-%%P"
)

echo DEBUG: SESSION_ID=%SESSION_ID%
