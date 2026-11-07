import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { backendStatus, decideSeed, generateImage } from '@/generate';
import { settings } from '@/state/settings';

/**
 * DSH 写手渠道在「唯一生成路径」上的行为。
 *
 * 刻意不 mock '@/backends/dshBridge':那条链路只依赖一个 fetch,stub 全局 fetch 就能
 * 从头跑到尾(拼接 → 请求 → 解包 → 组装 meta)。mock 掉它等于把要验的分派逻辑一起
 * 抹掉,只剩「我调了我自己」。
 */

const fetchMock = vi.fn();

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** 把设置调成「DSH 已配齐」。settings 是模块级单例,用例之间会串,故每次都整份复位。 */
function dshReady(overrides: Partial<typeof settings.dshBridge> = {}): void {
  settings.defaultBackend = 'dshbridge';
  settings.dshBridge.url = 'http://127.0.0.1:3080/story-image-bridge';
  settings.dshBridge.token = '';
  settings.dshBridge.timeoutMs = 180000;
  settings.dshBridge.configSet = '';
  settings.dshBridge.count = 1;
  Object.assign(settings.dshBridge, overrides);
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  settings.defaultBackend = 'comfyui';
});

describe('backendStatus: dshbridge', () => {
  it('填了地址就算就绪，模型名给配置集（空则写默认集）', () => {
    dshReady({ configSet: 'anime-ob' });
    expect(backendStatus()).toMatchObject({
      backend: 'dshbridge',
      configured: true,
      model: 'anime-ob',
      supportsCharacters: false,
      reason: '',
    });

    dshReady({ configSet: '' });
    expect(backendStatus().model).toBe('DSH 默认配置集');
  });

  it('地址为空 → 未配置，并说清缺的是哪一项', () => {
    dshReady({ url: '' });
    expect(backendStatus()).toMatchObject({ configured: false, reason: '未填写 DSH 桥接地址' });
  });

  it('令牌不算就绪条件（DSH 未启用校验时本就不填）', () => {
    dshReady({ token: '' });
    expect(backendStatus().configured).toBe(true);
  });
});

