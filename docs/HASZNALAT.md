# OddsAggregator használata

Ez a dokumentum a jelenlegi Linux + Docker Compose üzemeltetést írja le. A
korábbi Windows/PowerShell, fejlesztői és direct/canary futtatók eltávolításra
kerültek.

## Követelmények

- Linux;
- Docker Engine és `docker compose` v2;
- a felhasználó hozzáférése a Docker daemonhoz;
- futó, healthy `pia-gluetun` konténer.

A normál stack minden Node.js- és Chromium-függőséget az image-ben biztosít.
Host Node.js, Chrome, npm vagy Python telepítése nem szükséges. A PIA/Gluetun
konfiguráció nem része ennek a repónak; a projekt a már futó, `pia-gluetun`
nevű konténer hálózati névterét használja.

Ellenőrzés:

```bash
docker compose version
docker info
docker inspect --format '{{.Name}} {{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' pia-gluetun
```

Ha a Docker sockethez nincs hozzáférés, a felhasználót hozzá kell adni a
`docker` csoporthoz, majd új bejelentkezés szükséges:

```bash
sudo usermod -aG docker "$USER"
newgrp docker
```

## Konfiguráció ellenőrzése és indítás

Az image build előtt ellenőrizd a Compose-konfigurációt:

```bash
docker compose -f infra/docker/compose.yml config --quiet
```

Build és indítás:

```bash
docker compose -f infra/docker/compose.yml up -d --build
```

A stack szolgáltatásai:

- `chrome` – headless Chromium CDP-vel, a `9333` porton;
- `tippmixpro` – TippmixPro monitor;
- `sharpx` – SharpX monitor és közös oddslista/surebet kimenet;
- `vegas` – Vegas monitor.

A monitorok a Chrome health állapotára, egymás szükséges snapshotjaira és a
saját output healthcheckjükre támaszkodnak.

## Állapot és naplók

```bash
docker compose -f infra/docker/compose.yml ps
docker compose -f infra/docker/compose.yml logs -f --tail=100
docker compose -f infra/docker/compose.yml logs -f --tail=100 chrome
docker compose -f infra/docker/compose.yml logs -f --tail=100 sharpx
```

Healthcheckek és konténerállapot:

```bash
docker inspect --format '{{.Name}} {{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' \
  oddsaggregator-chrome oddsaggregator-tippmixpro oddsaggregator-sharpx oddsaggregator-vegas
```

## Kimeneti fájlok

A Compose a repó `runtime/data/` könyvtárát mountolja:

- `runtime/data/tippmixpro_odds_snapshot.json`;
- `runtime/data/sharpx_status_snapshot.json`;
- `runtime/data/sharpx_watchlist.json`;
- `runtime/data/combined_odds.txt`;
- `runtime/data/football/surebets_live_odds.txt`;
- `runtime/data/vegas_odds_snapshot.json`.

A fájlokat a monitorok atomikusan frissítik, ezért olvasás közben lockfájlok is
megjelenhetnek. A `data/`, `logs/` és `runtime/` könyvtárak generált állapotot
tartalmaznak, nem a Gitből származó forráskódot.

## Leállítás és újraépítés

Normál leállítás:

```bash
docker compose -f infra/docker/compose.yml down --remove-orphans
```

Csak az image újraépítése és újraindítás:

```bash
docker compose -f infra/docker/compose.yml up -d --build --force-recreate
```

Az output könyvtárak törlése nem része a leállításnak. Generált adatok törlése
előtt készíts mentést, ha a snapshotokra szükség van.

## Környezeti változók

A legfontosabb, Compose-ból felülírható értékek:

| Változó | Alapérték |
|---|---:|
| `MONITOR_STALE_MS` | `120000` |
| `MONITOR_STARTUP_GRACE_MS` | `180000` |
| `MONITOR_POLL_MS` | `10000` |
| `SHARPX_CDP_COMMAND_TIMEOUT_MS` | `60000` |
| `SHARPX_OUTPUT_MIN_COVERAGE_RATIO` | `0.90` |
| `SHARPX_LAST_GOOD_OUTPUT_TTL_MS` | `300000` |
| `SHARPX_WEBSOCKET_HANDSHAKE_TIMEOUT_MS` | `10000` |
| `SHARPX_WEBSOCKET_FRAME_TIMEOUT_MS` | `30000` |
| `SHARPX_WEBSOCKET_RECONNECT_BASE_MS` | `1000` |
| `SHARPX_WEBSOCKET_RECONNECT_MAX_MS` | `10000` |
| `SHARPX_ALL_SOCKET_RECOVERY_MS` | `30000` |
| `VEGAS_LIVE_REQUEST_BUDGET_MS` | `4500` |
| `VEGAS_LIVE_FAILURE_BACKOFF_MS` | `1000` |
| `VEGAS_LIVE_FAILURE_BACKOFF_MAX_MS` | `10000` |
| `VEGAS_ENHANCED_DETAIL_CONCURRENCY` | `12` |

Példa:

```bash
MONITOR_STALE_MS=180000 \
  docker compose -f infra/docker/compose.yml up -d
```

## Gyakori hibák

### A `pia-gluetun` konténer nem található

A normál Compose-fájl minden service-nél a `pia-gluetun` hálózati névterét
használja. Indítsd el a külső Gluetun/PIA stack-et, majd ellenőrizd:

```bash
docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' pia-gluetun
```

### A Chrome nem healthy

Nézd meg a Chrome naplóját és healthcheckjét:

```bash
docker compose -f infra/docker/compose.yml logs --tail=200 chrome
docker inspect --format '{{json .State.Health}}' oddsaggregator-chrome
```

### A monitor outputja stale vagy hiányzik

Ellenőrizd a függőségi sorrendet és a kimeneteket:

```bash
docker compose -f infra/docker/compose.yml ps
ls -l runtime/data
docker compose -f infra/docker/compose.yml logs --tail=200 tippmixpro sharpx vegas
```

### Nincs host Node.js

Ez Dockeres üzemnél normális. A teszt- és futtatókörnyezet Node.js 24.18.0-at
használ az image-en belül; a forráskódot nem kell hoston `npm install`-lal
előkészíteni.
