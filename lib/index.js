/**
 * dsh-conversation-folders — Host 半区（Cordis 插件）v0.5.1。
 *
 * 需求：
 *   1) 在已创建的工作区内进行对话时，自动为该会话开辟一个专属文件夹（优先用
 *      对话标题命名，标题未知时用短 ID），对话内容自动存档为 `对话记录.md`；
 *   2) 整理不打扰对话：对话进行中文件保持原样，只有会话「长时间空闲、没有新的
 *      任务」之后，才把散落文件（表格、图表、文档等）按类别分文件夹存放并自动
 *      命名（`调研<N>_<原文件名>`），同时把文件夹名更新为对话标题；
 *   3) 归档/改名不弄丢路径：归档后在原文件名处保留硬链接（同一份数据），
 *      文件夹改名后在旧短 ID 路径处保留目录联接，对话里点击旧文件链接依旧能
 *      直接打开；
 *   4) 删除该会话时，其文件夹及全部内容被彻底删除（不过回收站）；
 *   5) 输出目录：整理后把归档好的生产文件（`调研<N>_<原名>`）复制一份到
 *      `<输出目录>/<会话文件夹名>/`，方便直接提取成品；默认**不自动弹窗**，
 *      用户需要时通过侧栏面板「选择输出目录」按钮或 POST /pick-output-dir
 *      手动弹出系统目录选择框（chooseOutputDir 默认开，弹窗不阻塞正在进行的
 *      对话）；想恢复「对话第一次开始自动弹」可设 autoPromptOutputDir: true；
 *      删除会话时该副本一并彻底删除。
 *
 * 实现要点：
 *   - 惰性分配：会话创建（含空白占位）时不建文件夹，等第一条消息或回合
 *     开始（turn/start、user/message）才创建文件夹，避免"新建即占坑"；
 *   - 不修改不可变的 header.cwd，而是追加一条持久化的
 *     `working-directory/change` 会话事件：DSH 的 workingDirectory 投影
 *     （工具与系统提示的工作目录来源）会折叠该事件，把工作目录指向文件夹，
 *     会话产生的所有文件自然落在文件夹里；事件随日志持久化，重启仍生效；
 *   - 对话记录：监听 session/event 的 user/message、assistant/message，
 *     渲染成 markdown 追加写入（按会话串行化，带文件头）；
 *   - 空闲整理：每条会话事件都把该会话的"空闲计时器"重置，连续 idleDelayMs
 *     没有任何事件、且最后一回合已结束（turn/end 在最后）时，才执行
 *     分类归档；进行中的回合（last turn event 不是 turn/end）只重新计时；
 *   - 文件夹命名：分配时若对话标题已存在则直接用标题；否则先用短 ID 命名，
 *     等空闲整理时标题已就绪（sessionTitle 服务）再重命名文件夹（一次性，
 *     只从短 ID 名改为标题名），并追加 working-directory/change 指向新路径；
 *   - 删除检测：session/disposed 后轮询（默认最长 12 秒）等待会话持久化产物
 *     从磁盘消失——消失了才是真正的"删除会话"，此时才彻底删除文件夹；
 *     只是停止/关机则产物仍在，文件夹保留；
 *   - 所有删除动作都经过 assertSafeFolderTarget 校验（目标必须直接位于
 *     工作区根目录正下方、是普通目录、非符号链接），杜绝误删；
 *     Windows 上先递归清除只读属性再 rm，确保"彻底删除"。
 */
import { appendFile, copyFile, lstat, mkdir, readdir, realpath, rename, rm, unlink } from "node:fs/promises";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  absolute,
  candidateSessionDirNames,
  canonicalize,
  clearReadonlyTree,
  createJunction,
  ensureFolder,
  folderNameFor,
  folderNameFromTitle,
  isLinkLike,
  linkOrCopy,
  pathExists,
  removeFolderIfSafe,
  removeJunction,
  sanitizeFolderBase,
  sessionArtifactExists
} from "./fs-helpers.js";
import { createStateStore } from "./state-store.js";
import {
  autoNameFor,
  capFileName,
  classifyFileName,
  isAlreadyNamed,
  mergeCategories,
  splitName
} from "./organize.js";
import {
  renderAssistantSection,
  renderHeader,
  renderOrganizeSection,
  renderUserSection
} from "./transcript.js";

export const name = "dsh-conversation-folders";

/** 本包版本号（管理面板与「检查更新」显示用）。 */
const PLUGIN_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

/** 遥测用：GitHub 仓库的 main 分支 package.json（仅版本号）。 */
const UPDATE_MANIFEST_URL = "https://raw.githubusercontent.com/myqy91615-web/dsh-conversation-folders/main/package.json";

/** 比较 a.b.c 形式版本：a> b 返回 1，相等 0，小于 -1（非数字段视为 0）。 */
function compareVersions(left, right) {
  const parse = (value) => String(value).split(".").map((part) => {
    const number = Number.parseInt(part, 10);
    return Number.isFinite(number) ? number : 0;
  });
  const a = parse(left);
  const b = parse(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta > 0 ? 1 : -1;
  }
  return 0;
}

export const inject = [
  "sessions",
  "workspaceRegistry",
  "sessionProjections",
  "webServer"
];

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

/** 重命名目录；Windows 上遇到短暂占用（EBUSY/EPERM/EACCES）时退避重试。 */
async function renameWithRetry(from, to) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      lastError = error;
      const code = error?.code;
      if (code !== "EBUSY" && code !== "EPERM" && code !== "EACCES") throw error;
      if (attempt < 3) await sleep(250 * (attempt + 1));
    }
  }
  throw lastError;
}

/** 不阻止进程退出（应用关闭时删除轮询不拖延关机）。 */
const sleepUnref = (ms) => new Promise((resolveSleep) => {
  const timer = setTimeout(resolveSleep, ms);
  if (typeof timer.unref === "function") timer.unref();
});

/** 与 dsh-session-manager 相同的服务探测方式。 */
function getService(ctx, serviceName) {
  try {
    if (typeof ctx?.get === "function") {
      const value = ctx.get(serviceName);
      if (value !== undefined) return value;
    }
  } catch { /* ignore */ }
  try {
    return ctx && ctx[serviceName];
  } catch {
    return undefined;
  }
}

/** $DSH_HOME 为空则 ~/.dsh（与 dsh-home-paths 一致）。 */
function fallbackDshHome() {
  const raw = typeof process.env.DSH_HOME === "string" ? process.env.DSH_HOME.trim() : "";
  if (raw.length === 0) return resolve(join(homedir(), ".dsh"));
  const expanded = raw === "~" ? homedir() : raw.startsWith("~/") || raw.startsWith("~\\") ? join(homedir(), raw.slice(2)) : raw;
  return resolve(expanded);
}

/** 从 session/disposed 的各种入参形态中取出会话 id。 */
function sessionIdOf(subject) {
  if (typeof subject === "string") return subject;
  if (subject === null || typeof subject !== "object") return undefined;
  if (typeof subject.header?.id === "string") return subject.header.id;
  if (typeof subject.id === "string") return subject.id;
  return undefined;
}

function safeErrorMessage(error) {
  if (error === null || error === undefined) return "<nullish>";
  if (typeof error === "string") return error;
  if (typeof error?.message === "string" && error.message.length > 0) return error.message;
  try { return JSON.stringify(error); } catch { return String(error); }
}

/** 读取 JSON 请求体（上限 64KB）。 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        reject(new Error("请求体过大"));
        try { req.destroy(); } catch { /* ignore */ }
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text.length > 0 ? JSON.parse(text) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

/** 规范化配置里的名称（前缀 / 文件名）：剔除路径分隔符与非法字符，空则用默认值。 */
function normalizeNamePart(value, fallback) {
  if (typeof value !== "string") return fallback;
  const cleaned = value.trim().replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/[. ]+$/g, "");
  return cleaned.length > 0 ? cleaned : fallback;
}

/** 会话已在 DSH home 下有持久化产物（会话目录）即视为"未被删除"。 */
async function durableArtifactExists(homePath, sessionId) {
  try {
    return await sessionArtifactExists(homePath("sessions"), sessionId);
  } catch (error) {
    return true; // 无法判断时保守返回 true，避免误删文件夹
  }
}

