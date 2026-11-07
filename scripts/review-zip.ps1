param([ValidatePattern('^[a-zA-Z0-9_-]+\.zip$')][string]$ArchiveName = 'my-schedule-source-review.zip')
$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$outputDirectory = Join-Path $projectRoot 'artifacts'
if (Test-Path -LiteralPath $outputDirectory) {
    if ((Get-Item -LiteralPath $outputDirectory -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw 'Refusing a linked artifacts directory'
    }
}
$manifestLines = & node (Join-Path $PSScriptRoot 'review-manifest.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Source screening failed; archive was not created' }
$manifestText = $manifestLines -join "`n"
$manifest = $manifestText | ConvertFrom-Json
[IO.Directory]::CreateDirectory($outputDirectory) | Out-Null
$archivePath = Join-Path $outputDirectory $ArchiveName
Add-Type -AssemblyName System.IO.Compression
$stream = [IO.File]::Open($archivePath, [IO.FileMode]::CreateNew)
try {
    $zip = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($file in $manifest.files) {
            $sourcePath = [IO.Path]::GetFullPath((Join-Path $projectRoot $file.path))
            if (-not $sourcePath.StartsWith($projectRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Path escapes project' }
            $bytes = [IO.File]::ReadAllBytes($sourcePath)
            $sha = [Security.Cryptography.SHA256]::Create()
            try { $hash = [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }
            if ($hash -ne $file.sha256) { throw "Source changed during packaging: $($file.path)" }
            $entry = $zip.CreateEntry('my-schedule-app/' + $file.path)
            $entryStream = $entry.Open()
            try { $entryStream.Write($bytes, 0, $bytes.Length) } finally { $entryStream.Dispose() }
        }
        $entry = $zip.CreateEntry('my-schedule-app/REVIEW-MANIFEST.json')
        $entryStream = $entry.Open()
        $manifestBytes = [Text.UTF8Encoding]::new($false).GetBytes($manifestText)
        try { $entryStream.Write($manifestBytes, 0, $manifestBytes.Length) } finally { $entryStream.Dispose() }
    } finally { $zip.Dispose() }
} finally { $stream.Dispose() }
# Independently reopen every entry and verify names and uncompressed hashes.
$readStream = [IO.File]::OpenRead($archivePath)
try {
    $zip = [IO.Compression.ZipArchive]::new($readStream, [IO.Compression.ZipArchiveMode]::Read)
    try {
        if ($zip.Entries.Count -ne $manifest.files.Count + 1) { throw 'Unexpected ZIP entry count' }
        foreach ($file in $manifest.files) {
            $entry = $zip.GetEntry('my-schedule-app/' + $file.path)
            if ($null -eq $entry) { throw 'Missing ZIP entry' }
            $entryStream = $entry.Open()
            $sha = [Security.Cryptography.SHA256]::Create()
            try { $hash = [BitConverter]::ToString($sha.ComputeHash($entryStream)).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose(); $entryStream.Dispose() }
            if ($hash -ne $file.sha256) { throw "ZIP verification failed: $($file.path)" }
        }
    } finally { $zip.Dispose() }
} finally { $readStream.Dispose() }
Write-Output "Verified ZIP: $archivePath"
Get-FileHash -LiteralPath $archivePath -Algorithm SHA256
