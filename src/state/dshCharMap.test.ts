import { describe, expect, it } from 'vitest';
import {
  DSH_CHAR_MAP_MAX,
  dshMappingLabel,
  dshMappingValue,
  normalizeDshCharMappings,
  parseDshMappingValue,
  planDshCharacters,
  type DshCharMapping,
} from '@/state/dshCharMap';

/**
 * 这份单测守的是**发请求前那道机械判定**:谁进 characters、谁留在 roles、谁被跳过。
 * 它不测 DSH 侧怎么解析(那边有自己的账),也不测网络 —— 出问题时要能一眼指出是哪一步。
 */

const ARCHIVE: DshCharMapping = { name: '林夏', kind: 'archive', ref: '26-小静', line: 'moss-real' };
const CATALOG: DshCharMapping = { name: '胡桃', kind: 'catalog', ref: 'hu tao (genshin impact)', line: 'moss-anime' };

describe('normalizeDshCharMappings:设置里存的那张表', () => {
  it('丢掉空行 / 只填一半的行 / kind 不认识的行', () => {
    expect(
      normalizeDshCharMappings([
        { name: '', kind: 'archive', ref: '26-小静', line: '' },
        { name: '林夏', kind: 'archive', ref: '', line: '' },
        { name: '林夏', kind: 'weird', ref: '26-小静', line: '' },
        { name: '林夏', kind: 'archive', ref: '26-小静', line: 'moss-real' },
        null,
        'nope',
      ]),
    ).toEqual([{ name: '林夏', kind: 'archive', ref: '26-小静', line: 'moss-real' }]);
  });

  it('同名只留第一条:同一个名字映射两处 = 两套长相在串里打架', () => {
    expect(
      normalizeDshCharMappings([
        { name: '林夏', kind: 'archive', ref: '26-小静', line: 'moss-real' },
        { name: '林夏', kind: 'catalog', ref: 'hu tao (genshin impact)', line: 'moss-anime' },
      ]),
    ).toEqual([{ name: '林夏', kind: 'archive', ref: '26-小静', line: 'moss-real' }]);
  });

  it('去掉首尾空白、限制长度、限制行数', () => {
    const rows = Array.from({ length: DSH_CHAR_MAP_MAX + 5 }, (_, i) => ({
      name: ` 角色${i} `,
      kind: 'archive' as const,
      ref: ' 26-小静 ',
      line: ' moss-real ',
    }));
    const out = normalizeDshCharMappings(rows);
    expect(out).toHaveLength(DSH_CHAR_MAP_MAX);
    expect(out[0]).toEqual({ name: '角色0', kind: 'archive', ref: '26-小静', line: 'moss-real' });
    expect(normalizeDshCharMappings(rows.map(r => ({ ...r, name: 'x'.repeat(100) })))[0].name).toHaveLength(24);
  });

  it('非数组一律空表(老配置里这个键不存在)', () => {
    expect(normalizeDshCharMappings(undefined)).toEqual([]);
    expect(normalizeDshCharMappings(null)).toEqual([]);
    expect(normalizeDshCharMappings({})).toEqual([]);
  });
});

