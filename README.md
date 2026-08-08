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
