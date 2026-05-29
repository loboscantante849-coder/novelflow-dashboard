# NovelFlow书籍推荐官 安全审计报告

**项目**: NovelFlow书籍推荐官  
**报告人**: 徐敬涛  
**审计日期**: 2026-05-26  
**审计范围**: app-v2.html (前端)、api/*.js (后端API)、api/_lib/ (工具库)  
**风险等级**: 🔴 高危 - 内测阶段即将通过Facebook广告推广，急需修复

---

## 执行摘要

本次审计发现 **3个P0紧急问题**、**6个P1重要问题**、**5个P2改进项**。最严重的问题是：

1. **生产环境凭证硬编码**在 `oidc-token.js` 中
2. **前端 localStorage 可被用户完全篡改**（积分、VIP、reels额度等）
3. **JWT 密钥使用弱默认值**

---

## 一、P0 紧急问题（必须立即修复）

### P0-1: 生产环境凭证硬编码

**严重程度**: 🔴 极高  
**风险**: 任何人可以获取 NovelSpa 后台的管理权限

**位置**: `api/_lib/oidc-token.js` 第24-25行

```javascript
// ❌ 当前代码 - 危险！
const username = process.env.OIDC_USERNAME || 'xujt';
const password = process.env.OIDC_PASSWORD || '9@OY9NuHX4O2';
```

**修复建议**:
1. 立即删除代码中的硬编码凭证
2. 强制要求环境变量设置
3. 在 Vercel 中设置正确的环境变量

**修复代码**:
```javascript
// api/_lib/oidc-token.js
async function getFreshToken() {
  const username = process.env.OIDC_USERNAME;
  const password = process.env.OIDC_PASSWORD;

  // 生产环境必须配置环境变量
  if (!username || !password) {
    console.error('OIDC credentials not configured! Set OIDC_USERNAME and OIDC_PASSWORD env vars.');
    return null;
  }
  // ... 其余代码不变
}
```

---

### P0-2: localStorage 敏感数据可被完全篡改

**严重程度**: 🔴 极高  
**风险**: 用户可以无限刷积分、延长VIP、绕过reels限制

**位置**: `app-v2.html` 第3919-3987行

**当前实现问题**:
```javascript
// ❌ 当前代码 - 用户可以随意修改
function getUserPoints() {
    return parseInt(localStorage.getItem(getUserKey('points')) || '0');
}
function addUserPoints(pts) {
    const current = getUserPoints();
    const newPts = current + pts;
    // 虽然有上限5000，但用户可以手动修改
    localStorage.setItem(getUserKey('points'), newPts);
}

// ❌ checksum 校验形同虚设 - 校验算法本身在前端可见
function computePointsChecksum(pts, claimed, checkinData) {
    // 用户可以直接调用 savePointsChecksum() 伪造校验值
    // 或者直接删除 pts_checksum 触发新计算
}
```

**受影响的数据**:
| 数据项 | localStorage Key | 影响 |
|--------|------------------|------|
| 用户积分 | `novelflow_points_{username}` | 可刷积分兑换VIP |
| 签到数据 | `novelflow_checkin_{username}` | 可伪造连续签到 |
| VIP天数 | `novelflow_vip_days_{username}` | 可无限延长VIP |
| 任务状态 | `novelflow_claimed_{username}` | 可重复领取任务奖励 |
| Reels配额 | 内存变量 + API校验 | 可绕过前端限制 |

**修复建议**:
1. **所有关键数据必须后端存储和校验**
2. 前端只能展示，后端才是权威
3. 添加后端API进行积分/VIP有效性校验

**修复架构**:
```javascript
// 后端 API: /api/user/state
// GET - 获取用户状态（积分、VIP、签到等）
// POST - 执行操作（签到、领取奖励等）

// 前端 - 只负责展示和触发
async function doCheckin() {
    const response = await fetch('/api/checkin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include'
    });
    const data = await response.json();
    // 展示后端返回的数据，不信任本地存储
    updateUI(data);
}

// 前端删除以下本地修改功能:
function getUserPoints() { return serverState.points; }
function addUserPoints(pts) { /* 禁止前端直接修改 */ }
```

---

### P0-3: JWT 密钥使用弱默认值

**严重程度**: 🔴 高  
**风险**: 如果 JWT_SECRET 未设置，令牌可被伪造

**位置**: `api/_lib/jwt.js` 第8-18行

```javascript
// ❌ 当前代码
function getSecret() {
  if (!JWT_SECRET) {
    if (process.env.VERCEL === '1') {
      console.error('⚠️ JWT_SECRET not set in production! JWT tokens are insecure.');
    }
    return 'nf-dev-secret-not-for-production-use';  // 硬编码默认值
  }
  return JWT_SECRET;
}
```

**修复建议**:
```javascript
// api/_lib/jwt.js
const JWT_SECRET = process.env.JWT_SECRET;

