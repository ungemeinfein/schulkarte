# Schulkarte
- **Start:** `npm install` und dann `npm run dev`. Danach im Browser per Klick Wohnort A und B setzen; die Marker lassen sich verschieben und bleiben nur im localStorage dieses Browsers gespeichert.
- **CSV aktualisieren:** `data/schulen.csv` ersetzen und `npm run geocode` ausführen. Neue Adressen werden über Nominatim gesucht (1 Anfrage/s), bekannte kommen aus dem Cache `public/schulen.geojson`.
- **Fehlschläge beim Geocoding:** Koordinaten manuell in `data/geocode-overrides.json` als `{ "Schulname": [lon, lat] }` eintragen.
- **Termine:** `data/termine.json` bearbeiten. Die Spalte rechts zeigt sie chronologisch an, mit .ics-Download je Termin oder für alle gefilterten. Alle Bereiche lassen sich an den Trennern verschieben, ein Doppelklick setzt sie zurück.
- **Echte Fahrzeiten:** A und B setzen und auf „Echte Fahrzeiten berechnen“ klicken (ca. 2 min). Fahrrad über Valhalla/FOSSGIS mit 12 km/h, ÖPNV über v6.bvg.transport.rest (Dienstag, Ankunft bis 8:00). Die Koordinaten werden dafür auf ~100 m gerundet verschickt, die Ergebnisse bleiben nur im localStorage dieses Browsers. „echtes Routing“ zeichnet auch die Flächen auf der Karte damit.
