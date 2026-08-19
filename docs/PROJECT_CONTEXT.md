# OddsAggregator projektkontextus

Ez a dokumentum a jelenlegi, Linux alatti Docker Compose üzemet írja le. A
korábbi Windows/PowerShell, fejlesztői teszt, direct shadow és canary workflow-k
a projekt egyszerűsítésekor eltávolításra kerültek.

## Jelenlegi architektúra

A normál stack egy Docker image-ből fut, amely a Node.js 24.18.0 verziót és a
Chromiumot tartalmazza. A Compose négy service-t indít:

1. `chrome` – headless Chromium és CDP végpont;
2. `tippmixpro` – TippmixPro adatgyűjtő;
3. `sharpx` – SharpX adatgyűjtő, közös oddslista és surebet output;
4. `vegas` – Vegas adatgyűjtő.

Minden service a `pia-gluetun` külső konténer hálózati névterét használja. A
Gluetun/PIA konfiguráció nem része a repónak; a futó konténernek pontosan
`pia-gluetun` néven és használható health állapotban kell léteznie.

## Forrásfájlok

- `src/tippmixpro_odds_monitor.js` – TippmixPro monitor;
- `src/sharpx_odds_monitor.js` – SharpX monitor és output-összeállítás;
- `src/vegas_odds_monitor.js` – Vegas monitor;
- `src/atomic_file.js` – atomikus fájlírás és writer lockok;
- `src/numeric_config.js` – környezeti és CLI numerikus konfiguráció;
- `src/sharpx_market_renderability.js` – SharpX piacállapot-segédfüggvények;
- `config/team_aliases.json` – csapatnév-aliasok.

A monitorok csak Node.js beépített modulokat használnak. Nincs `package.json`,
`npm install` vagy host oldali Node-függőség a Dockeres futtatáshoz.

## Docker-fájlok

- [Dockerfile](../infra/docker/Dockerfile) – közös runtime image;
- [compose.yml](../infra/docker/compose.yml) – az egyetlen aktív production
  Compose-konfiguráció;
- `start-chrome.mjs` – Chrome indítása és CDP oldaltargetek megnyitása;
- `chrome-healthcheck.mjs` – Chrome/CDP healthcheck;
- `monitor-healthcheck.mjs` – monitor output freshness és tartalmi healthcheck;
- `monitor-supervisor.mjs` – monitor újraindítási és heartbeat-felügyelet.

Az image buildje a forráskódot és a konfigurációt bemásolja. A Compose a futási
adatokat a host `runtime/data/` könyvtárába mountolja.

## Indítási sorrend

Előfeltételként ellenőrizd a Docker Engine-t és a Gluetun konténert:

```bash
docker info
docker inspect --format '{{.Name}} {{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' pia-gluetun
```

Ezután:

```bash
docker compose -f infra/docker/compose.yml config --quiet
docker compose -f infra/docker/compose.yml up -d --build
docker compose -f infra/docker/compose.yml ps
```

A `tippmixpro` és `sharpx` service a Chrome health állapotára épít; a SharpX a
TippmixPro snapshotját is használja a közös output validálásához. A Vegas a
SharpX watchlistjét olvassa.

## Kimeneti adatfolyam

A fő kimenetek:

| Fájl | Előállító | Fogyasztó |
|---|---|---|
| `runtime/data/tippmixpro_odds_snapshot.json` | TippmixPro | SharpX, healthcheck |
| `runtime/data/sharpx_status_snapshot.json` | SharpX | Vegas, healthcheck |
| `runtime/data/sharpx_watchlist.json` | SharpX | Vegas |
| `runtime/data/combined_odds.txt` | SharpX | külső fogyasztók |
| `runtime/data/football/surebets_live_odds.txt` | SharpX | külső fogyasztók |
| `runtime/data/vegas_odds_snapshot.json` | Vegas | külső fogyasztók |

A monitorok atomikus írást és lockfájlokat használnak. A stale vagy hibás
snapshotot a healthcheck és a monitor supervisor nem tekinti érvényes outputnak.

## Ellenőrzés és üzemeltetés

```bash
docker compose -f infra/docker/compose.yml ps
docker compose -f infra/docker/compose.yml logs -f --tail=100
docker compose -f infra/docker/compose.yml logs --tail=200 tippmixpro sharpx vegas
```

Leállítás:

```bash
docker compose -f infra/docker/compose.yml down --remove-orphans
```

Az image újraépítése csak Dockerfile- vagy Node-verzió-változáskor kötelező;
forrásmódosítás után a `--build` használata biztosítja az új image-et.

## Fontos konfigurációk

A Compose által leggyakrabban felülírt értékek:

- `MONITOR_STALE_MS` – output freshness határ;
- `MONITOR_STARTUP_GRACE_MS` – indulási türelmi idő;
- `MONITOR_POLL_MS` – supervisor polling időköze;
- `SHARPX_OUTPUT_MIN_COVERAGE_RATIO` – SharpX minimum coverage;
- `SHARPX_CDP_COMMAND_TIMEOUT_MS` – SharpX CDP timeout;
- `VEGAS_LIVE_REQUEST_BUDGET_MS` – Vegas live request budget;
- `VEGAS_ENHANCED_DETAIL_CONCURRENCY` – Vegas részletes lekérdezések
  párhuzamossága.

Az alapértelmezett CDP végpont a Compose-ban `http://127.0.0.1:9333`, mert a
monitorok a Chrome service-szel közös `pia-gluetun` network namespace-ben
futnak.

## Megszüntetett workflow-k

A repó már nem tartalmazza:

- a Windows/PowerShell indítókat és monitorleállítókat;
- külön fejlesztői Compose image-et és tesztfájlokat;
- direct shadow és direct production/canary Compose-profilokat;
- külön comparator, probe és selector segédeszközöket.

A régi review- és smoke-dokumentumok történeti feljegyzésként maradtak meg; az
ott szereplő korábbi workflow-k nem részei a jelenlegi futtatási modellnek.
