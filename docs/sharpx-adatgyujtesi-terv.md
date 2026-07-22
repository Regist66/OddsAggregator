# SharpX valós idejű, nyilvános piaci adatainak programozott lekérése

> Projektstruktúra: a monitorok a `src/`, a konfiguráció a `config/`, a
> generált fájlok a `data/`, a naplók a `logs/` könyvtárban találhatók. A
> dokumentumban szereplő rövid fájlnevek ezekre a könyvtárakra utalnak.

## 1. Cél és keretek

A cél a SharpX bejelentkezés nélkül látható fogadási kínálatának és árainak programozott feldolgozása, legfeljebb 1–2 másodperces késéssel.

Első körben csak olvasás történik:

- sportok, versenyek és események;
- piacok és kimenetelek;
- back/lay árak és elérhető összegek;
- piaci állapotok, például `OPEN`, `SUSPENDED` és `CLOSED`;
- a forrásüzenet és a helyi feldolgozás időpontja.

A terv nem tartalmaz fogadásküldést, bejelentkezést, CAPTCHA-megkerülést vagy hozzáférés-védelem kijátszását. A nyilvános megjelenítés önmagában nem jelent automatikusan engedélyt nagy volumenű adatgyűjtésre vagy továbbértékesítésre, ezért indulás előtt ellenőrizni kell a SharpX felhasználási feltételeit és lehetőleg írásos engedélyt kérni.

## 2. Sikerkritériumok

Az első működő változat akkor tekinthető sikeresnek, ha:

1. bejelentkezés nélkül elindul;
2. legalább egy kiválasztott élő vagy hamarosan induló piac teljes árlistáját felismeri;
3. az árfrissítések 95%-át 2 másodpercen belül átadja a saját alkalmazásnak;
4. kezeli a kezdeti teljes állapotot és az azt követő részleges frissítéseket;
5. kapcsolatvesztés után automatikusan újracsatlakozik és újraépíti az állapotot;
6. 2 másodpercnél régebbi adatot `stale` állapotúnak jelöl;
7. legalább 6 órán át stabilan fut adatvesztés vagy folyamatos memórianövekedés nélkül.

## 3. Javasolt technikai irány

Elsődleges megoldás: Chromium + Playwright + Chrome DevTools Protocol (CDP).

A böngészőt nem a HTML rendszeres leolvasására használjuk, hanem arra, hogy a SharpX saját webalkalmazása normál módon felépítse a hálózati kapcsolatokat. A gyűjtő a böngésző által fogadott XHR/fetch válaszokat és WebSocket-frame-eket figyeli.

Előnyök:

- ugyanazt a nyilvános adatcsatornát látjuk, mint a weboldal;
- a JavaScript által előállított tokeneket és kapcsolatparamétereket nem kell kézzel reprodukálni;
- gyorsan kiderül, hogy JSON, MessagePack, Protobuf vagy más formátum érkezik-e;
- a prototípus később lecserélhető közvetlen kliensre, ha a protokoll stabil és annak használata engedélyezett.

Közvetlen WebSocket- vagy HTTP-klienssel csak a protokoll feltérképezése és a használati feltételek ellenőrzése után érdemes próbálkozni.

## 4. Megvalósítási fázisok

### 4.1. Fázis A – kézi hálózati felderítés

Időigény: körülbelül 1–2 óra.

1. Nyissuk meg a pontos SharpX publikus URL-jét Chromiumban.
2. DevTools → Network alatt kapcsoljuk be a `Preserve log` opciót.
3. Vizsgáljuk külön a `Fetch/XHR` és `WS` forgalmat.
4. Nyissunk meg egymás után:
   - egy prematch eseményt;
   - egy in-play eseményt;
   - egy Match Odds piacot;
   - egy több kimeneteles vagy teljes árlistás piacot.
5. Jegyezzük fel:
   - a katalógust adó HTTP-kérések URL-jét és metódusát;
   - a WebSocket URL-jét és subprotocolját;
   - a feliratkozási üzeneteket;
   - a heartbeat/ping gyakoriságát;
   - hogy a frame-ek szövegesek vagy binárisak;
   - a market ID és selection ID formátumát;
   - található-e forrásoldali időbélyeg vagy sorszám.
6. Mentsünk egy rövid, érzékeny adatokat nem tartalmazó mintát:
   - egy kezdeti állapotüzenetből;
   - legalább tíz árfrissítésből;
   - egy felfüggesztési vagy piacállapot-változási üzenetből.

