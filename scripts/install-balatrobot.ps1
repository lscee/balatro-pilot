#requires -Version 5.1

[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = "Medium")]
param(
  [string]$BalatroDirectory = "",
  [string]$ModsDirectory = "",
  [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# These inputs are intentionally immutable. Lovely has a release asset; Steamodded
# and BalatroBot publish source archives, so those downloads are pinned to the
# commits referenced by the named release tags as well as to an archive SHA-256.
$LovelyVersion = "0.9.0"
$LovelyArchiveUri = "https://github.com/ethangreen-dev/lovely-injector/releases/download/v0.9.0/lovely-x86_64-pc-windows-msvc.zip"
$LovelyArchiveSha256 = "40b994a055ee75e5f2aba81e7ae06f2c17460e18cc346483089921899fadd1f7"
$LovelyDllSha256 = "ccfed59e4d245b7802c684fc86708e0a937f584d6e07d1ecc11e8eae22f9fc1a"

$SmodsVersion = "1.0.0-beta-1814a"
$SmodsRuntimeVersion = "1.0.0~BETA-1814a-STEAMODDED"
$SmodsCommit = "f8e4ae060df0e42ce698ffaf901a39a6ef424c0f"
$SmodsArchiveUri = "https://codeload.github.com/Steamodded/smods/zip/$SmodsCommit"
$SmodsArchiveSha256 = "1cae496bfd1c5dbfbc5db1eb51137d822c44fb7758ba6beaf020e43f1b5f96db"

$BalatroBotVersion = "1.5.2"
$BalatroBotCommit = "9052d76f14723293f6c6b2cecaa791a5c4ae68f3"
$BalatroBotArchiveUri = "https://codeload.github.com/coder/balatrobot/zip/$BalatroBotCommit"
$BalatroBotArchiveSha256 = "f1c3b2faaa9e19cbbaf13d3ead5ecc361912420abb2e8aba1084e9809db6044a"
$BalatroBotUpstreamRuntimeFingerprint = "56042aacfd861d14b3c7c01a50083e18647a70651c373834a4b9b45f1c16951f"
$BalatroBotEntropyRuntimeFingerprint = "d16f644fbc876316bc81b6f11a6694434de5ec371e704fc6ba244c73afd056b9"
$BalatroBotBrokenEntropyEndlessRuntimeFingerprint = "4ceb563a70550df685623685813b348128f4b2035e9f8010ef3841f5d8d5e5e4"
$BalatroBotRacyEntropyEndlessRuntimeFingerprint = "e935f034677a82d9cc83d4b8e1f1360dc9ba8361c0a66ba58cbc787b9c657014"
$BalatroBotUnsafeEndlessRuntimeFingerprint = "e2ab32128ec0fed5473e215df423265fac62278d8875af7c243e6423c3547e73"
$BalatroBotPrePackRuntimeFingerprint = "a5b67a53b06fd4a949b3031d870bea87c6280b8bb7e13a1ad0b9d79e9145603d"
$BalatroBotPreCapabilityRuntimeFingerprint = "d53fa2eb86813c48e33b9d2c9317f786ef24bef28c0c60e4b4a48bcfcb6441e2"
$BalatroBotPreBuyUseRuntimeFingerprint = "7c780857ac7b7991479bc8942db17830a2b4c5ad4e9808718ac0f1dc17f00e7d"
$BalatroBotRuntimeFingerprint = "f5ffff76f5b0237e617a48e539ebb8cd4e007fa717cc0378987406559860964f"

$UvVersion = "0.12.3"
$UvArchiveUri = "https://github.com/astral-sh/uv/releases/download/0.12.3/uv-x86_64-pc-windows-msvc.zip"
$UvArchiveSha256 = "b23350c79e8ad0192b8124af13a0f17e8d4e4549524785e1aef389ae5a06990e"
$UvExecutableSha256 = "68a22cbab1674647bcda32120b214e6480f875414e3333f49f87ae99b4b0e0fa"
$UvwExecutableSha256 = "3a0304cf746971cf2d7e0c104e17c76b9f671e21d7b8899e4509b7842f358f8b"
$UvxExecutableSha256 = "64ff99ae93be556b5bf1202ff827c3cd56efa1f9ed317220007d0d87e8a55caf"

function Write-InstallStatus {
  param(
    [Parameter(Mandatory = $true)][string]$Kind,
    [Parameter(Mandatory = $true)][string]$Message
  )
  Write-Output ("[{0}] {1}" -f $Kind, $Message)
}

function Get-FileSha256 {
  param([Parameter(Mandatory = $true)][string]$LiteralPath)
  $stream = [System.IO.File]::OpenRead($LiteralPath)
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($sha256.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
  } finally {
    $sha256.Dispose()
    $stream.Dispose()
  }
}

function Add-CandidateDirectory {
  param(
    [Parameter(Mandatory = $true)]$List,
    [AllowEmptyString()][string]$Path
  )
  if ([string]::IsNullOrWhiteSpace($Path)) { return }
  try {
    $fullPath = [System.IO.Path]::GetFullPath(
      [Environment]::ExpandEnvironmentVariables($Path)
    )
    if ($fullPath.EndsWith("Balatro.exe", [StringComparison]::OrdinalIgnoreCase)) {
      $fullPath = Split-Path -Parent $fullPath
    }
    $List.Add($fullPath) | Out-Null
  } catch {
    return
  }
}

function Get-SteamLibraryDirectories {
  $steamRoots = New-Object System.Collections.Generic.List[string]
  foreach ($registryPath in @(
    "HKCU:\Software\Valve\Steam",
    "HKLM:\SOFTWARE\WOW6432Node\Valve\Steam",
    "HKLM:\SOFTWARE\Valve\Steam"
  )) {
    try {
      $properties = Get-ItemProperty -LiteralPath $registryPath -ErrorAction Stop
      foreach ($propertyName in @("SteamPath", "InstallPath")) {
        $value = [string]$properties.$propertyName
        if (-not [string]::IsNullOrWhiteSpace($value)) {
          $steamRoots.Add($value) | Out-Null
        }
      }
    } catch {
      continue
    }
  }
  if (-not [string]::IsNullOrWhiteSpace(${env:ProgramFiles(x86)})) {
    $steamRoots.Add((Join-Path ${env:ProgramFiles(x86)} "Steam")) | Out-Null
  }

  $libraries = New-Object System.Collections.Generic.List[string]
  foreach ($rawSteamRoot in @($steamRoots | Select-Object -Unique)) {
    try {
      $steamRoot = [System.IO.Path]::GetFullPath($rawSteamRoot)
      $libraries.Add($steamRoot) | Out-Null
      $libraryFile = Join-Path $steamRoot "steamapps\libraryfolders.vdf"
      if (-not (Test-Path -LiteralPath $libraryFile -PathType Leaf)) { continue }
      $content = Get-Content -LiteralPath $libraryFile -Raw -ErrorAction Stop
      foreach ($match in [regex]::Matches($content, '"path"\s+"(?<path>(?:\\.|[^"])*)"')) {
        $libraryPath = $match.Groups["path"].Value.Replace("\\", "\")
        if (-not [string]::IsNullOrWhiteSpace($libraryPath)) {
          $libraries.Add($libraryPath) | Out-Null
        }
      }
    } catch {
      continue
    }
  }
  return @($libraries | Select-Object -Unique)
}

function Find-BalatroDirectory {
  param([AllowEmptyString()][string]$ExplicitDirectory)

  if (-not [string]::IsNullOrWhiteSpace($ExplicitDirectory)) {
    $explicitCandidates = New-Object System.Collections.Generic.List[string]
    Add-CandidateDirectory -List $explicitCandidates -Path $ExplicitDirectory
    if ($explicitCandidates.Count -ne 1) {
      throw "BalatroDirectory is not a valid path: $ExplicitDirectory"
    }
    $explicit = $explicitCandidates[0]
    if (-not (Test-Path -LiteralPath (Join-Path $explicit "Balatro.exe") -PathType Leaf)) {
      throw "Balatro.exe was not found under: $explicit"
    }
    return $explicit
  }

  $candidateDirectories = New-Object System.Collections.Generic.List[string]
  try {
    foreach ($process in @(Get-Process -Name "Balatro" -ErrorAction Stop)) {
      Add-CandidateDirectory -List $candidateDirectories -Path ([string]$process.Path)
    }
  } catch {
    # Registry/library detection below remains available when process inspection is denied.
  }

  foreach ($libraryRoot in @(Get-SteamLibraryDirectories)) {
    $steamApps = Join-Path $libraryRoot "steamapps"
    $installName = "Balatro"
    $manifestPath = Join-Path $steamApps "appmanifest_2379780.acf"
    if (Test-Path -LiteralPath $manifestPath -PathType Leaf) {
      try {
        $manifest = Get-Content -LiteralPath $manifestPath -Raw -ErrorAction Stop
        $installMatch = [regex]::Match($manifest, '"installdir"\s+"(?<name>[^"]+)"')
        if ($installMatch.Success) {
          $installName = $installMatch.Groups["name"].Value
        }
      } catch {
        $installName = "Balatro"
      }
    }
    Add-CandidateDirectory -List $candidateDirectories -Path (
      Join-Path (Join-Path $steamApps "common") $installName
    )
  }

  foreach ($candidate in @($candidateDirectories | Select-Object -Unique)) {
    if (Test-Path -LiteralPath (Join-Path $candidate "Balatro.exe") -PathType Leaf) {
      return $candidate
    }
  }
  throw "Balatro Steam installation was not found. Pass -BalatroDirectory explicitly."
}

function Get-SmodsInstalledVersion {
  param([Parameter(Mandatory = $true)][string]$Root)
  $versionPath = Join-Path $Root "version.lua"
  if (-not (Test-Path -LiteralPath $versionPath -PathType Leaf)) { return $null }
  $content = Get-Content -LiteralPath $versionPath -Raw -ErrorAction Stop
  $match = [regex]::Match($content, 'return\s+["''](?<version>[^"'']+)["'']')
  if (-not $match.Success) { return $null }
  return $match.Groups["version"].Value
}

function Get-BalatroBotRuntimeFingerprint {
  param([Parameter(Mandatory = $true)][string]$Root)

  $requiredFiles = @(
    (Join-Path $Root "balatrobot.json"),
    (Join-Path $Root "balatrobot.lua")
  )
  $luaRoot = Join-Path $Root "src\lua"
  foreach ($requiredFile in $requiredFiles) {
    if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) { return $null }
  }
  if (-not (Test-Path -LiteralPath $luaRoot -PathType Container)) { return $null }

  $runtimeFiles = New-Object System.Collections.Generic.List[System.IO.FileInfo]
  foreach ($requiredFile in $requiredFiles) {
    $runtimeFiles.Add((Get-Item -LiteralPath $requiredFile)) | Out-Null
  }
  foreach ($file in @(Get-ChildItem -LiteralPath $luaRoot -Recurse -File)) {
    $runtimeFiles.Add($file) | Out-Null
  }
  $entries = @($runtimeFiles | ForEach-Object {
    $relative = $_.FullName.Substring($Root.Length).TrimStart([char]92).Replace("\", "/")
    $fileHash = Get-FileSha256 -LiteralPath $_.FullName
    "{0}`t{1}" -f $relative, $fileHash
  } | Sort-Object)
  $serialized = [string]::Join("`n", [string[]]$entries)
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($serialized)
    return ([BitConverter]::ToString($sha256.ComputeHash($bytes))).Replace("-", "").ToLowerInvariant()
  } finally {
    $sha256.Dispose()
  }
}

function Add-BalatroBotUnseededEntropyPatch {
  param([Parameter(Mandatory = $true)][string]$Root)

  $endpoint = Join-Path $Root "src\lua\endpoints\start.lua"
  $contents = [System.IO.File]::ReadAllText($endpoint)
  $newline = if ($contents.Contains("`r`n")) { "`r`n" } else { "`n" }
  $anchor = "    -- Start the run with stake number and optional seed$newline"
  if (-not $contents.Contains($anchor)) {
    throw "The pinned BalatroBot start endpoint no longer matches the entropy patch anchor."
  }
  $currentMarker = "    -- Balatro Pilot: inject entropy at the actual native seed call.$newline"
  if ($contents.Contains($currentMarker)) { return $false }
  $lines = @(
    '    -- Balatro Pilot: inject entropy at the actual native seed call.',
    '    -- G.FUNCS.start_run is asynchronous and cursor_hover.time is rewritten every',
    '    -- frame, so changing it before start_run races with Controller:set_cursor_hover().',
    '    -- run_params.seed remains nil, preserving normal unlocks and statistics.',
    '    if not args.seed and type(generate_starting_seed) == "function" then',
    '      G.BALATRO_PILOT_UNSEEDED_NONCE = (G.BALATRO_PILOT_UNSEEDED_NONCE or 0) + 1',
    '      local native_generate_starting_seed = generate_starting_seed',
    '      local wall_clock = os.time and os.time() or 0',
    '      local high_res_clock = love and love.timer and love.timer.getTime and love.timer.getTime()',
    '        or (os.clock and os.clock() or 0)',
    '      local entropy = (',
    '        (wall_clock % 2147483647)',
    '        + math.floor((high_res_clock % 4096) * 1000000)',
    '        + G.BALATRO_PILOT_UNSEEDED_NONCE * 104729',
    '      ) % 2147483647',
    '      local previous_seed = G.BALATRO_PILOT_LAST_UNSEEDED_SEED',
    '',
    '      generate_starting_seed = function()',
    '        generate_starting_seed = native_generate_starting_seed',
    '        local previous_cursor_time = G.CONTROLLER and G.CONTROLLER.cursor_hover',
    '          and G.CONTROLLER.cursor_hover.time or nil',
    '        local generated_seed = nil',
    '        for attempt = 0, 7 do',
    '          if G.CONTROLLER and G.CONTROLLER.cursor_hover then',
    '            G.CONTROLLER.cursor_hover.time = entropy + attempt * 104729',
    '          end',
    '          generated_seed = native_generate_starting_seed()',
    '          if generated_seed ~= previous_seed then break end',
    '        end',
    '        if G.CONTROLLER and G.CONTROLLER.cursor_hover then',
    '          G.CONTROLLER.cursor_hover.time = previous_cursor_time',
    '        end',
    '        G.BALATRO_PILOT_LAST_UNSEEDED_SEED = generated_seed',
    '        return generated_seed',
    '      end',
    '    end',
    ''
  )
  $newBlock = [string]::Join($newline, [string[]]$lines) + $newline
  $legacyMarker = "    -- Balatro Pilot: add wall-clock and per-process entropy before the native$newline"
  if ($contents.Contains($legacyMarker)) {
    $legacyStart = $contents.IndexOf($legacyMarker, [StringComparison]::Ordinal)
    $anchorStart = $contents.IndexOf($anchor, $legacyStart, [StringComparison]::Ordinal)
    if ($anchorStart -lt 0) {
      throw "The legacy BalatroBot entropy patch is missing its start-run anchor."
    }
    $patched = $contents.Substring(0, $legacyStart) + $newBlock + $contents.Substring($anchorStart)
  } else {
    $patched = $contents.Replace($anchor, $newBlock + $anchor)
  }
  [System.IO.File]::WriteAllText($endpoint, $patched, (New-Object System.Text.UTF8Encoding($false)))
  return $true
}

function Add-BalatroBotEndlessPatch {
  param([Parameter(Mandatory = $true)][string]$Root)

  $projectRoot = Split-Path -Parent $PSScriptRoot
  $assetRoot = Join-Path $projectRoot "assets\balatrobot-v1.5.2"
  $endpointSource = Join-Path $assetRoot "endless.lua"
  $playSource = Join-Path $assetRoot "play.lua"
  $cashOutSource = Join-Path $assetRoot "cash_out.lua"
  $packSource = Join-Path $assetRoot "pack.lua"
  $useSource = Join-Path $assetRoot "use.lua"
  $bossRerollSource = Join-Path $assetRoot "reroll_boss.lua"
  $buyUseSource = Join-Path $assetRoot "buy_use.lua"
  $endlessMethodSource = Join-Path $assetRoot "openrpc-endless-method.json"
  $bossRerollMethodSource = Join-Path $assetRoot "openrpc-reroll-boss-method.json"
  $buyUseMethodSource = Join-Path $assetRoot "openrpc-buy-use-method.json"
  foreach ($asset in @(
    $endpointSource,
    $playSource,
    $cashOutSource,
    $packSource,
    $useSource,
    $bossRerollSource,
    $buyUseSource,
    $endlessMethodSource,
    $bossRerollMethodSource,
    $buyUseMethodSource
  )) {
    if (-not (Test-Path -LiteralPath $asset -PathType Leaf)) {
      throw "Balatro Pilot endless patch asset is missing: $asset"
    }
  }

  $endpointTarget = Join-Path $Root "src\lua\endpoints\endless.lua"
  if (Test-Path -LiteralPath $endpointTarget -PathType Leaf) {
    if ((Get-FileSha256 -LiteralPath $endpointTarget) -ne (Get-FileSha256 -LiteralPath $endpointSource)) {
      throw "The existing BalatroBot endless endpoint differs from the pinned Balatro Pilot asset. Re-run install-balatrobot.ps1 -Force after reviewing the mod directory."
    }
  } else {
    Copy-Item -LiteralPath $endpointSource -Destination $endpointTarget -ErrorAction Stop
  }

  # Replace the two pinned v1.5.2 endpoints as one atomic compatibility patch.
  # play.lua must distinguish the native victory overlay from the persistent
  # G.GAME.won flag in Endless, while cash_out.lua independently waits until
  # every payout-row event and the native cash-out button are ready.
  Copy-Item -LiteralPath $playSource -Destination (Join-Path $Root "src\lua\endpoints\play.lua") -Force -ErrorAction Stop
  Copy-Item -LiteralPath $cashOutSource -Destination (Join-Path $Root "src\lua\endpoints\cash_out.lua") -Force -ErrorAction Stop
  # Mixed packs can contain Black Hole before an ordinary Planet. The pinned
  # endpoint derives hand readiness from the selected card and actual targets,
  # never from the first offer's broad set.
  Copy-Item -LiteralPath $packSource -Destination (Join-Path $Root "src\lua\endpoints\pack.lua") -Force -ErrorAction Stop
  # Aura is a vanilla special case whose center does not declare its one-card
  # target contract. Keep the endpoint and game-level validation pinned.
  Copy-Item -LiteralPath $useSource -Destination (Join-Path $Root "src\lua\endpoints\use.lua") -Force -ErrorAction Stop
  Copy-Item -LiteralPath $bossRerollSource -Destination (Join-Path $Root "src\lua\endpoints\reroll_boss.lua") -Force -ErrorAction Stop
  Copy-Item -LiteralPath $buyUseSource -Destination (Join-Path $Root "src\lua\endpoints\buy_use.lua") -Force -ErrorAction Stop

  $entryPath = Join-Path $Root "balatrobot.lua"
  $entry = [System.IO.File]::ReadAllText($entryPath)
  $newline = if ($entry.Contains("`r`n")) { "`r`n" } else { "`n" }
  if (-not $entry.Contains('"src/lua/endpoints/endless.lua"')) {
    $anchor = '  "src/lua/endpoints/cash_out.lua",' + $newline
    if (-not $entry.Contains($anchor)) {
      throw "The pinned BalatroBot entry module no longer matches the Endless endpoint registration anchor."
    }
    $entry = $entry.Replace($anchor, $anchor + '  "src/lua/endpoints/endless.lua",' + $newline)
  }
  if (-not $entry.Contains('"src/lua/endpoints/reroll_boss.lua"')) {
    $anchor = '  "src/lua/endpoints/select.lua",' + $newline
    if (-not $entry.Contains($anchor)) {
      throw "The pinned BalatroBot entry module no longer matches the Boss reroll registration anchor."
    }
    $entry = $entry.Replace($anchor, $anchor + '  "src/lua/endpoints/reroll_boss.lua",' + $newline)
  }
  if (-not $entry.Contains('"src/lua/endpoints/buy_use.lua"')) {
    $anchor = '  "src/lua/endpoints/buy.lua",' + $newline
    if (-not $entry.Contains($anchor)) {
      throw "The pinned BalatroBot entry module no longer matches the Buy & Use registration anchor."
    }
    $entry = $entry.Replace($anchor, $anchor + '  "src/lua/endpoints/buy_use.lua",' + $newline)
  }
  [System.IO.File]::WriteAllText($entryPath, $entry, (New-Object System.Text.UTF8Encoding($false)))

  $openRpcPath = Join-Path $Root "src\lua\utils\openrpc.json"
  $openRpc = Get-Content -LiteralPath $openRpcPath -Raw | ConvertFrom-Json
  $openRpcChanged = $false
  foreach ($methodSpec in @(
    @{ Name = "endless"; Source = $endlessMethodSource },
    @{ Name = "reroll_boss"; Source = $bossRerollMethodSource },
    @{ Name = "buy_use"; Source = $buyUseMethodSource }
  )) {
    $alreadyRegistered = @($openRpc.methods | Where-Object { [string]$_.name -eq $methodSpec.Name }).Count -gt 0
    if (-not $alreadyRegistered) {
      $method = Get-Content -LiteralPath $methodSpec.Source -Raw | ConvertFrom-Json
      $openRpc.methods = @($openRpc.methods) + @($method)
      $openRpcChanged = $true
    }
  }
  if ($openRpcChanged) {
    [System.IO.File]::WriteAllText(
      $openRpcPath,
      ($openRpc | ConvertTo-Json -Depth 100),
      (New-Object System.Text.UTF8Encoding($false))
    )
  }
  return $true
}

function Get-TargetState {
  param(
    [Parameter(Mandatory = $true)][ValidateSet("Lovely", "Smods", "BalatroBot", "Uv")][string]$Component,
    [Parameter(Mandatory = $true)][string]$Target
  )
  if (-not (Test-Path -LiteralPath $Target)) {
    return [pscustomobject]@{ State = "missing"; Detail = "not installed" }
  }
  if ($Component -eq "Uv") {
    if (-not (Test-Path -LiteralPath $Target -PathType Container)) {
      return [pscustomobject]@{ State = "conflict"; Detail = "target exists but is not a directory" }
    }
    $expectedFiles = [ordered]@{
      "uv.exe" = $UvExecutableSha256
      "uvw.exe" = $UvwExecutableSha256
      "uvx.exe" = $UvxExecutableSha256
    }
    foreach ($fileName in $expectedFiles.Keys) {
      $filePath = Join-Path $Target $fileName
      if (-not (Test-Path -LiteralPath $filePath -PathType Leaf)) {
        return [pscustomobject]@{ State = "conflict"; Detail = "missing $fileName" }
      }
      $fileHash = Get-FileSha256 -LiteralPath $filePath
      if ($fileHash -ne $expectedFiles[$fileName]) {
        return [pscustomobject]@{ State = "conflict"; Detail = "$fileName SHA-256 differs" }
      }
    }
    $versionText = [string](& (Join-Path $Target "uv.exe") --version 2>&1)
    if ($LASTEXITCODE -ne 0 -or $versionText -notmatch ('^uv\s+' + [regex]::Escape($UvVersion) + '(?:\s|$)')) {
      return [pscustomobject]@{ State = "conflict"; Detail = "uv.exe did not report version $UvVersion" }
    }
    return [pscustomobject]@{ State = "current"; Detail = "uv/uvx $UvVersion SHA-256 and version match" }
  }
  if ($Component -eq "Lovely") {
    if (-not (Test-Path -LiteralPath $Target -PathType Leaf)) {
      return [pscustomobject]@{ State = "conflict"; Detail = "target exists but is not a file" }
    }
    $hash = Get-FileSha256 -LiteralPath $Target
    if ($hash -eq $LovelyDllSha256) {
      return [pscustomobject]@{ State = "current"; Detail = "Lovely v$LovelyVersion SHA-256 matches" }
    }
    return [pscustomobject]@{ State = "conflict"; Detail = "existing version.dll SHA-256 is $hash" }
  }
  if (-not (Test-Path -LiteralPath $Target -PathType Container)) {
    return [pscustomobject]@{ State = "conflict"; Detail = "target exists but is not a directory" }
  }
  if ($Component -eq "Smods") {
    $installedVersion = Get-SmodsInstalledVersion -Root $Target
    if ($installedVersion -eq $SmodsRuntimeVersion) {
      return [pscustomobject]@{ State = "current"; Detail = "Steamodded $SmodsVersion detected" }
    }
    $shownVersion = if ($null -eq $installedVersion) { "unknown" } else { $installedVersion }
    return [pscustomobject]@{ State = "conflict"; Detail = "existing Steamodded version is $shownVersion" }
  }

  $fingerprint = Get-BalatroBotRuntimeFingerprint -Root $Target
  if ($fingerprint -eq $BalatroBotRuntimeFingerprint) {
    return [pscustomobject]@{ State = "current"; Detail = "BalatroBot v$BalatroBotVersion runtime matches" }
  }
  if (
    $fingerprint -eq $BalatroBotUpstreamRuntimeFingerprint -or
    $fingerprint -eq $BalatroBotEntropyRuntimeFingerprint -or
    $fingerprint -eq $BalatroBotBrokenEntropyEndlessRuntimeFingerprint -or
    $fingerprint -eq $BalatroBotRacyEntropyEndlessRuntimeFingerprint -or
    $fingerprint -eq $BalatroBotUnsafeEndlessRuntimeFingerprint -or
    $fingerprint -eq $BalatroBotPrePackRuntimeFingerprint -or
    $fingerprint -eq $BalatroBotPreCapabilityRuntimeFingerprint -or
    $fingerprint -eq $BalatroBotPreBuyUseRuntimeFingerprint
  ) {
    return [pscustomobject]@{ State = "patch"; Detail = "BalatroBot v$BalatroBotVersion legacy runtime detected; installer will apply the pinned entropy, safe settlement, and selected-card pack patches" }
  }
  $shownFingerprint = if ($null -eq $fingerprint) { "unrecognized" } else { $fingerprint }
  return [pscustomobject]@{ State = "conflict"; Detail = "existing runtime fingerprint is $shownFingerprint" }
}

function Assert-NotReparsePoint {
  param([Parameter(Mandatory = $true)][string]$Target)
  if (-not (Test-Path -LiteralPath $Target)) { return }
  $item = Get-Item -LiteralPath $Target -Force
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Refusing to replace a reparse point: $Target"
  }
}

function New-BackupPath {
  param([Parameter(Mandatory = $true)][string]$Target)
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $base = "$Target.balatro-pilot-backup-$stamp"
  $candidate = $base
  $suffix = 1
  while (Test-Path -LiteralPath $candidate) {
    $candidate = "$base-$suffix"
    $suffix += 1
  }
  return $candidate
}

function Save-VerifiedArchive {
  param(
    [Parameter(Mandatory = $true)][string]$Uri,
    [Parameter(Mandatory = $true)][string]$Destination,
    [Parameter(Mandatory = $true)][string]$ExpectedSha256
  )
  $parsedUri = [uri]$Uri
  if ($parsedUri.Scheme -ne "https" -or $parsedUri.Host -notin @("github.com", "codeload.github.com")) {
    throw "Refusing a non-official download URI: $Uri"
  }
  Write-InstallStatus -Kind "download" -Message $Uri
  Invoke-WebRequest -UseBasicParsing -Uri $Uri -OutFile $Destination
  $actualSha256 = Get-FileSha256 -LiteralPath $Destination
  if ($actualSha256 -ne $ExpectedSha256) {
    throw "SHA-256 mismatch for $Uri. Expected $ExpectedSha256; got $actualSha256."
  }
  Write-InstallStatus -Kind "verified" -Message "$([System.IO.Path]::GetFileName($Destination)) SHA-256 $actualSha256"
}

function Copy-DirectoryContents {
  param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination
  )
  if (-not (Test-Path -LiteralPath $Destination -PathType Container)) {
    New-Item -ItemType Directory -Path $Destination | Out-Null
  }
  foreach ($item in @(Get-ChildItem -LiteralPath $Source -Force)) {
    Copy-Item -LiteralPath $item.FullName -Destination $Destination -Recurse -Force
  }
}

