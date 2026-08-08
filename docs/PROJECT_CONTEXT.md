# OddsAggregator – projektkontextus és session handoff

> Utolsó érdemi frissítés: 2026-08-07. Az aktuális üzemi választás a headless
> primary stack a `9333` CDP-porton. A review ellenőrzésekor a stack nem futott,
> ezért valós hálózati smoke teszt nem történt; az állapot minden session elején
> újra ellenőrizendő.

A 2026-08-07-i priorizált találatlista és implementációs állapot:
`docs\REVIEW_2026-08-07.md`.

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

## Aktuális architektúra és üzemmódok

Négy eltérő mód létezik; a kanonikus kimeneteket egyszerre csak egy production
stack írhatja.

| Mód | Böngésző/CDP | Kimenet | Szerep |
|---|---|---|---|
| Headless primary | rejtett Chrome, alapból `9333` | kanonikus `data\` | aktuális elsődleges üzem |
| Grafikus stack | látható Chrome, alapból `9222` | kanonikus `data\` | rollback és referencia |
| Headless shadow | külön headless Chrome és profil | elkülönített tesztkimenet | normal/headless stabilitási összevetés |
| Direct shadow | nincs Chrome vagy CDP | elkülönített tesztkimenet | közvetlen Node-adatgyűjtés validációja |

A headless primary és a headless A/B futtató alapértelmezése `9333`, a
stabilitási shadow teszté `9334`. Ugyanazon a porton nem futhatnak párhuzamosan;
teszthez mindig szabad CDP-portot kell választani.

## Fontos kanonikus kimenetek

| Fájl | Szerep |
|---|---|
| `data\combined_odds.txt` | Ember által olvasható közös oddslista |
| `data\football\surebets_live_odds.txt` | Aktuális surebet-jelöltek |
| `data\sharpx_watchlist.json` | A Vegas célzott eseménylistája |
| `data\sharpx_status_snapshot.json` | SharpX piacstátusz, bet delay, `apiPt` és 1/X/2 lay odds |
| `data\tippmixpro_odds_snapshot.json` | TippmixPro esemény- és odds-snapshot |
| `data\vegas_odds_snapshot.json` | Vegas esemény- és odds-snapshot |
| `data\headless-primary\instance.json` | A headless primary utolsó indítási állapota és PID-jei |

Élő SharpX piac jelenlétében a SharpX által írt combined, surebet, watchlist és
status kimenetek célciklusa 1 másodperc. Tisztán prematch állapotban a prematch
cache miatt alapértelmezésben körülbelül 5 másodpercenként íródnak. A TippmixPro
és Vegas snapshot célciklusa 1 másodperc.

A primary surebet-generátor fail-closed TTL/freshness kaput alkalmaz. Alapból a
bookmaker snapshot legfeljebb 10 másodperces lehet; a TippmixPro kapcsolatnak
csatlakozottnak és feldolgozási tartozás nélkülinek, az utolsó frame-nek legfeljebb
30 másodpercesnek kell lennie. A Vegas live forrás legfeljebb 10, az egyedi
eseményadat legfeljebb 15 másodperces lehet. Elavult, jövőbeli, hibás vagy
disconnectelt forrásból bookmaker-sor és surebet nem készül.

A fájlok egyedi tempfájlos, Windows retry-val védett atomikus cserével íródnak.
A production entry pointok kimenetenként writer lockot is szereznek, ezért két
példány nem írhatja ugyanazt a fájlt. A `Get-Content -Wait` az atomikus csere miatt
nem követi megbízhatóan a változást; folyamatos nézethez polling vagy a megfelelő
watch script szükséges.

A surebet fájl eleji `** ` prefix élő SharpX eseményt jelöl. A bookmaker neve
utáni `**` (`Tippmix**`, `Vegas**`) ezzel szemben Szuper odds / Odds+ sort jelent.

## Aktuális éles indítás és vezérlés

A headless primary az ajánlott vezérlőpont:

```powershell
Set-Location 'C:\Users\regai\Projects\OddsAggregator'
& .\bin\headless_primary.ps1 Start
& .\bin\headless_primary.ps1 Status
& .\bin\headless_primary.ps1 Watch
& .\bin\headless_primary.ps1 Restart
& .\bin\headless_primary.ps1 Stop
```

Alapértékek és viselkedés:

- CDP: `http://127.0.0.1:9333`;
- Chrome-profil:
  `%LOCALAPPDATA%\Google\Chrome\OddsAggregatorHeadlessPrimary`;
