$ErrorActionPreference = "Stop"
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding

Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies @("System.Drawing.dll") -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace BalatroPilotNative
{
    public sealed class WindowInfo
    {
        public long Handle { get; set; }
        public string Title { get; set; }
    }

    public sealed class CaptureResult
    {
        public string PngBase64 { get; set; }
        public string ModelImageBase64 { get; set; }
        public string ModelImageMimeType { get; set; }
        public string Signature { get; set; }
        public int SignatureCellBytes { get; set; }
        public int Width { get; set; }
        public int Height { get; set; }
        public int ClientWidth { get; set; }
        public int ClientHeight { get; set; }
        public int ScreenX { get; set; }
        public int ScreenY { get; set; }
        public string Method { get; set; }
    }

    public sealed class UnlockOverlayResult
    {
        public bool Detected { get; set; }
        public double ButtonX { get; set; }
        public double ButtonY { get; set; }
        public double OrangeRatio { get; set; }
    }

    public static class Native
    {
        private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [StructLayout(LayoutKind.Sequential)]
        private struct RECT { public int Left, Top, Right, Bottom; }

        [StructLayout(LayoutKind.Sequential)]
        private struct POINT { public int X, Y; }

        [StructLayout(LayoutKind.Sequential)]
        private struct INPUT
        {
            public uint Type;
            public INPUTUNION Data;
        }

        [StructLayout(LayoutKind.Explicit)]
        private struct INPUTUNION
        {
            [FieldOffset(0)] public MOUSEINPUT Mouse;
            [FieldOffset(0)] public KEYBDINPUT Keyboard;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct MOUSEINPUT
        {
            public int Dx;
            public int Dy;
            public uint MouseData;
            public uint Flags;
            public uint Time;
            public UIntPtr ExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct KEYBDINPUT
        {
            public ushort VirtualKey;
            public ushort ScanCode;
            public uint Flags;
            public uint Time;
            public UIntPtr ExtraInfo;
        }

        [DllImport("user32.dll")]
        private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
        [DllImport("user32.dll")]
        private static extern int GetWindowTextLength(IntPtr hWnd);
        [DllImport("user32.dll")]
        private static extern bool IsWindowVisible(IntPtr hWnd);
        [DllImport("user32.dll")]
        private static extern bool IsWindow(IntPtr hWnd);
        [DllImport("user32.dll")]
        private static extern bool GetClientRect(IntPtr hWnd, out RECT rect);
        [DllImport("user32.dll")]
        private static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
        [DllImport("user32.dll")]
        private static extern bool ClientToScreen(IntPtr hWnd, ref POINT point);
        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr processId);
        [DllImport("kernel32.dll")]
        private static extern uint GetCurrentThreadId();
        [DllImport("user32.dll")]
        private static extern bool AttachThreadInput(uint sourceThread, uint targetThread, bool attach);
        [DllImport("user32.dll")]
        private static extern IntPtr SetFocus(IntPtr hWnd);
        [DllImport("user32.dll")]
        private static extern void SwitchToThisWindow(IntPtr hWnd, bool altTab);
        [DllImport("user32.dll")]
        private static extern bool BringWindowToTop(IntPtr hWnd);
        [DllImport("user32.dll")]
        private static extern bool ShowWindowAsync(IntPtr hWnd, int command);
        [DllImport("user32.dll")]
        private static extern short GetAsyncKeyState(int virtualKey);
        [DllImport("user32.dll")]
        private static extern uint SendInput(uint count, INPUT[] inputs, int size);
        [DllImport("user32.dll")]
        private static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")]
        private static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
        [DllImport("user32.dll")]
        private static extern int GetSystemMetrics(int index);

        private const uint INPUT_MOUSE = 0;
        private const uint INPUT_KEYBOARD = 1;
        private const uint MOUSE_LEFT_DOWN = 0x0002;
        private const uint MOUSE_LEFT_UP = 0x0004;
        private const uint MOUSE_RIGHT_DOWN = 0x0008;
        private const uint MOUSE_RIGHT_UP = 0x0010;
        private const uint MOUSE_MOVE = 0x0001;
        private const uint MOUSE_ABSOLUTE = 0x8000;
        private const uint MOUSE_VIRTUAL_DESK = 0x4000;
        private const uint KEY_UP = 0x0002;
        private const int SW_RESTORE = 9;
        private const int VK_F8 = 0x77;
        private const uint PW_CLIENTONLY = 0x00000001;
        private const uint PW_RENDERFULLCONTENT = 0x00000002;
        private const int SM_XVIRTUALSCREEN = 76;
        private const int SM_YVIRTUALSCREEN = 77;
        private const int SM_CXVIRTUALSCREEN = 78;
        private const int SM_CYVIRTUALSCREEN = 79;

        public static void EnableDpiAwareness()
        {
            try { SetProcessDPIAware(); } catch { }
        }

        public static WindowInfo[] ListWindows()
        {
            var result = new List<WindowInfo>();
            EnumWindows(delegate(IntPtr hWnd, IntPtr ignored)
            {
                if (!IsWindowVisible(hWnd)) return true;
                int length = GetWindowTextLength(hWnd);
                if (length <= 0) return true;
                var title = new StringBuilder(length + 1);
                GetWindowText(hWnd, title, title.Capacity);
                string value = title.ToString().Trim();
                if (value.Length > 0)
                    result.Add(new WindowInfo { Handle = hWnd.ToInt64(), Title = value });
                return true;
            }, IntPtr.Zero);
            return result.ToArray();
        }

        public static bool WindowExists(long handle)
        {
            return handle != 0 && IsWindow(new IntPtr(handle));
        }

        public static bool Focus(long handle)
        {
            var hWnd = new IntPtr(handle);
            if (!IsWindow(hWnd)) return false;
            IntPtr foreground = GetForegroundWindow();
            uint currentThread = GetCurrentThreadId();
            uint targetThread = GetWindowThreadProcessId(hWnd, IntPtr.Zero);
            uint foregroundThread = foreground == IntPtr.Zero ? 0 : GetWindowThreadProcessId(foreground, IntPtr.Zero);
            bool attachedTarget = false;
            bool attachedForeground = false;
            try
            {
                if (targetThread != 0 && targetThread != currentThread)
                    attachedTarget = AttachThreadInput(currentThread, targetThread, true);
                if (foregroundThread != 0 && foregroundThread != currentThread && foregroundThread != targetThread)
                    attachedForeground = AttachThreadInput(currentThread, foregroundThread, true);
                ShowWindowAsync(hWnd, SW_RESTORE);
                BringWindowToTop(hWnd);
                bool requested = SetForegroundWindow(hWnd);
                SetFocus(hWnd);
                if (!requested) SwitchToThisWindow(hWnd, true);
                Thread.Sleep(30);
                return GetForegroundWindow() == hWnd;
            }
            finally
            {
                if (attachedForeground) AttachThreadInput(currentThread, foregroundThread, false);
                if (attachedTarget) AttachThreadInput(currentThread, targetThread, false);
            }
        }

        private static Rectangle ClientScreenRectangle(IntPtr hWnd)
        {
            RECT rect;
            if (!GetClientRect(hWnd, out rect))
                throw new InvalidOperationException("GetClientRect failed");
            var topLeft = new POINT { X = rect.Left, Y = rect.Top };
            if (!ClientToScreen(hWnd, ref topLeft))
                throw new InvalidOperationException("ClientToScreen failed");
            int width = rect.Right - rect.Left;
            int height = rect.Bottom - rect.Top;
            if (width < 32 || height < 32)
                throw new InvalidOperationException("Target window client area is too small or minimized");

            // Some games use a DPI-awareness mode that makes ClientToScreen return
            // virtualized coordinates even though CopyFromScreen and SetCursorPos use the
            // physical desktop. Detect an impossible origin and derive the client origin
            // from the physical outer window rectangle and its standard frame.
            RECT windowRect;
            if (GetWindowRect(hWnd, out windowRect))
            {
                int windowWidth = windowRect.Right - windowRect.Left;
                int windowHeight = windowRect.Bottom - windowRect.Top;
                bool originOutsideWindow =
                    topLeft.X < windowRect.Left - 2 || topLeft.X > windowRect.Right ||
                    topLeft.Y < windowRect.Top - 2 || topLeft.Y > windowRect.Bottom;
                if (originOutsideWindow && windowWidth >= width && windowHeight >= height)
                {
                    int sideFrame = Math.Max(0, (windowWidth - width) / 2);
                    int bottomFrame = sideFrame;
                    topLeft.X = windowRect.Left + sideFrame;
                    topLeft.Y = windowRect.Bottom - bottomFrame - height;
                }
            }
            return new Rectangle(topLeft.X, topLeft.Y, width, height);
        }

        public static CaptureResult CaptureClient(long handle, bool includeImage)
        {
            var hWnd = new IntPtr(handle);
            if (!IsWindow(hWnd)) throw new InvalidOperationException("Target window no longer exists");
            Rectangle rect = ClientScreenRectangle(hWnd);
            using (var bitmap = new Bitmap(rect.Width, rect.Height, PixelFormat.Format24bppRgb))
            using (var graphics = Graphics.FromImage(bitmap))
            {
                // Capture from the target HWND instead of the desktop. Desktop GDI capture is
                // ambiguous when a mixed-DPI monitor has a negative virtual-screen origin.
                IntPtr hdc = graphics.GetHdc();
                bool captured;
                try
                {
                    captured = PrintWindow(hWnd, hdc, PW_CLIENTONLY | PW_RENDERFULLCONTENT);
                }
                finally
                {
                    graphics.ReleaseHdc(hdc);
                }
                if (!captured)
                    throw new InvalidOperationException("PrintWindow could not capture the Balatro client area");

                // A DPI-unaware game may render its logical client (for example 911x666)
                // into the top-left of a physical-size bitmap (1822x1332). Detect the
                // untouched black padding and crop it. Normalized action coordinates are
                // unchanged by this crop, while the model no longer sees a huge black area.
                Rectangle rendered = DetectRenderedBounds(bitmap);
                string pngBase64 = null;
                string modelImageBase64 = null;
                if (includeImage)
                {
                    if (rendered.Width != bitmap.Width || rendered.Height != bitmap.Height)
                    {
                        using (var cropped = bitmap.Clone(rendered, PixelFormat.Format24bppRgb))
                        {
                            pngBase64 = EncodePng(cropped);
                            modelImageBase64 = EncodeJpeg(cropped, 88L);
                        }
                    }
                    else
                    {
                        pngBase64 = EncodePng(bitmap);
                        modelImageBase64 = EncodeJpeg(bitmap, 88L);
                    }
                }
                return new CaptureResult
                {
                    PngBase64 = pngBase64,
                    ModelImageBase64 = modelImageBase64,
                    ModelImageMimeType = includeImage ? "image/jpeg" : null,
                    Signature = ComputeSignature(bitmap, rendered),
                    SignatureCellBytes = 2,
                    Width = rendered.Width,
                    Height = rendered.Height,
                    ClientWidth = rect.Width,
                    ClientHeight = rect.Height,
                    ScreenX = rect.Left,
                    ScreenY = rect.Top,
                    Method = rendered.Width == bitmap.Width && rendered.Height == bitmap.Height
                        ? "print-window-client"
                        : "print-window-client-dpi-crop"
                };
            }
        }

        public static UnlockOverlayResult DetectUnlockOverlay(long handle)
        {
            var hWnd = new IntPtr(handle);
            if (!IsWindow(hWnd)) throw new InvalidOperationException("Target window no longer exists");
            Rectangle rect = ClientScreenRectangle(hWnd);
            using (var bitmap = new Bitmap(rect.Width, rect.Height, PixelFormat.Format24bppRgb))
            using (var graphics = Graphics.FromImage(bitmap))
            {
                IntPtr hdc = graphics.GetHdc();
                bool captured;
                try
                {
                    captured = PrintWindow(hWnd, hdc, PW_CLIENTONLY | PW_RENDERFULLCONTENT);
                }
                finally
                {
                    graphics.ReleaseHdc(hdc);
                }
                if (!captured)
                    throw new InvalidOperationException("PrintWindow could not capture the Balatro client area");

                Rectangle rendered = DetectRenderedBounds(bitmap);
                int x0 = rendered.Left + (int)Math.Round(rendered.Width * 0.40);
                int x1 = rendered.Left + (int)Math.Round(rendered.Width * 0.60);
                int y0 = rendered.Top + (int)Math.Round(rendered.Height * 0.72);
                int y1 = rendered.Top + (int)Math.Round(rendered.Height * 0.83);
                int orange = 0;
                int samples = 0;
                for (int y = y0; y < y1; y += 2)
                {
                    for (int x = x0; x < x1; x += 2)
                    {
                        Color color = bitmap.GetPixel(x, y);
                        bool isOrange =
                            color.R >= 180 && color.G >= 70 && color.G <= 210 && color.B <= 100 &&
                            color.R >= color.G + 50 && color.G >= color.B + 30;
                        if (isOrange) orange++;
                        samples++;
                    }
                }
                double ratio = orange / (double)Math.Max(1, samples);
                return new UnlockOverlayResult
                {
                    // The unlock modal's wide orange Continue button fills roughly 35% of
                    // this central ROI. Node also requires an exact API-state mismatch.
                    Detected = ratio >= 0.18,
                    ButtonX = 0.50,
                    ButtonY = 0.775,
                    OrangeRatio = ratio
                };
            }
        }

        private static string EncodePng(Bitmap bitmap)
        {
            using (var stream = new MemoryStream())
            {
                bitmap.Save(stream, ImageFormat.Png);
                return Convert.ToBase64String(stream.ToArray());
            }
        }

        private static string EncodeJpeg(Bitmap bitmap, long quality)
        {
            ImageCodecInfo codec = null;
            foreach (var candidate in ImageCodecInfo.GetImageEncoders())
            {
                if (candidate.MimeType == "image/jpeg")
                {
                    codec = candidate;
                    break;
                }
            }
            if (codec == null) throw new InvalidOperationException("JPEG encoder is unavailable");
            using (var stream = new MemoryStream())
            using (var parameters = new EncoderParameters(1))
            {
                parameters.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, quality);
                bitmap.Save(stream, codec, parameters);
                return Convert.ToBase64String(stream.ToArray());
            }
        }

        // A compact 32x24 structural signature lets Node detect UI changes locally.
        // Edge density is much less sensitive than RGB averages to Balatro's constantly
        // moving background shader, while card and button movement still changes it.
        private static string ComputeSignature(Bitmap bitmap, Rectangle bounds)
        {
            const int columns = 32;
            const int rows = 24;
            var bytes = new byte[columns * rows * 2];
            int output = 0;
            for (int row = 0; row < rows; row++)
            {
                int y0 = bounds.Top + row * bounds.Height / rows;
                int y1 = bounds.Top + (row + 1) * bounds.Height / rows;
                for (int column = 0; column < columns; column++)
                {
                    int x0 = bounds.Left + column * bounds.Width / columns;
                    int x1 = bounds.Left + (column + 1) * bounds.Width / columns;
                    int stepX = Math.Max(1, (x1 - x0) / 4);
                    int stepY = Math.Max(1, (y1 - y0) / 4);
                    long magnitudeTotal = 0;
                    int strongEdges = 0;
                    int count = 0;
                    for (int y = Math.Max(bounds.Top + 1, y0); y < Math.Min(bounds.Bottom - 1, y1); y += stepY)
                    {
                        for (int x = Math.Max(bounds.Left + 1, x0); x < Math.Min(bounds.Right - 1, x1); x += stepX)
                        {
                            Color left = bitmap.GetPixel(x - 1, y);
                            Color right = bitmap.GetPixel(x + 1, y);
                            Color top = bitmap.GetPixel(x, y - 1);
                            Color bottom = bitmap.GetPixel(x, y + 1);
                            int leftLuma = (left.R * 54 + left.G * 183 + left.B * 19) / 256;
                            int rightLuma = (right.R * 54 + right.G * 183 + right.B * 19) / 256;
                            int topLuma = (top.R * 54 + top.G * 183 + top.B * 19) / 256;
                            int bottomLuma = (bottom.R * 54 + bottom.G * 183 + bottom.B * 19) / 256;
                            int magnitude = Math.Min(255, Math.Abs(rightLuma - leftLuma) + Math.Abs(bottomLuma - topLuma));
                            magnitudeTotal += magnitude;
                            if (magnitude >= 72) strongEdges++;
                            count++;
                        }
                    }
                    bytes[output++] = (byte)(magnitudeTotal / Math.Max(1, count));
                    bytes[output++] = (byte)(strongEdges * 255 / Math.Max(1, count));
                }
            }
            return Convert.ToBase64String(bytes);
        }

        private static Rectangle DetectRenderedBounds(Bitmap bitmap)
        {
            int maxX = -1;
            int maxY = -1;
            const int step = 2;
            for (int y = 0; y < bitmap.Height; y += step)
            {
                for (int x = 0; x < bitmap.Width; x += step)
                {
                    Color color = bitmap.GetPixel(x, y);
                    if (color.R + color.G + color.B > 24)
                    {
                        if (x > maxX) maxX = x;
                        if (y > maxY) maxY = y;
                    }
                }
            }
            if (maxX < 31 || maxY < 31)
                throw new InvalidOperationException("Captured window is blank or too dark");

            int detectedWidth = Math.Min(bitmap.Width, maxX + step + 1);
            int detectedHeight = Math.Min(bitmap.Height, maxY + step + 1);
            bool hasSubstantialPadding =
                detectedWidth < bitmap.Width * 0.90 || detectedHeight < bitmap.Height * 0.90;
            return hasSubstantialPadding
                ? new Rectangle(0, 0, detectedWidth, detectedHeight)
                : new Rectangle(0, 0, bitmap.Width, bitmap.Height);
        }

        private static POINT NormalizedClientPoint(long handle, double normalizedX, double normalizedY)
        {
            if (normalizedX < 0 || normalizedX > 1 || normalizedY < 0 || normalizedY > 1)
                throw new ArgumentOutOfRangeException("Coordinates must be normalized to [0,1]");
            Rectangle rect = ClientScreenRectangle(new IntPtr(handle));
            return new POINT
            {
                X = rect.Left + (int)Math.Round(normalizedX * Math.Max(1, rect.Width - 1)),
                Y = rect.Top + (int)Math.Round(normalizedY * Math.Max(1, rect.Height - 1))
            };
        }

        private static void SendMouseMoveAt(int screenX, int screenY)
        {
            int virtualX = GetSystemMetrics(SM_XVIRTUALSCREEN);
            int virtualY = GetSystemMetrics(SM_YVIRTUALSCREEN);
            int virtualWidth = GetSystemMetrics(SM_CXVIRTUALSCREEN);
            int virtualHeight = GetSystemMetrics(SM_CYVIRTUALSCREEN);
            if (virtualWidth < 2 || virtualHeight < 2)
                throw new InvalidOperationException("Invalid virtual desktop dimensions");
            int absoluteX = (int)Math.Round((screenX - virtualX) * 65535.0 / (virtualWidth - 1));
            int absoluteY = (int)Math.Round((screenY - virtualY) * 65535.0 / (virtualHeight - 1));

            var inputs = new INPUT[1];
            inputs[0].Type = INPUT_MOUSE;
            inputs[0].Data.Mouse.Dx = absoluteX;
            inputs[0].Data.Mouse.Dy = absoluteY;
            inputs[0].Data.Mouse.Flags = MOUSE_MOVE | MOUSE_ABSOLUTE | MOUSE_VIRTUAL_DESK;
            uint sent = SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
            if (sent != 1) throw new InvalidOperationException("SendInput mouse move failed");
        }

        private static void SendMouseButton(uint flag)
        {
            var inputs = new INPUT[1];
            inputs[0].Type = INPUT_MOUSE;
            inputs[0].Data.Mouse.Flags = flag;
            uint sent = SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
            if (sent != 1) throw new InvalidOperationException("SendInput mouse button failed");
        }

        public static void Move(long handle, double normalizedX, double normalizedY)
        {
            POINT point = NormalizedClientPoint(handle, normalizedX, normalizedY);
            SendMouseMoveAt(point.X, point.Y);
        }

        public static void Click(long handle, double normalizedX, double normalizedY, string button, int count)
        {
            POINT point = NormalizedClientPoint(handle, normalizedX, normalizedY);
            uint down = button == "right" ? MOUSE_RIGHT_DOWN : MOUSE_LEFT_DOWN;
            uint up = button == "right" ? MOUSE_RIGHT_UP : MOUSE_LEFT_UP;
            SendMouseMoveAt(point.X, point.Y);
            Thread.Sleep(30);
            for (int i = 0; i < count; i++)
            {
                SendMouseButton(down);
                Thread.Sleep(45);
                SendMouseButton(up);
                if (i + 1 < count) Thread.Sleep(70);
            }
        }

        private static ushort VirtualKeyFor(string key)
        {
            switch ((key ?? "").ToLowerInvariant())
            {
                case "escape": return 0x1B;
                case "enter": return 0x0D;
                case "space": return 0x20;
                case "tab": return 0x09;
                case "left": return 0x25;
                case "up": return 0x26;
                case "right": return 0x27;
                case "down": return 0x28;
                default: throw new ArgumentException("Unsupported key: " + key);
            }
        }

        public static void PressKey(string key)
        {
            ushort virtualKey = VirtualKeyFor(key);
            var inputs = new INPUT[2];
            inputs[0].Type = INPUT_KEYBOARD;
            inputs[0].Data.Keyboard.VirtualKey = virtualKey;
            inputs[1].Type = INPUT_KEYBOARD;
            inputs[1].Data.Keyboard.VirtualKey = virtualKey;
            inputs[1].Data.Keyboard.Flags = KEY_UP;
            uint sent = SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT)));
            if (sent != 2) throw new InvalidOperationException("SendInput key press failed");
        }

        public static bool StopPressed()
        {
            return (GetAsyncKeyState(VK_F8) & 0x8000) != 0;
        }
    }
}
'@ | Out-Null

