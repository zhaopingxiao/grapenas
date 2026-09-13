(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const BUTTONS = { 0: "left", 1: "middle", 2: "right", 3: "x1", 4: "x2" };

  const canvas = $("screen");
  const ctx = canvas.getContext("2d", { alpha: false });
  const stage = $("stage");
  const remoteCursor = $("remoteCursor");
  const overlay = $("overlay");
  const overlayMsg = $("overlayMsg");
  const refreshBtn = $("refreshBtn");
  const statusDot = $("statusDot");
  const statsEl = $("stats");
  const keyHint = $("keyHint");
  const monitorSelect = $("monitorSelect");
  const qualityRange = $("qualityRange");
  const qualityValue = $("qualityValue");
  const fpsRange = $("fpsRange");
  const fpsValue = $("fpsValue");
  const scaleSelect = $("scaleSelect");
  const dock = $("dock");
  const dockList = $("dockList");
  const dockEmpty = $("dockEmpty");
  const dropMenu = $("dropMenu");
  const dropMenuName = $("dropMenuName");
  const dropMenuAdd = $("dropMenuAdd");
  const lockOverlay = $("lockOverlay");

  const state = {
    ws: null,
    token: "",
    connected: false,
    manualClose: false,
    autoRefreshed: false,
    reconnectTimer: 0,
    settingsTimer: 0,
    pingTimer: 0,
    bitmap: null,
    fit: true,
    frames: 0,
    fps: 0,
    rtt: 0,
    serverStats: null,
    pressedKeys: new Set(),
    buttonsDown: new Set(),
    lastPos: { x: 0.5, y: 0.5 },
    moveScheduled: false,
    pendingMove: null,
    frameChain: Promise.resolve(),
    drag: { active: false, frozen: false, start: null },
    dropPoint: null,
    pendingPick: null,
    touch: {
      active: false,
      multi: false,
      moved: false,
      multiMoved: false,
      lastX: 0,
      lastY: 0,
      lastMidY: 0,
      timer: 0,
    },
  };

  // ---------------------------------------------------------------- utilities

  function send(message) {
    const ws = state.ws;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }

  function clamp(value, low, high) {
    return Math.max(low, Math.min(high, value));
  }

  function norm(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const x = clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1);
    const y = clamp((clientY - rect.top) / Math.max(1, rect.height), 0, 1);
    state.lastPos = { x, y };
    return { x: Math.round(x * 100000) / 100000, y: Math.round(y * 100000) / 100000 };
  }

  function sendMouse(action, extra) {
    send(Object.assign({ t: "mouse", a: action }, extra));
  }

  function showOverlay(message) {
    overlayMsg.textContent = message;
    overlay.classList.remove("hidden");
  }

  function setStatus(status) {
    statusDot.classList.toggle("online", status === "online");
    statusDot.classList.toggle("connecting", status === "connecting");
  }

  function updateStats() {
    if (!state.connected) {
      statsEl.textContent = "未连接";
      return;
    }
    const size = state.bitmap ? `${state.bitmap.width}x${state.bitmap.height}` : "--";
    const capture = state.serverStats ? `${Math.round(state.serverStats.capture_ms)}ms` : "--";
    statsEl.textContent = `${size} · ${state.fps}fps · 采集 ${capture} · 延迟 ${state.rtt}ms`;
  }

  function layout() {
    if (!state.bitmap) return;
    let width = state.bitmap.width;
    let height = state.bitmap.height;
    if (state.fit) {
      const ratio = Math.min(
        (stage.clientWidth - 16) / state.bitmap.width,
        (stage.clientHeight - 16) / state.bitmap.height,
        1
      );
      width = Math.max(1, Math.floor(state.bitmap.width * ratio));
      height = Math.max(1, Math.floor(state.bitmap.height * ratio));
    }
    canvas.style.width = width + "px";
    canvas.style.height = height + "px";
  }

  function releaseKeys() {
    for (const code of state.pressedKeys) send({ t: "key", a: "up", code });
    state.pressedKeys.clear();
    for (const button of state.buttonsDown) {
      sendMouse("up", { b: button, x: state.lastPos.x, y: state.lastPos.y });
    }
    state.buttonsDown.clear();
  }

  // ----------------------------------------------------------------- websocket

  function wsUrl(token) {
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    return `${protocol}://${location.host}/ws?token=${encodeURIComponent(token)}`;
  }

  function connect(token) {
    clearTimeout(state.reconnectTimer);
    state.manualClose = false;
    state.token = token;
    if (state.ws) {
      state.ws.onopen = null;
      state.ws.onmessage = null;
      state.ws.onclose = null;
      state.ws.onerror = null;
      try {
        state.ws.close();
      } catch (err) {
        /* ignore */
      }
    }

    let ws;
    try {
      ws = new WebSocket(wsUrl(token));
    } catch (err) {
      showOverlay("无法创建连接: " + err.message);
      return;
    }
    state.ws = ws;
    setStatus("connecting");
    showOverlay("正在连接…");

    ws.onopen = () => setStatus("connecting");
    ws.onmessage = (event) => {
      if (typeof event.data === "string") handleJson(event.data);
      else enqueueFrame(event.data);
    };
    ws.onclose = (event) => {
      state.connected = false;
      setStatus("offline");
      releaseKeys();
      remoteCursor.style.display = "none";
      lockOverlay.classList.add("hidden");
      hideDock();
      if (state.manualClose) {
        showOverlay("连接已断开");
        return;
      }
      showOverlay("正在重新连接…");
      if (event.code === 4003) {
        // 令牌已失效（桌面服务重启）：让外层重新获取令牌并重建页面
        if (!state.autoRefreshed) {
          state.autoRefreshed = true;
          setTimeout(requestParentReload, 1500);
        }
        return;
      }
      state.reconnectTimer = setTimeout(() => connect(state.token), 2000);
    };
    ws.onerror = () => {
      /* handled by onclose */
    };
  }

  function handleJson(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch (err) {
      return;
    }
    switch (message.t) {
      case "hello":
        populateMonitors(message.monitors);
        applyServerSettings(message.settings);
        state.connected = true;
        setStatus("online");
        overlay.classList.add("hidden");
        lockOverlay.classList.add("hidden");
        showDock();
        startPing();
        canvas.focus();
        if (document.activeElement !== canvas) keyHint.classList.add("show");
        break;
      case "stats":
        state.serverStats = message;
        updateStats();
        break;
      case "pong":
        if (typeof message.ts === "number") {
          state.rtt = Math.max(0, Math.round(performance.now() - message.ts));
        }
        break;
      case "cursor":
        if (message.visible === false) {
          remoteCursor.style.display = "none";
        } else {
          placeCursor(message.nx, message.ny, message.shape);
        }
        break;
      case "locked":
        state.connected = false;
        setStatus("offline");
        remoteCursor.style.display = "none";
        hideDock();
        lockOverlay.classList.remove("hidden");
        break;
      case "icon":
        handleIconResult(message);
        break;
      case "error":
        showOverlay(message.message || "服务端错误");
        break;
    }
  }

  // -------------------------------------------------------------- frame render

  function enqueueFrame(blob) {
    state.frameChain = state.frameChain
      .then(() => drawFrame(blob))
      .catch(() => {
        /* ignore decode errors */
      });
  }

  async function drawFrame(blob) {
    try {
      const bitmap = await createImageBitmap(blob);
      const previous = state.bitmap;
      state.bitmap = bitmap;
      if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
      }
      layout();
      ctx.drawImage(bitmap, 0, 0);
      if (previous) previous.close();
      state.frames += 1;
    } finally {
      send({ t: "ack" });
    }
  }

  // ------------------------------------------------------------------- inputs

  canvas.addEventListener("mousemove", (event) => {
    // 拖到悬浮窗上方时冻结远程拖拽，避免桌面图标被拖走
    if (state.drag.active && state.drag.frozen) return;
    state.pendingMove = { x: event.clientX, y: event.clientY };
    if (state.moveScheduled) return;
    state.moveScheduled = true;
    requestAnimationFrame(() => {
      state.moveScheduled = false;
      if (!state.pendingMove) return;
      const p = norm(state.pendingMove.x, state.pendingMove.y);
      sendMouse("move", p);
    });
  });

  canvas.addEventListener("mousedown", (event) => {
    event.preventDefault();
    canvas.focus();
    keyHint.classList.remove("show");
    const button = BUTTONS[event.button];
    if (!button) return;
    const p = norm(event.clientX, event.clientY);
    sendMouse("down", { b: button, x: p.x, y: p.y });
    state.buttonsDown.add(button);
    if (button === "left") {
      state.drag = { active: true, frozen: false, start: p };
    }
  });

  // 拖拽过程中：指针移到悬浮窗上则进入冻结（不再把移动发给远程）
  document.addEventListener("mousemove", (event) => {
    if (!state.drag.active) return;
    const over = isOverDock(event.clientX, event.clientY);
    if (over !== state.drag.frozen) {
      state.drag.frozen = over;
      dock.classList.toggle("drop-active", over);
    }
  });

  window.addEventListener("mouseup", (event) => {
    const button = BUTTONS[event.button];
    if (!button || !state.buttonsDown.has(button)) {
      resetDrag();
      return;
    }
    if (button === "left" && state.drag.active && isOverDock(event.clientX, event.clientY)) {
      // 放到悬浮窗：先把远程指针移回按下时的位置再松开（图标归位），再请求识别
      const start = state.drag.start;
      sendMouse("up", { b: "left", x: start.x, y: start.y });
      state.buttonsDown.delete(button);
      state.dropPoint = { x: event.clientX, y: event.clientY };
      send({ t: "icon.pick", x: start.x, y: start.y });
      resetDrag();
      return;
    }
    const p = norm(event.clientX, event.clientY);
    sendMouse("up", { b: button, x: p.x, y: p.y });
    state.buttonsDown.delete(button);
    resetDrag();
  });

  function resetDrag() {
    state.drag.active = false;
    state.drag.frozen = false;
    dock.classList.remove("drop-active");
  }

  canvas.addEventListener("contextmenu", (event) => event.preventDefault());

  canvas.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      sendMouse("scroll", {
        dx: event.deltaX,
        dy: event.deltaY,
        mode: event.deltaMode || 0,
      });
    },
    { passive: false }
  );

  canvas.addEventListener("keydown", (event) => {
    if (event.code === "F12") return;
    event.preventDefault();
    state.pressedKeys.add(event.code);
    send({ t: "key", a: "down", code: event.code, key: event.key });
  });

  canvas.addEventListener("keyup", (event) => {
    if (event.code === "F12") return;
    event.preventDefault();
    state.pressedKeys.delete(event.code);
    send({ t: "key", a: "up", code: event.code, key: event.key });
  });

  canvas.addEventListener("focus", () => keyHint.classList.remove("show"));
  canvas.addEventListener("blur", () => {
    releaseKeys();
    if (state.connected) keyHint.classList.add("show");
  });
  window.addEventListener("blur", releaseKeys);

  // -------------------------------------------------------------------- touch

  function touchNorm(touch) {
    return norm(touch.clientX, touch.clientY);
  }

  canvas.addEventListener(
    "touchstart",
    (event) => {
      event.preventDefault();
      canvas.focus();
      keyHint.classList.remove("show");
      if (event.touches.length === 1) {
        const touch = event.touches[0];
        const p = touchNorm(touch);
        sendMouse("move", p);
        sendMouse("down", { b: "left", x: p.x, y: p.y });
        Object.assign(state.touch, {
          active: true,
          multi: false,
          moved: false,
          multiMoved: false,
          lastX: touch.clientX,
          lastY: touch.clientY,
        });
        clearTimeout(state.touch.timer);
        state.touch.timer = setTimeout(() => {
          if (!state.touch.active || state.touch.moved) return;
          sendMouse("up", { b: "left", x: state.lastPos.x, y: state.lastPos.y });
          sendMouse("down", { b: "right", x: state.lastPos.x, y: state.lastPos.y });
          sendMouse("up", { b: "right", x: state.lastPos.x, y: state.lastPos.y });
          state.touch.active = false;
        }, 550);
      } else if (event.touches.length === 2) {
        clearTimeout(state.touch.timer);
        if (state.touch.active) {
          sendMouse("up", { b: "left", x: state.lastPos.x, y: state.lastPos.y });
          state.touch.active = false;
        }
        state.touch.multi = true;
        state.touch.multiMoved = false;
        state.touch.lastMidY = (event.touches[0].clientY + event.touches[1].clientY) / 2;
      }
    },
    { passive: false }
  );

  canvas.addEventListener(
    "touchmove",
    (event) => {
      event.preventDefault();
      if (event.touches.length === 1 && state.touch.active) {
        const touch = event.touches[0];
        const moved =
          Math.abs(touch.clientX - state.touch.lastX) +
            Math.abs(touch.clientY - state.touch.lastY) >
          10;
        if (moved) {
          state.touch.moved = true;
          clearTimeout(state.touch.timer);
        }
        sendMouse("move", touchNorm(touch));
      } else if (event.touches.length === 2) {
        const midY = (event.touches[0].clientY + event.touches[1].clientY) / 2;
        const dy = midY - state.touch.lastMidY;
        state.touch.lastMidY = midY;
        if (Math.abs(dy) > 2) state.touch.multiMoved = true;
        if (dy) sendMouse("scroll", { dx: 0, dy: dy * 2, mode: 0 });
      }
    },
    { passive: false }
  );

  canvas.addEventListener(
    "touchend",
    (event) => {
      event.preventDefault();
      clearTimeout(state.touch.timer);
      if (event.touches.length > 0) return;
      if (state.touch.active) {
        const touch = event.changedTouches[0];
        const p = touchNorm(touch);
        sendMouse("up", { b: "left", x: p.x, y: p.y });
      } else if (state.touch.multi && !state.touch.multiMoved) {
        sendMouse("down", { b: "right", x: state.lastPos.x, y: state.lastPos.y });
        sendMouse("up", { b: "right", x: state.lastPos.x, y: state.lastPos.y });
      }
      Object.assign(state.touch, {
        active: false,
        multi: false,
        moved: false,
        multiMoved: false,
      });
    },
    { passive: false }
  );

  // ------------------------------------------------------------------ toolbar

  function populateMonitors(monitors) {
    if (!Array.isArray(monitors)) return;
    monitorSelect.innerHTML = "";
    for (const monitor of monitors) {
      const option = document.createElement("option");
      option.value = String(monitor.id);
      option.textContent = `${monitor.name} (${monitor.width}x${monitor.height})`;
      monitorSelect.appendChild(option);
    }
  }

  function applyServerSettings(settings) {
    if (!settings) return;
    qualityRange.value = settings.quality;
    qualityValue.textContent = settings.quality;
    fpsRange.value = settings.fps;
    fpsValue.textContent = settings.fps;
    scaleSelect.value = String(settings.scale);
    monitorSelect.value = String(settings.monitor);
  }

  function sendSettings(partial) {
    send(Object.assign({ t: "settings" }, partial));
  }

  // ---- 悬浮窗：桌面快捷方式（拖桌面图标上去添加） ----

  // 通过外层葡萄云页面调用 NAS 接口（同源 iframe，直接调父页面的 call）
  function parentCall(type, data) {
    try {
      if (window.parent && window.parent !== window && typeof window.parent.call === "function") {
        return window.parent.call(type, data);
      }
    } catch (err) {
      /* 跨域等异常 */
    }
    return Promise.reject(new Error("无法访问外层页面"));
  }

  function isOverDock(clientX, clientY) {
    if (dock.classList.contains("hidden")) return false;
    const rect = dock.getBoundingClientRect();
    return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
  }

  function showDock() {
    dock.classList.remove("hidden");
    loadDock();
  }

  function hideDock() {
    dock.classList.add("hidden");
    dock.classList.remove("drop-active");
  }

  async function loadDock() {
    try {
      const items = await parentCall("shortcuts.list");
      renderDock(Array.isArray(items) ? items : []);
    } catch (err) {
      hideDock();
    }
  }
  window.desktopRefreshDock = loadDock;

  const TRASH_SVG =
    "M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z";

  function renderDock(items) {
    dockList.innerHTML = "";
    if (!items.length) {
      dockEmpty.textContent = "把桌面图标拖到这里";
      dockEmpty.style.display = "";
    } else {
      dockEmpty.style.display = "none";
    }
    for (const sc of items) {
      const item = document.createElement("div");
      item.className = "dock-item";
      const label = document.createElement("span");
      label.className = "dock-item-name";
      label.textContent = sc.name;
      item.appendChild(label);

      const del = document.createElement("button");
      del.className = "dock-del";
      del.title = "删除这个快捷方式";
      del.innerHTML =
        '<svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor" aria-hidden="true"><path d="' +
        TRASH_SVG +
        '"/></svg>';
      del.addEventListener("click", async (event) => {
        event.stopPropagation();
        try {
          await parentCall("shortcuts.remove", { id: sc.id });
          loadDock();
        } catch (err) {
          showDockHint(err.message || "删除失败");
        }
      });
      item.appendChild(del);
      dockList.appendChild(item);
    }
  }

  let dockHintTimer = 0;

  function showDockHint(text) {
    dockEmpty.textContent = text;
    dockEmpty.style.display = "";
    clearTimeout(dockHintTimer);
    dockHintTimer = setTimeout(() => {
      if (dockList.children.length) {
        dockEmpty.style.display = "none";
      } else {
        dockEmpty.textContent = "把桌面图标拖到这里";
      }
    }, 2600);
  }

  function handleIconResult(message) {
    if (message.found && message.lnk) {
      state.pendingPick = { name: message.name, lnk: message.lnk };
      dropMenuName.textContent = message.name;
      dropMenu.classList.remove("hidden");
      const rect = dropMenu.getBoundingClientRect();
      const pt = state.dropPoint || { x: window.innerWidth / 2, y: window.innerHeight / 2 };
      const x = Math.min(Math.max(8, pt.x - rect.width / 2), window.innerWidth - rect.width - 8);
      const y = Math.min(Math.max(8, pt.y - rect.height - 14), window.innerHeight - rect.height - 8);
      dropMenu.style.left = x + "px";
      dropMenu.style.top = y + "px";
    } else if (message.found) {
      showDockHint("只能添加 .lnk 快捷方式");
    } else {
      showDockHint("没有识别到桌面图标");
    }
  }

  dropMenuAdd.addEventListener("click", async () => {
    const pick = state.pendingPick;
    dropMenu.classList.add("hidden");
    state.pendingPick = null;
    if (!pick) return;
    try {
      await parentCall("shortcuts.add", { name: pick.name, lnk: pick.lnk });
      try {
        if (typeof window.parent.toast === "function") window.parent.toast("已添加到应用页");
      } catch (err) {
        /* 忽略 */
      }
      loadDock();
    } catch (err) {
      showDockHint(err.message || "添加失败");
    }
  });

  document.addEventListener("mousedown", (event) => {
    if (!dropMenu.classList.contains("hidden") && !dropMenu.contains(event.target)) {
      dropMenu.classList.add("hidden");
    }
  });

  monitorSelect.addEventListener("change", () =>
    sendSettings({ monitor: Number(monitorSelect.value) })
  );
  scaleSelect.addEventListener("change", () =>
    sendSettings({ scale: Number(scaleSelect.value) })
  );
  qualityRange.addEventListener("input", () => {
    qualityValue.textContent = qualityRange.value;
    clearTimeout(state.settingsTimer);
    state.settingsTimer = setTimeout(() => {
      sendSettings({ quality: Number(qualityRange.value), fps: Number(fpsRange.value) });
    }, 250);
  });
  fpsRange.addEventListener("input", () => {
    fpsValue.textContent = fpsRange.value;
    clearTimeout(state.settingsTimer);
    state.settingsTimer = setTimeout(() => {
      sendSettings({ quality: Number(qualityRange.value), fps: Number(fpsRange.value) });
    }, 250);
  });

  $("fitBtn").addEventListener("click", () => {
    state.fit = !state.fit;
    $("fitBtn").classList.toggle("active", state.fit);
    $("fitBtn").textContent = state.fit ? "适应窗口" : "原始大小";
    layout();
  });

  $("fullscreenBtn").addEventListener("click", async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch (err) {
      /* ignore */
    }
    setTimeout(layout, 150);
  });

  $("disconnectBtn").addEventListener("click", () => {
    state.manualClose = true;
    stopPing();
    if (state.ws) state.ws.close();
    showOverlay("连接已断开");
  });

  // 让外层葡萄云重新获取令牌并重建桌面页面；不可用时退回本页刷新
  function requestParentReload() {
    try {
      if (
        window.parent &&
        window.parent !== window &&
        typeof window.parent.loadDesktopView === "function"
      ) {
        window.parent.loadDesktopView();
        return;
      }
    } catch (err) {
      /* 跨域等情况忽略 */
    }
    location.reload();
  }

  refreshBtn.addEventListener("click", requestParentReload);

  window.addEventListener("resize", layout);

  // -------------------------------------------------------------------- timers

  function startPing() {
    stopPing();
    state.pingTimer = setInterval(() => send({ t: "ping", ts: performance.now() }), 2000);
  }

  function stopPing() {
    clearInterval(state.pingTimer);
    state.pingTimer = 0;
  }

  // 电脑光标同步：服务端主动推送位置与形状，本地指针隐藏（见 CSS cursor:none）
  const CURSOR_SVGS = {
    arrow: "M2 2 L2 21 L7 16.5 L10.5 23.5 L13.5 22 L10 15 L18 15 Z",
    ibeam: "M5 2h8v2h-3v16h3v2H5v-2h3V4H5z",
    hand: "M7 22v-7l-1.5 1.5c-.8.8-2 .3-2-.8V13c0-.3.1-.5.3-.7L8 8V4.5C8 3.7 8.7 3 9.5 3S11 3.7 11 4.5V10h1V3.5C12 2.7 12.7 2 13.5 2S15 2.7 15 3.5V10h1V5.5C16 4.7 16.7 4 17.5 4S19 4.7 19 5.5V10h1V7.5c0-.8.7-1.5 1.5-1.5S23 6.7 23 7.5V15c0 3.9-3.1 7-7 7H7z",
    crosshair: "M11 2h2v7h-2zM11 15h2v7h-2zM2 11h7v2H2zM15 11h7v2h-7z",
    sizewe: "M2 12l5-5v3h10V7l5 5-5 5v-3H7v3z",
    sizens: "M12 2l5 5h-3v10h3l-5 5-5-5h3V7H7z",
    sizenwse: "M3 3l7 1.5L7.5 7l9 9 2.5-2.5L20.5 21l-7-1.5L16 17l-9-9-2.5 2.5z",
    sizenesw: "M21 3l-7 1.5L16.5 7l-9 9L5 13.5 3.5 21l7-1.5L8 17l9-9 2.5 2.5z",
    sizeall: "M12 2l4 4h-3v4h4V7l4 4-4 4v-3h-4v4h3l-4 4-4-4h3v-4H7v3l-4-4 4-4v3h4V6H8z",
    wait: "M7 2h10v2l-4 8 4 8v2H7v-2l4-8-4-8z",
    uparrow: "M12 2l6 7h-4v13h-4V9H6z",
    no: "M12 3a9 9 0 100 18 9 9 0 000-18zm6.4 4.4L7.4 18.4A7 7 0 0118.4 7.4zM5.6 16.6L16.6 5.6a7 7 0 01-11 11z",
  };

  function cursorUrl(shape) {
    const path = CURSOR_SVGS[shape] || CURSOR_SVGS.arrow;
    const svg =
      "<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'>" +
      "<path d='" + path + "' fill='#fff' stroke='#000' stroke-width='1.4'/></svg>";
    return "url(\"data:image/svg+xml," + encodeURIComponent(svg) + "\")";
  }

  let currentCursorShape = "";

  function placeCursor(nx, ny, shape) {
    const rect = canvas.getBoundingClientRect();
    remoteCursor.style.display = "block";
    remoteCursor.style.transform =
      "translate(" + Math.round(rect.left + nx * rect.width) + "px, " +
      Math.round(rect.top + ny * rect.height) + "px)";
    if (shape && shape !== currentCursorShape) {
      currentCursorShape = shape;
      remoteCursor.style.backgroundImage = cursorUrl(shape);
    }
  }

  setInterval(() => {
    state.fps = state.frames;
    state.frames = 0;
    updateStats();
  }, 1000);

  // ---------------------------------------------------------------------- boot

  const token = new URLSearchParams(location.search).get("token") || "";
  if (token) {
    connect(token);
  } else {
    showOverlay("正在重新连接…");
    setTimeout(requestParentReload, 1500);
  }
})();