- SOCKS5 a Chrome számára: `socks5://127.0.0.1:1080`;
- naplók: `logs\headless-primary\`;
- `Watch` alapértelmezett frissítése: 2 másodperc;
- a `Status` legfeljebb 10 másodperces kimenetet frissnek, 10–30 másodperc
  között későnek, e fölött elavultnak jelez;
- a `Start` elindítja a Surebet Managert is, hacsak nincs `-SkipManager`;
- a `Stop` és `Restart` szándékosan futva hagyja a Surebet Managert;
- a `Start` elutasítja a három production monitor bármely másik példányát és
  azt is, ha a `9333` portot nem a saját profilú Chrome használja.

A headless Chrome grafikusan nem látható, de valódi Chrome: ugyanazokat az
oldalakat, iframe-eket, hálózati kapcsolatokat és JavaScriptet futtatja, mint a
grafikus mód.

### Grafikus rollback/referencia stack

```powershell
& .\bin\start_stack.ps1
```

Ez a `9222` CDP-porton, látható Chrome-mal ugyanazt a három monitort és ugyanazokat
a kanonikus kimeneteket használja. A headless primary monitorokkal nem futhat
párhuzamosan.

A `start_stack.ps1 -CdpPort` a választott portot mindhárom monitor
`*_CDP_ENDPOINT` változójába továbbadja, és indulás előtt, majd Chrome-indítás után
is ellenőrzi a port és a profil tulajdonosát.

Mindkét böngészős mód szükséges oldalai:

- `https://sharpxch.com/player/sport/1`;
- `https://www.tippmixpro.hu/hu/fogadas/i`;
- `https://vegas.hu/sports/live`.

Alapinfrastruktúra: Windows, PowerShell, Node.js 22+ (jelenleg Node.js 24),
Google Chrome és működő `127.0.0.1:1080` SOCKS5. A böngészős indítók a proxyt nem
hozzák létre, csak a Chrome-ot irányítják rá.

### Leállítási hatókör

- Headless primary célzott leállítása: `headless_primary.ps1 Stop`.
- A Surebet Managert az alkalmazásablak bezárásával kell leállítani.
- A `bin\stop_monitors.ps1` alapból csak a három `*_odds_monitor.js` entry point
  host Node-folyamatait állítja le, és támogatja a `-WhatIf` ellenőrzést. Az
  explicit `-IncludeProjectTools` kapcsoló a projektútvonalhoz tartozó direct
  collectorokat és comparatorokat is bevonja.
- A `stop_monitors.ps1` nem állítja le a Docker collectorokat, a Chrome-ot vagy
  a Surebet Managert.

## Production folyamatok és adatforrások

A grafikus és headless-primary stack három külön Node.js folyamatot futtat.
Mindhárom ugyanahhoz a Chrome CDP-végponthoz kapcsolódik, de hibájuk alapvetően
nem állítja le egymást.

### SharpX – `src\sharpx_odds_monitor.js`

- A `portal.sharpxch.com` iframe execution contextjében fut.
- A katalógust HTTP-válaszokból, az oddsokat SharpX WebSocket kapcsolatokból
  olvassa.
- A legjobb lay odds kerül az 1/X/2 SharpX sorba.
- Minden jövőbeli és élő Match Odds piacra feliratkozik; alapértelmezésben
  legfeljebb 30 piac/WebSocket.
