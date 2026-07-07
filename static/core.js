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

// Extract http(s) URLs from text, trimming trailing sentence punctuation and
// unbalanced closing brackets (e.g. a URL wrapped in parentheses).
export function extractLinks(text) {
    const urlRegex = /https?:\/\/[^\s<]+/g;
    const urls = [];
    let m;
    while ((m = urlRegex.exec(text)) !== null) {
        let url = m[0];
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
        if (url && !urls.includes(url)) urls.push(url);
    }
    return urls;
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
