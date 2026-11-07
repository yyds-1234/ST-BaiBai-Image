import type { ComfyImageResult } from '@/backends/comfyui';
import type { Orientation } from '@/backends/size';

/**
 * DSH 写手后端:把画面占位交给本机 DSH 的 dsh-story-image 插件,由它写成品画面串并出图。
 *
 * 契约真源是 `docs/DSH-BRIDGE-PROTOCOL.md`(两侧共用;改字段先改那份文档)。
 * 本模块做四件事:入队、轮询、把失败翻成带 code 的人话、把回包折成 ComfyImageResult。
 *
 * 【协议 v2 起是异步的】POST /generate 只回 202 + jobId,结果靠 GET /job/{id} 轮询。
 * 这么改的唯一原因是**跨局域网**:柏宝绘常装在另一台机器上,中间那层中继的 upstream
 * 超时往往写死几十秒,而一次出图 45～60 秒 —— 同步长连接必被掐断,症状是「明明出图了
 * 却报连不上 ComfyUI」。改成客户端主动来取之后,每一跳都是短请求,谁的超时都不再相关。
 *
 * 【为什么返回值还是 ComfyImageResult】
 * 柏宝绘的落盘链路(storage.ts)、卡片、公开接口、请求历史全都只认这一个形状。
 * DSH 回的是纯 base64(§3.2 明确不带 data: 前缀),这里拼成 dataURL —— storage.ts
 * 的 resultToBase64 对 data: 开头的 url 直接切逗号取字节,零改动即可落盘。
 * 反过来给一个自定义类型,就得在 storage / Card / public 三处加分支,那是把新后端的
 * 复杂度摊到所有老链路上。
 *
 * 【为什么取第一张就够】
 * 协议允许 images 多张(§3.1 的 count),但柏宝绘的一个槽位 = 一张图:
 * promptHash 桶里多塞几张会让卡片翻页器把「同一次请求的多个候选」当成「同一提示词的历史」,
 * 删除一张就把整条记录的语义弄乱。故 count 交给 DSH 决定,这里只取第 0 张。
 */

export interface DshBridgeConn {
  /** 桥接基址,如 http://127.0.0.1:3080/story-image-bridge(不带尾部斜杠也能用)。 */
  url: string;
  /** 可选令牌,非空时随请求发 x-bbi-token(DSH 侧启用令牌校验时必填)。 */
  token: string;
  /** 单次请求超时。ComfyUI 出图本身几十秒,给足;超时按 COMFY_UNAVAILABLE 处理。 */
  timeoutMs: number;
  /** 配置集 id;空串 = 用 DSH 侧的默认配置集。 */
  configSet: string;
  /** 请求张数(1..8)。本后端只用第一张,但仍要把选择权传给 DSH。 */
  count: number;
}

/** GET /health 的自述能力。面板的「测试连接」用它,也用来给配置集下拉填候选。 */
export interface DshHealth {
  ok: boolean;
  /** 协议版本。**必须是 2**:v1(v3 之前的同步长连接)在跨局域网经中继时必被掐断。 */
  protocol: number;
  version: string;
  /** DSH 侧是否拿得到 agents 服务(写串会话能力)。false 时通道通但出不了图。 */
  llmAvailable: boolean;
  configSets: string[];
  defaultConfigSet: string;
  /** 场景串长度上限(协议 §3.1 说请求上限是它的两倍)。 */
  promptMaxChars: number;
}

/** 本端支持的协议版本。对不上就直接报错,不静默降级 —— 降级会让人以为「能用但慢」。 */
export const DSH_PROTOCOL_VERSION = 2;

/** 任务状态(协议 §4)。终态是 done / failed,其余都要继续轮询。 */
export type DshJobStatus = 'queued' | 'writing' | 'rendering' | 'done' | 'failed';

