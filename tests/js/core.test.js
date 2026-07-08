// Unit tests for static/core.js — run with `npm test` (or `node --test tests/js/`).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    escapeHTML,
    extractLinks,
    parseDateToken,
    parseSearchQuery,
    formatTimestamp,
    formatDoneDate,
    formatWaitingSince,
} from '../../static/core.js';

test('escapeHTML escapes the five HTML-significant characters', () => {
    assert.equal(
        escapeHTML(`<a href="x" onclick='y'>&</a>`),
        '&lt;a href=&quot;x&quot; onclick=&#039;y&#039;&gt;&amp;&lt;/a&gt;'
    );
    assert.equal(escapeHTML('plain text'), 'plain text');
});

test('extractLinks finds http(s) URLs and dedupes', () => {
    assert.deepEqual(
        extractLinks('see http://a.com and https://b.com and http://a.com again'),
        ['http://a.com', 'https://b.com']
    );
    assert.deepEqual(extractLinks('no links here'), []);
});

test('extractLinks trims trailing punctuation', () => {
    assert.deepEqual(extractLinks('go to https://example.com/path.'), ['https://example.com/path']);
    assert.deepEqual(extractLinks('read https://example.com/x, now'), ['https://example.com/x']);
});

test('extractLinks keeps balanced brackets but drops an unbalanced trailing one', () => {
    // The closing paren belongs to the sentence, not the URL.
    assert.deepEqual(
        extractLinks('(see https://en.wikipedia.org/wiki/Foo)'),
        ['https://en.wikipedia.org/wiki/Foo']
    );
    // Wikipedia-style URL whose own parens are balanced is preserved.
    assert.deepEqual(
        extractLinks('https://en.wikipedia.org/wiki/Foo_(bar)'),
        ['https://en.wikipedia.org/wiki/Foo_(bar)']
    );
});

test('parseDateToken anchors partial dates to the start of the period', () => {
    assert.equal(parseDateToken('2025'), '2025-01-01');
    assert.equal(parseDateToken('2025-07'), '2025-07-01');
    assert.equal(parseDateToken('2025-07-03'), '2025-07-03');
    assert.equal(parseDateToken('2025-7-3'), '2025-07-03');
});

test('parseDateToken rejects non-dates and out-of-range values', () => {
    assert.equal(parseDateToken('lunch'), null);
    assert.equal(parseDateToken('2025-13'), null);
    assert.equal(parseDateToken('2025-07-32'), null);
    assert.equal(parseDateToken('25-07'), null);
});

test('parseSearchQuery splits text from before/after date bounds', () => {
    assert.deepEqual(parseSearchQuery('report after:2025-01 before:2025-07'), {
        text: 'report',
        after: '2025-01-01',
        before: '2025-07-01',
    });
});

test('parseSearchQuery keeps non-date before/after tokens as literal text', () => {
    assert.deepEqual(parseSearchQuery('before:lunch meeting'), {
        text: 'before:lunch meeting',
        after: '',
        before: '',
    });
});

test('parseSearchQuery is case-insensitive on the keyword and collapses whitespace', () => {
    assert.deepEqual(parseSearchQuery('  foo   AFTER:2024   bar '), {
        text: 'foo bar',
        after: '2024-01-01',
        before: '',
    });
});

test('parseSearchQuery on an empty string yields empty parts', () => {
    assert.deepEqual(parseSearchQuery('   '), { text: '', after: '', before: '' });
});

test('formatTimestamp normalises a SQLite (zoneless) timestamp and formats it', () => {
    // 12:34 UTC rendered in local time; assert the shape rather than the exact
    // hour so the test is timezone-independent.
    assert.match(formatTimestamp('2025-06-03 12:34:56'), /^[A-Z][a-z]{2} \d{1,2}, \d{2}:\d{2}$/);
});

test('formatTimestamp returns the fallback for empty or unparseable input', () => {
    assert.equal(formatTimestamp('', 'n/a'), 'n/a');
    assert.equal(formatTimestamp(null, 'n/a'), 'n/a');
    assert.equal(formatTimestamp('not a date', 'n/a'), 'n/a');
    assert.equal(formatTimestamp(''), '');
});

test('formatDoneDate falls back to "recently"', () => {
    assert.equal(formatDoneDate(null), 'recently');
    assert.equal(formatDoneDate(''), 'recently');
});

test('formatWaitingSince renders today/yesterday then a short date', () => {
    const now = Date.parse('2026-07-08T12:00:00Z');
    const daysAgo = (n) => new Date(now - n * 86400000).toISOString();
    assert.equal(formatWaitingSince(daysAgo(0), now), 'today');
    assert.equal(formatWaitingSince(daysAgo(1), now), 'yesterday');
    assert.match(formatWaitingSince(daysAgo(6), now), /^[A-Z][a-z]{2} \d{1,2}$/);
    // SQLite zoneless timestamps are normalised like formatTimestamp.
    assert.equal(formatWaitingSince('2026-07-07 12:00:00', now), 'yesterday');
});

test('formatWaitingSince returns empty string for empty/unparseable input', () => {
    assert.equal(formatWaitingSince(''), '');
    assert.equal(formatWaitingSince(null), '');
    assert.equal(formatWaitingSince('nope'), '');
});
