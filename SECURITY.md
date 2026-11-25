# Veiligheid
Laatste check: 2026-11-25, commit 428dc50, scope repo

| Cat | Status | Open |
|---|---|---|
| A Geheimen | ok | Geen geheimen in de code; alles via env-vars. |
| B Data-toegang | ok | Agent-tools die afspraken wijzigen controleren eigenaarschap server-side. |
| C Auth | ok | Webhook-verificatie constant-time. |
| D Input/output | ok | Widget escapet alle tekst; SQL geparametriseerd. |
| E Infra | oranje | Een paar moderate dependency-meldingen (zie open punten). |

## Open punten
- [E9] Moderate meldingen in `qs` (via express) en `uuid` (via node-cron 3). Op te lossen met een express-update en node-cron 4 (major). Wie: Claude, bij de volgende onderhoudsronde.
- [E2] HTTPS en HSTS worden door de hosting-proxy afgedwongen, niet door de app. Wie: Samuel, check in de proxy-config.
- [E11] Webchat heeft rate limits per minuut en per dag per IP, geen captcha. Voldoende zolang er geen misbruik is.

## Bewuste uitzonderingen
- [C5] `Math.random` in `public/widget.js` is alleen een fallback-id als de server onbereikbaar is; de server accepteert uitsluitend door hemzelf uitgegeven sessie-id's.
- [D3] `innerHTML` in `public/widget.js`: alle dynamische tekst gaat door `escHtml`/`escAttr`.
- [D7] Regexen in `src/agents/reply-guards.js` draaien op modeloutput van beperkte lengte, niet op vrije gebruikersinvoer.
- [E3] `trust proxy` staat op 1 hop: de app draait achter precies een eigen reverse proxy.
