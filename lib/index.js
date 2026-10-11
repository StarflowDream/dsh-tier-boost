/**
 * dsh-tier-boost — 宿主半边。
 *
 * 干两件事：
 * 1. 把 `deepseek-account` 的推理档位从硬编码的四档
 *    （off/low/high/max，见 `dsh-llm-deepseek/lib/index.js` 的 `modelInfo()`）
 *    扩成六档 low/medium/high/xhigh/max/ultra。右下角菜单只显示适配器 advertise 的档位，
 *    所以扩档 = 换适配器，没有别的路。
 * 2. 按当前档位往系统提示词里注入行为块：xhigh 及以下不注入；max 注入强化流程；
 *    ultra 再叠 Agent Team。
 * 3. 按 `effortOverrides` 配置做**逐模型档位覆写**：全局档位只有一个值，撞上"档位表里没有它"
 *    的模型会整轮失败；这张表按 provider/model 把档位换掉（规则与契约见 `lib/overrides.js`）。
 *
 * 线上值（发往 api.deepseek.com 的 `output_config.effort`）仍只有 off/low/high/max 四个合法值，
 * 所以六档在出网前降回来：low→off、medium→low、high→high、xhigh→max、max→max、ultra→max。
 * 这是用户 2026-10-07 定稿的「UI 层 GPT 风格改名」（DS 四档 off/low/high/max ↔ 菜单 low/medium/high/xHigh）。
 * 它不是 DS API 的兼容别名表：官方文档里 minimal→low、medium/xhigh→high 那套讲的是"把别名直接发给
 * DS API 会怎样"，与本插件这张 UI 映射表无关，**不要拿它来改这张表**（2026-10-08 我照官方表改过一版，被用户打回）。
 *
 * 两种运行模式（配置项，默认最保守的那个）：
 * - `takeover: false`（默认）：用一个**新** provider 名（`provider` 配置项，默认
 *   就是插件名本身）注册六档适配器。内置四档适配器原样留着 ⇒ 即使本插件加载失败，
 *   用户手上的模型也不受影响。用于先证明"档位能 advertise 出来"。
 * - `takeover: true`：用内置的 `deepseek-account` 名注册，并由本包的 `cordis.patch.yml`
 *   把内置行按 id 停用。菜单里只有一个条目，档位是六档。
 *
 * @module dsh-tier-boost
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { ACCOUNT_QUOTA_EXCEEDED_CODE, LlmError, QUOTA_EXCEEDED_CODE, ReasoningEffortId, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { DeepSeekAdapter, catalogModelInfo, plainOptions, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { applyEffortOverride, compileEffortOverrides, overrideMarkersOf } from './overrides.js'
// 策略层的唯一真相源（六档表 / 出网翻译 / 逐档委派策略 / 团队工具族 / 记忆轮默认标记）：
// 见 lib/policy.js 的模块注释。本文件只负责"把这些接到宿主上"，不再自带一套副本。
import {
  DELEGATION_TOOLS,
  FALLBACK_TIER,
  SPAWN_TOOL,
  SUBAGENT_TOOLS,
  TEAMMATE_HIDDEN_TOOLS,
  TEAM_COLLAB_TOOLS,
  TEAM_POLICY,
  TEAM_TOOLS,
  BLOCK_KEYS,
  TIER_BLOCK,
  TIERS,
  blockTextsFrom,
  normalizeBlockTexts,
  normalizeMemoryTurnMarkers,
  normalizeWireMap,
  normalizeWireValues,
  ownProviderFor,
  renderBlock,
  routePrefixFor,
  settingsNsFor,
  wireMapFrom,
  wireToTierFrom,
} from './policy.js'
import {
  applySelectionPin,
  decideSelectionGuard,
  eventsOf,
  firedMarkers,
  guardEnabled,
  isMemoryTaskTurn,
  selectionDiffers,
} from './selection-guard.js'

export const name = 'dsh-tier-boost'
export const inject = ['llm', 'systemPrompt', 'webServer']

// 六档表 / 出网翻译 / 逐档委派策略 / 团队工具族：全部来自 lib/policy.js（唯一真相源，
// `checks/tier-boost-policy.check.mjs` 会拦住"再抄一份回 index.js"）。
const EFFORTS = TIERS.map((tier) => ({
  id: ReasoningEffortId(tier.id),
  name: tier.name,
  description: tier.description,
}))
/** 连接关了思考时（thinking: disabled）线上只接受 off，菜单也只该给一档。 */
const OFF_ONLY_EFFORTS = [{
  id: ReasoningEffortId('low'),
  name: TIERS[0].name,
  description: '当前连接关闭了思考（thinking: disabled）',
}]

/**
 * 某一档、某种身份要从工具表里滤掉哪些名字（纯函数，units 测试直接断言）。
 * - Ultra 的 Lead：什么都不滤。
 * - 非 Ultra 的 Lead：滤掉整族团队工具（9 件），只留 subagent / subagent_fork。
 * - 队友（含普通子代理）：滤掉派单类——委派深度恒 1 层。
 */
function hiddenToolsFor(tier, teammate = false) {
  if (teammate === true) return [...TEAMMATE_HIDDEN_TOOLS]
  return TEAM_POLICY.get(tier)?.team === true ? [] : [...TEAM_TOOLS]
}



/**
 * 某一档要注入的行为块；不需要就返回空串（渲染器会丢掉空段，见 dsh-system-prompt 的 renderPrompt）。
 *
 * 正文**不在本文件**：出厂默认在 lib/policy.js 的 DEFAULT_BLOCK_TEXTS，用户可用
 * `config.blocks`（内联）或 `config.blockDir`（外部 .md）覆盖——想换语气/换语言不用改代码
 * （2026-10-11 用户：「想改档位/文案/行为块不用碰源码」）。
 *
 * @param tier 六档 id（未知档按 FALLBACK_TIER 的委派策略处理）
 * @param teammate 这个 agent 是不是"被 Lead 派出去的队友"（是的话给队友侧策略，不给 Lead 侧策略）
 * @param patch 正文覆盖补丁（来自 config，只含要换的那几块）
 */
function blockForTier(tier, teammate = false, patch = undefined) {
  const texts = blockTextsFrom(patch)
  const policy = TEAM_POLICY.get(tier) ?? TEAM_POLICY.get(FALLBACK_TIER)
  const mode = TIER_BLOCK.get(tier)
  const parts = []
  if (mode === 'methods' || mode === 'team') parts.push(texts.methods)
  if (teammate === true) parts.push(texts.teammate)
  else if (mode === 'team') parts.push(texts.team)
  else parts.push(renderBlock(texts.teamOff, { maxLive: policy.maxLive }))
  return parts.filter((part) => part.length > 0).join('\n\n')
}

/** 复用 CLI 的匿名用户 id（内置 registerDeepSeekProvider 用的是同一个文件，但那个函数没导出）。 */
function anonymousUserId() {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  const file = path.join(home, '.anonymous-user-id')
  try {
    const existing = fs.readFileSync(file, 'utf8').trim()
    if (existing.length > 0) return existing
  } catch {}
  const fresh = randomUUID()
  try {
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(file, `${fresh}\n`, 'utf8')
  } catch {}
  return fresh
}

/**
 * 档位 id → 出网合法值（默认表在 lib/policy.js，可由 `config.wireMap` 覆盖）；不认识的值原样放行。
 * 例外：连接关了思考（`thinking: disabled`）时线上只认 `off`，一律折成 `off`
 * （`dsh-llm-deepseek/lib/index.js:1700` 会直接抛 UNSUPPORTED_REASONING_EFFORT）——
 * 这里是 **off** 这个字面量唯一该出现的地方：它是宿主 advertise 的档位 id，不是我们的映射。
 * @param {object} options 出网调用参数
 * @param {Set<string>} [offOnlyModels] 采到的"关了思考"的模型 id（由 resolveModel 采集）
 * @param {Map<string,string>} [wireMap] 档位 → 出网值（默认出厂表）
 */
