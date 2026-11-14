import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * DSH 写手渠道的设置契约。
 *
 * 这个渠道是**纯加法**(升级前 settings 里根本没有 dshBridge 这个键),所以重点不是
 * 「老字段怎么折」,而是三条更隐蔽的不变式:
 * 1. 老配置 hydrate 后 defaultBackend **不会**变成 dshbridge —— 用户没选过它;
 * 2. defaultBackend 白名单认得 'dshbridge' —— 漏了的话用户选了它、刷新即被静默重置
 *    (这条最容易漏,且现象是「我明明选了它」,没有任何报错可查);
 * 3. configSet 的空串是**有意义的存储值**（= 跟随本插件默认线，不写死进存档），
 *    不能被 || 吞成默认值；真正发出去的值由 effectiveDshBridge 收口成 moss-real。
 *
 * 走 window.SillyTavern.getContext 而不是 vi.mock('@/st/context'):那正是扩展在
 * 生产环境里接触宿主的唯一入口(st/context.ts),stub 它等于让这条测试跑在真实路径上。
 */

const mocks = vi.hoisted(() => ({
  stored: null as Record<string, unknown> | null,
}));

/** 用一份 stored 重新 hydrate 一次模块(每次都要 resetModules,settings 是模块级单例)。 */
async function hydrateWith(raw: Record<string, unknown> | undefined) {
  mocks.stored = raw === undefined ? {} : raw;
  vi.resetModules();
  vi.stubGlobal('toastr', { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() });
  vi.stubGlobal('window', {
    addEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
    SillyTavern: {
      getContext: () => ({
        extensionSettings: { baibai_image: mocks.stored },
        saveSettingsDebounced: vi.fn(),
        name1: 'User',
        name2: 'Char',
        chatMetadata: {},
      }),
    },
  });
  const { hydrateSettings, settings } = await import('@/state/settings');
  await hydrateSettings();
  return settings;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('老配置升级', () => {
  it('缺 dshBridge 键 → 补一整套默认值，且 defaultBackend 仍是 comfyui', async () => {
    const settings = await hydrateWith({ defaultBackend: 'comfyui' });
    expect(settings.defaultBackend).toBe('comfyui');
    expect(settings.dshBridge).toEqual({
      url: 'http://127.0.0.1:3080/story-image-bridge',
      token: '',
      timeoutMs: 180000,
      configSet: '',
      count: 1,
      charMappings: [],
      // 自动认角色默认开：与 DSH 侧 bridge.autoCast 的默认值（smart）对齐 ——
      // 两边默认必须是同一个答案，否则「升级完什么都没变」与「升级完突然多两个人」都会发生。
      autoCast: true,
    });
  });

  it('连 settings 都空（全新装）也不会把默认后端改成 dshbridge', async () => {
    const settings = await hydrateWith(undefined);
    expect(settings.defaultBackend).toBe('comfyui');
  });

  it('老配置里本就没有 dshBridge，升级后 ComfyUI 行为不变', async () => {
    const settings = await hydrateWith({
      defaultBackend: 'comfyui',
      comfyui: {
        url: 'http://127.0.0.1:8188',
        workflows: [{ id: 'wf_1', name: '我的', workflow: '{"1":{}}' }],
        activeWorkflowId: 'wf_1',
      },
    });
    expect(settings.defaultBackend).toBe('comfyui');
    expect(settings.comfyui.url).toBe('http://127.0.0.1:8188');
    expect(settings.comfyui.workflows[0].workflow).toBe('{"1":{}}');
    // 新键存在但不参与任何老链路
    expect(settings.dshBridge.url).toContain('story-image-bridge');
  });

  it('用户选过 dshbridge → 白名单必须认它，否则刷新即被重置', async () => {
    const settings = await hydrateWith({ defaultBackend: 'dshbridge' });
    expect(settings.defaultBackend).toBe('dshbridge');
  });

  it('脏值（未知后端名）仍回落默认后端', async () => {
    const settings = await hydrateWith({ defaultBackend: 'not-a-backend' });
    expect(settings.defaultBackend).toBe('comfyui');
  });
});

describe('dshBridge 逐字段兜底', () => {
  it('保留用户填的每一项', async () => {
    const settings = await hydrateWith({
      dshBridge: {
        url: 'http://192.168.1.9:3080/story-image-bridge',
        token: 'tk',
        timeoutMs: 240000,
        configSet: 'anime-ob',
        count: 3,
        charMappings: [{ name: '林夏', kind: 'archive', ref: '26-小静', line: 'moss-real' }],
        // 关掉的开关必须留住：它决定「没配映射的人要不要 DSH 自己认」，被默认值顶回 true
        // 会让用户在面板上关掉、刷新又自己打开。
        autoCast: false,
      },
    });
    expect(settings.dshBridge).toEqual({
      url: 'http://192.168.1.9:3080/story-image-bridge',
      token: 'tk',
      timeoutMs: 240000,
      configSet: 'anime-ob',
      count: 3,
      charMappings: [{ name: '林夏', kind: 'archive', ref: '26-小静', line: 'moss-real' }],
      autoCast: false,
    });
  });

  it('映射表也逐字段清洗（坏行不进存档，好行原样保留）', async () => {
    const settings = await hydrateWith({
      dshBridge: {
        charMappings: [
          { name: ' 林夏 ', kind: 'archive', ref: ' 26-小静 ', line: ' moss-real ' },
          { name: '', kind: 'archive', ref: '26-小静', line: '' },
          { name: '胡桃', kind: 'nonsense', ref: 'hu tao', line: 'moss-anime' },
          'junk',
        ],
      },
    });
    expect(settings.dshBridge.charMappings).toEqual([
      { name: '林夏', kind: 'archive', ref: '26-小静', line: 'moss-real' },
    ]);
  });

  it('空 configSet 保持空串（= 跟随默认线），不被默认值顶掉', async () => {
    const settings = await hydrateWith({ dshBridge: { configSet: '' } });
    expect(settings.dshBridge.configSet).toBe('');
  });

  it('发请求时收口成 moss 真人线：留空不再是「DSH 的默认集」', async () => {
    // 存储值留空（面板上显示「没指定」），但真正进 payload 的必须是 moss-real ——
    // 否则柏宝绘出什么风格取决于另一台机器上可以随时改掉的 settings.yaml。
    await hydrateWith({ dshBridge: { configSet: '' } });
    const mod = await import('@/state/settings');
    expect(mod.effectiveDshBridge().configSet).toBe('moss-real');
    // 用户点了别的线就照发，不被默认值覆盖
    mod.settings.dshBridge.configSet = 'moss-anime';
    expect(mod.effectiveDshBridge().configSet).toBe('moss-anime');
    // 手填带空白的也当同一个值
    mod.settings.dshBridge.configSet = '  moss-real  ';
    expect(mod.effectiveDshBridge().configSet).toBe('moss-real');
  });

  it('类型不符逐项回落默认值', async () => {
    const settings = await hydrateWith({
      dshBridge: {
        url: 123,
        token: null,
        timeoutMs: 'long',
        configSet: 9,
        count: {},
        // 非布尔一律当「没填」→ 默认开（只有明确存过 false 才算关）。
        autoCast: 'yes',
      },
    });
    expect(settings.dshBridge).toEqual({
      url: 'http://127.0.0.1:3080/story-image-bridge',
      token: '',
      timeoutMs: 180000,
      configSet: '',
      count: 1,
      charMappings: [],
      autoCast: true,
    });
  });

  it('超时与张数被钳进可用范围（0 会让每次出图当场超时）', async () => {
    const low = await hydrateWith({ dshBridge: { timeoutMs: 0, count: 0 } });
    expect(low.dshBridge.timeoutMs).toBe(5000);
    expect(low.dshBridge.count).toBe(1);

    const high = await hydrateWith({ dshBridge: { timeoutMs: 9999999, count: 99 } });
    expect(high.dshBridge.timeoutMs).toBe(900000);
    expect(high.dshBridge.count).toBe(8);
  });
});
