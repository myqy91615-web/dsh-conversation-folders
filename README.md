# dsh-conversation-folders

DSH 插件：**每个会话一个专属文件夹（以对话标题命名）** + **对话记录存档** + **空闲后自动分类归档** + **删除会话时彻底清理**。

> **作者的话**
> 这是我自己做的第一个插件，全代码由 **DeepSeek 大肥鱼** 生成 🐟。
> 新手自用作品，平时用着觉得挺顺手，就分享给大家；可能还有一些我还没发现的 bug（很多知识还在学，不太清楚哪里会出问题）。
> 欢迎大家试用和反馈，希望能和大家一起进步 🙏

## 功能

1. **专属文件夹（以对话标题命名）**：在已创建的工作区内开始对话（发送第一条消息）时，自动在工作区下创建文件夹并把该会话的工作目录指过去——之后助手创建的所有文件（表格、图表、文档…）都落在文件夹里，不污染工作区根目录。文件夹名尽量与侧边栏显示的**对话标题一致**（`会话-<对话标题>`）；标题尚未生成时先用 `会话-<短ID>`，等对话空闲整理时再一次性改为标题名。
2. **对话记录存档**：用户消息与助手回复自动追加写入文件夹根目录的 `对话记录.md`。若插件在对话进行中才启用，或记录文件被删除，会从会话日志自动回填此前的全部真实对话（合成上下文消息不记录）。
3. **空闲后自动分门别类 + 自动命名**：**对话进行中不会移动任何文件**（在对话里看到的文件路径始终有效，可随时打开）。当一个会话**结束、长时间没有新任务**（默认连续 10 分钟没有任何会话事件）后，才把文件夹根目录的散落文件按类型移入分类子文件夹，并自动命名为 `调研<N>_<原文件名>`（N 为该会话的整理序号，只有确实移动了文件才递增），同时在 `对话记录.md` 里追加一段「整理」小结：
   - `01-表格/`（xlsx、csv、ods…）
   - `02-图表/`（png、jpg、svg、webp…）
   - `03-文档/`（docx、pdf、md、pptx…）
   - `04-数据/`（json、parquet、sqlite、sql…）
   - `05-代码/`（py、js、ts、html…）
   - `06-压缩包/`（zip、rar、7z、tar…）
   - `07-其他/`
4. **删除会话 → 彻底删除（含菜单入口）**：会话「…」菜单里新增 **「删除对话及其内容」**（位于「归档会话」与「复制 ID」之间），点击后弹出自定义确认框，文案为 **「将会删除对话及其所有内容，请谨慎考虑。」**；确认后删除该对话、会话持久化产物、会话文件夹（对话记录 + 分类文件）与状态映射，**不过回收站**（Windows 下先清除只读属性再递归删除并校验）。关机或停止会话不会误删文件夹。
5. **惰性分配**：仅新建空白占位会话不会产生文件夹，真正发送第一条消息才分配，避免空文件夹堆积。
6. **侧栏管理面板**：侧栏「更多」里新增 **「会话文件夹」** 入口（文件夹图标，与插件图标一致），打开后是一个管理页：当前的插件版本、已映射会话数、文件夹存在数、空闲整理间隔、待整理数量，以及每个会话对应的文件夹列表——每行可 **打开文件夹**（资源管理器）或 **立即整理**（不必等空闲），右上角还有 **刷新** 与 **检查更新**（对比 GitHub 仓库的最新版本）。
7. **归档后原路径仍可直接点开**：文件被移入 `01-表格/` 等分类文件夹后，在其原文件名处保留一个**硬链接**（与归档文件是同一份数据，不占额外空间）；文件夹按标题改名后，在旧短 ID 路径处保留一个**目录联接**。这样对话里已经展示过的文件链接（相对路径或绝对路径）**不再失效**——点击依旧能直接在侧栏预览/打开，无需再去翻文件夹。删除会话时这些入口会一并彻底删除。
8. **输出目录（生产内容随你挑地方存）**：对话第一次开始时自动弹出一个**系统目录选择框**，让你自己选择「输出目录」（不固定桌面，想放哪放哪）；每次空闲整理后，把归档好的生产文件（`调研<N>_*`）**复制**到 `<输出目录>/<会话文件夹名>/` 一份，方便直接提取；删除会话时该副本**一并彻底删除**，不会留垃圾。不需要的话在弹框里点“取消”即可，之后仍可在侧栏管理面板里手动设置。

