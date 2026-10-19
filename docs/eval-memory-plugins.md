# 记忆插件对比测评：灵枢 / engram / InkVault

> 测评日期：2026-10-19（同日按用户决定移除 engram） · 环境：DSH `0.2.1-rc.2`、Windows、Node 24 · 目的：决定三套记忆系统如何分工，避免重复注入与数据重复。

## 1. 对象

| 系统 | 形态 | 数据 | 本机状态 |
|---|---|---|---|
| **灵枢** `@furongjun1999/dsh-memory` 0.8.1 | DSH 插件 + MCP server | `md_cg` 认知图（纯 Markdown），`~/.dsh/.dsh-memory`（114 条，1.5 MB） | 已装、已注入 |
| **engram** `@kenz1117/dsh-engram` 0.9.1 | DSH 插件（Host + Client） | SQLite 三库（user/project/shared）+ FTS5 + 本地向量，`~/.dsh/engram` | 本次安装测评，**测评后已移除** |
| **InkVault** `dsh-inkvault` 0.3.0 | DSH 插件（Host + Client） | 双目录 Markdown（`D:\Obsidian库\...`） | 已装、`inject: true` |

## 2. 方法

- 写入同样 5 条受控记忆：中文回答偏好、Windows/DSH 事实、vx.y.z 版本规则、新项目默认私有仓库、2026-10-19 库迁移到 D 盘。
- 5 个查询：Q1 语言偏好 / Q2 版本规则 / Q3 新项目仓库 / Q4 迁移位置 / Q5 语义改写（“聊天回复应该用什么语种”）。
- 指标：top-1 是否正确、正确结果名次、语义改写是否命中、注入协议与工具成本。

## 3. 结果

| 查询 | engram | InkVault | 灵枢 |
|---|---|---|---|
| Q1 语言偏好 | ✅ top-1 | ✅ top-1 | ✅（已有原始对话卡） |
| Q2 版本规则 | ✅ top-1 | ✅ top-1 | ⚠️ 正确 CCG 卡在 top-2（top-1 是原始对话） |
| Q3 新项目仓库 | ⚠️ top-1 是版本规则，正确项 top-2 | ✅ top-1 | ⚠️ 命中原始对话，无结构化卡 |
| Q4 迁移位置 | ✅ top-1 | ✅ top-1 | ❌ 未召回具体位置 |
| Q5 语义改写 | ⚠️ 关键词命中（偏好第 2） | ❌ 无结果 | — |

**engram 关键发现：语义嵌入在本机不可用**——检索输出明确标注「语义嵌入不可用，仅关键词检索」。已安装 `onnxruntime-node`（289 MB）与 `@huggingface/transformers`（14 MB），但 `~/.dsh/engram/models` 没有模型文件，推断模型下载受网络限制；因此 engram 实际退化为 FTS5 关键词检索，与 InkVault 的 BM25 同属词法层。

## 4. 成本与体验

| 维度 | 灵枢 | engram | InkVault |
|---|---|---|---|
| 安装体积 | 中等 | **≈ 305 MB**（onnxruntime-node 289 MB + HF 14 MB + 插件 1.5 MB，不含模型） | ≈ 0（1 个 schemastery 依赖） |
| 工具数量 | 2（cg/stg） | **21** | 8 |
| 注入方式 | 每轮注入「最近记忆」块 | 会话开始注入画像（条数 + token 预算） | 每回合 step 0，≤ 800 token |
| 注入协议 | 无显式标注 | **最完善**：`<engram_memory_context>` + 使用警告 + `<current_user_request>` 分离 | 有 `trust="untrusted-data"` 标注 |
| 额外摩擦 | 低 | **证据门**：每次检索后需 `engram_assess`（本次 5 个批次被提醒补判） | 低 |
| 独有能力 | CCG 六要素卡、白箱规则、MCP、自愈/元认知 | 宫殿坐标、三作用域、取代链/矛盾边、复习(SM-2)、巩固/衰减、脱敏、实体词典、镜像导出 | 用户自有 Obsidian 双目录、知识库显式写入、可视化设置页 |

## 5. 结论

1. **三套同时开启自动注入不合适**：灵枢每轮注入 + engram 会话画像 + InkVault pre-step 注入会重复召回、争 token 预算、并让“哪条才算数”变得不可判定。
2. **当前最优分工**：灵枢 = agent 工作记忆（已成熟、已注入）；InkVault = 用户自有 Obsidian 知识库/记忆库（差异化、零重依赖）；engram 暂不参与自动注入。
3. **engram 值得借鉴、暂不建议常驻**：体积 305 MB、语义检索在本机不可用、21 个工具与证据门带来持续 token/交互成本；其替换链、脱敏、协议标签、作用域、复习闭环可择优移植进 InkVault 路线。
4. 若坚持保留 engram：先解决本地向量模型下载，并关闭灵枢或 InkVault 其中之一的自动注入，避免三重注入。

## 6. 复现与清理

- engram 测试条目：`user` 2 条（偏好阁#1、事实厅#1）、`project` 3 条（决策堂#1/#2、往事廊#1）。
- InkVault 测试条目：`m-20261019-079fd2`（语言偏好，保留）、`m-20261019-f458c0`（迁移记录，保留）；重复的 `m-20261019-a0a63d` 已归档去重。
- 移除 engram：`plugin_manager remove_bundle @kenz1117/dsh-engram` 在本机两次卡在 pnpm 阶段（10 分钟无输出），最终手动完成：从 profile `package.json` 去掉依赖、从 `pnpm-lock.yaml` 去掉 importer 条目、删除 `node_modules/{@kenz1117,@huggingface,onnxruntime-node}` 与 `~/.dsh/engram`。回收约 **300 MB**（onnxruntime-node 289 MB + transformers 14 MB + 插件与数据）。lockfile 的 packages 快照条目留待下次 `pnpm install` 自动清理。
