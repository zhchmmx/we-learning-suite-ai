# we-learning-suite-ai

基于 Cloudflare Workers 的出题 AI Worker。接收 `we-learning-suite-api` 的服务端触发，异步完成「读取 R2 材料 → 格式分诊 → OCR（仅图片）→ 多提供商故障切换生成题目 → 逐题校验 → 回写题库」。

**本 Worker 没有公网入口**（`workers_dev: false`）——只能由 we-learning-suite-api 通过 Service Binding 内部调用，客户端（以及任何外部请求）物理上无法到达；模型提供商地址、令牌、提示词全部封在服务端。

## 技术栈

- **运行时**: Cloudflare Workers（Free 套餐可运行：管线以网络 I/O 为主，几乎不耗 CPU）
- **路由**: Hono
- **异步**: Cloudflare Queues（`quiz-generation`，本 Worker 自产自销）
- **鉴权**: ticket（由 we-learning-suite-api 的 `quiz_sessions` 表验证，本 Worker 不接触 Appwrite）

## 处理链路

```
we-learning-suite-api ──Service Binding 内部直连──→ 本 Worker
  POST /api/quiz/generate { ticket, materials: [{ r2Key, mimeType }] }
  本 Worker：PATCH sessions/:ticket/status = processing（经 Service Binding 回调 API 项目验票，假票当场被拒）
            → 消息入队 → 立刻返回 202
  Queue 消费者：
    1. 复查 ticket 状态（经 Service Binding 回调）
    2. 从 R2 直读材料文件（r2Key，不走公网预签名 URL）
    3. 格式分诊：txt/md → 文本通道；jpg/png/webp → 图片通道；其他（含 PDF）→ 失败
    4. 图片 → OCR 模型转文字（每 5 张一批）；与文本合并为语料
    5. 语料超限（>60000 字符 / >15 张图）→ 失败
    6. 组提示词 → 按提供商优先级调 chat/completions（故障自动切换）
    7. 解析 JSON → 逐题校验 → 不合格丢弃 → 一道不剩则失败
    8. POST /api/quiz/questions/batch 入库（经 Service Binding 回调，API 项目自动置 quiz 和 session 为 completed）
    任何业务失败 → PATCH status=failed（经 Service Binding）；API 项目 5xx/网络错 → 交给队列重试（最多 2 次）
```

## API

### 健康检查

```
GET /health
```

无公网入口，仅本地开发（`wrangler dev`）或 Service Binding 内可达。

### 受理出题任务

```
POST /api/quiz/generate
Content-Type: application/json
```

**仅 we-learning-suite-api 经 Service Binding 调用**，凭证为 ticket（通过回调 API 项目的 PATCH 状态接口完成验证）。

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| ticket | string | 是 | quiz session 的 ticket |
| materials | array | 是 | 材料列表（1~50 项），每项 `{ r2Key: string, mimeType: string }` |
| options.count | number | 否 | 出题数量（1~50，默认 5） |

**响应 (202)：**

```json
{ "data": { "status": "processing", "ticket": "…" } }
```

**错误：** 400 参数错误 / 401 ticket 无效或过期 / 503 API 项目暂不可达。

### 图片转文字（OCR）

```
POST /api/ocr
Content-Type: application/json
```

**无公网入口，无需鉴权**：只能由 we-learning-suite-api 经 Service Binding 内部调用（客户端上传前的转码由 API 项目中转）。

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| images | array | 是 | 1~15 项，每项 `{ data: base64, mimeType: image/jpeg\|image/png\|image/webp }`，单张 ≤4MB |

**响应 (200)：**

```json
{ "data": { "text": "转录出来的文字" } }
```

**错误：** 400 参数错误 / 422 图片中无可识别文字 / 502 所有提供商都不可用。

## 题目输出格式

与 we-learning-suite-api 的 `/api/quiz/questions/batch` 契约严格一致（五种题型，入库前逐题校验，不合格丢弃）：

```json
{
  "questions": [
    {
      "type": "single_answer",
      "content": { "stem": "2+2等于?", "options": ["3", "4", "5", "6"] },
      "answer": { "correctIndex": 1 },
      "tags": ["数学"]
    },
    {
      "type": "true_false",
      "content": { "stem": "地球是平的" },
      "answer": { "correct": false }
    },
    {
      "type": "fill_blank",
      "content": { "stem": "法国的首都是___" },
      "answer": { "correct": "巴黎", "accept": ["巴黎", "Paris"] }
    }
  ]
}
```

## 多提供商配置

`AI_PROVIDERS` 是 JSON 数组（wrangler.jsonc 的 vars），数量不限，按 `priority` 升序尝试故障切换。每家一个 secret：`AI_PROVIDER_KEY_<NAME 大写>`。

