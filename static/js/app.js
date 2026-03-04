import { getState } from './api.js';
import { renderImportPage } from './import.js';
import { renderTriagePage } from './triage.js';
import { renderOrganizePage } from './organize.js';
import { renderExportPage } from './export.js';

const appEl = document.getElementById('app');

const pages = {
    import: renderImportPage,
    triage: renderTriagePage,
    organize: renderOrganizePage,
    export: renderExportPage,
};

let currentCleanup = null;

function updateNav(page) {
    document.querySelectorAll('.nav-link').forEach(link => {
        link.classList.toggle('active', link.dataset.page === page);
    });
}

async function navigate() {
    const hash = location.hash.slice(1) || 'import';
    const page = pages[hash] ? hash : 'import';
    updateNav(page);

    if (currentCleanup) {
        currentCleanup();
        currentCleanup = null;
    }

    const result = pages[page]();
    if (typeof result === 'string') {
        appEl.innerHTML = result;
    } else if (result && typeof result.html === 'string') {
        appEl.innerHTML = result.html;
        if (result.init) {
            currentCleanup = await result.init() || null;
        }
    }
}

window.addEventListener('hashchange', navigate);

// --- Theme toggle ---
function initTheme() {
    const toggle = document.getElementById('theme-toggle');
    if (!toggle) return;

    function getEffectiveTheme() {
        const saved = localStorage.getItem('theme');
        if (saved) return saved;
        return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }

    function applyTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('theme', theme);
    }

    toggle.addEventListener('click', () => {
        const current = getEffectiveTheme();
        applyTheme(current === 'dark' ? 'light' : 'dark');
    });
}

initTheme();

// --- Toast notifications ---
const toastContainer = document.getElementById('toast-container');

export function showToast(message, type = 'info') {
    if (!toastContainer) return;
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    toastContainer.appendChild(toast);

    // Trigger animation
    requestAnimationFrame(() => toast.classList.add('show'));

    setTimeout(() => {
        toast.classList.remove('show');
        toast.addEventListener('transitionend', () => toast.remove());
    }, 2500);
}

// --- Initial load ---
(async () => {
    try {
        const state = await getState();
        if (state.has_bookmarks && (!location.hash || location.hash === '#import')) {
            location.hash = '#triage';
        }
    } catch {
        // API not ready
    }
    navigate();
})();
