# Supplier messaging

- Channel: WhatsApp Business Platform (Cloud API) from StockRun's own number.
- First contact must be an **approved template** (business-initiated). Free-form chat only inside the 24-hour
  customer service window that opens when the supplier replies.
- Since July 1, 2025 Meta charges per delivered template message; rates depend on category and country.
  Use **utility** templates for order requests (cheaper than marketing).
- Fallback: AI voice call (e.g. Twilio) if no reply in ~15 minutes or no WhatsApp; SMS for pickup confirmation.

## Template draft (utility): `order_request`
> Hello {{1}}, StockRun wants to buy {{2}} for pickup today. Payment is made when our rider checks the goods at your shop. Please reply with your price.

## Negotiation guardrails for the agent
- Never promise payment before pickup verification.
- Never exceed the per-unit price the owner allowed; propose the order to the vault and let RestockGuard decide.
- Save the agreed price, quantity and pickup window to the order record.

## Demo
- Cloud API test number; one real supplier who agreed to take part; two simulated supplier bots.
