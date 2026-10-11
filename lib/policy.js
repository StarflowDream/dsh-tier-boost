/**
 * dsh-tier-boost / policy —— **策略层的唯一真相源**（纯数据，不 import 任何东西）。
 *
 * 为什么单独一个文件（用户 2026-10-11 问「同一张表有三份真相源是什么意思」）：
 *   六档的"出场名 / 中文描述 / 出网值 / 启用哪块行为提示词"原来同时活在 5 个地方
 *   （本文件的这套常量原本写死在 lib/index.js，另在 checks/tier-policy.json、
 *   checks/tier-policy.check.mjs、checks/tier-boost.check.mjs、checks/tier.check.mjs 各抄一份）。
 *   加一档要改 5 个文件，漏一处就静默漂移——判据之间能对账不代表不会漏，只代表漏了会红。
 *   现在：**这里定义一次**，插件与判据一律 import（判据 `checks/tier-boost-policy.check.mjs`
 *   就是"别再抄回去"的那道门）。
 *
 * 三层分工：
 *   · 本文件（策略层）：六档表、出网翻译、逐档委派策略、团队工具族、记忆轮标记。改策略只改这里。
 *   · lib/index.js（机制层）：把这张表接到宿主适配器 / 工具表 / 提示词上。加 provider、换模式都在这。
 *   · lib/overrides.js、lib/selection-guard.js（纯函数）：与宿主无关的判定逻辑，判据直接 import 测。
 *
 * 注意（2026-10-11 更新）：行为提示词的**正文**也搬进本文件了（DEFAULT_BLOCK_TEXTS）。
 * 之前它们以 `METHODS_BLOCK / TEAM_BLOCK / teamOffBlock() / TEAMMATE_BLOCK` 四个字面量活在
 * lib/index.js 里，想换语气/换语言就得改代码；现在这里是出厂默认，用户可用
 * `config.blocks` 内联覆盖或 `config.blockDir` 指向一组 .md 文件覆盖。
 */

/**
 * 六档。`wire` 是出网时用的合法值（宿主只认 off/low/high/max）；`block` 是启用哪块行为提示词；
 * `name`/`description` 直接显示在档位选择器里。
 */
export const TIERS = [
  { id: 'low', name: 'Low', wire: 'off', block: 'none', description: '不思考直接答（原 off）· 团队关，子代理 ≤1' },
  { id: 'medium', name: 'Medium', wire: 'low', block: 'none', description: '轻思考（原 low）· 团队关，子代理 ≤2' },
  { id: 'high', name: 'High', wire: 'high', block: 'none', description: '标准思考（原 high）· 团队关，子代理 ≤3' },
  { id: 'xhigh', name: 'Extra High', wire: 'max', block: 'none', description: '深度思考（原 max），不加额外流程 · 团队关，子代理 ≤4' },
  { id: 'max', name: 'Max', wire: 'max', block: 'methods', description: '深度思考 + 强化流程：判据先行 / 难题分解 / 迭代修复 / 收尾自检 · 团队关，子代理 ≤6' },
  { id: 'ultra', name: 'Ultra', wire: 'max', block: 'team', description: 'Max 的全部 + Agent Team：任务板、并行队友 ≤8、交叉验收' },
]

/** 档位 id → 出网值（Menu 六档 ≠ 出网四档）。 */
export const TIER_WIRE = new Map(TIERS.map((tier) => [tier.id, tier.wire]))

/** 档位 id → 行为提示词块的键（'none' = 不注入）。 */
export const TIER_BLOCK = new Map(TIERS.map((tier) => [tier.id, tier.block]))

/** 旧的线上档位 → 六档里的等价档（用于把内置适配器的 defaultEffort 翻成六档里的名字）。 */
export const WIRE_TO_TIER = { off: 'low', low: 'medium', high: 'high', max: 'xhigh' }

/** 出厂默认：保持"线上 max、不叠行为块"，即改造前的行为。 */
export const FALLBACK_TIER = 'xhigh'

