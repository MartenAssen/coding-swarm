# Deploy via Dokploy

Deze repo bevat al een productie-compose. `docs/DEPLOY.md` beschrijft de bare-Docker route met Caddy; dit document is de Dokploy-route, waarbij Dokploy's Traefik de TLS en routing doet.

## Hoe de compose-bestanden zich verhouden

| bestand | wie leest het | wat het doet |
| --- | --- | --- |
| `docker-compose.yml` | Dokploy **en** lokaal | `postgres` + `web`, named volumes, `expose: 3000`, geen host-poorten |
| `docker-compose.override.yml` | **alleen lokaal** (auto-merge door `docker compose`) | host-poorten 3000/11112 + een Caddy-proxy |

Dokploy deployt de base-file met een expliciete `-f`, dus de override — en dus Caddy en de open poorten — komt nooit in productie. Traefik doet TLS.

## Voorbereiding

- DNS: `A`-record (en `AAAA` als je IPv6 hebt) van je hostname naar het IP van de server. Laat dit propageren vóór je een domein in Dokploy toevoegt, anders faalt de Let's Encrypt-challenge.
- Serverresources: de build doet een volledige `next build` plus `npm i -g @anthropic-ai/claude-code` en `pip install graphifyy[mcp]`. Reken op **≥4 GB RAM** en ~6 GB schijf tijdens de build.

## Stappen in de Dokploy UI

1. **Create → Compose** (niet "Application" — we willen app + Postgres samen beheerd).
2. **Source**: Git provider → `MartenAssen/coding-swarm`, branch `master`. Compose-pad: `docker-compose.yml`.
3. **Environment**: paste de volledige inhoud van `.env.dokploy` (staat in de repo-root op je werkmachine, gitignored). Vervang `__DOMEIN__` op beide plekken door je hostname.
4. **Domains**: voeg je hostname toe, service `web`, container-poort `3000`. HTTPS met Let's Encrypt aan — **behalve** als je via Cloudflare Tunnel werkt, zie [Cloudflare Tunnel](#cloudflare-tunnel).
5. **Preview Compose** — klik dit vóór de deploy. Controleer in de gegenereerde YAML dat de `web`-service:
   - Traefik-labels heeft met jouw `Host(...)`-rule en `loadbalancer.server.port=3000`
   - op `dokploy-network` zit
   Zie de fallback hieronder als dat er niet staat.
6. **Deploy** en volg de logs van `web`. Je zoekt:
   ```
   [db] migrations applied
   [auth] Bootstrapped admin user: martenassen@gmail.com
   [skills] seeded 23 skill(s)
   Ready in …
   ```
   Stopt `web` direct? Dan is het env-validatie — `lib/env.ts` print precies welke variabele mist.
7. Inloggen op `https://<domein>/login` met `ADMIN_EMAIL` / `ADMIN_PASSWORD`.

## Fallback: Traefik routeert niet naar de app

