/* Alessandro Terminal — interface language (EN / IT).
   The page is written in English; in Italian a translator rewrites what the terminal itself says
   (labels, buttons, headers, messages, notes) as it is drawn. It never touches the data: headlines,
   company and event names, tickers, briefing text (written by the model in each language) and anything
   inside .notranslate stay as the source published them. Numbers keep the decimal point. */
(function (root) {
  "use strict";
  var KEY = "at-lang";
  function initial() {
    try { var v = localStorage.getItem(KEY); if (v === "it" || v === "en") return v; } catch (e) {}
    return /^it\b/i.test((root.navigator && navigator.language) || "") ? "it" : "en";
  }
  var cur = initial();

  // whole text of a node → Italian (labels, headers, buttons)
  var EXACT = {
    "SECURITY": "TITOLO", "SEARCH": "CERCA", "WATCHLIST": "WATCHLIST", "PORTFOLIO": "PORTAFOGLIO", "MARKETS": "MERCATI", "EXCHANGES": "BORSE",
    "HEAT MAPS": "HEAT MAP", "INDICES": "INDICI", "YIELDS": "RENDIMENTI", "CALENDAR": "CALENDARIO", "NEWS": "NEWS", "BRIEFING": "BRIEFING",
    "MOVERS": "MOVIMENTI", "SCREENER": "SCREENER", "COMPARE": "CONFRONTA", "CORREL": "CORREL.", "HEATMAP": "MAPPA SETTORI", "SETTINGS": "IMPOSTAZIONI", "HELP": "AIUTO",
    "TILE": "AFFIANCA", "⊟ CLOSE": "⊟ CHIUDI", "↩ UNDO": "↩ ANNULLA", "TAPE": "NASTRO",
    "WORLD EXCHANGES · OPEN NOW": "BORSE MONDIALI · APERTE ORA", "PORTFOLIO · EUR": "PORTAFOGLIO · EUR", "ECONOMIC CALENDAR": "CALENDARIO ECONOMICO",
    "GOVERNMENT YIELDS": "RENDIMENTI DEI TITOLI DI STATO", "WORLD INDICES": "INDICI MONDIALI", "MARKET MOVERS": "MIGLIORI E PEGGIORI", "EQUITY SCREENER": "SCREENER AZIONI",
    "CORRELATION": "CORRELAZIONE", "SECTOR HEATMAP": "MAPPA DEI SETTORI", "SYMBOL SEARCH": "RICERCA STRUMENTI",
    "MAJOR": "PRINCIPALI", "ALL (PROVIDER)": "TUTTE (FORNITORE)", "OPEN NOW": "APERTE ORA", "NEXT": "PROSSIMA",
    "LOCAL TIME": "ORA LOCALE", "EXCHANGE": "BORSA", "STATUS": "STATO", "SESSION (YOUR TIME)": "SEDUTA (TUA ORA)", "MIC": "MIC",
    "Americas": "Americhe", "Europe & Africa": "Europa e Africa", "Asia-Pacific": "Asia-Pacifico", "AMERICAS": "AMERICHE", "Europe": "Europa", "Middle East & Africa": "Medio Oriente e Africa",
    "MARKET VALUE": "VALORE DI MERCATO", "COST (EUR)": "COSTO (EUR)", "UNREALISED P&L": "P&L NON REALIZZATO", "TODAY": "OGGI", "REALISED P&L": "P&L REALIZZATO",
    "BUY": "ACQUISTO", "SELL": "VENDITA", "CHECK": "VERIFICA", "ADD TRADE": "AGGIUNGI OPERAZIONE", "SAVING…": "SALVATAGGIO…", "CCY": "VALUTA",
    "SYM": "SIMB.", "NAME": "NOME", "QTY": "Q.TÀ", "AVG COST": "COSTO MEDIO", "LAST": "ULTIMO", "DAY": "GIORNO", "VALUE": "VALORE", "VALUE €": "VALORE €",
    "WEIGHT": "PESO", "P&L €": "P&L €", "P&L %": "P&L %", "CLOSED POSITIONS": "POSIZIONI CHIUSE", "FIRST TRADE": "PRIMA OPERAZIONE", "TRADES": "OPERAZIONI",
    "REALISED": "REALIZZATO", "REALISED €": "REALIZZATO €", "DATE": "DATA", "SIDE": "SEGNO", "PRICE": "PREZZO", "FEES": "COMMISSIONI", "NOTE": "NOTA",
    "CONFIRM DELETE": "CONFERMA ELIMINAZIONE", "KEEP": "MANTIENI", "DELETE": "ELIMINA",
    "WORLD": "MONDO", "US OFFICIAL (BLS / BEA)": "USA UFFICIALE (BLS / BEA)", "HIGH IMPACT": "ALTO IMPATTO", "HIGH + MEDIUM": "ALTO + MEDIO", "ALL": "TUTTI", "ALL CCY": "TUTTE",
    "TIME (LOCAL)": "ORA (LOCALE)", "EVENT": "EVENTO", "IMPACT": "IMPATTO", "ACTUAL": "EFFETTIVO", "FCST": "PREVISTO", "PREV": "PRECED.", "REACTION 15M": "REAZIONE 15M",
    "SRC": "FONTE", "HIGH": "ALTO", "MED": "MEDIO", "LOW": "BASSO", "HOL": "FEST.", "JUST OUT": "APPENA USCITO", "NEXT HIGH-IMPACT": "PROSSIMO ALTO IMPATTO",
    "REACTION": "REAZIONE", "BEFORE": "PRIMA", "+15 MIN": "+15 MIN", "+60 MIN": "+60 MIN", "SOURCE": "FONTE", "PAST RELEASES": "USCITE PASSATE",
    "RELEASE (LOCAL)": "USCITA (LOCALE)", "FORECAST": "PREVISTO", "PREVIOUS": "PRECEDENTE", "TIME ET": "ORA NY", "CTRY": "PAESE", "INDICATOR": "INDICATORE", "IMP.": "IMP.",
    "MAP": "MAPPA", "CHANGE": "VARIAZIONE", "SIZE": "DIMENSIONE", "VIEW": "VISTA", "INDEX WT": "PESO INDICE", "EQUAL": "UGUALE", "TRADED VALUE": "CONTROVALORE",
    "TABLE": "TABELLA", "SECTORS": "SETTORI", "COUNTRIES": "PAESI", "CRYPTO": "CRIPTO", "FX": "VALUTE", "DOW 30": "DOW 30", "NASDAQ-100": "NASDAQ-100", "S&P 500": "S&P 500",
    "BASE DATE": "DATA BASE", "GROUP / SECTOR": "GRUPPO / SETTORE", "REGION": "AREA", "STRENGTH · AVERAGE VS THE OTHER 8": "FORZA · MEDIA CONTRO LE ALTRE 8",
    "BASE \\ QUOTE": "BASE \\ QUOTATA",
    "FT": "FT", "BLOOMBERG": "BLOOMBERG", "WSJ": "WSJ", "MARKETWATCH": "MARKETWATCH", "CENTRAL BANKS": "BANCHE CENTRALI", "SEC FILINGS": "DEPOSITI SEC",
    "SEC FILINGS · WATCHLIST": "DEPOSITI SEC · WATCHLIST", "NEW": "NUOVO",
    "DAILY": "GIORNALIERO", "EVENING": "SERALE", "WEEKLY": "SETTIMANALE", "MONTHLY": "MENSILE", "SOURCES": "FONTI", "REWRITE": "RISCRIVI", "RETRY": "RIPROVA",
    "SCHEDULED": "PROGRAMMATO", "writing…": "in scrittura…", "WRITE IN ITALIAN": "SCRIVI IN ITALIANO",
    "SYMBOL": "SIMBOLO", "TYPE": "TIPO", "COUNTRY": "PAESE", "PLAN": "PIANO", "ADD": "AGGIUNGI", "SHOW ALL": "MOSTRA TUTTI", "IN WL": "IN WL",
    "LEVEL": "LIVELLO", "CHG": "VAR.", "CHG%": "VAR.%", "VOLUME": "VOLUME", "TREND": "ANDAMENTO", "% CHANGE": "VAR. %", "PREV CLOSE": "CHIUSURA PREC.",
    "DAY HIGH": "MASSIMO", "DAY LOW": "MINIMO", "52W RANGE": "RANGE 52 SETT.", "OPEN / HIGH / LOW": "APERTURA / MAX / MIN", "MKT CAP": "CAPITALIZZ.",
    "EQUITIES · WATCHLIST": "AZIONI · WATCHLIST", "COMMODITIES": "MATERIE PRIME", "METALS": "METALLI", "TOP GAINERS": "MIGLIORI", "TOP LOSERS": "PEGGIORI",
    "MOST ACTIVE": "PIÙ SCAMBIATI", "SECTOR": "SETTORE", "SORT": "ORDINA", "UP": "SU", "DOWN": "GIÙ", "MOVE": "MOVIMENTO", "TENOR": "SCADENZA", "YIELD %": "RENDIM. %",
    "Δ BP": "Δ PB", "REBASE 100": "BASE 100", "INSTRUMENTS · click to toggle · real daily closes": "STRUMENTI · clic per attivare · chiusure giornaliere reali",
    "No instruments selected": "Nessuno strumento selezionato", "Select instruments below": "Seleziona gli strumenti qui sotto",
    "PRESET THEMES": "TEMI PREDEFINITI", "CUSTOM COLOURS": "COLORI PERSONALIZZATI", "RESET TO DEFAULT": "RIPRISTINA PREDEFINITI",
    "DATA LABELS · only real data is shown": "ETICHETTE DEI DATI · si mostrano solo dati reali",
    "COMMAND LINE": "RIGA DI COMANDO", "FUNCTIONS": "FUNZIONI", "WINDOWS": "FINESTRE", "GOT IT": "HO CAPITO",
    "US MARKET": "MERCATO USA", "BREADTH": "AMPIEZZA", "MKTS": "BORSE", "DATA AS OF": "DATI AL", "DATA AS OF —": "DATI AL —", "PULL": "AGGIORN.",
    "UNITED STATES · U.S. TREASURY": "STATI UNITI · TESORO USA", "EURO AREA · ECB": "AREA EURO · BCE", "LIVE": "LIVE", "LOADING": "IN CARICAMENTO",
    "Loading…": "Caricamento…", "NO DATA": "NESSUN DATO", "Waiting for live quotes…": "In attesa delle quotazioni…", "waiting for live quotes…": "in attesa delle quotazioni…",
    "Help": "Aiuto", "Workspace": "Area di lavoro", "Open windows": "Finestre aperte", "Command line": "Riga di comando",
    "no windows — open one from the bar below": "nessuna finestra — aprine una dalla barra in basso",
    "Watchlist empty — add a symbol above.": "Watchlist vuota — aggiungi un simbolo qui sopra.",
    "No matches. Loosen the filters.": "Nessun risultato. Allarga i filtri.", "All sectors": "Tutti i settori", "Any": "Qualsiasi",
    "Advancing": "In rialzo", "Declining": "In ribasso", "Price": "Prezzo", "Change %": "Var. %", "Other": "Altro", "OTHER": "ALTRO",
    "US sectors": "Settori USA", "Crypto": "Cripto", "Sector loading": "Settore in caricamento", "Not in the S&P 500 (no GICS sector)": "Fuori dall'S&P 500 (nessun settore GICS)",
    "ETF prices, not index levels": "prezzi degli ETF, non livelli degli indici", "updating…": "aggiornamento…",
    "close time not given": "orario di chiusura non indicato", "next open not given": "prossima apertura non indicata", "no major exchange": "nessuna borsa principale",
    "Your portfolio is empty. Record your first trade above — symbol, quantity, price and date. Nothing is preloaded.": "Il portafoglio è vuoto. Registra la prima operazione qui sopra — simbolo, quantità, prezzo e data. Non c'è nulla di precaricato.",
    "live quotes · DERIVED": "quotazioni live · DERIVED", "ECB rate on each trade date": "cambio BCE alla data di ogni operazione", "price + currency effect": "prezzo + effetto cambio",
    "vs previous close": "rispetto alla chiusura precedente", "closed sales, EUR": "vendite chiuse, EUR",
    "Loading your portfolio…": "Caricamento del portafoglio…", "Loading exchange status…": "Caricamento dello stato delle borse…",
    "Loading the economic calendar…": "Caricamento del calendario economico…", "Loading headlines and filings…": "Caricamento di titoli e depositi…",
    "Loading the briefing archive…": "Caricamento dell'archivio dei briefing…", "Loading official yield curves…": "Caricamento delle curve ufficiali…",
    "Loading the FX quotes…": "Caricamento dei cambi…", "Loading past releases…": "Caricamento delle uscite passate…", "Loading real history…": "Caricamento dello storico reale…",
    "No past releases archived yet — the archive started on 7 Oct 2026 and grows every week.": "Ancora nessuna uscita passata in archivio — l'archivio è partito il 7 ottobre 2026 e cresce ogni settimana.",
    "Input data given to the model": "Dati forniti al modello", "official schedules": "calendari ufficiali", "world calendar": "calendario mondiale",
    "no upcoming high-impact event in the current week": "nessun evento ad alto impatto in arrivo questa settimana",
    "No major exchange open now": "Nessuna borsa principale aperta ora",
    "Real but old: the last refresh failed": "Reale ma vecchio: l'ultimo aggiornamento è fallito", "Real but partial (volume from a venue subset)": "Reale ma parziale (volume da un sottoinsieme di sedi)",
    "Real, from the provider, within its refresh window": "Reale, dal fornitore, entro la sua finestra di aggiornamento",
    "Computed by the terminal from real data": "Calcolato dal terminale su dati reali", "No real source: nothing is estimated or invented": "Nessuna fonte reale: nulla è stimato o inventato",
    "Data on screen now": "Dati ora sullo schermo",
    "SYM · DATA": "SIMB. · DATI", "TIME": "ORA", "DATA": "DATI", "INDEX": "INDICE", "BRIEFING · DAILY": "BRIEFING · GIORNALIERO", "BRIEFING · EVENING": "BRIEFING · SERALE",
    "BRIEFING · WEEKLY": "BRIEFING · SETTIMANALE", "BRIEFING · MONTHLY": "BRIEFING · MENSILE", "Sector heatmap": "Mappa dei settori", "Equity screener with filters": "Screener azioni con filtri",
    "Compare instruments, rebased or % change": "Confronta strumenti, base 100 o variazione %", "Correlation matrix of daily returns": "Matrice di correlazione dei rendimenti giornalieri",
    "Price graph & security overview": "Grafico del prezzo e scheda del titolo", "Movers: gainers, losers, most active": "Movimenti: migliori, peggiori, più scambiati",
    "Markets: equities, FX, crypto, metals (real quotes)": "Mercati: azioni, valute, cripto, metalli (quotazioni reali)",
    "Symbol search: find any listed instrument, open it, add it to the watchlist": "Ricerca strumenti: trova qualsiasi strumento quotato, aprilo, aggiungilo alla watchlist",
    "World indices — NO DATA until a licensed source is connected": "Indici mondiali — NESSUN DATO finché non c'è una fonte con licenza",
    "Government yields: U.S. Treasury, ECB euro area": "Rendimenti dei titoli di Stato: Tesoro USA, BCE area euro",
    "Briefing: AI summary of the real data above, with sources": "Briefing: sintesi AI dei dati reali qui sopra, con le fonti",
    "Settings: colours & themes": "Impostazioni: colori e temi", "Move a window; drag the corner grip to resize": "Sposta una finestra; trascina l'angolo per ridimensionarla",
    "Economic calendar: world high-impact events (Forex Factory) with market reaction, plus official US schedules": "Calendario economico: eventi mondiali ad alto impatto (Forex Factory) con la reazione dei mercati, più i calendari ufficiali USA",
    "Heat maps: S&P 500, Nasdaq-100, Dow 30, sectors, countries, crypto, FX — coloured by 1D / 1W / 1M / 3M / 6M / YTD / 1Y change": "Heat map: S&P 500, Nasdaq-100, Dow 30, settori, paesi, cripto, valute — colorate per variazione 1D / 1W / 1M / 3M / 6M / YTD / 1Y",
    "drag title": "trascina il titolo", "double-click": "doppio clic", "venue-subset volume.": "volume del sottoinsieme di sedi.",
    "from real closes aligned by date.": "da chiusure reali allineate per data.", "move together,": "si muovono insieme,", "move apart.": "si muovono in direzioni opposte.",
    "U.S. Bureau of Labor Statistics": "U.S. Bureau of Labor Statistics", "Daily": "Giornaliero", "Evening": "Serale", "Weekly": "Settimanale", "Monthly": "Mensile",

  };

  // fragments inside longer texts (sentences, notes, banners); longest match first
  var PHRASES = [
    ["US, Europe (UK, CH, DE, FR, IT, NL, ES), Canada, Japan, Hong Kong, ETFs, FX and crypto.", "USA, Europa (UK, CH, DE, FR, IT, NL, ES), Canada, Giappone, Hong Kong, ETF, valute e cripto."],
    ["daily closes, split-adjusted", "chiusure giornaliere, rettificate per i frazionamenti"],
    ["Equity volume is PARTIAL (venue subset). The provider sends no volume for FX, crypto and gold: N/A.", "Il volume delle azioni è PARZIALE (sottoinsieme di sedi). Il fornitore non invia volumi per valute, cripto e oro: N/A."],
    ["no real index source is connected. The current plan has no index data (test 2026-10-06: SPX and NDX need a higher plan; DJI, IXIC, RUT and VIX are not available), and index vendors (S&P DJI, Nasdaq, Cboe, STOXX, Deutsche Börse) license even delayed values for display. ETFs are not shown as substitutes.",
      "nessuna fonte reale per gli indici è collegata. Il piano attuale non ha dati sugli indici (test 2026-10-06: SPX e NDX richiedono un piano superiore; DJI, IXIC, RUT e VIX non sono disponibili), e i fornitori degli indici (S&P DJI, Nasdaq, Cboe, STOXX, Deutsche Börse) concedono in licenza anche i valori ritardati. Gli ETF non vengono mostrati come sostituti."],
    ["No values are shown in its place.", "Nessun valore al suo posto."],
    ["AAA GOVERNMENT BONDS SPOT CURVE", "CURVA SPOT DEI TITOLI DI STATO AAA"], ["EURO AREA", "AREA EURO"], ["TREASURY PAR YIELD CURVE", "CURVA PAR DEL TESORO"], ["UNITED STATES", "STATI UNITI"],
    ["spot rate (Svensson), end of day", "tasso spot (Svensson), fine giornata"], ["par yield, end of day", "rendimento par, fine giornata"],
    ["— N/A until an approved official source is added. Maturities a source does not publish stay N/A; nothing is interpolated.", "— N/A finché non si aggiunge una fonte ufficiale approvata. Le scadenze che una fonte non pubblica restano N/A; nulla è interpolato."],
    ["Not connected:", "Non collegati:"], ["EUROPE & AFRICA", "EUROPA E AFRICA"], ["ASIA-PACIFIC", "ASIA-PACIFICO"], ["AMERICAS", "AMERICHE"], ["United Kingdom", "Regno Unito"], ["Germany", "Germania"], ["Italy", "Italia"], ["France", "Francia"], ["Japan", "Giappone"],
    ["difference between the two latest official publications", "differenza tra le due ultime pubblicazioni ufficiali"], ["10Y minus 2Y, same publication", "10A meno 2A, stessa pubblicazione"],
    ["S&P 500 constituents: Alpaca prices, iShares IVV weights (derived)", "componenti S&P 500: prezzi Alpaca, pesi iShares IVV (derivati)"],
    ["Twelve Data (FX, crypto, gold, watchlist)", "Twelve Data (valute, cripto, oro, watchlist)"], ["Headlines:", "Titoli:"],
    ["Rankings cover the", "Le classifiche coprono i"], ["watchlist instruments. Most active ranks by", "strumenti della watchlist. I più scambiati sono ordinati per"],
    ["market cap and P/E removed: no fundamentals source (N/A)", "capitalizzazione e P/E rimossi: nessuna fonte di fondamentali (N/A)"],
    ["Pearson correlation of daily returns over the last 90 sessions,", "Correlazione di Pearson dei rendimenti giornalieri nelle ultime 90 sedute,"],
    ["written", "scritto"], ["as of", "al"], ["obs", "oss."], ["source", "fonte"],
    ["Written automatically on weekday mornings at 07:30 (Rome time).", "Scritto automaticamente nei giorni feriali alle 07:30 (ora di Roma)."],
    ["Written automatically on weekday evenings at 22:30 (Rome time), after the US close.", "Scritto automaticamente nei giorni feriali alle 22:30 (ora di Roma), dopo la chiusura USA."],
    ["Written automatically on Saturday mornings at 08:00 (Rome time).", "Scritto automaticamente il sabato alle 08:00 (ora di Roma)."],
    ["Written automatically on the first Saturday of each month at 08:00 (Rome time).", "Scritto automaticamente il primo sabato di ogni mese alle 08:00 (ora di Roma)."],
    ["edition was not written in its window, so it is not written later with newer data.", "edizione non è stata scritta nella sua finestra, quindi non viene scritta dopo con dati più recenti."],
    ["is written automatically at", "viene scritta automaticamente alle"], ["from real data; it appears here within a few minutes.", "da dati reali; compare qui entro pochi minuti."],
    ["Automatic writing: last scheduled run", "Scrittura automatica: ultima esecuzione programmata"], ["Automatic writing: no scheduled run recorded yet", "Scrittura automatica: nessuna esecuzione programmata registrata"],
    ["Number check: all", "Verifica delle cifre: tutte le"], ["figures match the source data.", "cifre corrispondono ai dati di origine."],
    ["figure(s) not found in the source data:", "cifra/e non trovata/e nei dati di origine:"], ["link(s) not in the source data removed", "link non presenti nei dati di origine rimossi"],
    ["missing section(s):", "sezione/i mancante/i:"], ["briefing could not be written:", "briefing non è stato scritto:"],
    ["No text is produced without real inputs and a working model.", "Nessun testo viene prodotto senza dati reali e un modello funzionante."],
    ["from real data… (model: Workers AI, about 20 s)", "da dati reali… (modello: Workers AI, circa 20 s)"], ["briefing archive unavailable:", "archivio dei briefing non disponibile:"],
    ["Open all", "Apri tutte le"], ["as a view", "come vista"], ["AI-written from the real data below", "scritto dall'AI dai dati reali qui sotto"], ["AI-written from real data", "scritto dall'AI da dati reali"],
    ["AI-written summary of the real data listed below. Not investment advice.", "Sintesi scritta dall'AI dai dati reali elencati sotto. Non è una consulenza finanziaria."],
    ["The Italian version of this edition has not been written yet.", "La versione italiana di questa edizione non è ancora stata scritta."],
    ["World calendar: Forex Factory weekly export (USD, EUR, GBP, JPY, CHF, CAD, AUD, NZD, CNY), this week plus the last", "Calendario mondiale: export settimanale di Forex Factory (USD, EUR, GBP, JPY, CHF, CAD, AUD, NZD, CNY), questa settimana più gli ultimi"],
    ["days from the archive; impact, forecast and previous as published there. Actual: N/A — not in the export. Reaction: price just before the time vs 15 / 60 minutes after, from 1-minute data (FX: Twelve Data; USD events also SPY / TLT ETFs, Alpaca) — DERIVED, high-impact events only. Click an event for details and past releases. Times in your local time zone.",
      "giorni dall'archivio; impatto, previsto e precedente come pubblicati lì. Effettivo: N/A — non è nell'export. Reazione: prezzo subito prima dell'orario contro 15 / 60 minuti dopo, da dati al minuto (cambi: Twelve Data; eventi USD anche ETF SPY / TLT, Alpaca) — DERIVED, solo eventi ad alto impatto. Clicca un evento per dettagli e uscite passate. Orari nel tuo fuso."],
    ["Official U.S. release schedules (BLS, BEA), past 7 and next 35 days. Actual / previous: N/A until a FRED API key is configured. Forecast and importance: N/A in these official schedules.",
      "Calendari ufficiali USA (BLS, BEA), ultimi 7 e prossimi 35 giorni. Effettivo / precedente: N/A finché non è configurata una chiave FRED. Previsto e importanza: N/A in questi calendari ufficiali."],
    ["Headlines and links only, no article text: the publishers' and central banks' own public RSS feeds (personal use; articles open on their site). Filings: SEC EDGAR.",
      "Solo titoli e link, nessun testo degli articoli: feed RSS pubblici degli editori e delle banche centrali (uso personale; gli articoli si aprono sul loro sito). Depositi: SEC EDGAR."],
    ["Open / closed: Twelve Data, regular session, holidays and early closes included. Countdowns and session times are computed from the provider's time to open / close (DERIVED); lunch breaks show as closed when the provider reports them. Times in your time zone unless marked local.",
      "Aperta / chiusa: Twelve Data, seduta regolare, festivi e chiusure anticipate compresi. Conti alla rovescia e orari di seduta sono calcolati dal tempo all'apertura / chiusura del fornitore (DERIVED); le pause pranzo risultano chiuse quando il fornitore le segnala. Orari nel tuo fuso salvo dove indicato locale."],
    ["Fees in the trade currency. A sale must not exceed the quantity held on that date. Values in EUR use the live EUR/currency rate (Twelve Data); cost uses the ECB rate of the trade date.",
      "Commissioni nella valuta dell'operazione. Una vendita non può superare la quantità posseduta a quella data. I valori in EUR usano il cambio EUR/valuta attuale (Twelve Data); il costo usa il cambio BCE della data dell'operazione."],
    ["Average-cost method. Cost in EUR:", "Metodo del costo medio. Costo in EUR:"],
    ["; market value: live quotes; nothing is estimated — a position without a live price is N/A. Stored privately on your server (Cloudflare Access).",
      "; valore di mercato: quotazioni live; nulla è stimato — una posizione senza prezzo live è N/A. Salvato in privato sul tuo server (Cloudflare Access)."],
    ["ECB euro reference rates (ECB Data Portal, EXR)", "cambi di riferimento dell'euro della BCE (ECB Data Portal, EXR)"],
    ["position(s) without a live price or rate", "posizione/i senza prezzo o cambio live"], ["* partial —", "* parziale —"],
    ["— price prefilled, edit it to your execution price", "— prezzo precompilato, modificalo con il tuo prezzo di esecuzione"],
    ["You can still record it: choose its currency; its value will be N/A until a quote exists.", "Puoi comunque registrarla: scegli la valuta; il valore sarà N/A finché non c'è una quotazione."],
    ["Choose the currency of the price", "Scegli la valuta del prezzo"], ["is not a ticker — use SEARCH to find it", "non è un ticker — usa CERCA per trovarlo"], ["recorded", "registrato"],
    ["Not saved:", "Non salvato:"], ["portfolio storage unavailable", "archivio del portafoglio non disponibile"],
    ["Cell = % change of the row currency against the column currency since the previous close, from", "Cella = variazione % della valuta di riga contro quella di colonna dalla chiusura precedente, da"],
    ["live quotes vs USD (Twelve Data:", "quotazioni live contro USD (Twelve Data:"], ["crosses DERIVED", "cross DERIVED"],
    ["Longer periods need a daily history per pair (credits); shown for 1D only.", "Periodi più lunghi richiedono lo storico giornaliero di ogni coppia (crediti); solo 1D."],
    ["FX quotes unavailable; nothing is computed without them.", "cambi non disponibili; senza di essi non si calcola nulla."],
    ["traded value of the last completed session (close × volume, Alpaca)", "controvalore dell'ultima seduta completa (chiusura × volume, Alpaca)"],
    ["weight in IVV holdings (proxy for the index weight)", "peso nel portafoglio di IVV (approssima il peso nell'indice)"],
    ["sectors: GICS from the S&P 500 list where the company is in it", "settori: GICS dalla lista S&P 500 se la società ne fa parte"],
    ["constituents &amp; weights:", "componenti e pesi:"], ["constituents & weights:", "componenti e pesi:"], ["iShares IVV holdings", "portafoglio di iShares IVV"],
    ["Alpaca, latest IEX trade", "Alpaca, ultimo scambio IEX"], ["Alpaca, latest crypto trade", "Alpaca, ultimo scambio cripto"], ["Alpaca, consolidated close", "Alpaca, chiusura consolidata"],
    ["Alpaca, last completed UTC day", "Alpaca, ultimo giorno UTC completo"], ["consolidated close", "chiusura consolidata"], ["daily close (UTC)", "chiusura giornaliera (UTC)"],
    ["changes DERIVED", "variazioni DERIVED"], ["last price:", "ultimo prezzo:"], ["base:", "base:"], ["size:", "dimensione:"],
    ["constituents", "componenti"], ["Nothing is drawn without the real list.", "Senza la lista reale non si disegna nulla."],
    ["price source not connected: Alpaca API keys are not set in the Worker. Tiles show the real list only; every change is N/A.", "fonte dei prezzi non collegata: le chiavi Alpaca non sono impostate nel Worker. I riquadri mostrano solo la lista reale; ogni variazione è N/A."],
    ["prices unavailable", "prezzi non disponibili"], ["No substitute value is shown.", "Nessun valore sostitutivo."], ["unavailable", "non disponibile"],
    ["No open/closed state is guessed.", "Nessuno stato aperto/chiuso viene indovinato."], ["exchange status unavailable", "stato delle borse non disponibile"],
    ["not in the provider's list:", "non nella lista del fornitore:"], ["Twelve Data market_state · fetched", "Twelve Data market_state · aggiornato"],
    ["NEWEST FIRST", "PIÙ RECENTI PRIMA"], ["CHECKED", "CONTROLLATO"], ["AUTO EVERY 5 MIN", "AUTOMATICO OGNI 5 MIN"], ["HEADLINES", "TITOLI"],
    ["FED · ECB · BANK OF ENGLAND (OFFICIAL RELEASES)", "FED · BCE · BANCA D'INGHILTERRA (COMUNICATI UFFICIALI)"], ["CENTRAL BANKS", "BANCHE CENTRALI"],
    ["arrived since you opened the terminal", "arrivato dopo l'apertura del terminale"],
    ["HEAT MAP", "HEAT MAP"], ["BRIEFING ·", "BRIEFING ·"], ["SYMBOL SEARCH ·", "RICERCA STRUMENTI ·"],
    ["opens in", "apre tra"], ["closes in", "chiude tra"], ["OPEN NOW", "APERTE ORA"], [" OPEN", " APERTE"],
    ["computed from 1-minute prices 15 minutes after the time", "calcolata dai prezzi al minuto 15 minuti dopo l'orario"], ["60-minute window not complete yet", "finestra di 60 minuti non ancora completa"],
    ["from the archive", "dall'archivio"], ["impact", "impatto"], ["local", "locale"],
    ["no 1-minute prices around the time", "nessun prezzo al minuto attorno all'orario"],
    ["Past releases N/A", "Uscite passate N/A"],
    ["fetched", "aggiornato"], ["forecast", "previsto"], ["previous", "precedente"], ["data date", "data dei dati"], ["data time", "ora del dato"],
    ["refresh failed:", "aggiornamento fallito:"], ["last real quote from", "ultima quotazione reale del"],
    ["not available on the current data plan", "non disponibile con il piano dati attuale"], ["no licensed index source", "nessuna fonte con licenza per gli indici"],
    ["listed by the provider, but not included in the current data plan", "quotato dal fornitore, ma non incluso nel piano dati attuale"],
    ["price source not connected (Alpaca keys not set)", "fonte dei prezzi non collegata (chiavi Alpaca assenti)"], ["S&P 500 constituent list unavailable", "lista dei componenti S&P 500 non disponibile"],
    ["provider refused the request", "il fornitore ha rifiutato la richiesta"], ["unknown symbol at the provider", "simbolo sconosciuto al fornitore"], ["invalid symbol", "simbolo non valido"],
    ["provider rate limit reached", "limite di richieste del fornitore raggiunto"], ["provider timed out", "il fornitore non ha risposto in tempo"], ["provider unreachable", "fornitore non raggiungibile"],
    ["provider rejected the server key", "il fornitore ha rifiutato la chiave del server"], ["provider error / empty response", "errore del fornitore / risposta vuota"],
    ["no data for this range", "nessun dato per questo periodo"], ["could not reach /api", "impossibile raggiungere /api"], ["last real value is older than 24 h", "l'ultimo valore reale ha più di 24 ore"],
    ["not added:", "non aggiunto:"], ["is already in the watchlist", "è già nella watchlist"], ["Checking", "Verifica di"], ["with the provider…", "presso il fornitore…"],
    ["Portfolio: your transactions, positions, value and P&L in EUR (starts empty)", "Portafoglio: le tue operazioni, posizioni, valore e P&L in EUR (parte vuoto)"],
    ["World exchanges: which markets are open now, local time, time to open / close", "Borse mondiali: quali mercati sono aperti ora, ora locale, tempo all'apertura / chiusura"],
    ["News: FT, Bloomberg, WSJ, MarketWatch, central banks; SEC filings for the watchlist", "News: FT, Bloomberg, WSJ, MarketWatch, banche centrali; depositi SEC della watchlist"],
    ["A command-driven, multi-window market workspace. Type in the command line, use the launcher at the bottom, or the taskbar up top.", "Un'area di lavoro sui mercati a finestre, guidata da comandi. Scrivi nella riga di comando, usa la barra in basso o la barra delle finestre in alto."],
    ["Ticker, company name or function", "Ticker, nome della società o funzione"], ["Changes apply instantly across every window and are remembered on this device.", "Le modifiche valgono subito in ogni finestra e sono ricordate su questo dispositivo."],
    ["Arrange every open window in a grid", "Disponi tutte le finestre aperte in griglia"], ["Maximise / restore a window (title bar)", "Ingrandisci / ripristina una finestra (barra del titolo)"],
    ["This screen (or press ?)", "Questa schermata (o premi ?)"], ["Ticker + function in one line", "Ticker + funzione in una riga"], ["Open a security window", "Apri la finestra di un titolo"],
    ["Close all windows", "Chiudi tutte le finestre"], ["brings them back", "le riapre"],
    ["Anything else searches the provider's symbol master (name or ticker, all exchanges)", "Qualsiasi altro testo cerca nell'anagrafica del fornitore (nome o ticker, tutte le borse)"],
    ["Search any listed instrument by company name or ticker", "Cerca qualsiasi strumento quotato per nome della società o ticker"],
    ["Indices are not in the provider's search.", "Gli indici non sono nella ricerca del fornitore."],
    ["add to the watchlist (checked with a real quote)", "aggiungi alla watchlist (verificato con una quotazione reale)"],
    ["open the quote window (real quote + history, fetched now)", "apri la finestra della quotazione (quotazione reale + storico, scaricati ora)"],
    ["Watchlist — add/remove symbols (saved on this device)", "Watchlist — aggiungi/rimuovi simboli (salvata su questo dispositivo)"],
    ["major exchanges open now (Twelve Data market_state)", "borse principali aperte ora (Twelve Data market_state)"], ["next high-impact event (Forex Factory)", "prossimo evento ad alto impatto (Forex Factory)"],
    ["Open now:", "Aperte ora:"], ["edition for", "edizione del"],
  ];
  // dynamic patterns
  var PATTERNS = [
    [/^DATA AS OF /, "DATI AL "],
    [/^(\d+) results of (\d+)/, "$1 risultati su $2"],
    [/^(Daily|Evening|Weekly|Monthly) · /, function (m, p) { return { Daily: "Giornaliero", Evening: "Serale", Weekly: "Settimanale", Monthly: "Mensile" }[p] + " · "; }],
    [/^No (daily|evening|weekly|monthly) briefing yet\./, function (m, p) { return "Nessun briefing " + { daily: "giornaliero", evening: "serale", weekly: "settimanale", monthly: "mensile" }[p] + " ancora."; }],
    [/^No (daily|evening|weekly|monthly) edition yet\./, function (m, p) { return "Nessuna edizione " + { daily: "giornaliera", evening: "serale", weekly: "settimanale", monthly: "mensile" }[p] + " ancora."; }],
    [/\bWriting the (Daily|Evening|Weekly|Monthly) briefing( for)?\b/, function (m, p, f) { return "Scrittura del briefing " + { Daily: "giornaliero", Evening: "serale", Weekly: "settimanale", Monthly: "mensile" }[p] + (f ? " del" : ""); }],
    [/^(\d+)\/(\d+) open$/, "$1/$2 aperte"],
    [/ (\d+)\/(\d+) OPEN$/, " $1/$2 APERTE"],
    [/(^|\s)in (\d+[dhm])/g, "$1tra $2"],
    [/(\d+) (constituents|ETFs|pairs) · (\d+) N\/A/, function (m, n, k, na) { return n + " " + { constituents: "componenti", ETFs: "ETF", pairs: "coppie" }[k] + " · " + na + " N/A"; }],
    [/^at (\d{2}:\d{2})$/, "alle $1"],
    [/^(\d+) (BUY|SELL) /, "$1 $2 "],
    [/^(BUY|SELL) ([A-Z0-9.:\/-]+) registrato$/, function (m, s, x) { return (s === "BUY" ? "ACQUISTO " : "VENDITA ") + x + " registrato"; }],
    [/TRANSACTIONS · (\d+)/, "OPERAZIONI · $1"],
  ];

  var EXACT_MAP = new Map(Object.entries(EXACT));
  var PHR = PHRASES.slice().sort(function (a, b) { return b[0].length - a[0].length; });
  var PHR_MAP = new Map(PHR);
  // single short words only as whole words; longer phrases anywhere
  // a phrase never matches inside a longer word ("ASIA-PACIFIC" is not found again in "ASIA-PACIFICO")
  var PHR_RE = new RegExp(PHR.map(function (p) { var e = p[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); return (/^[A-Za-z]/.test(p[0]) ? "(?<![A-Za-z])" : "") + e + (/[A-Za-z]$/.test(p[0]) ? "(?![A-Za-z])" : ""); }).join("|"), "g");

  function tr(s) {
    if (cur !== "it" || !s) return s;
    var t = s.trim();
    if (!t || !/[A-Za-z]/.test(t)) return s;
    var ex = EXACT_MAP.get(t);
    if (ex != null) return s.replace(t, ex);
    var o = s;
    // known phrases first (only inside texts of several words: a lone word may be data), then dynamic patterns
    if (t.split(/\s+/).length > 1) o = o.replace(PHR_RE, function (m) { return PHR_MAP.get(m); });
    for (var i = 0; i < PATTERNS.length; i++) o = o.replace(PATTERNS[i][0], PATTERNS[i][1]);
    return o;
  }
  var SKIP = ".notranslate,.nm,script,style,textarea,code,pre";
  function skip(el) { return !el || (el.closest && el.closest(SKIP)); }
  function trTextNode(n) {
    if (cur !== "it" || n.__it === n.data || skip(n.parentElement)) return; // a node is translated once: never twice
    var v = n.data, o = tr(v);
    if (o !== v) { n.__en = v; n.__it = o; n.data = o; }
  }
  var ATTRS = ["title", "placeholder", "aria-label"];
  function trAttrs(el) {
    if (cur !== "it" || skip(el)) return;
    for (var i = 0; i < ATTRS.length; i++) {
      var a = ATTRS[i], v = el.getAttribute && el.getAttribute(a);
      if (!v) continue;
      el.__itAttr = el.__itAttr || {};
      if (el.__itAttr[a] === v) continue; // already ours
      var o = tr(v);
      if (o !== v) { el.__enAttr = el.__enAttr || {}; el.__enAttr[a] = v; el.__itAttr[a] = o; el.setAttribute(a, o); }
    }
  }
  function walk(root, fn) {
    if (!root) return;
    if (root.nodeType === 3) return fn(root, true);
    if (root.nodeType !== 1 || skip(root)) return;
    fn(root, false);
    var w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, { acceptNode: function (n) { return (n.nodeType === 1 ? n : n.parentElement).closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT; } });
    while (w.nextNode()) fn(w.currentNode, w.currentNode.nodeType === 3);
  }
  function translate(root) { walk(root || document.body, function (n, isText) { if (isText) trTextNode(n); else trAttrs(n); }); }
  function restore(root) {
    walk(root || document.body, function (n, isText) {
      if (isText) { if (n.__en != null && n.__it === n.data) n.data = n.__en; n.__en = null; n.__it = null; }
      else if (n.__enAttr) { for (var a in n.__enAttr) if (n.__itAttr && n.getAttribute(a) === n.__itAttr[a]) n.setAttribute(a, n.__enAttr[a]); n.__enAttr = null; n.__itAttr = null; }
    });
  }
  var mo = null;
  function attach() {
    document.documentElement.lang = cur;
    if (mo || typeof MutationObserver === "undefined") return;
    mo = new MutationObserver(function (muts) {
      if (cur !== "it") return;
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i];
        if (m.type === "childList") m.addedNodes.forEach(function (n) { translate(n); });
        else if (m.type === "characterData") trTextNode(m.target); // our own write is skipped (__it); new text from the page is translated
        else if (m.type === "attributes") trAttrs(m.target);
      }
    });
    mo.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
    if (cur === "it") translate(document.body);
  }
  function set(l) {
    if (l !== "it" && l !== "en") return;
    try { localStorage.setItem(KEY, l); } catch (e) {}
    var was = cur; cur = l; document.documentElement.lang = l;
    if (was === "it" && l === "en") restore(document.body);
    if (l === "it") translate(document.body);
  }
  // locale for dates and times shown by the terminal
  function locale() { return cur === "it" ? "it-IT" : "en-GB"; }
  root.I18N = { lang: function () { return cur; }, set: set, tr: tr, translate: translate, attach: attach, locale: locale, _exact: EXACT_MAP, _phrases: PHR };
})(typeof window !== "undefined" ? window : globalThis);
