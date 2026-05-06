interface StockDisplay {
  label:     string;   // "3 boxes" | "45 pcs" | "Out of Stock"
  inStock:   boolean;
  unitBadge: 'BOX' | 'PCS';
}

export function formatStock(totalPieces: number, unitType: string | null, unitOfMeasure: string | null, piecesPerBox: number | null): StockDisplay {
  const ut  = (unitType      || '').trim().toLowerCase();
  const uom = (unitOfMeasure || '').trim().toLowerCase();
  const isBoxType = ut === 'box' || ut === 'boxes' || uom === 'box' || uom === 'boxes';
  const ppb = (piecesPerBox ?? 0);

  if (totalPieces <= 0) {
    return { label: 'Out of Stock', inStock: false, unitBadge: isBoxType ? 'BOX' : 'PCS' };
  }

  if (isBoxType && ppb > 0) {
    const boxes = Math.floor(totalPieces / ppb);
    const rem   = totalPieces % ppb;
    const label = boxes > 0
      ? rem > 0 ? `${boxes} box${boxes > 1 ? 'es' : ''} + ${rem} pcs` : `${boxes} box${boxes > 1 ? 'es' : ''}`
      : `${rem} pcs`;
    return { label, inStock: true, unitBadge: 'BOX' };
  }

  return { label: `${totalPieces} pcs`, inStock: true, unitBadge: 'PCS' };
}
