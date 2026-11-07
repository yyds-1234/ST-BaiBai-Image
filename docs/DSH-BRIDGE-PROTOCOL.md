# DSH 桥接协议 v2（柏宝绘 ⇄ dsh-story-image）

> 本文是**两侧共用的唯一契约**。改字段先改这里，再同批改两边实现。
> 柏宝绘侧实现：`src/backends/dshBridge.ts`；DSH 侧实现：`lib/bridge.js`（dsh-story-image 插件）。
> 传输：HTTP，JSON，UTF-8。

## v1 → v2 改了什么（两个都要，一起改）

1. **出图改成异步任务**：`POST /generate` 立即回 `202 { jobId }`，结果靠 `GET /job/{jobId}` 轮询取。
   起因：跨局域网时中间常夹一层反向代理/中继（本机是 `dsh-pair-gateway` relay :18900），
   它们的 upstream 超时是硬编码的几十秒，而一次出图实测 45～60 秒 —— **同步长连接必然被中继掐断**。
   改成「客户端主动来取」后，任何中继都只承载短请求，超时不再是问题。
2. **写串从直连 LLM 改成 DSH 会话**：v1 用 `ctx.get('llm').stream()` 一次性补全，过程不可见。
   v2 起每次写串在 DSH 里**建一个真实会话**（GUI 侧栏可见、可点进去看完整对话），
   由插件驱动一轮拿结果。好处：过程可追溯、可复现、可接管（用户能直接在那个会话里继续问）。

## 0. 部署形态（先确认在哪一侧）

| 形态 | 柏宝绘填的 base | 说明 |
|---|---|---|
| 同机直连 | `http://127.0.0.1:3080/story-image-bridge` | DSH 默认只绑回环。 |
| 同机经中继 | `http://127.0.0.1:18900/story-image-bridge` | relay 绑 `0.0.0.0`，转发到 127.0.0.1:3080。 |
| **跨局域网经中继** | `http://<DSH主机局域网IP>:18900/story-image-bridge` | 最常见。DSH 的 3080 不对局域网开，18900 才开。 |
| 跨局域网直连 | `http://<DSH主机局域网IP>:3080/story-image-bridge` | 需 `dsh web --host <该IP>` 启动，DSH 会警告「plain HTTP 暴露在网络上」。 |

**v2 的异步化就是为了让前三种（尤其第三种）都能稳定工作。**

## 1. 通用

- 请求头：`content-type: application/json`；若启用了令牌，另带 `x-bbi-token: <token>`。
- 跨源：DSH 侧每条响应都带 CORS（`access-control-allow-origin` 回显 `Origin`，`vary: origin`，
  允许 `content-type, x-bbi-token`，方法 `GET, POST, OPTIONS`），`OPTIONS` 直接 204 空体。
- 所有响应都是 JSON 对象，顶层必有 `ok` 布尔。
- 失败：非 2xx + `{ ok: false, code, error }`。`code` 见 §5。

## 2. `GET {base}/health`

探活 + 自述能力，柏宝绘面板的「测试连接」用它。

```json
{
  "ok": true,
  "protocol": 2,
  "version": "1.0.0",
  "llm": { "available": true, "provider": "opendesign", "model": "deepseek-v4.1-flash", "mode": "session" },
  "configSets": ["moss-real", "moss-anime"],
  "defaultConfigSet": "moss-real",
  "promptMaxChars": 4000,
  "bridge": { "version": "2.0.0", "concurrency": 2, "active": 0, "queued": 0, "tokenRequired": false }
}
```

- `protocol: 2` 是**能力判据**：柏宝绘发现协议版本 < 2 就说明对端还是 v1，直接报错提示升级，不静默降级。
- `llm.available=false` 时仍返回 200（通道通、写串能力不可用）。
- `llm.mode`：`'session'`（v2，写串走真实会话）｜`'direct'`（v1 兼容，直连补全）。

