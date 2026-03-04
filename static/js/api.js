const API_BASE = '/api';

async function request(path, options = {}) {
    const url = `${API_BASE}${path}`;
    const resp = await fetch(url, {
        headers: { 'Content-Type': 'application/json', ...options.headers },
        ...options,
    });
    if (!resp.ok) {
        const body = await resp.json().catch(() => ({ detail: resp.statusText }));
        throw new Error(body.detail || `HTTP ${resp.status}`);
    }
    // Handle 204 No Content or empty responses
    const text = await resp.text();
    return text ? JSON.parse(text) : null;
}

export async function getState() {
    return request('/state');
}

export async function importFile(file) {
    const form = new FormData();
    form.append('file', file);
    const resp = await fetch(`${API_BASE}/import`, { method: 'POST', body: form });
    if (!resp.ok) {
        const body = await resp.json().catch(() => ({ detail: resp.statusText }));
        throw new Error(body.detail || `HTTP ${resp.status}`);
    }
    return resp.json();
}

export async function getBookmarkIds(statuses = []) {
    const params = statuses.map(s => `status=${encodeURIComponent(s)}`).join('&');
    return request(`/bookmarks/ids${params ? '?' + params : ''}`);
}

export async function getBookmarkSummaries(statuses = []) {
    const params = statuses.map(s => `status=${encodeURIComponent(s)}`).join('&');
    return request(`/bookmarks/summaries${params ? '?' + params : ''}`);
}

export async function getBookmark(id) {
    return request(`/bookmarks/${id}`);
}

export async function getNextBookmark() {
    return request('/bookmarks/next');
}

export async function patchBookmark(id, data) {
    return request(`/bookmarks/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
    });
}

export async function getProgress() {
    return request('/bookmarks/progress');
}

export async function getTags() {
    return request('/tags');
}

export async function searchTags(q) {
    return request(`/tags/search?q=${encodeURIComponent(q)}`);
}

export async function deleteTag(id) {
    return request(`/tags/${id}`, { method: 'DELETE' });
}

export async function renameTag(id, name) {
    return request(`/tags/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) });
}

// --- Folders ---

export async function getFolders() {
    return request('/folders');
}

export async function createFolder(data) {
    return request('/folders', { method: 'POST', body: JSON.stringify(data) });
}

export async function patchFolder(id, data) {
    return request(`/folders/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
}

export async function deleteFolder(id) {
    return request(`/folders/${id}`, { method: 'DELETE' });
}

export async function reorderFolders(items) {
    return request('/folders/reorder', { method: 'PUT', body: JSON.stringify({ items }) });
}

export async function assignFolderTags(folderId, tags) {
    return request(`/folders/${folderId}/tags`, { method: 'POST', body: JSON.stringify({ tags }) });
}

export async function getFolderPreview() {
    return request('/folders/preview');
}

// --- Settings ---

export async function getSetting(key) {
    return request(`/settings/${key}`);
}

export async function patchSetting(key, value) {
    return request(`/settings/${key}`, { method: 'PATCH', body: JSON.stringify({ value }) });
}

// --- Jobs ---

export async function startScrape(retryUnreachable = false) {
    const qs = retryUnreachable ? '?retry_unreachable=true' : '';
    return request(`/jobs/scrape${qs}`, { method: 'POST' });
}

export async function cancelScrape() {
    return request('/jobs/scrape/cancel', { method: 'POST' });
}

export async function startAiSuggest(retryFailed = false) {
    const qs = retryFailed ? '?retry_failed=true' : '';
    return request(`/jobs/ai-suggest${qs}`, { method: 'POST' });
}

export async function cancelAiSuggest() {
    return request('/jobs/ai-suggest/cancel', { method: 'POST' });
}

export async function getJobStatus() {
    return request('/jobs/status');
}

// --- Reset ---

export async function resetAll() {
    return request('/reset', { method: 'POST', body: JSON.stringify({ confirm: true }) });
}