```json
[
  { "name": "main", "priority": 1, "baseUrl": "https://你的提供商/v1",
    "generateModel": "Qwen3-235B-A22B", "ocrModel": "PaddleOCR-VL-1.5" },
  { "name": "deepseek", "priority": 2, "baseUrl": "https://api.deepseek.com/v1",
    "generateModel": "deepseek-chat" }
]
```

| 字段 | 说明 |
|------|------|
| name | 唯一标识，决定 secret 名（main → `AI_PROVIDER_KEY_MAIN`） |
| priority | 越小越先尝试 |
| baseUrl | OpenAI 兼容 base URL |
| generateModel | 生成题目用的模型 |
| ocrModel | 可选。OCR 模型；不填则该家在图片 OCR 阶段被跳过 |

**切换规则**：每家只试一次；网络错 / 5xx / 429 / 401 / 400 都切下一家；全部失败任务判 failed。OCR 与生成两个阶段各自独立走链。

## 配置清单

### 1. wrangler.jsonc 的 vars（非敏感）

| 变量 | 说明 |
|------|------|
| `API_WORKER` | Service Binding → we-learning-suite-api（验票 / 状态回写 / 题目入库） |
| `AI_PROVIDERS` | 提供商列表 JSON（见上） |

### 2. Secrets

```bash
npx wrangler secret put AI_PROVIDER_KEY_MAIN
# 每多一家提供商就多一个：AI_PROVIDER_KEY_<NAME>
```

### 3. 本地开发

`.dev.vars`（不要提交到版本库）：

```
AI_PROVIDERS=[{"name":"main","priority":1,"baseUrl":"https://你的提供商/v1","generateModel":"Qwen3-235B-A22B","ocrModel":"PaddleOCR-VL-1.5"}]
AI_PROVIDER_KEY_MAIN=sk-xxxx
```

本地联调时两个 Worker 同时跑：本项目 `npx wrangler dev --port 8788`，API 项目 `npx wrangler dev`（默认 8787）。两个方向都走 Service Binding（API→AI 和 AI→API），wrangler 会自动把绑定指向本地实例。

## 部署

```bash
npx wrangler deploy
```

注意：`workers_dev: false`，部署后原有的 `*.workers.dev` 公网地址会失效（这正是目的），只能通过 API 项目的 Service Binding 访问。

## 当前边界（v1）

- 支持格式：TXT、Markdown、PDF、docx / xlsx / xls / odt / ods、HTML / XML / CSV、JPEG/PNG/WebP 图片（图片单张 ≤4MB，≤15 张）；PPTX / .doc / .ppt 不支持（转换服务不覆盖）
- 客户端直传原始文档，转换发生在本 Worker 出题时：`AI.toMarkdown` 把文档转成 Markdown 再进入出题模型；图片走 OCR 通道（PaddleOCR-VL）
- 扫描件/超大 PDF：toMarkdown 无页面级 OCR，转换抛错、输出过少（或 >32MB 跳过转换）时进入 QuizGenerationDO 的 `scanning` 阶段——每轮 alarm 用 R2 Range 读一个 4MB 块续扫（免费版 CPU 预算），抽出内嵌页图（DCTDecode JPEG）转投 OCR 通道；任意大小的扫描件都支持，只是墙钟变长。少见编码（JPEG2000/CCITT）抽不到页图时会失败并给出文案
- `/api/ocr` 保留，供旧版客户端向后兼容（新版客户端直传原文件，不再调用）
- 不做：CORS（无浏览器调用方）、限流、长文档自动分段、流式输出

## 项目结构

```
src/
  index.ts               # Hono 入口（/health、/api/quiz/generate、/api/ocr、/api/usage）+ queue 消费者导出
  types.ts               # 类型定义
  config.ts              # 限制常量 + 模型链 + MIME 白名单/映射
  pipeline.ts            # 三阶段管线（规划 / 分批生成 / 上传）
  do/
    quiz-generation.ts   # 出题状态机（pending→planning→[scanning]→generating→uploading）
    ocr-processing.ts    # /api/ocr 异步 OCR 状态机
  services/
    api-client.ts        # 回调 we-learning-suite-api（PATCH 状态 / questions/batch）
    llm.ts               # chat completions 流式调用（经 AI Gateway）
    models.ts            # 模型选择（直连链 / Gateway 路由）
    ocr.ts               # 图片 OCR
    extract.ts           # R2 直读 + 格式分诊（文档走 AI.toMarkdown）
    pdf-scan.ts          # 扫描件分块扫描器（抽取内嵌页图）
    generate.ts          # 提示词 + JSON 解析 + 逐题校验
    content-scan.ts      # Waffo 内容审核（输入/输出侧）
    usage.ts             # AI Gateway 日志用量聚合
```
