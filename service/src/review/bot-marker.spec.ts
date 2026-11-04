import { describe, expect, it } from 'bun:test';
import { appendBotFooter, hasBotMarkerForHead } from './bot-marker.js';

const FOOTER = '\n\n<sub>🤖 review bot</sub>\n<!-- proxy-review-bot head=sha-2 -->';

describe('appendBotFooter', () => {
	it('a plain body → one footer', () => {
		expect(appendBotFooter('Looks good.', 'sha-2')).toBe(`Looks good.${FOOTER}`);
	});

	it.each([
		[
			'copied full footer, same head',
			'Looks good.\n\n<sub>🤖 review bot</sub>\n<!-- proxy-review-bot head=sha-2 -->',
		],
		[
			'copied full footer, older head',
			'Looks good.\n\n<sub>🤖 review bot</sub>\n<!-- proxy-review-bot head=sha-1 -->',
		],
		['copied signature line only', 'Looks good.\n\n<sub>🤖 review bot</sub>'],
		['copied marker only', 'Looks good.\n<!-- proxy-review-bot head=sha-1 -->'],
		[
			'signature and marker on one line',
			'Looks good.\n<sub>🤖 review bot</sub> <!-- proxy-review-bot head=sha-1 -->',
		],
		[
			'CRLF line endings',
			'Looks good.\r\n<sub>🤖 review bot</sub>\r\n<!-- proxy-review-bot head=sha-1 -->',
		],
	])('%s → one footer, for the new head', (_label, copied) => {
		const body = appendBotFooter(copied, 'sha-2');

		expect(body).toBe(`Looks good.${FOOTER}`);
		expect(hasBotMarkerForHead(body, 'sha-1')).toBe(false);
	});

	it('appending twice → still one footer', () => {
		const once = appendBotFooter('Looks good.', 'sha-2');

		expect(appendBotFooter(once, 'sha-2')).toBe(once);
	});

	it('a bare signature line or one in the middle → removed', () => {
		expect(appendBotFooter('Looks good.\n🤖 review bot', 'sha-2')).toBe(`Looks good.${FOOTER}`);
		expect(appendBotFooter('First.\n  <sub> 🤖 review bot </sub>\nSecond.', 'sha-2')).toBe(
			`First.\n\nSecond.${FOOTER}`,
		);
	});

	it('the phrase inside a sentence → kept', () => {
		expect(appendBotFooter('Unlike the 🤖 review bot note above, this is fine.', 'sha-2')).toBe(
			`Unlike the 🤖 review bot note above, this is fine.${FOOTER}`,
		);
	});
});
