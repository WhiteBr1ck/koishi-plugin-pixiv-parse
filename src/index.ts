import { Context, Schema, Logger, h, Session, Next, sleep, Time } from 'koishi'
import { promises as fs, createWriteStream } from 'fs'
import { once } from 'events'
import path from 'path'
import PDFDocument from 'pdfkit'
import sharp from 'sharp'
import type Puppeteer from 'koishi-plugin-puppeteer'
import type {} from '@koishijs/plugin-console'

export const name = 'pixiv-parse'
export const usage = [
  '',
  '---',
  '',
  '## Pixiv Parse 指令说明',
  '',
  '### 常用指令',
  '',
  '- `pid <作品ID>`：获取指定 Pixiv 作品。',
  '- `uid <作者ID>`：获取指定 Pixiv 作者主页信息和截图。',
  '- `pixivsearch <关键词>`：搜索 Pixiv 作品，例如 `pixivsearch 初音未来`。',
  '- `pixivrandom [数量]`：随机发送热门 Pixiv 作品，也可以使用中文别名 `试试手气`。',
  '- `pixivcheck`：手动检查所有订阅更新。',
  '- `pixivtest <作者ID>`：测试指定作者的最新作品推送。',
  '',
  '### 搜索参数',
  '',
  '`pixivsearch` 支持以下可选参数：',
  '',
  '- `-n <数量>`：本次返回的作品数量。',
  '- `-r <exclude|include|only>`：R18 策略。',
  '- `-m <auto|direct|forward|pdf>`：发送方式。',
  '- `-q <收藏阈值|off>`：最低收藏数，`off` 表示关闭高收藏阈值。',
  '- `-s <date_desc|date_asc>`：搜索排序。',
  '- `-t <tag|exact|text>`：搜索范围。',
  '- `-a <true|false|on|off>`：是否过滤 AI 作品。',
  '- `-p <first|all>`：多页作品发送策略。',
  '',
  '### 数量上限',
  '',
  '搜索、随机热门和 ChatLuna 工具的“最多返回多少个作品”配置项，设置为 `0` 时表示不额外限制数量。实际返回数量仍会受 Pixiv 接口、候选数量、去重和下载结果影响。',
  '',
  '---',
].join('\n')
export const inject = {
  required: ['http', 'database'], optional: ['puppeteer', 'console', 'ffmpeg', 'chatluna'],
}

const logger = new Logger(name)

declare module 'koishi' {
  interface Context {
    puppeteer: Puppeteer
    ffmpeg?: FFmpegService
  }
  interface Tables {
    pixiv_last_artworks: {
      author_id: string
      last_artwork_id: string
    }
    pixiv_search_history: {
      id: number
      scope_key: string
      keyword: string
      image_key: string
      created_at: Date
    }
  }
}


export type Subscription = {
  uid: string
  name: string
  channelIds: string[]
}

type SearchR18Mode = 'exclude' | 'include' | 'only'
type SearchSendMode = 'auto' | 'direct' | 'forward' | 'pdf'
type SearchTarget = 'tag' | 'exact' | 'text'
type SearchSort = 'date_desc' | 'date_asc'
type SearchPagePolicy = 'first' | 'all'
type SearchDedupScope = 'channel' | 'global'
type MessageContent = h[] | h | string
type MessagePayload = MessageContent | { message: MessageContent; pdfPassword?: string }
type PdfImageInput = { buffer: Buffer; mime?: string }

type FFmpegService = {
  builder(): {
    input(path: string | Buffer): any
    inputOption(...option: string[]): any
    outputOption(...option: string[]): any
    run(type: 'file', path: string): Promise<void>
  }
}


export interface Config {
  refreshToken?: string
  phpsessid?: string
  enableLinkParse: boolean
  sendTags: boolean
  sendAuthor: boolean
  sendLinkWithCommand: boolean
  r18Action: 'block' | 'warn' | 'send'
  forwardThreshold: number
  pdfThreshold: number
  autoPdfForR18: boolean
  pdfPassword?: string
  sendPdfPassword: boolean
  pdfSendMode: 'buffer' | 'file'
  enableCompression: boolean
  compressionQuality: number
  enableDirectCompress: boolean
  directCompressQuality: number
  downloadConcurrency: number
  enableUidCommand: boolean
  sendUserInfoText: boolean
  clientId: string
  clientSecret: string
  debug: boolean
  enableSubscription: boolean
  updateInterval?: number
  subscriptions?: Subscription[]
  pushBotPlatform?: string
  pushBotId?: string
  enableR18Watermark: boolean
  enablePngToJpeg: boolean
  enableSearch: boolean
  searchDefaultCount: number
  searchMaxCount: number
  searchPreferHighBookmarks: boolean
  searchDefaultMinBookmarks: number
  searchFallbackMinBookmarks: boolean
  searchCandidateLimit: number
  searchDefaultR18: SearchR18Mode
  searchDefaultSendMode: SearchSendMode
  searchDefaultTarget: SearchTarget
  searchDefaultSort: SearchSort
  searchExcludeAI: boolean
  searchDefaultPagePolicy: SearchPagePolicy
  searchDedupEnabled: boolean
  searchDedupScope: SearchDedupScope
  searchDedupTtlHours: number
  searchDedupMaxRecordsPerKeyword: number
  randomDefaultCount: number
  randomMaxCount: number
  enableRandom: boolean
  randomDefaultR18: SearchR18Mode
  randomDefaultSendMode: SearchSendMode
  randomDefaultPagePolicy: SearchPagePolicy
  randomExcludeAI: boolean
  randomDedupEnabled: boolean
  enableChatLunaTools: boolean
  chatLunaExposeSearch: boolean
  chatLunaExposeRandom: boolean
  chatLunaSearchToolName: string
  chatLunaRandomToolName: string
  chatLunaMaxCount: number
  chatLunaAllowR18: boolean
  chatLunaAllowSendModeOverride: boolean
  chatLunaDefaultSendMode: SearchSendMode
}

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    refreshToken: Schema.string().role('secret').description('Pixiv API Refresh Token。用于 API 请求。'),
    phpsessid: Schema.string().role('secret').description('Pixiv 网页版 Cookie (PHPSESSID)。用于 Puppeteer 截图。'),
  }).description('账户设置'),
  
  Schema.object({
    enableLinkParse: Schema.boolean().description('是否自动解析聊天中的 Pixiv 作品链接。关闭后仅保留指令调用。').default(true),
    sendTags: Schema.boolean().description('发送作品时，是否附带标签。').default(true),
    sendAuthor: Schema.boolean().description('发送作品时，是否附带作者信息。').default(true),
    sendLinkWithCommand: Schema.boolean().description('当使用指令时，是否在消息中一并发送作品的源链接。').default(false),
    r18Action: Schema.union([
      Schema.const('block').description('屏蔽 R-18 作品'),
      Schema.const('warn').description('发送警告并附带作品信息 (不发图)'),
      Schema.const('send').description('直接发送 (后果自负)'),
    ]).description('【最高优先级】如何处理 R-18/R-18G 作品。').default('warn'),
  }).description('发送设置'),

  Schema.object({
    forwardThreshold: Schema.number().min(0).step(1).description('【插画】图片数量超过此值时，将启用合并转发。设为 0 则彻底禁用此功能。').default(3),
    pdfThreshold: Schema.number().min(0).step(1).description('【插画】图片数量超过此值时，将自动转为 PDF 发送。优先级高于合并转发。设为 0 则永不转为 PDF。').default(10),
    autoPdfForR18: Schema.boolean().description('【插画】当 R-18 作品被允许发送时，是否自动转为 PDF 发送（无视图片数量）。').default(true),
    pdfPassword: Schema.string().role('secret').description('（可选）为生成的 PDF 文件设置一个打开密码。'),
    sendPdfPassword: Schema.boolean().description('【PDF模式】发送加密 PDF 后，是否额外发送当前 PDF 密码。仅在已配置 PDF 密码时生效。').default(false),
    
    pdfSendMode: Schema.union([
      Schema.const('buffer').description('buffer (内存模式)'),
      Schema.const('file').description('file (硬盘模式)')
    ]).description('【PDF模式】发送方式。Docker 环境请选择 buffer 。').default('buffer'),
    enableCompression: Schema.boolean().description('【PDF模式】是否启用图片压缩以减小 PDF 文件体积。').default(true),
    compressionQuality: Schema.number().min(1).max(100).step(1).role('slider').default(80)
      .description('【PDF模式】JPEG 图片质量 (1-100)。注意：JPEG为有损压缩，100为最高质量而非无损。'),
    
    enableDirectCompress: Schema.boolean().description('【直发模式】是否启用图片压缩以减少发送时的内存占用。').default(false),
    directCompressQuality: Schema.number().min(1).max(100).step(1).role('slider').default(80)
      .description('【直发模式】JPEG 图片质量 (1-100)。PNG 图片会进行无损压缩；若启用"PNG 转 JPG"则按此 JPEG 质量压缩。'),
    enableR18Watermark: Schema.boolean().description('【直发模式】（优先级低于转PDF，高于图片压缩和合并转发）对 R-18/R-18G 图片添加右下角 "R18" 水印，可一定程度上对抗QQ的审查。').default(false),
    enablePngToJpeg: Schema.boolean().description('【直发模式】将 PNG 转为 JPG，并应用上方的 JPEG 压缩质量。透明像素会以白色背景合成。').default(false),
  }).description('插画输出模式设置'),
  
  Schema.object({
    enableUidCommand: Schema.boolean().description('是否启用 `uid` 指令来获取作者主页截图。<b>注意：必须安装并启用 `puppeteer` 服务插件才能使用此功能。</b>').default(true),
    sendUserInfoText: Schema.boolean().description('发送作者主页截图时，是否同时发送作者的文本信息（昵称、简介等）。').default(true),
  }).description('作者主页 (UID) 设置'),
  
  Schema.object({
    enableSubscription: Schema.boolean().description('**【总开关】是否启用订阅功能。** 开启后会显示详细设置。').default(false),
  }).description('订阅设置'),
  Schema.union([
      Schema.object({
          enableSubscription: Schema.const(false),
      }),
      Schema.object({
          enableSubscription: Schema.const(true),
          updateInterval: Schema.number().min(1).description('每隔多少分钟检查一次更新。').default(30),
          pushBotPlatform: Schema.string().description('用于执行推送的机器人平台 (例如: onebot)。').required(),
          pushBotId: Schema.string().description('用于执行推送的机器人账号/ID (例如: 12345678)。').required(),
          subscriptions: Schema.array(Schema.object({
            uid: Schema.string().description('作者的 UID (纯数字)'),
            name: Schema.string().description('作者名字 (仅用于备注)'),
            channelIds: Schema.array(String).role('table').description('要推送到的频道/群组ID列表 (纯数字)。'),
          })).collapse().description('订阅列表。可使用右侧按钮展开或折叠全部订阅，订阅较多时更方便管理。'),
      }),
  ]),

  Schema.object({
    enableSearch: Schema.boolean().description('是否启用 `pixivsearch` 指令。').default(true),
    searchDefaultCount: Schema.number().min(1).max(20).step(1).description('搜索指令未使用 `-n` 时默认返回多少个作品。').default(1),
    searchMaxCount: Schema.number().min(0).max(20).step(1).description('搜索指令允许 `-n` 指定数量时的上限，设为 0 表示无上限。').default(5),
    searchPreferHighBookmarks: Schema.boolean().description('默认是否优先搜索高收藏作品。关闭后按 Pixiv 普通搜索结果随机取图。').default(true),
    searchDefaultMinBookmarks: Schema.number().min(0).step(100).description('默认高收藏阈值。设为 0 表示不限制收藏数。').default(1000),
    searchFallbackMinBookmarks: Schema.boolean().description('高收藏候选不足时，是否自动降低收藏阈值并继续搜索。').default(true),
    searchCandidateLimit: Schema.number().min(10).max(300).step(10).description('每次搜索最多收集多少个候选作品。数值越高，请求次数可能越多。').default(60),
    searchDefaultR18: Schema.union([
      Schema.const('exclude').description('排除 R-18/R-18G'),
      Schema.const('include').description('允许混入 R-18/R-18G'),
      Schema.const('only').description('只搜索 R-18/R-18G'),
    ]).description('搜索默认 R18 策略。最终仍受上方 R18 处理总开关限制。').default('exclude'),
    searchDefaultSendMode: Schema.union([
      Schema.const('auto').description('按现有阈值自动选择直发、合并转发或 PDF'),
      Schema.const('direct').description('强制直发图片'),
      Schema.const('forward').description('强制合并转发'),
      Schema.const('pdf').description('强制生成 PDF'),
    ]).description('搜索结果默认发送方式。').default('direct'),
    searchDefaultTarget: Schema.union([
      Schema.const('tag').description('标签部分匹配'),
      Schema.const('exact').description('标签完全匹配'),
      Schema.const('text').description('标题和简介搜索'),
    ]).description('默认搜索范围。').default('tag'),
    searchDefaultSort: Schema.union([
      Schema.const('date_desc').description('从新到旧'),
      Schema.const('date_asc').description('从旧到新'),
    ]).description('默认排序。没有 Pixiv Premium 时不使用热门排序。').default('date_desc'),
    searchExcludeAI: Schema.boolean().description('默认是否过滤 Pixiv 标记为 AI 生成的作品。').default(true),
    searchDefaultPagePolicy: Schema.union([
      Schema.const('first').description('多页作品只发送第一页'),
      Schema.const('all').description('多页作品发送全部页面'),
    ]).description('搜索命中多页作品时发送哪些页面。此选项不会决定作品数量，作品数量由默认数量或 `-n` 决定。').default('first'),
    searchDedupEnabled: Schema.boolean().description('是否启用搜索去重。只在作品成功发送后写入记录。').default(true),
    searchDedupScope: Schema.union([
      Schema.const('channel').description('每个群组单独去重'),
      Schema.const('global').description('全局去重'),
    ]).description('搜索去重的生效范围。').default('channel'),
    searchDedupTtlHours: Schema.number().min(1).max(720).step(1).description('去重记录保留小时数。').default(72),
    searchDedupMaxRecordsPerKeyword: Schema.number().min(10).max(1000).step(10).description('同一关键词最多保留多少条去重记录。').default(100),
  }).description('搜索设置'),

  Schema.object({
    enableRandom: Schema.boolean().description('是否启用 `pixivrandom` 指令。').default(true),
    randomDefaultCount: Schema.number().min(1).max(20).step(1).description('`pixivrandom` 未填写数量时默认返回多少个作品。').default(1),
    randomMaxCount: Schema.number().min(0).max(20).step(1).description('`pixivrandom` 后面填写数量时的上限，设为 0 表示无上限。').default(5),
    randomDefaultR18: Schema.union([
      Schema.const('exclude').description('排除 R-18/R-18G'),
      Schema.const('include').description('允许混入 R-18/R-18G'),
      Schema.const('only').description('只随机 R-18/R-18G'),
    ]).description('`pixivrandom` 的默认 R18 策略。最终仍受上方 R18 处理总开关限制。').default('exclude'),
    randomDefaultSendMode: Schema.union([
      Schema.const('auto').description('按现有阈值自动选择直发、合并转发或 PDF'),
      Schema.const('direct').description('强制直发图片'),
      Schema.const('forward').description('强制合并转发'),
      Schema.const('pdf').description('强制生成 PDF'),
    ]).description('`pixivrandom` 的默认发送方式。').default('direct'),
    randomDefaultPagePolicy: Schema.union([
      Schema.const('first').description('多页作品只发送第一页'),
      Schema.const('all').description('多页作品发送全部页面'),
    ]).description('`pixivrandom` 抽到多页作品时发送哪些页面。').default('first'),
    randomExcludeAI: Schema.boolean().description('`pixivrandom` 默认是否过滤 Pixiv 标记为 AI 生成的作品。').default(true),
    randomDedupEnabled: Schema.boolean().description('`pixivrandom` 是否启用去重。去重范围沿用搜索去重的生效范围。').default(true),
  }).description('随机热门设置'),

  Schema.object({
    enableChatLunaTools: Schema.boolean().description('是否注册 Pixiv 工具到 ChatLuna。关闭后 ChatLuna 不会看到本插件工具。').default(false),
    chatLunaExposeSearch: Schema.boolean().description('是否向 ChatLuna 暴露 Pixiv 搜索工具。').default(true),
    chatLunaExposeRandom: Schema.boolean().description('是否向 ChatLuna 暴露 Pixiv 随机热门工具。').default(true),
    chatLunaSearchToolName: Schema.string().description('注册到 ChatLuna 的搜索工具名称。').default('pixiv_search'),
    chatLunaRandomToolName: Schema.string().description('注册到 ChatLuna 的随机热门工具名称。').default('pixiv_random'),
    chatLunaMaxCount: Schema.number().min(0).max(20).step(1).description('ChatLuna 单次工具调用最多返回多少个作品。设为 0 表示不额外限制，仍会受到搜索和随机热门各自上限限制。').default(5),
    chatLunaAllowR18: Schema.boolean().description('是否允许 ChatLuna 工具请求 R18 内容。关闭后会强制排除 R18。').default(false),
    chatLunaAllowSendModeOverride: Schema.boolean().description('是否允许 ChatLuna 临时指定发送方式。关闭后始终使用下方默认发送方式。').default(true),
    chatLunaDefaultSendMode: Schema.union([
      Schema.const('auto').description('按现有阈值自动选择直发、合并转发或 PDF'),
      Schema.const('direct').description('强制直发图片'),
      Schema.const('forward').description('强制合并转发'),
      Schema.const('pdf').description('强制生成 PDF'),
    ]).description('ChatLuna 工具默认发送方式。').default('direct'),
  }).description('ChatLuna 工具'),

  Schema.object({
    downloadConcurrency: Schema.number().min(1).max(10).step(1).description('下载多张图片时的并行下载数量。').default(4),
  }).description('网络与下载设置'),

  Schema.object({
    debug: Schema.boolean().description('是否在控制台输出详细的调试日志。').default(false),
  }).description('调试设置'),
  
  Schema.object({
      clientId: Schema.string().role('secret').description('Pixiv API Client ID.').default('MOBrBDS8blbauoSck0ZfDbtuzpyT'),
      clientSecret: Schema.string().role('secret').description('Pixiv API Client Secret.').default('lsACyCD94FhDUtGTXi3QzcFE2uU1hqtDaKeqrdwj'),
  }).description('高级设置 (警告：除非你知道你在做什么，否则不要修改这些值！)'),
]);


