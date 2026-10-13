// Shared by the admin pages. Config values (names, keys, descriptions, args,
// tool descriptions from backends) are untrusted text: put them in the page
// with textContent / .value. Where an HTML template must carry one, escape it
// with this, which is safe in text and in quoted attributes alike.
function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
window.escapeHtml = escapeHtml;
