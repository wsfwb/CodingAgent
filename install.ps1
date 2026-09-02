[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$repositoryRoot = $PSScriptRoot
$codingAgentPath = Join-Path $repositoryRoot "packages\coding-agent"
$subagentsPath = Join-Path $repositoryRoot "packages\subagents"
$planModePath = Join-Path $repositoryRoot "packages\plan-mode"
$configScript = Join-Path $repositoryRoot "scripts\configure-global-packages.mjs"
$settingsPath = Join-Path $HOME ".pi\agent\settings.json"

function Invoke-CheckedCommand {
	param(
		[string]$Command,
		[string[]]$Arguments,
		[string]$WorkingDirectory
	)

	Push-Location $WorkingDirectory
	try {
		& $Command @Arguments
		if ($LASTEXITCODE -ne 0) {
			throw "$Command failed with exit code $LASTEXITCODE."
		}
	} finally {
		Pop-Location
	}
}

Write-Host "Installing the complete customized Pi build..." -ForegroundColor Cyan

foreach ($command in @("node", "npm")) {
	if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
		throw "$command was not found. Install Node.js 22.19.0 or newer, then run this script again."
	}
}

$nodeVersionText = (& node -p "process.versions.node").Trim()
if ([version]$nodeVersionText -lt [version]"22.19.0") {
	throw "Node.js $nodeVersionText is too old. Version 22.19.0 or newer is required."
}

foreach ($path in @($codingAgentPath, $subagentsPath, $planModePath, $configScript)) {
	if (-not (Test-Path -LiteralPath $path)) {
		throw "Required project path is missing: $path"
	}
}

Invoke-CheckedCommand "npm" @("install", "--ignore-scripts") $repositoryRoot
Invoke-CheckedCommand "npm" @("run", "build:offline") $repositoryRoot
Invoke-CheckedCommand "npm" @("link") $codingAgentPath
Invoke-CheckedCommand "node" @($configScript, $settingsPath, $subagentsPath, $planModePath) $repositoryRoot

if (-not (Get-Command "pi" -ErrorAction SilentlyContinue)) {
	throw "Installation finished, but the global pi command is not available on PATH."
}

Invoke-CheckedCommand "pi" @("--version") $repositoryRoot

Write-Host "Installation complete. You can now run pi from any directory." -ForegroundColor Green
Write-Host "Keep this repository at: $repositoryRoot"
