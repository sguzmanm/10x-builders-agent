# Google Places Tools -- Implementation Plan

## Objective

Add two new agent tools powered by the Google Maps **Places API (New)** so the agent can search for places and show details with a Google Maps link. No OAuth is needed -- the API uses a server-side API key.

## API Reference

| Operation | HTTP | Endpoint |
|-----------|------|----------|
| Text Search | `POST` | `https://places.googleapis.com/v1/places:searchText` |
| Place Details | `GET` | `https://places.googleapis.com/v1/places/{PLACE_ID}` |

Both endpoints require:
- Header `X-Goog-Api-Key: <API_KEY>` for authentication.
- Header `X-Goog-FieldMask: <comma-separated fields>` to specify which fields to return (mandatory -- the API returns an error without it).

---

## New Tools

### 1. `places_search` (risk: low)

Search for places matching a free-text query. Returns a list of results with name, address, and place ID so the user can pick one.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `query` | string | yes | Free-text search (e.g. "pizza near Times Square") |
| `language` | string | no | BCP-47 language code, defaults to `"es"` |
| `max_results` | number | no | 1--20, defaults to 5 |

**API call:**

```
POST https://places.googleapis.com/v1/places:searchText
X-Goog-Api-Key: <GOOGLE_MAPS_API_KEY>
X-Goog-FieldMask: places.id,places.displayName,places.formattedAddress,places.rating,places.googleMapsUri

{
  "textQuery": "<query>",
  "languageCode": "<language>",
  "pageSize": <max_results>
}
```

**Returned to the agent (per result):**

```json
{
  "id": "ChIJ...",
  "name": "Pizzeria Uno",
  "address": "123 Main St, New York, NY",
  "rating": 4.5,
  "maps_url": "https://maps.google.com/?cid=..."
}
```

### 2. `places_detail` (risk: low)

Get detailed information about a specific place by its ID (obtained from `places_search`).

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `place_id` | string | yes | The Google Place ID (e.g. `"ChIJ..."`) |
| `language` | string | no | BCP-47 language code, defaults to `"es"` |

**API call:**

```
GET https://places.googleapis.com/v1/places/<place_id>?languageCode=<language>
X-Goog-Api-Key: <GOOGLE_MAPS_API_KEY>
X-Goog-FieldMask: id,displayName,formattedAddress,rating,userRatingCount,types,
                   nationalPhoneNumber,websiteUri,googleMapsUri,
                   regularOpeningHours,editorialSummary
```

**Returned to the agent:**

```json
{
  "id": "ChIJ...",
  "name": "Pizzeria Uno",
  "address": "123 Main St, New York, NY",
  "rating": 4.5,
  "total_ratings": 1200,
  "phone": "+1 212-555-0100",
  "website": "https://example.com",
  "maps_url": "https://maps.google.com/?cid=...",
  "types": ["restaurant", "food"],
  "hours": "Mon-Fri 11am-10pm, Sat-Sun 12pm-11pm",
  "summary": "Classic deep-dish pizza joint since 1943."
}
```

---

## Architecture

Neither tool requires user-level OAuth or integration tokens. They use a single server-side API key, which means:

- No `requires_integration` field in the catalog entries.
- No changes to `ToolContext`, `AgentInput`, or `graph.ts`.
- No new OAuth routes, no encryption, no Settings UI section for Google.
- The API key is read from env var `GOOGLE_MAPS_API_KEY` inside the tool adapter at call time.

Both tools are **read-only** (`risk: "low"`), so no confirmation flow is needed.

```
User --> Agent --> places_search (query) --> Google Places API --> list of results
User --> Agent --> places_detail (place_id) --> Google Places API --> full detail + Maps link
```

---

## Files to Modify

### 1. `packages/agent/src/tools/catalog.ts`

Add two entries to `TOOL_CATALOG`:

```typescript
{
  id: "places_search",
  name: "places_search",
  description: "Searches for places matching a text query and returns names, addresses, and ratings.",
  risk: "low",
  parameters_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Free-text search query" },
      language: { type: "string", description: "Language code (default: es)" },
      max_results: { type: "number", description: "Max results 1-20 (default: 5)" },
    },
    required: ["query"],
  },
},
{
  id: "places_detail",
  name: "places_detail",
  description: "Returns detailed information about a place by its ID, including description and a Google Maps link.",
  risk: "low",
  parameters_schema: {
    type: "object",
    properties: {
      place_id: { type: "string", description: "Google Place ID from places_search" },
      language: { type: "string", description: "Language code (default: es)" },
    },
    required: ["place_id"],
  },
},
```

### 2. `packages/agent/src/tools/adapters.ts`

Add two new tool blocks inside `buildLangChainTools()`, following the existing pattern. Each block:

1. Checks `isToolAvailable`.
2. Creates a `tool_calls` record via `createToolCall`.
3. Reads `process.env.GOOGLE_MAPS_API_KEY` -- returns an error result if missing.
4. Calls the Google Places API with `fetch`.
5. Maps the response to the slim JSON shape defined above.
6. Updates the `tool_calls` record with `updateToolCallStatus`.

Add a small helper (similar to `githubApi` if present):

```typescript
const PLACES_API = "https://places.googleapis.com/v1";

function placesApi(path: string, opts: { method?: string; body?: string; fieldMask: string }) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) throw new Error("GOOGLE_MAPS_API_KEY not set");
  return fetch(`${PLACES_API}${path}`, {
    method: opts.method ?? "GET",
    headers: {
      "X-Goog-Api-Key": key,
      "X-Goog-FieldMask": opts.fieldMask,
      "Content-Type": "application/json",
    },
    ...(opts.body ? { body: opts.body } : {}),
  });
}
```

### 3. `apps/web/src/app/settings/settings-form.tsx`

Add `"places_search"` and `"places_detail"` to the `TOOL_IDS` array so users can enable/disable them from Settings.

### 4. `apps/web/.env.local`

Add the new env var:

```
GOOGLE_MAPS_API_KEY=<your-api-key>
```

---

## Google Cloud Setup (prerequisite)

1. Go to **Google Cloud Console** > select or create a project.
2. Navigate to **APIs & Services** > **Library** > enable **Places API (New)**.
3. Go to **APIs & Services** > **Credentials** > **Create API Key**.
4. (Recommended) Restrict the key to the **Places API (New)** only and limit it by IP or referrer.
5. Copy the key to `GOOGLE_MAPS_API_KEY` in `.env.local`.

---

## Cost Awareness

The Places API (New) bills per request with field-based pricing tiers:

| Fields requested | SKU | Cost per 1000 requests |
|-----------------|-----|------------------------|
| Basic (id, displayName, formattedAddress) | Basic | ~$0 (usually within free tier) |
| + rating, openingHours, etc. | Advanced | ~$5 |
| + editorialSummary, websiteUri, phone | Preferred | ~$7 |

The `places_search` tool requests Basic + rating + googleMapsUri (Advanced tier). The `places_detail` tool requests Preferred-tier fields. Google provides $200/month free credit for Maps APIs, which covers roughly 25,000--40,000 calls depending on the tier.
