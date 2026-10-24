import { createHash } from 'node:crypto';
import { formatSize } from './file-types.js';

// La page de dépôt : un seul document, sans ressource externe. Style et script en ligne, autorisés par leur
// empreinte dans la CSP (pas de 'unsafe-inline'). Les données de la page passent par un bloc JSON non exécuté.

export interface PageData {
  folder: string; // dossier cible, tel qu'affiché
  user: string; // nom de la personne connectée
  expiresAt: string; // ISO 8601
  extensions: string[];
  maxBytes?: number; // total d'un envoi
  maxFiles: number;
}

const STYLE = `
:root{--bg:#f7f7f5;--card:#fff;--text:#1f1f1c;--muted:#6b6a64;--line:#dddcd5;--accent:#2f5bd3;--ok:#1d7a46;
--bad:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#1b1b19;--card:#252522;--text:#ecebe6;--muted:#a3a29b;--line:#3a3934;
--accent:#8aa8ff;--ok:#5fc48c;--bad:#ff8a80}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:560px;margin:0 auto;padding:40px 16px}
h1{font-size:22px;margin:0 0 4px}
.meta{color:var(--muted);margin:0 0 24px;font-size:14px}
.meta strong{color:var(--text);font-weight:600}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px}
.drop{display:block;border:2px dashed var(--line);border-radius:10px;padding:28px 16px;text-align:center;cursor:pointer}
.drop.over,.drop:focus-within{border-color:var(--accent)}
.drop input{position:absolute;width:1px;height:1px;opacity:0}
.drop span{display:block;color:var(--muted);font-size:14px;margin-top:4px}
ul{list-style:none;padding:0;margin:16px 0 0}
li{display:flex;gap:8px;align-items:baseline;padding:8px 0;border-top:1px solid var(--line);font-size:14px}
li .name{flex:1;overflow-wrap:anywhere}
li .size{color:var(--muted)}
li .why{color:var(--bad);flex-basis:100%}
li.bad{flex-wrap:wrap}
li button{background:none;border:0;color:var(--muted);cursor:pointer;font-size:14px;padding:0 4px}
.send{margin-top:16px;width:100%;padding:12px;border:0;border-radius:8px;background:var(--accent);color:#fff;
font-size:16px;font-weight:600;cursor:pointer}
.send:disabled{opacity:.45;cursor:default}
.status{margin:16px 0 0;font-size:15px}
.status.ok{color:var(--ok)}
.status.bad{color:var(--bad)}
.hint{color:var(--muted);font-size:13px;margin:16px 0 0}
`;

