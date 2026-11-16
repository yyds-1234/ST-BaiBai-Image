import { describe, expect, it } from 'vitest';

import {
  autoTagProfile,
  buildAutoTagMessages,
  buildDshPlaceholderMessages,
  dedupeProtocolFromWorldInfo,
  expandNlSections,
} from '@/autoTag/prompt';
import { DEFAULT_DSH_PLACEHOLDER_SPEC, DSH_WORLDBOOK_ENTRY } from '@/autoTag/dshPlaceholder';
import {
  activeComfyPreset,
  DEFAULT_COMFY_THINKING,
  DEFAULT_MOSS_ANIME_THINKING,
  DEFAULT_MOSS_THINKING,
  DEFAULT_NAI_V5_SPEC,
  DEFAULT_NAI_V5_THINKING,
  settings,
  type AutoTagPrompts,
  type AutoTagSettings,
} from '@/state/settings';
import type { STContext } from '@/st/context';

/**
 * 提示词集:全部留空(= 回落内置默认),只把本用例关心的那几项覆盖掉。
 * 收在一处是因为 AutoTagPrompts 每加一个键,散落的字面量会同时 typecheck 失败。
 */
function prompts(overrides: Partial<AutoTagPrompts> = {}): AutoTagPrompts {
  return {
    jailbreak: '',
    naiSpec: '',
    naiV5Spec: '',
    comfySpec: '',
    comfyThinking: '',
    naiThinking: '',
    naiV5Thinking: '',
    mossSpec: '',
    mossThinking: '',
    mossAnimeSpec: '',
    mossAnimeThinking: '',
    dshSpec: '',
    ...overrides,
  };
}

/** 完整 AutoTagSettings(只关心 prompts 的用例用它,少写四个不可省字段)。 */
function mossOptions(overrides: Partial<AutoTagSettings> = {}): AutoTagSettings {
  return {
    enabled: true,
    contextMessages: 2,
    minImages: 0,
    maxImages: 2,
    retryCount: 1,
    autoGenerate: true,
    prompts: prompts(),
    ...overrides,
  };
}

function context(): STContext {
  return {
    chat: [
      { name: 'User', is_user: true, is_system: false, mes: '上一层' },
      { name: 'Char', is_user: false, is_system: false, mes: '目标第一行\n\n目标第三行' },
    ],
    chatMetadata: {},
    name1: 'User',
    name2: 'Char',
    getCurrentChatId: () => 'chat-a',
    getRequestHeaders: () => ({}),
    saveMetadataDebounced: () => undefined,
    saveChat: async () => undefined,
    eventSource: { on: () => undefined },
    eventTypes: {
      USER_MESSAGE_RENDERED: 'user',
      CHARACTER_MESSAGE_RENDERED: 'character',
      MESSAGE_SENT: 'sent',
      GENERATION_STARTED: 'started',
      GENERATION_ENDED: 'ended',
      CHAT_CHANGED: 'changed',
      MESSAGE_EDITED: 'edited',
      MESSAGE_UPDATED: 'updated',
      MESSAGE_SWIPED: 'swiped',
      MESSAGE_DELETED: 'deleted',
    },
  };
}

