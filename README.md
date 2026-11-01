# dsh-conversation-folders

DSH 插件：**每个会话一个专属文件夹** + **对话记录存档** + **调研后自动分类归档** + **删除会话时彻底清理**。

> **作者的话**
> 这是我自己做的第一个插件，全代码由 **DeepSeek 大肥鱼** 生成 🐟。
> 新手自用作品，平时用着觉得挺顺手，就分享给大家；可能还有一些我还没发现的 bug（很多知识还在学，不太清楚哪里会出问题）。
> 欢迎大家试用和反馈，希望能和大家一起进步 🙏

## 功能

1. **专属文件夹**：在已创建的工作区内开始对话（发送第一条消息）时，自动在工作区下创建 `会话-<短ID>/` 文件夹，并把该会话的工作目录指过去——之后助手创建的所有文件（表格、图表、文档…）都落在文件夹里，不污染工作区根目录。
2. **对话记录存档**：用户消息与助手回复自动追加写入文件夹根目录的 `对话记录.md`（每次调研结束还会追加一段"调研 N 结束"小结，列出本次整理的文件）。若插件在对话进行中才启用，或记录文件被删除，会从会话日志自动回填此前的全部真实对话（合成上下文消息不记录）。
3. **调研后自动分门别类 + 自动命名**：每次调研（一个回合）结束，文件夹根目录的散落文件按类型自动移入分类子文件夹，并自动命名为 `调研<N>_<原文件名>`（N 为该会话的调研序号）：
   - `01-表格/`（xlsx、csv、ods…）
   - `02-图表/`（png、jpg、svg、webp…）
   - `03-文档/`（docx、pdf、md、pptx…）
   - `04-数据/`（json、parquet、sqlite、sql…）
   - `05-代码/`（py、js、ts、html…）
   - `06-压缩包/`（zip、rar、7z、tar…）
   - `07-其他/`
4. **删除会话 → 彻底删除（含菜单入口）**：会话「…」菜单里新增 **「删除对话及其内容」**（位于「归档会话」与「复制 ID」之间），点击后弹出自定义确认框，文案为 **「将会删除对话及其所有内容，请谨慎考虑。」**；确认后删除该对话、会话持久化产物、会话文件夹（对话记录 + 分类文件）与状态映射，**不过回收站**（Windows 下先清除只读属性再递归删除并校验）。关机或停止会话不会误删文件夹。
5. **惰性分配**：仅新建空白占位会话不会产生文件夹，真正发送第一条消息才分配，避免空文件夹堆积。

> 会话菜单由客户端半区提供（`client.js` + `package.json` 的 `dsh.client`）。安装或升级后需**刷新页面**（必要时重启 DSH）让客户端模块生效。

## 目录结构示例

```
D:\deepseek工作区\
├─ 会话-29c06ebbe914\
│  ├─ 对话记录.md
│  ├─ 01-表格\
│  │  └─ 调研1_行业数据对比.xlsx
│  ├─ 02-图表\
│  │  └─ 调研1_趋势图.png
│  └─ 03-文档\
│     └─ 调研1_研究报告.md
└─ 其他工作区内容…
```

## 安装

在 DSH 的「插件」管理界面添加 `dsh-conversation-folders`，或通过 CLI：

```powershell
dsh plugin --profile desktop add npm:dsh-conversation-folders
```

本目录的开发版以 `file:` 方式链接安装（见 profile 的 `package.json`）。

## 配置

在 `cordis.patch.yml` 中可设（键均可省略）：

```yaml
- id: dsh-conversation-folders
  name: dsh-conversation-folders
  config:
    enabled: true            # 关闭后停止管理文件夹（已有文件夹与映射不删除）
    folderPrefix: 会话-       # 会话文件夹名前缀，实际名 会话-<短ID>
    transcriptName: 对话记录.md  # 对话记录文件名
    categorize: true         # 调研结束后自动分类归档
    runNamePrefix: 调研       # 自动命名前缀：调研<N>_<原文件名>
    deleteTimeoutMs: 12000   # 删除后等待会话产物消失的最长毫秒数
    # categories:            # 可选：覆盖扩展名分类表 { 分类名: [扩展名…] }
```

## 验证

1. 在某个工作区内新建对话并发送一条消息；
2. 检查工作区目录：应出现 `会话-<短ID>/`，内含 `对话记录.md`；
3. 让助手创建表格/图表等文件，回合结束后文件自动进入 `01-表格/` 等分类文件夹并带 `调研1_` 前缀；
4. 删除该对话：`会话-<短ID>/` 连同全部内容一并消失（不经过回收站）。

插件运行状态可查询：

- `GET /conversation-folders/api/status` — 映射统计
- `GET /conversation-folders/api/mappings` — 全部映射详情

## 原理

- **不动 header.cwd**：通过持久化的 `working-directory/change` 会话事件引导工作目录（DSH 内置 workingDirectory 投影折叠该事件），侧边栏工作区分组完全不受影响；
- **对话记录**：监听 `session/event` 的 `user/message`、`assistant/message` 写入 markdown；只记录 `source.kind === "user"` 的真实用户输入（runtime-context / skill-catalog / time-context 等合成消息不记录）；记录文件缺失时从会话事件日志回填全部历史对话；
- **删除检测**：`session/disposed` 后轮询磁盘上的会话产物目录（`~/.dsh/sessions/...`），确认产物消失（真正的"删除会话"动作，例如 dsh-session-manager 的删除流程）后才删除文件夹；关机/停止会话产物仍在，文件夹保留；
- **安全校验**：所有删除动作经过 realpath 正规化 + 父目录精确匹配 + 非符号链接/文件检查，杜绝误删；删除后校验目标确已消失并重试。

## 发布到插件市场（DSH Market）

本包已满足 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 收录的硬性要求：`package.json` 声明 `dsh.bundle`、可独立安装、真实可运行代码、MIT 许可、无安装期脚本。

1. 把本仓库推送到 GitHub（仓库需创建满 1 天，CI 自动检查），并给仓库加 `dsh-plugin` topic；
2. 向 registry 提一个 PR，新增 `data/plugins/<owner>__dsh-conversation-folders.yml`，内容模板见 [`market-entry.yml`](./market-entry.yml)（把 `<OWNER>` 换成你的 GitHub 用户名）；
3. 可选：`npm publish` 发布为 `dsh-conversation-folders`（包名已验证可用），并在 `package.json` 里补 `repository` 字段指回仓库，市场会展示下载量；
4. 可选：放置 `screenshots.json`（1–8 张 GitHub 托管图片）让市场详情页展示截图。

市场收录后会从 [awesome-dsh-plugin.com](https://awesome-dsh-plugin.com) 的目录一键安装。

## 限制

- 仅整理会话文件夹**根目录**的散落文件；已有子目录与其中的文件不会被打散；
- 被其他程序占用中的文件（如 Excel 打开中的 xlsx）可能无法移动，稍后重试仍失败则保留原位并记日志；
- 删除等待上限默认 12 秒：超时仍未确认会话产物消失则保留文件夹（视为停止而非删除）。

## License

MIT