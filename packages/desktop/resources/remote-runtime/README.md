发行时由 `scripts/prepare-remote-runtime-manifest.mjs` 从两份已验包的 Linux 产物生成 manifest.json。
清单随桌面打包；不从远端或 latest 接口获取，不手写占位摘要。构建和验包流程见 docs/build-release.md。
