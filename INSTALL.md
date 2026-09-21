# 安装与部署

本文档说明三种使用方式，按需要选一种即可：

| 方式 | 适合谁 | 需要什么 |
| --- | --- | --- |
| **A. 直接下载安装包** | 不想碰命令行的人 | 只要一个 `.exe` |
| **B. 从源码运行（桌面版）** | 想改代码、想用最新版 | Node.js + 一次 `npm install` |
| **C. 从源码运行（浏览器版）** | 只想快速用起来 | **只要 Node.js**，无需下载任何依赖 |

---

## 一、依赖说明

先把话说清楚：**这个项目没有任何运行时第三方依赖。**

我逐个文件扫描了 `src/`、`server/`、`electron/` 的全部 import 与 require，
除 `electron` 本身之外，用到的全部是 Node 内置模块：

```
node:crypto  node:fs  node:http  node:os  node:path  node:child_process
```

由此推出两件重要的事：

- **方式 C（浏览器版）只需要 Node.js**，不需要 `npm install`，不需要联网下载任何东西。
  数据照样写进本地磁盘，功能与桌面版完全一致。
- **方式 B（桌面版）唯一的依赖就是 Electron**（约 110 MB 的二进制），
  装在 `devDependencies` 里，不参与打包进应用代码。

### 运行时是否需要联网？

**不需要。** 界面上所有 `fetch` 都指向本机起的服务（`127.0.0.1` 或局域网地址）。
应用不会向任何外部服务器发送数据，也没有遥测、没有账号系统。
多人牌桌也走局域网直连，不经过互联网。

### Node.js 版本要求

| 用途 | 最低版本 | 为什么 |
| --- | --- | --- |
| 浏览器版 / 应用本体 | **16.6** | 用到 `Array.prototype.at()`（16.6）、`fs.rmSync`（14.14）、`node:` 前缀（14.18） |
| 跑测试 `npm test` | **20.11** | 测试脚本用了 `import.meta.dirname` |
| **建议** | **18 LTS 及以上** | 兼容性最好；本项目开发与验证用的是 Node 24 |

版本低于要求时，`npm install` 会在 `engines` 检查处给出提示。

检查你的版本：

```bash
node -v      # 应输出 v18.x 或更高
npm -v
```

---

## 二、方式 A：直接下载安装包

到 [Releases 页面](https://github.com/loyunemo/RPG_Recorder/releases) 下载对应文件：

| 文件 | 说明 |
| --- | --- |
| `RPG-Recorder-Setup-x.y.z.exe` | 安装版。装好后有开始菜单与桌面快捷方式，可卸载 |
| `RPG-Recorder-x.y.z-portable.exe` | 便携版。双击即用，不写注册表，可以放 U 盘里带着走 |

两个都是 64 位 Windows 程序。首次运行 Windows SmartScreen 可能拦截
（因为安装包没有购买代码签名证书），点「更多信息」→「仍要运行」即可。

数据默认存放在：

```
%APPDATA%\rpg-recorder\data
```

安装版与便携版共用这一个位置。**备份就是复制这个目录。**

---

## 三、方式 B：从源码运行（桌面应用）

### 1. 装 Node.js

到 [nodejs.org](https://nodejs.org/) 下载 LTS 版本安装。装完开一个新的终端验证：

```bash
node -v
npm -v
```

### 2. 取得源码

```bash
git clone https://github.com/loyunemo/RPG_Recorder.git
cd RPG_Recorder
```

没有 git 的话，在 GitHub 页面点 `Code` → `Download ZIP` 解压也一样。

### 3. 安装依赖

```bash
npm install
```

这一步只装一个东西：Electron。

> **国内网络注意**
> Electron 的二进制默认从 GitHub Releases 下载，经常超时或 `ECONNRESET`。
> 换成国内镜像再装：
>
> ```powershell
> # PowerShell
> $env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
> npm install
> ```
>
> ```bash
> # macOS / Linux
> export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
> npm install
> ```
>
> 如果 npm 的缓存目录不可写（权限问题），再补一个：
> `$env:npm_config_cache="$PWD\.npm-cache"`

### 4. 启动

```bash
npm start          # 正常启动
npm run dev        # 启动并打开开发者工具
```

### 5. 想先看看长什么样

```bash
npm run seed       # 生成四个演示战役（四套规则各一个）
npm start
```

---

## 四、方式 C：从源码运行（浏览器版，零依赖）

**不需要 `npm install`。** 只要有 Node.js：

```bash
git clone https://github.com/loyunemo/RPG_Recorder.git
cd RPG_Recorder
npm run serve
```

会自动打开浏览器指向 `http://127.0.0.1:41777/`。
加 `--no-open` 可以不自动开浏览器。

数据写在项目下的 `data/` 目录（可用环境变量 `RW_DATA_DIR` 换位置）。

这个模式同时就是**多人牌桌的服务端**：在界面里点「开启牌桌」，
局域网内的玩家用手机浏览器访问顶栏给出的地址即可加入。

端口被占用时换一个：

```powershell
$env:RW_PORT="41800"; npm run serve
```

---

## 五、验证安装是否正常

```bash
npm test
```

这个命令**不需要启动应用、也不需要 Electron**，
会跑 127 项核心逻辑测试（骰子引擎、四套规则、存储层、日志复现性、界面接口一致性）。

全部通过会输出：

```
────────────────────────────────────────────────────
全部通过：127 项
```

如果失败，多半是 `npm install` 没装完（跑测试其实不需要依赖，
所以失败更可能是 Node 版本过低或源码不完整）。

---

## 六、常见问题

**`npm install` 卡在 electron 下载不动**
见上面第三步的镜像设置。已经装了一半的话，先删掉 `node_modules` 再重来。

**`npm start` 报找不到 electron**
确认 `node_modules\electron\dist\electron.exe` 存在。
不存在说明安装脚本被跳过了，手动补一次：
```powershell
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
node node_modules/electron/install.js
```
（npm 10+ 默认可能拦截安装脚本，这条命令是绕过拦截手动执行它。）

**端口 41777 被占用**
设 `RW_PORT` 换一个，或关掉占用它的程序。

**局域网里的玩家连不上**
1. 确认主持人在界面里点了「开启牌桌」（没开的话服务只接受本机访问）
2. 检查 Windows 防火墙是否放行了 Node.js / RPG Recorder
3. 确认玩家和主持人连的是同一个网络（不是访客网络）

**数据存在哪里？怎么备份？**
桌面版在 `%APPDATA%\rpg-recorder\data`，
源码版在项目下的 `data/`。
界面里点「数据目录」按钮可直接打开。
备份 = 复制整个目录；恢复 = 覆盖回去。

---

## 七、自己打包发布

想构建安装包，需要额外装打包工具：

```bash
npm install -D electron-builder
```

构建：

```bash
npm run dist          # 生成安装版 + 便携版
npm run dist:win      # 只生成 Windows 版
```

产物在 `release/` 目录下。

> 打包时 electron-builder 还会额外下载 `winCodeSign`、`nsis` 等工具包，
> 同样可能被墙。用这个镜像：
>
> ```powershell
> $env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
> npm run dist
> ```

发布新版本前记得同步改 `package.json` 里的 `version`，
以及在 `CHANGELOG.md` 里记一笔。
