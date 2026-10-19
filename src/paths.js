/**
 * src/paths.js — vault 路径隔离与原子写（安全边界）。
 *
 * 这个模块是插件的安全边界：所有落盘/读取路径都必须经过 safeResolve。
 * 它拒绝：
 *   - 绝对路径（POSIX `/…`、Windows 盘符 `C:\…`、UNC `\\server\share`）；
 *   - 用 `..` 逃出 root 的路径；
 *   - 任何一段是符号链接/junction 且指向 root 之外（逐段校验）；
 *   - 非字符串/空路径/NUL 字符/Windows 保留设备名（NUL、CON、COM1…）。
 *
 * 设计约定：
 *   - root 由调用方信任并自行解析；本模块只保证「解析出的绝对路径仍在 root 内」。
 *   - safeResolve 返回的是**逻辑绝对路径**（已归一化、无 `..`）。所有后续文件操作都在这个
 *     normalized 路径上执行，因此 `link/../x` 这类「词法上在 root 内、语义上跟随链接」的
 *     技巧不会生效（我们从不把带 `..` 的原始串交给 fs）。
 *   - 符号链接链的每一段都会用 realpath 对比校验（见 assertNoSymlinkEscape 里关于
 *     Windows junction 与 lstat 的说明）；指向 root 内部的链接是允许的。
 *   - 原子写 = 同目录临时文件 → fsync → rename，失败清理临时文件。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/** 生成同目录临时文件名：`<file>.tmp-<pid>-<random>`。不以 `.md` 结尾，因此不会被 listMarkdown 扫到。 */
const makeTmpName = (basename) => `${basename}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;

/** 只认 `.md` 后缀（大小写不敏感，Windows 上常见 `.MD`）。 */
const MARKDOWN_RE = /\.md$/i;

/** 单个字母 + 冒号的开头视为盘符路径（含 Windows 的驱动器相对路径 `C:x`）。 */
const DRIVE_PREFIX_RE = /^[A-Za-z]:/;

/**
 * Windows 保留设备名。它们在任意目录下都会解析成设备（`root/NUL` 打开的是 NUL 设备而不是文件），
 * 会绕过「写入 root 内文件」的语义，因此直接拒绝。`NUL.txt` 这类带扩展名的写法同样命中。
 */
const WINDOWS_DEVICE_RE = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;

/** 路径越界/不合法时抛出的错误。`name` 固定为 'VaultPathError'，message 含具体原因。 */
export class VaultPathError extends Error {
  constructor(message) {
    super(message);
    this.name = 'VaultPathError';
  }
}

/** 所有平台都按 Windows 语义识别绝对路径，避免在 POSIX 上漏掉 `C:\` / UNC 输入。 */
function isAbsoluteAnywhere(target) {
  return path.isAbsolute(target) || path.win32.isAbsolute(target);
}

/**
 * childAbs 是否在 parentAbs 之内（parent 自身算「之内」）。
 * Windows 上大小写不敏感（path.win32.relative 内部会小写比较）。
 */
export function isInside(parentAbs, childAbs) {
  const parent = path.resolve(parentAbs);
  const child = path.resolve(childAbs);
  if (parent === child) return true;
  const rel = path.relative(parent, child);
  if (rel === '') return true;
  // 跨盘符时 relative 会返回目标绝对路径。
  if (path.isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${path.sep}`);
}

/** mkdir -p。已存在时不报错。 */
export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

/** realpath；路径不存在时返回 path.resolve 后的原路径（用于「尾部尚不存在」的写入场景）。 */
export async function realpathOrSelf(p) {
  const abs = path.resolve(p);
  try {
    return await fs.realpath(abs);
  } catch (err) {
    if (err && err.code === 'ENOENT') return abs;
    throw err;
  }
}

