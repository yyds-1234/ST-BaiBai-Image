/**
 * 「一次出图」的共用中段 —— 楼层卡片与公开接口的唯一生成入口。
 *
 * 原本这段活全写在 Card.vue 的 generate() 里,与槽位运行态(beginGen/failGen)、
 * 落盘(saveImageResult)、重水合(hydrateMessage)缠在一起。公开接口要让第三方
 * 「自己决定图显示在哪」,要的恰恰是**掐头去尾的中段**:
 *
 *   前(调用方):登记运行态 / 校验参数
 *   ★ 中(本模块):NAI 闸门 → 按 backend 分派 → 拿到图
 *   后(调用方):落盘、显示、收尾埋点
 *
 * **闸门不可绕过**,这是本模块存在的首要理由:直接调 backends/nai.ts 的
 * generateNaiImage 会跑在 floor/genQueue.ts 的并发闸门与全局节奏之外,0.2.0 整版的
 * NAI 限流自愈(429 全局冷却、相邻请求最小间隔、退避重试)当场失效。第三方并发调用
 * 是常态,绕过去的症状是用户 NAI 账号吃一串密集 429 —— 而用户只会认为柏宝绘坏了。
 * 故公开接口与卡片共用本函数,闸门在这里包死。
 *
 * 本模块**刻意不碰**:楼层坐标、genState、extra、水合、请求历史埋点。
 * 埋点留给调用方是有意为之:一条历史记录的「成功」判据各家不同——楼层卡片要等
 * saveImageResult 落盘成功才算成,还要把「图拿到了却因任务被取代而丢弃」记成已取消;
 * 本模块只知道请求本身的成败,替调用方下结论会把那两种情形谎报成成功。
 * 故 decideSeed 单独导出:调用方先定种子(埋点需要它)、再把它显式传进来。
 */

import type { ImageCharacterPrompt } from '@/autoTag/protocol';
import { comfySimpleParams, validateSimpleConfig } from '@/backends/comfyTemplates';
import { generateDshImage } from '@/backends/dshBridge';
import { generateComfyImage, previewComfyPrompt, randomSeed, type ComfyImageResult } from '@/backends/comfyui';
import {
  fullNegativePrompt,
  fullPositivePrompt,
  generateNaiImage,
  naiRandomSeed,
  naiSupportsCharacterPrompts,
} from '@/backends/nai';
import { effectiveOrientation, parseSize, pickSize, type Orientation } from '@/backends/size';
import { acquireNaiSlot } from '@/floor/genQueue';
import type { GenerationMeta } from '@/generationMeta';
import { activeComfyPreset, activeNaiEndpoint, activeOrientationLock, effectiveComfyConn, effectiveDshBridge, effectiveNai, settings, type BackendId } from '@/state/settings';

/** 一次生成的输入。与协议层 ImageInsertion 同形,但不含正文位置信息。 */
export interface GenerateInput {
  /** 正向 danbooru 短 tag。 */
  prompt: string;
  /** 自然语言部分(可空)。 */
  nl?: string;
  /**
   * 角色中文外貌(插件从角色库机械拼接,不来自 AI;可空)。
   * ComfyUI 链路并进正向;NAI 忽略——那边没有中文原生的文本编码器。
   */
  appearance?: string;
  /** 本画面动态负面(可空)。ComfyUI 走 %negative_prompt%;NAI 的负面取渠道配置,不吃这个。 */
  negative?: string;
  /** NAI 4.5/V5 原生多角色提示;ComfyUI 不支持(见 charactersApplied)。 */
  characters?: ImageCharacterPrompt[];
  /**
   * 画幅方向;缺省竖屏。具体像素取渠道配置里的横竖尺寸。
   * 渠道锁定了方向(activeOrientationLock)时一律按锁定方向出,这里传什么都不算数。
   */
  size?: Orientation;
  /** 本次种子。由调用方经 decideSeed() 先行确定(埋点要在发请求前拿到它)。 */
  seed: number;
  /**
   * DSH 写手渠道的画面占位散文(<dsh> 子标签内容)。
   *
   * 有值且当前后端是 dshbridge 时,它与 prompt/nl 是**互斥**的两条路:占位模式下
   * prompt 往往是空串(主模型只写散文,没有 danbooru tag),故不能拿 prompt 当场景。
   * 后端不是 dshbridge 时本字段被忽略——一张带 <dsh> 的卡片切到 ComfyUI 渠道后,
   * 仍按 prompt/nl 老路径出图,不至于点了没反应。
   */
  dsh?: string;
  /** 占位里出现的角色名(DSH 侧按自己的档案解析;这里只是把线索带过去)。 */
  dshCharacters?: string[];
  /**
   * 纯诊断坐标 { chatId, messageId, slot }。只有 DSH 渠道会用到(它写进自己的 runs.jsonl)。
   *
   * 由调用方传而不是本模块自己取:本模块刻意不认识楼层坐标(见文件头),而卡片那边
   * 本来就有这三个值,顺手带上比在这里反向 import 一套 chat 上下文干净得多。
   */
  source?: Record<string, unknown>;
}

