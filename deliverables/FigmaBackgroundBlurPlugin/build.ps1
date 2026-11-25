# Build & install FigmaBackgroundBlur.aex (After Effects effect plug-in, Windows x64)
#
# Requirements:
#   - After Effects SDK 27.0 for Windows, copied to
#     <workspace>\ae-plugin\sdk\AfterEffectsSDK_27.0_win
#   - Visual Studio 2022 (v143 toolset) or VS BuildTools + Windows 10 SDK
#   - Python 3 (used by tools/patch_pipl_name.py, see note below)
#
# Usage:  powershell -ExecutionPolicy Bypass -File build.ps1
#
# NOTE (PiPL encoding): After Effects on a Chinese Windows installation decodes
# PiPL strings with the system ANSI code page (CP936). The SDK PiPL toolchain does
# not preserve non-ASCII strings reliably, so FigmaBackgroundBlurPiPL.r uses fixed-
# length ASCII placeholders and tools/patch_pipl_name.py rewrites the compiled
# resource with the Chinese name/category (same byte lengths, so the PiPL layout is
# unchanged). Do not skip the patch step.
$ErrorActionPreference = "Stop"

$Here    = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root    = Resolve-Path (Join-Path $Here "..\..")
$Sdk     = Join-Path $Root "ae-plugin\sdk\AfterEffectsSDK_27.0_win"
$Dest    = Join-Path $Sdk  "Examples\Template\FigmaBackgroundBlur"
$BuildDir = Join-Path $Root "ae-plugin\build"

if (-not (Test-Path $Sdk)) {
    throw "AE SDK not found at $Sdk - copy D:\AfterEffectsSDK_27.0_win there first."
}

# 1) Copy the plug-in sources into the SDK example tree (the vcxproj include paths
#    are relative to <SDK>\Examples\Template\FigmaBackgroundBlur\Win).
New-Item -ItemType Directory -Force -Path (Join-Path $Dest "Win") | Out-Null
Copy-Item (Join-Path $Here "src\*") $Dest -Recurse -Force
New-Item -ItemType Directory -Force -Path $BuildDir | Out-Null

# 2) Locate the VS developer environment / MSBuild (VS 2022 or newer, incl. Build Tools)
$VsDev = Get-ChildItem @(
            "C:\Program Files\Microsoft Visual Studio\2022\*\Common7\Tools\VsDevCmd.bat",
            "C:\Program Files\Microsoft Visual Studio\18\*\Common7\Tools\VsDevCmd.bat",
            "C:\Program Files (x86)\Microsoft Visual Studio\18\*\Common7\Tools\VsDevCmd.bat",
            "C:\Program Files (x86)\Microsoft Visual Studio\2022\*\Common7\Tools\VsDevCmd.bat"
         ) -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
$MsBuild = Get-ChildItem @(
            "C:\Program Files\Microsoft Visual Studio\2022\*\MSBuild\Current\Bin\MSBuild.exe",
            "C:\Program Files\Microsoft Visual Studio\18\*\MSBuild\Current\Bin\MSBuild.exe",
            "C:\Program Files (x86)\Microsoft Visual Studio\18\*\MSBuild\Current\Bin\MSBuild.exe",
            "C:\Program Files (x86)\Microsoft Visual Studio\2022\*\MSBuild\Current\Bin\MSBuild.exe"
           ) -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
if (-not $VsDev -or -not $MsBuild) {
    throw "Visual Studio 2022+ (or Build Tools) with C++ tools was not found."
}

$Project = Join-Path $Dest "Win\FigmaBackgroundBlur.vcxproj"
$Cmd = '"' + $VsDev + '" -arch=x64 -host_arch=x64 && "' + $MsBuild + '" "' + $Project + '" /p:Configuration=Release /p:Platform=x64 /p:AE_PLUGIN_BUILD_DIR="' + $BuildDir + '" /m /v:m /nologo'
Write-Host "Building: $Project"
cmd /c $Cmd
if ($LASTEXITCODE -ne 0) { throw "Build failed with exit code $LASTEXITCODE" }

$Aex = Join-Path $BuildDir "FigmaBackgroundBlur.aex"
if (-not (Test-Path $Aex)) { throw "Build finished but $Aex was not produced." }

# 3) Patch the PiPL name/category to Chinese (CP936) - required on zh_CN Windows.
$Python = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $Python) { $Python = (Get-Command py -ErrorAction SilentlyContinue).Source }
if (-not $Python) { throw "Python 3 not found; run tools/patch_pipl_name.py manually on $Aex." }
Write-Host "Patching PiPL strings: $Aex"
& $Python (Join-Path $Here "tools\patch_pipl_name.py") $Aex
if ($LASTEXITCODE -ne 0) { throw "PiPL patch failed with exit code $LASTEXITCODE" }

# 4) Install into After Effects 2026 (adjust the path for another AE version)
$PluginDir = "D:\Software\Adobe\Adobe After Effects 2026\Support Files\Plug-ins\F2A"
New-Item -ItemType Directory -Force -Path $PluginDir | Out-Null
Copy-Item $Aex (Join-Path $PluginDir "FigmaBackgroundBlur.aex") -Force
Write-Host "Installed: $(Join-Path $PluginDir 'FigmaBackgroundBlur.aex')"
Write-Host "Restart After Effects to load the plug-in."