function mapReasoningEffort(options, offOnlyModels, wireMap = wireMapFrom()) {
  if (options === null || typeof options !== 'object') return options
  const current = typeof options.reasoningEffort === 'string' ? options.reasoningEffort : undefined
  if (current === undefined) return options
  const offOnly = offOnlyModels !== undefined && typeof options.model === 'string' && offOnlyModels.has(options.model)
  const next = offOnly ? 'off' : (wireMap.get(current) ?? current)
  return { ...options, reasoningEffort: ReasoningEffortId(next) }
}

/** 连接是否关了思考：宿主这时只 advertise 一档 off（`connection.defaults.thinking === 'disabled'`）。 */
function isOffOnlyInfo(info) {
  const raw = Array.isArray(info?.reasoning?.efforts) ? info.reasoning.efforts : []
  const ids = raw.map((effort) => (typeof effort === 'string' ? effort : effort?.id))
  return ids.length === 1 && ids[0] === 'off'
}

/** 把宿主硬编码的四档模型信息改写成六档；连接关了思考时仍只给一档（线上只收 off）。 */
function sixTierInfo(info, reverse = wireToTierFrom()) {
  const base = info?.reasoning
  if (base === undefined || base === null) return info
  const offOnly = isOffOnlyInfo(info)
  const efforts = offOnly ? OFF_ONLY_EFFORTS : EFFORTS
  const defaultTier = offOnly ? 'low' : (reverse[base.defaultEffort] ?? FALLBACK_TIER)
  return { ...info, reasoning: { efforts, defaultEffort: ReasoningEffortId(defaultTier) } }
}

/** 改写标记：挂在适配器实例上，插件重载（HMR / volatile-update）也不会重复包一层。 */
const DECLARED = Symbol.for('dsh-tier-boost.declared')

/** 取某个 provider 当前真正在用的适配器实例（`ctx.llm.adapters` 就是 listProviders() 读的那张表）。 */
function liveAdapterFor(ctx, provider) {
  const table = ctx.llm?.adapters
  if (table === undefined || table === null || typeof table.get !== 'function') return undefined
  const entry = table.get(provider)
  return entry?.adapter ?? entry
}

/**
 * 取 `ctx.llm.listProviders()` 里的 provider id 列表。
 * 注意：它返回的是 `{ id, displayName, … }` **对象数组**，不是字符串数组
 * （dsh-llm/lib/index.js:1900 `[...this.adapters.values()].map(({ provider }) => ({ ...provider }))`），
 * 所以 `list.includes('deepseek-account')` 永远 false —— 2026-10-08 踩过一次假警。
 */
function providerIds(ctx) {
  const list = ctx.llm?.listProviders?.() ?? []
  if (!Array.isArray(list)) return []
  return list.map((entry) => (typeof entry === 'string' ? entry : entry?.id)).filter((id) => typeof id === 'string' && id.length > 0)
}

/**
 * 在「声明层」改写一个**已经注册好**的适配器实例：让它 advertise 六档，并在出网前把六档翻回内置四档。
 *
 * 关键：不动任何注册关系（不停用内置行、不抢 provider 名），所以不会出现
 * 「内置行已停用、但本插件还没注册上」的启动窗口——那正是
 * `no adapter registered for provider "deepseek-account"`(NO_ADAPTER) 与
 * `does not support reasoning effort "xhigh"`(UNSUPPORTED_REASONING_EFFORT) 的来源。
 *
 * @param {object} adapter 已注册的适配器实例（含 resolveModel / prepareCall / stream）
 * @param {(tier: string|null, wire: string|null) => void} noteWire 出网档位观测
 * @param {object} [record] 观测记录（写进 state.json）
 */
function declareSixTiers(adapter, noteWire, record, wireMap = wireMapFrom(), reverse = wireToTierFrom(wireMap)) {
  if (adapter === null || typeof adapter !== 'object') return false
  if (adapter[DECLARED] === true) {
    if (record !== undefined) record.via = 'already-declared'
    return true
  }
  const resolveModel = adapter.resolveModel
  const prepareCall = adapter.prepareCall
  const stream = adapter.stream
  if (typeof resolveModel !== 'function' || typeof prepareCall !== 'function' || typeof stream !== 'function') {
    if (record !== undefined) record.via = 'shape-mismatch'
    return false
  }
  // 关了思考的模型（thinking: disabled）：resolveModel 时采集，出网时一律折成 off。
  const offOnlyModels = new Set()
  adapter.resolveModel = async function declaredResolveModel(provider, model, signal) {
    const info = await resolveModel.call(this, provider, model, signal)
    if (isOffOnlyInfo(info)) offOnlyModels.add(model)
    else offOnlyModels.delete(model)
    return sixTierInfo(info, reverse)
  }
  adapter.stream = function declaredStream(options) {
    const mapped = mapReasoningEffort(options, offOnlyModels, wireMap)
    noteWire(
      typeof options?.reasoningEffort === 'string' ? options.reasoningEffort : null,
      typeof mapped?.reasoningEffort === 'string' ? mapped.reasoningEffort : null,
    )
    return stream.call(this, mapped)
  }
  adapter.prepareCall = async function declaredPrepareCall(provider, model, signal) {
    const call = await prepareCall.call(this, provider, model, signal)
    if (call === null || typeof call !== 'object') return call
    // 真跑（会话派发）不看 resolveModel，看的是这里返回的 `model`：
    // dsh-llm/lib/index.js:2206 `normalizeModelInfo(registration, config.model, adapterCall.model)`
    // → :2182 用它校验档位；适配器侧 `{ model: modelInfo(...), stream }`
    // （dsh-llm-deepseek/lib/index.js:2100-2106）。只包 stream 不改 model ⇒
    // selftest（走 resolveModel）能过六档，真跑选 xHigh/medium/ultra 却被拒
    // ——2026-10-08 线上那次 UNSUPPORTED_REASONING_EFFORT 就是这么来的。
    if (call.model !== undefined) {
      if (isOffOnlyInfo(call.model)) offOnlyModels.add(model)
      else offOnlyModels.delete(model)
    }
    return {
      ...call,
      ...(call.model === undefined ? {} : { model: sixTierInfo(call.model, reverse) }),
      stream: (options) => adapter.stream.call(this, options),
    }
  }
  Object.defineProperty(adapter, DECLARED, { value: true, enumerable: false, configurable: true })
  if (record !== undefined) record.via = 'wrapped'
  return true
}

/** 六档适配器：只改 advertise 出来的档位、以及请求出网前的档位（own / takeover 两种上线方式用）。 */
class TieredDeepSeekAdapter extends DeepSeekAdapter {
  /** 关了思考（thinking: disabled）的模型 id：这些模型出网只认 off。 */
  #offOnlyModels = new Set()

  /** 档位 → 出网值（默认出厂表；apply() 里用 useWireMap() 注入配置版）。 */
  #wireMap = wireMapFrom()

  /** 反查表（出网值 → 六档 id）：把内置适配器 advertise 的 defaultEffort 翻成六档名。 */
  #reverse = wireToTierFrom()

  /**
   * 注入出网映射。构造后再调（而不是进构造函数参数）是为了不动基类的构造签名——
   * 多塞一个未知键给 DeepSeekAdapter 属于没必要的风险。
   */
  useWireMap(map) {
    this.#wireMap = map instanceof Map ? map : wireMapFrom()
    this.#reverse = wireToTierFrom(this.#wireMap)
    return this
  }

