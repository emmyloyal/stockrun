# App (to build Nov 28 – Dec 3)

Mobile web app with two modes, scaffolded with TapeCode and deployed to DeWEB.

## Owner mode
- Order box (text; voice if time allows) and the saved "usual order"
- Map (Leaflet + OpenStreetMap): suppliers with price, distance, status; live rider route
- Approval screen for ASK_OWNER orders, showing the reason code in plain words
- Delivery confirmation + issue report; order history with circuit verdicts and tx links

## Rider mode
- Job list; pickup and delivery photo capture; quantity entry; GPS check-in; bond balance

## Reason codes → plain words
| Circuit | Code | Text |
| --- | --- | --- |
| RestockGuard | 1 | Supplier not approved |
| RestockGuard | 2 | Over this week's budget |
| RestockGuard | 3 | Above your auto-approve limit |
| RestockGuard | 4 | This category needs your OK |
| RestockGuard | 5 | Supplier is far away |
| PickupCheck | 1 | Rider not at the supplier |
| PickupCheck | 2 | Rider bond too low |
| PickupCheck | 3 | Damaged goods — supplier to replace |
| PickupCheck | 4 | No goods counted |
| PickupCheck | 5 | Short supply — paying for what was counted |
| DeliveryCheck | 1 | Rider not at your shop yet |
| DeliveryCheck | 2 | Your report conflicts with the photo — under review |
| DeliveryCheck | 3 | Damage reported — under review |
| DeliveryCheck | 4 | Short delivery — you're compensated from the rider's bond |
| DeliveryCheck | 5 | Waiting for your confirmation |
