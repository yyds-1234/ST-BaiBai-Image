import { getContext, type STMessage } from '@/st/context';
import { reactive } from 'vue';

/**
 * 角色固定外貌库。
 *
 * 真源分三层:
 * - 全局库(跨聊天):extensionSettings,由 globalCharTags.ts 管理,仅用户手动维护,
 *   AI 的 changes 对锁定名一律无效;经 setGlobalCharTagSource 注入,本模块不反向依赖它。
 * - 手动条目/旧版快照:chatMetadata[META_KEY],不随楼层删除。
 * - 自动建档与变化:目标消息 extra[BBI_CHAR_EXTRA_KEY],随消息/swipe 一起保存和删除。
 *
 * charTagLib 只是响应式派生缓存:合并基线(本聊天优先,全局补同名空缺) + 按楼层物理顺序重放自动变化。
 */

export type CharTagField = 'fandom' | 'sex' | 'hair' | 'eyes' | 'skin' | 'body' | 'extra' | 'outfit';

export const CHAR_TAG_FIELDS: readonly CharTagField[] = [
  'fandom',
  'sex',
  'hair',
  'eyes',
  'skin',
  'body',
  'extra',
  'outfit',
];

export const CHAR_TAG_FIELD_LABELS: Record<CharTagField, string> = {
  fandom: '同人身份 tag',
  sex: '性别',
  hair: '头发',
  eyes: '眼睛',
  skin: '肤色',
  body: '体型',
  extra: '标志特征',
  outfit: '固定着装',
};

export type CharTagSource = 'book' | 'manual' | 'ai';
export type CharTagHistoryField = CharTagField | 'new' | 'raw' | 'nl' | 'zh';

export interface CharTagChangeRecord {
  field: CharTagHistoryField;
  from: string;
  to: string;
  reason: string;
  /** 自动变化在重放时按当前物理楼号生成;手动编辑/回滚为 -1。 */
  floor: number;
  at: number;
}

export interface CharTagEntry {
  name: string;
  fields: Record<CharTagField, string>;
  raw: string;
  nl: string;
  /**
   * 中文外貌描述(自由文本,不是 tag)。与 nl 的区别是**谁来用**:
   * nl 是发给 AI 当参考、由它决定要不要写进画面串(占位符替换已降级为兜底);
   * zh 由插件**机械拼进最终正向提示词的 nl 段**,不经 AI、不经 tag/nl 抉择。
   *
   * 存在的理由是 MOSS 写实线:那条线的正向拼装是 `nl || prompt`(见 comfyTemplates
   * 的 composePositive),nl 非空时 tag 整行被丢掉,而角色库七个字段是英文 tag、
   * 只能进 tag —— 中文外貌因此一个词都到不了模型。zh 就架在这条缝上。
   *
   * **可选**:0.3.4 新增,存量条目、老 extra、各处测试夹具都没有这个键。
   * 读侧一律走 `entry.zh?.trim() ?? ''`,不要假设它一定存在。
   */
  zh?: string;
  source: CharTagSource;
  desc: string;
  history: CharTagChangeRecord[];
}

export interface CharTagNewOp {
  kind: 'new';
  name: string;
  fields: Record<CharTagField, string>;
  raw: string;
  nl: string;
  /** 中文外貌描述(见 CharTagEntry.zh)。 */
  zh?: string;
  source: 'book' | 'ai';
  desc: string;
  reason: string;
  at: number;
}

export interface CharTagSetOp {
  kind: 'set';
  name: string;
  field: CharTagField | 'raw' | 'nl' | 'zh';
  value: string;
  reason: string;
  at: number;
}

export type CharTagAutoOp = CharTagNewOp | CharTagSetOp;

export interface CharTagFloorDelta {
  v: 1;
  swipe: number;
  ops: CharTagAutoOp[];
}

export const BBI_CHAR_EXTRA_KEY = 'bbiCharChanges';
const META_KEY = 'baibai_image_char_tags';
const HISTORY_CAP = 50;

interface CharTagStore {
  version: 3;
  entries: CharTagEntry[];
}

