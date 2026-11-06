/** The text of something caught, which needn't be an Error. */
export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
