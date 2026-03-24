GESTIONALE MAGAZZINO MVP - CARICO/SCARICO CON FORNITORE

AVVIO SU WINDOWS
1) Installa Node.js LTS
2) Estrai lo ZIP
3) Doppio click su avvia.bat

Oppure da terminale:
npm install
npm run dev

Apri:
http://localhost:3000

UTENTI DEMO
- admin@demo.it / demo123
- magazzino@demo.it / demo123
- commerciale@demo.it / demo123

NOVITÀ
- Import documento fornitore = carico
- Import documento cliente = scarico
- Per lo scarico cliente tutte le righe sono considerate DI DEFAULT dal tuo magazzino
- Puoi togliere la spunta alle righe spedite dal fornitore
- Le righe spedite dal fornitore non toccano le giacenze
- Ricerca globale e locale
- Documenti salvati e consultabili

NOTE
- I documenti si salvano in uploads
- I dati si salvano in data/db.json
- È una MVP locale per localhost

FIX INTERFACCIA
- Durante carico mostra 'carica a magazzino'
- Durante scarico mostra 'scarica da magazzino'
- La colonna disponibilità ora mostra messaggi coerenti con carico/scarico
- Le righe ignorate/spedizione non impattano il magazzino


AGGIORNAMENTO MISURE
- Topper 80x195 e 160x195 separati
- Demo import cliente aggiornata con quantità corrette 1+1
- Alias vendita distinti per misura


BRANDING
- Logo Tessil Shop integrato
- Dati azienda Gala SRLS inseriti
- Colori adattati al logo


AUTO-ASSOCIAZIONE
- Se associ un codice o una descrizione a un articolo e salvi alias, i prossimi documenti con stesso codice o descrizione simile preselezionano automaticamente lo stesso articolo.
- La logica prova prima per codice, poi descrizione esatta, poi descrizione simile con misura.


LETTURA AUTOMATICA PDF
- Il gestionale prova a leggere automaticamente le righe dei PDF caricati.
- Se riconosce codice, descrizione e quantità, compila le righe reali del documento.
- Se non riesce a leggere il layout, usa ancora la modalità demo come fallback.


QUANTITÀ EDITABILI
- Nelle righe importate da documenti, la quantità è modificabile manualmente prima della conferma.


UTENTI E PERMESSI
- L'amministratore può creare altri utenti.
- Ruoli disponibili: Amministratore, Magazziniere, Commerciale, Solo lettura.
- I menu visibili cambiano in base al ruolo.


PARSER PDF MIGLIORATO
- Riconoscimento automatico fornitore (Datex, Sydex, Cimmino quando possibile).
- Parser dedicato Datex e Sydex.
- Se il PDF non viene letto, il gestionale non mostra più righe demo: avvisa e lascia inserire righe manuali.
- Quantità modificabili manualmente prima della conferma.


FIX ADMIN
- Il login ora restituisce anche roleKey.
- L'amministratore vede di nuovo tutte le sezioni del menu, inclusi Fornitori, Clienti, Magazzini, Alias, Movimenti, Import e Utenti e permessi.


VERSIONE CIMMINO SOLO
- Il carico automatico è stato limitato ai PDF Cimmino.
- Gli altri fornitori non vengono più interpretati automaticamente in questa versione.
- Se un PDF Cimmino è solo immagine/scansione e non contiene testo articolo estraibile, il gestionale avvisa e non inventa righe sbagliate.


CIMMINO OCR
- Aggiunto OCR per i PDF Cimmino che non espongono bene il testo.
- Il sistema prova prima la lettura testuale, poi OCR.
- Se trova righe articolo, propone automaticamente codice, descrizione e quantità.
