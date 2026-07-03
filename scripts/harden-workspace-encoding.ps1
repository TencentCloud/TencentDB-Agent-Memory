<#
.SYNOPSIS
  Hardens Windows workspace encoding to prevent mojibake in Git pipelines.

.DESCRIPTION
  Implements Microsoft-recommended 5-layer defense against encoding corruption:
    Layer 1 - BOM:      Ensures PowerShell scripts have UTF-8 BOM
    Layer 2 - Git:      Forces UTF-8 encoding in Git config
    Layer 3 - Bypass:   Recommends -F over -m for non-ASCII commits
    Layer 4 - Pipeline:  Sets Out-File default to utf8
    Layer 5 - CI:       (handled by .github/workflows/pr-ci.yml)

.EXAMPLE
  .\harden-workspace-encoding.ps1 -Apply
  .\harden-workspace-encoding.ps1 -Check
#>

param(
    [switch]$Apply,
    [switch]$Check
)

$exitCode = 0

# ── Layer 2: Git config ─────────────────────────────────────────────
function Set-GitEncoding {
    Write-Host "[Layer 2] Git encoding config..."
    git config core.quotepath false
    git config i18n.commitEncoding utf-8
    git config i18n.logOutputEncoding utf-8
    Write-Host "  OK: core.quotepath = $(git config core.quotepath)"
    Write-Host "  OK: i18n.commitEncoding = $(git config i18n.commitEncoding)"
    Write-Host "  OK: i18n.logOutputEncoding = $(git config i18n.logOutputEncoding)"
}

function Check-GitEncoding {
    Write-Host "[Layer 2] Git encoding config..."
    $issues = @()
    if ((git config core.quotepath) -ne 'false') { $issues += 'core.quotepath should be false' }
    if ((git config i18n.commitEncoding) -ne 'utf-8') { $issues += 'i18n.commitEncoding should be utf-8' }
    if ((git config i18n.logOutputEncoding) -ne 'utf-8') { $issues += 'i18n.logOutputEncoding should be utf-8' }
    if ($issues.Count -eq 0) { Write-Host "  OK" } else { $issues | ForEach-Object { Write-Host "  ISSUE: $_" }; $script:exitCode = 1 }
}

# ── Layer 4: PowerShell output encoding ──────────────────────────────
function Set-PSEncoding {
    Write-Host "[Layer 4] PowerShell output encoding..."
    $profilePath = $PROFILE.CurrentUserAllHosts
    $lines = @(
        "`$PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'",
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8"
    )
    $existing = if (Test-Path $profilePath) { Get-Content $profilePath -Raw } else { '' }
    $changed = $false
    foreach ($line in $lines) {
        if ($existing -notmatch [Regex]::Escape($line)) {
            $existing += "`n" + $line
            $changed = $true
            Write-Host "  Added to profile: $line"
        }
    }
    if ($changed) { Set-Content -Path $profilePath -Value $existing -Encoding UTF8 }
    Write-Host "  OK: profile = $profilePath"
}

function Check-PSEncoding {
    Write-Host "[Layer 4] PowerShell profile encoding..."
    $profilePath = $PROFILE.CurrentUserAllHosts
    if (!(Test-Path $profilePath)) { Write-Host "  ISSUE: profile not found"; $script:exitCode = 1; return }
    $content = Get-Content $profilePath -Raw
    if ($content -match 'Out-File:Encoding.*utf8') { Write-Host "  OK: Out-File utf8" } else { Write-Host "  ISSUE: Out-File encoding not set"; $script:exitCode = 1 }
    if ($content -match 'OutputEncoding.*UTF8') { Write-Host "  OK: Console OutputEncoding" } else { Write-Host "  ISSUE: Console OutputEncoding not set"; $script:exitCode = 1 }
}

# ── Layer 1: BOM check ──────────────────────────────────────────────
function Test-Bom {
    param([string]$Path)
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    return ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
}

function Add-Bom {
    param([string]$Path)
    $content = Get-Content -Path $Path -Raw
    [System.IO.File]::WriteAllText($Path, $content, [System.Text.Encoding]::UTF8)
    Write-Host "  Added BOM: $Path"
}

function Set-Bom {
    Write-Host "[Layer 1] UTF-8 BOM on PowerShell scripts..."
    $psFiles = Get-ChildItem -Recurse -Filter '*.ps1' | Where-Object { $_.FullName -notmatch 'node_modules|\.git' }
    $fixed = 0
    foreach ($f in $psFiles) {
        if (!(Test-Bom -Path $f.FullName)) {
            Add-Bom -Path $f.FullName
            $fixed++
        }
    }
    if ($fixed -eq 0) { Write-Host "  OK: all .ps1 files have BOM" } else { Write-Host "  Fixed $fixed file(s)" }
}

function Check-Bom {
    Write-Host "[Layer 1] UTF-8 BOM on PowerShell scripts..."
    $psFiles = Get-ChildItem -Recurse -Filter '*.ps1' | Where-Object { $_.FullName -notmatch 'node_modules|\.git' }
    $missing = @()
    foreach ($f in $psFiles) {
        if (!(Test-Bom -Path $f.FullName)) { $missing += $f.FullName }
    }
    if ($missing.Count -eq 0) { Write-Host "  OK: all .ps1 files have BOM" }
    else { $missing | ForEach-Object { Write-Host "  MISSING BOM: $_" }; $script:exitCode = 1 }
}

# ── Layer 3: Advisory ────────────────────────────────────────────────
function Show-Advisory {
    Write-Host "[Layer 3] Advisory: Avoid inline non-ASCII in git commands"
    Write-Host "  Use:  git commit -F commit_msg.txt"
    Write-Host "  Not:  git commit -m '...'"
    Write-Host "  Reason: PowerShell encodes -m argument as Windows-1252,"
    Write-Host "          Git expects UTF-8. -F bypasses the shell entirely."
}

# ── Entry ────────────────────────────────────────────────────────────
Write-Host "============================================"
Write-Host "  Workspace Encoding Hardening"
Write-Host "============================================"
Write-Host ""

if ($Apply) {
    Set-GitEncoding
    Set-PSEncoding
    Set-Bom
    Show-Advisory
    Write-Host ""
    Write-Host "Done. Restart PowerShell for profile changes to take effect."
} elseif ($Check) {
    Check-GitEncoding
    Check-PSEncoding
    Check-Bom
    Write-Host ""
    if ($exitCode -eq 0) { Write-Host "All checks passed." } else { Write-Host "Some checks failed (see above)." }
} else {
    Write-Host "Usage:"
    Write-Host "  .\harden-workspace-encoding.ps1 -Apply    Apply all hardening"
    Write-Host "  .\harden-workspace-encoding.ps1 -Check    Verify current state"
}

exit $exitCode
