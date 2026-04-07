# X Feed Generator

个性化 AI 摘要生成器 - 自动抓取 X/Twitter 内容，按 AI/Web3 分类整理

## 🎯 功能特性

- **X/Twitter 抓取**: 跟踪关注的 AI & Web3 领域建设者（支持分类）
- **智能分类**: 自动按 AI/Web3 分类整理用户和内容
- **36小时滑动窗口**: 自动清理超过36小时无更新的用户数据
- **续跑机制**: 跨天自动继续未完成的一轮，确保数据完整
- **每日定时**: 每天北京时间 08:00 自动运行一轮

## 🚀 快速开始

### 1. 配置 GitHub Secrets

在仓库 Settings → Secrets → Actions 中添加：

| Secret | 说明 | 必需 |
|--------|------|------|
| `X_BEARER_TOKEN` | X API v2 Bearer Token | ✅ 必需 |

### 2. 自定义关注列表

编辑 `config/default-sources.json`：

```json
{
  "categories": {
    "AI": { "id": "AI" },
    "Web": { "id": "Web" }
  },
  "x_accounts": [
    { "name": "Andrej Karpathy", "handle": "karpathy", "category": "AI" },
    { "name": "Vitalik", "handle": "VitalikButerin", "category": "Web" }
  ]
}
```

- `categories`: 定义分类，目前支持 AI 和 Web
- `x_accounts`: 用户列表，每个用户指定 `category` 归属

### 3. 触发运行

- **自动**: 每天 UTC 00:00 (北京时间 08:00) 自动运行
- **运行时长**: 约 2-3 小时（取决于名单人数）
- **手动**: 在 Actions 页面点击 "Run workflow"

## 📁 项目结构

```
.
├── .github/workflows/
│   └── generate-feed.yml    # GitHub Actions 配置
├── config/
│   └── default-sources.json  # 数据源配置（用户名单+分类）
├── scripts/
│   ├── generate-feed.js      # 核心抓取脚本
│   └── package.json
├── feed-x.json              # 生成的 X 内容（按分类组织）
└── state-feed.json          # 处理状态和去重记录
```

## ⚙️ 运行机制

1. **每轮目标**: 处理全部名单用户（当前 54 人，动态适应名单变化）
2. **处理方式**: 每 5 人一批，批次间等待 3 分钟，用户间等待 3 分钟
3. **续跑逻辑**: 
   - 如果某天未完成（如处理了 40 人）
   - 第二天会先处理剩余 14 人，再处理新一轮的前 40 人
   - 确保每天都产出完整数据（共 54 人）
4. **数据清理**: 超过 36 小时无新推文的用户自动从 feed 中移除

## 📤 输出格式

`feed-x.json` 按分类组织：

```json
{
  "generatedAt": "2026-04-07T08:30:00Z",
  "lookbackHours": 24,
  "categories": {
    "AI": {
      "builders": [...],
      "stats": { "builderCount": 29, "tweetCount": 65 }
    },
    "Web": {
      "builders": [...],
      "stats": { "builderCount": 25, "tweetCount": 55 }
    }
  },
  "totalStats": {
    "totalBuilders": 54,
    "totalTweets": 120
  }
}
```

## 📖 详细文档

- [SETUP.md](./SETUP.md) - 完整配置指南

## 🔧 技术栈

- **运行时**: Node.js 22
- **API**: X API v2
- **CI/CD**: GitHub Actions

## 📝 License

MIT
