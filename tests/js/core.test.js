// Unit tests for static/core.js — run with `npm test` (or `node --test tests/js/`).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    escapeHTML,
    extractLinks,
    extractDescLinks,
    formatLinkLabel,
    linkifyHTML,
    extractContexts,
    groupByContext,
    deriveTaskState,
    parseDateToken,
    parseSearchQuery,
    formatTimestamp,
    formatDoneDate,
    formatWaitingSince,
    archiveBucket,
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

test('extractContexts finds @ tokens across title and description, lowercased and deduped', () => {
    assert.deepEqual(
        extractContexts({ title: 'Fix @Work bug @Urgent', description: 'ping @work again' }),
        ['work', 'urgent']
    );
    assert.deepEqual(extractContexts({ title: 'no tags here', description: '' }), []);
    // A tag at the very start of the text counts (^ boundary).
    assert.deepEqual(extractContexts({ title: '@work first', description: '' }), ['work']);
    // Tags after punctuation still count.
    assert.deepEqual(extractContexts({ title: '(@home)', description: '' }), ['home']);
});

test('extractContexts ignores # tokens so issue/PR refs are not contexts', () => {
    assert.deepEqual(extractContexts({ title: 'Review PR #412 @review', description: '' }), ['review']);
});

test('extractContexts ignores an @ glued to a word char, so emails are not contexts', () => {
    assert.deepEqual(extractContexts({ title: 'ping me@example.com', description: '' }), []);
    // A real tag alongside an email is still picked up; the email is not.
    assert.deepEqual(
        extractContexts({ title: 'mail bob@corp.com @urgent', description: '' }),
        ['urgent']
    );
});

test('groupByContext buckets tasks per tag, sorts alphabetically, untagged last', () => {
    const tasks = [
        { id: '1', title: 'A @work' },
        { id: '2', title: 'B @home @work' },
        { id: '3', title: 'C no tags' },
    ];
    const groups = groupByContext(tasks);
    assert.deepEqual(groups.map(g => g.context), ['home', 'work', null]);
    assert.deepEqual(groups.find(g => g.context === 'work').tasks.map(t => t.id), ['1', '2']);
    assert.deepEqual(groups.find(g => g.context === 'home').tasks.map(t => t.id), ['2']);
    assert.deepEqual(groups.find(g => g.context === null).tasks.map(t => t.id), ['3']);
});

test('groupByContext omits the untagged bucket when every task has a tag', () => {
    const groups = groupByContext([{ id: '1', title: '@work' }]);
    assert.deepEqual(groups.map(g => g.context), ['work']);
});

test('groupByContext preserves input order within a bucket', () => {
    const tasks = [
        { id: '3', title: '@x' },
        { id: '1', title: '@x' },
        { id: '2', title: '@x' },
    ];
    assert.deepEqual(groupByContext(tasks)[0].tasks.map(t => t.id), ['3', '1', '2']);
});

test('deriveTaskState prioritises waiting, then snooze, then backlog, then scheduled', () => {
    const today = '2026-07-10';
    assert.deepEqual(
        deriveTaskState({ waiting_since: '2026-07-01 09:00:00', defer_until: '2026-08-01', due_date: '2026-07-15' }, today),
        { kind: 'waiting', date: null }
    );
    assert.deepEqual(
        deriveTaskState({ defer_until: '2026-08-01', due_date: '2026-07-15' }, today),
        { kind: 'snoozed', date: '2026-08-01' }
    );
    // A past/today defer_until no longer snoozes: falls through to its due date.
    assert.deepEqual(
        deriveTaskState({ defer_until: '2026-07-10', due_date: '2026-07-15' }, today),
        { kind: 'scheduled', date: '2026-07-15' }
    );
    assert.deepEqual(deriveTaskState({ due_date: null }, today), { kind: 'backlog', date: null });
    assert.deepEqual(
        deriveTaskState({ due_date: '2026-07-15' }, today),
        { kind: 'scheduled', date: '2026-07-15' }
    );
});