## 3. `POST {base}/generate` —— 只入队

### 3.1 请求体

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `scene` | string | 是 | **画面占位原文**：中文散文（人物 + 场景 + 动作 + 光线）。上限 `promptMaxChars × 2`。 |
| `characters` | string[] | 否 | **这一单画谁**，按出场顺序。柏宝绘按画面散文去自己的角色库认人，把名字交过来；DSH 拿它去自己的 `identities/*.md` 认人（形象块 / LoRA / `line` 门禁都归它管）。名字必须是 DSH 档案里认得的写法（显示名或别名），否则那一侧按「角色不存在」报错。 |
| `size` | `'portrait'` | `'landscape'` | 否 | 默认 `portrait`。DSH 会按它摆正宽高（对调，像素总数不变）。 |
| `configSet` | string | 否 | 配置集 id；留空用 DSH 默认集。 |
| `negative` | string | 否 | 追加负向串；与配置集 `negativeHint` **合并**，不替换。 |
| `count` | integer | 否 | 1..8，默认 1。柏宝绘只落第一张。 |
| `seed` | integer | 否 | 复现种子；0/缺省 = 随机。 |
| `source` | object | 否 | `{ chatId, messageId, slot }`，纯诊断，进 `runs.jsonl`，不进提示词。 |

> **角色归属（v2 起定死）**：柏宝绘回答「这一单画谁」，DSH 回答「这个人长什么样」。
> 柏宝绘按占位散文在自己角色库里**按名字**认出在场角色，只把名字送过来；
> 形象块、LoRA、风格档、绑哪条配置集，全部由 DSH 的 `identities/*.md` 决定。
> 之所以不传外貌块：传块等于让同一个角色有两套真源，两边一改就会各说各话；
> 而 DSH 的档案还带着 LoRA 与 `line` 门禁信息，那些柏宝绘这边根本没有。
> 代价是**两边名字必须对得上**——柏宝绘库里叫「林夏」、DSH 档案里叫「01-林夏」时，
> 靠 DSH 的 `alias` 兜住；对不上会报「角色不存在」，而不是静默少画一个人。

### 3.2 立即响应（202）

```json
{ "ok": true, "jobId": "sj-1a2b3c4d5e6f", "status": "queued", "pollAfterMs": 1500 }
```

- `jobId`：`sj-` + 12 位十六进制。
- `pollAfterMs`：客户端首次轮询前建议等多久（DSH 按当前负载给的提示，柏宝绘至少等这么久）。
- **入队即返回，不等出图**。入队失败（并发满 / 令牌不对 / 参数非法）仍是 4xx/5xx + `{ok:false}`。

## 4. `GET {base}/job/{jobId}`

轮询任务状态。**幂等、无副作用**，可以随便重试。

```json
{
  "ok": true,
  "jobId": "sj-1a2b3c4d5e6f",
  "status": "rendering",
  "stage": "comfy",
  "progress": "等待 ComfyUI 队列（前面 1 个）",
  "requestId": "sj-bcdecb6bc55e",
  "elapsedMs": 21300
}
```

`status` 取值：

| status | 含义 | 柏宝绘侧 |
|---|---|---|
| `queued` | 已入队，等并发槽 | 继续轮询 |
| `writing` | 正在 DSH 会话里写画面串 | 继续轮询（卡片显示「DSH 写串中」） |
| `rendering` | 正在跑 lint + ComfyUI | 继续轮询（卡片显示「DSH 出图中」） |
| `done` | 成功，带 `result` | 取图、落盘 |
| `failed` | 失败，带 `code` + `error` | 按 §5 处置 |

> **注意**：`status` 与 `stage` 由同一次状态推进一起更新（不是两个独立轴）。
> 实测踩过的坑：只改 `stage` 会让客户端一直读到 `status:'writing'` 而 `stage:'rendering'`，
> 卡片于是永远显示「写串中」，而实际上它已经在出图了。

