# OddsAggregator használata és indítása

## Követelmények

- Windows és PowerShell;
- Node.js 22 vagy újabb; a jelenlegi környezet Node.js 24-et használ;
- Chrome távoli hibakeresési porttal: `9222`;
- működő SOCKS5 proxy: `127.0.0.1:1080`;
- három megnyitott sportoldal: SharpX, TippmixPro és Vegas.

A projekt könyvtára:

```powershell
Set-Location 'C:\Users\regai\Projects\OddsAggregator'
```

## Ajánlott egylépéses indítás

```powershell
& .\bin\start_stack.ps1
```

## Headless elsődleges üzemeltetés

Ha a headless mód az éles, kanonikus kimeneteket író üzemmód, használd az
egységes vezérlőscriptet. Saját Chrome-profilt és alapértelmezetten a `9333`
CDP-portot használja, de a normál, cím nélküli Node monitorok mellett nem indul
el: azok ugyanezeket a `data\` kimeneteket írnák.

```powershell
# Indítás (a normál monitorok előbb legyenek leállítva)
& .\bin\headless_primary.ps1 Start

# Egyszeri állapotjelentés: Chrome/CDP, oldalak, monitorok, kimenetek frissessége
& .\bin\headless_primary.ps1 Status

# Folyamatos, kétmásodperces állapotnézet; kilépés: Ctrl+C
& .\bin\headless_primary.ps1 Watch

# Csak a headless primary Node monitorokat és a saját Chrome-példányát állítja le
& .\bin\headless_primary.ps1 Stop

