// 手机端 UI 全页面截图验证
const WebSocket = require('ws');
const fs = require('fs');

const CDP = 'http://localhost:9222';
const OUT = 'C:\\Users\\jiayi\\AppData\\Local\\Temp\\opencode';
const ACCESS_CODE = '20141210';
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
  await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 667, deviceScaleFactor: 2, mobile: true });
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
  await sleep(2000);

  // 访问码页（两行四格）
  await send('Page.navigate', { url: 'http://localhost:9643/' });
  await ev('document.querySelector(\'.nav-item[data-view="dashboard"]\') && 0'); // noop
  await sleep(100);

  // 仪表盘
  await shot('m-dash');

  // 抽屉
  await ev('document.getElementById("menuBtn").click()');
  await sleep(500);
  await shot('m-drawer');

  // 文件管理 > 我的文件
  await ev('[...document.querySelectorAll(".nav-item")].find(b=>b.dataset.view==="files").click()');
  await sleep(400);
  await ev('[...document.querySelectorAll("#filesContent .menu-item")].find(b=>b.textContent.includes("我的文件")).click()');
  await sleep(600);
  await shot('m-files');

  // 文件管理根
  await ev('document.querySelector("#filesCrumbs .crumb").click()');
  await sleep(500);
  await shot('m-files-root');

  // 应用
  await ev('[...document.querySelectorAll(".nav-item")].find(b=>b.dataset.view==="apps").click()');
  await sleep(600);
  await shot('m-apps');

  // 选项 > 存储设置 > 存储位置
  await ev('[...document.querySelectorAll(".nav-item")].find(b=>b.dataset.view==="settings").click()');
  await sleep(400);
  await ev('[...document.querySelectorAll("#view-settings .menu-item")].find(b=>b.textContent.includes("存储设置")).click()');
  await sleep(400);
  await shot('m-storagesettings');
  await ev('[...document.querySelectorAll("#view-storagesettings .menu-item")].find(b=>b.textContent.includes("存储位置")).click()');
  await sleep(500);
  await shot('m-storagelocation');

  // 移动/复制弹窗（在应用文件里找一个目录）
  await ev('[...document.querySelectorAll(".nav-item")].find(b=>b.dataset.view==="files").click()');
  await sleep(400);
  await ev('[...document.querySelectorAll("#filesContent .menu-item")].find(b=>b.textContent.includes("应用文件")).click()');
  await sleep(600);
  const hasDir = await ev('[...document.querySelectorAll("#filesContent .file-row")].some(r=>r.classList.contains("is-dir"))');
  if (hasDir) {
    await ev('(function(){const row=[...document.querySelectorAll("#filesContent .file-row")].find(r=>r.classList.contains("is-dir"));const b=[...row.querySelectorAll("button")].find(x=>x.textContent==="移动");b.click();})()');
    await sleep(600);
    await shot('m-movecopy');
    await ev('document.getElementById("moveCopyCancelBtn").click()');
  }

  await fetch(`${CDP}/json/close/${t.id}`);
  ws.close();
  process.exit(0);
}
main().catch((e) => {
  console.error('失败:', e.message);
  process.exit(1);
});
