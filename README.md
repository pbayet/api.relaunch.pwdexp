# api.relaunch.pwdexp

API autonome qui relance par mail les utilisateurs Active Directory dont le
mot de passe arrive à expiration (ou a expiré).

C'est une copie du module `passwords` de l'API interne V1.1.0, rendue
indépendante : elle n'a besoin **que de l'AD (LDAP) et d'un relais SMTP**,
sans base SQL ni authentification interne.

## Installation

```bash
npm install
cp .env.example .env   # puis renseigner les valeurs
npm start              # ou : npm run pm2
```

Node.js 20 ou plus.

## Docker

```bash
cp .env.example .env          # puis renseigner les valeurs
docker compose up -d --build
docker compose logs -f        # suivre les journaux
```

Vérification : `http://<hôte>:<PORT>/health` doit répondre `{"status":"ok"}`
(le conteneur passe aussi à l'état `healthy` dans `docker ps`).

Points à connaître :

- **Configuration** : le `.env` est lu au lancement (`env_file`), il n'est
  jamais copié dans l'image. Après une modification du `.env` :
  `docker compose up -d` (recrée le conteneur).
- **NODE_ENV** : c'est la valeur du `.env` qui s'applique. `development` =
  mails redirigés vers `BASE_RECIPIENT_EMAIL` et pas de relance
  automatique ; `production` = vrais destinataires + relance quotidienne.
- **Fuseau horaire** : le conteneur est en `Europe/Paris` (cf.
  `docker-compose.yml`), la relance part donc bien à `PWD_REMINDER_HOUR`
  heure française.
- **Certificat LDAP** : déposer le certificat de l'AC dans `./certs/` et
  ajouter dans le `.env` `DOCKER_LDAP_CA_CERT_PATH="/app/certs/ca.pem"`
  (`LDAP_CA_CERT_PATH` n'est pas utilisé dans le conteneur).
- **Relais SMTP** : un relais qui filtre par IP (ex. IIS « Unable to
  relay ») voit l'IP de la **machine hôte** Docker : c'est elle qu'il faut
  autoriser sur le relais.
- **DNS** : si `LDAP_URL` / `HOST` (noms internes) ne se résolvent pas dans
  le conteneur, décommenter `dns:` dans `docker-compose.yml`.
- **Journaux** : volume Docker `logs` (rotation 14 jours), conservé entre
  deux redémarrages.
- **Une seule instance** (pas de `--scale`) : anti-doublon et planification
  sont en mémoire.

## Routes

Toutes les routes `/api/*` exigent l'en-tête `x-api-key: <API_KEY>`.

| Méthode | Route                 | Body                                | Rôle |
|---------|-----------------------|-------------------------------------|------|
| POST    | `/api/reminders`      | `{ "days"?: 15, "dryRun"?: false }` | Relance **tous** les comptes expirés, à changer, ou expirant sous `days` jours (défaut `PWD_REMINDER_DEFAULT_DAYS`). `dryRun: true` renvoie la liste sans rien envoyer. |
| POST    | `/api/reminders/user` | `{ "email": "x@example.com" }` | Relance **un** utilisateur, retrouvé dans l'AD par son email. |
| GET     | `/health`             | —                                   | Sonde de vie (sans clé). |

Exemples :

```bash
curl -X POST http://localhost:3001/api/reminders -H "x-api-key: $API_KEY" -H "content-type: application/json" -d '{"dryRun":true}'
```

```bash
curl -X POST http://localhost:3001/api/reminders/user -H "x-api-key: $API_KEY" -H "content-type: application/json" -d '{"email":"jean.dupont@example.com"}'
```

Réponse de la relance générale : `{ dryRun, days, total, sent, skipped, failed, results: [...] }`
(un échec SMTP sur un compte n'interrompt pas les autres envois).

Erreurs : `{ error: "CODE", message }` — 401 clé invalide, 400 body invalide,
404 compte AD introuvable, 422 mot de passe qui n'expire jamais, 429 relance
déjà envoyée il y a moins de `PWD_REMINDER_COOLDOWN_MIN` minutes.

## Relance automatique quotidienne

Quand `NODE_ENV=production` (et `PWD_REMINDER_SCHEDULE_ENABLED` ≠ `false`),
l'API relance chaque **jour ouvré** à `PWD_REMINDER_HOUR:PWD_REMINDER_MINUTE`
(défaut 8h00) :

- les comptes qui arrivent exactement sur un palier `PWD_REMINDER_TIERS`
  (défaut J-15, J-7, J-1) — le lundi, les paliers franchis pendant le
  week-end sont rattrapés ;
- les comptes expirés depuis au plus `PWD_REMINDER_EXPIRED_MAX_DAYS` jours,
  chaque jour ;
- les comptes « changement exigé à la prochaine connexion », le lundi.

Une seule instance doit tourner (cf. `ecosystem.config.cjs`) : l'anti-doublon
et la planification sont en mémoire.

## Garde-fou hors production

Si `NODE_ENV` ≠ `production`, **tous** les mails partent vers
`BASE_RECIPIENT_EMAIL` (l'objet indique le vrai destinataire) et la tâche
quotidienne n'est pas lancée.

## Qui est relancé ?

Tous les comptes AD **actifs** sous `SEARCH_BASE` ayant un attribut `mail`,
sauf ceux listés dans `PWD_REMINDER_EXCLUDE` (emails ou sAMAccountName :
comptes de service, boîtes génériques...).

> Différence avec l'API d'origine : celle-ci ne relançait que les comptes
> également présents et actifs dans users-manager. Ici, sans base SQL, c'est
> `PWD_REMINDER_EXCLUDE` qui écarte les comptes à ne pas relancer — faire un
> `dryRun` avant la première mise en production.

## Prérequis AD

Le compte de service (`LDAP_DN`) doit pouvoir lire `pwdLastSet`,
`userAccountControl`, `msDS-ResultantPSO` et `msDS-UserPasswordExpiryTimeComputed`
sur les utilisateurs (droit « Read Account Restrictions »). La connexion se
fait en `ldap://` port 389 chiffré par StartTLS (`LDAP_CA_CERT_PATH` si le
certificat du DC n'est pas reconnu).

## Structure

```
app.js                      point d'entrée (listen + tâche quotidienne)
config/                     chargement .env, logger (logs/ en rotation 14 j)
src/app.js                  application Express
src/reminders/              routes, contrôleurs, logique de sélection, validation
src/services/ad.service.js  calcul de l'expiration depuis l'AD
src/services/mail.service.js + mail-templates/expiration.html
src/services/scheduler.js   planification jours ouvrés
tests/                      vitest (AD et SMTP simulés) : npm test
Dockerfile, docker-compose.yml, certs/   déploiement Docker
```
