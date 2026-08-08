const test = require('node:test');
const assert = require('node:assert/strict');

const { messageToRecord } = require('../src/whatsapp');

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