  /**
   * 覆写模型信息：把宿主硬编码的四档换成六档，并给出六档里的默认档。
   * @param {string} provider
   * @param {string} model
   * @param {AbortSignal} [signal]
   */
  async resolveModel(provider, model, signal) {
    const info = await super.resolveModel(provider, model, signal)
    if (isOffOnlyInfo(info)) this.#offOnlyModels.add(model)
    else this.#offOnlyModels.delete(model)
    return sixTierInfo(info, this.#reverse)
  }

  /** 真正发请求的那条路（`prepareCall().stream` 与直接 `stream()` 都要过一遍）。 */
  stream(options) {
    return super.stream(mapReasoningEffort(options, this.#offOnlyModels, this.#wireMap))
  }

  async prepareCall(provider, model, signal) {
    const call = await super.prepareCall(provider, model, signal)
    if (call === null || typeof call !== 'object') return call
    // 同 declaredPrepareCall：宿主拿这里的 `model` 校验档位，必须换成六档。
    if (call.model !== undefined) {
      if (isOffOnlyInfo(call.model)) this.#offOnlyModels.add(model)
      else this.#offOnlyModels.delete(model)
    }
    return {
      ...call,
      ...(call.model === undefined ? {} : { model: sixTierInfo(call.model, this.#reverse) }),
      stream: (options) => call.stream(mapReasoningEffort(options, this.#offOnlyModels, this.#wireMap)),
    }
  }
}

export function apply(ctx, config) {
  // 插件行可能不带 config（或传成 undefined）；plainOptions 直接 Object.entries(config)，
  // 不兜住会当场 TypeError。
  const settings = config ?? {}
  // 三种上线方式：
  //   declare（默认）——不碰任何注册关系，直接把内置 `deepseek-account` 适配器实例的声明层
  //     改写成六档（advertise 六档 + 出网翻译）。没有 DUPLICATE_ADAPTER，也没有
  //     「内置行已停用但本插件还没注册上」的启动窗口（NO_ADAPTER / xhigh 报错的来源）。
  //   takeover——用内置的 provider 名注册自己的适配器；需要 profile 同时停用内置行。
  //   own——用自己的新 provider 名另起一条路；内置行保持不动。
  /**
   * 本插件自己的身份一律从 `name`（插件名）派生：路由前缀、own 模式默认 provider 名、
   * settingsNs 兜底。原来这三个字面量各写死一处（用户 2026-10-11：「去掉自身的硬编码身份」）。
   */
  const pluginId = name
  const routeBase = routePrefixFor(pluginId)
  /** 路由匹配串：把前缀里的正则元字符转义后加可选尾斜杠。 */
  const routePattern = new RegExp('^' + routeBase.replace(/[.*+?^${}()|[\]\\]/g, '\\  const takeover = settings.takeover === true') + '/?')
  const takeover = settings.takeover === true
  // 显式写了 mode 就以 mode 为准；只写 takeover: true 的旧配置当 takeover 处理。
  const mode = settings.mode === 'declare' || settings.mode === 'takeover' || settings.mode === 'own'
    ? settings.mode
    : (takeover ? 'takeover' : 'declare')
  /** 宿主内置适配器的名字：这是**外部契约**，不是本插件的身份，所以留字面量。 */
  const builtinProvider = 'deepseek-account'
  const provider = typeof settings.provider === 'string' && settings.provider.trim().length > 0
    ? settings.provider.trim()
    : (mode === 'own' ? ownProviderFor(pluginId) : builtinProvider)
  const displayName = typeof settings.displayName === 'string' && settings.displayName.trim().length > 0
    ? settings.displayName.trim()
    : (mode === 'own' ? pluginId + '（六档）' : 'DeepSeek Account')
  const settingsNs = settingsNsFor(pluginId, ctx.fiber?.entry?.options?.id)

  /**
   * 额外 provider：同一套六档也作用在这些路线上（**默认空表**，要哪条路线自己在 config 里列）。
   * 例：`extraProviders: ['scnet']` 让 pi-ai 的「SCNet 超算互联网」也吃同一套六档——
   * 出网那四个值（off/low/high/max）SCNet 端点照单全收（实测各值均 200，其中 off 仍会思考一点、
   * none 才完全关掉；要改 SCNet 专属出网值就改这里的 maps）。本机 profile 里就是这么配的。
   * 仍然只改写**声明层**，不动注册关系；一条插件实例管多条路线，提示词块与工具表策略只注册一次
   * （另开一条插件行会把行为块注入两遍）。
   */
  const extraProviders = (Array.isArray(settings.extraProviders) ? settings.extraProviders : [])
    .filter((id) => typeof id === 'string' && id.length > 0 && id !== provider)
  /** 这些 provider 的 session/selection 都算"本插件管的档位"（工具表与行为块按它取档）。 */
  const tierProviders = new Set([provider, ...extraProviders])
  /** 每个额外 provider 的改写记录（写进 state.json，用来证明哪条路线真的被包上了）。 */
  const declarations = new Map()

  /**
   * 出网值白名单 + 「档位 → 出网值」映射。
   * 默认是内置 deepseek 线路的四值（off/low/high/max）；接别家端点时用 `wireMap` 换映射、
   * `wireValues` 换白名单——原来这两件事都只能改源码（用户 2026-10-11：「真接别家端点时不该改源码」）。
   */
  const wireValues = normalizeWireValues(settings.wireValues)
  const wireMapPatch = normalizeWireMap(settings.wireMap)
  const wireMap = wireMapFrom(wireMapPatch)
  const wireReverse = wireToTierFrom(wireMap)
  /** 档位映射落在白名单外的档位（配置写错时的自证；只 warn，不拦加载）。 */
  const wireOutOfRange = TIERS.filter((tier) => !wireValues.includes(wireMap.get(tier.id))).map((tier) => tier.id)
  if (wireOutOfRange.length > 0) {
    ctx.logger?.warn?.(`[dsh-tier-boost] 这些档位的出网值不在 wireValues 白名单里：${wireOutOfRange.join(', ')}`)
  }

  /**
   * 行为提示词正文：出厂默认在 lib/policy.js，`blocks` 内联覆盖、`blockDir` 用外部 .md 覆盖
   * （内联优先于目录；目录里缺哪个键就那一块留默认）。读文件失败只跳过，绝不影响插件加载。
   */
  const blockSources = []
  let blockPatch = normalizeBlockTexts(settings.blocks)
  if (Object.keys(blockPatch).length > 0) blockSources.push('config')
  const blockDir = typeof settings.blockDir === 'string' && settings.blockDir.trim().length > 0
    ? settings.blockDir.trim()
    : null
  if (blockDir !== null) {
    const fromDir = {}
    for (const key of BLOCK_KEYS) {
      if (blockPatch[key] !== undefined) continue
      try {
        const text = fs.readFileSync(path.join(blockDir, `${key}.md`), 'utf8')
        if (text.trim().length > 0) fromDir[key] = text
      } catch {}
    }
    if (Object.keys(fromDir).length > 0) {
      blockPatch = { ...fromDir, ...blockPatch }
      blockSources.push('dir')
    }
  }
  const blockTexts = blockTextsFrom(blockPatch)
  /**
   * 逐模型档位覆盖表（规则与契约见 `lib/overrides.js` 的模块注释）。
   * 空表 = 本功能完全不介入：连 `agent/request` 瀑布都不挂，不给请求路径加一丝开销。
   */
  const effortOverrides = compileEffortOverrides(settings.effortOverrides)
  /**
   * 覆盖表里 `when: { markers: [...] }` 用到的标记：与内置 memoryTurnMarkers 一起扫这一轮的
   * user/message，判定口径完全一样（见 lib/overrides.js 的 when 说明）。
   */
  const overrideMarkers = overrideMarkersOf(effortOverrides)
  /**
   * 记忆任务轮（meow-memory 的反思/梦境轮）认哪几个标记：默认在 lib/policy.js，
   * 可由 `config.memoryTurnMarkers` 覆盖（**替换**不是并集）。state.json 的 `memoryTurn`
   * 段会自证当前实际在用哪几个——meow-memory 换了文案就改这里，不用改代码。
   */
  const memoryTurnMarkersFromConfig = Array.isArray(settings.memoryTurnMarkers)
    && settings.memoryTurnMarkers.some((marker) => typeof marker === 'string' && marker.trim().length > 0)
  const memoryTurnMarkers = normalizeMemoryTurnMarkers(settings.memoryTurnMarkers)
  /** 最近命中的改写（最多 40 条），进 state.json 供事后自证"到底改没改、从哪档改到哪档"。 */
  const overrideHits = []
  const noteOverride = (entry) => {
    overrideHits.unshift(entry)
    if (overrideHits.length > 40) overrideHits.length = 40
  }
  /** 每个 agent 的覆盖瀑布装配状态（按 agent.id 去重）。 */
  const effortOverrideRows = new Map()

  /**
   * 会话模型选择的「防劫持锚」（规则与契约见 `lib/selection-guard.js` 的模块注释）。
   * 默认开；`selectionGuard: false` 或 `{enabled: false}` 关掉（关掉时连瀑布都不挂）。
   */
  const selectionGuardEnabled = guardEnabled(settings)
  /** 每个 agent 的选择守卫装配状态（按 agent.id 去重）。 */
  const selectionGuardRows = new Map()

  /**
   * 决策流水（JSONL，落在 `$DSH_HOME/tier-boost-decisions.jsonl`）。
   *
   * 为什么不能只靠 `/state.json`：改 profile 补丁会触发 patchReload live，旧实例被 dispose 后
   * 它注册的 webServer 路由仍被命中，于是 `state.json` 返回 HTTP 500
   * `cannot get required service "llm" in inactive context` —— 而"改配置 → 重启 → 自证"
   * 这个循环里恰恰最需要自证。落盘一份就不受路由状态影响，重启后还能回查。
   */
  const decisionLogPath = path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'tier-boost-decisions.jsonl')
  const noteDecision = (entry) => {
    try {
      fs.appendFileSync(decisionLogPath, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, 'utf8')
    } catch {}
  }

  const options = () => resolveAdapterOptions(plainOptions(settings), launchEnvironmentOf(ctx))
  // 起来就解析一次：配置写错（比如非法档位）要当场炸，而不是等到第一次请求。
  // declare 模式走的是**内置行**的连接设置（本插件行可能没有 config），所以跳过这次自检。
  if (mode !== 'declare') options()

  const resolveAuth = async (connection) => {
    const account = ctx.get('deepseekAccount')
    const token = await account?.resolveToken(connection.baseURL)
    if (token === undefined) {
      throw new LlmError('Sign in to DeepSeek to use the account provider. The request destination must allow account authentication.', 'ACCOUNT_SIGN_IN_REQUIRED')
    }
    return {
      headers: { 'x-dsh-auth-token': token },
      onRequestError: async (error) => {
        if (!(error instanceof LlmError)) return error
        if (error.code === QUOTA_EXCEEDED_CODE) {
          return new LlmError(error.message, ACCOUNT_QUOTA_EXCEEDED_CODE, { ...error.failure, cause: error })
        }
        if (error.failure?.status !== 401) return error
        const rejected = new LlmError(error.message, 'ACCOUNT_TOKEN_INVALID', { ...error.failure, cause: error })
        try {
          await account?.rejectToken(token)
        } catch {}
        return rejected
      },
    }
  }

  // ---- 连接设置页的 provider 目录 ----------------------------------------
  // 只有本插件**自己拥有**这个 provider 时才登记；declare 模式下 provider 就是内置的
  // `deepseek-account`，官方插件早就登记过它了，再登记一次会抛
  // DUPLICATE_DIRECTORY（dsh-llm/lib/index.js:1926 `configurable provider "…" is already declared`），
  // 而这个异常会把整个 apply() 掀掉 —— 表现就是插件静默不加载、路由全 404。2026-10-08 实测踩过。
  // 另外整段包 try/catch：目录登记只是设置页的锦上添花，永远不该决定插件死活。
  const directory = { registered: false, skipped: false, error: null }
  if (mode === 'declare') {
    directory.skipped = true
  } else {
    try {
      ctx.llm.registerConfigurableProviders([{
        provider,
        displayName,
        settingsNs,
        settingsPath: [],
      }])
      directory.registered = true
    } catch (error) {
      directory.error = `${error?.code ?? 'ERROR'} ${error?.message ?? error}`.trim()
      ctx.logger?.warn?.(`[dsh-tier-boost] 目录登记失败（不影响档位改写）：${directory.error}`)
    }
  }

  // ---- 档位状态 ---------------------------------------------------------
  let selection = null
  let currentTier = null
  let currentAt = null
  const sessionTiers = new Map()
  /** 出网时真正用到的档位（由适配器记录）——用来证明映射生效。 */
  const wireObserved = { tier: null, wire: null, at: null, count: 0 }

  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'model/selection') return
    const data = event.data
    if (data === null || typeof data !== 'object') return
    if (tierProviders.has(data.provider) !== true) return
    if (typeof data.reasoningEffort !== 'string') return
    currentTier = data.reasoningEffort
    currentAt = new Date().toISOString()
    selection = data
    if (typeof session?.id === 'string') sessionTiers.set(session.id, currentTier)
  })

  const noteWire = (tier, wire) => {
    wireObserved.tier = tier ?? null
    wireObserved.wire = wire ?? null
    wireObserved.at = new Date().toISOString()
    wireObserved.count += 1
  }

  /**
   * 某个 agent 这一轮"真正生效"的档位。
   *
   * 系统提示词是在 `agent/pre-step` 里组装的，组装时 section 的 text 函数会收到
   * `{ agent, scope, signal }`（dsh-agent 的 assembleContextFor，见 system-prompt/lib/index.js:342
   * 的 `section.text(context)`）——所以能在这里现读 agent 自己的 model/selection 事件。
   * 好处：重启后第一轮、以及刚在右下角改完档位的当轮就生效，不必等下一个事件。
   */
  const tierOfAgent = (agent) => {
    try {
      const events = agent?.session?.snapshotEvents?.()
      if (Array.isArray(events)) {
        const last = events.findLast?.((event) => event?.type === 'model/selection')
        const data = last?.data
        if (data !== null && typeof data === 'object' && typeof data.reasoningEffort === 'string') {
          if (data.provider === undefined || tierProviders.has(data.provider)) return data.reasoningEffort
        }
      }
    } catch {}
    return null
  }

  // ---- 委派策略：按档开/关团队协作（只有 Ultra 开，其余档只留"派单发子代理"通道）----

  const teamPolicyFor = (tier) => TEAM_POLICY.get(tier) ?? TEAM_POLICY.get(FALLBACK_TIER)

  /** 这个 agent 是不是"被 Lead 派出去的队友"——平台用 session.header.parentSession 标记子会话。 */
  const isTeammate = (agent) => {
    try {
      return agent?.session?.header?.parentSession !== undefined
    } catch {
      return false
    }
  }

  /** 这个 agent 名下正在跑的直接子代理数；拿不到就按 0 算（宁可放过，不可误杀）。 */
  const liveChildren = (agent) => {
    try {
      const members = ctx.get('agentTeams')?.listMembers?.(agent)
      if (Array.isArray(members)) {
        return members.filter((member) => member?.role === 'teammate' && member?.status === 'running').length
      }
    } catch {}
    try {
      const list = ctx.get('agents')?.list?.() ?? []
      return list.filter((child) => child?.status === 'running' && child?.session?.header?.parentSession === agent?.id).length
    } catch {}
    return 0
  }

  const gate = { checks: 0, denied: 0, recent: [] }

  const noteDenial = (tier, reason) => {
    gate.denied += 1
    gate.recent.unshift({ at: new Date().toISOString(), tier, reason })
    if (gate.recent.length > 5) gate.recent.length = 5
  }

  /**
   * 委派硬闸（兜底）：工具表已经在 system-prompt/assemble 里按档滤过一遍，这里再拦一次，
   * 防止"滤网漏了 / 工具改名了"时被绕过。
   * tools.guard 必须同步返回（返回字符串＝拒绝本次调用），所以这里不 await。
   */
  const delegationGate = (exec) => {
    const name = exec?.name
    if (typeof name !== 'string' || DELEGATION_TOOLS.has(name) !== true) return undefined
    const agent = exec.agent
    if (agent === undefined || agent === null) return undefined
    const tier = tierOfAgent(agent) ?? currentTier
    gate.checks += 1
    if (isTeammate(agent)) {
      noteDenial(tier, `被派出去的一方不能再往下派（${name}）`)
      return `tier-boost: 你已经被派出去了，不能再派新的（${name} 不可用）——自己把活干完，按格式回报。`
    }
    if (TEAM_TOOLS.includes(name)) {
      noteDenial(tier, `本档关闭团队（${name}）`)
      return `tier-boost: ${tier} 档关闭了智能体团队（${name} 不可用）——要并行就用 subagent 单发子代理（最多 ${teamPolicyFor(tier).maxLive} 个在跑）。`
    }
    const policy = teamPolicyFor(tier)
    const live = liveChildren(agent)
    if (live >= policy.maxLive) {
      noteDenial(tier, `在跑子代理 ${live} ≥ ${policy.maxLive}`)
      return `tier-boost: ${tier} 档最多同时 ${policy.maxLive} 个子代理在跑（现在 ${live} 个）——先等它们回报，别再派新的。`
    }
    return undefined
  }

  try {
    ctx.inject(['tools'], (child) => {
      child.effect(() => child.tools.guard(delegationGate))
    })
  } catch (error) {
    ctx.logger?.warn?.(`tier-boost: 委派硬闸没挂上（${String(error?.message ?? error)}）`)
  }

  /**
   * 按档裁工具表：在每个 agent 自己的 ctx 上挂一条 `system-prompt/assemble` 瀑布，
   * 把不该出现的名字从 `assembly.tools` 里滤掉。
   *
   * 为什么不用 tools.restrict：`restrict` 只过滤 **global 工具**，而团队工具是
   * agent-team 插件用 `agent.ctx.tools.register()` 注册在**每个 agent 自己的层**上的
   * （scope-local），restrict 会对这些名字整次抛
   * `names unknown global tools`，于是一点都没藏掉（2026-10-08 线上实测踩到）。
   * 而 `assembly.tools` 正是进请求的那份工具表（dsh-agent-loop: assemble → buildRequest(...,
   * assembly.tools, ...)），在这一层滤才是真删。
   *
   * 每条瀑布在装配那一刻现读档位与身份，所以切档不需要重装；只有 agent 消失时才 dispose。
   */
  const policyRows = new Map()

  const installAgentPolicy = (agent) => {
    if (agent === undefined || agent === null || agent.id === undefined || agent.id === null) return null
    const id = agent.id
    const teammate = isTeammate(agent)
    const row = policyRows.get(id) ?? { session: id, tier: null, teammate, hidden: [], dropped: 0, at: null, error: null, installed: false }
    row.teammate = teammate
    policyRows.set(id, row)
    if (row.installed === true) return row
    if (typeof agent.ctx?.on !== 'function') {
      row.error = '这个 agent 上没有可挂的 ctx（agent.ctx.on 不可用）'
      return row
    }
    try {
      row.dispose = agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
        const assembled = await next()
        const agentTier = tierOfAgent(agent) ?? currentTier
        const teammateNow = isTeammate(agent)
        const hidden = hiddenToolsFor(agentTier, teammateNow)
        row.tier = agentTier
        row.teammate = teammateNow
        row.hidden = hidden
        row.at = new Date().toISOString()
        row.error = null
        if (hidden.length === 0 || Array.isArray(assembled?.tools) !== true) {
          row.dropped = 0
          return assembled
        }
        const names = new Set(hidden)
        const tools = assembled.tools.filter((tool) => names.has(tool?.name) !== true)
        row.dropped = assembled.tools.length - tools.length
        return { ...assembled, tools }
      })
      row.installed = true
    } catch (error) {
      row.error = String(error?.message ?? error)
    }
    return row
  }

  /**
   * 逐模型档位覆盖：在 agent 自己的 ctx 上挂一条 `agent/request` 瀑布，命中覆盖表就把
   * `reasoningEffort` 换成表里的值（其余字段一个不动）。用来修"全局档位撞上模型档位表里没这档"
   * 的整轮失败——现场是 meow-memory 的反思/梦境轮换成 `qodercn/qfmodel`
   * （档位表 ["xhigh","low","medium"]）却继承全局 `high`，宿主直接抛 UNSUPPORTED_REASONING_EFFORT。
   *
   * **为什么必须 `prepend: true`**：宿主的 `installModelSelection`（dsh-agent 的
   * model-selection.js）也是普通注册的 `agent/request`，它在 `next()` 之后用**全局** selection
   * 覆盖 provider/model/reasoningEffort（且"全局档位为空时会清掉继承来的档位"）。waterfall 的
   * 实现是 `(listeners.shift() ?? terminal)()`，prepend 把本插件排到数组最前 = 最外层，
   * 于是本插件在它之后落地、覆盖才算数；不 prepend 会被它原样盖回去 = **功能静默失效**。
   *
   * 空表时整条不挂，谁都没被改变。
   */
  const installEffortOverride = (agent) => {
    if (effortOverrides.length === 0) return null
    if (agent === undefined || agent === null || agent.id === undefined || agent.id === null) return null
    if (typeof agent.ctx?.on !== 'function') return null
    const id = agent.id
    const row = effortOverrideRows.get(id) ?? { session: id, hits: 0, last: null, installed: false, error: null }
    effortOverrideRows.set(id, row)
    if (row.installed === true) return row
    try {
      row.dispose = agent.ctx.on('agent/request', async (_payload, next) => {
        const resolved = await next()
        // 这一轮是不是记忆任务轮（meow-memory 的反思/梦境）：只有它能命中 `when: 'memory-turn'`
        // 的规则——用户嫌反思轮 xhigh 太慢，所以低档只钉记忆整理，不打扰手动选的档位。
        const events = eventsOf(agent.session)
        const memoryTurn = isMemoryTaskTurn(events, memoryTurnMarkers)
        const fired = firedMarkers(events, [...new Set([...memoryTurnMarkers, ...overrideMarkers])])
        // 兜底：覆盖表是用户可改的配置，写错一个档位名（或宿主换了档位枚举）
        // 绝不能让**每一个请求**都炸掉。出错就原样放行，并把错误记进 state 自证。
        let applied
        try {
          applied = applyEffortOverride(resolved, effortOverrides, { memoryTurn, markers: fired })
        } catch (error) {
          row.error = String(error?.message ?? error)
          return resolved
        }
        // 只在真的改了的时候记录：返回原引用 = 这次没命中、也没被动过。
        if (applied === resolved) return resolved
        // 档位 id 走宿主自己的类型包装，避免把裸字符串塞进后续校验；这一步同样兜底——
        // 配置里写了个宿主不认的档位名，只能让这一次「不改」，不能让所有请求陪着炸。
        let effort
        try {
          effort = ReasoningEffortId(applied.reasoningEffort)
        } catch (error) {
          row.error = `档位 "${applied.reasoningEffort}" 不被宿主接受：${error?.message ?? error}`
          return resolved
        }
        row.error = null
        row.hits += 1
        row.last = {
          at: new Date().toISOString(),
          provider: applied.provider ?? null,
          model: applied.model ?? null,
          from: resolved.reasoningEffort ?? null,
          to: applied.reasoningEffort,
          memoryTurn,
        }
        noteOverride({ ...row.last, session: id })
        noteDecision({ kind: 'effort-override', session: id, ...row.last })
        return { ...applied, reasoningEffort: effort }
      }, { prepend: true })
      row.installed = true
    } catch (error) {
      row.error = String(error?.message ?? error)
    }
    return row
  }

  /**
   * 会话模型选择的「防劫持锚」（契约与背景见 `lib/selection-guard.js` 的模块注释）。
   *
   * 治的是这个现象：meow-memory 的反思/梦境轮只在**单次请求**上把路由换成 delegate.model
   * （qodercn/qfmodel），宿主的 modelSelection 投影却把"最后一次请求的真实路由"当成会话
   * 当前模型 —— 右下角一直显示 qfmodel；更糟的是 `selection.current` 在没有新选择时会回退到
   * 那个被污染的路由，于是记忆轮之后的**普通轮次也继续跑 qfmodel**。
   *
   * 本钩子把「会话自己提交过的选择意图」（日志里最后一条 `model/selection`，唯一提交者是
   * 客户端 remote selectModel）钉回去，两种情形分开处理：
   *   · 记忆轮：路由是**故意**换的 → 原样放行（绝不能钉回去，否则等于静默废掉 qfmodel 跑反思），
   *     只补一条 `model/selection` = 意图，让宿主的 pending 不被 lastUsed 带偏（修显示层）；
   *   · 非记忆轮：路由 ≠ 意图 ⇒ 上一次覆盖漏下来了 → 这次请求直接钉回意图（修功能层）。
   * 拿不到意图（老会话、子代理会话）或没装上都原样放行，不介入。
   */
  const installSelectionGuard = (agent) => {
    if (!selectionGuardEnabled) return null
    if (agent === undefined || agent === null || agent.id === undefined || agent.id === null) return null
    if (typeof agent.ctx?.on !== 'function') return null
    // 子代理会话没有"客户端提交的选择"这回事，钉了只会添乱。
    if (agent.session?.header?.origin === 'subagent') return null
    const id = agent.id
    const row = selectionGuardRows.get(id) ?? {
      session: id,
      memoryTurns: 0,
      pins: 0,
      forces: 0,
      last: null,
      via: null,
      installed: false,
      error: null,
    }
    selectionGuardRows.set(id, row)
    if (row.installed === true) return row
    try {
      row.dispose = agent.ctx.on('agent/request', async (_payload, next) => {
        const resolved = await next()
        // 读事件、判断这轮的性质：全部兜底，任何一步出错都原样放行（不能让插件配置/宿主
        // 内部变化把每一个请求都炸掉——与 effortOverrides 同一契约）。
        let decision
        try {
          decision = decideSelectionGuard(resolved, eventsOf(agent.session), memoryTurnMarkers)
        } catch (error) {
          row.error = String(error?.message ?? error)
          return resolved
        }
        if (decision.action === 'skip' || decision.action === 'keep') {
          // skip 只在本轮确实是记忆轮时才记（那时它意味着"读不到选择意图"，是真问题）；
          // 每个普通请求都写一行会把流水淹掉。
          if (decision.action === 'skip' && isMemoryTaskTurn(eventsOf(agent.session), memoryTurnMarkers)) {
            noteDecision({ kind: 'selection-guard', session: id, action: 'skip', reason: 'no committed selection event in session' })
          }
          return resolved
        }
        const intent = decision.intent
        if (decision.action === 'pass') {
          row.memoryTurns += 1
          // 优先走宿主的正式通道（它会把 selection.current 也一起修正）；
          // 拿不到那个服务就退回直接补事件——只修显示层，功能层交给"非记忆轮钉回"兜住。
          const note = (via) => {
            row.via = via
            row.pins += 1
            row.last = {
              at: new Date().toISOString(),
              kind: 'pin',
              via,
              intent: { ...intent },
              route: { provider: resolved.provider ?? null, model: resolved.model ?? null, effort: resolved.reasoningEffort ?? null },
            }
            noteDecision({ kind: 'selection-guard', session: id, action: 'pass', ...row.last })
          }
          const viaService = ctx.get('sessionController')?.agents
          if (typeof viaService?.selectForNextRequest === 'function') {
            try {
              viaService.selectForNextRequest(agent, intent)
              note('sessionController.selectForNextRequest')
              return resolved
            } catch (error) {
              row.error = `selectForNextRequest 失败，退回补事件：${error?.message ?? error}`
            }
          }
          try {
            agent.session?.append?.('model/selection', intent)
            note('session.append')
          } catch (error) {
            row.error = String(error?.message ?? error)
          }
          return resolved
        }
        // 非记忆轮：路由该等于意图。不一样说明上一次的请求级覆盖漏了下来，钉回去。
        if (!selectionDiffers(resolved, intent)) return resolved
        let pinned
        try {
          pinned = applySelectionPin(resolved, intent)
        } catch (error) {
          row.error = String(error?.message ?? error)
          return resolved
        }
        if (pinned === resolved) return resolved
        // 档位走宿主自己的类型包装（与 overrides 同一手法）；包不上就这次不改。
        if (intent.reasoningEffort !== undefined) {
          try {
            pinned.reasoningEffort = ReasoningEffortId(pinned.reasoningEffort)
          } catch (error) {
            row.error = `档位 "${pinned.reasoningEffort}" 不被宿主接受：${error?.message ?? error}`
            return resolved
          }
        }
        row.error = null
        row.forces += 1
        row.last = {
          at: new Date().toISOString(),
          kind: 'force',
          intent: { ...intent },
          from: { provider: resolved.provider ?? null, model: resolved.model ?? null, effort: resolved.reasoningEffort ?? null },
        }
        noteDecision({ kind: 'selection-guard', session: id, action: 'force', ...row.last })
        return pinned
      }, { prepend: true })
      row.installed = true
    } catch (error) {
      row.error = String(error?.message ?? error)
    }
    return row
  }

  try {
    ctx.on('agent/created', ({ agent: created }) => {
      installAgentPolicy(created)
      installEffortOverride(created)
      installSelectionGuard(created)
    })
    for (const candidate of ctx.get('agents')?.list?.() ?? []) {
      installAgentPolicy(candidate)
      installEffortOverride(candidate)
      installSelectionGuard(candidate)
    }
  } catch (error) {
    ctx.logger?.warn?.(`tier-boost: 按 agent 装工具表没装上（${String(error?.message ?? error)}）`)
  }

  ctx.on('agent/disposed', ({ agent: disposed }) => {
    const id = disposed?.id
    if (id === undefined || id === null) return
    const row = policyRows.get(id)
    if (row !== undefined) {
      try { row.dispose?.() } catch {}
      policyRows.delete(id)
    }
    const overrideRow = effortOverrideRows.get(id)
    if (overrideRow !== undefined) {
      // 留着这一行反而有害：agent 已经没了，再挂瀑布只会在下次重建时留下一个死闭包。
      try { overrideRow.dispose?.() } catch {}
      effortOverrideRows.delete(id)
    }
    const guardRow = selectionGuardRows.get(id)
    if (guardRow !== undefined) {
      try { guardRow.dispose?.() } catch {}
      selectionGuardRows.delete(id)
    }
  })

  /** 渲染记录：证明行为块真的进了某一轮的提示词（text 函数被调用＝那一轮在组装）。 */
  // chars = JS 字符串长度（UTF-16 码元），不是 UTF-8 字节数——2026-10-08 之前叫 bytes，容易误读。
  const rendered = { count: 0, tier: null, chars: 0, at: null }

  ctx.systemPrompt.section({
    name: 'tier-boost:methods',
    order: 60,
    text: (context) => {
      const agent = context?.agent
      const tier = tierOfAgent(agent) ?? currentTier
      const teammate = isTeammate(agent)
      installAgentPolicy(agent)
      const block = blockForTier(tier, teammate, blockPatch)
      rendered.count += 1
      rendered.tier = tier ?? null
      rendered.teammate = teammate
      rendered.chars = block.length
      rendered.at = new Date().toISOString()
      return block
    },
  })

  // ---- 注册适配器 -------------------------------------------------------
  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })

