/**
 * dsh-conversation-folders — 纯文件系统辅助函数（可独立单测）。
 *
 * 职责：
 *  - 由会话 id 派生文件夹名（Windows 安全、稳定、一一对应）；
 *  - 删除文件夹前的安全校验（必须在工作区根目录的正下方、不能是符号链接/文件）；
 *  - 在工作区下方创建会话文件夹；
 *  - 彻底删除文件夹：先清除只读属性（Windows），再递归删除并重试；
 *  - 扫描 DSH sessions 目录判断某个会话的持久化产物是否仍然存在。
 */
import { chmod, lstat, mkdir, readdir, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const DEFAULT_FOLDER_PREFIX = "会话-";

/**
 * 把会话 id 编码成磁盘会话目录名，与 DSH kernel 的 encodeSegment 契约一致：
 *  - "." -> "~002E"；".." -> "~002E~002E"
 *  - 安全字符 [A-Za-z0-9._-]（不含 "~"）原样保留
 *  - 其余字符（含 ":"、"~"、非 ASCII）转义为 ~XXXX（4 位大写十六进制）
 */
export function encodeFsSessionSegment(raw) {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error("cannot encode an empty path segment");
  }
  if (raw === ".") return "~002E";
  if (raw === "..") return "~002E~002E";
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
      out += ch;
    } else {
      out += "~" + code.toString(16).toUpperCase().padStart(4, "0");
    }
  }
  return out;
}

/** 会话 id 形如 session-<uuid> 时，取 UUID 前 12 位十六进制作短标识。 */
export function folderTokenFor(sessionId) {
  if (typeof sessionId !== "string" || sessionId.length === 0) return "invalid";
  const m = /^session-([0-9a-fA-F]{8})-([0-9a-fA-F]{4})-([0-9a-fA-F]{4})-([0-9a-fA-F]{4})-([0-9a-fA-F]{12})$/.exec(sessionId);
  if (m) return (m[1] + m[2]).toLowerCase();
  // 兜底：清洗非法文件名字符，截断到 40 字符
  const cleaned = sessionId
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/[. ]+$/g, "")
    .slice(0, 40);
  return cleaned.length > 0 ? cleaned : "invalid";
}

/** 由会话 id 派生工作区下的文件夹名，如 会话-29c06ebbe914。 */
export function folderNameFor(sessionId, prefix = DEFAULT_FOLDER_PREFIX) {
  const p = typeof prefix === "string" && prefix.length > 0 ? prefix : DEFAULT_FOLDER_PREFIX;
  return p + folderTokenFor(sessionId);
}

/** 文件夹名主体的字数上限（Windows 路径安全余量）。 */
export const MAX_FOLDER_BASE_CHARS = 48;

/**
 * 把对话标题清洗成可用作文件夹名的文字：
 *  - Windows 非法文件名字符（\ / : * ? " < > | 与控制字符）替换为空格；
 *  - 连续空白折叠成一个空格，去掉首尾空白与首尾点号（Windows 限制）；
 *  - 截断到 MAX_FOLDER_BASE_CHARS，并再次去掉尾部点号/空格；
 *  - 空结果、"."、".." 返回 null（调用方回退到短 ID 命名）；
 *  - Windows 保留设备名（CON/PRN/AUX/NUL/COM1…/LPT1…）后加下划线。
 */
export function sanitizeFolderBase(title) {
  if (typeof title !== "string") return null;
  let base = title
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[. ]+|[. ]+$/g, "");
  if (base.length > MAX_FOLDER_BASE_CHARS) {
    base = base.slice(0, MAX_FOLDER_BASE_CHARS).replace(/[. ]+$/g, "");
  }
  if (base.length === 0) return null;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(base)) return base + "_";
  return base;
}

/**
 * 由对话标题派生文件夹名：`<前缀><清洗后的标题>`；
 * 标题为空/不可用时回退到 `<前缀><短 ID>`。
 */
export function folderNameFromTitle(title, sessionId, prefix = DEFAULT_FOLDER_PREFIX) {
  const p = typeof prefix === "string" && prefix.length > 0 ? prefix : DEFAULT_FOLDER_PREFIX;
  const base = sanitizeFolderBase(title);
  return base === null ? p + folderTokenFor(sessionId) : p + base;
}

/** 规范化一条路径（存在性 + realpath），失败返回 undefined。 */
export async function canonicalize(path) {
  if (typeof path !== "string" || path === "") return undefined;
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}

/**
 * 校验"文件夹删除目标"的安全性。返回 { folderResolved, workspaceResolved }；
 * 任何一项不满足都抛错（调用方只捕获并记录，绝不误删）。
 * 要求：
 *  - folder 为绝对路径；
 *  - folder 已存在且是目录；
 *  - folder 不是符号链接/挂载点；
 *  - folder 规范路径 != 工作区规范路径；
 *  - folder 的父目录（dirname）规范路径 === 工作区规范路径（即必须直接位于工作区下）。
 */
