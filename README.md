# Gemeinsame Aufgaben

Eine schlichte, geteilte To-do-Liste für kleine Gruppen. Änderungen erscheinen bei allen sofort (Echtzeit).

- **Frontend:** reines HTML/CSS/JavaScript, ohne Build-Schritt
- **Backend:** [Supabase](https://supabase.com) (PostgreSQL-Datenbank, Login und Echtzeit-Sync), kostenloser Tarif
- **Hosting:** GitHub Pages, kostenlos

## Funktionen

- Mehrere Listen/Kategorien anlegen, umbenennen und löschen
- Aufgaben anlegen, abhaken, bearbeiten (Titel + Notiz) und löschen
- Unteraufgaben (Checkliste pro Aufgabe) mit Fortschrittsanzeige, z. B. „☑ 2/5“
- Prioritäten (hoch, normal, niedrig): offene Aufgaben werden danach gruppiert
- Reihenfolge von Listen und Aufgaben per Drag & Drop am Griff ⠿ ändern, auch am Handy.
  Wer eine Aufgabe in eine andere Prioritätsgruppe zieht, ändert damit ihre Priorität.
- Aufgaben einer Person zuweisen
- Filter: erledigte ausblenden, nur meine oder nicht zugewiesene Aufgaben anzeigen
- Anmeldung mit E-Mail und Passwort, Hell-/Dunkelmodus, auch am Handy nutzbar

## Einrichtung

### 1. Supabase-Projekt anlegen

1. Auf [supabase.com](https://supabase.com) kostenlos registrieren und ein neues Projekt erstellen.
2. Im Dashboard **SQL Editor** öffnen, den Inhalt von [`supabase/schema.sql`](supabase/schema.sql) einfügen und **Run** klicken.
3. Unter **Project Settings → API** (bzw. **API Keys**) die **Project URL** und den **anon/publishable Key** kopieren
   und in [`config.js`](config.js) eintragen.

> Der anon-Key ist öffentlich und darf ins Repository. Die Daten schützen die Row-Level-Security-Regeln:
> Nur angemeldete Benutzer dürfen lesen und schreiben. Den **service_role/secret Key** niemals eintragen.

### 2. Lokal testen

Die Seite braucht einen kleinen Webserver, weil sie JavaScript-Module nutzt. Ein Doppelklick auf `index.html` funktioniert nicht.

```bash
python3 -m http.server 8000
```

Danach <http://localhost:8000> öffnen.

### 3. Konten anlegen und Registrierung schließen

1. Du und dein Mitspieler registrieren euch über die Seite.
   Supabase verschickt standardmäßig eine Bestätigungs-E-Mail. Wer das nicht möchte, schaltet es unter
   **Authentication → Sign In / Providers → Email → Confirm email** aus.
2. **Wichtig:** Sobald alle ein Konto haben, unter **Authentication → Sign In / Providers**
   die Option **Allow new users to sign up** deaktivieren. Dann kann sich niemand Fremdes mehr registrieren.

### 4. Auf GitHub Pages veröffentlichen

1. Im GitHub-Repository: **Settings → Pages → Build and deployment → Source: Deploy from a branch**,
   Branch `main`, Ordner `/ (root)`.
2. Nach etwa einer Minute ist die Seite unter `https://<benutzername>.github.io/<repo-name>/` erreichbar.
3. In Supabase unter **Authentication → URL Configuration** diese Adresse als **Site URL** eintragen,
   damit die Links in Bestätigungs-E-Mails dorthin führen.

## Updates für bestehende Installationen

Neue Funktionen brauchen manchmal Änderungen an der Datenbank. Diese liegen in `supabase/updates/`
und werden **einmal** im SQL Editor ausgeführt, der Reihe nach und am besten vor dem Hochladen des neuen Codes:

| Datei | Inhalt |
|---|---|
| `002_unteraufgaben_prioritaet_reihenfolge.sql` | Unteraufgaben, Prioritäten, Drag-&-Drop-Reihenfolge |

`supabase/schema.sql` enthält immer den vollständigen aktuellen Stand und ist für neue Installationen gedacht.

## Hinweis zum kostenlosen Tarif

Supabase pausiert kostenlose Projekte nach etwa einer Woche ohne Aktivität. Im Dashboard lässt sich das Projekt
mit einem Klick wieder starten, die Daten bleiben erhalten.

## Projektstruktur

```
index.html           Seitenaufbau
style.css            Aussehen (neutral, Hell-/Dunkelmodus)
app.js               Logik: Anmeldung, Daten laden/ändern, Echtzeit-Updates
config.js            Supabase-URL und anon-Key
supabase/schema.sql  Tabellen, Zugriffsregeln, Echtzeit (vollständig)
supabase/updates/    Datenbank-Änderungen für bestehende Installationen
```

Externe Bibliotheken werden direkt vom CDN geladen: `@supabase/supabase-js` und `sortablejs` für Drag & Drop.

## Ideen für später

- Fälligkeitsdaten
- Unteraufgaben per Drag & Drop sortieren
- Erledigte Aufgaben einer Liste auf einmal löschen
- Verlauf: wer hat wann was erledigt