  let userId
  let adapter = new TieredDeepSeekAdapter({
    options,
    resolveAuth,
    providerName: displayName,
    discoverModels: async (discoverProvider) => {
      const connection = options()
      try {
        await resolveAuth(connection)
      } catch (error) {
        if (error instanceof LlmError && error.code === 'ACCOUNT_SIGN_IN_REQUIRED') return []
        throw error
      }
      return connection.models.map((model) => catalogModelInfo(discoverProvider, model))
    },
    resolveUserId: () => (userId ??= anonymousUserId()),
    onReplayDegrade: ({ provider: p, model, reason }) => {
      ctx.logger?.warn?.(`tier-boost: dropped Messages replay state for ${p}/${model}: ${reason}`)
    },
    onExtensionsOmitted: ({ provider: p, model, fields, error }) => {
      ctx.logger?.warn?.(`tier-boost: omitted request extensions for ${p}/${model} (${fields.join(', ')}): ${error}`)
    },
    resolveAttachments: () => ctx.get('attachments'),
    // 内置 registerDeepSeekProvider 内部那份实现没导出，但它用到的 resolveImageAttachmentAccess 是导出的：
    // 照抄一遍，接管内置行之后图片附件才不会变成"不支持"。
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(attachments, (hostPath) => ctx.get('fs')?.processPathFromHostPath(hostPath), ref),
    prepareExtensions: (request) => ctx.get('deepseekLlmApiExtensions')?.prepare(request) ?? Promise.resolve({ fields: {}, accept: () => Promise.resolve() }),
  })
  // 出网映射注入（构造后再调，见 useWireMap 的注释）。
  adapter.useWireMap(wireMap)

