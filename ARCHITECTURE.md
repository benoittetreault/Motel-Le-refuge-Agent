# ARCHITECTURE — Motel Le Refuge (agent IA réceptionniste)

> Doc de reprise de contexte pour Claude Code. Concise et technique. Vérifie toujours
> qu'un symbole/fichier cité existe encore avant de t'en servir (le code évolue).
> Dernière mise à jour : 2026-07-09 (après canal vocal Vapi — PR #17→#18→#22/#23 mergées).

## 1. Vue d'ensemble

Agent IA réceptionniste bilingue (FR/EN) pour le Motel Le Refuge (Lennoxville/Sherbrooke,
QC). Le client chatte (web) OU appelle (voix via Vapi) ; l'agent répond, vérifie la
disponibilité, et — sur le web — génère des liens de réservation Reservit. Monorepo pnpm.

- **Backend** : `artifacts/api-server` — Express, routes sous `/api`. Démarre
  `node --enable-source-maps ./dist/index.mjs` (PORT 8080, health `/api/healthz`).
  Canaux : `/api/anthropic/*` (chat web), `/api/voice/*` (voix Vapi), `/api/bookings`.
- **Frontend** : `artifacts/motel-refuge` — React + Vite (SPA).
- **Libs** : `lib/db` (Drizzle + Neon Postgres : `conversations`, `messages`, `bookings`),
  `lib/api-zod` (schémas), `lib/api-client-react` (client généré),
  `lib/integrations-anthropic-ai` (instance brute du SDK ; **throw à l'import si
  `ANTHROPIC_API_KEY` absent** — d'où les helpers purs testables séparés, cf. §6),
  `lib/motel-config` (**source de vérité des données motel**, cf. §5).
- **Modèle** : `claude-sonnet-4-6`, `max_tokens: 8192`.
- **Données motel** (chambres/tarifs/politiques/IDs/attractions) : externalisées dans
  `lib/motel-config` (plus dans une constante en dur). Queen 100/110 (max 2), Double
  110/120 (max 4), Deluxe 120/130 (max 2), Suite 225 (max 4). Tél `819-564-9005`, 43 rue
  Queen, Sherbrooke QC J1M 1J2, 15h–21h.

## 2. Backend — flux du handler web `POST /api/anthropic/conversations/:id/messages`

Fichier : `artifacts/api-server/src/routes/anthropic/index.ts`. **Non-streaming** : une
réponse JSON complète `res.json({ content })`.

1. Valide, insère le message `user` en DB, recharge l'historique → `chatMessages`.
2. `generateReply(chatMessages)` (importé de `chat-brain.ts`, cf. §5) : un appel
   `anthropic.messages.create` (non-streamé) + boucle d'outil bornée (`MAX_TOOL_ROUNDS = 4`)
   avec `check_availability` **toujours** offert. Retourne le texte final.
3. **Vérification serveur des liens** (le vrai filet) — `findAllReservitLinks(candidate)` :
   - **0 lien** → envoyer tel quel.
   - **1 lien** → `parseReservitParams` ; non-parsable → envoyer (non bloquant) ;
     sinon `checkAvailability` : `all_available`/`check_failed` → envoyer ; `partial`/
     `none_available`/`too_long` → **rejet** → `regenerateHonestReply`.
   - **2+ liens** (groupe, **types différents**) → parse + `checkAvailability` en parallèle.
     `hardFailures` = tout statut ≠ `all_available` ET ≠ `check_failed`. Aucun → envoyer ;
     sinon → **rejet** → `regenerateHonestReply`.
4. `regenerateHonestReply` : régénère **sans lien** (résultat exact passé dans `correction`,
   outil retiré via `allowTool=false`), strippe tout lien résiduel, fallback bilingue si vide.
5. `stripToolTags(finalText)` : garde-fou (retire un `<tool_call>`/`<function_calls>`
   halluciné) avant envoi.
6. Persiste le message `assistant` puis `res.json({ content })`.

**Principe `check_failed`** : si NOTRE vérif échoue (panne Reservit, params non parsables),
on ne bloque JAMAIS le client — on envoie tel quel. On ne refuse que sur un « non » explicite.

## 3. `availability.ts` — `checkAvailability(fromDate, nights, adults)`

Fichier : `artifacts/api-server/src/routes/anthropic/availability.ts`. **Config-driven** :
`chainId`/`hotelId`/`bestPriceBase`/`currency`/`maxNights` viennent de `getMotelConfig()`.

- Vérifie **une nuit à la fois, en parallèle** (`Promise.all`).
- Par nuit : `GET {bestPriceBase}/{chainId}/{hotelId}` (aujourd'hui
  `https://secure.reservit.com/api/rs/bestprice/58/444801`) avec `fromdate`, `todate`
  (= +1 jour, **calcul UTC**), `roomAge1` (un « 30 » par adulte), `lang=EN`,
  `currency=USD` (⚠️ valeur héritée, probablement devrait être CAD — bug latent connu),
  `serviceIncluded=false`. Timeout 4000 ms (`AbortController`).
- Lecture : `bestPrice_unFormatted` — nombre `> 0` ⇒ dispo ; `-1`/absent ⇒ réservé.
- `MAX_NIGHTS = 14` ⇒ `too_long`. **Fail-closed** : une nuit qui jette/timeout ⇒
  `check_failed` (jamais de devinette partielle).
- **LIMITE FONDAMENTALE** : signal **binaire** par nuit (« ≥1 chambre existe »), PAS un
  compte d'inventaire → impossible de confirmer 2+ chambres du **même** type.

## 4. Frontend — `artifacts/motel-refuge/src/pages/chat.tsx`

- `handleSend` : `fetch` POST → `await res.json()` → `{ content }` affiché **d'un coup**
  (pas de SSE côté web — choix délibéré, cf. §7).
- `isTyping` : `true` au début, `false` dans `finally`. `useEffect` de **refocus** quand
  `isTyping` repasse à `false`.

## 5. Données motel & cerveau partagé (fondation multi-motels)

- **`lib/motel-config`** (`@workspace/motel-config`) : `MotelConfig` (types.ts),
  `motelLeRefuge` (motels/le-refuge.ts), `getMotelConfig(dialedNumber?)` (index.ts). Le
  paramètre `dialedNumber` est **déjà accepté** mais ignoré (retourne l'unique motel) —
  résolution par numéro appelé à implémenter quand plusieurs motels existeront.
- **`system-prompt.ts`** : `buildSystemPromptBody(config)` reconstruit le prompt à partir
  de la config (Couche 1 = données injectées ; Couche 2 = règles de comportement/sécurité,
  en dur et partagées ; Couche 3 = `personalization.toneNotes`, borné 500 car.).
  `buildSystemPrompt(config, now?)` ajoute l'en-tête date. **Golden snapshot** :
  `system-prompt.golden.ts` + `system-prompt.test.ts` verrouillent le prompt octet pour
  octet → tout changement volontaire doit mettre à jour le golden (cf. mémoire projet).
- **`chat-brain.ts`** : le **cerveau partagé** entre web ET voix. Exporte `generateReply`,
  `ChatMessageList`, et re-exporte `findAllReservitLinks`/`RESERVIT_LINK_RE_G` depuis
  `reservit-link.ts`. La vérif serveur des liens (spécifique au web) reste dans
  `anthropic/index.ts`.
- **`reservit-link.ts`** : regex Reservit **pure** (aucune dépendance) → importable par les
  helpers voix et leurs tests sans charger le client Anthropic.

## 6. Canal vocal Vapi.ai — Phase 2, Bloc A (FONCTIONNEL)

Vapi gère la **téléphonie** (ASR voix→texte, TTS texte→voix). Notre api-server reste le
**seul cerveau** via un endpoint « Custom LLM » que Vapi appelle à chaque tour.

- **Route** : `POST /api/voice/chat` + **alias** `POST /api/voice/chat/completions` (Vapi
  peut utiliser le chemin exact OU y ajouter `/chat/completions` façon OpenAI). Même
  handler `handleVoiceChat`. Fichier `routes/voice/index.ts`.
- **Helpers purs** : `routes/voice/concierge.ts` (testables sans serveur ni clé API — cf.
  `voice.test.ts`) :
  - `secretMatches` : comparaison **à temps constant** (SHA-256 + `timingSafeEqual`).
  - `extractProvidedSecret` : header custom (défaut `x-vapi-secret`, insensible à la casse)
    puis fallback `Authorization: Bearer`.
  - `mapVapiMessages` : mappe l'historique OpenAI de Vapi → `ChatMessageList`, garde
    **seulement user/assistant** (jette `system` — notre prompt fait foi — et `tool`, et le
    contenu vide/non-string).
  - `toSpokenReply` : **filet concierge** — un lien de réservation ne doit JAMAIS être parlé
    → toute réponse contenant un lien est remplacée par une invitation bilingue à appeler
    (`phone` + heures) ; liens résiduels + tags d'outil strippés dans tous les cas.
  - `buildSseChunks` / `formatSsePayload` : formatage SSE (cf. §6.1).
- **Flux du handler** : (debug opt-in) log headers+body bruts si `VOICE_DEBUG_LOG=true` →
  **auth** (401 si secret invalide ; si `VAPI_SECRET` absent → warning + passage, dev only)
  → extrait/log `call.phoneNumber.number` (appelé), `call.customer.number` (appelant),
  `call.id` → `getMotelConfig(dialedNumber)` → `mapVapiMessages` (400 si vide) →
  `generateReply` (**même cerveau que le web**) → `toSpokenReply` → réponse **SSE**.
- **Pas de persistance DB** en voix : Vapi renvoie l'historique **complet** à chaque tour.
- **Jamais de `tool_calls` renvoyés à Vapi** : `check_availability` reste interne à
  `generateReply` (invisible pour Vapi).

### 6.1 CORRECTION CRITIQUE — Vapi EXIGE du SSE (pas du JSON simple)

Découvert par un vrai appel en prod : Vapi envoie **toujours** `stream:true` et ne fait
lire une réponse que si elle arrive en **SSE OpenAI** (`chat.completion.chunk`). Un corps
**JSON simple laisse l'assistant SILENCIEUX, sans erreur** — notre serveur renvoyait pourtant
une réponse valide (confirmé par les logs). La conclusion initiale « Vapi accepte le
non-streaming JSON » (tirée de la doc de haut niveau) était **FAUSSE** ; se fier au CODE des
dépôts d'exemple Vapi. Format exact (chemin succès uniquement ; 401/400/500 restent en JSON) :

- **Headers** : `Content-Type: text/event-stream`, `Cache-Control: no-cache`,
  `Connection: keep-alive`.
- **3 chunks** `chat.completion.chunk` (même `id`/`created`/`model`), écrits
  `data: <json>\n\n` :
  1. `choices[0].delta = { role: "assistant", content: "" }`, `finish_reason: null`
  2. `choices[0].delta = { content: "<texte complet>" }`, `finish_reason: null` (un SEUL
     chunk — pas de découpage mot par mot dans cette V1)
  3. `choices[0].delta = {}`, `finish_reason: "stop"`
- **Terminateur** : `data: [DONE]\n\n`, puis `res.end()`.

### 6.2 Décision d'archi — « faux streaming », pas de vrai streaming modèle

`generateReply()` reste **non-streamé** et le filet concierge vérifie le **texte COMPLET**
avant tout envoi ; on ne fait qu'**emballer** ce résultat final déjà sûr en SSE. **Compromis
assumé** : aucun octet n'est écrit avant d'avoir le texte vérifié en main → **zéro risque de
fuite d'un lien en milieu de phrase**, au prix de **ne PAS réduire la latence perçue** (le
client attend la réponse complète, sans audio partiel). Atténuer la latence côté Vapi (sons
d'attente), pas en réintroduisant le vrai streaming.

### 6.3 Authentification

Secret partagé envoyé par Vapi dans un header. `VAPI_SECRET` (valeur attendue) +
`VAPI_SECRET_HEADER` (nom du header, défaut `X-Vapi-Secret`). Comparaison à temps constant.
Le header par défaut correspond à la config Vapi actuelle.

### 6.4 Leçons de configuration Vapi (dashboard) — NE PAS refaire ces erreurs

- **L'interface web Vapi perd silencieusement `model.headers`** (le header d'auth) même
  après « Publish ». **Solution fiable** : configurer via **PATCH direct** sur l'API REST —
  `PATCH https://api.vapi.ai/assistant/{id}` avec `Authorization: Bearer <clé privée Vapi>`
  et le body `{ model: { provider, model, url, headers: { "X-Vapi-Secret": "…" }, messages }}`.
  **Ne jamais** compter sur l'UI web pour `model.headers`. **Preuve de succès** = un GET
  montre `model.headers` contenant la clé (PAS `isServerUrlSecretSet`, qui concerne autre chose).
- **Numéros gratuits Vapi ≠ indicatifs canadiens** : impossible d'obtenir un vrai numéro
  819 via les numéros gratuits Vapi → nécessitera « Import Twilio » plus tard.

## 7. Décisions clés (et pourquoi)

- **Vérif serveur APRÈS génération, sur le texte complet.** Bug prod (Deluxe, 4–5 juillet
  2026 : lien émis alors que Reservit renvoyait `-1`). On revérifie mécaniquement **tout
  lien du texte final**, peu importe comment il a été produit.
- **Streaming — deux régimes distincts :**
  - **Chat WEB : non-streaming JSON, délibéré.** Le serveur doit voir la réponse COMPLÈTE
    pour vérifier les liens avant envoi. Fiabilité > fluidité. (Corrige l'ancienne note
    « streaming à réintroduire » : pour le web c'est un choix de conception, pas un manque.)
  - **VOIX : SSE OBLIGATOIRE**, contrainte externe de Vapi (§6.1), PAS notre choix. Mais la
    **génération** n'est jamais streamée dans les deux cas — on emballe du texte déjà complet.
- **Même-type multi-chambres → téléphone ; types-différents → liens possibles** (web).
  `checkAvailability` est binaire (§3).
- **Un seul appel modèle + outil toujours offert** ; `stripToolTags` en garde-fou.
- **Helpers purs séparés du client Anthropic** : `lib/integrations-anthropic-ai` throw à
  l'import sans `ANTHROPIC_API_KEY` → toute logique testable (concierge, SSE, reservit-link)
  vit dans des modules purs importables sans clé (usage `import type` pour les types du cerveau).

## 8. Plans en cours (non implémentés)

- **Bloc B — prompt vocal dédié.** Le Bloc A réutilise le prompt WEB tel quel (avec des
  `TODO(Bloc B)`), d'où le filet `toSpokenReply` qui rattrape les liens *a posteriori*. Le
  Bloc B doit : ne **jamais** produire de lien à la source, imposer des **phrases courtes**
  (adaptées au TTS), et gérer le « First Message » de Vapi (message d'accueil).
- **Bloc C — envoi du lien par SMS (via Twilio), planifié.** Après vérification de dispo
  serveur, envoyer le lien Reservit par SMS plutôt que de le parler — en **réutilisant le
  même point de détection** que le filet concierge actuel. **Capture du numéro** :
  `call.customer.number` en priorité ; sinon saisie **clavier DTMF** via le `keypadInputPlan`
  de Vapi. **JAMAIS de saisie vocale d'un numéro** (risque de transcription erronée).

## 9. Limites connues & questions ouvertes

- **Compte d'inventaire réel / même-type multi** : `bestprice` ne donne pas le nombre de
  chambres restantes → non démontré. À investiguer avant de promettre du même-type multi.
- **`currency=USD`** dans l'appel BestPrice (§3) : probablement devrait être CAD — bug
  latent, mis en config sans changer la valeur.
- **2 types différents, MÊME occupation + dates** → liens Reservit **identiques** (le lien
  n'encode pas le type) : deux liens identiques affichés, non dédupliqué. Acceptable.
- **Latence voix** : non-streaming + `check_availability` (4 s/nuit) → silence possible ;
  atténuer côté Vapi.
- **Décalage de déploiement** : vérifier que Railway sert bien le build courant (watch paths
  dans `artifacts/api-server/railway.json`).

## 10. Workflow standard

- L'agent tourne dans un **git worktree** (`main` est checkout ailleurs). Livrer : brancher
  `claude/<sujet>` → commit → push → PR. Le CLI `gh` n'est **pas** dispo dans l'env agent ;
  ouvrir la PR via l'API REST GitHub (token du credential manager) ou l'URL
  `…/pull/new/<branche>`.
- **Branches EMPILÉES (stacked)** : quand une chaîne de branches dépend l'une de l'autre
  (ex. motel-config → voix → SSE), une PR normale cible la branche parente (diff propre mais
  ne peut pas merger sur `main` seule). **Pattern qui marche à tout coup** : ouvrir/merger via
  l'URL de comparaison directe **`github.com/<repo>/compare/main...<branche>`** pour voir et
  merger le diff complet **contre `main`**.
- L'utilisateur **review et merge via GitHub**. Le merge sur `main` déclenche le
  **redéploiement auto Railway**.
- **Type-check** : `npx tsc -b` à la racine (ou `pnpm exec tsc -b` dans un pkg) — le simple
  `pnpm typecheck` échoue sur les refs workspace non buildées.
- **Tests** : `pnpm --filter @workspace/api-server test` (node:test via `tsx`).
- **Railway watch paths** : `artifacts/api-server/**`, `artifacts/motel-refuge/**`, `lib/**`,
  `pnpm-workspace.yaml`, `pnpm-lock.yaml`.

## 11. URLs & IDs

- **Repo** : https://github.com/benoittetreault/Motel-Le-refuge-Agent
- **Agent live** : Railway — `https://workspaceapi-server-production-ea0b.up.railway.app`
  (voix : `…/api/voice/chat/completions`).
- **Vapi** : assistant `1ad0b8ad-0513-4e43-b194-6fcacd9448ac` ; config via
  `PATCH https://api.vapi.ai/assistant/{id}` (Bearer clé privée) — cf. §6.4.
- **Reservit best-price** : `https://secure.reservit.com/api/rs/bestprice/58/444801`
  — **chain ID 58**, **hotel ID 444801**.
- **Lien de réservation (base)** :
  `http://softbooker.reservit.com/reservit/reserhotel.php?lang=EN|FR&hotelid=444801&fday=DD&fmonth=MM&fyear=YYYY&nbnights=NN&nbadt=ZZ`
- **Site / contact** : https://www.motellerefuge.com — 819-564-9005 — 43 rue Queen,
  Sherbrooke, QC J1M 1J2 — heures 15h00–21h00.
- **DB** : Neon Postgres (via variables d'environnement).
- **Modèle** : `claude-sonnet-4-6` (`max_tokens` 8192).
- **Env vars voix** : `VAPI_SECRET`, `VAPI_SECRET_HEADER` (défaut `X-Vapi-Secret`),
  `VOICE_DEBUG_LOG`.
