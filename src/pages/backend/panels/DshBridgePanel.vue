<script setup lang="ts">
import { DSH_WORLDBOOK_ENTRY, DSH_WORLDBOOK_TITLE } from '@/autoTag/dshPlaceholder';
import { DSH_PROTOCOL_VERSION, probeDshBridge, type DshHealth } from '@/backends/dshBridge';
import BbiCombo from '@/components/BbiCombo.vue';
import BbiSelect from '@/components/BbiSelect.vue';
import Collapsible from '@/components/Collapsible.vue';
import Icon from '@/components/Icon.vue';
import { copyText } from '@/st/clipboard';
import { effectiveDshBridge, settings } from '@/state/settings';
import { computed, ref } from 'vue';

/**
 * 「DSH 写手」渠道面板:只配怎么连与用哪套配置集。
 *
 * 与 ComfyUIPanel / NaiPanel 的骨架一致(Collapsible 分区 + 底部「使用此渠道出图」),
 * 差别在**没有提示词相关的一切**:这条线的提示词工程在 DSH 侧,柏宝绘面板里出现
 * 采样参数 / 质量词只会让用户以为它们会生效。
 *
 * 故本面板有三块独有内容:
 * 1. 写入方式说明(占位模式怎么工作)——它是这条渠道与另两条最大的不同;
 * 2. 「复制世界书条目」——让主模型知道要写占位;
 * 3. 测试连接顺带回填配置集候选(那一侧才知道用户装了哪几套)。
 */

/** 本渠道是否为当前出图渠道;「使用此渠道」按钮与设置页选择器、页签徽标同属一个开关。 */
const inUse = computed(() => settings.defaultBackend === 'dshbridge');

const testing = ref(false);
const health = ref<DshHealth | null>(null);

function errorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') return '操作已取消';
  return error instanceof Error ? error.message : String(error);
}

/** 配置集候选:探活拿到的清单 + 当前值(用户手填了个不在清单里的也要能显示出来)。 */
const configSetOptions = computed(() => {
  const list = health.value?.configSets ?? [];
  const current = settings.dshBridge.configSet.trim();
  if (current && !list.includes(current)) return [current, ...list];
  return list;
});

async function onTestConnection(): Promise<void> {
  if (testing.value) return;
  testing.value = true;
  health.value = null;
  try {
    const result = await probeDshBridge(effectiveDshBridge());
    health.value = result;
    // 协议版本先判:对面还是 v1(同步长连接)时,跨局域网一定会被中继掐断。
    // 这时候报「已连接」等于骗人——通道通不等于能用。
    if (result.protocol < DSH_PROTOCOL_VERSION) {
      toastr.warning(
        `对面是协议 v${result.protocol}（插件 ${result.version || '未知版本'}）：v1 是同步长连接，`
        + '经中继出图必被掐断。请把 dsh-story-image 升级到 v2（任务化 + 会话写串）。',
        'DSH 写手 · 协议版本过低',
      );
    } else if (!result.llmAvailable) {
      // llm 不可用不是失败(协议 §2:通道通、写不了串),故用 info 而不是 error
      toastr.info('桥接通了,但 DSH 侧拿不到写串用的模型', '柏宝绘');
    } else {
      toastr.success('已连接 DSH v' + (result.version || '?') + '（协议 v' + String(result.protocol) + '）', '柏宝绘');
    }
  } catch (error) {
    toastr.error(errorMessage(error), 'DSH 写手 · 连接失败');
  } finally {
    testing.value = false;
  }
}

async function copyWorldBook(): Promise<void> {
  await copyText(DSH_WORLDBOOK_ENTRY, `「${DSH_WORLDBOOK_TITLE}」已复制，粘到世界书条目的内容里`);
}

/** 超时以秒显示:面板里让用户填 180000 毫秒既难读,也容易多打或少打一个零。 */
const timeoutSec = computed({
  get: () => Math.round(settings.dshBridge.timeoutMs / 1000),
  set: (value: number) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return;
    settings.dshBridge.timeoutMs = Math.min(900, Math.max(5, Math.round(n))) * 1000;
  },
});

const COUNT_OPTIONS = ['1', '2', '3', '4'].map(v => ({ value: v, label: v + ' 张' }));

