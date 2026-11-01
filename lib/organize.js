/**
 * dsh-conversation-folders — 文件分类与自动命名（纯函数，可独立单测）。
 *
 * 类别按扩展名划分；分文件夹存储后，文件自动命名为 `调研<N>_<原文件名>`
 * （N 为该会话的调研回合序号）。
 */
export const DEFAULT_CATEGORIES = {
  "01-表格": [".xlsx", ".xls", ".xlsm", ".xltx", ".csv", ".tsv", ".ods", ".dif"],
  "02-图表": [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".tif", ".tiff", ".ico", ".avif", ".jfif"],
  "03-文档": [".docx", ".doc", ".pdf", ".md", ".markdown", ".txt", ".rtf", ".odt", ".odp", ".pptx", ".ppt", ".epub", ".wps", ".pages"],
  "04-数据": [".json", ".jsonl", ".ndjson", ".xml", ".yaml", ".yml", ".parquet", ".arrow", ".db", ".sqlite", ".sqlite3", ".sql", ".feather"],
  "05-代码": [".py", ".js", ".ts", ".mjs", ".cjs", ".jsx", ".tsx", ".java", ".kt", ".c", ".cpp", ".h", ".hpp", ".cs", ".go", ".rs", ".sh", ".ps1", ".bat", ".cmd", ".rb", ".php", ".lua", ".ipynb", ".css", ".scss", ".html", ".htm"],
  "06-压缩包": [".zip", ".rar", ".7z", ".tar", ".gz", ".bz2", ".xz", ".tgz", ".zst"],
  "07-其他": []
};

/**
 * 校验并规范化分类目录名：拒绝空名、"."、".."、路径分隔符与非法字符，
 * 防止自定义分类把文件移出会话文件夹。
 */
export function sanitizeCategoryName(raw) {
  if (typeof raw !== "string") return null;
  let name = raw.trim().replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/[. ]+$/g, "");
  if (name.length === 0 || name === "." || name === "..") return null;
  if (name.length > 40) name = name.slice(0, 40);
  return name;
}

/** 把用户配置的类别覆盖合并进默认类别表（非法类别名直接忽略）。 */
export function mergeCategories(userCategories) {
  if (userCategories === null || typeof userCategories !== "object" || Array.isArray(userCategories)) {
    return DEFAULT_CATEGORIES;
  }
  const merged = {};
  for (const [name, extensions] of Object.entries(DEFAULT_CATEGORIES)) {
    merged[name] = [...extensions];
  }
  for (const [rawName, extensions] of Object.entries(userCategories)) {
    const name = sanitizeCategoryName(rawName);
    if (name === null || !Array.isArray(extensions)) continue;
    merged[name] = extensions.map((ext) => String(ext).toLowerCase().trim()).filter((ext) => ext.length > 0);
  }
  return merged;
}

/** 按扩展名归类文件名；无扩展名也归入 "07-其他"。 */
export function classifyFileName(name, categories = DEFAULT_CATEGORIES) {
  if (typeof name !== "string" || name.length === 0) return "07-其他";
  const index = name.lastIndexOf(".");
  const ext = index > 0 ? name.slice(index).toLowerCase() : "";
  for (const [categoryName, extensions] of Object.entries(categories)) {
    if (ext.length > 0 && extensions.includes(ext)) return categoryName;
  }
  return "07-其他";
}

/** 拆出 "stem" 与 "扩展名(含点)"，便于去重后拼名。 */
export function splitName(name) {
  if (typeof name !== "string" || name.length === 0) return { stem: "file", ext: "" };
  const index = name.lastIndexOf(".");
  if (index <= 0) return { stem: name, ext: "" };
  return { stem: name.slice(0, index), ext: name.slice(index) };
}

/** 自动命名：`<runNamePrefix><N>_<原文件名>`。 */
export function autoNameFor(runNumber, originalName, runNamePrefix = "调研") {
  const prefix = typeof runNamePrefix === "string" && runNamePrefix.length > 0 ? runNamePrefix : "调研";
  const n = Number.isFinite(runNumber) && runNumber > 0 ? runNumber : 1;
  return prefix + n + "_" + originalName;
}

/** 判断文件名是否已经是 `调研N_` 形态（二次整理时跳过，避免前缀叠前缀）。 */
export function isAlreadyNamed(name, runNamePrefix = "调研") {
  if (typeof name !== "string") return false;
  const prefix = typeof runNamePrefix === "string" && runNamePrefix.length > 0 ? runNamePrefix : "调研";
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp("^" + escaped + "[0-9]+_").test(name);
}

/** 把过长的文件名截断到 maxLength（保留扩展名），避免 Windows 路径超长。 */
export function capFileName(name, maxLength = 160) {
  if (typeof name !== "string" || name.length === 0) return "file";
  const max = Number.isFinite(maxLength) && maxLength >= 16 ? Math.floor(maxLength) : 160;
  if (name.length <= max) return name;
  const index = name.lastIndexOf(".");
  const ext = index > 0 ? name.slice(index) : "";
  const stem = index > 0 ? name.slice(0, index) : name;
  const keep = Math.max(8, max - ext.length);
  return stem.slice(0, keep) + ext;
}