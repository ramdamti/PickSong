const { eventFromWhatsAppMessage, upsertEvent } = require('./event-reminders');

const TEST_EVENT_GROUP_ID = '120363420724758799@g.us';

function logTestEvent({ chatId, event, source, log = console.log }) {
  if (chatId !== TEST_EVENT_GROUP_ID) return false;
  log(`[event_sync_test] ${JSON.stringify({
    mode: 'log_only', group: 'TestMyBot', chatId, source,
    id: event.id, title: event.title, start_at: event.start_at,
    details: event.details, cancelled: event.cancelled
  })}`);
  return true;
}

function isScheduleChat(schedule, chat) {
  if (!chat?.isGroup) return false;
  if (schedule.group_id) return chat.id?._serialized === schedule.group_id;
  return Boolean(schedule.group_name) && String(chat.name || '').trim().toLowerCase() ===
    schedule.group_name.trim().toLowerCase();
}

// Scheduled-event edits do not necessarily emit message_edit (which watches
// body/caption). Re-read the original messages as well as recent history.
// Backup scans are bounded; startup and reconnect do not request history.
async function refreshScheduledEvents({ client, chat, schedule, onWarning = () => {} }) {
  if (!isScheduleChat(schedule, chat)) throw new Error('Event sync group does not match the configured group');
  const messages = await chat.fetchMessages({ limit: 250 });
  let next = schedule;
  let changed = false;
  const observedIds = new Set();
  function merge(message) {
    const event = eventFromWhatsAppMessage(message);
    if (!event) return;
    observedIds.add(event.id);
    const result = upsertEvent(next, event);
    next = result.schedule;
    changed ||= result.changed;
  }
  for (const message of messages) merge(message);
  for (const event of next.events) {
    // Imported local ids cannot be fetched from WhatsApp. Never infer deletion
    // from an absent message: linked devices can have incomplete history.
    if (observedIds.has(event.id) || !/^(true|false)_/.test(event.id)) continue;
    try {
      merge(await client.getMessageById(event.id));
    } catch (error) {
      onWarning(`message_refresh_failed id=${event.id}: ${error.message}`);
    }
  }
  return { schedule: next, changed, observed: observedIds.size };
}

function createEventTaskQueue() {
  let pending = Promise.resolve();
  return (task) => {
    const result = pending.then(task);
    pending = result.catch(() => {});
    return result;
  };
}

module.exports = { isScheduleChat, refreshScheduledEvents, createEventTaskQueue, logTestEvent };
