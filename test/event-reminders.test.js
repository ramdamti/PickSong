const test = require('node:test');
const assert = require('node:assert/strict');
const { isScheduleChat, refreshScheduledEvents, createEventTaskQueue, logTestEvent } = require('../src/event-sync');

test('test-group event diagnostics include edits and cancellations without capturing production events', () => {
  const lines = [];
  const event = Object.freeze({ id: 'test-event', title: 'Test', start_at: '2026-11-07T16:00:00.000Z', details: 'Room B', cancelled: true });
  const input = { event, source: 'event_change', log: line => lines.push(line) };
  assert.equal(logTestEvent({ ...input, chatId: '120363420724758799@g.us' }), true);
  assert.equal(logTestEvent({ ...input, chatId: '120363245259281935@g.us' }), false);
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0].replace('[event_sync_test] ', ''));
  assert.equal(record.mode, 'log_only');
  assert.equal(record.source, 'event_change');
  assert.equal(record.cancelled, true);
  assert.equal(record.details, 'Room B');
});

const {
  getReminderAt,
  formatEventReminder,
  sendDueEventReminders,
  eventFromWhatsAppMessage,
  upsertEvent
} = require('../src/event-reminders');

const syncGroupId = '123@g.us';
function eventMessage(id, overrides = {}) {
  return {
    id: { _serialized: id },
    _data: { eventName: 'Rehearsal', eventStartTime: 1790514000, ...overrides }
  };
}

test('schedule group id survives renames and rejects a different group with the same name', () => {
  const schedule = { group_id: syncGroupId, group_name: 'Band' };
  assert.equal(isScheduleChat(schedule, { isGroup: true, id: { _serialized: syncGroupId }, name: 'Renamed' }), true);
  assert.equal(isScheduleChat(schedule, { isGroup: true, id: { _serialized: 'other@g.us' }, name: 'Band' }), false);
});

test('history sync discovers offline events even when the schedule is empty and is idempotent', async () => {
  const chat = {
    isGroup: true, id: { _serialized: syncGroupId },
    async fetchMessages({ limit }) {
      assert.equal(limit, 250);
      return [{ body: 'ordinary message' }, eventMessage('false_123@g.us_new')];
    }
  };
  const first = await refreshScheduledEvents({ client: {}, chat, schedule: { group_id: syncGroupId, events: [] } });
  assert.equal(first.changed, true);
  assert.equal(first.schedule.events.length, 1);
  first.schedule.sent[first.schedule.events[0].id] = 'already-sent';
  const second = await refreshScheduledEvents({ client: {}, chat, schedule: first.schedule });
  assert.equal(second.changed, false);
  assert.equal(second.schedule.sent[first.schedule.events[0].id], 'already-sent');
});

test('polling refreshes older events outside recent history, including time, location and cancellation', async () => {
  const id = 'false_123@g.us_old';
  const original = eventFromWhatsAppMessage(eventMessage(id));
  const chat = { isGroup: true, id: { _serialized: syncGroupId }, async fetchMessages() { return []; } };
  const result = await refreshScheduledEvents({
    chat, schedule: { group_id: syncGroupId, events: [original], sent: { [id]: 'sent' } },
    client: { async getMessageById(messageId) {
      assert.equal(messageId, id);
      return eventMessage(id, { eventStartTime: 1790600400, eventLocation: { name: 'Room E' }, isEventCanceled: true });
    } }
  });
  assert.equal(result.schedule.events.length, 1);
  assert.notEqual(result.schedule.events[0].start_at, original.start_at);
  assert.equal(result.schedule.events[0].details, 'Room E');
  assert.equal(result.schedule.events[0].cancelled, true);
  assert.equal(result.schedule.sent[id], undefined);
});

test('incomplete history and individual fetch failures do not remove existing events', async () => {
  const original = eventFromWhatsAppMessage(eventMessage('false_123@g.us_old'));
  const warnings = [];
  const result = await refreshScheduledEvents({
    chat: { isGroup: true, id: { _serialized: syncGroupId }, async fetchMessages() { return []; } },
    schedule: { group_id: syncGroupId, events: [original] },
    client: { async getMessageById() { throw new Error('unavailable'); } },
    onWarning: (warning) => warnings.push(warning)
  });
  assert.deepEqual(result.schedule.events, [original]);
  assert.equal(result.changed, false);
  assert.equal(warnings.length, 1);
});

test('event writes and reminder checks are serialized and a failed task does not block subsequent updates', async () => {
  const queue = createEventTaskQueue();
  const steps = [];
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const first = queue(async () => { steps.push('first'); await blocked; steps.push('saved'); });
  const failed = queue(async () => { steps.push('failed'); throw new Error('write failed'); });
  const rejection = assert.rejects(failed, /write failed/);
  const last = queue(async () => { steps.push('last'); });
  await Promise.resolve();
  assert.deepEqual(steps, ['first']);
  release();
  await Promise.all([first, rejection, last]);
  assert.deepEqual(steps, ['first', 'saved', 'failed', 'last']);
});

