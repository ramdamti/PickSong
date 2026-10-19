const test = require('node:test');
const assert = require('node:assert/strict');

const { messageToRecord, readQuotedMessage } = require('../src/whatsapp');
const { installScheduledEventListener } = require('../src/event-listener');
const { eventFromWhatsAppMessage } = require('../src/event-reminders');
const vm = require('node:vm');

function listenerHarness() {
  const emitter = new (require('node:events').EventEmitter)();
  const collection = {
    on(events, handler) { for (const name of events.split(' ')) emitter.on(name, handler); },
    off(events, handler) { for (const name of events.split(' ')) emitter.off(name, handler); }
  };
  const window = { require: () => ({ Msg: collection }) };
  const pending = [];
  const client = {
    pupPage: {
      async evaluate(fn, arg) { return vm.runInNewContext(`(${fn.toString()})(arg)`, { window, arg, console }); },
      async exposeFunction(name, fn) {
        window[name] = (raw) => {
          const promise = fn(raw);
          pending.push(promise);
          return promise;
        };
      }
    },
    async getChatById(id) { return { isGroup: true, id: { _serialized: id } }; }
  };
  const message = {
    type: 'event_creation',
    id: { _serialized: 'false_123@g.us_event', remote: { _serialized: '123@g.us' }, fromMe: false },
    eventName: 'Rehearsal', eventStartTime: 1790514000,
    eventLocation: { name: 'Room A' }, messageSecret: 'must not cross the bridge'
  };
  return { client, emitter, message, pending, window };
}

test('scheduled event bridge receives additions and non-text edits with stable group and event ids', async () => {
  const h = listenerHarness();
  const received = [];
  await installScheduledEventListener(h.client, async (message) => {
    assert.equal(messageToRecord(message).chatId, '123@g.us');
    assert.equal((await message.getChat()).id._serialized, '123@g.us');
    assert.equal(message._data.messageSecret, undefined);
    received.push(eventFromWhatsAppMessage(message));
  });
  h.emitter.emit('add', h.message);
  h.message.eventStartTime += 3600;
  h.emitter.emit('change:eventStartTime', h.message);
  h.message.eventLocation = { name: 'Room B' };
  h.emitter.emit('change:eventLocation', h.message);
  h.message.isEventCanceled = true;
  h.emitter.emit('change:isEventCanceled', h.message);
  await Promise.all(h.pending);
  assert.equal(received.length, 4);
  assert.equal(new Set(received.map(event => event.id)).size, 1);
  assert.notEqual(received[0].start_at, received[1].start_at);
  assert.equal(received[2].details, 'Room B');
  assert.equal(received[3].cancelled, true);
});

test('scheduled event bridge installation is idempotent and excludes ordinary/private messages', async () => {
  const h = listenerHarness();
  let received = 0;
  const onMessage = async () => { received += 1; };
  await installScheduledEventListener(h.client, onMessage);
  await installScheduledEventListener(h.client, onMessage);
  h.emitter.emit('add', { type: 'chat', body: 'hello' });
  h.emitter.emit('add', { ...h.message, id: { remote: '123@c.us' } });
  h.emitter.emit('add', h.message);
  await Promise.all(h.pending);
  assert.equal(received, 1);
  assert.equal(h.emitter.listenerCount('change:eventLocation'), 1);
});

test('scheduled event bridge reports save failures without rejecting the page callback', async () => {
  const h = listenerHarness();
  const warnings = [];
  await installScheduledEventListener(h.client, async () => { throw new Error('disk unavailable'); }, warning => warnings.push(warning));
  h.emitter.emit('add', h.message);
  await Promise.all(h.pending);
  assert.match(warnings[0], /live_update_failed: disk unavailable/);
});

test('scheduled event listener can be reinstalled after the page context is replaced', async () => {
  const h = listenerHarness();
  let received = 0;
  await installScheduledEventListener(h.client, async () => { received += 1; });
  h.emitter.removeAllListeners();
  delete h.window.__picksongEventSubscription;
  delete h.window.__picksongScheduledEvent;
  await installScheduledEventListener(h.client, async () => { received += 1; });
  h.message.id.fromMe = true;
  h.emitter.emit('add', h.message);
  await Promise.all(h.pending);
  assert.equal(received, 1);
});

test('messageToRecord prefers the group conversation id for incoming group messages', () => {
  const record = messageToRecord({
    fromMe: false,
    from: '972549750400@c.us',
    author: '972549750400@c.us',
    body: 'בוט שיר עם תיפוף קל',
    _data: {
      from: '120363420724758799@g.us',
      to: '972549750400@c.us',
      notifyName: 'Member'
    },
    id: {
      _serialized: 'wamid.test',
      remote: '972549750400@c.us'
    }
  });

  assert.equal(record.chatId, '120363420724758799@g.us');
  assert.equal(record.from, '972549750400@c.us');
});

test('messageToRecord still uses the destination chat for outgoing messages', () => {
  const record = messageToRecord({
    fromMe: true,
    to: '120363420724758799@g.us',
    from: '972549750400@c.us',
    body: '🤖 הבאתי שיר',
    _data: {
      from: '972549750400@c.us',
      to: '120363420724758799@g.us'
    },
    id: {
      _serialized: 'wamid.outgoing',
      remote: '120363420724758799@g.us'
    }
  });

  assert.equal(record.chatId, '120363420724758799@g.us');
});

test('readQuotedMessage falls back to raw quoted data for outgoing reply messages', async () => {
  const quoted = await readQuotedMessage({
    hasQuotedMsg: true,
    _data: {
      quotedStanzaID: 'wamid.bot-list',
      quotedParticipant: '61143188005088@lid',
      quotedMsg: {
        body: '\u200f🤖 easy - Faith No More'
      }
    },
    async getQuotedMessage() {
      throw new Error('quoted fetch unavailable');
    }
  });

  assert.deepEqual(quoted, {
    id: 'wamid.bot-list',
    text: '\u200f🤖 easy - Faith No More',
    fromMe: null,
    author: '61143188005088@lid'
  });
});

test('readQuotedMessage keeps raw reply context when hasQuotedMsg is false', async () => {
  const quoted = await readQuotedMessage({
    hasQuotedMsg: false,
    _data: {
      quotedStanzaID: 'wamid.bot-question',
      quotedMsg: { body: '\u200f🤖 מי המבצע של "Its Probably Me"?' }
    }
  });

  assert.deepEqual(quoted, {
    id: 'wamid.bot-question',
    text: '\u200f🤖 מי המבצע של "Its Probably Me"?',
    fromMe: null,
    author: null
  });
});

test('readQuotedMessage keeps a quoted YouTube preview', async () => {
  const quoted = await readQuotedMessage({
    hasQuotedMsg: false,
    _data: {
      quotedStanzaID: 'wamid.youtube',
      quotedMsg: {
        body: 'https://youtu.be/abc123',
        title: 'Pink Floyd - Coming Back to Life',
        description: 'Official video'
      }
    }
  });

  assert.equal(quoted.linkPreview.title, 'Pink Floyd - Coming Back to Life');
  assert.equal(quoted.linkPreview.description, 'Official video');
});