describe('auto tag prompt', () => {
  it('marks only clean target paragraphs without pulling user messages before the earliest selected AI floor', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 3,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts({ jailbreak: '附加规则' }),
    };
    const messages = await buildAutoTagMessages(context(), 1, options, null);

    expect(messages[0].content).toContain('附加规则');
    expect(messages.some(m => m.role === 'system' && m.content.includes('你是严谨的剧情画面规划与生图提示词编写员'))).toBe(true);
    expect(messages.some(m => m.content.includes('除一个 <thinking> 块和一个 JSON 对象外'))).toBe(true);
    expect(messages.some(m => m.content.includes('最终结果必须包含且只能包含一个可解析的 JSON 对象'))).toBe(true);
    expect(messages.some(m => m.content.includes('images 数量必须在 0～3 之间'))).toBe(true);
    expect(messages.some(m => m.content.includes('没有值得绘制的可见瞬间时可以返回空数组'))).toBe(true);
    expect(messages.some(m => m.content.includes('不得包含质量词'))).toBe(true);
    expect(messages.some(m => m.content.includes('先完成角色建档与变化检查'))).toBe(true);
    expect(messages.some(m => m.content.includes('同一事件的相邻动作'))).toBe(true);
    expect(messages.some(m => m.content.includes('两人同框不等于必须横屏'))).toBe(true);
    expect(messages.some(m => m.content.includes('"field":"new"'))).toBe(true);
    expect(messages.some(m => m.content.includes('"hair":"long black hair","eyes":"blue eyes"'))).toBe(true);
    expect(messages.some(m => m.content.includes('首次出场就必须建档'))).toBe(true);
    expect(messages.some(m => m.content.includes('角色卡、世界书、柏宝书或持续剧情'))).toBe(true);
    expect(messages.some(m => m.content.includes('hair 与 eyes 必填'))).toBe(true);
    expect(messages.some(m => m.content.includes('"position":"P2"'))).toBe(true);
    expect(messages.some(m => m.content.includes('后续不得重新随机'))).toBe(true);
    // 建档不受入选与否影响,也不受位置门控 —— 这两条是修复的核心,措辞必须在协议里
    expect(messages.some(m => m.content.includes('不论他是否入选本次图片'))).toBe(true);
    expect(messages.some(m => m.content.includes('建档在本楼全程有效'))).toBe(true);
    // 已撤销的 characters 审计:不得回流到协议里
    expect(messages.some(m => m.content.includes('characters'))).toBe(false);
    expect(messages.some(m => m.content.includes('"tag":"@小雪'))).toBe(false);
    const user = messages[messages.length - 1];
    expect(user.role).toBe('user');
    expect(user.content).toContain('【角色固定外貌库】[system-maintained; currently empty]');
    expect(user.content).toContain('当前为空，没有任何角色已建档');
    expect(user.content).not.toContain('上一层');
    expect(user.content).toContain('目标第一行 ⟦P1⟧\n\n目标第三行 ⟦P2⟧');
    expect(user.content).not.toContain('[L0001]');
    expect(messages.some(message => message.content.includes('"position"'))).toBe(true);
  });

  it('turns a positive minimum into a strict image-count range', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 2,
      maxImages: 4,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const messages = await buildAutoTagMessages(context(), 1, options, null);

    expect(messages.some(m => m.content.includes('images 数量必须在 2～4 之间'))).toBe(true);
    expect(messages.some(m => m.content.includes('下限 2 是用户明确要求'))).toBe(true);
    expect(messages.some(m => m.content.includes('不得返回少于 2 张或空数组'))).toBe(true);
  });

  it('uses the prepared target snapshot without recomputing position IDs', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const messages = await buildAutoTagMessages(
      context(),
      1,
      options,
      null,
      {
        promptText: '请求开始时的正文快照 ⟦P9⟧',
        segments: [{ id: 'P9', sourceLine: 7, text: '请求开始时的正文快照' }],
      },
    );
    const user = messages[messages.length - 1];

    expect(user.content).toContain('请求开始时的正文快照 ⟦P9⟧');
    expect(user.content).not.toContain('目标第一行 ⟦P1⟧');
  });

  it('counts context by AI floors, keeps interleaved user floors, and preserves prior image tags', async () => {
    const ctx = context();
    ctx.chat = [
      { name: 'User', is_user: true, is_system: false, mes: '更早用户楼' },
      {
        name: 'Char',
        is_user: false,
        is_system: false,
        mes: `<think>隐藏思维</think>
<bbs_start>上午</bbs_start>
上一个 AI 楼
<snow>状态栏</snow>
<bbi_image>1girl, long silver hair, red eyes<size>portrait</size></bbi_image>
<bbs_end>中午</bbs_end>
尾部状态`,
      },
      { name: 'User', is_user: true, is_system: false, mes: '中间用户楼' },
      { name: 'Char', is_user: false, is_system: false, mes: '当前目标楼' },
    ];
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };

    const oldTags = [...settings.excludes.customStripTags];
    const messages = await (async () => {
      settings.excludes.customStripTags = ['snow'];
      try {
        return await buildAutoTagMessages(ctx, 3, options, null);
      } finally {
        settings.excludes.customStripTags = oldTags;
      }
    })();
    const user = messages[messages.length - 1];
    expect(user.content).not.toContain('更早用户楼');
    expect(user.content).toContain('上一个 AI 楼');
    expect(user.content).toContain('<bbi_image>1girl, long silver hair, red eyes<size>portrait</size></bbi_image>');
    expect(user.content).toContain('中间用户楼');
    expect(user.content).not.toContain('隐藏思维');
    expect(user.content).not.toContain('状态栏');
    expect(user.content).not.toContain('尾部状态');
    expect(user.content).not.toContain('上下文楼层');
    expect(user.content).toContain('当前目标楼 ⟦P1⟧');
    expect(user.content).not.toContain('上一个 AI 楼 ⟦P');
  });

  it('attaches the built-in thinking checklist by default', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const messages = await buildAutoTagMessages(context(), 1, options, null);

    const thinkingMsg = messages.find(m => m.content.includes('输出前思考清单'));
    expect(thinkingMsg?.role).toBe('system');

    // 两层结构:A~E 是整楼一次的全局判断,第二层是逐图槽位块。
    // 结构骨架比逐字文案更值得钉——散装 bullet 正是模型把每图压成一句话的原因。
    expect(thinkingMsg?.content).toContain('第一层｜全局判断（整楼各做一次）');
    expect(thinkingMsg?.content).toContain('第二层｜逐张图槽位块');
    expect(thinkingMsg?.content).toContain('不得合并、不得跨图共用一份');
    expect(thinkingMsg?.content).toContain('第三层｜落笔前自查');
    for (const slot of ['人物：', '核心动作：', '景别：', '场景：', '环境光：', 'size：']) {
      expect(thinkingMsg?.content).toContain(slot);
    }
    expect(thinkingMsg?.content).toContain('<角色名>｜表情｜视线｜本镜头可见服装｜临时状态｜个人动作');
    expect(thinkingMsg?.content).toContain('确实不适用的槽位写 "-"');
    expect(thinkingMsg?.content).toContain('核心动作、景别、表情、视线、场景、环境光、size 七项永远不得为 "-"');
    // 表情/视线此前全库没有槽位,是「木脸」的根因;两个后端规范也要各带一份。
    expect(thinkingMsg?.content).toContain('两项都不得留空，面无表情也要主动填 expressionless');
    expect(thinkingMsg?.content).toContain('表情与视线填后端规范给出的标准 danbooru 词');
    expect(thinkingMsg?.content).toContain('没有漏掉表情、视线或环境光');
    // 不再发送 assistant 预填充,消息以 user 任务消息收尾。
    expect(thinkingMsg?.content).toContain('不得开启第二个 <thinking> 块');

    // 以下是重写前就必须守住的既有约束,逐条确认没有在重构中丢失。
    expect(thinkingMsg?.content).toContain('不得把临时状态恢复成角色默认值');
    expect(thinkingMsg?.content).toContain('即使 images 为空也不能跳过这一步');
    expect(thinkingMsg?.content).toContain('视觉明确度、剧情重要度、动作完整度');
    expect(thinkingMsg?.content).toContain('下限大于 0 时从较次但仍可见的候选中补足');
    expect(thinkingMsg?.content).toContain('一次快门完整拍下');
    // size 判定口径瘦身后只留在后端规范一份(thinking 与协议都不再复述),
    // 但整套消息里必须仍有且有这一份,否则模型无从判断横竖。
    expect(messages.some(m => m.content.includes('双人近距离构图可写 portrait'))).toBe(true);
    expect(thinkingMsg?.content).not.toContain('双人近距离可 portrait');
    expect(thinkingMsg?.content).toContain('只跳过没有视觉变化的对话');
    expect(thinkingMsg?.content).toContain('首次出场就建档');
    expect(thinkingMsg?.content).toContain('不论他是否入选本次图片');
    expect(thinkingMsg?.content).toContain('建档在本楼全程有效');
    // 建档的 hair 必须带长度/发型:只写颜色的旧措辞会让模型以 black hair 过关。
    expect(thinkingMsg?.content).toContain('hair 必须同时带发色和长度/发型');
    expect(thinkingMsg?.content).not.toContain('hair 与 eyes 都不得留空');
    // 白皙肤色词禁令(ComfyUI 默认肤色已够白,叠 pale skin 会白得失真):
    // 规范给禁令,思维链第三层给落笔前的检查位;tan/dark skin 是豁免项。
    expect(messages.some(m => m.content.includes('白皙词一律禁止'))).toBe(true);
    expect(thinkingMsg?.content).toContain('白皙肤色词混进任何一张图');
    expect(thinkingMsg?.content).toContain('tan、dark skin 不在此列');
    // 建档字段的详细写法瘦身后只留在任务协议一份,thinking 不再复述。
    expect(messages.some(m => m.content.includes('建档写法：{"name":"角色名","field":"new"'))).toBe(true);
    // 新旧档案的 position 语义、时代判断的发挥边界:瘦身后各自只留一份权威副本
    // (分别在任务协议与后端规范),thinking 不再复述,但整套消息里必须仍在。
    expect(messages.some(m => m.content.includes('该位置之前的图片使用旧档案'))).toBe(true);
    expect(messages.some(m => m.content.includes('证据较少时可以合理补全时代风格'))).toBe(true);
    expect(thinkingMsg?.content).toContain('不得退回中性服装或默认现代都市');
    expect(thinkingMsg?.content).toContain('把未知的场景事实具体化');
    // 泥地/地形禁令原本 3 份(规范 + 槽位 + 自查),瘦身后规范留完整版、
    // thinking 只留一句「没依据就别写」。outdoors/forest 的具体口径归规范。
    expect(messages.some(m => m.content.includes('只确定“森林”时写 forest 即可'))).toBe(true);
    expect(messages.some(m => m.content.includes('不得为了丰富画面自行添加泥地、土路'))).toBe(true);
    expect(thinkingMsg?.content).toContain('没依据就别写');
    expect(thinkingMsg?.content).toContain('没依据就删除');
    expect(thinkingMsg?.content).toContain('只有名字实际列在【角色固定外貌库】区块中的才算已建档');
    expect(thinkingMsg?.content).toContain('按正文 P 位置维护每个角色的临时服装');
    expect(thinkingMsg?.content).toContain('视觉指纹');
    expect(thinkingMsg?.content).toContain('版型/剪裁 + 主色 + 关键部件');
    expect(thinkingMsg?.content).toContain('裤袜含颜色与透明度');
    expect(thinkingMsg?.content).toContain('模型会自行重新设计的孤立词');
    // 槽位侧同样要挡住笼统词,否则 C 段定了 navy school blazer、槽位里仍退回 school uniform。
    expect(thinkingMsg?.content).toContain('槽位里不许退回 school uniform、dress、pantyhose 这种笼统孤立词');
    expect(thinkingMsg?.content).toContain('多人画面每人的服装各写各的');
    // 自查项要点名服装,上一版只提「表情视线」,模型自查时就只核对了表情视线。
    expect(thinkingMsg?.content).toContain('没有谁的衣服只写在槽位里却没进 tag');
    // 配角只写「弯腰换鞋」不写表情词 → tag 里他没有表情。角色行必须逐人写全英文词。
    expect(thinkingMsg?.content).toContain('配角也要写全');
    expect(thinkingMsg?.content).toContain('这一行没有表情词');
    expect(thinkingMsg?.content).toContain('每个在场角色都各有一个绑定到自己的表情词和视线词');
    // 超限重选必须发生在 E 段,不能等到第三层「让位」——那几块槽位是白写的。
    expect(thinkingMsg?.content).toContain('写出 P 列表之前先数一遍');
    expect(thinkingMsg?.content).toContain('这一层只核对、不改决定');
    expect(messages.some(m => m.content.includes('navy school blazer, white collared shirt, red ribbon'))).toBe(true);
    expect(thinkingMsg?.content).toContain('镜头外不可见的部件可以省略，但省略不等于脱掉');
    expect(thinkingMsg?.content).toContain('没有散落的无主特征');
    expect(messages.some(m => m.content.includes('每个在场正式角色必须二选一'))).toBe(true);
    expect(messages.some(m => m.content.includes('禁止把两人的外貌特征散放成无法归属的一串公共 tag'))).toBe(true);
    expect(thinkingMsg?.content).toContain('定一套具体、自洽的时代/文明/视觉体系并全楼沿用');
    expect(messages.some(m => m.content.includes('必须先判断，并主动具体化'))).toBe(true);
    expect(messages.some(m => m.content.includes('具体不等于编造'))).toBe(true);
    expect(messages.some(m => m.content.includes('不得为了丰富画面自行添加泥地、土路'))).toBe(true);
    expect(messages.some(m => m.content.includes('允许为了完成画面作合理猜测'))).toBe(false);
    const last = messages[messages.length - 1];
    expect(last.role).toBe('user');
    expect(last.content).toContain('目标正文');
  });

  it('uses custom thinking when provided', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts({ comfyThinking: '自定义清单' }),
    };
    const messages = await buildAutoTagMessages(context(), 1, options, null);

    expect(messages.some(m => m.content.includes('自定义清单'))).toBe(true);
    expect(messages.some(m => m.content.includes('输出前思考清单'))).toBe(false);
    // 预填充功能已移除:消息里不应再出现 assistant 角色。
    expect(messages.some(m => m.role === 'assistant')).toBe(false);
  });

  // 思维链按后端各存一份。改 ComfyUI 那份不能影响 NAI——共用一份正是 V5 被要求填
  // 「景别/环境光/邻接绑定」这类它的规范从未教过的字段的根因。
  it('picks the thinking checklist per backend and never crosses them over', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts({
        comfyThinking: 'COMFY-CHECKLIST',
        naiThinking: 'NAI-CHECKLIST',
        naiV5Thinking: 'NAIV5-CHECKLIST',
      }),
    };
    const oldBackend = settings.defaultBackend;
    const oldModel = settings.nai.model;
    try {
      const cases = [
        { backend: 'comfyui', model: oldModel, want: 'COMFY-CHECKLIST' },
        // 单串分支的代表换成原版 NAI4:4.5 起走 Character Prompts 分支(自然语言是 4.5 引入的)
        // ⚠ NAI4 已从 NAI_MODELS 撤下(设置页选不到了),但 prompt.ts 的单串分支与
        // naiSpec/naiThinking 两个键都还在,故这条继续按字符串锁住分支归属。
        { backend: 'nai', model: 'nai-diffusion-4-full', want: 'NAI-CHECKLIST' },
        { backend: 'nai', model: 'nai-diffusion-4-5-full', want: 'NAIV5-CHECKLIST' },
        { backend: 'nai', model: 'nai-diffusion-5-full', want: 'NAIV5-CHECKLIST' },
      ] as const;
      const all = ['COMFY-CHECKLIST', 'NAI-CHECKLIST', 'NAIV5-CHECKLIST'];
      for (const { backend, model, want } of cases) {
        settings.defaultBackend = backend;
        settings.nai.model = model;
        const messages = await buildAutoTagMessages(context(), 1, options, null);
        const text = messages.map(m => m.content).join('\n');
        for (const marker of all) {
          expect([backend, model, marker, text.includes(marker)]).toEqual([
            backend,
            model,
            marker,
            marker === want,
          ]);
        }
      }
    } finally {
      settings.defaultBackend = oldBackend;
      settings.nai.model = oldModel;
    }
  });

  // 身份 tag 与 NSFW 的思维链落点:0.1.16 的旧清单本来有(身份 tag 定词+自查 / NAI 专属
  // NSFW 条款+自查),三层重写时三份全丢——规则只在 spec 里、思考回路没有检查位,
  // 漏写概率回升。这条钉死三份各自的落点口径,且 NSFW 不带年龄限定。
  it('keeps fandom identity and NSFW checkpoints inside each backend thinking', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const oldBackend = settings.defaultBackend;
    const oldModel = settings.nai.model;
    try {
      // ComfyUI:身份 tag 定词 + 括号转义提醒 + negative 条件自查(只有 Comfy 工作流会有
      // negative 键);Comfy spec 无 NSFW 条款,思维链也不加。
      settings.defaultBackend = 'comfyui';
      let text = (await buildAutoTagMessages(context(), 1, options, null))
        .map(m => m.content)
        .join('\n');
      expect(text).toContain('判定为同人时同一行定出最终身份 tag 词');
      expect(text).toContain(
        '每个同人角色的 tag 串里都有 B 段定下的 character name \\(copyright name\\) 身份 tag',
      );
      expect(text).toContain('若本图协议含 negative 键');
      expect(text).not.toContain('若本图是显式 NSFW 场景');
      // spec 的转义指导必须原样到达模型:模板字符串里 \( 会被烹饪成 (,
      // 0.1.16 起这条实际发给模型的就是未转义括号,一直是坏的。
      expect(text).toContain('实际提示词形态为 character name \\(copyright name\\)');
      expect(text).toContain('"character name \\\\(copyright name\\\\)"');
      expect(text).not.toContain('形态为 character name (copyright name)');
      // 白皙肤色词禁令只给 ComfyUI:本地模型默认肤色已够白,再叠 pale skin 会白得失真。
      expect(text).toContain('白皙词一律禁止');
      expect(text).toContain('白皙肤色词混进任何一张图');

      // NAI 4 系:身份 tag 不转义 + 显式 NSFW 解剖落点(从有变无的回归,此处补回)。
      // 负面词由后端按模型固定附加,AI 不写 negative——不该有 negative 条件自查。
      settings.defaultBackend = 'nai';
      settings.nai.model = 'nai-diffusion-4-5-full';
      text = (await buildAutoTagMessages(context(), 1, options, null))
        .map(m => m.content)
        .join('\n');
      expect(text).toContain('判定为同人时同一行定出最终身份 tag 词');
      expect(text).toContain('不转义圆括号');
      expect(text).toContain('若正文明确为显式 NSFW 场景');
      expect(text).toContain('若本图是显式 NSFW 场景');
      expect(text).not.toContain('若本图协议含 negative 键');
      // 注:此处原有一条 not.toContain('成年人'),自 002ad75 起一直红着。
      // 它想证明「NAI 不给成人条款」,但「成年人」只出现在 DEFAULT_JAILBREAK_PROMPT
      // (每次请求无条件拼在最前的破限词)里,和规范/思维链无关,断言必然失败。
      // 真正的判据是上面两条(要 NSFW 检查点、不要 negative 条件自查),此处不再重复。
      // NAI 侧用户没有白痘问题,不引入这条禁令。
      expect(text).not.toContain('白皙肤色词');
      expect(text).not.toContain('白皙词一律禁止');

      // NAI V5:身份 tag 落点是 characters[].tag 首位;NSFW 按 Base/角色块分工;
      // contentRule 明令禁止 negative tags,不该有 negative 条件自查。
      settings.nai.model = 'nai-diffusion-5-full';
      text = (await buildAutoTagMessages(context(), 1, options, null))
        .map(m => m.content)
        .join('\n');
      expect(text).toContain('身份 tag 必须写进档案');
      expect(text).toContain('每个同人角色的身份 tag 都逐字照抄自档案 fandom 字段');
      expect(text).toContain('若正文明确为显式 NSFW 场景');
      expect(text).toContain('若本图是显式 NSFW 场景');
      expect(text).not.toContain('若本图协议含 negative 键');
      expect(text).not.toContain('白皙肤色词');
    } finally {
      settings.defaultBackend = oldBackend;
      settings.nai.model = oldModel;
    }
  });

  // NAI V5 用 Base + characters[] 隔离每个人,其规范第 8 条明令禁止 ComfyUI 的邻接绑定。
  // 旧版三后端共用一份思维链时,V5 被要求做规范禁止的事——这条钉死不再回流。
  it('gives NAI V5 a Base/character slot block with no adjacency-binding wording', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const oldBackend = settings.defaultBackend;
    const oldModel = settings.nai.model;
    try {
      settings.defaultBackend = 'nai';
      settings.nai.model = 'nai-diffusion-5-full';
      const messages = await buildAutoTagMessages(context(), 1, options, null);
      const text = messages.map(m => m.content).join('\n');

      // 邻接绑定的每种措辞都不得出现在 V5 路径上。
      for (const banned of [
        '落 tag 时各自绑定',
        'on silver hair girl',
        'on green hair girl',
        '没主人的笼统孤立词',
        '人物：<人数 tag',
        '区分性称谓邻接绑定',
      ]) {
        expect([banned, text.includes(banned)]).toEqual([banned, false]);
      }

      // 取而代之的是 Base 块 + 每角色块。
      expect(text).toContain('■ P<编号>｜Base');
      expect(text).toContain('■ P<编号>｜<角色名或正文指称>');
      // 角色块按取景框、不按档案:块名允许正文指称,固定外貌槽给【一次性】留了合法填法。
      // 旧口径「照抄库中/刚建档的字段」是唯一来源,无名角色在这个槽位上无路可走——
      // 于是模型宁可放弃画面(见「无名角色入画」问题文档),这条钉死不再回流。
      expect(text).toContain('【一次性】角色用正文的指称原词作块名');
      expect(text).toContain('【一次性】按世界观一次性补全');
      expect(text).toContain('不要用邻接绑定');
      expect(text).toContain('Base 块与角色块的分工是硬边界');
      expect(text).toContain('落 JSON 时进他自己的 characters[].tag');
      // 单人画面没有多人互动:核心互动槽写 "-",唯一角色的动作进他角色块的个人动作——
      // 旧口径让单人接触点写进 Base 槽,与「个人动作只进角色块」的分工规则直接打架。
      expect(text).toContain('单人画面本槽写 "-"');
      expect(text).not.toContain('单人画面写该角色与场景/道具的接触点');
      // 第三层逐槽点名核对:实跑里模型把环境光丢了、自查却声称「覆盖了全部槽位」。
      // 点名清单必须含多人画面的核心互动——只在单人画面才允许 "-" 跳过。
      expect(text).toContain('逐槽核对过');
      expect(text).toContain('环境光不许漏');
      expect(text).toContain('多人画面的核心互动');
      // 服装视觉指纹与协议形态无关,三份思维链都要保住。
      expect(text).toContain('槽位里不许退回 school uniform、dress、pantyhose 这种笼统孤立词');
    } finally {
      settings.defaultBackend = oldBackend;
      settings.nai.model = oldModel;
    }
  });

  // 建档资格 ≠ 入画资格。实跑里模型把「一次性无名路人不建档」读成「无名者不能入画」,
  // 于是放弃了全文最强的戏剧瞬间(核心互动的另一方是个无名对手),转而挑了个能把他
  // 裁出镜头的景别。根因是造名单的谓词写错了:第一层 B 只清点「有名有姓」,那人从未
  // 上册,下游规则根本看不见他。三处必须同时成立,缺一处他就会在某一环被判死刑。
  it('lets unprofiled characters enter the frame on the NAI V5 path', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const oldBackend = settings.defaultBackend;
    const oldModel = settings.nai.model;
    try {
      settings.defaultBackend = 'nai';
      settings.nai.model = 'nai-diffusion-5-full';
      const messages = await buildAutoTagMessages(context(), 1, options, null);
      const text = messages.map(m => m.content).join('\n');

      // ① 第一层 B 清点「谁在场」而不是「谁有档案」,并逐人标出三类身份。
      expect(text).toContain('逐个列出实际在场的**全部**角色');
      expect(text).toContain('清点的是「谁在场」，不是「谁有档案」');
      expect(text).toContain('【一次性】');
      expect(text).not.toContain('逐个列出实际在场且有名有姓的角色');

      // ② 二选一 → 三选一。只改名单不改自查,那人会以合法身份上册、却在最后一关被
      // 自己判死刑(「每个在场正式角色必须二选一」他两条都占不上)。
      expect(text).toContain('每个在场角色都能三选一');
      expect(text).not.toContain('每个在场正式角色都能二选一');

      // 缺档不能否决核心互动;排除无关在场者仍是合法取景。
      expect(text).toContain('建档资格与入画资格是两回事');
      expect(text).toContain('不得仅因缺档案放弃画面、改选瞬间或裁掉他');

      // 个体/人群只决定入画后的落位,不决定是否值得入画。
      expect(text).toContain('拿不准是个体还是一团时按一团处理');
      expect(text).toContain('People the story treats as a mass rather than as individuals');
      expect(text).toContain('leave them in Base');

      // 编人名是有毒的:name 会随 <characters> 落进正文,而 cleanHistoryText 保留
      // bbi_image,下一楼原样读回——一个假人名与真档案无法区分,会被误建档。
      expect(text).toContain('绝不为他编造人名');
      expect(text).toContain('Never invent a personal name for them');

      // Name consistency 原本是普世律,模型把「没有真名」读成「没有合法名」。
      // 它的全部目的是保护逐字匹配,而一次性角色不参与任何匹配,故必须限定作用域。
      expect(text).toContain('these rules govern characters who have a library entry');
      expect(text).toContain('participates in no matching at all');

      // 人数按取景框算;缺档不能成为裁掉核心互动参与者的理由。
      expect(text).toContain('number of people visible inside this frame');
      expect(text).toContain('a missing profile is never a reason to reject a moment or crop that participant out');

      // C 段连坐:名单放宽后,不排除【一次性】会让模型给一次性对手维护服装时间线——
      // 白烧 token,更糟的是强化「他是正经角色」的暗示,反过来诱发建档。
      expect(text).toContain('【一次性】角色不在本段占行');

      // 示例本身曾是反面教材:Base 写 2girls 却只给一条 Character Prompt,
      // 正好演示了「另一个人没有落位」。示例必须演示要求的行为。
      expect(text).toContain('三年级队长');
      expect(text).not.toContain('"tag":"2girls, classroom, sunset, medium shot"');
    } finally {
      settings.defaultBackend = oldBackend;
      settings.nai.model = oldModel;
    }
  });

  // 只验证规则装配;实际取景是否突出主要角色仍需用剧情实跑。
  it.each(['nai-diffusion-4-5-full', 'nai-diffusion-5-full'] as const)(
    'prioritizes principal characters without requiring every present person in frame (%s)',
    async model => {
      const options: AutoTagSettings = {
        enabled: true,
        contextMessages: 2,
        minImages: 0,
        maxImages: 2,
        retryCount: 1,
        autoGenerate: true,
        prompts: prompts(),
      };
      const oldBackend = settings.defaultBackend;
      const oldModel = settings.nai.model;
      try {
        settings.defaultBackend = 'nai';
        settings.nai.model = model;
        const messages = await buildAutoTagMessages(context(), 1, options, null);
        const contract = messages.find(m => m.content.startsWith('你是严谨的剧情画面规划'))!.content;
        const thinking = messages.find(m => m.content.startsWith('【输出前思考清单】'))!.content;
        const spec = messages.find(m => m.content.startsWith('[NovelAI'))!.content;
        const selection = thinking.split('E. 选段\n')[1].split('第二层｜')[0];

        expect(contract).toContain('优先表现正文中玩家主角和主要角色的表情、状态、行动及关系');
        expect(contract).toContain('主要角色单独出镜同样成立');
        expect(contract).toContain('不得把不在场者加入画面');
        expect(contract).toContain('主要角色依据设定与剧情判断，不等同于所有已建档角色');
        expect(contract).toContain('仅仅在场不构成入画理由');
        expect(contract).toContain('Anonymous crowds visible in the frame remain in Base');
        expect(selection).toContain('优先选择突出玩家主角或主要角色的画面');
        expect(selection).toContain('不以有无档案或是否有名字给候选加减分');
        expect(selection).toContain('先确定本图要突出的主体与核心互动，再决定谁入镜');
        expect(selection).toContain('若人群本身承载核心互动则保留');
        expect(thinking).toContain('清点名单不是入画名单');
        expect(thinking).toContain('每个本图可见的个体角色各写一块');
        expect(thinking).toContain('入画时才在他自己的角色块里补外貌');
        expect(thinking).toContain('没有为了减人数破坏核心互动，也没有把无关在场者补进画面');
        expect(thinking).not.toContain('每个在场角色各');
        expect(thinking).not.toContain('入画资格只看正文是否写他在场');
        expect(spec).toContain('Only include them when the chosen frame needs the crowd');
        expect(spec).toContain('Other people or crowds may remain off-screen');
        expect(spec).toContain('Keep an unnamed participant when needed to show the core interaction');
        expect(spec).not.toContain('an extra body in Base costs a little rendering polish');
      } finally {
        settings.defaultBackend = oldBackend;
        settings.nai.model = oldModel;
      }
    },
  );

  // 思维链要求填景别/环境光/size,V5 规范里原本没有任何判据——模型只能瞎猜。
  it('teaches NAI V5 the visual-completion doctrine its slots depend on', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const oldBackend = settings.defaultBackend;
    const oldModel = settings.nai.model;
    try {
      settings.defaultBackend = 'nai';
      settings.nai.model = 'nai-diffusion-5-full';
      const messages = await buildAutoTagMessages(context(), 1, options, null);
      const text = messages.map(m => m.content).join('\n');

      expect(text).toContain('Write exactly one shot distance');
      expect(text).toContain('must contain this image');
      expect(text).toContain('Keep body tags consistent with the shot distance');
      // 表情词表与另两份对齐:思维链是白名单制(规范没列的一律不许用),
      // 少列一个词等于禁用一个词。
      expect(text).toContain('smile, grin, laughing, blush');
      expect(text).toContain('crying, tears, angry');
      expect(text).toContain('worried, scared, smug');
      expect(text).toContain('open mouth, clenched teeth');
      // d46ae82 的地形修复此前从未覆盖 V5 路径。
      expect(text).toContain('never add muddy ground, dirt path, wetland, puddles');
      expect(text).toContain('Orientation (the size key)');
      expect(text).toContain('When unsure, write portrait');
    } finally {
      settings.defaultBackend = oldBackend;
      settings.nai.model = oldModel;
    }
  });

  // 原版 NAI4 的 char_captions 恒为空(nai.ts),协议形态与 ComfyUI 一样是单条 tag 串,
  // 一样需要邻接绑定——但 NAI 规范里此前一条多人规则、一个示例都没有。
  // (4.5 起走 Character Prompts 分支,归属另一份规范,不适用邻接绑定。)
  it('gives NAI 4 the multi-character binding rules and a worked example', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const oldBackend = settings.defaultBackend;
    const oldModel = settings.nai.model;
    try {
      settings.defaultBackend = 'nai';
      settings.nai.model = 'nai-diffusion-4-full';
      const messages = await buildAutoTagMessages(context(), 1, options, null);
      const text = messages.map(m => m.content).join('\n');

      expect(text).toContain('多人画面（两人及以上）额外规则');
      expect(text).toContain('white dress on green hair girl');
      expect(text).toContain('petite on silver hair girl');
      expect(text).toContain('black hair girl smiling, silver hair girl looking at another');
      expect(text).toContain('dark trousers on black hair boy');
      // 示例是规则的靠山:只有条文没有示例时模型照抄不到写法。
      expect(text).toContain('多人 tag 示例');
      // NAI 不吃 ComfyUI 的权重括号转义,那条不该跟着复制过来。
      expect(text).not.toContain('ComfyUI 会把未转义圆括号当作权重语法');
      // 排序统一到「构图紧跟人数」口径:与 Comfy 一致,也与多人规则原文一致;
      // 旧的「镜头构图放末尾」排序表和示例曾与此自相矛盾。
      expect(text).toContain('人数/主体 → 镜头构图 → 外貌');
      expect(text).not.toContain('场景 → 光线氛围 → 镜头构图');
      expect(text).toContain('2girls, medium shot, long hair');
      expect(text).not.toContain('park, sunset, medium shot');
      // 视线词表笔误:eyes closed 是 closed eyes 的别名,同 tag 两种词序不该并列。
      expect(text).not.toContain('eyes closed');
    } finally {
      settings.defaultBackend = oldBackend;
      settings.nai.model = oldModel;
    }
  });

  it('has the library dictate copied field values instead of @ placeholders', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const library = '【角色固定外貌库(系统维护)】\n小雪: 1girl, long silver hair';
    const messages = await buildAutoTagMessages(context(), 1, options, null, undefined, library);

    // 示例改用实际外貌串;@占位符已撤回(见 charAnchors.ts 文件头)
    expect(messages.some(m => m.content.includes('"tag":"1girl, long silver hair, red eyes, white dress"'))).toBe(true);
    expect(messages.some(m => m.content.includes('@小雪'))).toBe(false);
    expect(messages.some(m => m.content.includes('系统会替换成库中最新 tag'))).toBe(false);
    // 照抄库中字段 + 一张图只写一遍,是本次回退的两条核心措辞
    expect(messages.some(m => m.content.includes('照抄库中/刚建档的字段值'))).toBe(true);
    expect(messages.some(m => m.content.includes('只写一遍'))).toBe(true);
    expect(messages[messages.length - 1].content).toContain(library);
    expect(messages[messages.length - 1].content).not.toContain('currently empty');
  });

  it('forbids poses and scenes from entering the appearance profile', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const messages = await buildAutoTagMessages(context(), 1, options, null);

    // 档案会在之后每张图被照抄,姿势/场景混进字段会让角色永远保持那个姿势
    expect(messages.some(m => m.content.includes('lying on carpet'))).toBe(true);
    expect(messages.some(m => m.content.includes('长期不变的身体特征'))).toBe(true);
  });

  it('keeps first-appearance profiling enabled when BaiBai Book memory exists', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const messages = await buildAutoTagMessages(
      context(),
      1,
      options,
      {
        timing: 'before_latest',
        text: '【角色参考】已有其他角色',
        roles: [],
      },
    );

    expect(messages.some(message => message.content.includes('首次出场就必须'))).toBe(true);
    expect(messages.some(message => message.content.includes('柏宝书本次未提供'))).toBe(false);
  });

  it('uses the dedicated NAI V5 Base and Character Prompt contract', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const oldBackend = settings.defaultBackend;
    const oldModel = settings.nai.model;
    try {
      settings.defaultBackend = 'nai';
      settings.nai.model = 'nai-diffusion-5-full';
      const messages = await buildAutoTagMessages(context(), 1, options, null);
      expect(messages.some(message => message.content.includes('one Base Prompt plus zero or more native Character Prompts'))).toBe(true);
      expect(messages.some(message => message.content.includes('"characters":['))).toBe(true);
      expect(messages.some(message => message.content.includes('source# / target# / mutual#'))).toBe(true);
      expect(messages.some(message => message.content.includes('Character tag uses girl/boy without a numeric count'))).toBe(true);
      expect(messages.some(message => message.content.includes('every field:"new" change must include a non-empty nl'))).toBe(true);
      expect(messages.some(message => message.content.includes('Expression and gaze are mandatory for every character'))).toBe(true);
      // Base 的全局性对 tag 与 nl 同样成立:实跑里模型把单角色的制服/体型写进 Base nl,
      // 与角色 nl 重复——旧文本只把禁令写在 tag 层面。
      expect(messages.some(message => message.content.includes('this applies to the Base nl as much as to the Base tag'))).toBe(true);
      expect(messages.some(message => message.content.includes('never put one character\'s appearance, outfit, or individual action in the Base nl'))).toBe(true);
      // 建档 nl 只写固定外貌:临时服装进了永久档案的 nl,会跟着之后每楼走。
      expect(messages.some(message => message.content.includes('temporary states never enter the profile'))).toBe(true);
    } finally {
      settings.defaultBackend = oldBackend;
      settings.nai.model = oldModel;
    }
  });

  // 表情/视线此前在三个后端规范里都没有位置,思维链槽位填了也会在转 tag 时丢掉。
  it('reserves an expression/gaze slot in the tag ordering of both tag-based backends', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const oldBackend = settings.defaultBackend;
    const oldModel = settings.nai.model;
    try {
      for (const backend of ['comfyui', 'nai'] as const) {
        settings.defaultBackend = backend;
        if (backend === 'nai') settings.nai.model = 'nai-diffusion-4-full';
        const messages = await buildAutoTagMessages(context(), 1, options, null);
        const spec = messages.find(m => m.content.includes('从重要到次要排列'));
        expect(spec?.content).toContain('动作姿态 → 表情视线 → 场景');
        expect(spec?.content).toContain('表情与视线每张图都要写，不得省略');
        expect(spec?.content).toContain('判断为面无表情时也要显式写 expressionless');
        // 首轮实跑漏出 gentle smile / shy expression / neutral curious expression
        // 这类非 danbooru 词组:槽位填对了,转 tag 时原样直译。规范里要给限定词表。
        expect(spec?.content).toContain('必须使用模型认识的标准 danbooru 词，不得自创描述性词组');
        expect(spec?.content).toContain('gentle smile 写 smile，shy expression 写 blush');
        expect(spec?.content).toContain('puffy cheeks');
      }
    } finally {
      settings.defaultBackend = oldBackend;
      settings.nai.model = oldModel;
    }
  });

  // 同一轮实跑里 P11 两人各自的 looking at another 被合并成一个裸 tag,
  // petite / black pantyhose 也脱离了 on green hair girl 绑定。
  it('binds per-character expression, gaze and body type in multi-character ComfyUI tags', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const oldBackend = settings.defaultBackend;
    try {
      settings.defaultBackend = 'comfyui';
      const messages = await buildAutoTagMessages(context(), 1, options, null);
      const spec = messages.find(m => m.content.includes('多人画面（两人及以上）额外规则'));
      expect(spec?.content).toContain('表情与视线同样是**每人各一份、必须绑定**的特征');
      expect(spec?.content).toContain('另一人变成默认木脸');
      expect(spec?.content).toContain('两人表情或视线恰好相同时也各写一份带称谓的');
      expect(spec?.content).toContain('体型词（petite、tall、muscular 等）不是锚点，必须绑定到具体角色');
      // 规则没有示例撑腰就是空话:实跑里模型照着示例串抄结构,petite/loli 仍然裸写。
      expect(spec?.content).toContain('petite on silver hair girl');
      // 发色瞳色是绑定锚点,裸列才对——不能被上一条误伤成 black hair on black hair girl。
      expect(spec?.content).toContain('发色、瞳色本身是用来指认角色的锚点，照常裸列即可');
      // 瘦身时删掉「不许退回笼统词」当轮就复发:tag 里裸写 school uniform +
      // black opaque pantyhose,男孩的 white shirt/dark pants 干脆没进 tag。
      expect(spec?.content).toContain('同类不同款的服装尤其要绑定，不能靠一个统称糊过去');
      expect(spec?.content).toContain('dark pleated skirt on green hair girl');
      expect(spec?.content).toContain('white shirt on black hair boy');
      expect(spec?.content).toContain('会让模型把裙子套到男生身上');
      // 示例串要真的示范绑定写法,否则模型照着旧示例抄裸 tag。
      expect(spec?.content).toContain('black hair girl smile, black hair girl looking at viewer');
      expect(spec?.content).toContain('silver hair girl blush, silver hair girl looking away');
    } finally {
      settings.defaultBackend = oldBackend;
    }
  });

  // 槽位本身也要挡住中文描述,否则先漏进槽位再漏进 tag。
  it('makes the per-image slot block demand canonical danbooru expression words', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const messages = await buildAutoTagMessages(context(), 1, options, null);
    const thinkingMsg = messages.find(m => m.content.includes('输出前思考清单'));
    expect(thinkingMsg?.content).toContain('不写中文感受也不自创词组（想写「温柔地笑」就填 smile）');
    expect(thinkingMsg?.content).toContain('多人画面每人各填一份');
    expect(thinkingMsg?.content).toContain('另一人变成默认木脸');
    // 连着两轮实跑都没照抄 ■ 格式,但七个槽位一项没漏——防漏的目的已达成,
    // 形状不是目的。故意不钉「■ 单独成行」这类形态断言,只钉槽位齐全。
    expect(thinkingMsg?.content).toContain('七个槽位一个都不能少');
    // 摇摆的可执行判据:抽象的「别反复权衡」模型每次都觉得自己没在权衡。
    expect(thinkingMsg?.content).toContain('同一个字段在整个 <thinking> 里只准出现一次取值');
    // 不写推演过程的约束保留,但不设字数硬上限——上限会逼着模型为多图多人场景压缩建档判断。
    expect(thinkingMsg?.content).not.toContain('800 字');
    expect(thinkingMsg?.content).toContain('带问号的自问');
    expect(thinkingMsg?.content).toContain('并列候选');
    // 第三层曾自称「落成 tag」,与「不要预写 tag 串」直接打架,实跑里 tag 被写了四遍。
    expect(thinkingMsg?.content).toContain('第三层｜落笔前自查');
    // 上一版只禁「完整 tag/nl 串」,模型钻空子改成在 thinking 里预写整个 JSON 对象
    // (末尾一句 "JSON:" 加一份完整答案),白烧约 800 token。措辞要覆盖 JSON 本身。
    expect(thinkingMsg?.content).toContain('不写完整 tag 串、不写完整 nl 句、更不要写出 JSON 对象');
    expect(thinkingMsg?.content).toContain('答案只在 </thinking> 之后出现一次');
    expect(thinkingMsg?.content).not.toContain('第三层｜落成 tag 并自查');
    expect(thinkingMsg?.content).not.toContain('逐条转成 tag/nl');
  });

  it('requests per-image negative tags only when the ComfyUI workflow uses %negative_prompt%', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const oldBackend = settings.defaultBackend;
    // 工作流改由「当前预设」承载(见 settings.ts 工作流库);默认值恒有一条,直接改它
    const preset = activeComfyPreset();
    const oldWorkflow = preset.workflow;
    try {
      settings.defaultBackend = 'comfyui';
      preset.workflow = JSON.stringify({
        '6': {
          class_type: 'CLIPTextEncode',
          inputs: { text: '%prompt%', negative: '%negative_prompt%' },
        },
      });
      const messages = await buildAutoTagMessages(context(), 1, options, null);

      expect(messages.some(message => message.content.includes('"negative":"extra people'))).toBe(true);
      expect(messages.some(message => message.content.includes('禁止输出通用质量、画质、审美或技术性负面词'))).toBe(true);
      expect(messages.some(message => message.content.includes('worst quality、low quality、blurry'))).toBe(true);
      expect(messages.some(message => message.content.includes('工作流里已有的通用质量负面词'))).toBe(false);
      expect(messages.some(message => message.content.includes('不得使用 @角色占位符'))).toBe(true);
      // 实跑里模型给下雨的正文配了 "negative":"rain, umbrella",反而抵消了 tag 的 wet asphalt。
      expect(messages.some(message => message.content.includes('negative 里绝不能出现正文已明确成立的事实'))).toBe(true);
      expect(messages.some(message => message.content.includes('正文写了在下雨'))).toBe(true);
      // 复发一次:nl 自己写了 drizzle,negative 仍填 rain。禁令必须覆盖「否定自己刚写的内容」。
      expect(messages.some(message => message.content.includes('也不能否定你自己刚写进本图 tag/nl 的任何东西'))).toBe(true);
      expect(messages.some(message => message.content.includes('写完 negative 逐词回看本图的 tag 与 nl'))).toBe(true);
      expect(messages.some(message => message.content.includes('空的 negative 永远比抵消正文的 negative 安全'))).toBe(true);
    } finally {
      settings.defaultBackend = oldBackend;
      preset.workflow = oldWorkflow;
    }
  });

  it('简易模式的动态负面词门槛由模板决定:checkpoint/anima 请求,flux 不请求', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const oldBackend = settings.defaultBackend;
    const preset = activeComfyPreset();
    const oldMode = preset.mode;
    const oldTemplate = preset.simple.template;
    try {
      settings.defaultBackend = 'comfyui';
      preset.mode = 'simple';
      preset.simple.template = 'checkpoint';
      const messages = await buildAutoTagMessages(context(), 1, options, null);
      expect(messages.some(message => message.content.includes('"negative":"extra people'))).toBe(true);

      preset.simple.template = 'flux';
      const fluxMessages = await buildAutoTagMessages(context(), 1, options, null);
      expect(fluxMessages.some(message => message.content.includes('"negative":"extra people'))).toBe(false);
    } finally {
      settings.defaultBackend = oldBackend;
      preset.mode = oldMode;
      preset.simple.template = oldTemplate;
    }
  });
});