describe('generateImage: dsh 分支', () => {
  /** 协议 v2 的 done 结果体（入队 202 之后的第二次请求）。 */
  const OK_BODY = {
    ok: true,
    status: 'done',
    result: {
      prompt: 'masterpiece, 1girl, rooftop',
      negative: 'blurry',
      scene: '傍晚的天台，她靠着栏杆回头',
      images: [{ base64: 'AAAA', mediaType: 'image/png', width: 832, height: 1216 }],
    },
  };

  /** 协议 v2：先 202 入队，再 done —— 两个响应要给到同一次调用的两跳上。 */
  function acceptThenDone(body: unknown = OK_BODY): void {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(202, { ok: true, jobId: 'sj-0123456789ab', status: 'queued', pollAfterMs: 300 }),
    );
    fetchMock.mockResolvedValueOnce(jsonResponse(200, body));
  }

  it('用 <dsh> 散文当场景，把 DSH 回的成品串与像素记进 meta', async () => {
    dshReady();
    acceptThenDone();

    const output = await generateImage({
      prompt: '',
      dsh: '傍晚的天台，她靠着栏杆回头',
      size: 'portrait',
      seed: 42,
      source: { chatId: 'c1', messageId: 7, slot: 0 },
    });

    expect(output.backend).toBe('dshbridge');
    expect(output.result.url).toBe('data:image/png;base64,AAAA');
    // finalPrompt 用 DSH 回包里的成品串（柏宝绘没拼过任何提示词）
    expect(output.finalPrompt).toBe('masterpiece, 1girl, rooftop');
    expect(output.finalNegative).toBe('blurry');
    expect(output.meta).toMatchObject({
      backend: 'dshbridge',
      width: 832,
      height: 1216,
      positive: 'masterpiece, 1girl, rooftop',
      negative: 'blurry',
      artist: null,
      vibes: [],
    });
    // ComfyUI 不支持 characters，DSH 也不吃这个字段——不能谎报
    expect(output.charactersApplied).toBe(false);

    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.scene).toBe('傍晚的天台，她靠着栏杆回头');
    // 没给角色块时整个字段都不发：发 [] 会让 DSH 多报一条「无角色」告警
    expect(body.characters).toBeUndefined();
    expect(body.source).toEqual({ chatId: 'c1', messageId: 7, slot: 0 });
  });

  it('角色块走 roles 旁路字段，不混进 characters', async () => {
    dshReady();
    acceptThenDone();
    await generateImage({
      prompt: '',
      dsh: '傍晚的天台，林夏靠着栏杆回头',
      dshRoles: [
        { name: '林夏', charBlock: '1girl, long black hair, grey sweater' },
        { name: '陈默', charBlock: '1boy, short hair' },
      ],
      size: 'portrait',
      seed: 7,
    });
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    // roles 与 characters 是两条独立通道：characters 让 DSH 查自己的档案，
    // roles 是调用方直接给块（DSH 收到就走旁路，不读 identities）。
    expect(body.roles).toEqual([
      { name: '林夏', charBlock: '1girl, long black hair, grey sweater' },
      { name: '陈默', charBlock: '1boy, short hair' },
    ]);
    expect(body.characters).toBeUndefined();
  });

  it('角色块为空数组时不发这个字段', async () => {
    dshReady();
    acceptThenDone();
    await generateImage({ prompt: '', dsh: '她站在窗边', dshRoles: [], size: 'portrait', seed: 1 });
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.roles).toBeUndefined();
    expect(body.characters).toBeUndefined();
  });
  it('没有 <dsh> 时回落 prompt —— 老 tag 切到本渠道照样能出图', async () => {
    dshReady();
    acceptThenDone();
    await generateImage({ prompt: '1girl, rooftop', size: 'portrait', seed: 1 });
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.scene).toBe('1girl, rooftop');
  });


  it('占位卡片撞上本地后端 → 分派之前就拦下，并说清该切哪个渠道', async () => {
    // 不拦的话这两句会一路走到 comfyui.ts / nai.ts 入口那两句「正向提示词不能为空」：
    // 用户在一张写满画面描述的卡片上点了生成，却被告诉「提示词是空的」。
    settings.defaultBackend = 'comfyui';
    settings.comfyui.url = 'http://127.0.0.1:8188';
    await expect(generateImage({ prompt: '', dsh: '傍晚的天台，她靠着栏杆回头', size: 'portrait', seed: 1 }))
      .rejects.toThrow('画面占位');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('拦截文案点名当前渠道：站在渠道页还被告知「去渠道页切换」的困惑不再复现', async () => {
    // 这句文案的唯一价值是「让我知道现在到底在走哪条」。曾经它只说「请到渠道页切换」，
    // 而用户往往正站在那一页（页签当时只切「看哪个面板」）——那句话读起来像在让他做事。
    const message = await rejectMessage('nai', '傍晚的天台，她靠着栏杆回头');
    expect(message).toContain('画面占位');
    expect(message).toContain('NAI');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('点名的是中文渠道名，不是内部 id', async () => {
    const message = await rejectMessage('nai', '傍晚的天台，她靠着栏杆回头');
    // 必须出现「NAI」，且不许把裸 id 漏出去（用户不认识 dshbridge 这类字符串）
    expect(message).toContain('NAI');
    expect(message).not.toContain('"nai"');
    expect(message).not.toContain("'nai'");
  });

  it('ComfyUI 渠道同样点名，且点名的是它自己而不是别条', async () => {
    const message = await rejectMessage('comfyui', '窗边的侧影');
    expect(message).toContain('ComfyUI');
    expect(message).not.toContain('NAI');
  });

  /** 把某个渠道下「占位撞本地后端」的报错文案抓出来（不抛，只取 message）。 */
  async function rejectMessage(backend: 'comfyui' | 'nai' | 'dshbridge', dsh: string): Promise<string> {
    settings.defaultBackend = backend;
    if (backend === 'nai') {
      settings.nai.model = 'nai-diffusion-5-full';
      settings.nai.endpoints = [
        { id: 'ep1', name: 'ep', url: 'http://127.0.0.1:8188', key: 'k', model: settings.nai.model },
      ] as unknown as typeof settings.nai.endpoints;
      settings.nai.activeEndpointId = 'ep1';
    }
    if (backend === 'comfyui') settings.comfyui.url = 'http://127.0.0.1:8188';
    try {
      await generateImage({ prompt: '', dsh, size: 'portrait', seed: 1 });
    } catch (error) {
      return (error as Error).message;
    }
    throw new Error('预期这条占位被拦下，却成功返回了');
  }

  it('没有 <dsh> 的老 tag 不受这条拦截影响（没占位的卡片照旧报各自的错）', async () => {
    settings.defaultBackend = 'comfyui';
    settings.comfyui.url = '';
    await expect(generateImage({ prompt: '1girl, rooftop', size: 'portrait', seed: 1 }))
      .rejects.not.toThrow('画面占位');
  });
  it('两样都空 → 当场报错，不发一个注定 400 的请求', async () => {
    dshReady();
    await expect(generateImage({ prompt: '  ', dsh: '  ', size: 'portrait', seed: 1 })).rejects.toThrow(
      '画面描述',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('DSH 回包没有 prompt 时，finalPrompt 记散文本身而不是空串', async () => {
    dshReady();
    acceptThenDone({ ok: true, status: 'done', result: { images: [{ base64: 'AAAA' }] } });
    const output = await generateImage({ prompt: '', dsh: '她在窗边回头', size: 'portrait', seed: 1 });
    expect(output.finalPrompt).toBe('她在窗边回头');
    // 没回报宽高就记 0（= 未知），不能编一个像素值
    expect(output.meta.width).toBe(0);
  });

  it('DSH 侧失败时错误原样冒泡（code 不丢，卡片据此给不同说法）', async () => {
    dshReady();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(422, { ok: false, code: 'LINT_BLOCKED', error: '自查未通过：size-conflict' }),
    );
    const error = (await generateImage({ prompt: '', dsh: '场景', size: 'portrait', seed: 1 }).catch(e => e)) as
      & Error & { code?: string };
    expect(error.code).toBe('LINT_BLOCKED');
    expect(error.message).toBe('自查未通过：size-conflict');
  });

  it('未配置时先抛人话，不走到请求', async () => {
    dshReady({ url: '' });
    await expect(generateImage({ prompt: '', dsh: '场景', size: 'portrait', seed: 1 })).rejects.toThrow(
      '未填写 DSH 桥接地址',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('decideSeed: dshbridge 走 ComfyUI 同款随机范围', () => {
  it('显式种子优先', () => {
    expect(decideSeed('dshbridge', 12345)).toBe(12345);
  });

  it('没给种子时随机，且落在 2^53 以内', () => {
    const seed = decideSeed('dshbridge');
    expect(seed).toBeGreaterThanOrEqual(0);
    expect(seed).toBeLessThan(2 ** 53);
  });
});