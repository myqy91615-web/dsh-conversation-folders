/**
 * dsh-conversation-folders — 冒烟测试（假 ctx，不依赖 DSH 运行时）。
 *
 * 用最小化的 Cordis 风格 ctx 驱动插件的 apply()，验证完整生命周期：
 *   0) apply() 写入激活标记；
 *   1) 会话创建（无名，不建文件夹）；
 *   2) 首次使用（user/message）→ 创建专属文件夹 + working-directory/change + 对话记录文件头；
 *   3) 继续收发消息 → 对话记录追加用户/助手章节；合成消息（runtime-context）不记录；
 *   4) turn/end → 散落文件被分类归档并自动命名（调研1_…），对话记录追加整理清单；
 *   5) 记录被删除后再次收到消息 → 从会话事件回填全部历史对话；
 *   6) 会话停止/关机（disposed 但产物仍在）→ 文件夹保留；
 *   7) 真正删除会话（disposed 且产物消失）→ 文件夹连同内容彻底删除、映射清除。
 * 运行：node test/smoke-test.mjs
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../lib/index.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;

function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed += 1; console.log("  ok  " + name); })
    .catch((error) => {
      failed += 1;
      console.log("FAIL  " + name + "\n      " + (error && error.message ? error.message : String(error)));
    });
}

async function pathExists(p) {
  try { await stat(p); return true; } catch { return false; }
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), "dsh-cf-smoke-"));
  const fakeHome = join(root, "dsh-home");
  const wsRoot = join(root, "workspace");
  await mkdir(wsRoot, { recursive: true });
  console.log("smoke root: " + root);

  // ---- 假 DSH 环境 ----
  const listeners = new Map();
  const liveSessions = new Map();
  const workingDirState = new Map(); // sessionId -> current workingDirectory 投影
  const wsys = [{ id: "ws-1", path: wsRoot, title: "工作区" }];
  const config = {
    enabled: true,
    folderPrefix: "会话-",
    transcriptName: "对话记录.md",
    categorize: true,
    runNamePrefix: "调研",
    settleDelayMs: 50,
    deleteTimeoutMs: 1500
  };

  const ctx = {
    config,
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
      return () => {
        const arr = listeners.get(event);
        if (arr) { const i = arr.indexOf(handler); if (i >= 0) arr.splice(i, 1); }
      };
    },
    emit(event, ...args) {
      const arr = listeners.get(event);
      if (arr) for (const h of [...arr]) { try { h(...args); } catch (e) { console.log("listener error on " + event + ": " + e); } }
    },
    effect(fn) { fn(); },
    get(name) {
      if (name === "dshHomePath") return (...seg) => join(fakeHome, ...seg);
      if (name === "workspaceRegistry") return { list: () => wsys };
      if (name === "sessions") return { get: (id) => liveSessions.get(id) };
      if (name === "sessionProjections") return { stateOf: (session, key) => key === "workingDirectory" ? workingDirState.get(session.id) ?? null : null };
      if (name === "sessionQuery") return {
        readSession: async (id) => {
          const live = liveSessions.get(id);
          return { session: live?.header ?? { id }, events: live ? [...live.events] : [] };
        }
      };
      if (name === "webServer") return { register: (spec) => { ctx.webSpec = spec; } };
      if (name === "agents" || name === "sessionPersistence") return {};
      return undefined;
    },
    logger: {
      info: (...a) => console.log("  [info] " + a.join(" ")),
      warn: (...a) => console.log("  [warn] " + a.join(" "))
    },
    webSpec: null
  };

  const makeSession = (id, cwd) => {
    const session = {
      id,
      header: { version: 4, id, createdAt: Date.now(), cwd, isSeeded: false },
      events: [],
      append(type, data) {
        const event = { type, seq: this.events.length, time: Date.now(), data };
        this.events.push(event);
        if (type === "working-directory/change") workingDirState.set(id, data.cwd);
        ctx.emit("session/event", this, event); // 模拟 DSH 的 session/event 分发
        return event;
      }
    };
    return session;
  };

  /** 记录事件到会话 events 后分发（模拟 DSH 先落盘再广播）。 */
  const fire = (session, event) => {
    session.events.push(event);
    ctx.emit("session/event", session, event);
  };

  let seq = 100;
  const nextSeq = () => ++seq;
  const userEvent = (text) => ({
    type: "user/message", seq: nextSeq(), time: Date.now(),
    data: { content: [{ type: "text", text }], source: { kind: "user", rpcId: "rpc-" + seq } }
  });
  const assistantEvent = (text) => ({
    type: "assistant/message", seq: nextSeq(), time: Date.now(),
    data: { turn: 1, step: 1, message: { role: "assistant", content: [{ type: "reasoning", text: "..." }, { type: "text", text }] } }
  });
  const turnEndEvent = (turn) => ({
    type: "turn/end", seq: nextSeq(), time: Date.now(), data: { turn, reason: { kind: "completed" } }
  });

  console.log("== 0) apply() 激活 ==");
  apply(ctx, config);
  await check("写入激活标记 applied.log", async () => {
    const log = await readFile(join(fakeHome, "conversation-folders", "applied.log"), "utf8");
    assert.ok(log.includes("apply"), log);
  });
  const stateFile = join(fakeHome, "conversation-folders", "state.v1.json");

  const SESSION_ID = "session-29c06ebb-e914-417e-8ab1-5af0a83ddbce";
  const FOLDER_NAME = "会话-29c06ebbe914";
  const sourceFolder = join(wsRoot, FOLDER_NAME);
  const transcriptFile = join(sourceFolder, "对话记录.md");
  const sessionsRoot = join(fakeHome, "sessions");
  const sessionDir = join(sessionsRoot, "--D-workspace--", SESSION_ID);

  console.log("== 1) 会话创建但不建文件夹（空白占位不占坑） ==");
  let s1 = makeSession(SESSION_ID, wsRoot);
  liveSessions.set(SESSION_ID, s1);
  ctx.emit("session/created", s1);
  await sleep(80);
  await check("空闲会话不产生文件夹", async () => {
    assert.equal(await pathExists(sourceFolder), false);
  });

  console.log("== 2) 第一条用户消息 → 专属文件夹 + 工作目录引导 + 对话记录 ==");
  fire(s1, userEvent("帮我调研一下白酒行业，最后输出一张对比表格"));
  await sleep(150);
  await check("工作区下出现 会话-<短ID> 文件夹", async () => {
    assert.equal(await pathExists(sourceFolder), true);
  });
  await check("working-directory 投影指向专属文件夹", () => {
    assert.equal(workingDirState.get(SESSION_ID), sourceFolder);
  });
  await check("对话记录创建且含文件头与用户消息", async () => {
    const text = await readFile(transcriptFile, "utf8");
    assert.ok(text.includes("# 对话记录"), text);
    assert.ok(text.includes("## 用户 · "), text);
    assert.ok(text.includes("帮我调研一下白酒行业"), text);
  });
  await check("映射已持久化", async () => {
    const state = JSON.parse(await readFile(stateFile, "utf8"));
    assert.equal(state.entries[SESSION_ID].folder, sourceFolder);
    assert.equal(state.entries[SESSION_ID].workspacePath, wsRoot);
  });
  await check("会话 header.cwd 保持不变（工作区归属不受影响）", () => {
    assert.equal(s1.header.cwd, wsRoot);
  });

  console.log("== 3) 助手回复与合成消息 → 只记录真实对话 ==");
  fire(s1, assistantEvent("好的，正在调研并整理表格。"));
  // 同一文本在不同回合重复出现时应各记录一次（防误判为重复而丢内容）
  fire(s1, assistantEvent("重复的一句话"));
  fire(s1, assistantEvent("重复的一句话"));
  // 合成消息（runtime-context）不应进入对话记录
  fire(s1, {
    type: "user/message", seq: nextSeq(), time: Date.now(),
    data: { content: [{ type: "text", text: "Current runtime context. This snapshot supersedes..." }], source: { kind: "runtime-context" } }
  });
  await sleep(150);
  await check("对话记录包含助手消息", async () => {
    const text = await readFile(transcriptFile, "utf8");
    assert.ok(text.includes("## 助手 · "), text);
    assert.ok(text.includes("好的，正在调研并整理表格。"), text);
  });
  await check("相同文本的两个助手消息都记录", async () => {
    const text = await readFile(transcriptFile, "utf8");
    assert.equal((text.match(/重复的一句话/g) ?? []).length, 2);
  });
  await check("合成 runtime-context 消息不记录", async () => {
    const text = await readFile(transcriptFile, "utf8");
    assert.equal(text.includes("Current runtime context"), false);
  });

  console.log("== 4) 调研结束（turn/end）→ 分类归档 + 自动命名 + 整理清单 ==");
  await writeFile(join(sourceFolder, "行业数据对比.xlsx"), "xlsx-bytes");
  await writeFile(join(sourceFolder, "趋势图.png"), "png-bytes");
  await writeFile(join(sourceFolder, "调研1_已整理.csv"), "already-named");
  // 目标名已被占用（上一轮遗留）→ 自动去重
  await mkdir(join(sourceFolder, "01-表格"), { recursive: true });
  await writeFile(join(sourceFolder, "01-表格", "调研1_preexisting.xlsx"), "old");
  await writeFile(join(sourceFolder, "preexisting.xlsx"), "new");
  // 超长文件名 → 截断
  const longName = "x".repeat(200) + ".xlsx";
  await writeFile(join(sourceFolder, longName), "long");
  fire(s1, turnEndEvent(1));
  await sleep(400);
  await check("表格文件移入 01-表格 并自动命名", async () => {
    assert.equal(await pathExists(join(sourceFolder, "01-表格", "调研1_行业数据对比.xlsx")), true);
    assert.equal(await pathExists(join(sourceFolder, "行业数据对比.xlsx")), false);
  });
  await check("图片文件移入 02-图表 并自动命名", async () => {
    assert.equal(await pathExists(join(sourceFolder, "02-图表", "调研1_趋势图.png")), true);
  });
  await check("已归档命名的文件不再重复移动", async () => {
    assert.equal(await pathExists(join(sourceFolder, "调研1_已整理.csv")), true);
  });
  await check("目标名被占用时自动去重", async () => {
    assert.equal(await readFile(join(sourceFolder, "01-表格", "调研1_preexisting.xlsx"), "utf8"), "old");
    assert.equal(await pathExists(join(sourceFolder, "01-表格", "调研1_preexisting_2.xlsx")), true);
    assert.equal(await pathExists(join(sourceFolder, "preexisting.xlsx")), false);
  });
  await check("超长文件名被截断", async () => {
    const names = await readdir(join(sourceFolder, "01-表格"));
    const capped = names.find((name) => name.startsWith("调研1_") && name.endsWith(".xlsx") && name.length <= 160 && name.includes("xxxx"));
    assert.ok(capped !== undefined, JSON.stringify(names));
  });
  await check("对话记录追加调研结束与整理清单", async () => {
    const text = await readFile(transcriptFile, "utf8");
    assert.ok(text.includes("## 调研 1 结束"), text);
    assert.ok(text.includes("01-表格/调研1_行业数据对比.xlsx"), text);
    assert.ok(text.includes("02-图表/调研1_趋势图.png"), text);
  });
  await check("调研序号持久化到映射", async () => {
    const state = JSON.parse(await readFile(stateFile, "utf8"));
    assert.equal(state.entries[SESSION_ID].run, 1);
  });
  await check("第二轮调研序号递增", async () => {
    await writeFile(join(sourceFolder, "notes.md"), "md");
    fire(s1, turnEndEvent(2));
    await sleep(400);
    assert.equal(await pathExists(join(sourceFolder, "03-文档", "调研2_notes.md")), true);
    const state = JSON.parse(await readFile(stateFile, "utf8"));
    assert.equal(state.entries[SESSION_ID].run, 2);
  });

  console.log("== 5) 对话记录被删除后再次收到消息 → 从会话事件回填历史 ==");
  await rm(transcriptFile, { force: true });
  fire(s1, userEvent("继续调研，补充渠道数据"));
  await sleep(250);
  await check("重建的对话记录包含全部历史对话", async () => {
    const text = await readFile(transcriptFile, "utf8");
    assert.ok(text.includes("帮我调研一下白酒行业"), text);
    assert.ok(text.includes("好的，正在调研并整理表格。"), text);
    assert.ok(text.includes("继续调研，补充渠道数据"), text);
  });
  await check("回填带说明标记且不含合成消息", async () => {
    const text = await readFile(transcriptFile, "utf8");
    assert.ok(text.includes("以上为此前对话回填"), text);
    assert.equal(text.includes("Current runtime context"), false);
  });

  console.log("== 6) 会话停止/关机（disposed 但产物还在）→ 文件夹保留 ==");
  await mkdir(sessionDir, { recursive: true }); // 模拟磁盘上的会话产物
  liveSessions.delete(SESSION_ID);
  ctx.emit("session/disposed", s1);
  await sleep(1200); // 超过 deleteTimeoutMs，产物一直存在 → 保留
  await check("会话仍存续时文件夹保留", async () => {
    assert.equal(await pathExists(sourceFolder), true);
    assert.equal(await pathExists(transcriptFile), true);
  });

  console.log("== 7) 真正删除会话（disposed 且产物消失）→ 文件夹彻底删除 ==");
  await rm(sessionDir, { recursive: true, force: true }); // 会话产物被删除（dsh-session-manager 删除动作）
  ctx.emit("session/disposed", s1);
  await sleep(1200);
  await check("文件夹与全部内容被彻底删除", async () => {
    assert.equal(await pathExists(sourceFolder), false);
    assert.equal(await pathExists(join(sourceFolder, "01-表格")), false);
  });
  await check("映射记录被清除", async () => {
    const state = JSON.parse(await readFile(stateFile, "utf8"));
    assert.equal(state.entries[SESSION_ID], undefined);
  });

  console.log("== 8) 工作区/文件夹被手动删除 → 删除会话后映射被清理 ==");
  const wsRoot2 = join(root, "workspace2");
  await mkdir(wsRoot2, { recursive: true });
  wsys.push({ id: "ws-2", path: wsRoot2, title: "工作区2" });
  const SESSION_ID_2 = "session-11111111-2222-3333-4444-555555555555";
  const s2 = makeSession(SESSION_ID_2, wsRoot2);
  liveSessions.set(SESSION_ID_2, s2);
  fire(s2, userEvent("第二个工作区的对话"));
  await sleep(250);
  await check("第二个工作区也分配了文件夹", async () => {
    assert.equal(await pathExists(join(wsRoot2, "会话-111111112222")), true);
  });
  await rm(wsRoot2, { recursive: true, force: true }); // 用户把整个工作区删了
  liveSessions.delete(SESSION_ID_2);
  ctx.emit("session/disposed", s2);
  await sleep(900);
  await check("工作区已删除时映射被清理（不永久残留）", async () => {
    const state = JSON.parse(await readFile(stateFile, "utf8"));
    assert.equal(state.entries[SESSION_ID_2], undefined);
  });

  console.log("== 9) 会话菜单删除接口 → 删除会话产物与文件夹 ==");
  const SESSION_ID_3 = "session-99999999-aaaa-bbbb-cccc-dddddddddddd";
  const s3 = makeSession(SESSION_ID_3, wsRoot);
  liveSessions.set(SESSION_ID_3, s3);
  fire(s3, userEvent("第三个对话，测试菜单删除"));
  await sleep(250);
  const folder3 = join(wsRoot, "会话-99999999aaaa");
  const artifactDir3 = join(sessionsRoot, "--D-workspace--", SESSION_ID_3);
  await mkdir(artifactDir3, { recursive: true });
  await writeFile(join(artifactDir3, "session.v4.jsonl.zstd"), "x");
  await check("删除前文件夹与会话产物存在", async () => {
    assert.equal(await pathExists(folder3), true);
    assert.equal(await pathExists(artifactDir3), true);
  });
  await check("POST /delete-session 删除文件夹、会话产物并清映射", async () => {
    liveSessions.delete(SESSION_ID_3); // 模拟删除一个非活动会话
    const req = new EventEmitter();
    req.method = "POST";
    req.url = "/conversation-folders/api/delete-session";
    const res = {
      status: 0,
      body: "",
      writeHead(status) { this.status = status; },
      end(body) { this.body = String(body); }
    };
    const pending = ctx.webSpec.handler(req, res);
    req.emit("data", Buffer.from(JSON.stringify({ sessionId: SESSION_ID_3 })));
    req.emit("end");
    await pending;
    assert.equal(res.status, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.ok, true, res.body);
    assert.equal(await pathExists(folder3), false);
    assert.equal(await pathExists(artifactDir3), false);
    const state = JSON.parse(await readFile(stateFile, "utf8"));
    assert.equal(state.entries[SESSION_ID_3], undefined);
  });
  await check("删除接口对无效参数返回错误", async () => {
    const req = new EventEmitter();
    req.method = "POST";
    req.url = "/conversation-folders/api/delete-session";
    const res = {
      status: 0,
      body: "",
      writeHead(status) { this.status = status; },
      end(body) { this.body = String(body); }
    };
    const pending = ctx.webSpec.handler(req, res);
    req.emit("data", Buffer.from(JSON.stringify({ sessionId: "" })));
    req.emit("end");
    await pending;
    assert.equal(res.status, 500);
    assert.equal(JSON.parse(res.body).ok, false);
  });

  await rm(root, { recursive: true, force: true });
  console.log("");
  console.log("结果: " + passed + " 通过, " + failed + " 失败");
  if (failed > 0) process.exit(1);
}

main().catch((error) => { console.error(error); process.exit(1); });