[BalatroPilotNative.Native]::EnableDpiAwareness()
$script:TargetHandle = [long]0

function Write-Response([hashtable]$Value) {
    [Console]::Out.WriteLine(($Value | ConvertTo-Json -Depth 8 -Compress))
    [Console]::Out.Flush()
}

function Require-Target {
    if ($script:TargetHandle -eq 0 -or -not [BalatroPilotNative.Native]::WindowExists($script:TargetHandle)) {
        throw "Target window is not set or no longer exists"
    }
}

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    try {
        $request = $line | ConvertFrom-Json
        switch ($request.command) {
            "ping" {
                Write-Response @{ ok = $true; platform = "windows"; protocol = 1 }
            }
            "list_windows" {
                $windows = [BalatroPilotNative.Native]::ListWindows()
                Write-Response @{ ok = $true; windows = @($windows) }
            }
            "locate" {
                $needle = [string]$request.title
                if ([string]::IsNullOrWhiteSpace($needle)) { throw "title is required" }
                $match = [BalatroPilotNative.Native]::ListWindows() |
                    Where-Object { $_.Title.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0 } |
                    Select-Object -First 1
                if ($null -eq $match) { throw "No visible window title contains '$needle'" }
                $script:TargetHandle = [long]$match.Handle
                Write-Response @{ ok = $true; handle = $script:TargetHandle; title = $match.Title }
            }
            "focus" {
                Require-Target
                $focused = [BalatroPilotNative.Native]::Focus($script:TargetHandle)
                Write-Response @{ ok = $true; focused = $focused }
            }
            "screenshot" {
                Require-Target
                $includeImage = if ($null -ne $request.includeImage) { [bool]$request.includeImage } else { $true }
                $capture = [BalatroPilotNative.Native]::CaptureClient($script:TargetHandle, $includeImage)
                Write-Response @{
                    ok = $true
                    pngBase64 = $capture.PngBase64
                    modelImageBase64 = $capture.ModelImageBase64
                    modelImageMimeType = $capture.ModelImageMimeType
                    signature = $capture.Signature
                    signatureCellBytes = $capture.SignatureCellBytes
                    width = $capture.Width
                    height = $capture.Height
                    clientWidth = $capture.ClientWidth
                    clientHeight = $capture.ClientHeight
                    screenX = $capture.ScreenX
                    screenY = $capture.ScreenY
                    method = $capture.Method
                }
            }
            "detect_unlock_overlay" {
                Require-Target
                $detection = [BalatroPilotNative.Native]::DetectUnlockOverlay($script:TargetHandle)
                Write-Response @{
                    ok = $true
                    detected = $detection.Detected
                    buttonX = $detection.ButtonX
                    buttonY = $detection.ButtonY
                    orangeRatio = $detection.OrangeRatio
                }
            }
            "move" {
                Require-Target
                if ([BalatroPilotNative.Native]::StopPressed()) { throw "Emergency stop is active (F8)" }
                [BalatroPilotNative.Native]::Move(
                    $script:TargetHandle,
                    [double]$request.x,
                    [double]$request.y
                )
                Write-Response @{ ok = $true }
            }
            "click" {
                Require-Target
                if ([BalatroPilotNative.Native]::StopPressed()) { throw "Emergency stop is active (F8)" }
                $button = if ($request.button) { [string]$request.button } else { "left" }
                if ($button -notin @("left", "right")) { throw "button must be left or right" }
                $count = if ($request.count) { [int]$request.count } else { 1 }
                if ($count -lt 1 -or $count -gt 2) { throw "count must be 1 or 2" }
                [BalatroPilotNative.Native]::Click(
                    $script:TargetHandle,
                    [double]$request.x,
                    [double]$request.y,
                    $button,
                    $count
                )
                Write-Response @{ ok = $true }
            }
            "key" {
                Require-Target
                if ([BalatroPilotNative.Native]::StopPressed()) { throw "Emergency stop is active (F8)" }
                [BalatroPilotNative.Native]::PressKey([string]$request.key)
                Write-Response @{ ok = $true }
            }
            "stop_pressed" {
                Write-Response @{ ok = $true; pressed = [BalatroPilotNative.Native]::StopPressed() }
            }
            "exit" {
                Write-Response @{ ok = $true }
                break
            }
            default { throw "Unknown command: $($request.command)" }
        }
        if ($request.command -eq "exit") { break }
    }
    catch {
        Write-Response @{ ok = $false; error = $_.Exception.Message }
    }
}
