# 北斗分析平台API调用格式

## 认证方式
- Header: `Authorization: Bearer <JWT_TOKEN>`
- Header: `x-project-id: 1006`
- Token获取: `document.querySelector("#app").__vue_app__.config.globalProperties.$pinia._s.get("pure-user").accessToken`
- 当前Token(2026-05-09刷新): `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VyaWQiOiI3NjUxODAyMjIzMTI3NzMiLCJ1c2VybmFtZSI6IuW-kOaVrOa2myIsIm9yZ2FuaXphdGlvbmlkIjoiOTcyMzg3MDExIiwibmJmIjoxNzc4MjkxNDQ0LCJleHAiOjE3ODM0NzU0NDR9.M1NyWUfJjcoiWIzwq9hwBa1LVyZg4nw051PFUc00lKg`

## 核心查询API
`POST /api/v1/event-analysis-report/query-report`

### 请求体格式

#### filter格式（关键！必须用formatFilters转换后的格式）

前端存储格式（hash/表单）:
```json
{
  "relation": "and",
  "extension": {
    "mixConditionAndFilter": [
      {"field": "e.product_line", "function": "EQUAL", "paramDatas": ["NovelFlow"]},
      {"relation": "and", "extension": {"mixConditionAndFilter": [...]}}
    ]
  }
}
```

API请求格式（formatFilters转换后）:
```json
{
  "relation": "and",
  "conditions": [
    {"field": "e.product_line", "function": "EQUAL", "paramDatas": ["NovelFlow"]}
  ],
  "filters": [
    {"relation": "and", "conditions": [...], "filters": []}
  ]
}
```

**关键差异**: `extension.mixConditionAndFilter` → `conditions` + `filters`
- 普通条件 → `conditions`
- 嵌套关系 → `filters` (递归)

#### byFieldParams格式

```json
[{
  "fieldName": "e.self_campaign_name",
  "propNmCh": "广告系列名称（自建）",
  "propNm": "self_campaign_name",
  "field": "e.self_campaign_name",
  "fieldLabel": "广告系列名称（自建）",
  "groupByDataType": "STRING",
  "dataTypeValue": "STRING",
  "reportPropType": "EventProp",
  "canAccessData": true,
  "id": 694111718764677,
  "proType": "2",
  "sqlExpression": "",
  "isVisible": "1"
}]
```

这些字段来自 `query-single-event-props` API返回的属性对象。

#### measures格式（formatMeasures转换后）

```json
[{
  "event_name": "app_launch",
  "event_id": 225,
  "metadata": {"color": "success", "origiName": "总link日拉活"},
  "field": "BodyCount",
  "aggregator": "BodyCount",
  "name": "总link日拉活",
  "measureAliasName": "measure_6",
  "bucketId": 1,
  "fieldLabel": "实体数"
}]
```

注意：metadata中去掉了`currentEvent`和`hasEdit`字段。

#### filter位置

filter在请求体的顶层，不在measure内部！

```json
{
  "approx": true,
  "sampling_factor": 1,
  "projectId": 1006,
  "timeZones": ["Etc/Greenwich", "Etc/Greenwich"],
  "analysisTypeName": "ccid",
  "byFieldParams": [...],
  "arith_rollup": true,
  "maxRowNumber": 2000,
  "maxGroupNumber": 500,
  "measures": [...],
  "filter": {...},  // 顶层filter
  "dateRange": ["2026-05-01 00:00", "2026-05-08 23:59"],
  "unit": "DAY"
}
```

### 异步查询模式
- 首次POST返回 `is_done: false, task_id: xxx`
- 重复POST相同请求体，返回缓存结果 `is_done: true, is_from_cache: true`

### 响应格式
```json
{
  "items": [{
    "detailResult": {
      "byFields": ["广告系列名称（自建）"],
      "series": ["26-05-08", "26-05-07", ...],
      "rows": [{
        "values": [[1043], [1468], ...],  // 每天的值，按series顺序
        "byValues": ["NovelFlow_SocialMedia_Facebook-grounp_Facebook_xujt"],
        "sumValues": [11201]
      }]
    }
  }],
  "is_done": true,
  "is_from_cache": true
}
```

## 其他有用API
- `POST /event-analysis-report-query/query-single-event-props` - 获取事件属性列表（含fieldName, propNm等分组所需字段）
- `POST /event-analysis-report/query-single-prop-values` - 获取属性可选值
- `POST /report-data-detail/query-report-data-detail-report` - 明细数据查询

## formatFilters函数（Python等价实现）
```python
def format_filters(f, deep=False):
    if not f or not f.get('extension') or not f.get('extension', {}).get('mixConditionAndFilter'):
        return None
    result = {'relation': f['relation'], 'conditions': [], 'filters': []}
    for item in f['extension']['mixConditionAndFilter']:
        if 'relation' in item:
            sub = format_filters(item, deep)
            if sub:
                result['filters'].append(sub)
        else:
            result['conditions'].append(item)
    if not result['conditions'] and not result['filters']:
        return None
    return result
```
