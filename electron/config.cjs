/**
 * 应用配置。
 *
 * 存在 Electron 的 userData 目录下 —— 它记录的就是「数据放在哪」，
 * 所以不能放进数据目录本身。
 *
 * 目前只有两项：
 *   dataDir     用户指定的数据目录（留空则用默认位置）
 *   recentDirs  最近用过的目录，便于来回切换
 */

const fs = require('node:fs');
const path = require('node:path');

const MAX_RECENT = 8;

const DEFAULTS = {
  dataDir: '',
  recentDirs: [],
};

function readConfig(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      ...DEFAULTS,
      ...parsed,
      recentDirs: Array.isArray(parsed.recentDirs) ? parsed.recentDirs : [],
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function writeConfig(file, patch) {
  const next = { ...readConfig(file), ...patch };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 原子写入，避免中途崩溃留下半个文件
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return next;
}

/**
 * 把目录记进「最近使用」，去重并保持最新在前。
 *
 * 存之前先 path.resolve 归一化：手工编辑过的配置里可能写成
 * `D:\\a\\b` 这种带多余分隔符的形式，不归一化的话字符串比较永远不相等，
 * 当前目录会重复出现在「最近使用」里。
 */
function rememberDir(file, dir) {
  const cfg = readConfig(file);
  const norm = path.resolve(dir);
  const list = [norm, ...cfg.recentDirs.map(d => path.resolve(d)).filter(d => d !== norm)]
    .slice(0, MAX_RECENT);
  return writeConfig(file, { recentDirs: list });
}

/** 读取时也归一化，兼容历史配置 */
function normalizedRecent(file) {
  const cfg = readConfig(file);
  const seen = new Set();
  const out = [];
  for (const d of cfg.recentDirs) {
    const norm = path.resolve(d);
    if (!seen.has(norm)) { seen.add(norm); out.push(norm); }
  }
  return out;
}

function forgetDir(file, dir) {
  const cfg = readConfig(file);
  const target = path.resolve(dir);
  return writeConfig(file, { recentDirs: cfg.recentDirs.map(d => path.resolve(d)).filter(d => d !== target) });
}

/**
 * 检查一个目录是否可用作数据目录。
 * 不存在就尝试创建；创建后还要确认真的可写。
 */
function probeDir(dir) {
  const target = path.resolve(dir);
  try {
    fs.mkdirSync(target, { recursive: true });
  } catch (err) {
    return { ok: false, dir: target, reason: `无法创建目录：${err.message}` };
  }
  try {
    fs.accessSync(target, fs.constants.W_OK);
  } catch {
    return { ok: false, dir: target, reason: '目录不可写（权限不足或为只读）' };
  }
  try {
    const probe = path.join(target, `.rw-write-test-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe, { force: true });
  } catch (err) {
    return { ok: false, dir: target, reason: `目录不可写：${err.message}` };
  }

  // 判断是不是一个空的/全新的数据目录
  let existing = false;
  try {
    existing = fs.existsSync(path.join(target, 'index.json'))
      || (fs.existsSync(path.join(target, 'campaigns'))
        && fs.readdirSync(path.join(target, 'campaigns')).length > 0);
  } catch { /* 读不了就当空目录 */ }

  return { ok: true, dir: target, hasData: existing };
}

/** 递归复制目录（用于把现有数据搬到新位置） */
function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  let files = 0;
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) {
      files += copyTree(src, dst);
    } else if (entry.isFile()) {
      // 已存在就不覆盖，避免把新目录里已有的东西冲掉
      if (!fs.existsSync(dst)) { fs.copyFileSync(src, dst); files++; }
    }
  }
  return files;
}

module.exports = {
  readConfig, writeConfig, rememberDir, forgetDir, normalizedRecent,
  probeDir, copyTree, DEFAULTS, MAX_RECENT,
};
