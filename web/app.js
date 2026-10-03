/* GrapeNAS 葡萄云 Web 客户端
 * 所有内置页面都在 "/" 下，通过 JS 切换视图，不依赖任何服务端路由。
 * 与服务器的数据交互全部通过 WebSocket 完成（认证基于 cookie 中的临时令牌）。 */

// 站内路径前缀：除壳页面 "/" 外，静态资源与接口都在 /grapenas 下（见 server/config.js BASE_PATH）
const BASE = '/grapenas';

const state = { view: 'dashboard', ws: null, connected: false };
let reqId = 0;
const pending = new Map();

// ---------- WebSocket ----------

const HANDSHAKE_TIMEOUT = 5000; // 握手超时：避免永远卡在 CONNECTING
const HEARTBEAT_INTERVAL = 25000; // 心跳间隔
const HEARTBEAT_SILENCE = 50000; // 超过该时长无任何消息往来则判定假死

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}${BASE}/ws`);
  state.ws = ws;
  let lastMsgAt = Date.now();

  // 握手超时保护：设备休眠唤醒、僵尸连接占满浏览器连接数等场景下
  // onopen/onclose 都可能不触发，主动关闭以进入重连循环
  const handshakeTimer = setTimeout(() => {
    if (ws.readyState === WebSocket.CONNECTING) ws.close();
  }, HANDSHAKE_TIMEOUT);

  // 客户端心跳：服务端长时间无响应说明连接假死（TCP 不会发 FIN），主动断开重连
  const heartbeatTimer = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (Date.now() - lastMsgAt > HEARTBEAT_SILENCE) {
      ws.close();
      return;
    }
    call('ping').catch(() => {});
  }, HEARTBEAT_INTERVAL);

  ws.onopen = () => {
    clearTimeout(handshakeTimer);
    lastMsgAt = Date.now();
    state.connected = true;
    updateConnStatus();
    refreshCurrentView();
    checkStorageConfig();
    syncTheme();
    loadSidebarApps();
    syncDesktop();
  };

  ws.onmessage = (e) => {
    lastMsgAt = Date.now();
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (msg.type === 'event') return handleEvent(msg);
    if (msg.id !== undefined && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.data);
      else p.reject(new Error(msg.error));
    }
  };

  ws.onclose = (e) => {
    clearTimeout(handshakeTimer);
    clearInterval(heartbeatTimer);
    state.connected = false;
    updateConnStatus();
    if (e.code === 4401) {
      // 令牌失效，回到访问码页面
      location.replace(BASE + '/auth?redirect=' + encodeURIComponent('/'));
      return;
    }
    setTimeout(connect, 2000); // 自动重连
  };
}

function call(type, data) {
  return new Promise((resolve, reject) => {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
      return reject(new Error('连接尚未建立'));
    }
    const id = ++reqId;
    pending.set(id, { resolve, reject });
    state.ws.send(JSON.stringify({ id, type, data }));
  });
}

function handleEvent(msg) {
  if (msg.event === 'log' && state.view === 'dashboard') appendLog(msg.data);
  if (msg.event === 'theme' && msg.data) {
    currentMode = msg.data.mode;
    currentPair = msg.data.pair;
    applyTheme(msg.data.mode, msg.data.pair);
  }
  if (msg.event === 'shortcuts') {
    if (state.view === 'apps') loadApps();
  }
  // 应用在运行时刷新了自己的侧边栏入口（/grapenas/api/reload_sidebar/<id>）
  if (msg.event === 'sidebar') {
    loadSidebarApps();
  }
  // 桌面 UI 开关（任意客户端切换都会广播，保持一致）
  if (msg.event === 'desktop') {
    applyDesktop(msg.data && msg.data.enabled);
  }
}

// ---------- 侧边栏（内置入口 + 应用入口） ----------
// 侧边栏应用入口：包内 sidebar.json（多入口）或 config.json 的 sidebar（单入口）

const BUILTIN_NAV = [
  { view: 'dashboard', label: '仪表盘', icon: '/grapenas/icons/dashboard.svg' },
  { view: 'files', label: '文件管理', icon: '/grapenas/icons/files.svg' },
  { view: 'apps', label: '应用', icon: '/grapenas/icons/apps.svg' },
  { view: 'settings', label: '选项', icon: '/grapenas/icons/settings.svg' },
];

const APP_VIEW = 'appview'; // 应用侧边栏页面片段共用的视图容器
const appRuntimes = new Map();
let appsList = [];
let activeAppId = null;
let activeAppEntry = 0; // 当前打开的是该应用的第几个侧边栏入口（sidebar.json 的小标）

// 暴露给应用片段（片段注入模式下与壳页面共用同一个 document）
window.GrapenasHost = {
  call,
  toast,
  switchView,
  reloadView() {
    if (activeAppId) switchView(APP_VIEW, { app: activeAppId, force: true });
  },
};

function renderSidebar() {
  const nav = document.getElementById('navList');
  if (!nav) return;
  nav.innerHTML = '';
  const addItem = (view, label, iconUrl, appId, entry) => {
    const btn = document.createElement('button');
    btn.className = 'nav-item';
    btn.dataset.view = view;
    if (appId) btn.dataset.app = appId;
    if (entry != null) btn.dataset.entry = String(entry);
    if (state.view === view && (!appId || (appId === activeAppId && Number(entry || 0) === activeAppEntry))) {
      btn.classList.add('active');
    }
    const icon = document.createElement('img');
    icon.className = 'nav-icon-img';
    icon.alt = '';
    icon.src = iconUrl;
    btn.appendChild(icon);
    btn.appendChild(document.createTextNode(label));
    nav.appendChild(btn);
  };
  // 应用入口排在「选项」之前：一个应用可声明多个入口（包内 sidebar.json）
  // 应用没在运行（或服务端已隐藏）时不下发 sidebar，这里自然就不显示
  for (const item of BUILTIN_NAV) {
    if (item.view === 'settings') {
      for (const app of appsList) {
        const entries = app.sidebar || [];
        for (const entry of entries) {
          addItem(APP_VIEW, entry.sidebar_name, entry.iconsvg || '/grapenas/grape.svg', app.id, entry.index);
        }
      }
    }
    addItem(item.view, item.label, item.icon);
  }
  applyNavActive();
}

function applyNavActive() {
  const activeNav = NAV_OF[state.view] || state.view;
  document.querySelectorAll('.nav-item').forEach((b) => {
    const isActive =
      state.view === APP_VIEW
        ? b.dataset.app === activeAppId && Number(b.dataset.entry || 0) === activeAppEntry
        : b.dataset.view === activeNav;
    b.classList.toggle('active', isActive);
  });
}


// ==================== beta：桌面 UI ====================
// 开启后铺满窗口：壁纸 + 桌面图标（文件管理 / 应用 / 选项）+ 可拖拽、可最大化最小化的窗口

let desktopOn = false;
let deskZ = 40; // 窗口层级递增
const deskWindows = new Map(); // key -> { el, body, title, minimized }

const DESKTOP_ICONS = [
  { key: 'files', name: '文件管理', icon: '/grapenas/icons/files.svg' },
  { key: 'apps', name: '应用', icon: '/grapenas/icons/apps.svg' },
  { key: 'settings', name: '选项', icon: '/grapenas/icons/settings.svg' },
];

async function syncDesktop() {
  try {
    const res = await call('desktop.get');
    applyDesktop(Boolean(res && res.enabled));
  } catch {
    applyDesktop(false);
  }
}

function applyDesktop(on) {
  desktopOn = Boolean(on);
  const root = document.getElementById('desktopRoot');
  if (!root) return;
  root.classList.toggle('hidden', !desktopOn);
  document.body.classList.toggle('desktop-mode', desktopOn);
  renderDesktopToggle();
  if (desktopOn) {
    renderDesktopIcons();
    startDesktopClock();
  } else {
    stopDesktopClock();
    closeAllDesktopWindows();
  }
}

function toggleDesktop(on) {
  call('desktop.set', { enabled: on }).catch((err) => toast(err.message, true));
}

function renderDesktopToggle() {
  const sw = document.getElementById('desktopUiSwitch');
  if (!sw) return;
  sw.classList.toggle('on', desktopOn);
  sw.setAttribute('aria-checked', String(desktopOn));
}

// ---- 图标 ----
function renderDesktopIcons() {
  const wrap = document.getElementById('desktopIcons');
  if (!wrap) return;
  wrap.innerHTML = '';
  const add = (key, name, icon, onOpen) => {
    const btn = document.createElement('button');
    btn.className = 'desk-icon';
    btn.dataset.key = key;
    const box = document.createElement('span');
    box.className = 'desk-icon-img';
    const img = document.createElement('img');
    img.src = icon;
    img.alt = '';
    box.appendChild(img);
    const label = document.createElement('span');
    label.className = 'desk-icon-name';
    label.textContent = name;
    btn.append(box, label);
    btn.addEventListener('dblclick', onOpen);
    btn.addEventListener('click', onOpen); // 单击即开（触屏也顺手）
    wrap.appendChild(btn);
  };
  for (const it of DESKTOP_ICONS) {
    add(it.key, it.name, it.icon, () => openDesktopView(it.key, it.name));
  }
  // 应用图标：点击跳到该应用的页面
  for (const app of appsList) {
    add('app:' + app.id, app.name || app.id, BASE + '/api/apps/icon?id=' + encodeURIComponent(app.id), () => {
      if (!app.running) return toast(`应用「${app.name || app.id}」未在运行`, true);
      if (appHasSidebar(app)) {
        // 有侧边栏入口：直接切到它的第一个入口页
        switchView(APP_VIEW, { app: app.id, entry: app.sidebar[0].index || 0, force: true });
      } else if (app.webui) {
        window.open(BASE + '/' + encodeURIComponent(app.id) + '/', '_blank');
      } else {
        toast('该应用没有界面');
      }
    });
  }
}

function appHasSidebar(app) {
  return Boolean(app && Array.isArray(app.sidebar) && app.sidebar.length);
}

// ---- 窗口 ----
const DESK_ICONS_SVG = {
  min: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M5 12h14v2H5z"/></svg>',
  max: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M5 5h14v14H5V5zm2 2v10h10V7H7z"/></svg>',
  close: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7 2.9 18.3 9.2 12 2.9 5.7 4.3 4.3l6.3 6.3 6.3-6.3z"/></svg>',
};

function openDesktopWindow(key, title, render) {
  const layer = document.getElementById('desktopWindows');
  if (!layer) return null;
  const exist = deskWindows.get(key);
  if (exist) {
    exist.el.classList.remove('minimized');
    focusDesktopWindow(key);
    return exist;
  }
  const el = document.createElement('div');
  el.className = 'desk-window';
  el.dataset.key = key;
  // 层叠出现，避免完全重叠
  const offset = deskWindows.size * 28;
  const w = Math.min(920, Math.max(380, window.innerWidth - 160));
  const h = Math.min(620, Math.max(280, window.innerHeight - 180));
  el.style.width = w + 'px';
  el.style.height = h + 'px';
  el.style.left = Math.max(12, (window.innerWidth - w) / 2 - 60 + offset) + 'px';
  el.style.top = Math.max(12, (window.innerHeight - h) / 2 - 40 + offset) + 'px';

  const bar = document.createElement('div');
  bar.className = 'desk-titlebar';
  const titleEl = document.createElement('span');
  titleEl.className = 'desk-title';
  titleEl.textContent = title;
  const btnMin = document.createElement('button');
  btnMin.className = 'desk-wbtn';
  btnMin.title = '最小化';
  btnMin.innerHTML = DESK_ICONS_SVG.min;
  const btnMax = document.createElement('button');
  btnMax.className = 'desk-wbtn';
  btnMax.title = '最大化';
  btnMax.innerHTML = DESK_ICONS_SVG.max;
  const btnClose = document.createElement('button');
  btnClose.className = 'desk-wbtn close';
  btnClose.title = '关闭';
  btnClose.innerHTML = DESK_ICONS_SVG.close;
  bar.append(titleEl, btnMin, btnMax, btnClose);

  const body = document.createElement('div');
  body.className = 'desk-window-body';
  const grip = document.createElement('div');
  grip.className = 'desk-resize';
  el.append(bar, body, grip);
  layer.appendChild(el);

  const win = { el, body, bar, titleEl, minimized: false, maximized: false, prev: null };
  deskWindows.set(key, win);

  btnMin.addEventListener('click', (e) => {
    e.stopPropagation();
    win.minimized = true;
    el.classList.add('minimized');
  });
  btnMax.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleMaximize(key);
  });
  btnClose.addEventListener('click', (e) => {
    e.stopPropagation();
    closeDesktopWindow(key);
  });
  bar.addEventListener('dblclick', () => toggleMaximize(key));
  el.addEventListener('mousedown', () => focusDesktopWindow(key));

  makeDraggable(win, bar);
  makeResizable(win, grip);

  focusDesktopWindow(key);
  if (render) Promise.resolve(render(body, titleEl)).catch((err) => toast(err.message, true));
  return win;
}

function focusDesktopWindow(key) {
  const win = deskWindows.get(key);
  if (!win) return;
  deskWindows.forEach((w) => w.el.classList.remove('focused'));
  win.el.classList.add('focused');
  win.el.style.zIndex = String(++deskZ);
}

function toggleMaximize(key) {
  const win = deskWindows.get(key);
  if (!win) return;
  const el = win.el;
  if (win.maximized) {
    Object.assign(el.style, win.prev);
    el.classList.remove('maximized');
    win.maximized = false;
  } else {
    win.prev = { left: el.style.left, top: el.style.top, width: el.style.width, height: el.style.height };
    el.classList.add('maximized');
    Object.assign(el.style, { left: '0px', top: '0px', width: '100%', height: 'calc(100% - 52px)' });
    win.maximized = true;
  }
  focusDesktopWindow(key);
}

function closeDesktopWindow(key) {
  const win = deskWindows.get(key);
  if (!win) return;
  const body = win.body;
  const mod = body.__grapenasModule;
  if (mod && typeof mod.unmount === 'function') {
    try {
      mod.unmount();
    } catch {
      /* 卸载失败不影响关闭 */
    }
    body.__grapenasModule = null;
  }
  win.el.remove();
  deskWindows.delete(key);
}

function closeAllDesktopWindows() {
  for (const key of Array.from(deskWindows.keys())) closeDesktopWindow(key);
}

function makeDraggable(win, handle) {
  let sx = 0;
  let sy = 0;
  let ox = 0;
  let oy = 0;
  let dragging = false;
  handle.addEventListener('mousedown', (e) => {
    if (e.target.closest('.desk-wbtn')) return;
    if (win.maximized) return;
    dragging = true;
    sx = e.clientX;
    sy = e.clientY;
    ox = parseFloat(win.el.style.left) || 0;
    oy = parseFloat(win.el.style.top) || 0;
    e.preventDefault();
    const move = (ev) => {
      if (!dragging) return;
      const nx = Math.max(-40, ox + ev.clientX - sx);
      const ny = Math.max(0, oy + ev.clientY - sy);
      win.el.style.left = nx + 'px';
      win.el.style.top = ny + 'px';
    };
    const up = () => {
      dragging = false;
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
}

function makeResizable(win, grip) {
  let sx = 0;
  let sy = 0;
  let ow = 0;
  let oh = 0;
  grip.addEventListener('mousedown', (e) => {
    if (win.maximized) return;
    sx = e.clientX;
    sy = e.clientY;
    ow = parseFloat(win.el.style.width) || win.el.offsetWidth;
    oh = parseFloat(win.el.style.height) || win.el.offsetHeight;
    e.preventDefault();
    e.stopPropagation();
    const move = (ev) => {
      win.el.style.width = Math.max(320, ow + ev.clientX - sx) + 'px';
      win.el.style.height = Math.max(200, oh + ev.clientY - sy) + 'px';
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
}

// 打开一个「内置视图」窗口：内容渲染到窗口里，不影响主界面的当前视图
function openDesktopView(key, name) {
  openDesktopWindow(key, name, async (body, titleEl) => {
    if (key === 'files') {
      await renderFilesInto(body);
    } else if (key === 'apps') {
      await renderAppsInto(body);
    } else if (key === 'settings') {
      renderSettingsInto(body);
    } else {
      body.innerHTML = '<p class="muted">暂不支持</p>';
    }
    titleEl.textContent = name;
  });
}

// ---- 复用的视图渲染（支持渲染到任意容器；主视图走同一套函数） ----
function panel(container, title, extraClass) {
  const sec = document.createElement('section');
  sec.className = 'view' + (extraClass ? ' ' + extraClass : '');
  const head = document.createElement('div');
  head.className = 'view-header';
  const h2 = document.createElement('h2');
  h2.textContent = title;
  head.appendChild(h2);
  sec.appendChild(head);
  container.appendChild(sec);
  return sec;
}

function renderSettingsInto(container) {
  container.innerHTML = '';
  const sec = panel(container, '选项');
  const ul = document.createElement('ul');
  ul.className = 'menu-list';
  const items = [
    { label: '重启葡萄云', danger: true },
    { label: '个性化设置', goto: 'personalization' },
    { label: '安全设置', goto: 'security' },
    { label: '存储设置', goto: 'storagesettings' },
  ];
  for (const it of items) {
    const li = document.createElement('li');
    li.className = 'menu-item' + (it.danger ? ' menu-item-danger' : '');
    const span = document.createElement('span');
    span.textContent = it.label;
    li.appendChild(span);
    if (it.goto) {
      const arrow = document.createElement('span');
      arrow.className = 'menu-arrow';
      arrow.textContent = '›';
      li.appendChild(arrow);
      li.addEventListener('click', () => {
        closeAllDesktopWindows();
        switchView(it.goto);
      });
    } else {
      li.addEventListener('click', () => {
        if (window.confirm('确认重启葡萄云？')) call('system.restart').catch((err) => toast(err.message, true));
      });
    }
    ul.appendChild(li);
  }
  sec.appendChild(ul);
}

function renderAppsInto(container) {
  return new Promise((resolve) => {
    container.innerHTML = '<p class="muted">加载中…</p>';
    Promise.all([call('apps.list'), call('shortcuts.list')])
      .then(([apps, shortcuts]) => {
        container.innerHTML = '';
        const sec = panel(container, '应用');
        const grid = document.createElement('div');
        grid.className = 'apps-grid';
        for (const app of apps) {
          const card = document.createElement('div');
          card.className = 'app-card';
          const ic = document.createElement('img');
          ic.className = 'app-icon';
          ic.src = BASE + '/api/apps/icon?id=' + encodeURIComponent(app.id);
          ic.alt = '';
          const nm = document.createElement('div');
          nm.className = 'app-name';
          nm.textContent = app.name || app.id;
          const st = document.createElement('div');
          st.className = 'app-state ' + (app.running ? 'ok' : 'off');
          st.textContent = app.running ? '运行中' : '已停止';
          card.append(ic, nm, st);
          card.addEventListener('click', () => {
            if (!app.running) {
              toast('应用未在运行，正在启动…');
              call('apps.start', { id: app.id }).then(() => toast('已启动')).catch((e) => toast(e.message, true));
              return;
            }
            if (appHasSidebar(app)) {
              closeAllDesktopWindows();
              switchView(APP_VIEW, { app: app.id, entry: app.sidebar[0].index || 0, force: true });
            } else if (app.webui) {
              window.open(BASE + '/' + encodeURIComponent(app.id) + '/', '_blank');
            } else {
              toast('该应用没有界面');
            }
          });
          grid.appendChild(card);
        }
        if (!apps.length) grid.innerHTML = '<p class="muted">还没有安装应用</p>';
        sec.appendChild(grid);
        if (shortcuts && shortcuts.length) {
          const h3 = document.createElement('h3');
          h3.textContent = '快捷方式';
          h3.className = 'section-sub';
          sec.appendChild(h3);
          const row = document.createElement('div');
          row.className = 'shortcut-row';
          for (const sc of shortcuts) {
            const b = document.createElement('button');
            b.className = 'shortcut-btn';
            b.textContent = sc.name;
            b.addEventListener('click', () => call('shortcuts.launch', { id: sc.id }).then(() => toast('已启动 ' + sc.name)).catch((e) => toast(e.message, true)));
            row.appendChild(b);
          }
          sec.appendChild(row);
        }
        resolve();
      })
      .catch((err) => {
        container.innerHTML = '';
        const sec = panel(container, '应用');
        const p = document.createElement('p');
        p.className = 'muted';
        p.textContent = '加载失败：' + err.message;
        sec.appendChild(p);
        resolve();
      });
  });
}

// 文件管理窗口：自带状态与渲染（与主视图的文件页互不影响）
function renderFilesInto(container) {
  return new Promise((resolve) => {
    container.innerHTML = '';
    const sec = panel(container, '文件管理', 'files-view');

    let cwd = ''; // 相对存储根：''=根，'user/xx'=某目录

    const toolbar = document.createElement('div');
    toolbar.className = 'files-toolbar';
    const mk = (label) => {
      const b = document.createElement('button');
      b.className = 'btn small';
      b.textContent = label;
      return b;
    };
    const up = mk('上一级');
    const mkdir = mk('新建文件夹');
    const upload = mk('上传文件');
    const btnRefresh = mk('刷新');
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.multiple = true;
    fileInput.hidden = true;
    toolbar.append(up, mkdir, upload, btnRefresh, fileInput);

    const crumbs = document.createElement('div');
    crumbs.className = 'crumbs';
    const list = document.createElement('div');
    list.className = 'file-list';
    sec.append(toolbar, crumbs, list);

    const drawer = document.createElement('div');
    drawer.className = 'desk-drawer hidden';
    sec.appendChild(drawer);

    const segsOf = () => {
      const out = [{ label: '文件管理', path: '' }];
      if (cwd) {
        const parts = cwd.split('/').filter(Boolean);
        let cur = '';
        for (const p of parts) {
          cur = cur ? cur + '/' + p : p;
          out.push({ label: p === 'user' ? '我的文件' : p === '.package' ? '应用文件' : p, path: cur });
        }
      }
      return out;
    };

    const paintCrumbs = () => {
      crumbs.innerHTML = '';
      const segs = segsOf();
      segs.forEach((seg, i) => {
        const el = document.createElement('span');
        el.className = 'crumb' + (i === segs.length - 1 ? ' current' : '');
        el.textContent = seg.label;
        if (i !== segs.length - 1) {
          el.addEventListener('click', () => {
            cwd = seg.path;
            refresh();
          });
        }
        crumbs.appendChild(el);
        if (i !== segs.length - 1) {
          const sep = document.createElement('span');
          sep.className = 'crumb-sep';
          sep.textContent = '›';
          crumbs.appendChild(sep);
        }
      });
    };

    const doUpload = async (file) => {
      const res = await fetch(
        BASE + '/api/files/upload?path=' + encodeURIComponent(cwd) + '&name=' + encodeURIComponent(file.name),
        { method: 'POST', body: file }
      );
      const d = await res.json();
      if (!d.ok) throw new Error(d.error || '上传失败');
    };

    const openDrawer = (title, build) => {
      drawer.innerHTML = '';
      drawer.classList.remove('hidden');
      const head = document.createElement('div');
      head.className = 'desk-drawer-head';
      const t = document.createElement('b');
      t.textContent = title;
      const x = document.createElement('button');
      x.className = 'desk-wbtn close';
      x.textContent = '✕';
      x.addEventListener('click', () => drawer.classList.add('hidden'));
      head.append(t, x);
      const bodyEl = document.createElement('div');
      bodyEl.className = 'desk-drawer-body';
      drawer.append(head, bodyEl);
      build(bodyEl);
    };

    const refresh = async () => {
      paintCrumbs();
      // 根目录：与主视图一致，先给「我的文件 / 应用文件」两个入口
      if (!cwd) {
        list.innerHTML = '';
        for (const [rel, label] of [
          ['user', '我的文件'],
          ['.package', '应用文件'],
        ]) {
          const row = document.createElement('div');
          row.className = 'file-row is-dir';
          row.innerHTML =
            '<span class="file-icon"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg></span>' +
            '<span class="file-name">' +
            label +
            '</span><span class="file-size">目录</span>';
          row.addEventListener('click', () => {
            cwd = rel;
            refresh();
          });
          list.appendChild(row);
        }
        resolve();
        return;
      }
      list.innerHTML = '<p class="muted">加载中…</p>';
      try {
        const data = await call('files.list', { path: cwd });
        const entries = (data && data.entries) || [];
        list.innerHTML = '';
        if (!entries.length) {
          list.innerHTML = '<p class="muted">这个目录是空的</p>';
        }
        for (const e of entries) {
          const row = document.createElement('div');
          row.className = 'file-row' + (e.dir ? ' is-dir' : '');
          const icon = document.createElement('span');
          icon.className = 'file-icon';
          icon.innerHTML = e.dir
            ? '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>'
            : '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zM13 9V3.5L18.5 9H13z"/></svg>';
          const name = document.createElement('span');
          name.className = 'file-name';
          name.textContent = e.name;
          const size = document.createElement('span');
          size.className = 'file-size';
          size.textContent = e.dir ? '目录' : formatSize(e.size);
          const acts = document.createElement('span');
          acts.className = 'file-acts';
          if (!e.dir) {
            const dl = document.createElement('button');
            dl.className = 'btn small';
            dl.textContent = '下载';
            dl.addEventListener('click', (ev) => {
              ev.stopPropagation();
              const a = document.createElement('a');
              a.href = BASE + '/api/files/download?path=' + encodeURIComponent(cwd ? cwd + '/' + e.name : e.name);
              a.click();
            });
            acts.appendChild(dl);
          }
          const rm = document.createElement('button');
          rm.className = 'btn small danger';
          rm.textContent = '删除';
          rm.addEventListener('click', async (ev) => {
            ev.stopPropagation();
            if (!window.confirm('删除「' + e.name + '」？')) return;
            try {
              await call('files.delete', { path: cwd ? cwd + '/' + e.name : e.name });
              toast('已删除 ' + e.name);
              refresh();
            } catch (err) {
              toast(err.message, true);
            }
          });
          acts.appendChild(rm);
          row.append(icon, name, size, acts);
          row.addEventListener('click', () => {
            if (e.dir) {
              cwd = cwd ? cwd + '/' + e.name : e.name;
              refresh();
            }
          });
          list.appendChild(row);
        }
        resolve();
      } catch (err) {
        list.innerHTML = '';
        const p = document.createElement('p');
        p.className = 'muted';
        p.textContent = '读取失败：' + err.message;
        list.appendChild(p);
        resolve();
      }
    };

    up.addEventListener('click', () => {
      if (!cwd) return;
      const parts = cwd.split('/').filter(Boolean);
      parts.pop();
      cwd = parts.join('/');
      refresh();
    });
    btnRefresh.addEventListener('click', () => refresh());
    upload.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      const files = Array.from(fileInput.files || []);
      fileInput.value = '';
      for (const f of files) {
        try {
          await doUpload(f);
          toast('已上传 ' + f.name);
        } catch (err) {
          toast(f.name + ' 上传失败：' + err.message, true);
        }
      }
      refresh();
    });
    mkdir.addEventListener('click', () => {
      openDrawer('新建文件夹', (bodyEl) => {
        const input = document.createElement('input');
        input.className = 'input';
        input.placeholder = '文件夹名称';
        const ok = document.createElement('button');
        ok.className = 'btn';
        ok.textContent = '创建';
        ok.addEventListener('click', async () => {
          const name = input.value.trim();
          if (!name) return toast('请输入名称', true);
          try {
            await call('files.mkdir', { path: cwd, name });
            toast('已创建 ' + name);
            drawer.classList.add('hidden');
            refresh();
          } catch (err) {
            toast(err.message, true);
          }
        });
        bodyEl.append(input, ok);
      });
    });

    refresh();
  });
}

function formatSize(n) {
  const v = Number(n) || 0;
  if (v < 1024) return v + ' B';
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB';
  if (v < 1024 * 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + ' MB';
  return (v / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

// 桌面时钟
let desktopClockTimer = 0;
function startDesktopClock() {
  stopDesktopClock();
  const tick = () => {
    const el = document.getElementById('desktopClock');
    if (el) el.textContent = new Date().toLocaleString('zh-CN', { hour12: false });
  };
  tick();
  desktopClockTimer = setInterval(tick, 1000);
}
function stopDesktopClock() {
  if (desktopClockTimer) clearInterval(desktopClockTimer);
  desktopClockTimer = 0;
}

// 侧边栏入口来自应用列表（应用包 config.json 的 sidebar 字段）
async function loadSidebarApps() {
  try {
    appsList = (await call('apps.list')) || [];
  } catch {
    appsList = [];
  }
  renderSidebar();
}

function updateConnStatus() {
  const el = document.getElementById('connStatus');
  el.textContent = state.connected ? '已连接' : '连接断开，重连中…';
  el.classList.toggle('ok', state.connected);
}

// ---------- 视图切换（无路由，纯状态） ----------

const VIEW_LOADERS = {
  dashboard: loadDashboard,
  files: loadFilesView,
  apps: loadApps,
  [APP_VIEW]: loadAppView,
  accesscode: loadAccessCode,
  proxy: loadProxyView,
  security: loadSecurityView,
  personalization: loadPersonalizationView,
  themecolor: loadThemeColorView,
  storagesettings: loadStorageSettingsView,
  storagelocation: loadStorageLocation,
};

// 子页面归属的顶级导航项（高亮用）
const NAV_OF = {
  dashboard: 'dashboard',
  files: 'files',
  apps: 'apps',
  settings: 'settings',
  personalization: 'settings',
  themecolor: 'settings',
  proxy: 'settings', // 反向代理属于"选项"
  security: 'settings',
  accesscode: 'settings',
  storagesettings: 'settings',
  storagelocation: 'settings',
};

function switchView(view, options = {}) {
  // 离开应用视图：卸载片段（断开连接、清定时器与全局事件）
  if (state.view === APP_VIEW && view !== APP_VIEW) unmountAppView();
  state.view = view;
  if (view === APP_VIEW && options.app) {
    activeAppId = options.app;
    activeAppEntry = Number(options.entry || 0);
  }
  if (options.force) appRuntimes.delete(activeAppId);
  document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'));
  const section = document.getElementById('view-' + view);
  if (section) section.classList.remove('hidden');
  applyNavActive();
  document.body.classList.remove('nav-open'); // 手机端选择页面后收起抽屉
  if (state.connected) refreshCurrentView();
}

function refreshCurrentView() {
  const loader = VIEW_LOADERS[state.view];
  if (loader) loader();
}

// ---------- 仪表盘：系统信息 + 日志 ----------

async function loadDashboard() {
  try {
    const [info, logs] = await Promise.all([call('sys.info'), call('logs.list')]);
    renderSysInfo(info);
    const list = document.getElementById('logList');
    list.innerHTML = '';
    logs.forEach(appendLog);
  } catch (err) {
    toast(err.message, true);
  }
}

function renderSysInfo(info) {
  const usedMem = info.totalMem - info.freeMem;
  const memPct = Math.round((usedMem / info.totalMem) * 100);
  const cards = [
    ['主机名', info.hostname],
    ['系统', `${info.platform} ${info.release} (${info.arch})`],
    ['CPU', `${escapeHtml(info.cpuModel)} × ${info.cpuCores}`],
    ['内存', `${formatBytes(usedMem)} / ${formatBytes(info.totalMem)}（${memPct}%）`],
    ['系统运行时间', formatUptime(info.osUptime)],
    ['服务运行时间', formatUptime(info.serverUptime)],
    ['Node 版本', info.nodeVersion],
    ['服务器时间', new Date(info.serverTime).toLocaleString()],
  ];
  document.getElementById('sysCards').innerHTML = cards
    .map(([label, value]) => `<div class="card"><div class="card-label">${label}</div><div class="card-value">${value}</div></div>`)
    .join('');
}

function appendLog(entry) {
  const list = document.getElementById('logList');
  const div = document.createElement('div');
  div.className = 'log-line';
  const time = new Date(entry.time).toLocaleTimeString();
  div.innerHTML = `<span class="log-time">${time}</span><span class="log-level ${entry.level}">${entry.level.toUpperCase()}</span><span class="log-msg"></span>`;
  div.querySelector('.log-msg').textContent = entry.message;
  list.appendChild(div);
  list.scrollTop = list.scrollHeight;
}

// ---------- 面包屑（统一渲染 + 溢出折叠） ----------
// segments: [{ label, click?, current? }]

function renderCrumbs(el, segments) {
  const build = (list) => {
    el.innerHTML = '';
    list.forEach((seg, i) => {
      if (i > 0) {
        const sep = document.createElement('span');
        sep.className = 'crumb-sep';
        sep.textContent = '>';
        el.appendChild(sep);
      }
      if (seg.current) {
        const c = document.createElement('span');
        c.className = 'crumb-current';
        c.textContent = seg.label;
        el.appendChild(c);
      } else {
        const b = document.createElement('button');
        b.className = 'crumb';
        b.type = 'button';
        b.textContent = seg.label;
        b.addEventListener('click', seg.click);
        el.appendChild(b);
      }
    });
  };
  build(segments);
  // 屏幕放不下时折叠中间段为"…"，点击弹窗选择前往位置
  if (segments.length > 3 && el.scrollWidth > el.clientWidth + 2) {
    const first = segments[0];
    const secondLast = segments[segments.length - 2];
    const last = segments[segments.length - 1];
    const collapsed = segments.slice(1, -2);
    const shown = [first];
    if (collapsed.length) {
      shown.push({
        label: '…',
        click: () => openCrumbsModal(segments),
      });
    }
    shown.push(secondLast, last);
    build(shown);
  }
}

function openCrumbsModal(segments) {
  const list = document.getElementById('breadcrumbList');
  list.innerHTML = '';
  segments.forEach((seg) => {
    if (seg.current) return;
    const btn = document.createElement('button');
    btn.className = 'menu-item';
    const span = document.createElement('span');
    span.textContent = seg.label;
    btn.appendChild(span);
    btn.addEventListener('click', () => {
      closeModal();
      seg.click();
    });
    list.appendChild(btn);
  });
  openModal('modalBreadcrumb');
}

// ---------- 存储位置 ----------

async function checkStorageConfig() {
  try {
    const s = await call('storage.get');
    document.getElementById('storageOverlay').classList.toggle('hidden', s.configured);
  } catch {
    /* 连接未就绪时忽略 */
  }
}

async function loadStorageLocation() {
  renderCrumbs(document.getElementById('crumbsStoragelocation'), [
    { label: '选项', click: () => switchView('settings') },
    { label: '存储设置', click: () => switchView('storagesettings') },
    { label: '存储位置', current: true },
  ]);
  try {
    const s = await call('storage.get');
    document.getElementById('storageStatus').textContent = s.configured
      ? `当前存储位置：${s.path}`
      : '尚未配置存储位置';
  } catch (err) {
    toast(err.message, true);
  }
}

// 安全设置 / 存储设置 列表页：渲染面包屑
function loadSecurityView() {
  renderCrumbs(document.getElementById('crumbsSecurity'), [
    { label: '选项', click: () => switchView('settings') },
    { label: '安全设置', current: true },
  ]);
}

function loadStorageSettingsView() {
  renderCrumbs(document.getElementById('crumbsStoragesettings'), [
    { label: '选项', click: () => switchView('settings') },
    { label: '存储设置', current: true },
  ]);
}

// ---------- 个性化设置 / 页面颜色 ----------

const BG_MODES = {
  dark: { name: '深色', color: '#100c1c' },
  light: { name: '浅色', color: '#f4f4f8' },
};
// 主题配色对：紫/蓝/橙/黄为固定色；黑白随背景切换（深色配白、浅色配黑）
const THEME_PAIRS = {
  purple: { name: '紫', fixed: '#8b5cf6' },
  blue: { name: '蓝', fixed: '#3b82f6' },
  orange: { name: '橙', fixed: '#f97316' },
  yellow: { name: '黄', fixed: '#eab308' },
  mono: { name: '黑白', dark: '#ffffff', light: '#111111' },
};

let currentMode = 'dark';
let currentPair = 'purple';

function loadPersonalizationView() {
  renderCrumbs(document.getElementById('crumbsPersonalization'), [
    { label: '选项', click: () => switchView('settings') },
    { label: '个性化设置', current: true },
  ]);
  renderDesktopToggle();
}

async function loadThemeColorView() {
  renderCrumbs(document.getElementById('crumbsThemecolor'), [
    { label: '选项', click: () => switchView('settings') },
    { label: '个性化设置', click: () => switchView('personalization') },
    { label: '页面颜色', current: true },
  ]);
  try {
    const t = await call('theme.get');
    currentMode = t.mode;
    currentPair = t.pair;
    renderModeSwatches();
    renderPairSwatches();
  } catch (err) {
    toast(err.message, true);
  }
}

function accentOf(mode, pair) {
  const def = THEME_PAIRS[pair] || THEME_PAIRS.purple;
  if (def.fixed) return def.fixed;
  return mode === 'dark' ? def.dark : def.light;
}

function renderModeSwatches() {
  const wrap = document.getElementById('bgModeSwatches');
  wrap.innerHTML = '';
  for (const [mode, def] of Object.entries(BG_MODES)) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mode-swatch' + (mode === currentMode ? ' active' : '');
    btn.textContent = def.name;
    btn.style.background = def.color;
    btn.style.color = luminance(def.color) > 0.5 ? '#1c1730' : '#e5e0f5';
    btn.addEventListener('click', () => saveMode(mode));
    wrap.appendChild(btn);
  }
}

function renderPairSwatches() {
  const wrap = document.getElementById('themeSwatches');
  wrap.innerHTML = '';
  for (const [pair, def] of Object.entries(THEME_PAIRS)) {
    const sw = document.createElement('button');
    sw.type = 'button';
    sw.className = 'theme-swatch' + (pair === currentPair ? ' active' : '');
    sw.style.background = accentOf(currentMode, pair);
    sw.title = def.name;
    sw.addEventListener('click', () => savePair(pair));
    wrap.appendChild(sw);
  }
}

async function saveMode(mode) {
  try {
    const t = await call('theme.set', { mode });
    currentMode = t.mode;
    currentPair = t.pair;
    applyTheme(currentMode, currentPair);
    renderModeSwatches();
    renderPairSwatches();
  } catch (err) {
    toast(err.message, true);
  }
}

async function savePair(pair) {
  try {
    const t = await call('theme.set', { pair });
    currentMode = t.mode;
    currentPair = t.pair;
    applyTheme(currentMode, currentPair);
    renderPairSwatches();
  } catch (err) {
    toast(err.message, true);
  }
}

// 颜色工具
function shadeHex(color, factor) {
  const n = parseInt(color.slice(1), 16);
  let r = (n >> 16) & 255;
  let g = (n >> 8) & 255;
  let b = n & 255;
  if (factor <= 1) {
    r = Math.round(r * factor);
    g = Math.round(g * factor);
    b = Math.round(b * factor);
  } else {
    const f = factor - 1;
    r = Math.round(r + (255 - r) * f);
    g = Math.round(g + (255 - g) * f);
    b = Math.round(b + (255 - b) * f);
  }
  return `rgb(${r}, ${g}, ${b})`;
}

function mixHex(a, b, t) {
  const na = parseInt(a.slice(1), 16);
  const nb = parseInt(b.slice(1), 16);
  const ch = (x, y) => Math.round(x + (y - x) * t);
  return `rgb(${ch((na >> 16) & 255, (nb >> 16) & 255)}, ${ch((na >> 8) & 255, (nb >> 8) & 255)}, ${ch(na & 255, nb & 255)})`;
}

function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

// 应用页面颜色：模式决定背景与文字色系，配色对按模式取深/浅变体
function applyTheme(mode, pair) {
  const m = mode === 'light' ? 'light' : 'dark';
  const p = THEME_PAIRS[pair] ? pair : 'purple';
  const bg = BG_MODES[m].color;
  const accent = accentOf(m, p);
  const dark = m === 'dark';
  const root = document.documentElement.style;
  const n = parseInt(accent.slice(1), 16);
  root.setProperty('--accent', accent);
  root.setProperty('--accent-dark', shadeHex(accent, 0.72));
  root.setProperty('--accent-mid', shadeHex(accent, 0.85));
  root.setProperty('--accent-light', dark ? shadeHex(accent, 1.35) : shadeHex(accent, 0.68));
  root.setProperty('--accent-rgb', `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`);
  // 主题色作背景时的文字色：偏黑主题配白字，偏白主题配黑字
  root.setProperty('--accent-contrast', luminance(accent) < 0.5 ? '#ffffff' : '#111111');
  root.setProperty('--bg', bg);
  if (dark) {
    // 深色模式：侧边栏比内容区更深
    root.setProperty('--bg-panel', shadeHex(bg, 0.62));
    root.setProperty('--bg-card', mixHex(bg, '#ffffff', 0.08));
    root.setProperty('--bg-deep', shadeHex(bg, 0.45));
    root.setProperty('--bg-elevated', mixHex(bg, '#ffffff', 0.16));
    root.setProperty('--bg-input', 'rgba(0, 0, 0, 0.3)');
    root.setProperty('--text', '#e5e0f5');
    root.setProperty('--text-2', '#cfc7ee');
    root.setProperty('--text-muted', '#a89ecf');
    root.setProperty('--text-faint', '#6b6390');
  } else {
    // 浅色模式：侧边栏比内容区更浅
    root.setProperty('--bg-panel', mixHex(bg, '#ffffff', 0.6));
    root.setProperty('--bg-card', mixHex(bg, '#ffffff', 0.55));
    root.setProperty('--bg-deep', shadeHex(bg, 0.93));
    root.setProperty('--bg-elevated', '#ffffff');
    root.setProperty('--bg-input', 'rgba(0, 0, 0, 0.05)');
    root.setProperty('--text', '#1c1730');
    root.setProperty('--text-2', '#3a3352');
    root.setProperty('--text-muted', '#6b6390');
    root.setProperty('--text-faint', '#8a84a3');
  }
  try {
    localStorage.setItem('grapenas_theme_mode', m);
    localStorage.setItem('grapenas_theme_pair', p);
  } catch {
    /* 忽略 */
  }
}

// 启动时先用本地缓存立即上色，随后与服务端同步
(function initTheme() {
  try {
    const cachedMode = localStorage.getItem('grapenas_theme_mode');
    const cachedPair = localStorage.getItem('grapenas_theme_pair');
    if (cachedMode || cachedPair) applyTheme(cachedMode || 'dark', cachedPair || 'purple');
  } catch {
    /* 忽略 */
  }
})();

async function syncTheme() {
  try {
    const t = await call('theme.get');
    currentMode = t.mode;
    currentPair = t.pair;
    applyTheme(t.mode, t.pair);
  } catch {
    /* 忽略 */
  }
}

// ---------- // 应用侧边栏视图（应用包里的页面片段注入这里） ----------

// 片段内的相对资源统一走 sidebar-asset 接口（服务端已改写 HTML 里的相对路径，这里兜住 JS 动态引用）
// 片段内的相对资源统一走 sidebar-asset 接口（要带 entry 才能定位到具体入口的 page）
function rewriteFragmentUrl(value, appId, entryIndex) {
  if (!value) return value;
  const v = String(value).trim();
  if (/^(?:[a-z]+:|\/\/|#|data:|blob:)/i.test(v)) return v;
  if (v.startsWith(BASE + '/api/apps/sidebar-asset')) return v;
  const file = v.startsWith('/') ? v.slice(1) : v;
  return (
    BASE +
    '/api/apps/sidebar-asset?id=' +
    encodeURIComponent(appId) +
    '&entry=' +
    encodeURIComponent(entryIndex || 0) +
    '&file=' +
    encodeURIComponent(file)
  );
}

// 片段脚本串行执行，保证依赖顺序
function loadFragmentScript(url) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url;
    s.async = false;
    s.dataset.appScript = '1';
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('片段脚本加载失败: ' + url));
    document.head.appendChild(s);
  });
}

async function loadAppView() {
  const host = document.getElementById('appViewHost');
  if (!activeAppId) return;
  const app = appsList.find((a) => a.id === activeAppId);
  const appId = activeAppId;
  const entries = (app && app.sidebar) || [];
  const entry = entries.find((e) => Number(e.index) === activeAppEntry) || entries[0];
  renderCrumbs(document.getElementById('appViewCrumbs'), [
    { label: (entry && entry.sidebar_name) || (app && app.name) || appId, current: true },
  ]);
  host.innerHTML = '<p class="muted">正在加载应用页面…</p>';
  try {
    if (!app) throw new Error('应用不存在: ' + appId);
    if (!entry) throw new Error('应用 ' + appId + ' 没有可用的侧边栏入口');
    const res = await fetch(
      BASE + '/api/apps/sidebar?id=' + encodeURIComponent(appId) + '&entry=' + encodeURIComponent(entry.index),
      { credentials: 'same-origin' }
    );
    if (!res.ok) throw new Error('应用页面加载失败（HTTP ' + res.status + '）');
    await mountAppFragment(host, await res.text(), appId, entry.index);
    appRuntimes.set(appId, { api: window.GrapenasModule });
  } catch (err) {
    host.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = err.message;
    host.appendChild(p);
  }
}

async function mountAppFragment(host, html, appId, entryIndex = 0) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const frag = tpl.content;
  frag.querySelectorAll('link[rel="stylesheet"], style').forEach((node) => {
    if (node.tagName === 'LINK') {
      node.setAttribute('href', rewriteFragmentUrl(node.getAttribute('href'), appId, entryIndex));
    }
    node.dataset.appStyle = appId;
    document.head.appendChild(node);
  });
  const scripts = [...frag.querySelectorAll('script')];
  scripts.forEach((s) => s.remove());
  host.innerHTML = '';
  host.appendChild(frag);
  const rootEl = host.firstElementChild;
  for (const old of scripts) {
    if (old.src) {
      await loadFragmentScript(rewriteFragmentUrl(old.getAttribute('src'), appId, entryIndex));
    } else {
      const s = document.createElement('script');
      s.textContent = old.textContent;
      s.dataset.appScript = '1';
      document.head.appendChild(s);
    }
  }
  // 应用片段可注册 window.GrapenasModule = { mount(root), unmount() }（可选）
  const api = window.GrapenasModule;
  if (api && typeof api.mount === 'function') api.mount(rootEl);
}

function unmountAppView() {
  const api = window.GrapenasModule;
  try {
    if (api && typeof api.unmount === 'function') api.unmount();
  } catch {
    /* 片段卸载异常不应影响切换 */
  }
  appRuntimes.delete(activeAppId);
  document.querySelectorAll('script[data-app-script]').forEach((s) => s.remove());
  document.querySelectorAll('[data-app-style]').forEach((n) => n.remove());
  const host = document.getElementById('appViewHost');
  if (host) host.innerHTML = '';
  window.GrapenasModule = undefined;
}

async function submitStoragePath(inputId, errorId) {
  const p = document.getElementById(inputId).value.trim();
  const errEl = document.getElementById(errorId);
  errEl.textContent = '';
  try {
    await call('storage.set', { path: p });
    toast('存储位置已设置');
    location.reload();
  } catch (err) {
    errEl.textContent = err.message;
  }
}

// ---------- 文件管理 ----------

let filesPath = null; // null = 根（我的文件/应用文件），否则为存储内相对路径

async function loadFilesView() {
  renderFilesCrumbs();
  const content = document.getElementById('filesContent');
  if (filesPath === null) {
    content.innerHTML = '';
    const ul = document.createElement('ul');
    ul.className = 'menu-list';
    ul.appendChild(makeFilesEntry('user', '我的文件'));
    ul.appendChild(makeFilesEntry('.package', '应用文件'));
    content.appendChild(ul);
    return;
  }
  try {
    const data = await call('files.list', { path: filesPath });
    renderFilesBrowser(content, data.entries);
  } catch (err) {
    content.innerHTML = `<p class="muted">${escapeHtml(err.message)}</p>`;
  }
}

function makeFilesEntry(rel, label) {
  const li = document.createElement('li');
  li.className = 'menu-item';
  const span = document.createElement('span');
  const b = document.createElement('b');
  b.textContent = label;
  span.appendChild(b);
  const arrow = document.createElement('span');
  arrow.className = 'menu-arrow';
  arrow.textContent = '›';
  li.append(span, arrow);
  li.addEventListener('click', () => {
    filesPath = rel;
    loadFilesView();
  });
  return li;
}

function renderFilesCrumbs() {
  const segs = [];
  if (filesPath === null) {
    // 文件管理根：当前页，不可点
    segs.push({ label: '文件管理', current: true });
  } else {
    segs.push({ label: '文件管理', click: () => { filesPath = null; loadFilesView(); } });
    const parts = filesPath.split('/');
    let cur = '';
    parts.forEach((part, i) => {
      const segPath = cur ? cur + '/' + part : part; // 每段捕获自己的路径（闭包陷阱）
      cur = segPath;
      const label = part === 'user' ? '我的文件' : part === '.package' ? '应用文件' : part;
      if (i === parts.length - 1) segs.push({ label, current: true });
      else segs.push({ label, click: () => { filesPath = segPath; loadFilesView(); } });
    });
  }
  renderCrumbs(document.getElementById('filesCrumbs'), segs);
}

const FILE_ICON =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zM13 9V3.5L18.5 9H13z"/></svg>';
const DIR_ICON =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>';

function filesRel(name) {
  return filesPath ? filesPath + '/' + name : name;
}

function renderFilesBrowser(content, entries) {
  content.innerHTML = '';
  const toolbar = document.createElement('div');
  toolbar.className = 'file-toolbar';
  const up = document.createElement('button');
  up.className = 'btn small';
  up.textContent = '上传文件';
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.multiple = true;
  fileInput.hidden = true;
  up.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    for (const f of fileInput.files) {
      try {
        const res = await fetch(
          BASE + '/api/files/upload?path=' + encodeURIComponent(filesPath || '') + '&name=' + encodeURIComponent(f.name),
          { method: 'POST', body: f }
        );
        const d = await res.json();
        if (!d.ok) throw new Error(d.error || '上传失败');
      } catch (err) {
        toast(err.message, true);
      }
    }
    fileInput.value = '';
    loadFilesView();
  });
  const mk = document.createElement('button');
  mk.className = 'btn small';
  mk.textContent = '新建文件夹';
  mk.addEventListener('click', async () => {
    const name = prompt('文件夹名称');
    if (!name) return;
    try {
      await call('files.mkdir', { path: filesPath, name });
      loadFilesView();
    } catch (err) {
      toast(err.message, true);
    }
  });
  const rf = document.createElement('button');
  rf.className = 'btn small';
  rf.textContent = '刷新';
  rf.addEventListener('click', loadFilesView);
  toolbar.append(up, fileInput, mk, rf);
  content.appendChild(toolbar);

  const list = document.createElement('div');
  list.className = 'file-list';
  if (!entries.length) {
    const empty = document.createElement('p');
    empty.className = 'file-empty';
    empty.textContent = '此文件夹为空';
    list.appendChild(empty);
  }
  for (const e of entries) {
    const row = document.createElement('div');
    row.className = 'file-row' + (e.dir ? ' is-dir' : '');
    const icon = document.createElement('span');
    icon.className = 'file-icon';
    icon.innerHTML = e.dir ? DIR_ICON : FILE_ICON;
    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = e.name;
    const meta = document.createElement('span');
    meta.className = 'file-meta';
    meta.textContent = e.dir ? '目录' : `${formatBytes(e.size)} · ${new Date(e.mtime).toLocaleString()}`;
    const actions = document.createElement('span');
    actions.className = 'file-actions';
    const mv = document.createElement('button');
    mv.className = 'btn small';
    mv.textContent = '移动';
    mv.addEventListener('click', (ev) => {
      ev.stopPropagation(); // 防止目录行的"进入目录"点击触发
      openMoveCopy('move', filesRel(e.name));
    });
    actions.appendChild(mv);
    const cp = document.createElement('button');
    cp.className = 'btn small';
    cp.textContent = '复制';
    cp.addEventListener('click', (ev) => {
      ev.stopPropagation();
      openMoveCopy('copy', filesRel(e.name));
    });
    actions.appendChild(cp);
    if (!e.dir) {
      const dl = document.createElement('a');
      dl.className = 'btn small';
      dl.textContent = '下载';
      dl.target = '_blank';
      dl.rel = 'noopener';
      dl.href = BASE + '/api/files/download?path=' + encodeURIComponent(filesRel(e.name));
      actions.appendChild(dl);
    }
    const del = document.createElement('button');
    del.className = 'btn small danger-text';
    del.textContent = '删除';
    del.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      if (!confirm(`确定删除「${e.name}」？${e.dir ? '目录内容将一并删除。' : ''}`)) return;
      try {
        await call('files.delete', { path: filesRel(e.name) });
        loadFilesView();
      } catch (err) {
        toast(err.message, true);
      }
    });
    actions.appendChild(del);
    row.append(icon, name, meta, actions);
    if (e.dir) {
      row.addEventListener('click', () => {
        filesPath = filesRel(e.name);
        loadFilesView();
      });
    }
    list.appendChild(row);
  }
  content.appendChild(list);
}

// ---------- 移动 / 复制 ----------

let mcAction = 'move';
let mcFrom = null;
let mcPath = ''; // 目标目录（存储内相对路径）

function openMoveCopy(action, rel) {
  mcAction = action;
  mcFrom = rel;
  mcPath = '';
  document.getElementById('moveCopyTitle').textContent = action === 'move' ? '移动到' : '复制到';
  document.getElementById('moveCopySource').textContent = rel;
  document.getElementById('moveCopyConfirmBtn').textContent = action === 'move' ? '移动到这里' : '复制到这里';
  openModal('modalMoveCopy');
  loadMoveCopyDirs();
}

async function loadMoveCopyDirs() {
  renderCrumbs(document.getElementById('moveCopyCrumbs'), buildMoveCopyCrumbs());
  try {
    const list = document.getElementById('moveCopyDirs');
    if (mcPath === '') {
      // 根：显示"我的文件 / 应用文件"两个入口（与文件管理一致）
      list.innerHTML = '';
      list.appendChild(makeMoveCopyEntry('user', '我的文件'));
      list.appendChild(makeMoveCopyEntry('.package', '应用文件'));
      return;
    }
    const data = await call('files.list', { path: mcPath });
    list.innerHTML = '';
    const dirs = data.entries.filter((e) => e.dir);
    if (!dirs.length) {
      list.innerHTML = '<p class="file-empty">此文件夹下没有子目录</p>';
      return;
    }
    for (const e of dirs) {
      const row = document.createElement('div');
      row.className = 'file-row is-dir';
      const icon = document.createElement('span');
      icon.className = 'file-icon';
      icon.innerHTML = DIR_ICON;
      const name = document.createElement('span');
      name.className = 'file-name';
      name.textContent = e.name;
      row.append(icon, name);
      row.addEventListener('click', () => {
        mcPath = mcPath ? mcPath + '/' + e.name : e.name;
        loadMoveCopyDirs();
      });
      list.appendChild(row);
    }
  } catch (err) {
    toast(err.message, true);
  }
}

function makeMoveCopyEntry(rel, label) {
  const row = document.createElement('div');
  row.className = 'file-row is-dir';
  const icon = document.createElement('span');
  icon.className = 'file-icon';
  icon.innerHTML = DIR_ICON;
  const name = document.createElement('span');
  name.className = 'file-name';
  name.textContent = label;
  row.append(icon, name);
  row.addEventListener('click', () => {
    mcPath = rel;
    loadMoveCopyDirs();
  });
  return row;
}

function buildMoveCopyCrumbs() {
  const segs = [{ label: '存储根', click: () => { mcPath = ''; loadMoveCopyDirs(); } }];
  if (mcPath) {
    const parts = mcPath.split('/');
    let cur = '';
    parts.forEach((part, i) => {
      const segPath = cur ? cur + '/' + part : part; // 每段捕获自己的路径（闭包陷阱）
      cur = segPath;
      const label = part === 'user' ? '我的文件' : part === '.package' ? '应用文件' : part;
      if (i === parts.length - 1) segs.push({ label, current: true });
      else segs.push({ label, click: () => { mcPath = segPath; loadMoveCopyDirs(); } });
    });
  }
  return segs;
}

// ---------- 访问码 ----------

async function loadAccessCode() {
  renderCrumbs(document.getElementById('crumbsAccesscode'), [
    { label: '选项', click: () => switchView('settings') },
    { label: '安全设置', click: () => switchView('security') },
    { label: '访问码', current: true },
  ]);
  try {
    const s = await call('settings.get');
    document.getElementById('codeStatus').textContent = s.accessCodeSet
      ? '访问码已设置。修改需要输入当前访问码。'
      : '访问码未设置。';
  } catch (err) {
    toast(err.message, true);
  }
}

// ---------- 应用 ----------

let lastApps = [];
let lastShortcuts = [];
const installing = new Map(); // id -> meta（本地"安装中"状态）

async function loadApps() {
  loadSidebarApps();
  try {
    const [apps, shortcuts] = await Promise.all([call('apps.list'), call('shortcuts.list')]);
    renderApps(apps, shortcuts);
  } catch (err) {
    toast(err.message, true);
  }
}

// 操作列统一图标按钮（背景一色、图标一色，与"前往"同风格）
const ICONS = {
  go: 'M19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z',
  play: 'M8 5v14l11-7z',
  stop: 'M6 6h12v12H6z',
  gear: 'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z',
  trash: 'M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z',
};

function makeIconBtn(icon, title, onClick) {
  const btn = document.createElement('button');
  btn.className = 'icon-btn';
  btn.title = title;
  btn.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="${ICONS[icon]}"/></svg>`;
  btn.addEventListener('click', onClick);
  return btn;
}