> 会话菜单与侧栏面板由客户端半区提供（`client.js` + `package.json` 的 `dsh.client`）。安装或升级后需**刷新页面**（必要时重启 DSH）让客户端模块生效。

## 目录结构示例

```
D:\deepseek工作区\
├─ 会话-白酒行业调研\
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

已收录到 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 插件列表，详情页：<https://awesome-dsh-plugin.com/p/myqy91615-web/dsh-conversation-folders/>

通过 CLI 从 GitHub 安装（推荐）：

```powershell
dsh plugin --profile desktop add github:myqy91615-web/dsh-conversation-folders
```

也可以在 DSH 的「插件」管理界面添加，或下载本仓库后以本地路径 / `file:` 方式安装（本目录的开发版即以 `file:` 链接方式安装，见 profile 的 `package.json`）。

> 注意：本包**尚未发布到 npm**，所以 `dsh plugin add npm:dsh-conversation-folders` 要等 [发布到 npm](#发布到插件市场dsh-market) 后才可用；现在请用上面的 GitHub 命令。

安装或升级后需**刷新页面**（必要时重启 DSH），让 `client.js`（会话菜单里的「删除对话及其内容」）生效。

## 配置

在 `cordis.patch.yml` 中可设（键均可省略）：

```yaml
- id: dsh-conversation-folders
  name: dsh-conversation-folders
  config:
    enabled: true            # 关闭后停止管理文件夹（已有文件夹与映射不删除）
    folderPrefix: 会话-       # 会话文件夹名前缀，实际名 会话-<对话标题>（无标题时暂用短 ID）
    transcriptName: 对话记录.md  # 对话记录文件名
    categorize: true         # 空闲后自动分类归档
    runNamePrefix: 调研       # 自动命名前缀：调研<N>_<原文件名>
    idleDelayMs: 600000      # 对话空闲多久后才整理（毫秒）；期间有新任务就重新计时；0 关闭自动整理
    renameToTitle: true      # 空闲整理时把短 ID 文件夹改名为对话标题（只改一次）
    keepPaths: true          # 归档后保留原路径入口（硬链接/目录联接），旧文件链接依旧可打开
    chooseOutputDir: true    # 对话第一次开始时自动弹「输出目录」选择框（取消则跳过，面板可手动设置）
    deleteTimeoutMs: 12000   # 删除后等待会话产物消失的最长毫秒数
    # categories:            # 可选：覆盖扩展名分类表 { 分类名: [扩展名…] }
