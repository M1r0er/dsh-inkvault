# 墨库 InkVault 改造计划 v1.0

> 目标版本：`dsh-inkvault` 0.4.0 → 0.5.0
> 定位结论：**收缩为「Obsidian 知识库桥」，记忆面保留为默认关闭的降级模式**
> 配套文档：灵枢改造计划 v1.0（节点 `mem_1792817070009_f833ce`），其 P0 已假定墨库 `memoryEnabled: false`

---

## 0. 先回答「是否需要变成专精知识库」

**是，但要把两件事分开看，否则会做出一个更没用的插件。**

| 动作 | 收益 | 风险 | 判断 |
|---|---|---|---|
| 关掉记忆面（P0） | 立刻省 ~870 tok/轮 + 5 个钩子全短路 | 极低，可逆 | **必须做** |
| 把知识面做深（P3） | 让墨库有灵枢给不了的价值 | 中等，需开发 | **不做就等于建议卸载** |

关键事实：**知识库从 0.4.0 发布至今 5 天，写入 0 条**（`D:\Obsidian库\墨库 InkVault-知识库\.inkvault\index.json` → `entries: 0`, `builtAt: 2026-10-19T11:12:15Z`），`notes/` 目录 0 文件。

这不是"用户暂时没需求"，是**功能本身没被接上**：

1. 三个知识工具的描述是"当用户说存/记住时调用"，但模型没有主动调用的锚点，且实测 0 次说明描述不够；
2. 只有 `save/search/read`，**没有 list / update / forget** → 写进去就是死数据，无法维护；
3. 没有 `[[双链]]`、`#tag`、目录分类等 Obsidian 原生语义 → 和"往文件夹里丢 md"没区别；
4. `note_search` 只有 `query` + `limit`（`src/tools.js:317-323`），**连 `kinds` 都没暴露**（记忆侧的 `inkvault_search` 反而有，`src/tools.js:133-137`）。

所以真正的结论是：**关记忆面是"止血"，做知识面才是"改造"。只做前者，墨库就退化成 4 个工具的薄封装，价值低于直接卸载。**

### 为什么不干脆删掉记忆面代码

因为**降级模式有真实价值**：如果哪天卸载灵枢（第三方包，或 Python 环境坏掉），墨库还留着一条可用的记忆路径，比"什么都没了"好。而且 `toolDefinitions` 本来就按 `runtime.memoryOn` 动态拼装（`src/tools.js:408-414`），`memoryEnabled: false` 天然就只注册 4 个工具——**代码不需要为这个改一行**。

---

## 1. 现状基线（实测，非文档）

### 1.1 资源占用

| 项 | 数值 | 出处 |
|---|---|---|
| 工具 schema 常驻（双开） | 8 工具 / **2771 字符** / ≈693 tok | `node -e` 实测拼装 |
| 工具 schema 常驻（仅知识） | 4 工具 / **1010 字符** / ≈253 tok | 同上 |
| **节省** | **−4 工具 / −1761 字符 / ≈−440 tok 每请求** | |

逐工具字符数（`JSON.stringify(t.parameters).length`）：

```
双开：search 482 / read 179 / remember 862 / forget 234
      note_save 499 / note_search 245 / note_read 185 / status 76  = 2771
仅知识：note_save 499 / note_search 245 / note_read 185 / status 76 = 1010
```
| 钩子（`memoryOn` 时全注册） | 5 个：`session/event`、`agent/pre-step`、`agent/turn-stopping`、`agent/disposed`、`system-prompt/assemble` | `index.js:433-456` |
| 进程内常驻状态 | `turnBuffers` Map（上限 50 会话，`index.js:38`）+ `injectedTurns` Set（上限 1000 条，`index.js:37`） | |
| 源码 | `index.js` 470 + `src/*.js` 2875 + `client.js` 362 = 3707 行 | `wc -l` |
| 测试 | 7 文件 / **132 个测试（131 通过 + 1 跳过）**，全部独立跑绿 | `node <file>` 逐个执行 |
| 运行时依赖 | 仅 `@deepseek-ai/schemastery ~3.18.5` | `package.json` |

### 1.2 记忆面代码分布（关掉后成为死重量）

| 文件 | 行数 | 职责 | 关闭后 |
|---|---|---|---|
| `src/recall.js` | 121 | 召回注入文本拼装 | 死代码 |
| `src/capture.js` | 302 | 5 条规则抽取 + 6 kinds + delivery 分层 | 死代码（当前 `capture: false` 已不跑） |
| `src/prompt.js` | 89 | 指令层块渲染 | 死代码 |
| `src/tools.js` 的 `memoryToolDefinitions` | 122-276 | 4 个记忆工具 | 不注册 |