/** 生成过程中的进度上报(卡片用它显示排队位置与退避进度)。 */
/** 最终提交的提示词全文(合成后)。 */
export interface FinalPromptInfo {
  positive: string;
  negative: string;
}

export interface GenerateProgress {
  /** 已取得闸门槽位、请求即将发出(NAI 从「排队中」进入「生成中」的时机)。 */
  onStart?: () => void;
  /**
   * 拼装完成、请求即将发出时回报最终全文。**先于请求发出**,故即使请求失败/被拦,
   * 调用方也已拿到「它本来要发什么」——这正是排查最需要的那一刻。
   * 拼装是纯函数(composePositive / fullPositivePrompt),在调后端之前就能算出。
   */
  onPrompt?: (info: FinalPromptInfo) => void;
  /** ComfyUI 服务端队列里前面还有几个;null = 未知。 */
  onQueue?: (ahead: number | null) => void;
  /** NAI 限流退避进度;传 null 表示已不在退避中。 */
  onRetry?: (retry: { attempt: number; max: number } | null) => void;
}

export interface GenerateOutput {
  result: ComfyImageResult;
  /** 本次实际使用的种子(原样回传,调用方不必自己记)。 */
  seed: number;
  /** 本次实际出图的画幅方向(渠道锁定时即锁定方向,可能与入参 size 不同)。 */
  size: Orientation;
  backend: BackendId;
  /**
   * 最终实际提交给后端的那一条正向全文(合成后,含固定正面/画质词/中文外貌)。
   * meta.positive 有时拿不到(ComfyUI 自定义模式无法在这里拼出全文),这里同口径:
   * 拿不到时为空串。存在的理由是调用方要把它写进请求历史——分段原料(simpleValues)
   * 看不出拼接顺序、看不出哪段被丢弃,回看时没用。
   */
  finalPrompt: string;
  /** 最终实际提交的负面全文;口径同上。 */
  finalNegative: string;
  /**
   * characters 是否真的发给了后端。
   * ComfyUI 链路**不支持**多角色提示(comfyui.ts / comfyTemplates.ts 全程不读该字段),
   * 传了也是静默丢弃 —— 故显式回报,调用方据此决定要不要提示用户换后端。
   * 不在这里「降级拼进 prompt」:那正是 0.2.3 修掉的重叠躯干问题(一张图里多份完整外貌)。
   */
  charactersApplied: boolean;
  /**
   * 本次实际使用的画师串 / vibe / 采样参数 / 模型，供落盘随图记录（见 generationMeta.ts）。
   * NAI 的画师串与 vibe 不在 tag 文本里，不在这里冒泡出去就只能永久丢失。
   */
  meta: GenerationMeta;
}

/**
 * 回报最终全文。**绝不抛**:埋点失败了不能把生图搞挂(理由同 state/history 的 safeHistory)。
 * 空串不回报 —— 那表示「算不出来」,让调用方保留「未知」而不是收到一个假的空提示词。
 */
function reportPrompt(progress: GenerateProgress, positive: string, negative: string): void {
  if (!positive && !negative) return;
  try {
    progress.onPrompt?.({ positive, negative });
  } catch (error) {
    console.warn('[柏宝绘] 回报最终提示词失败(已忽略)', error);
  }
}

