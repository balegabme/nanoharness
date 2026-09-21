import { describe, expect, it } from 'vitest'
import { readFacts, readOffers } from './model-facts.js'
import { clampEffort as coreClamp, EFFORTS as CORE_EFFORTS, factGaps, PRICES as CORE_PRICES, resolveFacts } from '../core/config.js'
import { costOf, moneyText } from '../core/cost.js'
import {
  clampEffort,
  costOf as windowCost,
  EFFORTS,
  PRICES,
  factGaps as windowGaps,
  moneyText as windowMoney,
  priceText,
  resolveFacts as windowResolve,
} from '../renderer/facts.js'
import type { Effort, ModelFacts, ProviderRecord } from '../core/config.js'
import type { TurnUsage } from '../core/types.js'

/**
 * What an endpoint says about a model, read off the four `/models` shapes that
 * say anything. The point of these is the gap: the documented answers and most
 * proxies carry no prices and no effort list, and the settings screen decides
 * whether to show a warning from exactly what comes out of here.
 */

describe('reading a model list', () => {
  it('takes prices that arrive as strings of dollars per token', () => {
    const facts = readFacts({
      id: 'anthropic/claude-opus-5',
      pricing: { prompt: '0.000015', completion: '0.000075', input_cache_read: '0.0000015' },
      supported_parameters: ['tools', 'reasoning', 'temperature'],
    })
    expect(facts.input).toBe(15)
    expect(facts.output).toBe(75)
    expect(facts.cacheRead).toBeCloseTo(1.5, 10)
    // `supported_parameters` says the model reasons, never at which levels.
    // Turning that into a list of seven would be inventing the answer.
    expect(facts.efforts).toBeUndefined()
    expect(factGaps(facts)).toEqual(['efforts'])
  })

  it('takes an effort list out of the reasoning metadata', () => {
    const facts = readFacts({
      id: 'qwen3-next',
      metadata: { reasoning: { default_enabled: true, supported_efforts: ['low', 'medium', 'high'], default_effort: 'medium' } },
    })
    expect(facts.efforts).toEqual(['low', 'medium', 'high'])
    expect(factGaps(facts)).toEqual(['cost'])
  })

  it('takes costs from model_info as well as the top level', () => {
    expect(readFacts({ id: 'a', model_info: { input_cost_per_token: 0.0000003, output_cost_per_token: 0.0000012 } })).toMatchObject({
      input: 0.3,
      output: 1.2,
    })
    expect(readFacts({ id: 'b', input_cost_per_token: 0.000001, output_cost_per_token: 0.000002 })).toMatchObject({ input: 1, output: 2 })
  })

  it('floors a ceiling and drops one that does not come out positive', () => {
    // Zero is not a ceiling a request can be built inside, and a sub-token
    // fraction floors to it; a fraction above one keeps its whole part.
    expect(readFacts({ id: 'half', max_tokens: 0.5 })).toEqual({})
    expect(readFacts({ id: 'zero', max_tokens: 0 })).toEqual({})
    expect(readFacts({ id: 'round', max_tokens: 64_000.9 }).maxOutput).toBe(64_000)
  })

  it('reads a free model as free, and a bare entry as nothing known', () => {
    const free = readFacts({ id: 'free-thing', pricing: { prompt: '0', completion: '0' } })
    expect(free.input).toBe(0)
    expect(free.output).toBe(0)
    expect(factGaps(free)).toEqual(['efforts'])

    const bare = readFacts({ id: 'gpt-5.2', object: 'model', created: 1_700_000_000, owned_by: 'openai' })
    expect(bare).toEqual({})
    expect(factGaps(bare)).toEqual(['efforts', 'cost'])
  })

  it('keeps ids sorted and unique, and skips entries that are not models', () => {
    const offers = readOffers([{ id: 'b' }, 'nope', null, { id: 'a', pricing: { prompt: '0.000002' } }, { id: 'a' }, { name: 'no id' }])
    expect(offers.map(o => o.id)).toEqual(['a', 'b'])
    // The first entry for an id wins, so a later bare duplicate cannot erase
    // prices the earlier one carried.
    expect(offers[0]?.facts.input).toBe(2)
  })
})

describe('what the harness believes about a model', () => {
  it('lets a typed correction beat the endpoint field by field', () => {
    const provider = record({ input: 9, output: 9, efforts: ['low', 'high'] }, { input: 1 })
    expect(resolveFacts(provider, 'm')).toEqual({ efforts: ['low', 'high'], input: 1, output: 9 })
  })

  it('describes a model the endpoint said nothing about once the user fills it in', () => {
    expect(factGaps(resolveFacts(record(), 'm'))).toEqual(['efforts', 'cost'])
    const filled = record(undefined, { efforts: ['none', 'medium'], input: 0.5, output: 2 })
    expect(factGaps(resolveFacts(filled, 'm'))).toEqual([])
  })
})