const SCRIPT = `
(() => {
  const data = JSON.parse(document.getElementById('data').textContent);
  const $ = (id) => document.getElementById(id);
  const input = $('input'), drop = $('drop'), list = $('list'), send = $('send'), status = $('status');
  const expires = new Date(data.expiresAt);
  $('expires').textContent = expires.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  input.accept = data.extensions.map((e) => '.' + e).join(',');
  let files = [];
  let done = false;
  let refusedByServer = {}; // nom -> raison : gardé jusqu'à ce que le fichier soit retiré ou remplacé

  const size = (n) => n < 1024 ? n + ' o' : n < 1048576 ? Math.round(n / 1024) + ' Ko'
    : (n / 1048576).toFixed(1).replace(/\\.0$/, '').replace('.', ',') + ' Mo';
  const ext = (name) => (name.split('.').length > 1 ? name.split('.').pop().toLowerCase() : '');
  const problem = (file) => {
    if (file.name.startsWith('.')) return 'fichier caché refusé';
    if (!data.extensions.includes(ext(file.name))) return 'type de fichier refusé';
    if (!file.size) return 'fichier vide';
    return '';
  };

  function render() {
    list.replaceChildren();
    const total = files.reduce((sum, f) => sum + f.size, 0);
    let blocked = !files.length || done;
    files.forEach((file, index) => {
      const li = document.createElement('li');
      const name = document.createElement('span'); name.className = 'name'; name.textContent = file.name;
      const weight = document.createElement('span'); weight.className = 'size'; weight.textContent = size(file.size);
      li.append(name, weight);
      if (!done) {
        const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Retirer';
        remove.setAttribute('aria-label', 'Retirer ' + file.name);
        remove.addEventListener('click', () => {
          files.splice(index, 1); delete refusedByServer[file.name]; setStatus(''); render();
        });
        li.append(remove);
      }
      const why = refusedByServer[file.name] || problem(file);
      if (why) {
        blocked = true; // renvoyer ce fichier tel quel donnerait le même refus
        li.classList.add('bad');
        const reason = document.createElement('span'); reason.className = 'why'; reason.textContent = why;
        li.append(reason);
      }
      list.append(li);
    });
    if (data.maxBytes && total > data.maxBytes) {
      blocked = true;
      setStatus('Trop lourd : ' + size(total) + ' au total, ' + size(data.maxBytes) + ' au plus par envoi.', 'bad');
    } else if (files.length > data.maxFiles) {
      blocked = true;
      setStatus(data.maxFiles + ' fichiers au plus par envoi.', 'bad');
    }
    send.disabled = blocked;
    send.textContent = files.length > 1 ? 'Envoyer ' + files.length + ' fichiers'
      : files.length ? 'Envoyer 1 fichier' : 'Envoyer';
  }

  function setStatus(text, kind) {
    status.textContent = text;
    status.className = 'status' + (kind ? ' ' + kind : '');
  }

  function add(fileList) {
    if (done) return;
    for (const file of fileList) {
      files = files.filter((f) => f.name !== file.name);
      delete refusedByServer[file.name];
      files.push(file);
    }
    setStatus('');
    render();
  }

  input.addEventListener('change', () => { add(input.files); input.value = ''; });
  ['dragenter', 'dragover'].forEach((type) => drop.addEventListener(type, (e) => {
    e.preventDefault(); drop.classList.add('over');
  }));
  ['dragleave', 'drop'].forEach((type) => drop.addEventListener(type, () => drop.classList.remove('over')));
  drop.addEventListener('drop', (e) => { e.preventDefault(); add(e.dataTransfer.files); });

  send.addEventListener('click', async () => {
    if (new Date() > expires) { setStatus('Ce lien a expiré : demandez-en un nouveau à Claude.', 'bad'); return; }
    const body = new FormData();
    files.forEach((file) => body.append('files', file, file.name));
    send.disabled = true;
    setStatus('Envoi en cours…');
    let response;
    try {
      response = await fetch(location.pathname, { method: 'POST', body, headers: { Accept: 'application/json' } });
    } catch {
      setStatus('Envoi impossible : vérifiez la connexion, puis réessayez.', 'bad');
      send.disabled = false;
      return;
    }
    // Une réponse qui n'est pas celle du serveur (proxy en 413 ou 502, page HTML) : un message, jamais un objet.
    let answer = {};
    if ((response.headers.get('content-type') || '').includes('application/json')) {
      answer = await response.json().catch(() => ({}));
    }
    if (typeof answer.error !== 'string') {
      answer.error = response.status === 413 ? 'Trop lourd : réduisez la taille ou le nombre de fichiers.'
        : response.ok || answer.refused ? ''
        : 'Envoi impossible (erreur ' + response.status + ') : réessayez plus tard.';
    }
    if (answer.ok) {
      done = true;
      render();
      input.disabled = true;
      setStatus(answer.message + ' Vous pouvez revenir dans Claude et dire « c\\'est envoyé ».', 'ok');
      return;
    }
    (Array.isArray(answer.refused) ? answer.refused : []).forEach((r) => { refusedByServer[r.name] = r.reason; });
    render();
    setStatus(answer.error || 'Rien n\\'a été envoyé : retirez les fichiers signalés, puis réessayez.', 'bad');
  });

  render();
})();
`;

const sha256 = (text: string) => `'sha256-${createHash('sha256').update(text).digest('base64')}'`;

/** CSP de la page : rien d'autre que son propre style, son propre script, et l'envoi vers elle-même. */
export const PAGE_CSP = [
  "default-src 'none'", `style-src ${sha256(STYLE)}`, `script-src ${sha256(SCRIPT)}`, "connect-src 'self'",
  "img-src 'self'", "form-action 'none'", "frame-ancestors 'none'", "base-uri 'none'"
].join('; ');

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

// Dans un bloc <script type="application/json"> : "<" échappé, la page ne peut pas en sortir.
const embedJson = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c');

function layout(title: string, body: string, script = '') {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${body}
</main>
${script}
</body>
</html>`;
}

/** La page de dépôt d'un lien valable. */
export function renderUploadPage(data: PageData): string {
  const limits = [
    data.maxBytes ? `${formatSize(data.maxBytes)} au plus par envoi` : '', `${data.maxFiles} fichiers au plus`
  ].filter(Boolean).join(', ');
  return layout('Déposer des fichiers', `
<h1>Déposer des fichiers</h1>
<p class="meta">Dans <strong>${escapeHtml(data.folder || '/')}</strong>
 · au nom de <strong>${escapeHtml(data.user)}</strong>
 · lien valable jusqu'à <strong id="expires"></strong>, une seule fois</p>
<div class="card">
<label class="drop" id="drop">
<input type="file" id="input" multiple>
<strong>Glissez vos fichiers ici, ou cliquez pour les choisir</strong>
<span>${escapeHtml(data.extensions.join(', '))} · ${escapeHtml(limits)}</span>
</label>
<ul id="list" aria-live="polite"></ul>
<button class="send" id="send" type="button" disabled>Envoyer</button>
<p class="status" id="status" role="status"></p>
</div>
<p class="hint">Les fichiers sont publiés tels quels : visibles par toute personne qui a le lien de la page.</p>
<noscript><p class="status bad">Cette page a besoin de JavaScript.</p></noscript>`,
  `<script type="application/json" id="data">${embedJson(data)}</script>\n<script>${SCRIPT}</script>`);
}

/** Lien inconnu, expiré ou déjà utilisé : la même page, sans dire lequel. */
export function renderInvalidLinkPage(): string {
  return layout('Lien non valable', `
<h1>Ce lien n'est plus valable</h1>
<p class="meta">Il a expiré ou a déjà servi. Demandez-en un nouveau à Claude.</p>`);
}
