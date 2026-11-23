# App

Phone-first web app for buyers and shop owners. It is built with React and Vite. It works with either of the agent's servers and picks the mode from `/api/config`:
- **Single-shop demo** (`npm run app`, `agent/src/server/api.ts`): demo keys, no sign-in. Described below.
- **Real accounts** (`npm run serve` or `serve:xlayer`, `agent/src/server/app.ts`): `src/Account.tsx` and friends. People sign in
  with an emailed code or a wallet, add naira (Paystack) or USD₮0 (their own vault), find sellers, record deals, collect and
  count. Shops register a store, post on the feed and chat with buyers; admins get `src/Admin.tsx` and
  `src/AdminControls.tsx`. This is what runs at https://stockrun-ai.duckdns.org. See "App servers" in `agent/README.md`.

## Try real accounts locally
```
cd app && npm install && npm run build
cd ../agent && npm run serve                # http://localhost:8080, local chain; sign-in codes appear in this console
```
Sign in with any email (the code is printed in the console), add free demo naira under **Money** (local only, labelled
"not real money"), then on **Ask** find sellers and record a deal. After it locks, go to **Orders**, count what you
collected, and PickupCheck approves the seller's payment for that many. The local server also has demo bot sellers and
"Try the demo agent"; neither exists on the live site.

## Run the local demo
```
cd app && npm install && npm run build     # once, or after changing the app
cd ../agent && npm run app                 # http://localhost:8080
```
- **Everything is local.** The vault runs on a local anvil chain and the suppliers are simulated bots.
- **Photo check** needs `GEMINI_API_KEY` in `.env`.
- **To work on the app:** keep `npm run app` running and use `npm run dev` in `app/`. Vite forwards `/api` and `/rpc` to port 8080.

## Who signs what
| Step | Signed by | Where |
| --- | --- | --- |
| Approve an "ask owner" order (`approveOrder`) | Owner | Owner's browser |
| Confirm delivery or report a problem (`ownerConfirm`) | Owner | Owner's browser |
| Count at the supplier, self-pickup (`riderPickup`) | Owner | Owner's browser |
| Pickup and arrival, logistics company (`riderPickup`, `riderArrive`) | That company's dispatch key, on the company's own status | Server |
| Propose an order | Agent key | Server |
| Photo count (`attestPickup`, `attestDelivery`) | Check key | Server |
| Settle (runs the circuit) | Anyone | Server |

- **The server never holds the owner's key.** Browsers reach the chain through the server's `/rpc` relay.
- **The relay is limited.** It only passes standard `eth_*` calls, so a browser cannot use test-node controls such as time travel.
- **In the local demo**, the owner signs with anvil's public test key.

## Owner mode
- **Map** (Leaflet + OpenStreetMap tiles, no API key):
  - the shop and the search radius (5, 10 or 15 km);
  - suppliers coloured by their status in the vault: preferred, approved, or not approved (suggest only). Blocked suppliers are never shown;
  - a line from supplier to shop for every order in progress;
  - tapping a supplier shows each item's price, where it came from (agreed, quoted, price list, or StockRun list price) and how old it is.

  A plain list of the same suppliers sits under the map.
- Order box: free text, read by the agent.
- Order list: status, price, a progress bar (escrow → pickup → delivery → delivery paid) and the circuit's decision in plain words, with transaction hashes.
- Buttons: approve an order that needs the owner's OK; confirm delivery or report a problem.

## No rider accounts
StockRun has no rider accounts and no bonds. The owner collects the goods, or a verified logistics company delivers them (`agent/src/logistics/`). The old rider screens were removed on 2026-11-20.

## Not built yet
- **Live courier position on the map:** use the logistics company's tracking link on the order.
- **Road distances:** distances are straight-line.
- **Own map tiles:** the demo uses openstreetmap.org tiles, whose usage policy covers light use only. A pilot with real traffic needs its own tile provider.
- **GPS and camera on a phone over plain `http://`:** browsers block them. Testing on a phone needs HTTPS, for example the cloudflared tunnel.
- **Reason codes for RestockGuard rejections:** these show as plain words in the order message, but not yet as a separate badge.

## Hosting on DeWEB (built, not used)
The live app is served by the StockRun server on AWS. Publishing it to DeWEB (stored on X Layer under our circuit #1 as
`1.2.433.tape`, served at `https://1-2-433.tapekit.org/`) is built and rehearsed on a fork, but it has not been published.
The server would keep running elsewhere, at a public HTTPS address.
```
cd app && npm run build
cd ../agent && npm run deweb:publish -- --api https://<server>             # rehearsal on a local fork: shows the cost
cd ../agent && npm run deweb:publish -- --api https://<server> --live      # publishes (deployer key, real OKB)
```
- **Cost:** about 0.084 OKB the first time, measured on a fork on 2026-11-20. That is 0.08 OKB to open the container once, and about 0.0043 OKB to store 724 KB. The name fee is 0 at the moment; fees are read live. Later publishes rewrite only the files that changed.
- **The server address** lives in `stockrun-config.json` next to `index.html`. Moving the server means republishing that one small file.
- **On the server**, set `ALLOWED_ORIGINS=https://1-2-433.tapekit.org`. The app on DeWEB signs in with a bearer token, not a cookie.
- **What the gateway allows:** its site policy permits `fetch` to any `https:` origin, and only loads scripts from the chain. Calls to our server show as "off-chain" in the gateway's status page. That is honest: sign-in, the agent and logistics run on the server.
