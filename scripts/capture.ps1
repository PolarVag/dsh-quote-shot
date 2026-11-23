param(
    [Parameter(Mandatory = $true)]
    [string]$OutPath,

    [Parameter(Mandatory = $true)]
    [string]$ContextPath
)

$ErrorActionPreference = 'Stop'

# The host reads stdout as UTF-8. Windows PowerShell 5.1 defaults to the
# console code page, so force UTF-8 explicitly for the single JSON line.
try {
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
} catch {
    # No console handle (fully redirected): the raw stream write below still
    # guarantees UTF-8 bytes.
}

$script:result = $null
$script:emitted = $false

function Write-Utf8JsonLine([string]$line) {
    $encoding = New-Object System.Text.UTF8Encoding($false)
    $bytes = $encoding.GetBytes($line + "`n")
    $stream = [Console]::OpenStandardOutput()
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush()
}

try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing

    # PerMonitorV2 first (Windows 10 1703+), then the legacy system-DPI call.
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class QuoteShotDpi
{
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetProcessDpiAwarenessContext(IntPtr dpiContext);

    [DllImport("user32.dll")]
    public static extern bool SetProcessDPIAware();

    [DllImport("user32.dll")]
    public static extern uint GetDpiForWindow(IntPtr hwnd);
}
'@

    $dpiAware = $false
    try {
        $dpiAware = [QuoteShotDpi]::SetProcessDpiAwarenessContext([IntPtr](-4))
    } catch {
        $dpiAware = $false
    }
    if (-not $dpiAware) {
        try { [void][QuoteShotDpi]::SetProcessDPIAware() } catch { }
    }

    # Query geometry only after DPI awareness is set: VirtualScreen and
    # CopyFromScreen must speak the same physical-pixel coordinate system.
    $script:vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
    [Console]::Error.WriteLine(("quote-shot: virtual-screen {0},{1} {2}x{3}" -f $script:vs.X, $script:vs.Y, $script:vs.Width, $script:vs.Height))

    $script:frozen = New-Object System.Drawing.Bitmap($script:vs.Width, $script:vs.Height)
    $frozenGraphics = [System.Drawing.Graphics]::FromImage($script:frozen)
    try {
        $frozenGraphics.CopyFromScreen($script:vs.X, $script:vs.Y, 0, 0, $script:vs.Size)
    } finally {
        $frozenGraphics.Dispose()
    }

    $script:state = 'selecting'
    $script:rect = [System.Drawing.Rectangle]::Empty
    $script:start = [System.Drawing.Point]::Empty
    $script:dragging = $false
    $script:hover = $null
    $script:buttons = @()
    $script:scale = 1.0

    function Get-ScalePx([double]$value) {
        $scaled = [Math]::Round($value * $script:scale)
        if ($scaled -lt 1) { return 1 }
        return [int]$scaled
    }

    # Control.DeviceDpi is not trustworthy before the window handle exists (it
    # can report 96 on a 125 %/150 % display). Ask GetDpiForWindow once the
    # handle is live, then fall back to DeviceDpi, then to 100 %.
    function Update-DpiScale {
        $dpi = 0
        try {
            if ($script:form -and $script:form.IsHandleCreated) {
                $dpi = [int][QuoteShotDpi]::GetDpiForWindow($script:form.Handle)
            }
        } catch {
            $dpi = 0
        }
        if ($dpi -le 0 -and $script:form) {
            try { $dpi = [int]$script:form.DeviceDpi } catch { $dpi = 0 }
        }
        if ($dpi -le 0) { $dpi = 96 }
        $script:scale = [double]$dpi / 96.0
        if ($script:scale -le 0) { $script:scale = 1.0 }
        [Console]::Error.WriteLine(("quote-shot: dpi {0} scale {1}" -f $dpi, $script:scale))
    }

    function Save-Crop([System.Drawing.Rectangle]$rect, [string]$path) {
        $dir = [System.IO.Path]::GetDirectoryName($path)
        if ($dir -and -not [System.IO.Directory]::Exists($dir)) {
            [void][System.IO.Directory]::CreateDirectory($dir)
        }
        $crop = New-Object System.Drawing.Bitmap($rect.Width, $rect.Height)
        try {
            $cropGraphics = [System.Drawing.Graphics]::FromImage($crop)
            try {
                $dest = New-Object System.Drawing.Rectangle(0, 0, $rect.Width, $rect.Height)
                $cropGraphics.DrawImage($script:frozen, $dest, $rect, [System.Drawing.GraphicsUnit]::Pixel)
            } finally {
                $cropGraphics.Dispose()
            }
            $crop.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
        } finally {
            $crop.Dispose()
        }
    }

    function Set-ErrorResult([System.Exception]$exception) {
        if (-not $script:result) {
            $message = 'capture failed'
            if ($exception -and $exception.Message) { $message = $exception.Message }
            $script:result = [ordered]@{ action = 'error'; message = $message }
        }
        try { $script:form.Close() } catch { }
    }

    function Cancel-Overlay {
        if (-not $script:result) {
            $script:result = [ordered]@{ action = 'cancel' }
        }
        try { $script:form.Close() } catch { }
    }

    function Update-ActionButtons {
        $r = $script:rect
        $script:buttons = @()
        if ($r.Width -le 0 -or $r.Height -le 0) { return }

        $padX = Get-ScalePx 13
        $padY = Get-ScalePx 7
        $gap = Get-ScalePx 7
        $margin = Get-ScalePx 6

        $font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Point)
        # Measure with the form's own DPI-aware Graphics. A 96-DPI bitmap
        # under-measures at 125 %/150 % and the labels would wrap or clip.
        $measureGraphics = $script:form.CreateGraphics()
        try {
            $askSize = $measureGraphics.MeasureString('向DSH提问', $font)
            $saveSize = $measureGraphics.MeasureString('另存为', $font)
        } finally {
            $measureGraphics.Dispose()
            $font.Dispose()
        }

        $height = [Math]::Max((Get-ScalePx 34), [int][Math]::Ceiling($askSize.Height) + 2 * $padY)
        $askWidth = [int][Math]::Ceiling($askSize.Width) + 2 * $padX
        $saveWidth = [int][Math]::Ceiling($saveSize.Width) + 2 * $padX
        $totalWidth = $askWidth + $gap + $saveWidth

        # Default: bottom-right of the selection. Flip above when there is no
        # room below, and pull left/clamp when the bar would leave the screen.
        $left = $r.Right - $totalWidth
        if ($left -lt 0 -or $left + $totalWidth -gt $script:vs.Width) {
            $left = $r.Left
        }
        if ($left + $totalWidth -gt $script:vs.Width) {
            $left = $script:vs.Width - $totalWidth
        }
        if ($left -lt 0) { $left = 0 }

        $top = $r.Bottom + $margin
        if ($top + $height -gt $script:vs.Height) {
            $top = $r.Top - $margin - $height
            if ($top -lt 0) {
                $top = [Math]::Min([Math]::Max(0, $r.Bottom - $height), $script:vs.Height - $height)
            }
        }
        if ($top -lt 0) { $top = 0 }

        $script:buttons = @(
            [pscustomobject]@{
                Kind = 'ask'
                Label = '向DSH提问'
                Bounds = (New-Object System.Drawing.Rectangle($left, $top, $askWidth, $height))
            },
            [pscustomobject]@{
                Kind = 'save'
                Label = '另存为'
                Bounds = (New-Object System.Drawing.Rectangle(($left + $askWidth + $gap), $top, $saveWidth, $height))
            }
        )
    }

    function Get-RoundedPath([System.Drawing.Rectangle]$bounds, [int]$radius) {
        $path = New-Object System.Drawing.Drawing2D.GraphicsPath
        $diameter = $radius * 2
        $path.AddArc($bounds.X, $bounds.Y, $diameter, $diameter, 180, 90)
        $path.AddArc($bounds.Right - $diameter, $bounds.Y, $diameter, $diameter, 270, 90)
        $path.AddArc($bounds.Right - $diameter, $bounds.Bottom - $diameter, $diameter, $diameter, 0, 90)
        $path.AddArc($bounds.X, $bounds.Bottom - $diameter, $diameter, $diameter, 90, 90)
        $path.CloseFigure()
        return $path
    }

    function Draw-SizeLabel($graphics, [System.Drawing.Rectangle]$r) {
        $label = '{0} × {1}' -f $r.Width, $r.Height
        $font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Point)
        try {
            $size = $graphics.MeasureString($label, $font)
            $padX = Get-ScalePx 8
            $padY = Get-ScalePx 4
            $width = [int][Math]::Ceiling($size.Width) + 2 * $padX
            $height = [int][Math]::Ceiling($size.Height) + 2 * $padY
            $x = $r.Left
            $y = $r.Top - $height - (Get-ScalePx 6)
            if ($y -lt 0) { $y = $r.Top + (Get-ScalePx 6) }
            if ($x + $width -gt $script:vs.Width) { $x = $script:vs.Width - $width }
            if ($x -lt 0) { $x = 0 }

            $background = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(215, 20, 20, 20))
            $foreground = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
            try {
                $graphics.FillRectangle($background, $x, $y, $width, $height)
                $graphics.DrawString($label, $font, $foreground, [single]($x + $padX), [single]($y + $padY))
            } finally {
                $background.Dispose()
                $foreground.Dispose()
            }
        } finally {
            $font.Dispose()
        }
    }

    function Draw-Buttons($graphics) {
        if ($script:buttons.Count -eq 0) { return }
        $previousMode = $graphics.SmoothingMode
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Point)
        $textBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
        try {
            foreach ($button in $script:buttons) {
                if ($button.Kind -eq 'ask') {
                    $fillColor = [System.Drawing.Color]::FromArgb(255, 12, 110, 235)
                    if ($script:hover -eq 'ask') {
                        $fillColor = [System.Drawing.Color]::FromArgb(255, 40, 140, 255)
                    }
                } else {
                    $fillColor = [System.Drawing.Color]::FromArgb(255, 52, 55, 62)
                    if ($script:hover -eq 'save') {
                        $fillColor = [System.Drawing.Color]::FromArgb(255, 76, 80, 90)
                    }
                }

                $path = Get-RoundedPath $button.Bounds (Get-ScalePx 5)
                $fill = New-Object System.Drawing.SolidBrush ($fillColor)
                $format = New-Object System.Drawing.StringFormat
                try {
                    $format.Alignment = [System.Drawing.StringAlignment]::Center
                    $format.LineAlignment = [System.Drawing.StringAlignment]::Center
                    $graphics.FillPath($fill, $path)
                    $graphics.DrawString($button.Label, $font, $textBrush, [System.Drawing.RectangleF]$button.Bounds, $format)
                } finally {
                    $format.Dispose()
                    $fill.Dispose()
                    $path.Dispose()
                }
            }
        } finally {
            $textBrush.Dispose()
            $font.Dispose()
            $graphics.SmoothingMode = $previousMode
        }
    }

    function Draw-Overlay($graphics) {
        $graphics.DrawImageUnscaled($script:frozen, 0, 0)

        $r = $script:rect
        if ($r.Width -gt 0 -and $r.Height -gt 0) {
            $dim = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(112, 0, 0, 0))
            try {
                $graphics.FillRectangle($dim, 0, 0, $script:vs.Width, $r.Top)
                $graphics.FillRectangle($dim, 0, $r.Bottom, $script:vs.Width, [Math]::Max(0, $script:vs.Height - $r.Bottom))
                $graphics.FillRectangle($dim, 0, $r.Top, $r.Left, $r.Height)
                $graphics.FillRectangle($dim, $r.Right, $r.Top, [Math]::Max(0, $script:vs.Width - $r.Right), $r.Height)
            } finally {
                $dim.Dispose()
            }

            $border = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 0, 174, 239)), (Get-ScalePx 2)
            try {
                $graphics.DrawRectangle($border, $r.X, $r.Y, [Math]::Max(0, $r.Width - 1), [Math]::Max(0, $r.Height - 1))
            } finally {
                $border.Dispose()
            }

            Draw-SizeLabel $graphics $r
        }

        if ($script:state -eq 'actions') {
            Draw-Buttons $graphics
        }
    }

    function Complete-Ask {
        $r = $script:rect
        if ($r.Width -lt 8 -or $r.Height -lt 8) { return }
        Save-Crop $r $script:OutPath
        $script:result = [ordered]@{
            action = 'ask'
            rect = [ordered]@{
                x = [int]($script:vs.X + $r.X)
                y = [int]($script:vs.Y + $r.Y)
                width = [int]$r.Width
                height = [int]$r.Height
            }
        }
        $script:form.Close()
    }

    function Show-SaveAs {
        $dialog = New-Object System.Windows.Forms.SaveFileDialog
        try {
            $dialog.Title = '另存为'
            $dialog.Filter = 'PNG Image|*.png'
            $dialog.DefaultExt = 'png'
            $dialog.AddExtension = $true
            $dialog.OverwritePrompt = $true
            $dialog.RestoreDirectory = $true
            $dialog.FileName = '截图-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.png'
            $pictures = [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::MyPictures)
            if ($pictures) { $dialog.InitialDirectory = $pictures }

            # The overlay is topmost; temporarily drop it so the owned dialog
            # is never hidden behind the frozen full-screen form.
            $script:form.TopMost = $false
            try {
                $choice = $dialog.ShowDialog($script:form)
            } finally {
                $script:form.TopMost = $true
            }

            if ($choice -ne [System.Windows.Forms.DialogResult]::OK) {
                $script:hover = $null
                $script:form.Invalidate()
                return
            }

            $target = $dialog.FileName
            Save-Crop $script:rect $target
            $script:result = [ordered]@{ action = 'save'; path = $target }
            $script:form.Close()
        } finally {
            $dialog.Dispose()
        }
    }

    $script:form = New-Object System.Windows.Forms.Form
    $form = $script:form
    $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
    $form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
    $form.Bounds = $script:vs
    $form.TopMost = $true
    $form.ShowInTaskbar = $false
    $form.KeyPreview = $true
    $form.Cursor = [System.Windows.Forms.Cursors]::Cross
    $form.Text = 'dsh-quote-shot'
    $form.BackColor = [System.Drawing.Color]::Black
    $form.AutoScaleMode = [System.Windows.Forms.AutoScaleMode]::None

    # Scale is refreshed from HandleCreated/Shown below, after the form's real
    # window handle and monitor DPI are known.
    $script:scale = 1.0

    # Control.DoubleBuffered is protected; flip it through reflection so the
    # full-screen paint does not flicker while dragging.
    $doubleBuffered = [System.Windows.Forms.Control].GetProperty('DoubleBuffered', [System.Reflection.BindingFlags]'Instance,NonPublic')
    if ($doubleBuffered) {
        try { $doubleBuffered.SetValue($form, $true) } catch { }
    }

    $form.Add_HandleCreated({
        try { Update-DpiScale } catch { }
    })

    $form.Add_Paint({
        param($sender, $e)
        try {
            Draw-Overlay $e.Graphics
        } catch {
            Set-ErrorResult $_.Exception
        }
    })

    $form.Add_MouseDown({
        param($sender, $e)
        try {
            if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Right) {
                Cancel-Overlay
                return
            }
            if ($e.Button -ne [System.Windows.Forms.MouseButtons]::Left) { return }

            if ($script:state -eq 'actions') {
                foreach ($button in $script:buttons) {
                    if ($button.Bounds.Contains($e.Location)) {
                        if ($button.Kind -eq 'ask') {
                            Complete-Ask
                        } else {
                            Show-SaveAs
                        }
                        return
                    }
                }
                if (-not $script:rect.Contains($e.Location)) {
                    Cancel-Overlay
                }
                return
            }

            $script:dragging = $true
            $script:start = $e.Location
            $script:rect = New-Object System.Drawing.Rectangle($e.Location.X, $e.Location.Y, 0, 0)
            $script:buttons = @()
            $script:hover = $null
            $script:form.Invalidate()
        } catch {
            Set-ErrorResult $_.Exception
        }
    })

    $form.Add_MouseMove({
        param($sender, $e)
        try {
            if ($script:state -eq 'selecting' -and $script:dragging) {
                $x1 = [Math]::Min($script:start.X, $e.Location.X)
                $y1 = [Math]::Min($script:start.Y, $e.Location.Y)
                $x2 = [Math]::Max($script:start.X, $e.Location.X)
                $y2 = [Math]::Max($script:start.Y, $e.Location.Y)
                $script:rect = New-Object System.Drawing.Rectangle($x1, $y1, ($x2 - $x1), ($y2 - $y1))
                $script:form.Invalidate()
                return
            }

            if ($script:state -eq 'actions') {
                $hover = $null
                foreach ($button in $script:buttons) {
                    if ($button.Bounds.Contains($e.Location)) { $hover = $button.Kind }
                }
                if ($hover -ne $script:hover) {
                    $script:hover = $hover
                    if ($hover) {
                        $script:form.Cursor = [System.Windows.Forms.Cursors]::Hand
                    } else {
                        $script:form.Cursor = [System.Windows.Forms.Cursors]::Default
                    }
                    $script:form.Invalidate()
                }
            }
        } catch {
            Set-ErrorResult $_.Exception
        }
    })

    $form.Add_MouseUp({
        param($sender, $e)
        try {
            if ($e.Button -ne [System.Windows.Forms.MouseButtons]::Left) { return }
            if ($script:state -eq 'selecting' -and $script:dragging) {
                $script:dragging = $false
                if ($script:rect.Width -ge 8 -and $script:rect.Height -ge 8) {
                    $script:state = 'actions'
                    $script:hover = $null
                    Update-ActionButtons
                    $script:form.Cursor = [System.Windows.Forms.Cursors]::Default
                } else {
                    $script:state = 'selecting'
                    $script:rect = [System.Drawing.Rectangle]::Empty
                    $script:form.Cursor = [System.Windows.Forms.Cursors]::Cross
                }
                $script:form.Invalidate()
            }
        } catch {
            Set-ErrorResult $_.Exception
        }
    })

    $form.Add_KeyDown({
        param($sender, $e)
        try {
            if ($e.KeyCode -eq [System.Windows.Forms.Keys]::Escape) {
                $e.SuppressKeyPress = $true
                Cancel-Overlay
            }
        } catch {
            Set-ErrorResult $_.Exception
        }
    })

    $form.Add_Shown({
        try {
            # HandleCreated can run before the window settles on its monitor;
            # refresh the scale and re-layout any buttons already created.
            Update-DpiScale
            if ($script:state -eq 'actions' -and $script:rect.Width -gt 0) {
                Update-ActionButtons
                $script:form.Invalidate()
            }
            $script:form.Activate()
            $script:form.Focus()
        } catch { }
    })

    [void]$form.ShowDialog()

    # Reaching here without an explicit result means the form was closed by
    # Alt+F4 or another external close: treat that as cancel.
    if (-not $script:result) {
        $script:result = [ordered]@{ action = 'cancel' }
    }

    try { $form.Dispose() } catch { }
    try { $script:frozen.Dispose() } catch { }

    $json = $script:result | ConvertTo-Json -Compress -Depth 6
    Write-Utf8JsonLine $json
    $script:emitted = $true

    if ($script:result.action -eq 'error') { exit 1 }
    exit 0
} catch {
    [Console]::Error.WriteLine($_.Exception.ToString())
    if (-not $script:emitted) {
        try {
            $failure = [ordered]@{ action = 'error'; message = $_.Exception.Message } | ConvertTo-Json -Compress -Depth 4
            Write-Utf8JsonLine $failure
        } catch { }
    }
    exit 1
}
