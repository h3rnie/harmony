// Applies the saved or system theme before first paint (no flash). A classic, blocking script in <head>, kept as a
// file rather than inline so the Content-Security-Policy needs no 'unsafe-inline' or hash for scripts.
(function () {
  var p = null
  try { p = localStorage.getItem('harmony-theme') } catch (e) {}
  var t = p === 'dark' || p === 'light' ? p : (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
  document.documentElement.dataset.theme = t
  document.documentElement.style.colorScheme = t
})()
