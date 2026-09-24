const test = require('node:test');
const assert = require('node:assert/strict');

const { messageToRecord, readQuotedMessage } = require('../src/whatsapp');

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