# Célzott újraindítás
& .\bin\headless_primary.ps1 Restart
```

Az indítás a Surebet Managert is elindítja, ha még nem fut. Ennek kihagyására:

```powershell
& .\bin\headless_primary.ps1 Start -SkipManager
```

A production monitorok ugyanarra a kanonikus kimenetre második writert nem
engednek. A SharpX csak friss, egészséges TippmixPro/Vegas snapshotból készít
bookmaker-sort vagy surebetet; elavult, disconnectelt, jövőbeli időbélyegű vagy
élő/prematch fázisban eltérő adat fail-closed módon kimarad.

## Headless Chrome A/B teszt

A normál stack megváltoztatása nélkül, külön Chrome-profillal, CDP-porttal,
kimeneti fájlokkal és naplókkal indítható:

```powershell
& .\bin\start_headless_ab_test.ps1
& .\bin\measure_headless_ab_test.ps1 -DurationSeconds 900
```

Az A/B teszt alapértelmezetten a `9333` CDP-portot, a
`data\ab-headless\` kimeneti mappát és a `logs\ab-headless\` naplókat használja.
A headless primary ugyanezt a portot használja, ezért párhuzamos teszthez adj meg
szabad `-CdpPort` értéket.
A mérőszkript öt másodpercenként rögzíti a headless Chrome és a teszt-monitorok
memóriáját, összes CPU-idejét, valamint a négy fontos kimenet frissességét.
Értékeléskor a Chrome working setet, az 1–2 másodperc körüli fájlfrissességet és
a `*.error.log` fájlok új hibáit kell összevetni a normál stackkel.

## Háromforrásos, Chrome-mentes shadow teszt

A SharpX, Vegas és TippmixPro közvetlen Node-os collectora külön futtatható,
anélkül hogy az éles headless kimeneteket írná. A futtató forrásonként külön
snapshotot és összevetési naplót hoz létre; a folyamatok a megadott idő végén
maguktól leállnak.

```powershell
& .\bin\start_all_direct_shadow_test.ps1 -DurationHours 2
```

A SharpX összevető a piacállapotot, a katalógusfrissítés idejét és a nyers
áridőbélyeget is figyelembe veszi. A Vegas és TippmixPro összevetője a
`generatedAt`- és forrásfrissesség, eseményfedettség és snapshot-skew mellett az
odds-, státusz-, live- és kezdésiidő-egyezést is méri. A közös launcher a Vegas
watchlistet a direct SharpX snapshotból építi, így a három collector
forrásoldalon Chrome nélkül fut; kanonikus combined/surebet kimenetet továbbra
sem ír.

Induláskor a launcher legfeljebb 60 másodpercig vár mindhárom friss, olvasható
JSON-ra. Startup hiba esetén csak az adott GUID-os run PID-jeit és konténereit
takarítja; a `logs\all-direct-shadow\<runId>\run-manifest.json` tartalmazza a
deadline-t és az elindított erőforrásokat.

Az odds-időbélyeg toleranciája prematchnél 3 másodperc, élő piacnál 10 másodperc;
ez az élő oddsok természetes frissítési eltolódását kezeli.

A SharpX comparator csak összehasonlítható snapshotpárt számol bele az eltérés- és
evidence-metrikákba. A freshness alapja a JSON `generatedAt` mezője, nem a fájl
módosítási ideje. Az alapértelmezett kapuk: 30 másodperc warmup, legfeljebb
10 másodperces normál és 5 másodperces direct tartalomkor, legfeljebb 5
másodperces snapshot-időkülönbség, valamint mindkét oldalon legalább 95%-os
`initializedMarkets / subscribedMarkets` lefedettség. Érvénytelen minta minden
folyamatban lévő evidence-epizódot megszakít. A snapshot `markets` tömbje és az
`initializedMarkets` számláló is sémaellenőrzést kap; hibás vagy ellentmondó
snapshot nem kerül összehasonlításra. A mintavételben alapértelmezetten 5
másodpercnél hosszabb kihagyás újraindítja az evidence grace időt. A fő
felülírások:
`--warmup-ms`, `--normal-max-content-age-ms`, `--direct-max-content-age-ms`,
`--max-snapshot-skew-ms`, `--max-observation-gap-ms` és
`--min-coverage-ratio`.

A SharpX direct collector a socket-tömörítést óvatosan végzi: alapértelmezetten
három egymást követő katalógusciklusban fennálló alulterheltség után indítja el,
majd két tömörítés között legalább 5 percet vár. A viselkedés a
`--socket-compaction-confirmations` és `--socket-compaction-ms` kapcsolókkal
hangolható.

A dinamikus, lapozott SharpX-katalógusból egy piac csak három egymást követő,
sikeres frissítési körös hiány után kerül ki; ezt a
`--catalogue-absence-confirmations` módosítja. A recovery az aktuális owner
socket `OPEN`/`ready` állapotát és az ár generációját is ellenőrzi. A nem-ready
vagy stale piacokat először újra feliratkoztatja, ismételt sikertelenségnél pedig
csak az érintett socketet indítja újra. Az age-alapú stale-határ csak élő,
`OPEN` piacnál aktív, alapértéke 60 másodperc. Prematch piacnál alapértelmezés
szerint ki van kapcsolva, mert a SharpX stream eseményvezérelt; a socket teljes
frissességét ettől függetlenül a frame-idő figyeli. A market-triggered restartok
száma ciklusonként legfeljebb 2, és socketenként 2 percről legfeljebb 15 percre
növekvő cooldown védi a collectort a restart-hullámtól.

A `sharpx_status_snapshot.json` `marketDiagnostics` blokkja okonkénti számlálót
és korlátozott ID-listát ír a `catalogue-missing`, `hysteresis-retained`,
`not-ready`, `stale` és `closed` állapotokról. Ugyanitt látható a nyers/egyedi/
duplikált katalógusméret, valamint a socket close/reconnect és market-recovery
számláló is. A lezárt piac az aktív kimenetből azonnal kiesik, diagnosztikai
rekordja alapértelmezetten még 5 percig megmarad.

Tiszta A/B erőforrásmérésnél a két stack nem futhat egyidejűleg. A
`run_clean_resource_ab_test.ps1` a már elindított normál baseline-mérés befejezése
után automatikusan leállítja a normál stacket, elvégzi az izolált headless mérést,
majd visszaállítja a normál Chrome-ot, monitorokat és a Surebet Managert.

## 24 órás headless shadow stabilitási teszt

A normál stack marad az éles kimeneti forrás; a headless stack külön profillal,
alapból `9334` CDP-porttal és futásonként elkülönített mappákban dolgozik. Az összehasonlító
másodpercenként figyeli a kimeneteket. A bizonyítékcsomag csak legalább 30
másodpercig fennálló, legalább 0,5% nettó edge-ű,
esemény/bookmaker/1X2-kimenet szintű surebet-eltéréshez készül.

```powershell
& .\bin\start_shadow_stability_test.ps1 -DurationHours 24
```

A futás végén a headless Chrome és monitorai automatikusan leállnak. A futáshoz
tartozó `logs\shadow-stability\<id>\summary.json` és `report.md` összegzi a
frissességi hibákat, hibanapló-növekedéseket, snapshot-eltéréseket és a normál-only/
headless-only surebet epizódokat. A jelentős eltérésekhez tartozó `evidence\*.json`
fájlok a két oldal aktuális oddsait, fájlkorát és eseményállapotát is elmentik.
Az `surebetPresent` és `missingFrom` mezők egyértelműen jelzik, melyik oldalon
volt jelen, illetve hiányzott a surebet; a státusz-összevetés ettől függetlenül
mindkét oldalon ugyanarra az eseményre történik.
Mindkét oldalon szerepel egy `sharpXQuote` blokk is: a SharpX 1/X/2 best-lay
oddsokkal, azok `oddsUpdatedAt` forrásidejével és a státuszsnapshot
`statusSnapshotGeneratedAt` idejével.
A SharpX állapotokat a `data\sharpx_status_snapshot.json` tartalmazza. A részletes
`health.jsonl` és `events.jsonl` csak diagnosztikához szükséges, nem az éles
kimeneteket módosítja.

Élő összevetéshez minden shadow run a saját
`data\shadow-headless\<id>\football\surebets_live_odds.txt` fájlját használja; a
normál fájl továbbra is `data\football\surebets_live_odds.txt`. A
`bin\watch_shadow_surebets.ps1` automatikusan a legutóbbi run fájlját választja,
vagy a `-HeadlessFile` kapcsolóval explicit útvonal adható. Mivel a monitorok
atomikusan cserélik a fájlokat, a `Get-Content -Wait` nem követi megbízhatóan a
változásokat.

A szkript szükség esetén elindítja a proxyt használó, `9222`-es CDP-portú
Chrome-ot, megnyitja a három szükséges sportoldalt, elindítja a Surebet Manager
GUI-t, majd háttérben a TippmixPro, SharpX és Vegas monitorokat. A már futó
komponensekből nem indít második példányt. A Manager közvetlenül a
`data\football\surebets_live_odds.txt` fájlt kapja javaslati forrásként.

A Manager kihagyható:

```powershell
& .\bin\start_stack.ps1 -SkipManager
```

Eltérő CDP-port vagy proxy is megadható:

```powershell
& .\bin\start_stack.ps1 -CdpPort 9333 -ProxyServer 'socks5://127.0.0.1:1080'
```

Nincs `npm install`: a monitorok csak a Node.js beépített moduljait és a
böngészőben futó oldalak meglévő kapcsolatait használják.

## 1. Chrome elindítása

Ha a megfelelő Chrome már fut a `9222` porton, ezt a lépést ki kell hagyni. Új
elkülönített Chrome-példány indításának példája:

```powershell
& 'C:\Program Files\Google\Chrome\Application\chrome.exe' `
  --remote-debugging-port=9222 `
  --proxy-server='socks5://127.0.0.1:1080' `
  --user-data-dir='C:\Users\regai\AppData\Local\OddsAggregatorChrome'
```

