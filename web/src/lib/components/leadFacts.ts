// Does the AI brief's opening sentence add anything the answer card does not already say?
// A deliberately simple heuristic: a "fact" is a number (ratios, ranks, counts, percentages, years), an ordinal word
// ("fourth") or a month name. The sentence earns its line in the card only when it carries at least one such fact
// that the card's own text does not. Paraphrase without new facts ("activity is well above normal") is skipped.

const ORD: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  twice: 2, double: 2, doubled: 2, half: 0.5, triple: 3, tripled: 3, thrice: 3,
}
const MONTH_RE = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/g

function facts(text: string): { nums: number[]; months: Set<string> } {
  const t = text.toLowerCase().replace(/(\d),(\d{3})/g, '$1$2')
  const nums: number[] = []
  for (const m of t.matchAll(/\d+(?:\.\d+)?/g)) nums.push(parseFloat(m[0]))
  for (const w of t.match(/[a-z]+/g) ?? []) if (w in ORD) nums.push(ORD[w])
  const months = new Set<string>()
  for (const m of t.matchAll(MONTH_RE)) months.add(m[1].slice(0, 3))
  return { nums, months }
}

/** True when `sentence` states a number or month that `card` (the card's visible text) does not. */
export function addsFact(sentence: string, card: string): boolean {
  if (!sentence.trim()) return false
  const s = facts(sentence), c = facts(card)
  const known = (n: number) => c.nums.some((k) => Math.abs(k - n) <= Math.max(0.051, Math.abs(n) * 0.03))
  if (s.nums.some((n) => !known(n))) return true
  for (const m of s.months) if (!c.months.has(m)) return true
  return false
}
