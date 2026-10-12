// UI logic. Talks to the app only through window.archiver (see preload.cjs).
const $ = (id) => document.getElementById(id);
const api = window.archiver;

const state = { folder: null, loggedIn: false, running: false, startedAt: 0, total: 0, done: 0, timer: null };

// a clock that ticks every second while archiving, so a long conversation never looks like a hang
function clock(sec) {
  const s = Math.max(0, Math.round(sec));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
}
function renderEta() {
  if (!state.startedAt || !state.total || state.done >= state.total) return;
  const elapsed = (Date.now() - state.startedAt) / 1000;
  const left = state.done >= 3 ? (elapsed / state.done) * (state.total - state.done) : NaN;
  $('progress-eta').textContent = `trwa ${clock(elapsed)}${Number.isFinite(left) ? ` · zostało ${fmtDuration(left)}` : ''}`;
}
function startClock() { stopClock(); state.timer = setInterval(renderEta, 1000); }
function stopClock() { if (state.timer) clearInterval(state.timer); state.timer = null; }

function setStatus(kind, text) {
  const el = $('status');
  el.className = `status ${kind}`;
  el.textContent = text;
}

function refreshButtons() {
  $('btn-start').disabled = state.running || !state.folder;
  $('btn-folder').disabled = state.running;
  $('btn-login').disabled = state.running;
  $('btn-cancel').hidden = !state.running;
  $('chk-full').disabled = state.running;
  $('step-folder').classList.toggle('done', Boolean(state.folder));
  $('step-login').classList.toggle('done', state.loggedIn);
}

function showFolder(info) {
  if (!info) return;
  state.folder = info.folder;
  $('folder-path').textContent = info.folder;
  $('folder-path').className = 'path';
  $('folder-note').textContent = info.conversations
    ? `W tym folderze jest już archiwum: ${info.conversations} rozmów. Zostanie uzupełnione o nowe i zmienione.`
    : `Rozmowy trafią do: ${info.archive}`;
  refreshButtons();
}

function fmtDuration(sec) {
  if (!Number.isFinite(sec) || sec < 1) return '';
  if (sec < 60) return `ok. ${Math.round(sec)} s`;
  const m = Math.round(sec / 60);
  return m < 60 ? `ok. ${m} min` : `ok. ${Math.floor(m / 60)} h ${m % 60} min`;
}

function onProgress(ev) {
  switch (ev.event) {
    case 'start':
      $('result').hidden = true;
      break;
    case 'phase':
      setStatus('wait', `${ev.message} Proszę czekać…`);
      if (ev.phase !== 'downloading') {
        $('progress').hidden = false;
        $('bar-fill').classList.add('indeterminate');
        $('progress-count').textContent = '';
        $('progress-eta').textContent = '';
      }
      break;
    case 'listed':
      state.total = ev.todo;
      state.done = 0;
      state.startedAt = Date.now();
      if (ev.todo) startClock();
      $('bar-fill').classList.remove('indeterminate');
      $('bar-fill').style.width = ev.todo ? '0%' : '100%';
      $('progress-count').textContent = `0 / ${ev.todo}`;
      if (!ev.todo) setStatus('ok', `Wszystkie ${ev.total} rozmów jest już w archiwum — nic nowego do pobrania.`);
      break;
    case 'progress': {
      const pct = state.total ? Math.round((ev.done / state.total) * 100) : 100;
      $('bar-fill').style.width = `${pct}%`;
      $('progress-count').textContent = `${ev.done} / ${ev.total} (${pct}%)`;
      $('progress-title').textContent = `${ev.status === 'failed' ? 'Błąd: ' : ''}${ev.title}`;
      state.done = ev.done;
      renderEta();
      setStatus('wait', 'Trwa archiwizacja — nie zamykaj aplikacji ani okna przeglądarki na pasku zadań. Proszę czekać…');
      break;
    }
    case 'warning':
      break;   // missing old attachments are normal; listed in the archive log
    case 'login_required':
      stopClock();
      state.loggedIn = false;
      $('login-state').textContent = 'Wymagane logowanie';
      $('login-state').className = 'error';
      setStatus('error', 'Sesja wygasła lub nie zalogowano. Kliknij „Zaloguj do ChatGPT”, a potem uruchom archiwizację ponownie — dokończy od miejsca przerwania.');
      break;
    case 'cancelled':
      stopClock();
      setStatus('info', ev.message);
      break;
    case 'error':
      stopClock();
      setStatus('error', ev.message);
      break;
    case 'done': {
      stopClock();
      const t = `Zapisano ${ev.saved} rozmów${ev.skipped ? `, ${ev.skipped} było już aktualnych` : ''}${ev.failed ? `, ${ev.failed} nie udało się pobrać (spróbuje ponownie przy następnym uruchomieniu)` : ''}.`;
      setStatus(ev.failed ? 'wait' : 'ok', `Archiwizacja zakończona. ${t}`);
      $('bar-fill').classList.remove('indeterminate');
      $('bar-fill').style.width = '100%';
      $('progress-eta').textContent = '';
      $('result').hidden = false;
      $('result-title').textContent = ev.failed ? 'Zakończono z uwagami' : 'Gotowe';
      $('result-text').textContent = `${t} Czas: ${fmtDuration(ev.durationSec) || 'kilka sekund'}.`;
      break;
    }
  }
}

