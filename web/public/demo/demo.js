// Viewer for the pitch deck at /demo: scales the 1920 x 1080 slides to the window and steps through them.
(function () {
  var stage = document.getElementById('stage')
  var viewport = document.getElementById('viewport')
  var slides = Array.prototype.slice.call(stage.children).filter(function (el) { return el.tagName === 'SECTION' })
  var count = document.getElementById('count')
  var prev = document.getElementById('prev')
  var next = document.getElementById('next')
  var notes = document.getElementById('notes')
  var notesText = document.getElementById('notes-text')
  var notesBtn = document.getElementById('notes-btn')
  var fullBtn = document.getElementById('full-btn')
  var at = 0

  function fit() {
    var w = viewport.clientWidth, h = viewport.clientHeight
    var k = Math.min(w / 1920, h / 1080)
    stage.style.transform = 'translate(' + (w - 1920 * k) / 2 + 'px,' + (h - 1080 * k) / 2 + 'px) scale(' + k + ')'
  }

  function show(n, keepHash) {
    at = Math.max(0, Math.min(slides.length - 1, n))
    slides.forEach(function (s, j) { s.classList.toggle('on', j === at) })
    count.textContent = (at + 1) + ' / ' + slides.length
    prev.disabled = at === 0
    next.disabled = at === slides.length - 1
    var a = slides[at].querySelector('aside')
    notesText.textContent = a ? a.textContent : ''
    notes.scrollTop = 0
    if (!keepHash) { try { history.replaceState(null, '', '#' + (at + 1)) } catch (e) {} }
  }

  function fromHash() {
    var n = parseInt(location.hash.slice(1), 10)
    return n >= 1 && n <= slides.length ? n - 1 : 0
  }

  function toggleNotes() {
    var on = notes.hidden
    notes.hidden = !on
    document.body.classList.toggle('dv-with-notes', on)
    notesBtn.setAttribute('aria-pressed', String(on))
    fit()
  }

  function toggleFull() {
    if (document.fullscreenElement) document.exitFullscreen()
    else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(function () {})
  }

  prev.addEventListener('click', function () { show(at - 1) })
  next.addEventListener('click', function () { show(at + 1) })
  notesBtn.addEventListener('click', toggleNotes)
  fullBtn.addEventListener('click', toggleFull)
  if (!document.documentElement.requestFullscreen) fullBtn.hidden = true

  // Click the slide to move: the left third goes back, the rest goes forward. Links keep working.
  viewport.addEventListener('click', function (e) {
    if (e.target.closest && e.target.closest('a')) return
    show(e.clientX < viewport.clientWidth / 3 ? at - 1 : at + 1)
  })

  document.addEventListener('keydown', function (e) {
    if (e.altKey || e.ctrlKey || e.metaKey) return
    var onButton = e.target && e.target.tagName === 'BUTTON'
    switch (e.key) {
      case 'ArrowRight': case 'PageDown': show(at + 1); break
      case 'ArrowLeft': case 'PageUp': show(at - 1); break
      case ' ': if (onButton) return; show(at + (e.shiftKey ? -1 : 1)); break
      case 'Home': show(0); break
      case 'End': show(slides.length - 1); break
      case 'n': case 'N': toggleNotes(); break
      case 'f': case 'F': toggleFull(); break
      default: return
    }
    e.preventDefault()
  })

  var x0 = null
  viewport.addEventListener('touchstart', function (e) { x0 = e.touches.length === 1 ? e.touches[0].clientX : null }, { passive: true })
  viewport.addEventListener('touchend', function (e) {
    if (x0 === null) return
    var dx = e.changedTouches[0].clientX - x0
    x0 = null
    if (Math.abs(dx) > 40) show(at + (dx < 0 ? 1 : -1))
  }, { passive: true })

  window.addEventListener('hashchange', function () { show(fromHash(), true) })
  window.addEventListener('resize', fit)
  fit()
  show(fromHash(), true)
})()
