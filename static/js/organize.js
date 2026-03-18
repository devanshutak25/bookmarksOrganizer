import {
    getFolders, createFolder, patchFolder, deleteFolder, reorderFolders,
    assignFolderTags, getFolderPreview, getTags, patchSetting, getState,
    deleteTag, renameTag,
} from './api.js';
import { showToast } from './app.js';

export function renderOrganizePage() {
    return {
        html: `
        <div class="page organize-page">
            <div class="organize-layout">
                <div class="organize-left">
                    <div class="panel-header">
                        <h3>Folders</h3>
                        <button id="btn-add-root-folder" class="btn btn-sm">+ Add Folder</button>
                    </div>
                    <div id="folder-tree" class="folder-tree"></div>
                </div>
                <div class="organize-right">
                    <div class="panel-header">
                        <h3>Tags</h3>
                        <span id="unassigned-count" class="subtle"></span>
                    </div>
                    <div id="tag-pool" class="tag-pool"></div>

                    <div class="dup-setting">
                        <label class="field-label">Duplicate handling</label>
                        <div class="radio-group">
                            <label><input type="radio" name="dup" value="first" id="dup-first" checked> Place in first matching folder</label>
                            <label><input type="radio" name="dup" value="duplicate" id="dup-duplicate"> Duplicate into all matching folders</label>
                        </div>
                    </div>

                    <div class="preview-section">
                        <button id="btn-preview" class="btn">Preview Export</button>
                        <div id="preview-tree" class="preview-tree" hidden></div>
                    </div>
                </div>
            </div>
        </div>
        `,
        init() {
            let folderData = [];
            let tagData = [];
            let draggedTag = null;
            let selectedTags = new Set();

            const treeEl = document.getElementById('folder-tree');
            const poolEl = document.getElementById('tag-pool');
            const unassignedEl = document.getElementById('unassigned-count');
            const previewEl = document.getElementById('preview-tree');

            async function refresh() {
                try {
                    [folderData, tagData] = await Promise.all([getFolders(), getTags()]);
                    renderTree();
                    renderPool();
                } catch (err) {
                    showToast(`Failed to load: ${err.message}`, 'error');
                }
            }

            getState().then(s => {
                if (s.duplicate_handling === 'duplicate') {
                    document.getElementById('dup-duplicate').checked = true;
                }
            }).catch(() => {});

            // --- Folder tree ---
            function renderTree() {
                treeEl.innerHTML = folderData.length === 0
                    ? '<p class="subtle" style="padding:1rem">No folders yet. Create one to get started.</p>'
                    : renderFolderNodes(folderData, 0);
            }

            function renderFolderNodes(nodes, depth) {
                return nodes.map(f => {
                    const indent = depth * 1.25;
                    const childrenHtml = f.children.length > 0 ? renderFolderNodes(f.children, depth + 1) : '';
                    const tagsHtml = f.tags.map(t =>
                        `<span class="folder-tag-pill" style="background:${tagColor(t)}">${esc(t)}</span>`
                    ).join('');

                    return `
                    <div class="folder-node" data-folder-id="${f.id}" style="padding-left:${indent}rem"
                         ondragover="event.preventDefault()" >
                        <div class="folder-row">
                            <span class="folder-icon">&#128193;</span>
                            <span class="folder-name" data-id="${f.id}">${esc(f.name)}</span>
                            <span class="folder-count">${f.bookmark_count}</span>
                            <div class="folder-tags-inline">${tagsHtml}</div>
                            <div class="folder-actions">
                                <button class="btn-icon" data-action="add-sub" data-id="${f.id}" title="Add subfolder">+</button>
                                <button class="btn-icon" data-action="rename" data-id="${f.id}" title="Rename">&#9998;</button>
                                <button class="btn-icon btn-icon-danger" data-action="delete" data-id="${f.id}" title="Delete">&times;</button>
                            </div>
                        </div>
                        ${childrenHtml}
                    </div>`;
                }).join('');
            }

            // --- Tag pool ---
            function renderPool() {
                const assignedTags = new Set();
                function collectAssigned(nodes) {
                    for (const f of nodes) {
                        for (const t of f.tags) assignedTags.add(t);
                        collectAssigned(f.children);
                    }
                }
                collectAssigned(folderData);

                const unassignedTags = tagData.filter(t => !assignedTags.has(t.name));
                unassignedEl.textContent = unassignedTags.length > 0
                    ? `${unassignedTags.length} tag${unassignedTags.length !== 1 ? 's' : ''} unassigned`
                    : 'All tags assigned';

                poolEl.innerHTML = tagData.map(t => {
                    const assigned = assignedTags.has(t.name);
                    const selected = selectedTags.has(t.name);
                    const zeroCount = t.count === 0;
                    return `<span class="pool-tag ${assigned ? 'assigned' : ''} ${selected ? 'selected' : ''} ${zeroCount ? 'orphan' : ''}"
                                 draggable="true" data-tag="${esc(t.name)}" data-tag-id="${t.id}"
                                 style="background:${assigned ? '' : tagColor(t.name)}">
                                ${esc(t.name)} <span class="subtle">(${t.count})</span>
                                <button class="tag-action-btn" data-tag-action="rename" data-tag-id="${t.id}" data-tag-name="${esc(t.name)}" title="Rename/merge">&#9998;</button>
                                <button class="tag-action-btn tag-action-del" data-tag-action="delete" data-tag-id="${t.id}" data-tag-name="${esc(t.name)}" title="Delete">&times;</button>
                            </span>`;
                }).join('');

                if (tagData.length === 0) {
                    poolEl.innerHTML = '<p class="subtle" style="padding:0.5rem">No tags yet. Tag bookmarks in the Triage page first.</p>';
                }
            }

            // --- Events: folder actions ---
            treeEl.addEventListener('click', async (e) => {
                const btn = e.target.closest('[data-action]');
                if (!btn) return;
                const action = btn.dataset.action;
                const id = parseInt(btn.dataset.id);

                if (action === 'add-sub') {
                    const name = prompt('Subfolder name:');
                    if (name?.trim()) {
                        try {
                            await createFolder({ name: name.trim(), parent_id: id });
                            await refresh();
                        } catch (err) { showToast(err.message, 'error'); }
                    }
                } else if (action === 'rename') {
                    const current = btn.closest('.folder-row').querySelector('.folder-name').textContent;
                    const name = prompt('New name:', current);
                    if (name?.trim() && name.trim() !== current) {
                        try {
                            await patchFolder(id, { name: name.trim() });
                            await refresh();
                        } catch (err) { showToast(err.message, 'error'); }
                    }
                } else if (action === 'delete') {
                    if (confirm('Delete this folder? Child folders will move to root.')) {
                        try {
                            await deleteFolder(id);
                            await refresh();
                        } catch (err) { showToast(err.message, 'error'); }
                    }
                }
            });

            // --- Events: drag tag onto folder ---
            treeEl.addEventListener('dragover', (e) => {
                e.preventDefault();
                const node = e.target.closest('.folder-node');
                treeEl.querySelectorAll('.folder-node').forEach(n => n.classList.remove('drag-target'));
                if (node) node.classList.add('drag-target');
            });

            treeEl.addEventListener('dragleave', (e) => {
                const node = e.target.closest('.folder-node');
                if (node) node.classList.remove('drag-target');
            });

            treeEl.addEventListener('drop', async (e) => {
                e.preventDefault();
                treeEl.querySelectorAll('.folder-node').forEach(n => n.classList.remove('drag-target'));
                const node = e.target.closest('.folder-node');
                if (!node) return;
                const folderId = parseInt(node.dataset.folderId);

                const tagsToAssign = new Set(selectedTags);
                if (draggedTag) tagsToAssign.add(draggedTag);
                if (tagsToAssign.size === 0) return;

                try {
                    await assignFolderTags(folderId, [...tagsToAssign]);
                    showToast(`Assigned ${tagsToAssign.size} tag(s)`, 'success');
                } catch (err) { showToast(err.message, 'error'); }
                selectedTags.clear();
                draggedTag = null;
                await refresh();
            });

            // --- Events: tag pool ---
            poolEl.addEventListener('dragstart', (e) => {
                const tag = e.target.closest('.pool-tag');
                if (tag) {
                    draggedTag = tag.dataset.tag;
                    e.dataTransfer.setData('text/plain', draggedTag);
                }
            });

            poolEl.addEventListener('click', async (e) => {
                // Tag action buttons
                const actionBtn = e.target.closest('[data-tag-action]');
                if (actionBtn) {
                    e.stopPropagation();
                    const action = actionBtn.dataset.tagAction;
                    const tagId = parseInt(actionBtn.dataset.tagId);
                    const tagName = actionBtn.dataset.tagName;

                    if (action === 'rename') {
                        const newName = prompt(`Rename "${tagName}" to:`, tagName);
                        if (newName?.trim() && newName.trim().toLowerCase() !== tagName) {
                            try {
                                const result = await renameTag(tagId, newName.trim());
                                showToast(result.merged ? `Merged into "${result.name}"` : `Renamed to "${result.name}"`, 'success');
                                await refresh();
                            } catch (err) { showToast(err.message, 'error'); }
                        }
                    } else if (action === 'delete') {
                        if (confirm(`Delete tag "${tagName}"? It will be removed from all bookmarks.`)) {
                            try {
                                await deleteTag(tagId);
                                showToast(`Deleted "${tagName}"`, 'success');
                                await refresh();
                            } catch (err) { showToast(err.message, 'error'); }
                        }
                    }
                    return;
                }

                // Tag selection
                const tag = e.target.closest('.pool-tag');
                if (!tag) return;
                const name = tag.dataset.tag;
                if (selectedTags.has(name)) {
                    selectedTags.delete(name);
                } else {
                    selectedTags.add(name);
                }
                renderPool();
            });

            // Click folder name with selected tags -> bulk assign
            treeEl.addEventListener('click', async (e) => {
                const nameEl = e.target.closest('.folder-name');
                if (!nameEl || selectedTags.size === 0) return;
                if (e.target.closest('.folder-actions')) return;
                const folderId = parseInt(nameEl.dataset.id);
                try {
                    await assignFolderTags(folderId, [...selectedTags]);
                    showToast(`Assigned ${selectedTags.size} tag(s)`, 'success');
                } catch (err) { showToast(err.message, 'error'); }
                selectedTags.clear();
                await refresh();
            });

            // --- Add root folder ---
            document.getElementById('btn-add-root-folder').addEventListener('click', async () => {
                const name = prompt('Folder name:');
                if (name?.trim()) {
                    try {
                        await createFolder({ name: name.trim() });
                        await refresh();
                    } catch (err) { showToast(err.message, 'error'); }
                }
            });

            // --- Duplicate handling ---
            document.querySelectorAll('input[name="dup"]').forEach(radio => {
                radio.addEventListener('change', async (e) => {
                    try {
                        await patchSetting('duplicate_handling', e.target.value);
                        showToast(`Duplicate handling: ${e.target.value}`, 'success');
                    } catch (err) { showToast(err.message, 'error'); }
                });
            });

            // --- Preview ---
            document.getElementById('btn-preview').addEventListener('click', async () => {
                try {
                    const tree = await getFolderPreview();
                    previewEl.hidden = false;
                    previewEl.innerHTML = renderPreviewTree(tree);
                } catch (err) { showToast(err.message, 'error'); }
            });

            function renderPreviewTree(nodes) {
                if (!nodes.length) return '<p class="subtle">No bookmarks to export.</p>';
                return nodes.map(node => {
                    const isUnassigned = node.folder === '_Unassigned';
                    const bms = (node.bookmarks || []).map(b =>
                        `<div class="preview-bm">${esc(b.custom_title || b.original_title)}</div>`
                    ).join('');
                    const children = (node.children || []).length > 0
                        ? renderPreviewTree(node.children) : '';
                    return `
                    <details class="preview-folder-node ${isUnassigned ? 'unassigned' : ''}" open>
                        <summary>${esc(node.folder)} <span class="subtle">(${countBookmarks(node)})</span></summary>
                        ${children}
                        ${bms}
                    </details>`;
                }).join('');
            }

            function countBookmarks(node) {
                let count = (node.bookmarks || []).length;
                for (const child of (node.children || [])) count += countBookmarks(child);
                return count;
            }

            // --- Init ---
            refresh();
        },
    };
}

function esc(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
