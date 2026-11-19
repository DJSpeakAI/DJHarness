/**
 * Quiet two kinds of noise around the conversation UI (client half only, no
 * host half). This plugin does two things:
 *
 *   1. Injects CSS that hides low-value chrome:
 *      - Sidebar top bar: the product logo ("deepseek HARNESS" brand button) is
 *        decoration once the app is open, so it goes away; the "新会话" button
 *        is lifted into that strip (margin 0 40px 10px 4px) and the sidebar
 *        collapse toggle keeps the top-right corner by floating the logoRow
 *        out of flow. Guarded by `:has(brand)` — pointer/animation-proof.
 *      - New-task hero screen: the little DeepSeek fish logo beside the
 *        greeting headline.
 *      - New-task agent-preset picker: the `conversation.hero.agentPreset`
 *        outlet. With a single all-in-one preset there is nothing to switch
 *        between, so the outlet leaves the layout while the preset itself
 *        stays active.
 *      - New-task workspace row above the composer ("默认工作区" + folder +
 *        chevron). Once the preset picker is gone both outlets in that row
 *        are empty, so the row is decoration only; workspaces are still
 *        switched from the sidebar.
 *      - Session header read-only mode tag, and sidebar row timestamps.
 *      - Composer model trigger: the reasoning-effort text ("DeepSeek-V4.1-Flash
 *        High"). Every DeepSeek model defaults to High and the effort row in
 *        the menu is hidden below, so the suffix is noise on phone widths.
 *   2. Keeps every message action row visible (copy / branch / turn usage pill /\n *      TTS speak) instead of hover-only: the stock chat plugin hides _actions at\n *      opacity:0 on finished-but-not-last turns, and the owner wants them always\n *      on (2026-11-19).\n *   3. Auto-drills the composer model menu: a MutationObserver on <body>
 *      clicks the model cell the moment the menu's root pane shows up, so
 *      the menu opens straight into the model list (see drillToModelList).
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-hide-mode-chip',
  factory() {
    const CSS = [
      /* Sidebar top strip: hide the brand logo and lift the "新会话" button into
         its place. STATE GUARD: the sidebar root toggles a `_quietBars` class on
         every pointer enter/leave (2s linger), so NEVER key rules on that class
         or on `:not(_collapsed)` (transient during the 150ms collapse settle).
         `:has(brand button)` is the stable "expanded" predicate: the brand only
         renders while wide, present through the collapse animation, absent on
         the icon rail. Pointer-independent, animation-proof. */
      'button[class*="_brand"]{display:none!important}',
      'span[class*="_brandMark"],span[class*="_brandName"],span[class*="_brandIdentity"]{display:none!important}',
      'div[class*="_sidebarCol"] div[class*="_root"]:has(>div[class*="_logoRow"]>button[class*="_brand"]){position:relative!important}',
      'div[class*="_root"]:has(>div[class*="_logoRow"]>button[class*="_brand"])>div[class*="_logoRow"]{position:absolute!important;top:6px;right:8px;left:auto!important;width:auto!important;height:28px!important;min-height:0!important;padding:0!important;margin:0!important;gap:0!important;display:flex!important;align-items:center!important;justify-content:flex-end!important}',
      'div[class*="_root"]:has(>div[class*="_logoRow"]>button[class*="_brand"])>button[class*="_newSession"]{margin:0 40px 10px 4px!important}',
      /* New-task hero screen: the little DeepSeek fish logo beside the greeting
         headline ("探索未至之境…" strip). It only shows on that screen, which
         made it look like the logo "flickers" between screens. Hide the fish
         svg and its link hitbox (unconditional, structure-independent); the
         headline text itself stays. */
      'svg[class*="_fish"]{display:none!important}',
      'span[class*="_fishHitbox"]{display:none!important}',
      /* Sidebar nav rows: drop the "更多" row (decorative overflow menu).
         Order target: AI 新闻 → 自动化任务 → 插件. DOM button order is
         插件(1), AI 新闻(2), 自动化任务(3) (registration orders differ), so
         push 插件 to the end (order:2) and 自动化任务 to the middle (order:1);
         AI 新闻 keeps default 0 and stays on top. */
      'nav[class*="_panelList"]>[class*="_moreAnchor"]{display:none!important}',
      'nav[class*="_panelList"]>button:nth-of-type(1){order:2!important}',
      'nav[class*="_panelList"]>button:nth-of-type(3){order:1!important}',
      /* New-task screen: the mode picker itself. */
      '[data-slot="conversation.hero.agentPreset"]{display:none!important}',
      /* Session header: the read-only mode tag beside the title. */
      '[data-slot="conversation.session.header.actions"]>span[class*="_label"][title]{display:none!important}',
      /* Sidebar session rows: the relative last-active time (e.g. "2分钟"). */
      /* The ctx-percentage pill in the trailing slot stays visible.          */
      '[data-row-key^="session:"][class*="_sessionRow"] [class*="_timestamp"]{display:none!important}',
      /* New-task screen: the whole row above the composer that holds the
         workspace picker ("默认工作区" + folder + chevron) and the hero option
         outlets. Both outlets are empty once the mode picker above is gone, so
         the row is pure decoration. Workspace switching stays available in the
         sidebar (workspace row -> "在此工作区中新建会话"). The class is
         `<hash>_heroWorkspaceRow`, so match the stable suffix only. */
      '[class*="_heroWorkspaceRow"]{display:none!important}',
      /* Composer model trigger: the effort suffix span ("High"). The trigger
         renders `triggerLabel` + `triggerEffort` as separate spans; hide the
         effort one so the seat reads just "DeepSeek-V4.1-Flash". The title and
         aria-label keep the full selection for hover/screen readers. */
      '[class*="_triggerEffort"]{display:none!important}',
      /* Composer model menu: the second root cell is the reasoning-effort
         picker ("推理等级 High"). Every DeepSeek model defaults to High and the
         owner never switches it, so the row is dead weight. Both root cells are
         direct children of the menu surface; the model cell is the first one. */
      'div[data-menu-material]>button[class*="_cell"]:nth-of-type(2){display:none!important}',
      /* Composer model menu: the "DeepSeek 账号" group lists exactly the same two
         models as the "DeepSeek" (API key) group, so it is a duplicate row band.
         Same account, same price, only the credential differs. Hide the whole
         group section (heading + options); the provider itself stays registered,
         so sessions already bound to it keep working. */
      'section[data-menu-group]:has([data-provider-id="deepseek-account"]){display:none!important}',
      /* Chat "回到底部" floating button: stock layout right-aligns it inside the
         chat frame (slot uses justify-content:flex-end + padding-right). Little
         DJ centers the same button, and the owner wants parity: center it on
         the chat frame. The frame's scroll padding is symmetric, so frame
         center == content-column center at every width. */
      '[class*="_toBottomSlot"]{justify-content:center!important;padding-right:0!important;padding-left:0!important}',

      /* ---- Message action row: always visible, never hover-only (v0.19x) ----
         Stock behavior (dsh-client-ui-chat): the assistant turn tail carries
         `data-actions-reveal="hover"` for every finished-but-not-last turn and
         the row's `_actions` (🔊 播报 / 复制 / 分叉 / "N tok · ≈￥" 用量) is
         `opacity:0` until the turn is hovered. Owner asked for it to stay
         visible ("为什么不能一直显示呢"). Two stock rules hide it:
           1. `[data-actions-reveal=hover] .<hash>_actions{opacity:0}`;
           2. user rows that have a LATER user row after them
              (`[data-chat-flow-kind=user]:has(~ [data-chat-flow-kind=user])`).
         Override both (hover-media only, mirroring stock so phones are
         untouched). Fragment matching on `_actions` instead of the build-time
         hash class keeps this upgrade-proof. */
      '@media (hover:hover){[data-actions-reveal="hover"] div[class*="_actions"],:is([data-chat-flow-kind="user"],[data-chat-flow-kind="steering"]):has(~:is([data-chat-flow-kind="user"],[data-chat-flow-kind="steering"])) div[class*="_actions"]{opacity:1!important;transition:none!important}}',

      /* ---- "已编辑 N 个文件" card: collapse the whole card from its top-left ----
         The stock card only has a bottom "全部 N 个文件" toggle (and only when it
         lists >4 files). The owner wants the card itself foldable, with the
         control at the top-left corner (the file tile sits there). We inject a
         chevron button into the card (see syncChangedFileCards) and drive it by
         data attributes only, so React never learns about it:
           - [data-djh-cf="1"] = collapsed -> hide the file list + bottom toggle,
             rotate the chevron to point right;
           - [data-djh-cf-on]   = our button is mounted -> reserve left padding in
             the header so the chevron does not sit on top of the tile.
         Match the stable `data-changed-files` attribute, never the hashed class. */
      '[data-changed-files]{position:relative!important}',
      /* v0.068: single-file card wraps the header inside a HoverCard, so it is
         NOT a direct child -> also match it by its stable `_header` class
         fragment (the chevron was overlapping the tile icon there). */
      '[data-changed-files][data-djh-cf-on]>button:first-child{padding-left:38px!important}',
      '[data-changed-files][data-djh-cf-on] button[class*="_header"]{padding-left:38px!important}',
      '[data-djh-cf-btn]{position:absolute;left:6px;top:30px;transform:translateY(-50%);z-index:3;width:26px;height:26px;display:flex;align-items:center;justify-content:center;padding:0;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background-color .12s,color .12s}',
      '@media (hover:hover){[data-djh-cf-btn]:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}}',
      '[data-djh-cf-btn] svg{display:block;transition:transform .15s ease}',
      '[data-changed-files][data-djh-cf="1"]>ul{display:none!important}',
      '[data-changed-files][data-djh-cf="1"]>button[aria-expanded]:not([data-djh-cf-btn]){display:none!important}',
      '[data-changed-files][data-djh-cf="1"] [data-djh-cf-btn] svg{transform:rotate(-90deg)}',
      /* Settings dialog header: the "打开配置文件" button (official
         SettingsDocumentAction). The owner never opens the config file from
         here, so the button goes away. Matched by its zh label in
         hideOpenDocButton (text-based, upgrade-proof — no hashed class,
         no node_modules patch); this rule only does the actual hiding. */
      '[data-djh-quiet="opendoc"]{display:none!important}',

      /* ---- Markdown tables: wrap within the message column (v0.209) ----
         Stock markdown tables size to content, so a wide table (10-column
         reports) blows past the chat column and the owner has to hunt for a
         horizontal scrollbar. Default mode = fixed layout + wrap: the table
         always fits the column, cells break long text. The little top-right
         button (see syncTables) flips the table to nowrap mode: auto layout +
         one line per cell + the wrapper scrolls horizontally. Preference is
         remembered per-browser in localStorage. Scoped to chat rows via the
         stable [data-chat-flow-kind] attribute — settings dialogs etc. are
         untouched. */
      '[data-chat-flow-kind] table{table-layout:fixed!important;width:100%!important;max-width:100%!important;border-collapse:collapse}',
      '[data-chat-flow-kind] th,[data-chat-flow-kind] td{overflow-wrap:anywhere!important;word-break:break-word!important;white-space:normal!important}',
      '[data-djh-tbl-wrap]{position:relative!important;overflow-x:auto!important}',
      '[data-djh-tbl-wrap][data-djh-tbl="nowrap"] table{table-layout:auto!important;width:auto!important;min-width:100%!important}',
      '[data-djh-tbl-wrap][data-djh-tbl="nowrap"] th,[data-djh-tbl-wrap][data-djh-tbl="nowrap"] td{white-space:nowrap!important;overflow-wrap:normal!important;word-break:normal!important}',
      '[data-djh-tbl-btn]{position:absolute;top:2px;right:2px;z-index:5;width:22px;height:22px;display:flex;align-items:center;justify-content:center;padding:0;border:0;border-radius:6px;background:var(--dsw-alias-bg-overlay,rgba(40,40,44,.9));color:var(--dsw-alias-label-secondary);cursor:pointer;opacity:0;transition:opacity .12s,background-color .12s,color .12s}',
      '[data-djh-tbl-wrap]:hover [data-djh-tbl-btn],[data-djh-tbl-btn][data-djh-tbl-on="1"]{opacity:1}',
      '@media (hover:hover){[data-djh-tbl-btn]:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}}',
      '[data-djh-tbl-btn] svg{display:block}',
      /* In nowrap mode the button would scroll away with the content, so pin
         it to the wrapper's visible corner instead: sticky keeps it at the
         right edge of the scrollport while the table slides underneath. */
      '[data-djh-tbl="nowrap"] [data-djh-tbl-btn]{position:sticky!important;float:right;top:2px;right:2px;margin-left:-24px}',
    ].join('');

    /**
     * The composer model menu opens on a root pane with two cells (模型 / 推理等级).
     * With the effort row gone that pane is a pointless extra click, so drill
     * straight into the model list the moment the root pane shows up.
     *
     * Structural guard instead of a hashed class name or localized label: only
     * the model menu renders exactly two `role="menuitem"` cells as direct
     * children of its menu surface. Other menus that style rows as `*_cell`
     * have a different shape, so they are left alone.
     */
    const drillToModelList = () => {
      const cells = Array.from(
        document.querySelectorAll('div[data-menu-material]>button[class*="_cell"][role="menuitem"]'),
      );
      if (cells.length !== 2 || cells[0].parentElement !== cells[1].parentElement) return;
      const modelCell = cells[0];
      if (modelCell.dataset.dshAutoDrill === '1') return;
      modelCell.dataset.dshAutoDrill = '1';
      modelCell.click();
    };

    const CF_CHEVRON =
      '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6.2 8 10.2 12 6.2"/></svg>';

    /* v0.209: table wrap toggle. Default "wrap" = table hugs the chat column;
       "nowrap" = one line per cell, wrapper scrolls horizontally. The mode is
       remembered browser-wide so every table on the page follows it. */
    const TBL_MODE_KEY = 'djh-tbl-mode';
    const tblMode = () => (localStorage.getItem(TBL_MODE_KEY) === 'nowrap' ? 'nowrap' : 'wrap');
    const TBL_ICON_WRAP =
      '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13 3v5.5a2 2 0 0 1-2 2H4"/><path d="M7 7.5 4 10.5l3 3"/></svg>';
    const TBL_ICON_NOWRAP =
      '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 5h11M2.5 8.5h11M2.5 12h7"/></svg>';

    const syncTables = () => {
      const mode = tblMode();
      for (const table of document.querySelectorAll('[data-chat-flow-kind] table')) {
        const wrap = table.parentElement;
        if (!wrap || !wrap.tagName || wrap.dataset.djhTblWrap !== undefined) continue;
        wrap.dataset.djhTblWrap = '1';
        if (mode === 'nowrap') wrap.dataset.djhTbl = 'nowrap';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.setAttribute('data-djh-tbl-btn', '');
        btn.title = '表格：换行 ⇄ 横向滚动';
        btn.innerHTML = mode === 'nowrap' ? TBL_ICON_NOWRAP : TBL_ICON_WRAP;
        btn.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          const host = btn.closest('[data-djh-tbl-wrap]');
          if (!host) return;
          const next = host.getAttribute('data-djh-tbl') === 'nowrap' ? 'wrap' : 'nowrap';
          if (next === 'nowrap') host.setAttribute('data-djh-tbl', 'nowrap');
          else host.removeAttribute('data-djh-tbl');
          localStorage.setItem(TBL_MODE_KEY, next);
          /* Page-wide: put every mounted wrapper in the new mode so the whole
             document follows the preference, and update every button icon. */
          for (const w of document.querySelectorAll('[data-djh-tbl-wrap]')) {
            if (next === 'nowrap') w.setAttribute('data-djh-tbl', 'nowrap');
            else w.removeAttribute('data-djh-tbl');
          }
          for (const b of document.querySelectorAll('[data-djh-tbl-btn]')) {
            b.innerHTML = next === 'nowrap' ? TBL_ICON_NOWRAP : TBL_ICON_WRAP;
          }
        });
        /* Insert just after the table so the wrapper (a plain markdown <p>-like
           container) keeps the table as its only flow child and the sticky
           button rides the scrollport in nowrap mode. */
        table.insertAdjacentElement('afterend', btn);
      }
    };

    /**
     * Mount the top-left fold button on every "已编辑 N 个文件" card.
     *
     * React renders the card as `div[data-changed-files]` > header button + ul
     * list (+ a bottom toggle when >4 files). We deliberately do not touch the
     * React tree: the injected `button` is absolutely positioned over the
     * header's leading padding and only flips `data-djh-cf` on the card, which
     * CSS uses to hide the list. Idempotent (one button per card) and cheap to
     * re-run, so the MutationObserver can call it on every content burst — that
     * also restores the button if React ever replaces the card's children.
     */
    const syncChangedFileCards = () => {
      const cards = document.querySelectorAll('[data-changed-files]');
      for (const card of cards) {
        if (card.querySelector(':scope > [data-djh-cf-btn]')) continue;
        card.setAttribute('data-djh-cf-on', '1');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.setAttribute('data-djh-cf-btn', '');
        btn.setAttribute('aria-expanded', card.getAttribute('data-djh-cf') === '1' ? 'false' : 'true');
        btn.setAttribute('aria-label', card.getAttribute('data-djh-cf') === '1' ? '展开改动文件列表' : '折叠改动文件列表');
        btn.innerHTML = CF_CHEVRON;
        btn.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          const collapsed = card.getAttribute('data-djh-cf') === '1';
          if (collapsed) card.removeAttribute('data-djh-cf');
          else card.setAttribute('data-djh-cf', '1');
          btn.setAttribute('aria-expanded', collapsed ? 'true' : 'false');
          btn.setAttribute('aria-label', collapsed ? '折叠改动文件列表' : '展开改动文件列表');
        });
        card.appendChild(btn);
      }
    };

    /**
     * Hide the settings dialog header's "打开配置文件" button.
     * Text-based match on the exact zh label (the owner's UI language), scoped
     * to elements inside a settings dialog container. Only flips a data
     * attribute so React never learns about it; the CSS rule above does the
     * hiding. Re-run by the observer/heartbeat, so React re-renders re-hide.
     */
    const hideOpenDocButton = () => {
      for (const btn of document.querySelectorAll('[role="dialog"] button')) {
        const label = (btn.textContent || '').trim();
        if (label === '打开配置文件') btn.setAttribute('data-djh-quiet', 'opendoc');
      }
    };

    return {
      apply(ctx) {
        if (typeof document === 'undefined') return;
        const tag = document.createElement('style');
        tag.dataset.plugin = '@local/dsh-hide-mode-chip';
        tag.dataset.pluginCss = 'hide-mode-chip';
        tag.textContent = CSS;
        document.head.appendChild(tag);
        ctx.effect(() => () => {
          tag.remove();
        }, 'hide-mode-chip: stylesheet');

        /* v0.083: hide the eval-only workspace "evals-ws" (regression-fixture home)
           from the owner's sidebar. The whole workspace (header + its session rows)
           lives in one groupSection container, so one :has() rule hides it all.
           EVAL PAGES MUST STILL SEE IT: eval scripts set window.name='djh-eval' on
           their tab BEFORE navigating (DSH strips URL query on load, so a param
           cannot carry the marker); they load this plugin too, so the rule is
           injected only on tabs without that marker — the owner's never has it. */
        if (window.name !== 'djh-eval') {
          const evalHide = document.createElement('style');
          evalHide.dataset.pluginCss = 'hide-mode-chip-evalws';
          evalHide.textContent =
            'div[class*="_groupSection"]:has([data-row-key^="workspace:cbcd81d3"]){display:none!important}';
          document.head.appendChild(evalHide);
          ctx.effect(() => () => {
            evalHide.remove();
          }, 'hide-mode-chip: evalws hide');
        }

        /* Menus mount into a portal on <body>, so watch the body subtree and
           coalesce bursts into one task.
           NOTE: use setTimeout, not requestAnimationFrame. The Chrome tab can be
           backgrounded (and the owner keeps DSH in a background app window), and
           rAF does not fire in hidden tabs — that made the fold button appear or
           not depending on which tab was active. A 1.5s timer is the cheap
           safety net for cards that mount while we are detached. */
        let scheduled = 0;
        const tick = () => {
          drillToModelList();
          syncChangedFileCards();
          hideOpenDocButton();
          syncTables();
        };
        const schedule = () => {
          if (scheduled !== 0) return;
          scheduled = setTimeout(() => {
            scheduled = 0;
            tick();
          }, 16);
        };
        const observer = new MutationObserver(schedule);
        observer.observe(document.body, { childList: true, subtree: true });
        tick();
        const heartbeat = setInterval(tick, 1500);
        ctx.effect(() => () => {
          observer.disconnect();
          clearInterval(heartbeat);
          if (scheduled !== 0) clearTimeout(scheduled);
        }, 'hide-mode-chip: model menu auto-drill');
      },
    };
  },
});
