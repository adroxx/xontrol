# Xontrol

Adrian's own Home Assistant integration for the self-hosted Alexa Smart Home
skill. Its admin-only sidebar panel (`/xontrol`) lets you choose which
entities are exposed to Alexa, with no YAML editing:

- Saving purges removed entities from Alexa (`Alexa.Discovery.DeleteReport`),
  rewrites the `alexa: smart_home: filter: include_entities:` list in
  `configuration.yaml`, and restarts Core.
- Tabs: Expose (sortable/filterable table with Alexa toggles), Automations
  and Settings (placeholders).

## Requirements

- Home Assistant 2026.3+ (local brand icons).
- An existing `alexa: smart_home:` block in `configuration.yaml` with the
  skill's `client_id` / `client_secret` and a `filter: include_entities:` list.
  Xontrol reads these at runtime; it stores no secrets of its own.
- HA's `alexa` component must have completed AcceptGrant
  (`.storage/alexa_auth` present) for removals to reach Alexa.

## Install / reinstall

1. HACS → ⋮ → Custom repositories → add this repo, category *Integration*,
   then download Xontrol. (Or copy `custom_components/xontrol/` into
   `/config/custom_components/` by hand.)
2. Restart Home Assistant.
3. Settings → Devices & services → Add integration → Xontrol (no fields).

## Updating

- Panel changes (`www/xontrol-panel.js`): bump `PANEL_JS_VERSION` in
  `const.py` (the cache-buster in the panel URL) and restart Core once so the
  new URL is registered; then hard-refresh the browser.
- Any `__init__.py` / `manifest.json` / `config_flow.py` change needs a full
  Core restart (`supports_unload` is false).
