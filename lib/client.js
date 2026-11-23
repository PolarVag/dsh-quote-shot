window.__ModuleLoader__.load({
  id: 'dsh-quote-shot',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    function normalizeText(text) {
      return String(text == null ? '' : text).replace(/\r\n?/g, '\n').replace(/\n+$/, '')
    }

    function relativizeToCwd(path, cwd) {
      if (!cwd) return path
      var root = String(cwd).replace(/[/\\]+$/, '')
      var text = String(path)
      if (text.startsWith(root + '/') || text.startsWith(root + '\\')) {
        return text.slice(root.length + 1).replace(/\\/g, '/')
      }
      return text.replace(/\\/g, '/')
    }

    function formatFileMention(path) {
      var text = String(path == null ? '' : path)
      if (!text) return ''
      if (/[\u0000-\u001f\u007f-\u009f"]/u.test(text)) return text
      if (!/\s/u.test(text)) return '@' + text
      return '@"' + text + '"'
    }

    function workspaceRootForComposer(composer) {
      if (!composer || !composer.ctx) return undefined
      var ctx = composer.ctx
      var sessions
      try {
        sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : ctx.sessions
      } catch (error) {
        sessions = null
      }
      if (!sessions || !sessions.list || typeof sessions.list.getSnapshot !== 'function') return undefined
      var sessionId = normalizeSessionId(composer.sessionId)
      if (!sessionId) return undefined
      try {
        var snapshot = sessions.list.getSnapshot()
        var record = snapshot && snapshot.byId ? snapshot.byId[sessionId] : null
        return record && typeof record.cwd === 'string' && record.cwd ? record.cwd : undefined
      } catch (error) {
        return undefined
      }
    }

    function formatSourceLabel(source) {
      if (!source) return ''
      if (source.kind === 'chat') {
        var chatLabel = source.turn != null ? '对话第 ' + source.turn + ' 轮' : '当前对话'
        if (typeof source.language === 'string' && source.language.trim()) {
          return chatLabel + ' · 代码块（' + source.language.trim() + '）'
        }
        return chatLabel
      }
      var path = source.path || ''
      var displayPath = relativizeToCwd(path, source.workspaceRoot)
      var label = formatFileMention(displayPath)
      if (source.startLine != null && source.endLine != null) {
        return source.startLine === source.endLine
          ? label + '（第 ' + source.startLine + ' 行）'
          : label + '（第 ' + source.startLine + '–' + source.endLine + ' 行）'
      }
      if (source.startLine != null) return label + '（第 ' + source.startLine + ' 行）'
      return label
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
      // A visible terminator separates the quoted passage from the user's
      // question. It is ordinary plain text, so it survives insertion into
      // the Lexical composer and remains editable.
      output += '\n\n【引用结束】'
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
      if (left < margin) left = margin
      if (top < margin) top = margin

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
      // Spec 4.4: a line range is meaningful only as a pair. A lone
      // endpoint is dropped rather than producing an ambiguous label.
      if (startLine != null && endLine != null) {
        source.startLine = startLine
        source.endLine = endLine
      }
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
    // Screenshot context helpers (pure: shared by the browser flow and tests)
    // ------------------------------------------------------------------
    var CAPTURE_STRING_LIMIT = 1000

    function finiteNumber(value) {
      return typeof value === 'number' && isFinite(value) ? value : undefined
    }

    function positiveNumber(value) {
      var number = finiteNumber(value)
      return number != null && number > 0 ? number : undefined
    }

    function boundedString(value) {
      if (typeof value !== 'string') return undefined
      // Paths/anchors are identifiers, not free-form text: trailing
      // whitespace is never meaningful and whitespace-only values are junk.
      var text = value.replace(/\s+$/, '')
      if (!text.trim()) return undefined
      return text.slice(0, CAPTURE_STRING_LIMIT)
    }

    function captureWindowRect(windowRect) {
      var rect = windowRect && typeof windowRect === 'object' ? windowRect : {}
      var x = finiteNumber(rect.x)
      var y = finiteNumber(rect.y)
      var width = positiveNumber(rect.width)
      var height = positiveNumber(rect.height)
      // The host requires all four fields. A window with no positive size
      // cannot be located reliably, so send 0 for those axes.
      return {
        x: x == null ? 0 : x,
        y: y == null ? 0 : y,
        width: width == null ? 0 : width,
        height: height == null ? 0 : height,
      }
    }

    function captureRect(value) {
      if (!value || typeof value !== 'object') return undefined
      var x = finiteNumber(value.x)
      var y = finiteNumber(value.y)
      var width = positiveNumber(value.width)
      var height = positiveNumber(value.height)
      if (x == null || y == null || width == null || height == null) return undefined
      return { x: x, y: y, width: width, height: height }
    }

    function captureContentOffset() {
      if (typeof window === 'undefined') return { x: 0, y: 0 }
      var outerWidth = positiveNumber(window.outerWidth)
      var innerWidth = positiveNumber(window.innerWidth)
      var outerHeight = positiveNumber(window.outerHeight)
      var innerHeight = positiveNumber(window.innerHeight)
      var offsetX = outerWidth != null && innerWidth != null ? (outerWidth - innerWidth) / 2 : 0
      var offsetY = outerHeight != null && innerHeight != null ? outerHeight - innerHeight : 0
      return {
        x: offsetX > 0 ? offsetX : 0,
        y: offsetY > 0 ? offsetY : 0,
      }
    }

    function elementScreenRect(element) {
      if (!element || typeof element.getBoundingClientRect !== 'function') return undefined
      var box
      try {
        box = element.getBoundingClientRect()
      } catch (error) {
        return undefined
      }
      if (!box) return undefined
      var width = positiveNumber(box.width)
      var height = positiveNumber(box.height)
      var left = finiteNumber(box.left)
      var top = finiteNumber(box.top)
      if (width == null || height == null || left == null || top == null) return undefined

      var view = typeof window !== 'undefined' ? window : {}
      var screenX = finiteNumber(view.screenX)
      if (screenX == null) screenX = finiteNumber(view.screenLeft)
      var screenY = finiteNumber(view.screenY)
      if (screenY == null) screenY = finiteNumber(view.screenTop)
      if (screenX == null || screenY == null) return undefined
      var offset = captureContentOffset()
      return {
        x: screenX + offset.x + left,
        y: screenY + offset.y + top,
        width: width,
        height: height,
      }
    }

    function captureActiveFile(activeFile) {
      if (!activeFile || typeof activeFile !== 'object') return undefined
      var out = {}
      var path = boundedString(activeFile.path)
      if (path) out.path = path
      var startLine = positiveInteger(activeFile.startLine)
      if (startLine != null) out.startLine = startLine
      var endLine = positiveInteger(activeFile.endLine)
      if (endLine != null) out.endLine = endLine
      var language = boundedString(activeFile.language)
      if (language) out.language = language
      var rect = captureRect(activeFile.rect)
      if (rect) out.rect = rect
      return Object.keys(out).length ? out : undefined
    }

    function captureChat(chat) {
      if (!chat || typeof chat !== 'object') return undefined
      var out = {}
      var turn = positiveInteger(chat.turn)
      if (turn != null) out.turn = turn
      var anchorKey = boundedString(chat.anchorKey)
      if (anchorKey) out.anchorKey = anchorKey
      var rect = captureRect(chat.rect)
      if (rect) out.rect = rect
      return Object.keys(out).length ? out : undefined
    }

    function buildCaptureRequest(input) {
      var opts = input || {}
      var dsh = {
        windowRect: captureWindowRect(opts.windowRect),
        scaleFactor: positiveNumber(opts.scaleFactor) || 1,
      }
      var activeFile = captureActiveFile(opts.activeFile)
      if (activeFile) dsh.activeFile = activeFile
      var chat = captureChat(opts.chat)
      if (chat) dsh.chat = chat
      var workspaceRoot = boundedString(opts.workspaceRoot)
      if (workspaceRoot) dsh.workspaceRoot = workspaceRoot
      return { dsh: dsh }
    }

    function parseCaptureResponse(value) {
      var response = value && typeof value === 'object' ? value : null
      var action = response ? response.action : undefined

      if (action === 'ask') {
        if (typeof response.token !== 'string' || !/^[0-9a-fA-F]{32}$/.test(response.token)) {
          throw new Error('unsupported capture action')
        }
        var sourceKind = response.sourceKind
        if (sourceKind !== 'file' && sourceKind !== 'chat') sourceKind = 'none'
        var ask = { action: 'ask', token: response.token, sourceKind: sourceKind }
        var relativePath = boundedString(response.relativePath)
        if (relativePath && /^quote-shot-captures\/[A-Za-z0-9._-]+\.png$/.test(relativePath)) {
          ask.relativePath = relativePath
        }
        var width = positiveNumber(response.width)
        if (width != null) ask.width = width
        var height = positiveNumber(response.height)
        if (height != null) ask.height = height
        if (Array.isArray(response.ocrCandidates)) {
          var candidates = []
          for (var i = 0; i < response.ocrCandidates.length && candidates.length < 5; i += 1) {
            var candidate = response.ocrCandidates[i]
            if (typeof candidate === 'string' && candidate.trim()) {
              candidates.push(candidate.slice(0, CAPTURE_STRING_LIMIT))
            }
          }
          if (candidates.length) ask.ocrCandidates = candidates
        }
        return ask
      }

      if (action === 'save') {
        if (typeof response.path !== 'string') {
          throw new Error('unsupported capture action')
        }
        var savePath = response.path.trim()
        if (!savePath) throw new Error('unsupported capture action')
        return { action: 'save', path: savePath.slice(0, 4096) }
      }

      if (action === 'cancel') return { action: 'cancel' }

      if (action === 'error') {
        if (typeof response.message !== 'string') {
          throw new Error('unsupported capture action')
        }
        var message = response.message.trim()
        if (!message) throw new Error('unsupported capture action')
        return { action: 'error', message: message.slice(0, CAPTURE_STRING_LIMIT) }
      }

      throw new Error('unsupported capture action')
    }

    function padTwo(value) {
      return value < 10 ? '0' + value : String(value)
    }

    function captureFileName(timestamp) {
      var date = timestamp instanceof Date ? timestamp : new Date(timestamp)
      if (!date || isNaN(date.getTime())) date = new Date()
      return (
        'quote-shot-' +
        date.getFullYear() +
        padTwo(date.getMonth() + 1) +
        padTwo(date.getDate()) +
        '-' +
        padTwo(date.getHours()) +
        padTwo(date.getMinutes()) +
        padTwo(date.getSeconds()) +
        '.png'
      )
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
    var selectionOverlay = null
    var toastElement = null
    var toastTimer = null
    var captureState = 'idle'

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

    function languageFromElement(element) {
      if (!element || typeof element.getAttribute !== 'function') return undefined
      var attributes = ['data-language', 'data-lang']
      for (var i = 0; i < attributes.length; i += 1) {
        var value = String(element.getAttribute(attributes[i]) || '').trim()
        if (value) return value
      }
      var className = String(element.className || element.getAttribute('class') || '')
      var match = /(?:^|\s)language-([^\s]+)/.exec(className)
      return match ? match[1] : undefined
    }

    function codeRootOf(node) {
      var element = elementOf(node)
      if (!element || typeof element.closest !== 'function') return null
      // `pre code` is preferred so endpoints inside the same block share a
      // root even when one is in nested markup. A bare `pre` still counts.
      return element.closest('pre code') || element.closest('pre')
    }

    function detectLanguage(node, scopeKind) {
      var element = elementOf(node)
      if (!element || typeof element.closest !== 'function') return undefined
      // Plain text previews also live inside a <pre>; they are not code.
      if (scopeKind === 'preview' && element.closest('[data-textpreview-plain], pre[data-textpreview-page]')) {
        return undefined
      }
      var code = element.closest('pre code') || element.closest('code')
      var pre = element.closest('pre')
      if (!code && !pre) return undefined

      var candidates = []
      if (code) candidates.push(code)
      if (pre && pre !== code) candidates.push(pre)
      // DSH's CodeBlock carries language metadata on the wrapper rather
      // than a `language-*` class, so inspect the nearest labelled ancestor
      // inside the code renderer too.
      var labelled = element.closest('[data-language], [data-lang]')
      if (labelled) candidates.push(labelled)

      for (var i = 0; i < candidates.length; i += 1) {
        var language = languageFromElement(candidates[i])
        if (language) return language
      }
      // Task 1 ruling: a selection inside a code renderer without a
      // language is still fenced, using the neutral `text` info string.
      return 'text'
    }

    function codeLineInfo(range) {
      var startPre = closestOf(range.startContainer, 'pre')
      var endPre = closestOf(range.endContainer, 'pre')
      // Do not guess line numbers when the selection crosses code roots or
      // is outside a code block entirely.
      if (!startPre || startPre !== endPre) return {}

      var root = startPre
      var nodes = []
      var renderedLines = root.querySelectorAll('.line')
      if (renderedLines.length) {
        nodes = Array.prototype.slice.call(renderedLines)
      } else {
        var container = root.querySelector('code') || root
        for (var i = 0; i < container.children.length; i += 1) {
          var child = container.children[i]
          if (String(child.textContent || '').length) nodes.push(child)
        }
      }

      if (!nodes.length) {
        // Bare text inside <pre>: derive line numbers from newlines before
        // each endpoint rather than inventing an index.
        if (typeof document === 'undefined' || typeof document.createRange !== 'function') return {}
        function lineAt(node) {
          try {
            var probe = document.createRange()
            probe.setStart(root, 0)
            probe.setEnd(node, 0)
            return (String(probe.toString()).match(/\n/g) || []).length + 1
          } catch (error) {
            return undefined
          }
        }
        var startFallback = lineAt(range.startContainer)
        var endFallback = lineAt(range.endContainer)
        if (startFallback == null || endFallback == null) return {}
        return {
          startLine: Math.min(startFallback, endFallback),
          endLine: Math.max(startFallback, endFallback),
        }
      }

      function indexOfNode(node) {
        var target = elementOf(node)
        for (var index = 0; index < nodes.length; index += 1) {
          if (nodes[index] === target) return index + 1
          if (target && typeof nodes[index].contains === 'function' && nodes[index].contains(target)) {
            return index + 1
          }
        }
        return undefined
      }

      var start = indexOfNode(range.startContainer)
      var end = indexOfNode(range.endContainer)
      if (start == null || end == null) {
        var selected = []
        for (var lineIndex = 0; lineIndex < nodes.length; lineIndex += 1) {
          try {
            if (range.intersectsNode(nodes[lineIndex])) selected.push(lineIndex + 1)
          } catch (error) {}
        }
        if (!selected.length) return {}
        start = selected[0]
        end = selected[selected.length - 1]
      }
      return { startLine: Math.min(start, end), endLine: Math.max(start, end) }
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
      // Only plain previews emit `[data-textpreview-line]`. CodeBlock uses
      // `pre .line` spans, so fall back to mapping the selected endpoints
      // onto the code block's rendered lines.
      if (numbers.startLine == null) numbers = codeLineInfo(range)
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
        if (numbers.startLine != null && numbers.endLine != null) {
          source.startLine = numbers.startLine
          source.endLine = numbers.endLine
        }
        if (language) source.language = language
      }
      var workspaceRoot = workspaceRootForComposer(activeComposer)
      if (workspaceRoot) source.workspaceRoot = workspaceRoot
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
      var source = sourceFromChat({ turn: turn, anchorKey: anchorKey })
      if (source) {
        // Only fence when both endpoints sit in the same code block. A
        // selection that merely starts in a block and ends outside it stays
        // plain text.
        var startPre = closestOf(range.startContainer, 'pre')
        var endPre = closestOf(range.endContainer, 'pre')
        if (startPre && startPre === endPre) {
          var language = detectLanguage(range.startContainer, 'chat')
          if (language) source.language = language
        }
      }
      return source
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

      // A snapshot must belong to exactly one quoteable region. Reject
      // selections that cross chat/sidebar or one message/block boundary.
      var startScope = resolveScope(range.startContainer)
      var endScope = resolveScope(range.endContainer)
      if (!startScope || !endScope) return null
      if (startScope.kind !== endScope.kind || startScope.root !== endScope.root) return null
      var scope = startScope

      var source = scope.kind === 'preview' ? previewSource(scope, range) : chatSource(range)
      return {
        text: text,
        source: source,
        range: range,
        scope: scope.kind,
        scopeKind: scope.kind,
        scopeRoot: scope.root,
      }
    }

    function rememberSelection() {
      var snapshot = readLiveSelection()
      if (snapshot) lastSelection = snapshot
    }

    function captureInsertionSpan(composer) {
      var target = composer || activeComposer
      if (!target || !target.inputActions) return null
      try {
        var span = target.inputActions.captureInsertion()
        if (span == null || span === false) return null
        return span
      } catch (error) {
        return null
      }
    }

    function insertSnapshot(snapshot, spanOverride) {
      if (!snapshot) return false
      if (!activeComposer || !activeComposer.inputActions) {
        showToast('输入框尚未连接')
        return false
      }

      var actions = activeComposer.inputActions
      // Prefer the caret captured while opening the menu: clicking the menu
      // can blur Lexical and move the draft caret before insertText runs.
      var span = spanOverride || snapshot.insertionSpan
      if (span == null) {
        try {
          span = actions.captureInsertion()
        } catch (error) {
          span = null
        }
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

    function captureSignal(timeoutMs) {
      if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
        return AbortSignal.timeout(timeoutMs)
      }
      if (typeof AbortController !== 'undefined') {
        var controller = new AbortController()
        setTimeout(function () {
          try {
            controller.abort()
          } catch (error) {}
        }, timeoutMs)
        return controller.signal
      }
      return undefined
    }

    function isVisibleElement(element) {
      if (!element || element.nodeType !== 1) return false
      if (typeof element.getClientRects === 'function') {
        var rects = element.getClientRects()
        if (!rects || !rects.length) return false
      }
      if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
        try {
          var style = window.getComputedStyle(element)
          if (!style || style.display === 'none' || style.visibility === 'hidden') return false
        } catch (error) {}
      }
      return true
    }

    function visibleElements(selector) {
      if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return []
      var nodes = document.querySelectorAll(selector)
      var out = []
      for (var i = 0; i < nodes.length; i += 1) {
        if (isVisibleElement(nodes[i])) out.push(nodes[i])
      }
      return out
    }

    function pickActiveElement(elements) {
      if (!elements.length) return null
      var active = typeof document !== 'undefined' ? document.activeElement : null
      for (var i = 0; i < elements.length; i += 1) {
        if (active && (elements[i] === active || (elements[i].contains && elements[i].contains(active)))) {
          return elements[i]
        }
      }
      return elements[0]
    }

    function previewLineRange(root) {
      if (!root || typeof root.querySelectorAll !== 'function') return {}
      var nodes = root.querySelectorAll('[data-textpreview-line]')
      var visible = []
      var i
      for (i = 0; i < nodes.length; i += 1) {
        if (isVisibleElement(nodes[i])) visible.push(nodes[i])
      }
      // If none of the line wrappers report a layout box (e.g. they are
      // virtualised), keep their declared numbers rather than returning none.
      if (!visible.length) {
        for (i = 0; i < nodes.length; i += 1) visible.push(nodes[i])
      }
      return lineNumbers(visible)
    }

    function readActiveFile() {
      if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return undefined
      var roots = visibleElements('[data-textpreview-state="text"]')
      if (!roots.length) roots = visibleElements('[data-textpreview-url]')
      var root = pickActiveElement(roots)
      if (!root) return undefined

      var address = root.getAttribute ? root.getAttribute('data-textpreview-url') : ''
      if (!address) {
        var addressNode = root.querySelector('[data-textpreview-url]')
        if (addressNode) address = addressNode.getAttribute('data-textpreview-url')
      }

      var lines = previewLineRange(root)
      var language = languageFromElement(root)
      if (!language) {
        var languageNode = root.querySelector('[data-language], [data-lang]')
        if (languageNode) language = languageFromElement(languageNode)
      }

      var source
      if (address) {
        source = sourceFromPreview({
          address: address,
          startLine: lines.startLine,
          endLine: lines.endLine,
          language: language,
        })
      }
      if (!source) {
        var pathNode = root.querySelector('[data-textpreview-path]')
        var path = pathNode ? String(pathNode.textContent || '').trim() : ''
        if (!path) return undefined
        source = { kind: 'file', path: path }
        if (lines.startLine != null && lines.endLine != null) {
          source.startLine = lines.startLine
          source.endLine = lines.endLine
        }
        if (language) source.language = language
      }
      var rect = elementScreenRect(root)
      if (rect) source.rect = rect
      var workspaceRoot = workspaceRootForComposer(activeComposer)
      if (workspaceRoot) source.workspaceRoot = workspaceRoot
      return source
    }

    function readChat() {
      if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return undefined
      var nodes = visibleElements('[data-chat-turn]')
      if (!nodes.length) nodes = visibleElements('[data-chat-anchor-key]')
      if (!nodes.length) return undefined

      var node = null
      var active = document.activeElement
      var i
      for (i = 0; i < nodes.length; i += 1) {
        if (active && (nodes[i] === active || (nodes[i].contains && nodes[i].contains(active)))) {
          node = nodes[i]
          break
        }
      }
      if (!node) {
        // Spec 4.6: the nearest turn to the centre of the chat viewport. A
        // side panel shifts the chat area, so use its flow box when present.
        var flowRoots = visibleElements('[data-slot="conversation.chat.flow"]')
        var flow = flowRoots.length ? pickActiveElement(flowRoots) : null
        var centreX = typeof window !== 'undefined' ? (window.innerWidth || 0) / 2 : 0
        var centreY = typeof window !== 'undefined' ? (window.innerHeight || 0) / 2 : 0
        if (flow) {
          try {
            var flowBox = flow.getBoundingClientRect()
            centreX = flowBox.left + flowBox.width / 2
            centreY = flowBox.top + flowBox.height / 2
          } catch (error) {}
        }
        var best = Infinity
        for (i = 0; i < nodes.length; i += 1) {
          var rect
          try {
            rect = nodes[i].getBoundingClientRect()
          } catch (error) {
            continue
          }
          var dx = rect.left + rect.width / 2 - centreX
          var dy = rect.top + rect.height / 2 - centreY
          var distance = dx * dx + dy * dy
          if (distance < best) {
            best = distance
            node = nodes[i]
          }
        }
        if (!node) node = nodes[0]
      }

      var turn
      var rawTurn = node.getAttribute('data-chat-turn')
      if (rawTurn != null && rawTurn !== '' && isFinite(Number(rawTurn))) turn = Number(rawTurn)
      var anchorKey = node.getAttribute('data-chat-anchor-key') || undefined
      var chatSource = sourceFromChat({ turn: turn, anchorKey: anchorKey })
      if (chatSource) {
        var rect = elementScreenRect(node)
        if (rect) chatSource.rect = rect
      }
      return chatSource
    }

    function captureViewportRect() {
      var view = typeof window !== 'undefined' ? window : {}
      var doc = typeof document !== 'undefined' ? document : null
      var docWidth = doc && doc.documentElement ? doc.documentElement.clientWidth : 0
      var docHeight = doc && doc.documentElement ? doc.documentElement.clientHeight : 0

      function firstFinite(candidates) {
        for (var i = 0; i < candidates.length; i += 1) {
          if (finiteNumber(candidates[i]) != null) return candidates[i]
        }
        return 0
      }
      function firstPositive(candidates) {
        for (var i = 0; i < candidates.length; i += 1) {
          if (positiveNumber(candidates[i]) != null) return candidates[i]
        }
        return 0
      }

      return {
        x: firstFinite([view.screenX, view.screenLeft, 0]),
        y: firstFinite([view.screenY, view.screenTop, 0]),
        width: firstPositive([view.outerWidth, view.innerWidth, docWidth]),
        height: firstPositive([view.outerHeight, view.innerHeight, docHeight]),
      }
    }

    function captureScaleFactor() {
      var ratio = typeof window !== 'undefined' ? Number(window.devicePixelRatio) : NaN
      return isFinite(ratio) && ratio > 0 ? ratio : 1
    }

    function collectCaptureContext() {
      var activeFile = readActiveFile()
      var chat = readChat()
      return {
        windowRect: captureViewportRect(),
        scaleFactor: captureScaleFactor(),
        activeFile: activeFile,
        chat: chat,
        workspaceRoot: workspaceRootForComposer(activeComposer),
        // The label source is the best DOM evidence we have; its screen rect
        // lets the host prove the screenshot actually overlaps it.
        source: activeFile || chat,
      }
    }

    function checkCaptureHealth() {
      if (typeof fetch !== 'function') return Promise.resolve(false)
      try {
        return fetch('/quote-shot/api/health', {
          cache: 'no-store',
          signal: captureSignal(2000),
        })
          .then(function (response) {
            if (!response || response.ok !== true) return false
            // A web-only host may answer with the SPA shell: require the
            // plugin's JSON marker when the body is inspectable.
            if (typeof response.json !== 'function') return true
            return response.json().then(function (body) {
              return !!body && body.ok === true
            })
          })
          .catch(function () {
            return false
          })
      } catch (error) {
        return Promise.resolve(false)
      }
    }

    function requestCapture(context) {
      if (typeof fetch !== 'function') return Promise.reject(new Error('capture unavailable'))
      var body
      try {
        body = JSON.stringify(buildCaptureRequest(context))
      } catch (error) {
        return Promise.reject(error)
      }
      try {
        return fetch('/quote-shot/api/capture', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: body,
          signal: captureSignal(120000),
        }).then(function (response) {
          if (!response || typeof response.json !== 'function') throw new Error('capture failed')
          return response.json()
        })
      } catch (error) {
        return Promise.reject(error)
      }
    }

    function discardCapture(token) {
      if (!token || typeof fetch !== 'function') return Promise.resolve()
      try {
        return fetch('/quote-shot/api/discard', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: token }),
        }).catch(function () {
          // Discard is best-effort: a stale temp file is swept later.
        })
      } catch (error) {
        return Promise.resolve()
      }
    }

    function releaseDrafts(conversation, drafts) {
      if (!drafts || !conversation || typeof conversation.releaseDraftAttachments !== 'function') return
      try {
        conversation.releaseDraftAttachments(drafts)
      } catch (error) {}
    }

    function normalizeSessionId(value) {
      if (value == null) return null
      if (typeof value === 'string') return value
      if (typeof value === 'number') return String(value)
      if (typeof value === 'object') return value.id || value.sessionId || null
      return null
    }

    function resolveConversation(ctx, sessionId) {
      if (!ctx) return null
      var direct = null
      try {
        if (typeof ctx.get === 'function') direct = ctx.get('conversation')
        if (!direct) direct = ctx.conversation
      } catch (error) {
        direct = null
      }
      if (direct && typeof direct.createDrafts === 'function') return direct

      var sessions = null
      try {
        if (typeof ctx.get === 'function') sessions = ctx.get('sessions')
        if (!sessions) sessions = ctx.sessions
      } catch (error) {
        sessions = null
      }
      if (!sessions || typeof sessions.scope !== 'function') return null
      var scope = sessions.scope(sessionId)
      if (!scope) return null
      var scoped = null
      try {
        scoped = typeof scope.get === 'function' ? scope.get('conversation') : scope.conversation
      } catch (error) {
        scoped = null
      }
      return scoped && typeof scoped.createDrafts === 'function' ? scoped : null
    }

    function isSameCaptureSession(current, pinned) {
      // CameraButton rebuilds its composer object on every render, so object
      // identity says nothing about whether the user changed sessions.
      return (
        !!current &&
        !!pinned &&
        normalizeSessionId(current.sessionId) === normalizeSessionId(pinned.sessionId)
      )
    }

    function captureSourceLabel(context, parsed) {
      var sourceKind = parsed && parsed.sourceKind ? parsed.sourceKind : 'none'
      if (sourceKind === 'file' && context && context.activeFile) {
        return formatSourceLabel(context.activeFile)
      }
      if (sourceKind === 'chat' && context && context.chat) {
        return formatSourceLabel(context.chat)
      }
      if (sourceKind === 'none' && parsed.ocrCandidates && parsed.ocrCandidates.length) {
        return '自动识别：' + formatFileMention(parsed.ocrCandidates[0])
      }
      return ''
    }

    function insertCaptureSource(context, parsed, composer) {
      var label = captureSourceLabel(context, parsed)
      if (!label) return
      // The capture may outlive the session that started it (or a render may
      // replace the composer object). Keep the image in the pinned
      // conversation, but never write a source line into a different one.
      if (!isSameCaptureSession(activeComposer, composer)) return
      if (!composer || !composer.inputActions) {
        showToast('图片已附加，但来源未能插入')
        return
      }

      var span = captureInsertionSpan(composer)
      var inserted = false
      if (span != null) {
        try {
          inserted = composer.inputActions.insertText('【截图来源】' + label + '\n', span)
        } catch (error) {
          inserted = false
        }
      }
      // The image stays attached: losing the source line is recoverable,
      // discarding the user's screenshot is not.
      if (inserted === false) showToast('图片已附加，但来源未能插入')
    }

    function insertCaptureReference(parsed, context, composer) {
      if (!isSameCaptureSession(activeComposer, composer)) {
        // The PNG is already persisted under the session workspace; do not
        // write a reference into a different conversation.
        showToast('截图已保存，但会话已切换')
        return false
      }
      if (!composer || !composer.inputActions) throw new Error('composer unavailable')
      var label = captureSourceLabel(context, parsed)
      var mention = formatFileMention(parsed.relativePath)

      // Prefer a real DSH file-reference chip over plain text. The public
      // inputActions surface has no reference method, but the conversation
      // service exposes the resident shell that owns insertFileReferences.
      var conversation = resolveConversation(composer.ctx, normalizeSessionId(composer.sessionId))
      var sessions = null
      try {
        sessions = composer.ctx && typeof composer.ctx.get === 'function'
          ? composer.ctx.get('sessions')
          : null
      } catch (error) {
        sessions = null
      }
      var binding = sessions && typeof sessions.binding === 'function'
        ? sessions.binding(normalizeSessionId(composer.sessionId))
        : null
      var shell = binding && conversation && conversation.input && typeof conversation.input.shellFor === 'function'
        ? conversation.input.shellFor(binding)
        : null
      if (shell && typeof shell.addFiles === 'function') {
        var base = String(parsed.relativePath).split(/[\\/]/).pop()
        var added = shell.addFiles([
          { source: 'reference', ref: mention, label: base, appearance: 'file', clipboardText: mention },
        ], [])
        if (added === false) throw new Error('reference rejected')
        if (label) {
          var span = captureInsertionSpan(composer)
          if (span != null) {
            try {
              composer.inputActions.insertText('\n【截图来源】' + label + '\n', span)
            } catch (error) {
              showToast('图片已引用，但来源未能插入')
            }
          }
        }
        return true
      }

      // Older shells may not expose addFiles. Degrade to the same @path text
      // the reference chip serializes, still avoiding a duplicate upload.
      var plainSpan = captureInsertionSpan(composer)
      if (plainSpan == null) throw new Error('composer busy')
      var lines = [mention]
      if (label) lines.push('【截图来源】' + label)
      var inserted = false
      try {
        inserted = composer.inputActions.insertText(lines.join('\n') + '\n', plainSpan)
      } catch (error) {
        inserted = false
      }
      if (inserted === false) throw new Error('insert rejected')
      return true
    }

    function attachCapture(parsed, context, composer) {
      var token = parsed.token
      var conversation = null
      var drafts = null
      var attached = false
      var stage = '读取图片'
      var sessionId = normalizeSessionId(composer && composer.sessionId)

      // A workspace copy is already the durable artifact; reference it by
      // relative path instead of re-uploading the image into the draft rail.
      if (parsed.relativePath) {
        stage = '插入文件引用'
        var inserted
        try {
          inserted = insertCaptureReference(parsed, context, composer)
        } catch (error) {
          inserted = false
        }
        if (!inserted) {
          if (isSameCaptureSession(activeComposer, composer)) {
            showToast('截图附加失败（' + stage + '）')
          }
        } else {
          attached = true
        }
        return Promise.resolve().then(function () {
          return discardCapture(token)
        })
      }

      return fetch('/quote-shot/api/image/' + encodeURIComponent(token), {
        cache: 'no-store',
        signal: captureSignal(15000),
      })
        .then(function (response) {
          if (!response || !response.ok) throw new Error('image fetch failed')
          return response.blob()
        })
        .then(function (blob) {
          if (typeof File !== 'function') throw new Error('File is unavailable')
          var file = new File([blob], captureFileName(new Date()), { type: 'image/png' })

          stage = '会话接口'
          conversation = resolveConversation(composer && composer.ctx, sessionId)
          if (!conversation) throw new Error('conversation unavailable')

          stage = '登记附件'
          drafts = conversation.createDrafts(sessionId, [file])
          if (!drafts || !drafts.length) throw new Error('no drafts created')

          stage = '加入附件'
          var ids = []
          for (var i = 0; i < drafts.length; i += 1) ids.push(drafts[i].id)
          var added = false
          try {
            added = composer.inputActions.addAttachments(ids)
          } catch (error) {
            added = false
          }
          if (added === false) throw new Error('attachment failed')

          attached = true
          // Losing the source line is recoverable; discarding a successful
          // attachment because a cosmetic insert failed is not.
          stage = '插入来源'
          try {
            insertCaptureSource(context, parsed, composer)
          } catch (error) {
            showToast('图片已附加，但来源未能插入')
          }
        })
        .catch(function (error) {
          try {
            if (typeof console !== 'undefined' && console.error) {
              console.error('[quote-shot] screenshot attach failed at ' + stage, error)
            }
          } catch (ignored) {}
          if (!attached) releaseDrafts(conversation, drafts)
          showToast('截图附加失败（' + stage + '）')
        })
        .then(function () {
          // Both success and failure own the token; discard is best effort.
          return discardCapture(token)
        })
    }

    function startCapture() {
      if (captureState !== 'idle') return Promise.resolve()
      var composer = activeComposer
      if (
        !composer ||
        !composer.inputActions ||
        typeof composer.inputActions.addAttachments !== 'function' ||
        !composer.ctx
      ) {
        showToast('请先打开一个会话')
        return Promise.resolve()
      }

      captureState = 'capturing'
      var context
      try {
        context = collectCaptureContext()
      } catch (error) {
        captureState = 'idle'
        showToast('截图失败')
        return Promise.resolve()
      }

      var flow
      try {
        flow = checkCaptureHealth().then(function (available) {
          if (!available) {
            showToast('截图仅桌面端可用')
            return null
          }
          showToast('选择截图区域…')
          return requestCapture(context).then(function (value) {
            var parsed = parseCaptureResponse(value)
            if (parsed.action === 'cancel') return null
            if (parsed.action === 'save') {
              showToast('已保存到 ' + parsed.path)
              return null
            }
            if (parsed.action === 'error') {
              showToast(parsed.message)
              return null
            }
            captureState = 'attaching'
            return attachCapture(parsed, context, composer)
          })
        })
      } catch (error) {
        flow = Promise.reject(error)
      }

      return flow
        .catch(function () {
          showToast('截图失败')
        })
        .then(
          function () { captureState = 'idle' },
          function () { captureState = 'idle' },
        )
    }

    function clearSelectionOverlay() {
      if (selectionOverlay && selectionOverlay.parentNode) {
        selectionOverlay.parentNode.removeChild(selectionOverlay)
      }
      selectionOverlay = null
    }

    function showSelectionOverlay(range) {
      if (typeof document === 'undefined' || !document.body || !range) return
      clearSelectionOverlay()
      var rects = typeof range.getClientRects === 'function' ? range.getClientRects() : null
      if (!rects || !rects.length) return

      var layer = document.createElement('div')
      layer.setAttribute('data-quote-shot-selection', '')
      layer.style.position = 'fixed'
      layer.style.left = '0'
      layer.style.top = '0'
      layer.style.width = '0'
      layer.style.height = '0'
      layer.style.pointerEvents = 'none'
      layer.style.zIndex = '2147482999'

      var count = 0
      for (var i = 0; i < rects.length; i += 1) {
        var rect = rects[i]
        if (!rect || rect.width <= 0 || rect.height <= 0) continue
        var piece = document.createElement('div')
        piece.style.position = 'fixed'
        piece.style.left = rect.left + 'px'
        piece.style.top = rect.top + 'px'
        piece.style.width = rect.width + 'px'
        piece.style.height = rect.height + 'px'
        piece.style.background = 'rgba(59, 130, 246, 0.38)'
        piece.style.borderRadius = '2px'
        piece.style.pointerEvents = 'none'
        layer.appendChild(piece)
        count += 1
      }
      if (!count) return
      document.body.appendChild(layer)
      selectionOverlay = layer
    }

    function closeMenu(keepOverlay) {
      if (menuElement && menuElement.parentNode) menuElement.parentNode.removeChild(menuElement)
      menuElement = null
      if (!keepOverlay) clearSelectionOverlay()
    }

    function menuPoint(point, snapshot) {
      if (point && (point.x !== 0 || point.y !== 0)) return point
      var selected = snapshot || lastSelection
      if (selected && selected.range) {
        try {
          var rect = selected.range.getBoundingClientRect()
          return { x: rect.right, y: rect.bottom }
        } catch (error) {}
      }
      return point || { x: 0, y: 0 }
    }

    function openMenu(point, snapshot) {
      // Keep the selection overlay painted while the menu is open; the native
      // selection itself has already been collapsed to suppress Electron's menu.
      closeMenu(true)
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
        point: menuPoint(point, snapshot),
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

    function scopeMatches(snapshot, scope) {
      return !!(
        snapshot &&
        scope &&
        scope.kind === snapshot.scopeKind &&
        scope.root === snapshot.scopeRoot
      )
    }

    function onMouseDown(event) {
      if (event.button !== 2) return
      if (isEditableOrComposer(event.target)) return
      var snapshot = readLiveSelection()
      if (!snapshot) return
      // Only takeover selections whose scope also contains the right-click
      // target. This keeps normal native menus working elsewhere.
      if (!scopeMatches(snapshot, resolveScope(event.target))) return
      if (!activeComposer || !activeComposer.inputActions) return

      // Best effort against the Electron native Copy menu: it only appears
      // when the main process sees a non-empty selectionText. Clearing the
      // live selection before `contextmenu` runs should make it empty, while
      // the quote snapshot stays in memory. This needs desktop verification;
      // the renderer cannot prevent the native popup by itself.
      closeMenu()
      snapshot.insertionSpan = captureInsertionSpan()
      pendingQuote = snapshot
      pendingQuoteAt = Date.now()
      // Keep the blue highlight visible even though the native selection has
      // to be collapsed so Electron does not open its own context menu.
      showSelectionOverlay(snapshot.range)
      try {
        var selection = window.getSelection()
        if (selection && typeof selection.removeAllRanges === 'function') selection.removeAllRanges()
      } catch (error) {}
    }

    function onContextMenu(event) {
      var button = event.button
      if (button != null && button !== 0 && button !== 2) return
      if (isEditableOrComposer(event.target)) return
      // Without a live composer the quote cannot be inserted. Leave the
      // event untouched so the native menu is not suppressed for nothing.
      if (!activeComposer || !activeComposer.inputActions) return

      var targetScope = resolveScope(event.target)
      var snapshot = null
      if (pendingQuote && Date.now() - pendingQuoteAt < 1500) {
        if (scopeMatches(pendingQuote, targetScope)) snapshot = pendingQuote
      }
      pendingQuote = null
      if (!snapshot) {
        snapshot = readLiveSelection()
        if (snapshot && scopeMatches(snapshot, targetScope)) {
          // Keyboard invocation has no right-button mousedown; capture the
          // caret now, before the menu item can steal focus.
          snapshot.insertionSpan = captureInsertionSpan()
        } else {
          snapshot = null
        }
      }
      if (!snapshot) {
        clearSelectionOverlay()
        return
      }

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
      var sessionId = normalizeSessionId(
        props.sessionId != null ? props.sessionId : (props.session && props.session.id)
      )
      var composer = {
        // Task 6 needs plugin services (sessions/drafts) alongside the composer.
        ctx: pluginContext,
        inputActions: props.inputActions || null,
        sessionId: sessionId,
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
            if (!activeComposer || !activeComposer.inputActions) return { status: 'pass' }

            // Prefer the live selection so a stale remembered quote cannot
            // override what the user is looking at right now.
            var chosen = readLiveSelection()
            if (!chosen) {
              if (typeof document !== 'undefined' && isEditableOrComposer(document.activeElement)) {
                return { status: 'pass' }
              }
              if (!lastSelection || !lastSelection.scopeKind) return { status: 'pass' }
              chosen = lastSelection
            }

            return {
              status: 'handled',
              run: function () { insertSnapshot(chosen) },
            }
          },
        })
      } catch (error) {
        console.warn('[dsh-quote-shot] could not register quote shortcut', error)
        return undefined
      }
    }

    function registerCaptureShortcut(shortcuts) {
      if (!shortcuts || typeof shortcuts.register !== 'function') return undefined
      try {
        return shortcuts.register({
          id: 'quote-shot.capture',
          label: function () { return '截图并附加到对话' },
          aliases: ['screenshot', '截图'],
          defaults: {
            'desktop:windows': { code: 'KeyZ', modifiers: ['primary', 'alt'] },
          },
          regions: ['page', 'editable'],
          modals: [],
          resolve: function () {
            return { status: 'handled', run: startCapture }
          },
        })
      } catch (error) {
        // A conflict with another plugin's Ctrl+Alt+Z must not break apply().
        console.warn('[dsh-quote-shot] could not register capture shortcut', error)
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
        if (shortcuts) ctx.effect(function () { return registerCaptureShortcut(shortcuts) }, 'quote-shot: capture shortcut')
        ctx.effect(installDocumentListeners, 'quote-shot: document listeners')
      } else {
        if (shortcuts) registerShortcut(shortcuts)
        if (shortcuts) registerCaptureShortcut(shortcuts)
        installDocumentListeners()
      }
    }

    exports.inject = ['slots', 'shortcuts', 'sessions', 'conversation']
    exports.apply = apply
    exports.__internals = {
      formatQuote: formatQuote,
      formatSourceLabel: formatSourceLabel,
      relativizeToCwd: relativizeToCwd,
      formatFileMention: formatFileMention,
      placeMenu: placeMenu,
      normalizeSessionId: normalizeSessionId,
      resolveConversation: resolveConversation,
      showSelectionOverlay: showSelectionOverlay,
      clearSelectionOverlay: clearSelectionOverlay,
      sourceFromPreview: sourceFromPreview,
      sourceFromChat: sourceFromChat,
      buildCaptureRequest: buildCaptureRequest,
      parseCaptureResponse: parseCaptureResponse,
      captureFileName: captureFileName,
      startCapture: startCapture,
      __setActiveComposer: function (composer) {
        activeComposer = composer || null
      },
    }
    return module.exports
  },
})
