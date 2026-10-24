import { Box, Text } from 'ink';
import { KEY_SECTIONS } from '../keys.js';

/** The `?` screen: every key, a section per box, as many side by side as fit. */
export function KeysView() {
	return (
		<Box flexGrow={1} overflow="hidden" flexDirection="column">
			<Text bold>
				Keys <Text dimColor>(? / q / esc close · also in KEYS.md)</Text>
			</Text>
			<Box flexWrap="wrap">
				{KEY_SECTIONS.map(section => {
					const keyWidth = Math.max(...section.keys.map(([k]) => k.length)) + 2;
					return (
						<Box key={section.title} flexDirection="column" width={48} marginTop={1} marginRight={2}>
							<Text bold color="cyan">
								{section.title}
							</Text>
							{section.keys.map(([k, what]) => (
								<Box key={k}>
									<Box width={keyWidth} flexShrink={0}>
										<Text>{k}</Text>
									</Box>
									<Text dimColor>{what}</Text>
								</Box>
							))}
						</Box>
					);
				})}
			</Box>
		</Box>
	);
}
