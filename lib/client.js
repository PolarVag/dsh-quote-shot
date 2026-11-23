window.__ModuleLoader__.load({
  id: 'dsh-quote-shot',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    function normalizeText(text) {
      return String(text == null ? '' : text).replace(/\r\n?/g, '\n').replace(/\n+$/, '')
    }

    function formatSourceLabel(source) {
      if (!source) return ''
      if (source.kind === 'chat') {
        return source.turn != null ? '对话第 ' + source.turn + ' 轮' : '当前对话'
      }
      var path = source.path || ''
      if (source.startLine != null && source.endLine != null) {
        return source.startLine === source.endLine
          ? path + ':' + source.startLine
          : path + ':' + source.startLine + '-' + source.endLine
      }
      if (source.startLine != null) return path + ':' + source.startLine
      return path
    }

    function longestBacktickRun(text) {
      var longest = 0
      var current = 0
      for (var i = 0; i < text.length; i += 1) {
        if (text[i] === '`') {
          current += 1
          if (current > longest) longest = current
        } else {
          current = 0
        }
      }
      return longest
    }

    function quotePlain(body) {
      return body
        .split('\n')
        .map(function (line) { return line ? '> ' + line : '>' })
        .join('\n')
    }

    function quoteCode(body, language) {
      var fence = '`'.repeat(Math.max(3, longestBacktickRun(body) + 1))
      return fence + (language || '') + '\n' + body + '\n' + fence
    }

    function formatQuote(options) {
      var opts = options || {}
      // Default cap keeps arbitrarily long selections out of the composer.
      // An explicit 0 is a valid limit (empty body plus the marker).
      var limit = opts.maxChars == null ? 12000 : opts.maxChars
      var text = normalizeText(opts.text)
      var truncated = false
      if (typeof limit === 'number' && limit >= 0 && text.length > limit) {
        text = text.slice(0, limit)
        truncated = true
      }

      var source = opts.source
      var language = source && typeof source.language === 'string' ? source.language.trim() : ''
      var label = formatSourceLabel(source)
      var output

      if (language) {
        output = (label ? '来源：' + label + '\n\n' : '') + quoteCode(text, language)
      } else if (source) {
        output = '> 来源：' + label + '\n>\n' + quotePlain(text)
      } else {
        output = quotePlain(text)
      }

      if (truncated) output += '\n\n（已截断）'
      return output
    }

    function placeMenu(options) {
      var opts = options || {}
      var point = opts.point || { x: 0, y: 0 }
      var menu = opts.menu || { width: 0, height: 0 }
      var viewport = opts.viewport || { width: 0, height: 0 }
      var margin = opts.margin == null ? 8 : opts.margin
      var offset = 2

      var left = point.x + offset
      var top = point.y + offset
      if (left + menu.width > viewport.width - margin) left = viewport.width - menu.width - margin
      if (top + menu.height > viewport.height - margin) top = viewport.height - menu.height - margin

      return { left: left, top: top }
    }

    function positiveInteger(value) {
      if (typeof value !== 'number' || !isFinite(value)) return undefined
      if (value < 1 || Math.floor(value) !== value) return undefined
      return value
    }

    function sourceFromPreview(options) {
      var opts = options || {}
      if (typeof opts.address !== 'string') return undefined
      var match = /^dsh-resource:\/\/file\/session\/[^/]+\/(.+)$/.exec(opts.address)
      if (!match) return undefined

      var path
      try {
        path = decodeURIComponent(match[1])
      } catch (error) {
        return undefined
      }
      if (!path) return undefined

      var source = { kind: 'file', path: path }
      var startLine = positiveInteger(opts.startLine)
      var endLine = positiveInteger(opts.endLine)
      if (startLine != null) source.startLine = startLine
      if (endLine != null) source.endLine = endLine
      if (typeof opts.language === 'string' && opts.language.trim()) {
        source.language = opts.language.trim()
      }
      return source
    }

    function sourceFromChat(options) {
      var opts = options || {}
      var turn = positiveInteger(opts.turn)
      if (turn != null) return { kind: 'chat', turn: turn }
      if (typeof opts.anchorKey === 'string' && opts.anchorKey.trim()) {
        return { kind: 'chat', anchorKey: opts.anchorKey.trim() }
      }
      return undefined
    }

    // ------------------------------------------------------------------
    // Session bridge: the camera button is mounted by the conversation
    // input bar, which owns the only reliable handle on the composer.
    // ------------------------------------------------------------------
    var activeComposer = null
    var pluginContext = null
    var lastSelection = null
    var pendingQuote = null
    var pendingQuoteAt = 0
    var menuElement = null
    var toastElement = null
    var toastTimer = null

    function elementOf(node) {
      if (!node) return null
      if (node.nodeType === 1) return node
      return node.parentElement || null
    }

    function closestOf(node, selector) {
      var element = elementOf(node)
      if (!element || typeof element.closest !== 'function') return null
      return element.closest(selector)
    }

    function isEditableOrComposer(node) {
      var element = elementOf(node)
      if (!element || typeof element.closest !== 'function') return false
      if (element.closest('input, textarea, [data-conversation-region="composer"]')) return true
      var editable = element.closest('[contenteditable]')
      if (!editable) return false
      var value = editable.getAttribute('contenteditable')
      return value !== 'false'
    }

    function resolveScope(node) {
      var element = elementOf(node)
      if (!element || typeof element.closest !== 'function') return null
      var preview = element.closest('[data-textpreview-state="text"]')
      if (preview) return { kind: 'preview', root: preview }
      var chat = element.closest('[data-slot="conversation.chat.flow"]')
      if (chat) return { kind: 'chat', root: chat }
      return null
    }

    function detectLanguage(node, scopeKind) {
      var element = elementOf(node)
      if (!element || typeof element.closest !== 'function') return undefined
      // Plain text previews also live inside a <pre>; they are not code.
      if (scopeKind === 'preview' && element.closest('[data-textpreview-plain], pre[data-textpreview-page]')) {
        return undefined
      }
      var code = element.closest('code[class*="language-"]')
      if (code) {
        var className = String(code.className || '')
        var match = /(?:^|\s)language-([^\s]+)/.exec(className)
        if (match) return match[1]
      }
      // Task 1 ruling: a selection inside a code renderer without a
      // language class is still fenced, using the neutral `text` info string.
      if (element.closest('pre, code')) return 'text'
      return undefined
    }

    function lineElementsInRange(root, range) {
      var selected = []
      var all = root.querySelectorAll('[data-textpreview-line]')
      for (var i = 0; i < all.length; i += 1) {
        if (range.intersectsNode(all[i])) selected.push(all[i])
      }
      return selected
    }

    function lineNumbers(elements) {
      var numbers = []
      for (var i = 0; i < elements.length; i += 1) {
        var value = Number(elements[i].getAttribute('data-textpreview-line'))
        if (isFinite(value) && value >= 1) numbers.push(Math.floor(value))
      }
      if (!numbers.length) return {}
      return {
        startLine: Math.min.apply(Math, numbers),
        endLine: Math.max.apply(Math, numbers),
      }
    }

    function previewSource(scope, range) {
      var root = scope.root
      var address = root.getAttribute('data-textpreview-url')
      if (!address) {
        var addressNode = root.querySelector('[data-textpreview-url]')
        if (addressNode) address = addressNode.getAttribute('data-textpreview-url')
      }

      var lines = lineElementsInRange(root, range)
      if (!lines.length) {
        var startLine = closestOf(range.startContainer, '[data-textpreview-line]')
        var endLine = closestOf(range.endContainer, '[data-textpreview-line]')
        if (startLine) lines.push(startLine)
        if (endLine && endLine !== startLine) lines.push(endLine)
      }
      var numbers = lineNumbers(lines)
      var language = detectLanguage(range.startContainer, 'preview')

      var source
      if (address) {
        source = sourceFromPreview({
          address: address,
          startLine: numbers.startLine,
          endLine: numbers.endLine,
          language: language,
        })
      }
      if (!source) {
        var pathNode = root.querySelector('[data-textpreview-path]')
        var path = pathNode ? String(pathNode.textContent || '').trim() : ''
        if (!path) return undefined
        source = { kind: 'file', path: path }
        if (numbers.startLine != null) source.startLine = numbers.startLine
        if (numbers.endLine != null) source.endLine = numbers.endLine
        if (language) source.language = language
      }
      return source
    }

    function chatSource(range) {
      var start = elementOf(range.startContainer)
      var end = elementOf(range.endContainer)
      var turnNode = null
      var anchorNode = null
      if (start && typeof start.closest === 'function') {
        turnNode = start.closest('[data-chat-turn]')
        anchorNode = start.closest('[data-chat-anchor-key]')
      }
      if (!turnNode && end && typeof end.closest === 'function') {
        turnNode = end.closest('[data-chat-turn]')
      }
      if (!anchorNode && end && typeof end.closest === 'function') {
        anchorNode = end.closest('[data-chat-anchor-key]')
      }

      var turn
      if (turnNode) {
        var rawTurn = turnNode.getAttribute('data-chat-turn')
        if (rawTurn != null && rawTurn !== '' && isFinite(Number(rawTurn))) turn = Number(rawTurn)
      }
      var anchorKey = anchorNode ? anchorNode.getAttribute('data-chat-anchor-key') : undefined
      return sourceFromChat({ turn: turn, anchorKey: anchorKey })
    }

    function readLiveSelection() {
      if (typeof window === 'undefined' || typeof window.getSelection !== 'function') return null
      var selection = window.getSelection()
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null
      var text = String(selection.toString())
      if (!text.trim()) return null

      var range
      try {
        range = selection.getRangeAt(0).cloneRange()
      } catch (error) {
        return null
      }
      if (isEditableOrComposer(range.startContainer) || isEditableOrComposer(range.endContainer)) return null

      var scope = resolveScope(range.startContainer) || resolveScope(range.endContainer)
      if (!scope) return null

      var source = scope.kind === 'preview' ? previewSource(scope, range) : chatSource(range)
      return {
        text: text,
        source: source,
        range: range,
        scope: scope.kind,
      }
    }

    function rememberSelection() {
      var snapshot = readLiveSelection()
      if (snapshot) lastSelection = snapshot
    }

    function insertSnapshot(snapshot) {
      if (!snapshot) return false
      if (!activeComposer || !activeComposer.inputActions) {
        showToast('输入框尚未连接')
        return false
      }

      var actions = activeComposer.inputActions
      var span
      try {
        span = actions.captureInsertion()
      } catch (error) {
        showToast('输入框正忙，请稍后重试')
        return false
      }
      if (span == null || span === false) {
        showToast('输入框正忙，请稍后重试')
        return false
      }

      var text = formatQuote({ text: snapshot.text, source: snapshot.source }) + '\n'
      var inserted
      try {
        inserted = actions.insertText(text, span)
      } catch (error) {
        inserted = false
      }
      if (inserted === false) {
        showToast('输入框正忙，请稍后重试')
        return false
      }
      return true
    }

    function insertLastSelection() {
      return insertSnapshot(lastSelection)
    }

    function showToast(message) {
      if (typeof document === 'undefined' || !document.body) return
      if (toastElement && toastElement.parentNode) toastElement.parentNode.removeChild(toastElement)
      var element = document.createElement('div')
      element.setAttribute('role', 'status')
      element.textContent = message
      element.style.position = 'fixed'
      element.style.left = '50%'
      element.style.bottom = '72px'
      element.style.transform = 'translateX(-50%)'
      element.style.padding = '8px 14px'
      element.style.borderRadius = '8px'
      element.style.background = 'rgba(20, 20, 24, 0.92)'
      element.style.color = '#fff'
      element.style.fontSize = '13px'
      element.style.zIndex = '2147483000'
      element.style.pointerEvents = 'none'
      document.body.appendChild(element)
      toastElement = element
      if (toastTimer) clearTimeout(toastTimer)
      toastTimer = setTimeout(function () {
        if (element.parentNode) element.parentNode.removeChild(element)
        if (toastElement === element) toastElement = null
      }, 2200)
    }

    function startCapture() {
      // Task 6 replaces this with the host capture flow.
      showToast('截图功能尚未连接')
    }

    function closeMenu() {
      if (menuElement && menuElement.parentNode) menuElement.parentNode.removeChild(menuElement)
      menuElement = null
    }

    function menuPoint(point) {
      if (point && (point.x !== 0 || point.y !== 0)) return point
      if (lastSelection && lastSelection.range) {
        try {
          var rect = lastSelection.range.getBoundingClientRect()
          return { x: rect.right, y: rect.bottom }
        } catch (error) {}
      }
      return point || { x: 0, y: 0 }
    }

    function openMenu(point, snapshot) {
      closeMenu()
      if (typeof document === 'undefined' || !document.body) return
      var menu = document.createElement('div')
      menu.setAttribute('role', 'menu')
      menu.setAttribute('aria-label', '引用选区')
      menu.style.position = 'fixed'
      menu.style.zIndex = '2147483001'
      menu.style.minWidth = '196px'
      menu.style.padding = '4px'
      menu.style.background = 'var(--dsh-menu-background, #202024)'
      menu.style.color = 'var(--dsh-menu-foreground, #f5f5f5)'
      menu.style.border = '1px solid rgba(127, 127, 127, 0.35)'
      menu.style.borderRadius = '8px'
      menu.style.boxShadow = '0 8px 28px rgba(0, 0, 0, 0.3)'

      var item = document.createElement('button')
      item.type = 'button'
      item.setAttribute('role', 'menuitem')
      item.style.display = 'flex'
      item.style.alignItems = 'center'
      item.style.justifyContent = 'space-between'
      item.style.gap = '18px'
      item.style.width = '100%'
      item.style.padding = '7px 10px'
      item.style.border = '0'
      item.style.borderRadius = '5px'
      item.style.background = 'transparent'
      item.style.color = 'inherit'
      item.style.font = 'inherit'
      item.style.cursor = 'pointer'

      var label = document.createElement('span')
      label.textContent = '向DSH提问'
      var keycap = document.createElement('span')
      keycap.textContent = 'Ctrl+Alt+Q'
      keycap.style.opacity = '0.6'
      keycap.style.fontSize = '11px'
      item.appendChild(label)
      item.appendChild(keycap)

      item.addEventListener('mousedown', function (event) {
        event.preventDefault()
      })
      item.addEventListener('click', function (event) {
        event.preventDefault()
        event.stopPropagation()
        var inserted = insertSnapshot(snapshot)
        closeMenu()
        if (!inserted) return
      })
      menu.appendChild(item)

      menu.style.visibility = 'hidden'
      menu.style.left = '0px'
      menu.style.top = '0px'
      document.body.appendChild(menu)
      var rect = menu.getBoundingClientRect()
      var position = placeMenu({
        point: menuPoint(point),
        menu: { width: rect.width, height: rect.height },
        viewport: {
          width: window.innerWidth || document.documentElement.clientWidth || 0,
          height: window.innerHeight || document.documentElement.clientHeight || 0,
        },
      })
      menu.style.left = position.left + 'px'
      menu.style.top = position.top + 'px'
      menu.style.visibility = 'visible'
      menuElement = menu
    }

    function onMouseDown(event) {
      if (event.button !== 2) return
      if (isEditableOrComposer(event.target)) return
      var snapshot = readLiveSelection()
      if (!snapshot) return
      // Best effort against the Electron native Copy menu: it only appears
      // when the main process sees a non-empty selectionText. Clearing the
      // live selection before `contextmenu` runs should make it empty, while
      // the quote snapshot stays in memory. This needs desktop verification;
      // the renderer cannot prevent the native popup by itself.
      pendingQuote = snapshot
      pendingQuoteAt = Date.now()
      try {
        var selection = window.getSelection()
        if (selection && typeof selection.removeAllRanges === 'function') selection.removeAllRanges()
      } catch (error) {}
    }

    function onContextMenu(event) {
      var button = event.button
      if (button != null && button !== 0 && button !== 2) return
      if (isEditableOrComposer(event.target)) return

      var snapshot = null
      if (pendingQuote && Date.now() - pendingQuoteAt < 1500) snapshot = pendingQuote
      pendingQuote = null
      if (!snapshot) snapshot = readLiveSelection()
      if (!snapshot) return
      if (!resolveScope(event.target)) return

      event.preventDefault()
      event.stopPropagation()
      openMenu({ x: event.clientX || 0, y: event.clientY || 0 }, snapshot)
    }

    function installDocumentListeners() {
      if (typeof document === 'undefined') return function () {}
      function onEscape(event) {
        if (event.key === 'Escape') closeMenu()
      }
      function onOutsideMouseDown(event) {
        if (menuElement && !menuElement.contains(event.target)) closeMenu()
      }
      function onScroll() {
        closeMenu()
      }
      function onBlur() {
        closeMenu()
      }

      document.addEventListener('pointerup', rememberSelection, true)
      document.addEventListener('keyup', rememberSelection, true)
      document.addEventListener('selectionchange', rememberSelection, true)
      document.addEventListener('mousedown', onMouseDown, true)
      document.addEventListener('contextmenu', onContextMenu, true)
      document.addEventListener('mousedown', onOutsideMouseDown, false)
      document.addEventListener('keydown', onEscape, true)
      document.addEventListener('scroll', onScroll, true)
      window.addEventListener('blur', onBlur)

      return function cleanup() {
        document.removeEventListener('pointerup', rememberSelection, true)
        document.removeEventListener('keyup', rememberSelection, true)
        document.removeEventListener('selectionchange', rememberSelection, true)
        document.removeEventListener('mousedown', onMouseDown, true)
        document.removeEventListener('contextmenu', onContextMenu, true)
        document.removeEventListener('mousedown', onOutsideMouseDown, false)
        document.removeEventListener('keydown', onEscape, true)
        document.removeEventListener('scroll', onScroll, true)
        window.removeEventListener('blur', onBlur)
        closeMenu()
      }
    }

    function CameraButton(props) {
      // React is provided by DSH; requiring it lazily keeps the pure helpers
      // usable in tests and in non-React contexts.
      var React = require('react')
      var sessionId = props.sessionId != null ? props.sessionId : (props.session && props.session.id)
      var composer = {
        // Task 6 needs plugin services (sessions/drafts) alongside the composer.
        ctx: pluginContext,
        inputActions: props.inputActions || null,
        sessionId: sessionId == null ? null : sessionId,
      }
      activeComposer = composer

      React.useEffect(function () {
        activeComposer = composer
        return function () {
          // Do not clobber a newer composer mounted by another session.
          if (activeComposer === composer) activeComposer = null
        }
      }, [props.inputActions, sessionId])

      return React.createElement(
        'button',
        {
          type: 'button',
          'aria-label': '截图',
          title: '截图 (Ctrl+Alt+Z)',
          onClick: function () { startCapture() },
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '28px',
            height: '28px',
            padding: '0',
            border: '0',
            borderRadius: '6px',
            background: 'transparent',
            color: 'inherit',
            cursor: 'pointer',
          },
        },
        React.createElement(
          'svg',
          {
            width: 16,
            height: 16,
            viewBox: '0 0 16 16',
            'aria-hidden': 'true',
          },
          React.createElement('rect', {
            x: 1.5,
            y: 3,
            width: 13,
            height: 10,
            rx: 2,
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.2,
          }),
          React.createElement('circle', {
            cx: 8,
            cy: 8,
            r: 3,
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.2,
          }),
        ),
      )
    }

    function registerShortcut(shortcuts) {
      try {
        return shortcuts.register({
          id: 'quote-shot.quote',
          label: function () { return '引用选区向 DSH 提问' },
          aliases: ['quote', '向DSH提问'],
          defaults: {
            'desktop:windows': { code: 'KeyQ', modifiers: ['primary', 'alt'] },
          },
          regions: ['page', 'editable'],
          modals: [],
          resolve: function () {
            if (!lastSelection || !lastSelection.scope) return { status: 'pass' }
            if (!activeComposer || !activeComposer.inputActions) return { status: 'pass' }
            return { status: 'handled', run: insertLastSelection }
          },
        })
      } catch (error) {
        console.warn('[dsh-quote-shot] could not register quote shortcut', error)
        return undefined
      }
    }

    function apply(ctx) {
      if (!ctx || typeof ctx.get !== 'function') return

      pluginContext = ctx
      var slots = ctx.get('slots')
      var shortcuts = ctx.get('shortcuts')

      if (slots && typeof slots.inject === 'function') {
        slots.inject('conversation.input.right', function () {
          return slots.register({
            name: 'conversation.input.right',
            id: 'quote-shot.camera',
            order: 20,
          }, CameraButton)
        })
      }

      if (typeof ctx.effect === 'function') {
        if (shortcuts) ctx.effect(function () { return registerShortcut(shortcuts) }, 'quote-shot: quote shortcut')
        ctx.effect(installDocumentListeners, 'quote-shot: document listeners')
      } else {
        if (shortcuts) registerShortcut(shortcuts)
        installDocumentListeners()
      }
    }

    exports.inject = ['slots', 'shortcuts', 'sessions']
    exports.apply = apply
    exports.__internals = {
      formatQuote: formatQuote,
      formatSourceLabel: formatSourceLabel,
      placeMenu: placeMenu,
      sourceFromPreview: sourceFromPreview,
      sourceFromChat: sourceFromChat,
    }
    return module.exports
  },
})
