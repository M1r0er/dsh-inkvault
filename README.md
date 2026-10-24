# dsh-inkvault（墨库 / InkVault）

DeepSeek Harness 的 **Obsidian 知识库桥接插件**：让 agent 在对话里把知识写进你自己的 Obsidian 库，也能反过来检索你手写的笔记。

> **v0.5.0 定位变更**：墨库从「记忆库 + 知识库双功能」收缩为**专精知识库插件**。记忆库功能保留但**默认关闭**（`memoryEnabled: false`），因为 agent 的自动记忆已由 [灵枢 `@furongjun1999/dsh-memory`](https://github.com/FuRongJun-1999/dsh-memory) 承担——两套自动注入同时开启会重复占用每轮上下文预算。墨库现在的差异化是：**人可编辑、Obsidian 原生、零自动注入、显式工具调用**。

| 功能 | 默认 | 作用 | 写入位置 | 工具 |
|---|---|---|---|---|
| **知识库** | **开** | 在对话中把知识写进 Obsidian 库，支持双链 / 标签 / 目录 | 你选的 `knowledgeRoot`（笔记在 `<root>/notes/`） | `inkvault_note_save / search / read / list / update / forget` |
| 记忆库 | 关 | 让 DSH 用 Obsidian 做长期记忆（自动召回 + 回合沉淀） | 你选的 `memoryRoot`（记忆在 `<root>/memory/`） | `inkvault_search / read / remember / forget` |

另有 `inkvault_status`：随时回答「我的库到底在哪、有多少条」。

**核心原则：插件绝不自己发明目录。** root 必须显式配置；没配置的功能保持不激活（不建目录、不注册对应工具），不会往 C 盘或某个隐藏文件夹里默默写东西。装完先用 `inkvault_status` 看配置状态。

## 目录

- [安装](#安装)
- [配置](#配置)
- [知识库（默认功能）](#知识库默认功能)
- [目录结构与笔记格式](#目录结构与笔记格式)
- [模型可见工具](#模型可见工具)
- [记忆库（默认关闭）](#记忆库默认关闭)
- [安全模型](#安全模型)
- [失败与恢复](#失败与恢复)
- [接入 Obsidian](#接入-obsidian)
- [开发与测试](#开发与测试)
- [版本、验证与路线](#版本验证与路线)

## 安装

在 Harness 里用 `plugin_manager`（`action: install_bundle`，`target` 为本目录绝对路径）安装；或：

```bash
dsh plugin --profile web add "D:\\DSH Workspace\\dsh-inkvault"
```

安装会读 `package.json` 的 `dsh.bundle.patch`，把一行插件 entry 追加到 profile 补丁层。

## 配置

插件自带客户端页面：打开 **设置 → 墨库 InkVault**。v0.5.0 起该页面**只展示知识库分组**——知识库文件夹（可直接输入，支持 `~`，或点 **浏览…** 调宿主原生文件夹选择器）、能力提示开关、索引状态。点保存后由 Host 写回 profile 补丁并立即生效。

记忆库配置仍可用，但需要直接编辑 profile 的 `cordis.patch.yml`（`config` 是整体替换，未写的键用默认值）：

```yaml
- id: inkvault
  config:
    disabled: false              # 总开关；true = 完全不注册任何东西

    # 默认功能：知识库
    knowledgeEnabled: true
    knowledgeRoot: 'D:\\Obsidian库\\墨库 InkVault-知识库'
    knowledgeHint: true          # 注入 ≤200 字符的能力提示，让 agent 知道有这个库

    # 可选：记忆库（v0.5.0 默认关闭；开启前请确认没有另一套自动记忆在跑）
    memoryEnabled: false
    memoryRoot: 'D:\\Obsidian库\\墨库 InkVault-记忆库'
    inject: true                 # 每回合第一步自动召回
    capture: false               # 回合结束自动沉淀候选
    injectBudgetTokens: 800
    maxRecallItems: 6
    captureMaxPerTurn: 2
    minCaptureConfidence: 0.6
    directives: true             # 指令层：每轮注入 delivery:prompt 且 active 的条目
    maxDirectiveChars: 4000
    directiveTriggers: []        # 强声明短语；空 = 用内置 13 条默认值

    debug: false
```

| 选项 | 默认 | 含义 |
|---|---|---|
| `disabled` | `true` | 总开关；`true` 时不注册工具/钩子 |
| `knowledgeEnabled` | `true` | 是否启用知识库功能 |
| `knowledgeRoot` | **空（不启用）** | 知识库根目录；笔记写入 `<root>/notes/` |
| `knowledgeHint` | `true` | 每轮注入一段 ≤200 字符的能力提示（v0.5.0 新增） |
| `memoryEnabled` | **`false`**（v0.5.0 起） | 是否启用记忆库功能 |
| `memoryRoot` | **空（不启用）** | 记忆库根目录；记忆写入 `<root>/memory/` |
| `inject` / `capture` | `true` / `true` | 记忆的自动召回 / 自动沉淀 |
| `injectBudgetTokens` | `800` | 单次注入 token 预算（CJK 按 1 token/字） |
| `maxRecallItems` | `6` | 单次注入条目上限 |
| `captureMaxPerTurn` | `2` | 每回合最多沉淀候选数 |
| `minCaptureConfidence` | `0.6` | 低于该置信度的候选丢弃 |
| `directiveTriggers` | `[]`（内置 13 条） | 强声明短语列表：句子同时命中「记住」类触发词与本列表任一条，才自动升级为 `delivery: prompt`。**空数组 = 关闭自动升级** |
| `directives` | `true` | 指令层开关：每轮把 `delivery: prompt` 且 `status: active` 的条目注入系统提示词 |
| `maxDirectiveChars` | `4000` | 指令层文本字符上限；超出则整块跳过并告警，**不截断** |
| `debug` | `false` | 召回/沉淀调试日志 |

规则：

- `~` 会展开；相对路径按用户主目录解析并告警。
- **不设默认目录**：`*Root` 留空则该功能不激活，并在日志/`inkvault_status` 中报告。
- 配置非法回落到默认值并记 warning，不会阻断插件加载。
- 目录可以指向同一个 Obsidian 库的不同子文件夹，也可以指向完全不同的位置。

## 知识库（默认功能）

墨库 0.5.0 的核心。与「自动记忆」的根本区别：**不自动注入、不自动沉淀**，只在你或 agent 显式调用工具时读写。

- **双链**：正文写 `[[另一篇笔记标题]]` 或 `[[m-20261024-a1b2c3]]`，索引会解析出**反链**——读一篇笔记时能看到「谁引用了我」。
- **标签**：frontmatter `tags` 与正文内联 `#tag` 会归并去重；`inkvault_note_search` 支持 `tags` **AND** 过滤（全部命中才返回）。
- **目录**：`inkvault_note_save` 支持 `folder`，笔记落到 `<root>/notes/<folder>/`，形成你 Obsidian 里熟悉的层级；`inkvault_note_list` 可按 `folder` 枚举。
- **收编（adopt）**：你**手工**丢进 `notes/` 的 `.md` 文件（没有 `id` 或不合法）不会被当成坏文件隔离，而是被**原地收编**——补上 `id` 并保持内容不变，id 在多次重建之间**确定且稳定**（同一文件名永远得到同一 id）。日常笔记文件名如 `2026-10-24.md` 会保留日期。
- **标题加权**：检索时标题权重是正文的 3 倍，标题命中优先。
- **增量重建**：索引只重读 mtime 变化的文件；没改动的 vault 重建不写 journal。

## 目录结构与笔记格式

```
<knowledgeRoot>/
  notes/<id>.md            # 知识笔记（可有子目录）
  .inkvault/index.json     # 派生索引（可删，自动重建）
  .inkvault/journal.jsonl  # 审计日志
  .inkvault/quarantine/    # 解析失败文件隔离（仅记忆库 profile 使用）
  .trash/                  # forget 的可逆归档

<memoryRoot>/
  memory/<id>.md           # 记忆条目（仅在 memoryEnabled 时存在）
  .inkvault/ ... .trash/   # 同上
```

知识笔记的 frontmatter（v0.5.0 **字段减噪**：不再写 `status` / `confidence` / `origin` / `delivery` 这些对知识无意义的空字段）：

```markdown
---
id: m-20261024-a1b2c3
title: DSH 插件上架社区市场索引流程
kind: reference
tags: [dsh-plugin, publish]
folder: dsh-plugin
created: 2026-10-24T10:00:00.000Z
updated: 2026-10-24T10:00:00.000Z
hash: 0123456789abcdef
---
正文 Markdown，可以写 [[双链]] 和 #标签。
```

- `kind`：`preference` / `fact` / `decision` / `project` / `reference` / `task`
- 文件是唯一事实源；索引删除后下次初始化自动重建。
- **id 格式 0.5.0 保持不变**（`m-YYYYMMDD-xxxxxx`），计划在 0.6.0 再改，避免破坏已有库。

## 模型可见工具

默认（仅知识库）**7 个工具、schema 合计 2016 字符**：

| 工具 | 作用 | 关键参数 |
|---|---|---|
| `inkvault_note_save` | 把知识写进知识库文件夹 | `text`、`title?`、`kind?`、`tags?`、`folder?` |
| `inkvault_note_search` | 搜索知识笔记（标题加权 + tags AND） | `query`、`limit?`、`kinds?`、`tags?` |
| `inkvault_note_read` | 按 id 读取知识笔记（含反链） | `id` |
| `inkvault_note_list` | 枚举笔记（按 folder / tags / 最近） | `folder?`、`tags?`、`recent?`、`limit?` |
| `inkvault_note_update` | 更新标题 / 正文 / 标签 | `id`、`title?`、`text?`、`tags?` |
| `inkvault_note_forget` | 归档一条笔记（进 `.trash`，可恢复） | `id`、`reason?` |
| `inkvault_status` | 报告库位置、是否激活、条目数、配置问题 | — |

开启记忆库后额外注册 4 个（`inkvault_search / read / remember / forget`），总计 11 个 / 3743 字符。

工具只接受 id、不接受路径；模型无法用工具越过已配置的 root。

## 记忆库（默认关闭）

保留但默认不启用。若你**没有**安装其他自动记忆插件，可以开启：

```yaml
memoryEnabled: true
memoryRoot: 'D:\\Obsidian库\\墨库 InkVault-记忆库'
```

记忆库分两类，走两条**完全不同的投递通道**：

| | 纯记忆（`delivery: recall`） | 指令（`delivery: prompt`） |
|---|---|---|
| 触发 | 默认 | 显式声明才进入 |
| 注入点 | `agent/pre-step`（step 0）追加一条 user 消息 | `system-prompt/assemble` 推 `assembly.contexts` |
| 频率 | 每回合 1 次，BM25 命中才有 | **每轮请求都在** |
| 信任标注 | `<inkvault-memory trust="untrusted-data">` | `<inkvault-directive trust="user-declared">` |
| 语义 | 参考数据，不是指令 | 用户声明的长期约定 |

- **召回**：`agent/pre-step`（waterfall），仅 `step === 0` 注入一次；`await next()` 后 spread 决策并追加一条 `source.kind = 'inkvault-recall'` 的 user 消息。
- **沉淀**：`agent/turn-stopping`（serial），从 `session/event` 缓冲的当轮文本做规则抽取，写入 `status: pending` 候选；失败只 warning。
- **指令层**：命中**强声明**触发词（「记住，以后都…」「from now on」等）自动升级——必须**同时**命中普通声明词与强声明词才算。注入 `system-prompt/assemble`，每步都 push。
- **三道闸门**：`directives: false` 关闭；只接受 `status: active`；总字符超 `maxDirectiveChars` **整块跳过并告警，不截断**——截断的指令比没有指令更危险。
- **花括号转义**：正文里的 `{{` 会被打断成 `{ {`，避免宿主的 `{{variable}}` 插值把整轮请求打挂。

> **与灵枢共存**：灵枢 `@furongjun1999/dsh-memory` 默认已开启自动召回 + 上下文窗口 + 逢十轮提醒。两套同时自动注入会重复占用上下文预算。建议**灵枢做记忆、墨库做知识**：保持 `memoryEnabled: false`。

## 安全模型

- **路径即权限**：所有文件操作经 `src/paths.js` 的 `safeResolve(root, relative)`；拒绝 `..`、绝对路径、UNC、Windows 保留设备名、任一层符号链接/junction 逃逸。
- **只写配置内目录**：两个功能各自只写自己的 root；未配置的功能不创建任何目录。
- **工具面无路径**：只接受 id（`^m-\d{8}-[a-z0-9]{6}$`）。
- **注入是数据**：召回块显式标注 `trust="untrusted-data"`，指令块标注 `trust="user-declared"`。
- **失败不外溢**：`system-prompt/assemble` 监听器内部异常只 warn，始终 `return next()`——绝不让知识库故障拖垮整轮请求。

## 失败与恢复

- 原子写：临时文件 + `fsync` + `rename`；失败清理临时文件，索引不变。
- 索引可重建：删除 `.inkvault/index.json` 后自动重建；过期按 mtime 判定，且**只重读变化的文件**。
- 记忆库 profile 解析失败文件进 `.inkvault/quarantine/`；**知识库 profile 改为收编**，不隔离用户手写笔记。
- `forget` 只移动到 `.trash/`，不物理删除。

## 接入 Obsidian

root 建议指向你 Obsidian 库内的子文件夹：

```yaml
knowledgeRoot: 'D:\\Obsidian库\\墨库 InkVault-知识库'
```

- 打开 Obsidian 就能看到 `notes/*.md`，双链、标签、目录都是 Obsidian 原生能力。
- `.inkvault/`、`.trash/` 是点目录，Obsidian 默认忽略。
- 写入范围仅限配置的子文件夹，库内其他个人笔记不会被改写；你手写的笔记可被检索、不会被搬走。

## 开发与测试

```bash
cd "D:\\DSH Workspace\\dsh-inkvault"
node --test test/*.test.js
```

- 隔离沙箱内 Node 测试子进程可能 `EPERM`（`spawn EPERM`），此时逐文件运行：`node test/store.test.js`。
- 内部模块契约见 [docs/internal-contract.md](docs/internal-contract.md)，架构决策见 [dsh-inkvault-架构设计.md](dsh-inkvault-架构设计.md)，改造计划见 [docs/inkvault-transformation-plan.md](docs/inkvault-transformation-plan.md)。

## 版本、验证与路线

- 当前 **v0.5.0**：**收缩为专精知识库插件**。`memoryEnabled` 默认改 `false`；知识工具面 3→7（新增 `note_list / note_update / note_forget`，`note_search` 补 `kinds` + `tags`，`note_save` 补 `folder`）；知识建模支持 `[[双链]]` + 反链、`#tag` 归并、`notes/<folder>/` 落盘、frontmatter 字段减噪；检索增强标题加权（3×）、tags AND、索引增量重建；设置页只留知识库；新增 `knowledgeHint` 能力提示注入。
- 自动化测试 **155 项**（154 pass / 1 skip；skip 为当前主机无权限创建文件符号链接）。其中 `test/knowledge.test.js` 13 项覆盖收编、增量刷新、标题加权、空查询枚举、反链、子目录。
- 版本规则：`vx.y.z`，初版 `v0.1.0`；普通更新 z+1，较大更新 y+1，x 仅在明确要求时变动；每个版本对应一个 tag。

已知限制：

- 知识库是**显式写入**（用户说"存到知识库"时由 agent 调用工具），不做对话自动沉淀——这是刻意的，避免与记忆插件抢注入通道。
- 检索是词法 BM25（中文按 2-gram）+ 标题加权，不做语义/向量检索。
- 无跨进程锁；同一 vault 多实例并发写是已知限制。
- id 格式仍是 `m-YYYYMMDD-xxxxxx`（记忆时代遗留），0.6.0 计划改为知识笔记专用格式。
