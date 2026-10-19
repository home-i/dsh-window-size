/**
 * Settings page for the remembered Desktop window size.
 *
 * The page is a `settings.section` entry: it shows the live and recorded size,
 * lets the user type a size and apply it, record the current window, reset to
 * the default, and keep the window horizontally and vertically centered. Every
 * action is a request to this package's Host half over the package-private
 * Connection RPC channel, so the page never touches the window itself.
 */
window.__ModuleLoader__.load({
  id: 'dsh-window-size',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    /** Channel registered by the Host half. */
    const CHANNEL = '/dsh-window-size'
    /** Locale namespace owned by this page. */
    const NS = 'dsh-window-size'

    const ZH = {
      section: '窗口尺寸',
      current: '当前窗口',
      recorded: '已记录尺寸',
      recordedDefault: '默认值',
      recordedSaved: '已保存',
      sizeTitle: '自定义尺寸',
      width: '宽度',
      height: '高度',
      apply: '应用并记住',
      remember: '记住当前尺寸',
      reapply: '重新应用',
      reset: '恢复默认',
      centerTitle: '启动时居中',
      centerHint: '开启后每次启动都把窗口水平、垂直居中于当前显示器；关闭则沿用上次位置。',
      centerNow: '立即居中',
      enableTitle: '启用尺寸记忆',
      enableHint: '关闭后不再恢复、也不再记录窗口尺寸，设置页仍可手动调整。',
      lastAction: '上次动作',
      minimum: '最小 {width} × {height}；超过当前显示器工作区的尺寸会被自动缩小。',
      unavailable: '此设置只在 DSH 桌面版中可用。',
      reason: '原因',
      never: '暂无记录',
      invalidSize: '请填写大于 0 的宽度和高度。',
      busy: '处理中…',
      actRestore: '启动时恢复',
      actResize: '手动调整',
      actApply: '应用尺寸',
      actRemember: '记住当前',
      actCenter: '立即居中',
      actCenterOn: '开启居中',
      actCenterOff: '关闭居中',
      actEnabled: '启用记忆',
      actDisabled: '停用记忆',
    }

    const EN = {
      section: 'Window size',
      current: 'Current window',
      recorded: 'Remembered size',
      recordedDefault: 'default',
      recordedSaved: 'saved',
      sizeTitle: 'Custom size',
      width: 'Width',
      height: 'Height',
      apply: 'Apply and remember',
      remember: 'Remember current size',
      reapply: 'Re-apply',
      reset: 'Restore default',
      centerTitle: 'Center on launch',
      centerHint: 'Centers the window horizontally and vertically on the current display at every launch; off keeps the last position.',
      centerNow: 'Center now',
      enableTitle: 'Enable size memory',
      enableHint: 'When off, the window size is neither restored nor recorded; the page can still resize the window.',
      lastAction: 'Last action',
      minimum: 'Minimum {width} × {height}; sizes larger than the current work area are reduced.',
      unavailable: 'This setting is only available in DSH Desktop.',
      reason: 'Reason',
      never: 'Nothing recorded yet',
      invalidSize: 'Enter a width and height greater than 0.',
      busy: 'Working…',
      actRestore: 'Restored at launch',
      actResize: 'Manual resize',
      actApply: 'Size applied',
      actRemember: 'Recorded current size',
      actCenter: 'Centered',
      actCenterOn: 'Centering enabled',
      actCenterOff: 'Centering disabled',
      actEnabled: 'Memory enabled',
      actDisabled: 'Memory disabled',
    }

    const styles = {
      wrap: { maxWidth: 520, display: 'flex', flexDirection: 'column', gap: 14 },
      card: {
        background: 'var(--dsw-alias-bg-layer-1,#fff)',
        border: '1px solid var(--dsw-alias-border-l2,#e5e7eb)',
        borderRadius: 12,
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      },
      title: { fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary,inherit)' },
      row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
      label: { fontSize: 13, color: 'var(--dsw-alias-label-primary,inherit)' },
      value: { fontSize: 13, color: 'var(--dsw-alias-label-secondary,#6b7280)', fontVariantNumeric: 'tabular-nums' },
      hint: { fontSize: 12, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary,#6b7280)' },
      muted: { fontSize: 12, color: 'var(--dsw-alias-label-secondary,#6b7280)' },
      error: { fontSize: 12, lineHeight: 1.6, color: 'var(--dsw-alias-state-error-primary,#dc2626)' },
      inputs: { display: 'flex', alignItems: 'flex-end', gap: 10, flexWrap: 'wrap' },
      field: { display: 'flex', flexDirection: 'column', gap: 4 },
      input: {
        font: 'inherit',
        height: 32,
        width: 92,
        padding: '0 10px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l2,#d1d5db)',
        background: 'var(--dsw-alias-bg-base,#fff)',
        color: 'var(--dsw-alias-label-primary,inherit)',
        fontVariantNumeric: 'tabular-nums',
        boxSizing: 'border-box',
      },
      buttons: { display: 'flex', gap: 8, flexWrap: 'wrap' },
      // The accent (`brand-primary`) is the theme's ink: near-black in the light
      // theme, near-white in the dark one. Its readable partner is
      // `label-primary-foreground` (#fff in light, #0f1115 in dark), never a
      // hard-coded white — that is white-on-white in dark mode (1.05:1).
      primary: {
        font: 'inherit',
        cursor: 'pointer',
        border: 'none',
        height: 32,
        padding: '0 14px',
        borderRadius: 999,
        fontSize: 13,
        fontWeight: 500,
        background: 'var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary,#4f6ef7))',
        color: 'var(--dsw-alias-label-primary-foreground,#fff)',
      },
      button: {
        font: 'inherit',
        cursor: 'pointer',
        height: 32,
        padding: '0 14px',
        borderRadius: 999,
        fontSize: 13,
        border: '1px solid var(--dsw-alias-border-l2,#d1d5db)',
        background: 'var(--dsw-alias-bg-layer-1,#fff)',
        color: 'var(--dsw-alias-label-primary,inherit)',
      },
      disabled: { opacity: 0.55, cursor: 'default' },
      toggle: {
        position: 'relative',
        flexShrink: 0,
        width: 36,
        height: 20,
        padding: 2,
        border: 0,
        borderRadius: 999,
        cursor: 'pointer',
        font: 'inherit',
        boxSizing: 'border-box',
        transition: 'background 120ms ease',
      },
      thumb: {
        display: 'block',
        width: 16,
        height: 16,
        borderRadius: '50%',
        // A hairline shadow keeps the knob readable when the thumb and track sit
        // close in the light theme (white thumb on the light idle track).
        boxShadow: '0 1px 2px rgba(0,0,0,.24)',
        transition: 'transform 120ms ease',
      },
    }

    /**
     * Render one interactive switch.
     * @param props - checked state, label, and change handler.
     * @returns the switch button.
     */
    function Toggle({ checked, onToggle, disabled, label }) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked ? 'true' : 'false',
        'aria-label': label,
        disabled,
        onClick: onToggle,
        style: {
          ...styles.toggle,
          background: checked
            ? 'var(--dsw-alias-brand-primary,#4f6ef7)'
            : 'var(--dsw-alias-state-idle-primary,#9aa3b2)',
          ...(disabled ? styles.disabled : {}),
        },
      }, h('span', {
        style: {
          ...styles.thumb,
          // Track and knob swap roles per state so the pair always contrasts:
          // ON = ink track + foreground knob, OFF = idle track + switch thumb.
          background: checked
            ? 'var(--dsw-alias-label-primary-foreground,#fff)'
            : 'var(--dsw-alias-switch-thumb,#fff)',
          transform: checked ? 'translateX(16px)' : 'translateX(0)',
        },
      }))
    }

    /**
     * Render one label/value row.
     * @param props - label and rendered value.
     * @returns the row.
     */
    function Row({ label, children }) {
      return h('div', { style: styles.row }, h('span', { style: styles.label }, label), children)
    }

    /**
     * Format a translated string with `{name}` placeholders.
     * @param template - text possibly containing placeholders.
     * @param values - replacement values by name.
     * @returns the formatted string.
     */
    function format(template, values) {
      return String(template).replace(/\{(\w+)\}/gu, (match, name) => (values[name] ?? match))
    }

    /**
     * The settings page body.
     * @param props - injected RPC caller and translator.
     * @returns the rendered page.
     */
    function WindowSizeSection({ call, t }) {
      const [status, setStatus] = useState(null)
      const [width, setWidth] = useState('')
      const [height, setHeight] = useState('')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const seeded = useRef(false)

      /** Send one request and unwrap the envelope. */
      const request = useCallback(async (endpoint, payload) => {
        const result = await call(endpoint, payload)
        if (result === null || typeof result !== 'object' || result.ok !== true) {
          throw new Error(result?.error?.message ?? 'request failed')
        }
        return result.value
      }, [call])

      /** Refresh the snapshot without surfacing transient failures. */
      const refresh = useCallback(async () => {
        try {
          setStatus(await request('status'))
        } catch {
          // The page polls; a transient failure must not clear the panel.
        }
      }, [request])

      useEffect(() => {
        let alive = true
        const load = async () => {
          try {
            const next = await request('status')
            if (alive) setStatus(next)
          } catch (cause) {
            if (alive) setError(cause instanceof Error ? cause.message : String(cause))
          }
        }
        load()
        const timer = setInterval(() => { if (alive) refresh() }, 2000)
        return () => { alive = false; clearInterval(timer) }
      }, [request, refresh])

      useEffect(() => {
        if (seeded.current || status === null) return
        const base = status.current ?? status.recorded
        if (base === null || base === undefined) return
        seeded.current = true
        setWidth(String(base.width))
        setHeight(String(base.height))
      }, [status])

      /** Run one mutating request. */
      const act = async (endpoint, payload) => {
        setBusy(true)
        setError(null)
        try {
          const next = await request(endpoint, payload)
          setStatus(next)
          if (endpoint === 'apply' || endpoint === 'reset' || endpoint === 'remember') {
            const base = next.current ?? next.recorded
            if (base) {
              setWidth(String(base.width))
              setHeight(String(base.height))
            }
          }
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          setBusy(false)
        }
      }

      /** Validate the typed size and apply it. */
      const applyTyped = () => {
        const nextWidth = Math.round(Number(width))
        const nextHeight = Math.round(Number(height))
        if (!Number.isFinite(nextWidth) || !Number.isFinite(nextHeight) || nextWidth <= 0 || nextHeight <= 0) {
          setError(t('invalidSize'))
          return
        }
        act('apply', { width: nextWidth, height: nextHeight })
      }

      if (status === null) {
        return h('div', { style: styles.wrap }, h('div', { style: styles.muted }, busy ? t('busy') : t('section')))
      }

      if (status.available !== true) {
        return h('div', { style: styles.wrap },
          h('div', { style: styles.card },
            h('div', { style: styles.title }, t('unavailable')),
            h('div', { style: styles.hint }, `${t('reason')}: ${status.reason ?? 'unknown'}`),
          ),
        )
      }

      const current = status.current
      const last = status.last
      // Records carry dashed action verbs; the dictionary uses flat act* keys.
      const actionKey = last && typeof last.action === 'string'
        ? `act${last.action.replace(/(^|-)([a-z])/gu, (_m, _d, c) => c.toUpperCase())}`
        : undefined
      const lastLabel = actionKey === undefined
        ? t('never')
        : (() => {
          const translated = t(actionKey)
          return translated === actionKey ? last.action : translated
        })()
      const lastTime = last && typeof last.at === 'number'
        ? new Date(last.at).toLocaleString()
        : ''
      const disabled = busy

      return h('div', { style: styles.wrap },
        h('div', { style: styles.card },
          h(Row, { label: t('current') },
            h('span', { style: styles.value }, current ? `${current.width} × ${current.height}` : '—'),
          ),
          h(Row, { label: t('recorded') },
            h('span', { style: styles.value },
              `${status.recorded.width} × ${status.recorded.height} · ${status.recordedSource === 'saved' ? t('recordedSaved') : t('recordedDefault')}`,
            ),
          ),
          h(Row, { label: t('lastAction') },
            h('span', { style: styles.value }, lastTime === '' ? lastLabel : `${lastLabel} · ${lastTime}`),
          ),
        ),

        h('div', { style: styles.card },
          h('div', { style: styles.title }, t('sizeTitle')),
          h('div', { style: styles.inputs },
            h('label', { style: styles.field },
              h('span', { style: styles.muted }, t('width')),
              h('input', {
                type: 'number',
                min: 1,
                step: 1,
                value: width,
                disabled,
                onChange: event => setWidth(event.target.value),
                style: styles.input,
                'aria-label': t('width'),
              }),
            ),
            h('span', { style: styles.muted }, '×'),
            h('label', { style: styles.field },
              h('span', { style: styles.muted }, t('height')),
              h('input', {
                type: 'number',
                min: 1,
                step: 1,
                value: height,
                disabled,
                onChange: event => setHeight(event.target.value),
                style: styles.input,
                'aria-label': t('height'),
              }),
            ),
          ),
          h('div', { style: styles.buttons },
            h('button', {
              type: 'button',
              disabled,
              onClick: applyTyped,
              style: { ...styles.primary, ...(disabled ? styles.disabled : {}) },
            }, busy ? t('busy') : t('apply')),
            h('button', {
              type: 'button',
              disabled,
              onClick: () => act('remember'),
              style: { ...styles.button, ...(disabled ? styles.disabled : {}) },
            }, t('remember')),
            h('button', {
              type: 'button',
              disabled,
              onClick: () => act('reapply'),
              style: { ...styles.button, ...(disabled ? styles.disabled : {}) },
            }, t('reapply')),
            h('button', {
              type: 'button',
              disabled,
              onClick: () => act('reset'),
              style: { ...styles.button, ...(disabled ? styles.disabled : {}) },
            }, `${t('reset')} ${status.defaults.width} × ${status.defaults.height}`),
          ),
          h('div', { style: styles.hint },
            format(t('minimum'), { width: status.minimum.width, height: status.minimum.height }),
          ),
        ),

        h('div', { style: styles.card },
          h(Row, { label: t('centerTitle') },
            h(Toggle, {
              checked: status.center === true,
              disabled,
              label: t('centerTitle'),
              onToggle: () => act('set-center', status.center !== true),
            }),
          ),
          h('div', { style: styles.hint }, t('centerHint')),
          h('div', { style: styles.buttons },
            h('button', {
              type: 'button',
              disabled,
              onClick: () => act('center'),
              style: { ...styles.button, ...(disabled ? styles.disabled : {}) },
            }, t('centerNow')),
          ),
        ),

        h('div', { style: styles.card },
          h(Row, { label: t('enableTitle') },
            h(Toggle, {
              checked: status.enabled === true,
              disabled,
              label: t('enableTitle'),
              onToggle: () => act('set-enabled', status.enabled !== true),
            }),
          ),
          h('div', { style: styles.hint }, t('enableHint')),
        ),

        error === null ? null : h('div', { style: styles.error }, error),
      )
    }

    return {
      name: 'dsh-window-size',
      inject: ['slots', 'connection', 'locale'],

      /**
       * Register the settings page.
       * @param ctx - plugin context.
       */
      apply(ctx) {
        const call = (endpoint, payload) => ctx.connection.rpc.call(CHANNEL, endpoint, payload)
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'dsh-window-size: locale dictionaries')
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'window-size',
          order: 2,
          label: () => t('section'),
          inject: () => ({ call, t }),
        }, WindowSizeSection))
      },
    }
  },
})
