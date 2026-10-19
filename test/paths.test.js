import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  VaultPathError,
  isInside,
  ensureDir,
  realpathOrSelf,
  safeResolve,
  safeReadFile,
  safeWriteAtomic,
  safeMove,
  listMarkdown,
  slugify,
} from '../src/paths.js';

const onWindows = process.platform === 'win32';

/**
 * 递归摘掉目录里的符号链接/junction，再整树删除。
 * 原因：Windows 上 junction 可能被当成普通目录；如果先删掉它的目标目录，
 * 后续 fs.rm 会卡在断链上（ENOTEMPTY）。先摘链接再删树可避免顺序依赖。
 */
async function detachLinks(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const dirReal = await fs.realpath(dir).catch(() => undefined);
  if (!dirReal) return;

  for (const dirent of entries) {
    const child = path.join(dir, dirent.name);
    if (dirent.isSymbolicLink()) {
      await fs.rm(child, { recursive: true, force: true }).catch(() => {});
      continue;
    }
    if (!dirent.isDirectory()) continue;
    const childReal = await fs.realpath(child).catch(() => undefined);
    if (!childReal) continue;
    // 真实路径 ≠ 父真实路径 + 目录名 => 这是被误报成目录的 junction/reparse point。
    if (childReal !== path.join(dirReal, dirent.name)) {
      await fs.rm(child, { recursive: true, force: true }).catch(() => {});
      continue;
    }
    await detachLinks(child);
  }
}

async function removeDirTree(dir) {
  await detachLinks(dir);
  await fs.rm(dir, { recursive: true, force: true });
}

/** 建一个带自动清理的临时目录（base）。 */
async function makeTempDir(t, prefix = 'inkvault-') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async () => {
    await removeDirTree(dir);
  });
  return dir;
}

/** 建 vault root（含 memory/）。 */
async function makeRoot(t) {
  const root = await makeTempDir(t);
  await ensureDir(path.join(root, 'memory'));
  return root;
}

async function writeRaw(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text, 'utf8');
}

/** 尝试创建目录 junction；失败返回 false（测试据此 skip）。 */
async function makeJunction(target, linkPath) {
  try {
    await fs.symlink(target, linkPath, 'junction');
    return true;
  } catch {
    return false;
  }
}

/** 尝试创建文件符号链接；失败返回 false（测试据此 skip）。 */
async function makeFileSymlink(target, linkPath) {
  try {
    await fs.symlink(target, linkPath, 'file');
    return true;
  } catch {
    return false;
  }
}

test('VaultPathError 是 Error 子类且 name/message 符合约定', () => {
  const err = new VaultPathError('越界了');
  assert.ok(err instanceof Error);
  assert.equal(err.name, 'VaultPathError');
  assert.equal(err.message, '越界了');
});

test('isInside：自身/子路径为 true，父路径/同前缀兄弟目录为 false', async (t) => {
  const root = await makeRoot(t);
  assert.equal(isInside(root, root), true);
  assert.equal(isInside(root, path.join(root, 'memory')), true);
  assert.equal(isInside(root, path.join(root, 'memory', 'a.md')), true);
  assert.equal(isInside(root, path.resolve(root, '..')), false);
  assert.equal(isInside(root, path.resolve(root, '..', 'evil.md')), false);
  // 前缀相同但并非子目录（root + '-evil'）
  assert.equal(isInside(root, `${root}-evil`), false);
  assert.equal(isInside(path.join(root, 'memory'), root), false);
});

test('isInside：Windows 大小写不敏感且不产生前缀误判', async (t) => {
  if (!onWindows) return t.skip('仅 Windows 语义');
  const root = await makeRoot(t);
  assert.equal(isInside(root, root.toUpperCase()), true);
  assert.equal(isInside(root.toUpperCase(), root), true);
  assert.equal(isInside(root, `${root.toUpperCase()}-evil`), false);
});

test('safeResolve：接受 POSIX 风格相对路径并返回 root 内绝对路径', async (t) => {
  const root = await makeRoot(t);
  const abs = await safeResolve(root, 'memory/notes/a.md');
  assert.equal(abs, path.resolve(root, 'memory', 'notes', 'a.md'));
  assert.equal(isInside(root, abs), true);
  // 词法上的 `..` 只要没逃出 root 就归一化（返回路径不含 `..`）
  const normalized = await safeResolve(root, 'memory/../memory/a.md');
  assert.equal(normalized, path.resolve(root, 'memory', 'a.md'));
  // 尾部不存在的路径也可解析（写入场景）
  const notYet = await safeResolve(root, 'memory/new/deep/file.md');
  assert.equal(isInside(root, notYet), true);
});