  const declaration = { mode, patched: false, via: null, attempts: 0, target: null, at: null }
  let registered = false

  if (mode === 'declare') {
    // 内置行的适配器正常已经注册好（本 bundle 排在最后）。万一还没有，等事件 + 短轮询兜底，
    // 期间内置行仍然照常工作——这就是这个模式不会出现 NO_ADAPTER 窗口的原因。
    const adopt = () => {
      declaration.attempts += 1
      let done = true
      if (declaration.patched !== true) {
        const live = liveAdapterFor(ctx, provider)
        if (live === undefined || live === null) done = false
        else if (declareSixTiers(live, noteWire, declaration, wireMap, wireReverse) !== true) done = false
        else {
          adapter = live
          declaration.patched = true
          declaration.target = typeof live.constructor?.name === 'string' ? live.constructor.name : 'object'
          declaration.at = new Date().toISOString()
        }
      }
      for (const id of extraProviders) {
        const row = declarations.get(id) ?? { provider: id, patched: false, via: null, target: null, at: null }
        declarations.set(id, row)
        if (row.patched === true) continue
        const live = liveAdapterFor(ctx, id)
        if (live === undefined || live === null) { done = false; continue }
        if (declareSixTiers(live, noteWire, row, wireMap, wireReverse) !== true) { done = false; continue }
        row.patched = true
        row.target = typeof live.constructor?.name === 'string' ? live.constructor.name : 'object'
        row.at = new Date().toISOString()
      }
      return done
    }
    adopt()
    if (!declaration.patched) {
      ctx.on('llm/adapters-updated', () => { adopt() })
      const timer = setInterval(() => { if (adopt()) clearInterval(timer) }, 400)
      timer.unref?.()
    }
  } else {
    const streamed = adapter.stream.bind(adapter)
    adapter.stream = (opts) => {
      const tier = typeof opts?.reasoningEffort === 'string' ? opts.reasoningEffort : null
      noteWire(tier, tier === null ? null : (wireMap.get(tier) ?? tier))
      return streamed(opts)
    }

    const registration = ctx.llm.registerAdapter([provider], adapter)
    registered = true
    let registeredPolicy = options().retryPolicy
    ctx.on('loader/volatile-update', () => {
      try {
        const policy = options().retryPolicy
        if (JSON.stringify(policy) === JSON.stringify(registeredPolicy)) return
        registeredPolicy = policy
        registration.replace([provider])
      } catch (error) {
        ctx.logger?.warn?.(`tier-boost: retry policy refresh failed: ${error}`)
      }
    })
  }

