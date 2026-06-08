# VDM — Velocity Decay Monitor (web edition)

Pelacak laju (views/jam) & peluruhan untuk penulis serial. PWA murni front-end:
tanpa server, tanpa build step, jalan offline, bisa dipasang ke home screen.

Port mesin dari **VDM v3.3 “Phoenix”** (CLI oleh @YCBRoadcast): `velocity_average`,
`velocity_rolling`, `fit_decay` (OLS log-linear), proyeksi, dan model `chase` —
lengkap dengan guard kualitas-data v3.3 dan *graceful degradation*. Logika
trigger-peringkat / deploy **tidak** disertakan.

## Isi
```
index.html            shell aplikasi
app.css               gaya
app.js                mesin + state (IndexedDB) + UI + PWA
manifest.webmanifest  metadata PWA
sw.js                 service worker (offline app-shell)
icons/                ikon 192 / 512 / maskable + favicon
```

## Pasang ke GitHub Pages (5 menit)
1. Buat repo baru, mis. `vdm`.
2. Upload **seluruh isi folder ini** ke root repo (drag-and-drop di web GitHub juga bisa).
3. Repo → **Settings → Pages** → *Source*: **Deploy from a branch** → branch `main`, folder `/ (root)` → **Save**.
4. Tunggu ±1 menit. Situsmu terbit di `https://<username>.github.io/vdm/`.
5. Buka di HP → menu browser → **Add to Home screen / Install**.

> Semua path sudah relatif, jadi aman dijalankan di sub-path `…github.io/vdm/`.
> Kalau ganti nama file yang di-cache, naikkan angka `CACHE` di `sw.js` agar update terambil.

## Tes lokal (opsional)
Service worker butuh `http(s)` atau `localhost` (tidak jalan via `file://`):
```bash
cd vdm-app
python3 -m http.server 8080
# buka http://localhost:8080
```

## Fitur
- **Dashboard** — catat views satu ketuk; laju rata² + laju kini (rolling) + delta; kartu *foresight* (peluruhan → half-life + label lambat/sedang/cepat, proyeksi “turun ke X v/j dalam ~Yj”) yang hanya muncul saat datanya layak dipercaya; grafik laju + kurva decay hasil fit + garis target.
- **Bab** — ledger per-bab (`start_views` otomatis = views bab sebelumnya), pertumbuhan internal & antar-bab, bar chart per bab (warna: di bawah target / ≥ organik / ≥ viral).
- **Watchlist** — input cepat dengan stepper (nilai lama prefilled), laju pembanding, dan “peluang menyusul” (estimasi model chase).
- **Jadwal** — window jam untuk mengingatkan posting bab baru, hitung mundur ke window berikutnya, indikator “sekarang”. Murni pengingat konten.
- **Pengaturan** — ambang (target proyeksi, organik, viral, min. sampel, jendela rolling), ekspor/impor JSON, ekspor CSV & Markdown, data contoh, reset.
- **Undo** sekali-tekan, dan tombol **Pasang** saat browser mengizinkan.

## Catatan & batasan
- **Penyimpanan per-perangkat** (IndexedDB). Pindah HP/PC? Pengaturan → *Ekspor cadangan (JSON)*, lalu *Impor* di perangkat baru.
- **Notifikasi window** muncul **selama aplikasi terbuka**; notifikasi terjadwal di latar belakang tidak dijamin oleh semua browser.
- Font dari Google Fonts; offline pertama kali memakai fallback sistem (tetap berfungsi, hanya beda rupa).

Lisensi mengikuti proyek asal: open-source, not for sale.
