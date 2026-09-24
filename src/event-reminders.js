const fs = require('fs/promises');

const REMINDER_TIME_ZONE = 'Asia/Jerusalem';
const REMINDER_HOUR = 20;
const REMINDER_GRACE_MS = 5 * 60 * 1000;

function datePartsAt(date, timeZone = REMINDER_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.year), month: Number(values.month), day: Number(values.day),
    hour: Number(values.hour), minute: Number(values.minute), second: Number(values.second)
  };
}

function timeZoneOffsetMs(date, timeZone) {
  const parts = datePartsAt(date, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - date.getTime();
}

function zonedDateTimeToUtc(parts, timeZone = REMINDER_TIME_ZONE) {
  const guessedUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second || 0);
  let result = new Date(guessedUtc - timeZoneOffsetMs(new Date(guessedUtc), timeZone));
  // Re-evaluate once so daylight-saving changes around the target date use
  // the target offset rather than the offset at the initial UTC guess.
  result = new Date(guessedUtc - timeZoneOffsetMs(result, timeZone));
  return result;
}

function normalizeEvent(raw) {
  const event = raw && typeof raw === 'object' ? raw : {};
  const id = String(event.id || '').trim();
  const title = String(event.title || '').trim();
  const startAt = String(event.start_at || '').trim();
  const start = new Date(startAt);
  if (!id || !title || Number.isNaN(start.getTime())) return null;
  return {
    id,
    title,
    start_at: start.toISOString(),
    details: String(event.details || '').trim() || null,
    cancelled: Boolean(event.cancelled)
  };
}

function normalizeSchedule(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const sent = source.sent && typeof source.sent === 'object' && !Array.isArray(source.sent)
    ? Object.fromEntries(Object.entries(source.sent).filter(([key, value]) => key && typeof value === 'string'))
    : {};
  return {
    version: 1,
    group_name: String(source.group_name || '').trim(),
    time_zone: String(source.time_zone || REMINDER_TIME_ZONE).trim() || REMINDER_TIME_ZONE,
    events: Array.isArray(source.events) ? source.events.map(normalizeEvent).filter(Boolean) : [],
    sent
  };
}

function eventFromWhatsAppMessage(message) {
  const raw = message?._data || {};
  const startSeconds = Number(message?.eventStartTime ?? raw.eventStartTime);
  const start = Number.isFinite(startSeconds) && startSeconds > 0
    ? new Date(startSeconds * 1000)
    : null;
  const id = String(message?.id?._serialized || message?.id?.id || raw.id?._serialized || raw.id?.id || '').trim();
  const title = String(message?.body || raw.eventName || '').trim();
  if (!id || !title || !start || Number.isNaN(start.getTime())) return null;
  const location = raw.eventLocation?.name || message?.eventLocation?.name || '';
  const description = raw.eventDescription || message?.eventDescription || '';
  return normalizeEvent({
    id,
    title,
    start_at: start.toISOString(),
    details: [description, location].map((value) => String(value || '').trim()).filter(Boolean).join(' | ') || null,
    cancelled: Boolean(raw.isEventCanceled ?? raw.isEventCaneled ?? message?.isEventCanceled ?? message?.isEventCaneled)
  });
}

function upsertEvent(schedule, rawEvent) {
  const normalized = normalizeSchedule(schedule);
  const event = normalizeEvent(rawEvent);
  if (!event) return { schedule: normalized, changed: false, event: null };
  // Events imported before live synchronization have local ids. When their
  // WhatsApp message is first observed, adopt its id instead of retaining a
  // duplicate reminder for the same title and start time.
  let index = normalized.events.findIndex((item) => item.id === event.id);
  if (index < 0) {
    index = normalized.events.findIndex((item) => item.title === event.title && item.start_at === event.start_at);
  }
  const existing = index >= 0 ? normalized.events[index] : null;
  const changed = !existing || JSON.stringify(existing) !== JSON.stringify(event);
  if (!changed) return { schedule: normalized, changed: false, event };
  if (index >= 0) normalized.events[index] = event;
  else normalized.events.push(event);
  // An edit changes the schedule or cancellation state. Permit a future
  // reminder for the updated event even if an older version was sent.
  delete normalized.sent[event.id];
  if (existing?.id && existing.id !== event.id) delete normalized.sent[existing.id];
  return { schedule: normalized, changed: true, event };
}

async function loadEventSchedule(filePath) {
  try {
    return normalizeSchedule(JSON.parse(await fs.readFile(filePath, 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') return normalizeSchedule({});
    throw error;
  }
}

async function saveEventSchedule(filePath, schedule) {
  await fs.writeFile(filePath, `${JSON.stringify(normalizeSchedule(schedule), null, 2)}\n`, 'utf8');
}

function getReminderAt(event, timeZone = REMINDER_TIME_ZONE) {
  const startParts = datePartsAt(new Date(event.start_at), timeZone);
  const twoDaysEarlier = new Date(Date.UTC(startParts.year, startParts.month - 1, startParts.day - 2));
  return zonedDateTimeToUtc({
    year: twoDaysEarlier.getUTCFullYear(),
    month: twoDaysEarlier.getUTCMonth() + 1,
    day: twoDaysEarlier.getUTCDate(),
    hour: REMINDER_HOUR,
    minute: 0,
    second: 0
  }, timeZone);
}

function formatEventReminder(event, timeZone = REMINDER_TIME_ZONE) {
  const start = new Date(event.start_at);
  const date = new Intl.DateTimeFormat('he-IL', {
    timeZone, weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).format(start);
  return `תזכורת: ${event.title} ב־${date}${event.details ? ` — ${event.details}` : ''}.`;
}

async function sendDueEventReminders({ schedule, now = new Date(), send }) {
  const normalized = normalizeSchedule(schedule);
  const due = [];
  for (const event of normalized.events) {
    if (event.cancelled || normalized.sent[event.id]) continue;
    const reminderAt = getReminderAt(event, normalized.time_zone);
    const elapsed = now.getTime() - reminderAt.getTime();
    if (elapsed < 0 || elapsed > REMINDER_GRACE_MS) continue;
    await send(formatEventReminder(event, normalized.time_zone), event);
    normalized.sent[event.id] = now.toISOString();
    due.push(event);
  }
  return { schedule: normalized, due };
}

module.exports = {
  REMINDER_TIME_ZONE,
  REMINDER_HOUR,
  normalizeSchedule,
  eventFromWhatsAppMessage,
  upsertEvent,
  loadEventSchedule,
  saveEventSchedule,
  getReminderAt,
  formatEventReminder,
  sendDueEventReminders
};
