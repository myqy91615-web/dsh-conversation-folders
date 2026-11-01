/**
 * dsh-conversation-folders — 映射状态存储。
 *
 * 记录 会话id -> { workspaceId, workspacePath, folder, folderName, assignedAt, run }。
 * 文件保存在 DSH home 下（~/.dsh/conversation-folders/state.v1.json），
 * 与工作区文件分离，避免被本插件的删除逻辑误删。写入采用临时文件 + 原子 rename。
 */
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { existsSync, renameSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const STATE_VERSION = 1;

export function createStateStore(stateFilePath) {
  let entries = new Map();
  let writeChain = Promise.resolve();

  // 同步加载：插件 apply() 中会同步读取映射（get/has/all），
  // 之后的事件都发生在启动之后的异步路径，构造时同步读可消除竞态。
  function loadSync() {
    if (!existsSync(stateFilePath)) return;
    try {
      const raw = readFileSync(stateFilePath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed !== null && typeof parsed === "object" && parsed.version === STATE_VERSION && parsed.entries !== null && typeof parsed.entries === "object") {
        for (const [id, value] of Object.entries(parsed.entries)) {
          if (value !== null && typeof value === "object" && typeof value.folder === "string") {
            entries.set(id, value);
          }
        }
      }
    } catch {
      // 损坏的状态文件不致命：改名为 .corrupt-<ts> 以便排查，然后重建
      try {
        renameSync(stateFilePath, stateFilePath + ".corrupt-" + Date.now());
      } catch { /* best-effort */ }
    }
  }
  loadSync();

  async function persist() {
    const payload = {
      version: STATE_VERSION,
      updatedAt: Date.now(),
      entries: Object.fromEntries(entries)
    };
    await mkdir(dirname(stateFilePath), { recursive: true });
    const tmp = stateFilePath + ".tmp-" + process.pid + "-" + Date.now();
    await writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
    try {
      await rename(tmp, stateFilePath);
    } catch (error) {
      try { await rm(tmp, { force: true }); } catch { /* best-effort */ }
      throw error;
    }
  }

  /** 串行化写入（含错误抑制的封装层由调用方决定）。 */
  function enqueueWrite() {
    writeChain = writeChain.then(persist).catch(() => {});
    return writeChain;
  }

  return {
    /** 兼容旧接口：构造时已同步加载，此方法为无操作。 */
    async init() {
      // 已在构造时同步加载
    },
    get(id) {
      return entries.get(id);
    },
    has(id) {
      return entries.has(id);
    },
    all() {
      return [...entries.values()];
    },
    set(id, value) {
      entries.set(id, value);
      return enqueueWrite();
    },
    remove(id) {
      const existed = entries.delete(id);
      if (existed) return enqueueWrite();
      return Promise.resolve();
    },
    /** 等待所有挂起写入完成（测试/关机时使用）。 */
    flush() {
      return writeChain;
    }
  };
}

export { join as pathJoin };