Kimenet: `samples/` könyvtárban anonimizált minták és egy rövid `protocol-notes.md`. A teljes HAR-t nem célszerű verziókezelésbe tenni, mert sütit, tokent vagy más azonosítót tartalmazhat.

### 4.2. Fázis B – minimális Playwright-rögzítő

Időigény: körülbelül fél nap.

Javasolt projektstruktúra:

```text
sharpx-feed/
  package.json
  .env.example
  src/
    capture.js
    decode.js
    logger.js
  samples/
  output/
```

Kezdő függőségek:

```powershell
npm init -y
npm install playwright dotenv pino
npx playwright install chromium
```

Konfiguráció:

```dotenv
TARGET_URL=https://a-pontos-sharpx-cim/
HEADLESS=false
OUTPUT_DIR=./output
```

A rögzítő első változata:

```javascript
import "dotenv/config";
import { chromium } from "playwright";

const browser = await chromium.launch({
  headless: process.env.HEADLESS === "true",
});

const context = await browser.newContext();
const page = await context.newPage();

page.on("response", async response => {
  const type = response.request().resourceType();
  if (type !== "xhr" && type !== "fetch") return;

  const contentType = response.headers()["content-type"] ?? "";
  if (!contentType.includes("json")) return;

  try {
    const body = await response.json();
    console.log(JSON.stringify({
      kind: "http",
      capturedAt: Date.now(),
      url: response.url(),
      body,
    }));
  } catch {
    // Nem minden JSON-nak jelölt válasz olvasható ki biztonságosan.
  }
});

page.on("websocket", socket => {
  console.error(`WS OPEN ${socket.url()}`);

  socket.on("framesent", frame => {
    console.error("WS SENT", frame.payload);
  });

  socket.on("framereceived", frame => {
    const payload = frame.payload;
    const value = typeof payload === "string"
      ? payload
      : payload.toString("base64");

    console.log(JSON.stringify({
      kind: "ws",
      capturedAt: Date.now(),
      binary: typeof payload !== "string",
      payload: value,
    }));
  });

  socket.on("close", () => console.error("WS CLOSED"));
});

await page.goto(process.env.TARGET_URL, { waitUntil: "domcontentloaded" });
```

Ebben a fázisban még nem kell minden adatot értelmezni. A cél annak bizonyítása, hogy a frissítések stabilan és a kívánt sebességgel rögzíthetők.

### 4.3. Fázis C – protokoll és adatmodell megfejtése

Időigény: a formátumtól függően fél–két nap.

Először el kell dönteni, milyen üzenetek érkeznek:

- közvetlen JSON;
- JSON-ba ágyazott tömörített vagy Base64-adat;
- MessagePack;
- Protobuf;
- bináris, saját formátum.

JSON esetén azonosítsuk legalább a következő fogalmakat:

```text
eventId
marketId
selectionId
marketStatus
inPlay
publishTime vagy sequence
back: [{ price, size }]
lay:  [{ price, size }]
lastTradedPrice
totalMatched
```

Fontos megkülönböztetni:

- a teljes kezdeti képet (`snapshot` vagy `image`);
- a részleges változásokat (`delta`);
- a törlést, amelyet sok feed nulla összeggel jelöl;
- a market definition vagy státusz változását;
- a heartbeat üzeneteket.

Ha nincs forrásoldali időbélyeg, pontos végponttól végpontig tartó késleltetés nem mérhető. Ilyenkor csak a böngészőbe érkezés és a saját alkalmazás általi feldolgozás közötti késés mérhető.

### 4.4. Fázis D – állapottartó normalizáló

Időigény: körülbelül 1–2 nap.

A nyers üzenetekből egy egységes, állapottartó modellt kell építeni:

```json
{
  "marketId": "1.234567890",
  "selectionId": 123456,
  "status": "OPEN",
  "inPlay": true,
  "back": [
    { "price": 2.02, "size": 184.25 }
  ],
  "lay": [
    { "price": 2.04, "size": 96.10 }
  ],
  "sourceTimestamp": 1780000000000,
  "receivedAt": 1780000000120,
  "updatedAt": 1780000000125,
  "stale": false
}
```

Javasolt belső kulcs:

```text
marketId → selectionId → price ladder
```

Szabályok:

