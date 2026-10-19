# dsh-inkvault · 内部实现契约 v0.1.0

> 本文件是并行实现的唯一契约源。所有模块必须**严格**按下述签名、数据形状与文件路径实现。
> 约束：ESM（`"type": "module"`）、零第三方依赖、只允许 `node:*` 与相对导入、Node ≥ 20。
> 测试：`node --test test/`（每个测试用 `fs.mkdtemp(path.join(os.tmpdir(), 'inkvault-'))`，结束清理）。

## 目录

```
index.js                 # 插件入口（Lead）
src/config.js            # 配置解析与默认值（Lead）
src/recall.js            # 召回：查询、预算、注入文本（Lead）
src/tools.js             # 四个工具定义（Lead）
src/paths.js             # 路径隔离 + 原子写（B）
src/capture.js           # 规则抽取候选（B）
src/frontmatter.js       # frontmatter 解析/序列化/元数据规范化（A）
src/search.js            # 分词 + BM25（A）
src/store.js             # vault 存储、索引、journal（A）
test/paths.test.js       # B
test/capture.test.js     # B
test/frontmatter.test.js # A
test/search.test.js      # A
test/store.test.js       # A
test/plugin.test.js      # Lead（集成）
```

**写入范围隔离**：A 只写 `src/frontmatter.js`、`src/search.js`、`src/store.js` 及其三个测试；B 只写 `src/paths.js`、`src/capture.js` 及其两个测试；Lead 写其余文件。不得改动他人文件。

## 0. 数据形状

### 0.1 EntryMeta（frontmatter 规范化后的元数据）

```js
{
  id: string,            // /^m-\d{8}-[a-z0-9]{6}$/，必填
  title: string,         // 单行，非空；缺省取 body 首行；最长 120 字符
  kind: string,          // 'preference' | 'fact' | 'decision' | 'project' | 'reference' | 'task'
  status: string,        // 'active' | 'pending' | 'superseded' | 'archived'
  created: string,       // ISO8601 字符串
  updated: string,       // ISO8601 字符串
  tags: string[],        // 去重，元素非空，最多 12
  confidence: number,    // 0..1
  source: string,        // 'capture' | 'manual' | 'import'
  hash: string,          // 正文内容 hash（16 位十六进制）
  origin: string,        // 可选：来源会话 id；无则 ''
}
```

### 0.2 EntryRecord

```js
{ meta: EntryMeta, body: string, path: string }  // path 为 vault 内相对路径，如 'memory/m-20261019-ab12cd.md'
```

### 0.3 vault 布局

```
<root>/
  memory/<id>.md          # 全部记忆条目（active/pending/superseded 都是文件，状态看 frontmatter）
  .inkvault/index.json    # 派生索引（可删除重建）
  .inkvault/journal.jsonl # 追加写审计日志
  .inkvault/quarantine/   # 解析失败的文件隔离区
  .trash/                 # forget 后的可逆归档
  .obsidian/              # 已存在则忽略
```

### 0.4 记忆文件格式

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
source: capture
hash: 0123456789abcdef
origin: ''
---

正文 Markdown。
```

## 1. `src/frontmatter.js`（A）

```js
export const ENTRY_KINDS;        // 见 0.1，冻结数组（Object.freeze）
export const ENTRY_STATUSES;     // 见 0.1
export const MAX_BODY_CHARS;     // 20000

// 解析一个完整 Markdown 文档。无 frontmatter 时 meta={}，body=原文。
// 只支持 YAML 子集：`key: value`、行内数组 [a, b]、双/单引号标量、数字、布尔、空值。
// 未知键保留为字符串；重复键、嵌套对象、多行值记为 issue 而不是抛错。
export function parseDocument(text)      // -> { meta: object, body: string, issues: string[] }

// 序列化。键顺序固定为 0.1 顺序；tags 用行内数组；字符串按需引号；body 不以换行结尾。
export function stringifyDocument(meta, body)  // -> string

// 把任意 meta 规范化为 EntryMeta。缺省值：title 取 body 首行（截 120），kind='fact'，
// status='active'，created/updated=now().toISOString()，tags=[]，confidence=0.5，
// source='manual'，hash=hashText(body)，origin=''。非法值回落到默认并记 issues。
export function coerceEntry(meta, body, options = {})  // options: { now?: () => Date }
export function entryToMarkdown(entry)   // -> string（= stringifyDocument(entry.meta, entry.body)）

export function hashText(text)           // -> sha256(text) 前 16 位小写十六进制
export function makeEntryId(now = new Date(), seed = '')  // -> `m-YYYYMMDD-` + hashText(seed+时间戳) 前 6 位
export function titleFromBody(body)      // -> 首个非空行，去除 Markdown 标记（#、-、>），截 120
export function parseDate(value)         // -> Date | undefined；接受 ISO 字符串与毫秒数
```

`parseDocument` 必须：只在文本以 `---` 开头且能找到第二行 `---` 时解析；`---` 后的内容为 body（去掉紧邻的一个空行）；对 `window`/`null`/`~` 值输出空字符串；对 `[a, b]` 产出字符串数组。

## 2. `src/search.js`（A）

```js
export function tokenize(text)   // -> string[]
// 规则：小写；ASCII 字母数字连续段长度 >=2；CJK（\u4e00-\u9fff 等）连续段取 2-gram，
// 单字段保留单字；去掉纯标点；去重（保留首次出现顺序）。

