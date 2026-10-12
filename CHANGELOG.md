# Changelog

## dsh-tier-boost v1.1.0 — 2026-10-13

### 档位可以叠加多个行为块

- `TIERS[].block` 从单值改成**数组**：一档可以挂多块（`['methods']` / `['methods','methodsDeep']` /
  `['methods','methodsDeep','team']`）。
- `BLOCK_KEYS` 现在是五种：`methods` / `methodsDeep` / `team` / `teamOff` / `teammate`；
  `blocks`（内联覆盖）与 `blockDir`（`<key>.md`）跟着支持五种键，内联优先、缺的键留默认。
- `teamOff` 块里的 `{maxLive}` 渲染成该档的并发上限；`renderBlock()` 只替换这一个占位符，
  正文里其他花括号（JSON 示例、模板）原样留着。

### low / medium 档不再能派子代理

- 新增 `NO_DELEGATION_TIERS`（出厂 `low`、`medium`）：这两档的工具表里**直接滤掉**
  团队工具与单发子代理工具（`hiddenToolsFor()`）。
- 另加一层 `tools.guard`（`delegationGate`）：工具万一被别处放出来，这两档的调用也会被拒，
  并给出可读原因——两层是双保险，互不依赖。
- 其余档的单发子代理并发上限逐档为 1 / 2 / 3 / 4 / 6 / 8（`TEAM_POLICY`）。

### 六档说明文案

- `TIERS[].description` 补齐：档位选择器里每行写清"用途 + 容量"
  （例：High = 标准思考 · 改代码、查根因、写脚本（日常默认），子代理 ≤3）。
  文案仍写在档位表里，改它只动 `lib/policy.js` 一处。

### 验证

- 三条判据全绿：`checks/tier-boost-policy.check.mjs`（表自洽与标记行为）、
  `checks/tier-boost-generic.check.mjs`（覆盖通道 / 身份派生 / 作用域泛化）、
  `checks/tier-boost-package.check.mjs`（发布件形状）；元判据
  `checks/discrimination.check.mjs` 给前两条各留了"坏样本必须报红"的用例。

## dsh-tier-boost v1.0.0 — 2026-10-11

第一次公开：从"只在本机 plugins-src + profile/node_modules 里活着"变成可安装、可给别人用的包。

### 结构：策略层单源化

- 新增 `lib/policy.js`（纯数据，不 import 任何东西）：六档表 `TIERS`、出网翻译
  `TIER_WIRE`/`WIRE_TO_TIER`、出厂兜底 `FALLBACK_TIER`、逐档委派策略 `TEAM_POLICY`、
  团队工具族 `TEAM_COLLAB_TOOLS`/`TEAM_TOOLS`/`SUBAGENT_TOOLS`/`DELEGATION_TOOLS`/
  `TEAMMATE_HIDDEN_TOOLS`/`SPAWN_TOOL`、记忆轮标记默认值 `DEFAULT_MEMORY_TURN_MARKERS`
  与清洗函数 `normalizeMemoryTurnMarkers()`。
- `lib/index.js` 不再自带这些表（它只剩机制：改写适配器声明层、注入提示词块、滤工具表）。
  加第七档从"改 5 个文件"变成"改 policy.js 一处 + 判据跟着走"。

### 配置：记忆轮标记不再写死

- 新增配置项 `memoryTurnMarkers: string[]`：哪些文本标记算"记忆轮"。
  默认 `['[meow-memory-reflect]', '[meow-memory-dream]']`（meow-memory 的整理/做梦标记）。
  没装 meow-memory、或对方改了文案，就把自己的标记填进来；**传了就是替换，不是并集**。
- 新增配置项 `extraProviders: string[]`：同一套六档还要作用在哪些 provider 上。
  **默认空表**（旧版本默认 `['scnet']`，那是本机网络拓扑，不该是别人的默认值）。
- `GET /state.json` 新增 `memoryTurn: { markers, source }`，用来验证当前这一份标记是从
  config 来的还是默认值。

### 泛化：改档位/文案/行为块/出网值都不用碰源码

- 行为块正文搬进 `lib/policy.js` 的 `DEFAULT_BLOCK_TEXTS`
  （`methods`/`team`/`teamOff`/`teammate`），新增配置项 `blocks`（内联覆盖）与
  `blockDir`（`<key>.md` 外部覆盖，内联优先）；`{maxLive}` 占位符由 `renderBlock()` 渲染。
  `lib/index.js` 里不再有提示词正文。
- 出网值可配：新增 `wireValues`（白名单，默认 `['off','low','high','max']`）与
  `wireMap`（档位 id → 出网值，覆盖默认表）。反查表 `wireToTierFrom()` 跟着映射走，
  保证内置适配器的 `defaultEffort` 仍能翻成六档名。
- `when` 作用域泛化：除 `'always'` / `'memory-turn'` 外支持 `{ markers: ['[x]'] }`；
  标记扫描统一走 `lib/selection-guard.js` 的 `firedMarkers()`（`isMemoryTaskTurn()` 复用它，
  两条判定永不漂移）。认不出的 `when`（非字符串非对象、空 `markers`）整条规则丢弃。
- 身份不再散落字面量：路由前缀 / `own` 模式默认 provider 名 / `settingsNs` 兜底
  改为由插件名派生（`policy.js` 的 `routePrefixFor()`/`ownProviderFor()`/`settingsNsFor()`）。
  内置 `deepseek-account` 是宿主契约，仍保留字面量。
- `mode: own` 的默认 provider 名从 `deepseek-account-tier` 改成插件名本身
  （显式配过 `provider` 的不受影响）。
- `GET /state.json` 新增 `identity` / `wire` / `blocks` 三段自证。
- 新增判据 `checks/tier-boost-generic.check.mjs`（覆盖通道 / 身份派生 / 作用域泛化，含区分度自检）。

### 发布就绪

- `package.json`：补 `license`/`author`/`repository`/`homepage`/`bugs`/`engines`/`keywords`，
  去掉 `private: true`，`exports` 补 `"./cordis.patch.yml"`，`files` 补 `LICENSE`、`CHANGELOG.md`。
- 新增 `LICENSE`（MIT）、`CHANGELOG.md`、`.gitignore`。
- 新增判据 `checks/tier-boost-policy.check.mjs`（单源化 + 标记行为）与
  `checks/tier-boost-package.check.mjs`（发布件），详见工作区 `checks/`。

## dsh-tier-boost v0.1.0 — 2026-10-08

- 六档推理等级：菜单六档 `low/medium/high/xhigh/max/ultra` ≠ 出网四档
  `off/low/high/max`，中间由适配器映射；`max`/`ultra` 额外注入强化流程 / Agent Team 行为块。
- 两种模式：`takeover: false` 新路由（`deepseek-account-tier`，内置行不动）、
  `takeover: true` 接管 `deepseek-account`。
- 逐模型档位覆写 `effortOverrides`（规则 `{ provider?, model?, effort, when? }`，
  `when: 'memory-turn'` 只在记忆轮命中）。
- `selectionGuard`：防止"记忆轮的路由/模型切换"把会话档位带偏。