- a `snapshot` felülírja az adott piac teljes állapotát;
- a `delta` csak a megadott árszinteket módosítja;
- nulla size törli az árszintet;
- kapcsolatvesztéskor minden érintett piac azonnal `stale` lesz;
- újracsatlakozás után új snapshot szükséges, régi cache-re nem szabad vakon továbbépíteni;
- 2000 ms forrásfrissítés nélküli aktív piac legyen `stale`, de ezt sportonként és piaconként később lehet finomítani.

### 4.5. Fázis E – saját program felé publikálás

Az első verzióhoz elegendő valamelyik:

- lokális WebSocket szerver;
- Server-Sent Events;
- Redis Pub/Sub vagy Redis Streams;
- csak teszteléshez JSON Lines fájl.

Javasolt lokális interfész:

```text
GET /health
GET /markets
GET /markets/:marketId
WS  /stream
```

A `/health` legalább ezt jelezze:

```json
{
  "browserConnected": true,
  "sourceConnected": true,
  "lastMessageAgeMs": 143,
  "activeMarkets": 327,
  "staleMarkets": 0
}
```

### 4.6. Fázis F – késleltetés- és stabilitásteszt

Mérendő mutatók:

- WebSocket-frame-ek száma másodpercenként;
- dekódolási és feldolgozási idő;
- `receivedAt - sourceTimestamp`, ha van forrásidő;
- utolsó üzenet életkora;
- újracsatlakozások száma;
- sequence gap-ek vagy kihagyott frissítések;
- memória- és CPU-használat;
- snapshot újraépítési ideje.

Tesztforgatókönyvek:

1. prematch piac 30 percig;
2. gyorsan változó in-play piac legalább 15 percig;
3. hálózat megszakítása 10 másodpercre;
4. oldal újratöltése;
5. WebSocket szerver általi bontás;
6. hatórás folyamatos futtatás;
7. az oldalon látható ár és a gyűjtött ár időbélyeges összehasonlítása.

## 5. Döntési pont az első felderítés után

### Ha az adat XHR/HTTP pollinggal érkezik

Először mérjük meg a weboldal saját lekérdezési gyakoriságát. Ha ez legfeljebb 1–2 másodperc, a válaszok böngészőn belüli figyelése megfelelő lehet. Ne növeljük önkényesen a weboldal által használt lekérdezési frekvenciát.

### Ha szöveges JSON WebSocket érkezik

Ez a legegyszerűbb eset. Playwrighttal gyorsan elkészíthető a stabil gyűjtő és a normalizáló.

### Ha bináris WebSocket érkezik

Először a frontend letöltött JavaScript-csomagjaiban kell megkeresni a dekódoló könyvtár vagy schema nyomait. Hasznos keresőkifejezések: `protobuf`, `msgpack`, `inflate`, `pako`, `decode`, `marketId`, `selectionId`, `publishTime` és a WebSocket URL-jének egyedi része. A cél a kliensben már jelen lévő formátum megértése, nem a védelem megkerülése.

### Ha nincs WebSocket és a DOM változik

Utolsó lehetőségként Playwright locatorokkal olvasható a DOM. Ez kevésbé megbízható, nehezebben ad teljes price laddert, és a virtuális listák miatt a képernyőn kívüli piacok hiányozhatnak. Az 1–2 másodperces célhoz csak korlátozott számú kiválasztott piac esetén alkalmas.

## 6. Kockázatok és kezelésük

| Kockázat | Kezelés |
|---|---|
| Frontend vagy protokoll megváltozik | Nyers minták, decoder unit tesztek, verziójelző és gyors hibadetektálás |
| Kapcsolat él, de adat nem érkezik | `lastMessageAgeMs`, stale flag és watchdog |
| Delta elveszik | Sequence ellenőrzés, cache eldobása, teljes újracsatlakozás/snapshot |
| Sok piac túlterheli a klienst | Csak szükséges sportokra/piacokra feliratkozás, backpressure és batch feldolgozás |
| Időbélyegek pontatlanok | NTP-szinkronizált gép, monotonic clock a belső mérésekhez |
| Feltételek tiltják az automatizálást | Írásos engedély vagy licencelt adatforrás használata |
| Nyilvános feed mégis rövid életű tokent használ | A kapcsolatot a böngésző építse fel; ne tároljuk és ne publikáljuk a tokent |

## 7. Első konkrét mérföldkő

Az első mérföldkő egy legfeljebb egy nap alatt elkészíthető technikai próba:

