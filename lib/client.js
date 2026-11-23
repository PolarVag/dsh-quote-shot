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
      var limit = opts.maxChars
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

    // apply(ctx) is added in Task 5
    exports.inject = ['slots', 'shortcuts', 'sessions']
    exports.apply = () => {}
    exports.__internals = { formatQuote, formatSourceLabel, placeMenu }
    return module.exports
  },
})
