# 葡萄云 GrapeNAS

轻量、零构建的自托管 NAS 管理面板。单端口（9643）承载 Web 界面、反向代理与 WebSocket 通讯。
前端是一个无路由的单壳页面（`/`），所有页面靠视图切换；数据交互以 WebSocket 为主，
文件上传/下载与应用包上传/安装走 HTTP。

## 功能特性

### 认证与安全

- **访问码**：8 位数字（SHA-256 加盐存储、时序安全比较），首次访问强制设置；同一 IP 连续 5 次失败锁定 30 秒
- **临时令牌**：登录成功签发随机令牌，写入 HttpOnly Cookie（`SameSite=Lax`、`Path=/`），有效期 7 天
- **令牌只存在内存里**：服务端不落盘签发记录，**重启葡萄云后所有设备都要重新输入访问码**
- 令牌通道：HTTP 接口接受 Cookie 或 `Authorization: Bearer`；代理 WebSocket 三者都认
  （Cookie / `Authorization: Bearer` / `?token=`）；面板自身 WebSocket（`/grapenas/ws`）只认 Cookie
- 修改访问码需先验证当前访问码（选项 → 安全设置 → 访问码）
- **唯一的例外**：应用用 `nocodeport` 声明的 `/nocode/<应用id>/` 故意不校验访问码（见下），
  只靠"应用是否在运行"控制开合

### 界面

| 页面 | 内容 |
|---|---|
| 仪表盘 | 主机名 / 系统 / CPU / 内存 / 系统与服务运行时间 / Node 版本 / 服务器时间，加实时日志（彩色级别、一键清空） |
| 文件管理 | 根下两个入口「我的文件 / 应用文件」；进入目录、上传（多选）、下载、删除、移动、复制、新建文件夹 |
| 应用 | 磁贴式启动器 + 桌面快捷方式磁贴；拖入 `.tar` 应用包安装 |
| 选项 | 重启葡萄云、个性化设置（页面颜色）、安全设置（访问码）、存储设置（存储位置） |

- **页面颜色**（选项 → 个性化设置 → 页面颜色）：深浅色（深 / 浅）× 主题色（紫 / 蓝 / 橙 / 黄 / 黑白）。
  服务端持久化并广播给所有在线设备；前端另存 localStorage，首屏不闪色
- **移动端**：≤768px 响应式布局 + 抽屉导航；访问码页为分格输入（支持整串粘贴）

### 通讯

- 数据全走 `/grapenas/ws`：系统信息、日志、应用、代理规则、存储位置、文件操作、页面颜色、快捷方式
- 心跳保活（服务端 30s ping 回收假死连接、客户端 25s 心跳 + 50s 静默判定）、握手 5s 超时、
  断线 2s 自动重连、令牌失效（close 4401）自动回访问码页
- 服务端主动推送事件：`log`（实时日志）、`theme`（页面颜色变更）、`shortcuts`（快捷方式增删）、
  `sidebar`（应用侧边栏刷新）
- 日志是内存环形缓冲（最多 500 条）

### 应用（tar 应用包）

- **安装**：把 `.tar` 拖进「添加应用」→ 预览图标 / 名称 / Markdown 描述 → 安装；包上限 50MB
- **安装完就启动**。磁贴点击行为：未运行 → 启动；运行中且有 WebUI → 新窗口打开 `/<应用id>/`；
  运行中且无 WebUI → 打开应用设置
- **应用设置**：Markdown 描述 + 启动 / 停止 / 卸载（停进程 → 清代理规则 → 删包目录 → 删日志与登记）；
  声明了 `nocodeport` 的应用还会列出免访问码地址
- **生命周期**：开机自动启动全部应用；重启后按 PID 记录收养存活进程、不重复启动；
  异常退出写日志并保持停止；输出重定向到 `data/logs/app-<id>.log`；Windows 下无窗口后台运行
- **多端口**：应用第一个端口映射到 `/<应用id>`，其余端口映射到 `/<应用id>-<端口>`
- **免访问码入口**：`config.json` 里声明 `nocodeport` 后，这个端口的 Web 服务代理到 `/nocode/<应用id>`，
  **该路径不校验访问码**（HTTP 与 WebSocket 都能直接访问），换台设备打开就能用；应用一停入口立即失效
- **桌面快捷方式**（Windows）：应用页可加指向桌面 `.lnk` 的磁贴，点击用 `explorer` 启动，右上角删除
- **侧边栏入口**：应用包用 `sidebar.json` 声明任意多个入口，运行时可用密钥刷新（见下）
- **每应用密钥**：安装时随机生成，通过环境变量与包内 `.grapenas.json` 下发给应用

## 技术栈

| 层 | 技术 |
|---|---|
| 运行时 | Node.js，代码实际只 import `ws` 一个第三方包 |
| 前端 | 原生 HTML/CSS/JS，无框架无构建 |
| 应用包 | tar + `main.js`（node 脚本）约定 |

