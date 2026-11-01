/**
 * dsh-conversation-folders — Host 半区（Cordis 插件）v0.2.0。
 *
 * 需求：
 *   1) 在已创建的工作区内进行对话时，自动为该会话开辟一个专属文件夹，
 *      对话内容（用户消息 / 助手回复）自动存档为 `对话记录.md`；
 *   2) 每次调研（回合）结束后，把本次新增的散落文件（表格、图表、文档等）
 *      按类别自动分文件夹存放，并自动命名（`调研<N>_<原文件名>`）；
 *   3) 删除该会话时，其文件夹及全部内容被彻底删除（不过回收站）。
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
 *   - 调研归档：turn/end 时把文件夹根目录的散落文件按扩展名分类移入
 *     01-表格 / 02-图表 / 03-文档 / 04-数据 / 05-代码 / 06-压缩包 / 07-其他
 *     子文件夹，并重命名为 `调研<N>_<原名>`（N 为该会话的调研序号，持久化）；
 *     整理清单追加进对话记录；
 *   - 删除检测：session/disposed 后轮询（默认最长 12 秒）等待会话持久化产物
 *     从磁盘消失——消失了才是真正的"删除会话"，此时才彻底删除文件夹；
 *     只是停止/关机则产物仍在，文件夹保留；
 *   - 所有删除动作都经过 assertSafeFolderTarget 校验（目标必须直接位于
 *     工作区根目录正下方、是普通目录、非符号链接），杜绝误删；
 *     Windows 上先递归清除只读属性再 rm，确保"彻底删除"。
 */
import { appendFile, copyFile, lstat, mkdir, readdir, realpath, rename, rm, unlink } from "node:fs/promises";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  absolute,
  candidateSessionDirNames,
  canonicalize,
  ensureFolder,
  folderNameFor,
  removeFolderIfSafe,
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
  renderTurnEndSection,
  renderUserSection
} from "./transcript.js";

export const name = "dsh-conversation-folders";

export const inject = [
  "sessions",
  "workspaceRegistry",
  "sessionProjections",
  "webServer"
];

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

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

  /** 会话映射被清理后，同步丢弃内存状态。 */
  function forget(sessionId) {
    writeSeqs.delete(sessionId);
    appendQueues.delete(sessionId);
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

    const folderName = folderNameFor(id, folderPrefix);
    const folder = join(absolute(workspace.path), folderName);
    // 防御：目标必须位于工作区根目录正下方（静态前缀校验，最终以 realpath 校验为准）
    if (!folder.startsWith(absolute(workspace.path) + "\\") && !folder.startsWith(absolute(workspace.path) + "/")) {
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
          await removeFolderIfSafe({ sessionId: id, workspacePath: absolute(workspace.path), folder });
        }
      } catch { /* best-effort; 文件夹可能已有内容则保留 */ }
      return { assigned: false, reason: "append-failed" };
    }

    const entry = {
      sessionId: id,
      workspaceId: workspace.id,
      workspacePath: absolute(workspace.path),
      folder,
      folderName,
      assignedAt: Date.now(),
      run: 0
    };
    await store.set(id, entry);
    ctx.logger?.info?.("dsh-conversation-folders: " + id + " -> " + folder);
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
    const run = ((Number.isFinite(entry.run) && entry.run > 0) ? entry.run : 0) + 1;
    const folder = entry.folder;
    const moved = [];
    let dirEntries;
    try {
      dirEntries = await readdir(folder, { withFileTypes: true });
    } catch (error) {
      ctx.logger?.warn?.("dsh-conversation-folders: 扫描会话文件夹失败 " + id + ": " + safeErrorMessage(error));
      return { run, moved };
    }
    const usedTargets = new Set(); // 小写比较：Windows 文件系统大小写不敏感
    for (const ent of dirEntries) {
      if (!ent.isFile()) continue;                          // 只整理散落文件，目录不动
      if (ent.name === transcriptName) continue;            // 对话记录保留在根目录
      if (ent.name.startsWith(".")) continue;               // 隐藏文件不动
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
      } catch (error) {
        ctx.logger?.warn?.("dsh-conversation-folders: 归档失败 " + id + "/" + ent.name + ": " + safeErrorMessage(error));
      }
    }
    entry.run = run;
    await store.set(id, entry);
    if (moved.length > 0) {
      ctx.logger?.info?.("dsh-conversation-folders: " + id + " 调研 " + run + " 归档 " + moved.length + " 个文件");
    }
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

  /** 回合结束：先归档，再把整理清单写进对话记录。 */
  async function onTurnEnd(session, event) {
    const id = sessionIdOf(session);
    if (id === undefined) return;
    if (typeof event?.seq === "number" && event.seq <= (writeSeqs.get(id) ?? -1)) return;
    const res = await ensureFor(session);
    if (!res.assigned) return;
    let report;
    if (cfg.categorize === false) {
      const entry = store.get(id);
      const run = ((Number.isFinite(entry?.run) && entry.run > 0) ? entry.run : 0) + 1;
      if (entry !== undefined) {
        entry.run = run;
        await store.set(id, entry);
      }
      report = { run, moved: [] };
    } else {
      report = await categorizeFor(session, res);
    }
    if (cfg.transcriptName === false) return;
    if (report.run === 0) return; // 映射不存在（会话已清理），不写小结
    const section = renderTurnEndSection(report.run, report.moved, event?.time ?? Date.now());
    await writeTranscriptEvent(session, event, section);
  }

  /* ---------------- 会话创建 / 首次使用 / 回合结束 ---------------- */
  if (typeof ctx.on === "function") {
    ctx.on("session/created", (session) => {
      const id = sessionIdOf(session);
      if (id === undefined || session?.header?.origin === "subagent") return;
      if (!store.has(id)) return; // 未分配：等真正使用再说，避免空文件夹堆积
      void ensureFor(session).catch(() => {});
    });

    ctx.on("session/event", (session, event) => {
      const eventType = event?.type;
      const id = sessionIdOf(session);
      if (id === undefined || session?.header?.origin === "subagent") return;
      if (eventType === "turn/start" || eventType === "user/message") void ensureFor(session).catch(() => {});
      if (eventType === "user/message") void transcribeUser(session, event).catch(() => {});
      if (eventType === "assistant/message") void transcribeAssistant(session, event).catch(() => {});
      if (eventType === "turn/end") void onTurnEnd(session, event).catch(() => {});
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
          await removeFolderIfSafe(entry);         // 彻底删除：不过回收站
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
    const reconcile = async () => {
      try {
        for (const entry of store.all()) {
          if (await durableArtifactExists(homePath, entry.sessionId)) {
            // 会话还在，但文件夹被手动删了 → 清理映射，下次使用时重新分配
            try {
              await realpath(entry.folder);
            } catch {
              await store.remove(entry.sessionId);
            }
            continue;
          }
          try {
            await removeFolderIfSafe(entry);
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
      try {
        await removeFolderIfSafe(entry);
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
            for (const entry of entries) {
              try { await realpath(entry.folder); present += 1; } catch { /* missing */ }
            }
            return send(res, 200, {
              ok: true,
              enabled: true,
              folderPrefix,
              transcriptName,
              runNamePrefix,
              stateFile,
              counts: { mapped: entries.length, foldersPresent: present },
              home: homePath()
            });
          }
          if (req.method === "GET" && path === "/mappings") {
            return send(res, 200, { ok: true, entries: store.all() });
          }
          if (req.method === "POST" && path === "/delete-session") {
            const body = await readJsonBody(req);
            const result = await deleteSessionAndContents(body?.sessionId);
            return send(res, 200, result);
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