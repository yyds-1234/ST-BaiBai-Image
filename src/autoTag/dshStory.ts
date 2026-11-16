/**
 * 剧情传递（DSH 写手渠道）：把「这一条占位 → 上一个占位」之间的正文取出来，随出图请求一起交给 DSH。
 *
 * 【为什么需要它】
 * 占位协议刻意把委托单压缩成三行（人物名称 / 人物服装 / 场景描述），画师看得到「这一帧长什么样」，
 * 却看不到「人为什么在这儿、刚才发生了什么」。三行里写「她侧身回头把湿发别到耳后」，写手只能照着
 * 这一帧硬写：前因、人物关系、此刻的情绪来源全凭空补。补错的表现不是报错，而是「图和正文对不上」——
 * 用户唯一能看到的线索是「这张图感觉不对」。
 *
 * 故这里补上**前后文**：从这条占位往上，取到**上一条占位之后**为止（再往上已经有图在替那段正文说话了），
 * 上限 {@link DSH_STORY_MAX_CHARS} 字。超了就砍头留尾——离这一帧越近的几句越有用。
 *
 * 【为什么是纯函数、且不碰 settings】
 * 这段逻辑要在卡片点下去的那一刻、拿当时的聊天快照算（正文可能刚被改过），也要能离线单测。
 * 清洗标签表由调用方传进来（settings.excludes.customStripTags），与 autoTag 链路同口径。
 *
 * 【为什么上限是 500 字】
 * 用户 2026-11-16 的口径。写手那边的占位预算有限（DSH 侧 scene 上限 8000 字符），而剧情只是
 * **理解用的背景**，不是要写进画面串的内容：给多了会把写手的注意力从这一帧上引开。
 */

import { cleanHistoryText } from '@/autoTag/clean';
import { isStoryMessage, type STMessage } from '@/st/context';
import { IMAGE_TAG_FIND_REGEX } from '@/st/imageTagRegex';

/** 剧情窗口的默认上限（字）。用户口径：不超过 500 字。 */
export const DSH_STORY_MAX_CHARS = 500;

/** 截断时加在最前面的标记：让写手知道上面还有内容，不会被当成「故事就这么开头的」。 */
const STORY_ELLIPSIS = '（前略）';

export interface DshStoryLimits {
  /** 上限（字）；缺省 {@link DSH_STORY_MAX_CHARS}。 */
  maxChars?: number;
  /** 自定义清洗标签表（settings.excludes.customStripTags）。 */
  stripTags?: string[];
}

/** 一次剧情窗口的结果。 */
export interface DshStoryWindow {
  /** 已清洗、按时间顺序、不超过上限的剧情正文（截断时带 {@link STORY_ELLIPSIS} 前缀）。 */
  text: string;
  /** text 的字数（按码点算，中文一个字算 1）。 */
  chars: number;
  /** 是否因为超上限砍掉了开头。 */
  truncated: boolean;
  /**
   * 窗口上界是不是「上一个占位」。
   * false = 往上一直取到了聊天开头（这条占位前面还没有图），此时窗口是「故事开头到这一帧」。
   */
  bounded: boolean;
  /** 覆盖了几层楼（诊断用）。 */
  floors: number;
}

/** 消息里所有 <bbi_image>…</bbi_image> 的区间（按出现顺序）。 */
function tagSpans(mes: string): Array<{ start: number; end: number }> {
  const pattern = new RegExp(IMAGE_TAG_FIND_REGEX.source, IMAGE_TAG_FIND_REGEX.flags);
  const spans: Array<{ start: number; end: number }> = [];
  for (const match of String(mes ?? '').matchAll(pattern)) {
    const start = match.index ?? 0;
    spans.push({ start, end: start + match[0].length });
  }
  return spans;
}

/** 清洗一段正文；标签表原样透传（与 autoTag 链路同一份口径）。 */
function clean(text: string, stripTags: string[]): string {
  return cleanHistoryText(text, stripTags).trim();
}