/** 两个真实路径是否指向同一位置（Windows 大小写不敏感）。 */
function samePath(a, b) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * 逐段确认 root → abs 之间没有「指向 root 外」的符号链接/junction。
 *
 * 判定链接的方式：真实父目录 + 当前段名 ≠ 该段的 realpath。
 * 不能依赖 lstat().isSymbolicLink()：Windows 上 Node 的 lstat 对 junction 会同时报
 * `isSymbolicLink()===false` 与 `isDirectory()===true`（readlink 也返回 EINVAL），
 * 只有 realpath 比较能可靠识别 reparse point。这个方法对普通符号链接同样有效。
 *
 * - 指向 root 内部的链接是允许的；此时把「真实父目录」切到链接目标，继续逐段校验链接链。
 * - 不存在的尾部/断链直接停止：剩余段都是已校验目录下的普通名字；写入用 rename 替换该名字，
 *   不会穿透断链写到外部。
 */
async function assertNoSymlinkEscape(rootAbs, abs, relative) {
  const rootReal = await realpathOrSelf(rootAbs);
  const rel = path.relative(rootAbs, abs);
  if (rel === '') return; // abs 就是 root 本身

  let currentLogical = rootAbs;
  let currentReal = rootReal;
  for (const segment of rel.split(path.sep)) {
    const logicalCandidate = path.join(currentLogical, segment);
    const expectedReal = path.join(currentReal, segment);
    let actualReal;
    try {
      actualReal = await fs.realpath(logicalCandidate);
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return; // 尾部不存在
      throw new VaultPathError(`无法解析路径 ${logicalCandidate}: ${err.code || err.message}`);
    }
    if (!samePath(actualReal, expectedReal) && !isInside(rootReal, actualReal)) {
      throw new VaultPathError(`符号链接/junction 越界: ${relative}（${logicalCandidate} -> ${actualReal}）`);
    }
    // 普通子项与「指向 root 内的链接」都从实际落在的位置继续校验。
    currentLogical = logicalCandidate;
    currentReal = actualReal;
  }
}

/**
 * 把 vault 相对路径解析成 root 内的绝对路径。
 * 任何不满足隔离规则的情况都抛 VaultPathError。
 */
export async function safeResolve(root, relative) {
  if (typeof root !== 'string' || root.length === 0) {
    throw new VaultPathError('root 必须是非空字符串');
  }
  if (typeof relative !== 'string' || relative.length === 0) {
    throw new VaultPathError('relative 必须是非空字符串');
  }
  if (relative.includes('\0')) {
    throw new VaultPathError('relative 不能包含 NUL 字符');
  }
  if (isAbsoluteAnywhere(relative) || DRIVE_PREFIX_RE.test(relative)) {
    throw new VaultPathError(`拒绝绝对路径/盘符/UNC: ${relative}`);
  }

  const rootAbs = path.resolve(root);
  const abs = path.resolve(rootAbs, relative);
  if (!isInside(rootAbs, abs)) {
    throw new VaultPathError(`路径越界（.. 逃逸）: ${relative}`);
  }
  // 逐段拒绝 Windows 保留设备名（NUL/CON/COM1…），它们不落在文件系统命名空间里。
  const relFromRoot = path.relative(rootAbs, abs);
  for (const segment of relFromRoot === '' ? [] : relFromRoot.split(path.sep)) {
    if (WINDOWS_DEVICE_RE.test(segment)) {
      throw new VaultPathError(`拒绝 Windows 保留设备名: ${segment}（${relative}）`);
    }
  }
  await assertNoSymlinkEscape(rootAbs, abs, relative);
  return abs;
}

/** 读取 root 内的文本文件（UTF-8）。 */
export async function safeReadFile(root, relative) {
  const abs = await safeResolve(root, relative);
  return fs.readFile(abs, 'utf8');
}

/**
 * 原子写入 root 内的文本文件，返回绝对路径。
 * 步骤：校验路径 → 建父目录 → 同目录临时文件 'wx' → 写入 → fsync → rename。
 * 任一步失败都会清理临时文件。
 */
