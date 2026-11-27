// In-process event delivery and scheduler ticks for plugins. Core services call
// emitPluginEvent() at the point a state change is committed; only enabled
// plugins with an onEvent handler receive it.
//
// Delivery is deferred to a microtask, so a handler runs after the emitter's
// synchronous work completes (finaliseForSending publishes the invoice right
// after markSent emits, and a listener wants the published state). A handler
// failure is logged and never reaches the emitter.

import { logger } from "../utils/logger";
import { getBackendPlugins, type PluginEvent } from "./registry";
import { isPluginEnabled } from "./settings";

export function emitPluginEvent(event: PluginEvent): void {
  const listeners = getBackendPlugins().filter((p) => p.onEvent);
  if (listeners.length === 0) return;

  for (const plugin of listeners) {
    // Resolved now, while the emitter's context (and database) is current.
    if (!isPluginEnabled(plugin.id)) continue;
    queueMicrotask(() => {
      Promise.resolve()
        .then(() => plugin.onEvent?.(event))
        .catch((err) => logger.error({ err, plugin: plugin.id, event }, "Plugin event failed"));
    });
  }
}

/** Run every enabled plugin's scheduled task. Called from the core scheduler. */
export async function runPluginSchedules(): Promise<void> {
  for (const plugin of getBackendPlugins()) {
    if (!plugin.onSchedule || !isPluginEnabled(plugin.id)) continue;
    try {
      await plugin.onSchedule();
    } catch (err) {
      logger.error({ err, plugin: plugin.id }, "Plugin scheduled task failed");
    }
  }
}