`done` 时多一个 `result` 字段：

```json
{
  "ok": true, "jobId": "sj-...", "status": "done", "elapsedMs": 47300,
  "result": {
    "prompt": "moodyrealism, ... （最终提交的完整正向串）",
    "negative": "...",
    "scene": "（写手产出的 scene 串，未经拼层）",
    "configSet": "moss-real", "line": "moss",
    "characters": ["linxia"], "characterSource": "auto",
    "lint": { "warns": [], "infos": [], "skipped": null },
    "images": [{ "base64": "iVBOR...", "mediaType": "image/png", "width": 912, "height": 1216, "seed": 1234 }],
    "requestId": "sj-bcdecb6bc55e"
  }
}
```

- `images[].base64`：**纯 base64，不带 `data:` 前缀**。
- `images` 为空数组 = 失败（`NO_IMAGE`），正常不会出现在 `done` 里。
- `scene` 是写手（一次性补全）的原样产出，方便柏宝绘在卡片上展示「DSH 写了什么」。
- `requestId` 与 `jobId` 相同：拿它去配置台 `/story-image-admin` 的「请求历史」页，
  就能看到这一次请求完整的上下文（写手 system、画面占位、出稿、路由、耗时、报错）。
  写串**不再建 DSH 会话**，所以侧栏里不会出现 bridge-writer-*。

未知 `jobId` → 404 `{ ok:false, code:'NO_SUCH_JOB' }`。任务默认保留 **30 分钟**（`bridge.jobTtlMs`）后回收。

## 5. 错误码

| code | HTTP | 含义 / 柏宝绘侧处置 |
|---|---|---|
| `BAD_REQUEST` | 400 | 缺 `scene` 或字段非法。卡片显示原文。 |
| `UNAUTHORIZED` | 401 | 令牌不对。 |
| `TOO_BUSY` | 429 | 队列已满（`bridge.queueLimit`）。按 `retryAfterMs` 重试。 |
| `NO_SUCH_JOB` | 404 | jobId 不存在/已回收。放弃轮询并报错。 |
| `LLM_UNAVAILABLE` | 503 | 宿主 llm 服务缺失、解析不出路由、模型报错。可回落本地后端。 |
| `LLM_EMPTY` | 502 | 写手没产出可用串。可回落。 |
| `LINT_BLOCKED` | 422 | 机械自查不通过。**不回落**（回落等于绕过闸门）。 |
| `COMFY_UNAVAILABLE` | 503 | ComfyUI 连不上/超时。可回落。 |
| `NO_IMAGE` | 502 | 提交成功但一张图都没取回。可回落。 |
| `INTERNAL` | 500 | 其它异常。 |

**注意**：入队阶段的失败用 HTTP 状态码 + `{ok:false,code}`；任务跑起来之后的失败放在 `GET /job` 的 `status:'failed'` 里（HTTP 仍 200），同一个 `code` 词表。

## 6. 时序

```
柏宝绘                                    DSH
  │  POST /generate                        │
  │ ──────────────────────────────────────> │ 校验 → 入队 → 返回
  │  202 { jobId, pollAfterMs: 1500 }       │
  │ <────────────────────────────────────── │
  │  （立即释放连接，中继不再承担长等待）      │
  │                                         │  后台：一次直连补全 → 记请求历史
  │  GET /job/{id}   （1.5s 后）             │  → lint → ComfyUI → 取图
  │ ──────────────────────────────────────> │
  │  200 { status:'writing', requestId }    │
  │ <────────────────────────────────────── │
  │  ...每 2s 轮询一次...                     │
  │  GET /job/{id}                          │
  │ ──────────────────────────────────────> │
  │  200 { status:'done', result:{...} }    │
  │ <────────────────────────────────────── │
  │  落盘 → dataURL → saveImageResult       │
```

