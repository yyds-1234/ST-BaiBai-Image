import { describe, expect, it } from 'vitest';

import {
  buildDshPlaceholder,
  describeDshPlaceholder,
  DSH_WORLDBOOK_ENTRY,
  dshSceneOf,
  isDshPlaceholder,
} from '@/autoTag/dshPlaceholder';
import {
  containsTagMarkup,
  formatPromptText,
  parseImageTagContent,
  parseImageTags,
  serializeImageTag,
} from '@/st/imageTagRegex';

/**
 * DSH 占位的解析/序列化契约。
 *
 * 重点不在单条往返(那由 imageTagRegex.test.ts 覆盖),而在**三条共存纪律**:
 * 1. <dsh> 不能漏进 tag 部分——漏了就会被当成 danbooru 词发给 ComfyUI;
 * 2. 一条消息里老 tag 与 dsh 占位必须能共存(用户可能手动插一条、自动 tag 又写一条);
 * 3. <dsh> 里的字面量 </bbi_image> 必须被挡下——查找正则非贪婪,漏一个就从这里截断。
 */

const RAW = '<bbi_image><dsh>傍晚的天台，林夏靠着栏杆回头，逆光把发梢照透</dsh><size>portrait</size></bbi_image>';

describe('parseImageTagContent: <dsh>', () => {
  it('把 <dsh> 拆到独立字段，不污染 tag 部分', () => {
    expect(parseImageTagContent(RAW)).toEqual({
      tag: '',
      nl: '',
      negative: '',
      characters: [],
      size: 'portrait',
      dsh: '傍晚的天台，林夏靠着栏杆回头，逆光把发梢照透',
    });
  });

  it('与 <nl>/<negative>/<characters> 同时存在时各归各位', () => {
    const raw =
      '<bbi_image>1girl<dsh>她在窗边回头</dsh><nl>A girl.</nl><negative>blurry</negative>' +
      '<characters>[{"name":"A","tag":"girl","nl":""}]</characters><size>landscape</size></bbi_image>';
    expect(parseImageTagContent(raw)).toEqual({
      tag: '1girl',
      nl: 'A girl.',
      negative: 'blurry',
      characters: [{ name: 'A', tag: 'girl', nl: '' }],
      size: 'landscape',
      dsh: '她在窗边回头',
    });
  });

  it('老格式（无 <dsh>）解析出的对象里没有 dsh 键（与改动前逐键相同）', () => {
    // 多一个恒为空串的键 = 一次无声的契约变更:既有测试用 toEqual 锁着这条形状。
    expect(parseImageTagContent('<bbi_image>1girl<nl>A girl.</nl></bbi_image>')).toEqual({
      tag: '1girl',
      nl: 'A girl.',
      negative: '',
      characters: [],
      size: 'portrait',
    });
    expect(isDshPlaceholder(parseImageTagContent('<bbi_image>1girl</bbi_image>'))).toBe(false);
  });

  it('跨行写进 <dsh> 的内容被折成单行（提示词里换行没有意义）', () => {
    expect(parseImageTagContent('<bbi_image><dsh>第一句\n第二句</dsh></bbi_image>').dsh).toBe(
      '第一句 第二句',
    );
  });
});

describe('serializeImageTag: <dsh>', () => {
  it('dsh 写在 tag 之后、nl 之前', () => {
    expect(
      serializeImageTag({
        tag: '1girl',
        dsh: '她在窗边回头',
        nl: 'A girl.',
        negative: '',
        characters: [],
        size: 'portrait',
      }),
    ).toBe('<bbi_image>1girl<dsh>她在窗边回头</dsh><nl>A girl.</nl><size>portrait</size></bbi_image>');
  });

  it('dsh 为空时不写空子标签（老格式逐字不变）', () => {
    expect(
      serializeImageTag({ tag: '1girl', dsh: '', nl: '', negative: '', characters: [], size: 'portrait' }),
    ).toBe('<bbi_image>1girl<size>portrait</size></bbi_image>');
  });

  it('buildDshPlaceholder 产出的串能原样解析回来（读写只有一份口径）', () => {
    const raw = buildDshPlaceholder('深夜的书房，她趴在桌上睡着了，台灯从左侧打过来', 'landscape');
    expect(raw).toBe(
      '<bbi_image><dsh>深夜的书房，她趴在桌上睡着了，台灯从左侧打过来</dsh><size>landscape</size></bbi_image>',
    );
    expect(parseImageTagContent(raw)).toEqual({
      tag: '',
      nl: '',
      negative: '',
      characters: [],
      size: 'landscape',
      dsh: '深夜的书房，她趴在桌上睡着了，台灯从左侧打过来',
    });
    expect(serializeImageTag(parseImageTagContent(raw))).toBe(raw);
  });
});

