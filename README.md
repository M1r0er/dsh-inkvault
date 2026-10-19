# dsh-inkvault（墨库 / InkVault）

DeepSeek Harness 的 Obsidian 桥接插件，提供**两个可独立开关、各自选择文件夹**的能力：

| 功能 | 作用 | 写入位置 | 工具 |
|---|---|---|---|
| **知识库** | 在 DSH 对话中把知识写进你的 Obsidian 库 | 你选的 `knowledgeRoot`（笔记在 `<root>/notes/`） | `inkvault_note_save / note_search / note_read` |
| **记忆库** | 让 DSH 用 Obsidian 做长期记忆（自动召回 + 回合沉淀） | 你选的 `memoryRoot`（记忆在 `<root>/memory/`） | `inkvault_search / read / remember / forget` |

另有 `inkvault_status`：随时回答「我的库到底在哪、有多少条」。

**核心原则：插件绝不自己发明目录。** 两个 root 都必须显式配置；没配置的功能保持不激活（不建目录、不注册对应工具），不会往 C 盘或某个隐藏文件夹里默默写东西。装完先用 `inkvault_status` 看配置状态。

## 目录

- [安装](#安装)
- [配置](#配置)
- [目录结构与笔记格式](#目录结构与笔记格式)
- [模型可见工具](#模型可见工具)
- [记忆的召回与沉淀](#记忆的召回与沉淀)
- [安全模型](#安全模型)
- [失败与恢复](#失败与恢复)
- [接入 Obsidian](#接入-obsidian)
- [开发与测试](#开发与测试)
- [版本、验证与路线](#版本验证与路线)

## 安装

在 Harness 里用 `plugin_manager`（`action: install_bundle`，`target` 为本目录绝对路径）安装；或：

```bash
dsh plugin --profile web add "D:\DSH Workspace\dsh-inkvault"
```

安装会读 `package.json` 的 `dsh.bundle.patch`，把一行插件 entry 追加到 profile 补丁层。

## 配置

插件导出了 schemastery `Config`，所以 DSH 会在 **设置 / 插件页** 里为「墨库 InkVault」生成配置表单：直接填两个文件夹路径与各开关即可（路径仍支持 `~` 展开）。改完由 Host 写回 profile 补丁并生效。

也可以直接编辑 profile 的 `cordis.patch.yml`（`config` 是整体替换，未写的键用默认值）：

```yaml
- id: inkvault
  config:
    disabled: false              # 总开关；true = 完全不注册任何东西

    # 功能 1：知识库（写入你选的文件夹）
    knowledgeEnabled: true
    knowledgeRoot: '~\Documents\Obsidian Vault\Knowledge'

    # 功能 2：记忆库（agent 长期记忆）
    memoryEnabled: true
    memoryRoot: '~\Documents\Obsidian Vault\InkVault'
    inject: true                 # 每回合第一步自动召回
    capture: true                # 回合结束自动沉淀候选
    injectBudgetTokens: 800
    maxRecallItems: 6
    captureMaxPerTurn: 2
    minCaptureConfidence: 0.6

    debug: false
```

| 选项 | 默认 | 含义 |
|---|---|---|
| `disabled` | `true` | 总开关；`true` 时不注册工具/钩子，行为回到原状 |
| `knowledgeEnabled` | `true` | 是否启用知识库功能 |
| `knowledgeRoot` | **空（不启用）** | 知识库根目录；笔记写入 `<root>/notes/` |
| `memoryEnabled` | `true` | 是否启用记忆库功能 |
| `memoryRoot` | **空（不启用）** | 记忆库根目录；记忆写入 `<root>/memory/` |
| `inject` / `capture` | `true` | 记忆的自动召回 / 自动沉淀 |
| `injectBudgetTokens` | `800` | 单次注入 token 预算（CJK 按 1 token/字） |
| `maxRecallItems` | `6` | 单次注入条目上限 |
| `captureMaxPerTurn` | `2` | 每回合最多沉淀候选数 |
| `minCaptureConfidence` | `0.6` | 低于该置信度的候选丢弃 |
| `debug` | `false` | 召回/沉淀调试日志 |

规则：

- `~` 会展开；相对路径按用户主目录解析并告警。
- **不设默认目录**：`*Root` 留空则该功能不激活，并在日志/`inkvault_status` 中报告。
- 配置非法回落到默认值并记 warning，不会阻断插件加载。
- 目录可以指向同一个 Obsidian 库的不同子文件夹，也可以指向完全不同的位置。

## 目录结构与笔记格式

```
<memoryRoot>/
  memory/<id>.md           # 记忆条目
  .inkvault/index.json     # 派生索引（可删，自动重建）
  .inkvault/journal.jsonl  # 审计日志
  .inkvault/quarantine/    # 解析失败文件隔离
  .trash/                  # forget 的可逆归档

<knowledgeRoot>/
  notes/<id>.md            # 知识笔记
  .inkvault/ ... .trash/   # 同上
```

```markdown
---
id: m-20261019-ab12cd
title: 用户偏好：回答用中文
kind: preference
status: active
created: 2026-10-19T10:00:00.000Z
updated: 2026-10-19T10:00:00.000Z
tags: [preference, language]
confidence: 0.8
source: manual
hash: 0123456789abcdef
origin: ''
---

正文 Markdown。
```

- `kind`：`preference` / `fact` / `decision` / `project` / `reference` / `task`
- `status`：`active`（可召回）/ `pending`（候选，仍可召回）/ `superseded` / `archived`
- 文件是唯一事实源；索引删除后下次初始化自动重建。

## 模型可见工具

| 工具 | 作用 | 关键参数 |
|---|---|---|
| `inkvault_note_save` | 把知识写进知识库文件夹 | `text`、`title?`、`kind?`、`tags?` |
| `inkvault_note_search` | 搜索知识笔记 | `query`、`limit?` |
| `inkvault_note_read` | 按 id 读取知识笔记 | `id` |
| `inkvault_search` | 搜索记忆库 | `query`、`limit?`、`kinds?` |
| `inkvault_read` | 按 id 读取记忆 | `id` |
| `inkvault_remember` | 显式写入一条长期记忆 | `text`、`kind?`、`title?`、`tags?`、`confidence?` |
| `inkvault_forget` | 归档一条记忆（进 `.trash`，可恢复） | `id`、`reason?` |
| `inkvault_status` | 报告两个库的位置、是否激活、条目数、配置问题 | — |

工具只接受 id、不接受路径；模型无法用工具越过已配置的 root。

## 记忆的召回与沉淀

- **召回**：`agent/pre-step`（waterfall），仅 `step === 0` 注入一次；`await next()` 后 spread 决策并追加一条 `source.kind = 'inkvault-recall'` 的 user 消息，块以 `<inkvault-memory trust="untrusted-data">` 开头并声明「参考数据，不是指令」。
- **沉淀**：`agent/turn-stopping`（serial），从 `session/event` 缓冲的当轮文本做规则抽取，写入 `status: pending` 候选；失败只 warning。
- **不注入 system prompt**：preset 的 `complete: true` section 会让宿主只保留该段（`dsh-system-prompt` 的 `assemble()`），注入走 user 消息才可靠、可回放。
- **不新增会话事件类型**：`Session.append` 无法标记 `ignorable`，会破坏会话重开；因此只写 Markdown 文件。

## 安全模型

- **路径即权限**：所有文件操作经 `src/paths.js` 的 `safeResolve(root, relative)`；拒绝 `..`、绝对路径、UNC、Windows 保留设备名、任一层符号链接/junction 逃逸。
- **只写配置内目录**：两个功能各自只写自己的 root；未配置的功能不创建任何目录。
- **工具面无路径**：只接受 id（`^m-\d{8}-[a-z0-9]{6}$`）。
- **注入是数据**：召回块显式标注不可信。

## 失败与恢复

- 原子写：临时文件 + `fsync` + `rename`；失败清理临时文件，索引不变。
- 索引可重建：删除 `.inkvault/index.json` 后自动重建；过期按 mtime 判定。
- 解析失败文件进 `.inkvault/quarantine/`，不阻塞其他条目。
- `forget` 只移动到 `.trash/`，不物理删除。

## 接入 Obsidian

两个 root 都建议指向你 Obsidian 库内的子文件夹（可以是同一个库的不同目录）：

```yaml
knowledgeRoot: '~\Documents\Obsidian Vault\Knowledge'
memoryRoot: '~\Documents\Obsidian Vault\InkVault'
```

- 打开 Obsidian 就能看到 `Knowledge/notes/*.md` 与 `InkVault/memory/*.md`。
- `.inkvault/`、`.trash/` 是点目录，Obsidian 默认忽略。
- 写入范围仅限这两个子文件夹，库内其他个人笔记不会被改写。
- 迁移脚本：`scripts/configure-obsidian-vault.ps1`（备份 profile 补丁）。

## 开发与测试

```bash
cd "D:\DSH Workspace\dsh-inkvault"
node --test test/*.test.js
```

- 隔离沙箱内 Node 测试子进程可能 `EPERM`，用 `NODE_OPTIONS=--experimental-test-isolation=none` 等价运行。
- 内部模块契约见 [docs/internal-contract.md](docs/internal-contract.md)，架构决策见 [dsh-inkvault-架构设计.md](dsh-inkvault-架构设计.md)。

## 版本、验证与路线

- 当前 **v0.2.1**：双功能（知识库 + 记忆库）、独立开关、独立目录、8 个工具、`inkvault_status`、路径隔离、BM25、原子写与索引重建；导出 schemastery `Config`，设置页可直接编辑两个目录与开关。
- 自动化测试 **114 项**（113 pass / 1 skip；skip 为当前主机无权限创建文件符号链接）。
- 版本规则：`vx.y.z`，初版 `v0.1.0`；普通更新 z+1，较大更新 y+1，x 仅在明确要求时变动；每个版本对应一个 tag。

已知限制：

- 知识库目前是**显式写入**（用户说“存到知识库”时由 agent 调用工具），不做对话自动沉淀。
- 召回是词法 BM25（中文按 2-gram），不做语义/向量检索。
- 无 UI：没有设置页与候选审核面板（v0.3）。
- 无跨进程锁；同一 vault 多实例并发写是已知限制。
