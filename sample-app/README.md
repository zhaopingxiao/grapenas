# 示例应用：免访问码入口（nocode-demo）

演示应用包 `config.json` 里的 **`nocodeport`**：这个端口的 Web 服务会被代理到
`/nocode/<应用id>`，**该路径不校验访问码**。

| 入口 | 由哪个字段提供 | 需要访问码 |
|---|---|---|
| `/nocode/nocode-demo/` | `nocodeport`（18992） | 否 |
| `/nocode-demo/` | `port`（18991） | 是 |

## 试试看

```bash
node pack.mjs                 # 生成 dist/nocode-demo.tar
```

然后在葡萄云「应用」页把 `dist/nocode-demo.tar` 拖进去安装（安装完会自动启动），再打开：

- <http://localhost:9643/nocode/nocode-demo/> —— 免访问码（隐私窗口、别的设备都能直接开）
- <http://localhost:9643/nocode-demo/> —— 会跳访问码页

应用设置弹窗里也会列出免访问码地址。

## 直接调试（不经葡萄云）

```bash
cd nocode-demo
node main.js
```

浏览器打开 <http://127.0.0.1:18991/>（模拟 port 入口）或 <http://127.0.0.1:18992/>（模拟 nocodeport 入口）。

> 目录里带了一份 `package.json`（`{"type":"commonjs"}`），一是让包内 `.js` 稳定按 CommonJS 解析，
> 二是能直接在仓库里 `node main.js` 调试（否则会继承仓库根 `package.json` 的 `"type": "module"`）。

## 写免访问码应用要注意

- **资源与接口一律用相对路径**（`style.css`、`api/info`）。反代会自动改写 HTML 里的
  `href/src="/x"`，但 JS 里 `fetch('/x')` 这类绝对路径不会改写，会请求到葡萄云根路径从而 404。
- 应用自己看到的是**剥掉前缀之后**的路径（`/`、`/api/info`），不用关心 `/nocode/<id>` 前缀。
- `/nocode` 是系统保留段：应用 id 不能叫 `nocode`，手动代理规则也不能占用 `/nocode`。
- 免访问码意味着**任何能访问到这台机器 9643 端口的人都能打开**，别把敏感数据放在这里。
  应用只监听 `127.0.0.1`，入口的开与关只取决于应用是否在运行（停止应用 → 入口立即失效）。
