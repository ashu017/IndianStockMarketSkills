// Money is stored on disk as INTEGER minor units (SQLite has no exact decimal type).
// Rupee amounts  -> paise      (×100)
// Prices         -> price units (×10000, to carry fractional paise in avg_price)
export const PAISE = 100;
export const PRICE_SCALE = 10000;

export const rupeesToPaise = (r: number): number => Math.round(r * PAISE);
export const paiseToRupees = (p: number): number => p / PAISE;
export const rupeesToPrice = (r: number): number => Math.round(r * PRICE_SCALE);
export const priceToRupees = (p: number): number => p / PRICE_SCALE;