function getSecret() {
  if (!JWT_SECRET) {
    throw new Error('FATAL: JWT_SECRET environment variable is not set. API cannot function.');
  }
  return JWT_SECRET;
}

function createJWT(payload) {
  // 在函数开头检查，避免运行时才发现问题
  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET not configured');
  }
  // ... 其余代码
}
```

---

## 二、P1 重要问题

### P1-1: 密码使用弱哈希算法

**严重程度**: 🟠 高  
**风险**: 密码可被彩虹表攻击破解

**位置**: `api/auth/login.js`, `api/auth/register.js`

```javascript
// ❌ 当前使用简单 SHA256 + 固定盐
function hashPassword(password) {
  return crypto.createHash('sha256').update('nf_' + password + '_salt2026').digest('hex');
}
```

**问题**:
1. 固定盐 `salt2026` 意味着相同密码总是产生相同哈希
2. SHA256 不是专门设计用于密码哈希
3. 缺少密钥拉伸（key stretching）

**修复建议**: 使用 bcrypt 或 Argon2

```javascript
// api/auth/register.js
const bcrypt = require('bcrypt');
const SALT_ROUNDS = 12;

async function hashPassword(password) {
  return bcrypt.hashSync(password, SALT_ROUNDS);
}

async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

// 使用示例
const newHash = await hashPassword(password);
await redis.set('nf_user_pass:' + username, newHash);
```

---

### P1-2: CORS 配置过于宽松

**严重程度**: 🟠 中高  
**风险**: 可能被恶意网站滥用API

**位置**: `api/_lib/cors.js`

```javascript
// 当前配置
const ALLOWED_ORIGINS = [
  'https://novelflow-dashboard.vercel.app',
  'https://loboscantante849-coder.github.io',
  'http://localhost:3000',
  'http://localhost:8080'
];

// 使用 startsWith 匹配
if (ALLOWED_ORIGINS.some(allowed => origin.startsWith(allowed))) {
```

**问题**:
1. `startsWith` 匹配可能允许子域名滥用
2. GitHub Pages 域名可能被滥用
3. 没有验证域名所有权

**修复建议**:
```javascript
// api/_lib/cors.js
const ALLOWED_ORIGINS = new Set([
  'https://novelflow-dashboard.vercel.app',
  'https://loboscantante849-coder.github.io'
]);

function getCORSOrigin(req) {
  const origin = req.headers.origin;
  
  // 精确匹配，不使用 startsWith
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    return origin;
  }
  
  // 本地开发允许 localhost
  if (origin && /^http:\/\/localhost:\d+$/.test(origin)) {
    return origin;
  }
  
  return '';
}
```

---

### P1-3: 内存中的 Rate Limiting 在 Serverless 无效

**严重程度**: 🟠 中高  
**风险**: 限流可以被轻易绕过

**位置**: 
- `api/confirm.js` (内存 Map)
- `api/ac-create.js` (内存 Map)

```javascript
// ❌ Serverless 环境下每次请求都是新实例
const confirmCounts = new Map(); // 每次请求重置！

function checkRateLimit(ip) {
  const record = confirmCounts.get(ip);
  // ...
}
```

**修复建议**: 使用 Upstash Redis 进行限流

```javascript
// api/confirm.js
const { Redis } = require('@upstash/redis');