describe('planDshCharacters:出图前算「谁按档案画、谁按角色库画」', () => {
  const roles = [
    { name: '林夏', charBlock: '1girl, long black hair' },
    { name: '许梨', charBlock: '1girl, silver hair' },
  ];

  it('名字在文本里出现 → 发 characters，并从 roles 里摘掉', () => {
    const plan = planDshCharacters({
      text: '人物名称：林夏\n人物服装：米色长风衣\n场景描述：傍晚的天台',
      roles,
      mappings: [ARCHIVE],
      line: 'moss-real',
    });
    expect(plan.characters).toEqual(['林夏：26-小静']);
    expect(plan.roles).toEqual([{ name: '许梨', charBlock: '1girl, silver hair' }]);
    expect(plan.skipped).toEqual([]);
  });

  it('名字没出现在文本里 → 什么都不发(映射不是「每单都注入」)', () => {
    const plan = planDshCharacters({
      text: '人物名称：许梨\n人物服装：白裙\n场景描述：门口',
      roles,
      mappings: [ARCHIVE],
      line: 'moss-real',
    });
    expect(plan.characters).toEqual([]);
    expect(plan.roles).toEqual(roles);
  });

  it('通用档案（line 留空）哪条线都能用', () => {
    const plan = planDshCharacters({
      text: '林夏回头',
      roles: [],
      mappings: [{ name: '林夏', kind: 'archive', ref: '32-我', line: '' }],
      line: 'krea2-moody',
    });
    expect(plan.characters).toEqual(['林夏：32-我']);
  });

  it('档案绑在别的线 → 跳过并记账（DSH lineGate=strict 会整单报错）', () => {
    const plan = planDshCharacters({
      text: '林夏回头',
      roles,
      mappings: [ARCHIVE],
      line: 'moss-anime',
    });
    expect(plan.characters).toEqual([]);
    expect(plan.skipped).toEqual([{ name: '林夏', ref: '26-小静', reason: 'line' }]);
    // 跳过的人保留本地块:有长相总比没有强,而且用户至少还能把线切回来
    expect(plan.roles).toEqual(roles);
  });

  it('动漫角色必须与本线完全一致（每条线查各自的表）', () => {
    const onAnime = planDshCharacters({ text: '胡桃站在门口', roles: [], mappings: [CATALOG], line: 'moss-anime' });
    expect(onAnime.characters).toEqual(['胡桃：hu tao (genshin impact)']);
    const onReal = planDshCharacters({ text: '胡桃站在门口', roles: [], mappings: [CATALOG], line: 'moss-real' });
    expect(onReal.characters).toEqual([]);
    expect(onReal.skipped[0]).toEqual({ name: '胡桃', ref: 'hu tao (genshin impact)', reason: 'line' });
  });

  it('顺序按首次出现位置:第一位站主角位', () => {
    const plan = planDshCharacters({
      text: '人物名称：许梨与林夏',
      roles: [],
      mappings: [
        ARCHIVE,
        { name: '许梨', kind: 'archive', ref: '33-马库斯', line: 'moss-real' },
      ],
      line: 'moss-real',
    });
    expect(plan.characters).toEqual(['许梨：33-马库斯', '林夏：26-小静']);
  });

  it('长名优先:「雪」的映射不会把「小雪」也吃掉', () => {
    const plan = planDshCharacters({
      text: '小雪走过来',
      roles: [],
      mappings: [
        { name: '雪', kind: 'archive', ref: '27-小峰', line: 'moss-real' },
        { name: '小雪', kind: 'archive', ref: '30-岳母', line: 'moss-real' },
      ],
      line: 'moss-real',
    });
    expect(plan.characters).toEqual(['小雪：30-岳母']);
  });

  it('空映射表 / 空文本 = 原样不动（老行为逐字不变）', () => {
    expect(planDshCharacters({ text: '林夏', roles, mappings: [], line: 'moss-real' })).toEqual({
      characters: [],
      roles,
      skipped: [],
    });
    expect(planDshCharacters({ text: '  ', roles, mappings: [ARCHIVE], line: 'moss-real' })).toEqual({
      characters: [],
      roles,
      skipped: [],
    });
  });
});

describe('选择器编码', () => {
  it('value ↔ kind/ref 往返', () => {
    expect(dshMappingValue(ARCHIVE)).toBe('archive:26-小静');
    expect(parseDshMappingValue('archive:26-小静')).toEqual({ kind: 'archive', ref: '26-小静' });
    expect(parseDshMappingValue('catalog:hu tao (genshin impact)')).toEqual({
      kind: 'catalog',
      ref: 'hu tao (genshin impact)',
    });
  });

  it('认不出来的值返回 null（空串 = 没选）', () => {
    expect(parseDshMappingValue('')).toBeNull();
    expect(parseDshMappingValue('archive:')).toBeNull();
    expect(parseDshMappingValue('26-小静')).toBeNull();
    expect(parseDshMappingValue('other:x')).toBeNull();
  });

  it('标签带线,便于在面板里一眼看出绑在哪条线', () => {
    expect(dshMappingLabel(ARCHIVE)).toBe('档案 · 26-小静（moss-real）');
    expect(dshMappingLabel({ ...ARCHIVE, line: '' })).toBe('档案 · 26-小静');
    expect(dshMappingLabel(CATALOG)).toBe('动漫 · hu tao (genshin impact)（moss-anime）');
  });
});
