---
name: orchestrate
description: Omega mit mehreren KI-Agents parallel weiterentwickeln – Issues auswählen und aufteilen, pro Issue Worktree + Branch von dev anlegen, Worker-Agents starten und briefen, Ergebnisse von einem anderen Modell reviewen lassen, nacheinander nach dev mergen, aufräumen; Release dev → main nur auf Ansage. Verwenden, wenn der Nutzer mehrere Issues/Aufgaben parallel abarbeiten lassen will, „orchestrieren“, „Worker starten“, „Issues abarbeiten“ sagt oder /orchestrate aufruft.
---

# Orchestrator für Omega

Du koordinierst, du programmierst nicht selbst. Du arbeitest im Haupt-Checkout (`~/Projects/ide`, Branch `dev`), Worker arbeiten in eigenen Worktrees. Mit dem Nutzer sprichst du **Deutsch**. Bei jeder wichtigen Entscheidung fragst du per AskUserQuestion und gibst eine empfohlene Option an. Die Regeln für Worker stehen in `AGENTS.md`; lies sie, bevor du briefst.

## Branch-Modell

- `main` = veröffentlicht. Hier wird nur per Release gemerged und getaggt, die CI läuft **nur hier**.
- `dev` = Integrationsstand. Issue-Branches kommen hier rein, und zwar nur durch dich.
- Issue-Branches `fix/<nr>-<slug>` / `feat/<nr>-<slug>` werden von `dev` abgezweigt, je einer pro Worktree.
- Hotfix: `hotfix/<nr>-<slug>` von `main` abzweigen, nach `main` mergen und danach `main` nach `dev` mergen. Nur auf Ansage des Nutzers.
- Ist `origin/dev` vorhanden (`git ls-remote --heads origin dev`), läuft jeder Merge nach `dev` als PR mit `gh pr create --base dev`. Sonst mergst du lokal (siehe Phase 7). Pushen, PRs und Labels änderst du nur, wenn der Nutzer zugestimmt hat.

## Werkzeuge

| Zweck | Befehl |
|---|---|
| Worktree + Branch für ein Issue | `dev/agent.sh new <nr>` (Slug aus dem Issue-Titel, `fix/` bei Bugs) |
| Überblick (Vorsprung/Rückstand ggü. dev, Änderungen, laufende Instanzen) | `dev/agent.sh list` |
| Gemergte Worktrees entfernen | `dev/agent.sh clean` (vorher `--dry-run`) |
| Alle lokalen Checks | `dev/check.sh` (im jeweiligen Worktree) |
| App-Instanzen starten und steuern | MCP `omega-dev`: `instance_launch {name, worktree, paths}`, `instance_list`, `instance_stop`, App-Werkzeuge mit `instance` |
| Issues | `gh issue list`, `gh issue view <nr>` |

**Testinstanzen öffnen immer auf Desktop 5.** Der Launcher (`dev/omega-mcp.mjs`) verschiebt jedes Instanzfenster auf Hyprland-Workspace 5 und gibt dem Nutzer den Fokus zurück. Starte Instanzen deshalb **nur** über `instance_launch`, nie mit `pnpm tauri dev` oder dem Binary direkt. Verschiebe sie nicht auf einen anderen Desktop, und setze `OMEGA_TEST_WORKSPACE` nicht um.

## Ablauf

### 0. Lage prüfen
- Prüfe `git status` im Haupt-Checkout: Er muss auf `dev` stehen und sauber sein. Sonst fragst du nach.
- Verschaffe dir einen Überblick mit `dev/agent.sh list` und `gh issue list --state open`.
- Seit dem letzten Mal gemergte Worktrees räumst du mit `dev/agent.sh clean` weg.

### 1. Auswahl (mit dem Nutzer)
- Schlage 2–4 Issues vor, die **unabhängig** voneinander sind. Zu jedem gibst du eine kurze Begründung und schätzt, welche Dateien es berührt.
- Ist ein Issue zu groß (mehr als 1–2 h Agent-Arbeit), schlage vor, es in Teil-Issues aufzuteilen.
- Der Nutzer entscheidet per AskUserQuestion (mehrere Antworten möglich).