/**
 * 一次 DSH 出图的结果。
 *
 * 在 ComfyImageResult 之上多带三个「只有 DSH 知道」的字段:成品提示词、实际像素。
 * 它们要随图落盘进 meta(generate.ts 组装),而 ComfyImageResult 是三个后端共用的
 * 最小契约,不该为了一个后端往里加可选字段——那会让另两条链路的读者以为它们也有。
 */
export interface DshImageResult extends ComfyImageResult {
  /** DSH 侧最终提交的完整正向串(协议 §4 的 result.prompt)。 */
  prompt: string;
  /** 同一份负面串(可能含配置集 negativeHint 的合并结果)。 */
  negative: string;
  /** 写手的原样产出(未经拼层的 scene 串):卡片要展示「DSH 写了什么」。 */
  scene: string;
  /** DSH 侧的请求历史记录 id(= jobId):拿它去配置台 /story-image-admin 的「请求历史」页看当次上下文。 */
  requestId: string;
  /** 实际出图像素;DSH 没回报时为 0。 */
  width: number;
  height: number;
}

/** 轮询进度(卡片用它换阶段文案;不关心就整个不传)。 */
export interface DshProgress {
  /** 阶段变化时调一次:queue / queued / writing / rendering / done / failed。 */
  onStage?: (stage: string, label: string) => void;
  /** 每次轮询都调一次(用于显示「已等 12s」与写手会话 id)。 */
  onProgress?: (info: {
    status: DshJobStatus;
    stage: string;
    detail: string;
    /** 请求历史记录 id:有它就能去 DSH 配置台的「请求历史」页翻这次的完整上下文。 */
    requestId: string;
    elapsedMs: number;
  }) => void;
}

export interface DshGenerateValues {
  /** 画面占位散文。 */
  scene: string;
  /** 占位里出现的角色名(显示名/别名均可);DSH 侧仍按自己的档案解析。 */
  characters?: string[];
  size: Orientation;
  /** 追加负向串;DSH 侧与配置集 negativeHint 合并,不替换。 */
  negative?: string;
  /** 0 = 让 DSH 随机。 */
  seed: number;
  /** 纯诊断用坐标 { chatId, messageId, slot };DSH 只写进 runs.jsonl,不进提示词。 */
  source?: Record<string, unknown>;
}

/** 协议 §4 的错误码。 */
export type DshErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'LLM_UNAVAILABLE'
  | 'LLM_EMPTY'
  | 'LINT_BLOCKED'
  | 'COMFY_UNAVAILABLE'
  | 'NO_IMAGE'
  | 'TOO_BUSY'
  | 'NO_SUCH_JOB'
  | 'INTERNAL';

/**
 * 带 code 的错误。
 *
 * 刻意**不派生 Error 子类**:与 public/api.ts 的 publicError 同一条理由——
 * 子类的 instanceof 跨 bundle 必然失效,真正有用的是挂在实例上的 code。
 * 调用方(卡片 / 公开接口)按 code 决定文案与是否值得重试,不靠类型。
 */
function dshError(code: DshErrorCode, message: string): Error {
  const error = new Error(message);
  (error as Error & { code?: DshErrorCode }).code = code;
  return error;
}

/** 超时按协议 §5 归类为 COMFY_UNAVAILABLE(它的处置就是「等会儿再来 / 回落本地」)。 */
const TIMEOUT_CODE: DshErrorCode = 'COMFY_UNAVAILABLE';

const DEFAULT_ERRORS: Record<string, string> = {
  BAD_REQUEST: 'DSH 拒绝了这个请求(缺少画面描述或字段非法)',
  UNAUTHORIZED: 'DSH 令牌不对,请检查柏宝绘「渠道 → DSH 写手」里的令牌',
  LLM_UNAVAILABLE: 'DSH 拿不到写串用的模型,或写串超时',
  LLM_EMPTY: 'DSH 的模型返回了空串',
  LINT_BLOCKED: 'DSH 自查未通过,拒绝出图(不回落)',
  COMFY_UNAVAILABLE: 'DSH 连不上 ComfyUI,或出图超时',
  NO_IMAGE: 'DSH 提交成功但一张图都没取回',
  TOO_BUSY: 'DSH 桥接排队已满，请稍后再试',
  NO_SUCH_JOB: 'DSH 找不到这个任务（可能已过保留期，或 DSH 重启了）',
  INTERNAL: 'DSH 内部异常',
};