Nyisd meg ebben a Chrome-ban:

- `https://sharpxch.com/player/sport/1`
- `https://www.tippmixpro.hu/hu/fogadas/i`
- `https://vegas.hu/sports/live`

Bejelentkezés nem szükséges. Várd meg, amíg mindhárom sportfelület betölt.

A CDP ellenőrzése:

```powershell
Invoke-RestMethod 'http://127.0.0.1:9222/json' |
  Select-Object title, url
```

## 2. Monitorok indítása

### Egyszerű módszer: három PowerShell ablak

Első ablak:

```powershell
Set-Location 'C:\Users\regai\Projects\OddsAggregator'
node .\src\tippmixpro_odds_monitor.js
```

Második ablak:

```powershell
Set-Location 'C:\Users\regai\Projects\OddsAggregator'
node .\src\sharpx_odds_monitor.js
```

Harmadik ablak:

```powershell
Set-Location 'C:\Users\regai\Projects\OddsAggregator'
node .\src\vegas_odds_monitor.js
```

Az ajánlott sorrend TippmixPro → SharpX → Vegas. A SharpX létrehozza a Vegas
által olvasott watchlistet. Induláskor néhány másodpercig még hiányozhatnak a
bookmaker-sorok; a következő ciklusokban automatikusan megjelennek.