export async function safeWriteAtomic(root, relative, text) {
  if (typeof text !== 'string') throw new VaultPathError('safeWriteAtomic: text 必须是字符串');
  const abs = await safeResolve(root, relative);
  const dir = path.dirname(abs);
  await ensureDir(dir);

  const tmp = path.join(dir, makeTmpName(path.basename(abs)));
  let renamed = false;
  try {
    const fh = await fs.open(tmp, 'wx'); // 'wx'：绝不覆盖已存在的临时文件
    try {
      await fh.writeFile(text, 'utf8');
      await fh.sync(); // fsync：rename 之前保证数据已落盘
    } finally {
      await fh.close().catch(() => {}); // 关闭失败不掩盖主错误
    }
    await fs.rename(tmp, abs);
    renamed = true;
    return abs;
  } finally {
    if (!renamed) {
      try {
        await fs.rm(tmp, { force: true });
      } catch {
        /* 清理失败不掩盖主错误；临时文件不会以 .md 结尾，不会被当成记忆条目 */
      }
    }
  }
}

/** 跨目录移动。目标父目录不存在则创建；rename 遇 EXDEV 时回退 copy + unlink。返回目标绝对路径。 */
export async function safeMove(root, relativeFrom, relativeTo) {
  const from = await safeResolve(root, relativeFrom);
  const to = await safeResolve(root, relativeTo);
  await ensureDir(path.dirname(to));
  try {
    await fs.rename(from, to);
  } catch (err) {
    if (!err || err.code !== 'EXDEV') throw err;
    await fs.copyFile(from, to);
    await fs.unlink(from);
  }
  return to;
}

/** 递归列出 relativeDir 下所有 `.md` 文件，返回相对 root 的 POSIX 风格路径（'/' 分隔），稳定排序。 */
export async function listMarkdown(root, relativeDir) {
  const rootAbs = path.resolve(root);
  const rootReal = await realpathOrSelf(rootAbs);
  const dirRel = typeof relativeDir === 'string' && relativeDir.length > 0 ? relativeDir : '.';
  const dirAbs = await safeResolve(root, dirRel);
  const found = [];

  async function walk(currentAbs) {
    let entries;
    try {
      entries = await fs.readdir(currentAbs, { withFileTypes: true });
    } catch (err) {
      if (err && err.code === 'ENOENT') return; // 目录还不存在 = 没有文件
      throw err;
    }
    for (const dirent of entries) {
      // 不跟进符号链接/junction：既防越界，也防目录环。真实 vault 里不需要链接。
      if (dirent.isSymbolicLink()) continue;
      const childAbs = path.join(currentAbs, dirent.name);
      // 防御：Windows 上 junction 可能被 readdir/lstat 当成普通目录，再用 realpath 兜一层。
      let childReal;
      try {
        childReal = await fs.realpath(childAbs);
      } catch (err) {
        if (err && err.code === 'ENOENT') continue;
        throw err;
      }
      if (!isInside(rootReal, childReal)) continue;
      if (dirent.isDirectory()) {
        await walk(childAbs);
      } else if (dirent.isFile() && MARKDOWN_RE.test(dirent.name)) {
        found.push(path.relative(rootAbs, childAbs).split(path.sep).join('/'));
      }
    }
  }

  await walk(dirAbs);
  // 字典序排序，保证同一目录树每次返回顺序一致。
  return found.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** 把任意文本变成文件名安全串：小写、空白转 '-'、去标点符号、截断；结果为空时返回 'entry'。 */
export function slugify(text, maxLen = 60) {
  const limit = Number.isInteger(maxLen) && maxLen > 0 ? maxLen : 60;
  const raw = typeof text === 'string' ? text : '';
  const collapsed = raw
    .normalize('NFKC') // 全角字母/数字归一，便于生成稳定文件名
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '-') // 空白（含全角空格）→ '-'
    .replace(/[^\p{L}\p{N}_-]+/gu, '') // 只保留字母/数字（含 CJK）/下划线/连字符
    .replace(/-{2,}/g, '-') // 折叠连续连字符
    .replace(/^-+|-+$/g, ''); // 去首尾连字符
  // 按码点截断，避免把代理对（emoji）切成两半；截断后再去一次尾部连字符。
  const truncated = Array.from(collapsed).slice(0, limit).join('').replace(/-+$/g, '');
  return truncated || 'entry';
}