> `package.json` 里还列着 `express` / `koffi` / `node-screenshots` / `sharp`，
> 这些是历史功能的遗留声明，当前源码没有任何引用。

## 快速开始

```bash
npm install
npm start
```

打开 <http://localhost:9643/>，首次访问会要求设置 8 位访问码（此后每次访问都需要输入）。

macOS / Linux 直接 `npm start` 或 `nohup node server/index.js &`。

## 路径约定

| 类型 | 路径 |
|---|---|
| 壳页面 | `/`（`/index.html` 同义） |
| 内置接口 / 静态 / WebSocket | `/grapenas/api/...`、`/grapenas/style.css`、`/grapenas/app.js`、`/grapenas/ws`、`/grapenas/auth` |
| 应用 / 反向代理 | `/<应用id>/...`（不带前缀，需要访问码） |
| 应用免访问码入口 | `/nocode/<应用id>/...`（不带前缀，**不校验访问码**，由 `nocodeport` 生成） |
| 禁止 | 不带 `/grapenas` 前缀的内置路径与根级静态文件（`/style.css`、`/app.js`）一律 404 |

`grapenas` 与 `nocode` 这两段被系统占用，**应用 id 与手动代理路径都不能叫它们**。

## 应用包格式

应用以 `.tar` 打包，在「应用」页拖入安装：

```
app.tar
├── config.json     # 应用元信息（必填）
├── main.js         # 唯一入口（必填，用 node 执行，全平台）
├── sidebar.json    # 侧边栏入口声明（可选，数组；见下）
├── icon.png        # 图标（可选，config.json 中声明路径）
├── package.json    # 可选；不提供时安装后自动写入 {"type":"commonjs"}
└── web/...         # main.js 自己的前端资源（位置随意）
```

约定：

- `main.js` 由葡萄云自带的 node（`process.execPath`）执行，进程日志写到 `data/logs/app-<id>.log`。
- 应用以 detached 方式启动：葡萄云退出后应用继续存活，葡萄云再启动时按 PID 记录收养，不会重复拉起。
- `main.js` 一退出就等于应用停止；需要收尾就在 `main.js` 里监听 `SIGINT` / `SIGTERM`。
- 包内 `.js` 默认按 CommonJS 解析（包内自带 `package.json` 时不覆盖）。
- 安装时会校验：`id` 合法且未被占用、`main.js` 存在、图标与侧边栏声明的文件真实存在且路径不越界。

`config.json` 示例（一个带 WebUI、带单入口侧边栏的应用）：

