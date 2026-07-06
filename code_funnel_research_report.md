# socialsource-code-funnel API 彻底研究报告（终版）

- **数据实际范围**: 2026-05-01 ~ 2026-07-05（66天）。⚠️ 2-4月无数据，从5月1日开始
- 报告生成: 2026-07-06
- Base URL: `https://ad.anystories.app/api/v1/novelflowmiddlegroundmanage/socialsource-code-funnel`

---

## 一、核心结论速览

| 指标 | 数值 |
|------|------|
| 总拉起UV(pullUv) | **31,858** |
| 总激活UV(activeUv) | 6,210 |
| 纯新增(newUv) | 637 |
| 归因激活(attActiveUv) | 634 |
| 归因新增(attNewUv) | 165 |
| 归因成功率 | 19.49% |
| d14收入 | $7,669.55 |
| **DN总收入(LTV)** | **$10,205.95** |
| ad_id总数 | 965（457个link + 508个code） |
| 有收入ad_id | 367 |

### ⚠️ 三个关键bug/限制

1. **mediaSources过滤和media_source分组全部500**：不管传什么值（link/code/邀请码、单值多值、空数组），只要带mediaSources参数或groupings里含media_source/ mediaSource，后端都返回Query Failed/Export Failed。**这是后端bug**，无法从API直接区分link和code渠道数据。
2. **ad_id的渠道来源只能通过格式推断**：24位hex(如`69b8f0ed...`) = link渠道(短链linkId)；纯数字(如`4484`) = code渠道(搜索关键词)；ad_id=-1兜底和邀请码渠道当前无数据。
3. **数据从2026-05-01开始**：传from=2026-02-01也是从5/1开始返回，2-4月无数据。

---

## 二、API完整文档

### 2.1 端点

| 端点 | 状态 | 说明 |
|------|------|------|
| POST `/list` | ✅ | 分页查询，返回JSON |
| POST `/export` | ⚠️ | xlsx导出，但groupings含media_source时500；只传dt+ad_id可用 |
| POST `/options` | ❌ | 始终返回500，不可用 |

### 2.2 Headers

```
Authorization: Bearer <OIDC Token>  # client_id=AuthClient, scope=openid profile offline_access roles
Content-Type: application/json
X-OS: web
```

### 2.3 Body 参数

| 参数 | 类型 | 必填 | 合法值 | 说明 |
|------|------|------|--------|------|
| `from` | string | ✅ | YYYY-MM-DD | 起始日期（含） |
| `to` | string | ✅ | YYYY-MM-DD | 结束日期（含） |
| `groupings` | string[] | ✅ | 仅 `"dt"`、`"ad_id"` 可用 | ⚠️ `"media_source"` 和任何含它的组合全部500；**参数用snake_case `"ad_id"`，但返回字段名是camelCase `adId`** |
| `mediaSources` | string[] | ❌ | 建议不传 | ⚠️ **bug：传任何值都500**。不传=全量 |
| `adIds` | string[] | ❌ | ad_id字符串数组 | 过滤可用，精确匹配 |
| `pageIndex` | int | ✅ | ≥1 从1开始 | 传0返回400 |
| `pageSize` | int | ✅ | 1~1000 | 传>1000返回400 |

### 2.4 返回字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `dt` | string | 分组含dt时出现，YYYY-MM-DD |
| `adId` | string | 分组含ad_id时出现；24位hex=linkId / 纯数字=搜索码 |
| `pullUv` | int | 拉起UV |
| `activeUv` | int | 激活UV |
| `newUv` | int | 纯新增UV |
| `attActiveUv` | int | 归因激活UV |
| `attNewUv` | int | 归因新增UV |
| `attSuccessRate` | float | 归因成功率(%) |
| `d0Income`~`d90Income` | float | 激活后N天累计收入(LTV cohort) |
| `dnIncome` | float | 截至数据日最终累计收入 |

### 2.5 正确调用示例

```json
// 全聚合（大盘KPI）
{"from":"2026-05-01","to":"2026-07-05","groupings":[],"pageIndex":1,"pageSize":10}

// 日趋势
{"from":"2026-05-01","to":"2026-07-05","groupings":["dt"],"pageIndex":1,"pageSize":1000}

// 推广者TOP榜
{"from":"2026-05-01","to":"2026-07-05","groupings":["ad_id"],"pageIndex":1,"pageSize":1000}
// ⚠️ 客户端必须过滤 pullUv=0 AND dnIncome=0 的死链

// 单推广者日趋势
{"from":"2026-05-01","to":"2026-07-05","groupings":["dt","ad_id"],"adIds":["<linkId>"],"pageIndex":1,"pageSize":100}
```

