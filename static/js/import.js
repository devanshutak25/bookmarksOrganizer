import { importFile, getState, startScrape, startAiSuggest, cancelScrape, cancelAiSuggest, getJobStatus } from './api.js';

export function renderImportPage() {
    return {
        html: `
        <div class="page centered">
            <div class="card import-card">
                <h2>Import Bookmarks</h2>
                <div id="import-drop-zone" class="drop-zone">
                    <p>Drag & drop your bookmark .html file here</p>
                    <p class="subtle">or click to browse</p>
                    <input type="file" id="import-file" accept=".html" hidden>
                </div>
                <div id="import-status" class="import-status" hidden></div>
                <div id="import-actions" hidden>
                    <div class="btn-row" style="margin-bottom:0.75rem">
                        <button id="btn-start-scrape" class="btn">Scrape Metadata</button>
                        <button id="btn-start-ai" class="btn">AI Suggest Tags</button>
                        <a href="#triage" class="btn">Skip to Triage</a>
                    </div>
                </div>
                <div id="jobs-progress" hidden>
                    <div class="job-row" id="scrape-row">
                        <span class="job-label">Scraping:</span>
                        <div class="job-bar"><div id="scrape-fill" class="job-fill"></div></div>
                        <span id="scrape-text" class="job-text"></span>
                        <button id="btn-cancel-scrape" class="btn-icon" title="Cancel">&times;</button>
                    </div>
                    <div class="job-row" id="ai-row" hidden>
                        <span class="job-label">AI Suggestions:</span>
                        <div class="job-bar"><div id="ai-fill" class="job-fill"></div></div>
                        <span id="ai-text" class="job-text"></span>
                        <button id="btn-cancel-ai" class="btn-icon" title="Cancel">&times;</button>
                    </div>
                    <div id="jobs-done" hidden>
                        <a href="#triage" class="btn btn-primary" style="margin-top:0.75rem">Start Triage &rarr;</a>
                    </div>
                </div>
            </div>
            <div id="import-resume" class="card import-card" hidden>
                <h2>Resume Session</h2>
                <p id="resume-text"></p>
                <div id="resume-jobs" hidden>
                    <div class="job-row" id="resume-scrape-row" hidden>
                        <span class="job-label">Scraping:</span>
                        <div class="job-bar"><div id="resume-scrape-fill" class="job-fill"></div></div>
                        <span id="resume-scrape-text" class="job-text"></span>
                    </div>
                    <div class="job-row" id="resume-ai-row" hidden>
                        <span class="job-label">AI Suggestions:</span>
                        <div class="job-bar"><div id="resume-ai-fill" class="job-fill"></div></div>
                        <span id="resume-ai-text" class="job-text"></span>
                    </div>
                </div>
                <div class="btn-row" style="margin-top:0.75rem">
                    <a href="#triage" class="btn btn-primary">Resume Triage</a>
                    <button id="btn-resume-scrape" class="btn btn-sm">Re-scrape Unreachable</button>
                </div>
            </div>
        </div>
        `,
        init() {
            const dropZone = document.getElementById('import-drop-zone');
            const fileInput = document.getElementById('import-file');
            const statusEl = document.getElementById('import-status');
            const actionsEl = document.getElementById('import-actions');
            const jobsEl = document.getElementById('jobs-progress');
            const resumeEl = document.getElementById('import-resume');
            const resumeText = document.getElementById('resume-text');

            let pollTimer = null;

            // Check if bookmarks already exist
            getState().then(state => {
                if (state.has_bookmarks) {
                    resumeEl.hidden = false;
                    resumeText.textContent = `You have ${state.progress.total} bookmarks (${state.progress.pending} pending).`;
                    dropZone.parentElement.querySelector('h2').textContent = 'Import New File';

                    // Show active job progress for returning users
                    if (state.jobs.scrape.running || state.jobs.ai_suggest.running) {
                        document.getElementById('resume-jobs').hidden = false;
                        startResumePoll();
                    }
                }
            }).catch(() => {});

            // --- File upload ---
            dropZone.addEventListener('click', () => fileInput.click());

            dropZone.addEventListener('dragover', e => {
                e.preventDefault();
                dropZone.classList.add('drag-over');
            });

            dropZone.addEventListener('dragleave', () => {
                dropZone.classList.remove('drag-over');
            });

            dropZone.addEventListener('drop', e => {
                e.preventDefault();
                dropZone.classList.remove('drag-over');
                const file = e.dataTransfer.files[0];
                if (file) handleFile(file);
            });

            fileInput.addEventListener('change', () => {
                if (fileInput.files[0]) handleFile(fileInput.files[0]);
            });

            async function handleFile(file) {
                statusEl.hidden = false;
                statusEl.textContent = 'Uploading and parsing...';
                statusEl.className = 'import-status';
                actionsEl.hidden = true;
                jobsEl.hidden = true;

                try {
                    const result = await importFile(file);
                    statusEl.textContent = `Imported ${result.imported} bookmarks (${result.duplicates_removed} duplicates removed)`;
                    statusEl.classList.add('success');
                    actionsEl.hidden = false;
                } catch (err) {
                    statusEl.textContent = `Error: ${err.message}`;
                    statusEl.classList.add('error');
                }
            }

            // --- Job triggers ---
            document.getElementById('btn-start-scrape').addEventListener('click', async () => {
                actionsEl.hidden = true;
                jobsEl.hidden = false;
                const result = await startScrape();
                if (result.status === 'started') {
                    startJobPoll();
                } else {
                    document.getElementById('scrape-text').textContent = result.status;
                }
            });

            document.getElementById('btn-start-ai').addEventListener('click', async () => {
                actionsEl.hidden = true;
                jobsEl.hidden = false;
                document.getElementById('ai-row').hidden = false;
                const result = await startAiSuggest();
                if (result.status === 'started' || result.status === 'already_running') {
                    startJobPoll();
                } else {
                    document.getElementById('ai-text').textContent = result.status;
                }
            });

            document.getElementById('btn-cancel-scrape').addEventListener('click', async () => {
                await cancelScrape();
            });

            document.getElementById('btn-cancel-ai').addEventListener('click', async () => {
                await cancelAiSuggest();
            });

            document.getElementById('btn-resume-scrape')?.addEventListener('click', async () => {
                const result = await startScrape(true);
                if (result.status === 'started') {
                    document.getElementById('resume-jobs').hidden = false;
                    startResumePoll();
                }
            });

            function startJobPoll() {
                if (pollTimer) clearInterval(pollTimer);
                pollTimer = setInterval(async () => {
                    try {
                        const status = await getJobStatus();
                        updateJobRow('scrape', status.scrape);
                        updateJobRow('ai', status.ai_suggest);

                        if (!status.scrape.running && !status.ai_suggest.running) {
                            clearInterval(pollTimer);
                            pollTimer = null;
                            document.getElementById('jobs-done').hidden = false;
                        }
                    } catch { /* ignore */ }
                }, 1500);
            }

            function startResumePoll() {
                if (pollTimer) clearInterval(pollTimer);
                pollTimer = setInterval(async () => {
                    try {
                        const status = await getJobStatus();
                        updateResumeRow('scrape', status.scrape);
                        updateResumeRow('ai', status.ai_suggest);

                        if (!status.scrape.running && !status.ai_suggest.running) {
                            clearInterval(pollTimer);
                            pollTimer = null;
                        }
                    } catch { /* ignore */ }
                }, 2000);
            }

            function updateJobRow(prefix, data) {
                const fill = document.getElementById(`${prefix}-fill`);
                const text = document.getElementById(`${prefix}-text`);
                if (!fill || !text) return;
                const pct = data.total > 0 ? (data.completed / data.total) * 100 : 0;
                fill.style.width = `${pct}%`;
                text.textContent = `${data.completed}/${data.total}`;
                if (!data.running && data.completed > 0) {
                    text.textContent += ' (done)';
                }
            }

            function updateResumeRow(prefix, data) {
                const row = document.getElementById(`resume-${prefix}-row`);
                const fill = document.getElementById(`resume-${prefix}-fill`);
                const text = document.getElementById(`resume-${prefix}-text`);
                if (!row || !fill || !text) return;
                if (data.running || data.completed > 0) {
                    row.hidden = false;
                    const pct = data.total > 0 ? (data.completed / data.total) * 100 : 0;
                    fill.style.width = `${pct}%`;
                    text.textContent = data.running ? `${data.completed}/${data.total}` : `${data.completed}/${data.total} (done)`;
                }
            }

            // Cleanup
            return () => {
                if (pollTimer) {
                    clearInterval(pollTimer);
                    pollTimer = null;
                }
            };
        },
    };
}
