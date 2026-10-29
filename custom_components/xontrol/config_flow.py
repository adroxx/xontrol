"""Config flow for Xontrol.

Single-instance, single-step confirm -- no user input required. The
integration reads everything it needs (Alexa skill client_id/client_secret,
the include_entities filter list) directly from the existing alexa:
smart_home: block in configuration.yaml at runtime, so there is nothing to
ask for here.
"""

from __future__ import annotations

from homeassistant import config_entries
from homeassistant.data_entry_flow import FlowResult

from .const import DOMAIN, PANEL_TITLE


class XontrolConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle a config flow for Xontrol."""

    VERSION = 1

    async def async_step_user(self, user_input: dict | None = None) -> FlowResult:
        """Confirm setup -- no fields, single instance only."""
        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")

        if user_input is not None:
            return self.async_create_entry(title=PANEL_TITLE, data={})

        return self.async_show_form(step_id="user")
