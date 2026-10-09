/**
 * 历史图片资源契约的集中参数（spec「资源契约」一节）。
 *
 * 为什么集中：这些数字同时约束「活跃资源」「队列」「缓存」「超时」四件事，
 * 散在各模块里会互相打架（比如缓存上限放大会让 48 slots 的意义变虚）。
 * 改这里之前先看 spec 与频道 IMPL-NOTES 的阶段 0 实测数据。
 */

/** 缩略图最长边（等比不放大；列表不随 DPR 升级，大截图细节交给原图预览） */
export const THUMBNAIL_MAX_SIDE = 384;

/** 活跃缩略图 slot 上限（含 loading 与 ready）；可见优先、缓冲次之 */
export const ACTIVE_SLOT_LIMIT = 48;

/** 等待队列上限（只引用既有 ImageInput，不预先复制字节） */
export const WAITING_LIMIT = 48;

/** 非活跃缩略图 Blob 的 LRU：条数与编码字节数**同时**约束 */
export const CACHE_ENTRY_LIMIT = 128;
export const CACHE_BYTE_LIMIT = 16 * 1024 * 1024;

/** 单任务超时（超时 → 重置 worker；错误占位可重试，绝不回退成原图 src） */
export const TASK_TIMEOUT_MS = 10_000;

/** 加载区触发：root 显式为 MessageList 滚动容器，rootMargin 上下各 400px */
export const VIEWPORT_ROOT_MARGIN_PX = 400;
