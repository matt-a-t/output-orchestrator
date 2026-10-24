import { useRef } from 'react';

const DOUBLE_CLICK_MS = 400;

/** A check for whether a click is on the same thing as the last, soon enough to make a double-click. */
export function useDoubleClick() {
	const lastClick = useRef<{ target: string; at: number } | null>(null);
	return (target: string) => {
		const now = Date.now();
		const double = lastClick.current?.target === target && now - lastClick.current.at < DOUBLE_CLICK_MS;
		lastClick.current = double ? null : { target, at: now };
		return double;
	};
}
