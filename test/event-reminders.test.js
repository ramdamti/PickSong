const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getReminderAt,
  formatEventReminder,
  sendDueEventReminders,
  eventFromWhatsAppMessage,
  upsertEvent
} = require('../src/event-reminders');

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

test('formatEventReminder includes the rehearsal details', () => {
  const text = formatEventReminder({
    title: 'חזרת להקה', start_at: '2026-10-10T17:30:00+03:00', details: 'גרוב, חדר B'
  });
  assert.match(text, /חזרת להקה/);
  assert.match(text, /גרוב, חדר B/);
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
