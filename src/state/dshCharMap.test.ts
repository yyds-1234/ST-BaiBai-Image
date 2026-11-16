import { describe, expect, it } from 'vitest';
import {
  DSH_CHAR_MAP_MAX,
  DSH_UNCLAIMED_MAX,
  dshMappingLabel,
  dshMappingValue,
  mergeAutoMappings,
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

describe('planDshCharacters:占位里点名、但没人认领的人（桥接 2.25.0）', () => {
  // 实测（2026-11-16）：「人物名称：安柏、涛」，只有映射过的 安柏 发了出去，涛 从头到尾
  // 没进过管道 —— 没档案、没形象块、也没有归属外壳，成了没有脸的路人。
  // 协议本来就允许「只给名字」，冒号后面那段由 DSH 自己解析（档案 → 动漫表 → 自动建档）。
  const THREE_LINES = (names: string) =>
    `人物名称：${names}\n人物服装：安柏：红制服\n场景描述：傍晚的宿舍，她弯下腰`;

  it('没有映射、角色库里也没有块 → 发裸名字', () => {
    const plan = planDshCharacters({
      text: THREE_LINES('安柏、涛'),
      roles: [],
      mappings: [],
      line: 'moss-real',
    });
    expect(plan.characters).toEqual(['安柏', '涛']);
    expect(plan.roles).toEqual([]);
  });

  it('角色库里有块的人不发裸名字（那走 roles 旁路，两套长相会打架）', () => {
    const plan = planDshCharacters({
      text: THREE_LINES('安柏、林夏'),
      roles: [{ name: '林夏', charBlock: '1girl, long black hair' }],
      mappings: [],
      line: 'moss-real',
    });
    expect(plan.characters).toEqual(['安柏']);
    expect(plan.roles).toEqual([{ name: '林夏', charBlock: '1girl, long black hair' }]);
  });

  it('映射表里有的名字不发裸名字 —— 包括因线不符被跳过的人（那是用户指定的归宿）', () => {
    const plan = planDshCharacters({
      text: THREE_LINES('林夏、涛'),
      roles: [],
      mappings: [ARCHIVE],
      line: 'moss-anime',
    });
    expect(plan.characters).toEqual(['涛']);
    expect(plan.skipped).toEqual([{ name: '林夏', ref: '26-小静', reason: 'line' }]);
  });

  it('空镜 / 指代词不发（「无」「我」「她」都不是一个人）', () => {
    for (const names of ['无', '我、她', '他']) {
      const plan = planDshCharacters({ text: THREE_LINES(names), roles: [], mappings: [], line: 'moss-real' });
      expect(plan.characters).toEqual([]);
    }
  });

  it('老的一段散文占位（没有「人物名称：」那行）→ 一个裸名字都不发', () => {
    const plan = planDshCharacters({
      text: '她在天台上回头，风把头发吹到脸上',
      roles: [],
      mappings: [],
      line: 'moss-real',
    });
    expect(plan.characters).toEqual([]);
  });

  it('顺序仍按首次出现位置：第一位站主角位（映射过的与未认领的混排）', () => {
    const plan = planDshCharacters({
      text: THREE_LINES('涛、林夏'),
      roles: [],
      mappings: [ARCHIVE],
      line: 'moss-real',
    });
    expect(plan.characters).toEqual(['涛', '林夏：26-小静']);
  });

  it('未认领的人有上限（占位最多两个名字，防手滑）', () => {
    const plan = planDshCharacters({
      text: THREE_LINES('甲、乙、丙、丁、戊、己'),
      roles: [],
      mappings: [],
      line: 'moss-real',
    });
    expect(plan.characters).toHaveLength(DSH_UNCLAIMED_MAX);
    expect(plan.characters[0]).toBe('甲');
  });
});
describe('mergeAutoMappings:DSH 认出来后自动建档（桥接 2.15.0 / 2.16.0）', () => {
  const CATALOG_PICK = { label: '胡桃', ref: 'hu tao (genshin impact)', kind: 'catalog', line: 'moss-anime' };
  // 档案那一路一律不建（2026-11-14 用户口径：真人线不自动认人/建档，档案映射必须手动配）。
  const GENERIC_ARCHIVE = { label: '瑶瑶', ref: '26-小静', kind: 'archive', line: '' };
  const BOUND_ARCHIVE = { label: '林夏', ref: '40-林夏', kind: 'archive', line: 'moss-real' };

  it('动漫角色 → 新建一条 auto 映射,绑的是这一单实际生效的线', () => {
    const row: DshCharMapping = {
      name: '胡桃',
      kind: 'catalog',
      ref: 'hu tao (genshin impact)',
      line: 'moss-anime',
      auto: true,
    };
    const merged = mergeAutoMappings([], [CATALOG_PICK], 'moss-anime');
    expect(merged.added).toEqual([row]);
    expect(merged.mappings).toEqual([row]);
    // 建好之后下一单开头就是 characters: ['胡桃：hu tao (genshin impact)'] —— 正常机械查表。
    const plan = planDshCharacters({
      text: '胡桃站在门口',
      roles: [],
      mappings: merged.mappings,
      line: 'moss-anime',
    });
    expect(plan.characters).toEqual(['胡桃：hu tao (genshin impact)']);
  });

  it('档案一律不建：通用档案、绑线档案、真人线认到的档案，都不进映射表', () => {
    for (const pick of [GENERIC_ARCHIVE, BOUND_ARCHIVE]) {
      const merged = mergeAutoMappings([], [pick], 'moss-real');
      expect(merged.mappings).toEqual([]);
      expect(merged.added).toEqual([]);
      expect(merged.updated).toEqual([]);
    }
    // 混着回来也只建动漫那一条（DSH 正常不会再在真人线认人，这是防御）。
    const merged = mergeAutoMappings([], [BOUND_ARCHIVE, CATALOG_PICK], 'moss-anime');
    expect(merged.added.map(row => row.kind)).toEqual(['catalog']);
  });

  it('老插件（2.15.0，pick 不带 line）的动漫角色退回本单的线', () => {
    const merged = mergeAutoMappings(
      [],
      [{ label: '胡桃', ref: 'hu tao (genshin impact)', kind: 'catalog' }],
      'moss-anime',
    );
    expect(merged.added).toEqual([
      { name: '胡桃', kind: 'catalog', ref: 'hu tao (genshin impact)', line: 'moss-anime', auto: true },
    ]);
  });

  it('同名已有用户手挑的行 → 一个字都不动（尊重用户的选择）', () => {
    const manual: DshCharMapping = {
      name: '胡桃',
      kind: 'catalog',
      ref: 'hu tao (lawson) (genshin impact)',
      line: 'moss-anime',
    };
    const merged = mergeAutoMappings([manual], [CATALOG_PICK], 'moss-anime');
    expect(merged.mappings).toEqual([manual]);
    expect(merged.added).toEqual([]);
    expect(merged.updated).toEqual([]);
  });

  it('自动建过的行跟着 DSH 这次的结果更新指向；线变了也一起改', () => {
    const old: DshCharMapping = {
      name: '胡桃',
      kind: 'catalog',
      ref: 'hu tao (genshin impact)',
      line: 'moss-real',
      auto: true,
    };
    const merged = mergeAutoMappings([old], [CATALOG_PICK], 'moss-anime');
    expect(merged.added).toEqual([]);
    const expected: DshCharMapping = {
      name: '胡桃',
      kind: 'catalog',
      ref: 'hu tao (genshin impact)',
      line: 'moss-anime',
      auto: true,
    };
    expect(merged.updated).toEqual([expected]);
    expect(merged.mappings[0]).toEqual(expected);
  });

  it('同一个名字重复出现只建一条（并列两次不会变成两行）', () => {
    const merged = mergeAutoMappings([], [CATALOG_PICK, CATALOG_PICK], 'moss-anime');
    expect(merged.mappings).toHaveLength(1);
    expect(merged.added).toHaveLength(1);
  });

  it('动漫角色缺线（老插件 + 调用方也没线）就不建 —— 绑错线等于白建', () => {
    const merged = mergeAutoMappings(
      [],
      [{ label: '胡桃', ref: 'hu tao (genshin impact)', kind: 'catalog' }],
      '  ',
    );
    expect(merged.mappings).toEqual([]);
  });

  it('行数到上限就不再追加，但仍返回已有表', () => {
    const full = Array.from({ length: DSH_CHAR_MAP_MAX }, (_, i) => ({
      name: `角色${i}`,
      kind: 'archive' as const,
      ref: '26-小静',
      line: 'moss-real',
    }));
    const merged = mergeAutoMappings(full, [CATALOG_PICK], 'moss-anime');
    expect(merged.added).toEqual([]);
    expect(merged.mappings).toHaveLength(DSH_CHAR_MAP_MAX);
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
