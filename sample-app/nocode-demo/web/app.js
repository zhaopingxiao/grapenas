// 相对路径请求：页面挂在 /nocode/nocode-demo/ 或 /nocode-demo/ 下都能命中
document.getElementById('callBtn').addEventListener('click', async () => {
  const status = document.getElementById('status');
  const out = document.getElementById('out');
  status.textContent = '请求中…';
  try {
    const res = await fetch('api/info', { cache: 'no-store' });
    const data = await res.json();
    status.textContent = `HTTP ${res.status}`;
    out.textContent = JSON.stringify(data, null, 2);
  } catch (err) {
    status.textContent = '请求失败';
    out.textContent = String(err);
  }
});