export const charTagLib = reactive<{ entries: CharTagEntry[] }>({ entries: [] });
/** 本聊天基线(手动层)里的名字,响应式——UI 用它判断「本聊天覆盖全局」。随 recompute 同步。 */
export const charTagBaseNames = reactive<Set<string>>(new Set());
let baseEntries: CharTagEntry[] = [];

/**
 * 全局角色库(跨聊天)的条目来源,由 globalCharTags.ts 启动时注入。
 * 走注入而不是 import:全局模块要用这里的 normalize/CRUD,直接互转会成模块环。
 */
let globalCharTagSource: () => CharTagEntry[] = () => [];

export function setGlobalCharTagSource(provider: () => CharTagEntry[]): void {
  globalCharTagSource = provider;
}

/**
 * 派生种子 = 本聊天基线 + 全局库补同名空缺(本聊天同名条目优先,即「本聊天覆盖全局」)。
 */
export function mergeCharTagSeed(
  chatBaseEntries: CharTagEntry[],
  globalEntries: CharTagEntry[],
): CharTagEntry[] {
  if (!globalEntries.length) return chatBaseEntries;
  const chatNames = new Set(chatBaseEntries.map(entry => entry.name));
  return [...chatBaseEntries, ...globalEntries.filter(entry => !chatNames.has(entry.name))];
}

/**
 * 锁定名集:全局库里有、且本聊天基线没有同名条目的角色。
 * AI 的 changes 对锁定名一律无效——全局条目只由用户手动维护,tag 有问题用户自己改。
 * 本聊天手动建同名条目即移出锁定(用户明确要的「本聊天覆盖」,AI 可照常变更它)。
 */
export function computeLockedCharTagNames(
  chatBaseEntries: CharTagEntry[],
  globalEntries: CharTagEntry[],
): Set<string> {
  if (!globalEntries.length) return new Set();
  const chatNames = new Set(chatBaseEntries.map(entry => entry.name));
  return new Set(
    globalEntries.filter(entry => !chatNames.has(entry.name)).map(entry => entry.name),
  );
}

function mergedSeedEntries(): CharTagEntry[] {
  return mergeCharTagSeed(baseEntries, globalCharTagSource());
}

/** 当前生效的锁定名集(全局 ⊖ 本聊天基线)。 */
export function lockedCharTagNames(): ReadonlySet<string> {
  return computeLockedCharTagNames(baseEntries, globalCharTagSource());
}

export function emptyCharFields(): Record<CharTagField, string> {
  return { fandom: '', sex: '', hair: '', eyes: '', skin: '', body: '', extra: '', outfit: '' };
}

export function charFieldsEmpty(fields: Record<CharTagField, string>): boolean {
  return CHAR_TAG_FIELDS.every(field => !(fields[field] ?? '').trim());
}

export function buildEntryTag(entry: Pick<CharTagEntry, 'fields' | 'raw'>): string {
  if (entry.raw.trim() && charFieldsEmpty(entry.fields)) return entry.raw.trim();
  return CHAR_TAG_FIELDS.map(field => (entry.fields[field] ?? '').trim())
    .filter(Boolean)
    .join(', ');
}

function isHistoryField(value: string): value is CharTagHistoryField {
  return (
    (CHAR_TAG_FIELDS as readonly string[]).includes(value) ||
    value === 'new' ||
    value === 'raw' ||
    value === 'nl' ||
    value === 'zh'
  );
}

function isSetField(value: string): value is CharTagSetOp['field'] {
  return (
    (CHAR_TAG_FIELDS as readonly string[]).includes(value) ||
    value === 'raw' ||
    value === 'nl' ||
    value === 'zh'
  );
}

function normalizeHistory(raw: unknown): CharTagChangeRecord[] {
  if (!Array.isArray(raw)) return [];
  const out: CharTagChangeRecord[] = [];
  for (const item of raw.slice(-HISTORY_CAP)) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Partial<CharTagChangeRecord>;
    const field = typeof record.field === 'string' ? record.field : '';
    if (!isHistoryField(field)) continue;
    out.push({
      field,
      from: typeof record.from === 'string' ? record.from : '',
      to: typeof record.to === 'string' ? record.to : '',
      reason: typeof record.reason === 'string' ? record.reason : '',
      floor: typeof record.floor === 'number' && Number.isFinite(record.floor) ? record.floor : -1,
      at: typeof record.at === 'number' && Number.isFinite(record.at) ? record.at : 0,
    });
  }
  return out;
}