async function checkRateLimit(ip) {
  const redis = getRedis();
  if (!redis) return { allowed: true }; // Redis 不可用时放行并记录日志
  
  const key = `rate_limit:confirm:${ip}`;
  const count = await redis.incr(key);
  
  if (count === 1) {
    await redis.expire(key, 3600); // 1小时过期
  }
  
  return { allowed: count <= 5, count };
}
```

---

### P1-4: nf_user Cookie 缺少 HttpOnly

**严重程度**: 🟠 中  
**风险**: XSS 攻击可窃取用户身份

**位置**: `api/auth/login.js`, `api/auth/callback.js`

```javascript
// ❌ 当前设置
`nf_user=${encodeURIComponent(JSON.stringify({ username: cleanUsername }))}; Path=/; Max-Age=2592000`

// 缺少 HttpOnly, Secure, SameSite
```

**修复建议**:
```javascript
res.setHeader('Set-Cookie', [
  `nf_token=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`,
  `nf_user=${encodeURIComponent(JSON.stringify({ username: cleanUsername }))}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`
]);
```

---

### P1-5: 缺少防机器注册/刷单机制

**严重程度**: 🟠 中高  
**风险**: 恶意用户可以批量注册刷佣金

**位置**: `api/auth/register.js`

```javascript
// ❌ 几乎没有任何防护
if (!username) return res.status(400).json({ error: 'Username is required' });
const cleanUsername = username.trim().substring(0, 50);
// 没有:
// - 验证码
// - IP限流
// - 设备指纹
// - 注册频率限制
```

**修复建议**:
1. 添加 reCAPTCHA 或 Turnstile
2. 使用 Redis 记录 IP 注册频率
3. 添加用户名黑名单
4. 延迟注册响应（防止暴力枚举）

```javascript
// api/auth/register.js
async function checkRegistrationLimit(ip) {
  const redis = getRedis();
  if (!redis) return true;
  
  const key = `reg_limit:${ip}`;
  const count = await redis.incr(key);
  
  if (count === 1) await redis.expire(key, 3600);
  
  if (count > 3) {
    return false; // 每小时最多注册3次
  }
  return true;
}
```

---

### P1-6: GitHub API Token 权限过大

**严重程度**: 🟠 中  
**风险**: 如果 Token 泄露，可读写整个仓库

**位置**: `api/confirm.js`, `api/submissions.js`, `api/my-stats.js`

```javascript
// 使用 repo 范围的全部权限
headers: { 'Authorization': `token ${GITHUB_TOKEN}` }
```

**问题**: GitHub PAT 权限过大，应该使用最小权限原则

**修复建议**:
1. 创建只有 `contents: read/write` 的专用 Token
2. 或者迁移到更安全的数据存储方案

---

## 三、P2 改进项

### P2-1: 部分 innerHTML 使用存在 XSS 风险

**严重程度**: 🟡 中低  
**位置**: `app-v2.html` 多处

```javascript
// ⚠️ 虽然有 escapeHtml，但在模板字符串中使用仍需谨慎
container.innerHTML = books.map(book => {
    return `<div>${escapeHtml(book.title)}</div>`; // OK
}).join('');

// ⚠️ 以下情况需要特别注意
el.innerHTML = dict[key]; // i18n 字典可能被污染
```

**修复建议**:
```javascript
// 使用 textContent 替代 innerHTML
el.textContent = dict[key];

// 或使用 DOMPurify 净化
container.innerHTML = DOMPurify.sanitize(htmlString);
```

---

### P2-2: Discord OAuth 硬编码 Client ID

**严重程度**: 🟡 低  
**位置**: `api/auth/callback.js`

```javascript
const CLIENT_ID = process.env.DISCORD_CLIENT_ID || '1504779503237333033';
```

**修复**: 移除 fallback 值，强制使用环境变量

---

### P2-3: 缺少安全响应头

**严重程度**: 🟡 低  
**位置**: 所有 API 文件

**修复建议**: 添加安全响应头

```javascript
// 在 cors.js 中添加
res.setHeader('X-Content-Type-Options', 'nosniff');
res.setHeader('X-Frame-Options', 'DENY');
res.setHeader('X-XSS-Protection', '1; mode=block');
res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
```

---

### P2-4: 错误信息可能泄露敏感信息

**严重程度**: 🟡 低  
**位置**: 多个 API

```javascript
// ❌ 可能泄露内部路径
return res.status(500).json({ error: 'Internal server error: ' + error.message });

