#requires -Version 5.1

[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = "Medium")]
param(
  [string]$BalatroDirectory = "",
  [string]$ModsDirectory = "",
  [ValidateSet("Hidden", "Foreground")]
  [string]$WindowMode = "Hidden",
  [ValidateSet("127.0.0.1")]
  [string]$HostAddress = "127.0.0.1",
  [ValidateRange(1, 65535)]
  [int]$Port = 12346,
  [ValidateRange(1, 100)]
  [int]$Gamespeed = 4,
  [ValidateRange(1, 240)]
  [int]$FpsCap = 60,
  # Preserve the current OBS/game layout on every normal background launch.
  [ValidateRange(640, 7680)]
  [int]$WindowClientWidth = 1708,
  [ValidateRange(360, 4320)]
  [int]$WindowClientHeight = 948,
  [ValidateRange(5, 60)]
  [int]$WaitForHealthSeconds = 45,
  [string]$LogsDirectory = "",
  # Keep Balatro's normal animation system at its native maximum speed (4x by
  # default). --fast is an explicit opt-in for headless/benchmark runs only.
  [switch]$Fast,
  [switch]$Headless,
  [switch]$RenderOnApi,
  [switch]$NoShaders,
  # Normal/stream play should sound like the game. Use -Audio:$false only for
  # silent automation or benchmark runs.
  [switch]$Audio = $true
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$BalatroBotVersion = "1.5.2"
$BalatroBotUpstreamRuntimeFingerprint = "56042aacfd861d14b3c7c01a50083e18647a70651c373834a4b9b45f1c16951f"
$BalatroBotEntropyRuntimeFingerprint = "d16f644fbc876316bc81b6f11a6694434de5ec371e704fc6ba244c73afd056b9"
$BalatroBotBrokenEntropyEndlessRuntimeFingerprint = "4ceb563a70550df685623685813b348128f4b2035e9f8010ef3841f5d8d5e5e4"
$BalatroBotRacyEntropyEndlessRuntimeFingerprint = "e935f034677a82d9cc83d4b8e1f1360dc9ba8361c0a66ba58cbc787b9c657014"
$BalatroBotUnsafeEndlessRuntimeFingerprint = "e2ab32128ec0fed5473e215df423265fac62278d8875af7c243e6423c3547e73"
$BalatroBotPrePackRuntimeFingerprint = "a5b67a53b06fd4a949b3031d870bea87c6280b8bb7e13a1ad0b9d79e9145603d"
$BalatroBotRuntimeFingerprint = "d53fa2eb86813c48e33b9d2c9317f786ef24bef28c0c60e4b4a48bcfcb6441e2"
$MinimumUvVersion = [version]"0.9.21"
$SmodsRuntimeVersion = "1.0.0~BETA-1814a-STEAMODDED"
$PinnedUvExecutableSha256 = "68a22cbab1674647bcda32120b214e6480f875414e3333f49f87ae99b4b0e0fa"
$PinnedUvxExecutableSha256 = "64ff99ae93be556b5bf1202ff827c3cd56efa1f9ed317220007d0d87e8a55caf"

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

function Set-BalatroWindowClientSize {
  param(
    [Parameter(Mandatory = $true)][int]$Width,
    [Parameter(Mandatory = $true)][int]$Height,
    [ValidateRange(1, 15)][int]$WaitSeconds = 10
  )

  if (-not ("BalatroPilotWindowSize.Native" -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Threading;

namespace BalatroPilotWindowSize
{
    public static class Native
    {
        [StructLayout(LayoutKind.Sequential)]
        private struct RECT { public int Left, Top, Right, Bottom; }

        [DllImport("user32.dll")]
        private static extern bool GetClientRect(IntPtr hWnd, out RECT rect);
        [DllImport("user32.dll")]
        private static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool SetWindowPos(
            IntPtr hWnd, IntPtr insertAfter, int x, int y, int width, int height, uint flags);
        [DllImport("user32.dll")]
        private static extern bool SetProcessDPIAware();

        private const uint SWP_NOMOVE = 0x0002;
        private const uint SWP_NOZORDER = 0x0004;
        private const uint SWP_NOACTIVATE = 0x0010;

        public static int[] ResizeClient(long rawHandle, int clientWidth, int clientHeight)
        {
            try { SetProcessDPIAware(); } catch { }
            IntPtr hWnd = new IntPtr(rawHandle);
            RECT client;
            RECT window;
            if (!GetClientRect(hWnd, out client) || !GetWindowRect(hWnd, out window))
                throw new Win32Exception("Unable to read the Balatro window bounds");

            int frameWidth = Math.Max(0, (window.Right - window.Left) - (client.Right - client.Left));
            int frameHeight = Math.Max(0, (window.Bottom - window.Top) - (client.Bottom - client.Top));
            if (!SetWindowPos(
                hWnd,
                IntPtr.Zero,
                0,
                0,
                clientWidth + frameWidth,
                clientHeight + frameHeight,
                SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE))
                throw new Win32Exception(Marshal.GetLastWin32Error());

            Thread.Sleep(100);
            if (!GetClientRect(hWnd, out client))
                throw new Win32Exception("Unable to verify the Balatro client bounds");
            return new[] { client.Right - client.Left, client.Bottom - client.Top };
        }
    }
}
'@
  }

  $deadline = [DateTime]::UtcNow.AddSeconds($WaitSeconds)
  do {
    $game = Get-Process -Name "Balatro" -ErrorAction SilentlyContinue |
      Where-Object { $_.MainWindowHandle -ne 0 } |
      Sort-Object StartTime -Descending |
      Select-Object -First 1
    if ($null -ne $game) {
      try {
        $actual = [BalatroPilotWindowSize.Native]::ResizeClient(
          [long]$game.MainWindowHandle,
          $Width,
          $Height
        )
        if ($actual[0] -eq $Width -and $actual[1] -eq $Height) {
          Write-Output "[window] Fixed Balatro client size at ${Width}x${Height}."
        } else {
          Write-Warning "Balatro requested ${Width}x${Height}, but Windows reported $($actual[0])x$($actual[1])."
        }
        return
      } catch {
        Write-Warning "Could not fix the Balatro window size: $($_.Exception.Message)"
        return
      }
    }
    Start-Sleep -Milliseconds 200
  } while ([DateTime]::UtcNow -lt $deadline)

  Write-Warning "Balatro window was not ready; client size ${Width}x${Height} was not applied."
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

  $candidateDirectories = New-Object System.Collections.Generic.List[string]
  if (-not [string]::IsNullOrWhiteSpace($ExplicitDirectory)) {
    Add-CandidateDirectory -List $candidateDirectories -Path $ExplicitDirectory
  } else {
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
  }

  foreach ($candidate in @($candidateDirectories | Select-Object -Unique)) {
    if (Test-Path -LiteralPath (Join-Path $candidate "Balatro.exe") -PathType Leaf) {
      return $candidate
    }
  }
  throw "Balatro Steam installation was not found. Pass -BalatroDirectory explicitly."
}

function Test-BalatroBotHealth {
  param(
    [Parameter(Mandatory = $true)][string]$ServerHost,
    [Parameter(Mandatory = $true)][int]$ServerPort
  )
  $healthUri = "http://{0}:{1}/" -f $ServerHost, $ServerPort
  $payload = '{"jsonrpc":"2.0","method":"health","params":{},"id":1}'
  try {
    $response = Invoke-RestMethod -UseBasicParsing -Uri $healthUri -Method Post -ContentType "application/json" -Body $payload -TimeoutSec 2
    return ($null -ne $response.result -and [string]$response.result.status -eq "ok")
  } catch {
    return $false
  }
}

function ConvertTo-StartProcessArgument {
  param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value)
  if ($Value -notmatch '[\s"]') { return $Value }
  if ($Value.Contains('"')) {
    throw "A process argument contains an unsupported quote character."
  }
  return '"' + $Value + '"'
}

function Get-BalatroBotRuntimeFingerprint {
  param([Parameter(Mandatory = $true)][string]$Root)

  $runtimeFiles = New-Object System.Collections.Generic.List[System.IO.FileInfo]
  foreach ($relativePath in @("balatrobot.json", "balatrobot.lua")) {
    $filePath = Join-Path $Root $relativePath
    if (-not (Test-Path -LiteralPath $filePath -PathType Leaf)) { return $null }
    $runtimeFiles.Add((Get-Item -LiteralPath $filePath)) | Out-Null
  }
  $luaRoot = Join-Path $Root "src\lua"
  if (-not (Test-Path -LiteralPath $luaRoot -PathType Container)) { return $null }
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
  $methodSource = Join-Path $assetRoot "openrpc-endless-method.json"
  foreach ($asset in @($endpointSource, $playSource, $cashOutSource, $packSource, $methodSource)) {
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

  Copy-Item -LiteralPath $playSource -Destination (Join-Path $Root "src\lua\endpoints\play.lua") -Force -ErrorAction Stop
  Copy-Item -LiteralPath $cashOutSource -Destination (Join-Path $Root "src\lua\endpoints\cash_out.lua") -Force -ErrorAction Stop
  Copy-Item -LiteralPath $packSource -Destination (Join-Path $Root "src\lua\endpoints\pack.lua") -Force -ErrorAction Stop

  $entryPath = Join-Path $Root "balatrobot.lua"
  $entry = [System.IO.File]::ReadAllText($entryPath)
  if (-not $entry.Contains('"src/lua/endpoints/endless.lua"')) {
    $newline = if ($entry.Contains("`r`n")) { "`r`n" } else { "`n" }
    $anchor = '  "src/lua/endpoints/cash_out.lua",' + $newline
    if (-not $entry.Contains($anchor)) {
      throw "The pinned BalatroBot entry module no longer matches the Endless endpoint registration anchor."
    }
    $entry = $entry.Replace($anchor, $anchor + '  "src/lua/endpoints/endless.lua",' + $newline)
    [System.IO.File]::WriteAllText($entryPath, $entry, (New-Object System.Text.UTF8Encoding($false)))
  }

  $openRpcPath = Join-Path $Root "src\lua\utils\openrpc.json"
  $openRpc = Get-Content -LiteralPath $openRpcPath -Raw | ConvertFrom-Json
  $alreadyRegistered = @($openRpc.methods | Where-Object { [string]$_.name -eq "endless" }).Count -gt 0
  if (-not $alreadyRegistered) {
    $method = Get-Content -LiteralPath $methodSource -Raw | ConvertFrom-Json
    $openRpc.methods = @($openRpc.methods) + @($method)
    [System.IO.File]::WriteAllText(
      $openRpcPath,
      ($openRpc | ConvertTo-Json -Depth 100),
      (New-Object System.Text.UTF8Encoding($false))
    )
  }
  return $true
}

if ($PSVersionTable.PSVersion.Major -ge 6 -and -not $IsWindows) {
  throw "This launcher supports Windows only."
}
if ($Headless -and $RenderOnApi) {
  throw "-Headless and -RenderOnApi are mutually exclusive."
}

$uvCommand = Get-Command "uv" -CommandType Application -ErrorAction SilentlyContinue
$uvxCommand = Get-Command "uvx" -CommandType Application -ErrorAction SilentlyContinue
$uvExecutable = if ($null -eq $uvCommand) { $null } else { $uvCommand.Source }
$uvxExecutable = if ($null -eq $uvxCommand) { $null } else { $uvxCommand.Source }
if ($null -eq $uvExecutable -or $null -eq $uvxExecutable) {
  if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    $fixedUvDirectory = Join-Path $env:LOCALAPPDATA "BalatroPilot\tools\uv-0.12.3"
    $fixedUvExecutable = Join-Path $fixedUvDirectory "uv.exe"
    $fixedUvxExecutable = Join-Path $fixedUvDirectory "uvx.exe"
    if ((Test-Path -LiteralPath $fixedUvExecutable -PathType Leaf) -and
        (Test-Path -LiteralPath $fixedUvxExecutable -PathType Leaf)) {
      $fixedUvHash = Get-FileSha256 -LiteralPath $fixedUvExecutable
      $fixedUvxHash = Get-FileSha256 -LiteralPath $fixedUvxExecutable
      if ($fixedUvHash -eq $PinnedUvExecutableSha256 -and $fixedUvxHash -eq $PinnedUvxExecutableSha256) {
        $uvExecutable = $fixedUvExecutable
        $uvxExecutable = $fixedUvxExecutable
      } else {
        throw "The pinned per-user uv tools directory failed SHA-256 validation. Re-run install-balatrobot.ps1 after inspecting the directory."
      }
    }
  }
}
if ($null -eq $uvExecutable -or $null -eq $uvxExecutable) {
  throw "uv/uvx was not found on PATH or in the pinned per-user tools directory. Run install-balatrobot.ps1 first."
}
$uvVersionText = [string](& $uvExecutable --version 2>&1)
if ($LASTEXITCODE -ne 0 -or $uvVersionText -notmatch '(?<version>\d+\.\d+\.\d+)') {
  throw "Unable to determine the installed uv version: $uvVersionText"
}
$uvVersion = [version]$Matches["version"]
if ($uvVersion -lt $MinimumUvVersion) {
  throw "uv $uvVersion is too old. BalatroBot requires uv $MinimumUvVersion or newer."
}

$resolvedBalatroDirectory = Find-BalatroDirectory -ExplicitDirectory $BalatroDirectory
$balatroExe = Join-Path $resolvedBalatroDirectory "Balatro.exe"
$lovelyDll = Join-Path $resolvedBalatroDirectory "version.dll"
if (-not (Test-Path -LiteralPath $lovelyDll -PathType Leaf)) {
  throw "Lovely version.dll was not found: $lovelyDll. Run install-balatrobot.ps1 first."
}

if ([string]::IsNullOrWhiteSpace($ModsDirectory)) {
  if ([string]::IsNullOrWhiteSpace($env:APPDATA)) {
    throw "APPDATA is unavailable. Pass -ModsDirectory explicitly."
  }
  $ModsDirectory = Join-Path $env:APPDATA "Balatro\Mods"
}
$resolvedModsDirectory = [System.IO.Path]::GetFullPath(
  [Environment]::ExpandEnvironmentVariables($ModsDirectory)
)
$smodsVersionPath = Join-Path $resolvedModsDirectory "smods\version.lua"
$balatroBotManifest = Join-Path $resolvedModsDirectory "balatrobot\balatrobot.json"
$balatroBotEntry = Join-Path $resolvedModsDirectory "balatrobot\balatrobot.lua"
$balatroBotLua = Join-Path $resolvedModsDirectory "balatrobot\src\lua"
if (-not (Test-Path -LiteralPath $smodsVersionPath -PathType Leaf)) {
  throw "Steamodded was not found under $resolvedModsDirectory. Run install-balatrobot.ps1 first."
}
$smodsVersionContent = Get-Content -LiteralPath $smodsVersionPath -Raw
if ($smodsVersionContent -notmatch [regex]::Escape($SmodsRuntimeVersion)) {
  Write-Warning "The installed Steamodded version does not match the tested $SmodsRuntimeVersion build."
}
foreach ($requiredPath in @($balatroBotManifest, $balatroBotEntry, $balatroBotLua)) {
  if (-not (Test-Path -LiteralPath $requiredPath)) {
    throw "BalatroBot runtime is incomplete; missing: $requiredPath"
  }
}
$balatroBotRoot = Join-Path $resolvedModsDirectory "balatrobot"
$installedRuntimeFingerprint = Get-BalatroBotRuntimeFingerprint -Root $balatroBotRoot
if ($installedRuntimeFingerprint -eq $BalatroBotUpstreamRuntimeFingerprint -or
    $installedRuntimeFingerprint -eq $BalatroBotEntropyRuntimeFingerprint -or
    $installedRuntimeFingerprint -eq $BalatroBotBrokenEntropyEndlessRuntimeFingerprint -or
    $installedRuntimeFingerprint -eq $BalatroBotRacyEntropyEndlessRuntimeFingerprint -or
    $installedRuntimeFingerprint -eq $BalatroBotUnsafeEndlessRuntimeFingerprint -or
    $installedRuntimeFingerprint -eq $BalatroBotPrePackRuntimeFingerprint) {
  if ($PSCmdlet.ShouldProcess($balatroBotRoot, "Apply the pinned unseeded-run entropy and safe Endless-settlement patches")) {
    Add-BalatroBotUnseededEntropyPatch -Root $balatroBotRoot | Out-Null
    Add-BalatroBotEndlessPatch -Root $balatroBotRoot | Out-Null
    $installedRuntimeFingerprint = Get-BalatroBotRuntimeFingerprint -Root $balatroBotRoot
    if ($installedRuntimeFingerprint -ne $BalatroBotRuntimeFingerprint) {
      throw "The BalatroBot unseeded-run entropy patch failed runtime fingerprint validation."
    }
    Write-Output "[ok] Applied the entropy, safe settlement, and selected-card pack patches; normal runs keep unlocks and mixed Celestial packs do not wait for a nonexistent hand."
  }
} elseif ($installedRuntimeFingerprint -ne $BalatroBotRuntimeFingerprint) {
  throw "BalatroBot runtime does not match the pinned v$BalatroBotVersion build. Re-run install-balatrobot.ps1 after inspecting the Mods directory."
}

if (Test-BalatroBotHealth -ServerHost $HostAddress -ServerPort $Port) {
  Write-Output "[ok] BalatroBot is already healthy at http://${HostAddress}:$Port/."
  return
}
$runningBalatro = @(Get-Process -Name "Balatro" -ErrorAction SilentlyContinue)
if ($runningBalatro.Count -gt 0) {
  throw "Balatro is already running but BalatroBot did not answer on port $Port. Close that game instance, then launch it with this script."
}

$projectRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($LogsDirectory)) {
  $LogsDirectory = Join-Path $projectRoot "runs\balatrobot-server"
}
$resolvedLogsDirectory = [System.IO.Path]::GetFullPath(
  [Environment]::ExpandEnvironmentVariables($LogsDirectory)
)

