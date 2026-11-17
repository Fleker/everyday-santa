# 🎁 Everyday Santa — AI + UCP Gift Discovery & Google Contacts Sync

**Everyday Santa** is a 100% static, serverless web application built with **Angular 20** (standalone components + Angular Signals) and **Angular Material** that connects your **Google Contacts** (`people.googleapis.com`), **Gemini AI**, and the **Universal Commerce Protocol (UCP v`2026-08-25`, `ucp.dev`)** for year-round gift discovery.

---

## 1. Key Capabilities

1. **Select People from Google Contacts (`people.connections.list`)**:
   - Pulls contacts, birthdays (`birthdays[0].date`), relationships, and personal notes (`biographies[0].value`) directly from the Google People API v1.
   - Lets you curate which people belong to your active **Gift Circle** (with filters for *Has Birthday* and *Has Notes*).
2. **Bidirectional Google Contacts Note Sync (`people.updateContact`)**:
   - Edit structured gift preferences (**Likes**, **Dislikes / Allergies**, **Sizes**, **Favorite Brands**, **Target Budget**, and **Freeform Notes**) or switch to the **Raw Google Note (`biographies[0].value`)** view to edit the `[Everyday Santa]` block directly.
   - **Push to Google Contacts**: Calls `PATCH https://people.googleapis.com/v1/{resourceName}:updateContact?updatePersonFields=biographies` with optimistic concurrency (`etag` handling + automatic conflict retry).
   - **Pull from Google Contacts**: Calls `GET https://people.googleapis.com/v1/{resourceName}` so notes you jot down in the Google Contacts mobile app on your phone sync straight back into Everyday Santa.
3. **Year-Round Occasion & Holiday Engine**:
   - **🎂 Birthdays**: Computes upcoming birthday countdowns and turning ages per contact.
   - **🎄 Christmas (Dec 25)**: Holiday gift planner with countdown.
   - **💐 Mother's Day (2nd Sunday in May)** & **👔 Father's Day (3rd Sunday in June)**: Automatically highlights maternal/paternal contacts and tailors UCP discovery queries.
   - **💝 Anniversary & Valentine's**: Milestone gift curation for partners.
4. **Universal Commerce Protocol (`ucp.dev` v`2026-08-25`) Product Discovery & Checkout**:
   - **Merchant Capability Discovery (`/.well-known/ucp`)**: Inspects and probes merchant `/.well-known/ucp` profiles declaring `dev.ucp.shopping.catalog.search`, `dev.ucp.shopping.catalog.lookup`, `dev.ucp.shopping.cart`, `dev.ucp.shopping.checkout`, `dev.ucp.shopping.fulfillment`, and `com.google.pay`.
   - **Catalog Search & Secondary Product Filters (`SearchCatalogRequest` + `SearchFilters`)**:
     - Maps UI secondary filters directly to UCP `SearchFilters` (`categories`, `price.min`, `price.max`, and `additional_properties`: `in_stock_only`, `free_shipping`, `max_delivery_days`, `free_returns`, `one_click_ucp_checkout`, `merchant_ids`, `min_rating`, `search_keyword`, and `sort_by`).
   - **1-Click Agentic Checkout (`dev.ucp.shopping.checkout`)**: Generates spec-compliant UCP `CreateCheckout` payloads with gift recipient context and fulfillment extensions while preserving the retailer as Merchant of Record.

---

## 2. Local Development & Commands

```bash
export PATH="$HOME/.nvm/versions/node/v20.20.2/bin:$PATH"
cd /usr/local/google/home/fleker/dev/everyday-santa

# Start dev server on http://localhost:4206
npm start

# Run headless Karma/Jasmine unit tests
npm test

# Build static production bundle into dist/everyday-santa/browser
npm run build
```

---

## 3. Setting Up Live Google Contacts OAuth 2.0 (Zero Backend, Permanent Refresh Token)

1. Open the [Google Cloud Console](https://console.cloud.google.com/) and enable the **Google People API**.
2. Under **Google Auth Platform / OAuth consent screen**:
   - Add scopes:
     - `https://www.googleapis.com/auth/contacts` (required for bidirectional read/write note sync)
     - `https://www.googleapis.com/auth/userinfo.email`
   - Set **Publishing status** to **In Production** so your OAuth `refresh_token` does not expire every 7 days.
3. Under **Credentials → Create Credentials → OAuth client ID (Web application)**:
   - Add Authorized JavaScript Origin: `http://localhost:4206` (and `https://fleker.github.io` if hosted on GitHub Pages).
   - Add Authorized Redirect URI: `http://localhost:4206/` (and `https://fleker.github.io/everyday-santa/`).
4. In Everyday Santa, click **Google OAuth & AI** in the top toolbar, paste your **Client ID**, **Client Secret**, and optional **Gemini API Key**, and click **Authorize & Connect Google Contacts**.
