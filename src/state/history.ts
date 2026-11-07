import { reactive } from 'vue';

import type { ChatMsg } from '@/api/client';
import type { ImageCharacterPrompt } from '@/autoTag/protocol';
import type { Orientation } from '@/backends/size';

/**
 * 请求历史(副 API 推理 + 生图)的模块级内存 store。
 *
 * **刻意不持久化**:刷新页面即清空,不进 settings、不落 localStorage。
 * 这是调试辅助——出问题时回看这一轮发了什么、收到什么,而不是要长期保存的资产。
 * 想留证据请在页面里复制出去。
 *
 * 为什么放模块级而非组件里:请求由 autoTag/Card 等处发起,历史页可能压根没打开过;
 * 记录必须活得比任何组件都长。与 floor/genState.ts 同构。
 *
 * 【重要】本模块的所有写入函数都必须是「不会抛」的:调用方在真实业务路径上
 * (发请求、出图),历史记录失败绝不能连累主流程。故 record() 内部吞异常,
 * 且调用方仍应用 safe*() 包装(见 api/client.ts 的用法)。
 */

/** 条数上限。副 API 的提示词很大(世界书+角色库+正文),不封顶几十条就是几十 MB。 */
const MAX_RECORDS = 50;

/**
 * 单条文本留存上限。超出截断并标注原长——
 * buildAutoTagMessages 拼出的 system 提示词轻松上万字,50 条全量留存内存吃不消。
 */
const MAX_CONTENT = 20_000;

export type HistoryKind = 'llm' | 'image';

/** running 是进行中;aborted 是用户主动取消(与 error 分开,不是故障)。 */
export type HistoryStatus = 'running' | 'ok' | 'error' | 'aborted';

interface BaseRecord {
  /** 自增序号,**不用 Date.now()**:同一毫秒内并发的多个请求会撞成同一 id。 */
  id: number;
  kind: HistoryKind;
  status: HistoryStatus;
  startedAt: number;
  /** 完成后才有;进行中为 null。 */
  durationMs: number | null;
  /** status='error' 时的错误信息,其余为空串。 */
  error: string;
}

export interface LlmRecord extends BaseRecord {
  kind: 'llm';
  /** 用途标签:'自动 tag' / '角色外貌转换' / 'ComfyUI 工作流配置' 等,由调用点传入。 */
  source: string;
  /** 渠道名;未指派渠道(跟随主 API)时为 FOLLOW_MAIN_API。 */
  channelName: string;
  model: string;
  stream: boolean;
  /** 完整提示词(已按 MAX_CONTENT 截断)。 */
  messages: ChatMsg[];
  /** 返回正文(已截断)。 */
  response: string;
  promptTokens: number | null;
  completionTokens: number | null;
  /**
   * token 数是否为本地估算。
   * 真值只在「自建渠道 + 非流式」时拿得到(ST 代理原样透传上游 usage);
   * 流式与跟随主 API 只能用 ST 分词器估——而它用的是**主界面当前模型**的分词器,
   * 与副 API 渠道模型未必同源。故 UI 必须用 ≈ 区分,不能与真值混显。
   */
  tokensEstimated: boolean;
}

export interface ImageRecord extends BaseRecord {
  kind: 'image';
  backend: 'nai' | 'comfyui' | 'dshbridge';
  /** NAI 模型名 / ComfyUI 当前工作流预设名。 */
  model: string;
  prompt: string;
  nl: string;
  negative: string;
  characters: ImageCharacterPrompt[];
  seed: number;
  size: Orientation;
  /** 楼层坐标:详情里据此指回是哪一楼哪个槽位。图片本身不存(见文件头)。 */
  floor: number;
  seq: number;
  /**
   * **最终实际提交给后端的那一条正向全文**(已含固定正面/AI tag/nl/中文外貌、
   * NAI 的画质词与画师串)。上面那几个字段是分段原料,这里是合成后的成品——
   * 「这次到底发了什么」只能看它:分段原料看不出拼接顺序、看不出某段是否被丢弃
   * (非 moss 模板下 nl 会顶掉 tag)、也看不出中文外貌拼在了哪儿。
   *
   * 由 startImage() 在生成开始时补录(拼装只在后端模块里发生,begin 时还拿不到);
   * 为空串表示这次没能拿到(例如请求在校验阶段即被拦下)。
   */
  finalPrompt?: string;
  /** 最终实际提交的负面全文(已含固定负面);口径同 finalPrompt。 */
  finalNegative?: string;
  /**
   * 中文外貌段落(插件从角色库机械拼接)。与 finalPrompt 并存:
   * 前者是「用户填了什么」,后者是「它最后落在串的哪个位置」——排查脸漂时要对照着看。
   */
  appearance?: string;
}

