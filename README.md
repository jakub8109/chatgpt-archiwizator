# ChatGPT Archiwizator

Twórca: **Jakub Lipiński**

Przenośna aplikacja dla Windows. Zapisuje rozmowy z ChatGPT z obszaru roboczego **Santander** do folderu, który wskaże użytkownik. Archiwum ma formę strony HTML: spis tematów z wyszukiwarką, strony rozmów ze zdjęciami i galerię. Działa bez instalacji, bez uprawnień administratora i bez internetu podczas przeglądania.

## Pobranie gotowej wersji

GitHub buduje plik automatycznie: zakładka **Actions** → ostatnie udane uruchomienie „Build” → artefakt **ChatGPT-Archiwizator-portable**. Wersje oznaczone tagiem `v*` trafiają też do zakładki **Releases**.

## Kompilacja samodzielna

Wymagania: Windows 10/11 i [Node.js 20+](https://nodejs.org).

```powershell
git clone https://github.com/jakub8109/chatgpt-archiwizator.git
cd chatgpt-archiwizator

cd engine
$env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1"   # przeglądarka nie jest potrzebna, aplikacja używa Edge
npm ci
npm test                                      # testy silnika (bezpieczeństwo HTML, nazwy plików, import)

cd ..\app
npm ci
npm run dist                                  # wynik: app\release\ChatGPT-Archiwizator-<wersja>-portable.exe
```

Jeśli `npm run dist` zgłosi błąd *„Cannot create symbolic link”* przy `winCodeSign`, włącz **Tryb dewelopera** w Windows (Ustawienia → System → Dla deweloperów) albo uruchom polecenie raz w terminalu z uprawnieniami administratora.

Szybki test okna bez logowania: `npm run smoke` (w katalogu `app`).

## Struktura

| Katalog | Zawartość |
|---|---|
| `engine/` | Silnik archiwizacji (TypeScript): logowanie przez przeglądarkę, ograniczenie do obszaru roboczego, pobieranie rozmów i załączników, wznawianie, Markdown, strony HTML. Ten sam silnik działa jako wtyczka JARVIS. |
| `app/` | Aplikacja Electron: okno z krokami (folder → logowanie → archiwizacja), postęp, anulowanie, budowanie wersji portable. |

## Bezpieczeństwo

Szczegóły dla działu IT są w [app/README.md](app/README.md). W skrócie:

- **Tylko obszar roboczy Santander.** Inne konta i obszary są odrzucane, a każde zapytanie jest przypisane do tego obszaru.
- **Tylko odczyt.** Aplikacja niczego nie zmienia w ChatGPT.
- **Bez hasła.** Logowanie odbywa się w zwykłym oknie Edge; aplikacja nie widzi hasła.
- **Bez serwera i telemetrii.** Dane trafiają tylko do wskazanego folderu.
- **Bezpieczne archiwum HTML:**
  - treść rozmów jest escapowana i objęta ścisłą polityką CSP;
  - obrazki ładują się tylko z folderu archiwum, bez ścieżek sieciowych (UNC);
  - załączniki aktywne (`.html`, `.svg`, `.exe`…) zapisują się jako `.txt`.

Archiwum zawiera treści służbowe. Przechowuj je zgodnie z zasadami firmy.

---
© 2026 Jakub Lipiński. Wszelkie prawa zastrzeżone.