/** 后端就绪状态。 */
export interface BackendStatus {
  backend: BackendId;
  configured: boolean;
  /** NAI 为模型名;ComfyUI 为当前工作流预设名。 */
  model: string;
  /** 当前后端是否支持 characters(NAI 4.5/V5 为 true,ComfyUI 恒 false)。 */
  supportsCharacters: boolean;
  /** configured=false 时的人话原因;已就绪为空串。 */
  reason: string;
}

/**
 * 当前后端能不能出图。**唯一判据**,卡片(configured)与公开接口共用。
 *
 * ComfyUI 要按模式分别校验(custom 要工作流 JSON;simple 要模型/VAE/CLIP 选齐,
 * 与出图组装同一口径 validateSimpleConfig,避免「卡片能点、出图才报错」);NAI 要 url + key。
 */
export function backendStatus(): BackendStatus {
  const backend = settings.defaultBackend;

  if (backend === 'nai') {
    const model = settings.nai.model;
    // 支持与否只看模型,与配没配齐无关:第三方要在出图前就知道该不该传 characters
    const supportsCharacters = naiSupportsCharacterPrompts(model);
    const base = { backend, model, supportsCharacters };
    // 地址与 key 取**当前接入点**那一份(见 effectiveNai);渠道级 nai.url/nai.key 是存量字段。
    // reason 里刻意**不带接入点名字**:它会经 getBackendStatus 原样递给第三方,而名字是用户
    // 自己敲的——有人就拿站点域名当名字,带上等于把地址漏进公开返回值(见 public/api.ts 白名单)。
    // 少了名字也不难定位:面板下拉里选中的就是这条。
    const conn = activeNaiEndpoint();
    if (!conn.url.trim()) {
      return { ...base, configured: false, reason: '当前 NAI 接入点未填写服务地址' };
    }
    if (!conn.key.trim()) {
      return { ...base, configured: false, reason: '当前 NAI 接入点未填写 API Key' };
    }
    return { ...base, configured: true, reason: '' };
  }

  if (backend === 'comfyui') {
    const preset = activeComfyPreset();
    const base = { backend, model: preset.name, supportsCharacters: false };
    if (!settings.comfyui.url.trim()) {
      return { ...base, configured: false, reason: '未填写 ComfyUI 服务地址' };
    }
    if (preset.mode === 'simple') {
      const invalid = validateSimpleConfig(preset.simple);
      if (invalid) return { ...base, configured: false, reason: invalid };
      return { ...base, configured: true, reason: '' };
    }
    if (!preset.workflow.trim()) {
      return { ...base, configured: false, reason: '当前工作流预设未填写工作流 JSON' };
    }
    return { ...base, configured: true, reason: '' };
  }

  if (backend === 'dshbridge') {
    // DSH 侧不传 characters(它自己按档案与 line 门禁解析),故恒 false:
    // 第三方据此决定要不要提示用户换后端,与 ComfyUI 同一口径。
    const base = {
      backend,
      model: settings.dshBridge.configSet.trim() || 'DSH 默认配置集',
      supportsCharacters: false,
    };
    if (!settings.dshBridge.url.trim()) {
      return { ...base, configured: false, reason: '未填写 DSH 桥接地址' };
    }
    // 令牌是可选的(DSH 未启用校验时不用填),故**不**作为就绪条件:
    // 把它当必需品会让绝大多数没开令牌的用户看到「未配置」却不知道要填什么。
    return { ...base, configured: true, reason: '' };
  }

  // webui 只剩存量类型(设置迁移会把它归一成 comfyui/nai),真出现就是「没选后端」
  return {
    backend,
    configured: false,
    model: '',
    supportsCharacters: false,
    reason: '出图后端未选择,请在柏宝绘「渠道」页选择出图渠道',
  };
}

/**
 * 定本次种子。**必须在发请求前定好**:一是部分采样器节点不接受 -1 自动随机,
 * 二是埋点与落盘(entry.seed)都要记下它,事后「同种子再来一张」才有依据。
 *
 * 口径:显式指定 > NAI 面板固定种子(>0)> 随机。
 * NAI 与 ComfyUI 的随机上界不同(各自协议的合法范围),故分开取。
 */
export function decideSeed(backend: BackendId, override?: number): number {
  if (override !== undefined && Number.isFinite(override) && override > 0) return Math.floor(override);
  if (backend === 'nai') return settings.nai.seed > 0 ? settings.nai.seed : naiRandomSeed();
  return randomSeed();
}