class PixivService {
  private accessToken: string | null = null
  private readonly headers: Record<string, string>
  
  constructor(private ctx: Context, private config: Config) {
    this.headers = {
      'app-os': 'ios',
      'app-os-version': '14.6',
      'user-agent': 'PixivIOSApp/7.13.3 (iOS 14.6; iPhone13,2)',
      'Referer': 'https://www.pixiv.net/',
    }
  }

  private async _refreshAccessToken(): Promise<boolean> {
    if (!this.config.refreshToken) {
      logger.warn('未配置 Refresh Token，无法进行认证。')
      return false
    }
    const data = new URLSearchParams({
      'grant_type': 'refresh_token',
      'client_id': this.config.clientId,
      'client_secret': this.config.clientSecret,
      'refresh_token': this.config.refreshToken,
      'get_secure_url': 'true',
    }).toString()
    try {
      const response = await this.ctx.http.post('https://oauth.secure.pixiv.net/auth/token', data, {
        headers: {
          ...this.headers,
          'Content-Type': 'application/x-www-form-urlencoded',
          'host': 'oauth.secure.pixiv.net',
        },
      })
      if (response.access_token) {
        this.accessToken = response.access_token
        if (this.config.debug) logger.info('AccessToken 刷新成功！')
        return true
      }
      return false
    } catch (error) {
      this.accessToken = null
      logger.error('刷新 AccessToken 失败:', error.response?.data || error.message)
      return false
    }
  }

  private async _request(url: string, params: Record<string, any>) {
    if (!this.accessToken) {
        if (!await this._refreshAccessToken()) {
            throw new Error('无法获取或刷新 Access Token。');
        }
    }

    const makeRequest = () => {
        const requestHeaders = { ...this.headers, 'Authorization': `Bearer ${this.accessToken}` };
        return this.ctx.http.get(url, { params, headers: requestHeaders });
    };

    try {
        return await makeRequest();
    } catch (error) {
        const errorMsg = error.response?.data?.error?.message || '';
        if (error.response?.status === 400 && /invalid_grant|invalid_token/i.test(errorMsg)) {
            if (this.config.debug) logger.info('AccessToken 已失效，尝试强制刷新...');
            if (await this._refreshAccessToken()) {
                if (this.config.debug) logger.info('刷新成功，正在重试请求...');
                return await makeRequest();
            }
        }
        throw error;
    }
  }
  
  public async getArtworkDetail(pid: string) {
    try {
      const response = await this._request(`https://app-api.pixiv.net/v1/illust/detail`, { illust_id: pid, filter: 'for_ios' });
      return response.illust;
    } catch (error) {
      if (this.config.debug) logger.warn(`获取插画详情失败 (PID: ${pid}):`, error.response?.data || error.message);
      return null;
    }
  }

  public async searchIllusts(options: {
    word: string
    target: string
    sort: string
    offset?: number
    minBookmarks?: number
  }) {
    const params: Record<string, any> = {
      word: options.word,
      search_target: options.target,
      sort: options.sort,
      filter: 'for_ios',
    }
    if (options.offset) params.offset = options.offset
    if (options.minBookmarks && options.minBookmarks > 0) params.min_bookmarks = options.minBookmarks
    try {
      const response = await this._request('https://app-api.pixiv.net/v1/search/illust', params)
      return response.illusts || []
    } catch (error) {
      if (this.config.debug) logger.warn(`搜索插画失败 (word: ${options.word}):`, error.response?.data || error.message)
      return null
    }
  }

  public async getRankingIllusts(options: { mode: string; offset?: number }) {
    const params: Record<string, any> = {
      mode: options.mode,
      filter: 'for_ios',
    }
    if (options.offset) params.offset = options.offset
    try {
      const response = await this._request('https://app-api.pixiv.net/v1/illust/ranking', params)
      return response.illusts || []
    } catch (error) {
      if (this.config.debug) logger.warn(`获取 Pixiv 榜单失败 (mode: ${options.mode}):`, error.response?.data || error.message)
      return null
    }
  }

