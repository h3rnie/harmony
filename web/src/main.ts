import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'

const app = mount(App, {
  target: document.getElementById('app')!,
})

// The app is on screen: stop the start-up watch (public/theme-init.js) and remove its placeholder.
;(window as unknown as { __harmonyUp?: boolean }).__harmonyUp = true
document.getElementById('boot')?.remove()

export default app
