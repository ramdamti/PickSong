// Keep the private WhatsApp Web integration isolated: if it changes, startup
// still succeeds, but field changes may be missed until the listener recovers.
async function installScheduledEventListener(client, onMessage, onWarning = () => {}, onDiagnostic = null) {
  const page = client.pupPage;
  if (!page) throw new Error('WhatsApp page is unavailable');
  const callbackName = '__picksongScheduledEvent';
  if (!await page.evaluate((name) => typeof window[name] === 'function', callbackName)) {
    await page.exposeFunction(callbackName, async (raw) => {
      try {
        if (raw.diagnostic) {
          if (raw.diagnostic.chatId === '120363420724758799@g.us' && typeof onDiagnostic === 'function') onDiagnostic(raw.diagnostic);
          return;
        }
        const chatId = raw.id?.remote;
        await onMessage({
          ...raw,
          _data: raw,
          getChat: () => client.getChatById(chatId)
        });
      } catch (error) {
        onWarning(`live_update_failed: ${error.message}`);
      }
    });
  }
  await page.evaluate(({ name, diagnosticsEnabled }) => {
    const collection = window.require('WAWebCollections').Msg;
    const key = '__picksongEventSubscription';
    const previous = window[key];
    if (previous) previous.collection.off(previous.events, previous.handler);
    if (previous?.diagnostics) {
      for (const [event, handler] of previous.diagnostics) previous.collection.off(event, handler);
    }
    // Newer WhatsApp models emit aggregate changes without the individual
    // change:event* signals. Read the original event model on any change.
    const events = 'add change';
    const messageKey = (id) => typeof id === 'string' ? id : id?._serialized || id?.id;
    const handler = (message) => {
      // A decrypted edit is a separate protocol message, not a new event.
      // Its original event model is observed through the change listener.
      if (message.type === 'protocol') return;
      if (message.type !== 'revoked' && message.type !== 'event_creation' && !message.eventStartTime) return;
      // Pass only event fields; no message secrets or unrelated chat content.
      const id = message.id;
      const remote = typeof id?.remote === 'string' ? id.remote : id?.remote?._serialized;
      if (!remote?.endsWith('@g.us')) return;
      const raw = {
        type: message.type,
        protocolMessageKey: messageKey(message.protocolMessageKey),
        id: { _serialized: messageKey(id), remote },
        fromMe: Boolean(id.fromMe),
        from: remote,
        to: remote,
        body: message.eventName ?? message.body ?? '',
        eventName: message.eventName,
        eventStartTime: message.eventStartTime,
        eventDescription: message.eventDescription,
        eventLocation: message.eventLocation ? { name: message.eventLocation.name } : null,
        isEventCanceled: message.isEventCanceled ?? message.isEventCaneled
      };
      // The Node callback handles persistence errors. Catch bridge failures too
      // so a page reload cannot create an unhandled rejection in WhatsApp.
      Promise.resolve(window[name](raw)).catch((error) => {
        console.warn(`[event_sync] bridge_failed: ${error.message}`);
      });
    };
    collection.on(events, handler);
    // System notifications and revocations can omit eventStartTime altogether.
    // Observe their shapes in TestMyBot without parsing them as full events or
    // inferring cancellation from a local removal/cache eviction.
    const diagnostics = (diagnosticsEnabled ? ['add', 'change', 'remove'] : []).map((source) => {
      const diagnosticHandler = (message) => {
        const id = message.id;
        const chatId = typeof id?.remote === 'string' ? id.remote : id?.remote?._serialized;
        if (chatId !== '120363420724758799@g.us') return;
        if (message.type === 'chat' && !message.eventStartTime && source !== 'remove') return;
        const diagnostic = {
          mode: 'log_only', source, chatId, id: messageKey(id),
          type: message.type, subtype: message.subtype,
          isNotification: Boolean(message.isNotification),
          eventName: message.eventName, eventStartTime: message.eventStartTime,
          eventEndTime: message.eventEndTime,
          eventDescription: message.eventDescription,
          eventLocation: message.eventLocation?.name,
          isEventCanceled: message.isEventCanceled ?? message.isEventCaneled,
          // Keys only: never dump bodies, participants, secrets or raw payloads.
          fields: Object.keys(message.attributes || message).filter(field => /event|parent|target|protocol|revoke|delete/i.test(field)).sort(),
          changedFields: Object.keys(message.changed || {}).sort(),
          protocolMessageKey: messageKey(message.protocolMessageKey)
        };
        Promise.resolve(window[name]({ diagnostic })).catch((error) => {
          console.warn(`[event_sync] diagnostic_bridge_failed: ${error.message}`);
        });
      };
      collection.on(source, diagnosticHandler);
      return [source, diagnosticHandler];
    });
    window[key] = { collection, events, handler, diagnostics };
  }, { name: callbackName, diagnosticsEnabled: typeof onDiagnostic === 'function' });
}

module.exports = { installScheduledEventListener };
