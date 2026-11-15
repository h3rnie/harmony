// Applies the saved or system theme before first paint (no flash). A classic, blocking script in <head>, kept as a
// file rather than inline so the Content-Security-Policy needs no 'unsafe-inline' or hash for scripts.
(function () {
  var p = null
  try { p = localStorage.getItem('harmony-theme') } catch (e) {}
  var t = p === 'dark' || p === 'light' ? p : (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
  document.documentElement.dataset.theme = t
  document.documentElement.style.colorScheme = t
})()

// Start-up watch. Until src/main.ts sets window.__harmonyUp, a script that fails to load, an uncaught error or a slow
// connection is reported in the #boot element instead of leaving a blank page.
(function () {
  function say(text) {
    if (window.__harmonyUp) return
    var m = document.getElementById('boot-msg')
    if (m) m.textContent = text
  }
  function failed(why) {
    say('Harmony could not start (' + why + '). Reload the page; if that does not help, try a current version of Chrome, Edge, Firefox or Safari.')
  }
  window.addEventListener('error', function (e) {
    var t = e.target
    if (t && t !== window && (t.tagName === 'SCRIPT' || t.tagName === 'LINK')) failed('a file did not load: ' + (t.src || t.href || 'unknown'))
    else if (e.message) failed(String(e.message).slice(0, 160))
  }, true)
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason
    failed(String((r && r.message) || r || 'unknown error').slice(0, 160))
  })
  setTimeout(function () { say('Still loading. The app is about 0.6 MB; on a slow connection this takes a little longer.') }, 8000)
})()
