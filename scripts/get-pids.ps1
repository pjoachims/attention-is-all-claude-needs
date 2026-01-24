# Walk up process tree to find Claude PID and Terminal PID
# Output format: claudePid,terminalPid
$currentPid = $PID
$maxLevels = 15
$claudePid = ""
$terminalPid = ""

for ($i = 0; $i -lt $maxLevels; $i++) {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$currentPid" -ErrorAction SilentlyContinue
    if (-not $proc) { break }

    $parentPid = $proc.ParentProcessId
    $parentProc = Get-CimInstance Win32_Process -Filter "ProcessId=$parentPid" -ErrorAction SilentlyContinue
    if (-not $parentProc) { break }

    # Check if parent is node.exe or claude.exe (Claude Code)
    if (-not $claudePid -and ($parentProc.Name -eq "node.exe" -or $parentProc.Name -eq "claude.exe")) {
        $claudePid = $parentPid
    }
    # Once we found Claude, the next shell-like process is the terminal
    elseif ($claudePid -and -not $terminalPid) {
        # Terminal is typically cmd.exe, powershell.exe, pwsh.exe, or bash.exe
        if ($parentProc.Name -match "^(cmd|powershell|pwsh|bash|zsh|fish|sh)\.exe$") {
            $terminalPid = $parentPid
            break  # Found both, we're done
        }
    }

    # Check if parent is Code.exe - use current as terminal if we haven't found one
    if ($parentProc.Name -eq "Code.exe") {
        if (-not $terminalPid -and $claudePid) {
            $terminalPid = $currentPid
        }
        break
    }

    $currentPid = $parentPid
}

# Output both PIDs (comma-separated)
Write-Host "$claudePid,$terminalPid"