合计约 512 行 + 4 个工具定义。**注意**：`index.js` 顶部是静态 import，这些模块仍会被解析加载（毫秒级，可忽略），只是不再执行。

### 1.3 知识面现状（要补强的地方）

| 维度 | 现状 | 缺口 |
|---|---|---|
| 工具 | save / search / read（`src/tools.js:280-375`） | 缺 list / update / forget |
| 检索 | 纯 BM25，K1=1.2 B=0.75，中文 2-gram（`src/search.js`） | 标题不加权；`tags`/`kinds` 未暴露给 `note_search` |
| 元数据 | `ENTRY_KINDS` 6 类、`ENTRY_STATUSES` 4 态、`ENTRY_DELIVERIES` 2 道（`src/frontmatter.js:14,17,35`） | 知识不需要 `confidence`/`status: pending`/`delivery`——`noteSave` 硬写 `confidence: 1`、`status: 'active'`，`delivery` 落到默认 `'recall'`（无意义） |
| 目录 | `contentDir: 'notes'` 固定（`index.js:71`），`listMarkdown` 递归（`src/paths.js:217`） | 递归能力已有，但**写入侧没有 folder 参数**，无法分目录 |
| 双链/标签 | 无 | `[[...]]`、`#tag` 都不解析 |
| 索引 | `.inkvault/index.json`，**任一文件 mtime > builtAt 就整库重建**（`src/store.js:214` → `rebuildIndex` `:459`） | 每次手改一个笔记 = 全量重扫 + 全量重写索引。知识库规模一大就卡 |
| 触发 | 无注入、无钩子（知识侧零钩子，这点是对的） | 模型不知道有这个能力 → 0 写入 |

### 1.4 当前 profile 实际配置（`cordis.patch.yml:84-94`）

```yaml
- id: inkvault
  config:
    disabled: false
    memoryEnabled: true
    memoryRoot: 'D:\Obsidian库\墨库 InkVault-记忆库'
    inject: true
    capture: false
    knowledgeEnabled: true
    knowledgeRoot: 'D:\Obsidian库\墨库 InkVault-知识库'
  disabled: false
```

注意 `capture: false` 已经关掉了自动沉淀，但 `inject: true` 仍让**召回钩子每回合跑 BM25 检索**，且 `directives: true`（默认）让 `system-prompt/assemble` 每步扫全库。

---

## 2. 分阶段改造

### P0 · 配置层止血（零代码，可逆，先做）

**改动**：`cordis.patch.yml:84-94`

```yaml
- id: inkvault
  config:
    disabled: false
    memoryEnabled: false          # ← 唯一实质改动：记忆面关闭，退化为降级模式
    memoryRoot: 'D:\Obsidian库\墨库 InkVault-记忆库'   # 保留，便于随时开回
    inject: false                 # 与 memoryEnabled 同步关，避免歧义
    capture: false
    knowledgeEnabled: true
    knowledgeRoot: 'D:\Obsidian库\墨库 InkVault-知识库'
  disabled: false
```

**效果（全部由 `runtime.memoryOn` 单点门控，见下表）**

| 关闭项 | 门控位置 | 结果 |
|---|---|---|
| 召回注入（通道 A） | `index.js:113` `if (!memoryOn ... ) return undefined` | 每回合不再跑 BM25 |
| 指令层（通道 B） | `index.js:146` | `system-prompt/assemble` 不再 push 任何块 |
| 会话缓冲 | `index.js:184` | `turnBuffers` 不再增长 |
| 回合沉淀 | `index.js:254` | 不再跑 capture |
| 5 个钩子 | `index.js:433` `if (runtime.memoryOn)` | **全部不注册** |
| 4 个记忆工具 | `src/tools.js:410` | 不注册，schema 2771→1010 字符 |

**净收益**：≈440 tok/请求（schema 2771→1010 字符）+ 5 个钩子 + 2 个上限容器。
**风险**：极低。`inkvault_status` 会显示 `memory.enabled: false`。
**回滚**：`memoryEnabled: true` + 重启会话，一条命令。
**验证**：见 §4 第 1-2 条。

---

### P1 · 代码层收缩为「知识库专精」（v0.5.0）

目标：把"两个半成品"变成一个"完整的知识库工具面"。**不删记忆代码**（降级模式），只做三件事。

#### P1.1 工具面补齐（`src/tools.js`）