test('extractDescLinks reads a "label | url" pipe link', () => {
    assert.deepEqual(
        extractDescLinks('Design doc | https://www.example.com/something/serious'),
        [{ url: 'https://www.example.com/something/serious', label: 'Design doc' }]
    );
});

test('extractDescLinks still picks up bare URLs with a null label', () => {
    assert.deepEqual(
        extractDescLinks('see https://a.com for details'),
        [{ url: 'https://a.com', label: null }]
    );
});

test('extractDescLinks trims trailing punctuation on a pipe URL and trims the label', () => {
    assert.deepEqual(
        extractDescLinks('  Spec   | https://a.com/x?y=1.'),
        [{ url: 'https://a.com/x?y=1', label: 'Spec' }]
    );
});

test('extractDescLinks mixes labelled and bare links in document order (label is line-scoped)', () => {
    assert.deepEqual(
        extractDescLinks('intro https://bare.com\nNamed | https://named.com'),
        [
            { url: 'https://bare.com', label: null },
            { url: 'https://named.com', label: 'Named' },
        ]
    );
});

test('extractDescLinks dedupes by url, keeping the labelled occurrence', () => {
    assert.deepEqual(
        extractDescLinks('Doc | https://a.com\nagain https://a.com'),
        [{ url: 'https://a.com', label: 'Doc' }]
    );
});

test('extractDescLinks returns nothing for text without links', () => {
    assert.deepEqual(extractDescLinks('just a plain note | not a url'), []);
});

test('linkifyHTML wraps a bare URL in an anchor and escapes surrounding text', () => {
    assert.equal(
        linkifyHTML('see https://a.com/x now'),
        'see <a href="https://a.com/x" target="_blank" rel="noopener noreferrer">https://a.com/x</a> now'
    );
});

test('linkifyHTML leaves trailing sentence punctuation outside the link', () => {
    assert.equal(
        linkifyHTML('read https://a.com.'),
        'read <a href="https://a.com" target="_blank" rel="noopener noreferrer">https://a.com</a>.'
    );
});

test('linkifyHTML escapes HTML in the text and in the URL so it cannot inject markup', () => {
    assert.equal(
        linkifyHTML('<b>x</b> & https://a.com/?q=1&r=2'),
        '&lt;b&gt;x&lt;/b&gt; &amp; <a href="https://a.com/?q=1&amp;r=2" target="_blank" rel="noopener noreferrer">https://a.com/?q=1&amp;r=2</a>'
    );
});

test('linkifyHTML only matches http(s), leaving other schemes as escaped text', () => {
    assert.equal(linkifyHTML('javascript:alert(1)'), 'javascript:alert(1)');
});

test('formatLinkLabel reduces a URL to its host', () => {
    assert.equal(formatLinkLabel('https://www.example.com/something/serious'), 'www.example.com');
    assert.equal(formatLinkLabel('http://a.com'), 'a.com');
    assert.equal(formatLinkLabel('https://sub.host.co.uk:8443/x?y=1'), 'sub.host.co.uk');
    // Not a parseable URL: fall back to the input unchanged.
    assert.equal(formatLinkLabel('not a url'), 'not a url');
});

test('formatLinkLabel uses the issue key for Jira browse URLs on any host', () => {
    assert.equal(formatLinkLabel('https://flow.sbb.ch/browse/TRSRISK-612'), 'TRSRISK-612');
    assert.equal(formatLinkLabel('https://mycorp.atlassian.net/browse/AB1-9/'), 'AB1-9');
    // Query params don't get in the way (pathname only).
    assert.equal(formatLinkLabel('https://jira.example.com/browse/X-1?focusedId=2'), 'X-1');
    // Lowercase or keyless paths are not Jira issues: plain host label.
    assert.equal(formatLinkLabel('https://flow.sbb.ch/browse/trsrisk-612'), 'flow.sbb.ch');
    assert.equal(formatLinkLabel('https://flow.sbb.ch/browse/TRSRISK-612/extra'), 'flow.sbb.ch');
});

