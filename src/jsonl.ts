import { closeSync, openSync, readSync, statSync } from 'node:fs';

/** Incrementally reads complete JSON lines appended to `file`, keeping the ones `accept` recognises. */
export class JsonlReader<T> {
	private offset = 0;
	private partial = '';

	constructor(
		private readonly file: string,
		private readonly accept: (value: any) => boolean,
	) {}

	read(): T[] {
		let size: number;
		try {
			size = statSync(this.file).size;
		} catch {
			return [];
		}
		if (size < this.offset) {
			// Truncated or replaced: start over.
			this.offset = 0;
			this.partial = '';
		}
		if (size === this.offset) return [];
		const buf = Buffer.alloc(size - this.offset);
		const fd = openSync(this.file, 'r');
		try {
			readSync(fd, buf, 0, buf.length, this.offset);
		} finally {
			closeSync(fd);
		}
		this.offset = size;
		const lines = (this.partial + buf.toString('utf8')).split('\n');
		this.partial = lines.pop() ?? '';
		const values: T[] = [];
		for (const line of lines) {
			try {
				const value = JSON.parse(line);
				if (value && this.accept(value)) values.push(value);
			} catch {}
		}
		return values;
	}
}
