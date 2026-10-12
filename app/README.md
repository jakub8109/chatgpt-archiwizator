# ChatGPT Archiwizator

Twórca: **Jakub Lipiński**

Przenośna aplikacja dla Windows. Zapisuje rozmowy z ChatGPT z firmowego obszaru roboczego **Santander** w folderze, który wskazuje pracownik. Nie wymaga instalacji ani uprawnień administratora.

## Dla pracownika

1. Uruchom `ChatGPT-Archiwizator-<wersja>-portable.exe`.
2. **Krok 1. Wybierz folder.** Najlepiej w Dokumentach albo na dysku sieciowym. Aplikacja utworzy w nim podfolder `ChatGPT`.
3. **Krok 2. Zaloguj do ChatGPT.** Otworzy się okno Edge. Zaloguj się kontem firmowym tak jak zwykle; aplikacja nie widzi Twojego hasła. Okno zamknie się samo po zalogowaniu.
4. **Krok 3. Rozpocznij archiwizację.** Pasek pokazuje postęp i szacowany czas. W tym czasie:
   - nie zamykaj aplikacji;
   - nie zamykaj zminimalizowanego okna Edge na pasku zadań.
5. Na koniec kliknij **„Otwórz spis rozmów”**.

Wskazówki:

- Kolejne uruchomienia pobierają tylko nowe i zmienione rozmowy, zwykle w kilka sekund.
- Przerwana archiwizacja dokończy się przy następnym uruchomieniu: wystarczy kliknąć „Rozpocznij archiwizację”.
- Gdy sesja wygaśnie, aplikacja poprosi o ponowne zalogowanie.

## Co powstaje w folderze

```
ChatGPT/
  INDEX.md                    spis wszystkich rozmów (od najnowszej) z linkami
  workspace.json              z jakiego obszaru roboczego jest archiwum
  conversations/RRRR/MM/<data>_<tytuł>_<id>/
    conversation.md           rozmowa (role, daty, godziny, obrazki)
    attachments/              Twoje pliki i obrazki z rozmowy
    metadata.json, raw.json   dane techniczne (wszystkie wersje edytowanych odpowiedzi)
```

Pliki `.md` najwygodniej czytać w VS Code (podgląd: Ctrl+Shift+V), w Obsidian albo w dowolnej przeglądarce Markdown.

## Zasady bezpieczeństwa (dla IT)

- **Tylko obszar roboczy Santander.**
  - Po zalogowaniu aplikacja sprawdza, czy konto należy do płatnego obszaru roboczego o nazwie „Santander” (Business, Enterprise lub Team). Konto prywatne lub inny obszar jest odrzucany przed pobraniem czegokolwiek.
  - Każde zapytanie jest przypisane do tego obszaru (`ChatGPT-Account-Id`), więc prywatne rozmowy pracownika nie trafiają do archiwum.
  - Jeden folder może zawierać archiwum tylko jednego obszaru.
- **Tylko odczyt.** Aplikacja niczego nie zmienia, nie usuwa i nie archiwizuje w ChatGPT.
- **Bez haseł.** Logowanie odbywa się w zwykłym oknie Edge. Aplikacja przechowuje wyłącznie sesję przeglądarki w profilu użytkownika Windows: `%APPDATA%\ChatGPT Archiwizator\browser-profile`.
- **Bez serwera i telemetrii.** Dane trafiają tylko do folderu wskazanego przez pracownika.
- **Przeglądarka.**
  - Aplikacja używa zainstalowanego Microsoft Edge, a jeśli go nie ma, Google Chrome. Nie zawiera własnej przeglądarki.
  - ChatGPT (Cloudflare) blokuje przeglądarki uruchomione bez okna, dlatego podczas archiwizacji Edge działa w zwykłym, zminimalizowanym oknie.
- Okno aplikacji nie ma dostępu do systemu: obowiązują `contextIsolation`, `sandbox` i ścisła polityka CSP. Ma do dyspozycji tylko kilka wywołań, m.in. wybór folderu, logowanie, start, anulowanie i otwarcie wyniku.

> Archiwum zawiera treści służbowe. Folder zapisu powinien spełniać zasady przechowywania danych firmy, np. zaszyfrowany dysk albo dysk sieciowy z kontrolą dostępu. Przed udostępnieniem aplikacji w firmie warto uzgodnić to z działem bezpieczeństwa IT.

## Budowanie

```powershell
cd engine; npm ci; cd ..pp
npm ci
npm run dist        # release\ChatGPT-Archiwizator-<wersja>-portable.exe
npm run smoke       # test okna (bez logowania)
```

Silnik archiwizacji (`../engine`, wspólny z wtyczką JARVIS) jest dołączany do aplikacji przy budowaniu. Przed `npm ci` w `app` zainstaluj zależności w `engine` (patrz główny README).
