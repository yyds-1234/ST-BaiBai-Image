import { describe, expect, it } from 'vitest';

import { collectDshStory, DSH_STORY_MAX_CHARS } from '@/autoTag/dshStory';
import type { STMessage } from '@/st/context';

/**
 * 剧情传递（DSH 写手渠道）的契约。
 *
 * 这段逻辑决定「写手能看到多少前因」，三条判据都是**用户口径**，改之前先想清楚：
 * 1. 窗口上界是**上一个占位**（那张图已经替那段正文说过话了），不是固定 N 层；
 * 2. 上限 500 字，超了砍头留尾（离这一帧最近的几句最有用）；
 * 3. 占位标签本身绝不进剧情——写手拿到的应该是正文，不是又一份委托单。
 */

const PLACEHOLDER = (scene: string): string =>
  '<bbi_image><dsh>人物名称：林夏\n人物服装：米色长风衣\n场景描述：' + scene + '</dsh><size>portrait</size></bbi_image>';

function message(mes: string, extra: Partial<STMessage> = {}): STMessage {
  return { name: '林夏', is_user: false, is_system: false, mes, ...extra };
}

describe('collectDshStory: 窗口边界', () => {
  it('同一楼里两条占位之间：只取中间那段正文，占位标签不进剧情', () => {
    const mes = [
      '她把伞插进伞桶。',
      PLACEHOLDER('她抬手把湿发别到耳后'),
      '她推门进去，暖气和关东煮的味道一起涌上来。店员抬头看了她一眼。',
      PLACEHOLDER('她站在关东煮柜前'),
      '她挑了两串萝卜。',
    ].join('\n\n');

    const window = collectDshStory([message(mes)], 0, 1);

    expect(window.bounded).toBe(true);
    expect(window.text).toContain('她推门进去，暖气和关东煮的味道一起涌上来。');
    expect(window.text).toContain('店员抬头看了她一眼。');
    // 上一条占位之前的内容属于更早那张图，不在窗口里
    expect(window.text).not.toContain('她把伞插进伞桶');
    // 这一条占位之后的内容是「未来」，不属于剧情
    expect(window.text).not.toContain('她挑了两串萝卜');
    // 占位原文（三行委托单）不应作为剧情混进来
    expect(window.text).not.toContain('人物名称');
    expect(window.text).not.toContain('bbi_image');
  });

  it('跨楼：上一条占位在更早的楼里，中间整楼 + 本楼占位前的正文都算', () => {
    const chat = [
      message('开头的一段铺垫。'),
      message('她在门口站了很久。\n\n' + PLACEHOLDER('她侧身回头')),
      message('雨停了。她把伞收起来，抖了抖水。'),
      message('推门的时候风灌进来，吹得她眯起眼睛。\n\n' + PLACEHOLDER('她推门而入')),
      message('后面的内容不在窗口里。'),
    ];

    const window = collectDshStory(chat, 3, 0);

    expect(window.bounded).toBe(true);
    expect(window.text).toContain('雨停了。她把伞收起来');
    expect(window.text).toContain('推门的时候风灌进来');
    // 上一条占位所在那一楼的**前半段**（她进门之前）已经由那张图负责
    expect(window.text).not.toContain('她在门口站了很久');
    // 本楼里占位之后的内容不算剧情
    expect(window.text).not.toContain('后面的内容不在窗口里');
  });

  it('前面还没有占位：bounded=false，一路取到聊天开头', () => {
    const chat = [
      message('故事的第一句。'),
      message('第二楼：她走进店里。'),
      message('第三楼。\n\n' + PLACEHOLDER('她抬头看灯')),
    ];

    const window = collectDshStory(chat, 2, 0);

    expect(window.bounded).toBe(false);
    expect(window.text).toContain('故事的第一句。');
    expect(window.text).toContain('第二楼：她走进店里。');
    expect(window.text).toContain('第三楼。');
    // 时间顺序：越早的越靠前
    expect(window.text.indexOf('故事的第一句')).toBeLessThan(window.text.indexOf('第三楼。'));
  });

  it('窗口按时间顺序拼，不按遍历顺序（近→远累积后要翻回来）', () => {
    const chat = [
      message('第一句。'),
      message('第二句。'),
      message('第三句。\n\n' + PLACEHOLDER('她抬头看灯')),
    ];
    const window = collectDshStory(chat, 2, 0);
    expect(window.text.indexOf('第一句')).toBeLessThan(window.text.indexOf('第二句'));
    expect(window.text.indexOf('第二句')).toBeLessThan(window.text.indexOf('第三句'));
    expect(window.floors).toBe(3);
  });
});

