// One probe per page load, shared by the brief card and the Ask box: GET /api/brief -> provider status.
import { probeAi, type AiStatus } from './client'

class AiStatusStore {
  /** null until the one-off probe has answered. */
  value = $state<AiStatus | null>(null)
  private started = false
  ensure(): void {
    if (this.started) return
    this.started = true
    probeAi().then((r) => { this.value = r })
  }
}

export const aiStatus = new AiStatusStore()
