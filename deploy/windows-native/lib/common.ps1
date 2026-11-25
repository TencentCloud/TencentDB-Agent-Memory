Set-StrictMode -Version 2
$ErrorActionPreference = "Stop"

function Get-NativeLayout {
  param([Parameter(Mandatory = $true)][string]$InstallDir)

  $root = [IO.Path]::GetFullPath($InstallDir)
  return [pscustomobject]@{
    Root = $root
    AppDir = Join-Path $root "app"
    ConfigDir = Join-Path $root "config"
    DataDir = Join-Path $root "data"
    LogDir = Join-Path $root "logs"
    RunDir = Join-Path $root "run"
    ServiceDir = Join-Path $root "service"
    NodeExe = Join-Path $root "runtime\node\node.exe"
    EnvironmentFile = Join-Path $root "config\environment.json"
    AdminKeyFile = Join-Path $root "config\admin.key"
    ProcessFile = Join-Path $root "run\processes.json"
  }
}

function Write-NativeJson {
  param(
    [Parameter(Mandatory = $true)]$Value,
    [Parameter(Mandatory = $true)][string]$Path
  )

  $json = $Value | ConvertTo-Json -Depth 20
  [IO.File]::WriteAllText($Path, $json + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
}

function Read-NativeEnvironment {
  param([Parameter(Mandatory = $true)][string]$Path)
  return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
}

function Wait-NativeHealth {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Url,
    $Process,
    [int]$TimeoutSeconds = 90
  )

  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  $lastError = ""
  while ([DateTime]::UtcNow -lt $deadline) {
    if ($null -ne $Process) {
      $Process.Refresh()
      if ($Process.HasExited) {
        throw "$Name exited with code $($Process.ExitCode) before becoming healthy. See $Url and the component logs."
      }
    }
    try {
      $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3
      if ($response.StatusCode -eq 200) {
        Write-Host "$Name is healthy: $Url"
        return
      }
      $lastError = "HTTP $($response.StatusCode)"
    } catch {
      $lastError = $_.Exception.Message
    }
    Start-Sleep -Milliseconds 500
  }
  throw "$Name did not become healthy within $TimeoutSeconds seconds. Last error: $lastError"
}

function Start-NativeComponent {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)]$Layout,
    [Parameter(Mandatory = $true)]$Environment,
    [Parameter(Mandatory = $true)][string]$WorkingDirectory,
    [Parameter(Mandatory = $true)][string]$Arguments
  )

  Write-Host "正在启动 $Name……"
  $stdout = Join-Path $Layout.LogDir "$Name.out.log"
  $stderr = Join-Path $Layout.LogDir "$Name.err.log"
  foreach ($path in @($stdout, $stderr)) {
    if (Test-Path -LiteralPath $path) {
      Move-Item -LiteralPath $path -Destination "$path.prev" -Force
    }
  }

  $previous = @{}
  foreach ($property in $Environment.PSObject.Properties) {
    $previous[$property.Name] = [Environment]::GetEnvironmentVariable($property.Name, "Process")
    [Environment]::SetEnvironmentVariable($property.Name, [string]$property.Value, "Process")
  }

  try {
    $process = Start-Process -FilePath $Layout.NodeExe -ArgumentList $Arguments `
      -WorkingDirectory $WorkingDirectory -RedirectStandardOutput $stdout `
      -RedirectStandardError $stderr -WindowStyle Hidden -PassThru
  } finally {
    foreach ($variableName in $previous.Keys) {
      [Environment]::SetEnvironmentVariable($variableName, $previous[$variableName], "Process")
    }
  }

  return [pscustomobject]@{
    Name = $Name
    Id = $process.Id
    Process = $process
    Stdout = $stdout
    Stderr = $stderr
  }
}

function Save-NativeProcessRegistry {
  param(
    [Parameter(Mandatory = $true)]$Layout,
    [Parameter(Mandatory = $true)]$Components
  )

  $records = @($Components | ForEach-Object {
    [pscustomobject]@{
      Name = $_.Name
      Id = $_.Id
      NodeExe = $Layout.NodeExe
    }
  })
  Write-NativeJson -Value $records -Path $Layout.ProcessFile
}

