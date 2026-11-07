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
  settings.dshBridge.charactersFrom = 'prompt';
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
      dshCharacters: ['林夏'],
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
    expect(body.characters).toEqual(['林夏']);
    expect(body.source).toEqual({ chatId: 'c1', messageId: 7, slot: 0 });
  });

  it('没有 <dsh> 时回落 prompt —— 老 tag 切到本渠道照样能出图', async () => {
    dshReady();
    acceptThenDone();
    await generateImage({ prompt: '1girl, rooftop', size: 'portrait', seed: 1 });
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.scene).toBe('1girl, rooftop');
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