function gearSvg(size) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="currentColor" aria-hidden="true"><path d="${ICONS.gear}"/></svg>`;
}

function renderApps(apps = lastApps, shortcuts = lastShortcuts) {
  lastApps = apps;
  lastShortcuts = shortcuts;
  const grid = document.getElementById('appGrid');
  grid.innerHTML = '';
  for (const app of apps) grid.appendChild(buildTile(app));
  for (const [id, meta] of installing) grid.appendChild(buildInstallingTile(id, meta));
  for (const sc of shortcuts) grid.appendChild(buildShortcutTile(sc));
  if (!apps.length && !installing.size && !shortcuts.length) {
    const empty = document.createElement('div');
    empty.className = 'app-empty';
    empty.textContent = '暂无应用，点右上角"添加应用"拖入应用包';
    grid.appendChild(empty);
  }
}

// 桌面快捷方式磁贴（不是真实应用）：点击打开对应程序并跳到控制桌面页
const SHORTCUT_BADGE =
  'M14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7zM5 5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7H5V5z';

function buildShortcutTile(sc) {
  const tile = document.createElement('div');
  tile.className = 'app-tile shortcut';
  tile.title = `桌面快捷方式：${sc.lnk || ''}\n点击启动`;

  const icon = document.createElement('div');
  icon.className = 'tile-icon';
  const av = document.createElement('div');
  av.className = 'tile-avatar';
  av.textContent = (sc.name || '?').slice(0, 1).toUpperCase();
  icon.appendChild(av);

  const badge = document.createElement('span');
  badge.className = 'tile-badge';
  badge.innerHTML = `<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="${SHORTCUT_BADGE}"/></svg>`;
  icon.appendChild(badge);

  // 右上角垃圾桶：删除快捷方式
  const del = document.createElement('button');
  del.className = 'tile-del';
  del.title = '删除快捷方式';
  del.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="${ICONS.trash}"/></svg>`;
  del.addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      await call('shortcuts.remove', { id: sc.id });
      toast(`已删除「${sc.name}」`);
      loadApps();
    } catch (err) {
      toast(err.message, true);
    }
  });
  icon.appendChild(del);

  tile.appendChild(icon);
  const name = document.createElement('div');
  name.className = 'tile-name';
  name.textContent = sc.name;
  tile.appendChild(name);

  tile.addEventListener('click', async () => {
    try {
      await call('shortcuts.launch', { id: sc.id });
      toast('已启动「' + sc.name + '」');
    } catch (err) {
      toast(err.message, true);
    }
  });
  return tile;
}