export function buildIndex(docs)      // docs: [{ id: string, text: string }] -> Index
export function searchIndex(index, query, options = {})  // -> [{ id, score }] 按 score 降序
// options: { limit = 8 }；查询无 token 或索引为空时返回 []；score 保留 6 位小数。
export function serializeIndex(index) // -> 纯 JSON 对象
export function deserializeIndex(raw) // -> Index（raw 非法/版本不符时返回 undefined）
```

Index 形状（`serializeIndex`/`deserializeIndex` 即此对象）：

```js
{
  version: 1,
  N: number,                         // 文档数
  avgdl: number,                     // 平均词数（保留 6 位小数）
  docs: { [id]: { len: number } },
  df: { [term]: number },
  postings: { [term]: { [id]: number } }  // tf
}
```

BM25：`k1=1.2, b=0.75`；`idf = ln(1 + (N - df + 0.5) / (df + 0.5))`；
`score = Σ idf * tf*(k1+1) / (tf + k1*(1 - b + b*dl/avgdl))`。空索引/空文档安全。

## 3. `src/paths.js`（B）

```js
export class VaultPathError extends Error {}   // name='VaultPathError'，message 含具体原因

export function isInside(parentAbs, childAbs)  // -> boolean；大小写不敏感（Windows 用 path.relative 判断）
export async function ensureDir(dir)           // mkdir recursive
export async function realpathOrSelf(p)        // realpath，不存在时返回 resolve 后的原路径
export async function safeResolve(root, relative)   // -> 绝对路径；见下
export async function safeReadFile(root, relative)  // -> string
export async function safeWriteAtomic(root, relative, text)  // -> 绝对路径
export async function safeMove(root, relativeFrom, relativeTo) // -> 目标绝对路径
export async function listMarkdown(root, relativeDir)  // -> 相对路径数组（排序稳定）
export function slugify(text, maxLen = 60)     // -> 文件名安全串：小写、空白转 -、去特殊字符、截断；空则 'entry'
```

`safeResolve(root, relative)` 规则（必须全部满足，否则抛 `VaultPathError`）：

1. `relative` 必须是字符串且非空；`path.isAbsolute(relative)` 直接拒绝。`root` 先 `path.resolve`。
2. `const abs = path.resolve(rootAbs, relative)`；`isInside(rootAbs, abs)` 必须为 true。
3. 从 root 到 abs 逐级 `lstat`（跳过不存在的尾部）：任一层是符号链接/junction 时，取其 `realpath`，并验证 realpath 仍在 `realpath(root)` 内，否则拒绝。符号链接链上的每一级都要检查。
4. Windows 下大小写差异不得导致越界误判；必须拒绝 `..` 逃逸、`C:\` 绝对路径、`\\server\share` UNC。

`safeWriteAtomic`：先写 `<file>.tmp-<pid>-<random>`，`fsync`（`fs.open` + `fh.sync`）后 `rename`；父目录不存在则 `ensureDir`；失败清理 tmp。只允许写 root 内路径。

`safeMove`：跨目录 move；目标父目录不存在则创建；用 `rename`，`EXDEV` 时回退 copy+unlink。

## 4. `src/store.js`（A）

```js
export class VaultStore {
  constructor({ root, now = () => new Date(), clock = () => Date.now() })
  // root 为绝对路径（已由调用方解析）。构造不做 IO。

