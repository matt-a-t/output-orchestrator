/** The text of something caught, which needn't be an Error. */
export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Status-line color: ✗ failed, ⚠ refused or partly done, anything else went fine. */
export const messageColor = (message: string, confirming = false) =>
	message.startsWith('✗') ? 'red' : confirming || message.startsWith('⚠') ? 'yellow' : 'green';

/** An { ok, message } result as a status line: ⚠ when it didn't go through, unless the message already says so. */
export const resultMessage = ({ ok, message }: { ok: boolean; message: string }): string =>
	ok || /^[✗⚠]/.test(message) ? message : `⚠ ${message}`;

export const unknownProject = (name: string) => `Unknown project "${name}"`;
export const stillWorking = (id: string) => `claude is still working on #${id}`;