function buildIconContent(app) {
  if (app.icon) {
    const img = document.createElement('img');
    img.src = BASE + '/api/apps/icon?id=' + encodeURIComponent(app.id);
    img.alt = app.name;
    img.draggable = false;
    return img;
  }
  const av = document.createElement('div');
  av.className = 'tile-avatar';
  av.textContent = (app.name || app.id).slice(0, 1).toUpperCase();
  return av;
}

function buildTile(app) {
  const tile = document.createElement('div');
  tile.className =
    'app-tile' +
    (app.webui ? ' has-webui' : ' no-webui') +
    (app.running ? '' : ' stopped');

  const icon = document.createElement('div');
  icon.className = 'tile-icon';
  icon.appendChild(buildIconContent(app));

  // 右上角小齿轮：打开设置（hover 显示；触屏常显）
  const gear = document.createElement('button');
  gear.className = 'tile-gear';
  gear.title = '设置';
  gear.innerHTML = gearSvg(14);
  gear.addEventListener('click', (e) => {
    e.stopPropagation();
    openAppSettings(app);
  });
  icon.appendChild(gear);

  // 无 webui 且运行中：hover 图标加深 + 中央大齿轮
  if (!app.webui && app.running) {
    const big = document.createElement('div');
    big.className = 'tile-gear-big';
    big.innerHTML = gearSvg(30);
    icon.appendChild(big);
  }

  tile.appendChild(icon);
  const name = document.createElement('div');
  name.className = 'tile-name';
  name.textContent = app.name;
  tile.appendChild(name);

  tile.addEventListener('click', () => {
    if (!app.running) {
      // 未运行：点击启动
      call('apps.start', { id: app.id })
        .then(() => {
          toast(`应用「${app.name}」已启动`);
          loadApps();
        })
        .catch((err) => toast(err.message, true));
    } else if (app.webui) {
      window.open('/' + app.id + '/', '_blank');
    } else {
      openAppSettings(app);
    }
  });
  return tile;
}

