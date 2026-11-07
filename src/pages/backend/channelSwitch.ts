import { BACKENDS, settings, type BackendId } from '@/state/settings';

/**
 * 渠道页页签 = 出图渠道开关。
 *
 * 【为什么单独成模块】这两个函数是「点页签」这个动作的全部语义,而它出过事故:
 * 早先页签只切本机浏览态 viewing(看哪个面板),真正决定出图的 settings.defaultBackend
 * 要另按面板底部的「使用此渠道出图」。用户点了「DSH 写手」页签、看着 DSH 面板,
 * 出图却仍走 ComfyUI,楼层卡片提示「到渠道页切换渠道」——而他就站在那一页。
 * 两个长得一样的开关是这整类困惑的源头,故 viewing 整个删除,语义收进这里,
 * 并由单测钉死「点页签必须真的切渠道」。
 */

/** 页签上该点亮哪一个 = 当前出图渠道。唯一定义处(不要再引入第二个状态)。 */
export function activeChannel(): BackendId {
  return settings.defaultBackend;
}

/** 点页签:切到这条渠道。幂等——已是当前渠道时不产生任何写操作(避免无意义回写服务器)。 */
export function selectChannel(id: BackendId): void {
  if (settings.defaultBackend !== id) settings.defaultBackend = id;
}

/** 渠道的中文名;取不到时回落 id 本身(总比空串强,报错文案里更不该是空的)。 */
export function channelLabel(id: BackendId): string {
  return BACKENDS.find(b => b.value === id)?.label ?? String(id);
}

/** 渠道页可显示的页签:webui 暂不开放(存量值由设置迁移改写,这里只负责不显示)。 */
export function visibleChannels(): { value: BackendId; label: string }[] {
  return BACKENDS.filter(b => b.value !== 'webui');
}
