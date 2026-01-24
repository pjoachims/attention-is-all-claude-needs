# Activate VS Code window by folder name in title
# Usage: activate-window.ps1 -FolderName "my-project"
param(
    [Parameter(Mandatory=$true)]
    [string]$FolderName
)

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public class WindowActivator {
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

    [DllImport("kernel32.dll")]
    public static extern uint GetCurrentThreadId();

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);  // Returns true if minimized

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    public const int SW_RESTORE = 9;

    private static IntPtr foundHwnd = IntPtr.Zero;
    private static string searchTerm = "";

    public static IntPtr FindWindowByTitleContains(string term) {
        foundHwnd = IntPtr.Zero;
        searchTerm = term.ToLower();

        EnumWindows((hWnd, lParam) => {
            if (IsWindowVisible(hWnd)) {
                var sb = new StringBuilder(256);
                GetWindowText(hWnd, sb, 256);
                string title = sb.ToString().ToLower();

                if (title.Contains("visual studio code") && title.Contains(searchTerm)) {
                    foundHwnd = hWnd;
                    return false;
                }
            }
            return true;
        }, IntPtr.Zero);

        return foundHwnd;
    }

    public static bool ActivateWindow(IntPtr hWnd) {
        if (hWnd == IntPtr.Zero) return false;

        IntPtr foregroundHwnd = GetForegroundWindow();
        uint dummy;
        uint foregroundThread = GetWindowThreadProcessId(foregroundHwnd, out dummy);
        uint currentThread = GetCurrentThreadId();

        bool attached = false;
        if (foregroundThread != currentThread) {
            attached = AttachThreadInput(currentThread, foregroundThread, true);
        }

        try {
            // Only restore if minimized - don't change maximized/normal state
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

$hwnd = [WindowActivator]::FindWindowByTitleContains($FolderName)

if ($hwnd -eq [IntPtr]::Zero) {
    Write-Output "NotFound"
    exit 1
}

$result = [WindowActivator]::ActivateWindow($hwnd)
Write-Output $result