function Install-PreparedTarget {
  param(
    [Parameter(Mandatory = $true)][string]$Prepared,
    [Parameter(Mandatory = $true)][string]$Target,
    [AllowNull()][string]$Backup
  )
  $movedOldTarget = $false
  try {
    if (-not [string]::IsNullOrWhiteSpace($Backup)) {
      Move-Item -LiteralPath $Target -Destination $Backup
      $movedOldTarget = $true
      Write-InstallStatus -Kind "backup" -Message "$Target -> $Backup"
    }
    Move-Item -LiteralPath $Prepared -Destination $Target
    Write-InstallStatus -Kind "installed" -Message $Target
  } catch {
    if ($movedOldTarget -and -not (Test-Path -LiteralPath $Target) -and (Test-Path -LiteralPath $Backup)) {
      Move-Item -LiteralPath $Backup -Destination $Target
      Write-InstallStatus -Kind "rollback" -Message "Restored $Target"
    }
    throw
  }
}

if ($PSVersionTable.PSVersion.Major -ge 6 -and -not $IsWindows) {
  throw "This installer supports Windows only."
}
if (-not [Environment]::Is64BitOperatingSystem) {
  throw "Lovely v$LovelyVersion requires 64-bit Windows for this installer."
}

$resolvedBalatroDirectory = Find-BalatroDirectory -ExplicitDirectory $BalatroDirectory
$balatroExe = Join-Path $resolvedBalatroDirectory "Balatro.exe"
$lovelyTarget = Join-Path $resolvedBalatroDirectory "version.dll"