function endpoint(base: string, path: string): string {
  return `${base.trim().replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function headers(conn: DshBridgeConn): Record<string, string> {
  const out: Record<string, string> = { 'content-type': 'application/json' };
  // 空令牌不发头:DSH 侧未启用令牌时带了反而是噪声,且会让日志里多一条空值
  if (conn.token.trim()) out['x-bbi-token'] = conn.token.trim();
  return out;
}

/**
 * 合并「外部取消」与「本次超时」。
 *
 * 为什么用 AbortSignal.timeout(而不是自己 setTimeout + abort):超时后必须让 fetch 真的
 * 断开,自己实现的版本容易漏掉 clearTimeout,或把「超时」与「用户取消」混成同一个错误。
 * 两者仍要**分得清**——取消不该被报成 COMFY_UNAVAILABLE(那会让卡片显示「ComfyUI 连不上」,
 * 而用户明明刚点了取消)。故用一个内部 controller,并记下它是被谁中止的。
 */
function linkSignals(
  timeoutMs: number,
  external?: AbortSignal,
): { signal: AbortSignal; peek: () => 'timeout' | 'abort' | null; reason: () => 'timeout' | 'abort' | null } {
  const controller = new AbortController();
  let reason: 'timeout' | 'abort' | null = null;
  const timeout = Math.max(1000, Math.floor(timeoutMs) || 180000);
  const timer = setTimeout(() => {
    reason = 'timeout';
    controller.abort();
  }, timeout);
  const onAbort = () => {
    reason = 'abort';
    controller.abort();
  };
  if (external) {
    if (external.aborted) onAbort();
    else external.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    /**
     * 只读当前原因，**不动计时器**。
     *
     * 原来的 reason() 顺手 clearTimeout —— 放在轮询循环里每圈调一次，等于第一圈就把
     * 超时计时器清掉，整个请求再也超不了时。查询与释放必须是两件事。
     */
    peek: () => reason,
    /** 清理计时器与监听（结束时要调，但仍把原因读回来给调用方分类）。 */
    reason: () => {
      clearTimeout(timer);
      external?.removeEventListener('abort', onAbort);
      return reason;
    },
  };
}

/** 把一次失败响应折成带 code 的 Error。body 不是 JSON 时按 HTTP 状态兜底。 */
function failureFrom(status: number, body: unknown): Error {
  const raw = (body ?? {}) as { code?: unknown; error?: unknown };
  const code =
    typeof raw.code === 'string' && raw.code in DEFAULT_ERRORS
      ? (raw.code as DshErrorCode)
      : status === 401
        ? 'UNAUTHORIZED'
        : 'INTERNAL';
  const detail = typeof raw.error === 'string' ? raw.error.trim() : '';
  // 服务端给了人话就用它(它比本地的通用文案清楚得多),否则用本地兜底文案
  return dshError(code, detail || `${DEFAULT_ERRORS[code]} (HTTP ${status})`);
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** 探活 + 拉能力自述。面板的「测试连接」与配置集下拉共用。 */
export async function probeDshBridge(conn: DshBridgeConn, signal?: AbortSignal): Promise<DshHealth> {
  if (!conn.url.trim()) throw dshError('BAD_REQUEST', '请先填写 DSH 桥接地址');
  // 探活不需要等一次出图那么久:连不上就是连不上,180s 的等待只会让面板像卡死
  const probeTimeout = Math.min(conn.timeoutMs || 180000, 15000);
  const linked = linkSignals(probeTimeout, signal);
  let response: Response;
  try {
    response = await fetch(endpoint(conn.url, 'health'), {
      method: 'GET',
      headers: headers(conn),
      signal: linked.signal,
    });
  } catch (error) {
    const why = linked.reason();
    if (why === 'abort') throw error;
    throw dshError(TIMEOUT_CODE, `连接 DSH 超时(${Math.round(probeTimeout / 1000)}s):${conn.url.trim()}`);
  }
  linked.reason();
  const body = (await readJson(response)) as Record<string, unknown> | null;
  if (!response.ok || !body || body.ok === false) throw failureFrom(response.status, body);
  const llm = (body.llm ?? {}) as { available?: unknown };
  const configSets = Array.isArray(body.configSets)
    ? body.configSets.filter((x): x is string => typeof x === 'string')
    : [];
  return {
    ok: true,
    version: typeof body.version === 'string' ? body.version : '',
    // llm.available=false 仍是 200(协议 §2):通道通、只是写不了串
    protocol: typeof body.protocol === 'number' ? body.protocol : 1,
    llmAvailable: llm.available === true,
    configSets,
    defaultConfigSet: typeof body.defaultConfigSet === 'string' ? body.defaultConfigSet : '',
    promptMaxChars:
      typeof body.promptMaxChars === 'number' && Number.isFinite(body.promptMaxChars)
        ? body.promptMaxChars
        : 4000,
  };
}

/**
 * 出图（协议 v2：**入队 + 轮询**）。返回的 ComfyImageResult.url 是 dataURL —— 落盘链路直接认它。
 *
 * 为什么不是一次长连接：柏宝绘常装在另一台机器上，中间可能夹一层反向代理/中继，
 * 而这类中继的 upstream 超时多是硬编码的几十秒，一次出图 45～60 秒必被掐断。
 * 改成「POST 拿 jobId → GET 轮询」后，每一跳都是短请求，中继超时不再是问题。
 *
 * 不在这里做重试：失败码已经分好类（LINT_BLOCKED 重试也没用，LLM_UNAVAILABLE 该等模型），
 * 重试决策留给调用方；何况一次请求可能已经出过一张图，无脑重发等于让用户多等一倍。
 */
export async function generateDshImage(
  conn: DshBridgeConn,
  values: DshGenerateValues,
  signal?: AbortSignal,
  progress: DshProgress = {},
): Promise<DshImageResult> {
  if (!conn.url.trim()) throw dshError('BAD_REQUEST', '请先填写 DSH 桥接地址');
  const scene = (values.scene ?? '').trim();
  if (!scene) throw dshError('BAD_REQUEST', '画面描述不能为空');

  const payload: Record<string, unknown> = {
    scene,
    size: values.size ?? 'portrait',
    seed: Number.isFinite(values.seed) && values.seed > 0 ? Math.floor(values.seed) : 0,
  };
  // 可选字段一律「有才发」：发空串会让 DSH 侧把「没填」当成「显式要求空」，
  // 例如 configSet 空串本应表示「用默认集」，发过去可能被当成一个不存在的集 id。
  if (values.characters?.length) payload.characters = values.characters;
  if (conn.configSet?.trim()) payload.configSet = conn.configSet.trim();
  if (values.negative?.trim()) payload.negative = values.negative.trim();
  if (conn.count > 0) payload.count = Math.min(8, Math.max(1, Math.floor(conn.count)));
  if (values.source) payload.source = values.source;

  const totalTimeout = Math.max(1000, Math.floor(conn.timeoutMs) || 180000);
  const linked = linkSignals(totalTimeout, signal);
  // 这两个要在 try 外声明：超时是从外面抛的，报错里得说清「停在哪个状态、哪个任务」。
  let jobId = '';
  let lastStatus: DshJobStatus | undefined;
  try {
    // ── 1. 入队 ──
    progress.onStage?.('queue', 'DSH 入队');
    const accepted = await postJson(endpoint(conn.url, 'generate'), payload, linked.signal, conn);
    if (accepted.status !== 202 && accepted.status !== 200) {
      throw failureFrom(accepted.status, accepted.json);
    }
    jobId = typeof accepted.json?.jobId === 'string' ? accepted.json.jobId : '';
    if (!jobId) throw dshError('INTERNAL', 'DSH 没有回 jobId（协议 v2 要求 202 带 jobId）');

    // ── 2. 轮询 ──
    let waitMs = Number.isFinite(accepted.json?.pollAfterMs) ? Math.max(300, Number(accepted.json?.pollAfterMs)) : 1500;
    const started = Date.now();
    for (;;) {
      if (linked.peek() === 'timeout') {
        throw dshError(TIMEOUT_CODE, `DSH 出图超时（${Math.round(totalTimeout / 1000)}s，任务 ${jobId} 停在 ${lastStatus ?? 'queued'}），可到「渠道 → DSH 写手」调大超时`);
      }
      await sleep(waitMs, linked.signal);
      const polled = await getJson(endpoint(conn.url, `job/${jobId}`), linked.signal, conn);
      if (polled.status === 404) {
        throw dshError('NO_SUCH_JOB', 'DSH 找不到这个任务（可能已过保留期，或 DSH 重启了）');
      }
      if (polled.status !== 200 || polled.json?.ok !== true) {
        throw failureFrom(polled.status, polled.json);
      }
      const status = polled.json.status as DshJobStatus;
      if (status !== lastStatus) {
        lastStatus = status;
        progress.onStage?.(status, progressOf(status, polled.json.progress));
      }
      progress.onProgress?.({
        status,
        stage: typeof polled.json.stage === 'string' ? polled.json.stage : '',
        detail: typeof polled.json.progress === 'string' ? polled.json.progress : '',
        requestId: typeof polled.json.requestId === 'string' ? polled.json.requestId : '',
        elapsedMs: typeof polled.json.elapsedMs === 'number' ? polled.json.elapsedMs : Date.now() - started,
      });
      if (status === 'failed') {
        const code = typeof polled.json.code === 'string' ? polled.json.code : 'INTERNAL';
        const message = typeof polled.json.error === 'string' ? polled.json.error : 'DSH 出图失败（没有原因）';
        throw dshError(isDshErrorCode(code) ? code : 'INTERNAL', message);
      }
      if (status === 'done') {
        const result = polled.json.result;
        return toImageResult(
          result !== null && typeof result === 'object' && !Array.isArray(result)
            ? (result as Record<string, unknown>)
            : undefined,
          jobId,
        );
      }
      // 轮询间隔沿用服务端给的 pollAfterMs（有上限）：它比本端更清楚自己那套队列的节奏，
      // 本端擅自改成固定值只会在「刚入队就狂刷」和「出图时半天不刷新」之间反复横跳。
      waitMs = Math.min(Math.max(waitMs, 300), 3000);
    }
  } catch (error) {
    const why = linked.reason();
    // 自己触发的超时：fetch 抛的是 DOMException('AbortError')，它的 code 是数字 20 ——
    // 原样抛出去会让卡片显示「未知错误」。这里按协议统一翻成 COMFY_UNAVAILABLE。
    if (why === 'timeout') {
      throw dshError(
        TIMEOUT_CODE,
        `DSH 出图超时（${Math.round(totalTimeout / 1000)}s，任务 ${jobId || '未入队'}`
        + `停在 ${lastStatus ?? 'queued'}）：它可能还在 DSH 里跑，`
        + '可到「渠道 → DSH 写手」调大超时，或稍后重试',
      );
    }
    // 外部取消：原样抛（调用方靠 name === 'AbortError' 区分「用户点了取消」）。
    throw error;
  } finally {
    linked.reason();
  }
}

/** 状态 → 给卡片看的阶段文案（写在 progress.onStage 里，卡片据此换字）。 */
function progressOf(status: DshJobStatus, detail: unknown): string {
  const suffix = typeof detail === 'string' && detail ? `（${detail}）` : '';
  switch (status) {
    case 'queued': return `DSH 排队中${suffix}`;
    case 'writing': return `DSH 写串中${suffix}`;
    case 'rendering': return `DSH 出图中${suffix}`;
    case 'done': return '完成';
    case 'failed': return '失败';
    default: return status;
  }
}

/** 把协议 §4 的 result 折成 DshImageResult。 */
function toImageResult(result: Record<string, unknown> | undefined, jobId: string): DshImageResult {
  const images = Array.isArray(result?.images) ? result.images : [];
  const first = images[0] as Record<string, unknown> | undefined;
  const base64 = typeof first?.base64 === 'string' ? first.base64.trim() : '';
  // 协议 §4 明说 images 不允许为空：一张都没出就是失败，不能落一张空卡片。
  if (!base64) throw dshError('NO_IMAGE', `DSH 任务 ${jobId} 报成功但一张图都没取回`);
  if (images.length > 1) {
    // 本槽位只认一张（见文件头）。多出来的不静默吞掉——留在日志里，便于日后要改成分格时有个依据。
    console.log(`[柏宝绘] DSH 回了 ${images.length} 张图，本槽位只落第一张`);
  }
  const mediaType = typeof first?.mediaType === 'string' && first.mediaType ? first.mediaType : 'image/png';
  const format = mediaType.split('/').pop()?.toLowerCase() || 'png';
  const normalized = format === 'jpeg' ? 'jpg' : format;
  return {
    url: `data:${mediaType};base64,${base64}`,
    filename: `dsh-${jobId}.${normalized}`,
    format: normalized,
    revoke() {
      // dataURL 无需释放资源（同 comfyui.ts 的 server 分支）；空实现是为了让调用方的
      // result.revoke() 在所有后端上都成立。
    },
    prompt: typeof result?.prompt === 'string' ? result.prompt : '',
    negative: typeof result?.negative === 'string' ? result.negative : '',
    // 写手会话的原样产出：卡片要展示「DSH 写了什么」。
    scene: typeof result?.scene === 'string' ? result.scene : '',
    // 写手会话 id：点开 DSH 侧栏就能看那次写串的完整过程。
    requestId: typeof result?.requestId === 'string' ? result.requestId : '',
    width: typeof first?.width === 'number' ? first.width : 0,
    height: typeof first?.height === 'number' ? first.height : 0,
  };
}

/** 简单 sleep（可被 signal 打断）。 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(Object.assign(new Error('已取消'), { name: 'AbortError' }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(Object.assign(new Error('已取消'), { name: 'AbortError' }));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** POST JSON，永不自己抛网络错误（统一折成 { status:0 }，由调用方判超时/失败）。 */
async function postJson(url: string, body: unknown, signal: AbortSignal, conn: DshBridgeConn): Promise<{ status: number; json?: Record<string, unknown> }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: headers(conn),
    body: JSON.stringify(body),
    signal,
  });
  const parsed = await readJson(response);
  return { status: response.status, json: (parsed ?? undefined) as Record<string, unknown> | undefined };
}

/** GET JSON（同上）。 */
async function getJson(url: string, signal: AbortSignal, conn: DshBridgeConn): Promise<{ status: number; json?: Record<string, unknown> }> {
  const response = await fetch(url, { method: 'GET', headers: headers(conn), signal });
  const parsed = await readJson(response);
  return { status: response.status, json: (parsed ?? undefined) as Record<string, unknown> | undefined };
}

/** 是不是协议表里的错误码（防止把第三方库的 error.code 当协议码）。 */
function isDshErrorCode(value: string): value is DshErrorCode {
  return value in DEFAULT_ERRORS;
}