@echo off
:: Claude Code Attention Monitor - Hook Script (Windows)
:: Writes session state to %USERPROFILE%\.claude\claude-attn\sessions\
setlocal enabledelayedexpansion

set "ACTION=%~1"
set "REASON=%~2"
if "%REASON%"=="" set "REASON=permission_prompt"

:: Set PS script path first (before any if blocks for proper variable expansion)
set "PS_SCRIPT=%USERPROFILE%\.claude\claude-attn\get-pids.ps1"

set "SESSION_ID="
set "CLAUDE_PID="
set "TERMINAL_PID="
set "WINDOW_HANDLE="

:: Get Claude PID and Terminal PID via PowerShell helper script
for /f "usebackq tokens=1,2 delims=," %%A in (`powershell -NoProfile -ExecutionPolicy Bypass -File "!PS_SCRIPT!"`) do (
    set "CLAUDE_PID=%%A"
    set "TERMINAL_PID=%%B"
)

:: Capture the foreground window handle (the VS Code window that launched this session)
:: This is reliable because the hook runs synchronously during session start
for /f "usebackq delims=" %%H in (`powershell -NoProfile -Command "Add-Type -MemberDefinition '[DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow();' -Name W -Namespace U; [U.W]::GetForegroundWindow().ToInt64()"`) do (
    set "WINDOW_HANDLE=%%H"
)

if defined CLAUDE_SESSION_ID (
    set "SESSION_ID=%CLAUDE_SESSION_ID%"
) else if defined CLAUDE_PID (
    set "SESSION_ID=ppid-!CLAUDE_PID!"
) else (
    set "SESSION_ID=win-%RANDOM%%RANDOM%"
)

if defined CLAUDE_WORKING_DIRECTORY (
    set "CWD=%CLAUDE_WORKING_DIRECTORY%"
) else (
    set "CWD=%CD%"
)
:: Escape backslashes for JSON
set "CWD=!CWD:\=\\!"

:: VS Code IPC handle - unique per VS Code window (deprecated, kept for compatibility)
set "IPC_HANDLE=%VSCODE_GIT_IPC_HANDLE%"
:: Escape backslashes in IPC handle for JSON
set "IPC_HANDLE=!IPC_HANDLE:\=\\!"

:: Window ID from Claude ATTN extension (unique per VS Code window)
set "WINDOW_ID=%CLAUDE_ATTN_WINDOW_ID%"

set "SESSIONS_DIR=%USERPROFILE%\.claude\claude-attn\sessions"
if not exist "%SESSIONS_DIR%" mkdir "%SESSIONS_DIR%"
set "SESSION_FILE=%SESSIONS_DIR%\!SESSION_ID!.json"

:: Get timestamp via PowerShell (more reliable than WMIC)
for /f "usebackq delims=" %%T in (`powershell -NoProfile -Command "Get-Date -Format 'yyyy-MM-ddTHH:mm:ssZ'"`) do set "TIMESTAMP=%%T"
if not defined TIMESTAMP set "TIMESTAMP=unknown"

:: Build extra fields for JSON
set "EXTRA_FIELDS="
if defined CLAUDE_PID if not "!CLAUDE_PID!"=="" set EXTRA_FIELDS=,"claudePid":!CLAUDE_PID!
if defined TERMINAL_PID if not "!TERMINAL_PID!"=="" set EXTRA_FIELDS=!EXTRA_FIELDS!,"terminalPid":!TERMINAL_PID!
if defined IPC_HANDLE if not "!IPC_HANDLE!"=="" set EXTRA_FIELDS=!EXTRA_FIELDS!,"vscodeIpcHandle":"!IPC_HANDLE!"
if defined WINDOW_ID if not "!WINDOW_ID!"=="" set EXTRA_FIELDS=!EXTRA_FIELDS!,"windowId":"!WINDOW_ID!"
if defined WINDOW_HANDLE if not "!WINDOW_HANDLE!"=="" if not "!WINDOW_HANDLE!"=="0" set EXTRA_FIELDS=!EXTRA_FIELDS!,"windowHandle":"!WINDOW_HANDLE!"

if "%ACTION%"=="attention" (
    echo {"id":"!SESSION_ID!","status":"attention","reason":"%REASON%","cwd":"!CWD!","lastUpdate":"!TIMESTAMP!"!EXTRA_FIELDS!}>"%SESSION_FILE%"
) else if "%ACTION%"=="start" (
    echo {"id":"!SESSION_ID!","status":"running","cwd":"!CWD!","lastUpdate":"!TIMESTAMP!"!EXTRA_FIELDS!}>"%SESSION_FILE%"
) else if "%ACTION%"=="end" (
    if exist "%SESSION_FILE%" del "%SESSION_FILE%"
) else if "%ACTION%"=="idle" (
    echo {"id":"!SESSION_ID!","status":"idle","cwd":"!CWD!","lastUpdate":"!TIMESTAMP!"!EXTRA_FIELDS!}>"%SESSION_FILE%"
)