</script>
<template>
  <div class="panel">
    <p class="bbi-page-intro">
      把正文里的画面占位交给本机 DSH 的 dsh-story-image 插件，由它用配置集规范写成品串并调
      ComfyUI 出图，图片再回到楼层卡片。柏宝绘这边不写提示词，只负责把占位送到、把图落盘。
    </p>

    <div class="bbi-sections">
      <Collapsible title="配置" :open="true">
        <div class="bbi-field">
          <div class="bbi-field-head">
            <span class="bbi-field-label">桥接地址</span>
          </div>
          <input
            class="bbi-input"
            type="text"
            v-model="settings.dshBridge.url"
            placeholder="http://127.0.0.1:3080/story-image-bridge"
            spellcheck="false"
          />
        </div>

        <div class="bbi-field">
          <div class="bbi-field-head">
            <span class="bbi-field-label">令牌</span>
          </div>
          <input
            class="bbi-input"
            type="password"
            v-model="settings.dshBridge.token"
            placeholder="DSH 侧启用令牌校验时填；留空表示不校验"
            spellcheck="false"
          />
          <p class="bbi-field-hint">留空 = 不发 x-bbi-token 头。DSH 未启用校验时无需填写。</p>
        </div>

        <div class="bbi-field">
          <div class="bbi-field-head">
            <span class="bbi-field-label">配置集</span>
          </div>
          <BbiCombo
            v-model="settings.dshBridge.configSet"
            :options="configSetOptions"
            placeholder="留空 = 用 DSH 的默认配置集"
            aria-label="DSH 配置集"
          />
          <p class="bbi-field-hint">
            配置集决定成品串的写法与底模。点一次「测试连接」可拉回 DSH 侧已有的清单。
          </p>
        </div>

        <div class="bbi-field">
          <div class="bbi-field-head">
            <span class="bbi-field-label">超时（秒）</span>
          </div>
          <input class="bbi-input" type="number" min="5" max="900" v-model.number="timeoutSec" />
          <p class="bbi-field-hint">
            DSH 要现写串再调 ComfyUI 出图，全程都算在这一个超时里；超时按「ComfyUI 连不上」处理。
          </p>
        </div>

        <div class="bbi-field">
          <div class="bbi-field-head">
            <span class="bbi-field-label">请求张数</span>
          </div>
          <BbiSelect
            :model-value="String(settings.dshBridge.count)"
            :options="COUNT_OPTIONS"
            aria-label="请求张数"
            @update:model-value="settings.dshBridge.count = Number($event)"
          />
          <p class="bbi-field-hint">
            交给 DSH 一次生成几张。<b>柏宝绘的一个槽位只落第一张</b>——多出来的候选不进楼层，
            否则翻页器会把「同一次请求的候选」当成「同一提示词的历史」。
          </p>
        </div>

<div class="conn-actions">
          <span v-if="inUse" class="conn-inuse"><Icon name="check" :size="13" /> 当前出图渠道</span>
          <button
            v-else
            class="bbi-btn conn-use"
            type="button"
            @click="settings.defaultBackend = 'dshbridge'"
          >
            使用此渠道出图
          </button>
          <button class="bbi-btn" type="button" :disabled="testing" @click="onTestConnection">
            <Icon name="plug" />
            {{ testing ? '连接中…' : '测试连接' }}
          </button>
        </div>

        <!-- 探活结果：llm 是否可用、有哪些配置集，一次说清 -->
        <div v-if="health" class="bbi-field">
          <p class="bbi-field-hint">
            DSH v{{ health.version || '?' }} ·
            {{ health.llmAvailable ? '写串模型可用' : '写串模型不可用（连接通了但出不了图）' }}
            · 默认配置集 {{ health.defaultConfigSet || '未声明' }}
            · 场景上限 {{ health.promptMaxChars }} 字
          </p>
          <p v-if="health.configSets.length" class="bbi-field-hint">
            可用配置集：{{ health.configSets.join('、') }}
          </p>
        </div>
      </Collapsible>

      <Collapsible title="写入方式（占位）" :open="false">
        <p class="bbi-field-hint">
          这条渠道不靠柏宝绘自动生成 tag。主模型在写正文时按下面的格式在回复末尾追加一个占位，
          卡片上的「交给 DSH 出图」会把它送去 DSH：
        </p>
        <pre class="bbi-dsh-sample">&lt;bbi_image&gt;&lt;dsh&gt;傍晚的天台，林夏靠着栏杆回头，逆光把发梢照透&lt;/dsh&gt;&lt;size&gt;portrait&lt;/size&gt;&lt;/bbi_image&gt;</pre>
        <p class="bbi-field-hint">
          占位在显示与提示词两条路径上都会被替换掉，永不进 DOM、永不进提示词。
          带 &lt;dsh&gt; 的卡片走这条渠道；没有 &lt;dsh&gt; 的老 tag 仍按原来的 tag 流出图，
          两种格式可以在同一个聊天里共存。
        </p>
      </Collapsible>

      <Collapsible title="世界书条目" :open="false">
        <p class="bbi-field-hint">
          下面复制的是<b>主协议</b>：新建一条世界书条目（建议标题：{{ DSH_WORLDBOOK_TITLE }}），
          触发方式选<b>常驻</b>（蓝灯），把正文粘进去。主模型每轮都会看到它，才会按格式写占位。
        </p>
        <p class="bbi-field-hint">
          想一次导全，用仓库里的 <code>docs/worldbook/01-柏宝绘-DSH画面占位.json</code>：
          除了主协议，还带「镜头与画幅」「亲密与露骨镜头」两条关键词触发的补充（用户聊到才注入，不占常驻预算），
          以及一条默认禁用的卡内精简版。
        </p>
        <p class="bbi-field-hint">
          <b>柏宝绘不会自动写入世界书</b>：ST 没有对外暴露写条目的一类接口，硬写只能摸未公开的内部函数，
          ST 一升级就断，还会在用户书单里留下他没同意过的条目。
        </p>
        <div class="conn-actions">
          <button class="bbi-btn" type="button" @click="copyWorldBook">
            <Icon name="copy" />
            复制世界书条目
          </button>
        </div>
      </Collapsible>
    </div>
  </div>
</template>

<style scoped>
/* 占位示例：等宽且不折行（窄屏上这一行很长，折开会把 <dsh> 切成两半），横向滚动由用户自己滑 */
.bbi-dsh-sample {
  margin: 8px 0;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--bbi-surface-2, rgba(127, 127, 127, 0.1));
  font-family: var(--bbi-font-mono, monospace);
  font-size: 12.5px;
  line-height: 1.6;
  overflow-x: auto;
  white-space: pre;
  tab-size: 2;
}
</style>