---

## 三、渠道来源分布（通过ad_id格式推断）

| 渠道 | 判定方式 | ad_id数 | 有收入数 | pullUv | dnIncome | 收入占比 |
|------|----------|---------|----------|--------|----------|----------|
| link(社媒归因) | 24位hex | 457 | 215 | 20,870 | $8,488.94 | 83.2% |
| code(搜索关键词) | 纯数字≥3位 | 508 | 152 | 10,988 | $1,717.01 | 16.8% |
| 邀请码 | 含'邀请码'字样 | 0 | 0 | 0 | $0.00 | 0% |
| ad_id=-1兜底 | 等于-1 | 0 | 0 | 0 | $0.00 | 0% |

→ **link渠道贡献83%收入，code渠道贡献17%**。邀请码渠道未接入。

---

## 四、TOP20 ad_id by DN收入

| # | ad_id | 渠道 | pullUv | d0 | d14 | dn |
|---|-------|------|--------|----|----|----|
| 1 | `69b8f0ed082d158b89d4f14d` | link | 453 | $119.99 | $487.77 | $669.49 |
| 2 | `69eee579e36fe00c433fc123` | link | 1,071 | $91.65 | $374.47 | $523.89 |
| 3 | `6912db8f2f6a6207884b6fe3` | link | 51 | $56.72 | $445.47 | $505.69 |
| 4 | `69af874e39070a85b2559aed` | link | 368 | $112.79 | $285.04 | $498.21 |
| 5 | `6a1cf079c46c85020a1ac33f` | link | 727 | $167.31 | $320.65 | $361.83 |
| 6 | `6a1f8a1783724a9e0204ac11` | link | 1,392 | $99.35 | $354.04 | $360.14 |
| 7 | `6a0d77a3e95c2d80649b4092` | link | 401 | $50.53 | $261.66 | $349.98 |
| 8 | `69d8949adc4437ec7f25f3d2` | link | 326 | $53.68 | $148.86 | $280.36 |
| 9 | `69ef1210d41d12d42512b164` | link | 193 | $9.43 | $203.58 | $269.17 |
| 10 | `69fea293594e2661699b3ec5` | link | 450 | $34.70 | $221.65 | $258.83 |
| 11 | `69c64e4fcf75c5562e9e1c9a` | link | 69 | $34.60 | $123.81 | $256.10 |
| 12 | `6a2010f583724a9e0204ac2c` | link | 686 | $98.19 | $218.04 | $241.61 |
| 13 | `6a12ba805b1eb5ac331b6922` | link | 494 | $16.99 | $200.30 | $239.61 |
| 14 | `69fc0188e71c030eb903203e` | link | 383 | $22.89 | $120.33 | $216.76 |
| 15 | `69d70bf78834321a4788ef9d` | link | 23 | $0.13 | $8.10 | $155.77 |
| 16 | `6a17b17cee65e026f56a7ced` | link | 759 | $65.68 | $127.68 | $153.07 |
| 17 | `4484` | code | 175 | $59.70 | $94.29 | $151.41 |
| 18 | `6a01b911356ab8725f99960d` | link | 231 | $51.19 | $93.13 | $149.52 |
| 19 | `6a0a73cf0771c1ae3226f9a1` | link | 354 | $23.55 | $106.98 | $140.43 |
| 20 | `6a1e7c8f211c5603cf016f49` | link | 3 | $0.91 | $139.72 | $139.72 |

---

## 五、code渠道TOP10（搜索关键词码）

| code | pullUv | dnIncome |
|------|--------|----------|
| 4484 | 175 | $151.41 |
| 4683 | 244 | $131.21 |
| 4639 | 299 | $130.61 |
| 4523 | 256 | $119.65 |
| 4544 | 124 | $94.40 |
| 9238 | 569 | $62.47 |
| 4483 | 33 | $50.12 |
| 4712 | 313 | $48.84 |
| 4543 | 190 | $46.68 |
| 4527 | 120 | $38.91 |

---

## 六、按月汇总

| 月份 | 天数 | pullUv | newUv | d14 | dn |
|------|------|--------|-------|-----|-----|
| 2026-05 | 31 | 14,170 | 250 | $4,534.95 | $6,971.93 |
| 2026-06 | 30 | 15,163 | 346 | $2,987.27 | $3,086.69 |
| 2026-07 | 5 | 2,525 | 41 | $147.33 | $147.33 |

