# @local/dsh-row-fork

左栏会话行 hover 时那一排小按钮里，加一颗「分叉」（⤙ 两个点分两支的图标）。

```
［⋯ 更多］［⑂ 分叉］［归档］［置顶］
```

- 点一下＝官方「分叉会话」菜单项（Ctrl+S 同一动作）：立刻分出继承完整历史的新会话并打开它。
- 分叉按钮插在官方 `sidebar.workspaces.session.row.action` 槽位、`order: 50`
  （归档 100 / 置顶 200 之前），所以它紧贴「⋯ 更多」右边，更多随之往左让一格。
- 失败会弹一条小提示：这轮还没答完 / 会话要先打开一次 / 分叉失败。
- 会话音效、会话列表数据都不碰，纯前端按钮。

## 挂载

profile `package.json` 加 `"@local/dsh-row-fork": "link:../../workspaces/default-workspace/plugins/dsh-row-fork"`,
`home/profiles/web/node_modules/@local/` 建 Junction，profile `cordis.patch.yml` 里 `- insert: - id: row-fork`。

## 关闭

`E:\DJH\home\profiles\web\cordis.patch.yml` 里把 `- id: row-fork` 那条注释掉 → 重启 DSH。