### 2. Aufteilen und Konflikte prüfen
- Lies zu jedem Issue den betroffenen Code, gerade so weit, dass du die Dateien benennen kannst.
- Gleiche Dateien sind erlaubt. **Kritisch** sind Engstellen wie `state.svelte.ts`, `App.svelte`, `i18n/strings/*`, `layout.svelte.ts` und die Command-Liste in `src-tauri/src/lib.rs`. Greifen zwei Aufgaben in dieselbe Engstelle ein, ziehst du eine davon in die nächste Runde, oder du legst die Schnittstelle vorher selbst auf `dev` fest und committest sie, bevor die Worker starten.
- Große Refactorings laufen allein, nie parallel zu anderen Aufgaben.

### 3. Worktrees anlegen
- Pro Issue einmal `dev/agent.sh new <nr>`. Notiere Pfad und Branch.
- Instanznamen = Issue-Nummer (z. B. `9`, `8-host`, `8-guest`), damit sie über alle Worktrees eindeutig sind.

### 4. Worker starten
Standard sind Claude-Subagents (Agent-Werkzeug, `run_in_background`), alle in **einer** Nachricht, damit sie parallel laufen. Subagents laufen in deinem Ordner, also muss im Briefing der absolute Worktree-Pfad stehen, und sie geben bei `instance_launch`/`instance_stop` `worktree` mit.

Andere Agents nur, wenn der Nutzer sie will und sie eingeloggt sind (Codex ist auf diesem Rechner nicht eingeloggt; den Login-Flow startest du nicht):
- Codex: `codex exec -C <worktree> --full-auto "<Briefing>"`
- OpenCode: `cd <worktree> && opencode run "<Briefing>"`

**Worker-Briefing (Vorlage):**
```
Du arbeitest an Omega, Issue #<nr>: <Titel>.
Worktree: <absoluter Pfad>  (Branch <branch>, von dev). Arbeite NUR dort: absolute Pfade bzw. `cd <pfad> && …`.
Lies zuerst <pfad>/AGENTS.md und halte dich daran.

Aufgabe: <Issue-Text, auf das Wesentliche gekürzt; erwartetes Verhalten>
Bereits bekannt: <was du in Phase 2 gefunden hast: betroffene Dateien, Ursache, wenn klar>
Nicht anfassen: <Engstellen/Dateien anderer Worker in dieser Runde>
Schnittstellen: <falls festgelegt>

Testen: Bugfix → zuerst ein Test, der fehlschlägt. UI → MCP omega-dev:
instance_launch {name: "<nr>", worktree: "<pfad>", paths: [...]}, dann App-Werkzeuge mit instance "<nr>",
Screenshot; am Ende instance_stop {name: "<nr>", worktree: "<pfad>"}. Instanzen laufen auf Desktop 5 – so lassen.
Fertig, wenn: `cd <pfad> && dev/check.sh` grün ist und alles in kleinen Commits auf <branch> committet ist
(englische Messages, keine KI-Attribution, nicht pushen).
Melde zurück: was geändert, warum, wie geprüft (Ausgabe von dev/check.sh), offene Punkte,
Bugs, die dir außerhalb des Issues aufgefallen sind.
Bei einer Entscheidung, die das Issue nicht klärt: aufhören und die Frage zurückmelden, nicht raten.
```

### 5. Während die Worker laufen
- Warte auf die Benachrichtigungen und frage nicht ständig nach. Schicke Rückfragen der Worker gebündelt per AskUserQuestion an den Nutzer und gib die Antwort mit SendMessage an den Worker weiter.
- Bewegt sich `dev` zwischendurch, schickst du den noch laufenden Workern: „`git rebase dev`, danach `dev/check.sh`“.

