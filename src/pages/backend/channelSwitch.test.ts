import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 「点页签 = 切出图渠道」这条契约。
 *
 * 这里守的是一个已发生过的事故:页签曾经只改本机浏览态 viewing,真正出图的
 * settings.defaultBackend 要另按面板底部的按钮。结果是用户点了「DSH 写手」页签、
 * 界面上看到的就是 DSH 面板,出图却仍走 ComfyUI —— 楼层卡片还在提示
 * 「到渠道页切换渠道」,而他就站在那一页。故两个状态合并成一个,并由本文件钉住:
 * 页签点亮的那条,必须就是真正出图的那条。
 */

const mocks = vi.hoisted(() => ({ stored: null as Record<string, unknown> | null }));

async function freshSettings(stored: Record<string, unknown> = {}) {
  mocks.stored = stored;
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
  const settingsMod = await import('@/state/settings');
  await settingsMod.hydrateSettings();
  const channelMod = await import('@/pages/backend/channelSwitch');
  return { settings: settingsMod.settings, ...channelMod };
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('点页签 = 切出图渠道', () => {
  it('点 DSH 写手页签后，出图渠道真的变成 dshbridge', async () => {
    const { settings, selectChannel, activeChannel } = await freshSettings({ defaultBackend: 'comfyui' });
    expect(activeChannel()).toBe('comfyui');
    selectChannel('dshbridge');
    // 这一句是这个 bug 的核心断言:页签点亮的那条 === 真正出图的那条
    expect(settings.defaultBackend).toBe('dshbridge');
    expect(activeChannel()).toBe(settings.defaultBackend);
  });

  it('点回 ComfyUI / NAI 同样真的切过去（不是只换面板）', async () => {
    const { settings, selectChannel } = await freshSettings({ defaultBackend: 'dshbridge' });
    selectChannel('comfyui');
    expect(settings.defaultBackend).toBe('comfyui');
    selectChannel('nai');
    expect(settings.defaultBackend).toBe('nai');
  });

  it('已经是当前渠道时不写（幂等，避免无意义回写服务器）', async () => {
    const { settings, selectChannel } = await freshSettings({ defaultBackend: 'comfyui' });
    const spy = vi.fn();
    const saved = settings.defaultBackend;
    // 用 defineProperty 观测赋值:同值再赋一次虽然结果一样，但会触发 settings 的 deep watch 落盘
    let writes = 0;
    Object.defineProperty(settings, 'defaultBackend', {
      configurable: true,
      get: () => saved,
      set: () => {
        writes += 1;
        spy();
      },
    });
    selectChannel('comfyui');
    expect(writes).toBe(0);
    Object.defineProperty(settings, 'defaultBackend', {
      configurable: true,
      writable: true,
      value: saved,
    });
  });
});

describe('页签列表与名称', () => {
  it('webui 不出现在页签里，但存量值仍是合法后端', async () => {
    const { visibleChannels, channelLabel } = await freshSettings({ defaultBackend: 'comfyui' });
    expect(visibleChannels().map(b => b.value)).not.toContain('webui');
    // 名称解析不因隐藏而失效
    expect(channelLabel('webui')).toBe('WebUI');
  });

  it('每条渠道都有中文名（报错文案直接用它，取不到会变成缺字的句子）', async () => {
    const { visibleChannels } = await freshSettings({ defaultBackend: 'comfyui' });
    for (const b of visibleChannels()) {
      expect(b.label.trim()).not.toBe('');
      expect(b.label).not.toBe(b.value);
    }
  });
});