- Katalógusfrissítés: 60 másodperc.
- Bármely subscription-signature változás teljes socket-generációcserét okoz:
  a régi socketek bezárnak és az új generáció újranyílik. Ez a direct collector
  inkrementális/hiszterézises modelljétől eltér, és rövid readiness-eltérést
  okozhat.
- Élő piacok, combined és surebet kimenet: 1 másodperces célciklus.
- Tisztán prematch módban a párosítás, renderelés és kimenet 5 másodperces
  cache-cikluson fut.
- A SharpX írja a Vegas watchlistet és a SharpX status snapshotot.

### TippmixPro – `src\tippmixpro_odds_monitor.js`

- A `tippmixpro.hu` oldal sport iframe-jének publikus WAMP kapcsolatát használja:
  `wss://sportsapi.tippmixpro.hu/v2`.
- Labdarúgás: `sportId=1`.
- Normál 1X2: `b69_ep3`, `bettingTypeId=69`.
- Szuper odds 1X2: `b693_ep3`, `bettingTypeId=693`.
- Snapshot: 1 másodperces célciklus.
- Ötpercenként tournament-discoveryt és subscription-frissítést/bővítést végez;
  nem üríti és építi újra teljesen minden alkalommal az összes adatmapet.

### Vegas – `src\vegas_odds_monitor.js`

- A Vegas fő execution contextjében Altenar REST-végpontokat kérdez.
- Labdarúgás: `sportId=66`.
- Élő REST frissítés és snapshot: 1 másodperc.
- A SharpX watchlisthez tartozó események: külön, 5 másodperces
  háttérfrissítés. A watchlist nincs kizárólag prematch piacokra szűrve.
- Teljes katalógusfrissítés: 5 perc.
- A teljes katalógus csak akkor commitol, ha minden bajnokságlekérés sikeres;
  részhiba megtartja az előző konzisztens állapotot és a régi health timestampet.
- A normál Vegas piac csak akkor használható, ha a piac neve pontosan `1X2`,
  és mindhárom valódi 1/X/2 kimenet (`typeId` 1, 2, 3) jelen van. A `typeId=1`
  önmagában nem bizonyít 1X2 piacot.
- Odds+ csak pontos `1X2 - Odds+` piacból jöhet. Az Odds+ esemény normál 1X2
  ára szükség esetén `GetEventDetails` válaszból érkezik.
- Az Altenar query `timezoneOffset` értéke minden kérésnél a runtime aktuális
  időzóna-offsetje; szükség esetén a validált `VEGAS_TIMEZONE_OFFSET_MINUTES`
  változóval felülírható. A `countryCode=LU` és `culture=hu-HU` változatlan.

A TippmixPro és Vegas snapshot státusz-, score-, period-, minute- és red-card
adatokat is hordozhat. A primary surebet-generátor a forrásfrissességet és az
élő/prematch fázisegyezést kapuként használja; a score-, period-, minute- és
red-card mezők továbbra is diagnosztikai adatok.

## Eseménypárosítás

A SharpX az elsődleges eseménylista. A fő párosítás home→home és away→away
sorrendben történik; megfordított csapatpárt nem próbál automatikusan.

Fő szabályok:

1. normál ágban legfeljebb 30 perc kezdési időeltérés és megfelelő kétoldali
   normalizált/fuzzy csapatnév-egyezés;
2. legfeljebb 2 perces, competition-kompatibilis, egyedi fallbacknél erősen
   aszimmetrikus névegyezés is elfogadható;
3. a `config\team_aliases.json` ellenőrzött kézi aliasai elsőbbséget élveznek;
4. pontosan egyórás szolgáltatói eltérésnél a 60 ± 2 perces kivétel csak erős
   kétoldali névegyezéssel és azonos versenysorozat-családdal fogadható el.

Az egyórás kivétel kezeli például a SharpX `Friendly Matches`, TippmixPro
`Felkészülési mérkőzés` és Vegas `Barátságos mérkőzések` elnevezéseit.