1. a pontos `TARGET_URL` rögzítése;
2. egy prematch és egy in-play piac hálózati forgalmának megfigyelése;
3. a feed típusának azonosítása;
4. legalább 100 egymást követő árfrissítés rögzítése;
5. market ID, selection ID, ár, size és státusz kinyerése;
6. a frissítési intervallum és a helyi feldolgozási késés riportálása;
7. go/no-go döntés a teljes gyűjtő elkészítéséről.

Go feltétel: az adat strukturáltan elérhető, stabilan összerendelhető a piacokkal, és a megfigyelt frissítés legalább az esetek 95%-ában belefér a 2 másodperces célba.

No-go vagy újratervezési feltétel: a publikus nézet eleve késleltetett, az adat csak képi formában érkezik, a használati feltételek tiltják a szükséges automatizálást, vagy a feed nem tartalmaz megbízható piacazonosítókat.

## 8. Induláshoz szükséges információ

A megvalósítás megkezdéséhez egyetlen kötelező bemenet kell: annak a SharpX publikus oldalnak a pontos URL-je, ahol bejelentkezés nélkül láthatók az élő oddsok. Ezután az A és B fázis végrehajtható anélkül, hogy Betfair-hozzáférésre vagy SharpX-fiókra lenne szükség.

## 9. TippmixPro integráció (megvalósítva 2026-07-22)

A TippmixPro sportfelülete WAMP protokollt használ a
`wss://sportsapi.tippmixpro.hu/v2` WebSocketen. A gyűjtő a már megnyitott,
SOCKS5 proxyn futó Chrome `sports2.tippmixpro.hu` iframe-jében kapcsolódik,
így nem igényel bejelentkezést vagy külön hitelesítő adatot.

Az alkalmazott azonosítók:

- labdarúgás: `sportId=1`;
- rendes játékidős 1X2: `b69_ep3`, `bettingTypeId=69`;
- Szuper odds 1X2 tartalék: `b693_ep3`, `bettingTypeId=693`;
- események: `MATCH` rekordok;
- oddsok: `BETTING_OFFER.odds`;
- valós idejű változások: WAMP `INVOCATION` (`UPDATE`) rekordok.

A `tippmixpro_odds_monitor.js` közvetlen RPC-hívásokkal deríti fel az aktív
helyszíneket és bajnokságokat, majd bajnokság-topicokra és a szükséges
`bettingOffers` topicokra iratkozik fel. Nem DOM-szöveget olvas és nem csak a
képernyőn látható mérkőzéseket kezeli. A pillanatképet másodpercenként a
`tippmixpro_odds_snapshot.json` fájlba írja.

A `sharpx_odds_monitor.js` kezdési idő és normalizált/fuzzy csapatnév alapján
párosítja a TippmixPro eseményeket a SharpX-listához. A kimenetben a
`TippmixPro` sor közvetlenül a megfelelő `SharpX` sor alatt jelenik meg. A
normál TippmixPro 1X2 külön `TippmixPro`, a Szuper odds 1X2 pedig külön
`TippmixPro**` sorban szerepel; ha mindkettő elérhető, mindkét sor megjelenik.
Mindkét folyamat automatikusan
újrainicializálja a böngészőoldali gyűjtőt, ha az iframe CDP execution contextje
egy oldalfrissítés miatt megváltozik.

A már ellenőrzött csapatnév-változatok a `team_aliases.json` dictionary-ban
találhatók. A monitor ezt használja elsőként, és csak ismeretlen névnél tér át
fuzzy párosításra. A fájl módosítási idejét minden kimeneti ciklusban ellenőrzi,
ezért új alias felvétele nem igényli a folyamat újraindítását. Egy alias csak
egyetlen canonical csapathoz tartozhat; az ütközést a monitor hibaként jelzi.

## 10. Vegas integráció (megvalósítva 2026-07-22)

A `vegas.hu/sports` felület az Altenar WSDK-t ágyazza be. A publikus
sportadatok REST-végpontokon érkeznek a
`hu-sb2frontend-altenar2.biahosted.com` hosztról. A gyűjtő a SOCKS5 proxyn
futó, `9222` CDP porton elérhető Chrome Vegas lapjának fő execution
contextjében kérdezi le ezeket, ezért ugyanazt az ország- és integrációs
konfigurációt használja, mint a képernyőn látható oldal.

Az alkalmazott azonosítók és végpontok:

