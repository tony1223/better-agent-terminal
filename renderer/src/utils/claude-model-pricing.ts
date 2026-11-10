export type ClaudeModelPricing = {
  input: number
  output: number
  cacheRead: number
  cacheWrite5m: number
  cacheWrite1h: number
}

const price = (input: number, output: number): ClaudeModelPricing => ({
  input, output, cacheRead: input * 0.1, cacheWrite5m: input * 1.25, cacheWrite1h: input * 2,
})

// USD per million tokens. Keep the cache-history estimates in both panels in
// sync. Actual SDK cost remains authoritative, especially for cumulative usage.
// https://platform.claude.com/docs/en/models/fable-5-2/overview
// https://platform.claude.com/docs/en/models/sonnet-5-5/overview
// https://platform.claude.com/docs/en/models/haiku-5-5/overview
const PRICING: Record<string, ClaudeModelPricing> = {
  'fable-5-2': { ...price(8, 40), cacheRead: 0.20 },
  'opus-5-5': { ...price(4, 20), cacheRead: 0.20 },
  'fable-5-1': { ...price(10, 50), cacheRead: 0.25 },
  'fable-5': price(10, 50),
  'opus-5': price(5, 25), 'opus-4-8': price(5, 25), 'opus-4-7': price(5, 25),
  'opus-4-6': price(5, 25), 'opus-4-5': price(5, 25),
  'opus-4-1': price(15, 75), 'opus-4': price(15, 75), 'opus-3': price(15, 75),
  'sonnet-5-5': { ...price(2, 10), cacheRead: 0.10 },
  'sonnet-5': price(2, 10),
  'sonnet-4-6': price(3, 15), 'sonnet-4-5': price(3, 15), 'sonnet-4': price(3, 15),
  'sonnet-3-7': price(3, 15), 'sonnet-3-5': price(3, 15),
  'haiku-4-5': price(1, 5), 'haiku-3-5': price(0.80, 4), 'haiku-3': price(0.25, 1.25),
}

export function getClaudeModelPricing(
  model: string,
  inputTokens?: number,
  cumulative = false,
): ClaudeModelPricing | null {
  if (model.includes('haiku-5-5')) {
    if (inputTokens === undefined || !Number.isFinite(inputTokens) || inputTokens < 0) return null
    // Haiku 5.5 charges by EACH request's prompt length, including cached
    // input. A cumulative total above 100K cannot reveal which tier its calls
    // used; omit that estimate rather than charging all calls the long tier.
    if (cumulative && inputTokens > 100_000) return null
    return inputTokens > 100_000 ? price(0.50, 2.50) : price(0.10, 0.50)
  }
  // Newer variants precede broader family prefixes, so Sonnet 5.5 cannot
  // accidentally inherit Sonnet 5's higher cache-read price.
  for (const key of [
    'fable-5-2', 'opus-5-5', 'fable-5-1', 'fable-5', 'opus-5',
    'opus-4-8', 'opus-4-7', 'opus-4-6', 'opus-4-5', 'opus-4-1',
    'sonnet-5-5', 'sonnet-5', 'sonnet-4-6', 'sonnet-4-5', 'sonnet-3-7', 'sonnet-3-5',
  ]) {
    if (model.includes(key)) return PRICING[key]
  }
  if (model.includes('opus-4-0') || /opus-4(?!-)\b|opus-4-2\d{7}/.test(model)) return PRICING['opus-4']
  if (model.includes('opus-3') || model.includes('3-opus')) return PRICING['opus-3']
  if (model.includes('sonnet-4-0') || /sonnet-4(?!-)\b|sonnet-4-2\d{7}/.test(model)) return PRICING['sonnet-4']
  if (model.includes('3-7-sonnet')) return PRICING['sonnet-3-7']
  if (model.includes('3-5-sonnet')) return PRICING['sonnet-3-5']
  if (model.includes('haiku-4') || model.includes('4-5-haiku')) return PRICING['haiku-4-5']
  if (model.includes('haiku-3-5') || model.includes('3-5-haiku')) return PRICING['haiku-3-5']
  if (model.includes('haiku-3') || model.includes('3-haiku')) return PRICING['haiku-3']
  return null
}