A Vegasnál két matching-lépcső van: előbb a SharpX watchlist kerül be a Vegas
snapshotba a Vegas saját `findVegasEvent` logikájával, majd a SharpX aggregator
illeszti a snapshotot a gazdagabb általános matcherrel. Emiatt egy egyébként
illeszthető esemény már a snapshot-kiválasztásnál kieshet.

Az alias-szótár nem tanul automatikusan. Új nevet csak kezdési idő és bajnokság
ellenőrzése után, kézzel szabad hozzáadni; egy alias csak egy canonical névhez
tartozhat.

## Surebet szabály és megjelenítési szemantika

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

A vizsgálat külön fut az 1, X és 2 kimenetre, valamint Tippmix, Tippmix**,
Vegas és Vegas** sorokra. Ha egy eseménynél legalább egy sor legalább egy
kimenetele megfelel, az esemény bekerül a surebet fájlba, és utána az összes
elérhető bookmaker-sor mindhárom oddsa megjelenik. Ezért nem minden kiírt
sor vagy odds önmagában surebet. A logban szereplő `surebetEvents` eseményeket,
nem külön opportunity/outcome darabszámot jelent.

A fájl jelenleg oddsokat ír ki; a konkrét tétet, nyereséget, minimális profitot
és likviditási korlátot nem számolja ki.

## Chrome-mentes direct shadow

Elkészült mindhárom közvetlen Node collector:

- `src\sharpx_direct_shadow.js` – közvetlen SharpX HTTP-katalógus és WebSocket;
- `src\vegas_direct_shadow.js` – közvetlen Altenar REST;
- `src\tippmixpro_direct_shadow.js` – közvetlen publikus WAMP kapcsolat.

Ezek nem használnak Chrome-ot, CDP-t, böngésző-cookie-t vagy DOM-ot. Továbbra is
shadow eszközök: külön fájlokat írnak, és nem készítenek kanonikus
`combined_odds.txt` vagy `surebets_live_odds.txt` kimenetet.

### VPN/Docker útvonal

A direct Node-kód nem SOCKS5 proxy-agenten keresztül megy. Az alapértelmezett
futtató minden collectort külön Docker-konténerbe indít, és a `pia-gluetun`
konténer hálózati névterét osztja meg:

```powershell
& .\bin\start_all_direct_shadow_test.ps1 -DurationHours 2
```

Alapértékek:

