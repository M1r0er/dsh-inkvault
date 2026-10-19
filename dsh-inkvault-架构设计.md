# dsh-inkvault · 架构设计

| 项 | 内容 |
|---|---|
| 文档版本 | v0.5 |
| 项目版本 | **v0.3.0** |
| 项目名 | **dsh-inkvault**（显示名：墨库 / InkVault） |
| 状态 | 双功能已实现、测试通过并安装验证 |
| 范围 | DeepSeek Harness（DSH）的 Obsidian 桥接插件 |
| 目标环境 | DSH `0.2.1-rc.2` · Node ≥ 20 · Windows 为主 |
| 最后更新 | 2026-10-19 |
| 前置决策 | 自研；名称已定；**不接灵枢、不以灵枢为前提** |

---

## 0. 一句话与边界

**一句话**：把 Obsidian 库拆成两个由用户显式选择的目录，分别承担 **DSH 的知识出口**（对话中产出的知识写进个人库）与 **DSH 的记忆入口**（长期记忆在 Obsidian 中沉淀与召回）。

**v0.2.0 的边界**：一个包、一行 patch、两个功能（知识库 / 记忆库）、两个可独立开关并各自选目录的 root、8 个工具；先跑通「知识写入」与「记忆召回 → 沉淀 → 再召回」两个闭环，UI 与向量化留到后续版本。

> v0.3 修订（相对 v0.2）：修正产品定位——知识库不是「只读/non-goal」，而是与记忆库并列的一等功能；两个 root 必须由用户显式配置，插件**不设默认目录**；新增 `inkvault_status` 解决「库在哪」的可发现性。

---

## 1. 目标与架构总览

### 1.1 关键事实（决定架构）

**F1. 注入必须走 `agent/pre-step` 的用户消息，不能塞进 system prompt。**
`system-prompt/assemble` 后，只要某个 section 声明 `complete: true`，宿主会把 `sections` 收敛为**仅该 section**（`dsh-system-prompt` 的 `assemble()`：`sections: completeSection === undefined ? transformed.sections : [completeSection]`），其他插件的提示段被静默丢弃。走 pre-step 还额外获得：注入成为可回放的会话事件、对 compaction 可见。

