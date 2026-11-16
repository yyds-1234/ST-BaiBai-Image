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

import { dshPartsOf } from '@/autoTag/dshPlaceholder';

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
  /**
   * 这一行的**其他写法**(2026-11-17):同一行的别名,两种 kind 通用。
   *
   * 为什么放在行上而不是靠「多加几行」:动漫角色没有档案,以前只能「加两行指向同一条 ref」
   * 来表示「甘雨 / Ganyu 是同一个人」—— 用户得自己维护几条长得一样的行,删的时候还得记住
   * 它们是一伙的。现在一行带住:主名决定发出去的「显示名」,别名只参与占位匹配。
   * 档案行的别名仍然建议写进档案本身(identities/<id>.md 的 alias 字段,DSH 也认),
   * 这里多存一份只影响「这一侧认不认得出占位里那个写法」。
   */
  aliases?: string[];
}

/** 映射行数上限。超了手抖加进来的空行会把面板撑满,也会让出图前那次匹配变慢。 */
export const DSH_CHAR_MAP_MAX = 40;
/** 名字长度上限(占位里的名字不会更长;挡住把整段正文粘进名字格)。 */
const NAME_MAX = 24;
/** 一行最多带几个别名:一个人在同一段占位里被写成四五种样子已经很过分了。 */
const ALIAS_MAX = 8;
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
    // 别名:去空白、去空、去重、去掉与主名相同的那个(留着只会让人以为有两份配置)。
    const aliases: string[] = [];
    for (const raw of Array.isArray(o.aliases) ? o.aliases : []) {
      if (typeof raw !== 'string') continue;
      const text = raw.trim().slice(0, NAME_MAX);
      if (!text || text === name || aliases.includes(text)) continue;
      aliases.push(text);
      if (aliases.length >= ALIAS_MAX) break;
    }
    out.push({
      name,
      kind,
      ref,
      line: typeof o.line === 'string' ? o.line.trim() : '',
      ...o.auto === true ? { auto: true } : {},
      ...aliases.length > 0 ? { aliases } : {},
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
 * DSH「自动认角色」回包里 `picks` 的一项（桥接 2.15.0 起；`line` 自 2.16.0）。
 *
 * `label` = 正文里那个名字（中文）；`ref` = 查表用的引用（档案 id 如 `26-小静`，
 * 或动漫表里的 `hu tao (genshin impact)`）；`line` = 这一条该绑的配置集
 * （档案用档案自己的线，通用档是空串；动漫角色用本单生效的线）。
 */
export interface DshAutoPick {
  label: string;
  ref: string;
  kind: string;
  line?: string;
  /**
   * 这一条是 DSH **这一单刚新建**的档案（桥接 2.24.0 的 `picks[].created`）。
   *
   * 为什么它决定要不要建映射行：DSH 认出来的**既有**档案不建（2026-11-14 用户口径 ——
   * 映射由用户显式配）；但「用户点名 / 写手归属段里的人，DSH 当场给他建了一份档案」不同：
   * 那份档案是这一单的产物，不记成映射行的话，柏宝绘这边永远看不到它（实测「涛 没在柏宝绘端建档」）。
   */
  created?: boolean;
}

/**
 * 把 DSH 回包里的 picks 自动建进映射表（桥接 2.15.0；2.25.0 起也收「这一单刚新建的档案」）。
 *
 * 为什么需要它:认人的结果是 `{ label: '胡桃', ref: 'hu tao (genshin impact)' }`，但下一单
 * 柏宝绘并不知道「胡桃」是谁 —— 没有映射就还得让 DSH 再认一次(模型那趟两三秒，且可能这次
 * 认成 A、下次认成 B)。把这一对存成映射后，下一单开头就是
 * `characters: ['胡桃：hu tao (genshin impact)']`，DSH 走的是**正常的机械查表**
 * (`lookupCatalog` 精确命中)，一次模型都不用问。
 *
 * 四条纪律:
 *   1. **只建动漫(`kind: 'catalog'`)的，加上「DSH 这一单刚新建的档案」(`kind: 'archive'` +
 *      `created: true`)**（2026-11-14 用户口径 + 2026-11-16 修正）：DSH **认出来的既有档案**不建 ——
 *      档案的名字由用户在「档案映射」里显式指定才是对的，把「DSH 认出来的档案」自动写成映射行
 *      是错误行为。但 DSH 当场**新建**的档案是这一单的产物，不记成映射行柏宝绘就永远看不到它
 *      （实测：涛 在 DSH 建了 `34-涛`，柏宝绘的档案映射表里却是空的）。
 *   2. **线照抄 `pick.line`**（2.16.0 起 DSH 每条都给，动漫角色 = 本单生效的线）：
 *      缺线时才退回调用方给的那条；两处都空就不建 —— 绑错线在下一单会被静默跳过。
 *   3. **用户手挑的行不动**：同名已存在时只在 `auto: true` 的行上改指向；手挑的行哪怕 DSH 这次
 *      认成了别的条目，也尊重用户的选择(他可能是故意的)。
 *   4. 受 `DSH_CHAR_MAP_MAX` 约束：满了就不再加，返回的 `added` 为空 —— 调用方据此不弹提示。
 *      同一批 picks 里同名只建一条(后到的覆盖先到的)。
 *
 * 纯函数，不 import settings、不碰网络，单测能直接跑。
 *
 * @param mappings 现有映射表(任意脏数据都行，进来先归一)
 * @param picks DSH 回包里的 `autoCast.picks` / `/cast/detect` 的 `picks`
 * @param line 这一单**实际生效**的配置集 id(`result.line`，不是请求参数)；仅在 pick 没带线时兜底
 * @param options.max 行数上限(默认 `DSH_CHAR_MAP_MAX`)
 * @param options.requested 这一单柏宝绘**主动发出去的裸名字**（`characters` 里没有「：」的项）。
 *   它们和 `created` 是同一件事的两个时机：档案还没建时 DSH 回 `created: true`；
 *   档案上一单已经建好时 DSH 只回一条机械命中的 `archive`（`created` 缺席）——
 *   那种单子如果也不建行，柏宝绘这边就永远看不到这份档案（实测：34-涛 建好了，映射表一直空着）。
 *   只认**柏宝绘自己点名的人**，DSH 纯靠正文认出来的既有档案仍然不建（2026-11-14 口径不变）。
 * @returns `{ mappings, added, updated }`：`added` 是新建的行，`updated` 是自动行改了指向的
 */
export function mergeAutoMappings(
  mappings: DshCharMapping[],
  picks: DshAutoPick[],
  line: string,
  options: { max?: number; requested?: string[] } = {},
): { mappings: DshCharMapping[]; added: DshCharMapping[]; updated: DshCharMapping[] } {
  const cap = Number.isFinite(options.max) && (options.max as number) > 0
    ? Math.floor(options.max as number)
    : DSH_CHAR_MAP_MAX;
  const out = normalizeDshCharMappings(mappings).map(item => ({ ...item }));
  const added: DshCharMapping[] = [];
  const updated: DshCharMapping[] = [];
  const fallbackLine = (line ?? '').trim();
  const requested = new Set(
    (Array.isArray(options.requested) ? options.requested : [])
      .map(item => String(item ?? '').trim())
      .filter(Boolean),
  );

  for (const pick of Array.isArray(picks) ? picks : []) {
    // 只建两种：动漫角色（纪律 1）、以及 DSH **这一单刚新建**的档案（`created: true`，2.25.0）。
    // 后者是「柏宝绘点名了 / 写手归属段里出现了、DSH 当场给他建了一份档案」—— 不记成映射行的话，
    // 柏宝绘这边永远看不到这份档案（实测：涛 在 DSH 建了 34-涛，柏宝绘的档案映射表里却没有他）。
    // DSH 认出来的**既有**档案仍然不建（那是 2026-11-14 的用户口径：映射由用户显式配）。
    const name = String(pick.label ?? '').trim().slice(0, NAME_MAX);
    const ref = String(pick.ref ?? '').trim().slice(0, REF_MAX);
    // `requested`：柏宝绘这一单亲手点名发出去的人（裸名字）。DSH 认出来的**既有**档案不建行，
    // 但「我自己发了这个人，DSH 说他是 34-涛」—— 那是一份用户已经默认接受的归宿，必须记下来。
    const kind: DshCharMapKind | '' = pick?.kind === 'catalog'
      ? 'catalog'
      : pick?.kind === 'archive' && (pick.created === true || requested.has(name)) ? 'archive' : '';
    if (!kind) continue;
    if (!name || !ref) continue;
    // 线照抄 pick.line；缺线时：动漫角色用调用方那条（每套配置集查各自的表），
    // 档案用空串 = 通用（**不能**冒用本单的线 —— 那会把通用档绑死在某条线上）。
    const bindLine = kind === 'catalog'
      ? String(pick.line ?? '').trim() || fallbackLine
      : String(pick.line ?? '').trim();
    if (kind === 'catalog' && !bindLine) continue;

    const existing = out.find(item => item.name === name);
    if (existing !== undefined) {
      if (existing.auto !== true) continue;
      if (existing.kind === kind && existing.ref === ref && existing.line === bindLine) continue;
      existing.kind = kind;
      existing.ref = ref;
      existing.line = bindLine;
      updated.push(existing);
      continue;
    }
    if (out.length >= cap) break;
    const row: DshCharMapping = { name, kind, ref, line: bindLine, auto: true };
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


/** 「这一单里没人认领的人」上限:占位最多写两个名字,多出来的都是模型手滑。 */
export const DSH_UNCLAIMED_MAX = 4;

/**
 * 明显不是「一个人」的写法。占位协议里空镜写「无」,其余是模型偶尔会写的指代。
 * 把它们发给 DSH 只会换来一份没用的档案,所以在这里就挡掉。
 */
const UNCLAIMED_STOP = new Set([
  '无', '空镜', '我', '你', '他', '她', '它', '他们', '她们', '他们俩', '两人', '二人', '众人', '路人', '旁白', '某人',
]);

/**
 * 占位「人物名称：」那一行里点名的所有人(还没和映射 / 角色库比对过)。
 *
 * 只认那一行:占位协议(v2.1)要求名字写在那里,正文里的人名不可靠(可能是回忆、转述),
 * 拿正文认人会把「提到过」的人塞进画面。
 */
function namesInPlaceholder(text: string): string[] {
  const line = dshPartsOf(text).names;
  if (!line) return [];
  const out: string[] = [];
  for (const chunk of line.split(/[、，,；;/]+/)) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;
    out.push(...splitConjunction(trimmed));
  }
  return out;
}

/**
 * 「甲与乙」/「甲和乙」也是模型常用的连人写法;但只在**两侧都有内容**时才切,
 * 免得把「与那岭」「和子」这种名字切成两半。
 */
function splitConjunction(text: string): string[] {
  const out: string[] = [];
  let rest = text;
  for (;;) {
    const at = rest.search(/[与和]/);
    if (at <= 0 || at >= rest.length - 1) {
      out.push(rest);
      break;
    }
    out.push(rest.slice(0, at));
    rest = rest.slice(at + 1);
  }
  return out.map(item => item.trim()).filter(Boolean);
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
  // 映射表空不代表什么都不发：占位里点名、两边都不认识的人照样要发（见下面 ②），
  // 那是 DSH 查表 / 自动建档的唯一入口。
  if (!text.trim()) return empty;

  // 长名优先命中、短名被长名覆盖:库里同时有「雪」与「小雪」时只留长的那个。
  // 一行可以带多个写法(name + aliases):动漫角色没有档案,别名就存在这一行里,
  // 不必再「加两行指向同一条 ref」。
  const hits: { mapping: DshCharMapping; at: number }[] = [];
  const accepted: string[] = [];
  const claimed = new Set<string>();
  for (const mapping of [...mappings].sort((a, b) => b.name.length - a.name.length)) {
    // 这一行的所有写法:主名在前(它决定发出去的「显示名」),别名只参与匹配。
    const spellings = [mapping.name, ...(Array.isArray(mapping.aliases) ? mapping.aliases : [])]
      .map(item => String(item ?? '').trim())
      .filter(item => item.length > 0);
    let hit: { at: number; text: string } | null = null;
    for (const spelling of spellings) {
      if (claimed.has(spelling)) continue;
      // 被更长的写法认领过就不再重复认(「小雪」认了,「雪」这个子串不再单独占一位)。
      if (accepted.some(longer => longer !== spelling && longer.includes(spelling))) continue;
      const at = text.indexOf(spelling);
      if (at < 0) continue;
      if (hit === null || at < hit.at) hit = { at, text: spelling };
    }
    if (hit === null) continue;
    claimed.add(hit.text);
    accepted.push(hit.text);
    hits.push({ mapping, at: hit.at });
  }
  hits.sort((a, b) => a.at - b.at);

  const picked: { text: string; at: number }[] = [];
  const skipped: DshCharPlan['skipped'] = [];
  const mapped = new Set<string>();
  /** 映射表里出现过这个名字(哪怕因为线不符被跳过):它已经有用户指定的归宿,不许当野名字发。 */
  const mappedNames = new Set<string>();
  for (const { mapping, at } of hits) {
    // 主名 + 别名都算「这一行已经认领的写法」:它们不许再当野名字发出去,
    // 也不许再被本地角色库的块顶掉。
    mappedNames.add(mapping.name.trim());
    for (const alias of Array.isArray(mapping.aliases) ? mapping.aliases : []) {
      mappedNames.add(String(alias ?? '').trim());
    }
    // 动漫角色**不看线**（2026-11-17）:用户选的是「这个英文角色」,不是「这条线上的这个英文角色」;
    // 表属于线,但 ref 是英文名,跨线通常同名。以前的「线不符就静默丢掉」只换来一句
    // 「有时这张图里没有她」—— 现在照发,当前线查不到时由 DSH 回执点名说清。
    // 档案行仍然看线:跨线注入会被 DSH 的 lineGate(strict) 整单拦下,那不是提示问题。
    const usable = mapping.kind === 'catalog'
      ? true
      : mapping.line === '' || mapping.line === line;
    if (!usable) {
      skipped.push({ name: mapping.name, ref: mapping.ref, reason: 'line' });
      continue;
    }
    picked.push({ text: `${mapping.name}：${mapping.ref}`, at });
    // 主名与别名都记进 mapped:同名的人不再走本地角色库的块(两套长相会打架)。
    mapped.add(mapping.name.trim());
    for (const alias of Array.isArray(mapping.aliases) ? mapping.aliases : []) {
      mapped.add(String(alias ?? '').trim());
    }
  }

  // ② 占位里点名、但**两边都不认识**的人（2026-11-16，桥接 2.25.0）。
  //
  // 以前这种人既不进 characters 也不进 roles：DSH 收到的名单里根本没有他，图里就成了
  // 没有脸的路人（实测「人物名称：安柏、涛」，只有映射过的 安柏 发了出去）。
  // 协议 §3.1 本来就允许「只给名字」——冒号后面那段由 DSH 自己解析：
  // 档案（显示名 / 别名）→ 动漫表 → 都没有就自动建档。三种归宿都在 DSH 那一侧，
  // 柏宝绘这边只负责「把这一帧在场的人也点上去」。
  //
  // 三条纪律：
  //   1. 映射表里有的名字永远不发裸名字（那是用户指定的归宿，包括因线不符被跳过的人）；
  //   2. 角色库里有块的人不发（那走 roles 旁路，同一个名字两套长相会在串里打架）；
  //   3. 空镜 / 指代词不发，总数受 DSH_UNCLAIMED_MAX 约束。
  const known = new Set<string>([...mappedNames, ...roles.map(role => role.name.trim())]);
  let unclaimed = 0;
  for (const name of namesInPlaceholder(text)) {
    if (unclaimed >= DSH_UNCLAIMED_MAX) break;
    if (known.has(name) || UNCLAIMED_STOP.has(name) || name.length > NAME_MAX) continue;
    const at = text.indexOf(name);
    if (at < 0) continue;
    known.add(name);
    picked.push({ text: name, at });
    unclaimed += 1;
  }

  picked.sort((a, b) => a.at - b.at);
  return {
    characters: picked.map(item => item.text),
    // 映射生效的人不再走本地块;被跳过的人保留本地块(退而求其次,有长相总比没有好)。
    roles: roles.filter(role => !mapped.has(role.name.trim())),
    skipped,
  };
}