- `DirectNetwork=PiaDocker`;
- `PiaContainerName=pia-gluetun`;
- `NodeImage=node:24.18.0-bookworm-slim`;
- a `DurationMinutes` megadása felülírja a `DurationHours` értékét;
- adat: `data\all-direct-shadow\<runId>\`;
- napló és összevetés: `logs\all-direct-shadow\<runId>\`;
- a futtató legfeljebb 60 másodpercig vár mindhárom collector friss, olvasható
  JSON-kimenetére, és csak ezután indítja a comparatorokat;
- a `run-manifest.json` rögzíti a közös deadline-t, PID-eket, container ID-ket és
  kimeneteket; startup hiba esetén csak az adott GUID-os run erőforrásait takarítja.

A PIA/Gluetun külső WSL-konfiguráció helye: `/home/jimmy/pia-vpn`; a használt
OpenVPN profil: `lu-aes-256-cbc-tcp-dns.ovpn`. Ez nincs a repóban. A futtató csak
azt ellenőrzi, hogy a `pia-gluetun` konténer fut-e; a VPN health-et, publikus IP-t
és DNS-útvonalat nem validálja. A `-DirectNetwork Host` csak célzott
hibakeresésre való, mert megkerüli a PIA Docker-útvonalat.

A direct futtatóknak nincs egységes korai `Stop` művelete. Normál esetben a
megadott duration állítja le őket; a collector konténerek `--rm` módban futnak.

### Direct korlátok

- A közös launcher a Vegas direct collectornak a direct SharpX status snapshotot
  adja watchlistként; az átalakítás a runnernevekből állítja elő a home/away
  adatokat. Így a három collector forrásoldala önállóan Chrome-mentes. A Vegas
  önálló indításának defaultja kompatibilitásból továbbra is a kanonikus watchlist.
- A Vegas/TippmixPro `provider_direct_shadow_comparator.js` a `generatedAt`,
  forrás-health, snapshot-skew és eseményfedettség mellett odds-, státusz-, live-
  és kezdésiidő-egyezést is mér; hibás vagy elavult minta nem javíthatja a
  readiness mutatókat.
- A comparatorok host Node-folyamatok, ezért a kanonikus referencia-stacknek a
  direct teszt alatt is frissen kell futnia.

### SharpX direct stabilitási védelem

- Egy korábban kiválasztott, nem `CLOSED` piac csak három egymást követő sikeres
  körben fennálló `currentSelected`-hiány után kerül ki. Ennek oka lehet valódi
  `catalogue-missing` vagy a start-time/inPlay átmenetből eredő
  `selection-filtered`; a raw/unique/duplicate és hiszterézis-adatok
  telemetriába kerülnek.
- A readiness az owner connection, socket `OPEN`, subscription-ready és price
  generation állapotát együtt ellenőrzi.
- A nem-ready vagy élő stale piac először teljes owner-socket resubscribe-ot kap,
  majd ismételt sikertelenségnél célzott owner-socket restart történik.
- Age-alapú stale csak élő, `OPEN` piacon aktív, alapból 60 másodperc; prematch
  stale alapból kikapcsolt.
- Market-triggered restartból ciklusonként legfeljebb 2 lehet; a socketenkénti
  exponenciális cooldown 2 percről legfeljebb 15 percre nő.
- A `CLOSED` piac az aktív kimenetből kiesik, diagnosztikája 5 percig megmarad.
- A `marketDiagnostics` okonként számolja/listázza a `catalogue-missing`,
  `hysteresis-retained`, `not-ready`, `stale` és `closed` piacokat.
- A socket-tömörítéshez három egymást követő nyomásciklus és két sikeres
  tömörítés között 5 perces cooldown kell.

A SharpX comparator csak `generatedAt` alapján friss, sémahelyes, mindkét oldalon
legalább 95%-os lefedettségű és legfeljebb 5 másodperces snapshot-skew-jú mintát
értékel. Alapból 30 másodperc warmupot használ; a normál/direct tartalomkor
10/5 másodperc. Érvénytelen minta vagy az alapból
`max(3 × intervalMs, 5000)` megfigyelési küszöbnél hosszabb rés megszakítja az
evidence-epizódot; ez 1 másodperces mintavételnél 5 másodperc, és
`--max-observation-gap-ms` kapcsolóval felülírható. Azonos `apiPt` mellett eltérő
odds, régebbi normal/direct ár és tolerált időzítési eltérés külön osztályozást
kap.

## Mérések és validációs állapot

### Korábbi production optimalizálás

| Mérőszám | Történeti eredmény |
|---|---:|
| SharpX CPU 10 másodperc alatt | 2,14 CPU-másodperc |
| SharpX memória | kb. 105 MB |
| Combined/surebet/watchlist frissülés átlaga | 1,27 mp |
| Leghosszabb mért ciklus | 2,01 mp |
| TippmixPro snapshot átlaga | 1,01 mp |
| Vegas snapshot átlaga | 1,009 mp |

A prematch cache előtt a SharpX 5,27 CPU-másodperc / 10 mp és kb. 213 MB volt.
Ezek történeti, nem folyamatos SLA-mérések.

### Tiszta normal/headless erőforrás A/B – 2026-07-26

Futások:

- `logs\resource-normal\metrics-20260726-092246.csv`;
- `logs\resource-headless-clean\metrics-20260726-093902.csv`.

| Mérőszám | Grafikus | Headless |
|---|---:|---:|
| Chrome working set átlag | 1611,8 MB | 1489,3 MB |
| Chrome working set maximum | 1666,2 MB | 1650,5 MB |
| Chrome folyamatok átlaga | 18 | 14 |
| Három Node monitor working set átlaga | 333,4 MB | 332,2 MB |

A memóriaelőny mérsékelt, körülbelül 122,5 MB / 7,6% Chrome working set. A
headless elsődleges választás ezért nem pusztán erőforrásnyereségre épült, hanem
az elkülönített profilra, a vezérelhetőségre és azokra a kézi esetekre is,
amikor a headless frissebb Tippmix/Vegas kínálatot tartott, míg a grafikus mód
eltűnt vagy régi oddsot őrzött.

A legutóbbi hosszabb normal/headless stabilitási riport:
`logs\shadow-stability\20260729-080621\report.md` (14,4 óra,
48 789/48 818 értékelhető minta, 2,112 másodperces medián felismerési eltérés).
Mindkét stackben voltak eltérések, ezért ez nem bizonyítja, hogy bármelyik mód
minden helyzetben hibátlan.

### Direct validációk

A 2026-08-01-i közös kétórás futás:
`logs\all-direct-shadow\20260801-085558`.

- Vegas: 7081/7088 ready minta (99,90%), végül 678/678 esemény;
- TippmixPro: 6981/7009 (99,60%), végül 1387/1387 esemény;
- SharpX: 6700/7043 (95,13%), végül 763 direct és 769 normal piac.

Ez Vegas/TippmixPro esetén csak folyamat- és event-ID katalógusvalidáció, nem
odds- vagy státuszvalidáció. A jelenlegi `start_all_direct_shadow_test.ps1` a
futás után még módosult, ezért az aktuális launcher-verzió sem tekinthető ezzel
teljesen lefedettnek.

A legutóbbi SharpX hosszú futás:
`logs\sharpx-direct-shadow\20260807-135633`.

- időtartam: 7 óra;
- ready minták: 21 360/24 525 (87,10%);
- persistent odds evidence: 26;
- végső direct lefedettség: 801/849 (94,35%);
- 28 katalógus `ETIMEDOUT` és 1 üres-socket restart.

A 87,10% a régi comparator snapshotpár-szintű, fájl-mtime alapú mutatója volt,
nem a direct collector önálló rendelkezésre állása. Az érvénytelen párok szinte
teljesen a normál referencia 5 másodpercnél idősebb snapshotjaiból származtak;
a direct oldalon nem volt 5 másodperces mtime-stale minta, csak 12 indulási
read-hiba.

A collector és comparator a futás után kapta meg a katalógus-hiszterézist,
readiness/recovery védelmet, restart-féket, tartalmi health gate-et és bővített
diagnosztikát. A jelenlegi verzióval még nem futott új smoke vagy hosszabb
validáció; a régi 7 órás eredmény ezért nem használható release-elfogadásként.

## Következő lépések

1. A jelenlegi SharpX collector/comparator 15 perces smoke tesztje a
   `pia-gluetun` útvonalon.
2. Sikeres smoke után legalább 2 órás, lehetőleg élő meccsekkel terhelt SharpX
   validáció.
3. Új közös háromforrásos validáció a provider comparatorok tartalmi metrikáival;
   csak ezután direct-primary és kanonikus combined/surebet kimenet tervezése.
4. Run-manifest alapú egységes direct `Status`/`Stop` és futás közbeni watchdog.
5. Frame-age alapú, cooldownnal védett célzott provider-reconnect soak teszttel.
6. A név- és időalapú matching kétértelmű eseteinek mérése és fixture-alapú
   regressziós tesztje.

## Gyakori ellenőrzések új sessionben

1. Olvasd el ezt a fájlt és a `docs\HASZNALAT.md` dokumentumot, de eltérésnél az
   aktuális kód az elsődleges forrás.
2. Headless primary állapot:

   ```powershell
   & .\bin\headless_primary.ps1 Status
   ```

3. CDP targetek (`9333` headless primary, `9222` grafikus stack):

   ```powershell
   $cdpPort = 9333
   Invoke-RestMethod "http://127.0.0.1:$cdpPort/json" |
     Select-Object type, title, url
   ```

4. Kimenetek:

   ```powershell
   Get-Item .\data\combined_odds.txt, `
     .\data\football\surebets_live_odds.txt, `
     .\data\sharpx_status_snapshot.json, `
     .\data\tippmixpro_odds_snapshot.json, `
     .\data\vegas_odds_snapshot.json |
     Select-Object Name, Length, LastWriteTime
   ```

5. Headless hibanaplók: `logs\headless-primary\*.error.log`. Grafikus stack:
   `logs\*.error.log`. A tesztek futásazonosítós alkönyvtárakat használnak.
6. Ellenőrizd, hogy élő surebetnél van-e sor eleji `** ` prefix, és hogy a
   bookmaker snapshotok is frissek-e.
7. Direct futás előtt ellenőrizd a Docker Engine-t és a `pia-gluetun` konténert;
   a script önmagában nem bizonyítja a VPN publikus IP-jét vagy DNS-útvonalát.
8. Statikus ellenőrzések módosítás után:

   ```powershell
   node --check src\sharpx_odds_monitor.js
   node --check src\tippmixpro_odds_monitor.js
   node --check src\vegas_odds_monitor.js
   node --check src\sharpx_direct_shadow.js
   node --check src\vegas_direct_shadow.js
   node --check src\tippmixpro_direct_shadow.js
   node --check src\sharpx_direct_shadow_comparator.js
   node --check src\provider_direct_shadow_comparator.js
   node --test
   ```

9. Ne futtasd párhuzamosan ugyanazon a CDP-porton a primary, A/B vagy shadow
   headless stacket. A böngészőlap-újratöltős `LiveOddsAggregator` ugyanazon a
   Chrome-on oldalakat tölthet újra vagy kattinthat, ami CDP context-hibát és
   adatkimaradást okozhat.

## Fontos production beállítások

A forráskód CDP-alapértéke `9222`; a `headless_primary.ps1` induláskor mindhárom
`*_CDP_ENDPOINT` változót a választott, alapból `9333` portra állítja.

| Változó | Alapérték |
|---|---|
| `SHARPX_CDP_ENDPOINT` | `http://127.0.0.1:9222` |
| `TIPPMIXPRO_CDP_ENDPOINT` | `http://127.0.0.1:9222` |
| `VEGAS_CDP_ENDPOINT` | `http://127.0.0.1:9222` |
| `SHARPX_PREMATCH_MIN_MATCHED` | `300` EUR |
| `SHARPX_CATALOGUE_REFRESH_MS` | `60000` |
| `SHARPX_OUTPUT_INTERVAL_MS` | `1000` |
| `SHARPX_PREMATCH_RENDER_MS` | `5000` |
| `SHARPX_MARKETS_PER_SOCKET` | `30` |
| `SHARPX_LIVE_PRICE_MAX_AGE_MS` | `10000` |
| `SHARPX_FETCH_TIMEOUT_MS` | `15000` |
| `BOOKMAKER_SNAPSHOT_MAX_AGE_MS` | `10000` |
| `SNAPSHOT_FUTURE_TOLERANCE_MS` | `5000` |
| `TIPPMIXPRO_SOURCE_MAX_AGE_MS` | `30000` |
| `VEGAS_SOURCE_MAX_AGE_MS` | `10000` |
| `VEGAS_EVENT_MAX_AGE_MS` | `15000` |
| `CDP_COMMAND_TIMEOUT_MS` | `15000` |
| `TIPPMIXPRO_OUTPUT_INTERVAL_MS` | `1000` |
| `TIPPMIXPRO_CATALOGUE_REFRESH_MS` | `300000` |
| `VEGAS_OUTPUT_INTERVAL_MS` | `1000` |
| `VEGAS_LIVE_REFRESH_MS` | `1000` |
| `VEGAS_MATCHED_REFRESH_MS` | `5000` |
| `VEGAS_CATALOGUE_REFRESH_MS` | `300000` |
| `VEGAS_REQUEST_TIMEOUT_MS` | `15000` |
| `VEGAS_TIMEZONE_OFFSET_MINUTES` | nincs; runtime időzóna |
| `SHARPX_OUTPUT_FILE` | `data\combined_odds.txt` |
| `SUREBETS_OUTPUT_FILE` | `data\football\surebets_live_odds.txt` |
| `SHARPX_STATUS_SNAPSHOT_FILE` | `data\sharpx_status_snapshot.json` |
| `SHARPX_WATCHLIST_FILE` | `data\sharpx_watchlist.json` |
| `TIPPMIXPRO_OUTPUT_FILE` | `data\tippmixpro_odds_snapshot.json` |
| `VEGAS_OUTPUT_FILE` | `data\vegas_odds_snapshot.json` |
| `TIPPMIXPRO_SNAPSHOT_FILE` | `data\tippmixpro_odds_snapshot.json` |
| `VEGAS_SNAPSHOT_FILE` | `data\vegas_odds_snapshot.json` |
| `TEAM_ALIASES_FILE` | `config\team_aliases.json` |