if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
  throw "LOCALAPPDATA is unavailable; cannot use the fixed per-user uv tools directory."
}
$uvTarget = Join-Path $env:LOCALAPPDATA "BalatroPilot\tools\uv-$UvVersion"

if ([string]::IsNullOrWhiteSpace($ModsDirectory)) {
  if ([string]::IsNullOrWhiteSpace($env:APPDATA)) {
    throw "APPDATA is unavailable. Pass -ModsDirectory explicitly."
  }
  $ModsDirectory = Join-Path $env:APPDATA "Balatro\Mods"
}
$resolvedModsDirectory = [System.IO.Path]::GetFullPath(
  [Environment]::ExpandEnvironmentVariables($ModsDirectory)
)
if ((Test-Path -LiteralPath $resolvedModsDirectory) -and
    -not (Test-Path -LiteralPath $resolvedModsDirectory -PathType Container)) {
  throw "ModsDirectory exists but is not a directory: $resolvedModsDirectory"
}
$smodsTarget = Join-Path $resolvedModsDirectory "smods"
$balatroBotTarget = Join-Path $resolvedModsDirectory "balatrobot"

$lovelyState = Get-TargetState -Component Lovely -Target $lovelyTarget
$smodsState = Get-TargetState -Component Smods -Target $smodsTarget
$balatroBotState = Get-TargetState -Component BalatroBot -Target $balatroBotTarget
$uvState = Get-TargetState -Component Uv -Target $uvTarget

