import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { generateDshImage, probeDshBridge, type DshBridgeConn } from '@/backends/dshBridge';

/**
 * DSH 桥接后端的契约（见 docs/DSH-BRIDGE-PROTOCOL.md v2）：
 *
 * - 出图是**异步任务**：POST 回 202 + jobId，结果靠 GET /job/{id} 轮询取；
 * - 成功 → dataURL；LINT_BLOCKED → 带 code 的错（不回落）；超时 → COMFY_UNAVAILABLE；
 * - images 为空 → NO_IMAGE；任务不存在 → NO_SUCH_JOB。
 *
 * 为什么这些必须逐条测：每一种失败在卡片上是**不同的一句话**，混了就等于骗用户
 * （「DSH 连不上 ComfyUI」与「DSH 自查没通过」是完全不同的处置）。
 */

function conn(overrides: Partial<DshBridgeConn> = {}): DshBridgeConn {
  return {
    url: 'http://127.0.0.1:3080/story-image-bridge',
    token: '',
    timeoutMs: 180000,
    configSet: '',
    count: 1,
    ...overrides,
  };
}

const VALUES = { scene: '傍晚的天台，林夏靠着栏杆回头', size: 'portrait' as const, seed: 12345 };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** 一次成功的 202 入队回包。 */
function accepted(jobId = 'sj-0123456789ab'): Response {
  return jsonResponse(202, { ok: true, jobId, status: 'queued', pollAfterMs: 300 });
}

/** 一份 done 的结果体（协议 §4）。 */
function doneResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    jobId: 'sj-0123456789ab',
    status: 'done',
    elapsedMs: 47300,
    requestId: 'sj-0123456789ab',
    result: {
      prompt: 'masterpiece, 1girl, rooftop, backlight',
      negative: 'blurry',
      scene: '傍晚的天台，林夏靠着栏杆回头',
      configSet: 'anime-ob',
      line: 'anime',
      characters: ['linxia'],
      characterSource: 'auto',
      lint: { warns: [], infos: [], skipped: null },
      images: [{ base64: 'iVBORw0KGgo=', mediaType: 'image/png', width: 832, height: 1216, seed: 999 }],
      requestId: 'sj-0123456789ab',
      ...overrides,
    },
  };
}

/**
 * 按调用顺序排好的 fetch 假实现：
 * 第一次 POST /generate，之后每次 GET /job/{id}。
 */
