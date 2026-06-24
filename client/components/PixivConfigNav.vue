<template>
  <div
    data-pixiv-parse-nav="1"
    :class="[$style.container, collapsed ? $style.collapsed : '']"
    :style="containerPosition"
  >
    <div :class="$style.header" @mousedown="startMove" @touchstart="startMove">
      <span :class="$style.handle">::</span>
      <button :class="$style.toggle" type="button" @click.stop="collapsed = !collapsed" @mousedown.stop @touchstart.stop>
        v
      </button>
    </div>
    <div :class="$style.body">
      <div :class="$style.section">
        <div :class="$style.sectionTitle">配置</div>
        <div
          v-for="item in staticItems"
          :key="item.id"
          :class="[$style.item, activeItem === item.id ? $style.active : '']"
          @click="toSchema(item.id, item.keys)"
        >
          {{ item.label }}
        </div>
      </div>
      <div v-if="subscriptionItems.length" :class="$style.section">
        <div :class="$style.sectionTitle">订阅</div>
        <div
          v-for="item in subscriptionItems"
          :key="item.id"
          :class="[$style.item, activeItem === `sub-${item.id}` ? $style.active : '']"
          @click="toSubscription(item.id)"
        >
          {{ item.label }}
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, inject, onUnmounted, reactive, ref, watch } from 'vue'
import type { ComputedRef } from 'vue'

interface SubscriptionConfig {
  uid?: string
  name?: string
}

interface PixivParseConfig {
  subscriptions?: SubscriptionConfig[]
}

const current = inject<ComputedRef<{ config: PixivParseConfig }>>('manager.settings.current')
const collapsed = ref(false)
const activeItem = ref('')

const staticItems = [
  { id: 'account', label: '账户设置', keys: ['refreshToken', 'phpsessid'] },
  { id: 'send', label: '发送设置', keys: ['enableLinkParse', 'sendTags', 'sendAuthor', 'r18Action'] },
  { id: 'output', label: '插画输出模式设置', keys: ['forwardThreshold', 'pdfThreshold', 'enableDirectCompress'] },
  { id: 'uid', label: '作者主页 (UID) 设置', keys: ['enableUidCommand', 'sendUserInfoText'] },
  { id: 'subscription', label: '订阅设置', keys: ['enableSubscription', 'subscriptions'] },
  { id: 'search', label: '搜索设置', keys: ['enableSearch', 'searchDefaultCount', 'searchDefaultPagePolicy'] },
  { id: 'random', label: '随机热门设置', keys: ['enableRandom', 'randomDefaultCount', 'randomDefaultPagePolicy'] },
  { id: 'chatluna', label: 'ChatLuna 工具', keys: ['enableChatLunaTools', 'chatLunaExposeSearch', 'chatLunaExposeRandom'] },
  { id: 'network', label: '网络与下载设置', keys: ['downloadConcurrency'] },
  { id: 'debug', label: '调试设置', keys: ['debug'] },
  { id: 'advanced', label: '高级设置', keys: ['clientId', 'clientSecret'] },
]

const subscriptionItems = computed(() => {
  const list = current?.value?.config?.subscriptions ?? []
  return list.map((item, index) => {
    const name = item?.name?.trim()
    const uid = item?.uid?.trim()
    return {
      id: String(index),
      label: name || uid || `订阅 ${index + 1}`,
      name,
      uid,
    }
  })
})

const mouseInfo = reactive({
  ing: false,
  top: 100,
  right: 20,
  startTop: 0,
  startRight: 0,
  startX: 0,
  startY: 0,
  width: 0,
  height: 0,
})

const containerPosition = computed(() => ({
  top: `${mouseInfo.top}px`,
  right: `${mouseInfo.right}px`,
}))

function getText(node: Element) {
  const element = node as HTMLElement
  const values = Array.from(element.querySelectorAll('input, textarea'))
    .map((input) => (input as HTMLInputElement | HTMLTextAreaElement).value)
    .join('\n')
  return `${element.innerHTML}\n${element.textContent || ''}\n${values}`
}

function findSchemaNode(test: (text: string) => boolean) {
  const nodes = document.querySelectorAll('.k-schema-left')
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]
    if (test(getText(node))) return node as HTMLElement
  }
}

function findSubscriptionRootNode() {
  return findSchemaNode((text) => {
    if (text.includes('subscriptions[') || text.includes('subscriptions.')) return false
    return text.includes('subscriptions') || text.includes('订阅列表')
  })
}

function getSchemaItem(node: HTMLElement) {
  return node.closest('.k-schema-item') as HTMLElement | null
}

function getSchemaGroup(node: HTMLElement) {
  const item = getSchemaItem(node)
  const group = item?.nextElementSibling
  return group?.classList.contains('k-schema-group') ? group as HTMLElement : null
}

function isInjectedToggleButton(button: Element) {
  return (button as HTMLElement).dataset.pixivSubscriptionToggle === '1'
}

