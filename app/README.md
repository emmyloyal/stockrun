# App

Phone-first web app with two modes, owner and rider. It is built with React and Vite, and talks to the agent's API (`agent/src/server/api.ts`).

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
| Rider's count and "at the supplier" (`riderPickup`) | Rider | Rider's browser |
| "At the shop" (`riderArrive`) | Rider | Rider's browser |
| Propose an order | Agent key | Server |
| Photo count (`attestPickup`, `attestDelivery`) | Check key | Server |
| Settle (runs the circuit) | Anyone | Server |

- **The server never holds the owner's or rider's key.** Browsers reach the chain through the server's `/rpc` relay.
- **The relay is limited.** It only passes standard `eth_*` calls, so a browser cannot use test-node controls such as time travel.
- **In the local demo**, the owner and rider sign with anvil's public test keys.

## Owner mode
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
- **Map:** Leaflet + OpenStreetMap, showing suppliers, the radius and the rider's route.
- **Real wallets:** sign-in and deployment to DeWEB. Today the demo keys are built in.
- **Signed GPS:** location is checked in the rider's browser and the rider signs the result. The check service does not verify it yet.
- **GPS and camera on a phone over plain `http://`:** browsers block them. Testing on a phone needs HTTPS, for example the cloudflared tunnel.
- **Reason codes for RestockGuard rejections:** these show as plain words in the order message, but not yet as a separate badge.
