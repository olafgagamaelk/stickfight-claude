# STIKKAOS Online

En online multiplayer-udgave af den fysikbaserede stickman-brawler. Serveren
kører den fysiske simulation autoritativt (så alle spillere ser samme
resultat), og hver spiller forbinder fra sin egen computer via browseren.

## Mappestruktur

```
stikkaos-online/
├── package.json        ← afhængigheder + startscript
├── render.yaml          ← valgfri "blueprint" til Render
├── server/
│   ├── index.js         ← Express + WebSocket-server, rum/lobby-styring
│   └── game.js           ← selve spil-simuleringen (fysik, baner, våben, runder)
└── public/               ← alt det spillerne downloader i browseren
    ├── index.html         ← menu/lobby/spil-skærm
    ├── client.js           ← netværk, rendering, ragdoll-animation, input
    └── style.css
```

## 1. Kør det lokalt (test før du deployer)

Kræver [Node.js](https://nodejs.org) version 18 eller nyere.

```bash
cd stikkaos-online
npm install
npm start
```

Åbn `http://localhost:3000` i browseren. Åbn den samme adresse i et par
faner/browsere for at teste flere spillere på din egen maskine, inden du
deler den med andre.

## 2. Læg det på GitHub

Render henter koden fra et GitHub-repository. Hvis du ikke allerede har et:

```bash
cd stikkaos-online
git init
git add .
git commit -m "Første version af STIKKAOS Online"
```

Opret et nyt, tomt repository på github.com, og følg instruktionerne der
til at "push" din lokale kode op (typisk noget i stil med):

```bash
git remote add origin https://github.com/DIT-BRUGERNAVN/stikkaos-online.git
git branch -M main
git push -u origin main
```

## 3. Opret en "Web Service" på Render

1. Gå til [render.com](https://render.com) og log ind (eller opret en konto).
2. Klik **New +** → **Web Service**.
3. Vælg dit GitHub-repository (`stikkaos-online`).
4. Render finder automatisk `render.yaml` og udfylder det meste selv. Hvis
   ikke, sæt disse felter manuelt:
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: `Free` er fint til at komme i gang
5. Klik **Create Web Service**.

Render bygger og starter serveren automatisk. Efter et par minutter får du
en adresse i stil med:

```
https://stikkaos-online.onrender.com
```

Den adresse er dit spil. Del den med dine venner — de skal bare åbne linket
i deres egen browser.

**Vigtigt:** Serveren lytter automatisk på den port, Render sætter via
miljøvariablen `PORT` (det er allerede indbygget i `server/index.js`), så
du skal ikke selv konfigurere noget port-nummer.

## 4. Sådan spiller I sammen

1. Én person åbner linket, taster evt. sit navn ind, og trykker
   **"Opret rum"**. De får en 4-tegns kode (fx `KX9P`).
2. De andre åbner samme link, taster koden ind under **"Deltag"**.
3. Alle trykker **"Klar"** i lobbyen.
4. Værten (den første, der oprettede rummet) trykker **"Start kamp"**.
5. Countdown → kamp → runde-vinder → stilling → næste runde, indtil en
   spiller vinder 3 runder.

Op til 4 spillere pr. rum. Hver spiller styrer med sit eget tastatur
(WASD/piletaster til at bevæge sig, W/Pil op/Space for at hoppe — hold
inde for at sigte op, S/Pil ned for at sigte ned, F/Enter/J for at
angribe/skyde) eller en tilsluttet controller.

## Bemærkninger om "gratis"-hosting på Render

- Render's gratis plan sætter tjenesten i dvale efter et stykke tids
  inaktivitet. Første besøg efter en pause kan derfor tage 20-50 sekunder,
  mens serveren starter op igen — det er normalt, ikke en fejl.
- Al spil-logik (fysik, skade, hvem der vinder) beregnes på serveren, så
  spillet er "fair" uanset hvor god ens egen computer eller forbindelse er.
  Klienten tegner blot det, serveren fortæller den.
- Rum ryddes automatisk op, når alle spillere i rummet har forladt/lukket
  fanen.

## Videreudvikling

- `server/game.js` indeholder al spillogik og er uafhængig af Express/WS,
  så den også kan genbruges, hvis du fx senere vil skrive automatiske tests.
- Bane-geometrien er bevidst duplikeret ét sted i `server/game.js` (til
  fysik) og ét sted i `public/client.js` (til visning). Hvis du ændrer eller
  tilføjer en bane, skal du opdatere begge steder, så de matcher.
