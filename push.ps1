# Push this repo to a remote you own.
# Usage:  .\push.ps1 https://github.com/<you>/dsh-figgenie-paper-diagram.git
param([Parameter(Mandatory = $true)][string]$Remote)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

git remote remove origin 2>$null
git remote add origin $Remote
Write-Host "remote -> $Remote"
Write-Host "commit -> $(git rev-parse HEAD)"

# the repo is ~250 MB packed, so give the connection room
git push -u origin main
if ($LASTEXITCODE -ne 0) { throw "push failed with $LASTEXITCODE" }

Write-Host ""
Write-Host "pushed. the market index needs this exact commit:"
git rev-parse HEAD