/**
 * The window keeps its own copy of the scale and of these two functions.
 * `src/core/config.ts` holds the definitions and the main process uses those,
 * but eslint.config.js forbids the renderer a runtime import from core, so the
 * copies are held against each other here.
 */

const CASES: ModelFacts[] = [
  {},
  { efforts: [] },
  { efforts: ['low', 'high'] },
  { input: 0, output: 0 },
  { input: 1.25 },
  { input: 1.25, output: 10, cacheRead: 0.125 },
  { efforts: ['none', 'medium'], input: 3, output: 15 },
  { maxOutput: 64_000 },
  { efforts: ['low', 'medium'], maxOutput: 8_192 },
  { vision: true },
  { vision: false },
  { input: 3, vision: true },
]

function record(facts?: ModelFacts, overrides?: ModelFacts): ProviderRecord {
  return {
    id: 'p',
    name: 'p',
    kind: 'openai',
    baseURL: 'https://example.test/v1',
    models: ['m'],
    ...(facts === undefined ? {} : { facts: { m: facts } }),
    ...(overrides === undefined ? {} : { overrides: { m: overrides } }),
  }
}

/**
 * A `capabilities` block is the one answer that states this outright: it names
 * the effort levels the model takes and the most output it will produce. The
 * shape below is the one an endpoint that publishes it sends.
 */

describe('a model list that names capabilities', () => {
  const opus = {
    id: 'claude-opus-5',
    display_name: 'Claude Opus 5',
    max_tokens: 64_000,
    capabilities: {
      // Alphabetical, which is how endpoints tend to print it and the order
      // JSON.parse hands back. The picker reads the list top to bottom.
      effort: {
        high: { supported: true },
        low: { supported: true },
        max: { supported: true },
        medium: { supported: true },
        supported: true,
        xhigh: { supported: true },
      },
      thinking: { supported: true, types: { adaptive: { supported: true }, enabled: { supported: true } } },
    },
  }

  it('takes the levels the model names, in the order the scale runs', () => {
    // `none` is the thinking block left out of the request, which needs no
    // permission; `minimal` is a budget the list does not mention, so it is not
    // invented here.
    expect(readFacts(opus).efforts).toEqual(['none', 'low', 'medium', 'high', 'xhigh', 'max'])
  })

  it('takes the ceiling, so a request is built inside what the model will produce', () => {
    expect(readFacts(opus).maxOutput).toBe(64_000)
  })

  it('leaves out a level the model says it does not take', () => {
    const narrow = {
      id: 'claude-sonnet-5',
      capabilities: { effort: { supported: true, low: { supported: true }, max: { supported: false }, medium: { supported: true } } },
    }
    expect(readFacts(narrow).efforts).toEqual(['none', 'low', 'medium'])
  })

  it('offers no thinking at all on a model that says it does not think', () => {
    const haiku = { id: 'claude-haiku-4-5', max_tokens: 8192, capabilities: { thinking: { supported: false } } }
    expect(readFacts(haiku).efforts).toEqual(['none'])
  })

  it('leaves the levels unknown when the block says nothing about effort', () => {
    const quiet = { id: 'claude-sonnet-4-5', capabilities: { image_input: { supported: true } } }
    expect(readFacts(quiet).efforts).toBeUndefined()
  })

  it('reads the prices it has no field for as missing, which is what marks the model', () => {
    expect(factGaps(readFacts(opus))).toEqual(['cost'])
  })
})

describe('whether a model takes images', () => {
  it('reads a list of input modalities, in either place it is written', () => {
    expect(readFacts({ id: 'm', architecture: { input_modalities: ['text', 'image'] } }).vision).toBe(true)
    expect(readFacts({ id: 'm', architecture: { input_modalities: ['text'] } }).vision).toBe(false)
    expect(readFacts({ id: 'm', input_modalities: ['text', 'image', 'file'] }).vision).toBe(true)
  })

  it('reads the older arrow spelling of the same list', () => {
    expect(readFacts({ id: 'm', architecture: { modality: 'text+image->text' } }).vision).toBe(true)
    expect(readFacts({ id: 'm', architecture: { modality: 'text->text' } }).vision).toBe(false)
  })

  it('reads a capabilities block or a capabilities list', () => {
    expect(readFacts({ id: 'm', capabilities: ['completion', 'vision'] }).vision).toBe(true)
    expect(readFacts({ id: 'm', capabilities: ['completion'] }).vision).toBe(false)
    expect(readFacts({ id: 'm', capabilities: { vision: { supported: true } } }).vision).toBe(true)
    expect(readFacts({ id: 'm', capabilities: { vision: false } }).vision).toBe(false)
  })

  it('reads the flag a gateway sets beside its prices', () => {
    expect(readFacts({ id: 'm', supports_vision: true }).vision).toBe(true)
    expect(readFacts({ id: 'm', model_info: { supports_vision: false } }).vision).toBe(false)
  })

  it('leaves it unanswered when the endpoint said nothing', () => {
    expect(readFacts({ id: 'm' }).vision).toBeUndefined()
    expect(readFacts({ id: 'm', pricing: { prompt: '0.000003' } }).vision).toBeUndefined()
    // Not a boolean, so not an answer: a string cannot be read as a yes.
    expect(readFacts({ id: 'm', supports_vision: 'yes' }).vision).toBeUndefined()
  })
})