  ctx.logger?.info?.(
    `tier-boost: loaded, mode=${mode}, provider=${provider}, registered=${registered}, declared=${declaration.patched}${declaration.patched ? `(${String(declaration.via)})` : ''}, extras=[${extraProviders.map((id) => `${id}:${declarations.get(id)?.patched === true}`).join(' ')}], tiers=${TIERS.map((tier) => tier.id).join('/')}`,
  )

  // ---- 观测路由 ---------------------------------------------------------
  /**
   * declare 模式下本插件行没有连接设置，`options()` 拿不到模型表，所以另开一条路：
   * 向宿主要该 provider 的模型目录（dsh-llm/lib/index.js:2073 listModels → adapter.listModels）。
   * 异步取、缓存住，供同步的 modelIds() 用。
   */
  let knownModels = []
  const refreshModels = async () => {
    try {
      const models = await ctx.llm.listModels?.(provider)
      const ids = (models ?? [])
        .map((model) => (typeof model === 'string' ? model : (model?.id ?? '')))
        .filter((id) => typeof id === 'string' && id.length > 0)
      if (ids.length > 0) knownModels = ids
    } catch (error) {
      ctx.logger?.warn?.(`tier-boost: listModels(${provider}) failed: ${error}`)
    }
  }
  void refreshModels()
  ctx.on('llm/adapters-updated', () => { void refreshModels() })