function normalizeFields(raw: unknown): Record<CharTagField, string> {
  const fields = emptyCharFields();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fields;
  for (const field of CHAR_TAG_FIELDS) {
    const value = (raw as Record<string, unknown>)[field];
    if (typeof value === 'string') fields[field] = value.trim();
  }
  return fields;
}

function normalizeEntry(raw: unknown): CharTagEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Partial<CharTagEntry> & { tags?: unknown };
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  if (!name) return null;
  const fields = normalizeFields(value.fields);
  const legacyTags = typeof value.tags === 'string' ? value.tags.trim() : '';
  const rawTag = typeof value.raw === 'string' ? value.raw.trim() : legacyTags;
  if (!rawTag && charFieldsEmpty(fields)) return null;
  const entry: CharTagEntry = {
    name,
    fields,
    raw: rawTag,
    nl: typeof value.nl === 'string' ? value.nl.trim() : '',
    source: value.source === 'book' || value.source === 'ai' ? value.source : 'manual',
    desc: typeof value.desc === 'string' ? value.desc : '',
    history: normalizeHistory(value.history),
  };
  // 空串不写这个键:zh 是 0.3.4 新增的可选字段,存量条目归一化后不该多出一个
  // 空字段(会把 equality 断言、导出的 JSON 一并改形)。有内容才落。
  const zh = typeof value.zh === 'string' ? value.zh.trim() : '';
  if (zh) entry.zh = zh;
  return entry;
}

function cloneEntry(entry: CharTagEntry): CharTagEntry {
  // zh 是可选字段:没有就保持"没有",不补空串——补了会让每个存量条目都多出一个键,
  // 序列化/相等比较跟着改形。读侧一律 zh ?? '' 兜底。
  return {
    ...entry,
    fields: { ...entry.fields },
    history: entry.history.map(record => ({ ...record })),
  };
}

export function normalizeCharTagStore(raw: unknown): CharTagEntry[] {
  if (!raw || typeof raw !== 'object') return [];
  const entries = (raw as Partial<CharTagStore>).entries;
  if (!Array.isArray(entries)) return [];
  const out: CharTagEntry[] = [];
  const seen = new Set<string>();
  for (const item of entries) {
    const entry = normalizeEntry(item);
    if (entry && !seen.has(entry.name)) {
      seen.add(entry.name);
      out.push(entry);
    }
  }
  return out;
}

function normalizeAutoOp(raw: unknown): CharTagAutoOp | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  const at = typeof value.at === 'number' && Number.isFinite(value.at) ? value.at : 0;
  if (!name) return null;
  if (value.kind === 'new') {
    const fields = normalizeFields(value.fields);
    const rawTag = typeof value.raw === 'string' ? value.raw.trim() : '';
    if (!rawTag && charFieldsEmpty(fields)) return null;
    return {
      kind: 'new',
      name,
      fields,
      raw: rawTag,
      nl: typeof value.nl === 'string' ? value.nl.trim() : '',
      zh: typeof value.zh === 'string' ? value.zh.trim() : '',
      source: value.source === 'book' ? 'book' : 'ai',
      desc: typeof value.desc === 'string' ? value.desc : '',
      reason: typeof value.reason === 'string' ? value.reason : '',
      at,
    };
  }
  const field = typeof value.field === 'string' ? value.field : '';
  const next = typeof value.value === 'string' ? value.value.trim() : '';
  if (value.kind !== 'set' || !isSetField(field) || !next) return null;
  return {
    kind: 'set',
    name,
    field,
    value: next,
    reason: typeof value.reason === 'string' ? value.reason : '',
    at,
  };
}

