# plugin-settings 示例

演示 `perchoUi: 2` 的声明式设置页、shadow 隔离与自带样式，以及设置值的实时读取。字段与规则说明见
[UI 插件设置页与隔离](../../ui-plugin-settings.md)。

本目录不随包分发。示例代码若放在 `resources/ui-plugins/examples/` 下，会被 seeder 拷进每个用户的
`<userData>/ui-plugins/_examples/`，等于预装一份示例；原版 Percho 的默认状态不改动，装不装由开发者决定。

在本机试用时复制进 dev 实例的插件目录，再在「设置 → 外观 → UI 插件」启用：

```bash
cp -r docs/examples/plugin-settings /tmp/percho-pv-dev/ui-plugins/plugin-settings
```