轮询间隔建议：首次 ≥ `pollAfterMs`，之后 2s，接近超时（剩 10%）时降到 1s。
总超时由柏宝绘侧 `timeoutMs`（默认 180s）控制；超了就停止轮询并报 `COMFY_UNAVAILABLE`。

## 7. 占位格式（柏宝绘 → 主模型）

```
<bbi_image><dsh>傍晚的走廊，林夏靠在窗边回头看他，逆光把发梢照透</dsh><size>portrait</size></bbi_image>
```

- 沿用 `<bbi_image>` 外壳 + `<dsh>` 子标签（没有 `<tag>`/`<nl>`，那是 autoTag 线路的写法）。
- **占位出现在正文的那个位置，图就落在那个位置**（锚点在 tag 的行内位置，水合按 DOM 顺序配对）。
  世界书要求模型把它插在所描述的那一段之后，而不是全文末尾——压尾写法会让图和情节错位。
- 占位由柏宝绘的托管正则换成空锚点，**永不进 DOM、永不进提示词**。
- 世界书条目正文见柏宝绘仓库 `src/autoTag/dshPlaceholder.ts` 的 `DSH_WORLDBOOK_ENTRY`。

## 8. 写手与请求历史（DSH 侧内部细节，不是协议字段）

写串是**一次直连补全**（`lib/writer-direct.js`：`ctx.get('llm').stream()` 单条 user + system），
**不建 DSH 会话**。这是刻意的：会话树是用户的，不该被 `bridge-writer-*` 灌满；
而真正需要的可观测性——「这一次请求到底发了什么、回了什么」——属于插件自己的账。

### 8.1 请求历史（`.state/requests.jsonl`）

每次写串请求追加一条（`lib/request-log.js`），在配置台 `/story-image-admin` 的
「请求历史」页里逐条展开看。字段：

| 字段 | 内容 |
|---|---|
| `id` | 与 `jobId` 相同（`sj-xxxxxxxxxxxx`）：从一张图能反查到它那次请求 |
| `status` | `ok` / `error` / `aborted` / `blocked` |
| `provider` / `model` / `route` | 写手路由，以及它是怎么解析出来的 |
| `configSet` / `size` / `characters` | 这一单用的配置集、画幅、角色 |
| `system` | **写手收到的完整 system 提示词**（该配置集的规范 + 契约 + 写串要点 + 输出纪律） |
| `scene` | 柏宝绘给的原样画面占位 |
| `instruction` | 实际发给模型的 user 文本（占位 + 画幅要求 + 角色清单） |
| `written` | 写手产出的 scene 串 |
| `prompt` | 送进 pipeline 的串（与 `written` 通常相同；不同就说明被上层清洗过） |
| `promptId` | ComfyUI 的 prompt id（出图成功时才有） |
| `elapsedMs` / `timings` | 总耗时 / 写串 / 出图三段 |
| `code` / `error` | 失败时的协议码与原因 |

**只出不进**：任何代码路径都不得把请求历史读回模型上下文（红线同 `runs.jsonl`）。
保留条数由 `history.requestsKeep`（默认 300）控制，超出滚动成 `requests.jsonl.1`。

### 8.2 与 `runs.jsonl` 的分工

| | `runs.jsonl` | `requests.jsonl` |
|---|---|---|
| 记什么 | 出图这一趟的**结果账**（verdict / lint / params / 图片文件） | 请求这一趟的**输入账**（system / 占位 / 出稿 / 路由 / 耗时 / 报错） |
| 谁写 | `pipeline.record()` | 桥接 `runJob()` |
| 页面 | 「运行历史」 | 「请求历史」 |

### 8.3 接口

`GET /story-image-admin/api/requests?limit=30[&id=sj-xxxxxxxxxxxx]` → `{ ok, dir, limit, requests: [...] }`

单独一个接口而不塞进 `/api/state`：一条请求带 system + 占位 + 出稿十几 KB，
概览/配置集那些页根本用不着；页面只在打开「请求历史」页时拉一页。

。