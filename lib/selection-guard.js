/**
 * dsh-tier-boost / selection-guard —— 会话模型选择的「防劫持锚」。
 *
 * 背景（2026-10-09 现场，用户报「记忆反思跑的时候右下角模型会切，而且跑完了也不会切回去」）：
 *   meow-memory 的反思/梦境轮是在 `agent/request` 瀑布里对**单次请求**换路由
 *   （delegate.model = qodercn/qfmodel）。宿主把每次请求的真实路由写进会话日志的
 *   `request/header`，而 `modelSelection` 投影（dsh-api-session-controller 注册）用
 *   `lastUsed = 最后一次 request/header` + `next = pending ?? lastUsed` 供右下角控件显示；
 *   于是"一次性的请求级覆盖"会被当成"会话最后一次用的模型"留下：
 *     ① 显示层：右下角一直显示 qfmodel，除非客户端重新提交一次选择；
 *     ② 功能层（更糟）：宿主 `selection.current`（installModelSelection 的闭包变量）在没有
 *        `picked` 时回退到 request/header 的真实路由，`agent/request` 又把它强写进下一次请求
 *        ⇒ 记忆轮之后的第一条普通轮次会**继续跑 qfmodel**，自我强化，只有用户手动重选才能断。
 *
 * 本模块的修法（不碰宿主、不碰 meow-memory）：
 *   在同一个 prepend 瀑布里观察最终解析出的路由，并以**会话自己提交过的选择**
 *   （日志里最后一条 `model/selection`，即用户/客户端的选择意图）为准做两件事：
 *     · 记忆轮：路由是故意被换的，放行；同时把"会话选择"重新钉回意图（提交一条 model/selection），
 *       于是 pending 一直等于意图 —— 右下角不再跟着记忆轮跑，宿主 picked 也不会被 lastUsed 带偏；
 *     · 非记忆轮：路由与意图不一致 = 上一次覆盖漏下来了，直接把这次请求钉回意图。
 *
 * 为什么是"最后一条 model/selection"而不是"最后一次请求路由"：只有前者代表**选择意图**
 * （客户端 remote `selectModel` 是唯一的提交者，见 dsh-api-session-controller 的
 * `selectForNextRequest`），后者正是被污染的那个值。
 *
 * 本模块**不 import 任何 `@deepseek-ai/*`**（那份依赖只存在于宿主进程里），
 * 所以判据 `checks/selection-guard.check.mjs` 能直接 import 它做纯函数测试；
 * 唯一的外部依赖是同目录的 `./policy.js`（纯数据，也不 import 任何东西）。
 */

// 默认标记表放在 lib/policy.js（策略层唯一真相源），这里只做"默认值的再导出"：
// 调用方（index.js）会用 `config.memoryTurnMarkers` 覆盖它，覆盖是替换不是并集。
import { DEFAULT_MEMORY_TURN_MARKERS } from './policy.js'

/**
 * 记忆任务轮的**默认**标记（meow-memory 自己 emit 到 user/message 文本里的常量，见其 lib/index.js）。
 * 真实生效的值由调用方传入（`isMemoryTaskTurn(events, markers)`），没传才落到这份出厂表。
 */
export const MEMORY_TASK_MARKERS = Object.freeze([...DEFAULT_MEMORY_TURN_MARKERS])

/**
 * 会话事件数组的安全取用。与 meow-memory 的 `sessionEventsOf` **同构**：
 * 优先 `session.ownEvents()`（宿主给"这个会话自己的"事件流），拿不到才退化读 `session.events`。
 *
 * 2026-10-09 实测：只读 `.events` 时记忆轮标记永远扫不到 —— state.json 的
 * `effortOverrides.recent` 28/28 `memoryTurn:false`、`selectionGuard.rows.memoryTurns` 恒 0，
 * 于是 `when: memory-turn` 一条都没命中（全落到 always 兜底 `xhigh`，慢），
 * 守卫也永远走不到"记忆轮放行"分支。改成优先 ownEvents 后，与 meow-memory 自己判断
 * "这轮要不要换路由"的口径一致。
 */
export function eventsOf(session) {
  if (typeof session?.ownEvents === 'function') {
    const own = session.ownEvents()
    return Array.isArray(own) ? own : []
  }
  const events = session?.events
  return Array.isArray(events) ? events : []
}

function textOf(data) {
  const content = data?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join(' ')
}

/**
 * 会话的选择意图 = 日志里**最后一条** `model/selection`。
 * 事件形如 `{type:"model/selection", data:{provider, model, reasoningEffort}}`。
 * 找不到（老会话/子代理会话没提交过）就返回 null，调用方必须原样放行。
 */
export function lastCommittedSelection(events) {
  const list = Array.isArray(events) ? events : []
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const event = list[i]
    if (event?.type !== 'model/selection') continue
    const data = event.data ?? {}
    if (typeof data.provider !== 'string' || data.provider.length === 0) continue
    if (typeof data.model !== 'string' || data.model.length === 0) continue
    const selection = { provider: data.provider, model: data.model }
    if (typeof data.reasoningEffort === 'string' && data.reasoningEffort.length > 0) selection.reasoningEffort = data.reasoningEffort
    return selection
  }
  return null
}

