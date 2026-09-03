[CmdletBinding()]
param(
    [string]$CertificateThumbprint = $env:WINDOWS_CERTIFICATE_THUMBPRINT,
    [string]$TimestampUrl = $env:WINDOWS_TIMESTAMP_URL,
    [string]$UpdaterPrivateKeyPath = $env:TAURI_SIGNING_PRIVATE_KEY_PATH,
    [string]$UpdaterPasswordFile = $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD_FILE,
    [switch]$AllowUnsigned
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$temporaryConfig = $null
$normalizedThumbprint = ($CertificateThumbprint -replace '\s', '').ToUpperInvariant()

try {
    if (-not $env:TAURI_SIGNING_PRIVATE_KEY) {
        if ([string]::IsNullOrWhiteSpace($UpdaterPrivateKeyPath)) {
            $defaultUpdaterKey = Join-Path $env:USERPROFILE '.tauri\ytm-tauri-updater.key'
            if (Test-Path -LiteralPath $defaultUpdaterKey) {
                $UpdaterPrivateKeyPath = $defaultUpdaterKey
            }
        }
        if ([string]::IsNullOrWhiteSpace($UpdaterPrivateKeyPath)) {
            throw 'Updater signing key is required. Set TAURI_SIGNING_PRIVATE_KEY or TAURI_SIGNING_PRIVATE_KEY_PATH.'
        }
        $resolvedUpdaterKey = Resolve-Path -LiteralPath $UpdaterPrivateKeyPath -ErrorAction Stop
        $env:TAURI_SIGNING_PRIVATE_KEY = $resolvedUpdaterKey.Path
    }
    if ([string]::IsNullOrWhiteSpace($env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD)) {
        if ([string]::IsNullOrWhiteSpace($UpdaterPasswordFile)) {
            $defaultPasswordFile = Join-Path $env:USERPROFILE '.tauri\ytm-tauri-updater-password.xml'
            if (Test-Path -LiteralPath $defaultPasswordFile) {
                $UpdaterPasswordFile = $defaultPasswordFile
            }
        }
        if ([string]::IsNullOrWhiteSpace($UpdaterPasswordFile)) {
            throw 'Updater signing password is required. Set TAURI_SIGNING_PRIVATE_KEY_PASSWORD or TAURI_SIGNING_PRIVATE_KEY_PASSWORD_FILE.'
        }

        $securePassword = Import-Clixml -LiteralPath $UpdaterPasswordFile
        $credential = [PSCredential]::new('updater', $securePassword)
        $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $credential.GetNetworkCredential().Password
        if ([string]::IsNullOrWhiteSpace($env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD)) {
            throw 'Updater signing password store is empty.'
        }
    }

    $buildArguments = @('run', 'build:tauri')

    if ($normalizedThumbprint) {
        if ($normalizedThumbprint -notmatch '^[A-F0-9]{40}$') {
            throw 'WINDOWS_CERTIFICATE_THUMBPRINT must be a 40-character SHA-1 certificate thumbprint.'
        }
        if (-not $TimestampUrl) {
            throw 'WINDOWS_TIMESTAMP_URL must be the timestamp server supplied by the certificate provider.'
        }

        $parsedTimestampUrl = $null
        if (
            -not [Uri]::TryCreate($TimestampUrl, [UriKind]::Absolute, [ref]$parsedTimestampUrl) -or
            $parsedTimestampUrl.Scheme -notin @('http', 'https')
        ) {
            throw 'WINDOWS_TIMESTAMP_URL must be an absolute HTTP or HTTPS URL.'
        }

        $certificate = Get-Item -LiteralPath "Cert:\CurrentUser\My\$normalizedThumbprint" -ErrorAction SilentlyContinue
        if ($null -eq $certificate) {
            throw "Code-signing certificate $normalizedThumbprint was not found in Cert:\CurrentUser\My."
        }
        if (-not $certificate.HasPrivateKey) {
            throw 'Code-signing certificate has no accessible private key.'
        }
        if ($certificate.NotAfter -le (Get-Date)) {
            throw 'Code-signing certificate is expired.'
        }
        if ($certificate.EnhancedKeyUsageList.ObjectId -notcontains '1.3.6.1.5.5.7.3.3') {
            throw 'Certificate is not valid for code signing.'
        }

        $signingConfig = @{
            bundle = @{
                windows = @{
                    certificateThumbprint = $normalizedThumbprint
                    digestAlgorithm = 'sha256'
                    timestampUrl = $TimestampUrl
                }
            }
        }
        $temporaryConfig = Join-Path ([IO.Path]::GetTempPath()) "yt-music-signing-$([Guid]::NewGuid().ToString('N')).json"
        $signingConfig |
            ConvertTo-Json -Depth 5 |
            Set-Content -LiteralPath $temporaryConfig -Encoding UTF8
        $buildArguments += @('--', '--config', $temporaryConfig)
    } elseif (-not $AllowUnsigned) {
        throw @'
Signed release build required.
Set WINDOWS_CERTIFICATE_THUMBPRINT and WINDOWS_TIMESTAMP_URL, then rerun npm run build.
For local packaging only, use: npm run build:unsigned
'@
    }

    Push-Location $repoRoot
    try {
        & npm @buildArguments
        if ($LASTEXITCODE -ne 0) {
            throw "Tauri build failed with exit code $LASTEXITCODE."
        }
    } finally {
        Pop-Location
    }

    if ($normalizedThumbprint) {
        & (Join-Path $PSScriptRoot 'verify-windows-bundle.ps1') -RequireSignature
    } else {
        & (Join-Path $PSScriptRoot 'verify-windows-bundle.ps1')
        Write-Warning 'Unsigned local build complete. Do not publish these artifacts.'
    }
} finally {
    if ($temporaryConfig -and (Test-Path -LiteralPath $temporaryConfig)) {
        Remove-Item -LiteralPath $temporaryConfig -Force
    }
}
