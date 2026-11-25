Set-StrictMode -Version 2
$ErrorActionPreference = "Stop"

function New-NativeServiceDefinition {
  param(
    [Parameter(Mandatory = $true)]$Layout,
    [Parameter(Mandatory = $true)][string]$Name
  )

  Copy-Item -LiteralPath (Join-Path $Layout.ServiceDir "TdaiMemoryService.exe") `
    -Destination (Join-Path $Layout.ServiceDir "$Name.exe") -Force
}
