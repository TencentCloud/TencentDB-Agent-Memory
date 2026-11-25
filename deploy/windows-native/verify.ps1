param(
  [string]$InstallDir = (Split-Path -Parent $PSScriptRoot)
)

Set-StrictMode -Version 2
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "lib\common.ps1")

$layout = Get-NativeLayout -InstallDir $InstallDir
$environment = Read-NativeEnvironment -Path $layout.EnvironmentFile
$proxyConfig = Get-Content -LiteralPath (Join-Path $layout.ConfigDir "proxy.yaml") -Raw | ConvertFrom-Json
$targets = @(
  [pscustomobject]@{ Name = "Core"; Url = "http://127.0.0.1:$($environment.Core.TDAI_GATEWAY_PORT)/health" },
  [pscustomobject]@{ Name = "Knowledge"; Url = "http://127.0.0.1:$($environment.Knowledge.PORT)/health" },
  [pscustomobject]@{ Name = "Panel"; Url = "http://127.0.0.1:$($environment.Panel.PORT)/health" },
  [pscustomobject]@{ Name = "Proxy"; Url = "http://127.0.0.1:$($proxyConfig.server.port)/health" }
)
$results = @()
foreach ($target in $targets) {
  try {
    $response = Invoke-WebRequest -Uri $target.Url -UseBasicParsing -TimeoutSec 10
    $healthy = $response.StatusCode -eq 200
    $detail = "HTTP $($response.StatusCode)"
    if ($target.Name -eq "Core") {
      $health = $response.Content | ConvertFrom-Json
      $healthy = $healthy -and $health.status -eq "ok" -and $health.stores.vectorStore
      $detail += "; status=$($health.status); vectorStore=$($health.stores.vectorStore)"
    } elseif ($target.Name -eq "Knowledge") {
      $health = $response.Content | ConvertFrom-Json
      $healthy = $healthy -and $health.status -eq "ok"
      $detail += "; status=$($health.status)"
    } elseif ($target.Name -eq "Proxy") {
      $health = $response.Content | ConvertFrom-Json
      $healthy = $healthy -and $health.status -eq "ok" -and $health.storage.effective -eq "sqlite"
      $detail += "; status=$($health.status); storage=$($health.storage.effective)"
    }
    $results += [pscustomobject]@{ Component = $target.Name; Healthy = $healthy; Detail = $detail }
  } catch {
    $results += [pscustomobject]@{ Component = $target.Name; Healthy = $false; Detail = $_.Exception.Message }
  }
}

try {
  $key = [IO.File]::ReadAllText($layout.AdminKeyFile).Trim()
  $headers = @{ "x-tdai-service-id" = "default" }
  $body = @{ user_key = $key } | ConvertTo-Json -Compress
  $response = Invoke-WebRequest -Uri "http://127.0.0.1:$($environment.Core.TDAI_GATEWAY_PORT)/v3/meta/auth/verify" `
    -Method Post -Headers $headers -ContentType "application/json" -Body $body -UseBasicParsing -TimeoutSec 10
  $results += [pscustomobject]@{ Component = "Core admin auth"; Healthy = $response.StatusCode -eq 200; Detail = "HTTP $($response.StatusCode)" }
} catch {
  $results += [pscustomobject]@{ Component = "Core admin auth"; Healthy = $false; Detail = $_.Exception.Message }
}

try {
  $panelRoot = Invoke-WebRequest -Uri "http://127.0.0.1:$($environment.Panel.PORT)/" -UseBasicParsing -TimeoutSec 10
  $match = [regex]::Match($panelRoot.Content, '(?:src|href)="(?<path>[^"]+\.(?:js|css))"')
  if (-not $match.Success) {
    throw "Panel HTML did not reference a JavaScript or CSS asset."
  }
  $assetUri = New-Object Uri(New-Object Uri("http://127.0.0.1:$($environment.Panel.PORT)/"), $match.Groups["path"].Value)
  $asset = Invoke-WebRequest -Uri $assetUri -UseBasicParsing -TimeoutSec 10
  $results += [pscustomobject]@{ Component = "Panel UI asset"; Healthy = $asset.StatusCode -eq 200; Detail = "HTTP $($asset.StatusCode)" }
} catch {
  $results += [pscustomobject]@{ Component = "Panel UI asset"; Healthy = $false; Detail = $_.Exception.Message }
}

$results | Format-Table -AutoSize
if (@($results | Where-Object { -not $_.Healthy }).Count -gt 0) {
  exit 1
}