$compatLauncher = Join-Path $projectRoot "scripts\balatrobot-serve-compat.py"
if (-not (Test-Path -LiteralPath $compatLauncher -PathType Leaf)) {
  throw "BalatroBot compatibility launcher is missing: $compatLauncher"
}

# BalatroBot 1.5.2's stock serve loop survives after its owned game exits.
# Remove only old, non-listening launchers for this exact project before a new
# session, so repeated livestream runs do not accumulate uv/Python processes.
$staleBefore = (Get-Date).AddMinutes(-2)
$escapedCompatLauncher = [Regex]::Escape($compatLauncher)
$portPattern = "(^|\s)--port\s+$Port(\s|$)"
$staleLaunchers = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
  $_.Name -match "^(uv|python)\.exe$" -and
  $_.CommandLine -match $escapedCompatLauncher -and
  $_.CommandLine -match $portPattern -and
  $_.CreationDate -lt $staleBefore
})
if ($staleLaunchers.Count -gt 0) {
  $staleIds = @($staleLaunchers | Select-Object -ExpandProperty ProcessId)
  Stop-Process -Id $staleIds -Force -ErrorAction SilentlyContinue
  Write-Output "[cleanup] Stopped $($staleIds.Count) stale BalatroBot launcher process(es) from earlier game sessions."
  Start-Sleep -Milliseconds 250
}

