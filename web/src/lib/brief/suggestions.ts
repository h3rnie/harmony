// Suggested follow-up questions, generated locally from the statistics (no model call): they only offer what the
// dossier can actually answer.
import type { Dossier } from './dossierTypes'

export function suggestQuestions(d: Dossier): string[] {
  const out: string[] = []
  if (d.detail.similarYears.length) out.push('Which years were most like this one?')
  if (d.month.ratio != null || d.month.percentile != null) out.push(`How unusual is ${d.month.label}?`)
  out.push('When does the season usually peak?')
  if (d.outlook) out.push('What does the outlook say for next month?')
  else out.push(d.trend.direction === 'none' ? 'Is activity trending up or down?' : 'Is activity trending up?')
  if (d.month.provisional) out.push('How much could this month change?')
  return out.slice(0, 4)
}
