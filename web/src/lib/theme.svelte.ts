import type { Theme } from './color'

type Pref = 'system' | Theme
const KEY = 'harmony-theme'

function readPref(): Pref {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'dark' || v === 'light' ? v : 'system'
  } catch {
    return 'system'
  }
}

class ThemeState {
  pref = $state<Pref>(readPref())
  systemDark = $state(typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)').matches : true)
  reducedMotion = $state(typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)').matches : false)

  get theme(): Theme {
    return this.pref === 'system' ? (this.systemDark ? 'dark' : 'light') : this.pref
  }

  constructor() {
    if (typeof matchMedia === 'function') {
      matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => { this.systemDark = e.matches; this.apply() })
      matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', (e) => { this.reducedMotion = e.matches })
    }
  }

  toggle() {
    this.pref = this.theme === 'dark' ? 'light' : 'dark'
    try { localStorage.setItem(KEY, this.pref) } catch { /* private mode */ }
    this.apply()
  }

  apply() {
    document.documentElement.dataset.theme = this.theme
    document.documentElement.style.colorScheme = this.theme
  }
}

export const themeState = new ThemeState()
