# Agent Instructions for Everyday Santa (`AGENTS.md`)

## 1. Architecture Overview

Everyday Santa is a 100% static Angular 20 + Angular Material web application (`dist/everyday-santa/browser`):

- **`src/app/models/santa.model.ts`**: Data contracts for Google Contacts (`SantaContact`, `StructuredGiftProfile`, `BirthdayDate`), Holidays/Occasions (`GiftOccasionId`), UCP v`2026-08-25` Discovery & Catalog (`UcpMerchantProfile`, `UcpSearchCatalogRequest`, `UcpSearchFilters`, `UcpDetailProduct`, `UcpOffer`, `UcpCheckoutPayload`), and Secondary Filter state (`SecondaryFilterState`).
- **`src/app/services/google-contacts.service.ts`**:
  - Manages OAuth 2.0 (`https://www.googleapis.com/auth/contacts`), automatic token refresh (`https://oauth2.googleapis.com/token`), and `people.connections.list` contact imports.
  - Implements bidirectional note parsing (`parseContactNotes`) and serialization (`serializeContactNotes`) using the `[Everyday Santa]` block inside `biographies[0].value`.
  - Pushes note updates via `PATCH https://people.googleapis.com/v1/{resourceName}:updateContact?updatePersonFields=biographies` (with automatic `etag` refresh on HTTP 400/409/412) and pulls remote updates via `GET https://people.googleapis.com/v1/{resourceName}`.
- **`src/app/services/ucp-catalog.service.ts`**:
  - Implements Universal Commerce Protocol (`ucp.dev` v`2026-08-25`) `/.well-known/ucp` capability discovery, `SearchFilters` builder, `searchCatalog`, and `buildUcpCheckoutPayload`.
- **`src/app/services/ai-gift-engine.service.ts`**:
  - Synthesizes UCP `SearchCatalogRequest` queries from contact notes + occasion, scores UCP catalog products against contact `likes`, `dislikes`, `pastGifts`, `favoriteBrands`, `relationship`, and `targetBudget`, and integrates with Gemini 4 (`gemini-4-carbon`, `gemini-4-argon`, `gemini-4-hydrogen`, `gemini-3.8-flash` via `generativelanguage.googleapis.com`).

## 2. Testing & Verification

Always run both the production build and headless Karma unit test suite after any change:

```bash
export PATH="$HOME/.nvm/versions/node/v20.20.2/bin:$PATH"
cd /usr/local/google/home/fleker/dev/everyday-santa
npm run build && npm test
```