| 工具 | 状态 | 说明 |
|---|---|---|
| `inkvault_note_save` | 已有，瘦身 | 描述 799 字符 → ≤350；新增 `folder` 参数 |
| `inkvault_note_search` | 已有，补参 | 暴露 `kinds` + `tags` + `limit`（对齐记忆侧 `inkvault_search` 的能力） |
| `inkvault_note_read` | 已有，不动 | |
| `inkvault_note_list` | **新增** | 按 `folder`/`tags` 列，`recent: true` 时按 updated 倒序。解决"写进去就再也看不见" |
| `inkvault_note_update` | **新增** | 按 id 改正文/标题/标签，走 `writeEntry` 覆盖 + `updated` 刷新 |
| `inkvault_note_forget` | **新增** | 复用 `store.archiveEntry`（`src/store.js:432`）移到 `.trash/`，可恢复 |
| `inkvault_status` | 瘦身 | 去掉 memory 段（`memoryEnabled: false` 时无意义），只报知识库路径/条数/索引健康 |

**工具数 4 → 7**（save/search/read/list/update/forget + status）。schema 预算控制在 **≤2200 字符（≈550 tok）**，比双开的 2771 字符仍省 20% 以上，且**能力是净增的**（现在只有 3 个知识工具）。

#### P1.2 知识建模（`src/frontmatter.js` + `src/store.js`）

1. **`[[双链]]` 解析**：`noteSave`/`noteUpdate` 时扫正文 `[[target]]`，写入 frontmatter `links: [...]`；`note_read` 返回 `backlinks`（反查谁链到它）。这是 Obsidian 原生语义，灵枢做不到。
2. **`#tag` 归并**：正文里的 `#tag` 自动并入 `meta.tags`（去重、小写）。
3. **`folder` 落盘**：`notes/<folder>/<id>.md`，`listMarkdown` 已递归支持（`src/paths.js:217`），写入侧补校验（禁止 `..`、绝对路径、非 `[A-Za-z0-9._-]` 目录名，复用 `src/store.js:36-43` 的 `normalizeContentDir` 校验模式）。
4. **字段减噪**：知识笔记不再写 `confidence` / `status: pending` / `delivery`。
   - 实现方式：`coerceEntry` 增加 `profile: 'knowledge'` 分支（或新常量 `KNOWLEDGE_KEY_ORDER`），知识侧 key 顺序 = `id,title,kind,created,updated,tags,links,source,hash`。
   - **兼容性**：老笔记里多余的字段仍能解析（`coerceEntry` 是容错的），只是不再生成。
   - **风险**：`ENTRY_ID_RE` 是 `^m-\d{8}-[a-z0-9]{6}$`（`src/frontmatter.js:22`），知识笔记沿用 `m-` 前缀会显得怪。建议 0.5.0 **不改 id 格式**（改了要迁移全部旧笔记 + 改 `ENTRY_ID_PATTERN` 的三处引用），留到 0.6.0。

#### P1.3 检索增强（`src/search.js`）

1. **标题加权**：`searchableText` 里把 title 重复 3 次（比改 BM25 公式简单且可测）。
2. **`tags` 过滤**：`store.search` 的 options 已有 `statuses`/`kinds`（`src/store.js:325-331`），加 `tags: string[]`，语义 = 全部命中（AND）。
3. **索引增量**：现在**任一文件 mtime 新于 `builtAt` 就整库重建**（`src/store.js:214`）。改成：
   - 先用 `fs.stat` 对比每个文件 mtime 与索引里记录的 `mtimeMs`，只重读变化的文件；
   - 只有"文件数变化 / 新增 / 删除"才整库重建；
   - 索引结构加 `fileCount` 与 per-entry `mtimeMs`（后者已有）。
   - **风险**：这是索引正确性改动，必须有测试覆盖（见 P4.3）。

---

### P2 · 数据迁移（3 条记忆 → 灵枢）

当前记忆库 3 条活跃笔记：

| id | 标题 | 性质 | 去向 |
|---|---|---|---|
| `m-20261019-079fd2` | 用户偏好：回答使用中文，并尽量简洁 | 用户长期偏好 | → 灵枢 `knowledge` 层（`cg(op=write)`） |
| `m-20261019-7a2652` | 项目约定：建仓可见性与版本号 | 项目约定 | → 灵枢 `knowledge` 层 |
| `m-20261020-942d31` | DSH 插件上架社区市场索引流程 | **知识型长文（reference）** | → 墨库**知识库** `notes/`（这才是它的归属，当初放错了库） |

