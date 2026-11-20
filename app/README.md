# App

Phone-first web app with two modes, owner and rider. It is built with React and Vite. It works with either of the agent's servers and picks the mode from `/api/config`:
- **Single-shop demo** (`npm run app`, `agent/src/server/api.ts`): demo keys, no sign-in. Described below.
- **Real accounts** (`npm run serve` or `serve:xlayer`, `agent/src/server/app.ts`): `src/Account.tsx`. The owner signs in by SMS, makes the phone's key with a PIN backup (`src/keys.ts`), sets up the shop, deposits, approves suppliers, then orders. See "App servers" in `agent/README.md`. Rider screens for real accounts are not built yet.

## Try real accounts locally
```
cd app && npm install && npm run build
cd ../agent && npm run serve                # http://localhost:8080, local chain; SMS codes appear in this console
```
Sign in as a shop owner, tap "Get test money", deposit, approve a supplier, then skip the 24 h wait with the test-chain control (`POST /api/dev/advance-day`). Choose "I'll collect them myself" to finish an order on your own: after it locks, confirm the count and the supplier is paid. "Send them with a logistics company" books the simulated company on the local server.

## Run the local demo
```
cd app && npm install && npm run build     # once, or after changing the app
cd ../agent && npm run app                 # http://localhost:8080
```
- **Everything is local.** The vault runs on a local anvil chain and the suppliers are simulated bots.
- **Photo check** needs `GEMINI_API_KEY` in `.env`.
- **Demo links:** `http://localhost:8080/?role=owner` and `/?role=rider` open a mode directly.
- **To work on the app:** keep `npm run app` running and use `npm run dev` in `app/`. Vite forwards `/api` and `/rpc` to port 8080.

## Who signs what
| Step | Signed by | Where |
| --- | --- | --- |
| Approve an "ask owner" order (`approveOrder`) | Owner | Owner's browser |
| Confirm delivery or report a problem (`ownerConfirm`) | Owner | Owner's browser |
| Rider's count and "at the supplier" (`riderPickup`) | Rider | Rider's browser |
| "At the shop" (`riderArrive`) | Rider | Rider's browser |
| Propose an order | Agent key | Server |
| Photo count (`attestPickup`, `attestDelivery`) | Check key | Server |
| Settle (runs the circuit) | Anyone | Server |

- **The server never holds the owner's or rider's key.** Browsers reach the chain through the server's `/rpc` relay.
- **The relay is limited.** It only passes standard `eth_*` calls, so a browser cannot use test-node controls such as time travel.
- **In the local demo**, the owner and rider sign with anvil's public test keys.

## Owner mode
- **Map** (Leaflet + OpenStreetMap tiles, no API key):
  - the shop and the search radius (5, 10 or 15 km);
  - suppliers coloured by their status in the vault: preferred, approved, or not approved (suggest only). Blocked suppliers are never shown;
  - a line from supplier to shop for every order in progress;
  - tapping a supplier shows each item's price, where it came from (agreed, quoted, price list, or StockRun list price) and how old it is.

  A plain list of the same suppliers sits under the map.
- Order box: free text, read by the agent.
- Order list: status, price, a progress bar (escrow → pickup → delivery → rider paid) and the circuit's decision in plain words, with transaction hashes.
- Buttons: approve an order that needs the owner's OK; confirm delivery or report a problem.

## Rider mode
- Job list, then one screen per job.
- **At the supplier:**
  1. Location check: GPS within 150 m of the pin, or a labelled "Demo: simulate being there" switch.
  2. Enter your count and sign it.
  3. Take a photo. The photo check counts the goods and PickupCheck pays the supplier for the lower of the photo count and your count.
- **At the shop:** the same steps without the count, then DeliveryCheck.
- Photos are shrunk to at most 1,600 px JPEG on the phone before upload.

## Not built yet
- **Live rider position on the map:** the map shows the supplier-to-shop line, but not where the rider is.
- **Road distances:** distances are straight-line.
- **Own map tiles:** the demo uses openstreetmap.org tiles, whose usage policy covers light use only. A pilot with real traffic needs its own tile provider.
- **Real wallets:** sign-in and deployment to DeWEB. Today the demo keys are built in.
- **Signed GPS:** location is checked in the rider's browser and the rider signs the result. The check service does not verify it yet.
- **GPS and camera on a phone over plain `http://`:** browsers block them. Testing on a phone needs HTTPS, for example the cloudflared tunnel.
- **Reason codes for RestockGuard rejections:** these show as plain words in the order message, but not yet as a separate badge.

## Hosting on DeWEB
The built app is stored on X Layer under our circuit #1 as `1.2.433.tape`, served at `https://1-2-433.tapekit.org/`. The server runs elsewhere, at a public HTTPS address.
```
cd app && npm run build
cd ../agent && npm run deweb:publish -- --api https://<server>             # rehearsal on a local fork: shows the cost
cd ../agent && npm run deweb:publish -- --api https://<server> --live      # publishes (deployer key, real OKB)
```
- **Cost:** about 0.084 OKB the first time, measured on a fork on 2026-11-20. That is 0.08 OKB to open the container once, and about 0.0043 OKB to store 724 KB. The name fee is 0 at the moment; fees are read live. Later publishes rewrite only the files that changed.
- **The server address** lives in `stockrun-config.json` next to `index.html`. Moving the server means republishing that one small file.
- **On the server**, set `ALLOWED_ORIGINS=https://1-2-433.tapekit.org`. The app on DeWEB signs in with a bearer token, not a cookie.
- **What the gateway allows:** its site policy permits `fetch` to any `https:` origin, and only loads scripts from the chain. Calls to our server show as "off-chain" in the gateway's status page. That is honest: sign-in, the agent and logistics run on the server.