function respondWith(...responses: Response[]): void {
  for (const response of responses) fetchMock.mockResolvedValueOnce(response);
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe('generateDshImage（协议 v2：入队 + 轮询）', () => {
  it('POST 回 202 后轮询到 done，把纯 base64 拼成 dataURL', async () => {
    respondWith(accepted(), jsonResponse(200, doneResult()));

    const result = await generateDshImage(conn(), VALUES);

    expect(result.url).toBe('data:image/png;base64,iVBORw0KGgo=');
    expect(result.format).toBe('png');
    // 文件名用 jobId：同一次任务重试时不会撞名，也便于回头查 DSH 的 runs。
    expect(result.filename).toBe('dsh-sj-0123456789ab.png');
    expect(() => result.revoke()).not.toThrow();
    expect(result).toMatchObject({
      width: 832,
      height: 1216,
      prompt: 'masterpiece, 1girl, rooftop, backlight',
      negative: 'blurry',
      scene: '傍晚的天台，林夏靠着栏杆回头',
      requestId: 'sj-0123456789ab',
    });
  });

  it('请求体走协议字段，空配置集/空负面不发（发空串会被当成显式要求）', async () => {
    respondWith(accepted(), jsonResponse(200, doneResult()));

    await generateDshImage(conn({ token: 'secret' }), {
      ...VALUES,
      roles: [{ name: '林夏', charBlock: '1girl, long black hair' }],
      source: { chatId: 'st-abc', messageId: 42, slot: 0 },
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:3080/story-image-bridge/generate');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['x-bbi-token']).toBe('secret');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      scene: VALUES.scene,
      size: 'portrait',
      seed: 12345,
      count: 1,
      roles: [{ name: '林夏', charBlock: '1girl, long black hair' }],
      source: { chatId: 'st-abc', messageId: 42, slot: 0 },
    });
    expect(body.configSet).toBeUndefined();
    expect(body.negative).toBeUndefined();
  });

  it('轮询打到 /job/{jobId} 上，方法 GET', async () => {
    respondWith(accepted('sj-aaaaaaaaaaaa'), jsonResponse(200, doneResult()));

    await generateDshImage(conn(), VALUES);

    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:3080/story-image-bridge/job/sj-aaaaaaaaaaaa');
    expect(init.method).toBe('GET');
  });

  it('中间态会继续轮询（queued → writing → rendering → done）', async () => {
    respondWith(
      accepted(),
      jsonResponse(200, { ok: true, jobId: 'sj-0123456789ab', status: 'queued', elapsedMs: 100 }),
      jsonResponse(200, { ok: true, jobId: 'sj-0123456789ab', status: 'writing', requestId: 'sj-0123456789ab', elapsedMs: 2000 }),
      jsonResponse(200, { ok: true, jobId: 'sj-0123456789ab', status: 'rendering', elapsedMs: 30000 }),
      jsonResponse(200, doneResult()),
    );

    const stages: string[] = [];
    const result = await generateDshImage(conn(), VALUES, undefined, {
      onStage: stage => stages.push(stage),
    });

    expect(result.url).toContain('data:image/png;base64,');
    // 入队一次 + 三个中间态 + done
    expect(stages).toEqual(['queue', 'queued', 'writing', 'rendering', 'done']);
  });

  it('onProgress 每次轮询都带上 status / requestId / elapsedMs', async () => {
    respondWith(
      accepted(),
      jsonResponse(200, { ok: true, status: 'writing', stage: 'writing', progress: '写串中', requestId: 'sj-0123456789ab', elapsedMs: 5000 }),
      jsonResponse(200, doneResult()),
    );

    const seen: { status: string; requestId: string }[] = [];
    await generateDshImage(conn(), VALUES, undefined, {
      onProgress: info => seen.push({ status: info.status, requestId: info.requestId }),
    });

    expect(seen[0]).toEqual({ status: 'writing', requestId: 'sj-0123456789ab' });
    expect(seen[seen.length - 1]?.status).toBe('done');
  });

  it('基址带尾斜杠也能拼出同一个路径', async () => {
    respondWith(accepted(), jsonResponse(200, doneResult()));
    await generateDshImage(conn({ url: 'http://127.0.0.1:3080/story-image-bridge/' }), VALUES);
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      'http://127.0.0.1:3080/story-image-bridge/generate',
    );
  });

  it('入队被 LINT_BLOCKED 拒（422）：code 挂到 error 上，文案用服务端的人话', async () => {
    respondWith(
      jsonResponse(422, {
        ok: false,
        code: 'LINT_BLOCKED',
        error: '自查未通过：size-conflict（同一张图两个互斥景别）',
      }),
    );

    const error = (await generateDshImage(conn(), VALUES).catch(e => e)) as Error & { code?: string };
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('LINT_BLOCKED');
    expect(error.message).toBe('自查未通过：size-conflict（同一张图两个互斥景别）');
  });

  it('任务跑起来之后失败（status:failed）→ 带服务端的 code 与原因', async () => {
    respondWith(
      accepted(),
      jsonResponse(200, {
        ok: true,
        jobId: 'sj-0123456789ab',
        status: 'failed',
        code: 'LINT_BLOCKED',
        error: '自查未通过：跨层复述',
        elapsedMs: 30000,
      }),
    );

    const error = (await generateDshImage(conn(), VALUES).catch(e => e)) as Error & { code?: string };
    expect(error.code).toBe('LINT_BLOCKED');
    expect(error.message).toBe('自查未通过：跨层复述');
  });

  it('认不出的失败 code 收敛成 INTERNAL（不让第三方 error.code 冒充协议码）', async () => {
    respondWith(
      accepted(),
      jsonResponse(200, { ok: true, status: 'failed', code: 'EPIPE', error: '管道断了' }),
    );
    const error = (await generateDshImage(conn(), VALUES).catch(e => e)) as Error & { code?: string };
    expect(error.code).toBe('INTERNAL');
    expect(error.message).toBe('管道断了');
  });

  it('job 超过保留期（404）→ NO_SUCH_JOB，并停止轮询', async () => {
    respondWith(accepted(), jsonResponse(404, { ok: false, code: 'NO_SUCH_JOB', error: '没有这个任务' }));
    const error = (await generateDshImage(conn(), VALUES).catch(e => e)) as Error & { code?: string };
    expect(error.code).toBe('NO_SUCH_JOB');
    // 一次 POST + 一次 GET（404 那下），没有继续打
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('认证失败按 HTTP 401 兜底成 UNAUTHORIZED', async () => {
    respondWith(new Response('', { status: 401 }));
    const error = (await generateDshImage(conn(), VALUES).catch(e => e)) as Error & { code?: string };
    expect(error.code).toBe('UNAUTHORIZED');
  });

  it('超时按 COMFY_UNAVAILABLE 处理（POST 挂住不返回）', async () => {
    fetchMock.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );

    const error = (await generateDshImage(conn({ timeoutMs: 1000 }), VALUES).catch(e => e)) as
      & Error & { code?: string };
    expect(error.code).toBe('COMFY_UNAVAILABLE');
    expect(error.message).toContain('超时');
  }, 10000);

  it('轮询阶段的超时也会停下来（不会永远轮）', async () => {
    // 入队成功，之后每次都回 writing —— 靠 timeoutMs 收口。
    fetchMock.mockResolvedValueOnce(accepted());
    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse(200, { ok: true, status: 'writing', elapsedMs: 1 })),
    );

    const error = (await generateDshImage(conn({ timeoutMs: 1200 }), VALUES).catch(e => e)) as
      & Error & { code?: string };
    expect(error.code).toBe('COMFY_UNAVAILABLE');
    expect(error.message).toContain('超时');
    // 报错里要带上最后停在哪个状态，否则运维只知道「超时」不知道卡在哪。
    expect(error.message).toContain('writing');
  }, 15000);

  it('外部取消原样抛出，不伪装成超时', async () => {
    fetchMock.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    const controller = new AbortController();
    const pending = generateDshImage(conn(), VALUES, controller.signal);
    controller.abort();
    const error = (await pending.catch(e => e)) as Error & { code?: string };
    expect(error.name).toBe('AbortError');
    // 不能被伪装成 DSH 的任何一个错误码：DOMException 自带的数字 code(20) 不算
    expect(typeof error.code).not.toBe('string');
  });

  it('done 但 images 为空 → NO_IMAGE（不能落一张空卡片）', async () => {
    respondWith(accepted(), jsonResponse(200, { ok: true, status: 'done', result: { images: [] } }));
    const error = (await generateDshImage(conn(), VALUES).catch(e => e)) as Error & { code?: string };
    expect(error.code).toBe('NO_IMAGE');
  });

  it('多张时只取第一张，不把候选塞进同一个槽位', async () => {
    respondWith(
      accepted(),
      jsonResponse(200, {
        ok: true,
        status: 'done',
        result: {
          images: [
            { base64: 'FIRST', mediaType: 'image/png' },
            { base64: 'SECOND', mediaType: 'image/png' },
          ],
        },
      }),
    );
    const result = await generateDshImage(conn(), VALUES);
    expect(result.url).toBe('data:image/png;base64,FIRST');
  });

  it('没填地址 / 空画面描述立刻报错，不发请求', async () => {
    await expect(generateDshImage(conn({ url: '' }), VALUES)).rejects.toThrow('DSH 桥接地址');
    await expect(generateDshImage(conn(), { ...VALUES, scene: '   ' })).rejects.toThrow(
      '画面描述不能为空',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('probeDshBridge', () => {
  it('回传版本、协议号、llm 可用性与配置集清单', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        ok: true,
        protocol: 2,
        version: '1.0.0',
        llm: { available: true, provider: 'deepseek-official', model: 'deepseek-v4.1-flash', mode: 'session' },
        configSets: ['anime-ob', 'moss-real'],
        defaultConfigSet: 'anime-ob',
        promptMaxChars: 4000,
      }),
    );
    const health = await probeDshBridge(conn());
    expect(health).toEqual({
      ok: true,
      protocol: 2,
      version: '1.0.0',
      llmAvailable: true,
      configSets: ['anime-ob', 'moss-real'],
      defaultConfigSet: 'anime-ob',
      promptMaxChars: 4000,
    });
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('http://127.0.0.1:3080/story-image-bridge/health');
  });

  it('老版本（没有 protocol 字段）按 1 处理，面板据此提示升级', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { ok: true, version: '0.9.0', llm: { available: true }, configSets: [] }),
    );
    const health = await probeDshBridge(conn());
    expect(health.protocol).toBe(1);
  });

  it('llm.available=false 仍是 200 —— 通道通但写不了串，面板要能分开说', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { ok: true, protocol: 2, version: '1.0.0', llm: { available: false }, configSets: [] }),
    );
    const health = await probeDshBridge(conn());
    expect(health.ok).toBe(true);
    expect(health.llmAvailable).toBe(false);
  });

  it('连不上时抛 COMFY_UNAVAILABLE，而不是把面板挂住', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const error = (await probeDshBridge(conn()).catch(e => e)) as Error & { code?: string };
    expect(error.code).toBe('COMFY_UNAVAILABLE');
    expect(error.message).toContain('连接 DSH 超时');
  });
});
