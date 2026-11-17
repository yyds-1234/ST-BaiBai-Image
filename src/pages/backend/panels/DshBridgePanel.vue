<script setup lang="ts">
import { DSH_WORLDBOOK_ENTRY, DSH_WORLDBOOK_TITLE, dshWorldbookOf } from '@/autoTag/dshPlaceholder';
import {
  DSH_PROTOCOL_VERSION,
  detectDshCast,
  getDshIdentity,
  listDshIdentities,
  saveDshIdentity,
  probeDshBridge,
  searchDshCatalog,
  type DshCastDetectResult,
  type DshCatalogEntry,
  type DshHealth,
  type DshIdentitySummary,
} from '@/backends/dshBridge';
import BbiCombo from '@/components/BbiCombo.vue';
import BbiSelect from '@/components/BbiSelect.vue';
import Collapsible from '@/components/Collapsible.vue';
import Icon from '@/components/Icon.vue';
import { copyText } from '@/st/clipboard';
import { dshMappingLabel, dshMappingValue, parseDshMappingValue } from '@/state/dshCharMap';
import { effectiveDshBridge, settings } from '@/state/settings';
import { computed, ref, watch } from 'vue';

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

// ── 世界书条目正文(可编辑)─────────────────────────────────────────────────
//
// 存进设置的是**自定义正文**(空串 = 用内置),而这里编辑的是草稿:让 textarea 直接
// v-model 到设置,用户一清空就会立刻跳回内置文本,想整段重打都做不到。改完点「保存」才写回。
//
// 为什么这段文本归用户:它是主模型每轮拼进提示词的一段话,口径要能按卡调;而 ST 没有
// 对外暴露写世界书的接口,插件只能「存一份 + 让人复制」——所以这份源文本必须是可改的。
const worldbookDraft = ref(dshWorldbookOf(settings.dshBridge.worldbookEntry));
/** 用户动过草稿之后,不再让外部回灌覆盖它(设置是异步 hydrate 的)。 */
const worldbookTouched = ref(false);

watch(
  () => settings.dshBridge.worldbookEntry,
  value => {
    if (worldbookTouched.value) return;
    worldbookDraft.value = dshWorldbookOf(value);
  },
  { immediate: true },
);

/** 草稿与「真正生效的那份」不一致 = 有未保存的改动。 */
const worldbookDirty = computed(
  () => worldbookDraft.value.trim() !== dshWorldbookOf(settings.dshBridge.worldbookEntry).trim(),
);
/** 存档里有没有自定义正文(空串 = 内置)。 */
const worldbookCustom = computed(() => settings.dshBridge.worldbookEntry.trim().length > 0);

/** 输入即视为「用户动过」:此后外部回灌不再覆盖草稿(否则一存盘/一刷新就把人打了一半的字冲掉)。 */
function touchWorldbook(): void {
  worldbookTouched.value = true;
}

/** 保存:与内置逐字相同就存空串(= 回到内置),免得存档里多一份不会跟着升级走的副本。 */
function saveWorldbook(): void {
  const text = worldbookDraft.value;
  settings.dshBridge.worldbookEntry = text.trim() === DSH_WORLDBOOK_ENTRY.trim() ? '' : text;
  worldbookTouched.value = false;
  toastr.success('世界书正文已保存;要让它生效,重新「复制世界书条目」粘进 ST 的那条条目', '柏宝绘');
}

/** 恢复内置:清空自定义,草稿同步回内置正文。 */
function resetWorldbook(): void {
  settings.dshBridge.worldbookEntry = '';
  worldbookDraft.value = DSH_WORLDBOOK_ENTRY;
  worldbookTouched.value = false;
  toastr.info('已回到内置正文;复制一次粘到世界书条目里才会生效', '柏宝绘');
}