export function readCharTagFloorDelta(message: STMessage | undefined): CharTagFloorDelta | null {
  const raw = message?.extra?.[BBI_CHAR_EXTRA_KEY];
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Partial<CharTagFloorDelta>;
  if (value.v !== 1 || !Array.isArray(value.ops)) return null;
  const swipe = typeof value.swipe === 'number' && Number.isInteger(value.swipe) ? value.swipe : 0;
  const ops = value.ops.map(normalizeAutoOp).filter((op): op is CharTagAutoOp => !!op);
  return { v: 1, swipe, ops };
}

function activeSwipe(message: STMessage): number {
  return typeof message.swipe_id === 'number' ? message.swipe_id : 0;
}

function pushHistory(entry: CharTagEntry, record: CharTagChangeRecord): void {
  entry.history.push(record);
  if (entry.history.length > HISTORY_CAP) entry.history.splice(0, entry.history.length - HISTORY_CAP);
}

export function createCharTagNewOp(
  entry: Pick<CharTagEntry, 'name' | 'fields' | 'raw' | 'nl' | 'source' | 'desc'> & { zh?: string },
  reason = '',
  at = Date.now(),
): CharTagNewOp | null {
  const normalized = normalizeEntry({ ...entry, history: [] });
  if (!normalized) return null;
  return {
    kind: 'new',
    name: normalized.name,
    fields: normalized.fields,
    raw: normalized.raw,
    nl: normalized.nl,
    zh: normalized.zh ?? '',
    source: normalized.source === 'book' ? 'book' : 'ai',
    desc: normalized.desc,
    reason,
    at,
  };
}

export function createCharTagSetOp(
  name: string,
  field: CharTagSetOp['field'],
  value: string,
  reason = '',
  at = Date.now(),
): CharTagSetOp | null {
  const cleanName = name.trim();
  const cleanValue = value.trim();
  if (!cleanName || !cleanValue) return null;
  return { kind: 'set', name: cleanName, field, value: cleanValue, reason, at };
}

export function applyCharTagOps(
  entries: CharTagEntry[],
  ops: CharTagAutoOp[],
  floor: number,
  locked?: ReadonlySet<string>,
): CharTagEntry[] {
  const out = entries.map(cloneEntry);
  for (const op of ops) {
    // 锁定角色(全局库)不接受 AI changes:无论 new 还是 set 一律丢弃
    if (locked?.has(op.name)) continue;
    if (op.kind === 'new') {
      if (out.some(entry => entry.name === op.name)) continue;
      const entry: CharTagEntry = {
        name: op.name,
        fields: { ...op.fields },
        raw: op.raw,
        nl: op.nl,
        zh: op.zh ?? '',
        source: op.source,
        desc: op.desc,
        history: [],
      };
      pushHistory(entry, {
        field: 'new',
        from: '',
        to: buildEntryTag(entry),
        reason: op.reason,
        floor,
        at: op.at,
      });
      out.push(entry);
      continue;
    }

    const entry = out.find(candidate => candidate.name === op.name);
    if (!entry) continue;
    if (
      op.field !== 'raw' &&
      op.field !== 'nl' &&
      op.field !== 'zh' &&
      entry.raw.trim() &&
      charFieldsEmpty(entry.fields)
    ) {
      continue;
    }
    const current =
      op.field === 'raw'
        ? entry.raw
        : op.field === 'nl'
          ? entry.nl
          : op.field === 'zh'
            ? (entry.zh ?? '')
            : entry.fields[op.field];
    if (current === op.value) continue;
    if (op.field === 'raw') entry.raw = op.value;
    else if (op.field === 'nl') entry.nl = op.value;
    else if (op.field === 'zh') entry.zh = op.value;
    else entry.fields[op.field] = op.value;
    entry.source = 'ai';
    entry.desc = '';
    pushHistory(entry, {
      field: op.field,
      from: current,
      to: op.value,
      reason: op.reason,
      floor,
      at: op.at,
    });
  }
  return out;
}

export function deriveCharTags(
  seedEntries: CharTagEntry[],
  chat: STMessage[],
  upToExclusive = chat.length,
  locked?: ReadonlySet<string>,
): CharTagEntry[] {
  let entries = seedEntries.map(cloneEntry);
  const end = Math.min(Math.max(0, upToExclusive), chat.length);
  for (let floor = 0; floor < end; floor += 1) {
    const message = chat[floor];
    const delta = readCharTagFloorDelta(message);
    if (!delta || delta.swipe !== activeSwipe(message)) continue;
    entries = applyCharTagOps(entries, delta.ops, floor, locked);
  }
  return entries;
}

