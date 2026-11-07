import { describe, expect, it } from 'vitest';

import {
  BBI_CHAR_EXTRA_KEY,
  applyCharTagOps,
  charTagLib,
  chineseAppearanceForText,
  computeLockedCharTagNames,
  createCharTagNewOp,
  createCharTagSetOp,
  deriveCharTags,
  emptyCharFields,
  mergeCharTagSeed,
  normalizeCharTagStore,
  rolesForText,
  type CharTagAutoOp,
} from '@/state/charTags';
import type { STMessage } from '@/st/context';

function floorMessage(ops: CharTagAutoOp[], swipe = 0, storedSwipe = swipe): STMessage {
  return {
    name: 'Char',
    is_user: false,
    is_system: false,
    mes: '正文',
    swipes: ['正文', '另一页'],
    swipe_id: swipe,
    extra: {
      [BBI_CHAR_EXTRA_KEY]: { v: 1, swipe: storedSwipe, ops },
    },
  };
}

describe('char tags store normalize', () => {
  it('keeps valid structured entries and normalizes fields', () => {
    const entries = normalizeCharTagStore({
      version: 2,
      entries: [
        {
          name: '阿黛尔',
          fields: { sex: '1girl', hair: ' short silver hair ' },
          source: 'book',
          desc: '银色短发',
        },
        { name: ' 铁匠老周 ', fields: { sex: '1boy' }, source: 'manual' },
      ],
    });
    expect(entries).toEqual([
      {
        name: '阿黛尔',
        fields: { fandom: '', sex: '1girl', hair: 'short silver hair', eyes: '', skin: '', body: '', extra: '', outfit: '' },
        raw: '',
        nl: '',
        source: 'book',
        desc: '银色短发',
        history: [],
      },
      {
        name: '铁匠老周',
        fields: { fandom: '', sex: '1boy', hair: '', eyes: '', skin: '', body: '', extra: '', outfit: '' },
        raw: '',
        nl: '',
        source: 'manual',
        desc: '',
        history: [],
      },
    ]);
  });

  it('migrates v1 legacy tags string into raw mode', () => {
    const entries = normalizeCharTagStore({
      version: 1,
      entries: [{ name: '旧角色', tags: '1girl, red eyes', source: 'book', desc: '红瞳' }],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].raw).toBe('1girl, red eyes');
    expect(entries[0].fields).toEqual({ fandom: '', sex: '', hair: '', eyes: '', skin: '', body: '', extra: '', outfit: '' });
    expect(entries[0].source).toBe('book');
    expect(entries[0].desc).toBe('红瞳');
  });

  it('drops entries without any usable content', () => {
    const entries = normalizeCharTagStore({
      version: 2,
      entries: [
        { name: '', fields: { sex: '1girl' } },
        { name: '空的', fields: {} },
        { name: '空白', fields: { hair: '   ' }, raw: ' ' },
        'not-an-object',
      ],
    });
    expect(entries).toEqual([]);
  });

  it('unknown source falls back to manual; history records are sanitized', () => {
    const entries = normalizeCharTagStore({
      version: 2,
      entries: [
        {
          name: '路人',
          fields: { sex: '1girl' },
          source: 'weird',
          history: [
            { field: 'hair', from: 'long', to: 'short', reason: '剪发', floor: 42, at: 1 },
            { field: 'bogus', from: 'x', to: 'y' },
            'junk',
          ],
        },
      ],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].source).toBe('manual');
    expect(entries[0].history).toEqual([
      { field: 'hair', from: 'long', to: 'short', reason: '剪发', floor: 42, at: 1 },
    ]);
  });

  it('dedupes by name, keeping the first occurrence', () => {
    const entries = normalizeCharTagStore({
      version: 2,
      entries: [
        { name: '阿黛尔', fields: { sex: 'a' }, source: 'book', desc: 'd1' },
        { name: '阿黛尔', fields: { sex: 'b' }, source: 'manual' },
      ],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].fields.sex).toBe('a');
  });

  it('returns empty for malformed stores', () => {
    expect(normalizeCharTagStore(null)).toEqual([]);
    expect(normalizeCharTagStore({ version: 2 })).toEqual([]);
    expect(normalizeCharTagStore('junk')).toEqual([]);
  });
});

