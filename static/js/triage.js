import { getBookmarkIds, getBookmark, patchBookmark, getProgress, searchTags } from './api.js';
import { showToast } from './app.js';

export function renderTriagePage() {
    return {
        html: `
        <div class="page triage-page">
            <div class="triage-progress-bar">
                <div id="triage-progress-fill" class="progress-fill"></div>
            </div>
            <div class="filter-bar" id="filter-bar">
                <button class="filter-btn active" data-filter="pending,tagged">All</button>
                <button class="filter-btn" data-filter="pending">Pending <span id="fc-pending" class="filter-count"></span></button>
                <button class="filter-btn" data-filter="tagged">Tagged <span id="fc-tagged" class="filter-count"></span></button>
                <button class="filter-btn" data-filter="dead">Dead <span id="fc-dead" class="filter-count"></span></button>
                <button class="filter-btn" data-filter="discarded">Discarded <span id="fc-discarded" class="filter-count"></span></button>
            </div>
            <div class="triage-layout">
                <div class="triage-preview" id="triage-preview">
                    <div class="empty-state" id="triage-empty">
                        <h2>No bookmarks to triage</h2>
                        <p>Import bookmarks first or change your filter.</p>
                        <a href="#import" class="btn btn-primary">Go to Import</a>
                    </div>
                </div>
                <div class="triage-actions" id="triage-actions">
                    <div class="triage-header">
                        <span id="triage-counter" class="counter"></span>
                        <div class="nav-btns">
                            <button id="btn-prev" class="btn btn-sm" title="Left arrow">&larr; Prev</button>
                            <button id="btn-next" class="btn btn-sm" title="Right arrow">Next &rarr;</button>
                        </div>
                    </div>
                    <div id="triage-url" class="triage-url"></div>
                    <label class="field-label">Title</label>
                    <input type="text" id="triage-title" class="input" placeholder="Enter a title">

                    <label class="field-label">Tags</label>
                    <div class="tags-area">
                        <div id="triage-tags" class="tag-pills"></div>
                        <div class="tag-input-wrap">
                            <input type="text" id="triage-tag-input" class="input" placeholder="Add tag...">
                            <div id="tag-autocomplete" class="autocomplete-dropdown" hidden></div>
                        </div>
                    </div>

                    <div id="ai-suggestions" class="ai-suggestions" hidden>
                        <label class="field-label">AI suggests:</label>
                        <div id="ai-suggestion-pills" class="tag-pills"></div>
                    </div>

                    <div class="action-btns">
                        <button id="btn-save" class="btn btn-primary" title="Ctrl+Enter">Save &amp; Next</button>
                        <button id="btn-skip" class="btn btn-sm">Skip</button>
                        <button id="btn-dead" class="btn btn-sm btn-danger" title="D key">Mark Dead</button>
                        <button id="btn-discard" class="btn btn-sm btn-danger">Discard</button>
                    </div>
                    <div class="kbd-hints">
                        <span><kbd>&larr;</kbd><kbd>&rarr;</kbd> navigate</span>
                        <span><kbd>Ctrl+Enter</kbd> save</span>
                        <span><kbd>D</kbd> dead</span>
                    </div>
                </div>
            </div>
        </div>
        `,
        init() {
            let ids = [];
            let currentIndex = -1;
            let currentBookmark = null;
            let currentTags = [];
            let autoSaveTimer = null;
            let activeFilter = ['pending', 'tagged'];

            const previewEl = document.getElementById('triage-preview');
            const emptyEl = document.getElementById('triage-empty');
            const actionsEl = document.getElementById('triage-actions');
            const counterEl = document.getElementById('triage-counter');
            const progressFill = document.getElementById('triage-progress-fill');
            const titleInput = document.getElementById('triage-title');
            const urlEl = document.getElementById('triage-url');
            const tagsEl = document.getElementById('triage-tags');
            const tagInput = document.getElementById('triage-tag-input');
            const autocompleteEl = document.getElementById('tag-autocomplete');
            const aiSuggestionsEl = document.getElementById('ai-suggestions');
            const aiPillsEl = document.getElementById('ai-suggestion-pills');
            const filterBar = document.getElementById('filter-bar');

            // --- Filter bar ---
            filterBar.addEventListener('click', async (e) => {
                const btn = e.target.closest('.filter-btn');
                if (!btn) return;
                filterBar.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                activeFilter = btn.dataset.filter.split(',');
                const hasData = await loadIds();
                if (hasData) {
                    await goTo(0);
                } else {
                    previewEl.innerHTML = '';
                    previewEl.appendChild(emptyEl);
                    emptyEl.hidden = false;
                }
            });

            async function updateFilterCounts() {
                try {
                    const p = await getProgress();
                    const el = (id) => document.getElementById(id);
                    el('fc-pending').textContent = p.pending;
                    el('fc-tagged').textContent = p.tagged;
                    el('fc-dead').textContent = p.dead;
                    el('fc-discarded').textContent = p.discarded;
                } catch { /* ignore */ }
            }

            async function loadIds() {
                const result = await getBookmarkIds(activeFilter);
                ids = result.ids;
                if (ids.length === 0) {
                    emptyEl.hidden = false;
                    actionsEl.style.visibility = 'hidden';
                    return false;
                }
                emptyEl.hidden = true;
                actionsEl.style.visibility = 'visible';
                return true;
            }

            async function loadBookmark(id) {
                currentBookmark = await getBookmark(id);
                currentTags = [...(currentBookmark.tags || [])];
                render();
            }

            function render() {
                if (!currentBookmark) return;
                const bm = currentBookmark;

                const faviconHtml = bm.favicon
                    ? `<img src="${escHtml(bm.favicon)}" class="preview-favicon" alt="">`
                    : '<div class="preview-favicon placeholder-favicon"></div>';

                const displayTitle = bm.custom_title || bm.meta_title || bm.original_title;
                const unreachable = bm.meta_title === '[UNREACHABLE]';

                let metaSection = '';
                if (bm.meta_description) {
                    metaSection = `<p class="preview-description">${escHtml(bm.meta_description)}</p>`;
                }
                if (bm.meta_title && bm.meta_title !== bm.original_title && !unreachable) {
                    metaSection += `<p class="preview-meta-diff"><span class="subtle">Page title:</span> ${escHtml(bm.meta_title)}</p>`;
                }

                let statusBadge = '';
                if (bm.status !== 'pending') {
                    const cls = bm.status === 'tagged' ? 'badge-success' : bm.status === 'dead' ? 'badge-warn' : 'badge-danger';
                    statusBadge = `<span class="badge ${cls}">${bm.status}</span>`;
                }

                previewEl.innerHTML = `
                    <div class="preview-card">
                        <div class="preview-header">
                            ${faviconHtml}
                            <h2 class="preview-title">${escHtml(displayTitle)}</h2>
                            ${statusBadge}
                        </div>
                        ${unreachable ? '<div class="badge badge-warn">Site may be down</div>' : ''}
                        <a href="${escHtml(bm.url)}" target="_blank" rel="noopener" class="preview-url">${escHtml(truncateUrl(bm.url))}</a>
                        ${bm.original_folder ? `<p class="preview-folder subtle">${escHtml(bm.original_folder)}</p>` : ''}
                        ${metaSection}
                        <a href="${escHtml(bm.url)}" target="_blank" rel="noopener" class="btn btn-open">Open in New Tab &#8599;</a>
                    </div>
                `;

                titleInput.value = bm.custom_title || bm.meta_title || bm.original_title || '';
                urlEl.innerHTML = `<a href="${escHtml(bm.url)}" target="_blank" rel="noopener">${escHtml(truncateUrl(bm.url, 50))}</a>`;
                counterEl.textContent = `${currentIndex + 1} / ${ids.length}`;

                renderTags();

                if (bm.ai_suggestions && bm.ai_suggestions.length > 0) {
                    const remaining = bm.ai_suggestions.filter(s => !currentTags.includes(s));
                    if (remaining.length > 0) {
                        aiSuggestionsEl.hidden = false;
                        aiPillsEl.innerHTML = remaining
                            .map(s => `<button class="tag-pill ai-pill" data-tag="${escHtml(s)}">${escHtml(s)}</button>`)
                            .join('');
                    } else {
                        aiSuggestionsEl.hidden = true;
                    }
                } else {
                    aiSuggestionsEl.hidden = true;
                }

                updateProgress();
                updateFilterCounts();
            }

            function renderTags() {
                tagsEl.innerHTML = currentTags
                    .map(t => `<span class="tag-pill" style="background:${tagColor(t)}">${escHtml(t)}<button class="tag-remove" data-tag="${escHtml(t)}">&times;</button></span>`)
                    .join('');
            }

            async function updateProgress() {
                try {
                    const p = await getProgress();
                    const done = p.tagged + p.dead + p.discarded;
                    const pct = p.total > 0 ? (done / p.total) * 100 : 0;
                    progressFill.style.width = `${pct}%`;
                } catch { /* ignore */ }
            }

            function scheduleAutoSave() {
                if (autoSaveTimer) clearTimeout(autoSaveTimer);
                autoSaveTimer = setTimeout(async () => {
                    if (!currentBookmark) return;
                    try {
                        await patchBookmark(currentBookmark.id, {
                            custom_title: titleInput.value.trim() || null,
                            tags: currentTags,
                        });
                    } catch (err) {
                        showToast(`Auto-save failed: ${err.message}`, 'error');
                    }
                }, 1000);
            }

            function cancelAutoSave() {
                if (autoSaveTimer) {
                    clearTimeout(autoSaveTimer);
                    autoSaveTimer = null;
                }
            }

            async function goTo(index) {
                if (index < 0 || index >= ids.length) return;
                currentIndex = index;
                await loadBookmark(ids[currentIndex]);
            }

            async function saveAndNext() {
                if (!currentBookmark) return;
                if (currentTags.length === 0) {
                    showToast('Add at least one tag before saving', 'warn');
                    titleInput.classList.add('shake');
                    setTimeout(() => titleInput.classList.remove('shake'), 500);
                    return;
                }
                cancelAutoSave();
                try {
                    await patchBookmark(currentBookmark.id, {
                        custom_title: titleInput.value.trim() || null,
                        status: 'tagged',
                        tags: currentTags,
                    });
                    showToast('Saved', 'success');
                } catch (err) {
                    showToast(`Save failed: ${err.message}`, 'error');
                    return;
                }
                if (currentIndex < ids.length - 1) {
                    await goTo(currentIndex + 1);
                } else {
                    await loadIds();
                    if (ids.length > 0) await goTo(0);
                }
            }

            async function markStatus(status) {
                if (!currentBookmark) return;
                cancelAutoSave();
                try {
                    await patchBookmark(currentBookmark.id, { status });
                    showToast(`Marked as ${status}`, 'success');
                } catch (err) {
                    showToast(`Failed: ${err.message}`, 'error');
                    return;
                }
                if (currentIndex < ids.length - 1) {
                    await goTo(currentIndex + 1);
                } else {
                    await loadIds();
                    if (ids.length > 0) await goTo(0);
                }
            }

            function addTag(name) {
                name = name.trim().toLowerCase();
                if (!name || currentTags.includes(name)) return;
                currentTags.push(name);
                renderTags();
                scheduleAutoSave();
                if (currentBookmark?.ai_suggestions) {
                    const remaining = currentBookmark.ai_suggestions.filter(s => !currentTags.includes(s));
                    if (remaining.length > 0) {
                        aiPillsEl.innerHTML = remaining
                            .map(s => `<button class="tag-pill ai-pill" data-tag="${escHtml(s)}">${escHtml(s)}</button>`)
                            .join('');
                    } else {
                        aiSuggestionsEl.hidden = true;
                    }
                }
            }

            function removeTag(name) {
                currentTags = currentTags.filter(t => t !== name);
                renderTags();
                scheduleAutoSave();
            }

            // Event listeners
            document.getElementById('btn-prev').addEventListener('click', () => goTo(currentIndex - 1));
            document.getElementById('btn-next').addEventListener('click', () => goTo(currentIndex + 1));
            document.getElementById('btn-save').addEventListener('click', saveAndNext);
            document.getElementById('btn-skip').addEventListener('click', () => goTo(currentIndex + 1));
            document.getElementById('btn-dead').addEventListener('click', () => markStatus('dead'));
            document.getElementById('btn-discard').addEventListener('click', () => markStatus('discarded'));

            titleInput.addEventListener('input', scheduleAutoSave);

            tagsEl.addEventListener('click', e => {
                const btn = e.target.closest('.tag-remove');
                if (btn) removeTag(btn.dataset.tag);
            });

            aiPillsEl.addEventListener('click', e => {
                const pill = e.target.closest('.ai-pill');
                if (pill) addTag(pill.dataset.tag);
            });

            let acTimer = null;
            tagInput.addEventListener('input', () => {
                const q = tagInput.value.trim();
                if (acTimer) clearTimeout(acTimer);
                if (!q) {
                    autocompleteEl.hidden = true;
                    return;
                }
                acTimer = setTimeout(async () => {
                    const results = await searchTags(q);
                    if (results.length > 0) {
                        autocompleteEl.innerHTML = results
                            .map(t => `<div class="ac-item" data-tag="${escHtml(t.name)}">${escHtml(t.name)} <span class="subtle">(${t.count})</span></div>`)
                            .join('');
                        autocompleteEl.hidden = false;
                    } else {
                        autocompleteEl.hidden = true;
                    }
                }, 200);
            });

            tagInput.addEventListener('keydown', e => {
                if (e.key === 'Enter' || e.key === ',') {
                    e.preventDefault();
                    const val = tagInput.value.replace(',', '').trim();
                    if (val) {
                        addTag(val);
                        tagInput.value = '';
                        autocompleteEl.hidden = true;
                    }
                }
            });

            autocompleteEl.addEventListener('click', e => {
                const item = e.target.closest('.ac-item');
                if (item) {
                    addTag(item.dataset.tag);
                    tagInput.value = '';
                    autocompleteEl.hidden = true;
                }
            });

            document.addEventListener('click', e => {
                if (!e.target.closest('.tag-input-wrap')) {
                    autocompleteEl.hidden = true;
                }
            });

            // Keyboard shortcuts
            function onKeyDown(e) {
                if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
                    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                        e.preventDefault();
                        saveAndNext();
                    }
                    return;
                }
                if (e.key === 'ArrowRight') goTo(currentIndex + 1);
                else if (e.key === 'ArrowLeft') goTo(currentIndex - 1);
                else if (e.key === 'd') markStatus('dead');
            }
            document.addEventListener('keydown', onKeyDown);

            // Init
            (async () => {
                await updateFilterCounts();
                const hasData = await loadIds();
                if (hasData) {
                    await goTo(0);
                }
            })();

            return () => {
                cancelAutoSave();
                document.removeEventListener('keydown', onKeyDown);
            };
        },
    };
}

// -- Utilities --

function escHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function truncateUrl(url, max = 80) {
    return url.length > max ? url.slice(0, max) + '...' : url;
}

function tagColor(name) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
        hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    const h = Math.abs(hash) % 360;
    return `hsl(${h}, 55%, 80%)`;
}
