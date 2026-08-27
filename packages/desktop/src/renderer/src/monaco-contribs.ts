/**
 * monaco 服务补注册（0.5.3）：聊天代码块（markstream-react → stream-monaco）创建的
 * standalone editor 在实例化 contribution 时抛 "depends on UNKNOWN service"
 * （ICodeLensCache / IInlayHintsCache / ISuggestMemories / actionWidgetService /
 * treeViewsDndService，一 天 1000+ 条 error 日志）。这些服务的 registerSingleton
 * 在各自模块顶层执行，但懒加载链只拉进了 controller 注册、没拉服务注册模块。
 *
 * 这里把缺失的注册模块钉进主 chunk：启动时同步执行 registerSingleton，编辑器
 * 实例化时服务齐备。只读代码块用不上 codeLens/inlayHints 等功能，此修复主要为
 * 消除错误日志洪水（避免淹没真实 renderer 错误）。monaco 升级后若出现新的
 * UNKNOWN service 报错，按同样方式在此补注册模块。
 */
import "monaco-editor/esm/vs/editor/contrib/codelens/browser/codeLensCache.js";
import "monaco-editor/esm/vs/editor/contrib/inlayHints/browser/inlayHintsController.js";
import "monaco-editor/esm/vs/editor/contrib/suggest/browser/suggestMemory.js";
import "monaco-editor/esm/vs/platform/actionWidget/browser/actionWidget.js";
import "monaco-editor/esm/vs/editor/common/services/treeViewsDndService.js";