function buildInstallingTile(id, meta) {
  // 安装中：普通磁贴外观（无三点动画），点击提示安装中
  const tile = document.createElement('div');
  tile.className = 'app-tile installing';

  const icon = document.createElement('div');
  icon.className = 'tile-icon';
  if (meta.iconDataUri) {
    const img = document.createElement('img');
    img.src = meta.iconDataUri;
    img.alt = meta.name;
    icon.appendChild(img);
  } else {
    const av = document.createElement('div');
    av.className = 'tile-avatar';
    av.textContent = (meta.name || id).slice(0, 1).toUpperCase();
    icon.appendChild(av);
  }

  tile.appendChild(icon);
  const name = document.createElement('div');
  name.className = 'tile-name';
  name.textContent = meta.name || id;
  tile.appendChild(name);

  tile.addEventListener('click', () =>
    openInfo('安装中', `应用「${meta.name || id}」正在安装，请稍候…`)
  );
  return tile;
}

let settingsAppId = null;

function openAppSettings(app) {
  settingsAppId = app.id;
  const wrap = document.getElementById('setIconWrap');
  wrap.innerHTML = '';
  wrap.appendChild(buildIconContent(app));
  document.getElementById('setName').textContent = app.name;
  document.getElementById('setId').textContent = app.id;
  document.getElementById('setDesc').innerHTML = app.description
    ? renderMarkdown(app.description)
    : '<span class="muted-inline">暂无描述</span>';

  // 启动/停止按钮按运行状态切换
  const ssBtn = document.getElementById('appStartStopBtn');
  ssBtn.dataset.action = app.running ? 'stop' : 'start';
  ssBtn.textContent = app.running ? '停止' : '启动';
  ssBtn.className = app.running ? 'btn danger' : 'btn primary';
  ssBtn.classList.remove('hidden');

  openModal('modalAppSettings');
}

