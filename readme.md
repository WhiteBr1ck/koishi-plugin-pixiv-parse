# koishi-plugin-pixiv-parse

[![npm](https://img.shields.io/npm/v/koishi-plugin-pixiv-parse?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-pixiv-parse)
[![license](https://img.shields.io/npm/l/koishi-plugin-pixiv-parse?style=flat-square)](https://github.com/WhiteBr1ck/koishi-plugin-pixiv-parse/blob/main/LICENSE)

为 [Koishi](https://koishi.chat/) 提供 Pixiv 链接解析与订阅功能的插件，支持 原图/合并转发/PDF 多种发送方式。

## 功能

- **自动解析**：识别聊天内容中的 Pixiv 作品链接并发送作品信息。
- **指令支持**：通过 `pid` 和 `uid` 指令，获取指定作品或作者主页的信息。
- **作者订阅**：提供订阅系统，可定时检查作者更新并推送到指定频道。
- **多样化输出**：支持多图合并转发、自动转换为 PDF 等多种发送策略。
- **R-18 内容处理**：可配置对 R-18/R-18G 内容的处理方式。
- **主页截图**：利用 Puppeteer 对作者主页进行截图。
- **可配置性**：提供丰富的配置项以自定义插件行为。

## 安装

在 Koishi 插件市场搜索 `pixiv-parse` 并安装。

或通过命令行执行：
```bash
npm install koishi-plugin-pixiv-parse
```

## 使用说明

### 链接解析
直接发送 Pixiv 作品链接 (例如 `https://www.pixiv.net/artworks/xxxxxx`)，插件将自动进行解析。

### 指令列表

- `pid <作品ID>`：获取指定 ID 的插画作品。
- `uid <作者ID>`：获取指定 ID 的作者主页信息和截图。
- `pixivcheck`：手动触发所有订阅的更新检查。
- `pixivtest <作者ID>`：测试获取指定作者的最新作品，并发送至当前会话。

## ⚙️ 配置项说明

### 账户设置
- `refreshToken`: **(必需)** Pixiv API Refresh Token，用于 API 功能。
- `phpsessid`: **(必需)** Pixiv 网页版 Cookie，用于 `uid` 指令截图功能。

### 发送设置
- `r18Action`: 对 R-18 内容的处理策略，默认为 `warn` (发送警告)。

### 插画输出模式设置
- `forwardThreshold`: 图片数量超过该值时，启用合并转发。
- `pdfThreshold`: 图片数量超过该值时，自动转为 PDF 发送。

### 订阅设置
- `enableSubscription`: 订阅功能的总开关。
- `pushBotPlatform` & `pushBotId`: 用于执行推送的机器人平台和账号 ID。
- `subscriptions`: 订阅列表，用于配置作者 UID 和推送的目标频道 ID。

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

## 免责声明

1.  本插件仅供学习和个人用途，请在遵守 Pixiv 用户协议的前提下使用。
2.  通过本插件获取的所有内容的版权归原作者所有。
3.  对于任何因不当使用本插件（如用于商业用途、未经授权的分发等）而导致的任何形式的损失或法律纠纷，开发者不承担任何责任。
4.  请勿将此插件用于非法用途。处理 R-18/R-18G 内容时，使用者有责任遵守当地的法律法规。

## 鸣谢

-   本插件的 Pixiv API 认证及请求部分的实现参考了 [**koishi-plugin-booru-pixiv**](https://www.npmjs.com/package/koishi-plugin-booru-pixiv) 的实现。

## License

MIT License © 2025 [WhiteBr1ck](https://github.com/WhiteBr1ck)