/**
 * dsh-conversation-folders — Client 半区（浏览器 UI）。
 *
 * 1) 会话「…」菜单（sidebar.workspaces.session.menu.item）里，于「归档会话」
 *    与「复制 ID」之间插入一行「删除对话及其内容」；点击后弹出自定义确认框：
 *    「将会删除对话及其所有内容，请谨慎考虑。」确认后调用插件的 Host 接口
 *    POST /conversation-folders/api/delete-session，删除会话及其全部内容
 *    （会话产物 + 会话文件夹 + 对话记录 + 分类文件 + 状态映射）。
 * 2) 侧栏「更多」菜单里的「会话文件夹」入口：注册 main 面板（key =
 *    conversation-folders）与 sidebar.panellist 图标，打开后是一个管理页：
 *    查看映射（会话 → 文件夹）、打开文件夹、立即整理、检查更新。
 */
window.__ModuleLoader__.load({
  id: 'dsh-conversation-folders',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'dsh-conversation-folders';
    const PANEL_ID = 'conversation-folders';
    const REPO_URL = 'https://github.com/myqy91615-web/dsh-conversation-folders';

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
        close: '关闭',

        panelName: '会话文件夹',
        panelSub: '每个对话的专属文件夹：查看映射、打开文件夹、立即整理、检查更新。',
        refresh: '刷新',
        loading: '加载中…',
        checkUpdate: '检查更新',
        checking: '检查中…',
        version: '版本',
        mapped: '已映射会话',
        present: '文件夹存在',
        idle: '空闲整理',
        pending: '待整理',
        idleOff: '已关闭',
        minutes: '{n} 分钟',
        empty: '还没有任何会话文件夹映射。在与工作区里的对话聊一句后，这里会出现它的文件夹。',
        openFolder: '打开文件夹',
        organize: '立即整理',
        notLive: '该会话当前未在运行：先打开这个对话，再点「立即整理」。',
        renamed: '已按对话标题更新文件夹名。',
        movedN: '本次整理 {n} 个文件。',
        noMove: '本次没有需要整理的新文件。',
        latest: '最新版本',
        upToDate: '已是最新版本（{v}）。',
        updateAvailable: '发现新版本 {v}，当前 {local}。可到仓库更新。',
        checkFailed: '检查更新失败：',
        repo: 'GitHub 仓库',
        openFailed: '打开文件夹失败：',
        organizeFailed: '整理失败：',
        runBadge: '调研 {n}',
        opened: '已在资源管理器打开：',
        outputDir: '输出目录',
        outputNotSet: '未设置',
        outputDirSet: '已设置输出目录：',
        chooseOutputDir: '选择输出目录',
        openOutputDir: '打开输出目录',
        outputDirSaved: '输出目录已设置：',
        outputDirCanceled: '未选择输出目录（已跳过，之后可手动设置）。',
        outputDirFailed: '设置输出目录失败：'
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
        close: 'Close',

        panelName: 'Conversation folders',
        panelSub: 'A dedicated folder per conversation: mappings, open folder, organize now, check updates.',
        refresh: 'Refresh',
        loading: 'Loading…',
        checkUpdate: 'Check for updates',
        checking: 'Checking…',
        version: 'Version',
        mapped: 'Mapped sessions',
        present: 'Folders present',
        idle: 'Idle organize',
        pending: 'Pending',
        idleOff: 'Off',
        minutes: '{n} min',
        empty: 'No conversation folder mappings yet. Send a message in a workspace conversation and its folder appears here.',
        openFolder: 'Open folder',
        organize: 'Organize now',
        notLive: 'That session is not running: open the conversation first, then try again.',
        renamed: 'Folder renamed to the conversation title.',
        movedN: 'Organized {n} file(s).',
        noMove: 'Nothing new to organize.',
        latest: 'Latest version',
        upToDate: 'Up to date ({v}).',
        updateAvailable: 'Version {v} is available (you have {local}). Update from the repository.',
        checkFailed: 'Update check failed: ',
        repo: 'GitHub repository',
        openFailed: 'Could not open folder: ',
        organizeFailed: 'Organize failed: ',
        runBadge: 'Run {n}',
        opened: 'Opened in File Explorer: ',
        outputDir: 'Output dir',
        outputNotSet: 'Not set',
        outputDirSet: 'Output dir set: ',
        chooseOutputDir: 'Choose output dir',
        openOutputDir: 'Open output dir',
        outputDirSaved: 'Output dir set to: ',
        outputDirCanceled: 'No output dir chosen (skipped; you can set it later).',
        outputDirFailed: 'Could not set output dir: '
      }
    };

    /** 把 locale id（如 zh-CN / en-US）归一成字典键。 */
    const normalizeLocale = (id) => {
      const value = typeof id === 'string' ? id.toLowerCase() : '';
      return value.startsWith('en') ? 'en' : 'zh';
    };

    let activeLocale = 'zh';
    /** 当前语言：优先读 locale 服务快照，读到之前回退到 apply 时的语言。 */
    function currentLocaleId() {
      try {
        const snapshot = localeStore.getSnapshot();
        if (snapshot && typeof snapshot.active === 'string') return normalizeLocale(snapshot.active);
      } catch { /* ignore */ }
      return activeLocale;
    }
    const t = (key, vars) => {
      const dict = DICT[currentLocaleId()] ?? DICT.zh;
      const text = dict[key] ?? DICT.zh[key] ?? key;
      return vars ? text.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match)) : text;
    };

    /* ---------------- 共享 UI 状态（删除确认框） ---------------- */
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

    /** locale 服务引用：apply 时捕获，供面板跟随界面语言。 */
    let localeRef = null;
    const EMPTY_LOCALE_SNAPSHOT = { active: 'zh', locales: [], revision: 0 };
    const localeStore = {
      subscribe(listener) {
        try {
          return localeRef && typeof localeRef.subscribe === 'function' ? localeRef.subscribe(listener) : () => {};
        } catch {
          return () => {};
        }
      },
      getSnapshot() {
        try {
          if (localeRef && typeof localeRef.getSnapshot === 'function') return localeRef.getSnapshot();
          if (localeRef && typeof localeRef.getLocale === 'function') {
            const current = localeRef.getLocale();
            if (current && typeof current.active === 'string') return current;
          }
        } catch { /* ignore */ }
        return EMPTY_LOCALE_SNAPSHOT;
      }
    };

    /* ---------------- Host API ---------------- */
    async function apiRequest(path, options) {
      const response = await fetch('/conversation-folders/api' + path, options);
      let data = {};
      try { data = await response.json(); } catch { /* non-JSON */ }
      if (!response.ok || data?.ok !== true) throw new Error(data?.error || ('HTTP ' + response.status));
      return data;
    }
    const apiGet = (path) => apiRequest(path);
    const apiPost = (path, body) => apiRequest(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {})
    });

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