function openInfo(title, text) {
  document.getElementById('infoTitle').textContent = title;
  document.getElementById('infoText').textContent = text;
  openModal('modalInfo');
}

// 最小 Markdown 渲染：标题/粗体/斜体/行内代码/链接/列表/换行
function renderMarkdown(md) {
  let html = escapeHtml(md);
  html = html
    .replace(/^#{1,3} (.+)$/gm, '<h4>$1</h4>')
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/(^|\W)\*([^*\n]+)\*/g, '$1<i>$2</i>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/^\s*[-*] (.+)$/gm, '<li>$1</li>');
  html = html.replace(/((?:<li>.*?<\/li>\n?)+)/g, '<ul>$1</ul>');
  html = html
    .split(/\n{2,}/)
    .map((p) => (/^<(h\d|ul)/.test(p.trim()) ? p : `<p>${p.replace(/\n/g, '<br>')}</p>`))
    .join('');
  return html;
}

// ---------- 反向代理 ----------

async function loadProxyView() {
  renderCrumbs(document.getElementById('crumbsProxy'), [
    { label: '选项', click: () => switchView('settings') },
    { label: '反向代理', current: true },
  ]);
  try {
    renderProxies(await call('proxy.list'));
  } catch (err) {
    toast(err.message, true);
  }
}

function renderProxies(rules) {
  const ul = document.getElementById('proxyList');
  ul.innerHTML = '';
  const manual = rules.filter((r) => !r.app);
  const appRules = rules.filter((r) => r.app);

  if (!rules.length) {
    const li = document.createElement('li');
    li.className = 'proxy-empty';
    li.textContent = '暂无代理规则';
    ul.appendChild(li);
    return;
  }

  for (const rule of manual) {
    const li = document.createElement('li');
    li.className = 'proxy-item';

    const route = document.createElement('div');
    route.className = 'proxy-route';
    const pathEl = document.createElement('b');
    pathEl.textContent = rule.path;
    route.appendChild(pathEl);
    route.appendChild(document.createTextNode(` → 127.0.0.1:${rule.port}`));

    const actions = document.createElement('div');
    actions.className = 'proxy-actions';
    actions.appendChild(
      makeIconBtn('go', `前往 ${rule.path}/`, () => window.open(rule.path + '/', '_blank'))
    );
    actions.appendChild(
      makeIconBtn('trash', '删除', async () => {
        try {
          await call('proxy.remove', { path: rule.path });
          toast(`已删除 ${rule.path}`);
          renderProxies(await call('proxy.list'));
        } catch (err) {
          toast(err.message, true);
        }
      })
    );
    li.append(route, actions);
    ul.appendChild(li);
  }

  // 应用的代理不逐条展示，汇总为一条，点击跳转到应用页管理
  if (appRules.length) {
    const li = document.createElement('li');
    li.className = 'proxy-item app-proxy-row';
    li.textContent = `应用的代理（${appRules.length}）`;
    li.title = '前往应用页管理';
    li.addEventListener('click', () => switchView('apps'));
    ul.appendChild(li);
  }
}

// ---------- 工具 ----------

function toast(msg, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => (el.className = 'toast hidden'), 3000);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function formatBytes(n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return n.toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
}

function formatUptime(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d} 天 ${h} 小时`;
  if (h > 0) return `${h} 小时 ${m} 分钟`;
  return `${m} 分钟`;
}

// ---------- 弹窗 ----------

function openModal(id) {
  document.getElementById('modalOverlay').classList.remove('hidden');
  document.querySelectorAll('.modal').forEach((m) => m.classList.add('hidden'));
  document.getElementById(id).classList.remove('hidden');
}

function closeModal() {
  document.getElementById('modalOverlay').classList.add('hidden');
}

// ---------- 事件绑定 ----------

// 侧边栏入口（内置 + 应用）动态渲染，用事件委托
document.getElementById('navList').addEventListener('click', (e) => {
  const btn = e.target.closest('.nav-item');
  if (!btn) return;
  if (btn.dataset.app) switchView(APP_VIEW, { app: btn.dataset.app, entry: Number(btn.dataset.entry || 0) });
  else switchView(btn.dataset.view);
});

// 列表页条目（功能>反向代理、选项>安全设置、安全设置>访问码）与面包屑跳转
document.querySelectorAll('.menu-item[data-goto]').forEach((li) =>
  li.addEventListener('click', () => switchView(li.dataset.goto))
);

// beta：个性化设置里的「桌面 UI」开关
document.getElementById('desktopUiToggle')?.addEventListener('click', () => {
  toggleDesktop(!desktopOn);
});

// beta：桌面模式下退出
document.getElementById('desktopExitBtn')?.addEventListener('click', () => {
  toggleDesktop(false);
});
document.querySelectorAll('.crumb').forEach((b) =>
  b.addEventListener('click', () => switchView(b.dataset.view))
);

// 重启葡萄云：确认弹窗 -> 发送重启指令，服务端拉起助手完成停+启
document.querySelectorAll('.menu-item[data-action]').forEach((li) =>
  li.addEventListener('click', () => {
    if (li.dataset.action === 'restart') openModal('modalConfirm');
  })
);
document.getElementById('confirmOkBtn').addEventListener('click', async () => {
  closeModal();
  try {
    await call('system.restart');
    toast('正在重启葡萄云…');
  } catch (err) {
    toast(err.message, true);
  }
});
document.getElementById('confirmCancelBtn').addEventListener('click', closeModal);

// ---- 存储位置表单 ----
document.getElementById('storageForm').addEventListener('submit', (e) => {
  e.preventDefault();
  submitStoragePath('storagePathInput', 'storageError');
});
document.getElementById('storagePageForm').addEventListener('submit', (e) => {
  e.preventDefault();
  submitStoragePath('storagePageInput', 'storagePageError');
});

// ---- 面包屑折叠弹窗 ----
document.getElementById('breadcrumbCloseBtn').addEventListener('click', closeModal);

// ---- 移动 / 复制 ----
document.getElementById('moveCopyConfirmBtn').addEventListener('click', async () => {
  try {
    if (mcAction === 'move') await call('files.move', { from: mcFrom, to: mcPath });
    else await call('files.copy', { from: mcFrom, to: mcPath });
    toast(mcAction === 'move' ? '移动完成' : '复制完成');
    closeModal();
    loadFilesView();
  } catch (err) {
    toast(err.message, true);
  }
});
document.getElementById('moveCopyCancelBtn').addEventListener('click', closeModal);

// 手机端抽屉菜单：三条杠开合，遮罩点击收起，回到桌面尺寸时清理状态
document.getElementById('menuBtn').addEventListener('click', () => {
  document.body.classList.toggle('nav-open');
});
document.getElementById('navMask').addEventListener('click', () => {
  document.body.classList.remove('nav-open');
});
window.matchMedia('(min-width: 769px)').addEventListener('change', (e) => {
  if (e.matches) document.body.classList.remove('nav-open');
});

document.getElementById('refreshSys').addEventListener('click', loadDashboard);

document.getElementById('changeCodeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const oldCode = document.getElementById('oldCode').value.trim();
  const newCode = document.getElementById('newCode').value.trim();
  const newCode2 = document.getElementById('newCode2').value.trim();
  if (!/^\d{8}$/.test(newCode)) return toast('新访问码须为 8 位数字', true);
  if (newCode !== newCode2) return toast('两次输入的新访问码不一致', true);
  try {
    await call('settings.setAccessCode', { oldCode, newCode });
    toast('访问码修改成功');
    e.target.reset();
  } catch (err) {
    toast(err.message, true);
  }
});

// ---- 添加应用：拖入 tar 包 -> 预览 -> 安装 ----
let stagedPkg = null; // { token, meta }

document.getElementById('openAppModal').addEventListener('click', () => {
  stagedPkg = null;
  document.getElementById('pkgPreview').classList.add('hidden');
  document.getElementById('dropZone').classList.remove('hidden', 'drag');
  openModal('modalApp');
});

const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');

['dragover', 'dragenter'].forEach((ev) =>
  dropZone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropZone.classList.add('drag');
  })
);
['dragleave', 'drop'].forEach((ev) =>
  dropZone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag');
  })
);
dropZone.addEventListener('drop', (e) => {
  const file = e.dataTransfer.files[0];
  if (file) uploadPkg(file);
});
document.getElementById('browseBtn').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) uploadPkg(fileInput.files[0]);
  fileInput.value = '';
});

async function uploadPkg(file) {
  if (!file.name.toLowerCase().endsWith('.tar')) return toast('请选择 .tar 应用包', true);
  if (file.size > 50 * 1024 * 1024) return toast('应用包超过 50MB 上限', true);
  try {
    const res = await fetch(BASE + '/api/apps/upload', { method: 'POST', body: file });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || '上传失败');
    stagedPkg = { token: data.token, meta: data.meta };
    showPkgPreview(data.meta);
  } catch (err) {
    toast(err.message, true);
  }
}

function showPkgPreview(meta) {
  dropZone.classList.add('hidden');
  document.getElementById('pkgPreview').classList.remove('hidden');
  const wrap = document.getElementById('pkgIconWrap');
  wrap.innerHTML = '';
  if (meta.iconDataUri) {
    const img = document.createElement('img');
    img.src = meta.iconDataUri;
    img.alt = meta.name;
    wrap.appendChild(img);
  } else {
    const av = document.createElement('div');
    av.className = 'tile-avatar';
    av.textContent = (meta.name || meta.id).slice(0, 1).toUpperCase();
    wrap.appendChild(av);
  }
  document.getElementById('pkgName').textContent = meta.name;
  document.getElementById('pkgId').textContent =
    meta.id + (meta.port ? ` · WebUI 端口 ${meta.port}` : ' · 无 WebUI');
  document.getElementById('pkgDesc').innerHTML = meta.description
    ? renderMarkdown(meta.description)
    : '<span class="muted-inline">暂无描述</span>';
}

document.getElementById('pkgInstallBtn').addEventListener('click', async () => {
  if (!stagedPkg) return;
  const { token, meta } = stagedPkg;
  stagedPkg = null;
  closeModal();
  installing.set(meta.id, meta);
  renderApps(); // 立即显示"安装中"磁贴
  try {
    const res = await fetch(BASE + '/api/apps/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || '安装失败');
    toast(`应用「${meta.name}」安装完成`);
  } catch (err) {
    toast(err.message, true);
  } finally {
    installing.delete(meta.id);
    loadApps();
  }
});

document.getElementById('pkgCancelBtn').addEventListener('click', () => {
  stagedPkg = null;
  closeModal();
});

// ---- 应用设置弹窗 ----
document.getElementById('appStartStopBtn').addEventListener('click', async () => {
  if (!settingsAppId) return;
  const action = document.getElementById('appStartStopBtn').dataset.action;
  try {
    await call(action === 'stop' ? 'apps.stop' : 'apps.start', { id: settingsAppId });
    toast(action === 'stop' ? '应用已停止' : '应用已启动');
    closeModal();
    loadApps();
  } catch (err) {
    toast(err.message, true);
  }
});
document.getElementById('appUninstallBtn').addEventListener('click', async () => {
  if (!settingsAppId) return;
  if (!confirm(`确定卸载应用「${settingsAppId}」？将先运行停止程序，然后删除应用包。`)) return;
  try {
    await call('apps.remove', { id: settingsAppId });
    toast('应用已卸载');
    closeModal();
    loadApps();
  } catch (err) {
    toast(err.message, true);
  }
});
document.getElementById('appSettingsCloseBtn').addEventListener('click', closeModal);
document.getElementById('infoOkBtn').addEventListener('click', closeModal);

document.getElementById('openProxyModal').addEventListener('click', () => {
  document.getElementById('addProxyForm').reset();
  openModal('modalProxy');
  document.getElementById('proxyPath').focus();
});

document.getElementById('proxyCancelBtn').addEventListener('click', closeModal);

document.getElementById('appViewClose').addEventListener('click', closeModal);

document.getElementById('modalOverlay').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeModal();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
});

document.getElementById('addProxyForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const path = document.getElementById('proxyPath').value.trim();
  const port = Number(document.getElementById('proxyPort').value);
  try {
    await call('proxy.add', { path, port });
    toast('代理规则已添加');
    closeModal();
    e.target.reset();
    renderProxies(await call('proxy.list'));
  } catch (err) {
    toast(err.message, true);
  }
});

document.getElementById('clearLogs').addEventListener('click', async () => {
  try {
    await call('logs.clear');
    document.getElementById('logList').innerHTML = '';
    toast('日志已清空');
  } catch (err) {
    toast(err.message, true);
  }
});

// 撤销访问码授权：清空所有已签发令牌（所有设备重新输入访问码）
document.getElementById('revokeAuthBtn').addEventListener('click', () => openModal('modalRevoke'));
document.getElementById('revokeCancelBtn').addEventListener('click', closeModal);
document.getElementById('revokeOkBtn').addEventListener('click', async () => {
  closeModal();
  try {
    await fetch(BASE + '/api/auth/revoke', { method: 'POST' });
    location.replace('/auth');
  } catch (err) {
    toast('撤销失败：' + err.message, true);
  }
});

connect();
