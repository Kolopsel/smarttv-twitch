<#
.SYNOPSIS
  Publish this Twellie fork (Midnight skin) to your GitHub account so
  TizenBrew on the TV can fetch it as gh/<you>/smarttv-twitch.

.DESCRIPTION
  Run AFTER forking https://github.com/nkatchik/smarttv-twitch on
  github.com (keep the repository name "smarttv-twitch"). The script
  checks the fork exists, sets your Git identity if missing, commits
  the known skin files by name, points origin at your fork, and
  pushes. It then prints the GitHub Release + TV steps. Git will ask
  you to sign in with GitHub (browser) on first push.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\publish-fork.ps1 -GitHubUser octocat
#>
param(
  [string]$GitHubUser
)

$ErrorActionPreference = 'Stop'

function Run-Git {
  param([Parameter(Mandatory = $true)][string[]]$GitArgs)
  & git @GitArgs
  if ($LASTEXITCODE -ne 0) { throw "git $($GitArgs -join ' ') failed with exit code $LASTEXITCODE" }
}

if (-not (Test-Path '.git')) {
  throw 'Run this script from the twitch-tv-tizen folder (no .git directory here).'
}
if (-not $GitHubUser) {
  $GitHubUser = Read-Host 'Your GitHub username (the account that owns the fork)'
}
if (-not $GitHubUser) { throw 'GitHub username is required.' }

$forkUrl = "https://github.com/$GitHubUser/smarttv-twitch"
Write-Host "Checking fork: $forkUrl"
$code = & curl.exe -s -o NUL -w "%{http_code}" $forkUrl
if ($code -ne '200') {
  throw "Fork not found (HTTP $code). Fork https://github.com/nkatchik/smarttv-twitch first, keeping the name smarttv-twitch, then re-run."
}

$name = & git config --global user.name
if (-not $name) {
  $name = Read-Host 'Git user.name (e.g. your name)'
  Run-Git @('config', '--global', 'user.name', $name)
}
$email = & git config --global user.email
if (-not $email) {
  $email = Read-Host 'Git user.email (the email on your GitHub account)'
  Run-Git @('config', '--global', 'user.email', $email)
}

$files = @(
  'package.json',
  'src/platforms/tizen/config.xml',
  'src/ui/styles.css',
  'test/skin.test.js',
  'docs/install/tizenbrew-fork.md',
  'publish-fork.ps1'
)
Write-Host ''
Write-Host 'Changes that will be committed:'
& git status --short -- $files
$pending = & git status --porcelain -- $files
if ($pending) {
  $answer = Read-Host 'Commit these files as "Midnight skin for the TV UI" and push to your fork? (y/n)'
  if ($answer -ne 'y') { throw 'Stopped by user. Nothing was committed.' }
  Run-Git (@('add', '--') + $files)
  Run-Git @('commit', '-m', 'Midnight skin for the TV UI')
} else {
  Write-Host 'Nothing new to commit for the skin files; continuing to push.'
}

$remote = & git remote get-url origin 2>$null
if ($remote) { Run-Git @('remote', 'set-url', 'origin', "$forkUrl.git") }
else { Run-Git @('remote', 'add', 'origin', "$forkUrl.git") }

Write-Host 'Pushing master to your fork (GitHub may open a browser sign-in)...'
Run-Git @('push', '-u', 'origin', 'master')

$version = (Get-Content 'package.json' -Raw | ConvertFrom-Json).version
Write-Host ''
Write-Host 'Push complete. Remaining steps:'
Write-Host "1. Publish the release TizenBrew will fetch:"
Write-Host "   $forkUrl/releases/new"
Write-Host "   Tag: v$version   Title: v$version Midnight skin   -> Publish release"
Write-Host ("2. Verify the CDN serves your version (expect version " + $version + "):")
Write-Host "   https://cdn.jsdelivr.net/gh/$GitHubUser/smarttv-twitch/package.json"
Write-Host '3. On the TV: TizenBrew -> Module Manager -> Add GitHub module ->'
Write-Host "   $GitHubUser/smarttv-twitch -> select Twellie."
Write-Host 'Full guide + TV verification checklist: docs\install\tizenbrew-fork.md'