### Háttérben, naplófájlokkal

```powershell
$project = 'C:\Users\regai\Projects\OddsAggregator'
$node = 'C:\Program Files\nodejs\node.exe'

Start-Process -FilePath $node `
  -ArgumentList (Join-Path $project 'src\tippmixpro_odds_monitor.js') `
  -WorkingDirectory $project -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $project 'logs\tippmixpro_odds_monitor.log') `
  -RedirectStandardError (Join-Path $project 'logs\tippmixpro_odds_monitor.error.log')

Start-Process -FilePath $node `
  -ArgumentList (Join-Path $project 'src\sharpx_odds_monitor.js') `
  -WorkingDirectory $project -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $project 'logs\sharpx_odds_monitor.log') `
  -RedirectStandardError (Join-Path $project 'logs\sharpx_odds_monitor.error.log')

Start-Process -FilePath $node `
  -ArgumentList (Join-Path $project 'src\vegas_odds_monitor.js') `
  -WorkingDirectory $project -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $project 'logs\vegas_odds_monitor.log') `
  -RedirectStandardError (Join-Path $project 'logs\vegas_odds_monitor.error.log')
```

Ne indíts új példányt, ha ugyanaz a monitor már fut.

## 3. Működés ellenőrzése

Futó monitorok:

```powershell
Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -eq 'node.exe' -and $_.CommandLine -match 'odds_monitor'
  } |
  Select-Object ProcessId, CommandLine
```

Kimeneti fájlok frissítési ideje:

```powershell
Get-Item .\data\combined_odds.txt, .\data\football\surebets_live_odds.txt, `
  .\data\tippmixpro_odds_snapshot.json, .\data\vegas_odds_snapshot.json |
  Select-Object Name, Length, LastWriteTime
```

Az ember által olvasható oddslista:

```powershell
Get-Content .\data\combined_odds.txt -Encoding utf8 -Wait
```

Surebet lista:

```powershell
Get-Content .\data\football\surebets_live_odds.txt -Encoding utf8 -Wait
```

Normál és headless lista élő összevetése:

```powershell
& .\bin\watch_shadow_surebets.ps1
```

Hibák:

```powershell
Get-Content .\logs\sharpx_odds_monitor.error.log -Encoding utf8 -Tail 50
Get-Content .\logs\tippmixpro_odds_monitor.error.log -Encoding utf8 -Tail 50
Get-Content .\logs\vegas_odds_monitor.error.log -Encoding utf8 -Tail 50
```

Normál működésnél a `combined_odds.txt` és `surebets_live_odds.txt` másodpercenként
új időbélyeget kap. Ha nincs surebet, a `surebets_live_odds.txt` csak az aktuális fejlécet
tartalmazza.

A 300 EUR prematch matched amount határ csak a `combined_odds.txt` listájára
vonatkozik. A surebet-kereső az ennél kisebb likviditású SharpX piacokat is
figyeli, ezért a `surebets_live_odds.txt` olyan eseményt is tartalmazhat, amely a közös
oddslistában nem látható.

## 4. Leállítás

