/**
 * 「档案映射」:把画面占位里写的**名字**映射到 DSH 侧的角色来源。
 *
 * 这条通道解决的是一个具体的错位:
 *   - 世界书让主模型在「人物名称：」那一行写名字(林夏);
 *   - DSH 侧的角色长相在它自己的 `identities/*.md` 里(26-小静),或动漫线的角色表里
 *     (`hu tao (genshin impact)`);
 *   - 两边**不必同名** —— 柏宝绘看不到 DSH 的磁盘,DSH 也不知道这本书里谁叫林夏。
 *
 * 于是:柏宝绘从桥接的 `GET /identities` / `GET /catalog` 把候选名字拉进面板让人挑,
 * 选中后存成一张「名字 → 档案 id / 动漫角色名」的表(随设置存,跨聊天),出图时按占位文本
 * 命中就发 `characters: ['林夏：26-小静']` 给 DSH。
 *
 * 【为什么不在这里塞外貌】长相(形象块 / LoRA / 风格档)的真源在 DSH 的档案里。柏宝绘只回答
 * 「这一单画谁」,DSH 回答「这个人长什么样」—— 两边各管一件事,改档案不必动柏宝绘。
 *
 * 【本模块是纯函数】不 import settings / 不碰网络,单测能直接跑(同 shotspec / dupes 的纪律)。
 */

/** 映射的两条去向:DSH 档案,或动漫线的角色表。 */
export type DshCharMapKind = 'archive' | 'catalog';

/** 名字 → 角色来源的一行映射。 */
export interface DshCharMapping {
  /** 占位「人物名称：」里写的名字(按字面匹配,大小写敏感 —— 中文名基本不受影响)。 */
  name: string;
  kind: DshCharMapKind;
  /** 档案 id(`26-小静`)或动漫表角色名(`hu tao (genshin impact)`)。 */
  ref: string;
  /**
   * 这条映射绑的配置集 id(空串 = 通用,只有档案可能有)。
   *
   * 为什么要把线存下来:DSH 的 `lineGate` 默认 strict —— 显式点名一份**绑在别的线**上的档案,
   * 会让整单报错(不是淡出)。柏宝绘在发请求前按这个字段自己先滤掉,比让对方报错更容易解释。
   */
  line: string;
  /**
   * 这条是**DSH 自动认角色**建的行(桥接 2.15.0),不是用户手挑的。
   *
   * 两个用途:面板上标出来(让人知道它从哪来、可以删),以及「DSH 下次认成同一个人但表名变了」时
   * 允许改写它 —— 用户手挑的行永远不动,那是他自己的决定。
   */
  auto?: boolean;
}

/** 映射行数上限。超了手抖加进来的空行会把面板撑满,也会让出图前那次匹配变慢。 */
export const DSH_CHAR_MAP_MAX = 40;
/** 名字长度上限(占位里的名字不会更长;挡住把整段正文粘进名字格)。 */
const NAME_MAX = 24;
/** 引用长度上限:动漫表名字最长的一批也在 60 字内。 */
const REF_MAX = 80;

/**
 * 清洗一张映射表(设置 hydrate / 面板写入都要过它)。
 *
 * 规则:
 *   - 名字或引用为空的行直接丢(面板里的空行、只填了一半的行);
 *   - kind 只认 archive / catalog;
 *   - **同名只留第一条**:同一个名字映射两处,出图时两套长相会在串里打架;
 *   - 去掉首尾空白、控制长度、最多 DSH_CHAR_MAP_MAX 行。
 */
export function normalizeDshCharMappings(raw: unknown): DshCharMapping[] {
  if (!Array.isArray(raw)) return [];
  const out: DshCharMapping[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const o = item as Partial<Record<keyof DshCharMapping, unknown>>;
    const name = typeof o.name === 'string' ? o.name.trim().slice(0, NAME_MAX) : '';
    const ref = typeof o.ref === 'string' ? o.ref.trim().slice(0, REF_MAX) : '';
    const kind = o.kind === 'catalog' ? 'catalog' : o.kind === 'archive' ? 'archive' : '';
    if (!name || !ref || !kind) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({
      name,
      kind,
      ref,
      line: typeof o.line === 'string' ? o.line.trim() : '',
      ...o.auto === true ? { auto: true } : {},
    });
    if (out.length >= DSH_CHAR_MAP_MAX) break;
  }
  return out;
}

