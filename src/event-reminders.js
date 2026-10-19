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
    cancelled: Boolean(event.cancelled || event.deleted),
    ...(event.deleted ? { deleted: true } : {})
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
    group_id: String(source.group_id || '').trim() || null,
    time_zone: String(source.time_zone || REMINDER_TIME_ZONE).trim() || REMINDER_TIME_ZONE,
    events: Array.isArray(source.events) ? source.events.map(normalizeEvent).filter(Boolean) : [],
    sent
  };
}

function eventFromWhatsAppMessage(message) {
  const raw = message?._data || {};
  // Edits have their own message id. Never insert them as separate events;
  // the live listener observes the updated original event model instead.
  const type = message?.type ?? raw.type;
  if (type === 'protocol' || type === 'revoked') return null;
  const startSeconds = Number(message?.eventStartTime ?? raw.eventStartTime);
  const start = Number.isFinite(startSeconds) && startSeconds > 0
    ? new Date(startSeconds * 1000)
    : null;
  const id = String(message?.id?._serialized || message?.id?.id || raw.id?._serialized || raw.id?.id || '').trim();
  const title = String(raw.eventName ?? message?.eventName ?? message?.body ?? raw.body ?? '').trim();
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
    index = normalized.events.findIndex((item) => /^(imported-|rehearsal-)/.test(item.id) && item.title === event.title && item.start_at === event.start_at);
  }
  const existing = index >= 0 ? normalized.events[index] : null;
  // A delayed event snapshot must not resurrect a deleted event.
  if (existing?.deleted) return { schedule: normalized, changed: false, event: existing };
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

function eventDeletionFromMessage(message) {
  const raw = message?._data || message || {};
  if ((message?.type ?? raw.type) !== 'revoked') return null;
  const key = raw.protocolMessageKey ?? message?.protocolMessageKey ?? message?.id ?? raw.id;
  const id = typeof key === 'string' ? key : key?._serialized || key?.id;
  if (!id) return null;
  // Some revocations retain the original fields; these can identify a unique
  // manually imported event whose WhatsApp id has not been adopted yet.
  const original = eventFromWhatsAppMessage({
    ...message, type: 'event_creation', id: { _serialized: id },
    _data: { ...raw, type: 'event_creation' }
  });
  const ownKey = message?.id ?? raw.id;
  const revocationId = typeof ownKey === 'string' ? ownKey : ownKey?._serialized || ownKey?.id;
  return { id, original, revocationId };
}

function deleteScheduledEvent(schedule, deletion) {
  const normalized = normalizeSchedule(schedule);
  const stanzaId = (id) => /^(true|false)_/.test(id) ? id.split('_')[2] : id;
  let matches = normalized.events.filter(item => stanzaId(item.id) === stanzaId(deletion.id));
  if (!matches.length && deletion.original) {
    matches = normalized.events.filter(item => /^(imported-|rehearsal-)/.test(item.id) &&
      item.title === deletion.original.title && item.start_at === deletion.original.start_at);
  }
  // Never guess by title alone, or insert a revocation as a new rehearsal.
  if (matches.length !== 1) return { schedule: normalized, changed: false, event: null };
  const event = matches[0];
  let changed = !event.deleted;
  event.cancelled = true;
  event.deleted = true;
  // WhatsApp can briefly expose the revocation under a new id while retaining
  // event_creation and all original fields, before changing type to revoked.
  // Retire only that explicitly linked alias, never unrelated matching titles.
  if (deletion.revocationId && stanzaId(deletion.revocationId) !== stanzaId(deletion.id)) {
    const alias = normalized.events.find(item => stanzaId(item.id) === stanzaId(deletion.revocationId));
    if (alias && alias.title === event.title && alias.start_at === event.start_at) {
      changed ||= !alias.deleted;
      alias.cancelled = true;
      alias.deleted = true;
    }
  }
  return { schedule: normalized, changed, event };
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
  const temporaryPath = `${filePath}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(normalizeSchedule(schedule), null, 2)}\n`, 'utf8');
  await fs.rename(temporaryPath, filePath);
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
  const nextEvent = normalized.events
    .filter((event) => !event.cancelled && new Date(event.start_at).getTime() > now.getTime())
    .sort((left, right) => new Date(left.start_at) - new Date(right.start_at))[0];
  const due = [];
  for (const event of normalized.events) {
    if (event.cancelled || normalized.sent[event.id]) continue;
    // A rehearsal reminder must always describe the next rehearsal, rather
    // than a later event whose two-day window happens to overlap it.
    if (!nextEvent || event.id !== nextEvent.id) continue;
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
  eventDeletionFromMessage,
  deleteScheduledEvent,
  loadEventSchedule,
  saveEventSchedule,
  getReminderAt,
  formatEventReminder,
  sendDueEventReminders
};
