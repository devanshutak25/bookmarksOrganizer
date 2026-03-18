import { getBookmarkIds, getBookmark, getBookmarkSummaries, patchBookmark, getProgress, searchTags, getTags } from './api.js';
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
                    <div class="bookmark-dropdown-wrap">
                        <input type="text" id="bookmark-search" class="input" placeholder="Jump to bookmark...">
                        <div id="bookmark-dropdown" class="bookmark-dropdown" hidden></div>
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
                        <div id="ai-suggestion-pills" class="tag-pills ai-suggestions-pool"></div>
                    </div>

                    <div id="all-tags-section" class="all-tags-section" hidden>
                        <label class="field-label">All Tags</label>
                        <div id="all-tags-pool" class="all-tags-pool"></div>
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
            let iframeGeneration = 0;

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
            const allTagsSection = document.getElementById('all-tags-section');
            const allTagsPool = document.getElementById('all-tags-pool');
            const filterBar = document.getElementById('filter-bar');
            const bookmarkSearchInput = document.getElementById('bookmark-search');
            const bookmarkDropdown = document.getElementById('bookmark-dropdown');
            let allTags = [];
            let bookmarkSummaries = [];

            // --- Filter bar ---
            filterBar.addEventListener('click', async (e) => {
                const btn = e.target.closest('.filter-btn');
                if (!btn) return;
                filterBar.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                activeFilter = btn.dataset.filter.split(',');
                const hasData = await loadIds();
                if (hasData) {
                    await loadSummaries();
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
                    ? `<img src="${escHtml(bm.favicon)}" class="iframe-toolbar-favicon" alt="">`
                    : '<div class="iframe-toolbar-favicon placeholder-favicon"></div>';

                const displayTitle = bm.custom_title || bm.meta_title || bm.original_title;

                let statusBadge = '';
                if (bm.status !== 'pending') {
                    const cls = bm.status === 'tagged' ? 'badge-success' : bm.status === 'dead' ? 'badge-warn' : 'badge-danger';
                    statusBadge = `<span class="badge ${cls}">${bm.status}</span>`;
                }

                const canIframe = isIframeableUrl(bm.url);
                const generation = ++iframeGeneration;

                previewEl.innerHTML = `
                    <div class="iframe-container">
                        <div class="iframe-toolbar">
                            ${faviconHtml}
                            <span class="iframe-toolbar-title" title="${escHtml(displayTitle)}">${escHtml(truncateUrl(displayTitle, 60))}</span>
                            ${statusBadge}
                            <span class="iframe-toolbar-spacer"></span>
                            <a href="${escHtml(bm.url)}" target="_blank" rel="noopener" class="btn btn-sm btn-open">Open in New Tab &#8599;</a>
                        </div>
                        <div class="iframe-wrapper">
                            ${canIframe
                                ? `<iframe sandbox="allow-scripts allow-same-origin allow-forms" src="${escHtml(bm.url)}"></iframe>`
                                : ''}
                            <div class="iframe-overlay${canIframe ? ' hidden' : ''}">
                                <div class="iframe-overlay-msg">
                                    ${canIframe ? 'This site blocks embedding.' : 'Cannot preview this URL type.'}
                                    <br><a href="${escHtml(bm.url)}" target="_blank" rel="noopener">Open in New Tab &#8599;</a>
                                </div>
                            </div>
                        </div>
                    </div>
                `;

                if (canIframe) {
                    const iframe = previewEl.querySelector('iframe');
                    const overlay = previewEl.querySelector('.iframe-overlay');
                    setupIframeLoadDetection(iframe, overlay, generation);
                }

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
                renderAllTags();
            }

            function renderAllTags() {
                if (allTags.length === 0) {
                    allTagsSection.hidden = true;
                    return;
                }
                allTagsSection.hidden = false;
                allTagsPool.innerHTML = allTags
                    .map(t => {
                        const active = currentTags.includes(t.name);
                        return `<button class="pool-tag-btn${active ? ' active' : ''}" data-tag="${escHtml(t.name)}" style="background:${tagColor(t.name)}">${escHtml(t.name)}</button>`;
                    })
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

            async function refreshAllTags() {
                try {
                    allTags = await getTags();
                    renderAllTags();
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
                        refreshAllTags();
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
                    refreshAllTags();
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

            allTagsPool.addEventListener('click', e => {
                const btn = e.target.closest('.pool-tag-btn');
                if (!btn) return;
                const tag = btn.dataset.tag;
                if (currentTags.includes(tag)) {
                    removeTag(tag);
                } else {
                    addTag(tag);
                }
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

            // --- Bookmark dropdown ---
            function renderDropdown(items) {
                if (items.length === 0) {
                    bookmarkDropdown.hidden = true;
                    return;
                }
                bookmarkDropdown.innerHTML = items
                    .map(s => {
                        const idx = ids.indexOf(s.id);
                        const isActive = idx === currentIndex;
                        return `<div class="bookmark-dropdown-item${isActive ? ' active' : ''}" data-index="${idx}">
                            <span class="status-dot ${escHtml(s.status)}"></span>
                            <span class="bm-title">${escHtml(s.title)}</span>
                            <span class="bm-url">${escHtml(truncateUrl(s.url, 30))}</span>
                        </div>`;
                    })
                    .join('');
                bookmarkDropdown.hidden = false;
            }

            bookmarkSearchInput.addEventListener('focus', () => {
                const q = bookmarkSearchInput.value.trim().toLowerCase();
                const filtered = q
                    ? bookmarkSummaries.filter(s => s.title.toLowerCase().includes(q) || s.url.toLowerCase().includes(q))
                    : bookmarkSummaries;
                renderDropdown(filtered);
            });

            bookmarkSearchInput.addEventListener('input', () => {
                const q = bookmarkSearchInput.value.trim().toLowerCase();
                const filtered = q
                    ? bookmarkSummaries.filter(s => s.title.toLowerCase().includes(q) || s.url.toLowerCase().includes(q))
                    : bookmarkSummaries;
                renderDropdown(filtered);
            });

            bookmarkDropdown.addEventListener('click', e => {
                const item = e.target.closest('.bookmark-dropdown-item');
                if (!item) return;
                const idx = parseInt(item.dataset.index, 10);
                if (idx >= 0) goTo(idx);
                bookmarkDropdown.hidden = true;
                bookmarkSearchInput.value = '';
            });

            document.addEventListener('click', e => {
                if (!e.target.closest('.bookmark-dropdown-wrap')) {
                    bookmarkDropdown.hidden = true;
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

            async function loadSummaries() {
                try {
                    const result = await getBookmarkSummaries(activeFilter);
                    bookmarkSummaries = result.items;
                } catch { bookmarkSummaries = []; }
            }

            // Init
            (async () => {
                getTags().then(tags => { allTags = tags; }).catch(() => {});
                await updateFilterCounts();
                const hasData = await loadIds();
                if (hasData) {
                    await loadSummaries();
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

// -- Iframe utilities --

function isIframeableUrl(url) {
    if (!url) return false;
    try {
        const u = new URL(url);
        return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
        return false;
    }
}

function setupIframeLoadDetection(iframe, overlay, generation) {
    let loaded = false;

    iframe.addEventListener('load', () => {
        loaded = true;
        // If navigation moved on, ignore this callback
        if (generation !== iframe.closest('.iframe-container')?.dataset.gen) return;
    });

    // Fallback: if no load event fires in 5s, assume blocked
    setTimeout(() => {
        if (!loaded && overlay) {
            overlay.classList.remove('hidden');
        }
    }, 5000);
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
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark' ||
        (!document.documentElement.getAttribute('data-theme') && window.matchMedia('(prefers-color-scheme: dark)').matches);
    return isDark ? `hsl(${h}, 50%, 35%)` : `hsl(${h}, 55%, 80%)`;
}
