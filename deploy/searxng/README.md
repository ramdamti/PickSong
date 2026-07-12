# SearXNG for PickSong

This folder contains a minimal local SearXNG setup for the chord finder.

## Run

From this directory:

```bash
docker compose -f compose.yml up -d
```

## Check logs

```bash
docker compose -f compose.yml logs -f
```

## Stop

```bash
docker compose -f compose.yml down
```

## Quick health check

```bash
curl "http://127.0.0.1:8080/search?q=test&format=json&pageno=1"
```

## Notes

- The service binds only to `127.0.0.1:8080`.
- JSON output must stay enabled under `search.formats`.
- Update `server.secret_key` before using this in a real environment.
