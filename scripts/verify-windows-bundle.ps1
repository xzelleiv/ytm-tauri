[CmdletBinding()]
param(
    [switch]$RequireSignature
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Open-MsiQuery {
    param(
        [Parameter(Mandatory)]
        [object]$Database,
        [Parameter(Mandatory)]
        [string]$Query
    )

    $view = $Database.GetType().InvokeMember(
        'OpenView',
        'InvokeMethod',
        $null,
        $Database,
        @($Query)
    )
    $view.GetType().InvokeMember('Execute', 'InvokeMethod', $null, $view, $null) | Out-Null
    return $view
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$package = Get-Content -Raw -LiteralPath (Join-Path $repoRoot 'package.json') | ConvertFrom-Json
$versionPattern = [regex]::Escape($package.version)
$targetRoot = if ([string]::IsNullOrWhiteSpace($env:CARGO_TARGET_DIR)) {
    Join-Path $repoRoot 'src-tauri\target'
} elseif ([IO.Path]::IsPathRooted($env:CARGO_TARGET_DIR)) {
    $env:CARGO_TARGET_DIR
} else {
    Join-Path $repoRoot $env:CARGO_TARGET_DIR
}
$releaseRoot = Join-Path $targetRoot 'release'
$bundleRoot = Join-Path $releaseRoot 'bundle'

$artifacts = @(
    Get-Item -LiteralPath (Join-Path $releaseRoot 'yt-music-tauri.exe')
    Get-ChildItem -Recurse -File -LiteralPath $bundleRoot |
        Where-Object {
            $_.Extension -In @('.exe', '.msi') -and
            $_.BaseName -match $versionPattern
        }
)

$msiArtifacts = @($artifacts | Where-Object Extension -EQ '.msi')
$setupArtifacts = @($artifacts | Where-Object {
    $_.Extension -EQ '.exe' -and $_.DirectoryName -like '*\bundle\nsis'
})
if ($msiArtifacts.Count -eq 0 -or $setupArtifacts.Count -eq 0) {
    throw "Windows bundles for version $($package.version) are incomplete."
}

foreach ($artifact in @($msiArtifacts + $setupArtifacts)) {
    $updaterSignaturePath = "$($artifact.FullName).sig"
    if (-not (Test-Path -LiteralPath $updaterSignaturePath -PathType Leaf)) {
        throw "Updater signature is missing for $($artifact.Name)."
    }

    try {
        $encodedSignature = (Get-Content -Raw -LiteralPath $updaterSignaturePath).Trim()
        $decodedSignature = [Text.Encoding]::UTF8.GetString(
            [Convert]::FromBase64String($encodedSignature)
        )
    } catch {
        throw "Updater signature is malformed for $($artifact.Name)."
    }
    if (
        -not $decodedSignature.StartsWith('untrusted comment: signature from tauri secret key') -or
        -not $decodedSignature.Contains("file:$($artifact.Name)")
    ) {
        throw "Updater signature metadata does not match $($artifact.Name)."
    }
}

$signatureFailures = @()
if ($RequireSignature) {
    $signatureFailures = foreach ($artifact in $artifacts) {
        $signature = Get-AuthenticodeSignature -LiteralPath $artifact.FullName
        if ($signature.Status -ne 'Valid') {
            [pscustomobject]@{
                Path = $artifact.FullName
                Status = $signature.Status
            }
        }
    }
}
if ($signatureFailures) {
    $signatureFailures | Format-Table -AutoSize | Out-String | Write-Host
    throw 'One or more Windows release artifacts are not validly signed.'
}

foreach ($msi in $msiArtifacts) {
    $installer = New-Object -ComObject WindowsInstaller.Installer
    $database = $installer.GetType().InvokeMember(
        'OpenDatabase',
        'InvokeMethod',
        $null,
        $installer,
        @($msi.FullName, 0)
    )

    $licenseView = Open-MsiQuery -Database $database -Query (
        "SELECT Text FROM Control WHERE Dialog_ = 'LicenseAgreementDlg' AND Control = 'LicenseText'"
    )
    $licenseRecord = $licenseView.GetType().InvokeMember(
        'Fetch',
        'InvokeMethod',
        $null,
        $licenseView,
        $null
    )
    if ($null -eq $licenseRecord) {
        throw "MSI license control is missing from $($msi.Name)."
    }
    $licenseText = $licenseRecord.GetType().InvokeMember(
        'StringData',
        'GetProperty',
        $null,
        $licenseRecord,
        @(1)
    )
    $licenseView.GetType().InvokeMember('Close', 'InvokeMethod', $null, $licenseView, $null) | Out-Null
    if (
        -not $licenseText.StartsWith('{\rtf1\ansi') -or
        -not $licenseText.Contains('MIT License') -or
        ([regex]::Matches($licenseText, '\{\\rtf1')).Count -ne 1
    ) {
        throw "MSI license RTF is invalid in $($msi.Name)."
    }

    $binaryView = Open-MsiQuery -Database $database -Query 'SELECT Name FROM Binary'
    $binaryNames = @()
    while ($true) {
        $binaryRecord = $binaryView.GetType().InvokeMember(
            'Fetch',
            'InvokeMethod',
            $null,
            $binaryView,
            $null
        )
        if ($null -eq $binaryRecord) {
            break
        }
        $binaryNames += $binaryRecord.GetType().InvokeMember(
            'StringData',
            'GetProperty',
            $null,
            $binaryRecord,
            @(1)
        )
    }
    $binaryView.GetType().InvokeMember('Close', 'InvokeMethod', $null, $binaryView, $null) | Out-Null
    if ($binaryNames -notcontains 'MicrosoftEdgeWebview2Setup.exe') {
        throw "Embedded WebView2 bootstrapper is missing from $($msi.Name)."
    }

    $identityView = Open-MsiQuery -Database $database -Query (
        'SELECT `Name`, `Value` FROM `Registry` WHERE `Key` = ''Software\Classes\AppUserModelId\app.ytmusic.desktop'''
    )
    $identityValues = @{}
    while ($true) {
        $identityRecord = $identityView.GetType().InvokeMember(
            'Fetch',
            'InvokeMethod',
            $null,
            $identityView,
            $null
        )
        if ($null -eq $identityRecord) {
            break
        }
        $name = $identityRecord.GetType().InvokeMember(
            'StringData', 'GetProperty', $null, $identityRecord, @(1)
        )
        $value = $identityRecord.GetType().InvokeMember(
            'StringData', 'GetProperty', $null, $identityRecord, @(2)
        )
        $identityValues[$name] = $value
    }
    $identityView.GetType().InvokeMember('Close', 'InvokeMethod', $null, $identityView, $null) | Out-Null
    if (
        $identityValues.DisplayName -ne 'YouTube Music' -or
        -not $identityValues.IconUri
    ) {
        throw "Windows application identity metadata is missing from $($msi.Name)."
    }
}

$signatureMode = if ($RequireSignature) { 'signed' } else { 'signature optional' }
Write-Host "Verified $($artifacts.Count) Windows artifacts ($signatureMode), updater signatures, MSI license, WebView2 bootstrapper, and application identity."
