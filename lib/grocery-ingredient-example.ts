/**
 * /api/grocery/ingredient output example: response recorded from the branch handler
 * (GET q=all-purpose flour&n=2, USDA snapshot only, no Open Food Facts read) at 2026-10-16T14:21Z UTC;
 * methodology omitted for length. Regenerate when the snapshot or the response shape changes.
 */
export const GROCERY_INGREDIENT_OUTPUT_EXAMPLE: Record<string, unknown> = {
  "source": "grocery-ingredient",
  "priced": null,
  "asOf": "2026-10-16T14:21:00.088Z",
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
