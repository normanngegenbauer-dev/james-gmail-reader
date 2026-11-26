James Gmail Reader for OpenPets
Version 0.3.19 – Community Draft

Funktionen
- Prüft Gmail alle 20 Sekunden.
- Verwendet ausschließlich den Scope gmail.metadata.
- Ruft keine Absender, Betreffzeilen, Header oder Nachrichteninhalte ab.
- Meldet neue E-Mails mit der festgelegten James-Ansage.
- Behält die bestehende Plugin-ID bei.

Einrichtung durch jeden Benutzer
1. In der eigenen Google Cloud Console eine OAuth-Client-ID erstellen.
2. Unter OpenPets > Plugins > James Gmail Reader > Configure die eigene
   Google OAuth Client ID eintragen.
3. Das eigene Google OAuth Client Secret im geschützten Secret-Feld eintragen.
4. Bildschirmbreite und Bildschirmhöhe in Pixel eintragen.
   Normis Standard/Fallback ist QHD: 2560 × 1440.
5. Speichern und anschließend „Gmail verbinden“ ausführen.

Hinweis zur Client-ID
Normis bisherige Client-ID bleibt als Standard/Fallback im Plugin-Code enthalten.
Trägt ein Benutzer im Configure-Feld eine eigene Client-ID ein, hat diese Vorrang.
Eine OAuth-Client-ID ist keine geheime Zugangsinformation.

Sicherheit
- Das Client Secret wird nicht im Quellcode gespeichert.
- Jeder Benutzer muss seine eigene OAuth-Konfiguration und sein eigenes Google-Konto verwenden.
- Vor einer öffentlichen Veröffentlichung müssen OAuth-Einrichtung, Berechtigungen,
  Datenschutztext und OpenPets-Katalogprüfung getestet werden.

Berechtigung
- https://www.googleapis.com/auth/gmail.metadata

Plugin-ID
- dizzy-capybara-1966.gmail-reader