```json
{
  "id": "hello",
  "name": "示例应用",
  "description": "### 这是什么\n\n一个最小的葡萄云应用示例。\n\n- 自带 WebUI：`http://<葡萄云地址>/hello/`\n- 在侧边栏加一个入口",
  "icon": "icon.png",
  "port": 18990,
  "sidebar": {
    "iconsvg": "information_icon.svg",
    "sidebar_name": "示例应用信息",
    "page": "web/information_sidebar.html"
  }
}
```

最小可用就是 `{"id": "hello"}`：只要包内有 `main.js` 就能安装，`name` 缺省用 `id`，`description` 缺省为空。
要多个侧边栏入口时，把 `sidebar` 去掉、改用包根 `sidebar.json`（见下）。

`config.json` 字段：

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 应用标识（字母数字 `- _`，≤32 字符，不可为 `grapenas` / `nocode`） |
| `name` | 否 | 显示名，缺省用 id |
| `description` | 否 | 描述，支持 Markdown |
| `icon` | 否 | 图标在包内的相对路径（禁止越界） |
| `port` | 否 | WebUI 端口；配置后自动反代到 `/<id>`，需要访问码 |
| `nocodeport` | 否 | **免访问码** WebUI 端口；自动反代到 `/nocode/<id>`，该路径不校验访问码 |
| `sidebar` | 否 | 单入口侧边栏（兼容写法）；多入口请用包根 `sidebar.json`，见下 |

`port` 与 `nocodeport` 可以同时声明（同一个应用两个入口，一个要访问码一个不要），也可以只声明 `nocodeport`。
两个端口都必须由 `main.js` 自己监听，葡萄云只负责代理。

> 免访问码 = 任何能访问到 9643 端口的人都能打开，别把敏感数据放在这一侧；应用停止后入口立即 404。

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
  `window.GrapenasHost.switchView(view)`、`window.GrapenasHost.reloadView()`（重新挂载当前视图）。
- 声明的图标与页面必须真实存在于包内，否则安装会失败。
- 兼容写法：`config.json` 里写单个 `sidebar` 对象也可以（等价于只有一项的 sidebar.json）。

#### 运行时刷新侧边栏

葡萄云在**启动应用时**读一次 `sidebar.json`；应用运行中改了入口（增删项、换名字/图标），
只需让应用 POST 一次葡萄云接口（需要该应用的密钥）：

```bash
POST /grapenas/api/reload_sidebar/<应用id>
Header: x-grapenas-app-secret: <应用密钥>        # 也支持 ?secret=<密钥>
```

密钥是安装应用时随机生成的，葡萄云启动应用时会：

- 通过环境变量 `GRAPENAS_APP_SECRET`（还有 `GRAPENAS_APP_ID`、`GRAPENAS_BASE_URL`、`GRAPENAS_DATA_DIR`）下发；
- 同时写进包内 `.grapenas.json`：`{ "id":…, "secret":…, "base_url":…, "reload_sidebar":"/api/reload_sidebar/<id>" }`。

刷新成功后，葡萄云会把最新的入口列表通过 WebSocket 事件 `sidebar` 推给所有已连接的客户端，
前端收到就重建侧边栏，不需要手动刷新页面。

## 反向代理

子路径 → `127.0.0.1:<端口>`，HTTP 与 WebSocket 同时映射：

- HTTP：`/<子路径>/...` 转发到 `127.0.0.1:<端口>/...`
- WebSocket：`/<子路径>/websocket` 即目标服务的 `/websocket`（TCP 透传 + keepalive）
- 自动改写 HTML 中 `href/src/action="/x"` 为 `/<子路径>/x`，并在 `<head>` 注入子路径适配脚本：
  包装 `history.pushState/replaceState`（SPA 前端路由留在子路径下）与 `WebSocket` 构造器（同源根路径 WS 自动改连子路径）
- 绝对路径 302 也补前缀；注入脚本需要内联执行，所以会去掉上游 CSP
- 目标服务用绝对路径引资源（CSS/JS/图标/manifest、运行时 fetch）时请求会落到根路径，
  此时按 Referer 归属回对应规则

应用的 WebUI 会自动生成规则：第一个端口 → `/<应用id>`，第 2..n 个端口 → `/<应用id>-<端口>`，
随应用启动/卸载同步增删，不影响手动规则。

应用还可以用 `config.json` 的 **`nocodeport`** 生成一条**免访问码**规则：
`/nocode/<应用id>` → `127.0.0.1:<nocodeport>`，HTTP 与 WebSocket 都不校验访问码
（请求在鉴权门之前直接进入代理）。`/nocode` 是系统保留段，应用 id 与手动代理规则都不能占用。

> 手动规则的界面（旧版的「选项 → 反向代理」页）已在早期版本从菜单移除，
> 服务端的 `proxy.list` / `proxy.add` / `proxy.remove` 三条 WS 消息仍在；
> 当前界面上的代理规则都来自应用端口（含 `nocodeport`）。

## 示例应用

`sample-app/` 里有一个可直接安装的示例，演示 `nocodeport`：

```
sample-app/
├── nocode-demo/          # 免访问码入口示例
│   ├── config.json       # port 18991（要访问码）+ nocodeport 18992（不要）
│   ├── main.js           # 同一份页面监听两个端口
│   └── web/              # 页面（资源与接口都用相对路径）
├── pack.mjs              # 打包成 .tar
├── dist/                 # 打包输出（.gitignore 已忽略）
└── README.md
```

```bash
node sample-app/pack.mjs        # 生成 sample-app/dist/nocode-demo.tar
```

把生成的 `.tar` 拖到「应用」页安装（装完自动启动），然后打开：

| 地址 | 需要访问码 |
|---|---|
| `/nocode/nocode-demo/` | 否（换台设备、隐私窗口都能直接开） |
| `/nocode-demo/` | 是 |

详细说明见 [`sample-app/README.md`](sample-app/README.md)，其中也写了写免访问码应用的两个坑：
资源要用相对路径、`fetch('/x')` 这类绝对路径不会被改写。

## 内置接口一览

### WebSocket 消息

请求 `{ id, type, data }`，响应 `{ id, type: '<type>.result', ok, data | error }`。

| 分类 | 消息 |
|---|---|
| 通用 | `ping`、`sys.info`、`logs.list`、`logs.clear` |
| 设置 | `settings.get`、`settings.setAccessCode`、`theme.get`、`theme.set` |
| 存储与文件 | `storage.get`、`storage.set`、`files.list`、`files.mkdir`、`files.delete`、`files.move`、`files.copy` |
| 应用 | `apps.list`、`apps.add`、`apps.update`、`apps.remove`、`apps.start`、`apps.stop` |
| 代理 | `proxy.list`、`proxy.add`、`proxy.remove` |
| 快捷方式 | `shortcuts.list`、`shortcuts.add`、`shortcuts.remove`、`shortcuts.launch` |
| 系统 | `system.restart` |

### HTTP 端点

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/`、`/index.html` | 公开 | 壳页面 |
| GET | `/grapenas/style.css`、`/grapenas/app.js`、`/grapenas/grape.svg` | 公开 | 壳页面自身资源 |
| GET | `/grapenas/auth` | 公开 | 访问码页（已认证则跳 `/`） |
| GET | `/grapenas/api/auth/status` | 公开 | 是否已设置访问码 / 当前是否已认证 |
| POST | `/grapenas/api/auth` | 公开 | 校验（或首次设置）访问码，成功写 Cookie |
| POST | `/grapenas/api/reload_sidebar/<应用id>` | 应用密钥 | 刷新该应用的侧边栏入口 |
| POST | `/grapenas/api/apps/upload` | 令牌 | 上传 tar 暂存，返回安装 `token` 与预览元信息（≤50MB） |
| POST | `/grapenas/api/apps/install` | 令牌 | 按 `token` 安装并启动 |
| GET | `/grapenas/api/apps/icon?id=` | 令牌 | 应用图标 |
| GET | `/grapenas/api/apps/sidebar?id=&entry=` | 令牌 | 侧边栏页面片段（相对资源已改写） |
| GET | `/grapenas/api/apps/sidebar-icon?id=&entry=` | 令牌 | 侧边栏图标 |
| GET | `/grapenas/api/apps/sidebar-asset?id=&entry=&file=` | 令牌 | 片段内的静态资源 |
| GET | `/grapenas/api/files/download?path=` | 令牌 | 下载（一律附件下载） |
| POST | `/grapenas/api/files/upload?path=&name=` | 令牌 | 上传单个文件（≤200MB） |
| 任意 | `/<应用id>/...` | 令牌 | 应用 WebUI / 手动代理规则 |
| 任意 | `/nocode/<应用id>/...` | **公开** | 应用用 `nocodeport` 声明的免访问码入口（含 WebSocket） |

