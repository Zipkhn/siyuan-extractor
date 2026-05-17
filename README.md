# siyuan-extractor

Service Node/TypeScript qui reçoit les webhooks `siyuan-plugin-publish`, lit les documents publiés via l'API Siyuan (endpoints bornés), et produit des snapshots JSON canoniques + HTML sanitisé.

V1 — pour usage personnel. Spec : `docs/v1/architecture.md` sur la branche `custom/main` du fork Siyuan.

## Responsabilités

- Recevoir `POST /webhook` (corps `{event, project, docId, version, publishedAt}`, en-tête `X-Publish-Secret`).
- Pour `event=publish` : lire le doc via une **liste bornée** d'endpoints Siyuan, valider que le doc est bien marqué `custom-published=true` côté Siyuan (defense in depth), parser le contenu, télécharger les assets référencés, écrire un snapshot atomique.
- Pour `event=unpublish` : supprimer le snapshot + l'entrée d'index correspondants.
- Maintenir un `<project>/index.json` listant les docs publiés.

## Ce qui est figé (V1)

1. **Format de snapshot canonique JSON** : schéma `siyuan-snapshot/v1`, content-hashable (sha256 de `content.blocks` canonicalisés).
2. **Sortie HTML sanitisée** : artefact sibling `<doc_id>.html`, généré depuis le HTML Siyuan via `sanitize-html` avec allowlist stricte + ré-écriture des URLs d'assets.
3. **Hash document/assets** : assets stockés en `<base>.<sha256_12>.<ext>`, idempotents. Snapshot non réécrit si `content_hash` + `version` inchangés.
4. **Config centralisée** : `src/config.ts` valide les env vars au boot, échoue fort si manquantes.
5. **Aucune exposition SQL** : aucun appel à `/api/query/sql`. Liste des endpoints Siyuan utilisés : `/api/attr/getBlockAttrs`, `/api/block/getDocInfo`, `/api/filetree/getDoc`, `/api/file/getFile` (assets uniquement).

## Couverture des blocs (V1.1)

