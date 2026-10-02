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
- **存储与文件管理**：可配置存储位置（无默认值，首次进入强制设置），我的文件存放于 `user/`、应用数据存放于 `.package/`；重新设置自动剪切迁移全部数据；文件管理页面支持浏览/上传/下载/删除/移动/复制/新建文件夹
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

打开 <http://localhost:9643/>，首次访问会要求设置 8 位访问码（此后每次访问都需要输入）。路径约定：`/` 是壳页面；内置路径（`/grapenas/ws`、`/grapenas/api/...`、`/grapenas/style.css`）统一在 `/grapenas` 前缀下；应用与反向代理仍在根下 `/<应用id>/`，不带前缀。`grapenas` 这一段被系统占用，**应用 id 与代理路径都不能叫 grapenas**。

macOS / Linux 直接 `npm start` 或 `nohup node server/index.js &`。

## 应用包格式

应用以 `.tar` 打包，在「应用」页拖入安装：

```
app.tar
├── config.json   # 应用元信息（必填）
├── main.js       # 唯一入口（必填，node 执行，全平台）
└── icon.png      # 图标（可选，config.json 中声明路径）
```

`config.json` 字段：

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 应用标识（字母数字 `- _`，≤32 字符，不可与系统保留路径冲突） |
| `name` | 否 | 显示名，缺省用 id |
| `description` | 否 | 描述，支持 Markdown |
| `icon` | 否 | 图标在包内的相对路径（禁止越界） |
| `port` | 否 | WebUI 端口，配置后自动反代到 `/<id>` |
| `sidebar` | 否 | 单入口侧边栏（兼容写法）；多入口请用包根 `sidebar.json`，见下 |

### 应用侧边栏（sidebar.json，可多个入口）

应用可以在包根放一个 **sidebar.json**，声明任意多个侧边栏入口（排在「选项」之前）：

```json
[
  {
    "iconsvg": "information_icon.svg",
    "sidebar_name": "示例应用信息",
    "page": "web/information_sidebar.html"
  },
  {
    "iconsvg": "test_icon.svg",
    "sidebar_name": "示例应用测试",
    "page": "web/test_sidebar.html"
  }
]
```

| 字段 | 说明 |
|---|---|
| `iconsvg` | 侧边栏图标（包内相对路径；`fill="currentColor"` 可跟随主题换色） |
| `sidebar_name` | 侧边栏显示名 |
| `page` | 页面片段（包内相对路径，注入到壳页面当前视图） |

约定：

- **入口只在应用运行时显示**：应用停止后它的所有侧边栏项立即消失，重启后自动回来。
- `page` 是**片段**，不是完整 HTML：不要写 `<html>/<head>/<body>`，注入后直接成为视图内容；
  片段内的相对 `src`/`href`（图片、CSS、脚本）会被自动改写到
  `/grapenas/api/apps/sidebar-asset?id=<id>&entry=<下标>&file=…`，照常相对引用即可。
- 片段可注册生命周期（可选）：`window.GrapenasModule = { mount(root), unmount() }`，
  切换视图时由壳页面调用，用于建立/断开连接、清定时器；
  因为与壳页面共用同一个 document，**class 名请自带前缀**，DOM 查找限定在 `mount(root)` 的 root 内。
- 片段可调用宿主接口：`window.GrapenasHost.call(type, data)`（与壳页面同一套 WS 消息）、`window.GrapenasHost.toast(text)`、
  `window.GrapenasHost.reloadView()`（重新挂载当前视图）。
- 声明的图标与页面必须真实存在于包内，否则安装会失败。
- 兼容写法：`config.json` 里写单个 `sidebar` 对象也可以（等价于只有一项的 sidebar.json）。

#### 运行时刷新侧边栏

葡萄云在**启动应用时**读一次 `sidebar.json`；应用运行中改了入口（增删项、换名字/图标），

仅需让应用 POST 一次葡萄云接口（需要该应用的密钥）：

```bash
POST /grapenas/api/reload_sidebar/<应用id>
Header: x-grapenas-app-secret: <应用密钥>        # 也支持 ?secret=<密钥>
```

密钥是安装应用时随机生成的，葡萄云启动应用时会：

- 通过环境变量 `GRAPENAS_APP_SECRET`（还有 `GRAPENAS_APP_ID`、`GRAPENAS_BASE_URL`）下发；
- 同时写进包内 `.grapenas.json`：`{ "id":…, "secret":…, "base_url":…, "reload_sidebar":"/api/reload_sidebar/<id>" }`。

刷新成功后，葡萄云会把最新的入口列表通过 WebSocket 事件 `sidebar` 推给所有已连接的客户端，
前端收到就重建侧边栏，不需要手动刷新页面。

## 示例应用

`sample-app/` 里有一个可直接安装的示例包 `hello.tar`：自带 HTTP 服务的 node 应用，安装后**网页**（`/hello/`）与**侧边栏**（「示例应用」入口）两种方式都能打开，两边共用同一个后端。

```bash
node sample-app/pack.mjs            # 改完 sample-app/hello/ 后重新打包成 hello.tar
```

把 `hello.tar` 拖到「应用」页即安装。当模板用：改 `config.json` 的 `id`/`name`/`port`/`sidebar`，改 `web/` 下的页面即可。

## 反向代理
「功能 → 反向代理」添加规则：子路径 → 本机端口。例如把 4096 端口的服务映射到 `/grapenas/opencode`：

- HTTP：`/grapenas/opencode/...` 自动转发到 `127.0.0.1:4096/...`
- WebSocket：服务的 `/websocket` 即 `/grapenas/opencode/websocket`
- 页面内绝对路径资源（CSS/JS/图标/manifest）、SPA 前端路由、WS 连接自动适配，无需应用改造
- 内置路径（接口/静态/WS）统一在 `/grapenas` 前缀下；应用与手动反代路径仍在根下 `/应用id`（不带前缀），`grapenas` 这一段被系统占用，**应用 id 与代理路径都不能叫 grapenas**

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
├── web/                   # 前端（单壳页面，无构建）
├── sample-app/            # 示例应用包源码 + 打包脚本
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