describe('the window and the main process describing the same model', () => {
  it('offers the same effort scale, in the same order', () => {
    expect(EFFORTS).toEqual(CORE_EFFORTS)
  })

  it('prices the same halves of a model', () => {
    expect(PRICES).toEqual(CORE_PRICES)
  })

  it('agrees on what is missing, for every shape a model can arrive in', () => {
    for (const facts of CASES) expect(windowGaps(facts)).toEqual(factGaps(facts))
    expect(windowGaps(undefined)).toEqual(factGaps(undefined))
  })

  it('agrees on what a typed correction does to an endpoint answer', () => {
    for (const reported of CASES) {
      for (const typed of CASES) {
        const provider = record(reported, typed)
        expect(windowResolve(provider, 'm')).toEqual(resolveFacts(provider, 'm'))
      }
    }
  })
})

describe('an effort the model does not take', () => {
  it('lands on the same level in the window as in the main process', () => {
    const lists: Effort[][] = [['none', 'low', 'medium', 'high'], ['low', 'medium', 'high'], ['none', 'high'], ['low', 'high'], ['max']]
    for (const offered of lists) {
      for (const wanted of EFFORTS) expect(clampEffort(offered, wanted)).toBe(coreClamp(offered, wanted))
    }
  })

  it('steps down the scale rather than falling to the bottom', () => {
    expect(clampEffort(['none', 'low', 'medium', 'high'], 'max')).toBe('high')
    expect(clampEffort(['low', 'medium', 'high'], 'minimal')).toBe('low')
    // Nearest wins over cheapest: none and high are three and one steps away.
    expect(clampEffort(['none', 'high'], 'medium')).toBe('high')
    // Equally far either way, so the quieter of the two.
    expect(clampEffort(['low', 'high'], 'medium')).toBe('low')
  })

  it('leaves a level the model does take alone', () => {
    for (const effort of EFFORTS) expect(clampEffort(EFFORTS, effort)).toBe(effort)
  })
})

describe('the price on a model row', () => {
  it('says free rather than nothing when a model is free', () => {
    expect(priceText({ input: 0, output: 0 })).toBe('free')
  })

  it('stays blank until both halves are known', () => {
    expect(priceText({ input: 1.25 })).toBe('')
    expect(priceText({ input: 1.25, output: 10 })).toBe('$1.25 in / $10 out per Mtok')
  })
})

/**
 * What a turn cost. The numbers below are a real price list: $3 in, $15 out,
 * $0.30 a cached read, $3.75 to write one, per million tokens.
 */

const PRICED: ModelFacts = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }

function usage(part: Partial<TurnUsage>): TurnUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, ...part }
}

/**
 * Long context at a higher rate. Grok 4.6's real list: $2 in and $6 out up to a
 * 200K prompt, twice that above it, and the endpoint charges the whole request
 * at whichever rate the prompt reaches.
 */

const TIERED: ModelFacts = {
  input: 2,
  output: 6,
  cacheRead: 0.5,
  tiers: [{ over: 200_000, input: 4, output: 12, cacheRead: 1 }],
}

