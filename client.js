/**
 * dsh-conversation-folders — Client 半区（浏览器 UI）。
 *
 * 在会话「…」菜单（sidebar.workspaces.session.menu.item）里，于「归档会话」
 * 与「复制 ID」之间插入一行「删除对话及其内容」；点击后弹出自定义确认框：
 * 「将会删除对话及其所有内容，请谨慎考虑。」确认后调用插件的 Host 接口
 * POST /conversation-folders/api/delete-session，保存删除会话及其全部内容
 * （会话产物 + 会话文件夹 + 对话记录 + 分类文件 + 状态映射）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-conversation-folders',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /* ---------------- 文案（跟随界面语言） ---------------- */
    const DICT = {
      zh: {
        deleteItem: '删除对话及其内容',
        dialogTitle: '删除对话及其内容',
        dialogBody: '将会删除对话及其所有内容，请谨慎考虑。',
        dialogTarget: '目标对话：',
        cancel: '取消',
        confirm: '确认删除',
        deleting: '正在删除…',
        failed: '删除失败：',
        close: '关闭'
      },
      en: {
        deleteItem: 'Delete conversation and its contents',
        dialogTitle: 'Delete conversation and its contents',
        dialogBody: 'This will delete the conversation and all of its contents. Please consider carefully.',
        dialogTarget: 'Target conversation: ',
        cancel: 'Cancel',
        confirm: 'Delete',
        deleting: 'Deleting…',
        failed: 'Delete failed: ',
        close: 'Close'
      }
    };
    let activeLocale = 'zh';
    const t = (key) => (DICT[activeLocale] ?? DICT.zh)[key] ?? key;

    /* ---------------- 共享 UI 状态 ---------------- */
    const ui = {
      snapshot: { target: null, busy: false, error: null },
      listeners: new Set()
    };
    const emit = () => { for (const listener of [...ui.listeners]) listener(); };
    const subscribe = (listener) => {
      ui.listeners.add(listener);
      return () => { ui.listeners.delete(listener); };
    };
    const getSnapshot = () => ui.snapshot;
    const update = (patch) => {
      ui.snapshot = { ...ui.snapshot, ...patch };
      emit();
    };

    const STYLE_ID = 'dsh-conversation-folders-ui';
    const CSS = `
.cf-menu-item {
  display: flex; align-items: center; gap: 8px;
  width: 100%; box-sizing: border-box;
  padding: 7px 12px; margin: 0;
  border: 0; border-radius: 6px;
  background: transparent;
  font: inherit; font-size: 13px; line-height: 1.4; text-align: left;
  color: var(--dsw-alias-state-error-primary, #d9534f);
  cursor: pointer;
}
.cf-menu-item:hover { background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.12)); }
.cf-menu-item:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #4c8dff); outline-offset: -2px; }
.cf-menu-item .cf-menu-icon { display: inline-flex; width: 16px; height: 16px; flex: none; }
.cf-menu-item .cf-menu-icon svg { width: 16px; height: 16px; display: block; }
.cf-overlay {
  position: fixed; inset: 0; z-index: 2147483000;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0, 0, 0, .38);
  padding: 24px;
}
.cf-dialog {
  width: min(420px, 100%); box-sizing: border-box;
  background: var(--dsw-alias-bg-overlay, #2b2d31);
  color: var(--dsw-alias-label-primary, #eaeaea);
  border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.25));
  border-radius: 12px;
  box-shadow: 0 16px 48px rgba(0, 0, 0, .35);
  padding: 18px 18px 14px;
  font-size: 13px; line-height: 1.6;
}
.cf-dialog-title { font-size: 15px; font-weight: 600; margin-bottom: 8px; }
.cf-dialog-body { color: var(--dsw-alias-label-secondary, #b9bcc4); }
.cf-dialog-target {
  margin-top: 8px; padding: 6px 10px;
  background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.12));
  border-radius: 6px;
  color: var(--dsw-alias-label-primary, #eaeaea);
  word-break: break-all;
}
.cf-dialog-error { margin-top: 8px; color: var(--dsw-alias-state-error-primary, #d9534f); }
.cf-dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
.cf-btn {
  font: inherit; font-size: 13px; line-height: 1.4;
  padding: 6px 14px; border-radius: 8px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35));
  background: transparent; color: var(--dsw-alias-label-primary, #eaeaea);
}
.cf-btn:hover { background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.12)); }
.cf-btn:disabled { opacity: .55; cursor: default; }
.cf-btn-danger {
  border-color: transparent; color: #fff;
  background: var(--dsw-alias-state-error-primary, #d9534f);
}
.cf-btn-danger:hover { background: var(--dsw-alias-state-error-primary, #d9534f); filter: brightness(1.08); }
`;

    /* ---------------- 组件 ---------------- */
    const trashIcon = () => h('svg', { viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none', 'aria-hidden': true },
      h('path', {
        d: 'M4 7h16M10 4h4M9 7v12m6-12v12M6.5 7l.9 12a2 2 0 0 0 2 1.9h5.2a2 2 0 0 0 2-1.9l.9-12',
        stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round'
      }));

    /** 会话「…」菜单中的一行：打开确认框。 */
    function DeleteMenuItem(props) {
      const onClick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        update({ target: { sessionId: props.sessionId, title: props.displayTitle || '' }, busy: false, error: null });
        // 关闭「…」菜单：让焦点离开菜单项，宿主的下一次外部点击/键盘事件即可收起
        try { if (document.activeElement && typeof document.activeElement.blur === 'function') document.activeElement.blur(); } catch { /* ignore */ }
        try { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); } catch { /* ignore */ }
      };
      return h('button', {
        type: 'button', role: 'menuitem', className: 'cf-menu-item',
        'data-cf-menu-item': 'delete-session',
        onClick
      }, h('span', { className: 'cf-menu-icon', 'aria-hidden': true }, trashIcon()), h('span', null, t('deleteItem')));
    }

    /** 全屏覆盖的确认框：文案要求「将会删除对话及其所有内容，请谨慎考虑。」 */
    function DeleteDialog() {
      const state = React.useSyncExternalStore(subscribe, getSnapshot);
      const dialogRef = React.useRef(null);
      React.useEffect(() => {
        if (state.target === null) return undefined;
        const element = dialogRef.current;
        try { if (element) element.focus(); } catch { /* ignore */ }
        const onEscape = (event) => {
          if (event.key !== 'Escape') return;
          event.stopPropagation();
          if (!ui.snapshot.busy) update({ target: null, error: null });
        };
        document.addEventListener('keydown', onEscape, true);
        return () => document.removeEventListener('keydown', onEscape, true);
      }, [state.target]);
      if (state.target === null) return null;
      const { sessionId, title } = state.target;
      const close = () => {
        if (state.busy) return;
        update({ target: null, error: null });
      };
      const confirm = async () => {
        if (state.busy) return;
        update({ busy: true, error: null });
        try {
          const response = await fetch('/conversation-folders/api/delete-session', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId })
          });
          let data = {};
          try { data = await response.json(); } catch { /* ignore */ }
          if (!response.ok || data.ok !== true) throw new Error(data.error || ('HTTP ' + response.status));
          update({ target: null, busy: false, error: null });
        } catch (error) {
          update({ busy: false, error: (error && error.message) ? error.message : String(error) });
        }
      };
      return h('div', {
        className: 'cf-overlay',
        role: 'presentation',
        onMouseDown: (event) => { if (event.target === event.currentTarget) close(); }
      }, h('div', {
        className: 'cf-dialog',
        ref: dialogRef,
        role: 'dialog', 'aria-modal': 'true',
        'aria-label': t('dialogTitle'),
        tabIndex: -1,
        onMouseDown: (event) => event.stopPropagation()
      },
        h('div', { className: 'cf-dialog-title' }, t('dialogTitle')),
        h('div', { className: 'cf-dialog-body' }, t('dialogBody')),
        title ? h('div', { className: 'cf-dialog-target' }, t('dialogTarget') + title) : null,
        state.error ? h('div', { className: 'cf-dialog-error' }, t('failed') + ' ' + state.error) : null,
        h('div', { className: 'cf-dialog-actions' },
          h('button', { type: 'button', className: 'cf-btn', onClick: close, disabled: state.busy }, t('cancel')),
          h('button', { type: 'button', className: 'cf-btn cf-btn-danger', onClick: confirm, disabled: state.busy }, state.busy ? t('deleting') : t('confirm'))
        )
      ));
    }

    /* ---------------- 插件 ---------------- */
    return {
      inject: ['slots'],
      apply(ctx) {
        // 主题化样式（卸载时移除）
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = CSS;
        document.head.appendChild(style);
        if (typeof ctx.effect === 'function') {
          ctx.effect(() => () => { style.remove(); });
        }

        // 跟随界面语言
        try {
          const locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined;
          const current = locale && typeof locale.getLocale === 'function' ? locale.getLocale() : undefined;
          const id = current && typeof current.id === 'string' ? current.id : (current && typeof current.locale === 'string' ? current.locale : '');
          if (id.toLowerCase().startsWith('en')) activeLocale = 'en';
        } catch { /* 默认中文 */ }

        // 会话菜单：在「归档会话」(400) 与「复制ID」(450) 之间插入删除行
        ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
          name: 'sidebar.workspaces.session.menu.item',
          id: 'conversation-folders-delete',
          order: 425
        }, DeleteMenuItem));

        // 确认框：渲染在框架级浮层
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'conversation-folders-delete-dialog',
          order: 900
        }, DeleteDialog));
      }
    };
  }
});