// ✅ 应该记录到日志而不是返回给用户
console.error('Submit error:', error);
return res.status(500).json({ error: 'An error occurred. Please try again later.' });
```

---

### P2-5: 密码最小长度要求过低

**严重程度**: 🟢 低  
**位置**: `api/auth/set-password.js`

```javascript
if (!password || password.length < 4) // 只有4位
```

**修复建议**: 至少 8 位，并建议包含多种字符类型

---

## 四、安全检查清单

### 上线前必须完成 ✅

| 项目 | 状态 | 说明 |
|------|------|------|
| 删除 oidc-token.js 硬编码凭证 | ❌ 紧急 | 见 P0-1 |
| JWT_SECRET 环境变量配置 | ❌ 紧急 | 见 P0-3 |
| 敏感数据后端化 | ❌ 紧急 | 见 P0-2 |
| 密码哈希改为 bcrypt | ⚠️ 重要 | 见 P1-1 |
| CORS 配置精确匹配 | ⚠️ 重要 | 见 P1-2 |
| Rate Limiting 改用 Redis | ⚠️ 重要 | 见 P1-3 |
| nf_user Cookie 添加 HttpOnly | ⚠️ 重要 | 见 P1-4 |
| 添加防注册刷单机制 | ⚠️ 重要 | 见 P1-5 |

### 上线后建议改进 ⏳

| 项目 | 优先级 | 说明 |
|------|--------|------|
| 迁移到专业数据库 | P1 | GitHub JSON 不是持久化存储 |
| 添加 reCAPTCHA/Turnstile | P1 | 防机器人注册 |
| 安全响应头 | P2 | X-Frame-Options 等 |
| Discord Client ID 移除 fallback | P2 | 强制环境变量 |
| 敏感错误信息净化 | P2 | 防止信息泄露 |

---

## 五、快速修复脚本

以下是快速修复 P0 问题的脚本：

```javascript
// ========== 1. api/_lib/oidc-token.js ==========
// 删除硬编码凭证，强制环境变量

const fs = require('fs');
let content = fs.readFileSync('api/_lib/oidc-token.js', 'utf8');
content = content.replace(
  /const username = process\.env\.OIDC_USERNAME \|\| '[^']*';/,
  "const username = process.env.OIDC_USERNAME;"
);
content = content.replace(
  /const password = process\.env\.OIDC_PASSWORD \|\| '[^']*';/,
  "const password = process.env.OIDC_PASSWORD;"
);
// 添加验证
content = content.replace(
  'if (!username || !password) {',
  `if (!username || !password) {
    console.error('FATAL: OIDC credentials not configured. Set OIDC_USERNAME and OIDC_PASSWORD env vars.');
    throw new Error('OIDC credentials not configured');`
);
fs.writeFileSync('api/_lib/oidc-token.js', content);


// ========== 2. api/_lib/jwt.js ==========
// 移除弱 fallback

content = fs.readFileSync('api/_lib/jwt.js', 'utf8');
content = content.replace(
  /function getSecret\(\) \{[\s\S]*?return '[^']*';\s*\}\s*\}/,
  `function getSecret() {
  if (!JWT_SECRET) {
    console.error('FATAL: JWT_SECRET is not set. API cannot function.');
    throw new Error('JWT_SECRET environment variable is required');
  }
  return JWT_SECRET;
}`
);
fs.writeFileSync('api/_lib/jwt.js', content);


// ========== 3. Vercel 环境变量检查 ==========
// 确保以下环境变量已设置:
// - JWT_SECRET (至少32字符随机字符串)
// - OIDC_USERNAME
// - OIDC_PASSWORD
// - GITHUB_TOKEN (仅需 contents 权限)
// - ADMIN_KEY
// - KV_REST_API_URL
// - KV_REST_API_TOKEN
```

---

## 六、联系与后续

本报告应由开发团队在 **72小时内** 处理所有 P0 问题，并在 **一周内** 处理所有 P1 问题。

如需进一步的技术支持或详细修复方案，请联系安全团队。

---

*报告生成时间: 2026-05-26*  
*审计工具: 手动代码审查 + 静态分析*  
*覆盖范围: 前端 HTML(70KB)、API 文件(23个)、工具库(3个)*