## 目录结构

```
grapenas/
├── server/                # Node 服务端
│   ├── index.js           # HTTP 入口（9643）：前缀剥离、认证门禁、静态、内置接口、反代路由
│   ├── ws.js              # WebSocket 通道 + 全部消息处理器 + 代理 WS 升级
│   ├── auth.js            # 访问码校验、临时令牌签发/验证
│   ├── apps.js            # 应用生命周期、tar 包暂存/安装/卸载、进程记录与 PID 校正
│   ├── storage.js         # 存储位置校验、文件路径安全解析、数据迁移
│   ├── proxy.js           # 反向代理：HTTP 转发、WS 隧道、HTML 改写、子路径适配脚本
│   ├── config.js          # 配置持久化、站内路径前缀
│   ├── logger.js          # 内存环形日志 + 订阅推送
│   └── util.js
├── web/                   # 前端（单壳页面，无构建）
│   ├── index.html         # 壳页面（全部视图都在这一个文件里）
│   ├── app.js             # 视图切换、WS 客户端、应用片段挂载、页面颜色
│   ├── style.css          # 样式与响应式布局
│   ├── auth.html          # 访问码页（分格输入）
│   ├── grape.svg
│   └── icons/             # 侧边栏图标
├── restart_helper.js      # 网页"重启葡萄云"的独立助手
├── sample-app/            # 示例应用（nocode-demo + pack.mjs 打包脚本）
└── package.json           # npm start
```

## 数据与安全

| 路径 | 说明 |
|---|---|
| `<存储位置>/user/` | 我的文件（文件管理） |
| `<存储位置>/.package/<id>/` | 已安装的应用包解压目录（含运行时写入的 `.grapenas.json`） |
| `data/config.json` | 访问码（加盐哈希，非明文）、存储位置、代理规则、应用登记、快捷方式、页面颜色 |
| `data/logs/app-<id>.log` | 各应用运行日志（卸载时删除） |
| `data/tmp/` | 应用包上传暂存（安装后自动清理） |
| `.ground_progress` | 应用 PID 记录（收养兜底；进程退出即清理） |

安全措施：访问码加盐哈希 + 时序安全比较、同 IP 连续失败锁定、令牌 HttpOnly Cookie、
资源请求不重定向（防缓存污染）、页面与前端资源响应 `no-store`、未认证/未命中响应也显式禁止缓存
（防旧版本或 401 被浏览器存下来）、
存储路径与文件路径越界校验、应用包图标与侧边栏路径双重防穿越（词法 + realpath）、
代理路径与保留段校验、应用 id 不可占用 `grapenas` / `nocode`。

注意：`/nocode/<应用id>/` 是**有意不设防**的（应用自己在 `config.json` 里声明 `nocodeport` 才会生成），
它绕过访问码与令牌校验，只靠"应用是否在运行"控制开合。敏感数据不要放在这个入口后面。

## 授权

MIT License