/**
 * 逐档的委派策略：只有 Ultra 开团队协作工具；其余档位只留"派单发子代理"的通道。
 * `maxLive` 是"同一时刻在跑的子代理数"上限（跑完即释放，管的是并发爆发不是总量）。
 * 梯度按用户 2026-10-08 拍板：1/2/3/4/6/8，Ultra 对齐 dsh-subagent 的 maxActiveSubagents 默认值 8。
 */
export const TEAM_POLICY = new Map([
  ['low', { team: false, maxLive: 1 }],
  ['medium', { team: false, maxLive: 2 }],
  ['high', { team: false, maxLive: 3 }],
  ['xhigh', { team: false, maxLive: 4 }],
  ['max', { team: false, maxLive: 6 }],
  ['ultra', { team: true, maxLive: 8 }],
])

/**
 * "智能体团队"整族里除 spawn_teammate 之外的协作件；与 SPAWN_TOOL 合起来就是 TEAM_TOOLS。
 * 非 Ultra 档把整族从**工具表**里滤掉（不是"调用时拒绝"，是真的不出现在请求里）。
 */
export const TEAM_COLLAB_TOOLS = [
  'send_message',
  'list_agents',
  'wait_agent',
  'interrupt_agent',
  'team_task_create',
  'team_task_list',
  'team_task_get',
  'team_task_update',
]

export const SPAWN_TOOL = 'spawn_teammate'

/** 团队整族（9 件）：非 Ultra 档一律滤掉，Ultra 档全留。 */
export const TEAM_TOOLS = [...TEAM_COLLAB_TOOLS, SPAWN_TOOL]

/** 单发子代理通道：非 Ultra 档保留（受 maxLive 限数），被派出去的一方滤掉（深度恒 1）。 */
export const SUBAGENT_TOOLS = ['subagent', 'subagent_fork']

/** 委派类工具全集：硬闸要拦的名字（团队整族 + 单发子代理）。 */
export const DELEGATION_TOOLS = new Set([...TEAM_TOOLS, ...SUBAGENT_TOOLS])

/** 被派出去的一方（队友 / 普通子代理）不能再往下派：这族名字从它的工具表里滤掉。 */
export const TEAMMATE_HIDDEN_TOOLS = [SPAWN_TOOL, ...SUBAGENT_TOOLS]

/**
 * "记忆任务轮"（meow-memory 的反思/梦境轮）的**默认**识别标记。
 *
 * 这是一条跨插件的**暗契约**：标记是 meow-memory 自己 emit 到 user/message 文本里的私有常量
 * （见其 lib/index.js）。写死在代码里的后果有两个，都真实发生过：
 *   · 没装 meow-memory 的人：这个能力无所指，`when: 'memory-turn'` 一条都不会命中；
 *   · meow-memory 改了文案：本插件**静默失效**（2026-10-09 事故——标记扫不到，全部落回
 *     always 兜底 `xhigh`，用户只感觉"整理记忆变慢了"，界面上看不到任何报错）。
 * 所以它必须能被 `config.memoryTurnMarkers` 覆盖（判据里有行为断言）。
 */
export const DEFAULT_MEMORY_TURN_MARKERS = Object.freeze(['[meow-memory-reflect]', '[meow-memory-dream]'])

/**
 * 规整配置里的 `memoryTurnMarkers`：只认非空字符串，去空白、去重；给不出有效列表就回默认表。
 *
 * 语义是**替换**而不是并集：写错标记 = 完全认不出来（可以在 state.json 的 `memoryTurn.markers`
 * 里看到实际在用哪几个），但也正因为是替换，不会出现"新旧两套标记各认一半"的半失效状态。
 */
export function normalizeMemoryTurnMarkers(raw) {
  if (!Array.isArray(raw)) return [...DEFAULT_MEMORY_TURN_MARKERS]
  const list = [...new Set(raw
    .filter((marker) => typeof marker === 'string')
    .map((marker) => marker.trim())
    .filter((marker) => marker.length > 0))]
  return list.length > 0 ? list : [...DEFAULT_MEMORY_TURN_MARKERS]
}