export type HistoryRecord = LlmRecord | ImageRecord;

/** 跟随主 API 时的渠道名占位。 */
export const FOLLOW_MAIN_API = '跟随主 API';

/**
 * 全部记录,**新的在前**(页面直接 v-for,不用每次 reverse)。
 * 因此「丢最旧」= 从尾部 pop。
 */
export const records = reactive<HistoryRecord[]>([]);

let nextId = 1;

/** 超长文本截断并标注原长;短文本原样返回(不产生新字符串)。 */
export function truncate(text: string): string {
  if (typeof text !== 'string') return '';
  if (text.length <= MAX_CONTENT) return text;
  return `${text.slice(0, MAX_CONTENT)}\n…(已截断，原长 ${text.length} 字符)`;
}

/** 中日韩表意文字/假名/谚文/全角标点:这些大致 1 字 = 1 token。 */
const CJK_PATTERN =
  /[　-〿぀-ヿ㐀-䶿一-鿿가-힯豈-﫿＀-￯]/;

/**
 * 单段文本的 token 粗估(同步、纯本地)。
 *
 * 为什么不用 ST 的 getTokenCountAsync:那是异步 HTTP(打 /api/tokenizers/…),
 * 展开一条 8 段的记录就是 8 个请求;而这里的数字只用于**段与段之间比大小**
 * (「哪段把提示词撑爆了」),不需要精确。
 *
 * 口径:中日韩按 1 字 1 token,其余(拉丁字母/数字/符号)按 4 字符 1 token——
 * BPE 分词器的通用经验值。**必然与真实用量有出入**,故 UI 上一律带 ≈ 显示,
 * 也不要拿各段之和去对标题行那个真值(那是上游 usage,口径不同)。
 */
export function roughTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let rest = 0;
  // for...of 按码点遍历,代理对(emoji/罕见汉字)算一个字符而非两个
  for (const ch of text) {
    if (CJK_PATTERN.test(ch)) cjk++;
    else rest++;
  }
  return Math.round(cjk + rest / 4);
}

function truncateMessages(messages: ChatMsg[]): ChatMsg[] {
  if (!Array.isArray(messages)) return [];
  return messages.map(m => ({ role: m.role, content: truncate(m.content) }));
}

/** 压入一条并维持封顶。新记录进头部,超出时从尾部(最旧)丢弃。 */
function push(record: HistoryRecord): void {
  records.unshift(record);
  while (records.length > MAX_RECORDS) records.pop();
}

/**
 * 按 id 找记录。返回 undefined 表示已被挤出封顶——
 * 长请求期间若前面涌进 50 条新记录,它就没了,此时 finish/fail 是安全空操作。
 */
function find(id: number): HistoryRecord | undefined {
  return records.find(r => r.id === id);
}

export interface LlmBegin {
  source: string;
  channelName: string;
  model: string;
  stream: boolean;
  messages: ChatMsg[];
}

/** 登记一次副 API 请求,返回 id 供后续 finish/fail。 */
export function beginLlm(info: LlmBegin): number {
  const id = nextId++;
  push({
    id,
    kind: 'llm',
    status: 'running',
    startedAt: Date.now(),
    durationMs: null,
    error: '',
    source: info.source,
    channelName: info.channelName,
    model: info.model,
    stream: info.stream,
    messages: truncateMessages(info.messages),
    response: '',
    promptTokens: null,
    completionTokens: null,
    tokensEstimated: false,
  });
  return id;
}

export interface LlmFinish {
  response: string;
  promptTokens: number | null;
  completionTokens: number | null;
  tokensEstimated: boolean;
}

export function finishLlm(id: number, info: LlmFinish): void {
  const record = find(id);
  if (record?.kind !== 'llm') return;
  record.status = 'ok';
  record.durationMs = Date.now() - record.startedAt;
  record.response = truncate(info.response);
  record.promptTokens = info.promptTokens;
  record.completionTokens = info.completionTokens;
  record.tokensEstimated = info.tokensEstimated;
}

/**
 * 请求失败或被取消。aborted 与 error 分开:前者是用户主动取消,不是故障,
 * UI 用中性色而非红色。
 */
export function failLlm(id: number, message: string, aborted = false): void {
  const record = find(id);
  if (record?.kind !== 'llm') return;
  record.status = aborted ? 'aborted' : 'error';
  record.durationMs = Date.now() - record.startedAt;
  record.error = aborted ? '' : message;
}

