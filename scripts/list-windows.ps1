Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public class WindowEnumerator {
    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    private static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool IsZoomed(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left, Top, Right, Bottom;
    }

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    public static void ListVSCodeWindows() {
        EnumWindows((hWnd, lParam) => {
            if (IsWindowVisible(hWnd)) {
                var sb = new StringBuilder(512);
                GetWindowText(hWnd, sb, 512);
                string title = sb.ToString();

                if (title.ToLower().Contains("visual studio code")) {
                    uint processId;
                    uint threadId = GetWindowThreadProcessId(hWnd, out processId);

                    var classSb = new StringBuilder(256);
                    GetClassName(hWnd, classSb, 256);

                    RECT rect;
                    GetWindowRect(hWnd, out rect);

                    bool minimized = IsIconic(hWnd);
                    bool maximized = IsZoomed(hWnd);

                    Console.WriteLine("========================================");
                    Console.WriteLine("Handle:    " + hWnd);
                    Console.WriteLine("Title:     " + title);
                    Console.WriteLine("Class:     " + classSb.ToString());
                    Console.WriteLine("ProcessID: " + processId);
                    Console.WriteLine("ThreadID:  " + threadId);
                    Console.WriteLine("Minimized: " + minimized);
                    Console.WriteLine("Maximized: " + maximized);
                    Console.WriteLine("Position:  L=" + rect.Left + " T=" + rect.Top + " R=" + rect.Right + " B=" + rect.Bottom);
                }
            }
            return true;
        }, IntPtr.Zero);
    }
}
"@

[WindowEnumerator]::ListVSCodeWindows()