function isSchemaCollapsed(node: HTMLElement) {
  const group = getSchemaGroup(node)
  if (group) {
    const style = window.getComputedStyle(group)
    if (group.dataset.pixivCollapsed === '1' || group.classList.contains('collapsed') || style.display === 'none') return true
    return false
  }
  const item = getSchemaItem(node)
  return !!Array.from(item?.querySelectorAll('.k-schema-right button') ?? [])
    .filter((button) => !isInjectedToggleButton(button))
    .some((button) => getText(button).includes('展开') || getText(button).toLowerCase().includes('expand'))
}

function scrollNode(node: HTMLElement) {
  node.scrollIntoView({ block: 'center' })
}

function clickExpandButton(node: HTMLElement) {
  const item = getSchemaItem(node)
  const button = Array.from(item?.querySelectorAll('.k-schema-right button') ?? [])
    .filter((button) => !isInjectedToggleButton(button))
    .find((button) => getText(button).includes('展开') || getText(button).toLowerCase().includes('expand')) as HTMLElement
  button?.click()
}

function expandSubscriptionGroup(node: HTMLElement) {
  const group = getSchemaGroup(node)
  if (group?.dataset.pixivCollapsed === '1') {
    delete group.dataset.pixivCollapsed
    group.style.display = ''
    return true
  }
  clickExpandButton(node)
  return true
}

function collapseSubscriptionGroup(node: HTMLElement) {
  const group = getSchemaGroup(node)
  if (!group) return false
  group.dataset.pixivCollapsed = '1'
  group.style.display = 'none'
  return true
}

let patchTimer: number | null = null

function schedulePatchSubscriptionToggle(delay = 80) {
  if (patchTimer !== null) window.clearTimeout(patchTimer)
  patchTimer = window.setTimeout(() => {
    patchTimer = null
    patchSubscriptionToggle()
  }, delay)
}

function patchSubscriptionToggle() {
  const root = findSubscriptionRootNode()
  if (!root) return
  const item = getSchemaItem(root)
  const right = item?.querySelector('.k-schema-right') as HTMLElement | null
  if (!right) return

  let button = right.querySelector('[data-pixiv-subscription-toggle="1"]') as HTMLButtonElement | null
  if (!button) {
    button = document.createElement('button')
    button.type = 'button'
    button.dataset.pixivSubscriptionToggle = '1'
    button.className = 'el-button pixiv-subscription-toggle'
    button.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      toggleSubscriptions()
      schedulePatchSubscriptionToggle(160)
      window.setTimeout(() => schedulePatchSubscriptionToggle(0), 420)
    })
    const menu = right.querySelector('.k-schema-menu')
    if (menu) right.insertBefore(button, menu)
    else right.appendChild(button)
  }
  const label = isSchemaCollapsed(root) ? '展开子项' : '折叠子项'
  if (button.textContent !== label) button.textContent = label
}

function ensureSubscriptionsExpanded(callback?: () => void) {
  const root = findSubscriptionRootNode()
  if (!root) return false
  if (isSchemaCollapsed(root)) {
    expandSubscriptionGroup(root)
    window.setTimeout(() => callback?.(), 120)
  } else {
    callback?.()
  }
  return true
}

function toSchema(id: string, keys: string[]) {
  const node = findSchemaNode((text) => keys.some((key) => text.includes(key)))
  if (!node) return
  scrollNode(node)
  activeItem.value = id
}

function toSubscription(index: string) {
  const keys = [`subscriptions.${index}.uid`, `subscriptions[${index}].uid`, `subscriptions.${index}.name`, `subscriptions[${index}].name`]
  const item = subscriptionItems.value[Number(index)]
  activeItem.value = `sub-${index}`
  const locate = () => {
    const node = findSchemaNode((text) => keys.some((key) => text.includes(key)) || (!!item?.uid && text.includes(item.uid)) || (!!item?.name && text.includes(item.name)))
    if (node) {
      scrollNode(node)
      return
    }
    const root = findSubscriptionRootNode()
    if (root) scrollNode(root)
  }
  if (!ensureSubscriptionsExpanded(locate)) locate()
}

function toggleSubscriptions() {
  const root = findSubscriptionRootNode()
  if (!root) return
  activeItem.value = 'subscription-list'
  scrollNode(root)
  if (isSchemaCollapsed(root)) {
    expandSubscriptionGroup(root)
  } else {
    collapseSubscriptionGroup(root)
  }
  schedulePatchSubscriptionToggle(200)
}

function getPointer(ev: MouseEvent | TouchEvent) {
  return ev instanceof TouchEvent ? ev.touches[0] as unknown as MouseEvent : ev
}

