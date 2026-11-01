/**
 * dsh-conversation-folders — 对话记录（transcript）渲染（纯函数，可独立单测）。
 *
 * 输出 markdown 追加到会话文件夹根目录的 `对话记录.md`：
 *  - 用户消息 / 助手最终文本消息各成一节；
 *  - 每个调研回合（turn）结束时追加"调研 N 结束"章节，并列出本次整理的文件。
 */
export const TRANSCRIPT_NAME = "对话记录.md";

function pad(n) {
  return String(n).padStart(2, "0");
}

/** 本地时间格式化：YYYY-MM-DD HH:mm:ss。 */
export function formatLocalTime(ms) {
  const d = new Date(typeof ms === "number" && Number.isFinite(ms) ? ms : Date.now());
  return (
    d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
    " " + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds())
  );
}

/** 从内容块中提取可读文本（仅 text 块，跳过 reasoning / tool-call / 附件）。 */
export function textBlocksToMarkdown(blocks) {
  if (!Array.isArray(blocks)) return null;
  const parts = [];
  for (const block of blocks) {
    if (block === null || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0) {
      parts.push(block.text.trimEnd());
    }
  }
  return parts.length > 0 ? parts.join("\n\n") : null;
}

/** 会话记录文件头（首次创建时写入）。 */
export function renderHeader(sessionId, workspacePath, startedAt) {
  return (
    "# 对话记录\n\n" +
    "- 会话: `" + (typeof sessionId === "string" ? sessionId : "") + "`\n" +
    "- 工作区: `" + (typeof workspacePath === "string" ? workspacePath : "") + "`\n" +
    "- 开始: " + formatLocalTime(startedAt) + "\n\n---\n"
  );
}

/** 用户消息章节。eventData 为 user/message 会话事件的 data 字段。 */
export function renderUserSection(eventData, fallbackTime) {
  const text = textBlocksToMarkdown(eventData?.content);
  if (text === null) return null;
  return "\n## 用户 · " + formatLocalTime(eventData?.time ?? fallbackTime) + "\n\n" + text + "\n";
}

/** 助手消息章节。eventData 为 assistant/message 会话事件的 data 字段。 */
export function renderAssistantSection(eventData, fallbackTime) {
  const message = eventData?.message ?? eventData;
  const text = textBlocksToMarkdown(message?.content);
  if (text === null) return null;
  return "\n## 助手 · " + formatLocalTime(eventData?.time ?? fallbackTime) + "\n\n" + text + "\n";
}

/**
 * 调研回合结束章节。moved 形如 [{ category, to }]。
 * 追加在分类整理完成之后，让用户能看到"这次调研产出了什么、被整理到哪里"。
 */
export function renderTurnEndSection(runNumber, moved, fallbackTime) {
  const lines = ["\n---", "## " + "调研 " + runNumber + " 结束 · " + formatLocalTime(fallbackTime), ""];
  if (Array.isArray(moved) && moved.length > 0) {
    lines.push("本次整理 " + moved.length + " 个文件：");
    for (const item of moved) {
      lines.push("- `" + item.category + "/" + item.to + "`");
    }
  } else {
    lines.push("本次未发现需要整理的新文件。");
  }
  lines.push("");
  return lines.join("\n");
}