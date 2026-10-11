/**
 * 逐模型推理档位覆盖表（纯函数，故意不 import 任何 `@deepseek-ai/*`）。
 *
 * 为什么需要它：DSH 的推理档位是**全局唯一**的一个值（profile 里
 * `agent-default-model.reasoningEffort`），而不同 provider/model advertise 的档位集合并不相同。
 * 全局值撞上"档位表里没有它"的模型时，宿主在 prepare 阶段直接抛
 * `provider "..." model "..." does not support reasoning effort "..."`(UNSUPPORTED_REASONING_EFFORT)，
 * **整轮彻底跑不起来**——现场就是 meow-memory 的反思/梦境轮换成 `qodercn/qfmodel`
 * （档位表 ["xhigh","low","medium"]）却继承全局 `high`。
 *
 * 本表把"档位"从全局单值变成"按 provider/model 覆写"：命中的请求把 reasoningEffort 换成表里的值，
 * 其余字段一律不动。因为是纯函数，判据可以脱离宿主进程直接 import 它（见
 * `D:\Documents\deepseek-harness\default-workspace\checks\effort-override.check.mjs`）。
 *
 * 规则形状：`{ provider?, model?, effort, when? }`
 *   - `provider` 留空 = 该维通配（任何 provider 都算命中）
 *   - `model` 留空 = 该维通配
 *   - `effort` 必填；缺失/空白/非字符串的规则整条丢弃（宁可不生效，也不要用一个空档位去撞宿主校验）
 *   - `when` 见下（`'always'` 默认 / `'memory-turn'` / `{ markers: [...] }`）
 *   - provider 与 model 不能同时留空（那会变成"全局默认档位"，语义与 agent-default-model 重复且危险）
 *   - **顺序即优先级**：取第一条命中的规则，所以"越具体越靠前"由使用方负责（判据里有对应断言）
 *
 * `when` 的作用域开关（2026-10-09 用户提出「qodercn/qfmodel effort=xhigh 整理记忆很慢，
 * 反思和回忆的思考强度有必要很高吗」后加；2026-10-11 泛化成通用标记，见第三条）：
 *   - `'always'`（默认）：只要 provider/model 命中就生效；
 *   - `'memory-turn'`：**只在记忆任务轮**（meow-memory 的反思/梦境轮）生效。这样"把 qfmodel
 *     钉成低档"只影响记忆整理，用户手动选 qfmodel 时自己挑的档位不会被悄悄改掉
 *     （否则界面上显示 xhigh、出网却是 low，属于静默不一致）。
 *   - `{ markers: ['[my-marker]', ...] }`：**任意标记**。别人的插件在自己的轮次里 emit 一句带标记的
 *     user/message，就能用同一套覆盖表（不必再往本文件里加枚举）——这就是"作用域条件泛化"。
 *   判定由调用方通过 context 传进来：`applyEffortOverride(config, rules, { memoryTurn, markers })`；
 *   两条路走的是**同一段扫描**（selection-guard 的 `firedMarkers`），只是候选标记不同。
 *   不传 context（比如判据里的纯函数单测）时，`'memory-turn'` 与 markers 规则一律不命中——
 *   拿不准轮次就**别动**，宁可慢也不要改错。
 */

const asText = (value) => (typeof value === 'string' ? value.trim() : '')

const WHEN_ALWAYS = 'always'
const WHEN_MEMORY = 'memory-turn'

/** 把 `when.markers` 里的标记规整成去重后的非空字符串数组；一个有效标记都没有就返回 null。 */
function asMarkers(value) {
  const raw = typeof value === 'string' ? value.split(/[\s,]+/) : (Array.isArray(value) ? value : null)
  if (raw === null) return null
  const list = [...new Set(raw
    .filter((marker) => typeof marker === 'string')
    .map((marker) => marker.trim())
    .filter((marker) => marker.length > 0))]
  return list.length > 0 ? list : null
}

/**
 * 认不出的 `when` 写法返回 null ⇒ 整条规则丢弃（与"effort 缺失就丢"同一原则）。
 * 不写 when（undefined/null）仍等价 `always`；但**非字符串非对象**（数字/布尔/数组）按"认不出"丢弃——
 * 配置写错时"这条规则不生效"比"静默变成 always 改掉所有请求的档位"安全。
 * 字符串写法存成字符串、对象写法存成 `{ kind: 'markers', markers }`——判据会逐条比对编译结果，
 * 所以"存成什么形状"是契约的一部分（见 checks/effort-override.check.mjs）。
 */