export function charTagsBeforeFloor(floor: number): CharTagEntry[] {
  const chat = getContext()?.chat ?? [];
  return deriveCharTags(mergedSeedEntries(), chat, floor, lockedCharTagNames());
}

export function makeCharTagFloorDelta(ops: CharTagAutoOp[], swipe: number): CharTagFloorDelta | undefined {
  return ops.length ? { v: 1, swipe, ops } : undefined;
}

export function recomputeCharTags(): void {
  const chat = getContext()?.chat ?? [];
  charTagLib.entries = deriveCharTags(mergedSeedEntries(), chat, chat.length, lockedCharTagNames());
  charTagBaseNames.clear();
  for (const entry of baseEntries) charTagBaseNames.add(entry.name);
}

export function hydrateCharTags(): void {
  const raw = getContext()?.chatMetadata?.[META_KEY];
  // v2 的整库快照无法可靠反推来源楼层,迁移时作为基线保留,避免丢用户现有数据。
  baseEntries = normalizeCharTagStore(raw);
  recomputeCharTags();
}

function persistBase(): void {
  const context = getContext();
  if (!context?.chatMetadata) return;
  const store: CharTagStore = {
    version: 3,
    entries: baseEntries.map(cloneEntry),
  };
  context.chatMetadata[META_KEY] = store;
  context.saveMetadataDebounced?.();
}

function stripOpsFromExtra(extra: Record<string, unknown> | undefined, names: Set<string>): boolean {
  if (!extra) return false;
  const raw = extra[BBI_CHAR_EXTRA_KEY];
  if (!raw || typeof raw !== 'object') return false;
  const value = raw as Partial<CharTagFloorDelta>;
  if (value.v !== 1 || !Array.isArray(value.ops)) return false;
  const nextOps = value.ops
    .map(normalizeAutoOp)
    .filter((op): op is CharTagAutoOp => !!op && !names.has(op.name));
  if (nextOps.length === value.ops.length) return false;
  if (nextOps.length) {
    extra[BBI_CHAR_EXTRA_KEY] = {
      v: 1,
      swipe: typeof value.swipe === 'number' ? value.swipe : 0,
      ops: nextOps,
    } satisfies CharTagFloorDelta;
  } else {
    delete extra[BBI_CHAR_EXTRA_KEY];
  }
  return true;
}

/**
 * 手动编辑/删除意味着用户接管当前结果:把该角色过去的自动楼层操作压进手动基线,
 * 并清掉已有消息里的同名操作。之后的新楼层仍可继续由 AI 变更。
 */
function detachFromExistingFloors(...rawNames: Array<string | undefined>): void {
  const names = new Set(rawNames.map(name => name?.trim()).filter((name): name is string => !!name));
  const context = getContext();
  if (!names.size || !context?.chat) return;
  let changed = false;
  for (const message of context.chat) {
    changed = stripOpsFromExtra(message.extra, names) || changed;
    for (const swipeInfo of message.swipe_info ?? []) {
      changed = stripOpsFromExtra(swipeInfo?.extra, names) || changed;
    }
  }
  if (changed) {
    void context.saveChat?.().catch(error => {
      console.warn('[柏宝绘] 手动角色变更已生效,但清理旧楼层角色记录保存失败', error);
    });
  }
}

export function findCharTag(name: string): CharTagEntry | undefined {
  return charTagLib.entries.find(entry => entry.name === name);
}

