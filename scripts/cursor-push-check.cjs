// 验证：光标推送（无轮询）+ 形状渲染 + 跟随
const WebSocket = require('ws');
const fs = require('fs');
const CDP = 'http://localhost:9222';
const OUT = 'C:\\Users\\jiayi\\AppData\\Local\\Temp\\opencode';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const t = await (await fetch(`${CDP}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
  await new Promise((r) => ws.on('open', r));
  let id = 0;
  const pend = new Map();
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pend.has(m.id)) {
      pend.get(m.id)(m);
      pend.delete(m.id);
    }
  });
  const send = (method, params = {}) =>
    new Promise((res) => {
      const mid = ++id;
      pend.set(mid, res);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  const ev = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) return 'EXC:' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
    return r.result?.result?.value;
  };
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(`${OUT}\\${name}.png`, Buffer.from(r.result.data, 'base64'));
    console.log('截图:', name);
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Network.clearBrowserCookies');
  await send('Page.navigate', { url: 'http://localhost:9643/' });
  await sleep(1500);
  await ev(`(function(){
    const b = document.querySelector('#group1 input');
    b.focus();
    for (const d of '20141210') {
      document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: d, bubbles: true, cancelable: true }));
    }
  })()`);
  await sleep(2200);
  await ev('document.querySelector(\'.nav-item[data-view="desktop"]\').click()');
  await sleep(4000);

  // 推送验证：页面未发送 cursor 请求，标记应自动出现
  const check = await ev(`(function(){
    const d = document.querySelector('.desktop-frame').contentDocument;
    const cur = d.getElementById('remoteCursor');
    return {
      display: getComputedStyle(cur).display,
      transform: cur.style.transform,
      hasShapeImg: cur.style.backgroundImage.startsWith('url("data:image/svg+xml'),
      cursorHidden: getComputedStyle(d.getElementById('screen')).cursor,
    };
  })()`);
  console.log('推送+形状:', JSON.stringify(check));

  // 移动鼠标到画面（模拟电脑光标移动），检查标记跟随
  const pos = await ev(`(function(){
    const f = document.querySelector('.desktop-frame');
    const r = f.contentDocument.getElementById('screen').getBoundingClientRect();
    const fr = f.getBoundingClientRect();
    return { x: fr.left + r.left + r.width * 0.7, y: fr.top + r.top + r.height * 0.4 };
  })()`);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos.x, y: pos.y });
  await sleep(500);
  console.log('移动后标记:', await ev('document.querySelector(".desktop-frame").contentDocument.getElementById("remoteCursor").style.transform'));
  await shot('i-cursor-shape');

  await fetch(`${CDP}/json/close/${t.id}`);
  ws.close();
  process.exit(0);
}
main().catch((e) => {
  console.error('失败:', e.message);
  process.exit(1);
});
