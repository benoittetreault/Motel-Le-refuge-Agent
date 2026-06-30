# ARCHITECTURE — Motel Le Refuge (agent IA réceptionniste)

> Doc de reprise de contexte pour Claude Code. Concise et technique. Vérifie toujours
> qu'un symbole/fichier cité existe encore avant de t'en servir (le code évolue).
> Dernière mise à jour : 2026-06-29 (après merge PR #11).

## 1. Vue d'ensemble

Agent IA réceptionniste bilingue (FR/EN) pour le Motel Le Refuge (Lennoxville/Sherbrooke,
QC). Le client chatte ; l'agent répond, vérifie la disponibilité, et génère des liens de
réservation Reservit. Monorepo pnpm.

- **Backend** : `artifacts/api-server` — Express, routes sous `/api/anthropic`. Démarre
  `node --enable-source-maps ./dist/index.mjs` (PORT 8080, health `/api/healthz`).
- **Frontend** : `artifacts/motel-refuge` — React + Vite (SPA).
- **Libs** : `lib/db` (Drizzle + Neon Postgres : tables `conversations`, `messages`,
  `bookings`), `lib/api-zod` (schémas), `lib/api-client-react` (client généré),
  `lib/integrations-anthropic-ai` (instance brute du SDK `@anthropic-ai/sdk`, voir
  `src/client.ts`).
- **Modèle** : `claude-sonnet-4-6`, `max_tokens: 8192`.
- Chambres/tarifs/politiques sont dans le **system prompt** (`SYSTEM_PROMPT_BODY`), source
  de vérité : Queen 100/110 (max 2), Double 110/120 (max 4), Deluxe 120/130 (max 2),
  Suite 225 (max 4). Tél `819-564-9005`, 43 rue Queen, Sherbrooke QC J1M 1J2, 15h–21h.

## 2. Backend — flux du handler `POST /conversations/:id/messages`

Fichier : `artifacts/api-server/src/routes/anthropic/index.ts`. **Non-streaming** : une
réponse JSON complète `res.json({ content })`.

1. Valide, insère le message `user` en DB, recharge l'historique → `chatMessages`.
2. `buildSystemPrompt()` = contexte date (injecté, `America/Montreal`, seule source de
   vérité pour « aujourd'hui ») + `SYSTEM_PROMPT_BODY` + `AVAILABILITY_TOOL_INSTRUCTION`.
3. `mightInvolveBooking(userContent)` — filtre par mots-clés (FR/EN). **Optimisation de
   coût uniquement** : décide si l'outil `check_availability` est offert au modèle. Ce
   n'est PAS le filet de sécurité.
4. `generateReply(chatMessages, includeTool)` : un appel `anthropic.messages.create`
   (non-streamé). Boucle d'outil bornée (`MAX_TOOL_ROUNDS = 4`) : si `stop_reason ===
   "tool_use"`, exécute `checkAvailability`, renvoie le `tool_result`, rappelle `create`.
   Si la borne est atteinte encore en `tool_use`, force un dernier appel sans outils.
   Retourne `extractAssistantText(response.content)`.
5. **Vérification serveur des liens** (le vrai filet) — `findAllReservitLinks(candidate)` :
   - **0 lien** → envoyer tel quel.
   - **1 lien** → `parseReservitParams` ; non-parsable → envoyer (non bloquant) ;
     sinon `checkAvailability` :
     - `all_available` ou `check_failed` → envoyer tel quel.
     - `partial` / `none_available` / `too_long` → **rejet** → `regenerateHonestReply`.
   - **2+ liens** (groupe, chambres de **types différents**) → parse chacun, `checkAvailability`
     en parallèle (`Promise.all`). `hardFailures` = tout statut ≠ `all_available` ET ≠
     `check_failed`. Si aucun → envoyer tel quel ; sinon → **rejet** → `regenerateHonestReply`.
6. `regenerateHonestReply(base, candidate, correction)` : régénère une réponse honnête
   **sans lien** (le modèle reçoit le résultat exact dans `correction`), strippe tout lien
   résiduel via `RESERVIT_LINK_RE_G`, fallback bilingue si vide.
7. `stripToolTags(finalText)` : garde-fou minimal (retire un éventuel `<tool_call>` /
   `<tool_response>` halluciné) avant envoi.
8. Persiste le message `assistant` (texte final) puis `res.json({ content })`.

**Principe `check_failed`** : si NOTRE vérif échoue (panne Reservit, params non parsables),
on ne bloque JAMAIS le client — on envoie la réponse telle quelle. On ne refuse que sur un
« non » explicite (`partial`/`none_available`/`too_long`).

## 3. `availability.ts` — `checkAvailability(fromDate, nights, adults)`

Fichier : `artifacts/api-server/src/routes/anthropic/availability.ts`.

- Vérifie **une nuit à la fois, en parallèle** (`Promise.all`).
- Par nuit : `GET https://secure.reservit.com/api/rs/bestprice/58/444801` avec
  `fromdate`, `todate` (= fromdate +1 jour, **calcul UTC**), `roomAge1` (un « 30 » par
  adulte, ex. `30,30`), `lang=EN`, `currency=USD`, `serviceIncluded=false`. Headers
  `Accept: application/json`, `User-Agent: Mozilla/5.0`. Timeout 4000 ms (`AbortController`).
- Lecture : `bestPrice_unFormatted` — nombre `> 0` ⇒ disponible ; `-1` ou absent ⇒ réservé.
- `MAX_NIGHTS = 14` ⇒ `too_long`. **Fail-closed** : si une seule nuit jette/timeout ⇒
  `check_failed` (jamais de devinette partielle).
- Retour (union discriminée) : `all_available {firstPrice}` | `partial
  {availableNights, bookedNights}` | `none_available` | `too_long {requestedNights}` |
  `check_failed`.
- **LIMITE FONDAMENTALE** : signal **binaire** par nuit (« ≥1 chambre existe pour ces
  dates/occupation »), PAS un compte d'inventaire. On ne peut pas distinguer « il en reste
  1 » de « il en reste 10 » → impossible de confirmer 2+ chambres du **même** type.

## 4. Frontend — `artifacts/motel-refuge/src/pages/chat.tsx`

- `handleSend` : `fetch` POST → `await res.json()` → `{ content }` affiché **d'un coup**.
  Plus de SSE (pas de `EventSource`/`getReader`/parsing `data:`).
- `isTyping` passe à `true` au début, `false` dans `finally` (tous chemins).
- `useEffect` de **refocus** : quand `isTyping` repasse à `false`, `inputRef.current?.focus()`
  (l'input est `disabled` pendant l'envoi, ce qui le défocus ; le réactiver ne restaure pas
  le focus). Fonctionne avec le flux non-streamé.

## 5. Décisions clés (et pourquoi)

- **Vérif serveur APRÈS génération, pas avant / pas en faisant confiance au modèle.**
  Bug prod confirmé : Deluxe, 4–5 juillet 2026, 2 adultes — lien émis alors que Reservit
  renvoie `-1`. Causes : le filtre par mots-clés sautait le tour décisif (« ok »/« oui »),
  et le `tool_result` n'était jamais persisté → rien ne reliait l'émission d'un lien à une
  dispo vérifiée. Solution : revérifier mécaniquement **tout lien présent dans le texte
  final**, peu importe comment/pourquoi il a été produit.
- **Pas de streaming pour l'instant.** Le serveur doit voir la réponse COMPLÈTE pour
  vérifier les liens avant de l'envoyer. Fiabilité > fluidité visuelle. À réintroduire plus
  tard.
- **Même-type multi-chambres → téléphone ; types-différents → liens possibles.**
  `checkAvailability` est binaire (cf. §3) : on ne peut pas garantir 2+ chambres du même
  type. Pour des types **différents**, chaque lien est vérifié indépendamment (les params
  diffèrent en pratique, ex. `nbadt` distinct) ⇒ on peut émettre un lien par type, et on
  rejette tout si une seule chambre échoue.
- **Un seul appel modèle + outil disponible** (vs ancien découpage Phase 1/Phase 2). L'ancien
  split servait à éviter une fuite `<tool_call>` quand la Phase 2 streamée n'avait pas
  d'outil ; sans phase streamée sans outil, plus besoin. `stripToolTags` reste en garde-fou.

## 6. Limites connues & questions ouvertes

- **Phase B (compte d'inventaire réel / même-type multi)** : faisabilité non démontrée —
  nécessiterait un endpoint Reservit exposant le nombre de chambres restantes par type
  (le `bestprice` ne le donne pas). À investiguer avant de promettre du même-type multi.
- **Streaming** : à réintroduire une fois la vérif bien testée (il faudra bufferiser/vérifier
  avant de flusher, ou vérifier puis streamer).
- **2 chambres de types différents mais MÊME occupation + mêmes dates** → liens Reservit
  **identiques** (le lien n'encode pas le type) : vérifiés deux fois, deux liens identiques
  affichés. Non dédupliqué. Acceptable (jamais de fausse dispo), mais à améliorer.
- **Risque de décalage de déploiement** : si le backend est redéployé mais qu'un ancien
  bundle frontend (SSE) est servi (cache / build non refait), le chat reste « bloqué ». Vérifier
  que Railway sert bien le build courant ; les watch paths (`railway.json`) ne s'appliquent
  que si le service pointe sur `artifacts/api-server/railway.json` (réglage dashboard à
  confirmer).

## 7. Workflow standard

- L'agent tourne dans un **git worktree** (`main` est checkout ailleurs). Pour livrer :
  brancher `claude/<sujet>` depuis `origin/main` → commit → push → ouvrir une PR
  (le CLI `gh` n'est pas dispo dans l'env agent ; utiliser l'URL `…/pull/new/<branche>`).
- L'utilisateur **review et merge via GitHub**. Le merge sur `main` déclenche le
  **redéploiement auto Railway**.
- **Type-check** : depuis `artifacts/<pkg>`, `pnpm exec tsc -b tsconfig.json --force`
  (le simple `pnpm typecheck` échoue sur les refs workspace non buildées → utiliser `tsc -b`).
- **Railway watch paths** (`artifacts/api-server/railway.json`) : `artifacts/api-server/**`,
  `artifacts/motel-refuge/**`, `lib/**`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`.

## 8. URLs & IDs

- **Repo** : https://github.com/benoittetreault/Motel-Le-refuge-Agent
- **Agent live** : hébergé sur Railway — *URL exacte à confirmer*.
- **Railway** : dashboard du projet (config-as-code via `artifacts/api-server/railway.json`).
- **Reservit best-price (dispo)** : `https://secure.reservit.com/api/rs/bestprice/58/444801`
  — **chain ID 58**, **hotel ID 444801**.
- **Lien de réservation (base)** :
  `http://softbooker.reservit.com/reservit/reserhotel.php?lang=EN|FR&hotelid=444801&fday=DD&fmonth=MM&fyear=YYYY&nbnights=NN&nbadt=ZZ`
- **Site / contact** : https://www.motellerefuge.com — 819-564-9005 — 43 rue Queen,
  Sherbrooke, QC J1M 1J2 — heures 15h00–21h00.
- **DB** : Neon Postgres (credentials via variables d'environnement / `.env`).
- **Modèle** : `claude-sonnet-4-6` (`max_tokens` 8192).
