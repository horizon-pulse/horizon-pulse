/**
 * /api/grocery/ingredient output example: response recorded from the handler
 * (GET q=all-purpose flour&n=2, USDA snapshot only, no Open Food Facts read) at 2026-10-16T14:39Z UTC (launch build, price $0.005);
 * methodology omitted for length. Regenerate when the snapshot or the response shape changes.
 */
export const GROCERY_INGREDIENT_OUTPUT_EXAMPLE: Record<string, unknown> = {
  "source": "grocery-ingredient",
  "priced": {
    "amountUsd": "$0.005",
    "amountAtomic": "5000",
    "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "network": "base",
    "payTo": "0x5b32c973596078a967562ca652761404f19be0e9"
  },
  "asOf": "2026-10-16T14:39:25.223Z",
  "ok": true,
  "items": [
    {
      "query": {
        "q": "all-purpose flour"
      },
      "matches": [
        {
          "source": "usda_fdc",
          "id": "790018",
          "fdcId": 790018,
          "name": "Flour, wheat, all-purpose, unenriched, unbleached",
          "dataType": "Foundation",
          "category": "Cereal Grains and Pasta",
          "nutrientsPer100g": {
            "energy_kcal": 362,
            "protein_g": 12,
            "fat_g": 1.7,
            "sat_fat_g": null,
            "carbs_g": 74.6,
            "sugars_g": null,
            "fiber_g": 3,
            "sodium_mg": 2
          },
          "sourceUrl": "https://fdc.nal.usda.gov",
          "license": "Public domain (CC0 1.0)",
          "attribution": "Source: U.S. Department of Agriculture, Agricultural Research Service. FoodData Central, Foundation Foods, April 2026. fdc.nal.usda.gov. Public domain (CC0 1.0).",
          "matchScore": 12.36
        },
        {
          "source": "usda_fdc",
          "id": "789890",
          "fdcId": 789890,
          "name": "Flour, wheat, all-purpose, enriched, bleached",
          "dataType": "Foundation",
          "category": "Cereal Grains and Pasta",
          "nutrientsPer100g": {
            "energy_kcal": 366,
            "protein_g": 10.9,
            "fat_g": 1.48,
            "sat_fat_g": null,
            "carbs_g": 77.3,
            "sugars_g": null,
            "fiber_g": null,
            "sodium_mg": 2
          },
          "sourceUrl": "https://fdc.nal.usda.gov",
          "license": "Public domain (CC0 1.0)",
          "attribution": "Source: U.S. Department of Agriculture, Agricultural Research Service. FoodData Central, Foundation Foods, April 2026. fdc.nal.usda.gov. Public domain (CC0 1.0).",
          "matchScore": 10.88
        }
      ],
      "whereToBuy": null,
      "unknowns": [
        "usda_fdc 790018 sat_fat_g: not published in this release",
        "usda_fdc 790018 sugars_g: not published in this release",
        "usda_fdc 789890 sat_fat_g: not published in this release",
        "usda_fdc 789890 sugars_g: not published in this release",
        "usda_fdc 789890 fiber_g: not published in this release",
        "allergens: not provided for USDA generic foods (give a barcode for Open Food Facts contributor data)"
      ]
    }
  ],
  "attribution": [
    "Source: U.S. Department of Agriculture, Agricultural Research Service. FoodData Central, Foundation Foods, April 2026. fdc.nal.usda.gov. Public domain (CC0 1.0)."
  ],
  "disclaimer": "Indicative data only. Open Food Facts data is entered by volunteers and USDA data describes generic or reported foods; values can be wrong, missing or out of date, and recipes and labels change. Allergen and ingredient fields may be incomplete: an empty or missing allergen list does NOT mean a product is free of any allergen or trace. Always check the product's own label. Not for medical, dietary or allergy decisions. Not advice.",
  "fdcSnapshot": [
    {
      "dataType": "Foundation",
      "release": "Foundation Foods, April 2026",
      "url": "https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_foundation_food_json_2026-04-30.zip",
      "zipSha256": "186e988ec542e913f51ef62b86a47758e8cdd0d1dc3889e7b055581f3c09c77a",
      "foods": 363
    },
    {
      "dataType": "SR Legacy",
      "release": "SR Legacy, April 2018",
      "url": "https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_sr_legacy_food_json_2018-04.zip",
      "zipSha256": "0fe8ae486a2c8eb42cb96413f058deb51863a46c8fb8eeb4b1fb45006dd338ef",
      "foods": 7793
    }
  ]
};