test('safeResolve：Windows 风格的反斜杠相对路径在 Windows 上被正确解析', async (t) => {
  if (!onWindows) return t.skip('仅 Windows 语义');
  const root = await makeRoot(t);
  const abs = await safeResolve(root, 'memory\\sub\\a.md');
  assert.equal(abs, path.join(root, 'memory', 'sub', 'a.md'));
});

test('safeResolve：大小写不同的路径在 Windows 上不抛错且仍在 root 内', async (t) => {
  if (!onWindows) return t.skip('仅 Windows 语义');
  const root = await makeRoot(t);
  await writeRaw(path.join(root, 'memory', 'a.md'), 'x');
  const abs = await safeResolve(root, 'MEMORY/A.MD');
  assert.equal(isInside(root, abs), true);
  assert.equal(await safeReadFile(root, 'MEMORY/A.MD'), 'x');
});

test('safeResolve：拒绝非字符串/空串/NUL', async (t) => {
  const root = await makeRoot(t);
  for (const bad of [undefined, null, 42, {}, '', 'memory/a\0.md']) {
    await assert.rejects(() => safeResolve(root, bad), VaultPathError);
  }
});

test('safeResolve：拒绝 POSIX 绝对路径、Windows 盘符绝对路径与 UNC', async (t) => {
  const root = await makeRoot(t);
  const bad = [
    '/etc/passwd',
    '/',
    'C:\\Windows\\win.ini',
    'C:/Windows/win.ini',
    'C:x', // 驱动器相对路径
    '\\\\server\\share\\evil.md',
    '//server/share/evil.md',
  ];
  for (const relative of bad) {
    await assert.rejects(() => safeResolve(root, relative), VaultPathError, `应拒绝: ${relative}`);
  }
});

test('safeResolve：拒绝 .. 逃逸（POSIX 风格）', async (t) => {
  const root = await makeRoot(t);
  for (const relative of ['../evil.md', '../../evil.md', 'memory/../../evil.md', 'memory/../../../etc/passwd']) {
    await assert.rejects(() => safeResolve(root, relative), VaultPathError, `应拒绝: ${relative}`);
  }
});

test('safeResolve：拒绝 .. 逃逸（Windows 反斜杠风格）', async (t) => {
  if (!onWindows) return t.skip('仅 Windows 语义');
  const root = await makeRoot(t);
  for (const relative of ['..\\evil.md', 'memory\\..\\..\\evil.md']) {
    await assert.rejects(() => safeResolve(root, relative), VaultPathError, `应拒绝: ${relative}`);
  }
});

test('safeResolve：拒绝 Windows 保留设备名（任意目录下的 NUL/CON 都指向设备）', async (t) => {
  const root = await makeRoot(t);
  for (const relative of ['NUL', 'memory/NUL', 'nul.txt', 'CON.md', 'memory/COM1']) {
    await assert.rejects(() => safeResolve(root, relative), VaultPathError, `应拒绝: ${relative}`);
    await assert.rejects(() => safeWriteAtomic(root, relative, 'x'), VaultPathError, `应拒绝写入: ${relative}`);
  }
});

test('safeResolve：拒绝指向 root 外的 junction（根下链接）', async (t) => {
  const base = await makeTempDir(t);
  const root = path.join(base, 'root');
  const outside = path.join(base, 'outside');
  await ensureDir(path.join(root, 'memory'));
  await writeRaw(path.join(outside, 'evil.md'), 'evil');
  if (!(await makeJunction(outside, path.join(root, 'linked')))) {
    return t.skip('当前环境无法创建 junction');
  }

  await assert.rejects(() => safeResolve(root, 'linked/evil.md'), VaultPathError);
  await assert.rejects(() => safeReadFile(root, 'linked/evil.md'), VaultPathError);
  // 外部文件必须原封不动
  assert.equal(await fs.readFile(path.join(outside, 'evil.md'), 'utf8'), 'evil');
});

test('safeResolve：逐段校验——memory/ 内部的 junction 逃逸同样被拒绝', async (t) => {
  const base = await makeTempDir(t);
  const root = path.join(base, 'root');
  const outside = path.join(base, 'outside');
  await ensureDir(path.join(root, 'memory'));
  await writeRaw(path.join(outside, 'sub', 'evil.md'), 'evil');
  if (!(await makeJunction(outside, path.join(root, 'memory', 'link')))) {
    return t.skip('当前环境无法创建 junction');
  }

  await assert.rejects(() => safeResolve(root, 'memory/link/evil.md'), VaultPathError);
  await assert.rejects(() => safeResolve(root, 'memory/link/sub/evil.md'), VaultPathError);
});