describe('collectDshStory: 上限与清洗', () => {
  it('超过 500 字砍头留尾，前缀（前略）标出还有上文', () => {
    const long = '最早的那一句。' + '甲'.repeat(600) + '离这一帧最近的一句。';
    const chat = [message(long + '\n\n' + PLACEHOLDER('她抬头看灯'))];

    const window = collectDshStory(chat, 0, 0);

    expect(window.truncated).toBe(true);
    expect(window.text.startsWith('（前略）')).toBe(true);
    // 最近的句子一定保住，最早的句子一定被砍掉
    expect(window.text).toContain('离这一帧最近的一句。');
    expect(window.text).not.toContain('最早的那一句。');
    // 整段（含标记）不超过 500 字
    expect(window.chars).toBeLessThanOrEqual(DSH_STORY_MAX_CHARS);
  });

  it('上限可调（设置里没有这一项，测试保证函数本身不是写死 500）', () => {
    const chat = [message('一二三四五六七八九十。')];
    const window = collectDshStory(chat, 0, 0, { maxChars: 5 });
    expect(window.truncated).toBe(true);
    expect(window.chars).toBeLessThanOrEqual(5);
  });

  it('短于上限原样返回，不加标记', () => {
    const chat = [message('她站在门口。\n\n' + PLACEHOLDER('她侧身回头'))];
    const window = collectDshStory(chat, 0, 0);
    expect(window.truncated).toBe(false);
    expect(window.text).toBe('她站在门口。');
    expect(window.chars).toBe(6);
  });

  it('系统消息（is_system + extra.type）不进剧情，/hide 的普通楼照进', () => {
    const chat = [
      message('第一楼正文。'),
      message('系统提示：这一段不是剧情。', { is_system: true, extra: { type: 'narrator' } }),
      message('被隐藏的普通楼也是剧情。', { is_system: true }),
      message('目标楼。\n\n' + PLACEHOLDER('她抬头看灯')),
    ];
    const window = collectDshStory(chat, 3, 0);
    expect(window.text).toContain('第一楼正文。');
    expect(window.text).toContain('被隐藏的普通楼也是剧情。');
    expect(window.text).not.toContain('这一段不是剧情');
  });

  it('自定义清洗标签整块删掉（与 autoTag 链路同一份名单）', () => {
    const chat = [message('<状态>体力 20/100</状态>她扶着墙站起来。\n\n' + PLACEHOLDER('她抬头看灯'))];
    const window = collectDshStory(chat, 0, 0, { stripTags: ['状态'] });
    expect(window.text).toBe('她扶着墙站起来。');
  });

  it('楼号/序号越界时安全返回空窗口，不抛', () => {
    expect(collectDshStory([], 0, 0).text).toBe('');
    expect(collectDshStory([message('只有一楼')], 5, 0).text).toBe('');
    // 序号越界：回落「最后一条已知占位之后」的正文，不崩、也不把占位原文当剧情
    const chat = [message('她在窗边。\n\n' + PLACEHOLDER('她侧身回头') + '\n\n她转过身来。')];
    const out = collectDshStory(chat, 0, 9);
    expect(out.text).toBe('她转过身来。');
    expect(out.text).not.toContain('人物名称');
  });
});