- labdarúgás: `sportId=66`, sporttípus: `typeId=1`;
- rendes játékidős 1X2 piac: market `typeId=1`;
- 1, X, 2 kimenet: odd `typeId=1`, `2`, `3`;
- Odds+ kínálat: `GetEnhancedOdds`, marketnév `1X2 - Odds+`;
- az Odds+ esemény normál 1X2 ára: `GetEventDetails`, marketnév `1X2`;
- sport- és bajnokságlista: `GetSportMenu`;
- bajnokságonkénti prematch katalógus: `GetEventsByChamp`;
- kiválasztott események célzott frissítése: `GetEventsById`;
- teljes élő labdarúgás: `GetLiveOverview&sportId=66`.

A `vegas_odds_monitor.js` induláskor felépíti a teljes labdarúgó katalógust.
Ezután a SharpX monitor által másodpercenként írt
`sharpx_watchlist.json` alapján csak a releváns prematch események oddsait
frissíti 5 másodpercenként. Az élő labdarúgás ettől függetlenül 1 másodperces
REST pollingot kap, így a prematch kínálat nagysága nem lassítja az in-play
feldolgozást. A teljes katalógus 5 percenként újraépül.

A normalizált Vegas-pillanatkép a `vegas_odds_snapshot.json` fájlba kerül. A
`sharpx_odds_monitor.js` ezt kezdési idő és csapatnév alapján párosítja, majd a
`Vegas` sort a megfelelő SharpX esemény alatt jeleníti meg. Ha ugyanahhoz az
eseményhez Odds+ 1X2 ajánlat is tartozik, az külön `Vegas**` sorban jelenik meg.
A két piacot külön azonosító és külön oddslista alapján kezeli, ezért a normál
árat nem írja felül az Odds+ ajánlat. A megszűnt Odds+ sort a következő sikeres
lekérdezési ciklus eltávolítja. A Vegas monitor is hot reloadolja a
`team_aliases.json` dictionary-t. A bevezetéskori ellenőrzés
817 Vegas labdarúgó eseményt talált; a 104 figyelt SharpX eseményből 102-höz
talált biztos Vegas-párt. A két fennmaradó eseményhez nem volt megfelelő Vegas
esemény a kezdési idő 30 perces környezetében.

Futtatási sorrend:

1. a proxyn indított Chrome-ban legyen megnyitva a SharpX soccer oldal, a
   TippmixPro sportoldal és `https://vegas.hu/sports/live`;
2. induljon el a `tippmixpro_odds_monitor.js`;
3. induljon el a `sharpx_odds_monitor.js`;
4. induljon el a `vegas_odds_monitor.js`.

A három collector egymástól külön Node folyamat. Egy TippmixPro- vagy
Vegas-hiba ezért nem állítja le a SharpX feedet és a már rendelkezésre álló
adatok fájlba írását.

A SharpX, TippmixPro és Vegas összepárosított, ember által olvasható kimenete
másodpercenként a `combined_odds.txt` fájlba kerül. A korábbi
`sharpx_odds_summary.txt` fájlnév már nincs használatban.

## 11. Surebet lista

A `sharpx_odds_monitor.js` minden kimeneti ciklusban kimenetelenként összeveti
a Tippmix/Vegas back oddsot a SharpX lay oddsszal. A SharpX nyereségére 2,95%
jutalékot számol. Ha a bookmaker back tétje `S`, back oddsa `B`, a SharpX lay
oddsa `L`, a kiegyenlítő lay tét pedig `X`, akkor:

`X = S × B / (L - 0,0295)`

Mindkét lehetséges eredmény akkor pozitív, ha:

`B × (1 - 0,0295) > L - 0,0295`

Ha egy esemény legalább egy 1/X/2 kimenetele megfelel ennek, az esemény az
másodpercenként atomikusan újraírt `football\\surebets_live_odds.txt` fájlba kerül. A fájl az
időbélyeges fejléc után a SharpX lay oddsot, valamint az összes párosított
Tippmix, Tippmix**, Vegas és Vegas** sort tartalmazza. Élő eseménynél az
eseménynév `** ` prefixet kap. Ha pillanatnyilag nincs surebet, a fájlban csak
az aktuális fejléc marad.

A surebet-vizsgálat a teljes jövőbeli és élő SharpX Match Odds kínálatra fut.
A 300 EUR matched amount prematch küszöb kizárólag a `combined_odds.txt`
megjelenítési szűrője; az alacsonyabb likviditású piacokat nem zárja ki a
surebet-keresésből.
