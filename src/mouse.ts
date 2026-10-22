import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

export type MouseButton = 'left' | 'middle' | 'right' | 'wheelUp' | 'wheelDown';
// x and y are 0-based cells from the window's top left.
export type MouseEvent = { button: MouseButton; x: number; y: number };

const BUTTONS: Record<number, MouseButton> = { 0: 'left', 1: 'middle', 2: 'right', 64: 'wheelUp', 65: 'wheelDown' };

// SGR mouse reports: ESC [ < button ; x ; y, then M for a press or m for a release.
const REPORT = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
const PARTIAL_REPORT = /\x1b\[<[\d;]*$/;

/** Mouse presses on the board, from the stdin returned by `mouseStdin`. */
export const mouse = new EventEmitter<{ press: [MouseEvent] }>();

/**
 * Ink drops mouse reports without passing them on, so give it this stdin instead: it takes the
 * reports out of the terminal's input and emits presses on `mouse`, passing everything else through.
 */
export function mouseStdin(stdin: NodeJS.ReadStream = process.stdin): NodeJS.ReadStream {
	const proxy = new PassThrough() as unknown as NodeJS.ReadStream & PassThrough;
	let pending = '';
	stdin.setEncoding('utf8');
	stdin.on('data', (chunk: string) => {
		let text = pending + chunk;
		// A report split across chunks is finished by the next one.
		pending = text.match(PARTIAL_REPORT)?.[0] ?? '';
		if (pending) text = text.slice(0, -pending.length);
		const rest = text.replace(REPORT, (_, code: string, x: string, y: string, kind: string) => {
			// Ignore modifier (4/8/16) and motion (32) bits on clicks; wheel codes keep theirs off anyway.
			const button = BUTTONS[Number(code) >= 64 ? Number(code) & ~28 : Number(code) & 3];
			if (button && kind === 'M') mouse.emit('press', { button, x: Number(x) - 1, y: Number(y) - 1 });
			return '';
		});
		if (rest) proxy.write(rest);
	});
	proxy.isTTY = true;
	proxy.setRawMode = (mode: boolean) => {
		stdin.setRawMode(mode);
		return proxy;
	};
	proxy.ref = () => (stdin.ref(), proxy);
	proxy.unref = () => (stdin.unref(), proxy);
	return proxy;
}

/** Ask the terminal for press/release and wheel reports in SGR form, until the process exits. */
export function reportMouse(stdout: NodeJS.WriteStream = process.stdout): void {
	stdout.write('\x1b[?1000h\x1b[?1006h');
	process.on('exit', () => stdout.write('\x1b[?1000l\x1b[?1006l'));
}