Előtérben futó monitornál nyomj `Ctrl+C`-t az adott ablakban.

Háttérfolyamatok célzott leállítása:

```powershell
$project = 'C:\Users\regai\Projects\OddsAggregator'
Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -eq 'node.exe' -and
    ($_.CommandLine -like "*$project\src\sharpx_odds_monitor.js*" -or
     $_.CommandLine -like "*$project\src\tippmixpro_odds_monitor.js*" -or
     $_.CommandLine -like "*$project\src\vegas_odds_monitor.js*")
  } |
  ForEach-Object { Stop-Process -Id $_.ProcessId }
```

## 5. Aliasszótár bővítése

A `config\team_aliases.json` canonical csapatneveket és az ismert névváltozatokat
tartalmazza. Példa:

```json
{
  "teams": {
    "qpr": [
      "QPR",
      "Queens Park Rangers"
    ]
  }
}
```

A fájl mentése után a monitorok automatikusan újraolvassák. Ugyanazt az aliast
ne add több canonical csapathoz. Az új párt előbb kezdési idő és bajnokság
alapján ellenőrizd.

## 6. Beállítások környezeti változókkal

A leggyakrabban használt felülírások:

| Változó | Alapérték |
|---|---|
| `SHARPX_CDP_ENDPOINT` | `http://127.0.0.1:9222` |
| `TIPPMIXPRO_CDP_ENDPOINT` | `http://127.0.0.1:9222` |
| `VEGAS_CDP_ENDPOINT` | `http://127.0.0.1:9222` |
| `SHARPX_PREMATCH_MIN_MATCHED` | `300` EUR |
| `SHARPX_OUTPUT_INTERVAL_MS` | `1000` |
| `SHARPX_PREMATCH_RENDER_MS` | `5000` |
| `TIPPMIXPRO_OUTPUT_INTERVAL_MS` | `1000` |
| `VEGAS_OUTPUT_INTERVAL_MS` | `1000` |
| `VEGAS_LIVE_REFRESH_MS` | `1000` |
| `VEGAS_MATCHED_REFRESH_MS` | `5000` |
| `SHARPX_OUTPUT_FILE` | `data\combined_odds.txt` a projektben |
| `SUREBETS_OUTPUT_FILE` | `data\football\surebets_live_odds.txt` a projektben |

Példa eltérő prematch limitre egy PowerShell ablakban:

```powershell
$env:SHARPX_PREMATCH_MIN_MATCHED = '500'
node .\src\sharpx_odds_monitor.js
```

## 7. Gyakori hibák

### „Nincs megnyitva ... oldal”

Ellenőrizd a `9222/json` targetlistát, a pontos oldalt és azt, hogy ugyanazt a
Chrome-példányt használod-e, amelyen a remote debugging engedélyezett.

### Nem frissülnek a Vegas sorok

Ellenőrizd a Vegas folyamatot, a `data\vegas_odds_snapshot.json` idejét, valamint a
`data\sharpx_watchlist.json` létét. Az első teljes Vegas-katalógus felépítése néhány
másodpercet igényelhet.

### Nem frissülnek a TippmixPro sorok

Ellenőrizd, hogy a TippmixPro sportoldal teljesen betöltött-e, és nézd meg a
`logs\tippmixpro_odds_monitor.error.log` fájlt. Oldalfrissítés után a collector
automatikusan megpróbál helyreállni.

### Kevés a párosított esemény

Hasonlítsd össze a kezdési időt, bajnokságot és a két csapatnevet. Ellenőrzött
névváltozat esetén egészítsd ki a `config\team_aliases.json` fájlt.
Az ismert, pontosan egyórás forráseltérést a rendszer automatikusan kezeli, de
csak erős kétoldali névegyezés és azonos bajnokságcsalád esetén.

### A surebet fájl üresnek tűnik

Ha csak a fejléc látható, pillanatnyilag nincs olyan back/lay kombináció, amely
a 2,95%-os SharpX-jutalék után is pozitív mindkét kimenetelnél. Ez normális
állapot.
