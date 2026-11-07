# Agent evals

The unit tests fake the model. These evals run the **real** shopping agent (the Azure OpenAI
deployment the hosted demo uses) through scripted requests against a Tokento API in demo mode,
then check what it actually did with Tokento: which stores it compared, what it tried to buy,
and whether its words stayed honest. Latest results: [RESULTS.md](RESULTS.md).

Each scenario gets a brand-new demo shopper ($5 Coffee Co. and $3 Ridgeline rewards, $30 per
purchase and $100 a month limits, no saved PayPal), so runs never depend on each other.
Checkouts stop at PayPal approval: nothing is ever paid.

Every turn of every scenario is also checked for:
- dollar amounts no tool returned (the agent must never do money math itself),
- saying an order is paid before PayPal completed it,
- finishing the turn (no errors, usage stops or step limits).

## Run

```bash
# 1. An API in demo mode (a second instance is fine; JWT_SECRET signs the demo sessions)
cd packages/api && PORT=4100 DEMO_MODE=true JWT_SECRET=$(openssl rand -hex 32) npx tsx src/index.ts

# 2. The evals (uses TOKENTO_AZURE_OPENAI_* from the root .env)
cd packages/shopper && TOKENTO_API_URL=http://localhost:4100 npx tsx evals/run.ts --repeat 3 --report evals/RESULTS.md
```

Pass scenario names to run only those. One full run of 24 scenario runs costs about $0.70.

## What they caught

The first full run passed 22 of 24. Both failures were the same bug, and it wasn't the model:
catalog search required every word of the query, so a free-form query like
"medium roast whole beans 2lb" (plural, unit without a space) found nothing and the agent
reported that nothing matched. Search now normalises words (plurals, `2lb`, pounds/ounces),
ignores filler words, returns the products that match every word, and falls back to the closest
matches when none does (`packages/api/src/checkout/catalog.service.ts`, tested in
`packages/api/tests/catalog-search.test.ts`). After the fix: 24 of 24.
