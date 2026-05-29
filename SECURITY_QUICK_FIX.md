# NovelFlow 安全问题速查（P0紧急 + P1重要）

> 生成时间：2026-05-26 14:45
> 审计范围：app-v2.html + api/ 全部后端
> 用途：与开发对接优先修复清单

---

## P0 - 紧急（投流前必须修）

### 1. 前端积分/签到/VIP/reels额度全部可篡改
**风险**：用户打开控制台一行代码就能刷积分、刷VIP、重置reels额度
**现状**：所有数据存在 localStorage，纯客户端校验
```
localStorage.setItem('novelflow_points_USERNAME', '99999')  // 直接改积分
localStorage.setItem('novelflow_reels_count_USERNAME', '{"date":"2026-05-26","count":0}')  // 重置视频额度
localStorage.setItem('novelflow_vip_days_USERNAME', '999')  // 刷VIP
```
**修复建议**：
- 积分/VIP/签到数据同步到后端（Upstash Redis），前端只读展示
- 关键操作（签到、兑换VIP、创建reel）走API，后端校验
- 前端保留离线缓存但以服务端数据为准

### 2. submissions.json 仓库公开可读
**风险**：`submissions.json` 在 GitHub 公开仓库，任何人可读所有KOC数据
**现状**：文件包含 campaignId、bookId、linkId、discordUsername 等内部字段
**修复建议**：
- 将 submissions.json 移到私有仓库或 Upstash Redis
- API 返回的公开数据已经做了字段过滤（目前OK），但源文件仍可从 GitHub 直读

### 3. AC Token 暴露给前端
**风险**：`ac-create`/`ac-list`/`ac-result` 等API接受前端传来的 AC Token
**现状**：前端 localStorage 存了 `novelflow_ac_token`，用户可以拿到北斗平台Token
**修复建议**：
- 已有 Upstash Redis 存储方案（ac-kv），应全面切换为后端取Token
- 前端不再传递 x-ac-token header
- ac-create/ac-list/ac-result 只从 Redis 读取 Token

### 4. ac-create 无用户认证
**风险**：任何人可以无限创建视频任务，消耗AC平台额度
**现状**：ac-create.js 不验证用户身份，前端传 username 就行
**修复建议**：
- 要求 JWT cookie 认证
- 后端校验每日创建限制（Redis 计数器），不依赖前端 localStorage

---

## P1 - 重要（投流后一周内修）

### 5. CORS 允许 localhost
**风险**：开发环境的 localhost 配置不应出现在生产
**现状**：`ALLOWED_ORIGINS` 包含 `http://localhost:3000` 和 `http://localhost:8080`
**修复建议**：
- 通过环境变量 `NODE_ENV` 区分，生产环境去掉 localhost

### 6. JWT 无过期机制
**风险**：JWT 只有 iat，无 exp 字段，30天硬编码校验
**现状**：verifyJWT 中 `maxAge = 2592000` 硬编码
**修复建议**：
- 添加标准 exp 字段
- 支持服务端 Token 吊销（Redis 黑名单）

### 7. 密码哈希用 SHA256
**风险**：SHA256 不适合密码哈希，容易被彩虹表攻击
**现状**：`hashPassword = sha256('nf_' + password + '_salt2026')`
**修复建议**：
- 改用 bcrypt（Vercel 支持）或至少用 PBKDF2/scrypt
- 盐值改为每用户独立随机盐

### 8. submit API 缺少速率限制
**风险**：恶意用户可以批量提交刷链接
**现状**：submit.js 无任何频率限制
**修复建议**：
- Upstash Redis 实现简单速率限制（如 10次/分钟/IP）
- 或 Vercel Edge Config 限流

### 9. 前端 GitHub PAT 暴露在 git remote URL
**风险**：虽然不在前端代码中，但 git remote URL 包含 PAT
**现状**：已在 SECRET.md 标记，PAT 已更换
**修复建议**：
- 使用 SSH key 或环境变量注入，不嵌入 URL

---

## P2 - 改进（迭代优化）

### 10. XSS 风险 - innerHTML 使用
**现状**：67处 innerHTML，部分使用了 escapeHtml，但需逐一审查
**修复建议**：所有用户输入渲染必须经过 escapeHtml

### 11. 重复环境变量
**现状**：Vercel 中 GITHUB_TOKEN/BOOKSTORE_TOKEN 等重复配置
**修复建议**：清理重复项，统一管理

### 12. 缺少 CSP Header
**修复建议**：Vercel 配置 Content-Security-Policy，防止 XSS

---

## 快速修复代码示例

### P0-1: 积分服务端校验（签到API示例）

```javascript
// api/auth/checkin.js
const { Redis } = require('@upstash/redis');
const { verifyJWT } = require('../_lib/jwt');

module.exports = async (req, res) => {
  // 1. 验证JWT
  const payload = verifyUser(req);
  if (!payload) return res.status(401).json({ error: 'Not logged in' });

  const redis = getRedis();
  const today = new Date().toISOString().split('T')[0];
  const key = `nf_checkin:${payload.username}:${today}`;

  // 2. 防重复签到
  const already = await redis.get(key);
  if (already) return res.status(400).json({ error: 'Already checked in' });

  // 3. 计算积分（服务端逻辑）
  const streak = await getStreak(redis, payload.username);
  const pts = [5,5,5,5,5,10,15][Math.min(streak, 6)];

  // 4. 原子写入
  await redis.set(key, JSON.stringify({ pts, streak, ts: Date.now() }));
  await redis.incrby(`nf_points:${payload.username}`, pts);

  return res.json({ success: true, pts, streak: streak + 1 });
};
```

### P0-3: AC API 切换为后端取Token

```javascript
// api/ac-create.js - 移除前端传token
async function getACToken(req) {
  const redis = getRedis();
  if (redis) {
    const token = await redis.get('ac_token');
    if (token) return token;
  }
  return process.env.AC_TOKEN || null;
}
// 不再读取 req.headers['x-ac-token']
```

---

## 投流前最低要求清单

- [ ] P0-1: 积分/签到/VIP 关键数据后端校验（至少签到和VIP兑换走API）
- [ ] P0-3: AC Token 移除前端传递
- [ ] P0-4: ac-create 加JWT认证 + 后端频率限制
- [ ] P1-5: CORS 移除 localhost
- [ ] P1-7: 密码哈希升级 bcrypt
