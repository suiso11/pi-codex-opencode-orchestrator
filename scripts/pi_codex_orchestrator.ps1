$ErrorActionPreference = "Stop"

$model = if ($env:PI_CODEX_MODEL) {
    $env:PI_CODEX_MODEL
} else {
    "openai-codex/gpt-5.5"
}

$piCommand = Get-Command pi -ErrorAction Stop
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

$tools = @(
    "read",
    "grep",
    "find",
    "ls",
    "bash",
    "opencode_task",
    "opencode_spawn",
    "opencode_wait",
    "opencode_check",
    "opencode_cancel",
    "opencode_list",
    "opencode_workflow",
    "opencode_workflow_wait",
    "opencode_workflow_check",
    "opencode_workflow_cancel",
    "opencode_workflow_list"
) -join ","

& $piCommand.Source `
    --approve `
    --model $model `
    --thinking high `
    --tools $tools `
    @args

exit $LASTEXITCODE