Write-InstallStatus -Kind "target" -Message "Balatro: $balatroExe"
Write-InstallStatus -Kind "target" -Message "Mods: $resolvedModsDirectory"
Write-InstallStatus -Kind "plan" -Message "Lovely $LovelyVersion -> $lovelyTarget ($($lovelyState.State): $($lovelyState.Detail))"
Write-InstallStatus -Kind "plan" -Message "Steamodded $SmodsVersion -> $smodsTarget ($($smodsState.State): $($smodsState.Detail))"
Write-InstallStatus -Kind "plan" -Message "BalatroBot $BalatroBotVersion -> $balatroBotTarget ($($balatroBotState.State): $($balatroBotState.Detail))"
Write-InstallStatus -Kind "plan" -Message "uv/uvx $UvVersion -> $uvTarget ($($uvState.State): $($uvState.Detail))"

$states = @($lovelyState, $smodsState, $balatroBotState, $uvState)
if ($uvState.State -eq "conflict") {
  throw "The fixed uv tools directory already exists but does not match uv $UvVersion. It was not overwritten: $uvTarget"
}
$gameComponentStates = @($lovelyState, $smodsState, $balatroBotState)
$conflicts = @($gameComponentStates | Where-Object { $_.State -eq "conflict" })
if ($conflicts.Count -gt 0 -and -not $Force) {
  throw "An existing installation differs from the pinned versions. Nothing was changed. Review the plan, then use -Force to preserve each old target as a timestamped backup before installing."
}
if (@($states | Where-Object { $_.State -ne "current" }).Count -eq 0) {
  Write-InstallStatus -Kind "ok" -Message "All pinned components are already installed."
  return
}