export function apply(ctx, config) {
  const cfg = config ?? {};
  if (cfg.enabled === false) {
    ctx.logger?.info?.("dsh-conversation-folders: disabled by config");
    return;
  }

  const homePathService = getService(ctx, "dshHomePath");
  const homePath = (...segments) => (typeof homePathService === "function"
    ? homePathService(...segments)
    : join(fallbackDshHome(), ...segments));

  // ====== 激活标记（诊断/验证用，不参与业务逻辑） ======
  const applyLogPath = join(homePath("conversation-folders"), "applied.log");
  try {
    mkdirSync(dirname(applyLogPath), { recursive: true });
    appendFileSync(applyLogPath, new Date().toISOString() + " apply\n");
  } catch { /* never throw from diagnostics */ }

  const folderPrefix = normalizeNamePart(cfg.folderPrefix, "会话-");
  const transcriptName = normalizeNamePart(cfg.transcriptName, "对话记录.md");
  const runNamePrefix = normalizeNamePart(cfg.runNamePrefix, "调研");
  const categoryTable = mergeCategories(cfg.categories);

  /** 空闲多久后整理（毫秒）；0/false 关闭自动整理（仍可用 API 手动触发）。 */
  const DEFAULT_IDLE_DELAY_MS = 10 * 60 * 1000;
  const idleDisabled = cfg.idleDelayMs === 0 || cfg.idleDelayMs === false;
  const idleDelayMs = (() => {
    const raw = Number(cfg.idleDelayMs);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_IDLE_DELAY_MS;
  })();
  /** 是否允许把文件夹名改成对话标题（默认开启）。 */
  const renameToTitle = cfg.renameToTitle !== false;
  /**
   * 归档 / 改名后是否在原路径保留入口（默认开启）：
   *  - 文件归档进 01-表格/… 后在原文件名处留一个硬链接，对话里旧的相对/绝对路径
   *    依旧能点开（硬链接与归档文件是同一份数据，不占额外空间）；
   *  - 文件夹按标题改名后，在旧短 ID 路径处留一个目录联接（junction），
   *    对话里旧文件夹的绝对路径依旧能解析到文件。
   */
  const keepPaths = cfg.keepPaths !== false;
  /**
   * 输出目录功能开关（默认开）：整理后把生产文件复制到用户选的输出目录。
   * 弹窗默认**不自动弹**（autoPromptOutputDir 默认 false）——用户需要时
   * 通过侧栏面板「选择输出目录」按钮或 POST /pick-output-dir 手动触发；
   * 想要「对话第一次开始自动弹」可把 autoPromptOutputDir 设为 true。
   */
  const chooseOutputDir = cfg.chooseOutputDir !== false;
  /** 是否在对话第一次开始时自动弹出目录选择框（默认 false：不自动弹）。 */
  const autoPromptOutputDir = cfg.autoPromptOutputDir === true;
  /** 正在弹出目录选择框的会话（防重入）。 */
  const outputPrompting = new Set();

  /** 取目录选择服务（原生选择能力）；没有或不可用时返回 null。 */
  function nativeDirectoryPicker() {
    try {
      const picker = getService(ctx, "directoryPicker");
      const capability = typeof picker?.capability === "function" ? picker.capability() : undefined;
      if (capability?.kind === "native" && typeof capability.pick === "function") {
        return capability;
      }
    } catch { /* 服务未启用时静默跳过 */ }
    return null;
  }

  /**
   * 输出目录能否使用：必须是绝对路径，且不能等于会话文件夹或其内部
   * （否则导出的副本会被下一次整理再归档，造成自复制）。
   */
  async function outputDirUsable(sessionId, dir) {
    const entry = store.get(sessionId);
    if (entry === undefined || typeof dir !== "string" || dir.trim().length === 0) return false;
    const output = resolve(dir);
    const folder = absolute(entry.folder);
    if (output === folder || output.startsWith(folder + "\\") || output.startsWith(folder + "/")) return false;
    try {
      await mkdir(output, { recursive: true });
      return true;
    } catch {
      return false;
    }
  }

  /** 给会话设置输出目录并落盘（返回最终值；不可用返回 null）。 */
  async function applyOutputDir(sessionId, dir) {
    const entry = store.get(sessionId);
    if (entry === undefined) return null;
    if (!(await outputDirUsable(sessionId, dir))) return null;
    const output = resolve(dir);
    entry.outputDir = output;
    if (!Array.isArray(entry.outputFolders)) entry.outputFolders = [];
    await store.set(sessionId, entry);
    ctx.logger?.info?.("dsh-conversation-folders: 会话 " + sessionId + " 输出目录 -> " + output);
    return output;
  }

  /**
   * 为会话弹出一次原生目录选择框，把用户选中的目录设为该会话的输出目录，
   * 之后每次整理都把生产文件复制过去。已提示过的会话（outputPromoted 置位）
   * 不会重复弹；需要重弹时先重置 outputPromoted（见 POST /pick-output-dir）。
   * 默认不自动调用——由 autoPromptOutputDir 控制是否在对话第一次开始时自动弹，
   * 其余情况由面板按钮 / 接口手动触发；不阻塞任何流程。
   */
  async function maybePromptOutputDir(sessionId) {
    if (!chooseOutputDir || outputPrompting.has(sessionId)) return;
    const entry = store.get(sessionId);
    if (entry === undefined || entry.outputPromoted === true) return;
    const picker = nativeDirectoryPicker();
    if (picker === null) return;
    outputPrompting.add(sessionId);
    entry.outputPromoted = true; // 先置位：选择框挂起期间也不再弹
    try {
      await store.set(sessionId, entry);
      let signal;
      try {
        signal = AbortSignal.timeout(10 * 60 * 1000);
      } catch {
        signal = undefined; // 老 Node 无 AbortSignal.timeout
      }
      let picked = null;
      try {
        picked = await picker.pick(signal);
      } catch { /* 用户取消或超时 */ }
      if (typeof picked === "string" && picked.trim().length > 0) {
        await applyOutputDir(sessionId, picked.trim());
      }
    } catch (error) {
      ctx.logger?.warn?.("dsh-conversation-folders: 选择输出目录失败 " + sessionId + ": " + safeErrorMessage(error));
    } finally {
      outputPrompting.delete(sessionId);
    }
  }

  /**
   * 把整理好的生产文件复制到 `<输出目录>/<会话文件夹名>/`（幂等：已存在跳过）。
   * 返回 { dir, copied }。没有设置输出目录时返回 { dir: null, copied: 0 }。
   */
  async function exportOutputs(entry) {
    if (entry === undefined || typeof entry?.outputDir !== "string" || entry.outputDir.trim().length === 0) {
      return { dir: null, copied: 0 };
    }
    const folder = absolute(entry.folder);
    const output = resolve(entry.outputDir);
    if (output === folder || output.startsWith(folder + "\\") || output.startsWith(folder + "/")) {
      return { dir: output, copied: 0 }; // 输出目录在会话文件夹内部：跳过
    }
    const targetDir = join(output, entry.folderName ?? folderNameFor(entry.sessionId, folderPrefix));
    let copied = 0;
    try {
      await mkdir(targetDir, { recursive: true });
      const entries = await readdir(folder, { withFileTypes: true });
      for (const dir of entries) {
        if (!dir.isDirectory() || dir.isSymbolicLink() || dir.name.startsWith(".")) continue;
        let files = [];
        try {
          files = await readdir(join(folder, dir.name), { withFileTypes: true });
        } catch { continue; }
        for (const file of files) {
          if (!file.isFile()) continue;
          if (!file.name.startsWith(runNamePrefix)) continue; // 只复制整理归档的生产文件
          const source = join(folder, dir.name, file.name);
          const dest = join(targetDir, file.name);
          if (existsSync(dest)) continue; // 幂等
          try {
            await copyFile(source, dest);
            copied += 1;
          } catch { /* 单个文件失败不中断 */ }
        }
      }
      const current = store.get(entry.sessionId);
      if (current !== undefined) {
        const subName = entry.folderName ?? folderNameFor(entry.sessionId, folderPrefix);
        const folders = Array.isArray(current.outputFolders) ? current.outputFolders : [];
        if (!folders.includes(subName)) {
          folders.push(subName);
          current.outputFolders = folders;
          await store.set(entry.sessionId, current);
        }
      }
    } catch (error) {
      ctx.logger?.warn?.("dsh-conversation-folders: 复制到输出目录失败 " + entry.sessionId + ": " + safeErrorMessage(error));
    }
    if (copied > 0) {
      ctx.logger?.info?.("dsh-conversation-folders: " + entry.sessionId + " 已复制 " + copied + " 个生产文件到 " + targetDir);
    }
    return { dir: targetDir, copied };
  }

  /** 删除该会话在输出目录里的副本（插件自己创建的 `<输出目录>/<会话文件夹名>`）。 */
  async function removeOutputCopies(entry) {
    if (entry === undefined || typeof entry?.outputDir !== "string" || entry.outputDir.trim().length === 0) return;
    const outputRoot = resolve(entry.outputDir);
    let rootReal;
    try {
      rootReal = await realpath(outputRoot);
    } catch { return; } // 输出目录本身已不存在
    const names = new Set(Array.isArray(entry.outputFolders) ? entry.outputFolders : []);
    if (typeof entry.folderName === "string" && entry.folderName.length > 0) names.add(entry.folderName);
    for (const name of names) {
      if (typeof name !== "string" || name.length === 0) continue;
      const target = join(rootReal, name);
      try {
        const targetReal = await realpath(target);
        // 必须直接位于输出目录下（防止路径穿越）
        if (dirname(targetReal) !== rootReal) continue;
        const info = await lstat(targetReal);
        if (!info.isDirectory() || info.isSymbolicLink()) continue;
        await clearReadonlyTree(targetReal);
        await rm(targetReal, { recursive: true, force: true, maxRetries: 2 });
        ctx.logger?.info?.("dsh-conversation-folders: 已删除输出目录副本 " + targetReal);
      } catch { /* 不存在或删除失败则忽略 */ }
    }
  }

  /** 视为"回合内事件"的类型：用它们判断最后一回合是否已经结束。 */
  const TURN_EVENT_TYPES = new Set([
    "turn/start", "turn/end", "step/start", "step/end",
    "user/message", "developer/message", "system/message",
    "assistant/message", "assistant/attempt",
    "tool/call", "tool/result",
    "request/header", "request/context"
  ]);

  const sessions = getService(ctx, "sessions");
  const registry = getService(ctx, "workspaceRegistry");
  const projections = getService(ctx, "sessionProjections");
  const webServer = getService(ctx, "webServer");

  const stateFile = join(homePath("conversation-folders"), "state.v1.json");
  const store = createStateStore(stateFile);

  /** 会话级单飞，防并发重复分配。 */
  const inflight = new Map();

  /** 会话级串行写队列（对话记录）。 */
  const appendQueues = new Map();

  /** 会话级单飞（调研归档）。 */
  const categorizeInflight = new Map();

  /** 已写进对话记录的最大事件 seq（防回填/迟到事件重复）。 */
  const writeSeqs = new Map();

  /** 旧路径保活的实现（在会话事件区赋值；organizeNow 与 HTTP API 复用）。 */
  let ensurePathEntries = null;

  /** 会话级空闲整理计时器（任何会话事件都会重置）。 */
  const idleTimers = new Map();

  /** 正在整理的会话（防重入）。 */
  const idleOrganizing = new Map();

  /** 清除某会话的空闲计时器。 */
  function clearIdleTimer(sessionId) {
    const timer = idleTimers.get(sessionId);
    if (timer !== undefined) {
      clearTimeout(timer);
      idleTimers.delete(sessionId);
    }
  }

  /** 会话映射被清理后，同步丢弃内存状态。 */
  function forget(sessionId) {
    writeSeqs.delete(sessionId);
    appendQueues.delete(sessionId);
    clearIdleTimer(sessionId);
    idleOrganizing.delete(sessionId);
  }

  /** 读取会话当前标题（sessionTitle 服务；不可用时返回 undefined）。 */
  function sessionTitleOf(session) {
    try {
      const service = getService(ctx, "sessionTitle");
      if (typeof service?.get === "function") {
        const snapshot = service.get(session);
        const title = snapshot?.title;
        if (typeof title === "string" && title.trim().length > 0) return title.trim();
      }
    } catch { /* 标题服务不可用时退回短 ID 命名 */ }
    return undefined;
  }

  /**
   * 最后一回合是否已结束：从会话事件末尾往回找第一条"回合内事件"，
   * 若它是 turn/end（或根本没有回合事件）则视为已结束；
   * 正在进行中的回合（最后是 assistant/tool/user 等）返回 false。
   */
  function lastTurnSettled(session) {
    const events = sessionEventsOf(session);
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const type = events[i]?.type;
      if (typeof type !== "string" || !TURN_EVENT_TYPES.has(type)) continue;
      return type === "turn/end";
    }
    return events.length === 0 ? false : true;
  }

  /** 找出 header.cwd 所归属的工作区（按 realpath 规范化后精确等于工作区路径）。 */
  async function owningWorkspaceOf(cwd) {
    if (typeof cwd !== "string" || cwd === "") return undefined;
    if (registry === undefined || typeof registry.list !== "function") {
      return undefined;
    }
    const canonical = await canonicalize(cwd);
    if (canonical === undefined) return undefined;
    let entities;
    try {
      entities = registry.list();
    } catch {
      return undefined;
    }
    if (!Array.isArray(entities)) return undefined;
    for (const entity of entities) {
      const entityPath = await canonicalize(entity?.path);
      if (entityPath !== undefined && entityPath === canonical) {
        return entity;
      }
    }
    return undefined;
  }

  /**
   * 读取当前 workingDirectory 投影状态；不可用时返回 undefined。
   */
  function currentWorkingDirectory(session) {
    try {
      if (typeof projections?.stateOf === "function") {
        const state = projections.stateOf(session, "workingDirectory");
        return typeof state === "string" ? state : undefined;
      }
    } catch { /* ignore */ }
    return undefined;
  }

  /**
   * 核心：为会话分配专属文件夹并把工作目录指过去。
   * - 已分配：确保文件夹与投影就位（幂等，用于 resumed 会话）；
   * - 未分配：首次使用时创建文件夹 + 追加 working-directory/change 事件。
   * 注意：必须在事件分发结束后的微任务中执行 append（并发分发期间禁止重入）。
   */
  async function ensureFolderFor(session, options = {}) {
    const id = sessionIdOf(session);
    if (id === undefined) return { assigned: false, reason: "no-id" };
    const header = session?.header ?? session;
    if (header?.origin === "subagent") return { assigned: false, reason: "subagent" };

    const existing = store.get(id);
    const sessionObj = typeof sessions?.get === "function" ? (sessions.get(id) ?? session) : session;

    if (existing !== undefined) {
      // 已分配：保证文件夹存在；若投影与文件夹不一致，追加一次修正事件。
      if (options.create === true || options.create === undefined) {
        try {
          await ensureFolder(existing.folder);
        } catch (error) {
          ctx.logger?.warn?.("dsh-conversation-folders: 重建文件夹失败 " + JSON.stringify(existing.folder) + ": " + safeErrorMessage(error));
        }
      }
      const current = currentWorkingDirectory(sessionObj);
      if (current !== existing.folder && typeof sessionObj?.append === "function") {
        try {
          await sleep(0); // 保证离开任何事件分发窗口
          sessionObj.append("working-directory/change", { cwd: existing.folder });
        } catch (error) {
          ctx.logger?.warn?.("dsh-conversation-folders: 重设工作目录失败 " + id + ": " + safeErrorMessage(error));
        }
      }
      return { assigned: true, reused: true, sessionId: id, folder: existing.folder };
    }

    // 懒分配：只有 header.cwd 恰好等于某个已注册工作区的根目录时才建文件夹。
    const cwd = typeof header?.cwd === "string" ? header.cwd : undefined;
    if (cwd === undefined) return { assigned: false, reason: "no-cwd" };
    const workspace = await owningWorkspaceOf(cwd);
    if (workspace === undefined) return { assigned: false, reason: "not-a-workspace-root" };

    const workspaceRoot = absolute(workspace.path);
    // 标题已就绪时直接用对话标题命名；否则先用短 ID，空闲整理时再改名。
    const knownTitle = renameToTitle ? sessionTitleOf(sessionObj) : undefined;
    let folderName = folderNameFor(id, folderPrefix);
    if (knownTitle !== undefined) {
      const candidate = folderNameFromTitle(knownTitle, id, folderPrefix);
      if (candidate !== folderName && !existsSync(join(workspaceRoot, candidate))) {
        folderName = candidate;
      }
    }
    const folder = join(workspaceRoot, folderName);
    // 防御：目标必须位于工作区根目录正下方（静态前缀校验，最终以 realpath 校验为准）
    if (!folder.startsWith(workspaceRoot + "\\") && !folder.startsWith(workspaceRoot + "/")) {
      return { assigned: false, reason: "unsafe-folder" };
    }

    try {
      await ensureFolder(folder);
    } catch (error) {
      ctx.logger?.warn?.("dsh-conversation-folders: 创建文件夹失败 " + JSON.stringify(folder) + ": " + safeErrorMessage(error));
      return { assigned: false, reason: "mkdir-failed" };
    }

    try {
      await sleep(0); // 离开 session/event 分发窗口再 append
      if (typeof sessionObj?.append !== "function") {
        throw new Error("session 没有可用的 append 接口");
      }
      sessionObj.append("working-directory/change", { cwd: folder });
    } catch (error) {
      ctx.logger?.warn?.("dsh-conversation-folders: 设置工作目录失败，回滚空文件夹 " + id + ": " + safeErrorMessage(error));
      try {
        const leftover = await readdir(folder).catch(() => []);
        if (leftover.length === 0) {
          await removeFolderIfSafe({ sessionId: id, workspacePath: workspaceRoot, folder });
        }
      } catch { /* best-effort; 文件夹可能已有内容则保留 */ }
      return { assigned: false, reason: "append-failed" };
    }

    const entry = {
      sessionId: id,
      workspaceId: workspace.id,
      workspacePath: workspaceRoot,
      folder,
      folderName,
      assignedAt: Date.now(),
      run: 0
    };
    await store.set(id, entry);
    ctx.logger?.info?.("dsh-conversation-folders: " + id + " -> " + folder);
    // 可选：对话第一次开始自动弹目录选择框（autoPromptOutputDir 开启时）；
    // 默认不自动弹——用户需要时通过面板按钮或 POST /pick-output-dir 手动触发
    if (autoPromptOutputDir) {
      void maybePromptOutputDir(id).catch(() => {});
    }
    return { assigned: true, sessionId: id, folder };
  }

  /** 带单飞的入口。 */
  function ensureFor(session) {
    const id = sessionIdOf(session);
    if (id === undefined) return Promise.resolve({ assigned: false, reason: "no-id" });
    const existingInflight = inflight.get(id);
    if (existingInflight !== undefined) return existingInflight;
    const task = (async () => {
      try {
        return await ensureFolderFor(session);
      } finally {
        inflight.delete(id);
      }
    })();
    inflight.set(id, task);
    return task;
  }

  /* ---------------- 对话记录（transcript） ---------------- */

  /** 会话的已落盘事件数组（live Session 的 log；兼容仅有 events 的宿主）。 */
  function sessionEventsOf(session) {
    if (Array.isArray(session?.log)) return session.log;
    if (Array.isArray(session?.events)) return session.events;
    return [];
  }

  /** 一个会话事件对应的对话记录章节；非消息事件返回 null。 */
  function eventToSection(event) {
    if (event === null || typeof event !== "object") return null;
    if (event.type === "user/message") {
      const kind = event.data?.source?.kind;
      // 跳过 runtime-context / skill-catalog / time-context 等合成消息，只记录真实用户输入
      if (kind !== undefined && kind !== "user") return null;
      return renderUserSection(event.data, event.time);
    }
    if (event.type === "assistant/message") {
      return renderAssistantSection(event.data, event.time);
    }
    return null;
  }

  /**
   * 写入对话记录：
   *  - 文件不存在（首次分配 / 插件较晚启用 / 记录被删除）→ 用会话已落盘的全部事件
   *    重建记录（含此前对话回填），再补上当前事件对应的章节；
   *  - 文件已存在 → 只追加当前章节。
   * 按会话串行化，避免并发写交错。
   */
  function writeTranscriptEvent(session, event, sectionText) {
    const id = sessionIdOf(session);
    if (id === undefined) return Promise.resolve();
    const entry = store.get(id);
    if (entry === undefined) return Promise.resolve();
    const file = join(entry.folder, transcriptName);
    const previous = appendQueues.get(id) ?? Promise.resolve();
    const next = previous.then(async () => {
      await mkdir(dirname(file), { recursive: true });
      if (!existsSync(file)) {
        const startedAt = typeof session?.header?.createdAt === "number" ? session.header.createdAt : Date.now();
        const parts = [renderHeader(id, entry.workspacePath, startedAt)];
        let lastSeq = -1;
        try {
          const events = sessionEventsOf(session);
          let included = false;
          let hadPrior = false;
          for (const ev of events) {
            if (typeof event?.seq === "number" && typeof ev?.seq === "number" && ev.seq > event.seq) break;
            const section = eventToSection(ev);
            if (section !== null) {
              parts.push(section);
              included = true;
              if (typeof event?.seq === "number" && typeof ev?.seq === "number" && ev.seq < event.seq) hadPrior = true;
            }
            if (typeof ev?.seq === "number") lastSeq = Math.max(lastSeq, ev.seq);
          }
          if (!included && sectionText !== undefined && sectionText !== null) {
            parts.push(sectionText);
          } else if (sectionText !== undefined && sectionText !== null && event?.type === "turn/end") {
            parts.push(sectionText);
          }
          if (hadPrior) parts.push("\n---\n（以上为此前对话回填；此后按调研回合归档）\n");
        } catch {
          // 回填失败时至少写入当前章节，保证记录可用
          if (sectionText !== undefined && sectionText !== null) parts.push(sectionText);
        }
        await appendFile(file, parts.join(""), "utf8");
        writeSeqs.set(id, Math.max(lastSeq, typeof event?.seq === "number" ? event.seq : -1));
      } else {
        if (sectionText !== undefined && sectionText !== null) await appendFile(file, sectionText, "utf8");
        if (typeof event?.seq === "number") writeSeqs.set(id, event.seq);
      }
    }).catch((error) => {
      ctx.logger?.warn?.("dsh-conversation-folders: 对话记录写入失败 " + id + ": " + safeErrorMessage(error));
    });
    appendQueues.set(id, next);
    return next;
  }

  async function transcribeUser(session, event) {
    if (cfg.transcriptName === false) return;
    const id = sessionIdOf(session);
    if (id === undefined) return;
    if (typeof event?.seq === "number" && event.seq <= (writeSeqs.get(id) ?? -1)) return;
    const kind = event?.data?.source?.kind;
    if (kind !== undefined && kind !== "user") return; // 合成消息不记录
    const res = await ensureFor(session);
    if (!res.assigned) return;
    const text = renderUserSection(event?.data, event?.time ?? Date.now());
    if (text === null) return;
    await writeTranscriptEvent(session, event, text);
  }

  async function transcribeAssistant(session, event) {
    if (cfg.transcriptName === false) return;
    const id = sessionIdOf(session);
    if (id === undefined) return;
    if (typeof event?.seq === "number" && event.seq <= (writeSeqs.get(id) ?? -1)) return;
    const res = await ensureFor(session);
    if (!res.assigned) return;
    const text = renderAssistantSection(event?.data, event?.time ?? Date.now());
    if (text === null) return;
    await writeTranscriptEvent(session, event, text);
  }

  /* ---------------- 调研归档：分类 + 自动命名 ---------------- */

  /** 移动文件（重命名；被占用时降级为复制+删除）。 */
  async function moveWithRetry(source, target) {
    let lastError;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await mkdir(dirname(target), { recursive: true });
        await rename(source, target);
        return target;
      } catch (error) {
        lastError = error;
        if (attempt === 0) await sleep(400); // 文件可能正被 Excel/WPS 等占用
      }
    }
    // 降级：复制 + 删除源（复制成功但源删除失败时保留源，记警告）
    try {
      await mkdir(dirname(target), { recursive: true });
      await copyFile(source, target);
      await unlink(source).catch(() => {});
      return target;
    } catch (fallbackError) {
      throw fallbackError;
    }
  }

  /**
   * 把会话文件夹根目录的散落文件按类别归档并自动命名。
   * 返回 { run, moved }；moved 形如 [{ category, from, to }]。
   */
  async function categorizeSession(session, res) {
    const id = typeof res?.sessionId === "string" ? res.sessionId : sessionIdOf(session);
    const entry = store.get(id);
    if (entry === undefined || entry.folder !== res?.folder) return { run: 0, moved: [] };
    const previousRun = (Number.isFinite(entry.run) && entry.run > 0) ? entry.run : 0;
    const run = previousRun + 1;
    const folder = entry.folder;
    const moved = [];
    let dirEntries;
    try {
      dirEntries = await readdir(folder, { withFileTypes: true });
    } catch (error) {
      ctx.logger?.warn?.("dsh-conversation-folders: 扫描会话文件夹失败 " + id + ": " + safeErrorMessage(error));
      return { run: previousRun, moved };
    }
    const usedTargets = new Set(); // 小写比较：Windows 文件系统大小写不敏感
    // 旧路径入口表：原文件名 -> 归档后的相对路径（"01-表格/调研1_x.xlsx"）。
    // 保留这些入口后，对话里点击原来的路径依旧能打开文件。
    const links = { ...(entry.links ?? {}) };
    for (const ent of dirEntries) {
      if (!ent.isFile()) continue;                          // 只整理散落文件，目录不动
      if (ent.name === transcriptName) continue;            // 对话记录保留在根目录
      if (ent.name.startsWith(".")) continue;               // 隐藏文件不动
      if (links[ent.name] !== undefined) {                  // 已归档文件的旧路径入口
        if (existsSync(join(folder, links[ent.name]))) continue;
        delete links[ent.name];                             // 归档文件已不在：当作普通文件重新处理
      }
      if (isAlreadyNamed(ent.name, runNamePrefix)) continue; // 已归档命名的不再移动
      const category = classifyFileName(ent.name, categoryTable);
      const { stem, ext } = splitName(ent.name);
      const base = autoNameFor(run, stem, runNamePrefix);
      let targetName = capFileName(base + ext);
      let counter = 2;
      while (
        usedTargets.has(targetName.toLowerCase()) ||
        existsSync(join(folder, category, targetName))
      ) {
        targetName = capFileName(base + "_" + counter + ext);
        counter += 1;
      }
      usedTargets.add(targetName.toLowerCase());
      try {
        await moveWithRetry(join(folder, ent.name), join(folder, category, targetName));
        moved.push({ category, from: ent.name, to: targetName });
        if (keepPaths) {
          // 在原文件名处留一个硬链接：对话里点击旧路径（相对或绝对）依旧能打开。
          const linked = await linkOrCopy(join(folder, category, targetName), join(folder, ent.name));
          if (linked === "link" || linked === "copy" || linked === "exists") {
            links[ent.name] = category + "/" + targetName;
          } else {
            ctx.logger?.warn?.("dsh-conversation-folders: 保留旧路径失败 " + id + "/" + ent.name);
          }
        }
      } catch (error) {
        ctx.logger?.warn?.("dsh-conversation-folders: 归档失败 " + id + "/" + ent.name + ": " + safeErrorMessage(error));
      }
    }
    if (Object.keys(links).length > 0 || entry.links !== undefined) {
      entry.links = links;
    }
    if (moved.length === 0) {
      // 没有新文件可归档：不推进调研编号，避免空整理把序号吃掉。
      if (entry.links !== undefined) await store.set(id, entry);
      return { run: previousRun, moved };
    }
    entry.run = run;
    await store.set(id, entry);
    ctx.logger?.info?.("dsh-conversation-folders: " + id + " 调研 " + run + " 归档 " + moved.length + " 个文件");
    return { run, moved };
  }

  /** 带单飞的调研归档入口。 */
  function categorizeFor(session, res) {
    const id = typeof res?.sessionId === "string" ? res.sessionId : sessionIdOf(session);
    if (id === undefined) return Promise.resolve({ run: 0, moved: [] });
    const existing = categorizeInflight.get(id);
    if (existing !== undefined) return existing;
    const task = (async () => {
      try {
        return await categorizeSession(session, res);
      } finally {
        categorizeInflight.delete(id);
      }
    })();
    categorizeInflight.set(id, task);
    return task;
  }

  /* ---------------- 空闲整理：长时间无新任务后才分类归档 ---------------- */

  /** 追加一段整理小结到对话记录（走会话串行写队列）。 */
  function appendTranscriptText(session, text) {
    const id = sessionIdOf(session);
    if (id === undefined) return Promise.resolve();
    const entry = store.get(id);
    if (entry === undefined) return Promise.resolve();
    const file = join(entry.folder, transcriptName);
    const previous = appendQueues.get(id) ?? Promise.resolve();
    const next = previous.then(async () => {
      await mkdir(dirname(file), { recursive: true });
      await appendFile(file, text, "utf8");
    }).catch((error) => {
      ctx.logger?.warn?.("dsh-conversation-folders: 对话记录写入失败 " + id + ": " + safeErrorMessage(error));
    });
    appendQueues.set(id, next);
    return next;
  }

  /**
   * 若文件夹还是短 ID 命名、而对话标题已经可用，则把文件夹改名为
   * `<前缀><标题>`；只改一次（之后标题再变化也不再移动文件，
   * 避免已经展示过的文件链接反复失效）。
   * `diag.error` 会记录重命名失败原因，方便 /organize-session 排查。
   */
  async function renameFolderToTitle(session, entry, diag) {
    if (!renameToTitle) return entry;
    if (entry.folderName !== folderNameFor(entry.sessionId, folderPrefix)) return entry;
    const title = sessionTitleOf(session);
    if (title === undefined) return entry;
    const base = sanitizeFolderBase(title);
    if (base === null) return entry;
    const folderName = folderPrefix + base;
    if (folderName === entry.folderName) return entry;
    const workspaceRoot = absolute(entry.workspacePath);
    const folder = join(workspaceRoot, folderName);
    if (folder === entry.folder) return entry;
    if (existsSync(folder)) {
      ctx.logger?.warn?.("dsh-conversation-folders: 标题命名的文件夹已存在，保留原文件夹名 " + JSON.stringify(folder));
      return entry;
    }
    try {
      await renameWithRetry(entry.folder, folder);
    } catch (error) {
      const reason = safeErrorMessage(error);
      if (diag !== undefined) diag.error = reason;
      ctx.logger?.warn?.("dsh-conversation-folders: 文件夹按标题重命名失败（可能被占用）" + entry.sessionId + ": " + reason);
      return entry;
    }
    // 旧短 ID 路径留一个目录联接：对话里旧文件夹的绝对路径依旧能解析到文件。
    const aliases = Array.isArray(entry.aliases) ? [...entry.aliases] : [];
    if (keepPaths) {
      const created = await createJunction(folder, entry.folder);
      if (created === "created") {
        aliases.push(entry.folder);
      } else if (created === "failed") {
        ctx.logger?.warn?.("dsh-conversation-folders: 旧路径联接创建失败 " + JSON.stringify(entry.folder));
      }
    }
    const updated = { ...entry, folder, folderName, aliases };
    await store.set(entry.sessionId, updated);
    try {
      await sleep(0);
      if (typeof session?.append === "function") {
        session.append("working-directory/change", { cwd: folder });
      }
    } catch (error) {
      ctx.logger?.warn?.("dsh-conversation-folders: 重命名后更新工作目录失败 " + entry.sessionId + ": " + safeErrorMessage(error));
    }
    ctx.logger?.info?.("dsh-conversation-folders: 文件夹已按对话标题命名 -> " + folder);
    return updated;
  }

  /**
   * 立即整理一个会话：先（必要时）按对话标题重命名文件夹，再分类归档，
   * 最后把整理结果写进对话记录。返回 { run, moved, renamed, renameError }。
   */
  async function organizeNow(session) {
    const id = sessionIdOf(session);
    if (id === undefined) return { run: 0, moved: [], renamed: false, renameError: null };
    const res = await ensureFor(session);
    if (!res.assigned) return { run: 0, moved: [], renamed: false, renameError: null };
    const before = store.get(id);
    if (before === undefined) return { run: 0, moved: [], renamed: false, renameError: null };
    let entry = before;
    let renamed = false;
    const diag = {};
    try {
      const updated = await renameFolderToTitle(session, entry, diag);
      if (updated !== entry) {
        entry = updated;
        renamed = true;
      }
    } catch (error) {
      diag.error = safeErrorMessage(error);
      ctx.logger?.warn?.("dsh-conversation-folders: 按标题重命名失败 " + id + ": " + diag.error);
    }
    let report = { run: Number.isFinite(entry.run) && entry.run > 0 ? entry.run : 0, moved: [] };
    if (cfg.categorize !== false) {
      report = await categorizeFor(session, { sessionId: id, folder: entry.folder });
    }
    // 补齐旧路径入口（改名后的旧文件夹联接、归档文件的原名硬链接），
    // 让对话里已经展示过的文件路径依旧可以直接点开。
    if (ensurePathEntries !== null) {
      try {
        const repaired = await ensurePathEntries(entry);
        if (repaired !== undefined) entry = repaired;
      } catch (error) {
        ctx.logger?.warn?.("dsh-conversation-folders: 旧路径保活失败 " + id + ": " + safeErrorMessage(error));
      }
    }
    // 有输出目录时，把整理归档好的生产文件复制一份过去（幂等）。
    let output = { dir: null, copied: 0 };
    if (entry.outputDir !== undefined && entry.outputDir !== null) {
      try {
        output = await exportOutputs(entry);
      } catch (error) {
        ctx.logger?.warn?.("dsh-conversation-folders: 输出目录复制失败 " + id + ": " + safeErrorMessage(error));
      }
    }
    if ((renamed || report.moved.length > 0 || output.copied > 0) && cfg.transcriptName !== false) {
      const section = renderOrganizeSection(
        report.run,
        report.moved,
        Date.now(),
        {
          folderName: renamed ? entry.folderName : undefined,
          outputDir: output.copied > 0 ? output.dir : undefined,
          outputCopied: output.copied
        }
      );
      await appendTranscriptText(session, section);
    }
    return {
      run: report.run,
      moved: report.moved,
      renamed,
      renameError: diag.error ?? null,
      outputDir: output.dir,
      outputCopied: output.copied
    };
  }

  /** 真正的空闲整理入口（防重入）；回合未结束时重新计时。 */
  async function runIdleOrganize(sessionId) {
    if (idleOrganizing.has(sessionId)) return;
    const live = typeof sessions?.get === "function" ? sessions.get(sessionId) : undefined;
    if (live === undefined) return;
    const entry = store.get(sessionId);
    if (entry === undefined) return;
    if (!lastTurnSettled(live)) {
      scheduleIdle(live); // 还有进行中的回合：继续等
      return;
    }
    const task = (async () => {
      try {
        await organizeNow(live);
      } catch (error) {
        ctx.logger?.warn?.("dsh-conversation-folders: 空闲整理失败 " + sessionId + ": " + safeErrorMessage(error));
      } finally {
        idleOrganizing.delete(sessionId);
      }
    })();
    idleOrganizing.set(sessionId, task);
    await task;
  }

  /** 重置该会话的空闲计时器（任何事件都会调用）。 */
  function scheduleIdle(session) {
    if (idleDisabled) return;
    const id = sessionIdOf(session);
    if (id === undefined || session?.header?.origin === "subagent") return;
    clearIdleTimer(id);
    const timer = setTimeout(() => {
      idleTimers.delete(id);
      void runIdleOrganize(id).catch(() => {});
    }, idleDelayMs);
    if (typeof timer.unref === "function") timer.unref();
    idleTimers.set(id, timer);
  }

  /* ---------------- 会话创建 / 首次使用 / 空闲触发整理 ---------------- */
  if (typeof ctx.on === "function") {
    ctx.on("session/created", (session) => {
      const id = sessionIdOf(session);
      if (id === undefined || session?.header?.origin === "subagent") return;
      if (!store.has(id)) return; // 未分配：等真正使用再说，避免空文件夹堆积
      void ensureFor(session).catch(() => {});
      scheduleIdle(session);
    });

    ctx.on("session/event", (session, event) => {
      const eventType = event?.type;
      const id = sessionIdOf(session);
      if (id === undefined || session?.header?.origin === "subagent") return;
      if (eventType === "turn/start" || eventType === "user/message") void ensureFor(session).catch(() => {});
      if (eventType === "user/message") void transcribeUser(session, event).catch(() => {});
      if (eventType === "assistant/message") void transcribeAssistant(session, event).catch(() => {});
      // 任何事件都重置空闲计时：等对话真正停下来、长时间没有新任务后才整理。
      scheduleIdle(session);
    });

    /* ---------------- 会话删除：彻底清理 ---------------- */
    ctx.on("session/disposed", (subject) => {
      const id = sessionIdOf(subject);
      if (id === undefined || !store.has(id)) return;
      void (async () => {
        try {
          // 先给删除方一点时间把会话产物移出磁盘；产物消失才是"真正删除"。
          // 期间会话若被重新打开（复活），循环会一直等到超时并放弃删除。
          await sleepUnref(typeof cfg.settleDelayMs === "number" ? cfg.settleDelayMs : 300);
          const deadline = Date.now() + (typeof cfg.deleteTimeoutMs === "number" ? cfg.deleteTimeoutMs : 12000);
          for (;;) {
            const live = typeof sessions?.get === "function" ? sessions.get(id) !== undefined : false;
            const artifactGone = !(await durableArtifactExists(homePath, id));
            if (!live && artifactGone) break;      // 会话确实被删除了
            if (Date.now() > deadline) return;     // 超时：会话仍在（停止/关机），保留文件夹
            await sleepUnref(250);
          }
          const entry = store.get(id);
          if (entry === undefined) return;
          for (const alias of Array.isArray(entry.aliases) ? entry.aliases : []) {
            try { await removeJunction(alias); } catch { /* 联接已不在则忽略 */ }
          }
          await removeFolderIfSafe(entry);         // 彻底删除：不过回收站
          await removeOutputCopies(entry);         // 输出目录里的副本一并删除
          await store.remove(id);
          forget(id);
          ctx.logger?.info?.("dsh-conversation-folders: 已彻底删除会话 " + id + " 的文件夹 " + JSON.stringify(entry.folder));
        } catch (error) {
          ctx.logger?.warn?.("dsh-conversation-folders: 会话 " + id + " 清理失败: " + safeErrorMessage(error));
          // 文件夹/工作区已被手动删除时，映射也不应永留：直接清掉
          try {
            const entry = store.get(id);
            if (entry !== undefined && !existsSync(entry.folder)) {
              await store.remove(id);
              forget(id);
            }
          } catch { /* ignore */ }
        }
      })().catch(() => {});
    });

    /* ---------------- 启动对账：插件停用期间被删除的会话 ---------------- */

    /**
     * 旧路径保活（幂等，可反复执行）：
     *  1) 文件夹已按标题改名 → 补上旧短 ID 路径的目录联接（junction）；
     *  2) 已归档进分类目录的文件（`<前缀><N>_<原名>`）→ 根目录缺原名入口则补硬链接；
     *  3) 清掉已失效的联接与入口记录。
     * 这样即使归档发生在旧版本、或入口被误删，对话里点击旧路径也能恢复可打开。
     */
    ensurePathEntries = async function ensurePathEntriesImpl(entry) {
      if (!keepPaths) return entry;
      try {
        await realpath(entry.folder);
      } catch {
        return entry;
      }
      const workspaceRoot = absolute(entry.workspacePath);
      const aliases = [];
      const seen = new Set();
      for (const alias of Array.isArray(entry.aliases) ? entry.aliases : []) {
        if (typeof alias !== "string" || alias === "") continue;
        const key = alias.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        if (await isLinkLike(alias)) {
          try {
            await realpath(alias);           // 联接仍能解析到目标
            aliases.push(alias);
          } catch {
            await removeJunction(alias);     // 失效联接：清掉（文件夹若已改名会重建）
          }
          continue;
        }
        if (!(await pathExists(alias))) aliases.push(alias); // 记录在案、暂时不存在
      }
      // 文件夹现在是标题名：补上旧短 ID 名的目录联接（旧绝对路径仍可解析）。
      // 若该路径残留了真实目录（可能是改名前的孤儿空目录），先移除空目录再建联接。
      const defaultName = folderNameFor(entry.sessionId, folderPrefix);
      if (entry.folderName !== defaultName) {
        const defaultPath = join(workspaceRoot, defaultName);
        if (await pathExists(defaultPath)) {
          const info = await lstat(defaultPath).catch(() => undefined);
          if (info !== undefined && !info.isSymbolicLink() && info.isDirectory()) {
            try {
              const kids = await readdir(defaultPath);
              if (kids.length === 0) await rm(defaultPath, { recursive: true, force: true });
            } catch { /* 非空或删除失败：保持原样，避免误删用户数据 */ }
          }
        }
        if (!(await pathExists(defaultPath))) {
          const created = await createJunction(entry.folder, defaultPath);
          if (created === "created") aliases.push(defaultPath);
        }
      }
      // 已归档文件：根目录缺原名入口则补硬链接
      const links = { ...(entry.links ?? {}) };
      let dirEntries = [];
      try {
        dirEntries = await readdir(entry.folder, { withFileTypes: true });
      } catch {
        dirEntries = [];
      }
      for (const dir of dirEntries) {
        if (!dir.isDirectory() || dir.isSymbolicLink()) continue;
        if (dir.name === ".." || dir.name.startsWith(".")) continue;
        let files = [];
        try {
          files = await readdir(join(entry.folder, dir.name), { withFileTypes: true });
        } catch {
          continue;
        }
        for (const file of files) {
          if (!file.isFile()) continue;
          if (!file.name.startsWith(runNamePrefix)) continue;
          const match = /^(\d+)_(.+)$/.exec(file.name.slice(runNamePrefix.length));
          if (match === null) continue;
          const original = match[2];
          if (original === "" || original === transcriptName) continue;
          const relative = dir.name + "/" + file.name;
          const rootPath = join(entry.folder, original);
          if (existsSync(rootPath)) {
            // 原路径入口已在：只补记录（保留已有映射，不覆盖）
            if (links[original] === undefined) links[original] = relative;
            continue;
          }
          const linked = await linkOrCopy(join(entry.folder, relative), rootPath);
          if (linked === "link" || linked === "copy") {
            links[original] = relative;
          }
        }
      }
      // 清掉指向已不存在文件的入口记录
      for (const [original, relative] of Object.entries(links)) {
        if (!existsSync(join(entry.folder, relative))) delete links[original];
      }
      const changed =
        JSON.stringify(aliases) !== JSON.stringify(Array.isArray(entry.aliases) ? entry.aliases : []) ||
        JSON.stringify(links) !== JSON.stringify(entry.links ?? {});
      if (!changed) return entry;
      const updated = { ...entry, aliases, links };
      await store.set(entry.sessionId, updated);
      return updated;
    };

    const reconcile = async () => {
      try {
        for (const entry of store.all()) {
          if (await durableArtifactExists(homePath, entry.sessionId)) {
            // 会话还在，但文件夹被手动删了 → 清理映射，下次使用时重新分配
            try {
              await realpath(entry.folder);
            } catch {
              await store.remove(entry.sessionId);
              continue;
            }
            try {
              await ensurePathEntries(entry);
            } catch (error) {
              ctx.logger?.warn?.("dsh-conversation-folders: 旧路径保活失败 " + entry.sessionId + ": " + safeErrorMessage(error));
            }
            continue;
          }
          for (const alias of Array.isArray(entry.aliases) ? entry.aliases : []) {
            try { await removeJunction(alias); } catch { /* 联接已不在则忽略 */ }
          }
          try {
            await removeFolderIfSafe(entry);
            await removeOutputCopies(entry); // 输出目录副本一并清理
            await store.remove(entry.sessionId);
            forget(entry.sessionId);
            ctx.logger?.info?.("dsh-conversation-folders: 对账清理 " + entry.sessionId + " 的文件夹 " + JSON.stringify(entry.folder));
          } catch (error) {
            ctx.logger?.warn?.("dsh-conversation-folders: 对账清理失败 " + entry.sessionId + ": " + safeErrorMessage(error));
            if (!existsSync(entry.folder)) {
              try {
                await store.remove(entry.sessionId);
                forget(entry.sessionId);
              } catch { /* ignore */ }
            }
          }
        }
      } catch (error) {
        ctx.logger?.warn?.("dsh-conversation-folders: 启动对账失败: " + safeErrorMessage(error));
      }
    };
    if (ctx.on("ready", () => { void reconcile(); })) {
      // ready 钩子挂载成功
    } else {
      setTimeout(() => { void reconcile(); }, 1500);
    }
  }

  /* ---------------- 删除对话及其全部内容（由会话菜单触发） ---------------- */

  /** 在 sessions 根目录下找出该会话的持久化产物目录（可能位于任一工作区分组下）。 */
  async function findSessionArtifactDirs(sessionId) {
    const root = homePath("sessions");
    const names = candidateSessionDirNames(sessionId);
    const dirs = [];
    let projects;
    try {
      projects = await readdir(root, { withFileTypes: true });
    } catch {
      return dirs;
    }
    for (const project of projects) {
      if (!project.isDirectory() || project.isSymbolicLink()) continue;
      for (const name of names) {
        const dir = join(root, project.name, name);
        try {
          const info = await lstat(dir);
          if (info.isDirectory() && !info.isSymbolicLink()) dirs.push(dir);
        } catch { /* absent */ }
      }
    }
    return dirs;
  }

  /**
   * 删除一个对话及其全部内容：
   *  1) 停止并拆除活动中的 Agent / Session（顺序与 dsh-session-manager 一致）；
   *  2) 从工作区列表摘除；
   *  3) 删除会话持久化产物（~/.dsh/sessions/...）；
   *  4) 删除会话文件夹（对话记录 + 分类文件 + 其他内容）与状态映射。
   * 说明：不级联删除子智能体会话（子代理会话产物保留）。
   */
  async function deleteSessionAndContents(sessionId) {
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new Error("无效的会话 ID");
    }
    const agents = getService(ctx, "agents");
    const agent = typeof agents?.get === "function" ? agents.get(sessionId) : undefined;
    if (agent !== undefined) {
      try { agent.cancel?.({ kind: "disposed" }); } catch { /* ignore */ }
      try {
        if (typeof agent.scope?.dispose === "function") {
          await Promise.race([agent.scope.dispose(), sleep(3000)]);
        }
      } catch { /* ignore */ }
      try { agents.store?.delete?.(sessionId); } catch { /* ignore */ }
    }

    let detached = false;
    const session = typeof sessions?.get === "function" ? sessions.get(sessionId) : undefined;
    if (session !== undefined) {
      try { await sessions?.flush?.(session); } catch { /* ignore */ }
      try {
        const entry = sessions?.store?.get?.(sessionId);
        if (entry !== undefined && typeof entry.detach === "function") {
          entry.detach();
          await sleep(200);
          detached = true;
        }
      } catch { /* ignore */ }
    }
    if (!detached) {
      try { ctx.emit?.("session/disposed", { id: sessionId }); } catch { /* ignore */ }
    }

    try {
      if (registry !== undefined && typeof registry.list === "function") {
        for (const entity of registry.list()) {
          const ids = Array.isArray(entity?.sessionIds) ? entity.sessionIds
            : Array.isArray(entity?.record?.sessionIds) ? entity.record.sessionIds : [];
          if (ids.includes(sessionId) && typeof entity.detachSession === "function") {
            await entity.detachSession(sessionId);
          }
        }
      }
    } catch { /* ignore */ }
    try { await registry?.unarchiveSession?.(sessionId); } catch { /* ignore */ }

    for (const dir of await findSessionArtifactDirs(sessionId)) {
      try {
        await rm(dir, { recursive: true, force: true, maxRetries: 2 });
      } catch (error) {
        ctx.logger?.warn?.("dsh-conversation-folders: 删除会话产物失败 " + dir + ": " + safeErrorMessage(error));
      }
    }

    const entry = store.get(sessionId);
    let folderDeleted = false;
    if (entry !== undefined) {
      for (const alias of Array.isArray(entry.aliases) ? entry.aliases : []) {
        try { await removeJunction(alias); } catch { /* 联接已不在则忽略 */ }
      }
      try {
        await removeFolderIfSafe(entry);          // 彻底删除：不过回收站
        await removeOutputCopies(entry);          // 输出目录副本一并清理
        folderDeleted = true;
      } catch (error) {
        ctx.logger?.warn?.("dsh-conversation-folders: 删除会话文件夹失败 " + sessionId + ": " + safeErrorMessage(error));
      }
      await store.remove(sessionId);
      forget(sessionId);
    }
    ctx.logger?.info?.("dsh-conversation-folders: 已删除对话 " + sessionId + "（文件夹: " + (folderDeleted ? "已删除" : "无") + "）");
    return { ok: true, sessionId, folderDeleted };
  }

  /* ---------------- 状态查询 API ---------------- */
  if (webServer !== undefined && typeof webServer.register === "function") {
    const send = (res, status, body) => {
      try {
        res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(body));
      } catch { /* client gone */ }
    };
    const API_PREFIX = "/conversation-folders/api";
    ctx.effect?.(() => webServer.register({
      kind: "prefix",
      path: API_PREFIX,
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? "/", "http://localhost");
          const path = url.pathname.startsWith(API_PREFIX) ? url.pathname.slice(API_PREFIX.length) || "/" : "/";
          if (req.method === "GET" && (path === "/status" || path === "/")) {
            const entries = store.all();
            let present = 0;
            let linked = 0;
            let aliased = 0;
            let outputDirs = 0;
            for (const entry of entries) {
              try { await realpath(entry.folder); present += 1; } catch { /* missing */ }
              linked += Object.keys(entry.links ?? {}).length;
              aliased += Array.isArray(entry.aliases) ? entry.aliases.length : 0;
              if (typeof entry.outputDir === "string" && entry.outputDir.length > 0) outputDirs += 1;
            }
            return send(res, 200, {
              ok: true,
              enabled: true,
              version: PLUGIN_VERSION,
              folderPrefix,
              transcriptName,
              runNamePrefix,
              idleDelayMs: idleDisabled ? 0 : idleDelayMs,
              pendingIdle: idleTimers.size,
              keepPaths,
              chooseOutputDir,
              autoPromptOutputDir,
              stateFile,
              counts: { mapped: entries.length, foldersPresent: present, linked, aliased, outputDirs },
              home: homePath()
            });
          }
          if (req.method === "GET" && path === "/mappings") {
            return send(res, 200, { ok: true, entries: store.all() });
          }
          if (req.method === "POST" && path === "/organize-session") {
            const body = await readJsonBody(req);
            const sessionId = typeof body?.sessionId === "string" ? body.sessionId : undefined;
            if (sessionId === undefined) return send(res, 400, { ok: false, error: "sessionId is required" });
            const live = typeof sessions?.get === "function" ? sessions.get(sessionId) : undefined;
            if (live === undefined) return send(res, 404, { ok: false, error: "session is not live: " + sessionId });
            const result = await organizeNow(live);
            return send(res, 200, { ok: true, sessionId, title: sessionTitleOf(live) ?? null, ...result });
          }
          if (req.method === "POST" && path === "/repair-paths") {
            // 为已归档文件补原路径入口、为改名文件夹补旧名联接；body 可带 sessionId 限定单个会话。
            const body = await readJsonBody(req);
            const only = typeof body?.sessionId === "string" ? body.sessionId : undefined;
            if (ensurePathEntries === null) return send(res, 503, { ok: false, error: "path repair is unavailable" });
            const results = [];
            for (const entry of store.all()) {
              if (only !== undefined && entry.sessionId !== only) continue;
              try {
                const updated = await ensurePathEntries(entry);
                results.push({
                  sessionId: entry.sessionId,
                  folder: entry.folder,
                  links: Object.keys(updated?.links ?? entry.links ?? {}).length,
                  aliases: Array.isArray(updated?.aliases ?? entry.aliases) ? (updated?.aliases ?? entry.aliases).length : 0
                });
              } catch (error) {
                results.push({ sessionId: entry.sessionId, error: safeErrorMessage(error) });
              }
            }
            return send(res, 200, { ok: true, repaired: results.length, results });
          }
          if (req.method === "POST" && path === "/delete-session") {
            const body = await readJsonBody(req);
            const result = await deleteSessionAndContents(body?.sessionId);
            return send(res, 200, result);
          }
          if (req.method === "POST" && path === "/open-folder") {
            const body = await readJsonBody(req);
            const sessionId = typeof body?.sessionId === "string" ? body.sessionId : undefined;
            if (sessionId === undefined) return send(res, 400, { ok: false, error: "sessionId is required" });
            const entry = store.get(sessionId);
            if (entry === undefined) return send(res, 404, { ok: false, error: "session has no folder mapping: " + sessionId });
            // 只打开映射里登记、且仍位于其工作区根目录之下的真实目录
            const folder = absolute(entry.folder);
            const workspace = absolute(entry.workspacePath);
            const inside = folder === workspace || folder.startsWith(workspace + "\\") || folder.startsWith(workspace + "/");
            if (!inside) return send(res, 403, { ok: false, error: "folder is outside its workspace: " + folder });
            try {
              const info = await lstat(folder);
              if (!info.isDirectory()) return send(res, 404, { ok: false, error: "folder is not a directory: " + folder });
            } catch {
              return send(res, 404, { ok: false, error: "folder does not exist: " + folder });
            }
            if (process.platform === "win32") {
              try {
                const child = spawn("explorer.exe", [folder], { detached: true, stdio: "ignore" });
                child.on?.("error", () => { /* ignore: explorer 不可用时前端仍显示路径 */ });
                child.unref?.();
              } catch { /* ignore */ }
            } else {
              try {
                const opener = process.platform === "darwin" ? "open" : "xdg-open";
                const child = spawn(opener, [folder], { detached: true, stdio: "ignore" });
                child.on?.("error", () => { /* ignore */ });
                child.unref?.();
              } catch { /* ignore */ }
            }
            return send(res, 200, { ok: true, sessionId, folder });
          }
          if (req.method === "POST" && path === "/set-output-dir") {
            // 手动指定输出目录：整理后生产文件复制一份到 <dir>/<会话文件夹名>/
            const body = await readJsonBody(req);
            const sessionId = typeof body?.sessionId === "string" ? body.sessionId : undefined;
            const dir = typeof body?.dir === "string" ? body.dir.trim() : undefined;
            if (sessionId === undefined || dir === undefined || dir.length === 0) {
              return send(res, 400, { ok: false, error: "sessionId and dir are required" });
            }
            const entry = store.get(sessionId);
            if (entry === undefined) return send(res, 404, { ok: false, error: "session has no folder mapping: " + sessionId });
            let output = null;
            let error = null;
            try {
              output = await applyOutputDir(sessionId, dir);
            } catch (failure) {
              error = safeErrorMessage(failure);
            }
            if (output === null && error === null) {
              error = "不可用的输出目录（需绝对路径，且不能位于会话文件夹内部）";
            }
            return send(res, error === null ? 200 : 400, { ok: error === null, sessionId, outputDir: output, error });
          }
          if (req.method === "POST" && path === "/pick-output-dir") {
            // 手动再弹一次系统目录选择框（重置"已提示"标记后重新询问）
            const body = await readJsonBody(req);
            const sessionId = typeof body?.sessionId === "string" ? body.sessionId : undefined;
            if (sessionId === undefined) return send(res, 400, { ok: false, error: "sessionId is required" });
            const entry = store.get(sessionId);
            if (entry === undefined) return send(res, 404, { ok: false, error: "session has no folder mapping: " + sessionId });
            if (nativeDirectoryPicker() === null) {
              return send(res, 503, { ok: false, error: "当前环境没有可用的目录选择服务" });
            }
            const current = store.get(sessionId);
            current.outputPromoted = false; // 重置"已提示"标记，允许重新弹框
            await store.set(sessionId, current);
            try {
              await maybePromptOutputDir(sessionId);
            } catch (error) {
              return send(res, 500, { ok: false, error: safeErrorMessage(error) });
            }
            const updated = store.get(sessionId);
            return send(res, 200, { ok: true, sessionId, outputDir: updated?.outputDir ?? null });
          }
          if (req.method === "POST" && path === "/open-output-dir") {
            // 在资源管理器中打开该会话的输出目录（若已设置）
            const body = await readJsonBody(req);
            const sessionId = typeof body?.sessionId === "string" ? body.sessionId : undefined;
            if (sessionId === undefined) return send(res, 400, { ok: false, error: "sessionId is required" });
            const entry = store.get(sessionId);
            if (entry === undefined) return send(res, 404, { ok: false, error: "session has no folder mapping: " + sessionId });
            if (typeof entry.outputDir !== "string" || entry.outputDir.length === 0) {
              return send(res, 404, { ok: false, error: "session has no output dir set: " + sessionId });
            }
            const folder = absolute(entry.outputDir);
            try {
              const info = await lstat(folder);
              if (!info.isDirectory()) return send(res, 404, { ok: false, error: "output dir is not a directory: " + folder });
            } catch {
              return send(res, 404, { ok: false, error: "output dir does not exist: " + folder });
            }
            if (process.platform === "win32") {
              try {
                const child = spawn("explorer.exe", [folder], { detached: true, stdio: "ignore" });
                child.on?.("error", () => { /* ignore */ });
                child.unref?.();
              } catch { /* ignore */ }
            } else {
              try {
                const opener = process.platform === "darwin" ? "open" : "xdg-open";
                const child = spawn(opener, [folder], { detached: true, stdio: "ignore" });
                child.on?.("error", () => { /* ignore */ });
                child.unref?.();
              } catch { /* ignore */ }
            }
            return send(res, 200, { ok: true, sessionId, folder });
          }
          if (req.method === "GET" && path === "/latest-version") {
            let latest = null;
            let error = null;
            try {
              const response = await fetch(UPDATE_MANIFEST_URL, {
                headers: { "user-agent": "dsh-conversation-folders/" + PLUGIN_VERSION },
                signal: AbortSignal.timeout(8000)
              });
              if (!response.ok) throw new Error("HTTP " + response.status);
              const pkg = await response.json();
              if (typeof pkg?.version === "string") latest = pkg.version;
            } catch (failure) {
              error = safeErrorMessage(failure);
            }
            const hasUpdate = latest !== null && compareVersions(latest, PLUGIN_VERSION) > 0;
            return send(res, 200, { ok: true, local: PLUGIN_VERSION, latest, hasUpdate, error });
          }
          return send(res, 404, { ok: false, error: "not found: " + req.method + " " + path });
        } catch (error) {
          return send(res, 500, { ok: false, error: safeErrorMessage(error) });
        }
      }
    }), "dsh-conversation-folders: http api");
  }

  ctx.logger?.info?.(
    "dsh-conversation-folders: 已启动（文件夹前缀=" + JSON.stringify(folderPrefix) +
    "，对话记录=" + JSON.stringify(transcriptName) + "，状态文件=" + stateFile + "）"
  );
}

export { assertSafeFolderTarget, folderNameFor, sessionArtifactExists } from "./fs-helpers.js";