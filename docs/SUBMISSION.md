# StockRun: submission draft (Build X: X Layer × TapeOut)

> Draft for the form at https://forms.gle/EoDNbxQ65dev1wFd9. Lines marked **[you]** need your decision or your words.

## One line
An AI buying agent for Nigeria: tell it what you want, your budget and your area; it finds real sellers near you,
writes your WhatsApp message, and locks your money until you have the goods. TapeOut circuits on X Layer decide every
payment.

## The problem
Buying stock in Lagos means half a day at a market like Mile 12, or paying a seller up front and hoping the goods are
all there. Short supply and no-shows are common, and the buyer carries all the risk.

## What StockRun does
1. The buyer types what they want, a budget and an area (one word like "Ikeja" is enough).
2. The AI works out what kind of seller sells it (bulk → wholesalers, small → supermarkets) and finds the nearest real
   ones with a mobile number (OpenStreetMap today).
3. The AI writes the buyer's first WhatsApp message; one tap opens their own chat with the seller.
4. The buyer records the deal they agreed. **RestockGuard** decides whether the money may lock.
5. At the shop, with the goods in hand and the phone within ~300 m, the buyer confirms the count. **PickupCheck**
   approves the seller's payment for exactly what was counted; the rest returns to the buyer.
6. StockRun pays the seller's bank through Paystack (automatic once the account is approved). With a logistics
   company, **DeliveryCheck** decides its fee from what arrives.

## Users and how we reach them **[you]**
- Buyers: small shop owners restocking, and households buying in bulk, in Lagos first.
- Sellers: wholesalers and shops who get new buyers and payment only after the buyer has the goods.
- Reach: **[you: e.g. market associations, WhatsApp groups, pilot users from Dec 2–4]**

## Revenue, and why they pay and stay **[you]**
- **[you: e.g. a small fee per completed order, or a delivery margin]**
- Buyers stay because their money is only released for goods they counted; sellers because buyers find them.

## TapeOut on X Layer
- Three decision circuits built from NAND gates, taped out on X Layer mainnet on 2026-11-19 through the Processor
  Factory, paid for in NAND transistor tokens:
  - RestockGuard #1: 34 inputs → 5 outputs, 119 NAND, tx `0xaf6429bf2e4a7bc4e435ca493815b8b868d7728389ed904e5eb0dd2a0feca6fd`
  - PickupCheck #2: 27 → 13, 210 NAND, tx `0x24b80f4d29c57371c33357cd9b9ece03038d9016ade3e296620747c5e18bacae`
  - DeliveryCheck #3: 21 → 13, 141 NAND, tx `0x0249042e8918f77cbe4056880fc10a0d54ab3bdb4599f47fe66fa313e86d66d2`
  - Processor: `0x34efCc0a3191A48Feec787252E6d817b063A4017`
- The live app calls each circuit with `eval` for every order and pickup, and saves the input, output and block so
  anyone can re-ask the circuit and check the decision.
- The AI never moves money and never decides a payment: it finds sellers and writes messages; the circuits decide.

## Trust model (what is on-chain, what is not)
- On-chain: the circuits' rules (fixed after tapeout) and every decision's evidence.
- Not on-chain: naira balances. StockRun holds them in a double-entry ledger backed by its Paystack account and says
  so in the app. Only circuit decisions move locked money.
- Not live yet: the coin vault (`contracts/src/StockRunVault.sol`), where the buyer's own contract would hold coins
  and pay sellers on the circuits' decisions.

## Try it
- App: https://stockrun.onrender.com (free server: the first visit can take a minute to wake up; its data resets on
  restart).
- Sign in with an email code. Deposit with Paystack **test mode** (no real money): use Paystack's test card
  **[you: check the current test card on Paystack's docs before submitting]**.
- Repo: https://github.com/emmyloyal/stockrun · Video: **[you: link]**

## Honest limits
Sellers come from OpenStreetMap, which lists few Lagos wholesalers. The free host wipes data on restart. Coin payments
through the vault are not live. Paystack runs in test mode.
