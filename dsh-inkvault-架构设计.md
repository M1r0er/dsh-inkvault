# dsh-inkvault · 架构设计

| 项 | 内容 |
|---|---|
| 文档版本 | v0.1-draft |
| 项目名 | **dsh-inkvault**（显示名：墨库 / InkVault） |
| 状态 | 设计进行中：**§1 已出**，§2–§9 待设计 |
| 范围 | DeepSeek Harness（DSH）的 Obsidian / Markdown 记忆插件 |
| 目标环境 | DSH `0.2.1-rc.2` · Node ≥ 20 · Windows 为主 |
| 最后更新 | 2026-10-19 |
| 前置决策 | 自研；名称已定；**不接灵枢、不以灵枢为前提** |

---

## 0. 一句话与 MVP 边界

**一句话**：让本地 Markdown 库同时承担 agent 的长期记忆与用户自己的知识库，并在**路径层**强制隔离——记忆库可写、个人库只读或不可见。

**v0.1.0 的边界**：一个包、一行 patch、两个钩子、四个工具。先把「召回 → 沉淀 → 再召回」闭环跑通，UI 与向量化留到后续版本。

---

## 1. 目标与架构总览

### 1.1 关键事实（决定架构）

**F1. 记忆注入必须走 `agent/pre-step` 的用户消息，不能塞进 system prompt。**
DSH 的 preset 若声明 `complete: true`（stock `minimal` 就是），组装后会把 persona 当唯一提示段，静默丢掉其他插件贡献的系统提示——记忆会失效且不报错。走 pre-step 还额外获得：注入成为可回放的会话事件、对 compaction 可见。
来源：OpenViking `dsh-memory-plugin` README 的 Design Notes。

**F2. DSH 插件的落地形态 = 一个包 + 一行 patch。**
`package.json` 声明 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`，文件内容为：

```yaml
- insert:
    - id: inkvault
      name: dsh-inkvault
```

`dsh plugin --profile <p> add <pkg>` 会自动装包并追加这一层。

**F3. 市场先例已证明这套设计可落地，我们只做合并与差异化。**

| 参考实现 | 层 | 关键设计 | 备注 |
|---|---|---|---|
| [dsh-longterm-memory](https://github.com/bufan528/dsh-longterm-memory) | 记忆层 | 4 工具（search/get/save/forget）、turn/end 规则抽取、BM25 召回、token 预算、收件箱/冲突、崩溃安全 journal | 声明 `engines.dsh >=0.2.1-rc.2 <0.2.2`；视觉证据与 581 测试 |
| [dsh-obsidian](https://github.com/mingzeng21/dsh-obsidian) | 工具层 | 12 个 vault 工具、零服务端、路径穿越防护、`.trash` 可逆删除、Windows 加固 | 30 star，验证到 `0.1.7-rc.2` |

→ 我们**不发明新轮子**，差异只在「自动记忆 + 个人库隔离」合并进一个插件。

**F4. 仍需源码核对的接口（§6 处理）**
`agent/pre-step` 与 `turn/end` 的确切签名、`ctx.tools.register` 的可见性语义、`ctx.systemPrompt` 的参与方式。当前结论来自参考实现的公开设计文档，**不是本地源码**。

### 1.2 目标

| # | 目标 |
|---|---|
| G1 | **自动记忆**：不需要用户说“记住”，每轮自动召回相关记忆，回合结束自动沉淀候选 |
| G2 | **纯 Markdown**：记忆是带 frontmatter 的 `.md`，Obsidian 能开、能编辑、能 git 版本化 |
| G3 | **双库硬隔离**：记忆库（可写）与个人知识库（只读或不可见）在路径层强制分离 |
| G4 | **本地优先**：零服务端、零遥测、默认零模型调用 |

### 1.3 非目标（v0.1.0 明确不做）

| # | 不做 | 原因 |
|---|---|---|
| N1 | 向量 / embedding 检索 | 先词法 BM25，够用且可解释 |
| N2 | 图形管理面板 | 侧边栏 UI 放 v0.2 |
| N3 | 自动摘要、反思、知识图谱 | 先规则抽取 + 冲突保留 |
| N4 | MCP 服务端 / OpenViking / Hindsight 后端 | 本地优先，不引入外部依赖 |
| N5 | 写入用户个人库 | 只读访问，且默认关闭 |
| N6 | 发布 Obsidian 社区插件 | 只做 DSH 侧 |

### 1.4 成功判据（可观测、可验收）

| # | 判据 | 怎么验 |
|---|---|---|
| S1 | 安装可见 | `dsh plugin --profile web list` 有 `dsh-inkvault`；重启后四个 `inkvault_*` 工具出现在模型工具表 |
| S2 | 自动沉淀 | 说一句偏好 → 回合结束 → 记忆库出现 `.md`（frontmatter 完整、`status` 合理），索引更新 |
| S3 | 自动召回 | 新会话问相关问题 → 注入块含该记忆，且注入长度 ≤ 配置预算 |
| S4 | 隔离生效 | 对个人库路径的任何写入（含 `..`、绝对路径、符号链接）被拒绝，有测试用例覆盖 |
| S5 | 可恢复 | 删 `.inkvault/index.json` 重启自动重建；模拟崩溃窗口后 journal 回放、无半写记忆 |
| S6 | 可关闭 | 配置 `disabled: true` 后行为完全回到原状，无残留注入 |

### 1.5 架构总览

```
┌─ DSH host（Node 进程）──────────────────────────────────────┐
│  dsh-inkvault（单个 Cordis row）                             │
│   ├─ config        ← profile/cordis.patch.yml               │
│   ├─ vault 绑定     memoryRoot(可写) / referenceRoots(只读)  │
│   ├─ store         Markdown + frontmatter + journal         │
│   ├─ recall        pre-step hook → 预算内注入                │
│   ├─ capture       turn/end hook → 规则抽取 → 收件箱         │
│   └─ tools         inkvault_search / read / remember / forget│
└─────────────────────────────────────────────────────────────┘
                         │ 文件系统
              D:\InkVault\Memory\   ← Obsidian 可直接打开
