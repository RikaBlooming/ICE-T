# 冰某氚ICE-T · 粉丝展示站（自动更新版）

非官方粉丝向展示网站，数据来自 Bilibili 公开接口，每天自动同步 UP 主最新视频。

## 工作原理

1. `update_site.mjs` — 更新引擎：拉取 B 站最新视频 → 下载新封面 → 生成网页
2. `.github/workflows/update.yml` — 定时任务：每天北京时间 14:00 自动运行引擎并提交更新
3. 托管平台（Netlify / Cloudflare Pages）连接本仓库后，每次自动提交都会触发重新部署

## 文件说明

| 文件 | 用途 |
|---|---|
| `index.html` | 普通版（引用 assets/ 目录图片） |
| `index-standalone.html` | 单文件版（图片全部内嵌，上传这一个文件即可） |
| `assets/` | 封面图片（自动维护） |
| `user_videos.json` | 视频数据缓存（自动维护） |
| `update_site.mjs` | 更新引擎（手动跑：`node update_site.mjs`） |

## 部署步骤（全自动路线）

1. 注册 GitHub 账号：https://github.com/signup
2. 新建仓库（Create repository），命名如 `bingmou-ice-t-site`，选 **Public**（免费版 Actions 只有公开仓库免费）
3. 把本文件夹里所有文件上传到仓库（网页端 Upload files 或 Git 客户端均可）
4. 等待第一次 Actions 自动运行（Actions 标签页可看到进度），或到 Actions 页面手动 Run workflow 触发一次
5. 到 Netlify：https://app.netlify.com → Add new site → Import from Git → 选这个仓库，Build command 留空，Publish directory 填 `.`（根目录）
6. 部署完成后即可访问，此后每天自动更新

## 手动更新

```bash
node update_site.mjs
```

## 其他 UP 主

想换目标 UP 主：设置环境变量 `BILI_MID` 为对方 UID 后运行引擎即可（如 `BILI_MID=12345 node update_site.mjs`），并同步修改 `update_site.mjs` 里的 UID/头像/名称。
