export const BOT_MARKER_PREFIX = '<!-- proxy-review-bot';

export const BOT_SIGNATURE = '🤖 review bot';

export const createBotMarker = (headSha: string): string => {
	return `${BOT_MARKER_PREFIX} head=${headSha} -->`;
};

export const hasBotMarker = (body: string): boolean => {
	return body.includes(BOT_MARKER_PREFIX);
};

export const hasBotMarkerForHead = (body: string, headSha: string): boolean => {
	return body.includes(createBotMarker(headSha));
};

export const appendBotFooter = (body: string, headSha: string): string => {
	return `${body.trim()}\n\n<sub>${BOT_SIGNATURE}</sub>\n${createBotMarker(headSha)}`;
};
