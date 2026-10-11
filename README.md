# dsh-tier-boost

给 DeepSeek 线路加六档推理等级（Low / Medium / High / xHigh / Max / Ultra），
并在高档位自动注入强化流程 / Agent Team 提示词。

档位显示名、行为块正文、出网值映射全部可以配置——**想改档位/文案/行为块/出网值都不用碰源码**。

## 安装

```bash
dsh plugin add dsh-tier-boost
```

装完在 profile 的 `cordis.patch.yml` 里加一条。两种上线方式，选一种：

### A. `mode: own` —— 通用路线（推荐给别人装）

用自己的 provider 名另起一条路，**不碰内置行**（内置 `deepseek-account` 照常可用）：

```yaml
- id: llm-tier-boost
  name: dsh-tier-boost
  config:
    mode: own
    provider: my-six-tier        # 省略时默认 = 插件名 dsh-tier-boost
    displayName: My Six Tier     # 省略时默认 = "dsh-tier-boost（六档）"
    extraProviders: []           # 同一套六档再作用到别的 provider 上，例如 [scnet]
```

### B. `mode: declare` —— DSH 内部路线（桌面端在用）

`declare` 靠**包裹宿主内置的 `deepseek-account` 适配器实例**实现（只改声明层、不动注册关系，
所以没有"内置行已停用但本插件还没注册上"的启动窗口）。代价是它**天生绑死
`deepseek-account` 这一个 provider**——所以它是 DSH 自己的用法，不是给第三方线路的通用路线：

```yaml
- id: llm-deepseek-account-tier
  name: dsh-tier-boost
  config:
    mode: declare
```

（注：`mode: declare` 和 A 里的 `mode: own` 底层都是 `@deepseek-ai/dsh-llm-deepseek` 的适配器实例——
换的是 provider 名，不是厂商。要在**别的厂商线路**上叠六档，走 `extraProviders`：
它包裹的是那条线自己的适配器，与厂商无关。）

插件自带补丁里那条 `config` 只是出厂样例；**同名 `- id` 的 profile 条目会整条覆盖它**，
所以真正生效的是 profile 里那份（改完看 `GET /plugins/<插件名>/state.json` 自证）。

## 为什么需要它

- 右下角的推理等级菜单**只显示适配器 advertise 的档位**，而内置的 `deepseek-account`
  适配器把档位硬编码成四项 `off/low/high/max`（`@deepseek-ai/dsh-llm-deepseek` 的
  `modelInfo()`），没有任何配置项能扩展它。
- 发往 `api.deepseek.com` 的 `output_config.effort` 也只接受 `off/low/high/max`
  四个值（同一个文件里校验，非法值抛 `UNSUPPORTED_REASONING_EFFORT`）。

所以"六档"必须是：**菜单里六档 ≠ 出网四档**，中间由适配器做映射。

## 六档映射（出厂默认）

| 菜单显示 | 档位 id | 出网 effort | 注入的提示词块 |
| --- | --- | --- | --- |
| Low | `low` | `off` | 无 |
| Medium | `medium` | `low` | 无 |
| High | `high` | `high` | 无 |
| xHigh | `xhigh` | `max` | 无（＝改造前的行为） |
| Max | `max` | `max` | 强化流程（判据先行 / 难题分解 / 迭代修复 / 收尾自检 / 交叉验证） |
| Ultra | `ultra` | `max` | 强化流程 + Agent Team |

行为块通过 `ctx.systemPrompt.section()` 注入；低档返回空串，渲染器会把空段丢掉
（`@deepseek-ai/dsh-system-prompt` 的 `renderPrompt` 里 `.filter((text) => text.length > 0)`），
所以不需要写死两套提示词。

出网映射本身也可以用 `wireMap` 换掉（见下），比如某条线路认 `none/minimal/medium/high`
或别的枚举时，不必改代码。

## 配置项

配置项（插件行的 `config`）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `mode` | `declare` | `own`（另起 provider 名，通用路线）/ `declare`（包裹内置 `deepseek-account`，DSH 内部路线）/ `takeover`（用内置名注册，需同时停用内置行） |
| `provider` | `own` → 插件名；其余 → `deepseek-account` | 用哪个 provider 名注册 |
| `displayName` | `own` → `"<插件名>（六档）"`；其余 → `DeepSeek Account` | 模型菜单里显示的 provider 名 |
| `takeover` | `false` | `mode: takeover` 的旧写法（等价）；新装请用 `mode` |
| `extraProviders` | `[]` | 同一套六档还要作用在哪些 provider 上（例：`[scnet]`）。只改声明层，不动注册关系 |
| `blocks` | `{}` | **内联覆盖行为块正文**，键 `methods` / `team` / `teamOff` / `teammate`；只给要换的那几块，其余留默认 |
| `blockDir` | 不读目录 | 从外部目录读 `<key>.md` 覆盖正文（同名时 `blocks` 内联胜）；文件缺失＝那块留默认 |
| `wireValues` | `['off','low','high','max']` | 出网合法值白名单。不在白名单里的档位会记一条 warn 并写进 `state.json` 的 `wire.outOfRange` |
| `wireMap` | 见上表 | 档位 id → 出网值的覆盖表，例：`{ xhigh: 'high' }`；没给的档位沿用默认 |
| `effortOverrides` | `[]` | 逐模型档位覆写，规则 `{ provider?, model?, effort, when? }` |
| `memoryTurnMarkers` | `['[meow-memory-reflect]', '[meow-memory-dream]']` | 哪些文本标记算"记忆轮"。没装 meow-memory 或对方改了文案，就把自己的标记填进来；**传了是替换，不是并集** |
| `selectionGuard` | `false` | 记忆轮的路由/模型切换把会话档位带偏时，把档位钉回用户选的那一档 |

