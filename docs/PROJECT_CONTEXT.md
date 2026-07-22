# OddsAggregator – projektkontextus és session handoff

## Cél és hatókör

Projektgyökér:

`C:\Users\regai\Projects\OddsAggregator`

A rendszer a SharpX, TippmixPro és Vegas publikus labdarúgó Match Odds / rendes
játékidős 1X2 kínálatát gyűjti, párosítja és írja ki. Nem jelentkezik be, nem ad
fel fogadást és nem kerül meg hozzáférés-védelmet.

Fő célok:

- élő oddsoknál körülbelül 1–2 másodperces frissesség;
- minden SharpX élő Match Odds piac figyelése;
- prematch megjelenítéshez legalább 300 EUR SharpX matched amount;
- surebet-keresés minden jövőbeli és élő SharpX Match Odds piacra, a 300 EUR
  küszöbtől függetlenül;
- SharpX lay odds és TippmixPro/Vegas back odds összevetése 2,95% SharpX
  jutalékkal.

## Fontos kimenetek

| Fájl | Szerep |
|---|---|
| `data\combined_odds.txt` | Ember által olvasható közös oddslista |
| `data\football\surebets_live_odds.txt` | Aktuális surebetek |
| `data\sharpx_watchlist.json` | Vegas célzott prematch watchlistje |
| `data\tippmixpro_odds_snapshot.json` | TippmixPro belső snapshot |
| `data\vegas_odds_snapshot.json` | Vegas belső snapshot |

A surebet fájlban a `** ` prefix élő SharpX eseményt jelöl. A combined lista
nem jelöl külön élő eseményt.

## Indítás és leállítás

Az ajánlott indítás:

```powershell
Set-Location 'C:\Users\regai\Projects\OddsAggregator'
& .\bin\start_stack.ps1
```

A `bin\start_stack.ps1`:

- szükség esetén elindítja a SOCKS5 proxyt használó Chrome-ot CDP `9222` porttal;
- megnyitja a SharpX, TippmixPro és Vegas szükséges oldalait;
- elindítja a Surebet Managert a `data\football\surebets_live_odds.txt`
  javaslati forrással;
- indítja a három Node monitort, de meglévő példányból nem indít duplikátumot.

A szükséges oldalak:

- `https://sharpxch.com/player/sport/1`
- `https://www.tippmixpro.hu/hu/fogadas/i`
- `https://vegas.hu/sports/live`

Alapvető infrastruktúra:

- Chrome CDP: `http://127.0.0.1:9222`
- SOCKS5 proxy: `socks5://127.0.0.1:1080`
- Node.js 22+; a jelenlegi környezet Node.js 24.

A Node monitorok célzott leállítása:

```powershell
$project = 'C:\Users\regai\Projects\OddsAggregator'

Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -eq 'node.exe' -and $_.CommandLine -match [regex]::Escape($project)
  } |
  ForEach-Object { Stop-Process -Id $_.ProcessId }
```

A Surebet Managert az alkalmazásablak bezárásával kell leállítani. A Chrome
csak akkor zárható be, ha más, ugyanazt a profilt használó feladat nem fut.

## Folyamatok és adatforrások

Három külön Node.js folyamat kapcsolódik ugyanahhoz a Chrome CDP végponthoz.
A folyamatok hibája alapvetően nem állítja le egymást.

### SharpX – `src\sharpx_odds_monitor.js`

- A `portal.sharpxch.com` iframe execution contextjében fut.
- A katalógust HTTP-válaszokból, az oddsokat SharpX WebSocket kapcsolatokból
  olvassa.
- A legjobb lay odds kerül az 1/X/2 SharpX sorba.
- Minden jövőbeli és élő Match Odds piacra feliratkozik; alapértelmezésben
  legfeljebb 30 piac/WebSocket.
- Katalógusfrissítés: 60 másodperc.
- Élő piacok, combined és surebet kimenet: 1 másodperces célciklus.
- A nagy prematch lista párosítása és renderelése 5 másodperces cache-ben van;
  az élő piacok minden ciklusban friss számítást kapnak.