$balatroBotArguments = New-Object System.Collections.Generic.List[string]
foreach ($argument in @(
  "run", "--no-project", "--python", "3.13", "--with", "balatrobot==$BalatroBotVersion",
  "python", $compatLauncher, "serve",
  "--platform", "windows",
  "--love-path", $balatroExe,
  "--lovely-path", $lovelyDll,
  "--host", $HostAddress,
  "--port", [string]$Port,
  "--gamespeed", [string]$Gamespeed,
  "--fps-cap", [string]$FpsCap,
  "--logs-path", $resolvedLogsDirectory
)) {
  $balatroBotArguments.Add($argument) | Out-Null
}
if ($Fast) { $balatroBotArguments.Add("--fast") | Out-Null }
if ($Headless) { $balatroBotArguments.Add("--headless") | Out-Null }
if ($RenderOnApi) { $balatroBotArguments.Add("--render-on-api") | Out-Null }
if ($NoShaders) { $balatroBotArguments.Add("--no-shaders") | Out-Null }
if ($Audio) { $balatroBotArguments.Add("--audio") | Out-Null }

$modeDescription = if ($WindowMode -eq "Hidden") { "in the background with a hidden console" } else { "in the foreground" }
if (-not $PSCmdlet.ShouldProcess(
  "BalatroBot $BalatroBotVersion at http://${HostAddress}:$Port/",
  "Launch pinned uvx package $modeDescription"
)) {
  return
}
if (-not (Test-Path -LiteralPath $resolvedLogsDirectory -PathType Container)) {
  New-Item -ItemType Directory -Path $resolvedLogsDirectory -Force | Out-Null
}