### 行为块怎么换成自己的

```yaml
config:
  # 写法一：直接内联（只换 methods 一块，其余三块留默认）
  blocks:
    methods: |
      ## 我的强化流程
      1. 先写判据……
  # 写法二：指向一个目录，里面放 methods.md / team.md / teamOff.md / teammate.md
  blockDir: /path/to/my-blocks
```

`teamOff` 块里可以写 `{maxLive}` 占位符，会在渲染时替换成该档的子代理并发上限
（`low/medium/high/xhigh/max/ultra` = 1/2/3/4/6/8）。

### `when` 作用域（`effortOverrides`）

- 不写 / `'always'`：只要 provider/model 命中就生效。
- `'memory-turn'`：只在"记忆轮"命中，标记见 `memoryTurnMarkers`。
- `{ markers: ['[my-marker]'] }`：**任意标记**。你自己的插件在轮次里 emit 一句带标记的
  user/message，就能用同一套覆盖表（判定口径与 `memory-turn` 完全一样）。
- 认不出的字符串、空 `markers`、非字符串非对象写法：**整条规则丢弃**（宁可不生效，
  也不要拿一个写错的 when 去改所有请求的档位）。

`memoryTurnMarkers` 只影响 `'memory-turn'` 规则与 `selectionGuard` 的判定；
当前生效的标记、自定义 marker 命中的情况都可以在 `state.json` 里自证。

## 自证路由

宿主半边注册了 `/plugins/<插件名>`（本插件名是 `dsh-tier-boost`）：

- `GET /state.json` —— 当前 provider、模式、六档表、当前档位，以及四段自证：
  - `identity: { pluginId, route, provider, settingsNs }`（身份从插件名派生，不再散落字面量）
  - `wire: { values, map, patch, outOfRange }`（出网白名单与映射的实际取值）
  - `blocks: { source, dir, chars }`（行为块正文来自 `default` / `config` / `dir`，以及每块长度）
  - `memoryTurn: { markers, source }`（认哪些标记、来自 config 还是默认）
- `GET /probe?tier=max&model=deepseek-flash` —— 单独看某一档映射到哪个出网值、注入多少字节。

## 已知取舍

- 内置的 `resolveImageAttachmentAccess` 没有导出（不在 `dsh-llm-deepseek` 的导出名单里），
  本插件只服务文本请求；图片请求走回退路径（不改任何现有行为，因为图片本来也不走账号线路）。
- 旧的线上档位名 `low` 在新的六档里代表"轻思考→出网 low"，语义与旧的 `low` 不同；
  如果某条会话之前存了 `low` 选择，升级后会被解释成新六档的 Medium。
  默认档位已在 profile 里设成 `xhigh`（＝出网 `max`、不叠块），保持改造前的手感。
- `mode: own` 的默认 provider 名就是插件名本身；已经用 `provider:` 显式配过的不受影响。

## 想改六档？只改一个文件

`lib/policy.js` 是唯一的策略层（纯数据，不 import 任何模块）：

- 六档表 `TIERS`、出网翻译 `TIER_WIRE`、出厂兜底 `FALLBACK_TIER`；
- 逐档委派策略 `TEAM_POLICY`、团队工具族；
- **行为块正文** `DEFAULT_BLOCK_TEXTS`（`blocks` / `blockDir` 就是覆盖它）、`BLOCK_KEYS`、
  `normalizeBlockTexts()`、`blockTextsFrom()`、`renderBlock()`；
- **出网值** `DEFAULT_WIRE_VALUES`、`normalizeWireValues()`、`normalizeWireMap()`、
  `wireMapFrom()`、`wireToTierFrom()`；
- **自身身份** `routePrefixFor()` / `ownProviderFor()` / `settingsNsFor()`；
- 记忆轮标记默认值与 `normalizeMemoryTurnMarkers()`。

`lib/index.js` 只负责机制（改写适配器声明层、注入提示词块、滤工具表），
`lib/overrides.js` 与 `lib/selection-guard.js` 是纯函数层（不 import 任何 `@deepseek-ai/*`，
所以能被判据直接 import 做单测）。

所以加第七档只需要动 `lib/policy.js` 一处；形状由工作区判据钉住：
`checks/tier-boost-policy.check.mjs`（表本身）、`checks/tier-boost-generic.check.mjs`
（泛化：覆盖通道 / 身份派生 / 作用域泛化）。