/**
 * 按当前设置出一张图。**楼层卡片与公开接口的唯一生成路径。**
 *
 * 不负责落盘、不负责显示、不登记运行态、不做埋点 —— 那些是调用方的事。
 * signal 一路透传到 fetch/轮询;取消时抛 AbortError(DOMException)。
 *
 * 闸门纪律(见 floor/genQueue.ts):NAI 路径必须持槽发请求,release 放在 finally,
 * 漏一格就永久少一格并发。
 */
export async function generateImage(
  input: GenerateInput,
  signal?: AbortSignal,
  progress: GenerateProgress = {},
): Promise<GenerateOutput> {
  const status = backendStatus();
  const isDsh = status.backend === 'dshbridge';
  // 占位卡片(只有 <dsh>、没有 tag)撞上本地后端时,必须**最先**拦下并说清该切哪个渠道。
  // 放在 configured 判断**之前**是刻意的:这类卡片出错时用户看到的若是
  // 「正向提示词不能为空」或「当前工作流预设未填写」,两条都在说别的事——真正的原因是
  // 他在一张写满画面描述的卡片上按了生成,而出图渠道根本读不懂占位。
  // 判据只看「有散文、没 tag」:这类卡片本来就是给 DSH 写手准备的,本地后端拼不出一条串。
  const dshScene = (input.dsh ?? '').trim();
  if (!isDsh && dshScene && !input.prompt.trim()) {
    throw new Error(
      '这张卡片是「画面占位」，画面描述要交给 DSH 写手写成提示词；'
      + '当前出图渠道是本地后端，读不懂占位。请到柏宝绘「渠道 → DSH 写手」切换渠道后再出图。',
    );
  }
  // 兜底:卡片侧已用 configured 拦在按钮上,公开接口侧也会先报 not_configured。
  // 真漏到这里说明上游判据漂了,宁可明说也别发一个注定 401/404 的请求。
  if (!status.configured) throw new Error(status.reason || '出图后端未配置');

  const isNai = status.backend === 'nai';
  const characters = input.characters ?? [];
  // 支持与否由后端说了算:ComfyUI 恒不支持;NAI 看模型是否 4.5/V5
  const charactersApplied = characters.length > 0 && status.supportsCharacters;

  let release: (() => void) | null = null;
  try {
    // 持槽:取到槽位后本函数内一直持有,直到 finally 释放
    if (isNai) release = await acquireNaiSlot(signal);
    progress.onStart?.();

    // 画幅锁在这里统一生效(卡片与公开接口同走本函数):只决定这一次用哪格尺寸,
    // tag 里记的方向原样不动——promptHash 吃 tag 原文,改写会让老图无辜变 stale。
    const size = effectiveOrientation(activeOrientationLock(), input.size ?? 'portrait');
    let result: ComfyImageResult;
    let meta: GenerationMeta;
    // 最终全文在这里先算一遍(纯函数),**先于请求**报给调用方:失败也要能回看发了什么。
    // 两处拼装都必须与后端内部用自己的那份完全同源 —— 逐字段照抄,不许「差不多」:
    // 差一个字段,历史里记的就不是真正发出去的东西了。
    let finalPrompt = '';
    let finalNegative = '';
    if (isDsh) {
      // DSH 写手:柏宝绘不拼提示词,只把画面散文原样送过去。故这里**没有** onPrompt 预览
      // ——成品串是 DSH 写出来的,发请求前根本不存在,硬编一个假的只会让历史记错。
      // 真串在回包里(prompt 字段),拿到后再通过 finalPrompt 补录。
      //
      // 场景来源:优先 <dsh> 占位;占位为空时回落 prompt,这样把同一条卡片切到老 tag 上
      // 也能出图(否则「换了后端,卡片点什么都没反应」)。
      const scene = dshScene || input.prompt.trim();
      if (!scene) throw new Error('这条占位没有画面描述,无法交给 DSH');
      const conn = effectiveDshBridge();
      const output = await generateDshImage(
        conn,
        {
          scene,
          characters: input.dshCharacters?.length ? input.dshCharacters : undefined,
          size,
          negative: input.negative,
          seed: input.seed,
          source: input.source,
        },
        signal,
        // 轮询进度直接借 onQueue 那条已经在用的通道（卡片会显示「排队中」位置）：
        // 不新开 UI 概念，出图阶段的变化就能看见。
        {
          onStage: (_stage, label) => {
            if (label === 'DSH 入队' || label === '完成' || label === '失败') return;
            try {
              progress.onQueue?.(null);
            } catch {
              // 进度回调失败不能影响出图。
            }
          },
        },
      );
      result = output;
      // DSH 回了成品串就用它(那是「这次究竟发了什么」的唯一真相);没回就记散文本身,
      // 至少比一个空串更能说明这张图画的是什么。
      finalPrompt = output.prompt.trim() || scene;
      finalNegative = output.negative || input.negative || '';
      reportPrompt(progress, finalPrompt, finalNegative);
      meta = {
        backend: 'dshbridge',
        model: status.model,
        width: output.width,
        height: output.height,
        positive: finalPrompt,
        negative: finalNegative,
        artist: null,
        vibes: [],
        // 采样参数全在 DSH 侧的配置集里,柏宝绘这边一个都看不到——故留空。
        // 硬填一个(比如把配置集 id 写进 template)会让「模型/模板」两行显示成一件事,
        // 排查时反而误以为是我们自己组装的模板。
        params: {},
      };
    } else if (isNai) {
      const nai = effectiveNai();
      // 先算成品再发请求:与 backends/nai 内部同一对纯函数(fullPositivePrompt /
      // fullNegativePrompt),同一份 nai 快照 —— 所以这里算出的就是真正发出去的那条。
      finalPrompt = fullPositivePrompt(nai, input.prompt, input.nl ?? '');
      finalNegative = fullNegativePrompt(nai);
      reportPrompt(progress, finalPrompt, finalNegative);
      const output = await generateNaiImage(
        nai,
        // characters 原样透传:不支持的模型由 buildNaiParameters 自己滤掉(同一口径
        // naiSupportsCharacterPrompts),在这儿再滤一遍只会多一处会漂的判据
        { prompt: input.prompt, nl: input.nl ?? '', characters, seed: input.seed, size },
        signal,
        { onRetry: info => progress.onRetry?.({ attempt: info.attempt, max: info.max }) },
      );
      result = output.result;
      meta = { backend: 'nai', model: status.model, ...output.usage };
    } else {
      const conn = effectiveComfyConn();
      // 尺寸解析口径与 generateComfyImage 一致（未解析出时 0 = 用工作流自带尺寸）。
      const px = parseSize(pickSize(conn, size));
      const width = px?.width ?? 0;
      const height = px?.height ?? 0;
      // 与 generateComfyImage 内部同一对纯函数、同一份取值:算出来的就是发出去的那条。
      const preview = previewComfyPrompt(conn, {
        prompt: input.prompt,
        nl: input.nl,
        appearance: input.appearance,
        negative_prompt: input.negative,
        seed: input.seed,
        width,
        height,
      });
      finalPrompt = preview.positive;
      finalNegative = preview.negative;
      reportPrompt(progress, finalPrompt, finalNegative);
      result = await generateComfyImage(
        conn,
        {
          prompt: input.prompt,
          nl: input.nl ?? '',
          appearance: input.appearance ?? '',
          negative_prompt: input.negative ?? '',
          seed: input.seed,
          size,
        },
        signal,
        { onQueue: ahead => progress.onQueue?.(ahead) },
      );
      // ComfyUI 没有运行期跳过的概念，配方全在预设里，可在此直接快照。
      meta = {
        backend: 'comfyui',
        model: status.model,
        width,
        height,
        positive: finalPrompt,
        negative: finalNegative,
        artist: null,
        vibes: [],
        params: conn.mode === 'simple' ? comfySimpleParams(conn.simple) : { mode: 'custom' },
      };
    }

    // 退避文案到此为止:图已拿到,落盘还要一会儿,不该继续显示「稍后重试」
    progress.onRetry?.(null);
    return {
      result,
      seed: input.seed,
      size,
      backend: status.backend,
      charactersApplied,
      finalPrompt,
      finalNegative,
      meta,
    };
  } finally {
    release?.();
  }
}