**步骤**
1. 先做 P0（停写），避免迁移期间又新增；
2. 两条偏好/约定用 `cg(op=write, content_kind=text, layer=knowledge)` 写入灵枢，正文按 CCG 六要素组织；
3. `942d31` 用 `inkvault_note_save` 写进知识库 `notes/dsh-plugin/`；
4. 记忆库目录重命名为 `D:\Obsidian库\墨库 InkVault-记忆库.archived-20261024`（**不删**）；
5. 回滚：目录改回原名即可。

**注意**：`~/.dsh/.dsh-memory` 里已有节点提到过 `awesome-dsh-plugin`（grep 命中 1 个 `contextual` 节点 `mem_1792669778773_0eb8f3`），迁移前先 `cg(op=read)` 查重，避免重复入库。

---

### P3 · 让知识库真正「能用」（真正的差异化）

如果只做到 P2，墨库就是个"能把 md 写进文件夹"的 4 工具插件——**建议直接卸载**。P3 才是立项理由。

| 项 | 做法 | 为什么灵枢给不了 |
|---|---|---|
| **人可编辑** | Obsidian 里直接改，下次 `ensureIndex` 自动重建（已有，`src/store.js:521` + `:158-167`） | 灵枢节点是 agent 生成物，人改会被索引逻辑覆盖 |
| **双链/反链** | P1.2 已建，`note_read` 返回 `backlinks` | 灵枢图是 `edges` 字段，面向推理不面向人类浏览 |
| **目录即分类** | `notes/<folder>/` | 灵枢无目录概念 |
| **零自动注入** | 知识侧不注册任何钩子（现状如此，保持） | 灵枢每轮必推 3 块 |
| **显式工具调用** | 用户说"存/记/整理"才写 | 灵枢 `memory.userMessage: true` 自动沉淀每条用户消息 |
| **触发锚点** | 新增一条**极短**能力提示（≤200 字符 ≈60 tok）注入 `system-prompt/assemble`，可配置关闭 | —— |
| **导出** | 已是 md+frontmatter，Obsidian 原生可读 | 灵枢是自定义 YAML 结构 |

**关于触发锚点的取舍**：0 条写入证明"只靠工具描述"不够。加 200 字符提示的代价是 60 tok/轮，收益是知识库从 0 到能用。**建议加，且默认开，配置键 `knowledgeHint: true`。**

---

### P4 · 设置页、文档、测试

1. **`client.js`（362 行）**：设置页去掉记忆库分组（`memoryRoot` 字段仍保留但折叠进"高级/降级模式"），主界面只剩「知识库文件夹」+「能力提示开关」。当前 `client.js:291-292` 两个输入框并列，会让人以为两边都要配。
2. **`src/config-schema.js`（14 个键）**：保留全部键（降级模式需要），但把 `memoryEnabled` 的 `default: true` 改为 **`default: false`**，描述改为"降级模式：灵枢不可用时的备用记忆面"。
3. **测试**（7 文件 / 132 项：capture 26 / frontmatter 19 / paths 26+1skip / plugin 18 / prompt 9 / search 14 / store 19）：
   - `capture.test.js`（26 项）、`prompt.test.js`（9 项）→ 保留（降级模式仍要能跑）
   - `plugin.test.js:179-208` 的"feature switches independent" 用例 → 扩一条 `memoryEnabled:false` 默认值断言
   - **新增** `test/knowledge.test.js`：list/update/forget、folder 校验、`[[双链]]`/`#tag` 解析、tags 过滤、索引增量重建（**这条必须有**，P1.3 是正确性改动）
4. **文档**：`README.md`（225 行）重写定位段；`docs/internal-contract.md`（295 行）同步 frontmatter 字段表；`dsh-inkvault-架构设计.md`（365 行）标注"记忆面 = 降级模式"。
5. **`package.json`**：版本 → 0.5.0；`description` 去掉 "memory vault"，改 "Obsidian knowledge vault"；`keywords` 加 `knowledge-base`。
   - ⚠️ `engines.dsh: ">=0.2.1-rc.2 <0.2.2"` 是硬钉版本区间，升级 DSH 时会挡安装，需一并确认。

---

## 3. 依赖与顺序

```
P0 (配置, 5min)  ──┬──> P2 (迁移, 需先停写)
                   └──> P1.1 (工具面) ──> P1.2 (建模) ──> P1.3 (检索) ──> P3 (触发锚点) ──> P4 (文档/测试/发布)
```

- P0 与 P1 无依赖，可同轮；
- P2 必须在 P0 之后；
- P1.3 索引增量必须在 P1.2 之后（folder 会改变文件路径集合）；
- P3 的触发锚点依赖 P1.1（没有 list/update 时，提示了也用不起来）。

