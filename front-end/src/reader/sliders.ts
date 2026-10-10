// Native range inputs are painted with the platform accent unless the track paint
// is driven explicitly. `fillPercent` gives each slider its own progress variable so
// the whole control reads in the single accent colour, in every reader theme.
export function fillPercent(value: number, min: number, max: number): string {
  const low = Number(min);
  const high = Number(max);
  const current = Number(value);
  if (!Number.isFinite(low) || !Number.isFinite(high) || high <= low) return '0%';
  const ratio = Number.isFinite(current) ? (current - low) / (high - low) : 0;
  return `${Math.round(Math.min(1, Math.max(0, ratio)) * 100)}%`;
}

/** Style binding for one range input. */
export const sliderFill = (value: number, min: number, max: number) => ({ '--fill': fillPercent(value, min, max) });