/** 估算 token 补录:请求已成功但真值拿不到时,估算结果晚于 finishLlm 到达。 */
export function patchLlmTokens(id: number, promptTokens: number | null, completionTokens: number | null): void {
  const record = find(id);
  if (record?.kind !== 'llm') return;
  // 已有真值时不覆盖(非流式路径拿到了 usage,估算结果作废)
  if (!record.tokensEstimated && record.promptTokens !== null) return;
  record.promptTokens = promptTokens;
  record.completionTokens = completionTokens;
  record.tokensEstimated = true;
}

export interface ImageBegin {
  backend: 'nai' | 'comfyui' | 'dshbridge';
  model: string;
  prompt: string;
  nl: string;
  negative: string;
  characters: ImageCharacterPrompt[];
  seed: number;
  size: Orientation;
  floor: number;
  seq: number;
  /** 中文外貌段落;null/缺省 = 本次没有(非 moss 模板或库中无人命中)。 */
  appearance?: string;
  /**
   * 最终提交的正向全文。**调用方通常不传**:拼装只在 backends 里发生,
   * begin 时还没拼出成品;拿到之后用 finishImage(id, {...}) 补录。
   * 只有调用方自己就知道成品时(如直接给后端的固定串)才在这里传。
   */
  finalPrompt?: string;
  finalNegative?: string;
}

/** 登记一次生图请求。图片结果不进 store(dataURL 会爆内存,且图已落盘进 ST)。 */
export function beginImage(info: ImageBegin): number {
  const id = nextId++;
  const record: ImageRecord = {
    id,
    kind: 'image',
    status: 'running',
    startedAt: Date.now(),
    durationMs: null,
    error: '',
    backend: info.backend,
    model: info.model,
    prompt: truncate(info.prompt),
    nl: truncate(info.nl),
    negative: truncate(info.negative),
    characters: info.characters.map(character => ({
      name: truncate(character.name),
      tag: truncate(character.tag),
      nl: truncate(character.nl),
    })),
    seed: info.seed,
    size: info.size,
    floor: info.floor,
    seq: info.seq,
  };
  // 可选键:没有就不写,免得每条记录都多出两个空字段(与 CharTagEntry.zh 同口径)
  const appearance = (info.appearance ?? '').trim();
  if (appearance) record.appearance = truncate(appearance);
  if (info.finalPrompt) record.finalPrompt = truncate(info.finalPrompt);
  if (info.finalNegative) record.finalNegative = truncate(info.finalNegative);
  push(record);
  return id;
}

export interface ImageFinish {
  /**
   * 最终实际提交的正向/负面全文。拼装发生在 backends(comfyTemplates 的 composePositive、
   * nai 的 fullPositivePrompt),begin 时还没有成品,故在生成成功或失败后补录。
   * 失败也要补:被拦在提交前的请求同样值得回看「它本来要发什么」。
   */
  finalPrompt?: string;
  finalNegative?: string;
}

/**
 * 补录最终提交的提示词全文。可在 finish 前、后任意时刻调用;
 * 空串不写(不覆盖已有值,也不给记录凭空加空键)。
 */
export function patchImagePrompt(id: number, finalPrompt?: string, finalNegative?: string): void {
  const record = find(id);
  if (record?.kind !== 'image') return;
  if (finalPrompt) record.finalPrompt = truncate(finalPrompt);
  if (finalNegative) record.finalNegative = truncate(finalNegative);
}

export function finishImage(id: number, info: ImageFinish = {}): void {
  const record = find(id);
  if (record?.kind !== 'image') return;
  record.status = 'ok';
  record.durationMs = Date.now() - record.startedAt;
  patchImagePrompt(id, info.finalPrompt, info.finalNegative);
}

export function failImage(id: number, message: string, aborted = false): void {
  const record = find(id);
  if (record?.kind !== 'image') return;
  record.status = aborted ? 'aborted' : 'error';
  record.durationMs = Date.now() - record.startedAt;
  record.error = aborted ? '' : message;
}

/** 清空(页面上的「清空」按钮)。 */
export function clearHistory(): void {
  records.splice(0, records.length);
}

/** 测试用:复位到干净状态(含 id 计数器)。 */
export function resetHistory(): void {
  clearHistory();
  nextId = 1;
}

/** 测试用:暴露封顶常量,免得单测里写死数字与实现脱节。 */
export const HISTORY_LIMITS = { MAX_RECORDS, MAX_CONTENT } as const;

/**
 * 埋点调用的统一包装:记录失败一律静默降级,**绝不向上抛**。
 *
 * 历史是调试辅助,而调用点全在真实业务路径上(发请求、出图)——
 * 让记录逻辑把生图/tag 搞挂是本末倒置。所有 begin/finish/fail 都该经过这里。
 */
export function safeHistory<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch (e) {
    console.debug('[柏宝绘] 请求历史记录失败(已忽略)', e);
    return null;
  }
}