describe('floor-owned character changes', () => {
  it('removes a character when its creation floor is deleted', () => {
    const create = createCharTagNewOp({
      name: '小雪',
      fields: { ...emptyCharFields(), sex: '1girl', hair: 'long black hair' },
      raw: '',
      nl: '',
      source: 'ai',
      desc: '',
    })!;
    const cutHair = createCharTagSetOp('小雪', 'hair', 'short black hair', '剪发')!;
    const chat = [floorMessage([create]), floorMessage([cutHair])];

    expect(deriveCharTags([], chat)[0].fields.hair).toBe('short black hair');
    chat.splice(0, 1);
    expect(deriveCharTags([], chat)).toEqual([]);
  });

  it('reverts a field when only the later change floor is deleted', () => {
    const create = createCharTagNewOp({
      name: '小雪',
      fields: { ...emptyCharFields(), hair: 'long black hair' },
      raw: '',
      nl: '',
      source: 'book',
      desc: '黑色长发',
    })!;
    const cutHair = createCharTagSetOp('小雪', 'hair', 'short black hair', '剪发')!;
    const chat = [floorMessage([create]), floorMessage([cutHair])];

    chat.pop();
    const [entry] = deriveCharTags([], chat);
    expect(entry.fields.hair).toBe('long black hair');
    expect(entry.history).toHaveLength(1);
    expect(entry.history[0].floor).toBe(0);
  });

  it('ignores changes copied from another swipe', () => {
    const create = createCharTagNewOp({
      name: '旧页角色',
      fields: { ...emptyCharFields(), sex: '1girl' },
      raw: '',
      nl: '',
      source: 'ai',
      desc: '',
    })!;
    expect(deriveCharTags([], [floorMessage([create], 1, 0)])).toEqual([]);
  });
});

