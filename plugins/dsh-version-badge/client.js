/**
 * dsh-version-badge — 在左下角「⚙ 设置」按钮右侧显示 DJH 四段式版本号。
 * 规范：E:\DJH\docs\版本号规范.md（沿用小 DJ 的 0.000.0.0 四段式）。
 * 唯一真相 = 下方 VERSION 常量；每次 DJH 改动后与台账同步 bump。
 * 纯 Client 半：MutationObserver 注入 <span>，pointer-events:none 不挡点击；
 * 侧栏收成图标栏（按钮宽 <100px）时自动隐藏。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-version-badge',
  factory() {
    const VERSION = 'v0.211.0.0';
    const ID = 'djh-version-badge';

    const css = document.createElement('style');
    css.textContent = [
      `#${ID}{position:absolute;right:12px;top:50%;transform:translateY(-50%);`,
      `pointer-events:none;z-index:5;user-select:none;font-size:11px;line-height:1;`,
      `font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;`,
      `font-variant-numeric:tabular-nums;opacity:.55;color:var(--dsw-alias-text-primary,#f9fafb);}`,
    ].join('');

    let btn = null;
    let badge = null;

    function ensure() {
      if (btn && !document.contains(btn)) btn = null;
      if (badge && !document.contains(badge)) badge = null;
      if (!btn) btn = document.querySelector('button[aria-label="设置"]');
      if (!btn) return;
      const host = btn.parentElement;
      if (!host) return;
      if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
      if (!badge) {
        badge = document.createElement('span');
        badge.id = ID;
        badge.dataset.djhVersion = VERSION;
        badge.textContent = VERSION;
        badge.title = 'DJH 版本号（规范见 docs/版本号规范.md）';
      }
      // 侧栏收成图标栏时按钮变窄 → 隐藏角标，防溢出
      const w = btn.getBoundingClientRect().width;
      badge.style.display = w >= 100 ? '' : 'none';
      if (badge.parentElement !== host) host.appendChild(badge);
    }

    const onResize = () => ensure();
    const mo = new MutationObserver(() => ensure());
    // 2026-11-15：DSH 0.2.2-rc.1 的 loader 要求 factory 返回 { apply }，
    // 之前"factory 直接执行副作用"的写法会让模块 resolve 成 undefined，
    // 触发 boot 报错 invalid plugin (received undefined)。
    return {
      apply(ctx) {
        document.head.appendChild(css);
        mo.observe(document.body, { childList: true, subtree: true });
        window.addEventListener('resize', onResize, { passive: true });
        ensure();
        ctx.effect(() => () => {
          window.removeEventListener('resize', onResize);
          mo.disconnect();
          badge?.remove();
          css.remove();
        }, 'version-badge: badge + stylesheet + resize');
      },
    };
  },
});
