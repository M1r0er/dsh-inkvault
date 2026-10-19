# 把 dsh-inkvault 配置成双功能（知识库 + 记忆库），目录放进用户 Obsidian 库
# 知识库：<USERPROFILE>\Documents\Obsidian Vault\Knowledge
# 记忆库：<USERPROFILE>\Documents\Obsidian Vault\InkVault
$ErrorActionPreference = 'Stop'
$profilePatch = Join-Path $env:USERPROFILE '.dsh\profiles\desktop\cordis.patch.yml'
$workspace = 'D:\DSH Workspace\dsh-inkvault'
$backupDir = Join-Path $workspace '.diag'

if (-not (Test-Path -LiteralPath $profilePatch)) { throw "profile patch not found: $profilePatch" }
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
Copy-Item -LiteralPath $profilePatch -Destination (Join-Path $backupDir ('cordis.patch.yml.bak-' + (Get-Date -Format 'yyyyMMdd-HHmmss')))

$patch = Get-Content -LiteralPath $profilePatch -Raw
# 移除上一版脚本追加的 inkvault 段落（从它的注释标记到文件末尾）
$marker = '# dsh-inkvault：'
$index = $patch.IndexOf($marker)
if ($index -ge 0) { $patch = $patch.Substring(0, $index).TrimEnd() + "`n" }

$block = @'

# dsh-inkvault：两个显式目录（知识库 / 记忆库），不在 C 盘另建默认库
- id: inkvault
  config:
    disabled: false
    memoryEnabled: true
    memoryRoot: '~\Documents\Obsidian Vault\InkVault'
    inject: true
    capture: false
    knowledgeEnabled: true
    knowledgeRoot: '~\Documents\Obsidian Vault\Knowledge'
'@
Set-Content -LiteralPath $profilePatch -Value ($patch.TrimEnd() + $block) -Encoding utf8NoBOM

Write-Output "patch: $profilePatch"
Write-Output "has inkvault entry: $([bool]((Get-Content -LiteralPath $profilePatch -Raw) -match '(?m)^- id: inkvault\s*$'))"