- A Vegas watchlistet a SharpX írja.

### TippmixPro – `src\tippmixpro_odds_monitor.js`

- A `tippmixpro.hu` oldal sport iframe-jének WAMP kapcsolatát használja:
  `wss://sportsapi.tippmixpro.hu/v2`.
- Labdarúgás: `sportId=1`.
- Normál 1X2: `b69_ep3`, `bettingTypeId=69`.
- Szuper odds 1X2: `b693_ep3`, `bettingTypeId=693`.
- Snapshot: 1 másodperces célciklus.
- Katalógusújraépítés: 5 perc.

### Vegas – `src\vegas_odds_monitor.js`

- A Vegas fő execution contextjében Altenar REST-végpontokat kérdez.
- Labdarúgás: `sportId=66`.
- Élő REST frissítés és snapshot: 1 másodperc.
- SharpX watchlisthez tartozó prematch események: külön, 5 másodperces
  háttérfrissítés. Ez nem blokkolhatja az élő snapshot írását.
- Teljes prematch katalógus: 5 perc.
- A normál Vegas piac csak akkor használható, ha a piac neve pontosan `1X2`,
  és mindhárom valódi 1/X/2 kimenet (typeId 1, 2, 3) jelen van.
  A `typeId=1` önmagában nem 1X2: például a „3. gól” piac is használhatja.
- Odds+ csak pontos `1X2 - Odds+` piacból jöhet. Az Odds+ esemény normál 1X2
  ára szükség esetén `GetEventDetails` válaszból érkezik.

## Eseménypárosítás

A SharpX az elsődleges eseménylista. A párosítás fő feltételei:

1. normál esetben legfeljebb 30 perc kezdési időeltérés;
2. erős, normalizált/fuzzy kétoldali csapatnév-egyezés;
3. versenysorozat-család kompatibilitása a bizonytalan esetekben;
4. a `config\team_aliases.json` kézi aliasai elsőbbséget élveznek.

Kezelt kivétel: egyes források ugyanazt a meccset pontosan egyórás eltéréssel
adják. A 60 ± 2 perces párosítás csak akkor fogadható el, ha mindkét csapatnév
erősen egyezik és a bajnokságcsalád is azonos. Ez kezeli például a SharpX
`Friendly Matches`, TippmixPro `Felkészülési mérkőzés` és Vegas `Barátságos
mérkőzések` elnevezéseit.

Az alias-szótár nem tanul automatikusan. Új nevet csak ellenőrzés után, kézzel
szabad hozzáadni; egy alias csak egy canonical névhez tartozhat.

## Surebet szabály

Jelölések:

- `B`: bookmaker back odds;
- `L`: SharpX lay odds;
- `c = 0,0295`: SharpX commission;
- `S`: bookmaker tét;
- `X`: SharpX lay tét.

Kiegyenlítő lay tét:

`X = S × B / (L - c)`

Surebet feltétele:

`B × (1 - c) > L - c`

A vizsgálat külön fut az 1, X és 2 kimenetre, illetve Tippmix, Tippmix**,
Vegas és Vegas** sorokra. A fájl jelenleg oddsokat ír ki; a konkrét tétet,
nyereséget, minimális profitot és likviditási korlátot még nem számolja ki.

## Élő működés: utolsó ellenőrzött állapot

Az élő optimalizálás után mért eredmény:

| Mérőszám | Eredmény |
|---|---:|
| SharpX CPU 10 másodperc alatt | 2,14 CPU-másodperc |
| SharpX memória | kb. 105 MB |
| Combined/surebet/watchlist frissülés átlaga | 1,27 mp |
| Leghosszabb mért ciklus | 2,01 mp |
| TippmixPro snapshot átlaga | 1,01 mp |
| Vegas snapshot átlaga | 1,009 mp |

Korábban a SharpX 5,27 CPU-másodperc / 10 mp és kb. 213 MB volt; a prematch
cache ezt körülbelül felére csökkentette. A 2,01 mp-es egyedi érték a teljes
prematch cache-frissítési ciklushoz tartozhat.

## Erőforráshelyzet és következő döntési pont

