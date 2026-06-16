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
