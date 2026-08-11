# OddsAggregator

Labdarúgó Match Odds aggregátor SharpX, TippmixPro és Vegas adatforrásokhoz,
élő eseményeknél 1 másodperces közös kimenettel és SharpX lay alapú
surebet-kereséssel.

## Könyvtárak

- `src/` – a három Node.js monitor;
- `bin/` – a teljes stack egylépéses indítószkriptje;
- `config/` – csapatnév-aliasok;
- `data/` – generált oddslisták és belső snapshotok;
- `logs/` – futási és hibanaplók;
- `docs/` – teljes dokumentáció és session-handoff.

## Dokumentáció

- [Használat és indítás](docs/HASZNALAT.md)
- [Projektkontextus új sessionhöz](docs/PROJECT_CONTEXT.md)
- [Technikai adatgyűjtési terv](docs/sharpx-adatgyujtesi-terv.md)

## Fejlesztés Dockerből

A hoston nem szükséges Node.js-t telepíteni. A fejlesztői image ugyanazt a
Node.js 24.18.0 verziót használja, mint a headless production image, a
repositoryt pedig közvetlenül mountolja. A Chrome és a VPN nem része ennek a
rétegnek.

Teljes tesztkészlet:

```bash
docker compose -f infra/docker/compose.dev.yml run --rm dev
```

Egy fájl statikus ellenőrzése:

```bash
docker compose -f infra/docker/compose.dev.yml run --rm dev \
  node --check src/sharpx_odds_monitor.js
```

Interaktív fejlesztői shell:

```bash
docker compose -f infra/docker/compose.dev.yml run --rm --entrypoint bash dev
```

Az image-et csak a Node-verzió vagy a Docker-konfiguráció módosításakor kell
újraépíteni; a forráskód módosításai azonnal látszanak a konténerben.

Fő kimenetek:

- `data/combined_odds.txt`
- `data/football/surebets_live_odds.txt`

Ajánlott production indítás (headless primary):

```powershell
& .\bin\headless_primary.ps1 Start
& .\bin\headless_primary.ps1 Status
```

A látható Chrome-os rollback/referencia stack: `bin\start_stack.ps1`.

Az aktuális priorizált technikai audit: [Projekt-review – 2026-08-07](docs/REVIEW_2026-08-07.md).