test('getReminderAt schedules 20:00 Israel time two calendar days before a rehearsal', () => {
  const reminderAt = getReminderAt({ start_at: '2026-09-26T17:00:00+03:00' });
  assert.equal(reminderAt.toISOString(), '2026-09-24T17:00:00.000Z');
});

test('getReminderAt keeps 20:00 Israel time after daylight saving time ends', () => {
  const reminderAt = getReminderAt({ start_at: '2026-11-07T18:00:00+02:00' });
  assert.equal(reminderAt.toISOString(), '2026-11-05T18:00:00.000Z');
});

test('sendDueEventReminders sends once and persists its sent marker', async () => {
  const messages = [];
  const schedule = {
    group_name: 'The Imagine Sessions',
    time_zone: 'Asia/Jerusalem',
    events: [{
      id: 'rehearsal-1', title: 'חזרת להקה',
      start_at: '2026-09-26T17:00:00+03:00', details: 'גרוב, חדר E'
    }],
    sent: {}
  };
  const now = new Date('2026-09-24T17:00:00.000Z');

  const first = await sendDueEventReminders({
    schedule, now,
    send: async (text) => messages.push(text)
  });
  const second = await sendDueEventReminders({
    schedule: first.schedule, now,
    send: async (text) => messages.push(text)
  });

  assert.equal(first.due.length, 1);
  assert.equal(second.due.length, 0);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /חזרת להקה/);
  assert.match(messages[0], /גרוב, חדר E/);
  assert.equal(first.schedule.sent['rehearsal-1'], now.toISOString());
});

test('sendDueEventReminders only announces the next future rehearsal', async () => {
  const messages = [];
  const now = new Date('2026-10-08T17:00:00.000Z'); // 20:00 Israel time
  const result = await sendDueEventReminders({
    schedule: {
      time_zone: 'Asia/Jerusalem',
      events: [
        { id: 'next', title: 'חזרת להקה', start_at: '2026-10-09T17:00:00.000Z', details: 'חדר A' },
        { id: 'later', title: 'חזרת להקה', start_at: '2026-10-10T17:00:00.000Z', details: 'חדר B' }
      ],
      sent: {}
    },
    now,
    send: async (text) => messages.push(text)
  });

  assert.equal(result.due.length, 0);
  assert.equal(messages.length, 0);
});

test('formatEventReminder includes the rehearsal details', () => {
  const text = formatEventReminder({
    title: 'חזרת להקה', start_at: '2026-10-10T17:30:00+03:00', details: 'גרוב, חדר B'
  });
  assert.match(text, /חזרת להקה/);
  assert.match(text, /גרוב, חדר B/);
  assert.match(text, /17:30/);
});

test('WhatsApp event updates replace the event and reset its sent marker', () => {
  const event = eventFromWhatsAppMessage({
    id: { _serialized: 'event-message-1' }, body: 'חזרת להקה', eventStartTime: 1790514000,
    _data: { eventDescription: 'גרוב', eventLocation: { name: 'חדר B' } }
  });
  const first = upsertEvent({ group_name: 'The Imagine Sessions', events: [], sent: {} }, event);
  const updated = upsertEvent({
    ...first.schedule,
    sent: { 'event-message-1': '2026-09-24T17:00:00.000Z' }
  }, { ...event, details: 'גרוב | חדר E' });

  assert.equal(first.changed, true);
  assert.equal(updated.changed, true);
  assert.equal(updated.schedule.events[0].details, 'גרוב | חדר E');
  assert.equal(updated.schedule.sent['event-message-1'], undefined);
});

test('WhatsApp event adopts an imported event with the same title and start time', () => {
  const importedId = 'rehearsal-2026-10-10';
  const startAt = '2026-10-10T14:30:00.000Z';
  const result = upsertEvent({
    group_name: 'The Imagine Sessions',
    events: [{ id: importedId, title: 'חזרת להקה', start_at: startAt, details: 'גרוב, חדר B' }],
    sent: { [importedId]: '2026-10-08T17:00:00.000Z' }
  }, {
    id: 'whatsapp-event-id', title: 'חזרת להקה', start_at: startAt, details: 'גרוב | חדר B'
  });

  assert.equal(result.changed, true);
  assert.equal(result.schedule.events.length, 1);
  assert.equal(result.schedule.events[0].id, 'whatsapp-event-id');
  assert.equal(result.schedule.sent[importedId], undefined);
});
