# 完整配置指南

## 📋 前置要求

- GitHub 账号
- X (Twitter) Developer 账号和 Bearer Token
- 可选: Supadata API Key (用于播客功能)

## 🔑 第一步：获取 API Keys

### X API Bearer Token

1. 访问 [Twitter Developer Portal](https://developer.twitter.com)
2. 创建 Project 和 App
3. 进入 App 设置 → Keys and Tokens
4. 复制 **Bearer Token**

**注意**: 
- Basic 计划 ($100/月) 每月 10,000 次请求
- Pro 计划 ($5000/月) 更多额度
- 如需免费方案，可考虑 RSS 服务如 rss.app

### Supadata API Key (可选)

1. 访问 [Supadata](https://supadata.ai)
2. 注册账号
3. 创建 API Key

## 🚀 第二步：配置 GitHub Secrets

1. 打开你的 GitHub 仓库页面
2. 点击 **Settings** 标签
3. 左侧菜单选择 **Secrets and variables** → **Actions**
4. 点击 **New repository secret**
5. 添加以下 Secrets：

```
Name: X_BEARER_TOKEN
Value: 你的 X API Bearer Token
```

```
Name: SUPADATA_API_KEY  
Value: 你的 Supadata API Key (可选)
```

## 👥 第三步：自定义关注列表

编辑 `config/default-sources.json`：

```json
{
  "x_accounts": [
    { "name": "Andrej Karpathy", "handle": "karpathy" },
    { "name": "Elon Musk", "handle": "elonmusk" },
    { "name": "李飞飞", "handle": "drfeifei" },
    { "name": "Mira Murati", "handle": "miramurati" },
    { "name": "Greg Brockman", "handle": "gdb" }
  ],
  "podcasts": [
    {
      "name": "Latent Space",
      "type": "youtube_channel",
      "url": "https://www.youtube.com/@LatentSpacePod",
      "channelHandle": "LatentSpacePod"
    },
    {
      "name": "No Priors",
      "type": "youtube_channel",
      "url": "https://www.youtube.com/@NoPriorsPodcast",
      "channelHandle": "NoPriorsPodcast"
    }
  ],
  "blogs": [
    {
      "name": "Anthropic Engineering",
      "type": "scrape",
      "indexUrl": "https://www.anthropic.com/engineering",
      "articleBaseUrl": "https://www.anthropic.com/engineering/",
      "fetchMethod": "http"
    }
  ]
}
```

添加更多关注者：
```json
{ "name": "显示名称", "handle": "x账号名" }
```

## ▶️ 第四步：测试运行

### 手动触发 GitHub Actions

1. 进入仓库页面 → **Actions** 标签
2. 左侧选择 **Generate X Feed**
3. 点击 **Run workflow** → **Run workflow**
4. 等待 1-2 分钟
5. 检查是否生成了 `feed-x.json` 文件

### 查看生成的 Feed

运行成功后，仓库根目录会出现：
- `feed-x.json` - X 内容
- `feed-podcasts.json` - 播客内容  
- `feed-blogs.json` - 博客内容

## 🕐 第五步：定时任务

GitHub Actions 已配置为每天 UTC 06:00 (北京时间 14:00) 自动运行。

修改定时时间：
编辑 `.github/workflows/generate-feed.yml`：

```yaml
schedule:
  - cron: '0 6 * * *'   # UTC 06:00 = 北京时间 14:00
  - cron: '30 22 * * *' # UTC 22:30 = 北京时间 06:30 (次日)
```

Cron 格式说明：
```
分 时 日 月 周
0  6  *  *  *   # 每天 6:00
```

## 🔧 第六步：本地使用

如果你想在本地运行生成摘要：

### 1. 克隆仓库

```bash
git clone https://github.com/你的用户名/仓库名.git
cd 仓库名
```

### 2. 配置环境变量

```bash
export X_BEARER_TOKEN="你的Token"
export SUPADATA_API_KEY="你的Key" # 可选
```

### 3. 运行脚本

```bash
cd scripts
node generate-feed.js
```

### 4. 查看结果

```bash
cat ../feed-x.json | head -50
```

## 🛠️ 故障排查

### GitHub Actions 运行失败

**问题**: "X_BEARER_TOKEN not set"
- **解决**: 检查 Secrets 是否正确配置，注意大小写

**问题**: "Rate limited"
- **解决**: X API 请求过于频繁，等待 15 分钟后重试

**问题**: 播客抓取失败
- **解决**: 可选功能，检查 SUPADATA_API_KEY 或暂时移除播客配置

### 没有生成 feed 文件

**检查步骤**:
1. 确认 Actions 成功完成（绿色 ✓）
2. 查看 Actions 日志中的错误信息
3. 检查 X 关注者列表是否正确
4. 确认 Bearer Token 有效且未过期

## 📊 查看生成的数据

生成的 JSON 文件结构：

**feed-x.json**:
```json
{
  "generatedAt": "2024-01-15T06:00:00Z",
  "x": [
    {
      "name": "Andrej Karpathy",
      "handle": "karpathy",
      "bio": "...",
      "tweets": [
        {
          "id": "...",
          "text": "推文内容",
          "createdAt": "...",
          "url": "https://x.com/..."
        }
      ]
    }
  ]
}
```

## 🔄 更新关注列表

1. 修改 `config/default-sources.json`
2. 提交更改：
   ```bash
   git add config/default-sources.json
   git commit -m "Add new X accounts"
   git push
   ```
3. 下次运行会自动包含新用户

## 🎨 高级配置

### 修改抓取频率

编辑 `scripts/generate-feed.js`:
```javascript
const TWEET_LOOKBACK_HOURS = 24;  // 回看时间窗口
const MAX_TWEETS_PER_USER = 3;    // 每人最大推文数
```

### 禁用播客/博客功能

编辑 `.github/workflows/generate-feed.yml`，只保留 X:
```yaml
- name: Generate feed
  env:
    X_BEARER_TOKEN: ${{ secrets.X_BEARER_TOKEN }}
  run: node scripts/generate-feed.js --tweets-only
```

## 📞 获取帮助

- GitHub Issues: 提交问题到本仓库
- X API 文档: https://developer.twitter.com/en/docs/twitter-api
- Supadata 文档: https://supadata.ai/docs

## ✅ 检查清单

部署前确认：
- [ ] GitHub Secrets 已配置 X_BEARER_TOKEN
- [ ] config/default-sources.json 已自定义
- [ ] GitHub Actions 成功运行过至少一次
- [ ] feed-x.json 文件已生成
- [ ] 定时任务配置正确
