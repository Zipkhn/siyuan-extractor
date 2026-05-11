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

## Limites V1.0 (à étendre en V1.1)

- Blocs supportés : `NodeHeading`, `NodeParagraph`, `NodeList`, `NodeListItem`, `NodeCodeBlock`, `NodeBlockquote`, `NodeThematicBreak`. Logged + skippés : `NodeTable`, `NodeMathBlock`, `NodeAttributeView`, `NodeSuperBlock`, `NodeImage` (image inline traitée via le HTML sanitisé mais pas extraite en JSON typé).
- Marks inline (gras, italique, code, lien, strike) : non extraits en JSON V1.0 (`marks: []`). Présents dans le HTML sanitisé.
- `outbound_refs` : `[]` en V1.0. Implémentation en V1.1.

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

## Sécurité

- Le `SIYUAN_TOKEN` ne quitte JAMAIS le serveur. Pas exposé au reader, pas dans les snapshots.
- Le webhook secret doit être configuré en prod. Comparaison en `timingSafeEqual`.
- Pas de SQL générique exposé.
- `sanitize-html` avec allowlist stricte sur les tags/attributs. Scripts, iframes, event handlers : tous strippés.
- Bind mount du workspace Siyuan en `:ro` côté reader recommandé (l'extracteur n'écrit que dans `SNAPSHOTS_DIR`).
