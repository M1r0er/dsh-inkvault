/**
 * Browser half of dsh-inkvault: a Settings section that edits the two vault
 * folders.
 *
 * DSH does not auto-generate a settings page for third-party bundles; a plugin
 * that wants a visible page registers one into the `settings.section` slot.
 * The page reads/writes the same Host Config schema (`src/config-schema.js`)
 * through the client `configForms` service, and opens the Host directory
 * picker (`remote.directoryPicker`) for the "browse" buttons.
 */
window.__ModuleLoader__.load({
  id: 'dsh-inkvault',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const FIELD_MEMORY = 'memoryRoot'
    const FIELD_KNOWLEDGE = 'knowledgeRoot'
    const FIELD_DIRECTIVES = 'directives'
    const FIELD_TRIGGERS = 'directiveTriggers'
    const FIELD_MAX_CHARS = 'maxDirectiveChars'
    const MIN_DIRECTIVE_CHARS = 200
    const MAX_DIRECTIVE_CHARS = 20000
    const SECTION_ID = 'inkvault'
    const SECTION_LABEL = '墨库 InkVault'

    /** Locate the loader namespace that carries the inkvault Config schema. */
    function findNamespace(namespaces) {
      if (!Array.isArray(namespaces)) return undefined
      const byId = namespaces.find((view) => typeof view?.ns === 'string' && (view.ns === 'inkvault' || view.ns.endsWith(':inkvault')))
      if (byId !== undefined) return byId.ns
      return namespaces.find((view) => view?.schema?.properties !== undefined
        && (FIELD_MEMORY in view.schema.properties || FIELD_KNOWLEDGE in view.schema.properties))?.ns
    }

    const styles = {
      page: {
        display: 'flex',
        flexDirection: 'column',
        gap: '20px',
        maxWidth: '720px',
        padding: '8px 0 32px',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '13px',
        lineHeight: '20px',
      },
      title: { margin: 0, fontSize: '20px', fontWeight: 500, lineHeight: '28px' },
      intro: { margin: 0, color: 'var(--dsw-alias-label-secondary)' },
      card: {
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        padding: '16px',
        border: '0.5px solid var(--dsw-alias-border-l3)',
        borderRadius: '12px',
        background: 'var(--dsw-alias-bg-layer-2)',
      },
      label: { fontWeight: 500 },
      row: { display: 'flex', gap: '8px', alignItems: 'center' },
      input: {
        flex: 1,
        minWidth: 0,
        height: '36px',
        padding: '0 12px',
        fontSize: '13px',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-3)',
        border: '0.5px solid var(--dsw-alias-border-l4)',
        borderRadius: '8px',
        outline: 'none',
        fontFamily: 'inherit',
      },
      button: {
        height: '36px',
        padding: '0 14px',
        fontSize: '13px',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '0.5px solid var(--dsw-alias-border-l4)',
        borderRadius: '8px',
        cursor: 'pointer',
        fontFamily: 'inherit',
        whiteSpace: 'nowrap',
      },
      primary: {
        height: '36px',
        padding: '0 16px',
        fontSize: '13px',
        color: 'var(--dsw-alias-label-primary-foreground)',
        background: 'var(--dsw-alias-state-business-primary)',
        border: 'none',
        borderRadius: '8px',
        cursor: 'pointer',
        fontFamily: 'inherit',
      },
      hint: { margin: 0, color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px', lineHeight: '18px' },
      textarea: {
        minHeight: '104px',
        padding: '10px 12px',
        fontSize: '13px',
        lineHeight: '20px',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-3)',
        border: '0.5px solid var(--dsw-alias-border-l4)',
        borderRadius: '8px',
        outline: 'none',
        fontFamily: 'inherit',
        resize: 'vertical',
      },
      checkboxRow: { display: 'flex', gap: '8px', alignItems: 'center', cursor: 'pointer' },
      checkbox: { width: '16px', height: '16px', margin: 0, cursor: 'pointer' },
      tagList: { display: 'flex', flexWrap: 'wrap', gap: '6px' },
      tag: {
        padding: '2px 8px',
        fontSize: '12px',
        lineHeight: '18px',
        color: 'var(--dsw-alias-label-secondary)',
        background: 'var(--dsw-alias-bg-layer-3)',
        border: '0.5px solid var(--dsw-alias-border-l4)',
        borderRadius: '6px',
      },
      sectionTitle: { margin: 0, fontSize: '15px', fontWeight: 500, lineHeight: '22px' },
      footer: { display: 'flex', alignItems: 'center', gap: '12px' },
      status: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px' },
      error: { color: 'var(--dsw-alias-state-error-primary)', fontSize: '12px' },
    }

    /** Settings page component, closed over the client context. */
    function createSection(ctx) {
      const configForms = ctx.configForms

      return function InkVaultSettings() {
        const [namespace, setNamespace] = React.useState(undefined)
        const [snapshot, setSnapshot] = React.useState(undefined)
        const [memoryRoot, setMemoryRoot] = React.useState('')
        const [knowledgeRoot, setKnowledgeRoot] = React.useState('')
        const [directives, setDirectives] = React.useState(true)
        const [triggers, setTriggers] = React.useState('')
        const [maxChars, setMaxChars] = React.useState('')
        const [dirty, setDirty] = React.useState(false)
        const [busy, setBusy] = React.useState('')
        const [notice, setNotice] = React.useState('')
        const [failure, setFailure] = React.useState('')

        // Find the namespace served by this plugin and keep following the shared mirror.
        React.useEffect(() => {
          const mirror = configForms.describe()
          const locate = () => {
            try {
              const view = mirror.getSnapshot?.()?.view
              const ns = findNamespace(view?.namespaces)
              if (ns !== undefined && ns !== namespace) setNamespace(ns)
            } catch (error) {
              setFailure(`读取配置目录失败：${error.message}`)
            }
          }
          const stop = mirror.subscribe(locate)
          mirror.ensure()
          locate()
          return () => { try { stop?.() } catch { /* ignore */ } }
        }, [namespace])

        // Follow the form snapshot for the located namespace.
        React.useEffect(() => {
          if (namespace === undefined) return undefined
          const form = configForms.get(namespace)
          const sync = () => {
            try { setSnapshot(form.getSnapshot()) } catch (error) { setFailure(String(error)) }
          }
          const stop = form.subscribe(sync)
          sync()
          return () => { try { stop?.() } catch { /* ignore */ } }
        }, [namespace])

        // Seed the drafts from the resolved value until the user edits them.
        React.useEffect(() => {
          if (dirty || snapshot?.status !== 'ready' || snapshot?.value === undefined) return
          setMemoryRoot(String(snapshot.value[FIELD_MEMORY] ?? ''))
          setKnowledgeRoot(String(snapshot.value[FIELD_KNOWLEDGE] ?? ''))
          setDirectives(snapshot.value[FIELD_DIRECTIVES] !== false)
          const list = snapshot.value[FIELD_TRIGGERS]
          setTriggers(Array.isArray(list) ? list.join('\n') : '')
          const limit = snapshot.value[FIELD_MAX_CHARS]
          setMaxChars(limit === undefined || limit === null ? '' : String(limit))
        }, [snapshot, dirty])

        const edit = (setter) => (event) => {
          setter(event.target.value)
          setDirty(true)
          setNotice('')
        }

        /** Open the Host directory chooser and copy its result into one field. */
        async function browse(field, setter) {
          setBusy(field)
          setFailure('')
          try {
            const result = await ctx.remote.directoryPicker.pick()
            if (result !== undefined && result.ok === false) {
              throw new Error(result.error?.message ?? '目录选择失败')
            }
            const value = result?.value
            if (typeof value === 'string' && value !== '') {
              setter(value)
              setDirty(true)
              setNotice('')
            }
          } catch (error) {
            setFailure(`无法打开目录选择器：${error.message}。可以直接在输入框中粘贴路径。`)
          } finally {
            setBusy('')
          }
        }

        /** Split the textarea into the phrase list the Host schema expects. */
        function parseTriggers(text) {
          const out = []
          for (const piece of String(text ?? '').split(/[\n,，、]/)) {
            const word = piece.trim()
            if (word !== '' && !out.includes(word)) out.push(word)
          }
          return out
        }

        /** Write every edited field as one atomic config mutation at the read revision. */
        async function save() {
          if (namespace === undefined || snapshot?.revision === undefined) return
          const limit = Number(maxChars)
          if (maxChars.trim() !== '' && (!Number.isInteger(limit) || limit < MIN_DIRECTIVE_CHARS || limit > MAX_DIRECTIVE_CHARS)) {
            setNotice('')
            setFailure(`字符上限必须是 ${MIN_DIRECTIVE_CHARS}–${MAX_DIRECTIVE_CHARS} 之间的整数。`)
            return
          }
          setBusy('save')
          setNotice('')
          setFailure('')
          try {
            const form = configForms.get(namespace)
            const operations = [
              { op: 'set', path: [FIELD_MEMORY], value: memoryRoot.trim() },
              { op: 'set', path: [FIELD_KNOWLEDGE], value: knowledgeRoot.trim() },
              { op: 'set', path: [FIELD_DIRECTIVES], value: directives },
              { op: 'set', path: [FIELD_TRIGGERS], value: parseTriggers(triggers) },
            ]
            // An empty box means "keep the schema default"; only send a real number.
            if (maxChars.trim() !== '') operations.push({ op: 'set', path: [FIELD_MAX_CHARS], value: limit })
            const accepted = await form.mutate(operations, snapshot.revision)
            if (accepted) {
              setDirty(false)
              setNotice('已保存，配置立即生效。')
            } else {
              setFailure('保存失败：配置已被其他窗口修改，请重试。')
            }
          } catch (error) {
            setFailure(`保存失败：${error.message}`)
          } finally {
            setBusy('')
          }
        }

        const writable = snapshot?.writable !== false
        const field = (title, value, onEdit, hint, name) => h('div', { style: styles.card },
          h('label', { style: styles.label }, title),
          h('div', { style: styles.row },
            h('input', {
              type: 'text',
              value,
              placeholder: hint,
              spellCheck: false,
              onChange: onEdit,
              style: styles.input,
            }),
            h('button', {
              type: 'button',
              style: styles.button,
              disabled: !writable || busy !== '',
              onClick: () => browse(name, onEdit === undefined ? undefined : (next) => {
                if (name === FIELD_MEMORY) setMemoryRoot(next)
                else setKnowledgeRoot(next)
                setDirty(true)
              }),
            }, busy === name ? '选择中…' : '浏览…')
          ),
          h('p', { style: styles.hint }, hint)
        )

        return h('div', { style: styles.page },
          h('h2', { style: styles.title }, SECTION_LABEL),
          h('p', { style: styles.intro }, '选择知识库与记忆库使用的文件夹，并设置指令层的升级规则。留空表示该功能不启用；插件不会创建任何未配置的目录。'),
          namespace === undefined && failure === '' ? h('p', { style: styles.hint }, '正在读取墨库配置…') : null,
          field('记忆库文件夹', memoryRoot, edit(setMemoryRoot), '例如 C:\\\\Users\\\\me\\\\Documents\\\\Obsidian Vault\\\\InkVault（支持 ~）', FIELD_MEMORY),
          field('知识库文件夹', knowledgeRoot, edit(setKnowledgeRoot), '例如 C:\\\\Users\\\\me\\\\Documents\\\\Obsidian Vault\\\\Knowledge（支持 ~）', FIELD_KNOWLEDGE),
          h('h3', { style: styles.sectionTitle }, '指令层'),
          h('p', { style: styles.hint }, '指令层把用户显式声明的长期约定每轮注入系统提示词；其余笔记仍走关键词召回，只作参考数据。'),
          h('div', { style: styles.card },
            h('label', { style: styles.checkboxRow },
              h('input', {
                type: 'checkbox',
                checked: directives,
                style: styles.checkbox,
                disabled: !writable,
                onChange: (event) => { setDirectives(event.target.checked); setDirty(true); setNotice('') },
              }),
              h('span', { style: styles.label }, '启用指令层')
            ),
            h('p', { style: styles.hint }, '只有 frontmatter 标了 delivery: prompt 且 status: active 的笔记会进入。关闭后这些笔记退回关键词召回，不再每轮注入。')
          ),
          h('div', { style: styles.card },
            h('label', { style: styles.label }, '强声明短语'),
            h('textarea', {
              value: triggers,
              placeholder: '每行一个短语，例如：\n以后都\nfrom now on',
              spellCheck: false,
              style: styles.textarea,
              disabled: !writable,
              onChange: (event) => { setTriggers(event.target.value); setDirty(true); setNotice('') },
            }),
            h('p', { style: styles.hint }, '一句话同时命中「记住」和这里任一短语时，才自动升级为指令层。纯文本子串匹配、大小写不敏感；留空即关闭自动升级，仍可手动写 delivery: prompt。'),
            triggers === '' ? null : h('div', { style: styles.tagList }, parseTriggers(triggers).map((word) => h('span', { key: word, style: styles.tag }, word)))
          ),
          h('div', { style: styles.card },
            h('label', { style: styles.label }, '指令层字符上限'),
            h('input', {
              type: 'text',
              value: maxChars,
              placeholder: `${MIN_DIRECTIVE_CHARS}–${MAX_DIRECTIVE_CHARS}`,
              spellCheck: false,
              style: styles.input,
              disabled: !writable,
              onChange: (event) => { setMaxChars(event.target.value); setDirty(true); setNotice('') },
            }),
            h('p', { style: styles.hint }, '超出上限时整块跳过并告警，不会截断——截断的指令比没有指令更危险。')
          ),
          h('div', { style: styles.footer },
            h('button', {
              type: 'button',
              style: styles.primary,
              disabled: !writable || busy !== '' || !dirty,
              onClick: save,
            }, busy === 'save' ? '保存中…' : '保存'),
            notice === '' ? null : h('span', { style: styles.status }, notice)
          ),
          failure === '' ? null : h('p', { style: styles.error }, failure),
          h('p', { style: styles.hint }, '提示：两个文件夹建议都放在同一个 Obsidian 库内，便于在 Obsidian 中直接查看。')
        )
      }
    }

    return {
      inject: ['slots', 'configForms', 'remote', 'remote.directoryPicker'],
      apply(ctx) {
        const Section = createSection(ctx)
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: SECTION_ID,
          order: 46,
          label: SECTION_LABEL,
        }, Section))
      },
    }
  },
})
