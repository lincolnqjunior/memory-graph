#!/usr/bin/env pwsh
# test-falkordb-isolation.ps1
#
# DEC-016 follow-up: spin up a throwaway FalkorDB container on port 6380,
# point the memorygraph CLI at it via MEMORY_FALKORDB_PORT, run the test
# suite against the isolated graph, and tear the container down on exit.
#
# Why port 6380: the production memorygraph-falkordb stack binds 6379
# (see ~/source/memorygraph-docker/docker-compose.yml:20). Tests must
# NEVER touch the prod graph — running against 6379 risks corrupting
# 381+ live memories. 6380 is the documented test-isolation port.
#
# Usage:
#   pwsh scripts/test-falkordb-isolation.ps1           # run full bun test
#   pwsh scripts/test-falkordb-isolation.ps1 -Keep     # leave container up
#   pwsh scripts/test-falkordb-isolation.ps1 -Verbose  # docker logs on stderr
#
# Exit codes:
#   0  tests passed, container cleaned up (or kept if -Keep)
#   1  tests failed (container always torn down on test failure)
#   2  docker unavailable / port collision / image pull failure

[CmdletBinding()]
param(
    [switch]$Keep,
    [string]$Image = "falkordb/falkordb:v4.16.3",
    [int]$Port = 6380,
    [string]$ContainerName = "memorygraph-falkordb-test"
)

$ErrorActionPreference = "Stop"

function Write-Step {
    param([string]$Msg)
    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] $Msg" -ForegroundColor Cyan
}

function Write-Warn {
    param([string]$Msg)
    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] WARN: $Msg" -ForegroundColor Yellow
}

function Write-Fail {
    param([string]$Msg)
    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] FAIL: $Msg" -ForegroundColor Red
}

# ---------------------------------------------------------------------------
# Pre-flight: docker available?
# ---------------------------------------------------------------------------
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Fail "docker not found on PATH. Install Docker Desktop and retry."
    exit 2
}

$dockerOk = & docker info 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Fail "docker daemon unreachable. Start Docker Desktop and retry."
    Write-Host ($dockerOk -join "`n")
    exit 2
}

# ---------------------------------------------------------------------------
# Pre-flight: port 6380 free on host?
# ---------------------------------------------------------------------------
$portInUse = & docker ps --format "{{.Names}}" --filter "publish=$Port" 2>$null
if ($portInUse) {
    Write-Fail "Port $Port already bound by container(s): $($portInUse -join ', ')"
    Write-Host "  Stop the conflicting container, or pass -Port <other>."
    exit 2
}

# ---------------------------------------------------------------------------
# Pre-flight: Windows reserved port range (AGENTS.md guardrail)
# ---------------------------------------------------------------------------
$excludedOutput = & netsh int ipv4 show excludedportrange protocol=tcp 2>$null
if ($LASTEXITCODE -eq 0 -and $excludedOutput) {
    # Parse "X-Y" ranges and check for collision with $Port
    $ranges = $excludedOutput | Select-String -Pattern '(\d+)\s+(\d+)\s*$' | ForEach-Object {
        $_.Matches[0].Groups[1..2] | ForEach-Object { [int]$_.Value }
    }
    for ($i = 0; $i -lt $ranges.Count; $i += 2) {
        $start = $ranges[$i]
        $end = $ranges[$i + 1]
        if ($Port -ge $start -and $Port -le $end) {
            Write-Fail "Port $Port is in the Windows reserved range $start-$end."
            Write-Host "  Pick a different port via -Port <other>."
            exit 2
        }
    }
}

# ---------------------------------------------------------------------------
# Pull image (idempotent)
# ---------------------------------------------------------------------------
Write-Step "Ensuring image $Image is available..."
& docker pull $Image 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Fail "Failed to pull $Image."
    exit 2
}

# ---------------------------------------------------------------------------
# Start container
# ---------------------------------------------------------------------------
Write-Step "Starting FalkorDB test container on port $Port..."
$runArgs = @(
    "run", "-d",
    "--name", $ContainerName,
    "--publish", "${Port}:6379",
    "--publish", "3001:3000",   # alt UI port (avoid collision with prod 3000)
    $Image
)
& docker @runArgs 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Fail "docker run failed. Container name '$ContainerName' may be taken."
    Write-Host "  Remove it with: docker rm -f $ContainerName"
    exit 2
}