| Type Siyuan | JSON typé | HTML sanitisé | Fallback / limite |
|---|---|---|---|
| `NodeHeading` | ✅ `{ level, text, marks: [] }` | `<h1>`–`<h6>` | marks inline non extraits |
| `NodeParagraph` | ✅ `{ text, marks: [] }` | `<p>` ou wrapper Siyuan | marks inline non extraits |
| `NodeList` / `NodeListItem` | ✅ récursif | `<ul>` / `<ol>` / `<li>` | — |
| `NodeCodeBlock` | ✅ `{ language, text }` | `<pre><code class="language-…">` | — |
| `NodeBlockquote` | ✅ récursif | `<blockquote>` | — |
| `NodeThematicBreak` | ✅ | `<hr>` | — |
| `NodeImage` | ✅ `{ asset_path, alt, caption }` (uniquement quand un paragraphe ne contient qu'**une seule** image et aucun autre texte significatif) | `<img>` (asset URL réécrite vers `stored_path`) | paragraphe mixte texte+image ou multi-images : reste un `NodeParagraph` typé, l'image survit uniquement dans le HTML |
| `NodeTable` | ✅ `{ header_row, rows: [[{text, marks: []}]] }` | `<table>` + `<thead>` + `<tbody>` | marks inline par cellule non extraits |
| `NodeMathBlock` | ✅ `{ text }` (LaTeX brut, depuis `data-content`) | `<pre class="math-block" data-latex="…">$$ … $$</pre>` | rendu mathématique laissé au reader (KaTeX/MathJax côté client) |
| `NodeSuperBlock` | ✅ `{ layout: "row" \| "col", children }` | `<div data-type="NodeSuperBlock" data-sb-layout="…">` | layout inconnu → fallback `"row"` |
| `NodeAttributeView` (database) | ✅ `{ view_type, av_name, view_name, columns: [{id, name, type}], rows: [{id, cells: string[]}] }` | `<table class="av-block">` synthétisé (toujours, même pour les vues gallery/kanban) | données pré-fetchées via `/api/av/renderAttributeView`. Si l'appel échoue, bloc loggé + skippé. Types de colonnes inconnus → `type: "unknown"` + valeur best-effort `JSON.stringify(value)` |

Types de colonnes AV reconnus dans `columns[].type` : `block, text, number, date, select, mSelect, url, email, phone, mAsset, template, created, updated, checkbox, relation, rollup, lineNumber`. Tout autre type est passé en `"unknown"` mais la valeur affichée est conservée.

## Limites V1.1 connues

- Marks inline (gras, italique, code, lien, strike) : non extraits en JSON (`marks: []` partout). Présents dans le HTML sanitisé.
- `outbound_refs` : `[]`. Implémentation ultérieure.
- Une image au milieu d'un paragraphe (texte + image mélangés) ou plusieurs images dans un même paragraphe ne sont pas typées en JSON — elles restent dans le HTML.
- Un `NodeAttributeView` dans un doc sans accès au kernel pendant le sync (kernel injoignable, AV supprimée entre-temps) est skippé du JSON. Le placeholder vide reste dans le HTML.

## Tests

```bash
npm run test         # vitest run (suite complète sur fixtures réelles)
npm run test:watch   # mode watch
```

Les fixtures dans `src/__fixtures__/` ont été extraites depuis le stack dev (Siyuan tournant via `deploy/dev/`) et représentent du HTML kernel réel, pas des structures inventées. Les ajouter ou les regénérer : voir `src/__tests__/harness.ts` (`parseAndRender(html, assets?, avBlocks?)`).

## Configuration

Toutes les env vars passent par `src/config.ts`. Voir `.env.example`.

| Env | Required | Default | Description |
|---|---|---|---|
| `SIYUAN_URL` | oui | — | URL kernel (en compose dev : `http://siyuan:6806`) |
| `SIYUAN_TOKEN` | oui | — | Token API (Settings → About → API token) |
| `WEBHOOK_SECRET` | recommandé | vide | Compare avec en-tête `X-Publish-Secret`. Si vide, tous les webhooks sont acceptés (dev only). |
| `HOST` | non | `0.0.0.0` | |
| `PORT` | non | `3000` | |
| `SNAPSHOTS_DIR` | oui | — | Racine du volume snapshots |
| `EMIT_HTML` | non | `true` | Génère le sibling HTML à côté du JSON |
| `LOG_LEVEL` | non | `info` | `trace` / `debug` / `info` / `warn` / `error` / `fatal` |

## Développement

```bash
cp .env.example .env
# édite .env (SIYUAN_TOKEN au minimum)

npm install
npm run dev       # tsx watch src/server.ts
```

## Build & prod

```bash
npm run build     # tsc → dist/
npm start         # tsx src/server.ts (alt. node dist/server.js après build)
```

Image Docker :
```bash
docker build -t siyuan-extractor:latest .
```

## Endpoints

### `GET /health`
Réponse : `{"status":"ok"}`.

### `POST /webhook`
En-tête : `X-Publish-Secret: <secret>` (si configuré).
Corps :
```json
{
  "event": "publish" | "unpublish",
  "project": "[a-z0-9-]+",
  "docId": "20240101120000-abc1234",
  "version": 1,
  "publishedAt": "2026-05-11T12:34:56.000Z"
}
```
Réponses :
- `200 {"ok":true, ...}` — traitement OK.
- `400` — schéma invalide.
- `401` — secret manquant ou incorrect.
- `500` — erreur extracteur (Siyuan injoignable, doc non publié côté Siyuan, etc.).

## Stockage produit

```
$SNAPSHOTS_DIR/
└── <project>/
    ├── index.json
    ├── docs/
    │   ├── <docId>.json
    │   └── <docId>.html        (si EMIT_HTML=true)
    └── assets/
        └── <base>.<sha256-12>.<ext>
```

Écriture atomique : chaque fichier écrit dans un `*.tmp` sibling puis renommé.

## Smoke tests

Suite courte pour valider la phase 2 ou tester après modification. Pré-requis : extracteur lancé via le compose dev, un doc déjà publié dans le projet `test` (snapshot existant). Adapte `DOCID`, `VERSION`, `PUBAT` aux valeurs réelles.

```bash
cd /Users/fares/Desktop/Siyuan/deploy/dev
SECRET=$(grep '^EXTRACTOR_WEBHOOK_SECRET=' .env | cut -d= -f2)
DOCID=20260512132840-nzy1rmj             # un doc dont le snapshot existe
VERSION=5                                 # la version actuelle du snapshot
PUBAT=2026-05-12T11:51:00.550Z            # le publishedAt actuel du snapshot
```

### 1. Health

```bash
curl -s http://localhost:3001/health
# attendu: {"status":"ok"}
```

### 2. Idempotence content_hash

Renvoyer un webhook `publish` avec la **même version** qu'un snapshot existant ne doit pas réécrire le fichier — le log doit dire `snapshot unchanged; skipping write`.

```bash
docker compose exec extractor stat -c '%y' /data/snapshots/test/docs/$DOCID.json

curl -s -X POST http://localhost:3001/webhook \
  -H "Content-Type: application/json" \
  -H "X-Publish-Secret: $SECRET" \
  -d "{\"event\":\"publish\",\"project\":\"test\",\"docId\":\"$DOCID\",\"version\":$VERSION,\"publishedAt\":\"$PUBAT\"}"
# attendu: {"ok":true,"snapshotChanged":false,"jsonPath":"test/docs/<docid>.json","htmlPath":"test/docs/<docid>.html"}

docker compose logs --tail 5 extractor
# attendu: ligne contenant "snapshot unchanged; skipping write"

docker compose exec extractor stat -c '%y' /data/snapshots/test/docs/$DOCID.json
# attendu: même timestamp qu'avant
```

### 3. Unpublish

```bash
curl -s -X POST http://localhost:3001/webhook \
  -H "Content-Type: application/json" \
  -H "X-Publish-Secret: $SECRET" \
  -d "{\"event\":\"unpublish\",\"project\":\"test\",\"docId\":\"$DOCID\",\"version\":$VERSION,\"publishedAt\":\"$PUBAT\"}"
# attendu: {"ok":true,"removed":true}

docker compose exec extractor ls /data/snapshots/test/docs/ | grep $DOCID || echo "OK: doc files removed"
# attendu: "OK: doc files removed"

docker compose exec extractor cat /data/snapshots/test/index.json | python3 -c 'import sys,json; idx=json.load(sys.stdin); ids=[d["id"] for d in idx["docs"]]; print("docs in index:", ids)'
# attendu: $DOCID ne doit pas être dans la liste
```

Pour restaurer le snapshot après ce test : republier le doc depuis Siyuan (clic-droit → Plugin → Publier).

### 4. Sécurité du webhook

Webhook sans secret → 401.

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3001/webhook \
  -H "Content-Type: application/json" \
  -d "{\"event\":\"publish\",\"project\":\"test\",\"docId\":\"$DOCID\",\"version\":$VERSION,\"publishedAt\":\"$PUBAT\"}"
# attendu: 401
```

Schéma invalide → 400.

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3001/webhook \
  -H "Content-Type: application/json" \
  -H "X-Publish-Secret: $SECRET" \
  -d '{"event":"publish"}'
# attendu: 400
```

## Sécurité

- Le `SIYUAN_TOKEN` ne quitte JAMAIS le serveur. Pas exposé au reader, pas dans les snapshots.
- Le webhook secret doit être configuré en prod. Comparaison en `timingSafeEqual`.
- Pas de SQL générique exposé.
- `sanitize-html` avec allowlist stricte sur les tags/attributs. Scripts, iframes, event handlers : tous strippés.
- Bind mount du workspace Siyuan en `:ro` côté reader recommandé (l'extracteur n'écrit que dans `SNAPSHOTS_DIR`).