**F2. 插件落地形态 = 一个包 + 一行 patch。**
`package.json` 声明 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`；`plugin_manager install_bundle` 或 `dsh plugin add` 安装并追加补丁层；profile 补丁层可用同 id 条目整体替换 `config`。

**F3. 参考实现。**
[dsh-longterm-memory](https://github.com/bufan528/dsh-longterm-memory)（4 工具、BM25、收件箱、journal）与 [dsh-obsidian](https://github.com/mingzeng21/dsh-obsidian)（vault 工具、路径穿越防护、Windows 加固）证明该形态可落地；我们做的是「知识写入 + 记忆 + 显式目录」的合并。

**F4. 钩子与会话边界（已核对源码）。**
- 召回：`agent/pre-step`，waterfall，`{agent, messages, turn, step, signal}`；`step === 0` 即每回合第一步。
- 沉淀：`agent/turn-stopping`，serial，`{agent, turn, signal}`。
- `turn/end` / `turn/start` 是**会话事件类型**，不是 Cordis 事件；监听 `session/event` 判断 `event.type`。
- `ctx.tools.register(definition)` 接收原始 ToolDefinition；schema 只支持 `type/oneOf/properties/required/additionalProperties/items/enum/const` + 注解，`required` 是对象节点上的数组。

**F5. 不能新增会话事件类型。**
`Session.append()` 无法写 `ignorable: true`；新增未知类型会让会话无法重新打开。插件因此不追加任何自定义会话事件：知识/记忆只写 Markdown 文件，索引是派生数据。

**F6. profile 链接包不能裸导 `@deepseek-ai/*`，所以插件只依赖 schemastery。**
本地目录安装会把包 link 进 profile，真实路径在工作区；工作区没有 node_modules。v0.2.1 起把 `@deepseek-ai/schemastery` 作为**唯一运行时依赖**装进工作区（`pnpm install`），导出 `Config` 供 Host 投影为设置表单；其余工具定义仍直接构造，不使用 `defineTool`。注意：链接安装需要工作区先 `pnpm install`，发布安装则由 pnpm 正常解析依赖。

**F7. 注入必须显式标注为不可信数据。**
召回块以 `<inkvault-memory trust="untrusted-data">` 开头，并带 `source.kind = 'inkvault-recall'` 标记（防自召回 / 自捕获）。

**F8. 目录是用户的决定，不是插件的默认值。**
不设默认 root：`memoryRoot` / `knowledgeRoot` 留空时对应功能不激活，不创建目录、不注册工具；`inkvault_status` 报告实际路径、条目数与配置问题。理由：默认落到 C 盘或插件自建目录会造成磁盘拥挤、库位置不可发现。

**F9. 两个 root 互不重叠。**
每个 root 有自己的 `.inkvault/`、`.trash/` 与内容子目录（memory → `memory/`，knowledge → `notes/`），互相不读写；同一 Obsidian 库内也可以是两个不同子目录。

### 1.2 目标

| # | 目标 |
|---|---|
| G1 | **知识库**：在 DSH 对话中把知识写进用户 Obsidian 库，目录用户自选 |
| G2 | **记忆库**：把 Obsidian 用做 agent 长期记忆（自动召回 + 回合沉淀），目录用户自选 |
| G3 | **功能独立**：两个功能可分别开关；关闭的功能不注册工具、不写文件 |
| G4 | **纯 Markdown**：知识/记忆都是带 frontmatter 的 `.md`，Obsidian 能开、能编辑、能 git 版本化 |
| G5 | **目录可发现**：`inkvault_status` + 启动日志能回答「库在哪」 |
| G6 | **本地优先**：零服务端、零遥测、默认零模型调用 |

### 1.3 非目标（v0.2.0 明确不做）

| # | 不做 | 原因 |
|---|---|---|
| N1 | 向量 / embedding 检索 | 先词法 BM25，够用且可解释 |
| N2 | 图形管理面板 / 设置页 | v0.3 做 UI |
| N3 | 自动摘要、反思、知识图谱 | 先规则抽取 + 冲突保留 |
| N4 | MCP 服务端 / OpenViking / Hindsight 后端 | 本地优先，不引入外部依赖 |
| N5 | **自动**把整轮对话沉淀为知识笔记 | v0.2 知识写入是显式工具调用；自动沉淀先放记忆侧 |
| N6 | 发布 Obsidian 社区插件 | 只做 DSH 侧 |
| N7 | 候选审核面板 | 设置页与目录选择已在 v0.3.0 交付；审核面板留 v0.3.1 |
| N8 | 接管用户已有个人笔记 | 只写配置的两个 root；不扫描、不改写其他目录 |

### 1.4 成功判据

| # | 判据 | 怎么验 |
|---|---|---|
| S1 | 安装可见 | 插件激活后 8 个 `inkvault_*` 工具出现在模型工具表 |
| S2 | 知识写入 | 让 agent 存一段知识 → 指定文件夹出现 `.md`，Obsidian 可见 |
| S3 | 记忆沉淀 | 说一句偏好 → 回合结束 → 记忆目录出现 `status: pending` 的 `.md` |
| S4 | 记忆召回 | 新会话问相关问题 → pre-step 注入块含该记忆且 ≤ 预算 |
| S5 | 功能独立 | `memoryEnabled` / `knowledgeEnabled` 分别关闭时，只保留对方工具与行为 |
| S6 | 目录显式 | 未配置 root 时不创建任何目录、只剩 status 工具；status 报告 unset |
| S7 | 隔离生效 | `..`、绝对路径、UNC、符号链接/junction 逃逸全部拒绝，有测试 |
| S8 | 可关闭 | `disabled: true` 时工具为 0、钩子不注册，行为回到原状 |
| S9 | 可恢复 | 删 `.inkvault/index.json` 后自动重建；`forget` 可从 `.trash` 恢复 |

### 1.5 架构总览

```
┌─ DSH host（Node 进程）────────────────────────────────────────┐
│  dsh-inkvault（单个 Cordis row）                               │
│   ├─ config        ← profile/cordis.patch.yml（两个 root + 开关）│
│   ├─ knowledge     store(root=knowledgeRoot, contentDir=notes) │
│   │     └─ tools   note_save / note_search / note_read         │
│   ├─ memory        store(root=memoryRoot, contentDir=memory)   │
│   │     ├─ recall  agent/pre-step → 预算内注入(user 消息)       │
│   │     ├─ capture agent/turn-stopping → 规则抽取 → pending     │
│   │     └─ tools   search / read / remember / forget           │
│   └─ status        inkvault_status（两个库的位置与条目数）      │
└───────────────────────────────────────────────────────────────┘
                    │ 文件系统（只写配置的两个 root）
      <knowledgeRoot>/notes/          <memoryRoot>/memory/
              ↑ Obsidian 库内子目录（用户自选）
```

**分层原则**：v0.2 只做 host 侧（无 client bundle）；先跑通两个闭环，再做 UI。

### 1.6 命名与包

- npm 包名：`dsh-inkvault`；显示名：**墨库 / InkVault**
- 仓库：`dsh-inkvault`，private；零运行时依赖
- `engines.dsh`：`>=0.2.1-rc.2 <0.2.2`

### 1.7 设计原则

1. **目录即权限，也是用户的决定**：不设默认目录；只写配置内 root。
2. **知识库与记忆库是一等并列功能**，不是主次关系。
3. **Markdown 是唯一事实源**：索引是派生数据，删了能重建。
4. **注入是数据，不是指令**：召回块显式标注不可信。
5. **默认关、可一键禁用**：`disabled: true` 回到原状。
6. **先闭环，再智能**：规则化、可解释优先。

---

## 2. 数据模型

### 2.1 条目结构（两种功能共用）

每条知识/记忆都是一个 `.md` 文件：frontmatter 承载元数据，正文承载内容。

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | `^m-\d{8}-[a-z0-9]{6}$` |
| `title` | string | 单行标题，缺省取正文首行，≤120 字符 |
| `kind` | enum | `preference` / `fact` / `decision` / `project` / `reference` / `task` |
| `status` | enum | `active` / `pending` / `superseded` / `archived` |
| `created` / `updated` | ISO8601 | 时间戳 |
| `tags` | string[] | 去重、≤12 个 |
| `confidence` | 0..1 | 抽取置信度（知识显式写入为 1） |
| `source` | enum | `capture` / `manual` / `import` |
| `hash` | hex16 | 正文 `sha256` 前 16 位，用于去重 |
| `origin` | string | 来源会话 id；无则空串 |

### 2.2 两种条目的差异

| 维度 | 记忆条目（memoryRoot） | 知识笔记（knowledgeRoot） |
|---|---|---|
| 目录 | `<root>/memory/` | `<root>/notes/` |
| 主要来源 | 自动捕获（规则）+ 显式工具 | 显式工具（对话中用户要求保存） |
| 生命周期 | `pending → active → superseded/archived` | 主要是 `active`，可直接编辑 |
| 召回 | 自动注入 pre-step | 不自动注入，按需 `note_search/read` |

### 2.3 索引与派生数据

- `.inkvault/index.json`：`{version, builtAt, entries[], search}`；索引可整删，缺失/损坏/过期时全量重建。
- `.inkvault/journal.jsonl`：write / archive / rebuild / quarantine 的追加审计日志；写失败只警告。

---

## 3. 目录布局与隔离

### 3.1 布局

```
<memoryRoot>/
  memory/<id>.md
  .inkvault/{index.json, journal.jsonl, quarantine/}
  .trash/

<knowledgeRoot>/
  notes/<id>.md
  .inkvault/{...}
  .trash/
```

### 3.2 隔离规则

- 每个 store 只在自己的 root 内操作，互不交叉。
- 所有路径先经 `safeResolve(root, relative)`：拒绝 `..`、绝对路径（含盘符）、UNC、Windows 保留设备名、任一层符号链接/junction 指向 root 外。
- 工具层不接受路径，只接受 id（固定正则校验），路径穿越面收敛到 store 内部一层。
- 未配置的 root 不创建；`disabled` 时不注册任何工具与钩子。

### 3.3 目录选择

- `memoryRoot` / `knowledgeRoot` 由用户在 profile 补丁里显式指定；`~` 展开，相对路径按 home 解析并告警。
- 推荐指向同一 Obsidian 库的两个子目录（如 `Obsidian Vault/InkVault` 与 `Obsidian Vault/Knowledge`）。
- 目录不存在时，只有在该功能确实被使用（首次初始化）时才 `mkdir`。

---

## 4. 知识写入（knowledge 功能）

1. 用户说“把这段存到知识库/记成笔记/整理到 Obsidian”，模型调用 `inkvault_note_save({text, title?, kind?, tags?})`。
2. 插件生成 id、frontmatter，原子写入 `<knowledgeRoot>/notes/<id>.md`，更新索引与 journal。
3. 返回 `{id, title, status, path}`；用户可在 Obsidian 中直接继续编辑。
4. `inkvault_note_search` / `note_read` 用于检索与回读；不进入自动注入，避免知识笔记污染记忆上下文。
5. 知识写入只发生在 `knowledgeEnabled && knowledgeRoot` 配置有效时；否则不注册对应工具。

v0.2 不做「自动把整轮对话沉淀为知识」：知识是显式意图，误存代价高；自动沉淀先放在记忆侧的候选机制。

---

## 5. 记忆召回与捕获（memory 功能）

### 5.1 召回（`agent/pre-step`）

1. 仅 `step === 0`、本回合未注入过、`memoryOn && inject` 时执行。
2. 查询文本 = 本步 user 消息拼接，跳过 `source.kind === 'inkvault-recall'` 的消息。
3. BM25 检索 top `maxRecallItems * 2`，按 `injectBudgetTokens` 与 `maxRecallItems` 裁剪。
4. 注入块 `<inkvault-memory trust="untrusted-data">…</inkvault-memory>`，作为 user 消息追加（spread 原决策）。
5. 异常只 warning，绝不阻断回合。

token 估算：CJK 1 token/字，其余 4 字符/token，向上取整（保守、零模型调用）。

### 5.2 捕获（`agent/turn-stopping`）

1. `session/event` 缓冲当轮 user/assistant 文本；`turn/end` 清理。
2. 回合收尾时做规则抽取，按置信度降序、正文 hash 去重、截断到 `captureMaxPerTurn`。
3. 写入 `status: pending` 记忆条目；失败只 warning。

规则（中英双语，可解释）：

| rule | 触发要点 | kind | confidence |
|---|---|---|---|
| `explicit` | 记住/记一下/remember/note that | 含偏好词→preference，否则 fact | 0.95 |
| `preference` | 我喜欢/偏好/习惯/别用/I prefer/I never | preference | 0.8 |
| `decision` | 决定/采用/就用/we decided/let's go with | decision | 0.75 |
| `personal-fact` | 我叫/我的…是/我在…工作/my name is | fact | 0.7 |
| `project-convention` | 这个项目/仓库约定/in this project | project | 0.6 |

### 5.3 去重与冲突

- 正文 hash 已存在则跳过；同回合同句只保留最高置信度候选。
- 冲突不自动合并/覆盖，保留双方由用户复核。

---

## 6. 模型可见工具面

| 功能 | 工具 | 参数 | 返回 |
|---|---|---|---|
| 知识 | `inkvault_note_save` | `text`、`title?`、`kind?`、`tags?` | `{id,title,status,path}` |
| 知识 | `inkvault_note_search` | `query`、`limit?` | `{results:[…]}` |
| 知识 | `inkvault_note_read` | `id` | `{id,title,kind,status,updated,tags,path,body}` |
| 记忆 | `inkvault_search` | `query`、`limit?`、`kinds?` | `{results:[…]}` |
| 记忆 | `inkvault_read` | `id` | 同上 |
| 记忆 | `inkvault_remember` | `text`、`kind?`、`title?`、`tags?`、`confidence?` | `{id,title,status,path}` |
| 记忆 | `inkvault_forget` | `id`、`reason?` | `{id,archived,trashPath}` |
| 通用 | `inkvault_status` | — | 两个库的 `{enabled,configured,root,contentDir,indexFile,notes,error?}` + `configIssues` |

- 工具名统一 `inkvault_` 前缀；按功能开关注册。
- 返回有界：搜索只给摘要 + id；全文走 read。
- 描述聚焦行为与约束；参数规则写在参数描述里。

---

## 7. DSH 兼容边界

| 项 | 事实 | 影响 |
|---|---|---|
| 插件形态 | 命名导出 `name` / `inject` / `apply`（无 default export） | default export 会让 Loader 折叠模块并丢 `inject` |
| 依赖解析 | profile 链接包按工作区真实路径解析；v0.2.1 起工作区安装 `@deepseek-ai/schemastery` | 唯一运行时依赖是 schemastery；导出 `Config`；不用 `defineTool` |
| 配置 | 无 `Config` 导出时 loader 原样传 config | `src/config.js` 自校验；profile 补丁 config 整体替换 |
| 工具 schema | 支持子集（F4） | 只用受支持关键字 |
| 事件 | F1/F4/F5 | 召回 pre-step、沉淀 turn-stopping、不新增会话事件 |
| 生命周期 | `ctx.effect`/`ctx.on` 注册，卸载自动清理 | 工具与监听器随插件卸载 |

---

## 8. 失败与恢复

- **原子写**：同目录临时文件 → `fsync` → `rename`；失败清理临时文件，索引不变。
- **索引重建**：缺失/损坏/过期即重建；`rebuildIndex()` 可手动触发。
- **隔离区**：frontmatter 无法解析的文件进 `.inkvault/quarantine/`。
- **journal**：审计与诊断；事实源是文件，journal 丢失不丢数据。
- **可逆删除**：`forget` 只移动到 `.trash/`。
- **失败隔离**：召回/捕获/工具异常不破坏回合；初始化失败可重试。
- **并发**：v0.2 无跨进程锁，同一 vault 多实例并发写是已知限制。

---

## 9. Obsidian 互操作

- 两个 root 都是普通 Markdown 目录，Obsidian 直接打开可见；`.inkvault/`、`.trash/` 为点目录，默认忽略。
- wikilink 原样保留，不解析、不改写。
- 外部编辑：索引按 mtime 过期重建；v0.2 不做文件监听。
- 只写两个 root 内文件，库内其他个人笔记不受影响。

---

## 10. 版本规则与分期路线

**版本规则（项目约定）**：`vx.y.z`；初版 `v0.1.0`；普通更新（README 说明除外）z+1；较大版本更新 y+1；x 仅在专门提醒时变动；每个版本在 GitHub 对应一个 tag。

| 版本 | 范围 | 状态 |
|---|---|---|
| v0.1.0 | 单功能：记忆库（召回/沉淀/4 工具/路径隔离/BM25） | 已完成 |
| **v0.2.0** | 双功能：知识库 + 记忆库；独立开关与目录；`inkvault_status`；8 工具；无默认目录 | 当前 |
| v0.2.1 | 导出 schemastery `Config`（Host 侧可编辑 schema） | 已完成 |
| **v0.3.0** | 客户端设置页：`settings.section` 注册「墨库 InkVault」，两个文件夹输入 + 原生「浏览…」目录选择 + 保存 | 当前 |
| v0.2.2 | 已知问题修复；知识笔记的 wikilink/标签增强 | 计划 |
| v0.3.1 | 候选审核面板；对话内「存到知识库」交互 | 计划 |
| v0.4.0 | 语义检索（可选本地 embedding）；冲突合并建议 | 计划 |

---

## 11. 待确认问题

| # | 问题 | 结论/建议 |
|---|---|---|
| Q1 | 知识库是否是一等功能？ | **是**（v0.2 修正）；与记忆库并列 |
| Q2 | 是否设默认目录？ | **否**；未配置的功能不激活，避免 C 盘堆积与「不知道库在哪」 |
| Q3 | 两个 root 能否是同一目录？ | 不建议；默认保持目录分离（`memory/` 与 `notes/`），避免两种数据混写 |
| Q4 | 知识写入是否自动？ | v0.2 显式工具；自动沉淀留到记忆侧候选机制之后评估 |
| Q5 | 是否需要目录选择 UI？ | v0.2.1 设置表单（文本路径）已可用；**原生目录选择器** v0.3 做（客户端 slot + `directoryPicker`） |

---

## 12. 决策记录

| # | 决策 | 依据 |
|---|---|---|
| D1 | 自研，而非复用 `dsh-longterm-memory` | 用户要自己拥有、长期维护 |
| D2 | 名称 `dsh-inkvault`（墨库） | 避开 Obsidian 商标词与现有插件重名 |
| D3 | 不接灵枢、不以灵枢为前提 | 用户明确不是需求 |
| D4 | 注入走 pre-step 用户消息 | F1 |
| D5 | v0.1 只做 host 侧、四个工具、两个钩子 | 先闭环 |
| D6 | 纯 Markdown + 可重建索引 | 原则 3 |
| D7 | 沉淀钩子用 `agent/turn-stopping` | F4 |
| D8 | 不追加自定义会话事件 | F5 |
| D9 | 插件零依赖、不导出 schemastery `Config` | F6 |
| D10 | 收件箱用 `status: pending` 表达 | 状态一处存储 |
| D11 | 工具只接受 id、不接受路径 | 收敛穿越面 |
| D12 | 召回注入标注 `untrusted-data` 并带 source marker | F7 |
| D13 | 默认 `disabled: true` | 安装副作用最小 |
| D14 | **知识库升级为一等功能**（v0.2 修正 v0.1 的 N5/Q2） | 产品初衷 |
| D15 | **两个 root 必须显式配置，不设默认目录** | F8；C 盘堆积/位置不可发现 |
| D16 | 两个功能独立开关、独立注册工具 | G3 |
| D17 | 增加 `inkvault_status` 作为可发现性入口 | G5 |
| D18 | 知识写入显式、记忆沉淀自动 | 误存知识代价高 |
| D19 | 导出 schemastery `Config`，让设置页承担目录配置 | 用户需要可视化选择两个库目录，而不是手改 profile 补丁 |
| D20 | 自带 client 端，往 `settings.section` 注册「墨库」页面，并用 `remote.directoryPicker` 做原生文件夹选择 | DSH 不会为第三方插件自动生成设置页，必须注册；原生 picker 在 Windows/loopback 下可用 |

---

## 13. 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v0.1-draft | 2026-10-19 | 建立文档，落地 §1，§2–§9 待设计 |
| v0.2 | 2026-10-19 | 核对并修正 F1/F4；新增 F5/F6/F7；补齐 §2–§9 |
| v0.3 | 2026-10-19 | 修正产品定位：知识库一等功能；新增 F8/F9；两个 root 显式配置；补 §4 知识写入、§10 版本规则、D14–D18 |
| v0.4 | 2026-10-19 | 导出 schemastery `Config`（设置表单可改两个目录）；F6/N7/§7/Q5 同步；D19 |
| v0.5 | 2026-10-19 | v0.3.0 客户端设置页（settings.section + 原生目录选择）；N7/§10/D20 同步 |