// ---------------------------------------------------------------------------
// 行为提示词正文（出厂默认）
// ---------------------------------------------------------------------------

/**
 * 四块行为提示词的**出厂默认正文**。`{maxLive}` 是唯一的占位符（`renderBlock` 会替换它）。
 *
 * 为什么放这里而不是 lib/index.js（2026-10-11 用户：「想改档位/文案/行为块不用碰源码」）：
 * 之前它们是 index.js 里的四个字面量，想换语言/换语气只能改代码。现在三层覆盖：
 *   `config.blocks`（内联）> `config.blockDir` 下的 `<key>.md` > 这里的出厂默认。
 * key 与 `TIERS[].block` 取值一致：`methods` / `team` / `teamOff` / `teammate`。
 */
export const DEFAULT_BLOCK_TEXTS = Object.freeze({
  methods: `## 推理档位：Max → 强化流程已开启
本档位把"多做一步"当默认动作，按顺序执行：
1. **判据先行**：动手前先写清"什么算完成"，配一条能跑的验证命令与期望信号；给不出判据就先补，别开工。
2. **先证明会失败**：判据写好先跑一次，得看到它失败；一次就通过的判据没有区分度。
3. **难题分解**：一次只推进一个可验证的小步，每步过判据，别攒到最后统一验。
4. **迭代修复**：失败就把报错原文喂回去再改，最多五轮；连续两轮同一个错误就换思路，不要原地重试。
5. **收尾自检**：给答案前重跑判据，与预期逐项对账（退出码/字段/行数/数字）；对不上就明说，不许含糊过去。
6. **交叉验证**：关键结论用第二条独立路径再算一遍（不同工具、不同数据源或不同算法），两条不一致就报不一致。`,
  team: `## 再追加：Agent Team 已开启（Ultra）
在 Max 的全部动作之上，长任务优先拆给队友并行：
- 先划分互不重叠的写作用域，一个队友一个作用域；共享文件只由 Lead 改。
- 每份队友产出都要有自己的判据；复核时只看产物与判据结果，不采信队友的转述。
- Lead 负责最终合并、重跑总闸、对用户交付；队友没跑完不许下结论。
- 同一件事只做一遍：派给队友的活自己不再算一遍，也不把同一件事派给两个人。`,
  teamOff: `## 子代理策略：团队协作关闭（本档）
- 本档没有团队工具：任务板、派队友、队友互发消息、打断队友、等队友——这些名字根本不在你的工具表里。
- 只能用 subagent / subagent_fork 派单发子代理：同一时刻最多 {maxLive} 个在跑（硬闸，超了会被拒绝）。
- 同一件事只算一遍：派出去了就别自己再算一遍；子代理会自己回报，收到回报先看产物（命令 / 退出码 / 文件路径）再采信。
- 子代理不能再往下派：本档的委派深度就是 1 层。`,
  teammate: `## 你这一轮的身份：被派出去的队友 / 子代理
- 只做 Lead 指派的那件事，别扩范围、别顺手改别的东西。
- 你不能再派子代理（平台不允许）。
- 汇报带证据：命令、退出码、关键输出、改过的文件路径；拿不到证据就直说拿不到。`,
})

/** 行为块的四个键（`blockDir` 下认的文件名就是 `<key>.md`）。 */
export const BLOCK_KEYS = Object.freeze(['methods', 'team', 'teamOff', 'teammate'])

/**
 * 规整 `config.blocks`：只认四个已知键 + 非空字符串，其余一律忽略。
 * 返回**覆盖补丁**（没给的键不出现），调用方与 `DEFAULT_BLOCK_TEXTS` 合并——
 * 这样"只想换 methods 一块"不用把另外三块也抄一遍。
 */
export function normalizeBlockTexts(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const patch = {}
  for (const key of BLOCK_KEYS) {
    const value = raw[key]
    if (typeof value === 'string' && value.trim().length > 0) patch[key] = value
  }
  return patch
}