```

## 验证

1. 在某个工作区内新建对话并发送一条消息；
2. 检查工作区目录：应出现 `会话-<标题>/`（标题未生成时为短 ID），内含 `对话记录.md`；
3. 让助手创建表格/图表等文件——**对话进行中这些文件仍在文件夹根目录，随时可打开**；
4. 停止对话 10 分钟（或把 `idleDelayMs` 调小）后：文件自动进入 `01-表格/` 等分类文件夹并带 `调研1_` 前缀，文件夹名改为对话标题，`对话记录.md` 追加「整理」小结；
5. **回到对话里点击整理前的文件链接：依旧能直接打开**（原路径保留硬链接/目录联接，无需翻文件夹）；
6. 删除该对话：文件夹连同全部内容一并消失（不经过回收站），旧路径入口也一并清除；
7. 对话开始时弹出的目录选择框里选一个输出目录 → 整理后到 `<输出目录>/<会话文件夹名>/` 查看生产文件副本；删除对话后该副本也一并消失。

插件运行状态可查询：

- `GET /conversation-folders/api/status` — 映射统计、`idleDelayMs`、`pendingIdle`（等待整理的会话数）
- `GET /conversation-folders/api/mappings` — 全部映射详情
- `POST /conversation-folders/api/organize-session`（body `{"sessionId":"…"}`）— 立即整理某个会话，不必等空闲
- `POST /conversation-folders/api/delete-session`（body `{"sessionId":"…"}`）— 删除对话及其全部内容
- `POST /conversation-folders/api/open-folder`（body `{"sessionId":"…"}`）— 在资源管理器打开该会话文件夹（面板按钮用）
- `POST /conversation-folders/api/repair-paths`（body 可带 `{"sessionId":"…"}`，缺省全部）— 为已归档/已改名的会话补齐原路径入口
- `GET /conversation-folders/api/latest-version` — 对比 GitHub 仓库 `main` 的最新版本（面板「检查更新」用）
- `POST /conversation-folders/api/set-output-dir`（body `{"sessionId":"…","dir":"…"}`）— 手动设置输出目录（需绝对路径，且不能位于会话文件夹内部）
- `POST /conversation-folders/api/pick-output-dir`（body `{"sessionId":"…"}`）— 重新弹出目录选择框让用户选择输出目录
- `POST /conversation-folders/api/open-output-dir`（body `{"sessionId":"…"}`）— 在资源管理器打开该会话的输出目录（面板按钮用）

## 原理

- **不动 header.cwd**：通过持久化的 `working-directory/change` 会话事件引导工作目录（DSH 内置 workingDirectory 投影折叠该事件），侧边栏工作区分组完全不受影响；
- **文件夹命名**：分配时尝试从 `sessionTitle` 服务读取当前对话标题，读不到则先用短 ID；空闲整理时再按标题把文件夹改名为 `会话-<标题>`（只改一次，标题之后再变化不再移动文件，避免已经展示过的文件链接反复失效）；
- **空闲整理**：监听 `session/event`，任何事件都会重置该会话的空闲计时器；计时器到点后只整理最后一回合已结束（最后一条回合类事件是 `turn/end`）的会话，进行中的对话不会被移动文件；
- **原路径保活**：归档时在原始文件名处创建指向归档文件的硬链接（NTFS 同一分区上即是同一份数据，零额外空间；跨卷自动降级为复制），并把「原名 → 分类相对路径」记入状态；文件夹按标题改名时在旧短 ID 路径处创建目录联接（junction），旧绝对路径依旧可解析；启动对账与每次整理都会补齐缺失的入口、清理失效入口，删除会话时入口随文件夹一并删除；
- **输出目录**：对话第一次分配文件夹时，若配置了 `chooseOutputDir` 且有系统目录选择服务（`directoryPicker.capability()` 为 `native`），自动弹选择框并只询问一次（取消后可在面板手动设置）；每次空闲整理后把归档的生产文件复制到 `<输出目录>/<会话文件夹名>/`（幂等：已存在的同名文件跳过）；删除会话时把输出目录里该会话的文件夹连同内容一并彻底删除（realpath 校验防穿越），输出根目录本身保留；
- **对话记录**：监听 `session/event` 的 `user/message`、`assistant/message` 写入 markdown；只记录 `source.kind === "user"` 的真实用户输入（runtime-context / skill-catalog / time-context 等合成消息不记录）；记录文件缺失时从会话事件日志回填全部历史对话；
- **删除检测**：`session/disposed` 后轮询磁盘上的会话产物目录（`~/.dsh/sessions/...`），确认产物消失（真正的"删除会话"动作，例如 dsh-session-manager 的删除流程）后才删除文件夹；关机/停止会话产物仍在，文件夹保留；
- **安全校验**：所有删除动作经过 realpath 正规化 + 父目录精确匹配 + 非符号链接/文件检查，杜绝误删；删除后校验目标确已消失并重试。

## 发布到插件市场（DSH Market）

**当前状态**

- ✅ 已收录 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 列表：PR [#11096](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/11096) 已合并，条目为 `data/plugins/myqy91615-web__dsh-conversation-folders.yml`；
- ✅ 官网详情页已上线：<https://awesome-dsh-plugin.com/p/myqy91615-web/dsh-conversation-folders/>；
- ⏳ 「应用内市场 Discover」索引（npm 包 `dsh-plugin-catalog`）**只收录已发布到 npm 的插件**，所以还需要一步 `npm publish` 才能被市场搜索到。

**发布到 npm（可选，做了就能进市场索引）**

1. 注册/登录 npm 账号：`npm login`；
2. 在仓库根目录发布：`npm publish`（包名 `dsh-conversation-folders` 已验证可用；`package.json` 已含 `repository` 字段）；
3. 市场每日重建索引后即可在「插件 → Discover」搜索安装；README 里的 `npm:dsh-conversation-folders` 命令也会随之可用；
4. 可选：放置 `screenshots.json`（1–8 张 GitHub 托管图片）让市场详情页展示截图。

市场收录后可从 [awesome-dsh-plugin.com](https://awesome-dsh-plugin.com) 的目录一键安装，或直接用上面的 GitHub 命令。

## 限制

- 仅整理会话文件夹**根目录**的散落文件；已有子目录与其中的文件不会被打散；
- 被其他程序占用中的文件（如 Excel 打开中的 xlsx）可能无法移动，稍后重试仍失败则保留原位并记日志；
- 删除等待上限默认 12 秒：超时仍未确认会话产物消失则保留文件夹（视为停止而非删除）。

## License

MIT