---

## 4. 验收标准

| # | 验收项 | 判据 |
|---|---|---|
| 1 | 工具面 | 重启后只剩 `inkvault_note_save/search/read/list/update/forget` + `inkvault_status` = 7 个；`inkvault_remember` 等 4 个消失 |
| 2 | schema 预算 | 工具 schema 总字符 ≤2200（现双开 2771 / 仅知识 1010），`node -e` 拼装实测 |
| 3 | 钩子 | `index.js` 运行时 `memoryOn=false` → 5 个 `ctx.on` 均未注册（用 `plugin.test.js` 断言 ctx 监听数） |
| 4 | 注入 | 会话内不再出现 `inkvault-recall` 来源的消息；`system-prompt/assemble` 里无墨库块 |
| 5 | 知识可用性 | `note_save` → `note_list` 能看到 → `note_update` 改标题 → `note_read` 见 `backlinks` → `note_forget` 进 `.trash/`，全链路走通 |
| 6 | 检索 | 同一 query 下，标题命中的笔记排在正文命中之前（标题加权生效） |
| 7 | 索引 | 手改一个 md 后 `ensureIndex` 只重读该文件（用 debug 日志或 `mtimeMs` 对比证明），不全量重建 |
| 8 | 迁移 | 灵枢 `cg(op=read, query=...)` 能检索到迁入的 2 条；知识库 `notes/dsh-plugin/` 有 `942d31` |
| 9 | 测试 | `node --test` 全绿，测试数 ≥132（当前基线 131 通过 + 1 跳过） |

---

## 5. 风险与回滚

| 风险 | 影响 | 缓解 |
|---|---|---|
| 关掉记忆面后用户忘了它存在 | 卸载灵枢时无记忆 | `config-schema.js` 描述里写明"降级模式"，设置页保留入口 |
| 索引增量改动引入漏索引 | 笔记搜不到 | P1.3 独立提交 + 专项测试；回滚 = 恢复 `_loadIndex` 的 mtime 全量判据 |
| `[[双链]]` 解析误伤正文里的 `[[` 字面量 | 错误的 links 字段 | 只解析成对 `[[...]]` 且 target 非空、长度 ≤200；解析失败静默忽略 |
| frontmatter 字段减噪破坏旧笔记 | 老笔记解析告警 | `coerceEntry` 是容错的，多余字段被忽略并 `report()`，不报错 |
| `engines.dsh` 钉版本 | 升级 DSH 后装不上 | P4.5 一并放宽 |
| 迁移时重复入库 | 灵枢出现重复节点 | 迁移前 `cg(op=read)` 查重（§2 P2 已含） |

**全局回滚**：P0 改一行 YAML + 重启；P1-P4 是代码提交，`git revert` 即可（仓库当前 `git status` 干净）。

---

## 6. 工作量估算

| 阶段 | 内容 | 估算 |
|---|---|---|
| P0 | 改 YAML + 验证 | 10 分钟 |
| P1.1 | 3 个新工具 + 2 个补参 | 半天 |
| P1.2 | 双链/标签/folder/字段减噪 | 1 天 |
| P1.3 | 标题加权 + tags 过滤 + 索引增量 | 1 天（含测试） |
| P2 | 迁移 3 条 + 目录归档 | 30 分钟 |
| P3 | 触发锚点 + 设置页 | 半天 |
| P4 | 测试 + 文档 + 发布 | 半天 |

**总计约 3.5 个工作日**。若只做 P0（止血），10 分钟拿到 80% 的资源收益；P1-P4 是拿"墨库还值得装"。

---

## 7. 与灵枢改造计划的衔接

两份计划是同一件事的两半，**必须同轮决策**：

| 灵枢计划 | 墨库计划 | 一致性检查 |
|---|---|---|
| P0 灵枢调参（`autoRecallLimit 4→2`、`contextWindow.turns 10→6`） | P0 墨库 `memoryEnabled: false` | 都指向"只留一个注入源" |
| P2 墨库 3 条记忆 → 灵枢 | P2 同一动作（互为镜像） | **必须只做一次**，避免双写 |
| 不改灵枢 `lib/`（第三方包） | 改墨库 `src/`（自有仓库） | 改造重心应在墨库侧 |

**建议执行顺序**：墨库 P0（关记忆）→ 灵枢 P0+P1（调参）→ 迁移（只做一次，选墨库计划 §2 P2 的路线）→ 墨库 P1（补知识面）。
