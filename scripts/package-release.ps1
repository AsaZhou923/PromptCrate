$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$packageJsonPath = Join-Path $repoRoot "package.json"
$packageJson = Get-Content -LiteralPath $packageJsonPath -Raw | ConvertFrom-Json
$version = $packageJson.version
$releaseDir = Join-Path $repoRoot "release"
$distDir = Join-Path $repoRoot "dist"
$zipPath = Join-Path $releaseDir "promptcrate-$version.zip"

Set-Location $repoRoot
pnpm build

if (-not (Test-Path -LiteralPath $distDir)) {
  throw "dist directory was not created"
}

New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null
if (Test-Path -LiteralPath $zipPath) {
  Remove-Item -LiteralPath $zipPath
}

Compress-Archive -Path (Join-Path $distDir "*") -DestinationPath $zipPath -CompressionLevel Optimal
Write-Host "Created $zipPath"