function Initialize-NativeAdmin {
  param(
    [Parameter(Mandatory = $true)]$Layout,
    [Parameter(Mandatory = $true)][int]$Port,
    [string]$Username = "admin"
  )

  $key = [IO.File]::ReadAllText($Layout.AdminKeyFile).Trim()
  if (-not $key) {
    throw "Admin key file is empty: $($Layout.AdminKeyFile)"
  }

  $headers = @{ "x-tdai-service-id" = "default" }
  $body = @{ username = $Username; user_key = $key } | ConvertTo-Json -Compress
  $status = 0
  try {
    $response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/v3/internal/meta/user/init-admin" `
      -Method Post -Headers $headers -ContentType "application/json" -Body $body -UseBasicParsing -TimeoutSec 10
    $status = $response.StatusCode
  } catch {
    if ($null -eq $_.Exception.Response) {
      throw
    }
    $status = [int]$_.Exception.Response.StatusCode
  }
  if ($status -ne 200 -and $status -ne 409) {
    throw "init-admin returned HTTP $status"
  }

  $verifyBody = @{ user_key = $key } | ConvertTo-Json -Compress
  $verify = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/v3/meta/auth/verify" `
    -Method Post -Headers $headers -ContentType "application/json" -Body $verifyBody -UseBasicParsing -TimeoutSec 10
  if ($verify.StatusCode -ne 200) {
    throw "auth/verify returned HTTP $($verify.StatusCode)"
  }
  Write-Host "Core admin key is initialized and verified."
}

function Test-NativeServiceSet {
  $names = @("TdaiMemoryCore", "TdaiMemoryKnowledge", "TdaiMemoryPanel", "TdaiMemoryProxy")
  foreach ($name in $names) {
    if ($null -eq (Get-Service -Name $name -ErrorAction SilentlyContinue)) {
      return $false
    }
  }
  return $true
}

function Stop-NativeServiceSet {
  foreach ($name in @("TdaiMemoryProxy", "TdaiMemoryPanel", "TdaiMemoryKnowledge", "TdaiMemoryCore")) {
    $service = Get-Service -Name $name -ErrorAction SilentlyContinue
    if ($null -ne $service -and $service.Status -ne "Stopped") {
      Stop-Service -Name $name -Force
      $service.WaitForStatus("Stopped", [TimeSpan]::FromSeconds(30))
    }
  }
}

function Invoke-Robocopy {
  param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination,
    [string[]]$ExcludedDirectories = @()
  )

  $arguments = @('"' + $Source + '"', '"' + $Destination + '"', "/E", "/R:2", "/W:1", "/NFL", "/NDL", "/NJH", "/NJS", "/NP")
  if ($ExcludedDirectories.Count -gt 0) {
    $arguments += "/XD"
    $arguments += $ExcludedDirectories | ForEach-Object { '"' + $_ + '"' }
  }
  $robocopy = Join-Path $env:SystemRoot "System32\robocopy.exe"
  $process = Start-Process -FilePath $robocopy -ArgumentList ($arguments -join " ") -Wait -PassThru -NoNewWindow
  if ($process.ExitCode -gt 7) {
    throw "robocopy failed with exit code $($process.ExitCode): $Source -> $Destination"
  }
  $global:LASTEXITCODE = 0
}

function Invoke-Icacls {
  param(
    [Parameter(Mandatory = $true)][string]$Target,
    [Parameter(Mandatory = $true)][string[]]$Arguments
  )

  $icacls = Join-Path $env:SystemRoot "System32\icacls.exe"
  $commandArguments = @('"' + $Target + '"') + $Arguments + "/Q"
  $process = Start-Process -FilePath $icacls -ArgumentList ($commandArguments -join " ") -Wait -PassThru -NoNewWindow
  if ($process.ExitCode -ne 0) {
    throw "icacls failed with exit code $($process.ExitCode): $Target"
  }
  $global:LASTEXITCODE = 0
}