/** 按码点截尾，并把开头的半句砍掉（最多砍 60 字，找不到句末标点就整段留着）。 */
function clipTail(text: string, maxChars: number): { text: string; truncated: boolean } {
  const chars = Array.from(text);
  if (chars.length <= maxChars) return { text, truncated: false };
  // 截断标记本身也占字数：用户口径是「这一整段不超过 500 字」，不是「正文 500 + 标记」。
  const room = Math.max(1, maxChars - STORY_ELLIPSIS.length);
  let tail = chars.slice(chars.length - room).join('');
  const head = tail.search(/[。！？!?…\n]/);
  if (head >= 0 && head < 60) tail = tail.slice(head + 1);
  return { text: STORY_ELLIPSIS + tail.trim(), truncated: true };
}

/**
 * 取「这一条占位 → 上一个占位」之间的剧情。
 *
 * @param chat  聊天数组（ST 的 context.chat 即可，只读 mes / is_user / is_system / extra.type）。
 * @param floor 这条占位所在楼层。
 * @param slot  这条占位在该楼里的序号（0-based，= 卡片 props.seq = <bbi_image> 在正文里的出现次序）。
 * @param limits 上限与清洗标签表。
 */
export function collectDshStory(
  chat: STMessage[],
  floor: number,
  slot: number,
  limits: DshStoryLimits = {},
): DshStoryWindow {
  const empty: DshStoryWindow = { text: '', chars: 0, truncated: false, bounded: false, floors: 0 };
  const maxChars = Math.max(1, Math.floor(Number(limits.maxChars) || DSH_STORY_MAX_CHARS));
  const stripTags = Array.isArray(limits.stripTags) ? limits.stripTags : [];
  if (!Array.isArray(chat) || floor < 0 || floor >= chat.length) return empty;

  // 近 → 远累积，最后反过来拼成时间顺序：离这一帧最近的那几句一定要保住，
  // 反过来的话（从远处累积）砍掉的就总是最近的剧情，正好砍反了。
  const chunks: string[] = [];
  let bounded = false;
  let floors = 0;
  let budget = 0;

  // ① 本楼：这条占位**之前**的正文（同一楼里的前几条占位，其后的正文也算剧情）。
  const current = chat[floor];
  const mes = String(current?.mes ?? '');
  const spans = tagSpans(mes);
  const at = spans[slot];
  // 同一楼里前面还有占位（slot > 0）= 窗口的上界就是它，不用再往上找；
  // 起点要落在**它之后**，否则上一条占位之前的内容会跟着一起混进来。
  const previousTag = slot > 0 && spans.length > 0 ? spans[Math.min(slot, spans.length) - 1] : undefined;
  if (previousTag) bounded = true;
  const from = previousTag ? previousTag.end : 0;
  const to = at ? at.start : mes.length;
  const before = to > from ? mes.slice(from, to) : '';
  const own = clean(before, stripTags);
  if (own) {
    chunks.push(own);
    budget += Array.from(own).length;
    floors += 1;
  }

  // ② 往上逐楼取，直到撞上「上一个占位」为止。
  for (let index = floor - 1; index >= 0; index -= 1) {
    const message = chat[index];
    if (!isStoryMessage(message)) continue;
    const mes = String(message.mes ?? '');
    const found = tagSpans(mes);
    if (found.length > 0) {
      // 这一楼里有图：只取**最后一条占位之后**的正文 —— 再往前的剧情已经由那张图负责了。
      const after = clean(mes.slice(found[found.length - 1].end), stripTags);
      if (after) {
        chunks.push(after);
        budget += Array.from(after).length;
      }
      bounded = true;
      floors += 1;
      break;
    }
    const whole = clean(mes, stripTags);
    if (whole) {
      chunks.push(whole);
      budget += Array.from(whole).length;
      floors += 1;
    }
    // 攒够就停：再往上取的部分一定会被截掉，读它只是白花时间。
    if (budget >= maxChars) break;
  }

  if (chunks.length === 0) return { ...empty, bounded, floors };

  // 近 → 远累积过，这里翻回时间顺序；段间空行保留（对白 / 分段是剧情的一部分）。
  const joined = chunks
    .reverse()
    .join('\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const clipped = clipTail(joined, maxChars);
  return {
    text: clipped.text,
    chars: Array.from(clipped.text).length,
    truncated: clipped.truncated,
    bounded,
    floors,
  };
}
