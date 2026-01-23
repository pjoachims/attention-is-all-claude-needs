@echo off
:: Claude Code Attention Monitor - Fast Windows Hook Script
:: Uses one file per session to avoid JSON parsing overhead
setlocal enabledelayedexpansion

set "ACTION=%~1"
set "REASON=%~2"
if "%REASON%"=="" set "REASON=permission_prompt"

if defined CLAUDE_SESSION_ID (
    set "SESSION_ID=%CLAUDE_SESSION_ID%"
) else (
    set "SESSION_ID=win-%RANDOM%%RANDOM%"
)

if defined CLAUDE_WORKING_DIRECTORY (
    set "CWD=%CLAUDE_WORKING_DIRECTORY%"
) else (
    set "CWD=%CD%"
)

set "SESSIONS_DIR=%USERPROFILE%\.claude\claude-attn\sessions"
if not exist "%SESSIONS_DIR%" mkdir "%SESSIONS_DIR%"
set "SESSION_FILE=%SESSIONS_DIR%\%SESSION_ID%.json"

:: Get ISO timestamp using wmic (locale-independent)
for /f "tokens=2 delims==" %%I in ('wmic os get localdatetime /value') do set "DT=%%I"
set "TIMESTAMP=%DT:~0,4%-%DT:~4,2%-%DT:~6,2%T%DT:~8,2%:%DT:~10,2%:%DT:~12,2%Z"

if "%ACTION%"=="attention" (
    echo {"id":"%SESSION_ID%","status":"attention","reason":"%REASON%","cwd":"%CWD%","lastUpdate":"%TIMESTAMP%"}>"%SESSION_FILE%"
) else if "%ACTION%"=="start" (
    echo {"id":"%SESSION_ID%","status":"running","cwd":"%CWD%","lastUpdate":"%TIMESTAMP%"}>"%SESSION_FILE%"
) else if "%ACTION%"=="end" (
    if exist "%SESSION_FILE%" del "%SESSION_FILE%"
) else if "%ACTION%"=="idle" (
    echo {"id":"%SESSION_ID%","status":"idle","cwd":"%CWD%","lastUpdate":"%TIMESTAMP%"}>"%SESSION_FILE%"
)