  public async getUgoiraMetadata(pid: string) {
    try {
      const response = await this._request('https://app-api.pixiv.net/v1/ugoira/metadata', { illust_id: pid })
      return response.ugoira_metadata || null
    } catch (error) {
      if (this.config.debug) logger.warn(`获取动图元数据失败 (PID: ${pid}):`, error.response?.data || error.message)
      return null
    }
  }

  public async downloadImage(url: string): Promise<Buffer | null> {
    try {
      const arrayBuffer = await this.ctx.http.get(url, {
        headers: { 'Referer': 'https://www.pixiv.net/' },
        responseType: 'arraybuffer',
        timeout: 60000,
      })
      return Buffer.from(arrayBuffer)
    } catch (error) {
      logger.warn(`图片下载失败 (URL: ${url}):`, error.message)
      return null
    }
  }

  public async getUserDetail(uid: string) {
    try {
        const response = await this._request('https://app-api.pixiv.net/v1/user/detail', { user_id: uid });
        return response;
    } catch (error) {
      if (this.config.debug) logger.warn(`获取用户详情失败 (UID: ${uid}):`, error.response?.data || error.message);
      return null;
    }
  }

  public async getUserIllusts(uid: string) {
    try {
      const response = await this._request(`https://app-api.pixiv.net/v1/user/illusts`, { user_id: uid, filter: 'for_ios' });
      return response.illusts;
    } catch (error) {
      if (this.config.debug) logger.warn(`获取用户作品失败 (UID: ${uid}):`, error.response?.data || error.message);
      return null;
    }
  }
}

