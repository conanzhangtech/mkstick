// A "buy me a coffee" button that opens Ko-fi in a popup on the same page.
// Nothing from Ko-fi is loaded until someone presses the button. Any link to ko-fi.com on the
// page opens the popup too, and still works as an ordinary link if this script does not run.
;(function () {
  var me = document.currentScript
  var handle = (me && me.dataset.handle) || ''
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(handle)) return
  var label = (me && me.dataset.text) || 'Buy me a coffee'
  var page = 'https://ko-fi.com/' + handle
  var dialog = null

  function open() {
    if (!dialog) {
      dialog = document.createElement('dialog')
      dialog.className = 'kofi-dialog'
      dialog.setAttribute('aria-label', 'Support on Ko-fi')
      var close = document.createElement('button')
      close.type = 'button'
      close.className = 'kofi-close'
      close.setAttribute('aria-label', 'Close')
      close.textContent = '×'
      close.addEventListener('click', function () { dialog.close() })
      var frame = document.createElement('iframe')
      frame.title = 'Support on Ko-fi'
      frame.className = 'kofi-frame'
      frame.referrerPolicy = 'strict-origin'
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox')
      frame.src = page + '/?hidefeed=true&widget=true&embed=true'
      var out = document.createElement('a')
      out.className = 'kofi-out'
      out.href = page
      out.target = '_blank'
      out.rel = 'noopener noreferrer'
      out.textContent = 'Open on Ko-fi instead'
      dialog.append(close, frame, out)
      dialog.addEventListener('click', function (e) { if (e.target === dialog) dialog.close() })
      document.body.append(dialog)
    }
    if (typeof dialog.showModal === 'function') dialog.showModal()
    else window.open(page, '_blank', 'noopener')
  }

  var fab = document.createElement('a')
  fab.className = 'kofi-fab'
  fab.href = page
  fab.textContent = label
  document.body.append(fab)

  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href]')
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    if (a.href.replace(/\/$/, '') !== page || a.classList.contains('kofi-out')) return
    e.preventDefault()
    open()
  })
})()
