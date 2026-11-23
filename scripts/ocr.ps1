[CmdletBinding()]
param(
    [string]$ImagePath = ''
)

$ErrorActionPreference = 'Stop'
$script:emitted = $false

# Redirected stdout is UTF-8 without a BOM; PowerShell 5.1 otherwise writes in
# the console code page, which would corrupt non-ASCII OCR text.
try {
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch { }

function Write-OcrJson([string]$Text) {
    if ($script:emitted) { return }
    $script:emitted = $true
    try {
        $json = @{ text = $Text } | ConvertTo-Json -Compress
        [Console]::Out.WriteLine($json)
        [Console]::Out.Flush()
    } catch { }
}

try {
    if ([string]::IsNullOrWhiteSpace($ImagePath)) {
        Write-OcrJson ''
        exit 0
    }

    [void][Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
    [void][Windows.Storage.FileAccessMode, Windows.Storage, ContentType = WindowsRuntime]
    [void][Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
    [void][Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
    [void][Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
    [void][Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType = WindowsRuntime]
    [void][Windows.Media.Ocr.OcrResult, Windows.Media.Ocr, ContentType = WindowsRuntime]

    Add-Type -AssemblyName System.Runtime.WindowsRuntime

    # WinRT IAsyncOperation<T> is not awaitable from Windows PowerShell 5.1;
    # adapt it to a .NET Task with the framework's own AsTask<T> helper.
    $asTaskMethods = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and
        $_.IsGenericMethod -and
        $_.GetParameters().Count -eq 1 -and
        $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    }
    $asTaskGeneric = @($asTaskMethods)[0]
    if ($null -eq $asTaskGeneric) { throw 'AsTask helper is unavailable' }

    function Await-WinRt($Operation, [Type]$ResultType) {
        $task = $asTaskGeneric.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
        [void]$task.Wait()
        return $task.Result
    }

    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    if ($null -eq $engine) {
        Write-OcrJson ''
        exit 0
    }

    $file = Await-WinRt ([Windows.Storage.StorageFile]::GetFileFromPathAsync($ImagePath)) ([Windows.Storage.StorageFile])
    $stream = Await-WinRt ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    try {
        $decoder = Await-WinRt ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
        $bitmap = Await-WinRt ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
        try {
            $ocr = Await-WinRt ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
            $text = if ($null -ne $ocr) { [string]$ocr.Text } else { '' }
            Write-OcrJson $text
        } finally {
            if ($null -ne $bitmap) { $bitmap.Dispose() }
        }
    } finally {
        if ($null -ne $stream) { $stream.Dispose() }
    }
} catch {
    Write-OcrJson ''
}

exit 0