```

**分层原则**：v0.1 只做 host 侧（无 client bundle）；先让闭环跑通，再谈 UI 与向量化。

### 1.6 命名与包

- npm 包名：`dsh-inkvault`（建仓时核实是否被占用）
- 显示名：**墨库 / InkVault**
- 仓库：`dsh-inkvault`，private（按 AGENTS.md）；版本从 `v0.1.0` 起

### 1.7 设计原则

1. **路径即权限**：安全边界由 `memoryRoot` / `referenceRoots` 的白名单决定，不靠调用方自觉。
2. **Markdown 是唯一事实源**：索引是派生数据，删了能重建；没有专有格式、没有导出步骤。
3. **注入是数据，不是指令**：注入块显式标注为不可信数据，避免记忆污染变成提示注入。
4. **默认关、可一键禁用**：`disabled: true` 后行为完全回到原状。
5. **先闭环，再智能**：v0.1 宁可规则化、可解释，也不引入语义黑盒。

---

## 2. 数据模型（待设计）

计划覆盖：记忆条目结构、frontmatter 字段、记忆类型、生命周期与验证态、索引与派生数据。

## 3. vault 目录布局与双库隔离（待设计）

计划覆盖：`memoryRoot` 可写 / `referenceRoots` 只读、路径穿越防护、符号链接处理、Obsidian 中的可见性。

## 4. 注入与捕获（待设计）

计划覆盖：pre-step 注入策略、turn/end 抽取、token 预算、去重/合并/冲突、敏感信息拦截。

## 5. 模型可见工具面（待设计）

计划覆盖：工具集合、参数语义、返回格式、只读/写入边界。

## 6. DSH 兼容边界（待设计）

计划覆盖：bundle patch、profile 配置、与 `0.2.1-rc.2` 的接口面（含 §1.1 F4 的源码核对）。

## 7. 失败与恢复（待设计）

计划覆盖：原子写、崩溃窗口、journal 回放、索引重建、隔离区（quarantine）。

## 8. 与 Obsidian 的互操作（待设计）

计划覆盖：wikilink、frontmatter、`.obsidian/` 处理、排除目录、外部编辑的冲突处理。

## 9. 分期路线（待设计）

计划覆盖：v0.1.0 最小可用范围、v0.1.1 / v0.2 的能力增量、每期的验收标准。

---

## 10. 待确认问题

| # | 问题 | 建议 |
|---|---|---|
| Q1 | §1 的目标、非目标、判据是否认可？ | 认可后进入 §2 数据模型 |
| Q2 | v0.1.0 是否包含“个人库只读检索”？ | **不包含**，放 v0.1.1——先把记忆闭环做稳，第一天只碰自己的记忆库，隔离边界更干净 |

## 11. 决策记录

| # | 决策 | 依据 |
|---|---|---|
| D1 | 自研，而非复用 `dsh-longterm-memory` | 用户要自己拥有、长期维护 |
| D2 | 名称 `dsh-inkvault`（墨库） | 避开 Obsidian 商标词与现有插件重名 |
| D3 | 不接灵枢、不以灵枢为前提 | 用户明确不是需求 |
| D4 | 注入走 pre-step 用户消息 | §1.1 F1 |
| D5 | v0.1 只做 host 侧、四个工具、两个钩子 | 先闭环，避免过度设计 |
| D6 | 纯 Markdown + 可重建索引 | §1.7 原则 2 |

## 12. 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v0.1-draft | 2026-10-19 | 建立文档，落地 §1（目标/非目标/判据/架构总览/命名），§2–§9 待设计 |
