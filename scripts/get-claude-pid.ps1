# Walk up the process tree from current PowerShell process to find Claude Code (node.exe)
# Returns the PID of the first node.exe ancestor, or nothing if not found

$currentPid = $PID
$maxLevels = 10  # Safety limit

for ($i = 0; $i -lt $maxLevels; $i++) {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$currentPid" -ErrorAction SilentlyContinue
    if (-not $proc) { break }

    $parentPid = $proc.ParentProcessId
    $parentProc = Get-CimInstance Win32_Process -Filter "ProcessId=$parentPid" -ErrorAction SilentlyContinue
    if (-not $parentProc) { break }

    # Check if parent is node.exe (Claude Code)
    if ($parentProc.Name -eq "node.exe" -or $parentProc.Name -eq "claude.exe") {
        Write-Host $parentPid
        exit 0
    }

    $currentPid = $parentPid
}

# If we didn't find node.exe, output nothing (batch will use fallback)