További target override-ok: `SHARPX_TARGET_URL_PREFIX`,
`TIPPMIXPRO_TARGET_URL_FRAGMENT`, `VEGAS_TARGET_URL_PREFIX`. Egyszeri debug futás:
`SHARPX_ONCE=1`, `TIPPMIXPRO_ONCE=1`, `VEGAS_ONCE=1`.

A direct SharpX és comparator részletes CLI-alapértékei a fájlok elején lévő
`CONFIG` blokkokban találhatók. A legfontosabb kapcsolók:

- collector: `--catalogue-absence-confirmations`, `--live-market-stale-ms`,
  `--prematch-market-stale-ms`, `--market-ready-timeout-ms`,
  `--market-recovery-attempts`, `--market-restart-max-per-tick`,
  `--market-restart-cooldown-base-ms`, `--market-restart-cooldown-max-ms`,
  `--closed-diagnostic-retention-ms`;
- comparator: `--warmup-ms`, `--normal-max-content-age-ms`,
  `--direct-max-content-age-ms`, `--max-snapshot-skew-ms`,
  `--max-observation-gap-ms`, `--evidence-grace-ms`,
  `--odds-time-tolerance-ms`, `--live-odds-time-tolerance-ms`,
  `--normal-min-coverage-ratio`, `--direct-min-coverage-ratio`.

