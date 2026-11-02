/**
 * dsh-conversation-folders — 纯逻辑自测（不依赖 DSH 运行时）。
 * 运行：node test/run-tests.mjs
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertSafeFolderTarget,
  encodeFsSessionSegment,
  folderNameFor,
  folderNameFromTitle,
  folderTokenFor,
  removeFolderIfSafe,
  sanitizeFolderBase,
  sessionArtifactExists
} from "../lib/fs-helpers.js";
import { createStateStore } from "../lib/state-store.js";
import {
  autoNameFor,
  capFileName,
  classifyFileName,
  isAlreadyNamed,
  mergeCategories,
  sanitizeCategoryName,
  splitName
} from "../lib/organize.js";
import {
  formatLocalTime,
  renderAssistantSection,
  renderHeader,
  renderOrganizeSection,
  renderUserSection,
  textBlocksToMarkdown
} from "../lib/transcript.js";

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed += 1; console.log("  ok  " + name); })
    .catch((error) => {
      failed += 1;
      failures.push({ name, error });
      console.log("FAIL  " + name + "\n      " + (error && error.message ? error.message : String(error)));
    });
}

async function main() {
  console.log("== folder naming ==");
  await test("uuid 会话 id -> 12 位短标识", () => {
    assert.equal(folderTokenFor("session-29c06ebb-e914-417e-8ab1-5af0a83ddbce"), "29c06ebbe914");
  });
  await test("大小写不规范 uuid 也归一为小写", () => {
    assert.equal(folderTokenFor("session-29C06EBB-E914-417E-8AB1-5AF0A83DDBcE"), "29c06ebbe914");
  });
  await test("非 uuid id 清洗非法字符", () => {
    assert.equal(folderTokenFor("a/b\\c:d"), "a_b_c_d");
    assert.equal(folderTokenFor("..."), "invalid");
  });
  await test("文件夹名带前缀", () => {
    assert.equal(folderNameFor("session-29c06ebb-e914-417e-8ab1-5af0a83ddbce"), "会话-29c06ebbe914");
    assert.equal(folderNameFor("session-29c06ebb-e914-417e-8ab1-5af0a83ddbce", "对话 "), "对话 29c06ebbe914");
  });

  console.log("== 对话标题 -> 文件夹名 ==");
  await test("标题清洗：非法字符、空白、首尾点", () => {
    assert.equal(sanitizeFolderBase("帮我调研:白酒/行业?"), "帮我调研 白酒 行业");
    assert.equal(sanitizeFolderBase("  多   空格  "), "多 空格");
    assert.equal(sanitizeFolderBase("结尾点..."), "结尾点");
    assert.equal(sanitizeFolderBase("..."), null);
    assert.equal(sanitizeFolderBase(""), null);
    assert.equal(sanitizeFolderBase("a\\b*c<d>e|f"), "a b c d e f");
  });
  await test("标题超长截断", () => {
    const long = "标".repeat(80);
    const base = sanitizeFolderBase(long);
    assert.ok(base.length <= 48, "length=" + base.length);
  });
  await test("Windows 保留设备名加下划线", () => {
    assert.equal(sanitizeFolderBase("CON"), "CON_");
    assert.equal(sanitizeFolderBase("com1"), "com1_");
  });
  await test("folderNameFromTitle：标题可用时用标题，否则回退短 ID", () => {
    const id = "session-29c06ebb-e914-417e-8ab1-5af0a83ddbce";
    assert.equal(folderNameFromTitle("白酒行业调研", id), "会话-白酒行业调研");
    assert.equal(folderNameFromTitle("...", id), "会话-29c06ebbe914");
    assert.equal(folderNameFromTitle(undefined, id), "会话-29c06ebbe914");
    assert.equal(folderNameFromTitle("白酒行业调研", id, "对话 "), "对话 白酒行业调研");
  });

  console.log("== encodeFsSessionSegment ==");
  await test("安全字符原样保留", () => {
    assert.equal(encodeFsSessionSegment("session-29c06ebb"), "session-29c06ebb");
  });
  await test("特殊字符按 DSH 契约转义", () => {
    assert.equal(encodeFsSessionSegment("a:b"), "a~003Ab");
    assert.equal(encodeFsSessionSegment("."), "~002E");
    assert.equal(encodeFsSessionSegment(".."), "~002E~002E");
  });

  console.log("== 文件夹安全校验 / 删除 ==");
  const root = await mkdtemp(join(tmpdir(), "dsh-cf-test-"));
  try {
    await test("合法目标通过校验", async () => {
      const ws = join(root, "ws");
      const folder = join(ws, "会话-abc123");
      await mkdir(folder, { recursive: true });
      const result = await assertSafeFolderTarget(folder, ws);
      assert.equal(result.folderResolved, folder);
      assert.equal(result.workspaceResolved, ws);
    });
    await test("不在工作区正下方的文件夹被拒绝", async () => {
      const ws = join(root, "ws2");
      const other = join(root, "other");
      await mkdir(other, { recursive: true });
      await assert.rejects(() => assertSafeFolderTarget(join(other, "x"), ws));
    });
    await test("工作区根目录本身被拒绝", async () => {
      const ws = join(root, "ws3");
      await mkdir(ws, { recursive: true });
      await assert.rejects(() => assertSafeFolderTarget(ws, ws));
    });
    await test("文件目标被拒绝", async () => {
      const ws = join(root, "ws4");
      const file = join(ws, "会话-file");
      await mkdir(ws, { recursive: true });
      await writeFile(file, "x");
      await assert.rejects(() => assertSafeFolderTarget(file, ws));
    });
    await test("嵌套子目录（间接位于工作区下）被拒绝", async () => {
      const ws = join(root, "ws5");
      const nested = join(ws, "sub", "会话-nested");
      await mkdir(nested, { recursive: true });
      await assert.rejects(() => assertSafeFolderTarget(nested, ws));
    });
    await test("removeFolderIfSafe 删除会话文件夹", async () => {
      const ws = join(root, "ws6");
      const folder = join(ws, "会话-remove");
      await mkdir(folder, { recursive: true });
      await writeFile(join(folder, "a.txt"), "hello");
      await removeFolderIfSafe({ sessionId: "session-x", workspacePath: ws, folder });
      await assert.rejects(() => readFile(join(folder, "a.txt")), /ENOENT/);
    });
    await test("removeFolderIfSafe 彻底删除：目标确已消失", async () => {
      const ws = join(root, "ws8");
      const folder = join(ws, "会话-deep");
      await mkdir(folder, { recursive: true });
      await writeFile(join(folder, "deep.txt"), "x");
      await removeFolderIfSafe({ sessionId: "session-y", workspacePath: ws, folder });
      await assert.rejects(() => readFile(join(folder, "deep.txt")), /ENOENT/);
    });
    await test("removeFolderIfSafe 对非法目标抛错且不删", async () => {
      const ws = join(root, "ws7");
      const target = join(root, "precious");
      await mkdir(target, { recursive: true });
      await writeFile(join(target, "keep.txt"), "keep");
      await assert.rejects(() => removeFolderIfSafe({ sessionId: "x", workspacePath: ws, folder: join(target, "keep.txt") }));
      await readFile(join(target, "keep.txt"));
    });

    console.log("== 会话产物存在性扫描 ==");
    await test("产物存在时返回 true", async () => {
      const sessionsRoot = join(root, "sessions");
      const project = join(sessionsRoot, "--D-test--");
      const sessionDir = join(project, "session-29c06ebb-e914-417e-8ab1-5af0a83ddbce");
      await mkdir(sessionDir, { recursive: true });
      assert.equal(await sessionArtifactExists(sessionsRoot, "session-29c06ebb-e914-417e-8ab1-5af0a83ddbce"), true);
    });
    await test("产物不存在时返回 false", async () => {
      const sessionsRoot = join(root, "sessions");
      assert.equal(await sessionArtifactExists(sessionsRoot, "session-00000000-0000-0000-0000-000000000000"), false);
    });
    await test("根目录无法访问时保守返回 true", async () => {
      assert.equal(await sessionArtifactExists(join(root, "no-such-root"), "session-abc"), true);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  console.log("== 状态存储 ==");
  const storeRoot = await mkdtemp(join(tmpdir(), "dsh-cf-store-"));
  try {
    await test("set/get/remove/持久化重载", async () => {
      const file = join(storeRoot, "state.v1.json");
      const store = createStateStore(file);
      await store.init();
      assert.equal(store.has("s1"), false);
      await store.set("s1", { sessionId: "s1", folder: join(storeRoot, "会话-x"), workspacePath: storeRoot });
      assert.equal(store.get("s1").folder, join(storeRoot, "会话-x"));
      await store.flush();
      const reloaded = createStateStore(file);
      await reloaded.init();
      assert.equal(reloaded.has("s1"), true);
      assert.equal(reloaded.get("s1").folder, join(storeRoot, "会话-x"));
      await reloaded.remove("s1");
      await reloaded.flush();
      const reloaded2 = createStateStore(file);
      await reloaded2.init();
      assert.equal(reloaded2.has("s1"), false);
    });
    await test("损坏的状态文件不致命并重建", async () => {
      const file = join(storeRoot, "state-corrupt.json");
      await writeFile(file, "{not json");
      const store = createStateStore(file);
      await store.init();
      assert.equal(store.all().length, 0);
      await store.set("s2", { sessionId: "s2", folder: "F", workspacePath: "W" });
      await store.flush();
      const parsed = JSON.parse(await readFile(file, "utf8"));
      assert.equal(parsed.version, 1);
    });
  } finally {
    await rm(storeRoot, { recursive: true, force: true });
  }

  console.log("== 分类与自动命名 ==");
  await test("扩展名归类", () => {
    assert.equal(classifyFileName("数据.xlsx"), "01-表格");
    assert.equal(classifyFileName("DATA.csv"), "01-表格");
    assert.equal(classifyFileName("图.png"), "02-图表");
    assert.equal(classifyFileName("报告.docx"), "03-文档");
    assert.equal(classifyFileName("report.md"), "03-文档");
    assert.equal(classifyFileName("data.json"), "04-数据");
    assert.equal(classifyFileName("solve.py"), "05-代码");
    assert.equal(classifyFileName("backup.zip"), "06-压缩包");
    assert.equal(classifyFileName("stuff.weird"), "07-其他");
    assert.equal(classifyFileName("noextension"), "07-其他");
  });
  await test("自定义类别覆盖默认表", () => {
    const merged = mergeCategories({ "01-表格": [".xlsx", ".custom"] });
    assert.equal(classifyFileName("a.custom", merged), "01-表格");
    assert.equal(classifyFileName("b.xlsx", merged), "01-表格");
    assert.equal(classifyFileName("c.csv", merged), "07-其他"); // 覆盖后 csv 不再属于表格
    assert.equal(classifyFileName("d.png", merged), "02-图表"); // 其余默认类别保留
  });
  await test("非法类别名被拒绝（不能移出会话文件夹）", () => {
    assert.equal(sanitizeCategoryName(".."), null);
    assert.equal(sanitizeCategoryName("."), null);
    assert.equal(sanitizeCategoryName("  "), null);
    assert.equal(sanitizeCategoryName("a/b"), "a_b");
    assert.equal(sanitizeCategoryName("a\\b"), "a_b");
    assert.equal(sanitizeCategoryName("x.."), "x");
    const merged = mergeCategories({ "../evil": [".xlsx"], "..": [".png"], "正常": [".abc"] });
    assert.equal(classifyFileName("a.xlsx", merged), "01-表格"); // 恶意键被丢弃，走默认表
    assert.equal(classifyFileName("b.abc", merged), "正常");     // 合法自定义类别保留
  });
  await test("超长文件名截断（保留扩展名）", () => {
    const long = "研".repeat(300) + ".xlsx";
    const capped = capFileName(long, 160);
    assert.ok(capped.length <= 160, "length=" + capped.length);
    assert.ok(capped.endsWith(".xlsx"));
    assert.equal(capFileName("short.xlsx", 160), "short.xlsx");
  });
  await test("自动命名与去重拆分", () => {
    assert.equal(autoNameFor(3, "行业数据.csv", "调研"), "调研3_行业数据.csv");
    assert.equal(autoNameFor(1, "图.png"), "调研1_图.png");
    assert.deepEqual(splitName("a.b.c.xlsx"), { stem: "a.b.c", ext: ".xlsx" });
    assert.deepEqual(splitName("noext"), { stem: "noext", ext: "" });
  });
  await test("已归档命名识别", () => {
    assert.equal(isAlreadyNamed("调研1_数据.xlsx"), true);
    assert.equal(isAlreadyNamed("调研12_数据.xlsx"), true);
    assert.equal(isAlreadyNamed("数据.xlsx"), false);
    assert.equal(isAlreadyNamed("调研数据.xlsx"), false);
    assert.equal(isAlreadyNamed("Stats_调研1_x"), false);
  });

  console.log("== 对话记录渲染 ==");
  await test("文本块提取", () => {
    const blocks = [
      { type: "reasoning", text: "hidden" },
      { type: "text", text: "你好" },
      { type: "tool-call", name: "x" },
      { type: "text", text: "世界" }
    ];
    assert.equal(textBlocksToMarkdown(blocks), "你好\n\n世界");
    assert.equal(textBlocksToMarkdown([{ type: "reasoning", text: "hidden" }]), null);
    assert.equal(textBlocksToMarkdown(null), null);
  });
  await test("用户/助手章节", () => {
    const t = formatLocalTime(1792632529640);
    const user = renderUserSection({ content: [{ type: "text", text: "请调研白酒行业" }], time: 1792632529640 });
    assert.ok(user.includes("## 用户 · "), user);
    assert.ok(user.includes("请调研白酒行业"), user);
    const assistant = renderAssistantSection({ message: { content: [{ type: "text", text: "好的，开始调研。" }] }, time: 1792632529640 });
    assert.ok(assistant.includes("## 助手 · "), assistant);
    assert.ok(assistant.includes("好的，开始调研。"), assistant);
    assert.equal(renderAssistantSection({ message: { content: [{ type: "reasoning", text: "x" }] } }), null);
  });
  await test("整理章节带归档清单", () => {
    const section = renderOrganizeSection(2, [{ category: "01-表格", to: "调研2_数据.xlsx" }], 1792632529640);
    assert.ok(section.includes("## 整理 · "), section);
    assert.ok(section.includes("01-表格/调研2_数据.xlsx"), section);
    const empty = renderOrganizeSection(1, [], 1792632529640);
    assert.ok(empty.includes("本次未发现需要整理的新文件"), empty);
  });
  await test("整理章节可标注文件夹改名", () => {
    const section = renderOrganizeSection(1, [], 1792632529640, { folderName: "会话-白酒行业调研" });
    assert.ok(section.includes("文件夹名已按对话标题更新为"), section);
    assert.ok(section.includes("会话-白酒行业调研"), section);
  });
  await test("文件头", () => {
    const header = renderHeader("session-x", "D:\\ws");
    assert.ok(header.includes("# 对话记录"));
    assert.ok(header.includes("session-x"));
    assert.ok(header.includes("D:\\ws"));
  });

  console.log("");
  console.log("结果: " + passed + " 通过, " + failed + " 失败");
  if (failed > 0) {
    for (const f of failures) console.log(" - " + f.name + ": " + f.error.message);
    process.exit(1);
  }
}

main().catch((error) => { console.error(error); process.exit(1); });