/**
 * 这一轮**实际命中了哪些候选标记**：从最后一条 `turn/start` 往后，逐条看**非用户来源**的
 * user/message 文本，命中即算。判定与 meow-memory 自己的 `isMemoryTaskTurn` 同构
 * （它就是这么判断"这轮要不要换路由"的），所以这里判成记忆轮 ⇒ 换路由是它干的、必须放行。
 *
 * 作用域泛化（2026-10-11 用户 m02448）：以前只有"是不是记忆轮"这一个布尔，别人想用同一套
 * 覆盖表就没门；现在把"这轮命中了哪些标记"原样报出来，`when: { markers: [...] }` 与内置
 * `memory-turn` 走**同一段扫描**，口径不会漂。
 */
export function firedMarkers(events, candidates) {
  const pool = [...new Set((Array.isArray(candidates) ? candidates : [])
    .filter((marker) => typeof marker === 'string')
    .map((marker) => marker.trim())
    .filter((marker) => marker.length > 0))]
  if (pool.length === 0) return []
  const list = Array.isArray(events) ? events : []
  let start = -1
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i]?.type === 'turn/start') {
      start = i
      break
    }
  }
  if (start < 0) return []
  const fired = new Set()
  for (let i = start; i < list.length; i += 1) {
    const event = list[i]
    if (event?.type !== 'user/message') continue
    if (event.data?.source?.kind === 'user') continue
    const text = textOf(event.data)
    for (const marker of pool) {
      if (text.includes(marker)) fired.add(marker)
    }
  }
  return [...fired]
}

/**
 * 当前这一轮是不是记忆任务轮（= 命中了默认标记表里的任一条）。语义与 meow-memory 自己的
 * `isMemoryTaskTurn` 同构；实现复用 `firedMarkers`，保证两条判定永不漂移。
 */
export function isMemoryTaskTurn(events, markers = MEMORY_TASK_MARKERS) {
  return firedMarkers(events, markers).length > 0
}

/**
 * 请求配置与选择意图是否算"同一个路由"。
 * provider/model 必须一致；档位只在**意图里明确写了**的时候才比（意图没写档位就不管档位，
 * 避免"无从比较"被当成"不一致"而每轮都改写）。
 */
export function sameSelection(config, selection) {
  if (config === null || config === undefined || selection === null || selection === undefined) return false
  if (config.provider !== selection.provider) return false
  if (config.model !== selection.model) return false
  if (selection.reasoningEffort === undefined) return true
  return String(config.reasoningEffort ?? '') === String(selection.reasoningEffort)
}

export function selectionDiffers(config, selection) {
  return !sameSelection(config, selection)
}

/**
 * 把请求配置钉回选择意图：只在**真的不一样**的时候换对象，一样就返回原引用
 * （调用方据此判断"这次没被动过"，与 overrides.js 同契约）。
 */
export function applySelectionPin(config, selection) {
  if (config === null || config === undefined || typeof config !== 'object') return config
  if (selection === null || selection === undefined) return config
  if (sameSelection(config, selection)) return config
  return {
    ...config,
    provider: selection.provider,
    model: selection.model,
    ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
  }
}

/**
 * 选择守卫的决策（纯函数，判据直接测它 —— 这里最容易翻车的不是"钉不钉"，而是
 * **把故意换路由的记忆轮也钉回去**，那等于静默废掉 qfmodel 跑反思）。
 *
 * 返回 `{action, intent, memory}`：
 *   · `'skip'`  = 拿不到选择意图（老会话/子代理会话）→ 什么都不做；
 *   · `'pass'`  = 记忆轮 → 路由原样放行，只补一条 `model/selection` 把"会话选择"钉回意图；
 *   · `'force'` = 非记忆轮且路由 ≠ 意图（上一次请求级覆盖漏下来了）→ 把这次请求钉回意图；
 *   · `'keep'`  = 非记忆轮且路由已经等于意图 → 什么都不做。
 */
export function decideSelectionGuard(config, events, markers = MEMORY_TASK_MARKERS) {
  const intent = lastCommittedSelection(events)
  if (intent === null) return { action: 'skip', intent: null, memory: false }
  const memory = isMemoryTaskTurn(events, markers)
  if (memory) return { action: 'pass', intent, memory: true }
  if (!selectionDiffers(config, intent)) return { action: 'keep', intent, memory: false }
  return { action: 'force', intent, memory: false }
}

/**
 * 配置项解析：`selectionGuard: false` 或 `selectionGuard: {enabled: false}` 关闭，默认开。
 * 关掉时连 `agent/request` 都不挂，不给请求路径加开销。
 */
export function guardEnabled(settings) {
  const raw = settings?.selectionGuard
  if (raw === false) return false
  if (raw !== null && typeof raw === 'object' && raw.enabled === false) return false
  return true
}
