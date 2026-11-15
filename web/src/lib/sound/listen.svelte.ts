// Shared state between the Listen control (writes) and the calendar (reads): which month is sounding now.
class ListenState {
  /** Month index under the playhead, or null when nothing is sounding. */
  m = $state<number | null>(null)
  playing = $state(false)
}
export const listen = new ListenState()