  /** 路由用的模型列表：本插件行的连接设置优先，其次宿主目录，最后退回 agent 选择事件里的模型。 */
  const modelIds = () => {
    try {
      const models = options().models
      const ids = models
        .map((model) => (typeof model === 'string' ? model : (model?.id ?? String(model))))
        .filter((id) => typeof id === 'string' && id.length > 0)
      if (ids.length > 0) return ids
    } catch (error) {
      ctx.logger?.warn?.(`tier-boost: connection settings unavailable (${mode}): ${error}`)
    }
    if (knownModels.length > 0) return knownModels
    const fallback = selection?.model
    return typeof fallback === 'string' && fallback.length > 0 ? [fallback] : []
  }

  const state = async () => {
    const models = []
    for (const modelId of modelIds()) {
      try {
        const info = await adapter.resolveModel(provider, modelId)
        models.push({
          model: modelId,
          defaultEffort: String(info?.reasoning?.defaultEffort ?? ''),
          efforts: (info?.reasoning?.efforts ?? []).map((effort) => ({
            id: String(effort?.id ?? effort),
            name: effort?.name,
            description: effort?.description,
          })),
        })
      } catch (error) {
        models.push({ model: modelId, error: String(error?.message ?? error) })
      }
    }
    return {
      plugin: name,
      provider,
      mode,
      takeover,
      registered,
      declaration: { ...declaration },
      // 额外路线（config 里配了才有，见 extraProviders 的注释）：哪条真的被包上了六档，看这里。
      extraProviders: [...extraProviders],
      declarations: Object.fromEntries([...declarations].map(([id, row]) => [id, { ...row }])),
      tierProviders: [...tierProviders],
      identity: { pluginId, route: routeBase, provider, settingsNs },
      directory: { ...directory },
      providers: providerIds(ctx),
      builtinRoutePresent: providerIds(ctx).includes('deepseek-account'),
      rendered: { ...rendered },
      tiers: TIERS.map((tier) => ({ id: tier.id, name: tier.name, wire: wireMap.get(tier.id) ?? tier.wire, block: tier.block })),
      // 出网值配置的自证：values = 白名单，map = 实际映射，patch = 用户覆盖了哪几档，outOfRange = 白名单外的档位。
      wire: { values: wireValues, map: Object.fromEntries(wireMap), patch: { ...wireMapPatch }, outOfRange: wireOutOfRange },
      currentTier,
      currentWire: currentTier === null ? null : (wireMap.get(currentTier) ?? null),
      currentAt,
      selection,
      // 会话 id → 该会话选的档位。用对象而不是 [key, value] 数组：
      // 数组形态在 PowerShell 里被 `| ConvertTo-Json` 展开后会被误读成"多出一个档位名的键"。
      sessions: Object.fromEntries(sessionTiers),
      blockChars: blockForTier(currentTier, false, blockPatch).length,
      // 行为块正文来自哪（default / config / dir）与每块实际长度：换过文案后自证用。
      blocks: { source: blockSources.length > 0 ? [...blockSources] : ['default'], dir: blockDir, chars: Object.fromEntries(BLOCK_KEYS.map((key) => [key, blockTexts[key].length])) },
      units: { blockChars: 'JS 字符串长度（UTF-16 码元），不是 UTF-8 字节数' },
      wireObserved: { ...wireObserved },
      // 记忆任务轮在认哪几个标记、这份表从哪来（default = lib/policy.js 的出厂表，config = 用户配过）。
      // 排查"为什么 when:'memory-turn' 一条没命中"先看这里。
      memoryTurn: { markers: [...memoryTurnMarkers], source: memoryTurnMarkersFromConfig ? 'config' : 'default' },
      // 按档的委派策略：只有 Ultra 开团队整族（9 件），其余档从**工具表**里滤掉整族、
      // 只留 subagent / subagent_fork，并用 tools.guard 兜一层"同时在跑的子代理数"硬闸。
      team: {
        policy: Object.fromEntries([...TEAM_POLICY].map(([id, entry]) => [id, { team: entry.team, maxLive: entry.maxLive }])),
        collabTools: [...TEAM_COLLAB_TOOLS],
        teamTools: [...TEAM_TOOLS],
        subagentTools: [...SUBAGENT_TOOLS],
        hiddenByTier: Object.fromEntries([...TEAM_POLICY.keys()].map((id) => [id, hiddenToolsFor(id, false)])),
        teammateHidden: [...TEAMMATE_HIDDEN_TOOLS],
        spawnTool: SPAWN_TOOL,
        service: ctx.get('agentTeams') !== undefined,
        gate: { checks: gate.checks, denied: gate.denied, recent: gate.recent.map((entry) => ({ ...entry })) },
        // 每个 agent 的"工具表滤镜"状态：hidden = 最近一次装配时滤掉的名字，
        // dropped = 那次装配实际从 assembly.tools 里删掉的条数（>0 才算真删掉）。
        agents: [...policyRows.values()].map((row) => ({
          session: row.session,
          tier: row.tier,
          teammate: row.teammate,
          hidden: [...row.hidden],
          dropped: row.dropped,
          installed: row.installed === true,
          error: row.error,
          at: row.at,
        })),
      },
      // 逐模型档位覆盖的自证面：rules = 编译后真正生效的表（非法条目已在编译期丢掉），
      // recent = 最近命中并改写的请求（含 from/to），agents = 每个 agent 的瀑布装没装上。
      // 只看"配置里有这行"不算数，要看 recent 里出现过对应 provider/model。
      effortOverrides: {
        rules: effortOverrides.map((rule) => ({ ...rule })),
        recent: overrideHits.map((entry) => ({ ...entry })),
        agents: [...effortOverrideRows.values()].map((row) => ({
          session: row.session,
          hits: row.hits,
          last: row.last,
          installed: row.installed === true,
          error: row.error,
        })),
        units: {
          rules: '编译后真正生效的规则（缺 effort / provider+model 全空的条目已在编译期丢弃）',
          recent: '最近命中的改写记录，倒序，最多 40 条',
        },
      },
      // 选择守卫的自证面：记忆轮把路由换走之后，宿主的"最后一次请求路由"会被当成会话当前
      // 模型（右下角显示 + 下一轮继承）。这里看三件事：观测到几轮记忆轮（memoryTurns）、
      // 给记忆轮补了几条选择意图（pins）、普通轮次里被钉回意图的请求数（forces，>0 就是真发生过泄漏）。
      selectionGuard: {
        enabled: selectionGuardEnabled,
        rows: [...selectionGuardRows.values()].map((row) => ({
          session: row.session,
          memoryTurns: row.memoryTurns,
          pins: row.pins,
          forces: row.forces,
          last: row.last,
          via: row.via,
          installed: row.installed === true,
          error: row.error,
        })),
        units: {
          memoryTurns: '观测到的记忆任务轮数（判定复用 meow-memory 的 [meow-memory-reflect]/[meow-memory-dream] 标记）',
          pins: '记忆轮里把"会话选择"钉回意图的次数（记忆轮自己的路由不动）',
          forces: '普通轮次里路由与意图不一致、已被钉回意图的次数（>0 说明覆盖真的泄漏过）',
          via: '钉回走的通道：sessionController.selectForNextRequest（连 selection.current 一起修）或 session.append（只修显示层）',
        },
      },
      models,
    }
  }

