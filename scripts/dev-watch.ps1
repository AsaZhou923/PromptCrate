$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")

$jobs = @(
  Start-Job -Name "promptcrate-extension-watch" -ScriptBlock {
    param($workspace)
    Set-Location $workspace
    pnpm exec vite build --watch
  } -ArgumentList $repoRoot,
  Start-Job -Name "promptcrate-content-watch" -ScriptBlock {
    param($workspace)
    Set-Location $workspace
    pnpm exec vite build --config vite.content.config.ts --watch
  } -ArgumentList $repoRoot
)

try {
  while (($jobs | Where-Object { $_.State -eq "Running" }).Count -gt 0) {
    Receive-Job -Job $jobs
    Start-Sleep -Seconds 1
  }

  Receive-Job -Job $jobs
} finally {
  Stop-Job -Job $jobs -ErrorAction SilentlyContinue
  Remove-Job -Job $jobs -Force -ErrorAction SilentlyContinue
}
