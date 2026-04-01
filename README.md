# X Feed Generator

个性化 AI 摘要生成器 - 自动抓取 X/Twitter、YouTube 播客和博客内容，生成每日 AI 摘要。

## 🎯 功能特性

- **X/Twitter 抓取**: 跟踪你关注的 AI 领域建设者
- **YouTube 播客**: 自动抓取最新播客节目和字幕
- **博客监控**: 监控 Anthropic、OpenAI 等官方博客
- **智能去重**: 避免重复内容，只看最新动态
- **每日推送**: 通过 GitHub Actions 定时运行

## 🚀 快速开始

### 1. 配置 GitHub Secrets

在仓库 Settings → Secrets → Actions 中添加：

| Secret | 说明 | 必需 |
|--------|------|------|
| `X_BEARER_TOKEN` | X API v2 Bearer Token | ✅ 必需 |
| `SUPADATA_API_KEY` | Supadata API Key (播客功能) | ⚠️ 可选 |

### 2. 自定义关注列表

编辑 `config/default-sources.json`：

```json
{
  "x_accounts": [
    { "name": "Andrej Karpathy", "handle": "karpathy" }
    // 添加你想关注的人
  ],
  "podcasts": [
    // YouTube 播客配置
  ],
  "blogs": [
    // 博客监控配置
  ]
}
```

### 3. 触发运行

- **自动**: 每天 UTC 06:00 (北京时间 14:00) 自动运行
- **手动**: 在 Actions 页面点击 "Run workflow"

## 📁 项目结构

```
.
├── .github/workflows/
│   └── generate-feed.yml    # GitHub Actions 配置
├── config/
│   └── default-sources.json  # 数据源配置
├── scripts/
│   ├── generate-feed.js      # 核心抓取脚本
│   └── package.json
├── feed-x.json              # 生成的 X 内容 (自动提交)
├── feed-podcasts.json       # 生成的播客内容 (自动提交)
├── feed-blogs.json          # 生成的博客内容 (自动提交)
└── state-feed.json          # 去重状态 (自动提交)
```

## 📖 详细文档

- [SETUP.md](./SETUP.md) - 完整配置指南

## 🔧 技术栈

- **运行时**: Node.js 20
- **API**: X API v2, Supadata API
- **CI/CD**: GitHub Actions

## 📝 License

MIT