Write-Output "[launch] uv run --with balatrobot==$BalatroBotVersion (startup-race compatibility probe)"
Write-Output "[target] $balatroExe"
Write-Output "[api] http://${HostAddress}:$Port/"

if ($WindowMode -eq "Foreground") {
  $previousLovelyModDirectory = [Environment]::GetEnvironmentVariable("LOVELY_MOD_DIR", "Process")
  try {
    [Environment]::SetEnvironmentVariable("LOVELY_MOD_DIR", $resolvedModsDirectory, "Process")
    & $uvExecutable @($balatroBotArguments)
    $foregroundExitCode = $LASTEXITCODE
  } finally {
    [Environment]::SetEnvironmentVariable("LOVELY_MOD_DIR", $previousLovelyModDirectory, "Process")
  }
  exit $foregroundExitCode
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$stdoutPath = Join-Path $resolvedLogsDirectory "launcher-$stamp.stdout.log"
$stderrPath = Join-Path $resolvedLogsDirectory "launcher-$stamp.stderr.log"
$startProcessArguments = @($balatroBotArguments | ForEach-Object {
  ConvertTo-StartProcessArgument -Value $_
})
$previousLovelyModDirectory = [Environment]::GetEnvironmentVariable("LOVELY_MOD_DIR", "Process")
try {
  [Environment]::SetEnvironmentVariable("LOVELY_MOD_DIR", $resolvedModsDirectory, "Process")
  $process = Start-Process -FilePath $uvExecutable `
    -ArgumentList $startProcessArguments `
    -WorkingDirectory $projectRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -PassThru
} finally {
  [Environment]::SetEnvironmentVariable("LOVELY_MOD_DIR", $previousLovelyModDirectory, "Process")
}

$deadline = [DateTime]::UtcNow.AddSeconds($WaitForHealthSeconds)
do {
  Start-Sleep -Milliseconds 500
  $process.Refresh()
  if ($process.HasExited) {
    throw "BalatroBot launcher exited with code $($process.ExitCode). Inspect $stderrPath and $stdoutPath."
  }
  if (Test-BalatroBotHealth -ServerHost $HostAddress -ServerPort $Port) {
    Write-Output "[ok] BalatroBot is healthy (launcher PID $($process.Id))."
    if (-not $Headless) {
      Set-BalatroWindowClientSize -Width $WindowClientWidth -Height $WindowClientHeight
    }
    Write-Output "[logs] $resolvedLogsDirectory"
    return
  }
} while ([DateTime]::UtcNow -lt $deadline)

throw "BalatroBot did not become healthy within $WaitForHealthSeconds seconds. Launcher PID $($process.Id) is still running; inspect $stderrPath and $stdoutPath."