describe('与老格式共存', () => {
  const MES =
    '第一段正文\n' +
    '<bbi_image>1girl, moonlight<nl>A girl on the roof.</nl><size>portrait</size></bbi_image>\n' +
    '第二段正文\n' +
    '<bbi_image><dsh>深夜的天台，她独自站着，月光从右后方打来</dsh><size>landscape</size></bbi_image>';

  it('一条消息里两个 tag，一个有 dsh 一个没有', () => {
    const tags = parseImageTags(MES);
    expect(tags).toHaveLength(2);
    const [old, dsh] = tags.map(parseImageTagContent);
    expect(isDshPlaceholder(old)).toBe(false);
    expect(old.tag).toBe('1girl, moonlight');
    expect(isDshPlaceholder(dsh)).toBe(true);
    expect(dsh.tag).toBe('');
    expect(dsh.size).toBe('landscape');
  });

  it('dshSceneOf 只取散文且 trim', () => {
    expect(dshSceneOf({ dsh: '  她在窗边回头  ' })).toBe('她在窗边回头');
    expect(dshSceneOf({ dsh: '   ' })).toBe('');
  });

  it('formatPromptText 把 dsh 作为正文段展示，卡片与图库同一口径', () => {
    const content = parseImageTagContent('<bbi_image><dsh>她在窗边回头</dsh><size>portrait</size></bbi_image>');
    expect(formatPromptText(content)).toBe('她在窗边回头');
    // 老格式不受影响:没有 dsh 时不凭空多出一段空行
    expect(
      formatPromptText(parseImageTagContent('<bbi_image>1girl<nl>night</nl></bbi_image>')),
    ).toBe('1girl\n\nnight');
  });

  it('describeDshPlaceholder 给出可读副标题，空散文给空串', () => {
    expect(describeDshPlaceholder('  她在窗边回头  ')).toBe('DSH 写手 · 6 字画面描述');
    expect(describeDshPlaceholder('   ')).toBe('');
  });
});

describe('子标签字面量必须被挡下', () => {
  it('dsh 现在也在 FORBIDDEN_SUBTAG 名单里', () => {
    expect(containsTagMarkup('场景<dsh>')).toBe(true);
    expect(containsTagMarkup('场景</dsh>')).toBe(true);
    // 未闭合的 <dsh 不算（与 <tag 同款:标签名后面必须是词边界）
    expect(containsTagMarkup('a <dshx> b')).toBe(false);
  });

  it('<dsh> 里出现 </bbi_image> 会被识别为非法内容', () => {
    // 查找正则非贪婪:内容里混进闭标签会让 tag 在这里提前截断,后半截漏进 DOM 与提示词。
    // 解析是**容忍式**的(它照读原文,不做校验),所以真正的闸门是 containsTagMarkup ——
    // 手输侧(提示词弹窗)与 AI 侧(protocol.sanitizeContent)都靠它拦。
    const scene = '她在窗边回头</bbi_image>然后正文漏出去';
    expect(containsTagMarkup(scene)).toBe(true);
    // 强行写进正文时,截断是真实发生的:展示侧正则只认到第一个闭标签
    const raw = buildDshPlaceholder(scene);
    expect(raw).toContain('</bbi_image>');
    expect(parseImageTagContent(raw).dsh).toContain('</bbi_image>');
  });
});

describe('DSH_WORLDBOOK_ENTRY', () => {
  it('是一段可直接粘贴的成品文本：含格式、四要素、长度与禁用清单', () => {
    expect(DSH_WORLDBOOK_ENTRY).toContain('<bbi_image><dsh>');
    expect(DSH_WORLDBOOK_ENTRY).toContain('<size>portrait</size>');
    // 四要素缺一件,画出来就是通用插图——这四个词是条目的承重墙
    for (const element of ['谁在画面里', '在哪', '在做什么', '光从哪来']) {
      expect(DSH_WORLDBOOK_ENTRY).toContain(element);
    }
    expect(DSH_WORLDBOOK_ENTRY).toContain('60 到 150 字');
    // 别把画风词/采样参数教给模型:那两项由 DSH 侧的配置集负责
    expect(DSH_WORLDBOOK_ENTRY).toContain('画风词');
    expect(DSH_WORLDBOOK_ENTRY).toContain('采样参数');
    // 一轮只画一帧:第二条占位在插件侧没有落点,只会把第一条挤成一张空图
    expect(DSH_WORLDBOOK_ENTRY).toContain('一次回复最多一条');
    // 位置决定图落在哪:锚点在 tag 所在的行内位置,攒到最后 = 图只能挂全文末尾
    expect(DSH_WORLDBOOK_ENTRY).toContain('插在它描述的那一段正文之后');
    expect(DSH_WORLDBOOK_ENTRY).not.toContain('最末尾');
    // 示例本身要演示「占位后面还有正文」,否则模型学到的仍然是压尾写法
    const closing = DSH_WORLDBOOK_ENTRY.lastIndexOf('</bbi_image>');
    expect(DSH_WORLDBOOK_ENTRY.slice(closing)).toMatch(/她推门进去/);
  });

  it('世界书正文是原样拼进提示词的,不能带 markdown 装饰', () => {
    expect(DSH_WORLDBOOK_ENTRY).not.toMatch(/\*\*|\u0060\u0060\u0060|#{1,6} /m);
  });

  it('里面的每一条占位样例都能被本仓库的解析口径读回来', () => {
    const samples = DSH_WORLDBOOK_ENTRY.match(/<bbi_image>[\s\S]+?<\/bbi_image>/gi) ?? [];
    expect(samples.length).toBeGreaterThan(0);
    for (const sample of samples) {
      const content = parseImageTagContent(sample);
      expect(isDshPlaceholder(content)).toBe(true);
      expect(['portrait', 'landscape']).toContain(content.size);
      // <dsh> 里再出现子标签会让非贪婪的查找正则提前截断,正文漏进 DOM
      expect(containsTagMarkup(content.dsh ?? '')).toBe(false);
    }
  });
});
