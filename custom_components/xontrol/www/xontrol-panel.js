/*
 * Xontrol sidebar panel.
 *
 * Registered via Home Assistant's panel_custom mechanism (see __init__.py),
 * NOT a plain iframe -- a plain iframe would be a separate browsing context
 * with no access to the frontend's auth token, so its fetch() calls to
 * /api/xontrol/* would either fail auth or require weakening the API
 * views to requires_auth=False (unacceptable: those views can restart Core
 * and rewrite the Alexa exposure filter). panel_custom instead hands this
 * element the live `hass` object as a property, giving it hass.callApi(),
 * with no build step or framework.
 *
 * Deliberately hand-built (table, tabs, sort/filter) rather than importing
 * HA's internal ha-data-table/tab-bar components -- those are undocumented
 * frontend internals and reusing them would raise this panel's exposure to
 * breaking on future HA frontend upgrades. Styling instead leans entirely
 * on HA's public theme CSS custom properties, which are inherited through
 * shadow DOM boundaries and update live on theme/dark-mode changes with no
 * extra wiring needed. One exception: <ha-icon> renders each entity's icon --
 * it's a globally-registered custom element already used throughout
 * Lovelace, not an internal layout/data construct like ha-data-table, so it
 * carries materially less upgrade risk.
 *
 * Row click dispatches a `hass-more-info` custom event (the standard
 * Lovelace-ecosystem convention for opening HA's own native, fully
 * interactive entity dialog) instead of building bespoke per-domain
 * controls here.
 *
 * Columns are resizable via drag handles on the header borders (desktop
 * only -- below the mobile breakpoint the table collapses into a stacked
 * card list, see the @media block, and the header/handles are hidden).
 * Widths are tracked as percentages that always sum to 100. Dragging a
 * handle grows or shrinks only the column being dragged, trading the
 * difference with the very last column -- every column in between keeps
 * its own width and just visually shifts right/left. Total width never
 * changes, so the table can never need a horizontal scrollbar.
 *
 * The Alexa toggle column is pinned to the far right and kept out of that
 * percentage/resize system entirely -- fixed width, no drag handle -- so
 * it can never be resized away or wrap out of view in any layout.
 *
 * Entity ID is rendered as a second line under the friendly name (inside
 * the Name column) rather than as its own column -- mirrors Homeway's own
 * device list layout and, combined with the mobile card breakpoint, is
 * what keeps this panel usable at iPhone widths instead of squashing many
 * columns into ~375px.
 *
 * On/off state is conveyed by tinting the row's icon green (via
 * --state-icon-active-color, the same CSS var HA's own state icons use)
 * rather than a separate State column -- entities with no icon of their
 * own fall back to a generic toggle icon so there's always something to
 * tint instead of blank space.
 *
 * Header: the toolbar's own background/divider styling matches HA's
 * dashboard header (e.g. "Overview") -- sidebar-matching background band,
 * a border-bottom seam, pixel-measured height/inset/font-size. The tab
 * strip itself (title left, tabs right, icon + label, active tab
 * underlined in --primary-color) instead matches HA's sub-page header
 * style (e.g. Settings > Voice assistants), always shown regardless of
 * tab count -- unlike a Lovelace dashboard's view-tabs, which only
 * appear once there's more than one view. The descriptive line lives
 * with the tab's own content rather than in the toolbar, since neither
 * reference page puts a subtitle in its header.
 */

const STORAGE_KEY = "xontrol_panel_state";
// Pre-rename key (domain was xone_connect until 2026-10-30) -- read once so
// saved sort/filter/column widths survive the rename.
const LEGACY_STORAGE_KEY = "xone_connect_panel_state";
const FALLBACK_ICON = "mdi:toggle-switch-outline";
const ALEXA_COLUMN_WIDTH = "68px";

const DEFAULT_SORT = { key: "friendly_name", dir: "asc" };
const DEFAULT_FILTERS = { text: "", exposedOnly: false, domain: "all" };
const DEFAULT_COLUMN_WIDTHS = [6, 49, 21, 24];

// Resizable, percentage-based columns (left to right). The Alexa toggle
// column is rendered separately, always last -- see ALEXA_COLUMN_WIDTH.
const COLUMNS = [
  { key: null, label: "", sortable: false }, // icon
  { key: "friendly_name", label: "Name", sortable: true }, // name + entity id, stacked
  { key: "domain", label: "Domain", sortable: true },
  { key: "integration", label: "Integration", sortable: true },
];

const ALEXA_COLUMN = { key: "exposed", label: "Alexa", sortable: true };