→ 5月dn收入$6,972但6月只有$3,087——注意这不是业务下滑，而是**dN收入成熟期效应**：5月用户的d30/d90还在回填，6月和7月的dN还没成熟，后续跑批会持续增长。

---

## 七、d0→dn 收入递进（LTV曲线）

| 阶段 | 累计收入 | 占dn% | 边际新增 |
|------|----------|-------|----------|
| d0 | $2,344.35 | 23.0% | $2,344.35 |
| d1 | $3,286.56 | 32.2% | $942.21 |
| d3 | $4,468.91 | 43.8% | $1,182.35 |
| d7 | $6,195.65 | 60.7% | $1,726.74 |
| d14 | $7,669.55 | 75.1% | $1,473.90 |
| d30 | $9,338.75 | 91.5% | $1,669.20 |
| d90 | $10,205.95 | 100.0% | $867.20 |
| **dn** | **$10,205.95** | 100.0% | $0.00 |

- d0（当日）贡献23%收入，d7贡献60%，d14贡献75%，d30贡献91%
- d14→d30还有16%增长，d30→dn还有9%长尾
- 实践：d14适合月度结算，dn适合长期价值评估

---

## 八、与现有数据映射

- 已知linkId（submissions+link-stats+三叶草共326个）
- 已知code（0个）
- link渠道可匹配: **86/457**（19%）
- code渠道可匹配: **0/508**（0%）
- **未知ad_id: 879个**（占91%）

→ 超8成ad_id在现有submissions/link-stats里找不到归属。这些是后台直接创建、AC投建、运营手工建的链接。**需要从后台link管理接口拉完整映射表**。

---

## 九、与putreport差异

| 项 | code-funnel | putreport |
|----|-------------|-----------|
| ad_id/linkId数 | 965 | 仅登记过的推广者 |
| 总收入(DN) | $10,205.95 | 仅d14部分数据 |
| 渠道覆盖 | link+code全量 | 仅submission系统link |
| 指标口径 | 原始归因流水(全LTV) | 财务结算(d14,有退款扣减) |
| UV/新增 | ✅ 有完整漏斗 | ❌ 无UV/激活/新增 |

→ putreport是结算工具，code-funnel是运营分析工具，两者定位不同。建议并存：code-funnel驱动前台看板，putreport保留做财务打款。

---

## 十、novelflow.top改造建议

### 10.1 每日更新策略

- 该API没有增量游标，收入是累计值会随时间回填，不能只拉当天
- 推荐：每日拉`from=<today-30>, to=<today>, groupings=['dt','ad_id']`（30天滚动），本地以`(dt,adId)`为主键upsert
- 30天前视为固化（d30≈dn），不重刷
- 首次初始化：拉`from=2026-05-01, to=today, groupings=['dt','ad_id']`全量入库

### 10.2 字段映射

| 看板指标 | API字段 | 备注 |
||---------|---------|------|
| 大盘KPI | groupings=[]一次拉完 | pullUv/activeUv/newUv/attActiveUv/attNewUv/dnIncome |
| 日趋势图 | groupings=['dt'] | 按dt展示折线 |
| 推广者榜单 | groupings=['ad_id'] | **必须在客户端过滤pullUv=0 AND dnIncome=0** |
| 单链接详情 | groupings=['dt','ad_id']+adIds=['xxx'] | 单日趋势 |
| 渠道分布 | 24hex→link, 纯数字→code | 通过adId格式推断，不要依赖mediaSources参数 |
| 导出Excel | /export + groupings=['dt','ad_id'] | 中文表头xlsx |

### 10.3 注意事项

1. **不传mediaSources参数**（bug参数）
2. **groupings参数用snake_case（ad_id），返回字段是camelCase（adId）**
3. **pageSize用1000**（最大值）
4. **数据起点是2026-05-01**，不是2月
5. **客户端必须过滤死链**（pullUv=0且dnIncome=0的ad_id是历史占位行）
6. **adId格式分类**：`re.fullmatch(r'[0-9a-fA-F]{24}', id)` → link；`re.fullmatch(r'\d{3,}', id)` → code
7. **dN收入有成熟期**：近7-14天的dN会持续增长，展示时可标注"数据成熟中"
8. **Token使用AuthClient获取**，scope=openid profile offline_access roles即可
