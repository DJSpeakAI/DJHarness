# dsh-version-badge

左下角「⚙ 设置」按钮右侧显示 DJH 四段式版本号（如 `v0.032.0.0`），沿用小 DJ 的 `0.000.0.0` 规范（`E:\DJH\docs\版本号规范.md`）。

- 唯一真相：`client.js` 顶部 `VERSION` 常量；每次 DJH 改动后与 `docs/版本号规范.md` 台账同步 bump。
- 纯 Client 半插件，MutationObserver 注入，`pointer-events:none` 不挡设置按钮点击；侧栏收成图标栏时自动隐藏。
- 挂载：profile patch `- insert: version-badge`（热生效），不进 bundles。
