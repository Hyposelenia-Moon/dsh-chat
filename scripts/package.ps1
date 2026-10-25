param([Parameter(Mandatory=$true)][string]$OutputPath)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$sourceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$archivePath = [IO.Path]::GetFullPath($OutputPath)
if ([IO.Path]::GetExtension($archivePath) -ne '.zip') { throw 'OutputPath must end with .zip' }
if (Test-Path -LiteralPath $archivePath) { throw 'Output already exists; choose a new filename.' }
$outputDirectory = [IO.Path]::GetDirectoryName($archivePath)
[IO.Directory]::CreateDirectory($outputDirectory) | Out-Null
$files = [Collections.Generic.List[IO.FileInfo]]::new()
function Collect-SourceFiles([string]$Directory) {
  foreach ($entry in Get-ChildItem -LiteralPath $Directory -Force) {
    if ($entry.PSIsContainer) {
      if ($entry.Name -notin @('node_modules','data','.git')) { Collect-SourceFiles $entry.FullName }
    } else {
      $relative = [IO.Path]::GetRelativePath($sourceRoot,$entry.FullName).Replace('\','/')
      if ($relative -eq 'config/config.yaml' -or $entry.Name -like '.env*' -or $entry.Name -like '*.tmp' -or $entry.Name -eq 'SHA256SUMS.txt') { continue }
      $files.Add($entry)
    }
  }
}
Collect-SourceFiles $sourceRoot
$zip = [IO.Compression.ZipFile]::Open($archivePath,[IO.Compression.ZipArchiveMode]::Create)
try {
  $sums = [Collections.Generic.List[string]]::new()
  foreach ($file in ($files | Sort-Object FullName)) {
    $relative = [IO.Path]::GetRelativePath($sourceRoot,$file.FullName).Replace('\','/')
    [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip,$file.FullName,('dsh-chat/'+$relative),[IO.Compression.CompressionLevel]::Optimal) | Out-Null
    $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    $sums.Add($hash+'  '+$relative)
  }
  $manifest = $zip.CreateEntry('dsh-chat/SHA256SUMS.txt')
  $writer = [IO.StreamWriter]::new($manifest.Open(),[Text.UTF8Encoding]::new($false))
  try { $writer.Write(($sums -join "`n")+"`n") } finally { $writer.Dispose() }
} finally { $zip.Dispose() }
$result = Get-Item -LiteralPath $archivePath
[pscustomobject]@{Path=$archivePath;Files=$files.Count+1;Bytes=$result.Length;SHA256=(Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()}