/**
 * 从画面串里认出在场角色,取他们的**中文外貌**拼成一段。
 *
 * 这是「中文外貌(zh)」唯一的消费口径:由插件机械拼接,不经 AI、不经 tag/nl 抉择。
 * 为什么需要这条旁路:角色库七个字段是英文 danbooru tag,只能进 tag;而 MOSS 写实线的
 * 正向是 `nl || prompt`(comfyTemplates 的 composePositive),nl 一非空 tag 整行就被丢掉——
 * 英文字段在那边天然到不了模型,中文外貌若也只走 tag 就同样到不了。
 *
 * 认人靠**名字字面出现**:传进来的是本图最终的 tag + nl 原文,库里每个名字去文本里找一次。
 * 不用 characters[] 是因为 ComfyUI 链路根本不产出那一段(supportsCharacters=false),
 * 而自动 tag 的协议也不会为它额外输出角色清单。名字匹配是这条链路上唯一机械可靠的信号;
 * 认错了最坏结果只是多拼一段同作者描述,不会改人数、不会增删元素。
 *
 * 匹配按名字长度降序:库里同时有「小雪」与「雪」时,先命中长的那个,
 * 免得短名把长名的角色也拉进来拼一遍。
 *
 * 拼的是 zh 原文:给人看的中文描述,交给中文原生的文本编码器,不做任何改写。
 *
 * **归属**:每段前面带名字(「林夏：鹅蛋脸…」),不再裸拼。多人同框时 tag 那条线有整套
 * 邻接绑定纪律(white dress on green hair girl),而 zh 是中文散文、无法用 on X 绑定——
 * 不加名字时模型拿到两个中文脸没有任何指向,只能随机分配或合并。名字是这里唯一能给的锚。
 *
 * **换行**:zh 是手填文本,可能带换行;nl 走 sanitizeContent 已被折成空格,这里同口径对齐,
 * 免得中文外貌成为整条正向里唯一带换行的段落。
 */
/**
 * 从一段文本里认出在场角色（名字字面出现即算），按**长名优先**排好序。
 *
 * 长名优先是必须的:库里同时有「雪」与「小雪」时,先命中长的那个才不会把同一个人的
 * 两套档案都拉进来。
 *
 * **这是「认人」的唯一口径**:中文外貌注入(chineseAppearanceForText)与
 * DSH 渠道的角色提交(roleNamesForText)共用它,两处若各写一套,就会出现
 * 「外貌拼了这个人、提交给 DSH 的名单里却没有他」这种对不上的事。
 */
export function matchCharTags(text: string): CharTagEntry[] {
  const source = (text ?? '').trim();
  if (!source) return [];
  const candidates = charTagLib.entries
    .filter(entry => entry.name.trim())
    .sort((left, right) => right.name.trim().length - left.name.trim().length);
  const out: CharTagEntry[] = [];
  const accepted: string[] = [];
  for (const entry of candidates) {
    const name = entry.name.trim();
    if (!source.includes(name)) continue;
    // 已被更长且已命中的名字覆盖:那是同一个人的另一条档案,不重复算。
    if (accepted.some(longer => longer.includes(name))) continue;
    accepted.push(name);
    out.push(entry);
  }
  return out;
}

/**
 * 给 DSH 渠道用的**在场角色名单**。
 *
 * 与 chineseAppearanceForText 的关系:**认人是同一个函数**(matchCharTags),只是产出不同——
 * 那边拼一段给人看的中文外貌,这边给出「这一单画谁」。
 *
 * 为什么只给名字、不给外貌块:DSH 侧的角色管理是它自己的地盘(identities/*.md +
 * line 门禁 + 每个角色绑定的 LoRA 与画风档),柏宝绘塞一份块过去等于让同一件事有两套
 * 真源,两边一改就各说各话。**分工是**:柏宝绘决定「这一单画谁」(它看得见正文、
 * 认得出在场的人),DSH 决定「这个人长什么样」(形态、LoRA、绑哪条线由档案定)。
 *
 * 名字必须是 DSH 档案里认得的写法(显示名或别名),否则那一侧会按「角色不存在」报错——
 * 这是有意的:静默跳过会让「图里少了个人」变成一件查不出来的事。
 */
export function roleNamesForText(text: string): string[] {
  return matchCharTags(text).map(entry => entry.name.trim()).filter(Boolean);
}

