# /api/grocery/ingredient (NOT LAUNCHED: price not set)

Ingredient name (or a `/api/grocery/normalize` canonicalId) and/or a product barcode → nutrition per 100 g
(kcal, protein, fat, saturated fat, carbohydrates, sugars, fiber, sodium) with per-match source attribution.
No prices, no stock, no images, no retailer links.

## Data sources and licences
Nutrition and product data come from Open Food Facts (https://openfoodfacts.org), made available under the ODbL (database) and DbCL (contents), and from USDA FoodData Central (fdc.nal.usda.gov, public domain/CC0). Horizon Pulse is not affiliated with or endorsed by Open Food Facts or USDA. The per-call fee is for our service; the underlying data is free from those sources.

Cached Open Food Facts records are unaltered copies; full data: https://world.openfoodfacts.org/data (ODbL).

- USDA FoodData Central: bundled snapshot `lib/data/fdc-snapshot.json` (Foundation Foods, April 2026 + SR Legacy, April 2018), built by `scripts/pull-fdc.mjs` from the FDC bulk downloads (zip sha256 pinned). No outbound call.
- Open Food Facts: live product read by barcode only (no name search), at most 12 reads per minute per server instance, custom User-Agent. Records are cached unaltered for at most 24 hours, keyed by barcode, at most 2,000 records; there is no bulk, list or export endpoint, and records are never merged into Horizon Pulse tables.

## Attribution in every response
- Each Open Food Facts match: "Contains information from Open Food Facts (https://openfoodfacts.org), which is made available here under the Open Database License (ODbL) https://opendatacommons.org/licenses/odbl/1-0/. Individual contents: Database Contents License (DbCL) https://opendatacommons.org/licenses/dbcl/1-0/. Product page: https://world.openfoodfacts.org/product/<barcode>."
- Each USDA match: "Source: U.S. Department of Agriculture, Agricultural Research Service. FoodData Central, <release>. fdc.nal.usda.gov. Public domain (CC0 1.0)."

## Disclaimer (in every response)
Indicative data only. Open Food Facts data is entered by volunteers and USDA data describes generic or reported foods; values can be wrong, missing or out of date, and recipes and labels change. Allergen and ingredient fields may be incomplete: an empty or missing allergen list does NOT mean a product is free of any allergen or trace. Always check the product's own label. Not for medical, dietary or allergy decisions. Not advice.

Allergens come only from Open Food Facts contributors (`allergensSource: "open_food_facts_contributors"`). When none are listed, `allergens` is `null` and `allergensStatus` is `"unknown"`, never an empty list.

## Where to buy
Store names as listed by Open Food Facts contributors, plus the Open Food Facts product page. No retailer links; our server never contacts retailer sites.

## Not charged
400 bad input · 404 no match in any source · 502/503 Open Food Facts down or throttled when nothing else matched. Any 200 (at least one match) is billed.