A Node monitoroknál a SharpX volt a fő szűk keresztmetszet; ez már javítva van.
A jelenlegi nagy fogyasztó a Chrome:

- körülbelül 2,2 GB working set;
- 12 renderer folyamat a három oldal cross-origin iframe-jei miatt;
- a három Node monitor együtt nagyjából 350 MB körüli working setet használ.

Chrome, Edge és Chromium mind Chromium/Blink/V8 alapú, ezért azonos oldalakon
a böngésző cseréjétől nem várható nagy nyereség. Edge efficiency mode vagy a
rendererfolyamatok erőszakos korlátozása élő oddsoknál nem ajánlott, mert
időzítő-throttlingot és iframe-hibát okozhat.

Ha további optimalizálás szükséges, ezt előbb külön méréssel kell eldönteni:

1. headless Chrome A/B teszt külön profillal és külön CDP-porttal;
2. ha a lemezírás problémát okoz, külön, kisméretű live snapshot és ritkább
   teljes prematch snapshot bevezetése;
3. hosszú távon Vegas, majd TippmixPro közvetlen Node-os adatgyűjtése, hogy
   kevesebb böngészőlapra legyen szükség.

Ne módosítsd automatikusan a 2–3. pontot új mérés és felhasználói döntés nélkül.

## Gyakori ellenőrzések új sessionben

1. Olvasd el ezt a fájlt és a `docs\HASZNALAT.md` dokumentumot.
2. Ellenőrizd a CDP-t:

   ```powershell
   Invoke-RestMethod 'http://127.0.0.1:9222/json' | Select-Object title, url
   ```

3. Ellenőrizd a három Node folyamatot és a `logs\*.error.log` fájlokat.
4. Ellenőrizd a kimeneti fájlok `LastWriteTime` értékét. Élő meccseknél
   jellemzően 1–2 másodpercen belül változniuk kell.
5. Ellenőrizd, hogy élő surebetnél van-e `** ` prefix.
6. Módosítás után futtasd:

   ```powershell
   node --check src\sharpx_odds_monitor.js
   node --check src\tippmixpro_odds_monitor.js
   node --check src\vegas_odds_monitor.js
   ```

7. Ne futtasd párhuzamosan ugyanazon a `9222` Chrome-on a `LiveOddsAggregator`
   böngészőlap-újratöltős stackjét. Az oldalakat újratöltheti vagy kattinthatja,
   ami CDP context-hibákat és átmeneti adatkimaradást okozhat.

## Fontos beállítások

| Változó | Alapérték |
|---|---|
| `SHARPX_CDP_ENDPOINT` | `http://127.0.0.1:9222` |
| `TIPPMIXPRO_CDP_ENDPOINT` | `http://127.0.0.1:9222` |
| `VEGAS_CDP_ENDPOINT` | `http://127.0.0.1:9222` |
| `SHARPX_PREMATCH_MIN_MATCHED` | `300` |
| `SHARPX_OUTPUT_INTERVAL_MS` | `1000` ms |
| `SHARPX_PREMATCH_RENDER_MS` | `5000` ms |
| `TIPPMIXPRO_OUTPUT_INTERVAL_MS` | `1000` ms |
| `VEGAS_OUTPUT_INTERVAL_MS` | `1000` ms |
| `VEGAS_LIVE_REFRESH_MS` | `1000` ms |
| `VEGAS_MATCHED_REFRESH_MS` | `5000` ms |

## Könyvtárak

| Könyvtár | Tartalom |
|---|---|
| `src\` | Három futtatható Node.js monitor |
| `bin\` | `start_stack.ps1` teljes stack indításához |
| `config\` | Csapatnév-aliasok |
| `data\` | Kimenetek és belső snapshotok |
| `logs\` | Standard output és hibanaplók |
| `docs\` | Használat, handoff és technikai jegyzetek |

## Biztonsági és jogi határ

A rendszer kizárólag publikus oddsokat olvas. A szolgáltatók felhasználási
feltételeit, az automatizált adatgyűjtés engedélyezettségét és az adatok további
felhasználásának jogszerűségét külön ellenőrizni kell.
