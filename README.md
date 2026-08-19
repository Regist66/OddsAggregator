# OddsAggregator

Labdarúgó oddsaggregátor SharpX, TippmixPro és Vegas adatforrásokhoz. A
projekt a három monitort és a Chrome/CDP réteget Docker Compose-ból futtatja.

## Könyvtárak

- `src/` – a három Node.js monitor és közös moduljaik;
- `config/` – csapatnév-aliasok;
- `infra/docker/` – Dockerfile, Compose-konfiguráció és healthcheckek;
- `runtime/` – futás közben generált snapshotok, oddslisták és lockok;
- `docs/` – használati és projektkontextus-dokumentáció.

## Követelmények

- Linux és Docker Engine Compose v2 támogatással;
- a felhasználónak hozzáférés a Docker daemonhoz;
- futó, healthy `pia-gluetun` konténer a production hálózati névtérhez;
- a PIA/Gluetun konfiguráció a repón kívül található.

A hoston nem szükséges Node.js vagy Chrome. Az image Node.js 24.18.0-at és
Chromiumot tartalmaz. A projektnek nincs külső npm-függősége, ezért nincs
`npm install` lépés.

## Indítás

```bash
docker compose -f infra/docker/compose.yml config --quiet
docker compose -f infra/docker/compose.yml up -d --build
docker compose -f infra/docker/compose.yml ps
```

Naplók:

```bash
docker compose -f infra/docker/compose.yml logs -f --tail=100
```

Leállítás:

```bash
docker compose -f infra/docker/compose.yml down --remove-orphans
```

Részletes leírás: [docs/HASZNALAT.md](docs/HASZNALAT.md). A projekt aktuális
állapota: [docs/PROJECT_CONTEXT.md](docs/PROJECT_CONTEXT.md).