if ($lovelyState.State -eq "conflict") { Assert-NotReparsePoint -Target $lovelyTarget }
if ($smodsState.State -eq "conflict") { Assert-NotReparsePoint -Target $smodsTarget }
if ($balatroBotState.State -eq "conflict") { Assert-NotReparsePoint -Target $balatroBotTarget }

$runningBalatro = @(Get-Process -Name "Balatro" -ErrorAction SilentlyContinue)
$requiresGameFileChanges = (
  $lovelyState.State -ne "current" -or
  $smodsState.State -ne "current" -or
  $balatroBotState.State -ne "current"
)
if ($requiresGameFileChanges -and $runningBalatro.Count -gt 0 -and -not $WhatIfPreference) {
  throw "Balatro is running. Close the game before installing Lovely or mods."
}

$operationDescription = "Install pinned uv, Lovely, Steamodded, and BalatroBot components; differing game/mod targets are backed up when -Force is present"
if (-not $PSCmdlet.ShouldProcess(
  "$uvTarget, $resolvedBalatroDirectory, and $resolvedModsDirectory",
  $operationDescription
)) {
  return
}

$stagingRoot = Join-Path ([System.IO.Path]::GetTempPath()) (
  "balatro-pilot-install-" + [guid]::NewGuid().ToString("N")
)
$oldProgressPreference = $ProgressPreference
$ProgressPreference = "SilentlyContinue"
try {
  # Windows PowerShell 5.1 can otherwise negotiate an obsolete TLS version.
  try {
    [Net.ServicePointManager]::SecurityProtocol = (
      [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    )
  } catch {
    # PowerShell 7 uses HttpClient and does not need this compatibility setting.
  }
  New-Item -ItemType Directory -Path $stagingRoot | Out-Null
  $downloadRoot = Join-Path $stagingRoot "downloads"
  $extractRoot = Join-Path $stagingRoot "extracted"
  $preparedRoot = Join-Path $stagingRoot "prepared"
  New-Item -ItemType Directory -Path $downloadRoot, $extractRoot, $preparedRoot | Out-Null

  $preparedLovely = $null
  if ($lovelyState.State -ne "current") {
    $lovelyArchive = Join-Path $downloadRoot "lovely-$LovelyVersion-windows-x64.zip"
    Save-VerifiedArchive -Uri $LovelyArchiveUri -Destination $lovelyArchive -ExpectedSha256 $LovelyArchiveSha256
    $lovelyExtract = Join-Path $extractRoot "lovely"
    Expand-Archive -LiteralPath $lovelyArchive -DestinationPath $lovelyExtract
    $preparedLovely = Join-Path $lovelyExtract "version.dll"
    if (-not (Test-Path -LiteralPath $preparedLovely -PathType Leaf)) {
      throw "Lovely archive did not contain top-level version.dll."
    }
    $dllHash = Get-FileSha256 -LiteralPath $preparedLovely
    if ($dllHash -ne $LovelyDllSha256) {
      throw "Lovely version.dll SHA-256 mismatch after extraction."
    }
  }

  $preparedSmods = $null
  if ($smodsState.State -ne "current") {
    $smodsArchive = Join-Path $downloadRoot "smods-$SmodsCommit.zip"
    Save-VerifiedArchive -Uri $SmodsArchiveUri -Destination $smodsArchive -ExpectedSha256 $SmodsArchiveSha256
    $smodsExtract = Join-Path $extractRoot "smods"
    Expand-Archive -LiteralPath $smodsArchive -DestinationPath $smodsExtract
    $smodsSource = Join-Path $smodsExtract "smods-$SmodsCommit"
    if ((Get-SmodsInstalledVersion -Root $smodsSource) -ne $SmodsRuntimeVersion) {
      throw "Steamodded archive version validation failed."
    }
    $preparedSmods = Join-Path $preparedRoot "smods"
    Copy-DirectoryContents -Source $smodsSource -Destination $preparedSmods
  }

  $preparedBalatroBot = $null
  if ($balatroBotState.State -ne "current") {
    $balatroBotArchive = Join-Path $downloadRoot "balatrobot-$BalatroBotCommit.zip"
    Save-VerifiedArchive -Uri $BalatroBotArchiveUri -Destination $balatroBotArchive -ExpectedSha256 $BalatroBotArchiveSha256
    $balatroBotExtract = Join-Path $extractRoot "balatrobot"
    Expand-Archive -LiteralPath $balatroBotArchive -DestinationPath $balatroBotExtract
    $balatroBotSource = Join-Path $balatroBotExtract "balatrobot-$BalatroBotCommit"
    $pyprojectPath = Join-Path $balatroBotSource "pyproject.toml"
    if (-not (Test-Path -LiteralPath $pyprojectPath -PathType Leaf) -or
        (Get-Content -LiteralPath $pyprojectPath -Raw) -notmatch '(?m)^version\s*=\s*"1\.5\.2"\s*$') {
      throw "BalatroBot source archive did not declare package version $BalatroBotVersion."
    }
    $sourceFingerprint = Get-BalatroBotRuntimeFingerprint -Root $balatroBotSource
    if ($sourceFingerprint -ne $BalatroBotUpstreamRuntimeFingerprint) {
      throw "BalatroBot runtime fingerprint validation failed."
    }
    $preparedBalatroBot = Join-Path $preparedRoot "balatrobot"
    New-Item -ItemType Directory -Path (Join-Path $preparedBalatroBot "src") -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $balatroBotSource "balatrobot.json") -Destination $preparedBalatroBot
    Copy-Item -LiteralPath (Join-Path $balatroBotSource "balatrobot.lua") -Destination $preparedBalatroBot
    Copy-Item -LiteralPath (Join-Path $balatroBotSource "src\lua") -Destination (Join-Path $preparedBalatroBot "src") -Recurse
    Add-BalatroBotUnseededEntropyPatch -Root $preparedBalatroBot | Out-Null
    Add-BalatroBotEndlessPatch -Root $preparedBalatroBot | Out-Null
    if ((Get-BalatroBotRuntimeFingerprint -Root $preparedBalatroBot) -ne $BalatroBotRuntimeFingerprint) {
      throw "Patched BalatroBot runtime fingerprint validation failed."
    }
    $installMarker = [ordered]@{
      component = "BalatroBot"
      version = $BalatroBotVersion
      tag = "v$BalatroBotVersion"
      commit = $BalatroBotCommit
      source_archive_sha256 = $BalatroBotArchiveSha256
    } | ConvertTo-Json
    # Steamodded scans every root-level *.json file as potential mod metadata.
    # Keep our provenance marker extensionless so it is not parsed as a mod.
    Set-Content -LiteralPath (Join-Path $preparedBalatroBot ".balatro-pilot-install") -Value $installMarker -Encoding UTF8
  }

  $preparedUv = $null
  if ($uvState.State -ne "current") {
    $uvArchive = Join-Path $downloadRoot "uv-$UvVersion-windows-x64.zip"
    Save-VerifiedArchive -Uri $UvArchiveUri -Destination $uvArchive -ExpectedSha256 $UvArchiveSha256
    $uvExtract = Join-Path $extractRoot "uv"
    Expand-Archive -LiteralPath $uvArchive -DestinationPath $uvExtract
    $expectedUvFiles = [ordered]@{
      "uv.exe" = $UvExecutableSha256
      "uvw.exe" = $UvwExecutableSha256
      "uvx.exe" = $UvxExecutableSha256
    }
    foreach ($fileName in $expectedUvFiles.Keys) {
      $filePath = Join-Path $uvExtract $fileName
      if (-not (Test-Path -LiteralPath $filePath -PathType Leaf)) {
        throw "uv archive did not contain top-level $fileName."
      }
      $fileHash = Get-FileSha256 -LiteralPath $filePath
      if ($fileHash -ne $expectedUvFiles[$fileName]) {
        throw "$fileName SHA-256 mismatch after extraction."
      }
    }
    $uvVersionText = [string](& (Join-Path $uvExtract "uv.exe") --version 2>&1)
    if ($LASTEXITCODE -ne 0 -or $uvVersionText -notmatch ('^uv\s+' + [regex]::Escape($UvVersion) + '(?:\s|$)')) {
      throw "Extracted uv.exe did not report version $UvVersion."
    }
    $preparedUv = Join-Path $preparedRoot "uv-$UvVersion"
    New-Item -ItemType Directory -Path $preparedUv | Out-Null
    foreach ($fileName in $expectedUvFiles.Keys) {
      Copy-Item -LiteralPath (Join-Path $uvExtract $fileName) -Destination $preparedUv
    }
  }

  if (-not (Test-Path -LiteralPath $resolvedModsDirectory -PathType Container)) {
    New-Item -ItemType Directory -Path $resolvedModsDirectory -Force | Out-Null
  }

  if ($null -ne $preparedUv) {
    $uvParent = Split-Path -Parent $uvTarget
    if (-not (Test-Path -LiteralPath $uvParent -PathType Container)) {
      New-Item -ItemType Directory -Path $uvParent -Force | Out-Null
    }
    Install-PreparedTarget -Prepared $preparedUv -Target $uvTarget -Backup $null
  }

  if ($null -ne $preparedLovely) {
    $lovelyBackup = if ($lovelyState.State -eq "conflict") { New-BackupPath -Target $lovelyTarget } else { $null }
    Install-PreparedTarget -Prepared $preparedLovely -Target $lovelyTarget -Backup $lovelyBackup
  }
  if ($null -ne $preparedSmods) {
    $smodsBackup = if ($smodsState.State -eq "conflict") { New-BackupPath -Target $smodsTarget } else { $null }
    Install-PreparedTarget -Prepared $preparedSmods -Target $smodsTarget -Backup $smodsBackup
  }
  if ($null -ne $preparedBalatroBot) {
    $balatroBotBackup = if ($balatroBotState.State -eq "conflict") { New-BackupPath -Target $balatroBotTarget } else { $null }
    Install-PreparedTarget -Prepared $preparedBalatroBot -Target $balatroBotTarget -Backup $balatroBotBackup
  }

  Write-InstallStatus -Kind "ok" -Message "Pinned uv and mod stack installed. Start it with scripts\start-balatrobot.ps1."
} finally {
  $ProgressPreference = $oldProgressPreference
  if (Test-Path -LiteralPath $stagingRoot) {
    $resolvedStagingRoot = [System.IO.Path]::GetFullPath($stagingRoot)
    $resolvedTempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd([char]92)
    $expectedPrefix = $resolvedTempRoot + [System.IO.Path]::DirectorySeparatorChar + "balatro-pilot-install-"
    if ($resolvedStagingRoot.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase)) {
      Remove-Item -LiteralPath $resolvedStagingRoot -Recurse -Force
    }
  }
}