test('safeResolve：指向 root 内部的 junction 被允许', async (t) => {
  const root = await makeRoot(t);
  const archive = path.join(root, 'memory', 'archive');
  await writeRaw(path.join(archive, 'a.md'), 'inside');
  if (!(await makeJunction(archive, path.join(root, 'inbox')))) {
    return t.skip('当前环境无法创建 junction');
  }

  const abs = await safeResolve(root, 'inbox/a.md');
  assert.equal(abs, path.join(root, 'inbox', 'a.md'));
  assert.equal(await safeReadFile(root, 'inbox/a.md'), 'inside');
});

test('safeResolve：文件符号链接指向 root 外时被拒绝', async (t) => {
  const base = await makeTempDir(t);
  const root = path.join(base, 'root');
  const outside = path.join(base, 'outside');
  await ensureDir(path.join(root, 'memory'));
  await writeRaw(path.join(outside, 'secret.txt'), 'secret');
  if (!(await makeFileSymlink(path.join(outside, 'secret.txt'), path.join(root, 'memory', 'leak.txt')))) {
    return t.skip('当前环境不允许创建文件符号链接（需要管理员权限或开发者模式）');
  }

  await assert.rejects(() => safeResolve(root, 'memory/leak.txt'), VaultPathError);
  await assert.rejects(() => safeReadFile(root, 'memory/leak.txt'), VaultPathError);
});

test('safeWriteAtomic：原子写入、返回绝对路径、无临时文件残留、可覆盖', async (t) => {
  const root = await makeRoot(t);
  const abs = await safeWriteAtomic(root, 'memory/a.md', '第一版内容');
  assert.equal(abs, path.resolve(root, 'memory', 'a.md'));
  assert.equal(await safeReadFile(root, 'memory/a.md'), '第一版内容');

  const names = await fs.readdir(path.join(root, 'memory'));
  assert.deepEqual(names, ['a.md'], '临时文件必须被 rename 掉，不该残留');

  // 覆盖写
  await safeWriteAtomic(root, 'memory/a.md', '第二版');
  assert.equal(await safeReadFile(root, 'memory/a.md'), '第二版');
  assert.deepEqual(await fs.readdir(path.join(root, 'memory')), ['a.md']);
});

test('safeWriteAtomic：父目录不存在时自动创建', async (t) => {
  const root = await makeRoot(t);
  await safeWriteAtomic(root, 'memory/deep/nested/dir/x.md', 'deep');
  assert.equal(await safeReadFile(root, 'memory/deep/nested/dir/x.md'), 'deep');
});

test('safeWriteAtomic：拒绝 root 外路径且不产生副作用', async (t) => {
  const base = await makeTempDir(t);
  const root = path.join(base, 'root');
  await ensureDir(path.join(root, 'memory'));

  await assert.rejects(() => safeWriteAtomic(root, '../evil.md', 'x'), VaultPathError);
  await assert.rejects(() => safeWriteAtomic(root, '/absolute.md', 'x'), VaultPathError);
  await assert.rejects(fs.stat(path.join(base, 'evil.md')));
});

test('safeWriteAtomic：rename 失败时清理临时文件', async (t) => {
  const root = await makeRoot(t);
  // 目标名已经是一个目录，rename(file -> existing dir) 必然失败
  await fs.mkdir(path.join(root, 'memory', 'blocked.md'));
  await assert.rejects(() => safeWriteAtomic(root, 'memory/blocked.md', 'x'));
  const names = await fs.readdir(path.join(root, 'memory'));
  assert.deepEqual(names, ['blocked.md'], `不应残留 .tmp- 文件，实际: ${names.join(', ')}`);
});

test('safeWriteAtomic：指向 root 外的 junction 路径不可写', async (t) => {
  const base = await makeTempDir(t);
  const root = path.join(base, 'root');
  const outside = path.join(base, 'outside');
  await ensureDir(path.join(root, 'memory'));
  await ensureDir(outside);
  if (!(await makeJunction(outside, path.join(root, 'linked')))) {
    return t.skip('当前环境无法创建 junction');
  }

  await assert.rejects(() => safeWriteAtomic(root, 'linked/evil.md', 'x'), VaultPathError);
  assert.deepEqual(await fs.readdir(outside), [], 'root 外目录不应被写入');
});

test('safeMove：root 内移动、创建目标父目录、内容保留、源消失', async (t) => {
  const root = await makeRoot(t);
  await safeWriteAtomic(root, 'memory/a.md', 'hello');

  const to = await safeMove(root, 'memory/a.md', '.trash/a.md');
  assert.equal(to, path.resolve(root, '.trash', 'a.md'));
  assert.equal(await fs.readFile(to, 'utf8'), 'hello');
  await assert.rejects(fs.stat(path.join(root, 'memory', 'a.md')));

  await safeWriteAtomic(root, 'memory/b.md', 'b');
  const deep = await safeMove(root, 'memory/b.md', 'archive/2026/b.md');
  assert.equal(deep, path.resolve(root, 'archive', '2026', 'b.md'));
  assert.equal(await fs.readFile(deep, 'utf8'), 'b');
});

