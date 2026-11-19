# @local/dsh-sfx（音效）

抄 little DJ 的「设置 → 音效」，落到 DSH 里两个场景：

| 场景 | 触发 | 默认音 |
| --- | --- | --- |
| 大管家回复结束 | 任一非子代理会话 `running: true → false` | 叮（ding） |
| 大管家向你提问 | `ask_user_question` 卡片出现（`pendingInteraction.kind === 'question'`） | 和弦（chord） |

设置位置：**左下角 ⚙ 设置 → 音效**（`settings.section`，order 5，排在「通用设置」后面）。

## 锁屏 / 后台保活（2026-11-15 v0.047 加，与小 DJ task193/262/323 同源）

手机息屏后网页默认被系统挂起（状态收不到、AudioContext 被挂起、声音出不来）。四层防线：

1. **近无声循环音轨**（220Hz 正弦 2% 振幅、元素音量 0.02）+ **MediaSession 元数据**（artwork/album/播放器按钮，锁屏显示「DSH 待命中」媒体卡片）→ 页面不被当普通后台页冻结；
2. **完成音 hidden 时走预渲染 WAV 的 `<audio>`**（OfflineAudioContext 提前渲染 6 音色）——媒体元素通道与保活音轨同类，息屏可出声；播放被拒再入 60s 待播队列；
3. **Service Worker 系统通知兜底**（`dist/sfx-sw.js`，安卓/鸿蒙只有 SW 能发系统通知）：出声被拦/保活没起来时发一条带提示音+振动的系统通知，点通知回到 DSH；
4. **暂停自愈 + 20s 看门狗**：系统按住保活音轨时指数退避（1s→16s×5）拉回；看门狗兜 pause 事件丢失。

设置页新增「锁屏 / 后台」区：保活开关（`dsh.sfx.keepalive`，默认开）+ 「开启系统通知」按钮（浏览器授权）。
网关 `djh-gateway.js` 的 `PUBLIC_STATIC_RE` 白名单加了 `sfx-sw.js` 免票直通（外网手机注册 SW 不被登录页挡）。

诚实边界：系统省电杀浏览器、最近任务划掉、深度省电断网 → 收不到，解锁回来看页面 60s 内补响。

## 声音怎么来的

不是音频文件，是 little DJ 那套 **WebAudio 实时合成**：叮 / 铃 / 水滴 / 滴 / 和弦 / 叩 + 「无」。
`note()`、6 个音色的频率/时长/峰值/滑音、主增益 `(vol/100) * 2.2` 和压缩器参数全部照抄 little DJ，听感一致。

## 偏好（localStorage，按设备走，和 little DJ 一样）

| 键 | 含义 | 默认 |
| --- | --- | --- |
| `dsh.sfx.vol` | 音量 0–100 | 80 |
| `dsh.sfx.done` | 完成音音色 | `ding` |
| `dsh.sfx.ask` | 提问音音色 | `chord` |

「无」= 该场景静音；音量 0 = 全静音（和 little DJ 一致，不会出声）。

## 触发口为什么这么写

不自己轮询、不扫 DOM：DSH 前端本来就把「每个会话是否在跑、是否在等你回答」聚合成
`ctx.uiSession.sessionStatus`（侧栏转圈/待回答标记读的就是它）。插件用槽位标准 props
`useSessionStatus` / `useSessions` 读同一份事实，只处理**跳变**：

- 首帧只建基线，不给历史状态补响；
- 完成音延迟 600ms 再响，期间若该会话又在跑 / 有提问挂着 → 这一声不响（避免和提问音双响）；
- `byId[id].origin === 'subagent'` 的子代理/子会话不响（干活过程不吵人）。

## 浏览器的规矩（诚实边界）

- 网页音频要先点一下页面才被允许发声（自动播放策略）；插件在第一次 pointerdown/keydown 时解锁，之前在挂起队列里等，解锁后 60s 内补播。
- 只在**开着这个页面**的浏览器里响；关掉页面/换设备就没有。
- 页面在后台标签页时，系统可能压低音量或暂停音频，取决于浏览器设置。

## 验证（留在 tmp，可重放）

```
node E:\DJH\tmp\sfx-verify.mjs  --port 9640   # 设置页 + 音色/音量/试听（10 项）
node E:\DJH\tmp\sfx-e2e2.mjs    --port 9640   # 新会话真跑一轮 → 完成音
node E:\DJH\tmp\sfx-console.mjs --port 9640   # 抓 console 异常（看监视器是否崩）
```

自检口：页面里 `window.__dshSfx.state()` / `play(id)` / `testDone()` / `testAsk()`。

## 回滚

- 停用：插件页关掉「音效」，或 `plugin_manager set_plugin @local/dsh-sfx enabled=false`。
- 彻底删：`plugin_manager remove_bundle @local/dsh-sfx`。
- 只关某一类：设置→音效 里把那一组选「无」。