function startMove(ev: MouseEvent | TouchEvent) {
  const e = getPointer(ev)
  const rect = (e.target as HTMLElement).closest('[data-pixiv-parse-nav="1"]')?.getBoundingClientRect()
  if (rect) {
    mouseInfo.width = rect.width
    mouseInfo.height = rect.height
  }
  mouseInfo.startTop = mouseInfo.top
  mouseInfo.startRight = mouseInfo.right
  mouseInfo.startX = e.clientX
  mouseInfo.startY = e.clientY
  mouseInfo.ing = true
}

function onMousemove(ev: MouseEvent | TouchEvent) {
  if (!mouseInfo.ing) return
  const e = getPointer(ev)
  const top = mouseInfo.startTop + (e.clientY - mouseInfo.startY)
  const right = mouseInfo.startRight - (e.clientX - mouseInfo.startX)
  const boundary = document.querySelector('.plugin-view')?.getBoundingClientRect()
  let minTop = 0
  let maxTop = window.innerHeight - mouseInfo.height
  let minRight = 0
  let maxRight = window.innerWidth - mouseInfo.width
  if (boundary) {
    minTop = boundary.top
    maxTop = boundary.bottom - mouseInfo.height
    minRight = window.innerWidth - boundary.right
    maxRight = window.innerWidth - boundary.left - mouseInfo.width
  }
  mouseInfo.top = Math.max(minTop, Math.min(maxTop, top))
  mouseInfo.right = Math.max(minRight, Math.min(maxRight, right))
}

function endMove() {
  mouseInfo.ing = false
}

let observer: IntersectionObserver | null = null
let schemaObserver: MutationObserver | null = null
const observed = new Map<Element, string>()

function initObserver() {
  observer?.disconnect()
  observed.clear()
  observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        const id = observed.get(entry.target)
        if (id) activeItem.value = id
      }
    }
  }, { rootMargin: '-40% 0px -40% 0px', threshold: 0 })

  for (const item of staticItems) {
    const node = findSchemaNode((text) => item.keys.some((key) => text.includes(key)))
    if (node) {
      observed.set(node, item.id)
      observer.observe(node)
    }
  }
}

function initSchemaObserver() {
  schemaObserver?.disconnect()
  schemaObserver = new MutationObserver(() => schedulePatchSubscriptionToggle())
  schemaObserver.observe(document.body, { childList: true, subtree: true })
  schedulePatchSubscriptionToggle(0)
}

window.addEventListener('mousemove', onMousemove)
window.addEventListener('mouseup', endMove)
window.addEventListener('touchmove', onMousemove)
window.addEventListener('touchend', endMove)

watch(() => current?.value?.config, () => {
  window.setTimeout(() => {
    initObserver()
    initSchemaObserver()
    patchSubscriptionToggle()
  }, 800)
}, { immediate: true, deep: true })

onUnmounted(() => {
  window.removeEventListener('mousemove', onMousemove)
  window.removeEventListener('mouseup', endMove)
  window.removeEventListener('touchmove', onMousemove)
  window.removeEventListener('touchend', endMove)
  observer?.disconnect()
  schemaObserver?.disconnect()
  if (patchTimer !== null) window.clearTimeout(patchTimer)
})
</script>

<style module lang="scss">
.container {
  position: absolute;
  z-index: 1000;
  width: 200px;
  max-width: 90vw;
  max-height: 70vh;
  background: var(--k-card-bg);
  border: 1px solid var(--k-card-border);
  border-radius: 8px;
  box-shadow: var(--k-card-shadow);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  user-select: none;
}

.header {
  height: 30px;
  padding: 0 8px;
  border-bottom: 1px solid var(--k-color-divider, #ebeef5);
  background: var(--k-hover-bg);
  display: flex;
  align-items: center;
  justify-content: space-between;
  cursor: move;
}

.handle {
  color: var(--k-text-light);
  font-weight: 700;
  line-height: 1;
}

.toggle {
  border: 0;
  background: transparent;
  color: var(--k-text-light);
  cursor: pointer;
  font-size: 14px;
  transition: transform 0.2s ease;
}

.body {
  overflow-y: auto;
  padding: 4px 0;
}

.collapsed {
  max-height: 30px;

  .body {
    display: none;
  }

  .toggle {
    transform: rotate(-90deg);
  }
}

.section {
  margin-bottom: 4px;
}

.sectionTitle {
  padding: 6px 12px;
  font-size: 12px;
  font-weight: 600;
  color: var(--k-text-light);
  background: var(--k-bg-light);
}

.item {
  padding: 8px 14px;
  border-left: 3px solid transparent;
  color: var(--k-text-normal);
  cursor: pointer;
  font-size: 13px;
  word-break: break-word;

  &:hover {
    background: var(--k-hover-bg);
    color: var(--k-text-active);
  }
}

.active {
  color: var(--k-color-primary);
  background: var(--k-activity-bg);
  border-left-color: var(--k-color-primary);
  font-weight: 500;
}

:global(.pixiv-subscription-toggle) {
  margin-left: 8px;
}
</style>