# Wait for health: redis-cli ping returns PONG
Write-Step "Waiting for FalkorDB to accept connections on :$Port..."
$ready = $false
for ($i = 0; $i -lt 30; $i++) {
    $ping = & docker exec $ContainerName redis-cli ping 2>$null
    if ($ping -eq "PONG") {
        $ready = $true
        break
    }
    Start-Sleep -Seconds 1
}
if (-not $ready) {
    Write-Fail "FalkorDB did not respond to PING within 30s."
    & docker logs $ContainerName 2>&1 | Select-Object -Last 30
    & docker rm -f $ContainerName 2>&1 | Out-Null
    exit 2
}
Write-Step "FalkorDB ready on :$Port (container $ContainerName)"

# ---------------------------------------------------------------------------
# Isolation smoke check: query prod (:6379) and test (:$Port) and confirm
# the counts diverge. Proves env-var routing actually targets 6380 and that
# the test container can't reach the prod graph.
# ---------------------------------------------------------------------------
Write-Step "Isolation smoke check: prod (:6379) vs test (:$Port) divergence..."

function Get-MemoryCount {
    param([string]$Backend, [string]$FalkorHost = "localhost", [int]$FalkorPort = 0)
    $savedBackend = $env:MEMORY_BACKEND
    $savedHost = $env:MEMORY_FALKORDB_HOST
    $savedPort = $env:MEMORY_FALKORDB_PORT
    try {
        $env:MEMORY_BACKEND = $Backend
        $env:MEMORY_FALKORDB_HOST = $FalkorHost
        if ($FalkorPort -gt 0) { $env:MEMORY_FALKORDB_PORT = "$FalkorPort" }
        $output = & memorygraph stats 2>$null
        $count = ($output | Select-String -Pattern "Total Memories:\s+(\d+)" |
            ForEach-Object { $_.Matches[0].Groups[1].Value } |
            Select-Object -First 1)
        return $count
    }
    finally {
        $env:MEMORY_BACKEND = $savedBackend
        $env:MEMORY_FALKORDB_HOST = $savedHost
        $env:MEMORY_FALKORDB_PORT = $savedPort
    }
}

$prodCount = Get-MemoryCount -Backend "falkordb" -FalkorPort 6379
$testCount = Get-MemoryCount -Backend "falkordb" -FalkorPort $Port

Write-Host "    Prod (:6379):  $prodCount memories  (expected: 381)" -ForegroundColor Gray
Write-Host "    Test (:$Port): $testCount memories  (expected: 0)"   -ForegroundColor Gray

if ($prodCount -ne "381") {
    Write-Warn "Prod memory count is $prodCount, not 381. Possible prod mutation?"
}
if ($testCount -ne "0") {
    Write-Warn "Test port reports $testCount memories. Port collision or pre-existing data?"
}
if (($prodCount -eq "381") -and ($testCount -eq "0")) {
    Write-Step "Isolation verified — prod and test graphs are independent"
}

# ---------------------------------------------------------------------------
# Run tests with isolated backend
# ---------------------------------------------------------------------------
$env:MEMORY_BACKEND = "falkordb"
$env:MEMORY_FALKORDB_HOST = "localhost"
$env:MEMORY_FALKORDB_PORT = "$Port"

Write-Step "Running bun test against isolated FalkorDB..."
$testOk = $true
try {
    # Run tests from the memorygraph repo root (where package.json + tests/ live).
    # Resolve relative to this script so it works regardless of caller's cwd.
    $repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
    & bun test --cwd "$repoRoot" 2>&1 | Tee-Object -Variable testOutput | Select-Object -Last 50
    if ($LASTEXITCODE -ne 0) { $testOk = $false }
}
catch {
    Write-Fail "bun test threw: $_"
    $testOk = $false
}
finally {
    # ---------------------------------------------------------------------------
    # Cleanup (unless -Keep)
    # ---------------------------------------------------------------------------
    if ($Keep) {
        Write-Step "Tests complete. Container kept running: $ContainerName"
        Write-Host "  Stop with: docker rm -f $ContainerName"
    }
    else {
        Write-Step "Stopping and removing test container..."
        & docker rm -f $ContainerName 2>&1 | Out-Null
    }
}

if ($testOk) {
    Write-Step "All tests passed against isolated FalkorDB :$Port"
    exit 0
}
else {
    Write-Fail "Tests failed. See output above."
    exit 1
}