$('btn-folder').addEventListener('click', async () => {
  showFolder(await api.chooseFolder());
  if (state.folder && !state.loggedIn) setStatus('info', 'Teraz zaloguj się do ChatGPT (krok 2) albo od razu rozpocznij archiwizację, jeśli logowałeś się wcześniej.');
});

$('btn-login').addEventListener('click', async () => {
  state.running = true; refreshButtons();
  $('login-state').textContent = 'Logowanie…';
  $('login-state').className = 'muted';
  const r = await api.login();
  state.running = false;
  state.loggedIn = r.ok;
  $('login-state').textContent = r.ok ? `Zalogowano · ${r.workspace}` : 'Nie zalogowano';
  $('login-state').className = r.ok ? 'ok' : 'error';
  setStatus(r.ok ? 'ok' : 'error', r.ok ? `${r.message} Możesz rozpocząć archiwizację.` : r.message);
  refreshButtons();
});

$('btn-start').addEventListener('click', async () => {
  state.running = true; refreshButtons();
  $('result').hidden = true;
  $('progress').hidden = false;
  $('progress-title').textContent = '';
  setStatus('wait', 'Uruchamiam… Proszę czekać.');
  const r = await api.start($('chk-full').checked);
  stopClock();
  state.running = false;
  if (r.folderInfo) showFolder(r.folderInfo);
  if (r.code === 0 || r.code === 2) { state.loggedIn = true; $('login-state').textContent = 'Zalogowano'; $('login-state').className = 'ok'; }
  if (r.message) setStatus('error', r.message);
  refreshButtons();
});

$('btn-cancel').addEventListener('click', async () => {
  $('btn-cancel').disabled = true;
  setStatus('wait', 'Przerywam po bieżącej rozmowie… Proszę czekać.');
  await api.cancel();
  $('btn-cancel').disabled = false;
});

$('btn-open-index').addEventListener('click', () => api.openIndex());
$('btn-open-folder').addEventListener('click', () => api.openArchive());

api.onProgress(onProgress);
api.onStatus((s) => setStatus(s.kind, s.text));

(async () => {
  const info = await api.info();
  $('ver').textContent = info.version;
  $('ws').textContent = info.workspace;
  if (info.folderInfo) showFolder(info.folderInfo);
  if (info.settings.lastRun) {
    const d = new Date(info.settings.lastRun.at);
    setStatus('info', `Ostatnia archiwizacja: ${d.toLocaleString('pl-PL')}. Kliknij „Rozpocznij archiwizację”, aby pobrać nowe rozmowy.`);
  }
  refreshButtons();
})();