test('formatLinkLabel uses the decoded page title for Confluence URLs', () => {
    assert.equal(
        formatLinkLabel('https://confluence.sbb.ch/spaces/TRSST/pages/2763653156/Rollen+und+Verantwortlichkeiten'),
        'Rollen und Verantwortlichkeiten',
    );
    // Cloud instances have the same shape under a /wiki prefix; slugs are
    // percent-encoded on top of the "+" word separators.
    assert.equal(
        formatLinkLabel('https://mycorp.atlassian.net/wiki/spaces/AB/pages/123/R%C3%BCckblick+2025'),
        'Rückblick 2025',
    );
    // Legacy /display/KEY/Title links.
    assert.equal(
        formatLinkLabel('https://confluence.sbb.ch/display/TRSST/Rollen+und+Verantwortlichkeiten'),
        'Rollen und Verantwortlichkeiten',
    );
    // Long titles get cut at a word boundary with an ellipsis.
    assert.equal(
        formatLinkLabel('https://confluence.sbb.ch/spaces/TRSST/pages/99/Betriebskonzept+Rollen+und+Verantwortlichkeiten'),
        'Betriebskonzept Rollen und…',
    );
    // No title slug in the URL: the space key stands in.
    assert.equal(
        formatLinkLabel('https://confluence.sbb.ch/spaces/TRSST/pages/2763653156'),
        'TRSST',
    );
});

test('formatLinkLabel uses reference syntax for GitHub and GitLab URLs', () => {
    assert.equal(formatLinkLabel('https://github.com/dnswlt/horizon/pull/42'), 'horizon#42');
    assert.equal(formatLinkLabel('https://github.com/dnswlt/horizon/issues/7'), 'horizon#7');
    // Sub-pages of a PR (files, commits) still label as the PR.
    assert.equal(formatLinkLabel('https://github.com/dnswlt/horizon/pull/42/files'), 'horizon#42');
    // GitHub Enterprise hosts named github.* count; other hosts don't claim
    // the generic /owner/repo/pull/N shape.
    assert.equal(formatLinkLabel('https://github.mycorp.com/team/repo/pull/3'), 'repo#3');
    assert.equal(formatLinkLabel('https://example.com/team/repo/pull/3'), 'example.com');
    // GitLab's /-/ marker works on any host.
    assert.equal(formatLinkLabel('https://gitlab.com/grp/proj/-/merge_requests/15'), 'proj!15');
    assert.equal(formatLinkLabel('https://git.mycorp.ch/grp/proj/-/issues/8'), 'proj#8');
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

test('archiveBucket buckets the last 7 days per day, older per month', () => {
    // Anchor everything to the machine's local "now" so the assertions are
    // timezone-independent (archiveBucket converts UTC timestamps to local days).
    const localDay = (d) =>
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const now = new Date();
    const today = localDay(now);
    const daysAgo = (n) => new Date(now.getTime() - n * 86400000);

    assert.deepEqual(archiveBucket(now.toISOString(), today), { key: today, label: 'Today' });
    assert.deepEqual(archiveBucket(daysAgo(1).toISOString(), today), {
        key: localDay(daysAgo(1)),
        label: 'Yesterday',
    });

    // 2–6 days ago: own day bucket, labelled with the weekday
    const d3 = archiveBucket(daysAgo(3).toISOString(), today);
    assert.equal(d3.key, localDay(daysAgo(3)));
    assert.match(d3.label, /^[A-Z][a-z]+day, [A-Z][a-z]{2} \d{1,2}$/);

    // Older than a week: month bucket
    const d30 = archiveBucket(daysAgo(30).toISOString(), today);
    assert.equal(d30.key, localDay(daysAgo(30)).slice(0, 7));
    assert.match(d30.label, /^[A-Z][a-z]+ \d{4}$/);

    // SQLite zoneless timestamps are normalised like formatTimestamp
    const sqliteNow = now.toISOString().slice(0, 19).replace('T', ' ');
    assert.equal(archiveBucket(sqliteNow, today).label, 'Today');
});

test('archiveBucket returns null for empty/unparseable input', () => {
    assert.equal(archiveBucket(''), null);
    assert.equal(archiveBucket(null), null);
    assert.equal(archiveBucket('nope'), null);
});