describe('中文外貌(zh)的认人与拼接', () => {
  /** 直接往派生库里塞条目:chineseAppearanceForText 读的是 charTagLib,不走 getContext。 */
  function seed(entries: Array<{ name: string; zh?: string }>): void {
    charTagLib.entries = entries.map(entry => ({
      name: entry.name,
      fields: emptyCharFields(),
      raw: '1girl',
      nl: '',
      ...(entry.zh ? { zh: entry.zh } : {}),
      source: 'manual' as const,
      desc: '',
      history: [],
    }));
  }

  it('名字在 tag 或 nl 里字面出现时拼出该角色的中文外貌', () => {
    seed([{ name: '林夏', zh: '鹅蛋脸,单眼皮,皮肤偏白。' }]);
    // 每段前面带名字:多人同框时靠它把描述绑定到具体角色
    expect(chineseAppearanceForText('1girl, 林夏, medium shot')).toBe('林夏：鹅蛋脸,单眼皮,皮肤偏白。');
    expect(chineseAppearanceForText('林夏坐在窗边。')).toBe('林夏：鹅蛋脸,单眼皮,皮肤偏白。');
  });

  it('没出现的角色不拼;没填 zh 的也不拼', () => {
    seed([
      { name: '林夏', zh: '鹅蛋脸。' },
      { name: '苏曼', zh: '圆脸,双眼皮。' },
      { name: '许梨' },
    ]);
    expect(chineseAppearanceForText('1girl, medium shot')).toBe('');
    expect(chineseAppearanceForText('苏曼站在门口。')).toBe('苏曼：圆脸,双眼皮。');
    expect(chineseAppearanceForText('许梨走过来。')).toBe('');
  });

  it('长名覆盖短名:被测文本只提到「小雪」时不额外拼「雪」那一条', () => {
    seed([
      { name: '雪', zh: '短名描述。' },
      { name: '小雪', zh: '长名描述。' },
    ]);
    // "小雪" 包含 "雪":若不做覆盖判断,同一个人会被拼两段
    expect(chineseAppearanceForText('小雪走过来。')).toBe('小雪：长名描述。');
    // 只有 "雪" 字出现时才轮到短名那条
    expect(chineseAppearanceForText('雪落在肩上。')).toBe('雪：短名描述。');
  });

  it('两个不相干的角色都在场时各拼一段,顺序按名字长度降序', () => {
    seed([
      { name: '林夏', zh: '鹅蛋脸。' },
      { name: '苏曼', zh: '圆脸。' },
    ]);
    expect(chineseAppearanceForText('林夏和苏曼站在门口。')).toBe('林夏：鹅蛋脸。 苏曼：圆脸。');
  });

  it('中文外貌里的换行被折成空格(与 nl 的 sanitizeContent 同口径)', () => {
    seed([{ name: '林夏', zh: '鹅蛋脸,\r\n单眼皮,\n皮肤偏白。' }]);
    // 不折的话,中文外貌会成为整条正向里唯一带换行的段落
    expect(chineseAppearanceForText('林夏')).toBe('林夏：鹅蛋脸, 单眼皮, 皮肤偏白。');
  });

  it('名称为空或 zh 全是空白的条目不会被拼进来', () => {
    seed([
      { name: '林夏', zh: '   ' },
      { name: '  ', zh: '不该出现。' },
    ]);
    expect(chineseAppearanceForText('林夏')).toBe('');
  });

  it('空文本与空库都返回空串', () => {
    seed([{ name: '林夏', zh: '鹅蛋脸。' }]);
    expect(chineseAppearanceForText('')).toBe('');
    expect(chineseAppearanceForText('   ')).toBe('');
    seed([]);
    expect(chineseAppearanceForText('林夏')).toBe('');
  });

  it('zh 能经由 set op 写入,并随条目落库', () => {
    const op = createCharTagSetOp('林夏', 'zh', '鹅蛋脸,单眼皮。', '补中文外貌');
    expect(op).not.toBeNull();
    const entries = applyCharTagOps(
      [{
        name: '林夏',
        fields: emptyCharFields(),
        raw: '1girl',
        nl: '',
        source: 'manual',
        desc: '',
        history: [],
      }],
      [op!],
      -1,
    );
    expect(entries[0].zh).toBe('鹅蛋脸,单眼皮。');
  });

  it('存量条目没有 zh 键时不会因为读它而崩,也不会凭空多出空键', () => {
    const [entry] = normalizeCharTagStore({
      entries: [{ name: '阿黛尔', fields: { hair: 'long black hair' }, raw: '' }],
    });
    expect(entry.zh).toBeUndefined();
    expect('zh' in entry).toBe(false);
    expect(chineseAppearanceForText('阿黛尔')).toBe('');
  });
});

