// Keep the private WhatsApp Web integration isolated: if it changes, startup
// still succeeds, but field changes may be missed until the listener recovers.
async function installScheduledEventListener(client, onMessage, onWarning = () => {}) {
  const page = client.pupPage;
  if (!page) throw new Error('WhatsApp page is unavailable');
  const callbackName = '__picksongScheduledEvent';
  if (!await page.evaluate((name) => typeof window[name] === 'function', callbackName)) {
    await page.exposeFunction(callbackName, async (raw) => {
      try {
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
  await page.evaluate((name) => {
    const collection = window.require('WAWebCollections').Msg;
    const key = '__picksongEventSubscription';
    const previous = window[key];
    if (previous) previous.collection.off(previous.events, previous.handler);
    const events = 'add change:type change:body change:eventName change:eventStartTime ' +
      'change:eventEndTime change:eventDescription change:eventLocation ' +
      'change:isEventCanceled change:isEventCaneled';
    const handler = (message) => {
      if (message.type !== 'event_creation' && !message.eventStartTime) return;
      // Pass only event fields; no message secrets or unrelated chat content.
      const id = message.id;
      const remote = typeof id?.remote === 'string' ? id.remote : id?.remote?._serialized;
      if (!remote?.endsWith('@g.us')) return;
      const raw = {
        id: { _serialized: id._serialized, remote },
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
    window[key] = { collection, events, handler };
  }, callbackName);
}

module.exports = { installScheduledEventListener };
