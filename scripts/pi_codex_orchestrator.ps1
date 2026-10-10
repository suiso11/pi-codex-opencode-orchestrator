$ErrorActionPreference = "Stop"

$model = if ($env:PI_CODEX_MODEL) {
    $env:PI_CODEX_MODEL
} else {
    "openai-codex/gpt-5.6-sol"
}

$thinking = if ($env:PI_CODEX_THINKING) {
    $env:PI_CODEX_THINKING
} else {
    "medium"
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$extension = Join-Path (Split-Path -Parent $scriptDir) ".pi\extensions\opencode-orchestrator\index.ts"
if (-not (Test-Path -LiteralPath $extension)) {
    throw "OpenCode orchestrator extension was not found at $extension."
}

$runtime = if ($env:PI_ORCH_RUNTIME) { $env:PI_ORCH_RUNTIME } else { "omp" }
if ($runtime -notin @("omp", "pi")) { throw "PI_ORCH_RUNTIME must be omp or pi" }
$runtimeCommand = Get-Command $runtime -ErrorAction Stop
if ($runtime -eq "omp") {
    $extension = Join-Path (Split-Path -Parent $scriptDir) ".pi\extensions\opencode-orchestrator\omp.ts"
    $runtimeArgs = @("--allow-home", "--no-extensions", "--config", (Join-Path $scriptDir "omp-orchestrator.yml"))
} else {
    $runtimeArgs = @("--approve")
}
$opencodeCommand = Get-Command opencode -ErrorAction Stop

if (-not $env:PI_OPENCODE_BIN -and
    [System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT) {
    $npmPrefix = Split-Path -Parent $opencodeCommand.Source
    $opencodeExe = Join-Path $npmPrefix "node_modules\opencode-ai\bin\opencode.exe"
    if (-not (Test-Path -LiteralPath $opencodeExe)) {
        throw "OpenCode executable was not found at $opencodeExe. Reinstall with: npm install -g opencode-ai"
    }
    $env:PI_OPENCODE_BIN = $opencodeExe
}

$tools = if ($runtime -eq "omp") {
    "read,grep,glob,task,wait,opencode_task,opencode_spawn,opencode_wait,opencode_tools"
} else {
    "read,grep,find,ls,opencode_task,opencode_spawn,opencode_wait,opencode_tools"
}

& $runtimeCommand.Source @runtimeArgs --extension $extension --model $model --thinking $thinking --tools $tools @args

exit $LASTEXITCODE