Dokploy hoort de labels en het netwerk zelf te injecteren, maar dat gaat niet in alle versies goed ([#3200](https://github.com/Dokploy/dokploy/issues/3200), [#3435](https://github.com/Dokploy/dokploy/issues/3435)). Zie je een 404 van Traefik of "Bad Gateway", voeg dan aan `docker-compose.yml` onder `web:` toe:

```yaml
    networks: [default, dokploy-network]
    labels:
      - traefik.docker.network=dokploy-network
```

en onderaan het bestand:

```yaml
networks:
  dokploy-network:
    external: true
```

Laat `postgres` op `default` staan — die hoeft niet vanaf buiten bereikbaar te zijn.

## Na de eerste deploy

**GitHub-token.** Zie [GitHub-token](#github-token) hieronder. Sla `gh auth login` over: zodra `GITHUB_TOKEN` in de env staat, negeert de `gh` CLI opgeslagen credentials.

**Linear-poller aanzetten.** Hij staat uit via `DISABLE_LINEAR_POLLER=1`. Dat is bewust: bij de eerste boot zou `lib/linear/seed-from-env.ts` anders automatisch een poller aanmaken met `defaultLabel: "agent"`, terwijl jouw oude setup `mas-agent` gebruikte. Volgorde:

1. Configureer de poller in de UI op `/pollers` — API-key, team, label (`mas-agent`), en per agent een rule met pickup- en in-progress-state.
2. Zet `DISABLE_LINEAR_POLLER=0` in Environment en redeploy.

**Repos.** `GITHUB_REPOS` (`label:owner/repo`) seedt de repo-dropdown op `/sessions/new` en cloont ze bij de eerste boot naar `/data/repos`. Die sources zijn read-only voor de agents: elke sessie krijgt een eigen worktree onder `/app/data/worktrees/<sessionId>`.

## Cloudflare Tunnel

Draait dit op een homeserver zonder open poorten, dan kan Cloudflare Tunnel de app publiceren. Eén domein kan naar meerdere servers tunnelen: een hostname hoort bij precies één tunnel, maar je kunt onbeperkt hostnames en tunnels onder hetzelfde domein hangen. Heb je al een tunnel naar een andere machine, dan komt er simpelweg een tweede `cloudflared` op deze server bij — de bestaande blijft ongemoeid.

### Deze server

Geverifieerd op `ubuntuserver` (tailnet-IP `100.77.98.57`):

| poort | wat er draait |
| --- | --- |
| 3000 | Dokploy UI |
| 80 | Traefik — geeft `404 page not found` voor een onbekende `Host`, dat is correct |
| 443 | Traefik met zijn `TRAEFIK DEFAULT CERT` self-signed cert |

Omdat Traefik 443 al bezet houdt, is `tailscale serve` hier geen optie zonder naar een andere poort uit te wijken. De tunnel gaat naar **poort 80**.

### Opzet

1. Zero Trust → Networks → Tunnels → **Create a tunnel** (type `cloudflared`). Installeer de connector als host-service op `ubuntuserver` — Cloudflare geeft je het `apt`-commando met token erin. Als host-service kan hij direct bij `localhost:80`; kies je toch een Docker-container, dan moet die op `dokploy-network` en naar de Traefik-containernaam wijzen (`docker ps`).
2. **Public hostname**: `agents` + `assenhomelab.nl`, service `http://localhost:80`.

   Wijs de tunnel naar **Traefik**, niet rechtstreeks naar `web:3000`. Traefik routeert op de `Host`-header, dus zo hang je later meer apps onder dezelfde tunnel zonder iets te herconfigureren.
3. Cloudflare zet zelf het `CNAME`-record. Laat de proxy (oranje wolk) aan.
4. In Dokploy → Domains: `agents.assenhomelab.nl`, service `web`, poort `3000`, **HTTPS uit**.

### Geen Let's Encrypt

Cloudflare termineert TLS aan de edge en de hop naar `cloudflared` is al versleuteld. Laat in Dokploy's Domains-paneel HTTPS/Let's Encrypt daarom **uit**: de HTTP-01 challenge verwacht publieke poort 80, die je achter een tunnel niet hebt. Traefik serveert plain HTTP op de `Host`-rule, Cloudflare doet de rest.

Zet `APP_URL=https://<hostname>` (niet `http://`) — de app gebruikt die waarde voor absolute links en voor origin/CSRF-checks.

### Timeouts zijn geen probleem

Cloudflare's proxy verbreekt een verbinding die 100s stil is (error 524). Dat raakt deze app niet:

- `app/api/sessions/[id]/stream/route.ts:33-35` stuurt elke 25s een `: ping` heartbeat, expliciet "so intermediaries don't close the stream".
- Turns starten als `void startTurn(...)` (o.a. `app/api/sessions/[id]/messages/route.ts:35`) — de POST antwoordt direct, het agent-werk loopt async door en resultaten komen via SSE binnen.

### Cloudflare Access is hier geen luxe

De login van deze app heeft **geen rate limiting, geen lockout en geen 2FA** (`app/api/auth/login/route.ts` — één DB-lookup, `verifyPassword`, klaar). De webhook-ingest heeft wél een limiter van 60/min, de login niet. Achter die login zitten je Claude-token, je Linear-key en een GitHub PAT met write-access op je org-repos. Publiek exposen zonder extra laag betekent onbeperkt wachtwoord raden op het meest waardevolle doelwit in je netwerk.

Zet daarom Access ervoor:

1. Zero Trust → Access → **Applications** → Add → Self-hosted, domein `agents.assenhomelab.nl`.
2. Policy: **Allow**, selector `Emails` → je eigen adres (of Google SSO). Session duration ruim zetten — een maand — zodat de PWA op je telefoon niet elke dag opnieuw vraagt.
3. **Tweede Application** voor pad `/api/hooks`, policy **Bypass** → Everyone.

Die tweede is niet optioneel als je de event-bus gebruikt: `/api/hooks/<key>` is het externe ingangspunt en heeft bewust geen sessie-auth (`app/api/hooks/[key]/route.ts`) — het leunt op een geheime key in het pad plus die 60 req/min. Access ervoor zetten breekt elke inkomende webhook, stil.

Access laat SSE ongemoeid, dus de streaming UI blijft werken.

## GitHub-token

De app raakt GitHub op vijf plekken:

| operatie | code | rechten |
| --- | --- | --- |
| `git clone https://x-access-token:TOKEN@…` | `lib/repos/manager.ts:56` | Contents: read |
| `git push` van sessie-branches | agent-worktrees | Contents: write |
| `gh repo view --json nameWithOwner` | `lib/agent/mcp-tools/github.ts:80` | Metadata: read |
| `gh pr create --label …` | `github.ts:194` | Pull requests: write + Issues: write |
| `gh pr review --approve` / `--request-changes` | `github.ts:258` | Pull requests: write |

**Fine-grained PAT** (voorkeur), owner = de org, scope = alleen de repos uit `GITHUB_REPOS`:

| permission | waarde |
| --- | --- |
| Contents | Read and write |
| Pull requests | Read and write |
| Issues | Read and write |
| Metadata | Read (verplicht) |
| Workflows | Write — alleen als agents `.github/workflows/*` mogen wijzigen; zonder dit weigert GitHub die push |

Staat de org geen fine-grained PATs toe, gebruik dan een classic PAT met `repo` + `read:org` (+ `workflow` indien nodig) en autoriseer hem voor de org als SAML SSO aanstaat.

### `gh auth login` is niet nodig

De `gh` CLI geeft `GH_TOKEN`/`GITHUB_TOKEN` uit de env voorrang boven opgeslagen credentials. Omdat `docker-compose.yml` de env inlaadt via `env_file: .env`, wint de PAT altijd. Je kunt niet op `gh auth login` leunen: zonder `GITHUB_TOKEN` kan `lib/repos/manager.ts` geen private repos clonen. Eén token in de env dus. (Dit wijkt af van stap 6 in `DEPLOY.md`, die nog van vóór de env-token uitgaat.)

### Eén token kan geen eigen PR's approven

Maakt de engineer een PR met token X, dan faalt `gh_pr_review --approve` van de QA-agent met *"Can not approve your own pull request"* als die ook token X gebruikt. Gebruik daarvoor de **Connections**-UI: een per-agent PAT die de env-token overschrijft (`lib/agent/mcp-tools/index.ts:82-88`). Zet daar een PAT van een tweede GitHub-account voor de QA-agent, of laat QA alleen `--request-changes` doen en merge zelf.

## Wat er niet meer via env gaat

Uit de oude opzet zijn deze weggevallen — de nieuwe code leest ze niet meer, het is nu DB/UI-config:

| oud | nu |
| --- | --- |
| `STATUS_BACKLOG`, `STATUS_IN_PROGRESS`, … | per rule op `/pollers` |
| `LABEL_AGENT`, `LABEL_NO_QUESTIONS`, `LABEL_SKIP_QA` | poller-label + agent-config |
| `BRANCH_PREFIX` | niet meer bestaand — geen equivalent |
| `AGENT_ROLE` | agents zijn nu rijen in de DB, niet één rol per container |

## Updates

Push naar `master` → Dokploy rebuildt (auto-deploy aan) of klik **Redeploy**. Drizzle-migraties draaien bij elke boot via `instrumentation.ts`, dus schemawijzigingen komen automatisch mee.

## Upstream bijhouden

Deze repo is een fork van `steyn2003/jupietre`, dat als `upstream` remote is geconfigureerd:

```bash
git fetch upstream
git log --oneline HEAD..upstream/master   # wat er nieuw is
git merge upstream/master                 # of rebase
```