class XontrolPanel extends HTMLElement {
  set hass(hass) {
    this._hass = hass;
    if (!this._initialized) {
      this._initialized = true;
      try {
        this._ensureShadow();

        const persisted = this._loadPersisted();
        this._tabs = [
          { id: "entities", label: "Expose", icon: "mdi:share-variant", render: () => this._renderEntitiesTabShell() },
          { id: "automations", label: "Automations", icon: "mdi:robot", render: () => this._renderBlankTabShell("Automations") },
          { id: "settings", label: "Settings", icon: "mdi:cog", render: () => this._renderBlankTabShell("Settings") },
        ];
        this._activeTabId =
          persisted.activeTab && this._tabs.some((t) => t.id === persisted.activeTab)
            ? persisted.activeTab
            : this._tabs[0].id;
        this._sort = { ...DEFAULT_SORT, ...(persisted.sort || {}) };
        this._filters = { ...DEFAULT_FILTERS, ...(persisted.filters || {}) };
        this._columnWidths =
          Array.isArray(persisted.columnWidths) && persisted.columnWidths.length === COLUMNS.length
            ? persisted.columnWidths
            : [...DEFAULT_COLUMN_WIDTHS];
        this._entities = [];
        this._checked = new Set();
        this._saving = false;

        this._render();
        this._loadEntities();
      } catch (err) {
        // Without this, a startup error here just aborts silently and the
        // panel stays permanently blank with nothing in the console for a
        // typical user to notice.
        this._initialized = false;
        this._showFatalError(err);
      }
    }
  }

  connectedCallback() {
    this._ensureShadow();
  }

  _ensureShadow() {
    if (!this.shadowRoot) {
      this.attachShadow({ mode: "open" });
    }
  }

  _showFatalError(err) {
    this._ensureShadow();
    const detail = err && err.stack ? err.stack : String(err);
    this.shadowRoot.innerHTML = `<pre style="color:#db4437;padding:16px;white-space:pre-wrap;font-family:monospace;">Xontrol failed to load:\n${detail}</pre>`;
  }

