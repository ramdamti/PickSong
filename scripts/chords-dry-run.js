#!/usr/bin/env node
const fs = require('fs/promises');
const path = require('path');
const { loadConfig } = require('../src/config');
const { searchForChordsUrlWithDebug } = require('../src/chords');

function printUsage() {
  console.log('Usage: node scripts/chords-dry-run.js <input.json>');
  console.log('');
  console.log('Input may be:');
  console.log('- a single song object');
  console.log('- an array of song objects');
  console.log('- an object with a songs array');
}

function normalizeInput(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object' && Array.isArray(data.songs)) {
    return data.songs;
  }
  if (data && typeof data === 'object') return [data];
  return [];
}

function formatSongLabel(song) {
  const title = String(song?.song_title || '').trim();
  const artist = String(song?.artist || '').trim();
  return title && artist ? `${title} - ${artist}` : title || artist || '(unknown song)';
}

function normalizeHost(host) {
  return String(host || '').trim().toLowerCase();
}

function formatDecision(item) {
  if (!item) return 'unknown';
  if (item.rejectReason) return item.rejectReason;
  return 'allowed';
}

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath || inputPath === '--help' || inputPath === '-h') {
    printUsage();
    process.exit(inputPath ? 0 : 1);
  }

  const resolvedPath = path.resolve(inputPath);
  const content = await fs.readFile(resolvedPath, 'utf8');
  const parsed = JSON.parse(content);
  const songs = normalizeInput(parsed);
  const config = loadConfig(process.env, { requireGroupName: false });

  if (songs.length === 0) {
    throw new Error('No songs found in input JSON');
  }

  const renderSong = async (song) => {
    const debug = await searchForChordsUrlWithDebug(song, global.fetch, config);
    const lines = [];
    lines.push(`Input: ${formatSongLabel(song)}`);
    lines.push(`Search backend: ${debug.search_backend || 'SearXNG'}`);
    lines.push(`SearXNG URL: ${debug.searxng_url || 'http://127.0.0.1:8080'}`);

    for (const item of debug.query_diagnostics || []) {
      lines.push(`Query: ${item.query}`);
      lines.push(`SearXNG results returned: ${item.resultsReturned || 0}`);
      if (item.error) {
        lines.push(`Search error: ${item.error}`);
      }
      const queryItems = (debug.candidate_diagnostics || []).filter((candidate) => candidate.query === item.query);
      for (const candidate of queryItems) {
        lines.push(`- Title: ${candidate.title || '(empty)'}`);
        lines.push(`  URL: ${candidate.url || '(empty)'}`);
        lines.push(`  Engine: ${candidate.engine || '(unknown)'}`);
        lines.push(`  Decision: ${formatDecision(candidate)}`);
      }
    }

    lines.push(`Search results received: ${debug.search_results_received || 0}`);
    lines.push(`Unsupported hosts skipped: ${debug.unsupported_hosts_skipped || 0}`);
    lines.push(`Duplicates skipped: ${debug.duplicate_urls_skipped || 0}`);
    lines.push(`Allowed candidates inspected: ${debug.allowed_candidates_inspected || 0}`);

    if (debug.chords_url) {
      lines.push('Result: FOUND');
      lines.push(`URL: ${debug.chords_url}`);
      if (debug.page_type) {
        lines.push(`Page type: ${debug.page_type}`);
      }
      if (debug.page_type_reason) {
        lines.push(`Page type reason: ${debug.page_type_reason}`);
      }
    } else {
      lines.push('Result: NOT FOUND');
      lines.push(`Rejected: ${debug.reason || 'no candidate found'}`);
      if (debug.rejected_host) {
        lines.push(`Host: ${debug.rejected_host}`);
      }
      if (debug.page_type) {
        lines.push(`Page type: ${debug.page_type}`);
      }
      if (debug.page_type_reason) {
        lines.push(`Page type reason: ${debug.page_type_reason}`);
      }
      if (debug.search_error) {
        lines.push(`Search error: ${debug.search_error}`);
      }

      const unsupportedHosts = new Map();
      for (const item of debug.candidate_diagnostics || []) {
        if (item.rejectReason !== 'unsupported host') continue;
        const host = normalizeHost(item.host);
        unsupportedHosts.set(host, (unsupportedHosts.get(host) || 0) + 1);
      }
      if (unsupportedHosts.size > 0) {
        lines.push('Unsupported hosts:');
        for (const [host, count] of unsupportedHosts.entries()) {
          lines.push(`- ${host}: ${count}`);
        }
      }
    }

    lines.push('');
    return lines.join('\n');
  };

  const outputs = await Promise.all(songs.map((song) => renderSong(song)));

  process.stdout.write(`${outputs.join('\n').trim()}\n`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