/** 一条映射在选择器里的编码值(`archive:26-小静`),只用于 UI 双向绑定,不发给 DSH。 */
export function dshMappingValue(mapping: Pick<DshCharMapping, 'kind' | 'ref'>): string {
  return `${mapping.kind}:${mapping.ref}`;
}

/** 把选择器的编码值拆回 kind / ref;认不出来返回 null(空串 = 没选)。 */
export function parseDshMappingValue(value: string): { kind: DshCharMapKind; ref: string } | null {
  const text = (value ?? '').trim();
  const at = text.indexOf(':');
  if (at <= 0) return null;
  const kind = text.slice(0, at);
  const ref = text.slice(at + 1).trim();
  if (!ref) return null;
  if (kind !== 'archive' && kind !== 'catalog') return null;
  return { kind, ref };
}

/** 给面板 / 卡片看的一行说明:`档案 · 26-小静（moss-real）`、`动漫 · hu tao (genshin impact)`。 */
export function dshMappingLabel(mapping: Pick<DshCharMapping, 'kind' | 'ref' | 'line'>): string {
  const head = mapping.kind === 'catalog' ? '动漫' : '档案';
  const line = mapping.line.trim();
  return line ? `${head} · ${mapping.ref}（${line}）` : `${head} · ${mapping.ref}`;
}

/**
 * 把 DSH「自动认角色」认出来的动漫角色**自动建进映射表**(桥接 2.15.0)。
 *
 * 为什么需要它:认人的结果是 `{ label: '胡桃', ref: 'hu tao (genshin impact)' }`，但下一单
 * 柏宝绘并不知道「胡桃」是谁 —— 没有映射就还得让 DSH 再认一次(模型那趟两三秒，且可能这次认成 A、
 * 下次认成 B)。把这一对存成映射后，下一单开头就是 `characters: ['胡桃：hu tao (genshin impact)']`，
 * DSH 走的是**正常的机械查表**(lookupCatalog 精确命中)，一次模型都不用问。
 *
 * 四条纪律:
 *   1. **只建动漫(`kind: 'catalog'`)的**：档案那条 DSH 已经按名字认到了，下一单照样能认到，
 *      存进映射反而要多存一份线(档案本身绑线，绑错就被跳过)。
 *   2. **线必须与这一单实际生效的配置集一致**：动漫映射线不符时下一单会被静默跳过 ——
 *      所以没有线(空串)就什么都不建，宁可下一单再认一次。
 *   3. **用户手挑的行不动**：同名已存在时只在 `auto: true` 的行上改指向；手挑的行哪怕 DSH 这次
 *      认成了别的条目，也尊重用户的选择(他可能是故意的)。
 *   4. 受 `DSH_CHAR_MAP_MAX` 约束：满了就不再加，返回的 `added` 为空 —— 调用方据此不弹提示。
 *
 * 纯函数，不 import settings、不碰网络，单测能直接跑。
 *
 * @param mappings 现有映射表(任意脏数据都行，进来先归一)
 * @param picks DSH 回包里的 `autoCast.picks` / `/cast/detect` 的 `picks`
 * @param line 这一单**实际生效**的配置集 id(`result.line`，不是请求参数)
 * @param options.max 行数上限(默认 `DSH_CHAR_MAP_MAX`)
 * @returns `{ mappings, added, updated }`：`added` 是新建的行，`updated` 是自动行改了指向的
 */
export function mergeAutoCatalogMappings(
  mappings: DshCharMapping[],
  picks: { label: string; ref: string; kind: string }[],
  line: string,
  options: { max?: number } = {},
): { mappings: DshCharMapping[]; added: DshCharMapping[]; updated: DshCharMapping[] } {
  const cap = Number.isFinite(options.max) && (options.max as number) > 0
    ? Math.floor(options.max as number)
    : DSH_CHAR_MAP_MAX;
  const out = normalizeDshCharMappings(mappings).map(item => ({ ...item }));
  const added: DshCharMapping[] = [];
  const updated: DshCharMapping[] = [];
  const current = (line ?? '').trim();
  if (!current) return { mappings: out, added, updated };

  for (const pick of Array.isArray(picks) ? picks : []) {
    if (pick?.kind !== 'catalog') continue;
    const name = String(pick.label ?? '').trim().slice(0, NAME_MAX);
    const ref = String(pick.ref ?? '').trim().slice(0, REF_MAX);
    if (!name || !ref) continue;
    const existing = out.find(item => item.name === name);
    if (existing !== undefined) {
      if (existing.auto !== true) continue;
      if (existing.kind === 'catalog' && existing.ref === ref && existing.line === current) continue;
      existing.kind = 'catalog';
      existing.ref = ref;
      existing.line = current;
      updated.push(existing);
      continue;
    }
    if (out.length >= cap) break;
    const row: DshCharMapping = { name, kind: 'catalog', ref, line: current, auto: true };
    out.push(row);
    added.push(row);
  }
  return { mappings: out, added, updated };
}