/**
 * POST /api/grocery/ingredient output example: response recorded from the handler on the
 * declared POST input {"items":[{"q":"egg"},{"q":"olive oil"}],"n":1} (USDA snapshot only,
 * no Open Food Facts read) at 2026-10-16T15:44:54.070Z UTC (branch fix/listing-copy-examples,
 * Odin 11:43 AM ET: the POST example must match its input). methodology omitted for length;
 * no other key or value changed. Raw: /workspace/hp-tmp/listing-fix/rec-ingredient-post.json (box only).
 */
export const GROCERY_INGREDIENT_POST_OUTPUT_EXAMPLE: Record<string, unknown> = {
  "source": "grocery-ingredient",
  "priced": {
    "amountUsd": "$0.005",
    "amountAtomic": "5000",
    "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "network": "base",
    "payTo": "0x5b32c973596078a967562ca652761404f19be0e9"
  },
  "asOf": "2026-10-16T15:44:54.134Z",
  "ok": true,
  "items": [
    {
      "query": {
        "q": "egg"
      },
      "matches": [
        {
          "source": "usda_fdc",
          "id": "171287",
          "fdcId": 171287,
          "name": "Egg, whole, raw, fresh",
          "dataType": "SR Legacy",
          "category": "Dairy and Egg Products",
          "nutrientsPer100g": {
            "energy_kcal": 143,
            "protein_g": 12.6,
            "fat_g": 9.51,
            "sat_fat_g": 3.13,
            "carbs_g": 0.72,
            "sugars_g": 0.37,
            "fiber_g": 0,
            "sodium_mg": 142
          },
          "sourceUrl": "https://fdc.nal.usda.gov",
          "license": "Public domain (CC0 1.0)",
          "attribution": "Source: U.S. Department of Agriculture, Agricultural Research Service. FoodData Central, SR Legacy, April 2018. fdc.nal.usda.gov. Public domain (CC0 1.0).",
          "matchScore": 18.29
        }
      ],
      "whereToBuy": null,
      "unknowns": [
        "allergens: not provided for USDA generic foods (give a barcode for Open Food Facts contributor data)"
      ]
    },
    {
      "query": {
        "q": "olive oil"
      },
      "matches": [
        {
          "source": "usda_fdc",
          "id": "171413",
          "fdcId": 171413,
          "name": "Oil, olive, salad or cooking",
          "dataType": "SR Legacy",
          "category": "Fats and Oils",
          "nutrientsPer100g": {
            "energy_kcal": 884,
            "protein_g": 0,
            "fat_g": 100,
            "sat_fat_g": 13.8,
            "carbs_g": 0,
            "sugars_g": 0,
            "fiber_g": 0,
            "sodium_mg": 2
          },
          "sourceUrl": "https://fdc.nal.usda.gov",
          "license": "Public domain (CC0 1.0)",
          "attribution": "Source: U.S. Department of Agriculture, Agricultural Research Service. FoodData Central, SR Legacy, April 2018. fdc.nal.usda.gov. Public domain (CC0 1.0).",
          "matchScore": 17.26
        }
      ],
      "whereToBuy": null,
      "unknowns": [
        "allergens: not provided for USDA generic foods (give a barcode for Open Food Facts contributor data)"
      ]
    }
  ],
  "attribution": [
    "Source: U.S. Department of Agriculture, Agricultural Research Service. FoodData Central, SR Legacy, April 2018. fdc.nal.usda.gov. Public domain (CC0 1.0)."
  ],
  "disclaimer": "Indicative data only. Open Food Facts data is entered by volunteers and USDA data describes generic or reported foods; values can be wrong, missing or out of date, and recipes and labels change. Allergen and ingredient fields may be incomplete: an empty or missing allergen list does NOT mean a product is free of any allergen or trace. Always check the product's own label. Not for medical, dietary or allergy decisions. Not advice.",
  "fdcSnapshot": [
    {
      "dataType": "Foundation",
      "release": "Foundation Foods, April 2026",
      "url": "https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_foundation_food_json_2026-04-30.zip",
      "zipSha256": "186e988ec542e913f51ef62b86a47758e8cdd0d1dc3889e7b055581f3c09c77a",
      "foods": 363
    },
    {
      "dataType": "SR Legacy",
      "release": "SR Legacy, April 2018",
      "url": "https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_sr_legacy_food_json_2018-04.zip",
      "zipSha256": "0fe8ae486a2c8eb42cb96413f058deb51863a46c8fb8eeb4b1fb45006dd338ef",
      "foods": 7793
    }
  ]
};
