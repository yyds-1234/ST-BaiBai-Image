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
  "catalogLines": ["moss-anime"],
  "autoCast": "smart",
  "promptMaxChars": 4000,
  "bridge": { "version": "2.14.0", "concurrency": 2, "active": 0, "queued": 0, "tokenRequired": false }
}
```

- `protocol: 2` 是**能力判据**：柏宝绘发现协议版本 < 2 就说明对端还是 v1，直接报错提示升级，不静默降级。
- `llm.available=false` 时仍返回 200（通道通、写串能力不可用）。
- `llm.mode`：`'session'`（v2，写串走真实会话）｜`'direct'`（v1 兼容，直连补全）。
- `catalogLines`：**查动漫表的线**（配置集 frontmatter 有 `catalogFile` 的）。面板用它说清
  「哪条线能映射动漫角色」；老插件没有这个字段 → 柏宝绘按空数组处理（= 哪条线都不查表）。
- `autoCast`（**2.14.0**）：DSH 侧「自动认角色」的默认档位 —— `off` / `mechanical`（只认档案）/
  `smart`（还会让模型报名字，再由动漫表核对）。老插件没有这个字段 → 空串，面板据此提示「升级才有」。
  它只是**默认值**：请求里给 `autoCast: false` 可以单次关掉（见 §3.1）。

## 3. `POST {base}/generate` —— 只入队

### 3.1 请求体

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `scene` | string | 是 | **画面占位原文**：v2.0 的三行中文（人物名称 / 人物服装 / 场景描述）；旧版一段散文照样收。上限 `promptMaxChars × 2`。 |
| `roles` | `{name,charBlock}[]` | 否 | 角色块旁路：DSH 不查档案、不过 line 门禁、不套用 LoRA / 风格档，`charBlock` 交给写手并拼进正向（第一个站主角位）。`charBlock` **两种写法都合法**：一句连贯英文描述（推荐，贴散文流底模）或一串 danbooru 短 tag；DSH 不判别、不转换。柏宝绘用它送**没做档案映射**的人。 |
| `characters` | string[] | 否 | 名字数组，走 DSH 自己的档案：拿名字去 identities/*.md 认人、挂 LoRA、过 line 门禁。每项可写 `显示名：引用`（冒号前是写手与回执看到的名字，冒号后是去档案查的 id / 动漫表角色名）；不带冒号时整串当引用。柏宝绘用它送**档案映射命中**的人。 |
| `autoCast` | boolean | 否 | **自动认角色**（2.14.0）：没点名角色时，让 DSH 自己从 `scene` 里认人（档案名 / 别名；动漫线上还会让模型报名字，再由动漫表核对）。不传 = 按 DSH 的 `bridge.autoCast`（默认 `smart`）；`false` = 这一单别认。**点名优先**：`characters` 非空时自动认必定关闭（用户说了是谁，就不该有第二套答案）。 |
| `size` | `'portrait'` \| `'landscape'` | 否 | 默认 `portrait`。DSH 会按它摆正宽高（对调，像素总数不变）。 |
| `configSet` | string | 否 | 配置集 id。柏宝绘把空串收口成 **`moss-real`**（moss 真人线）再发，与阅读器发配置集同字段；DSH 侧仍按原语义「留空用默认集」。 |
| `negative` | string | 否 | 追加负向串；与配置集 `negativeHint` **合并**，不替换。 |
| `count` | integer | 否 | 1..8，默认 1。柏宝绘只落第一张。 |
| `seed` | integer | 否 | 复现种子；0/缺省 = 随机。 |
| `source` | object | 否 | `{ chatId, messageId, slot }`，纯诊断，进 `runs.jsonl`，不进提示词。 |

> **角色来源（v2 起的定死口径）：两条通道，可以同时给**
>
> | | `roles`（旁路块） | `characters`（名字 → 档案/表） |
> |---|---|---|
> | 谁管长相 | **柏宝绘角色库** | DSH 插件（`identities/*.md` 或动漫表） |
> | 形象块从哪来 | 请求里的 `charBlock`，交给写手 | 档案的 `char_block` / 动漫表的 `copy_prompt` |
> | LoRA | 不挂 | 按档案挂 |
> | 风格档 / 剖面档 | 不套用 | 按档案 |
> | `line` 门禁 | **不参与** | 参与（跨线默认整单报错） |
> | 两边名字要对上吗 | **不需要** | 必须对得上（或由调用方映射） |
>
> 合并规则（2026-11-14 起）：`characters` 里的人**先入位**（第一位站主角位、按档案挂 LoRA），
> `roles` 里的块**追加在后面**（没有 LoRA / 风格档）。只给 `roles` 时整条走老旁路、一个词都不从
> identities 拿 —— 与升级前逐字一致。
>
> 为什么允许并存：柏宝绘这两条都要 —— 用户在「档案映射」里把「林夏」指到 DSH 的 `26-小静`（走
> `characters`，能用档案的长相与 LoRA），同一张图里的旁人仍可能只在他自己的角色库里（走 `roles`）。
> 二选一会让人被迫在「这张图少一个人的长相」和「那张图挂不上 LoRA」之间挑。

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
    "catalogCharacters": ["胡桃：hu tao (genshin impact)"],
    "autoCast": {
      "source": "smart",
      "characters": ["胡桃：hu tao (genshin impact)"],
      "notes": ["自动认角色：正文里出现「胡桃」→ 动漫表 hu tao (genshin impact)"]
    },
    "lint": { "warns": [], "infos": [], "skipped": null },
    "images": [{ "base64": "iVBOR...", "mediaType": "image/png", "width": 912, "height": 1216, "seed": 1234 }],
    "requestId": "sj-bcdecb6bc55e"
  }
}
```

- `images[].base64`：**纯 base64，不带 `data:` 前缀**。
- `images` 为空数组 = 失败（`NO_IMAGE`），正常不会出现在 `done` 里。
- `scene` 是写手（一次性补全）的原样产出，方便柏宝绘在卡片上展示「DSH 写了什么」。
- `catalogCharacters`（2.14.0）：动漫表命中的人（`显示名：动漫表角色名`）。它们没有档案，
  所以 `characters` 里看不到，但 `copy_prompt` 是真的原样注入了 —— 分开报才说得清「这张图里是谁」。
- `autoCast`（2.14.0）：**这一单 DSH 自己认出了谁**。`source` 是 `mechanical`（只按档案 / 别名 /
  表里字面名）或 `smart`（还问过模型，名字经机械核对）；`notes` 是逐条说明（认成哪一条、哪条因
  歧义被跳过）。没认到人时整个字段不出现 —— 客户端据「有没有这个字段」决定要不要提示，不必判空数组。
- `requestId` 与 `jobId` 相同：拿它去配置台 `/story-image-admin` 的「请求历史」页，
  就能看到这一次请求完整的上下文（写手 system、画面占位、出稿、路由、耗时、报错）。
  写串**不再建 DSH 会话**，所以侧栏里不会出现 bridge-writer-*。

未知 `jobId` → 404 `{ ok:false, code:'NO_SUCH_JOB' }`。任务默认保留 **30 分钟**（`bridge.jobTtlMs`）后回收。

## 4.5 选择器接口（只读，给面板挑人用）

「把占位里的人名映射到 DSH 的角色」这件事只能由看得见档案的那一侧回答 —— 档案在 DSH 那台
机器的磁盘上，浏览器读不到。故有两条只读接口，都**不产生任务、不写任何东西**。

### `GET {base}/identities`

```json
{
  "ok": true,
  "identities": [
    { "charId": "26-小静", "name": "小静", "line": "moss-real", "aliases": ["瑶瑶", "yao yao"], "blockChars": 1365 }
  ]
}
```

- 只回选择器需要的字段，**不回 `char_block` 原文**（十几份档案加起来几十 KB，挑人一个字都用不上）。
- `line` 是档案绑的配置集；空串 = 通用（哪条线都能用）。
- `blockChars = 0` = 这份档案没有形象块（选了也只会挂 LoRA），面板会标注。

### `GET {base}/catalog?line=<配置集>&q=<关键词>&limit=<n>`

```json
{
  "ok": true,
  "line": "moss-anime",
  "query": "hu tao",
  "total": 3,
  "entries": [{ "name": "hu tao (genshin impact)", "copyright": "genshin impact", "kind": "character" }]
}
```

- 动漫线的映射**映射的不是档案，而是表里的角色名**（`hu tao (genshin impact)`），
  所以必须能按关键词把表搜出来；`copy_prompt` 不出网（出图时 DSH 按名字再查一次）。
- `line` 不传 = 用默认配置集；那条线没配 `catalogFile` → **400** + 一句人话
  （「这条线只能选档案，不能映射动漫角色名」），面板原样展示。

## 4.6 `POST {base}/cast/detect` —— 试跑自动认角色（不出图）

给一段正文，回「这一单自动认角色会认出谁」。**不写串、不出图、不产生任务**，几秒内返回。

```json
POST { "scene": "芙宁娜坐在歌剧院高台上，胡桃靠在柱子旁打哈欠。", "configSet": "moss-anime", "autoCast": true }

→ 200
{
  "ok": true,
  "line": "moss-anime",
  "mode": "smart",
  "source": "smart",
  "characters": ["芙宁娜：furina (genshin impact)", "胡桃：hu tao (genshin impact)"],
  "notes": [
    "自动认角色：正文里出现「胡桃」→ 动漫表 hu tao (genshin impact)",
    "自动认角色：模型认出正文里的「芙宁娜」→ 动漫表 furina (genshin impact)（名字在正文里核对过、表里也确有名）"
  ],
  "catalog": true
}
```

- 入参：`scene`（必填）、`configSet`（也认 `line`）、`autoCast`（`false` / `true` / `'mechanical'`）。
  不传 `autoCast` 就按 `bridge.autoCast`（默认 `smart`）；真人线一律降到 `mechanical`（没有表可查）。
- `characters` 与 `/generate` 的 `characters` **同形**（`显示名：引用`）：客户端可以直接把它塞回请求。
- `catalog` = 这条线有没有动漫表（`false` 表示只可能认档案）。
- 为什么单开一条：平时认人藏在 `/generate` 里，要等一整张图（40～90s）才知道认成了谁；
  面板的「试跑自动认角色」用它当场看清「机械层认到谁、模型层又补了谁」——认错了立刻改映射或关开关。
- 动漫线上会走一趟识别模型（几秒）；那一趟失败只影响这次预览，理由进 DSH 日志，不影响出图。

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
<bbi_image><dsh>人物名称：林夏
人物服装：米色长风衣，右手收着黑伞
场景描述：傍晚的天台，她侧身回头，逆光把发梢照透
</dsh><size>portrait</size></bbi_image>
```

- 沿用 `<bbi_image>` 外壳 + `<dsh>` 子标签（没有 `<tag>`/`<nl>`，那是 autoTag 线路的写法）。
- **`<dsh>` 固定三行**（v2.1）：人物名称 / 人物服装 / 场景描述，顺序固定、标签固定。
  三行缺一不可；旧版「一段中文散文」的占位原样照发，不做强制迁移。
- **场景描述一句话就够**（在哪 + 在做什么，单帧），光 / 景别 / 机位可选。
  世界书是弱约束（只是每轮拼进提示词的一段话），条目故意只钉格式、不钉颗粒度；
  容错放在插件侧：标签顺序写歪、半角冒号、行被折成一行、整段散文，都能收。
- 三行**一起**进 §3.1 的 `scene` 字段：插件在发请求前按标签把顺序与全角冒号拉直
  （`dshSceneForBridge`），DSH 侧看到的形状因此与阅读器送正文时完全一致——
  两边用的都是 `scene`，不是各自一套自定义字段。
- `configSet` 随请求发 **moss 真人线 `moss-real`**（面板留空时由 `effectiveDshBridge` 收口），
  与阅读器把配置集随请求发是同一个字段、同一种语义。
- **占位出现在正文的那个位置，图就落在那个位置**（锚点在 tag 的行内位置，水合按 DOM 顺序配对）。
  世界书要求模型把它插在所描述的那一段之后，而不是全文末尾——压尾写法会让图和情节错位。
- 占位由柏宝绘的托管正则换成空锚点，**永不进 DOM、永不进提示词**。
- 世界书条目正文见柏宝绘仓库 `src/autoTag/dshPlaceholder.ts` 的 `DSH_WORLDBOOK_ENTRY`；
  `docs/worldbook/01-柏宝绘-DSH画面占位.json` 的 uid 1 与它逐字相同（单测锁着）。

### 7.1 档案映射（名字 → DSH 档案 / 动漫角色）

占位里的名字是**这本书里的人**（林夏），DSH 的档案是**插件那侧的角色**（`26-小静`），两边不必同名。
柏宝绘面板的「渠道 → DSH 写手 → 档案映射」把两者对上：

| 面板列 | 写什么 | 存成 |
|---|---|---|
| 名字 | 占位「人物名称：」里那一行写的那串，**一字不差** | `charMappings[].name` |
| 映射到 | 从 `GET /identities` 的档案 / `GET /catalog` 的动漫角色里选一项 | `kind`（`archive` / `catalog`）+ `ref` + `line` |

出图时的机械规则（`state/dshCharMap.ts` 的 `planDshCharacters`，纯函数）：

1. 只有名字**字面出现在这一条的占位里**才发（映射不是「每单都注入」）；长名优先（「雪」不会吃掉「小雪」）；
   命中项按首次出现位置排序 —— **第一位站主角位**（与阅读器同一口径）。
2. 命中的写进 `characters: ['林夏：26-小静']`；**同一个人不再进 `roles`**（两套长相会打架）。
3. `line` 不符的映射**不发**：`archive` 要求「同线或通用（`line` 留空）」，`catalog` 要求线与当前
   配置集完全一致（每条线查各自的表）。DSH 的 `lineGate` 默认 `strict`，跨线会让**整单报错**，
   所以柏宝绘先自己滤掉，并在出图前弹一句提醒（静默跳过只会留下「这张脸不对」）。
4. 没被映射的人照旧走 `roles`（柏宝绘角色库的块）。两路并存见 §3.1 的合并规则。

> 为什么映射只存 id 与线、不存外貌：长相的真源在 DSH 的档案里。DSH 改了 `char_block` / LoRA，
> 下一单自动跟着变 —— 柏宝绘存一份快照就等于让同一件事有两个真源。

### 7.2 自动认角色（没配映射时 DSH 自己认，2.14.0）

「映射」是**用户说**「这个人是 DSH 的谁」；「自动认角色」是**DSH 自己看**占位正文认。
两者在同一单里互斥：只要 `characters` 非空（映射命中过），自动认必定关闭 —— 点名优先，
否则同一张图会有两套答案。

启用条件：请求没点名角色 + `autoCast` 不是 `false` + DSH 侧 `bridge.autoCast` 不是 `off`。
总上限 **3 人**，三层按成本从低到高，前一层的收获会挤掉后一层的名额：

| 层 | 认什么 | 判据 | 在哪些线生效 |
|---|---|---|---|
| ① 档案 | 正文里字面出现的档案名 / 别名（「瑶瑶」→ `26-小静`） | `detectIdentities`，只认**本线可用**且未被停用的档案 | 全部 |
| ② 动漫表机械命中 | 中文别名表（`胡桃 → hu tao (genshin impact)`）+ 正文里的罗马字**多词**专名（`Hu Tao`） | `lookupCatalog` **精确命中**；同名多版本一律跳过并告警 | 只查动漫表的线 |
| ③ 模型提议 | 让写手那台模型读一遍正文，报出正在场的角色名 | **两道机械校验**：名字必须逐字在正文里、罗马字必须在表里查得到；验不过就丢 | 只查动漫表的线 |

纪律（为什么这么保守）：

- **绝不猜**：同名多版本（`asuna (sao)` / `asuna (blue archive)`）不选；查不到的名字不硬塞 ——
  塞错人比不塞更糟（画面会变成另一个人）。
- **单词罗马字不进机械层**：表里就有 `rose` / `star` / `doctor` / `king`，英文正文里随便一句
  "the rose in her hand" 都会被认成宝可梦的 Rose。单词专名交给模型那层（它看得懂语境，再由表核对）。
- **调用方已给块的人不重复注入**（`roles` 的 `name` 会被挡掉）：同一个人两套长相会在串里打架。
- 认出来的名字**走正常通道**（`characters`）：档案那批查形象块 / 挂 LoRA；动漫表那批查
  `copy_prompt` 并**原样注入**（一字不改）。所以「自动认」不是第二条拼串路径，只是替用户填了一次
  `characters` —— 出图结果与「用户自己映射了同样几个人」逐字一致。
- 回执里单独报：`autoCast`（谁认出来的、机械还是模型）、`catalogCharacters`（哪些来自动漫表）、
  以及 `warnings` 里的逐条说明（认成哪一条、哪条因歧义跳过）。
- 关掉的两处：面板「渠道 → DSH 写手 → 自动认角色」（发 `autoCast: false`），
  或 DSH 侧配置 `bridge.autoCast: 'off'`（影响所有调用方，包括阅读器）。

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