describe('a model that charges more for a long prompt', () => {
  it('bills the whole request at the base rate below the line', () => {
    // 100K in at $2, 1K out at $6.
    expect(costOf(usage({ input: 100_000, output: 1_000 }), TIERED)).toBeCloseTo(0.206, 10)
  })

  it('bills the whole request at the tier once the prompt passes it', () => {
    // Not the tokens past 200K: every one of the 250K is charged at $4.
    expect(costOf(usage({ input: 250_000, output: 1_000 }), TIERED)).toBeCloseTo(1.012, 10)
  })

  it('counts cached tokens towards the line, because the model still reads them', () => {
    const cached = usage({ input: 1_000, cacheRead: 250_000 })
    expect(costOf(cached, TIERED)).toBeCloseTo(0.254, 10)
    // The same tokens uncached would have reached the tier too.
    expect(costOf(usage({ input: 251_000 }), TIERED)).toBeCloseTo(1.004, 10)
  })

  it('keeps a base rate the tier says nothing about', () => {
    const partial: ModelFacts = { input: 2, output: 6, cacheRead: 0.5, tiers: [{ over: 100, output: 12 }] }
    // Output doubles, input and the cached read stay where they were.
    expect(costOf(usage({ input: 1_000, output: 1_000 }), partial)).toBeCloseTo(0.014, 10)
  })

  it('takes the highest tier the prompt reaches, whatever order they arrive in', () => {
    const steps: ModelFacts = {
      input: 1,
      output: 1,
      tiers: [{ over: 500_000, input: 8 }, { over: 100_000, input: 2 }],
    }
    expect(costOf(usage({ input: 50_000 }), steps)).toBeCloseTo(0.05, 10)
    expect(costOf(usage({ input: 200_000 }), steps)).toBeCloseTo(0.4, 10)
    expect(costOf(usage({ input: 600_000 }), steps)).toBeCloseTo(4.8, 10)
  })

  it('is priced the same in the window as in the main process', () => {
    for (const run of [usage({ input: 199_999 }), usage({ input: 200_001, output: 5 }), usage({ cacheRead: 400_000 })]) {
      expect(windowCost(run, TIERED)).toEqual(costOf(run, TIERED))
    }
  })

  it('drops the tiers when the user has typed a price of their own', () => {
    const record: ProviderRecord = {
      id: 'p',
      name: 'p',
      kind: 'openai',
      baseURL: 'https://example.test/v1',
      models: ['m'],
      facts: { m: TIERED },
      overrides: { m: { input: 1, output: 1 } },
    }
    // The form offers no way to edit a tier, so keeping one would quietly
    // double a number the user had just corrected.
    expect(resolveFacts(record, 'm').tiers).toBeUndefined()
    expect(windowResolve(record, 'm').tiers).toBeUndefined()
    // A correction that says nothing about price leaves them alone.
    expect(resolveFacts({ ...record, overrides: { m: { vision: true } } }, 'm').tiers).toEqual(TIERED.tiers)
  })
})

describe('what a turn cost', () => {
  it('charges each kind of token at its own rate', () => {
    const spent = costOf(usage({ input: 10_000, output: 2_000, cacheRead: 40_000, cacheWrite: 8_000 }), PRICED)
    // 0.03 + 0.03 + 0.012 + 0.03
    expect(spent).toBeCloseTo(0.102, 10)
  })

  it('leaves reasoning tokens out, because the output count already holds them', () => {
    const thought = usage({ input: 1_000, output: 5_000, reasoning: 4_000 })
    expect(costOf(thought, PRICED)).toBe(costOf(usage({ input: 1_000, output: 5_000 }), PRICED))
  })

  it('falls back to the input rate for a cache price nobody has given', () => {
    const flat: ModelFacts = { input: 3, output: 15 }
    expect(costOf(usage({ cacheRead: 1_000_000 }), flat)).toBe(3)
    expect(costOf(usage({ cacheWrite: 1_000_000 }), flat)).toBe(3)
  })

  it('says nothing rather than zero when the model has no price', () => {
    expect(costOf(usage({ input: 1_000, output: 1_000 }), {})).toBeNull()
    expect(costOf(usage({ input: 1_000 }), { input: 3 })).toBeNull()
    expect(costOf(usage({}), PRICED)).toBe(0)
  })

  it('keeps a small figure legible instead of rounding it to nothing', () => {
    expect(moneyText(0)).toBe('$0')
    expect(moneyText(0.000_02)).toBe('<$0.0001')
    expect(moneyText(0.0123)).toBe('$0.012')
    expect(moneyText(12.345)).toBe('$12.35')
  })

  it('is priced the same in the window as in the main process', () => {
    const runs = [
      usage({}),
      usage({ input: 1, output: 1 }),
      usage({ input: 12_345, output: 678, cacheRead: 90_000, cacheWrite: 1_234, reasoning: 500 }),
    ]
    for (const run of runs) {
      for (const facts of [...CASES, PRICED]) expect(windowCost(run, facts)).toEqual(costOf(run, facts))
    }
  })

  it('writes a figure the same way in the window as in the main process', () => {
    for (const usd of [0, 0.000_02, 0.000_1, 0.005, 0.0123, 0.5, 1, 12.345, 980.4]) {
      expect(windowMoney(usd)).toBe(moneyText(usd))
    }
  })
})
