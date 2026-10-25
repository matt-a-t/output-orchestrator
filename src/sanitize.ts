// Text from outside (tickets, PRs, `oo thread` input) cleaned of terminal control sequences before
// it's stored or shown, so it can't restyle the terminal, plant links or hide what it says.

// OSC (ESC ] … ended by BEL or ESC \), which includes OSC 8 links; the link text around it stays.
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g;
// CSI (ESC [ … final byte), colours and cursor moves among them.
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]?/g;
// Any other two-character escape.
const ESC = /\x1b[\s\S]?/g;
// What's left of C0, DEL and C1, keeping newlines and tabs.
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

/** `text` without control characters or escape sequences, except newlines and tabs. */
export function sanitize(text: string): string {
	return text.replace(OSC, '').replace(CSI, '').replace(ESC, '').replace(CONTROLS, '');
}

/** JSON from outside, with every string in it sanitized. */
export function parseUntrusted<T>(json: string): T {
	return JSON.parse(json, (_key, value: unknown) => (typeof value === 'string' ? sanitize(value) : value)) as T;
}
