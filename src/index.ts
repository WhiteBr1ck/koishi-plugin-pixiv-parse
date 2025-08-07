import { Context, Schema, Logger, h, Session, Next, sleep, Time } from 'koishi'
import { promises as fs } from 'fs'
import path from 'path'
import { Recipe } from 'muhammara'
import sharp from 'sharp'
import Puppeteer from 'koishi-plugin-puppeteer'

export const name = 'pixiv-parse'
export const inject = {
  required: ['http', 'puppeteer', 'database'],
}

const logger = new Logger(name)

declare module 'koishi' {
  interface Context {
    puppeteer: Puppeteer
  }
  interface Tables {
    pixiv_last_artworks: {
      author_id: string
      last_artwork_id: string
    }
  }
}


export type Subscription = {
  uid: string
  name: string
  channelIds: string[]
}


export interface Config {
  refreshToken?: string
  phpsessid?: string
  sendTags: boolean
  sendAuthor: boolean
  sendLinkWithCommand: boolean
  r18Action: 'block' | 'warn' | 'send'
  forwardThreshold: number
  pdfThreshold: number
  autoPdfForR18: boolean
  pdfPassword?: string
  pdfSendMode: 'buffer' | 'file'
  enableCompression: boolean
  compressionQuality: number
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
}

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    refreshToken: Schema.string().role('secret').description('Pixiv API Refresh Token。用于 API 请求。'),
    phpsessid: Schema.string().role('secret').description('Pixiv 网页版 Cookie (PHPSESSID)。用于 Puppeteer 截图。'),
  }).description('账户设置'),
  
  Schema.object({
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
    
    pdfSendMode: Schema.union([
      Schema.const('buffer').description('buffer (内存模式)'),
      Schema.const('file').description('file (硬盘模式)')
    ]).description('【PDF模式】发送方式。Docker 环境请选择 buffer 。').default('buffer'),
    enableCompression: Schema.boolean().description('【PDF模式】是否启用图片压缩以减小 PDF 文件体积。').default(true),
    compressionQuality: Schema.number().min(1).max(100).step(1).role('slider').default(80)
      .description('【PDF模式】JPEG 图片质量 (1-100)。注意：JPEG为有损压缩，100为最高质量而非无损。'),
  }).description('插画输出模式设置'),
  
  Schema.object({
    enableUidCommand: Schema.boolean().description('是否启用 `uid` 指令来获取作者主页截图。注意：该功能依赖 Puppeteer 服务插件，且会消耗更多资源。').default(true),
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
          })).role('table').description('订阅列表'),
      }),
  ]),

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
  ctx.model.extend('pixiv_last_artworks', {
    author_id: 'string',
    last_artwork_id: 'string',
  }, {
    primary: 'author_id',
  })

  const pixiv = new PixivService(ctx, config)


  async function createPdfFile(illust: any, buffers: Buffer[]): Promise<string> {
    const safeTitle = (illust.title || illust.id).replace(/[\\/:\*\?"<>\|]/g, '_')
    const tempDir = path.resolve(ctx.app.baseDir, 'data', 'temp', 'pixiv-parse')
    const tempPdfPath = path.resolve(tempDir, `${safeTitle}_${Date.now()}.pdf`)
    const tempImageDir = path.resolve(tempDir, `pid_${illust.id}_${Date.now()}`)

    await fs.mkdir(tempImageDir, { recursive: true })
    const recipe = new Recipe("new", tempPdfPath, { version: 1.6 });
    try {
      for (const [index, buffer] of buffers.entries()) {
        const tempImagePath = path.resolve(tempImageDir, `${index + 1}.jpg`)
        let imageToProcess = sharp(buffer)
        if (config.enableCompression) {
          imageToProcess = imageToProcess.jpeg({ quality: config.compressionQuality })
        }
        await imageToProcess.toFile(tempImagePath)
        const metadata = await sharp(tempImagePath).metadata()
        recipe.createPage(metadata.width, metadata.height).image(tempImagePath, 0, 0, {
          keepAspectRatio: true,
          width: metadata.width,
          height: metadata.height,
        }).endPage()
      }
      if (config.pdfPassword) recipe.encrypt({ userPassword: config.pdfPassword, ownerPassword: config.pdfPassword })
      recipe.endPDF()

      return tempPdfPath
    } finally {

      try { await fs.rm(tempImageDir, { recursive: true, force: true }) } catch {}
    }
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

  async function handlePixivRequest(session: Session, id: string, source: 'command' | 'middleware', isSubscription = false): Promise<h[] | h | string | null> {
    const statusMessage = !isSubscription ? await session.send(h('quote', { id: session.messageId }) + `正在解析 Pixiv 作品 (ID: ${id})...`) : null
    try {
      const illust = await pixiv.getArtworkDetail(id)
      if (!illust) return isSubscription ? null : h('quote', { id: session.messageId }) + '找不到该 ID 对应的插画作品。'

      const isR18 = illust.x_restrict > 0
      if (isR18) {
        if (config.r18Action === 'block') return isSubscription ? null : h('quote', { id: session.messageId }) + '根据配置，已屏蔽 R-18 作品。'
        if (config.r18Action === 'warn' && !isSubscription) return h('quote', { id: session.messageId }) + `[警告] 该作品为 R-18/R-18G 内容！\n标题: ${illust.title}\n作者: ${illust.user.name}`
      }

      const imageUrls: string[] = []
      if (illust.meta_pages && illust.meta_pages.length > 0) {
        imageUrls.push(...illust.meta_pages.map(p => p.image_urls.original))
      } else {
        imageUrls.push(illust.meta_single_page.original_image_url)
      }
      
      const imageBuffers = (await Promise.all(imageUrls.map(url => pixiv.downloadImage(url)))).filter(Boolean)

      if (imageBuffers.length === 0) return isSubscription ? null : h('quote', { id: session.messageId }) + '所有图片都下载失败了，无法发送。'
      
      const imageCount = imageBuffers.length
      let textInfo = (isSubscription ? `[${illust.user.name} 的作品更新]\n` : '')
        + `[标题] ${illust.title}`
        + (config.sendAuthor ? `\n[作者] ${illust.user.name}` : '')
        + (config.sendTags && illust.tags.length > 0 ? `\n[标签] ${illust.tags.map(t => t.name).join(', ')}` : '')
        + (isR18 ? `\n[警告] 本作品为 R-18/R-18G 内容` : '')
      
      if (source === 'command' && config.sendLinkWithCommand) {
        textInfo += `\n[源链接] https://www.pixiv.net/artworks/${id}`
      }
      
      const safeTitle = (illust.title || illust.id).replace(/[\\/:\*\?"<>\|]/g, '_');

      const shouldCreatePdf = (config.autoPdfForR18 && isR18) || (config.pdfThreshold > 0 && imageCount >= config.pdfThreshold);


      if (shouldCreatePdf) {
        const pdfPath = await createPdfFile(illust, imageBuffers);
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
          return messageElements;
        } finally {

          const delay = config.pdfSendMode === 'file' ? 5000 : 0;
          setTimeout(() => {
            fs.unlink(pdfPath).catch(e => logger.warn(`[PDF] 清理临时文件失败 ${pdfPath}:`, e));
          }, delay);
        }
      }

      const allContentNodes: h[] = [h('p', textInfo), ...imageBuffers.map(buffer => h.image(buffer, 'image/png'))]
      
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
                        await bot.sendMessage(channelId, Array.isArray(messageContent) ? messageContent.join('\n') : messageContent)
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

  ctx.command('pid <id:string>', '通过 ID 获取 Pixiv 插画')
    .action(async ({ session }, id) => {
      if (!id || !/^\d+$/.test(id)) return '请输入有效的 Pixiv 作品 ID。'
      const result = await handlePixivRequest(session, id, 'command')
      if (result) await session.send(Array.isArray(result) ? result.join('\n') : result)
    })

  ctx.command('uid <uid:string>', '获取 Pixiv 作者主页信息与截图')
    .action(async ({ session }, uid) => {
      if (!config.enableUidCommand) return 'uid 指令未启用。'
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
        await session.send(messageElements)
      } catch (error) {
        logger.error(`处理 UID 请求时发生未知错误 (UID: ${uid}):`, error)
        return h('quote', { id: session.messageId }) + `处理时发生未知错误：${error.message}`
      } finally {
        try { await session.bot.deleteMessage(session.channelId, statusMessage[0]) } catch (e) {}
      }
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
      if (messageContent) await session.send(Array.isArray(messageContent) ? messageContent.join('\n') : messageContent)
      else await session.send('内容生成失败。')
    })

  ctx.command('pixivcheck', '立即检查所有订阅并推送更新')
    .action(async ({ session }) => {
      if (!config.enableSubscription) return '订阅功能未启用。'
      session.send('正在手动触发所有订阅的更新任务...')
      return await checkAndPushUpdates(true)
    })

  ctx.middleware(async (session, next) => {
    const match = session.content.match(/pixiv\.net\/(?:artworks|i)\/(\d+)/)
    if (!match) return next()
    if (session.content.startsWith(ctx.root.config.prefix[0] + 'pid')) return next()
    const id = match[1]
    const result = await handlePixivRequest(session, id, 'middleware')
    if (result) await session.send(Array.isArray(result) ? result.join('\n') : result)
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