describe('自然语言条件段 expandNlSections', () => {
  it('{{#nl}} 段只在开启时保留,{{^nl}} 段只在关闭时保留', () => {
    const text = 'A{{#nl}}-on{{/nl}}{{^nl}}-off{{/nl}}B';
    expect(expandNlSections(text, true)).toBe('A-onB');
    expect(expandNlSections(text, false)).toBe('A-offB');
  });

  it('段内可以跨行;没有条件段的文本原样返回(整段替换的 {{nl}} 宏不归它管)', () => {
    const text = 'x{{#nl}}\n第一行\n第二行\n{{/nl}}y';
    expect(expandNlSections(text, true)).toBe('x\n第一行\n第二行\ny');
    expect(expandNlSections(text, false)).toBe('xy');
    expect(expandNlSections('plain {{nl}} text', false)).toBe('plain {{nl}} text');
  });

  it('配不上对的标记原样留着,不吞掉后文', () => {
    // 写错了在请求历史里看得见;静默吞掉的话,漏闭合会把后面整份规范一起删光
    expect(expandNlSections('a{{#nl}}b', false)).toBe('a{{#nl}}b');
    expect(expandNlSections('a{{/nl}}b', true)).toBe('a{{/nl}}b');
  });

  // 内置文本里的标记一旦写错(漏闭合、错拼),整段会连标记带内容原样漏给模型
  it.each([true, false])('内置 NAI 规范与思维链展开后不留任何标记(nl=%s)', nlOn => {
    for (const text of [DEFAULT_NAI_V5_SPEC, DEFAULT_NAI_V5_THINKING]) {
      expect(expandNlSections(text, nlOn)).not.toMatch(/\{\{[#^/]nl\}\}/);
    }
  });
});

// NAI 4.5 的提示词 token 上限比 V5 紧,自然语言是最占预算的部分 —— 这是开关的由来。
// 口径与 ComfyUI 那个开关相同:只管 AI 写不写,已写进正文的 nl 照常发送。
describe('NAI「生成自然语言」开关与渠道画幅锁', () => {
  function options(overrides: Partial<AutoTagPrompts> = {}): AutoTagSettings {
    return {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(overrides),
    };
  }

  /** 每条用例都会拨后端与开关:进来时快照,出去时原样放回(settings 是模块级单例)。 */
  function snapshot() {
    const preset = activeComfyPreset();
    const saved = {
      backend: settings.defaultBackend,
      model: settings.nai.model,
      naiNl: settings.nai.naturalLanguage,
      naiLock: settings.nai.orientationLock,
      presetNl: preset.naturalLanguage,
      presetLock: preset.orientationLock,
      presetDialect: preset.specDialect,
    };
    return {
      preset,
      restore() {
        settings.defaultBackend = saved.backend;
        settings.nai.model = saved.model;
        settings.nai.naturalLanguage = saved.naiNl;
        settings.nai.orientationLock = saved.naiLock;
        preset.naturalLanguage = saved.presetNl;
        preset.orientationLock = saved.presetLock;
        preset.specDialect = saved.presetDialect;
      },
    };
  }

  const CONTRACT_MARK = '你是严谨的剧情画面规划与生图提示词编写员';
  const NAI_SPEC_MARK = '[NovelAI 4.5/V5 Prompt Specification]';
  const THINKING_MARK = '输出前思考清单';

  function pick(messages: { content: string }[], mark: string): string {
    const found = messages.find(m => m.content.includes(mark));
    expect(found, mark).toBeTruthy();
    return found!.content;
  }

  it.each(['nai-diffusion-4-5-full', 'nai-diffusion-5-full'] as const)(
    '关掉后 %s 的协议、规范、思维链整套切成纯 tag;拨回开启即恢复',
    async model => {
      const state = snapshot();
      try {
        settings.defaultBackend = 'nai';
        settings.nai.model = model;
        settings.nai.naturalLanguage = false;
        const messages = await buildAutoTagMessages(context(), 1, options(), null);
        const contract = pick(messages, CONTRACT_MARK);
        const spec = pick(messages, NAI_SPEC_MARK);
        const thinking = pick(messages, THINKING_MARK);

        // 示例 JSON 里一个 nl 键都不留:模型照抄示例的倾向比照读规则强得多
        expect(contract).not.toContain('"nl"');
        expect(contract).toContain('"characters":[{"name":"小雪"');
        expect(contract).toContain('This output is tag-only');
        expect(contract).toContain('name and tag are both required');
        // 建档也不再要 nl —— runner 验收同一口径(profile.nl),否则会为不存在的要求白耗重试
        expect(contract).not.toContain('every field:"new" change must include a non-empty nl');

        // 规范第 6 条整条换成 tag-only 版本(编号不动),示例与条目形状同步去掉 nl
        expect(spec).toContain('This output is tag-only: write no nl key anywhere');
        expect(spec).toContain('{"name":"...","tag":"..."}');
        expect(spec).not.toContain('"nl":');
        expect(spec).not.toContain('Save adjectival nuance for nl');
        expect(thinking).toContain('本次只写 tag');
        expect(thinking).not.toContain('不写完整 nl 句');
        // 多角色提示词本身不受开关影响:关的只是 nl,characters[] 照样要
        expect(thinking).toContain('characters[]');

        settings.nai.naturalLanguage = true;
        const on = (await buildAutoTagMessages(context(), 1, options(), null))
          .map(m => m.content)
          .join('\n');
        expect(on).toContain('"nl":"A girl stands in a classroom');
        expect(on).toContain('Save adjectival nuance for nl.');
        expect(on).toContain('every field:"new" change must include a non-empty nl');
        expect(on).toContain('不写完整 nl 句');
        expect(on).not.toContain('This output is tag-only');
        expect(on).not.toContain('本次只写 tag');
      } finally {
        state.restore();
      }
    },
  );

  it('自定义规范与思维链同样按开关展开条件段(两个后端各认各的开关)', async () => {
    const state = snapshot();
    const custom = options({
      naiV5Spec: 'NAI-SPEC{{#nl}} with-nl{{/nl}}{{^nl}} tag-only{{/nl}}',
      naiV5Thinking: 'NAI-THINK{{#nl}} with-nl{{/nl}}{{^nl}} tag-only{{/nl}}',
      comfySpec: 'COMFY-SPEC{{#nl}} with-nl{{/nl}}{{^nl}} tag-only{{/nl}}',
      comfyThinking: 'COMFY-THINK{{#nl}} with-nl{{/nl}}{{^nl}} tag-only{{/nl}}',
    });
    const run = async () =>
      (await buildAutoTagMessages(context(), 1, custom, null)).map(m => m.content).join('\n');
    try {
      settings.defaultBackend = 'nai';
      settings.nai.model = 'nai-diffusion-4-5-full';
      settings.nai.naturalLanguage = false;
      // ComfyUI 那份开着也不该影响 NAI
      state.preset.naturalLanguage = true;
      let text = await run();
      expect(text).toContain('NAI-SPEC tag-only');
      expect(text).toContain('NAI-THINK tag-only');
      expect(text).not.toContain('with-nl');

      settings.nai.naturalLanguage = true;
      text = await run();
      expect(text).toContain('NAI-SPEC with-nl');
      expect(text).toContain('NAI-THINK with-nl');

      settings.defaultBackend = 'comfyui';
      state.preset.naturalLanguage = false;
      text = await run();
      expect(text).toContain('COMFY-SPEC tag-only');
      expect(text).toContain('COMFY-THINK tag-only');
      expect(text).not.toContain('with-nl');

      state.preset.naturalLanguage = true;
      text = await run();
      expect(text).toContain('COMFY-SPEC with-nl');
      expect(text).toContain('COMFY-THINK with-nl');
    } finally {
      state.restore();
    }
  });

  // 只锁出图不改协议的话,模型照样按横竖判据取景:锁竖时为群像构思宽画面,出图却是竖的
  it('NAI 锁横屏:协议改口为每张都填 landscape,示例同步,不再给选向兜底', async () => {
    const state = snapshot();
    try {
      settings.defaultBackend = 'nai';
      settings.nai.model = 'nai-diffusion-4-5-full';
      settings.nai.orientationLock = 'landscape';
      const contract = pick(await buildAutoTagMessages(context(), 1, options(), null), CONTRACT_MARK);
      expect(contract).toContain('锁定为横图，每张图都填 "landscape"');
      expect(contract).toContain('判据本次不适用');
      expect(contract).toContain('"size":"landscape"}],"changes":[]}');
      expect(contract).not.toContain('拿不准就填 "portrait"');
    } finally {
      state.restore();
    }
  });

  it('ComfyUI 锁看当前工作流那份;NAI 的锁不串过来', async () => {
    const state = snapshot();
    try {
      settings.defaultBackend = 'comfyui';
      settings.nai.orientationLock = 'landscape';
      state.preset.orientationLock = 'portrait';
      let contract = pick(await buildAutoTagMessages(context(), 1, options(), null), CONTRACT_MARK);
      expect(contract).toContain('锁定为竖图，每张图都填 "portrait"');
      expect(contract).toContain('"size":"portrait"}],"changes":[]}');

      state.preset.orientationLock = 'auto';
      contract = pick(await buildAutoTagMessages(context(), 1, options(), null), CONTRACT_MARK);
      expect(contract).toContain('拿不准就填 "portrait"');
      expect(contract).not.toContain('已由用户在渠道设置里锁定');
    } finally {
      state.restore();
    }
  });

  it('autoTagProfile:按当前后端与其开关算一次,写协议与 runner 验收共用这一份', () => {
    const state = snapshot();
    try {
      settings.defaultBackend = 'nai';
      settings.nai.model = 'nai-diffusion-4-5-full';
      settings.nai.naturalLanguage = true;
      settings.nai.orientationLock = 'auto';
      expect(autoTagProfile()).toEqual({
        naiCharPrompts: true,
        nl: true,
        lockedSize: null,
        dialect: 'comfy',
        layoutLock: 'auto',
      });

      settings.nai.naturalLanguage = false;
      settings.nai.orientationLock = 'portrait';
      expect(autoTagProfile()).toEqual({
        naiCharPrompts: true,
        nl: false,
        lockedSize: 'portrait',
        dialect: 'comfy',
        layoutLock: 'auto',
      });

      // 单串分支(NAI4)的协议本来就不写 nl,开关对它不起作用
      settings.nai.model = 'nai-diffusion-4-full';
      settings.nai.naturalLanguage = true;
      expect(autoTagProfile()).toMatchObject({ naiCharPrompts: false, nl: false });

      // ComfyUI:自然语言与画幅锁都取当前工作流
      settings.defaultBackend = 'comfyui';
      state.preset.naturalLanguage = true;
      state.preset.orientationLock = 'landscape';
      expect(autoTagProfile()).toEqual({
        naiCharPrompts: false,
        nl: true,
        lockedSize: 'landscape',
        dialect: 'comfy',
        layoutLock: 'auto',
      });

      state.preset.naturalLanguage = false;
      state.preset.orientationLock = 'auto';
      expect(autoTagProfile()).toEqual({
        naiCharPrompts: false,
        nl: false,
        lockedSize: null,
        dialect: 'comfy',
        layoutLock: 'auto',
      });

      // MOSS 方言:nl 恒真(那条线的 tag 只锁元素、nl 才是主体),不受「生成自然语言」开关影响
      state.preset.specDialect = 'moss';
      state.preset.naturalLanguage = false;
      expect(autoTagProfile()).toMatchObject({ nl: true, dialect: 'moss' });
    } finally {
      state.restore();
    }
  });

  it('MOSS 方言:换规范与思维链、强制 nl、不请求动态负面词', async () => {
    const state = snapshot();
    try {
      settings.defaultBackend = 'comfyui';
      state.preset.specDialect = 'moss';
      // 开关关掉也不影响 MOSS 线 —— nl 是那条线的主体
      state.preset.naturalLanguage = false;
      expect(autoTagProfile()).toMatchObject({ nl: true, dialect: 'moss' });

      const messages = await buildAutoTagMessages(context(), 1, mossOptions(), null);

      // 规范与思维链整份换成 MOSS 那份
      const spec = pick(messages, 'MOSS-Image 写实线提示词规范');
      expect(spec).toContain('nl（JSON 的 nl 键）：**本线必填');
      expect(pick(messages, '输出前思考清单（MOSS 写实线）')).toBeTruthy();
      // 不再混入 tag 流的 COMFY 规范与 NL 追加段
      expect(messages.some(m => m.content.includes('【ComfyUI 提示词规范】'))).toBe(false);
      expect(messages.some(m => m.content.includes('nl（JSON 的 nl 键）：自然语言——连贯完整的英文句子'))).toBe(false);

      // 协议不再请求 negative:固定负面已由预设承担,AI 再写一段只会打架
      const contract = messages.find(m => m.content.includes('你是严谨的剧情画面规划与生图提示词编写员'))!.content;
      expect(contract).not.toContain('negative 是本画面专用的 danbooru 负面短 tag');
    } finally {
      state.restore();
    }
  });

  // 机位是 MOSS 线的骨架:tag 的元素顺序里曾有「景别」却没有「朝向」,机位只活在 nl 首句,
  // 被后面两段冲淡后模型会为了细节改机位(实测:side view + 臀缝可见 → 出图变成后视)。
  it('MOSS 方言:机位朝向进 tag 元素位,且规范/思维链都钉住可见性', async () => {
    const state = snapshot();
    try {
      settings.defaultBackend = 'comfyui';
      state.preset.specDialect = 'moss';

      const messages = await buildAutoTagMessages(context(), 1, mossOptions(), null);
      const spec = pick(messages, 'MOSS-Image 写实线提示词规范');
      const thinking = pick(messages, '输出前思考清单（MOSS 写实线）');

      // tag 元素顺序必须有「机位朝向」这一项,且排在景别之后
      expect(spec).toContain('人数 → 景别（只写一个）→ **机位朝向（见 1.1）**');
      expect(spec).toContain('front view（正对）/ three-quarter view（四分之三侧）/ side view（正侧');
      // 可见性对照:细节与机位冲突时必须择一,这是本条修复的核心
      expect(spec).toContain('看不见**臀缝');
      expect(spec).toContain('改机位或删细节，绝不两者都写');
      expect(spec).toContain('bent over / looking back 在训练数据里默认与后视绑定');
      // 前景/背景不许放同一件家具 —— 实测里「前景扶手 + 背景沙发」直接把构图搞散
      expect(spec).toContain('同一件家具只能出现在其中一层');
      // 光位必须先定光源在哪一侧,否则「两头都亮」等于没有光源
      expect(spec).toContain('先定光源在房间的哪一侧');
      // 英文身体段不是中文段的翻译:这条缺了,两段会互相加权
      expect(spec).toContain('这一段不是中文段的翻译');

      // 思维链必须把「定机位」提到写内容之前,并收在一条一致性总检上
      expect(thinking).toContain('机位定死（本步必须在写任何内容之前完成）');
      expect(thinking).toContain('改机位，还是删细节');
      expect(thinking).toContain('自检：交出去之前对一遍');

      // 面部占比过小时允许「不画脸」:占比估不出来就会硬画一张崩坏脸。
      // 这条同时必须给出**例外**——否则「表情与视线不得留空」会把它顶回去。
      expect(spec).toContain('面部占比与「不画脸」');
      expect(spec).toContain('面积不到 2%');
      expect(spec).toContain('表情与视线两槽就写 "-"');
      expect(thinking).toContain('面部占比估一次，它决定这一张到底画不画脸');
      expect(thinking).toContain('占比过小就改成不画脸');
      expect(thinking).toContain('表情与视线不得留空（**唯一例外**');
      // 总检条目数跟着加了一条,数字不同步会让模型按旧条目数核对
      expect(thinking).toContain('「自检：交出去之前对一遍」五条过一遍');

      // tag 流那两份不带机位条款:那条线 single-CLIP 吃短 tag,写了只是噪声
      state.preset.specDialect = 'comfy';
      const comfyMessages = await buildAutoTagMessages(context(), 1, mossOptions(), null);
      const comfySpec = pick(comfyMessages, '【ComfyUI 提示词规范】');
      expect(comfySpec).not.toContain('机位朝向');
      expect(comfySpec).not.toContain('改机位或删细节');
    } finally {
      state.restore();
    }
  });

  it('MOSS 方言:外貌归属按库标记分流,不再无条件要求照抄', async () => {
    const state = snapshot();
    try {
      settings.defaultBackend = 'comfyui';
      state.preset.specDialect = 'moss';
      const library = [
        '- 林夏 [中文外貌已填]: 性别=1girl, 头发=long black hair',
        '- 许梨: 性别=1girl, 头发=short brown hair',
      ].join('\n');

      const messages = await buildAutoTagMessages(context(), 1, mossOptions(), null, undefined, library);
      const contract = messages.find(m => m.content.includes('你是严谨的剧情画面规划与生图提示词编写员'))!.content;

      // 填了中文外貌的角色:外貌由插件注入,AI 不重描(与 MOSS 规范同口径)
      expect(contract).toContain('这些固定外貌一个词都不要写');
      // 年龄与人种不属于固定外貌档案,插件不注入 —— 这条必须留着,否则 zh 角色会失去
      // chinese / east asian,按英文先验出欧美脸
      expect(contract).toContain('年龄感与人种');
      expect(contract).toContain('写了不算重描');
      // 没填的仍然由 AI 补一次 —— 否则没填 zh 的角色会彻底失去外貌
      expect(contract).toContain('外貌由你补一次');
      // 通用条款那句「无条件照抄库字段」在 moss 下必须让位,否则两条相反指令并存
      expect(contract).not.toContain('用词一字不改，不得自行改写或增删其固定外貌');

      // tag 流保持原样:那条线没有中文外貌通道,照抄才是对的口径
      state.preset.specDialect = 'comfy';
      const comfyMessages = await buildAutoTagMessages(context(), 1, mossOptions(), null, undefined, library);
      const comfyContract = comfyMessages.find(m => m.content.includes('你是严谨的剧情画面规划与生图提示词编写员'))!.content;
      expect(comfyContract).toContain('用词一字不改，不得自行改写或增删其固定外貌');
    } finally {
      state.restore();
    }
  });

  // 动漫线与写实线共底模但审美相反:前者要中文散文 + 极简元素行,后者要 tag 锁元素 +
  // 英文身体段。两套规范混用会让模型写它那条线根本不存在的段落形态。
  // 版式锁是预设级的,协议与思维链都要跟着换形态 —— 这条盯着「锁定后协议真的多了一条版式要求、
  // auto 时一条都不多」,免得锁了却还在要单张(或反过来)。
  it('MOSS 动漫方言:版式锁按档位改写协议与思维链', async () => {
    const state = snapshot();
    try {
      settings.defaultBackend = 'comfyui';
      state.preset.specDialect = 'moss-anime';
      const read = async () => {
        const messages = await buildAutoTagMessages(context(), 1, mossOptions(), null);
        return {
          contract: messages.find(m => m.content.includes('你是严谨的剧情画面规划与生图提示词编写员'))!.content,
          thinking: messages.filter(m => m.content.includes('输出前思考清单')).pop()!.content,
        };
      };

      // auto:协议里一个字都不要提版式
      state.preset.layoutLock = 'auto';
      let out = await read();
      expect(out.contract).not.toContain('版式（已锁定');
      expect(out.thinking).not.toContain('本次版式已锁定');
      expect(autoTagProfile().layoutLock).toBe('auto');

      // 单张:明文禁止页型与气泡
      state.preset.layoutLock = 'single';
      out = await read();
      expect(out.contract).toContain('版式（已锁定为单张）');
      expect(out.contract).toContain('不分格、不写页型');
      expect(out.thinking).toContain('本次版式已锁定为单张');
      expect(autoTagProfile().layoutLock).toBe('single');

      // 分镜条:页型 + 每格一段 + 格数上限 + 不写气泡
      state.preset.layoutLock = 'strip';
      out = await read();
      expect(out.contract).toContain('版式（已锁定为分镜条）');
      expect(out.contract).toContain('格数上限 3');
      expect(out.contract).toContain('不写气泡、不写台词');
      expect(out.thinking).toContain('本次版式已锁定为分镜条');

      // 漫画页:气泡 + 台词字数 + 阅读顺序
      state.preset.layoutLock = 'page';
      out = await read();
      expect(out.contract).toContain('版式（已锁定为漫画页）');
      expect(out.contract).toContain('2–10 个简体汉字');
      expect(out.contract).toContain('气泡不许压脸');
      expect(out.contract).toContain('右上→左下');
      expect(out.thinking).toContain('本次版式已锁定为漫画页');

      // 非动漫方言:版式锁一律不参与(那条线的规范里没有分镜口径)
      state.preset.specDialect = 'moss';
      out = await read();
      expect(out.contract).not.toContain('版式（已锁定');
      expect(autoTagProfile().layoutLock).toBe('auto');
    } finally {
      state.restore();
    }
  });

  it('MOSS 动漫方言:换规范与思维链、tag 示例改中文元素行、负面同样不请求', async () => {
    const state = snapshot();
    try {
      settings.defaultBackend = 'comfyui';
      state.preset.specDialect = 'moss-anime';

      // nl 同样恒真:动漫线的主体也是散文段,开关不参与
      state.preset.naturalLanguage = false;
      expect(autoTagProfile()).toMatchObject({ nl: true, dialect: 'moss-anime' });

      const messages = await buildAutoTagMessages(context(), 1, mossOptions(), null);
      const spec = pick(messages, 'MOSS 动漫线提示词规范');
      const thinking = pick(messages, '输出前思考清单（MOSS 动漫线）');
      const contract = messages.find(m => m.content.includes('你是严谨的剧情画面规划与生图提示词编写员'))!.content;

      // 写实线那份不能混进来:两套规范的段落形态互斥
      expect(messages.some(m => m.content.includes('MOSS-Image 写实线提示词规范'))).toBe(false);
      expect(messages.some(m => m.content.includes('【ComfyUI 提示词规范】'))).toBe(false);

      // 规范要点:极简中文元素行 + 中文四段 + 禁画风词 + 不出分镜页
      expect(spec).toContain('极简中文元素行');
      expect(spec).toContain('tag 流');
      expect(spec).toContain('画风词');
      expect(spec).toContain('## 六、版式：单张 or 分镜');
      expect(spec).toContain('分镜条');
      expect(spec).toContain('漫画页');
      expect(spec).toContain('格数上限 3');
      expect(thinking).toContain('机位定死（本步必须在写任何内容之前完成）');
      expect(thinking).toContain('材质三件套');

      // 面部占比:动漫线原来只写「确认脸落在看得见的位置」,脸太小也要有出口。
      // 「不画脸」是取景选项而不是偷懒,规范自检第 6 条因此从硬要求改成二选一。
      expect(thinking).toContain('面部占比在这一步一并估掉');
      expect(thinking).toContain('占比过小时**两种走法，二选一');
      expect(thinking).toContain('干脆不画脸');
      expect(spec).toContain('脸的去向说清了吗');
      expect(spec).toContain('两种都合格，含糊才不合格');
      // 总检不报条数:分镜两条是按预设条件生效的,写死「六条 / 七条」都会让模型数错
      expect(thinking).toContain('「八、自检」逐条过一遍');
      expect(thinking).not.toMatch(/「八、自检」[一二三四五六七八九十]+条/);
      // 分镜页每格要单独判面部占比:广角格里硬塞五官就是崩坏脸的来源
      expect(spec).toContain('每格单独判面部占比');
      expect(spec).toContain('整页不必每格都有脸');

      // 示例必须是中文元素行:给英文 tag 示例会把模型带回 tag 流
      expect(contract).toContain('"tag":"一个人，中景，四分之三侧面，公寓客厅，午后的侧光"');
      expect(contract).not.toContain('"tag":"1girl, long silver hair, red eyes, white dress"');
      // 协议里 tag 的定义也换成了元素行,不再说 danbooru 短 tag
      expect(contract).toContain('极简中文元素行（人数 / 景别 / 机位朝向 / 地点 / 光的方向，20 字以内）');

      // 负面同样由预设的固定串承担,AI 不写动态负面
      expect(contract).not.toContain('negative 是本画面专用的 danbooru 负面短 tag');
    } finally {
      state.restore();
    }
  });

  it('MOSS 动漫方言:角色库条款按标记分流,但不禁中文段写外貌', async () => {
    const state = snapshot();
    try {
      settings.defaultBackend = 'comfyui';
      state.preset.specDialect = 'moss-anime';
      const library = [
        '- 林夏 [中文外貌已填]: 性别=1girl, 头发=long black hair',
        '- 许梨: 性别=1girl, 头发=short brown hair',
      ].join('\n');

      const messages = await buildAutoTagMessages(context(), 1, mossOptions(), null, undefined, library);
      const contract = messages.find(m => m.content.includes('你是严谨的剧情画面规划与生图提示词编写员'))!.content;

      expect(contract).toContain('这些**固定外貌一个词都不要写');
      // 动漫线没有英文身体段,外貌全在 nl 的中文层里 —— 这条判据必须点明
      expect(contract).toContain('年龄感与人种**（它们不属于固定外貌档案');
      expect(contract).toContain('外貌由你补一次');
      // 写实线那句「写进英文身体段」不能挂到这条线上
      expect(contract).not.toContain('不要在英文身体段里再给一遍体型总述');
    } finally {
      state.restore();
    }
  });

  it('MOSS 方言下自报的 negative 也不会进协议(与 ComfyUI tag 流对照)', async () => {
    const state = snapshot();
    const savedWorkflow = state.preset.workflow;
    try {
      settings.defaultBackend = 'comfyui';
      state.preset.specDialect = 'comfy';
      state.preset.naturalLanguage = true;
      // tag 流的 negative 规则只在工作流真的吃 %negative_prompt% 时才出现
      // (默认预设是空工作流,negativeOn=false),故这里显式给一套带负面的工作流。
      state.preset.workflow = JSON.stringify({
        '1': { class_type: 'CLIPTextEncode', inputs: { text: '%prompt%' } },
        '2': { class_type: 'CLIPTextEncode', inputs: { text: '%negative_prompt%' } },
      });
      const comfyMsgs = await buildAutoTagMessages(context(), 1, mossOptions(), null);
      const comfyContract = comfyMsgs.find(m => m.content.includes('你是严谨的剧情画面规划与生图提示词编写员'))!.content;

      state.preset.specDialect = 'moss';
      const mossMsgs = await buildAutoTagMessages(context(), 1, mossOptions(), null);
      const mossContract = mossMsgs.find(m => m.content.includes('你是严谨的剧情画面规划与生图提示词编写员'))!.content;

      // 关键差别:tag 流的合同里带 negative 规则,MOSS 流里根本没有这条
      expect(comfyContract).toContain('negative 是本画面专用的 danbooru 负面短 tag');
      expect(mossContract).not.toContain('negative 是本画面专用的 danbooru 负面短 tag');
    } finally {
      state.preset.workflow = savedWorkflow;
      state.restore();
    }
  });
});

describe('构图闸:协议里的构图约束', () => {
  function options(overrides: Partial<AutoTagPrompts> = {}): AutoTagSettings {
    return {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(overrides),
    };
  }

  /** 协议 = 那条以「你是严谨的剧情画面规划」开头的 system 消息。 */
  async function contractOf(cfg: AutoTagSettings): Promise<string> {
    const messages = await buildAutoTagMessages(context(), 1, cfg, null);
    return messages.find(m => m.content.startsWith('你是严谨的剧情画面规划'))!.content;
  }

  const state = () => {
    const preset = activeComfyPreset();
    const saved = {
      backend: settings.defaultBackend,
      model: settings.nai.model,
      dialect: preset.specDialect,
      presetNl: preset.naturalLanguage,
      naiNl: settings.nai.naturalLanguage,
    };
    return {
      preset,
      restore() {
        settings.defaultBackend = saved.backend;
        settings.nai.model = saved.model;
        preset.specDialect = saved.dialect;
        preset.naturalLanguage = saved.presetNl;
        settings.nai.naturalLanguage = saved.naiNl;
      },
    };
  };

  it('每个方言都拿到同一份承重墙顺序(人数 → 景别 → 机位朝向 → 机位高度)', async () => {
    const save = state();
    try {
      for (const backend of ['comfyui', 'nai'] as const) {
        for (const dialect of ['comfy', 'moss', 'moss-anime'] as const) {
          settings.defaultBackend = backend;
          if (backend === 'nai') settings.nai.model = 'nai-diffusion-4-full';
          save.preset.specDialect = dialect;
          save.preset.naturalLanguage = true;
          const contract = await contractOf(options());
          // 规则正文来自 SHOT_ORDER_RULE 本身,不在这里另抄一份词表
          expect([backend, dialect, contract.includes('构图先于其它一切')]).toEqual([backend, dialect, true]);
          expect(contract).toContain('景别只许出现一个');
          expect(contract).toContain('机位高度');
          expect(contract).toContain('**构图闸');
        }
      }
    } finally {
      save.restore();
    }
  });

  it('动漫线额外强调:景别只许一个、nl 第一段与 tag 同口径,且与规范第二节不矛盾', async () => {
    const save = state();
    try {
      settings.defaultBackend = 'comfyui';
      save.preset.specDialect = 'moss-anime';
      save.preset.naturalLanguage = true;
      const contract = await contractOf(options());

      expect(contract).toContain('极简中文元素行是**同一条**规则，不是第二套');
      expect(contract).toContain('**景别与机位朝向各只许出现一个**');
      expect(contract).toContain('nl 的第一段必须与 tag 同口径');
      expect(contract).toContain('每格第一句各自点明景别与机位');

      // 规范第二节的元素行顺序必须与这条规则同口径(两处一旦漂,模型两头都不认)
      const spec = (await buildAutoTagMessages(context(), 1, options(), null)).find(m =>
        m.content.includes('MOSS 动漫线提示词规范'),
      )!.content;
      expect(spec).toContain('人数 → 景别 → 机位朝向 → 地点 → 光的方向');
    } finally {
      save.restore();
    }
  });

  it('写实线与 tag 流各自的口径补充不串线', async () => {
    const save = state();
    try {
      settings.defaultBackend = 'comfyui';
      save.preset.naturalLanguage = true;

      save.preset.specDialect = 'moss';
      let contract = await contractOf(options());
      expect(contract).toContain('机位朝向紧跟景别，不得挪到外貌锚点之后');
      expect(contract).not.toContain('极简中文元素行是**同一条**规则');

      save.preset.specDialect = 'comfy';
      contract = await contractOf(options());
      expect(contract).toContain('写在人数之后、外貌之前，不要挪到串尾');
      expect(contract).not.toContain('机位朝向紧跟景别，不得挪到外貌锚点之后');
    } finally {
      save.restore();
    }
  });

  it('纯 tag 协议声明 nl 那条不适用,且只声明一次', async () => {
    const save = state();
    try {
      settings.defaultBackend = 'nai';
      settings.nai.model = 'nai-diffusion-5-full';
      settings.nai.naturalLanguage = false;
      const contract = await contractOf(options());

      const note = '本次输出不含 nl 段：上面关于 nl 的那一条本次不适用';
      expect(contract).toContain(note);
      expect(contract.split(note).length - 1).toBe(1);
    } finally {
      save.restore();
    }
  });

  it('含 nl 的协议里不出现那条「不含 nl」的声明', async () => {
    const save = state();
    try {
      settings.defaultBackend = 'comfyui';
      save.preset.specDialect = 'comfy';
      save.preset.naturalLanguage = true;
      const contract = await contractOf(options());
      expect(contract).not.toContain('本次输出不含 nl 段');
    } finally {
      save.restore();
    }
  });

  it('机位词表只给标准词,不放手让模型自造词组', async () => {
    const save = state();
    try {
      settings.defaultBackend = 'comfyui';
      save.preset.specDialect = 'comfy';
      save.preset.naturalLanguage = true;
      const contract = await contractOf(options());
      expect(contract).toContain('机位词只用模型认识的标准词，不得自造词组');
      expect(contract).toContain('front view（正面）');
      expect(contract).toContain('three-quarter view（四分之三侧面）');
      expect(contract).toContain('side view（正侧）');
      expect(contract).toContain('from behind（背面）');
      expect(contract).toContain('high angle（俯拍）');
      expect(contract).toContain('low angle（仰拍）');
    } finally {
      save.restore();
    }
  });
});


describe('英文身体段改条件段 + 人种收成一处', () => {
  /** 外层 describe 里的 pick 不在这个作用域:本块自带一份同口径的取消息。 */
  function pick(messages: { content: string }[], mark: string): string {
    const found = messages.find(m => m.content.includes(mark));
    expect(found, mark).toBeTruthy();
    return found!.content;
  }

  const state = () => {
    const preset = activeComfyPreset();
    const saved = { backend: settings.defaultBackend, dialect: preset.specDialect };
    return {
      preset,
      restore() {
        settings.defaultBackend = saved.backend;
        preset.specDialect = saved.dialect;
      },
    };
  };

  async function specOf(dialect: 'moss' | 'moss-anime', library?: string) {
    const messages = await buildAutoTagMessages(context(), 1, mossOptions(), null, undefined, library);
    return {
      spec: pick(messages, dialect === 'moss' ? 'MOSS-Image 写实线提示词规范' : 'MOSS 动漫线提示词规范'),
      thinking: pick(messages, dialect === 'moss' ? '输出前思考清单（MOSS 写实线）' : '输出前思考清单（MOSS 动漫线）'),
      contract: messages.find(m => m.content.includes('你是严谨的剧情画面规划与生图提示词编写员'))!.content,
    };
  }

  // 英文身体段曾经是**无条件必写**的一段(规范第三节 B 与思维链第 5 步同口径写死),
  // 而规范自己在开头就写明「同一件事写几遍 = 叠几层权重」。两处同口径地改成
  // 「题材条件段」后,这段话的判据必须让模型自己能判,不能只留一句「可选」。
  it('MOSS 方言:英文身体段改成题材条件段,判据规范与思维链逐条同口径', async () => {
    const save = state();
    try {
      settings.defaultBackend = 'comfyui';
      save.preset.specDialect = 'moss';
      const { spec, thinking } = await specOf('moss');

      // 1) 无条件的两段结构必须消失 —— 这是本次改动的因:旧条文自己打自己
      expect(spec).not.toContain('由「中文散文段 + 英文身体段」两部分组成');
      expect(spec).not.toContain('缺一段都算没写完');
      expect(thinking).not.toContain('缺一段都算没写完');
      expect(thinking).not.toContain('由两段组成');
      // 2) 条件式判据:正例与反例都要写出来,只给一边模型只会一律加或一律不加
      expect(spec).toContain('画面里出现了裸露的躯干或性器官');
      expect(spec).toContain('衣着完整的日常、多人对话、环境镜头 → 不加');
      expect(thinking).toContain('画面里有裸露的躯干或性器官');
      expect(thinking).toContain('衣着完整的日常、多人对话、环境镜头 → 不写');
      // 思维链必须点名规范的判据是**同一条**,不许自己另立
      expect(thinking).toContain('判据与规范第三节 B 同一条');
      // 3) 条件段要写在标题上,否则模型读到「60–120 词」仍会当必做项
      expect(spec).toContain('### B. 英文身体段（**条件段**');
      expect(thinking).toContain('B. 英文身体段（**条件段**');

      // 4) 日常镜头(不加英文段)时,所有「写英文段才有」的下游条文都要有跳过口径,
      //    否则模型会把「没写」当成遗漏:自检、材质层、总检三处最容易漏。
      expect(spec).toContain('本图没写英文段时，这条整条不适用');
      expect(spec).toContain('本图没写英文段时跳过');
      expect(thinking).toContain('第 7 步的材质层并进中文段末尾');
      expect(thinking).toContain('没写英文段就只查前两项');
    } finally {
      save.restore();
    }
  });

  // 人种与年龄被写了三遍(tag / 英文段首句 / 中文段的禁令又提一遍),正是规范自己
  // 点名的「同一信息叠两层权重」。收成只写一处后,三份条文不再互指:
  // tag 是唯一负责方,中文段与英文段都被明确排除。
  it('MOSS 方言:人种与年龄只在 tag 写一次,规范与思维链都不再要求复述', async () => {
    const save = state();
    try {
      settings.defaultBackend = 'comfyui';
      save.preset.specDialect = 'moss';
      const { spec, thinking } = await specOf('moss');

      // 旧口径要求英文段首句给年龄 + 人种 —— 与 tag 的 chinese / twenty years old 打架
      expect(spec).not.toContain('年龄与人种你永远要写');
      expect(spec).not.toContain('英文身体段仍需写：年龄 + 人种（必写）');
      expect(thinking).not.toContain('第一句必须给年龄 + 人种');
      // 新口径三处齐备:tag 独家负责、中文段排除、英文段排除
      expect(spec).toContain('全串唯一一处该写人种的地方');
      expect(spec).toContain('年龄感与人种只归 tag');
      expect(spec).toContain('人种与年龄不在这一段写');
      expect(thinking).toContain('全串唯一写人种与年龄感的地方');
      expect(thinking).toContain('不从年龄与人种写起');
      // tag 的元素顺序里那一格还在(人种仍然要写,只是只写这一处)
      expect(spec).toContain('→ 人种与年龄感 →');

      // 动漫线本来就没有英文身体段,条件段的条文一个字都不该跟过去
      save.preset.specDialect = 'moss-anime';
      const anime = await specOf('moss-anime');
      expect(anime.spec).not.toContain('条件段');
      expect(anime.spec).not.toContain('裸体、裸露、性行为');
      expect(anime.thinking).not.toContain('英文身体段（**条件段**');
    } finally {
      save.restore();
    }
  });


describe('思维链必须收得住', () => {
  // 出图前的 tag 生成是一条串行链路:思考块每多写一段,后面每个字都要等。
  // 实测一次失败的 tag 生成 23.9s,规范与思维链加起来 17.6k 字符塞进 5 条 system。
  // 这里钉住的是「三份思维链都得自己声明预算」——漏一份,那条线就回到无上限的自我复述。
  const chains: [string, string][] = [
    ['comfy', DEFAULT_COMFY_THINKING],
    ['moss', DEFAULT_MOSS_THINKING],
    ['moss-anime', DEFAULT_MOSS_ANIME_THINKING],
  ];

  for (const [name, value] of chains) {
    it(name + ' 的思维链声明了字数预算', () => {
      expect(value).toMatch(/thinking[\s\S]{0,40}(?:字以内|不超过\s*\d{2,4}\s*字)/);
    });
  }

  it('MOSS 写实线的思维链明说这是检查清单,并禁止复述规范', () => {
    expect(DEFAULT_MOSS_THINKING).toContain('这是检查清单，不是推理题');
    expect(DEFAULT_MOSS_THINKING).toContain('不要把规范再抄一遍');
  });

  it('MOSS 写实线的思维链不超过 3600 字符', () => {
    // 上一版 4088。每一段都是模型要逐字读的输入,涨回去就是又慢回去。
    expect(DEFAULT_MOSS_THINKING.length).toBeLessThan(3600);
  });
});

  // 协议侧的库条款(不是规范)也在提英文段:这两句原先把「年龄写法」指到英文段首句,
  // 新口径下那句已经不存在,条款不跟着改就会指向一个不存在的槽位。
  it('MOSS 方言:库条款把年龄人种指回 tag,英文段相关表述改成条件式', async () => {
    const save = state();
    try {
      settings.defaultBackend = 'comfyui';
      save.preset.specDialect = 'moss';
      const library = ['- 林夏 [中文外貌已填]: 性别=1girl, 头发=long black hair'].join('\n');
      const { contract } = await specOf('moss', library);

      // 指向新槽位:只在 tag 里写一次,并且点名 nl 两段都不复述
      expect(contract).toContain('但**只在 tag 里写一次**');
      expect(contract).toContain('nl 的任何一段都不复述');
      // 旧的「英文身体段首句的年龄由你照常写」必须消失(那个槽位已不存在)
      expect(contract).not.toContain('英文身体段首句的年龄');
      // B 类(没有标记)的补外貌改成条件式:没写英文段就只靠 tag 一处
      expect(contract).toContain('没写就只靠 tag 那一处，不要为补外貌硬加一段');
    } finally {
      save.restore();
    }
  });
});

describe('DSH 画面占位请求', () => {
  it('用世界书协议 + JSON 输出契约要三行委托书，不带 tag 流那套规则', async () => {
    const oldBackend = settings.defaultBackend;
    try {
      settings.defaultBackend = 'dshbridge';
      const options = mossOptions({ maxImages: 3 });
      const messages = await buildDshPlaceholderMessages(context(), 1, options, null);
      const joined = messages.map(message => message.content).join('\n---\n');

      // 协议原文整段照搬世界书(格式只有一个真源),且必须先作废「续写」语境
      expect(joined).toContain('【柏宝绘 · 画面占位协议 v2.1】');
      expect(joined).toContain('你这次不是续写正文');
      expect(joined).toContain('一次回复最多一条');
      // 输出契约:JSON 形状、数量、位置、画幅
      expect(joined).toContain('"dsh"');
      expect(joined).toContain('images 数量必须在 0～3 之间');
      expect(joined).toContain('P编号');
      expect(joined).toContain('拿不准就填 "portrait"');
      // 不能把 tag 流的契约混进来(两套规则同时在,模型只会折中)
      expect(joined).not.toContain('你是严谨的剧情画面规划与生图提示词编写员');
      expect(joined).not.toContain('【角色固定外貌库】');

      const user = messages[messages.length - 1];
      expect(user.role).toBe('user');
      expect(user.content).toContain('--- 目标正文｜assistant（Char） ---');
      expect(user.content).toContain('⟦P1⟧');
    } finally {
      settings.defaultBackend = oldBackend;
    }
  });

  it('委托单规范可编辑，破限词置顶拼在规范之前（破限 + 世界书）', async () => {
    const oldBackend = settings.defaultBackend;
    try {
      settings.defaultBackend = 'dshbridge';
      const messages = await buildDshPlaceholderMessages(
        context(),
        1,
        mossOptions({
          prompts: prompts({ jailbreak: '我的破限词', dshSpec: '我的委托单规范' }),
        }),
        null,
      );
      // 破限永远第一条 system:与自动 tag 链路同一个位置,不随规范变
      expect(messages[0]).toEqual({ role: 'system', content: '我的破限词' });
      const specMessage = messages.find(message => message.content.includes('我的委托单规范'));
      expect(specMessage).toBeTruthy();
      // 用户规范替换掉内置那一份(内含世界书原文),但输出契约仍由插件追加
      expect(messages.map(message => message.content).join('\n').includes('【柏宝绘 · 画面占位协议 v2.1】')).toBe(false);
      expect(specMessage?.content).toContain('**本次输出契约**');
      expect(specMessage?.content).toContain('"dsh"');
      expect(specMessage?.content).toContain('images 数量必须在');
    } finally {
      settings.defaultBackend = oldBackend;
    }
  });

  it('世界书里常驻的同一条协议会被摘掉，避免同一组规则叠两层', () => {
    const worldInfo = '【别的条目】一些设定\n\n' + DSH_WORLDBOOK_ENTRY;
    const deduped = dedupeProtocolFromWorldInfo(worldInfo, DEFAULT_DSH_PLACEHOLDER_SPEC);
    expect(deduped).not.toContain('【柏宝绘 · 画面占位协议 v2.1】');
    expect(deduped).toContain('此处不再重复');
    expect(deduped).toContain('【别的条目】');
    // 用户把协议从规范里删掉时，世界书那份是唯一来源，不许动它
    expect(dedupeProtocolFromWorldInfo(worldInfo, '自定义规范')).toBe(worldInfo);
    // 没有命中就原样返回（不改动无关内容）
    expect(dedupeProtocolFromWorldInfo('只有设定', DEFAULT_DSH_PLACEHOLDER_SPEC)).toBe('只有设定');
  });

  it('下限大于 0 时改口要求补足，而不是允许空数组', async () => {
    const oldBackend = settings.defaultBackend;
    try {
      settings.defaultBackend = 'dshbridge';
      const messages = await buildDshPlaceholderMessages(
        context(),
        1,
        mossOptions({ minImages: 2, maxImages: 2 }),
        null,
      );
      const joined = messages.map(message => message.content).join('\n---\n');
      expect(joined).toContain('images 数量必须在 2～2 之间');
      expect(joined).not.toContain('时可以返回空数组');
    } finally {
      settings.defaultBackend = oldBackend;
    }
  });
});