  const sendJson = (res, code, body) => {
    const text = JSON.stringify(body, null, 2)
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) })
    res.end(text)
  }

  ctx.webServer.register({
    kind: 'prefix',
    path: routeBase,
    handler: async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const route = url.pathname.replace(routePattern, '/')
        if (route === '/state.json' || route === '/state' || route === '/') {
          sendJson(res, 200, await state())
          return
        }
        if (route === '/probe') {
          const model = url.searchParams.get('model') ?? modelIds()[0]
          const tier = url.searchParams.get('tier') ?? currentTier ?? FALLBACK_TIER
          const info = await adapter.resolveModel(provider, model)
          sendJson(res, 200, {
            provider,
            mode,
            model,
            tier,
            wire: wireMap.get(tier) ?? tier,
            blockChars: blockForTier(tier, false, blockPatch).length,
            team: (() => {
              const policy = TEAM_POLICY.get(tier) ?? TEAM_POLICY.get(FALLBACK_TIER)
              return { team: policy.team, maxLive: policy.maxLive }
            })(),
            // 这一档的 Lead、以及被派出去的一方，工具表里要滤掉的名字（纯函数算出来的）。
            hidden: hiddenToolsFor(tier, false),
            teammateHidden: hiddenToolsFor(tier, true),
            advertised: (info?.reasoning?.efforts ?? []).map((effort) => String(effort?.id ?? effort)),
            defaultEffort: String(info?.reasoning?.defaultEffort ?? ''),
          })
          return
        }
        if (route === '/selftest') {
          // 走的是宿主真正用来校验的那条路（dsh-llm 的 resolveCallConfig → resolveCallWithInfo）：
          // 六档必须全过，且 `bogus` 必须被拒——否则这个自检没有区分度。
          const model = url.searchParams.get('model') ?? modelIds()[0]
          const legal = TIERS.map((tier) => tier.id)
          const results = []
          for (const tier of [...legal, 'bogus']) {
            try {
              const info = await ctx.llm.resolveCallConfig({ provider, model, reasoningEffort: ReasoningEffortId(tier) })
              results.push({ tier, ok: true, effective: String(info?.reasoningEffort ?? info?.reasoning?.effective ?? '') })
            } catch (error) {
              results.push({ tier, ok: false, code: error?.code ?? null, message: String(error?.message ?? error) })
            }
          }
          // 第二条路（真跑用的那条）：`prepareCall` 返回的 `model` 才是宿主校验档位的依据
          // （dsh-llm/lib/index.js:2206 → :2182）。只过 resolveCallConfig 不够——
          // 2026-10-08 线上就是「selftest 全绿、真跑 xHigh 被拒」。
          const dispatch = []
          for (const tier of legal) {
            try {
              const handle = await ctx.llm.prepareCall({ provider, model, reasoningEffort: ReasoningEffortId(tier) })
              dispatch.push({ tier, ok: true, effective: String(handle?.config?.reasoningEffort ?? '') })
            } catch (error) {
              dispatch.push({ tier, ok: false, code: error?.code ?? null, message: String(error?.message ?? error) })
            }
          }
          sendJson(res, 200, {
            provider,
            mode,
            model,
            results,
            legalPass: results.filter((entry) => legal.includes(entry.tier) && entry.ok === true).length,
            bogusRejected: results.find((entry) => entry.tier === 'bogus')?.ok === false,
            dispatch,
            dispatchPass: dispatch.filter((entry) => entry.ok === true).length,
          })
          return
        }
        sendJson(res, 404, { error: `unknown route ${route}` })
      } catch (error) {
        sendJson(res, 500, { error: String(error?.stack ?? error?.message ?? error) })
      }
    },
  })

  ctx.provide('tierBoost', {
    provider,
    mode,
    takeover,
    registered,
    directory: () => ({ ...directory }),
    declaration: () => ({ ...declaration }),
    tiers: TIERS,
    currentTier: () => currentTier,
    blockForTier,
    hiddenToolsFor,
    teamTools: [...TEAM_TOOLS],
    teamPolicy: (tier) => ({ ...teamPolicyFor(tier) }),
    teamGate: () => ({ checks: gate.checks, denied: gate.denied }),
    teamAgents: () => [...policyRows.values()].map((row) => ({ session: row.session, tier: row.tier, teammate: row.teammate, hidden: [...row.hidden], dropped: row.dropped, error: row.error })),
  })
}