  get root();                       // 绝对路径
  async init();                     // ensureDir(memory, .inkvault, .inkvault/quarantine, .trash)；
                                    // 载入索引；索引缺失/损坏/过期（任一 md mtime 晚于 builtAt）则 rebuildIndex()
  async listEntries();              // -> EntryRecord[]（按 updated 降序，再按 id）
  async getEntry(id);               // -> EntryRecord | undefined；id 非法格式返回 undefined
  async search(query, options = {}); // options: { limit=8, statuses=['active','pending'], kinds=null }
                                    // -> [{ entry: EntryRecord, score: number }]；score 降序
  async writeEntry({ meta, body, path });  // 规范化(meta 已规范或未规范均可)、分配/保留 id、
                                    // created 保留旧值(同 id 已存在时)、updated=now、
                                    // 写 memory/<id>.md、更新内存索引、saveIndex、journal
                                    // -> EntryRecord
  async archiveEntry(id, reason = ''); // 不存在 -> undefined；移动到 .trash/<id>-<clock>.md，
                                    // 从索引移除，journal 记录；-> { id, trashPath } 相对路径
  async rebuildIndex();             // 扫描 memory/*.md，解析失败的文件移动到 .inkvault/quarantine/；
                                    // 重建 BM25 并 saveIndex；-> { count, quarantined: string[] }
  async ensureIndex();              // 已就绪则直接返回
  async journalRecord(record);      // 追加一行 JSON 到 .inkvault/journal.jsonl（record 由调用方给 ts）
  async close();                    // 预留；当前可空实现
}
```

实现要求：

- **Markdown 是唯一事实源**：`listEntries()` 以文件为准；索引只是缓存。`init()` 后 `listEntries()` 必须返回磁盘上的全部合法条目。
- 索引文件：`.inkvault/index.json`，形状 `{ version: 1, builtAt: number, entries: EntryRecord[] 的元数据快照, search: <serializeIndex 结果> }`；`entries` 里每条含 `{ meta, body, path, mtimeMs }`。**注意**：索引可含 body（v0.1 允许，方便召回），但删掉索引后必须能从文件完整重建。
- 过期判定：`builtAt` 早于 `memory/` 下任一 `.md` 的 `mtimeMs`，或条目数不一致。
- 写入必须原子（复用 `paths.safeWriteAtomic`）；写入失败不得破坏索引（先写文件，再更新内存与索引文件）。
- journal 每行：`{ ts: number, op: 'write'|'archive'|'rebuild'|'quarantine', id?: string, path?: string, detail?: string }`。journal 写失败只记警告，不抛。
- `writeEntry` 的 `path` 参数可选：给了就用它（必须在 `memory/` 下），否则 `memory/<id>.md`。
- 不做路径判断以外的安全策略；路径安全由 `paths.js` 负责。
- 索引写入失败（如磁盘满）不得让 `writeEntry` 抛错：捕获并继续，返回 EntryRecord。

## 5. `src/capture.js`（B）

```js
export const MAX_CANDIDATES_PER_TURN;   // 2（默认值；调用方可覆盖）
export const MIN_CONFIDENCE;            // 0.6

// content blocks -> 纯文本。只拼接 {type:'text'} 的 text，块间用 '\n'。
export function textOfContent(content)          // -> string

// 规则抽取。不读写文件、不生成 id。
// input: {
//   userText: string, assistantText?: string, turn?: number,
//   now?: () => Date, maxCandidates?: number, minConfidence?: number
// }
// -> Candidate[]
// Candidate: {
//   kind, status, confidence, title, body, tags: string[], rule: string
// }
// body 为命中的句子（去首尾空白，最多 500 字符）；title 为 body 首行截 80；
// status 恒为 'pending'；tags 含 kind 与规则名；confidence 见下表。
// 没有命中返回 []。输入文本先做规范化：折叠空白、去零宽字符、限制 20000 字符。
export function extractCandidates(input)

export function detectRememberIntent(text)  // -> boolean（显式“记住/remember”）
export function splitSentences(text)        // -> string[]（中英句末标点与换行切分，过滤 <3 字符片段）
```

规则（中英双语，大小写不敏感；一条文本命中多个规则时，按优先级取，且候选 body 不得重复）：

| rule | 触发 | kind | confidence |
|---|---|---|---|
| `explicit` | 记住/记一下/请记/帮我记/remember that/note that | 由内容判定：含偏好词→preference，否则 fact | 0.95 |
| `preference` | 我喜欢/我更喜欢/我偏好/我习惯/我通常/我不喜欢/我讨厌/别用/不要用/I prefer/I always/I never/I don't like | preference | 0.8 |
| `decision` | 决定/采用/定了/就用/选择用/结论是/we decided/let's go with/we'll use | decision | 0.75 |
| `personal-fact` | 我叫/我的…是/我在…工作/我在…住/my name is/I work at/I live in | fact | 0.7 |
| `project-convention` | 这个项目/本项目/我们的项目/仓库约定/in this project/this repo/convention | project | 0.6 |

硬性过滤：命中句长度 < 4 或 > 500 跳过；纯疑问句（以 `?`/`？` 结尾且不含陈述词）跳过；assistantText 不参与抽取（仅保留参数以备将来）。

## 6. `src/recall.js`（Lead，供参考）

```js
export function extractQueryText(messages)  // -> string：取 source.kind !== 'inkvault-recall' 的 user 消息文本
export function estimateTokens(text)        // -> number：CJK 计 1 token/字，其余按 4 字符/token，向上取整
export function buildInjectionText(results, options) // -> string | null
```

## 7. 测试要求

- A：frontmatter（往返、坏输入、默认值、hash/id）；search（分词、BM25 排序、空索引、序列化往返）；store（init 建目录、写入→读回、重建索引、删索引后重建、archive、journal、坏文件隔离）。
- B：paths（`..` 逃逸、绝对路径、UNC、符号链接/junction 逃逸、原子写、safeMove、listMarkdown）；capture（五类规则命中、英文、无命中、去重/限量、优先级）。
- 所有测试使用 `node:test` + `node:assert/strict`，不依赖网络。
- 测试必须能在 Windows 下通过；符号链接用例在无权限创建时 `t.skip()`，但 junction 用例应尝试。
