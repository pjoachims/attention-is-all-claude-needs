# Activate VS Code window by window handle (HWND)
# Usage: activate-by-handle.ps1 -Handle 12345
param(
    [Parameter(Mandatory=$true)]
    [long]$Handle
)

Add-Type @"
using System;
using System.Runtime.InteropServices;

public class WinActivate {
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

    [DllImport("kernel32.dll")]
    public static extern uint GetCurrentThreadId();

    public const int SW_RESTORE = 9;

    public static bool ActivateWindow(IntPtr hWnd) {
        if (hWnd == IntPtr.Zero) return false;
        if (!IsWindow(hWnd)) return false;

        IntPtr foregroundHwnd = GetForegroundWindow();
        uint dummy;
        uint foregroundThread = GetWindowThreadProcessId(foregroundHwnd, out dummy);
        uint currentThread = GetCurrentThreadId();

        bool attached = false;
        if (foregroundThread != currentThread) {
            attached = AttachThreadInput(currentThread, foregroundThread, true);
        }

        try {
            if (IsIconic(hWnd)) {
                ShowWindow(hWnd, SW_RESTORE);
            }
            return SetForegroundWindow(hWnd);
        }
        finally {
            if (attached) {
                AttachThreadInput(currentThread, foregroundThread, false);
            }
        }
    }
}
"@

$hWnd = [IntPtr]::new($Handle)
if (-not [WinActivate]::IsWindow($hWnd)) {
    Write-Output "InvalidHandle"
    exit 1
}

$result = [WinActivate]::ActivateWindow($hWnd)
Write-Output "OK:$result"