export async function assertSafeFolderTarget(folder, workspacePath) {
  if (typeof folder !== "string" || folder === "") {
    throw new Error("安全校验拒绝：目标文件夹路径为空");
  }
  if (!isAbsolute(folder)) {
    throw new Error("安全校验拒绝：目标文件夹路径不是绝对路径: " + folder);
  }
  if (typeof workspacePath !== "string" || workspacePath === "") {
    throw new Error("安全校验拒绝：工作区路径为空");
  }
  const workspaceResolved = await canonicalize(workspacePath);
  if (workspaceResolved === undefined) {
    throw new Error("安全校验拒绝：工作区路径无法解析: " + workspacePath);
  }
  const folderResolved = await canonicalize(folder);
  if (folderResolved === undefined) {
    throw new Error("安全校验拒绝：目标文件夹不存在: " + folder);
  }
  const info = await lstat(folderResolved);
  if (info.isSymbolicLink() || info.isFile()) {
    throw new Error("安全校验拒绝：目标不是普通目录（符号链接/文件）: " + folderResolved);
  }
  if (folderResolved === workspaceResolved) {
    throw new Error("安全校验拒绝：目标文件夹就是工作区根目录本身");
  }
  const parentResolved = await canonicalize(dirname(folderResolved));
  if (parentResolved !== workspaceResolved) {
    throw new Error(
      "安全校验拒绝：目标文件夹不在工作区根目录的正下方 " +
        JSON.stringify(folderResolved) + " (parent=" + JSON.stringify(parentResolved) + ")"
    );
  }
  return { folderResolved, workspaceResolved };
}

/** 在工作区下创建会话文件夹（若已存在则幂等返回）。 */
export async function ensureFolder(folder) {
  if (typeof folder !== "string" || folder === "") {
    throw new Error("无法创建空的文件夹路径");
  }
  await mkdir(folder, { recursive: true });
  const info = await lstat(await realpath(folder));
  if (info.isFile()) throw new Error("目标路径已存在且是文件: " + folder);
  return folder;
}

/** 递归清除只读属性（Windows 上只读文件会导致 rm 失败）。 */
export async function clearReadonlyTree(root) {
  let info;
  try {
    info = await lstat(root);
  } catch {
    return; // 已不存在则无需处理
  }
  try {
    await chmod(root, 0o666);
  } catch { /* 尽力而为 */ }
  if (info.isDirectory()) {
    let children;
    try {
      children = await readdir(root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const child of children) {
      try {
        await clearReadonlyTree(join(root, child.name));
      } catch { /* 尽量继续清理其余子项 */ }
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 带完整安全校验的"彻底删除"。entry 形如：
 *   { sessionId, workspacePath, folder }
 * 只有当 realpath(folder) 的父目录 === realpath(workspacePath)（Windows 大小写、
 * 分隔符、8.3 短名均已由 realpath 归一）时才执行递归删除：
 *   1) 递归清除只读属性（Windows）；
 *   2) rm -rf（force + recursive，不过回收站，属彻底删除）；
 *   3) 校验目标确已消失，否则重试最多 3 次。
 */
export async function removeFolderIfSafe(entry) {
  if (entry === null || typeof entry !== "object") {
    throw new Error("安全校验拒绝：无效的映射记录");
  }
  const { folderResolved } = await assertSafeFolderTarget(entry.folder, entry.workspacePath);
  await clearReadonlyTree(folderResolved);
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await rm(folderResolved, { recursive: true, force: true });
      await realpath(folderResolved); // 若仍能解析说明没删干净
      lastError = new Error("删除后目标仍存在: " + folderResolved);
    } catch (error) {
      if (error.code === "ENOENT") return folderResolved; // 已消失，删除成功
      lastError = error;
    }
    await sleep(300 * (attempt + 1));
  }
  throw lastError ?? new Error("删除失败: " + folderResolved);
}

/** 候选的磁盘会话目录名（主编码 + 原始 id，若二者不同）。 */
export function candidateSessionDirNames(sessionId) {
  const primary = encodeFsSessionSegment(sessionId);
  const names = [primary];
  if (sessionId !== primary) names.push(sessionId);
  return names;
}

/**
 * 判断某个会话的持久化产物（会话目录）是否仍存在于 DSH sessions 根目录下。
 * sessionsRoot 即 dshHome("sessions")。返回 true 表示产物仍在磁盘上。
 */
export async function sessionArtifactExists(sessionsRoot, sessionId) {
  if (typeof sessionsRoot !== "string" || sessionsRoot === "") return true; // 无法判断时保守返回 true
  if (typeof sessionId !== "string" || sessionId === "") return true;
  const candidates = candidateSessionDirNames(sessionId);
  let projects;
  try {
    projects = await readdir(sessionsRoot, { withFileTypes: true });
  } catch {
    return true; // 读不到根目录，保守返回 true（不删）
  }
  for (const proj of projects) {
    if (!proj.isDirectory() || proj.isSymbolicLink()) continue;
    let dirs;
    try {
      dirs = await readdir(join(sessionsRoot, proj.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of dirs) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      for (const candidate of candidates) {
        // Windows 文件名比较忽略大小写
        if (entry.name.toLowerCase() === candidate.toLowerCase()) return true;
      }
    }
  }
  return false;
}

/** 把任意路径解析为绝对路径（不要求存在）。 */
export function absolute(p) {
  return resolve(p);
}

export { join, resolve as resolvePath };