  _loadPersisted() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_STORAGE_KEY);
      return raw ? JSON.parse(raw) || {} : {};
    } catch (err) {
      // Corrupt/stale shape from a prior version must never break the panel.
      return {};
    }
  }

  _persist() {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          activeTab: this._activeTabId,
          sort: this._sort,
          filters: this._filters,
          columnWidths: this._columnWidths,
        })
      );
    } catch (err) {
      // localStorage can throw (private browsing, quota) -- persistence is
      // a nice-to-have, never let it break the panel.
    }
  }

  async _loadEntities() {
    this._setStatus("Loading entities...", false);
    try {
      const resp = await this._hass.callApi("GET", "xontrol/entities");
      this._entities = resp.entities;
      this._checked = new Set(
        this._entities.filter((e) => e.exposed).map((e) => e.entity_id)
      );
      this._setStatus("", false);
      this._refreshActiveTab();
    } catch (err) {
      this._setStatus("Failed to load entities: " + err, true);
    }
  }

  _refreshActiveTab() {
    const tab = this._tabs.find((t) => t.id === this._activeTabId);
    if (tab) tab.render();
  }

  async _save() {
    if (this._saving) return;
    this._saving = true;
    this._setStatus("Saving and restarting Home Assistant...", false);
    this._updateSaveButton();

    try {
      const resp = await this._hass.callApi("POST", "xontrol/save", {
        entity_ids: Array.from(this._checked),
      });
      let msg = "Saved. Home Assistant is restarting -- this page will reconnect automatically.";
      if (resp.purge_failed && resp.purge_failed.length) {
        msg += ` (${resp.purge_failed.length} Alexa device(s) could not be purged and will retry next save.)`;
      }
      this._setStatus(msg, false);
      this._waitForRestart();
    } catch (err) {
      this._saving = false;
      this._setStatus("Save failed: " + err, true);
      this._updateSaveButton();
    }
  }

  _waitForRestart() {
    let attempts = 0;
    const poll = setInterval(async () => {
      attempts += 1;
      try {
        await this._hass.callApi("GET", "xontrol/entities");
        clearInterval(poll);
        this._setStatus("Home Assistant is back. Reloading...", false);
        setTimeout(() => window.location.reload(), 1000);
      } catch (err) {
        if (attempts > 60) {
          clearInterval(poll);
          this._setStatus(
            "Still waiting on Home Assistant to come back -- reload the page manually when it's ready.",
            false
          );
        }
      }
    }, 3000);
  }

  _render() {
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          /* Measured directly off a real Overview screenshot: the title,
             "Welcome Administrator", and "Favorites" all start at the same
             ~37px inset from the sidebar boundary (not the 16px this panel
             used before) -- Overview applies this margin to the whole page,
             not just the toolbar, so it belongs on :host itself. */
          padding: 16px 36px;
          font-family: var(--paper-font-body1_-_font-family, Roboto, sans-serif);
          color: var(--primary-text-color, #212121);
          background: var(--primary-background-color, #fafafa);
          min-height: 100vh;
          box-sizing: border-box;
          /* Every native HA panel (Lovelace, Config, ...) is wrapped in a
             shared shell that draws this divider between the sidebar and
             the content pane. panel_custom hands us a completely bare
             custom element with none of that chrome, so it has to be
             asserted here -- otherwise the boundary only reads as a
             color change, which vanished once the toolbar started
             matching the sidebar's own background (see .toolbar below). */
          border-left: 1px solid var(--divider-color, rgba(0, 0, 0, 0.12));
          /* WebKit auto-inflates font sizes in text blocks based on
             heuristics tied to surrounding content volume -- this is why
             the 174-row unfiltered list rendered visibly bigger than the
             7-row filtered one despite identical CSS. Disabling it forces
             every size in this stylesheet to render as specified,
             regardless of how much content is around it. */
          -webkit-text-size-adjust: 100%;
          text-size-adjust: 100%;
        }
        .toolbar {
          display: flex;
          align-items: center;
          /* Anchors .tabbar's absolute centering (below) to this element
             instead of the whole panel. */
          position: relative;
          /* Title on the left; the tab group is centered independently
             (see .tabbar) rather than placed via this rule. */
          justify-content: space-between;
          /* Pixel-measured off Overview's own toolbar band -- re-measured
             a second time (background-start to border-bottom row, within
             a single screenshot so the comparison isn't thrown off by two
             independently-cropped images having different origins) and
             corrected from 54 to 56 to close a small remaining gap. */
          min-height: 56px;
          box-sizing: border-box;
          /* Bleeds edge-to-edge and carries its own background, exactly
             like Overview's <app-toolbar>: HA's stock header shares the
             sidebar's background color (a shade lighter than the page
             canvas below it), not the page's own background -- that color
             seam is what actually reads as "a header" rather than just a
             bigger line of text. Margins cancel :host's own padding (see
             the matching -10px override in the mobile media query, where
             :host's padding shrinks to 10px) so the bleed always exactly
             matches whatever padding is currently in effect. */
          margin: -16px -36px 0 -36px;
          padding: 0 36px;
          background: var(--app-header-background-color, var(--sidebar-background-color, var(--primary-background-color, #fafafa)));
          /* The real seam under Overview's toolbar: measured as a single,
             distinctly lighter pixel row between the toolbar band and the
             content canvas below it -- a genuine border, not just the
             color-band boundary itself. */
          border-bottom: 1px solid var(--divider-color, rgba(255, 255, 255, 0.08));
        }
        h1 {
          /* Explicit px, not em: relative sizing here inherits from
             whatever font-size context the panel_custom element happens
             to sit in. 24px overshot -- pixel-measuring the actual glyph
             height of both titles against the same background color (so
             directly comparable) put Xontrol's ink at 18px tall against
             Overview's 14px; back-calculating through that same ratio
             puts Overview's real font-size at ~19px, i.e. HA's standard
             20px title size, not 24px. */
          font-size: 20px;
          font-weight: 400;
          margin: 0;
          color: var(--primary-text-color, #212121);
        }
        .intro-text {
          color: var(--secondary-text-color, #727272);
          /* Overview's toolbar hands off to a large gap before its own
             first line of content ("Welcome Administrator") -- matched
             here rather than letting this text crowd the toolbar band. */
          margin: 24px 0 16px 0;
          font-size: 0.95em;
        }
        .tabbar {
          display: flex;
          align-items: stretch;
          gap: 8px;
          /* Pixel-measured off HA's own Voice-assistants-style sub-page
             tabs: the group centers in the toolbar as its own unit,
             independent of however wide the title happens to be, rather
             than being pushed to one side. */
          position: absolute;
          top: 0;
          bottom: 0;
          left: 50%;
          transform: translateX(-50%);
        }
        .tab {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          background: none;
          border: none;
          /* Transparent border reserves the same space the active
             indicator needs, so switching tabs never shifts layout. */
          border-bottom: 3px solid transparent;
          /* Pixel-measured off the reference screenshot: the tab's whole
             clickable/hoverable box is much wider than its icon+label
             content (~140px box around ~76px of content) -- this is what
             actually reads as a "button" rather than plain inline text. */
          padding: 0 28px;
          font-size: 14px;
          font-family: inherit;
          color: var(--secondary-text-color, #727272);
          cursor: pointer;
          white-space: nowrap;
        }
        .tab ha-icon {
          --mdc-icon-size: 20px;
          color: inherit;
        }
        .tab:hover {
          /* Measured directly off a hover screenshot: a flat ~5.5% white
             overlay filling the tab's full box, no rounded corners. */
          background: rgba(255, 255, 255, 0.055);
        }
        .tab-active {
          color: var(--primary-text-color, #212121);
          border-bottom-color: var(--primary-color, #03a9f4);
        }
        .filter-bar {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 12px;
          margin-bottom: 12px;
        }
        input[type="search"], select {
          padding: 8px 12px;
          border: 1px solid var(--divider-color, #e0e0e0);
          border-radius: 6px;
          font-size: 1em;
          font-family: inherit;
          box-sizing: border-box;
          background: var(--card-background-color, #fff);
          color: inherit;
        }
        input[type="search"] {
          flex: 1 1 260px;
          min-width: 200px;
        }
        .filter-checkbox {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 0.9em;
          color: var(--secondary-text-color, #727272);
          white-space: nowrap;
        }
        .summary {
          display: flex;
          align-items: center;
          justify-content: space-between;
          flex-wrap: wrap;
          gap: 12px;
          margin-bottom: 10px;
          font-size: 0.85em;
          color: var(--secondary-text-color, #727272);
        }
        .summary strong {
          color: var(--primary-text-color, #212121);
          font-weight: 600;
        }
        .summary-stats {
          display: flex;
          flex-wrap: wrap;
          gap: 16px;
        }
        .summary-actions {
          display: flex;
          gap: 8px;
        }
        .summary-actions button {
          background: none;
          border: 1px solid var(--divider-color, #e0e0e0);
          border-radius: 6px;
          padding: 4px 10px;
          font-size: 0.95em;
          font-family: inherit;
          color: var(--primary-color, #03a9f4);
          cursor: pointer;
        }
        .summary-actions button:hover {
          background: var(--secondary-background-color, #f0f0f0);
        }
        .table-wrap {
          max-height: 60vh;
          overflow-y: auto;
          overflow-x: hidden;
          border: 1px solid var(--divider-color, #e0e0e0);
          border-radius: 6px;
        }
        table {
          width: 100%;
          /* border-collapse: collapse is what actually broke this: it
             forces table cells into a rendering mode where Chrome/WebKit
             doesn't correctly composite position:sticky <th> cells above
             later-scrolled <tbody> content -- row icons/toggles paint
             through the "sticky" header instead of being occluded by it.
             separate + zero spacing looks identical (only border-bottom
             is used anywhere, no vertical cell borders to double up) but
             makes the sticky header actually stick above scrolled rows. */
          border-collapse: separate;
          border-spacing: 0;
          font-size: 0.92em;
          table-layout: fixed;
        }
        thead th {
          position: sticky;
          top: 0;
          z-index: 2;
          background: var(--card-background-color, #fff);
          text-align: left;
          padding: 8px 10px;
          font-weight: 600;
          font-size: 0.85em;
          color: var(--secondary-text-color, #727272);
          border-bottom: 1px solid var(--divider-color, #e0e0e0);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        th.sortable {
          cursor: pointer;
          user-select: none;
        }
        th.sortable:hover {
          color: var(--primary-text-color, #212121);
        }
        .col-resize-handle {
          position: absolute;
          top: 0;
          right: 0;
          width: 6px;
          height: 100%;
          cursor: col-resize;
          z-index: 1;
        }
        .col-resize-handle:hover,
        .col-resize-handle.resizing {
          background: var(--primary-color, #03a9f4);
          opacity: 0.4;
        }
        tbody td {
          padding: 7px 10px;
          border-bottom: 1px solid var(--divider-color, #eee);
          vertical-align: middle;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        tbody tr {
          cursor: pointer;
        }
        tbody tr:hover {
          background: var(--secondary-background-color, #f0f0f0);
        }
        tbody tr.row-exposed {
          background: var(--secondary-background-color, #eeeeee);
          background: color-mix(in srgb, var(--primary-background-color, #fafafa) 92%, black 8%);
        }
        .col-icon {
          text-align: center;
        }
        .col-icon ha-icon {
          --mdc-icon-size: 20px;
          color: var(--secondary-text-color, #727272);
        }
        .col-icon ha-icon.icon-on {
          color: var(--state-icon-active-color, #4caf50);
        }
        .toggle {
          position: relative;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 44px;
          height: 44px;
          vertical-align: middle;
          cursor: pointer;
        }
        .toggle input {
          position: absolute;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          margin: 0;
          opacity: 0;
          cursor: pointer;
        }
        .toggle-slider {
          position: relative;
          display: block;
          width: 29px;
          height: 16px;
          cursor: pointer;
          /* Hardcoded, not theme-derived: --disabled-text-color and
             --divider-color turned out to be near-invisible against this
             theme's background (they're meant for subtle accents, not a
             switch track), so this can't be left to theme-variable luck. */
          background-color: #8e8e93;
          box-sizing: border-box;
          transition: background-color 0.2s;
          border-radius: 16px;
          pointer-events: none;
        }
        .toggle-slider::before {
          position: absolute;
          content: "";
          height: 12px;
          width: 12px;
          left: 1px;
          top: 50%;
          transform: translateY(-50%);
          background-color: #fff;
          box-shadow: 0 1px 2px rgba(0, 0, 0, 0.4);
          transition: transform 0.2s;
          border-radius: 50%;
        }
        .toggle input:checked + .toggle-slider {
          background-color: var(--switch-checked-track-color, var(--primary-color, #03a9f4));
        }
        .toggle input:checked + .toggle-slider::before {
          transform: translateY(-50%) translateX(15px);
        }
        .col-name {
          white-space: normal;
        }
        .name-primary {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .name-entity-id {
          font-size: 0.8em;
          color: var(--secondary-text-color, #969696);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          margin-top: 1px;
        }
        .empty {
          text-align: center;
          padding: 24px;
          color: var(--secondary-text-color, #727272);
        }
        .status {
          margin: 4px 0 12px 0;
          font-size: 0.9em;
        }
        .status.error {
          color: var(--error-color, #db4437);
        }
        .save-bar {
          position: sticky;
          bottom: 0;
          background: var(--primary-background-color, #fafafa);
          padding: 12px 0;
          margin-top: 16px;
        }
        button#save {
          background: var(--primary-color, #03a9f4);
          color: white;
          border: none;
          border-radius: 6px;
          padding: 10px 20px;
          font-size: 1em;
          font-family: inherit;
          cursor: pointer;
        }
        button#save:disabled {
          opacity: 0.6;
          cursor: default;
        }

        /* ---- Mobile / iOS: collapse the table into a stacked card list ---- */
        @media (max-width: 640px) {
          :host {
            padding: 10px;
          }
          .sticky-header {
            position: sticky;
            top: 0;
            z-index: 5;
            background: var(--primary-background-color, #fafafa);
            /* Cancel :host's own padding and reapply it as this element's
               own, so the sticky header spans edge-to-edge once pinned
               instead of floating with a gap on either side. */
            margin: -10px -10px 0 -10px;
            padding: 10px 10px 0 10px;
          }
          .toolbar {
            min-height: 50px;
            /* Re-bleed relative to .sticky-header's own 10px local padding
               (set just above) instead of the base rule's -16px/-36px pair,
               which is sized for the desktop breakpoint's wider padding. */
            margin: -10px -10px 0 -10px;
            padding: 0 10px;
          }
          h1 {
            font-size: 18px;
          }
          .tabbar {
            gap: 0;
          }
          .tab {
            /* Three tabs at the desktop's 28px padding plus visible labels
               don't fit a phone-width viewport at all -- icon-only with
               minimal padding does, guaranteed, regardless of screen size. */
            padding: 0 10px;
          }
          .tab span {
            display: none;
          }
          .filter-bar {
            gap: 8px;
          }
          input[type="search"], select {
            font-size: 16px; /* prevents iOS Safari auto-zoom on focus */
            flex: 1 1 100%;
          }
          .filter-checkbox {
            flex: 1 1 100%;
          }
          .table-wrap {
            max-height: none;
            /* Scroll, don't clip: the HA companion app's embedded WebView
               doesn't reliably shrink col-name to fit the way Safari does,
               so rows can end up wider than the viewport. overflow-x:hidden
               was silently clipping the Alexa toggle off past the right
               edge in that case -- overflow-x:auto instead makes any
               overflow reachable with a swipe, so the toggle is never
               simply gone. */
            overflow-x: auto;
            overflow-y: visible;
            -webkit-overflow-scrolling: touch;
            border: none;
            border-radius: 0;
          }
          table {
            table-layout: auto;
            width: 100%;
          }
          colgroup {
            display: none;
          }
          thead {
            display: none;
          }
          tbody, tr, td {
            display: block;
            width: auto !important;
          }
          /* CSS Grid, not flex-on-table-elements: three flexbox behaviors
             in a row (shrink-to-fit measurement, max-width on a flex
             child, text-overflow ellipsis) all misbehaved specifically in
             the HA companion app's embedded WebView despite working in
             Safari -- overriding a <tr>'s display away from its native
             table-row role and then relying on flexbox's content-based
             sizing algorithm on top of that is a much less consistently
             implemented combination than an explicit grid-template-columns
             track list, which needs no content measurement at all: the
             three columns are always exactly auto / remaining-space / auto,
             full stop, regardless of engine.  */
          tbody tr {
            display: grid;
            grid-template-columns: auto minmax(0, 1fr) auto;
            align-items: center;
            column-gap: 10px;
            padding: 12px 6px;
            border-bottom: 1px solid var(--divider-color, #eee);
          }
          tbody td {
            border-bottom: none;
            padding: 0;
            white-space: normal;
          }
          .col-icon ha-icon {
            --mdc-icon-size: 26px;
          }
          .col-name {
            min-width: 0;
            overflow: hidden;
          }
          .name-primary {
            font-size: 1.02em;
          }
          .col-domain,
          .col-integration {
            display: none;
          }
          .col-resize-handle {
            display: none;
          }
          .save-bar {
            padding-bottom: max(12px, env(safe-area-inset-bottom));
          }
          button#save {
            width: 100%;
            padding: 14px 20px;
            font-size: 1.05em;
          }
        }
      </style>
      <div id="sticky-header" class="sticky-header">
        <div class="toolbar">
          <h1>Xontrol</h1>
          <div id="tabbar" class="tabbar"></div>
        </div>
        <div id="status" class="status"></div>
        <div id="tab-sticky-slot"></div>
      </div>
      <div id="tabcontent"></div>
    `;

    this._renderTabBar();
    const activeTab = this._tabs.find((t) => t.id === this._activeTabId) || this._tabs[0];
    activeTab.render();
  }

  _renderTabBar() {
    const bar = this.shadowRoot.getElementById("tabbar");
    if (!bar) return;
    // Styled after HA's own sub-page tab strip (e.g. Settings > Voice
    // assistants > Assistants/Expose) -- icon + label per tab, always
    // shown regardless of tab count, unlike a Lovelace dashboard's view
    // tabs which only appear once there's more than one view.
    bar.innerHTML = this._tabs
      .map(
        (tab) => `
          <button class="tab ${tab.id === this._activeTabId ? "tab-active" : ""}" data-tab-id="${tab.id}">
            <ha-icon icon="${tab.icon}"></ha-icon>
            <span>${tab.label}</span>
          </button>
        `
      )
      .join("");
    bar.querySelectorAll("button[data-tab-id]").forEach((btn) => {
      btn.addEventListener("click", () =>
        this._switchTab(btn.getAttribute("data-tab-id"))
      );
    });
  }

  _switchTab(id) {
    if (this._activeTabId === id) return;
    this._activeTabId = id;
    this._persist();
    this._renderTabBar();
    const tab = this._tabs.find((t) => t.id === id);
    if (tab) tab.render();
  }

  _setStatus(text, isError) {
    const el = this.shadowRoot.getElementById("status");
    if (!el) return;
    el.textContent = text;
    el.className = "status" + (isError ? " error" : "");
  }

  _updateSaveButton() {
    const btn = this.shadowRoot.getElementById("save");
    if (!btn) return;
    btn.disabled = this._saving;
    btn.textContent = this._saving ? "Saving..." : "Save & Restart";
  }

  // ---- Placeholder tabs (Automations, Settings) -----------------------

  _renderBlankTabShell(title) {
    const stickySlot = this.shadowRoot.getElementById("tab-sticky-slot");
    const content = this.shadowRoot.getElementById("tabcontent");
    if (!stickySlot || !content) return;
    stickySlot.innerHTML = "";
    content.innerHTML = `<div class="empty">${title} is coming soon.</div>`;
  }

  // ---- Exposed Devices tab -------------------------------------------

  _renderEntitiesTabShell() {
    // Split across two containers rather than one: #tab-sticky-slot lives
    // inside the sticky header (see _render()) so the filter controls and
    // summary stay pinned on mobile, while #tabcontent holds only the
    // actual scrollable row list and the save bar.
    const stickySlot = this.shadowRoot.getElementById("tab-sticky-slot");
    const content = this.shadowRoot.getElementById("tabcontent");
    if (!stickySlot || !content) return;

    stickySlot.innerHTML = `
      <div class="intro-text">Manage entities exposed to your self-hosted Alexa skill.</div>
      <div class="filter-bar">
        <input type="search" placeholder="Filter entities..." id="filter-text" />
        <label class="filter-checkbox">
          <input type="checkbox" id="filter-exposed" />
          Exposed only
        </label>
        <select id="filter-domain"></select>
      </div>
      <div id="summary" class="summary"></div>
    `;

    content.innerHTML = `
      <div class="table-wrap">
        <table>
          <colgroup id="colgroup"></colgroup>
          <thead><tr id="header-row"></tr></thead>
          <tbody id="rows"></tbody>
        </table>
      </div>
      <div class="save-bar">
        <button id="save">Save &amp; Restart</button>
      </div>
    `;

    const textInput = this.shadowRoot.getElementById("filter-text");
    textInput.value = this._filters.text;
    textInput.addEventListener("input", (e) => {
      this._filters.text = e.target.value;
      this._persist();
      this._renderTableBody();
    });

    const exposedCb = this.shadowRoot.getElementById("filter-exposed");
    exposedCb.checked = this._filters.exposedOnly;
    exposedCb.addEventListener("change", (e) => {
      this._filters.exposedOnly = e.target.checked;
      this._persist();
      this._renderTableBody();
    });

    const domainSelect = this.shadowRoot.getElementById("filter-domain");
    const domains = Array.from(new Set(this._entities.map((e) => e.domain))).sort();
    if (!domains.includes(this._filters.domain) && this._filters.domain !== "all") {
      this._filters.domain = "all";
    }
    domainSelect.innerHTML =
      `<option value="all">All domains</option>` +
      domains.map((d) => `<option value="${d}">${d}</option>`).join("");
    domainSelect.value = this._filters.domain;
    domainSelect.addEventListener("change", (e) => {
      this._filters.domain = e.target.value;
      this._persist();
      this._renderTableBody();
    });

    this.shadowRoot
      .getElementById("save")
      .addEventListener("click", () => this._save());

    this._renderColgroup();
    this._renderHeaderRow();
    this._renderTableBody();
    this._updateSaveButton();
  }

  _renderColgroup() {
    const colgroup = this.shadowRoot.getElementById("colgroup");
    if (!colgroup) return;
    const dataCols = this._columnWidths.map((w) => `<col style="width:${w}%">`).join("");
    colgroup.innerHTML = dataCols + `<col style="width:${ALEXA_COLUMN_WIDTH}">`;
  }

  _renderHeaderRow() {
    const headerRow = this.shadowRoot.getElementById("header-row");
    if (!headerRow) return;

    const dataHeaders = COLUMNS.map((col, i) => {
      const handle =
        i < COLUMNS.length - 1
          ? `<span class="col-resize-handle" data-col-index="${i}"></span>`
          : "";
      if (!col.sortable) {
        return `<th>${col.label}${handle}</th>`;
      }
      const active = this._sort.key === col.key;
      const arrow = active ? (this._sort.dir === "asc" ? " ▲" : " ▼") : "";
      return `<th class="sortable" data-key="${col.key}">${col.label}${arrow}${handle}</th>`;
    }).join("");

    const alexaActive = this._sort.key === ALEXA_COLUMN.key;
    const alexaArrow = alexaActive ? (this._sort.dir === "asc" ? " ▲" : " ▼") : "";
    const alexaHeader = `<th class="sortable col-alexa" data-key="${ALEXA_COLUMN.key}">${ALEXA_COLUMN.label}${alexaArrow}</th>`;

    headerRow.innerHTML = dataHeaders + alexaHeader;

    headerRow.querySelectorAll("th.sortable").forEach((th) => {
      th.addEventListener("click", () => {
        const key = th.getAttribute("data-key");
        if (this._sort.key === key) {
          this._sort = { key, dir: this._sort.dir === "asc" ? "desc" : "asc" };
        } else {
          this._sort = { key, dir: "asc" };
        }
        this._persist();
        this._renderHeaderRow();
        this._renderTableBody();
      });
    });

    this._attachColumnResize(headerRow);
  }

  _attachColumnResize(headerRow) {
    headerRow.querySelectorAll(".col-resize-handle").forEach((handle) => {
      handle.addEventListener("click", (ev) => ev.stopPropagation());
      handle.addEventListener("mousedown", (ev) => this._startColumnResize(ev, handle));
    });
  }

  _startColumnResize(ev, handle) {
    ev.preventDefault();
    ev.stopPropagation();

    const index = parseInt(handle.getAttribute("data-col-index"), 10);
    const lastIndex = this._columnWidths.length - 1;
    const table = this.shadowRoot.querySelector(".table-wrap table");
    if (!table) return;

    const tableWidth = table.getBoundingClientRect().width;
    const startX = ev.clientX;
    const startWidths = [...this._columnWidths];
    const minWidth = 4;

    handle.classList.add("resizing");

    const onMove = (moveEv) => {
      const deltaPct = ((moveEv.clientX - startX) / tableWidth) * 100;
      let newCurrent = startWidths[index] + deltaPct;
      let newLast = startWidths[lastIndex] - deltaPct;

      if (newCurrent < minWidth) {
        newLast -= minWidth - newCurrent;
        newCurrent = minWidth;
      }
      if (newLast < minWidth) {
        newCurrent -= minWidth - newLast;
        newLast = minWidth;
      }

      this._columnWidths[index] = newCurrent;
      this._columnWidths[lastIndex] = newLast;
      this._renderColgroup();
    };

    const onUp = () => {
      handle.classList.remove("resizing");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      this._persist();
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  _visibleRows() {
    const text = this._filters.text.trim().toLowerCase();
    let rows = this._entities.filter((e) => {
      if (this._filters.exposedOnly && !this._checked.has(e.entity_id)) return false;
      if (this._filters.domain !== "all" && e.domain !== this._filters.domain) return false;
      if (!text) return true;
      return (
        e.friendly_name.toLowerCase().includes(text) ||
        e.entity_id.toLowerCase().includes(text)
      );
    });

    const { key, dir } = this._sort;
    rows = rows.slice().sort((a, b) => {
      let cmp;
      if (key === "exposed") {
        // Group by live toggle state (not the stale value loaded at fetch
        // time), then alphabetically within each group.
        const aExp = this._checked.has(a.entity_id) ? 1 : 0;
        const bExp = this._checked.has(b.entity_id) ? 1 : 0;
        cmp = aExp - bExp;
        if (cmp === 0) {
          const an = (a.friendly_name || "").toLowerCase();
          const bn = (b.friendly_name || "").toLowerCase();
          cmp = an < bn ? -1 : an > bn ? 1 : 0;
        }
      } else {
        const av = (a[key] ?? "").toString().toLowerCase();
        const bv = (b[key] ?? "").toString().toLowerCase();
        cmp = av < bv ? -1 : av > bv ? 1 : 0;
      }
      return dir === "asc" ? cmp : -cmp;
    });

    return rows;
  }

  _renderSummary(rows) {
    const el = this.shadowRoot.getElementById("summary");
    if (!el) return;

    const exposedInView = rows.filter((r) => this._checked.has(r.entity_id)).length;

    el.innerHTML = `
      <span class="summary-stats">
        <span><strong>${rows.length}</strong> shown</span>
        <span><strong>${exposedInView}</strong> exposed / ${rows.length}</span>
      </span>
      <span class="summary-actions">
        <button type="button" id="expose-all">Expose all shown</button>
        <button type="button" id="clear-all">Clear all shown</button>
      </span>
    `;

    el.querySelector("#expose-all").addEventListener("click", () =>
      this._bulkSetExposed(rows, true)
    );
    el.querySelector("#clear-all").addEventListener("click", () =>
      this._bulkSetExposed(rows, false)
    );
  }

  _bulkSetExposed(rows, value) {
    rows.forEach((r) => {
      if (value) {
        this._checked.add(r.entity_id);
      } else {
        this._checked.delete(r.entity_id);
      }
    });
    this._renderTableBody();
  }

  _renderRow(e) {
    const exposed = this._checked.has(e.entity_id);
    const isOn = e.state === "on";
    const icon = e.icon || FALLBACK_ICON;

    return `
      <tr data-entity-id="${e.entity_id}" class="${exposed ? "row-exposed" : ""}">
        <td class="col-icon"><ha-icon icon="${icon}" class="${isOn ? "icon-on" : ""}"></ha-icon></td>
        <td class="col-name" title="${e.friendly_name} (${e.entity_id})">
          <div class="name-primary">${e.friendly_name}</div>
          <div class="name-entity-id">${e.entity_id}</div>
        </td>
        <td class="col-domain">${e.domain}</td>
        <td class="col-integration" title="${e.integration ?? ""}">${e.integration ?? "—"}</td>
        <td class="col-toggle">
          <label class="toggle">
            <input type="checkbox" class="toggle-input" data-entity-id="${e.entity_id}" ${
      exposed ? "checked" : ""
    } />
            <span class="toggle-slider"></span>
          </label>
        </td>
      </tr>
    `;
  }

  _renderTableBody() {
    const tbody = this.shadowRoot.getElementById("rows");
    if (!tbody) return;

    const rows = this._visibleRows();
    this._renderSummary(rows);

    if (rows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="${COLUMNS.length + 1}" class="empty">No matching entities.</td></tr>`;
      return;
    }

    tbody.innerHTML = rows.map((e) => this._renderRow(e)).join("");

    tbody.querySelectorAll("input.toggle-input").forEach((cb) => {
      cb.addEventListener("click", (ev) => ev.stopPropagation());
      cb.addEventListener("change", (ev) => {
        const id = ev.target.getAttribute("data-entity-id");
        if (ev.target.checked) {
          this._checked.add(id);
        } else {
          this._checked.delete(id);
        }
        this._renderTableBody();
      });
    });

    tbody.querySelectorAll("tr[data-entity-id]").forEach((tr) => {
      tr.addEventListener("click", (ev) => {
        if (ev.target.closest(".toggle")) return;
        this.dispatchEvent(
          new CustomEvent("hass-more-info", {
            detail: { entityId: tr.getAttribute("data-entity-id") },
            bubbles: true,
            composed: true,
          })
        );
      });
    });
  }
}

customElements.define("xontrol-panel", XontrolPanel);
