"""Constants for the Xontrol integration."""

DOMAIN = "xontrol"

PANEL_TITLE = "Xontrol"
PANEL_ICON = "mdi:hub"
PANEL_URL_PATH = "xontrol"
STATIC_URL_PATH = "/xontrol_static"

# Cache-buster for the panel's frontend script -- bump this on every edit to
# xontrol-panel.js so the browser is guaranteed to fetch the new file
# instead of serving a stale cached copy from a previous session.
PANEL_JS_VERSION = "18"

# Amazon Alexa Event Gateway -- region-matched to this account's marketplace.
# AU/JP marketplaces use the Far East (FE) endpoint. See
# Control Room/Sessions/controlroom_session_2026-07-26.md (v6.10, section B)
# for the full investigation behind this value.
EVENT_GATEWAY_URL = "https://api.fe.amazonalexa.com/v3/events"
LWA_TOKEN_URL = "https://api.amazon.com/auth/o2/token"

# Amazon's docs only confirm a 300/request cap for AddOrUpdateReport and don't
# state a DeleteReport-specific number. A 148-endpoint DeleteReport returned a
# bare INTERNAL_SERVICE_EXCEPTION in testing, so this is kept conservatively
# small and retried with backoff rather than assumed to be a hard limit.
MAX_ENDPOINTS_PER_REQUEST = 10
MAX_RETRIES = 3
RETRY_BACKOFF_SECONDS = 2

# Entity domains realistically relevant to Alexa exposure -- keeps the panel's
# checkbox list from being flooded with sensors/diagnostics that Alexa can't
# use anyway.
ALEXA_CAPABLE_DOMAINS = [
    "light",
    "switch",
    "media_player",
    "remote",
    "input_boolean",
    "scene",
    "fan",
    "cover",
    "lock",
    "climate",
    "script",
]

CONFIG_YAML_PATH = "configuration.yaml"
ALEXA_AUTH_STORAGE_PATH = ".storage/alexa_auth"

RESTART_DELAY_SECONDS = 2
