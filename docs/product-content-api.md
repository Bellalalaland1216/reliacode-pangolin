# 产品内容与溯源 API

产品内容属于产品的 `brand_id`。非平台账号访问其他品牌对象统一返回 `404`；所有管理写操作记录 `operation_logs`。Agent 写接口还必须携带 `Authorization: Bearer …` 和 8–128 位 `Idempotency-Key`。

## 后台接口

- `GET /api/products/:id/content`：产品、图片、模板、批次及营销草稿总览。
- `POST /api/products/:id/upload-images`：上传字段名 `files`，仅 JPEG/PNG/WebP，最多 6 个、单个不超过 5 MiB，并校验文件签名和真实解码结果。输入最多 4000 万像素；服务端根据 EXIF 方向归正、移除 EXIF/GPS/ICC 元数据、等比限制在 2400×2400 内并统一输出质量 82 的 WebP。返回的本地 URL 需再绑定。
- `PUT /api/products/:id/media`：替换排序后的图片数组，`media` 元素为 `{url, alt_text, is_cover}`；最多一张封面，无封面时首张自动成为封面。
- `PUT /api/products/:id/trace-template`：替换/停用模板，`stages` 元素为 `{stage_key,title,public_label,enabled}`。
- `POST /api/products/:id/batches`：创建 `{batch_no,production_date}`，同产品批次号唯一。
- `GET /api/batches/:batchId/trace`：读取批次及完整履历。
- `POST /api/batches/:batchId/trace`：追加履历；通过 `revision_of` 创建修订，不覆盖历史。
- `PUT /api/batches/:batchId/publish`：发布批次和其当前履历，需要批次 `version`。
- `PUT /api/products/:id/marketing`：保存产品广告并进入 `pending`；图片必须是本地上传，外链只允许安全 HTTPS。
- `PUT /api/products/:id/marketing/review`：品牌管理员审核为 `approved` 或 `rejected`。

产品 `PUT /api/products/:id` 支持 `description` 和可选 `version`；版本冲突返回 `409 VERSION_CONFLICT`。新建产品返回初始版本。

产品绑定生码（浏览器及 Agent 的 items/boxes 命令）必须提交非空 `batch_no`，且该批次必须已存在于同品牌、同产品的 `product_batches`；缺失分别返回 `400 BATCH_REQUIRED` 或 `404 BATCH_NOT_FOUND`。不带 `product_id` 的空白码保持兼容，可后续在受控装箱流程绑定。

## 消费者接口

`GET /api/verify/:code` 的兼容字段保持不变，并增加消费者页面直接使用的 `product_media`、`trace_timeline`、`promotion`；同时提供结构化汇总 `product_content`：

- `media`：该产品排序后的图片和封面。
- `batch`、`trace`：只有码所绑定批次已发布时返回，且只包含已发布履历。
- `marketing`：只有已启用、审核通过且处于有效期的产品广告才返回。

公开结果不返回用户、内部位置、审核人或内部单据。

## Agent 命令

能力发现版本为 1.2。以下命令复用相同租户与角色规则：

- `PUT /api/agent/products/:id/media`
- `PUT /api/agent/products/:id/trace-template`
- `POST /api/agent/products/:id/batches`
- `POST /api/agent/batches/:batchId/trace`
- `PUT /api/agent/products/:id/marketing`

Agent 不具备营销审核、物理删除素材或覆盖历史履历的能力。
