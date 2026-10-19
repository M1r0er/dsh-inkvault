# 把 dsh-inkvault 的记忆库接入用户现有 Obsidian 库
# 目标：<USERPROFILE>\Documents\Obsidian Vault\InkVault
# 做三件事：1) profile 补丁加 inkvault 配置覆盖；2) 建目录；3) 迁移已写入的笔记
$ErrorActionPreference = 'Stop'
$profilePatch = Join-Path $env:USERPROFILE '.dsh\profiles\desktop\cordis.patch.yml'
$workspace = 'D:\DSH Workspace\dsh-inkvault'
$backupDir = Join-Path $workspace '.diag'
$vaultRoot = Join-Path $env:USERPROFILE 'Documents\Obsidian Vault\InkVault'
$oldMemory = Join-Path $env:USERPROFILE 'InkVault\Memory\memory'

if (-not (Test-Path -LiteralPath $profilePatch)) { throw "profile patch not found: $profilePatch" }
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
$backup = Join-Path $backupDir ('cordis.patch.yml.bak-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
Copy-Item -LiteralPath $profilePatch -Destination $backup

$patch = Get-Content -LiteralPath $profilePatch -Raw
if ($patch -notmatch '(?m)^- id: inkvault\s*$') {
  $block = @'

# dsh-inkvault：记忆库放在用户 Obsidian 库内的 InkVault/ 子目录（写入范围仍限制在该子目录）
# 恢复默认（~/InkVault/Memory）时删除本 entry 即可。
- id: inkvault
  config:
    disabled: true
    memoryRoot: '~\Documents\Obsidian Vault\InkVault'
'@
  Add-Content -LiteralPath $profilePatch -Value $block -Encoding utf8NoBOM
}

New-Item -ItemType Directory -Force -Path (Join-Path $vaultRoot 'memory') | Out-Null
$copied = 0
if (Test-Path -LiteralPath $oldMemory) {
  Get-ChildItem -LiteralPath $oldMemory -Filter '*.md' -File | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $vaultRoot 'memory') -Force
    $copied++
  }
}

Write-Output "backup: $backup"
$hasEntry = (Get-Content -LiteralPath $profilePatch -Raw) -match '(?m)^- id: inkvault\s*$'
Write-Output "patch has inkvault entry: $hasEntry"
Write-Output "vault memory dir: $vaultRoot\memory"
Write-Output "notes migrated: $copied"
Get-ChildItem -LiteralPath (Join-Path $vaultRoot 'memory') -Filter '*.md' -File | Select-Object -ExpandProperty Name