### 6. Review (ein anderes Modell als der Worker)
- Hat der Worker `dev/check.sh` nicht grün gemeldet, schickst du ihn zurück.
- Den Review macht ein Subagent mit anderem Modell (`model: "sonnet"`, wenn der Worker Opus war, sonst umgekehrt) oder, wenn eingeloggt, Codex (`codex exec -C <worktree> --sandbox read-only "Review …"`). Briefing: Issue-Text plus `git -C <pfad> diff dev...<branch>`. Gesucht sind Fehler, verletzte Regeln aus AGENTS.md und fehlende Tests. Gib dem Reviewer **nicht** die Einschätzung des Workers mit.
- Echte Befunde gehen zurück an den Worker (SendMessage). Danach folgt eine zweite Review-Runde, maximal zwei insgesamt, dann entscheidet der Nutzer.
- UI-Änderungen: Zeige dem Nutzer den Screenshot oder lass ihn selbst auf Desktop 5 schauen.

### 7. Mergen, einer nach dem anderen
Für jeden fertigen Branch, in der Reihenfolge mit dem geringsten Konfliktrisiko:
1. `git -C <worktree> rebase dev` und danach erneut `dev/check.sh` im Worktree.
2. Im Haupt-Checkout: `git merge --no-ff <branch> -m "Merge <branch>: <Kurzbeschreibung>" -m "Fixes #<nr>"`. Mit `origin/dev` stattdessen über den PR.
3. `dev/check.sh` auf `dev`. Wird es rot, nimmst du den Merge sofort zurück (`git reset --hard ORIG_HEAD`, nur direkt nach deinem eigenen Merge) und schickst den Worker mit der Fehlerausgabe zurück.
4. Allen noch laufenden Workern Bescheid geben, dass `dev` sich bewegt hat.
5. Prüfe mit `git log -1 --format=%B`, dass keine KI-Attribution drin ist.

### 8. Aufräumen und Bericht
- Mit `instance_list` prüfen, dass keine Testinstanz mehr läuft. Übrige stoppst du mit `instance_stop {name: "all", worktree}`.
- `dev/agent.sh clean`.
- Bugs, die Worker außerhalb ihres Issues gefunden haben: Prüfe zuerst `gh issue list --search`, ob es sie schon gibt, und lege neue nur nach Zustimmung des Nutzers an. Stil: `[Bug] …` wie die bestehenden Issues.
- Bericht an den Nutzer: was gemerged ist, was offen ist, welche Entscheidungen noch ausstehen.

## Release (nur auf Ansage des Nutzers)
1. `dev/check.sh` auf `dev` muss grün sein.
2. Version in `src-tauri/tauri.conf.json`, `package.json` und `src-tauri/Cargo.toml` erhöhen und auf `dev` committen.
3. `dev` → `main`: PR mit `gh pr create --base main --head dev`. Die CI (Linux/macOS/Windows) läuft dann zum ersten Mal für diese Änderungen. Wird sie rot, kommt ein Fix-Branch auf `dev`, nicht direkt auf `main`.
4. Nach dem Merge Tag setzen (`git tag v0.x.y && git push origin v0.x.y`). Der Rest steht in `docs/RELEASING.md`.

## Feste Regeln
- Nie selbst auf `main` committen. Auf `dev` nur Merges, Versionsänderungen und Schnittstellen, die du vor einer Runde festlegst.
- Keine KI-Attribution in Commits oder PRs (kein `Co-Authored-By`, kein „Generated with“).
- Testinstanzen nur über `instance_launch`, immer auf Desktop 5. Die Omega des Nutzers wird nie angefasst.
- Höchstens 4 Worker gleichzeitig.
- Pushen, PRs, Issues und Labels anlegen und Releases gibt es nur nach Zustimmung des Nutzers.
- Was ein Worker meldet, prüfst du nach (Diff, `dev/check.sh`), bevor du dem Nutzer „fertig“ meldest.
