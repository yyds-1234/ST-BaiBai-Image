import { describe, expect, it } from 'vitest';

import worldbook from '../../docs/worldbook/01-柏宝绘-DSH画面占位.json';
import {
  buildDshPlaceholder,
  composeDshPlaceholderSpec,
  DEFAULT_DSH_PLACEHOLDER_SPEC,
  describeDshPlaceholder,
  DSH_PART_LABELS,
  DSH_WORLDBOOK_ENTRY,
  dshPartsOf,
  dshSceneForBridge,
  dshSceneOf,
  dshWorldbookOf,
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

  it('跨行写进 <dsh> 的内容保留行结构（v2.1 的三行是格式的一部分）', () => {
    // v1.0 时这里折叠成单行（「提示词里换行没有意义」）；v2.1 起 dsh 固定三行
    // （人物名称 / 人物服装 / 场景描述），行就是信息本身，折叠会把三段糊成一句。
    expect(parseImageTagContent('<bbi_image><dsh>人物名称：林夏\n人物服装：长风衣\n场景描述：天台回头</dsh></bbi_image>').dsh).toBe(
      '人物名称：林夏\n人物服装：长风衣\n场景描述：天台回头',
    );
    // 行首行尾的空白与空行仍然被清掉：模型常把缩进和空行带进来
    expect(parseImageTagContent('<bbi_image><dsh>\n  第一句  \n\n 第二句\n</dsh></bbi_image>').dsh).toBe('第一句\n第二句');
    // CRLF 归一成 LF：Windows 侧手写的占位不能把 \r 带进成品串
    expect(parseImageTagContent('<bbi_image><dsh>第一句\r\n第二句</dsh></bbi_image>').dsh).toBe('第一句\n第二句');
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

  it('三行 dsh 序列化再解析回来一字不差（换行是内容，不能被折掉）', () => {
    const three = '人物名称：林夏\n人物服装：米色长风衣\n场景描述：傍晚的天台，她侧身回头';
    const raw = serializeImageTag({
      tag: '',
      dsh: three,
      nl: '',
      negative: '',
      characters: [],
      size: 'portrait',
    });
    expect(raw).toContain(`<dsh>${three}</dsh>`);
    expect(parseImageTagContent(raw).dsh).toBe(three);
  });

  it('buildDshPlaceholder 产出的串能原样解析回来（读写只有一份口径）', () => {    const raw = buildDshPlaceholder('深夜的书房，她趴在桌上睡着了，台灯从左侧打过来', 'landscape');
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

describe('三行占位（v2.1）：人物名称 / 人物服装 / 场景描述', () => {
  const THREE = '人物名称：林夏、店主\n人物服装：林夏：米色长风衣、黑伞；店主：白围裙\n场景描述：深夜的便利店门口，她侧身回头，冷白灯从右侧打来，中景';

  it('三行齐全时拆出三段，并按协议顺序认标签（不靠行号）', () => {
    expect(dshPartsOf(THREE)).toEqual({
      names: '林夏、店主',
      outfit: '林夏：米色长风衣、黑伞；店主：白围裙',
      scene: '深夜的便利店门口，她侧身回头，冷白灯从右侧打来，中景',
      complete: true,
    });
  });

  it('行被折成一行、半角冒号、标签后多个空格都能认', () => {
    const folded = '人物名称: 林夏 人物服装: 米色长风衣 场景描述: 雨后的便利店门口，她侧身回头';
    expect(dshPartsOf(folded)).toMatchObject({ names: '林夏', outfit: '米色长风衣', complete: true });
  });

  it('顺序写歪了也按标签归位：靠标签切，不靠第几行', () => {
    const swapped = '场景描述：她在窗边回头 人物名称：林夏 人物服装：校服';
    expect(dshPartsOf(swapped)).toMatchObject({
      names: '林夏',
      outfit: '校服',
      scene: '她在窗边回头',
      complete: true,
    });
  });

  it('同一标签重复出现取第一次（场景描述里顺手写的「人物服装：…」不能覆盖前面的真信息）', () => {
    const dup = '人物名称：林夏\n人物服装：米色长风衣\n场景描述：她抬手拢头发，人物服装：湿透的裙摆';
    expect(dshPartsOf(dup).outfit).toBe('米色长风衣');
    expect(dshPartsOf(dup).scene).toContain('湿透的裙摆');
  });

  it('缺一行 → complete=false，但已有的段仍然读得到（不是错误，只是回落原样发）', () => {
    const partial = dshPartsOf('人物名称：林夏\n场景描述：她在窗边回头');
    expect(partial).toMatchObject({ names: '林夏', outfit: '', complete: false });
  });

  it('旧的一段散文占位读不出标签：complete=false，整段原样返回', () => {
    const legacy = '傍晚的天台，林夏靠着栏杆回头，逆光把发梢照透';
    expect(dshPartsOf(legacy)).toEqual({ names: '', outfit: '', scene: '', complete: false });
    expect(dshSceneForBridge(legacy)).toBe(legacy);
  });

  it('三行齐全时拉直成协议顺序与全角标签（DSH 侧拿到的永远是同一种形状）', () => {
    const messy = '场景描述: 她在窗边回头\n人物名称: 林夏\n人物服装: 校服';
    expect(dshSceneForBridge(messy)).toBe('人物名称：林夏\n人物服装：校服\n场景描述：她在窗边回头');
    // 空串 → 空串（调用方据此回落到 prompt，不要把空串当占位）
    expect(dshSceneForBridge('   ')).toBe('');
  });

  it('三行者一起进桥接的 scene 字段：一段都不丢', () => {
    const scene = dshSceneForBridge(THREE);
    for (const label of DSH_PART_LABELS) expect(scene).toContain(`${label}：`);
    expect(scene.split('\n')).toHaveLength(3);
  });

  it('卡片副标题把名字带出来（缺人名最难在卡片上发现）', () => {
    expect(describeDshPlaceholder(THREE)).toBe(`DSH 写手 · 林夏、店主 · ${THREE.length} 字画面描述`);
    // 空镜不占副标题
    const empty = '人物名称：无\n人物服装：未着衣物\n场景描述：雨后的空巷，积水反光，中景';
    expect(describeDshPlaceholder(empty)).toBe(`DSH 写手 · ${empty.length} 字画面描述`);
    // 旧散文占位保持原口径
    expect(describeDshPlaceholder('她在窗边回头')).toBe('DSH 写手 · 6 字画面描述');
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
  it('是一段可直接粘贴的成品文本：含格式、三行、长度与禁用清单', () => {
    expect(DSH_WORLDBOOK_ENTRY).toContain('<bbi_image><dsh>');
    expect(DSH_WORLDBOOK_ENTRY).toContain('<size>portrait</size>');
    // 三行是 v2.1 起的承重墙：名字 / 衣服 / 场景必须各占一行、各带标签
    for (const label of DSH_PART_LABELS) expect(DSH_WORLDBOOK_ENTRY).toContain(`${label}：`);
    // 场景描述只要求「在哪、在做什么」，光/景别/机位是可选项 —— 世界书是弱约束，
    // 条目越细模型越会挑着执行，所以别再往这里加四要素清单。
    for (const element of ['在哪', '在做什么', '光从哪来']) {
      expect(DSH_WORLDBOOK_ENTRY).toContain(element);
    }
    expect(DSH_WORLDBOOK_ENTRY).toContain('一句话就够');
    // v2.2：场景描述写的是「人物正在做什么」，不是定格的一帧 ——
    // 写成摆拍姿势清单，画师画出来的是一尊姿势，人和正文的动势对不上。
    expect(DSH_WORLDBOOK_ENTRY).toContain('正在做什么');
    expect(DSH_WORLDBOOK_ENTRY).toContain('动作本身');
    expect(DSH_WORLDBOOK_ENTRY).toContain('摆好姿势');
    expect(DSH_WORLDBOOK_ENTRY).not.toContain('能定格的单帧动作');
    expect(DSH_WORLDBOOK_ENTRY).not.toContain('只写这一帧');
    expect(DSH_WORLDBOOK_ENTRY).toContain('40 到 120 字');
    // 条目长度也是一条契约：世界书每轮都进提示词，长到两千字以上模型就开始漏项。
    expect(DSH_WORLDBOOK_ENTRY.length).toBeLessThan(1600);
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

  it('与可导入的世界书 JSON 逐字相同（面板复制的那份 = 用户导入的那份）', () => {
    // 这条比对只能放在测试里：docs/ 不进构建产物，运行时代码读不到它。
    // 唯一目的是让「改了一边忘了另一边」当场变成红的 —— 两份漂移的症状是
    // 老用户导入的书要求 A 写法、新复制的条目要求 B 写法，而两边都不会报错。
    expect(worldbook.entries['1'].content).toBe(DSH_WORLDBOOK_ENTRY);
    // 卡内精简版也必须带三行标签，否则「书很挤」的那种卡会继续写旧格式
    for (const label of DSH_PART_LABELS) expect(worldbook.entries['4'].content).toContain(`${label}：`);
  });

  it('世界书正文是原样拼进提示词的,不能带 markdown 装饰', () => {
    expect(DSH_WORLDBOOK_ENTRY).not.toMatch(/\*\*|\u0060\u0060\u0060|#{1,6} /m);
  });

  it('里面的每一条占位样例都能被本仓库的解析口径读回来（且三行齐全）', () => {
    const samples = DSH_WORLDBOOK_ENTRY.match(/<bbi_image>[\s\S]+?<\/bbi_image>/gi) ?? [];
    expect(samples.length).toBeGreaterThan(0);
    for (const sample of samples) {
      const content = parseImageTagContent(sample);
      expect(isDshPlaceholder(content)).toBe(true);
      expect(['portrait', 'landscape']).toContain(content.size);
      // <dsh> 里再出现子标签会让非贪婪的查找正则提前截断,正文漏进 DOM
      expect(containsTagMarkup(content.dsh ?? '')).toBe(false);
      // 示例必须演示三行格式：模型学的是例子，不是上面那段散文说明
      expect(dshPartsOf(content.dsh ?? '').complete).toBe(true);
    }
  });
});

describe('世界书正文可编辑（v2.2）', () => {
  // 面板「渠道 → DSH 写手 → 世界书条目」把这段正文存进 settings.dshBridge.worldbookEntry,
  // 空串 = 用内置。三条口径(面板 / 设置页 / 手动补写请求)都从这里取,
  // 所以「空串回落」只允许有一个解释。
  it('空串 / 纯空白 / 缺省 = 内置正文', () => {
    expect(dshWorldbookOf('')).toBe(DSH_WORLDBOOK_ENTRY);
    expect(dshWorldbookOf('   \n  ')).toBe(DSH_WORLDBOOK_ENTRY);
    expect(dshWorldbookOf(undefined)).toBe(DSH_WORLDBOOK_ENTRY);
  });

  it('自定义正文去首尾空白后原样生效', () => {
    expect(dshWorldbookOf('  我的协议\n第二行  ')).toBe('我的协议\n第二行');
  });

  it('委托单规范的内置默认跟着自定义正文走（不再嵌旧口径）', () => {
    const spec = composeDshPlaceholderSpec('我的协议');
    expect(spec).toContain('我的协议');
    // 只嵌一份:自定义那份生效时,内置那份不许再出现(否则同一组规则叠两层)
    expect(spec).not.toContain(DSH_WORLDBOOK_ENTRY);
    // 没自定义时回到内置正文,且与常量逐字一致
    expect(composeDshPlaceholderSpec('')).toContain(DSH_WORLDBOOK_ENTRY);
    expect(DEFAULT_DSH_PLACEHOLDER_SPEC).toBe(composeDshPlaceholderSpec(DSH_WORLDBOOK_ENTRY));
  });
});