test('safeMove：拒绝移动到 root 外且源文件保持不变', async (t) => {
  const root = await makeRoot(t);
  await safeWriteAtomic(root, 'memory/c.md', 'c');
  await assert.rejects(() => safeMove(root, 'memory/c.md', '../c.md'), VaultPathError);
  assert.equal(await safeReadFile(root, 'memory/c.md'), 'c');
});

test('listMarkdown：递归、只收 .md、POSIX 相对路径、稳定排序', async (t) => {
  const root = await makeRoot(t);
  await writeRaw(path.join(root, 'memory', 'z.md'), 'z');
  await writeRaw(path.join(root, 'memory', 'a.md'), 'a');
  await writeRaw(path.join(root, 'memory', 'sub', 'b.md'), 'b');
  await writeRaw(path.join(root, 'memory', 'sub', 'deep', 'c.md'), 'c');
  await writeRaw(path.join(root, 'memory', 'notes.txt'), 'txt');
  await writeRaw(path.join(root, 'memory', 'upper.MD'), 'upper');
  await writeRaw(path.join(root, '.trash', 'old.md'), 'old');

  assert.deepEqual(await listMarkdown(root, 'memory'), [
    'memory/a.md',
    'memory/sub/b.md',
    'memory/sub/deep/c.md',
    'memory/upper.MD',
    'memory/z.md',
  ]);

  // relativeDir 为空/缺省时列出整个 root
  assert.deepEqual(await listMarkdown(root, ''), [
    '.trash/old.md',
    'memory/a.md',
    'memory/sub/b.md',
    'memory/sub/deep/c.md',
    'memory/upper.MD',
    'memory/z.md',
  ]);
  assert.deepEqual(await listMarkdown(root), await listMarkdown(root, ''));

  // 目录不存在 -> 空数组
  assert.deepEqual(await listMarkdown(root, 'memory/missing'), []);
});

test('listMarkdown：不跟进 junction，无法借链接列出 root 外内容', async (t) => {
  const base = await makeTempDir(t);
  const root = path.join(base, 'root');
  const outside = path.join(base, 'outside');
  await ensureDir(path.join(root, 'memory'));
  await writeRaw(path.join(root, 'memory', 'a.md'), 'a');
  await writeRaw(path.join(outside, 'evil.md'), 'evil');
  if (!(await makeJunction(outside, path.join(root, 'linked')))) {
    return t.skip('当前环境无法创建 junction');
  }

  const listed = await listMarkdown(root, '');
  assert.deepEqual(listed, ['memory/a.md']);
  assert.equal(listed.some((entry) => entry.startsWith('linked/')), false);
});

test('ensureDir 幂等创建嵌套目录', async (t) => {
  const root = await makeTempDir(t);
  const nested = path.join(root, 'a', 'b', 'c');
  await ensureDir(nested);
  assert.equal((await fs.stat(nested)).isDirectory(), true);
  await ensureDir(nested); // 第二次不抛错
  assert.equal((await fs.stat(nested)).isDirectory(), true);
});

test('realpathOrSelf：存在时返回真实路径，不存在时返回 resolve 后的原路径', async (t) => {
  const root = await makeRoot(t);
  const file = path.join(root, 'memory', 'a.md');
  await writeRaw(file, 'x');

  assert.equal(await realpathOrSelf(file), await fs.realpath(file));

  const missing = path.join(root, 'nope', 'deep', 'x.md');
  assert.equal(await realpathOrSelf(missing), path.resolve(missing));
});

test('slugify：小写、空白转连字符、去特殊字符、截断、空串兜底', () => {
  assert.equal(slugify('Hello World!'), 'hello-world');
  assert.equal(slugify('Many   Spaces\tand\nnewlines'), 'many-spaces-and-newlines');
  assert.equal(slugify('用户偏好：回答用中文'), '用户偏好回答用中文');
  assert.equal(slugify('ＡＢＣ'), 'abc'); // NFKC 全角归一
  assert.equal(slugify('a/b\\c:d*e?f'), 'abcdef');
  assert.equal(slugify('   '), 'entry');
  assert.equal(slugify(''), 'entry');
  assert.equal(slugify('!!!'), 'entry');
  assert.equal(slugify('abc', 2), 'ab');
  assert.equal(slugify('ab cd', 3), 'ab'); // 截断后再去尾部连字符
  assert.equal(slugify('abc', 0), 'abc'); // 非法 maxLen 回落默认值
  assert.equal(slugify('a/../b').includes('/'), false);
});