function asWhen(value) {
  if (value === undefined || value === null) return WHEN_ALWAYS
  if (typeof value === 'object' && !Array.isArray(value)) {
    const markers = asMarkers(value.markers ?? value.marker)
    return markers === null ? null : { kind: 'markers', markers }
  }
  if (typeof value !== 'string') return null
  const text = asText(value).toLowerCase().replace(/[\s_]+/g, '-')
  if (text === '' || text === 'always' || text === 'any') return WHEN_ALWAYS
  if (text === 'memory-turn' || text === 'memoryturn' || text === 'memory') return WHEN_MEMORY
  return null
}

/**
 * 这条规则的 `when` 在这一轮上成不成立。context 由调用方给：
 * `{ memoryTurn?: boolean, markers?: string[] }`（markers = 这一轮实际命中的标记，见 selection-guard）。
 */
function whenMatches(when, context) {
  if (when === WHEN_ALWAYS) return true
  const ctx = context !== null && typeof context === 'object' ? context : {}
  if (when === WHEN_MEMORY) return ctx.memoryTurn === true
  if (when !== null && typeof when === 'object' && Array.isArray(when.markers)) {
    const fired = Array.isArray(ctx.markers) ? ctx.markers : []
    return when.markers.some((marker) => fired.includes(marker))
  }
  return false
}

/**
 * 表里所有 `when: { markers: [...] }` 用到的标记（去重）。
 * 调用方拿它跟内置 memoryTurnMarkers 并起来扫这一轮的 user/message——判定口径与内置完全一致。
 */
export function overrideMarkersOf(rules) {
  const out = new Set()
  for (const rule of Array.isArray(rules) ? rules : []) {
    if (rule?.when !== null && typeof rule?.when === 'object' && Array.isArray(rule.when.markers)) {
      for (const marker of rule.when.markers) out.add(marker)
    }
  }
  return [...out]
}

/**
 * 把配置里的原始数组编译成干净的规则表。
 * 任何形状不对的条目都静默丢弃——配置错误不该让整个插件挂掉，但也不该被当成有效规则放行。
 */
export function compileEffortOverrides(raw) {
  if (!Array.isArray(raw)) return []
  const rules = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    const effort = asText(entry.effort)
    if (effort.length === 0) continue
    const when = asWhen(entry.when)
    if (when === null) continue
    const provider = asText(entry.provider)
    const model = asText(entry.model)
    if (provider.length === 0 && model.length === 0) continue
    rules.push({ provider, model, effort, when })
  }
  return rules
}

/**
 * 取第一条命中的规则。`provider` / `model` 为空串的维度视为通配。
 * 作用域判定统一走 `whenMatches(rule.when, context)`：`'memory-turn'` 看 `context.memoryTurn`，
 * `{ markers }` 看 `context.markers`（两者都不给就不命中）。
 * 没命中返回 undefined（调用方据此保留原配置引用）。
 */
export function pickEffortOverride(rules, provider, model, context) {
  if (!Array.isArray(rules) || rules.length === 0) return undefined
  const wantProvider = typeof provider === 'string' ? provider : ''
  const wantModel = typeof model === 'string' ? model : ''
  for (const rule of rules) {
    if (!whenMatches(rule.when, context)) continue
    if (rule.provider.length > 0 && rule.provider !== wantProvider) continue
    if (rule.model.length > 0 && rule.model !== wantModel) continue
    return rule
  }
  return undefined
}

/**
 * 把规则应用到一份已解析的请求配置上。
 *
 * 契约（判据逐条钉住）：
 *   - 输入不是对象 → 原样返回；
 *   - 没命中规则 → 返回**原引用**（上层可据此判断"这次没被动过"）；
 *   - 命中的档位与现值相同 → 同样返回原引用（不做无意义的对象重建）；
 *   - 命中且值不同 → 浅拷贝并只改 `reasoningEffort`，其余字段（provider/model/maxTokens/…）逐个原样带过去；
 *   - 原本没有 `reasoningEffort` 字段也能补上。
 *
 * `context` 会透传给 `pickEffortOverride`（决定 `when: 'memory-turn'` 的规则能不能命中），
 * 省略时那些规则不生效——纯函数判据就是靠这一点做"不传 context = 不动"的断言。
 */
export function applyEffortOverride(config, rules, context) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) return config
  const hit = pickEffortOverride(rules, config.provider, config.model, context)
  if (hit === undefined) return config
  if (config.reasoningEffort === hit.effort) return config
  return { ...config, reasoningEffort: hit.effort }
}
