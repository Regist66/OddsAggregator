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
