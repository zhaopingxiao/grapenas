# 葡萄云 GrapeNAS

轻量、零构建的自托管 NAS 管理面板。单端口（9643）承载 Web 界面、反向代理与 WebSocket 通讯，全部页面无路由（单壳页面 + 视图切换），数据交互统一走 WebSocket。

## 功能特性

- **访问码认证**：8 位数字访问码（SHA-256 加盐存储），首次访问强制设置；验证通过签发临时令牌（HttpOnly Cookie / `Authorization: Bearer` / WS `?token=` 三通道通用），7 天有效
- **全 WebSocket 通讯**：系统信息、日志、反代规则、应用管理全部走 WS；令牌即凭证，无独立 WS 密钥；心跳保活、断线自动重连、假死自愈
- **反向代理**：子路径 → 本机端口，HTTP + WebSocket 同步映射；自动改写 HTML 绝对路径、注入前端路由/WS 适配脚本、Referer 回退路由——**未改造的 SPA（如 opencode）也能直接跑在子路径下**
- **应用管理（tar 应用包）**：拖拽安装应用包，磁贴式启动器，markdown 描述，WebUI 自动反代到 `/<id>`
- **应用生命周期**：开机自动启动全部应用、重启后收养存活进程防重复启动、异常退出检测与日志、应用输出重定向到独立日志文件、Windows 下无窗口后台运行
- **运维**：网页内一键重启（独立重启助手）、端口冲突友好提示
- **跨平台**：Windows / macOS / Linux 全分支适配（进程管理、端口探测、脚本执行）
- **存储与文件管理**：可配置存储位置（无默认值，首次进入强制设置），我的文件存放于 `user/`、应用数据存放于 `.package/`；重新设置自动剪切迁移全部数据；文件管理页面支持浏览/上传/下载/删除/新建文件夹
- **移动端**：响应式布局、抽屉导航、分格访问码输入

## 技术栈

| 层 | 技术 |
|---|---|
| 运行时 | Node.js（仅依赖 `ws` 一个包） |
| 前端 | 原生 HTML/CSS/JS，无框架无构建 |
| 应用包 | tar + node 脚本约定 |

## 快速开始

```bash
npm install
npm start
```

打开 <http://localhost:9643>，首次访问会要求设置 8 位访问码（此后每次访问都需要输入）。

macOS / Linux 直接 `npm start` 或 `nohup node server/index.js &`。

## 应用包格式

应用以 `.tar` 打包，在「应用」页拖入安装：

```
app.tar
├── config.json   # 应用元信息（必填）
├── icon.png      # 图标（可选，config.json 中声明路径）
├── start.js      # 启动程序（必填，node 执行，全平台）
└── stop.js       # 停止程序（可选，卸载时执行）
```

`config.json` 字段：

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 应用标识（字母数字 `- _`，≤32 字符，不可与系统保留路径冲突） |
| `name` | 否 | 显示名，缺省用 id |
| `description` | 否 | 描述，支持 Markdown |
| `icon` | 否 | 图标在包内的相对路径（禁止越界） |
| `port` | 否 | WebUI 端口，配置后自动反代到 `/<id>` |

约定：

- 入口统一为 `start.js` / `stop.js`（node 执行，天然跨平台）；需要特殊脚本操作时在 js 内自行调用 `.bat` / `.ps1` / `.sh`
- 包内 `.js` 默认按 CommonJS 解析（自动补 `package.json`，无需自带；需要 ESM 可自带覆盖）
- **Windows 下 js 内 spawn 子进程请带 `windowsHide: true` 且不要用 `stdio: 'inherit'`**（inherit 会弹出可见控制台窗口）
- 应用输出自动写入 `data/logs/app-<id>.log`（隐藏窗口 + 日志重定向，无弹窗）

安装后自动启动；重启葡萄云时应用随机关闭、开机后自动拉起。

## 反向代理

「功能 → 反向代理」添加规则：子路径 → 本机端口。例如把 4096 端口的服务映射到 `/opencode`：

- HTTP：`/opencode/...` 自动转发到 `127.0.0.1:4096/...`
- WebSocket：服务的 `/websocket` 即 `/opencode/websocket`
- 页面内绝对路径资源（CSS/JS/图标/manifest）、SPA 前端路由、WS 连接自动适配，无需应用改造
- 系统保留路径（`/api`、`/auth`、`/ws` 等）不可占用；应用的代理规则只能在应用页管理

## 目录结构

```
grapenas/
├── server/                # Node 服务端
│   ├── index.js           # HTTP 入口（9643）：认证门禁、静态、API、反代路由
│   ├── ws.js              # WebSocket 通道 + 全部消息处理器
│   ├── auth.js            # 访问码校验、临时令牌签发/验证
│   ├── apps.js            # 应用生命周期、tar 包安装/卸载、进程记录
│   ├── storage.js         # 存储位置管理、文件路径安全解析、数据迁移
│   ├── proxy.js           # 反向代理：HTTP 转发、WS 隧道、HTML 改写、shim 注入
│   ├── config.js          # 配置持久化
│   ├── logger.js          # 内存环形日志 + 订阅推送
│   └── util.js
└── web/                   # 前端（单壳页面，无构建）
└── restart_helper.js      # 网页"重启葡萄云"的独立助手
```

## 数据与安全

| 路径 | 说明 |
|---|---|
| `<存储位置>/user/` | 我的文件（文件管理） |
| `<存储位置>/.package/<id>/` | 已安装的应用包解压目录 |
| `data/config.json` | 访问码（加盐哈希，非明文）、存储位置、代理规则、应用登记 |
| `data/logs/` | 各应用运行日志（`app-<id>.log`） |
| `data/tmp/` | 上传暂存（安装后自动清理） |
| `.ground_progress` | 应用进程记录（异常死亡时的收养兜底，正常关闭会显式清理） |

安全措施：访问码加盐哈希 + 时序安全比较、同 IP 连续失败锁定、令牌 HttpOnly Cookie、资源请求不重定向（防缓存污染）、应用包图标路径双重防穿越（词法 + realpath）、代理路径保留校验。

## 授权

MIT License
