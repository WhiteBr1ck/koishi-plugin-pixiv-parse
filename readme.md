# koishi-plugin-pixiv-parse

[![npm](https://img.shields.io/npm/v/koishi-plugin-pixiv-parse?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-pixiv-parse)
[![license](https://img.shields.io/npm/l/koishi-plugin-pixiv-parse?style=flat-square)](https://github.com/WhiteBr1ck/koishi-plugin-pixiv-parse/blob/main/LICENSE)

为 [Koishi](https://koishi.chat/) 提供 Pixiv 链接解析与订阅功能的插件，支持 原图/合并转发/PDF 多种发送方式。现已支持Chatluna工具调用。

## 功能

- **自动解析**：识别聊天内容中的 Pixiv 作品链接并发送作品信息。
- **指令支持**：通过 `pid`、`uid`、`pixivsearch`、`pixivrandom` 等指令，获取指定作品、作者主页、搜索结果或随机热门作品。
- **作者订阅**：提供订阅系统，可定时检查作者更新并推送到指定频道。
- **多样化输出**：支持多图合并转发、自动转换为 PDF、PDF 密码提示等多种发送策略。
- **R-18 内容处理**：可配置对 R-18/R-18G 内容的处理方式。
- **R-18 水印功能**：直发模式下可为 R-18/R-18G 图片添加随机位置水印标识，避免固定位置被识别。
- **图片压缩优化**：直发模式下支持 JPEG 压缩和 PNG 转 JPG，减少发送时的内存占用。
- **主页截图**：利用 Puppeteer 对作者主页进行截图。
- **Pixiv 搜索**：支持关键词搜索、高收藏优先、去重、AI 过滤、R18 策略和多种发送方式。
- **随机热门**：支持随机发送 Pixiv 热门作品，并可单独配置数量、R18 策略和发送方式。
- **ChatLuna 工具**：可选择将搜索和随机热门能力注册为 ChatLuna 工具。

## 安装

在 Koishi 插件市场搜索 `pixiv-parse` 并安装。

## 使用说明

### 链接解析
直接发送 Pixiv 作品链接 (例如 `https://www.pixiv.net/artworks/xxxxxx`)，插件将自动进行解析。

### 指令列表

- `pid <作品ID>`：获取指定 ID 的插画作品。
- `uid <作者ID>`：获取指定 ID 的作者主页信息和截图。
- `pixivsearch <关键词>`：搜索 Pixiv 作品并返回结果，例如 `pixivsearch 初音未来`。
- `pixivrandom [数量]`：随机发送热门 Pixiv 作品，也可以使用中文别名 `试试手气`。
- `pixivcheck`：手动触发所有订阅的更新检查。
- `pixivtest <作者ID>`：测试获取指定作者的最新作品，并发送至当前会话。

### pixivsearch 参数（除了数量其他指令主要给ai看的，日常用在插件配置里设置好就行了）

- `-n <数量>`：本次返回的作品数量。
- `-r <exclude|include|only>`：R18 策略，最终仍受全局 R18 设置限制。
- `-m <auto|direct|forward|pdf>`：发送方式。
- `-q <收藏阈值|off>`：最低收藏数，`off` 表示关闭高收藏阈值。
- `-s <date_desc|date_asc>`：搜索排序。
- `-t <tag|exact|text>`：搜索范围。
- `-a <true|false|on|off>`：是否过滤 AI 作品。
- `-p <first|all>`：多页作品发送策略。

## ⚙️ 配置项说明

### 账户设置
- `refreshToken`: **(必需)** Pixiv API Refresh Token，用于 API 功能。
- `phpsessid`: **(必需)** Pixiv 网页版 Cookie，用于 `uid` 指令截图功能。

### 发送设置
- `r18Action`: 对 R-18 内容的处理策略，默认为 `warn` (发送警告)。

### 插画输出模式设置
- `forwardThreshold`: 图片数量超过该值时，启用合并转发。
- `pdfThreshold`: 图片数量超过该值时，自动转为 PDF 发送。
- `enableDirectCompress`: 【直发模式】是否启用图片压缩以减少发送时的内存占用。
- `directCompressQuality`: 【直发模式】JPEG 图片质量 (1-100)。
- `enablePngToJpeg`: 【直发模式】将 PNG 转为 JPG，并应用 JPEG 压缩质量。透明像素会以白色背景合成。
- `enableR18Watermark`: 【直发模式】对 R-18/R-18G 图片添加随机位置水印，可一定程度上对抗审查。

### 订阅设置
- `enableSubscription`: 订阅功能的总开关。
- `pushBotPlatform` & `pushBotId`: 用于执行推送的机器人平台和账号 ID。
- `subscriptions`: 订阅列表，用于配置作者 UID 和推送的目标频道 ID。

### 搜索设置
- `enableSearch`: 是否启用 `pixivsearch` 指令。
- `searchDefaultCount`: 未指定 `-n` 时默认返回多少个作品。
- `searchMaxCount`: `-n` 指定数量的上限，设为 `0` 表示无上限。
- `searchPreferHighBookmarks`: 是否默认优先搜索高收藏作品。
- `searchDedupEnabled`: 是否启用搜索去重。

### 随机热门设置
- `enableRandom`: 是否启用 `pixivrandom` 指令。
- `randomDefaultCount`: 未填写数量时默认返回多少个作品。
- `randomMaxCount`: 指令填写数量时的上限，设为 `0` 表示无上限。
- `randomDefaultR18`: `pixivrandom` 的默认 R18 策略。

### ChatLuna 工具
- `enableChatLunaTools`: 是否注册 Pixiv 工具到 ChatLuna。
- `chatLunaExposeSearch`: 是否向 ChatLuna 暴露 Pixiv 搜索工具。
- `chatLunaExposeRandom`: 是否向 ChatLuna 暴露 Pixiv 随机热门工具。
- `chatLunaMaxCount`: ChatLuna 单次工具调用最多返回多少个作品，设为 `0` 表示不额外限制。

### 如何获取凭证

#### PHPSESSID

`PHPSESSID` 是用于模拟网页登录状态的 Cookie，获取步骤如下：

1.  在你的电脑浏览器上，访问 [www.pixiv.net](https://www.pixiv.net) 并**登录你的账号**。
2.  登录成功后，按 `F12` 键打开浏览器开发者工具。
3.  在开发者工具中，找到并切换到 **"应用" (Application)** 选项卡。
4.  在左侧菜单中，依次展开 **"Cookie"** -> `https://www.pixiv.net`。
5.  在右侧的 Cookie 列表中，找到名为 `PHPSESSID` 的条目。
6.  复制其 **"值" (Value)** 列下对应的一长串字符串，并粘贴到插件配置中。

#### refreshToken

`refreshToken` 是调用 Pixiv 官方 App API 的凭证。获取过程相对复杂（推荐使用 PixEz 软件），请遵循以下这篇外部教程的步骤来获取：

-   **[Pixiv refresh_token 获取教程 by Nanoka](https://www.nanoka.top/posts/e78ef86/)**

请将教程中最终获取到的 `refresh_token` 字符串粘贴到插件配置中。

## 更新日志

### v0.4.0 (2026-06-24)
- **[新增]** 新增 `pixivsearch` 搜索指令，支持数量、R18 策略、发送方式、收藏阈值、搜索范围、AI 过滤和多页策略。
- **[新增]** 新增 `pixivrandom` 随机热门指令，并提供中文别名 `试试手气`。
- **[新增]** 支持将 Pixiv 搜索和随机热门注册为 ChatLuna 工具，可在配置中分别控制暴露范围。
- **[新增]** 配置页开头加入指令使用说明，并新增右侧悬浮导航。
- **[新增]** 支持搜索去重、GIF 动图处理、PDFKit 生成 PDF 和 PDF 密码单独提示。
- **[优化]** 搜索、随机热门和 ChatLuna 工具的数量上限支持设为 `0`，表示不额外限制返回作品数。
### v0.3.2 (2025-09-03)
- **[新增]** 新增直发模式下 PNG 转 JPG 功能，可配置应用压缩设置。
- **[优化]** R18 水印位置改为随机边缘位置，避免固定位置容易被识别。

### v0.3.1 (2025-08-31)
- **[新增]** 新增直发模式添加水印的功能。

### v0.3.0 (2025-08-31)
- **[新增]** 新增直发模式的图片压缩功能。
- **[修复]** 修复了部分文件名无法正确显示的问题。

### v0.1.2 (2025-07-30)
- **[修复]** 解决了 `accessToken` 过期后插件无法自动刷新的问题。

## 免责声明

1.  本插件仅供学习和个人用途，请在遵守 Pixiv 用户协议的前提下使用。
2.  通过本插件获取的所有内容的版权归原作者所有。
3.  对于任何因不当使用本插件（如用于商业用途、未经授权的分发等）而导致的任何形式的损失或法律纠纷，开发者不承担任何责任。
4.  请勿将此插件用于非法用途。处理 R-18/R-18G 内容时，使用者有责任遵守当地的法律法规。

## License

MIT License © 2025 [WhiteBr1ck](https://github.com/WhiteBr1ck)