export function chineseAppearanceForText(text: string): string {
  // 认人交给 matchCharTags（与 DSH 渠道的 roleNamesForText 同一个函数），这里只管拼文本。
  const parts: string[] = [];
  for (const entry of matchCharTags(text)) {
    const zh = (entry.zh ?? '').trim().replace(/[\r\n]+/g, ' ');
    if (zh) parts.push(`${entry.name.trim()}：${zh}`);
  }
  return parts.join(' ');
}

export interface UpsertOptions {
  recordChanges?: boolean;
}

export function upsertCharTag(
  entry: CharTagEntry,
  oldName?: string,
  opts: UpsertOptions = {},
): boolean {
  const name = entry.name.trim();
  if (!name || !buildEntryTag(entry)) return false;
  const previous = findCharTag(oldName ?? name);
  const next: CharTagEntry = {
    name,
    fields: normalizeFields(entry.fields),
    raw: entry.raw.trim(),
    nl: entry.nl.trim(),
    zh: (entry.zh ?? '').trim(),
    source: entry.source,
    desc: entry.desc,
    history: entry.history.length
      ? entry.history.map(record => ({ ...record }))
      : (previous?.history.map(record => ({ ...record })) ?? []),
  };
  if (opts.recordChanges && previous) {
    const at = Date.now();
    for (const field of CHAR_TAG_FIELDS) {
      if (previous.fields[field] !== next.fields[field]) {
        pushHistory(next, {
          field,
          from: previous.fields[field],
          to: next.fields[field],
          reason: '手动编辑',
          floor: -1,
          at,
        });
      }
    }
    if (previous.raw !== next.raw && (previous.raw || next.raw)) {
      pushHistory(next, { field: 'raw', from: previous.raw, to: next.raw, reason: '手动编辑', floor: -1, at });
    }
    if (previous.nl !== next.nl && (previous.nl || next.nl)) {
      pushHistory(next, { field: 'nl', from: previous.nl, to: next.nl, reason: '手动编辑', floor: -1, at });
    }
  }

  detachFromExistingFloors(oldName, name);
  if (oldName && oldName !== name) {
    const oldIndex = baseEntries.findIndex(candidate => candidate.name === oldName);
    if (oldIndex >= 0) baseEntries.splice(oldIndex, 1);
  }
  const index = baseEntries.findIndex(candidate => candidate.name === name);
  if (index >= 0) baseEntries[index] = next;
  else baseEntries.push(next);
  persistBase();
  recomputeCharTags();
  return true;
}

export function removeCharTag(name: string): boolean {
  const cleanName = name.trim();
  if (!cleanName || !findCharTag(cleanName)) return false;
  detachFromExistingFloors(cleanName);
  const index = baseEntries.findIndex(entry => entry.name === cleanName);
  if (index >= 0) baseEntries.splice(index, 1);
  persistBase();
  recomputeCharTags();
  return true;
}

export function rollbackCharTag(name: string, record: CharTagChangeRecord): boolean {
  const current = findCharTag(name);
  if (!current) return false;
  if (record.field === 'new') return removeCharTag(name);
  const next = cloneEntry(current);
  if (record.field === 'raw') next.raw = record.from;
  else if (record.field === 'nl') next.nl = record.from;
  else if (record.field === 'zh') next.zh = record.from;
  else next.fields[record.field] = record.from;
  next.source = 'manual';
  next.desc = '';
  pushHistory(next, {
    field: record.field,
    from: record.to,
    to: record.from,
    reason: '手动回滚',
    floor: -1,
    at: Date.now(),
  });
  return upsertCharTag(next, name);
}

let bound = false;

export function bindCharTagSync(): void {
  if (bound) return;
  const context = getContext();
  if (!context?.eventSource || !context.eventTypes?.CHAT_CHANGED) return;
  bound = true;
  context.eventSource.on(context.eventTypes.CHAT_CHANGED, hydrateCharTags);
  const recomputeLater = () => setTimeout(recomputeCharTags, 0);
  if (context.eventTypes.MESSAGE_DELETED) {
    context.eventSource.on(context.eventTypes.MESSAGE_DELETED, recomputeLater);
  }
  if (context.eventTypes.MESSAGE_SWIPED) {
    context.eventSource.on(context.eventTypes.MESSAGE_SWIPED, recomputeLater);
  }
  hydrateCharTags();
}
