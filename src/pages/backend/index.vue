<script setup lang="ts">
import type { BackendId } from '@/state/settings';
import { computed, type Component } from 'vue';
import { activeChannel, selectChannel, visibleChannels } from './channelSwitch';
import ComfyUIPanel from './panels/ComfyUIPanel.vue';
import DshBridgePanel from './panels/DshBridgePanel.vue';
import NaiPanel from './panels/NaiPanel.vue';
import WebUIPanel from './panels/WebUIPanel.vue';

/**
 * 渠道页:页签**就是**出图渠道开关。
 *
 * 【为什么不再有第二个状态】这里曾经有两个:viewing(看哪个面板,存 localStorage 的本机
 * 浏览态)与 settings.defaultBackend(真正决定出图的那条)。用户点「DSH 写手」页签只改了前者,
 * 出图照旧走 ComfyUI —— 于是楼层卡片提示「到渠道页切换渠道」,而他就站在那一页上。
 * 两个状态长得一样、语义不同,是这一整类困惑的源头,故整个 viewing 删掉:
 * 页签 = defaultBackend,点页签 = 切渠道,没有第二处可以漂移。
 *
 * 面板底部的「使用此渠道出图 / 当前出图渠道」保留:它现在只是同一意义的另一个入口,
 * 与设置页「出图后端」下拉三方读写同一个字段,任一处改动页签立刻跟随。
 *
 * webui 暂不开放:入口藏掉(代码保留,便于后续恢复);merge 已把存量 webui 值迁移走。
 */
const VISIBLE_BACKENDS = visibleChannels();

/** 当前出图渠道 = 当前页签。语义全在 channelSwitch.ts（含为什么不能有第二个状态）。 */
const active = computed<BackendId>(() => activeChannel());

// Record<BackendId, …> 是穷尽类型:新增后端不加这一项,编译就会报缺键,
// 比运行期「页签点了却是空白面板」早得多暴露出来。
const PANELS: Record<BackendId, Component> = {
  webui: WebUIPanel,
  comfyui: ComfyUIPanel,
  dshbridge: DshBridgePanel,
  nai: NaiPanel,
};
// 存量值不可见(webui)时回落第一个可见页签,避免整页空白。
const activePanel = computed(() =>
  VISIBLE_BACKENDS.some(b => b.value === active.value) ? PANELS[active.value] : PANELS[VISIBLE_BACKENDS[0].value],
);
</script>

<template>
  <section class="bbi-page">
    <div class="bbi-page-head">
      <h2 class="bbi-title bbi-title-sub">渠道</h2>
      <div class="bbi-segmented" role="tablist" aria-label="生图渠道">
        <button
          v-for="b in VISIBLE_BACKENDS"
          :key="b.value"
          class="bbi-seg"
          :class="{ 'is-on': active === b.value }"
          type="button"
          role="tab"
          :aria-selected="active === b.value"
          @click="selectChannel(b.value)"
        >
          {{ b.label }}
        </button>
      </div>
      <p class="bbi-field-hint bbi-channel-hint">
        点页签即切换出图渠道，选中的那条立刻生效（楼层卡片下一次出图就走它）。
      </p>
    </div>
    <hr class="bbi-rule" />

    <!-- KeepAlive:切换渠道时保留各面板的折叠/输入状态 -->
    <KeepAlive>
      <component :is="activePanel" :key="active" />
    </KeepAlive>
  </section>
</template>

<style scoped>
/* 窄屏下标题与渠道分段控件分两行,不挤压 */
.bbi-page-head {
  flex-wrap: wrap;
}
.bbi-channel-hint {
  flex-basis: 100%;
  margin: 8px 0 0;
}
</style>