/** 出图前算出来的角色清单(见 planDshCharacters)。 */
export interface DshCharPlan {
  /**
   * `characters` 原样发给 DSH 的项:`显示名：引用`(协议 §3.1)。
   * 顺序 = 在占位文本里第一次出现的位置 —— 第一位站主角位(与阅读器同一口径)。
   */
  characters: string[];
  /**
   * 仍走本地角色库的角色块。**已映射且生效的名字不在这里**(同一个人两套长相会打架);
   * 映射因为线不符被跳过的人会留在里面(有块就先按块画,总比没有长相强)。
   */
  roles: { name: string; charBlock: string }[];
  /**
   * 命中了、但因为「绑在别的线」没发出去的映射。调用方据此弹一句提醒 ——
   * 静默跳过会让「图里这个人不对」变成一件查不出来的事。
   */
  skipped: { name: string; ref: string; reason: 'line' }[];
}

/**
 * 按占位文本算出这一单的角色清单。
 *
 * 命中判据只有一条:**名字在文本里字面出现**(与角色库认人同一个思路,见 charTags 的
 * matchCharTags)。长名优先,免得「雪」把「小雪」的映射也吃掉;最后按首次出现位置排序。
 *
 * 线不符的映射**不发**(DSH 的 lineGate=strict 会整单报错),并记进 skipped 让调用方提醒。
 * 档案的 line 为空串表示通用,哪条线都能用;动漫角色必须与当前线完全一致(每套配置集查的
 * 是各自那张表)。
 */
export function planDshCharacters(input: {
  text: string;
  roles: { name: string; charBlock: string }[];
  mappings: DshCharMapping[];
  /** 本次要走的配置集 id(空串 = 未指定,调用方应已收口成实际生效的那条)。 */
  line: string;
}): DshCharPlan {
  const text = input.text ?? '';
  const line = (input.line ?? '').trim();
  const roles = Array.isArray(input.roles) ? input.roles : [];
  const mappings = normalizeDshCharMappings(input.mappings);
  const empty: DshCharPlan = { characters: [], roles: roles.slice(), skipped: [] };
  if (!text.trim() || mappings.length === 0) return empty;

  // 长名优先命中、短名被长名覆盖:库里同时有「雪」与「小雪」时只留长的那个。
  const hits: { mapping: DshCharMapping; at: number }[] = [];
  const accepted: string[] = [];
  for (const mapping of [...mappings].sort((a, b) => b.name.length - a.name.length)) {
    const at = text.indexOf(mapping.name);
    if (at < 0) continue;
    if (accepted.some(longer => longer.includes(mapping.name))) continue;
    accepted.push(mapping.name);
    hits.push({ mapping, at });
  }
  if (hits.length === 0) return empty;
  hits.sort((a, b) => a.at - b.at);

  const characters: string[] = [];
  const skipped: DshCharPlan['skipped'] = [];
  const mapped = new Set<string>();
  for (const { mapping } of hits) {
    const usable = mapping.kind === 'catalog'
      ? mapping.line !== '' && mapping.line === line
      : mapping.line === '' || mapping.line === line;
    if (!usable) {
      skipped.push({ name: mapping.name, ref: mapping.ref, reason: 'line' });
      continue;
    }
    characters.push(`${mapping.name}：${mapping.ref}`);
    mapped.add(mapping.name);
  }
  return {
    characters,
    // 映射生效的人不再走本地块;被跳过的人保留本地块(退而求其次,有长相总比没有好)。
    roles: roles.filter(role => !mapped.has(role.name.trim())),
    skipped,
  };
}
