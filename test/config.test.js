const test = require('node:test');
const assert = require('node:assert/strict');

const { loadConfig } = require('../src/config');

test('discover_chords env flag is parsed from .env style input', () => {
  const config = loadConfig(
    {
      GROUP_NAME: 'Band',
      discover_chords: 'false'
    },
    {
      requireGroupName: true
    }
  );

  assert.equal(config.groupName, 'Band');
  assert.deepEqual(config.groupNames, ['Band']);
  assert.equal(config.discoverChords, false);
});

test('DISCOVER_CHORDS overrides the lowercase env key', () => {
  const config = loadConfig(
    {
      GROUP_NAME: 'Band',
      discover_chords: 'false',
      DISCOVER_CHORDS: 'true'
    },
    {
      requireGroupName: true
    }
  );

  assert.equal(config.discoverChords, true);
});

test('GROUP_ID is loaded when provided', () => {
  const config = loadConfig(
    {
      GROUP_NAME: 'Band',
      GROUP_ID: '120363420724758799@g.us'
    },
    {
      requireGroupName: true
    }
  );

  assert.equal(config.groupId, '120363420724758799@g.us');
  assert.deepEqual(config.groupIds, ['120363420724758799@g.us']);
});

test('GROUP_NAMES and GROUP_IDS are parsed as comma-separated target lists', () => {
  const config = loadConfig(
    {
      GROUP_NAME: '',
      GROUP_ID: '',
      GROUP_NAMES: 'Band A, Band B',
      GROUP_IDS: '1201@g.us, 1202@g.us'
    },
    {
      requireGroupName: true
    }
  );

  assert.deepEqual(config.groupNames, ['Band A', 'Band B']);
  assert.deepEqual(config.groupIds, ['1201@g.us', '1202@g.us']);
});