## Könyvtárak és külső függőségek

| Hely | Tartalom |
|---|---|
| `src\` | Production monitorok, direct collectorok, probe-ok és comparatorok |
| `bin\` | Grafikus/headless lifecycle, A/B-, stabilitási és direct-shadow futtatók |
| `config\` | Csapatnév-aliasok |
| `data\` | Kanonikus kimenetek, headless állapot és futásonkénti tesztadatok |
| `logs\` | Production és futásazonosítós tesztnaplók |
| `docs\` | Használat, handoff és technikai jegyzetek |
| `..\SurebetManager\` | Külső testvérprojekt, `main_qt.py` GUI |
| `/home/jimmy/pia-vpn` | Külső WSL PIA/Gluetun konfiguráció |

## Git/worktree állapot

A 2026-08-07-i audit után a production hardening, a headless/direct/shadow
tooling, a regressziós tesztek és a dokumentáció tematikus commitokba rendezve
bekerültek a repository történetébe. Új sessionben ettől függetlenül mindig
ellenőrizni kell a `git status --short` kimenetét; a `data\` és `logs\` továbbra
is generált, gitignore-olt tartalom.

## Biztonsági és jogi határ

A rendszer kizárólag publikus oddsokat olvas. A szolgáltatók felhasználási
feltételeit, az automatizált adatgyűjtés engedélyezettségét és az adatok további
felhasználásának jogszerűségét külön ellenőrizni kell.
