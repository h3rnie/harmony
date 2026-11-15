// The situation brief's opening line, lifted into the answer card when an AI-written brief is available.
// BriefCard writes it; StatusStrip reads it. Empty when only the rule-based brief exists (its first sentence
// repeats the answer card word for word, so lifting it would add nothing).
class BriefLead {
  text = $state('')
  /** Dossier key the text belongs to, so a stale line never shows against new statistics. */
  key = $state('')
}
export const briefLead = new BriefLead()