describe('rolesForText：交给 DSH 的角色块（旁路）', () => {
  /** 与上面同一套塞库手法:rolesForText 也读 charTagLib。 */
  function seed(entries: Array<{ name: string; raw?: string; fields?: Record<string, string> }>): void {
    charTagLib.entries = entries.map(entry => ({
      name: entry.name,
      fields: { ...emptyCharFields(), ...(entry.fields ?? {}) },
      raw: entry.raw ?? '1girl',
      nl: '',
      source: 'manual' as const,
      desc: '',
      history: [],
    }));
  }

  it('按名字认出在场角色，给出英文块', () => {
    seed([{ name: '林夏', raw: '1girl, long black hair' }]);
    expect(rolesForText('傍晚的天台，林夏靠着栏杆回头')).toEqual([
      { name: '林夏', charBlock: '1girl, long black hair' },
    ]);
  });

  it('结构化字段按固定顺序拼成块（与本地后端拼 tag 同一口径）', () => {
    seed([{ name: '林夏', raw: '', fields: { sex: '1girl', hair: 'long black hair', eyes: 'red eyes' } }]);
    expect(rolesForText('林夏回头')).toEqual([
      { name: '林夏', charBlock: '1girl, long black hair, red eyes' },
    ]);
  });

  it('没出场的角色不进清单；空块的条目也不进', () => {
    seed([
      { name: '林夏', raw: '1girl, long black hair' },
      { name: '苏曼', raw: '1girl, short hair' },
      { name: '许梨', raw: '', fields: {} },
    ]);
    // 「许梨」被提到了，但她的块是空串：交给 DSH 等于说「这个角色没长相」，
    // 结果是不注入，还会在回执里被当成「档案缺形象块」报出来。
    expect(rolesForText('林夏和许梨在门口')).toEqual([
      { name: '林夏', charBlock: '1girl, long black hair' },
    ]);
  });

  it('长名覆盖短名，与中文外貌走同一个认人函数', () => {
    seed([
      { name: '雪', raw: '1girl, white hair' },
      { name: '小雪', raw: '1girl, silver hair' },
    ]);
    expect(rolesForText('小雪走过来')).toEqual([{ name: '小雪', charBlock: '1girl, silver hair' }]);
  });

  it('空文本与空库给出空清单（调用方据此不传该字段）', () => {
    seed([{ name: '林夏', raw: '1girl' }]);
    expect(rolesForText('')).toEqual([]);
    expect(rolesForText('   ')).toEqual([]);
    seed([]);
    expect(rolesForText('林夏')).toEqual([]);
  });
});
describe('global library merge & lock', () => {
  const globalEntry = (name: string, fields: Record<string, string>) => ({
    name,
    fields: { ...emptyCharFields(), ...fields },
    raw: '',
    nl: '',
    source: 'manual' as const,
    desc: '',
    history: [],
  });

  it('mergeCharTagSeed: 本聊天同名条目优先,全局只补同名空缺', () => {
    const chat = [globalEntry('小雪', { hair: 'short red hair' })];
    const global = [globalEntry('小雪', { hair: 'long black hair' }), globalEntry('玩家', { sex: '1boy' })];
    const merged = mergeCharTagSeed(chat, global);
    expect(merged).toHaveLength(2);
    expect(merged.find(e => e.name === '小雪')?.fields.hair).toBe('short red hair');
    expect(merged.find(e => e.name === '玩家')?.fields.sex).toBe('1boy');
    // 无全局时原样返回(零开销路径)
    expect(mergeCharTagSeed(chat, [])).toBe(chat);
  });

  it('computeLockedCharTagNames: 只有「全局独有」的名字被锁定;本聊天同名即解锁', () => {
    const global = [globalEntry('玩家', { sex: '1boy' }), globalEntry('小雪', { sex: '1girl' })];
    expect([...computeLockedCharTagNames([], global)].sort()).toEqual(['小雪', '玩家']);
    expect([...computeLockedCharTagNames([globalEntry('小雪', { sex: '1girl' })], global)]).toEqual(['玩家']);
    expect(computeLockedCharTagNames([], []).size).toBe(0);
  });

  it('applyCharTagOps: 锁定名的 new 与 set 一律丢弃', () => {
    const locked = new Set(['玩家']);
    const create = createCharTagNewOp({
      name: '玩家',
      fields: { ...emptyCharFields(), sex: '1boy', hair: 'short black hair' },
      raw: '',
      nl: '',
      source: 'ai',
      desc: '',
    })!;
    const dye = createCharTagSetOp('玩家', 'hair', 'long red hair', '染发')!;
    const base = [globalEntry('玩家', { sex: '1boy', hair: 'short black hair' })];
    const out = applyCharTagOps(base, [create, dye], 3, locked);
    expect(out[0].fields.hair).toBe('short black hair');
    expect(out[0].history).toEqual([]);
    // 不传 locked 时旧行为不变
    const out2 = applyCharTagOps(base, [dye], 3);
    expect(out2[0].fields.hair).toBe('long red hair');
  });

  it('deriveCharTags: 旧消息里针对锁定角色的楼层 ops 重放时失效', () => {
    const dye = createCharTagSetOp('玩家', 'hair', 'long red hair', '染发')!;
    const chat = [floorMessage([dye])];
    const base = [globalEntry('玩家', { sex: '1boy', hair: 'short black hair' })];
    expect(deriveCharTags(base, chat, chat.length, new Set(['玩家']))[0].fields.hair).toBe('short black hair');
    expect(deriveCharTags(base, chat)[0].fields.hair).toBe('long red hair');
  });
});
