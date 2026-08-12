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
4. **Domains**: voeg je hostname toe, service `web`, container-poort `3000`, HTTPS aan met Let's Encrypt.
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

**`gh` authenticeren in de container.** De `gh_*` MCP-tools shellen naar `gh`. Eenmalig, blijft staan via het `jupietre-gh-config`-volume:

```bash
docker exec -it jupietre-web gh auth login   # GitHub.com → HTTPS → web browser
docker exec -it jupietre-web gh auth status
```

Zonder dit faalt elke `gh_create_pr`.

**Linear-poller aanzetten.** Hij staat uit via `DISABLE_LINEAR_POLLER=1`. Dat is bewust: bij de eerste boot zou `lib/linear/seed-from-env.ts` anders automatisch een poller aanmaken met `defaultLabel: "agent"`, terwijl jouw oude setup `mas-agent` gebruikte. Volgorde:

1. Configureer de poller in de UI op `/pollers` — API-key, team, label (`mas-agent`), en per agent een rule met pickup- en in-progress-state.
2. Zet `DISABLE_LINEAR_POLLER=0` in Environment en redeploy.

**Repos.** `GITHUB_REPOS` (`label:owner/repo`) seedt de repo-dropdown op `/sessions/new` en cloont ze bij de eerste boot naar `/data/repos`. Die sources zijn read-only voor de agents: elke sessie krijgt een eigen worktree onder `/app/data/worktrees/<sessionId>`.

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
