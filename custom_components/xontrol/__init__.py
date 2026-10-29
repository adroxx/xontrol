"""The Xontrol integration.

Adrian's own, self-owned equivalent of Homeway for this specific job:
managing which entities are exposed to the self-hosted Alexa Smart Home
skill, entirely inside Home Assistant with no external script and no
Claude in the loop. v1 covers Alexa exposure management; the api.py /
panel split is meant to be extended with further features later.
"""

from __future__ import annotations

import logging

from homeassistant.components.http import StaticPathConfig
from homeassistant.components.panel_custom import async_register_panel
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from . import api
from .const import (
    DOMAIN,
    PANEL_ICON,
    PANEL_JS_VERSION,
    PANEL_TITLE,
    PANEL_URL_PATH,
    STATIC_URL_PATH,
)

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Xontrol from a config entry."""
    www_path = hass.config.path("custom_components/xontrol/www")
    await hass.http.async_register_static_paths(
        [StaticPathConfig(STATIC_URL_PATH, www_path, cache_headers=False)]
    )

    api.async_register_views(hass)

    await async_register_panel(
        hass,
        frontend_url_path=PANEL_URL_PATH,
        webcomponent_name="xontrol-panel",
        sidebar_title=PANEL_TITLE,
        sidebar_icon=PANEL_ICON,
        module_url=f"{STATIC_URL_PATH}/xontrol-panel.js?v={PANEL_JS_VERSION}",
        embed_iframe=False,
        require_admin=True,
    )

    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = True
    return True