export function apply(ctx: Context, config: Config) {
  ctx.inject(['console'], (ctx) => {
    const baseDir = __dirname
    ctx.console.addEntry({
      dev: path.resolve(baseDir, '../client/index.ts'),
      prod: path.resolve(baseDir, '../dist'),
    })
  })

  ctx.model.extend('pixiv_last_artworks', {
    author_id: 'string',
    last_artwork_id: 'string',
  }, {
    primary: 'author_id',
  })

  ctx.model.extend('pixiv_search_history', {
    id: 'unsigned',
    scope_key: 'string',
    keyword: 'string',
    image_key: 'string',
    created_at: 'timestamp',
  }, {
    autoInc: true,
    indexes: [['scope_key', 'keyword'], ['created_at']],
    unique: [['scope_key', 'keyword', 'image_key']],
  })

  const pixiv = new PixivService(ctx, config)
  let lastSearchHistoryCleanup = 0
  const pendingSearchKeys = new Set<string>()

  // 直发压缩功能（可配置）
  async function compressForSend(img: { buffer: Buffer; mime: string }): Promise<{ buffer: Buffer; mime: string }> {
    if (!config.enableDirectCompress) return img
    try {
      if (img.mime === 'image/jpeg') {
        const out = await sharp(img.buffer).jpeg({ quality: config.directCompressQuality, mozjpeg: true }).toBuffer()
        return { buffer: out, mime: 'image/jpeg' }
      }
      if (img.mime === 'image/png') {
        // 若启用 PNG -> JPG，则转 JPG 并按 directCompressQuality 压缩（透明以白色背景合成）
        if (config.enablePngToJpeg) {
          const out = await sharp(img.buffer)
            .flatten({ background: '#ffffff' })
            .jpeg({ quality: config.directCompressQuality, mozjpeg: true })
            .toBuffer()
          return { buffer: out, mime: 'image/jpeg' }
        }
        // 否则按原有逻辑做 PNG 无损压缩
        const out = await sharp(img.buffer).png({ compressionLevel: 7, palette: true }).toBuffer()
        return { buffer: out, mime: 'image/png' }
      }
      return img
    } catch (e) {
      logger.warn(`[直发压缩] 失败，使用原图: ${e.message}`)
      return img
    }
  }

  // R18 随机边缘位置文字水印（保持原格式，不转 JPG）
  async function addR18Watermark(
    input: Buffer,
    text = 'R18',
    opts: { margin?: number; fontSize?: number; opacity?: number; color?: string } = {}
  ): Promise<Buffer> {
    const meta = await sharp(input).metadata()
    const width = meta.width ?? 1080
    const height = meta.height ?? Math.round(width * 1.3)
    const margin = opts.margin ?? 24
    const fontSize = opts.fontSize ?? Math.max(24, Math.round(width / 30))
    const opacity = Math.max(0, Math.min(1, opts.opacity ?? 0.35))
    const color = opts.color ?? '#000'
    
    // 随机选择边缘位置：0=上边，1=右边，2=下边，3=左边
    const position = Math.floor(Math.random() * 4)
    let x: number, y: number, anchor: string
    
    switch (position) {
      case 0: // 上边 - 水平居中偏移
        x = width / 2 + (Math.random() - 0.5) * (width * 0.4) // 中心±20%宽度内随机
        y = margin + fontSize
        anchor = 'middle'
        break
      case 1: // 右边 - 垂直居中偏移  
        x = width - margin
        y = height / 2 + (Math.random() - 0.5) * (height * 0.4) // 中心±20%高度内随机
        anchor = 'end'
        break
      case 2: // 下边 - 水平居中偏移
        x = width / 2 + (Math.random() - 0.5) * (width * 0.4) // 中心±20%宽度内随机
        y = height - margin
        anchor = 'middle'
        break
      case 3: // 左边 - 垂直居中偏移
        x = margin
        y = height / 2 + (Math.random() - 0.5) * (height * 0.4) // 中心±20%高度内随机
        anchor = 'start'
        break
    }
    
    const esc = (s: string) => s.replace(/[<>&'"]/g, c => ({ '<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;' }[c] as string))
    const svg = Buffer.from(`
      <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
        <style>
          .t { font: ${fontSize}px sans-serif; fill:${color}; fill-opacity:${opacity};
               stroke:#fff; stroke-opacity:${opacity}; stroke-width:${Math.max(1, Math.round(fontSize/16))} }
        </style>
        <text class="t" x="${x}" y="${y}" text-anchor="${anchor}">${esc(text)}</text>
      </svg>
    `)
    return sharp(input).composite([{ input: svg }]).toBuffer() // 不指定格式，保留原图格式
  }

  async function preparePdfImageBuffer(input: PdfImageInput, index: number): Promise<Buffer> {
    const jpegOptions: sharp.JpegOptions = {}
    if (config.enableCompression) jpegOptions.quality = config.compressionQuality
    if (config.debug && input.mime === 'image/gif') {
      logger.info(`[PDF] 第 ${index + 1} 张图片是 GIF，PDF 模式将取第一帧作为静态页面。`)
    }
    return sharp(input.buffer, { animated: false })
      .flatten({ background: '#ffffff' })
      .jpeg(jpegOptions)
      .toBuffer()
  }

  async function createPdfFile(illust: any, images: PdfImageInput[]): Promise<string> {
    const safeTitle = (illust.title || illust.id).replace(/[\\/:\*\?"<>\|]/g, '_')
    const tempDir = path.resolve(ctx.app.baseDir, 'data', 'temp', 'pixiv-parse')
    const tempPdfPath = path.resolve(tempDir, `${safeTitle}_${Date.now()}.pdf`)

    await fs.mkdir(tempDir, { recursive: true })
    const pdfOptions: any = {
      autoFirstPage: false,
      pdfVersion: '1.7',
    }
    if (config.pdfPassword) {
      pdfOptions.userPassword = config.pdfPassword
      pdfOptions.ownerPassword = config.pdfPassword
      pdfOptions.permissions = {
        printing: 'highResolution',
        modifying: false,
        copying: false,
        annotating: false,
        fillingForms: false,
        contentAccessibility: false,
        documentAssembly: false,
      }
    }

    const doc = new PDFDocument(pdfOptions)
    const pdfStream = createWriteStream(tempPdfPath)
    doc.pipe(pdfStream)

    try {
      for (const [index, image] of images.entries()) {
        const imageBuffer = await preparePdfImageBuffer(image, index)
        const metadata = await sharp(imageBuffer).metadata()
        if (!metadata.width || !metadata.height) {
          throw new Error(`无法读取第 ${index + 1} 张图片尺寸。`)
        }
        doc.addPage({ size: [metadata.width, metadata.height], margin: 0 })
        doc.image(imageBuffer, 0, 0, { width: metadata.width, height: metadata.height })
      }
      doc.end()
      await once(pdfStream, 'finish')
      return tempPdfPath
    } catch (error) {
      doc.end()
      try { await fs.unlink(tempPdfPath) } catch {}
      throw error
    }
  }

  function createPdfPayload(message: MessageContent): MessagePayload {
    const pdfPassword = config.sendPdfPassword && config.pdfPassword ? config.pdfPassword : undefined
    return { message, pdfPassword }
  }

  function isWrappedMessagePayload(payload: MessagePayload | null): payload is { message: MessageContent; pdfPassword?: string } {
    return !!payload && typeof payload === 'object' && !Array.isArray(payload) && 'message' in payload
  }

  function getMessageContent(payload: MessagePayload): MessageContent {
    return isWrappedMessagePayload(payload) ? payload.message : payload
  }

  function renderMessageContent(message: MessageContent) {
    return Array.isArray(message) ? message.join('\n') : message
  }

  async function sendMessagePayload(payload: MessagePayload | null, send: (message: any) => Promise<any>) {
    if (!payload) return
    await send(renderMessageContent(getMessageContent(payload)))
    if (isWrappedMessagePayload(payload) && payload.pdfPassword) {
      await send(`PDF 打开密码：${payload.pdfPassword}`)
    }
  }

  async function getTempDir(name?: string) {
    const dir = path.resolve(ctx.app.baseDir, 'data', 'temp', 'pixiv-parse', name || '')
    await fs.mkdir(dir, { recursive: true })
    return dir
  }

  function cleanupTempPath(targetPath: string, delay = 0) {
    const remove = () => fs.rm(targetPath, { recursive: true, force: true }).catch(() => {})
    if (delay > 0) {
      const timer = setTimeout(remove, delay)
      if (typeof (timer as any).unref === 'function') (timer as any).unref()
      return
    }
    return remove()
  }

  function getImageMimeByName(name: string) {
    const lower = name.toLowerCase()
    if (lower.endsWith('.png')) return 'image/png'
    if (lower.endsWith('.webp')) return 'image/webp'
    if (lower.endsWith('.gif')) return 'image/gif'
    return 'image/jpeg'
  }

  function quoteFfmpegConcatPath(filePath: string) {
    return filePath.replace(/\\/g, '/').replace(/'/g, "\\'")
  }

  async function convertUgoiraZipToGif(pid: string, metadata: any, zipBuffer: Buffer): Promise<{ buffer: Buffer; mime: string } | null> {
    const frames = Array.isArray(metadata?.frames) ? metadata.frames : []
    if (frames.length === 0) return null

    const AdmZip = require('adm-zip')
    const zip = new AdmZip(zipBuffer)
    const tempDir = await getTempDir(`ugoira-${pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    let firstFrame: { buffer: Buffer; mime: string } | null = null

    try {
      const framePaths: string[] = []
      const delays: number[] = []
      for (const [index, frame] of frames.entries()) {
        const entry = zip.getEntry(frame?.file)
        if (!entry) continue
        const ext = path.extname(frame.file || '') || '.jpg'
        const framePath = path.join(tempDir, `${String(index).padStart(5, '0')}${ext}`)
        await fs.writeFile(framePath, entry.getData())
        framePaths.push(framePath)
        delays.push(Math.max(20, Number(frame.delay || 100)))
      }

      if (framePaths.length === 0) return null
      firstFrame = {
        buffer: await fs.readFile(framePaths[0]),
        mime: getImageMimeByName(framePaths[0]),
      }

      const ffmpeg = ctx.ffmpeg || (ctx as any).get?.('ffmpeg') as FFmpegService | undefined
      if (!ffmpeg) {
        if (config.debug) logger.warn(`[动图] 未启用 koishi-plugin-ffmpeg，PID ${pid} 回退发送第一帧。`)
        return firstFrame
      }

      const concatPath = path.join(tempDir, 'frames.txt')
      const lines: string[] = []
      for (let i = 0; i < framePaths.length; i++) {
        lines.push(`file '${quoteFfmpegConcatPath(framePaths[i])}'`)
        lines.push(`duration ${(delays[i] / 1000).toFixed(3)}`)
      }
      lines.push(`file '${quoteFfmpegConcatPath(framePaths[framePaths.length - 1])}'`)
      await fs.writeFile(concatPath, lines.join('\n'), 'utf8')

      const gifPath = path.join(tempDir, 'ugoira.gif')
      await ffmpeg.builder()
        .inputOption('-f', 'concat', '-safe', '0')
        .input(concatPath)
        .outputOption(
          '-vf',
          'fps=15,scale=480:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse',
          '-loop',
          '0'
        )
        .run('file', gifPath)
      return { buffer: await fs.readFile(gifPath), mime: 'image/gif' }
    } catch (error) {
      if (config.debug) logger.warn(`[动图] PID ${pid} 转 GIF 失败，回退发送第一帧:`, error.message)
      return firstFrame
    } finally {
      cleanupTempPath(tempDir)
    }
  }

  async function downloadUgoiraAsset(pid: string): Promise<{ buffer: Buffer; mime: string } | null> {
    const metadata = await pixiv.getUgoiraMetadata(pid)
    const zipUrl = metadata?.zip_urls?.medium || metadata?.zip_urls?.original
    if (!zipUrl) {
      if (config.debug) logger.warn(`[动图] PID ${pid} 没有可下载的 zip 地址。`)
      return null
    }
    const zipBuffer = await pixiv.downloadImage(zipUrl)
    if (!zipBuffer) return null
    return convertUgoiraZipToGif(pid, metadata, zipBuffer)
  }

  async function downloadPixivPageAsset(asset: PixivPageAsset): Promise<{ buffer: Buffer; mime: string } | null> {
    if (asset.kind === 'ugoira') return downloadUgoiraAsset(asset.url)
    const buffer = await pixiv.downloadImage(asset.url)
    if (!buffer) return null
    return { buffer, mime: getImageMimeByName(asset.url) }
  }

  async function takeUserPageScreenshot(uid: string): Promise<Buffer | null> {
    const page = await ctx.puppeteer.page()
    try {
      if (config.phpsessid) {
        await page.setCookie({ name: 'PHPSESSID', value: config.phpsessid, domain: '.pixiv.net', path: '/' })
        if (config.debug) logger.info(`[Puppeteer] 已设置 PHPSESSID Cookie。`)
      } else {
        logger.warn(`[Puppeteer] 未配置 PHPSESSID，截图可能会因登录墙而失败。`)
      }

      const url = `https://www.pixiv.net/users/${uid}`
      
      await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 })
      
      await sleep(2000) 

      if (config.debug) logger.info(`[Puppeteer] 页面加载完成，准备截取完整页面...`)

      return await page.screenshot({ type: 'png', fullPage: true })
      
    } catch (error) {
      logger.error(`[Puppeteer] 截图失败 (UID: ${uid}):`, error)
      return null
    } finally {
      if (page) await page.close()
    }
  }

  type PixivPageAsset = {
    pageIndex: number
    url: string
    kind: 'image' | 'ugoira'
  }

  type SearchCandidate = {
    illust: any
    pages: PixivPageAsset[]
    workKey: string
  }

  type SearchDownloadedImage = {
    candidate: SearchCandidate
    pageIndex: number
    pageCount: number
    buffer: Buffer
    mime: string
  }

  type ExecutePixivResult = {
    ok: boolean
    text: string
    sentCount?: number
    r18Forced?: boolean
    sendModeForced?: boolean
  }

  type ExecutePixivSearchOptions = {
    keyword: string
    count: number
    r18Mode: SearchR18Mode
    sendMode: SearchSendMode
    target: SearchTarget
    sort: SearchSort
    pagePolicy: SearchPagePolicy
    excludeAI: boolean
    minBookmarks: number
    quoteErrors?: boolean
    debugSource?: string
  }

  type ExecutePixivRandomOptions = {
    count: number
    r18Mode: SearchR18Mode
    sendMode: SearchSendMode
    pagePolicy: SearchPagePolicy
    excludeAI: boolean
    dedupEnabled: boolean
    quoteErrors?: boolean
    debugSource?: string
  }

  const searchTargets: Record<SearchTarget, string> = {
    tag: 'partial_match_for_tags',
    exact: 'exact_match_for_tags',
    text: 'title_and_caption',
  }

  function normalizeMaxCount(maxCount: number): number {
    const parsed = Number(maxCount)
    if (!Number.isFinite(parsed) || parsed <= 0) return 0
    return Math.floor(parsed)
  }

  function mergeMaxCounts(...maxCounts: number[]): number {
    const limits = maxCounts.map(normalizeMaxCount).filter((count) => count > 0)
    return limits.length ? Math.min(...limits) : 0
  }

  function clampCount(value: unknown, fallback: number, maxCount = config.searchMaxCount): number {
    const parsedFallback = Number(fallback)
    const fallbackCount = Number.isFinite(parsedFallback) && parsedFallback > 0 ? Math.floor(parsedFallback) : 1
    const parsed = Number(value)
    const requestedCount = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallbackCount
    const limit = normalizeMaxCount(maxCount)
    return limit > 0 ? Math.min(requestedCount, limit) : requestedCount
  }

  function normalizeKeyword(keyword: string): string {
    return keyword.trim().replace(/\s+/g, ' ').toLowerCase()
  }

  function shuffle<T>(items: T[]): T[] {
    const result = [...items]
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[result[i], result[j]] = [result[j], result[i]]
    }
    return result
  }

  function parseEnumOption<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T | null {
    if (value === undefined || value === null || value === '') return fallback
    const normalized = String(value).trim() as T
    return allowed.includes(normalized) ? normalized : null
  }

  function parseBooleanOption(value: unknown, fallback: boolean): boolean | null {
    if (value === undefined || value === null || value === '') return fallback
    if (typeof value === 'boolean') return value
    const normalized = String(value).trim().toLowerCase()
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true
    if (['false', '0', 'no', 'off'].includes(normalized)) return false
    return null
  }

  function resolveR18Mode(requested: SearchR18Mode): SearchR18Mode | null {
    if (config.r18Action === 'send') return requested
    if (requested === 'only') return null
    return 'exclude'
  }

  function isR18Illust(illust: any): boolean {
    return Number(illust?.x_restrict || 0) > 0
  }

  function isAiIllust(illust: any): boolean {
    if (Number(illust?.illust_ai_type || 0) === 2) return true
    const tags = Array.isArray(illust?.tags) ? illust.tags : []
    return tags.some((tag: any) => ['AI生成', 'AI Generated'].includes(tag?.name) || ['AI生成', 'AI Generated'].includes(tag?.translated_name))
  }

  function isUgoiraIllust(illust: any): boolean {
    return illust?.type === 'ugoira' || Number(illust?.illust_type || 0) === 2
  }

  function getIllustImageUrls(illust: any): PixivPageAsset[] {
    if (isUgoiraIllust(illust)) {
      return illust?.id ? [{ pageIndex: 0, url: String(illust.id), kind: 'ugoira' }] : []
    }
    if (Array.isArray(illust?.meta_pages) && illust.meta_pages.length > 0) {
      return illust.meta_pages
        .map((page: any, index: number) => ({ pageIndex: index, url: page?.image_urls?.original, kind: 'image' as const }))
        .filter((item: PixivPageAsset) => !!item.url)
    }
    const singleUrl = illust?.meta_single_page?.original_image_url || illust?.image_urls?.large
    return singleUrl ? [{ pageIndex: 0, url: singleUrl, kind: 'image' }] : []
  }

  function buildCandidates(
    illusts: any[],
    options: {
      r18Mode: SearchR18Mode
      excludeAI: boolean
      pagePolicy: SearchPagePolicy
      minBookmarks?: number
    }
  ): SearchCandidate[] {
    const candidates: SearchCandidate[] = []
    for (const illust of illusts || []) {
      if (!illust?.id) continue
      const isR18 = isR18Illust(illust)
      if (options.r18Mode === 'exclude' && isR18) continue
      if (options.r18Mode === 'only' && !isR18) continue
      if (options.excludeAI && isAiIllust(illust)) continue
      if (options.minBookmarks && Number(illust.total_bookmarks || 0) < options.minBookmarks) continue
      const urls = getIllustImageUrls(illust)
      const selectedUrls = options.pagePolicy === 'first' ? urls.slice(0, 1) : urls
      if (selectedUrls.length === 0) continue
      candidates.push({
        illust,
        pages: selectedUrls,
        workKey: String(illust.id),
      })
    }
    return candidates
  }

  function getDedupScopeKey(session: Session): string {
    if (config.searchDedupScope === 'global') return 'global'
    return `${session.platform}:${session.channelId}`
  }

  function getPendingSearchKey(scopeKey: string, keyword: string, workKey: string): string {
    return `${scopeKey}\u0000${keyword}\u0000${workKey}`
  }

  function reserveSearchCandidate(scopeKey: string, keyword: string, dedupKeys: Set<string>, candidate: SearchCandidate): boolean {
    if (dedupKeys.has(candidate.workKey)) return false
    const pendingKey = getPendingSearchKey(scopeKey, keyword, candidate.workKey)
    if (pendingSearchKeys.has(pendingKey)) return false
    pendingSearchKeys.add(pendingKey)
    return true
  }

  function releaseSearchCandidates(scopeKey: string, keyword: string, candidates: SearchCandidate[]) {
    for (const candidate of candidates) {
      pendingSearchKeys.delete(getPendingSearchKey(scopeKey, keyword, candidate.workKey))
    }
  }

  function pickReservedCandidates(scopeKey: string, keyword: string, candidates: SearchCandidate[], count: number): SearchCandidate[] {
    const selected = shuffle(candidates).slice(0, count)
    const selectedKeys = new Set(selected.map(candidate => candidate.workKey))
    releaseSearchCandidates(scopeKey, keyword, candidates.filter(candidate => !selectedKeys.has(candidate.workKey)))
    return selected
  }

  async function cleanupSearchHistory(force = false) {
    const now = Date.now()
    if (!force && now - lastSearchHistoryCleanup < Time.hour) return
    lastSearchHistoryCleanup = now
    const cutoff = new Date(now - config.searchDedupTtlHours * Time.hour)
    try {
      await ctx.database.remove('pixiv_search_history', { created_at: { $lt: cutoff } })
    } catch (error) {
      if (config.debug) logger.warn('[搜索去重] 清理过期记录失败:', error)
    }
  }

  async function loadDedupKeys(session: Session, keyword: string, enabled = config.searchDedupEnabled): Promise<Set<string>> {
    if (!enabled) return new Set()
    await cleanupSearchHistory()
    const cutoff = new Date(Date.now() - config.searchDedupTtlHours * Time.hour)
    const records = await ctx.database.get('pixiv_search_history', {
      scope_key: getDedupScopeKey(session),
      keyword,
      created_at: { $gt: cutoff },
    }, {
      fields: ['image_key'],
    })
    return new Set(records.flatMap((record) => {
      const key = record.image_key
      const workKey = key.includes(':') ? key.split(':')[0] : key
      return [key, workKey]
    }))
  }

  async function rememberSearchResults(session: Session, keyword: string, candidates: SearchCandidate[], enabled = config.searchDedupEnabled) {
    if (!enabled || candidates.length === 0) return
    const scopeKey = getDedupScopeKey(session)
    const createdAt = new Date()
    for (const candidate of candidates) {
      await ctx.database.upsert('pixiv_search_history', [{
        scope_key: scopeKey,
        keyword,
        image_key: candidate.workKey,
        created_at: createdAt,
      }], ['scope_key', 'keyword', 'image_key'])
    }

    if (config.searchDedupMaxRecordsPerKeyword <= 0) return
    const records = await ctx.database.get('pixiv_search_history', {
      scope_key: scopeKey,
      keyword,
    }, {
      fields: ['id'],
      sort: { created_at: 'desc' },
    })
    const overflow = records.slice(config.searchDedupMaxRecordsPerKeyword)
    if (overflow.length > 0) {
      await ctx.database.remove('pixiv_search_history', { id: { $in: overflow.map(record => record.id) } })
    }
  }

  function getBookmarkThresholds(minBookmarks: number): number[] {
    if (minBookmarks <= 0) return [0]
    if (!config.searchFallbackMinBookmarks) return [minBookmarks]
    const presets = [10000, 5000, 1000, 500, 100, 0]
    const thresholds = [minBookmarks, ...presets.filter(value => value < minBookmarks)]
    return [...new Set(thresholds)]
  }

  function getRandomRankingModes(r18Mode: SearchR18Mode): string[] {
    if (r18Mode === 'only') {
      return shuffle(['day_r18', 'week_r18', 'day_male_r18', 'day_female_r18', 'week_r18g'])
    }
    if (r18Mode === 'include') {
      return shuffle(['day', 'week', 'month', 'day_r18', 'week_r18', 'day_male_r18', 'day_female_r18'])
    }
    return shuffle(['day', 'week', 'month'])
  }

  async function fetchSearchIllusts(word: string, target: SearchTarget, sort: SearchSort, minBookmarks: number): Promise<any[]> {
    const maxPages = Math.max(1, Math.min(5, Math.ceil(config.searchCandidateLimit / 30)))
    const illusts: any[] = []
    const seen = new Set<string>()
    for (let page = 0; page < maxPages; page++) {
      const response = await pixiv.searchIllusts({
        word,
        target: searchTargets[target],
        sort,
        offset: page * 30,
        minBookmarks,
      })
      if (!response || response.length === 0) break
      for (const illust of response) {
        const id = String(illust?.id || '')
        if (!id || seen.has(id)) continue
        seen.add(id)
        illusts.push(illust)
      }
      if (illusts.length >= config.searchCandidateLimit) break
    }
    return illusts
  }

  async function collectSearchCandidates(options: {
    keyword: string
    count: number
    r18Mode: SearchR18Mode
    sendTarget: SearchTarget
    sort: SearchSort
    excludeAI: boolean
    pagePolicy: SearchPagePolicy
    dedupKeys: Set<string>
    scopeKey: string
    dedupKeyword: string
    minBookmarks: number
  }): Promise<SearchCandidate[]> {
    const candidates: SearchCandidate[] = []
    const seenWorks = new Set<string>()
    const thresholds = getBookmarkThresholds(options.minBookmarks)
    for (const threshold of thresholds) {
      const directIllusts = await fetchSearchIllusts(options.keyword, options.sendTarget, options.sort, threshold)
      const directCandidates = buildCandidates(directIllusts, {
        r18Mode: options.r18Mode,
        excludeAI: options.excludeAI,
        pagePolicy: options.pagePolicy,
        minBookmarks: threshold,
      })
      for (const candidate of shuffle(directCandidates)) {
        if (seenWorks.has(candidate.workKey)) continue
        if (!reserveSearchCandidate(options.scopeKey, options.dedupKeyword, options.dedupKeys, candidate)) continue
        seenWorks.add(candidate.workKey)
        candidates.push(candidate)
        if (candidates.length >= config.searchCandidateLimit) break
      }

      if (threshold > 0 && candidates.length < options.count) {
        const tagWord = `${options.keyword} ${threshold}users入り`
        const tagIllusts = await fetchSearchIllusts(tagWord, 'tag', options.sort, 0)
        const tagCandidates = buildCandidates(tagIllusts, {
          r18Mode: options.r18Mode,
          excludeAI: options.excludeAI,
          pagePolicy: options.pagePolicy,
          minBookmarks: threshold,
        })
        for (const candidate of shuffle(tagCandidates)) {
          if (seenWorks.has(candidate.workKey)) continue
          if (!reserveSearchCandidate(options.scopeKey, options.dedupKeyword, options.dedupKeys, candidate)) continue
          seenWorks.add(candidate.workKey)
          candidates.push(candidate)
          if (candidates.length >= config.searchCandidateLimit) break
        }
      }

      if (candidates.length >= options.count || !config.searchFallbackMinBookmarks) break
    }
    return pickReservedCandidates(options.scopeKey, options.dedupKeyword, candidates, options.count)
  }

  async function collectRandomRankingCandidates(options: {
    count: number
    r18Mode: SearchR18Mode
    excludeAI: boolean
    pagePolicy: SearchPagePolicy
    dedupKeys: Set<string>
    scopeKey: string
    dedupKeyword: string
  }): Promise<SearchCandidate[]> {
    const candidates: SearchCandidate[] = []
    const seenWorks = new Set<string>()
    const modes = getRandomRankingModes(options.r18Mode)
    const offsets = shuffle([0, 30, 60, 90, 120])
    if (config.debug) logger.info(`[搜索] 随机热门使用榜单模式 ${modes.join(', ')}`)
    for (const mode of modes) {
      for (const offset of offsets) {
        const illusts = await pixiv.getRankingIllusts({ mode, offset })
        if (!illusts || illusts.length === 0) continue
        const rankingCandidates = buildCandidates(illusts, {
          r18Mode: options.r18Mode,
          excludeAI: options.excludeAI,
          pagePolicy: options.pagePolicy,
        })
        for (const candidate of shuffle(rankingCandidates)) {
          if (seenWorks.has(candidate.workKey)) continue
          if (!reserveSearchCandidate(options.scopeKey, options.dedupKeyword, options.dedupKeys, candidate)) continue
          seenWorks.add(candidate.workKey)
          candidates.push(candidate)
          if (candidates.length >= Math.max(options.count, config.searchCandidateLimit)) break
        }
        if (candidates.length >= options.count) return pickReservedCandidates(options.scopeKey, options.dedupKeyword, candidates, options.count)
      }
    }
    return pickReservedCandidates(options.scopeKey, options.dedupKeyword, candidates, options.count)
  }

  function buildSearchTextInfo(item: Pick<SearchDownloadedImage, 'candidate' | 'pageIndex' | 'pageCount'>, sourceLabel: string): string {
    const candidate = item.candidate
    const illust = candidate.illust
    const tags = Array.isArray(illust.tags) ? illust.tags : []
    let textInfo = `[${sourceLabel}]\n[标题] ${illust.title}`
      + (config.sendAuthor ? `\n[作者] ${illust.user?.name || '未知'}` : '')
      + (Number(illust.total_bookmarks || 0) > 0 ? `\n[收藏] ${illust.total_bookmarks}` : '')
      + (item.pageCount > 1 ? `\n[页码] ${item.pageIndex + 1}/${item.pageCount}` : '')
      + (config.sendTags && tags.length > 0 ? `\n[标签] ${tags.map((tag: any) => tag.name).filter(Boolean).join(', ')}` : '')
      + (isR18Illust(illust) ? `\n[警告] 本作品为 R-18/R-18G 内容` : '')
    if (config.sendLinkWithCommand) {
      textInfo += `\n[源链接] https://www.pixiv.net/artworks/${illust.id}`
    }
    return textInfo
  }

  async function buildSearchMessage(candidates: SearchCandidate[], sendMode: SearchSendMode, sourceLabel: string): Promise<MessagePayload | null> {
    const pageTasks = candidates.flatMap((candidate) => {
      const pageCount = Number(candidate.illust?.page_count || getIllustImageUrls(candidate.illust).length || candidate.pages.length || 1)
      return candidate.pages.map((page) => ({ candidate, page, pageCount }))
    })
    const downloaded = (await Promise.all(pageTasks.map(async (item) => {
      const asset = await downloadPixivPageAsset(item.page)
      return asset ? {
        candidate: item.candidate,
        pageIndex: item.page.pageIndex,
        pageCount: item.pageCount,
        buffer: asset.buffer,
        mime: asset.mime,
      } : null
    }))).filter((item): item is SearchDownloadedImage => !!item)

    if (downloaded.length === 0) return '所有图片都下载失败了，无法发送。'

    const hasR18 = downloaded.some(item => isR18Illust(item.candidate.illust))
    let processed = downloaded
    if (config.enableR18Watermark) {
      processed = await Promise.all(downloaded.map(async (item) => ({
        ...item,
        buffer: isR18Illust(item.candidate.illust) && item.mime !== 'image/gif' ? await addR18Watermark(item.buffer, 'R18') : item.buffer,
      })))
    }

    const compressed = await Promise.all(processed.map(async (item) => ({
      ...item,
      ...(await compressForSend({ buffer: item.buffer, mime: item.mime })),
    })))

    const shouldCreatePdf = sendMode === 'pdf'
      || (sendMode === 'auto' && ((config.autoPdfForR18 && hasR18) || (config.pdfThreshold > 0 && compressed.length >= config.pdfThreshold)))
    const shouldForward = sendMode === 'forward'
      || (sendMode === 'auto' && config.forwardThreshold > 0 && compressed.length >= config.forwardThreshold)

    const textInfos = compressed.map(item => buildSearchTextInfo(item, sourceLabel))

    if (shouldCreatePdf) {
      const pdfIllust = { id: sourceLabel, title: sourceLabel }
      const pdfPath = await createPdfFile(pdfIllust, compressed.map(item => ({ buffer: item.buffer, mime: item.mime })))
      const summary = textInfos.join('\n\n')
      try {
        if (config.pdfSendMode === 'file') {
          return createPdfPayload([h('p', summary), h.file(`file://${pdfPath}`, { title: `${sourceLabel}.pdf` })])
        }
        const pdfBuffer = await fs.readFile(pdfPath)
        return createPdfPayload([h('p', summary), h.file(pdfBuffer, 'application/pdf', { title: `${sourceLabel}.pdf` })])
      } finally {
        const delay = config.pdfSendMode === 'file' ? 5000 : 0
        setTimeout(() => {
          fs.unlink(pdfPath).catch(e => logger.warn(`[PDF] 清理临时文件失败 ${pdfPath}:`, e))
        }, delay)
      }
    }

    const nodes: h[] = []
    for (const [index, item] of compressed.entries()) {
      nodes.push(h('p', textInfos[index]))
      nodes.push(h.image(item.buffer, item.mime))
    }

    if (shouldForward) return h('figure', {}, nodes)
    return nodes
  }

  function quoteError(session: Session, text: string, enabled = true) {
    return enabled ? h('quote', { id: session.messageId }) + text : text
  }

  async function executePixivSearch(session: Session, options: ExecutePixivSearchOptions): Promise<ExecutePixivResult> {
    const keyword = options.keyword.trim()
    const normalizedKeyword = normalizeKeyword(keyword)
    const statusMessage = await session.send(h('quote', { id: session.messageId }) + `正在搜索 Pixiv：${keyword}`)
    const scopeKey = getDedupScopeKey(session)
    let candidates: SearchCandidate[] = []
    try {
      if (config.debug) {
        logger.info(`[搜索] ${options.debugSource || 'pixivsearch'} keyword=${keyword} count=${options.count} r18=${options.r18Mode} mode=${options.sendMode} target=${options.target} sort=${options.sort} page=${options.pagePolicy} minBookmarks=${options.minBookmarks} excludeAI=${options.excludeAI} scope=${scopeKey}`)
      }
      const dedupKeys = await loadDedupKeys(session, normalizedKeyword)
      if (config.debug) logger.info(`[搜索] 已加载去重记录 ${dedupKeys.size} 条 keyword=${normalizedKeyword}`)
      candidates = await collectSearchCandidates({
        keyword,
        count: options.count,
        r18Mode: options.r18Mode,
        sendTarget: options.target,
        sort: options.sort,
        excludeAI: options.excludeAI,
        pagePolicy: options.pagePolicy,
        dedupKeys,
        scopeKey,
        dedupKeyword: normalizedKeyword,
        minBookmarks: options.minBookmarks,
      })
      if (candidates.length === 0) {
        if (config.debug) logger.info(`[搜索] 没有找到可发送候选 keyword=${normalizedKeyword}`)
        return { ok: false, text: quoteError(session, '没有找到符合条件且未重复的作品。可以降低收藏阈值，或临时关闭去重后再试。', options.quoteErrors) }
      }
      if (config.debug) logger.info(`[搜索] 最终候选作品 ${candidates.map(candidate => candidate.workKey).join(', ')}`)
      const result = await buildSearchMessage(candidates, options.sendMode, `Pixiv 搜索：${keyword}`)
      if (!result) return { ok: false, text: quoteError(session, '搜索结果生成失败。', options.quoteErrors) }
      await sendMessagePayload(result, message => session.send(message))
      if (typeof result !== 'string') await rememberSearchResults(session, normalizedKeyword, candidates)
      return { ok: true, text: `已发送 ${candidates.length} 个 Pixiv 搜索作品，关键词：${keyword}。`, sentCount: candidates.length }
    } catch (error) {
      logger.error(`[搜索] 处理 ${options.debugSource || 'pixivsearch'} 时发生错误:`, error)
      return { ok: false, text: quoteError(session, `搜索失败：${error.message}`, options.quoteErrors) }
    } finally {
      releaseSearchCandidates(scopeKey, normalizedKeyword, candidates)
      try { await session.bot.deleteMessage(session.channelId, statusMessage[0]) } catch (e) {}
    }
  }

  async function executePixivRandom(session: Session, options: ExecutePixivRandomOptions): Promise<ExecutePixivResult> {
    const keyword = '__pixivrandom__'
    const statusMessage = await session.send(h('quote', { id: session.messageId }) + `正在随机抽取 Pixiv 热门作品...`)
    const scopeKey = getDedupScopeKey(session)
    let candidates: SearchCandidate[] = []
    try {
      if (config.debug) {
        logger.info(`[搜索] ${options.debugSource || 'pixivrandom'} count=${options.count} r18=${options.r18Mode} mode=${options.sendMode} page=${options.pagePolicy} excludeAI=${options.excludeAI} dedup=${options.dedupEnabled} scope=${scopeKey}`)
      }
      const dedupKeys = await loadDedupKeys(session, keyword, options.dedupEnabled)
      if (config.debug) logger.info(`[搜索] 随机热门已加载去重记录 ${dedupKeys.size} 条`)
      candidates = await collectRandomRankingCandidates({
        count: options.count,
        r18Mode: options.r18Mode,
        excludeAI: options.excludeAI,
        pagePolicy: options.pagePolicy,
        dedupKeys,
        scopeKey,
        dedupKeyword: keyword,
      })
      if (candidates.length === 0) {
        if (config.debug) logger.info('[搜索] 随机热门没有找到可发送候选')
        return { ok: false, text: quoteError(session, '没有找到符合条件且未重复的热门作品。', options.quoteErrors) }
      }
      if (config.debug) logger.info(`[搜索] 随机热门最终候选作品 ${candidates.map(candidate => candidate.workKey).join(', ')}`)
      const result = await buildSearchMessage(candidates, options.sendMode, 'Pixiv 随机热门')
      if (!result) return { ok: false, text: quoteError(session, '随机结果生成失败。', options.quoteErrors) }
      await sendMessagePayload(result, message => session.send(message))
      if (typeof result !== 'string') await rememberSearchResults(session, keyword, candidates, options.dedupEnabled)
      return { ok: true, text: `已发送 ${candidates.length} 个 Pixiv 随机热门作品。`, sentCount: candidates.length }
    } catch (error) {
      logger.error(`[搜索] 处理 ${options.debugSource || 'pixivrandom'} 时发生错误:`, error)
      return { ok: false, text: quoteError(session, `随机作品失败：${error.message}`, options.quoteErrors) }
    } finally {
      releaseSearchCandidates(scopeKey, keyword, candidates)
      try { await session.bot.deleteMessage(session.channelId, statusMessage[0]) } catch (e) {}
    }
  }

  async function handlePixivRequest(session: Session, id: string, source: 'command' | 'middleware', isSubscription = false): Promise<MessagePayload | null> {
    const statusMessage = !isSubscription ? await session.send(h('quote', { id: session.messageId }) + `正在解析 Pixiv 作品 (ID: ${id})...`) : null
    try {
      const illust = await pixiv.getArtworkDetail(id)
      if (!illust) return isSubscription ? null : h('quote', { id: session.messageId }) + '找不到该 ID 对应的插画作品。'

      const isR18 = illust.x_restrict > 0
      if (isR18) {
        if (config.r18Action === 'block') return isSubscription ? null : h('quote', { id: session.messageId }) + '根据配置，已屏蔽 R-18 作品。'
        if (config.r18Action === 'warn' && !isSubscription) return h('quote', { id: session.messageId }) + `[警告] 该作品为 R-18/R-18G 内容！\n标题: ${illust.title}\n作者: ${illust.user.name}`
      }

      const imageAssets = getIllustImageUrls(illust)
      const images = (await Promise.all(imageAssets.map(async (asset) => {
        return downloadPixivPageAsset(asset)
      }))).filter((x): x is { buffer: Buffer; mime: string } => !!x)

      if (images.length === 0) return isSubscription ? null : h('quote', { id: session.messageId }) + '所有图片都下载失败了，无法发送。'
      
      const imageCount = images.length
      let textInfo = (isSubscription ? `[${illust.user.name} 的作品更新]\n` : '')
        + `[标题] ${illust.title}`
        + (config.sendAuthor ? `\n[作者] ${illust.user.name}` : '')
        + (config.sendTags && illust.tags.length > 0 ? `\n[标签] ${illust.tags.map(t => t.name).join(', ')}` : '')
        + (isR18 ? `\n[警告] 本作品为 R-18/R-18G 内容` : '')
      
      if (source === 'command' && config.sendLinkWithCommand) {
        textInfo += `\n[源链接] https://www.pixiv.net/artworks/${id}`
      }
      
      const safeTitle = (illust.title || illust.id)
        .replace(/[\\/:\*\?"<>\|]/g, '_')  // Windows 非法字符
        .replace(/[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu, '')  // 移除 Emoji
        || illust.id;  // 如果清理后为空，使用 ID

      const shouldCreatePdf = (config.autoPdfForR18 && isR18) || (config.pdfThreshold > 0 && imageCount >= config.pdfThreshold);


      if (shouldCreatePdf) {
        const pdfPath = await createPdfFile(illust, images.map(i => ({ buffer: i.buffer, mime: i.mime })));
        let messageElements: h[];
        try {
          if (config.pdfSendMode === 'file') {
            if (config.debug) logger.info(`[PDF] 使用 "file" 模式发送: ${pdfPath}`);
            messageElements = [h('p', textInfo), h.file(`file://${pdfPath}`, { title: `${safeTitle}.pdf` })];
          } else {
            if (config.debug) logger.info(`[PDF] 使用 "buffer" 模式发送`);
            const pdfBuffer = await fs.readFile(pdfPath);
            messageElements = [h('p', textInfo), h.file(pdfBuffer, 'application/pdf', { title: `${safeTitle}.pdf` })];
          }
          return createPdfPayload(messageElements);
        } finally {

          const delay = config.pdfSendMode === 'file' ? 5000 : 0;
          setTimeout(() => {
            fs.unlink(pdfPath).catch(e => logger.warn(`[PDF] 清理临时文件失败 ${pdfPath}:`, e));
          }, delay);
        }
      }

      // 仅直发模式，对 R18 且开启开关时加水印（保持原格式）
      let imagesForSend = images
      if (isR18 && config.enableR18Watermark) {
        imagesForSend = await Promise.all(images.map(async (img) => ({
          mime: img.mime,
          buffer: img.mime === 'image/gif' ? img.buffer : await addR18Watermark(img.buffer, 'R18'),
        })))
      }

      // 直发时压缩图片（可配置）
      const sendImages = await Promise.all(imagesForSend.map(compressForSend))
      const allContentNodes: h[] = [h('p', textInfo), ...sendImages.map(img => h.image(img.buffer, img.mime))]
      
      const platform = isSubscription ? config.pushBotPlatform : session?.platform
      if (config.forwardThreshold > 0 && imageCount >= config.forwardThreshold && ['qq', 'onebot'].includes(platform)) {
        return h('figure', {}, allContentNodes)
      }
      
      return allContentNodes

    } catch (error) {
      logger.error(`处理 Pixiv 请求时发生未知错误 (ID: ${id}):`, error)
      return isSubscription ? null : h('quote', { id: session.messageId }) + `处理时发生未知错误：${error.message}`
    } finally {
      if (statusMessage) try { await session.bot.deleteMessage(session.channelId, statusMessage[0]) } catch (e) {}
    }
  }

  async function checkAndPushUpdates(isManualTrigger = false) {
    if (!config.enableSubscription) return;
    if (config.debug) logger.info('[订阅] 开始检查更新...');

    const bot = ctx.bots.find(b => b.platform === config.pushBotPlatform && b.selfId === config.pushBotId && b.status === 1);

    if (!bot) {
        const botIdentifier = `${config.pushBotPlatform}:${config.pushBotId}`;
        logger.warn(`[订阅] 配置中指定的机器人 [${botIdentifier}] 不存在或不在线，跳过本轮检查。`)
        return isManualTrigger ? `配置中指定的机器人 [${botIdentifier}] 不存在或不在线。` : undefined
    }
    
    let updatesFound = 0;
    for (const sub of config.subscriptions) {
        if (!sub.uid || !sub.channelIds || sub.channelIds.length === 0) continue;
        
        if (config.debug) logger.info(`[订阅] 正在检查作者: ${sub.name} (UID: ${sub.uid})`);

        try {
            const illusts = await pixiv.getUserIllusts(sub.uid)
            if (!illusts || illusts.length === 0) {
                if (config.debug) logger.info(`[订阅] 未能获取到作者 ${sub.name} 的任何作品，跳过。`);
                continue;
            }

            const latestIllust = illusts[0];
            const latestId = latestIllust.id.toString();
            if (config.debug) logger.info(`[订阅] API 返回的最新作品ID: ${latestId}`);


            const record = await ctx.database.get('pixiv_last_artworks', { author_id: sub.uid });
            const lastIdInDb = record[0]?.last_artwork_id;
            if (config.debug) logger.info(`[订阅] 数据库中记录的ID: ${lastIdInDb || '无'}`);

            
            const isNew = !lastIdInDb || latestId !== lastIdInDb;
            const shouldPush = isNew || (isManualTrigger && !!latestId);
            if (config.debug) logger.info(`[订阅] 检查结果: isNew=${isNew}, isManualTrigger=${isManualTrigger}, shouldPush=${shouldPush}`);

            
            if (shouldPush) {
                logger.info(`[订阅] ★ 发现 [${sub.name}] 的新作品或被手动触发: ${latestId}`)
                updatesFound++;
                
                const messageContent = await handlePixivRequest(null, latestId, 'middleware', true)
                if (!messageContent) {
                  logger.warn(`[订阅] 新作品 ${latestId} 内容生成失败，跳过推送。`)
                  continue;
                }

                for (const channelId of sub.channelIds) {
                    try {
                        await sendMessagePayload(messageContent, message => bot.sendMessage(channelId, message))
                    } catch (e) {
                        logger.warn(`[订阅] 向频道 ${channelId} 推送失败 (使用机器人 ${bot.sid}):`, e.message);
                    }
                }
            }

            if (isNew) {
                await ctx.database.upsert('pixiv_last_artworks', [{ author_id: sub.uid, last_artwork_id: latestId }])
                if (config.debug) logger.info(`[订阅] 数据库ID已更新为: ${latestId}`);
            }
        } catch(error) {
            logger.error(`[订阅] 检查作者 ${sub.name} (UID: ${sub.uid}) 时出错:`, error)
        }
    }
    if (config.debug) logger.info(`[订阅] 本轮检查结束，共推送 ${updatesFound} 个更新。`)
    if (isManualTrigger) return `手动检查完成，共为 ${updatesFound} 个订阅执行了推送任务。`
  }

  type PixivSearchToolInput = {
    keyword: string
    count?: number
    r18?: SearchR18Mode
    mode?: SearchSendMode
    quality?: number | 'off'
    sort?: SearchSort
    target?: SearchTarget
    ai?: boolean
    page?: SearchPagePolicy
  }

  type PixivRandomToolInput = {
    count?: number
    r18?: SearchR18Mode
    mode?: SearchSendMode
    ai?: boolean
    page?: SearchPagePolicy
  }
  function resolveChatLunaR18Mode(requested: SearchR18Mode | undefined, fallback: SearchR18Mode) {
    let next = requested || fallback
    let forced = false
    if (!config.chatLunaAllowR18 && next !== 'exclude') {
      next = 'exclude'
      forced = true
    }
    const resolved = resolveR18Mode(next)
    if (!resolved) return { error: '当前 R18 总开关不允许请求 R18 内容。', forced }
    if (resolved !== next) forced = true
    return { mode: resolved, forced }
  }

  function resolveChatLunaSendMode(requested: SearchSendMode | undefined) {
    const fallback = config.chatLunaDefaultSendMode
    if (!config.chatLunaAllowSendModeOverride) {
      return { mode: fallback, forced: !!requested && requested !== fallback }
    }
    return { mode: requested || fallback, forced: false }
  }

  function resolveChatLunaQuality(value: PixivSearchToolInput['quality']) {
    if (value === 'off') return 0
    if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.floor(value))
    return config.searchPreferHighBookmarks ? config.searchDefaultMinBookmarks : 0
  }

  function withChatLunaPolicyNotes(text: string, options: { r18Forced?: boolean; sendModeForced?: boolean }) {
    const notes: string[] = []
    if (options.r18Forced) notes.push('已按插件配置强制排除或降级 R18 请求')
    if (options.sendModeForced) notes.push('已按插件配置使用默认发送方式')
    return notes.length ? `${text}\n${notes.join('；')}` : text
  }

  function requireFromApp(id: string) {
    const resolved = require.resolve(id, { paths: [ctx.app.baseDir, __dirname] })
    return require(resolved)
  }

  async function registerChatLunaTools() {
    if (!config.enableChatLunaTools) {
      if (config.debug) logger.info('[ChatLuna] 工具注册总开关已关闭。')
      return
    }

    const platform = (ctx as any).chatluna?.platform
    if (!platform?.registerTool) {
      if (config.debug) logger.warn('[ChatLuna] 未检测到 ChatLuna 服务，跳过工具注册。')
      return
    }

    let StructuredTool: any
    let z: any
    try {
      StructuredTool = requireFromApp('@langchain/core/tools').StructuredTool
      z = requireFromApp('zod/v3').z
    } catch (error) {
      logger.warn('[ChatLuna] 缺少 @langchain/core 或 zod 依赖，跳过 Pixiv 工具注册。请在 Koishi 根目录安装依赖后重启。', error)
      return
    }

    const chatLunaR18Schema = z.enum(['exclude', 'include', 'only'])
    const chatLunaSendModeSchema = z.enum(['auto', 'direct', 'forward', 'pdf'])
    const chatLunaPagePolicySchema = z.enum(['first', 'all'])

    const pixivSearchToolSchema = z.object({
      keyword: z.string().min(1).describe('Pixiv 搜索关键词，例如角色名、作品名、标签或自然语言描述。'),
      count: z.number().int().min(1).optional().describe('要发送的作品数量。省略时使用插件搜索默认数量。'),
      r18: chatLunaR18Schema.optional().describe('R18 策略。exclude 排除 R18，include 允许混入 R18，only 只搜索 R18。最终仍受插件配置限制。'),
      mode: chatLunaSendModeSchema.optional().describe('发送方式。auto 按插件阈值自动选择，direct 直发图片，forward 合并转发，pdf 生成 PDF。'),
      quality: z.union([z.number().int().min(0), z.literal('off')]).optional().describe('最低收藏数阈值。off 表示关闭高收藏阈值。'),
      sort: z.enum(['date_desc', 'date_asc']).optional().describe('搜索排序。没有 Pixiv Premium 时不使用热门排序。'),
      target: z.enum(['tag', 'exact', 'text']).optional().describe('搜索范围。tag 为标签部分匹配，exact 为标签完全匹配，text 为标题和简介搜索。'),
      ai: z.boolean().optional().describe('是否过滤 Pixiv 标记为 AI 生成的作品。true 表示过滤。'),
      page: chatLunaPagePolicySchema.optional().describe('多页作品发送策略。first 只发送第一页，all 发送全部页面。'),
    })

    const pixivRandomToolSchema = z.object({
      count: z.number().int().min(1).optional().describe('要随机发送的作品数量。省略时使用随机热门默认数量。'),
      r18: chatLunaR18Schema.optional().describe('R18 策略。exclude 排除 R18，include 允许混入 R18，only 只随机 R18。最终仍受插件配置限制。'),
      mode: chatLunaSendModeSchema.optional().describe('发送方式。auto 按插件阈值自动选择，direct 直发图片，forward 合并转发，pdf 生成 PDF。'),
      ai: z.boolean().optional().describe('是否过滤 Pixiv 标记为 AI 生成的作品。true 表示过滤。'),
      page: chatLunaPagePolicySchema.optional().describe('多页作品发送策略。first 只发送第一页，all 发送全部页面。'),
    })

    class ChatLunaPixivSearchTool extends StructuredTool {
      name: string
      description = '搜索 Pixiv 作品并把图片、合并转发或 PDF 发送到当前聊天。适合用户要求找某个角色、标签或主题的 Pixiv 图片时调用。'
      schema = pixivSearchToolSchema

      constructor(toolName: string) {
        super()
        this.name = toolName
      }

      async _call(input: PixivSearchToolInput, _runManager?: unknown, runConfig?: any) {
        const session = runConfig?.configurable?.session as Session | undefined
        if (!session) return 'Pixiv 搜索工具无法获取当前会话。'
        if (!config.enableSearch) return 'Pixiv 搜索功能未启用。'
        if (!input.keyword?.trim()) return '请输入搜索关键词。'

        const r18 = resolveChatLunaR18Mode(input.r18, config.searchDefaultR18)
        if (r18.error) return r18.error
        const sendMode = resolveChatLunaSendMode(input.mode)
        const maxCount = mergeMaxCounts(config.searchMaxCount, config.chatLunaMaxCount)
        const result = await executePixivSearch(session, {
          keyword: input.keyword,
          count: clampCount(input.count, config.searchDefaultCount, maxCount),
          r18Mode: r18.mode,
          sendMode: sendMode.mode,
          target: input.target || config.searchDefaultTarget,
          sort: input.sort || config.searchDefaultSort,
          pagePolicy: input.page || config.searchDefaultPagePolicy,
          excludeAI: input.ai ?? config.searchExcludeAI,
          minBookmarks: resolveChatLunaQuality(input.quality),
          quoteErrors: false,
          debugSource: 'chatluna.pixiv_search',
        })
        return withChatLunaPolicyNotes(result.text, { r18Forced: r18.forced, sendModeForced: sendMode.forced })
      }
    }

    class ChatLunaPixivRandomTool extends StructuredTool {
      name: string
      description = '随机发送 Pixiv 热门作品到当前聊天。适合用户要求随机来几张、试试手气、找热门 Pixiv 图片时调用。'
      schema = pixivRandomToolSchema

      constructor(toolName: string) {
        super()
        this.name = toolName
      }

      async _call(input: PixivRandomToolInput, _runManager?: unknown, runConfig?: any) {
        const session = runConfig?.configurable?.session as Session | undefined
        if (!session) return 'Pixiv 随机热门工具无法获取当前会话。'
        if (!config.enableRandom) return 'Pixiv 随机热门功能未启用。'

        const r18 = resolveChatLunaR18Mode(input.r18, config.randomDefaultR18)
        if (r18.error) return r18.error
        const sendMode = resolveChatLunaSendMode(input.mode)
        const maxCount = mergeMaxCounts(config.randomMaxCount, config.chatLunaMaxCount)
        const result = await executePixivRandom(session, {
          count: clampCount(input.count, config.randomDefaultCount, maxCount),
          r18Mode: r18.mode,
          sendMode: sendMode.mode,
          pagePolicy: input.page || config.randomDefaultPagePolicy,
          excludeAI: input.ai ?? config.randomExcludeAI,
          dedupEnabled: config.randomDedupEnabled,
          quoteErrors: false,
          debugSource: 'chatluna.pixiv_random',
        })
        return withChatLunaPolicyNotes(result.text, { r18Forced: r18.forced, sendModeForced: sendMode.forced })
      }
    }

    const registered = new Set<string>()
    const meta = {
      source: 'extension',
      group: 'image',
      tags: ['pixiv', 'image', 'search'],
      defaultAvailability: {
        enabled: true,
        main: true,
        chatluna: true,
        characterScope: 'all',
      },
    }

    if (config.chatLunaExposeSearch) {
      const toolName = config.chatLunaSearchToolName.trim() || 'pixiv_search'
      const dispose = platform.registerTool(toolName, {
        description: '搜索 Pixiv 作品并发送到当前聊天，支持数量、R18 策略、发送方式、收藏阈值、搜索范围和多页策略。',
        createTool() {
          return new ChatLunaPixivSearchTool(toolName)
        },
        selector() {
          return true
        },
        authorization(session: Session) {
          return !!session
        },
        meta,
      })
      registered.add(toolName)
      ctx.on('dispose', dispose)
      if (config.debug) logger.info(`[ChatLuna] 已注册 Pixiv 搜索工具 ${toolName}`)
    }

    if (config.chatLunaExposeRandom) {
      const toolName = config.chatLunaRandomToolName.trim() || 'pixiv_random'
      if (registered.has(toolName)) {
        logger.warn(`[ChatLuna] 随机热门工具名称 ${toolName} 已被占用，跳过注册。`)
        return
      }
      const dispose = platform.registerTool(toolName, {
        description: '随机发送 Pixiv 热门作品到当前聊天，支持数量、R18 策略、发送方式和多页策略。',
        createTool() {
          return new ChatLunaPixivRandomTool(toolName)
        },
        selector() {
          return true
        },
        authorization(session: Session) {
          return !!session
        },
        meta,
      })
      ctx.on('dispose', dispose)
      if (config.debug) logger.info(`[ChatLuna] 已注册 Pixiv 随机热门工具 ${toolName}`)
    }
  }
  ctx.inject(['chatluna'], () => {
    void registerChatLunaTools()
  })

  ctx.command('pid <id:string>', '通过 ID 获取 Pixiv 插画')
    .action(async ({ session }, id) => {
      if (!id || !/^\d+$/.test(id)) return '请输入有效的 Pixiv 作品 ID。'
      const result = await handlePixivRequest(session, id, 'command')
      await sendMessagePayload(result, message => session.send(message))
    })

  ctx.command('uid <uid:string>', '获取 Pixiv 作者主页信息与截图')
    .action(async ({ session }, uid) => {
      if (!config.enableUidCommand) return 'uid 指令未启用。'

      if (!ctx.puppeteer) {
        logger.warn('uid 指令需要 puppeteer 服务，但该服务未启用或未注入。')
        return '错误：此功能依赖的 puppeteer 服务未启用。'
      }
      
      if (!uid || !/^\d+$/.test(uid)) return '请输入有效的 Pixiv 用户 ID。'
      const statusMessage = await session.send(h('quote', { id: session.messageId }) + `正在获取作者信息 (UID: ${uid})...`)
      try {
        const [detailResponse, screenshotBuffer] = await Promise.all([
          config.sendUserInfoText ? pixiv.getUserDetail(uid) : Promise.resolve(null),
          takeUserPageScreenshot(uid)
        ])
        const messageElements: h[] = []
        if (detailResponse?.user) {
          const { user, profile } = detailResponse
          let textInfo = `[作者] ${user.name} (@${user.account})`
            + `\n[主页] https://www.pixiv.net/users/${user.id}`
          if (profile.total_follow_users) textInfo += `\n[关注] ${profile.total_follow_users} 人`
          const totalWorks = profile.total_illusts + profile.total_manga
          if (totalWorks > 0) textInfo += `\n[插画/漫画] ${totalWorks} 个`
          const cleanBio = (profile.comment || '').replace(/<br \/>/g, "\n").replace(/<[^>]*>/g, "")
          if (cleanBio) textInfo += `\n[简介] ${cleanBio}`
          messageElements.push(h('p', textInfo))
        } else if (config.sendUserInfoText) {
          messageElements.push(h('p', `获取作者文本信息失败。`))
        }

        if (screenshotBuffer) {
          messageElements.push(h.image(screenshotBuffer, 'image/png'))
        } else {
          messageElements.push(h('p', `获取主页截图失败。`))
        }
        await sendMessagePayload(messageElements, message => session.send(message))
      } catch (error) {
        logger.error(`处理 UID 请求时发生未知错误 (UID: ${uid}):`, error)
        return h('quote', { id: session.messageId }) + `处理时发生未知错误：${error.message}`
      } finally {
        try { await session.bot.deleteMessage(session.channelId, statusMessage[0]) } catch (e) {}
      }
    })

  ctx.command('pixivsearch <keyword:text>', '搜索 Pixiv 作品并直接返回结果')
    .option('count', '-n <count:number>')
    .option('r18', '-r <mode:string>')
    .option('mode', '-m <mode:string>')
    .option('quality', '-q <value:string>')
    .option('sort', '-s <sort:string>')
    .option('target', '-t <target:string>')
    .option('ai', '-a <value:string>')
    .option('page', '-p <policy:string>')
    .action(async ({ session, options }, keyword) => {
      if (!config.enableSearch) return '搜索功能未启用。'
      if (!keyword || !keyword.trim()) return '请输入搜索关键词。'

      const count = clampCount(options.count, config.searchDefaultCount, config.searchMaxCount)
      const requestedR18 = parseEnumOption(options.r18, ['exclude', 'include', 'only'] as const, config.searchDefaultR18)
      if (!requestedR18) return 'R18 参数无效，可用值：exclude、include、only。'
      const r18Mode = resolveR18Mode(requestedR18)
      if (!r18Mode) return '当前 R18 总开关不允许只搜索 R18 作品。'

      const sendMode = parseEnumOption(options.mode, ['auto', 'direct', 'forward', 'pdf'] as const, config.searchDefaultSendMode)
      if (!sendMode) return '发送方式参数无效，可用值：auto、direct、forward、pdf。'
      const sort = parseEnumOption(options.sort, ['date_desc', 'date_asc'] as const, config.searchDefaultSort)
      if (!sort) return '排序参数无效，可用值：date_desc、date_asc。'
      const target = parseEnumOption(options.target, ['tag', 'exact', 'text'] as const, config.searchDefaultTarget)
      if (!target) return '搜索范围参数无效，可用值：tag、exact、text。'
      const pagePolicy = parseEnumOption(options.page, ['first', 'all'] as const, config.searchDefaultPagePolicy)
      if (!pagePolicy) return '作品页发送策略参数无效，可用值：first、all。'
      const excludeAI = parseBooleanOption(options.ai, config.searchExcludeAI)
      if (excludeAI === null) return 'AI 过滤参数无效，可用值：true、false、on、off。'

      let minBookmarks = config.searchPreferHighBookmarks ? config.searchDefaultMinBookmarks : 0
      if (options.quality !== undefined && options.quality !== null && options.quality !== '') {
        const qualityText = String(options.quality).trim().toLowerCase()
        if (qualityText === 'off') {
          minBookmarks = 0
        } else {
          const parsed = Number(qualityText)
          if (!Number.isFinite(parsed) || parsed < 0) return '收藏阈值参数无效，请输入 0 或正整数，也可以输入 off。'
          minBookmarks = Math.floor(parsed)
        }
      }

      const result = await executePixivSearch(session, {
        keyword,
        count,
        r18Mode,
        sendMode,
        target,
        sort,
        pagePolicy,
        excludeAI,
        minBookmarks,
        quoteErrors: true,
        debugSource: 'pixivsearch',
      })
      if (!result.ok) return result.text
    })

  ctx.command('pixivrandom [count:number]', '随机发送热门 Pixiv 作品')
    .alias('试试手气')
    .action(async ({ session }, countInput) => {
      if (!config.enableRandom) return '随机热门功能未启用。'
      const count = clampCount(countInput, config.randomDefaultCount, config.randomMaxCount)
      const r18Mode = resolveR18Mode(config.randomDefaultR18)
      if (!r18Mode) return '当前 R18 总开关不允许只随机 R18 作品。'
      const result = await executePixivRandom(session, {
        count,
        r18Mode,
        sendMode: config.randomDefaultSendMode,
        pagePolicy: config.randomDefaultPagePolicy,
        excludeAI: config.randomExcludeAI,
        dedupEnabled: config.randomDedupEnabled,
        quoteErrors: true,
        debugSource: 'pixivrandom',
      })
      if (!result.ok) return result.text
    })

  ctx.command('pixivtest <uid:string>', '测试获取作者最新作品并推送到当前频道')
    .action(async ({ session }, uid) => {
      if (!config.enableSubscription) return '订阅功能未启用。'
      if (!uid || !/^\d+$/.test(uid)) return '请输入有效的作者 UID。'
      await session.send(`正在为 [${uid}] 获取最新作品并模拟推送到当前会话...`)
      const illusts = await pixiv.getUserIllusts(uid)
      if (!illusts || illusts.length === 0) return '无法找到该作者的任何作品。'
      const latestId = illusts[0].id.toString()
      await session.send(`成功获取到最新作品ID: ${latestId}\n正在生成内容...`)
      const messageContent = await handlePixivRequest(session, latestId, 'middleware', true)
      if (messageContent) await sendMessagePayload(messageContent, message => session.send(message))
      else await session.send('内容生成失败。')
    })

  ctx.command('pixivcheck', '立即检查所有订阅并推送更新')
    .action(async ({ session }) => {
      if (!config.enableSubscription) return '订阅功能未启用。'
      session.send('正在手动触发所有订阅的更新任务...')
      return await checkAndPushUpdates(true)
    })

  ctx.middleware(async (session, next) => {
    if (!config.enableLinkParse) return next()
    const match = session.content.match(/pixiv\.net\/(?:artworks|i)\/(\d+)/)
    if (!match) return next()
    if (session.content.startsWith(ctx.root.config.prefix[0] + 'pid')) return next()
    const id = match[1]
    const result = await handlePixivRequest(session, id, 'middleware')
    await sendMessagePayload(result, message => session.send(message))
  })

  if (config.enableSubscription) {
    logger.info('Pixiv 订阅功能已启动。')
    ctx.on('ready', async () => {
        if (config.debug) logger.info('[订阅] 正在初始化最新作品ID...');
        if (!config.subscriptions || config.subscriptions.length === 0) return;
        for (const sub of config.subscriptions) {
            const record = await ctx.database.get('pixiv_last_artworks', { author_id: sub.uid })
            if (record.length === 0) {
                const illusts = await pixiv.getUserIllusts(sub.uid)
                if (illusts && illusts.length > 0) {
                    await ctx.database.create('pixiv_last_artworks', { author_id: sub.uid, last_artwork_id: illusts[0].id.toString() })
                }
            }
        }
        if (config.debug) logger.info('[订阅] 初始化完成。');
    });

    const interval = setInterval(() => checkAndPushUpdates(false), config.updateInterval * Time.minute)
    ctx.on('dispose', () => {
        clearInterval(interval)
        logger.info('Pixiv 订阅功能已关闭。')
    })
  }
}
