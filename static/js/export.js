import { getProgress } from './api.js';

export function renderExportPage() {
    return {
        html: `
        <div class="page centered">
            <div class="card export-card">
                <h2>Export Bookmarks</h2>
                <div id="export-stats" class="export-stats"></div>
                <div class="btn-row export-btns">
                    <a href="/api/export" class="btn btn-primary" download>Download Bookmarks HTML</a>
                    <a href="/api/export?format=json" class="btn" download>Download JSON (full metadata)</a>
                </div>
                <div class="export-instructions">
                    <p class="field-label">To import into your browser:</p>
                    <p>Chrome &rarr; Bookmark Manager &rarr; &#8942; &rarr; Import bookmarks from HTML file</p>
                </div>
                <div class="export-reset">
                    <button id="btn-reset" class="btn btn-danger btn-sm">Start Over</button>
                </div>
            </div>
        </div>
        `,
        init() {
            const statsEl = document.getElementById('export-stats');

            getProgress().then(p => {
                const exporting = p.tagged;
                const excluded = p.dead + p.discarded;
                const pending = p.pending;
                let html = `<p>Exporting <strong>${exporting}</strong> tagged bookmarks.</p>`;
                if (excluded > 0) {
                    html += `<p class="subtle">${excluded} bookmark${excluded !== 1 ? 's' : ''} excluded (${p.dead} dead, ${p.discarded} discarded).</p>`;
                }
                if (pending > 0) {
                    html += `<p class="subtle warn-text">${pending} bookmark${pending !== 1 ? 's' : ''} still pending — consider triaging them first.</p>`;
                }
                statsEl.innerHTML = html;
            }).catch(() => {
                statsEl.innerHTML = '<p class="subtle">Could not load stats.</p>';
            });

            document.getElementById('btn-reset').addEventListener('click', async () => {
                if (!confirm('This will delete ALL bookmarks, tags, and folders. Are you sure?')) return;
                if (!confirm('Really? This cannot be undone.')) return;
                try {
                    const resp = await fetch('/api/reset', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ confirm: true }),
                    });
                    if (resp.ok) {
                        location.hash = '#import';
                        location.reload();
                    }
                } catch { /* ignore */ }
            });
        },
    };
}
