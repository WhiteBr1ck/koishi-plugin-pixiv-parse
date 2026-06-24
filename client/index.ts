import type { Context } from '@koishijs/client'
import PixivConfigNavLoader from './PixivConfigNavLoader.vue'

export default (ctx: Context) => {
  ctx.slot({
    type: 'plugin-details',
    component: PixivConfigNavLoader,
    order: -997,
  })
}