.cf-panel {
  box-sizing: border-box; height: 100%; overflow: auto;
  padding: 28px 32px 40px;
  color: var(--dsw-alias-label-primary, #eaeaea);
  font-size: 13px; line-height: 1.55;
}
.cf-panel-inner { max-width: 880px; margin: 0 auto; }
.cf-panel-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.cf-panel-title { font-size: 20px; font-weight: 650; display: flex; align-items: center; gap: 8px; }
.cf-panel-sub { margin-top: 6px; color: var(--dsw-alias-label-secondary, #b9bcc4); }
.cf-panel-buttons { display: flex; gap: 8px; flex: none; }
.cf-chip {
  font-size: 11px; font-weight: 500; line-height: 1;
  padding: 4px 8px; border-radius: 999px;
  color: var(--dsw-alias-label-secondary, #b9bcc4);
  background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.16));
}
.cf-panel-error { margin-top: 14px; padding: 9px 12px; border-radius: 8px; color: var(--dsw-alias-state-error-primary, #d9534f); background: rgba(217,83,79,.10); }
.cf-panel-notice { margin-top: 14px; padding: 9px 12px; border-radius: 8px; color: var(--dsw-alias-label-secondary, #b9bcc4); background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.12)); }
.cf-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-top: 18px; }
.cf-card {
  padding: 12px 14px; border-radius: 10px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.22));
  background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,.06));
}
.cf-card-label { font-size: 12px; color: var(--dsw-alias-label-secondary, #b9bcc4); }
.cf-card-value { margin-top: 4px; font-size: 18px; font-weight: 620; }
.cf-list-head { margin-top: 24px; font-size: 13px; font-weight: 600; }
.cf-empty {
  margin-top: 10px; padding: 18px; border-radius: 10px;
  color: var(--dsw-alias-label-secondary, #b9bcc4);
  border: 1px dashed var(--dsw-alias-border-l2, rgba(127,127,127,.32));
}
.cf-rows { margin-top: 10px; display: flex; flex-direction: column; gap: 8px; }
.cf-row {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 11px 14px; border-radius: 10px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.22));
  background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,.05));
}
.cf-row-main { min-width: 0; }
.cf-row-title { font-weight: 600; display: flex; align-items: center; gap: 8px; word-break: break-all; }
.cf-badge {
  font-size: 11px; font-weight: 500; line-height: 1;
  padding: 3px 7px; border-radius: 999px;
  color: var(--dsw-alias-brand-primary, #4c8dff);
  background: rgba(76,141,255,.12);
}
.cf-row-meta { margin-top: 4px; display: flex; flex-wrap: wrap; gap: 10px; color: var(--dsw-alias-label-secondary, #b9bcc4); font-size: 12px; }
.cf-row-actions { display: flex; gap: 8px; flex: none; }
.cf-mono { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; }
.cf-dim { color: var(--dsw-alias-label-tertiary, #8f929b); }
.cf-panel-foot { margin-top: 28px; display: flex; flex-wrap: wrap; gap: 14px; align-items: center; color: var(--dsw-alias-label-secondary, #b9bcc4); font-size: 12px; }
.cf-panel-foot a { color: var(--dsw-alias-brand-primary, #4c8dff); text-decoration: none; }
.cf-panel-foot a:hover { text-decoration: underline; }
`;

    /* ---------------- 图标 ---------------- */
    const trashIcon = () => h('svg', { viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none', 'aria-hidden': true },
      h('path', {
        d: 'M4 7h16M10 4h4M9 7v12m6-12v12M6.5 7l.9 12a2 2 0 0 0 2 1.9h5.2a2 2 0 0 0 2-1.9l.9-12',
        stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round'
      }));

    /** 侧栏面板图标：一个带三点的文件夹，与插件图标一致。 */
    const folderIcon = (size) => h('svg', { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', 'aria-hidden': true },
      h('path', {
        d: 'M3.5 7.6A2.1 2.1 0 0 1 5.6 5.5h3.9l1.9 2h7A2.1 2.1 0 0 1 20.5 9.6v8.3a2.1 2.1 0 0 1-2.1 2.1H5.6a2.1 2.1 0 0 1-2.1-2.1V7.6Z',
        stroke: 'currentColor', strokeWidth: 1.7, strokeLinejoin: 'round'
      }),
      h('circle', { cx: 9, cy: 14.6, r: 1.05, fill: 'currentColor' }),
      h('circle', { cx: 12, cy: 14.6, r: 1.05, fill: 'currentColor' }),
      h('circle', { cx: 15, cy: 14.6, r: 1.05, fill: 'currentColor' }));

    /* ---------------- 会话菜单：删除对话及其内容 ---------------- */

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

    /* ---------------- 侧栏面板：会话文件夹管理页 ---------------- */

    const formatTime = (value) => {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
    };

    function ManagementPanel() {
      const localeSnapshot = React.useSyncExternalStore(localeStore.subscribe, localeStore.getSnapshot);
      const locale = normalizeLocale(localeSnapshot && localeSnapshot.active);
      const dict = DICT[locale] ?? DICT.zh;
      const tr = (key, vars) => {
        const text = dict[key] ?? DICT.zh[key] ?? key;
        return vars ? text.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match)) : text;
      };

      const [status, setStatus] = React.useState(null);
      const [entries, setEntries] = React.useState([]);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);
      const [notice, setNotice] = React.useState(null);
      const [checking, setChecking] = React.useState(false);
      const [acting, setActing] = React.useState(null);

      const load = React.useCallback(async () => {
        setBusy(true);
        setError(null);
        try {
          const [statusData, mappingsData] = await Promise.all([apiGet('/status'), apiGet('/mappings')]);
          setStatus(statusData);
          setEntries(Array.isArray(mappingsData.entries) ? mappingsData.entries : []);
        } catch (failure) {
          setError(failure?.message ? String(failure.message) : String(failure));
        } finally {
          setBusy(false);
        }
      }, []);

      React.useEffect(() => { void load(); }, [load]);

      const openFolder = async (entry) => {
        setActing(entry.sessionId);
        setError(null);
        setNotice(null);
        try {
          const result = await apiPost('/open-folder', { sessionId: entry.sessionId });
          setNotice(tr('opened') + (result.folder || entry.folder));
        } catch (failure) {
          setError(tr('openFailed') + ' ' + (failure?.message ? String(failure.message) : String(failure)));
        } finally {
          setActing(null);
        }
      };

      const pickOutputDir = async (entry) => {
        setActing(entry.sessionId);
        setError(null);
        setNotice(null);
        try {
          const result = await apiPost('/pick-output-dir', { sessionId: entry.sessionId });
          if (result.outputDir) setNotice(tr('outputDirSaved') + result.outputDir);
          else if (result.ok === true) setNotice(tr('outputDirCanceled'));
          else setNotice(tr('outputDirCanceled'));
          await load();
        } catch (failure) {
          const message = failure?.message ? String(failure.message) : String(failure);
          if (message.includes('no directory picker') || message.includes('目录选择'))
            setError(tr('outputDirFailed') + ' ' + message);
          else setError(tr('outputDirFailed') + ' ' + message);
        } finally {
          setActing(null);
        }
      };

      const openOutputDir = async (entry) => {
        setActing(entry.sessionId);
        setError(null);
        setNotice(null);
        try {
          const result = await apiPost('/open-output-dir', { sessionId: entry.sessionId });
          setNotice(tr('opened') + (result.folder || entry.outputDir));
        } catch (failure) {
          setError(tr('openFailed') + ' ' + (failure?.message ? String(failure.message) : String(failure)));
        } finally {
          setActing(null);
        }
      };

      const organize = async (entry) => {
        setActing(entry.sessionId);
        setError(null);
        setNotice(null);
        try {
          const result = await apiPost('/organize-session', { sessionId: entry.sessionId });
          const moved = Array.isArray(result.moved) ? result.moved : [];
          if (result.renamed === true) setNotice(tr('renamed'));
          else if (moved.length > 0) setNotice(tr('movedN', { n: moved.length }));
          else setNotice(tr('noMove'));
          if (result.renameError && result.renamed !== true) setError(String(result.renameError));
          await load();
        } catch (failure) {
          const message = failure?.message ? String(failure.message) : String(failure);
          if (message.includes('not live')) setNotice(tr('notLive'));
          else setError(tr('organizeFailed') + ' ' + message);
        } finally {
          setActing(null);
        }
      };

      const checkUpdate = async () => {
        setChecking(true);
        setError(null);
        setNotice(null);
        try {
          const result = await apiGet('/latest-version');
          if (result.hasUpdate === true) setNotice(tr('updateAvailable', { v: result.latest, local: result.local }));
          else if (result.latest) setNotice(tr('upToDate', { v: result.latest }));
          else setError(tr('checkFailed') + ' ' + String(result.error || ''));
        } catch (failure) {
          setError(tr('checkFailed') + ' ' + (failure?.message ? String(failure.message) : String(failure)));
        } finally {
          setChecking(false);
        }
      };

      const cards = status === null ? [] : [
        [tr('mapped'), status.counts?.mapped ?? entries.length],
        [tr('present'), status.counts?.foldersPresent ?? '—'],
        [tr('idle'), (status.idleDelayMs ?? 0) > 0 ? tr('minutes', { n: Math.round(status.idleDelayMs / 60000) }) : tr('idleOff')],
        [tr('pending'), status.pendingIdle ?? 0]
      ];

      return h('div', { className: 'cf-panel' },
        h('div', { className: 'cf-panel-inner' },
          h('div', { className: 'cf-panel-head' },
            h('div', null,
              h('div', { className: 'cf-panel-title' },
                tr('panelName'),
                status && status.version ? h('span', { className: 'cf-chip' }, 'v' + status.version) : null),
              h('div', { className: 'cf-panel-sub' }, tr('panelSub'))),
            h('div', { className: 'cf-panel-buttons' },
              h('button', { type: 'button', className: 'cf-btn', onClick: () => { void load(); }, disabled: busy }, busy ? tr('loading') : tr('refresh')),
              h('button', { type: 'button', className: 'cf-btn', onClick: () => { void checkUpdate(); }, disabled: checking }, checking ? tr('checking') : tr('checkUpdate')))),
          error ? h('div', { className: 'cf-panel-error' }, error) : null,
          notice ? h('div', { className: 'cf-panel-notice' }, notice) : null,
          cards.length > 0 ? h('div', { className: 'cf-cards' }, cards.map(([label, value]) =>
            h('div', { className: 'cf-card', key: label },
              h('div', { className: 'cf-card-label' }, label),
              h('div', { className: 'cf-card-value' }, String(value))))) : null,
          h('div', { className: 'cf-list-head' }, tr('mapped')),
          entries.length === 0
            ? h('div', { className: 'cf-empty' }, tr('empty'))
            : h('div', { className: 'cf-rows' }, entries.map((entry) =>
              h('div', { className: 'cf-row', key: entry.sessionId },
                h('div', { className: 'cf-row-main' },
                  h('div', { className: 'cf-row-title' },
                    entry.folderName || entry.folder,
                    (entry.run ?? 0) > 0 ? h('span', { className: 'cf-badge' }, tr('runBadge', { n: entry.run })) : null),
                  h('div', { className: 'cf-row-meta' },
                    h('span', { className: 'cf-mono', title: entry.sessionId }, String(entry.sessionId).slice(0, 18) + '…'),
                    h('span', { className: 'cf-mono cf-dim' }, entry.folder),
                    formatTime(entry.assignedAt) ? h('span', { className: 'cf-dim' }, formatTime(entry.assignedAt)) : null),
                  h('div', { className: 'cf-row-meta' },
                    h('span', { className: 'cf-dim' }, tr('outputDir') + '：'),
                    entry.outputDir
                      ? h('span', { className: 'cf-mono cf-dim', title: entry.outputDir }, entry.outputDir)
                      : h('span', { className: 'cf-dim' }, tr('outputNotSet'))),
                h('div', { className: 'cf-row-actions' },
                  h('button', {
                    type: 'button', className: 'cf-btn',
                    disabled: acting === entry.sessionId,
                    onClick: () => { void openFolder(entry); }
                  }, tr('openFolder')),
                  h('button', {
                    type: 'button', className: 'cf-btn',
                    disabled: acting === entry.sessionId,
                    onClick: () => { void pickOutputDir(entry); }
                  }, tr('chooseOutputDir')),
                  entry.outputDir ? h('button', {
                    type: 'button', className: 'cf-btn',
                    disabled: acting === entry.sessionId,
                    onClick: () => { void openOutputDir(entry); }
                  }, tr('openOutputDir')) : null,
                  h('button', {
                    type: 'button', className: 'cf-btn',
                    disabled: acting === entry.sessionId,
                    onClick: () => { void organize(entry); }
                  }, tr('organize'))))))),
          h('div', { className: 'cf-panel-foot' },
            h('a', { href: REPO_URL, target: '_blank', rel: 'noreferrer' }, tr('repo')),
            status && status.stateFile ? h('span', { className: 'cf-mono cf-dim' }, status.stateFile) : null)));
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

        // locale 服务（面板跟随界面语言）；菜单文案沿用 apply 时的语言
        try {
          localeRef = typeof ctx.get === 'function' ? ctx.get('locale') : undefined;
          if (localeRef && typeof localeRef.getSnapshot === 'function') {
            activeLocale = normalizeLocale(localeRef.getSnapshot().active);
          } else if (localeRef && typeof localeRef.getLocale === 'function') {
            const current = localeRef.getLocale();
            activeLocale = normalizeLocale(current && (current.active || current.id));
          }
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

        // 侧栏「更多」里的「会话文件夹」：图标 + 管理面板
        ctx.slots.inject('sidebar.panellist', () => {
          const disposers = [];
          disposers.push(ctx.slots.register({
            name: 'main',
            key: PANEL_ID
          }, ManagementPanel));
          disposers.push(ctx.slots.register({
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 40,
            label: () => t('panelName')
          }, ((owner = {}) => folderIcon(owner.size ?? 16))));
          return () => {
            for (const disposer of disposers) {
              if (typeof disposer === 'function') disposer();
            }
          };
        });
      }
    };
  }
});
