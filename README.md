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

Teljes stack indítása:

```powershell
& .\bin\start_stack.ps1
```