/** 合成最终正文表（出厂默认 ← 覆盖补丁）。 */
export function blockTextsFrom(patch) {
  return { ...DEFAULT_BLOCK_TEXTS, ...(patch ?? {}) }
}

/** 渲染一块正文：只替换 `{maxLive}`，其他花括号原样留着（正文里可能有 JSON/模板示例）。 */
export function renderBlock(text, vars) {
  if (typeof text !== 'string') return ''
  const maxLive = vars !== null && typeof vars === 'object' && Number.isInteger(vars.maxLive) ? String(vars.maxLive) : ''
  return text.replaceAll('{maxLive}', maxLive)
}

// ---------------------------------------------------------------------------
// 出网值（wire）白名单与映射
// ---------------------------------------------------------------------------

/**
 * 出网合法值的**出厂默认**白名单。内置 `deepseek-account` 线路只认这四个；
 * 别家端点认别的值（或想换一套映射）时走 `config.wireValues` / `config.wireMap`，不用改代码。
 */
export const DEFAULT_WIRE_VALUES = Object.freeze(['off', 'low', 'high', 'max'])

/** 规整 `config.wireValues`：非空字符串、去重；给不出有效列表就回默认四值。 */
export function normalizeWireValues(raw) {
  if (!Array.isArray(raw)) return [...DEFAULT_WIRE_VALUES]
  const list = [...new Set(raw
    .filter((value) => typeof value === 'string')
    .map((value) => value.trim())
    .filter((value) => value.length > 0))]
  return list.length > 0 ? list : [...DEFAULT_WIRE_VALUES]
}

/**
 * 规整 `config.wireMap`（`{ 档位id: 出网值 }`）：只认六档里的键 + 非空字符串值。
 * 返回覆盖补丁；没给到的档位仍用 `TIERS[].wire`。
 */
export function normalizeWireMap(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const known = new Set(TIERS.map((tier) => tier.id))
  const patch = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!known.has(key)) continue
    if (typeof value !== 'string' || value.trim().length === 0) continue
    patch[key] = value.trim()
  }
  return patch
}

/** 合成最终的「档位 → 出网值」映射（出厂表 ← 覆盖补丁），返回新 Map。 */
export function wireMapFrom(patch) {
  const map = new Map(TIER_WIRE)
  for (const [key, value] of Object.entries(patch ?? {})) map.set(key, value)
  return map
}

/**
 * 从「档位 → 出网值」反推「出网值 → 档位」：每个出网值取**第一个**（最低的）档位。
 * 用来把内置适配器 advertise 的 `defaultEffort`（出网值）翻成六档里的名字——
 * 覆盖过映射后也必须跟着变，否则默认档会指到一张不存在的表上。
 */
export function wireToTierFrom(map) {
  const table = map instanceof Map ? map : wireMapFrom()
  const reverse = {}
  for (const tier of TIERS) {
    const wire = table.get(tier.id)
    if (typeof wire !== 'string' || wire.length === 0) continue
    if (reverse[wire] === undefined) reverse[wire] = tier.id
  }
  return reverse
}

// ---------------------------------------------------------------------------
// 自身身份（不把插件名写死在多处）
// ---------------------------------------------------------------------------

/** 路由前缀：`/plugins/<插件名>`（原来这个字面量写死在 index.js 里）。 */
export function routePrefixFor(pluginId) {
  return `/plugins/${pluginId}`
}

/** `mode: 'own'` 时的默认 provider 名 = 插件名（配置里给了 `provider` 就听配置的）。 */
export function ownProviderFor(pluginId) {
  return pluginId
}

/** 连接设置页的 settingsNs 兜底值 = 插件名（原来兜底写死 'llm-deepseek-account-tier'）。 */
export function settingsNsFor(pluginId, lineId) {
  return typeof lineId === 'string' && lineId.length > 0 ? lineId : pluginId
}
