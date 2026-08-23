/* GrapeNAS 葡萄云 Web 客户端
 * 所有内置页面都在 "/" 下，通过 JS 切换视图，不依赖任何服务端路由。
 * 与服务器的数据交互全部通过 WebSocket 完成（认证基于 cookie 中的临时令牌）。 */

const state = { view: 'dashboard', ws: null, connected: false };
let reqId = 0;
const pending = new Map();

// ---------- WebSocket ----------

const HANDSHAKE_TIMEOUT = 5000; // 握手超时：避免永远卡在 CONNECTING
const HEARTBEAT_INTERVAL = 25000; // 心跳间隔
const HEARTBEAT_SILENCE = 50000; // 超过该时长无任何消息往来则判定假死

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
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
      location.replace('/auth?redirect=' + encodeURIComponent('/'));
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
}

function updateConnStatus() {
  const el = document.getElementById('connStatus');
  el.textContent = state.connected ? '已连接' : '连接断开，重连中…';
  el.classList.toggle('ok', state.connected);
}

// ---------- 视图切换（无路由，纯状态） ----------

const VIEW_LOADERS = {
  dashboard: loadDashboard,
  apps: loadApps,
  accesscode: loadAccessCode,
  proxy: loadProxyView,
};

// 子页面归属的顶级导航项（高亮用）
const NAV_OF = {
  dashboard: 'dashboard',
  apps: 'apps',
  features: 'features',
  proxy: 'features', // 反向代理属于"功能"
  settings: 'settings',
  security: 'settings', // 安全设置属于"设置"
  accesscode: 'settings', // 访问码属于"设置 > 安全设置"
};

function switchView(view) {
  state.view = view;
  const activeNav = NAV_OF[view] || view;
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === activeNav));
  document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'));
  document.getElementById('view-' + view).classList.remove('hidden');
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

// ---------- 访问码 ----------

async function loadAccessCode() {
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
const installing = new Map(); // id -> meta（本地"安装中"状态）

async function loadApps() {
  try {
    renderApps(await call('apps.list'));
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

function renderApps(apps = lastApps) {
  lastApps = apps;
  const grid = document.getElementById('appGrid');
  grid.innerHTML = '';
  for (const app of apps) grid.appendChild(buildTile(app));
  for (const [id, meta] of installing) grid.appendChild(buildInstallingTile(id, meta));
  if (!apps.length && !installing.size) {
    const empty = document.createElement('div');
    empty.className = 'app-empty';
    empty.textContent = '暂无应用，点右上角"添加应用"拖入应用包';
    grid.appendChild(empty);
  }
}

function buildIconContent(app) {
  if (app.icon) {
    const img = document.createElement('img');
    img.src = '/api/apps/icon?id=' + encodeURIComponent(app.id);
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

document.querySelectorAll('.nav-item').forEach((b) =>
  b.addEventListener('click', () => switchView(b.dataset.view))
);

// 列表页条目（功能>反向代理、选项>安全设置、安全设置>访问码）与面包屑跳转
document.querySelectorAll('.menu-item[data-goto]').forEach((li) =>
  li.addEventListener('click', () => switchView(li.dataset.goto))
);
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
    const res = await fetch('/api/apps/upload', { method: 'POST', body: file });
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
    const res = await fetch('/api/apps/install', {
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

document.getElementById('logoutBtn').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  location.replace('/auth');
});

connect();