async function copyWorldBook(): Promise<void> {
  // 复制的是**框里这段**:用户可能刚改完还没保存,复制旧的那份等于白改。
  const text = worldbookDraft.value.trim() || DSH_WORLDBOOK_ENTRY;
  await copyText(text, `「${DSH_WORLDBOOK_TITLE}」已复制，粘到世界书条目的内容里`);
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

// ── 档案映射 ───────────────────────────────────────────────────────────────
//
// 面板只负责「挑」:把 DSH 那侧的档案清单（GET /identities）和动漫表检索结果
// （GET /catalog）拉进来当候选,存成 settings.dshBridge.charMappings。
// **怎么用**在 state/dshCharMap 里（纯函数），这里一行判定都不写 —— 面板与出图
// 各有一套判定时，「面板里选好了、出图却不生效」会变成查不出来的问题。

/** 这次拉回来的档案清单。空 = 还没拉过（面板照样能显示已存的映射）。 */
const identities = ref<DshIdentitySummary[]>([]);
/** 这次搜出来的动漫角色（带它所属的线，映射时要存进去）。 */
const catalogHits = ref<{ entry: DshCatalogEntry; line: string }[]>([]);
const catalogQuery = ref('');
const mappingBusy = ref(false);
const identityNote = ref('');
const catalogNote = ref('');

/** 当前要走的配置集：与出图同一个口径（留空已收口成 moss-real）。 */
const currentLine = computed(() => effectiveDshBridge().configSet);

/**
 * 这次拉回来的档案里，有几份能在这条线上用（同线 + line 留空的通用档）。
 *
 * 只在提示语里用：拉回 8 份、其中 6 份绑在别的线时，「拉到了 8 份」会让人以为都能选。
 * 选择器**不**按线过滤 —— 面板也是「把线切过去之前先配好」的地方，藏起来只会让人以为那份档案不存在。
 */
const usableOnLine = computed(
  () => identities.value.filter(item => !item.line || item.line === currentLine.value).length,
);

/**
 * 候选池：档案 + 动漫角色。
 *
 * 档案**不按当前线过滤** —— 面板也是「把这条线切过去之前先配好」的地方，
 * 藏起来只会让人以为那份档案不存在；grep 不到时的那句提醒在出图前给（见 Card 的跳线提醒）。
 */
const mappingPool = computed(() => {
  const out: { value: string; label: string; line: string }[] = [];
  for (const item of identities.value) {
    const line = item.line;
    out.push({
      value: dshMappingValue({ kind: 'archive', ref: item.charId }),
      label: dshMappingLabel({ kind: 'archive', ref: item.charId, line }) + (item.blockChars > 0 ? '' : ' · 无形象块'),
      line,
    });
  }
  for (const hit of catalogHits.value) {
    out.push({
      value: dshMappingValue({ kind: 'catalog', ref: hit.entry.name }),
      label: dshMappingLabel({ kind: 'catalog', ref: hit.entry.name, line: hit.line }),
      line: hit.line,
    });
  }
  return out;
});

/**
 * 下拉候选。
 *
 * 除了候选池，还要补两类「池子里没有但必须能显示」的值：
 *   1. 已存进设置、这次没拉到的（换了机器 / 还没点刷新）—— 否则面板看起来像把配置弄丢了；
 *   2. 空值（未选择）—— 加了新行还没挑目标时就是这个状态。
 */
const mappingOptions = computed(() => {
  const options = [{ value: '', label: '未选择' }];
  const seen = new Set<string>(['']);
  const push = (value: string, label: string) => {
    if (seen.has(value)) return;
    seen.add(value);
    options.push({ value, label });
  };
  for (const item of mappingPool.value) push(item.value, item.label);
  for (const row of settings.dshBridge.charMappings) {
    if (!row.name || !row.ref) continue;
    push(dshMappingValue(row), dshMappingLabel(row));
  }
  return options;
});

function addMapping(): void {
  settings.dshBridge.charMappings.push({ name: '', kind: 'archive', ref: '', line: '' });
}

function removeMapping(index: number): void {
  settings.dshBridge.charMappings.splice(index, 1);
}

/**
 * 一行别名（顿号 / 逗号分隔，两种 kind 通用）。
 *
 * 为什么不再让人「多加几行指向同一条 ref」：动漫角色没有档案，以前只能那样表达
 * 「甘雨 / Ganyu 是同一个人」，几条一模一样的行既难维护、删的时候还容易漏。
 * 现在一行带住：主名决定发出去的「显示名」，别名只参与占位匹配。
 * 用 change（失焦 / 回车）提交，不是 input —— 边打边拆数组会把光标和顿号一起改写。
 */
function onEditAliases(index: number, event: Event): void {
  const row = settings.dshBridge.charMappings[index];
  if (!row) return;
  const value = (event.target as HTMLInputElement).value;
  const aliases = value
    .split(/[,，;；、\n]/)
    .map(item => item.trim())
    .filter(Boolean);
  if (aliases.length > 0) row.aliases = aliases;
  else delete row.aliases;
}

// ── 编辑档案（桥接 2.28.1）───────────────────────────────────────────────
//
// 自动建出来的档案（auto: true）以前只能在 DSH 配置台里改。柏宝绘这边看得见映射、
// 也在同一个页面上，所以把「改名 / 加别名 / 改块」搬到这儿来 —— 三件事正是自动建档之后
// 最常要修的：起草的英文名可能拼错、中文名要留成别名、起草的块可能不合意。
//
// 与映射行分开：改档案**不动**映射行（映射的 name 是占位里的写法，是匹配用的键；
// 改了它这一单就再也匹配不上）。档案 id 也不改（引用它的是映射表）。
const identityEditor = ref<{
  charId: string;
  name: string;
  aliases: string;
  block: string;
  /** 绑哪条配置集;空串 = 通用档（哪条线都能用）。 */
  line: string;
  auto: boolean;
  loading: boolean;
  saving: boolean;
  error: string;
} | null>(null);

/** 打开编辑器：先 GET /identity 把全文拉回来（摘要里没有 char_block，改块必须有原文）。 */
async function openIdentityEditor(charId: string): Promise<void> {
  const id = String(charId ?? '').trim();
  if (!id) return;
  identityEditor.value = { charId: id, name: '', aliases: '', block: '', line: '', auto: false, loading: true, saving: false, error: '' };
  try {
    const full = await getDshIdentity(effectiveDshBridge(), id);
    identityEditor.value = {
      charId: full.charId,
      name: full.name,
      // 别名用顿号 / 逗号都能分开：中英文输入法混着来是常事。
      aliases: full.aliases.join('、'),
      block: full.block,
      line: full.line,
      auto: full.auto,
      loading: false,
      saving: false,
      error: '',
    };
  } catch (error) {
    if (identityEditor.value) {
      identityEditor.value.loading = false;
      identityEditor.value.error = errorMessage(error);
    }
  }
}

function closeIdentityEditor(): void {
  identityEditor.value = null;
}

/** 保存：名字 / 别名 / 形象块一次写回（别名是**整体替换**，清空输入框 = 清空别名）。 */
async function saveIdentityEditor(): Promise<void> {
  const editor = identityEditor.value;
  if (!editor || editor.saving || editor.loading) return;
  editor.saving = true;
  editor.error = '';
  try {
    const aliases = editor.aliases
      .split(/[,，;；、\n]/)
      .map(item => item.trim())
      .filter(Boolean);
    const result = await saveDshIdentity(effectiveDshBridge(), {
      charId: editor.charId,
      name: editor.name,
      aliases,
      charBlock: editor.block,
      // 空串 = 通用档：绑错线是最常遇到的坑，这里给一条「改成通用」的路。
      line: editor.line,
    });
    identityNote.value = `已保存档案 ${result.charId}：显示名「${result.name}」，别名 ${result.aliases.length} 个`;
    identityEditor.value = null;
    await refreshIdentities();
  } catch (error) {
    editor.error = errorMessage(error);
    editor.saving = false;
  }
}

/**
 * 下拉选中 → 写回这一行。
 *
 * 线的来源:候选项自己带来的（档案绑的线 / 动漫表属于哪条线）优先；
 * 池子里找不到（老值）时保留原来存的线，别把一条有效映射改成「无主」。
 */
function onPickMapping(index: number, value: string): void {
  const row = settings.dshBridge.charMappings[index];
  if (!row) return;
  const picked = parseDshMappingValue(value);
  if (!picked) {
    row.ref = '';
    return;
  }
  row.kind = picked.kind;
  row.ref = picked.ref;
  const hit = mappingPool.value.find(item => item.value === value);
  // 池子里没有这一项（换过机器 / 没点刷新 / 旧值回显）：动漫角色的线就按当前线存，
  // 别留成空串 —— 空串在面板上看起来像「没配」，而且旧版本的判定会把它当「线不符」直接丢掉。
  if (hit) row.line = hit.line;
  else if (picked.kind === 'catalog') row.line = currentLine.value;
}

/** 拉档案清单；顺手把已存映射的线对齐到档案当前的线（档案被挪过线时免得留一条过期的线）。 */
async function refreshIdentities(): Promise<void> {
  if (mappingBusy.value) return;
  mappingBusy.value = true;
  identityNote.value = '';
  try {
    identities.value = await listDshIdentities(effectiveDshBridge());
    for (const row of settings.dshBridge.charMappings) {
      if (row.kind !== 'archive' || !row.ref) continue;
      const hit = identities.value.find(item => item.charId === row.ref);
      if (hit) row.line = hit.line;
    }
    identityNote.value = identities.value.length
      ? `拉到 ${identities.value.length} 份档案（其中 ${usableOnLine.value} 份能在这条线（${currentLine.value}）上用）`
      : 'DSH 侧一份档案都没有：identities/ 目录是空的';
  } catch (error) {
    identityNote.value = errorMessage(error);
  } finally {
    mappingBusy.value = false;
  }
}

/** 搜动漫表。只有配了 catalogFile 的线有结果，别的线服务端会回 400 并说明原因。 */
async function searchCatalog(): Promise<void> {
  const q = catalogQuery.value.trim();
  if (!q || mappingBusy.value) return;
  mappingBusy.value = true;
  catalogNote.value = '';
  try {
    const result = await searchDshCatalog(effectiveDshBridge(), { line: currentLine.value, q, limit: 20 });
    catalogHits.value = result.entries.map(entry => ({ entry, line: result.line || currentLine.value }));
    catalogNote.value = result.total > result.entries.length
      ? `「${result.line || currentLine.value}」的表里命中 ${result.total} 条，只列前 ${result.entries.length} 条（换个更具体的关键词）`
      : `「${result.line || currentLine.value}」的表里命中 ${result.total} 条`;
  } catch (error) {
    catalogNote.value = errorMessage(error);
  } finally {
    mappingBusy.value = false;
  }
}
// ── 自动认角色（桥接 2.14.0）────────────────────────────────────────────────
//
// 平时这一步藏在 `/generate` 里（DSH 出图前自己认），要等一整张图才知道它认成了谁。
// 面板里给一个「试跑」入口：调 `POST /cast/detect`（**不出图**），当场看清机械层认到谁、
// 模型层又补了谁；认错了可以立刻改映射，或者把开关关掉 —— 不必先浪费一张图。

/** 试跑用的正文（用户从占位里复制一段贴进来）。 */
const castProbe = ref('');
const castBusy = ref(false);
const castResult = ref<DshCastDetectResult | null>(null);
const castError = ref('');

async function probeCast(): Promise<void> {
  const scene = castProbe.value.trim();
  if (scene.length === 0 || castBusy.value) return;
  castBusy.value = true;
  castError.value = '';
  castResult.value = null;
  try {
    // 配置集与出图同一个口径（effectiveDshBridge 已把留空收口成 moss-real）：
    // 试跑看到的线必须就是出图那条线，否则「试跑认到了、出图没有」根本无从解释。
    const conn = effectiveDshBridge();
    castResult.value = await detectDshCast(conn, {
      scene,
      configSet: conn.configSet,
      autoCast: settings.dshBridge.autoCast,
    });
  } catch (error) {
    castError.value = errorMessage(error);
  } finally {
    castBusy.value = false;
  }
}

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
            配置集决定成品串的写法与底模；<b>留空 = moss 真人线（moss-real）</b>，
            与阅读器随请求发的是同一个字段。点一次「测试连接」可拉回 DSH 侧已有的清单。
            想映射动漫角色，得选一条<b>查动漫表</b>的线（如 moss-anime）。
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
          <p class="bbi-field-hint">
            查动漫表（能映射动漫角色）的线：{{ health.catalogLines.length ? health.catalogLines.join('、') : '没有（这些线只能映射档案）' }}
          </p>
        </div>
      </Collapsible>

      <Collapsible title="档案映射（可选）" :open="false">
        <p class="bbi-field-hint">
          占位「人物名称：」里写的名字，可以指到 DSH 那侧的角色来源：<b>档案</b>（identities/*.md，
          带形象块、能挂 LoRA、有线门禁）或<b>动漫角色</b>（只有查动漫表的线才有，如 moss-anime）。
          没映射的人照旧用柏宝绘角色库的外貌块 —— 两路可以同时用。
        </p>
        <p class="bbi-field-hint">
          「名字」必须与占位里写的<b>一字不差</b>；映射只在名字出现在这一条的占位里时才发出去。
          档案绑在哪条线就只在哪条线生效（跨线会让整单被 DSH 拦下，所以出图前会先按线滤掉并提醒）。
        </p>

        <div class="conn-actions">
          <button class="bbi-btn" type="button" :disabled="mappingBusy" @click="refreshIdentities">
            <Icon name="refresh" />
            {{ mappingBusy ? '读取中…' : '拉取档案清单' }}
          </button>
          <button class="bbi-btn" type="button" @click="addMapping">添加一行</button>
        </div>
        <p v-if="identityNote" class="bbi-field-hint">{{ identityNote }}</p>
        <p v-else class="bbi-field-hint">
          档案在 DSH 那台机器上，柏宝绘读不到，只能问它要清单；这个按钮只读，不改 DSH 任何东西。
        </p>

        <div class="bbi-field">
          <div class="bbi-field-head">
            <span class="bbi-field-label">搜动漫角色</span>
          </div>
          <div class="dsh-map-search">
            <input
              class="bbi-input"
              type="text"
              v-model="catalogQuery"
              placeholder="关键词，如 hu tao / 胡桃"
              spellcheck="false"
              @keyup.enter="searchCatalog"
            />
            <button
              class="bbi-btn"
              type="button"
              :disabled="mappingBusy || !catalogQuery.trim()"
              @click="searchCatalog"
            >
              搜索
            </button>
          </div>
          <p class="bbi-field-hint">
            {{ catalogNote || '搜到的角色名会出现在下面每一行的下拉里；当前线不查动漫表时 DSH 会说清原因。' }}
          </p>
        </div>

        <div v-if="settings.dshBridge.charMappings.length" class="dsh-map-list">
          <div v-for="(row, index) in settings.dshBridge.charMappings" :key="index" class="dsh-map-row">
            <div class="dsh-map-name">
              <input
                class="bbi-input"
                type="text"
                v-model="row.name"
                placeholder="占位里的名字"
                spellcheck="false"
                :aria-label="`第 ${index + 1} 行的名字`"
              />
              <span
                v-if="row.auto"
                class="dsh-map-auto"
                title="DSH 自动认角色建的映射；下次同名直接查表。删掉它就会重新进入自动识别。"
              >
                自动
              </span>
            </div>
            <BbiSelect
              :model-value="row.ref ? dshMappingValue(row) : ''"
              :options="mappingOptions"
              :aria-label="`第 ${index + 1} 行映射到`"
              @update:model-value="onPickMapping(index, $event)"
            />
            <input
              class="bbi-input dsh-map-aliases"
              type="text"
              :value="(row.aliases ?? []).join('、')"
              placeholder="别名（顿号分隔）"
              spellcheck="false"
              :aria-label="`第 ${index + 1} 行的别名`"
              @change="onEditAliases(index, $event)"
            />
            <button
              v-if="row.kind === 'archive' && row.ref"
              class="bbi-btn dsh-map-edit"
              type="button"
              :aria-label="`编辑档案 ${row.ref}`"
              title="改档案本身：显示名 / 别名 / 形象块（自动建档起草的就是这里的内容）"
              @click="openIdentityEditor(row.ref)"
            >
              编辑
            </button>
            <button
              class="bbi-btn dsh-map-del"
              type="button"
              :aria-label="`删除映射 ${row.name || '这一行'}`"
              @click="removeMapping(index)"
            >
              <Icon name="trash" :size="13" />
            </button>
          </div>
        </div>
        <p v-else class="bbi-field-hint">还没有映射行：先「拉取档案清单」，再「添加一行」。</p>
        <p v-if="settings.dshBridge.charMappings.length" class="bbi-field-hint">
          每行的「别名」是<b>占位里还可能怎么写这个人</b>（顿号分隔，如 <code class="mono">甘雨、Ganyu</code>）。
          动漫角色与原创角色都适用：发出去的显示名永远是主名，别名只用来认出他。
        </p>

        <div v-if="identityEditor" class="dsh-map-editor">
          <div class="dsh-map-editor-head">
            <b>编辑档案</b>
            <code class="mono">{{ identityEditor.charId }}</code>
            <span v-if="identityEditor.auto" class="dsh-map-auto">自动建档</span>
            <button class="bbi-btn dsh-map-editor-close" type="button" @click="closeIdentityEditor">关闭</button>
          </div>
          <p v-if="identityEditor.loading" class="bbi-field-hint">正在读取档案全文…</p>
          <template v-else>
            <label class="dsh-map-editor-field">
              <span>显示名</span>
              <input
                class="bbi-input"
                type="text"
                v-model="identityEditor.name"
                spellcheck="false"
                placeholder="可以改成英文名，如 Yanqing"
              />
            </label>
            <label class="dsh-map-editor-field">
              <span>别名</span>
              <input
                class="bbi-input"
                type="text"
                v-model="identityEditor.aliases"
                spellcheck="false"
                placeholder="顿号 / 逗号分隔，如：砚青、Yanqing"
              />
            </label>
            <label class="dsh-map-editor-field">
              <span>绑线</span>
              <BbiSelect
                :model-value="identityEditor.line"
                :options="[{ value: '', label: '通用（哪条线都能用）' }, ...configSetOptions.map(item => ({ value: item, label: item }))]"
                aria-label="这份档案绑哪条配置集"
                @update:model-value="identityEditor.line = $event"
              />
            </label>
            <label class="dsh-map-editor-field is-block">
              <span>形象块</span>
              <textarea
                class="bbi-input dsh-map-editor-block"
                v-model="identityEditor.block"
                spellcheck="false"
                rows="4"
              ></textarea>
            </label>
            <p class="bbi-field-hint">
              保存会写回 <code class="mono">identities/{{ identityEditor.charId }}.md</code>，
              并<b>清掉「自动建档」标记</b>（改过就不再算机器写的）。
              别名是<b>整体替换</b>：清空输入框 = 清空别名。档案 id 与映射行都不动 —— 引用它的还是这一行。
            </p>
            <p v-if="identityEditor.error" class="dsh-map-editor-error">{{ identityEditor.error }}</p>
            <div class="dsh-map-editor-actions">
              <button class="bbi-btn" type="button" :disabled="identityEditor.saving" @click="closeIdentityEditor">取消</button>
              <button class="bbi-btn is-primary" type="button" :disabled="identityEditor.saving" @click="saveIdentityEditor">
                {{ identityEditor.saving ? '保存中…' : '保存' }}
              </button>
            </div>
          </template>
        </div>
      </Collapsible>

      <Collapsible title="自动认角色" :open="false">
        <p class="bbi-field-hint">
          每一单，<b>没给英文对照</b>的人（占位里叫得出名字、但你没配映射、角色库里也没有块）都会被认一遍——已给英文对照的人不重复认（逐人补认），
          要不要让 DSH 自己从占位正文里认人：
          <b>档案名 / 别名</b>（如「瑶瑶」→ 26-小静）与<b>动漫角色</b>（只在查动漫表的线上，如 moss-anime）。
        </p>
        <p class="bbi-field-hint">
          动漫线那一路是「模型先报名字，再由动漫表核对」：名字必须在正文里<b>逐字出现</b>，
          罗马字必须在表里<b>查得到</b>，两关都过才注入 —— 认不出来就什么都不加，不会瞎猜一个人。
          关掉之后，没配过的人只有「模型随机长相」这一种结果。
        </p>

        <label class="dsh-auto-row">
          <input v-model="settings.dshBridge.autoCast" type="checkbox" class="bbi-checkbox" />
          <span>开：没映射的人也交给 DSH 认（推荐）</span>
        </label>
        <label class="dsh-auto-row">
          <input
            v-model="settings.dshBridge.autoMap"
            type="checkbox"
            class="bbi-checkbox"
          />
          <span>自动写进上面的档案映射：点过名的人 + 认出来的动漫角色</span>
        </label>
        <p class="bbi-field-hint">
          <b>DSH 新建的档案</b>（查表查不到、DSH 按正文起草了一份，如 <code>涛 → 34-涛</code>）：
          不写进映射表的话，这边永远看不到这份档案。
          同一种行也覆盖<b>你点过名、但档案是上一单就建好的</b>人 —— 那种单子回包只是一条
          「既有档案命中」，不把点名的名字算进去，那行就永远补不上。
          <b>认出来的动漫角色</b>（<code>胡桃 → hu tao (genshin impact)</code>）：下一单开头就把它们当
          <code>characters</code> 发过去，DSH 走的是<b>正常的机械查表</b>（精确命中表里那一条），
          不再为同一个名字跑一趟识别模型，也不会这次认成 A、下次认成 B。
          自动建的行绑的是本单生效的那条线（新建档案没带线时按通用档存）。
          DSH 纯从正文认出来、你<b>没点名</b>的既有档案不建（那由你在上面显式配）；
          你手挑的行不会被覆盖，自动行随时可以删。
        </p>

        <div class="bbi-field">
          <div class="bbi-field-head">
            <span class="bbi-field-label">试跑（不出图）</span>
          </div>
          <textarea
            v-model="castProbe"
            class="bbi-input dsh-auto-input"
            rows="3"
            spellcheck="false"
            placeholder="贴一段占位正文，看 DSH 会认成谁。例如：人物名称：胡桃 / 人物服装：黑色长外套 / 场景描述：雨夜的屋檐下，她回头笑"
          />
          <div class="conn-actions">
            <button
              class="bbi-btn"
              type="button"
              :disabled="castBusy || !castProbe.trim()"
              @click="probeCast"
            >
              <Icon name="plug" />
              {{ castBusy ? '识别中…' : '试跑自动认角色' }}
            </button>
          </div>
          <p v-if="castError" class="bbi-field-hint dsh-auto-err">{{ castError }}</p>
          <div v-else-if="castResult" class="dsh-auto-result">
            <p class="bbi-field-hint">
              线 {{ castResult.line }} · 档位 {{ castResult.mode }} · 来源 {{ castResult.source }}
              · {{ castResult.catalog ? '这条线查动漫表' : '这条线只认档案' }}
            </p>
            <p v-if="castResult.picks.length" class="bbi-field-hint">
              认出来的人：
              <b>{{ castResult.picks.map(item => `${item.label} → ${item.ref}`).join('、') }}</b>
            </p>
            <p v-else-if="castResult.characters.length" class="bbi-field-hint">
              认出来的人：<b>{{ castResult.characters.join('、') }}</b>
            </p>
            <p v-else class="bbi-field-hint">
              没认出来：正文里没有档案名 / 别名，动漫表也没对上（这时出图照常，长相由写手从正文里写）。
            </p>
            <ul v-if="castResult.notes.length" class="dsh-auto-notes">
              <li v-for="(note, index) in castResult.notes" :key="index">{{ note }}</li>
            </ul>
          </div>
        </div>
      </Collapsible>

      <Collapsible title="写入方式（占位）" :open="false">
        <p class="bbi-field-hint">
          这条渠道不靠柏宝绘自动生成 tag。主模型在写正文时按下面的格式在回复末尾追加一个占位，
          卡片上的「交给 DSH 出图」会把它送去 DSH：
        </p>
        <pre class="bbi-dsh-sample">&lt;bbi_image&gt;&lt;dsh&gt;人物名称：林夏
人物服装：米色长风衣，右手收着黑伞
场景描述：傍晚的天台，她侧身回头，逆光把发梢照透&lt;/dsh&gt;&lt;size&gt;portrait&lt;/size&gt;&lt;/bbi_image&gt;</pre>
        <p class="bbi-field-hint">
          三行（人物名称 / 人物服装 / 场景描述）按协议顺序拼在一起，原样进桥接的
          <code>scene</code> 字段；场景描述一句话就够，旧的一段散文占位也照读照送。
        </p>
        <p class="bbi-field-hint">
          <b>剧情传递</b>：出图时除这三行，还会把<b>上一个占位到这一条之间</b>的正文（≤500 字，
          超了砍头留尾、开头加「（前略）」）一起交给 DSH。写手只把它当前因读：<b>不写进画面串</b>、
          不参与认角色与画幅判定 —— 目的是让「她为什么在这儿」有依据，而不是往画面里加东西。
        </p>
        <p class="bbi-field-hint">
          占位在显示与提示词两条路径上都会被替换掉，永不进 DOM、永不进提示词。
          带 &lt;dsh&gt; 的卡片走这条渠道；没有 &lt;dsh&gt; 的老 tag 仍按原来的 tag 流出图，
          两种格式可以在同一个聊天里共存。
        </p>
      </Collapsible>

      <Collapsible title="世界书条目" :open="false">
        <p class="bbi-field-hint">
          下面是<b>主协议</b>，也就是这一段：新建一条世界书条目（建议标题：{{ DSH_WORLDBOOK_TITLE }}），
          触发方式选<b>常驻</b>（蓝灯），把正文粘进去。主模型每轮都会看到它，才会按格式写占位。
        </p>
        <p class="bbi-field-hint">
          <b>这段正文可以直接改</b>：改完点「保存」，再点「复制世界书条目」粘进 ST 的那条条目里
          （插件不会替你改世界书）。它决定主模型怎么写占位；插件侧的解析口径不变 ——
          三行标签、<code>&lt;bbi_image&gt;</code> / <code>&lt;size&gt;</code> 外壳仍按协议读，
          写成别的形状只会解析不出来。「设置 → 自定义提示词 → DSH 委托单规范」的内置默认
          也跟这份走，手动补写时用的是同一套口径。
        </p>
        <p class="bbi-field-hint">
          想一次导全，用仓库里的 <code>docs/worldbook/01-柏宝绘-DSH画面占位.json</code>：
          除了主协议，还带「镜头与画幅」「亲密与露骨镜头」两条关键词触发的补充（用户聊到才注入，不占常驻预算），
          以及一条默认禁用的卡内精简版。
        </p>
        <p class="bbi-field-hint">
          <b>没占位的楼可以手动补</b>：点该楼 ⋯ 里的调色盘按钮，柏宝绘会拿<b>同一份协议</b>（这份世界书
          文本）让模型按这一楼正文补写一条占位。那条请求的规范可在「设置 → 自定义提示词 →
          DSH 委托单规范」里改，前面拼的破限词也在同一页。
        </p>
        <p class="bbi-field-hint">
          <b>柏宝绘不会自动写入世界书</b>：ST 没有对外暴露写条目的一类接口，硬写只能摸未公开的内部函数，
          ST 一升级就断，还会在用户书单里留下他没同意过的条目。
        </p>
        <div class="bbi-field">
          <div class="bbi-field-head">
            <span class="bbi-field-label">条目正文</span>
            <span v-if="worldbookDirty" class="dsh-wb-badge is-dirty">未保存</span>
            <span v-else-if="worldbookCustom" class="dsh-wb-badge is-custom">已自定义</span>
            <span v-else class="dsh-wb-badge is-builtin">内置默认</span>
          </div>
          <textarea
            v-model="worldbookDraft"
            class="bbi-input dsh-wb-text"
            rows="14"
            spellcheck="false"
            aria-label="世界书条目正文"
            @input="touchWorldbook"
          ></textarea>
          <p class="bbi-field-hint">
            草稿 {{ worldbookDraft.trim().length }} 字 · 内置 {{ DSH_WORLDBOOK_ENTRY.length }} 字。
            世界书每轮都进提示词，改长会挤占预算；弱约束条目越长，模型越会挑着执行。
          </p>
          <div class="conn-actions">
            <button class="bbi-btn" type="button" @click="copyWorldBook">
              <Icon name="copy" />
              复制世界书条目
            </button>
            <button class="bbi-btn" type="button" :disabled="!worldbookDirty" @click="saveWorldbook">
              保存
            </button>
            <button class="bbi-btn" type="button" @click="resetWorldbook">
              恢复内置
            </button>
          </div>
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

/* 世界书正文编辑器:等宽 + 可纵向拉伸。这份文本是逐字粘进世界书的,等宽才好比对换行。 */
.dsh-wb-text {
  width: 100%;
  min-height: 220px;
  resize: vertical;
  font-family: var(--bbi-font-mono, monospace);
  font-size: 12px;
  line-height: 1.65;
  white-space: pre-wrap;
}

/* 状态角标:未保存 / 已自定义 / 内置默认 —— 只有「未保存」值得用颜色提醒。 */
.dsh-wb-badge {
  margin-left: 8px;
  padding: 1px 6px;
  border-radius: 6px;
  font-size: 10.5px;
  line-height: 1.4;
  color: var(--dsw-alias-label-secondary);
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-l2);
}
.dsh-wb-badge.is-dirty {
  color: var(--dsw-alias-warning, #b8860b);
  border-color: currentColor;
}

/* 映射行：名字 / 目标 / 删除。名字窄、目标宽（档案 id + 线要放得下），删除键定宽。
   minmax(0, …) 是关键：grid 子项默认 min-width:auto，输入框会被内容撑破列宽。 */
.dsh-map-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 8px;
}
.dsh-map-row {
  display: grid;
  /* 名字 / 目标 / 别名 / 编辑（仅档案行有）/ 删除 */
  grid-template-columns: minmax(0, 0.85fr) minmax(0, 1.25fr) minmax(0, 0.85fr) auto 32px;
  gap: 8px;
  align-items: center;
}
.dsh-map-row > * {
  min-width: 0;
}
/* 名字格 + 「自动」角标：角标是 DSH 自动建档留下的痕迹（用户手挑的行不会有它）。 */
.dsh-map-name {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.dsh-map-name .bbi-input {
  flex: 1 1 auto;
  min-width: 0;
}
.dsh-map-auto {
  flex: none;
  font-size: 10.5px;
  line-height: 1.4;
  padding: 1px 6px;
  border-radius: 6px;
  color: var(--dsw-alias-label-secondary);
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-l2);
}
.dsh-map-del {
  padding: 0;
  height: 30px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
/* 「编辑」按钮：档案行才有（动漫角色没有档案可改，名字就是表里那条）。 */
.dsh-map-edit {
  height: 30px;
  padding: 0 10px;
  font-size: 12px;
  white-space: nowrap;
}

/* 档案编辑器：列表下方展开，不起浮层（面板里还有下拉在弹，浮层会打架）。 */
.dsh-map-editor {
  margin-top: 10px;
  padding: 12px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-l2);
}
.dsh-map-editor-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.dsh-map-editor-close {
  margin-left: auto;
  height: 26px;
  padding: 0 10px;
  font-size: 12px;
}
.dsh-map-editor-field {
  display: grid;
  grid-template-columns: 56px minmax(0, 1fr);
  gap: 8px;
  align-items: center;
  margin: 6px 0;
  font-size: 12.5px;
}
.dsh-map-editor-field.is-block {
  align-items: start;
}
.dsh-map-editor-block {
  min-height: 72px;
  resize: vertical;
  font-family: var(--bbi-font-mono, monospace);
  font-size: 12px;
  line-height: 1.5;
}
.dsh-map-editor-error {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--dsw-alias-danger, #d9534f);
}
.dsh-map-editor-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}

.dsh-map-search {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
  align-items: center;
}
.dsh-map-search > * {
  min-width: 0;
}

/* 自动认角色的开关行：复选框 + 一句人话。用 label 包住，点字也能勾上。 */
.dsh-auto-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 8px 0;
  font-size: 12.5px;
  line-height: 1.5;
  cursor: pointer;
}
.dsh-auto-input {
  width: 100%;
  resize: vertical;
  margin-bottom: 8px;
}
.dsh-auto-err {
  color: var(--bbi-danger, #d9534f);
}
/* 试跑结果：notes 是逐条说明（认成谁、哪条因为歧义跳过），用小字号列表读着最省地方。 */
.dsh-auto-notes {
  margin: 4px 0 0;
  padding-left: 18px;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--bbi-label-secondary, rgba(127, 127, 127, 0.95));
}
</style>

