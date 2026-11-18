// Shared by the admin pages. Config values (names, keys, descriptions, args,
// tool descriptions from backends) are untrusted text: put them in the page
// with textContent / .value. Where an HTML template must carry one, escape it
// with this, which is safe in text and in quoted attributes alike.
function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
window.escapeHtml = escapeHtml;

// Clears a status line after `ms`, but only if it still shows the message it
// showed when this was called: a newer message (a refused save, say) is never
// wiped by an older timer. `color`, when given, is restored with the clear.
function clearStatusLater(el, ms, color) {
    if (!el) return;
    const shown = el.textContent;
    setTimeout(() => {
        if (el.textContent !== shown) return;
        el.textContent = '';
        if (color !== undefined) el.style.color = color;
    }, ms);
}
window.clearStatusLater = clearStatusLater;
