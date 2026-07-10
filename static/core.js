// core.js — pure helpers with no DOM or app-state dependencies.
//
// Everything here is a plain function of its arguments, which keeps it easy to
// unit-test under `node --test` (see tests/js/core.test.js). app.js imports
// these; nothing here imports back from app.js.

// Escape HTML to prevent XSS when interpolating user text into innerHTML.
export function escapeHTML(str) {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// Trim trailing sentence punctuation and unbalanced closing brackets from a URL
// (e.g. a URL wrapped in parentheses, or one ending a sentence).
function trimUrl(url) {
    let changed = true;
    while (changed && url) {
        changed = false;
        const c = url[url.length - 1];
        if ('.,;:!?\'"'.includes(c)) {
            url = url.slice(0, -1);
            changed = true;
        } else if (')]}'.includes(c)) {
            const open = c === ')' ? '(' : c === ']' ? '[' : '{';
            const opens = url.split(open).length - 1;
            const closes = url.split(c).length - 1;
            if (closes > opens) {
                url = url.slice(0, -1);
                changed = true;
            }
        }
    }
    return url;
}

// Extract http(s) URLs from text, trimming trailing punctuation/brackets.
export function extractLinks(text) {
    const urlRegex = /https?:\/\/[^\s<]+/g;
    const urls = [];
    let m;
    while ((m = urlRegex.exec(text)) !== null) {
        const url = trimUrl(m[0]);
        if (url && !urls.includes(url)) urls.push(url);
    }
    return urls;
}

// Parse a task description into link chips. Recognises "label | url" (label
// first, pipe-delimited) so a link can carry a short name; any other http(s)
// URL is picked up bare. Returns [{ url, label }] in document order, deduped by
// url, where `label` is the trimmed pipe label or null for a bare URL. Only
// http(s) URLs are matched, so a chip href can never be a javascript: scheme.
export function extractDescLinks(text) {
    const found = [];       // { url, label, index }
    const seen = new Set();

    // "label | url": the label is the text before " | " on the same line — no
    // pipe, no newline — kept non-greedy so it stays as short as the text allows.
    const pipeRe = /([^\n|]+?)\s*\|\s*(https?:\/\/[^\s<]+)/g;
    const spans = [];       // char ranges of matched URLs, to blank out below
    let m;
    while ((m = pipeRe.exec(text)) !== null) {
        const url = trimUrl(m[2]);
        if (!url) continue;
        const urlStart = m.index + m[0].length - m[2].length;
        spans.push([urlStart, urlStart + url.length]);
        if (seen.has(url)) continue;
        seen.add(url);
        found.push({ url, label: m[1].trim() || null, index: urlStart });
    }

    // Blank the matched URLs so extractLinks() won't re-report them as bare.
    let bare = text;
    if (spans.length) {
        const chars = text.split('');
        for (const [s, e] of spans) {
            for (let i = s; i < e; i++) chars[i] = ' ';
        }
        bare = chars.join('');
    }
    for (const url of extractLinks(bare)) {
        if (seen.has(url)) continue;
        seen.add(url);
        found.push({ url, label: null, index: bare.indexOf(url) });
    }

    found.sort((a, b) => a.index - b.index);
    return found.map(({ url, label }) => ({ url, label }));
}

// Short display label for a link chip: just the host, so
// "https://www.example.com/a/b/c" shows as "www.example.com". Falls back to the
// full string if it doesn't parse as a URL (extractLinks only yields http(s),
// so that's a belt-and-braces guard).
export function formatLinkLabel(url) {
    try {
        return new URL(url).hostname;
    } catch {
        return url;
    }
}

// ===== Date helpers =====

// today (+ offsetDays) as a local YYYY-MM-DD string.
export function getLocalDateString(offsetDays = 0) {
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}

// Format a YYYY-MM-DD string as a short local date, e.g. "Jul 20"
export function formatShortDate(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// Date string of the next occurrence (strictly future) of a weekday (0=Sun..6=Sat)
export function nextWeekdayDateString(targetDow) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    let delta = (targetDow - d.getDay() + 7) % 7;
    if (delta === 0) delta = 7;
    d.setDate(d.getDate() + delta);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function nextMonthDateString() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setMonth(d.getMonth() + 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Format a UTC timestamp (from the DB) as local "Jun 3, 13:33". SQLite emits
// "YYYY-MM-DD HH:MM:SS" with no zone marker, so we normalise to ISO+Z first.
// Returns `fallback` for empty or unparseable input.
export function formatTimestamp(ts, fallback = '') {
    if (!ts) return fallback;
    let dateStr = ts;
    if (!dateStr.includes('T')) {
        dateStr = dateStr.replace(' ', 'T') + 'Z';
    }
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return fallback;
    const month = d.toLocaleDateString('en-US', { month: 'short' });
    const day = d.getDate();
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    return `${month} ${day}, ${hours}:${minutes}`;
}

export function formatDoneDate(completedAt) {
    return formatTimestamp(completedAt, 'recently');
}

// "Waiting since" label for a past UTC timestamp, as a point in time (reads
// better than a duration): "today", "yesterday", or a short date like "Jul 2".
// `now` is injectable for testing. Returns '' for empty/unparseable input.
export function formatWaitingSince(ts, now = Date.now()) {
    if (!ts) return '';
    let dateStr = ts;
    if (!dateStr.includes('T')) {
        dateStr = dateStr.replace(' ', 'T') + 'Z';
    }
    const then = new Date(dateStr);
    if (isNaN(then.getTime())) return '';
    const days = Math.floor((now - then.getTime()) / 86400000);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    return then.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ===== Context grouping (Contexts tab) =====

// Distinct @context tokens mentioned in a task's title or description,
// lowercased and de-duplicated, in first-seen order. This is the single source
// of truth for "what is a tag" — deriveColor() in app.js builds on it too.
//
// A context '@' must start the text or follow a non-word character, so a tag is
// only recognised where a human would read one. Deliberately NOT tags:
//   - '#412'         '#' is an issue/PR marker, not a context prefix
//   - 'me@host.com'  the '@' is glued to a word char (an email), not a context
export function extractContexts(task) {
    const text = `${task.title || ''} ${task.description || ''}`;
    const re = /(?:^|[^\w])@([\w-]+)/g;
    const seen = [];
    let m;
    while ((m = re.exec(text)) !== null) {
        const tag = m[1].toLowerCase();
        if (!seen.includes(tag)) seen.push(tag);
    }
    return seen;
}

// Group open tasks by context for the Contexts tab. Returns an array of
// { context, tasks } buckets sorted alphabetically by context name; a task with
// several tags appears in each of its buckets. Tasks with no tag collect into a
// trailing bucket with context === null. Within a bucket the input order is
// preserved (the endpoint already sorts by due date). Empty buckets are omitted.
export function groupByContext(tasks) {
    const buckets = new Map();  // context -> tasks[]
    const untagged = [];
    for (const task of tasks) {
        const contexts = extractContexts(task);
        if (contexts.length === 0) {
            untagged.push(task);
            continue;
        }
        for (const ctx of contexts) {
            if (!buckets.has(ctx)) buckets.set(ctx, []);
            buckets.get(ctx).push(task);
        }
    }
    const groups = [...buckets.keys()]
        .sort()
        .map(context => ({ context, tasks: buckets.get(context) }));
    if (untagged.length) groups.push({ context: null, tasks: untagged });
    return groups;
}

// Classify where an open task currently sits, for the state mark shown in the
// Contexts tab. `today` is an injectable local YYYY-MM-DD (defaults to now).
// Order matters: waiting and snooze take the task off the board, so they win
// over its due date; an undated task is Backlog; otherwise it's scheduled.
// Returns { kind, date } where date is the relevant YYYY-MM-DD (or null).
export function deriveTaskState(task, today = getLocalDateString()) {
    if (task.waiting_since) return { kind: 'waiting', date: null };
    if (task.defer_until && task.defer_until > today) {
        return { kind: 'snoozed', date: task.defer_until };
    }
    if (!task.due_date) return { kind: 'backlog', date: null };
    return { kind: 'scheduled', date: task.due_date };
}

// ===== Search query parsing =====

// Normalise a date token to the *start* of the period it names, as YYYY-MM-DD:
//   2025          -> 2025-01-01
//   2025-07       -> 2025-07-01
//   2025-07-03    -> 2025-07-03
// Returns null when the value isn't a valid (partial) date, so the caller can
// fall back to treating the whole token as literal search text.
export function parseDateToken(value) {
    const m = /^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?$/.exec(value);
    if (!m) return null;
    const year = m[1];
    const month = m[2] ? Number(m[2]) : 1;
    const day = m[3] ? Number(m[3]) : 1;
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// Split the raw search bar into structured parts. `before:`/`after:` tokens
// become date bounds (both anchored to the START of the named period, so
// `after:2025 before:2025` meet exactly at 2025-01-01). A token whose value
// isn't a valid date is kept as ordinary search text, so typing "before:lunch"
// still searches literally. Returns { text, after, before }.
export function parseSearchQuery(raw) {
    const words = [];
    let after = '';
    let before = '';
    for (const token of raw.trim().split(/\s+/)) {
        if (!token) continue;
        const m = /^(before|after):(.+)$/i.exec(token);
        if (m) {
            const date = parseDateToken(m[2]);
            if (date) {
                if (m[1].toLowerCase() === 'after') after = date;
                else before = date;
                continue;
            }
        }
        words.push(token);
    }
    return { text: words.join(' '), after, before };
}
