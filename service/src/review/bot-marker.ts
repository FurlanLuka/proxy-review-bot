export const BOT_MARKER_PREFIX = '<!-- proxy-review-bot';

export const BOT_SIGNATURE = '🤖 review bot';

const BOT_MARKER_PATTERN = /<!-- proxy-review-bot[^>]*-->/g;
const BOT_SIGNATURE_LINE_PATTERN =
	/^[ \t]*(?:<sub>[ \t]*)?🤖 review bot(?:[ \t]*<\/sub>)?[ \t]*$/gm;

export const createBotMarker = (headSha: string): string => {
	return `${BOT_MARKER_PREFIX} head=${headSha} -->`;
};

export const hasBotMarker = (body: string): boolean => {
	return body.includes(BOT_MARKER_PREFIX);
};

export const hasBotMarkerForHead = (body: string, headSha: string): boolean => {
	return body.includes(createBotMarker(headSha));
};

// Claude sometimes copies the footer from the bot's earlier comments, so drop it before adding ours.
const stripBotFooter = (body: string): string => {
	return body.replace(BOT_MARKER_PATTERN, '').replace(BOT_SIGNATURE_LINE_PATTERN, '').trim();
};

export const appendBotFooter = (body: string, headSha: string): string => {
	return `${stripBotFooter(body)}\n\n<sub>${BOT_SIGNATURE}</sub>\n${createBotMarker(headSha)}`;
};
